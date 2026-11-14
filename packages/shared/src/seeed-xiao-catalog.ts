/**
 * Seeed Studio XIAO (ESP32 family) reference profiles.
 *
 * Every value below is transcribed from Seeed Studio's own publications and is
 * re-checked against them by the admin "Import official boards" preview:
 *
 *  - pad -> GPIO map:   the "XIAO Pin / Function / Chip Pin" table on each
 *                       board's Getting Started wiki page (SEEED_XIAO_WIKI_URLS)
 *  - MCU, flash, USB:   the board manifest in Seeed's PlatformIO platform
 *                       (github.com/Seeed-Studio/platform-seeedboards/boards)
 *  - images, datasheet: files.seeedstudio.com links published on the wiki page
 *  - hardware revision: the version in the name of the schematic Seeed links
 *                       on the wiki page (for example
 *                       XIAO_ESP32C3_v1.3_SCH_260116.pdf). The XIAO ESP32-C5
 *                       schematic carries no version, so its revision is
 *                       stored as unspecified instead of a guessed number.
 *
 * GPIO capabilities and restrictions are NOT copied from the wiki. They are
 * derived from the same per-SoC pin rules as the verified Espressif boards
 * (BOARD_CATALOG_BUILDERS), so a XIAO pin is judged exactly like the same GPIO
 * on a DevKit.
 *
 * These profiles are not part of VERIFIED_BOARD_CATALOG on purpose: they enter
 * the Board Library only when an admin selects them in the import preview.
 */
import {
  BOARD_CATALOG_BUILDERS,
  BOARD_REVISION_UNSPECIFIED,
  VERIFIED_BOARD_CATALOG,
  type BoardCatalogSocPinProfile,
  type CatalogBoardSeed,
} from "./board-catalog-data";
import { resolveBoardFirmwareCompatibility } from "./board-firmware-compat";
import type { BoardHeaderPin, BoardLayoutSpec } from "./index";

const { headerPin: hp, buildDefinitionsFromHeaders, soc } = BOARD_CATALOG_BUILDERS;

export const SEEED_XIAO_SOURCE_PROVIDER = "seeed_partner";

export const SEEED_PLATFORM_REPO_URL = "https://github.com/Seeed-Studio/platform-seeedboards";
export const SEEED_PLATFORM_BOARDS_INDEX_URL =
  "https://api.github.com/repos/Seeed-Studio/platform-seeedboards/contents/boards";

export function seeedPlatformManifestUrl(manifestName: string): string {
  return `https://raw.githubusercontent.com/Seeed-Studio/platform-seeedboards/main/boards/${manifestName}.json`;
}

export const SEEED_XIAO_WIKI_URLS = {
  esp32c3: "https://wiki.seeedstudio.com/XIAO_ESP32C3_Getting_Started/",
  esp32s3: "https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/",
  esp32c6: "https://wiki.seeedstudio.com/xiao_esp32c6_getting_started/",
  esp32c5: "https://wiki.seeedstudio.com/xiao_esp32c5_getting_started/",
} as const;

export interface OfficialBoardSourceRef {
  label: string;
  url: string;
}

export interface SeeedXiaoOfficialBoard {
  /** Complete Board Library profile, in the same shape as the verified catalog. */
  seed: CatalogBoardSeed;
  /** Official pad name -> chip GPIO, exactly as printed in Seeed's pin table. */
  officialPinMap: Record<string, number>;
  wikiUrl: string;
  /** Manifest name in Seeed's PlatformIO platform; null when Seeed publishes none. */
  platformManifest: string | null;
  /** Short facts from the official specification table, shown in the preview. */
  highlights: string[];
  sources: OfficialBoardSourceRef[];
}

// ---------------------------------------------------------------------------
// SoC rules. A XIAO has no USB-UART bridge, so the UART0 pads (D6 / D7) are
// free GPIOs instead of a reserved console, as on the existing XIAO ESP32-S3.
// ---------------------------------------------------------------------------

const XIAO_ESP32_C3_SOC: BoardCatalogSocPinProfile = { ...soc.esp32c3, uart0Pins: {} };
const XIAO_ESP32_C6_SOC: BoardCatalogSocPinProfile = { ...soc.esp32c6, uart0Pins: {} };
const XIAO_ESP32_C5_SOC: BoardCatalogSocPinProfile = { ...soc.esp32c5, uart0Pins: {} };
/** The Plus breaks out GPIO10-13, which carry ADC1_CH9 and TOUCH10-13 on the ESP32-S3. */
const XIAO_ESP32_S3_PLUS_SOC: BoardCatalogSocPinProfile = {
  ...soc.xiaoEsp32s3,
  adcPins: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  touchPins: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]),
};

