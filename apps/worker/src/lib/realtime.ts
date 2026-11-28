import { isEmqxConfigured, EmqxClient } from "./emqx";
import { toBase64Url } from "./crypto";
import type { WorkerBindings } from "../config/env";
import type { CustomFetch, DbClient } from "./db";

/**
 * Account-scoped real-time state channel.
 *
 * The browser holds exactly one MQTT-over-WebSocket session per signed-in
 * browser session and subscribes to one wildcard topic:
 *
 *   homecore/<accountId>/realtime/#
 *
 * The Worker publishes a single JSON envelope to
 * `homecore/<accountId>/realtime/events` whenever persisted state changes. A
 * request that changes several rows publishes once, not once per row, so the
 * broker sees one message per user action or device report.
 *
 * Reconnection reconciliation uses `buildRealtimeSnapshot()`, which returns a
 * compact map of entity versions. The frontend compares those versions against
 * the last event it applied and reloads only the pages whose entities drifted.
 */
export type RealtimeEntity =
  | "board"
  | "switch"
  | "device"
  | "sensor"
  | "automation"
  | "notification"
  | "home"
  | "log";

export type RealtimeEventAction =
  | "created"
  | "updated"
  | "deleted"
  | "state"
  | "run"
  | "alert";

/**
 * Command lifecycle. The console must never present a button press as a
 * hardware-confirmed change: `desired` is what the user asked for, `accepted`
 * means the broker/Worker took it, `confirmed` means the hardware reported it,
 * and `failed` means the command never left the Worker.
 */
export type RealtimeEventPhase = "desired" | "accepted" | "confirmed" | "failed";

export interface RealtimeEvent {
  entity: RealtimeEntity;
  action: RealtimeEventAction;
  id: string;
  /** ISO timestamp of the data change. Older events are ignored by the client. */
  ts: string;
  phase?: RealtimeEventPhase;
  patch?: Record<string, unknown>;
  /**
   * Row-derived entity version (the same field `buildRealtimeSnapshot()` reads,
   * e.g. `switches.last_changed_at`). When present it is the authoritative
   * reconciliation key; `ts` only orders deliveries.
   */
  version?: string;
}

export interface RealtimeEnvelope {
  v: 1;
  accountId: string;
  sentAt: string;
  events: RealtimeEvent[];
}

export interface RealtimeSnapshotEntity {
  id: string;
  /** ISO timestamp (or config revision for boards) used for drift detection. */
  version: string;
  [key: string]: unknown;
}

export interface RealtimeSnapshot {
  v: 1;
  accountId: string;
  serverTime: string;
  entities: {
    boards: RealtimeSnapshotEntity[];
    switches: RealtimeSnapshotEntity[];
    devices: RealtimeSnapshotEntity[];
    sensors: RealtimeSnapshotEntity[];
    automations: RealtimeSnapshotEntity[];
    homes: RealtimeSnapshotEntity[];
  };
}

export const REALTIME_MAX_EVENTS_PER_MESSAGE = 40;

export function buildRealtimeTopic(accountId: string): string {
  return `homecore/${accountId}/realtime/events`;
}

export function buildRealtimeSubscription(accountId: string): string {
  return `homecore/${accountId}/realtime/#`;
}

export function buildRealtimeWebUsername(accountId: string, sessionId: string): string {
  return `hcweb-${accountId.replace(/-/g, "")}-${sessionId.replace(/-/g, "")}`;
}

/**
 * Derives the subscribe-only broker password for one login session.
 *
 * The password is a deterministic HMAC of the session id keyed with the EMQX
 * app secret, so it is never persisted (no credential at rest in Postgres) and
 * can be recomputed on every page load. Rotating `EMQX_APP_SECRET` invalidates
 * every outstanding browser credential at once.
 */
export async function deriveRealtimePassword(
  env: WorkerBindings,
  sessionId: string
): Promise<string> {
  const secret =
    env.EMQX_APP_SECRET?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!secret) throw new Error("Realtime credentials require a configured app secret.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`homecoreos:realtime:${sessionId}`)
  );
  return toBase64Url(new Uint8Array(signature).slice(0, 24));
}

