/**
 * Executor for Dynamic Island Action Button programs.
 *
 * Reuses the existing account resources and command contract:
 *  - switches / devices tables are updated optimistically after dispatch,
 *  - MQTT payloads match /api/switches/:id/toggle and /api/devices/:id/command,
 *  - automation targets run through the shared automation engine,
 *  - downstream switch/device events re-enter the automation engine so button
 *    commands behave exactly like manual dashboard commands.
 *
 * Availability is validated before dispatch: steps targeting controllers that
 * are not online fail fast with a per-step error instead of pretending the
 * command landed. Sensors are never addressable.
 */
import {
  isDeviceStateActive,
  type ActionButtonGesture,
  type ActionButtonOp,
  type ActionButtonStep,
  type AutomationActionItem,
  type FlowGraph,
} from "@homecoreos/shared";
import {
  evaluateAutomationsForEvent,
  executeAutomationActions,
  executeOrTestFlowGraph,
} from "./automation-engine";
import type { WorkerBindings } from "../config/env";
import { EmqxClient, isEmqxConfigured } from "./emqx";
import { recordActivity } from "./audit";
import type { AppEnv } from "../types/context";

export interface ControllableSwitchRow {
  id: string;
  name: string;
  controller_id: string;
  room_id: string | null;
  gpio_pin: number;
  inverted: boolean;
  is_on: boolean;
}

export interface ControllableDeviceRow {
  id: string;
  name: string;
  controller_id: string;
  room_id: string | null;
  gpio_pin: number;
  device_type: string;
  state: string;
  is_online: boolean;
}

export interface ControllableInventory {
  switches: ControllableSwitchRow[];
  devices: ControllableDeviceRow[];
}

export async function loadControllableInventory(
  db: AppEnv["Variables"]["db"],
  accountId: string
): Promise<ControllableInventory> {
  const [swRes, devRes] = await Promise.all([
    db
      .from("switches")
      .select("id,name,controller_id,room_id,gpio_pin,inverted,is_on")
      .eq("account_id", accountId)
      .is("deleted_at", null),
    db
      .from("devices")
      .select("id,name,controller_id,room_id,gpio_pin,device_type,state,is_online")
      .eq("account_id", accountId)
      .is("deleted_at", null),
  ]);
  return {
    switches: (swRes.data ?? []) as ControllableSwitchRow[],
    devices: (devRes.data ?? []) as ControllableDeviceRow[],
  };
}

export interface ResolvedControllableTarget {
  stepId: string;
  kind: "switch" | "device";
  op: ActionButtonOp;
  switchRow?: ControllableSwitchRow;
  deviceRow?: ControllableDeviceRow;
}

/** Expand a single gesture's steps into concrete switch/device targets. */
export function resolveControllableTargets(
  steps: ActionButtonStep[],
  inventory: ControllableInventory
): { targets: ResolvedControllableTarget[]; unresolved: string[] } {
  const targets: ResolvedControllableTarget[] = [];
  const unresolved: string[] = [];
  const pushSwitch = (stepId: string, op: ActionButtonOp, sw: ControllableSwitchRow) => {
    targets.push({ stepId, kind: "switch", op, switchRow: sw });
  };
  const pushDevice = (stepId: string, op: ActionButtonOp, dev: ControllableDeviceRow) => {
    targets.push({ stepId, kind: "device", op, deviceRow: dev });
  };

  for (const step of steps) {
    switch (step.kind) {
      case "switch": {
        const sw = inventory.switches.find((s) => s.id === step.switchId);
        if (sw) pushSwitch(step.id, step.op, sw);
        else unresolved.push(step.id);
        break;
      }
      case "device": {
        const dev = inventory.devices.find((d) => d.id === step.deviceId);
        if (dev) pushDevice(step.id, step.op, dev);
        else unresolved.push(step.id);
        break;
      }
      case "room": {
        const roomSwitches =
          step.target === "devices"
            ? []
            : inventory.switches.filter((s) => s.room_id === step.roomId);
        const roomDevices =
          step.target === "switches"
            ? []
            : inventory.devices.filter((d) => d.room_id === step.roomId);
        if (roomSwitches.length === 0 && roomDevices.length === 0) {
          unresolved.push(step.id);
        }
        for (const sw of roomSwitches) pushSwitch(step.id, step.op, sw);
        for (const dev of roomDevices) pushDevice(step.id, step.op, dev);
        break;
      }
      case "all": {
        const allSwitches =
          step.target === "devices" ? [] : inventory.switches;
        const allDevices =
          step.target === "switches" ? [] : inventory.devices;
        if (allSwitches.length === 0 && allDevices.length === 0) {
          unresolved.push(step.id);
        }
        for (const sw of allSwitches) pushSwitch(step.id, step.op, sw);
        for (const dev of allDevices) pushDevice(step.id, step.op, dev);
        break;
      }
      default:
        break;
    }
  }

  return { targets, unresolved };
}

