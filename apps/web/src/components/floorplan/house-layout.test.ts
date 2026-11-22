import { describe, expect, it } from "vitest";
import {
  buildHousePlan,
  isLayoutConfigured,
  placeRoomDevices,
  type HousePlan,
  type PlanSourceRoom,
} from "./house-layout";

function room(
  id: string,
  name: string,
  type: PlanSourceRoom["room_type"],
  rect?: { x: number; y: number; w: number; h: number }
): PlanSourceRoom {
  return {
    id,
    name,
    room_type: type,
    floor_x: rect?.x ?? 0,
    floor_y: rect?.y ?? 0,
    floor_w: rect?.w ?? null,
    floor_h: rect?.h ?? null,
    layout_config: { floorStyle: "wood" },
  };
}

const unconfiguredHome: PlanSourceRoom[] = [
  room("r1", "Living Room", "living_room"),
  room("r2", "Kitchen", "kitchen"),
  room("r3", "Primary Bedroom", "bedroom"),
  room("r4", "Bathroom", "bathroom"),
  room("r5", "Dining Room", "dining"),
  room("r6", "Hallway", "hallway"),
];

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** True when the given point on a room edge is either walled or an opening. */
function pointIsCovered(plan: HousePlan, x: number, y: number, axis: "h" | "v"): boolean {
  const onWall = plan.walls.some((wall) => {
    if (axis === "h") {
      return Math.abs(wall.y1 - y) < 1.5 && Math.abs(wall.y2 - y) < 1.5 && x >= wall.x1 - 1.5 && x <= wall.x2 + 1.5 && wall.x1 !== wall.x2;
    }
    return Math.abs(wall.x1 - x) < 1.5 && Math.abs(wall.x2 - x) < 1.5 && y >= wall.y1 - 1.5 && y <= wall.y2 + 1.5 && wall.y1 !== wall.y2;
  });
  if (onWall) return true;
  return plan.doors.some((door) => {
    if (door.axis !== axis) return false;
    const along = axis === "h" ? x : y;
    const line = axis === "h" ? y : x;
    return Math.abs(door.line - line) < 1.5 && along >= door.start - 1 && along <= door.start + door.length + 1;
  });
}

function expectEveryEdgeEnclosed(plan: HousePlan) {
  for (const room of plan.rooms) {
    const steps = Math.max(3, Math.round(room.w / 20));
    for (let index = 0; index <= steps; index += 1) {
      const x = room.x + (room.w * index) / steps;
      expect(pointIsCovered(plan, x, room.y, "h"), `${room.name} top edge at ${x}`).toBe(true);
      expect(pointIsCovered(plan, x, room.y + room.h, "h"), `${room.name} bottom edge at ${x}`).toBe(true);
    }
    const vSteps = Math.max(3, Math.round(room.h / 20));
    for (let index = 0; index <= vSteps; index += 1) {
      const y = room.y + (room.h * index) / vSteps;
      expect(pointIsCovered(plan, room.x, y, "v"), `${room.name} left edge at ${y}`).toBe(true);
      expect(pointIsCovered(plan, room.x + room.w, y, "v"), `${room.name} right edge at ${y}`).toBe(true);
    }
  }
}