/** Broker WebSocket URL. `EMQX_WS_URL` wins when the deployment differs. */
export function resolveRealtimeBrokerUrl(env: WorkerBindings): string | null {
  const explicit = env.EMQX_WS_URL?.trim();
  if (explicit) return explicit;
  const host = env.EMQX_BROKER_HOST?.trim();
  if (!host) return null;
  const port = env.EMQX_WS_PORT?.trim() || "8084";
  const path = env.EMQX_WS_PATH?.trim() || "/mqtt";
  return `wss://${host}:${port}${path.startsWith("/") ? path : `/${path}`}`;
}

export interface RealtimeCredential {
  brokerUrl: string;
  username: string;
  password: string;
  topic: string;
  clientIdPrefix: string;
  /**
   * Deterministic broker client id for this login session. One session owns one
   * connection, so revoking the session can kick the live socket immediately by
   * id instead of waiting for the 12 h credential TTL.
   */
  clientId: string;
  expiresAt: string;
}

export function buildRealtimeClientId(accountId: string, sessionId: string): string {
  return buildRealtimeWebUsername(accountId, sessionId);
}

const CREDENTIAL_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Returns (and lazily provisions) the subscribe-only broker identity for one
 * login session. Provisioning is idempotent and skipped once the EMQX user is
 * recorded as provisioned, so opening the console costs at most one EMQX API
 * call per sign-in instead of one per page load.
 */
export async function ensureRealtimeCredential(params: {
  db: DbClient;
  env: WorkerBindings;
  deps?: { emqxFetch?: CustomFetch };
  sessionId: string;
  accountId: string;
  userId: string;
  now?: Date;
  force?: boolean;
  clientIdPrefix?: string;
}): Promise<{ ok: true; credential: RealtimeCredential } | { ok: false; reason: string }> {
  const { db, env } = params;
  if (!isEmqxConfigured(env)) {
    return { ok: false, reason: "emqx_not_configured" };
  }
  const brokerUrl = resolveRealtimeBrokerUrl(env);
  if (!brokerUrl) return { ok: false, reason: "broker_url_missing" };

  const username = buildRealtimeWebUsername(params.accountId, params.sessionId);
  const password = await deriveRealtimePassword(env, params.sessionId);
  const now = params.now ?? new Date();

  const { data: existing } = await db
    .from("realtime_web_sessions")
    .select("session_id,mqtt_username,provisioned_at,revoked_at")
    .eq("session_id", params.sessionId)
    .maybeSingle();

  const row = existing as
    | { session_id: string; mqtt_username: string; provisioned_at: string | null; revoked_at: string | null }
    | null;

  const needsProvisioning = params.force || !row?.provisioned_at || Boolean(row?.revoked_at);

  if (needsProvisioning) {
    try {
      const emqx = new EmqxClient(env, params.deps?.emqxFetch);
      await emqx.provisionRealtimeWebCredentials({
        accountId: params.accountId,
        username,
        password,
      });
    } catch (err) {
      console.warn(
        `[realtime] failed to provision browser MQTT identity: ${
          err instanceof Error ? err.message : "unknown error"
        }`
      );
      return { ok: false, reason: "provision_failed" };
    }
  }

  const upsert = await db.from("realtime_web_sessions").upsert(
    {
      session_id: params.sessionId,
      account_id: params.accountId,
      user_id: params.userId,
      mqtt_username: username,
      provisioned_at: needsProvisioning ? now.toISOString() : row?.provisioned_at ?? now.toISOString(),
      last_issued_at: now.toISOString(),
      revoked_at: null,
    },
    { onConflict: "session_id" }
  );
  if (upsert.error) {
    console.warn(`[realtime] failed to record browser MQTT identity: ${upsert.error.message}`);
    return { ok: false, reason: "record_failed" };
  }

  return {
    ok: true,
    credential: {
      brokerUrl,
      username,
      password,
      topic: buildRealtimeSubscription(params.accountId),
      clientIdPrefix: params.clientIdPrefix ?? "hcweb",
      clientId: buildRealtimeClientId(params.accountId, params.sessionId),
      expiresAt: new Date(now.getTime() + CREDENTIAL_TTL_MS).toISOString(),
    },
  };
}

