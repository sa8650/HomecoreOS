import {
  normalizeConditionGroups,
  normalizeTriggerList,
  type AutomationActionItem,
  type AutomationConditionsConfig,
  type AutomationTriggerConfig,
} from "@homecoreos/shared";
import type { WorkerBindings } from "../config/env";
import { sha256Hex } from "./crypto";
import type { CustomFetch, DbClient } from "./db";
import { EmqxClient, isEmqxConfigured } from "./emqx";

export interface ConsolidatedControllerConfigSnapshot {
  schema: 2;
  controllerId: string;
  revision: number;
  hash: string;
  settings: {
    controllerName: string;
    heartbeatIntervalSec: number;
    telemetryBatchSec: number;
    timezone: string;
  };
  gpioConfig: Array<{
    pin: number;
    kind: "switch" | "device" | "sensor";
    id: string;
    inverted?: boolean;
    deviceType?: string;
    sensorType?: string;
  }>;
  switches: Array<{
    id: string;
    name: string;
    gpio_pin: number;
    is_on: boolean;
    inverted: boolean;
  }>;
  devices: Array<{
    id: string;
    name: string;
    device_type: string;
    gpio_pin: number;
    state: string;
    config: Record<string, unknown>;
  }>;
  sensors: Array<{
    id: string;
    name: string;
    sensor_type: string;
    gpio_pin: number | null;
    unit: string;
    i2c_address?: string | null;
  }>;
  automations: Array<{
    id: string;
    name: string;
    execution_mode: string;
    trigger_config: Record<string, unknown>;
    conditions_config: unknown[];
    actions_config: unknown[];
  }>;
  localAutomations: Array<{
    id: string;
    name: string;
    execution_mode: string;
    trigger_config: Record<string, unknown>;
    conditions_config: unknown[];
    actions_config: unknown[];
  }>;
}

