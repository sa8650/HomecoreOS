import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  RiCpuLine,
  RiFocus3Line,
  RiRadioButtonLine,
  RiSensorLine,
  RiToggleLine,
  RiZoomInLine,
  RiZoomOutLine,
  RiPlugLine,
  RiWifiLine,
} from "@remixicon/react";
import { isDeviceStateActive } from "@homecoreos/shared";
import { isEntityOnline } from "@/lib/board-pin-helpers";
import { cn } from "cn";
import {
  buildHousePlan,
  placeRoomDevices,
  roomLabelAnchor,
  type PlanRoom,
} from "@/components/floorplan/house-layout";
import {
  classifyDeviceType,
  classifySensorType,
  classifySwitch,
} from "@/components/floorplan/floor-visuals";
import type {
  ControllerItem,
  DeviceItem,
  RoomItem,
  SensorItem,
  SwitchItem,
} from "@/features/types";

type EntityKind = "switch" | "device" | "sensor";

export interface BlueprintEntityNode {
  key: string;
  id: string;
  kind: EntityKind;
  name: string;
  pinLabel: string;
  roomId: string | null;
  roomName: string | null;
  boardId: string;
  online: boolean;
  active: boolean;
  readingLabel: string | null;
  x: number;
  y: number;
}

interface PlacedBoard {
  board: ControllerItem;
  isNode: boolean;
  roomId: string | null;
  roomName: string | null;
  inRail: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

const SHEET_PAD = 42;
const RAIL_GAP = 36;
const RAIL_W = 196;
const BOARD_W = 128;
const BOARD_H = 48;
const RAIL_BOARD_W = 164;
const RAIL_BOARD_H = 54;

function sensorPinLabel(sensor: SensorItem): string {
  if (sensor.i2c_address) return `I2C · ${sensor.i2c_address}`;
  const raw = sensor.last_raw_payload as Record<string, unknown> | null | undefined;
  const rawAddr = typeof raw?.i2c_address === "string" ? raw.i2c_address.trim() : "";
  if (rawAddr) return `I2C · ${rawAddr}`;
  const resPins = (sensor.resources?.pins ??
    (raw?.resources as { pins?: Record<string, number | null | undefined> } | undefined)?.pins) as
    | Record<string, number | null | undefined>
    | undefined;
  const pinPairs = Object.entries(resPins ?? {}).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number"
  );
  if (pinPairs.length > 0) {
    return pinPairs.map(([role, p]) => `${role.replace(/^.*_/, "").toUpperCase()} ${p}`).join(" · ");
  }
  if (sensor.gpio_pin !== null && sensor.gpio_pin !== undefined) {
    return `GPIO ${sensor.gpio_pin}`;
  }
  return "Bus";
}

function formatSensorReading(sensor: SensorItem): string | null {
  if (sensor.last_value === null || sensor.last_value === undefined) return null;
  const unit = (sensor.unit ?? "").trim();
  if (!unit) return String(sensor.last_value);
  return unit.startsWith("°") || unit === "%"
    ? `${sensor.last_value}${unit}`
    : `${sensor.last_value} ${unit}`;
}

function wireColorFor(kind: EntityKind, online: boolean, boardStatus: ControllerItem["status"]) {
  if (boardStatus === "disconnected") {
    return { stroke: "#64748b", dash: "3 4", glow: false };
  }
  if (boardStatus !== "online" || !online) {
    return { stroke: "#f59e0b", dash: "5 3", glow: false };
  }
  if (kind === "switch") return { stroke: "#38bdf8", dash: undefined, glow: true };
  if (kind === "device") return { stroke: "#34d399", dash: undefined, glow: true };
  return { stroke: "#c084fc", dash: undefined, glow: true };
}

function statusDotColor(status: ControllerItem["status"]): string {
  switch (status) {
    case "online":
      return "#34d399";
    case "pending":
    case "updating":
      return "#38bdf8";
    case "disconnected":
      return "#94a3b8";
    default:
      return "#f59e0b";
  }
}

/** Orthogonal CAD Manhattan trace with subtle fan-out so parallel wires stay legible. */
function buildOrthogonalWirePath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  fanIndex: number,
  fanCount: number
): { d: string; midX: number; midY: number } {
  const spread = fanCount > 1 ? (fanIndex - (fanCount - 1) / 2) * 8 : 0;
  const dx = toX - fromX;
  const dy = toY - fromY;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const midX = Math.round(fromX + dx * 0.52 + spread);
    const d = `M ${fromX} ${fromY} L ${midX} ${fromY} L ${midX} ${toY} L ${toX} ${toY}`;
    return { d, midX, midY: Math.round((fromY + toY) / 2) };
  }
  const midY = Math.round(fromY + dy * 0.52 + spread);
  const d = `M ${fromX} ${fromY} L ${fromX} ${midY} L ${toX} ${midY} L ${toX} ${toY}`;
  return { d, midX: Math.round((fromX + toX) / 2), midY };
}

