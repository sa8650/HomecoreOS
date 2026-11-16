import { useId, useState, type ReactNode } from "react";
import {
  PLANNER_CATEGORY_META,
  PLANNER_INPUT_LIMITS,
  PLANNER_LOAD_CATEGORIES,
  PLANNER_SENSOR_CATEGORIES,
  type PlannerDeviceCategory,
  type PlannerEnvironment,
  type PlannerEthernetNeed,
  type PlannerMissingInformation,
  type PlannerNormalizedRequirements,
  type PlannerSensorWiring,
  type PlannerWifiAvailability,
} from "@homecoreos/shared";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowLeftLine,
  RiArrowRightLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiMagicLine,
  RiSubtractLine,
} from "@remixicon/react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/reui/badge";
import { Frame, FramePanel } from "@/components/reui/frame";
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from "@/components/reui/stepper";
import { StatusAlert } from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  PLANNER_ROOM_SUGGESTIONS,
  addLocation,
  addRoom,
  canAddLocation,
  canAddRoom,
  duplicateRoom,
  removeLocation,
  removeRoom,
  roomDeviceTotal,
  setDeviceIndependent,
  setDeviceQuantity,
  setFanSpeedControl,
  setFloors,
  updateLocation,
  updateRoom,
  type PlannerDraft,
  type PlannerDraftRoom,
} from "./planner-draft";

export const PLANNER_WIZARD_STEPS = [
  { id: "home", title: "Your home", hint: "Floors and rooms" },
  { id: "devices", title: "Devices", hint: "What to control in each room" },
  { id: "installation", title: "Installation", hint: "Wi-Fi, wiring and future plans" },
  { id: "review", title: "Review", hint: "Check and analyze" },
] as const;

export type PlannerWizardStepId = (typeof PLANNER_WIZARD_STEPS)[number]["id"];

/** Wizard step number (1-based) for a step id reported by the planner. */
export function plannerStepNumber(step: PlannerMissingInformation["step"]): number {
  return PLANNER_WIZARD_STEPS.findIndex((s) => s.id === step) + 1;
}

interface Choice<T extends string> {
  value: T;
  label: string;
  description: string;
}

const WIFI_CHOICES: Choice<PlannerWifiAvailability>[] = [
  { value: "strong", label: "Strong signal", description: "Phones connect reliably where the controller will sit." },
  { value: "weak", label: "Weak or patchy", description: "Wi-Fi reaches the spot but is slow or drops out." },
  { value: "none", label: "No Wi-Fi there", description: "There is no Wi-Fi coverage at the controller location." },
  { value: "unknown", label: "Not checked yet", description: "I have not tested the signal there." },
];

const ETHERNET_CHOICES: Choice<PlannerEthernetNeed>[] = [
  { value: "not_needed", label: "Not needed", description: "Wi-Fi is fine for my controllers." },
  { value: "preferred", label: "Nice to have", description: "I would use a network cable if a board supports it." },
  { value: "required", label: "Must be wired", description: "Controllers have to connect with a network cable." },
];

const ENVIRONMENT_CHOICES: Choice<PlannerEnvironment>[] = [
  { value: "indoor_dry", label: "Indoors, dry", description: "A normal room, cupboard or ceiling space." },
  { value: "electrical_panel", label: "Inside an electrical panel", description: "Next to breakers and mains wiring." },
  { value: "damp", label: "Damp area", description: "Bathroom, laundry or anywhere with moisture." },
  { value: "outdoor", label: "Outdoors", description: "Exposed to weather or direct sun." },
];

