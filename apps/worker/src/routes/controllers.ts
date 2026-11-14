import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  CONTROLLER_TRASH_RETENTION_DAYS,
  defaultBootButtonGpioForChip,
  resolveBoardFirmwareCompatibility,
  supportsBleProvisioningForBoard,
} from "@homecoreos/shared";
import { recordActivity } from "../lib/audit";
import { syncControllerConfigSnapshot } from "../lib/controller-config";
import {
  generateRandomToken,
  generateSixDigitPairingCode,
  sha256Hex,
} from "../lib/crypto";
import {
  EmqxClient,
  buildControllerTopicPrefix,
  isEmqxConfigured,
} from "../lib/emqx";
import {
  resolveControllerCompatBoard,
  type CompatBoardRecord,
} from "../lib/firmware-compatibility";
import {
  emitNotification,
  refreshStaleControllerStates,
} from "../lib/notifications";
import { requireStaffRole, requireUserSession } from "../middleware/auth";
import type { AppEnv } from "../types/context";

const createControllerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  homeId: z.string().uuid().optional(),
  boardCatalogId: z.string().uuid().optional(),
  customBoardId: z.string().uuid().optional(),
});

const recoverControllerSchema = z.object({
  controllerId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  homeId: z.string().uuid().optional(),
  boardCatalogId: z.string().uuid().optional(),
  customBoardId: z.string().uuid().optional(),
});

const updateControllerSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

const wifiConfigSchema = z.object({
  ssid: z.string().trim().min(1).max(64),
  password: z.string().min(0).max(128),
});

function buildOfflineRecoveryInstructions(
  board?: CompatBoardRecord | null
): string[] {
  const bootGpio = board
    ? (board.boot_button_gpio ??
      defaultBootButtonGpioForChip(board.chip_family, board.slug))
    : 0;
  const bleSummary = board ? supportsBleProvisioningForBoard(board) : null;
  const supportsWifi = board?.supports_wifi !== false;
  const supportsBle = bleSummary ? bleSummary.supportsBle : true;
  const supportsBleWifi = bleSummary
    ? bleSummary.supportsBleWifiProvisioning
    : Boolean(supportsWifi && supportsBle);
  const boardLabel = board ? `${board.manufacturer} ${board.model}` : "ESP32";

  if (!supportsWifi) {
    return [
      `Verify USB/5V power supply and confirm the ${boardLabel} status LED is illuminated.`,
      `${boardLabel} (${board?.chip_family.toUpperCase() ?? "ESP32-H2"}) has no integrated Wi-Fi radio and does not broadcast a Wi-Fi Setup network.`,
      `Hold the physical BOOT / Recovery button (GPIO${bootGpio}) for 3 seconds to enter local BLE recovery mode.`,
      "Note: ESP32-H2 is unavailable as a standalone Wi-Fi/MQTT controller.",
      "If firmware appears corrupted, use Firmware & Updates → Install on a Fresh Controller over USB.",
    ];
  }

  if (supportsBleWifi) {
    return [
      `Verify USB/5V power supply and confirm the ${boardLabel} status LED is illuminated.`,
      `Hold the physical BOOT / Recovery button (GPIO${bootGpio}) for 3 seconds to open Bluetooth LE recovery and HomecoreOS-Setup-XXXX without erasing your pairing.`,
      "Recommended: choose Recover with BLE in HomecoreOS (Chrome/Edge) to reconnect Wi-Fi and verify pairing wirelessly.",
      "Fallback: connect to HomecoreOS-Setup-XXXX and open http://192.168.4.1 to update Wi-Fi or complete recovery.",
      "Hold BOOT for 10 full seconds only if you intentionally want a full factory reset.",
    ];
  }

  return [
    `Verify USB/5V power supply and confirm the ${boardLabel} status LED is illuminated.`,
    `${boardLabel} (${board?.chip_family.toUpperCase() ?? "ESP32-S2"}) has Wi-Fi without Bluetooth LE hardware, so recovery uses the local setup webpage.`,
    `Hold the physical BOOT / Recovery button (GPIO${bootGpio}) for 3 seconds to open HomecoreOS-Setup-XXXX without erasing your pairing.`,
    "Connect to HomecoreOS-Setup-XXXX and open http://192.168.4.1 to update Wi-Fi or complete recovery.",
    "If firmware appears corrupted, use Firmware & Updates → Install on a Fresh Controller over USB.",
  ];
}

function summarizeBoardCompat(board: CompatBoardRecord | null) {
  if (!board) return undefined;
  const bleSummary = supportsBleProvisioningForBoard(board);
  return {
    slug: board.slug,
    model: board.model,
    chip_family: board.chip_family,
    partition_scheme: board.partition_scheme ?? null,
    boot_button_gpio:
      board.boot_button_gpio ??
      defaultBootButtonGpioForChip(board.chip_family, board.slug),
    usb_interface: board.usb_interface ?? null,
    supports_wifi: board.supports_wifi !== false,
    supports_ble: bleSummary.supportsBle,
    supports_ble_wifi_provisioning: bleSummary.supportsBleWifiProvisioning,
    connectivity_note: board.connectivity_note ?? null,
  };
}

