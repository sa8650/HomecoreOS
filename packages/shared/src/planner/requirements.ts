/**
 * Smart Home Planner — (1) requirement normalization.
 *
 * Turns whatever the wizard submits into one validated, clamped, fully-defaulted
 * structure, expands it into independent control channels, and reports which
 * answers are still missing. It never throws on bad input: a planner that
 * rejects half-finished answers cannot tell the customer what is missing.
 */
import {
  requiredPinCapabilityForDevice,
  requiredPinCapabilityForSensor,
  type PinOperationRequirement,
} from "../board-validation";
import {
  ROOM_TYPES,
  ROOM_TYPE_LABELS,
  inferRoomTypeFromName,
  type RoomType,
  type SupportedDeviceType,
  type SupportedSensorType,
} from "../index";
import {
  PLANNER_CATEGORY_META,
  PLANNER_DEVICE_CATEGORIES,
  PLANNER_ENVIRONMENT_OPTIONS,
  PLANNER_ETHERNET_OPTIONS,
  PLANNER_INPUT_LIMITS,
  PLANNER_LOAD_CATEGORIES,
  PLANNER_REQUIREMENTS_SCHEMA_VERSION,
  PLANNER_SENSOR_CATEGORIES,
  PLANNER_SENSOR_WIRING_OPTIONS,
  PLANNER_WIFI_OPTIONS,
  type PlannerChannel,
  type PlannerChannelKind,
  type PlannerDeviceCategory,
  type PlannerHomecoreMapping,
  type PlannerMissingInformation,
  type PlannerNormalizedDeviceCount,
  type PlannerNormalizedInstallation,
  type PlannerNormalizedLocation,
  type PlannerNormalizedRequirements,
  type PlannerNormalizedRoom,
  type PlannerRequirementTotals,
  type PlannerRequirementsInput,
  type PlannerSensorWiring,
} from "./types";

const DEFAULT_LOCATION_ID = "main";
const DEFAULT_LOCATION_NAME = "Main controller location";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toInt(value: unknown, min: number, max: number, fallback: number): number {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // Drop control characters; keep printable text in any language.
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(trimmed) ? trimmed : null;
}

