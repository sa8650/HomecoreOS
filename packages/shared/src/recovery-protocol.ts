/**
 * Device side of the Unified Repair & Recovery Engine.
 *
 * The firmware (`firmware/main/recovery_logic.c`) speaks one small JSON
 * protocol on every local transport:
 *
 *   Wi-Fi setup portal : GET  http://192.168.4.1/api/recovery
 *                        POST {"command":"HC REPAIR {…}"}
 *   Bluetooth LE       : encrypted command `action:"hc HC …"` + status notifications
 *   USB serial (115200): `HC …\n` in, one JSON line out
 *
 * This module is the single place that turns those device payloads into the
 * engine's `RecoveryBoardInfo` / `RecoveryTelemetry`. Having it in `shared`
 * (rather than once per transport, or once in the web app and once in the
 * worker) is what makes "one engine, three transports" true: Wi-Fi, BLE and USB
 * differ only in how bytes arrive, never in how they are interpreted.
 *
 * Everything here is pure: no DOM, no Web Bluetooth, no Web Serial, no fetch.
 */
import {
  RECOVERY_STALE_HEARTBEAT_SEC,
  classifyWifiError,
  emptyRecoveryTelemetry,
  type ProblemCode,
  type RecoveryBoardInfo,
  type RecoveryBoardMode,
  type RecoveryTelemetry,
} from "./recovery";

export const RECOVERY_DEVICE_PROTO_VERSION = 1;

/** `{"hc":"recovery",…}` — discovery answer (`HC HELLO`). */
export interface RecoveryDeviceHello {
  proto: number;
  boardSlug: string | null;
  chip: string | null;
  firmwareVersion: string | null;
  mode: RecoveryBoardMode;
  paired: boolean | null;
  hasWifi: boolean;
  hasBle: boolean;
  recoverySupported: boolean;
  /** Last 4 hex characters of the hardware UID. Never a secret. */
  uidSuffix: string | null;
  /** Partition scheme the running image was built with ("" when unknown). */
  partitionScheme?: string | null;
  /** Hardware UID (MAC) the device exposes for setup identity. Never a secret. */
  hardwareUid?: string | null;
}

/** `{"hc":"status",…}` — live diagnostics (`HC STATUS`). */
export interface RecoveryDeviceStatus {
  proto: number;
  mode: RecoveryBoardMode;
  firmwareVersion: string | null;
  paired: boolean;
  wifiConnected: boolean;
  ssid: string | null;
  /** 0 means "not measured"; negative dBm otherwise. */
  rssi: number | null;
  ip: string | null;
  wifiError: string | null;
  mqttConnected: boolean;
  mqttError: string | null;
  backendReachable: boolean;
  backendAuthenticated: boolean;
  backendOk: boolean;
  configRevision: number | null;
  syncedConfigRevision: number | null;
  pendingConfig: boolean;
  heartbeatAgeSec: number | null;
  heartbeatIntervalSec: number | null;
  entitiesKnown: boolean;
  sensorsTotal: number | null;
  sensorsReporting: number | null;
  switchesTotal: number | null;
  switchesReporting: number | null;
  nodesKnown: boolean;
  nodesTotal: number | null;
  nodesLinked: number | null;
  lastError: string | null;
  /* --- Facts added for the full setup/repair contract ------------------ */
  /** Board Library slug the running firmware was built for. */
  boardSlug?: string | null;
  chip?: string | null;
  partitionScheme?: string | null;
  uptimeSec?: number | null;
  freeHeapBytes?: number | null;
  /** Server URL the controller has stored (never a secret). */
  backendUrl?: string | null;
  /** False when the firmware reports OTA cannot run on this image. */
  otaSupported?: boolean | null;
  otaPendingVerify?: boolean | null;
  otaError?: string | null;
  /** Non-null once the device reports its provisioning-mode interfaces. */
  wifiApSupported?: boolean | null;
  bleSupported?: boolean | null;
  espnowSupported?: boolean | null;
  espnowLinkState?: string | null;
}

