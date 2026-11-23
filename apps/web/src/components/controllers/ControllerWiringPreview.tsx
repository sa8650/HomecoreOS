import { memo, useMemo, useState, type ReactNode } from "react";
import {
  RiCpuLine,
  RiDoorOpenLine,
  RiDropLine,
  RiLightbulbLine,
  RiLockLine,
  RiPlugLine,
  RiPulseLine,
  RiSensorLine,
  RiShutDownLine,
  RiSunLine,
  RiTempColdLine,
  RiToggleLine,
  RiTv2Line,
  RiVolumeUpLine,
  RiWifiLine,
  RiWifiOffLine,
  RiWindyLine,
} from "@remixicon/react";
import { isEntityOnline } from "@/lib/board-pin-helpers";
import { cn } from "cn";
import { Badge } from "@/components/reui/badge";
import { IconTile } from "@/components/reui/icon-tile";
import { EmptyStatePanel } from "@/components/shared/AppUi";
import { BlueprintWiringMap } from "@/components/controllers/BlueprintWiringMap";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type {
  ControllerItem,
  DeviceItem,
  RoomItem,
  SensorItem,
  SwitchItem,
} from "@/features/types";

/* ── Layout constants for the wiring harness ─────────────────────────────── */
const ROW_H = 36;
const ROW_GAP = 6;
const ENTITY_BLOCK = ROW_H + ROW_GAP;
const GUTTER_W = 52;

type EntityKind = "switch" | "device" | "sensor";

interface WireEntity {
  id: string;
  kind: EntityKind;
  name: string;
  pinLabel: string;
  online: boolean;
  icon: ReactNode;
}

function deviceTypeIcon(deviceType: string): ReactNode {
  const t = deviceType.toLowerCase();
  if (t.includes("light")) return <RiLightbulbLine className="size-4" aria-hidden="true" />;
  if (t.includes("dimmer")) return <RiSunLine className="size-4" aria-hidden="true" />;
  if (t.includes("fan")) return <RiWindyLine className="size-4" aria-hidden="true" />;
  if (t.includes("tv")) return <RiTv2Line className="size-4" aria-hidden="true" />;
  if (t.includes("lock")) return <RiLockLine className="size-4" aria-hidden="true" />;
  if (t.includes("valve")) return <RiDropLine className="size-4" aria-hidden="true" />;
  if (t.includes("buzzer")) return <RiVolumeUpLine className="size-4" aria-hidden="true" />;
  if (t.includes("status")) return <RiPulseLine className="size-4" aria-hidden="true" />;
  return <RiPlugLine className="size-4" aria-hidden="true" />; // relay & fallback
}

function sensorTypeIcon(sensorType: string): ReactNode {
  const t = sensorType.toLowerCase();
  if (t.includes("humid")) return <RiDropLine className="size-4" aria-hidden="true" />;
  if (t.includes("temp")) return <RiTempColdLine className="size-4" aria-hidden="true" />;
  if (t.includes("lux") || t.includes("light")) return <RiSunLine className="size-4" aria-hidden="true" />;
  return <RiSensorLine className="size-4" aria-hidden="true" />;
}

