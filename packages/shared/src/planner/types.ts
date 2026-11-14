/**
 * Smart Home Planner — shared type contracts.
 *
 * The planner is a deterministic rule engine. It never invents hardware facts:
 * every board, pin, firmware release and artifact it reasons about comes from the
 * records administrators already manage through the Board Library and Firmware
 * Management pages. Anything those records do not document is reported as
 * "unknown" / "not documented" instead of being assumed.
 */
import type { PinOperationRequirement } from "../board-validation";
import type {
  BoardCatalogCategory,
  BoardFirmwareStatus,
  BoardLayoutSpec,
  BoardVerificationStatus,
  GpioPinDefinition,
  RoomType,
} from "../index";

/** Bump when rule changes must invalidate every cached recommendation. */
export const PLANNER_ENGINE_VERSION = 1;
export const PLANNER_REQUIREMENTS_SCHEMA_VERSION = 1;

/**
 * Mirrors HOMECORE_MAX_IO_ITEMS in firmware/main/homecore_config.h: one controller
 * can bind at most this many switches + devices + sensors, whatever the pin count.
 */
export const PLANNER_FIRMWARE_MAX_IO_ITEMS = 32;

/** A BME280-class sensor only offers two I2C addresses, so one bus carries two. */
export const PLANNER_I2C_CLIMATE_SENSORS_PER_BUS = 2;

export const PLANNER_INPUT_LIMITS = {
  maxFloors: 12,
  maxRooms: 40,
  maxControllerLocations: 20,
  maxQuantityPerCategory: 64,
  maxNameLength: 60,
  maxFutureChannels: 64,
  maxCableRunMeters: 500,
  /** Upper bound on controller connections in one plan; keeps analysis time bounded. */
  maxTotalChannels: 600,
} as const;

// ---------------------------------------------------------------------------
// Customer requirements
// ---------------------------------------------------------------------------

export const PLANNER_LOAD_CATEGORIES = [
  "lights",
  "fans",
  "switches",
  "curtains",
  "pumps",
  "appliances",
] as const;

export const PLANNER_SENSOR_CATEGORIES = [
  "motion_sensors",
  "climate_sensors",
  "contact_sensors",
  "gas_smoke_sensors",
  "leak_sensors",
] as const;

export const PLANNER_DEVICE_CATEGORIES = [
  ...PLANNER_LOAD_CATEGORIES,
  ...PLANNER_SENSOR_CATEGORIES,
] as const;

export type PlannerLoadCategory = (typeof PLANNER_LOAD_CATEGORIES)[number];
export type PlannerSensorCategory = (typeof PLANNER_SENSOR_CATEGORIES)[number];
export type PlannerDeviceCategory = (typeof PLANNER_DEVICE_CATEGORIES)[number];

export interface PlannerCategoryMeta {
  label: string;
  singular: string;
  plural: string;
  group: "load" | "sensor";
  /** Plain-language explanation shown to customers. */
  hint: string;
}

export const PLANNER_CATEGORY_META: Record<PlannerDeviceCategory, PlannerCategoryMeta> = {
  lights: {
    label: "Lights",
    singular: "light",
    plural: "lights",
    group: "load",
    hint: "Ceiling lights, lamps and light circuits you want to switch.",
  },
  fans: {
    label: "Fans",
    singular: "fan",
    plural: "fans",
    group: "load",
    hint: "Ceiling, wall or exhaust fans.",
  },
  switches: {
    label: "Switches & sockets",
    singular: "switch",
    plural: "switches",
    group: "load",
    hint: "Wall sockets or any other circuit you simply want to turn on and off.",
  },
  curtains: {
    label: "Curtains & blinds",
    singular: "curtain",
    plural: "curtains",
    group: "load",
    hint: "Motorized curtains, blinds or shutters.",
  },
  pumps: {
    label: "Pumps",
    singular: "pump",
    plural: "pumps",
    group: "load",
    hint: "Water pumps and other motors.",
  },
  appliances: {
    label: "Other appliances",
    singular: "appliance",
    plural: "appliances",
    group: "load",
    hint: "Water heaters, air conditioners and anything else switched on and off.",
  },
  motion_sensors: {
    label: "Motion sensors",
    singular: "motion sensor",
    plural: "motion sensors",
    group: "sensor",
    hint: "Detect movement to switch lights or raise alerts.",
  },
  climate_sensors: {
    label: "Temperature & humidity",
    singular: "temperature and humidity sensor",
    plural: "temperature and humidity sensors",
    group: "sensor",
    hint: "Measure room temperature and humidity.",
  },
  contact_sensors: {
    label: "Door & window sensors",
    singular: "door or window sensor",
    plural: "door and window sensors",
    group: "sensor",
    hint: "Know when a door or window is open.",
  },
  gas_smoke_sensors: {
    label: "Gas & smoke sensors",
    singular: "gas or smoke sensor",
    plural: "gas and smoke sensors",
    group: "sensor",
    hint: "Monitor gas leaks or smoke levels.",
  },
  leak_sensors: {
    label: "Water-leak sensors",
    singular: "water-leak sensor",
    plural: "water-leak sensors",
    group: "sensor",
    hint: "Detect water on the floor near tanks, sinks or washing machines.",
  },
};

