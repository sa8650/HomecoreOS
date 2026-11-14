import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  analyzeFlowGraphLocalCapability,
  autoLayoutFlowGraph,
  compileFlowGraphToRuleConfigs,
  computeSunTimeHHMM,
  flowGraphFromLegacyRule,
  isDeviceStateActive,
  validateFlowGraph,
  type AutomationOperator,
  type FlowActionNodeConfig,
  type FlowConditionNodeConfig,
  type FlowDelayNodeConfig,
  type FlowEdge,
  type FlowEndNodeConfig,
  type FlowExecutionTrace,
  type FlowGraph,
  type FlowLogicNodeConfig,
  type FlowNode,
  type FlowNodeExecutionTrace,
  type FlowNodeKind,
  type FlowTriggerNodeConfig,
  type FlowVariable,
  type SceneTargetItem,
} from "@homecoreos/shared";
import {
  RiAddLine,
  RiArrowGoBackLine,
  RiArrowGoForwardLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiFlashlightLine,
  RiFlaskLine,
  RiFolderLine,
  RiGitBranchLine,
  RiGlobalLine,
  RiLayoutGridLine,
  RiNotification3Line,
  RiPlayLine,
  RiSaveLine,
  RiSensorLine,
  RiSettings3Line,
  RiSparklingLine,
  RiStopCircleLine,
  RiSunLine,
  RiTimeLine,
  RiTimerLine,
  RiToggleLine,
  RiWifiOffLine,
} from "@remixicon/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { apiFetch, ApiError } from "@/lib/api";
import { Badge } from "@/components/reui/badge";
import { FormField, StatusAlert } from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type {
  AutomationItem,
  ControllerItem,
  DeviceItem,
  RoomItem,
  SensorItem,
  SwitchItem,
} from "@/features/types";

const WEEKDAYS = [
  { id: "mon", label: "Mon" },
  { id: "tue", label: "Tue" },
  { id: "wed", label: "Wed" },
  { id: "thu", label: "Thu" },
  { id: "fri", label: "Fri" },
  { id: "sat", label: "Sat" },
  { id: "sun", label: "Sun" },
];

const OPERATOR_OPTIONS: Array<{ value: AutomationOperator; label: string }> = [
  { value: "gt", label: "Greater than (>)" },
  { value: "gte", label: "Greater or equal (>=)" },
  { value: "lt", label: "Less than (<)" },
  { value: "lte", label: "Less or equal (<=)" },
  { value: "eq", label: "Equals (=)" },
  { value: "neq", label: "Not equal (!=)" },
];

const OP_SYMBOL: Record<AutomationOperator, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  eq: "=",
  neq: "!=",
};

export interface VisualAutomationBuilderProps {
  initialRule: AutomationItem | null;
  sensors: SensorItem[];
  switches: SwitchItem[];
  devices: DeviceItem[];
  rooms: RoomItem[];
  controllers: ControllerItem[];
  existingFolders?: string[];
  flowsMenuSlot?: ReactNode;
  timezone: string;
  canManage: boolean;
  canOperate: boolean;
  onSaved: (message: string, saved?: AutomationItem) => Promise<void> | void;
  onCancelEdit: () => void;
}

interface FlowNodeCardData extends Record<string, unknown> {
  flowNode: FlowNode;
  subtitle: string;
  trace?: FlowNodeExecutionTrace;
  canManage: boolean;
  onDelete: (id: string) => void;
}

function makeUid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeFlowNode(
  node: FlowNode,
  sensorById: Map<string, SensorItem>,
  switchById: Map<string, SwitchItem>,
  deviceById: Map<string, DeviceItem>,
  roomById: Map<string, RoomItem>
): string {
  if (node.kind === "trigger") {
    const cfg = node.config as FlowTriggerNodeConfig;
    if (cfg.triggerType === "sensor_value") {
      const s = cfg.sensorId ? sensorById.get(cfg.sensorId) : undefined;
      const op = OP_SYMBOL[cfg.operator ?? "gt"];
      return `${s?.name ?? "Select sensor"} ${op} ${cfg.threshold ?? 0}${s?.unit ? ` ${s.unit}` : ""}`;
    }
    if (cfg.triggerType === "device_state") {
      if (cfg.switchId) {
        const sw = switchById.get(cfg.switchId);
        return `${sw?.name ?? "Select switch"} → ${cfg.expectedState ? "ON" : "OFF"}`;
      }
      const dv = cfg.deviceId ? deviceById.get(cfg.deviceId) : undefined;
      return `${dv?.name ?? "Select device"} → ${cfg.expectedState ?? "active"}`;
    }
    if (cfg.triggerType === "time") {
      return `Schedule ${cfg.cronTime ?? "18:00"}`;
    }
    if (cfg.triggerType === "sun_event") {
      const off = cfg.offsetMinutes ?? 0;
      const sign = off > 0 ? ` +${off}m` : off < 0 ? ` ${off}m` : "";
      return `At ${cfg.sunEvent ?? "sunset"}${sign}`;
    }
    return "Manual flow trigger";
  }

  if (node.kind === "condition") {
    const cfg = node.config as FlowConditionNodeConfig;
    if (cfg.conditionType === "sensor_value") {
      const s = cfg.sensorId ? sensorById.get(cfg.sensorId) : undefined;
      return `${s?.name ?? "Sensor"} ${OP_SYMBOL[cfg.operator ?? "gt"]} ${cfg.threshold ?? 0}`;
    }
    if (cfg.conditionType === "switch_state") {
      const sw = cfg.switchId ? switchById.get(cfg.switchId) : undefined;
      return `${sw?.name ?? "Switch"} is ${cfg.expectedState ? "ON" : "OFF"}`;
    }
    if (cfg.conditionType === "device_state") {
      const dv = cfg.deviceId ? deviceById.get(cfg.deviceId) : undefined;
      return `${dv?.name ?? "Device"} = ${cfg.expectedState ?? "active"}`;
    }
    if (cfg.conditionType === "room_state") {
      const rm = cfg.roomId ? roomById.get(cfg.roomId) : undefined;
      return `${rm?.name ?? "Room"} (${cfg.roomMatch ?? "any_on"})`;
    }
    if (cfg.conditionType === "variable_check") {
      return `$${cfg.variableName ?? "var"} = ${String(cfg.variableValue ?? "")}`;
    }
    return `${cfg.startTime ?? "18:00"} – ${cfg.endTime ?? "23:00"}`;
  }

  if (node.kind === "logic") {
    const cfg = node.config as FlowLogicNodeConfig;
    return cfg.gate === "ALL" ? "Wait for ALL inputs" : "Continue on ANY input";
  }

  if (node.kind === "delay") {
    const cfg = node.config as FlowDelayNodeConfig;
    return `Wait ${cfg.durationValue} ${cfg.durationUnit}`;
  }

  if (node.kind === "action") {
    const cfg = node.config as FlowActionNodeConfig;
    if (cfg.actionType === "switch_on" || cfg.actionType === "switch_off") {
      const sw = cfg.switchId ? switchById.get(cfg.switchId) : undefined;
      return `${sw?.name ?? "Select switch"} → ${cfg.actionType === "switch_on" ? "ON" : "OFF"}`;
    }
    if (cfg.actionType === "device_state") {
      const dv = cfg.deviceId ? deviceById.get(cfg.deviceId) : undefined;
      return `${dv?.name ?? "Select device"} → ${cfg.targetState ?? "active"}`;
    }
    if (cfg.actionType === "scene") {
      return `${cfg.sceneName || "Scene"} (${cfg.targets?.length ?? 0} targets)`;
    }
    if (cfg.actionType === "notification") {
      return cfg.notificationTitle || "Send Alert";
    }
    if (cfg.actionType === "http_request") {
      return `${cfg.httpMethod ?? "POST"} ${cfg.httpUrl || "https://..."}`;
    }
    return `Set $${cfg.variableName || "var"} = ${String(cfg.variableValue ?? "")}`;
  }

  const endCfg = node.config as FlowEndNodeConfig;
  return endCfg.outcome === "stopped" ? "Stop Branch" : "Flow Completed";
}

function getTraceBadgeStyle(trace?: FlowNodeExecutionTrace): string {
  if (!trace) return "";
  switch (trace.status) {
    case "executed":
    case "passed":
      return "ring-2 ring-emerald-500 border-emerald-500";
    case "failed":
      return "ring-2 ring-rose-500 border-rose-500";
    case "waiting":
      return "ring-2 ring-amber-500 border-amber-500";
    case "skipped":
      return "opacity-55 border-dashed";
    default:
      return "";
  }
}

