import {
  BOARD_LOG_DEFAULT_PAGE_SIZE,
  BOARD_LOG_MAX_PAGE_SIZE,
  BOARD_LOG_MAX_ROWS_PER_BOARD,
  BOARD_LOG_METADATA_KEY_LIMIT,
  BOARD_LOG_METADATA_VALUE_LIMIT,
  BOARD_LOG_RETENTION_DAYS,
  isBoardLogCategory,
  isBoardLogSeverity,
  type BoardLogCategory,
  type BoardLogEntry,
  type BoardLogSeverity,
} from "@homecoreos/shared";
import type { WorkerBindings } from "../config/env";
import type { CustomFetch, DbClient } from "./db";
import {
  makeRealtimeEvent,
  publishRealtimeEvents,
  type RealtimeEvent,
} from "./realtime";

/**
 * Per-board live Log storage.
 *
 * Design rules that the rest of the Worker relies on:
 *
 *  - One row = one logical event. `dedupeKey` is the identity of the event;
 *    the same key is never stored twice (a bounded in-memory cache avoids the
 *    round trip, the unique index is the source of truth).
 *  - No heartbeat row per heartbeat. The capture points are *transitions*:
 *    online/offline, connected/disconnected, route changes, binding changes,
 *    command lifecycle steps and receiver-reported facts.
 *  - Bounded storage: metadata is trimmed, the rate limiter drops low-value
 *    chatter, and the scheduled sweep enforces both a retention window and a
 *    per-board row ceiling.
 *  - Never blocks the caller: a failed log write never fails the operation
 *    that produced it.
 */

/** Low-priority events accepted per board per minute before the limiter drops them. */
export const BOARD_LOG_RATE_LIMIT_PER_MINUTE = 120;

/** Upper bound for the in-memory dedupe cache (LRU-ish, insertion ordered). */
const DEDUPE_CACHE_LIMIT = 4096;

/** Upper bound for the in-memory rate-limit buckets. */
const RATE_LIMITER_LIMIT = 4096;

interface DedupeEntry {
  key: string;
  at: number;
}

interface RateBucket {
  key: string;
  windowStart: number;
  accepted: number;
  suppressed: number;
}

/**
 * Bounded in-memory caches. A Worker isolate is short-lived, so these are only
 * an optimisation: the database unique index still guarantees that one logical
 * event is stored once, and the retention sweep still bounds the table.
 */
const dedupeCache: DedupeEntry[] = [];
const dedupeIndex = new Set<string>();
const rateBuckets: RateBucket[] = [];
const rateIndex = new Map<string, RateBucket>();

function nowMs(): number {
  return Date.now();
}

function rememberDedupeKey(key: string): void {
  if (dedupeIndex.has(key)) return;
  dedupeCache.push({ key, at: nowMs() });
  dedupeIndex.add(key);
  while (dedupeCache.length > DEDUPE_CACHE_LIMIT) {
    const evicted = dedupeCache.shift();
    if (evicted) dedupeIndex.delete(evicted.key);
  }
}

function hasSeenDedupeKey(key: string): boolean {
  if (dedupeIndex.has(key)) return true;
  rememberDedupeKey(key);
  return false;
}

/**
 * Keeps only short, non-sensitive scalars. A log line must never carry a
 * credential, a payload or a sensor value — only identifiers and tokens.
 */
export function sanitizeBoardLogMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!metadata || typeof metadata !== "object") return out;
  let count = 0;
  for (const [key, value] of Object.entries(metadata)) {
    if (count >= BOARD_LOG_METADATA_KEY_LIMIT) break;
    if (typeof key !== "string" || key.length === 0) continue;
    const safeKey = key.slice(0, 48);
    if (value === null || value === undefined) {
      out[safeKey] = null;
      count += 1;
      continue;
    }
    if (typeof value === "string") {
      out[safeKey] = value.slice(0, BOARD_LOG_METADATA_VALUE_LIMIT);
      count += 1;
      continue;
    }
    if (typeof value === "number") {
      out[safeKey] = Number.isFinite(value) ? value : null;
      count += 1;
      continue;
    }
    if (typeof value === "boolean") {
      out[safeKey] = value;
      count += 1;
      continue;
    }
    // Arrays and objects are flattened to their length so a large payload can
    // never reach the database.
    if (Array.isArray(value)) {
      out[safeKey] = value.length;
      count += 1;
      continue;
    }
    out[safeKey] = Object.keys(value as Record<string, unknown>).length;
    count += 1;
  }
  return out;
}

