import { Hono } from "hono";
import { z } from "zod";
import {
  isNewerFirmwareVersion,
  compareFirmwareVersions,
  resolveBoardFirmwareCompatibility,
} from "@homecoreos/shared";
import { recordActivity } from "../lib/audit";
import { EmqxClient, isEmqxConfigured } from "../lib/emqx";
import {
  checkControllerReleaseCompatibility,
  resolveControllerCompatBoard,
  type CompatBoardRecord,
} from "../lib/firmware-compatibility";
import { emitNotification } from "../lib/notifications";
import { getFirmwareObject } from "../lib/r2";
import { requireStaffRole, requireUserSession } from "../middleware/auth";
import type { AppEnv } from "../types/context";

const otaStartSchema = z.object({
  controllerId: z.string().uuid(),
  releaseId: z.string().uuid(),
});

/** Outcome of the board identity check the browser flasher runs before writing. */
const usbBoardCheckSchema = z.object({
  result: z.enum(["match", "mismatch", "unverified"]),
  /** True only when the user explicitly chose "Force to Flash". */
  forced: z.boolean().default(false),
  severity: z.enum(["none", "minor", "major", "critical"]).optional(),
  detectedSummary: z.string().max(200).optional(),
  usbId: z.string().max(24).optional(),
  selectedBoardSlug: z.string().max(120).optional(),
  recommendedBoardSlugs: z.array(z.string().max(120)).max(5).optional(),
  mismatches: z.array(z.string().max(60)).max(10).optional(),
});

const usbFlashLogSchema = z.object({
  releaseId: z.string().uuid(),
  controllerId: z.string().uuid().optional(),
  status: z.enum(["succeeded", "failed"]),
  chipDetected: z.string().max(120).optional(),
  detectedFlashSizeMb: z.number().int().min(1).max(64).optional(),
  reportedBoardSlug: z.string().max(120).optional(),
  errorMessage: z.string().max(500).optional(),
  boardCheck: usbBoardCheckSchema.optional(),
});

interface ControllerCompatRow {
  id: string;
  name: string;
  status: string;
  board_catalog_id: string | null;
  custom_board_id: string | null;
  board_model: string;
  firmware_version: string | null;
  chip_variant: string;
}

interface ReleaseRow {
  id: string;
  name: string;
  version: string;
  channel: string;
  chip_family: string;
  target_board_slug?: string | null;
  partition_scheme?: string | null;
  psram_mode?: string | null;
  flash_size_mb?: number | null;
  hardware_verified?: boolean;
  compatible_board_ids: string[];
  compatible_board_slugs?: string[];
  ota_available: boolean;
  usb_available: boolean;
  status: string;
  release_notes: string;
  manifest: unknown;
  published_at: string | null;
}

