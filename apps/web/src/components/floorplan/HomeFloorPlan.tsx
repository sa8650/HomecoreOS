import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiAddLine,
  RiCheckLine,
  RiCloseLine,
  RiDragMove2Line,
  RiEditLine,
  RiFlashlightLine,
  RiFocus3Line,
  RiFullscreenExitLine,
  RiFullscreenLine,
  RiInformationLine,
  RiLayoutColumnLine,
  RiLayoutGridLine,
  RiLayoutRowLine,
  RiLightbulbFlashLine,
  RiLightbulbLine,
  RiPulseLine,
  RiSensorLine,
  RiShutDownLine,
  RiZoomInLine,
  RiZoomOutLine,
} from "@remixicon/react";
import {
  inferRoomTypeFromName,
  isDeviceStateActive,
  type RoomType,
} from "@homecoreos/shared";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api";
import { isEntityOnline } from "@/lib/board-pin-helpers";
import { formatShortTime, useEffectiveTimezone } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/reui/badge";
import { IconTile } from "@/components/reui/icon-tile";
import { EmptyStatePanel } from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
import { RoomEditorModal } from "./RoomEditorModal";
import {
  FloorDeviceFixtures,
  FloorPatternDefs,
  RoomFurnitureArt,
  RoomOpeningsSvg,
  getFloorPatternUrl,
  isLightingFixture,
  type FloorFixtureItem,
} from "./RoomFurnitureSvg";

interface PositionedRoom {
  room: RoomItem;
  x: number;
  y: number;
  w: number;
  h: number;
  type: RoomType;
}

