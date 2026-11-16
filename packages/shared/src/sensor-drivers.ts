/**
 * Centralized Sensor Driver Registry, Board Hardware Capability Profiles,
 * and Firmware Driver Manifest Compatibility Engine.
 *
 * Pure declarations only (no import-time side effects) to preserve
 * `@homecoreos/shared` `"sideEffects": false` tree-shaking guarantees.
 */
import {
  resolveBoardFirmwareCompatibility,
  type PartitionScheme,
  type PsramMode,
} from "./board-firmware-compat";
import {
  validateGpioAssignment,
  type PinOperationRequirement,
} from "./board-validation";
import {
  SUPPORTED_CHIP_FAMILIES,
  SUPPORTED_SENSOR_TYPES,
  type BoardProfileSpec,
  type ChipFamily,
  type SupportedSensorType,
} from "./index";
import {
  collectBoardPinHardwareFacts,
  readBoardLayoutFacts,
} from "./planner/board-capability";

export const SENSOR_DRIVER_IDS = [
  "dht22",
  "ds18b20",
  "bme280",
  "pir",
  "reed",
  "bh1750",
  "adc_voltage",
] as const;

export type SensorDriverId = (typeof SENSOR_DRIVER_IDS)[number];

export type SensorInterfaceKind =
  | "gpio_digital_in"
  | "gpio_single_wire"
  | "onewire"
  | "i2c"
  | "adc";

export type SensorHardwareVerificationStatus =
  | "implemented_unverified"
  | "bench_verified"
  | "planned";

export interface SensorDriverBusConfig {
  kind: "gpio" | "onewire" | "i2c" | "adc";
  requiresPullUp?: boolean;
  supportsSharedBus: boolean;
  requiresTwoPins?: boolean;
  defaultAddresses?: readonly string[];
  defaultClockHz?: number;
  debounceMs?: number;
  minIntervalMs?: number;
  samplesPerRead?: number;
}

export interface SensorDriverDefinition {
  id: SensorDriverId;
  displayName: string;
  shortDescription: string;
  supportedModels: readonly string[];
  supportedChipFamilies: readonly ChipFamily[];
  interface: SensorInterfaceKind;
  interfaceLabel: string;
  requiredInterfaces: readonly ("gpio" | "single_wire" | "onewire" | "i2c" | "adc")[];
  requiredPinCapabilities: readonly PinOperationRequirement[];
  requiresBidirectionalGpio: boolean;
  busConfig: SensorDriverBusConfig;
  idfComponents: readonly string[];
  resourceEstimate: {
    flashBytes: number;
    ramBytes: number;
  };
  measurements: readonly SupportedSensorType[];
  defaultUnits: Readonly<Partial<Record<SupportedSensorType, string>>>;
  driverVersion: string;
  kconfigFlag: string;
  hardwareVerificationStatus: SensorHardwareVerificationStatus;
  allowSharedPinWithSameDriver: boolean;
  allowSharedI2cBus: boolean;
}

export interface SensorMeasurementDefinition {
  sensorType: SupportedSensorType;
  driverId: SensorDriverId;
  displayName: string;
  shortDescription: string;
  interfaceLabel: string;
  defaultUnit: string;
  valueKind: "numeric" | "boolean";
}

const ALL_SENSOR_CAPABLE_CHIPS: readonly ChipFamily[] = [
  "esp32",
  "esp32s2",
  "esp32s3",
  "esp32c2",
  "esp32c3",
  "esp32c5",
  "esp32c6",
  "esp32c61",
  "esp32h2",
  "esp32p4",
  "esp8266",
];

export const SENSOR_DRIVER_REGISTRY: readonly SensorDriverDefinition[] = [
  {
    id: "dht22",
    displayName: "DHT22 / AM2302",
    shortDescription: "Single-wire digital temperature and relative humidity sensor.",
    supportedModels: ["DHT22", "AM2302", "RHT03"],
    supportedChipFamilies: ALL_SENSOR_CAPABLE_CHIPS,
    interface: "gpio_single_wire",
    interfaceLabel: "GPIO (1-Pin Digital)",
    requiredInterfaces: ["gpio", "single_wire"],
    requiredPinCapabilities: ["digital_in", "digital_out"],
    requiresBidirectionalGpio: true,
    busConfig: {
      kind: "gpio",
      requiresPullUp: true,
      supportsSharedBus: false,
      minIntervalMs: 2000,
    },
    idfComponents: ["driver/gpio", "esp_timer", "rom/ets_sys"],
    resourceEstimate: { flashBytes: 2400, ramBytes: 128 },
    measurements: ["temperature_dht22", "humidity_dht22"],
    defaultUnits: { temperature_dht22: "°C", humidity_dht22: "%" },
    driverVersion: "1.0.0",
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_DHT22",
    hardwareVerificationStatus: "implemented_unverified",
    allowSharedPinWithSameDriver: true,
    allowSharedI2cBus: false,
  },
  {
    id: "ds18b20",
    displayName: "DS18B20 (1-Wire)",
    shortDescription: "1-Wire precision digital temperature probe (-55°C to +125°C).",
    supportedModels: ["DS18B20", "DS18B20-WP"],
    supportedChipFamilies: ALL_SENSOR_CAPABLE_CHIPS,
    interface: "onewire",
    interfaceLabel: "1-Wire",
    requiredInterfaces: ["onewire"],
    requiredPinCapabilities: ["digital_in", "digital_out"],
    requiresBidirectionalGpio: true,
    busConfig: {
      kind: "onewire",
      requiresPullUp: true,
      supportsSharedBus: true,
      minIntervalMs: 1000,
    },
    idfComponents: ["driver/gpio", "esp_timer", "rom/ets_sys"],
    resourceEstimate: { flashBytes: 3200, ramBytes: 192 },
    measurements: ["temperature_ds18b20"],
    defaultUnits: { temperature_ds18b20: "°C" },
    driverVersion: "1.0.0",
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_DS18B20",
    hardwareVerificationStatus: "implemented_unverified",
    allowSharedPinWithSameDriver: true,
    allowSharedI2cBus: false,
  },
  {
    id: "bme280",
    displayName: "BME280 (I2C Climate)",
    shortDescription: "Bosch I2C temperature, humidity, and barometric pressure sensor.",
    supportedModels: ["BME280"],
    supportedChipFamilies: ALL_SENSOR_CAPABLE_CHIPS,
    interface: "i2c",
    interfaceLabel: "I2C",
    requiredInterfaces: ["i2c"],
    requiredPinCapabilities: ["i2c"],
    requiresBidirectionalGpio: false,
    busConfig: {
      kind: "i2c",
      supportsSharedBus: true,
      requiresTwoPins: true,
      defaultAddresses: ["0x76", "0x77"],
      defaultClockHz: 100000,
      minIntervalMs: 1000,
    },
    idfComponents: ["driver/i2c_master"],
    resourceEstimate: { flashBytes: 4600, ramBytes: 256 },
    measurements: ["temperature_bme280", "humidity_bme280", "pressure_bme280"],
    defaultUnits: {
      temperature_bme280: "°C",
      humidity_bme280: "%",
      pressure_bme280: "hPa",
    },
    driverVersion: "1.0.0",
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_BME280",
    hardwareVerificationStatus: "implemented_unverified",
    allowSharedPinWithSameDriver: true,
    allowSharedI2cBus: true,
  },
  {
    id: "pir",
    displayName: "PIR Motion Sensor",
    shortDescription: "Passive infrared digital motion detector with software debouncing.",
    supportedModels: ["HC-SR501", "AM312", "SR602", "Generic PIR"],
    supportedChipFamilies: ALL_SENSOR_CAPABLE_CHIPS,
    interface: "gpio_digital_in",
    interfaceLabel: "GPIO Input",
    requiredInterfaces: ["gpio"],
    requiredPinCapabilities: ["digital_in"],
    requiresBidirectionalGpio: false,
    busConfig: {
      kind: "gpio",
      requiresPullUp: false,
      supportsSharedBus: false,
      debounceMs: 50,
    },
    idfComponents: ["driver/gpio", "esp_timer"],
    resourceEstimate: { flashBytes: 900, ramBytes: 64 },
    measurements: ["motion_pir"],
    defaultUnits: { motion_pir: "motion" },
    driverVersion: "1.0.0",
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_PIR",
    hardwareVerificationStatus: "implemented_unverified",
    allowSharedPinWithSameDriver: false,
    allowSharedI2cBus: false,
  },
  {
    id: "reed",
    displayName: "Magnetic Reed / Contact",
    shortDescription: "Debounced dry-contact magnetic door/window reed switch.",
    supportedModels: ["MC-38", "Generic Dry Contact Reed"],
    supportedChipFamilies: ALL_SENSOR_CAPABLE_CHIPS,
    interface: "gpio_digital_in",
    interfaceLabel: "GPIO Input",
    requiredInterfaces: ["gpio"],
    requiredPinCapabilities: ["digital_in"],
    requiresBidirectionalGpio: false,
    busConfig: {
      kind: "gpio",
      requiresPullUp: true,
      supportsSharedBus: false,
      debounceMs: 50,
    },
    idfComponents: ["driver/gpio", "esp_timer"],
    resourceEstimate: { flashBytes: 900, ramBytes: 64 },
    measurements: ["contact_reed"],
    defaultUnits: { contact_reed: "state" },
    driverVersion: "1.0.0",
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_REED",
    hardwareVerificationStatus: "implemented_unverified",
    allowSharedPinWithSameDriver: false,
    allowSharedI2cBus: false,
  },
  {
    id: "bh1750",
    displayName: "BH1750 Ambient Light",
    shortDescription: "Digital I2C ambient illuminance sensor measuring light in lux.",
    supportedModels: ["BH1750", "BH1750FVI", "GY-30", "GY-302"],
    supportedChipFamilies: ALL_SENSOR_CAPABLE_CHIPS,
    interface: "i2c",
    interfaceLabel: "I2C",
    requiredInterfaces: ["i2c"],
    requiredPinCapabilities: ["i2c"],
    requiresBidirectionalGpio: false,
    busConfig: {
      kind: "i2c",
      supportsSharedBus: true,
      requiresTwoPins: true,
      defaultAddresses: ["0x23", "0x5C"],
      defaultClockHz: 100000,
      minIntervalMs: 500,
    },
    idfComponents: ["driver/i2c_master"],
    resourceEstimate: { flashBytes: 2200, ramBytes: 128 },
    measurements: ["light_bh1750"],
    defaultUnits: { light_bh1750: "lx" },
    driverVersion: "1.0.0",
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_BH1750",
    hardwareVerificationStatus: "implemented_unverified",
    allowSharedPinWithSameDriver: false,
    allowSharedI2cBus: true,
  },
  {
    id: "adc_voltage",
    displayName: "Analog Voltage (ADC)",
    shortDescription: "Calibrated multi-sample ADC voltage measurement (0–3.3V input).",
    supportedModels: ["Generic Analog 0-3.3V", "Voltage Divider"],
    supportedChipFamilies: ALL_SENSOR_CAPABLE_CHIPS,
    interface: "adc",
    interfaceLabel: "ADC",
    requiredInterfaces: ["adc"],
    requiredPinCapabilities: ["adc"],
    requiresBidirectionalGpio: false,
    busConfig: {
      kind: "adc",
      supportsSharedBus: false,
      samplesPerRead: 8,
    },
    idfComponents: ["esp_adc/adc_oneshot", "esp_adc/adc_cali"],
    resourceEstimate: { flashBytes: 2800, ramBytes: 160 },
    measurements: ["analog_voltage"],
    defaultUnits: { analog_voltage: "V" },
    driverVersion: "1.0.0",
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_ADC",
    hardwareVerificationStatus: "implemented_unverified",
    allowSharedPinWithSameDriver: false,
    allowSharedI2cBus: false,
  },
];