export interface RecoveryDeviceAck {
  action: string;
  ok: boolean;
  detail: string;
}

export interface RecoveryDeviceError {
  code: string;
  message: string;
}

export type RecoveryDeviceMessage =
  | { kind: "hello"; hello: RecoveryDeviceHello }
  | { kind: "status"; status: RecoveryDeviceStatus }
  | { kind: "ack"; ack: RecoveryDeviceAck }
  | { kind: "error"; error: RecoveryDeviceError }
  | { kind: "pong"; proto: number }
  | { kind: "unknown"; raw: string };

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

/**
 * `undefined` means the firmware does not report this fact at all (an older
 * image), which the engine shows as Unknown. An empty string is a reported
 * empty value — a real problem. Keeping the two apart is what stops an older
 * board from being reported as misconfigured.
 */
function presentStr(obj: Json, key: string): string | undefined {
  if (!(key in obj)) return undefined;
  return typeof obj[key] === "string" ? (obj[key] as string) : "";
}

function presentBool(obj: Json, key: string): boolean | undefined {
  return key in obj ? bool(obj[key]) ?? false : undefined;
}

function presentNum(obj: Json, key: string): number | undefined {
  return key in obj ? num(obj[key]) ?? undefined : undefined;
}

function mode(value: unknown): RecoveryBoardMode {
  return value === "unprovisioned" || value === "recovery" || value === "normal" || value === "unknown"
    ? value
    : "unknown";
}

/**
 * Parses one device payload. Never throws: an unreadable payload becomes
 * `{kind:"unknown"}`, so a garbled BLE notification or a partial serial line can
 * only ever be retried, never misread as a repair result.
 */
export function parseRecoveryDeviceMessage(raw: string | null | undefined): RecoveryDeviceMessage {
  const text = (raw ?? "").trim();
  if (!text) return { kind: "unknown", raw: "" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unknown", raw: text };
  }
  const obj = asObject(parsed);
  if (!obj) return { kind: "unknown", raw: text };

  const hc = str(obj.hc);

  if (hc === "recovery") {
    return {
      kind: "hello",
      hello: {
        proto: num(obj.proto) ?? RECOVERY_DEVICE_PROTO_VERSION,
        boardSlug: str(obj.board),
        chip: str(obj.chip),
        firmwareVersion: str(obj.fw),
        mode: mode(obj.mode),
        paired: bool(obj.paired),
        hasWifi: bool(obj.wifi) ?? true,
        hasBle: bool(obj.ble) ?? true,
        recoverySupported: bool(obj.recovery_supported) ?? true,
        uidSuffix: str(obj.uid_suffix),
        partitionScheme: str(obj.partition),
        hardwareUid: str(obj.uid),
      },
    };
  }

  if (hc === "status") {
    const rssiRaw = num(obj.rssi);
    const hbAge = num(obj.heartbeat_age_sec);
    const hbInterval = num(obj.heartbeat_interval_sec);
    return {
      kind: "status",
      status: {
        proto: num(obj.proto) ?? RECOVERY_DEVICE_PROTO_VERSION,
        mode: mode(obj.mode),
        firmwareVersion: str(obj.fw),
        paired: bool(obj.paired) ?? false,
        wifiConnected: bool(obj.wifi_connected) ?? false,
        ssid: str(obj.ssid),
        rssi: rssiRaw !== null && rssiRaw < 0 ? rssiRaw : null,
        ip: str(obj.ip),
        wifiError: str(obj.wifi_error),
        mqttConnected: bool(obj.mqtt_connected) ?? false,
        mqttError: str(obj.mqtt_error),
        backendReachable: bool(obj.backend_reachable) ?? false,
        backendAuthenticated: bool(obj.backend_authenticated) ?? false,
        backendOk: bool(obj.backend_ok) ?? false,
        configRevision: num(obj.config_revision),
        syncedConfigRevision: num(obj.synced_config_revision),
        pendingConfig: bool(obj.pending_config) ?? false,
        // 0 from the firmware means "never", which is not the same as "just now".
        heartbeatAgeSec: hbAge !== null && hbAge > 0 ? hbAge : null,
        heartbeatIntervalSec: hbInterval !== null && hbInterval > 0 ? hbInterval : null,
        entitiesKnown: bool(obj.entities_known) ?? false,
        sensorsTotal: num(obj.sensors_total),
        sensorsReporting: num(obj.sensors_reporting),
        switchesTotal: num(obj.switches_total),
        switchesReporting: num(obj.switches_reporting),
        nodesKnown: bool(obj.nodes_known) ?? false,
        nodesTotal: num(obj.nodes_total),
        nodesLinked: num(obj.nodes_linked),
        lastError: str(obj.last_error),
        boardSlug: str(obj.board),
        chip: str(obj.chip),
        partitionScheme: str(obj.partition),
        uptimeSec: presentNum(obj, "uptime_sec"),
        freeHeapBytes: presentNum(obj, "free_heap"),
        backendUrl: presentStr(obj, "backend_url"),
        otaSupported: presentBool(obj, "ota_supported"),
        otaPendingVerify: presentBool(obj, "ota_pending"),
        otaError: str(obj.ota_error),
        wifiApSupported: presentBool(obj, "has_wifi"),
        bleSupported: presentBool(obj, "has_ble"),
        espnowSupported: presentBool(obj, "espnow_supported"),
        espnowLinkState: presentStr(obj, "espnow_link"),
      },
    };
  }

  if (hc === "ack") {
    return {
      kind: "ack",
      ack: {
        action: str(obj.action) ?? "",
        ok: bool(obj.ok) ?? true,
        detail: str(obj.detail) ?? "",
      },
    };
  }

  if (hc === "error") {
    return {
      kind: "error",
      error: {
        code: str(obj.code) ?? "device_error",
        message: str(obj.message) ?? "The controller reported an error.",
      },
    };
  }

  if (hc === "pong") {
    return { kind: "pong", proto: num(obj.proto) ?? RECOVERY_DEVICE_PROTO_VERSION };
  }

  return { kind: "unknown", raw: text };
}

