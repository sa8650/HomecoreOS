import {
  analyzeFlowGraphLocalCapability,
  analyzeLocalAutomationCapability,
  computeSunTimeHHMM,
  isDeviceStateActive,
  isValidIanaTimezone,
  normalizeConditionGroups,
  normalizeTriggerList,
  resolveEffectiveTimezone,
  type AutomationActionItem,
  type AutomationConditionItem,
  type AutomationConditionsConfig,
  type AutomationOperator,
  type AutomationTriggerConfig,
  type AutomationTriggerItem,
  type FlowActionNodeConfig,
  type FlowConditionNodeConfig,
  type FlowDelayNodeConfig,
  type FlowEndNodeConfig,
  type FlowExecutionTrace,
  type FlowGraph,
  type FlowLogicNodeConfig,
  type FlowNode,
  type FlowNodeExecutionTrace,
  type FlowTriggerNodeConfig,
  type SceneTargetItem,
} from "@homecoreos/shared";
import type { WorkerBindings } from "../config/env";
import { recordActivity } from "./audit";
import type { CustomFetch, DbClient } from "./db";
import { EmqxClient, isEmqxConfigured } from "./emqx";
import { emitNotification } from "./notifications";

export type AutomationTrigger = AutomationTriggerConfig;
export type AutomationAction = AutomationActionItem;
export type AutomationCondition = AutomationConditionItem;

interface AutomationRuleRow {
  id: string;
  account_id: string;
  home_id: string | null;
  name: string;
  enabled: boolean;
  execution_mode: "cloud" | "controller" | "hybrid";
  trigger_config: AutomationTriggerConfig;
  conditions_config: AutomationConditionsConfig | null;
  actions_config: AutomationActionItem[];
  flow_graph?: FlowGraph | null;
  last_executed_at: string | null;
}

const MAX_AUTOMATION_CHAIN_DEPTH = 5;

function compareNumeric(
  actual: number,
  operator: AutomationOperator | undefined,
  threshold: number
): boolean {
  switch (operator) {
    case "gt":
      return actual > threshold;
    case "gte":
      return actual >= threshold;
    case "lt":
      return actual < threshold;
    case "lte":
      return actual <= threshold;
    case "eq":
      return actual === threshold;
    case "neq":
      return actual !== threshold;
    default:
      return false;
  }
}

export function parseExpectedBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const norm = value.trim().toLowerCase();
    if (norm === "true" || norm === "on" || norm === "1" || norm === "yes") return true;
    if (norm === "false" || norm === "off" || norm === "0" || norm === "no") return false;
  }
  return null;
}

function getZonedClockParts(date: Date, timezone: string): {
  hhmm: string;
  minutesSinceMidnight: number;
  weekday: string;
  minuteKey: string;
} {
  const safeTz = isValidIanaTimezone(timezone) ? timezone : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = new Map<string, string>();
  for (const part of parts) {
    map.set(part.type, part.value);
  }
  const rawHour = map.get("hour") ?? "00";
  const hour = rawHour === "24" ? "00" : rawHour.padStart(2, "0");
  const minute = (map.get("minute") ?? "00").padStart(2, "0");
  const year = map.get("year") ?? "1970";
  const month = map.get("month") ?? "01";
  const day = map.get("day") ?? "01";
  const weekday = (map.get("weekday") ?? "mon").slice(0, 3).toLowerCase();

  return {
    hhmm: `${hour}:${minute}`,
    minutesSinceMidnight: Number.parseInt(hour, 10) * 60 + Number.parseInt(minute, 10),
    weekday,
    minuteKey: `${year}-${month}-${day} ${hour}:${minute}`,
  };
}

function parseHhmmMinutes(hhmm: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10) * 60 + Number.parseInt(match[2]!, 10);
}

async function evaluateSingleCondition(
  db: DbClient,
  accountId: string,
  cond: AutomationConditionItem,
  now: Date,
  fallbackTimezone: string
): Promise<{ matched: boolean; detail: string }> {
  if (cond.type === "sensor_value" && cond.sensorId && typeof cond.threshold === "number") {
    const { data: sensor } = await db
      .from("sensors")
      .select("name,last_value,unit")
      .eq("id", cond.sensorId)
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .maybeSingle();
    const row = sensor as { name?: string; last_value?: number | null; unit?: string } | null;
    const val = row?.last_value;
    const matched =
      typeof val === "number" && compareNumeric(val, cond.operator ?? "eq", cond.threshold);
    return {
      matched,
      detail: `${row?.name ?? "Sensor"} current=${val ?? "none"}${row?.unit ? ` ${row.unit}` : ""}`,
    };
  }

  if (cond.type === "switch_state" && cond.switchId) {
    const expected = parseExpectedBoolean(cond.expectedState);
    if (expected === null) return { matched: false, detail: "Invalid expected switch state" };
    const { data: sw } = await db
      .from("switches")
      .select("name,is_on")
      .eq("id", cond.switchId)
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!sw) return { matched: false, detail: "Switch not found" };
    const row = sw as { name: string; is_on: boolean };
    const matched = Boolean(row.is_on) === expected;
    return {
      matched,
      detail: `${row.name} is ${row.is_on ? "ON" : "OFF"} (expected ${expected ? "ON" : "OFF"})`,
    };
  }

  if (cond.type === "device_state" && cond.deviceId) {
    const { data: dev } = await db
      .from("devices")
      .select("name,state")
      .eq("id", cond.deviceId)
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!dev) return { matched: false, detail: "Device not found" };
    const row = dev as { name: string; state: string };
    const matched =
      String(row.state).trim().toLowerCase() ===
      String(cond.expectedState ?? "").trim().toLowerCase();
    return {
      matched,
      detail: `${row.name} is "${row.state}" (expected "${cond.expectedState ?? ""}")`,
    };
  }

  if (cond.type === "room_state" && cond.roomId) {
    const [{ data: room }, { data: sws }, { data: devs }] = await Promise.all([
      db
        .from("rooms")
        .select("name")
        .eq("id", cond.roomId)
        .eq("account_id", accountId)
        .is("deleted_at", null)
        .maybeSingle(),
      db
        .from("switches")
        .select("is_on")
        .eq("room_id", cond.roomId)
        .eq("account_id", accountId)
        .is("deleted_at", null),
      db
        .from("devices")
        .select("state")
        .eq("room_id", cond.roomId)
        .eq("account_id", accountId)
        .is("deleted_at", null),
    ]);
    if (!room) return { matched: false, detail: "Room not found" };
    const roomName = (room as { name: string }).name;
    const states = [
      ...((sws ?? []) as Array<{ is_on: boolean }>).map((s) => Boolean(s.is_on)),
      ...((devs ?? []) as Array<{ state: string }>).map((d) => isDeviceStateActive(d.state)),
    ];
    const mode = cond.roomMatch ?? "all_on";
    let matched = false;
    if (mode === "all_on") {
      matched = states.length > 0 && states.every(Boolean);
    } else if (mode === "all_off") {
      matched = states.every((v) => !v);
    } else {
      matched = states.some(Boolean);
    }
    return {
      matched,
      detail: `Room "${roomName}" (${states.filter(Boolean).length}/${states.length} active, check=${mode})`,
    };
  }

  if (cond.type === "time_range" && cond.startTime && cond.endTime) {
    const startMin = parseHhmmMinutes(cond.startTime);
    const endMin = parseHhmmMinutes(cond.endTime);
    if (startMin === null || endMin === null) {
      return { matched: false, detail: "Invalid time range" };
    }
    const tz = resolveEffectiveTimezone(cond.timezone ?? null, fallbackTimezone);
    const parts = getZonedClockParts(now, tz);
    if (Array.isArray(cond.days) && cond.days.length > 0) {
      const normalizedDays = cond.days.map((d) => d.trim().slice(0, 3).toLowerCase());
      if (!normalizedDays.includes(parts.weekday)) {
        return {
          matched: false,
          detail: `Current day ${parts.weekday.toUpperCase()} not in active days`,
        };
      }
    }
    const cur = parts.minutesSinceMidnight;
    const matched =
      startMin <= endMin
        ? cur >= startMin && cur <= endMin
        : cur >= startMin || cur <= endMin;
    return {
      matched,
      detail: `Time ${parts.hhmm} (${tz}) in [${cond.startTime}..${cond.endTime}]`,
    };
  }

  return { matched: false, detail: "Unsupported or incomplete condition" };
}

