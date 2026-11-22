/**
 * HomecoreOS — 2D smart-home floor map geometry.
 *
 * Turns the user's real rooms (positions, sizes, doors, windows saved through the
 * Rooms workflow) into one connected architectural plan:
 *
 *   rooms  →  magnetised rects  →  merged shared walls  →  doorways  →  windows
 *
 * Everything in this module is pure so the map renderer stays a thin view layer and
 * the geometry can be unit tested without a DOM.
 */
import {
  inferRoomTypeFromName,
  type FloorDoor,
  type FloorStyle,
  type FloorWindow,
  type RoomLayoutConfig,
  type RoomType,
  type WallSide,
} from "@homecoreos/shared";

/** Minimal room shape the planner needs (structurally compatible with RoomItem). */
export interface PlanSourceRoom {
  id: string;
  name: string;
  room_type?: RoomType | null;
  floor_order?: number | null;
  floor_x?: number | null;
  floor_y?: number | null;
  floor_w?: number | null;
  floor_h?: number | null;
  layout_config?: RoomLayoutConfig | null;
}

export interface PlanRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlanRoom extends PlanRect {
  id: string;
  name: string;
  type: RoomType;
  index: number;
  floorStyle: FloorStyle;
  layoutConfig: RoomLayoutConfig;
  doors: FloorDoor[];
  windows: FloorWindow[];
  /** Centre of the room, handy for labels and selection rings. */
  cx: number;
  cy: number;
  /** True when the room uses a position saved from the Rooms / Arrange workflow. */
  configured: boolean;
}

/** Wall run with the doorways already cut out of it. */
export interface PlanWall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  exterior: boolean;
}

export interface PlanDoor {
  id: string;
  /** Orientation of the wall the opening sits in. */
  axis: "h" | "v";
  /** Wall coordinate: y for a horizontal wall, x for a vertical wall. */
  line: number;
  /** Start coordinate along the wall. */
  start: number;
  /** Clear opening width. */
  length: number;
  kind: "interior" | "entry";
  roomIds: string[];
  /** Which side the leaf swings to, so neighbouring doors do not overlap. */
  swing: 1 | -1;
}

export interface PlanWindow {
  id: string;
  axis: "h" | "v";
  line: number;
  start: number;
  length: number;
}

export interface HousePlan {
  rooms: PlanRoom[];
  walls: PlanWall[];
  doors: PlanDoor[];
  windows: PlanWindow[];
  bounds: { x: number; y: number; w: number; h: number };
}

export type FloorDeviceKind =
  | "light"
  | "dimmer"
  | "plug"
  | "fan"
  | "tv"
  | "speaker"
  | "camera"
  | "ac"
  | "heater"
  | "lock"
  | "door"
  | "valve"
  | "buzzer"
  | "sensor-temperature"
  | "sensor-humidity"
  | "sensor-motion"
  | "sensor-contact"
  | "sensor-light"
  | "sensor-power"
  | "sensor-generic"
  | "generic";

export interface PlaceableDevice {
  id: string;
  kind: FloorDeviceKind;
}

export interface PlanPoint {
  x: number;
  y: number;
}

/* -------------------------------------------------------------------------- */
/* Layout constants                                                            */
/* -------------------------------------------------------------------------- */

/** Wall thickness used for thresholds, window marks and hit areas. */
export const WALL_THICKNESS = 7;
const MIN_ROOM_W = 168;
const MIN_ROOM_H = 168;
const DEFAULT_ROOM_W = 360;
const DEFAULT_ROOM_H = 280;
const PLAN_WIDTH = 1120;
const MAX_ROW_WEIGHT = 4.4;
const ROW_BASE_HEIGHT = 250;
const SNAP_TOLERANCE = 8;
const MIN_SHARED_EDGE = 68;
const DOOR_MIN = 44;
const DOOR_MAX = 64;

const ROOM_WEIGHT: Record<RoomType, number> = {
  living_room: 2.4,
  bedroom: 1.7,
  kitchen: 1.5,
  dining: 1.4,
  bathroom: 1.0,
  toilet: 0.85,
  hallway: 0.95,
  patio: 1.3,
  office: 1.2,
  garage: 1.8,
  utility: 1.0,
  custom: 1.2,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, step = 2): number {
  return Math.round(value / step) * step;
}