/**
 * Discovery → `RecoveryBoardInfo`. Board Library facts the device cannot know
 * (radio capabilities for a chip we have no profile for, compatibility) are
 * passed in as fallbacks rather than guessed.
 */
export function boardInfoFromHello(
  hello: RecoveryDeviceHello,
  fallbacks: Partial<RecoveryBoardInfo> = {}
): RecoveryBoardInfo {
  const capabilityIssues: string[] = [];
  if (!hello.hasWifi) {
    capabilityIssues.push("This board has no integrated Wi-Fi radio, so it cannot join your network.");
  }
  if (!hello.recoverySupported) {
    capabilityIssues.push(
      "This firmware predates Repair & Recovery. Update the firmware from Firmware & Updates first."
    );
  }

  return {
    ...(fallbacks as RecoveryBoardInfo),
    boardSlug: hello.boardSlug ?? fallbacks.boardSlug ?? null,
    chip: hello.chip ?? fallbacks.chip ?? null,
    model: fallbacks.model ?? null,
    hardwareUid: hello.uidSuffix ?? fallbacks.hardwareUid ?? null,
    firmwareVersion: hello.firmwareVersion ?? fallbacks.firmwareVersion ?? null,
    mode: hello.mode,
    paired: hello.paired ?? fallbacks.paired ?? null,
    supportsWifi: hello.hasWifi,
    supportsBle: hello.hasBle,
    lastTransport: fallbacks.lastTransport ?? null,
    diagnosticsSupported: hello.recoverySupported && hello.proto >= 1,
    capabilityIssues,
  };
}

/**
 * Diagnostics → `RecoveryTelemetry`, merged onto whatever the server already
 * knows. A fact the device does not report stays `available:false` (unknown),
 * which the engine treats as "unable to verify", never as a failure.
 */