describe("buildHousePlan", () => {
  it("generates one connected, non-overlapping house when no positions are configured", () => {
    expect(isLayoutConfigured(unconfiguredHome)).toBe(false);

    const plan = buildHousePlan(unconfiguredHome);
    expect(plan.rooms).toHaveLength(unconfiguredHome.length);
    expect(plan.bounds.w).toBeGreaterThan(600);
    expect(plan.bounds.h).toBeGreaterThan(300);

    for (let i = 0; i < plan.rooms.length; i += 1) {
      for (let j = i + 1; j < plan.rooms.length; j += 1) {
        expect(rectsOverlap(plan.rooms[i]!, plan.rooms[j]!)).toBe(false);
      }
    }

    // Rooms form rows that butt against each other: every room shares at least
    // one full edge with another room, so nothing floats as an isolated box.
    for (const candidate of plan.rooms) {
      const touchesAnother = plan.rooms.some(
        (other) =>
          other.id !== candidate.id &&
          (Math.abs(other.x + other.w - candidate.x) < 1 ||
            Math.abs(candidate.x + candidate.w - other.x) < 1 ||
            Math.abs(other.y + other.h - candidate.y) < 1 ||
            Math.abs(candidate.y + candidate.h - other.y) < 1)
      );
      expect(touchesAnother, `${candidate.name} should share a wall`).toBe(true);
    }

    expectEveryEdgeEnclosed(plan);
  });

  it("cuts doorways between adjacent rooms and keeps the rest of the wall solid", () => {
    const rooms = [
      room("a", "Living Room", "living_room", { x: 0, y: 0, w: 400, h: 300 }),
      room("b", "Kitchen", "kitchen", { x: 400, y: 0, w: 300, h: 300 }),
      room("c", "Bedroom", "bedroom", { x: 0, y: 300, w: 400, h: 260 }),
    ];
    const plan = buildHousePlan(rooms);

    const interiorDoors = plan.doors.filter((door) => door.kind === "interior");
    expect(interiorDoors.length).toBeGreaterThanOrEqual(2);

    const livingKitchen = interiorDoors.find(
      (door) => door.axis === "v" && Math.abs(door.line - 400) < 1
    );
    expect(livingKitchen).toBeTruthy();

    // The shared wall is split around the doorway instead of being drawn across it.
    const coveredByWall = plan.walls.some(
      (wall) =>
        wall.x1 === 400 &&
        wall.x2 === 400 &&
        Math.min(wall.y2, livingKitchen!.start + livingKitchen!.length) >
          Math.max(wall.y1, livingKitchen!.start) + 2
    );
    expect(coveredByWall).toBe(false);
    expectEveryEdgeEnclosed(plan);
  });

  it("snaps near-flush saved rooms onto a shared wall", () => {
    const rooms = [
      room("a", "Living Room", "living_room", { x: 0, y: 0, w: 400, h: 300 }),
      // 5px drift on both axes, as happens after manual arranging
      room("b", "Kitchen", "kitchen", { x: 405, y: 4, w: 300, h: 296 }),
    ];
    const plan = buildHousePlan(rooms);
    const [living, kitchen] = plan.rooms;
    expect(living!.x + living!.w).toBe(kitchen!.x);
    expect(living!.y).toBe(kitchen!.y);
    expect(plan.doors.some((door) => door.axis === "v" && Math.abs(door.line - 400) < 1)).toBe(true);
  });

  it("honours live drag overrides so walls follow a room being moved", () => {
    const rooms = [
      room("a", "Living Room", "living_room", { x: 0, y: 0, w: 400, h: 300 }),
      room("b", "Kitchen", "kitchen", { x: 400, y: 0, w: 300, h: 300 }),
    ];
    const plan = buildHousePlan(rooms, { b: { x: 520 } });
    const kitchen = plan.rooms.find((item) => item.id === "b")!;
    expect(kitchen.x).toBe(520);
    expect(plan.bounds.w).toBe(820);
  });

  it("adds an entry door on an exterior wall", () => {
    const plan = buildHousePlan(unconfiguredHome);
    expect(plan.doors.some((door) => door.kind === "entry")).toBe(true);
  });
});

describe("placeRoomDevices", () => {
  const plan = buildHousePlan([
    room("living", "Living room", "living_room", { x: 0, y: 0, w: 420, h: 320 }),
  ]);
  const living = plan.rooms[0]!;

  const devices = [
    { id: "switch:lamp", kind: "light" as const },
    { id: "device:tv", kind: "tv" as const },
    { id: "camera:front", kind: "camera" as const },
    { id: "sensor:temp", kind: "sensor-temperature" as const },
    { id: "device:fan", kind: "fan" as const },
  ];

  it("keeps every badge inside its room", () => {
    const placements = placeRoomDevices(living, devices);
    expect(Object.keys(placements)).toHaveLength(devices.length);
    for (const point of Object.values(placements)) {
      expect(point.x).toBeGreaterThan(living.x + 12);
      expect(point.x).toBeLessThan(living.x + living.w - 12);
      expect(point.y).toBeGreaterThan(living.y + 12);
      expect(point.y).toBeLessThan(living.y + living.h - 12);
    }
  });

  it("separates badges so two devices never stack on top of each other", () => {
    const placements = placeRoomDevices(living, devices);
    const points = Object.values(placements);
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const distance = Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y);
        expect(distance).toBeGreaterThan(20);
      }
    }
  });

  it("is deterministic so badges never jump between live refreshes", () => {
    const first = placeRoomDevices(living, devices);
    const second = placeRoomDevices(living, [...devices].reverse());
    expect(second).toEqual(first);
  });
});