async function evaluateConditionGroups(
  db: DbClient,
  accountId: string,
  conditionsConfig: AutomationConditionsConfig | null | undefined,
  now = new Date(),
  fallbackTimezone = "UTC"
): Promise<{
  matched: boolean;
  groupResults: Array<{
    logic: "AND" | "OR";
    matched: boolean;
    conditions: Array<{ type: string; matched: boolean; detail: string }>;
  }>;
}> {
  const normalized = normalizeConditionGroups(conditionsConfig);
  const activeGroups = normalized.groups.filter((g) => g.conditions.length > 0);
  if (activeGroups.length === 0) {
    return { matched: true, groupResults: [] };
  }

  const groupResults: Array<{
    logic: "AND" | "OR";
    matched: boolean;
    conditions: Array<{ type: string; matched: boolean; detail: string }>;
  }> = [];

  for (const group of activeGroups) {
    const results = await Promise.all(
      group.conditions.map(async (cond) => {
        const res = await evaluateSingleCondition(
          db,
          accountId,
          cond,
          now,
          fallbackTimezone
        );
        return { type: cond.type, ...res };
      })
    );
    const groupMatched =
      group.logic === "OR"
        ? results.some((r) => r.matched)
        : results.every((r) => r.matched);
    groupResults.push({
      logic: group.logic,
      matched: groupMatched,
      conditions: results,
    });
  }

  const matched =
    normalized.logic === "OR"
      ? groupResults.some((g) => g.matched)
      : groupResults.every((g) => g.matched);

  return { matched, groupResults };
}

async function conditionsAreSatisfied(
  db: DbClient,
  accountId: string,
  conditions: AutomationConditionsConfig | null | undefined,
  now = new Date(),
  fallbackTimezone = "UTC"
): Promise<boolean> {
  const res = await evaluateConditionGroups(
    db,
    accountId,
    conditions,
    now,
    fallbackTimezone
  );
  return res.matched;
}

async function executeSwitchTarget(params: {
  db: DbClient;
  emqx: EmqxClient | null;
  accountId: string;
  ruleId: string;
  switchId: string;
  desired: boolean;
  errors: string[];
  downstreamEvents: Array<
    | { kind: "device"; deviceId: string; state: string }
    | { kind: "switch"; switchId: string; isOn: boolean }
  >;
}): Promise<boolean> {
  const { db, emqx, accountId, ruleId, switchId, desired, errors, downstreamEvents } = params;
  const { data: swData } = await db
    .from("switches")
    .select("id,name,controller_id,gpio_pin,inverted,is_on")
    .eq("id", switchId)
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .maybeSingle();

  if (!swData) {
    errors.push(`Switch ${switchId} not found.`);
    return false;
  }
  const sw = swData as {
    id: string;
    name: string;
    controller_id: string;
    gpio_pin: number;
    inverted: boolean;
    is_on: boolean;
  };

  await db
    .from("switches")
    .update({
      is_on: desired,
      last_changed_at: new Date().toISOString(),
    })
    .eq("id", sw.id)
    .eq("account_id", accountId);

  if (emqx) {
    const { data: cred } = await db
      .from("mqtt_credentials_metadata")
      .select("topic_prefix,status")
      .eq("controller_id", sw.controller_id)
      .eq("account_id", accountId)
      .eq("status", "active")
      .maybeSingle();

    if (cred) {
      await emqx.publish({
        topic: `${(cred as { topic_prefix: string }).topic_prefix}/cmd/switch`,
        payload: {
          switch_id: sw.id,
          gpio_pin: sw.gpio_pin,
          state: desired ? "ON" : "OFF",
          inverted: sw.inverted,
          source: "automation",
          rule_id: ruleId,
        },
        qos: 1,
      });
    }
  }
  if (sw.is_on !== desired) {
    downstreamEvents.push({ kind: "switch", switchId: sw.id, isOn: desired });
  }
  return true;
}

async function executeDeviceTarget(params: {
  db: DbClient;
  emqx: EmqxClient | null;
  accountId: string;
  ruleId: string;
  deviceId: string;
  targetState: string;
  errors: string[];
  downstreamEvents: Array<
    | { kind: "device"; deviceId: string; state: string }
    | { kind: "switch"; switchId: string; isOn: boolean }
  >;
}): Promise<boolean> {
  const { db, emqx, accountId, ruleId, deviceId, targetState, errors, downstreamEvents } = params;
  const { data: devData } = await db
    .from("devices")
    .select("id,name,controller_id,gpio_pin,device_type,state")
    .eq("id", deviceId)
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .maybeSingle();

  if (!devData) {
    errors.push(`Device ${deviceId} not found.`);
    return false;
  }
  const dev = devData as {
    id: string;
    name: string;
    controller_id: string;
    gpio_pin: number;
    device_type: string;
    state: string;
  };

  await db
    .from("devices")
    .update({ state: targetState })
    .eq("id", dev.id)
    .eq("account_id", accountId);

  if (emqx) {
    const { data: cred } = await db
      .from("mqtt_credentials_metadata")
      .select("topic_prefix,status")
      .eq("controller_id", dev.controller_id)
      .eq("account_id", accountId)
      .eq("status", "active")
      .maybeSingle();

    if (cred) {
      await emqx.publish({
        topic: `${(cred as { topic_prefix: string }).topic_prefix}/cmd/device`,
        payload: {
          device_id: dev.id,
          device_type: dev.device_type,
          gpio_pin: dev.gpio_pin,
          state: targetState,
          source: "automation",
          rule_id: ruleId,
        },
        qos: 1,
      });
    }
  }
  if (dev.state !== targetState) {
    downstreamEvents.push({
      kind: "device",
      deviceId: dev.id,
      state: targetState,
    });
  }
  return true;
}

