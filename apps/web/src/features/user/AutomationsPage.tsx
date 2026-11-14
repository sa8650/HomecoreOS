import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  normalizeConditionGroups,
  normalizeTriggerList,
  type FlowActionNodeConfig,
} from "@homecoreos/shared";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
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
import { cn } from "@/lib/utils";
import { apiFetch, ApiError, cachedGet, getCachedSnapshot } from "@/lib/api";
import { formatTimestamp, useEffectiveTimezone } from "@/lib/timezone";
import { VisualAutomationBuilder } from "@/components/automations/VisualAutomationBuilder";
import { Badge } from "@/components/reui/badge";
import { IconTile } from "@/components/reui/icon-tile";
import {
  ConfirmDeleteDialog,
  EmptyStatePanel,
  FormField,
  StatusAlert,
} from "@/components/shared/AppUi";
import { AUTOMATIONS_HERO_ICONS } from "@/components/shared/HeroDomainIcons";
import { PageHeroHeader } from "@/components/shared/PageHeroHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  AutomationItem,
  ControllerItem,
  DeviceItem,
  RoomItem,
  SensorItem,
  SwitchItem,
} from "@/features/types";

type UiTriggerKind = "sensor_value" | "switch_state" | "device_state" | "time";

const WEEKDAYS = [
  { id: "mon", label: "Mon" },
  { id: "tue", label: "Tue" },
  { id: "wed", label: "Wed" },
  { id: "thu", label: "Thu" },
  { id: "fri", label: "Fri" },
  { id: "sat", label: "Sat" },
  { id: "sun", label: "Sun" },
];

const OPERATOR_LABELS: Record<string, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  eq: "=",
  neq: "!=",
};

function isComplexRule(rule: AutomationItem): boolean {
  if (rule.flow_graph && Array.isArray(rule.flow_graph.nodes)) {
    const hasAdvanced = rule.flow_graph.nodes.some(
      (n) =>
        n.kind === "delay" ||
        n.kind === "logic" ||
        n.kind === "end" ||
        (n.kind === "action" &&
          ["notification", "http_request", "set_variable"].includes(
            (n.config as FlowActionNodeConfig).actionType
          ))
    );
    if (hasAdvanced || rule.flow_graph.nodes.length > 3) return true;
  }
  const triggers = normalizeTriggerList(rule.trigger_config);
  const condGroups = normalizeConditionGroups(rule.conditions_config);
  const hasComplexTrigger =
    triggers.length > 1 || triggers.some((t) => t.type === "sun_event");
  const hasConditions = condGroups.groups.some((g) => g.conditions.length > 0);
  const hasComplexAction =
    rule.actions_config.length > 1 ||
    rule.actions_config.some((a) => a.type === "scene");
  return hasComplexTrigger || hasConditions || hasComplexAction;
}

