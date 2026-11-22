/**
 * Unified Repair & Recovery — Worker side.
 *
 * The browser runs the shared engine (`@homecoreos/shared/recovery`) over the
 * transport it has (Wi-Fi setup AP, BLE, USB serial). The Worker does the three
 * things a browser cannot do honestly on its own:
 *
 *  1. Build *server-verified* telemetry. "Is the board really online?" is read
 *     from the database that the board itself writes to (heartbeats, telemetry,
 *     config ACKs, MQTT state), not from what a tab claims.
 *  2. Own the recovery session lifecycle: one active session per board,
 *     server-minted expiry, idempotent stage updates, and an append-only event
 *     log. Two browsers cannot repair the same board concurrently.
 *  3. Persist the final report (and expose it read-only to admins).
 *
 * Nothing here stores or returns a Wi-Fi password, pairing code, MQTT password
 * or device token. `redactRecoveryText()` is applied to every free-text field
 * before it is written.
 */
import {
  RECOVERY_SESSION_TTL_SEC,
  RECOVERY_STALE_HEARTBEAT_SEC,
  RECOVERY_STALE_SENSOR_SEC,
  checkRecoverySessionGuard,
  emptyRecoveryTelemetry,
  redactRecoveryText,
  runDiagnostics,
  buildRepairPlan,
  verifyRecovery,
  buildRecoveryReport,
  type DiagnosticCheck,
  type ProblemCode,
  type RecoveryBoardInfo,
  type RecoveryPlan,
  type RecoveryReport,
  type RecoverySessionStatus,
  type RecoveryStage,
  type RecoveryTelemetry,
  type RecoveryTransportKind,
  type RepairOutcome,
} from "@homecoreos/shared";
import type { DbClient } from "./db";

export const RECOVERY_TRANSPORTS: RecoveryTransportKind[] = ["wifi", "ble", "usb"];

const ACTIVE_STATUSES: RecoverySessionStatus[] = ["active"];

export interface RecoverySessionRow {
  id: string;
  account_id: string;
  board_instance_id: string | null;
  created_by: string | null;
  transport: RecoveryTransportKind;
  status: RecoverySessionStatus;
  stage: RecoveryStage;
  detected_problems: string[];
  diagnostics: DiagnosticCheck[];
  repair_plan: unknown;
  actions_attempted: RepairOutcome[];
  verification: unknown;
  report: RecoveryReport | null;
  unresolved_problems: string[];
  next_action: string | null;
  failure_reason: string | null;
  started_at: string;
  last_stage_at: string;
  completed_at: string | null;
  expires_at: string;
}

// ---------------------------------------------------------------------------
// Server-verified telemetry
// ---------------------------------------------------------------------------

export interface BuildTelemetryInput {
  db: DbClient;
  accountId: string;
  board: {
    id: string;
    status: string | null;
    pairing_status: string | null;
    wifi_connected: boolean | null;
    wifi_ssid: string | null;
    wifi_rssi: number | null;
    local_ip: string | null;
    mqtt_connected: boolean | null;
    last_heartbeat_at: string | null;
    last_communication_at: string | null;
    last_config_synced_at: string | null;
    firmware_version: string | null;
    config_revision: number | null;
    last_synced_config_revision: number | null;
    pending_config_sync: boolean | null;
    last_error: string | null;
    last_error_at: string | null;
    board_role: string | null;
  };
  firmwareCompatible?: boolean | null;
  firmwareUpdateAvailable?: string | null;
  /** Live probe result from this request (optional). */
  probe?: {
    backendReachable?: boolean | null;
    backendStatus?: number | null;
    backendAuthenticated?: boolean | null;
    pairingValid?: boolean | null;
  };
  mqttCredentialStatus?: string | null;
  nowMs?: number;
}

/**
 * Everything here comes from rows the controller wrote itself. A field the
 * database has no value for stays `available: false` — the engine then reports
 * Unknown instead of inventing a failure.
 */