export const SENSOR_MEASUREMENT_REGISTRY: readonly SensorMeasurementDefinition[] = [
  {
    sensorType: "temperature_dht22",
    driverId: "dht22",
    displayName: "Temperature (DHT22)",
    shortDescription: "Ambient air temperature via DHT22 / AM2302 single-wire sensor.",
    interfaceLabel: "GPIO (1-Pin Digital)",
    defaultUnit: "°C",
    valueKind: "numeric",
  },
  {
    sensorType: "humidity_dht22",
    driverId: "dht22",
    displayName: "Humidity (DHT22)",
    shortDescription: "Relative humidity via DHT22 / AM2302 (can share pin with DHT22 temperature).",
    interfaceLabel: "GPIO (1-Pin Digital)",
    defaultUnit: "%",
    valueKind: "numeric",
  },
  {
    sensorType: "temperature_ds18b20",
    driverId: "ds18b20",
    displayName: "Temperature (DS18B20)",
    shortDescription: "Precision 1-Wire digital temperature probe with CRC-8 verification.",
    interfaceLabel: "1-Wire",
    defaultUnit: "°C",
    valueKind: "numeric",
  },
  {
    sensorType: "temperature_bme280",
    driverId: "bme280",
    displayName: "Temperature (BME280)",
    shortDescription: "Bosch BME280 I2C temperature measurement (shares I2C bus).",
    interfaceLabel: "I2C",
    defaultUnit: "°C",
    valueKind: "numeric",
  },
  {
    sensorType: "humidity_bme280",
    driverId: "bme280",
    displayName: "Humidity (BME280)",
    shortDescription: "Bosch BME280 I2C relative humidity measurement (shares I2C bus).",
    interfaceLabel: "I2C",
    defaultUnit: "%",
    valueKind: "numeric",
  },
  {
    sensorType: "pressure_bme280",
    driverId: "bme280",
    displayName: "Barometric Pressure (BME280)",
    shortDescription: "Bosch BME280 I2C barometric pressure in hPa (shares I2C bus).",
    interfaceLabel: "I2C",
    defaultUnit: "hPa",
    valueKind: "numeric",
  },
  {
    sensorType: "motion_pir",
    driverId: "pir",
    displayName: "Motion (PIR)",
    shortDescription: "Passive infrared motion detection with debounced digital input.",
    interfaceLabel: "GPIO Input",
    defaultUnit: "motion",
    valueKind: "boolean",
  },
  {
    sensorType: "contact_reed",
    driverId: "reed",
    displayName: "Door / Window Contact (Reed)",
    shortDescription: "Debounced magnetic reed switch with pull-up support.",
    interfaceLabel: "GPIO Input",
    defaultUnit: "state",
    valueKind: "boolean",
  },
  {
    sensorType: "light_bh1750",
    driverId: "bh1750",
    displayName: "Ambient Light (BH1750)",
    shortDescription: "Digital I2C ambient light illuminance in lux (shares I2C bus).",
    interfaceLabel: "I2C",
    defaultUnit: "lx",
    valueKind: "numeric",
  },
  {
    sensorType: "analog_voltage",
    driverId: "adc_voltage",
    displayName: "Analog Voltage (ADC)",
    shortDescription: "Calibrated ADC voltage input on an ADC-capable GPIO pin.",
    interfaceLabel: "ADC",
    defaultUnit: "V",
    valueKind: "numeric",
  },
];

export function isSensorDriverId(value: string): value is SensorDriverId {
  return (SENSOR_DRIVER_IDS as readonly string[]).includes(value);
}

export function getSensorDriverById(id: string): SensorDriverDefinition | undefined {
  return SENSOR_DRIVER_REGISTRY.find((d) => d.id === id);
}

export function getSensorMeasurementByType(
  sensorType: string
): SensorMeasurementDefinition | undefined {
  return SENSOR_MEASUREMENT_REGISTRY.find((m) => m.sensorType === sensorType);
}

export function getSensorDriverForMeasurement(
  sensorType: string
): SensorDriverDefinition | undefined {
  const measurement = getSensorMeasurementByType(sensorType);
  if (!measurement) return undefined;
  return getSensorDriverById(measurement.driverId);
}

export function getMeasurementsForDriver(
  driverId: SensorDriverId
): readonly SupportedSensorType[] {
  return getSensorDriverById(driverId)?.measurements ?? [];
}