type FloorPlanViewMode = "standard" | "wide" | "fullscreen";

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
  const [editMode, setEditMode] = useState(false);
  const [viewMode, setViewMode] = useState<FloorPlanViewMode>("standard");
  const [fullscreenRoomOpen, setFullscreenRoomOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState<RoomItem | null>(null);
  const [pendingIds, setPendingIds] = useState<Record<string, boolean>>({});
  const [optimisticSwitches, setOptimisticSwitches] = useState<Record<string, boolean>>({});
  const [optimisticDevices, setOptimisticDevices] = useState<Record<string, string>>({});
  const [batchPending, setBatchPending] = useState(false);
  const [dragPositions, setDragPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [resizeDims, setResizeDims] = useState<Record<string, { w: number; h: number }>>({});
  const [assignTargetId, setAssignTargetId] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const opSeqRef = useRef<Map<string, number>>(new Map());
  const inFlightIdsRef = useRef<Set<string>>(new Set());
  const roomClickCandidateRef = useRef<{
    roomId: string;
    startClientX: number;
    startClientY: number;
  } | null>(null);
  const svgPanStartRef = useRef<{ startClientX: number; startClientY: number } | null>(
    null
  );
  const suppressNextRoomClickRef = useRef(false);
  const dragStateRef = useRef<{
    roomId: string;
    startClientX: number;
    startClientY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const resizeStateRef = useRef<{
    roomId: string;
    startClientX: number;
    startClientY: number;
    origW: number;
    origH: number;
  } | null>(null);
  const panStateRef = useRef<{
    startClientX: number;
    startClientY: number;
    origPanX: number;
    origPanY: number;
  } | null>(null);
  const pinchStateRef = useRef<{
    startDist: number;
    startZoom: number;
  } | null>(null);
  const activeTouchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());

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

  const ctrlById = useMemo(
    () => new Map(controllers.map((c) => [c.id, c])),
    [controllers]
  );

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

  const primaryHomeId = homes[0]?.id ?? "";

  const positionedRooms: PositionedRoom[] = useMemo(() => {
    const allZero =
      rooms.length > 1 &&
      rooms.every((r) => (r.floor_x ?? 0) === 0 && (r.floor_y ?? 0) === 0);

    let cursorX = 0;
    let cursorY = 0;
    let rowMaxH = 0;

    return rooms.map((room, index) => {
      const dimOverride = resizeDims[room.id];
      const w = dimOverride ? dimOverride.w : (room.floor_w ?? (room.grid_col_span >= 2 ? 420 : 300));
      const h = dimOverride ? dimOverride.h : (room.floor_h ?? 240);
      let x = room.floor_x ?? 0;
      let y = room.floor_y ?? 0;

      if (allZero && index > 0) {
        if (cursorX + w > 960) {
          cursorX = 0;
          cursorY += rowMaxH;
          rowMaxH = 0;
        }
        x = cursorX;
        y = cursorY;
        cursorX += w;
        rowMaxH = Math.max(rowMaxH, h);
      } else if (allZero && index === 0) {
        cursorX = w;
        rowMaxH = h;
      }

      const posOverride = dragPositions[room.id];
      return {
        room,
        x: posOverride ? posOverride.x : x,
        y: posOverride ? posOverride.y : y,
        w,
        h,
        type: room.room_type ?? inferRoomTypeFromName(room.name),
      };
    });
  }, [rooms, dragPositions, resizeDims]);

  const baseBox = useMemo(() => {
    if (positionedRooms.length === 0) {
      return { x: 0, y: 0, width: 640, height: 360 };
    }
    const minX = Math.min(...positionedRooms.map((r) => r.x)) - 36;
    const minY = Math.min(...positionedRooms.map((r) => r.y)) - 36;
    const maxX = Math.max(...positionedRooms.map((r) => r.x + r.w)) + 36;
    const maxY = Math.max(...positionedRooms.map((r) => r.y + r.h)) + 36;
    const width = Math.max(460, maxX - minX);
    const height = Math.max(300, maxY - minY);
    return { x: minX, y: minY, width, height };
  }, [positionedRooms]);

  const activeBox = useMemo(() => {
    const vbW = baseBox.width / zoom;
    const vbH = baseBox.height / zoom;
    const cx = baseBox.x + baseBox.width / 2 + pan.x;
    const cy = baseBox.y + baseBox.height / 2 + pan.y;
    return {
      x: cx - vbW / 2,
      y: cy - vbH / 2,
      width: vbW,
      height: vbH,
    };
  }, [baseBox, zoom, pan]);

  const viewBox = `${activeBox.x} ${activeBox.y} ${activeBox.width} ${activeBox.height}`;

  function clampZoom(next: number) {
    return Math.min(3, Math.max(0.6, Number(next.toFixed(2))));
  }

  function handleResetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  const isFullscreen = viewMode === "fullscreen";
  const isWideOrFullscreen = viewMode === "wide" || viewMode === "fullscreen";

  // Sync fullscreen viewport lock, html marker (for Dynamic Island centering), and Escape exit
  useEffect(() => {
    if (!isFullscreen) {
      setFullscreenRoomOpen(false);
      document.documentElement.removeAttribute("data-hc-fullscreen-map");
      return;
    }

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.setAttribute("data-hc-fullscreen-map", "true");

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (
        document.querySelector(
          '[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="select-content"], [data-island-layer]'
        )
      ) {
        return;
      }
      e.preventDefault();
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
  }, [isFullscreen, fullscreenRoomOpen]);

  // Native non-passive wheel zoom listener so preventDefault works cleanly without browser warnings
  const zoomStateRef = useRef({ zoom, baseBox });
  zoomStateRef.current = { zoom, baseBox };

  const roomCount = rooms.length;
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { zoom: currentZoom, baseBox: box } = zoomStateRef.current;
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const nextZoom = clampZoom(currentZoom * factor);
      if (nextZoom === currentZoom) return;

      const rect = svgEl.getBoundingClientRect();
      // SVG uses xMidYMid meet: account for letterboxing at extreme viewport ratios.
      const scale = Math.max(box.width / currentZoom / Math.max(1, rect.width), box.height / currentZoom / Math.max(1, rect.height));
      const rx = (e.clientX - rect.left - rect.width / 2) * scale / (box.width / currentZoom);
      const ry = (e.clientY - rect.top - rect.height / 2) * scale / (box.height / currentZoom);
      const oldW = box.width / currentZoom;
      const oldH = box.height / currentZoom;
      const newW = box.width / nextZoom;
      const newH = box.height / nextZoom;

      setPan((prev) => ({
        x: prev.x + rx * (oldW - newW),
        y: prev.y + ry * (oldH - newH),
      }));
      setZoom(nextZoom);
    };

    svgEl.addEventListener("wheel", onWheel, { passive: false });
    return () => svgEl.removeEventListener("wheel", onWheel);
  }, [roomCount, viewMode]);

  const activeSelectedId =
    selectedRoomId && rooms.some((r) => r.id === selectedRoomId)
      ? selectedRoomId
      : rooms[0]?.id ?? null;
  const selectedRoom = positionedRooms.find((r) => r.room.id === activeSelectedId) ?? null;

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

  const activeLightsAcrossHome = useMemo(() => {
    const swOn = effectiveSwitches.filter((s) => s.is_on);
    const devLightsOn = effectiveDevices.filter(
      (d) => isDeviceStateActive(d.state) && isLightingFixture("device", d.device_type)
    );
    return { switches: swOn, devices: devLightsOn, total: swOn.length + devLightsOn.length };
  }, [effectiveSwitches, effectiveDevices]);

  const roomLights = useMemo(() => {
    const devLights = roomDevices.filter((d) => isLightingFixture("device", d.device_type));
    const anyOn =
      roomSwitches.some((s) => s.is_on) ||
      devLights.some((d) => isDeviceStateActive(d.state));
    return {
      switches: roomSwitches,
      devices: devLights,
      count: roomSwitches.length + devLights.length,
      anyOn,
    };
  }, [roomSwitches, roomDevices]);

  const unassignedItems = useMemo(() => {
    const items: Array<{ key: string; kind: "switch" | "device" | "sensor"; id: string; label: string }> = [];
    for (const s of effectiveSwitches) {
      if (!s.room_id) items.push({ key: `switch:${s.id}`, kind: "switch", id: s.id, label: `Switch · ${s.name}` });
    }
    for (const d of effectiveDevices) {
      if (!d.room_id) items.push({ key: `device:${d.id}`, kind: "device", id: d.id, label: `Device · ${d.name}` });
    }
    for (const s of sensors) {
      if (!s.room_id) items.push({ key: `sensor:${s.id}`, kind: "sensor", id: s.id, label: `Sensor · ${s.name}` });
    }
    return items;
  }, [effectiveSwitches, effectiveDevices, sensors]);

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
        toast.error(
          err instanceof ApiError ? err.message : `Failed to toggle "${sw.name}".`
        );
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

  const toggleDevice = useCallback(
    async (dev: DeviceItem, explicitOn?: boolean) => {
      if (inFlightIdsRef.current.has(dev.id)) return;
      const isCurrentlyOn = isDeviceStateActive(dev.state);
      const targetOn = explicitOn !== undefined ? explicitOn : !isCurrentlyOn;
      if (targetOn === isCurrentlyOn) return;
      const nextState = targetOn ? "on" : "off";

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
        toast.error(
          err instanceof ApiError ? err.message : `Failed to control "${dev.name}".`
        );
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

  async function handleBatchLights(
    targets: { switches: SwitchItem[]; devices: DeviceItem[] },
    turnOn: boolean
  ) {
    if (!canOperate || batchPending) return;
    setBatchPending(true);
    try {
      await Promise.all([
        ...targets.switches
          .filter((s) => s.is_on !== turnOn)
          .map((s) => toggleSwitch(s, turnOn)),
        ...targets.devices
          .filter((d) => isDeviceStateActive(d.state) !== turnOn)
          .map((d) => toggleDevice(d, turnOn)),
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
      toast.error(
        err instanceof ApiError ? err.message : "Failed to assign hardware to room."
      );
    } finally {
      setPendingIds((prev) => {
        const copy = { ...prev };
        delete copy[id!];
        return copy;
      });
    }
  }

  function handlePointerDownRoom(e: React.PointerEvent, pr: PositionedRoom) {
    if (!editMode || !canEdit) {
      roomClickCandidateRef.current = {
        roomId: pr.room.id,
        startClientX: e.clientX,
        startClientY: e.clientY,
      };
      return;
    }
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setSelectedRoomId(pr.room.id);
    dragStateRef.current = {
      roomId: pr.room.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX: pr.x,
      origY: pr.y,
    };
  }

  function handlePointerDownResize(e: React.PointerEvent, pr: PositionedRoom) {
    if (!editMode || !canEdit) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    resizeStateRef.current = {
      roomId: pr.room.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origW: pr.w,
      origH: pr.h,
    };
  }

  function handlePointerDownSvg(e: React.PointerEvent) {
    activeTouchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activeTouchesRef.current.size === 2) {
      const pts = Array.from(activeTouchesRef.current.values());
      const dist = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
      pinchStateRef.current = { startDist: Math.max(10, dist), startZoom: zoom };
      panStateRef.current = null;
      return;
    }
    if (e.button !== 0 || dragStateRef.current || resizeStateRef.current) return;
    svgPanStartRef.current = { startClientX: e.clientX, startClientY: e.clientY };
    suppressNextRoomClickRef.current = false;
    panStateRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      origPanX: pan.x,
      origPanY: pan.y,
    };
  }

  function handlePointerMoveSvg(e: React.PointerEvent) {
    if (activeTouchesRef.current.has(e.pointerId)) {
      activeTouchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (activeTouchesRef.current.size === 2 && pinchStateRef.current) {
      const pts = Array.from(activeTouchesRef.current.values());
      const dist = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
      const scale = dist / pinchStateRef.current.startDist;
      setZoom(clampZoom(pinchStateRef.current.startZoom * scale));
      return;
    }

    const resizer = resizeStateRef.current;
    if (resizer && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const scaleX = Math.max(activeBox.width / Math.max(1, rect.width), activeBox.height / Math.max(1, rect.height));
      const scaleY = scaleX;
      const dx = (e.clientX - resizer.startClientX) * scaleX;
      const dy = (e.clientY - resizer.startClientY) * scaleY;
      const snappedW = Math.max(140, Math.min(1200, Math.round((resizer.origW + dx) / 20) * 20));
      const snappedH = Math.max(140, Math.min(1200, Math.round((resizer.origH + dy) / 20) * 20));
      setResizeDims((prev) => ({
        ...prev,
        [resizer.roomId]: { w: snappedW, h: snappedH },
      }));
      return;
    }

    const drag = dragStateRef.current;
    if (drag && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const scaleX = Math.max(activeBox.width / Math.max(1, rect.width), activeBox.height / Math.max(1, rect.height));
      const scaleY = scaleX;
      const dx = (e.clientX - drag.startClientX) * scaleX;
      const dy = (e.clientY - drag.startClientY) * scaleY;
      const snappedX = Math.round((drag.origX + dx) / 20) * 20;
      const snappedY = Math.round((drag.origY + dy) / 20) * 20;
      setDragPositions((prev) => ({
        ...prev,
        [drag.roomId]: { x: snappedX, y: snappedY },
      }));
      return;
    }

    const panDrag = panStateRef.current;
    if (panDrag && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const scaleX = Math.max(activeBox.width / Math.max(1, rect.width), activeBox.height / Math.max(1, rect.height));
      const scaleY = scaleX;
      const dx = (e.clientX - panDrag.startClientX) * scaleX;
      const dy = (e.clientY - panDrag.startClientY) * scaleY;
      setPan({
        x: panDrag.origPanX - dx,
        y: panDrag.origPanY - dy,
      });
    }
  }

  async function handlePointerUpSvg(e: React.PointerEvent) {
    activeTouchesRef.current.delete(e.pointerId);
    if (activeTouchesRef.current.size < 2) {
      pinchStateRef.current = null;
    }
    panStateRef.current = null;

    const panStart = svgPanStartRef.current;
    svgPanStartRef.current = null;
    if (panStart) {
      const panDist = Math.hypot(
        e.clientX - panStart.startClientX,
        e.clientY - panStart.startClientY
      );
      suppressNextRoomClickRef.current = panDist >= 6;
    }

    const candidate = roomClickCandidateRef.current;
    roomClickCandidateRef.current = null;
    if (candidate) {
      const movedDist = Math.hypot(
        e.clientX - candidate.startClientX,
        e.clientY - candidate.startClientY
      );
      if (movedDist < 6) {
        setSelectedRoomId(candidate.roomId);
        if (isFullscreen) {
          setFullscreenRoomOpen(true);
        }
      } else {
        suppressNextRoomClickRef.current = true;
      }
    }

    const resizer = resizeStateRef.current;
    if (resizer) {
      resizeStateRef.current = null;
      const resized = resizeDims[resizer.roomId];
      if (resized && (resized.w !== resizer.origW || resized.h !== resizer.origH)) {
        try {
          await apiFetch(`/api/homes/rooms/${resizer.roomId}`, {
            method: "PATCH",
            body: JSON.stringify({ floorW: resized.w, floorH: resized.h }),
          });
          await onReload();
        } catch (err) {
          toast.error(
            err instanceof ApiError ? err.message : "Failed to save room size."
          );
        } finally {
          setResizeDims((prev) => {
            const copy = { ...prev };
            delete copy[resizer.roomId];
            return copy;
          });
        }
      }
      return;
    }

    const drag = dragStateRef.current;
    if (!drag) return;
    dragStateRef.current = null;
    const moved = dragPositions[drag.roomId];
    if (!moved) return;
    if (moved.x === drag.origX && moved.y === drag.origY) return;
    try {
      await apiFetch(`/api/homes/rooms/${drag.roomId}`, {
        method: "PATCH",
        body: JSON.stringify({ floorX: moved.x, floorY: moved.y }),
      });
      await onReload();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to save room position."
      );
    } finally {
      setDragPositions((prev) => {
        const copy = { ...prev };
        delete copy[drag.roomId];
        return copy;
      });
    }
  }

  const handleToggleFixture = useCallback(
    (item: FloorFixtureItem) => {
      if (item.kind === "switch") {
        const sw = effectiveSwitches.find((s) => s.id === item.id);
        if (sw) void toggleSwitch(sw);
      } else {
        const dev = effectiveDevices.find((d) => d.id === item.id);
        if (dev) void toggleDevice(dev);
      }
    },
    [effectiveSwitches, effectiveDevices, toggleSwitch, toggleDevice]
  );

  if (rooms.length === 0) {
    return (
      <EmptyStatePanel
        icon={<RiLayoutGridLine />}
        title="No rooms mapped on your 2D floor plan yet"
        description="Add your first room—such as a Living Room, Kitchen, or Bedroom—and HomecoreOS will render its architectural layout and automatically snap additional rooms alongside it."
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
            onNavigateRooms && (
              <Button onClick={onNavigateRooms}>Go to Rooms</Button>
            )
          )
        }
      />
    );
  }

  const renderRoomInspectorBody = (showCloseButton = false) => {
    if (!selectedRoom) return null;
    return (
      <div className="flex min-h-0 flex-1 flex-col divide-y">
        <div className="flex items-start justify-between gap-2 p-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-foreground">
                {selectedRoom.room.name}
              </h3>
              <Badge
                variant={
                  roomSwitches.some((s) => s.is_on) ||
                  roomDevices.some((d) => isDeviceStateActive(d.state))
                    ? "warning-light"
                    : "secondary"
                }
                radius="full"
              >
                {roomSwitches.filter((s) => s.is_on).length +
                  roomDevices.filter((d) => isDeviceStateActive(d.state)).length}{" "}
                Active
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {roomSwitches.length} switches · {roomDevices.length} devices ·{" "}
              {roomSensors.length} sensors
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {canOperate && roomLights.count > 0 && (
              <Button
                size="xs"
                variant={roomLights.anyOn ? "secondary" : "outline"}
                disabled={batchPending}
                onClick={() =>
                  void handleBatchLights(
                    { switches: roomLights.switches, devices: roomLights.devices },
                    !roomLights.anyOn
                  )
                }
              >
                <RiLightbulbFlashLine className="size-3.5" aria-hidden="true" />
                {roomLights.anyOn ? "Room Off" : "Room On"}
              </Button>
            )}
            {canEdit && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setEditingRoom(selectedRoom.room);
                  setEditorOpen(true);
                }}
              >
                <RiEditLine className="size-3.5" aria-hidden="true" />
                Edit Room
              </Button>
            )}
            {showCloseButton && (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Close room controls popup"
                onClick={() => setFullscreenRoomOpen(false)}
              >
                <RiCloseLine className="size-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>

        <div
          className={cn(
            "flex-1 space-y-2.5 overflow-y-auto p-4",
            isFullscreen
              ? "min-h-0"
              : isWideOrFullscreen
                ? "max-h-[340px]"
                : "max-h-[390px]"
          )}
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Controls
          </p>
          {roomSwitches.length === 0 && roomDevices.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No switches or devices assigned to this room yet.
            </p>
          )}
          {roomSwitches.map((sw) => {
            const online = isEntityOnline(sw.is_online, ctrlById.get(sw.controller_id));
            const isPending = Boolean(pendingIds[sw.id]);
            return (
              <div
                key={sw.id}
                className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <IconTile
                    variant="soft"
                    size="xs"
                    className={sw.is_on ? "text-warning" : "text-muted-foreground"}
                  >
                    {sw.is_on ? (
                      <RiLightbulbFlashLine className="size-3.5" />
                    ) : (
                      <RiLightbulbLine className="size-3.5" />
                    )}
                  </IconTile>
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">
                      {sw.name}
                    </p>
                    <p className="text-[11px] font-mono text-muted-foreground">
                      GPIO {sw.gpio_pin} · {online ? "Online" : "Offline"}
                    </p>
                  </div>
                </div>
                <Switch
                  checked={sw.is_on}
                  disabled={!canOperate || isPending}
                  onCheckedChange={(checked) => void toggleSwitch(sw, checked)}
                  aria-label={`Toggle ${sw.name}`}
                />
              </div>
            );
          })}

          {roomDevices.map((dev) => {
            const active = isDeviceStateActive(dev.state);
            const online = isEntityOnline(dev.is_online, ctrlById.get(dev.controller_id));
            const isPending = Boolean(pendingIds[dev.id]);
            return (
              <div
                key={dev.id}
                className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <IconTile variant="soft" size="xs" className="text-primary">
                    <RiFlashlightLine className="size-3.5" />
                  </IconTile>
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">
                      {dev.name}
                    </p>
                    <p className="text-[11px] font-mono text-muted-foreground">
                      {dev.device_type} · GPIO {dev.gpio_pin} · {online ? "Online" : "Offline"}
                    </p>
                  </div>
                </div>
                <Button
                  size="xs"
                  variant={active ? "default" : "outline"}
                  disabled={!canOperate || isPending}
                  onClick={() => void toggleDevice(dev)}
                >
                  {isPending ? "..." : active ? "On" : "Off"}
                </Button>
              </div>
            );
          })}

          {roomSensors.length > 0 && (
            <div className="pt-2 space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Sensors
              </p>
              {roomSensors.map((sensor) => {
                const online = isEntityOnline(
                  sensor.is_online,
                  ctrlById.get(sensor.controller_id)
                );
                return (
                  <div
                    key={sensor.id}
                    className="flex items-center justify-between rounded-lg border bg-card px-3 py-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <RiSensorLine
                        className={cn(
                          "size-4 shrink-0",
                          online ? "text-success" : "text-muted-foreground"
                        )}
                      />
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-foreground">
                          {sensor.name}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {online ? "Live" : "Offline"} ·{" "}
                          {sensor.last_reading_at
                            ? formatShortTime(sensor.last_reading_at, timezone)
                            : "Awaiting telemetry"}
                        </p>
                      </div>
                    </div>
                    <Badge variant="success-light" radius="default" className="tabular-nums">
                      <RiPulseLine className="size-3" aria-hidden="true" />
                      {sensor.last_value !== null ? `${sensor.last_value} ${sensor.unit}` : "—"}
                    </Badge>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {canEdit && unassignedItems.length > 0 && (
          <div className="p-3 bg-muted/40 space-y-2">
            <p className="text-[11px] font-medium text-muted-foreground">
              Assign unassigned hardware to {selectedRoom.room.name}
            </p>
            <div className="flex gap-2">
              <Select value={assignTargetId} onValueChange={setAssignTargetId}>
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
                disabled={!assignTargetId || Object.keys(pendingIds).length > 0}
                onClick={() => void handleAssignToRoom()}
              >
                Assign
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div
        data-testid="floorplan-container"
        data-view-mode={viewMode}
        className={cn(
          isFullscreen
            ? "fixed inset-0 z-50 flex h-[100dvh] w-full flex-col overflow-hidden bg-background"
            : "space-y-3"
        )}
      >
        <div
          className={cn(
            isFullscreen
              ? "flex min-h-0 min-w-0 flex-1 flex-col"
              : cn(
                  "grid gap-4",
                  viewMode === "wide"
                    ? "grid-cols-1"
                    : "grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px]"
                )
          )}
        >
          <Card
            className={cn(
              "gap-0 overflow-hidden py-0",
              isFullscreen && "flex min-h-0 flex-1 flex-col rounded-none border-0 ring-0"
            )}
          >
            {/* Map View Header Bar */}
            <div
              data-testid="floorplan-header-bar"
              className={cn(
                "flex flex-wrap items-center justify-between gap-2 border-b bg-muted/50 px-4 text-xs",
                isFullscreen ? "max-h-[45dvh] shrink-0 overflow-y-auto pb-2.5 pt-14 sm:px-6" : "py-2"
              )}
            >
              <div className="flex flex-wrap items-center gap-3 min-w-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="Interactive 2D Home Floor Plan details"
                      className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm font-semibold text-foreground transition-colors hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span>Interactive 2D Home Floor Plan</span>
                      <RiInformationLine
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    align="start"
                    className="max-w-xs flex-col items-start gap-1 p-2.5 text-xs"
                  >
                    <p className="font-semibold">Interactive 2D Home Floor Plan</p>
                    <p className="text-[11px] leading-relaxed opacity-90">
                      Click fixtures directly on the map to toggle hardware, drag to pan, or jump between rooms.
                    </p>
                  </TooltipContent>
                </Tooltip>

                <div className="hidden sm:flex flex-wrap items-center gap-3 text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full bg-amber-400 ring-2 ring-amber-400/30" />
                    Lit Room
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full bg-slate-500/60" />
                    Unlit / Quiet
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full bg-emerald-500" />
                    Live Sensor
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {editMode && (
                  <Badge variant="warning-light" radius="full" className="mr-1">
                    Drag room to move · Drag corner to resize (20px)
                  </Badge>
                )}

                {canOperate && activeLightsAcrossHome.total > 0 && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={batchPending}
                    onClick={() =>
                      void handleBatchLights(
                        {
                          switches: activeLightsAcrossHome.switches,
                          devices: activeLightsAcrossHome.devices,
                        },
                        false
                      )
                    }
                  >
                    <RiShutDownLine className="size-3.5 text-warning" aria-hidden="true" />
                    All Lights Off ({activeLightsAcrossHome.total})
                  </Button>
                )}

                {/* 3-State Map View Selector: Standard View | Wide View | Full Screen */}
                <div
                  role="group"
                  aria-label="Floor plan view mode"
                  className="inline-flex items-center rounded-lg border bg-background/80 p-0.5"
                >
                  <Button
                    type="button"
                    size="xs"
                    variant={viewMode === "standard" ? "secondary" : "ghost"}
                    aria-pressed={viewMode === "standard"}
                    onClick={() => {
                      setFullscreenRoomOpen(false);
                      setViewMode("standard");
                    }}
                  >
                    <RiLayoutColumnLine className="size-3.5" aria-hidden="true" />
                    Standard View
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant={viewMode === "wide" ? "secondary" : "ghost"}
                    aria-pressed={viewMode === "wide"}
                    onClick={() => {
                      setFullscreenRoomOpen(false);
                      setViewMode("wide");
                    }}
                  >
                    <RiLayoutRowLine className="size-3.5" aria-hidden="true" />
                    Wide View
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant={isFullscreen ? "secondary" : "ghost"}
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
                    {isFullscreen ? "Exit Full Screen" : "Full Screen"}
                  </Button>
                </div>

                {canEdit && (
                  <>
                    <Button
                      size="xs"
                      variant={editMode ? "default" : "outline"}
                      onClick={() => {
                        setEditMode((v) => !v);
                        setFullscreenRoomOpen(false);
                      }}
                    >
                      {editMode ? (
                        <RiCheckLine className="size-3.5" aria-hidden="true" />
                      ) : (
                        <RiDragMove2Line className="size-3.5" aria-hidden="true" />
                      )}
                      {editMode ? "Done Positioning" : "Arrange Floor Plan"}
                    </Button>
                    {primaryHomeId && (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          setEditingRoom(null);
                          setEditorOpen(true);
                        }}
                      >
                        <RiAddLine className="size-3.5" aria-hidden="true" />
                        Add Room
                      </Button>
                    )}
                  </>
                )}

                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="outline"
                    aria-label="Zoom out floor plan"
                    onClick={() => setZoom((z) => clampZoom(z - 0.2))}
                  >
                    <RiZoomOutLine className="size-3.5" aria-hidden="true" />
                  </Button>
                  <Badge
                    variant="secondary"
                    size="xs"
                    className="min-w-11 justify-center font-mono tabular-nums"
                  >
                    {Math.round(zoom * 100)}%
                  </Badge>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="outline"
                    aria-label="Zoom in floor plan"
                    onClick={() => setZoom((z) => clampZoom(z + 0.2))}
                  >
                    <RiZoomInLine className="size-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    aria-label="Reset floor plan view"
                    onClick={handleResetView}
                  >
                    <RiFocus3Line className="size-3.5" aria-hidden="true" />
                    Fit
                  </Button>
                </div>
              </div>
            </div>

            <div
              className={cn(
                "hc-blueprint-bg relative min-w-0 overflow-hidden p-3 sm:p-4",
                isFullscreen && "flex-1 min-h-0"
              )}
            >
              <svg
                ref={svgRef}
                viewBox={viewBox}
                className={cn(
                  "w-full select-none touch-none rounded-lg cursor-grab active:cursor-grabbing",
                  isFullscreen
                    ? "h-full"
                    : viewMode === "wide"
                      ? "h-[460px] sm:h-[580px]"
                      : "h-[380px] sm:h-[490px]"
                )}
                onPointerDown={handlePointerDownSvg}
                onPointerMove={handlePointerMoveSvg}
                onPointerUp={(e) => void handlePointerUpSvg(e)}
                onPointerCancel={(e) => {
                  roomClickCandidateRef.current = null;
                  svgPanStartRef.current = null;
                  suppressNextRoomClickRef.current = false;
                  void handlePointerUpSvg(e);
                }}
                onClick={() => {
                  if (suppressNextRoomClickRef.current) {
                    suppressNextRoomClickRef.current = false;
                    return;
                  }
                  if (isFullscreen && fullscreenRoomOpen) {
                    setFullscreenRoomOpen(false);
                  }
                }}
                role="img"
                aria-label="Interactive 2D Architectural Home Floor Plan"
              >
                <FloorPatternDefs />

                {positionedRooms.map((pr) => {
                  const sws = effectiveSwitches.filter((s) => s.room_id === pr.room.id);
                  const devs = effectiveDevices.filter((d) => d.room_id === pr.room.id);
                  const sens = sensors.filter((s) => s.room_id === pr.room.id);
                  const fixtures: FloorFixtureItem[] = [
                    ...sws.map((s) => ({
                      id: s.id,
                      kind: "switch" as const,
                      name: s.name,
                      deviceType: "light",
                      isOn: s.is_on,
                      online: isEntityOnline(s.is_online, ctrlById.get(s.controller_id)),
                      pending: Boolean(pendingIds[s.id]),
                    })),
                    ...devs.map((d) => ({
                      id: d.id,
                      kind: "device" as const,
                      name: d.name,
                      deviceType: d.device_type,
                      isOn: isDeviceStateActive(d.state),
                      online: isEntityOnline(d.is_online, ctrlById.get(d.controller_id)),
                      pending: Boolean(pendingIds[d.id]),
                    })),
                  ];

                  const activeLightsCount = fixtures.filter(
                    (f) => f.isOn && isLightingFixture(f.kind, f.deviceType)
                  ).length;
                  const activeCount = fixtures.filter((f) => f.isOn).length;
                  const isRoomLit = activeLightsCount > 0;
                  const isSelected = pr.room.id === activeSelectedId;
                  const liveSensors = sens
                    .filter((s) => s.last_value !== null)
                    .slice(0, 2);

                  return (
                    <g
                      key={pr.room.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${pr.room.name} room`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (suppressNextRoomClickRef.current) {
                          suppressNextRoomClickRef.current = false;
                          return;
                        }
                        if (!editMode) {
                          setSelectedRoomId(pr.room.id);
                          if (isFullscreen) {
                            setFullscreenRoomOpen(true);
                          }
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedRoomId(pr.room.id);
                          if (isFullscreen && !editMode) {
                            setFullscreenRoomOpen(true);
                          }
                        }
                      }}
                      onPointerDown={(e) => handlePointerDownRoom(e, pr)}
                      className={
                        editMode
                          ? "cursor-grab active:cursor-grabbing focus:outline-none"
                          : "cursor-pointer focus:outline-none"
                      }
                    >
                      <rect
                        x={pr.x}
                        y={pr.y}
                        width={pr.w}
                        height={pr.h}
                        fill={getFloorPatternUrl(pr.room.layout_config?.floorStyle)}
                      />
                      <RoomFurnitureArt
                        roomType={pr.type}
                        x={pr.x}
                        y={pr.y}
                        w={pr.w}
                        h={pr.h}
                      />
                      {isRoomLit ? (
                        <rect
                          x={pr.x}
                          y={pr.y}
                          width={pr.w}
                          height={pr.h}
                          fill="url(#hc-room-warm-glow)"
                          fillOpacity={Math.min(1, 0.58 + activeLightsCount * 0.16)}
                        />
                      ) : (
                        <rect
                          x={pr.x}
                          y={pr.y}
                          width={pr.w}
                          height={pr.h}
                          fill="#0F172A"
                          fillOpacity={activeCount > 0 ? 0.08 : 0.16}
                        />
                      )}
                      <rect
                        x={pr.x}
                        y={pr.y}
                        width={pr.w}
                        height={pr.h}
                        fill="none"
                        stroke={isSelected ? "#3B76F6" : "#1E293B"}
                        strokeWidth={isSelected ? 5 : 4}
                      />
                      <RoomOpeningsSvg
                        x={pr.x}
                        y={pr.y}
                        w={pr.w}
                        h={pr.h}
                        doors={pr.room.layout_config?.doors}
                        windows={pr.room.layout_config?.windows}
                      />
                      <g transform={`translate(${pr.x + 12}, ${pr.y + pr.h - 32})`}>
                        <rect
                          x="0"
                          y="0"
                          width={Math.min(pr.w - 24, 184)}
                          height="22"
                          rx="6"
                          fill={isSelected ? "#2563EB" : "#0F172A"}
                          fillOpacity={isSelected ? 0.94 : 0.82}
                        />
                        <text
                          x="9"
                          y="14.5"
                          fill="#F8FAFC"
                          fontSize="11"
                          fontWeight="600"
                        >
                          {pr.room.name.slice(0, 18)}
                        </text>
                        {activeCount > 0 && (
                          <g transform={`translate(${Math.min(pr.w - 24, 184) - 42}, 3)`}>
                            <rect width="36" height="16" rx="4" fill="#F59E0B" />
                            <text
                              x="18"
                              y="11"
                              textAnchor="middle"
                              fill="#0F172A"
                              fontSize="9.5"
                              fontWeight="700"
                            >
                              {activeCount} ON
                            </text>
                          </g>
                        )}
                      </g>
                      {liveSensors.map((sensor, sIdx) => (
                        <g
                          key={sensor.id}
                          transform={`translate(${pr.x + 12}, ${pr.y + 12 + sIdx * 24})`}
                        >
                          <rect
                            width="86"
                            height="20"
                            rx="5"
                            fill="#0F172A"
                            fillOpacity="0.82"
                          />
                          <circle
                            cx="11"
                            cy="10"
                            r="3"
                            fill={
                              isEntityOnline(sensor.is_online, ctrlById.get(sensor.controller_id))
                                ? "#10B981"
                                : "#94A3B8"
                            }
                          />
                          <text x="19" y="13.5" fill="#F8FAFC" fontSize="10" fontWeight="600">
                            {sensor.last_value} {sensor.unit}
                          </text>
                        </g>
                      ))}
                      <FloorDeviceFixtures
                        x={pr.x}
                        y={pr.y}
                        w={pr.w}
                        h={pr.h}
                        fixtures={fixtures}
                        interactive={!editMode && canOperate}
                        onToggleFixture={handleToggleFixture}
                      />

                      {/* Resize corner grip in arrange mode */}
                      {editMode && canEdit && isSelected && (
                        <g
                          transform={`translate(${pr.x + pr.w - 10}, ${pr.y + pr.h - 10})`}
                          onPointerDown={(e) => handlePointerDownResize(e, pr)}
                          className="cursor-nwse-resize"
                        >
                          <title>Drag corner to resize room</title>
                          <rect
                            width="14"
                            height="14"
                            rx="3"
                            fill="#3B76F6"
                            stroke="#FFFFFF"
                            strokeWidth="1.5"
                          />
                        </g>
                      )}
                    </g>
                  );
                })}
              </svg>

              {/* Full Screen Room Controls & Sensors Popup inside the Blueprint */}
              {isFullscreen && fullscreenRoomOpen && selectedRoom && (
                <div
                  data-testid="fullscreen-room-popup"
                  role="dialog"
                  aria-modal="false"
                  aria-label={`${selectedRoom.room.name} controls and sensors`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onWheel={(e) => e.stopPropagation()}
                  className="absolute right-4 bottom-4 top-4 z-20 flex w-[min(376px,calc(100%-2rem))] flex-col overflow-hidden rounded-xl border bg-card/95 shadow-2xl backdrop-blur-md sm:left-auto"
                >
                  {renderRoomInspectorBody(true)}
                </div>
              )}
            </div>
          </Card>

          {!isFullscreen && (
            <Card className="flex flex-col gap-0 py-0">
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
    </TooltipProvider>
  );
});
