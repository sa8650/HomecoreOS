import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  ESPNOW_NODE_STALE_MS,
  isDeviceStateActive,
  isNewerFirmwareVersion,
  normalizeBoardRole,
} from "@homecoreos/shared";
import { inspectConfiguration, requireEmqxConfig } from "../config/env";
import { recordActivity } from "../lib/audit";
import { evaluateAutomationsForEvent } from "../lib/automation-engine";
import {
  acknowledgeControllerConfigRevision,
  buildConsolidatedControllerConfig,
  syncControllerConfigSnapshot,
} from "../lib/controller-config";
import { generateRandomToken, sha256Hex } from "../lib/crypto";
import {
  EmqxClient,
  buildControllerTopicPrefix,
  isEmqxConfigured,
} from "../lib/emqx";
import {
  checkControllerReleaseCompatibility,
  resolveControllerCompatBoard,
} from "../lib/firmware-compatibility";
import { resolveControllerBoardSpec } from "../lib/board-helpers";
import { findMatchingFirmwareReleaseIdForDevice } from "../lib/sensor-compatibility";
import { emitNotification } from "../lib/notifications";
import { getFirmwareObject } from "../lib/r2";
import {
  checkAttemptAllowed,
  extractClientIp,
  recordFailedAttempt,
  resetAttempts,
} from "../lib/rate-limit";
import { requireDeviceBearerAuth } from "../middleware/auth";
import type { AppEnv } from "../types/context";

const pairSchema = z.object({
  pairingCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "6-digit numeric pairing code required"),
  macAddress: z.string().trim().max(32).optional(),
  identityKey: z.string().trim().min(16).max(256).optional(),
  physicalConfirmed: z.boolean().optional(),
  physicalConfirmationMethod: z.enum(["button_press", "local_portal", "ble_recovery"]).optional(),
  firmwareVersion: z.string().trim().max(64).optional(),
  chipVariant: z.string().trim().max(64).optional(),
  boardSlug: z.string().trim().max(120).optional(),
  partitionScheme: z.string().trim().max(48).optional(),
  flashSizeMb: z.number().int().min(1).max(64).optional(),
  psramSizeMb: z.number().int().min(0).max(32).optional(),
  wifiSsid: z.string().trim().max(64).optional(),
  localIp: z.string().trim().max(64).optional(),
  bleSetupPin: z.string().trim().min(6).max(16).optional(),
  provisioningTransport: z.enum(["ble", "softap", "usb", "manual"]).optional(),
});

const recoverPairSchema = pairSchema.extend({
  identityKey: z
    .string()
    .trim()
    .min(32, "Controller hardware identity key is required for secure re-pairing")
    .max(256),
  physicalConfirmed: z.literal(true, {
    errorMap: () => ({
      message:
        "Physical confirmation via controller recovery button or local setup webpage is required.",
    }),
  }),
  physicalConfirmationMethod: z.enum(["button_press", "local_portal", "ble_recovery"]),
});

const heartbeatSchema = z
  .object({
    wifiRssi: z.number().int().min(-120).max(0).optional(),
    r: z.number().int().min(-120).max(0).optional(),
    wifiSsid: z.string().trim().max(64).optional(),
    s: z.string().trim().max(64).optional(),
    localIp: z.string().trim().max(64).optional(),
    ip: z.string().trim().max(64).optional(),
    firmwareVersion: z.string().trim().max(64).optional(),
    v: z.string().trim().max(64).optional(),
    wifiConnected: z.boolean().optional(),
    w: z.boolean().optional(),
    mqttConnected: z.boolean().optional(),
    m: z.boolean().optional(),
    lastError: z.string().max(300).nullable().optional(),
    err: z.string().max(300).nullable().optional(),
    macAddress: z.string().trim().max(32).optional(),
    mac: z.string().trim().max(32).optional(),
    boardSlug: z.string().trim().max(120).optional(),
    b: z.string().trim().max(120).optional(),
    partitionScheme: z.string().trim().max(48).optional(),
    ps: z.string().trim().max(48).optional(),
    flashSizeMb: z.number().int().min(1).max(64).optional(),
    detectedChipName: z.string().trim().max(64).optional(),
    otaPendingVerify: z.boolean().optional(),
    otaPending: z.boolean().optional(),
    op: z.boolean().optional(),
    bp: z.boolean().optional(),
    configRevision: z.number().int().min(0).optional(),
    rev: z.number().int().min(0).optional(),
    driverManifestHash: z.string().trim().max(128).optional(),
    dmh: z.string().trim().max(128).optional(),
    // Unified Controller / Node role reporting
    boardRole: z.enum(["controller", "node"]).optional(),
    role: z.enum(["controller", "node"]).optional(),
    commMode: z.enum(["espnow", "wifi_mqtt", "offline"]).optional(),
    cm: z.enum(["espnow", "wifi_mqtt", "offline"]).optional(),
    linkState: z
      .enum(["linked", "controller_lost", "reconnecting", "standalone", "unassigned"])
      .optional(),
    ls: z
      .enum(["linked", "controller_lost", "reconnecting", "standalone", "unassigned"])
      .optional(),
    /** Controller only: the Nodes it currently hosts over ESP-NOW. */
    nodes: z
      .array(
        z.object({
          id: z.string().trim().max(64),
          link: z.enum(["linked", "controller_lost", "reconnecting", "standalone", "unassigned"]).optional(),
          rssi: z.number().int().min(-120).max(0).optional(),
          channel: z.number().int().min(1).max(13).optional(),
        })
      )
      .max(64)
      .optional(),
  })
  .transform((d) => ({
    wifiRssi: d.wifiRssi ?? d.r,
    wifiSsid: d.wifiSsid ?? d.s,
    localIp: d.localIp ?? d.ip,
    firmwareVersion: d.firmwareVersion ?? d.v,
    wifiConnected: d.wifiConnected ?? d.w,
    mqttConnected: d.mqttConnected ?? d.m,
    lastError: d.lastError !== undefined ? d.lastError : d.err,
    macAddress: d.macAddress ?? d.mac,
    boardSlug: d.boardSlug ?? d.b,
    partitionScheme: d.partitionScheme ?? d.ps,
    flashSizeMb: d.flashSizeMb,
    detectedChipName: d.detectedChipName,
    otaPendingVerify: d.otaPendingVerify ?? d.otaPending ?? d.op ?? false,
    configRevision: d.configRevision ?? d.rev,
    driverManifestHash: d.driverManifestHash ?? d.dmh,
    boardRole: d.boardRole ?? d.role,
    commMode: d.commMode ?? d.cm,
    linkState: d.linkState ?? d.ls,
    nodes: d.nodes,
  }));

const configAckSchema = z.object({
  revision: z.number().int().min(1),
  hash: z.string().trim().max(128).optional(),
});

const telemetrySchema = z.object({
  sensors: z
    .array(
      z.object({
        sensorId: z.string().uuid(),
        value: z.union([z.number(), z.string(), z.boolean(), z.null()]).optional(),
        secondaryValue: z.number().optional(),
        unit: z.string().trim().max(24).optional(),
        timestamp: z.union([z.string().max(64), z.number()]).optional(),
        status: z.enum(["ok", "error"]).optional(),
        error: z.string().max(160).nullable().optional(),
        driverId: z.string().trim().max(48).optional(),
      })
    )
    .optional(),
  switches: z
    .array(
      z.object({
        switchId: z.string().uuid(),
        isOn: z.boolean(),
      })
    )
    .optional(),
  devices: z
    .array(
      z.object({
        deviceId: z.string().uuid(),
        state: z.string().trim().max(64),
      })
    )
    .optional(),
});

const otaProgressSchema = z.object({
  historyId: z.string().uuid().optional(),
  releaseId: z.string().uuid().optional(),
  status: z.enum([
    "downloading",
    "flashing",
    "verifying",
    "rebooting",
    "succeeded",
    "rolled_back",
    "failed",
    "cancelled",
  ]),
  progressPercent: z.number().int().min(0).max(100),
  firmwareVersion: z.string().trim().max(64).optional(),
  errorMessage: z.string().max(500).optional(),
});