export type PlannerWifiAvailability = "strong" | "weak" | "none" | "unknown";
export type PlannerEthernetNeed = "not_needed" | "preferred" | "required";
export type PlannerEnvironment = "indoor_dry" | "electrical_panel" | "damp" | "outdoor";
export type PlannerSensorWiring = "direct" | "i2c_bus" | "wireless" | "rs485" | "unsure";

export const PLANNER_WIFI_OPTIONS: readonly PlannerWifiAvailability[] = [
  "strong",
  "weak",
  "none",
  "unknown",
];
export const PLANNER_ETHERNET_OPTIONS: readonly PlannerEthernetNeed[] = [
  "not_needed",
  "preferred",
  "required",
];
export const PLANNER_ENVIRONMENT_OPTIONS: readonly PlannerEnvironment[] = [
  "indoor_dry",
  "electrical_panel",
  "damp",
  "outdoor",
];
export const PLANNER_SENSOR_WIRING_OPTIONS: readonly PlannerSensorWiring[] = [
  "direct",
  "i2c_bus",
  "wireless",
  "rs485",
  "unsure",
];

/** A physical device count plus how many of them must be controlled separately. */
export interface PlannerDeviceCountInput {
  /** Physical devices (bulbs, fans, sensors …). */
  quantity?: number;
  /** Independent control channels. Six bulbs on two circuits = quantity 6, independent 2. */
  independent?: number;
}

export interface PlannerRoomInput {
  id?: string;
  name?: string;
  type?: string;
  floor?: number;
  locationId?: string | null;
  devices?: Partial<Record<PlannerDeviceCategory, PlannerDeviceCountInput>>;
  /** How many of this room's independently controlled fans need speed control. */
  fanSpeedControl?: number;
}

export interface PlannerControllerLocationInput {
  id?: string;
  name?: string;
  floor?: number | null;
}

export interface PlannerInstallationInput {
  wifi?: PlannerWifiAvailability | null;
  ethernet?: PlannerEthernetNeed | null;
  environment?: PlannerEnvironment | null;
  maxCableRunMeters?: number | null;
  sensorWiring?: PlannerSensorWiring | null;
  allowAdditionalControllers?: boolean | null;
  allowExternalRelayModules?: boolean | null;
  futureOutputs?: number | null;
  futureInputs?: number | null;
}

/** Shape the customer-facing wizard submits. Every field is optional on purpose. */
export interface PlannerRequirementsInput {
  schemaVersion?: number;
  home?: {
    floors?: number;
    rooms?: PlannerRoomInput[];
    controllerLocations?: PlannerControllerLocationInput[];
  };
  installation?: PlannerInstallationInput;
}

export interface PlannerNormalizedDeviceCount {
  quantity: number;
  independent: number;
}

export interface PlannerNormalizedRoom {
  id: string;
  name: string;
  type: RoomType;
  floor: number;
  locationId: string;
  devices: Record<PlannerDeviceCategory, PlannerNormalizedDeviceCount>;
  fanSpeedControl: number;
  physicalDevices: number;
  controlChannels: number;
}

export interface PlannerNormalizedLocation {
  id: string;
  name: string;
  floor: number | null;
  roomIds: string[];
}

