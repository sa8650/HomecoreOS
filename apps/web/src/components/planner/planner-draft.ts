/**
 * Editable wizard state for the Smart Home Planner.
 *
 * The draft only holds what the customer typed. It is converted to
 * PlannerRequirementsInput and sent to the Worker, which validates it again and
 * makes every hardware decision. Reading a draft back always goes through the
 * shared normalizer, so stored or restored data can never be malformed.
 */
import {
  PLANNER_DEVICE_CATEGORIES,
  PLANNER_INPUT_LIMITS,
  PLANNER_LOAD_CATEGORIES,
  PLANNER_SENSOR_WIRING_OPTIONS,
  normalizePlannerRequirements,
  type PlannerDeviceCategory,
  type PlannerEnvironment,
  type PlannerEthernetNeed,
  type PlannerRequirementsInput,
  type PlannerSensorWiring,
  type PlannerWifiAvailability,
} from "@homecoreos/shared";

export interface PlannerDraftDeviceCount {
  /** Physical devices. */
  quantity: number;
  /** How many of them are switched separately. */
  independent: number;
}

export interface PlannerDraftRoom {
  id: string;
  name: string;
  floor: number;
  /** null = the default (first or only) controller location. */
  locationId: string | null;
  devices: Record<PlannerDeviceCategory, PlannerDraftDeviceCount>;
  fanSpeedControl: number;
}

export interface PlannerDraftLocation {
  id: string;
  name: string;
  floor: number | null;
}

export interface PlannerDraft {
  floors: number;
  rooms: PlannerDraftRoom[];
  locations: PlannerDraftLocation[];
  wifi: PlannerWifiAvailability | null;
  ethernet: PlannerEthernetNeed;
  environment: PlannerEnvironment | null;
  maxCableRunMeters: number | null;
  sensorWiring: PlannerSensorWiring | null;
  allowAdditionalControllers: boolean;
  allowExternalRelayModules: boolean;
  futureOutputs: number;
  futureInputs: number;
}

/** Room names offered as one-tap shortcuts. They add an empty room, nothing more. */
export const PLANNER_ROOM_SUGGESTIONS = [
  "Living Room",
  "Kitchen",
  "Bedroom",
  "Bathroom",
  "Dining Room",
  "Office",
  "Hallway",
  "Garage",
  "Balcony",
  "Utility Room",
] as const;

function isLoadCategory(category: PlannerDeviceCategory): boolean {
  return (PLANNER_LOAD_CATEGORIES as readonly string[]).includes(category);
}

export function emptyDeviceCounts(): Record<PlannerDeviceCategory, PlannerDraftDeviceCount> {
  const counts = {} as Record<PlannerDeviceCategory, PlannerDraftDeviceCount>;
  for (const category of PLANNER_DEVICE_CATEGORIES) {
    counts[category] = { quantity: 0, independent: 0 };
  }
  return counts;
}

export function createEmptyDraft(): PlannerDraft {
  return {
    floors: 1,
    rooms: [],
    locations: [],
    wifi: null,
    ethernet: "not_needed",
    environment: null,
    maxCableRunMeters: null,
    sensorWiring: null,
    allowAdditionalControllers: true,
    allowExternalRelayModules: true,
    futureOutputs: 0,
    futureInputs: 0,
  };
}