// ---------------------------------------------------------------------------
// The XIAO footprint is the same on every board: D0-D6 down the left edge and
// 5V, GND, 3V3, D10, D9, D8, D7 down the right edge, USB-C at the top.
// ---------------------------------------------------------------------------

const POWER_5V = hp(1, "Right", "5V", null, "power", { voltage: "5V", note: "USB VBUS 5V" });
const POWER_GND = hp(2, "Right", "GND", null, "ground", { voltage: "GND" });
const POWER_3V3 = hp(3, "Right", "3V3", null, "power", {
  voltage: "3.3V",
  note: "Regulated 3.3V out",
});

const XIAO_C3_LEFT: BoardHeaderPin[] = [
  hp(1, "Left", "D0 / A0", 2, "gpio", { aliases: ["A0", "D0", "ADC1_CH2"] }),
  hp(2, "Left", "D1 / A1", 3, "gpio", { aliases: ["A1", "D1", "ADC1_CH3"] }),
  hp(3, "Left", "D2 / A2", 4, "gpio", { aliases: ["A2", "D2", "ADC1_CH4", "MTMS"] }),
  hp(4, "Left", "D3", 5, "gpio", { aliases: ["A3", "D3", "ADC2_CH0", "MTDI"] }),
  hp(5, "Left", "D4 / SDA", 6, "gpio", { aliases: ["D4", "SDA", "MTCK"], note: "I2C SDA" }),
  hp(6, "Left", "D5 / SCL", 7, "gpio", { aliases: ["D5", "SCL", "MTDO"], note: "I2C SCL" }),
  hp(7, "Left", "D6 / TX", 21, "gpio", {
    aliases: ["D6", "TX", "U0TXD"],
    note: "UART TX (free GPIO)",
  }),
];

const XIAO_C3_RIGHT: BoardHeaderPin[] = [
  POWER_5V,
  POWER_GND,
  POWER_3V3,
  hp(4, "Right", "D10 / MOSI", 10, "gpio", { aliases: ["D10", "MOSI"], note: "SPI MOSI" }),
  hp(5, "Right", "D9 / MISO", 9, "gpio", { aliases: ["D9", "MISO", "BOOT"], note: "SPI MISO" }),
  hp(6, "Right", "D8 / SCK", 8, "gpio", { aliases: ["D8", "SCK"], note: "SPI SCK" }),
  hp(7, "Right", "D7 / RX", 20, "gpio", {
    aliases: ["D7", "RX", "U0RXD"],
    note: "UART RX (free GPIO)",
  }),
];

const XIAO_C6_LEFT: BoardHeaderPin[] = [
  hp(1, "Left", "D0 / A0", 0, "gpio", { aliases: ["A0", "D0", "ADC1_CH0", "LP_GPIO0"] }),
  hp(2, "Left", "D1 / A1", 1, "gpio", { aliases: ["A1", "D1", "ADC1_CH1", "LP_GPIO1"] }),
  hp(3, "Left", "D2 / A2", 2, "gpio", { aliases: ["A2", "D2", "ADC1_CH2", "LP_GPIO2"] }),
  hp(4, "Left", "D3", 21, "gpio", { aliases: ["D3", "SDIO_DATA1"] }),
  hp(5, "Left", "D4 / SDA", 22, "gpio", { aliases: ["D4", "SDA", "SDIO_DATA2"], note: "I2C SDA" }),
  hp(6, "Left", "D5 / SCL", 23, "gpio", { aliases: ["D5", "SCL", "SDIO_DATA3"], note: "I2C SCL" }),
  hp(7, "Left", "D6 / TX", 16, "gpio", {
    aliases: ["D6", "TX", "U0TXD"],
    note: "UART TX (free GPIO)",
  }),
];

const XIAO_C6_RIGHT: BoardHeaderPin[] = [
  POWER_5V,
  POWER_GND,
  POWER_3V3,
  hp(4, "Right", "D10 / MOSI", 18, "gpio", { aliases: ["D10", "MOSI"], note: "SPI MOSI" }),
  hp(5, "Right", "D9 / MISO", 20, "gpio", { aliases: ["D9", "MISO"], note: "SPI MISO" }),
  hp(6, "Right", "D8 / SCK", 19, "gpio", { aliases: ["D8", "SCK"], note: "SPI SCK" }),
  hp(7, "Right", "D7 / RX", 17, "gpio", {
    aliases: ["D7", "RX", "U0RXD"],
    note: "UART RX (free GPIO)",
  }),
];

