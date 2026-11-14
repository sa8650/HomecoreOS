import {
  SUPPORTED_DEVICE_TYPES,
  SUPPORTED_SENSOR_TYPES,
  type BoardProfileSpec,
  type GpioPinDefinition,
  type SupportedDeviceType,
  type SupportedSensorType,
} from "./index";

export type PinOperationRequirement =
  | "digital_out"
  | "digital_in"
  | "pwm"
  | "adc"
  | "i2c"
  | "pull_up"
  | "pull_down";

export interface GpioValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function requiredPinCapabilityForDevice(
  deviceType: SupportedDeviceType
): PinOperationRequirement {
  switch (deviceType) {
    case "dimmer_pwm":
      return "pwm";
    default:
      return "digital_out";
  }
}

export function requiredPinCapabilityForSensor(
  sensorType: SupportedSensorType
): PinOperationRequirement {
  switch (sensorType) {
    case "analog_voltage":
      return "adc";
    case "temperature_bme280":
    case "humidity_bme280":
    case "pressure_bme280":
    case "light_bh1750":
      return "i2c";
    case "motion_pir":
    case "contact_reed":
      return "digital_in";
    case "temperature_dht22":
    case "humidity_dht22":
    case "temperature_ds18b20":
    default:
      return "digital_in";
  }
}