export async function buildServerTelemetry(
  input: BuildTelemetryInput
): Promise<RecoveryTelemetry> {
  const nowMs = input.nowMs ?? Date.now();
  const { db, accountId, board } = input;
  const telemetry = emptyRecoveryTelemetry(nowMs);

  const heartbeatAge = (() => {
    if (!board.last_heartbeat_at && !board.last_communication_at) return null;
    const iso = board.last_heartbeat_at ?? board.last_communication_at!;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  })();
  const staleAfter = RECOVERY_STALE_HEARTBEAT_SEC;

  // The heartbeat row is only "current" when the board also says it is online.
  const heartbeatAvailable = heartbeatAge !== null;
  const recentlyCommunicating =
    heartbeatAge !== null && nowMs - heartbeatAge <= staleAfter * 1000;

  telemetry.heartbeat = {
    available: heartbeatAvailable,
    lastHeartbeatAt: board.last_heartbeat_at,
    lastSyncAt: board.last_config_synced_at,
    nowMs,
    staleAfterSeconds: staleAfter,
  };

  const wifiAvailable =
    board.wifi_connected !== null || board.wifi_ssid !== null || board.local_ip !== null;
  telemetry.wifi = {
    available: wifiAvailable,
    connected: board.wifi_connected ?? null,
    ssid: board.wifi_ssid ?? null,
    rssi: board.wifi_rssi ?? null,
    ipAssigned:
      board.local_ip && board.local_ip.trim() && board.local_ip !== "0.0.0.0"
        ? true
        : wifiAvailable && board.local_ip !== null
          ? false
          : null,
    lastError: board.last_error ?? null,
    credentialsRewritten: false,
  };

  // Backend reachability: the board proves it by writing heartbeats, and this
  // request can add a live probe from the Worker side.
  const probe = input.probe;
  const backendReachable =
    probe?.backendReachable !== undefined
      ? probe.backendReachable
      : heartbeatAvailable
        ? recentlyCommunicating
        : null;
  telemetry.backend = {
    available: backendReachable !== null || probe?.backendStatus !== undefined,
    reachable: backendReachable ?? null,
    authenticated: probe?.backendAuthenticated ?? null,
    status: probe?.backendStatus ?? null,
    lastError: recentlyCommunicating ? null : (board.last_error ?? null),
  };

  telemetry.internet = {
    available: telemetry.backend.reachable !== null || board.wifi_connected !== null,
    reachable:
      telemetry.backend.reachable === true
        ? true
        : board.wifi_connected === true && telemetry.backend.reachable === false
          ? false
          : null,
  };

  const paired = board.pairing_status === "paired";
  telemetry.pairing = {
    available: board.pairing_status !== null,
    paired: board.pairing_status !== null ? paired : null,
    credentialsValid:
      probe?.pairingValid ??
      (board.pairing_status === "revoked" ? false : board.pairing_status !== null ? paired && true : null),
  };

  const mqttAvailable = board.mqtt_connected !== null;
  const mqttCredRevoked = input.mqttCredentialStatus === "revoked";
  telemetry.mqtt = {
    available: mqttAvailable,
    connected: board.mqtt_connected ?? null,
    authenticated: mqttCredRevoked ? false : board.mqtt_connected === true ? true : null,
    lastError: mqttCredRevoked
      ? "MQTT credentials were revoked."
      : board.last_error?.toLowerCase().includes("mqtt")
        ? board.last_error
        : null,
  };

  telemetry.firmware = {
    available: board.firmware_version !== null || input.firmwareCompatible !== undefined,
    version: board.firmware_version,
    compatible: input.firmwareCompatible ?? null,
    updateAvailable: input.firmwareUpdateAvailable ?? null,
  };

  const configAvailable =
    board.config_revision !== null || board.pending_config_sync !== null;
  telemetry.config = {
    available: configAvailable,
    revision: board.config_revision,
    syncedRevision: board.last_synced_config_revision,
    pendingSync: board.pending_config_sync,
    hashValid:
      board.config_revision !== null && board.last_synced_config_revision !== null
        ? board.config_revision >= board.last_synced_config_revision
        : null,
  };

  // Entities: the account's real inventory for this board.
  const [sensorRes, switchRes, nodeRes] = await Promise.all([
    db
      .from("sensors")
      .select("id,last_reading_at,is_online")
      .eq("account_id", accountId)
      .eq("board_instance_id", board.id)
      .is("deleted_at", null),
    db
      .from("switches")
      .select("id,is_online")
      .eq("account_id", accountId)
      .eq("board_instance_id", board.id)
      .is("deleted_at", null),
    board.board_role === "node"
      ? Promise.resolve({ data: [] as unknown[] })
      : db
          .from("board_instances")
          .select("id,node_link_state")
          .eq("account_id", accountId)
          .eq("assigned_controller_id", board.id)
          .is("deleted_at", null),
  ]);

  const sensors = ((sensorRes.data ?? []) as Array<{
    last_reading_at: string | null;
    is_online: boolean | null;
  }>) ?? [];
  if (sensorRes.data !== undefined) {
    const nowRef = nowMs;
    const reporting = sensors.filter((s) => {
      if (s.is_online === false) return false;
      if (!s.last_reading_at) return false;
      const t = Date.parse(s.last_reading_at);
      return Number.isFinite(t) && nowRef - t <= RECOVERY_STALE_SENSOR_SEC * 1000;
    }).length;
    telemetry.entities = {
      ...telemetry.entities,
      sensorsTotal: sensors.length,
      sensorsReporting: reporting,
    };
  }
  const switches = ((switchRes.data ?? []) as Array<{ is_online: boolean | null }>) ?? [];
  if (switchRes.data !== undefined) {
    telemetry.entities = {
      ...telemetry.entities,
      available: true,
      switchesTotal: switches.length,
      switchesReporting: switches.filter((s) => s.is_online !== false).length,
    };
  }

  const nodes = ((nodeRes.data ?? []) as Array<{ node_link_state: string | null }>) ?? [];
  telemetry.nodes = {
    available: board.board_role !== "node",
    total: nodes.length,
    linked: nodes.filter((n) => n.node_link_state === "linked" || n.node_link_state === null).length,
  };

  // Recorded errors: one current row, plus the recent activity trail.
  const recentErrors: Array<{ message: string; at: string | null }> = [];
  if (board.last_error && board.last_error.trim()) {
    recentErrors.push({ message: redactRecoveryText(board.last_error), at: board.last_error_at });
  }
  telemetry.errors = { available: true, recent: recentErrors };

  return telemetry;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export interface CreateRecoverySessionInput {
  db: DbClient;
  accountId: string;
  boardInstanceId: string;
  userId: string;
  transport: RecoveryTransportKind;
  boardSlug?: string | null;
  chipVariant?: string | null;
  hardwareUidSuffix?: string | null;
  firmwareVersion?: string | null;
  pairingStatus?: string | null;
  nowMs?: number;
}

export type CreateRecoverySessionResult =
  | { ok: true; session: RecoverySessionRow; resumed: boolean }
  | { ok: false; status: number; error: string; sessionId?: string };

/**
 * Starts (or resumes) the one active session for a board. A session created by
 * the same user in the last few minutes is resumed instead of duplicated, so a
 * page reload does not fragment the history.
 */
export async function createRecoverySession(
  input: CreateRecoverySessionInput
): Promise<CreateRecoverySessionResult> {
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Expire anything that outlived its window, then look for a live session.
  await input.db
    .from("recovery_sessions")
    .update({ status: "expired", stage: "report", completed_at: nowIso })
    .eq("board_instance_id", input.boardInstanceId)
    .eq("status", "active")
    .lt("expires_at", nowIso);

  const { data: existingRows } = await input.db
    .from("recovery_sessions")
    .select("*")
    .eq("board_instance_id", input.boardInstanceId)
    .eq("status", "active")
    .order("started_at", { ascending: false });

  const guard = checkRecoverySessionGuard({
    boardInstanceId: input.boardInstanceId,
    userId: input.userId,
    existing: ((existingRows ?? []) as RecoverySessionRow[]).map((s) => ({
      id: s.id,
      boardInstanceId: s.board_instance_id ?? "",
      userId: s.created_by ?? "",
      status: s.status,
      expiresAt: s.expires_at,
    })),
    nowMs,
  });

  if (!guard.allowed) {
    return { ok: false, status: 409, error: guard.message, sessionId: guard.sessionId };
  }

  if (guard.resumeSessionId) {
    const resumed = ((existingRows ?? []) as RecoverySessionRow[]).find(
      (s) => s.id === guard.resumeSessionId
    );
    if (resumed) return { ok: true, session: resumed, resumed: true };
  }

  const expiresAt = new Date(nowMs + RECOVERY_SESSION_TTL_SEC * 1000).toISOString();
  const { data, error } = await input.db
    .from("recovery_sessions")
    .insert({
      account_id: input.accountId,
      board_instance_id: input.boardInstanceId,
      created_by: input.userId,
      transport: input.transport,
      status: "active",
      stage: "discovery",
      board_slug: input.boardSlug ?? null,
      chip_variant: input.chipVariant ?? null,
      hardware_uid_suffix: input.hardwareUidSuffix ?? null,
      firmware_version_before: input.firmwareVersion ?? null,
      pairing_status_before: input.pairingStatus ?? null,
      started_at: nowIso,
      last_stage_at: nowIso,
      expires_at: expiresAt,
    })
    .select("*")
    .single();

  if (error || !data) {
    // The partial unique index is the last line of defence against two
    // concurrent sessions created in the same millisecond.
    const duplicate = /duplicate|unique/i.test(error?.message ?? "");
    return {
      ok: false,
      status: duplicate ? 409 : 400,
      error: duplicate
        ? "A recovery session is already active for this controller."
        : (error?.message ?? "Could not start a recovery session."),
    };
  }

  await recordRecoveryEvent({
    db: input.db,
    sessionId: String((data as RecoverySessionRow).id),
    accountId: input.accountId,
    boardInstanceId: input.boardInstanceId,
    stage: "discovery",
    status: "started",
    step: "session_started",
    message: `Recovery started over ${input.transport.toUpperCase()}.`,
    detail: { transport: input.transport },
  });

  return { ok: true, session: data as RecoverySessionRow, resumed: false };
}

export async function recordRecoveryEvent(input: {
  db: DbClient;
  sessionId: string;
  accountId: string;
  boardInstanceId: string | null;
  stage: RecoveryStage;
  status: "started" | "progress" | "succeeded" | "failed" | "unknown" | "skipped";
  step?: string | null;
  message?: string | null;
  problemCodes?: ProblemCode[];
  detail?: Record<string, unknown>;
}): Promise<void> {
  await input.db.from("recovery_events").insert({
    session_id: input.sessionId,
    account_id: input.accountId,
    board_instance_id: input.boardInstanceId,
    stage: input.stage,
    status: input.status,
    step: input.step ?? null,
    message: input.message ? redactRecoveryText(input.message).slice(0, 600) : null,
    problem_codes: input.problemCodes ?? [],
    detail: input.detail ?? {},
  });
}

export async function closeRecoverySession(input: {
  db: DbClient;
  session: RecoverySessionRow;
  status: RecoverySessionStatus;
  stage?: RecoveryStage;
  report?: RecoveryReport | null;
  failureReason?: string | null;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  const report = input.report ?? null;
  await input.db
    .from("recovery_sessions")
    .update({
      status: input.status,
      stage: input.stage ?? "report",
      report: report ?? undefined,
      verification: report?.verification ?? undefined,
      unresolved_problems: report?.unresolvedProblems ?? [],
      detected_problems: report?.detectedProblems ?? [],
      diagnostics: report?.diagnostics ?? [],
      actions_attempted: report?.actions ?? [],
      next_action: report?.nextAction ?? null,
      firmware_version_after: report?.finalTelemetry.firmwareVersion ?? null,
      failure_reason: input.failureReason ? redactRecoveryText(input.failureReason) : null,
      last_stage_at: nowIso,
      completed_at: nowIso,
    })
    .eq("id", input.session.id);

  await recordRecoveryEvent({
    db: input.db,
    sessionId: input.session.id,
    accountId: input.session.account_id,
    boardInstanceId: input.session.board_instance_id,
    stage: "report",
    status:
      input.status === "completed"
        ? "succeeded"
        : input.status === "unverified"
          ? "unknown"
          : "failed",
    step: "session_closed",
    message: report?.verification.summary ?? input.failureReason ?? `Session ${input.status}.`,
    problemCodes: (report?.unresolvedProblems ?? []) as ProblemCode[],
  });
}

/** Reads the live session for a board so an interrupted flow can resume. */
export async function loadActiveRecoverySession(
  db: DbClient,
  accountId: string,
  boardInstanceId: string
): Promise<RecoverySessionRow | null> {
  const { data } = await db
    .from("recovery_sessions")
    .select("*")
    .eq("account_id", accountId)
    .eq("board_instance_id", boardInstanceId)
    .in("status", ACTIVE_STATUSES)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as RecoverySessionRow | null) ?? null;
}

/** A board's recovery history (read-only), newest first. */
export async function listRecoverySessions(
  db: DbClient,
  params: { accountId: string; boardInstanceId?: string | null; limit: number; offset: number }
): Promise<{ sessions: Array<Record<string, unknown>>; count: number }> {
  let query = db
    .from("recovery_sessions")
    .select(
      "id,board_instance_id,transport,status,stage,firmware_version_before,firmware_version_after,detected_problems,unresolved_problems,next_action,started_at,completed_at,created_by,board_slug,chip_variant",
      { count: "exact" }
    )
    .eq("account_id", params.accountId);
  if (params.boardInstanceId) {
    query = query.eq("board_instance_id", params.boardInstanceId);
  }
  const { data, count } = await query
    .order("started_at", { ascending: false })
    .range(params.offset, params.offset + params.limit - 1);
  return {
    sessions: ((data ?? []) as Array<Record<string, unknown>>) ?? [],
    count: count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Server-side evaluation (used to double-check a browser's claim)
// ---------------------------------------------------------------------------

export interface EvaluateRecoveryInput {
  board: RecoveryBoardInfo;
  telemetry: RecoveryTelemetry;
  transport: RecoveryTransportKind;
  wifiCredentialsProvided?: boolean;
  allowRePair?: boolean;
  /** Outcomes the transport reported (already executed). */
  outcomes?: RepairOutcome[];
}

export interface EvaluateRecoveryResult {
  diagnostics: ReturnType<typeof runDiagnostics>;
  plan: RecoveryPlan;
  verification: ReturnType<typeof verifyRecovery>;
}

/**
 * Replays the shared engine against server-verified telemetry. The console and
 * the Worker therefore cannot disagree about whether a repair worked.
 */
export function evaluateRecovery(
  input: EvaluateRecoveryInput
): EvaluateRecoveryResult {
  const diagnostics = runDiagnostics({
    board: input.board,
    telemetry: input.telemetry,
    transport: input.transport,
    wifiCredentialsProvided: input.wifiCredentialsProvided,
  });
  const plan = buildRepairPlan({
    board: input.board,
    diagnostics,
    transport: input.transport,
    allowRePair: input.allowRePair,
  });
  const verification = verifyRecovery({
    board: input.board,
    before: input.telemetry,
    after: input.telemetry,
    plan,
  });
  return { diagnostics, plan, verification };
}

export { buildRecoveryReport };