/**
 * Compares the server URL stored on the controller with the website that is
 * running this flow. Trailing slashes and a different case in the host are not
 * a different deployment, so they are normalised before comparing.
 */
export function matchesWebsite(
  stored: string | null | undefined,
  website: string | null | undefined
): boolean | null {
  const a = normalizeOrigin(stored);
  const b = normalizeOrigin(website);
  if (!a || !b) return null;
  if (a === b) return true;
  // An http portal host can legitimately carry the same deployment host.
  return a.replace(/^https?:\/\//, "") === b.replace(/^https?:\/\//, "");
}

function normalizeOrigin(value: string | null | undefined): string | null {
  const text = (value ?? "").trim().replace(/\/+$/, "");
  if (!text) return null;
  try {
    const url = new URL(text);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return text.toLowerCase();
  }
}

export function telemetryFromDeviceStatus(
  status: RecoveryDeviceStatus,
  nowMs = Date.now(),
  base: RecoveryTelemetry = emptyRecoveryTelemetry(nowMs),
  websiteUrl: string | null = null
): RecoveryTelemetry {
  const recent: Array<{ code?: string; message: string; at?: string | null }> = [];
  if (status.lastError) recent.push({ message: status.lastError });
  if (status.wifiError) recent.push({ code: "wifi", message: status.wifiError });
  if (status.mqttError) recent.push({ code: "mqtt", message: status.mqttError });

  const staleAfter = Math.max(
    RECOVERY_STALE_HEARTBEAT_SEC,
    (status.heartbeatIntervalSec ?? 60) * 2
  );

  return {
    ...base,
    wifi: {
      available: true,
      connected: status.wifiConnected,
      ssid: status.ssid,
      rssi: status.rssi,
      ipAssigned: status.ip ? true : status.wifiConnected ? false : null,
      lastError: status.wifiError,
      credentialsRewritten: base.wifi.credentialsRewritten,
    },
    internet: status.backendOk
      ? { available: true, reachable: true }
      : { available: false, reachable: null },
    backend: {
      available: true,
      reachable: status.backendReachable,
      authenticated: status.backendAuthenticated,
      status: null,
      lastError: status.backendReachable ? null : "The controller has not reached the HomecoreOS Worker.",
    },
    pairing: {
      available: true,
      paired: status.paired,
      credentialsValid:
        status.paired && status.backendReachable ? (status.backendAuthenticated ? true : false) : null,
    },
    mqtt: {
      available: true,
      connected: status.mqttConnected,
      authenticated: status.mqttConnected ? true : status.mqttError ? false : null,
      lastError: status.mqttError,
    },
    heartbeat: {
      available: true,
      lastHeartbeatAt:
        status.heartbeatAgeSec !== null
          ? new Date(nowMs - status.heartbeatAgeSec * 1000).toISOString()
          : null,
      lastSyncAt: base.heartbeat.lastSyncAt,
      nowMs,
      staleAfterSeconds: staleAfter,
    },
    firmware: {
      available: true,
      version: status.firmwareVersion ?? base.firmware.version,
      boardSlug: status.boardSlug ?? base.firmware.boardSlug,
      partitionScheme: status.partitionScheme ?? base.firmware.partitionScheme,
      uptimeSec: status.uptimeSec ?? base.firmware.uptimeSec,
      freeHeapBytes: status.freeHeapBytes ?? base.firmware.freeHeapBytes,
      compatible: base.firmware.compatible,
      updateAvailable: base.firmware.updateAvailable,
    },
    ota:
      status.otaSupported === undefined && status.otaPendingVerify === undefined
        ? base.ota
        : {
            available: true,
            supported: status.otaSupported ?? base.ota.supported,
            pendingVerify: status.otaPendingVerify ?? base.ota.pendingVerify,
            lastError: status.otaError ?? base.ota.lastError,
          },
    portal:
      status.wifiApSupported === undefined && status.bleSupported === undefined
        ? base.portal
        : {
            available: true,
            wifiApSupported: status.wifiApSupported ?? base.portal.wifiApSupported,
            bleSupported: status.bleSupported ?? base.portal.bleSupported,
          },
    espnow:
      status.espnowSupported === undefined && status.espnowLinkState === undefined
        ? base.espnow
        : {
            available: true,
            supported: status.espnowSupported ?? base.espnow.supported,
            linkState: status.espnowLinkState ?? base.espnow.linkState,
          },
    backendUrl:
      status.backendUrl === undefined
        ? base.backendUrl
        : {
            available: true,
            value: status.backendUrl,
            matchesWebsite: matchesWebsite(status.backendUrl, websiteUrl),
          },
    config: {
      available: true,
      revision: status.configRevision,
      syncedRevision: status.syncedConfigRevision,
      pendingSync: status.pendingConfig,
      hashValid: base.config.hashValid,
    },
    entities: status.entitiesKnown
      ? {
          available: true,
          sensorsTotal: status.sensorsTotal,
          sensorsReporting: status.sensorsReporting,
          switchesTotal: status.switchesTotal,
          switchesReporting: status.switchesReporting,
        }
      : { available: false, sensorsTotal: null, sensorsReporting: null, switchesTotal: null, switchesReporting: null },
    nodes: status.nodesKnown
      ? { available: true, total: status.nodesTotal, linked: status.nodesLinked }
      : { available: false, total: null, linked: null },
    // A status answer *is* the controller's error log: an empty list means it
    // reported no error, which is different from never having been asked.
    errors: { available: true, recent },
  };
}

/** Problem codes the device itself already knows about (used for the plan preview). */
export function problemsFromDeviceStatus(
  status: RecoveryDeviceStatus,
  websiteUrl: string | null = null
): ProblemCode[] {
  const problems: ProblemCode[] = [];
  if (!status.wifiConnected) {
    const classified = classifyWifiError(status.wifiError);
    problems.push(classified ?? "wifi_not_connected");
  }
  if (status.wifiConnected && !status.backendReachable) problems.push("backend_unreachable");
  if (status.paired && !status.mqttConnected) {
    problems.push(status.mqttError ? "mqtt_auth_failed" : "mqtt_disconnected");
  }
  if (!status.paired) problems.push("pairing_missing");
  if (status.configRevision !== null && status.syncedConfigRevision !== null) {
    if (status.pendingConfig || status.configRevision > status.syncedConfigRevision) {
      problems.push("config_unsynced");
    }
  }
  if (status.backendUrl !== undefined) {
    if (!status.backendUrl) problems.push("backend_url_missing");
    else if (websiteUrl && matchesWebsite(status.backendUrl, websiteUrl) === false) {
      problems.push("backend_url_mismatch");
    }
  }
  if (status.espnowSupported === false) problems.push("espnow_unavailable");
  if (status.espnowLinkState === "controller_lost" || status.espnowLinkState === "reconnecting") {
    problems.push("espnow_link_down");
  }
  if (status.otaSupported === false) problems.push("ota_unavailable");
  if (status.entitiesKnown) {
    const sensorsBehind =
      status.sensorsTotal !== null &&
      status.sensorsReporting !== null &&
      status.sensorsReporting < status.sensorsTotal;
    const switchesBehind =
      status.switchesTotal !== null &&
      status.switchesReporting !== null &&
      status.switchesReporting < status.switchesTotal;
    if (sensorsBehind || switchesBehind) problems.push("sensors_not_reporting");
  }
  return Array.from(new Set(problems));
}

// ---------------------------------------------------------------------------
// Commands (what the console sends down the same three transports)
// ---------------------------------------------------------------------------

export type RecoveryDeviceAction =
  | "wifi"
  /** Re-write the HomecoreOS server URL and re-fetch the configuration. */
  | "config"
  | "mqtt"
  /** Re-open the ESP-NOW radio and re-synchronize the role block. */
  | "espnow"
  | "restart"
  | "pair"
  | "factory_reset";

export interface RecoveryRepairRequest {
  action: RecoveryDeviceAction;
  ssid?: string;
  password?: string;
  backendUrl?: string;
  /** Single-use 6-digit account recovery code (`action:"pair"`). */
  pairCode?: string;
  confirm?: boolean;
}

/** One protocol line for any transport (`HC REPAIR {…}`, `HC STATUS`, …). */
export function buildRecoveryCommand(
  kind: "PING" | "HELLO" | "STATUS" | "REPAIR",
  repair?: RecoveryRepairRequest
): string {
  if (kind !== "REPAIR") return `HC ${kind}`;
  const body: Json = { action: repair?.action ?? "config" };
  if (repair?.ssid) body.ssid = repair.ssid;
  if (repair?.password) body.password = repair.password;
  if (repair?.backendUrl) body.backend_url = repair.backendUrl;
  if (repair?.pairCode) body.pair_code = repair.pairCode;
  if (repair?.confirm) body.confirm = true;
  return `HC REPAIR ${JSON.stringify(body)}`;
}

/**
 * The BLE command payload for a recovery line. The firmware relays any
 * `action` starting with `"hc "` straight to the same parser USB uses.
 */
export function bleRecoveryCommandPayload(line: string): { action: string } {
  return { action: `hc ${line}` };
}

// ---------------------------------------------------------------------------
// Transport framing: chunked BLE notifications and serial line buffering
// ---------------------------------------------------------------------------

export interface BleStatusChunk {
  index: number;
  total: number;
  data: string;
}

/** Reads `{"chunk":{"i":0,"n":3,"d":"…"}}` (the firmware's chunk envelope). */
export function parseBleStatusChunk(payload: unknown): BleStatusChunk | null {
  const obj = asObject(payload);
  const chunk = obj ? asObject(obj.chunk) : null;
  if (!chunk) return null;
  const index = num(chunk.i);
  const total = num(chunk.n);
  const data = typeof chunk.d === "string" ? chunk.d : null;
  if (index === null || total === null || data === null) return null;
  if (total < 1 || total > 8 || index < 0 || index >= total) return null;
  return { index, total, data };
}

export interface BleStatusReassembler {
  /** Feed one decrypted notification. Returns the completed payload, or null. */
  push: (payload: unknown) => string | null;
  /** Drops a half-received message (e.g. after a reconnect). */
  reset: () => void;
  /** True while part of a message is buffered. */
  inProgress: () => boolean;
}

/**
 * Reassembles chunked BLE responses. A plain (unchunked) payload passes
 * straight through, and an out-of-order / incomplete set is discarded instead
 * of being guessed — the caller re-asks with `HC STATUS`.
 */
export function createBleStatusReassembler(maxBytes = 8192): BleStatusReassembler {
  let expected = 0;
  let parts = new Map<number, string>();

  const reset = () => {
    expected = 0;
    parts = new Map();
  };

  return {
    push(payload: unknown) {
      const chunk = parseBleStatusChunk(payload);
      if (!chunk) {
        // Not a chunk envelope: a whole response arrived on its own.
        reset();
        if (typeof payload === "string") return payload;
        return payload ? JSON.stringify(payload) : null;
      }

      if (expected !== chunk.total) {
        reset();
        expected = chunk.total;
      }
      parts.set(chunk.index, chunk.data);
      if (parts.size < expected) return null;

      const ordered = Array.from({ length: expected }, (_, i) => parts.get(i) ?? null);
      reset();
      if (ordered.some((p) => p === null)) return null;
      const joined = ordered.join("");
      return joined.length > maxBytes ? null : joined;
    },
    reset,
    inProgress: () => parts.size > 0,
  };
}

// ---------------------------------------------------------------------------
// GATT MTU framing (firmware/main/ble_protocol_logic.c is the other half)
//
// A GATT write carries at most ATT_MTU - 3 bytes. The Security 1 handshake
// (66-byte Client Hello, 130-byte Device Hello), the encrypted command payloads
// and the encrypted status notifications are all larger than that, and the
// negotiated MTU is not something the page can raise: Chrome on Windows and
// several Android builds stay at the 23-byte default. Attempting the long
// write/read instead is what produces the opaque
// "GATT operation failed for unknown reason".
//
// So the page frames everything itself with the same tiny headers the firmware
// parses, and never issues a GATT operation larger than the negotiated budget.
// ---------------------------------------------------------------------------

/** Marker introducing a fragmented write (handshake/command characteristics). */
export const HOMECORE_BLE_FRAG_WRITE_TAG = 0x10;
/** Marker introducing a read-response fragment. */
export const HOMECORE_BLE_FRAG_READ_TAG = 0x20;
/** Marker introducing a status-notification fragment. */
export const HOMECORE_BLE_NOTE_FRAG_TAG = 0x30;
/** `[tag][len:2][offset:2]` */
export const HOMECORE_BLE_FRAG_HEADER = 5;
/** `[tag][index][total:2]` */
export const HOMECORE_BLE_NOTE_FRAG_HEADER = 4;
/** ATT_MTU default: the value every stack must support. */
export const HOMECORE_BLE_DEFAULT_ATT_MTU = 23;
/** Value bytes that fit in one GATT operation for a negotiated MTU. */
export function bleFragmentBudget(mtu: number | null | undefined): number {
  if (!mtu || !Number.isFinite(mtu) || mtu < HOMECORE_BLE_DEFAULT_ATT_MTU) return 20;
  return Math.floor(mtu) - 3;
}

/** One framed write of `value` at `offset`, or null when nothing fits. */
export function buildBleFragmentedWrite(
  value: Uint8Array,
  offset: number,
  maxFragment: number
): Uint8Array | null {
  if (!value || value.byteLength === 0 || offset < 0 || offset >= value.byteLength) return null;
  if (!Number.isFinite(maxFragment) || maxFragment <= HOMECORE_BLE_FRAG_HEADER) return null;
  const budget = Math.floor(maxFragment) - HOMECORE_BLE_FRAG_HEADER;
  const slice = Math.min(budget, value.byteLength - offset);
  const out = new Uint8Array(HOMECORE_BLE_FRAG_HEADER + slice);
  out[0] = HOMECORE_BLE_FRAG_WRITE_TAG;
  out[1] = value.byteLength & 0xff;
  out[2] = (value.byteLength >> 8) & 0xff;
  out[3] = offset & 0xff;
  out[4] = (offset >> 8) & 0xff;
  out.set(value.subarray(offset, offset + slice), HOMECORE_BLE_FRAG_HEADER);
  return out;
}

/**
 * Accumulates the read-response windows of one characteristic value.
 *
 * Window headers carry `total` and `offset`, so a window is addressed rather
 * than sequenced. That matters because the firmware tracks the read cursor and
 * a platform that repeats or reorders a read would otherwise shift every later
 * window by one: each window is copied to its announced offset and the value is
 * complete as soon as every byte has arrived, no matter what order that was in.
 */
export interface BleReadWindowReader {
  /**
   * Adds one window. Returns the whole value once every byte arrived, `null`
   * while more windows are needed, and `undefined` when the frame was rejected
   * (a new value starting at offset 0 always begins a fresh read).
   */
  push: (frame: Uint8Array) => Uint8Array | null | undefined;
  /** True once every byte of the announced length is present. */
  complete: () => boolean;
  /** Length announced by the first window, or null before one arrived. */
  total: () => number | null;
  reset: () => void;
}

export function createBleReadWindowReader(maxBytes = 4096): BleReadWindowReader {
  let announced: number | null = null;
  let buffer: Uint8Array | null = null;
  let seen: boolean[] = [];
  let filled = 0;

  const reset = () => {
    announced = null;
    buffer = null;
    seen = [];
    filled = 0;
  };

  return {
    push(frame: Uint8Array) {
      if (!frame || frame.byteLength === 0) return undefined;

      // A value that fits in one read is returned unchanged.
      if (frame[0] !== HOMECORE_BLE_FRAG_READ_TAG || frame.byteLength < HOMECORE_BLE_FRAG_HEADER) {
        reset();
        return new Uint8Array(frame);
      }

      const total = frame[1] | (frame[2] << 8);
      const offset = frame[3] | (frame[4] << 8);
      const slice = frame.subarray(HOMECORE_BLE_FRAG_HEADER);
      if (total === 0 || total > maxBytes || slice.byteLength === 0) {
        reset();
        return undefined;
      }
      if (offset + slice.byteLength > total) {
        reset();
        return undefined;
      }

      if (announced !== total) {
        reset();
        announced = total;
        buffer = new Uint8Array(total);
        seen = new Array<boolean>(total).fill(false);
      }

      const out = buffer!;
      for (let i = 0; i < slice.byteLength; i++) {
        const index = offset + i;
        if (!seen[index]) {
          seen[index] = true;
          filled++;
        }
        out[index] = slice[i];
      }

      if (filled < announced!) return null;
      const completed = out;
      reset();
      return completed;
    },
    complete: () => announced !== null && filled === announced,
    total: () => announced,
    reset,
  };
}

/**
 * Joins the `{0x30, index, total}` fragments of one encrypted notification.
 * Returns the complete ciphertext once every piece arrived.
 */
export interface BleNoteReassembler {
  push: (frame: Uint8Array) => Uint8Array | null;
  reset: () => void;
  inProgress: () => boolean;
}

export function createBleNoteReassembler(maxBytes = 2048): BleNoteReassembler {
  let expected = 0;
  let parts = new Map<number, Uint8Array>();

  const reset = () => {
    expected = 0;
    parts = new Map();
  };

  return {
    push(frame: Uint8Array) {
      if (!frame || frame.byteLength === 0) return null;
      // Not framed: one whole ciphertext in a single notification.
      if (
        frame[0] !== HOMECORE_BLE_NOTE_FRAG_TAG ||
        frame.byteLength < HOMECORE_BLE_NOTE_FRAG_HEADER
      ) {
        reset();
        return frame;
      }

      const index = frame[1];
      const total = frame[2] | (frame[3] << 8);
      if (total < 1 || total > 255 || index >= total) {
        reset();
        return null;
      }
      if (expected !== total) {
        reset();
        expected = total;
      }
      // Index 0 always starts a message, and a fragment that arrives after a
      // gap cannot be trusted: drop the partial rather than join a message with
      // a hole in it (the flow re-asks with HC STATUS).
      if (index === 0) {
        reset();
        expected = total;
      } else if (parts.size !== index) {
        reset();
        return null;
      }
      parts.set(index, new Uint8Array(frame.subarray(HOMECORE_BLE_NOTE_FRAG_HEADER)));
      if (parts.size < expected) return null;

      let length = 0;
      for (const part of parts.values()) length += part.byteLength;
      if (length === 0 || length > maxBytes) {
        reset();
        return null;
      }
      const out = new Uint8Array(length);
      let cursor = 0;
      for (let i = 0; i < expected; i++) {
        const part = parts.get(i);
        if (!part) {
          reset();
          return null;
        }
        out.set(part, cursor);
        cursor += part.byteLength;
      }
      reset();
      return out;
    },
    reset,
    inProgress: () => parts.size > 0,
  };
}

export interface SerialLineBuffer {
  /** Feed a decoded chunk; returns the complete lines it contained. */
  push: (chunk: string) => string[];
  reset: () => void;
}

/**
 * Line buffering for the USB console. Firmware writes one `\n`-terminated JSON
 * line per response, but a serial read can split or merge them arbitrarily.
 */
export function createSerialLineBuffer(maxLineLength = 4096): SerialLineBuffer {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (buffer.length > maxLineLength) buffer = "";
      return lines.map((l) => l.trim()).filter((l) => l.length > 0);
    },
    reset() {
      buffer = "";
    },
  };
}

/** `HC PING` → the controller answered with its protocol version. */
export function isRecoveryProtocolMessage(message: RecoveryDeviceMessage): boolean {
  return message.kind !== "unknown";
}
