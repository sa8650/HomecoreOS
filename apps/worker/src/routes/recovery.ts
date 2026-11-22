/**
 * Unified Repair & Recovery API.
 *
 * The browser owns the transport (Wi-Fi setup AP, BLE GATT, USB serial) and runs
 * the shared engine. These routes are the authoritative record and the server
 * side of the same engine:
 *
 *   POST /api/recovery/sessions              start (or resume) a session
 *   GET  /api/recovery/sessions/:id          session + events + server verdict
 *   POST /api/recovery/sessions/:id/diagnostics   store a diagnosis (idempotent)
 *   POST /api/recovery/sessions/:id/complete      close with a verified report
 *   POST /api/recovery/sessions/:id/abandon       close without a repair
 *   GET  /api/recovery/history               this account's recovery history
 *
 * Security: staff-only, always scoped by `account_id`, one active session per
 * board (DB-enforced), server-minted 15-minute expiry, and no secret ever stored
 * or returned. A browser cannot mark a session successful on its own: the
 * session is closed as `completed` only when the *server-verified* telemetry
 * passes the shared verification stage.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  RECOVERY_TRANSPORTS,
  buildRecoveryReport,
  buildServerTelemetry,
  closeRecoverySession,
  createRecoverySession,
  evaluateRecovery,
  listRecoverySessions,
  loadActiveRecoverySession,
  recordRecoveryEvent,
  type RecoverySessionRow,
} from "../lib/recovery";
import {
  EMPTY_BOARD_INFO,
  redactRecoveryText,
  type ProblemCode,
  type RecoveryBoardInfo,
  type RecoveryTransportKind,
  type RepairOutcome,
} from "@homecoreos/shared";
import { recordActivity } from "../lib/audit";
import { resolveControllerCompatBoard } from "../lib/firmware-compatibility";
import { requireStaffRole, requireUserSession } from "../middleware/auth";
import type { AppEnv } from "../types/context";
import type { DbClient } from "../lib/db";

const transportSchema = z.enum(["wifi", "ble", "usb"]);

const startSchema = z.object({
  boardInstanceId: z.string().uuid(),
  transport: transportSchema,
  boardSlug: z.string().trim().max(120).optional(),
  chipVariant: z.string().trim().max(64).optional(),
  hardwareUidSuffix: z.string().trim().max(16).optional(),
  firmwareVersion: z.string().trim().max(64).optional(),
});

const diagnosticsSchema = z.object({
  transport: transportSchema.optional(),
  stage: z
    .enum(["discovery", "diagnostics", "plan", "repair", "verification", "report"])
    .optional(),
  wifiCredentialsProvided: z.boolean().optional(),
  allowRePair: z.boolean().optional(),
  /** Checks the transport observed (ids + statuses only; never payloads). */
  clientChecks: z
    .array(
      z.object({
        id: z.string().max(40),
        status: z.enum(["pass", "warning", "fail", "unknown"]),
        problem: z.string().max(60).nullable().optional(),
        summary: z.string().max(300).optional(),
      })
    )
    .max(40)
    .optional(),
  /** The board went quiet after this stage (drives failure reporting). */
  transportError: z.string().max(300).optional(),
});

const completeSchema = z.object({
  outcomes: z
    .array(
      z.object({
        actionId: z.string().max(40),
        status: z.enum(["applied", "skipped", "failed", "unknown"]),
        message: z.string().max(300),
        technical: z.string().max(600).optional(),
      })
    )
    .max(12)
    .optional(),
  transportReleased: z.boolean().optional(),
  failureReason: z.string().max(300).optional(),
});

const abandonSchema = z.object({
  reason: z.string().max(300).optional(),
});

interface BoardRowForRecovery {
  id: string;
  account_id: string;
  home_id: string;
  name: string;
  board_profile_id: string | null;
  custom_board_profile_id: string | null;
  board_model: string;
  chip_variant: string;
  hardware_uid: string | null;
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
  reported_board_slug: string | null;
  installed_firmware_release_id: string | null;
}