function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let n = used.size + 1;
  while (used.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

/** "Bedroom" → "Bedroom 2" → "Bedroom 3" so every room keeps a distinct name. */
function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  const limit = PLANNER_INPUT_LIMITS.maxNameLength;
  const clean = base.trim().slice(0, limit);
  if (!used.has(clean.toLowerCase())) return clean;
  const stem = clean.replace(/\s+\d+$/, "");
  for (let n = 2; n < 1000; n += 1) {
    const suffix = ` ${n}`;
    const candidate = `${stem.slice(0, limit - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return clean;
}

export function canAddRoom(draft: PlannerDraft): boolean {
  return draft.rooms.length < PLANNER_INPUT_LIMITS.maxRooms;
}

export function addRoom(draft: PlannerDraft, name?: string): PlannerDraft {
  if (!canAddRoom(draft)) return draft;
  const names = draft.rooms.map((room) => room.name);
  const room: PlannerDraftRoom = {
    id: nextId(
      "room",
      draft.rooms.map((r) => r.id)
    ),
    name: uniqueName(name ?? `Room ${draft.rooms.length + 1}`, names),
    floor: 1,
    locationId: null,
    devices: emptyDeviceCounts(),
    fanSpeedControl: 0,
  };
  return { ...draft, rooms: [...draft.rooms, room] };
}

export function duplicateRoom(draft: PlannerDraft, roomId: string): PlannerDraft {
  const index = draft.rooms.findIndex((room) => room.id === roomId);
  const source = draft.rooms[index];
  if (!source || !canAddRoom(draft)) return draft;
  const devices = emptyDeviceCounts();
  for (const category of PLANNER_DEVICE_CATEGORIES) {
    devices[category] = { ...source.devices[category] };
  }
  const copy: PlannerDraftRoom = {
    ...source,
    id: nextId(
      "room",
      draft.rooms.map((r) => r.id)
    ),
    name: uniqueName(
      source.name || "Room",
      draft.rooms.map((room) => room.name)
    ),
    devices,
  };
  const rooms = [...draft.rooms];
  rooms.splice(index + 1, 0, copy);
  return { ...draft, rooms };
}

export function updateRoom(
  draft: PlannerDraft,
  roomId: string,
  changes: Partial<Pick<PlannerDraftRoom, "name" | "floor" | "locationId">>
): PlannerDraft {
  return {
    ...draft,
    rooms: draft.rooms.map((room) => (room.id === roomId ? { ...room, ...changes } : room)),
  };
}

export function removeRoom(draft: PlannerDraft, roomId: string): PlannerDraft {
  return { ...draft, rooms: draft.rooms.filter((room) => room.id !== roomId) };
}

function clampCount(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.trunc(value)));
}

/**
 * Changes how many devices of one kind a room has. While every device is
 * switched separately (the default) the separate count follows the quantity.
 */
export function setDeviceQuantity(
  draft: PlannerDraft,
  roomId: string,
  category: PlannerDeviceCategory,
  value: number
): PlannerDraft {
  const quantity = clampCount(value, PLANNER_INPUT_LIMITS.maxQuantityPerCategory);
  return {
    ...draft,
    rooms: draft.rooms.map((room) => {
      if (room.id !== roomId) return room;
      const current = room.devices[category];
      const followed = current.independent >= current.quantity;
      let independent = followed ? quantity : Math.min(current.independent, quantity);
      if (quantity > 0 && independent < 1) independent = 1;
      const devices = { ...room.devices, [category]: { quantity, independent } };
      return {
        ...room,
        devices,
        fanSpeedControl: Math.min(room.fanSpeedControl, devices.fans.independent),
      };
    }),
  };
}

/** Sets how many devices of one kind are switched separately (1 … quantity). */
export function setDeviceIndependent(
  draft: PlannerDraft,
  roomId: string,
  category: PlannerDeviceCategory,
  value: number
): PlannerDraft {
  if (!isLoadCategory(category)) return draft;
  return {
    ...draft,
    rooms: draft.rooms.map((room) => {
      if (room.id !== roomId) return room;
      const quantity = room.devices[category].quantity;
      const independent = quantity === 0 ? 0 : Math.max(1, clampCount(value, quantity));
      const devices = { ...room.devices, [category]: { quantity, independent } };
      return {
        ...room,
        devices,
        fanSpeedControl: Math.min(room.fanSpeedControl, devices.fans.independent),
      };
    }),
  };
}

export function setFanSpeedControl(draft: PlannerDraft, roomId: string, value: number): PlannerDraft {
  return {
    ...draft,
    rooms: draft.rooms.map((room) =>
      room.id === roomId
        ? { ...room, fanSpeedControl: clampCount(value, room.devices.fans.independent) }
        : room
    ),
  };
}

export function setFloors(draft: PlannerDraft, value: number): PlannerDraft {
  const floors = Math.max(1, clampCount(value, PLANNER_INPUT_LIMITS.maxFloors));
  return {
    ...draft,
    floors,
    rooms: draft.rooms.map((room) => ({ ...room, floor: Math.min(room.floor, floors) })),
    locations: draft.locations.map((location) => ({
      ...location,
      floor: location.floor === null ? null : Math.min(location.floor, floors),
    })),
  };
}

export function canAddLocation(draft: PlannerDraft): boolean {
  return draft.locations.length < PLANNER_INPUT_LIMITS.maxControllerLocations;
}

export function addLocation(draft: PlannerDraft): PlannerDraft {
  if (!canAddLocation(draft)) return draft;
  const location: PlannerDraftLocation = {
    id: nextId(
      "location",
      draft.locations.map((l) => l.id)
    ),
    name: uniqueName(
      `Controller location ${draft.locations.length + 1}`,
      draft.locations.map((l) => l.name)
    ),
    floor: null,
  };
  return { ...draft, locations: [...draft.locations, location] };
}

export function updateLocation(
  draft: PlannerDraft,
  locationId: string,
  changes: Partial<Pick<PlannerDraftLocation, "name" | "floor">>
): PlannerDraft {
  return {
    ...draft,
    locations: draft.locations.map((location) =>
      location.id === locationId ? { ...location, ...changes } : location
    ),
  };
}

export function removeLocation(draft: PlannerDraft, locationId: string): PlannerDraft {
  return {
    ...draft,
    locations: draft.locations.filter((location) => location.id !== locationId),
    rooms: draft.rooms.map((room) =>
      room.locationId === locationId ? { ...room, locationId: null } : room
    ),
  };
}

export function roomDeviceTotal(room: PlannerDraftRoom): number {
  let total = 0;
  for (const category of PLANNER_DEVICE_CATEGORIES) total += room.devices[category].quantity;
  return total;
}

/** The request body the Worker analyzes. */
export function draftToRequirements(draft: PlannerDraft): PlannerRequirementsInput {
  return {
    home: {
      floors: draft.floors,
      rooms: draft.rooms.map((room) => {
        const devices: Partial<Record<PlannerDeviceCategory, PlannerDraftDeviceCount>> = {};
        for (const category of PLANNER_DEVICE_CATEGORIES) {
          const count = room.devices[category];
          if (count.quantity > 0) {
            devices[category] = { quantity: count.quantity, independent: count.independent };
          }
        }
        return {
          id: room.id,
          name: room.name.trim(),
          floor: room.floor,
          locationId: room.locationId,
          devices,
          fanSpeedControl: room.fanSpeedControl,
        };
      }),
      controllerLocations: draft.locations.map((location) => ({
        id: location.id,
        name: location.name.trim(),
        floor: location.floor,
      })),
    },
    installation: {
      wifi: draft.wifi,
      ethernet: draft.ethernet,
      environment: draft.environment,
      maxCableRunMeters: draft.maxCableRunMeters,
      sensorWiring: draft.sensorWiring,
      allowAdditionalControllers: draft.allowAdditionalControllers,
      allowExternalRelayModules: draft.allowExternalRelayModules,
      futureOutputs: draft.futureOutputs,
      futureInputs: draft.futureInputs,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rebuilds wizard state from saved or restored requirements. Everything passes
 * through the shared normalizer, so out-of-range or unknown values are dropped.
 */
export function requirementsToDraft(input: unknown): PlannerDraft {
  const normalized = normalizePlannerRequirements(input);
  const raw = isRecord(input) ? input : {};
  const rawHome = isRecord(raw.home) ? raw.home : {};
  const rawInstallation = isRecord(raw.installation) ? raw.installation : {};

  // The normalizer always reports one location. Only keep the ones the customer named.
  const hadLocations =
    Array.isArray(rawHome.controllerLocations) && rawHome.controllerLocations.length > 0;
  const locations: PlannerDraftLocation[] = hadLocations
    ? normalized.locations.map((l) => ({ id: l.id, name: l.name, floor: l.floor }))
    : [];
  const locationIds = new Set(locations.map((l) => l.id));
  const defaultLocationId = locations[0]?.id ?? null;

  // The normalizer plans "not sure" as wired sensors; keep the customer's own answer.
  const wiringAnswer = PLANNER_SENSOR_WIRING_OPTIONS.find(
    (option) => option === rawInstallation.sensorWiring
  );

  return {
    floors: normalized.floors,
    rooms: normalized.rooms.map((room) => {
      const devices = emptyDeviceCounts();
      for (const category of PLANNER_DEVICE_CATEGORIES) {
        devices[category] = { ...room.devices[category] };
      }
      return {
        id: room.id,
        name: room.name,
        floor: room.floor,
        locationId:
          locationIds.has(room.locationId) && room.locationId !== defaultLocationId
            ? room.locationId
            : null,
        devices,
        fanSpeedControl: room.fanSpeedControl,
      };
    }),
    locations,
    wifi: normalized.installation.wifi,
    ethernet: normalized.installation.ethernet,
    environment: normalized.installation.environment,
    maxCableRunMeters: normalized.installation.maxCableRunMeters,
    sensorWiring: wiringAnswer ?? null,
    allowAdditionalControllers: normalized.installation.allowAdditionalControllers,
    allowExternalRelayModules: normalized.installation.allowExternalRelayModules,
    futureOutputs: normalized.installation.futureOutputs,
    futureInputs: normalized.installation.futureInputs,
  };
}

// ---------------------------------------------------------------------------
// Unsaved-draft persistence (per browser tab, per account)
// ---------------------------------------------------------------------------

const DRAFT_STORAGE_PREFIX = "homecoreos:planner-draft:";

/** The saved plan the answers in the wizard belong to. */
export interface PlannerPlanLink {
  id: string;
  name: string;
  /** Fingerprint of the answers as they are stored in the saved plan. */
  savedKey: string;
}

export interface StoredPlannerDraft {
  draft: PlannerDraft;
  step: number;
  /** Set when the answers were opened from, or saved as, a saved plan. */
  plan: PlannerPlanLink | null;
}

function draftStorageKey(scope: string): string {
  return `${DRAFT_STORAGE_PREFIX}${scope || "default"}`;
}

function readPlanLink(value: unknown): PlannerPlanLink | null {
  if (!isRecord(value)) return null;
  const { id, name, savedKey } = value;
  if (typeof id !== "string" || typeof name !== "string" || typeof savedKey !== "string") {
    return null;
  }
  return id && name && savedKey ? { id, name, savedKey } : null;
}

export function loadStoredDraft(scope: string): StoredPlannerDraft | null {
  try {
    const text = window.sessionStorage.getItem(draftStorageKey(scope));
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !isRecord(parsed.requirements)) return null;
    const step = Number(parsed.step);
    return {
      draft: requirementsToDraft(parsed.requirements),
      step: Number.isInteger(step) && step >= 1 && step <= 4 ? step : 1,
      plan: readPlanLink(parsed.plan),
    };
  } catch {
    return null;
  }
}

/**
 * Stores the answers in the wizard, with the saved plan they belong to, or
 * forgets them once the wizard is empty again.
 */
export function storeDraft(
  scope: string,
  draft: PlannerDraft,
  step: number,
  plan: PlannerPlanLink | null = null
): void {
  try {
    const requirements = draftToRequirements(draft);
    const isEmpty =
      JSON.stringify(requirements) === JSON.stringify(draftToRequirements(createEmptyDraft()));
    if (isEmpty) {
      window.sessionStorage.removeItem(draftStorageKey(scope));
      return;
    }
    window.sessionStorage.setItem(
      draftStorageKey(scope),
      JSON.stringify(plan ? { requirements, step, plan } : { requirements, step })
    );
  } catch {
    // Storage can be unavailable (private mode, quota). The wizard still works.
  }
}