export async function executeAutomationActions(params: {
  db: DbClient;
  env: WorkerBindings;
  emqxFetch?: CustomFetch;
  accountId: string;
  ruleId: string;
  ruleName: string;
  actions: AutomationActionItem[];
  actorUserId?: string | null;
  visitedRuleIds?: Set<string>;
  executedAt?: Date;
  skipRuleStatusUpdate?: boolean;
}): Promise<{ executedCount: number; errors: string[] }> {
  const {
    db,
    env,
    emqxFetch,
    accountId,
    ruleId,
    ruleName,
    actions,
    actorUserId,
    visitedRuleIds,
    executedAt,
    skipRuleStatusUpdate,
  } = params;

  const emqx = isEmqxConfigured(env) ? new EmqxClient(env, emqxFetch) : null;
  const errors: string[] = [];
  let executedCount = 0;
  const downstreamEvents: Array<
    | { kind: "device"; deviceId: string; state: string }
    | { kind: "switch"; switchId: string; isOn: boolean }
  > = [];

  for (const action of actions) {
    try {
      if ((action.type === "switch_on" || action.type === "switch_off") && action.switchId) {
        const ok = await executeSwitchTarget({
          db,
          emqx,
          accountId,
          ruleId,
          switchId: action.switchId,
          desired: action.type === "switch_on",
          errors,
          downstreamEvents,
        });
        if (ok) executedCount += 1;
      } else if (action.type === "device_state" && action.deviceId && action.targetState) {
        const ok = await executeDeviceTarget({
          db,
          emqx,
          accountId,
          ruleId,
          deviceId: action.deviceId,
          targetState: action.targetState,
          errors,
          downstreamEvents,
        });
        if (ok) executedCount += 1;
      } else if (action.type === "scene" && Array.isArray(action.targets)) {
        for (const target of action.targets) {
          if (target.kind === "switch") {
            const ok = await executeSwitchTarget({
              db,
              emqx,
              accountId,
              ruleId,
              switchId: target.switchId,
              desired: target.isOn,
              errors,
              downstreamEvents,
            });
            if (ok) executedCount += 1;
          } else if (target.kind === "device") {
            const ok = await executeDeviceTarget({
              db,
              emqx,
              accountId,
              ruleId,
              deviceId: target.deviceId,
              targetState: target.targetState,
              errors,
              downstreamEvents,
            });
            if (ok) executedCount += 1;
          }
        }
      } else {
        errors.push(`Invalid or incomplete action configuration (${action.type}).`);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : "Automation action failed");
    }
  }

  const tasks: Promise<unknown>[] = [
    recordActivity(db, {
      accountId,
      actorUserId: actorUserId ?? null,
      category: "automation",
      action: "automation.triggered",
      summary: `Automation "${ruleName}" executed ${executedCount} action(s)`,
      metadata: { ruleId, executedCount, errors },
    }),
  ];

  if (!skipRuleStatusUpdate) {
    tasks.push(
      Promise.resolve(
        db
          .from("automation_rules")
          .update({
            last_executed_at: (executedAt ?? new Date()).toISOString(),
            last_execution_status: errors.length > 0 ? "failed" : "success",
            last_error: errors.length > 0 ? errors.join("; ") : null,
          })
          .eq("id", ruleId)
          .eq("account_id", accountId)
      )
    );
  }

  await Promise.all(tasks);

  if (errors.length > 0) {
    await emitNotification(db, {
      scope: "user",
      accountId,
      category: "automation",
      eventKey: "automation.failed",
      preferenceKey: "automation_failures",
      severity: "danger",
      title: `Automation Failed: ${ruleName}`,
      message: errors.join("; "),
      dedupKey: `auto_fail:${ruleId}`,
      dedupWindowSeconds: 300,
      metadata: { ruleId, errors },
    });
  }

  // Chain downstream switch/device triggers with cycle and depth protection
  const nextVisited = new Set(visitedRuleIds ?? []);
  nextVisited.add(ruleId);
  if (nextVisited.size < MAX_AUTOMATION_CHAIN_DEPTH && downstreamEvents.length > 0) {
    for (const downstream of downstreamEvents) {
      await evaluateAutomationsForEvent({
        db,
        env,
        emqxFetch,
        accountId,
        event: downstream,
        visitedRuleIds: nextVisited,
      });
    }
  }

  return { executedCount, errors };
}

function triggerMatchesEvent(
  trig: AutomationTriggerItem,
  event:
    | { kind: "sensor"; sensorId: string; numericValue: number }
    | { kind: "device"; deviceId: string; state: string }
    | { kind: "switch"; switchId: string; isOn: boolean }
): boolean {
  if (
    event.kind === "sensor" &&
    trig.type === "sensor_value" &&
    trig.sensorId === event.sensorId &&
    typeof trig.threshold === "number"
  ) {
    return compareNumeric(event.numericValue, trig.operator ?? "eq", trig.threshold);
  }
  if (
    event.kind === "device" &&
    trig.type === "device_state" &&
    trig.deviceId === event.deviceId
  ) {
    return (
      String(event.state).trim().toLowerCase() ===
      String(trig.expectedState ?? "").trim().toLowerCase()
    );
  }
  if (
    event.kind === "switch" &&
    trig.type === "device_state" &&
    trig.switchId === event.switchId
  ) {
    const expectedBool = parseExpectedBoolean(trig.expectedState);
    return expectedBool !== null && Boolean(event.isOn) === expectedBool;
  }
  return false;
}