const ACTIVE_OTA_STATUSES = [
  "pending",
  "downloading",
  "flashing",
  "verifying",
  "rebooting",
] as const;

const TERMINAL_OTA_STATUSES = new Set([
  "succeeded",
  "rolled_back",
  "failed",
  "cancelled",
]);

function normalizeVersionStr(v: string | null | undefined): string {
  return (v ?? "").trim().replace(/^v/i, "");
}

function versionsExactMatch(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const na = normalizeVersionStr(a);
  const nb = normalizeVersionStr(b);
  return na.length > 0 && nb.length > 0 && na === nb;
}

interface ClaimedPairingRow {
  pairing_code_id: string;
  account_id: string;
  board_instance_id: string;
  account_status: string;
  purpose?: "initial_pair" | "recovery";
  requires_physical_confirmation?: boolean;
}

export function createDeviceApiRoutes() {
  const app = new Hono<AppEnv>();

  app.post("/pair", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = pairSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "A valid 6-digit pairing code is required." }, 400);
    }
    return handlePairOrRecover(c, parsed.data, false);
  });

  app.post("/recover-pair", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = recoverPairSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error:
            parsed.error.issues[0]?.message ??
            "Valid recovery pairing code, hardware identity proof, and physical confirmation are required.",
        },
        parsed.error.issues.some((i) => i.path.includes("physicalConfirmed"))
          ? 403
          : 400
      );
    }
    return handlePairOrRecover(c, parsed.data, true);
  });

  app.get("/config", requireDeviceBearerAuth(), async (c) => {
    const dev = c.get("deviceAuth")!;
    const db = c.get("db");

    const { data: ctrl } = await db
      .from("board_instances")
      .select(
        "id,name,account_id,home_id,board_model,chip_variant,firmware_version,status,pairing_status,wifi_connected,mqtt_connected,config_revision,config_hash"
      )
      .eq("id", dev.boardInstanceId)
      .eq("account_id", dev.accountId)
      .is("deleted_at", null)
      .maybeSingle();

    if (!ctrl) return c.json({ error: "Controller not found." }, 404);

    const built = await buildConsolidatedControllerConfig(
      db,
      dev.accountId,
      dev.boardInstanceId
    );
    const snapshot = built.snapshot;

    const ctrlMeta = ctrl as { config_hash?: string | null };
    if (!ctrlMeta.config_hash) {
      await db
        .from("board_instances")
        .update({ config_hash: snapshot.hash })
        .eq("id", dev.boardInstanceId)
        .eq("account_id", dev.accountId);
    }

    const knownRevRaw = c.req.query("knownRevision") ?? c.req.query("revision");
    const knownRev = knownRevRaw !== undefined ? Number(knownRevRaw) : NaN;
    const ifNoneMatch = c.req.header("if-none-match")?.replace(/"/g, "");

    if (
      (Number.isFinite(knownRev) && knownRev === snapshot.revision) ||
      (ifNoneMatch && ifNoneMatch === snapshot.hash)
    ) {
      await acknowledgeControllerConfigRevision(
        db,
        dev.accountId,
        dev.boardInstanceId,
        snapshot.revision
      );
      return c.json({
        unchanged: true,
        revision: snapshot.revision,
        hash: snapshot.hash,
      });
    }

    await acknowledgeControllerConfigRevision(
      db,
      dev.accountId,
      dev.boardInstanceId,
      snapshot.revision
    );

    return c.json({ controller: ctrl, ...snapshot });
  });

  app.post("/config/ack", requireDeviceBearerAuth(), async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = configAckSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid config ACK payload." }, 400);
    }

    const dev = c.get("deviceAuth")!;
    const db = c.get("db");
    await acknowledgeControllerConfigRevision(
      db,
      dev.accountId,
      dev.boardInstanceId,
      parsed.data.revision
    );
    return c.json({ ok: true, revision: parsed.data.revision });
  });

  app.post("/heartbeat", requireDeviceBearerAuth(), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = heartbeatSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid heartbeat payload." }, 400);

    const dev = c.get("deviceAuth")!;
    const db = c.get("db");
    const deps = c.get("deps") ?? {};
    const now = new Date().toISOString();

    const [{ data: prevRow }, { data: latestHistRow }] = await Promise.all([
      db
        .from("board_instances")
        .select(
          "id,name,status,mqtt_connected,board_role,firmware_version,config_revision,last_synced_config_revision,pending_config_sync"
        )
        .eq("id", dev.boardInstanceId)
        .eq("account_id", dev.accountId)
        .maybeSingle(),
      db
        .from("firmware_update_history")
        .select("id,release_id,update_type,target_version,status,started_at,completed_at")
        .eq("board_instance_id", dev.boardInstanceId)
        .eq("account_id", dev.accountId)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const prev = prevRow as {
      id: string;
      name: string;
      status: string;
      mqtt_connected: boolean;
      board_role?: string | null;
      firmware_version?: string | null;
      config_revision?: number;
      last_synced_config_revision?: number;
      pending_config_sync?: boolean;
    } | null;

    // A Node is never described as a Controller in a notification.
    const prevRoleLabel = prev?.board_role === "node" ? "Node" : "Controller";

    const latestHist = latestHistRow as {
      id: string;
      release_id: string | null;
      update_type: string;
      target_version: string;
      status: string;
      started_at: string;
      completed_at: string | null;
    } | null;

    const updates: Record<string, unknown> = {
      status: "online",
      pairing_status: "paired",
      wifi_connected: parsed.data.wifiConnected ?? true,
      wifi_last_connected_at:
        parsed.data.wifiConnected === false ? undefined : now,
      last_heartbeat_at: now,
      last_communication_at: now,
    };
    if (updates.wifi_last_connected_at === undefined) {
      delete updates.wifi_last_connected_at;
    }
    if (parsed.data.wifiRssi !== undefined) updates.wifi_rssi = parsed.data.wifiRssi;
    if (parsed.data.wifiSsid !== undefined) updates.wifi_ssid = parsed.data.wifiSsid;
    if (parsed.data.localIp !== undefined) updates.local_ip = parsed.data.localIp;
    if (parsed.data.firmwareVersion !== undefined && !parsed.data.otaPendingVerify) {
      updates.firmware_version = parsed.data.firmwareVersion;
      const { data: ctrlBoardRef } = await db
        .from("board_instances")
        .select("board_profile_id,custom_board_profile_id")
        .eq("id", dev.boardInstanceId)
        .maybeSingle();
      if (ctrlBoardRef) {
        const boardSpec = await resolveControllerBoardSpec(
          db,
          ctrlBoardRef as { board_profile_id: string | null; custom_board_profile_id: string | null }
        );
        const matchedRelId = await findMatchingFirmwareReleaseIdForDevice(
          db,
          boardSpec,
          parsed.data.firmwareVersion
        );
        updates.installed_firmware_release_id = matchedRelId;
      }
    }
    if (parsed.data.driverManifestHash !== undefined) {
      updates.reported_driver_manifest_hash = parsed.data.driverManifestHash || null;
    }
    if (parsed.data.mqttConnected !== undefined) {
      updates.mqtt_connected = parsed.data.mqttConnected;
      if (parsed.data.mqttConnected) {
        updates.mqtt_last_connected_at = now;
      }
    }
    if (parsed.data.lastError !== undefined) {
      const cleanedErr = parsed.data.lastError?.trim() || null;
      updates.last_error = cleanedErr;
      updates.last_error_at = cleanedErr ? now : null;
    }
    if (parsed.data.macAddress !== undefined) {
      updates.hardware_uid = parsed.data.macAddress;
    }
    if (parsed.data.boardSlug !== undefined) {
      updates.reported_board_slug = parsed.data.boardSlug;
    }
    if (parsed.data.flashSizeMb !== undefined) {
      updates.detected_flash_size_mb = parsed.data.flashSizeMb;
    }
    if (parsed.data.detectedChipName !== undefined) {
      updates.detected_chip_name = parsed.data.detectedChipName;
    }

    // Unified role reporting. The role itself stays user-owned: a device may only
    // confirm what the console told it to run, never promote (or demote) itself.
    // The persisted role is the single source of truth; a mismatching report is
    // ignored and corrected on the next config snapshot.
    const storedRole = normalizeBoardRole(prev?.board_role);
    if (
      parsed.data.boardRole !== undefined &&
      parsed.data.boardRole !== storedRole
    ) {
      // Deliberately ignored: the device keeps running the role this account
      // assigned. The next config snapshot re-delivers the correct role.
      console.warn(
        `[device-api] ignoring self-reported role "${parsed.data.boardRole}" from device ${dev.boardInstanceId} (stored role: ${storedRole})`
      );
    }
    // `comm_mode` / `node_link_state` describe a Node's uplink only; a Controller
    // reporting them must not make its row look like a Node.
    if (storedRole === "node") {
      if (parsed.data.commMode !== undefined) {
        updates.comm_mode = parsed.data.commMode;
      }
      if (parsed.data.linkState !== undefined) {
        updates.node_link_state = parsed.data.linkState;
        if (parsed.data.linkState === "linked") {
          updates.node_last_linked_at = now;
        }
      }
    }

    await db
      .from("board_instances")
      .update(updates)
      .eq("id", dev.boardInstanceId)
      .eq("account_id", dev.accountId);

    // A Controller reports which Nodes it currently hosts over ESP-NOW. Those
    // Nodes have no cloud session of their own, so this roster is what keeps
    // their status, communication mode and last-activity honest. An empty array
    // is meaningful too: it is how a Controller says "I host nobody right now",
    // which is what marks its assigned Nodes as controller_lost.
    if (parsed.data.nodes) {
      const roster = parsed.data.nodes;
      const linkedIds = roster.filter((n) => (n.link ?? "linked") === "linked").map((n) => n.id);
      if (linkedIds.length > 0) {
        await db
          .from("board_instances")
          .update({
            status: "online",
            comm_mode: "espnow",
            node_link_state: "linked",
            node_last_linked_at: now,
            last_heartbeat_at: now,
            last_communication_at: now,
          })
          .eq("account_id", dev.accountId)
          .eq("assigned_controller_id", dev.boardInstanceId)
          .eq("board_role", "node")
          .in("id", linkedIds);
      }

      const reportedIds = new Set(roster.map((n) => n.id));
      const { data: assignedNodes } = await db
        .from("board_instances")
        .select("id,node_link_state,node_last_linked_at")
        .eq("account_id", dev.accountId)
        .eq("assigned_controller_id", dev.boardInstanceId)
        .eq("board_role", "node")
        .is("deleted_at", null);

      const staleCutoff = Date.now() - ESPNOW_NODE_STALE_MS;
      const missing = ((assignedNodes ?? []) as Array<{
        id: string;
        node_link_state: string | null;
        node_last_linked_at: string | null;
      }>).filter((n) => {
        if (reportedIds.has(n.id)) return false;
        const lastLinked = n.node_last_linked_at ? Date.parse(n.node_last_linked_at) : NaN;
        // Never override a Node that is reporting its own Wi-Fi/MQTT fallback.
        if (n.node_link_state === "standalone" || n.node_link_state === "unassigned") return false;
        return !Number.isFinite(lastLinked) || lastLinked < staleCutoff;
      });

      if (missing.length > 0) {
        await db
          .from("board_instances")
          .update({ node_link_state: "controller_lost" })
          .eq("account_id", dev.accountId)
          .in(
            "id",
            missing.map((n) => n.id)
          );
      }
    }

    // Reconcile ONLY non-terminal OTA history against the true firmware version reported in heartbeat.
    // Never rewrite an already-terminal OTA history row (single terminal result per historyId).
    const reportedFw = parsed.data.firmwareVersion?.trim();
    if (
      reportedFw &&
      latestHist &&
      latestHist.update_type === "ota" &&
      !TERMINAL_OTA_STATUSES.has(latestHist.status)
    ) {
      const ctrlName = prev?.name ?? "Controller";
      const isActiveOta = (ACTIVE_OTA_STATUSES as readonly string[]).includes(
        latestHist.status
      );
      const startedAgeMs = Date.now() - Date.parse(latestHist.started_at);

      if (isActiveOta) {
        if (versionsExactMatch(reportedFw, latestHist.target_version)) {
          // Never mark OTA succeeded while bootloader verification or MQTT health check is still pending!
          if (parsed.data.otaPendingVerify || parsed.data.mqttConnected === false) {
            await db
              .from("firmware_update_history")
              .update({
                status: "verifying",
                progress_percent: 96,
              })
              .eq("id", latestHist.id)
              .eq("board_instance_id", dev.boardInstanceId)
              .in("status", [...ACTIVE_OTA_STATUSES]);
          } else {
            const { data: transitioned } = await db
              .from("firmware_update_history")
              .update({
                status: "succeeded",
                progress_percent: 100,
                error_message: null,
                completed_at: now,
              })
              .eq("id", latestHist.id)
              .eq("board_instance_id", dev.boardInstanceId)
              .in("status", [...ACTIVE_OTA_STATUSES])
              .select("id")
              .maybeSingle();
            if (transitioned) {
              await recordActivity(db, {
                accountId: dev.accountId,
                boardInstanceId: dev.boardInstanceId,
                category: "firmware",
                action: "firmware.ota_succeeded",
                summary: `Firmware update succeeded: ${ctrlName} is running v${reportedFw}`,
              });
              await emitNotification(db, {
                scope: "user",
                accountId: dev.accountId,
                category: "firmware",
                eventKey: "firmware.install_result",
                preferenceKey: "firmware_install_results",
                severity: "success",
                title: `Firmware Updated: ${ctrlName}`,
                message: `${ctrlName} is now up to date on firmware v${reportedFw}.`,
                dedupKey: `ota:${latestHist.id}:terminal`,
                dedupWindowSeconds: 86400,
                metadata: {
                  historyId: latestHist.id,
                  boardInstanceId: dev.boardInstanceId,
                  status: "succeeded",
                  firmwareVersion: reportedFw,
                },
              });
            }
          }
        } else if (
          (latestHist.status === "rebooting" || latestHist.status === "verifying") &&
          isNewerFirmwareVersion(latestHist.target_version, reportedFw)
        ) {
          const rollbackMsg = `Controller rebooted reporting v${reportedFw} instead of target v${latestHist.target_version}.`;
          const { data: transitioned } = await db
            .from("firmware_update_history")
            .update({
              status: "rolled_back",
              progress_percent: 0,
              error_message: rollbackMsg,
              completed_at: now,
            })
            .eq("id", latestHist.id)
            .eq("board_instance_id", dev.boardInstanceId)
            .in("status", [...ACTIVE_OTA_STATUSES])
            .select("id")
            .maybeSingle();
          if (transitioned) {
            await recordActivity(db, {
              accountId: dev.accountId,
              boardInstanceId: dev.boardInstanceId,
              category: "firmware",
              action: "firmware.ota_rolled_back",
              summary: `Firmware update rolled back: ${rollbackMsg}`,
            });
            await emitNotification(db, {
              scope: "user",
              accountId: dev.accountId,
              category: "firmware",
              eventKey: "firmware.install_result",
              preferenceKey: "firmware_install_results",
              severity: "danger",
              title: `Firmware Update Could Not Be Completed: ${ctrlName}`,
              message: `The v${latestHist.target_version} update could not be verified. ${ctrlName} safely restored firmware v${reportedFw}, and your settings remain intact.`,
              dedupKey: `ota:${latestHist.id}:terminal`,
              dedupWindowSeconds: 86400,
              metadata: {
                historyId: latestHist.id,
                boardInstanceId: dev.boardInstanceId,
                status: "rolled_back",
                firmwareVersion: reportedFw,
              },
            });
          }
        } else if (
          ["downloading", "flashing", "verifying"].includes(latestHist.status) &&
          Number.isFinite(startedAgeMs) &&
          startedAgeMs > 90_000
        ) {
          const timeoutMsg = `Controller reconnected on v${reportedFw} before OTA v${latestHist.target_version} finished.`;
          await db
            .from("firmware_update_history")
            .update({
              status: "failed",
              error_message: timeoutMsg,
              completed_at: now,
            })
            .eq("id", latestHist.id)
            .eq("board_instance_id", dev.boardInstanceId)
            .in("status", [...ACTIVE_OTA_STATUSES]);
        }
      }
    }

    if (prev && prev.status !== "online" && prev.status !== "pending") {
      await emitNotification(db, {
        scope: "user",
        accountId: dev.accountId,
        category: "controller",
        eventKey: "controller.online",
        preferenceKey: "controller_offline_online",
        severity: "success",
        title: `${prevRoleLabel} Online: ${prev.name}`,
        message: `${prev.name} reconnected and is online.`,
        dedupKey: `ctrl:${dev.boardInstanceId}:online`,
        dedupWindowSeconds: 120,
        metadata: { boardInstanceId: dev.boardInstanceId, previousStatus: prev.status },
      });
    }

    if (prev && prev.mqtt_connected && parsed.data.mqttConnected === false) {
      await emitNotification(db, {
        scope: "user",
        accountId: dev.accountId,
        category: "controller",
        eventKey: "controller.mqtt_disconnected",
        preferenceKey: "controller_offline_online",
        severity: "warning",
        title: `${prevRoleLabel} MQTT Disconnected: ${prev.name}`,
        message: `${prev.name} is reachable on Wi-Fi but its MQTT session is disconnected.`,
        dedupKey: `ctrl:${dev.boardInstanceId}:mqtt_off`,
        dedupWhileUnread: true,
        metadata: { boardInstanceId: dev.boardInstanceId },
      });
    }

    const currentRev = prev?.config_revision ?? 1;
    const lastSyncedRev = prev?.last_synced_config_revision ?? 0;
    const reportedRev = parsed.data.configRevision;
    let syncPublished = false;

    if (reportedRev !== undefined && reportedRev >= currentRev) {
      await acknowledgeControllerConfigRevision(
        db,
        dev.accountId,
        dev.boardInstanceId,
        reportedRev
      );
    } else if (
      prev &&
      (prev.pending_config_sync ||
        lastSyncedRev < currentRev ||
        (reportedRev !== undefined && reportedRev < currentRev))
    ) {
      const syncRes = await syncControllerConfigSnapshot(db, c.env ?? {}, deps, {
        accountId: dev.accountId,
        boardInstanceId: dev.boardInstanceId,
        reason: "reconnect",
        forcePublish: true,
      }).catch(() => null);
      // A Node normally has no EMQX session of its own while it is linked over
      // ESP-NOW, and an MQTT publish to an unsubscribed topic is accepted by the
      // broker even though nobody received it. Never claim "published" for a
      // device that reports no MQTT session: the heartbeat response then makes
      // the device pull the snapshot over HTTPS instead.
      syncPublished =
        Boolean(syncRes?.published) && parsed.data.mqttConnected !== false;
    }

    return c.json({
      ok: true,
      server_time: now,
      config_revision: currentRev,
      sync_published: syncPublished,
    });
  });

  app.post("/telemetry", requireDeviceBearerAuth(), async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = telemetrySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid telemetry payload." }, 400);

    const dev = c.get("deviceAuth")!;
    const db = c.get("db");
    const deps = c.get("deps") ?? {};
    const now = new Date().toISOString();

    await db
      .from("board_instances")
      .update({
        status: "online",
        wifi_connected: true,
        last_communication_at: now,
      })
      .eq("id", dev.boardInstanceId)
      .eq("account_id", dev.accountId);

    for (const s of parsed.data.sensors ?? []) {
      const isErrorReading =
        s.status === "error" || s.value === null || s.value === undefined;
      const numericValue = isErrorReading
        ? null
        : typeof s.value === "number"
          ? s.value
          : typeof s.value === "boolean"
            ? s.value
              ? 1
              : 0
            : Number.isFinite(Number(s.value))
              ? Number(s.value)
              : null;

      const { data: sensorMeta } = await db
        .from("sensors")
        .select("id,name,sensor_type,unit,last_raw_payload")
        .eq("id", s.sensorId)
        .eq("board_instance_id", dev.boardInstanceId)
        .eq("account_id", dev.accountId)
        .is("deleted_at", null)
        .maybeSingle();

      const existingRaw = ((sensorMeta as { last_raw_payload?: Record<string, unknown> } | null)
        ?.last_raw_payload ?? {}) as Record<string, unknown>;

      const sensorUpdate: Record<string, unknown> = {
        last_raw_payload: {
          ...existingRaw,
          ...(isErrorReading
            ? {
                status: "error",
                last_error: s.error ?? "Sensor read failed",
                last_error_at: now,
              }
            : {
                status: "ok",
                value: s.value,
                last_error: null,
              }),
          ...(s.secondaryValue !== undefined
            ? { secondary_value: s.secondaryValue }
            : {}),
          ...(s.unit ? { reported_unit: s.unit } : {}),
          ...(s.timestamp !== undefined ? { device_timestamp: s.timestamp } : {}),
          ...(s.driverId ? { reported_driver_id: s.driverId } : {}),
        },
        last_reading_at: now,
        is_online: !isErrorReading,
      };
      if (!isErrorReading) {
        sensorUpdate.last_value = numericValue;
      }

      await db
        .from("sensors")
        .update(sensorUpdate)
        .eq("id", s.sensorId)
        .eq("board_instance_id", dev.boardInstanceId)
        .eq("account_id", dev.accountId)
        .is("deleted_at", null);

      // Rolling per-sensor reading history (bounded) for card sparklines.
      // Best-effort only — history bookkeeping must never break telemetry ingest.
      if (numericValue !== null && sensorMeta) {
        const historyUnit =
          typeof (sensorMeta as { unit?: unknown }).unit === "string"
            ? ((sensorMeta as { unit?: unknown }).unit as string)
            : "";
        const retentionCutoff = new Date(
          Date.now() - 30 * 24 * 60 * 60 * 1000
        ).toISOString();
        try {
          await db.from("sensor_readings").insert({
            sensor_id: s.sensorId,
            account_id: dev.accountId,
            value: numericValue,
            unit: historyUnit,
          });
          // Retention pruning used to run on every telemetry message, which turned
          // each reading into an extra DELETE. It now runs on roughly 1 in 64
          // writes per sensor: still bounded (each message can add at most one old
          // row) without deleting on the hot path.
          if (Math.random() < 1 / 64) {
            await db
              .from("sensor_readings")
              .delete()
              .eq("sensor_id", s.sensorId)
              .lt("recorded_at", retentionCutoff);
          }
        } catch {
          // ignore history write failures
        }
      }

      if (sensorMeta && numericValue !== null) {
        const meta = sensorMeta as {
          id: string;
          name: string;
          sensor_type: string;
          unit: string;
        };
        const alertMax =
          typeof existingRaw.alertMax === "number" ? existingRaw.alertMax : null;
        const alertMin =
          typeof existingRaw.alertMin === "number" ? existingRaw.alertMin : null;
        const breachedHigh = alertMax !== null && numericValue > alertMax;
        const breachedLow = alertMin !== null && numericValue < alertMin;
        const motionAlert =
          Boolean(existingRaw.notifyOnTrigger) &&
          (meta.sensor_type === "motion_pir" || meta.sensor_type === "contact_reed") &&
          numericValue >= 1;

        if (breachedHigh || breachedLow || motionAlert) {
          await emitNotification(db, {
            scope: "user",
            accountId: dev.accountId,
            category: "sensor",
            eventKey: "sensor.alert",
            preferenceKey: "sensor_alerts",
            severity: "warning",
            title: `Sensor Alert: ${meta.name}`,
            message: breachedHigh
              ? `${meta.name} reported ${numericValue} ${meta.unit} (above threshold ${alertMax} ${meta.unit}).`
              : breachedLow
                ? `${meta.name} reported ${numericValue} ${meta.unit} (below threshold ${alertMin} ${meta.unit}).`
                : `${meta.name} detected activity (${meta.sensor_type}).`,
            dedupKey: `sensor:${s.sensorId}:alert`,
            dedupWindowSeconds: 300,
            metadata: { boardInstanceId: dev.boardInstanceId, sensorId: s.sensorId, value: numericValue, unit: meta.unit },
          });
        }
      }

      if (numericValue !== null) {
        await evaluateAutomationsForEvent({
          db,
          env: c.env ?? {},
          emqxFetch: deps.emqxFetch,
          accountId: dev.accountId,
          event: { kind: "sensor", sensorId: s.sensorId, numericValue },
        });
      }
    }

    for (const sw of parsed.data.switches ?? []) {
      const { data: existingSw } = await db
        .from("switches")
        .select("id,is_on")
        .eq("id", sw.switchId)
        .eq("board_instance_id", dev.boardInstanceId)
        .eq("account_id", dev.accountId)
        .is("deleted_at", null)
        .maybeSingle();

      const stateChanged =
        !existingSw ||
        Boolean((existingSw as { is_on: boolean }).is_on) !== sw.isOn;

      await db
        .from("switches")
        .update({
          is_on: sw.isOn,
          is_online: true,
          ...(stateChanged ? { last_changed_at: now } : {}),
        })
        .eq("id", sw.switchId)
        .eq("board_instance_id", dev.boardInstanceId)
        .eq("account_id", dev.accountId)
        .is("deleted_at", null);

      await evaluateAutomationsForEvent({
        db,
        env: c.env ?? {},
        emqxFetch: deps.emqxFetch,
        accountId: dev.accountId,
        event: { kind: "switch", switchId: sw.switchId, isOn: sw.isOn },
      });
    }

    for (const d of parsed.data.devices ?? []) {
      const lowered = d.state.trim().toLowerCase();
      const isDisconnected =
        lowered === "disconnected" || lowered === "offline" || lowered === "fault";

      const { data: existingDev } = await db
        .from("devices")
        .select("id,name,state")
        .eq("id", d.deviceId)
        .eq("board_instance_id", dev.boardInstanceId)
        .eq("account_id", dev.accountId)
        .is("deleted_at", null)
        .maybeSingle();

      const prevState =
        (existingDev as { state?: string | null } | null)?.state ?? null;
      const prevNorm = prevState?.trim().toLowerCase() ?? "";
      const isGenericBinaryReport = lowered === "on" || lowered === "off";
      const prevIsIdle = prevNorm === "idle" || prevNorm === "";
      const preserveSemanticState =
        !isDisconnected &&
        isGenericBinaryReport &&
        prevState !== null &&
        !prevIsIdle &&
        isDeviceStateActive(prevState) === isDeviceStateActive(d.state);
      const effectiveState = preserveSemanticState ? prevState : d.state;

      const { data: updatedDev } = await db
        .from("devices")
        .update({
          state: effectiveState,
          is_online: !isDisconnected,
          last_state_at: now,
        })
        .eq("id", d.deviceId)
        .eq("board_instance_id", dev.boardInstanceId)
        .eq("account_id", dev.accountId)
        .is("deleted_at", null)
        .select("id,name")
        .maybeSingle();

      if (isDisconnected && updatedDev) {
        await emitNotification(db, {
          scope: "user",
          accountId: dev.accountId,
          category: "device",
          eventKey: "device.disconnected",
          preferenceKey: "device_disconnected",
          severity: "warning",
          title: `Device ${lowered}: ${(updatedDev as { name: string }).name}`,
          message: `${(updatedDev as { name: string }).name} reported state "${d.state}".`,
          dedupKey: `dev:${d.deviceId}:disconnected`,
          dedupWhileUnread: true,
          metadata: { boardInstanceId: dev.boardInstanceId, deviceId: d.deviceId, state: d.state },
        });
      }

      await evaluateAutomationsForEvent({
        db,
        env: c.env ?? {},
        emqxFetch: deps.emqxFetch,
        accountId: dev.accountId,
        event: { kind: "device", deviceId: d.deviceId, state: effectiveState },
      });
    }

    return c.json({ ok: true });
  });

  app.post("/ota/progress", requireDeviceBearerAuth(), async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = otaProgressSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid OTA progress payload." }, 400);

    const dev = c.get("deviceAuth")!;
    const db = c.get("db");
    const now = new Date().toISOString();

    let resolvedHistoryId = parsed.data.historyId ?? null;
    let resolvedTargetVersion: string | null = null;
    let existingStatus: string | null = null;

    if (resolvedHistoryId) {
      const { data: existingHist } = await db
        .from("firmware_update_history")
        .select("id,target_version,status")
        .eq("id", resolvedHistoryId)
        .eq("board_instance_id", dev.boardInstanceId)
        .eq("account_id", dev.accountId)
        .maybeSingle();
      resolvedTargetVersion =
        (existingHist as { target_version?: string } | null)?.target_version ?? null;
      existingStatus =
        (existingHist as { status?: string } | null)?.status ?? null;
    } else if (parsed.data.releaseId) {
      const { data: activeHist } = await db
        .from("firmware_update_history")
        .select("id,target_version,status")
        .eq("board_instance_id", dev.boardInstanceId)
        .eq("account_id", dev.accountId)
        .eq("release_id", parsed.data.releaseId)
        .in("status", [...ACTIVE_OTA_STATUSES])
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (activeHist) {
        resolvedHistoryId = (activeHist as { id: string }).id;
        resolvedTargetVersion =
          (activeHist as { target_version?: string }).target_version ?? null;
        existingStatus =
          (activeHist as { status?: string }).status ?? null;
      } else {
        // Check if this release already reached a terminal result for this controller so duplicate callbacks stay idempotent
        const { data: recentTermHist } = await db
          .from("firmware_update_history")
          .select("id,target_version,status")
          .eq("board_instance_id", dev.boardInstanceId)
          .eq("account_id", dev.accountId)
          .eq("release_id", parsed.data.releaseId)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (
          recentTermHist &&
          TERMINAL_OTA_STATUSES.has((recentTermHist as { status: string }).status)
        ) {
          return c.json({
            ok: true,
            alreadyTerminal: true,
            status: (recentTermHist as { status: string }).status,
          });
        }
      }
    }

    // Guarantee only ONE terminal OTA result is ever recorded per OTA history ID
    if (existingStatus && TERMINAL_OTA_STATUSES.has(existingStatus)) {
      return c.json({
        ok: true,
        alreadyTerminal: true,
        status: existingStatus,
      });
    }

    if (!resolvedTargetVersion && parsed.data.releaseId) {
      const { data: relMeta } = await db
        .from("firmware_releases")
        .select("version")
        .eq("id", parsed.data.releaseId)
        .maybeSingle();
      resolvedTargetVersion = (relMeta as { version?: string } | null)?.version ?? null;
    }

    // Never trust or synthesize targetVersion when actual running firmwareVersion is missing or mismatched.
    const actualReportedVersion = parsed.data.firmwareVersion?.trim() || null;
    let effectiveStatus = parsed.data.status;
    let effectiveProgress = parsed.data.progressPercent;
    let effectiveError = parsed.data.errorMessage ?? null;

    if (parsed.data.status === "succeeded") {
      if (!actualReportedVersion) {
        // Do not mark succeeded without verified runtime version; hold in verifying until heartbeat/device reports real version
        effectiveStatus = "verifying";
        effectiveProgress = 95;
        effectiveError =
          effectiveError ??
          "Awaiting verified running firmware version before confirming OTA success";
      } else if (
        resolvedTargetVersion &&
        !versionsExactMatch(actualReportedVersion, resolvedTargetVersion)
      ) {
        effectiveStatus = "rolled_back";
        effectiveProgress = 0;
        effectiveError = `Controller reported running firmware v${actualReportedVersion} instead of target v${resolvedTargetVersion}`;
      } else {
        effectiveProgress = 100;
        effectiveError = null;
      }
    }

    const terminal = TERMINAL_OTA_STATUSES.has(effectiveStatus);

    let recordedTerminalTransition = false;
    if (resolvedHistoryId) {
      if (terminal) {
        const { data: transitioned } = await db
          .from("firmware_update_history")
          .update({
            status: effectiveStatus,
            progress_percent: effectiveProgress,
            error_message: effectiveError,
            completed_at: now,
          })
          .eq("id", resolvedHistoryId)
          .eq("board_instance_id", dev.boardInstanceId)
          .eq("account_id", dev.accountId)
          .in("status", [...ACTIVE_OTA_STATUSES])
          .select("id")
          .maybeSingle();
        recordedTerminalTransition = Boolean(transitioned);
      } else {
        await db
          .from("firmware_update_history")
          .update({
            status: effectiveStatus,
            progress_percent: effectiveProgress,
            error_message: effectiveError,
            completed_at: null,
          })
          .eq("id", resolvedHistoryId)
          .eq("board_instance_id", dev.boardInstanceId)
          .eq("account_id", dev.accountId)
          .in("status", [...ACTIVE_OTA_STATUSES]);
      }
    }

    // Only update controller's recorded firmware_version from actual device-reported metadata (never target fallback)
    if (
      (effectiveStatus === "succeeded" ||
        effectiveStatus === "rolled_back" ||
        effectiveStatus === "failed") &&
      actualReportedVersion
    ) {
      const { data: ctrlBoardRef } = await db
        .from("board_instances")
        .select("board_profile_id,custom_board_profile_id")
        .eq("id", dev.boardInstanceId)
        .maybeSingle();
      const boardSpec = ctrlBoardRef
        ? await resolveControllerBoardSpec(
            db,
            ctrlBoardRef as { board_profile_id: string | null; custom_board_profile_id: string | null }
          )
        : null;
      const matchedRelId = await findMatchingFirmwareReleaseIdForDevice(
        db,
        boardSpec,
        actualReportedVersion
      );
      await db
        .from("board_instances")
        .update({
          firmware_version: actualReportedVersion,
          installed_firmware_release_id: matchedRelId,
        })
        .eq("id", dev.boardInstanceId)
        .eq("account_id", dev.accountId);
    }

    if (terminal && (!resolvedHistoryId || recordedTerminalTransition)) {
      await recordActivity(db, {
        accountId: dev.accountId,
        boardInstanceId: dev.boardInstanceId,
        category: "firmware",
        action: `firmware.ota_${effectiveStatus}`,
        summary: `OTA firmware update ${effectiveStatus}${
          effectiveError ? `: ${effectiveError}` : ""
        }`,
      });

      const { data: ctrl } = await db
        .from("board_instances")
        .select("name")
        .eq("id", dev.boardInstanceId)
        .maybeSingle();
      const ctrlName = (ctrl as { name?: string } | null)?.name ?? "Controller";
      const ok = effectiveStatus === "succeeded";

      await emitNotification(db, {
        scope: "user",
        accountId: dev.accountId,
        category: "firmware",
        eventKey: "firmware.install_result",
        preferenceKey: "firmware_install_results",
        severity: ok ? "success" : "danger",
        title: ok
          ? `Firmware Updated: ${ctrlName}`
          : effectiveStatus === "rolled_back"
            ? `Firmware Update Restored Previous Version: ${ctrlName}`
            : `Firmware Update Could Not Be Completed: ${ctrlName}`,
        message: ok
          ? `${ctrlName} is now up to date on firmware${
              actualReportedVersion ? ` v${actualReportedVersion}` : ""
            }.`
          : effectiveStatus === "rolled_back"
            ? `The update could not be completed. ${ctrlName} safely kept firmware${
                actualReportedVersion ? ` v${actualReportedVersion}` : ""
              }, and your settings remain intact.`
            : `${ctrlName} update did not complete. Your previous firmware and settings remain available.`,
        dedupKey: resolvedHistoryId ? `ota:${resolvedHistoryId}:terminal` : null,
        dedupWindowSeconds: 86400,
        metadata: {
          historyId: resolvedHistoryId,
          boardInstanceId: dev.boardInstanceId,
          status: effectiveStatus,
          firmwareVersion: actualReportedVersion,
        },
      });
    }

    return c.json({ ok: true, status: effectiveStatus });
  });

  app.get("/firmware/ota/:releaseId", requireDeviceBearerAuth(), async (c) => {
    const dev = c.get("deviceAuth")!;
    const db = c.get("db");
    const releaseId = c.req.param("releaseId");

    const [{ data: ctrl }, { data: rel }] = await Promise.all([
      db
        .from("board_instances")
        .select("board_profile_id,custom_board_profile_id,reported_board_slug")
        .eq("id", dev.boardInstanceId)
        .eq("account_id", dev.accountId)
        .is("deleted_at", null)
        .maybeSingle(),
      db
        .from("firmware_releases")
        .select(
          "id,status,chip_family,target_board_slug,compatible_board_ids,compatible_board_slugs,partition_scheme,psram_mode,flash_size_mb"
        )
        .eq("id", releaseId)
        .eq("status", "published")
        .is("deleted_at", null)
        .maybeSingle(),
    ]);

    if (!ctrl || !rel) {
      return c.json({ error: "Published firmware release not available." }, 404);
    }

    const cRow = ctrl as {
      board_profile_id: string | null;
      custom_board_profile_id: string | null;
      reported_board_slug?: string | null;
    };
    const rRow = rel as {
      chip_family: string;
      target_board_slug?: string | null;
      compatible_board_ids: string[];
      compatible_board_slugs?: string[];
      partition_scheme?: string | null;
      psram_mode?: string | null;
      flash_size_mb?: number | null;
    };

    const reqChipFamily = (
      c.req.header("x-homecore-chip-family") ??
      c.req.header("x-homecore-chip") ??
      ""
    )
      .trim()
      .toLowerCase() || null;
    const reqBoardSlug = (
      c.req.header("x-homecore-board-slug") ??
      c.req.header("x-homecore-board") ??
      ""
    ).trim() || null;
    const reqPartScheme = (
      c.req.header("x-homecore-partition-scheme") ??
      c.req.header("x-homecore-partition") ??
      ""
    ).trim() || null;
    const reqFlashMbRaw = c.req.header("x-homecore-flash-mb")?.trim() || null;
    const reqFlashMb = reqFlashMbRaw ? Number.parseInt(reqFlashMbRaw, 10) : null;

    if (
      reqChipFamily &&
      rRow.chip_family.trim().toLowerCase() !== reqChipFamily
    ) {
      return c.json(
        {
          error: `Chip family mismatch: release targets "${rRow.chip_family}", device reported "${reqChipFamily}".`,
        },
        403
      );
    }
    if (
      reqBoardSlug &&
      rRow.target_board_slug &&
      rRow.target_board_slug !== reqBoardSlug
    ) {
      return c.json(
        {
          error: `Release targets board "${rRow.target_board_slug}" and cannot run on "${reqBoardSlug}".`,
        },
        403
      );
    }
    if (
      reqPartScheme &&
      rRow.partition_scheme &&
      rRow.partition_scheme !== reqPartScheme
    ) {
      return c.json(
        {
          error: `Partition scheme mismatch: release expects "${rRow.partition_scheme}", device runs "${reqPartScheme}".`,
        },
        403
      );
    }
    if (
      reqFlashMb !== null &&
      Number.isFinite(reqFlashMb) &&
      rRow.flash_size_mb &&
      reqFlashMb < rRow.flash_size_mb
    ) {
      return c.json(
        {
          error: `Flash capacity mismatch: release requires ${rRow.flash_size_mb}MB, device reported ${reqFlashMb}MB.`,
        },
        403
      );
    }

    const board = await resolveControllerCompatBoard(db, cRow);
    const compat = checkControllerReleaseCompatibility({
      board,
      release: rRow,
      requirePublished: true,
    });
    if (!compat.compatible) {
      return c.json(
        { error: compat.reasons[0] ?? "Release incompatible with controller board." },
        403
      );
    }

    const { data: otaFile } = await db
      .from("firmware_files")
      .select("r2_key,file_name,sha256,size_bytes")
      .eq("release_id", releaseId)
      .eq("file_type", "ota_app")
      .maybeSingle();

    if (!otaFile) return c.json({ error: "OTA image not found." }, 404);
    const f = otaFile as {
      r2_key: string;
      file_name: string;
      sha256: string;
      size_bytes: number;
    };

    const rangeHeader = c.req.header("range")?.trim();
    if (rangeHeader && f.size_bytes > 0) {
      const m = rangeHeader.match(/^bytes=(\d+)-(\d*)$/i);
      if (m) {
        const start = Number.parseInt(m[1]!, 10);
        const rawEnd = m[2] ? Number.parseInt(m[2], 10) : f.size_bytes - 1;
        const end = Math.min(rawEnd, f.size_bytes - 1);
        if (start >= 0 && start <= end && start < f.size_bytes) {
          const length = end - start + 1;
          const obj = await getFirmwareObject(c.env ?? {}, f.r2_key, {
            range: { offset: start, length },
          });
          if (!obj) return c.json({ error: "OTA binary missing from R2." }, 404);
          const buf = new Uint8Array(await obj.arrayBuffer());
          const chunk =
            buf.byteLength === length
              ? buf
              : buf.subarray(start, Math.min(buf.byteLength, start + length));
          return new Response(chunk, {
            status: 206,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(chunk.byteLength),
              "Content-Range": `bytes ${start}-${start + chunk.byteLength - 1}/${f.size_bytes}`,
              "Accept-Ranges": "bytes",
              "X-Firmware-Sha256": f.sha256,
            },
          });
        }
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${f.size_bytes}` },
        });
      }
    }

    const obj = await getFirmwareObject(c.env ?? {}, f.r2_key);
    if (!obj) return c.json({ error: "OTA binary missing from R2." }, 404);

    return new Response(obj.body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(f.size_bytes),
        "Accept-Ranges": "bytes",
        "X-Firmware-Sha256": f.sha256,
      },
    });
  });

  return app;
}

async function handlePairOrRecover(
  c: Context<AppEnv>,
  input: z.infer<typeof pairSchema>,
  forceRecoveryEndpoint: boolean
) {
  const db = c.get("db");
  const deps = c.get("deps") ?? {};
  const ip = extractClientIp(c.req.raw);
  const rateKey = `pair:${ip}`;

  const attemptCheck = await checkAttemptAllowed(db, rateKey, ip);
  if (!attemptCheck.allowed) {
    return c.json(
      {
        error: `Too many invalid pairing attempts. Retry in ${attemptCheck.retryAfterSeconds}s.`,
      },
      429
    );
  }

  const codeHash = await sha256Hex(input.pairingCode);
  const { data: claimRows, error: claimErr } = await db.rpc("claim_pairing_code", {
    p_code_hash: codeHash,
  });

  if (claimErr) {
    return c.json({ error: claimErr.message }, 500);
  }

  const claimed = Array.isArray(claimRows)
    ? (claimRows[0] as ClaimedPairingRow | undefined)
    : (claimRows as ClaimedPairingRow | null | undefined);

  if (!claimed) {
    const attempt = await recordFailedAttempt(db, rateKey, ip, 10);
    return c.json(
      {
        error: attempt.locked
          ? "Too many invalid pairing attempts. Temporarily locked."
          : "Pairing code is invalid, expired, or already used.",
      },
      attempt.locked ? 429 : 400
    );
  }

  await resetAttempts(db, rateKey, ip);

  const {
    account_id: accountId,
    board_instance_id: boardInstanceId,
    purpose = "initial_pair",
    requires_physical_confirmation: requiresPhysical = false,
  } = claimed;

  const isRecovery = forceRecoveryEndpoint || purpose === "recovery" || requiresPhysical;

  // Enforce physical confirmation & hardware identity proof on recovery re-pairing
  if (isRecovery) {
    if (!input.physicalConfirmed || !input.physicalConfirmationMethod) {
      return c.json(
        {
          error:
            "Physical confirmation on the controller (recovery button press or local setup webpage) is required before re-pairing succeeds.",
        },
        403
      );
    }
    if (!input.identityKey || input.identityKey.length < 32) {
      return c.json(
        {
          error:
            "Controller hardware identity proof is required for recovery re-pairing.",
        },
        400
      );
    }
  }

  const { data: ctrlData } = await db
    .from("board_instances")
    .select(
      "id,name,connection_history,pairing_status,board_instance_identity_secret_hash,board_role"
    )
    .eq("id", boardInstanceId)
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .is("permanently_deleted_at", null)
    .maybeSingle();

  if (!ctrlData) {
    return c.json({ error: "Target controller no longer exists." }, 404);
  }

  const identityHash = input.identityKey ? await sha256Hex(input.identityKey) : null;

  // Prevent duplicate controller pairing / hijacking another active paired controller's hardware identity or MAC
  if (identityHash) {
    const { data: dupByIdentity } = await db
      .from("board_instances")
      .select("id,account_id")
      .eq("board_instance_identity_secret_hash", identityHash)
      .eq("pairing_status", "paired")
      .is("deleted_at", null)
      .is("permanently_deleted_at", null)
      .neq("id", boardInstanceId)
      .limit(1)
      .maybeSingle();

    if (dupByIdentity) {
      const dupAccountId = (dupByIdentity as { account_id: string }).account_id;
      await emitNotification(db, {
        scope: "user",
        accountId: dupAccountId,
        category: "security",
        eventKey: "security.duplicate_claim_blocked",
        preferenceKey: "security_events",
        severity: "warning",
        title: "Blocked Duplicate Controller Claim",
        message: "An attempt to pair an already-paired controller hardware identity was blocked.",
        dedupKey: `sec:dup_id:${(dupByIdentity as { id: string }).id}`,
        dedupWindowSeconds: 600,
      });
      return c.json(
        {
          error:
            "This controller hardware identity is already actively paired to another controller slot. Delete or unpair the active controller first.",
        },
        409
      );
    }
  }

  if (input.macAddress) {
    const { data: dupByMac } = await db
      .from("board_instances")
      .select("id,account_id")
      .eq("hardware_uid", input.macAddress)
      .eq("pairing_status", "paired")
      .is("deleted_at", null)
      .is("permanently_deleted_at", null)
      .neq("id", boardInstanceId)
      .limit(1)
      .maybeSingle();

    if (dupByMac) {
      const dupAccountId = (dupByMac as { account_id: string }).account_id;
      await emitNotification(db, {
        scope: "user",
        accountId: dupAccountId,
        category: "security",
        eventKey: "security.duplicate_claim_blocked",
        preferenceKey: "security_events",
        severity: "warning",
        title: "Blocked Duplicate MAC Pairing",
        message: `Pairing attempt with active controller hardware UID ${input.macAddress} was blocked.`,
        dedupKey: `sec:dup_mac:${(dupByMac as { id: string }).id}`,
        dedupWindowSeconds: 600,
      });
      return c.json(
        {
          error:
            "A controller with this hardware UID is already actively paired. Remove or move it to Trash before pairing it again.",
        },
        409
      );
    }
  }

  // Revoke any old EMQX credentials if re-pairing / rotating
  const { data: prevCred } = await db
    .from("mqtt_credentials_metadata")
    .select("mqtt_username,mqtt_client_id,status")
    .eq("board_instance_id", boardInstanceId)
    .maybeSingle();

  if (prevCred && isEmqxConfigured(c.env ?? {})) {
    const prev = prevCred as {
      mqtt_username: string;
      mqtt_client_id: string;
      status: string;
    };
    const emqx = new EmqxClient(c.env!, deps.emqxFetch);
    try {
      await emqx.revokeControllerCredentials(prev.mqtt_username, prev.mqtt_client_id);
    } catch {
      // Continue rotation
    }
  }

  const credSuffix = isRecovery ? `_${generateRandomToken(2).toLowerCase().slice(0, 4)}` : "";
  const mqttUsername = `hc_${boardInstanceId.replace(/-/g, "").slice(0, 14)}${credSuffix}`;
  const mqttClientId = `hc_esp_${boardInstanceId.replace(/-/g, "").slice(0, 14)}${credSuffix}`;
  const mqttPassword = generateRandomToken(24);
  const deviceApiToken = generateRandomToken(32);
  const deviceTokenHash = await sha256Hex(deviceApiToken);
  const topicPrefix = buildControllerTopicPrefix(accountId, boardInstanceId);

  let emqxSynced = false;
  if (isEmqxConfigured(c.env ?? {})) {
    const emqx = new EmqxClient(c.env!, deps.emqxFetch);
    await emqx.provisionControllerCredentials({
      accountId,
      boardInstanceId,
      username: mqttUsername,
      password: mqttPassword,
    });
    emqxSynced = true;
  }

  const now = new Date().toISOString();

  await db.from("mqtt_credentials_metadata").upsert(
    {
      account_id: accountId,
      board_instance_id: boardInstanceId,
      mqtt_username: mqttUsername,
      mqtt_client_id: mqttClientId,
      device_token_hash: deviceTokenHash,
      topic_prefix: topicPrefix,
      emqx_synced: emqxSynced,
      status: "active",
      last_rotated_at: now,
      revoked_at: null,
    },
    { onConflict: "board_instance_id" }
  );

  const prevHistory = Array.isArray(
    (ctrlData as { connection_history?: unknown[] }).connection_history
  )
    ? (ctrlData as { connection_history: unknown[] }).connection_history.slice(-19)
    : [];

  const pairBoardSpec = await resolveControllerBoardSpec(db, {
    board_profile_id:
      (ctrlData as { board_profile_id?: string | null }).board_profile_id ?? null,
    custom_board_profile_id:
      (ctrlData as { custom_board_profile_id?: string | null }).custom_board_profile_id ?? null,
  });
  const pairMatchedReleaseId = await findMatchingFirmwareReleaseIdForDevice(
    db,
    pairBoardSpec,
    input.firmwareVersion ?? null
  );

  await db
    .from("board_instances")
    .update({
      status: "online",
      pairing_status: "paired",
      wifi_connected: true,
      mqtt_connected: emqxSynced,
      hardware_uid: input.macAddress ?? null,
      board_instance_identity_secret_hash:
        identityHash ??
        (ctrlData as { board_instance_identity_secret_hash?: string | null })
          .board_instance_identity_secret_hash ??
        null,
      firmware_version: input.firmwareVersion ?? null,
      installed_firmware_release_id: pairMatchedReleaseId,
      reported_board_slug: input.boardSlug ?? null,
      detected_flash_size_mb: input.flashSizeMb ?? null,
      detected_chip_name: input.chipVariant ?? null,
      wifi_ssid: input.wifiSsid ?? null,
      local_ip: input.localIp ?? null,
      ...(input.bleSetupPin ? { ble_setup_pin: input.bleSetupPin } : {}),
      ...(input.provisioningTransport
        ? { provisioning_transport: input.provisioningTransport }
        : {}),
      last_error: null,
      last_error_at: null,
      paired_at: now,
      wifi_last_connected_at: now,
      mqtt_last_connected_at: emqxSynced ? now : null,
      last_heartbeat_at: now,
      last_communication_at: now,
      connection_history: [
        ...prevHistory,
        {
          event: isRecovery ? "recovered_and_repaired" : "paired",
          at: now,
          ip: input.localIp ?? ip,
          confirmation: input.physicalConfirmationMethod ?? null,
        },
      ],
    })
    .eq("id", boardInstanceId)
    .eq("account_id", accountId);

  const pairedRoleLabel =
    (ctrlData as { board_role?: string | null }).board_role === "node" ? "Node" : "Controller";

  await recordActivity(db, {
    accountId,
    boardInstanceId,
    category: "pairing",
    action: isRecovery ? "controller.recovered_and_repaired" : "controller.paired",
    summary: isRecovery
      ? `${pairedRoleLabel} "${(ctrlData as { name: string }).name}" verified physical confirmation (${input.physicalConfirmationMethod}), rotated MQTT credentials, and synced configuration`
      : `${pairedRoleLabel} "${(ctrlData as { name: string }).name}" paired and provisioned on EMQX`,
  });

  const cfgStatus = inspectConfiguration(c.env ?? {});
  let brokerHost = "";
  let tlsPort = 8883;
  if (cfgStatus.emqxReady) {
    const emqxCfg = requireEmqxConfig(c.env!);
    brokerHost = emqxCfg.brokerHost;
    tlsPort = emqxCfg.tlsPort;
  }

  const builtConfig = await buildConsolidatedControllerConfig(
    db,
    accountId,
    boardInstanceId
  );
  const configSnapshot = builtConfig.snapshot;

  await db
    .from("board_instances")
    .update({
      config_revision: configSnapshot.revision,
      config_hash: configSnapshot.hash,
      last_synced_config_revision: configSnapshot.revision,
      pending_config_sync: false,
      last_config_sync_at: now,
    })
    .eq("id", boardInstanceId)
    .eq("account_id", accountId);

  const ctrlName = (ctrlData as { name: string }).name;
  const ctrlRoleLabel =
    (ctrlData as { board_role?: string | null }).board_role === "node" ? "Node" : "Controller";

  await emitNotification(db, {
    scope: "admin",
    category: "controller",
    eventKey: isRecovery ? "admin.controller_recovered" : "admin.controller_paired",
    preferenceKey: "controller_activity",
    severity: "info",
    title: isRecovery
      ? `${ctrlRoleLabel} Recovered: ${ctrlName}`
      : `${ctrlRoleLabel} Paired: ${ctrlName}`,
    message: isRecovery
      ? `${ctrlRoleLabel} "${ctrlName}" verified physical recovery and rotated MQTT credentials.`
      : `${ctrlRoleLabel} "${ctrlName}" completed initial pairing and provisioned EMQX ACLs.`,
    metadata: { accountId, boardInstanceId, isRecovery },
  });

  if (isRecovery) {
    await emitNotification(db, {
      scope: "user",
      accountId,
      category: "security",
      eventKey: "security.controller_recovered",
      preferenceKey: "security_events",
      severity: "info",
      title: `${ctrlRoleLabel} Recovered: ${ctrlName}`,
      message: `${ctrlName} confirmed physical recovery (${input.physicalConfirmationMethod}) and rotated credentials.`,
      metadata: { boardInstanceId, method: input.physicalConfirmationMethod },
    });
  }

  return c.json({
    board_instance_id: boardInstanceId,
    account_id: accountId,
    broker_host: brokerHost,
    tls_port: tlsPort,
    mqtt_username: mqttUsername,
    mqtt_password: mqttPassword,
    mqtt_client_id: mqttClientId,
    topic_prefix: topicPrefix,
    device_api_token: deviceApiToken,
    emqx_synced: emqxSynced,
    recovered: isRecovery,
    config: configSnapshot,
  });
}