function truncateToken(value: string | null | undefined, limit = 120): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, limit);
}

function takeRateBucket(key: string): RateBucket {
  const existing = rateIndex.get(key);
  const now = nowMs();
  if (existing && now - existing.windowStart < 60_000) return existing;
  if (existing) {
    rateIndex.delete(existing.key);
    const position = rateBuckets.indexOf(existing);
    if (position >= 0) rateBuckets.splice(position, 1);
  }
  const bucket: RateBucket = {
    key,
    windowStart: now,
    accepted: 0,
    suppressed: 0,
  };
  rateBuckets.push(bucket);
  rateIndex.set(key, bucket);
  while (rateBuckets.length > RATE_LIMITER_LIMIT) {
    const evicted = rateBuckets.shift();
    if (evicted) rateIndex.delete(evicted.key);
  }
  return bucket;
}

/**
 * Turns a receiver-side fact reported by a board into a readable line.
 * The console never invents the wording: it only labels what the board
 * actually reported.
 */
export function describeBoardFact(params: {
  kind: string;
  status: string;
  target?: string | null;
  detail?: string | null;
}): string {
  const target = params.target?.trim() ? params.target.trim() : null;
  const detail = params.detail?.trim() ? params.detail.trim() : null;
  const subject = target ? ` ${target}` : "";
  const suffix = detail && detail !== target ? ` (${detail})` : "";
  switch (params.status) {
    case "received":
      return `Command received${subject}${suffix}.`;
    case "acknowledged":
      return target
        ? `Acknowledgement received for ${target}${suffix}.`
        : `Acknowledgement received${suffix}.`;
    case "executed":
      return `Command executed${subject}${suffix}.`;
    case "failed":
      return `Command failed${subject}${suffix}.`;
    case "rejected":
      return `Command rejected${subject}${suffix}.`;
    case "duplicate":
      return `Duplicate command ignored${subject}${suffix}.`;
    case "sent":
      // A command that was handed to a transport and a frame that went out
      // are two different things; the wording keeps them apart.
      return params.kind === "cmd"
        ? `Command sent${subject}${suffix}.`
        : `Frame sent${subject}${suffix}.`;
    case "timeout":
      return `Delivery timed out${subject}${suffix}.`;
    case "offline":
      return `Link lost${subject}.`;
    case "online":
      return `Link established${subject}.`;
    case "link_established":
      return `Link established${subject}.`;
    case "link_lost":
      return `Link lost${subject}.`;
    default:
      return `${params.kind === "cmd" ? "Command" : "Event"} ${params.status}${subject}${suffix}.`;
  }
}

/**
 * Collects the real-time events of the log entries written during one request.
 *
 * The account channel publishes one envelope per user action or device
 * report, so the log entries of that action travel in the same envelope as the
 * state change instead of adding one broker message per log line.
 */
export interface BoardLogCollector {
  events: RealtimeEvent[];
}

export function createBoardLogCollector(): BoardLogCollector {
  return { events: [] };
}

export interface BoardLogCaptureContext {
  db: DbClient;
  env?: WorkerBindings;
  deps?: { emqxFetch?: CustomFetch };
  /** When set, the real-time event is collected instead of published. */
  collector?: BoardLogCollector;
}

/**
 * The capture can be switched off per deployment without touching the code:
 * `BOARD_LOG_ENABLED=false` stops every new row from being written. The
 * console keeps reading the history that was already stored.
 */
export function isBoardLogEnabled(env?: WorkerBindings): boolean {
  const raw = env?.BOARD_LOG_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return raw !== "false" && raw !== "0" && raw !== "off" && raw !== "no";
}

/** The retention window for this deployment, in days. */
export function resolveBoardLogRetentionDays(env?: WorkerBindings): number {
  const parsed = Number(env?.BOARD_LOG_RETENTION_DAYS);
  if (Number.isFinite(parsed) && parsed >= 1) return Math.trunc(parsed);
  return BOARD_LOG_RETENTION_DAYS;
}

export interface BoardLogInput {
  accountId: string;
  boardInstanceId: string;
  category: BoardLogCategory | string;
  severity?: BoardLogSeverity | string;
  status?: string | null;
  method?: string | null;
  source?: string | null;
  destination?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
  /** Identity of the logical event. Repeating a key never stores a second row. */
  dedupeKey?: string | null;
  /** Overrides the stored timestamp (used when a device reports its own time). */
  createdAt?: string;
}