export async function evaluateAutomationsForEvent(params: {
  db: DbClient;
  env: WorkerBindings;
  emqxFetch?: CustomFetch;
  webhookFetch?: CustomFetch;
  accountId: string;
  event:
    | { kind: "sensor"; sensorId: string; numericValue: number }
    | { kind: "device"; deviceId: string; state: string }
    | { kind: "switch"; switchId: string; isOn: boolean };
  visitedRuleIds?: Set<string>;
  preloadedRules?: AutomationRuleRow[];
}): Promise<number> {
  const { db, env, emqxFetch, webhookFetch, accountId, event, visitedRuleIds, preloadedRules } = params;
  const rules =
    preloadedRules ??
    (
      await db
        .from("automation_rules")
        .select("*")
        .eq("account_id", accountId)
        .eq("enabled", true)
        .is("deleted_at", null)
    ).data;

  let triggered = 0;

  for (const rule of (rules ?? []) as AutomationRuleRow[]) {
    if (visitedRuleIds?.has(rule.id)) continue;

    if (rule.flow_graph && Array.isArray(rule.flow_graph.nodes) && rule.flow_graph.nodes.length > 0) {
      const flowRes = await executeOrTestFlowGraph({
        db,
        env,
        emqxFetch,
        webhookFetch,
        accountId,
        ruleId: rule.id,
        ruleName: rule.name,
        graph: rule.flow_graph,
        dryRun: false,
        triggerMode: "event",
        event,
        visitedRuleIds,
      });
      if (flowRes.trace.triggered) {
        triggered += 1;
      }
      continue;
    }

    const triggerList = normalizeTriggerList(rule.trigger_config);
    const match = triggerList.some((trig) => triggerMatchesEvent(trig, event));
    if (!match) continue;

    const conditionsOk = await conditionsAreSatisfied(
      db,
      accountId,
      rule.conditions_config
    );
    if (!conditionsOk) continue;

    await executeAutomationActions({
      db,
      env,
      emqxFetch,
      accountId,
      ruleId: rule.id,
      ruleName: rule.name,
      actions: rule.actions_config ?? [],
      visitedRuleIds,
    });
    triggered += 1;
  }

  return triggered;
}

export async function evaluateScheduledAutomations(params: {
  db: DbClient;
  env: WorkerBindings;
  emqxFetch?: CustomFetch;
  webhookFetch?: CustomFetch;
  now?: Date;
  accountId?: string;
}): Promise<{ checked: number; triggered: number }> {
  const { db, env, emqxFetch, webhookFetch, now = new Date(), accountId } = params;

  let query = db
    .from("automation_rules")
    .select("*")
    .eq("enabled", true)
    .is("deleted_at", null);

  if (accountId) {
    query = query.eq("account_id", accountId);
  }

  const [{ data: rules }, { data: homes }, { data: settings }] = await Promise.all([
    query,
    db.from("homes").select("id,timezone").is("deleted_at", null),
    db.from("platform_settings").select("default_timezone").eq("id", 1).maybeSingle(),
  ]);

  const homeTzMap = new Map<string, string>(
    ((homes ?? []) as Array<{ id: string; timezone: string }>).map((h) => [
      h.id,
      h.timezone,
    ])
  );
  const platformDefaultTz =
    (settings as { default_timezone?: string } | null)?.default_timezone ?? "UTC";

  let checked = 0;
  let triggered = 0;

  for (const rule of (rules ?? []) as AutomationRuleRow[]) {
    const triggerList = normalizeTriggerList(rule.trigger_config);
    const scheduleTriggers = triggerList.filter(
      (t) =>
        (t.type === "time" && Boolean(t.cronTime)) ||
        (t.type === "sun_event" && (t.sunEvent === "sunrise" || t.sunEvent === "sunset"))
    );
    if (scheduleTriggers.length === 0) continue;

    checked += 1;
    const homeTz = rule.home_id ? homeTzMap.get(rule.home_id) : undefined;

    let matchedTrigTz: string | null = null;
    for (const trig of scheduleTriggers) {
      const ruleTz = resolveEffectiveTimezone(
        trig.timezone ?? homeTz ?? null,
        platformDefaultTz
      );
      const current = getZonedClockParts(now, ruleTz);

      if (Array.isArray(trig.days) && trig.days.length > 0) {
        const normalizedDays = trig.days.map((d) => d.trim().slice(0, 3).toLowerCase());
        if (!normalizedDays.includes(current.weekday)) continue;
      }

      const targetHhmm =
        trig.type === "sun_event"
          ? computeSunTimeHHMM({
              date: now,
              event: trig.sunEvent!,
              timezone: ruleTz,
              offsetMinutes: trig.offsetMinutes ?? 0,
              latitude: trig.latitude,
              longitude: trig.longitude,
            })
          : trig.cronTime!;

      if (targetHhmm !== current.hhmm) continue;

      if (rule.last_executed_at) {
        const lastDate = new Date(rule.last_executed_at);
        if (!Number.isNaN(lastDate.getTime())) {
          const lastKey = getZonedClockParts(lastDate, ruleTz).minuteKey;
          if (lastKey === current.minuteKey) {
            continue;
          }
        }
      }

      matchedTrigTz = ruleTz;
      break;
    }

    if (!matchedTrigTz) continue;

    if (rule.flow_graph && Array.isArray(rule.flow_graph.nodes) && rule.flow_graph.nodes.length > 0) {
      const flowRes = await executeOrTestFlowGraph({
        db,
        env,
        emqxFetch,
        webhookFetch,
        accountId: rule.account_id,
        ruleId: rule.id,
        ruleName: rule.name,
        graph: rule.flow_graph,
        dryRun: false,
        triggerMode: "schedule",
        now,
        fallbackTimezone: matchedTrigTz,
      });
      if (flowRes.trace.executed || flowRes.trace.triggered) {
        triggered += 1;
      }
      continue;
    }

    const conditionsOk = await conditionsAreSatisfied(
      db,
      rule.account_id,
      rule.conditions_config,
      now,
      matchedTrigTz
    );
    if (!conditionsOk) continue;

    await executeAutomationActions({
      db,
      env,
      emqxFetch,
      accountId: rule.account_id,
      ruleId: rule.id,
      ruleName: rule.name,
      actions: rule.actions_config ?? [],
      executedAt: now,
    });
    triggered += 1;
  }

  return { checked, triggered };
}

