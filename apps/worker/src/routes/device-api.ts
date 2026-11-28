import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  ESPNOW_NODE_STALE_MS,
  isDeviceStateActive,
  isNewerFirmwareVersion,
  normalizeBindingGeneration,
  normalizeBoardRole,
} from "@homecoreos/shared";
import { inspectConfiguration, requireEmqxConfig } from "../config/env";
import { recordActivity } from "../lib/audit";
import {
  captureBoardLog,
  createBoardLogCollector,
  describeBoardFact,
} from "../lib/board-log";
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
import { verifyNodeBinding } from "../lib/board-roles";
import { commandIdentity } from "../lib/route-authority";
import { findMatchingFirmwareReleaseIdForDevice } from "../lib/sensor-compatibility";
import { emitNotification } from "../lib/notifications";
import { getFirmwareObject } from "../lib/r2";
import {
  makeRealtimeEvent,
  publishRealtimeEvents,
  type RealtimeEvent,
} from "../lib/realtime";
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
  physicalConfirmationMethod: z
    .enum(["button_press", "local_portal", "ble_recovery", "recovery_console"])
    .optional(),
  firmwareVersion: z.string().trim().max(64).optional(),
  chipVariant: z.string().trim().max(64).optional(),
  boardSlug: z.string().trim().max(120).optional(),
  partitionScheme: z.string().trim().max(48).optional(),
  flashSizeMb: z.number().int().min(1).max(64).optional(),
  psramSizeMb: z.number().int().min(0).max(32).optional(),
  wifiSsid: z.string().trim().max(64).optional(),
  localIp: z.string().trim().max(64).optional(),
  bleSetupPin: z.string().trim().min(6).max(16).optional(),
  provisioningTransport: z
    .enum(["ble", "softap", "usb", "usb_console", "recovery_console", "manual"])
    .optional(),
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
  physicalConfirmationMethod: z.enum([
    "button_press",
    "local_portal",
    "ble_recovery",
    "recovery_console",
  ]),
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
    /** Whether this image can update itself in place (older firmware omits it). */
    otaSupported: z.boolean().optional(),
    os: z.boolean().optional(),
    otaError: z.string().max(200).nullable().optional(),
    oe: z.string().max(200).nullable().optional(),
    /** Running image facts used by repair/recovery diagnostics. */
    uptimeSec: z.number().int().min(0).max(4_000_000_000).optional(),
    up: z.number().int().min(0).max(4_000_000_000).optional(),
    freeHeapBytes: z.number().int().min(0).max(4_000_000_000).optional(),
    heap: z.number().int().min(0).max(4_000_000_000).optional(),
    /** The server URL the board has stored, so recovery can correct a stale one. */
    backendUrl: z.string().trim().max(300).nullable().optional(),
    bu: z.string().trim().max(300).nullable().optional(),
    supportsWifi: z.boolean().optional(),
    sw: z.boolean().optional(),
    supportsBle: z.boolean().optional(),
    sb: z.boolean().optional(),
    espnowSupported: z.boolean().optional(),
    es: z.boolean().optional(),
    espnowLinkState: z
      .enum([
        "hosting",
        "linked",
        "controller_lost",
        "reconnecting",
        "standalone",
        "unassigned",
        "down",
      ])
      .optional(),
    els: z
      .enum([
        "hosting",
        "linked",
        "controller_lost",
        "reconnecting",
        "standalone",
        "unassigned",
        "down",
      ])
      .optional(),
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
    ch: z.number().int().min(1).max(13).optional(),
    // Worker-authorized binding / route telemetry. Never a self-verification.
    bindingState: z.enum(["unpaired", "pairing", "assigned", "verified", "revoked"]).optional(),
    bs: z.enum(["unpaired", "pairing", "assigned", "verified", "revoked"]).optional(),
    bindingId: z.string().trim().max(48).nullable().optional(),
    bid: z.string().trim().max(48).nullable().optional(),
    bindingGeneration: z.number().int().min(0).optional(),
    gen: z.number().int().min(0).optional(),
    /** Worker-issued challenge echoed by the Node after MQTT delivery. */
    challengeId: z.string().trim().max(48).optional(),
    chid: z.string().trim().max(48).optional(),
    challengeNonce: z.string().trim().max(64).optional(),
    cnon: z.string().trim().max(64).optional(),
    challengeGeneration: z.number().int().min(0).optional(),
    chg: z.number().int().min(0).optional(),
    cloudRoute: z.enum(["direct_node_mqtt", "controller_mqtt", "connecting", "unavailable"]).optional(),
    cr: z.enum(["direct_node_mqtt", "controller_mqtt", "connecting", "unavailable"]).optional(),
    kaTx: z.number().int().min(0).optional(),
    ackRx: z.number().int().min(0).optional(),
    peerRssi: z.number().int().min(-120).max(0).optional(),
    peerCh: z.number().int().min(1).max(13).optional(),
    /**
     * Receiver-side facts reported by the board itself.
     *
     * A board has no per-log MQTT publisher: it keeps a tiny bounded ring of
     * facts in RAM and ships them inside the heartbeat it already sends. These
     * are the only honest source for "received", "acknowledged" and
     * "executed" — a publish on the Worker side never proves receipt.
     */
    facts: z
      .array(
        z.object({
          /** kind: cmd | comm | dev | sys */
          k: z.enum(["cmd", "comm", "dev", "sys"]).optional(),
          /** status token, e.g. received / acknowledged / executed */
          s: z.string().trim().max(24).optional(),
          /** transport the fact was observed on */
          m: z.enum(["mqtt", "espnow", "http"]).optional(),
          /** target identifier (switch, device, peer board) */
          t: z.string().trim().max(64).optional(),
          /** short detail, never a payload */
          d: z.string().trim().max(80).optional(),
          /** command id the Worker attached to the command */
          c: z.string().trim().max(64).optional(),
          /** monotonic counter used for ordering */
          ts: z.number().int().min(0).max(4_000_000_000).optional(),
        })
      )
      // The firmware ring holds up to 12 facts; the cap must stay in sync with
      // HC_BOARD_LOG_RING_SIZE, otherwise a full ring would reject the whole
      // heartbeat (and with it the board's telemetry).
      .max(12)
      .optional(),
    /**
     * Random per-boot session id. It namespaces the board's fact sequence so
     * a reboot can never collide with the facts of the previous session.
     */
    factSession: z.number().int().min(0).max(4_294_967_295).optional(),
    sid: z.number().int().min(0).max(4_294_967_295).optional(),
    /** Compact alias used by the firmware. */
    fx: z
      .array(
        z.object({
          k: z.enum(["cmd", "comm", "dev", "sys"]).optional(),
          s: z.string().trim().max(24).optional(),
          m: z.enum(["mqtt", "espnow", "http"]).optional(),
          t: z.string().trim().max(64).optional(),
          d: z.string().trim().max(80).optional(),
          c: z.string().trim().max(64).optional(),
          ts: z.number().int().min(0).max(4_000_000_000).optional(),
        })
      )
      // The firmware ring holds up to 12 facts; the cap must stay in sync with
      // HC_BOARD_LOG_RING_SIZE, otherwise a full ring would reject the whole
      // heartbeat (and with it the board's telemetry).
      .max(12)
      .optional(),
    /** Controller only: the Nodes it currently hosts over ESP-NOW. */
    nodes: z
      .array(
        z.object({
          id: z.string().trim().max(64),
          link: z.enum(["linked", "controller_lost", "reconnecting", "standalone", "unassigned"]).optional(),
          rssi: z.number().int().min(-120).max(0).optional(),
          channel: z.number().int().min(1).max(13).optional(),
          seq: z.number().int().min(0).optional(),
          bid: z.string().trim().max(48).optional(),
          gen: z.number().int().min(0).optional(),
          chid: z.string().trim().max(48).optional(),
          cnon: z.string().trim().max(64).optional(),
          chg: z.number().int().min(0).optional(),
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
    otaPendingReported: d.otaPendingVerify ?? d.otaPending ?? d.op,
    otaSupported: d.otaSupported ?? d.os,
    otaError: d.otaError !== undefined ? d.otaError : d.oe,
    uptimeSec: d.uptimeSec ?? d.up,
    freeHeapBytes: d.freeHeapBytes ?? d.heap,
    backendUrl: d.backendUrl !== undefined ? d.backendUrl : d.bu,
    supportsWifi: d.supportsWifi ?? d.sw,
    supportsBle: d.supportsBle ?? d.sb,
    espnowSupported: d.espnowSupported ?? d.es,
    espnowLinkState: d.espnowLinkState ?? d.els,
    configRevision: d.configRevision ?? d.rev,
    driverManifestHash: d.driverManifestHash ?? d.dmh,
    boardRole: d.boardRole ?? d.role,
    commMode: d.commMode ?? d.cm,
    linkState: d.linkState ?? d.ls,
    radioChannel: d.ch,
    bindingState: d.bindingState ?? d.bs,
    bindingId: d.bindingId !== undefined ? d.bindingId : d.bid,
    bindingGeneration: d.bindingGeneration ?? d.gen,
    challengeId: d.challengeId ?? d.chid,
    challengeNonce: d.challengeNonce ?? d.cnon,
    challengeGeneration: d.challengeGeneration ?? d.chg,
    cloudRoute: d.cloudRoute ?? d.cr,
    kaTx: d.kaTx,
    ackRx: d.ackRx,
    peerRssi: d.peerRssi,
    peerCh: d.peerCh,
    facts: d.facts ?? d.fx,
    factSession: d.factSession ?? d.sid ?? 0,
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
    await publishRealtimeEvents(c.env ?? {}, c.get("deps") ?? {}, dev.accountId, [
      makeRealtimeEvent(
        "board",
        "updated",
        dev.boardInstanceId,
        { configRevision: parsed.data.revision, pendingConfigSync: false },
        "confirmed"
      ),
    ]);
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
          "id,name,status,mqtt_connected,wifi_connected,board_role,assigned_controller_id,comm_mode,firmware_version,config_revision,last_synced_config_revision,pending_config_sync,node_link_state,binding_generation,espnow_telemetry,last_heartbeat_at,last_communication_at,last_error,uptime_sec"
        )
        .eq("id", dev.boardInstanceId)
        .eq("account_id", dev.accountId)
        .maybeSingle(),
      db
        .from("firmware_update_history")
        .select("id,release_id,update_type,target_version,status,error_message,started_at,completed_at")
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
      wifi_connected?: boolean | null;
      node_link_state?: string | null;
      comm_mode?: string | null;
      assigned_controller_id?: string | null;
      board_role?: string | null;
      binding_generation?: number | string | null;
      firmware_version?: string | null;
      config_revision?: number;
      last_synced_config_revision?: number;
      pending_config_sync?: boolean;
      espnow_telemetry?: Record<string, unknown> | null;
      last_heartbeat_at?: string | null;
      last_communication_at?: string | null;
      last_error?: string | null;
      uptime_sec?: number | null;
    } | null;

    // A Node is never described as a Controller in a notification.
    const prevRoleLabel = prev?.board_role === "node" ? "Node" : "Controller";

    const latestHist = latestHistRow as {
      id: string;
      release_id: string | null;
      update_type: string;
      target_version: string;
      status: string;
      error_message?: string | null;
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
    if (parsed.data.partitionScheme !== undefined) {
      updates.reported_partition_scheme = parsed.data.partitionScheme;
    }

    // Recovery health facts. Each one is written only when the board actually
    // reported it, so an older image never blanks a value a newer one wrote or
    // stamps health_reported_at when no health facts were sent.
    const health: Record<string, unknown> = {
      uptime_sec: parsed.data.uptimeSec,
      free_heap_bytes: parsed.data.freeHeapBytes,
      backend_url: parsed.data.backendUrl === undefined ? undefined : (parsed.data.backendUrl?.trim() || null),
      ota_supported: parsed.data.otaSupported,
      ota_pending: parsed.data.otaPendingReported,
      ota_error:
        parsed.data.otaError === undefined ? undefined : (parsed.data.otaError?.trim() || null),
      espnow_supported: parsed.data.espnowSupported,
      // `espnowLinkState` is the ESP-NOW verdict even for a Controller, where
      // `linkState`/`ls` already mean the Node uplink and must not be reused.
      espnow_link_state: parsed.data.espnowLinkState,
      supports_wifi: parsed.data.supportsWifi,
      supports_ble: parsed.data.supportsBle,
    };
    let healthReported = false;
    for (const [key, value] of Object.entries(health)) {
      if (value !== undefined) {
        updates[key] = value;
        healthReported = true;
      }
    }
    if (healthReported) updates.health_reported_at = now;

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
    const prevTel =
      prev?.espnow_telemetry && typeof prev.espnow_telemetry === "object"
        ? prev.espnow_telemetry
        : {};
    let rosterChanged = false;
    let keepaliveFirstReported = false;

    if (storedRole === "node") {
      if (parsed.data.bindingGeneration !== undefined) {
        const currentGeneration = normalizeBindingGeneration(prev?.binding_generation);
        const reportedGeneration = normalizeBindingGeneration(parsed.data.bindingGeneration);
        /* A higher generation observed on a device is authoritative even when
         * the Worker was offline. Lower generations are ignored. */
        if (reportedGeneration > currentGeneration) {
          updates.binding_generation = reportedGeneration;
          updates.route_generation = reportedGeneration;
        }
      }
      if (parsed.data.cloudRoute !== undefined) {
        Object.assign(prevTel, {
          reportedCloudRoute: parsed.data.cloudRoute,
          reportedBindingState: parsed.data.bindingState ?? null,
          reportedBindingId: parsed.data.bindingId ?? null,
          reportedChallengeId: parsed.data.challengeId ?? null,
          reportedChallengeNonce: parsed.data.challengeNonce ?? null,
          reportedAt: now,
        });
        updates.espnow_telemetry = { ...prevTel };
      }
      if (parsed.data.commMode !== undefined) {
        updates.comm_mode = parsed.data.commMode;
      }
      if (parsed.data.linkState !== undefined) {
        updates.node_link_state = parsed.data.linkState;
        if (parsed.data.linkState === "linked") {
          updates.node_last_linked_at = now;
        }
      }
      const hasNodeEspnowReport =
        parsed.data.radioChannel !== undefined ||
        parsed.data.peerCh !== undefined ||
        parsed.data.peerRssi !== undefined ||
        parsed.data.kaTx !== undefined ||
        parsed.data.ackRx !== undefined ||
        parsed.data.linkState !== undefined;
      if (hasNodeEspnowReport) {
        const prevKa = typeof prevTel.keepaliveTxSeq === "number" ? prevTel.keepaliveTxSeq : 0;
        if (prevKa === 0 && (parsed.data.kaTx ?? 0) > 0) {
          keepaliveFirstReported = true;
        }
        const ackConfirmed =
          parsed.data.ackRx !== undefined
            ? parsed.data.ackRx > 0
            : parsed.data.linkState === "linked"
              ? true
              : parsed.data.linkState === "controller_lost" ||
                  parsed.data.linkState === "standalone" ||
                  parsed.data.linkState === "unassigned"
                ? false
                : (prevTel.ackConfirmed ?? null);
        updates.espnow_telemetry = {
          ...prevTel,
          channel: parsed.data.peerCh ?? parsed.data.radioChannel ?? prevTel.channel ?? null,
          rssi: parsed.data.peerRssi ?? prevTel.rssi ?? null,
          keepaliveTxSeq: parsed.data.kaTx ?? prevTel.keepaliveTxSeq ?? null,
          ackRxSeq: parsed.data.ackRx ?? prevTel.ackRxSeq ?? null,
          ackConfirmed,
          nodeReportedLinkState: parsed.data.linkState ?? prevTel.nodeReportedLinkState ?? null,
          nodeReportedAt: now,
        };
      }
    } else if (parsed.data.nodes !== undefined || parsed.data.radioChannel !== undefined) {
      const prevRoster = Array.isArray(prevTel.roster)
        ? (prevTel.roster as Array<{ id?: string; link?: string }>)
        : null;
      const nextRoster =
        parsed.data.nodes !== undefined
          ? parsed.data.nodes.map((n) => ({
              id: n.id,
              link: n.link ?? "linked",
              rssi: n.rssi ?? null,
              channel: n.channel ?? parsed.data.radioChannel ?? null,
              seq: n.seq ?? null,
              bid: n.bid ?? null,
              gen: n.gen ?? null,
            }))
          : prevRoster;
      if (parsed.data.nodes !== undefined) {
        const prevSig = prevRoster
          ? prevRoster.map((r) => `${r.id}:${r.link ?? "linked"}`).sort().join(",")
          : "__none__";
        const nextSig = (nextRoster ?? [])
          .map((r) => `${r.id}:${r.link ?? "linked"}`)
          .sort()
          .join(",");
        rosterChanged = prevSig !== nextSig;
      }
      updates.espnow_telemetry = {
        ...prevTel,
        channel: parsed.data.radioChannel ?? prevTel.channel ?? null,
        ...(parsed.data.nodes !== undefined
          ? { roster: nextRoster, rosterReportedAt: now }
          : {}),
      };
    }

    const { error: hbUpdateError } = await db
      .from("board_instances")
      .update(updates)
      .eq("id", dev.boardInstanceId)
      .eq("account_id", dev.accountId);

    if (hbUpdateError) {
      const errMsg = hbUpdateError.message ?? "";
      const errCode = hbUpdateError.code ?? "";
      const isMissingOptionalCol =
        errCode === "PGRST204" ||
        errCode === "42703" ||
        /could not find the ['"][^'"]+['"] column/i.test(errMsg) ||
        /column .* does not exist/i.test(errMsg);

      if (isMissingOptionalCol) {
        const coreUpdates: Record<string, unknown> = { ...updates };
        for (const col of [
          "reported_partition_scheme",
          "uptime_sec",
          "free_heap_bytes",
          "backend_url",
          "ota_supported",
          "ota_pending",
          "ota_error",
          "espnow_supported",
          "espnow_link_state",
          "espnow_telemetry",
          "supports_wifi",
          "supports_ble",
          "health_reported_at",
        ]) {
          delete coreUpdates[col];
        }
        console.warn(
          `[device-api] heartbeat update hit missing optional column (${errCode || errMsg}); retrying core heartbeat fields.`
        );
        const { error: retryError } = await db
          .from("board_instances")
          .update(coreUpdates)
          .eq("id", dev.boardInstanceId)
          .eq("account_id", dev.accountId);
        if (retryError) {
          console.error("[device-api] core heartbeat update failed:", retryError.message);
          return c.json({ error: "Failed to persist device heartbeat." }, 500);
        }
      } else {
        console.error("[device-api] heartbeat update failed:", hbUpdateError.message);
        return c.json({ error: "Failed to persist device heartbeat." }, 500);
      }
    }

    // Only genuine ONLINE/OFFLINE, uplink, config-sync, roster or firmware
    // transitions are pushed. Steady heartbeats write to Postgres quietly.
    const configJustAcked =
      parsed.data.configRevision !== undefined &&
      parsed.data.configRevision >= (prev?.config_revision ?? 1) &&
      Boolean(
        prev?.pending_config_sync ||
          (prev?.last_synced_config_revision ?? 0) < (prev?.config_revision ?? 1)
      );
    const boardTransition =
      prev?.status !== "online" ||
      configJustAcked ||
      rosterChanged ||
      keepaliveFirstReported ||
      (parsed.data.mqttConnected !== undefined &&
        prev?.mqtt_connected !== parsed.data.mqttConnected) ||
      (parsed.data.wifiConnected !== undefined &&
        prev?.wifi_connected !== parsed.data.wifiConnected) ||
      (parsed.data.firmwareVersion !== undefined &&
        prev?.firmware_version !== parsed.data.firmwareVersion) ||
      (storedRole === "node" &&
        parsed.data.commMode !== undefined &&
        prev?.comm_mode !== parsed.data.commMode) ||
      (storedRole === "node" &&
        parsed.data.linkState !== undefined &&
        prev?.node_link_state !== parsed.data.linkState);

    /* ------------------------------------------------------------------
     * Per-board live Log.
     *
     * Only *transitions* are written. A steady heartbeat never produces a
     * row, so the log stays a readable operational history instead of a
     * firehose of keepalives. Every line belongs to this board alone.
     * ---------------------------------------------------------------- */
    const nodeExpectsNoMqtt =
      storedRole === "node" &&
      Boolean(prev?.assigned_controller_id) &&
      parsed.data.linkState !== "standalone" &&
      parsed.data.linkState !== "unassigned";

    const logCollector = createBoardLogCollector();
    const logCtx = { db, env: c.env ?? {}, deps, collector: logCollector };
    const logBoard = (entry: {
      category: string;
      severity?: string;
      status?: string | null;
      method?: string | null;
      source?: string | null;
      destination?: string | null;
      message: string;
      metadata?: Record<string, unknown>;
      dedupeKey?: string | null;
    }) =>
      captureBoardLog(logCtx, {
        accountId: dev.accountId,
        boardInstanceId: dev.boardInstanceId,
        ...entry,
      });

    const boardName = prev?.name ?? "Board";
    // Identifies one transition: the previous heartbeat is a unique marker
    // for "the board was in this state until now".
    const transitionToken = prev?.last_heartbeat_at ?? prev?.status ?? "init";
    const minuteBucket = Math.floor(Date.now() / 60_000);

    if (prev && prev.status !== "online") {
      await logBoard({
        category: "connection",
        severity: "success",
        status: "online",
        method: "http",
        source: dev.boardInstanceId,
        message: `${boardName} came online.`,
        dedupeKey: `status:online:${transitionToken}`,
        metadata: { previousStatus: prev.status, role: storedRole },
      });
    }

    if (
      parsed.data.mqttConnected !== undefined &&
      prev?.mqtt_connected !== parsed.data.mqttConnected
    ) {
      const connected = parsed.data.mqttConnected;
      // A Node that is linked over ESP-NOW deliberately owns no MQTT session;
      // losing it is the expected route change, not a fault.
      if (!(nodeExpectsNoMqtt && !connected)) {
        await logBoard({
          category: "communication",
          severity: connected ? "success" : "warning",
          status: connected ? "connected" : "disconnected",
          method: "mqtt",
          message: connected
            ? "MQTT session established."
            : "MQTT session lost.",
          dedupeKey: `mqtt:${connected ? "up" : "down"}:${transitionToken}`,
          metadata: { role: storedRole },
        });
      }
    }

    if (
      parsed.data.wifiConnected !== undefined &&
      prev?.wifi_connected !== parsed.data.wifiConnected
    ) {
      const connected = parsed.data.wifiConnected;
      await logBoard({
        category: "communication",
        severity: connected ? "success" : "error",
        status: connected ? "connected" : "disconnected",
        method: "wifi",
        message: connected ? "Wi-Fi connected." : "Wi-Fi disconnected.",
        dedupeKey: `wifi:${connected ? "up" : "down"}:${transitionToken}`,
        metadata: { rssi: parsed.data.wifiRssi ?? null, ssid: parsed.data.wifiSsid ?? null },
      });
    }

    if (
      storedRole === "node" &&
      parsed.data.linkState !== undefined &&
      prev?.node_link_state !== parsed.data.linkState
    ) {
      const linkState = parsed.data.linkState;
      await logBoard({
        category: "connection",
        severity:
          linkState === "linked"
            ? "success"
            : linkState === "controller_lost"
              ? "warning"
              : "info",
        status: linkState,
        method: "espnow",
        source: prev?.assigned_controller_id ?? null,
        destination: dev.boardInstanceId,
        message:
          linkState === "linked"
            ? "Controller link established over ESP-NOW."
            : linkState === "controller_lost"
              ? "Controller link lost."
              : `Controller link state changed to ${linkState}.`,
        dedupeKey: `link:${linkState}:${transitionToken}`,
        metadata: {
          rssi: parsed.data.peerRssi ?? null,
          channel: parsed.data.peerCh ?? null,
        },
      });
    }

    if (
      storedRole === "node" &&
      parsed.data.commMode !== undefined &&
      prev?.comm_mode !== parsed.data.commMode
    ) {
      const routeMethod =
        parsed.data.commMode === "espnow"
          ? "espnow"
          : parsed.data.commMode === "wifi_mqtt"
            ? "mqtt"
            : "worker";
      await logBoard({
        category: "communication",
        severity: "info",
        status: "route_changed",
        method: routeMethod,
        message: `Communication route changed: ${prev?.comm_mode ?? "unknown"} → ${parsed.data.commMode}.`,
        dedupeKey: `route:${parsed.data.commMode}:${transitionToken}`,
        metadata: {
          from: prev?.comm_mode ?? null,
          to: parsed.data.commMode,
        },
      });
    }

    if (storedRole === "node" && parsed.data.bindingGeneration !== undefined) {
      const authorised = normalizeBindingGeneration(prev?.binding_generation);
      const reported = normalizeBindingGeneration(parsed.data.bindingGeneration);
      if (reported > authorised) {
        await logBoard({
          category: "binding",
          severity: "info",
          status: "verified",
          method: "worker",
          message: `Binding generation advanced ${authorised} → ${reported}.`,
          dedupeKey: `binding:gen:${reported}`,
          metadata: {
            from: authorised,
            to: reported,
            bindingId: parsed.data.bindingId ?? null,
          },
        });
      } else if (reported > 0 && reported < authorised) {
        await logBoard({
          category: "binding",
          severity: "warning",
          status: "generation_mismatch",
          method: "worker",
          message: `Reported binding generation ${reported} is older than the authorised ${authorised}.`,
          dedupeKey: `binding:mismatch:${reported}:${authorised}`,
          metadata: { reported, authorised },
        });
      }
    }

    // A reboot is visible as the uptime counter going backwards. It is a
    // genuine "boot" fact reported by the board itself.
    if (
      parsed.data.uptimeSec !== undefined &&
      typeof prev?.uptime_sec === "number" &&
      parsed.data.uptimeSec < prev.uptime_sec
    ) {
      await logBoard({
        category: "system",
        severity: "info",
        status: "reboot",
        method: "http",
        source: dev.boardInstanceId,
        message: `Board rebooted (uptime restarted at ${parsed.data.uptimeSec}s).`,
        dedupeKey: `reboot:${transitionToken}:${parsed.data.uptimeSec}`,
        metadata: {
          previousUptimeSec: prev.uptime_sec,
          uptimeSec: parsed.data.uptimeSec,
        },
      });
    }

    if (
      parsed.data.firmwareVersion !== undefined &&
      prev?.firmware_version !== parsed.data.firmwareVersion
    ) {
      await logBoard({
        category: "system",
        severity: "info",
        status: null,
        method: "http",
        message: `Firmware version ${prev?.firmware_version ?? "unknown"} → ${parsed.data.firmwareVersion}.`,
        dedupeKey: `firmware:${parsed.data.firmwareVersion}`,
        metadata: {
          from: prev?.firmware_version ?? null,
          to: parsed.data.firmwareVersion,
        },
      });
    }

    const reportedError = parsed.data.lastError?.trim() ?? null;
    if (reportedError !== (prev?.last_error ?? null)) {
      if (reportedError) {
        await logBoard({
          category: "system",
          severity: "error",
          status: "error",
          method: "http",
          message: reportedError,
          dedupeKey: `error:${transitionToken}`,
          metadata: { source: "device" },
        });
      } else if (prev?.last_error) {
        await logBoard({
          category: "system",
          severity: "success",
          status: null,
          method: "http",
          message: "The board cleared its reported error.",
          dedupeKey: `error:cleared:${transitionToken}`,
          metadata: { previousError: prev.last_error },
        });
      }
    }

    // Receiver-side facts reported by the board itself. These are the only
    // honest source for "received", "acknowledged" and "executed": a publish
    // on the Worker side never proves that the destination received it.
    const factSession = parsed.data.factSession ?? 0;
    for (const fact of parsed.data.facts ?? []) {
      const status = fact.s?.trim();
      if (!status) continue;
      const kind = fact.k ?? "cmd";
      const category =
        kind === "cmd"
          ? "command"
          : kind === "dev"
            ? "device_activity"
            : kind === "comm"
              ? "communication"
              : "system";
      await logBoard({
        category,
        severity:
          status === "failed" || status === "rejected" || status === "timeout"
            ? "error"
            : status === "duplicate"
              ? "warning"
              : status === "executed" ||
                  status === "acknowledged" ||
                  status === "received"
                ? "success"
                : "info",
        status,
        method: fact.m ?? null,
        source: dev.boardInstanceId,
        destination: fact.t ?? null,
        message: describeBoardFact({
          kind,
          status,
          target: fact.t ?? null,
          detail: fact.d ?? null,
        }),
        dedupeKey: `fact:${factSession}:${status}:${fact.t ?? "-"}:${fact.c ?? "-"}:${fact.ts ?? 0}`,
        metadata: {
          detail: fact.d ?? null,
          reportedBy: "device",
          // The command id ties a receiver-side fact back to the command the
          // Worker published, so a published command can be confirmed (or
          // timed out) against the board's own report.
          commandId: fact.c ?? null,
        },
      });
    }

    if (boardTransition) {
      // The log entries of this report travel in the same envelope as the
      // state change: one broker message per device report.
      const logEvents = logCollector.events.splice(0, logCollector.events.length);
      await publishRealtimeEvents(c.env ?? {}, deps, dev.accountId, [
        makeRealtimeEvent(
          "board",
          "state",
          dev.boardInstanceId,
          {
            status: "online",
            role: storedRole,
            mqttConnected:
              parsed.data.mqttConnected ?? prev?.mqtt_connected ?? null,
            wifiConnected:
              parsed.data.wifiConnected ?? prev?.wifi_connected ?? null,
            firmwareVersion:
              parsed.data.firmwareVersion ?? prev?.firmware_version ?? null,
            nodeLinkState:
              storedRole === "node"
                ? parsed.data.linkState ?? prev?.node_link_state ?? null
                : null,
            lastHeartbeatAt: now,
          },
          "confirmed",
          now
        ),
        ...logEvents,
      ]);
    }

    // A Controller reports which Nodes it currently hosts over ESP-NOW. Those
    // Nodes have no cloud session of their own, so this roster is what keeps
    // their status, communication mode and last-activity honest. An empty array
    // is meaningful too: it is how a Controller says "I host nobody right now",
    // which is what marks its assigned Nodes as controller_lost.
    if (parsed.data.nodes && storedRole === "controller") {
      const roster = parsed.data.nodes;
      const rosterById = new Map(roster.map((n) => [n.id, n]));
      const linkedIds = roster.filter((n) => (n.link ?? "linked") === "linked").map((n) => n.id);

      // Read the roster's current state first so only genuine link changes are
      // broadcast. A Controller re-reporting the same Nodes every heartbeat must
      // not spam the console with reloads.
      const reportedIds = new Set(roster.map((n) => n.id));
      const { data: assignedNodes } = await db
        .from("board_instances")
        .select("id,status,node_link_state,node_last_linked_at,espnow_telemetry")
        .eq("account_id", dev.accountId)
        .eq("assigned_controller_id", dev.boardInstanceId)
        .eq("board_role", "node")
        .is("deleted_at", null);

      const assigned = (assignedNodes ?? []) as Array<{
        id: string;
        status: string | null;
        node_link_state: string | null;
        node_last_linked_at: string | null;
        espnow_telemetry?: Record<string, unknown> | null;
      }>;

      const confirmedLinkedIds: string[] = [];
      const oneWayHeardIds: string[] = [];

      for (const id of linkedIds) {
        const assignedRow = assigned.find((n) => n.id === id);
        if (!assignedRow) continue;
        const nTel =
          assignedRow.espnow_telemetry && typeof assignedRow.espnow_telemetry === "object"
            ? assignedRow.espnow_telemetry
            : {};
        const nodeReportedAtMs =
          typeof nTel.nodeReportedAt === "string" ? Date.parse(nTel.nodeReportedAt) : NaN;
        const recentUnackedNodeReport =
          nTel.ackConfirmed === false &&
          typeof nTel.keepaliveTxSeq === "number" &&
          nTel.keepaliveTxSeq > 0 &&
          Number.isFinite(nodeReportedAtMs) &&
          Date.now() - nodeReportedAtMs < 10_000;

        const rEntry = rosterById.get(id);
        const mergedTel = {
          ...nTel,
          controllerHeardAt: now,
          controllerReportedRssi: rEntry?.rssi ?? nTel.controllerReportedRssi ?? null,
          controllerReportedChannel:
            rEntry?.channel ?? parsed.data.radioChannel ?? nTel.controllerReportedChannel ?? null,
        };

        if (recentUnackedNodeReport) {
          // Asymmetric one-way RX: Controller heard the Node's keepalive, but
          // the Node very recently reported zero received ACKs. Record that the
          // Controller heard it without falsely marking bidirectional `linked`.
          oneWayHeardIds.push(id);
          await db
            .from("board_instances")
            .update({
              espnow_telemetry: mergedTel,
              last_communication_at: now,
            })
            .eq("account_id", dev.accountId)
            .eq("id", id);
        } else {
          confirmedLinkedIds.push(id);
          const { error: nodeRosterErr } = await db
            .from("board_instances")
            .update({
              status: "online",
              comm_mode: "espnow",
              node_link_state: "linked",
              node_last_linked_at: now,
              last_heartbeat_at: now,
              last_communication_at: now,
              espnow_telemetry: mergedTel,
            })
            .eq("account_id", dev.accountId)
            .eq("assigned_controller_id", dev.boardInstanceId)
            .eq("board_role", "node")
            .eq("id", id);
          if (nodeRosterErr) {
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
              .eq("id", id);
          }
        }
      }

      const staleCutoff = Date.now() - ESPNOW_NODE_STALE_MS;
      const missing = assigned.filter((n) => {
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

      const byId = new Map(assigned.map((n) => [n.id, n]));
      const linkedChanged = confirmedLinkedIds.filter((id) => {
        const row = byId.get(id);
        return !row || row.status !== "online" || row.node_link_state !== "linked";
      });

      /* The Controller's own log records the Node only as the peer of a
       * communication event. A Node never inherits the Controller's log and
       * the Controller never inherits the Node's log. */
      for (const id of linkedChanged) {
        await captureBoardLog(logCtx, {
          accountId: dev.accountId,
          boardInstanceId: dev.boardInstanceId,
          category: "communication",
          severity: "success",
          status: "linked",
          method: "espnow",
          source: dev.boardInstanceId,
          destination: id,
          message: `Node ${id} is linked over ESP-NOW.`,
          dedupeKey: `roster:linked:${id}:${transitionToken}`,
          metadata: {
            nodeId: id,
            rssi: rosterById.get(id)?.rssi ?? null,
            channel: rosterById.get(id)?.channel ?? null,
          },
        });
      }

      for (const row of missing) {
        await captureBoardLog(logCtx, {
          accountId: dev.accountId,
          boardInstanceId: dev.boardInstanceId,
          category: "communication",
          severity: "warning",
          status: "controller_lost",
          method: "espnow",
          source: dev.boardInstanceId,
          destination: row.id,
          message: `Node ${row.id} stopped answering on ESP-NOW.`,
          dedupeKey: `roster:lost:${row.id}:${transitionToken}`,
          metadata: { nodeId: row.id },
        });
        // The Worker owns the link verdict, so the loss is recorded on the
        // Node's own log as well — as that board's connection event.
        await captureBoardLog(logCtx, {
          accountId: dev.accountId,
          boardInstanceId: row.id,
          category: "connection",
          severity: "warning",
          status: "controller_lost",
          method: "espnow",
          source: dev.boardInstanceId,
          destination: row.id,
          message: "Controller link lost.",
          dedupeKey: `link:controller_lost:${transitionToken}`,
          metadata: { controllerId: dev.boardInstanceId },
        });
      }

      for (const id of oneWayHeardIds) {
        // One-way reception is a delivery problem: the Controller hears the
        // Node but the Node has no acknowledgement to prove the return path.
        await captureBoardLog(logCtx, {
          accountId: dev.accountId,
          boardInstanceId: dev.boardInstanceId,
          category: "communication",
          severity: "warning",
          status: "received",
          method: "espnow",
          source: id,
          destination: dev.boardInstanceId,
          message: `Heard a keepalive from Node ${id}, but the Node reports no received acknowledgements.`,
          dedupeKey: `roster:oneway:${id}:${minuteBucket}`,
          metadata: { nodeId: id },
        });
      }

      if (linkedChanged.length > 0 || missing.length > 0 || oneWayHeardIds.length > 0) {
        await publishRealtimeEvents(c.env ?? {}, deps, dev.accountId, [
          ...linkedChanged.map((id) =>
            makeRealtimeEvent(
              "board",
              "state",
              id,
              {
                status: "online",
                role: "node",
                nodeLinkState: "linked",
                commMode: "espnow",
                lastHeartbeatAt: now,
              },
              "confirmed",
              now
            )
          ),
          ...oneWayHeardIds.map((id) =>
            makeRealtimeEvent(
              "board",
              "state",
              id,
              { role: "node", controllerHeardAt: now },
              "accepted",
              now
            )
          ),
          ...missing.map((row) =>
            makeRealtimeEvent(
              "board",
              "state",
              row.id,
              { role: "node", nodeLinkState: "controller_lost" },
              "confirmed"
            )
          ),
        ]);
      }
    }

    /* Binding verification is Worker-owned. A Node self-reporting "linked" is
     * not enough: its Controller must also list it, with the same generation,
     * and have a live cloud session. */
    if (
      storedRole === "node" &&
      parsed.data.linkState === "linked" &&
      dev.boardInstanceId &&
      normalizeBindingGeneration(prev?.binding_generation) >= 0
    ) {
      const { data: ctrlForVerify } = await db
        .from("board_instances")
        .select("id,status,mqtt_connected,espnow_telemetry,assigned_controller_id")
        .eq("id", prev?.assigned_controller_id ?? "")
        .eq("account_id", dev.accountId)
        .is("deleted_at", null)
        .maybeSingle();
      const ctrl = ctrlForVerify as {
        id: string;
        status: string | null;
        mqtt_connected: boolean | null;
        espnow_telemetry?: Record<string, unknown> | null;
      } | null;
      const roster = Array.isArray(ctrl?.espnow_telemetry?.roster)
        ? (ctrl!.espnow_telemetry!.roster as Array<Record<string, unknown>>)
        : [];
      const rosterEntry = roster.find((r) => r.id === dev.boardInstanceId);
      const challengeId =
        parsed.data.challengeId ??
        (typeof rosterEntry?.chid === "string" ? rosterEntry.chid : null);
      const challengeNonce =
        parsed.data.challengeNonce ??
        (typeof rosterEntry?.cnon === "string" ? rosterEntry.cnon : null);
      const reportedGeneration = Math.max(
        normalizeBindingGeneration(prev?.binding_generation),
        normalizeBindingGeneration(parsed.data.bindingGeneration)
      );
      const rosterGeneration = normalizeBindingGeneration(rosterEntry?.gen ?? rosterEntry?.generation);
      if (ctrl && rosterEntry && rosterEntry.link === "linked" && reportedGeneration > 0) {
        const verdict = await verifyNodeBinding(db, dev.accountId, {
          nodeId: dev.boardInstanceId,
          controllerId: ctrl.id,
          generation: reportedGeneration,
          bindingId: parsed.data.bindingId ?? null,
          challengeId,
          challengeNonce,
          espnowLinked: true,
          rosterConfirmed: rosterGeneration === 0 || rosterGeneration === reportedGeneration,
          controllerMqttHealthy: ctrl.status === "online" && Boolean(ctrl.mqtt_connected),
          env: c.env ?? undefined,
          deps,
          collector: logCollector,
        }).catch(() => ({ verified: false, generation: reportedGeneration }));
        if (verdict.verified && isEmqxConfigured(c.env ?? {})) {
          const { data: parentCred } = await db
            .from("mqtt_credentials_metadata")
            .select("topic_prefix")
            .eq("board_instance_id", ctrl.id)
            .eq("account_id", dev.accountId)
            .eq("status", "active")
            .maybeSingle();
          const topicPrefix = (parentCred as { topic_prefix?: string } | null)?.topic_prefix;
          if (topicPrefix) {
            const cid = commandIdentity({ action: "confirm_route", node: dev.boardInstanceId, gen: verdict.generation });
            await new EmqxClient(c.env!, deps.emqxFetch).publish({
              topic: `${topicPrefix}/cmd/system`,
              payload: {
                action: "confirm_route",
                node_id: dev.boardInstanceId,
                cid,
                gen: verdict.generation,
                requested_at: now,
              },
              qos: 1,
            }).catch(() => undefined);
          }
        }
      }
    }

    // Reconcile non-terminal OTA history against the true firmware version reported in heartbeat.
    // Also self-heal a known pre-reboot race from older firmware (<= 1.3.7) that emitted a
    // spurious "Controller rolled back to previous firmware partition after first-boot failure"
    // right before esp_restart(), whenever the board immediately boots onto the exact target version.
    const reportedFw = parsed.data.firmwareVersion?.trim();
    const isLinkedEspNowNode =
      storedRole === "node" &&
      (parsed.data.linkState === "linked" || parsed.data.commMode === "espnow");
    const mqttStillPending = !isLinkedEspNowNode && parsed.data.mqttConnected === false;

    const completedAgeMs = latestHist?.completed_at
      ? Date.now() - Date.parse(latestHist.completed_at)
      : Number.POSITIVE_INFINITY;
    const isLegacyPreRebootRaceRollback =
      Boolean(reportedFw && latestHist) &&
      latestHist!.update_type === "ota" &&
      latestHist!.status === "rolled_back" &&
      latestHist!.error_message ===
        "Controller rolled back to previous firmware partition after first-boot failure" &&
      Number.isFinite(completedAgeMs) &&
      completedAgeMs >= 0 &&
      completedAgeMs <= 180_000 &&
      versionsExactMatch(reportedFw!, latestHist!.target_version) &&
      !parsed.data.otaPendingVerify &&
      !mqttStillPending;

    if (isLegacyPreRebootRaceRollback && latestHist && reportedFw) {
      const ctrlName = prev?.name ?? "Controller";
      const { data: healed } = await db
        .from("firmware_update_history")
        .update({
          status: "succeeded",
          progress_percent: 100,
          error_message: null,
          completed_at: now,
        })
        .eq("id", latestHist.id)
        .eq("board_instance_id", dev.boardInstanceId)
        .eq("status", "rolled_back")
        .select("id")
        .maybeSingle();
      if (healed) {
        await recordActivity(db, {
          accountId: dev.accountId,
          boardInstanceId: dev.boardInstanceId,
          category: "firmware",
          action: "firmware.ota_succeeded",
          summary: `Firmware update verified after reboot: ${ctrlName} is running v${reportedFw}`,
        });
        await publishRealtimeEvents(c.env ?? {}, deps, dev.accountId, [
          makeRealtimeEvent(
            "board",
            "updated",
            dev.boardInstanceId,
            {
              firmwareVersion: reportedFw,
              ota: {
                historyId: latestHist.id,
                status: "succeeded",
                progressPercent: 100,
                errorMessage: null,
                targetVersion: latestHist.target_version,
                firmwareVersion: reportedFw,
                terminal: true,
              },
            },
            "confirmed"
          ),
        ]);
      }
    } else if (
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
          if (parsed.data.otaPendingVerify || mqttStillPending) {
            await db
              .from("firmware_update_history")
              .update({
                status: "verifying",
                progress_percent: 96,
              })
              .eq("id", latestHist.id)
              .eq("board_instance_id", dev.boardInstanceId)
              .in("status", [...ACTIVE_OTA_STATUSES]);
            await publishRealtimeEvents(c.env ?? {}, deps, dev.accountId, [
              makeRealtimeEvent(
                "board",
                "updated",
                dev.boardInstanceId,
                {
                  ota: {
                    historyId: latestHist.id,
                    status: "verifying",
                    progressPercent: 96,
                    errorMessage: null,
                    targetVersion: latestHist.target_version,
                    firmwareVersion: reportedFw,
                    terminal: false,
                  },
                },
                "accepted"
              ),
            ]);
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
              await publishRealtimeEvents(c.env ?? {}, deps, dev.accountId, [
                makeRealtimeEvent(
                  "board",
                  "updated",
                  dev.boardInstanceId,
                  {
                    firmwareVersion: reportedFw,
                    ota: {
                      historyId: latestHist.id,
                      status: "succeeded",
                      progressPercent: 100,
                      errorMessage: null,
                      targetVersion: latestHist.target_version,
                      firmwareVersion: reportedFw,
                      terminal: true,
                    },
                  },
                  "confirmed"
                ),
              ]);
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
            await publishRealtimeEvents(c.env ?? {}, deps, dev.accountId, [
              makeRealtimeEvent(
                "board",
                "updated",
                dev.boardInstanceId,
                {
                  firmwareVersion: reportedFw,
                  ota: {
                    historyId: latestHist.id,
                    status: "rolled_back",
                    progressPercent: 0,
                    errorMessage: rollbackMsg,
                    targetVersion: latestHist.target_version,
                    firmwareVersion: reportedFw,
                    terminal: true,
                  },
                },
                "confirmed"
              ),
            ]);
          }
        } else if (
          ["downloading", "flashing", "verifying"].includes(latestHist.status) &&
          Number.isFinite(startedAgeMs) &&
          startedAgeMs > 300_000
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

    if (prev && prev.mqtt_connected && parsed.data.mqttConnected === false && !nodeExpectsNoMqtt) {
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

    if (logCollector.events.length > 0) {
      await publishRealtimeEvents(c.env ?? {}, deps, dev.accountId, logCollector.events);
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
    // Every entity change in this one report is coalesced into a single MQTT
    // message at the end of the handler.
    const realtimeEvents: RealtimeEvent[] = [];
    const logCollector = createBoardLogCollector();
    const logCtx = { db, env: c.env ?? {}, deps, collector: logCollector };

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
        .select("id,name,sensor_type,unit,last_raw_payload,last_value,last_reading_at")
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

      const prevLastValue =
        (sensorMeta as { last_value?: number | null } | null)?.last_value ?? null;
      const prevLastReadingAt =
        (sensorMeta as { last_reading_at?: string | null } | null)?.last_reading_at ?? null;
      const prevErrorStatus = existingRaw.status === "error";
      const statusFlipped = Boolean(sensorMeta) && isErrorReading !== prevErrorStatus;
      const valueChanged =
        numericValue !== null &&
        (prevLastValue === null || Number(prevLastValue) !== numericValue);
      // Unchanged readings are not broadcast, except a once-per-five-minutes
      // freshness touch so "last reading" never looks frozen on a stable sensor.
      const freshnessTouch =
        !prevLastReadingAt ||
        Date.now() - Date.parse(prevLastReadingAt) > 5 * 60 * 1000;

      if (sensorMeta && statusFlipped) {
        // A sensor that starts or stops failing is a device-activity event.
        // Only the transition is logged, never the reading itself.
        await captureBoardLog(
          logCtx,
          {
            accountId: dev.accountId,
            boardInstanceId: dev.boardInstanceId,
            category: "device_activity",
            severity: isErrorReading ? "error" : "success",
            status: isErrorReading ? "error" : "ok",
            method: "http",
            source: dev.boardInstanceId,
            destination: s.sensorId,
            message: isErrorReading
              ? `Sensor ${s.sensorId} stopped reporting: ${s.error ?? "read failed"}.`
              : `Sensor ${s.sensorId} is reporting again.`,
            dedupeKey: `sensor:error:${s.sensorId}:${isErrorReading ? "on" : "off"}:${now}`,
            metadata: { sensorId: s.sensorId, driverId: s.driverId ?? null },
          }
        );
      }

      if (sensorMeta && (statusFlipped || valueChanged || freshnessTouch)) {
        realtimeEvents.push(
          makeRealtimeEvent(
            "sensor",
            "state",
            s.sensorId,
            {
              value: numericValue,
              isOnline: !isErrorReading,
              lastReadingAt: now,
              status: isErrorReading ? "error" : "ok",
              boardInstanceId: dev.boardInstanceId,
            },
            "confirmed",
            now
          )
        );
      }

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
          (meta.sensor_type === "motion_pir" ||
            meta.sensor_type === "contact_reed" ||
            meta.sensor_type === "presence_ld2410" ||
            meta.sensor_type === "motion_ld2410" ||
            meta.sensor_type === "presence_ld2450" ||
            meta.sensor_type === "water_leak" ||
            meta.sensor_type === "rain_level") &&
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

      if (existingSw && stateChanged) {
        await captureBoardLog(
          logCtx,
          {
            accountId: dev.accountId,
            boardInstanceId: dev.boardInstanceId,
            category: "device_activity",
            severity: "info",
            status: sw.isOn ? "on" : "off",
            method: "http",
            source: dev.boardInstanceId,
            destination: sw.switchId,
            message: `Switch ${sw.switchId} is now ${sw.isOn ? "ON" : "OFF"}.`,
            // The switch's own change timestamp identifies the transition, so
            // a repeated report of the same state never writes a second row.
            dedupeKey: `switch:${sw.switchId}:${sw.isOn ? "on" : "off"}:${now}`,
            metadata: { switchId: sw.switchId },
          }
        );
        realtimeEvents.push(
          makeRealtimeEvent(
            "switch",
            "state",
            sw.switchId,
            {
              isOn: sw.isOn,
              isOnline: true,
              lastChangedAt: now,
              boardInstanceId: dev.boardInstanceId,
            },
            "confirmed",
            now
          )
        );
      }

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
        .select("id,name,state,is_online")
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

      const prevDevState = (existingDev as { state?: string | null } | null)?.state ?? null;
      const prevDevOnline =
        (existingDev as { is_online?: boolean | null } | null)?.is_online ?? null;
      if (updatedDev && (prevDevState !== effectiveState || prevDevOnline !== !isDisconnected)) {
        await captureBoardLog(
          logCtx,
          {
            accountId: dev.accountId,
            boardInstanceId: dev.boardInstanceId,
            category: "device_activity",
            severity: isDisconnected ? "warning" : "info",
            status: isDisconnected ? "offline" : effectiveState,
            method: "http",
            source: dev.boardInstanceId,
            destination: d.deviceId,
            message: isDisconnected
              ? `Device ${d.deviceId} reported "${d.state}".`
              : `Device ${d.deviceId} is now "${effectiveState}".`,
            dedupeKey: `device:${d.deviceId}:${effectiveState}:${now}`,
            metadata: { deviceId: d.deviceId, previousState: prevDevState },
          }
        );
        realtimeEvents.push(
          makeRealtimeEvent(
            "device",
            "state",
            d.deviceId,
            {
              state: effectiveState,
              isOnline: !isDisconnected,
              lastStateAt: now,
              boardInstanceId: dev.boardInstanceId,
            },
            "confirmed",
            now
          )
        );
      }

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

    // The per-board log entries of this report travel with the state changes.
    realtimeEvents.push(...logCollector.events);

    if (realtimeEvents.length > 0) {
      await publishRealtimeEvents(c.env ?? {}, deps, dev.accountId, realtimeEvents);
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

    await publishRealtimeEvents(c.env ?? {}, c.get("deps") ?? {}, dev.accountId, [
      makeRealtimeEvent(
        "board",
        "updated",
        dev.boardInstanceId,
        {
          ota: {
            historyId: resolvedHistoryId,
            status: effectiveStatus,
            progressPercent: effectiveProgress,
            errorMessage: effectiveError,
            targetVersion: resolvedTargetVersion,
            firmwareVersion: actualReportedVersion,
            terminal,
          },
          ...(terminal && actualReportedVersion
            ? { firmwareVersion: actualReportedVersion }
            : {}),
        },
        terminal ? "confirmed" : "accepted"
      ),
    ]);

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

    const recordStreamingDownloadProgress = async (pct: number) => {
      try {
        const { data: activeHist } = await db
          .from("firmware_update_history")
          .select("id,status,progress_percent,target_version")
          .eq("board_instance_id", dev.boardInstanceId)
          .eq("account_id", dev.accountId)
          .eq("release_id", releaseId)
          .in("status", ["pending", "downloading", "flashing"])
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!activeHist) return;
        const row = activeHist as {
          id: string;
          status: string;
          progress_percent: number;
          target_version: string;
        };
        const clampedPct = Math.max(12, Math.min(90, Math.round(pct)));
        const nextStatus = clampedPct >= 25 ? "flashing" : "downloading";
        const prevPct = Number(row.progress_percent ?? 0);
        // Throttle writes to at most ~5 steps across the entire image download
        const shouldUpdate =
          row.status !== nextStatus ||
          clampedPct - prevPct >= 15 ||
          (clampedPct >= 90 && prevPct < 90);
        if (!shouldUpdate || clampedPct < prevPct) return;
        await db
          .from("firmware_update_history")
          .update({
            status: nextStatus,
            progress_percent: clampedPct,
          })
          .eq("id", row.id)
          .eq("board_instance_id", dev.boardInstanceId)
          .in("status", ["pending", "downloading", "flashing"]);
        await publishRealtimeEvents(c.env ?? {}, c.get("deps") ?? {}, dev.accountId, [
          makeRealtimeEvent(
            "board",
            "updated",
            dev.boardInstanceId,
            {
              ota: {
                historyId: row.id,
                status: nextStatus,
                progressPercent: clampedPct,
                errorMessage: null,
                targetVersion: row.target_version,
                terminal: false,
              },
            },
            "accepted"
          ),
        ]);
      } catch {
        // Streaming progress reporting is best-effort; never fail binary delivery.
      }
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
          const pct = 10 + ((start + chunk.byteLength) / f.size_bytes) * 80;
          await recordStreamingDownloadProgress(pct);
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
    await recordStreamingDownloadProgress(30);

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
    board_instance_id: provisionalBoardId,
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

  const identityHash = input.identityKey ? await sha256Hex(input.identityKey) : null;
  const { data: resolvedId, error: resolveError } = await db.rpc("resolve_pairing_board", {
    p_code_id: claimed.pairing_code_id,
    p_hardware_uid: input.macAddress ?? null,
    p_identity_hash: identityHash,
  });
  if (resolveError || typeof resolvedId !== "string") {
    return c.json({ error: resolveError?.message ?? "Could not resolve installed board identity." }, 409);
  }
  const boardInstanceId = resolvedId || provisionalBoardId;

  const { data: ctrlData } = await db
    .from("board_instances")
    .select(
      "id,name,connection_history,pairing_status,board_instance_identity_secret_hash,board_role,board_profile_id,custom_board_profile_id"
    )
    .eq("id", boardInstanceId)
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .is("permanently_deleted_at", null)
    .maybeSingle();

  if (!ctrlData) {
    return c.json({ error: "Target controller no longer exists." }, 404);
  }


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
      mqtt_connected: false, // Broker credentials exist; only telemetry proves a connection.
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
        ? {
            provisioning_transport:
              input.provisioningTransport === "usb_console" ||
              input.provisioningTransport === "recovery_console"
                ? "usb"
                : input.provisioningTransport,
          }
        : {}),
      last_error: null,
      last_error_at: null,
      paired_at: now,
      wifi_last_connected_at: now,
      mqtt_last_connected_at: null,
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

  // The console learns about the new board immediately (pairing modal, My Boards,
  // and the 2D floor plan) instead of waiting for its next poll.
  await publishRealtimeEvents(c.env ?? {}, deps, accountId, [
    makeRealtimeEvent(
      "board",
      "updated",
      boardInstanceId,
      {
        status: "online",
        pairingStatus: "paired",
        role: ctrlRoleLabel === "Node" ? "node" : "controller",
        mqttUsername,
        recovered: isRecovery,
      },
      "confirmed"
    ),
  ]);

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
