import {
  BOARD_CATALOG_BUILDERS,
  BOARD_REVISION_UNSPECIFIED,
  type CatalogBoardSeed,
} from "./board-catalog-data";
import { resolveBoardFirmwareCompatibility } from "./board-firmware-compat";
import type { BoardHeaderPin, GpioPinDefinition } from "./index";

const { headerPin: hp, buildDefinitionsFromHeaders, soc } = BOARD_CATALOG_BUILDERS;

export const WAVESHARE_SOURCE_PROVIDER = "waveshare_partner";
export const WAVESHARE_WIKI_BASE_URL = "https://www.waveshare.com/wiki/";
export const NODEMCU_SOURCE_PROVIDER = "nodemcu_community";

export interface WaveshareSourceLink {
  label: string;
  url: string;
}

export interface WaveshareOfficialBoard {
  seed: CatalogBoardSeed;
  wikiUrl: string;
  officialPinMap: Record<string, number>;
  highlights: string[];
  sources: WaveshareSourceLink[];
}

function finalizeSeed(
  seed: Omit<CatalogBoardSeed, keyof ReturnType<typeof resolveBoardFirmwareCompatibility>> &
    Partial<ReturnType<typeof resolveBoardFirmwareCompatibility>>
): CatalogBoardSeed {
  return {
    ...(seed as CatalogBoardSeed),
    ...resolveBoardFirmwareCompatibility(seed),
  };
}

function extraFromPads(pads: BoardHeaderPin[]): Array<{ pin: number; name: string; note?: string }> {
  return pads
    .filter((p): p is BoardHeaderPin & { gpioPin: number } => typeof p.gpioPin === "number")
    .map((p) => ({
      pin: p.gpioPin,
      name: p.pinName,
      ...(p.note ? { note: p.note } : {}),
    }));
}