export function createFirmwareRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", requireUserSession());

  app.get("/releases", async (c) => {
    const db = c.get("db");
    const chip = (c.req.query("chip") ?? "").trim().toLowerCase();
    const channel = (c.req.query("channel") ?? "").trim().toLowerCase();
    const boardId = (c.req.query("boardId") ?? "").trim();
    const boardSlug = (c.req.query("boardSlug") ?? "").trim();
    const version = (c.req.query("version") ?? "").trim().toLowerCase();
    const search = (c.req.query("search") ?? "").trim().toLowerCase();

    const { data: releases } = await db
      .from("firmware_releases")
      .select("*")
      .eq("status", "published")
      .is("deleted_at", null)
      .order("published_at", { ascending: false });

    const relList = ((releases ?? []) as ReleaseRow[]).filter((r) => {
      if (chip && r.chip_family.toLowerCase() !== chip) return false;
      if (channel && r.channel.toLowerCase() !== channel) return false;
      if (version && r.version.toLowerCase() !== version) return false;
      if (boardId) {
        const matchesId = r.compatible_board_ids.includes(boardId);
        const matchesUnpinned =
          r.compatible_board_ids.length === 0 &&
          (r.compatible_board_slugs?.length ?? 0) === 0 &&
          !r.target_board_slug;
        if (!matchesId && !matchesUnpinned) return false;
      }
      if (boardSlug) {
        const matchesSlug =
          r.target_board_slug === boardSlug ||
          Boolean(r.compatible_board_slugs?.includes(boardSlug));
        const matchesUnpinned =
          r.compatible_board_ids.length === 0 &&
          (r.compatible_board_slugs?.length ?? 0) === 0 &&
          !r.target_board_slug;
        if (!matchesSlug && !matchesUnpinned) return false;
      }
      if (search) {
        const hay = `${r.name} ${r.version} ${r.channel} ${r.chip_family} ${r.target_board_slug ?? ""} ${r.release_notes}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    const releaseIds = relList.map((r) => r.id);
    const allBoardIds = new Set<string>();
    for (const r of relList) {
      for (const bid of r.compatible_board_ids ?? []) {
        if (bid) allBoardIds.add(bid);
      }
    }

    const [filesRes, boardsRes] = await Promise.all([
      releaseIds.length > 0
        ? db
            .from("firmware_files")
            .select(
              "id,release_id,file_type,file_name,size_bytes,sha256,flash_address,flash_mode,flash_freq,flash_size,partition_scheme,psram_mode,validated,created_at"
            )
            .in("release_id", releaseIds)
        : Promise.resolve({ data: null }),
      allBoardIds.size > 0
        ? db
            .from("board_catalog")
            .select(
              "id,slug,manufacturer,model,chip_family,chip_variant,flash_size_mb,psram_size_mb,psram_mode,partition_scheme,bootloader_offset,boot_button_gpio,usb_interface,supports_wifi,supports_ble,supports_ble_wifi_provisioning"
            )
            .in("id", Array.from(allBoardIds))
            .is("deleted_at", null)
        : Promise.resolve({ data: null }),
    ]);

    const filesByRelease = new Map<string, unknown[]>();
    for (const f of (filesRes.data ?? []) as Array<{ release_id: string }>) {
      const arr = filesByRelease.get(f.release_id) ?? [];
      arr.push(f);
      filesByRelease.set(f.release_id, arr);
    }

    const boardLookup = new Map<string, Record<string, unknown>>();
    for (const b of (boardsRes.data ?? []) as Array<Record<string, unknown>>) {
      boardLookup.set(String(b.id), b);
    }

    return c.json({
      releases: relList.map((r) => ({
        ...r,
        files: filesByRelease.get(r.id) ?? [],
        compatible_boards: (r.compatible_board_ids ?? [])
          .map((bid) => boardLookup.get(bid))
          .filter(Boolean),
      })),
    });
  });

  // Tab 2: Applicable OTA updates for the signed-in user's controllers + update history
  app.get("/updates", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");

    const [ctrlRes, relRes, catRes, customRes, histRes] = await Promise.all([
      db
        .from("controllers")
        .select(
          "id,name,status,board_catalog_id,custom_board_id,board_model,firmware_version,chip_variant"
        )
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .is("permanently_deleted_at", null)
        .order("created_at", { ascending: false }),
      db
        .from("firmware_releases")
        .select("*")
        .eq("status", "published")
        .eq("ota_available", true)
        .is("deleted_at", null)
        .order("published_at", { ascending: false }),
      db
        .from("board_catalog")
        .select(
          "id,slug,manufacturer,model,revision,chip_family,chip_variant,flash_size_mb,psram_size_mb,firmware_status,partition_scheme,psram_mode,flash_mode,flash_freq,bootloader_offset,ota_app_offset,boot_button_gpio,usb_interface,supports_wifi,supports_ble,supports_ble_wifi_provisioning,supports_ota_rollback,firmware_compat_key"
        )
        .is("deleted_at", null),
      db
        .from("custom_boards")
        .select(
          "id,slug,manufacturer,model,revision,chip_family,chip_variant,flash_size_mb,psram_size_mb,partition_scheme,psram_mode,flash_mode,flash_freq,bootloader_offset,ota_app_offset,boot_button_gpio,usb_interface,supports_wifi,supports_ble,supports_ble_wifi_provisioning,supports_ota_rollback,firmware_compat_key"
        )
        .eq("account_id", auth.accountId)
        .is("deleted_at", null),
      db
        .from("firmware_update_history")
        .select("*")
        .eq("account_id", auth.accountId)
        .order("started_at", { ascending: false })
        .limit(50),
    ]);

    const controllers = (ctrlRes.data ?? []) as ControllerCompatRow[];
    const otaReleases = (relRes.data ?? []) as ReleaseRow[];
    const catalogById = new Map(
      ((catRes.data ?? []) as CompatBoardRecord[]).map((b) => [
        b.id,
        { ...b, ...resolveBoardFirmwareCompatibility(b) },
      ])
    );
    const customById = new Map(
      ((customRes.data ?? []) as CompatBoardRecord[]).map((b) => [
        b.id,
        { ...b, ...resolveBoardFirmwareCompatibility(b), firmware_status: "custom" },
      ])
    );

    const historyRows = (histRes.data ?? []) as Array<{
      id: string;
      controller_id: string;
      release_id: string;
      update_type: string;
      previous_version: string | null;
      target_version: string;
      status: string;
      progress_percent: number;
      error_message: string | null;
      started_at: string;
      completed_at: string | null;
    }>;

    const staleCutoffMs = Date.now() - 15 * 60_000;
    const staleIds: string[] = [];
    const activeHistoryByController = new Map<string, (typeof historyRows)[number]>();
    for (const h of historyRows) {
      if (
        ["pending", "downloading", "flashing", "verifying", "rebooting"].includes(
          h.status
        )
      ) {
        const startedMs = Date.parse(h.started_at);
        if (Number.isFinite(startedMs) && startedMs < staleCutoffMs) {
          staleIds.push(h.id);
          h.status = "failed";
          h.error_message = h.error_message ?? "OTA update timed out without completion.";
          h.completed_at = new Date().toISOString();
        } else if (!activeHistoryByController.has(h.controller_id)) {
          activeHistoryByController.set(h.controller_id, h);
        }
      }
    }

    if (staleIds.length > 0) {
      await db
        .from("firmware_update_history")
        .update({
          status: "failed",
          error_message: "OTA update timed out without completion.",
          completed_at: new Date().toISOString(),
        })
        .in("id", staleIds)
        .eq("account_id", auth.accountId)
        .in("status", ["pending", "downloading", "flashing", "verifying", "rebooting"]);
    }

    const releaseIds = otaReleases.map((r) => r.id);
    const otaFilesByRelease = new Map<
      string,
      Array<{ release_id: string; flash_size?: string | null }>
    >();
    if (releaseIds.length > 0) {
      const { data: otaFiles } = await db
        .from("firmware_files")
        .select("release_id,flash_size")
        .in("release_id", releaseIds)
        .eq("file_type", "ota_app");
      for (const f of (otaFiles ?? []) as Array<{
        release_id: string;
        flash_size?: string | null;
      }>) {
        const list = otaFilesByRelease.get(f.release_id) ?? [];
        list.push(f);
        otaFilesByRelease.set(f.release_id, list);
      }
    }

    const applicableUpdates: Array<{
      controllerId: string;
      controllerName: string;
      boardModel: string;
      controllerStatus: string;
      currentVersion: string | null;
      availableRelease: {
        id: string;
        name: string;
        version: string;
        channel: string;
        chip_family: string;
        target_board_slug?: string | null;
        partition_scheme?: string | null;
        psram_mode?: string | null;
        hardware_verified?: boolean;
        release_notes: string;
        published_at: string | null;
      };
      activeUpdate: (typeof historyRows)[number] | null;
    }> = [];

    for (const ctrl of controllers) {
      const compatBoard = ctrl.board_catalog_id
        ? catalogById.get(ctrl.board_catalog_id) ?? null
        : ctrl.custom_board_id
          ? customById.get(ctrl.custom_board_id) ?? null
          : null;

      const compatibleNewer = otaReleases
        .filter((rel) => {
          const relFiles = otaFilesByRelease.get(rel.id);
          if (!relFiles || relFiles.length === 0) return false;
          const compat = checkControllerReleaseCompatibility({
            board: compatBoard,
            release: { ...rel, files: relFiles },
            requirePublished: true,
          });
          if (!compat.compatible) return false;
          return isNewerFirmwareVersion(rel.version, ctrl.firmware_version);
        })
        .sort((a, b) => compareFirmwareVersions(b.version, a.version));

      const bestRelease = compatibleNewer[0];
      if (!bestRelease) continue;

      applicableUpdates.push({
        controllerId: ctrl.id,
        controllerName: ctrl.name,
        boardModel: ctrl.board_model,
        controllerStatus: ctrl.status,
        currentVersion: ctrl.firmware_version,
        availableRelease: {
          id: bestRelease.id,
          name: bestRelease.name,
          version: bestRelease.version,
          channel: bestRelease.channel,
          chip_family: bestRelease.chip_family,
          target_board_slug: bestRelease.target_board_slug ?? null,
          partition_scheme: bestRelease.partition_scheme ?? null,
          psram_mode: bestRelease.psram_mode ?? null,
          hardware_verified: bestRelease.hardware_verified ?? false,
          release_notes: bestRelease.release_notes,
          published_at: bestRelease.published_at,
        },
        activeUpdate: activeHistoryByController.get(ctrl.id) ?? null,
      });
    }

    const ctrlNameById = new Map(controllers.map((ctrl) => [ctrl.id, ctrl.name]));
    const enrichedHistory = historyRows.map((h) => ({
      ...h,
      controller_name: ctrlNameById.get(h.controller_id) ?? "Removed controller",
    }));

    return c.json({
      applicableUpdates,
      history: enrichedHistory,
    });
  });

  app.get("/files/:fileId/download", async (c) => {
    const db = c.get("db");
    const fileId = c.req.param("fileId");

    const { data: fileData } = await db
      .from("firmware_files")
      .select("*")
      .eq("id", fileId)
      .maybeSingle();

    if (!fileData) return c.json({ error: "Firmware file not found." }, 404);
    const file = fileData as {
      id: string;
      release_id: string;
      file_type: string;
      r2_key: string;
      file_name: string;
      sha256: string;
      flash_address: string | null;
      flash_mode: string | null;
      flash_freq: string | null;
      flash_size: string | null;
    };

    const { data: rel } = await db
      .from("firmware_releases")
      .select("status")
      .eq("id", file.release_id)
      .is("deleted_at", null)
      .maybeSingle();

    if (!rel || (rel as { status: string }).status !== "published") {
      return c.json({ error: "Firmware release is not published." }, 403);
    }

    const obj = await getFirmwareObject(c.env ?? {}, file.r2_key);
    if (!obj) {
      return c.json({ error: "Firmware binary missing from R2 storage." }, 404);
    }

    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Disposition", `attachment; filename="${file.file_name}"`);
    headers.set("X-Firmware-Sha256", file.sha256);
    if (file.flash_address) headers.set("X-Flash-Address", file.flash_address);
    if (file.flash_mode) headers.set("X-Flash-Mode", file.flash_mode);
    if (file.flash_freq) headers.set("X-Flash-Freq", file.flash_freq);
    if (file.flash_size) headers.set("X-Flash-Size", file.flash_size);

    return new Response(obj.body, { status: 200, headers });
  });

  app.get("/ota/history", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const { data } = await db
      .from("firmware_update_history")
      .select("*")
      .eq("account_id", auth.accountId)
      .order("started_at", { ascending: false })
      .limit(50);
    return c.json({ history: data ?? [] });
  });

  app.post(
    "/ota/start",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = otaStartSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "controllerId and releaseId are required." }, 400);
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};

      const { data: ctrl } = await db
        .from("controllers")
        .select("*")
        .eq("id", parsed.data.controllerId)
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .is("permanently_deleted_at", null)
        .maybeSingle();

      if (!ctrl) return c.json({ error: "Controller not found." }, 404);
      const ctrlRow = ctrl as ControllerCompatRow;

      if (ctrlRow.status !== "online") {
        return c.json(
          { error: "Controller must be online to receive an OTA firmware update." },
          409
        );
      }

      const { data: rel } = await db
        .from("firmware_releases")
        .select("*")
        .eq("id", parsed.data.releaseId)
        .eq("status", "published")
        .is("deleted_at", null)
        .maybeSingle();

      if (!rel) return c.json({ error: "Published firmware release not found." }, 404);
      const release = rel as ReleaseRow;

      if (!release.ota_available) {
        return c.json({ error: "Selected release does not include an OTA image." }, 400);
      }

      // Resolve full board profile & validate release compatibility strictly
      const compatBoard = await resolveControllerCompatBoard(db, ctrlRow);
      const { data: relFiles } = await db
        .from("firmware_files")
        .select("flash_size")
        .eq("release_id", release.id);
      const compat = checkControllerReleaseCompatibility({
        board: compatBoard,
        release: {
          ...release,
          files: (relFiles ?? []) as Array<{ flash_size?: string | null }>,
        },
        requirePublished: true,
      });

      if (!compat.compatible) {
        return c.json(
          {
            error:
              compat.reasons[0] ??
              "Selected firmware release is not compatible with this controller board.",
          },
          400
        );
      }

      const { data: otaFile } = await db
        .from("firmware_files")
        .select("id,sha256,size_bytes,file_name")
        .eq("release_id", release.id)
        .eq("file_type", "ota_app")
        .maybeSingle();

      if (!otaFile) {
        return c.json({ error: "OTA binary artifact missing for release." }, 400);
      }

      const { data: cred } = await db
        .from("mqtt_credentials_metadata")
        .select("topic_prefix,status")
        .eq("controller_id", ctrlRow.id)
        .eq("account_id", auth.accountId)
        .eq("status", "active")
        .maybeSingle();

      if (!cred) {
        return c.json({ error: "Controller has no active MQTT session." }, 409);
      }

      if (!isEmqxConfigured(c.env ?? {})) {
        return c.json({ error: "EMQX Serverless is not configured." }, 503);
      }

      // Clear any lingering uncompleted OTA jobs on this controller before starting a new attempt
      await db
        .from("firmware_update_history")
        .update({
          status: "failed",
          error_message: "Superseded by a new OTA update attempt.",
          completed_at: new Date().toISOString(),
        })
        .eq("account_id", auth.accountId)
        .eq("controller_id", ctrlRow.id)
        .in("status", ["pending", "downloading", "flashing", "verifying", "rebooting"]);

      const { data: historyRow } = await db
        .from("firmware_update_history")
        .insert({
          account_id: auth.accountId,
          controller_id: ctrlRow.id,
          release_id: release.id,
          update_type: "ota",
          previous_version: ctrlRow.firmware_version,
          target_version: release.version,
          status: "pending",
          progress_percent: 0,
        })
        .select("*")
        .single();

      const origin = new URL(c.req.url).origin;
      const otaUrl = `${origin}/api/device/firmware/ota/${release.id}`;
      const f = otaFile as { sha256: string; size_bytes: number };

      const emqx = new EmqxClient(c.env!, deps.emqxFetch);
      await emqx.publish({
        topic: `${(cred as { topic_prefix: string }).topic_prefix}/ota/cmd`,
        payload: {
          history_id: (historyRow as { id: string }).id,
          release_id: release.id,
          version: release.version,
          ota_url: otaUrl,
          sha256: f.sha256,
          size_bytes: f.size_bytes,
        },
        qos: 1,
      });

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        controllerId: ctrlRow.id,
        category: "firmware",
        action: "firmware.ota_started",
        summary: `Started OTA update to v${release.version} for "${ctrlRow.name}"`,
      });

      return c.json({ update: historyRow }, 201);
    }
  );

  app.post(
    "/ota/:historyId/cancel",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const historyId = c.req.param("historyId");

      const { data: row } = await db
        .from("firmware_update_history")
        .select("id,controller_id,target_version,status")
        .eq("id", historyId)
        .eq("account_id", auth.accountId)
        .maybeSingle();

      if (!row) return c.json({ error: "Update record not found." }, 404);
      const h = row as {
        id: string;
        controller_id: string;
        target_version: string;
        status: string;
      };

      if (h.status !== "pending") {
        return c.json(
          { error: `Cannot cancel update while status is "${h.status}".` },
          409
        );
      }

      const { data: updated } = await db
        .from("firmware_update_history")
        .update({
          status: "cancelled",
          completed_at: new Date().toISOString(),
        })
        .eq("id", historyId)
        .eq("account_id", auth.accountId)
        .select("*")
        .single();

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        controllerId: h.controller_id,
        category: "firmware",
        action: "firmware.ota_cancelled",
        summary: `Cancelled pending OTA update to v${h.target_version}`,
      });

      return c.json({ update: updated });
    }
  );

  app.post(
    "/usb-flash-events",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = usbFlashLogSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: "Invalid USB flash event." }, 400);

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const boardCheck = parsed.data.boardCheck ?? null;
      const boardMismatch = boardCheck?.result === "mismatch";
      const forcedFlash = Boolean(boardCheck?.forced && boardMismatch);
      // The flasher stopped on a board mismatch before writing anything. That is
      // the safety check working, not a flash that went wrong.
      const stoppedOnMismatch =
        parsed.data.status === "failed" && boardMismatch && !boardCheck?.forced;

      const { data: rel } = await db
        .from("firmware_releases")
        .select("version")
        .eq("id", parsed.data.releaseId)
        .maybeSingle();

      const targetVersion =
        (rel as { version?: string } | null)?.version ?? "usb-factory";

      if (parsed.data.controllerId) {
        const { data: ctrl } = await db
          .from("controllers")
          .select("id")
          .eq("id", parsed.data.controllerId)
          .eq("account_id", auth.accountId)
          .maybeSingle();

        if (ctrl) {
          await db.from("firmware_update_history").insert({
            account_id: auth.accountId,
            controller_id: parsed.data.controllerId,
            release_id: parsed.data.releaseId,
            update_type: "usb_factory",
            target_version: targetVersion,
            status: parsed.data.status,
            progress_percent: parsed.data.status === "succeeded" ? 100 : 0,
            error_message: parsed.data.errorMessage ?? null,
            completed_at: new Date().toISOString(),
          });

          if (parsed.data.status === "succeeded") {
            const ctrlUpdates: Record<string, unknown> = {
              firmware_version: targetVersion,
            };
            if (parsed.data.chipDetected) {
              ctrlUpdates.detected_chip_name = parsed.data.chipDetected;
            }
            if (parsed.data.detectedFlashSizeMb) {
              ctrlUpdates.detected_flash_size_mb = parsed.data.detectedFlashSizeMb;
            }
            // The check proved the connected board is not the selected one, so
            // the selected slug is never stored as what the controller is.
            if (parsed.data.reportedBoardSlug && !boardMismatch) {
              ctrlUpdates.reported_board_slug = parsed.data.reportedBoardSlug;
            }
            await db
              .from("controllers")
              .update(ctrlUpdates)
              .eq("id", parsed.data.controllerId)
              .eq("account_id", auth.accountId);
          }
        }
      }

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        controllerId: parsed.data.controllerId ?? null,
        category: "firmware",
        action:
          parsed.data.status === "succeeded"
            ? "firmware.usb_flash_succeeded"
            : "firmware.usb_flash_failed",
        summary: stoppedOnMismatch
          ? `USB Web Serial flash (${targetVersion}) stopped before writing: the connected board${
              parsed.data.chipDetected ? ` (${parsed.data.chipDetected})` : ""
            } did not match the selected board`
          : `USB Web Serial flash (${targetVersion}) ${parsed.data.status}${
              parsed.data.chipDetected ? ` on ${parsed.data.chipDetected}` : ""
            }${forcedFlash ? " (forced by the user after a board mismatch warning)" : ""}`,
        metadata: {
          errorMessage: parsed.data.errorMessage,
          chipDetected: parsed.data.chipDetected,
          // Kept so a forced flash can always be traced back to who accepted the risk.
          ...(boardCheck ? { boardCheck } : {}),
        },
      });

      await emitNotification(db, {
        scope: "user",
        accountId: auth.accountId,
        category: "firmware",
        eventKey: "firmware.install_result",
        preferenceKey: "firmware_install_results",
        severity:
          parsed.data.status === "succeeded"
            ? forcedFlash
              ? "warning"
              : "success"
            : stoppedOnMismatch
              ? "warning"
              : "danger",
        title:
          parsed.data.status === "succeeded"
            ? `USB Flash Complete (${targetVersion})`
            : stoppedOnMismatch
              ? `USB Flash Stopped (${targetVersion})`
              : `USB Flash Failed (${targetVersion})`,
        message:
          parsed.data.status === "succeeded"
            ? `Flashed firmware v${targetVersion} via Web Serial${
                parsed.data.chipDetected ? ` onto ${parsed.data.chipDetected}` : ""
              }.${
                forcedFlash
                  ? " The board did not match the selected board and the flash was forced."
                  : ""
              }`
            : stoppedOnMismatch
              ? `The connected board${
                  boardCheck?.detectedSummary ? ` (${boardCheck.detectedSummary})` : ""
                } did not match the selected board. Nothing was written to the controller.`
              : `USB flash failed${
                  parsed.data.errorMessage ? `: ${parsed.data.errorMessage}` : "."
                }`,
        metadata: {
          controllerId: parsed.data.controllerId ?? null,
          releaseId: parsed.data.releaseId,
          status: parsed.data.status,
          chipDetected: parsed.data.chipDetected ?? null,
          forced: forcedFlash,
          stoppedOnBoardMismatch: stoppedOnMismatch,
        },
      }).catch(() => null);

      return c.json({ ok: true });
    }
  );

  return app;
}

