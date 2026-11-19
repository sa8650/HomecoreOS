import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  RiAddLine,
  RiCheckLine,
  RiDragMove2Line,
  RiFocus3Line,
  RiFullscreenExitLine,
  RiFullscreenLine,
  RiInformationLine,
  RiLayoutColumnLine,
  RiLayoutGridLine,
  RiLayoutRowLine,
  RiRestartLine,
  RiShutDownLine,
  RiZoomInLine,
  RiZoomOutLine,
} from "@remixicon/react";
import { inferRoomTypeFromName, isDeviceStateActive, type RoomType } from "@homecoreos/shared";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api";
import { isEntityOnline } from "@/lib/board-pin-helpers";
import { useEffectiveTimezone } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/reui/badge";
import { EmptyStatePanel } from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  ControllerItem,
  DeviceItem,
  HomeItem,
  RoomItem,
  SensorItem,
  SwitchItem,
} from "@/features/types";
import { SmartHomeMap } from "./SmartHomeMap";
import { buildHousePlan, type PlanRect } from "./house-layout";
import { classifyDeviceType, classifySwitch, isLightingKind } from "./floor-visuals";
import { RoomControlsCard } from "./RoomControlsCard";
import { RoomEditorModal } from "./RoomEditorModal";

type FloorPlanViewMode = "standard" | "wide" | "fullscreen";

const MIN_ZOOM = 0.55;
const MAX_ZOOM = 3;

function clampZoom(next: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(next.toFixed(3))));
}

/**
 * HomecoreOS home preview: one connected 2D smart-home floor map with live,
 * interactive devices. Rooms, positions, sizes and openings come from the user's
 * real room records; every badge reflects the live MQTT-backed device state.
 */