export function resolveRoomType(room: PlanSourceRoom): RoomType {
  return room.room_type ?? inferRoomTypeFromName(room.name);
}

/**
 * A layout counts as "configured" when at least two rooms sit in different
 * places. A brand-new home where every room is still at 0,0 falls back to the
 * generated house layout until the user arranges the plan.
 */
export function isLayoutConfigured(rooms: PlanSourceRoom[]): boolean {
  if (rooms.length < 2) {
    return rooms.some(
      (room) =>
        (room.floor_x ?? 0) !== 0 ||
        (room.floor_y ?? 0) !== 0 ||
        room.floor_w != null ||
        room.floor_h != null
    );
  }
  const seen = new Set<string>();
  for (const room of rooms) {
    seen.add(`${room.floor_x ?? 0}:${room.floor_y ?? 0}`);
  }
  return seen.size > 1;
}

function distributeWidths(weights: number[], total: number, minWidth: number): number[] {
  const count = weights.length;
  if (count === 0) return [];
  const maxWidth = total * 0.58;

  // Blend towards equal shares for sparse rows so a lone bathroom does not
  // stretch across the whole floor plate.
  const sum = weights.reduce((acc, w) => acc + w, 0);
  const average = sum / count;
  const blended = sum < 2.6 ? weights.map((w) => w * 0.55 + average * 0.45) : weights;
  const blendedSum = blended.reduce((acc, w) => acc + w, 0) || 1;

  let widths = blended.map((w) => (total * w) / blendedSum);
  for (let pass = 0; pass < 4; pass += 1) {
    let overflow = 0;
    let flexible = 0;
    widths = widths.map((w) => {
      if (w < minWidth) {
        overflow += minWidth - w;
        return minWidth;
      }
      if (w > maxWidth) {
        overflow -= w - maxWidth;
        return maxWidth;
      }
      flexible += w;
      return w;
    });
    if (Math.abs(overflow) < 0.5 || flexible <= 0) break;
    widths = widths.map((w) =>
      w > minWidth && w < maxWidth ? Math.max(minWidth, w + (overflow * w) / flexible) : w
    );
  }

  // Snap to whole units and push the rounding remainder into the widest room so
  // every row spans the same total width and walls line up.
  const snapped = widths.map((w) => round(w));
  const drift = round(total) - snapped.reduce((acc, w) => acc + w, 0);
  if (snapped.length > 0) {
    let widest = 0;
    snapped.forEach((w, i) => {
      if (w > snapped[widest]!) widest = i;
    });
    snapped[widest] = Math.max(minWidth, snapped[widest]! + drift);
  }
  return snapped;
}

/** Generated "house grammar" layout used until the user arranges the plan. */
function autoLayout(rooms: PlanSourceRoom[]): PlanRect[] {
  if (rooms.length === 0) return [];
  if (rooms.length === 1) {
    return [
      {
        x: 0,
        y: 0,
        w: Math.max(MIN_ROOM_W, rooms[0]!.floor_w ?? 520),
        h: Math.max(MIN_ROOM_H, rooms[0]!.floor_h ?? 380),
      },
    ];
  }

  const weights = rooms.map((room) => ROOM_WEIGHT[resolveRoomType(room)] ?? 1.2);
  const rows: number[][] = [];
  let current: number[] = [];
  let currentWeight = 0;

  weights.forEach((weight, index) => {
    if (current.length > 0 && currentWeight + weight > MAX_ROW_WEIGHT) {
      rows.push(current);
      current = [];
      currentWeight = 0;
    }
    current.push(index);
    currentWeight += weight;
  });
  if (current.length > 0) rows.push(current);

  const rects: PlanRect[] = rooms.map(() => ({ x: 0, y: 0, w: MIN_ROOM_W, h: MIN_ROOM_H }));
  let cursorY = 0;

  for (const row of rows) {
    const rowWeights = row.map((index) => weights[index]!);
    const rowWeight = rowWeights.reduce((acc, w) => acc + w, 0);
    const widths = distributeWidths(rowWeights, PLAN_WIDTH, MIN_ROOM_W);
    const height = round(clamp(ROW_BASE_HEIGHT * (Math.sqrt(rowWeight) / 1.55), 200, 340), 4);
    let cursorX = 0;
    row.forEach((index, position) => {
      const width = widths[position] ?? MIN_ROOM_W;
      rects[index] = { x: round(cursorX), y: round(cursorY), w: width, h: height };
      cursorX += width;
    });
    cursorY += height;
  }

  return rects;
}

