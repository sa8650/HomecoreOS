import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AUTOMATION_WEEKDAYS,
  buildTriggerConfigFromList,
  computeSunTimeHHMM,
  normalizeTriggerList,
  type AutomationActionItem,
  type AutomationWeekday,
  type AutomationOperator,
  type AutomationTriggerItem,
} from "@homecoreos/shared";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiEditLine,
  RiFlashlightLine,
  RiFlaskLine,
  RiFolderLine,
  RiGitBranchLine,
  RiPlayLine,
  RiSearchLine,
  RiTimeLine,
} from "@remixicon/react";
import { toast } from "sonner";
import { apiFetch, ApiError, cachedGet } from "@/lib/api";
import { useLiveSync } from "@/lib/realtime/RealtimeProvider";
import { formatTimestamp, useEffectiveTimezone } from "@/lib/timezone";
import { cn } from "cn";
import { VisualAutomationBuilder } from "@/components/automations/VisualAutomationBuilder";
import { Badge } from "@/components/reui/badge";
import { ConfirmDeleteDialog, FormField } from "@/components/shared/AppUi";
import { AUTOMATIONS_HERO_ICONS } from "@/components/shared/HeroDomainIcons";
import { PageHeroHeader } from "@/components/shared/PageHeroHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  AutomationItem,
  ControllerItem,
  DeviceItem,
  RoomItem,
  SensorItem,
  SwitchItem,
} from "../types";

type ConditionKind = "schedule" | "device_state" | "sun_event" | "event" | "scene";
type ActionFormType = "switch_on" | "switch_off" | "device_state" | "scene";
type SceneTarget = NonNullable<AutomationActionItem["targets"]>[number];

const WEEKDAYS = AUTOMATION_WEEKDAYS.map((day) => day.id);
const WEEKDAY_LABELS = Object.fromEntries(
  AUTOMATION_WEEKDAYS.map((day) => [day.id, day.label])
) as Record<AutomationWeekday, string>;

const OPERATORS: Array<{ value: AutomationOperator; symbol: string; label: string }> = [
  { value: "gt", symbol: ">", label: "Greater than (>)" },
  { value: "gte", symbol: "≥", label: "Greater or equal (>=)" },
  { value: "lt", symbol: "<", label: "Less than (<)" },
  { value: "lte", symbol: "≤", label: "Less or equal (<=)" },
  { value: "eq", symbol: "=", label: "Equals (=)" },
  { value: "neq", symbol: "≠", label: "Not equal (!=)" },
];

const SUN_OFFSETS = [
  { value: -30, label: "-30m" },
  { value: -15, label: "-15m" },
  { value: 0, label: "Exact" },
  { value: 15, label: "+15m" },
  { value: 30, label: "+30m" },
];

// Clean emerald line icons matching the "Choose Condition" automation card design
function ConditionIcon({
  kind,
  className = "size-6",
}: {
  kind: ConditionKind;
  className?: string;
}) {
  const strokeProps = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.65,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  if (kind === "schedule") {
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...strokeProps}>
        <path d="M9 3.5h6l.8 3.2A6 6 0 0 0 8.2 6.7L9 3.5Z" />
        <path d="M9 20.5h6l.8-3.2a6 6 0 0 1-7.6 0l.8 3.2Z" />
        <circle cx="12" cy="12" r="5.5" />
        <path d="M12 9.2V12l1.8 1.2" />
      </svg>
    );
  }
  if (kind === "device_state") {
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...strokeProps}>
        <path d="M12 3.2 4.5 7.4v9.2L12 20.8l7.5-4.2V7.4L12 3.2Z" />
        <path d="M4.5 7.4 12 11.6l7.5-4.2" />
        <path d="M12 11.6v9.2" />
      </svg>
    );
  }
  if (kind === "sun_event") {
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...strokeProps}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
      </svg>
    );
  }
  if (kind === "event") {
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...strokeProps}>
        <path d="M12 3.5a5.5 5.5 0 0 0-5.5 5.5v3.6c0 .9-.4 1.8-1 2.4l-.8.8h14.6l-.8-.8c-.6-.6-1-1.5-1-2.4V9A5.5 5.5 0 0 0 12 3.5Z" />
        <path d="M9.8 18.2a2.2 2.2 0 0 0 4.4 0" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...strokeProps}>
      <path d="M11 4.2V2.6M7.8 5.4 6.6 4.2M14.2 5.4l1.2-1.2" />
      <path d="M9.8 12.2V7.6a1.3 1.3 0 0 1 2.6 0v4.2" />
      <path d="M12.4 10.6a1.25 1.25 0 0 1 2.5 0v1.6" />
      <path d="M14.9 11.4a1.25 1.25 0 0 1 2.5 0v3.3a5.6 5.6 0 0 1-5.6 5.6h-1.2a5 5 0 0 1-4.1-2.2l-1.9-2.8a1.2 1.2 0 0 1 1.9-1.5l1.3 1.2v-2.8" />
    </svg>
  );
}

const CONDITION_META: Record<
  ConditionKind,
  {
    title: string;
    badge: string;
    placeholder: string;
    helper: string;
  }
> = {
  schedule: {
    title: "Schedule",
    badge: "Schedule",
    placeholder: "e.g. Morning Living Room Lights",
    helper: "Automation will start at a specific time of day",
  },
  device_state: {
    title: "Device State",
    badge: "Device State",
    placeholder: "e.g. Night Light When Wall Switch Off",
    helper: "Trigger automation by a certain state of the device.",
  },
  sun_event: {
    title: "Sunset/Sunrise",
    badge: "Sunset/Sunrise",
    placeholder: "e.g. Porch Lights at Sunset",
    helper: "Automation will start based on the sun",
  },
  event: {
    title: "Event",
    badge: "Event",
    placeholder: "e.g. High Temp Exhaust Fan",
    helper: "Trigger automation when a sensor event is logged.",
  },
  scene: {
    title: "Scene",
    badge: "Scene",
    placeholder: "e.g. Goodnight All Off Scene",
    helper: "Trigger automation manually",
  },
};

function ruleConditionKind(rule: AutomationItem): ConditionKind {
  const list = normalizeTriggerList(rule.trigger_config);
  const first = list[0];
  if (!first) return "scene";
  if (first.type === "time") return "schedule";
  if (first.type === "device_state") return "device_state";
  if (first.type === "sun_event") return "sun_event";
  if (first.type === "manual") return "scene";
  return "event";
}

function describeTrigger(
  t: AutomationItem["trigger_config"],
  sensors: SensorItem[],
  switches: SwitchItem[],
  devices: DeviceItem[]
): string {
  const list = normalizeTriggerList(t);
  if (list.length === 0) return "Manual scene trigger";
  return list
    .map((item) => {
      if (item.type === "manual") {
        return "Manual scene (one-tap run)";
      }
      if (item.type === "sensor_value") {
        const s = sensors.find((x) => x.id === item.sensorId);
        const opSym =
          OPERATORS.find((o) => o.value === item.operator)?.symbol ?? item.operator ?? "=";
        return `${s?.name ?? "Sensor"} ${opSym} ${item.threshold ?? "?"}${s?.unit ? ` ${s.unit}` : ""}`;
      }
      if (item.type === "device_state") {
        if (item.switchId) {
          const sw = switches.find((x) => x.id === item.switchId);
          const expected =
            item.expectedState === true || item.expectedState === "on"
              ? "ON"
              : "OFF";
          return `${sw?.name ?? "Switch"} turned ${expected}`;
        }
        const dev = devices.find((x) => x.id === item.deviceId);
        return `${dev?.name ?? "Device"} becomes "${String(item.expectedState ?? "active")}"`;
      }
      if (item.type === "sun_event") {
        const label = item.sunEvent === "sunrise" ? "Sunrise" : "Sunset";
        const offset = item.offsetMinutes ?? 0;
        const offsetText = offset === 0 ? "" : offset > 0 ? ` +${offset}m` : ` ${offset}m`;
        const days = item.days?.length ? ` (${item.days.join(", ")})` : " (daily)";
        return `${label}${offsetText}${days}`;
      }
      const days = item.days?.length ? ` on ${item.days.join(", ")}` : " daily";
      return `At ${item.cronTime ?? "19:00"}${days}${item.timezone ? ` (${item.timezone})` : ""}`;
    })
    .join(" OR ");
}

