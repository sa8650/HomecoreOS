import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { RiDragMove2Line } from "@remixicon/react";
import { isDeviceStateActive } from "@homecoreos/shared";
import { isEntityOnline } from "@/lib/board-pin-helpers";
import { cn } from "@/lib/utils";
import type {
  ControllerItem,
  DeviceItem,
  RoomItem,
  SensorItem,
  SwitchItem,
} from "@/features/types";
import {
  DeviceGlyph,
  FloorMapDefs,
  RoomFloorArt,
  clampFloorZoom,
  classifyDeviceType,
  classifySensorType,
  classifySwitch,
  getFloorPatternUrl,
  getRoomPalette,
  isLightingKind,
} from "./floor-visuals";
import {
  WALL_THICKNESS,
  buildHousePlan,
  placeRoomDevices,
  roomLabelAnchor,
  type HousePlan,
  type PlanRect,
  type PlanRoom,
} from "./house-layout";
import { DeviceControlPopover, type MapBadge } from "./DeviceControlPopover";

const VIEW_PADDING = 20;
const MAX_BADGES_PER_ROOM = 14;
/** Edge magnetism: how close (plan units) a dragged room snaps flush to another. */
const DRAG_SNAP = 12;
/** Arrange-mode grid. Small on purpose so rooms can be sized precisely. */
const ROOM_GRID = 4;
/** Grid lines drawn while arranging (a 10-unit sub-grid of ROOM_GRID snapping). */
const GRID_HINT = 10;
const MIN_ROOM_DIM = 110;

interface RoomBadges {
  visible: MapBadge[];
  overflow: MapBadge[];
}

function formatSensorValue(sensor: SensorItem): string | undefined {
  if (sensor.last_value === null || sensor.last_value === undefined) return undefined;
  const unit = (sensor.unit ?? "").trim();
  if (!unit) return String(sensor.last_value);
  return unit.startsWith("°") || unit === "%"
    ? `${sensor.last_value}${unit}`
    : `${sensor.last_value} ${unit}`;
}

/**
 * The interactive 2D smart-home floor map.
 *
 * Renders one connected house plan built from the user's real rooms and draws
 * every switch, device and sensor as a white badge at its room position. State,
 * hardware type, online/offline and pending flags all come straight from the
 * HomecoreOS overview payload — nothing here is decorative.
 */