export interface ConfigSyncResult {
  revision: number;
  hash: string;
  changed: boolean;
  published: boolean;
  queuedForReconnect: boolean;
  skippedReason?: "unchanged" | "already_synced" | "no_credentials" | "emqx_unconfigured" | "offline_queued";
  snapshot: ConsolidatedControllerConfigSnapshot;
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableJsonStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * Builds one consolidated controller configuration snapshot AND computes a
 * deterministic structural SHA-256 hash. Volatile runtime fields (switch is_on,
 * device runtime state, sensor last_value) are excluded from the structural hash
 * so routine state toggles and telemetry NEVER cause redundant full config publishes.
 */
export async function buildConsolidatedControllerConfig(
  db: DbClient,
  accountId: string,
  controllerId: string
): Promise<{
  snapshot: ConsolidatedControllerConfigSnapshot;
  structuralHash: string;
  controllerRow: {
    id: string;
    name: string;
    home_id: string;
    status: string;
    mqtt_connected: boolean;
    config_revision: number;
    config_hash: string | null;
    last_synced_config_revision: number;
    pending_config_sync: boolean;
    heartbeat_interval_sec: number;
  } | null;
}> {
  const [ctrlRes, settingsRes, homesRes, swRes, devRes, senRes, rulesRes] =
    await Promise.all([
      db
        .from("controllers")
        .select(
          "id,name,home_id,status,mqtt_connected,config_revision,config_hash,last_synced_config_revision,pending_config_sync,heartbeat_interval_sec"
        )
        .eq("id", controllerId)
        .eq("account_id", accountId)
        .is("deleted_at", null)
        .is("permanently_deleted_at", null)
        .maybeSingle(),
      db
        .from("platform_settings")
        .select("controller_heartbeat_interval_seconds,default_timezone")
        .eq("id", 1)
        .maybeSingle(),
      db
        .from("homes")
        .select("id,timezone")
        .eq("account_id", accountId)
        .is("deleted_at", null),
      db
        .from("switches")
        .select("id,name,gpio_pin,is_on,inverted")
        .eq("controller_id", controllerId)
        .eq("account_id", accountId)
        .is("deleted_at", null)
        .order("gpio_pin", { ascending: true }),
      db
        .from("devices")
        .select("id,name,device_type,gpio_pin,state,config")
        .eq("controller_id", controllerId)
        .eq("account_id", accountId)
        .is("deleted_at", null)
        .order("gpio_pin", { ascending: true }),
      db
        .from("sensors")
        .select("id,name,sensor_type,gpio_pin,unit,last_raw_payload")
        .eq("controller_id", controllerId)
        .eq("account_id", accountId)
        .is("deleted_at", null)
        .order("name", { ascending: true }),
      db
        .from("automation_rules")
        .select(
          "id,name,execution_mode,trigger_config,conditions_config,actions_config"
        )
        .eq("account_id", accountId)
        .eq("enabled", true)
        .in("execution_mode", ["controller", "hybrid"])
        .is("deleted_at", null)
        .order("id", { ascending: true }),
    ]);

  const ctrl = ctrlRes.data as {
    id: string;
    name: string;
    home_id: string;
    status: string;
    mqtt_connected: boolean;
    config_revision: number;
    config_hash: string | null;
    last_synced_config_revision: number;
    pending_config_sync: boolean;
    heartbeat_interval_sec: number;
  } | null;

  const homeTimezone = ctrl?.home_id
    ? ((homesRes.data ?? []) as Array<{ id: string; timezone?: string | null }>).find(
        (h) => h.id === ctrl.home_id
      )?.timezone ?? null
    : null;

  const pSettings = settingsRes.data as {
    controller_heartbeat_interval_seconds?: number;
    default_timezone?: string;
  } | null;

  const heartbeatIntervalSec = Math.max(
    30,
    ctrl?.heartbeat_interval_sec ??
      pSettings?.controller_heartbeat_interval_seconds ??
      60
  );
  const telemetryBatchSec = heartbeatIntervalSec;
  const timezone = homeTimezone ?? pSettings?.default_timezone ?? "UTC";

  const switches = (swRes.data ?? []) as Array<{
    id: string;
    name: string;
    gpio_pin: number;
    is_on: boolean;
    inverted: boolean;
  }>;
  const devices = (devRes.data ?? []) as Array<{
    id: string;
    name: string;
    device_type: string;
    gpio_pin: number;
    state: string;
    config: Record<string, unknown>;
  }>;
  const sensorsRaw = (senRes.data ?? []) as Array<{
    id: string;
    name: string;
    sensor_type: string;
    gpio_pin: number | null;
    unit: string;
    last_raw_payload: Record<string, unknown> | null;
  }>;
  const sensors = sensorsRaw.map((s) => ({
    id: s.id,
    name: s.name,
    sensor_type: s.sensor_type,
    gpio_pin: s.gpio_pin,
    unit: s.unit,
    i2c_address:
      typeof s.last_raw_payload?.i2c_address === "string"
        ? s.last_raw_payload.i2c_address
        : null,
  }));

  const swSet = new Set(switches.map((s) => s.id));
  const devSet = new Set(devices.map((d) => d.id));
  const senSet = new Set(sensors.map((s) => s.id));

  const localAutomations = (
    (rulesRes.data ?? []) as Array<{
      id: string;
      name: string;
      execution_mode: string;
      trigger_config: AutomationTriggerConfig;
      conditions_config?: AutomationConditionsConfig | null;
      actions_config: AutomationActionItem[];
    }>
  )
    .filter((rule) => {
      const triggers = normalizeTriggerList(rule.trigger_config);
      if (triggers.length === 0) return false;
      const triggerFits = triggers.every(
        (t) =>
          (t.type === "sensor_value" && Boolean(t.sensorId) && senSet.has(t.sensorId!)) ||
          (t.type === "device_state" &&
            ((Boolean(t.switchId) && swSet.has(t.switchId!)) ||
              (Boolean(t.deviceId) && devSet.has(t.deviceId!))))
      );
      if (!triggerFits) return false;

      const actions = rule.actions_config ?? [];
      const actionsFit =
        actions.length > 0 &&
        actions.every((act) => {
          if (act.type === "scene") {
            return (
              Array.isArray(act.targets) &&
              act.targets.length > 0 &&
              act.targets.every((targ) =>
                targ.kind === "switch"
                  ? swSet.has(targ.switchId)
                  : devSet.has(targ.deviceId)
              )
            );
          }
          return (
            (Boolean(act.switchId) && swSet.has(act.switchId!)) ||
            (Boolean(act.deviceId) && devSet.has(act.deviceId!))
          );
        });
      if (!actionsFit) return false;

      const grouped = normalizeConditionGroups(rule.conditions_config);
      const condsFit = grouped.groups.every(
        (grp) =>
          grp.logic === "AND" &&
          grp.conditions.every(
            (cond) =>
              cond.type !== "room_state" &&
              cond.type !== "time_range" &&
              (!cond.sensorId || senSet.has(cond.sensorId)) &&
              (!cond.switchId || swSet.has(cond.switchId)) &&
              (!cond.deviceId || devSet.has(cond.deviceId))
          )
      );
      return condsFit;
    })
    .map((rule) => {
      const flatConditions = normalizeConditionGroups(rule.conditions_config).groups.flatMap(
        (g) => g.conditions
      );
      const expandedActions: AutomationActionItem[] = (rule.actions_config ?? []).flatMap((act) => {
        if (act.type === "scene" && Array.isArray(act.targets)) {
          return act.targets.map((targ): AutomationActionItem =>
            targ.kind === "switch"
              ? {
                  type: (targ.isOn ? "switch_on" : "switch_off") as "switch_on" | "switch_off",
                  switchId: targ.switchId,
                }
              : {
                  type: "device_state" as const,
                  deviceId: targ.deviceId,
                  targetState: targ.targetState,
                }
          );
        }
        return [act];
      });
      return {
        id: rule.id,
        name: rule.name,
        execution_mode: rule.execution_mode,
        trigger_config: rule.trigger_config as unknown as Record<string, unknown>,
        conditions_config: flatConditions,
        actions_config: expandedActions,
      };
    });

  const gpioConfig: ConsolidatedControllerConfigSnapshot["gpioConfig"] = [
    ...switches.map((s) => ({
      pin: s.gpio_pin,
      kind: "switch" as const,
      id: s.id,
      inverted: s.inverted,
    })),
    ...devices.map((d) => ({
      pin: d.gpio_pin,
      kind: "device" as const,
      id: d.id,
      deviceType: d.device_type,
    })),
    ...sensors
      .filter((s) => s.gpio_pin !== null)
      .map((s) => ({
        pin: s.gpio_pin!,
        kind: "sensor" as const,
        id: s.id,
        sensorType: s.sensor_type,
      })),
  ].sort((a, b) => a.pin - b.pin);

  const settings = {
    controllerName: ctrl?.name ?? "Controller",
    heartbeatIntervalSec,
    telemetryBatchSec,
    timezone,
  };

  // Canonical structural state (excludes volatile runtime values)
  const structuralPayload = {
    settings,
    switches: switches.map((s) => ({
      id: s.id,
      name: s.name,
      gpio_pin: s.gpio_pin,
      inverted: s.inverted,
    })),
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      device_type: d.device_type,
      gpio_pin: d.gpio_pin,
      config: d.config ?? {},
    })),
    sensors: sensors.map((s) => ({
      id: s.id,
      name: s.name,
      sensor_type: s.sensor_type,
      gpio_pin: s.gpio_pin,
      unit: s.unit,
      i2c_address: s.i2c_address ?? null,
    })),
    automations: localAutomations,
  };

  const fullSha = await sha256Hex(stableJsonStringify(structuralPayload));
  const structuralHash = fullSha.slice(0, 16);
  const revision = ctrl?.config_revision ?? 1;

  const snapshot: ConsolidatedControllerConfigSnapshot = {
    schema: 2,
    controllerId,
    revision,
    hash: structuralHash,
    settings,
    gpioConfig,
    switches,
    devices,
    sensors,
    automations: localAutomations,
    localAutomations,
  };

  return {
    snapshot,
    structuralHash,
    controllerRow: ctrl,
  };
}