const SENSOR_WIRING_CHOICES: Choice<PlannerSensorWiring>[] = [
  { value: "direct", label: "Wired to the controller", description: "Each sensor has its own wire to a controller pin." },
  { value: "i2c_bus", label: "Shared sensor bus (I2C)", description: "Temperature sensors share one pair of wires." },
  { value: "wireless", label: "Wireless sensors", description: "Battery sensors using Zigbee, Bluetooth or similar." },
  { value: "rs485", label: "RS-485 / Modbus", description: "Industrial sensors on one long cable." },
  { value: "unsure", label: "Not sure", description: "Plan them as ordinary wired sensors." },
];

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function CountStepper({
  label,
  value,
  min = 0,
  max,
  onChange,
  className,
}: {
  label: string;
  value: number;
  min?: number;
  max: number;
  onChange: (next: number) => void;
  className?: string;
}) {
  const clamp = (next: number) => Math.max(min, Math.min(max, Number.isFinite(next) ? Math.trunc(next) : min));
  return (
    <div className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        <RiSubtractLine aria-hidden="true" />
      </Button>
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        aria-label={label}
        value={String(value)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className="h-7 w-12 px-1 text-center text-sm tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        <RiAddLine aria-hidden="true" />
      </Button>
    </div>
  );
}

function ChoiceGroup<T extends string>({
  legend,
  hint,
  required = false,
  value,
  choices,
  onChange,
  columns = "sm:grid-cols-2",
}: {
  legend: string;
  hint?: string;
  required?: boolean;
  value: T | null;
  choices: Choice<T>[];
  onChange: (next: T) => void;
  columns?: string;
}) {
  const name = useId();
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-semibold text-foreground">
        {legend}
        {required && (
          <span className="ml-1.5 text-[11px] font-medium text-primary">Required</span>
        )}
      </legend>
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      <div className={cn("grid grid-cols-1 gap-2", columns)}>
        {choices.map((choice) => (
          <label
            key={choice.value}
            className={cn(
              "flex cursor-pointer items-start gap-2.5 rounded-lg border bg-card px-3 py-2.5 transition-colors",
              "hover:border-primary/40 has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
              value === choice.value ? "border-primary/60 bg-primary/5" : "border-border"
            )}
          >
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={value === choice.value}
              onChange={() => onChange(choice.value)}
              className="mt-0.5 size-3.5 shrink-0 accent-primary outline-none"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium leading-tight text-foreground">
                {choice.label}
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                {choice.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SectionTitle({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

type UpdateDraft = (update: (draft: PlannerDraft) => PlannerDraft) => void;

function floorLabel(floor: number): string {
  return `Floor ${floor}`;
}

// ---------------------------------------------------------------------------
// Step 1 — home
// ---------------------------------------------------------------------------

function HomeStep({ draft, update }: { draft: PlannerDraft; update: UpdateDraft }) {
  const floorOptions = Array.from({ length: draft.floors }, (_, i) => i + 1);
  const unusedSuggestions = PLANNER_ROOM_SUGGESTIONS.filter(
    (name) => !draft.rooms.some((room) => room.name.trim().toLowerCase() === name.toLowerCase())
  );
  const roomLimitReached = !canAddRoom(draft);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">How many floors does your home have?</p>
          <p className="text-xs text-muted-foreground">Count every level that has something to control.</p>
        </div>
        <CountStepper
          label="Number of floors"
          value={draft.floors}
          min={1}
          max={PLANNER_INPUT_LIMITS.maxFloors}
          onChange={(next) => update((d) => setFloors(d, next))}
        />
      </div>

      <div className="space-y-3">
        <SectionTitle
          title="Rooms"
          description="Add every room or area where you want to control something. You will list the devices in the next step."
        />

        {draft.rooms.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            No rooms yet. Add your first room below.
          </p>
        ) : (
          <ul className="space-y-2" aria-label="Rooms">
            {draft.rooms.map((room, index) => (
              <li
                key={room.id}
                className="hc-step-enter flex flex-wrap items-center gap-2 rounded-lg border bg-card px-2.5 py-2"
              >
                <span className="w-5 shrink-0 text-center text-[11px] font-semibold tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <Input
                  aria-label={`Room ${index + 1} name`}
                  placeholder={`Room ${index + 1}`}
                  maxLength={PLANNER_INPUT_LIMITS.maxNameLength}
                  value={room.name}
                  onChange={(e) => update((d) => updateRoom(d, room.id, { name: e.target.value }))}
                  className="h-8 min-w-36 flex-1"
                />
                {draft.floors > 1 && (
                  <Select
                    value={String(room.floor)}
                    onValueChange={(value) =>
                      update((d) => updateRoom(d, room.id, { floor: Number(value) }))
                    }
                  >
                    <SelectTrigger
                      aria-label={`Floor of ${room.name || `room ${index + 1}`}`}
                      className="h-8 w-28 text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {floorOptions.map((floor) => (
                        <SelectItem key={floor} value={String(floor)}>
                          {floorLabel(floor)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {draft.locations.length > 1 && (
                  <Select
                    value={room.locationId ?? draft.locations[0]!.id}
                    onValueChange={(value) =>
                      update((d) => updateRoom(d, room.id, { locationId: value }))
                    }
                  >
                    <SelectTrigger
                      aria-label={`Controller location for ${room.name || `room ${index + 1}`}`}
                      className="h-8 w-48 text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {draft.locations.map((location, i) => (
                        <SelectItem key={location.id} value={location.id}>
                          {location.name.trim() || `Controller location ${i + 1}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Duplicate ${room.name || `room ${index + 1}`}`}
                    title="Duplicate this room and its devices"
                    disabled={roomLimitReached}
                    onClick={() => update((d) => duplicateRoom(d, room.id))}
                  >
                    <RiFileCopyLine aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${room.name || `room ${index + 1}`}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => update((d) => removeRoom(d, room.id))}
                  >
                    <RiDeleteBinLine aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={roomLimitReached}
            onClick={() => update((d) => addRoom(d))}
          >
            <RiAddLine aria-hidden="true" />
            Add room
          </Button>
          {!roomLimitReached &&
            unusedSuggestions.map((name) => (
              <Button
                key={name}
                type="button"
                variant="ghost"
                size="xs"
                className="border border-dashed border-border text-muted-foreground"
                aria-label={`Add ${name}`}
                onClick={() => update((d) => addRoom(d, name))}
              >
                <RiAddLine aria-hidden="true" />
                {name}
              </Button>
            ))}
        </div>
        {roomLimitReached && (
          <p className="text-[11px] text-muted-foreground">
            One plan holds up to {PLANNER_INPUT_LIMITS.maxRooms} rooms. Split a larger site into
            separate plans.
          </p>
        )}
      </div>

      <div className="space-y-3">
        <SectionTitle
          title="Where will controllers be installed? (optional)"
          description="A controller is the small board that the wires from your devices run to. If you leave this empty, the planner assumes one central spot for the whole home. Add a location for each place you want a controller, for example one per floor, then choose a location for every room."
        />
        {draft.locations.length > 0 && (
          <ul className="space-y-2" aria-label="Controller locations">
            {draft.locations.map((location, index) => (
              <li
                key={location.id}
                className="hc-step-enter flex flex-wrap items-center gap-2 rounded-lg border bg-card px-2.5 py-2"
              >
                <Input
                  aria-label={`Controller location ${index + 1} name`}
                  placeholder={`Controller location ${index + 1}`}
                  maxLength={PLANNER_INPUT_LIMITS.maxNameLength}
                  value={location.name}
                  onChange={(e) =>
                    update((d) => updateLocation(d, location.id, { name: e.target.value }))
                  }
                  className="h-8 min-w-40 flex-1"
                />
                {draft.floors > 1 && (
                  <Select
                    value={location.floor === null ? "any" : String(location.floor)}
                    onValueChange={(value) =>
                      update((d) =>
                        updateLocation(d, location.id, {
                          floor: value === "any" ? null : Number(value),
                        })
                      )
                    }
                  >
                    <SelectTrigger
                      aria-label={`Floor of controller location ${index + 1}`}
                      className="h-8 w-36 text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Floor not set</SelectItem>
                      {floorOptions.map((floor) => (
                        <SelectItem key={floor} value={String(floor)}>
                          {floorLabel(floor)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove controller location ${index + 1}`}
                  className="ml-auto text-muted-foreground hover:text-destructive"
                  onClick={() => update((d) => removeLocation(d, location.id))}
                >
                  <RiDeleteBinLine aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canAddLocation(draft)}
          onClick={() => update((d) => addLocation(d))}
        >
          <RiAddLine aria-hidden="true" />
          Add controller location
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — devices
// ---------------------------------------------------------------------------

function DeviceCounter({
  room,
  category,
  update,
}: {
  room: PlannerDraftRoom;
  category: PlannerDeviceCategory;
  update: UpdateDraft;
}) {
  const meta = PLANNER_CATEGORY_META[category];
  const count = room.devices[category];
  const roomName = room.name.trim() || "this room";
  const max = PLANNER_INPUT_LIMITS.maxQuantityPerCategory;

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5 transition-colors",
        count.quantity > 0 ? "border-primary/35 bg-primary/[0.04]" : "border-border bg-card"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium leading-tight text-foreground">{meta.label}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{meta.hint}</p>
        </div>
        <CountStepper
          label={`${meta.label} in ${roomName}`}
          value={count.quantity}
          max={max}
          onChange={(next) => update((d) => setDeviceQuantity(d, room.id, category, next))}
        />
      </div>

      {meta.group === "load" && count.quantity > 1 && (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-dashed pt-2">
          <p className="min-w-0 text-[11px] leading-snug text-muted-foreground">
            <span className="font-medium text-foreground">Switched separately</span>
            <br />
            {count.independent === count.quantity
              ? `Each of the ${count.quantity} has its own on/off control.`
              : `${plural(count.quantity, meta.singular, meta.plural)} share ${plural(
                  count.independent,
                  "control"
                )}.`}
          </p>
          <CountStepper
            label={`${meta.label} switched separately in ${roomName}`}
            value={count.independent}
            min={1}
            max={count.quantity}
            onChange={(next) => update((d) => setDeviceIndependent(d, room.id, category, next))}
          />
        </div>
      )}

      {category === "fans" && count.independent > 0 && (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-dashed pt-2">
          <p className="min-w-0 text-[11px] leading-snug text-muted-foreground">
            <span className="font-medium text-foreground">With speed control</span>
            <br />
            Fans whose speed you want to change, not only switch on and off.
          </p>
          <CountStepper
            label={`Fans with speed control in ${roomName}`}
            value={room.fanSpeedControl}
            max={count.independent}
            onChange={(next) => update((d) => setFanSpeedControl(d, room.id, next))}
          />
        </div>
      )}
    </div>
  );
}

function DevicesStep({
  draft,
  update,
  onGoToStep,
}: {
  draft: PlannerDraft;
  update: UpdateDraft;
  onGoToStep: (step: number) => void;
}) {
  const [openRoomId, setOpenRoomId] = useState<string | null>(() => draft.rooms[0]?.id ?? null);
  const activeRoomId = draft.rooms.some((room) => room.id === openRoomId)
    ? openRoomId
    : null;

  if (draft.rooms.length === 0) {
    return (
      <StatusAlert
        tone="info"
        title="Add a room first"
        action={
          <Button type="button" size="xs" variant="outline" onClick={() => onGoToStep(1)}>
            Go to Your home
          </Button>
        }
      >
        Devices are listed room by room, so the planner needs at least one room.
      </StatusAlert>
    );
  }

  return (
    <div className="space-y-4">
      <SectionTitle
        title="What do you want to control in each room?"
        description="Count the real devices. If several lights come on together from one switch, lower “Switched separately” so the planner reserves one connection for the group instead of one per light."
      />
      <ul className="space-y-2">
        {draft.rooms.map((room, index) => {
          const open = room.id === activeRoomId;
          const total = roomDeviceTotal(room);
          const roomName = room.name.trim() || `Room ${index + 1}`;
          const panelId = `planner-room-devices-${room.id}`;
          return (
            <li key={room.id} className="overflow-hidden rounded-xl border bg-card">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpenRoomId(open ? null : room.id)}
                className="flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/60"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-foreground">
                    {roomName}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {draft.floors > 1 ? `${floorLabel(room.floor)} · ` : ""}
                    {total === 0 ? "No devices yet" : plural(total, "device")}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {total > 0 && (
                    <Badge variant="primary-light" size="sm" radius="full">
                      {total}
                    </Badge>
                  )}
                  <RiArrowDownSLine
                    aria-hidden="true"
                    className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")}
                  />
                </span>
              </button>
              {open && (
                <div id={panelId} className="hc-step-enter space-y-4 border-t px-3.5 py-3.5">
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Things to switch
                    </p>
                    <div className="grid grid-cols-1 items-start gap-2 lg:grid-cols-2">
                      {PLANNER_LOAD_CATEGORIES.map((category) => (
                        <DeviceCounter key={category} room={room} category={category} update={update} />
                      ))}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Sensors
                    </p>
                    <div className="grid grid-cols-1 items-start gap-2 lg:grid-cols-2">
                      {PLANNER_SENSOR_CATEGORIES.map((category) => (
                        <DeviceCounter key={category} room={room} category={category} update={update} />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — installation
// ---------------------------------------------------------------------------

function ToggleRow({
  id,
  title,
  description,
  checked,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border bg-card px-3 py-2.5">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{description}</span>
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </div>
  );
}

function InstallationStep({
  draft,
  update,
  hasSensors,
}: {
  draft: PlannerDraft;
  update: UpdateDraft;
  hasSensors: boolean;
}) {
  const ids = useId();
  const cableId = `${ids}-cable`;
  return (
    <div className="space-y-6">
      <ChoiceGroup
        legend="Is there Wi-Fi where the controllers will be installed?"
        hint="Controllers connect to HomecoreOS over Wi-Fi, so the planner needs this answer."
        required
        value={draft.wifi}
        choices={WIFI_CHOICES}
        onChange={(wifi) => update((d) => ({ ...d, wifi }))}
      />

      <ChoiceGroup
        legend="Do the controllers need a wired network connection (Ethernet)?"
        value={draft.ethernet}
        choices={ETHERNET_CHOICES}
        columns="sm:grid-cols-3"
        onChange={(ethernet) => update((d) => ({ ...d, ethernet }))}
      />

      <ChoiceGroup
        legend="Where will the controllers sit?"
        hint="Used for enclosure and safety advice."
        value={draft.environment}
        choices={ENVIRONMENT_CHOICES}
        onChange={(environment) => update((d) => ({ ...d, environment }))}
      />

      <ChoiceGroup
        legend="How will sensors connect?"
        hint={
          hasSensors
            ? "Choose how your sensors reach the controller."
            : "You have not listed any sensors, so this only matters if you add some."
        }
        value={draft.sensorWiring}
        choices={SENSOR_WIRING_CHOICES}
        onChange={(sensorWiring) => update((d) => ({ ...d, sensorWiring }))}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2.5">
        <label htmlFor={cableId} className="min-w-0 cursor-pointer">
          <span className="block text-sm font-medium text-foreground">
            Longest cable from a controller to a sensor
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            A rough length in meters. Leave empty if you do not know yet.
          </span>
        </label>
        <div className="flex items-center gap-1.5">
          <Input
            id={cableId}
            type="number"
            inputMode="numeric"
            min={0}
            max={PLANNER_INPUT_LIMITS.maxCableRunMeters}
            placeholder="—"
            value={draft.maxCableRunMeters === null ? "" : String(draft.maxCableRunMeters)}
            onChange={(e) => {
              const text = e.target.value.trim();
              const parsed = Number(text);
              update((d) => ({
                ...d,
                maxCableRunMeters:
                  text === "" || !Number.isFinite(parsed)
                    ? null
                    : Math.max(
                        0,
                        Math.min(PLANNER_INPUT_LIMITS.maxCableRunMeters, Math.trunc(parsed))
                      ),
              }));
            }}
            className="h-8 w-20 text-right tabular-nums"
          />
          <span className="text-xs text-muted-foreground">m</span>
        </div>
      </div>

      <div className="space-y-2">
        <SectionTitle title="What may the plan include?" />
        <ToggleRow
          id={`${ids}-controllers`}
          title="More than one controller"
          description="Allow the plan to split your home across several controllers when one is not enough."
          checked={draft.allowAdditionalControllers}
          onChange={(next) => update((d) => ({ ...d, allowAdditionalControllers: next }))}
        />
        <ToggleRow
          id={`${ids}-relays`}
          title="External relay modules"
          description="Lights, fans, pumps and appliances are switched through separate relay modules wired to the controller."
          checked={draft.allowExternalRelayModules}
          onChange={(next) => update((d) => ({ ...d, allowExternalRelayModules: next }))}
        />
      </div>

      <div className="space-y-2">
        <SectionTitle
          title="Room to grow (optional)"
          description="Reserve spare connections for things you may add later. The planner tells you whether each option leaves that much room."
        />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Extra switched devices</p>
              <p className="text-xs text-muted-foreground">Lights, sockets or appliances.</p>
            </div>
            <CountStepper
              label="Extra switched devices for the future"
              value={draft.futureOutputs}
              max={PLANNER_INPUT_LIMITS.maxFutureChannels}
              onChange={(next) => update((d) => ({ ...d, futureOutputs: next }))}
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Extra sensors</p>
              <p className="text-xs text-muted-foreground">Motion, door or other sensors.</p>
            </div>
            <CountStepper
              label="Extra sensors for the future"
              value={draft.futureInputs}
              max={PLANNER_INPUT_LIMITS.maxFutureChannels}
              onChange={(next) => update((d) => ({ ...d, futureInputs: next }))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — review
// ---------------------------------------------------------------------------

function choiceLabel<T extends string>(choices: Choice<T>[], value: T | null): string {
  return choices.find((choice) => choice.value === value)?.label ?? "Not answered";
}

function ReviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

function ReviewStep({
  draft,
  normalized,
  onGoToStep,
}: {
  draft: PlannerDraft;
  normalized: PlannerNormalizedRequirements;
  onGoToStep: (step: number) => void;
}) {
  const blocking = normalized.missing.filter((item) => item.blocking);
  const optional = normalized.missing.filter((item) => !item.blocking);
  const totals = normalized.totals;
  const listed = [...PLANNER_LOAD_CATEGORIES, ...PLANNER_SENSOR_CATEGORIES].filter(
    (category) => totals.byCategory[category].quantity > 0
  );

  return (
    <div className="space-y-4">
      {blocking.length > 0 ? (
        <StatusAlert tone="warning" title="A few answers are still missing">
          <ul className="mt-1 space-y-1.5">
            {blocking.map((item) => (
              <li key={item.code} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">{item.message}</span>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => onGoToStep(plannerStepNumber(item.step))}
                >
                  Fix this
                </Button>
              </li>
            ))}
          </ul>
        </StatusAlert>
      ) : (
        <StatusAlert tone="success" title="Everything needed for an analysis is here">
          The planner will check these requirements against the boards and firmware HomecoreOS
          currently offers.
        </StatusAlert>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border bg-card px-3.5 py-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Home and devices</h3>
            <Button type="button" variant="ghost" size="xs" onClick={() => onGoToStep(2)}>
              Edit
            </Button>
          </div>
          <dl className="mt-1 divide-y">
            <ReviewRow label="Floors" value={totals.floors} />
            <ReviewRow label="Rooms" value={totals.rooms} />
            <ReviewRow label="Devices" value={totals.physicalDevices} />
            <ReviewRow
              label="Controller connections needed"
              value={
                <span title="Each separately switched device or sensor uses one connection; a curtain uses two.">
                  {totals.gpioChannels}
                </span>
              }
            />
            {listed.map((category) => {
              const count = totals.byCategory[category];
              const meta = PLANNER_CATEGORY_META[category];
              return (
                <ReviewRow
                  key={category}
                  label={meta.label}
                  value={
                    meta.group === "load" && count.independent !== count.quantity
                      ? `${count.quantity} (${plural(count.independent, "control")})`
                      : count.quantity
                  }
                />
              );
            })}
          </dl>
        </div>

        <div className="rounded-xl border bg-card px-3.5 py-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Installation</h3>
            <Button type="button" variant="ghost" size="xs" onClick={() => onGoToStep(3)}>
              Edit
            </Button>
          </div>
          <dl className="mt-1 divide-y">
            <ReviewRow label="Wi-Fi at the controllers" value={choiceLabel(WIFI_CHOICES, draft.wifi)} />
            <ReviewRow label="Wired network" value={choiceLabel(ETHERNET_CHOICES, draft.ethernet)} />
            <ReviewRow
              label="Location"
              value={choiceLabel(ENVIRONMENT_CHOICES, draft.environment)}
            />
            <ReviewRow
              label="Sensor connection"
              value={choiceLabel(SENSOR_WIRING_CHOICES, draft.sensorWiring)}
            />
            <ReviewRow
              label="Longest sensor cable"
              value={draft.maxCableRunMeters === null ? "Not given" : `${draft.maxCableRunMeters} m`}
            />
            <ReviewRow
              label="Controller locations"
              value={
                draft.locations.length === 0 ? "One central location" : draft.locations.length
              }
            />
            <ReviewRow
              label="Several controllers"
              value={draft.allowAdditionalControllers ? "Allowed" : "Not allowed"}
            />
            <ReviewRow
              label="Relay modules"
              value={draft.allowExternalRelayModules ? "Allowed" : "Not allowed"}
            />
            <ReviewRow
              label="Reserved for later"
              value={
                draft.futureOutputs + draft.futureInputs === 0
                  ? "Nothing"
                  : `${plural(draft.futureOutputs, "switched device")}, ${plural(
                      draft.futureInputs,
                      "sensor"
                    )}`
              }
            />
          </dl>
        </div>
      </div>

      {(optional.length > 0 || normalized.adjustments.length > 0) && (
        <div className="rounded-xl border border-dashed bg-card/60 px-3.5 py-3">
          <h3 className="text-xs font-semibold text-foreground">
            Optional details that would sharpen the result
          </h3>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
            {optional.map((item) => (
              <li key={item.code + item.message}>{item.message}</li>
            ))}
            {normalized.adjustments.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wizard shell
// ---------------------------------------------------------------------------

export interface PlannerWizardProps {
  draft: PlannerDraft;
  /** The same requirements run through the shared normalizer, for live totals. */
  normalized: PlannerNormalizedRequirements;
  step: number;
  onStepChange: (step: number) => void;
  onUpdate: UpdateDraft;
  onAnalyze: () => void;
  onReset: () => void;
  busy?: boolean;
}

export function PlannerWizard({
  draft,
  normalized,
  step,
  onStepChange,
  onUpdate,
  onAnalyze,
  onReset,
  busy = false,
}: PlannerWizardProps) {
  const totalSteps = PLANNER_WIZARD_STEPS.length;
  const current = PLANNER_WIZARD_STEPS[step - 1] ?? PLANNER_WIZARD_STEPS[0];
  const totals = normalized.totals;
  const hasInput = draft.rooms.length > 0 || draft.locations.length > 0 || draft.wifi !== null;

  return (
    <Frame spacing="sm">
      <FramePanel className="min-w-0 space-y-5">
        <Stepper value={step} onValueChange={onStepChange} className="w-full min-w-0">
          <StepperNav aria-label="Planner steps" className="gap-1">
            {PLANNER_WIZARD_STEPS.map((item, index) => {
              const number = index + 1;
              return (
                <StepperItem key={item.id} step={number} className="min-w-0">
                  <StepperTrigger
                    aria-label={`Step ${number}: ${item.title}`}
                    className="min-w-0 rounded-lg px-1.5 py-1"
                  >
                    <StepperIndicator className="size-6 text-[11px] font-semibold">
                      {number < step ? <RiCheckLine className="size-3.5" aria-hidden="true" /> : number}
                    </StepperIndicator>
                    <span className="hidden min-w-0 text-left sm:block">
                      <StepperTitle className="truncate text-xs font-semibold">
                        {item.title}
                      </StepperTitle>
                    </span>
                  </StepperTrigger>
                  {number < totalSteps && <StepperSeparator className="mx-1" />}
                </StepperItem>
              );
            })}
          </StepperNav>
        </Stepper>

        <div className="space-y-1 border-b pb-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-primary">
            Step {step} of {totalSteps}
          </p>
          <h2 className="text-lg font-bold tracking-tight text-foreground">{current.title}</h2>
          <p className="text-xs text-muted-foreground">{current.hint}</p>
        </div>

        <div
          key={step}
          id={`stepper-panel-${step}`}
          role="tabpanel"
          aria-labelledby={`stepper-tab-${step}`}
          className="hc-step-enter min-w-0"
        >
          {step === 1 && <HomeStep draft={draft} update={onUpdate} />}
          {step === 2 && <DevicesStep draft={draft} update={onUpdate} onGoToStep={onStepChange} />}
          {step === 3 && (
            <InstallationStep draft={draft} update={onUpdate} hasSensors={totals.sensors > 0} />
          )}
          {step === 4 && (
            <ReviewStep draft={draft} normalized={normalized} onGoToStep={onStepChange} />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <p
            className="text-xs tabular-nums text-muted-foreground"
            data-testid="planner-running-totals"
          >
            {plural(totals.rooms, "room")} · {plural(totals.physicalDevices, "device")} ·{" "}
            {plural(totals.gpioChannels, "controller connection")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {hasInput && (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onReset}>
                Start over
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={step <= 1 || busy}
              onClick={() => onStepChange(step - 1)}
            >
              <RiArrowLeftLine aria-hidden="true" />
              Back
            </Button>
            {step < totalSteps ? (
              <Button type="button" size="sm" onClick={() => onStepChange(step + 1)}>
                Next
                <RiArrowRightLine aria-hidden="true" />
              </Button>
            ) : (
              <Button type="button" size="sm" disabled={busy} onClick={onAnalyze}>
                <RiMagicLine aria-hidden="true" />
                Analyze my home
              </Button>
            )}
          </div>
        </div>
      </FramePanel>
    </Frame>
  );
}