function controllerStatusMeta(status: ControllerItem["status"]): {
  label: string;
  dot: string;
  text: string;
} {
  switch (status) {
    case "online":
      return { label: "Online", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" };
    case "pending":
      return { label: "Pending", dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400" };
    case "updating":
      return { label: "Updating", dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400" };
    case "reset_pending":
      return { label: "Reset pending", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" };
    case "disconnected":
      return { label: "Disconnected", dot: "bg-slate-400", text: "text-muted-foreground" };
    default:
      return { label: "Offline", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" };
  }
}

/** Tone of a wire from the controller to one entity, based on real link state. */
function wireTone(controllerStatus: ControllerItem["status"], entityOnline: boolean) {
  if (controllerStatus === "disconnected") {
    return { stroke: "#94a3b8", dash: "2.5 3.5", opacity: 0.75 };
  }
  if (controllerStatus !== "online") {
    return { stroke: "#f59e0b", dash: "4 3", opacity: 0.85 };
  }
  return entityOnline
    ? { stroke: "#10b981", dash: undefined as string | undefined, opacity: 0.9 }
    : { stroke: "#f59e0b", dash: "4 3", opacity: 0.85 };
}

const ControllerStation = memo(function ControllerStation({
  controller,
  roomName,
  parentControllerName,
  switches,
  devices,
  sensors,
  dimmed,
  selected,
  onToggleSelect,
}: {
  controller: ControllerItem;
  roomName: string | null;
  parentControllerName: string | null;
  switches: SwitchItem[];
  devices: DeviceItem[];
  sensors: SensorItem[];
  dimmed: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const status = controllerStatusMeta(controller.status);
  const isNode = controller.board_role === "node";

  const entities = useMemo<WireEntity[]>(() => {
    const list: WireEntity[] = [];
    for (const sw of switches) {
      list.push({
        id: sw.id,
        kind: "switch",
        name: sw.name,
        pinLabel: `GPIO ${sw.gpio_pin}`,
        online: isEntityOnline(sw.is_online, controller),
        icon: <RiToggleLine className="size-4" aria-hidden="true" />,
      });
    }
    for (const dev of devices) {
      list.push({
        id: dev.id,
        kind: "device",
        name: dev.name,
        pinLabel: `GPIO ${dev.gpio_pin}`,
        online: isEntityOnline(dev.is_online, controller),
        icon: deviceTypeIcon(dev.device_type),
      });
    }
    for (const sen of sensors) {
      const pinLabel =
        sen.gpio_pin !== null && sen.gpio_pin !== undefined
          ? `GPIO ${sen.gpio_pin}`
          : sen.i2c_address
            ? `I2C · ${sen.i2c_address}`
            : "I2C / bus";
      list.push({
        id: sen.id,
        kind: "sensor",
        name: sen.name,
        pinLabel,
        online: isEntityOnline(sen.is_online, controller),
        icon: sensorTypeIcon(sen.sensor_type),
      });
    }
    const order: Record<EntityKind, number> = { switch: 0, device: 1, sensor: 2 };
    return list.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  }, [switches, devices, sensors, controller]);

  const bodyH = Math.max(entities.length * ENTITY_BLOCK - ROW_GAP, ROW_H);
  const controllerCenterY = bodyH / 2;
  const pinCount = new Set(
    [...switches.map((s) => `sw:${s.gpio_pin}`), ...devices.map((d) => `dev:${d.gpio_pin}`), ...sensors.filter((s) => s.gpio_pin !== null).map((s) => `sen:${s.gpio_pin}`)]
  ).size;

  return (
    <button
      type="button"
      onClick={() => onToggleSelect(controller.id)}
      aria-pressed={selected}
      aria-label={`${selected ? "Deselect" : "Select"} controller ${controller.name}`}
      data-testid={`controller-station-${controller.id}`}
      className={cn(
        "group flex min-w-0 flex-col rounded-xl border bg-card text-left transition-all duration-200",
        "hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-primary/50 shadow-md ring-2 ring-primary/35"
          : "shadow-none",
        dimmed && "opacity-45 saturate-[.6]"
      )}
    >
      {/* Station header */}
      <div className="flex w-full items-start gap-2.5 border-b px-3 py-2.5">
        <IconTile variant="soft" size="sm" className="shrink-0 text-primary">
          <RiCpuLine className="size-4" aria-hidden="true" />
        </IconTile>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="truncate text-xs font-semibold tracking-tight text-foreground">
            {controller.name}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {controller.board_model} · {controller.chip_variant}
            {controller.firmware_version
              ? ` · v${controller.firmware_version.replace(/^v/, "")}`
              : ""}
          </p>
          <p className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
            {roomName ? (
              <>
                <RiDoorOpenLine className="size-3 shrink-0 opacity-75" aria-hidden="true" />
                <span className="truncate">{roomName}</span>
              </>
            ) : (
              <span className="truncate opacity-80">No room assigned</span>
            )}
            <span className="opacity-45">·</span>
            <span
              className={cn(
                "shrink-0 font-semibold uppercase tracking-wide",
                isNode ? "text-violet-600 dark:text-violet-400" : "text-sky-600 dark:text-sky-400"
              )}
            >
              {isNode ? "Node" : "Controller"}
            </span>
            {isNode && parentControllerName && (
              <>
                <span className="opacity-45">→</span>
                <span className="truncate text-violet-600/90 dark:text-violet-300/90">
                  {parentControllerName}
                </span>
              </>
            )}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-background/60 px-2 py-1 text-[9px] font-bold uppercase tracking-wider",
            status.text
          )}
        >
          <span className={cn("size-1.5 rounded-full", status.dot)} aria-hidden="true" />
          {status.label}
        </span>
      </div>

      {/* Wiring blueprint */}
      {entities.length === 0 ? (
        <div className="m-3 rounded-lg border border-dashed bg-muted/30 px-3 py-4 text-center">
          <p className="text-[11px] font-medium text-muted-foreground">
            No switches, devices, or sensors linked yet
          </p>
        </div>
      ) : (
        <div className="flex w-full items-stretch gap-0 px-3 py-3">
          {/* Controller / Node bus block */}
          <div
            className="flex w-[92px] shrink-0 flex-col items-center justify-center gap-1 rounded-lg border bg-muted/40 px-1.5 py-2 text-center"
            aria-hidden="true"
          >
            <RiCpuLine className={cn("size-5", isNode ? "text-violet-500" : "text-primary")} />
            <p className="text-[9px] font-bold uppercase leading-tight tracking-wider text-foreground/80">
              {isNode ? "Node" : "Controller"}
            </p>
            <p className="w-full truncate font-mono text-[9px] text-muted-foreground" title={controller.board_model}>
              {controller.board_model}
            </p>
            {controller.mqtt_connected ? (
              <RiWifiLine className="size-3 text-emerald-500" />
            ) : (
              <RiWifiOffLine className="size-3 text-muted-foreground/70" />
            )}
          </div>

          {/* Wire harness */}
          <svg
            viewBox={`0 0 ${GUTTER_W} ${bodyH}`}
            width={GUTTER_W}
            height={bodyH}
            className="shrink-0"
            role="img"
            aria-label={`Wiring harness from ${controller.name} to ${entities.length} linked ${entities.length === 1 ? "entity" : "entities"}`}
          >
            {entities.map((entity, index) => {
              const cy = index * ENTITY_BLOCK + ROW_H / 2;
              const tone = wireTone(controller.status, entity.online);
              const midX = GUTTER_W / 2;
              return (
                <path
                  key={entity.id}
                  d={`M 2 ${controllerCenterY} C ${midX} ${controllerCenterY}, ${midX} ${cy}, ${GUTTER_W - 2} ${cy}`}
                  fill="none"
                  stroke={tone.stroke}
                  strokeOpacity={dimmed ? 0.35 : tone.opacity}
                  strokeWidth={1.6}
                  strokeDasharray={tone.dash}
                  strokeLinecap="round"
                />
              );
            })}
            {entities.map((entity, index) => {
              const cy = index * ENTITY_BLOCK + ROW_H / 2;
              const tone = wireTone(controller.status, entity.online);
              return (
                <circle
                  key={`dot-${entity.id}`}
                  cx={GUTTER_W - 2}
                  cy={cy}
                  r={2}
                  fill={tone.stroke}
                  fillOpacity={dimmed ? 0.4 : 0.95}
                />
              );
            })}
          </svg>

          {/* Entity nodes */}
          <div className="min-w-0 flex-1" style={{ rowGap: ROW_GAP, display: "grid" }}>
            {entities.map((entity) => (
              <div
                key={entity.id}
                className="flex min-w-0 items-center gap-1.5 rounded-lg border bg-background/60 px-1.5"
                style={{ height: ROW_H }}
                data-testid={`wire-entity-${entity.id}`}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-md",
                    entity.kind === "sensor"
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : entity.kind === "switch"
                        ? "bg-sky-500/10 text-sky-600 dark:text-sky-400"
                        : "bg-violet-500/10 text-violet-600 dark:text-violet-400"
                  )}
                >
                  {entity.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[10.5px] font-medium leading-tight text-foreground">
                    {entity.name}
                  </span>
                  <span className="block font-mono text-[8.5px] leading-tight text-muted-foreground">
                    {entity.pinLabel}
                  </span>
                </span>
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    entity.online ? "bg-emerald-500" : "bg-amber-400"
                  )}
                  title={entity.online ? "Online" : "Offline"}
                  aria-label={entity.online ? "Online" : "Offline"}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Station footer */}
      <div className="mt-auto flex w-full flex-wrap items-center justify-between gap-x-2 gap-y-0.5 border-t px-3 py-1.5 text-[9.5px] text-muted-foreground">
        <span className="truncate">
          {switches.length} switch{switches.length === 1 ? "" : "es"} · {devices.length} device
          {devices.length === 1 ? "" : "s"} · {sensors.length} sensor{sensors.length === 1 ? "" : "s"}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 font-medium">
          <RiShutDownLine className="size-3 opacity-70" aria-hidden="true" />
          {pinCount} GPIO in use
        </span>
      </div>
    </button>
  );
});

/**
 * Interactive controller wiring blueprint for the Overview panel.
 * Shows every controller with its actual linked switches / devices / sensors
 * and the GPIO / I²C relationships recorded in the database — nothing invented.
 * Clicking a station isolates and highlights that controller's wiring.
 */
export const ControllerWiringPreview = memo(function ControllerWiringPreview({
  controllers,
  switches,
  devices,
  sensors,
  rooms = [],
  onNavigate,
}: {
  controllers: ControllerItem[];
  switches: SwitchItem[];
  devices: DeviceItem[];
  sensors: SensorItem[];
  rooms?: RoomItem[];
  onNavigate?: (path: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const roomById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);
  const boardNameById = useMemo(
    () => new Map(controllers.map((c) => [c.id, c.name])),
    [controllers]
  );
  const grouped = useMemo(() => {
    const switchMap = new Map<string, SwitchItem[]>();
    const deviceMap = new Map<string, DeviceItem[]>();
    const sensorMap = new Map<string, SensorItem[]>();
    for (const sw of switches) {
      const bucket = switchMap.get(sw.board_instance_id) ?? [];
      bucket.push(sw);
      switchMap.set(sw.board_instance_id, bucket);
    }
    for (const dev of devices) {
      const bucket = deviceMap.get(dev.board_instance_id) ?? [];
      bucket.push(dev);
      deviceMap.set(dev.board_instance_id, bucket);
    }
    for (const sen of sensors) {
      const bucket = sensorMap.get(sen.board_instance_id) ?? [];
      bucket.push(sen);
      sensorMap.set(sen.board_instance_id, bucket);
    }
    return { switchMap, deviceMap, sensorMap };
  }, [switches, devices, sensors]);

  const onlineCount = controllers.filter((c) => c.status === "online").length;
  const toggleSelect = (id: string) =>
    setSelectedId((prev) => (prev === id ? null : id));

  return (
    <Card className="gap-0 overflow-hidden py-0" data-testid="controller-preview-panel">
      {/* Header bar — mirrors the Home Preview chrome */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/50 px-4 py-2 text-xs">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <RiCpuLine className="size-4 text-primary" aria-hidden="true" />
            Controller Preview
          </span>
          <div className="hidden flex-wrap items-center gap-3 text-muted-foreground sm:flex">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/25" />
              Connected
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-amber-400 ring-2 ring-amber-400/25" />
              Offline
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-slate-400 ring-2 ring-slate-400/25" />
              Disconnected
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedId && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setSelectedId(null)}
            >
              Clear selection
            </Button>
          )}
          <Badge variant="secondary" size="xs" radius="full">
            <span className="tabular-nums">
              {onlineCount}/{controllers.length} online
            </span>
          </Badge>
        </div>
      </div>

      <CardContent className="space-y-4 p-3 sm:p-4">
        {controllers.length === 0 ? (
          <EmptyStatePanel
            icon={<RiCpuLine className="size-6" />}
            title="No controllers yet"
            description="Pair a controller to see its live wiring blueprint — every switch, device, and sensor linked to each board."
            action={
              onNavigate ? (
                <Button size="sm" onClick={() => onNavigate("/controllers")}>
                  Go to Controllers
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <BlueprintWiringMap
              rooms={rooms}
              controllers={controllers}
              switches={switches}
              devices={devices}
              sensors={sensors}
              selectedBoardId={selectedId}
              onSelectBoard={setSelectedId}
            />

            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Hardware Pin &amp; Wiring Schedule
                </p>
                <span className="text-[11px] text-muted-foreground">
                  Select a board below or on the blueprint to isolate its circuit
                </span>
              </div>
              <div
                className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2 2xl:grid-cols-3"
                role="group"
                aria-label="Controller wiring blueprints"
              >
                {controllers.map((ctrl) => (
                  <ControllerStation
                    key={ctrl.id}
                    controller={ctrl}
                    roomName={ctrl.room_id ? roomById.get(ctrl.room_id)?.name ?? null : null}
                    parentControllerName={
                      ctrl.assigned_controller_id
                        ? boardNameById.get(ctrl.assigned_controller_id) ?? null
                        : null
                    }
                    switches={grouped.switchMap.get(ctrl.id) ?? []}
                    devices={grouped.deviceMap.get(ctrl.id) ?? []}
                    sensors={grouped.sensorMap.get(ctrl.id) ?? []}
                    selected={selectedId === ctrl.id}
                    dimmed={selectedId !== null && selectedId !== ctrl.id}
                    onToggleSelect={toggleSelect}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
});