export const HomeFloorPlan = memo(function HomeFloorPlan({
  homes,
  rooms,
  controllers = [],
  switches,
  devices,
  sensors,
  onReload,
  canEdit,
  canOperate = true,
  onNavigateRooms,
}: {
  homes: HomeItem[];
  rooms: RoomItem[];
  controllers?: ControllerItem[];
  switches: SwitchItem[];
  devices: DeviceItem[];
  sensors: SensorItem[];
  onReload: () => Promise<void> | void;
  canEdit: boolean;
  canOperate?: boolean;
  onNavigateRooms?: () => void;
}) {
  const timezone = useEffectiveTimezone();
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(rooms[0]?.id ?? null);
  const [selectedDeviceKey, setSelectedDeviceKey] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [viewMode, setViewMode] = useState<FloorPlanViewMode>("standard");
  const [fullscreenRoomOpen, setFullscreenRoomOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState<RoomItem | null>(null);
  const [pendingIds, setPendingIds] = useState<Record<string, boolean>>({});
  const [optimisticSwitches, setOptimisticSwitches] = useState<Record<string, boolean>>({});
  const [optimisticDevices, setOptimisticDevices] = useState<Record<string, string>>({});
  const [batchPending, setBatchPending] = useState(false);
  const [resettingBadges, setResettingBadges] = useState(false);
  const [assignTargetId, setAssignTargetId] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  // Mirrors of the controlled view, so a zoom button pressed mid-animation
  // continues from what is on screen rather than from a stale render value.
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const viewAnimationRef = useRef<number | null>(null);
  zoomRef.current = zoom;
  panRef.current = pan;
  const opSeqRef = useRef<Map<string, number>>(new Map());
  const inFlightIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setOptimisticSwitches((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const sw of switches) {
        if (sw.id in next && !inFlightIdsRef.current.has(sw.id) && sw.is_on === next[sw.id]) {
          delete next[sw.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [switches]);

  useEffect(() => {
    setOptimisticDevices((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const dev of devices) {
        if (
          dev.id in next &&
          !inFlightIdsRef.current.has(dev.id) &&
          isDeviceStateActive(dev.state) === isDeviceStateActive(next[dev.id])
        ) {
          delete next[dev.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [devices]);

  const ctrlById = useMemo(() => new Map(controllers.map((c) => [c.id, c])), [controllers]);

  const effectiveSwitches = useMemo(
    () =>
      switches.map((s) =>
        s.id in optimisticSwitches ? { ...s, is_on: optimisticSwitches[s.id]! } : s
      ),
    [switches, optimisticSwitches]
  );

  const effectiveDevices = useMemo(
    () =>
      devices.map((d) =>
        d.id in optimisticDevices ? { ...d, state: optimisticDevices[d.id]! } : d
      ),
    [devices, optimisticDevices]
  );

  const plan = useMemo(() => buildHousePlan(rooms), [rooms]);
  const roomTypeById = useMemo(() => {
    const map = new Map<string, RoomType>();
    for (const room of plan.rooms) map.set(room.id, room.type);
    return map;
  }, [plan]);

  const primaryHomeId = homes[0]?.id ?? "";

  const activeSelectedId =
    selectedRoomId && rooms.some((room) => room.id === selectedRoomId)
      ? selectedRoomId
      : rooms[0]?.id ?? null;
  const selectedRoom = rooms.find((room) => room.id === activeSelectedId) ?? null;

  const roomSwitches = useMemo(
    () => effectiveSwitches.filter((s) => s.room_id === activeSelectedId),
    [effectiveSwitches, activeSelectedId]
  );
  const roomDevices = useMemo(
    () => effectiveDevices.filter((d) => d.room_id === activeSelectedId),
    [effectiveDevices, activeSelectedId]
  );
  const roomSensors = useMemo(
    () => sensors.filter((s) => s.room_id === activeSelectedId),
    [sensors, activeSelectedId]
  );

  const activeLights = useMemo(() => {
    const switchLights = effectiveSwitches.filter(
      (item) => item.is_on && isLightingKind(classifySwitch(item.name))
    );
    const activeSwitches = effectiveSwitches.filter((item) => item.is_on);
    const deviceLights = effectiveDevices.filter(
      (item) =>
        isDeviceStateActive(item.state) &&
        isLightingKind(classifyDeviceType(item.device_type, item.name))
    );
    return {
      switches: activeSwitches,
      devices: deviceLights,
      total: activeSwitches.length + deviceLights.length,
      lightingTotal: switchLights.length + deviceLights.length,
    };
  }, [effectiveSwitches, effectiveDevices]);

  const unassignedItems = useMemo(() => {
    const items: Array<{ key: string; kind: "switch" | "device" | "sensor"; id: string; label: string }> = [];
    for (const item of effectiveSwitches) {
      if (!item.room_id) {
        items.push({ key: `switch:${item.id}`, kind: "switch", id: item.id, label: `Switch · ${item.name}` });
      }
    }
    for (const item of effectiveDevices) {
      if (!item.room_id) {
        items.push({ key: `device:${item.id}`, kind: "device", id: item.id, label: `Device · ${item.name}` });
      }
    }
    for (const item of sensors) {
      if (!item.room_id) {
        items.push({ key: `sensor:${item.id}`, kind: "sensor", id: item.id, label: `Sensor · ${item.name}` });
      }
    }
    return items;
  }, [effectiveSwitches, effectiveDevices, sensors]);

  const offlineCount = useMemo(() => {
    const offlineSwitches = effectiveSwitches.filter(
      (item) => !isEntityOnline(item.is_online, ctrlById.get(item.board_instance_id))
    ).length;
    const offlineDevices = effectiveDevices.filter(
      (item) => !isEntityOnline(item.is_online, ctrlById.get(item.board_instance_id))
    ).length;
    return offlineSwitches + offlineDevices;
  }, [effectiveSwitches, effectiveDevices, ctrlById]);

  /* ---------------------------------------------------------------------- */
  /* Device + switch commands                                                */
  /* ---------------------------------------------------------------------- */

  const toggleSwitch = useCallback(
    async (sw: SwitchItem, explicitIsOn?: boolean) => {
      if (inFlightIdsRef.current.has(sw.id)) return;
      const nextIsOn = explicitIsOn !== undefined ? explicitIsOn : !sw.is_on;
      if (nextIsOn === sw.is_on) return;

      const seq = (opSeqRef.current.get(sw.id) ?? 0) + 1;
      opSeqRef.current.set(sw.id, seq);
      inFlightIdsRef.current.add(sw.id);

      setOptimisticSwitches((prev) => ({ ...prev, [sw.id]: nextIsOn }));
      setPendingIds((prev) => ({ ...prev, [sw.id]: true }));

      try {
        const res = await apiFetch<{ switch?: SwitchItem }>(`/api/switches/${sw.id}/toggle`, {
          method: "POST",
          body: JSON.stringify({ isOn: nextIsOn }),
        });
        if (opSeqRef.current.get(sw.id) === seq) {
          if (res.switch) {
            setOptimisticSwitches((prev) => ({ ...prev, [sw.id]: res.switch!.is_on }));
          }
          await Promise.resolve(onReload()).catch(() => {});
          if (opSeqRef.current.get(sw.id) === seq) {
            setOptimisticSwitches((prev) => {
              const copy = { ...prev };
              delete copy[sw.id];
              return copy;
            });
          }
        }
      } catch (err) {
        if (opSeqRef.current.get(sw.id) === seq) {
          setOptimisticSwitches((prev) => {
            const copy = { ...prev };
            delete copy[sw.id];
            return copy;
          });
        }
        toast.error(err instanceof ApiError ? err.message : `Failed to toggle "${sw.name}".`);
      } finally {
        inFlightIdsRef.current.delete(sw.id);
        setPendingIds((prev) => {
          const copy = { ...prev };
          delete copy[sw.id];
          return copy;
        });
      }
    },
    [onReload]
  );

  const setDeviceState = useCallback(
    async (dev: DeviceItem, nextState: string) => {
      if (inFlightIdsRef.current.has(dev.id)) return;
      if (dev.state.trim().toLowerCase() === nextState.trim().toLowerCase()) return;

      const seq = (opSeqRef.current.get(dev.id) ?? 0) + 1;
      opSeqRef.current.set(dev.id, seq);
      inFlightIdsRef.current.add(dev.id);

      setOptimisticDevices((prev) => ({ ...prev, [dev.id]: nextState }));
      setPendingIds((prev) => ({ ...prev, [dev.id]: true }));

      try {
        const res = await apiFetch<{ device?: DeviceItem }>(`/api/devices/${dev.id}/command`, {
          method: "POST",
          body: JSON.stringify({ state: nextState }),
        });
        if (opSeqRef.current.get(dev.id) === seq) {
          if (res.device?.state) {
            setOptimisticDevices((prev) => ({ ...prev, [dev.id]: res.device!.state }));
          }
          await Promise.resolve(onReload()).catch(() => {});
          if (opSeqRef.current.get(dev.id) === seq) {
            setOptimisticDevices((prev) => {
              const copy = { ...prev };
              delete copy[dev.id];
              return copy;
            });
          }
        }
      } catch (err) {
        if (opSeqRef.current.get(dev.id) === seq) {
          setOptimisticDevices((prev) => {
            const copy = { ...prev };
            delete copy[dev.id];
            return copy;
          });
        }
        toast.error(err instanceof ApiError ? err.message : `Failed to control "${dev.name}".`);
      } finally {
        inFlightIdsRef.current.delete(dev.id);
        setPendingIds((prev) => {
          const copy = { ...prev };
          delete copy[dev.id];
          return copy;
        });
      }
    },
    [onReload]
  );

  const toggleDevice = useCallback(
    async (dev: DeviceItem, explicitOn?: boolean) => {
      const isCurrentlyOn = isDeviceStateActive(dev.state);
      const targetOn = explicitOn !== undefined ? explicitOn : !isCurrentlyOn;
      if (targetOn === isCurrentlyOn) return;
      await setDeviceState(dev, targetOn ? "on" : "off");
    },
    [setDeviceState]
  );

  async function handleBatchLights(
    targets: { switches: SwitchItem[]; devices: DeviceItem[] },
    turnOn: boolean
  ) {
    if (!canOperate || batchPending) return;
    setBatchPending(true);
    try {
      await Promise.all([
        ...targets.switches
          .filter((item) => item.is_on !== turnOn)
          .map((item) => toggleSwitch(item, turnOn)),
        ...targets.devices
          .filter((item) => isDeviceStateActive(item.state) !== turnOn)
          .map((item) => toggleDevice(item, turnOn)),
      ]);
    } finally {
      setBatchPending(false);
    }
  }

  async function handleAssignToRoom() {
    if (!assignTargetId || !activeSelectedId || pendingIds[assignTargetId]) return;
    const [kind, id] = assignTargetId.split(":");
    const endpoint =
      kind === "switch"
        ? `/api/switches/${id}`
        : kind === "device"
          ? `/api/devices/${id}`
          : `/api/sensors/${id}`;
    setPendingIds((prev) => ({ ...prev, [id!]: true }));
    try {
      await apiFetch(endpoint, {
        method: "PATCH",
        body: JSON.stringify({ roomId: activeSelectedId }),
      });
      setAssignTargetId("");
      toast.success("Assigned hardware to room.");
      await onReload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to assign hardware to room.");
    } finally {
      setPendingIds((prev) => {
        const copy = { ...prev };
        delete copy[id!];
        return copy;
      });
    }
  }

  /** Persists a room move / resize made directly on the floor map. */
  const handleRoomRectCommit = useCallback(
    async (roomId: string, rect: PlanRect) => {
      const room = rooms.find((item) => item.id === roomId);
      if (!room) return;
      const payload: Record<string, number> = {};
      if ((room.floor_x ?? null) !== rect.x || (room.floor_y ?? null) !== rect.y) {
        payload.floorX = rect.x;
        payload.floorY = rect.y;
      }
      if ((room.floor_w ?? null) !== rect.w || (room.floor_h ?? null) !== rect.h) {
        payload.floorW = rect.w;
        payload.floorH = rect.h;
      }
      if (Object.keys(payload).length === 0) return;
      try {
        await apiFetch(`/api/homes/rooms/${roomId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        await onReload();
      } catch (err) {
        toast.error(
          err instanceof ApiError ? err.message : "Failed to save the room position on the plan."
        );
      }
    },
    [rooms, onReload]
  );

  /** Persists a device badge position dragged on the map into the room layout. */
  const handleDevicePositionCommit = useCallback(
    async (roomId: string, deviceKey: string, position: { x: number; y: number }) => {
      const room = rooms.find((item) => item.id === roomId);
      if (!room) return;
      const layoutConfig = {
        ...(room.layout_config ?? {}),
        devicePositions: {
          ...(room.layout_config?.devicePositions ?? {}),
          [deviceKey]: position,
        },
      };
      try {
        await apiFetch(`/api/homes/rooms/${roomId}`, {
          method: "PATCH",
          body: JSON.stringify({ layoutConfig }),
        });
        await onReload();
      } catch (err) {
        toast.error(
          err instanceof ApiError ? err.message : "Failed to save the device position on the plan."
        );
      }
    },
    [rooms, onReload]
  );

  /** Drops every saved badge position so the map falls back to auto placement. */
  const handleResetDevicePositions = useCallback(async () => {
    const targets = rooms.filter((room) => {
      const positions = room.layout_config?.devicePositions;
      return positions ? Object.keys(positions).length > 0 : false;
    });
    if (targets.length === 0) {
      toast.info("No custom device positions to reset.");
      return;
    }
    setResettingBadges(true);
    try {
      await Promise.all(
        targets.map((room) => {
          const { devicePositions: _positions, ...rest } = room.layout_config ?? {};
          return apiFetch(`/api/homes/rooms/${room.id}`, {
            method: "PATCH",
            body: JSON.stringify({ layoutConfig: rest }),
          });
        })
      );
      toast.success("Device positions reset to automatic placement.");
      await onReload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to reset device positions.");
    } finally {
      setResettingBadges(false);
    }
  }, [rooms, onReload]);

  /* ---------------------------------------------------------------------- */
  /* Selection                                                               */
  /* ---------------------------------------------------------------------- */

  const handleSelectRoom = useCallback(
    (roomId: string) => {
      setSelectedRoomId(roomId);
      setSelectedDeviceKey(null);
      if (viewMode === "fullscreen" && !editMode) setFullscreenRoomOpen(true);
    },
    [editMode, viewMode]
  );

  const handleSelectDevice = useCallback(
    (key: string | null) => {
      setSelectedDeviceKey(key);
      if (!key) return;
      const [kind, id] = key.split(":");
      const owner =
        kind === "switch"
          ? switches.find((item) => item.id === id)
          : kind === "device"
            ? devices.find((item) => item.id === id)
            : sensors.find((item) => item.id === id);
      if (owner?.room_id) setSelectedRoomId(owner.room_id);
    },
    [switches, devices, sensors]
  );

  /* ---------------------------------------------------------------------- */
  /* Fullscreen lock + Escape                                                */
  /* ---------------------------------------------------------------------- */

  const isFullscreen = viewMode === "fullscreen";
  const isWideOrFullscreen = viewMode === "wide" || viewMode === "fullscreen";

  useEffect(() => {
    if (!isFullscreen) {
      setFullscreenRoomOpen(false);
      document.documentElement.removeAttribute("data-hc-fullscreen-map");
      return;
    }

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.setAttribute("data-hc-fullscreen-map", "true");

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (
        document.querySelector(
          '[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="select-content"], [data-island-layer]'
        )
      ) {
        return;
      }
      if (selectedDeviceKey) {
        setSelectedDeviceKey(null);
        return;
      }
      event.preventDefault();
      if (fullscreenRoomOpen) {
        setFullscreenRoomOpen(false);
      } else {
        setViewMode("standard");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.documentElement.removeAttribute("data-hc-fullscreen-map");
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isFullscreen, fullscreenRoomOpen, selectedDeviceKey]);

  /**
   * Eases the viewport to a new zoom/pan pair over ~190ms. Button zoom and Fit
   * used to snap in a single frame, which read as a jump next to the smooth
   * wheel/pinch gestures.
   */
  const animateView = useCallback((target: { zoom: number; pan: { x: number; y: number } }) => {
    if (typeof window === "undefined") return;
    if (viewAnimationRef.current !== null) cancelAnimationFrame(viewAnimationRef.current);
    const startZoom = zoomRef.current;
    const startPan = panRef.current;
    const nextZoom = clampZoom(target.zoom);
    const duration = 190;
    const startedAt = performance.now();

    const step = (now: number) => {
      const t = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setZoom(clampZoom(startZoom + (nextZoom - startZoom) * eased));
      setPan({
        x: startPan.x + (target.pan.x - startPan.x) * eased,
        y: startPan.y + (target.pan.y - startPan.y) * eased,
      });
      viewAnimationRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    viewAnimationRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(
    () => () => {
      if (viewAnimationRef.current !== null) cancelAnimationFrame(viewAnimationRef.current);
    },
    []
  );

  const handleResetView = useCallback(() => {
    animateView({ zoom: 1, pan: { x: 0, y: 0 } });
  }, [animateView]);

  const stepZoom = useCallback(
    (direction: 1 | -1) => {
      animateView({ zoom: clampZoom(zoomRef.current + direction * 0.2), pan: panRef.current });
    },
    [animateView]
  );

  if (rooms.length === 0) {
    return (
      <EmptyStatePanel
        icon={<RiLayoutGridLine />}
        title="No rooms mapped on your 2D floor plan yet"
        description="Add your first room — such as a Living Room, Kitchen, or Bedroom — and HomecoreOS renders one connected house plan, then snaps the next rooms into place."
        action={
          canEdit && primaryHomeId ? (
            <Button
              onClick={() => {
                setEditingRoom(null);
                setEditorOpen(true);
              }}
            >
              <RiAddLine className="size-4" aria-hidden="true" />
              Add First Room
            </Button>
          ) : (
            onNavigateRooms && <Button onClick={onNavigateRooms}>Go to Rooms</Button>
          )
        }
      />
    );
  }

  const renderRoomInspectorBody = (showCloseButton = false) => {
    if (!selectedRoom) return null;
    return (
      <RoomControlsCard
        room={selectedRoom}
        roomType={roomTypeById.get(selectedRoom.id) ?? inferRoomTypeFromName(selectedRoom.name)}
        switches={roomSwitches}
        devices={roomDevices}
        sensors={roomSensors}
        ctrlById={ctrlById}
        timezone={timezone}
        canEdit={canEdit}
        canOperate={canOperate}
        pendingIds={pendingIds}
        batchPending={batchPending}
        isFullscreen={isFullscreen}
        isWideOrFullscreen={isWideOrFullscreen}
        showCloseButton={showCloseButton}
        unassignedItems={unassignedItems}
        assignTargetId={assignTargetId}
        onAssignTargetChange={setAssignTargetId}
        onAssignToRoom={() => void handleAssignToRoom()}
        onToggleSwitch={(sw, checked) => void toggleSwitch(sw, checked)}
        onToggleDevice={(dev, checked) => void toggleDevice(dev, checked)}
        onSetDeviceState={(dev, state) => void setDeviceState(dev, state)}
        onBatchLights={(targets, turnOn) => void handleBatchLights(targets, turnOn)}
        onEditRoom={() => {
          setEditingRoom(selectedRoom);
          setEditorOpen(true);
        }}
        onClosePopup={() => setFullscreenRoomOpen(false)}
      />
    );
  };

  const fullScreenLabel = isFullscreen ? "Exit Full Screen" : "Full Screen";
  const arrangeLabel = editMode ? "Done Positioning" : "Arrange Floor Plan";
  const mapHeightClass = isFullscreen
    ? "h-full"
    : viewMode === "wide"
      ? "h-[460px] sm:h-[600px]"
      : "h-[340px] sm:h-[520px]";

  const planNode = (
    <div
      data-testid="floorplan-container"
      data-view-mode={viewMode}
      className={cn(
        isFullscreen
          ? "fixed inset-0 z-50 flex h-[100dvh] w-screen flex-col overflow-hidden overscroll-contain bg-background"
          : "space-y-3"
      )}
    >
      <div
        className={cn(
          isFullscreen
            ? "flex min-h-0 min-w-0 flex-1 flex-col"
            : cn(
                "grid gap-4",
                viewMode === "wide" ? "grid-cols-1" : "grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px]"
              )
        )}
      >
        <Card
          className={cn(
            "gap-0 overflow-hidden py-0",
            isFullscreen && "flex min-h-0 flex-1 flex-col rounded-none border-0 ring-0"
          )}
        >
          {/* Map header bar */}
          <div
            data-testid="floorplan-header-bar"
            className={cn(
              "flex flex-wrap items-center justify-between gap-2 border-b bg-muted/50 px-4 text-xs",
              isFullscreen ? "max-h-[45dvh] shrink-0 overflow-y-auto pb-2.5 pt-14 sm:px-6" : "py-2"
            )}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Home Preview details"
                    className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm font-semibold text-foreground transition-colors hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span>Home Preview</span>
                    <RiInformationLine className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="max-w-xs flex-col items-start gap-1 p-2.5 text-xs">
                  <p className="font-semibold">Home Preview</p>
                  <p className="text-[11px] leading-relaxed opacity-90">
                    Click a device badge to open its controls, drag to pan, scroll or pinch to zoom,
                    and select a room to focus its hardware.
                  </p>
                </TooltipContent>
              </Tooltip>

              <div className="hidden flex-wrap items-center gap-3 text-muted-foreground sm:flex">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-amber-400 ring-2 ring-amber-400/30" />
                  Light on
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-slate-300 ring-1 ring-slate-400/40" />
                  Idle
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-red-500" />
                  Offline {offlineCount > 0 ? `(${offlineCount})` : ""}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {editMode && (
                <Badge variant="warning-light" radius="full" className="mr-1">
                  Drag a room, a device badge or the corner grip to arrange the plan
                </Badge>
              )}

              {editMode && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={resettingBadges}
                  onClick={() => void handleResetDevicePositions()}
                >
                  <RiRestartLine className="size-3.5" aria-hidden="true" />
                  Reset Badges
                </Button>
              )}

              {canOperate && activeLights.total > 0 && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={batchPending}
                  onClick={() =>
                    void handleBatchLights(
                      { switches: activeLights.switches, devices: activeLights.devices },
                      false
                    )
                  }
                >
                  <RiShutDownLine className="size-3.5 text-warning" aria-hidden="true" />
                  All Lights Off ({activeLights.total})
                </Button>
              )}

              <div
                role="group"
                aria-label="Floor plan view mode"
                className="inline-flex items-center gap-0.5 rounded-lg border bg-background/80 p-0.5"
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant={viewMode === "standard" ? "secondary" : "ghost"}
                      aria-label="Standard View"
                      aria-pressed={viewMode === "standard"}
                      onClick={() => {
                        setFullscreenRoomOpen(false);
                        setViewMode("standard");
                      }}
                    >
                      <RiLayoutColumnLine className="size-3.5" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Standard View</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant={viewMode === "wide" ? "secondary" : "ghost"}
                      aria-label="Wide View"
                      aria-pressed={viewMode === "wide"}
                      onClick={() => {
                        setFullscreenRoomOpen(false);
                        setViewMode("wide");
                      }}
                    >
                      <RiLayoutRowLine className="size-3.5" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Wide View</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant={isFullscreen ? "secondary" : "ghost"}
                      aria-label={fullScreenLabel}
                      aria-pressed={isFullscreen}
                      onClick={() => {
                        if (isFullscreen) {
                          setFullscreenRoomOpen(false);
                          setViewMode("standard");
                        } else {
                          setFullscreenRoomOpen(false);
                          handleResetView();
                          setViewMode("fullscreen");
                        }
                      }}
                    >
                      {isFullscreen ? (
                        <RiFullscreenExitLine className="size-3.5" aria-hidden="true" />
                      ) : (
                        <RiFullscreenLine className="size-3.5" aria-hidden="true" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{fullScreenLabel}</TooltipContent>
                </Tooltip>
              </div>

              {canEdit && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant={editMode ? "default" : "outline"}
                        aria-label={arrangeLabel}
                        aria-pressed={editMode}
                        onClick={() => {
                          setEditMode((value) => !value);
                          setFullscreenRoomOpen(false);
                          setSelectedDeviceKey(null);
                        }}
                      >
                        {editMode ? (
                          <RiCheckLine className="size-3.5" aria-hidden="true" />
                        ) : (
                          <RiDragMove2Line className="size-3.5" aria-hidden="true" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{arrangeLabel}</TooltipContent>
                  </Tooltip>

                  {primaryHomeId && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="outline"
                          aria-label="Add Room"
                          onClick={() => {
                            setEditingRoom(null);
                            setEditorOpen(true);
                          }}
                        >
                          <RiAddLine className="size-3.5" aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Add Room</TooltipContent>
                    </Tooltip>
                  )}
                </>
              )}

              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="outline"
                      aria-label="Zoom out floor plan"
                      onClick={() => stepZoom(-1)}
                    >
                      <RiZoomOutLine className="size-3.5" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Zoom Out</TooltipContent>
                </Tooltip>
                <Badge variant="secondary" size="xs" className="min-w-11 justify-center font-mono tabular-nums">
                  {Math.round(zoom * 100)}%
                </Badge>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="outline"
                      aria-label="Zoom in floor plan"
                      onClick={() => stepZoom(1)}
                    >
                      <RiZoomInLine className="size-3.5" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Zoom In</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="outline"
                      aria-label="Fit"
                      onClick={handleResetView}
                    >
                      <RiFocus3Line className="size-3.5" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Fit</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>

          <SmartHomeMap
            rooms={rooms}
            devices={effectiveDevices}
            switches={effectiveSwitches}
            sensors={sensors}
            controllers={controllers}
            selectedRoomId={activeSelectedId}
            selectedDeviceKey={selectedDeviceKey}
            onSelectRoom={handleSelectRoom}
            onSelectDevice={handleSelectDevice}
            canOperate={canOperate}
            canEdit={canEdit}
            editMode={editMode}
            pendingIds={pendingIds}
            zoom={zoom}
            pan={pan}
            onZoomChange={(next) => setZoom(clampZoom(next))}
            onPanChange={setPan}
            onToggleSwitch={(item, next) => void toggleSwitch(item, next)}
            onToggleDevice={(item, next) => void toggleDevice(item, next)}
            onSetDeviceState={(item, state) => void setDeviceState(item, state)}
            onRoomRectCommit={handleRoomRectCommit}
            onDevicePositionCommit={handleDevicePositionCommit}
            onBackgroundClick={() => setSelectedDeviceKey(null)}
            heightClassName={mapHeightClass}
            className={isFullscreen ? "flex min-h-0 flex-1 flex-col" : undefined}
          >
            {isFullscreen && fullscreenRoomOpen && selectedRoom && (
              <div
                data-testid="fullscreen-room-popup"
                role="dialog"
                aria-modal="false"
                aria-label={`${selectedRoom.name} controls and sensors`}
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
                className="absolute bottom-4 right-4 top-4 z-20 flex w-[min(368px,calc(100%-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl sm:left-auto"
              >
                {renderRoomInspectorBody(true)}
              </div>
            )}
          </SmartHomeMap>
        </Card>

        {!isFullscreen && (
          <Card className="flex flex-col gap-0 overflow-hidden py-0">
            {renderRoomInspectorBody(false)}
          </Card>
        )}
      </div>

      <RoomEditorModal
        open={editorOpen}
        room={editingRoom}
        homeId={primaryHomeId}
        onClose={() => setEditorOpen(false)}
        onSaved={onReload}
      />
    </div>
  );

  return (
    <TooltipProvider delayDuration={120} disableHoverableContent>
      {/*
        Full-screen mode must escape the page tree: any ancestor with a transform
        (the page uses entrance animations) becomes the containing block for
        `position: fixed`, which used to leave the overlay offset inside the page
        instead of covering the viewport. Rendering it into <body> keeps the fixed
        layer anchored to the viewport no matter what wraps the Overview page.
      */}
      {isFullscreen && typeof document !== "undefined"
        ? createPortal(planNode, document.body)
        : planNode}
    </TooltipProvider>
  );
});