const XIAO_C5_LEFT: BoardHeaderPin[] = [
  hp(1, "Left", "D0 / A0", 1, "gpio", { aliases: ["A0", "D0", "ADC1_CH0", "LP_GPIO1"] }),
  hp(2, "Left", "D1", 0, "gpio", { aliases: ["D1", "LP_GPIO0"] }),
  hp(3, "Left", "D2", 25, "gpio", { aliases: ["D2"] }),
  hp(4, "Left", "D3", 7, "gpio", { aliases: ["D3", "SDIO_DATA1"] }),
  hp(5, "Left", "D4 / SDA", 23, "gpio", { aliases: ["D4", "SDA"], note: "I2C SDA" }),
  hp(6, "Left", "D5 / SCL", 24, "gpio", { aliases: ["D5", "SCL"], note: "I2C SCL" }),
  hp(7, "Left", "D6 / TX", 11, "gpio", {
    aliases: ["D6", "TX", "U0TXD"],
    note: "UART TX (free GPIO)",
  }),
];

const XIAO_C5_RIGHT: BoardHeaderPin[] = [
  POWER_5V,
  POWER_GND,
  POWER_3V3,
  hp(4, "Right", "D10 / MOSI", 10, "gpio", { aliases: ["D10", "MOSI"], note: "SPI MOSI" }),
  hp(5, "Right", "D9 / MISO", 9, "gpio", { aliases: ["D9", "MISO"], note: "SPI MISO" }),
  hp(6, "Right", "D8 / SCK", 8, "gpio", { aliases: ["D8", "SCK"], note: "SPI SCK" }),
  hp(7, "Right", "D7 / RX", 12, "gpio", {
    aliases: ["D7", "RX", "U0RXD"],
    note: "UART RX (free GPIO)",
  }),
];

/** Same pads as the plain XIAO ESP32-S3; D8-D10 also serve the Sense microSD slot. */
const XIAO_S3_SENSE_LEFT: BoardHeaderPin[] = BOARD_CATALOG_BUILDERS.xiaoEsp32s3Headers.left;
const XIAO_S3_SENSE_RIGHT: BoardHeaderPin[] = [
  POWER_5V,
  POWER_GND,
  POWER_3V3,
  hp(4, "Right", "D10 / MOSI", 9, "gpio", {
    aliases: ["A10", "D10", "MOSI", "SD_MOSI"],
    note: "SPI MOSI (shared with the microSD slot)",
  }),
  hp(5, "Right", "D9 / MISO", 8, "gpio", {
    aliases: ["A9", "D9", "MISO", "SD_MISO"],
    note: "SPI MISO (shared with the microSD slot)",
  }),
  hp(6, "Right", "D8 / SCK", 7, "gpio", {
    aliases: ["A8", "D8", "SCK", "SD_SCK"],
    note: "SPI SCK (shared with the microSD slot)",
  }),
  hp(7, "Right", "D7 / RX", 44, "gpio", {
    aliases: ["D7", "RX", "U0RXD"],
    note: "UART RX (free GPIO)",
  }),
];

const XIAO_S3_PLUS_BACK_PADS: BoardHeaderPin[] = [
  hp(1, "Back", "D11", 38, "gpio", { aliases: ["D11", "I2S_SD"], note: "Back pad" }),
  hp(2, "Back", "D12", 39, "gpio", { aliases: ["D12", "I2S_SCK", "MTCK"], note: "Back pad" }),
  hp(3, "Back", "D13", 40, "gpio", { aliases: ["D13", "I2S_WS", "MTDO"], note: "Back pad" }),
  hp(4, "Back", "D14", 41, "gpio", { aliases: ["D14", "PDM_DATA", "MTDI"], note: "Back pad" }),
  hp(5, "Back", "D15", 42, "gpio", { aliases: ["D15", "PDM_CLK", "MTMS"], note: "Back pad" }),
  hp(6, "Back", "D16", 10, "gpio", {
    aliases: ["D16", "ADC1_CH9", "ADC_BAT"],
    note: "Back pad (also reads the battery voltage, ADC_BAT)",
  }),
  hp(7, "Back", "D17", 13, "gpio", { aliases: ["D17", "SPI1_SCK"], note: "Back pad" }),
  hp(8, "Back", "D18", 12, "gpio", { aliases: ["D18", "SPI1_MISO"], note: "Back pad" }),
  hp(9, "Back", "D19", 11, "gpio", { aliases: ["D19", "SPI1_MOSI"], note: "Back pad" }),
];

