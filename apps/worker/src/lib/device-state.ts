import type { WorkerBindings } from "../config/env";
import { EmqxClient, isEmqxConfigured } from "./emqx";
import type { CustomFetch, DbClient } from "./db";

/**
 * Centralised device state management.
 *
 * Every source of a state change - manual switch/device toggles, automations,
 * action buttons, flow graphs - funnels through `applyCommand`. That gives one
 * place to enforce the invariants that make offline control reliable:
 *
 *  - a monotonic revision decides which command wins (latest valid intent wins),
 *  - duplicate/stale/out-of-order intents are rejected before any MQTT traffic,
 *  - the user's intent is persisted even when the controller is unreachable,
 *  - the controller is told the *state it should be in* rather than a one-shot
 *    pulse, so a restart or power failure reconciles from durable state.
 *
 * The write itself is an atomic, row-locked Postgres function
 * (`apply_entity_command`, migration 0022) so concurrent toggles cannot
 * interleave and a late request can never clobber a newer intent.
 */

export type EntityKind = "switch" | "device";

export type CommandSource = "manual" | "automation" | "action_button" | "flow";

export interface CommandTarget {
  kind: EntityKind;
  id: string;
}

export interface ApplyCommandParams {
  db: DbClient;
  env: WorkerBindings;
  deps?: { emqxFetch?: CustomFetch };
  accountId: string;
  target: CommandTarget;
  /** Full desired state, e.g. `{ on: true }` or `{ state: "on" }`. */
  desiredState: Record<string, unknown>;
  /** Client-observed revision; guards against out-of-order requests. */
  expectedRev?: number | null;
  source: CommandSource;
  actorUserId?: string | null;
}

export type ApplyCommandReason =
  | "accepted"
  | "not_found"
  | "stale_revision"
  | "already_applied"
  | "duplicate_pending";

export interface ApplyCommandResult {
  ok: boolean;
  accepted: boolean;
  reason: ApplyCommandReason;
  desiredState: Record<string, unknown> | null;
  appliedState: Record<string, unknown> | null;
  desiredRev: number;
  appliedRev: number;
  stateStatus: "synced" | "pending" | "failed" | "expired";
  /** True only when a command was actually handed to the broker. */
  dispatched: boolean;
  /** Controller reachability at dispatch time. */
  controllerOnline: boolean;
  error?: string;
}

interface CommandRow {
  accepted: boolean;
  reason: string;
  desired_state: Record<string, unknown> | null;
  applied_state: Record<string, unknown> | null;
  desired_rev: number | string;
  applied_rev: number | string;
  state_status: "synced" | "pending" | "failed" | "expired";
}