function buildSnapper(values: number[], tolerance: number): (value: number) => number {
  const sorted = Array.from(new Set(values.map((value) => round(value)))).sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(value - last[last.length - 1]!) <= tolerance) {
      last.push(value);
    } else {
      clusters.push([value]);
    }
  }
  const lookup = new Map<number, number>();
  for (const cluster of clusters) {
    const target = cluster[Math.floor((cluster.length - 1) / 2)]!;
    for (const value of cluster) lookup.set(value, target);
  }
  return (value: number) => lookup.get(round(value)) ?? round(value);
}

/**
 * Aligns walls that are almost but not exactly flush, so saved rooms that were
 * nudged around still share a single continuous wall instead of leaving slivers.
 */
function magnetize(rects: PlanRect[]): PlanRect[] {
  if (rects.length < 2) {
    return rects.map((rect) => ({ x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) }));
  }
  const xEdges: number[] = [];
  const yEdges: number[] = [];
  for (const rect of rects) {
    xEdges.push(rect.x, rect.x + rect.w);
    yEdges.push(rect.y, rect.y + rect.h);
  }
  const snapX = buildSnapper(xEdges, SNAP_TOLERANCE);
  const snapY = buildSnapper(yEdges, SNAP_TOLERANCE);

  return rects.map((rect) => {
    const left = snapX(rect.x);
    const right = snapX(rect.x + rect.w);
    const top = snapY(rect.y);
    const bottom = snapY(rect.y + rect.h);
    return {
      x: left,
      y: top,
      w: Math.max(MIN_ROOM_W, right - left),
      h: Math.max(MIN_ROOM_H, bottom - top),
    };
  });
}

function resolveRects(rooms: PlanSourceRoom[]): { rects: PlanRect[]; configured: boolean } {
  const configured = isLayoutConfigured(rooms);
  if (!configured) {
    return { rects: autoLayout(rooms), configured: false };
  }

  const rects: PlanRect[] = rooms.map((room) => ({
    x: round(room.floor_x ?? 0),
    y: round(room.floor_y ?? 0),
    w: Math.max(MIN_ROOM_W, round(room.floor_w ?? DEFAULT_ROOM_W)),
    h: Math.max(MIN_ROOM_H, round(room.floor_h ?? DEFAULT_ROOM_H)),
  }));

  // Rooms without a saved position (for example one added after the plan was
  // arranged) are stacked below the arranged extent instead of piling up at 0,0.
  let extentBottom = Number.NEGATIVE_INFINITY;
  let extentLeft = Number.POSITIVE_INFINITY;
  rects.forEach((rect, index) => {
    const room = rooms[index]!;
    const hasPosition = room.floor_x != null || room.floor_y != null;
    if (hasPosition) {
      extentBottom = Math.max(extentBottom, rect.y + rect.h);
      extentLeft = Math.min(extentLeft, rect.x);
    }
  });
  if (Number.isFinite(extentBottom)) {
    let cursorX = Number.isFinite(extentLeft) ? extentLeft : 0;
    rects.forEach((rect, index) => {
      const room = rooms[index]!;
      if (room.floor_x == null && room.floor_y == null) {
        rects[index] = { ...rect, x: round(cursorX), y: round(extentBottom) };
        cursorX += rect.w;
      }
    });
  }

  return { rects: magnetize(rects), configured: true };
}

/* -------------------------------------------------------------------------- */
/* Walls, doorways and windows                                                 */
/* -------------------------------------------------------------------------- */

interface Run {
  line: number;
  a: number;
  b: number;
}