const TRASH_MS = CONTROLLER_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export function createControllerRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", requireUserSession());

  app.get("/", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const deps = c.get("deps") ?? {};
    const emqx = isEmqxConfigured(c.env ?? {})
      ? new EmqxClient(c.env!, deps.emqxFetch)
      : null;

    // Run stale heartbeat check + single batch EMQX client listing concurrently
    const [, emqxListRes] = await Promise.all([
      refreshStaleControllerStates(db, auth.accountId).catch(() => 0),
      emqx
        ? emqx.listClients(1, 200).catch(() => null)
        : Promise.resolve(null),
    ]);

    const [ctrlRes, credsRes] = await Promise.all([
      db
        .from("controllers")
        .select("*")
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .is("permanently_deleted_at", null)
        .order("created_at", { ascending: false }),
      db
        .from("mqtt_credentials_metadata")
        .select(
          "controller_id,mqtt_username,mqtt_client_id,topic_prefix,emqx_synced,status,last_rotated_at"
        )
        .eq("account_id", auth.accountId),
    ]);

    const credByController = new Map(
      ((credsRes.data ?? []) as Array<{
        controller_id: string;
        mqtt_username: string;
        mqtt_client_id: string;
        topic_prefix: string;
        emqx_synced: boolean;
        status: string;
        last_rotated_at?: string;
      }>).map((m) => [m.controller_id, m])
    );

    const liveEmqxByClientId = new Map<string, boolean>();
    if (emqxListRes?.data) {
      for (const client of emqxListRes.data) {
        if (client.clientid) {
          liveEmqxByClientId.set(client.clientid, Boolean(client.connected ?? true));
        }
      }
    }

    const ctrlRows = (ctrlRes.data ?? []) as Array<Record<string, unknown>>;
    const catalogIds = Array.from(
      new Set(
        ctrlRows
          .map((r) => (r.board_catalog_id ? String(r.board_catalog_id) : ""))
          .filter(Boolean)
      )
    );
    const customIds = Array.from(
      new Set(
        ctrlRows
          .map((r) => (r.custom_board_id ? String(r.custom_board_id) : ""))
          .filter(Boolean)
      )
    );

    const [catBoardsRes, custBoardsRes] = await Promise.all([
      catalogIds.length > 0
        ? db
            .from("board_catalog")
            .select(
              "id,slug,manufacturer,model,revision,chip_family,chip_variant,flash_size_mb,psram_size_mb,firmware_status,partition_scheme,psram_mode,flash_mode,flash_freq,bootloader_offset,ota_app_offset,boot_button_gpio,usb_interface,supports_wifi,supports_ble,supports_ble_wifi_provisioning,supports_ota_rollback,firmware_compat_key,connectivity_note"
            )
            .in("id", catalogIds)
        : Promise.resolve({ data: [] as unknown[] }),
      customIds.length > 0
        ? db
            .from("custom_boards")
            .select(
              "id,slug,manufacturer,model,revision,chip_family,chip_variant,flash_size_mb,psram_size_mb,partition_scheme,psram_mode,flash_mode,flash_freq,bootloader_offset,ota_app_offset,boot_button_gpio,usb_interface,supports_wifi,supports_ble,supports_ble_wifi_provisioning,supports_ota_rollback,firmware_compat_key,connectivity_note"
            )
            .in("id", customIds)
        : Promise.resolve({ data: [] as unknown[] }),
    ]);

    const boardMap = new Map<string, CompatBoardRecord>();
    for (const row of (catBoardsRes.data ?? []) as CompatBoardRecord[]) {
      boardMap.set(`catalog:${row.id}`, {
        ...row,
        ...resolveBoardFirmwareCompatibility(row),
      });
    }
    for (const row of (custBoardsRes.data ?? []) as CompatBoardRecord[]) {
      boardMap.set(`custom:${row.id}`, {
        ...row,
        ...resolveBoardFirmwareCompatibility(row),
      });
    }

    const controllers = ctrlRows.map((ctrl) => {
      const id = String(ctrl.id);
      const cred = credByController.get(id) ?? null;
      let emqxConnected = Boolean(ctrl.mqtt_connected);
      if (emqxListRes && cred && cred.status === "active") {
        const listedState = liveEmqxByClientId.get(cred.mqtt_client_id);
        if (listedState !== undefined) {
          emqxConnected = listedState;
        }
      }
      const board = ctrl.board_catalog_id
        ? (boardMap.get(`catalog:${String(ctrl.board_catalog_id)}`) ?? null)
        : ctrl.custom_board_id
          ? (boardMap.get(`custom:${String(ctrl.custom_board_id)}`) ?? null)
          : null;
      return {
        ...ctrl,
        mqtt_connected: emqxConnected,
        wifi_connected: Boolean(ctrl.wifi_connected ?? ctrl.status === "online"),
        pairing_status:
          (ctrl.pairing_status as string | undefined) ??
          (ctrl.paired_at ? "paired" : "pending"),
        mqtt: cred,
        board_compat: summarizeBoardCompat(board),
        offline_recovery_instructions:
          ctrl.status === "online"
            ? undefined
            : buildOfflineRecoveryInstructions(board),
      };
    });

    return c.json({ controllers });
  });

  // Trash list (controllers soft-deleted within 30-day retention window)
  app.get("/trash", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");

    const { data: rows } = await db
      .from("controllers")
      .select("*")
      .eq("account_id", auth.accountId)
      .not("deleted_at", "is", null)
      .is("permanently_deleted_at", null)
      .order("deleted_at", { ascending: false });

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiredIds: string[] = [];
    const activeRows: Array<{ row: Record<string, unknown>; expiresAtMs: number }> = [];

    for (const row of (rows ?? []) as Array<Record<string, unknown>>) {
      const id = String(row.id);
      const deletedAtMs = row.deleted_at ? new Date(String(row.deleted_at)).getTime() : nowMs;
      const expiresAtMs = row.trash_expires_at
        ? new Date(String(row.trash_expires_at)).getTime()
        : deletedAtMs + TRASH_MS;
      if (expiresAtMs <= nowMs) {
        expiredIds.push(id);
      } else {
        activeRows.push({ row, expiresAtMs });
      }
    }

    if (expiredIds.length > 0) {
      await Promise.all([
        db
          .from("controllers")
          .update({ permanently_deleted_at: nowIso })
          .in("id", expiredIds)
          .eq("account_id", auth.accountId),
        db
          .from("switches")
          .update({
            permanently_deleted_at: nowIso,
            deleted_reason: "controller_permanently_deleted",
          })
          .in("controller_id", expiredIds)
          .eq("account_id", auth.accountId)
          .is("permanently_deleted_at", null),
        db
          .from("devices")
          .update({
            permanently_deleted_at: nowIso,
            deleted_reason: "controller_permanently_deleted",
          })
          .in("controller_id", expiredIds)
          .eq("account_id", auth.accountId)
          .is("permanently_deleted_at", null),
        db
          .from("sensors")
          .update({
            permanently_deleted_at: nowIso,
            deleted_reason: "controller_permanently_deleted",
          })
          .in("controller_id", expiredIds)
          .eq("account_id", auth.accountId)
          .is("permanently_deleted_at", null),
      ]);
    }

    if (activeRows.length === 0) {
      return c.json({ controllers: [], retentionDays: CONTROLLER_TRASH_RETENTION_DAYS });
    }

    const activeIds = activeRows.map((a) => String(a.row.id));
    const [swRows, devRows, senRows] = await Promise.all([
      db
        .from("switches")
        .select("controller_id")
        .in("controller_id", activeIds)
        .eq("account_id", auth.accountId)
        .eq("deleted_reason", "controller_trashed")
        .is("permanently_deleted_at", null),
      db
        .from("devices")
        .select("controller_id")
        .in("controller_id", activeIds)
        .eq("account_id", auth.accountId)
        .eq("deleted_reason", "controller_trashed")
        .is("permanently_deleted_at", null),
      db
        .from("sensors")
        .select("controller_id")
        .in("controller_id", activeIds)
        .eq("account_id", auth.accountId)
        .eq("deleted_reason", "controller_trashed")
        .is("permanently_deleted_at", null),
    ]);

    const countByCtrl = (list: unknown[] | null) => {
      const m = new Map<string, number>();
      for (const item of (list ?? []) as Array<{ controller_id: string }>) {
        m.set(item.controller_id, (m.get(item.controller_id) ?? 0) + 1);
      }
      return m;
    };
    const swMap = countByCtrl(swRows.data);
    const devMap = countByCtrl(devRows.data);
    const senMap = countByCtrl(senRows.data);

    const activeTrash = activeRows.map(({ row, expiresAtMs }) => {
      const id = String(row.id);
      const daysRemaining = Math.max(
        1,
        Math.ceil((expiresAtMs - nowMs) / (24 * 60 * 60 * 1000))
      );
      return {
        ...row,
        trash_expires_at: new Date(expiresAtMs).toISOString(),
        days_remaining: daysRemaining,
        recoverable_counts: {
          switches: swMap.get(id) ?? 0,
          devices: devMap.get(id) ?? 0,
          sensors: senMap.get(id) ?? 0,
        },
      };
    });

    return c.json({ controllers: activeTrash, retentionDays: CONTROLLER_TRASH_RETENTION_DAYS });
  });

  // Existing Controller / Recover Controller initiation (single-use recovery code + physical confirmation required)
  app.post(
    "/recover",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = recoverControllerSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid controller recovery fields." }, 400);
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};

      const { data: settings } = await db
        .from("platform_settings")
        .select("max_controllers_per_account,pairing_code_expiration_seconds")
        .eq("id", 1)
        .maybeSingle();

      const cfg = settings as {
        max_controllers_per_account?: number;
        pairing_code_expiration_seconds?: number;
      } | null;

      const ttlSeconds = cfg?.pairing_code_expiration_seconds ?? 300;
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

      let targetController: Record<string, unknown>;

      if (parsed.data.controllerId) {
        const { data: existing } = await db
          .from("controllers")
          .select("*")
          .eq("id", parsed.data.controllerId)
          .eq("account_id", auth.accountId)
          .is("deleted_at", null)
          .is("permanently_deleted_at", null)
          .maybeSingle();

        if (!existing) {
          return c.json({ error: "Controller not found in your account." }, 404);
        }

        const cRow = existing as Record<string, unknown>;
        const controllerId = String(cRow.id);

        // Revoke any previous MQTT/device credentials cleanly before re-pairing
        const { data: oldCred } = await db
          .from("mqtt_credentials_metadata")
          .select("id,mqtt_username,mqtt_client_id,status")
          .eq("controller_id", controllerId)
          .eq("account_id", auth.accountId)
          .maybeSingle();

        if (oldCred) {
          const oldRow = oldCred as {
            id: string;
            mqtt_username: string;
            mqtt_client_id: string;
            status: string;
          };
          if (oldRow.status === "active" && isEmqxConfigured(c.env ?? {})) {
            const emqx = new EmqxClient(c.env!, deps.emqxFetch);
            try {
              await emqx.revokeControllerCredentials(
                oldRow.mqtt_username,
                oldRow.mqtt_client_id
              );
            } catch {
              // Proceed with DB revocation
            }
          }
          await db
            .from("mqtt_credentials_metadata")
            .update({
              status: "revoked",
              emqx_synced: false,
              revoked_at: new Date().toISOString(),
            })
            .eq("id", oldRow.id);
        }

        // Invalidate unused codes
        await db
          .from("pairing_codes")
          .update({ used_at: new Date().toISOString() })
          .eq("controller_id", controllerId)
          .eq("account_id", auth.accountId)
          .is("used_at", null);

        const { data: updated } = await db
          .from("controllers")
          .update({
            status: "pending",
            pairing_status: "recovery_pending",
            mqtt_connected: false,
            last_error: null,
            last_error_at: null,
          })
          .eq("id", controllerId)
          .eq("account_id", auth.accountId)
          .select("*")
          .single();

        targetController = (updated ?? cRow) as Record<string, unknown>;
      } else {
        // Recovering a permanently deleted controller into a fresh recovery slot
        if (!parsed.data.name) {
          return c.json(
            { error: "Controller name is required when recovering a permanently deleted controller." },
            400
          );
        }

        const { boardCatalogId, customBoardId } = parsed.data;
        if ((!boardCatalogId && !customBoardId) || (boardCatalogId && customBoardId)) {
          return c.json(
            { error: "Specify either boardCatalogId or customBoardId." },
            400
          );
        }

        const { count: currentCount } = await db
          .from("controllers")
          .select("id", { count: "exact", head: true })
          .eq("account_id", auth.accountId)
          .is("deleted_at", null);

        if ((currentCount ?? 0) >= (cfg?.max_controllers_per_account ?? 25)) {
          return c.json(
            { error: "Controller limit reached for this account." },
            403
          );
        }

        const homeId = await resolveAccountHomeId(db, auth.accountId, parsed.data.homeId);
        if (!homeId) return c.json({ error: "Home not found in your account." }, 404);

        const boardSpec = await resolveBoardSpec(
          db,
          auth.accountId,
          boardCatalogId,
          customBoardId
        );
        if (!boardSpec) {
          return c.json({ error: "Selected board profile is unavailable." }, 404);
        }

        const { data: created, error: cErr } = await db
          .from("controllers")
          .insert({
            account_id: auth.accountId,
            home_id: homeId,
            board_catalog_id: boardCatalogId ?? null,
            custom_board_id: customBoardId ?? null,
            name: parsed.data.name,
            board_model: boardSpec.model,
            chip_variant: boardSpec.chip_variant,
            flash_size_mb: boardSpec.flash_size_mb,
            psram_size_mb: boardSpec.psram_size_mb,
            status: "pending",
            pairing_status: "recovery_pending",
            mqtt_connected: false,
            wifi_connected: false,
            connection_history: [
              {
                event: "recovery_initiated",
                at: new Date().toISOString(),
                status: "recovery_pending",
              },
            ],
          })
          .select("*")
          .single();

        if (cErr || !created) {
          return c.json(
            { error: cErr?.message ?? "Failed to create recovery controller slot." },
            400
          );
        }

        targetController = created as Record<string, unknown>;
      }

      const controllerId = String(targetController.id);
      const recoveryCode = generateSixDigitPairingCode();
      const codeHash = await sha256Hex(recoveryCode);

      await db.from("pairing_codes").insert({
        account_id: auth.accountId,
        controller_id: controllerId,
        code_hash: codeHash,
        purpose: "recovery",
        requires_physical_confirmation: true,
        expires_at: expiresAt,
        created_by: auth.userId,
      });

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        controllerId,
        category: "pairing",
        action: "controller.recovery_initiated",
        summary: `Initiated secure recovery re-pairing for "${String(targetController.name)}" (physical confirmation required)`,
      });

      await emitNotification(db, {
        scope: "user",
        accountId: auth.accountId,
        category: "security",
        eventKey: "security.controller_recovery_initiated",
        preferenceKey: "security_events",
        severity: "warning",
        title: `Recovery Initiated: ${String(targetController.name)}`,
        message: "A single-use recovery pairing code was generated; physical button or setup AP confirmation is required.",
        metadata: { controllerId },
      });

      const recBoard = await resolveControllerCompatBoard(db, {
        board_catalog_id: targetController.board_catalog_id
          ? String(targetController.board_catalog_id)
          : null,
        custom_board_id: targetController.custom_board_id
          ? String(targetController.custom_board_id)
          : null,
      });
      const recBootGpio = recBoard
        ? (recBoard.boot_button_gpio ??
          defaultBootButtonGpioForChip(recBoard.chip_family, recBoard.slug))
        : 0;

      return c.json(
        {
          controller: targetController,
          pairingCode: recoveryCode,
          purpose: "recovery",
          requiresPhysicalConfirmation: true,
          expiresAt,
          expiresInSeconds: ttlSeconds,
          physicalConfirmationInstructions:
            recBoard?.supports_wifi === false
              ? [
                  `Hold the controller's physical BOOT / Recovery button (GPIO${recBootGpio}) for 3 seconds to enter local BLE recovery mode.`,
                  "Note: ESP32-H2 does not have an integrated Wi-Fi radio for standalone MQTT operation.",
                  "HomecoreOS will verify the controller's hardware identity, revoke old credentials, issue new MQTT credentials, and sync controller configuration.",
                ]
              : supportsBleProvisioningForBoard(recBoard).supportsBle
                ? [
                    `Hold the controller's physical BOOT / Recovery button (GPIO${recBootGpio}) for 3 seconds until Bluetooth LE recovery and HomecoreOS-Setup-XXXX open.`,
                    "Use Recover with BLE in HomecoreOS, OR connect to HomecoreOS-Setup-XXXX and open http://192.168.4.1 to submit Wi-Fi credentials and the recovery code.",
                    "HomecoreOS will verify the controller's hardware identity, revoke old credentials, issue new MQTT credentials, and sync controller configuration.",
                  ]
                : [
                    `Hold the controller's physical BOOT / Recovery button (GPIO${recBootGpio}) for 3 seconds until HomecoreOS-Setup-XXXX starts.`,
                    "Connect to HomecoreOS-Setup-XXXX, open http://192.168.4.1, enter the temporary single-use recovery code above, and confirm physical access.",
                    "HomecoreOS will verify the controller's hardware identity, revoke old credentials, issue new MQTT credentials, and sync controller configuration.",
                  ],
        },
        201
      );
    }
  );

  app.get("/:id", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const id = c.req.param("id");

    const { data: controller } = await db
      .from("controllers")
      .select("*")
      .eq("id", id)
      .eq("account_id", auth.accountId)
      .is("deleted_at", null)
      .is("permanently_deleted_at", null)
      .maybeSingle();

    if (!controller) return c.json({ error: "Controller not found." }, 404);

    const ctrlRow = controller as Record<string, unknown>;
    const [{ data: cred }, board] = await Promise.all([
      db
        .from("mqtt_credentials_metadata")
        .select(
          "mqtt_username,mqtt_client_id,topic_prefix,emqx_synced,status,last_rotated_at"
        )
        .eq("controller_id", id)
        .eq("account_id", auth.accountId)
        .maybeSingle(),
      resolveControllerCompatBoard(db, {
        board_catalog_id: ctrlRow.board_catalog_id
          ? String(ctrlRow.board_catalog_id)
          : null,
        custom_board_id: ctrlRow.custom_board_id
          ? String(ctrlRow.custom_board_id)
          : null,
      }),
    ]);

    return c.json({
      controller: {
        ...ctrlRow,
        mqtt: cred ?? null,
        board_compat: summarizeBoardCompat(board),
        offline_recovery_instructions: buildOfflineRecoveryInstructions(board),
      },
    });
  });

  app.post(
    "/",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = createControllerSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid controller creation fields." }, 400);
      }

      const { boardCatalogId, customBoardId } = parsed.data;
      if ((!boardCatalogId && !customBoardId) || (boardCatalogId && customBoardId)) {
        return c.json(
          { error: "Specify either boardCatalogId or customBoardId." },
          400
        );
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");

      const [{ data: settings }, { count: currentCount }] = await Promise.all([
        db
          .from("platform_settings")
          .select("max_controllers_per_account,pairing_code_expiration_seconds")
          .eq("id", 1)
          .maybeSingle(),
        db
          .from("controllers")
          .select("id", { count: "exact", head: true })
          .eq("account_id", auth.accountId)
          .is("deleted_at", null),
      ]);

      const cfg = settings as {
        max_controllers_per_account?: number;
        pairing_code_expiration_seconds?: number;
      } | null;

      if ((currentCount ?? 0) >= (cfg?.max_controllers_per_account ?? 25)) {
        return c.json(
          { error: "Controller limit reached for this account." },
          403
        );
      }

      const homeId = await resolveAccountHomeId(db, auth.accountId, parsed.data.homeId);
      if (!homeId) return c.json({ error: "Home not found in your account." }, 404);

      const boardSpec = await resolveBoardSpec(
        db,
        auth.accountId,
        boardCatalogId,
        customBoardId
      );
      if (!boardSpec) {
        return c.json(
          { error: "Selected board catalog or custom board profile is unavailable." },
          404
        );
      }

      const { data: controller, error: cErr } = await db
        .from("controllers")
        .insert({
          account_id: auth.accountId,
          home_id: homeId,
          board_catalog_id: boardCatalogId ?? null,
          custom_board_id: customBoardId ?? null,
          name: parsed.data.name,
          board_model: boardSpec.model,
          chip_variant: boardSpec.chip_variant,
          flash_size_mb: boardSpec.flash_size_mb,
          psram_size_mb: boardSpec.psram_size_mb,
          status: "pending",
          pairing_status: "pending",
          mqtt_connected: false,
          wifi_connected: false,
          connection_history: [
            { event: "created", at: new Date().toISOString(), status: "pending" },
          ],
        })
        .select("*")
        .single();

      if (cErr || !controller) {
        return c.json({ error: cErr?.message ?? "Failed to create controller." }, 400);
      }

      const controllerId = (controller as { id: string }).id;
      const pairingCode = generateSixDigitPairingCode();
      const codeHash = await sha256Hex(pairingCode);
      const ttlSeconds = cfg?.pairing_code_expiration_seconds ?? 300;
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

      await db.from("pairing_codes").insert({
        account_id: auth.accountId,
        controller_id: controllerId,
        code_hash: codeHash,
        purpose: "initial_pair",
        requires_physical_confirmation: false,
        expires_at: expiresAt,
        created_by: auth.userId,
      });

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        controllerId,
        category: "pairing",
        action: "controller.pairing_initiated",
        summary: `Created pending controller "${parsed.data.name}" (${boardSpec.model}) with 6-digit pairing code`,
      });

      return c.json(
        {
          controller,
          pairingCode,
          expiresAt,
          expiresInSeconds: ttlSeconds,
        },
        201
      );
    }
  );

  app.post(
    "/:id/regenerate-pairing-code",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const controllerId = c.req.param("id");

      const { data: controller } = await db
        .from("controllers")
        .select("id,name,paired_at,pairing_status")
        .eq("id", controllerId)
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .maybeSingle();

      if (!controller) return c.json({ error: "Controller not found." }, 404);
      const cRow = controller as {
        id: string;
        name: string;
        paired_at: string | null;
        pairing_status: string;
      };
      const isRecovery = Boolean(cRow.paired_at || cRow.pairing_status === "recovery_pending");

      const { data: settings } = await db
        .from("platform_settings")
        .select("pairing_code_expiration_seconds")
        .eq("id", 1)
        .maybeSingle();

      const ttlSeconds =
        (settings as { pairing_code_expiration_seconds?: number } | null)
          ?.pairing_code_expiration_seconds ?? 300;

      await db
        .from("pairing_codes")
        .update({ used_at: new Date().toISOString() })
        .eq("controller_id", controllerId)
        .eq("account_id", auth.accountId)
        .is("used_at", null);

      const pairingCode = generateSixDigitPairingCode();
      const codeHash = await sha256Hex(pairingCode);
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

      await db.from("pairing_codes").insert({
        account_id: auth.accountId,
        controller_id: controllerId,
        code_hash: codeHash,
        purpose: isRecovery ? "recovery" : "initial_pair",
        requires_physical_confirmation: isRecovery,
        expires_at: expiresAt,
        created_by: auth.userId,
      });

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        controllerId,
        category: "pairing",
        action: "controller.pairing_code_regenerated",
        summary: `Generated new ${isRecovery ? "recovery " : ""}pairing code for "${cRow.name}"`,
      });

      return c.json({
        pairingCode,
        purpose: isRecovery ? "recovery" : "initial_pair",
        requiresPhysicalConfirmation: isRecovery,
        expiresAt,
        expiresInSeconds: ttlSeconds,
      });
    }
  );

  // Restore soft-deleted controller from Trash (30-day recovery window)
  app.post(
    "/:id/restore",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};
      const controllerId = c.req.param("id");

      const { data: trashed } = await db
        .from("controllers")
        .select("*")
        .eq("id", controllerId)
        .eq("account_id", auth.accountId)
        .not("deleted_at", "is", null)
        .is("permanently_deleted_at", null)
        .maybeSingle();

      if (!trashed) {
        return c.json({ error: "Controller not found in Trash." }, 404);
      }

      const cRow = trashed as {
        id: string;
        name: string;
        deleted_at: string;
        trash_expires_at: string | null;
        connection_history: unknown[];
      };
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const deletedMs = new Date(cRow.deleted_at).getTime();
      const expiresMs = cRow.trash_expires_at
        ? new Date(cRow.trash_expires_at).getTime()
        : deletedMs + TRASH_MS;

      if (expiresMs <= nowMs) {
        await db
          .from("controllers")
          .update({ permanently_deleted_at: nowIso })
          .eq("id", controllerId)
          .eq("account_id", auth.accountId);
        return c.json(
          {
            error:
              "Controller Trash retention period (30 days) has expired. Use Existing Controller / Recover Controller to re-pair.",
          },
          410
        );
      }

      const [{ data: settings }, { count: currentCount }] = await Promise.all([
        db
          .from("platform_settings")
          .select("max_controllers_per_account,pairing_code_expiration_seconds")
          .eq("id", 1)
          .maybeSingle(),
        db
          .from("controllers")
          .select("id", { count: "exact", head: true })
          .eq("account_id", auth.accountId)
          .is("deleted_at", null),
      ]);

      const cfg = settings as {
        max_controllers_per_account?: number;
        pairing_code_expiration_seconds?: number;
      } | null;

      if ((currentCount ?? 0) >= (cfg?.max_controllers_per_account ?? 25)) {
        return c.json(
          { error: "Controller limit reached for this account; remove an active controller before restoring." },
          403
        );
      }

      // Verify valid active rooms so stale deleted rooms are safely unlinked rather than breaking integrity
      const { data: activeRooms } = await db
        .from("rooms")
        .select("id")
        .eq("account_id", auth.accountId)
        .is("deleted_at", null);
      const validRoomIds = new Set(
        ((activeRooms ?? []) as Array<{ id: string }>).map((r) => r.id)
      );

      // Restore controller hardware entities that were soft-trashed with it
      const [swRes, devRes, senRes] = await Promise.all([
        db
          .from("switches")
          .select("id,room_id")
          .eq("controller_id", controllerId)
          .eq("account_id", auth.accountId)
          .eq("deleted_reason", "controller_trashed")
          .is("permanently_deleted_at", null),
        db
          .from("devices")
          .select("id,room_id")
          .eq("controller_id", controllerId)
          .eq("account_id", auth.accountId)
          .eq("deleted_reason", "controller_trashed")
          .is("permanently_deleted_at", null),
        db
          .from("sensors")
          .select("id,room_id")
          .eq("controller_id", controllerId)
          .eq("account_id", auth.accountId)
          .eq("deleted_reason", "controller_trashed")
          .is("permanently_deleted_at", null),
      ]);

      const swList = (swRes.data ?? []) as Array<{ id: string; room_id: string | null }>;
      const devList = (devRes.data ?? []) as Array<{ id: string; room_id: string | null }>;
      const senList = (senRes.data ?? []) as Array<{ id: string; room_id: string | null }>;

      await Promise.all([
        ...swList.map((item) =>
          db
            .from("switches")
            .update({
              deleted_at: null,
              deleted_reason: null,
              room_id: item.room_id && validRoomIds.has(item.room_id) ? item.room_id : null,
            })
            .eq("id", item.id)
        ),
        ...devList.map((item) =>
          db
            .from("devices")
            .update({
              deleted_at: null,
              deleted_reason: null,
              room_id: item.room_id && validRoomIds.has(item.room_id) ? item.room_id : null,
            })
            .eq("id", item.id)
        ),
        ...senList.map((item) =>
          db
            .from("sensors")
            .update({
              deleted_at: null,
              deleted_reason: null,
              room_id: item.room_id && validRoomIds.has(item.room_id) ? item.room_id : null,
            })
            .eq("id", item.id)
        ),
      ]);

      // Check MQTT credentials; if revoked or absent, securely generate & provision fresh credentials
      const { data: credRow } = await db
        .from("mqtt_credentials_metadata")
        .select("*")
        .eq("controller_id", controllerId)
        .eq("account_id", auth.accountId)
        .maybeSingle();

      let credentialsRotated = false;
      let provisionedCreds: Record<string, unknown> | null = null;
      let recoveryPairingCode: string | null = null;
      let recoveryExpiresAt: string | null = null;

      if (!credRow || (credRow as { status: string }).status !== "active") {
        credentialsRotated = true;
        const suffix = generateRandomToken(3).toLowerCase().slice(0, 4);
        const mqttUsername = `hc_${controllerId.replace(/-/g, "").slice(0, 12)}_${suffix}`;
        const mqttClientId = `hc_esp_${controllerId.replace(/-/g, "").slice(0, 12)}_${suffix}`;
        const mqttPassword = generateRandomToken(24);
        const deviceApiToken = generateRandomToken(32);
        const deviceTokenHash = await sha256Hex(deviceApiToken);
        const topicPrefix = buildControllerTopicPrefix(auth.accountId, controllerId);

        let emqxSynced = false;
        if (isEmqxConfigured(c.env ?? {})) {
          const emqx = new EmqxClient(c.env!, deps.emqxFetch);
          await emqx.provisionControllerCredentials({
            accountId: auth.accountId,
            controllerId,
            username: mqttUsername,
            password: mqttPassword,
          });
          emqxSynced = true;
        }

        const { data: upsertedCred } = await db
          .from("mqtt_credentials_metadata")
          .upsert(
            {
              account_id: auth.accountId,
              controller_id: controllerId,
              mqtt_username: mqttUsername,
              mqtt_client_id: mqttClientId,
              device_token_hash: deviceTokenHash,
              topic_prefix: topicPrefix,
              emqx_synced: emqxSynced,
              status: "active",
              last_rotated_at: nowIso,
              revoked_at: null,
            },
            { onConflict: "controller_id" }
          )
          .select("mqtt_username,mqtt_client_id,topic_prefix,emqx_synced,status")
          .single();

        provisionedCreds = (upsertedCred ?? {
          mqtt_username: mqttUsername,
          mqtt_client_id: mqttClientId,
          topic_prefix: topicPrefix,
          emqx_synced: emqxSynced,
          status: "active",
        }) as Record<string, unknown>;

        // Also provide a temporary single-use recovery code so the hardware can securely pull rotated credentials if needed
        const ttlSeconds = cfg?.pairing_code_expiration_seconds ?? 300;
        recoveryPairingCode = generateSixDigitPairingCode();
        recoveryExpiresAt = new Date(nowMs + ttlSeconds * 1000).toISOString();
        await db.from("pairing_codes").insert({
          account_id: auth.accountId,
          controller_id: controllerId,
          code_hash: await sha256Hex(recoveryPairingCode),
          purpose: "recovery",
          requires_physical_confirmation: true,
          expires_at: recoveryExpiresAt,
          created_by: auth.userId,
        });
      }

      const prevHistory = Array.isArray(cRow.connection_history)
        ? cRow.connection_history.slice(-19)
        : [];

      const { data: restoredCtrl } = await db
        .from("controllers")
        .update({
          deleted_at: null,
          trash_expires_at: null,
          status: "offline",
          pairing_status: credentialsRotated ? "recovery_pending" : "paired",
          mqtt_connected: false,
          wifi_connected: false,
          last_error: null,
          last_error_at: null,
          connection_history: [
            ...prevHistory,
            { event: "restored_from_trash", at: nowIso },
          ],
        })
        .eq("id", controllerId)
        .eq("account_id", auth.accountId)
        .select("*")
        .single();

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        controllerId,
        category: "controller",
        action: "controller.restored",
        summary: `Restored controller "${cRow.name}" from Trash (${swList.length} switches, ${devList.length} devices, ${senList.length} sensors)${
          credentialsRotated ? " with newly provisioned MQTT credentials" : ""
        }`,
      });

      if (credentialsRotated) {
        await emitNotification(db, {
          scope: "user",
          accountId: auth.accountId,
          category: "security",
          eventKey: "security.credentials_rotated",
          preferenceKey: "security_events",
          severity: "warning",
          title: `Credentials Rotated: ${cRow.name}`,
          message: "Controller restored from Trash with freshly rotated MQTT credentials.",
          metadata: { controllerId },
        });
      }

      return c.json({
        controller: {
          ...(restoredCtrl as Record<string, unknown>),
          mqtt: provisionedCreds ?? credRow ?? null,
        },
        restoredCounts: {
          switches: swList.length,
          devices: devList.length,
          sensors: senList.length,
        },
        credentialsRotated,
        pairingCode: recoveryPairingCode,
        expiresAt: recoveryExpiresAt,
      });
    }
  );

  app.patch(
    "/:id",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = updateControllerSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: "Invalid controller name." }, 400);

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const { data, error } = await db
        .from("controllers")
        .update({ name: parsed.data.name })
        .eq("id", c.req.param("id"))
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .select("*")
        .maybeSingle();

      if (error) return c.json({ error: error.message }, 400);
      if (!data) return c.json({ error: "Controller not found." }, 404);

      await syncControllerConfigSnapshot(db, c.env ?? {}, c.get("deps") ?? {}, {
        accountId: auth.accountId,
        controllerId: c.req.param("id"),
        reason: "config_change",
      }).catch(() => null);

      return c.json({ controller: data });
    }
  );

  app.post(
    "/:id/sync-config",
    requireStaffRole("owner", "administrator", "operator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};
      const controllerId = c.req.param("id");

      const { data: ctrl } = await db
        .from("controllers")
        .select("id")
        .eq("id", controllerId)
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .is("permanently_deleted_at", null)
        .maybeSingle();

      if (!ctrl) return c.json({ error: "Controller not found." }, 404);

      const result = await syncControllerConfigSnapshot(db, c.env ?? {}, deps, {
        accountId: auth.accountId,
        controllerId,
        reason: "explicit_sync",
        forcePublish: true,
      });

      return c.json({ ok: true, ...result });
    }
  );

  // Soft-delete to Trash (30-day retention window)
  app.delete(
    "/:id",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};
      const controllerId = c.req.param("id");

      const { data: controller } = await db
        .from("controllers")
        .select("id,name")
        .eq("id", controllerId)
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .is("permanently_deleted_at", null)
        .maybeSingle();

      if (!controller) return c.json({ error: "Controller not found." }, 404);

      await revokeControllerCredentialsAndCodes(
        db,
        c.env ?? {},
        deps,
        auth.accountId,
        controllerId
      );

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const trashExpiresAt = new Date(nowMs + TRASH_MS).toISOString();

      await Promise.all([
        db
          .from("controllers")
          .update({
            deleted_at: nowIso,
            trash_expires_at: trashExpiresAt,
            status: "disconnected",
            pairing_status: "revoked",
            mqtt_connected: false,
            wifi_connected: false,
          })
          .eq("id", controllerId)
          .eq("account_id", auth.accountId),
        db
          .from("switches")
          .update({ deleted_at: nowIso, deleted_reason: "controller_trashed" })
          .eq("controller_id", controllerId)
          .eq("account_id", auth.accountId)
          .is("deleted_at", null),
        db
          .from("devices")
          .update({ deleted_at: nowIso, deleted_reason: "controller_trashed" })
          .eq("controller_id", controllerId)
          .eq("account_id", auth.accountId)
          .is("deleted_at", null),
        db
          .from("sensors")
          .update({ deleted_at: nowIso, deleted_reason: "controller_trashed" })
          .eq("controller_id", controllerId)
          .eq("account_id", auth.accountId)
          .is("deleted_at", null),
      ]);

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        controllerId,
        category: "controller",
        action: "controller.deleted",
        summary: `Moved controller "${(controller as { name: string }).name}" to Trash (30-day recovery window) and revoked MQTT credentials`,
      });

      return c.json({ ok: true, trashed: true, trashExpiresAt });
    }
  );

  // Permanent deletion (from active list or Trash)
  app.delete(
    "/:id/permanent",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};
      const controllerId = c.req.param("id");

      const { data: controller } = await db
        .from("controllers")
        .select("id,name,deleted_at")
        .eq("id", controllerId)
        .eq("account_id", auth.accountId)
        .is("permanently_deleted_at", null)
        .maybeSingle();

      if (!controller) return c.json({ error: "Controller not found." }, 404);

      await revokeControllerCredentialsAndCodes(
        db,
        c.env ?? {},
        deps,
        auth.accountId,
        controllerId
      );

      const nowIso = new Date().toISOString();
      const existingDeletedAt = (controller as { deleted_at: string | null }).deleted_at;

      await Promise.all([
        db
          .from("controllers")
          .update({
            deleted_at: existingDeletedAt ?? nowIso,
            permanently_deleted_at: nowIso,
            status: "disconnected",
            pairing_status: "revoked",
            mqtt_connected: false,
            wifi_connected: false,
          })
          .eq("id", controllerId)
          .eq("account_id", auth.accountId),
        db
          .from("switches")
          .update({
            deleted_at: nowIso,
            permanently_deleted_at: nowIso,
            deleted_reason: "controller_permanently_deleted",
          })
          .eq("controller_id", controllerId)
          .eq("account_id", auth.accountId)
          .is("permanently_deleted_at", null),
        db
          .from("devices")
          .update({
            deleted_at: nowIso,
            permanently_deleted_at: nowIso,
            deleted_reason: "controller_permanently_deleted",
          })
          .eq("controller_id", controllerId)
          .eq("account_id", auth.accountId)
          .is("permanently_deleted_at", null),
        db
          .from("sensors")
          .update({
            deleted_at: nowIso,
            permanently_deleted_at: nowIso,
            deleted_reason: "controller_permanently_deleted",
          })
          .eq("controller_id", controllerId)
          .eq("account_id", auth.accountId)
          .is("permanently_deleted_at", null),
      ]);

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        controllerId,
        category: "controller",
        action: "controller.permanently_deleted",
        summary: `Permanently deleted controller "${(controller as { name: string }).name}" and revoked all credentials`,
      });

      return c.json({ ok: true, permanentlyDeleted: true });
    }
  );

  // Remote MQTT controller operations
  async function dispatchControllerCommand(
    c: Context<AppEnv>,
    command: "disconnect" | "reconnect" | "restart" | "reset" | "wifi",
    payload: Record<string, unknown> = {}
  ) {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const deps = c.get("deps") ?? {};
    const controllerId = c.req.param("id");

    const { data: ctrlData } = await db
      .from("controllers")
      .select("*")
      .eq("id", controllerId)
      .eq("account_id", auth.accountId)
      .is("deleted_at", null)
      .is("permanently_deleted_at", null)
      .maybeSingle();

    if (!ctrlData) return c.json({ error: "Controller not found." }, 404);
    const ctrl = ctrlData as {
      id: string;
      name: string;
      status: string;
      mqtt_connected: boolean;
      connection_history: unknown[];
      board_catalog_id?: string | null;
      custom_board_id?: string | null;
    };

    const { data: cred } = await db
      .from("mqtt_credentials_metadata")
      .select("mqtt_client_id,topic_prefix,status")
      .eq("controller_id", controllerId)
      .eq("account_id", auth.accountId)
      .maybeSingle();

    const board = await resolveControllerCompatBoard(db, {
      board_catalog_id: ctrl.board_catalog_id ? String(ctrl.board_catalog_id) : null,
      custom_board_id: ctrl.custom_board_id ? String(ctrl.custom_board_id) : null,
    });
    const offlineRecovery = buildOfflineRecoveryInstructions(board);
    const bootGpio = board
      ? (board.boot_button_gpio ??
        defaultBootButtonGpioForChip(board.chip_family, board.slug))
      : 0;

    if (!cred || (cred as { status: string }).status !== "active") {
      return c.json(
        {
          error:
            "Controller has no active MQTT credentials. Use Existing Controller / Recover Controller or follow local recovery instructions.",
          offlineRecovery,
        },
        409
      );
    }

    const credRow = cred as { mqtt_client_id: string; topic_prefix: string };

    if (ctrl.status !== "online" && command !== "reconnect") {
      return c.json(
        {
          error: `Controller "${ctrl.name}" is currently ${ctrl.status}. Remote MQTT command cannot be delivered while offline — hold BOOT (GPIO${bootGpio}) for 3 seconds to open recovery mode on the controller.`,
          offlineRecovery,
        },
        409
      );
    }

    if (!isEmqxConfigured(c.env ?? {})) {
      return c.json(
        {
          error: "EMQX Serverless is not configured on this Worker.",
          offlineRecovery,
        },
        503
      );
    }

    const emqx = new EmqxClient(c.env!, deps.emqxFetch);

    if (command === "disconnect") {
      await emqx.kickClient(credRow.mqtt_client_id);
      await db
        .from("controllers")
        .update({
          status: "disconnected",
          mqtt_connected: false,
          connection_history: [
            ...(Array.isArray(ctrl.connection_history)
              ? ctrl.connection_history.slice(-19)
              : []),
            { event: "disconnected_by_user", at: new Date().toISOString() },
          ],
        })
        .eq("id", controllerId)
        .eq("account_id", auth.accountId);
    } else if (command === "reconnect") {
      await emqx.publish({
        topic: `${credRow.topic_prefix}/cmd/system`,
        payload: { action: "reconnect", requested_at: new Date().toISOString() },
        qos: 1,
      });
    } else {
      await emqx.publish({
        topic: `${credRow.topic_prefix}/cmd/system`,
        payload: {
          action: command,
          ...payload,
          requested_at: new Date().toISOString(),
        },
        qos: 1,
      });
      if (command === "reset") {
        await db
          .from("controllers")
          .update({
            status: "reset_pending",
            pairing_status: "revoked",
            mqtt_connected: false,
          })
          .eq("id", controllerId)
          .eq("account_id", auth.accountId);
      }
    }

    await recordActivity(db, {
      accountId: auth.accountId,
      actorUserId: auth.userId,
      controllerId,
      category: "controller",
      action: `controller.${command}`,
      summary: `Sent "${command}" command to controller "${ctrl.name}"`,
    });

    return c.json({ ok: true, command, controllerId });
  }

  app.post("/:id/disconnect", requireStaffRole("owner", "administrator", "operator"), (c) =>
    dispatchControllerCommand(c, "disconnect")
  );
  app.post("/:id/reconnect", requireStaffRole("owner", "administrator", "operator"), (c) =>
    dispatchControllerCommand(c, "reconnect")
  );
  app.post("/:id/restart", requireStaffRole("owner", "administrator", "operator"), (c) =>
    dispatchControllerCommand(c, "restart")
  );
  app.post("/:id/reset", requireStaffRole("owner", "administrator"), (c) =>
    dispatchControllerCommand(c, "reset")
  );
  app.post(
    "/:id/wifi",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = wifiConfigSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Valid Wi-Fi SSID and password are required." }, 400);
      }
      return dispatchControllerCommand(c, "wifi", {
        ssid: parsed.data.ssid,
        password: parsed.data.password,
      });
    }
  );

  return app;
}