/** Best-effort revocation used on sign-out. Never blocks or fails a request. */
export async function revokeRealtimeCredential(params: {
  db: DbClient;
  env: WorkerBindings;
  deps?: { emqxFetch?: CustomFetch };
  sessionId: string;
}): Promise<void> {
  const { db, env } = params;
  try {
    const { data } = await db
      .from("realtime_web_sessions")
      .select("mqtt_username,account_id,revoked_at")
      .eq("session_id", params.sessionId)
      .maybeSingle();
    const row = data as
      | { mqtt_username: string; account_id: string; revoked_at: string | null }
      | null;
    if (row && !row.revoked_at) {
      if (isEmqxConfigured(env)) {
        const emqx = new EmqxClient(env, params.deps?.emqxFetch);
        // Kicking by the deterministic client id closes a live socket at once;
        // deleting the user stops any reconnect.
        await emqx.revokeMqttIdentity(row.mqtt_username, row.mqtt_username).catch(() => {});
      }
      await db
        .from("realtime_web_sessions")
        .update({ revoked_at: new Date().toISOString() })
        .eq("session_id", params.sessionId);
    }
  } catch (err) {
    console.warn(
      `[realtime] credential revocation skipped: ${
        err instanceof Error ? err.message : "unknown error"
      }`
    );
  }
}

/**
 * Best-effort revocation for many sessions at once (password change, password
 * recovery, "revoke all other sessions"). One query instead of one per session,
 * and a failure on any single broker call never blocks the security action.
 */
export async function revokeRealtimeCredentialsForSessions(params: {
  db: DbClient;
  env: WorkerBindings;
  deps?: { emqxFetch?: CustomFetch };
  sessionIds: string[];
}): Promise<{ revoked: number }> {
  const ids = Array.from(new Set(params.sessionIds.filter(Boolean)));
  if (ids.length === 0) return { revoked: 0 };

  try {
    const { data } = await params.db
      .from("realtime_web_sessions")
      .select("session_id,mqtt_username,revoked_at")
      .in("session_id", ids)
      .is("revoked_at", null);
    const rows = (data ?? []) as Array<{ session_id: string; mqtt_username: string }>;
    if (rows.length === 0) return { revoked: 0 };

    if (isEmqxConfigured(params.env)) {
      const emqx = new EmqxClient(params.env, params.deps?.emqxFetch);
      await Promise.all(
        rows.map((row) =>
          emqx.revokeMqttIdentity(row.mqtt_username, row.mqtt_username).catch(() => {})
        )
      );
    }

    await params.db
      .from("realtime_web_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .in(
        "session_id",
        rows.map((row) => row.session_id)
      );

    return { revoked: rows.length };
  } catch (err) {
    console.warn(
      `[realtime] batch revocation skipped: ${
        err instanceof Error ? err.message : "unknown error"
      }`
    );
    return { revoked: 0 };
  }
}

/**
 * Publishes state events as one or more envelopes.
 *
 * A single envelope carries at most `REALTIME_MAX_EVENTS_PER_MESSAGE` events so
 * the MQTT payload stays small (free-tier friendly) and a broker never rejects
 * an oversized message. Bulk actions that touch more entities than that are
 * **split across several envelopes** instead of being truncated — dropping the
 * tail used to leave parts of a large action silently out of sync until the
 * next reconnect.
 *
 * Delivery is best-effort by design: real-time is an optimization, never the
 * source of truth, so a broker outage must not fail a user action that already
 * committed to Postgres. Each chunk gets one bounded retry for transient
 * failures.
 */
