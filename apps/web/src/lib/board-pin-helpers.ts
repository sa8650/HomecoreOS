import {
  buildGpioPinSelectorModel,
  requiredPinCapabilityForDevice,
  requiredPinCapabilityForSensor,
  type GpioPinEntityKind,
  type GpioPinSelectorEntry,
  type GpioPinSelectorModel,
  type GpioPinUsage,
  type PinOperationRequirement,
  type SupportedDeviceType,
  type SupportedSensorType,
} from "@homecoreos/shared";
import { cachedGet } from "@/lib/api";
import type {
  BoardProfileItem,
  ControllerItem,
  DeviceItem,
  RoomItem,
  SensorItem,
  SwitchItem,
} from "@/features/types";

export interface HardwareContext {
  controllers: ControllerItem[];
  rooms: RoomItem[];
  boardsById: Map<string, BoardProfileItem>;
  usedPinsByController?: Map<
    string,
    Array<{ pin: number; entityKind: "switch" | "device" | "sensor"; id: string; name: string }>
  >;
}

export async function fetchBasicHardwareContext(options?: {
  force?: boolean;
}): Promise<{ controllers: ControllerItem[]; rooms: RoomItem[] }> {
  const force = options?.force ?? false;
  const [ctrlRes, roomRes] = await Promise.all([
    cachedGet<{ controllers: ControllerItem[] }>("/api/controllers", {
      ttlMs: 15_000,
      force,
    }),
    cachedGet<{ rooms: RoomItem[] }>("/api/homes/rooms", {
      ttlMs: 20_000,
      force,
    }),
  ]);
  return {
    controllers: ctrlRes.controllers,
    rooms: roomRes.rooms,
  };
}

export async function fetchHardwareContext(
  includeAssignedPins = true,
  options?: { force?: boolean }
): Promise<HardwareContext> {
  const force = options?.force ?? false;
  const [ctrlRes, roomRes, catRes, myRes, swRes, devRes, senRes] =
    await Promise.all([
      cachedGet<{ controllers: ControllerItem[] }>("/api/controllers", {
        ttlMs: 15_000,
        force,
      }),
      cachedGet<{ rooms: RoomItem[] }>("/api/homes/rooms", {
        ttlMs: 20_000,
        force,
      }),
      cachedGet<{ boards: BoardProfileItem[] }>("/api/boards/catalog", {
        ttlMs: 60_000,
        force,
      }),
      cachedGet<{
        catalogBoards: BoardProfileItem[];
        customBoards: BoardProfileItem[];
      }>("/api/boards/my-boards", {
        ttlMs: 60_000,
        force,
      }),
      includeAssignedPins
        ? cachedGet<{ switches: SwitchItem[] }>("/api/switches", {
            ttlMs: 12_000,
            force,
          }).catch(() => ({ switches: [] as SwitchItem[] }))
        : Promise.resolve({ switches: [] as SwitchItem[] }),
      includeAssignedPins
        ? cachedGet<{ devices: DeviceItem[] }>("/api/devices", {
            ttlMs: 12_000,
            force,
          }).catch(() => ({ devices: [] as DeviceItem[] }))
        : Promise.resolve({ devices: [] as DeviceItem[] }),
      includeAssignedPins
        ? cachedGet<{ sensors: SensorItem[] }>("/api/sensors", {
            ttlMs: 12_000,
            force,
          }).catch(() => ({ sensors: [] as SensorItem[] }))
        : Promise.resolve({ sensors: [] as SensorItem[] }),
    ]);

  const boardsById = new Map<string, BoardProfileItem>();
  for (const b of [
    ...catRes.boards,
    ...myRes.catalogBoards,
    ...myRes.customBoards,
  ]) {
    boardsById.set(b.id, b);
  }

  const usedPinsByController = new Map<
    string,
    Array<{ pin: number; entityKind: "switch" | "device" | "sensor"; id: string; name: string }>
  >();

  const pushUsed = (
    controllerId: string,
    pin: number | null,
    entityKind: "switch" | "device" | "sensor",
    id: string,
    name: string
  ) => {
    if (pin === null || !Number.isFinite(pin)) return;
    const list = usedPinsByController.get(controllerId) ?? [];
    list.push({ pin, entityKind, id, name });
    usedPinsByController.set(controllerId, list);
  };

  for (const s of swRes.switches) pushUsed(s.controller_id, s.gpio_pin, "switch", s.id, s.name);
  for (const d of devRes.devices) pushUsed(d.controller_id, d.gpio_pin, "device", d.id, d.name);
  for (const sen of senRes.sensors)
    pushUsed(sen.controller_id, sen.gpio_pin, "sensor", sen.id, sen.name);

  return {
    controllers: ctrlRes.controllers,
    rooms: roomRes.rooms,
    boardsById,
    usedPinsByController,
  };
}

/** The board profile a controller runs on, when the library knows it. */
export function resolveControllerBoard(
  controller: ControllerItem | undefined,
  boardsById: Map<string, BoardProfileItem>
): BoardProfileItem | undefined {
  const boardId = controller?.board_catalog_id ?? controller?.custom_board_id;
  return boardId ? boardsById.get(boardId) : undefined;
}

/** The pin map of one controller for one device / switch / sensor type. */
export interface PinMap {
  /** The controller's board, or undefined when the library does not know it. */
  board: BoardProfileItem | undefined;
  /** Every pin of that board with its state; null without a pin map. */
  model: GpioPinSelectorModel | null;
  /** Devices, switches and sensors that already hold a pin on the controller. */
  usedPins: GpioPinUsage[];
  /** The entity being edited. Its own pin is not a conflict. */
  editing: { entityKind: GpioPinEntityKind; id: string } | null;
}