function describeActions(
  actions: AutomationActionItem[],
  switches: SwitchItem[],
  devices: DeviceItem[]
): string {
  if (!actions || actions.length === 0) return "No actions configured";
  return actions
    .map((a) => {
      if (a.type === "switch_on") {
        const sw = switches.find((x) => x.id === a.switchId);
        return `Turn ${sw?.name ?? "Switch"} ON`;
      }
      if (a.type === "switch_off") {
        const sw = switches.find((x) => x.id === a.switchId);
        return `Turn ${sw?.name ?? "Switch"} OFF`;
      }
      if (a.type === "scene") {
        const count = a.targets?.length ?? 0;
        return `Run "${a.sceneName ?? "Scene"}" (${count} target${count === 1 ? "" : "s"})`;
      }
      const dev = devices.find((x) => x.id === a.deviceId);
      return `Set ${dev?.name ?? "Device"} → ${a.targetState ?? "active"}`;
    })
    .join(", ");
}

function isComplexFlowRule(rule: AutomationItem): boolean {
  const graph = rule.flow_graph;
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return false;
  return graph.nodes.some(
    (n) =>
      n.kind === "delay" ||
      n.kind === "logic" ||
      (n.kind === "action" &&
        ["notification", "http_request", "set_variable"].includes(
          String((n.config as { actionType?: string }).actionType ?? "")
        ))
  );
}

function formatOffsetLabel(offset: number): string {
  if (offset === 0) return "at exact time";
  return offset > 0 ? `${offset} min after` : `${Math.abs(offset)} min before`;
}