/**
 * Publishes one consolidated configuration snapshot ONLY when:
 * - structural configuration actually changed (hash mismatch), OR
 * - controller reconnected while behind (last_synced_config_revision < revision or pending_config_sync), OR
 * - explicit sync was requested with forcePublish.
 *
 * If the controller is currently offline, sets pending_config_sync=true so it
 * receives the latest consolidated snapshot immediately upon reconnect.
 */
export async function syncControllerConfigSnapshot(
  db: DbClient,
  env: WorkerBindings,
  deps: { emqxFetch?: CustomFetch },
  params: {
    accountId: string;
    controllerId: string;
    reason: "config_change" | "reconnect" | "explicit_sync";
    forcePublish?: boolean;
  }
): Promise<ConfigSyncResult> {
  const built = await buildConsolidatedControllerConfig(
    db,
    params.accountId,
    params.controllerId
  );

  const ctrl = built.controllerRow;
  if (!ctrl) {
    return {
      revision: 1,
      hash: built.structuralHash,
      changed: false,
      published: false,
      queuedForReconnect: false,
      skippedReason: "no_credentials",
      snapshot: built.snapshot,
    };
  }

  const hashChanged =
    ctrl.config_hash !== null && ctrl.config_hash !== built.structuralHash;
  const firstHashInit = ctrl.config_hash === null;

  let nextRevision = ctrl.config_revision;
  let pendingSync = Boolean(ctrl.pending_config_sync);

  if (hashChanged) {
    nextRevision = ctrl.config_revision + 1;
    pendingSync = true;
  }

  const finalSnapshot: ConsolidatedControllerConfigSnapshot = {
    ...built.snapshot,
    revision: nextRevision,
    hash: built.structuralHash,
  };

  // Deduplication rules:
  // 1. config_change with identical structural hash -> never republish
  if (params.reason === "config_change" && !hashChanged && !firstHashInit && !params.forcePublish) {
    return {
      revision: nextRevision,
      hash: built.structuralHash,
      changed: false,
      published: false,
      queuedForReconnect: false,
      skippedReason: "unchanged",
      snapshot: finalSnapshot,
    };
  }

  // 2. reconnect when controller already has latest revision synced -> never republish
  const needsSync =
    hashChanged ||
    pendingSync ||
    ctrl.last_synced_config_revision < nextRevision;

  if (params.reason === "reconnect" && !needsSync && !params.forcePublish) {
    return {
      revision: nextRevision,
      hash: built.structuralHash,
      changed: false,
      published: false,
      queuedForReconnect: false,
      skippedReason: "already_synced",
      snapshot: finalSnapshot,
    };
  }

  // 3. Offline handling: retain/queue latest revision in DB and deliver when online
  const isOnline = ctrl.status === "online" || ctrl.mqtt_connected;
  if (!isOnline && params.reason !== "reconnect") {
    await db
      .from("controllers")
      .update({
        ...(hashChanged ? { config_revision: nextRevision } : {}),
        config_hash: built.structuralHash,
        pending_config_sync: true,
      })
      .eq("id", ctrl.id)
      .eq("account_id", params.accountId);

    return {
      revision: nextRevision,
      hash: built.structuralHash,
      changed: hashChanged || firstHashInit,
      published: false,
      queuedForReconnect: true,
      skippedReason: "offline_queued",
      snapshot: finalSnapshot,
    };
  }

  // 4. Publish ONE consolidated MQTT snapshot (QoS 1, retain: false)
  if (!isEmqxConfigured(env)) {
    if (hashChanged || firstHashInit) {
      await db
        .from("controllers")
        .update({
          ...(hashChanged ? { config_revision: nextRevision, pending_config_sync: true } : {}),
          config_hash: built.structuralHash,
        })
        .eq("id", ctrl.id)
        .eq("account_id", params.accountId);
    }
    return {
      revision: nextRevision,
      hash: built.structuralHash,
      changed: hashChanged || firstHashInit,
      published: false,
      queuedForReconnect: true,
      skippedReason: "emqx_unconfigured",
      snapshot: finalSnapshot,
    };
  }

  // Run controller revision/hash update in parallel with MQTT credential fetch
  const [, credRes] = await Promise.all([
    hashChanged || firstHashInit
      ? db
          .from("controllers")
          .update({
            ...(hashChanged ? { config_revision: nextRevision, pending_config_sync: true } : {}),
            config_hash: built.structuralHash,
          })
          .eq("id", ctrl.id)
          .eq("account_id", params.accountId)
      : Promise.resolve({ data: null }),
    db
      .from("mqtt_credentials_metadata")
      .select("topic_prefix,status")
      .eq("controller_id", ctrl.id)
      .eq("account_id", params.accountId)
      .eq("status", "active")
      .maybeSingle(),
  ]);
  const cred = credRes.data;

  if (!cred) {
    return {
      revision: nextRevision,
      hash: built.structuralHash,
      changed: hashChanged || firstHashInit,
      published: false,
      queuedForReconnect: true,
      skippedReason: "no_credentials",
      snapshot: finalSnapshot,
    };
  }

  const emqx = new EmqxClient(env, deps.emqxFetch);
  await emqx.publish({
    topic: `${(cred as { topic_prefix: string }).topic_prefix}/config/snapshot`,
    payload: finalSnapshot as unknown as Record<string, unknown>,
    qos: 1,
    retain: false,
  });

  const nowIso = new Date().toISOString();
  await db
    .from("controllers")
    .update({
      config_hash: built.structuralHash,
      last_config_published_at: nowIso,
      // On reconnect sync or explicit sync, mark synced only once acknowledged via ack/config fetch,
      // OR keep pending_config_sync true until device confirms revision (or if config_change already delivered QoS 1).
    })
    .eq("id", ctrl.id)
    .eq("account_id", params.accountId);

  return {
    revision: nextRevision,
    hash: built.structuralHash,
    changed: hashChanged || firstHashInit,
    published: true,
    queuedForReconnect: false,
    snapshot: finalSnapshot,
  };
}

