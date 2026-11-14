import {
  requiredPinCapabilityForDevice,
  requiredPinCapabilityForSensor,
  type GpioPinDefinition,
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

export function getPinHint(params: {
  controller: ControllerItem | undefined;
  boardsById: Map<string, BoardProfileItem>;
  pinNum: number | null;
  requirement?: PinOperationRequirement;
  usedPinsByController?: HardwareContext["usedPinsByController"];
  excludeEntity?: { kind: "switch" | "device" | "sensor"; id: string };
}): { label: string; blocked: boolean; reason?: string } {
  const {
    controller,
    boardsById,
    pinNum,
    requirement,
    usedPinsByController,
    excludeEntity,
  } = params;

  if (pinNum === null || !Number.isFinite(pinNum)) {
    return { label: "I2C / Bus", blocked: false };
  }

  if (!controller) return { label: `GPIO${pinNum}`, blocked: false };

  const used = (usedPinsByController?.get(controller.id) ?? []).find(
    (entry) =>
      entry.pin === pinNum &&
      !(
        excludeEntity &&
        entry.entityKind === excludeEntity.kind &&
        entry.id === excludeEntity.id
      )
  );
  if (used) {
    return {
      label: `GPIO${pinNum}`,
      blocked: true,
      reason: `GPIO ${pinNum} is already assigned to ${used.entityKind} "${used.name}" on this controller.`,
    };
  }

  const boardId = controller.board_catalog_id ?? controller.custom_board_id;
  const board = boardId ? boardsById.get(boardId) : undefined;
  const def: GpioPinDefinition | undefined = board?.gpio_definitions.find(
    (g) => g.pin === pinNum
  );
  if (board && !def) {
    return {
      label: `GPIO${pinNum}`,
      blocked: true,
      reason: `GPIO ${pinNum} does not exist on ${board.model}.`,
    };
  }
  if (!def) {
    return { label: `GPIO${pinNum}`, blocked: false };
  }

  if (def.restrictions.reserved || def.restrictions.flash_psram_conflict) {
    return {
      label: def.label,
      blocked: true,
      reason: def.restrictions.reserved_reason ?? "Reserved internal Flash/PSRAM bus",
    };
  }

  if (
    (requirement === "digital_out" || requirement === "pwm") &&
    def.restrictions.input_only
  ) {
    return {
      label: def.label,
      blocked: true,
      reason: `GPIO ${pinNum} is input-only and cannot drive outputs.`,
    };
  }

  if (requirement && !def.capabilities[requirement]) {
    return {
      label: def.label,
      blocked: true,
      reason: `GPIO ${pinNum} does not support ${requirement.replace("_", " ")}.`,
    };
  }

  if (def.restrictions.usb_jtag_conflict) {
    return {
      label: def.label,
      blocked: false,
      reason: "Shared with USB/JTAG; may affect serial console when toggled.",
    };
  }

  if (def.restrictions.strapping_pin) {
    return {
      label: def.label,
      blocked: false,
      reason: `Boot strapping pin (${def.restrictions.strapping_note ?? "sampled on reset"})`,
    };
  }

  return { label: def.label, blocked: false };
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
