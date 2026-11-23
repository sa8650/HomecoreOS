import { useMemo } from "react";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiCloseLine,
  RiLightbulbLine,
} from "@remixicon/react";
import {
  ACTION_BUTTON_CATEGORY_LABELS,
  ACTION_BUTTON_GESTURE_LABELS,
  type ActionButtonCategory,
  type ActionButtonGesture,
  type ActionButtonGestures,
  type ActionButtonOp,
  type ActionButtonBulkTarget,
  type ActionButtonStep,
} from "@homecoreos/shared";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "cn";
import type { ActionButtonInventory } from "./action-button-inventory";
import { nextStepId, summarizeStep } from "./action-button-summary";

const OP_OPTIONS: Array<{ value: ActionButtonOp; label: string }> = [
  { value: "on", label: "Turn ON" },
  { value: "off", label: "Turn OFF" },
  { value: "toggle", label: "Toggle" },
];

const BULK_TARGET_OPTIONS: Array<{ value: ActionButtonBulkTarget; label: string }> = [
  { value: "all", label: "Switches & devices" },
  { value: "switches", label: "Switches only" },
  { value: "devices", label: "Devices only" },
];

const GESTURE_ORDER: ActionButtonGesture[] = ["single", "double", "long"];

function defaultStepsFor(
  category: ActionButtonCategory,
  inventory: ActionButtonInventory
): ActionButtonStep[] {
  switch (category) {
    case "global":
      return [{ id: nextStepId(), kind: "all", target: "all", op: "off" }];
    case "room": {
      const first = inventory.rooms[0];
      return first
        ? [{ id: nextStepId(), kind: "room", roomId: first.id, target: "all", op: "off" }]
        : [];
    }
    case "group": {
      const firstSwitch = inventory.switches[0];
      if (firstSwitch) {
        return [{ id: nextStepId(), kind: "switch", switchId: firstSwitch.id, op: "toggle" }];
      }
      const firstDevice = inventory.devices[0];
      return firstDevice
        ? [{ id: nextStepId(), kind: "device", deviceId: firstDevice.id, op: "toggle" }]
        : [];
    }
    case "automation": {
      const first = inventory.automations[0];
      return first
        ? [{ id: nextStepId(), kind: "automation", automationId: first.id }]
        : [];
    }
    case "custom":
      return [];
  }
}

function OpSelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: ActionButtonOp;
  onChange: (op: ActionButtonOp) => void;
  ariaLabel: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ActionButtonOp)}>
      <SelectTrigger size="sm" aria-label={ariaLabel} className="w-[118px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {OP_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function BulkTargetSelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: ActionButtonBulkTarget;
  onChange: (target: ActionButtonBulkTarget) => void;
  ariaLabel: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v as ActionButtonBulkTarget)}
    >
      <SelectTrigger size="sm" aria-label={ariaLabel} className="w-[152px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {BULK_TARGET_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function GlobalBody({
  steps,
  onStepsChange,
}: {
  steps: ActionButtonStep[];
  onStepsChange: (steps: ActionButtonStep[]) => void;
}) {
  const step = steps.find((s) => s.kind === "all") as
    | Extract<ActionButtonStep, { kind: "all" }>
    | undefined;
  const target = step?.target ?? "all";
  const op = step?.op ?? "off";
  const update = (nextTarget: ActionButtonBulkTarget, nextOp: ActionButtonOp) => {
    onStepsChange([{ id: step?.id ?? nextStepId(), kind: "all", target: nextTarget, op: nextOp }]);
  };
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        One tap applies the chosen action to every switch and device in this account.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <BulkTargetSelect value={target} onChange={(t) => update(t, op)} ariaLabel="Bulk target" />
        <OpSelect value={op} onChange={(o) => update(target, o)} ariaLabel="Bulk action" />
      </div>
    </div>
  );
}

