import {
  buildGpioPinSelectorModel,
  canSensorsShareGpioPin,
  deriveBoardHardwareCapabilityProfile,
  getSensorDriverForMeasurement,
  requiredPinCapabilityForDevice,
  requiredPinCapabilityForSensor,
  type ControllerSensorCompatibilityReport,
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
    Array<{
      pin: number;
      entityKind: "switch" | "device" | "sensor";
      id: string;
      name: string;
      sensorType?: string;
    }>
  >;
  sensorCompatibilityByController?: Map<string, ControllerSensorCompatibilityReport>;
}

export async function fetchBasicHardwareContext(options?: {
  force?: boolean;
}): Promise<{ controllers: ControllerItem[]; rooms: RoomItem[] }> {
  const force = options?.force ?? false;
  const [ctrlRes, roomRes] = await Promise.all([
    cachedGet<{ controllers: ControllerItem[] }>("/api/board-instances", {
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
      cachedGet<{ controllers: ControllerItem[] }>("/api/board-instances", {
        ttlMs: 15_000,
        force,
      }),
      cachedGet<{ rooms: RoomItem[] }>("/api/homes/rooms", {
        ttlMs: 20_000,
        force,
      }),
      cachedGet<{ boards: BoardProfileItem[] }>("/api/board-library/catalog", {
        ttlMs: 60_000,
        force,
      }),
      cachedGet<{
        catalogBoards: BoardProfileItem[];
        customBoardProfiles: BoardProfileItem[];
      }>("/api/board-library/saved-profiles", {
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
    ...myRes.catalogBoards,
    ...catRes.boards,
    ...myRes.customBoardProfiles,
  ]) {
    boardsById.set(b.id, b);
  }

  const usedPinsByController = new Map<
    string,
    Array<{
      pin: number;
      entityKind: "switch" | "device" | "sensor";
      id: string;
      name: string;
      sensorType?: string;
    }>
  >();

  const pushUsed = (
    boardInstanceId: string,
    pin: number | null,
    entityKind: "switch" | "device" | "sensor",
    id: string,
    name: string,
    sensorType?: string
  ) => {
    if (pin === null || !Number.isFinite(pin)) return;
    const list = usedPinsByController.get(boardInstanceId) ?? [];
    list.push({ pin, entityKind, id, name, sensorType });
    usedPinsByController.set(boardInstanceId, list);
  };

  for (const s of swRes.switches) pushUsed(s.board_instance_id, s.gpio_pin, "switch", s.id, s.name);
  for (const d of devRes.devices) pushUsed(d.board_instance_id, d.gpio_pin, "device", d.id, d.name);
  for (const sen of senRes.sensors)
    pushUsed(sen.board_instance_id, sen.gpio_pin, "sensor", sen.id, sen.name, sen.sensor_type);

  const sensorCompatibilityByController = new Map<
    string,
    ControllerSensorCompatibilityReport
  >();
  for (const ctrl of ctrlRes.controllers) {
    if (ctrl.sensor_compatibility) {
      sensorCompatibilityByController.set(ctrl.id, ctrl.sensor_compatibility);
    }
  }

  return {
    controllers: ctrlRes.controllers,
    rooms: roomRes.rooms,
    boardsById,
    usedPinsByController,
    sensorCompatibilityByController,
  };
}

/** The board profile a controller runs on, when the library knows it. */
export function resolveControllerBoard(
  controller: ControllerItem | undefined,
  boardsById: Map<string, BoardProfileItem>
): BoardProfileItem | undefined {
  const boardId = controller?.board_profile_id ?? controller?.custom_board_profile_id;
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
  sensorType?: string;
}): PinMap {
  const {
    controller,
    boardsById,
    requirement,
    usedPinsByController,
    excludeEntity,
    sensorType,
  } = params;
  const board = resolveControllerBoard(controller, boardsById);
  const rawUsed = controller ? (usedPinsByController?.get(controller.id) ?? []) : [];

  const editing = excludeEntity ? { entityKind: excludeEntity.kind, id: excludeEntity.id } : null;
  const currentPin = editing
    ? rawUsed.find((u) => u.entityKind === editing.entityKind && u.id === editing.id)?.pin ?? null
    : null;

  // When configuring a sensor, allow sharing a GPIO pin with legally compatible
  // sibling sensors (e.g. DHT22 temp + humidity, shared I2C SDA, shared 1-Wire bus).
  const usedPins: GpioPinUsage[] = sensorType
    ? rawUsed.filter((u) => {
        if (u.entityKind !== "sensor" || !u.sensorType) return true;
        return !canSensorsShareGpioPin(sensorType, u.sensorType);
      })
    : rawUsed;

  let model =
    board && board.gpio_definitions.length > 0
      ? buildGpioPinSelectorModel({ board, requirement, usedPins, editing, currentPin })
      : null;

  // Apply driver-specific hardware constraints (bidirectional GPIO for DHT22/DS18B20
  // and onboard relay/buzzer output-only pins) so the UI picker agrees 100% with the API.
  if (model && board && sensorType) {
    const driver = getSensorDriverForMeasurement(sensorType);
    if (driver) {
      const capProfile = deriveBoardHardwareCapabilityProfile(board);
      const outputOnlyOnboard = new Set([
        ...capProfile.onboardPeripherals.relays,
        ...capProfile.onboardPeripherals.buzzers,
      ]);
      const defByPin = new Map(board.gpio_definitions.map((d) => [d.pin, d]));
      let changed = false;
      const entries = model.entries.map((entry) => {
        if (!entry.selectable) return entry;
        const def = defByPin.get(entry.pin);
        if (outputOnlyOnboard.has(entry.pin)) {
          changed = true;
          return {
            ...entry,
            state: "restricted" as const,
            selectable: false,
            suggestionRank: null,
            reasonTag: "ON-BOARD",
            explanation: `GPIO ${entry.pin} is hardwired to onboard output circuitry on ${board.model} and cannot be used for ${driver.displayName}.`,
          };
        }
        if (
          driver.requiresBidirectionalGpio &&
          def &&
          (def.restrictions.input_only || !def.capabilities.digital_out)
        ) {
          changed = true;
          return {
            ...entry,
            state: "restricted" as const,
            selectable: false,
            suggestionRank: null,
            reasonTag: "IN ONLY",
            explanation: `GPIO ${entry.pin} is input-only and cannot drive ${driver.displayName}, which requires bidirectional GPIO signaling.`,
          };
        }
        return entry;
      });
      if (changed) {
        const selectableSet = new Set(
          entries.filter((e) => e.selectable).map((e) => e.pin)
        );
        const suggestions = model.suggestions.filter((p) => selectableSet.has(p));
        const counts = { available: 0, used: 0, restricted: 0, dangerous: 0 };
        for (const e of entries) counts[e.state] += 1;
        model = {
          ...model,
          entries,
          suggestions,
          counts,
        };
      }
    }
  }

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
