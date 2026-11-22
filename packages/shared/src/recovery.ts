/**
 * HomecoreOS unified Repair & Recovery engine.
 *
 * One engine, three transports. Wi-Fi (temporary setup AP), BLE (Security 1
 * GATT) and USB (serial console) only differ in *how* the browser reaches the
 * board: discovery, diagnostics, the repair plan, repair execution, verification
 * and the final report are exactly the same code for all three.
 *
 * The engine is deliberately pure and transport-agnostic so the same rules run
 * in the web console, in the Worker (server-side verification) and in tests:
 *
 *   discovery  -> RecoveryBoardInfo
 *   diagnostics-> RecoveryTelemetry  =>  DiagnosticCheck[]
 *   plan       -> RepairAction[]      (only what the diagnostics justify)
 *   repair     -> RepairOutcome[]     (executed by the transport adapter)
 *   verify     -> VerificationCheck[] (from fresh telemetry, never "sent OK")
 *   report     -> RecoveryReport
 *
 * Two rules shape every decision here:
 *   1. Missing telemetry is `unknown`, never `fail`. A board that cannot report
 *      Wi-Fi state is not a board with broken Wi-Fi.
 *   2. A repair is never reported as successful because a command was sent. It
 *      is successful only when post-repair telemetry confirms it, and anything
 *      that cannot be confirmed is reported as unverified.
 */

export type RecoveryTransportKind = "wifi" | "ble" | "usb";

export const RECOVERY_TRANSPORT_LABELS: Record<RecoveryTransportKind, string> = {
  wifi: "Wi-Fi",
  ble: "Bluetooth LE",
  usb: "USB",
};

/** A recovery session is single-use and short lived (matches the firmware's 15 min window). */
export const RECOVERY_SESSION_TTL_SEC = 15 * 60;
/** Bound on automatic retries of one transport operation. */
export const RECOVERY_MAX_ATTEMPTS = 3;
/** How long a single transport operation may take before it is declared timed out. */
export const RECOVERY_OPERATION_TIMEOUT_MS = 45_000;
/** How long post-repair verification may wait for fresh telemetry. */
export const RECOVERY_VERIFY_TIMEOUT_MS = 60_000;
/** A heartbeat older than this cannot prove anything about the board right now. */
export const RECOVERY_STALE_HEARTBEAT_SEC = 180;
/** A sensor is "not reporting" after this long without a reading. */
export const RECOVERY_STALE_SENSOR_SEC = 15 * 60;
/** Weak-signal threshold used for the advisory Wi-Fi check (dBm). */
export const RECOVERY_WEAK_RSSI_DBM = -80;

export type RecoveryStage =
  | "discovery"
  | "diagnostics"
  | "plan"
  | "repair"
  | "verification"
  | "report";

export const RECOVERY_STAGE_LABELS: Record<RecoveryStage, string> = {
  discovery: "Detecting controller",
  diagnostics: "Diagnosing controller",
  plan: "Building repair plan",
  repair: "Repairing",
  verification: "Verifying repair",
  report: "Recovery report",
};

// ---------------------------------------------------------------------------
// Stage 1 — Discovery
// ---------------------------------------------------------------------------

export type RecoveryBoardMode = "unprovisioned" | "recovery" | "normal" | "unknown";

/**
 * What the transport can read about the physical board before anything is
 * changed. This is identity: it must never be rewritten by a repair.
 */
export interface RecoveryBoardInfo {
  /** Board Library slug, e.g. `esp32-s3-devkitc-1-n16r8`. */
  boardSlug: string | null;
  model: string | null;
  chip: string | null;
  /** Last 4-8 hex characters of the hardware UID (identity match, never a secret). */
  hardwareUid: string | null;
  firmwareVersion: string | null;
  mode: RecoveryBoardMode;
  paired: boolean | null;
  supportsWifi: boolean;
  supportsBle: boolean;
  /** Transport that provisioned the board last, when the board reports it. */
  lastTransport: string | null;
  /** True when the reported firmware exposes the diagnostics this engine reads. */
  diagnosticsSupported: boolean;
  /** Board Library / firmware capability problems found during discovery. */
  capabilityIssues: string[];
}

export const EMPTY_BOARD_INFO: RecoveryBoardInfo = {
  boardSlug: null,
  model: null,
  chip: null,
  hardwareUid: null,
  firmwareVersion: null,
  mode: "unknown",
  paired: null,
  supportsWifi: true,
  supportsBle: true,
  lastTransport: null,
  diagnosticsSupported: false,
  capabilityIssues: [],
};

// ---------------------------------------------------------------------------
// Stage 2 — Diagnostics
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "warning" | "fail" | "unknown";

export type DiagnosticCheckId =
  | "board_identity"
  | "wifi_config"
  | "wifi_connection"
  | "wifi_signal"
  | "dhcp"
  | "internet"
  | "backend"
  | "pairing"
  | "mqtt"
  | "heartbeat"
  | "firmware"
  | "config"
  | "entities"
  | "nodes"
  | "errors";

export type ProblemCode =
  | "board_unsupported"
  | "firmware_diagnostics_unsupported"
  | "wifi_not_configured"
  | "wifi_auth_failed"
  | "wifi_network_not_found"
  | "wifi_signal_weak"
  | "wifi_not_connected"
  | "dhcp_no_address"
  | "internet_unreachable"
  | "backend_unreachable"
  | "backend_auth_failed"
  | "pairing_missing"
  | "pairing_invalid"
  | "pairing_credentials_revoked"
  | "mqtt_disconnected"
  | "mqtt_auth_failed"
  | "heartbeat_stale"
  | "firmware_missing"
  | "firmware_incompatible"
  | "firmware_update_available"
  | "config_unsynced"
  | "config_corrupt"
  | "sensors_not_reporting"
  | "switches_not_reporting"
  | "nodes_unlinked"
  | "board_reported_error";

export const PROBLEM_LABELS: Record<ProblemCode, string> = {
  board_unsupported: "Board or firmware capability unsupported",
  firmware_diagnostics_unsupported: "Firmware cannot report recovery diagnostics",
  wifi_not_configured: "No Wi-Fi network saved on the controller",
  wifi_auth_failed: "Wi-Fi password rejected by the router",
  wifi_network_not_found: "Saved Wi-Fi network is not in range",
  wifi_signal_weak: "Wi-Fi signal is weak",
  wifi_not_connected: "Controller is not connected to Wi-Fi",
  dhcp_no_address: "Router did not assign an IP address",
  internet_unreachable: "Wi-Fi works but there is no internet access",
  backend_unreachable: "HomecoreOS Worker/API is unreachable",
  backend_auth_failed: "HomecoreOS rejected the controller's device token",
  pairing_missing: "Controller is not paired to an account",
  pairing_invalid: "Pairing credentials are invalid",
  pairing_credentials_revoked: "Pairing was revoked or the board was deleted",
  mqtt_disconnected: "MQTT is not connected",
  mqtt_auth_failed: "MQTT broker rejected the controller's credentials",
  heartbeat_stale: "No recent heartbeat from the controller",
  firmware_missing: "Firmware version not reported",
  firmware_incompatible: "Installed firmware is not compatible with this board",
  firmware_update_available: "A newer compatible firmware is available",
  config_unsynced: "Configuration has not been synchronized",
  config_corrupt: "Stored configuration looks incomplete or corrupt",
  sensors_not_reporting: "Some sensors are not reporting",
  switches_not_reporting: "Some switches are not reporting",
  nodes_unlinked: "Attached Nodes lost their Controller link",
  board_reported_error: "Controller recorded an error",
};