export async function publishRealtimeEvents(
  env: WorkerBindings,
  deps: { emqxFetch?: CustomFetch } | undefined,
  accountId: string,
  events: RealtimeEvent[]
): Promise<{ published: boolean; chunks: number; failedChunks: number }> {
  const usable = events.filter((event) => Boolean(event?.entity && event?.id && event?.ts));
  if (usable.length === 0) return { published: false, chunks: 0, failedChunks: 0 };
  if (!isEmqxConfigured(env)) return { published: false, chunks: 0, failedChunks: 0 };

  const emqx = new EmqxClient(env, deps?.emqxFetch);
  const topic = buildRealtimeTopic(accountId);
  let failedChunks = 0;
  let publishedChunks = 0;
  let sentAt = new Date().toISOString();

  for (let offset = 0; offset < usable.length; offset += REALTIME_MAX_EVENTS_PER_MESSAGE) {
    const chunk = usable.slice(offset, offset + REALTIME_MAX_EVENTS_PER_MESSAGE);
    const envelope: RealtimeEnvelope = {
      v: 1,
      accountId,
      sentAt,
      events: chunk,
    };

    // QoS policy: low-volume, human-triggered changes (switch/device/board/
    // automation/home/notification) are worth an acknowledgement, so a dropped
    // command result cannot go unnoticed until the next reconnect. Any chunk
    // that carries sensor telemetry stays QoS 0 — sensors are the high-frequency
    // producer and acks there would only add broker traffic. Nothing is retained:
    // the snapshot is the repair mechanism, not the broker.
    const qos = chunk.some((event) => event.entity === "sensor") ? 0 : 1;

    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt += 1) {
      try {
        await emqx.publish({
          topic,
          payload: envelope as unknown as Record<string, unknown>,
          qos,
          retain: false,
        });
        ok = true;
      } catch (err) {
        if (attempt === 1) {
          console.warn(
            `[realtime] publish skipped: ${err instanceof Error ? err.message : "unknown error"}`
          );
        } else {
          await new Promise((resolve) => setTimeout(resolve, 50));
          sentAt = new Date().toISOString();
        }
      }
    }
    if (ok) publishedChunks += 1;
    else failedChunks += 1;
  }

  return { published: publishedChunks > 0, chunks: publishedChunks, failedChunks };
}

type SnapshotRow = Record<string, unknown>;

function versionOf(row: SnapshotRow, ...fields: string[]): string {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const createdAt = row.created_at;
  return typeof createdAt === "string" ? createdAt : new Date(0).toISOString();
}

export class RealtimeSnapshotError extends Error {
  readonly entity: string;
  constructor(entity: string, detail: string) {
    super(`Realtime snapshot query failed for ${entity}: ${detail}`);
    this.name = "RealtimeSnapshotError";
    this.entity = entity;
  }
}

/**
 * Compact version map used to reconcile after a reconnect.
 *
 * Every query is checked: a database error is thrown, never coerced into an
 * empty list. An empty list is a *valid* answer meaning "this account has no
 * such entities", and treating a failure as emptiness would tell the browser it
 * is synchronized with a fleet that had all just disappeared.
 */