// ---------------------------------------------------------------------------
// Structured Board Hardware Capability Profile (derived from gpio_definitions)
// ---------------------------------------------------------------------------

export interface BoardHardwareCapabilityProfile {
  boardSlug: string;
  chipFamily: string;
  flashSizeMb: number;
  psramSizeMb: number;
  psramMode: PsramMode;
  totalDefinedGpios: number;
  maxUsableGpios: number;
  usableGpios: number[];
  reservedGpios: number[];
  strappingGpios: number[];
  usbConflictGpios: number[];
  flashPsramGpios: number[];
  onboardPeripherals: {
    relays: number[];
    leds: number[];
    buttons: number[];
    buzzers: number[];
    uart: number[];
    camera: number[];
    sd: number[];
  };
  pins: {
    digitalIn: number[];
    digitalOut: number[];
    bidirectionalGpio: number[];
    adc: number[];
    pwm: number[];
    i2c: number[];
    spi: number[];
    oneWire: number[];
    uart: number[];
    touch: number[];
  };
  interfaces: {
    supportsDigitalIn: boolean;
    supportsDigitalOut: boolean;
    supportsBidirectionalGpio: boolean;
    supportsAdc: boolean;
    supportsI2c: boolean;
    supportsOneWire: boolean;
    supportsSpi: boolean;
    supportsPwm: boolean;
    supportsTouch: boolean;
  };
  defaultI2cBus: {
    sdaPin: number | null;
    sclPin: number | null;
  };
  peripheralLimits: {
    maxI2cBuses: number;
    maxAdcChannels: number;
    maxSensorSlots: number;
  };
}

function defaultMaxI2cBusesForChip(chipFamily: string): number {
  const norm = chipFamily.trim().toLowerCase();
  if (norm === "esp32" || norm === "esp32s2" || norm === "esp32s3" || norm === "esp32p4") {
    return 2;
  }
  return 1;
}

function findDefaultI2cPinsFromLayout(
  board: Pick<BoardProfileSpec, "board_layout" | "gpio_definitions">,
  usableI2cSet: Set<number>
): { sdaPin: number | null; sclPin: number | null } {
  let sdaPin: number | null = null;
  let sclPin: number | null = null;

  const layout = board.board_layout;
  const allHeaderPins = [
    ...(layout?.leftHeader?.pins ?? []),
    ...(layout?.rightHeader?.pins ?? []),
    ...(layout?.extraPads?.pins ?? []),
  ];

  for (const hp of allHeaderPins) {
    if (typeof hp.gpioPin !== "number" || !usableI2cSet.has(hp.gpioPin)) continue;
    const tokens = [hp.pinName, ...(hp.aliases ?? [])]
      .join(" ")
      .toUpperCase();
    if (sdaPin === null && /\b(I2C_?SDA|SDA)\b/.test(tokens)) {
      sdaPin = hp.gpioPin;
    }
    if (sclPin === null && /\b(I2C_?SCL|SCL)\b/.test(tokens)) {
      sclPin = hp.gpioPin;
    }
  }

  for (const def of board.gpio_definitions ?? []) {
    if (!usableI2cSet.has(def.pin)) continue;
    const text = `${def.label} ${def.board_pin_name ?? ""} ${def.board_note ?? ""}`.toUpperCase();
    if (sdaPin === null && /\b(I2C_?SDA|SDA)\b/.test(text)) sdaPin = def.pin;
    if (sclPin === null && /\b(I2C_?SCL|SCL)\b/.test(text)) sclPin = def.pin;
  }

  if (sdaPin !== null && sclPin !== null && sdaPin === sclPin) {
    sclPin = null;
  }

  if ((sdaPin === null || sclPin === null) && usableI2cSet.size >= 2) {
    const sorted = Array.from(usableI2cSet).sort((a, b) => a - b);
    if (sdaPin === null) {
      sdaPin = sorted.find((p) => p !== sclPin) ?? null;
    }
    if (sclPin === null) {
      sclPin = sorted.find((p) => p !== sdaPin) ?? null;
    }
  }

  return { sdaPin, sclPin };
}

/**
 * Derives a structured hardware capability profile directly from the board's
 * existing `gpio_definitions` and `board_layout` without duplicating pin rules.
 */
export function deriveBoardHardwareCapabilityProfile(
  board: Pick<
    BoardProfileSpec,
    | "slug"
    | "chip_family"
    | "flash_size_mb"
    | "psram_size_mb"
    | "psram_mode"
    | "boot_button_gpio"
    | "board_layout"
    | "gpio_definitions"
  >
): BoardHardwareCapabilityProfile {
  const compat = resolveBoardFirmwareCompatibility(board);
  const layoutFacts = readBoardLayoutFacts({
    board_layout: board.board_layout ?? null,
    gpio_definitions: board.gpio_definitions ?? [],
  });
  const bootButtonGpio =
    typeof board.boot_button_gpio === "number"
      ? board.boot_button_gpio
      : compat.boot_button_gpio;

  const usableGpios: number[] = [];
  const reservedGpios: number[] = [];
  const strappingGpios: number[] = [];
  const usbConflictGpios: number[] = [];
  const flashPsramGpios: number[] = [];

  const relays: number[] = [];
  const leds: number[] = [];
  const buttons: number[] = [];
  const buzzers: number[] = [];
  const uartOnboard: number[] = [];
  const camera: number[] = [];
  const sd: number[] = [];

  const digitalIn: number[] = [];
  const digitalOut: number[] = [];
  const bidirectionalGpio: number[] = [];
  const adc: number[] = [];
  const pwm: number[] = [];
  const i2c: number[] = [];
  const spi: number[] = [];
  const oneWire: number[] = [];
  const uart: number[] = [];
  const touch: number[] = [];

  for (const def of board.gpio_definitions ?? []) {
    const facts = collectBoardPinHardwareFacts(def, layoutFacts, bootButtonGpio);

    if (def.restrictions.reserved) reservedGpios.push(def.pin);
    if (def.restrictions.strapping_pin) strappingGpios.push(def.pin);
    if (def.restrictions.usb_jtag_conflict) usbConflictGpios.push(def.pin);
    if (def.restrictions.flash_psram_conflict) flashPsramGpios.push(def.pin);

    for (const kind of facts.onboardKinds) {
      if (kind === "relay") relays.push(def.pin);
      else if (kind === "led" || kind === "rgb_led") leds.push(def.pin);
      else if (kind === "button") buttons.push(def.pin);
      else if (kind === "buzzer") buzzers.push(def.pin);
      else if (kind === "uart") uartOnboard.push(def.pin);
      else if (kind === "camera") camera.push(def.pin);
      else if (kind === "sd") sd.push(def.pin);
    }

    // Blocked pins (reserved, flash/PSRAM, off-header) cannot be used
    if (facts.blocked.length > 0) continue;

    // Restricted pins (strapping, USB/JTAG, BOOT button, dedicated onboard UART)
    // are excluded from general-purpose sensor availability counts.
    if (facts.restricted.length > 0) continue;

    usableGpios.push(def.pin);

    const isOnboardOutputOnly =
      facts.onboardKinds.includes("relay") || facts.onboardKinds.includes("buzzer");

    if (def.capabilities.digital_out && !def.restrictions.input_only) {
      digitalOut.push(def.pin);
    }
    if (def.capabilities.pwm && !def.restrictions.input_only) {
      pwm.push(def.pin);
    }

    if (!isOnboardOutputOnly) {
      if (def.capabilities.digital_in) digitalIn.push(def.pin);
      if (
        def.capabilities.digital_in &&
        def.capabilities.digital_out &&
        !def.restrictions.input_only
      ) {
        bidirectionalGpio.push(def.pin);
        oneWire.push(def.pin);
      }
      if (def.capabilities.adc) adc.push(def.pin);
      if (def.capabilities.i2c && !def.restrictions.input_only) i2c.push(def.pin);
      if (def.capabilities.spi) spi.push(def.pin);
      if (def.capabilities.uart) uart.push(def.pin);
      if (def.capabilities.touch) touch.push(def.pin);
    }
  }

  const defaultI2cBus = findDefaultI2cPinsFromLayout(board, new Set(i2c));

  return {
    boardSlug: board.slug,
    chipFamily: String(board.chip_family).trim().toLowerCase(),
    flashSizeMb: board.flash_size_mb,
    psramSizeMb: board.psram_size_mb,
    psramMode: compat.psram_mode,
    totalDefinedGpios: (board.gpio_definitions ?? []).length,
    maxUsableGpios: usableGpios.length,
    usableGpios,
    reservedGpios,
    strappingGpios,
    usbConflictGpios,
    flashPsramGpios,
    onboardPeripherals: {
      relays,
      leds,
      buttons,
      buzzers,
      uart: uartOnboard,
      camera,
      sd,
    },
    pins: {
      digitalIn,
      digitalOut,
      bidirectionalGpio,
      adc,
      pwm,
      i2c,
      spi,
      oneWire,
      uart,
      touch,
    },
    interfaces: {
      supportsDigitalIn: digitalIn.length >= 1,
      supportsDigitalOut: digitalOut.length >= 1,
      supportsBidirectionalGpio: bidirectionalGpio.length >= 1,
      supportsAdc: adc.length >= 1,
      supportsI2c: i2c.length >= 2,
      supportsOneWire: oneWire.length >= 1,
      supportsSpi: spi.length >= 3,
      supportsPwm: pwm.length >= 1,
      supportsTouch: touch.length >= 1,
    },
    defaultI2cBus,
    peripheralLimits: {
      maxI2cBuses: i2c.length >= 2 ? defaultMaxI2cBusesForChip(board.chip_family) : 0,
      maxAdcChannels: adc.length,
      maxSensorSlots: 48,
    },
  };
}

