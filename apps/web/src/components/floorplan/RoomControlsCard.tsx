import { useMemo, useState, type ReactNode } from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { RiCloseLine, RiEditLine } from "@remixicon/react";
import { isDeviceStateActive, type RoomType } from "@homecoreos/shared";
import { isEntityOnline } from "@/lib/board-pin-helpers";
import { formatShortTime } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ControllerItem,
  DeviceItem,
  RoomItem,
  SensorItem,
  SwitchItem,
} from "@/features/types";
import { isLightingFixture } from "./floor-visuals";

const FAN_SPEED_STEPS = [1, 2, 3, 4, 5] as const;
type FanSpeedStep = (typeof FAN_SPEED_STEPS)[number];

/** Smooth pill switch styled with Homecore's primary and input theme tokens. */
function RoomPillSwitch({
  checked,
  onCheckedChange,
  disabled,
  ariaLabel,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      data-slot="room-pill-switch"
      className={cn(
        "peer relative inline-flex h-[26px] w-[46px] shrink-0 cursor-pointer items-center rounded-full p-[3px] transition-colors duration-200 outline-none",
        "focus-visible:ring-3 focus-visible:ring-ring/50",
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-[20px] rounded-full bg-background shadow-xs ring-0 transition-transform duration-200",
          "dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground",
          "data-[state=checked]:translate-x-[20px] data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  );
}

/** Minimal outline room icon tile (couch, bed, kitchen, bath, desk, garage, home). */
function RoomTypeOutlineIcon({ roomType }: { roomType: RoomType }) {
  switch (roomType) {
    case "living_room":
      return (
        <svg viewBox="0 0 28 28" fill="none" className="size-6" aria-hidden="true">
          <path
            d="M6.5 13V10.5C6.5 9.12 7.62 8 9 8H19C20.38 8 21.5 9.12 21.5 10.5V13"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M4.5 14.5C4.5 13.4 5.4 12.5 6.5 12.5C7.6 12.5 8.5 13.4 8.5 14.5V16H19.5V14.5C19.5 13.4 20.4 12.5 21.5 12.5C22.6 12.5 23.5 13.4 23.5 14.5V18.5C23.5 19.33 22.83 20 22 20H6C5.17 20 4.5 19.33 4.5 18.5V14.5Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M7.5 20V21.75M20.5 20V21.75"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      );
    case "bedroom":
      return (
        <svg viewBox="0 0 28 28" fill="none" className="size-6" aria-hidden="true">
          <path
            d="M4.5 14.5V10.5C4.5 9.4 5.4 8.5 6.5 8.5H21.5C22.6 8.5 23.5 9.4 23.5 10.5V14.5"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <rect x="7" y="11" width="5.5" height="3.5" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
          <rect x="15.5" y="11" width="5.5" height="3.5" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M4 15.5C4 14.95 4.45 14.5 5 14.5H23C23.55 14.5 24 14.95 24 15.5V19.5H4V15.5Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path d="M6.5 19.5V21.5M21.5 19.5V21.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      );
    case "kitchen":
    case "dining":
      return (
        <svg viewBox="0 0 28 28" fill="none" className="size-6" aria-hidden="true">
          <rect x="5" y="6" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
          <path d="M5 11.5H23" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="9.5" cy="8.75" r="0.9" fill="currentColor" />
          <circle cx="14" cy="8.75" r="0.9" fill="currentColor" />
          <circle cx="18.5" cy="8.75" r="0.9" fill="currentColor" />
          <rect x="8.5" y="14.5" width="11" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "bathroom":
      return (
        <svg viewBox="0 0 28 28" fill="none" className="size-6" aria-hidden="true">
          <path
            d="M5 14H23V16.5C23 18.99 20.99 21 18.5 21H9.5C7.01 21 5 18.99 5 16.5V14Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path
            d="M7.5 14V8.5C7.5 7.4 8.4 6.5 9.5 6.5C10.6 6.5 11.5 7.4 11.5 8.5V9"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <path d="M8.5 21V22.5M19.5 21V22.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      );
    case "office":
      return (
        <svg viewBox="0 0 28 28" fill="none" className="size-6" aria-hidden="true">
          <rect x="5" y="6.5" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.7" />
          <path d="M11 21.5H17M14 18.5V21.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      );
    case "garage":
      return (
        <svg viewBox="0 0 28 28" fill="none" className="size-6" aria-hidden="true">
          <path
            d="M4.5 11.5L14 6L23.5 11.5V21.5H4.5V11.5Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path d="M8.5 21.5V14.5H19.5V21.5M8.5 17.5H19.5" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 28 28" fill="none" className="size-6" aria-hidden="true">
          <path
            d="M5 12.5L14 5.5L23 12.5V21C23 21.55 22.55 22 22 22H6C5.45 22 5 21.55 5 21V12.5Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path d="M11.5 22V15.5H16.5V22" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      );
  }
}

/** Crisp outline sensor icons matching the thermometer & droplet pill style. */
function SensorOutlineIcon({ sensorType, name }: { sensorType: string; name: string }) {
  const key = `${sensorType} ${name}`.toLowerCase();
  if (key.includes("temp")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" className="size-[22px]" aria-hidden="true">
        <path
          d="M14 13.76V5a2 2 0 1 0-4 0v8.76a4 4 0 1 0 4 0Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="17" r="1.4" fill="currentColor" />
        <path d="M12 10.5V15.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (key.includes("humid") || key.includes("moist") || key.includes("water")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" className="size-[22px]" aria-hidden="true">
        <path
          d="M12 3.5C12 3.5 6.2 10.1 6.2 14.3a5.8 5.8 0 0 0 11.6 0C17.8 10.1 12 3.5 12 3.5Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M9.6 15.2a2.6 2.6 0 0 0 2.4 2.3"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (key.includes("light") || key.includes("lux")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" className="size-[22px]" aria-hidden="true">
        <circle cx="12" cy="12" r="3.6" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (key.includes("power") || key.includes("volt") || key.includes("energy") || key.includes("curr")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" className="size-[22px]" aria-hidden="true">
        <path
          d="M13 3L5.5 13.5H12L11 21L18.5 10.5H12L13 3Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-[22px]" aria-hidden="true">
      <path
        d="M3.5 12H7.2L9.5 6.8L13.5 17.2L16.2 12H20.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Progressive 5-step fan blade glyph (3 delicate -> 3 medium -> 3 bold -> 4 medium -> 4 full). */
function FanSpeedBladeIcon({ level }: { level: FanSpeedStep }) {
  const blades = level <= 3 ? 3 : 4;
  const angles = blades === 3 ? [0, 120, 240] : [0, 90, 180, 270];
  const scale =
    level === 1 ? 0.62 : level === 2 ? 0.78 : level === 3 ? 0.92 : level === 4 ? 0.92 : 1;

  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className="size-5 transition-transform duration-150"
      aria-hidden="true"
    >
      <g transform={`translate(12 12) scale(${scale}) translate(-12 -12)`}>
        {angles.map((deg) => (
          <path
            key={deg}
            d="M12 11.2C10.5 8.8 10.8 5.2 12.6 4.4C14.3 3.7 15.8 5.4 15.3 7.6C14.9 9.4 13.4 10.7 12 11.2Z"
            transform={`rotate(${deg} 12 12)`}
          />
        ))}
        <circle cx="12" cy="12" r={level <= 2 ? 1.45 : 1.75} />
      </g>
    </svg>
  );
}

/** Control row icon for lights, fans, outlets, locks, TVs, and general devices. */
function ControlItemIcon({
  kind,
  active,
}: {
  kind: "light" | "fan" | "device";
  active: boolean;
}) {
  if (kind === "fan") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className="size-5 shrink-0" aria-hidden="true">
        {[0, 90, 180, 270].map((deg) => (
          <path
            key={deg}
            d="M12 11.2C10.3 8.8 10.7 5.0 12.7 4.2C14.6 3.5 16.2 5.3 15.6 7.7C15.1 9.5 13.5 10.8 12 11.2Z"
            transform={`rotate(${deg} 12 12)`}
          />
        ))}
        <circle cx="12" cy="12" r="1.8" />
      </svg>
    );
  }
  if (kind === "light") {
    return (
      <svg viewBox="0 0 24 24" fill="none" className="size-5 shrink-0" aria-hidden="true">
        <path
          d="M9.5 15.6C7.7 14.5 6.5 12.6 6.5 10.4A5.5 5.5 0 1 1 17.5 10.4c0 2.2-1.2 4.1-3 5.2-.4.25-.65.7-.65 1.18V17.5a1 1 0 0 1-1 1h-1.7a1 1 0 0 1-1-1v-.72c0-.48-.25-.93-.65-1.18Z"
          fill={active ? "currentColor" : "none"}
          fillOpacity={active ? 0.24 : 0}
          stroke="currentColor"
          strokeWidth="1.65"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M10.2 20.6h3.6"
          stroke="currentColor"
          strokeWidth="1.65"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-5 shrink-0" aria-hidden="true">
      <path
        d="M12 4.5V11.5M8.2 6.6a6.5 6.5 0 1 0 7.6 0"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function isFanDevice(dev: DeviceItem): boolean {
  return dev.device_type.toLowerCase() === "fan" || /\bfan\b/i.test(dev.name);
}

function parseFanSpeedFromState(
  state: string | null | undefined,
  fallbackActiveSpeed: FanSpeedStep
): FanSpeedStep | null {
  if (!isDeviceStateActive(state)) return null;
  const normalized = (state ?? "").trim().toLowerCase();
  const match = normalized.match(/^speed_([1-5])$/);
  if (match) return Number(match[1]) as FanSpeedStep;
  if (normalized === "low") return 1;
  if (normalized === "medium") return 3;
  if (normalized === "high") return 5;
  return fallbackActiveSpeed;
}

function formatSensorMetricValue(sensor: SensorItem): string {
  if (sensor.last_value === null || sensor.last_value === undefined) return "—";
  const unit = (sensor.unit ?? "").trim();
  if (!unit) return String(sensor.last_value);
  if (unit.startsWith("°") || unit === "%") {
    return `${sensor.last_value}${unit}`;
  }
  return `${sensor.last_value} ${unit}`;
}

function formatSensorMetricLabel(sensor: SensorItem): string {
  const lower = sensor.name.trim().toLowerCase();
  if (lower.includes("temp")) return "Temperature";
  if (lower.includes("humid")) return "Humidity";
  return sensor.name;
}

export interface UnassignedHardwareOption {
  key: string;
  kind: "switch" | "device" | "sensor";
  id: string;
  label: string;
}

export function RoomControlsCard({
  room,
  roomType,
  switches,
  devices,
  sensors,
  ctrlById,
  timezone,
  canEdit,
  canOperate,
  pendingIds,
  batchPending,
  isFullscreen,
  isWideOrFullscreen,
  showCloseButton = false,
  unassignedItems,
  assignTargetId,
  onAssignTargetChange,
  onAssignToRoom,
  onToggleSwitch,
  onToggleDevice,
  onSetDeviceState,
  onBatchLights,
  onEditRoom,
  onClosePopup,
}: {
  room: RoomItem;
  roomType: RoomType;
  switches: SwitchItem[];
  devices: DeviceItem[];
  sensors: SensorItem[];
  ctrlById: Map<string, ControllerItem>;
  timezone: string;
  canEdit: boolean;
  canOperate: boolean;
  pendingIds: Record<string, boolean>;
  batchPending: boolean;
  isFullscreen: boolean;
  isWideOrFullscreen: boolean;
  showCloseButton?: boolean;
  unassignedItems: UnassignedHardwareOption[];
  assignTargetId: string;
  onAssignTargetChange: (value: string) => void;
  onAssignToRoom: () => void;
  onToggleSwitch: (sw: SwitchItem, explicitIsOn?: boolean) => void;
  onToggleDevice: (dev: DeviceItem, explicitOn?: boolean) => void;
  onSetDeviceState: (dev: DeviceItem, targetState: string) => void;
  onBatchLights: (
    targets: { switches: SwitchItem[]; devices: DeviceItem[] },
    turnOn: boolean
  ) => void;
  onEditRoom: () => void;
  onClosePopup?: () => void;
}) {
  const [selectedFanId, setSelectedFanId] = useState<string | null>(null);
  const [lastSpeedByFanId, setLastSpeedByFanId] = useState<Record<string, FanSpeedStep>>({});

  const lightDevices = useMemo(
    () => devices.filter((d) => isLightingFixture("device", d.device_type)),
    [devices]
  );
  const fanDevices = useMemo(
    () => devices.filter((d) => !isLightingFixture("device", d.device_type) && isFanDevice(d)),
    [devices]
  );
  const otherDevices = useMemo(
    () => devices.filter((d) => !isLightingFixture("device", d.device_type) && !isFanDevice(d)),
    [devices]
  );

  const totalLightsCount = switches.length + lightDevices.length;
  const anyControlOn =
    switches.some((s) => s.is_on) ||
    devices.some((d) => isDeviceStateActive(d.state));

  const hasControllableItems = switches.length > 0 || devices.length > 0;

  const headerSubtitle = useMemo(() => {
    const parts: string[] = [];
    if (totalLightsCount > 0) {
      parts.push(`${totalLightsCount} ${totalLightsCount === 1 ? "Light" : "Lights"}`);
    }
    if (fanDevices.length > 0) {
      parts.push(`${fanDevices.length} ${fanDevices.length === 1 ? "Fan" : "Fans"}`);
    }
    if (otherDevices.length > 0) {
      parts.push(
        `${otherDevices.length} ${otherDevices.length === 1 ? "Device" : "Devices"}`
      );
    }
    if (parts.length > 0) return parts.join(" · ");
    if (sensors.length > 0) {
      return `${sensors.length} ${sensors.length === 1 ? "Sensor" : "Sensors"}`;
    }
    return "No devices assigned";
  }, [totalLightsCount, fanDevices.length, otherDevices.length, sensors.length]);

  const activeFan = useMemo(() => {
    if (fanDevices.length === 0) return null;
    if (selectedFanId) {
      const found = fanDevices.find((f) => f.id === selectedFanId);
      if (found) return found;
    }
    return fanDevices.find((f) => isDeviceStateActive(f.state)) ?? fanDevices[0]!;
  }, [fanDevices, selectedFanId]);

  const activeFanSpeed = activeFan
    ? parseFanSpeedFromState(activeFan.state, lastSpeedByFanId[activeFan.id] ?? 5)
    : null;

  // Whole-room master ON/OFF: toggles every switch and every device assigned to this room.
  const handleMasterToggle = (nextChecked: boolean) => {
    if (!hasControllableItems) return;
    onBatchLights({ switches, devices }, nextChecked);
  };

  const handleSelectFanSpeed = (fan: DeviceItem, step: FanSpeedStep) => {
    setLastSpeedByFanId((prev) => ({ ...prev, [fan.id]: step }));
    onSetDeviceState(fan, `speed_${step}`);
  };

  // Ordered control rows: Lights/Switches -> Fans -> Other Devices
  const orderedRows: Array<{
    key: string;
    name: string;
    kind: "light" | "fan" | "device";
    active: boolean;
    online: boolean;
    pending: boolean;
    metaTitle: string;
    onToggle: (checked: boolean) => void;
  }> = [
    ...switches.map((sw) => {
      const online = isEntityOnline(sw.is_online, ctrlById.get(sw.board_instance_id));
      return {
        key: `sw:${sw.id}`,
        name: sw.name,
        kind: "light" as const,
        active: sw.is_on,
        online,
        pending: Boolean(pendingIds[sw.id]),
        metaTitle: `${sw.name} · GPIO ${sw.gpio_pin} · ${online ? "Online" : "Offline"}`,
        onToggle: (checked: boolean) => onToggleSwitch(sw, checked),
      };
    }),
    ...lightDevices.map((dev) => {
      const online = isEntityOnline(dev.is_online, ctrlById.get(dev.board_instance_id));
      return {
        key: `dev:${dev.id}`,
        name: dev.name,
        kind: "light" as const,
        active: isDeviceStateActive(dev.state),
        online,
        pending: Boolean(pendingIds[dev.id]),
        metaTitle: `${dev.name} (${dev.device_type}) · GPIO ${dev.gpio_pin} · ${online ? "Online" : "Offline"}`,
        onToggle: (checked: boolean) => onToggleDevice(dev, checked),
      };
    }),
    ...fanDevices.map((dev) => {
      const online = isEntityOnline(dev.is_online, ctrlById.get(dev.board_instance_id));
      return {
        key: `dev:${dev.id}`,
        name: dev.name,
        kind: "fan" as const,
        active: isDeviceStateActive(dev.state),
        online,
        pending: Boolean(pendingIds[dev.id]),
        metaTitle: `${dev.name} (${dev.device_type}) · GPIO ${dev.gpio_pin} · ${online ? "Online" : "Offline"}`,
        onToggle: (checked: boolean) => {
          if (checked) {
            const remembered = lastSpeedByFanId[dev.id];
            if (remembered) {
              onSetDeviceState(dev, `speed_${remembered}`);
              return;
            }
          }
          onToggleDevice(dev, checked);
        },
      };
    }),
    ...otherDevices.map((dev) => {
      const online = isEntityOnline(dev.is_online, ctrlById.get(dev.board_instance_id));
      return {
        key: `dev:${dev.id}`,
        name: dev.name,
        kind: "device" as const,
        active: isDeviceStateActive(dev.state),
        online,
        pending: Boolean(pendingIds[dev.id]),
        metaTitle: `${dev.name} (${dev.device_type}) · GPIO ${dev.gpio_pin} · ${online ? "Online" : "Offline"}`,
        onToggle: (checked: boolean) => onToggleDevice(dev, checked),
      };
    }),
  ];

  const renderSection = (content: ReactNode) => content;

  return (
    <div
      data-testid="room-controls-panel"
      className="flex min-h-0 flex-1 flex-col bg-card text-card-foreground"
    >
      {/* Header Row: Room Icon Tile + Title/Subtitle + Whole-Room Master Switch */}
      <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40 text-foreground">
            <RoomTypeOutlineIcon roomType={roomType} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold leading-tight tracking-tight text-foreground">
              {room.name}
            </h3>
            <p className="mt-0.5 truncate text-xs font-normal text-muted-foreground">
              {headerSubtitle}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {canEdit && (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Edit Room"
              title="Edit Room"
              className="size-7 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onEditRoom}
            >
              <RiEditLine className="size-3.5" aria-hidden="true" />
            </Button>
          )}
          {showCloseButton && onClosePopup && (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Close room controls popup"
              className="size-7 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onClosePopup}
            >
              <RiCloseLine className="size-4" aria-hidden="true" />
            </Button>
          )}
          {hasControllableItems && (
            <RoomPillSwitch
              checked={anyControlOn}
              disabled={!canOperate || batchPending}
              onCheckedChange={handleMasterToggle}
              ariaLabel={
                anyControlOn
                  ? `Turn off ${room.name}`
                  : `Turn on ${room.name}`
              }
            />
          )}
        </div>
      </div>

      {/* Scrollable Body: Sensor Metric Pills -> Fan Speed Dial -> Control Rows */}
      <div
        className={cn(
          "flex-1 space-y-4 overflow-y-auto px-4 pb-4",
          isFullscreen
            ? "min-h-0"
            : isWideOrFullscreen
              ? "max-h-[380px]"
              : "max-h-[450px]"
        )}
      >
        {/* 2-Column Sensor Metric Pills (Temperature, Humidity, etc.) */}
        {sensors.length > 0 &&
          renderSection(
            <div className="grid grid-cols-2 gap-2.5" data-testid="room-sensor-pills">
              {sensors.map((sensor) => {
                const online = isEntityOnline(
                  sensor.is_online,
                  ctrlById.get(sensor.board_instance_id)
                );
                const readingStamp = sensor.last_reading_at
                  ? formatShortTime(sensor.last_reading_at, timezone)
                  : "Awaiting telemetry";
                return (
                  <div
                    key={sensor.id}
                    title={`${sensor.name} · ${online ? "Live" : "Offline"} · ${readingStamp}`}
                    className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border bg-muted/35 px-3 py-2.5 transition-colors"
                  >
                    <span
                      className={cn(
                        "shrink-0",
                        online ? "text-foreground/85" : "text-muted-foreground/70"
                      )}
                    >
                      <SensorOutlineIcon sensorType={sensor.sensor_type} name={sensor.name} />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-normal leading-tight text-muted-foreground">
                        {formatSensorMetricLabel(sensor)}
                      </p>
                      <p className="mt-0.5 truncate text-[15px] font-semibold leading-tight tabular-nums text-foreground">
                        {formatSensorMetricValue(sensor)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

        {/* Fan Control 5-Speed Circular Dial */}
        {activeFan &&
          renderSection(
            <div className="space-y-2.5" data-testid="room-fan-control">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold tracking-tight text-foreground">
                  Fan Control
                </h4>
                {fanDevices.length > 1 && (
                  <div className="flex flex-wrap items-center gap-1">
                    {fanDevices.map((fan) => {
                      const selected = fan.id === activeFan.id;
                      return (
                        <button
                          key={fan.id}
                          type="button"
                          onClick={() => setSelectedFanId(fan.id)}
                          className={cn(
                            "cursor-pointer rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors",
                            selected
                              ? "bg-primary/15 text-primary"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground"
                          )}
                        >
                          {fan.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div
                role="group"
                aria-label={`${activeFan.name} speed control`}
                className="grid grid-cols-5 gap-1.5"
              >
                {FAN_SPEED_STEPS.map((step) => {
                  const isSelected = activeFanSpeed === step;
                  const isPending = Boolean(pendingIds[activeFan.id]);
                  return (
                    <button
                      key={step}
                      type="button"
                      aria-pressed={isSelected}
                      aria-label={`${activeFan.name} Speed ${step}`}
                      disabled={!canOperate || isPending}
                      onClick={() => handleSelectFanSpeed(activeFan, step)}
                      className="group flex flex-col items-center gap-1.5 outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span
                        className={cn(
                          "flex size-10 items-center justify-center rounded-full border transition-all duration-150",
                          "group-focus-visible:ring-3 group-focus-visible:ring-ring/50",
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground shadow-sm"
                            : "border-border bg-muted/40 text-foreground/80 group-hover:border-primary/40 group-hover:bg-primary/10"
                        )}
                      >
                        <FanSpeedBladeIcon level={step} />
                      </span>
                      <span
                        className={cn(
                          "text-[11px] leading-none transition-colors",
                          isSelected
                            ? "font-medium text-foreground"
                            : "font-normal text-muted-foreground"
                        )}
                      >
                        Speed {step}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

        {/* Control Rows (Lights, Fans, Devices) */}
        <div className="space-y-2" data-testid="room-control-rows">
          {orderedRows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-xs text-muted-foreground">
              No lights, switches, or devices assigned to this room yet.
            </p>
          ) : (
            orderedRows.map((row) => (
              <div
                key={row.key}
                title={row.metaTitle}
                data-active={row.active ? "true" : "false"}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 transition-colors duration-200",
                  row.active
                    ? "border-primary/30 bg-primary/10 text-foreground dark:border-primary/35 dark:bg-primary/15"
                    : "border-border bg-muted/30 text-foreground hover:bg-muted/50"
                )}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center transition-colors",
                      row.active
                        ? "text-primary"
                        : "text-muted-foreground"
                    )}
                  >
                    <ControlItemIcon kind={row.kind} active={row.active} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium leading-tight text-foreground">
                      {row.name}
                    </p>
                    {!row.online && (
                      <p className="mt-0.5 text-[10px] leading-none text-muted-foreground">
                        Offline
                      </p>
                    )}
                  </div>
                </div>

                <RoomPillSwitch
                  checked={row.active}
                  disabled={!canOperate || row.pending}
                  onCheckedChange={row.onToggle}
                  ariaLabel={`Toggle ${row.name}`}
                />
              </div>
            ))
          )}
        </div>
      </div>

      {/* Assign Unassigned Hardware Footer */}
      {canEdit && unassignedItems.length > 0 && (
        <div className="space-y-2 border-t border-border bg-muted/30 px-4 py-3">
          <p className="text-[11px] font-medium text-muted-foreground">
            Assign unassigned hardware to {room.name}
          </p>
          <div className="flex gap-2">
            <Select value={assignTargetId} onValueChange={onAssignTargetChange}>
              <SelectTrigger
                aria-label="Select unassigned hardware"
                size="sm"
                className="flex-1 text-xs"
              >
                <SelectValue placeholder="Select hardware..." />
              </SelectTrigger>
              <SelectContent>
                {unassignedItems.map((it) => (
                  <SelectItem key={it.key} value={it.key}>
                    {it.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="xs"
              className="px-3"
              disabled={!assignTargetId || Object.keys(pendingIds).length > 0}
              onClick={onAssignToRoom}
            >
              Assign
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