/** GPIOs wired to the OV camera connector of the Sense expansion board. */
const XIAO_S3_SENSE_CAMERA_PINS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 38, 39, 40, 47, 48];

function xiaoLayout(params: {
  left: BoardHeaderPin[];
  right: BoardHeaderPin[];
  processor: string;
  wireless: string;
  antennaLabel: string;
  onboardFeatures: NonNullable<BoardLayoutSpec["onboardFeatures"]>;
  extraPads?: BoardLayoutSpec["extraPads"];
}): BoardLayoutSpec {
  return {
    formFactor: "xiao",
    orientation: "vertical",
    aspectRatio: 773 / 977,
    usbEdge: "top",
    usbLabel: "USB Type-C",
    antennaEdge: "bottom",
    antennaLabel: params.antennaLabel,
    imageFrame: { pinTopPct: 18.5, pinBottomPct: 87.5 },
    hardwareSpecs: {
      processor: params.processor,
      wireless: params.wireless,
      usb: "1x USB-C",
      usbPortCount: 1,
      usbConnector: "usb-c",
      buttons: "RESET + BOOT",
      resetLabel: "RESET",
      modulePackage: "xiao",
      hasUartBridge: false,
    },
    leftHeader: { name: "Left (D0-D6)", pins: params.left },
    rightHeader: { name: "Right (Power / D7-D10)", pins: params.right },
    ...(params.extraPads ? { extraPads: params.extraPads } : {}),
    onboardFeatures: params.onboardFeatures,
  };
}

const COMMON_SEED = {
  manufacturer: "Seeed Studio",
  catalog_category: "partner",
  source_provider: SEEED_XIAO_SOURCE_PROVIDER,
  verification_status: "verified",
  firmware_status: "catalog_only",
  is_published: true,
  // Official PlatformIO manifests: "flash_mode": "qio", "f_flash": "80000000L".
  flash_mode: "qio",
  flash_freq: "80m",
  usb_interface: "Native USB-C (CDC/JTAG)",
} as const;

