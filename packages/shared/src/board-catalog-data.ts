import {
  SUPPORTED_CHIP_FAMILIES,
  type BoardCatalogCategory,
  type BoardFirmwareStatus,
  type BoardHeaderPin,
  type BoardLayoutSpec,
  type BoardProfileSpec,
  type BoardVerificationStatus,
  type ChipFamily,
  type GpioPinDefinition,
  type ResolvedBoardHardwareSpecs,
} from "./index";
import { resolveBoardFirmwareCompatibility } from "./board-firmware-compat";

export interface CatalogBoardSeed extends BoardProfileSpec {
  catalog_category: BoardCatalogCategory;
  series: string;
  image_url: string | null;
  pinout_image_url?: string | null;
  docs_url: string;
  datasheet_url?: string | null;
  source_url: string;
  source_provider: string;
  verification_status: BoardVerificationStatus;
  firmware_status: BoardFirmwareStatus;
  revision_notes?: string | null;
  is_published: boolean;
  board_layout: BoardLayoutSpec;
}

export function normalizeChipFamily(raw: string | null | undefined): ChipFamily | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cleaned === "esp8684" || cleaned === "esp32c2" || cleaned.startsWith("esp32c2")) {
    return "esp32c2";
  }
  const ordered = [...SUPPORTED_CHIP_FAMILIES].sort((a, b) => b.length - a.length);
  for (const fam of ordered) {
    if (cleaned === fam || cleaned.startsWith(fam)) {
      return fam;
    }
  }
  return null;
}

interface SocPinProfile {
  adcPins: Set<number>;
  touchPins: Set<number>;
  inputOnlyPins: Set<number>;
  strappingNotes: Record<number, string>;
  flashPins: Set<number>;
  psramPins: Set<number>;
  usbPins: Set<number>;
  uart0Pins: Record<number, string>;
  extraGpioRange?: number[];
}

function pinDefForSoc(params: {
  pin: number;
  soc: SocPinProfile;
  boardPinName?: string | null;
  headerSide?: "left" | "right" | null;
  headerPosition?: number | null;
  boardNote?: string | null;
  forceReservedReason?: string;
}): GpioPinDefinition {
  const { pin, soc } = params;
  const isFlash = soc.flashPins.has(pin);
  const isPsram = soc.psramPins.has(pin);
  const isUsb = soc.usbPins.has(pin);
  const uartLabel = soc.uart0Pins[pin];
  const isUart0 = Boolean(uartLabel);
  const isInputOnly = soc.inputOnlyPins.has(pin);
  const strappingNote = soc.strappingNotes[pin];
  const isStrapping = Boolean(strappingNote);

  let reservedReason = params.forceReservedReason;
  if (!reservedReason) {
    if (isFlash) reservedReason = "Internal SPI Flash bus";
    else if (isPsram) reservedReason = "Internal PSRAM bus";
    else if (isUart0) reservedReason = `UART0 console (${uartLabel})`;
  }
  const reserved = Boolean(reservedReason);
  const usableIo = !reserved && !isInputOnly;

  return {
    pin,
    label: params.boardNote
      ? `GPIO${pin} (${params.boardNote})`
      : isUsb
        ? `GPIO${pin} (USB)`
        : isUart0
          ? `GPIO${pin} (${uartLabel})`
          : `GPIO${pin}`,
    board_pin_name: params.boardPinName ?? `GPIO${pin}`,
    header_side: params.headerSide ?? null,
    header_position: params.headerPosition ?? null,
    board_note: params.boardNote ?? null,
    capabilities: {
      digital_in: !isFlash && !isPsram,
      digital_out: usableIo,
      pwm: usableIo,
      adc: soc.adcPins.has(pin) && !isFlash && !isPsram,
      i2c: usableIo && !isUsb,
      spi: usableIo && !isUsb,
      uart: usableIo && !isUsb,
      touch: soc.touchPins.has(pin) && !isFlash && !isPsram,
      pull_up: !isFlash && !isPsram && !isInputOnly,
      pull_down: !isFlash && !isPsram && !isInputOnly,
    },
    restrictions: {
      input_only: isInputOnly,
      reserved,
      reserved_reason: reservedReason,
      strapping_pin: isStrapping,
      strapping_note: strappingNote,
      flash_psram_conflict: isFlash || isPsram,
      usb_jtag_conflict: isUsb,
    },
  };
}

function buildDefinitionsFromHeaders(
  leftPins: BoardHeaderPin[],
  rightPins: BoardHeaderPin[],
  soc: SocPinProfile,
  extraPins: Array<{ pin: number; note?: string; reservedReason?: string }> = []
): GpioPinDefinition[] {
  const byPin = new Map<number, GpioPinDefinition>();

  const registerHeaderPin = (hp: BoardHeaderPin, side: "left" | "right") => {
    if (hp.gpioPin === null || hp.gpioPin === undefined) return;
    if (byPin.has(hp.gpioPin)) return;
    byPin.set(
      hp.gpioPin,
      pinDefForSoc({
        pin: hp.gpioPin,
        soc,
        boardPinName: hp.pinName,
        headerSide: side,
        headerPosition: hp.position,
        boardNote: hp.note ?? null,
      })
    );
  };

  for (const hp of leftPins) registerHeaderPin(hp, "left");
  for (const hp of rightPins) registerHeaderPin(hp, "right");

  for (const extra of extraPins) {
    if (!byPin.has(extra.pin)) {
      byPin.set(
        extra.pin,
        pinDefForSoc({
          pin: extra.pin,
          soc,
          boardPinName: `GPIO${extra.pin}`,
          headerSide: null,
          headerPosition: null,
          boardNote: extra.note ?? null,
          forceReservedReason: extra.reservedReason,
        })
      );
    }
  }

  for (const rangePin of soc.extraGpioRange ?? []) {
    if (!byPin.has(rangePin)) {
      byPin.set(
        rangePin,
        pinDefForSoc({
          pin: rangePin,
          soc,
          boardPinName: `GPIO${rangePin}`,
        })
      );
    }
  }

  return Array.from(byPin.values()).sort((a, b) => a.pin - b.pin);
}

function hp(
  position: number,
  headerName: string,
  pinName: string,
  gpioPin: number | null,
  kind: BoardHeaderPin["kind"],
  opts?: { voltage?: string; aliases?: string[]; note?: string }
): BoardHeaderPin {
  return {
    position,
    headerName,
    pinName,
    gpioPin,
    kind,
    ...(opts?.voltage ? { voltage: opts.voltage } : {}),
    ...(opts?.aliases ? { aliases: opts.aliases } : {}),
    ...(opts?.note ? { note: opts.note } : {}),
  };
}

// ---------- SoC Pin Profiles ----------

const ESP32_S3_OPI_SOC: SocPinProfile = {
  adcPins: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  touchPins: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]),
  inputOnlyPins: new Set([46]),
  strappingNotes: {
    0: "Boot mode select (pull-up; LOW enters ROM download mode)",
    3: "JTAG signal source select",
    45: "VDD_SPI flash voltage select (keep LOW for 3.3V)",
    46: "Boot mode / ROM print enable (input-only strapping)",
  },
  flashPins: new Set([26, 27, 28, 29, 30, 31, 32]),
  psramPins: new Set([33, 34, 35, 36, 37]),
  usbPins: new Set([19, 20]),
  uart0Pins: { 43: "UART0 TX", 44: "UART0 RX" },
  extraGpioRange: [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44,
    45, 46, 47, 48,
  ],
};

const XIAO_ESP32_S3_SOC: SocPinProfile = {
  adcPins: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]),
  touchPins: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]),
  inputOnlyPins: new Set(),
  strappingNotes: {
    0: "BOOT button (pull-up; LOW enters ROM download mode)",
  },
  flashPins: new Set([26, 27, 28, 29, 30, 31, 32]),
  psramPins: new Set([33, 34, 35, 36, 37]),
  usbPins: new Set([19, 20]),
  uart0Pins: {}, // On XIAO ESP32-S3, USB-CDC uses GPIO19/20; D6(GPIO43)/D7(GPIO44) are exposed UART pads!
};

const ESP32_DEVKITC_SOC: SocPinProfile = {
  adcPins: new Set([32, 33, 34, 35, 36, 37, 38, 39]),
  touchPins: new Set([0, 2, 4, 12, 13, 14, 15, 27, 32, 33]),
  inputOnlyPins: new Set([34, 35, 36, 37, 38, 39]),
  strappingNotes: {
    0: "Boot mode select (pull-up; LOW enters download mode)",
    2: "Download boot / onboard LED strapping",
    5: "SDIO timing strapping",
    12: "MTDI flash voltage select (must be LOW on 3.3V flash boards!)",
    15: "MTDO boot log silencing strapping",
  },
  flashPins: new Set([6, 7, 8, 9, 10, 11]),
  psramPins: new Set(),
  usbPins: new Set(),
  uart0Pins: { 1: "UART0 TX", 3: "UART0 RX" },
};

const ESP32_S2_SOC: SocPinProfile = {
  adcPins: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  touchPins: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]),
  inputOnlyPins: new Set([46]),
  strappingNotes: {
    0: "Boot mode select (pull-up; LOW enters download mode)",
    45: "VDD_SPI flash voltage select",
    46: "ROM log / download mode strapping (input-only)",
  },
  flashPins: new Set([26, 27, 28, 29, 30, 31, 32]),
  psramPins: new Set(),
  usbPins: new Set([19, 20]),
  uart0Pins: { 43: "UART0 TX", 44: "UART0 RX" },
};

