/**
 * The Repair & Recovery flow driver.
 *
 * This is the *whole* recovery experience — discovery, diagnostics, plan,
 * execution, verification, report — written once and reused by Wi-Fi, BLE and
 * USB. A transport adapter only moves bytes; everything that decides what is
 * wrong, what to repair and whether the repair worked lives in the shared
 * engine (`@homecoreos/shared`), and this file sequences it.
 *
 * It is deliberately framework-free (no React, no DOM APIs beyond the injected
 * transports) so the same logic is exercised by the unit tests that cover the
 * hard cases: wrong Wi-Fi password, no internet, Worker down, MQTT down, invalid
 * pairing, a dropped BLE link, a yanked USB cable, an expired session and
 * repeated attempts.
 */
import {
  RECOVERY_MAX_ATTEMPTS,
  RECOVERY_OPERATION_TIMEOUT_MS,
  RECOVERY_SESSION_TTL_SEC,
  buildRecoverySteps,
  buildRepairPlan,
  buildRecoveryReport,
  describeTransportCapability,
  emptyRecoveryTelemetry,
  isRecoverySessionExpired,
  mergeRecoveryTelemetry,
  repairExecutionSucceeded,
  runDiagnostics,
  verifyRecovery,
  type DiagnosticCheck,
  type DiagnosticsResult,
  type ProblemCode,
  type RecoveryBoardInfo,
  type RecoveryPlan,
  type RecoveryReport,
  type RecoveryStage,
  type RecoveryStepDefinition,
  type RecoveryTelemetry,
  type RecoveryTransportKind,
  type RepairActionId,
  type RepairOutcome,
  type VerificationResult,
} from "@homecoreos/shared";
import {
  boardInfoFromHello,
  buildRecoveryCommand,
  telemetryFromDeviceStatus,
  type RecoveryDeviceStatus,
} from "@homecoreos/shared";
import {
  RecoveryTransportError,
  type RecoveryTransport,
  type RecoveryTransportAvailability,
} from "./recovery-transport";

// ---------------------------------------------------------------------------
// Server side (the authoritative record)
// ---------------------------------------------------------------------------

export interface RecoveryServerSessionSummary {
  id: string;
  status: string;
  stage: string;
  expiresAt: string;
  startedAt: string;
}