function pickOption<T extends string>(value: unknown, options: readonly T[]): T | null {
  return typeof value === "string" && (options as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function uniqueId(preferred: string | null, fallback: string, taken: Set<string>): string {
  let id = preferred && !taken.has(preferred) ? preferred : fallback;
  let suffix = 2;
  while (taken.has(id)) {
    id = `${fallback}-${suffix}`;
    suffix += 1;
  }
  taken.add(id);
  return id;
}

function isRoomType(value: unknown): value is RoomType {
  return typeof value === "string" && (ROOM_TYPES as readonly string[]).includes(value);
}

function emptyDeviceCounts(): Record<PlannerDeviceCategory, PlannerNormalizedDeviceCount> {
  const out = {} as Record<PlannerDeviceCategory, PlannerNormalizedDeviceCount>;
  for (const category of PLANNER_DEVICE_CATEGORIES) {
    out[category] = { quantity: 0, independent: 0 };
  }
  return out;
}

function isSensorCategory(category: PlannerDeviceCategory): boolean {
  return (PLANNER_SENSOR_CATEGORIES as readonly string[]).includes(category);
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function capitalize(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** Spread `quantity` physical devices across `independent` channels as evenly as possible. */
function distribute(quantity: number, independent: number): number[] {
  if (independent <= 0) return [];
  const base = Math.floor(quantity / independent);
  const remainder = quantity % independent;
  return Array.from({ length: independent }, (_, i) => base + (i < remainder ? 1 : 0));
}

interface ChannelBlueprint {
  kind: PlannerChannelKind;
  requirement: PinOperationRequirement | null;
  requirePullUp: boolean;
  homecore: PlannerHomecoreMapping;
  needsRelay: boolean;
}

function deviceBlueprint(
  deviceType: SupportedDeviceType,
  label: string,
  kind: PlannerChannelKind
): ChannelBlueprint {
  return {
    kind,
    requirement: requiredPinCapabilityForDevice(deviceType),
    requirePullUp: false,
    homecore: { entity: "device", type: deviceType, label },
    needsRelay: kind === "relay_output",
  };
}

function sensorBlueprint(
  sensorType: SupportedSensorType,
  label: string,
  kind: PlannerChannelKind,
  requirePullUp: boolean
): ChannelBlueprint {
  return {
    kind,
    requirement: kind === "i2c_sensor" ? null : requiredPinCapabilityForSensor(sensorType),
    requirePullUp,
    homecore: { entity: "sensor", type: sensorType, label },
    needsRelay: false,
  };
}

/**
 * Maps a planner category onto the device / sensor types HomecoreOS already
 * supports, so pin requirements come from the existing GPIO validator rules.
 */
function blueprintFor(
  category: PlannerDeviceCategory,
  options: { speedControl: boolean; sensorWiring: PlannerSensorWiring }
): ChannelBlueprint {
  switch (category) {
    case "lights":
      return deviceBlueprint("light", "Device · Light", "relay_output");
    case "fans":
      return options.speedControl
        ? deviceBlueprint("dimmer_pwm", "Device · PWM dimmer (fan speed)", "pwm_output")
        : deviceBlueprint("fan", "Device · Fan", "relay_output");
    case "switches":
      return {
        kind: "relay_output",
        // The Switches API validates every switch pin as a plain digital output.
        requirement: "digital_out",
        requirePullUp: false,
        homecore: { entity: "switch", type: "switch", label: "Switch" },
        needsRelay: true,
      };
    case "curtains":
    case "pumps":
    case "appliances":
      return deviceBlueprint("relay", "Device · Relay", "relay_output");
    case "motion_sensors":
      return sensorBlueprint("motion_pir", "Sensor · Motion (PIR)", "digital_input", false);
    case "climate_sensors":
      return options.sensorWiring === "i2c_bus"
        ? sensorBlueprint(
            "temperature_bme280",
            "Sensor · Temperature & humidity (BME280, I2C)",
            "i2c_sensor",
            false
          )
        : sensorBlueprint(
            "temperature_dht22",
            "Sensor · Temperature & humidity (DHT22)",
            "digital_input",
            false
          );
    case "contact_sensors":
      return sensorBlueprint("contact_reed", "Sensor · Contact (reed switch)", "contact_input", true);
    case "gas_smoke_sensors":
      return sensorBlueprint(
        "analog_voltage",
        "Sensor · Analog voltage (gas / smoke level)",
        "analog_input",
        false
      );
    case "leak_sensors":
      return sensorBlueprint("contact_reed", "Sensor · Contact (leak probe)", "contact_input", true);
  }
}

/** HomecoreOS only reads sensors wired to a controller pin or its I2C bus. */
export function unsupportedSensorInterface(wiring: PlannerSensorWiring): string | null {
  if (wiring === "wireless") {
    return "Wireless sensors (Zigbee, Thread or Bluetooth) are not a sensor type HomecoreOS supports.";
  }
  if (wiring === "rs485") {
    return "RS-485 / Modbus sensors are not a sensor type HomecoreOS supports.";
  }
  return null;
}

function channelLabel(
  category: PlannerDeviceCategory,
  index: number,
  physicalDevices: number,
  grouped: boolean
): string {
  const meta = PLANNER_CATEGORY_META[category];
  const base = capitalize(meta.singular);
  if (grouped) {
    return `${base} group ${index} (${plural(physicalDevices, meta.singular, meta.plural)})`;
  }
  return `${base} ${index}`;
}

export function expandPlannerChannels(
  rooms: PlannerNormalizedRoom[],
  installation: PlannerNormalizedInstallation
): PlannerChannel[] {
  const channels: PlannerChannel[] = [];

  for (const room of rooms) {
    for (const category of PLANNER_DEVICE_CATEGORIES) {
      const count = room.devices[category];
      if (count.independent <= 0) continue;
      const shares = distribute(count.quantity, count.independent);
      const grouped = count.quantity > count.independent;

      for (let i = 0; i < count.independent; i++) {
        const index = i + 1;
        const physicalDevices = shares[i] ?? 1;
        const speedControl = category === "fans" && i < room.fanSpeedControl;
        const blueprint = blueprintFor(category, {
          speedControl,
          sensorWiring: installation.sensorWiring,
        });
        const baseLabel = channelLabel(category, index, physicalDevices, grouped);
        const common = {
          roomId: room.id,
          roomName: room.name,
          locationId: room.locationId,
          floor: room.floor,
          category,
          requirePullUp: blueprint.requirePullUp,
          homecore: blueprint.homecore,
          needsRelay: blueprint.needsRelay,
          unsupportedInterface: isSensorCategory(category)
            ? unsupportedSensorInterface(installation.sensorWiring)
            : null,
        };

        if (category === "curtains") {
          // A curtain motor has an open and a close winding: two outputs that
          // must live on the same controller so they can be interlocked.
          const group = `${room.id}:curtains:${index}`;
          channels.push({
            ...common,
            id: `${group}:open`,
            label: `${baseLabel} – open`,
            kind: blueprint.kind,
            requirement: blueprint.requirement,
            physicalDevices,
            atomicGroup: group,
            speedControl: false,
          });
          channels.push({
            ...common,
            id: `${group}:close`,
            label: `${baseLabel} – close`,
            kind: blueprint.kind,
            requirement: blueprint.requirement,
            physicalDevices: 0,
            atomicGroup: group,
            speedControl: false,
          });
          continue;
        }

        channels.push({
          ...common,
          id: `${room.id}:${category}:${index}`,
          label: speedControl ? `${baseLabel} (speed control)` : baseLabel,
          kind: blueprint.kind,
          requirement: blueprint.requirement,
          physicalDevices,
          atomicGroup: null,
          speedControl,
        });
      }
    }
  }

  return channels;
}

function computeTotals(
  floors: number,
  rooms: PlannerNormalizedRoom[],
  locations: PlannerNormalizedLocation[],
  channels: PlannerChannel[]
): PlannerRequirementTotals {
  const byCategory = emptyDeviceCounts();
  let physicalDevices = 0;
  let controlChannels = 0;

  for (const room of rooms) {
    for (const category of PLANNER_DEVICE_CATEGORIES) {
      byCategory[category].quantity += room.devices[category].quantity;
      byCategory[category].independent += room.devices[category].independent;
    }
    physicalDevices += room.physicalDevices;
    controlChannels += room.controlChannels;
  }

  const count = (kinds: PlannerChannelKind[]) =>
    channels.filter((c) => kinds.includes(c.kind)).length;

  return {
    rooms: rooms.length,
    floors,
    controllerLocations: locations.length,
    physicalDevices,
    controlChannels,
    gpioChannels: channels.length,
    outputs: count(["relay_output", "pwm_output"]),
    inputs: count(["digital_input", "contact_input", "analog_input", "i2c_sensor"]),
    relayChannels: channels.filter((c) => c.needsRelay).length,
    pwmChannels: count(["pwm_output"]),
    analogChannels: count(["analog_input"]),
    i2cSensors: count(["i2c_sensor"]),
    sensors: PLANNER_SENSOR_CATEGORIES.reduce((sum, c) => sum + byCategory[c].quantity, 0),
    byCategory,
  };
}

export function normalizePlannerRequirements(raw: unknown): PlannerNormalizedRequirements {
  const input = isRecord(raw) ? raw : {};
  const home = isRecord(input.home) ? input.home : {};
  const installIn = isRecord(input.installation) ? input.installation : {};
  const adjustments: string[] = [];
  const missing: PlannerMissingInformation[] = [];

  const floors = toInt(home.floors, 1, PLANNER_INPUT_LIMITS.maxFloors, 1);

  // --- Controller installation locations -----------------------------------
  const rawLocations = Array.isArray(home.controllerLocations) ? home.controllerLocations : [];
  if (rawLocations.length > PLANNER_INPUT_LIMITS.maxControllerLocations) {
    adjustments.push(
      `Only the first ${PLANNER_INPUT_LIMITS.maxControllerLocations} controller locations were used.`
    );
  }
  const takenLocationIds = new Set<string>();
  const locations: PlannerNormalizedLocation[] = rawLocations
    .slice(0, PLANNER_INPUT_LIMITS.maxControllerLocations)
    .filter(isRecord)
    .map((loc, i) => {
      const name =
        cleanText(loc.name, PLANNER_INPUT_LIMITS.maxNameLength) || `Controller location ${i + 1}`;
      const floorRaw = loc.floor;
      return {
        id: uniqueId(cleanId(loc.id), `location-${i + 1}`, takenLocationIds),
        name,
        floor:
          floorRaw === null || floorRaw === undefined ? null : toInt(floorRaw, 1, floors, 1),
        roomIds: [],
      };
    });

  // --- Rooms ----------------------------------------------------------------
  const rawRooms = Array.isArray(home.rooms) ? home.rooms : [];
  if (rawRooms.length > PLANNER_INPUT_LIMITS.maxRooms) {
    adjustments.push(`Only the first ${PLANNER_INPUT_LIMITS.maxRooms} rooms were used.`);
  }
  const takenRoomIds = new Set<string>();
  const rooms: PlannerNormalizedRoom[] = [];
  let usedDefaultLocation = false;

  rawRooms
    .slice(0, PLANNER_INPUT_LIMITS.maxRooms)
    .filter(isRecord)
    .forEach((room, i) => {
      const id = uniqueId(cleanId(room.id), `room-${i + 1}`, takenRoomIds);
      const givenName = cleanText(room.name, PLANNER_INPUT_LIMITS.maxNameLength);
      const name = givenName || `Room ${i + 1}`;
      if (!givenName) {
        missing.push({
          code: "room_unnamed",
          step: "home",
          message: `Room ${i + 1} has no name yet, so it is listed as "${name}".`,
          blocking: false,
        });
      }
      const type = isRoomType(room.type) ? room.type : inferRoomTypeFromName(name);

      const devicesIn = isRecord(room.devices) ? room.devices : {};
      const devices = emptyDeviceCounts();
      for (const category of PLANNER_DEVICE_CATEGORIES) {
        const entry = isRecord(devicesIn[category]) ? devicesIn[category] : {};
        const quantity = toInt(
          (entry as Record<string, unknown>).quantity,
          0,
          PLANNER_INPUT_LIMITS.maxQuantityPerCategory,
          0
        );
        let independent = quantity;
        if (!isSensorCategory(category)) {
          const requested = (entry as Record<string, unknown>).independent;
          independent =
            requested === undefined || requested === null
              ? quantity
              : toInt(requested, 0, quantity, quantity);
          // At least one channel is needed to control any physical device.
          if (quantity > 0 && independent < 1) independent = 1;
        }
        devices[category] = { quantity, independent };
      }

      const requestedSpeed = toInt(
        room.fanSpeedControl,
        0,
        PLANNER_INPUT_LIMITS.maxQuantityPerCategory,
        0
      );
      const fanSpeedControl = Math.min(requestedSpeed, devices.fans.independent);
      if (requestedSpeed > fanSpeedControl) {
        adjustments.push(
          `${name}: speed control was limited to ${fanSpeedControl} because only ${plural(
            devices.fans.independent,
            "fan is",
            "fans are"
          )} controlled separately.`
        );
      }

      let locationId = cleanId(room.locationId);
      if (!locationId || !locations.some((l) => l.id === locationId)) {
        locationId = locations[0]?.id ?? DEFAULT_LOCATION_ID;
        if (locations.length === 0) usedDefaultLocation = true;
      }

      let physicalDevices = 0;
      let controlChannels = 0;
      for (const category of PLANNER_DEVICE_CATEGORIES) {
        physicalDevices += devices[category].quantity;
        controlChannels += devices[category].independent;
      }

      rooms.push({
        id,
        name,
        type,
        floor: toInt(room.floor, 1, floors, 1),
        locationId,
        devices,
        fanSpeedControl,
        physicalDevices,
        controlChannels,
      });
    });

  if (locations.length === 0) {
    locations.push({
      id: DEFAULT_LOCATION_ID,
      name: DEFAULT_LOCATION_NAME,
      floor: null,
      roomIds: [],
    });
    if (rooms.length > 0 && usedDefaultLocation) {
      missing.push({
        code: "controller_location_assumed",
        step: "home",
        message:
          "No controller installation location was given, so one central location was assumed for every room.",
        blocking: false,
      });
    }
  }
  for (const room of rooms) {
    locations.find((l) => l.id === room.locationId)?.roomIds.push(room.id);
  }

  // --- Installation ---------------------------------------------------------
  const wifi = pickOption(installIn.wifi, PLANNER_WIFI_OPTIONS);
  const environment = pickOption(installIn.environment, PLANNER_ENVIRONMENT_OPTIONS);
  const sensorWiringAnswer = pickOption(installIn.sensorWiring, PLANNER_SENSOR_WIRING_OPTIONS);
  const cableRaw = installIn.maxCableRunMeters;
  const maxCableRunMeters =
    cableRaw === null || cableRaw === undefined || cableRaw === ""
      ? null
      : toInt(cableRaw, 0, PLANNER_INPUT_LIMITS.maxCableRunMeters, 0);

  const installation: PlannerNormalizedInstallation = {
    wifi,
    ethernet: pickOption(installIn.ethernet, PLANNER_ETHERNET_OPTIONS) ?? "not_needed",
    environment,
    maxCableRunMeters,
    // "Not sure" is planned as ordinary wired sensors, the only supported option.
    sensorWiring:
      sensorWiringAnswer === null || sensorWiringAnswer === "unsure" ? "direct" : sensorWiringAnswer,
    allowAdditionalControllers: installIn.allowAdditionalControllers !== false,
    allowExternalRelayModules: installIn.allowExternalRelayModules !== false,
    futureOutputs: toInt(installIn.futureOutputs, 0, PLANNER_INPUT_LIMITS.maxFutureChannels, 0),
    futureInputs: toInt(installIn.futureInputs, 0, PLANNER_INPUT_LIMITS.maxFutureChannels, 0),
  };

  const channels = expandPlannerChannels(rooms, installation);
  const totals = computeTotals(floors, rooms, locations, channels);

  // --- Completeness ---------------------------------------------------------
  if (rooms.length === 0) {
    missing.push({
      code: "no_rooms",
      step: "home",
      message: "Add at least one room so the planner knows where devices go.",
      blocking: true,
    });
  } else if (totals.gpioChannels === 0) {
    missing.push({
      code: "no_devices",
      step: "devices",
      message: "Add at least one light, appliance or sensor to control.",
      blocking: true,
    });
  }
  if (totals.gpioChannels > PLANNER_INPUT_LIMITS.maxTotalChannels) {
    missing.push({
      code: "plan_too_large",
      step: "devices",
      message: `This plan needs ${totals.gpioChannels} controller connections. One plan handles up to ${PLANNER_INPUT_LIMITS.maxTotalChannels}, so split a larger site into separate plans, for example one per building or floor.`,
      blocking: true,
    });
  }
  if (wifi === null) {
    missing.push({
      code: "wifi_unanswered",
      step: "installation",
      message:
        "Tell us whether Wi-Fi reaches the controller location. Controllers need it to connect to HomecoreOS.",
      blocking: true,
    });
  } else if (wifi === "unknown") {
    missing.push({
      code: "wifi_unknown",
      step: "installation",
      message:
        "Wi-Fi coverage at the controller location is not known yet. Check it before buying hardware.",
      blocking: false,
    });
  }
  if (environment === null) {
    missing.push({
      code: "environment_unanswered",
      step: "installation",
      message:
        "The installation environment was not selected, so enclosure advice cannot be tailored.",
      blocking: false,
    });
  }
  if (maxCableRunMeters === null && totals.sensors > 0) {
    missing.push({
      code: "cable_distance_unanswered",
      step: "installation",
      message:
        "The longest cable run to a sensor was not given, so cable-length limits could not be checked.",
      blocking: false,
    });
  }
  if (totals.sensors > 0 && (sensorWiringAnswer === null || sensorWiringAnswer === "unsure")) {
    missing.push({
      code: "sensor_wiring_assumed",
      step: "installation",
      message:
        "Sensor connection type was not chosen, so sensors were planned as wired directly to the controller.",
      blocking: false,
    });
  }

  return {
    schemaVersion: PLANNER_REQUIREMENTS_SCHEMA_VERSION,
    floors,
    rooms,
    locations,
    installation,
    channels,
    totals,
    missing,
    adjustments,
    complete: !missing.some((m) => m.blocking),
  };
}

/**
 * The canonical, storable form of a set of requirements. Saved plans persist
 * this instead of the raw request body so nothing unvalidated reaches the database.
 */
export function toPlannerRequirementsInput(
  normalized: PlannerNormalizedRequirements,
  original?: unknown
): PlannerRequirementsInput {
  const originalInstall =
    isRecord(original) && isRecord(original.installation) ? original.installation : {};
  // Preserve an explicit "not sure" so the wizard reopens with the customer's answer.
  const wiringAnswer = pickOption(originalInstall.sensorWiring, PLANNER_SENSOR_WIRING_OPTIONS);
  const hadLocations =
    isRecord(original) &&
    isRecord(original.home) &&
    Array.isArray(original.home.controllerLocations) &&
    original.home.controllerLocations.length > 0;

  return {
    schemaVersion: PLANNER_REQUIREMENTS_SCHEMA_VERSION,
    home: {
      floors: normalized.floors,
      rooms: normalized.rooms.map((room) => {
        const devices: Partial<Record<PlannerDeviceCategory, PlannerNormalizedDeviceCount>> = {};
        for (const category of PLANNER_DEVICE_CATEGORIES) {
          if (room.devices[category].quantity > 0) {
            devices[category] = { ...room.devices[category] };
          }
        }
        return {
          id: room.id,
          name: room.name,
          type: room.type,
          floor: room.floor,
          locationId: room.locationId,
          devices,
          fanSpeedControl: room.fanSpeedControl,
        };
      }),
      controllerLocations:
        hadLocations || original === undefined
          ? normalized.locations.map((l) => ({ id: l.id, name: l.name, floor: l.floor }))
          : [],
    },
    installation: {
      wifi: normalized.installation.wifi,
      ethernet: normalized.installation.ethernet,
      environment: normalized.installation.environment,
      maxCableRunMeters: normalized.installation.maxCableRunMeters,
      sensorWiring: original === undefined ? normalized.installation.sensorWiring : wiringAnswer,
      allowAdditionalControllers: normalized.installation.allowAdditionalControllers,
      allowExternalRelayModules: normalized.installation.allowExternalRelayModules,
      futureOutputs: normalized.installation.futureOutputs,
      futureInputs: normalized.installation.futureInputs,
    },
  };
}

export function describePlannerRoomType(type: RoomType): string {
  return ROOM_TYPE_LABELS[type] ?? "Room";
}

export function isPlannerLoadCategory(category: PlannerDeviceCategory): boolean {
  return (PLANNER_LOAD_CATEGORIES as readonly string[]).includes(category);
}