export const SmartHomeMap = memo(function SmartHomeMap({
  rooms,
  devices,
  switches,
  sensors,
  controllers,
  selectedRoomId,
  selectedDeviceKey,
  onSelectRoom,
  onSelectDevice,
  canOperate,
  canEdit,
  editMode,
  pendingIds,
  zoom,
  pan,
  onZoomChange,
  onPanChange,
  onToggleSwitch,
  onToggleDevice,
  onSetDeviceState,
  onRoomRectCommit,
  onDevicePositionCommit,
  heightClassName,
  className,
  onBackgroundClick,
  children,
}: {
  rooms: RoomItem[];
  devices: DeviceItem[];
  switches: SwitchItem[];
  sensors: SensorItem[];
  controllers: ControllerItem[];
  selectedRoomId: string | null;
  selectedDeviceKey: string | null;
  onSelectRoom: (roomId: string) => void;
  onSelectDevice: (key: string | null) => void;
  canOperate: boolean;
  canEdit: boolean;
  editMode: boolean;
  pendingIds: Record<string, boolean>;
  zoom: number;
  pan: { x: number; y: number };
  onZoomChange: (zoom: number) => void;
  onPanChange: (pan: { x: number; y: number }) => void;
  onToggleSwitch: (item: SwitchItem, next?: boolean) => void;
  onToggleDevice: (item: DeviceItem, next?: boolean) => void;
  onSetDeviceState: (item: DeviceItem, state: string) => void;
  onRoomRectCommit: (roomId: string, rect: PlanRect) => void | Promise<void>;
  onDevicePositionCommit: (
    roomId: string,
    deviceKey: string,
    position: { x: number; y: number }
  ) => void | Promise<void>;
  heightClassName?: string;
  className?: string;
  onBackgroundClick?: () => void;
  children?: ReactNode;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Partial<PlanRect>>>({});
  const [hoveredRoomId, setHoveredRoomId] = useState<string | null>(null);
  const [hoveredBadgeKey, setHoveredBadgeKey] = useState<string | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [popoverAnchor, setPopoverAnchor] = useState<{ left: number; top: number } | null>(null);
  const [badgeDrag, setBadgeDrag] = useState<{
    key: string;
    roomId: string;
    point: { x: number; y: number };
  } | null>(null);
  const badgeDragRef = useRef<{
    key: string;
    roomId: string;
    room: PlanRoom;
    startX: number;
    startY: number;
    origin: { x: number; y: number };
    moved: boolean;
  } | null>(null);

  const ctrlById = useMemo(() => new Map(controllers.map((c) => [c.id, c])), [controllers]);

  const resolveOnline = useCallback(
    (isOnline: boolean, boardInstanceId: string) => {
      const controller = ctrlById.get(boardInstanceId);
      return controller ? isEntityOnline(isOnline, controller) : isOnline;
    },
    [ctrlById]
  );

  const committedPlan = useMemo<HousePlan>(() => buildHousePlan(rooms), [rooms]);
  const plan = useMemo<HousePlan>(
    () => (Object.keys(overrides).length === 0 ? committedPlan : buildHousePlan(rooms, overrides)),
    [committedPlan, rooms, overrides]
  );

  const baseView = useMemo(() => {
    const bounds = committedPlan.bounds;
    return {
      x: bounds.x - VIEW_PADDING,
      y: bounds.y - VIEW_PADDING,
      width: Math.max(320, bounds.w + VIEW_PADDING * 2),
      height: Math.max(240, bounds.h + VIEW_PADDING * 2),
    };
  }, [committedPlan]);

  const viewBox = useMemo(() => {
    const width = baseView.width / zoom;
    const height = baseView.height / zoom;
    const cx = baseView.x + baseView.width / 2 + pan.x;
    const cy = baseView.y + baseView.height / 2 + pan.y;
    return { x: cx - width / 2, y: cy - height / 2, width, height };
  }, [baseView, zoom, pan]);

  const viewBoxRef = useRef(viewBox);
  viewBoxRef.current = viewBox;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;

  /* ---------------------------------------------------------------------- */
  /* Badges                                                                  */
  /* ---------------------------------------------------------------------- */

  const badgesByRoom = useMemo(() => {
    const byRoom = new Map<string, MapBadge[]>();
    const push = (roomId: string, badge: MapBadge) => {
      const list = byRoom.get(roomId) ?? [];
      list.push(badge);
      byRoom.set(roomId, list);
    };

    for (const item of switches) {
      if (!item.room_id) continue;
      push(item.room_id, {
        key: `switch:${item.id}`,
        kind: "switch",
        id: item.id,
        name: item.name,
        visual: classifySwitch(item.name),
        isOn: item.is_on,
        online: resolveOnline(item.is_online, item.board_instance_id),
        pending: Boolean(pendingIds[item.id]),
      });
    }

    for (const item of devices) {
      if (!item.room_id) continue;
      push(item.room_id, {
        key: `device:${item.id}`,
        kind: "device",
        id: item.id,
        name: item.name,
        visual: classifyDeviceType(item.device_type, item.name),
        isOn: isDeviceStateActive(item.state),
        online: resolveOnline(item.is_online, item.board_instance_id),
        pending: Boolean(pendingIds[item.id]),
        valueLabel: item.state,
      });
    }

    for (const item of sensors) {
      if (!item.room_id) continue;
      push(item.room_id, {
        key: `sensor:${item.id}`,
        kind: "sensor",
        id: item.id,
        name: item.name,
        visual: classifySensorType(item.sensor_type, item.name),
        isOn: item.last_value !== null && item.last_value !== undefined,
        online: resolveOnline(item.is_online, item.board_instance_id),
        pending: false,
        valueLabel: formatSensorValue(item),
      });
    }
    return byRoom;
  }, [switches, devices, sensors, resolveOnline, pendingIds]);

  const placements = useMemo(() => {
    const result = new Map<string, Record<string, { x: number; y: number }>>();
    for (const room of plan.rooms) {
      const list = badgesByRoom.get(room.id) ?? [];
      result.set(
        room.id,
        placeRoomDevices(
          room,
          list.map((badge) => ({ id: badge.key, kind: badge.visual }))
        )
      );
    }
    return result;
  }, [plan, badgesByRoom]);

  const placementsWithDrag = useMemo(() => {
    if (!badgeDrag) return placements;
    const next = new Map(placements);
    const roomPlacements = { ...(next.get(badgeDrag.roomId) ?? {}) };
    roomPlacements[badgeDrag.key] = badgeDrag.point;
    next.set(badgeDrag.roomId, roomPlacements);
    return next;
  }, [placements, badgeDrag]);

  const roomBadges = useMemo(() => {
    const result = new Map<string, RoomBadges>();
    for (const room of plan.rooms) {
      const list = badgesByRoom.get(room.id) ?? [];
      result.set(room.id, {
        visible: list.slice(0, MAX_BADGES_PER_ROOM),
        overflow: list.slice(MAX_BADGES_PER_ROOM),
      });
    }
    return result;
  }, [plan, badgesByRoom]);

  const selectedBadge = useMemo(() => {
    if (!selectedDeviceKey) return null;
    for (const list of badgesByRoom.values()) {
      const found = list.find((badge) => badge.key === selectedDeviceKey);
      if (found) return found;
    }
    return null;
  }, [badgesByRoom, selectedDeviceKey]);

  const selectedBadgeRoom = useMemo(() => {
    if (!selectedDeviceKey) return null;
    for (const room of plan.rooms) {
      const list = badgesByRoom.get(room.id) ?? [];
      if (list.some((badge) => badge.key === selectedDeviceKey)) return room;
    }
    return null;
  }, [badgesByRoom, plan, selectedDeviceKey]);

  const selectedRoom = useMemo(
    () => plan.rooms.find((room) => room.id === selectedRoomId) ?? null,
    [plan, selectedRoomId]
  );

  /* ---------------------------------------------------------------------- */
  /* Popover anchoring                                                       */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    setContainerSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  const badgeScale = Math.min(1.8, Math.max(0.62, 1 / zoom));

  useEffect(() => {
    if (!selectedBadge || !selectedBadgeRoom || !svgRef.current || !containerRef.current) {
      setPopoverAnchor(null);
      return;
    }
    const point = placementsWithDrag.get(selectedBadgeRoom.id)?.[selectedBadge.key];
    if (!point) {
      setPopoverAnchor(null);
      return;
    }
    const svgRect = svgRef.current.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    const scale = Math.max(
      viewBox.width / Math.max(1, svgRect.width),
      viewBox.height / Math.max(1, svgRect.height)
    );
    const contentWidth = viewBox.width / scale;
    const contentHeight = viewBox.height / scale;
    const offsetX = (svgRect.width - contentWidth) / 2;
    const offsetY = (svgRect.height - contentHeight) / 2;
    setPopoverAnchor({
      left: (point.x - viewBox.x) / scale + offsetX + (svgRect.left - containerRect.left),
      top: (point.y - viewBox.y) / scale + offsetY + (svgRect.top - containerRect.top),
    });
  }, [selectedBadge, selectedBadgeRoom, placementsWithDrag, viewBox, containerSize]);

  /* ---------------------------------------------------------------------- */
  /* Pointer interaction: pan, pinch, room drag, resize                      */
  /* ---------------------------------------------------------------------- */

  const panStateRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const pinchStateRef = useRef<{ startDist: number; startZoom: number } | null>(null);
  const activeTouchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const roomClickRef = useRef<{ roomId: string; startX: number; startY: number } | null>(null);
  const dragRef = useRef<{
    roomId: string;
    startX: number;
    startY: number;
    origin: PlanRect;
  } | null>(null);
  const resizeRef = useRef<{
    roomId: string;
    startX: number;
    startY: number;
    origin: PlanRect;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const clientToPlanScale = useCallback(() => {
    const svg = svgRef.current;
    const vb = viewBoxRef.current;
    const rect = svg?.getBoundingClientRect();
    if (!rect) return { scale: 1, rect: null as DOMRect | null, vb };
    const scale = Math.max(vb.width / Math.max(1, rect.width), vb.height / Math.max(1, rect.height));
    return { scale, rect, vb };
  }, []);

  const snapDragRect = useCallback(
    (roomId: string, rect: PlanRect): PlanRect => {
      const others = plan.rooms.filter((room) => room.id !== roomId);
      let { x, y } = rect;
      for (const other of others) {
        const xTargets = [other.x - rect.w, other.x, other.x + other.w, other.x + other.w - rect.w];
        const yTargets = [other.y - rect.h, other.y, other.y + other.h, other.y + other.h - rect.h];
        for (const target of xTargets) {
          if (Math.abs(target - x) <= DRAG_SNAP) x = target;
        }
        for (const target of yTargets) {
          if (Math.abs(target - y) <= DRAG_SNAP) y = target;
        }
      }
      return { ...rect, x: Math.round(x), y: Math.round(y) };
    },
    [plan]
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      activeTouchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (activeTouchesRef.current.size === 2) {
        const points = Array.from(activeTouchesRef.current.values());
        const distance = Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y);
        pinchStateRef.current = { startDist: Math.max(10, distance), startZoom: zoomRef.current };
        panStateRef.current = null;
        return;
      }
      if (event.button !== 0 || dragRef.current || resizeRef.current) return;
      panStateRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        originX: panRef.current.x,
        originY: panRef.current.y,
      };
      suppressClickRef.current = false;
    },
    []
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (activeTouchesRef.current.has(event.pointerId)) {
        activeTouchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      if (activeTouchesRef.current.size === 2 && pinchStateRef.current) {
        const points = Array.from(activeTouchesRef.current.values());
        const distance = Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y);
        onZoomChange(clampFloorZoom(pinchStateRef.current.startZoom * (distance / pinchStateRef.current.startDist)));
        return;
      }

      const { scale } = clientToPlanScale();

      const resize = resizeRef.current;
      if (resize) {
        const dx = (event.clientX - resize.startX) * scale;
        const dy = (event.clientY - resize.startY) * scale;
        setOverrides((previous) => ({
          ...previous,
          [resize.roomId]: {
            w: Math.max(MIN_ROOM_DIM, Math.round((resize.origin.w + dx) / ROOM_GRID) * ROOM_GRID),
            h: Math.max(MIN_ROOM_DIM, Math.round((resize.origin.h + dy) / ROOM_GRID) * ROOM_GRID),
          },
        }));
        return;
      }

      const drag = dragRef.current;
      if (drag) {
        const dx = (event.clientX - drag.startX) * scale;
        const dy = (event.clientY - drag.startY) * scale;
        const moved = snapDragRect(drag.roomId, {
          ...drag.origin,
          x: Math.round((drag.origin.x + dx) / ROOM_GRID) * ROOM_GRID,
          y: Math.round((drag.origin.y + dy) / ROOM_GRID) * ROOM_GRID,
        });
        setOverrides((previous) => ({
          ...previous,
          [drag.roomId]: { x: moved.x, y: moved.y },
        }));
        return;
      }

      const panDrag = panStateRef.current;
      if (panDrag) {
        onPanChange({
          x: panDrag.originX - (event.clientX - panDrag.startX) * scale,
          y: panDrag.originY - (event.clientY - panDrag.startY) * scale,
        });
      }
    },
    [clientToPlanScale, onPanChange, onZoomChange, snapDragRect]
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      activeTouchesRef.current.delete(event.pointerId);
      if (activeTouchesRef.current.size < 2) pinchStateRef.current = null;

      const panStart = panStateRef.current;
      panStateRef.current = null;
      if (panStart) {
        const distance = Math.hypot(event.clientX - panStart.startX, event.clientY - panStart.startY);
        if (distance >= 6) suppressClickRef.current = true;
      }

      const candidate = roomClickRef.current;
      roomClickRef.current = null;
      if (candidate) {
        const distance = Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY);
        if (distance < 6) {
          onSelectRoom(candidate.roomId);
        } else {
          suppressClickRef.current = true;
        }
      }

      const clearOverride = (roomId: string) =>
        setOverrides((previous) => {
          const next = { ...previous };
          delete next[roomId];
          return next;
        });

      const resize = resizeRef.current;
      if (resize) {
        resizeRef.current = null;
        const applied = overrides[resize.roomId];
        if (!applied || (applied.w === resize.origin.w && applied.h === resize.origin.h)) {
          clearOverride(resize.roomId);
          return;
        }
        // Keep the interactive size on screen until the saved room comes back
        // from the API, otherwise the room snaps back for a frame.
        void Promise.resolve(
          onRoomRectCommit(resize.roomId, {
            x: resize.origin.x,
            y: resize.origin.y,
            w: applied.w ?? resize.origin.w,
            h: applied.h ?? resize.origin.h,
          })
        ).finally(() => clearOverride(resize.roomId));
        return;
      }

      const drag = dragRef.current;
      if (drag) {
        dragRef.current = null;
        const applied = overrides[drag.roomId];
        if (!applied || (applied.x === drag.origin.x && applied.y === drag.origin.y)) {
          clearOverride(drag.roomId);
          return;
        }
        void Promise.resolve(
          onRoomRectCommit(drag.roomId, {
            x: applied.x ?? drag.origin.x,
            y: applied.y ?? drag.origin.y,
            w: drag.origin.w,
            h: drag.origin.h,
          })
        ).finally(() => clearOverride(drag.roomId));
      }
    },
    [onRoomRectCommit, onSelectRoom, overrides]
  );

  /* ---------------------------------------------------------------------- */
  /* Wheel zoom (non-passive so the page does not scroll)                    */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // Wheel gestures arrive in bursts (a trackpad fires dozens of small events per
    // frame). Deltas are accumulated and applied once per animation frame with an
    // exponential curve, so zoom follows the gesture smoothly instead of stepping.
    let pendingDelta = 0;
    let anchorX = 0;
    let anchorY = 0;
    let frame: number | null = null;

    const flushWheel = () => {
      frame = null;
      const delta = pendingDelta;
      pendingDelta = 0;
      if (delta === 0) return;

      const current = zoomRef.current;
      const next = clampFloorZoom(current * Math.exp(-delta * 0.0016));
      if (next === current) return;

      const rect = svg.getBoundingClientRect();
      const vb = viewBoxRef.current;
      const scale = Math.max(vb.width / Math.max(1, rect.width), vb.height / Math.max(1, rect.height));
      const rx = ((anchorX - rect.left - rect.width / 2) * scale) / vb.width;
      const ry = ((anchorY - rect.top - rect.height / 2) * scale) / vb.height;
      const ratio = current / next;
      onPanChange({
        x: panRef.current.x + rx * (vb.width - vb.width * ratio),
        y: panRef.current.y + ry * (vb.height - vb.height * ratio),
      });
      onZoomChange(next);
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.ctrlKey) {
        onPanChange({ x: panRef.current.x + event.deltaX, y: panRef.current.y });
        return;
      }
      // deltaMode: 0 = pixels, 1 = lines, 2 = pages
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      const delta = Math.max(-140, Math.min(140, event.deltaY * unit));
      if (!delta) return;
      pendingDelta += delta;
      anchorX = event.clientX;
      anchorY = event.clientY;
      if (frame === null) frame = requestAnimationFrame(flushWheel);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      svg.removeEventListener("wheel", onWheel);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [onPanChange, onZoomChange]);

  /* ---------------------------------------------------------------------- */
  /* Interaction helpers                                                     */
  /* ---------------------------------------------------------------------- */

  const handleRoomPointerDown = useCallback(
    (event: ReactPointerEvent<SVGGElement>, room: PlanRoom) => {
      if (editMode && canEdit) {
        event.stopPropagation();
        (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
        onSelectRoom(room.id);
        dragRef.current = {
          roomId: room.id,
          startX: event.clientX,
          startY: event.clientY,
          origin: { x: room.x, y: room.y, w: room.w, h: room.h },
        };
        return;
      }
      roomClickRef.current = {
        roomId: room.id,
        startX: event.clientX,
        startY: event.clientY,
      };
    },
    [canEdit, editMode, onSelectRoom]
  );

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<SVGGElement>, room: PlanRoom) => {
      if (!editMode || !canEdit) return;
      event.stopPropagation();
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
      resizeRef.current = {
        roomId: room.id,
        startX: event.clientX,
        startY: event.clientY,
        origin: { x: room.x, y: room.y, w: room.w, h: room.h },
      };
    },
    [canEdit, editMode]
  );

  const handleBadgePointerDown = useCallback(
    (event: ReactPointerEvent<SVGGElement>, room: PlanRoom, badge: MapBadge, point: { x: number; y: number }) => {
      event.stopPropagation();
      if (!editMode || !canEdit) {
        setHoveredBadgeKey(badge.key);
        return;
      }
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
      badgeDragRef.current = {
        key: badge.key,
        roomId: room.id,
        room,
        startX: event.clientX,
        startY: event.clientY,
        origin: point,
        moved: false,
      };
      setBadgeDrag({ key: badge.key, roomId: room.id, point });
    },
    [canEdit, editMode]
  );

  const handleBadgePointerMove = useCallback(
    (event: ReactPointerEvent<SVGGElement>, badge: MapBadge) => {
      const drag = badgeDragRef.current;
      if (!drag || drag.key !== badge.key) return;
      const { scale } = clientToPlanScale();
      const dx = (event.clientX - drag.startX) * scale;
      const dy = (event.clientY - drag.startY) * scale;
      const room = drag.room;
      const padding = 16;
      const point = {
        x: Math.round(Math.min(room.x + room.w - padding, Math.max(room.x + padding, drag.origin.x + dx))),
        y: Math.round(Math.min(room.y + room.h - padding, Math.max(room.y + padding, drag.origin.y + dy))),
      };
      drag.moved = drag.moved || Math.hypot(point.x - drag.origin.x, point.y - drag.origin.y) > 3;
      setBadgeDrag({ key: drag.key, roomId: drag.roomId, point });
    },
    [clientToPlanScale]
  );

  const handleBadgePointerUp = useCallback(
    (event: ReactPointerEvent<SVGGElement>, room: PlanRoom, badge: MapBadge) => {
      const drag = badgeDragRef.current;
      badgeDragRef.current = null;
      const applied = badgeDrag;
      if (!drag || drag.key !== badge.key) {
        setBadgeDrag(null);
        return;
      }
      if (!drag.moved) {
        setBadgeDrag(null);
        onSelectRoom(room.id);
        return;
      }
      event.stopPropagation();
      const point = applied?.key === badge.key ? applied.point : drag.origin;
      void Promise.resolve(
        onDevicePositionCommit(room.id, badge.key, {
          x: Number(Math.min(0.94, Math.max(0.06, (point.x - room.x) / room.w)).toFixed(3)),
          y: Number(Math.min(0.94, Math.max(0.06, (point.y - room.y) / room.h)).toFixed(3)),
        })
      ).finally(() => setBadgeDrag(null));
    },
    [badgeDrag, onDevicePositionCommit, onSelectRoom]
  );

  const handleBadgeActivate = useCallback(
    (badge: MapBadge, roomId: string) => {
      // While arranging the plan the badges are inert; clicking one selects the
      // room it belongs to instead of toggling hardware.
      if (editMode) {
        onSelectRoom(roomId);
        return;
      }
      onSelectDevice(badge.key);
    },
    [editMode, onSelectDevice, onSelectRoom]
  );

  const popoverSwitch = selectedBadge?.kind === "switch" ? switches.find((item) => item.id === selectedBadge.id) : undefined;
  const popoverDevice = selectedBadge?.kind === "device" ? devices.find((item) => item.id === selectedBadge.id) : undefined;

  const handlePopoverToggle = (next: boolean) => {
    if (popoverSwitch) onToggleSwitch(popoverSwitch, next);
    if (popoverDevice) onToggleDevice(popoverDevice, next);
  };

  const handlePopoverState = (state: string) => {
    if (popoverDevice) onSetDeviceState(popoverDevice, state);
  };

  const dimFor = (roomId: string) =>
    selectedRoomId && selectedRoomId !== roomId ? 0.8 : 1;

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  const labelFontSize = (room: PlanRoom) => {
    const byWidth = (room.w - 24) / Math.max(3, room.name.length * 0.58);
    return Math.max(9, Math.min(17, byWidth, room.h / 6.5));
  };

  return (
    <div
      ref={containerRef}
      className={cn("hc-blueprint-bg relative min-w-0 overflow-hidden p-3 sm:p-4", className)}
    >
      <svg
        ref={svgRef}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        className={cn(
          "w-full touch-none select-none rounded-lg",
          editMode ? "cursor-grab active:cursor-grabbing" : "cursor-grab active:cursor-grabbing",
          heightClassName
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={(event) => {
          roomClickRef.current = null;
          panStateRef.current = null;
          dragRef.current = null;
          resizeRef.current = null;
          setOverrides({});
          handlePointerUp(event);
        }}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          onBackgroundClick?.();
        }}
        role="group"
        aria-label="Interactive 2D smart home floor map"
      >
        <FloorMapDefs />

        {/* Arrange-mode grid: shows the ROOM_GRID snapping resolution so rooms can
            be nudged and resized precisely, and disappears outside edit mode. */}
        {editMode && canEdit && (
          <>
            <defs>
              <pattern
                id="hc-arrange-grid"
                width={GRID_HINT}
                height={GRID_HINT}
                patternUnits="userSpaceOnUse"
              >
                <path
                  d={`M ${GRID_HINT} 0 L 0 0 0 ${GRID_HINT}`}
                  fill="none"
                  stroke="#93A3B4"
                  strokeWidth="0.6"
                  strokeOpacity="0.35"
                />
              </pattern>
            </defs>
            <rect
              x={plan.bounds.x - 8}
              y={plan.bounds.y - 8}
              width={plan.bounds.w + 16}
              height={plan.bounds.h + 16}
              fill="url(#hc-arrange-grid)"
              pointerEvents="none"
            />
          </>
        )}

        {/* House silhouette shadow: the filter drops a shadow from the union of room floors */}

        {/* Room floors, flooring texture, furniture and live lighting */}
        <g filter="url(#hc-plan-shadow)">
          {plan.rooms.map((room) => (
            <rect
              key={`plate-${room.id}`}
              x={room.x}
              y={room.y}
              width={room.w}
              height={room.h}
              fill="#FDFEFF"
            />
          ))}
        </g>

        {plan.rooms.map((room) => {
          const palette = getRoomPalette(room.type);
          const list = badgesByRoom.get(room.id) ?? [];
          const litLights = list.filter((badge) => badge.isOn && isLightingKind(badge.visual)).length;
          const anyActive = list.some((badge) => badge.isOn);
          const isSelected = room.id === selectedRoomId;
          const pattern = getFloorPatternUrl(room.floorStyle);
          return (
            <g
              key={room.id}
              role="button"
              tabIndex={0}
              aria-label={`${room.name} room`}
              aria-pressed={isSelected}
              data-room-id={room.id}
              className={cn("focus:outline-none", editMode ? "cursor-grab" : "cursor-pointer")}
              style={{ opacity: dimFor(room.id) }}
              onPointerDown={(event) => handleRoomPointerDown(event, room)}
              onPointerEnter={() => setHoveredRoomId(room.id)}
              onPointerLeave={() => setHoveredRoomId((current) => (current === room.id ? null : current))}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectRoom(room.id);
                }
              }}
              onClick={(event) => {
                event.stopPropagation();
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                if (!editMode) onSelectRoom(room.id);
              }}
            >
              <rect x={room.x} y={room.y} width={room.w} height={room.h} fill={palette.floor} />
              {pattern && (
                <rect x={room.x} y={room.y} width={room.w} height={room.h} fill={pattern} opacity={0.32} />
              )}
              {litLights > 0 ? (
                <rect
                  x={room.x}
                  y={room.y}
                  width={room.w}
                  height={room.h}
                  fill="url(#hc-room-warm-glow)"
                  fillOpacity={Math.min(1, 0.72 + litLights * 0.12)}
                />
              ) : (
                <rect
                  x={room.x}
                  y={room.y}
                  width={room.w}
                  height={room.h}
                  fill="#0F172A"
                  fillOpacity={anyActive ? 0.02 : 0.045}
                />
              )}
              <RoomFloorArt room={room} />
              {hoveredRoomId === room.id && !editMode && (
                <rect
                  x={room.x}
                  y={room.y}
                  width={room.w}
                  height={room.h}
                  fill="#FFFFFF"
                  fillOpacity={0.16}
                  pointerEvents="none"
                />
              )}
            </g>
          );
        })}

        {/* Walls */}
        <g fill="none" strokeLinecap="round">
          {plan.walls.map((wall, index) => (
            <g key={`wall-${index}`}>
              <line
                x1={wall.x1}
                y1={wall.y1}
                x2={wall.x2}
                y2={wall.y2}
                stroke={wall.exterior ? "#93A3B4" : "#C3CEDA"}
                strokeWidth={(wall.exterior ? 10 : 8) + 2}
              />
              <line
                x1={wall.x1}
                y1={wall.y1}
                x2={wall.x2}
                y2={wall.y2}
                stroke="#FFFFFF"
                strokeWidth={wall.exterior ? 10 : 8}
              />
            </g>
          ))}
        </g>

        {/* Windows cut into the walls */}
        <g pointerEvents="none">
          {plan.windows.map((window) =>
            window.axis === "h" ? (
              <g key={window.id}>
                <rect x={window.start} y={window.line - 4.5} width={window.length} height={9} fill="#FFFFFF" />
                <line
                  x1={window.start + 3}
                  y1={window.line}
                  x2={window.start + window.length - 3}
                  y2={window.line}
                  stroke="#A7C9E8"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                />
              </g>
            ) : (
              <g key={window.id}>
                <rect x={window.line - 4.5} y={window.start} width={9} height={window.length} fill="#FFFFFF" />
                <line
                  x1={window.line}
                  y1={window.start + 3}
                  x2={window.line}
                  y2={window.start + window.length - 3}
                  stroke="#A7C9E8"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                />
              </g>
            )
          )}
        </g>

        {/* Doorways: threshold, leaf and swing arc */}
        <g pointerEvents="none">
          {plan.doors.map((door) => {
            const thickness = WALL_THICKNESS;
            const swing = door.swing;
            const accent = door.kind === "entry" ? "#9AA7B5" : "#C3CCD6";
            if (door.axis === "h") {
              const hinge = swing > 0 ? door.start : door.start + door.length;
              const leafEnd = door.line + swing * door.length;
              return (
                <g key={door.id} opacity={0.55}>
                  <rect
                    x={door.start}
                    y={door.line - thickness / 2}
                    width={door.length}
                    height={thickness}
                    fill="#F1F5F9"
                  />
                  <line x1={hinge} y1={door.line} x2={hinge} y2={leafEnd} stroke={accent} strokeWidth={1.4} />
                  <path
                    d={`M ${hinge + swing * door.length} ${door.line} A ${door.length} ${door.length} 0 0 ${
                      swing > 0 ? 0 : 1
                    } ${hinge} ${leafEnd}`}
                    fill="none"
                    stroke={accent}
                    strokeWidth={1}
                    strokeDasharray="2 3"
                  />
                </g>
              );
            }
            const hinge = swing > 0 ? door.start : door.start + door.length;
            const leafEnd = door.line + swing * door.length;
            return (
              <g key={door.id} opacity={0.55}>
                <rect
                  x={door.line - thickness / 2}
                  y={door.start}
                  width={thickness}
                  height={door.length}
                  fill="#F1F5F9"
                />
                <line x1={door.line} y1={hinge} x2={leafEnd} y2={hinge} stroke={accent} strokeWidth={1.4} />
                <path
                  d={`M ${door.line} ${hinge + swing * door.length} A ${door.length} ${door.length} 0 0 ${
                    swing > 0 ? 1 : 0
                  } ${leafEnd} ${hinge}`}
                  fill="none"
                  stroke={accent}
                  strokeWidth={1}
                  strokeDasharray="2 3"
                />
              </g>
            );
          })}
        </g>

        {/* Room labels */}
        <g pointerEvents="none">
          {plan.rooms.map((room) => {
            const label = roomLabelAnchor(room);
            const palette = getRoomPalette(room.type);
            const fontSize = labelFontSize(room);
            const pillWidth = Math.min(room.w - 14, room.name.length * fontSize * 0.6 + 14);
            const pillHeight = fontSize + 8;
            return (
              <g key={`label-${room.id}`} style={{ opacity: dimFor(room.id) }}>
                <rect
                  x={label.x - pillWidth / 2}
                  y={label.y - pillHeight + 3.5}
                  width={pillWidth}
                  height={pillHeight}
                  rx={pillHeight / 2}
                  fill="#FFFFFF"
                  fillOpacity={0.78}
                />
                <text
                  x={label.x}
                  y={label.y}
                  textAnchor="middle"
                  fontSize={fontSize}
                  fontWeight={600}
                  fill={palette.ink}
                  fillOpacity={0.95}
                >
                  {room.name}
                </text>
              </g>
            );
          })}
        </g>

        {/* Selection ring */}
        {selectedRoom && (
          <rect
            x={selectedRoom.x + 1}
            y={selectedRoom.y + 1}
            width={Math.max(8, selectedRoom.w - 2)}
            height={Math.max(8, selectedRoom.h - 2)}
            rx="4"
            fill="none"
            stroke="#2563EB"
            strokeWidth={3}
            strokeOpacity={0.85}
            filter="url(#hc-room-selected-glow)"
            pointerEvents="none"
          />
        )}

        {/* Device badges */}
        {plan.rooms.map((room) => {
          const group = roomBadges.get(room.id);
          const positions = placementsWithDrag.get(room.id) ?? {};
          if (!group) return null;
          return (
            <g key={`badges-${room.id}`} style={{ opacity: dimFor(room.id) }}>
              {group.visible.map((badge) => {
                const point = positions[badge.key];
                if (!point) return null;
                const lighting = isLightingKind(badge.visual);
                const iconColor = !badge.online
                  ? "#94A3B8"
                  : badge.isOn
                    ? lighting || badge.visual === "heater"
                      ? "#D97706"
                      : badge.visual === "lock" || badge.visual === "valve"
                        ? "#059669"
                        : "#2563EB"
                    : "#64748B";
                const isSelected = badge.key === selectedDeviceKey;
                const isHovered = badge.key === hoveredBadgeKey;
                return (
                  <g
                    key={badge.key}
                    transform={`translate(${point.x}, ${point.y}) scale(${badgeScale})`}
                    data-fixture-id={badge.id}
                    data-fixture-kind={badge.kind}
                    role="button"
                    tabIndex={0}
                    aria-label={`${badge.name} (${badge.isOn ? "ON" : "OFF"})`}
                    aria-pressed={isSelected}
                    aria-busy={badge.pending || undefined}
                    className={cn(
                      "cursor-pointer focus:outline-none",
                      badge.pending && "cursor-wait",
                      !canOperate && !editMode && "cursor-default"
                    )}
                    onPointerDown={(event) => handleBadgePointerDown(event, room, badge, point)}
                    onPointerMove={(event) => handleBadgePointerMove(event, badge)}
                    onPointerUp={(event) => handleBadgePointerUp(event, room, badge)}
                    onPointerEnter={() => setHoveredBadgeKey(badge.key)}
                    onPointerLeave={() =>
                      setHoveredBadgeKey((current) => (current === badge.key ? null : current))
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      handleBadgeActivate(badge, room.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        handleBadgeActivate(badge, room.id);
                      }
                    }}
                  >
                    {badge.isOn && lighting && (
                      <circle
                        cx="0"
                        cy="0"
                        r="34"
                        fill="url(#hc-fixture-warm-halo)"
                        className="hc-light-pulse"
                        pointerEvents="none"
                      />
                    )}
                    {badge.isOn && !lighting && badge.kind !== "sensor" && (
                      <circle cx="0" cy="0" r="26" fill="url(#hc-fixture-cool-halo)" pointerEvents="none" />
                    )}
                    {isSelected && (
                      <circle
                        r="18"
                        fill="none"
                        stroke="#2563EB"
                        strokeWidth="2.4"
                        strokeOpacity="0.9"
                        pointerEvents="none"
                      />
                    )}
                    {badge.pending && (
                      <circle
                        r="16.5"
                        fill="none"
                        stroke="#3B82F6"
                        strokeWidth="1.8"
                        strokeDasharray="4 3"
                        pointerEvents="none"
                      />
                    )}
                    <circle
                      r="13"
                      fill="#FFFFFF"
                      fillOpacity={badge.online ? 0.98 : 0.8}
                      stroke={isSelected ? "#2563EB" : isHovered ? "#CBD5E1" : "#E2E8F0"}
                      strokeWidth="1.4"
                      filter="url(#hc-device-shadow)"
                    />
                    {badge.isOn && (
                      <circle
                        r="13"
                        fill="none"
                        stroke={iconColor}
                        strokeOpacity="0.35"
                        strokeWidth="2"
                        pointerEvents="none"
                      />
                    )}
                    <g
                      className={cn(
                        badge.visual === "tv" && badge.isOn && "hc-tv-glow",
                        badge.visual === "ac" && badge.isOn && "hc-ac-wave"
                      )}
                    >
                      <DeviceGlyph
                        kind={badge.visual}
                        color={iconColor}
                        animated={badge.visual === "fan" && badge.isOn}
                      />
                    </g>
                    {!badge.online && (
                      <g transform="translate(9, 9)">
                        <circle r="4" fill="#FFFFFF" />
                        <circle r="2.6" fill="#EF4444" />
                      </g>
                    )}
                    {badge.kind === "sensor" && badge.valueLabel && (
                      <g transform="translate(0, 20)" pointerEvents="none">
                        <rect
                          x={-((badge.valueLabel.length * 4.6 + 10) / 2)}
                          y={-7}
                          width={badge.valueLabel.length * 4.6 + 10}
                          height={13}
                          rx={6.5}
                          fill="#FFFFFF"
                          fillOpacity={0.94}
                          stroke="#E2E8F0"
                          strokeWidth={0.8}
                        />
                        <text
                          y={2.6}
                          textAnchor="middle"
                          fontSize={8}
                          fontWeight={600}
                          fill="#475569"
                        >
                          {badge.valueLabel}
                        </text>
                      </g>
                    )}
                    {isHovered && (
                      <g transform="translate(0, -25)" pointerEvents="none">
                        <rect
                          x={-((badge.name.length * 5.4 + 16) / 2)}
                          y={-9}
                          width={badge.name.length * 5.4 + 16}
                          height={18}
                          rx={9}
                          fill="#0F172A"
                          fillOpacity={0.92}
                        />
                        <text
                          y={3.5}
                          textAnchor="middle"
                          fontSize={9.5}
                          fontWeight={600}
                          fill="#F8FAFC"
                        >
                          {badge.name.slice(0, 26)}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}

              {group.overflow.length > 0 && (() => {
                const overflowPoint = {
                  x: room.x + room.w - 26,
                  y: room.y + room.h - 26,
                };
                return (
                  <g
                    transform={`translate(${overflowPoint.x}, ${overflowPoint.y}) scale(${badgeScale})`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${group.overflow.length} more devices in ${room.name}`}
                    className="cursor-pointer focus:outline-none"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectRoom(room.id);
                    }}
                  >
                    <circle r="13" fill="#FFFFFF" stroke="#E2E8F0" strokeWidth="1.4" filter="url(#hc-device-shadow)" />
                    <text y={3.6} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#475569">
                      +{group.overflow.length}
                    </text>
                  </g>
                );
              })()}
            </g>
          );
        })}

        {/* Arrange-mode resize grip */}
        {editMode && canEdit && selectedRoom && (
          <g
            transform={`translate(${selectedRoom.x + selectedRoom.w - 9}, ${selectedRoom.y + selectedRoom.h - 9})`}
            onPointerDown={(event) => handleResizePointerDown(event, selectedRoom)}
            className="cursor-nwse-resize"
          >
            <title>Drag corner to resize room</title>
            <rect width="16" height="16" rx="4" fill="#2563EB" stroke="#FFFFFF" strokeWidth="1.6" />
            <path d="M5 11 L11 5" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" />
          </g>
        )}
      </svg>

      {editMode && (
        <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-lg border border-primary/30 bg-background/95 px-2 py-1 text-[10px] font-semibold text-primary shadow-sm">
          <RiDragMove2Line className="size-3.5" aria-hidden="true" />
          <span className="text-[10px]">Drag room to move · corner to resize</span>
        </div>
      )}

      {selectedBadge && popoverAnchor && (
        <DeviceControlPopover
          badge={selectedBadge}
          roomName={selectedBadgeRoom?.name ?? "Unassigned"}
          controllerName={
            (popoverSwitch && ctrlById.get(popoverSwitch.board_instance_id)?.name) ||
            (popoverDevice && ctrlById.get(popoverDevice.board_instance_id)?.name) ||
            undefined
          }
          anchor={popoverAnchor}
          container={containerSize}
          canOperate={canOperate}
          onClose={() => onSelectDevice(null)}
          onToggle={handlePopoverToggle}
          onSetState={handlePopoverState}
        />
      )}

      {children}
    </div>
  );
});