const RAW_NEW_BOARDS: SeeedXiaoOfficialBoard[] = [
  {
    seed: {
      ...COMMON_SEED,
      slug: "seeed-xiao-esp32c3",
      model: "XIAO ESP32-C3",
      revision: "v1.3",
      chip_family: "esp32c3",
      chip_variant: "ESP32-C3",
      flash_size_mb: 4,
      psram_size_mb: 0,
      usb_vid: "0x303A",
      usb_pid: "0x1001",
      series: "ESP32-C3",
      image_url: "https://files.seeedstudio.com/wiki/XIAO_WiFi/board-pic.png",
      pinout_image_url:
        "https://files.seeedstudio.com/wiki/XIAO_WiFi/XIAO_ESP32-C3_front_pinout.png",
      docs_url: SEEED_XIAO_WIKI_URLS.esp32c3,
      datasheet_url: "https://files.seeedstudio.com/wiki/XIAO_WiFi/Resources/esp32-c3_datasheet.pdf",
      source_url: SEEED_XIAO_WIKI_URLS.esp32c3,
      revision_notes:
        "21 x 17.8 mm board with 11 GPIO pads on 7+7 castellations. D0 (GPIO2), D8 (GPIO8) and D9 (GPIO9, BOOT button) are boot-strapping pins. D3 (GPIO5) is on ADC2 and is not offered as an analog input. No user LED.",
      board_layout: xiaoLayout({
        left: XIAO_C3_LEFT,
        right: XIAO_C3_RIGHT,
        processor: "Single-Core RISC-V (160 MHz)",
        wireless: "Wi-Fi 4 (2.4 GHz), BLE 5.0",
        antennaLabel: "U.FL antenna",
        onboardFeatures: [
          { label: "BOOT Button", gpioPin: 9, kind: "button", note: "BOOT button on GPIO9 (pad D9)" },
          { label: "USB Serial / JTAG", gpioPin: 18, kind: "usb", note: "GPIO18/19 USB Type-C" },
        ],
      }),
      gpio_definitions: buildDefinitionsFromHeaders(XIAO_C3_LEFT, XIAO_C3_RIGHT, XIAO_ESP32_C3_SOC),
    },
    officialPinMap: { D0: 2, D1: 3, D2: 4, D3: 5, D4: 6, D5: 7, D6: 21, D7: 20, D8: 8, D9: 9, D10: 10 },
    wikiUrl: SEEED_XIAO_WIKI_URLS.esp32c3,
    platformManifest: "seeed-xiao-esp32-c3",
    highlights: [
      "400 KB SRAM and 4 MB flash on chip",
      "1x UART, 1x I2C, 1x SPI, 11x GPIO (PWM), 4x ADC",
      "Reset and Boot buttons, charge LED",
    ],
    sources: [],
  },
  {
    seed: {
      ...COMMON_SEED,
      slug: "seeed-xiao-esp32c6",
      model: "XIAO ESP32-C6",
      revision: "v1.0",
      chip_family: "esp32c6",
      chip_variant: "ESP32-C6",
      flash_size_mb: 4,
      psram_size_mb: 0,
      usb_vid: "0x303A",
      usb_pid: "0x1001",
      series: "ESP32-C6",
      image_url: "https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32C6/img/xiaoc6.jpg",
      pinout_image_url:
        "https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32C6/img/XIAO_ESP32-C6_front_pinout.png",
      docs_url: SEEED_XIAO_WIKI_URLS.esp32c6,
      datasheet_url:
        "https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32C6/res/esp32-c6_datasheet_en.pdf",
      source_url: SEEED_XIAO_WIKI_URLS.esp32c6,
      revision_notes:
        "21 x 17.8 mm board with 11 GPIO pads. User LED on GPIO15. GPIO3 powers the on-board RF switch and GPIO14 selects the internal or external antenna; both are reserved. BOOT button on GPIO9.",
      board_layout: xiaoLayout({
        left: XIAO_C6_LEFT,
        right: XIAO_C6_RIGHT,
        processor: "RISC-V HP (160 MHz) + LP (20 MHz)",
        wireless: "Wi-Fi 6 (2.4 GHz), BLE 5.0, Zigbee / Thread",
        antennaLabel: "Ceramic + U.FL antenna",
        onboardFeatures: [
          { label: "USER LED", gpioPin: 15, kind: "led", note: "User LED on GPIO15" },
          { label: "BOOT Button", gpioPin: 9, kind: "button", note: "BOOT button on GPIO9" },
          { label: "USB Serial / JTAG", gpioPin: 12, kind: "usb", note: "GPIO12/13 USB Type-C" },
        ],
      }),
      gpio_definitions: buildDefinitionsFromHeaders(XIAO_C6_LEFT, XIAO_C6_RIGHT, XIAO_ESP32_C6_SOC, [
        { pin: 15, note: "Onboard USER LED" },
        { pin: 9, note: "Onboard BOOT button" },
        { pin: 3, note: "RF switch power", reservedReason: "Powers the on-board RF switch (LOW = enabled)" },
        {
          pin: 14,
          note: "Antenna select",
          reservedReason: "Selects the internal or external antenna (on-board RF switch)",
        },
      ]),
    },
    officialPinMap: { D0: 0, D1: 1, D2: 2, D3: 21, D4: 22, D5: 23, D6: 16, D7: 17, D8: 19, D9: 20, D10: 18 },
    wikiUrl: SEEED_XIAO_WIKI_URLS.esp32c6,
    platformManifest: "seeed-xiao-esp32-c6",
    highlights: [
      "512 KB SRAM and 4 MB flash on chip",
      "1x UART, 1x LP_UART, 1x I2C, 1x LP_I2C, 1x SPI, 11x GPIO (PWM), 7x ADC, 1x SDIO",
      "On-board ceramic antenna with a switchable U.FL connector",
    ],
    sources: [],
  },
  {
    seed: {
      ...COMMON_SEED,
      slug: "seeed-xiao-esp32c5",
      model: "XIAO ESP32-C5",
      // Seeed publishes no hardware revision for this board.
      revision: BOARD_REVISION_UNSPECIFIED,
      chip_family: "esp32c5",
      chip_variant: "ESP32-C5",
      flash_size_mb: 8,
      psram_size_mb: 8,
      usb_vid: "0x303A",
      usb_pid: "0x1001",
      series: "ESP32-C5",
      image_url:
        "https://files.seeedstudio.com/wiki/XIAO_ESP32C5/Getting_started/3-100010048-Seeed-Studio-XIAO-ESP32C5.jpg",
      pinout_image_url:
        "https://files.seeedstudio.com/wiki/XIAO_ESP32C5/Getting_started/XIAO_ESP32-C5_front_pinout.png",
      docs_url: SEEED_XIAO_WIKI_URLS.esp32c5,
      datasheet_url: "https://files.seeedstudio.com/wiki/XIAO_ESP32C5/res/esp32-c5_datasheet_en.pdf",
      source_url: SEEED_XIAO_WIKI_URLS.esp32c5,
      revision_notes:
        "21 x 17.8 mm dual-band Wi-Fi 6 board with 11 GPIO pads. D2 (GPIO25) and D3 (GPIO7) are boot-strapping pins. User LED on GPIO27, BOOT button on GPIO28. GPIO6 reads the battery voltage and GPIO26 enables that measurement; both are reserved.",
      board_layout: xiaoLayout({
        left: XIAO_C5_LEFT,
        right: XIAO_C5_RIGHT,
        processor: "Single-Core RISC-V (240 MHz)",
        wireless: "Dual-band Wi-Fi 6 (2.4 + 5 GHz), BLE 5, Zigbee / Thread",
        antennaLabel: "U.FL antenna",
        onboardFeatures: [
          { label: "USER LED", gpioPin: 27, kind: "led", note: "Yellow user LED on GPIO27" },
          { label: "BOOT Button", gpioPin: 28, kind: "button", note: "BOOT button on GPIO28" },
          { label: "USB Serial / JTAG", gpioPin: 13, kind: "usb", note: "GPIO13/14 USB Type-C" },
        ],
      }),
      gpio_definitions: buildDefinitionsFromHeaders(XIAO_C5_LEFT, XIAO_C5_RIGHT, XIAO_ESP32_C5_SOC, [
        { pin: 27, note: "Onboard USER LED" },
        { pin: 28, note: "Onboard BOOT button" },
        { pin: 6, note: "Battery voltage sense", reservedReason: "Reads the battery voltage (ADC_BAT)" },
        {
          pin: 26,
          note: "Battery measurement enable",
          reservedReason: "Enables the battery measurement circuit (ADC_CRL)",
        },
      ]),
    },
    officialPinMap: { D0: 1, D1: 0, D2: 25, D3: 7, D4: 23, D5: 24, D6: 11, D7: 12, D8: 8, D9: 9, D10: 10 },
    wikiUrl: SEEED_XIAO_WIKI_URLS.esp32c5,
    platformManifest: "seeed-xiao-esp32-c5",
    highlights: [
      "8 MB PSRAM and 8 MB flash",
      "I2C, UART, SPI; 11 PWM pins, 5 analog pins",
      "Reset and Boot buttons, charge LED and user LED",
    ],
    sources: [],
  },
  {
    seed: {
      ...COMMON_SEED,
      slug: "seeed-xiao-esp32s3-sense",
      model: "XIAO ESP32-S3 Sense",
      revision: "v1.51",
      chip_family: "esp32s3",
      chip_variant: "ESP32-S3R8",
      flash_size_mb: 8,
      psram_size_mb: 8,
      usb_vid: "0x2886",
      usb_pid: "0x0056",
      series: "ESP32-S3",
      image_url:
        "https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32S3/img/xiaoesp32s3sense.jpg",
      pinout_image_url:
        "https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32S3/img/XIAO_ESP32-S3_Sense_front_pinout.png",
      docs_url: SEEED_XIAO_WIKI_URLS.esp32s3,
      datasheet_url:
        "https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32S3/res/esp32-s3_datasheet.pdf",
      source_url: SEEED_XIAO_WIKI_URLS.esp32s3,
      revision_notes:
        "XIAO ESP32-S3 with the Sense expansion board: camera connector, digital microphone and microSD slot. The camera and microphone GPIOs are reserved. D8-D10 are shared with the microSD slot, whose chip select is GPIO21 (also the user LED).",
      board_layout: xiaoLayout({
        left: XIAO_S3_SENSE_LEFT,
        right: XIAO_S3_SENSE_RIGHT,
        processor: "Dual-Core Xtensa LX7 (240 MHz)",
        wireless: "Wi-Fi 4 (2.4 GHz), BLE 5.0",
        antennaLabel: "U.FL / B2B",
        onboardFeatures: [
          { label: "USER LED", gpioPin: 21, kind: "led", note: "User LED on GPIO21" },
          { label: "BOOT Button", gpioPin: 0, kind: "button", note: "BOOT button on GPIO0" },
          { label: "USB Serial / JTAG", gpioPin: 19, kind: "usb", note: "GPIO19/20 USB Type-C" },
          { label: "microSD slot", gpioPin: 21, kind: "sd", note: "CS on GPIO21, SPI on GPIO7/8/9" },
          { label: "Camera connector", gpioPin: 10, kind: "camera", note: "DVP camera on GPIO10-18, 38-40, 47, 48" },
        ],
      }),
      gpio_definitions: buildDefinitionsFromHeaders(
        XIAO_S3_SENSE_LEFT,
        XIAO_S3_SENSE_RIGHT,
        soc.xiaoEsp32s3,
        [
          { pin: 21, note: "Onboard USER LED (shared with microSD CS)" },
          { pin: 0, note: "Onboard BOOT button" },
          {
            pin: 42,
            name: "D11",
            note: "Microphone clock",
            reservedReason: "PDM clock of the on-board digital microphone",
          },
          {
            pin: 41,
            name: "D12",
            note: "Microphone data",
            reservedReason: "PDM data of the on-board digital microphone",
          },
          ...XIAO_S3_SENSE_CAMERA_PINS.map((pin) => ({
            pin,
            note: "Camera connector",
            reservedReason: "Wired to the camera connector of the Sense expansion board",
          })),
        ]
      ),
    },
    officialPinMap: {
      D0: 1, D1: 2, D2: 3, D3: 4, D4: 5, D5: 6, D6: 43, D7: 44, D8: 7, D9: 8, D10: 9, D11: 42, D12: 41,
    },
    wikiUrl: SEEED_XIAO_WIKI_URLS.esp32s3,
    platformManifest: "seeed-xiao-esp32-s3-sense",
    highlights: [
      "8 MB PSRAM and 8 MB flash, microSD slot (up to 32 GB FAT)",
      "OV5640 camera sensor and digital microphone",
      "1x UART, 1x I2C, 1x I2S, 1x SPI, 11x GPIO (PWM), 9x ADC",
    ],
    sources: [],
  },
  {
    seed: {
      ...COMMON_SEED,
      slug: "seeed-xiao-esp32s3-plus",
      model: "XIAO ESP32-S3 Plus",
      revision: "v1.1",
      chip_family: "esp32s3",
      chip_variant: "ESP32-S3R8",
      flash_size_mb: 16,
      psram_size_mb: 8,
      usb_vid: "0x2886",
      usb_pid: "0x0056",
      series: "ESP32-S3",
      image_url:
        "https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32S3/img/xiaoesp32s3plus.png",
      pinout_image_url:
        "https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32S3/img/XIAO_ESP32-S3_Plus_front_pinout.png",
      docs_url: SEEED_XIAO_WIKI_URLS.esp32s3,
      datasheet_url:
        "https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32S3/res/esp32-s3_datasheet.pdf",
      source_url: SEEED_XIAO_WIKI_URLS.esp32s3,
      revision_notes:
        "XIAO ESP32-S3 with 16 MB flash and nine extra back pads (D11-D19) next to the 11 castellated pads. D16 (GPIO10) also reads the battery voltage. User LED on GPIO21, BOOT button on GPIO0.",
      board_layout: xiaoLayout({
        left: BOARD_CATALOG_BUILDERS.xiaoEsp32s3Headers.left,
        right: BOARD_CATALOG_BUILDERS.xiaoEsp32s3Headers.right,
        processor: "Dual-Core Xtensa LX7 (240 MHz)",
        wireless: "Wi-Fi 4 (2.4 GHz), BLE 5.0",
        antennaLabel: "U.FL / B2B",
        extraPads: { name: "Back pads (D11-D19)", pins: XIAO_S3_PLUS_BACK_PADS },
        onboardFeatures: [
          { label: "USER LED", gpioPin: 21, kind: "led", note: "User LED on GPIO21" },
          { label: "BOOT Button", gpioPin: 0, kind: "button", note: "BOOT button on GPIO0" },
          { label: "USB Serial / JTAG", gpioPin: 19, kind: "usb", note: "GPIO19/20 USB Type-C" },
        ],
      }),
      gpio_definitions: buildDefinitionsFromHeaders(
        BOARD_CATALOG_BUILDERS.xiaoEsp32s3Headers.left,
        BOARD_CATALOG_BUILDERS.xiaoEsp32s3Headers.right,
        XIAO_ESP32_S3_PLUS_SOC,
        [
          { pin: 21, note: "Onboard USER LED" },
          { pin: 0, note: "Onboard BOOT button" },
          ...XIAO_S3_PLUS_BACK_PADS.map((pad) => ({
            pin: pad.gpioPin as number,
            name: pad.pinName,
            note: pad.note,
          })),
        ]
      ),
    },
    officialPinMap: {
      D0: 1, D1: 2, D2: 3, D3: 4, D4: 5, D5: 6, D6: 43, D7: 44, D8: 7, D9: 8, D10: 9,
      D11: 38, D12: 39, D13: 40, D14: 41, D15: 42, D16: 10, D17: 13, D18: 12, D19: 11,
    },
    wikiUrl: SEEED_XIAO_WIKI_URLS.esp32s3,
    platformManifest: "seeed-xiao-esp32-s3-plus",
    highlights: [
      "8 MB PSRAM and 16 MB flash",
      "2x UART, 1x I2C, 1x I2S, 2x SPI, 18x GPIO (PWM), 9x ADC",
      "Reset and Boot buttons, charge LED and user LED, B2B connector",
    ],
    sources: [],
  },
];