function isSafeWebhookUrl(rawUrl: string, hasTestFetch: boolean): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (hasTestFetch) return true;
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host.startsWith("169.254.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function executeOrTestFlowGraph(params: {
  db: DbClient;
  env: WorkerBindings;
  emqxFetch?: CustomFetch;
  webhookFetch?: CustomFetch;
  accountId: string;
  actorUserId?: string | null;
  ruleId?: string | null;
  ruleName: string;
  graph: FlowGraph;
  dryRun: boolean;
  triggerMode: "manual" | "event" | "schedule";
  event?:
    | { kind: "sensor"; sensorId: string; numericValue: number }
    | { kind: "device"; deviceId: string; state: string }
    | { kind: "switch"; switchId: string; isOn: boolean };
  now?: Date;
  fallbackTimezone?: string;
  simulatedVariables?: Record<string, string | number | boolean>;
  visitedRuleIds?: Set<string>;
}): Promise<{
  trace: FlowExecutionTrace;
  executedCount: number;
  errors: string[];
  localExecution: { supported: boolean; controllerId: string | null; reasons: string[] };
}> {
  const now = params.now ?? new Date();
  const { db, env, emqxFetch, webhookFetch, accountId, graph, dryRun } = params;
  const emqx = !dryRun && isEmqxConfigured(env) ? new EmqxClient(env, emqxFetch) : null;

  const [swRes, devRes, senRes, homeRes] = await Promise.all([
    db
      .from("switches")
      .select("id,name,controller_id,is_on")
      .eq("account_id", accountId)
      .is("deleted_at", null),
    db
      .from("devices")
      .select("id,name,controller_id,state")
      .eq("account_id", accountId)
      .is("deleted_at", null),
    db
      .from("sensors")
      .select("id,name,controller_id,last_value,unit")
      .eq("account_id", accountId)
      .is("deleted_at", null),
    db
      .from("homes")
      .select("timezone")
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle(),
  ]);

  const switches = (swRes.data ?? []) as Array<{
    id: string;
    name: string;
    controller_id: string;
    is_on: boolean;
  }>;
  const devices = (devRes.data ?? []) as Array<{
    id: string;
    name: string;
    controller_id: string;
    state: string;
  }>;
  const sensors = (senRes.data ?? []) as Array<{
    id: string;
    name: string;
    controller_id: string;
    last_value: number | null;
    unit: string;
  }>;
  const fallbackTz =
    params.fallbackTimezone ??
    (homeRes.data as { timezone?: string } | null)?.timezone ??
    "UTC";

  const localExecution = analyzeFlowGraphLocalCapability({
    graph,
    switchControllerById: new Map(switches.map((s) => [s.id, s.controller_id])),
    deviceControllerById: new Map(devices.map((d) => [d.id, d.controller_id])),
    sensorControllerById: new Map(sensors.map((s) => [s.id, s.controller_id])),
  });

  const variablesSnapshot: Record<string, string | number | boolean> = {};
  for (const v of graph.variables ?? []) {
    variablesSnapshot[v.name] = v.initialValue;
  }
  if (params.simulatedVariables) {
    Object.assign(variablesSnapshot, params.simulatedVariables);
  }

  const nodeMap = new Map<string, FlowNode>(graph.nodes.map((n) => [n.id, n]));
  const incomingEdges = new Map<string, typeof graph.edges>();
  const outgoingEdges = new Map<string, typeof graph.edges>();
  for (const n of graph.nodes) {
    incomingEdges.set(n.id, []);
    outgoingEdges.set(n.id, []);
  }
  for (const e of graph.edges) {
    if (nodeMap.has(e.source) && nodeMap.has(e.target)) {
      outgoingEdges.get(e.source)!.push(e);
      incomingEdges.get(e.target)!.push(e);
    }
  }

  // Topological sort (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  for (const n of graph.nodes) inDegree.set(n.id, (incomingEdges.get(n.id) ?? []).length);
  const queue = graph.nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topoOrder.push(id);
    for (const e of outgoingEdges.get(id) ?? []) {
      const next = (inDegree.get(e.target) ?? 0) - 1;
      inDegree.set(e.target, next);
      if (next === 0) queue.push(e.target);
    }
  }

  const nodeResults: Record<string, FlowNodeExecutionTrace> = {};
  const edgeStates: Record<string, "active" | "inactive"> = {};
  const actionsPlanned: FlowExecutionTrace["actionsPlanned"] = [];
  const notes: string[] = [];
  const errors: string[] = [];
  const downstreamEvents: Array<
    | { kind: "device"; deviceId: string; state: string }
    | { kind: "switch"; switchId: string; isOn: boolean }
  > = [];

  let anyTriggerFired = false;
  let anyConditionPassed = true;
  let executedCount = 0;

  for (const nodeId of topoOrder) {
    const node = nodeMap.get(nodeId)!;
    const inEdges = incomingEdges.get(nodeId) ?? [];
    const outEdges = outgoingEdges.get(nodeId) ?? [];

    if (node.kind === "trigger") {
      const cfg = node.config as FlowTriggerNodeConfig;
      let fired = false;
      let detail = "Trigger checked";

      if (params.triggerMode === "manual") {
        fired = true;
        if (cfg.triggerType === "sensor_value") {
          const s = sensors.find((x) => x.id === cfg.sensorId);
          detail = `Manual simulation (${s?.name ?? "Sensor"} = ${s?.last_value ?? "n/a"})`;
        } else if (cfg.triggerType === "device_state") {
          detail = "Manual simulation of state trigger";
        } else if (cfg.triggerType === "time") {
          detail = `Simulated schedule ${cfg.cronTime ?? "18:00"}`;
        } else if (cfg.triggerType === "sun_event") {
          const tz = resolveEffectiveTimezone(cfg.timezone ?? null, fallbackTz);
          const hhmm = computeSunTimeHHMM({
            date: now,
            event: cfg.sunEvent === "sunrise" ? "sunrise" : "sunset",
            timezone: tz,
            offsetMinutes: cfg.offsetMinutes ?? 0,
          });
          detail = `Simulated ${cfg.sunEvent ?? "sunset"} (${hhmm} ${tz})`;
        } else {
          detail = "Manual flow start";
        }
      } else if (params.triggerMode === "event" && params.event) {
        if (cfg.triggerType === "sensor_value" && params.event.kind === "sensor" && cfg.sensorId === params.event.sensorId && typeof cfg.threshold === "number") {
          fired = compareNumeric(params.event.numericValue, cfg.operator ?? "eq", cfg.threshold);
          detail = `Sensor value ${params.event.numericValue} ${cfg.operator ?? "eq"} ${cfg.threshold}`;
        } else if (cfg.triggerType === "device_state" && params.event.kind === "switch" && cfg.switchId === params.event.switchId) {
          const exp = parseExpectedBoolean(cfg.expectedState);
          fired = exp !== null && params.event.isOn === exp;
          detail = `Switch state ${params.event.isOn ? "ON" : "OFF"}`;
        } else if (cfg.triggerType === "device_state" && params.event.kind === "device" && cfg.deviceId === params.event.deviceId) {
          fired = String(params.event.state).toLowerCase() === String(cfg.expectedState ?? "").toLowerCase();
          detail = `Device state "${params.event.state}"`;
        }
      } else if (params.triggerMode === "schedule") {
        const tz = resolveEffectiveTimezone(cfg.timezone ?? null, fallbackTz);
        const current = getZonedClockParts(now, tz);
        if (cfg.triggerType === "time" && cfg.cronTime === current.hhmm) {
          fired = true;
          detail = `Matched ${cfg.cronTime} (${tz})`;
        } else if (cfg.triggerType === "sun_event" && cfg.sunEvent) {
          const hhmm = computeSunTimeHHMM({
            date: now,
            event: cfg.sunEvent,
            timezone: tz,
            offsetMinutes: cfg.offsetMinutes ?? 0,
          });
          fired = hhmm === current.hhmm;
          detail = `${cfg.sunEvent} @ ${hhmm} (${tz})`;
        }
      }

      if (fired) anyTriggerFired = true;
      nodeResults[nodeId] = {
        nodeId,
        label: node.label,
        kind: node.kind,
        status: fired ? "passed" : "skipped",
        detail,
        branchTaken: "out",
      };
      for (const e of outEdges) edgeStates[e.id] = fired ? "active" : "inactive";
      continue;
    }

    const activeInputs = inEdges.filter((e) => edgeStates[e.id] === "active");
    const hasActiveInput = activeInputs.length > 0;

    if (!hasActiveInput) {
      nodeResults[nodeId] = {
        nodeId,
        label: node.label,
        kind: node.kind,
        status: "skipped",
        detail: "Skipped (upstream branch inactive)",
      };
      for (const e of outEdges) edgeStates[e.id] = "inactive";
      continue;
    }

    if (node.kind === "logic") {
      const cfg = node.config as FlowLogicNodeConfig;
      const passed =
        cfg.gate === "ALL"
          ? inEdges.length > 0 && activeInputs.length === inEdges.length
          : activeInputs.length >= 1;
      nodeResults[nodeId] = {
        nodeId,
        label: node.label,
        kind: node.kind,
        status: passed ? "passed" : "failed",
        detail:
          cfg.gate === "ALL"
            ? `${activeInputs.length}/${inEdges.length} upstream branches active (ALL)`
            : `${activeInputs.length} upstream branch active (ANY)`,
        branchTaken: "out",
      };
      for (const e of outEdges) edgeStates[e.id] = passed ? "active" : "inactive";
      continue;
    }

    if (node.kind === "condition") {
      const cfg = node.config as FlowConditionNodeConfig;
      let matched = false;
      let detail = "Condition evaluated";

      if (cfg.conditionType === "variable_check" && cfg.variableName) {
        const curVal = variablesSnapshot[cfg.variableName];
        matched = String(curVal ?? "") === String(cfg.variableValue ?? "");
        detail = `Variable "${cfg.variableName}" = ${JSON.stringify(curVal)} (expected ${JSON.stringify(cfg.variableValue)})`;
      } else {
        const legacyCond: AutomationConditionItem = {
          type: cfg.conditionType as AutomationConditionItem["type"],
          sensorId: cfg.sensorId,
          operator: cfg.operator,
          threshold: cfg.threshold,
          switchId: cfg.switchId,
          deviceId: cfg.deviceId,
          expectedState: cfg.expectedState,
          roomId: cfg.roomId,
          roomMatch: cfg.roomMatch,
          startTime: cfg.startTime,
          endTime: cfg.endTime,
          days: cfg.days,
          timezone: cfg.timezone,
        };
        const res = await evaluateSingleCondition(db, accountId, legacyCond, now, fallbackTz);
        matched = res.matched;
        detail = res.detail;
      }

      if (!matched) anyConditionPassed = false;
      const branchTaken = matched ? "true" : "false";
      nodeResults[nodeId] = {
        nodeId,
        label: node.label,
        kind: node.kind,
        status: matched ? "passed" : "failed",
        detail,
        branchTaken,
      };
      for (const e of outEdges) {
        const handle = e.sourceHandle || "true";
        edgeStates[e.id] = handle === branchTaken ? "active" : "inactive";
      }
      continue;
    }

    if (node.kind === "delay") {
      const cfg = node.config as FlowDelayNodeConfig;
      const mult =
        cfg.durationUnit === "hours" ? 3_600_000 : cfg.durationUnit === "minutes" ? 60_000 : 1_000;
      const delayMs = Math.max(100, (cfg.durationValue || 1) * mult);
      if (!dryRun && delayMs <= 3000) {
        await new Promise((r) => setTimeout(r, delayMs));
      } else if (!dryRun) {
        notes.push(`Delay node "${node.label}" (${cfg.durationValue} ${cfg.durationUnit}) simulated without worker timeout.`);
      }
      actionsPlanned.push({
        nodeId,
        actionType: "delay",
        detail: `Wait ${cfg.durationValue} ${cfg.durationUnit}`,
        delayMs,
      });
      nodeResults[nodeId] = {
        nodeId,
        label: node.label,
        kind: node.kind,
        status: dryRun ? "waiting" : "passed",
        detail: dryRun
          ? `Simulated delay: ${cfg.durationValue} ${cfg.durationUnit}`
          : `Delayed ${cfg.durationValue} ${cfg.durationUnit}`,
        branchTaken: "out",
      };
      for (const e of outEdges) edgeStates[e.id] = "active";
      continue;
    }

    if (node.kind === "action") {
      const cfg = node.config as FlowActionNodeConfig;
      let detail = "Action";
      let actionOk = true;

      if ((cfg.actionType === "switch_on" || cfg.actionType === "switch_off") && cfg.switchId) {
        const sw = switches.find((s) => s.id === cfg.switchId);
        const desired = cfg.actionType === "switch_on";
        detail = `${sw?.name ?? "Switch"} -> ${desired ? "ON" : "OFF"}`;
        actionsPlanned.push({ nodeId, actionType: cfg.actionType, detail, switchId: cfg.switchId });
        if (!dryRun) {
          actionOk = await executeSwitchTarget({
            db,
            emqx,
            accountId,
            ruleId: params.ruleId ?? "flow-run",
            switchId: cfg.switchId,
            desired,
            errors,
            downstreamEvents,
          });
          if (actionOk) executedCount += 1;
        }
      } else if (cfg.actionType === "device_state" && cfg.deviceId && cfg.targetState) {
        const dev = devices.find((d) => d.id === cfg.deviceId);
        detail = `${dev?.name ?? "Device"} -> "${cfg.targetState}"`;
        actionsPlanned.push({
          nodeId,
          actionType: "device_state",
          detail,
          deviceId: cfg.deviceId,
          targetState: cfg.targetState,
        });
        if (!dryRun) {
          actionOk = await executeDeviceTarget({
            db,
            emqx,
            accountId,
            ruleId: params.ruleId ?? "flow-run",
            deviceId: cfg.deviceId,
            targetState: cfg.targetState,
            errors,
            downstreamEvents,
          });
          if (actionOk) executedCount += 1;
        }
      } else if (cfg.actionType === "scene" && Array.isArray(cfg.targets)) {
        detail = `Scene "${cfg.sceneName ?? "Scene"}" (${cfg.targets.length} target(s))`;
        actionsPlanned.push({
          nodeId,
          actionType: "scene",
          detail,
          targets: cfg.targets as SceneTargetItem[],
        });
        if (!dryRun) {
          for (const t of cfg.targets) {
            if (t.kind === "switch") {
              const ok = await executeSwitchTarget({
                db,
                emqx,
                accountId,
                ruleId: params.ruleId ?? "flow-run",
                switchId: t.switchId,
                desired: t.isOn,
                errors,
                downstreamEvents,
              });
              if (ok) executedCount += 1;
            } else {
              const ok = await executeDeviceTarget({
                db,
                emqx,
                accountId,
                ruleId: params.ruleId ?? "flow-run",
                deviceId: t.deviceId,
                targetState: t.targetState,
                errors,
                downstreamEvents,
              });
              if (ok) executedCount += 1;
            }
          }
        }
      } else if (cfg.actionType === "set_variable" && cfg.variableName) {
        variablesSnapshot[cfg.variableName] = cfg.variableValue ?? "";
        detail = `Set ${cfg.variableName} = ${JSON.stringify(variablesSnapshot[cfg.variableName])}`;
        actionsPlanned.push({
          nodeId,
          actionType: "set_variable",
          detail,
          variableName: cfg.variableName,
          variableValue: variablesSnapshot[cfg.variableName],
        });
        if (!dryRun) executedCount += 1;
      } else if (cfg.actionType === "notification") {
        detail = `Notify "${cfg.notificationTitle ?? "Automation Alert"}"`;
        actionsPlanned.push({
          nodeId,
          actionType: "notification",
          detail,
          notificationTitle: cfg.notificationTitle,
          notificationMessage: cfg.notificationMessage,
          notificationSeverity: cfg.notificationSeverity ?? "info",
        });
        if (!dryRun) {
            await emitNotification(db, {
            scope: "user",
            accountId,
            category: "automation",
            eventKey: "automation.flow_notification",
            preferenceKey: "sensor_alerts",
            severity: cfg.notificationSeverity ?? "info",
            title: cfg.notificationTitle ?? params.ruleName,
            message: cfg.notificationMessage ?? "Automation flow triggered.",
            metadata: { ruleId: params.ruleId ?? null, nodeId },
          });
          executedCount += 1;
        }
      } else if (cfg.actionType === "http_request" && cfg.httpUrl) {
        const method = cfg.httpMethod ?? "POST";
        detail = `${method} ${cfg.httpUrl}`;
        actionsPlanned.push({
          nodeId,
          actionType: "http_request",
          detail,
          httpMethod: method,
          httpUrl: cfg.httpUrl,
          httpBody: cfg.httpBody,
        });
        if (!dryRun) {
          if (!isSafeWebhookUrl(cfg.httpUrl, Boolean(webhookFetch))) {
            actionOk = false;
            errors.push(`Webhook URL "${cfg.httpUrl}" is blocked (private/invalid target).`);
          } else {
            try {
              const fetcher: CustomFetch = webhookFetch ?? fetch;
              const resp = await fetcher(cfg.httpUrl, {
                method,
                headers: { "Content-Type": "application/json" },
                body:
                  method === "GET"
                    ? undefined
                    : cfg.httpBody || JSON.stringify({ ruleName: params.ruleName, variables: variablesSnapshot }),
              });
              if (!resp.ok) {
                actionOk = false;
                errors.push(`Webhook returned HTTP ${resp.status}`);
              } else {
                executedCount += 1;
              }
            } catch (err) {
              actionOk = false;
              errors.push(err instanceof Error ? err.message : "Webhook request failed");
            }
          }
        }
      }

      nodeResults[nodeId] = {
        nodeId,
        label: node.label,
        kind: node.kind,
        status: dryRun ? "passed" : actionOk ? "executed" : "failed",
        detail,
        branchTaken: "out",
      };
      for (const e of outEdges) edgeStates[e.id] = actionOk ? "active" : "inactive";
      continue;
    }

    if (node.kind === "end") {
      const cfg = node.config as FlowEndNodeConfig;
      nodeResults[nodeId] = {
        nodeId,
        label: node.label,
        kind: node.kind,
        status: "passed",
        detail: cfg.note || `Flow ${cfg.outcome ?? "completed"}`,
      };
    }
  }

  const effectiveConditionsMatched =
    anyTriggerFired && (actionsPlanned.length > 0 || anyConditionPassed);

  const trace: FlowExecutionTrace = {
    evaluatedAt: now.toISOString(),
    triggered: anyTriggerFired,
    conditionsMatched: effectiveConditionsMatched,
    executed: !dryRun && executedCount > 0 && errors.length === 0,
    nodeResults,
    edgeStates,
    variablesSnapshot,
    actionsPlanned,
    notes,
  };

  if (!dryRun && anyTriggerFired && params.ruleId) {
    await Promise.all([
      recordActivity(db, {
        accountId,
        actorUserId: params.actorUserId ?? null,
        category: "automation",
        action: "automation.triggered",
        summary: `Flow "${params.ruleName}" executed ${executedCount} action(s)`,
        metadata: { ruleId: params.ruleId, executedCount, errors },
      }),
      db
        .from("automation_rules")
        .update({
          last_executed_at: now.toISOString(),
          last_execution_status: errors.length > 0 ? "failed" : "success",
          last_error: errors.length > 0 ? errors.join("; ") : null,
          last_run_trace: trace,
        })
        .eq("id", params.ruleId)
        .eq("account_id", accountId),
    ]);

    const nextVisited = new Set(params.visitedRuleIds ?? []);
    nextVisited.add(params.ruleId);
    if (nextVisited.size < MAX_AUTOMATION_CHAIN_DEPTH && downstreamEvents.length > 0) {
      for (const downstream of downstreamEvents) {
        await evaluateAutomationsForEvent({
          db,
          env,
          emqxFetch,
          webhookFetch,
          accountId,
          event: downstream,
          visitedRuleIds: nextVisited,
        });
      }
    }
  }

  return { trace, executedCount, errors, localExecution };
}