/**
 * Stores one log entry and (best effort) publishes it on the account's
 * real-time channel. Never throws: a broken log must not break the operation
 * that produced it.
 */
export async function captureBoardLog(
  ctx: BoardLogCaptureContext,
  input: BoardLogInput
): Promise<BoardLogEntry | null> {
  if (!input?.accountId || !input?.boardInstanceId || !input?.message) return null;
  if (!isBoardLogEnabled(ctx.env)) return null;

  const category = isBoardLogCategory(input.category) ? input.category : "system";
  const severity = isBoardLogSeverity(input.severity) ? input.severity : "info";
  const dedupeKey = input.dedupeKey ? truncateToken(input.dedupeKey, 200) : null;

  if (dedupeKey && hasSeenDedupeKey(`${input.accountId}:${input.boardInstanceId}:${dedupeKey}`)) {
    return null;
  }

  // Rate limiting: warnings and errors are always kept, low-priority chatter
  // is dropped and counted. The count is attached to the next accepted entry
  // so a burst shows up as one aggregated line instead of many.
  const bucketKey = `${input.accountId}:${input.boardInstanceId}`;
  const bucket = takeRateBucket(bucketKey);
  let metadata = sanitizeBoardLogMetadata(input.metadata);
  if (severity === "info" || severity === "success") {
    if (bucket.accepted >= BOARD_LOG_RATE_LIMIT_PER_MINUTE) {
      bucket.suppressed += 1;
      return null;
    }
  }
  if (bucket.suppressed > 0) {
    metadata = { ...metadata, suppressed: bucket.suppressed };
    bucket.suppressed = 0;
  }
  bucket.accepted += 1;

  const row = {
    account_id: input.accountId,
    board_instance_id: input.boardInstanceId,
    category,
    severity,
    status: truncateToken(input.status, 40),
    method: truncateToken(input.method, 24),
    source: truncateToken(input.source, 80),
    destination: truncateToken(input.destination, 80),
    message: truncateToken(input.message, 500) ?? "",
    metadata,
    dedupe_key: dedupeKey,
    ...(input.createdAt ? { created_at: input.createdAt } : {}),
  };

  try {
    const { data, error } = await ctx.db
      .from("board_log_events")
      .insert(row)
      .select("id,seq,created_at")
      .single();
    if (error) {
      // A duplicate logical event is not an error: the event is already stored.
      if (error.code === "23505" || /duplicate key/i.test(error.message ?? "")) {
        return null;
      }
      console.warn(`[board-log] insert failed: ${error.message}`);
      return null;
    }
    const created = data as { id: string; seq: number; created_at: string };
    const entry: BoardLogEntry = {
      id: created.id,
      boardInstanceId: input.boardInstanceId,
      category,
      severity,
      status: row.status,
      method: row.method,
      source: row.source,
      destination: row.destination,
      message: row.message,
      metadata: row.metadata,
      createdAt: created.created_at,
    };
    if (ctx.collector) {
      ctx.collector.events.push(
        buildBoardLogRealtimeEvent(input.accountId, entry)
      );
    } else if (ctx.env) {
      await publishBoardLogRealtime(ctx, input.accountId, entry);
    }
    return entry;
  } catch (err) {
    console.warn(
      `[board-log] insert threw: ${err instanceof Error ? err.message : "unknown error"}`
    );
    return null;
  }
}

/**
 * Publishes one log entry on the existing account-scoped real-time channel.
 * The event id is the log row id, so two entries created in the same
 * millisecond are still two distinct deliveries.
 */
function buildBoardLogRealtimeEvent(
  accountId: string,
  entry: BoardLogEntry
): RealtimeEvent {
  void accountId;
  return makeRealtimeEvent(
    "log",
    "created",
    entry.id,
    {
      boardInstanceId: entry.boardInstanceId,
      category: entry.category,
      severity: entry.severity,
      status: entry.status,
      method: entry.method,
      source: entry.source,
      destination: entry.destination,
      message: entry.message,
      metadata: entry.metadata,
      createdAt: entry.createdAt,
    },
    undefined,
    entry.createdAt
  );
}

