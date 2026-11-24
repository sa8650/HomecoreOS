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
  "dht11",
  "sht3x",
  "aht20",
  "tmp117",
  "ld2410",
  "ld2450",
  "veml7700",
  "sgp30",
  "water_leak",
  "water_level",
  "soil_moisture",
  "rain",
  "ina219",
  "ina226",
  "pzem004t",
  "sct013",
  "mq2",
  "mq135",
] as const;

export type SensorDriverId = (typeof SENSOR_DRIVER_IDS)[number];

export type SensorInterfaceKind =
  | "gpio_digital_in"
  | "gpio_single_wire"
  | "onewire"
  | "i2c"
  | "uart"
  | "spi"
  | "adc";

export type SensorHardwareVerificationStatus =
  | "implemented_unverified"
  | "bench_verified"
  | "planned";

/** Logical grouping used by the sensor picker — never a hardware claim. */
export const SENSOR_CATEGORIES = [
  { id: "climate", displayName: "Temperature & Humidity", description: "Air temperature and relative humidity probes." },
  { id: "motion", displayName: "Motion & Occupancy", description: "PIR and mmWave presence detection." },
  { id: "contact", displayName: "Contact & Leak", description: "Dry-contact, reed and water-leak inputs." },
  { id: "light", displayName: "Light", description: "Ambient illuminance sensors." },
  { id: "air_quality", displayName: "Air Quality", description: "Volatile organics and equivalent CO2 estimates." },
  { id: "water", displayName: "Water & Leak", description: "Contact and analog water sensing." },
  { id: "energy", displayName: "Energy Monitoring", description: "Voltage, current, power and energy metering." },
  { id: "garden", displayName: "Garden & Outdoor", description: "Soil moisture and rain sensing." },
  { id: "gas", displayName: "Gas Monitoring", description: "Qualitative MQ-series gas modules (not safety rated)." },
] as const;

export type SensorCategoryId = (typeof SENSOR_CATEGORIES)[number]["id"];

/**
 * A *physical* pin or bus role required by one hardware model. This is the
 * authoritative vocabulary shared by frontend pin pickers, Worker validation
 * and firmware configuration generation.
 */
export type SensorPinRole =
  | "gpio_in"
  | "gpio_out"
  | "gpio_bidirectional"
  | "onewire"
  | "i2c_sda"
  | "i2c_scl"
  | "uart_tx"
  | "uart_rx"
  | "spi_sclk"
  | "spi_mosi"
  | "spi_miso"
  | "spi_cs"
  | "adc";

export type SensorBusKind = "none" | "gpio" | "onewire" | "i2c" | "uart" | "spi" | "adc";

export interface SensorDriverResourceDefinition {
  /** The bus this physical driver communicates over. */
  bus: SensorBusKind;
  /** Every required signal role. Multi-role drivers declare every pin. */
  roles: readonly SensorPinRole[];
  /** Board capability required for each role. */
  requiredCapabilities: Partial<Record<SensorPinRole, PinOperationRequirement>>;
  /** Whether pins/bus can be reused, and under which constraints. */
  sharing: "exclusive" | "multidrop" | "addressed_bus" | "shared_bus";
  /** Documented default roles, used only when the board profile confirms them. */
  defaultPins?: Partial<Record<SensorPinRole, number>>;
  notes?: string;
}

/** Model-specific protocol/decoding configuration inside a shared driver family. */
export interface SensorModelProfile {
  model: string;
  protocolFamily: string;
  /** Chip ID registers / expected IDs, when the protocol exposes them. */
  expectedChipIds?: readonly string[];
  defaultI2cAddresses?: readonly string[];
  accuracy?: string;
  notes?: string;
}

export interface SensorResourcesConfig {
  driverId?: string;
  model?: string;
  busId?: string | null;
  pins?: Partial<Record<SensorPinRole, number | null>>;
  i2cAddress?: string | null;
  inverted?: boolean;
}