function withSources(board: SeeedXiaoOfficialBoard): SeeedXiaoOfficialBoard {
  const sources: OfficialBoardSourceRef[] = [
    { label: "Seeed Studio wiki (pin table)", url: board.wikiUrl },
  ];
  if (board.platformManifest) {
    sources.push({
      label: "Seeed PlatformIO board manifest",
      url: seeedPlatformManifestUrl(board.platformManifest),
    });
  }
  if (board.seed.pinout_image_url) {
    sources.push({ label: "Official pinout diagram", url: board.seed.pinout_image_url });
  }
  if (board.seed.datasheet_url) {
    sources.push({ label: "Chip datasheet", url: board.seed.datasheet_url });
  }
  return {
    ...board,
    seed: { ...board.seed, ...resolveBoardFirmwareCompatibility(board.seed) },
    sources,
  };
}

/**
 * The XIAO ESP32-S3 that already ships in the verified catalog. It is listed
 * here so the importer recognises it as an existing board instead of offering
 * a duplicate.
 */
function existingXiaoEsp32s3(): SeeedXiaoOfficialBoard[] {
  const seed = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "seeed-xiao-esp32s3");
  if (!seed) return [];
  return [
    {
      seed,
      officialPinMap: { D0: 1, D1: 2, D2: 3, D3: 4, D4: 5, D5: 6, D6: 43, D7: 44, D8: 7, D9: 8, D10: 9 },
      wikiUrl: SEEED_XIAO_WIKI_URLS.esp32s3,
      // Seeed's PlatformIO platform ships no manifest for the plain ESP32-S3.
      platformManifest: null,
      highlights: [
        "8 MB PSRAM and 8 MB flash on chip",
        "1x UART, 1x I2C, 1x SPI, 11x GPIO (PWM), 9x ADC",
        "Reset and Boot buttons, charge LED and user LED",
      ],
      sources: [],
    },
  ];
}