function withPinOverrides(
  defs: GpioPinDefinition[],
  overrides: Record<
    number,
    {
      label?: string;
      boardNote?: string;
      reservedReason?: string;
      inputOnly?: boolean;
      digitalIn?: boolean;
      digitalOut?: boolean;
      adc?: boolean;
      pullUp?: boolean;
      pullDown?: boolean;
      i2c?: boolean;
      spi?: boolean;
      uart?: boolean;
      touch?: boolean;
      pwm?: boolean;
    }
  >
): GpioPinDefinition[] {
  return defs.map((def) => {
    const patch = overrides[def.pin];
    if (!patch) return def;
    const reserved = Boolean(patch.reservedReason) || def.restrictions.reserved;
    return {
      ...def,
      label: patch.label ?? def.label,
      board_note: patch.boardNote ?? def.board_note,
      capabilities: {
        ...def.capabilities,
        digital_in: reserved ? false : (patch.digitalIn ?? def.capabilities.digital_in),
        digital_out: reserved ? false : (patch.digitalOut ?? def.capabilities.digital_out),
        adc: reserved ? false : (patch.adc ?? def.capabilities.adc),
        pwm: reserved ? false : (patch.pwm ?? def.capabilities.pwm),
        i2c: reserved ? false : (patch.i2c ?? def.capabilities.i2c),
        spi: reserved ? false : (patch.spi ?? def.capabilities.spi),
        uart: reserved ? false : (patch.uart ?? def.capabilities.uart),
        touch: reserved ? false : (patch.touch ?? def.capabilities.touch),
        pull_up: patch.pullUp ?? def.capabilities.pull_up,
        pull_down: patch.pullDown ?? def.capabilities.pull_down,
      },
      restrictions: {
        ...def.restrictions,
        input_only: patch.inputOnly ?? def.restrictions.input_only,
        reserved,
        reserved_reason: patch.reservedReason ?? def.restrictions.reserved_reason,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// 1. Waveshare ESP32-S3-Zero (ESP32-S3FH4R2, 4MB Flash + 2MB Quad PSRAM)
// ---------------------------------------------------------------------------

const WS_S3_ZERO_LEFT: BoardHeaderPin[] = [
  hp(1, "Left", "5V", null, "power", { voltage: "5V" }),
  hp(2, "Left", "GND", null, "ground"),
  hp(3, "Left", "3V3", null, "power", { voltage: "3.3V" }),
  hp(4, "Left", "GP1", 1, "gpio", { aliases: ["ADC1_CH0", "TOUCH1"] }),
  hp(5, "Left", "GP2", 2, "gpio", { aliases: ["ADC1_CH1", "TOUCH2"] }),
  hp(6, "Left", "GP3", 3, "gpio", { aliases: ["ADC1_CH2", "STRAPPING"] }),
  hp(7, "Left", "GP4", 4, "gpio", { aliases: ["ADC1_CH3", "TOUCH4"] }),
  hp(8, "Left", "GP5", 5, "gpio", { aliases: ["ADC1_CH4", "TOUCH5"] }),
  hp(9, "Left", "GP6", 6, "gpio", { aliases: ["ADC1_CH5", "TOUCH6"] }),
];

const WS_S3_ZERO_RIGHT: BoardHeaderPin[] = [
  hp(1, "Right", "TX", 43, "gpio", { aliases: ["U0TXD", "GPIO43"] }),
  hp(2, "Right", "RX", 44, "gpio", { aliases: ["U0RXD", "GPIO44"] }),
  hp(3, "Right", "GP13", 13, "gpio", { aliases: ["SPI_MOSI", "TOUCH13"] }),
  hp(4, "Right", "GP12", 12, "gpio", { aliases: ["SPI_CLK", "TOUCH12"] }),
  hp(5, "Right", "GP11", 11, "gpio", { aliases: ["SPI_MOSI", "TOUCH11"] }),
  hp(6, "Right", "GP10", 10, "gpio", { aliases: ["SPI_CS", "ADC1_CH9"] }),
  hp(7, "Right", "GP9", 9, "gpio", { aliases: ["ADC1_CH8", "TOUCH9"] }),
  hp(8, "Right", "GP8", 8, "gpio", { aliases: ["I2C_SDA", "ADC1_CH7"] }),
  hp(9, "Right", "GP7", 7, "gpio", { aliases: ["I2C_SCL", "ADC1_CH6"] }),
];

const WS_S3_ZERO_EXTRA: BoardHeaderPin[] = [
  hp(1, "Bottom", "GP14", 14, "gpio", { note: "Castellated bottom pad" }),
  hp(2, "Bottom", "GP15", 15, "gpio", { note: "Castellated bottom pad" }),
  hp(3, "Bottom", "GP16", 16, "gpio", { note: "Castellated bottom pad" }),
  hp(4, "Bottom", "GP17", 17, "gpio", { note: "Castellated bottom pad" }),
  hp(5, "Bottom", "GP18", 18, "gpio", { note: "Castellated bottom pad" }),
  hp(6, "Bottom", "GP21", 21, "gpio", { note: "Onboard WS2812 RGB LED" }),
  hp(7, "Bottom", "GP33", 33, "gpio", { note: "Castellated bottom pad (Quad PSRAM free)" }),
  hp(8, "Bottom", "GP34", 34, "gpio", { note: "Castellated bottom pad (Quad PSRAM free)" }),
  hp(9, "Bottom", "GP35", 35, "gpio", { note: "Castellated bottom pad (Quad PSRAM free)" }),
  hp(10, "Bottom", "GP36", 36, "gpio", { note: "Castellated bottom pad (Quad PSRAM free)" }),
];

const WS_S3_ZERO_SEED = finalizeSeed({
  slug: "waveshare-esp32-s3-zero",
  manufacturer: "Waveshare",
  model: "ESP32-S3-Zero",
  revision: BOARD_REVISION_UNSPECIFIED,
  chip_family: "esp32s3",
  chip_variant: "ESP32-S3FH4R2",
  flash_size_mb: 4,
  psram_size_mb: 2,
  usb_vid: "0x303A",
  usb_pid: "0x1001",
  catalog_category: "partner",
  series: "Waveshare ESP32-Zero",
  image_url: null,
  pinout_image_url: null,
  docs_url: "https://www.waveshare.com/wiki/ESP32-S3-Zero",
  datasheet_url: "https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf",
  source_url: "https://www.waveshare.com/wiki/ESP32-S3-Zero",
  source_provider: WAVESHARE_SOURCE_PROVIDER,
  verification_status: "verified",
  firmware_status: "catalog_only",
  revision_notes:
    "Ultra-compact castellated ESP32-S3FH4R2 board with 4MB Flash, 2MB Quad PSRAM, ceramic antenna, USB-C, and onboard WS2812 RGB LED on GPIO21.",
  is_published: true,
  board_layout: {
    formFactor: "devkit",
    orientation: "vertical",
    aspectRatio: 18 / 23.5,
    usbEdge: "top",
    usbLabel: "Native USB-C",
    antennaEdge: "bottom",
    antennaLabel: "Ceramic Antenna",
    hardwareSpecs: {
      processor: "Dual-Core Xtensa LX7 (240 MHz)",
      wireless: "Wi-Fi 4, BLE 5.0",
      usb: "1x USB-C (Native OTG / JTAG)",
      usbPortCount: 1,
      usbConnector: "usb-c",
      buttons: "RST + BOOT",
      resetLabel: "RST",
      modulePackage: "mini",
      hasUartBridge: false,
    },
    leftHeader: { name: "Left", pins: WS_S3_ZERO_LEFT },
    rightHeader: { name: "Right", pins: WS_S3_ZERO_RIGHT },
    extraPads: { name: "Bottom Pads", pins: WS_S3_ZERO_EXTRA },
    onboardFeatures: [
      { label: "WS2812 RGB LED", gpioPin: 21, kind: "rgb_led", note: "GPIO21" },
      { label: "BOOT Button", gpioPin: 0, kind: "button", note: "GPIO0" },
    ],
  },
  gpio_definitions: buildDefinitionsFromHeaders(
    WS_S3_ZERO_LEFT,
    WS_S3_ZERO_RIGHT,
    soc.esp32s3Qpi,
    [
      ...extraFromPads(WS_S3_ZERO_EXTRA),
      { pin: 0, name: "BOOT", note: "Onboard BOOT button" },
    ]
  ),
});

// ---------------------------------------------------------------------------
// 2. Waveshare ESP32-C6-Zero (ESP32-C6FH4, 4MB Flash, Wi-Fi 6 + BLE 5 + Zigbee)
// ---------------------------------------------------------------------------

const WS_C6_ZERO_LEFT: BoardHeaderPin[] = [
  hp(1, "Left", "5V", null, "power", { voltage: "5V" }),
  hp(2, "Left", "GND", null, "ground"),
  hp(3, "Left", "3V3", null, "power", { voltage: "3.3V" }),
  hp(4, "Left", "GP0", 0, "gpio", { aliases: ["ADC1_CH0"] }),
  hp(5, "Left", "GP1", 1, "gpio", { aliases: ["ADC1_CH1"] }),
  hp(6, "Left", "GP2", 2, "gpio", { aliases: ["ADC1_CH2"] }),
  hp(7, "Left", "GP3", 3, "gpio", { aliases: ["ADC1_CH3"] }),
  hp(8, "Left", "GP4", 4, "gpio", { aliases: ["ADC1_CH4", "MTMS"] }),
  hp(9, "Left", "GP5", 5, "gpio", { aliases: ["ADC1_CH5", "MTDI"] }),
];

const WS_C6_ZERO_RIGHT: BoardHeaderPin[] = [
  hp(1, "Right", "TX", 16, "gpio", { aliases: ["U0TXD", "GPIO16"] }),
  hp(2, "Right", "RX", 17, "gpio", { aliases: ["U0RXD", "GPIO17"] }),
  hp(3, "Right", "GP20", 20, "gpio", { aliases: ["I2C_SDA"] }),
  hp(4, "Right", "GP19", 19, "gpio", { aliases: ["I2C_SCL"] }),
  hp(5, "Right", "GP18", 18, "gpio", { aliases: ["SPI_CS"] }),
  hp(6, "Right", "GP15", 15, "gpio", { aliases: ["STRAPPING"] }),
  hp(7, "Right", "GP14", 14, "gpio", { aliases: ["GPIO14"] }),
  hp(8, "Right", "GP7", 7, "gpio", { aliases: ["SPI_MOSI"] }),
  hp(9, "Right", "GP6", 6, "gpio", { aliases: ["SPI_CLK", "ADC1_CH6"] }),
];

const WS_C6_ZERO_EXTRA: BoardHeaderPin[] = [
  hp(1, "Bottom", "GP8", 8, "gpio", { note: "Onboard WS2812 RGB LED" }),
  hp(2, "Bottom", "GP9", 9, "gpio", { note: "Onboard BOOT button" }),
  hp(3, "Bottom", "GP21", 21, "gpio", { note: "Castellated bottom pad" }),
  hp(4, "Bottom", "GP22", 22, "gpio", { note: "Castellated bottom pad" }),
  hp(5, "Bottom", "GP23", 23, "gpio", { note: "Castellated bottom pad" }),
];

const WS_C6_ZERO_SEED = finalizeSeed({
  slug: "waveshare-esp32-c6-zero",
  manufacturer: "Waveshare",
  model: "ESP32-C6-Zero",
  revision: BOARD_REVISION_UNSPECIFIED,
  chip_family: "esp32c6",
  chip_variant: "ESP32-C6FH4",
  flash_size_mb: 4,
  psram_size_mb: 0,
  usb_vid: "0x303A",
  usb_pid: "0x1001",
  catalog_category: "partner",
  series: "Waveshare ESP32-Zero",
  image_url: null,
  pinout_image_url: null,
  docs_url: "https://www.waveshare.com/wiki/ESP32-C6-Zero",
  datasheet_url: "https://www.espressif.com/sites/default/files/documentation/esp32-c6_datasheet_en.pdf",
  source_url: "https://www.waveshare.com/wiki/ESP32-C6-Zero",
  source_provider: WAVESHARE_SOURCE_PROVIDER,
  verification_status: "verified",
  firmware_status: "catalog_only",
  revision_notes:
    "Compact castellated ESP32-C6FH4 RISC-V board with Wi-Fi 6, BLE 5.3, Zigbee/Thread, ceramic antenna, USB-C, and onboard WS2812 RGB LED on GPIO8.",
  is_published: true,
  board_layout: {
    formFactor: "devkit",
    orientation: "vertical",
    aspectRatio: 18 / 23.5,
    usbEdge: "top",
    usbLabel: "Native USB-C",
    antennaEdge: "bottom",
    antennaLabel: "Ceramic Antenna",
    hardwareSpecs: {
      processor: "Single-Core RISC-V (160 MHz)",
      wireless: "Wi-Fi 6, BLE 5.3, Zigbee / Thread",
      usb: "1x USB-C (Native USB-JTAG)",
      usbPortCount: 1,
      usbConnector: "usb-c",
      buttons: "RST + BOOT",
      resetLabel: "RST",
      modulePackage: "mini",
      hasUartBridge: false,
    },
    leftHeader: { name: "Left", pins: WS_C6_ZERO_LEFT },
    rightHeader: { name: "Right", pins: WS_C6_ZERO_RIGHT },
    extraPads: { name: "Bottom Pads", pins: WS_C6_ZERO_EXTRA },
    onboardFeatures: [
      { label: "WS2812 RGB LED", gpioPin: 8, kind: "rgb_led", note: "GPIO8" },
      { label: "BOOT Button", gpioPin: 9, kind: "button", note: "GPIO9" },
    ],
  },
  gpio_definitions: buildDefinitionsFromHeaders(
    WS_C6_ZERO_LEFT,
    WS_C6_ZERO_RIGHT,
    soc.esp32c6,
    extraFromPads(WS_C6_ZERO_EXTRA)
  ),
});

// ---------------------------------------------------------------------------
// 3. Waveshare ESP32-C3-Zero (ESP32-C3FH4, 4MB Flash, Wi-Fi 4 + BLE 5)
// ---------------------------------------------------------------------------

const WS_C3_ZERO_LEFT: BoardHeaderPin[] = [
  hp(1, "Left", "5V", null, "power", { voltage: "5V" }),
  hp(2, "Left", "GND", null, "ground"),
  hp(3, "Left", "3V3", null, "power", { voltage: "3.3V" }),
  hp(4, "Left", "GP0", 0, "gpio", { aliases: ["ADC1_CH0"] }),
  hp(5, "Left", "GP1", 1, "gpio", { aliases: ["ADC1_CH1"] }),
  hp(6, "Left", "GP2", 2, "gpio", { aliases: ["ADC1_CH2", "STRAPPING"] }),
  hp(7, "Left", "GP3", 3, "gpio", { aliases: ["ADC1_CH3"] }),
  hp(8, "Left", "GP4", 4, "gpio", { aliases: ["ADC1_CH4", "SPI_HD"] }),
  hp(9, "Left", "GP5", 5, "gpio", { aliases: ["SPI_WP"] }),
];

const WS_C3_ZERO_RIGHT: BoardHeaderPin[] = [
  hp(1, "Right", "TX", 21, "gpio", { aliases: ["U0TXD", "GPIO21"] }),
  hp(2, "Right", "RX", 20, "gpio", { aliases: ["U0RXD", "GPIO20"] }),
  hp(3, "Right", "GP10", 10, "gpio", { aliases: ["RGB_LED"], note: "Onboard WS2812 RGB LED" }),
  hp(4, "Right", "GP9", 9, "gpio", { aliases: ["BOOT"], note: "BOOT strapping button" }),
  hp(5, "Right", "GP8", 8, "gpio", { aliases: ["I2C_SDA", "STRAPPING"] }),
  hp(6, "Right", "GP7", 7, "gpio", { aliases: ["I2C_SCL"] }),
  hp(7, "Right", "GP6", 6, "gpio", { aliases: ["SPI_CLK"] }),
];

const WS_C3_ZERO_SEED = finalizeSeed({
  slug: "waveshare-esp32-c3-zero",
  manufacturer: "Waveshare",
  model: "ESP32-C3-Zero",
  revision: BOARD_REVISION_UNSPECIFIED,
  chip_family: "esp32c3",
  chip_variant: "ESP32-C3FH4",
  flash_size_mb: 4,
  psram_size_mb: 0,
  usb_vid: "0x303A",
  usb_pid: "0x1001",
  catalog_category: "partner",
  series: "Waveshare ESP32-Zero",
  image_url: null,
  pinout_image_url: null,
  docs_url: "https://www.waveshare.com/wiki/ESP32-C3-Zero",
  datasheet_url: "https://www.espressif.com/sites/default/files/documentation/esp32-c3_datasheet_en.pdf",
  source_url: "https://www.waveshare.com/wiki/ESP32-C3-Zero",
  source_provider: WAVESHARE_SOURCE_PROVIDER,
  verification_status: "verified",
  firmware_status: "catalog_only",
  revision_notes:
    "Miniature castellated ESP32-C3FH4 RISC-V board with 4MB Flash, Wi-Fi 4 + BLE 5.0, ceramic antenna, USB-C, and WS2812 RGB LED on GPIO10.",
  is_published: true,
  board_layout: {
    formFactor: "devkit",
    orientation: "vertical",
    aspectRatio: 18 / 23.5,
    usbEdge: "top",
    usbLabel: "Native USB-C",
    antennaEdge: "bottom",
    antennaLabel: "Ceramic Antenna",
    hardwareSpecs: {
      processor: "Single-Core RISC-V (160 MHz)",
      wireless: "Wi-Fi 4, BLE 5.0",
      usb: "1x USB-C (Native USB-JTAG)",
      usbPortCount: 1,
      usbConnector: "usb-c",
      buttons: "RST + BOOT",
      resetLabel: "RST",
      modulePackage: "mini",
      hasUartBridge: false,
    },
    leftHeader: { name: "Left", pins: WS_C3_ZERO_LEFT },
    rightHeader: { name: "Right", pins: WS_C3_ZERO_RIGHT },
    onboardFeatures: [
      { label: "WS2812 RGB LED", gpioPin: 10, kind: "rgb_led", note: "GPIO10" },
      { label: "BOOT Button", gpioPin: 9, kind: "button", note: "GPIO9" },
    ],
  },
  gpio_definitions: buildDefinitionsFromHeaders(WS_C3_ZERO_LEFT, WS_C3_ZERO_RIGHT, soc.esp32c3),
});

// ---------------------------------------------------------------------------
// 4. Waveshare ESP32-S3-Pico (ESP32-S3R2, 16MB Flash + 2MB Quad PSRAM, 40-pin)
// ---------------------------------------------------------------------------

const WS_S3_PICO_LEFT: BoardHeaderPin[] = [
  hp(1, "Left", "GP1", 1, "gpio", { aliases: ["ADC1_CH0"] }),
  hp(2, "Left", "GP2", 2, "gpio", { aliases: ["ADC1_CH1"] }),
  hp(3, "Left", "GND", null, "ground"),
  hp(4, "Left", "GP4", 4, "gpio", { aliases: ["ADC1_CH3"] }),
  hp(5, "Left", "GP5", 5, "gpio", { aliases: ["ADC1_CH4"] }),
  hp(6, "Left", "GP6", 6, "gpio", { aliases: ["ADC1_CH5"] }),
  hp(7, "Left", "GP7", 7, "gpio", { aliases: ["ADC1_CH6"] }),
  hp(8, "Left", "GND", null, "ground"),
  hp(9, "Left", "GP8", 8, "gpio", { aliases: ["ADC1_CH7"] }),
  hp(10, "Left", "GP9", 9, "gpio", { aliases: ["ADC1_CH8"] }),
  hp(11, "Left", "GP10", 10, "gpio", { aliases: ["ADC1_CH9"] }),
  hp(12, "Left", "GP11", 11, "gpio", { aliases: ["SPI_MOSI"] }),
  hp(13, "Left", "GND", null, "ground"),
  hp(14, "Left", "GP12", 12, "gpio", { aliases: ["SPI_CLK"] }),
  hp(15, "Left", "GP13", 13, "gpio", { aliases: ["SPI_MISO"] }),
  hp(16, "Left", "GP14", 14, "gpio", { aliases: ["GPIO14"] }),
  hp(17, "Left", "GP15", 15, "gpio", { aliases: ["GPIO15"] }),
  hp(18, "Left", "GND", null, "ground"),
  hp(19, "Left", "GP16", 16, "gpio", { aliases: ["I2C_SDA"] }),
  hp(20, "Left", "GP17", 17, "gpio", { aliases: ["I2C_SCL"] }),
];

const WS_S3_PICO_RIGHT: BoardHeaderPin[] = [
  hp(1, "Right", "VBUS", null, "power", { voltage: "5V" }),
  hp(2, "Right", "VSYS", null, "power", { voltage: "5V" }),
  hp(3, "Right", "GND", null, "ground"),
  hp(4, "Right", "3V3_EN", null, "reset", { note: "3.3V regulator enable" }),
  hp(5, "Right", "3V3", null, "power", { voltage: "3.3V" }),
  hp(6, "Right", "GP42", 42, "gpio", { aliases: ["MTMS"] }),
  hp(7, "Right", "GP41", 41, "gpio", { aliases: ["MTDI"] }),
  hp(8, "Right", "GND", null, "ground"),
  hp(9, "Right", "GP40", 40, "gpio", { aliases: ["MTDO"] }),
  hp(10, "Right", "GP39", 39, "gpio", { aliases: ["MTCK"] }),
  hp(11, "Right", "RST", null, "reset"),
  hp(12, "Right", "GP38", 38, "gpio", { aliases: ["GPIO38"] }),
  hp(13, "Right", "GND", null, "ground"),
  hp(14, "Right", "GP37", 37, "gpio", { aliases: ["GPIO37"] }),
  hp(15, "Right", "GP36", 36, "gpio", { aliases: ["GPIO36"] }),
  hp(16, "Right", "GP35", 35, "gpio", { aliases: ["GPIO35"] }),
  hp(17, "Right", "GP34", 34, "gpio", { aliases: ["GPIO34"] }),
  hp(18, "Right", "GND", null, "ground"),
  hp(19, "Right", "GP33", 33, "gpio", { aliases: ["GPIO33"] }),
  hp(20, "Right", "GP18", 18, "gpio", { aliases: ["GPIO18"] }),
];

const WS_S3_PICO_SEED = finalizeSeed({
  slug: "waveshare-esp32-s3-pico",
  manufacturer: "Waveshare",
  model: "ESP32-S3-Pico",
  revision: BOARD_REVISION_UNSPECIFIED,
  chip_family: "esp32s3",
  chip_variant: "ESP32-S3R2",
  flash_size_mb: 16,
  psram_size_mb: 2,
  usb_vid: "0x303A",
  usb_pid: "0x1001",
  catalog_category: "partner",
  series: "Waveshare ESP32-Pico",
  image_url: null,
  pinout_image_url: null,
  docs_url: "https://www.waveshare.com/wiki/ESP32-S3-Pico",
  datasheet_url: "https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf",
  source_url: "https://www.waveshare.com/wiki/ESP32-S3-Pico",
  source_provider: WAVESHARE_SOURCE_PROVIDER,
  verification_status: "verified",
  firmware_status: "catalog_only",
  revision_notes:
    "Raspberry Pi Pico form-factor ESP32-S3R2 board with 16MB Flash, 2MB Quad PSRAM, 27 exposed GPIOs, USB-C, and onboard WS2812 RGB LED on GPIO21.",
  is_published: true,
  board_layout: {
    formFactor: "devkit",
    orientation: "vertical",
    aspectRatio: 21 / 51,
    usbEdge: "top",
    usbLabel: "Native USB-C",
    antennaEdge: "bottom",
    antennaLabel: "Ceramic Antenna",
    hardwareSpecs: {
      processor: "Dual-Core Xtensa LX7 (240 MHz)",
      wireless: "Wi-Fi 4, BLE 5.0",
      usb: "1x USB-C (Native OTG / JTAG)",
      usbPortCount: 1,
      usbConnector: "usb-c",
      buttons: "RST + BOOT",
      resetLabel: "RST",
      modulePackage: "mini",
      hasUartBridge: false,
    },
    leftHeader: { name: "Left", pins: WS_S3_PICO_LEFT },
    rightHeader: { name: "Right", pins: WS_S3_PICO_RIGHT },
    onboardFeatures: [
      { label: "WS2812 RGB LED", gpioPin: 21, kind: "rgb_led", note: "GPIO21" },
      { label: "BOOT Button", gpioPin: 0, kind: "button", note: "GPIO0" },
    ],
  },
  gpio_definitions: buildDefinitionsFromHeaders(WS_S3_PICO_LEFT, WS_S3_PICO_RIGHT, soc.esp32s3Qpi, [
    { pin: 21, name: "RGB_LED", note: "Onboard WS2812 RGB LED" },
    { pin: 0, name: "BOOT", note: "Onboard BOOT button" },
  ]),
});

// ---------------------------------------------------------------------------
// 5. Waveshare ESP32-S3-Relay-6CH (ESP32-S3-WROOM-1-N16R8, 6x Relay + RS485)
// ---------------------------------------------------------------------------

const WS_S3_RELAY_LEFT: BoardHeaderPin[] = [
  hp(1, "Relays", "CH1", 1, "gpio", { aliases: ["RELAY1"], note: "Onboard Relay CH1 (Active High)" }),
  hp(2, "Relays", "CH2", 2, "gpio", { aliases: ["RELAY2"], note: "Onboard Relay CH2 (Active High)" }),
  hp(3, "Relays", "CH3", 41, "gpio", { aliases: ["RELAY3"], note: "Onboard Relay CH3 (Active High)" }),
  hp(4, "Relays", "CH4", 42, "gpio", { aliases: ["RELAY4"], note: "Onboard Relay CH4 (Active High)" }),
  hp(5, "Relays", "CH5", 45, "gpio", { aliases: ["RELAY5"], note: "Onboard Relay CH5 (Active High)" }),
  hp(6, "Relays", "CH6", 46, "gpio", { aliases: ["RELAY6"], note: "Onboard Relay CH6 (Active High)" }),
  hp(7, "Relays", "RGB", 38, "gpio", { aliases: ["WS2812"], note: "Onboard WS2812 RGB LED" }),
  hp(8, "Relays", "BUZZ", 21, "gpio", { aliases: ["BUZZER"], note: "Onboard Buzzer" }),
  hp(9, "Relays", "5V", null, "power", { voltage: "5V" }),
  hp(10, "Relays", "GND", null, "ground"),
];

const WS_S3_RELAY_RIGHT: BoardHeaderPin[] = [
  hp(1, "Expansion", "3V3", null, "power", { voltage: "3.3V" }),
  hp(2, "Expansion", "GND", null, "ground"),
  hp(3, "Expansion", "GP4", 4, "gpio", { aliases: ["ADC1_CH3"] }),
  hp(4, "Expansion", "GP5", 5, "gpio", { aliases: ["ADC1_CH4"] }),
  hp(5, "Expansion", "GP6", 6, "gpio", { aliases: ["ADC1_CH5"] }),
  hp(6, "Expansion", "GP7", 7, "gpio", { aliases: ["ADC1_CH6"] }),
  hp(7, "Expansion", "GP8", 8, "gpio", { aliases: ["I2C_SDA"] }),
  hp(8, "Expansion", "GP9", 9, "gpio", { aliases: ["I2C_SCL"] }),
  hp(9, "Expansion", "RS485_TX", 17, "gpio", { aliases: ["TXD"], note: "Isolated RS485 TX" }),
  hp(10, "Expansion", "RS485_RX", 18, "gpio", { aliases: ["RXD"], note: "Isolated RS485 RX" }),
];

const WS_S3_RELAY_6CH_SEED = finalizeSeed({
  slug: "waveshare-esp32-s3-relay-6ch",
  manufacturer: "Waveshare",
  model: "ESP32-S3-Relay-6CH",
  revision: BOARD_REVISION_UNSPECIFIED,
  chip_family: "esp32s3",
  chip_variant: "ESP32-S3-WROOM-1-N16R8",
  flash_size_mb: 16,
  psram_size_mb: 8,
  usb_vid: "0x303A",
  usb_pid: "0x1001",
  catalog_category: "partner",
  series: "Waveshare Industrial Relay",
  image_url: null,
  pinout_image_url: null,
  docs_url: "https://www.waveshare.com/wiki/ESP32-S3-Relay-6CH",
  datasheet_url: "https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf",
  source_url: "https://www.waveshare.com/wiki/ESP32-S3-Relay-6CH",
  source_provider: WAVESHARE_SOURCE_PROVIDER,
  verification_status: "verified",
  firmware_status: "catalog_only",
  revision_notes:
    "Industrial 6-channel isolated relay controller built on ESP32-S3-WROOM-1-N16R8 (16MB Flash + 8MB Octal PSRAM) with RS485, buzzer (GPIO21), and RGB LED (GPIO38).",
  is_published: true,
  board_layout: {
    formFactor: "devkit",
    orientation: "vertical",
    aspectRatio: 88 / 122,
    usbEdge: "bottom",
    usbLabel: "USB-C (Native OTG)",
    antennaEdge: "top",
    antennaLabel: "WROOM PCB Antenna",
    hardwareSpecs: {
      processor: "Dual-Core Xtensa LX7 (240 MHz)",
      wireless: "Wi-Fi 4, BLE 5.0",
      usb: "1x USB-C (Native OTG / JTAG)",
      usbPortCount: 1,
      usbConnector: "usb-c",
      buttons: "RST + BOOT",
      resetLabel: "RST",
      modulePackage: "wroom",
      hasUartBridge: false,
    },
    leftHeader: { name: "Relays", pins: WS_S3_RELAY_LEFT },
    rightHeader: { name: "Expansion", pins: WS_S3_RELAY_RIGHT },
    onboardFeatures: [
      { label: "Relay CH1", gpioPin: 1, kind: "relay", note: "Onboard Isolated Relay CH1 (Active High)" },
      { label: "Relay CH2", gpioPin: 2, kind: "relay", note: "Onboard Isolated Relay CH2 (Active High)" },
      { label: "Relay CH3", gpioPin: 41, kind: "relay", note: "Onboard Isolated Relay CH3 (Active High)" },
      { label: "Relay CH4", gpioPin: 42, kind: "relay", note: "Onboard Isolated Relay CH4 (Active High)" },
      { label: "Relay CH5", gpioPin: 45, kind: "relay", note: "Onboard Isolated Relay CH5 (Active High)" },
      { label: "Relay CH6", gpioPin: 46, kind: "relay", note: "Onboard Isolated Relay CH6 (Active High)" },
      { label: "WS2812 RGB LED", gpioPin: 38, kind: "rgb_led", note: "GPIO38" },
      { label: "Onboard Buzzer", gpioPin: 21, kind: "buzzer", note: "GPIO21" },
      { label: "Isolated RS485 TX", gpioPin: 17, kind: "uart", note: "GPIO17" },
      { label: "Isolated RS485 RX", gpioPin: 18, kind: "uart", note: "GPIO18" },
      { label: "BOOT Button", gpioPin: 0, kind: "button", note: "GPIO0" },
    ],
  },
  gpio_definitions: withPinOverrides(
    buildDefinitionsFromHeaders(WS_S3_RELAY_LEFT, WS_S3_RELAY_RIGHT, soc.esp32s3Opi),
    {
      1: {
        label: "GPIO1 (Relay CH1)",
        boardNote: "Hardwired to onboard Relay CH1 optocoupler driver (output only)",
        digitalIn: false,
        digitalOut: true,
        adc: false,
        i2c: false,
        spi: false,
        uart: false,
        pwm: false,
        touch: false,
      },
      2: {
        label: "GPIO2 (Relay CH2)",
        boardNote: "Hardwired to onboard Relay CH2 optocoupler driver (output only)",
        digitalIn: false,
        digitalOut: true,
        adc: false,
        i2c: false,
        spi: false,
        uart: false,
        pwm: false,
        touch: false,
      },
      41: {
        label: "GPIO41 (Relay CH3)",
        boardNote: "Hardwired to onboard Relay CH3 optocoupler driver (output only)",
        digitalIn: false,
        digitalOut: true,
        adc: false,
        i2c: false,
        spi: false,
        uart: false,
        pwm: false,
        touch: false,
      },
      42: {
        label: "GPIO42 (Relay CH4)",
        boardNote: "Hardwired to onboard Relay CH4 optocoupler driver (output only)",
        digitalIn: false,
        digitalOut: true,
        adc: false,
        i2c: false,
        spi: false,
        uart: false,
        pwm: false,
        touch: false,
      },
      45: {
        label: "GPIO45 (Relay CH5)",
        boardNote: "Hardwired to onboard Relay CH5 optocoupler driver (strapping pin, output only)",
        digitalIn: false,
        digitalOut: true,
        adc: false,
        i2c: false,
        spi: false,
        uart: false,
        pwm: false,
        touch: false,
      },
      46: {
        label: "GPIO46 (Relay CH6)",
        boardNote: "Hardwired to onboard Relay CH6 optocoupler driver (strapping pin, output only)",
        inputOnly: false,
        digitalIn: false,
        digitalOut: true,
        adc: false,
        i2c: false,
        spi: false,
        uart: false,
        pwm: false,
        touch: false,
      },
      21: {
        label: "GPIO21 (Onboard Buzzer)",
        boardNote: "Drives onboard active/passive buzzer (output/PWM only)",
        digitalIn: false,
        digitalOut: true,
        adc: false,
        i2c: false,
        spi: false,
        uart: false,
        pwm: true,
      },
    }
  ),
});

export const WAVESHARE_ESP_OFFICIAL_BOARDS: readonly WaveshareOfficialBoard[] = [
  {
    seed: WS_S3_ZERO_SEED,
    wikiUrl: "https://www.waveshare.com/wiki/ESP32-S3-Zero",
    officialPinMap: {
      GP1: 1,
      GP2: 2,
      GP3: 3,
      GP4: 4,
      GP5: 5,
      GP6: 6,
      GP7: 7,
      GP8: 8,
      GP9: 9,
      GP10: 10,
      GP11: 11,
      GP12: 12,
      GP13: 13,
      TX: 43,
      RX: 44,
      GP14: 14,
      GP15: 15,
      GP16: 16,
      GP17: 17,
      GP18: 18,
      GP21: 21,
      GP33: 33,
      GP34: 34,
      GP35: 35,
      GP36: 36,
    },
    highlights: [
      "Dual-core ESP32-S3FH4R2 (240 MHz) with 4MB Flash + 2MB Quad PSRAM",
      "Ultra-compact castellated stamp module with onboard ceramic antenna",
      "Native USB-C + onboard WS2812 RGB LED on GPIO21",
    ],
    sources: [
      { label: "Waveshare ESP32-S3-Zero Wiki", url: "https://www.waveshare.com/wiki/ESP32-S3-Zero" },
      { label: "ESP32-S3 Datasheet (Espressif)", url: "https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf" },
    ],
  },
  {
    seed: WS_C6_ZERO_SEED,
    wikiUrl: "https://www.waveshare.com/wiki/ESP32-C6-Zero",
    officialPinMap: {
      GP0: 0,
      GP1: 1,
      GP2: 2,
      GP3: 3,
      GP4: 4,
      GP5: 5,
      GP6: 6,
      GP7: 7,
      GP8: 8,
      GP9: 9,
      GP14: 14,
      GP15: 15,
      TX: 16,
      RX: 17,
      GP18: 18,
      GP19: 19,
      GP20: 20,
      GP21: 21,
      GP22: 22,
      GP23: 23,
    },
    highlights: [
      "ESP32-C6FH4 RISC-V (160 MHz) with Wi-Fi 6, BLE 5.3, and Zigbee / Thread",
      "4MB Flash in ultra-compact castellated Zero form factor",
      "Native USB-C + WS2812 RGB LED on GPIO8",
    ],
    sources: [
      { label: "Waveshare ESP32-C6-Zero Wiki", url: "https://www.waveshare.com/wiki/ESP32-C6-Zero" },
      { label: "ESP32-C6 Datasheet (Espressif)", url: "https://www.espressif.com/sites/default/files/documentation/esp32-c6_datasheet_en.pdf" },
    ],
  },
  {
    seed: WS_C3_ZERO_SEED,
    wikiUrl: "https://www.waveshare.com/wiki/ESP32-C3-Zero",
    officialPinMap: {
      GP0: 0,
      GP1: 1,
      GP2: 2,
      GP3: 3,
      GP4: 4,
      GP5: 5,
      GP6: 6,
      GP7: 7,
      GP8: 8,
      GP9: 9,
      GP10: 10,
      RX: 20,
      TX: 21,
    },
    highlights: [
      "Low-cost ESP32-C3FH4 RISC-V (160 MHz) with 4MB Flash, Wi-Fi 4 + BLE 5.0",
      "Castellated stamp pins for compact smart-home enclosures",
      "Native USB-C + WS2812 RGB LED on GPIO10",
    ],
    sources: [
      { label: "Waveshare ESP32-C3-Zero Wiki", url: "https://www.waveshare.com/wiki/ESP32-C3-Zero" },
      { label: "ESP32-C3 Datasheet (Espressif)", url: "https://www.espressif.com/sites/default/files/documentation/esp32-c3_datasheet_en.pdf" },
    ],
  },
  {
    seed: WS_S3_PICO_SEED,
    wikiUrl: "https://www.waveshare.com/wiki/ESP32-S3-Pico",
    officialPinMap: {
      GP1: 1,
      GP2: 2,
      GP4: 4,
      GP5: 5,
      GP6: 6,
      GP7: 7,
      GP8: 8,
      GP9: 9,
      GP10: 10,
      GP11: 11,
      GP12: 12,
      GP13: 13,
      GP14: 14,
      GP15: 15,
      GP16: 16,
      GP17: 17,
      GP18: 18,
      GP33: 33,
      GP34: 34,
      GP35: 35,
      GP36: 36,
      GP37: 37,
      GP38: 38,
      GP39: 39,
      GP40: 40,
      GP41: 41,
      GP42: 42,
    },
    highlights: [
      "ESP32-S3R2 with 16MB Flash + 2MB Quad PSRAM in 40-pin Pico layout",
      "27 exposed multi-function GPIO pins compatible with Pico accessories",
      "Native USB-C + onboard WS2812 RGB LED on GPIO21",
    ],
    sources: [
      { label: "Waveshare ESP32-S3-Pico Wiki", url: "https://www.waveshare.com/wiki/ESP32-S3-Pico" },
      { label: "ESP32-S3 Datasheet (Espressif)", url: "https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf" },
    ],
  },
  {
    seed: WS_S3_RELAY_6CH_SEED,
    wikiUrl: "https://www.waveshare.com/wiki/ESP32-S3-Relay-6CH",
    officialPinMap: {
      CH1: 1,
      CH2: 2,
      GP4: 4,
      GP5: 5,
      GP6: 6,
      GP7: 7,
      GP8: 8,
      GP9: 9,
      RS485_TX: 17,
      RS485_RX: 18,
      BUZZ: 21,
      RGB: 38,
      CH3: 41,
      CH4: 42,
      CH5: 45,
      CH6: 46,
    },
    highlights: [
      "6-channel opto-isolated industrial relay board powered by ESP32-S3-WROOM-1-N16R8",
      "16MB Flash + 8MB Octal PSRAM + isolated RS485 interface",
      "Dedicated onboard buzzer (GPIO21) and WS2812 RGB status LED (GPIO38)",
    ],
    sources: [
      { label: "Waveshare ESP32-S3-Relay-6CH Wiki", url: "https://www.waveshare.com/wiki/ESP32-S3-Relay-6CH" },
      { label: "ESP32-S3 Datasheet (Espressif)", url: "https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf" },
    ],
  },
];

// ---------------------------------------------------------------------------
// NodeMCU ESP8266 (ESP-12E Amica v2, 4MB Flash, Wi-Fi 4)
// ---------------------------------------------------------------------------

const NODEMCU_8266_LEFT: BoardHeaderPin[] = [
  hp(1, "Left", "A0", 17, "gpio", { aliases: ["ADC0", "TOUT"], note: "Dedicated 10-bit Analog Input (0-3.3V, input-only ADC)" }),
  hp(2, "Left", "RSV", null, "nc"),
  hp(3, "Left", "RSV", null, "nc"),
  hp(4, "Left", "SD3", 10, "gpio", { aliases: ["GPIO10"], note: "Internal SPI Flash (avoid)" }),
  hp(5, "Left", "SD2", 9, "gpio", { aliases: ["GPIO9"], note: "Internal SPI Flash (avoid)" }),
  hp(6, "Left", "SD1", 8, "gpio", { aliases: ["GPIO8"], note: "Internal SPI Flash" }),
  hp(7, "Left", "CMD", 11, "gpio", { aliases: ["GPIO11"], note: "Internal SPI Flash" }),
  hp(8, "Left", "SD0", 7, "gpio", { aliases: ["GPIO7"], note: "Internal SPI Flash" }),
  hp(9, "Left", "CLK", 6, "gpio", { aliases: ["GPIO6"], note: "Internal SPI Flash" }),
  hp(10, "Left", "GND", null, "ground"),
  hp(11, "Left", "3V3", null, "power", { voltage: "3.3V" }),
  hp(12, "Left", "EN", null, "reset", { aliases: ["CH_PD"], note: "Chip enable" }),
  hp(13, "Left", "RST", null, "reset"),
  hp(14, "Left", "GND", null, "ground"),
  hp(15, "Left", "VIN", null, "power", { voltage: "5V" }),
];

const NODEMCU_8266_RIGHT: BoardHeaderPin[] = [
  hp(1, "Right", "D0", 16, "gpio", { aliases: ["GPIO16", "WAKE"], note: "Deep-sleep wake / onboard LED (no pull-up/I2C)" }),
  hp(2, "Right", "D1", 5, "gpio", { aliases: ["GPIO5", "SCL"], note: "Default I2C SCL (safe GPIO)" }),
  hp(3, "Right", "D2", 4, "gpio", { aliases: ["GPIO4", "SDA"], note: "Default I2C SDA (safe GPIO)" }),
  hp(4, "Right", "D3", 0, "gpio", { aliases: ["GPIO0", "FLASH"], note: "FLASH boot strapping pin" }),
  hp(5, "Right", "D4", 2, "gpio", { aliases: ["GPIO2", "TXD1"], note: "ESP-12E onboard LED / boot strapping" }),
  hp(6, "Right", "3V3", null, "power", { voltage: "3.3V" }),
  hp(7, "Right", "GND", null, "ground"),
  hp(8, "Right", "D5", 14, "gpio", { aliases: ["GPIO14", "HSCLK"], note: "Safe GPIO / SPI CLK" }),
  hp(9, "Right", "D6", 12, "gpio", { aliases: ["GPIO12", "HMISO"], note: "Safe GPIO / SPI MISO" }),
  hp(10, "Right", "D7", 13, "gpio", { aliases: ["GPIO13", "HMOSI"], note: "Safe GPIO / SPI MOSI" }),
  hp(11, "Right", "D8", 15, "gpio", { aliases: ["GPIO15", "HCS"], note: "Boot strapping (pulled LOW via 10k)" }),
  hp(12, "Right", "RX", 3, "gpio", { aliases: ["GPIO3", "RXD0"], note: "UART0 RX console" }),
  hp(13, "Right", "TX", 1, "gpio", { aliases: ["GPIO1", "TXD0"], note: "UART0 TX console" }),
  hp(14, "Right", "GND", null, "ground"),
  hp(15, "Right", "3V3", null, "power", { voltage: "3.3V" }),
];

export const NODEMCU_ESP8266_BOARD: CatalogBoardSeed = finalizeSeed({
  slug: "nodemcu-esp8266",
  manufacturer: "NodeMCU",
  model: "NodeMCU ESP8266 (ESP-12E)",
  revision: "v2",
  chip_family: "esp8266",
  chip_variant: "ESP8266EX (ESP-12E)",
  flash_size_mb: 4,
  psram_size_mb: 0,
  usb_vid: "0x10C4",
  usb_pid: "0xEA60",
  catalog_category: "partner",
  series: "ESP8266 NodeMCU",
  image_url: null,
  pinout_image_url: null,
  docs_url: "https://nodemcu.readthedocs.io/en/release/getting-started/",
  datasheet_url: "https://www.espressif.com/sites/default/files/documentation/0a-esp8266ex_datasheet_en.pdf",
  source_url: "https://github.com/nodemcu/nodemcu-devkit-v1.0",
  source_provider: NODEMCU_SOURCE_PROVIDER,
  verification_status: "verified",
  firmware_status: "catalog_only",
  revision_notes:
    "Classic NodeMCU v2 Amica ESP-12E (ESP8266EX) Wi-Fi 4 development board with 4MB Flash, CP2102 Micro-USB bridge, and D0–D8 headers. Safe relay/sensor GPIOs: D1 (GPIO5), D2 (GPIO4), D5 (GPIO14), D6 (GPIO12), D7 (GPIO13).",
  is_published: true,
  board_layout: {
    formFactor: "devkit",
    orientation: "vertical",
    aspectRatio: 25.4 / 48.26,
    usbEdge: "bottom",
    usbLabel: "Micro-USB (CP2102)",
    antennaEdge: "top",
    antennaLabel: "ESP-12E PCB Antenna",
    hardwareSpecs: {
      processor: "Single-Core Xtensa L106 (80 / 160 MHz)",
      wireless: "Wi-Fi 4 (2.4 GHz, No BLE)",
      usb: "1x Micro-USB (CP2102 UART)",
      usbPortCount: 1,
      usbConnector: "micro-usb",
      buttons: "RST + FLASH",
      resetLabel: "RST",
      modulePackage: "wroom",
      hasUartBridge: true,
    },
    leftHeader: { name: "Left", pins: NODEMCU_8266_LEFT },
    rightHeader: { name: "Right", pins: NODEMCU_8266_RIGHT },
    onboardFeatures: [
      { label: "Onboard Blue LED", gpioPin: 2, kind: "led", note: "GPIO2 / D4 (active-low)" },
      { label: "NodeMCU LED / Wake", gpioPin: 16, kind: "led", note: "GPIO16 / D0 (active-low)" },
      { label: "FLASH Button", gpioPin: 0, kind: "button", note: "GPIO0 / D3" },
    ],
  },
  gpio_definitions: [
    ...withPinOverrides(
      buildDefinitionsFromHeaders(
        NODEMCU_8266_LEFT.filter((p) => p.gpioPin !== 17),
        NODEMCU_8266_RIGHT,
        soc.esp8266NodeMcu
      ),
      {
        16: {
          pullUp: false,
          pullDown: true,
          i2c: false,
        },
      }
    ),
    {
      pin: 17,
      label: "A0 (ADC0 / TOUT)",
      board_pin_name: "A0",
      header_side: "left",
      header_position: 1,
      board_note: "Dedicated 10-bit ADC input (0–3.3V via onboard divider; analog input only)",
      capabilities: {
        digital_in: false,
        digital_out: false,
        pwm: false,
        adc: true,
        i2c: false,
        spi: false,
        uart: false,
        touch: false,
        pull_up: false,
        pull_down: false,
      },
      restrictions: {
        input_only: true,
        reserved: false,
        strapping_pin: false,
        flash_psram_conflict: false,
        usb_jtag_conflict: false,
      },
    },
  ],
});

/**
 * Additional partner & community boards seeded by migrations (kept outside
 * VERIFIED_BOARD_CATALOG which tracks the ESP-IDF CI build matrix).
 */
export const COMMUNITY_PARTNER_BOARDS: readonly CatalogBoardSeed[] = [
  WS_S3_ZERO_SEED,
  NODEMCU_ESP8266_BOARD,
];

export function findWaveshareEspOfficialBoard(
  slug: string
): WaveshareOfficialBoard | undefined {
  return WAVESHARE_ESP_OFFICIAL_BOARDS.find((b) => b.seed.slug === slug);
}

export function findCommunityPartnerBoard(slug: string): CatalogBoardSeed | undefined {
  return COMMUNITY_PARTNER_BOARDS.find((b) => b.slug === slug);
}