export interface SensorDriverBusConfig {
  kind: "gpio" | "onewire" | "i2c" | "uart" | "spi" | "adc";
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
  requiredInterfaces: readonly ("gpio" | "single_wire" | "onewire" | "i2c" | "uart" | "spi" | "adc")[];
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
  /** Category shown first in the sensor picker. */
  category?: SensorCategoryId;
  /** Shared protocol implementation family (e.g. `dht_single_wire`). */
  protocolFamily?: string;
  /** Authoritative hardware resource declaration. */
  resources?: SensorDriverResourceDefinition;
  /** Model-specific configuration and decoding profiles. */
  modelProfiles?: readonly SensorModelProfile[];
  /** Accuracy / calibration / safety caveats shown in the UI. */
  limitations?: string;
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

const RES_I2C: SensorDriverResourceDefinition = {
  bus: "i2c",
  roles: ["i2c_sda", "i2c_scl"],
  requiredCapabilities: { i2c_sda: "i2c", i2c_scl: "i2c" },
  sharing: "addressed_bus",
  notes: "SDA/SCL may be shared; every device on the bus needs a unique 7-bit address.",
};
const RES_UART: SensorDriverResourceDefinition = {
  bus: "uart",
  roles: ["uart_tx", "uart_rx"],
  requiredCapabilities: { uart_tx: "digital_out", uart_rx: "digital_in" },
  sharing: "exclusive",
  notes: "TX and RX are distinct signal roles; UART buses are not multiplexed.",
};
const RES_ADC: SensorDriverResourceDefinition = {
  bus: "adc",
  roles: ["adc"],
  requiredCapabilities: { adc: "adc" },
  sharing: "exclusive",
  notes: "ESP8266 has exactly one external analog input (A0).",
};
const RES_GPIO_IN: SensorDriverResourceDefinition = {
  bus: "gpio",
  roles: ["gpio_in"],
  requiredCapabilities: { gpio_in: "digital_in" },
  sharing: "exclusive",
};
const RES_ONEWIRE: SensorDriverResourceDefinition = {
  bus: "onewire",
  roles: ["onewire"],
  requiredCapabilities: { onewire: "digital_in" },
  sharing: "multidrop",
  notes: "Multiple 1-Wire probes may share one data line with a single pull-up.",
};
const RES_DHT: SensorDriverResourceDefinition = {
  bus: "gpio",
  roles: ["gpio_bidirectional"],
  requiredCapabilities: { gpio_bidirectional: "digital_in" },
  sharing: "exclusive",
  notes: "One bidirectional GPIO per physical DHT module; requires a pull-up.",
};

const BASE_SENSOR_DRIVER_REGISTRY: readonly SensorDriverDefinition[] = [
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
    category: "climate",
    protocolFamily: "bme280_i2c",
    resources: RES_I2C,
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
    category: "motion",
    protocolFamily: "gpio_digital",
    resources: RES_GPIO_IN,
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
    category: "contact",
    protocolFamily: "gpio_digital",
    resources: RES_GPIO_IN,
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
    category: "light",
    protocolFamily: "bh1750_i2c",
    resources: RES_I2C,
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

// ---------------------------------------------------------------------------
// Expanded physical driver catalog (protocol families + model decoding).
// ---------------------------------------------------------------------------

type NewDriverInput = Omit<
  SensorDriverDefinition,
  | "supportedChipFamilies"
  | "driverVersion"
  | "hardwareVerificationStatus"
  | "allowSharedPinWithSameDriver"
  | "allowSharedI2cBus"
> &
  Partial<Pick<SensorDriverDefinition,
    "supportedChipFamilies" | "driverVersion" | "hardwareVerificationStatus" |
    "allowSharedPinWithSameDriver" | "allowSharedI2cBus">>;

const ESP32_ONLY_CHIPS: readonly ChipFamily[] = [
  "esp32", "esp32s2", "esp32s3", "esp32c2", "esp32c3", "esp32c5", "esp32c6",
  "esp32c61", "esp32h2", "esp32p4",
];

function physicalDriver(input: NewDriverInput): SensorDriverDefinition {
  return {
    supportedChipFamilies: ALL_SENSOR_CAPABLE_CHIPS,
    driverVersion: "1.0.0",
    hardwareVerificationStatus: "implemented_unverified",
    allowSharedPinWithSameDriver: true,
    allowSharedI2cBus: input.interface === "i2c",
    ...input,
  };
}

const EXPANDED_SENSOR_DRIVER_REGISTRY: readonly SensorDriverDefinition[] = [
  physicalDriver({
    id: "dht11", category: "climate", protocolFamily: "dht_single_wire", resources: RES_DHT,
    displayName: "DHT11", shortDescription: "Low-cost single-wire temperature and humidity sensor.",
    supportedModels: ["DHT11", "RHT11"],
    interface: "gpio_single_wire", interfaceLabel: "GPIO (1-Pin Digital)",
    requiredInterfaces: ["gpio", "single_wire"],
    requiredPinCapabilities: ["digital_in", "digital_out"], requiresBidirectionalGpio: true,
    busConfig: { kind: "gpio", requiresPullUp: true, supportsSharedBus: false, minIntervalMs: 2000 },
    idfComponents: ["driver/gpio", "esp_timer", "rom/ets_sys"],
    resourceEstimate: { flashBytes: 2200, ramBytes: 112 },
    measurements: ["temperature_dht11", "humidity_dht11"],
    defaultUnits: { temperature_dht11: "°C", humidity_dht11: "%" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_DHT11",
    modelProfiles: [{ model: "DHT11", protocolFamily: "dht_single_wire", accuracy: "±2 °C / ±5 %RH" }],
    limitations: "DHT11 resolution and accuracy are lower than DHT22; 1 Hz maximum, 2 s sampling recommended.",
  }),
  physicalDriver({
    id: "sht3x", category: "climate", protocolFamily: "sht3x_i2c", resources: RES_I2C,
    displayName: "SHT3x (SHT30/31/35)",
    shortDescription: "Sensirion I2C temperature and humidity family with CRC-protected samples.",
    supportedModels: ["SHT30", "SHT31", "SHT35", "SHT3x"],
    interface: "i2c", interfaceLabel: "I2C",
    requiredInterfaces: ["i2c"], requiredPinCapabilities: ["i2c"], requiresBidirectionalGpio: false,
    busConfig: { kind: "i2c", supportsSharedBus: true, requiresTwoPins: true,
      defaultAddresses: ["0x44", "0x45"], defaultClockHz: 100000, minIntervalMs: 1000 },
    idfComponents: ["driver/i2c_master"],
    resourceEstimate: { flashBytes: 2800, ramBytes: 160 },
    measurements: ["temperature_sht3x", "humidity_sht3x"],
    defaultUnits: { temperature_sht3x: "°C", humidity_sht3x: "%" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_SHT3X",
    modelProfiles: [
      { model: "SHT30", protocolFamily: "sht3x_i2c", defaultI2cAddresses: ["0x44", "0x45"], accuracy: "±2 °C / ±2 %RH" },
      { model: "SHT31", protocolFamily: "sht3x_i2c", defaultI2cAddresses: ["0x44", "0x45"], accuracy: "±2 °C / ±2 %RH" },
      { model: "SHT35", protocolFamily: "sht3x_i2c", defaultI2cAddresses: ["0x44", "0x45"], accuracy: "±1.5 °C / ±1.5 %RH" },
    ],
    limitations: "SHT30/31/35 share one protocol; accuracy differs by model. Heater and high-repeatability modes are not exposed.",
  }),
  physicalDriver({
    id: "aht20", category: "climate", protocolFamily: "aht20_i2c", resources: RES_I2C,
    displayName: "AHT20", shortDescription: "AOSONG I2C temperature and relative humidity sensor.",
    supportedModels: ["AHT20", "AHT10 (compatible command set)"],
    interface: "i2c", interfaceLabel: "I2C",
    requiredInterfaces: ["i2c"], requiredPinCapabilities: ["i2c"], requiresBidirectionalGpio: false,
    busConfig: { kind: "i2c", supportsSharedBus: true, requiresTwoPins: true,
      defaultAddresses: ["0x38"], defaultClockHz: 100000, minIntervalMs: 1000 },
    idfComponents: ["driver/i2c_master"],
    resourceEstimate: { flashBytes: 2400, ramBytes: 128 },
    measurements: ["temperature_aht20", "humidity_aht20"],
    defaultUnits: { temperature_aht20: "°C", humidity_aht20: "%" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_AHT20",
    modelProfiles: [{ model: "AHT20", protocolFamily: "aht20_i2c", expectedChipIds: ["0x38"], accuracy: "±0.3 °C / ±2 %RH (typical)" }],
    limitations: "Requires ~80 ms conversion delay; AHT10 compatibility is not bench verified.",
  }),
  physicalDriver({
    id: "tmp117", category: "climate", protocolFamily: "tmp117_i2c", resources: RES_I2C,
    displayName: "TMP117 Precision Temperature",
    shortDescription: "TI high-accuracy I2C digital temperature sensor.",
    supportedModels: ["TMP117", "TMP116"],
    interface: "i2c", interfaceLabel: "I2C",
    requiredInterfaces: ["i2c"], requiredPinCapabilities: ["i2c"], requiresBidirectionalGpio: false,
    busConfig: { kind: "i2c", supportsSharedBus: true, requiresTwoPins: true,
      defaultAddresses: ["0x48", "0x49", "0x4A", "0x4B"], defaultClockHz: 100000, minIntervalMs: 1000 },
    idfComponents: ["driver/i2c_master"],
    resourceEstimate: { flashBytes: 2000, ramBytes: 96 },
    measurements: ["temperature_tmp117"],
    defaultUnits: { temperature_tmp117: "°C" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_TMP117",
    modelProfiles: [{ model: "TMP117", protocolFamily: "tmp117_i2c", accuracy: "±0.1 °C typical" }],
    limitations: "One measurement per device; address must match the A0/A1 strap of the module.",
  }),
  physicalDriver({
    id: "ld2410", category: "motion", protocolFamily: "ld2410_uart", resources: RES_UART,
    displayName: "LD2410 mmWave Presence",
    shortDescription: "Hi-Link LD2410 UART mmWave presence, motion and target-distance sensor.",
    supportedModels: ["LD2410", "LD2410B", "LD2410C"],
    interface: "uart", interfaceLabel: "UART (TX + RX)",
    requiredInterfaces: ["uart"], requiredPinCapabilities: ["digital_in", "digital_out"],
    requiresBidirectionalGpio: false,
    busConfig: { kind: "uart", supportsSharedBus: false, defaultClockHz: 256000, minIntervalMs: 500 },
    idfComponents: ["driver/uart"],
    resourceEstimate: { flashBytes: 5200, ramBytes: 320 },
    measurements: ["presence_ld2410", "motion_ld2410", "distance_ld2410"],
    defaultUnits: { presence_ld2410: "state", motion_ld2410: "state", distance_ld2410: "cm" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_LD2410",
    supportedChipFamilies: ESP32_ONLY_CHIPS,
    modelProfiles: [{ model: "LD2410", protocolFamily: "ld2410_uart", notes: "Engineering-mode frames used for target data; 256000 baud default." }],
    limitations: "Not available on ESP8266 ( UART resource constraints ). Presence and motion states are heuristic, not safety rated.",
  }),
  physicalDriver({
    id: "ld2450", category: "motion", protocolFamily: "ld2450_uart", resources: RES_UART,
    displayName: "LD2450 mmWave Presence (Planned)",
    shortDescription: "Planned multi-target tracker; no firmware implementation is compiled yet.",
    supportedModels: ["LD2450"],
    interface: "uart", interfaceLabel: "UART (TX + RX)",
    requiredInterfaces: ["uart"], requiredPinCapabilities: ["digital_in", "digital_out"],
    requiresBidirectionalGpio: false,
    busConfig: { kind: "uart", supportsSharedBus: false, minIntervalMs: 500 },
    idfComponents: ["driver/uart"],
    resourceEstimate: { flashBytes: 6400, ramBytes: 384 },
    measurements: ["presence_ld2450"],
    defaultUnits: { presence_ld2450: "state" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_LD2450",
    supportedChipFamilies: ESP32_ONLY_CHIPS,
    hardwareVerificationStatus: "planned",
    modelProfiles: [{ model: "LD2450", protocolFamily: "ld2450_uart", notes: "Protocol implementation is not complete." }],
    limitations: "Planned only. Never selectable on a firmware manifest; do not wire as a supported sensor.",
  }),
  physicalDriver({
    id: "veml7700", category: "light", protocolFamily: "veml_i2c", resources: RES_I2C,
    displayName: "VEML7700 Ambient Light",
    shortDescription: "Vishay I2C ambient light sensor with high dynamic range.",
    supportedModels: ["VEML7700"],
    interface: "i2c", interfaceLabel: "I2C",
    requiredInterfaces: ["i2c"], requiredPinCapabilities: ["i2c"], requiresBidirectionalGpio: false,
    busConfig: { kind: "i2c", supportsSharedBus: true, requiresTwoPins: true,
      defaultAddresses: ["0x10"], defaultClockHz: 100000, minIntervalMs: 500 },
    idfComponents: ["driver/i2c_master"],
    resourceEstimate: { flashBytes: 2200, ramBytes: 128 },
    measurements: ["light_veml7700"],
    defaultUnits: { light_veml7700: "lx" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_VEML7700",
    modelProfiles: [{ model: "VEML7700", protocolFamily: "veml_i2c", defaultI2cAddresses: ["0x10"] }],
    limitations: "Uses default gain/integration time; saturates above the configured range.",
  }),
  physicalDriver({
    id: "sgp30", category: "air_quality", protocolFamily: "sgp30_i2c", resources: RES_I2C,
    displayName: "SGP30 Air Quality",
    shortDescription: "Sensirion SGP30 TVOC and eCO2 gestalt sensor (I2C).",
    supportedModels: ["SGP30"],
    interface: "i2c", interfaceLabel: "I2C",
    requiredInterfaces: ["i2c"], requiredPinCapabilities: ["i2c"], requiresBidirectionalGpio: false,
    busConfig: { kind: "i2c", supportsSharedBus: true, requiresTwoPins: true,
      defaultAddresses: ["0x58"], defaultClockHz: 100000, minIntervalMs: 1000 },
    idfComponents: ["driver/i2c_master"],
    resourceEstimate: { flashBytes: 3200, ramBytes: 192 },
    measurements: ["tvoc_sgp30", "eco2_sgp30"],
    defaultUnits: { tvoc_sgp30: "ppb", eco2_sgp30: "ppm" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_SGP30",
    modelProfiles: [{ model: "SGP30", protocolFamily: "sgp30_i2c", expectedChipIds: ["0xD0"], notes: "Requires baseline warm-up and humidity compensation." }],
    limitations: "TVOC is a total VOC index in ppb; eCO2 is an estimate derived from TVOC, not a calibrated CO2 measurement. Not an air-safety alarm.",
  }),
  physicalDriver({
    id: "water_leak", category: "water", protocolFamily: "threshold_adc", resources: RES_GPIO_IN,
    displayName: "Water Leak Detector",
    shortDescription: "Contact or analog water-leak probe with configurable threshold.",
    supportedModels: ["Generic Water Leak (GPIO)", "Generic Water Leak (ADC)"],
    interface: "gpio_digital_in", interfaceLabel: "GPIO Input",
    requiredInterfaces: ["gpio"], requiredPinCapabilities: ["digital_in"], requiresBidirectionalGpio: false,
    busConfig: { kind: "gpio", requiresPullUp: true, supportsSharedBus: false, debounceMs: 200 },
    idfComponents: ["driver/gpio"],
    resourceEstimate: { flashBytes: 900, ramBytes: 64 },
    measurements: ["water_leak"],
    defaultUnits: { water_leak: "state" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_WATER_LEAK",
    limitations: "Detects presence of conductive path/water at the probe only. Calibration and probe corrosion affect reliability; not a flood-safety certified device.",
  }),
  physicalDriver({
    id: "water_level", category: "water", protocolFamily: "threshold_adc", resources: RES_ADC,
    displayName: "Water Level Sensor",
    shortDescription: "Analog conductive water-level strip read through an ADC input.",
    supportedModels: ["Generic Analog Water Level"],
    interface: "adc", interfaceLabel: "ADC",
    requiredInterfaces: ["adc"], requiredPinCapabilities: ["adc"], requiresBidirectionalGpio: false,
    busConfig: { kind: "adc", supportsSharedBus: false, samplesPerRead: 8, minIntervalMs: 500 },
    idfComponents: ["esp_adc/adc_oneshot", "esp_adc/adc_cali"],
    resourceEstimate: { flashBytes: 1600, ramBytes: 96 },
    measurements: ["water_level"],
    defaultUnits: { water_level: "%" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_WATER_LEVEL",
    limitations: "Raw ADC percentage depends on probe geometry, water conductivity and supply voltage. Must be calibrated in place.",
  }),
  physicalDriver({
    id: "soil_moisture", category: "garden", protocolFamily: "capacitive_adc", resources: RES_ADC,
    displayName: "Capacitive Soil Moisture",
    shortDescription: "Capacitive soil moisture probe read through an ADC input.",
    supportedModels: ["Capacitive Soil Moisture v1.2", "Generic Capacitive Soil Moisture"],
    interface: "adc", interfaceLabel: "ADC",
    requiredInterfaces: ["adc"], requiredPinCapabilities: ["adc"], requiresBidirectionalGpio: false,
    busConfig: { kind: "adc", supportsSharedBus: false, samplesPerRead: 8, minIntervalMs: 1000 },
    idfComponents: ["esp_adc/adc_oneshot", "esp_adc/adc_cali"],
    resourceEstimate: { flashBytes: 1600, ramBytes: 96 },
    measurements: ["soil_moisture"],
    defaultUnits: { soil_moisture: "%" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_SOIL_MOISTURE",
    limitations: "Percent is calibrated dry-to-wet only after user calibration; uncalibrated readings are raw ADC percentages.",
  }),
  physicalDriver({
    id: "rain", category: "garden", protocolFamily: "threshold_adc", resources: RES_GPIO_IN,
    displayName: "Rain Detection",
    shortDescription: "Rain sensor board with digital threshold output.",
    supportedModels: ["Generic Rain Sensor (GPIO)", "FC-37", "YL-83"],
    interface: "gpio_digital_in", interfaceLabel: "GPIO Input",
    requiredInterfaces: ["gpio"], requiredPinCapabilities: ["digital_in"], requiresBidirectionalGpio: false,
    busConfig: { kind: "gpio", supportsSharedBus: false, debounceMs: 500 },
    idfComponents: ["driver/gpio"],
    resourceEstimate: { flashBytes: 900, ramBytes: 64 },
    measurements: ["rain_level"],
    defaultUnits: { rain_level: "state" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_RAIN",
    limitations: "Boolean output depends on the module's on-board comparator threshold; it is not a rainfall rate measurement.",
  }),
  physicalDriver({
    id: "ina219", category: "energy", protocolFamily: "ina2xx_i2c", resources: RES_I2C,
    displayName: "INA219 Current/Power Monitor",
    shortDescription: "TI INA219 I2C shunt monitor: bus voltage, current and power.",
    supportedModels: ["INA219"],
    interface: "i2c", interfaceLabel: "I2C",
    requiredInterfaces: ["i2c"], requiredPinCapabilities: ["i2c"], requiresBidirectionalGpio: false,
    busConfig: { kind: "i2c", supportsSharedBus: true, requiresTwoPins: true,
      defaultAddresses: ["0x40", "0x41", "0x44", "0x45"], defaultClockHz: 100000, minIntervalMs: 500 },
    idfComponents: ["driver/i2c_master"],
    resourceEstimate: { flashBytes: 2800, ramBytes: 160 },
    measurements: ["voltage_ina219", "current_ina219", "power_ina219"],
    defaultUnits: { voltage_ina219: "V", current_ina219: "A", power_ina219: "W" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_INA219",
    supportedChipFamilies: ESP32_ONLY_CHIPS,
    modelProfiles: [{ model: "INA219", protocolFamily: "ina2xx_i2c", notes: "Uses 32 V / ±3.2 A configuration with the board's onboard 0.1 Ω shunt." }],
    limitations: "Accuracy depends on the shunt fitted to the module and its calibration. Not a revenue-grade meter.",
  }),
  physicalDriver({
    id: "ina226", category: "energy", protocolFamily: "ina2xx_i2c", resources: RES_I2C,
    displayName: "INA226 Current/Power Monitor",
    shortDescription: "TI INA226 I2C shunt monitor: bus voltage, current, power and accumulated energy.",
    supportedModels: ["INA226"],
    interface: "i2c", interfaceLabel: "I2C",
    requiredInterfaces: ["i2c"], requiredPinCapabilities: ["i2c"], requiresBidirectionalGpio: false,
    busConfig: { kind: "i2c", supportsSharedBus: true, requiresTwoPins: true,
      defaultAddresses: ["0x40", "0x41", "0x44", "0x45"], defaultClockHz: 100000, minIntervalMs: 500 },
    idfComponents: ["driver/i2c_master"],
    resourceEstimate: { flashBytes: 3200, ramBytes: 192 },
    measurements: ["voltage_ina226", "current_ina226", "power_ina226", "energy_ina226"],
    defaultUnits: { voltage_ina226: "V", current_ina226: "A", power_ina226: "W", energy_ina226: "Wh" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_INA226",
    supportedChipFamilies: ESP32_ONLY_CHIPS,
    modelProfiles: [{ model: "INA226", protocolFamily: "ina2xx_i2c", notes: "Energy is accumulated in firmware from sampled power (Wh)." }],
    limitations: "Default shunt 0.1 Ω and 36 V range. Energy is a firmware estimate and resets on reboot.",
  }),
  physicalDriver({
    id: "pzem004t", category: "energy", protocolFamily: "pzem_uart", resources: RES_UART,
    displayName: "PZEM-004T (Planned)",
    shortDescription: "Planned UART energy meter driver; not compiled in any firmware release.",
    supportedModels: ["PZEM-004T v3"],
    interface: "uart", interfaceLabel: "UART (TX + RX)",
    requiredInterfaces: ["uart"], requiredPinCapabilities: ["digital_in", "digital_out"],
    requiresBidirectionalGpio: false,
    busConfig: { kind: "uart", supportsSharedBus: false, defaultClockHz: 9600, minIntervalMs: 1000 },
    idfComponents: ["driver/uart"],
    resourceEstimate: { flashBytes: 5200, ramBytes: 256 },
    measurements: ["voltage_pzem", "current_pzem", "power_pzem", "energy_pzem"],
    defaultUnits: { voltage_pzem: "V", current_pzem: "A", power_pzem: "W", energy_pzem: "kWh" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_PZEM004T",
    supportedChipFamilies: ESP32_ONLY_CHIPS,
    hardwareVerificationStatus: "planned",
    limitations: "Planned only. Requires mains-safe current transformer wiring; never select on current firmware.",
  }),
  physicalDriver({
    id: "sct013", category: "energy", protocolFamily: "burden_adc", resources: RES_ADC,
    displayName: "SCT-013 Current Transformer (ADC)",
    shortDescription: "SCT-013 clamp with external burden/bias conditioning on an ADC input.",
    supportedModels: ["SCT-013-000", "SCT-013-030"],
    interface: "adc", interfaceLabel: "ADC",
    requiredInterfaces: ["adc"], requiredPinCapabilities: ["adc"], requiresBidirectionalGpio: false,
    busConfig: { kind: "adc", supportsSharedBus: false, samplesPerRead: 16, minIntervalMs: 100 },
    idfComponents: ["esp_adc/adc_oneshot", "esp_adc/adc_cali"],
    resourceEstimate: { flashBytes: 2200, ramBytes: 128 },
    measurements: ["current_sct013"],
    defaultUnits: { current_sct013: "A" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_SCT013",
    supportedChipFamilies: ESP32_ONLY_CHIPS,
    hardwareVerificationStatus: "planned",
    limitations: "Planned only. Requires an external burden resistor and 1.65 V bias; never connect a CT directly to a GPIO. Mains wiring must follow local electrical codes.",
  }),
  physicalDriver({
    id: "mq2", category: "gas", protocolFamily: "mq_adc", resources: RES_ADC,
    displayName: "MQ-2 Gas Module (Qualitative)",
    shortDescription: "Analog MQ-2 module output read through an ADC input.",
    supportedModels: ["MQ-2"],
    interface: "adc", interfaceLabel: "ADC",
    requiredInterfaces: ["adc"], requiredPinCapabilities: ["adc"], requiresBidirectionalGpio: false,
    busConfig: { kind: "adc", supportsSharedBus: false, samplesPerRead: 8, minIntervalMs: 1000 },
    idfComponents: ["esp_adc/adc_oneshot", "esp_adc/adc_cali"],
    resourceEstimate: { flashBytes: 1600, ramBytes: 96 },
    measurements: ["gas_mq2"],
    defaultUnits: { gas_mq2: "%FS" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_MQ2",
    limitations: "NOT a certified gas or fire alarm. Needs burn-in and calibration; output is a qualitative % of full-scale ADC, not a gas concentration.",
  }),
  physicalDriver({
    id: "mq135", category: "gas", protocolFamily: "mq_adc", resources: RES_ADC,
    displayName: "MQ-135 Air Quality Module (Qualitative)",
    shortDescription: "Analog MQ-135 module output read through an ADC input.",
    supportedModels: ["MQ-135"],
    interface: "adc", interfaceLabel: "ADC",
    requiredInterfaces: ["adc"], requiredPinCapabilities: ["adc"], requiresBidirectionalGpio: false,
    busConfig: { kind: "adc", supportsSharedBus: false, samplesPerRead: 8, minIntervalMs: 1000 },
    idfComponents: ["esp_adc/adc_oneshot", "esp_adc/adc_cali"],
    resourceEstimate: { flashBytes: 1600, ramBytes: 96 },
    measurements: ["gas_mq135"],
    defaultUnits: { gas_mq135: "%FS" },
    kconfigFlag: "CONFIG_HOMECORE_DRIVER_MQ135",
    limitations: "NOT a certified air-quality or fire alarm. Cross-sensitive to humidity and temperature; values are uncalibrated %FS only.",
  }),
];

/** Default metadata for the seven original drivers, kept for backward compatibility. */
const LEGACY_DRIVER_RESOURCES: Record<string, SensorDriverResourceDefinition> = {
  dht22: RES_DHT,
  ds18b20: RES_ONEWIRE,
  bme280: RES_I2C,
  pir: RES_GPIO_IN,
  reed: { ...RES_GPIO_IN, notes: "Dry contact with pull-up; one GPIO per contact." },
  bh1750: RES_I2C,
  adc_voltage: RES_ADC,
};
const LEGACY_DRIVER_CATEGORIES: Record<string, SensorCategoryId> = {
  dht22: "climate", ds18b20: "climate", bme280: "climate",
  pir: "motion", reed: "motion", bh1750: "light", adc_voltage: "energy",
};
const LEGACY_DRIVER_PROTOCOLS: Record<string, string> = {
  dht22: "dht_single_wire", ds18b20: "ds18b20_onewire", bme280: "bme280_i2c",
  pir: "gpio_digital", reed: "gpio_digital", bh1750: "bh1750_i2c", adc_voltage: "adc_oneshot",
};

export const SENSOR_DRIVER_REGISTRY: readonly SensorDriverDefinition[] = [
  ...BASE_SENSOR_DRIVER_REGISTRY.map((driver) => ({
    ...driver,
    category: LEGACY_DRIVER_CATEGORIES[driver.id] ?? "climate",
    protocolFamily: LEGACY_DRIVER_PROTOCOLS[driver.id] ?? driver.id,
    resources: LEGACY_DRIVER_RESOURCES[driver.id] ?? RES_GPIO_IN,
    modelProfiles: driver.supportedModels.map((model) => ({
      model,
      protocolFamily: LEGACY_DRIVER_PROTOCOLS[driver.id] ?? driver.id,
    })),
  })),
  ...EXPANDED_SENSOR_DRIVER_REGISTRY,
];

/** Drivers with a compiled firmware implementation; `planned` never appears here. */
export const IMPLEMENTED_SENSOR_DRIVER_IDS: readonly SensorDriverId[] = SENSOR_DRIVER_REGISTRY
  .filter((d) => d.hardwareVerificationStatus !== "planned")
  .map((d) => d.id);

export function getSensorCategory(id: string): (typeof SENSOR_CATEGORIES)[number] | undefined {
  return SENSOR_CATEGORIES.find((c) => c.id === id);
}

export function getSensorDriverResources(driverId: string): SensorDriverResourceDefinition | null {
  return getSensorDriverById(driverId)?.resources ?? null;
}

export function getSensorModels(driverId: string): readonly string[] {
  return getSensorDriverById(driverId)?.supportedModels ?? [];
}

export function getMeasurementOptionsForDriver(
  driverId: string
): readonly SensorMeasurementDefinition[] {
  return SENSOR_MEASUREMENT_REGISTRY.filter((m) => m.driverId === driverId);
}

/** True when measurements belong to one physical driver instance. */
export function areMeasurementsSamePhysicalDriver(...types: string[]): boolean {
  if (types.length < 2) return true;
  const ids = types.map((t) => getSensorDriverForMeasurement(t)?.id ?? null);
  return ids.every((id) => id !== null && id === ids[0]);
}


const BASE_SENSOR_MEASUREMENT_REGISTRY: readonly SensorMeasurementDefinition[] = [
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

interface MeasurementSemantics {
  name: string;
  description: string;
  kind?: "numeric" | "boolean";
}

const EXPANDED_MEASUREMENT_SEMANTICS: Record<string, MeasurementSemantics> = {
  temperature_dht11: { name: "Temperature (DHT11)", description: "Air temperature from a DHT11 single-wire module (±2 °C typical)." },
  humidity_dht11: { name: "Humidity (DHT11)", description: "Relative humidity from the same DHT11 module (±5 %RH typical)." },
  temperature_sht3x: { name: "Temperature (SHT3x)", description: "Temperature from SHT30/31/35; shares one physical I2C module." },
  humidity_sht3x: { name: "Humidity (SHT3x)", description: "Relative humidity from the same SHT3x module." },
  temperature_aht20: { name: "Temperature (AHT20)", description: "Temperature from the AHT20 I2C module." },
  humidity_aht20: { name: "Humidity (AHT20)", description: "Relative humidity from the same AHT20 module." },
  temperature_tmp117: { name: "Temperature (TMP117)", description: "High-accuracy temperature from a TMP117 I2C sensor." },
  presence_ld2410: { name: "Presence (LD2410)", description: "Presence state from the LD2410 mmWave target data frame.", kind: "boolean" },
  motion_ld2410: { name: "Motion (LD2410)", description: "Moving-target state reported by the same LD2410 module.", kind: "boolean" },
  distance_ld2410: { name: "Target Distance (LD2410)", description: "Distance to the strongest detected target in centimetres." },
  presence_ld2450: { name: "Presence (LD2450, planned)", description: "Planned multi-target tracker; no compiled firmware support.", kind: "boolean" },
  light_veml7700: { name: "Ambient Light (VEML7700)", description: "Illuminance from the VEML7700 I2C sensor in lux." },
  tvoc_sgp30: { name: "TVOC (SGP30)", description: "Total VOC index in ppb; qualitative, not a safety measurement." },
  eco2_sgp30: { name: "eCO₂ (SGP30)", description: "CO₂-equivalent estimate in ppm derived from TVOC — not a calibrated CO₂ reading." },
  water_leak: { name: "Water Leak", description: "Detected water/conductive path at the probe (calibration required).", kind: "boolean" },
  water_level: { name: "Water Level", description: "Raw ADC water-level percentage from a conductive level strip." },
  voltage_ina219: { name: "Bus Voltage (INA219)", description: "Bus voltage from INA219; shares the physical monitor." },
  current_ina219: { name: "Current (INA219)", description: "Shunt current from INA219; shares the physical monitor." },
  power_ina219: { name: "Power (INA219)", description: "Calculated power from INA219." },
  voltage_ina226: { name: "Bus Voltage (INA226)", description: "Bus voltage from INA226; shares the physical monitor." },
  current_ina226: { name: "Current (INA226)", description: "Shunt current from INA226; shares the physical monitor." },
  power_ina226: { name: "Power (INA226)", description: "Calculated power from INA226." },
  energy_ina226: { name: "Energy (INA226)", description: "Firmware-accumulated energy in Wh; resets on reboot." },
  voltage_pzem: { name: "Voltage (PZEM-004T, planned)", description: "Planned UART energy meter; not compiled." },
  current_pzem: { name: "Current (PZEM-004T, planned)", description: "Planned UART energy meter; not compiled." },
  power_pzem: { name: "Power (PZEM-004T, planned)", description: "Planned UART energy meter; not compiled." },
  energy_pzem: { name: "Energy (PZEM-004T, planned)", description: "Planned UART energy meter; not compiled." },
  current_sct013: { name: "Current (SCT-013)", description: "Current from an externally conditioned CT on an ADC input." },
  soil_moisture: { name: "Soil Moisture", description: "Capacitive soil moisture, dry-to-wet percentage after calibration." },
  rain_level: { name: "Rain Detected", description: "Boolean rain state from a comparator-based rain module.", kind: "boolean" },
  gas_mq2: { name: "MQ-2 Gas (Qualitative)", description: "Uncalibrated %FS ADC reading. NOT a gas or fire alarm." },
  gas_mq135: { name: "MQ-135 Air Quality (Qualitative)", description: "Uncalibrated %FS ADC reading. NOT an air-safety alarm." },
};

const EXPANDED_SENSOR_MEASUREMENT_REGISTRY: readonly SensorMeasurementDefinition[] =
  EXPANDED_SENSOR_DRIVER_REGISTRY.flatMap((driver) =>
    driver.measurements.map((sensorType) => {
      const semantics = EXPANDED_MEASUREMENT_SEMANTICS[sensorType];
      return {
        sensorType,
        driverId: driver.id,
        displayName: semantics?.name ?? sensorType,
        shortDescription: semantics?.description ?? driver.shortDescription,
        interfaceLabel: driver.interfaceLabel,
        defaultUnit: driver.defaultUnits[sensorType] ?? "unit",
        valueKind: semantics?.kind ?? "numeric",
      };
    })
  );

export const SENSOR_MEASUREMENT_REGISTRY: readonly SensorMeasurementDefinition[] = [
  ...BASE_SENSOR_MEASUREMENT_REGISTRY,
  ...EXPANDED_SENSOR_MEASUREMENT_REGISTRY,
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
 * The board's *documented* default I2C bus, resolved only from data the board
 * profile actually documents (header pad names/aliases and GPIO definition
 * text). Unlike {@link deriveBoardHardwareCapabilityProfile}, this never
 * invents a pair from the pool of I2C-capable pins — callers that need to
 * draw wiring (the Wire Diagram) must not see a bus that was never documented.
 */
export function findDocumentedI2cBus(
  board: Pick<BoardProfileSpec, "board_layout" | "gpio_definitions">
): { sdaPin: number | null; sclPin: number | null } {
  const usableI2cSet = new Set(
    (board.gpio_definitions ?? [])
      .filter((g) => g.capabilities?.i2c && !g.restrictions?.reserved)
      .map((g) => g.pin)
  );
  const { sdaPin, sclPin } = findDefaultI2cPinsFromLayout(board, usableI2cSet);
  // Drop the "lowest two I2C-capable pins" fallback: it documents nothing.
  const hasDocumentedPin = (pin: number): boolean => {
    const layout = board.board_layout;
    const pins = [
      ...(layout?.leftHeader?.pins ?? []),
      ...(layout?.rightHeader?.pins ?? []),
      ...(layout?.extraPads?.pins ?? []),
    ];
    const fromHeader = pins.some(
      (hp) =>
        hp.gpioPin === pin &&
        [hp.pinName, ...(hp.aliases ?? [])]
          .join(" ")
          .toUpperCase()
          .match(/\b(I2C_?SDA|SDA|I2C_?SCL|SCL)\b/)
    );
    if (fromHeader) return true;
    return (board.gpio_definitions ?? []).some((def) => {
      if (def.pin !== pin) return false;
      const text = `${def.label} ${def.board_pin_name ?? ""} ${def.board_note ?? ""}`.toUpperCase();
      return /\b(I2C_?SDA|SDA|I2C_?SCL|SCL)\b/.test(text);
    });
  };
  const sdaOk = sdaPin !== null && hasDocumentedPin(sdaPin);
  const sclOk = sclPin !== null && hasDocumentedPin(sclPin);
  return {
    sdaPin: sdaOk ? sdaPin : null,
    sclPin: sclOk ? sclPin : null,
  };
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
      if (reg.hardwareVerificationStatus === "planned") {
        errors.push(
          `Driver "${driverIdRaw}" is catalog-only (planned) and cannot be claimed as compiled firmware support.`
        );
        continue;
      }
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

  if (driver.interface === "uart") {
    availablePins = profile.pins.uart;
    if (availablePins.length < 2) {
      reasons.push(
        `${boardLabel} does not expose two usable UART pins (TX + RX) for ${driver.displayName}.`
      );
    }
  } else if (driver.interface === "spi") {
    availablePins = profile.pins.spi;
    if (!profile.interfaces.supportsSpi || availablePins.length < 4) {
      reasons.push(
        `${boardLabel} does not expose the four SPI lines needed by ${driver.displayName}.`
      );
    }
  } else if (driver.interface === "adc") {
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
  driver_id?: string | null;
  resources?: SensorResourcesConfig | null;
}


// ---------------------------------------------------------------------------
// Driver-aware hardware resource allocation
// ---------------------------------------------------------------------------

export interface ResolvedSensorResources {
  driverId: SensorDriverId;
  model: string | null;
  bus: SensorBusKind;
  busId: string | null;
  pins: Partial<Record<SensorPinRole, number>>;
  i2cAddress: string | null;
}

export interface SensorResourceAllocationInput {
  id: string;
  name: string;
  kind: "sensor" | "switch" | "device";
  sensorType?: string | null;
  driverId?: string | null;
  resources?: SensorResourcesConfig | null;
  gpioPin?: number | null;
  i2cAddress?: string | null;
}

export interface SensorResourceValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  resolved: ResolvedSensorResources | null;
}

const EXCLUSIVE_ROLES: readonly SensorPinRole[] = [
  "gpio_in", "gpio_out", "gpio_bidirectional", "adc", "uart_tx", "uart_rx",
  "spi_cs",
];

function documentedBusForBoard(board: BoardProfileSpec): { sdaPin: number | null; sclPin: number | null } {
  return findDocumentedI2cBus(board);
}

/**
 * Turns a stored/UI resource configuration into one canonical binding. Never
 * invents bus pins: an I2C bus is complete only when both SDA and SCL are
 * documented by the board (or explicitly configured with valid capabilities).
 */
export function resolveSensorResources(params: {
  board: BoardProfileSpec;
  sensorType?: string | null;
  driverId?: string | null;
  resources?: SensorResourcesConfig | null;
  legacyPin?: number | null;
  legacyI2cAddress?: string | null;
}): SensorResourceValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const explicitDriver = params.driverId && isSensorDriverId(params.driverId)
    ? getSensorDriverById(params.driverId) ?? null
    : null;
  const measuredDriver = params.sensorType
    ? getSensorDriverForMeasurement(params.sensorType) ?? null
    : null;
  const driver = explicitDriver ?? measuredDriver;
  if (!driver) {
    return { valid: false, errors: ["Unknown physical sensor driver."], warnings, resolved: null };
  }
  if (explicitDriver && measuredDriver && explicitDriver.id !== measuredDriver.id) {
    errors.push(
      `Hardware model ${explicitDriver.displayName} cannot produce ${params.sensorType}; expected ${measuredDriver.displayName}.`
    );
  }
  if (params.sensorType && !(driver.measurements as readonly string[]).includes(params.sensorType)) {
    errors.push(`${params.sensorType} is not a measurement of ${driver.displayName}.`);
  }

  const cfg = params.resources ?? {};
  const def = driver.resources!;
  const pins: Partial<Record<SensorPinRole, number>> = {};
  for (const role of def.roles) {
    const value = cfg.pins?.[role];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) pins[role] = value;
  }
  const legacyPin = typeof params.legacyPin === "number" ? params.legacyPin : null;
  const legacyAddress = normalizeI2cAddress(params.legacyI2cAddress ?? cfg.i2cAddress ?? null);
  const model = cfg.model && driver.supportedModels.includes(cfg.model) ? cfg.model : null;
  if (cfg.model && !model) {
    errors.push(`Model "${cfg.model}" is not supported by ${driver.displayName}.`);
  }

  let busId: string | null = cfg.busId?.trim() || null;
  let address = legacyAddress ?? normalizeI2cAddress(cfg.i2cAddress ?? null);

  if (def.bus === "i2c") {
    const documented = documentedBusForBoard(params.board);
    if (legacyPin !== null && pins.i2c_sda === undefined) pins.i2c_sda = legacyPin;
    if (pins.i2c_sda === undefined && documented.sdaPin !== null) pins.i2c_sda = documented.sdaPin;
    if (pins.i2c_scl === undefined && documented.sclPin !== null) pins.i2c_scl = documented.sclPin;
    if (!address) {
      address = normalizeI2cAddress(driver.busConfig.defaultAddresses?.[0] ?? null);
      if (!address) errors.push(`${driver.displayName} requires a valid 7-bit I2C address.`);
    }
    if (driver.busConfig.defaultAddresses?.length && address) {
      const allowed = driver.busConfig.defaultAddresses.map((a) => normalizeI2cAddress(a));
      if (!allowed.includes(address)) {
        warnings.push(`I2C address ${address} is not one of the documented defaults for ${driver.displayName}. Verify the module's address straps.`);
      }
    }
    if (pins.i2c_sda === undefined || pins.i2c_scl === undefined) {
      errors.push(`${params.board.model} does not document both I2C pins (SDA + SCL). Configure a documented bus instead.`);
    } else if (pins.i2c_sda === pins.i2c_scl) {
      errors.push("I2C SDA and SCL must be two distinct pins.");
    }
    busId = `i2c:${pins.i2c_sda ?? "?"}:${pins.i2c_scl ?? "?"}`;
  } else if (def.bus === "onewire") {
    const oneWirePin = pins.onewire ?? legacyPin;
    if (oneWirePin === null || oneWirePin === undefined) {
      errors.push(`${driver.displayName} requires one 1-Wire data pin.`);
    } else {
      pins.onewire = oneWirePin;
      busId = `onewire:${oneWirePin}`;
    }
  } else if (def.bus === "uart") {
    if (pins.uart_tx === undefined || pins.uart_rx === undefined) {
      errors.push(`${driver.displayName} requires distinct UART TX and RX pins.`);
    } else if (pins.uart_tx === pins.uart_rx) {
      errors.push("UART TX and RX must be assigned to distinct pins.");
    } else {
      busId = `uart:${pins.uart_tx}:${pins.uart_rx}`;
    }
  } else if (def.bus === "spi") {
    if (def.roles.some((r) => pins[r] === undefined)) {
      errors.push(`${driver.displayName} requires every SPI line (SCLK, MOSI, MISO, CS).`);
    } else {
      busId = `spi:${pins.spi_sclk}:${pins.spi_mosi}:${pins.spi_miso}`;
    }
  } else {
    const primary = def.roles[0]!;
    const chosen = pins[primary] ?? legacyPin;
    if (chosen === null || chosen === undefined) {
      errors.push(`${driver.displayName} requires a ${primary.replace(/_/g, " ")} pin.`);
    } else {
      pins[primary] = chosen;
    }
  }

  // Every declared role is checked against the board's documented hardware.
  for (const role of def.roles) {
    const pin = pins[role];
    if (pin === undefined) continue;
    const requirement = def.requiredCapabilities[role] ?? (role === "adc" ? "adc" : "digital_in");
    const result = validateGpioAssignment({
      board: params.board,
      pin,
      requirement,
      usedPinsOnController: [],
    });
    if (!result.valid) {
      errors.push(`${driver.displayName} ${role.replace(/_/g, " ")} on GPIO${pin}: ${result.errors.join(" ")}`);
    }
    warnings.push(...result.warnings.map((w) => `${role.replace(/_/g, " ")} GPIO${pin}: ${w}`));
    const pinDef = params.board.gpio_definitions.find((g) => g.pin === pin);
    if (driver.requiresBidirectionalGpio && pinDef && (pinDef.restrictions.input_only || !pinDef.capabilities.digital_out)) {
      errors.push(`GPIO${pin} is input-only; ${driver.displayName} needs bidirectional GPIO.`);
    }
    if (role === "adc" && pinDef && !pinDef.capabilities.adc) {
      errors.push(`GPIO${pin} is not an ADC channel on ${params.board.model}.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    resolved: errors.length === 0 ? {
      driverId: driver.id,
      model,
      bus: def.bus,
      busId,
      pins,
      i2cAddress: address,
    } : null,
  };
}

/**
 * Authoritative conflict check across all drivers/entities on a controller.
 * Shared I2C buses and shared 1-Wire buses are explicitly allowed; incompatible
 * GPIO, UART, SPI and ADC reuse is rejected with a named explanation.
 */
export function validateSensorResourceAssignments(params: {
  board: BoardProfileSpec;
  candidate: SensorResourceAllocationInput;
  allocations: readonly SensorResourceAllocationInput[];
}): SensorResourceValidationResult {
  const resolved = resolveSensorResources({
    board: params.board,
    sensorType: params.candidate.sensorType,
    driverId: params.candidate.driverId,
    resources: params.candidate.resources,
    legacyPin: params.candidate.gpioPin,
    legacyI2cAddress: params.candidate.i2cAddress,
  });
  if (!resolved.valid || !resolved.resolved) return resolved;
  const target = resolved.resolved;
  const targetDriver = getSensorDriverById(target.driverId)!;
  const def = targetDriver.resources!;
  const errors: string[] = [...resolved.errors];
  const warnings: string[] = [...resolved.warnings];

  const peers = params.allocations.filter((a) => a.id !== params.candidate.id);
  const occupiedPins = new Map<number, string[]>();
  const addOccupied = (pin: number | null | undefined, label: string) => {
    if (typeof pin !== "number") return;
    const list = occupiedPins.get(pin) ?? [];
    list.push(label);
    occupiedPins.set(pin, list);
  };

  for (const peer of peers) {
    const peerDriver = peer.driverId && isSensorDriverId(peer.driverId)
      ? getSensorDriverById(peer.driverId) ?? null
      : peer.sensorType ? getSensorDriverForMeasurement(peer.sensorType) ?? null : null;
    if (peer.kind !== "sensor" || !peerDriver) {
      addOccupied(peer.gpioPin, `${peer.kind} "${peer.name}"`);
      continue;
    }

    const peerResolved = resolveSensorResources({
      board: params.board,
      sensorType: peer.sensorType,
      driverId: peer.driverId,
      resources: peer.resources,
      legacyPin: peer.gpioPin,
      legacyI2cAddress: peer.i2cAddress,
    });
    if (!peerResolved.resolved) {
      addOccupied(peer.gpioPin, `sensor "${peer.name}" (partially configured)`);
      continue;
    }
    const other = peerResolved.resolved;
    const otherDef = getSensorDriverById(other.driverId)!.resources!;

    if (def.bus === "i2c" && otherDef.bus === "i2c") {
      const sameBus = target.busId === other.busId;
      if (!sameBus) {
        errors.push(
          `${targetDriver.displayName} (${peer.name}) cannot share a different I2C bus: ${peer.name} uses ${other.busId ?? "an undocumented bus"}.`
        );
      } else if (target.i2cAddress && other.i2cAddress && target.i2cAddress === other.i2cAddress) {
        if (target.driverId === other.driverId && params.candidate.sensorType !== peer.sensorType) {
          // Sibling measurements of one physical module legitimately share the address.
          warnings.push(`${peer.name} shares physical I2C device ${target.i2cAddress} with this measurement.`);
        } else {
          errors.push(
            `I2C address ${target.i2cAddress} is already used by "${peer.name}" on ${target.busId}. Each physical device needs a unique address.`
          );
        }
      }
      continue;
    }

    if (def.bus === "onewire" && otherDef.bus === "onewire") {
      if (target.pins.onewire !== other.pins.onewire) {
        errors.push(`${peer.name} is on a different 1-Wire bus (GPIO${other.pins.onewire}); 1-Wire buses are not shared across data pins.`);
      }
      continue;
    }

    if ((def.bus === "uart" && otherDef.bus === "uart") ||
        (def.bus === "spi" && otherDef.bus === "spi")) {
      // No UART/SPI multiplexing is implemented: two peripherals cannot own
      // overlapping signal pins, except exact SPI bus reuse with a distinct CS.
      const targetPins = def.roles.map((r) => target.pins[r]).filter((p): p is number => p !== undefined);
      const otherPins = otherDef.roles.map((r) => other.pins[r]).filter((p): p is number => p !== undefined);
      if (def.bus === "spi" && target.busId === other.busId && target.pins.spi_cs !== other.pins.spi_cs) {
        warnings.push(`${peer.name} shares the SPI clock/data bus; its chip-select GPIO${other.pins.spi_cs} stays independent.`);
      } else {
        const overlap = targetPins.filter((p) => otherPins.includes(p));
        if (overlap.length > 0) {
          errors.push(
            `${targetDriver.displayName} cannot share ${def.bus.toUpperCase()} pin(s) GPIO${overlap.join(", GPIO")} with "${peer.name}"; this firmware does not multiplex ${def.bus.toUpperCase()} peripherals.`
          );
        }
      }
      continue;
    }

    // Same physical multi-measurement module: shared binding is intentional.
    if (other.driverId === target.driverId && targetDriver.allowSharedPinWithSameDriver &&
        params.candidate.sensorType !== peer.sensorType) {
      warnings.push(`${peer.name} is another measurement of the same physical ${targetDriver.displayName} module.`);
      continue;
    }

    for (const role of def.roles) {
      const pin = target.pins[role];
      if (pin === undefined) continue;
      for (const otherRole of otherDef.roles) {
        if (other.pins[otherRole] === pin) {
          errors.push(
            `GPIO${pin} is already used by "${peer.name}" (${getSensorDriverById(other.driverId)?.displayName ?? other.driverId}) for ${otherRole.replace(/_/g, " ")}; ${targetDriver.displayName} needs it for ${role.replace(/_/g, " ")}.`
          );
        }
      }
    }
  }

  for (const role of EXCLUSIVE_ROLES) {
    const pin = target.pins[role];
    if (pin === undefined) continue;
    const holders = occupiedPins.get(pin) ?? [];
    if (holders.length > 0) {
      errors.push(
        `GPIO${pin} (${role.replace(/_/g, " ")}) is already assigned to ${holders.join(", ")}. Pick a different pin.`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors: Array.from(new Set(errors)),
    warnings: Array.from(new Set(warnings)),
    resolved: errors.length === 0 ? target : null,
  };
}

/** Recommended, driver-aware starting resources for a board. */
export function suggestSensorResources(params: {
  board: BoardProfileSpec;
  sensorType: string;
  driverId?: string | null;
  model?: string | null;
}): SensorResourcesConfig {
  const driver = (params.driverId && isSensorDriverId(params.driverId)
    ? getSensorDriverById(params.driverId) ?? null
    : null) ?? getSensorDriverForMeasurement(params.sensorType);
  if (!driver) return {};
  const def = driver.resources!;
  const profile = deriveBoardHardwareCapabilityProfile(params.board);
  const bus = documentedBusForBoard(params.board);
  const pins: Partial<Record<SensorPinRole, number>> = {};
  const pick = (pool: number[], avoid: number[] = []): number | null =>
    pool.find((p) => !avoid.includes(p)) ?? null;

  if (def.bus === "i2c") {
    if (bus.sdaPin !== null && bus.sclPin !== null) {
      pins.i2c_sda = bus.sdaPin;
      pins.i2c_scl = bus.sclPin;
    }
  } else if (def.bus === "onewire") {
    const pin = pick(profile.pins.oneWire);
    if (pin !== null) pins.onewire = pin;
  } else if (def.bus === "uart") {
    const tx = pick(profile.pins.uart);
    const rx = pick(profile.pins.uart, tx === null ? [] : [tx]);
    if (tx !== null) pins.uart_tx = tx;
    if (rx !== null) pins.uart_rx = rx;
  } else if (def.bus === "spi") {
    const used: number[] = [];
    for (const role of ["spi_sclk", "spi_mosi", "spi_miso", "spi_cs"] as const) {
      const pin = pick(profile.pins.spi, used);
      if (pin !== null) {
        pins[role] = pin;
        used.push(pin);
      }
    }
  } else {
    const pool = def.roles[0] === "adc"
      ? profile.pins.adc
      : def.roles[0] === "gpio_bidirectional"
        ? profile.pins.bidirectionalGpio
        : profile.pins.digitalIn;
    const pin = pick(pool);
    if (pin !== null) pins[def.roles[0]] = pin;
  }

  return {
    driverId: driver.id,
    model: params.model && driver.supportedModels.includes(params.model) ? params.model : (driver.supportedModels[0] ?? null),
    pins,
    i2cAddress: driver.busConfig.defaultAddresses?.[0] ?? null,
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

type SensorAssignmentParams = Parameters<typeof validateSensorAssignmentForController>[0];

/** Firmware-manifest gate shared by the legacy and driver-aware validation paths. */
function finishSensorFirmwareValidation(
  params: SensorAssignmentParams,
  driver: SensorDriverDefinition,
  measurement: SensorMeasurementDefinition,
  warnings: string[]
): SensorAssignmentValidationResult {
  if (!params.board) {
    return {
      valid: false,
      code: "BOARD_PROFILE_MISSING",
      errors: ["Controller board profile is missing."],
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
  /** Driver-aware resource assignment; when present it is authoritative. */
  resources?: SensorResourcesConfig | null;
  /** Explicit physical driver id; used to distinguish models sharing a measurement. */
  driverId?: string | null;
  model?: string | null;
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

  // Driver-aware path: one physical driver owns all of its required pins/buses.
  // The same function is used by the frontend suggestions and the Worker API.
  if (params.resources) {
    const allocations: SensorResourceAllocationInput[] = [
      ...params.existingSensorsOnController
        .filter((s) => s.id !== params.editingSensorId)
        .map((s) => ({
          id: s.id,
          name: s.name,
          kind: "sensor" as const,
          sensorType: s.sensor_type,
          driverId: s.driver_id ?? null,
          resources: s.resources ?? null,
          gpioPin: s.gpio_pin,
          i2cAddress: s.i2c_address,
        })),
      ...params.usedPinsByNonSensors.map((pin, index) => ({
        id: `non-sensor-${index}`,
        name: `GPIO${pin}`,
        kind: "device" as const,
        gpioPin: pin,
      })),
    ];
    const resourceCheck = validateSensorResourceAssignments({
      board: params.board,
      candidate: {
        id: params.editingSensorId ?? "new-sensor",
        name: "this sensor",
        kind: "sensor",
        sensorType: params.sensorType,
        driverId: params.driverId ?? driver.id,
        resources: params.resources,
        gpioPin: params.gpioPin,
        i2cAddress: params.i2cAddress,
      },
      allocations,
    });
    if (!resourceCheck.valid) {
      return {
        valid: false,
        code: resourceCheck.errors.some((e) => /I2C address/i.test(e))
          ? "I2C_ADDRESS_CONFLICT"
          : "GPIO_OR_BUS_INVALID",
        errors: resourceCheck.errors,
        warnings: resourceCheck.warnings,
        driver,
        measurement,
      };
    }
    warnings.push(...resourceCheck.warnings);
  }

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
  if (params.resources) {
    // Resource validation above already covered every required pin and bus.
    return finishSensorFirmwareValidation(params, driver, measurement, warnings);
  }
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

  return finishSensorFirmwareValidation(params, driver, measurement, warnings);
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
  const requested = params.driverIds ?? IMPLEMENTED_SENSOR_DRIVER_IDS;
  const drivers: FirmwareDriverEntry[] = [];
  const supported = new Set<SupportedSensorType>();

  for (const id of requested) {
    const reg = getSensorDriverById(id);
    if (!reg || reg.hardwareVerificationStatus === "planned") continue;
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
