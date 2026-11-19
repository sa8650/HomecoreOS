import { useEffect, useRef } from "react";
import { RiCloseLine, RiPulseLine } from "@remixicon/react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/reui/badge";
import { DeviceGlyph, deviceKindLabel } from "./floor-visuals";
import type { FloorDeviceKind } from "./house-layout";

export interface MapBadge {
  key: string;
  kind: "switch" | "device" | "sensor";
  id: string;
  name: string;
  visual: FloorDeviceKind;
  isOn: boolean;
  online: boolean;
  pending: boolean;
  /** Human readable live value for sensors / fan speed steps. */
  valueLabel?: string;
}

const FAN_SPEEDS = [1, 2, 3, 4, 5] as const;

function stateOptionsFor(visual: FloorDeviceKind): Array<{ label: string; state: string }> | null {
  if (visual === "fan") {
    return [
      { label: "Off", state: "off" },
      ...FAN_SPEEDS.map((speed) => ({ label: String(speed), state: `speed_${speed}` })),
    ];
  }
  if (visual === "lock") {
    return [
      { label: "Lock", state: "locked" },
      { label: "Unlock", state: "unlocked" },
    ];
  }
  if (visual === "valve") {
    return [
      { label: "Close", state: "closed" },
      { label: "Open", state: "open" },
    ];
  }
  if (visual === "door") {
    return [
      { label: "Close", state: "closed" },
      { label: "Open", state: "open" },
    ];
  }
  return null;
}

function activeStateLabel(visual: FloorDeviceKind, state: string | undefined): string | null {
  if (!state) return null;
  const normalized = state.trim().toLowerCase();
  if (visual === "fan") {
    const match = normalized.match(/^speed_([1-5])$/);
    if (match) return `Speed ${match[1]}`;
    if (normalized === "low") return "Speed 1";
    if (normalized === "medium") return "Speed 3";
    if (normalized === "high") return "Speed 5";
    return null;
  }
  if (visual === "lock") return normalized === "unlocked" ? "Unlocked" : "Locked";
  if (visual === "valve" || visual === "door") {
    return normalized === "open" || normalized === "opened" ? "Open" : "Closed";
  }
  return null;
}

/**
 * Compact control panel that opens when a device badge on the floor map is
 * selected. Shows the live state of the real HomecoreOS entity and exposes only
 * the controls the device type actually supports.
 */
export function DeviceControlPopover({
  badge,
  roomName,
  controllerName,
  anchor,
  container,
  canOperate,
  onClose,
  onToggle,
  onSetState,
}: {
  badge: MapBadge;
  roomName: string;
  controllerName?: string;
  anchor: { left: number; top: number };
  container: { width: number; height: number };
  canOperate: boolean;
  onClose: () => void;
  onToggle: (next: boolean) => void;
  onSetState: (state: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const width = 268;
  const estimatedHeight = badge.kind === "sensor" ? 150 : 196;

  useEffect(() => {
    panelRef.current?.focus();
  }, [badge.key]);

  const left = Math.max(
    8,
    Math.min(container.width - width - 8, anchor.left - width / 2)
  );
  const preferredTop = anchor.top + 22;
  const top =
    preferredTop + estimatedHeight > container.height
      ? Math.max(8, anchor.top - estimatedHeight - 22)
      : preferredTop;

  const options = badge.kind === "sensor" ? null : stateOptionsFor(badge.visual);
  const activeOption = badge.valueLabel ?? null;
  const stateLabel = activeStateLabel(badge.visual, badge.valueLabel);
  const isSensor = badge.kind === "sensor";

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label={`${badge.name} controls`}
      data-testid="device-control-popover"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      className={cn(
        "absolute z-30 rounded-xl border border-border/80 bg-card/98 p-3 shadow-xl backdrop-blur",
        "focus-visible:outline-none"
      )}
      style={{ left, top, width }}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-full border transition-colors",
            badge.isOn
              ? "border-amber-300/70 bg-amber-50 text-amber-600 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
              : "border-border bg-muted/60 text-muted-foreground"
          )}
        >
          <svg viewBox="-10 -10 20 20" className="size-5" aria-hidden="true">
            <DeviceGlyph kind={badge.visual} color="currentColor" scale={0.95} />
          </svg>
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight text-foreground">
            {badge.name}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {roomName} · {deviceKindLabel(badge.visual)}
          </p>
        </div>

        <button
          type="button"
          aria-label="Close device controls"
          onClick={onClose}
          className="-mr-1 -mt-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RiCloseLine className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Badge variant={badge.isOn ? "success-light" : "secondary"} radius="full">
          {isSensor
            ? badge.valueLabel ?? "No reading"
            : `${badge.isOn ? "On" : "Off"}${stateLabel ? ` · ${stateLabel}` : ""}`}
        </Badge>
        <Badge variant={badge.online ? "secondary" : "warning-light"} radius="full">
          {badge.online ? "Online" : "Offline"}
        </Badge>
        {badge.pending && (
          <Badge variant="info-light" radius="full">
            <RiPulseLine className="size-3 animate-pulse" aria-hidden="true" />
            Syncing
          </Badge>
        )}
      </div>

      {!isSensor && options && (
        <div className="mt-2.5">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {badge.visual === "lock" ? "Bolt" : badge.visual === "fan" ? "Speed" : "Position"}
          </p>
          <div className="flex flex-wrap gap-1">
            {options.map((option) => {
              const selected =
                option.state === "off"
                  ? !badge.isOn
                  : activeOption?.toLowerCase() === option.state.toLowerCase();
              return (
                <button
                  key={option.state}
                  type="button"
                  disabled={!canOperate || !badge.online || badge.pending}
                  aria-pressed={selected}
                  onClick={() => onSetState(option.state)}
                  className={cn(
                    "min-w-8 rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors",
                    selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                    "disabled:cursor-not-allowed disabled:opacity-50"
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!isSensor && !options && (
        <button
          type="button"
          disabled={!canOperate || !badge.online || badge.pending}
          aria-pressed={badge.isOn}
          onClick={() => onToggle(!badge.isOn)}
          className={cn(
            "mt-2.5 inline-flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors",
            badge.isOn
              ? "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
              : "border-border bg-muted/40 text-foreground hover:bg-muted",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
        >
          <span>{badge.isOn ? "Turn off" : "Turn on"}</span>
          <span
            className={cn(
              "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
              badge.isOn ? "bg-amber-500" : "bg-input"
            )}
          >
            <span
              className={cn(
                "block size-4 rounded-full bg-white shadow transition-transform",
                badge.isOn ? "translate-x-[18px]" : "translate-x-0.5"
              )}
            />
          </span>
        </button>
      )}

      {controllerName && (
        <p className="mt-2 truncate text-[10px] text-muted-foreground">
          Controller · {controllerName}
        </p>
      )}
    </div>
  );
}