export interface DiagnosticCheck {
  id: DiagnosticCheckId;
  label: string;
  status: CheckStatus;
  /** Problem this check found, or null when it passed / is unknown. */
  problem: ProblemCode | null;
  /** One plain-language sentence, safe to show inline. */
  summary: string;
  /** Expanded technical detail (no secrets). */
  technical?: string;
}

/** Per-fact availability: `available: false` means "we could not read this". */
export interface TelemetryFact {
  available: boolean;
}

export interface RecoveryTelemetry {
  wifi: TelemetryFact & {
    connected: boolean | null;
    ssid: string | null;
    rssi: number | null;
    ipAssigned: boolean | null;
    lastError: string | null;
    /** True when this recovery rewrote the credentials. */
    credentialsRewritten: boolean;
  };
  internet: TelemetryFact & { reachable: boolean | null };
  backend: TelemetryFact & {
    reachable: boolean | null;
    authenticated: boolean | null;
    status: number | null;
    lastError: string | null;
  };
  pairing: TelemetryFact & {
    paired: boolean | null;
    credentialsValid: boolean | null;
  };
  mqtt: TelemetryFact & {
    connected: boolean | null;
    authenticated: boolean | null;
    lastError: string | null;
  };
  heartbeat: TelemetryFact & {
    lastHeartbeatAt: string | null;
    lastSyncAt: string | null;
    nowMs: number;
    staleAfterSeconds: number;
  };
  firmware: TelemetryFact & {
    version: string | null;
    compatible: boolean | null;
    updateAvailable: string | null;
  };
  config: TelemetryFact & {
    revision: number | null;
    syncedRevision: number | null;
    pendingSync: boolean | null;
    hashValid: boolean | null;
  };
  entities: TelemetryFact & {
    sensorsTotal: number | null;
    sensorsReporting: number | null;
    switchesTotal: number | null;
    switchesReporting: number | null;
  };
  nodes: TelemetryFact & {
    total: number | null;
    linked: number | null;
  };
  errors: TelemetryFact & {
    recent: Array<{ code?: string; message: string; at?: string | null }>;
  };
}

export interface RecoveryErrorEntry {
  code?: string;
  message: string;
  at?: string | null;
}

export const emptyRecoveryTelemetry = (nowMs = Date.now()): RecoveryTelemetry => ({
  wifi: {
    available: false,
    connected: null,
    ssid: null,
    rssi: null,
    ipAssigned: null,
    lastError: null,
    credentialsRewritten: false,
  },
  internet: { available: false, reachable: null },
  backend: { available: false, reachable: null, authenticated: null, status: null, lastError: null },
  pairing: { available: false, paired: null, credentialsValid: null },
  mqtt: { available: false, connected: null, authenticated: null, lastError: null },
  heartbeat: {
    available: false,
    lastHeartbeatAt: null,
    lastSyncAt: null,
    nowMs,
    staleAfterSeconds: RECOVERY_STALE_HEARTBEAT_SEC,
  },
  firmware: { available: false, version: null, compatible: null, updateAvailable: null },
  config: { available: false, revision: null, syncedRevision: null, pendingSync: null, hashValid: null },
  entities: {
    available: false,
    sensorsTotal: null,
    sensorsReporting: null,
    switchesTotal: null,
    switchesReporting: null,
  },
  nodes: { available: false, total: null, linked: null },
  errors: { available: false, recent: [] },
});

/** Merge telemetry fragments: a later fragment wins only where it is available. */
export function mergeRecoveryTelemetry(
  base: RecoveryTelemetry,
  patch: Partial<RecoveryTelemetry>
): RecoveryTelemetry {
  const mergeFact = <T extends TelemetryFact>(a: T, b: Partial<T> | undefined): T => {
    if (!b) return a;
    if (b.available === undefined) {
      // A patch that only fills fields never claims availability on its own.
      return { ...a, ...b, available: a.available };
    }
    if (!b.available) return b.available === false && a.available ? a : { ...a, ...b } as T;
    return { ...a, ...b } as T;
  };
  return {
    wifi: mergeFact(base.wifi, patch.wifi),
    internet: mergeFact(base.internet, patch.internet),
    backend: mergeFact(base.backend, patch.backend),
    pairing: mergeFact(base.pairing, patch.pairing),
    mqtt: mergeFact(base.mqtt, patch.mqtt),
    heartbeat: mergeFact(base.heartbeat, patch.heartbeat),
    firmware: mergeFact(base.firmware, patch.firmware),
    config: mergeFact(base.config, patch.config),
    entities: mergeFact(base.entities, patch.entities),
    nodes: mergeFact(base.nodes, patch.nodes),
    errors: mergeFact(base.errors, patch.errors),
  };
}