/** Every official ESP32-based XIAO board HomecoreOS has a checked profile for. */
export const SEEED_XIAO_OFFICIAL_BOARDS: SeeedXiaoOfficialBoard[] = [
  ...existingXiaoEsp32s3(),
  ...RAW_NEW_BOARDS,
].map(withSources);

export function findSeeedXiaoOfficialBoard(slug: string): SeeedXiaoOfficialBoard | undefined {
  return SEEED_XIAO_OFFICIAL_BOARDS.find((b) => b.seed.slug === slug);
}

/**
 * Pad name -> GPIO as the profile itself defines it (headers, extra pads and
 * named extra pins). Used to prove that a profile and Seeed's table agree.
 */
export function boardPadMap(seed: {
  board_layout?: BoardLayoutSpec | null;
  gpio_definitions: Array<{ pin: number; board_pin_name?: string | null }>;
}): Record<string, number> {
  const map: Record<string, number> = {};
  const add = (rawName: string | null | undefined, pin: number | null | undefined) => {
    if (typeof pin !== "number" || !rawName) return;
    const match = rawName.trim().match(/^(D\d+)\b/i);
    if (match) map[match[1]!.toUpperCase()] = pin;
  };
  const layout = seed.board_layout;
  for (const hpin of [
    ...(layout?.leftHeader?.pins ?? []),
    ...(layout?.rightHeader?.pins ?? []),
    ...(layout?.extraPads?.pins ?? []),
  ]) {
    add(hpin.pinName, hpin.gpioPin);
  }
  for (const def of seed.gpio_definitions) add(def.board_pin_name, def.pin);
  return map;
}