async function resolveAccountHomeId(
  db: AppEnv["Variables"]["db"],
  accountId: string,
  requestedHomeId?: string
): Promise<string | null> {
  if (requestedHomeId) {
    const { data: h } = await db
      .from("homes")
      .select("id")
      .eq("id", requestedHomeId)
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .maybeSingle();
    return h ? String((h as { id: string }).id) : null;
  }

  const { data: defaultHome } = await db
    .from("homes")
    .select("id")
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (defaultHome) return String((defaultHome as { id: string }).id);

  const { data: createdHome } = await db
    .from("homes")
    .insert({ account_id: accountId, name: "Primary Home" })
    .select("id")
    .single();
  return createdHome ? String((createdHome as { id: string }).id) : null;
}

async function resolveBoardSpec(
  db: AppEnv["Variables"]["db"],
  accountId: string,
  boardCatalogId?: string,
  customBoardId?: string
): Promise<{
  model: string;
  chip_variant: string;
  flash_size_mb: number;
  psram_size_mb: number;
} | null> {
  if (boardCatalogId) {
    const { data: b } = await db
      .from("board_catalog")
      .select("model,chip_variant,flash_size_mb,psram_size_mb,is_available")
      .eq("id", boardCatalogId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!b || !(b as { is_available: boolean }).is_available) return null;
    return b as {
      model: string;
      chip_variant: string;
      flash_size_mb: number;
      psram_size_mb: number;
    };
  }
  if (customBoardId) {
    const { data: cb } = await db
      .from("custom_boards")
      .select("model,chip_variant,flash_size_mb,psram_size_mb,is_validated")
      .eq("id", customBoardId)
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!cb || !(cb as { is_validated: boolean }).is_validated) return null;
    return cb as {
      model: string;
      chip_variant: string;
      flash_size_mb: number;
      psram_size_mb: number;
    };
  }
  return null;
}