export interface PlannerNormalizedInstallation {
  /** null means the customer has not answered yet. */
  wifi: PlannerWifiAvailability | null;
  ethernet: PlannerEthernetNeed;
  environment: PlannerEnvironment | null;
  maxCableRunMeters: number | null;
  sensorWiring: PlannerSensorWiring;
  allowAdditionalControllers: boolean;
  allowExternalRelayModules: boolean;
  futureOutputs: number;
  futureInputs: number;
}

export interface PlannerMissingInformation {
  code: string;
  /** Wizard step the customer should revisit. */
  step: "home" | "devices" | "installation";
  message: string;
  /** Blocking gaps produce the INCOMPLETE result state. */
  blocking: boolean;
}

export type PlannerChannelKind =
  | "relay_output"
  | "pwm_output"
  | "digital_input"
  | "contact_input"
  | "analog_input"
  | "i2c_sensor";

/** How the customer would create this channel inside HomecoreOS afterwards. */
export interface PlannerHomecoreMapping {
  entity: "device" | "switch" | "sensor";
  /** Existing SUPPORTED_DEVICE_TYPES / SUPPORTED_SENSOR_TYPES value. */
  type: string;
  label: string;
}

/** One independently controlled signal that needs a controller connection. */
export interface PlannerChannel {
  id: string;
  roomId: string;
  roomName: string;
  locationId: string;
  floor: number;
  category: PlannerDeviceCategory;
  label: string;
  kind: PlannerChannelKind;
  /** Pin capability required by the existing GPIO validator; null for bus sensors. */
  requirement: PinOperationRequirement | null;
  requirePullUp: boolean;
  /** Physical devices switched/read through this channel. */
  physicalDevices: number;
  /** Channels sharing a group must stay on one controller (e.g. curtain open/close). */
  atomicGroup: string | null;
  homecore: PlannerHomecoreMapping;
  needsRelay: boolean;
  speedControl: boolean;
  /**
   * Set when the customer asked for a connection type HomecoreOS cannot read
   * (wireless or RS-485 sensors). Such channels are never given a pin.
   */
  unsupportedInterface: string | null;
}

export interface PlannerRequirementTotals {
  rooms: number;
  floors: number;
  controllerLocations: number;
  physicalDevices: number;
  /** Independently controlled things as the customer counts them. */
  controlChannels: number;
  /** Controller connections required (a curtain uses two). */
  gpioChannels: number;
  outputs: number;
  inputs: number;
  relayChannels: number;
  pwmChannels: number;
  analogChannels: number;
  i2cSensors: number;
  sensors: number;
  byCategory: Record<PlannerDeviceCategory, PlannerNormalizedDeviceCount>;
}