const ESP32_C3_SOC: SocPinProfile = {
  adcPins: new Set([0, 1, 2, 3, 4]),
  touchPins: new Set(),
  inputOnlyPins: new Set(),
  strappingNotes: {
    2: "Boot mode strapping",
    8: "Boot mode / onboard RGB LED (must not be pulled LOW at boot)",
    9: "BOOT button / download mode strapping",
  },
  flashPins: new Set([12, 13, 14, 15, 16, 17]),
  psramPins: new Set(),
  usbPins: new Set([18, 19]),
  uart0Pins: { 20: "UART0 RX", 21: "UART0 TX" },
};

const ESP32_C6_SOC: SocPinProfile = {
  adcPins: new Set([0, 1, 2, 3, 4, 5, 6]),
  touchPins: new Set(),
  inputOnlyPins: new Set(),
  strappingNotes: {
    4: "MTMS JTAG/boot strapping",
    5: "MTDI boot strapping",
    8: "Boot mode / RGB LED strapping",
    9: "BOOT button / download mode strapping",
    15: "ROM log print control strapping",
  },
  flashPins: new Set([24, 25, 26, 27, 28, 29, 30]),
  psramPins: new Set(),
  usbPins: new Set([12, 13]),
  uart0Pins: { 16: "UART0 TX", 17: "UART0 RX" },
};

const ESP32_C5_SOC: SocPinProfile = {
  adcPins: new Set([1, 2, 3, 4, 5, 6]),
  touchPins: new Set(),
  inputOnlyPins: new Set(),
  strappingNotes: {
    2: "Boot strapping pin",
    7: "Boot strapping pin",
    25: "Boot strapping pin",
    27: "Boot strapping / onboard RGB LED",
    28: "BOOT button / download mode strapping",
  },
  flashPins: new Set(),
  psramPins: new Set(),
  usbPins: new Set([13, 14]),
  uart0Pins: { 11: "UART0 TX", 12: "UART0 RX" },
};

const ESP32_C61_SOC: SocPinProfile = {
  adcPins: new Set([0, 1, 2, 3, 4, 5]),
  touchPins: new Set(),
  inputOnlyPins: new Set(),
  strappingNotes: {
    7: "Boot strapping pin",
    8: "Boot strapping / onboard RGB LED",
    9: "BOOT button / download mode strapping",
  },
  flashPins: new Set(),
  psramPins: new Set(),
  usbPins: new Set([12, 13]),
  uart0Pins: { 10: "UART0 RX", 11: "UART0 TX" },
};

const ESP32_C2_SOC: SocPinProfile = {
  adcPins: new Set([0, 1, 2, 3, 4]),
  touchPins: new Set(),
  inputOnlyPins: new Set(),
  strappingNotes: {
    8: "Boot strapping / blue LED",
    9: "BOOT button / download mode strapping",
  },
  flashPins: new Set([11, 12, 13, 14, 15, 16, 17]),
  psramPins: new Set(),
  usbPins: new Set(),
  uart0Pins: { 19: "UART0 RX", 20: "UART0 TX" },
};

const ESP32_H2_SOC: SocPinProfile = {
  adcPins: new Set([1, 2, 3, 4, 5]),
  touchPins: new Set(),
  inputOnlyPins: new Set(),
  strappingNotes: {
    2: "Boot strapping pin",
    3: "Boot strapping pin",
    8: "Boot strapping / onboard RGB LED",
    9: "BOOT button / download mode strapping",
    25: "Boot strapping pin",
  },
  flashPins: new Set([15, 16, 17, 18, 19, 20, 21]),
  psramPins: new Set(),
  usbPins: new Set([26, 27]),
  uart0Pins: { 23: "UART0 RX", 24: "UART0 TX" },
};

// ---------- Official Espressif & Partner Board Headers ----------

const S3_DEVKITC1_J1: BoardHeaderPin[] = [
  hp(1, "J1", "3V3", null, "power", { voltage: "3.3V" }),
  hp(2, "J1", "3V3", null, "power", { voltage: "3.3V" }),
  hp(3, "J1", "RST", null, "reset", { note: "CHIP_PU / EN reset" }),
  hp(4, "J1", "4", 4, "gpio", { aliases: ["ADC1_CH3", "TOUCH4"] }),
  hp(5, "J1", "5", 5, "gpio", { aliases: ["ADC1_CH4", "TOUCH5"] }),
  hp(6, "J1", "6", 6, "gpio", { aliases: ["ADC1_CH5", "TOUCH6"] }),
  hp(7, "J1", "7", 7, "gpio", { aliases: ["ADC1_CH6", "TOUCH7"] }),
  hp(8, "J1", "15", 15, "gpio", { aliases: ["XTAL_32K_P"] }),
  hp(9, "J1", "16", 16, "gpio", { aliases: ["XTAL_32K_N"] }),
  hp(10, "J1", "17", 17, "gpio", { aliases: ["UART1_TX"] }),
  hp(11, "J1", "18", 18, "gpio", { aliases: ["UART1_RX"] }),
  hp(12, "J1", "8", 8, "gpio", { aliases: ["ADC1_CH7", "TOUCH8"] }),
  hp(13, "J1", "3", 3, "gpio", { aliases: ["ADC1_CH2", "TOUCH3"], note: "Strapping (JTAG)" }),
  hp(14, "J1", "46", 46, "gpio", { note: "Input-only strapping" }),
  hp(15, "J1", "9", 9, "gpio", { aliases: ["ADC1_CH8", "TOUCH9"] }),
  hp(16, "J1", "10", 10, "gpio", { aliases: ["ADC1_CH9", "TOUCH10"] }),
  hp(17, "J1", "11", 11, "gpio", { aliases: ["TOUCH11"] }),
  hp(18, "J1", "12", 12, "gpio", { aliases: ["TOUCH12"] }),
  hp(19, "J1", "13", 13, "gpio", { aliases: ["TOUCH13"] }),
  hp(20, "J1", "14", 14, "gpio", { aliases: ["TOUCH14"] }),
  hp(21, "J1", "5V", null, "power", { voltage: "5V" }),
  hp(22, "J1", "G", null, "ground", { voltage: "GND" }),
];

function s3DevKitC1J3(rgbPin: 38 | 48): BoardHeaderPin[] {
  return [
    hp(1, "J3", "G", null, "ground", { voltage: "GND" }),
    hp(2, "J3", "TX", 43, "gpio", { aliases: ["U0TXD"], note: "UART0 TX" }),
    hp(3, "J3", "RX", 44, "gpio", { aliases: ["U0RXD"], note: "UART0 RX" }),
    hp(4, "J3", "1", 1, "gpio", { aliases: ["ADC1_CH0", "TOUCH1"] }),
    hp(5, "J3", "2", 2, "gpio", { aliases: ["ADC1_CH1", "TOUCH2"] }),
    hp(6, "J3", "42", 42, "gpio", { aliases: ["MTMS"] }),
    hp(7, "J3", "41", 41, "gpio", { aliases: ["MTDI"] }),
    hp(8, "J3", "40", 40, "gpio", { aliases: ["MTDO"] }),
    hp(9, "J3", "39", 39, "gpio", { aliases: ["MTCK"] }),
    hp(10, "J3", "38", 38, "gpio", {
      note: rgbPin === 38 ? "Onboard RGB LED (v1.1)" : "General GPIO (free on v1.0)",
    }),
    hp(11, "J3", "37", 37, "gpio", { note: "Octal PSRAM (unavailable on R8)" }),
    hp(12, "J3", "36", 36, "gpio", { note: "Octal PSRAM (unavailable on R8)" }),
    hp(13, "J3", "35", 35, "gpio", { note: "Octal PSRAM (unavailable on R8)" }),
    hp(14, "J3", "0", 0, "gpio", { note: "BOOT button & strapping" }),
    hp(15, "J3", "45", 45, "gpio", { note: "Strapping (VDD_SPI)" }),
    hp(16, "J3", "48", 48, "gpio", {
      note: rgbPin === 48 ? "Onboard RGB LED (v1.0)" : "General GPIO",
    }),
    hp(17, "J3", "47", 47, "gpio"),
    hp(18, "J3", "21", 21, "gpio"),
    hp(19, "J3", "20", 20, "gpio", { aliases: ["USB_D+"], note: "USB D+" }),
    hp(20, "J3", "19", 19, "gpio", { aliases: ["USB_D-"], note: "USB D-" }),
    hp(21, "J3", "G", null, "ground", { voltage: "GND" }),
    hp(22, "J3", "G", null, "ground", { voltage: "GND" }),
  ];
}

const S3_V11_J3 = s3DevKitC1J3(38);
const S3_V10_J3 = s3DevKitC1J3(48);

const XIAO_S3_LEFT: BoardHeaderPin[] = [
  hp(1, "Left", "D0 / A0", 1, "gpio", { aliases: ["A0", "D0", "ADC1_CH0", "TOUCH1"] }),
  hp(2, "Left", "D1 / A1", 2, "gpio", { aliases: ["A1", "D1", "ADC1_CH1", "TOUCH2"] }),
  hp(3, "Left", "D2 / A2", 3, "gpio", { aliases: ["A2", "D2", "ADC1_CH2", "TOUCH3"] }),
  hp(4, "Left", "D3 / A3", 4, "gpio", { aliases: ["A3", "D3", "ADC1_CH3", "TOUCH4"] }),
  hp(5, "Left", "D4 / SDA", 5, "gpio", { aliases: ["A4", "D4", "SDA", "ADC1_CH4"], note: "I2C SDA" }),
  hp(6, "Left", "D5 / SCL", 6, "gpio", { aliases: ["A5", "D5", "SCL", "ADC1_CH5"], note: "I2C SCL" }),
  hp(7, "Left", "D6 / TX", 43, "gpio", { aliases: ["D6", "TX", "U0TXD"], note: "UART TX (free GPIO)" }),
];

