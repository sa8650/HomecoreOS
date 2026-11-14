import {
  analyzeLocalAutomationCapability,
  buildTriggerConfigFromList,
  normalizeConditionGroups,
  normalizeTriggerList,
  type AutomationActionItem,
  type AutomationConditionGroup,
  type AutomationConditionItem,
  type AutomationConditionsConfig,
  type AutomationOperator,
  type AutomationTriggerConfig,
  type AutomationTriggerItem,
  type SceneTargetItem,
} from "./automations";
import { isValidIanaTimezone } from "./index";

export type FlowNodeKind =
  | "trigger"
  | "condition"
  | "logic"
  | "delay"
  | "action"
  | "end";

export interface FlowVariable {
  id: string;
  name: string;
  type: "string" | "number" | "boolean";
  initialValue: string | number | boolean;
}

export interface FlowTriggerNodeConfig {
  triggerType: "sensor_value" | "device_state" | "time" | "sun_event" | "manual";
  sensorId?: string;
  operator?: AutomationOperator;
  threshold?: number;
  switchId?: string;
  deviceId?: string;
  expectedState?: string | boolean;
  cronTime?: string;
  days?: string[];
  timezone?: string;
  sunEvent?: "sunrise" | "sunset";
  offsetMinutes?: number;
}

export interface FlowConditionNodeConfig {
  conditionType:
    | "sensor_value"
    | "switch_state"
    | "device_state"
    | "room_state"
    | "time_range"
    | "variable_check";
  sensorId?: string;
  operator?: AutomationOperator;
  threshold?: number;
  switchId?: string;
  deviceId?: string;
  expectedState?: string | boolean;
  roomId?: string;
  roomMatch?: "all_on" | "all_off" | "any_on";
  startTime?: string;
  endTime?: string;
  days?: string[];
  timezone?: string;
  variableName?: string;
  variableValue?: string | number | boolean;
}

export interface FlowLogicNodeConfig {
  gate: "ALL" | "ANY";
}

export interface FlowDelayNodeConfig {
  durationValue: number;
  durationUnit: "seconds" | "minutes" | "hours";
  cancelPreviousOnRetrigger?: boolean;
}

export interface FlowActionNodeConfig {
  actionType:
    | "switch_on"
    | "switch_off"
    | "device_state"
    | "scene"
    | "notification"
    | "http_request"
    | "set_variable";
  switchId?: string;
  deviceId?: string;
  targetState?: string;
  sceneName?: string;
  targets?: SceneTargetItem[];
  notificationTitle?: string;
  notificationMessage?: string;
  notificationSeverity?: "info" | "success" | "warning" | "danger";
  httpMethod?: "GET" | "POST" | "PUT" | "PATCH";
  httpUrl?: string;
  httpBody?: string;
  variableName?: string;
  variableValue?: string | number | boolean;
}

export interface FlowEndNodeConfig {
  outcome: "completed" | "stopped";
  note?: string;
}

export type FlowNodeConfig =
  | FlowTriggerNodeConfig
  | FlowConditionNodeConfig
  | FlowLogicNodeConfig
  | FlowDelayNodeConfig
  | FlowActionNodeConfig
  | FlowEndNodeConfig;

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  position: { x: number; y: number };
  label: string;
  config: FlowNodeConfig;
}

export interface FlowEdge {
  id: string;
  source: string;
  sourceHandle?: "out" | "true" | "false" | string | null;
  target: string;
  targetHandle?: "in" | string | null;
  label?: string;
}

export interface FlowGraph {
  version: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  variables: FlowVariable[];
  viewport?: { x: number; y: number; zoom: number };
}

export interface FlowNodeExecutionTrace {
  nodeId: string;
  label: string;
  kind: FlowNodeKind;
  status: "passed" | "failed" | "skipped" | "waiting" | "executed";
  detail: string;
  branchTaken?: "out" | "true" | "false";
}

export interface FlowExecutionTrace {
  evaluatedAt: string;
  triggered: boolean;
  conditionsMatched: boolean;
  executed: boolean;
  nodeResults: Record<string, FlowNodeExecutionTrace>;
  edgeStates: Record<string, "active" | "inactive">;
  variablesSnapshot: Record<string, string | number | boolean>;
  actionsPlanned: Array<{
    nodeId: string;
    actionType: string;
    detail: string;
    switchId?: string;
    deviceId?: string;
    targetState?: string;
    targets?: SceneTargetItem[];
    delayMs?: number;
    notificationTitle?: string;
    notificationMessage?: string;
    notificationSeverity?: "info" | "success" | "warning" | "danger";
    httpMethod?: string;
    httpUrl?: string;
    httpBody?: string;
    variableName?: string;
    variableValue?: string | number | boolean;
  }>;
  notes: string[];
}