/** Aggregate ON/OFF counts for currently targeted entities (read-only). */
export function aggregateTargetStates(
  targets: ResolvedControllableTarget[]
): { on: number; off: number } | null {
  let on = 0;
  let off = 0;
  for (const t of targets) {
    if (t.kind === "switch" && t.switchRow) {
      if (t.switchRow.is_on) on += 1;
      else off += 1;
    } else if (t.kind === "device" && t.deviceRow) {
      if (isDeviceStateActive(t.deviceRow.state)) on += 1;
      else off += 1;
    }
  }
  return on + off > 0 ? { on, off } : null;
}

export interface ActionButtonStepResult {
  stepId: string;
  kind: ActionButtonStep["kind"] | "switch-target" | "device-target";
  summary: string;
  status: "done" | "failed";
  error?: string;
  mqttDispatched?: boolean;
  controllerOnline?: boolean;
  acknowledged?:
    | { kind: "switch"; switchId: string; isOn: boolean }
    | { kind: "device"; deviceId: string; state: string };
}

export interface ActionButtonExecution {
  ok: boolean;
  gesture: ActionButtonGesture;
  executedCount: number;
  failedCount: number;
  results: ActionButtonStepResult[];
  states: { on: number; off: number } | null;
  executedAt: string;
}

async function loadControllerStatusById(
  db: AppEnv["Variables"]["db"],
  accountId: string,
  controllerIds: string[]
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  if (controllerIds.length === 0) return map;
  const { data } = await db
    .from("controllers")
    .select("id,status")
    .eq("account_id", accountId)
    .in("id", controllerIds);
  for (const row of (data ?? []) as Array<{ id: string; status: string | null }>) {
    map.set(row.id, row.status === "online");
  }
  return map;
}