const XIAO_S3_RIGHT: BoardHeaderPin[] = [
  hp(1, "Right", "5V", null, "power", { voltage: "5V", note: "USB VBUS 5V" }),
  hp(2, "Right", "GND", null, "ground", { voltage: "GND" }),
  hp(3, "Right", "3V3", null, "power", { voltage: "3.3V", note: "Regulated 3.3V out" }),
  hp(4, "Right", "D10 / MOSI", 9, "gpio", { aliases: ["A10", "D10", "MOSI"], note: "SPI MOSI" }),
  hp(5, "Right", "D9 / MISO", 8, "gpio", { aliases: ["A9", "D9", "MISO"], note: "SPI MISO" }),
  hp(6, "Right", "D8 / SCK", 7, "gpio", { aliases: ["A8", "D8", "SCK"], note: "SPI SCK" }),
  hp(7, "Right", "D7 / RX", 44, "gpio", { aliases: ["D7", "RX", "U0RXD"], note: "UART RX (free GPIO)" }),
];

const ESP32_V4_J2: BoardHeaderPin[] = [
  hp(1, "J2", "3V3", null, "power", { voltage: "3.3V" }),
  hp(2, "J2", "EN", null, "reset", { note: "CHIP_PU reset" }),
  hp(3, "J2", "VP / 36", 36, "gpio", { aliases: ["SENSOR_VP", "ADC1_CH0"], note: "Input-only" }),
  hp(4, "J2", "VN / 39", 39, "gpio", { aliases: ["SENSOR_VN", "ADC1_CH3"], note: "Input-only" }),
  hp(5, "J2", "34", 34, "gpio", { aliases: ["ADC1_CH6"], note: "Input-only" }),
  hp(6, "J2", "35", 35, "gpio", { aliases: ["ADC1_CH7"], note: "Input-only" }),
  hp(7, "J2", "32", 32, "gpio", { aliases: ["ADC1_CH4", "TOUCH9"] }),
  hp(8, "J2", "33", 33, "gpio", { aliases: ["ADC1_CH5", "TOUCH8"] }),
  hp(9, "J2", "25", 25, "gpio", { aliases: ["DAC_1"] }),
  hp(10, "J2", "26", 26, "gpio", { aliases: ["DAC_2"] }),
  hp(11, "J2", "27", 27, "gpio", { aliases: ["TOUCH7"] }),
  hp(12, "J2", "14", 14, "gpio", { aliases: ["TOUCH6", "HSPI_CLK"] }),
  hp(13, "J2", "12", 12, "gpio", { aliases: ["TOUCH5", "MTDI"], note: "Strapping (keep LOW at boot)" }),
  hp(14, "J2", "GND", null, "ground", { voltage: "GND" }),
  hp(15, "J2", "13", 13, "gpio", { aliases: ["TOUCH4", "HSPI_MOSI"] }),
  hp(16, "J2", "D2 / 9", 9, "gpio", { note: "SPI Flash D2 (reserved)" }),
  hp(17, "J2", "D3 / 10", 10, "gpio", { note: "SPI Flash D3 (reserved)" }),
  hp(18, "J2", "CMD / 11", 11, "gpio", { note: "SPI Flash CMD (reserved)" }),
  hp(19, "J2", "5V", null, "power", { voltage: "5V" }),
];

const ESP32_V4_J3: BoardHeaderPin[] = [
  hp(1, "J3", "GND", null, "ground", { voltage: "GND" }),
  hp(2, "J3", "23", 23, "gpio", { aliases: ["VSPI_MOSI"] }),
  hp(3, "J3", "22", 22, "gpio", { aliases: ["I2C_SCL"] }),
  hp(4, "J3", "TXD0 / 1", 1, "gpio", { note: "UART0 TX" }),
  hp(5, "J3", "RXD0 / 3", 3, "gpio", { note: "UART0 RX" }),
  hp(6, "J3", "21", 21, "gpio", { aliases: ["I2C_SDA"] }),
  hp(7, "J3", "GND", null, "ground", { voltage: "GND" }),
  hp(8, "J3", "19", 19, "gpio", { aliases: ["VSPI_MISO"] }),
  hp(9, "J3", "18", 18, "gpio", { aliases: ["VSPI_CLK"] }),
  hp(10, "J3", "5", 5, "gpio", { aliases: ["VSPI_CS0"], note: "Strapping" }),
  hp(11, "J3", "17", 17, "gpio", { aliases: ["U2TXD"] }),
  hp(12, "J3", "16", 16, "gpio", { aliases: ["U2RXD"] }),
  hp(13, "J3", "4", 4, "gpio", { aliases: ["TOUCH0"] }),
  hp(14, "J3", "0", 0, "gpio", { note: "BOOT button & strapping" }),
  hp(15, "J3", "2", 2, "gpio", { note: "Strapping / Onboard LED" }),
  hp(16, "J3", "15", 15, "gpio", { aliases: ["MTDO"], note: "Strapping" }),
  hp(17, "J3", "D1 / 8", 8, "gpio", { note: "SPI Flash D1 (reserved)" }),
  hp(18, "J3", "D0 / 7", 7, "gpio", { note: "SPI Flash D0 (reserved)" }),
  hp(19, "J3", "CLK / 6", 6, "gpio", { note: "SPI Flash CLK (reserved)" }),
];

const ESP32_S2_J1: BoardHeaderPin[] = [
  hp(1, "J1", "3V3", null, "power", { voltage: "3.3V" }),
  hp(2, "J1", "0", 0, "gpio", { note: "BOOT button & strapping" }),
  hp(3, "J1", "1", 1, "gpio", { aliases: ["ADC1_CH0", "TOUCH1"] }),
  hp(4, "J1", "2", 2, "gpio", { aliases: ["ADC1_CH1", "TOUCH2"] }),
  hp(5, "J1", "3", 3, "gpio", { aliases: ["ADC1_CH2", "TOUCH3"] }),
  hp(6, "J1", "4", 4, "gpio", { aliases: ["ADC1_CH3", "TOUCH4"] }),
  hp(7, "J1", "5", 5, "gpio", { aliases: ["ADC1_CH4", "TOUCH5"] }),
  hp(8, "J1", "6", 6, "gpio", { aliases: ["ADC1_CH5", "TOUCH6"] }),
  hp(9, "J1", "7", 7, "gpio", { aliases: ["ADC1_CH6", "TOUCH7"] }),
  hp(10, "J1", "8", 8, "gpio", { aliases: ["ADC1_CH7", "TOUCH8"] }),
  hp(11, "J1", "9", 9, "gpio", { aliases: ["ADC1_CH8", "TOUCH9"] }),
  hp(12, "J1", "10", 10, "gpio", { aliases: ["ADC1_CH9", "TOUCH10"] }),
  hp(13, "J1", "11", 11, "gpio", { aliases: ["TOUCH11"] }),
  hp(14, "J1", "12", 12, "gpio", { aliases: ["TOUCH12"] }),
  hp(15, "J1", "13", 13, "gpio", { aliases: ["TOUCH13"] }),
  hp(16, "J1", "14", 14, "gpio", { aliases: ["TOUCH14"] }),
  hp(17, "J1", "15", 15, "gpio"),
  hp(18, "J1", "16", 16, "gpio"),
  hp(19, "J1", "17", 17, "gpio", { aliases: ["DAC_1"] }),
  hp(20, "J1", "18", 18, "gpio", { aliases: ["DAC_2"], note: "Onboard RGB LED" }),
  hp(21, "J1", "19", 19, "gpio", { note: "USB D-" }),
  hp(22, "J1", "20", 20, "gpio", { note: "USB D+" }),
];