function ageSeconds(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

function describeSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** Recognises the router-side failure text the firmware records. */
export function classifyWifiError(message: string | null | undefined): ProblemCode | null {
  const text = (message ?? "").trim().toLowerCase();
  if (!text) return null;
  if (/auth|password|handshake|wrong|invalid.?key|4way/.test(text)) return "wifi_auth_failed";
  if (/not found|no ap|ssid|out of range|no.?ap/.test(text)) return "wifi_network_not_found";
  if (/ip|dhcp|address/.test(text)) return "dhcp_no_address";
  return "wifi_not_connected";
}

export interface DiagnosticsInput {
  board: RecoveryBoardInfo;
  telemetry: RecoveryTelemetry;
  transport: RecoveryTransportKind;
  /** True when the user supplied new Wi-Fi credentials in this session. */
  wifiCredentialsProvided?: boolean;
  rssiWeakThreshold?: number;
}

export interface DiagnosticsResult {
  checks: DiagnosticCheck[];
  problems: ProblemCode[];
  status: "healthy" | "degraded" | "offline" | "unknown";
  /** True when at least one fact could not be read at all. */
  hasUnknowns: boolean;
}

function check(
  id: DiagnosticCheckId,
  label: string,
  status: CheckStatus,
  summary: string,
  problem: ProblemCode | null = null,
  technical?: string
): DiagnosticCheck {
  return { id, label, status, summary, problem, technical };
}

/**
 * Stage 2. Pure function of recorded facts. Never invents a failure from
 * missing data: a fact with `available: false` produces an `unknown` check.
 */
export function runDiagnostics(input: DiagnosticsInput): DiagnosticsResult {
  const { board, telemetry: t } = input;
  const weakThreshold = input.rssiWeakThreshold ?? RECOVERY_WEAK_RSSI_DBM;
  const checks: DiagnosticCheck[] = [];

  // --- Identity & capability ------------------------------------------------
  if (board.capabilityIssues.length > 0) {
    checks.push(
      check(
        "board_identity",
        "Board identity & capability",
        "fail",
        board.capabilityIssues[0],
        "board_unsupported",
        board.capabilityIssues.join(" · ")
      )
    );
  } else if (board.boardSlug || board.chip) {
    checks.push(
      check(
        "board_identity",
        "Board identity & capability",
        "pass",
        `${board.model ?? board.boardSlug ?? board.chip} confirmed${
          board.firmwareVersion ? `, firmware v${board.firmwareVersion}` : ""
        }.`
      )
    );
  } else {
    checks.push(
      check(
        "board_identity",
        "Board identity & capability",
        "unknown",
        "The controller did not report its board identity.",
        null
      )
    );
  }

  // --- Wi-Fi configuration --------------------------------------------------
  const hasSavedSsid = Boolean(t.wifi.ssid && t.wifi.ssid.trim());
  if (!t.wifi.available) {
    checks.push(
      check("wifi_config", "Wi-Fi configuration", "unknown", "The controller cannot report its saved Wi-Fi network.")
    );
  } else if (!hasSavedSsid && !input.wifiCredentialsProvided) {
    checks.push(
      check(
        "wifi_config",
        "Wi-Fi configuration",
        "fail",
        "No Wi-Fi network is saved on this controller.",
        "wifi_not_configured",
        "wifi_ssid is empty in the controller's stored configuration."
      )
    );
  } else {
    checks.push(
      check(
        "wifi_config",
        "Wi-Fi configuration",
        "pass",
        hasSavedSsid ? `Wi-Fi network "${t.wifi.ssid}" is saved.` : "New Wi-Fi credentials were provided."
      )
    );
  }

  // --- Wi-Fi connection -----------------------------------------------------
  if (!t.wifi.available) {
    checks.push(
      check("wifi_connection", "Wi-Fi connection", "unknown", "Wi-Fi connection state could not be read.")
    );
  } else if (t.wifi.connected === true) {
    checks.push(check("wifi_connection", "Wi-Fi connection", "pass", "The controller is joined to Wi-Fi."));
  } else if (t.wifi.connected === false) {
    const code = classifyWifiError(t.wifi.lastError) ?? "wifi_not_connected";
    checks.push(
      check(
        "wifi_connection",
        "Wi-Fi connection",
        "fail",
        t.wifi.lastError
          ? `Wi-Fi failed: ${t.wifi.lastError}.`
          : "The controller is not connected to Wi-Fi.",
        code,
        t.wifi.lastError ?? undefined
      )
    );
  } else {
    checks.push(
      check("wifi_connection", "Wi-Fi connection", "unknown", "Wi-Fi connection state is not reported.")
    );
  }

  // --- Signal ---------------------------------------------------------------
  if (!t.wifi.available || t.wifi.rssi === null) {
    checks.push(check("wifi_signal", "Wi-Fi signal strength", "unknown", "Signal strength is not reported."));
  } else if (t.wifi.rssi <= weakThreshold) {
    checks.push(
      check(
        "wifi_signal",
        "Wi-Fi signal strength",
        "warning",
        `Signal is weak (${t.wifi.rssi} dBm). Move the controller closer to the router.`,
        "wifi_signal_weak",
        `RSSI ${t.wifi.rssi} dBm <= ${weakThreshold} dBm`
      )
    );
  } else {
    checks.push(check("wifi_signal", "Wi-Fi signal strength", "pass", `Signal ${t.wifi.rssi} dBm.`));
  }

  // --- DHCP -----------------------------------------------------------------
  if (!t.wifi.available) {
    checks.push(check("dhcp", "IP address (DHCP)", "unknown", "IP assignment could not be read."));
  } else if (t.wifi.connected === false) {
    checks.push(
      check("dhcp", "IP address (DHCP)", "unknown", "No IP address can be assigned until Wi-Fi connects.")
    );
  } else if (t.wifi.ipAssigned === true) {
    checks.push(check("dhcp", "IP address (DHCP)", "pass", "The router assigned an IP address."));
  } else if (t.wifi.ipAssigned === false) {
    checks.push(
      check(
        "dhcp",
        "IP address (DHCP)",
        "fail",
        "Wi-Fi is connected but the router did not assign an IP address.",
        "dhcp_no_address"
      )
    );
  } else {
    checks.push(check("dhcp", "IP address (DHCP)", "unknown", "IP assignment is not reported."));
  }

  // --- Internet -------------------------------------------------------------
  if (!t.internet.available) {
    checks.push(check("internet", "Internet connectivity", "unknown", "Internet reachability is not reported."));
  } else if (t.internet.reachable === true) {
    checks.push(check("internet", "Internet connectivity", "pass", "The controller can reach the internet."));
  } else if (t.internet.reachable === false) {
    checks.push(
      check(
        "internet",
        "Internet connectivity",
        "fail",
        "Wi-Fi works, but the controller cannot reach the internet.",
        "internet_unreachable"
      )
    );
  } else {
    checks.push(check("internet", "Internet connectivity", "unknown", "Internet reachability could not be determined."));
  }

  // --- Backend / Worker -----------------------------------------------------
  const apiStatus = t.backend.status;
  if (!t.backend.available) {
    checks.push(
      check("backend", "HomecoreOS backend", "unknown", "Worker/API reachability is not reported.")
    );
  } else if (t.backend.reachable === true && t.backend.authenticated !== false) {
    checks.push(check("backend", "HomecoreOS backend", "pass", "The controller reached the HomecoreOS Worker."));
  } else if (apiStatus === 401 || apiStatus === 403 || t.backend.authenticated === false) {
    checks.push(
      check(
        "backend",
        "HomecoreOS backend",
        "fail",
        "The Worker is reachable but rejected the controller's device token.",
        "backend_auth_failed",
        apiStatus ? `HTTP ${apiStatus}` : undefined
      )
    );
  } else if (t.backend.reachable === false) {
    checks.push(
      check(
        "backend",
        "HomecoreOS backend",
        "fail",
        "The controller cannot reach the HomecoreOS Worker.",
        "backend_unreachable",
        t.backend.lastError ?? undefined
      )
    );
  } else {
    checks.push(check("backend", "HomecoreOS backend", "unknown", "Backend reachability is not reported."));
  }

  // --- Pairing --------------------------------------------------------------
  if (!t.pairing.available) {
    checks.push(check("pairing", "Pairing & authentication", "unknown", "Pairing state is not reported."));
  } else if (t.pairing.paired === true && t.pairing.credentialsValid !== false) {
    checks.push(check("pairing", "Pairing & authentication", "pass", "The controller is paired and authenticated."));
  } else if (t.pairing.paired === false) {
    checks.push(
      check(
        "pairing",
        "Pairing & authentication",
        "fail",
        "The controller is not paired to an account.",
        "pairing_missing"
      )
    );
  } else if (t.pairing.credentialsValid === false) {
    checks.push(
      check(
        "pairing",
        "Pairing & authentication",
        "fail",
        "The controller's pairing credentials are no longer accepted.",
        "pairing_invalid"
      )
    );
  } else {
    checks.push(check("pairing", "Pairing & authentication", "unknown", "Pairing validity is not reported."));
  }

  // --- MQTT -----------------------------------------------------------------
  if (!t.mqtt.available) {
    checks.push(check("mqtt", "MQTT broker", "unknown", "MQTT state is not reported."));
  } else if (t.mqtt.connected === true && t.mqtt.authenticated !== false) {
    checks.push(check("mqtt", "MQTT broker", "pass", "The controller is connected to the MQTT broker."));
  } else if (t.mqtt.authenticated === false) {
    checks.push(
      check(
        "mqtt",
        "MQTT broker",
        "fail",
        "The broker rejected the controller's MQTT credentials.",
        "mqtt_auth_failed",
        t.mqtt.lastError ?? undefined
      )
    );
  } else if (t.mqtt.connected === false) {
    checks.push(
      check(
        "mqtt",
        "MQTT broker",
        "fail",
        "The controller is not connected to the MQTT broker.",
        "mqtt_disconnected",
        t.mqtt.lastError ?? undefined
      )
    );
  } else {
    checks.push(check("mqtt", "MQTT broker", "unknown", "MQTT connection state could not be read."));
  }

  // --- Heartbeat ------------------------------------------------------------
  if (!t.heartbeat.available) {
    checks.push(check("heartbeat", "Heartbeat & synchronization", "unknown", "Heartbeat data is unavailable."));
  } else {
    const age = ageSeconds(t.heartbeat.lastHeartbeatAt, t.heartbeat.nowMs);
    if (age === null) {
      checks.push(
        check(
          "heartbeat",
          "Heartbeat & synchronization",
          "unknown",
          "The controller has never sent a heartbeat."
        )
      );
    } else if (age > t.heartbeat.staleAfterSeconds) {
      checks.push(
        check(
          "heartbeat",
          "Heartbeat & synchronization",
          "fail",
          `Last heartbeat was ${describeSeconds(age)} ago.`,
          "heartbeat_stale",
          `heartbeat_age=${age}s > stale_after=${t.heartbeat.staleAfterSeconds}s`
        )
      );
    } else {
      checks.push(
        check(
          "heartbeat",
          "Heartbeat & synchronization",
          "pass",
          `Last heartbeat ${describeSeconds(age)} ago.`
        )
      );
    }
  }

  // --- Firmware -------------------------------------------------------------
  if (!t.firmware.available) {
    checks.push(check("firmware", "Firmware compatibility", "unknown", "Firmware version is not reported."));
  } else if (!t.firmware.version) {
    checks.push(
      check(
        "firmware",
        "Firmware compatibility",
        "fail",
        "The controller did not report a firmware version.",
        "firmware_missing"
      )
    );
  } else if (t.firmware.compatible === false) {
    checks.push(
      check(
        "firmware",
        "Firmware compatibility",
        "fail",
        `Firmware v${t.firmware.version} is not compatible with this board.`,
        "firmware_incompatible",
        "Recovery cannot fix a firmware/board mismatch; use the Flash Board workflow."
      )
    );
  } else if (t.firmware.updateAvailable) {
    checks.push(
      check(
        "firmware",
        "Firmware compatibility",
        "warning",
        `A newer compatible firmware (v${t.firmware.updateAvailable}) is available.`,
        "firmware_update_available",
        "Advisory only: recovery never installs firmware; use Firmware & Updates."
      )
    );
  } else {
    checks.push(
      check("firmware", "Firmware compatibility", "pass", `Firmware v${t.firmware.version} is compatible.`)
    );
  }

  // --- Configuration --------------------------------------------------------
  if (!t.config.available) {
    checks.push(check("config", "Configuration integrity", "unknown", "Configuration state is not reported."));
  } else if (t.config.hashValid === false) {
    checks.push(
      check(
        "config",
        "Configuration integrity",
        "fail",
        "The stored configuration is incomplete or corrupt.",
        "config_corrupt",
        `revision=${t.config.revision ?? "?"} synced=${t.config.syncedRevision ?? "?"}`
      )
    );
  } else if (
    t.config.pendingSync === true ||
    (t.config.revision !== null &&
      t.config.syncedRevision !== null &&
      t.config.revision > t.config.syncedRevision)
  ) {
    checks.push(
      check(
        "config",
        "Configuration integrity",
        "warning",
        "The controller has not acknowledged the latest configuration revision.",
        "config_unsynced",
        `revision=${t.config.revision ?? "?"} synced=${t.config.syncedRevision ?? "?"}`
      )
    );
  } else {
    checks.push(check("config", "Configuration integrity", "pass", "Configuration is synchronized."));
  }

  // --- Entities -------------------------------------------------------------
  if (!t.entities.available) {
    checks.push(
      check("entities", "Sensors & switches", "unknown", "Sensor and switch reporting is unavailable.")
    );
  } else {
    const sensorTotal = t.entities.sensorsTotal ?? 0;
    const sensorReporting = t.entities.sensorsReporting ?? 0;
    const switchTotal = t.entities.switchesTotal ?? 0;
    const switchReporting = t.entities.switchesReporting ?? 0;
    if (sensorTotal > 0 && sensorReporting < sensorTotal) {
      checks.push(
        check(
          "entities",
          "Sensors & switches",
          "warning",
          `${sensorTotal - sensorReporting} of ${sensorTotal} sensor(s) are not reporting.`,
          "sensors_not_reporting"
        )
      );
    } else if (switchTotal > 0 && switchReporting < switchTotal) {
      checks.push(
        check(
          "entities",
          "Sensors & switches",
          "warning",
          `${switchTotal - switchReporting} of ${switchTotal} switch(es) are not reporting.`,
          "switches_not_reporting"
        )
      );
    } else if (sensorTotal + switchTotal === 0) {
      checks.push(check("entities", "Sensors & switches", "pass", "No sensors or switches are assigned to this board."));
    } else {
      checks.push(
        check(
          "entities",
          "Sensors & switches",
          "pass",
          `${sensorReporting} sensor(s) and ${switchReporting} switch(es) reporting.`
        )
      );
    }
  }

  // --- Nodes ----------------------------------------------------------------
  if (!t.nodes.available || (t.nodes.total ?? 0) === 0) {
    checks.push(check("nodes", "Node communication", "pass", "No Nodes are attached to this Controller."));
  } else if ((t.nodes.linked ?? 0) < (t.nodes.total ?? 0)) {
    checks.push(
      check(
        "nodes",
        "Node communication",
        "warning",
        `${(t.nodes.total ?? 0) - (t.nodes.linked ?? 0)} of ${t.nodes.total} Node(s) lost their link.`,
        "nodes_unlinked"
      )
    );
  } else {
    checks.push(check("nodes", "Node communication", "pass", `${t.nodes.total} Node(s) linked.`));
  }

  // --- Recorded errors ------------------------------------------------------
  if (!t.errors.available) {
    checks.push(check("errors", "Recent errors", "unknown", "The controller's error log is unavailable."));
  } else if (t.errors.recent.length > 0) {
    const first = t.errors.recent[0];
    checks.push(
      check(
        "errors",
        "Recent errors",
        "warning",
        `The controller recorded an error: ${first.message.slice(0, 160)}`,
        "board_reported_error",
        t.errors.recent.map((e) => e.message).join(" | ").slice(0, 600)
      )
    );
  } else {
    checks.push(check("errors", "Recent errors", "pass", "No recent controller errors."));
  }

  if (!board.diagnosticsSupported && board.firmwareVersion) {
    checks.push(
      check(
        "board_identity",
        "Diagnostics capability",
        "warning",
        "This firmware cannot report full recovery diagnostics; some checks stay Unknown.",
        "firmware_diagnostics_unsupported"
      )
    );
  }

  const problems = Array.from(
    new Set(checks.map((c) => c.problem).filter((p): p is ProblemCode => Boolean(p)))
  );
  const hasUnknowns = checks.some((c) => c.status === "unknown");
  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarning = checks.some((c) => c.status === "warning");

  let status: DiagnosticsResult["status"];
  if (hasFail) status = "offline";
  else if (hasWarning) status = "degraded";
  else if (hasUnknowns) status = "unknown";
  else status = "healthy";

  return { checks, problems, status, hasUnknowns };
}

// ---------------------------------------------------------------------------
// Stage 3 — Recovery plan
// ---------------------------------------------------------------------------

export type RepairActionId =
  | "rewrite_wifi"
  | "verify_network"
  | "reconnect_mqtt"
  | "repair_pairing"
  | "resync_config"
  | "restore_config"
  | "recheck_entities"
  | "none";

export type RepairActionKind = "credentials" | "connection" | "pairing" | "config" | "diagnostic";

export interface RepairAction {
  id: RepairActionId;
  title: string;
  description: string;
  kind: RepairActionKind;
  /** Problem this action addresses. */
  problem: ProblemCode | null;
  /** What the user will see when it worked. */
  verification: string;
  /** True when the action needs the user to type a secret in this session. */
  requiresSecret: "wifi" | "recovery_code" | null;
  /** True when the action changes identity / credentials (needs explicit consent). */
  changesIdentity: boolean;
  /** True when the action is only possible on some transports. */
  transports?: RecoveryTransportKind[];
}

export interface RecoveryPlan {
  actions: RepairAction[];
  /** Firmware work is out of scope: send the user to the Flash Board workflow. */
  requiresFirmwareWorkflow: boolean;
  /** A destructive/identity-changing step the user must explicitly confirm. */
  requiresUserConsent: boolean;
  consentReason: string | null;
  /** Plain-language "problem / action / verification" preview shown before repair. */
  summary: Array<{ problem: string; action: string; verification: string }>;
  /** Nothing to do: the environment is healthy. */
  noActionNeeded: boolean;
}

const ACTION_LIBRARY: Record<RepairActionId, RepairAction> = {
  rewrite_wifi: {
    id: "rewrite_wifi",
    title: "Rewrite Wi-Fi credentials",
    description:
      "Saves the Wi-Fi network name and password on the controller and reconnects it. The board ID, pairing and device assignments are kept.",
    kind: "credentials",
    problem: null,
    verification: "The controller joins Wi-Fi and gets an IP address.",
    requiresSecret: "wifi",
    changesIdentity: false,
  },
  verify_network: {
    id: "verify_network",
    title: "Re-check network path",
    description:
      "Re-tests the router, internet and HomecoreOS Worker path from the controller without changing any stored setting.",
    kind: "diagnostic",
    problem: null,
    verification: "The controller reaches the internet and the HomecoreOS Worker.",
    requiresSecret: null,
    changesIdentity: false,
  },
  reconnect_mqtt: {
    id: "reconnect_mqtt",
    title: "Re-establish MQTT authentication",
    description:
      "Reconnects the controller to the MQTT broker and re-verifies its credentials. Wi-Fi credentials and device assignments are untouched.",
    kind: "connection",
    problem: "mqtt_auth_failed",
    verification: "The controller authenticates with the broker and the heartbeat resumes.",
    requiresSecret: null,
    changesIdentity: false,
  },
  repair_pairing: {
    id: "repair_pairing",
    title: "Re-pair with your account",
    description:
      "Issues a single-use recovery code and re-pairs the existing board record. The board ID, room, devices, sensors, switches and Nodes are kept; MQTT credentials are rotated.",
    kind: "pairing",
    problem: "pairing_missing",
    verification: "The controller authenticates with HomecoreOS and receives fresh MQTT credentials.",
    requiresSecret: "recovery_code",
    changesIdentity: true,
  },
  resync_config: {
    id: "resync_config",
    title: "Re-synchronize configuration",
    description:
      "Pushes the current configuration revision to the controller and waits for it to acknowledge it.",
    kind: "config",
    problem: "config_unsynced",
    verification: "The controller acknowledges the latest configuration revision.",
    requiresSecret: null,
    changesIdentity: false,
  },
  restore_config: {
    id: "restore_config",
    title: "Restore a valid configuration",
    description:
      "Rebuilds the controller's configuration snapshot from its stored devices, sensors and switches. Nothing is erased from your account.",
    kind: "config",
    problem: "config_corrupt",
    verification: "The controller applies a complete, valid configuration revision.",
    requiresSecret: null,
    changesIdentity: false,
  },
  recheck_entities: {
    id: "recheck_entities",
    title: "Resume sensor & switch reporting",
    description:
      "Asks the controller to re-read its local inputs and report sensor and switch state again.",
    kind: "diagnostic",
    problem: "sensors_not_reporting",
    verification: "Sensors and switches report fresh values.",
    requiresSecret: null,
    changesIdentity: false,
  },
  none: {
    id: "none",
    title: "No repair needed",
    description: "The controller reported a healthy environment.",
    kind: "diagnostic",
    problem: null,
    verification: "Nothing to verify.",
    requiresSecret: null,
    changesIdentity: false,
  },
};

export interface BuildPlanInput {
  board: RecoveryBoardInfo;
  diagnostics: DiagnosticsResult;
  transport: RecoveryTransportKind;
  /** True only when the user explicitly asked for a full account re-pair. */
  allowRePair?: boolean;
}

/**
 * Stage 3. A repair is proposed only for a confirmed problem. Unknown checks
 * are never "repaired" blindly, and firmware incompatibility is knowingly
 * handed off to the separate Flash Board workflow.
 */
export function buildRepairPlan(input: BuildPlanInput): RecoveryPlan {
  const { diagnostics, transport } = input;
  const problems = new Set(diagnostics.problems);
  const actions: RepairAction[] = [];
  const add = (id: RepairActionId, problem: ProblemCode | null = null) => {
    if (actions.some((a) => a.id === id)) return;
    const base = ACTION_LIBRARY[id];
    if (base.transports && !base.transports.includes(transport)) return;
    actions.push({ ...base, problem });
  };

  const wifiBroken =
    problems.has("wifi_not_configured") ||
    problems.has("wifi_auth_failed") ||
    problems.has("wifi_network_not_found") ||
    (problems.has("wifi_not_connected") && !problems.has("internet_unreachable"));

  if (wifiBroken) {
    add("rewrite_wifi", problems.has("wifi_auth_failed") ? "wifi_auth_failed" : "wifi_not_configured");
  }
  if (problems.has("internet_unreachable") || problems.has("backend_unreachable")) {
    add("verify_network", problems.has("backend_unreachable") ? "backend_unreachable" : "internet_unreachable");
  }
  if (
    problems.has("pairing_missing") ||
    problems.has("pairing_invalid") ||
    problems.has("pairing_credentials_revoked")
  ) {
    if (input.allowRePair !== false) add("repair_pairing");
  }
  if (problems.has("mqtt_auth_failed") || problems.has("mqtt_disconnected")) {
    add("reconnect_mqtt");
  }
  if (problems.has("config_unsynced")) add("resync_config");
  if (problems.has("config_corrupt")) add("restore_config");
  if (problems.has("sensors_not_reporting") || problems.has("switches_not_reporting")) {
    add("recheck_entities");
  }

  // Re-pairing already rotates MQTT credentials and pulls the configuration
  // snapshot, so a separate MQTT reconnect or config resync would be a
  // redundant second operation on the same board.
  if (actions.some((a) => a.id === "repair_pairing")) {
    const redundant: RepairActionId[] = ["reconnect_mqtt", "resync_config"];
    for (let i = actions.length - 1; i >= 0; i--) {
      if (redundant.includes(actions[i].id)) actions.splice(i, 1);
    }
  }

  const requiresFirmwareWorkflow =
    problems.has("firmware_incompatible") ||
    problems.has("board_unsupported") ||
    problems.has("firmware_diagnostics_unsupported");

  // Repairing identity (re-pairing) is a deliberate decision, never automatic.
  const identityAction = actions.find((a) => a.changesIdentity) ?? null;

  const summary = actions.map((action) => ({
    problem: action.problem ? PROBLEM_LABELS[action.problem] : "Detected problem",
    action: action.description,
    verification: action.verification,
  }));

  if (actions.length === 0) {
    return {
      actions: [],
      requiresFirmwareWorkflow,
      requiresUserConsent: false,
      consentReason: null,
      summary: requiresFirmwareWorkflow
        ? [
            {
              problem: "Firmware does not match this board",
              action: "Recovery cannot change firmware. Use Flash Board to install the compatible image.",
              verification: "After flashing, run Recovery again to verify the environment.",
            },
          ]
        : [],
      noActionNeeded: !requiresFirmwareWorkflow,
    };
  }

  return {
    actions,
    requiresFirmwareWorkflow,
    requiresUserConsent: Boolean(identityAction),
    consentReason: identityAction
      ? "Re-pairing rotates the controller's MQTT credentials. Board ID, room, devices, sensors, switches and Nodes are preserved, but the controller reconnects with new credentials."
      : null,
    summary,
    noActionNeeded: false,
  };
}

// ---------------------------------------------------------------------------
// Stage 4 — Repair execution
// ---------------------------------------------------------------------------

export type RepairOutcomeStatus = "applied" | "skipped" | "failed" | "unknown";

export interface RepairOutcome {
  actionId: RepairActionId;
  status: RepairOutcomeStatus;
  /** Plain-language result. */
  message: string;
  technical?: string;
  at: string;
}

export interface RepairExecution {
  outcomes: RepairOutcome[];
  /** True when the transport could not execute anything (disconnected). */
  transportFailed: boolean;
}

/** The board is only "possibly repaired" once every action reports applied. */
export function repairExecutionSucceeded(execution: RepairExecution): boolean {
  if (execution.transportFailed) return false;
  if (execution.outcomes.length === 0) return false;
  return execution.outcomes.every((o) => o.status === "applied" || o.status === "skipped");
}

// ---------------------------------------------------------------------------
// Stage 5 — Verification
// ---------------------------------------------------------------------------

export type VerificationCheckId =
  | "board_reachable"
  | "wifi_connected"
  | "ip_assigned"
  | "backend_api"
  | "pairing_valid"
  | "mqtt_connected"
  | "subscribed"
  | "heartbeat_fresh"
  | "config_synced"
  | "entities_reporting";

export interface VerificationCheck {
  id: VerificationCheckId;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Verification the user asked for by running this repair. */
  required: boolean;
}

export interface VerificationInput {
  board: RecoveryBoardInfo;
  before: RecoveryTelemetry;
  after: RecoveryTelemetry;
  plan: RecoveryPlan;
  /** True when the transport confirmed it released the session cleanly. */
  transportReleased?: boolean;
}

export interface VerificationResult {
  checks: VerificationCheck[];
  status: "verified" | "partial" | "failed" | "unverified";
  /** Plain-language headline for the report. */
  summary: string;
  unresolved: ProblemCode[];
}

/**
 * Stage 5. Verification is computed from *post-repair* telemetry. `unknown` is
 * not success: a repair whose effect cannot be observed is "unverified".
 */
export function verifyRecovery(input: VerificationInput): VerificationResult {
  const { after, plan, board } = input;
  const actions = new Set(plan.actions.map((a) => a.id));
  const needsWifi = actions.has("rewrite_wifi") || actions.has("verify_network");
  const needsPairing = actions.has("repair_pairing");
  const needsMqtt = actions.has("reconnect_mqtt") || needsPairing;
  const needsConfig = actions.has("resync_config") || actions.has("restore_config") || needsPairing;
  const needsEntities = actions.has("recheck_entities");

  const checks: VerificationCheck[] = [];
  const push = (
    id: VerificationCheckId,
    label: string,
    status: CheckStatus,
    detail: string,
    required: boolean
  ) => checks.push({ id, label, status, detail, required });

  push(
    "board_reachable",
    "Controller is running and reachable",
    board.mode !== "unknown" ? "pass" : "unknown",
    board.mode !== "unknown" ? `Controller answered (${board.mode} mode).` : "The controller did not answer.",
    true
  );

  const conn = after.wifi;
  if (!conn.available) {
    push("wifi_connected", "Wi-Fi connected", "unknown", "Wi-Fi state is not reported.", needsWifi);
    push("ip_assigned", "IP address assigned", "unknown", "IP assignment is not reported.", needsWifi);
  } else {
    push(
      "wifi_connected",
      "Wi-Fi connected",
      conn.connected === true ? "pass" : conn.connected === false ? "fail" : "unknown",
      conn.connected === true
        ? `Joined "${conn.ssid ?? "Wi-Fi"}".`
        : conn.connected === false
          ? conn.lastError ?? "Not connected to Wi-Fi."
          : "Wi-Fi state unknown.",
      needsWifi
    );
    push(
      "ip_assigned",
      "IP address assigned",
      conn.ipAssigned === true ? "pass" : conn.ipAssigned === false ? "fail" : "unknown",
      conn.ipAssigned === true ? "The router assigned an IP address." : "No IP address reported.",
      needsWifi
    );
  }

  const api = after.backend;
  push(
    "backend_api",
    "HomecoreOS API reachable",
    api.reachable === true && api.authenticated !== false
      ? "pass"
      : api.reachable === false || api.authenticated === false
        ? "fail"
        : "unknown",
    api.reachable === true
      ? api.authenticated === false
        ? "The Worker rejected the device token."
        : "The controller reached the Worker."
      : api.reachable === false
        ? api.lastError ?? "The Worker is unreachable."
        : "Backend reachability is unknown.",
    true
  );

  const pairing = after.pairing;
  push(
    "pairing_valid",
    "Pairing / authentication valid",
    pairing.paired === true && pairing.credentialsValid !== false
      ? "pass"
      : pairing.paired === false || pairing.credentialsValid === false
        ? "fail"
        : "unknown",
    pairing.paired === true
      ? "The controller is paired."
      : pairing.paired === false
        ? "The controller is not paired."
        : "Pairing state is unknown.",
    needsPairing || needsMqtt
  );

  const mqtt = after.mqtt;
  push(
    "mqtt_connected",
    "MQTT connected",
    mqtt.connected === true && mqtt.authenticated !== false
      ? "pass"
      : mqtt.connected === false || mqtt.authenticated === false
        ? "fail"
        : "unknown",
    mqtt.connected === true
      ? "The controller is connected to the broker."
      : mqtt.authenticated === false
        ? mqtt.lastError ?? "The broker rejected the MQTT credentials."
        : mqtt.connected === false
          ? mqtt.lastError ?? "The controller is not connected to the broker."
          : "MQTT state is unknown.",
    needsMqtt
  );

  push(
    "subscribed",
    "Required subscriptions active",
    mqtt.connected === true && mqtt.authenticated !== false ? "pass" : "unknown",
    mqtt.connected === true
      ? "The controller's subscription topics are active."
      : "Subscriptions can only be confirmed while MQTT is connected.",
    false
  );

  const hb = after.heartbeat;
  const hbAge = ageSeconds(hb.lastHeartbeatAt, hb.nowMs);
  push(
    "heartbeat_fresh",
    "Heartbeat received",
    hb.available && hbAge !== null
      ? hbAge <= hb.staleAfterSeconds
        ? "pass"
        : "fail"
      : "unknown",
    hbAge !== null ? `Last heartbeat ${describeSeconds(hbAge)} ago.` : "No heartbeat recorded.",
    true
  );

  const cfg = after.config;
  const cfgSynced =
    cfg.available &&
    cfg.hashValid !== false &&
    (cfg.pendingSync === false || cfg.pendingSync === null) &&
    (cfg.revision === null || cfg.syncedRevision === null || cfg.revision <= cfg.syncedRevision);
  push(
    "config_synced",
    "Configuration synchronized",
    !cfg.available ? "unknown" : cfgSynced ? "pass" : cfg.hashValid === false ? "fail" : "fail",
    !cfg.available
      ? "Configuration state is not reported."
      : cfgSynced
        ? "The controller acknowledged the latest configuration."
        : "The controller has not acknowledged the latest configuration.",
    needsConfig
  );

  const ents = after.entities;
  const entitiesOk =
    ents.available &&
    (ents.sensorsTotal ?? 0) === (ents.sensorsReporting ?? 0) &&
    (ents.switchesTotal ?? 0) === (ents.switchesReporting ?? 0);
  push(
    "entities_reporting",
    "Sensors & switches reporting",
    !ents.available ? "unknown" : entitiesOk ? "pass" : "warning",
    !ents.available
      ? "Sensor and switch reporting is unavailable."
      : entitiesOk
        ? "All sensors and switches report."
        : "Some sensors or switches are still not reporting.",
    needsEntities
  );

  const required = checks.filter((c) => c.required);
  const requiredFail = required.filter((c) => c.status === "fail");
  const requiredUnknown = required.filter((c) => c.status === "unknown");
  const anyFail = checks.some((c) => c.status === "fail");

  let status: VerificationResult["status"];
  if (requiredFail.length > 0) status = "failed";
  else if (anyFail) status = "partial";
  else if (requiredUnknown.length > 0) status = "unverified";
  else status = "verified";

  const unresolved: ProblemCode[] = [];
  if (status !== "verified") {
    if (requiredFail.some((c) => c.id === "wifi_connected")) unresolved.push("wifi_not_connected");
    if (requiredFail.some((c) => c.id === "mqtt_connected")) unresolved.push("mqtt_disconnected");
    if (requiredFail.some((c) => c.id === "pairing_valid")) unresolved.push("pairing_invalid");
    if (requiredFail.some((c) => c.id === "backend_api")) unresolved.push("backend_unreachable");
    if (requiredFail.some((c) => c.id === "heartbeat_fresh")) unresolved.push("heartbeat_stale");
    if (requiredFail.some((c) => c.id === "config_synced")) unresolved.push("config_unsynced");
  }

  const summary =
    status === "verified"
      ? "Repair verified: the controller is online, authenticated and synchronized."
      : status === "failed"
        ? "Repair could not be verified: the controller still reports a failure."
        : status === "partial"
          ? "Repair partially verified: some checks still report problems."
          : "Repair sent, but its result could not be verified with fresh telemetry.";

  return { checks, status, summary, unresolved };
}

// ---------------------------------------------------------------------------
// Stage 6 — Report
// ---------------------------------------------------------------------------

export type RecoverySessionStatus = "active" | "completed" | "failed" | "unverified" | "expired" | "abandoned";

export interface RecoveryReport {
  sessionId: string;
  transport: RecoveryTransportKind;
  board: {
    boardInstanceId: string | null;
    name: string | null;
    boardSlug: string | null;
    hardwareUid: string | null;
    firmwareVersion: string | null;
  };
  startedAt: string;
  completedAt: string;
  durationMs: number;
  detectedProblems: ProblemCode[];
  diagnostics: DiagnosticCheck[];
  actions: RepairOutcome[];
  verification: VerificationResult;
  unresolvedProblems: ProblemCode[];
  finalStatus: RecoverySessionStatus;
  finalTelemetry: {
    connected: boolean | null;
    wifiSsid: string | null;
    wifiRssi: number | null;
    ipAssigned: boolean | null;
    mqttConnected: boolean | null;
    apiReachable: boolean | null;
    lastSyncAt: string | null;
    lastHeartbeatAt: string | null;
    firmwareVersion: string | null;
  };
  nextAction: string | null;
}

export function recommendNextAction(input: {
  plan: RecoveryPlan;
  verification: VerificationResult;
  report: Pick<RecoveryReport, "transport" | "detectedProblems">;
}): string | null {
  const { plan, verification } = input;
  if (verification.status === "verified") return null;
  if (plan.requiresFirmwareWorkflow) {
    return "Open Firmware & Updates → Flash Board and install the compatible HomecoreOS image for this board.";
  }
  if (verification.status === "unverified") {
    return "The controller did not report back in time. Keep it powered and connected, then run recovery again.";
  }
  const failing = verification.checks.filter((c) => c.status === "fail").map((c) => c.id);
  if (failing.includes("wifi_connected")) {
    return "Confirm the 2.4 GHz Wi-Fi name and password, then run recovery again. If it still fails, check the router's client limit or MAC filter.";
  }
  if (failing.includes("ip_assigned")) {
    return "The router is not handing out an address. Restart the router's DHCP service or reserve an address for the controller.";
  }
  if (failing.includes("mqtt_connected") || failing.includes("pairing_valid")) {
    return "Re-run recovery once the network is stable. If MQTT still fails, check that EMQX is reachable and the controller's credentials were not revoked.";
  }
  if (failing.includes("backend_api")) {
    return "The controller cannot reach HomecoreOS. Verify the Worker URL and that the network allows outbound HTTPS (443) and MQTT (8883).";
  }
  if (failing.includes("config_synced")) {
    return "Open the board in My Boards and save its configuration again to re-publish the snapshot, then re-run verification.";
  }
  return "Review the failed checks, fix the underlying network or configuration issue, then run recovery again.";
}

export function buildRecoveryReport(input: {
  sessionId: string;
  boardInstanceId: string | null;
  boardName: string | null;
  board: RecoveryBoardInfo;
  transport: RecoveryTransportKind;
  startedAt: string;
  completedAt: string;
  diagnostics: DiagnosticsResult;
  plan: RecoveryPlan;
  execution: RepairExecution;
  verification: VerificationResult;
  finalTelemetry: RecoveryTelemetry;
}): RecoveryReport {
  const started = Date.parse(input.startedAt);
  const completed = Date.parse(input.completedAt);
  const durationMs =
    Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : 0;

  const finalStatus: RecoverySessionStatus =
    input.verification.status === "verified"
      ? "completed"
      : input.verification.status === "unverified"
        ? "unverified"
        : "failed";

  const t = input.finalTelemetry;

  return {
    sessionId: input.sessionId,
    transport: input.transport,
    board: {
      boardInstanceId: input.boardInstanceId,
      name: input.boardName,
      boardSlug: input.board.boardSlug,
      hardwareUid: input.board.hardwareUid,
      firmwareVersion: t.firmware.version ?? input.board.firmwareVersion,
    },
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs,
    detectedProblems: input.diagnostics.problems,
    diagnostics: input.diagnostics.checks,
    actions: input.execution.outcomes,
    verification: input.verification,
    unresolvedProblems: Array.from(new Set([...input.verification.unresolved])),
    finalStatus,
    finalTelemetry: {
      connected: t.wifi.connected,
      wifiSsid: t.wifi.ssid,
      wifiRssi: t.wifi.rssi,
      ipAssigned: t.wifi.ipAssigned,
      mqttConnected: t.mqtt.connected,
      apiReachable: t.backend.reachable,
      lastSyncAt: t.heartbeat.lastSyncAt,
      lastHeartbeatAt: t.heartbeat.lastHeartbeatAt,
      firmwareVersion: t.firmware.version ?? input.board.firmwareVersion,
    },
    nextAction: recommendNextAction({
      plan: input.plan,
      verification: input.verification,
      report: { transport: input.transport, detectedProblems: input.diagnostics.problems },
    }),
  };
}

// ---------------------------------------------------------------------------
// Transport capability & progress
// ---------------------------------------------------------------------------

export interface RecoveryTransportCapability {
  transport: RecoveryTransportKind;
  label: string;
  /** Short sentence under the option title. */
  description: string;
  requirements: string[];
  /** False when this browser / board cannot use the transport. */
  available: boolean;
  /** Plain-language reason when unavailable (never a silent "unsupported"). */
  unavailableReason: string | null;
  /** True when the transport can rewrite Wi-Fi credentials without re-pairing. */
  supportsWifiRepair: boolean;
  /** True when the transport can re-pair an existing board with an account. */
  supportsRePair: boolean;
  /** True when the transport can read the board's own diagnostics. */
  supportsDiagnostics: boolean;
}

export function describeTransportCapability(params: {
  transport: RecoveryTransportKind;
  browserSupported: boolean;
  browserReason?: string | null;
  boardSupportsWifi: boolean;
  boardSupportsBle: boolean;
  boardFirmwareSupportsDiagnostics: boolean;
}): RecoveryTransportCapability {
  const { transport, browserSupported, boardSupportsWifi, boardSupportsBle } = params;

  if (transport === "wifi") {
    return {
      transport,
      label: "Repair / Recover with Wi-Fi",
      description: "Join the controller's temporary HomecoreOS-Setup network and repair it from its local page.",
      requirements: [
        "The controller is powered and within Wi-Fi range",
        "Hold BOOT for 3 seconds to open HomecoreOS-Setup-XXXX",
        "Works in any browser on this device",
      ],
      available: boardSupportsWifi,
      unavailableReason: boardSupportsWifi
        ? null
        : "This board has no integrated Wi-Fi radio, so it cannot open a setup network.",
      supportsWifiRepair: true,
      supportsRePair: true,
      supportsDiagnostics: true,
    };
  }

  if (transport === "ble") {
    return {
      transport,
      label: "Repair / Recover with BLE",
      description: "Talk to the controller over an encrypted Bluetooth LE session and repair it in place.",
      requirements: [
        "Chrome or Edge on desktop / Android",
        "Bluetooth enabled on this device",
        "Hold BOOT for 3 seconds to open BLE recovery",
      ],
      available: boardSupportsBle && browserSupported,
      unavailableReason: !boardSupportsBle
        ? "This board has no Bluetooth LE radio. Use Wi-Fi or USB recovery instead."
        : !browserSupported
          ? params.browserReason ?? "Web Bluetooth is not available in this browser."
          : null,
      supportsWifiRepair: true,
      supportsRePair: true,
      supportsDiagnostics: params.boardFirmwareSupportsDiagnostics,
    };
  }

  return {
    transport: "usb",
    label: "Repair / Recover with USB",
    description: "Repair the running controller over its USB serial console. Firmware is never written.",
    requirements: [
      "Desktop Chrome, Edge or Chromium",
      "A USB data cable (not charge-only)",
      "Hold BOOT for 3 seconds so the controller is in recovery mode",
    ],
    available: browserSupported,
    unavailableReason: browserSupported
      ? null
      : params.browserReason ?? "Web Serial is not available in this browser.",
    supportsWifiRepair: true,
    supportsRePair: true,
    supportsDiagnostics: params.boardFirmwareSupportsDiagnostics,
  };
}

export interface RecoveryStepDefinition {
  id: string;
  label: string;
  stage: RecoveryStage;
}

/** The same ordered progress for every transport. */
export function buildRecoverySteps(): RecoveryStepDefinition[] {
  return [
    { id: "detect", label: "Detect controller", stage: "discovery" },
    { id: "read", label: "Read board information", stage: "discovery" },
    { id: "wifi_check", label: "Check Wi-Fi connection", stage: "diagnostics" },
    { id: "backend_check", label: "Check backend connectivity", stage: "diagnostics" },
    { id: "plan", label: "Plan repairs", stage: "plan" },
    { id: "repair", label: "Apply repairs", stage: "repair" },
    { id: "verify", label: "Verify controller health", stage: "verification" },
    { id: "report", label: "Recovery report", stage: "report" },
  ];
}

// ---------------------------------------------------------------------------
// Session guards
// ---------------------------------------------------------------------------

export interface RecoverySessionGuardInput {
  boardInstanceId: string;
  userId: string;
  existing: Array<{
    id: string;
    boardInstanceId: string;
    userId: string;
    status: string;
    expiresAt: string;
  }> | null;
  nowMs?: number;
}

export type RecoverySessionGuardResult =
  | { allowed: true; resumeSessionId: string | null }
  | { allowed: false; reason: "concurrent_session"; sessionId: string; message: string };

/**
 * One active recovery per board. A stale/expired/abandoned row never blocks a
 * new attempt, and the same user re-entering the flow resumes their own
 * session instead of creating a duplicate.
 */
export function checkRecoverySessionGuard(
  input: RecoverySessionGuardInput
): RecoverySessionGuardResult {
  const now = input.nowMs ?? Date.now();
  const active = (input.existing ?? []).filter((s) => {
    if (s.boardInstanceId !== input.boardInstanceId) return false;
    if (s.status !== "active") return false;
    const expires = Date.parse(s.expiresAt);
    return Number.isFinite(expires) ? expires > now : false;
  });
  if (active.length === 0) return { allowed: true, resumeSessionId: null };
  const mine = active.find((s) => s.userId === input.userId);
  if (mine) return { allowed: true, resumeSessionId: mine.id };
  return {
    allowed: false,
    reason: "concurrent_session",
    sessionId: active[0].id,
    message:
      "Another administrator is already repairing this controller. Ask them to finish or wait for the recovery session to expire (15 minutes).",
  };
}

export function isRecoverySessionExpired(expiresAt: string, nowMs = Date.now()): boolean {
  const t = Date.parse(expiresAt);
  return !Number.isFinite(t) || t <= nowMs;
}

/** Redacts anything that must never reach a log, a report or the console. */
export function redactRecoveryText(input: string | null | undefined): string {
  const text = (input ?? "").trim();
  if (!text) return "";
  return text
    .replace(/("?(?:password|wifi_pass|mqtt_password|device_api_token|identity_key|setup_pin)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1«redacted»")
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi, "$1«redacted»")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, (m) => (m.length >= 48 ? "«redacted»" : m));
}