export function detectFlowGraphCycles(graph: FlowGraph): string[] {
  const adj = new Map<string, string[]>();
  for (const node of graph.nodes) adj.set(node.id, []);
  for (const edge of graph.edges) {
    if (adj.has(edge.source) && adj.has(edge.target)) {
      adj.get(edge.source)!.push(edge.target);
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  const cycleMsgs: string[] = [];

  const dfs = (id: string, stack: string[]) => {
    state.set(id, "visiting");
    for (const next of adj.get(id) ?? []) {
      const s = state.get(next);
      if (s === "visiting") {
        const startIdx = stack.indexOf(next);
        const loop = [...stack.slice(Math.max(0, startIdx)), next];
        cycleMsgs.push(`Flow contains a loop (${loop.join(" -> ")}). Remove cyclic edges.`);
        return;
      }
      if (!s) {
        dfs(next, [...stack, next]);
      }
    }
    state.set(id, "visited");
  };

  for (const node of graph.nodes) {
    if (!state.has(node.id)) {
      dfs(node.id, [node.id]);
    }
  }
  return cycleMsgs;
}

export function validateFlowGraph(params: {
  name: string;
  graph: FlowGraph;
  fallbackTimezone?: string;
}): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { graph } = params;

  if (!params.name.trim()) {
    errors.push("Flow name is required.");
  }

  const triggers = graph.nodes.filter((n) => n.kind === "trigger");
  const actions = graph.nodes.filter((n) => n.kind === "action");
  if (triggers.length === 0) {
    errors.push("Add at least one Trigger node to start the flow.");
  }
  if (actions.length === 0) {
    errors.push("Add at least one Action node to perform work when triggered.");
  }

  errors.push(...detectFlowGraphCycles(graph));

  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  for (const n of graph.nodes) {
    incomingCount.set(n.id, 0);
    outgoingCount.set(n.id, 0);
  }
  for (const e of graph.edges) {
    outgoingCount.set(e.source, (outgoingCount.get(e.source) ?? 0) + 1);
    incomingCount.set(e.target, (incomingCount.get(e.target) ?? 0) + 1);
  }

  for (const node of graph.nodes) {
    if (node.kind !== "trigger" && (incomingCount.get(node.id) ?? 0) === 0) {
      errors.push(`Node "${node.label}" has no incoming connection.`);
    }
    if (node.kind === "trigger" && (outgoingCount.get(node.id) ?? 0) === 0) {
      warnings.push(`Trigger "${node.label}" is not connected to any downstream node.`);
    }

    if (node.kind === "trigger") {
      const cfg = node.config as FlowTriggerNodeConfig;
      if (cfg.triggerType === "sensor_value") {
        if (!cfg.sensorId) errors.push(`Trigger "${node.label}": select a sensor.`);
        if (typeof cfg.threshold !== "number" || !Number.isFinite(cfg.threshold)) {
          errors.push(`Trigger "${node.label}": numeric threshold is required.`);
        }
      } else if (cfg.triggerType === "device_state") {
        if (!cfg.switchId && !cfg.deviceId) {
          errors.push(`Trigger "${node.label}": select a switch or device.`);
        }
      } else if (cfg.triggerType === "time") {
        if (!cfg.cronTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.cronTime)) {
          errors.push(`Trigger "${node.label}": enter a valid HH:MM schedule time.`);
        }
        const tz = cfg.timezone ?? params.fallbackTimezone;
        if (tz && !isValidIanaTimezone(tz)) {
          errors.push(`Trigger "${node.label}": invalid timezone "${tz}".`);
        }
      } else if (cfg.triggerType === "sun_event") {
        if (cfg.sunEvent !== "sunrise" && cfg.sunEvent !== "sunset") {
          errors.push(`Trigger "${node.label}": select sunrise or sunset.`);
        }
      }
    } else if (node.kind === "condition") {
      const cfg = node.config as FlowConditionNodeConfig;
      if (cfg.conditionType === "sensor_value") {
        if (!cfg.sensorId) errors.push(`Condition "${node.label}": select a sensor.`);
      } else if (cfg.conditionType === "switch_state") {
        if (!cfg.switchId) errors.push(`Condition "${node.label}": select a switch.`);
      } else if (cfg.conditionType === "device_state") {
        if (!cfg.deviceId || !String(cfg.expectedState ?? "").trim()) {
          errors.push(`Condition "${node.label}": select a device and expected state.`);
        }
      } else if (cfg.conditionType === "room_state") {
        if (!cfg.roomId) errors.push(`Condition "${node.label}": select a room.`);
      } else if (cfg.conditionType === "time_range") {
        if (
          !cfg.startTime ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.startTime) ||
          !cfg.endTime ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.endTime)
        ) {
          errors.push(`Condition "${node.label}": enter valid HH:MM start and end times.`);
        }
      } else if (cfg.conditionType === "variable_check") {
        if (!cfg.variableName?.trim()) {
          errors.push(`Condition "${node.label}": select a flow variable.`);
        }
      }
    } else if (node.kind === "delay") {
      const cfg = node.config as FlowDelayNodeConfig;
      if (!Number.isFinite(cfg.durationValue) || cfg.durationValue <= 0) {
        errors.push(`Delay "${node.label}": duration must be greater than 0.`);
      }
    } else if (node.kind === "action") {
      const cfg = node.config as FlowActionNodeConfig;
      if (cfg.actionType === "switch_on" || cfg.actionType === "switch_off") {
        if (!cfg.switchId) errors.push(`Action "${node.label}": select a switch.`);
      } else if (cfg.actionType === "device_state") {
        if (!cfg.deviceId || !String(cfg.targetState ?? "").trim()) {
          errors.push(`Action "${node.label}": select a device and target state.`);
        }
      } else if (cfg.actionType === "scene") {
        if (!cfg.sceneName?.trim()) {
          errors.push(`Action "${node.label}": enter a scene name.`);
        }
        if (!Array.isArray(cfg.targets) || cfg.targets.length === 0) {
          errors.push(`Action "${node.label}": add at least one scene target.`);
        }
      } else if (cfg.actionType === "notification") {
        if (!cfg.notificationTitle?.trim() || !cfg.notificationMessage?.trim()) {
          errors.push(`Action "${node.label}": title and message are required.`);
        }
      } else if (cfg.actionType === "http_request") {
        if (!cfg.httpUrl || !/^https?:\/\/.+/i.test(cfg.httpUrl.trim())) {
          errors.push(`Action "${node.label}": valid http:// or https:// URL is required.`);
        }
      } else if (cfg.actionType === "set_variable") {
        if (!cfg.variableName?.trim()) {
          errors.push(`Action "${node.label}": variable name is required.`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function autoLayoutFlowGraph(graph: FlowGraph): FlowGraph {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of graph.edges) {
    if (adj.has(e.source) && inDegree.has(e.target)) {
      adj.get(e.source)!.push(e.target);
      inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    }
  }

  const layer = new Map<string, number>();
  const queue: string[] = [];
  for (const n of graph.nodes) {
    if ((inDegree.get(n.id) ?? 0) === 0 || n.kind === "trigger") {
      layer.set(n.id, 0);
      queue.push(n.id);
    }
  }

  const seenOrder: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    seenOrder.push(id);
    const curLayer = layer.get(id) ?? 0;
    for (const next of adj.get(id) ?? []) {
      const nextLayer = Math.max(layer.get(next) ?? 0, curLayer + 1);
      layer.set(next, nextLayer);
      if (!seenOrder.includes(next) && !queue.includes(next)) {
        queue.push(next);
      }
    }
  }

  const byLayer = new Map<number, FlowNode[]>();
  for (const n of graph.nodes) {
    const l = layer.get(n.id) ?? (n.kind === "trigger" ? 0 : 1);
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(n);
  }

  const positioned = new Map<string, { x: number; y: number }>();
  for (const [l, nodesInCol] of Array.from(byLayer.entries()).sort((a, b) => a[0] - b[0])) {
    const x = 80 + l * 330;
    const totalH = (nodesInCol.length - 1) * 165;
    const startY = Math.max(70, 220 - totalH / 2);
    nodesInCol.forEach((n, idx) => {
      positioned.set(n.id, { x, y: Math.round(startY + idx * 165) });
    });
  }

  return {
    ...graph,
    nodes: graph.nodes.map((n) => ({
      ...n,
      position: positioned.get(n.id) ?? n.position,
    })),
  };
}

export function flowGraphFromLegacyRule(rule: {
  name?: string;
  trigger_config: AutomationTriggerConfig;
  conditions_config?: AutomationConditionsConfig | null;
  actions_config: AutomationActionItem[];
}): FlowGraph {
  const triggers = normalizeTriggerList(rule.trigger_config);
  const condGrouped = normalizeConditionGroups(rule.conditions_config);
  const actions = Array.isArray(rule.actions_config) ? rule.actions_config : [];

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  // 1. Trigger column
  const triggerIds: string[] = [];
  triggers.forEach((t, idx) => {
    const id = `trig-${idx + 1}`;
    triggerIds.push(id);
    const label =
      t.type === "sensor_value"
        ? `Sensor ${t.operator ?? "gt"} ${t.threshold ?? 0}`
        : t.type === "device_state"
          ? "Device State Trigger"
          : t.type === "time"
            ? `At ${t.cronTime ?? "18:00"}`
            : `${t.sunEvent === "sunrise" ? "Sunrise" : "Sunset"}`;
    nodes.push({
      id,
      kind: "trigger",
      position: { x: 80, y: 120 + idx * 150 },
      label,
      config: {
        triggerType: t.type,
        sensorId: t.sensorId,
        operator: t.operator,
        threshold: t.threshold,
        switchId: t.switchId,
        deviceId: t.deviceId,
        expectedState: t.expectedState,
        cronTime: t.cronTime,
        days: t.days,
        timezone: t.timezone,
        sunEvent: t.sunEvent,
        offsetMinutes: t.offsetMinutes,
      },
    });
  });

  let frontierIds = triggerIds;
  let frontierHandle: "out" | "true" = "out";

  if (triggerIds.length > 1) {
    const joinId = "logic-trig-any";
    nodes.push({
      id: joinId,
      kind: "logic",
      position: { x: 380, y: 150 },
      label: "ANY Trigger",
      config: { gate: "ANY" },
    });
    for (const tid of triggerIds) {
      edges.push({
        id: `e-${tid}-${joinId}`,
        source: tid,
        sourceHandle: "out",
        target: joinId,
        targetHandle: "in",
      });
    }
    frontierIds = [joinId];
    frontierHandle = "out";
  }

  // 2. Conditions respecting group AND / OR logic
  let condCounter = 0;
  const nonEmptyGroups = condGrouped.groups.filter((g) => g.conditions.length > 0);
  const makeConditionNode = (c: AutomationConditionItem, idx: number): FlowNode => {
    const cid = `cond-${idx}`;
    const label =
      c.type === "sensor_value"
        ? `Sensor ${c.operator ?? "gt"} ${c.threshold ?? 0}`
        : c.type === "switch_state"
          ? "Check Switch"
          : c.type === "device_state"
            ? "Check Device"
            : c.type === "room_state"
              ? "Check Room"
              : "Time Window";
    return {
      id: cid,
      kind: "condition",
      position: { x: 400 + idx * 280, y: 150 },
      label,
      config: {
        conditionType: c.type,
        sensorId: c.sensorId,
        operator: c.operator,
        threshold: c.threshold,
        switchId: c.switchId,
        deviceId: c.deviceId,
        expectedState: c.expectedState,
        roomId: c.roomId,
        roomMatch: c.roomMatch,
        startTime: c.startTime,
        endTime: c.endTime,
        days: c.days,
        timezone: c.timezone,
      },
    };
  };

  if (condGrouped.logic === "OR" && nonEmptyGroups.length > 1) {
    const groupEndIds: Array<{ id: string; handle: "out" | "true" }> = [];
    nonEmptyGroups.forEach((grp, gIdx) => {
      let curSources = frontierIds;
      let curHandle: "out" | "true" = frontierHandle;
      if (grp.logic === "OR" && grp.conditions.length > 1) {
        const branchIds: string[] = [];
        for (const c of grp.conditions) {
          condCounter += 1;
          const node = makeConditionNode(c, condCounter);
          nodes.push(node);
          branchIds.push(node.id);
          for (const prev of curSources) {
            edges.push({
              id: `e-${prev}-${node.id}`,
              source: prev,
              sourceHandle: curHandle,
              target: node.id,
              targetHandle: "in",
            });
          }
        }
        const orJoinId = `logic-grp-any-${gIdx + 1}`;
        nodes.push({
          id: orJoinId,
          kind: "logic",
          position: { x: 640, y: 150 + gIdx * 160 },
          label: "ANY Condition",
          config: { gate: "ANY" },
        });
        for (const bid of branchIds) {
          edges.push({
            id: `e-${bid}-${orJoinId}`,
            source: bid,
            sourceHandle: "true",
            target: orJoinId,
            targetHandle: "in",
          });
        }
        groupEndIds.push({ id: orJoinId, handle: "out" });
      } else {
        for (const c of grp.conditions) {
          condCounter += 1;
          const node = makeConditionNode(c, condCounter);
          nodes.push(node);
          for (const prev of curSources) {
            edges.push({
              id: `e-${prev}-${node.id}`,
              source: prev,
              sourceHandle: curHandle,
              target: node.id,
              targetHandle: "in",
            });
          }
          curSources = [node.id];
          curHandle = "true";
        }
        groupEndIds.push({ id: curSources[0]!, handle: curHandle });
      }
    });
    const topOrJoin = "logic-cond-any";
    nodes.push({
      id: topOrJoin,
      kind: "logic",
      position: { x: 860, y: 150 },
      label: "ANY Group",
      config: { gate: "ANY" },
    });
    for (const end of groupEndIds) {
      edges.push({
        id: `e-${end.id}-${topOrJoin}`,
        source: end.id,
        sourceHandle: end.handle,
        target: topOrJoin,
        targetHandle: "in",
      });
    }
    frontierIds = [topOrJoin];
    frontierHandle = "out";
  } else {
    nonEmptyGroups.forEach((grp, gIdx) => {
      if (grp.logic === "OR" && grp.conditions.length > 1) {
        const branchIds: string[] = [];
        for (const c of grp.conditions) {
          condCounter += 1;
          const node = makeConditionNode(c, condCounter);
          nodes.push(node);
          branchIds.push(node.id);
          for (const prev of frontierIds) {
            edges.push({
              id: `e-${prev}-${node.id}`,
              source: prev,
              sourceHandle: frontierHandle,
              target: node.id,
              targetHandle: "in",
            });
          }
        }
        const orJoinId = `logic-grp-any-${gIdx + 1}`;
        nodes.push({
          id: orJoinId,
          kind: "logic",
          position: { x: 640, y: 150 },
          label: "ANY Condition",
          config: { gate: "ANY" },
        });
        for (const bid of branchIds) {
          edges.push({
            id: `e-${bid}-${orJoinId}`,
            source: bid,
            sourceHandle: "true",
            target: orJoinId,
            targetHandle: "in",
          });
        }
        frontierIds = [orJoinId];
        frontierHandle = "out";
      } else {
        for (const c of grp.conditions) {
          condCounter += 1;
          const node = makeConditionNode(c, condCounter);
          nodes.push(node);
          for (const prev of frontierIds) {
            edges.push({
              id: `e-${prev}-${node.id}`,
              source: prev,
              sourceHandle: frontierHandle,
              target: node.id,
              targetHandle: "in",
            });
          }
          frontierIds = [node.id];
          frontierHandle = "true";
        }
      }
    });
  }

  // 3. Actions column
  const actionX = 420 + condCounter * 280 + (triggerIds.length > 1 ? 260 : 0);
  actions.forEach((a, idx) => {
    const aid = `act-${idx + 1}`;
    const label =
      a.type === "switch_on"
        ? "Switch ON"
        : a.type === "switch_off"
          ? "Switch OFF"
          : a.type === "scene"
            ? a.sceneName || "Run Scene"
            : "Set Device";
    nodes.push({
      id: aid,
      kind: "action",
      position: { x: actionX, y: 120 + idx * 150 },
      label,
      config: {
        actionType: a.type,
        switchId: a.switchId,
        deviceId: a.deviceId,
        targetState: a.targetState,
        sceneName: a.sceneName,
        targets: a.targets,
      },
    });
    for (const prev of frontierIds) {
      edges.push({
        id: `e-${prev}-${aid}`,
        source: prev,
        sourceHandle: frontierHandle,
        target: aid,
        targetHandle: "in",
      });
    }
  });

  return autoLayoutFlowGraph({
    version: 1,
    variables: [],
    nodes,
    edges,
  });
}

export function compileFlowGraphToRuleConfigs(graph: FlowGraph): {
  triggerConfig: AutomationTriggerConfig;
  conditionsConfig: AutomationConditionsConfig;
  actionsConfig: AutomationActionItem[];
  isSimpleLinear: boolean;
} {
  const triggerItems: AutomationTriggerItem[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "trigger") continue;
    const cfg = node.config as FlowTriggerNodeConfig;
    if (cfg.triggerType === "manual") continue;
    triggerItems.push({
      id: node.id,
      type: cfg.triggerType,
      sensorId: cfg.sensorId,
      operator: cfg.operator,
      threshold: cfg.threshold,
      switchId: cfg.switchId,
      deviceId: cfg.deviceId,
      expectedState: cfg.expectedState,
      cronTime: cfg.cronTime,
      days: cfg.days,
      timezone: cfg.timezone,
      sunEvent: cfg.sunEvent,
      offsetMinutes: cfg.offsetMinutes,
    });
  }

  const condItems: AutomationConditionItem[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "condition") continue;
    const cfg = node.config as FlowConditionNodeConfig;
    if (cfg.conditionType === "variable_check") continue;
    condItems.push({
      id: node.id,
      type: cfg.conditionType,
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
    });
  }

  const actionItems: AutomationActionItem[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "action") continue;
    const cfg = node.config as FlowActionNodeConfig;
    if (
      cfg.actionType === "switch_on" ||
      cfg.actionType === "switch_off" ||
      cfg.actionType === "device_state" ||
      cfg.actionType === "scene"
    ) {
      actionItems.push({
        id: node.id,
        type: cfg.actionType,
        switchId: cfg.switchId,
        deviceId: cfg.deviceId,
        targetState: cfg.targetState,
        sceneName: cfg.sceneName,
        targets: cfg.targets,
      });
    }
  }

  const hasAdvancedNodes = graph.nodes.some(
    (n) =>
      n.kind === "delay" ||
      n.kind === "logic" ||
      (n.kind === "action" &&
        ["notification", "http_request", "set_variable"].includes(
          (n.config as FlowActionNodeConfig).actionType
        )) ||
      (n.kind === "trigger" &&
        (n.config as FlowTriggerNodeConfig).triggerType === "manual") ||
      (n.kind === "condition" &&
        (n.config as FlowConditionNodeConfig).conditionType === "variable_check")
  );

  const hasFalseBranch = graph.edges.some((e) => e.sourceHandle === "false");
  const isSimpleLinear = !hasAdvancedNodes && !hasFalseBranch;

  const groups: AutomationConditionGroup[] =
    condItems.length > 0
      ? [{ id: "group-1", logic: "AND", conditions: condItems }]
      : [];

  return {
    triggerConfig: buildTriggerConfigFromList(
      triggerItems.length > 0 ? triggerItems : [{ type: "sensor_value" }]
    ),
    conditionsConfig: { logic: "AND", groups },
    actionsConfig: actionItems,
    isSimpleLinear,
  };
}