const ESP32_S2_J3: BoardHeaderPin[] = [
  hp(1, "J3", "GND", null, "ground", { voltage: "GND" }),
  hp(2, "J3", "21", 21, "gpio"),
  hp(3, "J3", "26", 26, "gpio", { note: "SPI Flash/PSRAM CS1 (reserved)" }),
  hp(4, "J3", "33", 33, "gpio"),
  hp(5, "J3", "34", 34, "gpio"),
  hp(6, "J3", "35", 35, "gpio"),
  hp(7, "J3", "36", 36, "gpio"),
  hp(8, "J3", "37", 37, "gpio"),
  hp(9, "J3", "38", 38, "gpio"),
  hp(10, "J3", "39", 39, "gpio", { aliases: ["MTCK"] }),
  hp(11, "J3", "40", 40, "gpio", { aliases: ["MTDO"] }),
  hp(12, "J3", "41", 41, "gpio", { aliases: ["MTDI"] }),
  hp(13, "J3", "42", 42, "gpio", { aliases: ["MTMS"] }),
  hp(14, "J3", "TX / 43", 43, "gpio", { note: "UART0 TX" }),
  hp(15, "J3", "RX / 44", 44, "gpio", { note: "UART0 RX" }),
  hp(16, "J3", "45", 45, "gpio", { note: "Strapping (VDD_SPI)" }),
  hp(17, "J3", "46", 46, "gpio", { note: "Input-only strapping" }),
  hp(18, "J3", "RST", null, "reset", { note: "CHIP_PU reset" }),
  hp(19, "J3", "3V3", null, "power", { voltage: "3.3V" }),
  hp(20, "J3", "5V", null, "power", { voltage: "5V" }),
  hp(21, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(22, "J3", "G", null, "ground", { voltage: "GND" }),
];

const ESP32_C3_J1: BoardHeaderPin[] = [
  hp(1, "J1", "GND", null, "ground", { voltage: "GND" }),
  hp(2, "J1", "3V3", null, "power", { voltage: "3.3V" }),
  hp(3, "J1", "3V3", null, "power", { voltage: "3.3V" }),
  hp(4, "J1", "2", 2, "gpio", { aliases: ["ADC1_CH2"], note: "Strapping" }),
  hp(5, "J1", "3", 3, "gpio", { aliases: ["ADC1_CH3"] }),
  hp(6, "J1", "GND", null, "ground", { voltage: "GND" }),
  hp(7, "J1", "RST", null, "reset", { note: "CHIP_EN reset" }),
  hp(8, "J1", "GND", null, "ground", { voltage: "GND" }),
  hp(9, "J1", "0", 0, "gpio", { aliases: ["ADC1_CH0"] }),
  hp(10, "J1", "1", 1, "gpio", { aliases: ["ADC1_CH1"] }),
  hp(11, "J1", "10", 10, "gpio"),
  hp(12, "J1", "GND", null, "ground", { voltage: "GND" }),
  hp(13, "J1", "5V", null, "power", { voltage: "5V" }),
  hp(14, "J1", "5V", null, "power", { voltage: "5V" }),
  hp(15, "J1", "GND", null, "ground", { voltage: "GND" }),
];

const ESP32_C3_J3: BoardHeaderPin[] = [
  hp(1, "J3", "GND", null, "ground", { voltage: "GND" }),
  hp(2, "J3", "TX / 21", 21, "gpio", { note: "UART0 TX" }),
  hp(3, "J3", "RX / 20", 20, "gpio", { note: "UART0 RX" }),
  hp(4, "J3", "GND", null, "ground", { voltage: "GND" }),
  hp(5, "J3", "9", 9, "gpio", { note: "BOOT button & strapping" }),
  hp(6, "J3", "8", 8, "gpio", { note: "Onboard RGB LED & strapping" }),
  hp(7, "J3", "GND", null, "ground", { voltage: "GND" }),
  hp(8, "J3", "7", 7, "gpio"),
  hp(9, "J3", "6", 6, "gpio"),
  hp(10, "J3", "5", 5, "gpio"),
  hp(11, "J3", "4", 4, "gpio", { aliases: ["ADC1_CH4"] }),
  hp(12, "J3", "GND", null, "ground", { voltage: "GND" }),
  hp(13, "J3", "18", 18, "gpio", { note: "USB D-" }),
  hp(14, "J3", "19", 19, "gpio", { note: "USB D+" }),
  hp(15, "J3", "GND", null, "ground", { voltage: "GND" }),
];

const ESP32_C6_J1: BoardHeaderPin[] = [
  hp(1, "J1", "3V3", null, "power", { voltage: "3.3V" }),
  hp(2, "J1", "RST", null, "reset", { note: "CHIP_EN reset" }),
  hp(3, "J1", "0", 0, "gpio", { aliases: ["ADC1_CH0", "XTAL_32K_P"] }),
  hp(4, "J1", "1", 1, "gpio", { aliases: ["ADC1_CH1", "XTAL_32K_N"] }),
  hp(5, "J1", "2", 2, "gpio", { aliases: ["ADC1_CH2"] }),
  hp(6, "J1", "3", 3, "gpio", { aliases: ["ADC1_CH3"] }),
  hp(7, "J1", "4", 4, "gpio", { aliases: ["ADC1_CH4", "MTMS"], note: "Strapping" }),
  hp(8, "J1", "5", 5, "gpio", { aliases: ["ADC1_CH5", "MTDI"], note: "Strapping" }),
  hp(9, "J1", "6", 6, "gpio", { aliases: ["ADC1_CH6", "MTCK"] }),
  hp(10, "J1", "7", 7, "gpio", { aliases: ["MTDO"] }),
  hp(11, "J1", "10", 10, "gpio"),
  hp(12, "J1", "11", 11, "gpio"),
  hp(13, "J1", "8", 8, "gpio", { note: "Onboard RGB LED & strapping" }),
  hp(14, "J1", "15", 15, "gpio", { note: "Strapping" }),
  hp(15, "J1", "5V", null, "power", { voltage: "5V" }),
  hp(16, "J1", "G", null, "ground", { voltage: "GND" }),
];

const ESP32_C6_J3: BoardHeaderPin[] = [
  hp(1, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(2, "J3", "TX / 16", 16, "gpio", { note: "UART0 TX" }),
  hp(3, "J3", "RX / 17", 17, "gpio", { note: "UART0 RX" }),
  hp(4, "J3", "23", 23, "gpio"),
  hp(5, "J3", "22", 22, "gpio"),
  hp(6, "J3", "21", 21, "gpio"),
  hp(7, "J3", "20", 20, "gpio"),
  hp(8, "J3", "19", 19, "gpio"),
  hp(9, "J3", "18", 18, "gpio"),
  hp(10, "J3", "14", 14, "gpio"),
  hp(11, "J3", "9", 9, "gpio", { note: "BOOT button & strapping" }),
  hp(12, "J3", "13", 13, "gpio", { note: "USB D+" }),
  hp(13, "J3", "12", 12, "gpio", { note: "USB D-" }),
  hp(14, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(15, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(16, "J3", "G", null, "ground", { voltage: "GND" }),
];

const ESP32_C5_J1: BoardHeaderPin[] = [
  hp(1, "J1", "3V3", null, "power", { voltage: "3.3V" }),
  hp(2, "J1", "RST", null, "reset", { note: "CHIP_EN reset" }),
  hp(3, "J1", "2", 2, "gpio", { aliases: ["ADC1_CH1", "MTMS"], note: "Strapping" }),
  hp(4, "J1", "3", 3, "gpio", { aliases: ["ADC1_CH2", "MTDI"] }),
  hp(5, "J1", "4", 4, "gpio", { aliases: ["ADC1_CH3", "MTCK"] }),
  hp(6, "J1", "5", 5, "gpio", { aliases: ["ADC1_CH4", "MTDO"] }),
  hp(7, "J1", "6", 6, "gpio", { aliases: ["ADC1_CH5"] }),
  hp(8, "J1", "7", 7, "gpio", { note: "Strapping" }),
  hp(9, "J1", "8", 8, "gpio"),
  hp(10, "J1", "9", 9, "gpio"),
  hp(11, "J1", "10", 10, "gpio"),
  hp(12, "J1", "1", 1, "gpio", { aliases: ["ADC1_CH0"] }),
  hp(13, "J1", "0", 0, "gpio", { aliases: ["XTAL_32K_P"] }),
  hp(14, "J1", "5V", null, "power", { voltage: "5V" }),
  hp(15, "J1", "5V", null, "power", { voltage: "5V" }),
  hp(16, "J1", "NC", null, "nc"),
];

const ESP32_C5_J3: BoardHeaderPin[] = [
  hp(1, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(2, "J3", "TX / 11", 11, "gpio", { note: "UART0 TX" }),
  hp(3, "J3", "RX / 12", 12, "gpio", { note: "UART0 RX" }),
  hp(4, "J3", "27", 27, "gpio", { note: "Onboard RGB LED & strapping" }),
  hp(5, "J3", "26", 26, "gpio"),
  hp(6, "J3", "25", 25, "gpio", { note: "Strapping" }),
  hp(7, "J3", "24", 24, "gpio"),
  hp(8, "J3", "23", 23, "gpio"),
  hp(9, "J3", "15", 15, "gpio"),
  hp(10, "J3", "28", 28, "gpio", { note: "BOOT button & strapping" }),
  hp(11, "J3", "14", 14, "gpio", { note: "USB D+" }),
  hp(12, "J3", "13", 13, "gpio", { note: "USB D-" }),
  hp(13, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(14, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(15, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(16, "J3", "G", null, "ground", { voltage: "GND" }),
];

const ESP32_C61_J1: BoardHeaderPin[] = [
  hp(1, "J1", "3V3", null, "power", { voltage: "3.3V" }),
  hp(2, "J1", "RST", null, "reset", { note: "CHIP_EN reset" }),
  hp(3, "J1", "0", 0, "gpio", { aliases: ["ADC1_CH0", "XTAL_32K_P"] }),
  hp(4, "J1", "1", 1, "gpio", { aliases: ["ADC1_CH1", "XTAL_32K_N"] }),
  hp(5, "J1", "2", 2, "gpio", { aliases: ["ADC1_CH2", "MTMS"] }),
  hp(6, "J1", "3", 3, "gpio", { aliases: ["ADC1_CH3", "MTDI"] }),
  hp(7, "J1", "4", 4, "gpio", { aliases: ["ADC1_CH4", "MTCK"] }),
  hp(8, "J1", "5", 5, "gpio", { aliases: ["ADC1_CH5", "MTDO"] }),
  hp(9, "J1", "6", 6, "gpio"),
  hp(10, "J1", "7", 7, "gpio", { note: "Strapping" }),
  hp(11, "J1", "8", 8, "gpio", { note: "Onboard RGB LED & strapping" }),
  hp(12, "J1", "21", 21, "gpio"),
  hp(13, "J1", "NC", null, "nc"),
  hp(14, "J1", "5V", null, "power", { voltage: "5V" }),
  hp(15, "J1", "5V", null, "power", { voltage: "5V" }),
  hp(16, "J1", "G", null, "ground", { voltage: "GND" }),
];

const ESP32_C61_J3: BoardHeaderPin[] = [
  hp(1, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(2, "J3", "TX / 11", 11, "gpio", { note: "UART0 TX" }),
  hp(3, "J3", "RX / 10", 10, "gpio", { note: "UART0 RX" }),
  hp(4, "J3", "28", 28, "gpio"),
  hp(5, "J3", "27", 27, "gpio"),
  hp(6, "J3", "26", 26, "gpio"),
  hp(7, "J3", "25", 25, "gpio"),
  hp(8, "J3", "24", 24, "gpio"),
  hp(9, "J3", "23", 23, "gpio"),
  hp(10, "J3", "22", 22, "gpio"),
  hp(11, "J3", "9", 9, "gpio", { note: "BOOT button & strapping" }),
  hp(12, "J3", "13", 13, "gpio", { note: "USB D+" }),
  hp(13, "J3", "12", 12, "gpio", { note: "USB D-" }),
  hp(14, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(15, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(16, "J3", "G", null, "ground", { voltage: "GND" }),
];

const ESP8684_J1: BoardHeaderPin[] = [
  hp(1, "J1", "GND", null, "ground", { voltage: "GND" }),
  hp(2, "J1", "3V3", null, "power", { voltage: "3.3V" }),
  hp(3, "J1", "3V3", null, "power", { voltage: "3.3V" }),
  hp(4, "J1", "2", 2, "gpio", { aliases: ["ADC1_CH2"] }),
  hp(5, "J1", "3", 3, "gpio", { aliases: ["ADC1_CH3"] }),
  hp(6, "J1", "GND", null, "ground", { voltage: "GND" }),
  hp(7, "J1", "RST", null, "reset", { note: "CHIP_EN reset" }),
  hp(8, "J1", "GND", null, "ground", { voltage: "GND" }),
  hp(9, "J1", "0", 0, "gpio", { aliases: ["ADC1_CH0"], note: "Onboard RGB Red" }),
  hp(10, "J1", "1", 1, "gpio", { aliases: ["ADC1_CH1"], note: "Onboard RGB Green" }),
  hp(11, "J1", "10", 10, "gpio"),
  hp(12, "J1", "GND", null, "ground", { voltage: "GND" }),
  hp(13, "J1", "5V", null, "power", { voltage: "5V" }),
  hp(14, "J1", "5V", null, "power", { voltage: "5V" }),
  hp(15, "J1", "GND", null, "ground", { voltage: "GND" }),
];

const ESP8684_J3: BoardHeaderPin[] = [
  hp(1, "J3", "GND", null, "ground", { voltage: "GND" }),
  hp(2, "J3", "TX / 20", 20, "gpio", { note: "UART0 TX" }),
  hp(3, "J3", "RX / 19", 19, "gpio", { note: "UART0 RX" }),
  hp(4, "J3", "GND", null, "ground", { voltage: "GND" }),
  hp(5, "J3", "9", 9, "gpio", { note: "BOOT button & strapping" }),
  hp(6, "J3", "8", 8, "gpio", { note: "RGB Blue & strapping" }),
  hp(7, "J3", "GND", null, "ground", { voltage: "GND" }),
  hp(8, "J3", "7", 7, "gpio"),
  hp(9, "J3", "6", 6, "gpio"),
  hp(10, "J3", "5", 5, "gpio"),
  hp(11, "J3", "4", 4, "gpio", { aliases: ["ADC1_CH4"] }),
  hp(12, "J3", "GND", null, "ground", { voltage: "GND" }),
  hp(13, "J3", "18", 18, "gpio"),
  hp(14, "J3", "NC", null, "nc"),
  hp(15, "J3", "GND", null, "ground", { voltage: "GND" }),
];

const ESP32_H2_J1: BoardHeaderPin[] = [
  hp(1, "J1", "3V3", null, "power", { voltage: "3.3V" }),
  hp(2, "J1", "RST", null, "reset", { note: "CHIP_EN reset" }),
  hp(3, "J1", "0", 0, "gpio"),
  hp(4, "J1", "1", 1, "gpio", { aliases: ["ADC1_CH0"] }),
  hp(5, "J1", "2", 2, "gpio", { aliases: ["ADC1_CH1", "MTMS"], note: "Strapping" }),
  hp(6, "J1", "3", 3, "gpio", { aliases: ["ADC1_CH2", "MTDI"], note: "Strapping" }),
  hp(7, "J1", "4", 4, "gpio", { aliases: ["ADC1_CH3", "MTCK"] }),
  hp(8, "J1", "5", 5, "gpio", { aliases: ["ADC1_CH4", "MTDO"] }),
  hp(9, "J1", "10", 10, "gpio"),
  hp(10, "J1", "11", 11, "gpio"),
  hp(11, "J1", "8", 8, "gpio", { note: "Onboard RGB LED & strapping" }),
  hp(12, "J1", "12", 12, "gpio"),
  hp(13, "J1", "13", 13, "gpio"),
  hp(14, "J1", "14", 14, "gpio"),
  hp(15, "J1", "5V", null, "power", { voltage: "5V" }),
];

const ESP32_H2_J3: BoardHeaderPin[] = [
  hp(1, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(2, "J3", "TX / 24", 24, "gpio", { note: "UART0 TX" }),
  hp(3, "J3", "RX / 23", 23, "gpio", { note: "UART0 RX" }),
  hp(4, "J3", "25", 25, "gpio", { note: "Strapping" }),
  hp(5, "J3", "22", 22, "gpio"),
  hp(6, "J3", "9", 9, "gpio", { note: "BOOT button & strapping" }),
  hp(7, "J3", "27", 27, "gpio", { note: "USB D+" }),
  hp(8, "J3", "26", 26, "gpio", { note: "USB D-" }),
  hp(9, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(10, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(11, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(12, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(13, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(14, "J3", "G", null, "ground", { voltage: "GND" }),
  hp(15, "J3", "G", null, "ground", { voltage: "GND" }),
];

const RAW_VERIFIED_BOARD_CATALOG: CatalogBoardSeed[] = [
  {
    slug: "esp32-s3-devkitc-1-n16r8",
    manufacturer: "Espressif",
    model: "ESP32-S3-DevKitC-1 N16R8",
    revision: "v1.1",
    chip_family: "esp32s3",
    chip_variant: "ESP32-S3-WROOM-1-N16R8",
    flash_size_mb: 16,
    psram_size_mb: 8,
    usb_vid: "0x303A",
    usb_pid: "0x1001",
    catalog_category: "official_espressif",
    series: "ESP32-S3",
    image_url: null,
    pinout_image_url: null,
    docs_url:
      "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html",
    datasheet_url:
      "https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf",
    source_url: "https://www.espressif.com/products/devkits",
    source_provider: "espressif_devkits",
    verification_status: "verified",
    firmware_status: "firmware_supported",
    revision_notes:
      "v1.1 uses GPIO38 for onboard WS2812 RGB LED (v1.0 used GPIO48). GPIO35-37 reserved for 8 MB Octal PSRAM.",
    is_published: true,
    board_layout: {
      formFactor: "devkit",
      orientation: "vertical",
      aspectRatio: 87 / 189,
      usbEdge: "bottom",
      usbLabel: "UART + Native USB-C",
      antennaEdge: "top",
      antennaLabel: "PCB Antenna",
      imageFrame: { pinTopPct: 14.5, pinBottomPct: 89.5 },
      hardwareSpecs: {
        processor: "Dual-Core Xtensa LX7 (240 MHz)",
        wireless: "Wi-Fi 4, BLE 5.0",
        usb: "2x USB-C (UART + Native OTG)",
        usbPortCount: 2,
        usbConnector: "usb-c",
        buttons: "RST + BOOT",
        resetLabel: "RST",
        modulePackage: "wroom",
        hasUartBridge: true,
      },
      leftHeader: { name: "J1", pins: S3_DEVKITC1_J1 },
      rightHeader: { name: "J3", pins: S3_V11_J3 },
      onboardFeatures: [
        { label: "WS2812 RGB LED", gpioPin: 38, kind: "rgb_led", note: "GPIO38 on v1.1 revision" },
        { label: "BOOT Button", gpioPin: 0, kind: "button", note: "GPIO0 active-low boot mode" },
        { label: "Octal PSRAM", gpioPin: 35, kind: "psram", note: "GPIO35-37 reserved (N16R8)" },
      ],
    },
    gpio_definitions: buildDefinitionsFromHeaders(S3_DEVKITC1_J1, S3_V11_J3, ESP32_S3_OPI_SOC, [
      { pin: 26, reservedReason: "Internal SPI0/1 Flash bus" },
      { pin: 27, reservedReason: "Internal SPI0/1 Flash bus" },
      { pin: 28, reservedReason: "Internal SPI0/1 Flash bus" },
      { pin: 29, reservedReason: "Internal SPI0/1 Flash bus" },
      { pin: 30, reservedReason: "Internal SPI0/1 Flash bus" },
      { pin: 31, reservedReason: "Internal SPI0/1 Flash bus" },
      { pin: 32, reservedReason: "Internal SPI0/1 Flash bus" },
      { pin: 33, reservedReason: "Internal 8 MB Octal PSRAM bus" },
      { pin: 34, reservedReason: "Internal 8 MB Octal PSRAM bus" },
    ]),
  },
  {
    slug: "seeed-xiao-esp32s3",
    manufacturer: "Seeed Studio",
    model: "XIAO ESP32-S3",
    revision: "v1.0",
    chip_family: "esp32s3",
    chip_variant: "ESP32-S3R8",
    flash_size_mb: 8,
    psram_size_mb: 8,
    usb_vid: "0x2886",
    usb_pid: "0x0056",
    catalog_category: "partner",
    series: "ESP32-S3",
    image_url: null,
    pinout_image_url: null,
    docs_url: "https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/",
    datasheet_url:
      "https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32S3/res/esp32-s3_datasheet_en.pdf",
    source_url: "https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/",
    source_provider: "seeed_partner",
    verification_status: "verified",
    firmware_status: "catalog_only",
    revision_notes:
      "Ultra-compact 21x17.8mm thumb-sized board. Exposes 11 GPIO pins across 7+7 castellations; onboard orange USER_LED on GPIO21 (active-low). B2B GPIO41/42 are digital-only.",
    is_published: true,
    board_layout: {
      formFactor: "xiao",
      orientation: "vertical",
      aspectRatio: 773 / 977,
      usbEdge: "top",
      usbLabel: "USB Type-C",
      antennaEdge: "bottom",
      antennaLabel: "U.FL / B2B",
      imageFrame: { pinTopPct: 18.5, pinBottomPct: 87.5 },
      hardwareSpecs: {
        processor: "Dual-Core Xtensa LX7 (240 MHz)",
        wireless: "Wi-Fi 4, BLE 5.0",
        usb: "1x USB-C",
        usbPortCount: 1,
        usbConnector: "usb-c",
        buttons: "RESET + BOOT",
        resetLabel: "RESET",
        modulePackage: "xiao",
        hasUartBridge: false,
      },
      leftHeader: { name: "Left (D0-D6)", pins: XIAO_S3_LEFT },
      rightHeader: { name: "Right (Power / D7-D10)", pins: XIAO_S3_RIGHT },
      onboardFeatures: [
        { label: "USER LED", gpioPin: 21, kind: "led", note: "Orange LED active-low on GPIO21" },
        { label: "BOOT Button", gpioPin: 0, kind: "button", note: "Top-right tactile BOOT button" },
        { label: "USB Serial / JTAG", gpioPin: 19, kind: "usb", note: "GPIO19/20 USB Type-C" },
      ],
    },
    gpio_definitions: buildDefinitionsFromHeaders(XIAO_S3_LEFT, XIAO_S3_RIGHT, XIAO_ESP32_S3_SOC, [
      { pin: 21, note: "Onboard USER_LED (active-low; shared with Sense SD CS)" },
      { pin: 0, note: "Onboard BOOT button" },
    ]),
  },
  {
    slug: "esp32-s3-devkitc-1-v1-0",
    manufacturer: "Espressif",
    model: "ESP32-S3-DevKitC-1 v1.0",
    revision: "v1.0",
    chip_family: "esp32s3",
    chip_variant: "ESP32-S3-WROOM-1-N8R8",
    flash_size_mb: 8,
    psram_size_mb: 8,
    usb_vid: "0x303A",
    usb_pid: "0x1001",
    catalog_category: "official_espressif",
    series: "ESP32-S3",
    image_url: null,
    pinout_image_url: null,
    docs_url:
      "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.0.html",
    datasheet_url:
      "https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf",
    source_url: "https://www.espressif.com/products/devkits",
    source_provider: "espressif_devkits",
    verification_status: "verified",
    firmware_status: "catalog_only",
    revision_notes:
      "Earlier v1.0 hardware revision: onboard WS2812 RGB LED is wired to GPIO48 instead of GPIO38.",
    is_published: true,
    board_layout: {
      formFactor: "devkit",
      orientation: "vertical",
      aspectRatio: 87 / 189,
      usbEdge: "bottom",
      usbLabel: "UART + Native USB-C",
      antennaEdge: "top",
      antennaLabel: "PCB Antenna",
      imageFrame: { pinTopPct: 14.5, pinBottomPct: 89.5 },
      hardwareSpecs: {
        processor: "Dual-Core Xtensa LX7 (240 MHz)",
        wireless: "Wi-Fi 4, BLE 5.0",
        usb: "2x USB-C (UART + Native OTG)",
        usbPortCount: 2,
        usbConnector: "usb-c",
        buttons: "RST + BOOT",
        resetLabel: "RST",
        modulePackage: "wroom",
        hasUartBridge: true,
      },
      leftHeader: { name: "J1", pins: S3_DEVKITC1_J1 },
      rightHeader: { name: "J3", pins: S3_V10_J3 },
      onboardFeatures: [
        { label: "WS2812 RGB LED", gpioPin: 48, kind: "rgb_led", note: "GPIO48 on v1.0 revision" },
        { label: "BOOT Button", gpioPin: 0, kind: "button", note: "GPIO0 active-low boot mode" },
      ],
    },
    gpio_definitions: buildDefinitionsFromHeaders(S3_DEVKITC1_J1, S3_V10_J3, ESP32_S3_OPI_SOC),
  },
  {
    slug: "esp32-c6-devkitc-1",
    manufacturer: "Espressif",
    model: "ESP32-C6-DevKitC-1",
    revision: "v1.2",
    chip_family: "esp32c6",
    chip_variant: "ESP32-C6-WROOM-1-N8",
    flash_size_mb: 8,
    psram_size_mb: 0,
    usb_vid: "0x303A",
    usb_pid: "0x1001",
    catalog_category: "official_espressif",
    series: "ESP32-C6",
    image_url: null,
    pinout_image_url: null,
    docs_url:
      "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c6/esp32-c6-devkitc-1/user_guide.html",
    datasheet_url:
      "https://www.espressif.com/sites/default/files/documentation/esp32-c6_datasheet_en.pdf",
    source_url: "https://www.espressif.com/products/devkits",
    source_provider: "espressif_devkits",
    verification_status: "verified",
    firmware_status: "catalog_only",
    revision_notes:
      "RISC-V Wi-Fi 6 + BLE 5 + IEEE 802.15.4 (Thread/Zigbee). RGB LED on GPIO8; USB D-/D+ on GPIO12/13.",
    is_published: true,
    board_layout: {
      formFactor: "devkit",
      orientation: "vertical",
      aspectRatio: 89 / 189,
      usbEdge: "bottom",
      usbLabel: "UART + Native USB-C",
      antennaEdge: "top",
      antennaLabel: "PCB Antenna",
      imageFrame: { pinTopPct: 15, pinBottomPct: 87 },
      hardwareSpecs: {
        processor: "Single-Core RISC-V (160 MHz)",
        wireless: "Wi-Fi 6, BLE 5.3, Zigbee / Thread",
        usb: "2x USB-C (UART + Native JTAG)",
        usbPortCount: 2,
        usbConnector: "usb-c",
        buttons: "RST + BOOT",
        resetLabel: "RST",
        modulePackage: "wroom",
        hasUartBridge: true,
      },
      leftHeader: { name: "J1", pins: ESP32_C6_J1 },
      rightHeader: { name: "J3", pins: ESP32_C6_J3 },
      onboardFeatures: [
        { label: "WS2812 RGB LED", gpioPin: 8, kind: "rgb_led", note: "GPIO8 (also strapping pin)" },
        { label: "BOOT Button", gpioPin: 9, kind: "button", note: "GPIO9 active-low boot mode" },
      ],
    },
    gpio_definitions: buildDefinitionsFromHeaders(ESP32_C6_J1, ESP32_C6_J3, ESP32_C6_SOC),
  },
  {
    slug: "esp32-c3-devkitm-1",
    manufacturer: "Espressif",
    model: "ESP32-C3-DevKitM-1",
    revision: "v1.0",
    chip_family: "esp32c3",
    chip_variant: "ESP32-C3-MINI-1-N4",
    flash_size_mb: 4,
    psram_size_mb: 0,
    usb_vid: "0x10C4",
    usb_pid: "0xEA60",
    catalog_category: "official_espressif",
    series: "ESP32-C3",
    image_url: null,
    pinout_image_url: null,
    docs_url:
      "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c3/esp32-c3-devkitm-1/user_guide.html",
    datasheet_url:
      "https://www.espressif.com/sites/default/files/documentation/esp32-c3_datasheet_en.pdf",
    source_url: "https://www.espressif.com/products/devkits",
    source_provider: "espressif_devkits",
    verification_status: "verified",
    firmware_status: "catalog_only",
    revision_notes:
      "Single-core RISC-V Wi-Fi + BLE 5 entry DevKit. RGB LED on GPIO8; BOOT on GPIO9; USB D-/D+ on GPIO18/19.",
    is_published: true,
    board_layout: {
      formFactor: "devkit",
      orientation: "vertical",
      aspectRatio: 112 / 189,
      usbEdge: "bottom",
      usbLabel: "Micro-USB UART",
      antennaEdge: "top",
      antennaLabel: "PCB Antenna",
      imageFrame: { pinTopPct: 16.5, pinBottomPct: 95 },
      hardwareSpecs: {
        processor: "Single-Core RISC-V (160 MHz)",
        wireless: "Wi-Fi 4, BLE 5.0",
        usb: "1x Micro-USB",
        usbPortCount: 1,
        usbConnector: "micro-usb",
        buttons: "RST + BOOT",
        resetLabel: "RST",
        modulePackage: "mini",
        hasUartBridge: true,
      },
      leftHeader: { name: "J1", pins: ESP32_C3_J1 },
      rightHeader: { name: "J3", pins: ESP32_C3_J3 },
      onboardFeatures: [
        { label: "WS2812 RGB LED", gpioPin: 8, kind: "rgb_led", note: "GPIO8" },
        { label: "BOOT Button", gpioPin: 9, kind: "button", note: "GPIO9" },
      ],
    },
    gpio_definitions: buildDefinitionsFromHeaders(ESP32_C3_J1, ESP32_C3_J3, ESP32_C3_SOC),
  },
  {
    slug: "esp32-devkitc-v4",
    manufacturer: "Espressif",
    model: "ESP32-DevKitC V4",
    revision: "v4.0",
    chip_family: "esp32",
    chip_variant: "ESP32-WROOM-32E",
    flash_size_mb: 4,
    psram_size_mb: 0,
    usb_vid: "0x10C4",
    usb_pid: "0xEA60",
    catalog_category: "official_espressif",
    series: "ESP32",
    image_url: null,
    pinout_image_url: null,
    docs_url:
      "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html",
    datasheet_url:
      "https://www.espressif.com/sites/default/files/documentation/esp32_datasheet_en.pdf",
    source_url: "https://www.espressif.com/products/devkits",
    source_provider: "espressif_devkits",
    verification_status: "verified",
    firmware_status: "catalog_only",
    revision_notes:
      "Classic dual-core Xtensa ESP32 DevKit. GPIO34-39 are input-only; GPIO6-11 connect internal SPI Flash.",
    is_published: true,
    board_layout: {
      formFactor: "devkit",
      orientation: "vertical",
      aspectRatio: 100 / 188,
      usbEdge: "bottom",
      usbLabel: "Micro-USB UART",
      antennaEdge: "top",
      antennaLabel: "PCB Antenna",
      imageFrame: { pinTopPct: 15.5, pinBottomPct: 94 },
      hardwareSpecs: {
        processor: "Dual-Core Xtensa LX6 (240 MHz)",
        wireless: "Wi-Fi 4, BLE 4.2",
        usb: "1x Micro-USB",
        usbPortCount: 1,
        usbConnector: "micro-usb",
        buttons: "EN + BOOT",
        resetLabel: "EN",
        modulePackage: "wroom",
        hasUartBridge: true,
      },
      leftHeader: { name: "J2", pins: ESP32_V4_J2 },
      rightHeader: { name: "J3", pins: ESP32_V4_J3 },
      onboardFeatures: [
        { label: "BOOT Button", gpioPin: 0, kind: "button", note: "GPIO0 active-low boot mode" },
        { label: "SPI Flash", gpioPin: 6, kind: "flash", note: "GPIO6-11 internal SPI Flash" },
      ],
    },
    gpio_definitions: buildDefinitionsFromHeaders(ESP32_V4_J2, ESP32_V4_J3, ESP32_DEVKITC_SOC),
  },
  {
    slug: "esp32-s2-devkitc-1",
    manufacturer: "Espressif",
    model: "ESP32-S2-DevKitC-1",
    revision: "v1.0",
    chip_family: "esp32s2",
    chip_variant: "ESP32-S2-SOLO-2-N4R2",
    flash_size_mb: 4,
    psram_size_mb: 2,
    usb_vid: "0x303A",
    usb_pid: "0x0002",
    catalog_category: "official_espressif",
    series: "ESP32-S2",
    image_url: null,
    pinout_image_url: null,
    docs_url:
      "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s2/esp32-s2-devkitc-1/user_guide.html",
    datasheet_url:
      "https://www.espressif.com/sites/default/files/documentation/esp32-s2_datasheet_en.pdf",
    source_url: "https://www.espressif.com/products/devkits",
    source_provider: "espressif_devkits",
    verification_status: "verified",
    firmware_status: "catalog_only",
    revision_notes: "Single-core Xtensa ESP32-S2 Wi-Fi DevKit with USB OTG; RGB LED on GPIO18.",
    is_published: true,
    board_layout: {
      formFactor: "devkit",
      orientation: "vertical",
      aspectRatio: 77 / 187,
      usbEdge: "bottom",
      usbLabel: "UART + USB OTG",
      antennaEdge: "top",
      antennaLabel: "PCB Antenna",
      imageFrame: { pinTopPct: 15.5, pinBottomPct: 93 },
      hardwareSpecs: {
        processor: "Single-Core Xtensa LX7 (240 MHz)",
        wireless: "Wi-Fi 4 (No BLE)",
        usb: "2x Micro-USB (UART + OTG)",
        usbPortCount: 2,
        usbConnector: "micro-usb",
        buttons: "RST + BOOT",
        resetLabel: "RST",
        modulePackage: "solo",
        hasUartBridge: true,
      },
      leftHeader: { name: "J1", pins: ESP32_S2_J1 },
      rightHeader: { name: "J3", pins: ESP32_S2_J3 },
      onboardFeatures: [
        { label: "WS2812 RGB LED", gpioPin: 18, kind: "rgb_led", note: "GPIO18" },
        { label: "BOOT Button", gpioPin: 0, kind: "button", note: "GPIO0" },
      ],
    },
    gpio_definitions: buildDefinitionsFromHeaders(ESP32_S2_J1, ESP32_S2_J3, ESP32_S2_SOC),
  },
  {
    slug: "esp32-c5-devkitc-1",
    manufacturer: "Espressif",
    model: "ESP32-C5-DevKitC-1",
    revision: "v1.2",
    chip_family: "esp32c5",
    chip_variant: "ESP32-C5-WROOM-1-N8R8",
    flash_size_mb: 8,
    psram_size_mb: 8,
    usb_vid: "0x303A",
    usb_pid: "0x1001",
    catalog_category: "official_espressif",
    series: "ESP32-C5",
    image_url: null,
    pinout_image_url: null,
    docs_url:
      "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c5/esp32-c5-devkitc-1/user_guide.html",
    datasheet_url:
      "https://www.espressif.com/sites/default/files/documentation/esp32-c5_datasheet_en.pdf",
    source_url: "https://www.espressif.com/products/devkits",
    source_provider: "espressif_devkits",
    verification_status: "verified",
    firmware_status: "catalog_only",
    revision_notes:
      "Dual-band (2.4 / 5 GHz) Wi-Fi 6 + BLE 5 + Thread/Zigbee RISC-V DevKit. RGB LED on GPIO27; BOOT on GPIO28.",
    is_published: true,
    board_layout: {
      formFactor: "devkit",
      orientation: "vertical",
      aspectRatio: 84 / 190,
      usbEdge: "bottom",
      usbLabel: "UART + Native USB-C",
      antennaEdge: "top",
      antennaLabel: "Dual-Band Antenna",
      imageFrame: { pinTopPct: 15.5, pinBottomPct: 86 },
      hardwareSpecs: {
        processor: "Single-Core RISC-V (240 MHz)",
        wireless: "Wi-Fi 6 (2.4 / 5 GHz), BLE 5.0, Zigbee / Thread",
        usb: "2x USB-C (UART + Native JTAG)",
        usbPortCount: 2,
        usbConnector: "usb-c",
        buttons: "RST + BOOT",
        resetLabel: "RST",
        modulePackage: "wroom",
        hasUartBridge: true,
      },
      leftHeader: { name: "J1", pins: ESP32_C5_J1 },
      rightHeader: { name: "J3", pins: ESP32_C5_J3 },
      onboardFeatures: [
        { label: "WS2812 RGB LED", gpioPin: 27, kind: "rgb_led", note: "GPIO27" },
        { label: "BOOT Button", gpioPin: 28, kind: "button", note: "GPIO28" },
      ],
    },
    gpio_definitions: buildDefinitionsFromHeaders(ESP32_C5_J1, ESP32_C5_J3, ESP32_C5_SOC),
  },
  {
    slug: "esp32-c61-devkitc-1",
    manufacturer: "Espressif",
    model: "ESP32-C61-DevKitC-1",
    revision: "v2.0",
    chip_family: "esp32c61",
    chip_variant: "ESP32-C61-WROOM-1-N8R2",
    flash_size_mb: 8,
    psram_size_mb: 2,
    usb_vid: "0x303A",
    usb_pid: "0x1001",
    catalog_category: "official_espressif",
    series: "ESP32-C61",
    image_url: null,
    pinout_image_url: null,
    docs_url:
      "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c61/esp32-c61-devkitc-1/user_guide.html",
    datasheet_url: null,
    source_url: "https://www.espressif.com/products/devkits",
    source_provider: "espressif_devkits",
    verification_status: "verified",
    firmware_status: "catalog_only",
    revision_notes: "Cost-optimized Wi-Fi 6 + BLE 5 + PSRAM RISC-V DevKit. RGB LED on GPIO8.",
    is_published: true,
    board_layout: {
      formFactor: "devkit",
      orientation: "vertical",
      aspectRatio: 85 / 186,
      usbEdge: "bottom",
      usbLabel: "UART + Native USB-C",
      antennaEdge: "top",
      antennaLabel: "PCB Antenna",
      imageFrame: { pinTopPct: 15.5, pinBottomPct: 86.5 },
      hardwareSpecs: {
        processor: "Single-Core RISC-V (160 MHz)",
        wireless: "Wi-Fi 6, BLE 5.0",
        usb: "2x USB-C (UART + Native JTAG)",
        usbPortCount: 2,
        usbConnector: "usb-c",
        buttons: "RST + BOOT",
        resetLabel: "RST",
        modulePackage: "wroom",
        hasUartBridge: true,
      },
      leftHeader: { name: "J1", pins: ESP32_C61_J1 },
      rightHeader: { name: "J3", pins: ESP32_C61_J3 },
      onboardFeatures: [
        { label: "WS2812 RGB LED", gpioPin: 8, kind: "rgb_led", note: "GPIO8" },
        { label: "BOOT Button", gpioPin: 9, kind: "button", note: "GPIO9" },
      ],
    },
    gpio_definitions: buildDefinitionsFromHeaders(ESP32_C61_J1, ESP32_C61_J3, ESP32_C61_SOC),
  },
  {
    slug: "esp8684-devkitm-1",
    manufacturer: "Espressif",
    model: "ESP8684-DevKitM-1",
    revision: "v1.1",
    chip_family: "esp32c2",
    chip_variant: "ESP8684-MINI-1-N4",
    flash_size_mb: 4,
    psram_size_mb: 0,
    usb_vid: "0x10C4",
    usb_pid: "0xEA60",
    catalog_category: "official_espressif",
    series: "ESP32-C2",
    image_url: null,
    pinout_image_url: null,
    docs_url:
      "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c2/esp8684-devkitm-1/user_guide.html",
    datasheet_url:
      "https://www.espressif.com/sites/default/files/documentation/esp8684_datasheet_en.pdf",
    source_url: "https://www.espressif.com/products/devkits",
    source_provider: "espressif_devkits",
    verification_status: "verified",
    firmware_status: "catalog_only",
    revision_notes: "Ultra-low-cost ESP32-C2 / ESP8684 Wi-Fi 4 + BLE 5 DevKit. RGB LED on GPIO0/1/8.",
    is_published: true,
    board_layout: {
      formFactor: "devkit",
      orientation: "vertical",
      aspectRatio: 108 / 184,
      usbEdge: "bottom",
      usbLabel: "Micro-USB UART",
      antennaEdge: "top",
      antennaLabel: "PCB Antenna",
      imageFrame: { pinTopPct: 16.5, pinBottomPct: 94.5 },
      hardwareSpecs: {
        processor: "Single-Core RISC-V (120 MHz)",
        wireless: "Wi-Fi 4, BLE 5.0",
        usb: "1x Micro-USB",
        usbPortCount: 1,
        usbConnector: "micro-usb",
        buttons: "RST + BOOT",
        resetLabel: "RST",
        modulePackage: "mini",
        hasUartBridge: true,
      },
      leftHeader: { name: "J1", pins: ESP8684_J1 },
      rightHeader: { name: "J3", pins: ESP8684_J3 },
      onboardFeatures: [
        { label: "Discrete RGB LED", gpioPin: 0, kind: "rgb_led", note: "GPIO0 (R), GPIO1 (G), GPIO8 (B)" },
        { label: "BOOT Button", gpioPin: 9, kind: "button", note: "GPIO9" },
      ],
    },
    gpio_definitions: buildDefinitionsFromHeaders(ESP8684_J1, ESP8684_J3, ESP32_C2_SOC),
  },
  {
    slug: "esp32-h2-devkitm-1",
    manufacturer: "Espressif",
    model: "ESP32-H2-DevKitM-1",
    revision: "v1.2",
    chip_family: "esp32h2",
    chip_variant: "ESP32-H2-MINI-1-N4",
    flash_size_mb: 4,
    psram_size_mb: 0,
    usb_vid: "0x303A",
    usb_pid: "0x1001",
    catalog_category: "official_espressif",
    series: "ESP32-H2",
    image_url: null,
    pinout_image_url: null,
    docs_url:
      "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32h2/esp32-h2-devkitm-1/user_guide.html",
    datasheet_url:
      "https://www.espressif.com/sites/default/files/documentation/esp32-h2_datasheet_en.pdf",
    source_url: "https://www.espressif.com/products/devkits",
    source_provider: "espressif_devkits",
    verification_status: "verified",
    firmware_status: "catalog_only",
    revision_notes:
      "IEEE 802.15.4 (Thread / Zigbee / Matter) + BLE 5 DevKit (no Wi-Fi radio). RGB LED on GPIO8.",
    is_published: true,
    board_layout: {
      formFactor: "devkit",
      orientation: "vertical",
      aspectRatio: 94 / 184,
      usbEdge: "bottom",
      usbLabel: "UART + Native USB-C",
      antennaEdge: "top",
      antennaLabel: "PCB Antenna",
      imageFrame: { pinTopPct: 15, pinBottomPct: 86.5 },
      hardwareSpecs: {
        processor: "Single-Core RISC-V (96 MHz)",
        wireless: "BLE 5.3, Zigbee / Thread (No Wi-Fi)",
        usb: "2x USB-C (UART + Native JTAG)",
        usbPortCount: 2,
        usbConnector: "usb-c",
        buttons: "RST + BOOT",
        resetLabel: "RST",
        modulePackage: "mini",
        hasUartBridge: true,
      },
      leftHeader: { name: "J1", pins: ESP32_H2_J1 },
      rightHeader: { name: "J3", pins: ESP32_H2_J3 },
      onboardFeatures: [
        { label: "WS2812 RGB LED", gpioPin: 8, kind: "rgb_led", note: "GPIO8" },
        { label: "BOOT Button", gpioPin: 9, kind: "button", note: "GPIO9" },
      ],
    },
    gpio_definitions: buildDefinitionsFromHeaders(ESP32_H2_J1, ESP32_H2_J3, ESP32_H2_SOC),
  },
];

export const VERIFIED_BOARD_CATALOG: CatalogBoardSeed[] = RAW_VERIFIED_BOARD_CATALOG.map(
  (b) => ({
    ...b,
    ...resolveBoardFirmwareCompatibility(b),
  })
);

const DEFAULT_SOC_HARDWARE_SPECS: Record<
  ChipFamily,
  { processor: string; wireless: string; usb: string; usbPortCount: 1 | 2; usbConnector: "usb-c" | "micro-usb" }
> = {
  esp32: {
    processor: "Dual-Core Xtensa LX6 (240 MHz)",
    wireless: "Wi-Fi 4, BLE 4.2",
    usb: "1x Micro-USB",
    usbPortCount: 1,
    usbConnector: "micro-usb",
  },
  esp32s2: {
    processor: "Single-Core Xtensa LX7 (240 MHz)",
    wireless: "Wi-Fi 4 (No BLE)",
    usb: "2x Micro-USB (UART + OTG)",
    usbPortCount: 2,
    usbConnector: "micro-usb",
  },
  esp32s3: {
    processor: "Dual-Core Xtensa LX7 (240 MHz)",
    wireless: "Wi-Fi 4, BLE 5.0",
    usb: "2x USB-C (UART + Native OTG)",
    usbPortCount: 2,
    usbConnector: "usb-c",
  },
  esp32s31: {
    processor: "Dual-Core RISC-V",
    wireless: "Wi-Fi 6, BLE 5.3",
    usb: "2x USB-C",
    usbPortCount: 2,
    usbConnector: "usb-c",
  },
  esp32c2: {
    processor: "Single-Core RISC-V (120 MHz)",
    wireless: "Wi-Fi 4, BLE 5.0",
    usb: "1x Micro-USB",
    usbPortCount: 1,
    usbConnector: "micro-usb",
  },
  esp32c3: {
    processor: "Single-Core RISC-V (160 MHz)",
    wireless: "Wi-Fi 4, BLE 5.0",
    usb: "1x Micro-USB",
    usbPortCount: 1,
    usbConnector: "micro-usb",
  },
  esp32c5: {
    processor: "Single-Core RISC-V (240 MHz)",
    wireless: "Wi-Fi 6 (2.4 / 5 GHz), BLE 5.0, Zigbee / Thread",
    usb: "2x USB-C (UART + Native JTAG)",
    usbPortCount: 2,
    usbConnector: "usb-c",
  },
  esp32c6: {
    processor: "Single-Core RISC-V (160 MHz)",
    wireless: "Wi-Fi 6, BLE 5.3, Zigbee / Thread",
    usb: "2x USB-C (UART + Native JTAG)",
    usbPortCount: 2,
    usbConnector: "usb-c",
  },
  esp32c61: {
    processor: "Single-Core RISC-V (160 MHz)",
    wireless: "Wi-Fi 6, BLE 5.0",
    usb: "2x USB-C (UART + Native JTAG)",
    usbPortCount: 2,
    usbConnector: "usb-c",
  },
  esp32h2: {
    processor: "Single-Core RISC-V (96 MHz)",
    wireless: "BLE 5.3, Zigbee / Thread (No Wi-Fi)",
    usb: "2x USB-C (UART + Native JTAG)",
    usbPortCount: 2,
    usbConnector: "usb-c",
  },
  esp32h21: {
    processor: "Single-Core RISC-V (96 MHz)",
    wireless: "BLE 5.3, Zigbee / Thread",
    usb: "1x USB-C",
    usbPortCount: 1,
    usbConnector: "usb-c",
  },
  esp32h4: {
    processor: "Dual-Core RISC-V (96 MHz)",
    wireless: "BLE 5.4, Zigbee / Thread",
    usb: "1x USB-C",
    usbPortCount: 1,
    usbConnector: "usb-c",
  },
  esp32p4: {
    processor: "Dual-Core RISC-V HP (400 MHz)",
    wireless: "Companion Radio (No On-Die Wi-Fi)",
    usb: "2x USB-C (High-Speed OTG + Debug)",
    usbPortCount: 2,
    usbConnector: "usb-c",
  },
};

export function resolveBoardHardwareSpecs(board: {
  slug?: string;
  model?: string;
  chip_family: ChipFamily;
  chip_variant: string;
  flash_size_mb: number;
  psram_size_mb: number;
  board_layout?: BoardLayoutSpec | null;
}): ResolvedBoardHardwareSpecs {
  const catalogMatch = board.slug
    ? VERIFIED_BOARD_CATALOG.find((c) => c.slug === board.slug)
    : undefined;
  const embedded = board.board_layout?.hardwareSpecs ?? catalogMatch?.board_layout.hardwareSpecs;
  const socDefaults = DEFAULT_SOC_HARDWARE_SPECS[board.chip_family] ?? DEFAULT_SOC_HARDWARE_SPECS.esp32s3;

  const memory =
    board.psram_size_mb > 0
      ? `${board.flash_size_mb}MB Flash + ${board.psram_size_mb}MB PSRAM`
      : `${board.flash_size_mb}MB Flash`;

  const isXiao =
    board.board_layout?.formFactor === "xiao" ||
    /xiao/i.test(board.model ?? "") ||
    /xiao/i.test(board.slug ?? "");
  const isMini = /mini/i.test(board.chip_variant) || /devkitm/i.test(board.model ?? "");
  const isSolo = /solo/i.test(board.chip_variant);

  const usbConnector =
    embedded?.usbConnector ??
    (/micro-usb/i.test(board.board_layout?.usbLabel ?? "")
      ? "micro-usb"
      : isXiao
        ? "usb-c"
        : socDefaults.usbConnector);
  const usbPortCount =
    embedded?.usbPortCount ?? (isXiao ? 1 : socDefaults.usbPortCount);

  return {
    processor: embedded?.processor ?? socDefaults.processor,
    wireless: embedded?.wireless ?? socDefaults.wireless,
    usb:
      embedded?.usb ??
      (isXiao ? "1x USB-C" : socDefaults.usb),
    usbPortCount,
    usbConnector,
    buttons: embedded?.buttons ?? (board.chip_family === "esp32" ? "EN + BOOT" : "RST + BOOT"),
    resetLabel: embedded?.resetLabel ?? (isXiao ? "RESET" : board.chip_family === "esp32" ? "EN" : "RST"),
    modulePackage:
      embedded?.modulePackage ??
      (isXiao ? "xiao" : isMini ? "mini" : isSolo ? "solo" : "wroom"),
    hasUartBridge: embedded?.hasUartBridge ?? !isXiao,
    memory,
  };
}