export function validateGpioAssignment(params: {
  board: BoardProfileSpec;
  pin: number;
  requirement: PinOperationRequirement;
  usedPinsOnController: number[];
  requirePullUp?: boolean;
  requirePullDown?: boolean;
  allowStrappingWarning?: boolean;
}): GpioValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const def = params.board.gpio_definitions.find((g) => g.pin === params.pin);
  if (!def) {
    return {
      valid: false,
      errors: [
        `GPIO ${params.pin} does not exist on board ${params.board.manufacturer} ${params.board.model}.`,
      ],
      warnings: [],
    };
  }

  if (params.usedPinsOnController.includes(params.pin)) {
    errors.push(
      `GPIO ${params.pin} is already assigned to another device, switch, or sensor on this controller.`
    );
  }

  if (def.restrictions.reserved) {
    errors.push(
      `GPIO ${params.pin} is reserved (${def.restrictions.reserved_reason ?? "system/internal bus"}).`
    );
  }

  if (def.restrictions.flash_psram_conflict) {
    errors.push(
      `GPIO ${params.pin} is connected to internal Flash/PSRAM on ${params.board.model} and cannot be used.`
    );
  }

  if (def.restrictions.usb_jtag_conflict) {
    warnings.push(
      `GPIO ${params.pin} is shared with USB/JTAG; assigning it may interrupt USB serial communication.`
    );
  }

  if (def.restrictions.strapping_pin) {
    const msg = `GPIO ${params.pin} is a boot strapping pin (${def.restrictions.strapping_note ?? "sampled on reset"}). External pull/loads can prevent booting.`;
    if (params.allowStrappingWarning === false) {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
  }

  const isOutputReq =
    params.requirement === "digital_out" || params.requirement === "pwm";
  if (isOutputReq && def.restrictions.input_only) {
    errors.push(`GPIO ${params.pin} is input-only and cannot drive outputs.`);
  }

  if (!def.capabilities[params.requirement]) {
    errors.push(
      `GPIO ${params.pin} does not support ${params.requirement.replace("_", " ")}.`
    );
  }

  if (params.requirePullUp && !def.capabilities.pull_up) {
    errors.push(`GPIO ${params.pin} does not support internal pull-up resistors.`);
  }

  if (params.requirePullDown && !def.capabilities.pull_down) {
    errors.push(`GPIO ${params.pin} does not support internal pull-down resistors.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function validateBoardProfileSpec(board: BoardProfileSpec): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!board.manufacturer.trim()) errors.push("Manufacturer is required.");
  if (!board.model.trim()) errors.push("Board model is required.");
  if (!board.slug.trim()) errors.push("Board slug is required.");
  if (board.flash_size_mb < 2 || board.flash_size_mb > 64) {
    errors.push("Flash capacity must be between 2 MB and 64 MB.");
  }
  if (board.psram_size_mb < 0 || board.psram_size_mb > 32) {
    errors.push("PSRAM capacity must be between 0 MB and 32 MB.");
  }
  if (board.gpio_definitions.length === 0) {
    errors.push("At least one GPIO pin definition is required.");
  }

  const seenPins = new Set<number>();
  let usableOutputCount = 0;

  for (const pin of board.gpio_definitions) {
    if (pin.pin < 0 || pin.pin > 54) {
      errors.push(`Invalid GPIO number ${pin.pin}.`);
    }
    if (seenPins.has(pin.pin)) {
      errors.push(`Duplicate GPIO definition for pin ${pin.pin}.`);
    }
    seenPins.add(pin.pin);

    if (pin.restrictions.input_only && (pin.capabilities.digital_out || pin.capabilities.pwm)) {
      errors.push(
        `GPIO ${pin.pin} cannot be marked input-only while advertising output or PWM capabilities.`
      );
    }

    if (
      !pin.restrictions.reserved &&
      !pin.restrictions.flash_psram_conflict &&
      !pin.restrictions.input_only &&
      pin.capabilities.digital_out
    ) {
      usableOutputCount += 1;
    }
  }

  if (usableOutputCount === 0) {
    errors.push("Board must expose at least one non-reserved digital output GPIO pin.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateBoardPublicationReady(board: BoardProfileSpec): {
  ready: boolean;
  errors: string[];
} {
  const specCheck = validateBoardProfileSpec(board);
  const errors = [...specCheck.errors];

  if (board.verification_status === "needs_verification") {
    errors.push(
      "Board verification status is 'needs_verification'. Verify hardware pin definitions before publishing."
    );
  }
  if (board.board_layout) {
    const leftCount = board.board_layout.leftHeader?.pins?.length ?? 0;
    const rightCount = board.board_layout.rightHeader?.pins?.length ?? 0;
    if (leftCount === 0 && rightCount === 0) {
      errors.push("Board layout header pins cannot both be empty.");
    }
  }

  return {
    ready: errors.length === 0,
    errors,
  };
}

export function isSupportedDeviceType(value: string): value is SupportedDeviceType {
  return (SUPPORTED_DEVICE_TYPES as readonly string[]).includes(value);
}

export function isSupportedSensorType(value: string): value is SupportedSensorType {
  return (SUPPORTED_SENSOR_TYPES as readonly string[]).includes(value);
}

/**
 * Hardware-verified GPIO pinout for Espressif ESP32-S3-WROOM-1 N16R8
 * (16 MB QIO Flash + 8 MB Octal/OPI PSRAM).
 */
export function buildEsp32S3N16R8PinMap(): GpioPinDefinition[] {
  const pins: GpioPinDefinition[] = [];

  const adc1Pins = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const touchPins = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  const strappingNotes: Record<number, string> = {
    0: "Boot mode select (pull-up; LOW enters ROM download mode)",
    3: "JTAG signal source select",
    45: "VDD_SPI flash voltage select (must stay LOW for 3.3V flash)",
    46: "Boot mode / ROM print enable (input-only strapping during boot)",
  };

  for (let pin = 0; pin <= 48; pin++) {
    // 22..25 do not exist on ESP32-S3
    if (pin >= 22 && pin <= 25) continue;

    const isSpiFlash = pin >= 26 && pin <= 32;
    const isOctalPsram = pin >= 33 && pin <= 37;
    const isUsb = pin === 19 || pin === 20;
    const isUart0 = pin === 43 || pin === 44;
    const isStrapping = pin in strappingNotes;
    const isInputOnly = pin === 46;
    const reserved = isSpiFlash || isOctalPsram || isUart0;

    let reservedReason: string | undefined;
    if (isSpiFlash) reservedReason = "Internal SPI0/1 Flash bus";
    else if (isOctalPsram) reservedReason = "Internal 8 MB Octal (OPI) PSRAM bus on N16R8";
    else if (isUart0) reservedReason = "UART0 USB-UART console / flashing TX-RX";

    const usableIo = !reserved && !isInputOnly;

    pins.push({
      pin,
      label:
        pin === 48
          ? "GPIO48 (Onboard RGB LED)"
          : isUsb
            ? `GPIO${pin} (USB D${pin === 19 ? "-" : "+"})`
            : isUart0
              ? `GPIO${pin} (UART0 ${pin === 43 ? "TX" : "RX"})`
              : `GPIO${pin}`,
      capabilities: {
        digital_in: !isSpiFlash && !isOctalPsram,
        digital_out: usableIo,
        pwm: usableIo,
        adc: adc1Pins.has(pin),
        i2c: usableIo && !isUsb,
        spi: usableIo && !isUsb,
        uart: usableIo && !isUsb,
        touch: touchPins.has(pin),
        pull_up: !isSpiFlash && !isOctalPsram,
        pull_down: !isSpiFlash && !isOctalPsram,
      },
      restrictions: {
        input_only: isInputOnly,
        reserved,
        reserved_reason: reservedReason,
        strapping_pin: isStrapping,
        strapping_note: strappingNotes[pin],
        flash_psram_conflict: isSpiFlash || isOctalPsram,
        usb_jtag_conflict: isUsb,
      },
    });
  }

  return pins;
}