// ---------------------------------------------------------------------------
// Firmware-Specific Driver Manifest Schema, Validation & Extraction
// ---------------------------------------------------------------------------

export const FIRMWARE_DRIVER_MANIFEST_VERSION = "1.0";

export interface FirmwareDriverEntry {
  id: SensorDriverId;
  version: string;
  measurements: SupportedSensorType[];
  kconfig_flag?: string;
  status?: "compiled" | "verified";
}

export interface FirmwareDriverManifest {
  manifest_version: string;
  manifest_hash?: string;
  release_id?: string | null;
  firmware_version: string;
  target_board_slug: string | null;
  chip_family: ChipFamily;
  partition_scheme: PartitionScheme | null;
  flash_size_mb: number | null;
  psram_mode: PsramMode | null;
  sensor_drivers: FirmwareDriverEntry[];
  supported_sensor_types: SupportedSensorType[];
  build_verification?: {
    verified: boolean;
    verifier?: string | null;
    ci_commit_sha?: string | null;
    idf_version?: string | null;
  };
}

export type FirmwareManifestState =
  | "manifest_verified"
  | "legacy_no_manifest"
  | "unknown_firmware"
  | "no_firmware_installed"
  | "invalid_manifest";

export interface ResolvedFirmwareDriverManifest {
  state: FirmwareManifestState;
  releaseId: string | null;
  releaseName: string | null;
  firmwareVersion: string | null;
  targetBoardSlug: string | null;
  manifestVersion: string | null;
  manifestHash: string | null;
  compiledDriverIds: SensorDriverId[];
  supportedSensorTypes: SupportedSensorType[];
  drivers: FirmwareDriverEntry[];
  reason: string | null;
}