/** Smooth curved RF arc for ESP-NOW wireless Node <-> Controller backbone links. */
function buildEspNowArc(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  arcIndex: number
): { d: string; labelX: number; labelY: number } {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy) || 1;
  const lift = Math.min(72, Math.max(26, dist * 0.22)) * (arcIndex % 2 === 0 ? -1 : 1);
  const nx = (-dy / dist) * lift;
  const ny = (dx / dist) * lift;
  const cx = Math.round(mx + nx);
  const cy = Math.round(my + ny);
  return {
    d: `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`,
    labelX: Math.round(0.25 * x1 + 0.5 * cx + 0.25 * x2),
    labelY: Math.round(0.25 * y1 + 0.5 * cy + 0.25 * y2),
  };
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(1, maxLen - 1))}…`;
}

export const BlueprintWiringMap = memo(function BlueprintWiringMap({
  rooms,
  controllers,
  switches,
  devices,
  sensors,
  selectedBoardId,
  onSelectBoard,
}: {
  rooms: RoomItem[];
  controllers: ControllerItem[];
  switches: SwitchItem[];
  devices: DeviceItem[];
  sensors: SensorItem[];
  selectedBoardId: string | null;
  onSelectBoard: (boardId: string | null) => void;
}) {
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [hoveredEntityKey, setHoveredEntityKey] = useState<string | null>(null);
  const [hoveredBoardId, setHoveredBoardId] = useState<string | null>(null);
  const [showSwitches, setShowSwitches] = useState(true);
  const [showDevices, setShowDevices] = useState(true);
  const [showSensors, setShowSensors] = useState(true);
  const [showEspNow, setShowEspNow] = useState(true);
  const [showPinLabels, setShowPinLabels] = useState(true);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const plan = useMemo(() => buildHousePlan(rooms), [rooms]);

  const roomById = useMemo(() => {
    const map = new Map<string, PlanRoom>();
    for (const r of plan.rooms) map.set(r.id, r);
    return map;
  }, [plan.rooms]);

  const roomNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rooms) map.set(r.id, r.name);
    return map;
  }, [rooms]);

  const boardById = useMemo(() => {
    const map = new Map<string, ControllerItem>();
    for (const c of controllers) map.set(c.id, c);
    return map;
  }, [controllers]);

  // 1. Place room devices at their exact Home Floor Plan coordinates
  const roomEntityPlacements = useMemo(() => {
    const byRoom = new Map<
      string,
      Array<{ id: string; kind: ReturnType<typeof classifySwitch> }>
    >();
    const push = (roomId: string, id: string, kind: ReturnType<typeof classifySwitch>) => {
      const list = byRoom.get(roomId) ?? [];
      list.push({ id, kind });
      byRoom.set(roomId, list);
    };
    for (const sw of switches) {
      if (sw.room_id && roomById.has(sw.room_id)) {
        push(sw.room_id, `switch:${sw.id}`, classifySwitch(sw.name));
      }
    }
    for (const dev of devices) {
      if (dev.room_id && roomById.has(dev.room_id)) {
        push(dev.room_id, `device:${dev.id}`, classifyDeviceType(dev.device_type, dev.name));
      }
    }
    for (const s of sensors) {
      if (s.room_id && roomById.has(s.room_id)) {
        push(s.room_id, `sensor:${s.id}`, classifySensorType(s.sensor_type, s.name));
      }
    }

    const result = new Map<string, Record<string, { x: number; y: number }>>();
    for (const room of plan.rooms) {
      const list = byRoom.get(room.id) ?? [];
      result.set(room.id, placeRoomDevices(room, list));
    }
    return result;
  }, [plan.rooms, roomById, switches, devices, sensors]);

  // 2. Place Controllers & Nodes either inside their assigned room or on the Equipment Bus rail
  const { placedBoards, railRect, canvasBounds } = useMemo(() => {
    const houseBounds =
      plan.rooms.length > 0
        ? plan.bounds
        : { x: 0, y: 0, w: 520, h: 320 };

    const boardsInRoom = new Map<string, ControllerItem[]>();
    const railBoards: ControllerItem[] = [];

    // Sort controllers first, then nodes, for crisp hierarchy
    const sortedBoards = [...controllers].sort((a, b) => {
      const aNode = a.board_role === "node" ? 1 : 0;
      const bNode = b.board_role === "node" ? 1 : 0;
      if (aNode !== bNode) return aNode - bNode;
      return a.name.localeCompare(b.name);
    });

    for (const board of sortedBoards) {
      if (board.room_id && roomById.has(board.room_id)) {
        const list = boardsInRoom.get(board.room_id) ?? [];
        list.push(board);
        boardsInRoom.set(board.room_id, list);
      } else {
        railBoards.push(board);
      }
    }

    const placed: PlacedBoard[] = [];

    // Place room-mounted boards neatly along the top-right hardware bay of each room
    for (const [rId, list] of boardsInRoom.entries()) {
      const room = roomById.get(rId)!;
      const bw = Math.min(BOARD_W, Math.max(94, room.w - 24));
      const bh = BOARD_H;
      list.forEach((board, idx) => {
        const x = Math.round(room.x + room.w - bw - 10);
        const y = Math.round(
          Math.min(room.y + room.h - bh - 10, room.y + 12 + idx * (bh + 8))
        );
        placed.push({
          board,
          isNode: board.board_role === "node",
          roomId: room.id,
          roomName: room.name,
          inRail: false,
          x,
          y,
          w: bw,
          h: bh,
        });
      });
    }

    const hasRail = railBoards.length > 0;
    const railX = Math.round(houseBounds.x + houseBounds.w + RAIL_GAP);
    const railY = Math.round(houseBounds.y);
    const neededRailH = Math.max(
      houseBounds.h,
      54 + railBoards.length * (RAIL_BOARD_H + 16) + 20
    );

    if (hasRail) {
      railBoards.forEach((board, idx) => {
        placed.push({
          board,
          isNode: board.board_role === "node",
          roomId: board.room_id ?? null,
          roomName: board.room_id ? (roomNameById.get(board.room_id) ?? null) : null,
          inRail: true,
          x: railX + Math.round((RAIL_W - RAIL_BOARD_W) / 2),
          y: railY + 42 + idx * (RAIL_BOARD_H + 16),
          w: RAIL_BOARD_W,
          h: RAIL_BOARD_H,
        });
      });
    }

    const totalW =
      (hasRail ? railX + RAIL_W : houseBounds.x + houseBounds.w) -
      houseBounds.x +
      SHEET_PAD * 2;
    const totalH = Math.max(houseBounds.h, hasRail ? neededRailH : 0) + SHEET_PAD * 2 + 28;

    return {
      placedBoards: placed,
      railRect: hasRail
        ? { x: railX, y: railY, w: RAIL_W, h: neededRailH }
        : null,
      canvasBounds: {
        x: Math.round(houseBounds.x - SHEET_PAD),
        y: Math.round(houseBounds.y - SHEET_PAD),
        w: Math.round(Math.max(580, totalW)),
        h: Math.round(Math.max(360, totalH)),
      },
    };
  }, [controllers, plan.bounds, plan.rooms.length, roomById, roomNameById]);

  const placedBoardById = useMemo(() => {
    const map = new Map<string, PlacedBoard>();
    for (const pb of placedBoards) map.set(pb.board.id, pb);
    return map;
  }, [placedBoards]);

  // 3. Build unified entity nodes (positioned in their rooms, or docked near their board if roomless)
  const entityNodes = useMemo<BlueprintEntityNode[]>(() => {
    const list: BlueprintEntityNode[] = [];
    const roomlessCountByBoard = new Map<string, number>();

    const resolvePos = (
      key: string,
      roomId: string | null | undefined,
      boardId: string
    ): { x: number; y: number } | null => {
      if (roomId && roomById.has(roomId)) {
        const pt = roomEntityPlacements.get(roomId)?.[key];
        if (pt) return pt;
        const r = roomById.get(roomId)!;
        return { x: r.cx, y: r.cy };
      }
      const pb = placedBoardById.get(boardId);
      if (!pb) return null;
      const idx = roomlessCountByBoard.get(boardId) ?? 0;
      roomlessCountByBoard.set(boardId, idx + 1);
      // Dock roomless entity cleanly along the left of its board rail bay
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      return {
        x: Math.round(pb.x - 28 - col * 32),
        y: Math.round(pb.y + 16 + row * 24),
      };
    };

    for (const sw of switches) {
      if (!sw.board_instance_id || !placedBoardById.has(sw.board_instance_id)) continue;
      const pos = resolvePos(`switch:${sw.id}`, sw.room_id, sw.board_instance_id);
      if (!pos) continue;
      const board = boardById.get(sw.board_instance_id);
      list.push({
        key: `switch:${sw.id}`,
        id: sw.id,
        kind: "switch",
        name: sw.name,
        pinLabel: `GPIO ${sw.gpio_pin}`,
        roomId: sw.room_id ?? null,
        roomName: sw.room_id ? (roomNameById.get(sw.room_id) ?? null) : null,
        boardId: sw.board_instance_id,
        online: isEntityOnline(sw.is_online, board),
        active: sw.is_on,
        readingLabel: sw.is_on ? "ON" : "OFF",
        x: pos.x,
        y: pos.y,
      });
    }

    for (const dev of devices) {
      if (!dev.board_instance_id || !placedBoardById.has(dev.board_instance_id)) continue;
      const pos = resolvePos(`device:${dev.id}`, dev.room_id, dev.board_instance_id);
      if (!pos) continue;
      const board = boardById.get(dev.board_instance_id);
      const active = isDeviceStateActive(dev.state);
      list.push({
        key: `device:${dev.id}`,
        id: dev.id,
        kind: "device",
        name: dev.name,
        pinLabel: `GPIO ${dev.gpio_pin}`,
        roomId: dev.room_id ?? null,
        roomName: dev.room_id ? (roomNameById.get(dev.room_id) ?? null) : null,
        boardId: dev.board_instance_id,
        online: isEntityOnline(dev.is_online, board),
        active,
        readingLabel: dev.state ? dev.state.toUpperCase() : null,
        x: pos.x,
        y: pos.y,
      });
    }

    for (const s of sensors) {
      if (!s.board_instance_id || !placedBoardById.has(s.board_instance_id)) continue;
      const pos = resolvePos(`sensor:${s.id}`, s.room_id, s.board_instance_id);
      if (!pos) continue;
      const board = boardById.get(s.board_instance_id);
      const reading = formatSensorReading(s);
      list.push({
        key: `sensor:${s.id}`,
        id: s.id,
        kind: "sensor",
        name: s.name,
        pinLabel: sensorPinLabel(s),
        roomId: s.room_id ?? null,
        roomName: s.room_id ? (roomNameById.get(s.room_id) ?? null) : null,
        boardId: s.board_instance_id,
        online: isEntityOnline(s.is_online, board),
        active: reading !== null,
        readingLabel: reading,
        x: pos.x,
        y: pos.y,
      });
    }

    return list;
  }, [
    switches,
    devices,
    sensors,
    roomById,
    roomEntityPlacements,
    placedBoardById,
    boardById,
    roomNameById,
  ]);

  const visibleEntities = useMemo(
    () =>
      entityNodes.filter((e) => {
        if (e.kind === "switch" && !showSwitches) return false;
        if (e.kind === "device" && !showDevices) return false;
        if (e.kind === "sensor" && !showSensors) return false;
        return true;
      }),
    [entityNodes, showSwitches, showDevices, showSensors]
  );

  // 4. ESP-NOW Node <-> Parent Controller wireless links
  const espNowLinks = useMemo(() => {
    const links: Array<{
      id: string;
      node: PlacedBoard;
      parent: PlacedBoard;
      linked: boolean;
      channel: number | null;
    }> = [];
    for (const pb of placedBoards) {
      if (!pb.isNode || !pb.board.assigned_controller_id) continue;
      const parent = placedBoardById.get(pb.board.assigned_controller_id);
      if (!parent) continue;
      const linked =
        pb.board.status === "online" &&
        parent.board.status === "online" &&
        pb.board.node_link_state !== "controller_lost";
      links.push({
        id: `${pb.board.id}->${parent.board.id}`,
        node: pb,
        parent,
        linked,
        channel: pb.board.espnow_channel ?? parent.board.espnow_channel ?? null,
      });
    }
    return links;
  }, [placedBoards, placedBoardById]);

  // Active highlight set: selecting a board highlights it + any linked parent/child boards
  const activeBoardFocusId = hoveredBoardId ?? selectedBoardId;
  const relatedBoardIds = useMemo(() => {
    if (!activeBoardFocusId) return null;
    const set = new Set<string>([activeBoardFocusId]);
    for (const link of espNowLinks) {
      if (link.node.board.id === activeBoardFocusId) set.add(link.parent.board.id);
      if (link.parent.board.id === activeBoardFocusId) set.add(link.node.board.id);
    }
    return set;
  }, [activeBoardFocusId, espNowLinks]);

  const controllerCount = placedBoards.filter((b) => !b.isNode).length;
  const nodeCount = placedBoards.filter((b) => b.isNode).length;

  // Compute wires with per-board fan-out index so parallel wires spread cleanly
  const wires = useMemo(() => {
    const groupedByBoard = new Map<string, BlueprintEntityNode[]>();
    for (const entity of visibleEntities) {
      const list = groupedByBoard.get(entity.boardId) ?? [];
      list.push(entity);
      groupedByBoard.set(entity.boardId, list);
    }

    const result: Array<{
      entity: BlueprintEntityNode;
      pb: PlacedBoard;
      d: string;
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      midX: number;
      midY: number;
      tone: ReturnType<typeof wireColorFor>;
    }> = [];

    for (const [boardId, list] of groupedByBoard.entries()) {
      const pb = placedBoardById.get(boardId);
      if (!pb) continue;
      list.forEach((entity, idx) => {
        const boardCenterX = pb.x + pb.w / 2;
        // Anchor wire cleanly on the nearest side of the board PCB
        const fromLeft = entity.x < boardCenterX;
        const toX = fromLeft ? pb.x : pb.x + pb.w;
        const slotRatio = list.length === 1 ? 0.5 : (idx + 0.5) / list.length;
        const toY = Math.round(pb.y + 8 + slotRatio * (pb.h - 16));
        const { d, midX, midY } = buildOrthogonalWirePath(
          entity.x,
          entity.y,
          toX,
          toY,
          idx,
          list.length
        );
        result.push({
          entity,
          pb,
          d,
          fromX: entity.x,
          fromY: entity.y,
          toX,
          toY,
          midX,
          midY,
          tone: wireColorFor(entity.kind, entity.online, pb.board.status),
        });
      });
    }
    return result;
  }, [visibleEntities, placedBoardById]);

  const handleZoomIn = useCallback(
    () => setZoom((z) => Math.min(2.2, Number((z + 0.2).toFixed(2)))),
    []
  );
  const handleZoomOut = useCallback(
    () => setZoom((z) => Math.max(0.65, Number((z - 0.2).toFixed(2)))),
    []
  );
  const handleResetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setSelectedRoomId(null);
    onSelectBoard(null);
  }, [onSelectBoard]);

  const handlePointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if ((e.target as HTMLElement).closest("[data-interactive='true']")) return;
    panDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: pan.x,
      originY: pan.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setPan({
      x: drag.originX + (e.clientX - drag.startX),
      y: drag.originY + (e.clientY - drag.startY),
    });
  };

  const handlePointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (panDragRef.current?.pointerId === e.pointerId) {
      panDragRef.current = null;
    }
  };

  // Compute live inspector summary
  const inspectedEntity = hoveredEntityKey
    ? entityNodes.find((e) => e.key === hoveredEntityKey) ?? null
    : null;
  const inspectedBoard = activeBoardFocusId
    ? placedBoardById.get(activeBoardFocusId) ?? null
    : null;

  return (
    <div
      data-testid="blueprint-wiring-map"
      className="overflow-hidden rounded-2xl border border-sky-400/25 bg-[#071529] text-sky-100 shadow-lg"
    >
      {/* Top Engineering Blueprint Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-sky-300/15 bg-[#0b1d38]/90 px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-sky-300 uppercase">
            <RiCpuLine className="size-3.5" aria-hidden="true" />
            Blueprint Wiring
          </span>
          <span className="font-mono text-[11px] text-sky-200/75">
            {plan.rooms.length} room{plan.rooms.length === 1 ? "" : "s"} · {controllerCount}{" "}
            controller{controllerCount === 1 ? "" : "s"}
            {nodeCount > 0 ? ` · ${nodeCount} node${nodeCount === 1 ? "" : "s"}` : ""} ·{" "}
            {entityNodes.length} wired I/O
          </span>
        </div>

        {/* Layer filter pills + zoom controls */}
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              {
                key: "sw",
                label: "Switches",
                active: showSwitches,
                toggle: () => setShowSwitches((v) => !v),
                dot: "bg-sky-400",
                icon: <RiToggleLine className="size-3" aria-hidden="true" />,
              },
              {
                key: "dev",
                label: "Devices",
                active: showDevices,
                toggle: () => setShowDevices((v) => !v),
                dot: "bg-emerald-400",
                icon: <RiPlugLine className="size-3" aria-hidden="true" />,
              },
              {
                key: "sen",
                label: "Sensors",
                active: showSensors,
                toggle: () => setShowSensors((v) => !v),
                dot: "bg-purple-400",
                icon: <RiSensorLine className="size-3" aria-hidden="true" />,
              },
              {
                key: "espnow",
                label: "ESP-NOW",
                active: showEspNow,
                toggle: () => setShowEspNow((v) => !v),
                dot: "bg-indigo-400",
                icon: <RiWifiLine className="size-3" aria-hidden="true" />,
              },
              {
                key: "pins",
                label: "Pins",
                active: showPinLabels,
                toggle: () => setShowPinLabels((v) => !v),
                dot: "bg-cyan-300",
                icon: <RiRadioButtonLine className="size-3" aria-hidden="true" />,
              },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={item.active}
              onClick={item.toggle}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] font-medium transition-colors",
                item.active
                  ? "border-sky-300/40 bg-sky-400/15 text-sky-100"
                  : "border-sky-300/15 bg-transparent text-sky-300/45 hover:text-sky-200/80"
              )}
            >
              <span className={cn("size-1.5 rounded-full", item.dot)} />
              <span>{item.label}</span>
            </button>
          ))}

          <div className="ml-1 inline-flex items-center rounded-md border border-sky-300/20 bg-[#08172e]">
            <button
              type="button"
              onClick={handleZoomOut}
              aria-label="Zoom out blueprint"
              className="cursor-pointer px-1.5 py-1 text-sky-200/80 hover:bg-sky-400/15 hover:text-white"
            >
              <RiZoomOutLine className="size-3.5" aria-hidden="true" />
            </button>
            <span className="min-w-[3rem] px-1 text-center font-mono text-[10px] tabular-nums text-sky-200/85">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={handleZoomIn}
              aria-label="Zoom in blueprint"
              className="cursor-pointer px-1.5 py-1 text-sky-200/80 hover:bg-sky-400/15 hover:text-white"
            >
              <RiZoomInLine className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={handleResetView}
              aria-label="Reset blueprint view"
              title="Reset view & selection"
              className="cursor-pointer border-l border-sky-300/15 px-1.5 py-1 text-sky-200/80 hover:bg-sky-400/15 hover:text-white"
            >
              <RiFocus3Line className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Interactive Blueprint SVG Viewport */}
      <div className="relative h-[420px] w-full overflow-hidden sm:h-[490px] lg:h-[540px]">
        <svg
          role="img"
          aria-label="Architectural blueprint floor map showing room devices, sensors, switches, and wiring to controllers and nodes"
          viewBox={`${canvasBounds.x} ${canvasBounds.y} ${canvasBounds.w} ${canvasBounds.h}`}
          className="h-full w-full cursor-grab select-none active:cursor-grabbing"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <defs>
            <linearGradient id="hc-bp-bg" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#07162b" />
              <stop offset="55%" stopColor="#0b203f" />
              <stop offset="100%" stopColor="#081a35" />
            </linearGradient>
            <pattern id="hc-bp-grid-sm" width="16" height="16" patternUnits="userSpaceOnUse">
              <path
                d="M 16 0 L 0 0 0 16"
                fill="none"
                stroke="#38bdf8"
                strokeOpacity="0.09"
                strokeWidth="0.6"
              />
            </pattern>
            <pattern id="hc-bp-grid-lg" width="80" height="80" patternUnits="userSpaceOnUse">
              <rect width="80" height="80" fill="url(#hc-bp-grid-sm)" />
              <path
                d="M 80 0 L 0 0 0 80"
                fill="none"
                stroke="#7dd3fc"
                strokeOpacity="0.18"
                strokeWidth="0.9"
              />
            </pattern>
            <filter id="hc-bp-glow" x="-25%" y="-25%" width="150%" height="150%">
              <feGaussianBlur stdDeviation="2.2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Blueprint Paper + Coordinate Grid */}
          <rect
            x={canvasBounds.x - 400}
            y={canvasBounds.y - 400}
            width={canvasBounds.w + 800}
            height={canvasBounds.h + 800}
            fill="url(#hc-bp-bg)"
          />
          <rect
            x={canvasBounds.x - 400}
            y={canvasBounds.y - 400}
            width={canvasBounds.w + 800}
            height={canvasBounds.h + 800}
            fill="url(#hc-bp-grid-lg)"
          />

          {/* Interactive Pan & Zoom Layer */}
          <g
            transform={`translate(${pan.x} ${pan.y}) translate(${canvasBounds.x + canvasBounds.w / 2} ${canvasBounds.y + canvasBounds.h / 2}) scale(${zoom}) translate(${-(canvasBounds.x + canvasBounds.w / 2)} ${-(canvasBounds.y + canvasBounds.h / 2)})`}
          >
            {/* Outer CAD Drawing Border + Registration Marks */}
            <rect
              x={canvasBounds.x + 12}
              y={canvasBounds.y + 12}
              width={canvasBounds.w - 24}
              height={canvasBounds.h - 24}
              fill="none"
              stroke="#7dd3fc"
              strokeOpacity="0.28"
              strokeWidth="1"
            />
            <rect
              x={canvasBounds.x + 16}
              y={canvasBounds.y + 16}
              width={canvasBounds.w - 32}
              height={canvasBounds.h - 32}
              fill="none"
              stroke="#38bdf8"
              strokeOpacity="0.14"
              strokeWidth="0.7"
              strokeDasharray="6 4"
            />

            {/* ── LAYER 1: Architectural Blueprint Rooms ─────────────────── */}
            {plan.rooms.length === 0 ? (
              <g>
                <rect
                  x={24}
                  y={24}
                  width={460}
                  height={250}
                  rx={6}
                  fill="#0ea5e9"
                  fillOpacity="0.06"
                  stroke="#7dd3fc"
                  strokeOpacity="0.4"
                  strokeDasharray="6 4"
                  strokeWidth="1.2"
                />
                <text
                  x={254}
                  y={142}
                  textAnchor="middle"
                  fill="#bae6fd"
                  fontSize="12"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  NO ROOMS CONFIGURED ON FLOOR PLAN YET
                </text>
                <text
                  x={254}
                  y={162}
                  textAnchor="middle"
                  fill="#7dd3fc"
                  fillOpacity="0.7"
                  fontSize="10"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  Controllers &amp; Nodes appear on the Hardware Bus rail →
                </text>
              </g>
            ) : (
              <>
                {plan.rooms.map((room, idx) => {
                  const isSelected = selectedRoomId === room.id;
                  const label = roomLabelAnchor(room);
                  const roomEntityCount = entityNodes.filter((e) => e.roomId === room.id).length;
                  return (
                    <g
                      key={room.id}
                      data-interactive="true"
                      className="cursor-pointer"
                      onClick={() =>
                        setSelectedRoomId((prev) => (prev === room.id ? null : room.id))
                      }
                    >
                      <rect
                        x={room.x}
                        y={room.y}
                        width={room.w}
                        height={room.h}
                        fill={isSelected ? "#38bdf8" : "#0ea5e9"}
                        fillOpacity={isSelected ? 0.14 : 0.06}
                        stroke={isSelected ? "#7dd3fc" : "#38bdf8"}
                        strokeOpacity={isSelected ? 0.65 : 0.2}
                        strokeWidth={isSelected ? 1.5 : 0.8}
                      />
                      {/* Room Code Tag */}
                      <text
                        x={room.x + 10}
                        y={room.y + 18}
                        fill="#7dd3fc"
                        fillOpacity="0.7"
                        fontSize="8.5"
                        fontWeight="600"
                        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                      >
                        RM-{String(idx + 1).padStart(2, "0")}
                      </text>
                      {/* Room Name Watermark */}
                      <text
                        x={label.x}
                        y={label.y - 3}
                        textAnchor="middle"
                        fill="#e0f2fe"
                        fillOpacity={isSelected ? 0.95 : 0.62}
                        fontSize="11"
                        fontWeight="700"
                        letterSpacing="0.06em"
                        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                      >
                        {room.name.toUpperCase()}
                      </text>
                      <text
                        x={label.x}
                        y={label.y + 10}
                        textAnchor="middle"
                        fill="#7dd3fc"
                        fillOpacity="0.55"
                        fontSize="8.5"
                        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                      >
                        {roomEntityCount} I/O · {Math.round(room.w / 10)}×{Math.round(room.h / 10)}
                      </text>
                    </g>
                  );
                })}

                {/* Architectural Blueprint Walls */}
                {plan.walls.map((w, i) => (
                  <g key={`wall-${i}`}>
                    {w.exterior && (
                      <line
                        x1={w.x1}
                        y1={w.y1}
                        x2={w.x2}
                        y2={w.y2}
                        stroke="#38bdf8"
                        strokeOpacity="0.28"
                        strokeWidth="6.5"
                        strokeLinecap="square"
                      />
                    )}
                    <line
                      x1={w.x1}
                      y1={w.y1}
                      x2={w.x2}
                      y2={w.y2}
                      stroke={w.exterior ? "#bae6fd" : "#7dd3fc"}
                      strokeOpacity={w.exterior ? 0.95 : 0.72}
                      strokeWidth={w.exterior ? 2.4 : 1.5}
                      strokeLinecap="square"
                    />
                  </g>
                ))}

                {/* Architectural Blueprint Doors (Swing Arc + Leaf) */}
                {plan.doors.map((door) => {
                  const s = door.swing;
                  if (door.axis === "h") {
                    const x1 = door.start;
                    const x2 = door.start + door.length;
                    const y = door.line;
                    const endY = y + s * door.length;
                    const sweep = s === 1 ? 1 : 0;
                    return (
                      <g key={door.id}>
                        <line
                          x1={x1}
                          y1={y}
                          x2={x1}
                          y2={endY}
                          stroke="#7dd3fc"
                          strokeWidth="1.4"
                        />
                        <path
                          d={`M ${x1} ${endY} A ${door.length} ${door.length} 0 0 ${sweep} ${x2} ${y}`}
                          fill="none"
                          stroke="#38bdf8"
                          strokeOpacity="0.55"
                          strokeDasharray="3 2.5"
                          strokeWidth="1"
                        />
                      </g>
                    );
                  }
                  const y1 = door.start;
                  const y2 = door.start + door.length;
                  const x = door.line;
                  const endX = x + s * door.length;
                  const sweep = s === 1 ? 0 : 1;
                  return (
                    <g key={door.id}>
                      <line
                        x1={x}
                        y1={y1}
                        x2={endX}
                        y2={y1}
                        stroke="#7dd3fc"
                        strokeWidth="1.4"
                      />
                      <path
                        d={`M ${endX} ${y1} A ${door.length} ${door.length} 0 0 ${sweep} ${x} ${y2}`}
                        fill="none"
                        stroke="#38bdf8"
                        strokeOpacity="0.55"
                        strokeDasharray="3 2.5"
                        strokeWidth="1"
                      />
                    </g>
                  );
                })}

                {/* Architectural Blueprint Windows */}
                {plan.windows.map((win) =>
                  win.axis === "h" ? (
                    <g key={win.id}>
                      <line
                        x1={win.start}
                        y1={win.line - 2}
                        x2={win.start + win.length}
                        y2={win.line - 2}
                        stroke="#38bdf8"
                        strokeWidth="1.2"
                      />
                      <line
                        x1={win.start}
                        y1={win.line + 2}
                        x2={win.start + win.length}
                        y2={win.line + 2}
                        stroke="#38bdf8"
                        strokeWidth="1.2"
                      />
                    </g>
                  ) : (
                    <g key={win.id}>
                      <line
                        x1={win.line - 2}
                        y1={win.start}
                        x2={win.line - 2}
                        y2={win.start + win.length}
                        stroke="#38bdf8"
                        strokeWidth="1.2"
                      />
                      <line
                        x1={win.line + 2}
                        y1={win.start}
                        x2={win.line + 2}
                        y2={win.start + win.length}
                        stroke="#38bdf8"
                        strokeWidth="1.2"
                      />
                    </g>
                  )
                )}
              </>
            )}

            {/* ── LAYER 2: Unassigned Hardware Distribution Bus Rail ─────── */}
            {railRect && (
              <g>
                <rect
                  x={railRect.x}
                  y={railRect.y}
                  width={railRect.w}
                  height={railRect.h}
                  rx={6}
                  fill="#0c2344"
                  fillOpacity="0.65"
                  stroke="#38bdf8"
                  strokeOpacity="0.4"
                  strokeWidth="1.2"
                  strokeDasharray="5 3"
                />
                <text
                  x={railRect.x + railRect.w / 2}
                  y={railRect.y + 18}
                  textAnchor="middle"
                  fill="#7dd3fc"
                  fontSize="9"
                  fontWeight="700"
                  letterSpacing="0.08em"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  HARDWARE BUS
                </text>
                <text
                  x={railRect.x + railRect.w / 2}
                  y={railRect.y + 30}
                  textAnchor="middle"
                  fill="#7dd3fc"
                  fillOpacity="0.6"
                  fontSize="7.5"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  UNASSIGNED BOARDS
                </text>
              </g>
            )}

            {/* ── LAYER 3: ESP-NOW Wireless Node <-> Controller Backbone ─── */}
            {showEspNow &&
              espNowLinks.map((link, idx) => {
                const x1 = Math.round(link.node.x + link.node.w / 2);
                const y1 = Math.round(link.node.y + link.node.h / 2);
                const x2 = Math.round(link.parent.x + link.parent.w / 2);
                const y2 = Math.round(link.parent.y + link.parent.h / 2);
                const arc = buildEspNowArc(x1, y1, x2, y2, idx);
                const isDimmed =
                  relatedBoardIds !== null &&
                  !relatedBoardIds.has(link.node.board.id) &&
                  !relatedBoardIds.has(link.parent.board.id);
                const color = link.linked ? "#a78bfa" : "#f59e0b";

                return (
                  <g key={link.id} opacity={isDimmed ? 0.18 : 0.92}>
                    <path
                      d={arc.d}
                      fill="none"
                      stroke={color}
                      strokeWidth={isDimmed ? 1.2 : 2}
                      strokeDasharray="6 4"
                      filter={link.linked && !isDimmed ? "url(#hc-bp-glow)" : undefined}
                    />
                    <rect
                      x={arc.labelX - 30}
                      y={arc.labelY - 8}
                      width={60}
                      height={16}
                      rx={8}
                      fill="#0a1933"
                      stroke={color}
                      strokeWidth="1"
                    />
                    <text
                      x={arc.labelX}
                      y={arc.labelY + 3}
                      textAnchor="middle"
                      fill={color}
                      fontSize="7.5"
                      fontWeight="700"
                      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    >
                      {link.channel ? `ESP-NOW CH${link.channel}` : "ESP-NOW"}
                    </text>
                  </g>
                );
              })}

            {/* ── LAYER 4: Orthogonal CAD Wiring Traces (Entity -> Board) ── */}
            {wires.map((w) => {
              const matchesBoard =
                relatedBoardIds === null || relatedBoardIds.has(w.entity.boardId);
              const matchesRoom =
                selectedRoomId === null || w.entity.roomId === selectedRoomId;
              const isHovered = hoveredEntityKey === w.entity.key;
              const emphasized =
                isHovered ||
                (relatedBoardIds !== null && matchesBoard) ||
                (selectedRoomId !== null && matchesRoom);
              const dimmed =
                !isHovered &&
                ((relatedBoardIds !== null && !matchesBoard) ||
                  (selectedRoomId !== null && !matchesRoom));

              return (
                <g key={`wire-${w.entity.key}`} opacity={dimmed ? 0.14 : emphasized ? 1 : 0.82}>
                  <path
                    d={w.d}
                    fill="none"
                    stroke={w.tone.stroke}
                    strokeWidth={isHovered ? 2.4 : emphasized ? 1.8 : 1.35}
                    strokeDasharray={w.tone.dash}
                    strokeLinejoin="round"
                    filter={w.tone.glow && emphasized ? "url(#hc-bp-glow)" : undefined}
                  />
                  {/* Terminal solder pad on the board PCB edge */}
                  <circle
                    cx={w.toX}
                    cy={w.toY}
                    r={2.4}
                    fill={w.tone.stroke}
                    stroke="#07162b"
                    strokeWidth="0.9"
                  />
                  {/* Inline GPIO/I2C callout pill on hover or active circuit */}
                  {showPinLabels && (isHovered || (selectedBoardId === w.entity.boardId && !dimmed)) && (
                    <g>
                      <rect
                        x={w.midX - 27}
                        y={w.midY - 7.5}
                        width={54}
                        height={15}
                        rx={3.5}
                        fill="#07172f"
                        stroke={w.tone.stroke}
                        strokeOpacity="0.8"
                        strokeWidth="0.9"
                      />
                      <text
                        x={w.midX}
                        y={w.midY + 2.8}
                        textAnchor="middle"
                        fill="#e0f2fe"
                        fontSize="7.5"
                        fontWeight="600"
                        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                      >
                        {truncateText(w.entity.pinLabel, 10)}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}

            {/* ── LAYER 5: Room Switches, Devices & Sensors Schematic Nodes */}
            {visibleEntities.map((entity) => {
              const board = boardById.get(entity.boardId);
              const tone = wireColorFor(entity.kind, entity.online, board?.status ?? "offline");
              const matchesBoard =
                relatedBoardIds === null || relatedBoardIds.has(entity.boardId);
              const matchesRoom =
                selectedRoomId === null || entity.roomId === selectedRoomId;
              const isHovered = hoveredEntityKey === entity.key;
              const dimmed =
                !isHovered &&
                ((relatedBoardIds !== null && !matchesBoard) ||
                  (selectedRoomId !== null && !matchesRoom));

              const kindTag =
                entity.kind === "switch" ? "SW" : entity.kind === "device" ? "DEV" : "SNS";

              return (
                <g
                  key={entity.key}
                  data-interactive="true"
                  className="cursor-pointer"
                  opacity={dimmed ? 0.22 : 1}
                  onMouseEnter={() => setHoveredEntityKey(entity.key)}
                  onMouseLeave={() =>
                    setHoveredEntityKey((cur) => (cur === entity.key ? null : cur))
                  }
                  onClick={() =>
                    onSelectBoard(
                      selectedBoardId === entity.boardId ? null : entity.boardId
                    )
                  }
                >
                  {/* Active halo */}
                  {entity.active && entity.online && (
                    <circle
                      cx={entity.x}
                      cy={entity.y}
                      r={14.5}
                      fill={tone.stroke}
                      fillOpacity="0.16"
                    />
                  )}
                  {/* Schematic terminal circle */}
                  <circle
                    cx={entity.x}
                    cy={entity.y}
                    r={isHovered ? 11.5 : 10}
                    fill="#081a36"
                    stroke={tone.stroke}
                    strokeWidth={isHovered ? 2 : 1.5}
                  />
                  <text
                    x={entity.x}
                    y={entity.y + 2.8}
                    textAnchor="middle"
                    fill={tone.stroke}
                    fontSize="7"
                    fontWeight="700"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  >
                    {kindTag}
                  </text>
                  {/* Entity name + pin caption below schematic terminal */}
                  <rect
                    x={entity.x - 38}
                    y={entity.y + 12}
                    width={76}
                    height={showPinLabels ? 21 : 12}
                    rx={3}
                    fill="#07162b"
                    fillOpacity="0.88"
                    stroke={tone.stroke}
                    strokeOpacity={isHovered ? 0.75 : 0.28}
                    strokeWidth="0.7"
                  />
                  <text
                    x={entity.x}
                    y={entity.y + 20.5}
                    textAnchor="middle"
                    fill="#e0f2fe"
                    fontSize="7.4"
                    fontWeight="600"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  >
                    {truncateText(entity.name, 12)}
                  </text>
                  {showPinLabels && (
                    <text
                      x={entity.x}
                      y={entity.y + 29.5}
                      textAnchor="middle"
                      fill={tone.stroke}
                      fontSize="6.8"
                      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    >
                      {truncateText(entity.pinLabel, 12)}
                    </text>
                  )}
                </g>
              );
            })}

            {/* ── LAYER 6: Controller & Node PCB Modules ─────────────────── */}
            {placedBoards.map((pb) => {
              const isSelected = selectedBoardId === pb.board.id;
              const isHovered = hoveredBoardId === pb.board.id;
              const isDimmed =
                relatedBoardIds !== null && !relatedBoardIds.has(pb.board.id);
              const accent = pb.isNode ? "#a78bfa" : "#38bdf8";
              const ledColor = statusDotColor(pb.board.status);
              const wiredCount = entityNodes.filter((e) => e.boardId === pb.board.id).length;

              return (
                <g
                  key={pb.board.id}
                  data-interactive="true"
                  data-testid={`blueprint-board-${pb.board.id}`}
                  className="cursor-pointer"
                  opacity={isDimmed ? 0.28 : 1}
                  onMouseEnter={() => setHoveredBoardId(pb.board.id)}
                  onMouseLeave={() =>
                    setHoveredBoardId((cur) => (cur === pb.board.id ? null : cur))
                  }
                  onClick={() =>
                    onSelectBoard(isSelected ? null : pb.board.id)
                  }
                >
                  {/* PCB IC Pin ticks along top & bottom */}
                  {[0.22, 0.4, 0.6, 0.78].map((ratio, i) => (
                    <g key={i}>
                      <line
                        x1={pb.x + pb.w * ratio}
                        y1={pb.y - 4}
                        x2={pb.x + pb.w * ratio}
                        y2={pb.y}
                        stroke={accent}
                        strokeOpacity="0.6"
                        strokeWidth="1.3"
                      />
                      <line
                        x1={pb.x + pb.w * ratio}
                        y1={pb.y + pb.h}
                        x2={pb.x + pb.w * ratio}
                        y2={pb.y + pb.h + 4}
                        stroke={accent}
                        strokeOpacity="0.6"
                        strokeWidth="1.3"
                      />
                    </g>
                  ))}

                  {/* Main PCB Module Body */}
                  <rect
                    x={pb.x}
                    y={pb.y}
                    width={pb.w}
                    height={pb.h}
                    rx={pb.isNode ? 10 : 5}
                    fill={isSelected ? "#0e2b54" : "#091c38"}
                    stroke={isSelected || isHovered ? "#ffffff" : accent}
                    strokeWidth={isSelected ? 2 : 1.4}
                    filter={isSelected ? "url(#hc-bp-glow)" : undefined}
                  />

                  {/* Role Badge Pill */}
                  <rect
                    x={pb.x + 6}
                    y={pb.y + 6}
                    width={pb.isNode ? 36 : 36}
                    height={12}
                    rx={3}
                    fill={accent}
                    fillOpacity="0.2"
                    stroke={accent}
                    strokeOpacity="0.6"
                    strokeWidth="0.7"
                  />
                  <text
                    x={pb.x + 24}
                    y={pb.y + 14.5}
                    textAnchor="middle"
                    fill={accent}
                    fontSize="7"
                    fontWeight="700"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  >
                    {pb.isNode ? "NODE" : "CTRL"}
                  </text>

                  {/* Live Health LED */}
                  <circle cx={pb.x + pb.w - 10} cy={pb.y + 12} r={3.5} fill={ledColor} />

                  {/* Board Name */}
                  <text
                    x={pb.x + 7}
                    y={pb.y + 29}
                    fill="#f0f9ff"
                    fontSize="9"
                    fontWeight="700"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  >
                    {truncateText(pb.board.name, pb.inRail ? 20 : 15)}
                  </text>

                  {/* Chip / Wired Count Subline */}
                  <text
                    x={pb.x + 7}
                    y={pb.y + pb.h - 7}
                    fill="#7dd3fc"
                    fillOpacity="0.8"
                    fontSize="7.4"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  >
                    {truncateText(
                      `${pb.board.chip_variant ?? pb.board.board_model} · ${wiredCount} I/O`,
                      pb.inRail ? 24 : 18
                    )}
                  </text>
                </g>
              );
            })}

            {/* ── LAYER 7: CAD Title Block (bottom-right of blueprint sheet) */}
            <g
              transform={`translate(${canvasBounds.x + canvasBounds.w - 224} ${canvasBounds.y + canvasBounds.h - 40})`}
            >
              <rect
                width={206}
                height={22}
                rx={2}
                fill="#07162b"
                fillOpacity="0.92"
                stroke="#7dd3fc"
                strokeOpacity="0.35"
                strokeWidth="0.8"
              />
              <text
                x={8}
                y={10}
                fill="#bae6fd"
                fontSize="7"
                fontWeight="700"
                letterSpacing="0.08em"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                HOMECOREOS · HARDWARE BLUEPRINT
              </text>
              <text
                x={8}
                y={18.5}
                fill="#7dd3fc"
                fillOpacity="0.72"
                fontSize="6.5"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                CTRL: {controllerCount} · NODE: {nodeCount} · LINKS: {espNowLinks.length} · REV LIVE
              </text>
            </g>
          </g>
        </svg>
      </div>

      {/* Bottom Blueprint Legend & Live Circuit Inspector Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-sky-300/15 bg-[#0a1b33] px-3.5 py-2 font-mono text-[11px]">
        <div className="min-w-0 flex-1 truncate text-sky-100/90">
          {inspectedEntity ? (
            <span>
              <strong className="text-white">{inspectedEntity.name}</strong>{" "}
              <span className="text-sky-300">({inspectedEntity.pinLabel})</span>
              {inspectedEntity.roomName ? ` · ${inspectedEntity.roomName}` : ""}
              {inspectedEntity.readingLabel ? ` · ${inspectedEntity.readingLabel}` : ""}
              {" → "}
              <span className="text-cyan-300">
                {boardById.get(inspectedEntity.boardId)?.name ?? "Board"}
              </span>
            </span>
          ) : inspectedBoard ? (
            <span>
              <strong className="text-white">{inspectedBoard.board.name}</strong>{" "}
              <span className={inspectedBoard.isNode ? "text-purple-300" : "text-sky-300"}>
                [{inspectedBoard.isNode ? "ESP-NOW NODE" : "CONTROLLER"}]
              </span>{" "}
              · {inspectedBoard.board.board_model}
              {inspectedBoard.roomName ? ` · ${inspectedBoard.roomName}` : " · Unassigned"}
              {inspectedBoard.isNode && inspectedBoard.board.assigned_controller_id
                ? ` · Host: ${boardById.get(inspectedBoard.board.assigned_controller_id)?.name ?? "Controller"}`
                : ""}
            </span>
          ) : (
            <span className="text-sky-200/70">
              Click any Controller, Node, Room, or device to trace its full wiring circuit · Drag to pan
            </span>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-3 text-[10px] text-sky-200/75">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-xs border border-sky-400 bg-sky-400/30" />
            Controller
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full border border-purple-400 bg-purple-400/30" />
            Node
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 bg-sky-400" />
            Switch
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 bg-emerald-400" />
            Device
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 bg-purple-400" />
            Sensor
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 border-t border-dashed border-purple-400" />
            ESP-NOW
          </span>
        </div>
      </div>
    </div>
  );
});