export async function acknowledgeControllerConfigRevision(
  db: DbClient,
  accountId: string,
  controllerId: string,
  revision: number
): Promise<void> {
  if (!Number.isFinite(revision) || revision <= 0) return;

  const { data: ctrl } = await db
    .from("controllers")
    .select("config_revision,last_synced_config_revision")
    .eq("id", controllerId)
    .eq("account_id", accountId)
    .maybeSingle();

  if (!ctrl) return;
  const row = ctrl as {
    config_revision: number;
    last_synced_config_revision: number;
  };

  const nextSynced = Math.max(row.last_synced_config_revision ?? 0, revision);
  const nowIso = new Date().toISOString();

  await db
    .from("controllers")
    .update({
      last_synced_config_revision: nextSynced,
      last_config_synced_at: nowIso,
      pending_config_sync: nextSynced < row.config_revision,
    })
    .eq("id", controllerId)
    .eq("account_id", accountId);
}

export async function syncControllersForAccount(
  db: DbClient,
  env: WorkerBindings,
  deps: { emqxFetch?: CustomFetch },
  accountId: string,
  reason: "config_change" | "explicit_sync" = "config_change"
): Promise<void> {
  const { data: ctrls } = await db
    .from("controllers")
    .select("id")
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .is("permanently_deleted_at", null);

  for (const ctrl of (ctrls ?? []) as Array<{ id: string }>) {
    try {
      await syncControllerConfigSnapshot(db, env, deps, {
        accountId,
        controllerId: ctrl.id,
        reason,
      });
    } catch {
      // Do not block API writes if broker is temporarily unreachable
    }
  }
}