async function loadActiveMqttCredentials(
  db: AppEnv["Variables"]["db"],
  accountId: string
): Promise<Array<{ controller_id: string; topic_prefix: string }>> {
  const { data } = await db
    .from("mqtt_credentials_metadata")
    .select("controller_id,topic_prefix")
    .eq("account_id", accountId)
    .eq("status", "active");
  return (data ?? []) as Array<{ controller_id: string; topic_prefix: string }>;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function executeActionButtonSteps(params: {
  db: AppEnv["Variables"]["db"];
  env: WorkerBindings;
  emqxFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  accountId: string;
  actorUserId: string;
  buttonName: string;
  configId: string;
  gesture: ActionButtonGesture;
  steps: ActionButtonStep[];
  roomNames: Map<string, string>;
}): Promise<ActionButtonExecution> {
  const {
    db,
    env,
    emqxFetch,
    accountId,
    actorUserId,
    buttonName,
    configId,
    gesture,
    steps,
    roomNames,
  } = params;

  const inventory = await loadControllableInventory(db, accountId);
  const results: ActionButtonStepResult[] = [];
  const downstreamEvents: Array<
    | { kind: "device"; deviceId: string; state: string }
    | { kind: "switch"; switchId: string; isOn: boolean }
  > = [];
  const visitedAutomationIds = new Set<string>();

  const controllerIds = Array.from(
    new Set([
      ...inventory.switches.map((s) => s.controller_id),
      ...inventory.devices.map((d) => d.controller_id),
    ])
  );
  const [controllerOnlineMap, mqttCreds, rulesRes] = await Promise.all([
    loadControllerStatusById(db, accountId, controllerIds),
    loadActiveMqttCredentials(db, accountId),
    db
      .from("automation_rules")
      .select("*")
      .eq("account_id", accountId)
      .eq("enabled", true)
      .is("deleted_at", null),
  ]);
  const emqxReady = isEmqxConfigured(env);
  const emqx = emqxReady ? new EmqxClient(env, emqxFetch) : null;
  const credByController = new Map(mqttCreds.map((cred) => [cred.controller_id, cred]));
  const preloadedRules = (rulesRes.data ?? []) as NonNullable<
    Parameters<typeof evaluateAutomationsForEvent>[0]["preloadedRules"]
  >;

  let onCount = 0;
  let offCount = 0;

  const failStep = (
    stepId: string,
    kind: ActionButtonStepResult["kind"],
    summary: string,
    error: string,
    controllerOnline?: boolean
  ) => {
    results.push({ stepId, kind, summary, status: "failed", error, controllerOnline });
  };

  for (const step of steps) {
    try {
      if (step.kind === "delay") {
        await delay(step.ms);
        results.push({
          stepId: step.id,
          kind: "delay",
          summary: `Wait ${step.ms} ms`,
          status: "done",
        });
        continue;
      }

      if (step.kind === "automation") {
        const { data: ruleData } = await db
          .from("automation_rules")
          .select("*")
          .eq("id", step.automationId)
          .eq("account_id", accountId)
          .is("deleted_at", null)
          .maybeSingle();
        if (!ruleData) {
          failStep(step.id, "automation", "Automation", "Automation rule not found.");
          continue;
        }
        const rule = ruleData as {
          id: string;
          name: string;
          actions_config: AutomationActionItem[];
          flow_graph?: FlowGraph | null;
        };
        visitedAutomationIds.add(rule.id);
        let runErrors: string[] = [];
        if (
          rule.flow_graph &&
          Array.isArray(rule.flow_graph.nodes) &&
          rule.flow_graph.nodes.length > 0
        ) {
          const flowRes = await executeOrTestFlowGraph({
            db,
            env,
            emqxFetch,
            accountId,
            actorUserId,
            ruleId: rule.id,
            ruleName: rule.name,
            graph: rule.flow_graph,
            dryRun: false,
            triggerMode: "manual",
          });
          runErrors = flowRes.errors ?? [];
        } else {
          const runRes = await executeAutomationActions({
            db,
            env,
            emqxFetch,
            accountId,
            ruleId: rule.id,
            ruleName: rule.name,
            actions: rule.actions_config ?? [],
            actorUserId,
          });
          runErrors = runRes.errors ?? [];
        }
        if (runErrors.length > 0) {
          failStep(
            step.id,
            "automation",
            `Run "${rule.name}"`,
            runErrors.join("; ")
          );
        } else {
          results.push({
            stepId: step.id,
            kind: "automation",
            summary: `Run "${rule.name}"`,
            status: "done",
          });
        }
        continue;
      }

      // Switch / device targeting steps (concrete, room-scoped, or global)
      const stepTargets = resolveControllableTargets([step], inventory);
      if (stepTargets.targets.length === 0) {
        failStep(
          step.id,
          step.kind === "room" || step.kind === "all" ? step.kind : step.kind,
          describeStep(step, roomNames),
          step.kind === "room" || step.kind === "all"
            ? "No controllable switches or devices match this target."
            : "Target not found in your account."
        );
        continue;
      }

      for (const target of stepTargets.targets) {
        if (target.kind === "switch" && target.switchRow) {
          const sw = target.switchRow;
          const desired =
            target.op === "toggle" ? !sw.is_on : target.op === "on";
          const online = controllerOnlineMap.get(sw.controller_id) ?? false;
          const summary = `Set "${sw.name}" ${desired ? "ON" : "OFF"}`;
          if (!online) {
            failStep(step.id, "switch-target", summary, "Controller is offline.", false);
            continue;
          }
          const dispatched = await dispatchSwitchCommand({
            db,
            env,
            emqx,
            emqxReady,
            cred: credByController.get(sw.controller_id) ?? null,
            accountId,
            actorUserId,
            sw,
            desired,
          });
          if (!dispatched.ok) {
            failStep(step.id, "switch-target", summary, dispatched.error, true);
            continue;
          }
          // Reflect locally so later steps (e.g. toggles on the same switch) see fresh state.
          sw.is_on = desired;
          if (desired) onCount += 1;
          else offCount += 1;
          downstreamEvents.push({ kind: "switch", switchId: sw.id, isOn: desired });
          results.push({
            stepId: step.id,
            kind: "switch-target",
            summary,
            status: "done",
            mqttDispatched: dispatched.mqttDispatched,
            controllerOnline: true,
            acknowledged: { kind: "switch", switchId: sw.id, isOn: desired },
          });
        } else if (target.kind === "device" && target.deviceRow) {
          const dev = target.deviceRow;
          const currentlyActive = isDeviceStateActive(dev.state);
          const desiredState =
            target.op === "toggle"
              ? currentlyActive
                ? "inactive"
                : "active"
              : target.op === "on"
                ? "active"
                : "inactive";
          const desiredActive = isDeviceStateActive(desiredState);
          const online = controllerOnlineMap.get(dev.controller_id) ?? false;
          const summary = `Set "${dev.name}" to ${desiredState}`;
          if (!dev.is_online) {
            failStep(step.id, "device-target", summary, "Device is offline.", false);
            continue;
          }
          if (!online) {
            failStep(step.id, "device-target", summary, "Controller is offline.", false);
            continue;
          }
          const dispatched = await dispatchDeviceCommand({
            db,
            env,
            emqx,
            emqxReady,
            cred: credByController.get(dev.controller_id) ?? null,
            accountId,
            actorUserId,
            dev,
            desiredState,
          });
          if (!dispatched.ok) {
            failStep(step.id, "device-target", summary, dispatched.error, true);
            continue;
          }
          dev.state = desiredState;
          if (desiredActive) onCount += 1;
          else offCount += 1;
          downstreamEvents.push({ kind: "device", deviceId: dev.id, state: desiredState });
          results.push({
            stepId: step.id,
            kind: "device-target",
            summary,
            status: "done",
            mqttDispatched: dispatched.mqttDispatched,
            controllerOnline: true,
            acknowledged: { kind: "device", deviceId: dev.id, state: desiredState },
          });
        }
      }
    } catch (err) {
      results.push({
        stepId: step.id,
        kind: step.kind,
        summary: describeStep(step, roomNames),
        status: "failed",
        error: err instanceof Error ? err.message : "Step failed.",
      });
    }
  }

  // Chain downstream switch/device automation triggers like the primary APIs do.
  if (downstreamEvents.length > 0) {
    for (const downstream of downstreamEvents) {
      await evaluateAutomationsForEvent({
        db,
        env,
        emqxFetch,
        accountId,
        event: downstream,
        visitedRuleIds: new Set(visitedAutomationIds),
        preloadedRules,
      }).catch(() => 0);
    }
  }

  const executedCount = results.filter((r) => r.status === "done").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const executedAt = new Date().toISOString();

  await recordActivity(db, {
    accountId,
    actorUserId,
    category: "automation",
    action: "action_button.executed",
    summary: `Action button "${buttonName}" ran (${gesture} press): ${executedCount} ok, ${failedCount} failed`,
    metadata: {
      configId,
      gesture,
      executedCount,
      failedCount,
      errors: results.filter((r) => r.error).map((r) => r.error),
    },
  });

  return {
    ok: failedCount === 0,
    gesture,
    executedCount,
    failedCount,
    results,
    states: onCount + offCount > 0 ? { on: onCount, off: offCount } : null,
    executedAt,
  };
}

function describeStep(step: ActionButtonStep, roomNames: Map<string, string>): string {
  switch (step.kind) {
    case "switch":
      return `Switch → ${step.op}`;
    case "device":
      return `Device → ${step.op}`;
    case "room": {
      const room = roomNames.get(step.roomId) ?? "Room";
      return `${room} (${step.target}) → ${step.op}`;
    }
    case "all":
      return `All ${step.target} → ${step.op}`;
    case "automation":
      return "Run automation";
    case "delay":
      return `Wait ${step.ms} ms`;
  }
}

async function dispatchSwitchCommand(params: {
  db: AppEnv["Variables"]["db"];
  env: WorkerBindings;
  emqx: EmqxClient | null;
  emqxReady: boolean;
  cred: { topic_prefix: string } | null;
  accountId: string;
  actorUserId: string;
  sw: ControllableSwitchRow;
  desired: boolean;
}): Promise<{ ok: true; mqttDispatched: boolean } | { ok: false; error: string }> {
  const { db, emqx, emqxReady, cred, accountId, actorUserId, sw, desired } = params;

  let mqttDispatched = false;
  if (emqxReady && emqx && cred) {
    try {
      await emqx.publish({
        topic: `${cred.topic_prefix}/cmd/switch`,
        payload: {
          switch_id: sw.id,
          gpio_pin: sw.gpio_pin,
          state: desired ? "ON" : "OFF",
          inverted: sw.inverted,
          source: "action_button",
          actor_user_id: actorUserId,
        },
        qos: 1,
      });
      mqttDispatched = true;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to dispatch MQTT switch command.";
      return { ok: false, error: `Controller command failed: ${msg}` };
    }
  }

  await db
    .from("switches")
    .update({ is_on: desired, last_changed_at: new Date().toISOString() })
    .eq("id", sw.id)
    .eq("account_id", accountId);

  return { ok: true, mqttDispatched };
}

async function dispatchDeviceCommand(params: {
  db: AppEnv["Variables"]["db"];
  env: WorkerBindings;
  emqx: EmqxClient | null;
  emqxReady: boolean;
  cred: { topic_prefix: string } | null;
  accountId: string;
  actorUserId: string;
  dev: ControllableDeviceRow;
  desiredState: string;
}): Promise<{ ok: true; mqttDispatched: boolean } | { ok: false; error: string }> {
  const { db, emqx, emqxReady, cred, accountId, actorUserId, dev, desiredState } = params;

  let mqttDispatched = false;
  if (emqxReady && emqx && cred) {
    try {
      await emqx.publish({
        topic: `${cred.topic_prefix}/cmd/device`,
        payload: {
          device_id: dev.id,
          device_type: dev.device_type,
          gpio_pin: dev.gpio_pin,
          state: desiredState,
          active: isDeviceStateActive(desiredState),
          source: "action_button",
          actor_user_id: actorUserId,
        },
        qos: 1,
      });
      mqttDispatched = true;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to dispatch MQTT device command.";
      return { ok: false, error: `Controller command failed: ${msg}` };
    }
  }

  await db
    .from("devices")
    .update({ state: desiredState, last_state_at: new Date().toISOString() })
    .eq("id", dev.id)
    .eq("account_id", accountId);

  return { ok: true, mqttDispatched };
}