function toRev(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Resolves the owning controller plus the fields the firmware needs. */
async function resolveEntityDetails(
  db: DbClient,
  accountId: string,
  target: CommandTarget
): Promise<{ controllerId: string; details: EntityCommandDetails } | null> {
  if (target.kind === "switch") {
    const { data } = await db
      .from("switches")
      .select("controller_id,gpio_pin,inverted")
      .eq("id", target.id)
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .maybeSingle();
    const row = data as
      | { controller_id: string; gpio_pin: number; inverted: boolean }
      | null;
    if (!row) return null;
    return {
      controllerId: row.controller_id,
      details: { gpio_pin: row.gpio_pin, inverted: row.inverted },
    };
  }

  const { data } = await db
    .from("devices")
    .select("controller_id,gpio_pin,device_type")
    .eq("id", target.id)
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .maybeSingle();
  const row = data as
    | { controller_id: string; gpio_pin: number; device_type: string }
    | null;
  if (!row) return null;
  return {
    controllerId: row.controller_id,
    details: { gpio_pin: row.gpio_pin, device_type: row.device_type },
  };
}

async function isControllerReachable(
  db: DbClient,
  accountId: string,
  controllerId: string
): Promise<boolean> {
  const { data } = await db
    .from("controllers")
    .select("status")
    .eq("id", controllerId)
    .eq("account_id", accountId)
    .maybeSingle();
  return (data as { status?: string } | null)?.status === "online";
}

/**
 * Builds the MQTT payload. The payload carries the desired revision so a
 * controller (and the broker, which retains nothing by default) can discard a
 * command it has already superseded.
 */
interface EntityCommandDetails {
  gpio_pin: number;
  inverted?: boolean;
  device_type?: string;
}

/**
 * Builds the MQTT payload.
 *
 * The shape is dictated by the *deployed* firmware: `handle_switch_cmd` and
 * `handle_device_cmd` both act on `gpio_pin` (and `inverted`) carried in the
 * command itself, so those fields must always be present. `rev` is additive and
 * ignored by older firmware, which keeps the payload backward compatible.
 */
function buildCommandPayload(
  target: CommandTarget,
  desiredState: Record<string, unknown>,
  revision: number,
  source: CommandSource,
  details: EntityCommandDetails,
  actorUserId?: string | null
): Record<string, unknown> {
  const base = {
    gpio_pin: details.gpio_pin,
    rev: revision,
    source,
    ...(actorUserId ? { actor_user_id: actorUserId } : {}),
  };

  if (target.kind === "switch") {
    const on = Boolean(desiredState.on);
    return {
      switch_id: target.id,
      state: on ? "ON" : "OFF",
      inverted: Boolean(details.inverted),
      ...base,
    };
  }

  const state = typeof desiredState.state === "string" ? desiredState.state : "inactive";
  return {
    device_id: target.id,
    device_type: details.device_type ?? "",
    state,
    active: isDeviceStateActive(state),
    ...base,
  };
}

/** Minimal boolean-state interpretation for the `active` flag. */
function isDeviceStateActive(state: string): boolean {
  const normalized = state.trim().toLowerCase();
  return ACTIVE_DEVICE_STATES.has(normalized);
}

const ACTIVE_DEVICE_STATES = new Set([
  "on",
  "active",
  "open",
  "unlocked",
  "true",
  "1",
  "low",
  "medium",
  "high",
  "speed_1",
  "speed_2",
  "speed_3",
  "speed_4",
  "speed_5",
]);

async function publishCommand(params: {
  db: DbClient;
  env: WorkerBindings;
  deps?: { emqxFetch?: CustomFetch };
  accountId: string;
  controllerId: string;
  target: CommandTarget;
  desiredState: Record<string, unknown>;
  revision: number;
  source: CommandSource;
  details: EntityCommandDetails;
  actorUserId?: string | null;
}): Promise<{ dispatched: boolean; error?: string }> {
  if (!isEmqxConfigured(params.env)) return { dispatched: false };

  const { data: cred } = await params.db
    .from("mqtt_credentials_metadata")
    .select("topic_prefix,status")
    .eq("controller_id", params.controllerId)
    .eq("account_id", params.accountId)
    .eq("status", "active")
    .maybeSingle();

  const record = cred as { topic_prefix?: string } | null;
  if (!record?.topic_prefix) return { dispatched: false };

  try {
    const emqx = new EmqxClient(params.env, params.deps?.emqxFetch);
    const topic =
      params.target.kind === "switch"
        ? `${record.topic_prefix}/cmd/switch`
        : `${record.topic_prefix}/cmd/device`;
    await emqx.publish({
      topic,
      payload: buildCommandPayload(
        params.target,
        params.desiredState,
        params.revision,
        params.source,
        params.details,
        params.actorUserId
      ),
      qos: 1,
    });
    return { dispatched: true };
  } catch (err) {
    return {
      dispatched: false,
      error: err instanceof Error ? err.message : "Failed to dispatch MQTT command.",
    };
  }
}

/**
 * Records a failed delivery attempt. Attempts are capped by the caller; this
 * only mirrors the error so the UI can distinguish "waiting" from "gave up".
 */
async function markCommandFailed(
  db: DbClient,
  accountId: string,
  target: CommandTarget,
  error: string
): Promise<void> {
  const table = target.kind === "switch" ? "switches" : "devices";
  await db
    .from(table)
    .update({
      state_status: "failed",
      state_error: error.slice(0, 240),
      updated_at: new Date().toISOString(),
    })
    .eq("id", target.id)
    .eq("account_id", accountId)
    .is("deleted_at", null);
}

/**
 * The single entry point for changing device/switch state.
 *
 * Returns `accepted: false` for idempotent no-ops (duplicate or stale intents);
 * those must not be published to MQTT, which is what suppresses redundant
 * traffic during rapid toggling.
 */
export async function applyCommand(params: ApplyCommandParams): Promise<ApplyCommandResult> {
  const { db, env, accountId, target, desiredState, source } = params;

  const resolved = await resolveEntityDetails(db, accountId, target);
  if (!resolved) {
    return {
      ok: false,
      accepted: false,
      reason: "not_found",
      desiredState: null,
      appliedState: null,
      desiredRev: 0,
      appliedRev: 0,
      stateStatus: "synced",
      dispatched: false,
      controllerOnline: false,
    };
  }
  const { controllerId, details } = resolved;

  // Atomic, row-locked intake. This is the only writer of desired state.
  const { data, error } = await db.rpc("apply_entity_command", {
    p_entity_kind: target.kind,
    p_entity_id: target.id,
    p_account_id: accountId,
    p_desired_state: desiredState,
    p_expected_rev: params.expectedRev ?? null,
  });

  if (error) {
    return {
      ok: false,
      accepted: false,
      reason: "not_found",
      desiredState: null,
      appliedState: null,
      desiredRev: 0,
      appliedRev: 0,
      stateStatus: "synced",
      dispatched: false,
      controllerOnline: false,
      error: error.message,
    };
  }

  const row = (Array.isArray(data) ? data[0] : data) as CommandRow | null;
  if (!row) {
    return {
      ok: false,
      accepted: false,
      reason: "not_found",
      desiredState: null,
      appliedState: null,
      desiredRev: 0,
      appliedRev: 0,
      stateStatus: "synced",
      dispatched: false,
      controllerOnline: false,
    };
  }

  const desiredRev = toRev(row.desired_rev);
  const appliedRev = toRev(row.applied_rev);
  const base: ApplyCommandResult = {
    ok: true,
    accepted: row.accepted,
    reason: row.reason as ApplyCommandReason,
    desiredState: row.desired_state,
    appliedState: row.applied_state,
    desiredRev,
    appliedRev,
    stateStatus: row.state_status,
    dispatched: false,
    controllerOnline: false,
  };

  // Nothing to send: duplicate / stale / already-true. This is the branch that
  // keeps rapid toggling from generating MQTT traffic.
  if (!row.accepted) {
    if (row.reason === "already_applied") {
      base.stateStatus = "synced";
    }
    return base;
  }

  // Intent collapsed back to confirmed reality - no controller action needed.
  if (row.state_status === "synced" && row.desired_state === null) {
    return base;
  }

  const online = await isControllerReachable(db, accountId, controllerId);
  base.controllerOnline = online;

  // Offline: the intent is already durable, so it is delivered on reconnect by
  // the config snapshot / reconciliation sweep. Do not spam the broker.
  if (!online) return base;

  const published = await publishCommand({
    db,
    env,
    deps: params.deps,
    accountId,
    controllerId,
    target,
    desiredState: row.desired_state ?? desiredState,
    revision: desiredRev,
    source,
    details,
    actorUserId: params.actorUserId,
  });

  if (published.dispatched) {
    base.dispatched = true;
    return base;
  }

  if (published.error) {
    await markCommandFailed(db, accountId, target, published.error);
    base.stateStatus = "failed";
    base.error = published.error;
  }

  return base;
}

export interface ReconcilableCommand {
  kind: EntityKind;
  id: string;
  desiredState: Record<string, unknown>;
  revision: number;
  details: EntityCommandDetails;
}

/**
 * Collects outstanding intents that a controller still has to apply. Used by
 * the config snapshot so a rebooted controller re-derives state from durable
 * cloud intent instead of its own stale NVS cache.
 */
export async function loadPendingCommands(
  db: DbClient,
  accountId: string,
  controllerId: string
): Promise<ReconcilableCommand[]> {
  const [switches, devices] = await Promise.all([
    db
      .from("switches")
      .select("id,desired_state,desired_rev,gpio_pin,inverted")
      .eq("account_id", accountId)
      .eq("controller_id", controllerId)
      .eq("state_status", "pending")
      .is("deleted_at", null),
    db
      .from("devices")
      .select("id,desired_state,desired_rev,gpio_pin,device_type")
      .eq("account_id", accountId)
      .eq("controller_id", controllerId)
      .eq("state_status", "pending")
      .is("deleted_at", null),
  ]);

  const out: ReconcilableCommand[] = [];
  for (const row of (switches.data ?? []) as Array<{
    id: string;
    desired_state: Record<string, unknown> | null;
    desired_rev: number | string;
    gpio_pin: number;
    inverted: boolean;
  }>) {
    if (!row.desired_state) continue;
    out.push({
      kind: "switch",
      id: row.id,
      desiredState: row.desired_state,
      revision: toRev(row.desired_rev),
      details: { gpio_pin: row.gpio_pin, inverted: row.inverted },
    });
  }
  for (const row of (devices.data ?? []) as Array<{
    id: string;
    desired_state: Record<string, unknown> | null;
    desired_rev: number | string;
    gpio_pin: number;
    device_type: string;
  }>) {
    if (!row.desired_state) continue;
    out.push({
      kind: "device",
      id: row.id,
      desiredState: row.desired_state,
      revision: toRev(row.desired_rev),
      details: { gpio_pin: row.gpio_pin, device_type: row.device_type },
    });
  }
  return out;
}

/**
 * Confirms state reported by a controller. Only reports at least as new as the
 * outstanding intent clear it; older reports are ignored so a delayed
 * duplicate acknowledgement cannot resurrect a stale state.
 */
export async function confirmEntityState(params: {
  db: DbClient;
  accountId: string;
  target: CommandTarget;
  appliedState: Record<string, unknown>;
  appliedRev?: number | null;
}): Promise<{ confirmed: boolean; stateStatus: string }> {
  const { db, accountId, target } = params;
  const { data, error } = await db.rpc("confirm_entity_state", {
    p_entity_kind: target.kind,
    p_entity_id: target.id,
    p_account_id: accountId,
    p_applied_state: params.appliedState,
    p_applied_rev: params.appliedRev ?? null,
  });

  if (error) return { confirmed: false, stateStatus: "unknown" };
  const row = (Array.isArray(data) ? data[0] : data) as
    | { confirmed: boolean; state_status: string }
    | null;
  if (!row) return { confirmed: false, stateStatus: "unknown" };
  return { confirmed: row.confirmed, stateStatus: row.state_status };
}

/**
 * Redelivers outstanding intents to a controller that has just reconnected.
 *
 * Called from the heartbeat ingest path, which is the natural "controller is
 * reachable again" signal and needs no extra scheduler. Idempotent: rows are
 * only read while `state_status = 'pending'`, and `confirmEntityState` clears
 * them once the controller reports the applied revision.
 *
 * Returns the number of commands actually handed to the broker.
 */
export async function reconcilePendingCommands(params: {
  db: DbClient;
  env: WorkerBindings;
  deps?: { emqxFetch?: CustomFetch };
  accountId: string;
  controllerId: string;
}): Promise<number> {
  const pending = await loadPendingCommands(params.db, params.accountId, params.controllerId);
  if (pending.length === 0) return 0;

  let delivered = 0;
  for (const command of pending) {
    const published = await publishCommand({
      db: params.db,
      env: params.env,
      deps: params.deps,
      accountId: params.accountId,
      controllerId: params.controllerId,
      target: { kind: command.kind, id: command.id },
      desiredState: command.desiredState,
      revision: command.revision,
      source: "manual",
      details: command.details,
    });
    if (published.dispatched) delivered += 1;
  }
  return delivered;
}