async function loadBoard(
  db: DbClient,
  accountId: string,
  boardInstanceId: string
): Promise<BoardRowForRecovery | null> {
  const { data } = await db
    .from("board_instances")
    .select(
      "id,account_id,home_id,name,board_profile_id,custom_board_profile_id,board_model,chip_variant,hardware_uid,status,pairing_status,wifi_connected,wifi_ssid,wifi_rssi,local_ip,mqtt_connected,last_heartbeat_at,last_communication_at,last_config_synced_at,firmware_version,config_revision,last_synced_config_revision,pending_config_sync,last_error,last_error_at,board_role,reported_board_slug,installed_firmware_release_id"
    )
    .eq("id", boardInstanceId)
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as BoardRowForRecovery | null) ?? null;
}

async function loadSession(
  db: DbClient,
  accountId: string,
  sessionId: string
): Promise<RecoverySessionRow | null> {
  const { data } = await db
    .from("recovery_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("account_id", accountId)
    .maybeSingle();
  return (data as RecoverySessionRow | null) ?? null;
}

function sessionExpired(session: RecoverySessionRow, nowMs = Date.now()): boolean {
  const expires = Date.parse(session.expires_at);
  if (!Number.isFinite(expires)) return true;
  return expires <= nowMs;
}

function publicSession(session: RecoverySessionRow) {
  return {
    id: session.id,
    boardInstanceId: session.board_instance_id,
    transport: session.transport,
    status: session.status,
    stage: session.stage,
    detectedProblems: session.detected_problems ?? [],
    unresolvedProblems: session.unresolved_problems ?? [],
    nextAction: session.next_action,
    failureReason: session.failure_reason,
    startedAt: session.started_at,
    lastStageAt: session.last_stage_at,
    completedAt: session.completed_at,
    expiresAt: session.expires_at,
    diagnostics: session.diagnostics ?? [],
    report: session.report,
    verification: session.verification,
    actions: session.actions_attempted ?? [],
  };
}

/** The server's own view of the board, used to verify any claim. */
async function serverVerdict(
  db: DbClient,
  board: BoardRowForRecovery,
  transport: RecoveryTransportKind,
  options: { allowRePair?: boolean; wifiCredentialsProvided?: boolean } = {}
) {
  const compatBoard = await resolveControllerCompatBoard(db, {
    board_profile_id: board.board_profile_id,
    custom_board_profile_id: board.custom_board_profile_id,
  });

  const telemetry = await buildServerTelemetry({
    db,
    accountId: board.account_id,
    board: {
      id: board.id,
      status: board.status,
      pairing_status: board.pairing_status,
      wifi_connected: board.wifi_connected,
      wifi_ssid: board.wifi_ssid,
      wifi_rssi: board.wifi_rssi,
      local_ip: board.local_ip,
      mqtt_connected: board.mqtt_connected,
      last_heartbeat_at: board.last_heartbeat_at,
      last_communication_at: board.last_communication_at,
      last_config_synced_at: board.last_config_synced_at,
      firmware_version: board.firmware_version,
      config_revision: board.config_revision,
      last_synced_config_revision: board.last_synced_config_revision,
      pending_config_sync: board.pending_config_sync,
      last_error: board.last_error,
      last_error_at: board.last_error_at,
      board_role: board.board_role,
    },
    firmwareCompatible: compatBoard ? true : null,
    probe: { backendAuthenticated: board.pairing_status === "paired" ? true : null },
  });

  const info: RecoveryBoardInfo = {
    ...EMPTY_BOARD_INFO,
    boardSlug: board.reported_board_slug ?? compatBoard?.slug ?? null,
    model: compatBoard?.model ?? board.board_model,
    chip: compatBoard?.chip_family ?? board.chip_variant,
    hardwareUid: board.hardware_uid,
    firmwareVersion: board.firmware_version,
    mode:
      board.pairing_status === "recovery_pending"
        ? "recovery"
        : board.pairing_status === "paired"
          ? "normal"
          : "unprovisioned",
    paired: board.pairing_status === "paired",
    supportsWifi: compatBoard ? compatBoard.supports_wifi !== false : true,
    supportsBle: compatBoard ? compatBoard.supports_ble !== false : true,
    lastTransport: null,
    diagnosticsSupported: true,
    capabilityIssues:
      compatBoard && compatBoard.supports_wifi === false
        ? ["This board has no integrated Wi-Fi radio."]
        : [],
  };

  return {
    info,
    telemetry,
    ...evaluateRecovery({
      board: info,
      telemetry,
      transport,
      allowRePair: options.allowRePair,
      wifiCredentialsProvided: options.wifiCredentialsProvided,
    }),
  };
}

export function createRecoveryRoutes() {
  const app = new Hono<AppEnv>();

  app.use("*", requireUserSession());
  app.use("*", requireStaffRole("owner", "administrator"));

  // ---------------------------------------------------------------- start
  app.post("/sessions", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = startSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid recovery session fields." }, 400);
    }

    const auth = c.get("userAuth")!;
    const db = c.get("db");

    const board = await loadBoard(db, auth.accountId, parsed.data.boardInstanceId);
    if (!board) return c.json({ error: "Controller not found in your account." }, 404);

    const expectedSuffix = board.hardware_uid?.replace(/[^a-f0-9]/gi, "").slice(-4).toUpperCase();
    const detectedSuffix = parsed.data.hardwareUidSuffix?.toUpperCase();
    if (expectedSuffix && detectedSuffix && expectedSuffix !== detectedSuffix) {
      return c.json({ error: "Connected board identity does not match this controller." }, 409);
    }

    const created = await createRecoverySession({
      db,
      accountId: auth.accountId,
      boardInstanceId: board.id,
      userId: auth.userId,
      transport: parsed.data.transport,
      boardSlug: parsed.data.boardSlug ?? board.reported_board_slug,
      chipVariant: parsed.data.chipVariant ?? board.chip_variant,
      hardwareUidSuffix: parsed.data.hardwareUidSuffix ?? board.hardware_uid?.slice(-4) ?? null,
      firmwareVersion: parsed.data.firmwareVersion ?? board.firmware_version,
      pairingStatus: board.pairing_status,
    });

    if (!created.ok) {
      return c.json({ error: created.error, sessionId: created.sessionId ?? null }, created.status as 409 | 400);
    }

    if (!created.resumed) {
      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        boardInstanceId: board.id,
        category: "security",
        action: "controller.recovery_session_started",
        summary: `Started ${parsed.data.transport.toUpperCase()} recovery for "${board.name}"`,
        metadata: { sessionId: created.session.id, transport: parsed.data.transport },
      });
    }

    const verdict = await serverVerdict(db, board, parsed.data.transport);

    return c.json(
      {
        session: publicSession(created.session),
        resumed: created.resumed,
        server: {
          diagnostics: verdict.diagnostics,
          plan: verdict.plan,
        },
        board: {
          id: board.id,
          name: board.name,
          boardModel: board.board_model,
          firmwareVersion: board.firmware_version,
          pairingStatus: board.pairing_status,
        },
      },
      created.resumed ? 200 : 201
    );
  });

  // ------------------------------------------------------------- read one
  app.get("/sessions/:id", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const session = await loadSession(db, auth.accountId, c.req.param("id"));
    if (!session) return c.json({ error: "Recovery session not found." }, 404);

    const { data: events } = await db
      .from("recovery_events")
      .select("id,stage,status,step,message,problem_codes,created_at")
      .eq("session_id", session.id)
      .eq("account_id", auth.accountId)
      .order("created_at", { ascending: true })
      .limit(200);

    return c.json({
      session: publicSession(session),
      events: (events ?? []) as Array<Record<string, unknown>>,
      expired: session.status === "active" && sessionExpired(session),
    });
  });

  // -------------------------------------------------------- diagnostics
  app.post("/sessions/:id/diagnostics", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = diagnosticsSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json({ error: "Invalid diagnostics payload." }, 400);
    }

    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const session = await loadSession(db, auth.accountId, c.req.param("id"));
    if (!session) return c.json({ error: "Recovery session not found." }, 404);
    if (session.status !== "active") {
      return c.json({ error: "This recovery session is already closed." }, 409);
    }
    if (sessionExpired(session)) {
      await closeRecoverySession({
        db,
        session,
        status: "expired",
        failureReason: "The recovery session expired before it completed.",
      });
      return c.json({ error: "This recovery session expired. Start a new one." }, 410);
    }

    const board = session.board_instance_id
      ? await loadBoard(db, auth.accountId, session.board_instance_id)
      : null;
    if (!board) return c.json({ error: "Controller not found in your account." }, 404);

    const transport = parsed.data.transport ?? session.transport;
    const verdict = await serverVerdict(db, board, transport, {
      allowRePair: parsed.data.allowRePair,
      wifiCredentialsProvided: parsed.data.wifiCredentialsProvided,
    });

    const stage = parsed.data.stage ?? "diagnostics";
    const diagnosticsJson = {
      checks: verdict.diagnostics.checks,
      problems: verdict.diagnostics.problems,
      status: verdict.diagnostics.status,
      // What the transport itself saw, kept side by side with the server view so
      // a disagreement (e.g. flaky BLE) is visible instead of being overwritten.
      clientChecks: (parsed.data.clientChecks ?? []).map((ch) => ({
        id: ch.id,
        status: ch.status,
        problem: ch.problem ? redactRecoveryText(ch.problem) : null,
        summary: ch.summary ? redactRecoveryText(ch.summary).slice(0, 300) : null,
      })),
      serverCheckedAt: new Date().toISOString(),
    };

    await db
      .from("recovery_sessions")
      .update({
        transport,
        stage,
        diagnostics: diagnosticsJson,
        detected_problems: verdict.diagnostics.problems,
        repair_plan: verdict.plan.actions,
        last_stage_at: new Date().toISOString(),
      })
      .eq("id", session.id)
      .eq("account_id", auth.accountId);

    await recordRecoveryEvent({
      db,
      sessionId: session.id,
      accountId: auth.accountId,
      boardInstanceId: session.board_instance_id,
      stage: parsed.data.transportError ? "repair" : stage,
      status: parsed.data.transportError
        ? "failed"
        : verdict.diagnostics.status === "healthy"
          ? "succeeded"
          : verdict.diagnostics.status === "unknown"
            ? "unknown"
            : "progress",
      step: "diagnostics",
      message:
        parsed.data.transportError ??
        `Diagnostics: ${verdict.diagnostics.status} (${verdict.diagnostics.problems.length} problem(s)).`,
      problemCodes: verdict.diagnostics.problems as ProblemCode[],
    });

    return c.json({
      diagnostics: verdict.diagnostics,
      plan: verdict.plan,
      serverTelemetry: summarizeTelemetry(verdict.telemetry),
    });
  });

  // ------------------------------------------------------------ complete
  app.post("/sessions/:id/complete", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = completeSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json({ error: "Invalid completion payload." }, 400);
    }

    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const session = await loadSession(db, auth.accountId, c.req.param("id"));
    if (!session) return c.json({ error: "Recovery session not found." }, 404);
    if (session.status !== "active") {
      return c.json({ error: "This recovery session is already closed.", session: publicSession(session) }, 409);
    }

    const board = session.board_instance_id
      ? await loadBoard(db, auth.accountId, session.board_instance_id)
      : null;
    if (!board) return c.json({ error: "Controller not found in your account." }, 404);

    const verdict = await serverVerdict(db, board, session.transport);
    const outcomes: RepairOutcome[] = (parsed.data.outcomes ?? []).map((o) => ({
      actionId: o.actionId as RepairOutcome["actionId"],
      status: o.status,
      message: redactRecoveryText(o.message).slice(0, 300),
      technical: o.technical ? redactRecoveryText(o.technical).slice(0, 600) : undefined,
      at: new Date().toISOString(),
    }));

    const completedAt = new Date().toISOString();
    const report = buildRecoveryReport({
      sessionId: session.id,
      boardInstanceId: board.id,
      boardName: board.name,
      board: verdict.info,
      transport: session.transport,
      startedAt: session.started_at,
      completedAt,
      diagnostics: verdict.diagnostics,
      plan: verdict.plan,
      execution: {
        outcomes,
        transportFailed: Boolean(parsed.data.failureReason) || parsed.data.transportReleased === false,
      },
      // Verification is the *server's* post-repair view of the same board.
      verification: verdict.verification,
      finalTelemetry: verdict.telemetry,
    });

    const finalStatus =
      parsed.data.failureReason && report.verification.status !== "verified"
        ? "failed"
        : report.finalStatus;

    await closeRecoverySession({
      db,
      session,
      status: finalStatus,
      report,
      failureReason: parsed.data.failureReason ?? null,
    });

    await db
      .from("recovery_sessions")
      .update({
        actions_attempted: outcomes,
        repair_plan: verdict.plan.actions,
        diagnostics: verdict.diagnostics.checks,
        detected_problems: verdict.diagnostics.problems,
        pairing_status_before: board.pairing_status,
      })
      .eq("id", session.id)
      .eq("account_id", auth.accountId);

    await recordActivity(db, {
      accountId: auth.accountId,
      actorUserId: auth.userId,
      boardInstanceId: board.id,
      category: "security",
      action:
        finalStatus === "completed"
          ? "controller.recovery_completed"
          : finalStatus === "unverified"
            ? "controller.recovery_unverified"
            : "controller.recovery_failed",
      summary:
        finalStatus === "completed"
          ? `${session.transport.toUpperCase()} recovery verified for "${board.name}"`
          : `${session.transport.toUpperCase()} recovery not verified for "${board.name}": ${report.verification.summary}`,
      metadata: {
        sessionId: session.id,
        transport: session.transport,
        problems: report.detectedProblems,
        unresolved: report.unresolvedProblems,
      },
    });

    return c.json({
      session: {
        ...publicSession({
          ...session,
          status: finalStatus,
          completed_at: completedAt,
        }),
      },
      report,
      serverVerified: report.verification.status,
    });
  });

  // ------------------------------------------------------------- abandon
  app.post("/sessions/:id/abandon", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = abandonSchema.safeParse(body ?? {});
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const session = await loadSession(db, auth.accountId, c.req.param("id"));
    if (!session) return c.json({ error: "Recovery session not found." }, 404);
    if (session.status !== "active") {
      return c.json({ ok: true, alreadyClosed: true });
    }
    await closeRecoverySession({
      db,
      session,
      status: "abandoned",
      failureReason: parsed.success ? (parsed.data.reason ?? "Abandoned by the user.") : "Abandoned by the user.",
    });
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------- history
  app.get("/history", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const url = new URL(c.req.url);
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
    const boardInstanceId = url.searchParams.get("boardInstanceId");

    const { sessions, count } = await listRecoverySessions(db, {
      accountId: auth.accountId,
      boardInstanceId,
      limit,
      offset: (page - 1) * limit,
    });

    return c.json({
      sessions,
      pagination: {
        page,
        pageSize: limit,
        total: count,
        totalPages: Math.max(1, Math.ceil(count / limit)),
      },
      transports: RECOVERY_TRANSPORTS,
    });
  });

  return app;
}

function summarizeTelemetry(telemetry: Awaited<ReturnType<typeof buildServerTelemetry>>) {
  return {
    wifi: {
      available: telemetry.wifi.available,
      connected: telemetry.wifi.connected,
      ssid: telemetry.wifi.ssid,
      rssi: telemetry.wifi.rssi,
    },
    mqtt: { available: telemetry.mqtt.available, connected: telemetry.mqtt.connected },
    backend: {
      available: telemetry.backend.available,
      reachable: telemetry.backend.reachable,
      authenticated: telemetry.backend.authenticated,
    },
    heartbeat: {
      available: telemetry.heartbeat.available,
      lastHeartbeatAt: telemetry.heartbeat.lastHeartbeatAt,
      lastSyncAt: telemetry.heartbeat.lastSyncAt,
    },
    firmware: telemetry.firmware,
    config: telemetry.config,
    entities: telemetry.entities,
  };
}

/** Exported for tests and for the admin read-only view. */
export { loadActiveRecoverySession };