function describeRule(
  rule: AutomationItem,
  sensors: SensorItem[],
  switches: SwitchItem[],
  devices: DeviceItem[],
  rooms: RoomItem[],
  fallbackTz: string
): { triggerText: string; conditionText: string | null; actionText: string } {
  const triggers = normalizeTriggerList(rule.trigger_config);
  const triggerParts = triggers.map((trig) => {
    if (trig.type === "sensor_value") {
      const sensor = sensors.find((s) => s.id === trig.sensorId);
      const op = OPERATOR_LABELS[trig.operator ?? "eq"] ?? "=";
      return `When ${sensor?.name ?? "Sensor"} ${op} ${trig.threshold ?? "?"}${
        sensor?.unit ? ` ${sensor.unit}` : ""
      }`;
    }
    if (trig.type === "device_state") {
      if (trig.switchId) {
        const sw = switches.find((s) => s.id === trig.switchId);
        const onOff =
          trig.expectedState === true ||
          String(trig.expectedState).toLowerCase() === "true" ||
          String(trig.expectedState).toLowerCase() === "on"
            ? "ON"
            : "OFF";
        return `When switch "${sw?.name ?? "Switch"}" turns ${onOff}`;
      }
      const dev = devices.find((d) => d.id === trig.deviceId);
      return `When device "${dev?.name ?? "Device"}" becomes "${trig.expectedState ?? ""}"`;
    }
    if (trig.type === "sun_event") {
      const offset = trig.offsetMinutes ?? 0;
      const offsetLabel =
        offset === 0 ? "" : offset > 0 ? ` +${offset}m` : ` ${offset}m`;
      return `At ${trig.sunEvent ?? "sunset"}${offsetLabel} (${trig.timezone ?? fallbackTz})`;
    }
    const dayText =
      trig.days && trig.days.length > 0 && trig.days.length < 7
        ? trig.days.map((d) => d.toUpperCase()).join(", ")
        : "Daily";
    return `${dayText} at ${trig.cronTime ?? "00:00"} (${trig.timezone ?? fallbackTz})`;
  });

  const condConfig = normalizeConditionGroups(rule.conditions_config);
  const condGroupTexts = condConfig.groups
    .filter((g) => g.conditions.length > 0)
    .map((g) => {
      const parts = g.conditions.map((c) => {
        if (c.type === "room_state") {
          const rm = rooms.find((r) => r.id === c.roomId);
          return `Room "${rm?.name ?? "Room"}" ${c.roomMatch ?? "any_on"}`;
        }
        if (c.type === "time_range") {
          return `${c.startTime ?? "00:00"}–${c.endTime ?? "23:59"}`;
        }
        if (c.type === "switch_state") {
          const sw = switches.find((s) => s.id === c.switchId);
          return `${sw?.name ?? "Switch"} is ${c.expectedState ? "ON" : "OFF"}`;
        }
        if (c.type === "device_state") {
          const dev = devices.find((d) => d.id === c.deviceId);
          return `${dev?.name ?? "Device"} = "${c.expectedState ?? ""}"`;
        }
        const sen = sensors.find((s) => s.id === c.sensorId);
        return `${sen?.name ?? "Sensor"} ${OPERATOR_LABELS[c.operator ?? "eq"] ?? "="} ${c.threshold ?? "?"}`;
      });
      return parts.join(` ${g.logic} `);
    });

  const actions = (rule.actions_config ?? []).map((act) => {
    if (act.type === "switch_on" || act.type === "switch_off") {
      const sw = switches.find((s) => s.id === act.switchId);
      return `Turn ${sw?.name ?? "Switch"} ${act.type === "switch_on" ? "ON" : "OFF"}`;
    }
    if (act.type === "scene") {
      const count = act.targets?.length ?? 0;
      return `Run scene "${act.sceneName ?? "Scene"}" (${count} target${count === 1 ? "" : "s"})`;
    }
    const dev = devices.find((d) => d.id === act.deviceId);
    return `Set ${dev?.name ?? "Device"} → "${act.targetState ?? ""}"`;
  });

  if (actions.length === 0 && rule.flow_graph?.nodes?.length) {
    const flowActions = rule.flow_graph.nodes
      .filter((n) => n.kind === "action")
      .map((n) => n.label);
    if (flowActions.length > 0) {
      actions.push(...flowActions);
    }
  }

  return {
    triggerText: triggerParts.join(" OR ") || "Trigger configured",
    conditionText:
      condGroupTexts.length > 0
        ? condGroupTexts.join(` ${condConfig.logic} `)
        : null,
    actionText: actions.join(", ") || "Flow steps configured",
  };
}