const TriggerFlowNode = memo(function TriggerFlowNode({
  id,
  data,
  selected,
}: NodeProps<Node<FlowNodeCardData>>) {
  const cfg = data.flowNode.config as FlowTriggerNodeConfig;
  const Icon =
    cfg.triggerType === "sun_event"
      ? RiSunLine
      : cfg.triggerType === "time"
        ? RiTimeLine
        : cfg.triggerType === "device_state"
          ? RiToggleLine
          : cfg.triggerType === "manual"
            ? RiPlayLine
            : RiSensorLine;

  return (
    <div
      className={cn(
        "group min-w-[215px] max-w-[245px] rounded-xl border bg-card shadow-sm transition-all",
        selected ? "border-sky-500 ring-2 ring-sky-500/35" : "border-border hover:border-sky-500/50",
        getTraceBadgeStyle(data.trace)
      )}
    >
      <div className="flex items-center justify-between gap-2 rounded-t-[11px] bg-sky-500/12 px-3 py-1.5 border-b border-sky-500/20">
        <div className="flex items-center gap-1.5 text-sky-700 dark:text-sky-300">
          <Icon className="size-3.5 shrink-0" />
          <span className="text-[10px] font-bold uppercase tracking-wider">When · Trigger</span>
        </div>
        <div className="flex items-center gap-1">
          {data.trace && (
            <Badge variant="outline" size="xs" className="text-[9px]">
              {data.trace.status}
            </Badge>
          )}
          {data.canManage && (
            <button
              type="button"
              aria-label="Remove card"
              title="Remove card"
              onClick={(e) => {
                e.stopPropagation();
                data.onDelete(id);
              }}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 rounded p-0.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-opacity"
            >
              <RiCloseLine className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="px-3 py-2.5">
        <p className="text-xs font-semibold text-foreground truncate">{data.flowNode.label}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground truncate">{data.subtitle}</p>
      </div>
      <Handle
        id="out"
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !border-2 !border-background !bg-sky-500"
      />
    </div>
  );
});

const ConditionFlowNode = memo(function ConditionFlowNode({
  id,
  data,
  selected,
}: NodeProps<Node<FlowNodeCardData>>) {
  return (
    <div
      className={cn(
        "group min-w-[235px] max-w-[265px] rounded-xl border bg-card shadow-sm transition-all",
        selected ? "border-amber-500 ring-2 ring-amber-500/35" : "border-border hover:border-amber-500/50",
        getTraceBadgeStyle(data.trace)
      )}
    >
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !border-2 !border-background !bg-slate-400"
      />
      <div className="flex items-center justify-between gap-2 rounded-t-[11px] bg-amber-500/12 px-3 py-1.5 border-b border-amber-500/20">
        <div className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
          <RiGitBranchLine className="size-3.5 shrink-0" />
          <span className="text-[10px] font-bold uppercase tracking-wider">If · Condition</span>
        </div>
        <div className="flex items-center gap-1">
          {data.trace && (
            <Badge
              variant={data.trace.status === "passed" ? "success-light" : "warning-light"}
              size="xs"
              className="text-[9px]"
            >
              {data.trace.branchTaken ?? data.trace.status}
            </Badge>
          )}
          {data.canManage && (
            <button
              type="button"
              aria-label="Remove card"
              title="Remove card"
              onClick={(e) => {
                e.stopPropagation();
                data.onDelete(id);
              }}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 rounded p-0.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-opacity"
            >
              <RiCloseLine className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="px-3 py-2.5 pr-12 relative">
        <p className="text-xs font-semibold text-foreground truncate">{data.flowNode.label}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground truncate">{data.subtitle}</p>
        <div className="absolute right-2 top-2 flex items-center gap-1 text-[9px] font-bold text-emerald-600">
          <RiCheckLine className="size-3" />
          True
        </div>
        <div className="absolute right-2 bottom-2 flex items-center gap-1 text-[9px] font-bold text-rose-600">
          <RiCloseLine className="size-3" />
          False
        </div>
      </div>
      <Handle
        id="true"
        type="source"
        position={Position.Right}
        style={{ top: "54%" }}
        className="!h-3 !w-3 !border-2 !border-background !bg-emerald-500"
      />
      <Handle
        id="false"
        type="source"
        position={Position.Right}
        style={{ top: "82%" }}
        className="!h-3 !w-3 !border-2 !border-background !bg-rose-500"
      />
    </div>
  );
});

const LogicFlowNode = memo(function LogicFlowNode({
  id,
  data,
  selected,
}: NodeProps<Node<FlowNodeCardData>>) {
  const cfg = data.flowNode.config as FlowLogicNodeConfig;
  return (
    <div
      className={cn(
        "group min-w-[145px] rounded-full border bg-card px-4 py-2 shadow-sm transition-all",
        selected ? "border-violet-500 ring-2 ring-violet-500/35" : "border-violet-500/40 hover:border-violet-500/70",
        getTraceBadgeStyle(data.trace)
      )}
    >
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !border-2 !border-background !bg-violet-500"
      />
      <div className="flex items-center justify-center gap-2">
        <Badge variant="info-light" size="xs" className="font-mono font-bold">
          {cfg.gate}
        </Badge>
        <span className="text-xs font-semibold text-foreground">{data.flowNode.label}</span>
        {data.canManage && (
          <button
            type="button"
            aria-label="Remove card"
            title="Remove card"
            onClick={(e) => {
              e.stopPropagation();
              data.onDelete(id);
            }}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 rounded-full p-0.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-opacity"
          >
            <RiCloseLine className="size-3" />
          </button>
        )}
      </div>
      <Handle
        id="out"
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !border-2 !border-background !bg-violet-500"
      />
    </div>
  );
});

const DelayFlowNode = memo(function DelayFlowNode({
  id,
  data,
  selected,
}: NodeProps<Node<FlowNodeCardData>>) {
  return (
    <div
      className={cn(
        "group min-w-[175px] rounded-full border bg-card px-3.5 py-2 shadow-sm transition-all",
        selected ? "border-cyan-500 ring-2 ring-cyan-500/35" : "border-cyan-500/40 hover:border-cyan-500/70",
        getTraceBadgeStyle(data.trace)
      )}
    >
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !border-2 !border-background !bg-cyan-500"
      />
      <div className="flex items-center gap-2">
        <RiTimerLine className="size-4 text-cyan-600 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-foreground truncate">{data.flowNode.label}</p>
          <p className="text-[10px] text-muted-foreground truncate">{data.subtitle}</p>
        </div>
        {data.canManage && (
          <button
            type="button"
            aria-label="Remove card"
            title="Remove card"
            onClick={(e) => {
              e.stopPropagation();
              data.onDelete(id);
            }}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 rounded-full p-0.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-opacity"
          >
            <RiCloseLine className="size-3" />
          </button>
        )}
      </div>
      <Handle
        id="out"
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !border-2 !border-background !bg-cyan-500"
      />
    </div>
  );
});

const ActionFlowNode = memo(function ActionFlowNode({
  id,
  data,
  selected,
}: NodeProps<Node<FlowNodeCardData>>) {
  const cfg = data.flowNode.config as FlowActionNodeConfig;
  const Icon =
    cfg.actionType === "scene"
      ? RiSparklingLine
      : cfg.actionType === "notification"
        ? RiNotification3Line
        : cfg.actionType === "http_request"
          ? RiGlobalLine
          : RiFlashlightLine;

  return (
    <div
      className={cn(
        "group min-w-[215px] max-w-[250px] rounded-xl border bg-card shadow-sm transition-all",
        selected ? "border-emerald-500 ring-2 ring-emerald-500/35" : "border-border hover:border-emerald-500/50",
        getTraceBadgeStyle(data.trace)
      )}
    >
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !border-2 !border-background !bg-emerald-500"
      />
      <div className="flex items-center justify-between gap-2 rounded-t-[11px] bg-emerald-500/12 px-3 py-1.5 border-b border-emerald-500/20">
        <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
          <Icon className="size-3.5 shrink-0" />
          <span className="text-[10px] font-bold uppercase tracking-wider">Then · Action</span>
        </div>
        <div className="flex items-center gap-1">
          {data.trace && (
            <Badge variant="success-light" size="xs" className="text-[9px]">
              {data.trace.status}
            </Badge>
          )}
          {data.canManage && (
            <button
              type="button"
              aria-label="Remove card"
              title="Remove card"
              onClick={(e) => {
                e.stopPropagation();
                data.onDelete(id);
              }}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 rounded p-0.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-opacity"
            >
              <RiCloseLine className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="px-3 py-2.5">
        <p className="text-xs font-semibold text-foreground truncate">{data.flowNode.label}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground truncate">{data.subtitle}</p>
      </div>
      <Handle
        id="out"
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !border-2 !border-background !bg-emerald-500"
      />
    </div>
  );
});

const EndFlowNode = memo(function EndFlowNode({
  id,
  data,
  selected,
}: NodeProps<Node<FlowNodeCardData>>) {
  return (
    <div
      className={cn(
        "group min-w-[140px] rounded-full border bg-muted/60 px-3.5 py-2 shadow-xs transition-all",
        selected ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-primary/50",
        getTraceBadgeStyle(data.trace)
      )}
    >
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !border-2 !border-background !bg-slate-400"
      />
      <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-foreground">
        <RiStopCircleLine className="size-3.5 text-muted-foreground" />
        <span>{data.flowNode.label}</span>
        {data.canManage && (
          <button
            type="button"
            aria-label="Remove card"
            title="Remove card"
            onClick={(e) => {
              e.stopPropagation();
              data.onDelete(id);
            }}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 rounded-full p-0.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-opacity"
          >
            <RiCloseLine className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
});

const NODE_TYPES = {
  trigger: TriggerFlowNode,
  condition: ConditionFlowNode,
  logic: LogicFlowNode,
  delay: DelayFlowNode,
  action: ActionFlowNode,
  end: EndFlowNode,
};

function createInitialGraphForRule(
  initialRule: AutomationItem | null,
  sensors: SensorItem[],
  switches: SwitchItem[],
  devices: DeviceItem[],
  timezone: string
): FlowGraph {
  if (initialRule?.flow_graph && Array.isArray(initialRule.flow_graph.nodes) && initialRule.flow_graph.nodes.length > 0) {
    return {
      version: initialRule.flow_graph.version ?? 1,
      nodes: initialRule.flow_graph.nodes,
      edges: initialRule.flow_graph.edges ?? [],
      variables: initialRule.flow_graph.variables ?? [],
      viewport: initialRule.flow_graph.viewport,
    };
  }
  if (initialRule) {
    return flowGraphFromLegacyRule({
      name: initialRule.name,
      trigger_config: initialRule.trigger_config,
      conditions_config: initialRule.conditions_config,
      actions_config: initialRule.actions_config ?? [],
    });
  }

  const trigId = "trig-1";
  const actId = "act-1";
  const trigNode: FlowNode =
    sensors.length > 0
      ? {
          id: trigId,
          kind: "trigger",
          position: { x: 80, y: 170 },
          label: "Sensor Trigger",
          config: {
            triggerType: "sensor_value",
            sensorId: sensors[0]!.id,
            operator: "gt",
            threshold: 28,
          },
        }
      : switches.length > 0
        ? {
            id: trigId,
            kind: "trigger",
            position: { x: 80, y: 170 },
            label: "Switch Trigger",
            config: {
              triggerType: "device_state",
              switchId: switches[0]!.id,
              expectedState: true,
            },
          }
        : {
            id: trigId,
            kind: "trigger",
            position: { x: 80, y: 170 },
            label: "Schedule Trigger",
            config: {
              triggerType: "time",
              cronTime: "19:00",
              days: [],
              timezone,
            },
          };

  const actNode: FlowNode =
    switches.length > 0
      ? {
          id: actId,
          kind: "action",
          position: { x: 420, y: 170 },
          label: "Turn Switch ON",
          config: {
            actionType: "switch_on",
            switchId: switches[0]!.id,
          },
        }
      : {
          id: actId,
          kind: "action",
          position: { x: 420, y: 170 },
          label: devices.length > 0 ? "Set Device State" : "Send Alert",
          config:
            devices.length > 0
              ? {
                  actionType: "device_state",
                  deviceId: devices[0]!.id,
                  targetState: "active",
                }
              : {
                  actionType: "notification",
                  notificationTitle: "Automation Alert",
                  notificationMessage: "Your flow ran successfully.",
                  notificationSeverity: "info",
                },
        };

  return {
    version: 1,
    variables: [],
    nodes: [trigNode, actNode],
    edges: [
      {
        id: `e-${trigId}-${actId}`,
        source: trigId,
        sourceHandle: "out",
        target: actId,
        targetHandle: "in",
      },
    ],
  };
}

export function VisualAutomationBuilder({
  initialRule,
  sensors,
  switches,
  devices,
  rooms,
  controllers,
  existingFolders = ["General"],
  flowsMenuSlot,
  timezone,
  canManage,
  canOperate,
  onSaved,
  onCancelEdit,
}: VisualAutomationBuilderProps) {
  const [name, setName] = useState("");
  const [folderName, setFolderName] = useState("General");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [executionMode, setExecutionMode] = useState<"cloud" | "controller" | "hybrid">("cloud");

  const [graph, setGraph] = useState<FlowGraph>(() =>
    createInitialGraphForRule(initialRule, sensors, switches, devices, timezone)
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<FlowGraph[]>([]);
  const [redoStack, setRedoStack] = useState<FlowGraph[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [connectTargetId, setConnectTargetId] = useState("");
  const [connectHandle, setConnectHandle] = useState<"out" | "true" | "false">("out");

  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [testTrace, setTestTrace] = useState<FlowExecutionTrace | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const savingRef = useRef(false);
  const initializedKeyRef = useRef<string | null>(null);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const sensorById = useMemo(() => new Map(sensors.map((s) => [s.id, s])), [sensors]);
  const switchById = useMemo(() => new Map(switches.map((s) => [s.id, s])), [switches]);
  const deviceById = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);
  const roomById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);

  useEffect(() => {
    const ruleKey = initialRule?.id ?? "__new__";
    const hardwareLoaded =
      sensors.length > 0 || switches.length > 0 || devices.length > 0;
    const currentNodes = graphRef.current.nodes;
    const isInitialDefault =
      ruleKey === "__new__" &&
      currentNodes.length <= 2 &&
      hardwareLoaded &&
      initializedKeyRef.current === "__new__" &&
      !currentNodes.some((n) => {
        const cfg = n.config as FlowTriggerNodeConfig & FlowActionNodeConfig;
        return Boolean(cfg.sensorId || cfg.switchId || cfg.deviceId);
      });

    if (initializedKeyRef.current === ruleKey && !isInitialDefault) {
      return;
    }
    initializedKeyRef.current = ruleKey;
    setValidationErrors([]);
    setTestTrace(initialRule?.last_run_trace ?? null);
    setUndoStack([]);
    setRedoStack([]);

    if (initialRule) {
      setName(initialRule.name);
      setFolderName(initialRule.folder_name || "General");
      setDescription(initialRule.description ?? "");
      setEnabled(initialRule.enabled);
      setExecutionMode(initialRule.execution_mode);
      const nextGraph = createInitialGraphForRule(
        initialRule,
        sensors,
        switches,
        devices,
        timezone
      );
      setGraph(nextGraph);
      setSelectedNodeId(null);
    } else {
      setName("");
      setFolderName("General");
      setDescription("");
      setEnabled(true);
      setExecutionMode("cloud");
      const nextGraph = createInitialGraphForRule(
        null,
        sensors,
        switches,
        devices,
        timezone
      );
      setGraph(nextGraph);
      setSelectedNodeId(null);
    }
  }, [initialRule, sensors, switches, devices, timezone]);

  const commitGraph = useCallback((updater: (prev: FlowGraph) => FlowGraph) => {
    setGraph((prev) => {
      const next = updater(prev);
      if (next === prev) return prev;
      setUndoStack((u) => [...u.slice(-29), prev]);
      setRedoStack([]);
      return next;
    });
  }, []);

  const handleUndo = useCallback(() => {
    setUndoStack((u) => {
      if (u.length === 0) return u;
      const previous = u[u.length - 1]!;
      setRedoStack((r) => [...r, graphRef.current]);
      setGraph(previous);
      return u.slice(0, -1);
    });
  }, []);

  const handleRedo = useCallback(() => {
    setRedoStack((r) => {
      if (r.length === 0) return r;
      const next = r[r.length - 1]!;
      setUndoStack((u) => [...u, graphRef.current]);
      setGraph(next);
      return r.slice(0, -1);
    });
  }, []);

  const switchControllerById = useMemo(
    () => new Map(switches.map((s) => [s.id, s.controller_id])),
    [switches]
  );
  const deviceControllerById = useMemo(
    () => new Map(devices.map((d) => [d.id, d.controller_id])),
    [devices]
  );
  const sensorControllerById = useMemo(
    () => new Map(sensors.map((s) => [s.id, s.controller_id])),
    [sensors]
  );

  const localCapability = useMemo(
    () =>
      analyzeFlowGraphLocalCapability({
        graph,
        switchControllerById,
        deviceControllerById,
        sensorControllerById,
      }),
    [graph, switchControllerById, deviceControllerById, sensorControllerById]
  );

  const localCtrlName = localCapability.controllerId
    ? controllers.find((c) => c.id === localCapability.controllerId)?.name ?? "Controller"
    : null;

  const deleteNodeById = useCallback(
    (nodeId: string) => {
      commitGraph((prev) => ({
        ...prev,
        nodes: prev.nodes.filter((n) => n.id !== nodeId),
        edges: prev.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      }));
      setSelectedNodeId((cur) => (cur === nodeId ? null : cur));
    },
    [commitGraph]
  );

  const rfNodes = useMemo<Array<Node<FlowNodeCardData>>>(
    () =>
      graph.nodes.map((fn) => ({
        id: fn.id,
        type: fn.kind,
        position: fn.position,
        selected: fn.id === selectedNodeId,
        data: {
          flowNode: fn,
          subtitle: summarizeFlowNode(fn, sensorById, switchById, deviceById, roomById),
          trace: testTrace?.nodeResults?.[fn.id],
          canManage,
          onDelete: deleteNodeById,
        },
      })),
    [
      graph.nodes,
      selectedNodeId,
      sensorById,
      switchById,
      deviceById,
      roomById,
      testTrace,
      canManage,
      deleteNodeById,
    ]
  );

  const rfEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((fe) => {
        const edgeState = testTrace?.edgeStates?.[fe.id];
        const isTrue = fe.sourceHandle === "true";
        const isFalse = fe.sourceHandle === "false";
        const stroke =
          edgeState === "active"
            ? "#10b981"
            : edgeState === "inactive"
              ? "#94a3b8"
              : isTrue
                ? "#10b981"
                : isFalse
                  ? "#f43f5e"
                  : "#64748b";
        return {
          id: fe.id,
          type: "smoothstep",
          source: fe.source,
          sourceHandle: fe.sourceHandle ?? undefined,
          target: fe.target,
          targetHandle: fe.targetHandle ?? undefined,
          label: fe.label ?? (isTrue ? "True" : isFalse ? "False" : undefined),
          animated: edgeState === "active",
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
          style: {
            stroke,
            strokeWidth: edgeState === "active" ? 2.5 : 1.75,
            strokeDasharray: edgeState === "inactive" ? "5 4" : undefined,
          },
        };
      }),
    [graph.edges, testTrace]
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<FlowNodeCardData>>[]) => {
      const updated = applyNodeChanges(changes, rfNodes);
      const hasDragOrSelect = changes.some(
        (c) => c.type === "position" || c.type === "remove" || c.type === "select"
      );
      if (!hasDragOrSelect) return;

      for (const ch of changes) {
        if (ch.type === "select" && ch.selected) {
          setSelectedNodeId(ch.id);
        }
      }

      const nextPosMap = new Map(updated.map((u) => [u.id, u.position]));
      const removedIds = new Set(
        changes.filter((c) => c.type === "remove").map((c) => c.id)
      );

      if (removedIds.size > 0) {
        commitGraph((prev) => ({
          ...prev,
          nodes: prev.nodes.filter((n) => !removedIds.has(n.id)),
          edges: prev.edges.filter(
            (e) => !removedIds.has(e.source) && !removedIds.has(e.target)
          ),
        }));
      } else if (changes.some((c) => c.type === "position")) {
        setGraph((prev) => ({
          ...prev,
          nodes: prev.nodes.map((n) => ({
            ...n,
            position: nextPosMap.get(n.id) ?? n.position,
          })),
        }));
      }
    },
    [rfNodes, commitGraph]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed = changes.filter((c) => c.type === "remove");
      if (removed.length > 0) {
        const nextEdges = applyEdgeChanges(changes, rfEdges);
        const keep = new Set(nextEdges.map((e) => e.id));
        commitGraph((prev) => ({
          ...prev,
          edges: prev.edges.filter((e) => keep.has(e.id)),
        }));
      }
    },
    [rfEdges, commitGraph]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) {
        return;
      }
      commitGraph((prev) => {
        const nextRf = addEdge(
          {
            ...connection,
            id: `e-${connection.source}-${connection.sourceHandle ?? "out"}-${connection.target}`,
          },
          prev.edges.map((e) => ({
            ...e,
            sourceHandle: e.sourceHandle ?? undefined,
            targetHandle: e.targetHandle ?? undefined,
          }))
        );
        const mapped: FlowEdge[] = nextRf.map((e) => ({
          id: e.id,
          source: e.source,
          sourceHandle: e.sourceHandle ?? "out",
          target: e.target,
          targetHandle: e.targetHandle ?? "in",
          label: typeof e.label === "string" ? e.label : undefined,
        }));
        return { ...prev, edges: mapped };
      });
    },
    [commitGraph]
  );

  function appendNode(
    kind: FlowNodeKind,
    label: string,
    config: FlowNode["config"],
    autoConnectFromSelected = true,
    preferredSourceHandle?: "out" | "true" | "false"
  ) {
    const id = makeUid(kind.slice(0, 4));
    const anchor =
      graph.nodes.find((n) => n.id === selectedNodeId) ??
      graph.nodes[graph.nodes.length - 1];
    const x = anchor ? anchor.position.x + (kind === "trigger" ? 0 : 290) : 100;
    const yOffset =
      preferredSourceHandle === "false"
        ? 110
        : preferredSourceHandle === "true"
          ? -30
          : 20 * (graph.nodes.length % 3);
    const y = anchor
      ? anchor.position.y + (kind === "trigger" ? 150 : yOffset)
      : 160;

    const newNode: FlowNode = {
      id,
      kind,
      position: { x: Math.round(x), y: Math.round(y) },
      label,
      config,
    };

    commitGraph((prev) => {
      const nextEdges = [...prev.edges];
      if (autoConnectFromSelected && kind !== "trigger" && anchor) {
        const sourceHandle =
          preferredSourceHandle ?? (anchor.kind === "condition" ? "true" : "out");
        if (anchor.kind !== "end") {
          nextEdges.push({
            id: `e-${anchor.id}-${sourceHandle}-${id}`,
            source: anchor.id,
            sourceHandle,
            target: id,
            targetHandle: "in",
          });
        }
      }
      return {
        ...prev,
        nodes: [...prev.nodes, newNode],
        edges: nextEdges,
      };
    });
    setSelectedNodeId(id);
  }

  function addPresetNode(preset: string) {
    switch (preset) {
      case "trigger_sensor":
        appendNode(
          "trigger",
          "Sensor Trigger",
          {
            triggerType: "sensor_value",
            sensorId: sensors[0]?.id ?? "",
            operator: "gt",
            threshold: 28,
          },
          false
        );
        break;
      case "trigger_sun":
        appendNode(
          "trigger",
          "Sunset / Sunrise",
          {
            triggerType: "sun_event",
            sunEvent: "sunset",
            offsetMinutes: 0,
            timezone,
          },
          false
        );
        break;
      case "trigger_time":
        appendNode(
          "trigger",
          "Time Schedule",
          {
            triggerType: "time",
            cronTime: "19:00",
            days: [],
            timezone,
          },
          false
        );
        break;
      case "trigger_device":
        appendNode(
          "trigger",
          "Switch / Device Trigger",
          switches[0]
            ? {
                triggerType: "device_state",
                switchId: switches[0].id,
                expectedState: true,
              }
            : {
                triggerType: "device_state",
                deviceId: devices[0]?.id ?? "",
                expectedState: "active",
              },
          false
        );
        break;
      case "trigger_manual":
        appendNode("trigger", "Manual Trigger", { triggerType: "manual" }, false);
        break;
      case "condition":
        appendNode("condition", "Check Condition", {
          conditionType: rooms[0]
            ? "room_state"
            : switches[0]
              ? "switch_state"
              : "time_range",
          roomId: rooms[0]?.id,
          roomMatch: "any_on",
          switchId: switches[0]?.id,
          expectedState: true,
          startTime: "18:00",
          endTime: "23:00",
          timezone,
        });
        break;
      case "logic_all":
        appendNode("logic", "ALL Gate", { gate: "ALL" });
        break;
      case "logic_any":
        appendNode("logic", "ANY Gate", { gate: "ANY" });
        break;
      case "delay":
        appendNode("delay", "Delay Timer", {
          durationValue: 30,
          durationUnit: "seconds",
          cancelPreviousOnRetrigger: false,
        });
        break;
      case "action_switch":
        appendNode("action", "Turn Switch ON", {
          actionType: "switch_on",
          switchId: switches[0]?.id ?? "",
        });
        break;
      case "action_scene":
        appendNode("action", "Run Scene", {
          actionType: "scene",
          sceneName: "Evening Comfort",
          targets: switches[0]
            ? [{ kind: "switch", switchId: switches[0].id, isOn: true }]
            : devices[0]
              ? [{ kind: "device", deviceId: devices[0].id, targetState: "active" }]
              : [],
        });
        break;
      case "action_notify":
        appendNode("action", "Send Notification", {
          actionType: "notification",
          notificationTitle: "HomecoreOS Flow Alert",
          notificationMessage: "Trigger conditions were met.",
          notificationSeverity: "info",
        });
        break;
      case "action_http":
        appendNode("action", "HTTP Webhook", {
          actionType: "http_request",
          httpMethod: "POST",
          httpUrl: "https://example.com/webhook",
          httpBody: '{"event":"homecoreos_flow"}',
        });
        break;
      case "action_var":
        appendNode("action", "Set Variable", {
          actionType: "set_variable",
          variableName: graph.variables[0]?.name ?? "flowState",
          variableValue: "active",
        });
        break;
      case "end":
        appendNode("end", "End Flow", { outcome: "completed" });
        break;
    }
  }

  function applyStarterTemplate(templateId: "temp_fan" | "sunset_delay" | "webhook_alert") {
    const swId = switches[0]?.id ?? "";
    const senId = sensors[0]?.id ?? "";
    if (templateId === "temp_fan") {
      setName((prev) => prev || "High Temp Cooling Flow");
      setFolderName("Climate & Safety");
      commitGraph(() =>
        autoLayoutFlowGraph({
          version: 1,
          variables: [],
          nodes: [
            {
              id: "t1",
              kind: "trigger",
              position: { x: 80, y: 160 },
              label: "High Temp Trigger",
              config: {
                triggerType: "sensor_value",
                sensorId: senId,
                operator: "gt",
                threshold: 29,
              },
            },
            {
              id: "c1",
              kind: "condition",
              position: { x: 380, y: 160 },
              label: "Daytime Window",
              config: {
                conditionType: "time_range",
                startTime: "07:00",
                endTime: "23:00",
                timezone,
              },
            },
            {
              id: "a1",
              kind: "action",
              position: { x: 700, y: 100 },
              label: "Turn Cooling ON",
              config: { actionType: "switch_on", switchId: swId },
            },
            {
              id: "a2",
              kind: "action",
              position: { x: 700, y: 240 },
              label: "Night Alert",
              config: {
                actionType: "notification",
                notificationTitle: "High Temperature Overnight",
                notificationMessage: "Temperature exceeded 29°C during quiet hours.",
                notificationSeverity: "warning",
              },
            },
          ],
          edges: [
            { id: "e1", source: "t1", sourceHandle: "out", target: "c1", targetHandle: "in" },
            { id: "e2", source: "c1", sourceHandle: "true", target: "a1", targetHandle: "in" },
            { id: "e3", source: "c1", sourceHandle: "false", target: "a2", targetHandle: "in" },
          ],
        })
      );
      setSelectedNodeId("t1");
    } else if (templateId === "sunset_delay") {
      setName((prev) => prev || "Sunset Porch Auto-Off");
      setFolderName("First Floor");
      commitGraph(() =>
        autoLayoutFlowGraph({
          version: 1,
          variables: [],
          nodes: [
            {
              id: "t1",
              kind: "trigger",
              position: { x: 80, y: 160 },
              label: "At Sunset",
              config: {
                triggerType: "sun_event",
                sunEvent: "sunset",
                offsetMinutes: 0,
                timezone,
              },
            },
            {
              id: "a1",
              kind: "action",
              position: { x: 380, y: 160 },
              label: "Porch Light ON",
              config: { actionType: "switch_on", switchId: swId },
            },
            {
              id: "d1",
              kind: "delay",
              position: { x: 680, y: 160 },
              label: "Wait 4 Hours",
              config: { durationValue: 4, durationUnit: "hours" },
            },
            {
              id: "a2",
              kind: "action",
              position: { x: 960, y: 160 },
              label: "Porch Light OFF",
              config: { actionType: "switch_off", switchId: swId },
            },
          ],
          edges: [
            { id: "e1", source: "t1", sourceHandle: "out", target: "a1", targetHandle: "in" },
            { id: "e2", source: "a1", sourceHandle: "out", target: "d1", targetHandle: "in" },
            { id: "e3", source: "d1", sourceHandle: "out", target: "a2", targetHandle: "in" },
          ],
        })
      );
      setSelectedNodeId("t1");
    } else {
      setName((prev) => prev || "Alert & Webhook Dispatch");
      setFolderName("Safety & Security");
      commitGraph(() =>
        autoLayoutFlowGraph({
          version: 1,
          variables: [
            { id: "v1", name: "alertTag", type: "string", initialValue: "priority-1" },
          ],
          nodes: [
            {
              id: "t1",
              kind: "trigger",
              position: { x: 80, y: 160 },
              label: "Manual Check",
              config: { triggerType: "manual" },
            },
            {
              id: "a1",
              kind: "action",
              position: { x: 380, y: 100 },
              label: "Notify Homeowner",
              config: {
                actionType: "notification",
                notificationTitle: "Security Flow Triggered",
                notificationMessage: "Alert dispatched via HomecoreOS flow.",
                notificationSeverity: "info",
              },
            },
            {
              id: "a2",
              kind: "action",
              position: { x: 380, y: 240 },
              label: "Dispatch Webhook",
              config: {
                actionType: "http_request",
                httpMethod: "POST",
                httpUrl: "https://example.com/hook",
                httpBody: '{"status":"ok"}',
              },
            },
          ],
          edges: [
            { id: "e1", source: "t1", sourceHandle: "out", target: "a1", targetHandle: "in" },
            { id: "e2", source: "t1", sourceHandle: "out", target: "a2", targetHandle: "in" },
          ],
        })
      );
      setSelectedNodeId("t1");
    }
  }

  const selectedNode = graph.nodes.find((n) => n.id === selectedNodeId) ?? null;

  function updateSelectedNode(patch: Partial<FlowNode>) {
    if (!selectedNode) return;
    commitGraph((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === selectedNode.id ? { ...n, ...patch } : n)),
    }));
  }

  function updateSelectedConfig<T extends FlowNode["config"]>(patch: Partial<T>) {
    if (!selectedNode) return;
    commitGraph((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) =>
        n.id === selectedNode.id ? { ...n, config: { ...n.config, ...patch } } : n
      ),
    }));
  }

  function connectSelectedToTarget() {
    if (!selectedNode || !connectTargetId || selectedNode.id === connectTargetId) return;
    const sh = selectedNode.kind === "condition" ? connectHandle : "out";
    commitGraph((prev) => {
      const exists = prev.edges.some(
        (e) =>
          e.source === selectedNode.id &&
          (e.sourceHandle ?? "out") === sh &&
          e.target === connectTargetId
      );
      if (exists) return prev;
      return {
        ...prev,
        edges: [
          ...prev.edges,
          {
            id: `e-${selectedNode.id}-${sh}-${connectTargetId}-${Date.now().toString(36)}`,
            source: selectedNode.id,
            sourceHandle: sh,
            target: connectTargetId,
            targetHandle: "in",
          },
        ],
      };
    });
    setConnectTargetId("");
  }

  async function handleDryRunTest() {
    setValidationErrors([]);
    const check = validateFlowGraph({
      name: name.trim() || "Draft Flow",
      graph,
      fallbackTimezone: timezone,
    });
    if (!check.valid) {
      setValidationErrors(check.errors);
      toast.error("Fix validation errors before running a dry-run simulation.");
      return;
    }

    setTesting(true);
    try {
      const res = await apiFetch<{
        ok: boolean;
        flowTrace?: FlowExecutionTrace;
      }>("/api/automations/test", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim() || "Draft Flow",
          executionMode,
          flowGraph: graph,
          dryRun: true,
        }),
      });
      if (res.flowTrace) {
        setTestTrace(res.flowTrace);
      }
      toast.success("Dry-run simulation completed. Highlighted active paths on canvas.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Dry-run test failed.");
    } finally {
      setTesting(false);
    }
  }

  async function handleSaveFlow() {
    if (savingRef.current) return;
    setValidationErrors([]);

    const check = validateFlowGraph({
      name,
      graph,
      fallbackTimezone: timezone,
    });
    if (!check.valid) {
      setValidationErrors(check.errors);
      toast.error("Fix flow validation issues before saving.");
      return;
    }

    const compiled = compileFlowGraphToRuleConfigs(graph);
    const payload = {
      name: name.trim(),
      folderName: folderName.trim() || "General",
      description: description.trim(),
      enabled,
      executionMode,
      triggerConfig: compiled.triggerConfig,
      conditionsConfig: compiled.conditionsConfig,
      actionsConfig:
        compiled.actionsConfig.length > 0
          ? compiled.actionsConfig
          : undefined,
      flowGraph: graph,
    };

    savingRef.current = true;
    setSaving(true);
    try {
      let savedRule: AutomationItem | undefined;
      if (initialRule) {
        const res = await apiFetch<{ automation?: AutomationItem }>(
          `/api/automations/${initialRule.id}`,
          {
            method: "PATCH",
            body: JSON.stringify(payload),
          }
        );
        savedRule = res.automation;
      } else {
        const res = await apiFetch<{ automation?: AutomationItem }>(
          "/api/automations",
          {
            method: "POST",
            body: JSON.stringify(payload),
          }
        );
        savedRule = res.automation;
      }
      await onSaved(
        initialRule
          ? `Updated visual flow "${name.trim()}".`
          : `Saved visual flow "${name.trim()}".`,
        savedRule
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save flow.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!canManage) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const targetTag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const inTextField = targetTag === "input" || targetTag === "textarea";
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSaveFlow();
        return;
      }
      if (!inTextField && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if (!inTextField && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const outgoingFromSelected = selectedNode
    ? graph.edges.filter((e) => e.source === selectedNode.id)
    : [];

  return (
    <div className="space-y-3">
      {/* Slim Homey-style Single-Row Flow Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2 shadow-xs">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {flowsMenuSlot}

          <div className="flex items-center gap-1.5">
            <Label htmlFor="flow-name" className="sr-only">
              Automation Name
            </Label>
            <Input
              id="flow-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Flow name..."
              disabled={!canManage}
              className="h-8 w-44 sm:w-52 text-xs font-medium"
            />
          </div>

          <div className="relative flex items-center">
            <Label htmlFor="flow-folder" className="sr-only">
              Folder
            </Label>
            <RiFolderLine className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
            <Input
              id="flow-folder"
              list="flow-folder-suggestions"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder="Folder"
              disabled={!canManage}
              className="h-8 w-28 sm:w-32 pl-7 text-xs"
            />
            <datalist id="flow-folder-suggestions">
              {existingFolders.map((f) => (
                <option key={f} value={f} />
              ))}
              <option value="First Floor" />
              <option value="Ground Floor" />
              <option value="Safety & Security" />
              <option value="Climate" />
            </datalist>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {canManage && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="xs" className="h-8">
                    <RiAddLine className="size-3.5" />
                    Add
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuLabel>When (Trigger)</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => addPresetNode("trigger_sensor")}>
                    <RiSensorLine className="size-3.5 text-sky-500" />
                    Sensor Threshold
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addPresetNode("trigger_device")}>
                    <RiToggleLine className="size-3.5 text-sky-500" />
                    Switch / Device Change
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addPresetNode("trigger_time")}>
                    <RiTimeLine className="size-3.5 text-sky-500" />
                    Time Schedule
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addPresetNode("trigger_sun")}>
                    <RiSunLine className="size-3.5 text-sky-500" />
                    Sunrise / Sunset
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addPresetNode("trigger_manual")}>
                    <RiPlayLine className="size-3.5 text-sky-500" />
                    Manual Trigger
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Check &amp; Wait</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => addPresetNode("condition")}>
                    <RiGitBranchLine className="size-3.5 text-amber-500" />
                    If Condition (True / False)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addPresetNode("delay")}>
                    <RiTimerLine className="size-3.5 text-cyan-500" />
                    Delay Timer
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addPresetNode("logic_all")}>
                    <RiGitBranchLine className="size-3.5 text-violet-500" />
                    ALL Join Gate
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addPresetNode("logic_any")}>
                    <RiGitBranchLine className="size-3.5 text-violet-500" />
                    ANY Join Gate
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Then (Action)</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => addPresetNode("action_switch")}>
                    <RiFlashlightLine className="size-3.5 text-emerald-500" />
                    Control Switch / Device
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addPresetNode("action_scene")}>
                    <RiSparklingLine className="size-3.5 text-emerald-500" />
                    Run Scene
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addPresetNode("action_notify")}>
                    <RiNotification3Line className="size-3.5 text-emerald-500" />
                    Send Notification
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Advanced</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => addPresetNode("action_http")}>
                    <RiGlobalLine className="size-3.5 text-emerald-500" />
                    HTTP Webhook
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addPresetNode("action_var")}>
                    <RiSparklingLine className="size-3.5 text-emerald-500" />
                    Set Variable
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addPresetNode("end")}>
                    <RiStopCircleLine className="size-3.5 text-muted-foreground" />
                    End Marker
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-8"
                onClick={() => addPresetNode("condition")}
              >
                + If
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-8"
                onClick={() => addPresetNode("delay")}
              >
                + Delay
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-8"
                onClick={() => addPresetNode("action_switch")}
              >
                + Action
              </Button>

              <div className="flex items-center rounded-md border border-border bg-muted/20">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="h-7.5 w-7"
                  disabled={undoStack.length === 0}
                  onClick={handleUndo}
                  title="Undo"
                >
                  <RiArrowGoBackLine className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="h-7.5 w-7"
                  disabled={redoStack.length === 0}
                  onClick={handleRedo}
                  title="Redo"
                >
                  <RiArrowGoForwardLine className="size-3.5" />
                </Button>
              </div>

              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-8"
                onClick={() => commitGraph((g) => autoLayoutFlowGraph(g))}
              >
                <RiLayoutGridLine className="size-3.5" />
                Auto-Arrange
              </Button>

              {!initialRule && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="xs" className="h-8">
                      <RiSparklingLine className="size-3.5 text-primary" />
                      Templates
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => applyStarterTemplate("temp_fan")}>
                      Temperature Alert + Branching
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => applyStarterTemplate("sunset_delay")}>
                      Sunset Porch Light + 4h Delay
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => applyStarterTemplate("webhook_alert")}>
                      Notification + HTTP Webhook
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          )}

          {/* Secondary Flow Options (Execution Mode, Enabled, Notes, Variables) tucked cleanly */}
          <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-8"
                title="Flow Settings & Variables"
              >
                <RiSettings3Line className="size-3.5" />
                Settings
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 space-y-3 p-3.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">Flow Settings</span>
                <div className="flex items-center gap-2">
                  <Label htmlFor="flow-enabled" className="text-xs cursor-pointer">
                    Enabled
                  </Label>
                  <Switch
                    id="flow-enabled"
                    checked={enabled}
                    onCheckedChange={setEnabled}
                    disabled={!canManage}
                  />
                </div>
              </div>

              <FormField id="flow-mode" label="Execution Target">
                <Select
                  value={executionMode}
                  onValueChange={(v) =>
                    setExecutionMode(v as "cloud" | "controller" | "hybrid")
                  }
                  disabled={!canManage}
                >
                  <SelectTrigger id="flow-mode" className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cloud">Cloud Flow Engine</SelectItem>
                    <SelectItem value="hybrid">Hybrid (Cloud + Hub)</SelectItem>
                    <SelectItem value="controller">Local Controller</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>

              <FormField id="flow-desc" label="Notes">
                <Input
                  id="flow-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional flow notes..."
                  disabled={!canManage}
                  className="h-8 text-xs"
                />
              </FormField>

              <div className="border-t border-border pt-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold">
                    Variables ({graph.variables.length})
                  </span>
                  {canManage && (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        commitGraph((g) => ({
                          ...g,
                          variables: [
                            ...g.variables,
                            {
                              id: makeUid("var"),
                              name: `var${g.variables.length + 1}`,
                              type: "string",
                              initialValue: "",
                            },
                          ],
                        }))
                      }
                    >
                      + Variable
                    </Button>
                  )}
                </div>
                {graph.variables.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    Optional variables for passing values between steps.
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-40 overflow-y-auto">
                    {graph.variables.map((v, idx) => (
                      <div key={v.id} className="grid grid-cols-12 gap-1 items-center">
                        <Input
                          className="col-span-5 h-7 text-xs font-mono"
                          value={v.name}
                          onChange={(e) => {
                            const next = [...graph.variables];
                            next[idx] = { ...v, name: e.target.value };
                            commitGraph((g) => ({ ...g, variables: next }));
                          }}
                        />
                        <Select
                          value={v.type}
                          onValueChange={(t) => {
                            const next = [...graph.variables];
                            const vt = t as FlowVariable["type"];
                            next[idx] = {
                              ...v,
                              type: vt,
                              initialValue: vt === "number" ? 0 : vt === "boolean" ? false : "",
                            };
                            commitGraph((g) => ({ ...g, variables: next }));
                          }}
                        >
                          <SelectTrigger className="col-span-3 h-7 text-[11px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="string">str</SelectItem>
                            <SelectItem value="number">num</SelectItem>
                            <SelectItem value="boolean">bool</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          className="col-span-3 h-7 text-xs"
                          value={String(v.initialValue)}
                          onChange={(e) => {
                            const next = [...graph.variables];
                            const raw = e.target.value;
                            next[idx] = {
                              ...v,
                              initialValue:
                                v.type === "number"
                                  ? Number(raw) || 0
                                  : v.type === "boolean"
                                    ? raw === "true"
                                    : raw,
                            };
                            commitGraph((g) => ({ ...g, variables: next }));
                          }}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="col-span-1 text-destructive"
                          onClick={() =>
                            commitGraph((g) => ({
                              ...g,
                              variables: g.variables.filter((x) => x.id !== v.id),
                            }))
                          }
                        >
                          <RiDeleteBinLine className="size-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </PopoverContent>
          </Popover>

          <Badge
            variant={localCapability.supported ? "success-light" : "outline"}
            size="xs"
            className="hidden sm:inline-flex"
            title={
              localCapability.supported
                ? `Eligible for local offline execution on ${localCtrlName}`
                : localCapability.reasons.join(" ")
            }
          >
            {localCapability.supported ? (
              <>
                <RiWifiOffLine className="size-3" />
                Local Ready ({localCtrlName})
              </>
            ) : (
              <>
                <RiGlobalLine className="size-3" />
                Cloud Engine
              </>
            )}
          </Badge>

          {canOperate && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="h-8"
              disabled={testing}
              onClick={() => void handleDryRunTest()}
            >
              <RiFlaskLine className="size-3.5" />
              {testing ? "Testing..." : "Test (Dry Run)"}
            </Button>
          )}

          {canManage && (
            <>
              {initialRule && (
                <Button type="button" variant="ghost" size="xs" className="h-8" onClick={onCancelEdit}>
                  Cancel
                </Button>
              )}
              <Button
                type="button"
                size="xs"
                className="h-8 px-3"
                disabled={saving}
                onClick={() => void handleSaveFlow()}
              >
                <RiSaveLine className="size-3.5" />
                {saving ? "Saving..." : initialRule ? "Update Flow" : "Save Flow"}
              </Button>
            </>
          )}
        </div>
      </div>

      {validationErrors.length > 0 && (
        <StatusAlert tone="danger">
          <p className="font-semibold">Fix these flow issues before saving or testing:</p>
          <ul className="mt-1 list-disc pl-5 text-xs space-y-0.5">
            {validationErrors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </StatusAlert>
      )}

      {/* Full-Width Airy Canvas + Contextual Slide-Out Node Inspector */}
      <div
        className={cn(
          "grid grid-cols-1 gap-4",
          selectedNode ? "lg:grid-cols-[minmax(0,1fr)_320px]" : ""
        )}
      >
        <Card className="relative overflow-hidden p-0">
          <div
            className="h-[560px] w-full bg-muted/15"
            data-testid="visual-flow-canvas"
          >
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={NODE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onEdgeDoubleClick={(_ev, edge) => {
                if (!canManage) return;
                commitGraph((prev) => ({
                  ...prev,
                  edges: prev.edges.filter((e) => e.id !== edge.id),
                }));
              }}
              onNodeClick={(_ev, node) => setSelectedNodeId(node.id)}
              onPaneClick={() => setSelectedNodeId(null)}
              connectionLineType={ConnectionLineType.SmoothStep}
              defaultEdgeOptions={{ type: "smoothstep" }}
              snapToGrid
              snapGrid={[16, 16]}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              deleteKeyCode={canManage ? ["Backspace", "Delete"] : null}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          {!selectedNode && (
            <div className="pointer-events-none absolute bottom-3 left-14 rounded-full border border-border bg-card/90 px-3 py-1 text-[11px] text-muted-foreground shadow-xs backdrop-blur-xs">
              Click a card to configure · Drag dots to wire · Double-click wire to unlink
            </div>
          )}
        </Card>

        {/* Contextual Node Inspector (only shown when a card is selected) */}
        {selectedNode && (
          <Card className="h-fit">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm capitalize">
                  {selectedNode.kind} Settings
                </CardTitle>
                <div className="flex items-center gap-1">
                  {canManage && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        title="Duplicate node"
                        onClick={() =>
                          appendNode(
                            selectedNode.kind,
                            `${selectedNode.label} Copy`,
                            { ...selectedNode.config },
                            false
                          )
                        }
                      >
                        <RiFileCopyLine className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="text-destructive"
                        title="Delete node"
                        onClick={() => deleteNodeById(selectedNode.id)}
                      >
                        <RiDeleteBinLine className="size-3.5" />
                      </Button>
                    </>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    title="Close inspector"
                    onClick={() => setSelectedNodeId(null)}
                  >
                    <RiCloseLine className="size-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <div className="space-y-3">
                <FormField id="node-label" label="Card Title">
                  <Input
                    id="node-label"
                    value={selectedNode.label}
                    onChange={(e) => updateSelectedNode({ label: e.target.value })}
                    disabled={!canManage}
                  />
                </FormField>

                {/* TRIGGER CONFIG */}
                {selectedNode.kind === "trigger" && (() => {
                  const cfg = selectedNode.config as FlowTriggerNodeConfig;
                  return (
                    <div className="space-y-2.5">
                      <FormField id="trig-type" label="Trigger Kind">
                        <Select
                          value={cfg.triggerType}
                          onValueChange={(v) => {
                            const nextType = v as FlowTriggerNodeConfig["triggerType"];
                            if (nextType === "sensor_value") {
                              updateSelectedConfig<FlowTriggerNodeConfig>({
                                triggerType: nextType,
                                sensorId: cfg.sensorId || sensors[0]?.id || "",
                                operator: cfg.operator ?? "gt",
                                threshold: cfg.threshold ?? 28,
                              });
                            } else if (nextType === "device_state") {
                              updateSelectedConfig<FlowTriggerNodeConfig>({
                                triggerType: nextType,
                                switchId: cfg.switchId || switches[0]?.id,
                                expectedState: true,
                              });
                            } else if (nextType === "time") {
                              updateSelectedConfig<FlowTriggerNodeConfig>({
                                triggerType: nextType,
                                cronTime: cfg.cronTime ?? "19:00",
                                days: cfg.days ?? [],
                                timezone,
                              });
                            } else if (nextType === "sun_event") {
                              updateSelectedConfig<FlowTriggerNodeConfig>({
                                triggerType: nextType,
                                sunEvent: cfg.sunEvent ?? "sunset",
                                offsetMinutes: cfg.offsetMinutes ?? 0,
                                timezone,
                              });
                            } else {
                              updateSelectedConfig<FlowTriggerNodeConfig>({
                                triggerType: "manual",
                              });
                            }
                          }}
                          disabled={!canManage}
                        >
                          <SelectTrigger id="trig-type" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="sensor_value">Sensor Threshold</SelectItem>
                            <SelectItem value="device_state">Switch / Device State</SelectItem>
                            <SelectItem value="time">Scheduled Time</SelectItem>
                            <SelectItem value="sun_event">Sunrise / Sunset</SelectItem>
                            <SelectItem value="manual">Manual Trigger</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormField>

                      {cfg.triggerType === "sensor_value" && (() => {
                        const liveSensor = cfg.sensorId ? sensorById.get(cfg.sensorId) : undefined;
                        return (
                          <>
                            <FormField id="trig-sen" label="Sensor">
                              <Select
                                value={cfg.sensorId ?? ""}
                                onValueChange={(v) =>
                                  updateSelectedConfig<FlowTriggerNodeConfig>({ sensorId: v })
                                }
                              >
                                <SelectTrigger id="trig-sen" className="w-full">
                                  <SelectValue placeholder="Choose sensor..." />
                                </SelectTrigger>
                                <SelectContent>
                                  {sensors.map((s) => (
                                    <SelectItem key={s.id} value={s.id}>
                                      {s.name} ({s.unit})
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </FormField>
                            {liveSensor && (
                              <div className="flex items-center justify-between rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px]">
                                <span className="text-muted-foreground">Live reading</span>
                                <span className="font-mono font-semibold text-foreground">
                                  {liveSensor.last_value !== null
                                    ? `${liveSensor.last_value} ${liveSensor.unit}`
                                    : "Awaiting data"}
                                </span>
                              </div>
                            )}
                            <div className="grid grid-cols-2 gap-2">
                              <FormField id="trig-op" label="Operator">
                                <Select
                                  value={cfg.operator ?? "gt"}
                                  onValueChange={(v) =>
                                    updateSelectedConfig<FlowTriggerNodeConfig>({
                                      operator: v as AutomationOperator,
                                    })
                                  }
                                >
                                  <SelectTrigger id="trig-op" className="w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {OPERATOR_OPTIONS.map((op) => (
                                      <SelectItem key={op.value} value={op.value}>
                                        {op.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </FormField>
                              <FormField id="trig-thresh" label="Threshold">
                                <Input
                                  id="trig-thresh"
                                  type="number"
                                  step="any"
                                  value={cfg.threshold ?? 0}
                                  onChange={(e) =>
                                    updateSelectedConfig<FlowTriggerNodeConfig>({
                                      threshold: Number(e.target.value),
                                    })
                                  }
                                />
                              </FormField>
                            </div>
                          </>
                        );
                      })()}

                      {cfg.triggerType === "device_state" && (
                        <>
                          <FormField id="trig-sw" label="Switch (or leave blank for Device)">
                            <Select
                              value={cfg.switchId ?? "__device__"}
                              onValueChange={(v) => {
                                if (v === "__device__") {
                                  updateSelectedConfig<FlowTriggerNodeConfig>({
                                    switchId: undefined,
                                    deviceId: devices[0]?.id ?? "",
                                    expectedState: "active",
                                  });
                                } else {
                                  updateSelectedConfig<FlowTriggerNodeConfig>({
                                    switchId: v,
                                    deviceId: undefined,
                                    expectedState: true,
                                  });
                                }
                              }}
                            >
                              <SelectTrigger id="trig-sw" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {switches.map((sw) => (
                                  <SelectItem key={sw.id} value={sw.id}>
                                    Switch: {sw.name}
                                  </SelectItem>
                                ))}
                                {devices.length > 0 && (
                                  <SelectItem value="__device__">Choose Device instead...</SelectItem>
                                )}
                              </SelectContent>
                            </Select>
                          </FormField>

                          {cfg.switchId ? (
                            <FormField id="trig-sw-state" label="Expected State">
                              <Select
                                value={cfg.expectedState ? "true" : "false"}
                                onValueChange={(v) =>
                                  updateSelectedConfig<FlowTriggerNodeConfig>({
                                    expectedState: v === "true",
                                  })
                                }
                              >
                                <SelectTrigger id="trig-sw-state" className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="true">Turned ON</SelectItem>
                                  <SelectItem value="false">Turned OFF</SelectItem>
                                </SelectContent>
                              </Select>
                            </FormField>
                          ) : (
                            <div className="grid grid-cols-2 gap-2">
                              <FormField id="trig-dev" label="Device">
                                <Select
                                  value={cfg.deviceId ?? ""}
                                  onValueChange={(v) =>
                                    updateSelectedConfig<FlowTriggerNodeConfig>({ deviceId: v })
                                  }
                                >
                                  <SelectTrigger id="trig-dev" className="w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {devices.map((d) => (
                                      <SelectItem key={d.id} value={d.id}>
                                        {d.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </FormField>
                              <FormField id="trig-dev-state" label="State">
                                <Input
                                  id="trig-dev-state"
                                  value={String(cfg.expectedState ?? "active")}
                                  onChange={(e) =>
                                    updateSelectedConfig<FlowTriggerNodeConfig>({
                                      expectedState: e.target.value,
                                    })
                                  }
                                />
                              </FormField>
                            </div>
                          )}
                        </>
                      )}

                      {cfg.triggerType === "time" && (
                        <>
                          <FormField id="trig-cron" label="Time (24h HH:MM)">
                            <Input
                              id="trig-cron"
                              type="time"
                              value={cfg.cronTime ?? "19:00"}
                              onChange={(e) =>
                                updateSelectedConfig<FlowTriggerNodeConfig>({
                                  cronTime: e.target.value,
                                })
                              }
                            />
                          </FormField>
                          <div className="flex flex-wrap gap-1">
                            {WEEKDAYS.map((wd) => {
                              const active = (cfg.days ?? []).includes(wd.id);
                              return (
                                <Button
                                  key={wd.id}
                                  type="button"
                                  size="xs"
                                  variant={active ? "default" : "outline"}
                                  onClick={() => {
                                    const cur = cfg.days ?? [];
                                    updateSelectedConfig<FlowTriggerNodeConfig>({
                                      days: active
                                        ? cur.filter((d) => d !== wd.id)
                                        : [...cur, wd.id],
                                    });
                                  }}
                                >
                                  {wd.label}
                                </Button>
                              );
                            })}
                          </div>
                        </>
                      )}

                      {cfg.triggerType === "sun_event" && (
                        <div className="space-y-2">
                          <div className="grid grid-cols-2 gap-2">
                            <FormField id="trig-sun" label="Solar Event">
                              <Select
                                value={cfg.sunEvent ?? "sunset"}
                                onValueChange={(v) =>
                                  updateSelectedConfig<FlowTriggerNodeConfig>({
                                    sunEvent: v as "sunrise" | "sunset",
                                  })
                                }
                              >
                                <SelectTrigger id="trig-sun" className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="sunrise">Sunrise</SelectItem>
                                  <SelectItem value="sunset">Sunset</SelectItem>
                                </SelectContent>
                              </Select>
                            </FormField>
                            <FormField id="trig-off" label="Offset (min)">
                              <Input
                                id="trig-off"
                                type="number"
                                min={-180}
                                max={180}
                                value={cfg.offsetMinutes ?? 0}
                                onChange={(e) =>
                                  updateSelectedConfig<FlowTriggerNodeConfig>({
                                    offsetMinutes: Number(e.target.value) || 0,
                                  })
                                }
                              />
                            </FormField>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            Estimated today:{" "}
                            <span className="font-mono font-medium">
                              {computeSunTimeHHMM({
                                date: new Date(),
                                timezone,
                                event: cfg.sunEvent ?? "sunset",
                                offsetMinutes: cfg.offsetMinutes ?? 0,
                              })}
                            </span>{" "}
                            ({timezone})
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* CONDITION CONFIG */}
                {selectedNode.kind === "condition" && (() => {
                  const cfg = selectedNode.config as FlowConditionNodeConfig;
                  return (
                    <div className="space-y-2.5">
                      <FormField id="cond-type" label="Condition Kind">
                        <Select
                          value={cfg.conditionType}
                          onValueChange={(v) =>
                            updateSelectedConfig<FlowConditionNodeConfig>({
                              conditionType: v as FlowConditionNodeConfig["conditionType"],
                              sensorId: cfg.sensorId || sensors[0]?.id,
                              switchId: cfg.switchId || switches[0]?.id,
                              deviceId: cfg.deviceId || devices[0]?.id,
                              roomId: cfg.roomId || rooms[0]?.id,
                              startTime: cfg.startTime ?? "18:00",
                              endTime: cfg.endTime ?? "23:00",
                              timezone,
                            })
                          }
                        >
                          <SelectTrigger id="cond-type" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="sensor_value">Sensor Reading</SelectItem>
                            <SelectItem value="switch_state">Switch State</SelectItem>
                            <SelectItem value="device_state">Device State</SelectItem>
                            <SelectItem value="room_state">Room Lighting State</SelectItem>
                            <SelectItem value="time_range">Time Window</SelectItem>
                            <SelectItem value="variable_check">Flow Variable</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormField>

                      {cfg.conditionType === "sensor_value" && (
                        <>
                          <FormField id="cond-sen" label="Sensor">
                            <Select
                              value={cfg.sensorId ?? ""}
                              onValueChange={(v) =>
                                updateSelectedConfig<FlowConditionNodeConfig>({ sensorId: v })
                              }
                            >
                              <SelectTrigger id="cond-sen" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {sensors.map((s) => (
                                  <SelectItem key={s.id} value={s.id}>
                                    {s.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </FormField>
                          <div className="grid grid-cols-2 gap-2">
                            <FormField id="cond-op" label="Operator">
                              <Select
                                value={cfg.operator ?? "gt"}
                                onValueChange={(v) =>
                                  updateSelectedConfig<FlowConditionNodeConfig>({
                                    operator: v as AutomationOperator,
                                  })
                                }
                              >
                                <SelectTrigger id="cond-op" className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {OPERATOR_OPTIONS.map((op) => (
                                    <SelectItem key={op.value} value={op.value}>
                                      {op.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </FormField>
                            <FormField id="cond-val" label="Threshold">
                              <Input
                                id="cond-val"
                                type="number"
                                step="any"
                                value={cfg.threshold ?? 0}
                                onChange={(e) =>
                                  updateSelectedConfig<FlowConditionNodeConfig>({
                                    threshold: Number(e.target.value),
                                  })
                                }
                              />
                            </FormField>
                          </div>
                        </>
                      )}

                      {cfg.conditionType === "switch_state" && (
                        <div className="grid grid-cols-2 gap-2">
                          <FormField id="cond-sw" label="Switch">
                            <Select
                              value={cfg.switchId ?? ""}
                              onValueChange={(v) =>
                                updateSelectedConfig<FlowConditionNodeConfig>({ switchId: v })
                              }
                            >
                              <SelectTrigger id="cond-sw" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {switches.map((s) => (
                                  <SelectItem key={s.id} value={s.id}>
                                    {s.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </FormField>
                          <FormField id="cond-sw-exp" label="Is">
                            <Select
                              value={cfg.expectedState ? "true" : "false"}
                              onValueChange={(v) =>
                                updateSelectedConfig<FlowConditionNodeConfig>({
                                  expectedState: v === "true",
                                })
                              }
                            >
                              <SelectTrigger id="cond-sw-exp" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="true">ON</SelectItem>
                                <SelectItem value="false">OFF</SelectItem>
                              </SelectContent>
                            </Select>
                          </FormField>
                        </div>
                      )}

                      {cfg.conditionType === "device_state" && (
                        <div className="grid grid-cols-2 gap-2">
                          <FormField id="cond-dev" label="Device">
                            <Select
                              value={cfg.deviceId ?? ""}
                              onValueChange={(v) =>
                                updateSelectedConfig<FlowConditionNodeConfig>({ deviceId: v })
                              }
                            >
                              <SelectTrigger id="cond-dev" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {devices.map((d) => (
                                  <SelectItem key={d.id} value={d.id}>
                                    {d.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </FormField>
                          <FormField id="cond-dev-exp" label="Expected">
                            <Input
                              id="cond-dev-exp"
                              value={String(cfg.expectedState ?? "active")}
                              onChange={(e) =>
                                updateSelectedConfig<FlowConditionNodeConfig>({
                                  expectedState: e.target.value,
                                })
                              }
                            />
                          </FormField>
                        </div>
                      )}

                      {cfg.conditionType === "room_state" && (
                        <div className="grid grid-cols-2 gap-2">
                          <FormField id="cond-rm" label="Room">
                            <Select
                              value={cfg.roomId ?? ""}
                              onValueChange={(v) =>
                                updateSelectedConfig<FlowConditionNodeConfig>({ roomId: v })
                              }
                            >
                              <SelectTrigger id="cond-rm" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {rooms.map((r) => (
                                  <SelectItem key={r.id} value={r.id}>
                                    {r.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </FormField>
                          <FormField id="cond-rm-m" label="Rule">
                            <Select
                              value={cfg.roomMatch ?? "any_on"}
                              onValueChange={(v) =>
                                updateSelectedConfig<FlowConditionNodeConfig>({
                                  roomMatch: v as FlowConditionNodeConfig["roomMatch"],
                                })
                              }
                            >
                              <SelectTrigger id="cond-rm-m" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="any_on">Any switch ON</SelectItem>
                                <SelectItem value="all_on">All switches ON</SelectItem>
                                <SelectItem value="all_off">All switches OFF</SelectItem>
                              </SelectContent>
                            </Select>
                          </FormField>
                        </div>
                      )}

                      {cfg.conditionType === "time_range" && (
                        <div className="grid grid-cols-2 gap-2">
                          <FormField id="cond-st" label="Start Time">
                            <Input
                              id="cond-st"
                              type="time"
                              value={cfg.startTime ?? "18:00"}
                              onChange={(e) =>
                                updateSelectedConfig<FlowConditionNodeConfig>({
                                  startTime: e.target.value,
                                })
                              }
                            />
                          </FormField>
                          <FormField id="cond-et" label="End Time">
                            <Input
                              id="cond-et"
                              type="time"
                              value={cfg.endTime ?? "23:00"}
                              onChange={(e) =>
                                updateSelectedConfig<FlowConditionNodeConfig>({
                                  endTime: e.target.value,
                                })
                              }
                            />
                          </FormField>
                        </div>
                      )}

                      {cfg.conditionType === "variable_check" && (
                        <div className="grid grid-cols-2 gap-2">
                          <FormField id="cond-var" label="Variable Name">
                            <Input
                              id="cond-var"
                              value={cfg.variableName ?? ""}
                              onChange={(e) =>
                                updateSelectedConfig<FlowConditionNodeConfig>({
                                  variableName: e.target.value,
                                })
                              }
                              placeholder="alertTag"
                            />
                          </FormField>
                          <FormField id="cond-var-v" label="Equals Value">
                            <Input
                              id="cond-var-v"
                              value={String(cfg.variableValue ?? "")}
                              onChange={(e) =>
                                updateSelectedConfig<FlowConditionNodeConfig>({
                                  variableValue: e.target.value,
                                })
                              }
                            />
                          </FormField>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* LOGIC CONFIG */}
                {selectedNode.kind === "logic" && (() => {
                  const cfg = selectedNode.config as FlowLogicNodeConfig;
                  return (
                    <FormField id="logic-gate" label="Gate Behavior">
                      <Select
                        value={cfg.gate}
                        onValueChange={(v) =>
                          updateSelectedConfig<FlowLogicNodeConfig>({
                            gate: v as "ALL" | "ANY",
                          })
                        }
                      >
                        <SelectTrigger id="logic-gate" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ALL">ALL — wait until every input arrives</SelectItem>
                          <SelectItem value="ANY">ANY — continue on first active input</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormField>
                  );
                })()}

                {/* DELAY CONFIG */}
                {selectedNode.kind === "delay" && (() => {
                  const cfg = selectedNode.config as FlowDelayNodeConfig;
                  return (
                    <div className="grid grid-cols-2 gap-2">
                      <FormField id="delay-val" label="Duration">
                        <Input
                          id="delay-val"
                          type="number"
                          min={1}
                          value={cfg.durationValue}
                          onChange={(e) =>
                            updateSelectedConfig<FlowDelayNodeConfig>({
                              durationValue: Number(e.target.value) || 1,
                            })
                          }
                        />
                      </FormField>
                      <FormField id="delay-unit" label="Unit">
                        <Select
                          value={cfg.durationUnit}
                          onValueChange={(v) =>
                            updateSelectedConfig<FlowDelayNodeConfig>({
                              durationUnit: v as FlowDelayNodeConfig["durationUnit"],
                            })
                          }
                        >
                          <SelectTrigger id="delay-unit" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="seconds">Seconds</SelectItem>
                            <SelectItem value="minutes">Minutes</SelectItem>
                            <SelectItem value="hours">Hours</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormField>
                    </div>
                  );
                })()}

                {/* ACTION CONFIG */}
                {selectedNode.kind === "action" && (() => {
                  const cfg = selectedNode.config as FlowActionNodeConfig;
                  return (
                    <div className="space-y-2.5">
                      <FormField id="act-type" label="Action Kind">
                        <Select
                          value={cfg.actionType}
                          onValueChange={(v) => {
                            const nextType = v as FlowActionNodeConfig["actionType"];
                            updateSelectedConfig<FlowActionNodeConfig>({
                              actionType: nextType,
                              switchId: cfg.switchId || switches[0]?.id,
                              deviceId: cfg.deviceId || devices[0]?.id,
                              targetState: cfg.targetState ?? "active",
                              sceneName: cfg.sceneName ?? "Evening Comfort",
                              targets:
                                cfg.targets && cfg.targets.length > 0
                                  ? cfg.targets
                                  : switches[0]
                                    ? [{ kind: "switch", switchId: switches[0].id, isOn: true }]
                                    : [],
                              notificationTitle: cfg.notificationTitle ?? "Flow Alert",
                              notificationMessage:
                                cfg.notificationMessage ?? "Automation action ran.",
                              notificationSeverity: cfg.notificationSeverity ?? "info",
                              httpMethod: cfg.httpMethod ?? "POST",
                              httpUrl: cfg.httpUrl ?? "https://example.com/hook",
                            });
                          }}
                        >
                          <SelectTrigger id="act-type" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="switch_on">Turn Switch ON</SelectItem>
                            <SelectItem value="switch_off">Turn Switch OFF</SelectItem>
                            <SelectItem value="device_state">Set Device State</SelectItem>
                            <SelectItem value="scene">Run Multi-Target Scene</SelectItem>
                            <SelectItem value="notification">Send In-App Notification</SelectItem>
                            <SelectItem value="http_request">HTTP Webhook Request</SelectItem>
                            <SelectItem value="set_variable">Set Flow Variable</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormField>

                      {(cfg.actionType === "switch_on" || cfg.actionType === "switch_off") && (() => {
                        const targetSw = cfg.switchId ? switchById.get(cfg.switchId) : undefined;
                        return (
                          <div className="space-y-2">
                            <FormField id="act-sw" label="Target Switch">
                              <Select
                                value={cfg.switchId ?? ""}
                                onValueChange={(v) =>
                                  updateSelectedConfig<FlowActionNodeConfig>({ switchId: v })
                                }
                              >
                                <SelectTrigger id="act-sw" className="w-full">
                                  <SelectValue placeholder="Choose switch..." />
                                </SelectTrigger>
                                <SelectContent>
                                  {switches.map((sw) => (
                                    <SelectItem key={sw.id} value={sw.id}>
                                      {sw.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </FormField>
                            {targetSw && (
                              <div className="flex items-center justify-between rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px]">
                                <span className="text-muted-foreground">Current state</span>
                                <Badge variant={targetSw.is_on ? "warning-light" : "secondary"} size="xs">
                                  {targetSw.is_on ? "ON" : "OFF"}
                                </Badge>
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {cfg.actionType === "device_state" && (() => {
                        const targetDev = cfg.deviceId ? deviceById.get(cfg.deviceId) : undefined;
                        return (
                          <div className="space-y-2">
                            <div className="grid grid-cols-2 gap-2">
                              <FormField id="act-dev" label="Target Device">
                                <Select
                                  value={cfg.deviceId ?? ""}
                                  onValueChange={(v) =>
                                    updateSelectedConfig<FlowActionNodeConfig>({ deviceId: v })
                                  }
                                >
                                  <SelectTrigger id="act-dev" className="w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {devices.map((d) => (
                                      <SelectItem key={d.id} value={d.id}>
                                        {d.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </FormField>
                              <FormField id="act-dev-st" label="Target State">
                                <Input
                                  id="act-dev-st"
                                  value={cfg.targetState ?? "active"}
                                  onChange={(e) =>
                                    updateSelectedConfig<FlowActionNodeConfig>({
                                      targetState: e.target.value,
                                    })
                                  }
                                />
                              </FormField>
                            </div>
                            {targetDev && (
                              <div className="flex items-center justify-between rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px]">
                                <span className="text-muted-foreground">Current state</span>
                                <Badge
                                  variant={isDeviceStateActive(targetDev.state) ? "warning-light" : "secondary"}
                                  size="xs"
                                >
                                  {targetDev.state}
                                </Badge>
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {cfg.actionType === "scene" && (
                        <div className="space-y-2">
                          <FormField id="act-scene-name" label="Scene Name">
                            <Input
                              id="act-scene-name"
                              value={cfg.sceneName ?? ""}
                              onChange={(e) =>
                                updateSelectedConfig<FlowActionNodeConfig>({
                                  sceneName: e.target.value,
                                })
                              }
                            />
                          </FormField>
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="font-medium">Targets ({cfg.targets?.length ?? 0})</span>
                              {switches.length > 0 && (
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="outline"
                                  onClick={() => {
                                    const cur = cfg.targets ?? [];
                                    updateSelectedConfig<FlowActionNodeConfig>({
                                      targets: [
                                        ...cur,
                                        {
                                          kind: "switch",
                                          switchId: switches[0]!.id,
                                          isOn: true,
                                        },
                                      ],
                                    });
                                  }}
                                >
                                  + Target
                                </Button>
                              )}
                            </div>
                            {(cfg.targets ?? []).map((t: SceneTargetItem, tIdx: number) => (
                              <div key={tIdx} className="flex items-center gap-1.5">
                                {t.kind === "switch" ? (
                                  <>
                                    <Select
                                      value={t.switchId}
                                      onValueChange={(v) => {
                                        const next = [...(cfg.targets ?? [])];
                                        next[tIdx] = { kind: "switch", switchId: v, isOn: t.isOn };
                                        updateSelectedConfig<FlowActionNodeConfig>({ targets: next });
                                      }}
                                    >
                                      <SelectTrigger className="h-7 flex-1 text-[11px]">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {switches.map((sw) => (
                                          <SelectItem key={sw.id} value={sw.id}>
                                            {sw.name}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    <Select
                                      value={t.isOn ? "on" : "off"}
                                      onValueChange={(v) => {
                                        const next = [...(cfg.targets ?? [])];
                                        next[tIdx] = {
                                          kind: "switch",
                                          switchId: t.switchId,
                                          isOn: v === "on",
                                        };
                                        updateSelectedConfig<FlowActionNodeConfig>({ targets: next });
                                      }}
                                    >
                                      <SelectTrigger className="h-7 w-16 text-[11px]">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="on">ON</SelectItem>
                                        <SelectItem value="off">OFF</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </>
                                ) : (
                                  <span className="flex-1 text-[11px] truncate">
                                    Device: {t.deviceId} → {t.targetState}
                                  </span>
                                )}
                                <Button
                                  type="button"
                                  size="icon-xs"
                                  variant="ghost"
                                  onClick={() =>
                                    updateSelectedConfig<FlowActionNodeConfig>({
                                      targets: (cfg.targets ?? []).filter((_, i) => i !== tIdx),
                                    })
                                  }
                                >
                                  <RiDeleteBinLine className="size-3" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {cfg.actionType === "notification" && (
                        <>
                          <FormField id="act-notif-t" label="Title">
                            <Input
                              id="act-notif-t"
                              value={cfg.notificationTitle ?? ""}
                              onChange={(e) =>
                                updateSelectedConfig<FlowActionNodeConfig>({
                                  notificationTitle: e.target.value,
                                })
                              }
                            />
                          </FormField>
                          <FormField id="act-notif-m" label="Message">
                            <Input
                              id="act-notif-m"
                              value={cfg.notificationMessage ?? ""}
                              onChange={(e) =>
                                updateSelectedConfig<FlowActionNodeConfig>({
                                  notificationMessage: e.target.value,
                                })
                              }
                            />
                          </FormField>
                          <FormField id="act-notif-s" label="Severity">
                            <Select
                              value={cfg.notificationSeverity ?? "info"}
                              onValueChange={(v) =>
                                updateSelectedConfig<FlowActionNodeConfig>({
                                  notificationSeverity: v as
                                    | "info"
                                    | "success"
                                    | "warning"
                                    | "danger",
                                })
                              }
                            >
                              <SelectTrigger id="act-notif-s" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="info">Info</SelectItem>
                                <SelectItem value="success">Success</SelectItem>
                                <SelectItem value="warning">Warning</SelectItem>
                                <SelectItem value="danger">Critical Alert</SelectItem>
                              </SelectContent>
                            </Select>
                          </FormField>
                        </>
                      )}

                      {cfg.actionType === "http_request" && (
                        <>
                          <div className="grid grid-cols-3 gap-2">
                            <FormField id="act-http-m" label="Method">
                              <Select
                                value={cfg.httpMethod ?? "POST"}
                                onValueChange={(v) =>
                                  updateSelectedConfig<FlowActionNodeConfig>({
                                    httpMethod: v as FlowActionNodeConfig["httpMethod"],
                                  })
                                }
                              >
                                <SelectTrigger id="act-http-m" className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="GET">GET</SelectItem>
                                  <SelectItem value="POST">POST</SelectItem>
                                  <SelectItem value="PUT">PUT</SelectItem>
                                  <SelectItem value="PATCH">PATCH</SelectItem>
                                </SelectContent>
                              </Select>
                            </FormField>
                            <div className="col-span-2">
                              <FormField id="act-http-u" label="Endpoint URL">
                                <Input
                                  id="act-http-u"
                                  value={cfg.httpUrl ?? ""}
                                  onChange={(e) =>
                                    updateSelectedConfig<FlowActionNodeConfig>({
                                      httpUrl: e.target.value,
                                    })
                                  }
                                />
                              </FormField>
                            </div>
                          </div>
                          <FormField id="act-http-b" label="JSON Payload (Optional)">
                            <Input
                              id="act-http-b"
                              className="font-mono text-[11px]"
                              value={cfg.httpBody ?? ""}
                              onChange={(e) =>
                                updateSelectedConfig<FlowActionNodeConfig>({
                                  httpBody: e.target.value,
                                })
                              }
                            />
                          </FormField>
                        </>
                      )}

                      {cfg.actionType === "set_variable" && (
                        <div className="grid grid-cols-2 gap-2">
                          <FormField id="act-var-n" label="Variable Name">
                            <Input
                              id="act-var-n"
                              value={cfg.variableName ?? ""}
                              onChange={(e) =>
                                updateSelectedConfig<FlowActionNodeConfig>({
                                  variableName: e.target.value,
                                })
                              }
                            />
                          </FormField>
                          <FormField id="act-var-v" label="Value">
                            <Input
                              id="act-var-v"
                              value={String(cfg.variableValue ?? "")}
                              onChange={(e) =>
                                updateSelectedConfig<FlowActionNodeConfig>({
                                  variableValue: e.target.value,
                                })
                              }
                            />
                          </FormField>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* END CONFIG */}
                {selectedNode.kind === "end" && (() => {
                  const cfg = selectedNode.config as FlowEndNodeConfig;
                  return (
                    <FormField id="end-outcome" label="Outcome">
                      <Select
                        value={cfg.outcome}
                        onValueChange={(v) =>
                          updateSelectedConfig<FlowEndNodeConfig>({
                            outcome: v as "completed" | "stopped",
                          })
                        }
                      >
                        <SelectTrigger id="end-outcome" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="completed">Completed</SelectItem>
                          <SelectItem value="stopped">Stopped Branch</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormField>
                  );
                })()}

                {/* Outgoing Connection Helper & Quick-Branch Builder */}
                {canManage && selectedNode.kind !== "end" && (
                  <div className="border-t border-border pt-3 space-y-2.5">
                    <p className="font-semibold text-foreground">Next Steps &amp; Wiring</p>
                    {selectedNode.kind === "condition" ? (
                      <div className="grid grid-cols-2 gap-1.5">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            appendNode(
                              "action",
                              "True Action",
                              switches[0]
                                ? { actionType: "switch_on", switchId: switches[0].id }
                                : {
                                    actionType: "notification",
                                    notificationTitle: "Condition Passed",
                                    notificationMessage: "Flow condition matched.",
                                    notificationSeverity: "success",
                                  },
                              true,
                              "true"
                            )
                          }
                        >
                          + True Action
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            appendNode(
                              "action",
                              "False Action",
                              switches[0]
                                ? { actionType: "switch_off", switchId: switches[0].id }
                                : {
                                    actionType: "notification",
                                    notificationTitle: "Condition Skipped",
                                    notificationMessage: "Flow took False branch.",
                                    notificationSeverity: "info",
                                  },
                              true,
                              "false"
                            )
                          }
                        >
                          + False Action
                        </Button>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-1.5">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            appendNode(
                              "condition",
                              "Check Condition",
                              {
                                conditionType: rooms[0] ? "room_state" : "time_range",
                                roomId: rooms[0]?.id,
                                roomMatch: "any_on",
                                startTime: "18:00",
                                endTime: "23:00",
                                timezone,
                              },
                              true,
                              "out"
                            )
                          }
                        >
                          + Add If Branch
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            appendNode(
                              "action",
                              "Next Action",
                              switches[0]
                                ? { actionType: "switch_on", switchId: switches[0].id }
                                : {
                                    actionType: "notification",
                                    notificationTitle: "Flow Alert",
                                    notificationMessage: "Automation action ran.",
                                    notificationSeverity: "info",
                                  },
                              true,
                              "out"
                            )
                          }
                        >
                          + Next Action
                        </Button>
                      </div>
                    )}
                    {outgoingFromSelected.length > 0 && (
                      <div className="space-y-1">
                        {outgoingFromSelected.map((edge) => {
                          const targetNode = graph.nodes.find((n) => n.id === edge.target);
                          return (
                            <div
                              key={edge.id}
                              className="flex items-center justify-between rounded border border-border px-2 py-1 text-[11px]"
                            >
                              <span className="truncate">
                                <Badge variant="outline" size="xs" className="mr-1.5">
                                  {edge.sourceHandle ?? "out"}
                                </Badge>
                                → {targetNode?.label ?? edge.target}
                              </span>
                              <button
                                type="button"
                                className="text-destructive hover:underline ml-2"
                                onClick={() =>
                                  commitGraph((prev) => ({
                                    ...prev,
                                    edges: prev.edges.filter((e) => e.id !== edge.id),
                                  }))
                                }
                              >
                                Remove
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5">
                      {selectedNode.kind === "condition" && (
                        <Select
                          value={connectHandle}
                          onValueChange={(v) => setConnectHandle(v as "true" | "false")}
                        >
                          <SelectTrigger className="h-7 w-20 text-[11px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">True</SelectItem>
                            <SelectItem value="false">False</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                      <Select value={connectTargetId} onValueChange={setConnectTargetId}>
                        <SelectTrigger className="h-7 flex-1 text-[11px]">
                          <SelectValue placeholder="Connect to node..." />
                        </SelectTrigger>
                        <SelectContent>
                          {graph.nodes
                            .filter((n) => n.id !== selectedNode.id && n.kind !== "trigger")
                            .map((n) => (
                              <SelectItem key={n.id} value={n.id}>
                                {n.label} ({n.kind})
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={!connectTargetId}
                        onClick={connectSelectedToTarget}
                      >
                        Wire
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Compact Dismissible Dry-Run Flow Trace */}
      {testTrace && (
        <Card className="py-3">
          <CardHeader className="py-0 pb-2 px-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-xs font-semibold">
                  Dry-Run Flow Evaluation Trace
                </CardTitle>
                <Badge
                  variant={testTrace.conditionsMatched ? "success-light" : "warning-light"}
                  size="xs"
                >
                  {testTrace.conditionsMatched ? "Conditions Matched" : "Conditions Not Met"}
                </Badge>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                title="Dismiss trace"
                onClick={() => setTestTrace(null)}
              >
                <RiCloseLine className="size-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="px-4 py-0 space-y-2 text-xs">
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
              {Object.values(testTrace.nodeResults).map((nr) => (
                <div
                  key={nr.nodeId}
                  className="rounded-md border border-border bg-muted/25 px-2.5 py-1.5"
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="font-semibold text-[11px] text-foreground truncate">
                      {nr.label}
                    </span>
                    <Badge
                      variant={
                        nr.status === "passed" || nr.status === "executed"
                          ? "success-light"
                          : nr.status === "failed"
                            ? "destructive-light"
                            : "outline"
                      }
                      size="xs"
                    >
                      {nr.status}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-[10px] text-muted-foreground truncate">
                    {nr.detail}
                  </p>
                </div>
              ))}
            </div>
            {testTrace.actionsPlanned.length > 0 && (
              <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                <span className="font-semibold text-foreground">
                  Actions ({testTrace.actionsPlanned.length}):{" "}
                </span>
                {testTrace.actionsPlanned.map((a) => a.detail).join(" · ")}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