export function buildCanonicalDriverManifestString(input: {
  manifest_version: string;
  firmware_version: string;
  target_board_slug: string | null;
  chip_family: string;
  partition_scheme: string | null;
  flash_size_mb: number | null;
  psram_mode: string | null;
  sensor_drivers: Array<{ id: string; version: string; measurements: string[] }>;
}): string {
  const normalizedDrivers = [...input.sensor_drivers]
    .map((d) => ({
      id: d.id,
      version: d.version,
      measurements: [...d.measurements].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return JSON.stringify({
    chip_family: input.chip_family.trim().toLowerCase(),
    firmware_version: input.firmware_version.trim(),
    flash_size_mb: input.flash_size_mb ?? null,
    manifest_version: input.manifest_version.trim(),
    partition_scheme: input.partition_scheme ?? null,
    psram_mode: input.psram_mode ?? null,
    sensor_drivers: normalizedDrivers,
    target_board_slug: input.target_board_slug ?? null,
  });
}

export function validateFirmwareDriverManifest(
  raw: unknown,
  context?: { expectedChipFamily?: string | null; expectedBoardSlug?: string | null }
): {
  valid: boolean;
  errors: string[];
  manifest: FirmwareDriverManifest | null;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      valid: false,
      errors: ["Firmware driver manifest must be a JSON object."],
      manifest: null,
    };
  }
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  const manifestVersion =
    typeof obj.manifest_version === "string" && obj.manifest_version.trim()
      ? obj.manifest_version.trim()
      : FIRMWARE_DRIVER_MANIFEST_VERSION;

  const chipRaw =
    typeof obj.chip_family === "string"
      ? obj.chip_family.trim().toLowerCase()
      : (context?.expectedChipFamily ?? "").trim().toLowerCase();
  if (!(SUPPORTED_CHIP_FAMILIES as readonly string[]).includes(chipRaw)) {
    errors.push(`Invalid or unsupported chip_family "${chipRaw}" in driver manifest.`);
  }
  if (
    context?.expectedChipFamily &&
    chipRaw &&
    chipRaw !== context.expectedChipFamily.trim().toLowerCase()
  ) {
    errors.push(
      `Driver manifest chip_family "${chipRaw}" does not match firmware release chip_family "${context.expectedChipFamily}".`
    );
  }

  const targetBoardSlug =
    typeof obj.target_board_slug === "string" && obj.target_board_slug.trim()
      ? obj.target_board_slug.trim()
      : context?.expectedBoardSlug ?? null;

  if (
    context?.expectedBoardSlug &&
    targetBoardSlug &&
    targetBoardSlug !== context.expectedBoardSlug
  ) {
    errors.push(
      `Driver manifest target_board_slug "${targetBoardSlug}" does not match release board "${context.expectedBoardSlug}".`
    );
  }

  const firmwareVersion =
    typeof obj.firmware_version === "string" && obj.firmware_version.trim()
      ? obj.firmware_version.trim()
      : "";
  if (!firmwareVersion) {
    errors.push("Driver manifest is missing firmware_version.");
  }

  if (!Array.isArray(obj.sensor_drivers)) {
    errors.push("Driver manifest must contain a sensor_drivers array.");
  }

  const drivers: FirmwareDriverEntry[] = [];
  const seenDrivers = new Set<SensorDriverId>();
  const supportedTypesSet = new Set<SupportedSensorType>();

  if (Array.isArray(obj.sensor_drivers)) {
    for (const item of obj.sensor_drivers) {
      const driverIdRaw =
        typeof item === "string"
          ? item.trim()
          : item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
            ? String((item as { id: string }).id).trim()
            : "";

      if (!isSensorDriverId(driverIdRaw)) {
        errors.push(`Unknown sensor driver "${driverIdRaw || "<empty>"}" in firmware driver manifest.`);
        continue;
      }
      if (seenDrivers.has(driverIdRaw)) continue;

      const reg = getSensorDriverById(driverIdRaw)!;
      if (chipRaw && !(reg.supportedChipFamilies as readonly string[]).includes(chipRaw)) {
        errors.push(
          `Driver "${driverIdRaw}" is not supported on chip family "${chipRaw}".`
        );
        continue;
      }

      const itemObj =
        item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const version =
        typeof itemObj.version === "string" && itemObj.version.trim()
          ? itemObj.version.trim()
          : reg.driverVersion;

      let measurements: SupportedSensorType[] = [...reg.measurements];
      if (Array.isArray(itemObj.measurements)) {
        const declared: SupportedSensorType[] = [];
        for (const m of itemObj.measurements) {
          if (
            typeof m !== "string" ||
            !(reg.measurements as readonly string[]).includes(m)
          ) {
            errors.push(
              `Measurement "${String(m)}" is not valid for sensor driver "${driverIdRaw}".`
            );
          } else {
            declared.push(m as SupportedSensorType);
          }
        }
        if (declared.length > 0) measurements = declared;
      }

      seenDrivers.add(driverIdRaw);
      for (const m of measurements) supportedTypesSet.add(m);
      drivers.push({
        id: driverIdRaw,
        version,
        measurements,
        kconfig_flag:
          typeof itemObj.kconfig_flag === "string"
            ? itemObj.kconfig_flag
            : reg.kconfigFlag,
        status: itemObj.status === "verified" ? "verified" : "compiled",
      });
    }
  }

  // Validate supported_sensor_types if explicitly provided (must not claim measurements from uncompiled drivers)
  if (Array.isArray(obj.supported_sensor_types)) {
    for (const st of obj.supported_sensor_types) {
      if (
        typeof st !== "string" ||
        !(SUPPORTED_SENSOR_TYPES as readonly string[]).includes(st)
      ) {
        errors.push(`Invalid measurement "${String(st)}" in supported_sensor_types.`);
      } else if (!supportedTypesSet.has(st as SupportedSensorType)) {
        errors.push(
          `Measurement "${st}" is listed in supported_sensor_types without its compiled driver in sensor_drivers.`
        );
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, manifest: null };
  }

  const supportedSensorTypes = SUPPORTED_SENSOR_TYPES.filter((t) =>
    supportedTypesSet.has(t)
  );

  return {
    valid: true,
    errors: [],
    manifest: {
      manifest_version: manifestVersion,
      manifest_hash:
        typeof obj.manifest_hash === "string" && obj.manifest_hash.trim()
          ? obj.manifest_hash.trim()
          : undefined,
      release_id:
        typeof obj.release_id === "string" ? obj.release_id : null,
      firmware_version: firmwareVersion,
      target_board_slug: targetBoardSlug,
      chip_family: chipRaw as ChipFamily,
      partition_scheme:
        typeof obj.partition_scheme === "string"
          ? (obj.partition_scheme as PartitionScheme)
          : null,
      flash_size_mb:
        typeof obj.flash_size_mb === "number" ? obj.flash_size_mb : null,
      psram_mode:
        typeof obj.psram_mode === "string"
          ? (obj.psram_mode as PsramMode)
          : null,
      sensor_drivers: drivers,
      supported_sensor_types: supportedSensorTypes,
      ...(obj.build_verification && typeof obj.build_verification === "object"
        ? {
            build_verification: obj.build_verification as FirmwareDriverManifest["build_verification"],
          }
        : {}),
    },
  };
}

/**
 * Extracts and validates the compiled sensor driver manifest from an
 * authoritative `firmware_releases` database record. Legacy releases without
 * driver manifest metadata safely resolve to `"legacy_no_manifest"`.
 */
export function extractFirmwareDriverManifestFromRelease(release: {
  id: string;
  name?: string | null;
  version: string;
  chip_family: string;
  target_board_slug?: string | null;
  partition_scheme?: string | null;
  flash_size_mb?: number | null;
  psram_mode?: string | null;
  driver_manifest?: unknown;
  compiled_sensor_drivers?: string[] | null;
  supported_sensor_types?: string[] | null;
  manifest_version?: string | null;
  manifest_hash?: string | null;
  manifest?: unknown;
}): ResolvedFirmwareDriverManifest {
  const pkgManifest =
    release.manifest && typeof release.manifest === "object" && !Array.isArray(release.manifest)
      ? (release.manifest as Record<string, unknown>)
      : null;

  const candidateRaw =
    release.driver_manifest ??
    pkgManifest?.driver_manifest ??
    (Array.isArray(pkgManifest?.sensor_drivers)
      ? {
          manifest_version:
            pkgManifest.manifest_version ??
            release.manifest_version ??
            FIRMWARE_DRIVER_MANIFEST_VERSION,
          manifest_hash: pkgManifest.manifest_hash ?? release.manifest_hash ?? undefined,
          release_id: release.id,
          firmware_version: release.version,
          target_board_slug: release.target_board_slug ?? null,
          chip_family: release.chip_family,
          partition_scheme: release.partition_scheme ?? null,
          flash_size_mb: release.flash_size_mb ?? null,
          psram_mode: release.psram_mode ?? null,
          sensor_drivers: pkgManifest.sensor_drivers,
          supported_sensor_types: pkgManifest.supported_sensor_types,
        }
      : Array.isArray(release.compiled_sensor_drivers) &&
          release.compiled_sensor_drivers.length > 0
        ? {
            manifest_version:
              release.manifest_version ?? FIRMWARE_DRIVER_MANIFEST_VERSION,
            manifest_hash: release.manifest_hash ?? undefined,
            release_id: release.id,
            firmware_version: release.version,
            target_board_slug: release.target_board_slug ?? null,
            chip_family: release.chip_family,
            partition_scheme: release.partition_scheme ?? null,
            flash_size_mb: release.flash_size_mb ?? null,
            psram_mode: release.psram_mode ?? null,
            sensor_drivers: release.compiled_sensor_drivers,
          }
        : null);

  if (!candidateRaw) {
    return {
      state: "legacy_no_manifest",
      releaseId: release.id,
      releaseName: release.name ?? null,
      firmwareVersion: release.version,
      targetBoardSlug: release.target_board_slug ?? null,
      manifestVersion: null,
      manifestHash: null,
      compiledDriverIds: [],
      supportedSensorTypes: [],
      drivers: [],
      reason: `Installed firmware v${release.version} does not contain a compiled sensor driver manifest. Update this controller to a board-aware firmware release.`,
    };
  }

  const check = validateFirmwareDriverManifest(candidateRaw, {
    expectedChipFamily: release.chip_family,
    expectedBoardSlug: release.target_board_slug ?? null,
  });

  if (!check.valid || !check.manifest) {
    return {
      state: "invalid_manifest",
      releaseId: release.id,
      releaseName: release.name ?? null,
      firmwareVersion: release.version,
      targetBoardSlug: release.target_board_slug ?? null,
      manifestVersion: release.manifest_version ?? null,
      manifestHash: release.manifest_hash ?? null,
      compiledDriverIds: [],
      supportedSensorTypes: [],
      drivers: [],
      reason: `Firmware v${release.version} driver manifest is invalid: ${check.errors.join(" ")}`,
    };
  }

  return {
    state: "manifest_verified",
    releaseId: release.id,
    releaseName: release.name ?? null,
    firmwareVersion: release.version,
    targetBoardSlug: check.manifest.target_board_slug,
    manifestVersion: check.manifest.manifest_version,
    manifestHash: check.manifest.manifest_hash ?? release.manifest_hash ?? null,
    compiledDriverIds: check.manifest.sensor_drivers.map((d) => d.id),
    supportedSensorTypes: check.manifest.supported_sensor_types,
    drivers: check.manifest.sensor_drivers,
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// Board + Firmware Sensor Compatibility Evaluation & Assignment Validation
// ---------------------------------------------------------------------------

export interface BoardDriverCompatibilityResult {
  driverId: SensorDriverId;
  supported: boolean;
  reasons: string[];
  availablePins: number[];
}

/**
 * Evaluates whether a board's PHYSICAL hardware supports a given sensor driver,
 * independently checking ADC, I2C (>=2 pins), OneWire / bidirectional GPIO,
 * and chip family compatibility.
 */
export function evaluateBoardDriverCompatibility(
  board: Pick<
    BoardProfileSpec,
    | "slug"
    | "manufacturer"
    | "model"
    | "chip_family"
    | "flash_size_mb"
    | "psram_size_mb"
    | "psram_mode"
    | "boot_button_gpio"
    | "board_layout"
    | "gpio_definitions"
  >,
  driverId: SensorDriverId,
  precomputedProfile?: BoardHardwareCapabilityProfile
): BoardDriverCompatibilityResult {
  const driver = getSensorDriverById(driverId);
  if (!driver) {
    return {
      driverId,
      supported: false,
      reasons: [`Unknown sensor driver "${driverId}".`],
      availablePins: [],
    };
  }

  const profile = precomputedProfile ?? deriveBoardHardwareCapabilityProfile(board);
  const reasons: string[] = [];
  const boardLabel = `${board.manufacturer} ${board.model}`.trim();

  if (!(driver.supportedChipFamilies as readonly string[]).includes(profile.chipFamily)) {
    reasons.push(
      `${driver.displayName} is not supported on ${profile.chipFamily.toUpperCase()} silicon.`
    );
  }

  let availablePins: number[] = [];

  if (driver.interface === "adc") {
    availablePins = profile.pins.adc;
    if (!profile.interfaces.supportsAdc) {
      reasons.push(
        `${boardLabel} has no usable ADC-capable GPIO pins for ${driver.displayName}.`
      );
    }
  } else if (driver.interface === "i2c") {
    availablePins = profile.pins.i2c;
    if (!profile.interfaces.supportsI2c) {
      reasons.push(
        `${boardLabel} does not have at least two usable I2C-capable GPIOs (SDA + SCL) for ${driver.displayName}.`
      );
    }
  } else if (driver.interface === "onewire") {
    availablePins = profile.pins.oneWire;
    if (!profile.interfaces.supportsOneWire) {
      reasons.push(
        `${boardLabel} has no usable bidirectional GPIO pins for 1-Wire (${driver.displayName}).`
      );
    }
  } else if (driver.requiresBidirectionalGpio) {
    availablePins = profile.pins.bidirectionalGpio;
    if (!profile.interfaces.supportsBidirectionalGpio) {
      reasons.push(
        `${boardLabel} has no usable bidirectional GPIO pins (input + output) for ${driver.displayName}.`
      );
    }
  } else {
    availablePins = profile.pins.digitalIn;
    if (!profile.interfaces.supportsDigitalIn) {
      reasons.push(
        `${boardLabel} has no usable digital input GPIO pins for ${driver.displayName}.`
      );
    }
  }

  return {
    driverId,
    supported: reasons.length === 0,
    reasons,
    availablePins,
  };
}

export interface ControllerSensorOptionReport {
  sensorType: SupportedSensorType;
  driverId: SensorDriverId;
  displayName: string;
  driverDisplayName: string;
  shortDescription: string;
  interface: SensorInterfaceKind;
  interfaceLabel: string;
  defaultUnit: string;
  defaultI2cAddresses: readonly string[];
  boardSupported: boolean;
  firmwareSupported: boolean;
  compatible: boolean;
  boardReasons: string[];
  firmwareReasons: string[];
  availablePins: number[];
  driverVersion: string | null;
  hardwareVerificationStatus: SensorHardwareVerificationStatus;
}

export interface ControllerSensorCompatibilityReport {
  boardSlug: string | null;
  boardName: string | null;
  boardCapabilities: BoardHardwareCapabilityProfile | null;
  firmware: ResolvedFirmwareDriverManifest;
  compatibleSensors: ControllerSensorOptionReport[];
  incompatibleSensors: ControllerSensorOptionReport[];
  compatibleDriverIds: SensorDriverId[];
  boardOnlySupportedSensors: SupportedSensorType[];
  needsFirmwareUpdate: boolean;
  updateRecommendation: string | null;
  latestAvailableRelease?: {
    id: string;
    version: string;
    name: string;
    supportedSensorTypes: SupportedSensorType[];
  } | null;
}

export function evaluateControllerSensorCompatibility(params: {
  board: BoardProfileSpec | null;
  installedFirmware: ResolvedFirmwareDriverManifest;
  latestAvailableRelease?: {
    id: string;
    version: string;
    name: string;
    supportedSensorTypes: SupportedSensorType[];
  } | null;
}): ControllerSensorCompatibilityReport {
  const { board, installedFirmware, latestAvailableRelease } = params;

  if (!board) {
    const incompatible: ControllerSensorOptionReport[] = SENSOR_MEASUREMENT_REGISTRY.map(
      (m) => {
        const drv = getSensorDriverById(m.driverId)!;
        return {
          sensorType: m.sensorType,
          driverId: m.driverId,
          displayName: m.displayName,
          driverDisplayName: drv.displayName,
          shortDescription: m.shortDescription,
          interface: drv.interface,
          interfaceLabel: m.interfaceLabel,
          defaultUnit: m.defaultUnit,
          defaultI2cAddresses: drv.busConfig.defaultAddresses ?? [],
          boardSupported: false,
          firmwareSupported: false,
          compatible: false,
          boardReasons: ["Controller has no assigned hardware board profile."],
          firmwareReasons: installedFirmware.reason ? [installedFirmware.reason] : [],
          availablePins: [],
          driverVersion: null,
          hardwareVerificationStatus: drv.hardwareVerificationStatus,
        };
      }
    );
    return {
      boardSlug: null,
      boardName: null,
      boardCapabilities: null,
      firmware: installedFirmware,
      compatibleSensors: [],
      incompatibleSensors: incompatible,
      compatibleDriverIds: [],
      boardOnlySupportedSensors: [],
      needsFirmwareUpdate: false,
      updateRecommendation: "Assign a hardware board profile to this controller first.",
      latestAvailableRelease: latestAvailableRelease ?? null,
    };
  }

  const profile = deriveBoardHardwareCapabilityProfile(board);
  const boardDriverChecks = new Map<SensorDriverId, BoardDriverCompatibilityResult>();
  for (const drv of SENSOR_DRIVER_REGISTRY) {
    boardDriverChecks.set(
      drv.id,
      evaluateBoardDriverCompatibility(board, drv.id, profile)
    );
  }

  const compiledSet = new Set<SensorDriverId>(
    installedFirmware.state === "manifest_verified"
      ? installedFirmware.compiledDriverIds
      : []
  );
  const compiledVersionMap = new Map<SensorDriverId, string>(
    installedFirmware.drivers.map((d) => [d.id, d.version])
  );

  const compatibleSensors: ControllerSensorOptionReport[] = [];
  const incompatibleSensors: ControllerSensorOptionReport[] = [];
  const boardOnlySupportedSensors: SupportedSensorType[] = [];
  const compatibleDriverSet = new Set<SensorDriverId>();

  for (const m of SENSOR_MEASUREMENT_REGISTRY) {
    const drv = getSensorDriverById(m.driverId)!;
    const boardCheck = boardDriverChecks.get(m.driverId)!;
    const boardSupported = boardCheck.supported;
    const firmwareSupported =
      installedFirmware.state === "manifest_verified" &&
      compiledSet.has(m.driverId) &&
      installedFirmware.supportedSensorTypes.includes(m.sensorType);

    const firmwareReasons: string[] = [];
    if (!firmwareSupported) {
      if (installedFirmware.state !== "manifest_verified") {
        firmwareReasons.push(
          installedFirmware.reason ??
            "Controller firmware does not publish verified sensor driver capabilities. Update firmware to enable sensors."
        );
      } else {
        firmwareReasons.push(
          `Installed firmware v${installedFirmware.firmwareVersion} does not include the ${drv.displayName} driver (${drv.kconfigFlag}). Update firmware to enable this sensor.`
        );
      }
    }

    const compatible = boardSupported && firmwareSupported;
    if (boardSupported && !firmwareSupported) {
      boardOnlySupportedSensors.push(m.sensorType);
    }
    if (compatible) {
      compatibleDriverSet.add(m.driverId);
    }

    const entry: ControllerSensorOptionReport = {
      sensorType: m.sensorType,
      driverId: m.driverId,
      displayName: m.displayName,
      driverDisplayName: drv.displayName,
      shortDescription: m.shortDescription,
      interface: drv.interface,
      interfaceLabel: m.interfaceLabel,
      defaultUnit: m.defaultUnit,
      defaultI2cAddresses: drv.busConfig.defaultAddresses ?? [],
      boardSupported,
      firmwareSupported,
      compatible,
      boardReasons: boardCheck.reasons,
      firmwareReasons,
      availablePins: boardCheck.availablePins,
      driverVersion: firmwareSupported ? (compiledVersionMap.get(m.driverId) ?? drv.driverVersion) : null,
      hardwareVerificationStatus: drv.hardwareVerificationStatus,
    };

    if (compatible) {
      compatibleSensors.push(entry);
    } else {
      incompatibleSensors.push(entry);
    }
  }

  const needsFirmwareUpdate =
    installedFirmware.state !== "manifest_verified" ||
    boardOnlySupportedSensors.length > 0;

  let updateRecommendation: string | null = null;
  if (installedFirmware.state === "no_firmware_installed") {
    updateRecommendation = latestAvailableRelease
      ? `Flash or install firmware v${latestAvailableRelease.version} for ${board.manufacturer} ${board.model} to enable compatible sensor drivers.`
      : `No firmware version is reported on this controller yet. Flash a verified ${board.manufacturer} ${board.model} firmware release with a sensor driver manifest.`;
  } else if (installedFirmware.state === "legacy_no_manifest") {
    updateRecommendation = latestAvailableRelease
      ? `Firmware v${installedFirmware.firmwareVersion} predates sensor driver manifests. Update to v${latestAvailableRelease.version} to unlock supported sensors.`
      : `Firmware v${installedFirmware.firmwareVersion} does not include a sensor driver manifest. Update to a newer firmware release for ${board.manufacturer} ${board.model}.`;
  } else if (installedFirmware.state === "unknown_firmware" || installedFirmware.state === "invalid_manifest") {
    updateRecommendation =
      installedFirmware.reason ??
      "Installed firmware could not be matched to a verified driver manifest. Flash an official verified release.";
  } else if (boardOnlySupportedSensors.length > 0) {
    updateRecommendation = latestAvailableRelease
      ? `Installed firmware v${installedFirmware.firmwareVersion} supports ${compatibleDriverSet.size} driver(s). Update to v${latestAvailableRelease.version} to unlock additional sensors supported by ${board.model}.`
      : `Installed firmware v${installedFirmware.firmwareVersion} omits ${boardOnlySupportedSensors.length} sensor measurement(s) that ${board.model} physically supports. Update firmware with those drivers enabled to use them.`;
  }

  return {
    boardSlug: board.slug,
    boardName: `${board.manufacturer} ${board.model}`.trim(),
    boardCapabilities: profile,
    firmware: installedFirmware,
    compatibleSensors,
    incompatibleSensors,
    compatibleDriverIds: Array.from(compatibleDriverSet),
    boardOnlySupportedSensors,
    needsFirmwareUpdate,
    updateRecommendation,
    latestAvailableRelease: latestAvailableRelease ?? null,
  };
}

export interface ExistingControllerSensorSummary {
  id: string;
  name: string;
  sensor_type: string;
  gpio_pin: number | null;
  i2c_address?: string | null;
}

export interface SensorAssignmentValidationResult {
  valid: boolean;
  code:
    | "OK"
    | "UNSUPPORTED_SENSOR_TYPE"
    | "BOARD_PROFILE_MISSING"
    | "BOARD_HARDWARE_UNSUPPORTED"
    | "GPIO_OR_BUS_INVALID"
    | "I2C_ADDRESS_CONFLICT"
    | "FIRMWARE_NOT_INSTALLED"
    | "FIRMWARE_MANIFEST_MISSING"
    | "FIRMWARE_DRIVER_UNSUPPORTED";
  errors: string[];
  warnings: string[];
  driver: SensorDriverDefinition | null;
  measurement: SensorMeasurementDefinition | null;
}

export function normalizeI2cAddress(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const cleaned = raw.trim().toLowerCase();
  const match = cleaned.match(/^(?:0x)?([0-9a-f]{1,2})$/);
  if (!match) return null;
  const num = Number.parseInt(match[1]!, 16);
  if (num < 0x08 || num > 0x77) return null;
  return `0x${num.toString(16).padStart(2, "0")}`;
}

/**
 * Returns true when two sensor measurements are legally allowed to share the
 * same GPIO pin on the same controller (e.g. two I2C sensors on the shared SDA
 * bus, DHT22 temperature + humidity on the same single-wire pin, or multiple
 * DS18B20 probes on one 1-Wire bus).
 */
export function canSensorsShareGpioPin(
  sensorTypeA: string,
  sensorTypeB: string
): boolean {
  const drvA = getSensorDriverForMeasurement(sensorTypeA);
  const drvB = getSensorDriverForMeasurement(sensorTypeB);
  if (!drvA || !drvB) return false;
  if (drvA.allowSharedI2cBus && drvB.allowSharedI2cBus) {
    return true;
  }
  if (
    drvA.allowSharedPinWithSameDriver &&
    drvA.id === drvB.id &&
    (drvA.interface === "onewire" || sensorTypeA !== sensorTypeB)
  ) {
    return true;
  }
  return false;
}

/**
 * Authoritative end-to-end validator for adding or editing a sensor on a
 * controller. Enforces:
 * 1. Supported measurement & physical driver registry lookup
 * 2. Physical board hardware capability checks (ADC / I2C / OneWire / bidirectional GPIO)
 * 3. Pin & bus validation (including shared I2C bus & shared DHT22 multi-measurement rules)
 * 4. Installed firmware driver manifest verification (never trusts client-reported driver lists)
 */
export function validateSensorAssignmentForController(params: {
  board: BoardProfileSpec | null;
  installedFirmware: ResolvedFirmwareDriverManifest;
  sensorType: string;
  gpioPin: number | null | undefined;
  i2cAddress?: string | null;
  usedPinsByNonSensors: number[];
  existingSensorsOnController: ExistingControllerSensorSummary[];
  editingSensorId?: string | null;
  allowUnchangedPin?: boolean;
}): SensorAssignmentValidationResult {
  const measurement = getSensorMeasurementByType(params.sensorType);
  const driver = measurement ? getSensorDriverById(measurement.driverId) ?? null : null;

  if (!measurement || !driver) {
    return {
      valid: false,
      code: "UNSUPPORTED_SENSOR_TYPE",
      errors: [
        `Unsupported sensor type "${params.sensorType}". Allowed types: ${SUPPORTED_SENSOR_TYPES.join(", ")}`,
      ],
      warnings: [],
      driver: null,
      measurement: null,
    };
  }

  if (!params.board) {
    return {
      valid: false,
      code: "BOARD_PROFILE_MISSING",
      errors: ["Controller board profile is missing."],
      warnings: [],
      driver,
      measurement,
    };
  }

  const profile = deriveBoardHardwareCapabilityProfile(params.board);
  const boardCheck = evaluateBoardDriverCompatibility(params.board, driver.id, profile);
  if (!boardCheck.supported) {
    return {
      valid: false,
      code: "BOARD_HARDWARE_UNSUPPORTED",
      errors: boardCheck.reasons,
      warnings: [],
      driver,
      measurement,
    };
  }

  const warnings: string[] = [];
  const otherSensors = params.existingSensorsOnController.filter(
    (s) => s.id !== params.editingSensorId
  );

  // Validate I2C address format & address collisions across distinct drivers on the shared I2C bus
  let normalizedAddr: string | null = null;
  if (driver.interface === "i2c") {
    if (params.i2cAddress && params.i2cAddress.trim()) {
      normalizedAddr = normalizeI2cAddress(params.i2cAddress);
      if (!normalizedAddr) {
        return {
          valid: false,
          code: "GPIO_OR_BUS_INVALID",
          errors: [
            `Invalid 7-bit I2C address "${params.i2cAddress}". Expected hex between 0x08 and 0x77 (e.g., ${driver.busConfig.defaultAddresses?.join(" or ")}).`,
          ],
          warnings,
          driver,
          measurement,
        };
      }
    } else if (driver.busConfig.defaultAddresses && driver.busConfig.defaultAddresses.length > 0) {
      normalizedAddr = normalizeI2cAddress(driver.busConfig.defaultAddresses[0]);
    }

    for (const peer of otherSensors) {
      const peerDrv = getSensorDriverForMeasurement(peer.sensor_type);
      if (!peerDrv || peerDrv.interface !== "i2c") continue;
      const peerAddr =
        normalizeI2cAddress(peer.i2c_address) ??
        normalizeI2cAddress(peerDrv.busConfig.defaultAddresses?.[0]);

      // Two DIFFERENT physical I2C drivers cannot occupy the exact same I2C address on the same bus.
      if (normalizedAddr && peerAddr && normalizedAddr === peerAddr) {
        if (peerDrv.id !== driver.id) {
          return {
            valid: false,
            code: "I2C_ADDRESS_CONFLICT",
            errors: [
              `I2C address ${normalizedAddr} is already used by ${peer.name} (${peerDrv.displayName}) on this controller.`,
            ],
            warnings,
            driver,
            measurement,
          };
        }
        // Same driver (e.g. BME280): allow sibling measurements (temp + humidity + pressure),
        // reject duplicate identical measurement at the same address.
        if (peer.sensor_type === measurement.sensorType) {
          return {
            valid: false,
            code: "I2C_ADDRESS_CONFLICT",
            errors: [
              `A ${measurement.displayName} sensor is already configured at I2C address ${normalizedAddr} ("${peer.name}"). Use an alternate address (e.g., ${driver.busConfig.defaultAddresses?.find((a) => a.toLowerCase() !== normalizedAddr) ?? "alternate hex address"}) for a second device.`,
            ],
            warnings,
            driver,
            measurement,
          };
        }
      }
    }
  }

  // Validate GPIO pin assignment (when provided, or required for non-I2C sensors)
  const pin = params.gpioPin ?? null;
  if (pin !== null) {
    // Determine which existing pins actually conflict with this sensor:
    // - Non-sensor entities (switches, devices) ALWAYS conflict
    // - Other sensors conflict UNLESS:
    //   (a) BOTH are I2C sensors (sharing the controller's I2C bus SDA pin!), OR
    //   (b) BOTH belong to the same physical driver with allowSharedPinWithSameDriver
    //       (e.g., DHT22 temperature + humidity on the same GPIO, or 1-Wire DS18B20 bus)
    //       AND for DHT22 they are different measurements (not duplicate temperature_dht22).
    const conflictingSensorPins: number[] = [];
    for (const peer of otherSensors) {
      if (peer.gpio_pin === null) continue;
      if (peer.gpio_pin !== pin) {
        conflictingSensorPins.push(peer.gpio_pin);
        continue;
      }
      const peerDrv = getSensorDriverForMeasurement(peer.sensor_type);
      const canShareI2c =
        driver.allowSharedI2cBus && peerDrv?.allowSharedI2cBus === true;
      const canShareSameDriver =
        driver.allowSharedPinWithSameDriver &&
        peerDrv?.id === driver.id &&
        (driver.interface === "onewire" || peer.sensor_type !== measurement.sensorType);

      if (!canShareI2c && !canShareSameDriver) {
        conflictingSensorPins.push(peer.gpio_pin);
      }
    }

    const usedPinsForValidation = Array.from(
      new Set([...params.usedPinsByNonSensors, ...conflictingSensorPins])
    );

    const primaryReq: PinOperationRequirement =
      driver.interface === "adc"
        ? "adc"
        : driver.interface === "i2c"
          ? "i2c"
          : "digital_in";

    const pinCheck = validateGpioAssignment({
      board: params.board,
      pin,
      requirement: primaryReq,
      usedPinsOnController: usedPinsForValidation,
    });

    if (!pinCheck.valid) {
      return {
        valid: false,
        code: "GPIO_OR_BUS_INVALID",
        errors: pinCheck.errors,
        warnings: pinCheck.warnings,
        driver,
        measurement,
      };
    }

    // Extra hardware check: DHT22 & DS18B20 require bidirectional GPIO (digital_in + digital_out, NOT input-only!)
    const pinDef = params.board.gpio_definitions.find((g) => g.pin === pin);
    if (
      pinDef &&
      driver.requiresBidirectionalGpio &&
      (pinDef.restrictions.input_only || !pinDef.capabilities.digital_out)
    ) {
      return {
        valid: false,
        code: "GPIO_OR_BUS_INVALID",
        errors: [
          `GPIO ${pin} is input-only and cannot drive ${driver.displayName}, which requires bidirectional GPIO signaling.`,
        ],
        warnings: pinCheck.warnings,
        driver,
        measurement,
      };
    }

    // Extra hardware check: onboard relay/buzzer circuitry pins cannot serve as sensor inputs
    if (
      profile.onboardPeripherals.relays.includes(pin) ||
      profile.onboardPeripherals.buzzers.includes(pin)
    ) {
      return {
        valid: false,
        code: "GPIO_OR_BUS_INVALID",
        errors: [
          `GPIO ${pin} is hardwired to onboard output circuitry on ${params.board.model} and cannot be used for ${driver.displayName}.`,
        ],
        warnings: pinCheck.warnings,
        driver,
        measurement,
      };
    }

    warnings.push(...pinCheck.warnings);
  } else if (driver.interface !== "i2c") {
    return {
      valid: false,
      code: "GPIO_OR_BUS_INVALID",
      errors: [`A GPIO pin is required for ${driver.displayName}.`],
      warnings,
      driver,
      measurement,
    };
  }

  // Enforce installed firmware driver manifest support (authoritative, never bypassed)
  const fw = params.installedFirmware;
  if (fw.state === "no_firmware_installed") {
    return {
      valid: false,
      code: "FIRMWARE_NOT_INSTALLED",
      errors: [
        fw.reason ??
          `Controller does not report an installed firmware version with verified sensor drivers. Flash a compatible ${params.board.model} firmware release first.`,
      ],
      warnings,
      driver,
      measurement,
    };
  }

  if (fw.state !== "manifest_verified") {
    return {
      valid: false,
      code: "FIRMWARE_MANIFEST_MISSING",
      errors: [
        fw.reason ??
          `Installed firmware does not include a verified sensor driver manifest. Update firmware before adding ${measurement.displayName}.`,
      ],
      warnings,
      driver,
      measurement,
    };
  }

  if (
    !fw.compiledDriverIds.includes(driver.id) ||
    !fw.supportedSensorTypes.includes(measurement.sensorType)
  ) {
    return {
      valid: false,
      code: "FIRMWARE_DRIVER_UNSUPPORTED",
      errors: [
        `Installed firmware v${fw.firmwareVersion} does not include the ${driver.displayName} driver required for ${measurement.displayName}. Update the controller firmware to enable this sensor.`,
      ],
      warnings,
      driver,
      measurement,
    };
  }

  return {
    valid: true,
    code: "OK",
    errors: [],
    warnings,
    driver,
    measurement,
  };
}

/** Helper for test/seed/build fixtures: creates a complete driver manifest for a board/release. */
export function buildFirmwareDriverManifest(params: {
  firmwareVersion: string;
  chipFamily: ChipFamily;
  targetBoardSlug: string | null;
  partitionScheme?: PartitionScheme | null;
  flashSizeMb?: number | null;
  psramMode?: PsramMode | null;
  driverIds?: readonly SensorDriverId[];
  manifestHash?: string;
  releaseId?: string | null;
  idfVersion?: string | null;
  ciCommitSha?: string | null;
}): FirmwareDriverManifest {
  const requested = params.driverIds ?? SENSOR_DRIVER_IDS;
  const drivers: FirmwareDriverEntry[] = [];
  const supported = new Set<SupportedSensorType>();

  for (const id of requested) {
    const reg = getSensorDriverById(id);
    if (!reg) continue;
    if (!(reg.supportedChipFamilies as readonly string[]).includes(params.chipFamily)) {
      continue;
    }
    drivers.push({
      id: reg.id,
      version: reg.driverVersion,
      measurements: [...reg.measurements],
      kconfig_flag: reg.kconfigFlag,
      status: "compiled",
    });
    for (const m of reg.measurements) supported.add(m);
  }

  return {
    manifest_version: FIRMWARE_DRIVER_MANIFEST_VERSION,
    ...(params.manifestHash ? { manifest_hash: params.manifestHash } : {}),
    release_id: params.releaseId ?? null,
    firmware_version: params.firmwareVersion,
    target_board_slug: params.targetBoardSlug,
    chip_family: params.chipFamily,
    partition_scheme: params.partitionScheme ?? null,
    flash_size_mb: params.flashSizeMb ?? null,
    psram_mode: params.psramMode ?? null,
    sensor_drivers: drivers,
    supported_sensor_types: SUPPORTED_SENSOR_TYPES.filter((t) => supported.has(t)),
    build_verification: {
      verified: true,
      verifier: "homecoreos-verify-firmware-image",
      ci_commit_sha: params.ciCommitSha ?? null,
      idf_version: params.idfVersion ?? null,
    },
  };
}