function mergeRuns(runs: Run[]): Run[] {
  const byLine = new Map<number, Run[]>();
  for (const run of runs) {
    const key = round(run.line);
    const list = byLine.get(key) ?? [];
    list.push({ line: key, a: Math.min(run.a, run.b), b: Math.max(run.a, run.b) });
    byLine.set(key, list);
  }

  const merged: Run[] = [];
  for (const list of byLine.values()) {
    list.sort((left, right) => left.a - right.a);
    let current: Run | null = null;
    for (const run of list) {
      if (!current) {
        current = { ...run };
        continue;
      }
      if (run.a <= current.b + 0.5) {
        current.b = Math.max(current.b, run.b);
      } else {
        merged.push(current);
        current = { ...run };
      }
    }
    if (current) merged.push(current);
  }
  return merged;
}

function cutRun(run: Run, cuts: Array<{ a: number; b: number }>): Run[] {
  let pieces: Run[] = [run];
  for (const cut of cuts) {
    const next: Run[] = [];
    for (const piece of pieces) {
      const overlapStart = Math.max(piece.a, cut.a);
      const overlapEnd = Math.min(piece.b, cut.b);
      if (overlapEnd <= overlapStart) {
        next.push(piece);
        continue;
      }
      if (overlapStart - piece.a > 2) next.push({ line: piece.line, a: piece.a, b: overlapStart });
      if (piece.b - overlapEnd > 2) next.push({ line: piece.line, a: overlapEnd, b: piece.b });
    }
    pieces = next;
  }
  return pieces;
}

interface Adjacency {
  axis: "h" | "v";
  line: number;
  a: number;
  b: number;
  rooms: [number, number];
}

function findAdjacencies(rects: PlanRect[]): Adjacency[] {
  const found: Adjacency[] = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const left = rects[i]!;
      const right = rects[j]!;

      // Vertical shared wall
      const verticalCandidate =
        Math.abs(left.x + left.w - right.x) <= 1
          ? left.x + left.w
          : Math.abs(right.x + right.w - left.x) <= 1
            ? right.x + right.w
            : null;
      if (verticalCandidate != null) {
        const from = Math.max(left.y, right.y);
        const to = Math.min(left.y + left.h, right.y + right.h);
        if (to - from >= MIN_SHARED_EDGE) {
          found.push({ axis: "v", line: verticalCandidate, a: from, b: to, rooms: [i, j] });
        }
      }

      // Horizontal shared wall
      const horizontalCandidate =
        Math.abs(left.y + left.h - right.y) <= 1
          ? left.y + left.h
          : Math.abs(right.y + right.h - left.y) <= 1
            ? right.y + right.h
            : null;
      if (horizontalCandidate != null) {
        const from = Math.max(left.x, right.x);
        const to = Math.min(left.x + left.w, right.x + right.w);
        if (to - from >= MIN_SHARED_EDGE) {
          found.push({ axis: "h", line: horizontalCandidate, a: from, b: to, rooms: [i, j] });
        }
      }
    }
  }
  return found;
}

function doorLengthFor(span: number): number {
  return clamp(round(span * 0.32), DOOR_MIN, Math.min(DOOR_MAX, span - 28));
}

function wallSideToAxis(side: WallSide): "h" | "v" {
  return side === "top" || side === "bottom" ? "h" : "v";
}

function windowLengthFor(span: number): number {
  return clamp(round(span * 0.42), 56, 150);
}

/**
 * Builds the connected floor plan for a set of rooms.
 *
 * `overrides` carries live drag / resize rects from the Arrange workflow so the
 * walls, doorways and windows follow a room while it is being moved.
 */