export function AutomationsPage({
  canManage,
  canOperate,
}: {
  canManage: boolean;
  canOperate: boolean;
}) {
  const timezone = useEffectiveTimezone();
  const cachedRules = getCachedSnapshot<{ automations: AutomationItem[] }>("/api/automations");
  const [activeTab, setActiveTab] = useState<"rules" | "builder">("rules");
  const [builderRule, setBuilderRule] = useState<AutomationItem | null>(null);
  const [builderKey, setBuilderKey] = useState(0);
  const [search, setSearch] = useState("");
  const [flowFilter, setFlowFilter] = useState("");
  const [flowsMenuOpen, setFlowsMenuOpen] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<string>("__all__");
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});

  const [rules, setRules] = useState<AutomationItem[]>(() => cachedRules?.automations ?? []);
  const [sensors, setSensors] = useState<SensorItem[]>([]);
  const [switches, setSwitches] = useState<SwitchItem[]>([]);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [rooms, setRooms] = useState<RoomItem[]>([]);
  const [controllers, setControllers] = useState<ControllerItem[]>([]);
  const [loading, setLoading] = useState(!cachedRules);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"cloud" | "controller" | "hybrid">("cloud");
  const [triggerKind, setTriggerKind] = useState<UiTriggerKind>("sensor_value");
  const [sensorId, setSensorId] = useState("");
  const [operator, setOperator] = useState<"gt" | "gte" | "lt" | "lte" | "eq" | "neq">("gt");
  const [threshold, setThreshold] = useState(30);
  const [triggerSwitchId, setTriggerSwitchId] = useState("");
  const [triggerSwitchState, setTriggerSwitchState] = useState<"true" | "false">("true");
  const [cronTime, setCronTime] = useState("19:00");
  const [scheduleDays, setScheduleDays] = useState<string[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [expectedState, setExpectedState] = useState("active");

  const [actionType, setActionType] = useState<"switch_on" | "switch_off" | "device_state">(
    "switch_on"
  );
  const [targetSwitchId, setTargetSwitchId] = useState("");
  const [targetDeviceId, setTargetDeviceId] = useState("");
  const [targetState, setTargetState] = useState("active");

  const [deleteTarget, setDeleteTarget] = useState<AutomationItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (force = false) => {
    if (!getCachedSnapshot("/api/automations")) {
      setLoading(true);
    }
    try {
      const [aRes, sRes, swRes, dRes, rRes, cRes] = await Promise.all([
        cachedGet<{ automations: AutomationItem[] }>("/api/automations", {
          ttlMs: 15_000,
          force,
        }),
        cachedGet<{ sensors: SensorItem[] }>("/api/sensors", {
          ttlMs: 15_000,
          force,
        }),
        cachedGet<{ switches: SwitchItem[] }>("/api/switches", {
          ttlMs: 15_000,
          force,
        }),
        cachedGet<{ devices: DeviceItem[] }>("/api/devices", {
          ttlMs: 15_000,
          force,
        }),
        cachedGet<{ rooms?: RoomItem[] }>("/api/homes/rooms", {
          ttlMs: 15_000,
          force,
        }).catch(() => ({ rooms: [] })),
        cachedGet<{ controllers?: ControllerItem[] }>("/api/controllers", {
          ttlMs: 15_000,
          force,
        }).catch(() => ({ controllers: [] })),
      ]);
      setRules(Array.isArray(aRes?.automations) ? aRes.automations : []);
      const safeSensors = Array.isArray(sRes?.sensors) ? sRes.sensors : [];
      const safeSwitches = Array.isArray(swRes?.switches) ? swRes.switches : [];
      const safeDevices = Array.isArray(dRes?.devices) ? dRes.devices : [];
      setSensors(safeSensors);
      setSwitches(safeSwitches);
      setDevices(safeDevices);
      setRooms(Array.isArray(rRes?.rooms) ? rRes.rooms : []);
      setControllers(Array.isArray(cRes?.controllers) ? cRes.controllers : []);

      setSensorId((prev) => prev || safeSensors[0]?.id || "");
      setTriggerSwitchId((prev) => prev || safeSwitches[0]?.id || "");
      setTargetSwitchId((prev) => prev || safeSwitches[0]?.id || "");
      setDeviceId((prev) => prev || safeDevices[0]?.id || "");
      setTargetDeviceId((prev) => prev || safeDevices[0]?.id || "");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load automations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreateModal() {
    setEditingRuleId(null);
    setName("");
    setMode("cloud");
    setTriggerKind(
      sensors.length > 0 ? "sensor_value" : switches.length > 0 ? "switch_state" : "time"
    );
    setSensorId(sensors[0]?.id ?? "");
    setOperator("gt");
    setThreshold(30);
    setTriggerSwitchId(switches[0]?.id ?? "");
    setTriggerSwitchState("true");
    setCronTime("19:00");
    setScheduleDays([]);
    setDeviceId(devices[0]?.id ?? "");
    setExpectedState("active");
    setActionType(switches.length > 0 ? "switch_on" : "device_state");
    setTargetSwitchId(switches[0]?.id ?? "");
    setTargetDeviceId(devices[0]?.id ?? "");
    setTargetState("active");
    setModalError(null);
    setModalOpen(true);
  }

  function openVisualFlow(rule: AutomationItem | null) {
    setBuilderRule(rule);
    setBuilderKey((k) => k + 1);
    setActiveTab("builder");
  }

  function startEdit(rule: AutomationItem) {
    if (isComplexRule(rule)) {
      openVisualFlow(rule);
      return;
    }

    setEditingRuleId(rule.id);
    setName(rule.name);
    setMode(rule.execution_mode);
    const trig = rule.trigger_config;
    if (trig.type === "sensor_value") {
      setTriggerKind("sensor_value");
      setSensorId(trig.sensorId ?? sensors[0]?.id ?? "");
      setOperator(trig.operator ?? "gt");
      setThreshold(trig.threshold ?? 30);
    } else if (trig.type === "device_state") {
      if (trig.switchId) {
        setTriggerKind("switch_state");
        setTriggerSwitchId(trig.switchId);
        const isTrue =
          trig.expectedState === true ||
          String(trig.expectedState).toLowerCase() === "true" ||
          String(trig.expectedState).toLowerCase() === "on";
        setTriggerSwitchState(isTrue ? "true" : "false");
      } else {
        setTriggerKind("device_state");
        setDeviceId(trig.deviceId ?? devices[0]?.id ?? "");
        setExpectedState(String(trig.expectedState ?? "active"));
      }
    } else {
      setTriggerKind("time");
      setCronTime(trig.cronTime ?? "19:00");
      setScheduleDays(trig.days ?? []);
    }

    const firstAction = rule.actions_config[0];
    if (firstAction && firstAction.type !== "scene") {
      setActionType(firstAction.type);
      if (firstAction.type === "device_state") {
        setTargetDeviceId(firstAction.deviceId ?? devices[0]?.id ?? "");
        setTargetState(firstAction.targetState ?? "active");
      } else {
        setTargetSwitchId(firstAction.switchId ?? switches[0]?.id ?? "");
      }
    }
    setModalError(null);
    setModalOpen(true);
  }

  function toggleWeekday(day: string) {
    setScheduleDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    setModalError(null);

    if (!name.trim()) {
      setModalError("Please enter a rule name.");
      return;
    }

    let triggerConfig: Record<string, unknown>;
    if (triggerKind === "sensor_value") {
      if (!sensorId) {
        setModalError("Select a sensor to monitor.");
        return;
      }
      if (!Number.isFinite(threshold)) {
        setModalError("Enter a valid numeric threshold.");
        return;
      }
      triggerConfig = { type: "sensor_value", sensorId, operator, threshold };
    } else if (triggerKind === "switch_state") {
      if (!triggerSwitchId) {
        setModalError("Select a trigger switch.");
        return;
      }
      triggerConfig = {
        type: "device_state",
        switchId: triggerSwitchId,
        expectedState: triggerSwitchState === "true",
      };
    } else if (triggerKind === "device_state") {
      if (!deviceId || !expectedState.trim()) {
        setModalError("Select a device and expected state.");
        return;
      }
      triggerConfig = {
        type: "device_state",
        deviceId,
        expectedState: expectedState.trim(),
      };
    } else {
      if (!/^\d{2}:\d{2}$/.test(cronTime)) {
        setModalError("Select a valid 24-hour schedule time.");
        return;
      }
      triggerConfig = {
        type: "time",
        cronTime,
        days: scheduleDays,
        timezone,
      };
    }

    let actionPayload: Record<string, unknown>;
    if (actionType === "device_state") {
      if (!targetDeviceId || !targetState.trim()) {
        setModalError("Select a target device and target state.");
        return;
      }
      actionPayload = {
        type: "device_state",
        deviceId: targetDeviceId,
        targetState: targetState.trim(),
      };
    } else {
      if (!targetSwitchId) {
        setModalError("Select a target switch for the action.");
        return;
      }
      actionPayload = {
        type: actionType,
        switchId: targetSwitchId,
      };
    }

    savingRef.current = true;
    setSaving(true);
    try {
      if (editingRuleId) {
        await apiFetch(`/api/automations/${editingRuleId}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: name.trim(),
            executionMode: mode,
            triggerConfig,
            actionsConfig: [actionPayload],
          }),
        });
        toast.success(`Updated rule "${name.trim()}".`);
      } else {
        await apiFetch("/api/automations", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            executionMode: mode,
            triggerConfig,
            actionsConfig: [actionPayload],
          }),
        });
        toast.success(`Saved automation rule "${name.trim()}".`);
      }
      setModalOpen(false);
      await load(true);
    } catch (err) {
      setModalError(
        err instanceof ApiError ? err.message : "Failed to save automation rule."
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function handleToggle(rule: AutomationItem, enabled: boolean) {
    try {
      await apiFetch(`/api/automations/${rule.id}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
      toast.success(
        `${enabled ? "Enabled" : "Paused"} rule "${rule.name}".`
      );
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to toggle rule.");
    }
  }

  async function handleRun(rule: AutomationItem) {
    try {
      const res = await apiFetch<{ executedCount: number; errors: string[] }>(
        `/api/automations/${rule.id}/run`,
        { method: "POST" }
      );
      if (res.errors && res.errors.length > 0) {
        toast.error(`Executed with warning: ${res.errors.join("; ")}`);
      } else {
        toast.success(
          `Executed "${rule.name}" (${res.executedCount} action${res.executedCount === 1 ? "" : "s"}).`
        );
      }
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Execution failed.");
    }
  }

  async function handleDryRunRule(rule: AutomationItem) {
    try {
      const res = await apiFetch<{
        conditionsMatched: boolean;
        plannedActions: Array<{ summary: string }>;
      }>(`/api/automations/${rule.id}/test`, {
        method: "POST",
        body: JSON.stringify({ dryRun: true }),
      });
      toast.success(
        `Dry-run test for "${rule.name}": ${
          res.conditionsMatched ? "Conditions PASSED" : "Conditions NOT MET"
        } · ${res.plannedActions.map((a) => a.summary).join(", ") || "No actions"}`
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Dry-run test failed.");
    }
  }

  async function handleCheckSchedulesNow() {
    try {
      const res = await apiFetch<{ checked: number; triggered: number }>(
        "/api/automations/evaluate-schedules",
        { method: "POST", body: JSON.stringify({}) }
      );
      toast.success(
        `Checked ${res.checked} schedule rule(s); ${res.triggered} triggered for current minute (${timezone}).`
      );
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to check schedules.");
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/automations/${deleteTarget.id}`, { method: "DELETE" });
      toast.success(`Deleted rule "${deleteTarget.name}".`);
      if (builderRule?.id === deleteTarget.id) {
        setBuilderRule(null);
      }
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed.");
    } finally {
      setDeleting(false);
    }
  }

  const foldersList = useMemo(() => {
    const set = new Set<string>(["General"]);
    for (const r of rules) {
      if (r.folder_name?.trim()) set.add(r.folder_name.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rules]);

  const rulesByFolder = useMemo(() => {
    const q = flowFilter.trim().toLowerCase();
    const map = new Map<string, AutomationItem[]>();
    for (const r of rules) {
      const fName = r.folder_name?.trim() || "General";
      if (q && !`${r.name} ${fName} ${r.description ?? ""}`.toLowerCase().includes(q)) {
        continue;
      }
      if (!map.has(fName)) map.set(fName, []);
      map.get(fName)!.push(r);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rules, flowFilter]);

  const visibleRules = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rules.filter((r) => {
      if (
        selectedFolder !== "__all__" &&
        (r.folder_name?.trim() || "General") !== selectedFolder
      ) {
        return false;
      }
      if (!q) return true;
      return `${r.name} ${r.description ?? ""} ${r.folder_name ?? ""} ${r.execution_mode}`
        .toLowerCase()
        .includes(q);
    });
  }, [rules, selectedFolder, search]);

  if (loading && rules.length === 0 && switches.length === 0) {
    return (
      <div className="py-12 text-center text-xs text-muted-foreground">
        Loading automations...
      </div>
    );
  }

  const selectedSensor = sensors.find((s) => s.id === sensorId);

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
              Visual Flows, Multi-Condition Scenes, &amp; Schedules
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => openVisualFlow(null)}
              >
                <RiGitBranchLine className="size-4" aria-hidden="true" />
                New Visual Flow
              </Button>
              <Button size="sm" onClick={openCreateModal}>
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
      >
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

        <TabsContent value="rules" className="space-y-4 pt-2">
          {rules.length === 0 ? (
            <EmptyStatePanel
              icon={<RiFlashlightLine className="size-6" />}
              title="No automation rules configured yet"
              description="Create quick rules or open the Visual Builder to connect multiple triggers, conditions, and scenes."
              action={
                canManage ? (
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={openCreateModal}>
                      <RiAddLine className="size-4" aria-hidden="true" />
                      Create First Rule
                    </Button>
                    <Button variant="outline" onClick={() => openVisualFlow(null)}>
                      <RiGitBranchLine className="size-4" aria-hidden="true" />
                      Open Visual Builder
                    </Button>
                  </div>
                ) : undefined
              }
            />
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {foldersList.length > 1 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setSelectedFolder("__all__")}
                      className={cn(
                        "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                        selectedFolder === "__all__"
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-card text-muted-foreground hover:text-foreground"
                      )}
                    >
                      All ({rules.length})
                    </button>
                    {foldersList.map((folder) => {
                      const count = rules.filter(
                        (r) => (r.folder_name?.trim() || "General") === folder
                      ).length;
                      return (
                        <button
                          key={folder}
                          type="button"
                          onClick={() => setSelectedFolder(folder)}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                            selectedFolder === folder
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border bg-card text-muted-foreground hover:text-foreground"
                          )}
                        >
                          <RiFolderLine className="size-3.5" />
                          {folder} ({count})
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Timezone: {timezone}
                  </span>
                )}

                {canOperate && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void handleCheckSchedulesNow()}
                  >
                    <RiTimeLine className="size-3.5" aria-hidden="true" />
                    Evaluate Schedules
                  </Button>
                )}
              </div>

              {visibleRules.length === 0 ? (
                <EmptyStatePanel
                  icon={<RiFlashlightLine className="size-6" />}
                  title="No matching automation rules"
                  description={
                    search.trim()
                      ? `No rules match "${search}".`
                      : `No rules inside folder "${selectedFolder}".`
                  }
                  action={
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSearch("");
                        setSelectedFolder("__all__");
                      }}
                    >
                      Clear Filters
                    </Button>
                  }
                />
              ) : (
                visibleRules.map((rule) => {
                const { triggerText, conditionText, actionText } = describeRule(
                  rule,
                  sensors,
                  switches,
                  devices,
                  rooms,
                  timezone
                );
                return (
                  <Card key={rule.id} interactive className="py-4">
                    <CardContent className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <IconTile variant="soft" size="sm" className="text-primary">
                          <RiFlashlightLine className="size-4" aria-hidden="true" />
                        </IconTile>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-foreground">
                              {rule.name}
                            </span>
                            {rule.folder_name && (
                              <Badge variant="outline" size="xs">
                                <RiFolderLine className="size-3" />
                                {rule.folder_name}
                              </Badge>
                            )}
                            {rule.flow_graph?.nodes?.length ? (
                              <Badge variant="outline" size="xs">
                                {rule.flow_graph.nodes.length} nodes
                              </Badge>
                            ) : null}
                            <Badge variant="primary-light">{rule.execution_mode}</Badge>
                            <Badge
                              variant={
                                rule.last_execution_status === "failed"
                                  ? "destructive-light"
                                  : rule.last_execution_status === "success"
                                    ? "success-light"
                                    : "secondary"
                              }
                            >
                              {rule.last_execution_status}
                            </Badge>
                          </div>
                          {rule.description && (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {rule.description}
                            </p>
                          )}
                          <p className="mt-1 text-xs text-foreground">
                            {triggerText}
                            {conditionText && (
                              <>
                                {" "}
                                <span className="text-muted-foreground">IF</span>{" "}
                                <span className="font-medium">({conditionText})</span>
                              </>
                            )}{" "}
                            <span className="text-muted-foreground">→</span>{" "}
                            <span className="font-medium">{actionText}</span>
                          </p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {rule.last_executed_at
                              ? `Last ran ${formatTimestamp(rule.last_executed_at, timezone)}`
                              : "Waiting for trigger event"}
                          </p>
                          {rule.last_error && (
                            <p className="mt-1 text-[11px] text-destructive">
                              Last error: {rule.last_error}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Switch
                          checked={rule.enabled}
                          disabled={!canOperate}
                          aria-label={`Enable ${rule.name}`}
                          onCheckedChange={(val) => void handleToggle(rule, val)}
                        />
                        {canManage && (
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => openVisualFlow(rule)}
                          >
                            <RiGitBranchLine className="size-3.5" aria-hidden="true" />
                            Flow
                          </Button>
                        )}
                        {canManage && (
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => startEdit(rule)}
                          >
                            <RiEditLine className="size-3.5" aria-hidden="true" />
                            Edit
                          </Button>
                        )}
                        {canOperate && (
                          <>
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() => void handleDryRunRule(rule)}
                            >
                              <RiFlaskLine className="size-3.5" aria-hidden="true" />
                              Test
                            </Button>
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() => void handleRun(rule)}
                            >
                              <RiPlayLine className="size-3.5" aria-hidden="true" />
                              Run Now
                            </Button>
                          </>
                        )}
                        {canManage && (
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => setDeleteTarget(rule)}
                          >
                            <RiDeleteBinLine className="size-3.5" aria-hidden="true" />
                            Delete
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })
              )}
            </div>
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
            timezone={timezone}
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

      {/* Create / Edit Rule Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingRuleId ? "Edit Automation Rule" : "Create Automation Rule"}
            </DialogTitle>
            <DialogDescription>
              Configure trigger condition, execution mode, and target hardware action.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            {modalError && <StatusAlert tone="danger">{modalError}</StatusAlert>}

            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <FormField id="auto-name" label="Rule Name">
                <Input
                  id="auto-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="High Temp Exhaust Fan"
                />
              </FormField>

              <FormField id="auto-mode" label="Execution Mode">
                <Select
                  value={mode}
                  onValueChange={(v) => setMode(v as typeof mode)}
                >
                  <SelectTrigger id="auto-mode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cloud">Cloud (Active)</SelectItem>
                    <SelectItem value="controller">
                      Controller (Local Hub Sync)
                    </SelectItem>
                    <SelectItem value="hybrid">Hybrid (Cloud + Controller)</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>

              <FormField id="auto-trigger" label="Trigger Type">
                <Select
                  value={triggerKind}
                  onValueChange={(v) => setTriggerKind(v as UiTriggerKind)}
                >
                  <SelectTrigger id="auto-trigger" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sensor_value">Sensor Reading</SelectItem>
                    <SelectItem value="switch_state">Switch Turned ON / OFF</SelectItem>
                    <SelectItem value="device_state">Device State Changed</SelectItem>
                    <SelectItem value="time">Time Schedule ({timezone})</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {triggerKind === "sensor_value" && (
                <>
                  <FormField id="trig-sensor" label="Sensor">
                    <Select
                      value={sensorId || "__none__"}
                      onValueChange={(v) => setSensorId(v === "__none__" ? "" : v)}
                      disabled={sensors.length === 0}
                    >
                      <SelectTrigger id="trig-sensor" className="w-full">
                        <SelectValue placeholder="No sensors available" />
                      </SelectTrigger>
                      <SelectContent>
                        {sensors.length === 0 && (
                          <SelectItem value="__none__">No sensors available</SelectItem>
                        )}
                        {sensors.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name} ({s.unit})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>

                  <FormField id="trig-op" label="Condition">
                    <Select
                      value={operator}
                      onValueChange={(v) => setOperator(v as typeof operator)}
                    >
                      <SelectTrigger id="trig-op" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="gt">Greater than (&gt;)</SelectItem>
                        <SelectItem value="gte">Greater or equal (&gt;=)</SelectItem>
                        <SelectItem value="lt">Less than (&lt;)</SelectItem>
                        <SelectItem value="lte">Less or equal (&lt;=)</SelectItem>
                        <SelectItem value="eq">Equals (=)</SelectItem>
                        <SelectItem value="neq">Not equal (!=)</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>

                  <FormField
                    id="trig-thresh"
                    label={`Threshold${selectedSensor?.unit ? ` (${selectedSensor.unit})` : ""}`}
                  >
                    <Input
                      id="trig-thresh"
                      type="number"
                      step="any"
                      value={threshold}
                      onChange={(e) => setThreshold(Number(e.target.value))}
                    />
                  </FormField>
                </>
              )}

              {triggerKind === "switch_state" && (
                <>
                  <FormField id="trig-sw" label="Watch Switch">
                    <Select
                      value={triggerSwitchId || "__none__"}
                      onValueChange={(v) => setTriggerSwitchId(v === "__none__" ? "" : v)}
                      disabled={switches.length === 0}
                    >
                      <SelectTrigger id="trig-sw" className="w-full">
                        <SelectValue placeholder="No switches available" />
                      </SelectTrigger>
                      <SelectContent>
                        {switches.length === 0 && (
                          <SelectItem value="__none__">No switches available</SelectItem>
                        )}
                        {switches.map((sw) => (
                          <SelectItem key={sw.id} value={sw.id}>
                            {sw.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>

                  <FormField id="trig-sw-state" label="When Switch Becomes">
                    <Select
                      value={triggerSwitchState}
                      onValueChange={(v) =>
                        setTriggerSwitchState(v as "true" | "false")
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
                </>
              )}

              {triggerKind === "device_state" && (
                <>
                  <FormField id="trig-dev" label="Watch Device">
                    <Select
                      value={deviceId || "__none__"}
                      onValueChange={(v) => setDeviceId(v === "__none__" ? "" : v)}
                      disabled={devices.length === 0}
                    >
                      <SelectTrigger id="trig-dev" className="w-full">
                        <SelectValue placeholder="No devices available" />
                      </SelectTrigger>
                      <SelectContent>
                        {devices.length === 0 && (
                          <SelectItem value="__none__">No devices available</SelectItem>
                        )}
                        {devices.map((d) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>

                  <FormField id="trig-dev-state" label="Expected State">
                    <Input
                      id="trig-dev-state"
                      value={expectedState}
                      onChange={(e) => setExpectedState(e.target.value)}
                      placeholder="active / on / off"
                    />
                  </FormField>
                </>
              )}

              {triggerKind === "time" && (
                <>
                  <FormField id="trig-time" label={`Trigger Time (${timezone})`}>
                    <Input
                      id="trig-time"
                      type="time"
                      value={cronTime}
                      onChange={(e) => setCronTime(e.target.value)}
                    />
                  </FormField>
                  <div className="md:col-span-2 space-y-1.5">
                    <span className="block text-xs font-medium text-muted-foreground">
                      Active Days (leave empty for every day)
                    </span>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {WEEKDAYS.map((day) => {
                        const selected = scheduleDays.includes(day.id);
                        return (
                          <button
                            key={day.id}
                            type="button"
                            onClick={() => toggleWeekday(day.id)}
                            className={cn(
                              "rounded-md border px-2.5 py-1 text-xs font-medium transition cursor-pointer",
                              selected
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border bg-card text-muted-foreground hover:bg-muted"
                            )}
                          >
                            {day.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <FormField id="act-type" label="Action">
                <Select
                  value={actionType}
                  onValueChange={(v) => setActionType(v as typeof actionType)}
                >
                  <SelectTrigger id="act-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="switch_on">Turn Switch ON</SelectItem>
                    <SelectItem value="switch_off">Turn Switch OFF</SelectItem>
                    <SelectItem value="device_state">Set Device State</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>

              {actionType === "device_state" ? (
                <>
                  <FormField id="act-dev" label="Target Device">
                    <Select
                      value={targetDeviceId || "__none__"}
                      onValueChange={(v) => setTargetDeviceId(v === "__none__" ? "" : v)}
                      disabled={devices.length === 0}
                    >
                      <SelectTrigger id="act-dev" className="w-full">
                        <SelectValue placeholder="No devices available" />
                      </SelectTrigger>
                      <SelectContent>
                        {devices.length === 0 && (
                          <SelectItem value="__none__">No devices available</SelectItem>
                        )}
                        {devices.map((d) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                  <FormField id="act-state" label="Target State">
                    <Input
                      id="act-state"
                      value={targetState}
                      onChange={(e) => setTargetState(e.target.value)}
                    />
                  </FormField>
                </>
              ) : (
                <FormField id="act-sw" label="Target Switch">
                  <Select
                    value={targetSwitchId || "__none__"}
                    onValueChange={(v) => setTargetSwitchId(v === "__none__" ? "" : v)}
                    disabled={switches.length === 0}
                  >
                    <SelectTrigger id="act-sw" className="w-full">
                      <SelectValue placeholder="No switches available" />
                    </SelectTrigger>
                    <SelectContent>
                      {switches.length === 0 && (
                        <SelectItem value="__none__">No switches available</SelectItem>
                      )}
                      {switches.map((sw) => (
                        <SelectItem key={sw.id} value={sw.id}>
                          {sw.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving
                  ? "Saving..."
                  : editingRuleId
                    ? "Update Automation Rule"
                    : "Save Automation Rule"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete rule "${deleteTarget?.name ?? ""}"?`}
        description="This stops automatic execution for this trigger and action pipeline."
        confirmLabel="Delete Rule"
        busy={deleting}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