export function analyzeFlowGraphLocalCapability(params: {
  graph: FlowGraph;
  switchControllerById: Map<string, string>;
  deviceControllerById: Map<string, string>;
  sensorControllerById: Map<string, string>;
}): {
  supported: boolean;
  controllerId: string | null;
  reasons: string[];
} {
  const compiled = compileFlowGraphToRuleConfigs(params.graph);
  const reasons: string[] = [];

  if (!compiled.isSimpleLinear) {
    reasons.push(
      "Flows using Delays, Notifications, HTTP requests, Variables, Logic joins, or False branches run in the cloud flow engine."
    );
  }
  if (compiled.actionsConfig.length === 0 && reasons.length === 0) {
    reasons.push("Add at least one hardware action to evaluate local execution.");
  }

  const legacyAnalysis = analyzeLocalAutomationCapability({
    triggers: normalizeTriggerList(compiled.triggerConfig),
    conditions: normalizeConditionGroups(compiled.conditionsConfig),
    actions: compiled.actionsConfig,
    switchControllerById: params.switchControllerById,
    deviceControllerById: params.deviceControllerById,
    sensorControllerById: params.sensorControllerById,
  });

  const allReasons = [...reasons, ...legacyAnalysis.reasons];
  const supported = allReasons.length === 0 && legacyAnalysis.supported;
  return {
    supported,
    controllerId: supported ? legacyAnalysis.controllerId : null,
    reasons: allReasons,
  };
}