export interface PlannerNormalizedRequirements {
  schemaVersion: number;
  floors: number;
  rooms: PlannerNormalizedRoom[];
  locations: PlannerNormalizedLocation[];
  installation: PlannerNormalizedInstallation;
  channels: PlannerChannel[];
  totals: PlannerRequirementTotals;
  missing: PlannerMissingInformation[];
  /** Values the planner corrected or assumed, in plain language. */
  adjustments: string[];
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Catalog input (built server-side from admin-managed records)
// ---------------------------------------------------------------------------

export interface PlannerBoardRecord {
  id: string;
  /** "custom" = the account's own Custom Board Builder profile. */
  source: "catalog" | "custom";
  slug: string;
  manufacturer: string;
  model: string;
  revision: string;
  chip_family: string;
  chip_variant: string;
  flash_size_mb: number;
  psram_size_mb: number;
  /** Catalog publication flag (board_catalog.is_available). */
  is_available: boolean;
  verification_status: BoardVerificationStatus | null;
  firmware_status: BoardFirmwareStatus | "custom" | null;
  catalog_category?: BoardCatalogCategory | null;
  partition_scheme?: string | null;
  psram_mode?: string | null;
  flash_mode?: string | null;
  flash_freq?: string | null;
  bootloader_offset?: string | null;
  ota_app_offset?: string | null;
  boot_button_gpio?: number | null;
  usb_interface?: string | null;
  supports_wifi?: boolean | null;
  supports_ble?: boolean | null;
  supports_ble_wifi_provisioning?: boolean | null;
  supports_ota_rollback?: boolean | null;
  firmware_compat_key?: string | null;
  connectivity_note?: string | null;
  board_layout?: BoardLayoutSpec | null;
  docs_url?: string | null;
  gpio_definitions: GpioPinDefinition[];
  /**
   * Only set when the catalog holds a real price. The current schema has no
   * price column, so this stays null and no cost estimate is produced.
   */
  unit_price?: { amount: number; currency: string } | null;
  /**
   * Only set when real inventory data exists. The current schema tracks none,
   * so stock is always reported as unknown.
   */
  stock?: { status: "in_stock" | "out_of_stock"; quantity?: number | null } | null;
}

export interface PlannerFirmwareFileRecord {
  file_type: string;
  validated: boolean;
  flash_size?: string | null;
}

export interface PlannerFirmwareReleaseRecord {
  id: string;
  name: string;
  version: string;
  channel: string;
  chip_family: string;
  status: string;
  build_status: string | null;
  target_board_slug: string | null;
  compatible_board_ids: string[];
  compatible_board_slugs: string[];
  partition_scheme: string | null;
  psram_mode: string | null;
  flash_size_mb: number | null;
  hardware_verified: boolean;
  verified_board_ids: string[];
  verified_board_slugs: string[];
  ota_available: boolean;
  usb_available: boolean;
  published_at: string | null;
  /** Artifact rows WITHOUT storage keys. Private R2 keys never enter the planner. */
  files: PlannerFirmwareFileRecord[];
}

export interface PlannerAccountContext {
  existingControllers: number;
  existingDevices: number;
  /** platform_settings.max_controllers_per_account */
  maxControllers: number | null;
  /** platform_settings.max_devices_per_account */
  maxDevices: number | null;
}

export interface PlannerCatalogSnapshot {
  boards: PlannerBoardRecord[];
  releases: PlannerFirmwareReleaseRecord[];
  /** platform_settings.board_catalog_enabled */
  boardCatalogEnabled: boolean;
  account: PlannerAccountContext | null;
  /** Fingerprint of every record above; drives cache invalidation. */
  revision: string | null;
}

// ---------------------------------------------------------------------------
// Evaluation results
// ---------------------------------------------------------------------------

export type PlannerBoardStatusCode = "published" | "unpublished" | "unverified" | "unsupported";

export interface PlannerBoardStatus {
  code: PlannerBoardStatusCode;
  label: string;
  detail: string;
  isPublished: boolean;
  isVerified: boolean;
  isCustom: boolean;
}

export type PlannerPinTier = "free" | "shared" | "restricted" | "blocked";

export interface PlannerPinInfo {
  pin: number;
  label: string;
  boardPinName: string | null;
  tier: PlannerPinTier;
  /** Why the pin is shared / restricted / blocked. */
  reasons: string[];
  digitalOut: boolean;
  digitalIn: boolean;
  pwm: boolean;
  adc: boolean;
  i2c: boolean;
  spi: boolean;
  uart: boolean;
  pullUp: boolean;
  inputOnly: boolean;
}

export interface PlannerCapabilityCounts {
  /** Pins defined on the board. */
  total: number;
  /** Pins the planner will assign (free + shared). */
  usable: number;
  free: number;
  shared: number;
  /** Boot-strapping, USB and boot-button pins the planner holds back. */
  restricted: number;
  /** Reserved, flash/PSRAM or not broken out. */
  blocked: number;
  digitalOut: number;
  digitalIn: number;
  inputOnly: number;
  pwm: number;
  adc: number;
  i2c: number;
  spi: number;
  uart: number;
  pullUp: number;
}

export interface PlannerBoardCapability {
  boardId: string;
  status: PlannerBoardStatus;
  /** False when the record lacks a usable pin map; such boards are never assumed to fit. */
  evaluable: boolean;
  specIssues: string[];
  chipFamily: string;
  chipLabel: string;
  processor: string;
  wireless: string;
  memory: string;
  usb: string;
  supportsWifi: boolean;
  supportsBle: boolean;
  /** The catalog schema has no Ethernet field, so this is never assumed. */
  ethernet: "not_documented";
  connectivityNote: string | null;
  /** Supply rails printed on the documented headers, e.g. ["3.3V", "5V"]. */
  powerRails: string[];
  /** The catalog documents no current or power budget for any board. */
  currentLimitDocumented: false;
  /** The catalog documents no on-board relays for any board. */
  onboardRelayChannels: 0;
  maxIoItems: number;
  pins: PlannerPinInfo[];
  counts: PlannerCapabilityCounts;
  /** Assignable pins per requirement, in the order the allocator prefers them. */
  pinsFor: Record<PlannerPinDemand, number[]>;
}

/** Distinct pin demands the allocator matches against a board. */
export type PlannerPinDemand =
  | "digital_out"
  | "pwm"
  | "digital_in"
  | "contact_in"
  | "adc"
  | "i2c";

export interface PlannerPinAssignment {
  channelId: string;
  roomId: string;
  roomName: string;
  category: PlannerDeviceCategory;
  label: string;
  kind: PlannerChannelKind;
  /** null when the sensor sits on the shared I2C bus instead of its own pin. */
  pin: number | null;
  pinLabel: string;
  boardPinName: string | null;
  demand: PlannerPinDemand | "i2c_bus";
  physicalDevices: number;
  homecore: PlannerHomecoreMapping;
  needsRelay: boolean;
  notes: string[];
}

export interface PlannerSpareCapacity {
  /** Unassigned usable pins. */
  pins: number;
  /** How many more on/off outputs still fit. */
  outputs: number;
  /** How many more sensor inputs still fit. */
  inputs: number;
  /** Remaining firmware I/O slots. */
  ioItems: number;
}

export interface PlannerControllerRoomSummary {
  roomId: string;
  roomName: string;
  floor: number;
  channels: number;
  physicalDevices: number;
  byCategory: Partial<Record<PlannerDeviceCategory, number>>;
}

export interface PlannerControllerPlan {
  index: number;
  name: string;
  locationId: string;
  locationName: string;
  rooms: PlannerControllerRoomSummary[];
  assignments: PlannerPinAssignment[];
  i2cBus: { sda: number; scl: number; sensors: number } | null;
  ioItemsUsed: number;
  pinsUsed: number;
  relayChannels: number;
  spare: PlannerSpareCapacity;
}

export type PlannerUnallocatedReason =
  | "single_controller_limit"
  | "no_capable_pin"
  | "io_item_limit"
  | "board_not_evaluable"
  | "unsupported_interface";

export interface PlannerUnallocatedChannel {
  channelId: string;
  roomId: string;
  roomName: string;
  label: string;
  category: PlannerDeviceCategory;
  demand: PlannerPinDemand | "i2c_bus";
  reason: PlannerUnallocatedReason;
  detail: string;
}

/** Why channels spilled onto an extra controller or stayed unassigned. */
export interface PlannerAllocationPressure {
  gpioShortage: boolean;
  ioItemLimit: boolean;
  capabilityShortage: PlannerPinDemand[];
  /** True when held-back restricted pins would have been enough. */
  restrictedPinsWithheld: boolean;
  singleControllerLimit: boolean;
  i2cFallbackSensors: number;
}

export interface PlannerFutureCapacity {
  requestedOutputs: number;
  requestedInputs: number;
  accommodatedOutputs: number;
  accommodatedInputs: number;
  satisfied: boolean;
}

export interface PlannerAllocation {
  feasible: boolean;
  controllers: PlannerControllerPlan[];
  unallocated: PlannerUnallocatedChannel[];
  pressure: PlannerAllocationPressure;
  future: PlannerFutureCapacity;
  spare: PlannerSpareCapacity;
}

export type PlannerFirmwareState =
  | "published_available"
  | "compatible_release_found"
  | "build_pending"
  | "build_failed"
  | "deprecated"
  | "no_compatible_release";

export interface PlannerFirmwareReleaseSummary {
  /** Only present for published releases; drafts stay anonymous. */
  id: string | null;
  name: string | null;
  version: string;
  channel: string;
  publishedAt: string | null;
}

export interface PlannerFirmwareEvaluation {
  state: PlannerFirmwareState;
  label: string;
  detail: string;
  release: PlannerFirmwareReleaseSummary | null;
  published: boolean;
  /** A new board can be flashed through HomecoreOS: published + USB factory image. */
  installable: boolean;
  usbFactoryAvailable: boolean;
  otaAvailable: boolean;
  /** Release verified on this board, or the board is flagged firmware_supported. */
  validatedForBoard: boolean;
  releaseHardwareVerified: boolean;
  /** Technically compatible releases in any lifecycle state. */
  compatibleReleaseCount: number;
  /** Other lifecycle states found among compatible releases. */
  otherStates: PlannerFirmwareState[];
  notes: string[];
}

export interface PlannerInstallationStatus {
  usbFactory: { available: boolean; label: string; detail: string };
  ota: { available: boolean; label: string; detail: string };
}

export interface PlannerStockStatus {
  status: "unknown" | "in_stock" | "out_of_stock";
  label: string;
  detail: string;
}

export interface PlannerCostLine {
  label: string;
  quantity: number;
  unitAmount: number;
  subtotal: number;
}

export type PlannerCostEstimate =
  | { available: false; reason: string }
  | {
      available: true;
      currency: string;
      total: number;
      lines: PlannerCostLine[];
      excludes: string[];
    };

export interface PlannerAccountLimitCheck {
  kind: "controllers" | "devices";
  limit: number;
  existing: number;
  planned: number;
  exceeded: boolean;
}

export interface PlannerAvailability {
  catalog: { status: PlannerBoardStatusCode; label: string; detail: string };
  stock: PlannerStockStatus;
  cost: PlannerCostEstimate;
  accountLimits: PlannerAccountLimitCheck[];
}

export interface PlannerExternalHardwareItem {
  kind:
    | "relay_module"
    | "fan_speed_controller"
    | "curtain_controller"
    | "motor_contactor"
    | "power_supply"
    | "sensor_module"
    | "enclosure";
  label: string;
  quantity: number;
  unit: string;
  detail: string;
  required: boolean;
}

export type PlannerWarningSeverity = "critical" | "high" | "medium" | "low";

export type PlannerWarningCategory =
  | "electrical"
  | "hardware"
  | "firmware"
  | "connectivity"
  | "availability"
  | "information"
  | "expansion";

/** What the warning does to the plan, independent of how serious it sounds. */
export type PlannerWarningEffect =
  | "blocks_plan"
  | "blocks_installation"
  | "action_required"
  | "advisory";

export type PlannerWarningCode =
  | "insufficient_gpio_channels"
  | "restricted_pin_conflict"
  | "insufficient_io_capacity"
  | "missing_relay_hardware"
  | "unsupported_sensor_interface"
  | "insufficient_power_capacity"
  | "missing_expansion_modules"
  | "unsupported_connectivity"
  | "unverified_board_specs"
  | "no_compatible_firmware"
  | "firmware_not_published"
  | "missing_usb_artifact"
  | "missing_ota_artifact"
  | "incomplete_information"
  | "insufficient_future_capacity"
  | "board_not_published"
  | "board_unsupported"
  | "firmware_not_validated"
  | "stock_unknown"
  | "account_limit_exceeded"
  | "mains_safety"
  | "inductive_load"
  | "curtain_interlock"
  | "life_safety_sensor"
  | "installation_environment"
  | "long_cable_run"
  | "weak_wifi"
  | "speed_controller_required"
  | "no_boards_available";

export interface PlannerWarning {
  id: string;
  code: PlannerWarningCode;
  severity: PlannerWarningSeverity;
  category: PlannerWarningCategory;
  effect: PlannerWarningEffect;
  title: string;
  /** What the problem means, in plain language. */
  meaning: string;
  /** The customer requirement or catalog fact that caused it. */
  cause: string;
  impact: string;
  /** A practical way to resolve it. */
  resolution: string;
}

export type PlannerReadiness = "ready" | "partially_ready" | "not_supported";
export type PlannerResultState = PlannerReadiness | "incomplete";

export interface PlannerBoardSummary {
  id: string;
  source: "catalog" | "custom";
  /** Hidden for boards the Board Library does not show to customers. */
  slug: string | null;
  manufacturer: string;
  model: string;
  revision: string | null;
  chipLabel: string;
  chipVariant: string | null;
  memory: string | null;
  wireless: string | null;
  docsUrl: string | null;
}

export interface PlannerCandidatePlan {
  rank: number;
  board: PlannerBoardSummary;
  readiness: PlannerReadiness;
  /** True when the board can carry the whole plan as specified (readiness is not "not_supported"). */
  fits: boolean;
  /** Short form of the deciding reason, e.g. "Fits on 2 controllers". */
  fit: string;
  /** One sentence that explains `fit`. */
  fitDetail: string;
  /** "summary" hides pin-level data for boards customers cannot see in the library. */
  detailLevel: "full" | "summary";
  boardStatus: PlannerBoardStatus;
  firmware: PlannerFirmwareEvaluation;
  installation: PlannerInstallationStatus;
  availability: PlannerAvailability;
  controllerCount: number;
  controllers: PlannerControllerPlan[];
  unallocated: PlannerUnallocatedChannel[];
  capability: PlannerCapabilityCounts & {
    maxIoItems: number;
    powerRails: string[];
    supportsWifi: boolean;
    supportsBle: boolean;
    restrictedPins: Array<{ pin: number; label: string; reason: string }>;
  };
  externalHardware: PlannerExternalHardwareItem[];
  expansion: PlannerFutureCapacity & { spare: PlannerSpareCapacity };
  /** Why this plan ranks where it does. */
  reasons: string[];
  warnings: PlannerWarning[];
}

export interface PlannerEvaluatedBoard {
  boardId: string;
  manufacturer: string;
  model: string;
  chipLabel: string;
  source: "catalog" | "custom";
  boardStatus: PlannerBoardStatus;
  firmwareState: PlannerFirmwareState;
  firmwareLabel: string;
  usbFactoryAvailable: boolean;
  otaAvailable: boolean;
  /**
   * True when the board can carry the whole plan as specified. It may still be
   * waiting for firmware or publication; it is false exactly when the board's
   * readiness is "not_supported".
   */
  fits: boolean;
  /** Why it fits or does not, e.g. "Fits on 2 controllers" or "No Wi-Fi, …". */
  fit: string;
  /** Controllers needed; null when the board does not fit. */
  controllerCount: number | null;
  readiness: PlannerReadiness;
  rank: number;
  summary: string;
}

export type PlannerStageId =
  | "requirements"
  | "load_boards"
  | "load_firmware"
  | "board_capability"
  | "allocation"
  | "firmware_compatibility"
  | "availability"
  | "ranking"
  | "warnings";

export type PlannerStageStatus = "pending" | "running" | "completed" | "skipped" | "failed";

export interface PlannerStage {
  id: PlannerStageId;
  label: string;
  status: PlannerStageStatus;
  /** Real measured duration; null until the stage has finished. */
  durationMs: number | null;
  /** Real outcome of the stage, e.g. "11 boards evaluated". */
  detail: string | null;
}

export interface PlannerStageEvent {
  id: PlannerStageId;
  status: PlannerStageStatus;
  durationMs?: number | null;
  detail?: string | null;
}

export const PLANNER_STAGE_ORDER: readonly PlannerStageId[] = [
  "requirements",
  "load_boards",
  "load_firmware",
  "board_capability",
  "allocation",
  "firmware_compatibility",
  "availability",
  "ranking",
  "warnings",
];

export const PLANNER_STAGE_LABELS: Record<PlannerStageId, string> = {
  requirements: "Understanding your home",
  load_boards: "Reading the Board Library",
  load_firmware: "Reading firmware releases",
  board_capability: "Checking what each board can do",
  allocation: "Assigning devices to controllers and pins",
  firmware_compatibility: "Matching firmware to each board",
  availability: "Checking catalog availability",
  ranking: "Ranking the options",
  warnings: "Reviewing safety and readiness",
};

export interface PlannerResultStats {
  boardsEvaluated: number;
  /** Boards that can carry the whole plan as specified, whatever their firmware state. */
  boardsThatFit: number;
  firmwareReleasesEvaluated: number;
  publishedFirmwareReleases: number;
}

export interface PlannerResult {
  engineVersion: number;
  state: PlannerResultState;
  headline: string;
  summary: string;
  catalogRevision: string | null;
  requirements: {
    totals: PlannerRequirementTotals;
    rooms: Array<{
      id: string;
      name: string;
      type: RoomType;
      floor: number;
      locationId: string;
      physicalDevices: number;
      controlChannels: number;
    }>;
    locations: PlannerNormalizedLocation[];
    installation: PlannerNormalizedInstallation;
    adjustments: string[];
  };
  missingInformation: PlannerMissingInformation[];
  /** Ranked plans; the first is the recommendation, the rest are alternatives. */
  plans: PlannerCandidatePlan[];
  /** Every board the planner looked at, including the ones that did not qualify. */
  evaluatedBoards: PlannerEvaluatedBoard[];
  /** Warnings that apply whatever board is chosen. */
  warnings: PlannerWarning[];
  stats: PlannerResultStats;
  stages: PlannerStage[];
}