async function publishBoardLogRealtime(
  ctx: BoardLogCaptureContext,
  accountId: string,
  entry: BoardLogEntry
): Promise<void> {
  try {
    await publishRealtimeEvents(ctx.env!, ctx.deps, accountId, [
      buildBoardLogRealtimeEvent(accountId, entry),
    ]);
  } catch (err) {
    console.warn(
      `[board-log] realtime publish failed: ${
        err instanceof Error ? err.message : "unknown error"
      }`
    );
  }
}

export interface BoardLogQuery {
  accountId: string;
  boardInstanceId: string;
  limit?: number;
  /** Cursor: the `seq` of the newest entry of the previous page. */
  before?: string | number | null;
  category?: string | null;
  severity?: string | null;
  search?: string | null;
}

export interface BoardLogQueryResult {
  entries: BoardLogEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

function mapRow(row: Record<string, unknown>): BoardLogEntry {
  return {
    id: String(row.id),
    boardInstanceId: String(row.board_instance_id),
    category: String(row.category) as BoardLogCategory,
    severity: String(row.severity) as BoardLogSeverity,
    status: row.status === null || row.status === undefined ? null : String(row.status),
    method: row.method === null || row.method === undefined ? null : String(row.method),
    source: row.source === null || row.source === undefined ? null : String(row.source),
    destination:
      row.destination === null || row.destination === undefined ? null : String(row.destination),
    message: String(row.message ?? ""),
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdAt: String(row.created_at),
  };
}

/** Free-text search is restricted to the message column and to safe characters. */
function sanitizeSearch(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[%_(),."'\\]/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, 80);
}

export async function listBoardLogs(
  db: DbClient,
  query: BoardLogQuery
): Promise<BoardLogQueryResult> {
  const limit = Math.min(
    Math.max(1, Math.trunc(query.limit ?? BOARD_LOG_DEFAULT_PAGE_SIZE)),
    BOARD_LOG_MAX_PAGE_SIZE
  );

  let builder = db
    .from("board_log_events")
    .select(
      "id,seq,board_instance_id,category,severity,status,method,source,destination,message,metadata,created_at"
    )
    .eq("account_id", query.accountId)
    .eq("board_instance_id", query.boardInstanceId);

  if (query.category && isBoardLogCategory(query.category)) {
    builder = builder.eq("category", query.category);
  }
  if (query.severity && isBoardLogSeverity(query.severity)) {
    builder = builder.eq("severity", query.severity);
  }
  const search = sanitizeSearch(query.search);
  if (search) {
    builder = builder.or(`message.ilike.*${search}*`);
  }
  if (query.before !== null && query.before !== undefined && query.before !== "") {
    const seq = Number(query.before);
    if (Number.isFinite(seq) && seq > 0) {
      builder = builder.lt("seq", seq);
    }
  }

  const { data, error } = await builder
    .order("seq", { ascending: false })
    .limit(limit + 1);

  if (error) {
    throw new Error(`Board log query failed: ${error.message}`);
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const entries = page.map(mapRow);
  const lastSeq = page.length > 0 ? Number(page[page.length - 1]!.seq) : null;

  return {
    entries,
    nextCursor: hasMore && lastSeq !== null ? String(lastSeq) : null,
    hasMore,
  };
}

/**
 * Retention sweep. Removes rows older than the retention window and trims a
 * board that outgrew the per-board ceiling. Called from the Worker's
 * scheduled tick; failures are logged and never throw.
 */
export async function pruneBoardLogs(
  db: DbClient,
  options?: { retentionDays?: number; maxRowsPerBoard?: number; env?: WorkerBindings }
): Promise<{ prunedByAge: number; trimmedByCount: number }> {
  const retentionDays = Math.max(
    1,
    options?.retentionDays ?? resolveBoardLogRetentionDays(options?.env)
  );
  const maxRows = Math.max(100, options?.maxRowsPerBoard ?? BOARD_LOG_MAX_ROWS_PER_BOARD);
  let prunedByAge = 0;
  let trimmedByCount = 0;

  try {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const aged = await db
      .from("board_log_events")
      .delete()
      .lt("created_at", cutoff)
      .select("id");
    if (aged.error) {
      console.warn(`[board-log] retention sweep failed: ${aged.error.message}`);
    } else {
      prunedByAge = (aged.data ?? []).length;
    }
  } catch (err) {
    console.warn(
      `[board-log] retention sweep threw: ${
        err instanceof Error ? err.message : "unknown error"
      }`
    );
  }

  try {
    // Keep only the newest rows per board. The trim runs inside the database
    // so a noisy board never has to be streamed through the Worker.
    const { data, error } = await db.rpc("trim_board_log_events", {
      p_max_rows: maxRows,
    });
    if (error) {
      console.warn(`[board-log] row trim failed: ${error.message}`);
      return { prunedByAge, trimmedByCount };
    }
    const value = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : null;
    const removed = value
      ? Object.values(value)[0]
      : typeof data === "number"
        ? data
        : 0;
    trimmedByCount = typeof removed === "number" ? removed : Number(removed ?? 0);
  } catch (err) {
    console.warn(
      `[board-log] row trim threw: ${
        err instanceof Error ? err.message : "unknown error"
      }`
    );
  }

  return { prunedByAge, trimmedByCount };
}

/** Test seam: clears the in-memory caches. */
export function resetBoardLogCaches(): void {
  dedupeCache.length = 0;
  dedupeIndex.clear();
  rateBuckets.length = 0;
  rateIndex.clear();
}

/**
 * Records the command lifecycle on the board that owns the target.
 *
 * The three states are kept strictly apart:
 *   created — the console accepted the request
 *   sent    — the Worker handed the command to a transport (a publish, nothing
 *             more; a publish never proves that the destination received it)
 *   failed / offline — the command never left the Worker
 *
 * "received", "acknowledged" and "executed" are never written here: they are
 * only written from a fact the destination board itself reported.
 */
export async function recordCommandLifecycle(
  ctx: BoardLogCaptureContext,
  params: {
    accountId: string;
    boardInstanceId: string;
    targetId: string;
    targetName: string;
    kind: "switch" | "device";
    requestedState: string;
    commandId: string;
    dispatchId: string;
    route: string | null;
    relayedViaControllerId: string | null;
    delivered: boolean;
    boardOnline: boolean;
    actorUserId?: string | null;
  }
): Promise<void> {
  const subject =
    params.kind === "switch"
      ? `switch "${params.targetName}"`
      : `device "${params.targetName}"`;

  await captureBoardLog(ctx, {
    accountId: params.accountId,
    boardInstanceId: params.boardInstanceId,
    category: "command",
    severity: "info",
    status: "created",
    method: "user",
    source: params.actorUserId ?? null,
    destination: params.targetId,
    message: `Command created: set ${subject} to ${params.requestedState}.`,
    dedupeKey: `cmd:created:${params.commandId}:${params.dispatchId}`,
    metadata: {
      commandId: params.commandId,
      target: params.targetId,
      kind: params.kind,
      requestedState: params.requestedState,
    },
  });

  if (!params.delivered) {
    await captureBoardLog(ctx, {
      accountId: params.accountId,
      boardInstanceId: params.boardInstanceId,
      category: "command",
      severity: "warning",
      status: params.boardOnline ? "failed" : "offline",
      method: "worker",
      source: "worker",
      destination: params.targetId,
      message: params.boardOnline
        ? `Command was not delivered: no healthy route to the board.`
        : `Command was not delivered: the board is offline.`,
      dedupeKey: `cmd:undelivered:${params.commandId}:${params.dispatchId}`,
      metadata: {
        commandId: params.commandId,
        target: params.targetId,
        kind: params.kind,
        boardOnline: params.boardOnline,
      },
    });
    return;
  }

  await captureBoardLog(ctx, {
    accountId: params.accountId,
    boardInstanceId: params.boardInstanceId,
    category: "command",
    severity: "info",
    status: "sent",
    method: "mqtt",
    source: "worker",
    destination: params.targetId,
    message: params.relayedViaControllerId
      ? `Command published for relay to the Controller (${params.route}).`
      : `Command published to the board (${params.route}).`,
    dedupeKey: `cmd:sent:${params.commandId}:${params.dispatchId}`,
    metadata: {
      commandId: params.commandId,
      target: params.targetId,
      kind: params.kind,
      route: params.route,
      relayedViaControllerId: params.relayedViaControllerId,
    },
  });

  if (params.relayedViaControllerId) {
    // The Controller is the peer of the relay, so the relay shows up in the
    // Controller's own log as a communication event. The Node keeps its own
    // history; the two are never merged.
    await captureBoardLog(ctx, {
      accountId: params.accountId,
      boardInstanceId: params.relayedViaControllerId,
      category: "communication",
      severity: "info",
      status: "sent",
      method: "mqtt",
      source: "worker",
      destination: params.boardInstanceId,
      message: `Relay accepted for ${subject}.`,
      dedupeKey: `relay:sent:${params.commandId}:${params.dispatchId}`,
      metadata: {
        commandId: params.commandId,
        nodeId: params.boardInstanceId,
        target: params.targetId,
      },
    });
  }
}

/**
 * Marks commands that were published but never confirmed by the destination
 * board as timed out.
 *
 * The check is bounded: it only looks at a recent window of "sent" command
 * entries and at the confirmations reported for them, so it never scans the
 * whole table. A command counts as confirmed only when the destination board
 * itself reported "received", "acknowledged", "executed", "rejected" or
 * "failed" for the same command id.
 */
export async function expireUnconfirmedCommands(
  db: DbClient,
  options?: {
    deadlineSeconds?: number;
    maxRows?: number;
    now?: Date;
    env?: WorkerBindings;
    deps?: { emqxFetch?: CustomFetch };
  }
): Promise<number> {
  const deadlineSeconds = Math.max(15, options?.deadlineSeconds ?? 120);
  const maxRows = Math.max(20, options?.maxRows ?? 200);
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  const lookback = new Date(nowMs - 15 * 60 * 1000).toISOString();

  try {
    const [{ data: sentRows }, { data: confirmedRows }] = await Promise.all([
      db
        .from("board_log_events")
        .select("id,seq,account_id,board_instance_id,created_at,metadata")
        .eq("category", "command")
        .eq("status", "sent")
        .gte("created_at", lookback)
        .order("seq", { ascending: false })
        .limit(maxRows),
      db
        .from("board_log_events")
        .select("board_instance_id,status,metadata,created_at")
        .eq("category", "command")
        .in("status", ["received", "acknowledged", "executed", "rejected", "failed"])
        .gte("created_at", lookback)
        .limit(maxRows * 5),
    ]);

    const sent = (sentRows ?? []) as Array<{
      id: string;
      seq: number;
      account_id: string;
      board_instance_id: string;
      created_at: string;
      metadata?: Record<string, unknown> | null;
    }>;
    if (sent.length === 0) return 0;

    /* A confirmation only counts for a command that was still outstanding when
     * the confirmation arrived. The same payload can be dispatched twice (the
     * command id is a hash of the payload), so a confirmation that predates the
     * send must not confirm it. */
    const confirmations = new Map<string, number[]>();
    for (const row of (confirmedRows ?? []) as Array<{
      board_instance_id: string;
      metadata?: Record<string, unknown> | null;
      created_at: string;
    }>) {
      const commandId = (row.metadata as { commandId?: unknown } | null)?.commandId;
      if (typeof commandId !== "string" || commandId.length === 0) continue;
      const key = `${row.board_instance_id}:${commandId}`;
      const at = Date.parse(row.created_at);
      const list = confirmations.get(key) ?? [];
      list.push(Number.isFinite(at) ? at : 0);
      confirmations.set(key, list);
    }

    let expired = 0;
    for (const row of sent) {
      const createdMs = Date.parse(row.created_at);
      if (!Number.isFinite(createdMs) || nowMs - createdMs < deadlineSeconds * 1000) {
        continue;
      }
      const commandId = (row.metadata as { commandId?: unknown } | null)?.commandId;
      if (typeof commandId !== "string" || commandId.length === 0) continue;
      const confirmationsForCommand =
        confirmations.get(`${row.board_instance_id}:${commandId}`) ?? [];
      const confirmedAfterSend = confirmationsForCommand.some((at) => at >= createdMs);
      if (confirmedAfterSend) continue;

      const written = await captureBoardLog(
        { db, env: options?.env, deps: options?.deps },
        {
          accountId: row.account_id,
          boardInstanceId: row.board_instance_id,
          category: "command",
          severity: "warning",
          status: "timeout",
          method: "worker",
          source: "worker",
          destination: (row.metadata as { target?: unknown } | null)?.target as string ?? null,
          message: `Command was published but the board never confirmed it within ${deadlineSeconds}s.`,
          dedupeKey: `cmd:timeout:${row.board_instance_id}:${commandId}:${row.seq}`,
          metadata: { commandId, deadlineSeconds },
        }
      );
      if (written) expired += 1;
    }
    return expired;
  } catch (err) {
    console.warn(
      `[board-log] command timeout sweep failed: ${
        err instanceof Error ? err.message : "unknown error"
      }`
    );
    return 0;
  }
}