export function buildHousePlan(
  sourceRooms: PlanSourceRoom[],
  overrides?: Record<string, Partial<PlanRect>>
): HousePlan {
  const { rects, configured } = resolveRects(sourceRooms);

  if (overrides && Object.keys(overrides).length > 0) {
    sourceRooms.forEach((room, index) => {
      const override = overrides[room.id];
      if (!override) return;
      const base = rects[index]!;
      rects[index] = {
        x: round(override.x ?? base.x),
        y: round(override.y ?? base.y),
        w: Math.max(MIN_ROOM_W, round(override.w ?? base.w)),
        h: Math.max(MIN_ROOM_H, round(override.h ?? base.h)),
      };
    });
  }

  const rooms: PlanRoom[] = sourceRooms.map((room, index) => {
    const rect = rects[index]!;
    const layoutConfig = room.layout_config ?? {};
    return {
      ...rect,
      id: room.id,
      name: room.name,
      type: resolveRoomType(room),
      index,
      floorStyle: layoutConfig.floorStyle ?? "wood",
      layoutConfig,
      doors: layoutConfig.doors ?? [],
      windows: layoutConfig.windows ?? [],
      cx: rect.x + rect.w / 2,
      cy: rect.y + rect.h / 2,
      configured,
    };
  });

  const extent = rooms.reduce(
    (acc, room) => ({
      minX: Math.min(acc.minX, room.x),
      minY: Math.min(acc.minY, room.y),
      maxX: Math.max(acc.maxX, room.x + room.w),
      maxY: Math.max(acc.maxY, room.y + room.h),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  );
  const bounds = {
    x: extent.minX,
    y: extent.minY,
    w: extent.maxX - extent.minX,
    h: extent.maxY - extent.minY,
  };

  const emptyBounds = { x: 0, y: 0, w: 640, h: 380 };
  if (rooms.length === 0) {
    return { rooms, walls: [], doors: [], windows: [], bounds: emptyBounds };
  }

  const isOnBoundary = (axis: "h" | "v", line: number) =>
    axis === "h"
      ? Math.abs(line - bounds.y) <= 1 || Math.abs(line - (bounds.y + bounds.h)) <= 1
      : Math.abs(line - bounds.x) <= 1 || Math.abs(line - (bounds.x + bounds.w)) <= 1;

  /* ---- Interior doorways between connected rooms ---- */
  const doors: PlanDoor[] = [];
  for (const adjacency of findAdjacencies(rects)) {
    const span = adjacency.b - adjacency.a;
    const length = doorLengthFor(span);
    if (length < DOOR_MIN) continue;
    const start = round(adjacency.a + span / 2 - length / 2);
    const clashes = doors.some(
      (door) =>
        door.axis === adjacency.axis &&
        Math.abs(door.line - adjacency.line) <= 1 &&
        Math.abs(door.start - start) < length
    );
    if (clashes) continue;
    doors.push({
      id: `door-${adjacency.rooms[0]}-${adjacency.rooms[1]}-${adjacency.axis}-${start}`,
      axis: adjacency.axis,
      line: adjacency.line,
      start,
      length,
      kind: "interior",
      roomIds: [sourceRooms[adjacency.rooms[0]]!.id, sourceRooms[adjacency.rooms[1]]!.id],
      swing: (start + adjacency.rooms[1]) % 2 === 0 ? 1 : -1,
    });
  }

  /* ---- Doors configured in the room editor ---- */
  for (const room of rooms) {
    for (const door of room.doors) {
      const axis = wallSideToAxis(door.wall);
      const span = axis === "h" ? room.w : room.h;
      const origin = axis === "h" ? room.x : room.y;
      const line =
        door.wall === "top" || door.wall === "left"
          ? axis === "h"
            ? room.y
            : room.x
          : axis === "h"
            ? room.y + room.h
            : room.x + room.w;
      const length = clamp(round(door.width ?? 56), 30, span * 0.5);
      const start = round(origin + clamp(span * door.offset, length / 2, span - length / 2) - length / 2);
      const duplicates = doors.some(
        (existing) =>
          existing.axis === axis &&
          Math.abs(existing.line - line) <= 1 &&
          Math.abs(existing.start - start) < length * 0.8
      );
      if (duplicates) continue;
      doors.push({
        id: `door-${room.id}-${door.id}`,
        axis,
        line,
        start,
        length,
        kind: isOnBoundary(axis, line) ? "entry" : "interior",
        roomIds: [room.id],
        swing: door.hinge === "end" ? -1 : 1,
      });
    }
  }

  /* ---- Entry door on an exterior wall (prefer the hallway / entry room) ---- */
  if (!doors.some((door) => door.kind === "entry")) {
    const entryRoom =
      rooms.find((room) => room.type === "hallway") ??
      rooms.find((room) => room.type === "living_room") ??
      rooms[0]!;
    const candidates: Array<{ axis: "h" | "v"; line: number; a: number; b: number }> = [
      { axis: "h", line: entryRoom.y + entryRoom.h, a: entryRoom.x, b: entryRoom.x + entryRoom.w },
      { axis: "h", line: entryRoom.y, a: entryRoom.x, b: entryRoom.x + entryRoom.w },
      { axis: "v", line: entryRoom.x + entryRoom.w, a: entryRoom.y, b: entryRoom.y + entryRoom.h },
      { axis: "v", line: entryRoom.x, a: entryRoom.y, b: entryRoom.y + entryRoom.h },
    ];
    const exterior = candidates.find((candidate) => isOnBoundary(candidate.axis, candidate.line));
    if (exterior) {
      const span = exterior.b - exterior.a;
      const length = clamp(round(span * 0.26), 48, 76);
      const start = round(exterior.a + span / 2 - length / 2);
      doors.push({
        id: `entry-${entryRoom.id}`,
        axis: exterior.axis,
        line: exterior.line,
        start,
        length,
        kind: "entry",
        roomIds: [entryRoom.id],
        swing: 1,
      });
    }
  }

  /* ---- Windows ---- */
  const windows: PlanWindow[] = [];
  for (const room of rooms) {
    for (const window of room.windows) {
      const axis = wallSideToAxis(window.wall);
      const span = axis === "h" ? room.w : room.h;
      const origin = axis === "h" ? room.x : room.y;
      const line =
        window.wall === "top" || window.wall === "left"
          ? axis === "h"
            ? room.y
            : room.x
          : axis === "h"
            ? room.y + room.h
            : room.x + room.w;
      const length = clamp(round(window.width ?? 96), 40, span * 0.6);
      const start = round(origin + clamp(span * window.offset, length / 2, span - length / 2) - length / 2);
      windows.push({ id: `win-${room.id}-${window.id}`, axis, line, start, length });
    }
  }

  // Daylight is added automatically on exterior walls for habitable rooms so the
  // plan reads like an architectural drawing even before windows are configured.
  const autoWindowTypes = new Set<RoomType>(["living_room", "bedroom", "kitchen", "dining", "office", "hallway"]);
  let autoWindowSeq = 0;
  for (const room of rooms) {
    if (room.windows.length > 0) continue;
    if (!autoWindowTypes.has(room.type)) continue;
    const edges = (
      [
        { axis: "h", line: room.y, a: room.x, b: room.x + room.w },
        { axis: "h", line: room.y + room.h, a: room.x, b: room.x + room.w },
        { axis: "v", line: room.x, a: room.y, b: room.y + room.h },
        { axis: "v", line: room.x + room.w, a: room.y, b: room.y + room.h },
      ] as Array<{ axis: "h" | "v"; line: number; a: number; b: number }>
    ).filter((edge) => isOnBoundary(edge.axis, edge.line));

    for (const edge of edges.slice(0, room.type === "living_room" ? 2 : 1)) {
      const span = edge.b - edge.a;
      if (span < 160) continue;
      const length = windowLengthFor(span);
      const start = round(edge.a + span / 2 - length / 2);
      autoWindowSeq += 1;
      windows.push({ id: `win-auto-${room.id}-${autoWindowSeq}`, axis: edge.axis, line: edge.line, start, length });
    }
  }

  /* ---- Wall runs with openings cut out ---- */
  const horizontalRuns = mergeRuns([
    ...rooms.flatMap((room) => [
      { line: room.y, a: room.x, b: room.x + room.w },
      { line: room.y + room.h, a: room.x, b: room.x + room.w },
    ]),
  ]);
  const verticalRuns = mergeRuns([
    ...rooms.flatMap((room) => [
      { line: room.x, a: room.y, b: room.y + room.h },
      { line: room.x + room.w, a: room.y, b: room.y + room.h },
    ]),
  ]);

  const horizontalCuts = new Map<number, Array<{ a: number; b: number }>>();
  const verticalCuts = new Map<number, Array<{ a: number; b: number }>>();
  for (const door of doors) {
    const target = door.axis === "h" ? horizontalCuts : verticalCuts;
    const key = round(door.line);
    const list = target.get(key) ?? [];
    list.push({ a: door.start, b: door.start + door.length });
    target.set(key, list);
  }

  const walls: PlanWall[] = [];
  for (const run of horizontalRuns) {
    const cuts = horizontalCuts.get(run.line) ?? [];
    for (const piece of cutRun(run, cuts)) {
      walls.push({ x1: piece.a, y1: piece.line, x2: piece.b, y2: piece.line, exterior: isOnBoundary("h", piece.line) });
    }
  }
  for (const run of verticalRuns) {
    const cuts = verticalCuts.get(run.line) ?? [];
    for (const piece of cutRun(run, cuts)) {
      walls.push({ x1: piece.line, y1: piece.a, x2: piece.line, y2: piece.b, exterior: isOnBoundary("v", piece.line) });
    }
  }

  return {
    rooms,
    walls,
    doors,
    windows,
    bounds: {
      x: round(bounds.x),
      y: round(bounds.y),
      w: round(round(bounds.x + bounds.w) - round(bounds.x)),
      h: round(round(bounds.y + bounds.h) - round(bounds.y)),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Device placement                                                            */
/* -------------------------------------------------------------------------- */

type AnchorZone =
  | "center"
  | "wall-top"
  | "wall-bottom"
  | "wall-top-left"
  | "wall-top-right"
  | "wall-bottom-left"
  | "wall-bottom-right"
  | "corner-tl"
  | "corner-tr"
  | "corner-bl"
  | "corner-br"
  | "side-left"
  | "side-right";

const KIND_ANCHORS: Record<FloorDeviceKind, AnchorZone[]> = {
  light: ["center", "wall-top-left", "side-left", "side-right"],
  dimmer: ["center", "side-right", "wall-top-right"],
  fan: ["center", "corner-tr", "corner-tl"],
  tv: ["wall-bottom-left", "wall-top-right", "wall-bottom-right"],
  speaker: ["side-right", "wall-bottom-right", "corner-br"],
  camera: ["corner-tr", "corner-tl", "corner-bl", "corner-br"],
  ac: ["wall-top", "wall-top-left", "side-left"],
  heater: ["wall-bottom-right", "corner-br", "side-right"],
  plug: ["corner-bl", "corner-br", "side-left"],
  lock: ["side-right", "side-left", "wall-bottom"],
  door: ["wall-bottom", "side-right", "wall-top"],
  valve: ["side-left", "corner-bl", "wall-top"],
  buzzer: ["corner-tl", "corner-tr", "side-right"],
  "sensor-temperature": ["corner-tr", "corner-tl", "side-right"],
  "sensor-humidity": ["corner-tr", "corner-tl", "side-right"],
  "sensor-motion": ["corner-tr", "corner-tl", "corner-bl"],
  "sensor-contact": ["wall-top", "wall-bottom", "side-left"],
  "sensor-light": ["corner-tl", "corner-tr", "wall-top"],
  "sensor-power": ["corner-br", "corner-bl", "side-right"],
  "sensor-generic": ["corner-tr", "corner-bl", "side-left"],
  generic: ["center", "side-right", "corner-br", "wall-top"],
};

const PLACEMENT_PRIORITY: Record<FloorDeviceKind, number> = {
  camera: 0,
  tv: 1,
  ac: 2,
  lock: 3,
  door: 3,
  speaker: 4,
  fan: 5,
  plug: 6,
  valve: 7,
  heater: 7,
  buzzer: 8,
  light: 9,
  dimmer: 9,
  "sensor-temperature": 10,
  "sensor-humidity": 10,
  "sensor-motion": 10,
  "sensor-contact": 10,
  "sensor-light": 10,
  "sensor-power": 10,
  "sensor-generic": 10,
  generic: 11,
};

function anchorPoint(room: PlanRect, zone: AnchorZone, inset: number): PlanPoint {
  const { x, y, w, h } = room;
  switch (zone) {
    case "wall-top":
      return { x: x + w / 2, y: y + inset };
    case "wall-bottom":
      return { x: x + w / 2, y: y + h - inset };
    case "wall-top-left":
      return { x: x + w * 0.3, y: y + inset };
    case "wall-top-right":
      return { x: x + w * 0.7, y: y + inset };
    case "wall-bottom-left":
      return { x: x + w * 0.3, y: y + h - inset };
    case "wall-bottom-right":
      return { x: x + w * 0.7, y: y + h - inset };
    case "corner-tl":
      return { x: x + inset, y: y + inset };
    case "corner-tr":
      return { x: x + w - inset, y: y + inset };
    case "corner-bl":
      return { x: x + inset, y: y + h - inset };
    case "corner-br":
      return { x: x + w - inset, y: y + h - inset };
    case "side-left":
      return { x: x + inset, y: y + h / 2 };
    case "side-right":
      return { x: x + w - inset, y: y + h / 2 };
    default:
      return { x: x + w / 2, y: y + h / 2 };
  }
}

/** Where the room name label is drawn, so badges can keep clear of it. */
export function roomLabelAnchor(room: PlanRoom): PlanPoint {
  return { x: room.cx, y: room.y + room.h - Math.min(30, room.h * 0.13) };
}

/**
 * Places devices at natural spots inside a room: lights near the middle, TVs and
 * AC units against walls, cameras and sensors in corners, plugs near the floor
 * corners. Collisions are resolved deterministically so a device never jumps
 * between renders.
 */
export function placeRoomDevices(room: PlanRoom, devices: PlaceableDevice[]): Record<string, PlanPoint> {
  const result: Record<string, PlanPoint> = {};
  if (devices.length === 0) return result;

  // Positions the user placed themselves always win.
  const saved = room.layoutConfig.devicePositions ?? {};
  const savedPoints: Array<{ x: number; y: number }> = [];
  const pending: PlaceableDevice[] = [];
  for (const device of devices) {
    const position = saved[device.id];
    if (position) {
      const point = {
        x: Math.round(room.x + Math.min(0.94, Math.max(0.06, position.x)) * room.w),
        y: Math.round(room.y + Math.min(0.94, Math.max(0.06, position.y)) * room.h),
      };
      result[device.id] = point;
      savedPoints.push(point);
    } else {
      pending.push(device);
    }
  }
  if (pending.length === 0) return result;

  const compact = Math.min(room.w, room.h) < 200;
  const inset = compact ? 24 : clamp(Math.min(room.w, room.h) * 0.14, 26, 48);
  const minGap = compact ? 30 : 38;
  const labelPoint = roomLabelAnchor(room);

  const step = clamp(round(Math.min(room.w, room.h) / 4), 34, 66);
  const candidates: PlanPoint[] = [];
  for (let gx = room.x + inset; gx <= room.x + room.w - inset; gx += step) {
    for (let gy = room.y + inset; gy <= room.y + room.h - inset; gy += step) {
      candidates.push({ x: Math.round(gx), y: Math.round(gy) });
    }
  }
  // Always include the anchor zones themselves, even if the grid misses them.
  for (const zones of Object.values(KIND_ANCHORS)) {
    for (const zone of zones) {
      const point = anchorPoint(room, zone, inset);
      candidates.push({ x: Math.round(point.x), y: Math.round(point.y) });
    }
  }
  if (candidates.length === 0) {
    candidates.push({ x: room.cx, y: room.cy });
  }

  const placed: PlanPoint[] = [...savedPoints];
  const usage = new Map<FloorDeviceKind, number>();
  const ordered = [...pending].sort(
    (left, right) =>
      (PLACEMENT_PRIORITY[left.kind] ?? 5) - (PLACEMENT_PRIORITY[right.kind] ?? 5) ||
      left.id.localeCompare(right.id)
  );

  for (const device of ordered) {
    const used = usage.get(device.kind) ?? 0;
    usage.set(device.kind, used + 1);
    const zones = KIND_ANCHORS[device.kind] ?? KIND_ANCHORS.generic;
    const anchor = anchorPoint(room, zones[used % zones.length]!, inset);

    let best: PlanPoint | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const distance = Math.hypot(candidate.x - anchor.x, candidate.y - anchor.y);
      let score = distance;
      if (Math.hypot(candidate.x - labelPoint.x, candidate.y - labelPoint.y) < minGap * 1.6) {
        score += 160;
      }
      for (const other of placed) {
        const gap = Math.hypot(candidate.x - other.x, candidate.y - other.y);
        if (gap < minGap) score += (minGap - gap) * 12;
      }
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    const point = best ?? anchor;
    placed.push(point);
    result[device.id] = { x: Math.round(point.x), y: Math.round(point.y) };
  }

  return result;
}