export function AutomationsPage({
  canManage,
  canOperate,
}: {
  canManage: boolean;
  canOperate: boolean;
}) {
  const effectiveTimezone = useEffectiveTimezone();
  const [activeTab, setActiveTab] = useState<"rules" | "builder">("rules");
  const [search, setSearch] = useState("");
  const [folderFilter, setFolderFilter] = useState("all");
  const [rules, setRules] = useState<AutomationItem[]>([]);
  const [sensors, setSensors] = useState<SensorItem[]>([]);
  const [switches, setSwitches] = useState<SwitchItem[]>([]);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [rooms, setRooms] = useState<RoomItem[]>([]);
  const [controllers, setControllers] = useState<ControllerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [checkingSchedules, setCheckingSchedules] = useState(false);

  // Visual Builder state
  const [builderRule, setBuilderRule] = useState<AutomationItem | null>(null);
  const [builderKey, setBuilderKey] = useState(0);
  const [flowsMenuOpen, setFlowsMenuOpen] = useState(false);
  const [flowFilter, setFlowFilter] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});

  // Interactive rule creation/edit modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [conditionKind, setConditionKind] = useState<ConditionKind>("schedule");
  const [name, setName] = useState("");
  const [folderName, setFolderName] = useState("General");

  // Trigger config fields
  const [deviceStateSource, setDeviceStateSource] = useState<"switch" | "device">("switch");
  const [sensorId, setSensorId] = useState("");
  const [operator, setOperator] = useState<AutomationOperator>("gt");
  const [thresholdText, setThresholdText] = useState("30");
  const [triggerSwitchId, setTriggerSwitchId] = useState("");
  const [triggerSwitchState, setTriggerSwitchState] = useState<"on" | "off">("off");
  const [triggerDeviceId, setTriggerDeviceId] = useState("");
  const [triggerDeviceState, setTriggerDeviceState] = useState("active");
  const [cronTime, setCronTime] = useState("19:00");
  const [selectedDays, setSelectedDays] = useState<string[]>([]);
  const [sunEvent, setSunEvent] = useState<"sunrise" | "sunset">("sunset");
  const [sunOffset, setSunOffset] = useState(0);

  // Action config fields
  const [actionType, setActionType] = useState<ActionFormType>("switch_on");
  const [targetSwitchId, setTargetSwitchId] = useState("");
  const [targetDeviceId, setTargetDeviceId] = useState("");
  const [targetDeviceState, setTargetDeviceState] = useState("active");
  const [sceneName, setSceneName] = useState("");
  const [sceneTargets, setSceneTargets] = useState<SceneTarget[]>([]);
  const [executionMode, setExecutionMode] = useState<"cloud" | "controller" | "hybrid">("cloud");

  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AutomationItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [lastDryRunByRule, setLastDryRunByRule] = useState<
    Record<
      string,
      {
        conditionsMatched: boolean;
        triggerSummaries: string[];
        plannedActions: Array<{ summary: string }>;
      }
    >
  >({});
  const savingRef = useRef(false);
  const deletingRef = useRef(false);

  async function load(force = false) {
    try {
      const [rRes, senRes, swRes, devRes, ovRes] = await Promise.all([
        cachedGet<{ automations: AutomationItem[] }>("/api/automations", {
          ttlMs: 12_000,
          force,
        }),
        cachedGet<{ sensors: SensorItem[] }>("/api/sensors", { ttlMs: 12_000, force }),
        cachedGet<{ switches: SwitchItem[] }>("/api/switches", { ttlMs: 12_000, force }),
        cachedGet<{ devices: DeviceItem[] }>("/api/devices", { ttlMs: 12_000, force }),
        cachedGet<{ rooms?: RoomItem[]; controllers?: ControllerItem[] }>("/api/homes/overview", {
          ttlMs: 20_000,
          force,
        }).catch(() => ({ rooms: [] as RoomItem[], controllers: [] as ControllerItem[] })),
      ]);
      const nextRules = rRes.automations ?? [];
      const nextSensors = senRes.sensors ?? [];
      const nextSwitches = swRes.switches ?? [];
      const nextDevices = devRes.devices ?? [];
      setRules(nextRules);
      setSensors(nextSensors);
      setSwitches(nextSwitches);
      setDevices(nextDevices);
      setRooms(ovRes.rooms ?? []);
      setControllers(ovRes.controllers ?? []);

      if (nextSensors[0] && !sensorId) setSensorId(nextSensors[0].id);
      if (nextSwitches[0] && !targetSwitchId) setTargetSwitchId(nextSwitches[0].id);
      if (nextSwitches[0] && !triggerSwitchId) setTriggerSwitchId(nextSwitches[0].id);
      if (nextDevices[0] && !targetDeviceId) setTargetDeviceId(nextDevices[0].id);
      if (nextDevices[0] && !triggerDeviceId) setTriggerDeviceId(nextDevices[0].id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load automations.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Execution results and the entities automations reference arrive over the
  // shared channel; no interval polling.
  useLiveSync(() => load(true), {
    kinds: ["automation", "sensor", "switch", "device", "board"],
    fallbackMs: 60_000,
  });

  const hasDeviceOrSwitch = switches.length > 0 || devices.length > 0;
  const hasSensors = sensors.length > 0;
  const hasActionableHardware = switches.length > 0 || devices.length > 0;

  function openVisualFlow(rule: AutomationItem | null) {
    setBuilderRule(rule);
    setBuilderKey((k) => k + 1);
    setActiveTab("builder");
  }

  function buildDefaultSceneTargets(): SceneTarget[] {
    if (switches[0]) {
      return [{ kind: "switch", switchId: switches[0].id, isOn: true }];
    }
    if (devices[0]) {
      return [{ kind: "device", deviceId: devices[0].id, targetState: "active" }];
    }
    return [];
  }

  function openConditionBuilder(kind: ConditionKind) {
    if (!canManage) return;
    if (kind === "device_state" && !hasDeviceOrSwitch) {
      toast.info("Add a switch or device first to use the Device State trigger.");
      return;
    }
    if (kind === "event" && !hasSensors) {
      toast.info("Add a sensor first to use the Event trigger.");
      return;
    }

    setEditingRuleId(null);
    setConditionKind(kind);
    setName("");
    setFolderName(folderFilter !== "all" ? folderFilter : "General");
    setSelectedDays([]);
    setCronTime("19:00");
    setSunEvent("sunset");
    setSunOffset(0);
    setOperator("gt");
    setThresholdText("30");

    if (switches[0]) {
      setDeviceStateSource("switch");
      setTriggerSwitchId(switches[0].id);
      setTriggerSwitchState("off");
      setTargetSwitchId(switches[0].id);
    } else if (devices[0]) {
      setDeviceStateSource("device");
      setTriggerDeviceId(devices[0].id);
      setTriggerDeviceState("active");
      setTargetDeviceId(devices[0].id);
    }
    if (sensors[0]) setSensorId(sensors[0].id);
    if (devices[0]) setTargetDeviceId(devices[0].id);

    if (kind === "scene") {
      setActionType(hasActionableHardware ? "scene" : "switch_on");
      setSceneName("");
      setSceneTargets(buildDefaultSceneTargets());
    } else if (switches[0]) {
      setActionType("switch_on");
      setSceneTargets(buildDefaultSceneTargets());
    } else if (devices[0]) {
      setActionType("device_state");
      setTargetDeviceState("active");
      setSceneTargets(buildDefaultSceneTargets());
    } else {
      setActionType("switch_on");
      setSceneTargets([]);
    }

    setExecutionMode("cloud");
    setModalOpen(true);
  }

  function openEditModal(rule: AutomationItem) {
    if (isComplexFlowRule(rule)) {
      openVisualFlow(rule);
      return;
    }
    setEditingRuleId(rule.id);
    setName(rule.name);
    setFolderName(rule.folder_name || "General");
    setExecutionMode(rule.execution_mode ?? "cloud");

    const trig = normalizeTriggerList(rule.trigger_config)[0];
    if (trig?.type === "time") {
      setConditionKind("schedule");
      setCronTime(trig.cronTime ?? "19:00");
      setSelectedDays(trig.days ?? []);
    } else if (trig?.type === "sun_event") {
      setConditionKind("sun_event");
      setSunEvent(trig.sunEvent === "sunrise" ? "sunrise" : "sunset");
      setSunOffset(trig.offsetMinutes ?? 0);
      setSelectedDays(trig.days ?? []);
    } else if (trig?.type === "device_state") {
      setConditionKind("device_state");
      if (trig.switchId) {
        setDeviceStateSource("switch");
        setTriggerSwitchId(trig.switchId);
        setTriggerSwitchState(
          trig.expectedState === true || trig.expectedState === "on" ? "on" : "off"
        );
      } else {
        setDeviceStateSource("device");
        setTriggerDeviceId(trig.deviceId ?? devices[0]?.id ?? "");
        setTriggerDeviceState(String(trig.expectedState ?? "active"));
      }
    } else if (trig?.type === "manual") {
      setConditionKind("scene");
    } else {
      setConditionKind("event");
      setSensorId(trig?.sensorId ?? sensors[0]?.id ?? "");
      setOperator(trig?.operator ?? "gt");
      setThresholdText(String(trig?.threshold ?? 30));
    }

    const firstAction = rule.actions_config?.[0];
    if (firstAction?.type === "switch_on" || firstAction?.type === "switch_off") {
      setActionType(firstAction.type);
      setTargetSwitchId(firstAction.switchId ?? switches[0]?.id ?? "");
    } else if (firstAction?.type === "device_state") {
      setActionType("device_state");
      setTargetDeviceId(firstAction.deviceId ?? devices[0]?.id ?? "");
      setTargetDeviceState(firstAction.targetState ?? "active");
    } else if (firstAction?.type === "scene") {
      setActionType("scene");
      setSceneName(firstAction.sceneName ?? rule.name);
      setSceneTargets(
        firstAction.targets && firstAction.targets.length > 0
          ? firstAction.targets
          : buildDefaultSceneTargets()
      );
    } else {
      setActionType(switches[0] ? "switch_on" : "device_state");
    }

    setModalOpen(true);
  }

  function toggleWeekday(day: string) {
    setSelectedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  }

  function addSceneTarget(kind: "switch" | "device") {
    if (kind === "switch" && switches[0]) {
      const unused = switches.find(
        (sw) => !sceneTargets.some((t) => t.kind === "switch" && t.switchId === sw.id)
      );
      setSceneTargets((prev) => [
        ...prev,
        { kind: "switch", switchId: (unused ?? switches[0]!).id, isOn: true },
      ]);
    } else if (kind === "device" && devices[0]) {
      const unused = devices.find(
        (d) => !sceneTargets.some((t) => t.kind === "device" && t.deviceId === d.id)
      );
      setSceneTargets((prev) => [
        ...prev,
        { kind: "device", deviceId: (unused ?? devices[0]!).id, targetState: "active" },
      ]);
    }
  }

  const computedSunPreview = useMemo(() => {
    try {
      return computeSunTimeHHMM({
        date: new Date(),
        event: sunEvent,
        timezone: effectiveTimezone,
        offsetMinutes: sunOffset,
      });
    } catch {
      return sunEvent === "sunrise" ? "06:30" : "18:30";
    }
  }, [sunEvent, effectiveTimezone, sunOffset]);

  const draftPreview = useMemo(() => {
    let whenText = "";
    if (conditionKind === "schedule") {
      const daysStr =
        selectedDays.length === 0 || selectedDays.length === 7
          ? "Every day"
          : selectedDays
              .map((d) => WEEKDAY_LABELS[d as keyof typeof WEEKDAY_LABELS] ?? d)
              .join(", ");
      whenText = `${daysStr} at ${cronTime || "19:00"} (${effectiveTimezone})`;
    } else if (conditionKind === "device_state") {
      if (deviceStateSource === "switch") {
        const sw = switches.find((s) => s.id === triggerSwitchId);
        whenText = `When ${sw?.name ?? "Switch"} turns ${triggerSwitchState.toUpperCase()}`;
      } else {
        const dev = devices.find((d) => d.id === triggerDeviceId);
        whenText = `When ${dev?.name ?? "Device"} becomes "${triggerDeviceState || "active"}"`;
      }
    } else if (conditionKind === "sun_event") {
      const label = sunEvent === "sunrise" ? "Sunrise" : "Sunset";
      whenText = `${label} (${formatOffsetLabel(sunOffset)} · ~${computedSunPreview})`;
    } else if (conditionKind === "event") {
      const sen = sensors.find((s) => s.id === sensorId);
      const sym = OPERATORS.find((o) => o.value === operator)?.symbol ?? "=";
      whenText = `When ${sen?.name ?? "Sensor"} ${sym} ${thresholdText || "0"}${sen?.unit ? ` ${sen.unit}` : ""}`;
    } else {
      whenText = "Manual one-tap Scene";
    }

    let thenText = "";
    if (actionType === "switch_on" || actionType === "switch_off") {
      const sw = switches.find((s) => s.id === targetSwitchId);
      thenText = `Turn ${sw?.name ?? "Switch"} ${actionType === "switch_on" ? "ON" : "OFF"}`;
    } else if (actionType === "device_state") {
      const dev = devices.find((d) => d.id === targetDeviceId);
      thenText = `Set ${dev?.name ?? "Device"} to "${targetDeviceState || "active"}"`;
    } else {
      const count = sceneTargets.length;
      thenText =
        count > 0
          ? `Execute ${count} target${count === 1 ? "" : "s"} in "${sceneName.trim() || name.trim() || "Scene"}"`
          : "Add at least one target to this scene";
    }
    return { whenText, thenText };
  }, [
    conditionKind,
    selectedDays,
    cronTime,
    effectiveTimezone,
    deviceStateSource,
    switches,
    triggerSwitchId,
    triggerSwitchState,
    devices,
    triggerDeviceId,
    triggerDeviceState,
    sunEvent,
    sunOffset,
    computedSunPreview,
    sensors,
    sensorId,
    operator,
    thresholdText,
    actionType,
    targetSwitchId,
    targetDeviceId,
    targetDeviceState,
    sceneTargets,
    sceneName,
    name,
  ]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Please enter an automation name.");
      return;
    }

    let triggerItem: AutomationTriggerItem;
    if (conditionKind === "schedule") {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cronTime)) {
        toast.error("Enter a valid 24-hour time (HH:MM).");
        return;
      }
      triggerItem = {
        type: "time",
        cronTime,
        timezone: effectiveTimezone,
        ...(selectedDays.length > 0 ? { days: selectedDays } : {}),
      };
    } else if (conditionKind === "device_state") {
      if (deviceStateSource === "switch") {
        if (!triggerSwitchId) {
          toast.error("Select a trigger switch.");
          return;
        }
        triggerItem = {
          type: "device_state",
          switchId: triggerSwitchId,
          expectedState: triggerSwitchState === "on",
        };
      } else {
        if (!triggerDeviceId || !triggerDeviceState.trim()) {
          toast.error("Select a trigger device and target state.");
          return;
        }
        triggerItem = {
          type: "device_state",
          deviceId: triggerDeviceId,
          expectedState: triggerDeviceState.trim(),
        };
      }
    } else if (conditionKind === "sun_event") {
      triggerItem = {
        type: "sun_event",
        sunEvent,
        offsetMinutes: Math.max(-180, Math.min(180, Math.round(sunOffset))),
        timezone: effectiveTimezone,
        ...(selectedDays.length > 0 ? { days: selectedDays } : {}),
      };
    } else if (conditionKind === "event") {
      const parsedThreshold = Number(thresholdText);
      if (!sensorId) {
        toast.error("Select a trigger sensor.");
        return;
      }
      if (!thresholdText.trim() || !Number.isFinite(parsedThreshold)) {
        toast.error("Enter a valid numeric threshold.");
        return;
      }
      triggerItem = {
        type: "sensor_value",
        sensorId,
        operator,
        threshold: parsedThreshold,
      };
    } else {
      triggerItem = { type: "manual" };
    }

    const triggerConfig = buildTriggerConfigFromList([triggerItem]);

    let actionsConfig: AutomationActionItem[];
    if (actionType === "switch_on" || actionType === "switch_off") {
      if (!targetSwitchId) {
        toast.error("Select a target switch for the action.");
        return;
      }
      actionsConfig = [{ type: actionType, switchId: targetSwitchId }];
    } else if (actionType === "device_state") {
      if (!targetDeviceId || !targetDeviceState.trim()) {
        toast.error("Select a target device and state for the action.");
        return;
      }
      actionsConfig = [
        {
          type: "device_state",
          deviceId: targetDeviceId,
          targetState: targetDeviceState.trim(),
        },
      ];
    } else {
      if (sceneTargets.length === 0) {
        toast.error("Add at least one switch or device target to your scene.");
        return;
      }
      actionsConfig = [
        {
          type: "scene",
          sceneName: sceneName.trim() || name.trim(),
          targets: sceneTargets,
        },
      ];
    }

    if (savingRef.current) return;
    savingRef.current = true;
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        folderName: folderName.trim() || "General",
        executionMode,
        triggerConfig,
        actionsConfig,
      };

      if (editingRuleId) {
        await apiFetch(`/api/automations/${editingRuleId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        toast.success(`Updated automation "${name.trim()}".`);
      } else {
        await apiFetch("/api/automations", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        toast.success(`Automation "${name.trim()}" created.`);
      }
      setModalOpen(false);
      await load(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save automation.");
    } finally {
      savingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleToggle(rule: AutomationItem, enabled: boolean) {
    setBusyId(rule.id);
    try {
      await apiFetch(`/api/automations/${rule.id}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
      toast.success(enabled ? `Enabled "${rule.name}".` : `Paused "${rule.name}".`);
      await load(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Update failed.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRun(rule: AutomationItem) {
    setBusyId(rule.id);
    try {
      const res = await apiFetch<{ executedCount?: number; errors?: string[] }>(
        `/api/automations/${rule.id}/run`,
        { method: "POST" }
      );
      if (res.errors && res.errors.length > 0) {
        toast.error(`Executed with warning: ${res.errors.join("; ")}`);
      } else {
        const count = res.executedCount ?? rule.actions_config.length;
        toast.success(
          `Executed "${rule.name}" (${count} action${count === 1 ? "" : "s"}).`
        );
      }
      await load(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Run failed.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDryRunTest(rule: AutomationItem) {
    setTestingId(rule.id);
    try {
      const res = await apiFetch<{
        conditionsMatched: boolean;
        triggerPreview?: Array<{ summary: string }>;
        plannedActions?: Array<{ summary?: string; detail?: string; targetName?: string }>;
      }>(`/api/automations/${rule.id}/test`, {
        method: "POST",
        body: JSON.stringify({ dryRun: true }),
      });
      const planned = (res.plannedActions ?? []).map((a) => ({
        summary: a.summary ?? a.detail ?? a.targetName ?? "Planned action",
      }));
      const triggerSummaries = (res.triggerPreview ?? []).map((t) => t.summary);
      setLastDryRunByRule((prev) => ({
        ...prev,
        [rule.id]: {
          conditionsMatched: Boolean(res.conditionsMatched),
          triggerSummaries,
          plannedActions: planned,
        },
      }));
      toast.success(
        `Dry-run test for "${rule.name}": ${
          res.conditionsMatched ? "Conditions PASSED" : "Conditions NOT MET"
        } · ${planned.map((a) => a.summary).join(", ") || "No actions"}`
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Dry-run test failed.");
    } finally {
      setTestingId(null);
    }
  }

  async function handleCheckSchedulesNow() {
    setCheckingSchedules(true);
    try {
      const res = await apiFetch<{ checked: number; triggered: number }>(
        "/api/automations/evaluate-schedules",
        { method: "POST", body: JSON.stringify({}) }
      );
      toast.success(
        `Evaluated ${res.checked} scheduled rule(s); ${res.triggered} triggered for ${effectiveTimezone}.`
      );
      await load(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Schedule evaluation failed.");
    } finally {
      setCheckingSchedules(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      await apiFetch(`/api/automations/${deleteTarget.id}`, { method: "DELETE" });
      toast.success(`Deleted automation "${deleteTarget.name}".`);
      if (builderRule?.id === deleteTarget.id) {
        setBuilderRule(null);
      }
      setDeleteTarget(null);
      await load(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed.");
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  const foldersList = useMemo(() => {
    const set = new Set<string>(["General"]);
    for (const r of rules) {
      if (r.folder_name) set.add(r.folder_name);
    }
    return Array.from(set).sort();
  }, [rules]);

  const rulesByFolder = useMemo(() => {
    const q = flowFilter.trim().toLowerCase();
    const map = new Map<string, AutomationItem[]>();
    for (const r of rules) {
      if (q && !r.name.toLowerCase().includes(q) && !(r.folder_name ?? "").toLowerCase().includes(q)) {
        continue;
      }
      const folder = r.folder_name || "General";
      const arr = map.get(folder) ?? [];
      arr.push(r);
      map.set(folder, arr);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rules, flowFilter]);

  const filteredRules = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rules.filter((r) => {
      if (folderFilter !== "all" && (r.folder_name || "General") !== folderFilter) {
        return false;
      }
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        (r.folder_name || "").toLowerCase().includes(q) ||
        describeTrigger(r.trigger_config, sensors, switches, devices)
          .toLowerCase()
          .includes(q) ||
        describeActions(r.actions_config, switches, devices)
          .toLowerCase()
          .includes(q)
      );
    });
  }, [rules, folderFilter, search, sensors, switches, devices]);

  const hasScheduledRules = useMemo(
    () =>
      rules.some((r) =>
        normalizeTriggerList(r.trigger_config).some(
          (t) => t.type === "time" || t.type === "sun_event"
        )
      ),
    [rules]
  );

  const conditionCards: Array<{
    kind: ConditionKind;
    title: string;
    description: string;
    available: boolean;
  }> = [
    {
      kind: "schedule",
      title: "Schedule",
      description: "Automation will start at a specific time of day",
      available: true,
    },
    {
      kind: "device_state",
      title: "Device State",
      description: hasDeviceOrSwitch
        ? "Trigger automation by a certain state of the device."
        : "Trigger automation by a certain state of the device. Add a device to use this trigger.",
      available: hasDeviceOrSwitch,
    },
    {
      kind: "sun_event",
      title: "Sunset/Sunrise",
      description: "Automation will start based on the sun",
      available: true,
    },
    {
      kind: "event",
      title: "Event",
      description: hasSensors
        ? "Trigger automation when a sensor event is logged."
        : "Trigger automation when an event is logged. Add a device to use this trigger.",
      available: hasSensors,
    },
    {
      kind: "scene",
      title: "Scene",
      description: "Trigger automation manually",
      available: true,
    },
  ];

  if (loading && rules.length === 0 && switches.length === 0) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeroHeader
        tone="pink"
        ariaLabel="Automation Header"
        title="Automation"
        subtitle={
          <>
            Build{" "}
            <span className="font-medium text-foreground/85">
              Schedules, Device Triggers, Scenes, &amp; Visual Flows
            </span>{" "}
            <br className="hidden sm:inline" />
            with{" "}
            <span className="font-semibold text-pink-700 dark:text-pink-400">
              Cloud &amp; Hybrid Edge Rules
            </span>
          </>
        }
        leftIcons={AUTOMATIONS_HERO_ICONS.left}
        rightIcons={AUTOMATIONS_HERO_ICONS.right}
        searchValue={search}
        onSearchChange={(next) => {
          setSearch(next);
          if (next && activeTab !== "rules") {
            setActiveTab("rules");
          }
        }}
        searchAriaLabel="Search automations"
        searchPlaceholder="Search automation rules, folders, or modes..."
        actions={
          canManage ? (
            <>
              <Button variant="outline" size="sm" onClick={() => openVisualFlow(null)}>
                <RiGitBranchLine className="size-4" aria-hidden="true" />
                New Visual Flow
              </Button>
              <Button
                size="sm"
                onClick={() => openConditionBuilder(hasDeviceOrSwitch ? "device_state" : "schedule")}
              >
                <RiAddLine className="size-4" aria-hidden="true" />
                Create Rule
              </Button>
            </>
          ) : undefined
        }
      />

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "rules" | "builder")}
        className="space-y-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="rules">
              <RiFlashlightLine className="size-4" aria-hidden="true" />
              Rules ({rules.length})
            </TabsTrigger>
            <TabsTrigger value="builder">
              <RiGitBranchLine className="size-4" aria-hidden="true" />
              Visual Builder
            </TabsTrigger>
          </TabsList>

          {activeTab === "rules" && hasScheduledRules && canOperate && (
            <Button
              size="xs"
              variant="outline"
              disabled={checkingSchedules}
              onClick={() => void handleCheckSchedulesNow()}
            >
              <RiTimeLine className="size-3.5" aria-hidden="true" />
              {checkingSchedules ? "Checking..." : "Check Schedules Now"}
            </Button>
          )}
        </div>

        <TabsContent value="rules" className="space-y-7 pt-1">
          {/* Clean "Create automations — Choose Condition" section */}
          {canManage && (
            <section
              aria-label="Create automations"
              className="rounded-2xl border border-border/75 bg-card p-6 sm:p-8 shadow-xs"
            >
              <div className="mx-auto max-w-3xl">
                <h2 className="text-xl font-semibold tracking-tight text-foreground">
                  Create automations
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Automations let you set up actions that start when a certain trigger happens.
                </p>

                <h3 className="mt-6 mb-3.5 text-sm font-medium text-foreground">
                  Choose Condition
                </h3>

                <div
                  className="grid grid-cols-1 gap-3.5 sm:grid-cols-2"
                  data-testid="automation-condition-grid"
                >
                  {conditionCards.map((card) => (
                    <button
                      key={card.kind}
                      type="button"
                      disabled={!card.available}
                      aria-disabled={!card.available}
                      onClick={() => openConditionBuilder(card.kind)}
                      className={cn(
                        "group flex min-h-[120px] items-start gap-4 rounded-xl border px-5 py-5 text-left transition-all",
                        card.available
                          ? "cursor-pointer border-border/80 bg-card hover:border-emerald-600/50 hover:bg-emerald-50/30 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/40 dark:hover:bg-emerald-950/20"
                          : "cursor-not-allowed border-border/60 bg-muted/45 opacity-80"
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 shrink-0 transition-transform",
                          card.available
                            ? "text-emerald-700 group-hover:scale-105 dark:text-emerald-400"
                            : "text-emerald-700/65 dark:text-emerald-400/60"
                        )}
                      >
                        <ConditionIcon kind={card.kind} className="size-6" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[15px] font-semibold leading-snug text-foreground">
                          {card.title}
                        </span>
                        <span className="mt-1.5 block text-[13px] leading-relaxed text-muted-foreground">
                          {card.description}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* Active & Saved Automations list */}
          {rules.length > 0 && (
            <section aria-label="Saved automations" className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold tracking-tight text-foreground">
                    Your Automations
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Manage, test, run, or open any rule in the Visual Builder.
                  </p>
                </div>

                {foldersList.length > 1 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <Button
                      size="xs"
                      variant={folderFilter === "all" ? "secondary" : "ghost"}
                      onClick={() => setFolderFilter("all")}
                    >
                      All Folders ({rules.length})
                    </Button>
                    {foldersList.map((folder) => {
                      const count = rules.filter(
                        (r) => (r.folder_name || "General") === folder
                      ).length;
                      return (
                        <Button
                          key={folder}
                          size="xs"
                          variant={folderFilter === folder ? "secondary" : "ghost"}
                          onClick={() => setFolderFilter(folder)}
                        >
                          <RiFolderLine className="size-3.5" aria-hidden="true" />
                          {folder} ({count})
                        </Button>
                      );
                    })}
                  </div>
                )}
              </div>

              {filteredRules.length === 0 ? (
                <Card className="p-8 text-center">
                  <p className="text-sm font-medium text-foreground">
                    No automations match &ldquo;{search}&rdquo;
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Try clearing your search filter or picking another folder.
                  </p>
                  <div className="mt-3">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        setSearch("");
                        setFolderFilter("all");
                      }}
                    >
                      Clear Filters
                    </Button>
                  </div>
                </Card>
              ) : (
                <div className="space-y-3">
                  {filteredRules.map((rule) => {
                    const kind = ruleConditionKind(rule);
                    const dryRun = lastDryRunByRule[rule.id];
                    const hasFlow = Boolean(rule.flow_graph?.nodes?.length);
                    return (
                      <Card
                        key={rule.id}
                        className="rounded-xl border-border/80 p-4 transition-colors hover:border-border"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="flex min-w-0 items-start gap-3.5">
                            <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                              <ConditionIcon kind={kind} className="size-5" />
                            </div>
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-semibold text-foreground">
                                  {rule.name}
                                </span>
                                <Badge variant="secondary" size="xs" radius="full">
                                  {CONDITION_META[kind].badge}
                                </Badge>
                                <Badge
                                  variant={rule.enabled ? "success-light" : "outline"}
                                  size="xs"
                                  radius="full"
                                >
                                  {rule.enabled ? "Active" : "Paused"}
                                </Badge>
                                {rule.folder_name && rule.folder_name !== "General" && (
                                  <Badge variant="outline" size="xs">
                                    <RiFolderLine className="mr-1 size-3" />
                                    {rule.folder_name}
                                  </Badge>
                                )}
                                {hasFlow && (
                                  <Badge variant="info-light" size="xs">
                                    <RiGitBranchLine className="mr-1 size-3" />
                                    Flow
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground">
                                <span className="font-medium text-foreground">When:</span>{" "}
                                {describeTrigger(
                                  rule.trigger_config,
                                  sensors,
                                  switches,
                                  devices
                                )}
                                <span className="mx-1.5 text-muted-foreground/60">→</span>
                                <span className="font-medium text-foreground">Then:</span>{" "}
                                {describeActions(rule.actions_config, switches, devices)}
                              </p>
                              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                                <span>
                                  {rule.last_executed_at
                                    ? `Last run ${formatTimestamp(rule.last_executed_at, effectiveTimezone)}`
                                    : "Never executed yet"}
                                </span>
                                {rule.last_execution_status && (
                                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                                    {rule.last_execution_status}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
                            {canManage && (
                              <div className="mr-1 flex items-center gap-1.5">
                                <Switch
                                  checked={rule.enabled}
                                  disabled={busyId === rule.id}
                                  aria-label={`Toggle ${rule.name}`}
                                  onCheckedChange={(v) => void handleToggle(rule, v)}
                                />
                              </div>
                            )}
                            {canOperate && (
                              <>
                                <Button
                                  size="xs"
                                  variant="outline"
                                  disabled={testingId === rule.id}
                                  onClick={() => void handleDryRunTest(rule)}
                                >
                                  <RiFlaskLine className="size-3.5" aria-hidden="true" />
                                  {testingId === rule.id ? "Testing..." : "Test"}
                                </Button>
                                <Button
                                  size="xs"
                                  variant={kind === "scene" ? "default" : "outline"}
                                  disabled={busyId === rule.id}
                                  onClick={() => void handleRun(rule)}
                                >
                                  <RiPlayLine className="size-3.5" aria-hidden="true" />
                                  Run Now
                                </Button>
                              </>
                            )}
                            {canManage && (
                              <>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => openEditModal(rule)}
                                >
                                  <RiEditLine className="size-3.5" aria-hidden="true" />
                                  Edit
                                </Button>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => openVisualFlow(rule)}
                                >
                                  <RiGitBranchLine className="size-3.5" aria-hidden="true" />
                                  Flow
                                </Button>
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  aria-label={`Delete ${rule.name}`}
                                  onClick={() => setDeleteTarget(rule)}
                                >
                                  <RiDeleteBinLine
                                    className="size-3.5 text-destructive"
                                    aria-hidden="true"
                                  />
                                </Button>
                              </>
                            )}
                          </div>
                        </div>

                        {dryRun && (
                          <div className="mt-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge
                                variant={
                                  dryRun.conditionsMatched ? "success-light" : "warning-light"
                                }
                                size="xs"
                              >
                                Dry-Run: {dryRun.conditionsMatched ? "Would Execute" : "Blocked"}
                              </Badge>
                              {dryRun.triggerSummaries.length > 0 && (
                                <span className="text-muted-foreground">
                                  {dryRun.triggerSummaries.join(" · ")}
                                </span>
                              )}
                            </div>
                            {dryRun.plannedActions.length > 0 && (
                              <div className="mt-1 text-[11px] text-muted-foreground">
                                Planned actions:{" "}
                                {dryRun.plannedActions.map((a) => a.summary).join(", ")}
                              </div>
                            )}
                          </div>
                        )}
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </TabsContent>

        <TabsContent value="builder" className="pt-2">
          <VisualAutomationBuilder
            key={`${builderRule?.id ?? "new"}-${builderKey}`}
            initialRule={builderRule}
            sensors={sensors}
            switches={switches}
            devices={devices}
            rooms={rooms}
            controllers={controllers}
            existingFolders={foldersList}
            timezone={effectiveTimezone}
            canManage={canManage}
            canOperate={canOperate}
            flowsMenuSlot={
              <Popover open={flowsMenuOpen} onOpenChange={setFlowsMenuOpen}>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" size="xs" className="h-8 gap-1.5">
                    <RiFolderLine className="size-3.5 text-primary/80" />
                    <span>Flows ({rules.length})</span>
                    <RiArrowDownSLine className="size-3.5 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-2.5 space-y-2.5">
                  <div className="relative">
                    <RiSearchLine
                      className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      value={flowFilter}
                      onChange={(e) => setFlowFilter(e.target.value)}
                      placeholder="Filter flows..."
                      className="h-7.5 pl-8 text-xs"
                    />
                  </div>

                  <div className="space-y-1 max-h-64 overflow-y-auto pr-0.5">
                    {rulesByFolder.length === 0 ? (
                      <p className="py-3 text-center text-xs text-muted-foreground">
                        No saved flows yet.
                      </p>
                    ) : (
                      rulesByFolder.map(([folder, items]) => {
                        const collapsed = Boolean(collapsedFolders[folder]);
                        return (
                          <div key={folder} className="space-y-0.5">
                            <button
                              type="button"
                              onClick={() =>
                                setCollapsedFolders((prev) => ({
                                  ...prev,
                                  [folder]: !prev[folder],
                                }))
                              }
                              className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] font-semibold text-foreground hover:bg-muted/60"
                            >
                              {collapsed ? (
                                <RiArrowRightSLine className="size-3 text-muted-foreground" />
                              ) : (
                                <RiArrowDownSLine className="size-3 text-muted-foreground" />
                              )}
                              <RiFolderLine className="size-3 text-primary/80" />
                              <span className="truncate flex-1">{folder}</span>
                              <span className="text-[10px] text-muted-foreground">
                                {items.length}
                              </span>
                            </button>

                            {!collapsed && (
                              <div className="ml-3.5 space-y-0.5 border-l border-border pl-2">
                                {items.map((item) => {
                                  const active = builderRule?.id === item.id;
                                  return (
                                    <button
                                      key={item.id}
                                      type="button"
                                      onClick={() => {
                                        openVisualFlow(item);
                                        setFlowsMenuOpen(false);
                                      }}
                                      className={cn(
                                        "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs transition-colors",
                                        active
                                          ? "bg-primary/12 font-semibold text-primary"
                                          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                                      )}
                                    >
                                      <span className="truncate">{item.name}</span>
                                      {!item.enabled && (
                                        <span className="text-[9px] uppercase opacity-70">
                                          Off
                                        </span>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>

                  {canManage && (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="w-full"
                      onClick={() => {
                        openVisualFlow(null);
                        setFlowsMenuOpen(false);
                      }}
                    >
                      <RiAddLine className="size-3.5" />
                      New Blank Flow
                    </Button>
                  )}
                </PopoverContent>
              </Popover>
            }
            onCancelEdit={() => {
              setBuilderRule(null);
              setBuilderKey((k) => k + 1);
            }}
            onSaved={async (msg) => {
              toast.success(msg);
              setBuilderRule(null);
              setBuilderKey((k) => k + 1);
              setActiveTab("rules");
              await load(true);
            }}
          />
        </TabsContent>
      </Tabs>

      {/* Interactive Create / Edit Automation Dialog */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <div className="flex items-center gap-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                <ConditionIcon kind={conditionKind} className="size-5" />
              </span>
              <div>
                <DialogTitle>
                  {editingRuleId
                    ? `Edit ${CONDITION_META[conditionKind].title} Automation`
                    : `New ${CONDITION_META[conditionKind].title} Automation`}
                </DialogTitle>
                <DialogDescription>{CONDITION_META[conditionKind].helper}</DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Quick condition switcher */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Condition Type</Label>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
                {conditionCards.map((c) => {
                  const active = c.kind === conditionKind;
                  return (
                    <button
                      key={c.kind}
                      type="button"
                      disabled={!c.available}
                      onClick={() => {
                        setConditionKind(c.kind);
                        if (c.kind === "scene" && hasActionableHardware) {
                          setActionType("scene");
                          if (sceneTargets.length === 0) {
                            setSceneTargets(buildDefaultSceneTargets());
                          }
                        }
                      }}
                      className={cn(
                        "flex flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2 text-[11px] font-medium transition-colors",
                        active
                          ? "border-emerald-600/60 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
                          : c.available
                            ? "cursor-pointer border-border bg-card text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground"
                            : "cursor-not-allowed border-border/50 bg-muted/40 text-muted-foreground/50"
                      )}
                    >
                      <ConditionIcon kind={c.kind} className="size-4" />
                      <span className="truncate">{c.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Name & Folder */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <FormField id="auto-name" label="Automation Name">
                  <Input
                    id="auto-name"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={CONDITION_META[conditionKind].placeholder}
                  />
                </FormField>
              </div>
              <FormField id="auto-folder" label="Folder">
                <Input
                  id="auto-folder"
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  placeholder="General"
                />
              </FormField>
            </div>

            {/* WHEN — Condition Configuration */}
            <div className="space-y-3 rounded-xl border border-border/80 bg-muted/20 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                  When · {CONDITION_META[conditionKind].title}
                </span>
                {(conditionKind === "schedule" || conditionKind === "sun_event") && (
                  <Badge variant="outline" size="xs">
                    {effectiveTimezone}
                  </Badge>
                )}
              </div>

              {conditionKind === "schedule" && (
                <div className="space-y-3">
                  <FormField id="auto-time" label="Time of Day (24-hour)">
                    <Input
                      id="auto-time"
                      type="time"
                      value={cronTime}
                      onChange={(e) => setCronTime(e.target.value)}
                      className="max-w-[180px] font-mono"
                    />
                  </FormField>

                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Label className="text-xs">Repeat Days</Label>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="xs"
                          variant={selectedDays.length === 0 ? "secondary" : "ghost"}
                          onClick={() => setSelectedDays([])}
                        >
                          Every day
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant={
                            selectedDays.length === 5 &&
                            ["mon", "tue", "wed", "thu", "fri"].every((d) =>
                              selectedDays.includes(d)
                            )
                              ? "secondary"
                              : "ghost"
                          }
                          onClick={() => setSelectedDays(["mon", "tue", "wed", "thu", "fri"])}
                        >
                          Weekdays
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant={
                            selectedDays.length === 2 &&
                            selectedDays.includes("sat") &&
                            selectedDays.includes("sun")
                              ? "secondary"
                              : "ghost"
                          }
                          onClick={() => setSelectedDays(["sat", "sun"])}
                        >
                          Weekends
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {WEEKDAYS.map((day) => {
                        const active = selectedDays.includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            onClick={() => toggleWeekday(day)}
                            className={cn(
                              "h-8 min-w-[44px] cursor-pointer rounded-lg border px-2 text-xs font-medium transition-colors",
                              active
                                ? "border-emerald-600 bg-emerald-600 text-white"
                                : "border-border bg-card text-muted-foreground hover:border-emerald-500/40 hover:text-foreground"
                            )}
                          >
                            {WEEKDAY_LABELS[day]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {conditionKind === "device_state" && (
                <div className="space-y-3">
                  {switches.length > 0 && devices.length > 0 && (
                    <div className="inline-flex rounded-lg border border-border bg-card p-0.5 text-xs">
                      <button
                        type="button"
                        onClick={() => setDeviceStateSource("switch")}
                        className={cn(
                          "cursor-pointer rounded-md px-3 py-1 font-medium transition-colors",
                          deviceStateSource === "switch"
                            ? "bg-emerald-600 text-white"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        Switch
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeviceStateSource("device")}
                        className={cn(
                          "cursor-pointer rounded-md px-3 py-1 font-medium transition-colors",
                          deviceStateSource === "device"
                            ? "bg-emerald-600 text-white"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        Device
                      </button>
                    </div>
                  )}

                  {deviceStateSource === "switch" && switches.length > 0 ? (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <FormField id="auto-trig-sw" label="Switch">
                        <Select value={triggerSwitchId} onValueChange={setTriggerSwitchId}>
                          <SelectTrigger id="auto-trig-sw" aria-label="Trigger Switch">
                            <SelectValue placeholder="Choose switch" />
                          </SelectTrigger>
                          <SelectContent>
                            {switches.map((sw) => (
                              <SelectItem key={sw.id} value={sw.id}>
                                {sw.name} (GPIO {sw.gpio_pin})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormField>

                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">When Switch Becomes</Label>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setTriggerSwitchState("on")}
                            className={cn(
                              "flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors",
                              triggerSwitchState === "on"
                                ? "border-emerald-600 bg-emerald-600 text-white"
                                : "border-border bg-card text-foreground hover:bg-muted"
                            )}
                          >
                            {triggerSwitchState === "on" && <RiCheckLine className="size-3.5" />}
                            Turned ON
                          </button>
                          <button
                            type="button"
                            onClick={() => setTriggerSwitchState("off")}
                            className={cn(
                              "flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors",
                              triggerSwitchState === "off"
                                ? "border-emerald-600 bg-emerald-600 text-white"
                                : "border-border bg-card text-foreground hover:bg-muted"
                            )}
                          >
                            {triggerSwitchState === "off" && <RiCheckLine className="size-3.5" />}
                            Turned OFF
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <FormField id="auto-trig-dev" label="Device">
                        <Select value={triggerDeviceId} onValueChange={setTriggerDeviceId}>
                          <SelectTrigger id="auto-trig-dev" aria-label="Trigger Device">
                            <SelectValue placeholder="Choose device" />
                          </SelectTrigger>
                          <SelectContent>
                            {devices.map((d) => (
                              <SelectItem key={d.id} value={d.id}>
                                {d.name} ({d.device_type})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormField>
                      <FormField id="auto-trig-dev-state" label="When State Equals">
                        <div className="space-y-1.5">
                          <Input
                            id="auto-trig-dev-state"
                            value={triggerDeviceState}
                            onChange={(e) => setTriggerDeviceState(e.target.value)}
                            placeholder="active / inactive / on / off"
                          />
                          <div className="flex flex-wrap gap-1">
                            {["active", "inactive", "on", "off"].map((preset) => (
                              <button
                                key={preset}
                                type="button"
                                onClick={() => setTriggerDeviceState(preset)}
                                className={cn(
                                  "cursor-pointer rounded-md border px-2 py-0.5 text-[11px] transition-colors",
                                  triggerDeviceState === preset
                                    ? "border-emerald-600 bg-emerald-600 text-white"
                                    : "border-border bg-card text-muted-foreground hover:text-foreground"
                                )}
                              >
                                {preset}
                              </button>
                            ))}
                          </div>
                        </div>
                      </FormField>
                    </div>
                  )}
                </div>
              )}

              {conditionKind === "sun_event" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2.5">
                    {(["sunrise", "sunset"] as const).map((ev) => {
                      const active = sunEvent === ev;
                      return (
                        <button
                          key={ev}
                          type="button"
                          onClick={() => setSunEvent(ev)}
                          className={cn(
                            "flex cursor-pointer items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition-colors",
                            active
                              ? "border-emerald-600 bg-emerald-500/10 text-foreground"
                              : "border-border bg-card text-muted-foreground hover:border-emerald-500/40"
                          )}
                        >
                          <div>
                            <div className="text-sm font-semibold capitalize text-foreground">
                              {ev}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {ev === "sunrise" ? "Start at dawn" : "Start at dusk"}
                            </div>
                          </div>
                          <ConditionIcon
                            kind="sun_event"
                            className={cn(
                              "size-5",
                              active
                                ? "text-emerald-700 dark:text-emerald-400"
                                : "text-muted-foreground"
                            )}
                          />
                        </button>
                      );
                    })}
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="auto-sun-offset" className="text-xs">
                        Offset (minutes)
                      </Label>
                      <span className="font-mono text-xs text-emerald-700 dark:text-emerald-400">
                        Today ≈ {computedSunPreview}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {SUN_OFFSETS.map((item) => (
                        <button
                          key={item.value}
                          type="button"
                          onClick={() => setSunOffset(item.value)}
                          className={cn(
                            "h-8 cursor-pointer rounded-lg border px-2.5 text-xs font-medium transition-colors",
                            sunOffset === item.value
                              ? "border-emerald-600 bg-emerald-600 text-white"
                              : "border-border bg-card text-muted-foreground hover:text-foreground"
                          )}
                        >
                          {item.label}
                        </button>
                      ))}
                      <Input
                        id="auto-sun-offset"
                        type="number"
                        min={-180}
                        max={180}
                        value={sunOffset}
                        onChange={(e) => setSunOffset(Number(e.target.value) || 0)}
                        className="h-8 w-24 font-mono text-xs"
                        aria-label="Custom sun offset minutes"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Active Days (optional — empty means every day)</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {WEEKDAYS.map((day) => {
                        const active = selectedDays.includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            onClick={() => toggleWeekday(day)}
                            className={cn(
                              "h-7 min-w-[40px] cursor-pointer rounded-md border px-2 text-xs font-medium transition-colors",
                              active
                                ? "border-emerald-600 bg-emerald-600 text-white"
                                : "border-border bg-card text-muted-foreground hover:text-foreground"
                            )}
                          >
                            {WEEKDAY_LABELS[day]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {conditionKind === "event" && (
                <div className="space-y-3">
                  <FormField id="auto-sensor" label="Sensor Event Source">
                    <Select value={sensorId} onValueChange={setSensorId}>
                      <SelectTrigger id="auto-sensor" aria-label="Trigger Sensor">
                        <SelectValue placeholder="Choose sensor" />
                      </SelectTrigger>
                      <SelectContent>
                        {sensors.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name} ({s.unit}
                            {typeof s.last_value === "number" ? ` · now ${s.last_value}` : ""})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">Condition</Label>
                      <div className="grid grid-cols-6 gap-1">
                        {OPERATORS.map((op) => (
                          <button
                            key={op.value}
                            type="button"
                            title={op.label}
                            aria-label={op.label}
                            onClick={() => setOperator(op.value)}
                            className={cn(
                              "h-9 cursor-pointer rounded-lg border font-mono text-sm font-semibold transition-colors",
                              operator === op.value
                                ? "border-emerald-600 bg-emerald-600 text-white"
                                : "border-border bg-card text-foreground hover:bg-muted"
                            )}
                          >
                            {op.symbol}
                          </button>
                        ))}
                      </div>
                    </div>

                    <FormField
                      id="auto-thresh"
                      label={`Threshold${sensors.find((s) => s.id === sensorId)?.unit ? ` (${sensors.find((s) => s.id === sensorId)!.unit})` : ""}`}
                    >
                      <Input
                        id="auto-thresh"
                        type="number"
                        step="0.1"
                        value={thresholdText}
                        onChange={(e) => setThresholdText(e.target.value)}
                      />
                    </FormField>
                  </div>
                </div>
              )}

              {conditionKind === "scene" && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  This automation runs manually whenever you click <strong>Run Now</strong>. Configure one or more switch or device actions below to trigger together in a single tap.
                </p>
              )}
            </div>

            {/* THEN — Action Configuration */}
            <div className="space-y-3 rounded-xl border border-border/80 bg-muted/20 p-4">
              <span className="block text-xs font-semibold uppercase tracking-wider text-foreground">
                Then · Action
              </span>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormField id="auto-act" label="Action Type">
                  <Select
                    value={actionType}
                    onValueChange={(v) => {
                      const next = v as ActionFormType;
                      setActionType(next);
                      if (next === "scene" && sceneTargets.length === 0) {
                        setSceneTargets(buildDefaultSceneTargets());
                      }
                    }}
                  >
                    <SelectTrigger id="auto-act" aria-label="Action Type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="switch_on">Turn Switch ON</SelectItem>
                      <SelectItem value="switch_off">Turn Switch OFF</SelectItem>
                      <SelectItem value="device_state">Set Device State</SelectItem>
                      <SelectItem value="scene">Multi-Device Scene</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>

                {(actionType === "switch_on" || actionType === "switch_off") && (
                  <FormField id="auto-target-sw" label="Target Switch">
                    <Select value={targetSwitchId} onValueChange={setTargetSwitchId}>
                      <SelectTrigger id="auto-target-sw" aria-label="Target Switch">
                        <SelectValue placeholder="Choose switch" />
                      </SelectTrigger>
                      <SelectContent>
                        {switches.map((sw) => (
                          <SelectItem key={sw.id} value={sw.id}>
                            {sw.name} (GPIO {sw.gpio_pin})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                )}

                {actionType === "device_state" && (
                  <FormField id="auto-target-dev" label="Target Device">
                    <Select value={targetDeviceId} onValueChange={setTargetDeviceId}>
                      <SelectTrigger id="auto-target-dev" aria-label="Target Device">
                        <SelectValue placeholder="Choose device" />
                      </SelectTrigger>
                      <SelectContent>
                        {devices.map((d) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.name} ({d.device_type})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                )}

                {actionType === "scene" && (
                  <FormField id="auto-scene-name" label="Scene Label">
                    <Input
                      id="auto-scene-name"
                      value={sceneName}
                      onChange={(e) => setSceneName(e.target.value)}
                      placeholder={name || "Movie Night"}
                    />
                  </FormField>
                )}
              </div>

              {actionType === "device_state" && (
                <FormField id="auto-target-dev-state" label="Target State">
                  <Input
                    id="auto-target-dev-state"
                    value={targetDeviceState}
                    onChange={(e) => setTargetDeviceState(e.target.value)}
                    placeholder="active / inactive / on / off"
                  />
                </FormField>
              )}

              {actionType === "scene" && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label className="text-xs">Scene Targets ({sceneTargets.length})</Label>
                    <div className="flex items-center gap-1.5">
                      {switches.length > 0 && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => addSceneTarget("switch")}
                        >
                          <RiAddLine className="size-3.5" />
                          Add Switch
                        </Button>
                      )}
                      {devices.length > 0 && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => addSceneTarget("device")}
                        >
                          <RiAddLine className="size-3.5" />
                          Add Device
                        </Button>
                      )}
                    </div>
                  </div>

                  {sceneTargets.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                      Add switches or devices to include in this scene.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {sceneTargets.map((target, index) => (
                        <div
                          key={`${target.kind}-${index}`}
                          className="flex items-center gap-2 rounded-lg border border-border bg-card p-2"
                        >
                          {target.kind === "switch" ? (
                            <>
                              <Select
                                value={target.switchId}
                                onValueChange={(nextId) =>
                                  setSceneTargets((prev) =>
                                    prev.map((item, idx) =>
                                      idx === index
                                        ? { kind: "switch", switchId: nextId, isOn: target.isOn }
                                        : item
                                    )
                                  )
                                }
                              >
                                <SelectTrigger className="h-8 flex-1 text-xs">
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
                              <Button
                                type="button"
                                size="xs"
                                variant={target.isOn ? "default" : "outline"}
                                onClick={() =>
                                  setSceneTargets((prev) =>
                                    prev.map((item, idx) =>
                                      idx === index && item.kind === "switch"
                                        ? { ...item, isOn: !item.isOn }
                                        : item
                                    )
                                  )
                                }
                              >
                                {target.isOn ? "ON" : "OFF"}
                              </Button>
                            </>
                          ) : (
                            <>
                              <Select
                                value={target.deviceId}
                                onValueChange={(nextId) =>
                                  setSceneTargets((prev) =>
                                    prev.map((item, idx) =>
                                      idx === index
                                        ? {
                                            kind: "device",
                                            deviceId: nextId,
                                            targetState: target.targetState,
                                          }
                                        : item
                                    )
                                  )
                                }
                              >
                                <SelectTrigger className="h-8 flex-1 text-xs">
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
                              <Input
                                value={target.targetState}
                                onChange={(e) =>
                                  setSceneTargets((prev) =>
                                    prev.map((item, idx) =>
                                      idx === index && item.kind === "device"
                                        ? { ...item, targetState: e.target.value }
                                        : item
                                    )
                                  )
                                }
                                className="h-8 w-24 text-xs"
                                placeholder="active"
                              />
                            </>
                          )}
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-label="Remove target"
                            onClick={() =>
                              setSceneTargets((prev) => prev.filter((_, idx) => idx !== index))
                            }
                          >
                            <RiCloseLine className="size-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Live plain-English summary preview */}
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-3.5 py-2.5 text-xs">
              <span className="font-semibold text-emerald-700 dark:text-emerald-400">Summary: </span>
              <span className="text-foreground">{draftPreview.whenText}</span>
              <span className="mx-1.5 text-muted-foreground">→</span>
              <span className="font-medium text-foreground">{draftPreview.thenText}</span>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Label htmlFor="auto-mode" className="text-xs text-muted-foreground">
                  Execution
                </Label>
                <Select
                  value={executionMode}
                  onValueChange={(v) => setExecutionMode(v as "cloud" | "controller" | "hybrid")}
                >
                  <SelectTrigger id="auto-mode" className="h-8 w-36 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cloud">Cloud Engine</SelectItem>
                    <SelectItem value="controller">Local Controller</SelectItem>
                    <SelectItem value="hybrid">Hybrid</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <DialogFooter className="gap-2 sm:gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setModalOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting
                    ? "Saving..."
                    : editingRuleId
                      ? "Save Changes"
                      : "Save Automation Rule"}
                </Button>
              </DialogFooter>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={`Delete automation "${deleteTarget?.name ?? ""}"?`}
        description="This removes the automation rule permanently and stops future executions."
        confirmLabel="Delete Rule"
        busy={deleting}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