export async function testAutomationRule(params: {
  db: DbClient;
  env: WorkerBindings;
  emqxFetch?: CustomFetch;
  accountId: string;
  actorUserId: string;
  ruleId?: string | null;
  ruleName: string;
  triggerConfig: AutomationTriggerConfig;
  conditionsConfig?: AutomationConditionsConfig | null;
  actionsConfig: AutomationActionItem[];
  dryRun: boolean;
  now?: Date;
}): Promise<{
  conditionsMatched: boolean;
  conditionTrace: Array<{
    groupIndex: number;
    logic: "AND" | "OR";
    matched: boolean;
    items: Array<{ type: string; matched: boolean; detail: string }>;
  }>;
  plannedActions: Array<{
    type: string;
    targetName: string;
    summary: string;
  }>;
  groupResults: Array<{
    logic: "AND" | "OR";
    matched: boolean;
    conditions: Array<{ type: string; matched: boolean; detail: string }>;
  }>;
  triggerPreview: Array<{ type: string; matchedNow: boolean; summary: string }>;
  localExecution: { supported: boolean; controllerId: string | null; reasons: string[] };
  executedCount: number;
  errors: string[];
}> {
  const now = params.now ?? new Date();
  const [swRes, devRes, senRes, homeRes] = await Promise.all([
    params.db
      .from("switches")
      .select("id,name,controller_id,is_on")
      .eq("account_id", params.accountId)
      .is("deleted_at", null),
    params.db
      .from("devices")
      .select("id,name,controller_id,state")
      .eq("account_id", params.accountId)
      .is("deleted_at", null),
    params.db
      .from("sensors")
      .select("id,name,controller_id,last_value,unit")
      .eq("account_id", params.accountId)
      .is("deleted_at", null),
    params.db
      .from("homes")
      .select("timezone")
      .eq("account_id", params.accountId)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle(),
  ]);

  const switches = (swRes.data ?? []) as Array<{
    id: string;
    name: string;
    controller_id: string;
    is_on: boolean;
  }>;
  const devices = (devRes.data ?? []) as Array<{
    id: string;
    name: string;
    controller_id: string;
    state: string;
  }>;
  const sensors = (senRes.data ?? []) as Array<{
    id: string;
    name: string;
    controller_id: string;
    last_value: number | null;
    unit: string;
  }>;

  const fallbackTz =
    (homeRes.data as { timezone?: string } | null)?.timezone ?? "UTC";

  const triggers = normalizeTriggerList(params.triggerConfig);
  const triggerPreview = triggers.map((t) => {
    if (t.type === "sensor_value") {
      const sen = sensors.find((s) => s.id === t.sensorId);
      const matched =
        typeof sen?.last_value === "number" &&
        typeof t.threshold === "number" &&
        compareNumeric(sen.last_value, t.operator, t.threshold);
      return {
        type: t.type,
        matchedNow: matched,
        summary: `${sen?.name ?? "Sensor"} (${sen?.last_value ?? "no reading"}) ${t.operator ?? "eq"} ${t.threshold ?? "?"}`,
      };
    }
    if (t.type === "device_state") {
      if (t.switchId) {
        const sw = switches.find((s) => s.id === t.switchId);
        const exp = parseExpectedBoolean(t.expectedState);
        const matched = Boolean(sw && exp !== null && sw.is_on === exp);
        return {
          type: "switch_state",
          matchedNow: matched,
          summary: `${sw?.name ?? "Switch"} is ${sw?.is_on ? "ON" : "OFF"} (triggers on ${exp ? "ON" : "OFF"})`,
        };
      }
      const dev = devices.find((d) => d.id === t.deviceId);
      const matched = Boolean(
        dev &&
          dev.state.trim().toLowerCase() ===
            String(t.expectedState ?? "").trim().toLowerCase()
      );
      return {
        type: t.type,
        matchedNow: matched,
        summary: `${dev?.name ?? "Device"} is "${dev?.state ?? "?"}" (triggers on "${t.expectedState ?? ""}")`,
      };
    }
    if (t.type === "sun_event") {
      const tz = resolveEffectiveTimezone(t.timezone ?? null, fallbackTz);
      const hhmm = computeSunTimeHHMM({
        date: now,
        event: t.sunEvent === "sunrise" ? "sunrise" : "sunset",
        timezone: tz,
        offsetMinutes: t.offsetMinutes ?? 0,
        latitude: t.latitude,
        longitude: t.longitude,
      });
      const current = getZonedClockParts(now, tz);
      return {
        type: t.type,
        matchedNow: current.hhmm === hhmm,
        summary: `${t.sunEvent ?? "sunset"} (${hhmm} ${tz}, now ${current.hhmm})`,
      };
    }
    const tz = resolveEffectiveTimezone(t.timezone ?? null, fallbackTz);
    const current = getZonedClockParts(now, tz);
    return {
      type: t.type,
      matchedNow: current.hhmm === t.cronTime,
      summary: `Schedule ${t.cronTime ?? "00:00"} (${tz}, now ${current.hhmm})`,
    };
  });

  const condEval = await evaluateConditionGroups(
    params.db,
    params.accountId,
    params.conditionsConfig,
    now,
    fallbackTz
  );

  const localExecution = analyzeLocalAutomationCapability({
    triggers,
    conditions: normalizeConditionGroups(params.conditionsConfig),
    actions: params.actionsConfig,
    switchControllerById: new Map(switches.map((s) => [s.id, s.controller_id])),
    deviceControllerById: new Map(devices.map((d) => [d.id, d.controller_id])),
    sensorControllerById: new Map(sensors.map((s) => [s.id, s.controller_id])),
  });

  const conditionTrace = condEval.groupResults.map((grp, groupIndex) => ({
    groupIndex,
    logic: grp.logic,
    matched: grp.matched,
    items: grp.conditions,
  }));

  const plannedActions: Array<{
    type: string;
    targetName: string;
    summary: string;
  }> = [];

  for (const act of params.actionsConfig) {
    if (act.type === "switch_on" || act.type === "switch_off") {
      const sw = switches.find((s) => s.id === act.switchId);
      plannedActions.push({
        type: act.type,
        targetName: sw?.name ?? "Switch",
        summary: act.type === "switch_on" ? "Turn ON" : "Turn OFF",
      });
    } else if (act.type === "device_state") {
      const dev = devices.find((d) => d.id === act.deviceId);
      plannedActions.push({
        type: act.type,
        targetName: dev?.name ?? "Device",
        summary: `Set state → "${act.targetState ?? ""}"`,
      });
    } else if (act.type === "scene") {
      for (const targ of act.targets ?? []) {
        if (targ.kind === "switch") {
          const sw = switches.find((s) => s.id === targ.switchId);
          plannedActions.push({
            type: "scene",
            targetName: sw?.name ?? "Switch",
            summary: `${act.sceneName ?? "Scene"}: Turn ${targ.isOn ? "ON" : "OFF"}`,
          });
        } else {
          const dev = devices.find((d) => d.id === targ.deviceId);
          plannedActions.push({
            type: "scene",
            targetName: dev?.name ?? "Device",
            summary: `${act.sceneName ?? "Scene"}: Set → "${targ.targetState}"`,
          });
        }
      }
    }
  }

  let executedCount = 0;
  let errors: string[] = [];

  if (!params.dryRun) {
    const exec = await executeAutomationActions({
      db: params.db,
      env: params.env,
      emqxFetch: params.emqxFetch,
      accountId: params.accountId,
      ruleId: params.ruleId ?? "draft-test",
      ruleName: params.ruleName,
      actions: params.actionsConfig,
      actorUserId: params.actorUserId,
      executedAt: now,
      skipRuleStatusUpdate: !params.ruleId,
    });
    executedCount = exec.executedCount;
    errors = exec.errors;
  }

  return {
    conditionsMatched: condEval.matched,
    conditionTrace,
    plannedActions,
    groupResults: condEval.groupResults,
    triggerPreview,
    localExecution,
    executedCount,
    errors,
  };
}