export interface RecoveryServerApi {
  startSession: (input: {
    boardInstanceId: string;
    transport: RecoveryTransportKind;
    boardSlug?: string | null;
    chipVariant?: string | null;
    hardwareUidSuffix?: string | null;
    firmwareVersion?: string | null;
  }) => Promise<{
    session: RecoveryServerSessionSummary;
    resumed: boolean;
    server: { diagnostics: DiagnosticsResult | null; plan: RecoveryPlan | null };
  }>;
  postDiagnostics: (
    sessionId: string,
    payload: {
      stage?: RecoveryStage;
      clientChecks: Array<{ id: string; status: string; problem: string | null; summary?: string }>;
      wifiCredentialsProvided?: boolean;
      allowRePair?: boolean;
      transportError?: string;
    }
  ) => Promise<{
    diagnostics: DiagnosticsResult;
    plan: RecoveryPlan;
  }>;
  complete: (
    sessionId: string,
    payload: {
      outcomes: Array<{ actionId: string; status: string; message: string; technical?: string }>;
      transportReleased: boolean;
      failureReason?: string;
    }
  ) => Promise<{
    report: RecoveryReport;
    session: RecoveryServerSessionSummary;
    cancelled?: "expired";
  }>;
  abandon: (sessionId: string, reason?: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type RecoveryFlowPhase =
  | "idle"
  | "identified"
  | "identifying"
  | "diagnostics"
  | "plan"
  | "awaiting_input"
  | "repairing"
  | "verifying"
  | "report"
  | "error";

export type RecoveryStepState = "pending" | "active" | "done" | "warning" | "error";

export interface RecoveryStepView extends RecoveryStepDefinition {
  state: RecoveryStepState;
  detail: string | null;
}

export interface RecoveryFlowInputs {
  /** Wi-Fi credentials supplied in this session (never persisted). */
  wifi?: { ssid: string; password: string };
  /** Single-use account recovery code, only for an explicit re-pair. */
  pairingCode?: string;
  /** The user explicitly consented to an identity-changing repair. */
  consentToRePair?: boolean;
}

/** Thrown when the plan needs something only the user can provide. */
export class RecoveryInputNeededError extends Error {
  readonly needed: "wifi_credentials" | "pairing_code" | "consent";

  constructor(needed: RecoveryInputNeededError["needed"], message: string) {
    super(message);
    this.name = "RecoveryInputNeededError";
    this.needed = needed;
  }
}

export interface RecoveryFlowState {
  phase: RecoveryFlowPhase;
  transport: RecoveryTransportKind | null;
  capability: ReturnType<typeof describeTransportCapability> | null;
  board: RecoveryBoardInfo;
  steps: RecoveryStepView[];
  boardStatus: RecoveryDeviceStatus | null;
  diagnostics: DiagnosticsResult | null;
  serverDiagnostics: DiagnosticsResult | null;
  plan: RecoveryPlan | null;
  outcomes: RepairOutcome[];
  verification: VerificationResult | null;
  report: RecoveryReport | null;
  /** Live line under the current step ("Applying repairs …"). */
  progress: string | null;
  error: { message: string; code: string; retryable: boolean } | null;
  /** Plain-language blocking input, when the flow waits for the user. */
  needs: { kind: RecoveryInputNeededError["needed"]; message: string } | null;
  sessionId: string | null;
  sessionExpiresAt: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Raw technical detail for the expandable panel (no secrets). */
  technical: string[];
}

const EMPTY_STATE: RecoveryFlowState = {
  phase: "idle",
  transport: null,
  capability: null,
  board: {
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
  },
  steps: buildRecoverySteps().map((s) => ({ ...s, state: "pending", detail: null })),
  boardStatus: null,
  diagnostics: null,
  serverDiagnostics: null,
  plan: null,
  outcomes: [],
  verification: null,
  report: null,
  progress: null,
  error: null,
  needs: null,
  sessionId: null,
  sessionExpiresAt: null,
  startedAt: null,
  finishedAt: null,
  technical: [],
};

export interface RecoveryControllerOptions {
  api: RecoveryServerApi;
  /** Builds a transport for the chosen method (already availability-checked). */
  createTransport: (kind: RecoveryTransportKind) => RecoveryTransport;
  /** Browser/board capability of each transport, for the method chooser. */
  capabilityFor: (kind: RecoveryTransportKind) => ReturnType<typeof describeTransportCapability>;
  boardInstanceId: string;
  expectedHardwareUid?: string | null;
  /** Board Library facts used to identify the controller. */
  boardFallbacks?: Partial<RecoveryBoardInfo>;
  now?: () => number;
  /** How long to wait for the board to come online after a repair. */
  verifyTimeoutMs?: number;
  verifyPollMs?: number;
}

export interface RecoveryController {
  getState: () => RecoveryFlowState;
  subscribe: (listener: (state: RecoveryFlowState) => void) => () => void;
  /** Step 1+2: connect over the chosen method and read the board's identity. */
  connect: (kind: RecoveryTransportKind) => Promise<void>;
  /**
   * Step 3: run diagnostics, open (or resume) the server session and show the
   * repair plan. Nothing is changed on the board yet.
   */
  diagnose: () => Promise<void>;
  /** Step 4+5+6: apply only the planned repairs, verify, then report. */
  repair: (inputs: RecoveryFlowInputs) => Promise<void>;
  /** Interrupts a live session without leaving a row blocking the board. */
  cancel: (reason?: string) => Promise<void>;
  /** Starts over from the method chooser (keeps nothing from the last attempt). */
  reset: () => void;
  /** Releases the transport, e.g. when the dialog closes. */
  dispose: () => Promise<void>;
}

const STEP_INDEX: Record<string, number> = {
  detect: 0,
  read: 1,
  wifi_check: 2,
  backend_check: 3,
  plan: 4,
  repair: 5,
  verify: 6,
  report: 7,
};

export function createRecoveryController(options: RecoveryControllerOptions): RecoveryController {
  const now = options.now ?? (() => Date.now());
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 60_000;
  const verifyPollMs = options.verifyPollMs ?? 3_000;

  let state: RecoveryFlowState = { ...EMPTY_STATE, steps: EMPTY_STATE.steps.map((s) => ({ ...s })) };
  const listeners = new Set<(s: RecoveryFlowState) => void>();
  let transport: RecoveryTransport | null = null;
  let busy = false;
  let cancelled = false;

  const emit = (patch: Partial<RecoveryFlowState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };

  const setStep = (id: string, stepState: RecoveryStepState, detail: string | null = null) => {
    const index = STEP_INDEX[id];
    if (index === undefined) return;
    const steps = state.steps.map((step, i) =>
      i === index ? { ...step, state: stepState, detail } : step
    );
    emit({ steps });
  };

  const setStepStage = (from: number, stepState: RecoveryStepState) => {
    const steps = state.steps.map((step, i) => (i === from ? { ...step, state: stepState } : step));
    emit({ steps });
  };

  const logTechnical = (line: string) => {
    emit({ technical: [...state.technical, line].slice(-80) });
  };

  const releaseTransport = async () => {
    if (!transport) return;
    const active = transport;
    transport = null;
    try {
      await active.release();
    } catch {
      // Releasing must never mask the real result.
    }
  };

  const fail = async (err: unknown, fallbackPhase: RecoveryFlowPhase = "error") => {
    const code = err instanceof RecoveryTransportError ? err.code : "recovery_failed";
    const message =
      err instanceof Error ? err.message : "Recovery could not complete. Try again.";
    const retryable = err instanceof RecoveryTransportError ? err.retryable : true;
    logTechnical(`${code}: ${message}`);
    emit({ phase: fallbackPhase, progress: null, error: { code, message, retryable } });
    // The transport may have died mid-operation; tell the server so the session
    // is recorded as failed instead of blocking the board for 15 minutes.
    if (state.sessionId) {
      try {
        await options.api.postDiagnostics(state.sessionId, {
          clientChecks: [],
          transportError: message,
        });
      } catch {
        // The session will expire on its own.
      }
    }
    await releaseTransport();
  };

  /** Which action needs which input, so the UI can ask before anything runs. */
  const requiredInputs = (plan: RecoveryPlan, inputs: RecoveryFlowInputs) => {
    const needs: Array<RecoveryInputNeededError> = [];
    for (const action of plan.actions) {
      if (action.requiresSecret === "wifi") {
        const ssid = inputs.wifi?.ssid?.trim();
        const password = inputs.wifi?.password ?? "";
        if (!ssid) {
          needs.push(
            new RecoveryInputNeededError(
              "wifi_credentials",
              "Enter the 2.4 GHz Wi-Fi name and password so the controller can rejoin."
            )
          );
        } else if (password.length > 0 && password.length < 8) {
          needs.push(
            new RecoveryInputNeededError(
              "wifi_credentials",
              "A Wi-Fi password must be 8–63 characters (leave it blank only for an open network)."
            )
          );
        }
      }
      if (action.requiresSecret === "recovery_code" && !/^\d{6}$/.test(inputs.pairingCode ?? "")) {
        needs.push(
          new RecoveryInputNeededError(
            "pairing_code",
            "Re-pairing needs a fresh 6-digit recovery code from My Boards → Repair / Recover."
          )
        );
      }
    }
    if (plan.requiresUserConsent && !inputs.consentToRePair && plan.actions.some((a) => a.changesIdentity)) {
      needs.push(
        new RecoveryInputNeededError(
          "consent",
          plan.consentReason ??
            "Re-pairing rotates the controller's MQTT credentials. Confirm to continue."
        )
      );
    }
    return needs;
  };

  const planSummary = (plan: RecoveryPlan) => {
    if (plan.actions.length === 0) return "No repair is needed.";
    return plan.actions.map((a) => a.title).join(" · ");
  };

  async function readFresh({
    attempts = RECOVERY_MAX_ATTEMPTS,
    base,
  }: {
    attempts?: number;
    base: RecoveryTelemetry;
  }): Promise<{ status: RecoveryDeviceStatus; telemetry: RecoveryTelemetry }> {
    if (!transport) {
      throw new RecoveryTransportError(
        "not_connected",
        "The connection to the controller is closed. Reconnect and try again."
      );
    }
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const status = await transport.readStatus();
        return { status, telemetry: telemetryFromDeviceStatus(status, now(), base) };
      } catch (err) {
        lastError = err;
        if (attempt < attempts) {
          // Bounded retry with a short pause: a single dropped BLE notification
          // is not a failed repair.
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new RecoveryTransportError("no_status", "The controller did not report its status.");
  }

  async function executeAction(
    actionId: RepairActionId,
    inputs: RecoveryFlowInputs
  ): Promise<RepairOutcome> {
    const at = new Date(now()).toISOString();
    if (!transport) {
      return {
        actionId,
        status: "failed",
        message: "The connection to the controller was closed before this repair ran.",
        at,
      };
    }

    if (actionId === "none" || actionId === "verify_network" || actionId === "recheck_entities") {
      // Diagnostic-only steps: they read state, they never change the board.
      try {
        await transport.request(buildRecoveryCommand("STATUS"), {
          timeoutMs: RECOVERY_OPERATION_TIMEOUT_MS,
        });
        return {
          actionId,
          status: "applied",
          message:
            actionId === "verify_network"
              ? "Re-checked the network path from the controller."
              : actionId === "recheck_entities"
                ? "Asked the controller to report its sensors and switches again."
                : "Nothing to change.",
          at,
        };
      } catch (err) {
        return {
          actionId,
          status: "failed",
          message: err instanceof Error ? err.message : "The controller did not answer.",
          at,
        };
      }
    }

    const request: Parameters<typeof buildRecoveryCommand>[1] =
      actionId === "rewrite_wifi"
        ? { action: "wifi", ssid: inputs.wifi?.ssid, password: inputs.wifi?.password }
        : actionId === "reconnect_mqtt"
          ? { action: "mqtt" }
          : actionId === "repair_pairing"
            ? { action: "pair", pairCode: inputs.pairingCode }
            : actionId === "resync_config" || actionId === "restore_config"
              ? { action: "config" }
              : { action: "config" };

    // A command is sent exactly once: a lost acknowledgement is not proof
    // that a mutation failed to execute. Retrying requires a fresh diagnosis.
    try {
      const raw = await transport.request(buildRecoveryCommand("REPAIR", request), {
        timeoutMs: RECOVERY_OPERATION_TIMEOUT_MS,
      });
      const parsed = JSON.parse(raw) as {
        hc?: string; ok?: boolean; detail?: string; code?: string; message?: string;
      };
      if (parsed.hc === "ack" && parsed.ok !== false) {
        return { actionId, status: "applied", message: parsed.detail ?? "The controller accepted the repair.", at: new Date(now()).toISOString() };
      }
      return {
        actionId, status: "failed",
        message: parsed.message ?? parsed.detail ?? "The controller refused this repair.",
        technical: parsed.code, at: new Date(now()).toISOString(),
      };
    } catch (err) {
      return {
        actionId, status: "failed",
        message: err instanceof Error ? err.message : "The controller did not answer.",
        at: new Date(now()).toISOString(),
      };
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async connect(kind) {
      if (busy) return;
      cancelled = false;
      busy = true;
      const capability = options.capabilityFor(kind);
      emit({
        ...EMPTY_STATE,
        steps: EMPTY_STATE.steps.map((s) => ({ ...s })),
        transport: kind,
        capability,
        phase: "identifying",
        startedAt: now(),
      });

      if (!capability.available) {
        emit({
          phase: "error",
          error: {
            code: "transport_unavailable",
            message: capability.unavailableReason ?? "This method is not available here.",
            retryable: false,
          },
        });
        busy = false;
        return;
      }

      try {
        setStepStage(0, "active");
        const candidate = options.createTransport(kind);
        transport = candidate;
        const { hello, status } = await candidate.connect({
          onDisconnected: (error) => { cancelled = true; void fail(error); },
          onProgress: (message) => {
            emit({ progress: message });
            logTechnical(message);
          },
        });

        if (cancelled) { await candidate.release(); return; }
        const expectedSuffix = options.expectedHardwareUid?.replace(/[^a-f0-9]/gi, "").slice(-4).toUpperCase();
        if (expectedSuffix && hello.uidSuffix?.toUpperCase() !== expectedSuffix) {
          throw new RecoveryTransportError("identity_mismatch", "The connected board does not match the selected controller. No repair was performed.", false);
        }
        const board = boardInfoFromHello(hello, options.boardFallbacks ?? {});
        emit({ board, boardStatus: status });
        setStep("detect", "done", `${capability.label.split("·")[0]?.trim() ?? kind} connected.`);
        setStep("read", "done", `${board.model ?? board.boardSlug ?? "Controller"} · firmware v${board.firmwareVersion ?? "unknown"}`);
        emit({ phase: "identified", progress: "Controller identified." });

        if (board.capabilityIssues.length > 0) {
          // Capability problems are real findings, not transport failures.
          setStep("read", "warning", board.capabilityIssues[0]);
        }
      } catch (err) {
        setStepStage(0, "error");
        await fail(err);
      } finally {
        busy = false;
      }
    },

    async diagnose() {
      if (busy || !transport) return;
      busy = true;
      const base = state.boardStatus ? telemetryFromDeviceStatus(state.boardStatus, now()) : emptyRecoveryTelemetry(now());
      try {
        emit({ phase: "diagnostics", progress: "Reading the controller's diagnostics …", error: null });

        // --- discovery facts from the board (already read while connecting) --
        const deviceTelemetry = state.boardStatus
          ? telemetryFromDeviceStatus(state.boardStatus, now())
          : base;

        // --- the server's own view: internet path, entity counts, heartbeat --
        let serverDiagnostics: DiagnosticsResult | null = null;
        try {
          const started = await options.api.startSession({
            boardInstanceId: options.boardInstanceId,
            transport: state.transport!,
            boardSlug: state.board.boardSlug,
            chipVariant: state.board.chip,
            hardwareUidSuffix: state.board.hardwareUid,
            firmwareVersion: state.board.firmwareVersion,
          });
          if (cancelled) { await options.api.abandon(started.session.id, "Recovery cancelled during connection."); return; }
          serverDiagnostics = started.server.diagnostics;
          emit({
            sessionId: started.session.id,
            sessionExpiresAt: started.session.expiresAt,
            serverDiagnostics,
          });
          logTechnical(
            `Server session ${started.session.id} (${started.resumed ? "resumed" : "new"}), expires ${started.session.expiresAt}.`
          );
        } catch (err) {
          // Authorization, identity and concurrency refusals must never fall
          // through to offline repair. Only an unavailable server may do so.
          const status = (err as { status?: number })?.status;
          if (status && status >= 400 && status < 500) throw err;
          // The local diagnosis still works without the server; it just cannot
          // be recorded, which the report says explicitly.
          logTechnical(
            `Server session unavailable: ${err instanceof Error ? err.message : "unknown error"}`
          );
        }

        if (cancelled) return;
        setStepStage(2, "active");
        const clientDiagnostics = runDiagnostics({
          board: state.board,
          telemetry: deviceTelemetry,
          transport: state.transport!,
          wifiCredentialsProvided: Boolean(state.plan?.actions.some((a) => a.requiresSecret === "wifi")),
        });
        setStep("wifi_check", clientDiagnostics.problems.some((p) => p.startsWith("wifi")) ? "warning" : "done", clientDiagnostics.checks.find((c) => c.id === "wifi_connection")?.summary ?? null);
        setStepStage(3, "active");
        setStep(
          "backend_check",
          deviceTelemetry.backend.reachable === false ? "warning" : "done",
          clientDiagnostics.checks.find((c) => c.id === "backend")?.summary ?? null
        );

        // Server checks win where they know something the device does not
        // (internet reachability, entity counts); unknowns stay unknown.
        const diagnostics: DiagnosticsResult = serverDiagnostics
          ? {
              ...clientDiagnostics,
              checks: mergeChecks(clientDiagnostics.checks, serverDiagnostics.checks),
              problems: Array.from(
                new Set<ProblemCode>([...clientDiagnostics.problems, ...serverDiagnostics.problems])
              ),
              status: serverDiagnostics.status === "healthy" ? clientDiagnostics.status : serverDiagnostics.status,
              hasUnknowns: clientDiagnostics.hasUnknowns || serverDiagnostics.hasUnknowns,
            }
          : clientDiagnostics;

        const plan = buildRepairPlan({
          board: state.board,
          diagnostics,
          transport: state.transport!,
          allowRePair: true,
        });

        setStepStage(4, "active");
        setStep("plan", "done", planSummary(plan));
        emit({
          diagnostics,
          plan,
          phase: "plan",
          progress: null,
        });

        if (state.sessionId) {
          try {
            await options.api.postDiagnostics(state.sessionId, {
              stage: "plan",
              clientChecks: clientDiagnostics.checks.map((c) => ({
                id: c.id,
                status: c.status,
                problem: c.problem,
                summary: c.summary,
              })),
            });
          } catch (err) {
            logTechnical(
              `Diagnostics were not recorded: ${err instanceof Error ? err.message : "unknown error"}`
            );
          }
        }
      } catch (err) {
        await fail(err, "error");
      } finally {
        busy = false;
      }
    },

    async repair(inputs) {
      if (busy || !transport) return;
      const plan = state.plan;
      if (!plan || cancelled || state.phase === "error" || plan.requiresFirmwareWorkflow) return;
      if (isRecoveryFlowExpired(state.sessionExpiresAt, now())) {
        await fail(new RecoveryTransportError("session_expired", "This recovery session expired. Reconnect and run diagnostics before repairing.", false));
        return;
      }
      if (plan.actions.some((a) => a.changesIdentity) && !state.sessionId) {
        await fail(new RecoveryTransportError("authorization_required", "Account recovery requires a live authorized server session. Reconnect to HomecoreOS and try again.", false));
        return;
      }

      const blocking = requiredInputs(plan, inputs)[0];
      if (blocking) {
        emit({
          phase: "awaiting_input",
          needs: { kind: blocking.needed, message: blocking.message },
        });
        return;
      }

      busy = true;
      const beforeTelemetry = state.boardStatus
        ? telemetryFromDeviceStatus(state.boardStatus, now())
        : emptyRecoveryTelemetry(now());
      const outcomes: RepairOutcome[] = [];
      emit({
        phase: "repairing",
        needs: null,
        error: null,
        outcomes: [],
        progress:
          plan.actions.length === 0
            ? "Nothing to change — verifying the controller."
            : plan.actions[0].title,
      });

      try {
        setStepStage(5, "active");
        for (const action of plan.actions) {
          if (cancelled) return;
          if (action.id === "none") continue;
          emit({ progress: `${action.title} …` });
          // Saving credentials only acknowledges NVS. Wait for the station to
          // obtain an address before dependent HTTP/pairing/MQTT operations.
          if (action.id !== "rewrite_wifi" && outcomes.some((o) => o.actionId === "rewrite_wifi" && o.status === "applied")) {
            const networkDeadline = now() + Math.min(30_000, verifyTimeoutMs);
            let networkReady = false;
            do {
              if (cancelled) return;
              try {
                const fresh = await readFresh({ attempts: 1, base: beforeTelemetry });
                emit({ boardStatus: fresh.status, progress: "Waiting for Wi-Fi and an IP address before the next repair …" });
                networkReady = fresh.status.wifiConnected === true && Boolean(fresh.status.ip);
              } catch { /* Unknown is not ready; the deadline bounds the wait. */ }
              if (!networkReady && now() < networkDeadline) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, verifyPollMs)));
            } while (!networkReady && now() < networkDeadline);
            if (!networkReady) {
              outcomes.push({ actionId: action.id, status: "failed", message: "Wi-Fi credentials were saved, but the controller has not obtained an IP address. Dependent repair was not sent.", at: new Date(now()).toISOString() });
              emit({ outcomes: [...outcomes] });
              break;
            }
          }
          const outcome = await executeAction(action.id, inputs);
          outcomes.push(outcome);
          emit({ outcomes: [...outcomes] });
          if (outcome.status === "failed") {
            setStep("repair", "error", outcome.message);
            logTechnical(`${action.id}: ${outcome.message}`);
            // Stop: a later repair that depends on this one cannot succeed, and
            // repeating commands on a board that just refused one is unsafe.
            break;
          }
          logTechnical(`${action.id}: ${outcome.message}`);
        }
        if (cancelled) return;
        const repairOk = repairExecutionSucceeded({ outcomes, transportFailed: false });
        setStep(
          "repair",
          repairOk ? "done" : "warning",
          repairOk ? "All planned repairs were applied." : "Some repairs were not applied."
        );

        // --- verification: only fresh telemetry counts ----------------------
        emit({ phase: "verifying", progress: "Waiting for the controller to report back …" });
        setStepStage(6, "active");
        const deadline = now() + verifyTimeoutMs;
        let after = emptyRecoveryTelemetry(now());
        let verification: VerificationResult | null = null;

        if (plan.actions.length === 0) {
          // Nothing changed, so there is nothing to wait for.
          try {
            const fresh = await readFresh({ base: beforeTelemetry });
            after = mergeRecoveryTelemetry(beforeTelemetry, fresh.telemetry);
          } catch (err) {
            logTechnical(
              `Verification read failed: ${err instanceof Error ? err.message : "unknown"}`
            );
          }
        } else {
          while (now() <= deadline) {
            if (cancelled) return;
            try {
              const fresh = await readFresh({ base: beforeTelemetry });
              after = mergeRecoveryTelemetry(beforeTelemetry, fresh.telemetry);
              verification = verifyRecovery({
                board: state.board,
                before: beforeTelemetry,
                after,
                plan,
              });
              if (verification.status === "verified") break;
            } catch (err) {
              logTechnical(
                `Verification read failed: ${err instanceof Error ? err.message : "unknown"}`
              );
            }
            await new Promise((resolve) => setTimeout(resolve, verifyPollMs));
          }
        }

        if (cancelled) return;
        verification =
          verification ?? verifyRecovery({ board: state.board, before: beforeTelemetry, after, plan });
        emit({ verification });
        setStep(
          "verify",
          verification.status === "verified"
            ? "done"
            : verification.status === "unverified"
              ? "warning"
              : "error",
          verification.summary
        );
        emit({ progress: verification.summary });

        const transportReleased = await releaseAfterRepair();
        const finishedAt = new Date(now()).toISOString();

        // --- report --------------------------------------------------------
        let report: RecoveryReport | null = null;
        if (state.sessionId) {
          try {
            const closed = await options.api.complete(state.sessionId, {
              outcomes: outcomes.map((o) => ({
                actionId: o.actionId,
                status: o.status,
                message: o.message,
                technical: o.technical,
              })),
              transportReleased,
            });
            // The server's verification is authoritative: a browser cannot
            // declare a recovery successful on its own.
            report = closed.report;
          } catch (err) {
            logTechnical(
              `The server could not record the report: ${
                err instanceof Error ? err.message : "unknown error"
              }`
            );
          }
        }

        // The server's verdict is authoritative for the record, but a console
        // that can see the controller failing must never display success. The
        // stricter of the two verdicts wins.
        if (report) {
          const stricter = stricterVerification(verification, report.verification);
          if (stricter !== report.verification) {
            logTechnical(
              "The controller still reports a problem on this connection; the recovery is shown as not verified."
            );
          }
          report = {
            ...report,
            verification: stricter,
            finalStatus:
              stricter.status === "verified"
                ? report.finalStatus
                : stricter.status === "unverified"
                  ? report.finalStatus === "completed"
                    ? "unverified"
                    : report.finalStatus
                  : "failed",
            nextAction:
              stricter.status === "verified"
                ? report.nextAction
                : report.nextAction ??
                  "The controller still reports a problem. Review the failed checks and run recovery again.",
          };
        }

        if (!report) {
          report = buildRecoveryReport({
            sessionId: "local",
            boardInstanceId: options.boardInstanceId,
            boardName: null,
            board: state.board,
            transport: state.transport!,
            startedAt: new Date(state.startedAt ?? now()).toISOString(),
            completedAt: finishedAt,
            diagnostics: state.diagnostics ?? {
              checks: [],
              problems: [],
              status: "unknown",
              hasUnknowns: true,
            },
            plan,
            execution: { outcomes, transportFailed: false },
            verification,
            finalTelemetry: after,
          });
        }

        setStep(
          "report",
          report.finalStatus === "completed"
            ? "done"
            : report.finalStatus === "unverified"
              ? "warning"
              : "error",
          report.finalStatus === "completed"
            ? "Recovery verified."
            : report.nextAction ?? "The controller still reports a problem."
        );
        emit({
          phase: "report",
          report,
          verification: report.verification,
          finishedAt: now(),
          progress: null,
        });
      } catch (err) {
        setStepStage(6, "error");
        await fail(err, "error");
      } finally {
        busy = false;
      }
    },

    async cancel(reason = "The user stopped the recovery.") {
      cancelled = true;
      if (state.sessionId) {
        try {
          await options.api.abandon(state.sessionId, reason);
        } catch {
          // Session expiry is the fallback.
        }
      }
      await releaseTransport();
      emit({ phase: "idle", progress: null, sessionId: null });
    },

    reset() {
      emit({
        ...EMPTY_STATE,
        steps: EMPTY_STATE.steps.map((s) => ({ ...s })),
      });
    },

    async dispose() {
      await releaseTransport();
    },
  };

  /** Releases the board after a repair, and says honestly whether it did. */
  async function releaseAfterRepair(): Promise<boolean> {
    if (!transport) return true;
    try {
      await transport.release();
      transport = null;
      return true;
    } catch {
      return false;
    }
  }
}

const VERIFICATION_RANK: Record<VerificationResult["status"], number> = {
  verified: 0,
  unverified: 1,
  partial: 2,
  failed: 3,
};

/** Whichever verdict is worse wins: the console never upgrades a failure. */
export function stricterVerification(
  a: VerificationResult,
  b: VerificationResult
): VerificationResult {
  return VERIFICATION_RANK[a.status] >= VERIFICATION_RANK[b.status] ? a : b;
}

/** Server checks replace client checks only when they carry fresher facts. */
function mergeChecks(client: DiagnosticCheck[], server: DiagnosticCheck[]): DiagnosticCheck[] {
  const byId = new Map<string, DiagnosticCheck>();
  for (const check of client) byId.set(check.id, check);
  for (const check of server) {
    const existing = byId.get(check.id);
    if (!existing) {
      byId.set(check.id, check);
      continue;
    }
    // Keep the device's own view when it could see the fact, unless the server
    // has a definite failure (the server sees the cloud path end to end).
    if (existing.status === "unknown" || check.status === "fail" || check.status === "warning") {
      byId.set(check.id, check);
    }
  }
  return Array.from(byId.values());
}

/** True when the recovery session has run out of time (15 minutes by default). */
export function isRecoveryFlowExpired(expiresAt: string | null, nowMs = Date.now()): boolean {
  if (!expiresAt) return false;
  return isRecoverySessionExpired(expiresAt, nowMs);
}

export const RECOVERY_FLOW_TTL_SEC = RECOVERY_SESSION_TTL_SEC;

/** Plain-language "problem / action / verification" rows for the plan screen. */
export function planRows(plan: RecoveryPlan | null) {
  if (!plan) return [];
  return plan.summary;
}

export type { RecoveryTransportAvailability };