function RoomBody({
  steps,
  onStepsChange,
  inventory,
}: {
  steps: ActionButtonStep[];
  onStepsChange: (steps: ActionButtonStep[]) => void;
  inventory: ActionButtonInventory;
}) {
  const step = steps.find((s) => s.kind === "room") as
    | Extract<ActionButtonStep, { kind: "room" }>
    | undefined;
  if (inventory.rooms.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        No rooms found yet. Create rooms first, then assign this button to one.
      </p>
    );
  }
  const update = (roomId: string, target: ActionButtonBulkTarget, op: ActionButtonOp) => {
    onStepsChange([{ id: step?.id ?? nextStepId(), kind: "room", roomId, target, op }]);
  };
  const roomId = step?.roomId ?? "";
  const target = step?.target ?? "all";
  const op = step?.op ?? "off";
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Applies the action to everything controllable inside one room.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={roomId}
          onValueChange={(v) => update(v, target, op)}
        >
          <SelectTrigger size="sm" aria-label="Room" className="w-[180px]">
            <SelectValue placeholder="Choose a room" />
          </SelectTrigger>
          <SelectContent>
            {inventory.rooms.map((room) => (
              <SelectItem key={room.id} value={room.id}>
                {room.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <BulkTargetSelect value={target} onChange={(t) => roomId && update(roomId, t, op)} ariaLabel="Room target" />
        <OpSelect value={op} onChange={(o) => roomId && update(roomId, target, o)} ariaLabel="Room action" />
      </div>
    </div>
  );
}

function GroupBody({
  steps,
  onStepsChange,
  inventory,
}: {
  steps: ActionButtonStep[];
  onStepsChange: (steps: ActionButtonStep[]) => void;
  inventory: ActionButtonInventory;
}) {
  const controllable = steps.filter(
    (s): s is Extract<ActionButtonStep, { kind: "switch" | "device" }> =>
      s.kind === "switch" || s.kind === "device"
  );
  const op: ActionButtonOp = controllable[0]?.op ?? "toggle";
  const selectedSwitchIds = new Set(
    steps.filter((s) => s.kind === "switch").map((s) => (s.kind === "switch" ? s.switchId : ""))
  );
  const selectedDeviceIds = new Set(
    steps.filter((s) => s.kind === "device").map((s) => (s.kind === "device" ? s.deviceId : ""))
  );

  const rebuild = (
    nextSwitchIds: Set<string>,
    nextDeviceIds: Set<string>,
    nextOp: ActionButtonOp
  ) => {
    const next: ActionButtonStep[] = [];
    for (const sw of inventory.switches) {
      if (nextSwitchIds.has(sw.id)) {
        const existing = steps.find((s) => s.kind === "switch" && s.switchId === sw.id);
        next.push({ id: existing?.id ?? nextStepId(), kind: "switch", switchId: sw.id, op: nextOp });
      }
    }
    for (const dev of inventory.devices) {
      if (nextDeviceIds.has(dev.id)) {
        const existing = steps.find((s) => s.kind === "device" && s.deviceId === dev.id);
        next.push({ id: existing?.id ?? nextStepId(), kind: "device", deviceId: dev.id, op: nextOp });
      }
    }
    onStepsChange(next);
  };

  const toggle = (kind: "switch" | "device", id: string) => {
    const nextSwitch = new Set(selectedSwitchIds);
    const nextDevice = new Set(selectedDeviceIds);
    if (kind === "switch") {
      if (nextSwitch.has(id)) nextSwitch.delete(id);
      else nextSwitch.add(id);
    } else {
      if (nextDevice.has(id)) nextDevice.delete(id);
      else nextDevice.add(id);
    }
    rebuild(nextSwitch, nextDevice, op);
  };

  const changeOp = (nextOp: ActionButtonOp) => {
    onStepsChange(
      steps.map((s) =>
        s.kind === "switch" || s.kind === "device" ? { ...s, op: nextOp } : s
      )
    );
  };

  const selectedCount = selectedSwitchIds.size + selectedDeviceIds.size;
  const hasItems = inventory.switches.length > 0 || inventory.devices.length > 0;

  if (!hasItems) {
    return (
      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        No controllable switches or devices yet. Add hardware first, then group them here.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Pick exactly what this button controls — your custom group.
        </p>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" radius="full">
            {selectedCount} selected
          </Badge>
          <OpSelect value={op} onChange={changeOp} ariaLabel="Group action" />
          {selectedCount > 0 && (
            <Button size="sm" variant="ghost" onClick={() => onStepsChange([])}>
              Clear
            </Button>
          )}
        </div>
      </div>
      <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border p-2">
        {inventory.switches.length > 0 && (
          <p className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Switches
          </p>
        )}
        {inventory.switches.map((sw) => {
          const checked = selectedSwitchIds.has(sw.id);
          return (
            <label
              key={sw.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle("switch", sw.id)}
                aria-label={`Include switch ${sw.name}`}
                className="size-3.5 accent-primary"
              />
              <span className="min-w-0 flex-1 truncate">{sw.name}</span>
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  sw.is_on ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"
                )}
                aria-hidden="true"
              />
            </label>
          );
        })}
        {inventory.devices.length > 0 && (
          <p className="px-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Devices
          </p>
        )}
        {inventory.devices.map((dev) => {
          const checked = selectedDeviceIds.has(dev.id);
          return (
            <label
              key={dev.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle("device", dev.id)}
                aria-label={`Include device ${dev.name}`}
                className="size-3.5 accent-primary"
              />
              <span className="min-w-0 flex-1 truncate">
                {dev.name}
                <span className="text-muted-foreground"> · {dev.device_type.replace(/_/g, " ")}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function AutomationBody({
  steps,
  onStepsChange,
  inventory,
}: {
  steps: ActionButtonStep[];
  onStepsChange: (steps: ActionButtonStep[]) => void;
  inventory: ActionButtonInventory;
}) {
  const step = steps.find((s) => s.kind === "automation") as
    | Extract<ActionButtonStep, { kind: "automation" }>
    | undefined;
  const scenes = inventory.automations.filter((a) => a.scene);
  const automations = inventory.automations.filter((a) => !a.scene);

  if (inventory.automations.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        No scenes or automations yet. Create one in Automations first — manual-trigger rules appear here as scenes.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Runs an existing scene or automation by id. Scene = manual-trigger automation.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={step?.automationId ?? ""}
          onValueChange={(v) =>
            onStepsChange([{ id: step?.id ?? nextStepId(), kind: "automation", automationId: v }])
          }
        >
          <SelectTrigger size="sm" aria-label="Scene or automation" className="w-[280px]">
            <SelectValue placeholder="Choose a scene or automation" />
          </SelectTrigger>
          <SelectContent>
            {scenes.map((rule) => (
              <SelectItem key={rule.id} value={rule.id}>
                Scene · {rule.name}
              </SelectItem>
            ))}
            {automations.map((rule) => (
              <SelectItem key={rule.id} value={rule.id}>
                Automation · {rule.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {step && (
          <Button size="sm" variant="ghost" onClick={() => onStepsChange([])}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

function CustomBody({
  steps,
  onStepsChange,
  inventory,
}: {
  steps: ActionButtonStep[];
  onStepsChange: (steps: ActionButtonStep[]) => void;
  inventory: ActionButtonInventory;
}) {
  const update = (index: number, step: ActionButtonStep) => {
    const next = steps.slice();
    next[index] = step;
    onStepsChange(next);
  };
  const remove = (index: number) => {
    const next = steps.slice();
    next.splice(index, 1);
    onStepsChange(next);
  };
  const move = (index: number, delta: -1 | 1) => {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= steps.length) return;
    const next = steps.slice();
    const [item] = next.splice(index, 1);
    next.splice(targetIndex, 0, item!);
    onStepsChange(next);
  };
  const addStep = (kind: ActionButtonStep["kind"]) => {
    const starter: ActionButtonStep =
      kind === "switch" && inventory.switches[0]
        ? { id: nextStepId(), kind: "switch", switchId: inventory.switches[0].id, op: "toggle" }
        : kind === "device" && inventory.devices[0]
          ? { id: nextStepId(), kind: "device", deviceId: inventory.devices[0].id, op: "toggle" }
          : kind === "room" && inventory.rooms[0]
            ? { id: nextStepId(), kind: "room", roomId: inventory.rooms[0].id, target: "all", op: "off" }
            : kind === "all"
              ? { id: nextStepId(), kind: "all", target: "all", op: "off" }
              : kind === "automation" && inventory.automations[0]
                ? { id: nextStepId(), kind: "automation", automationId: inventory.automations[0].id }
                : { id: nextStepId(), kind: "delay", ms: 500 };
    onStepsChange([...steps, starter]);
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Build any sequence — mix switches, devices, rooms, scenes and delays, executed in order.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ["switch", "Switch"],
            ["device", "Device"],
            ["room", "Room"],
            ["all", "Everything"],
            ["automation", "Scene / Auto"],
            ["delay", "Delay"],
          ] as Array<[ActionButtonStep["kind"], string]>
        ).map(([kind, label]) => (
          <Button
            key={kind}
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => addStep(kind)}
          >
            <RiAddLine className="size-3.5" aria-hidden="true" />
            {label}
          </Button>
        ))}
      </div>

      {steps.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          No steps yet — combine your home into one gesture.
        </p>
      ) : (
        <ol className="space-y-1.5">
          {steps.map((step, index) => (
            <li
              key={step.id}
              className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-background/60 p-1.5"
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-[10px] font-bold text-primary">
                {index + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                <StepKindEditors
                  step={step}
                  inventory={inventory}
                  onChange={(s) => update(index, s)}
                />
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label="Move step up"
                >
                  <RiArrowUpSLine className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
                  onClick={() => move(index, 1)}
                  disabled={index === steps.length - 1}
                  aria-label="Move step down"
                >
                  <RiArrowDownSLine className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => remove(index)}
                  aria-label="Remove step"
                >
                  <RiCloseLine className="size-4" aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function StepKindEditors({
  step,
  inventory,
  onChange,
}: {
  step: ActionButtonStep;
  inventory: ActionButtonInventory;
  onChange: (step: ActionButtonStep) => void;
}) {
  switch (step.kind) {
    case "switch":
      return (
        <>
          <Select
            value={step.switchId}
            onValueChange={(v) => onChange({ ...step, switchId: v })}
          >
            <SelectTrigger size="sm" aria-label="Switch" className="w-[170px]">
              <SelectValue placeholder="Switch" />
            </SelectTrigger>
            <SelectContent>
              {inventory.switches.map((sw) => (
                <SelectItem key={sw.id} value={sw.id}>
                  {sw.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <OpSelect value={step.op} onChange={(op) => onChange({ ...step, op })} ariaLabel="Switch action" />
        </>
      );
    case "device":
      return (
        <>
          <Select
            value={step.deviceId}
            onValueChange={(v) => onChange({ ...step, deviceId: v })}
          >
            <SelectTrigger size="sm" aria-label="Device" className="w-[170px]">
              <SelectValue placeholder="Device" />
            </SelectTrigger>
            <SelectContent>
              {inventory.devices.map((dev) => (
                <SelectItem key={dev.id} value={dev.id}>
                  {dev.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <OpSelect value={step.op} onChange={(op) => onChange({ ...step, op })} ariaLabel="Device action" />
        </>
      );
    case "room":
      return (
        <>
          <Select
            value={step.roomId}
            onValueChange={(v) => onChange({ ...step, roomId: v })}
          >
            <SelectTrigger size="sm" aria-label="Room" className="w-[140px]">
              <SelectValue placeholder="Room" />
            </SelectTrigger>
            <SelectContent>
              {inventory.rooms.map((room) => (
                <SelectItem key={room.id} value={room.id}>
                  {room.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <BulkTargetSelect
            value={step.target}
            onChange={(target) => onChange({ ...step, target })}
            ariaLabel="Room target"
          />
          <OpSelect value={step.op} onChange={(op) => onChange({ ...step, op })} ariaLabel="Room action" />
        </>
      );
    case "all":
      return (
        <>
          <BulkTargetSelect
            value={step.target}
            onChange={(target) => onChange({ ...step, target })}
            ariaLabel="Everything target"
          />
          <OpSelect value={step.op} onChange={(op) => onChange({ ...step, op })} ariaLabel="Everything action" />
        </>
      );
    case "automation":
      return (
        <Select
          value={step.automationId}
          onValueChange={(v) => onChange({ ...step, automationId: v })}
        >
          <SelectTrigger size="sm" aria-label="Scene or automation" className="w-[220px]">
            <SelectValue placeholder="Scene / automation" />
          </SelectTrigger>
          <SelectContent>
            {inventory.automations.map((rule) => (
              <SelectItem key={rule.id} value={rule.id}>
                {rule.scene ? "Scene" : "Automation"} · {rule.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "delay":
      return (
        <span className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Wait</span>
          <Input
            type="number"
            min={0}
            max={10_000}
            step={50}
            value={step.ms}
            onChange={(e) =>
              onChange({ ...step, ms: Math.max(0, Math.min(10_000, Number(e.target.value) || 0)) })
            }
            aria-label="Delay in milliseconds"
            className="h-8 w-24"
          />
          <span className="text-xs text-muted-foreground">ms</span>
        </span>
      );
  }
}

function GestureBody({
  category,
  steps,
  onStepsChange,
  inventory,
}: {
  category: ActionButtonCategory;
  steps: ActionButtonStep[];
  onStepsChange: (steps: ActionButtonStep[]) => void;
  inventory: ActionButtonInventory;
}) {
  switch (category) {
    case "global":
      return <GlobalBody steps={steps} onStepsChange={onStepsChange} />;
    case "room":
      return <RoomBody steps={steps} onStepsChange={onStepsChange} inventory={inventory} />;
    case "group":
      return <GroupBody steps={steps} onStepsChange={onStepsChange} inventory={inventory} />;
    case "automation":
      return <AutomationBody steps={steps} onStepsChange={onStepsChange} inventory={inventory} />;
    case "custom":
      return <CustomBody steps={steps} onStepsChange={onStepsChange} inventory={inventory} />;
  }
}

export function ActionButtonStepsEditor({
  category,
  gestures,
  onChange,
  inventory,
}: {
  category: ActionButtonCategory;
  gestures: ActionButtonGestures;
  onChange: (gestures: ActionButtonGestures) => void;
  inventory: ActionButtonInventory;
}) {
  const setGestureSteps = (gesture: ActionButtonGesture, steps: ActionButtonStep[] | null) => {
    onChange({ ...gestures, [gesture]: steps });
  };

  const gestureSummaries = useMemo(() => {
    const map = new Map<ActionButtonGesture, string[]>();
    for (const g of GESTURE_ORDER) {
      const steps = gestures[g];
      if (steps) map.set(g, steps.map((s) => summarizeStep(s, inventory)));
    }
    return map;
  }, [gestures, inventory]);

  return (
    <Tabs defaultValue="single" className="w-full">
      <TabsList className="w-full justify-start" aria-label="Gesture">
        {GESTURE_ORDER.map((gesture) => {
          const configured = gesture === "single" || Boolean(gestures[gesture]?.length);
          return (
            <TabsTrigger key={gesture} value={gesture} className="gap-1.5">
              {ACTION_BUTTON_GESTURE_LABELS[gesture]}
              {gesture !== "single" && (
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    configured ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"
                  )}
                  aria-hidden="true"
                />
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>

      {GESTURE_ORDER.map((gesture) => {
        const steps = gestures[gesture];
        const optional = gesture !== "single";
        const configured = !optional || Boolean(steps && steps.length > 0);
        return (
          <TabsContent key={gesture} value={gesture} className="mt-3 space-y-3">
            {optional && !configured ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center">
                <RiLightbulbLine className="size-5 text-muted-foreground" aria-hidden="true" />
                <p className="text-xs text-muted-foreground">
                  No {ACTION_BUTTON_GESTURE_LABELS[gesture].toLowerCase()} action yet.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setGestureSteps(gesture, defaultStepsFor(category, inventory))}
                >
                  <RiAddLine className="size-4" aria-hidden="true" />
                  Add {ACTION_BUTTON_GESTURE_LABELS[gesture].toLowerCase()}
                </Button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="primary-light" radius="full">
                    {ACTION_BUTTON_CATEGORY_LABELS[category]}
                  </Badge>
                  {optional && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                      onClick={() => setGestureSteps(gesture, null)}
                    >
                      Remove gesture
                    </Button>
                  )}
                </div>
                <GestureBody
                  category={category}
                  steps={steps ?? []}
                  onStepsChange={(next) => setGestureSteps(gesture, next.length === 0 && optional ? null : next)}
                  inventory={inventory}
                />
                {steps && steps.length > 0 && (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    <span className="font-semibold text-foreground/80">Preview:</span>{" "}
                    {gestureSummaries.get(gesture)?.join(" → ")}
                  </p>
                )}
              </>
            )}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