export interface PinSelection extends PinMap {
  /** The entry of the pin that is currently entered, if it exists on the board. */
  entry: GpioPinSelectorEntry | null;
  /** True when the entered pin must not be saved. */
  blocked: boolean;
  /** Why it is blocked, or what to keep in mind. */
  reason?: string;
}

/**
 * Builds the pin map the GPIO selector draws. The rules come from the shared
 * pin policy, which the API enforces as well.
 */
export function resolvePinMap(params: {
  controller: ControllerItem | undefined;
  boardsById: Map<string, BoardProfileItem>;
  requirement: PinOperationRequirement;
  usedPinsByController?: HardwareContext["usedPinsByController"];
  excludeEntity?: { kind: GpioPinEntityKind; id: string };
}): PinMap {
  const { controller, boardsById, requirement, usedPinsByController, excludeEntity } = params;
  const board = resolveControllerBoard(controller, boardsById);
  const usedPins: GpioPinUsage[] = controller ? (usedPinsByController?.get(controller.id) ?? []) : [];
  const editing = excludeEntity ? { entityKind: excludeEntity.kind, id: excludeEntity.id } : null;
  const model =
    board && board.gpio_definitions.length > 0
      ? buildGpioPinSelectorModel({ board, requirement, usedPins, editing })
      : null;
  return { board, model, usedPins, editing };
}

/** The verdict for the pin that is entered in the field. */
export function resolvePinChoice(map: PinMap, pinNum: number | null): PinSelection {
  if (pinNum === null) {
    return { ...map, entry: null, blocked: false };
  }
  if (!Number.isInteger(pinNum) || pinNum < 0) {
    return { ...map, entry: null, blocked: true, reason: "Enter a whole GPIO number." };
  }

  if (!map.model) {
    // Without a pin map only a conflict on the same controller can be detected.
    const conflict = map.usedPins.find(
      (u) =>
        u.pin === pinNum &&
        !(map.editing && u.entityKind === map.editing.entityKind && u.id === map.editing.id)
    );
    return {
      ...map,
      entry: null,
      blocked: Boolean(conflict),
      reason: conflict
        ? `GPIO ${pinNum} is already assigned to ${conflict.entityKind} "${conflict.name}" on this controller.`
        : undefined,
    };
  }

  const entry = map.model.entries.find((e) => e.pin === pinNum) ?? null;
  if (!entry) {
    return {
      ...map,
      entry,
      blocked: true,
      reason: `GPIO ${pinNum} does not exist on ${map.board?.model ?? "this board"}.`,
    };
  }
  return { ...map, entry, blocked: !entry.selectable, reason: entry.explanation ?? undefined };
}

export function resolvePinSelection(params: {
  controller: ControllerItem | undefined;
  boardsById: Map<string, BoardProfileItem>;
  pinNum: number | null;
  requirement: PinOperationRequirement;
  usedPinsByController?: HardwareContext["usedPinsByController"];
  excludeEntity?: { kind: GpioPinEntityKind; id: string };
}): PinSelection {
  return resolvePinChoice(resolvePinMap(params), params.pinNum);
}

/**
 * The pin a new device, switch or sensor starts with: the best suggestion.
 * An I2C sensor starts on the board's own SDA pad, or on no pin at all (the
 * default bus) when that pad is unknown or taken.
 */
export function suggestedDefaultPin(
  model: GpioPinSelectorModel | null,
  requirement: PinOperationRequirement
): number | null {
  const first = model?.suggestions[0];
  if (model === null || first === undefined) return null;
  if (requirement === "i2c") {
    const entry = model.entries.find((e) => e.pin === first);
    return entry?.roles.includes("SDA") ? first : null;
  }
  return first;
}

export function getPinHint(params: {
  controller: ControllerItem | undefined;
  boardsById: Map<string, BoardProfileItem>;
  pinNum: number | null;
  requirement?: PinOperationRequirement;
  usedPinsByController?: HardwareContext["usedPinsByController"];
  excludeEntity?: { kind: "switch" | "device" | "sensor"; id: string };
}): { label: string; blocked: boolean; reason?: string } {
  if (params.pinNum === null || !Number.isFinite(params.pinNum)) {
    return { label: "I2C / Bus", blocked: false };
  }
  const selection = resolvePinSelection({
    ...params,
    requirement: params.requirement ?? "digital_in",
  });
  return {
    label: selection.entry?.label ?? `GPIO${params.pinNum}`,
    blocked: selection.blocked,
    reason: selection.reason,
  };
}

export function getRequirementForDeviceType(deviceType: string): PinOperationRequirement {
  return requiredPinCapabilityForDevice(deviceType as SupportedDeviceType);
}

export function getRequirementForSensorType(sensorType: string): PinOperationRequirement {
  return requiredPinCapabilityForSensor(sensorType as SupportedSensorType);
}

export function isControllerOnline(
  ctrl: Pick<ControllerItem, "status" | "mqtt_connected"> | undefined
): boolean {
  if (!ctrl) return true;
  if (ctrl.status === "offline" || ctrl.status === "disconnected") return false;
  return true;
}

export function isEntityOnline(
  entityOnline: boolean,
  ctrl: Pick<ControllerItem, "status" | "mqtt_connected"> | undefined
): boolean {
  if (!isControllerOnline(ctrl)) return false;
  return entityOnline;
}