async function revokeControllerCredentialsAndCodes(
  db: AppEnv["Variables"]["db"],
  env: AppEnv["Bindings"],
  deps: NonNullable<AppEnv["Variables"]["deps"]>,
  accountId: string,
  controllerId: string
) {
  const { data: cred } = await db
    .from("mqtt_credentials_metadata")
    .select("id,mqtt_username,mqtt_client_id,status")
    .eq("controller_id", controllerId)
    .eq("account_id", accountId)
    .maybeSingle();

  if (cred) {
    const cRow = cred as {
      id: string;
      mqtt_username: string;
      mqtt_client_id: string;
    };
    if (isEmqxConfigured(env)) {
      const emqx = new EmqxClient(env, deps.emqxFetch);
      try {
        await emqx.revokeControllerCredentials(
          cRow.mqtt_username,
          cRow.mqtt_client_id
        );
      } catch {
        // Continue revoking DB state even if broker is unreachable
      }
    }
    await db
      .from("mqtt_credentials_metadata")
      .update({
        status: "revoked",
        emqx_synced: false,
        device_token_hash: null,
        revoked_at: new Date().toISOString(),
      })
      .eq("id", cRow.id);
  }

  await db
    .from("pairing_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("controller_id", controllerId)
    .eq("account_id", accountId)
    .is("used_at", null);
}