export async function buildRealtimeSnapshot(
  db: DbClient,
  accountId: string
): Promise<RealtimeSnapshot> {
  const [boardsRes, switchesRes, devicesRes, sensorsRes, automationsRes, homesRes] =
    await Promise.all([
      db
        .from("board_instances")
        .select(
          "id,status,mqtt_connected,node_link_state,board_role,firmware_version,config_revision,last_heartbeat_at,last_communication_at,updated_at,created_at,room_id,home_id"
        )
        .eq("account_id", accountId)
        .is("deleted_at", null),
      db
        .from("switches")
        .select("id,is_on,is_online,board_instance_id,last_changed_at,updated_at,created_at")
        .eq("account_id", accountId)
        .is("deleted_at", null),
      db
        .from("devices")
        .select("id,state,is_online,board_instance_id,last_state_at,updated_at,created_at")
        .eq("account_id", accountId)
        .is("deleted_at", null),
      db
        .from("sensors")
        .select("id,last_value,is_online,board_instance_id,last_reading_at,updated_at,created_at")
        .eq("account_id", accountId)
        .is("deleted_at", null),
      db
        .from("automation_rules")
        .select("id,last_executed_at,last_execution_status,enabled,updated_at,created_at")
        .eq("account_id", accountId)
        .is("deleted_at", null),
      db
        .from("homes")
        .select("id,name,updated_at,created_at")
        .eq("account_id", accountId)
        .is("deleted_at", null),
    ]);

  const failed: Array<[string, { message?: string } | null | undefined]> = [
    ["boards", boardsRes.error],
    ["switches", switchesRes.error],
    ["devices", devicesRes.error],
    ["sensors", sensorsRes.error],
    ["automations", automationsRes.error],
    ["homes", homesRes.error],
  ];
  const firstFailure = failed.find(([, error]) => Boolean(error));
  if (firstFailure) {
    throw new RealtimeSnapshotError(
      firstFailure[0],
      firstFailure[1]?.message ?? "database error"
    );
  }

  const boards = ((boardsRes.data ?? []) as SnapshotRow[]).map((row) => ({
    id: String(row.id),
    version: versionOf(row, "last_communication_at", "updated_at"),
    status: row.status ?? null,
    mqttConnected: row.mqtt_connected ?? null,
    nodeLinkState: row.node_link_state ?? null,
    boardRole: row.board_role ?? null,
    firmwareVersion: row.firmware_version ?? null,
    configRevision: row.config_revision ?? null,
    lastHeartbeatAt: row.last_heartbeat_at ?? null,
    roomId: row.room_id ?? null,
    homeId: row.home_id ?? null,
  }));

  const switches = ((switchesRes.data ?? []) as SnapshotRow[]).map((row) => ({
    id: String(row.id),
    version: versionOf(row, "last_changed_at", "updated_at"),
    isOn: row.is_on ?? null,
    isOnline: row.is_online ?? null,
    boardInstanceId: row.board_instance_id ?? null,
  }));

  const devices = ((devicesRes.data ?? []) as SnapshotRow[]).map((row) => ({
    id: String(row.id),
    version: versionOf(row, "last_state_at", "updated_at"),
    state: row.state ?? null,
    isOnline: row.is_online ?? null,
    boardInstanceId: row.board_instance_id ?? null,
  }));

  const sensors = ((sensorsRes.data ?? []) as SnapshotRow[]).map((row) => ({
    id: String(row.id),
    version: versionOf(row, "last_reading_at", "updated_at"),
    lastValue: row.last_value ?? null,
    isOnline: row.is_online ?? null,
    boardInstanceId: row.board_instance_id ?? null,
  }));

  const automations = ((automationsRes.data ?? []) as SnapshotRow[]).map((row) => ({
    id: String(row.id),
    version: versionOf(row, "last_executed_at", "updated_at"),
    lastExecutionStatus: row.last_execution_status ?? null,
    enabled: row.enabled ?? null,
  }));

  const homes = ((homesRes.data ?? []) as SnapshotRow[]).map((row) => ({
    id: String(row.id),
    version: versionOf(row, "updated_at"),
    name: row.name ?? null,
  }));

  return {
    v: 1,
    accountId,
    serverTime: new Date().toISOString(),
    entities: { boards, switches, devices, sensors, automations, homes },
  };
}

/**
 * Small factory so call sites stay one line and timestamps stay consistent.
 *
 * `version` should be the row value the snapshot also reports for this entity
 * (`last_changed_at`, `last_state_at`, `last_reading_at`, `last_executed_at`,
 * `last_communication_at`/`updated_at`). When it is supplied the browser can
 * reconcile an entity without reloading it, because the event and the snapshot
 * speak about the same revision.
 */
export function makeRealtimeEvent(
  entity: RealtimeEntity,
  action: RealtimeEventAction,
  id: string,
  patch?: Record<string, unknown>,
  phase?: RealtimeEventPhase,
  version?: string | null
): RealtimeEvent {
  const event: RealtimeEvent = {
    entity,
    action,
    id,
    ts: new Date().toISOString(),
  };
  if (patch) event.patch = patch;
  if (phase) event.phase = phase;
  if (version) event.version = version;
  return event;
}
