/**
 * GPIO pin selection policy.
 *
 * One rule set decides which pins of a board a device, switch or sensor may
 * use. It is shared by the visual pin selector in the user console and by the
 * device / switch / sensor API, so the interface can never offer a pin the
 * server would refuse (or the other way round).
 *
 * The hardware rules themselves are not new: they are the ones the Smart Home
 * Planner already applies (collectBoardPinHardwareFacts) together with the
 * platform's validateGpioAssignment(). This module only turns their verdicts
 * into four user-facing states and ranks the pins that are left.
 */
import { resolveBoardFirmwareCompatibility } from "./board-firmware-compat";
import { validateGpioAssignment, type PinOperationRequirement } from "./board-validation";
import type { BoardHeaderPin, BoardProfileSpec, GpioPinDefinition } from "./index";
import { collectBoardPinHardwareFacts, readBoardLayoutFacts } from "./planner/board-capability";

/** The four states of the pin selector. */
export type GpioPinState = "available" | "used" | "restricted" | "dangerous";

export const GPIO_PIN_STATE_LABELS: Record<GpioPinState, string> = {
  available: "Available",
  used: "Used",
  restricted: "Restricted",
  dangerous: "Dangerous",
};

export const GPIO_PIN_STATE_DESCRIPTIONS: Record<GpioPinState, string> = {
  available: "Free and suitable for this type.",
  used: "Already assigned on this controller.",
  restricted: "Affects booting or USB, or cannot do what this type needs.",
  dangerous: "Reserved by the board's own hardware. Never assignable.",
};

export type GpioPinEntityKind = "switch" | "device" | "sensor";

export interface GpioPinUsage {
  pin: number;
  entityKind: GpioPinEntityKind;
  id: string;
  name: string;
}

export type GpioPinLocation = "header" | "pad" | "onboard";

export type GpioCapabilityTag = "OUT" | "IN" | "PWM" | "ADC" | "I2C" | "TOUCH";

export interface GpioPinSelectorEntry {
  pin: number;
  /** "GPIO6" */
  label: string;
  /** The name printed on the board ("D4 / SDA"), when it differs from the label. */
  boardPinName: string | null;
  state: GpioPinState;
  selectable: boolean;
  /** One sentence: why the pin cannot be chosen, or what to keep in mind. */
  explanation: string | null;
  /**
   * The reason in one or two words ("FLASH", "STRAP", "NO ADC"), for places
   * that have no room for the sentence. Null when the pin can be chosen.
   */
  reasonTag: string | null;
  /** Selectable, but shared with an on-board part such as an LED. */
  caution: boolean;
  capabilities: GpioCapabilityTag[];
  /** Default bus roles printed for this pin: "SDA", "SCL", "TX", "MOSI" ... */
  roles: string[];
  /** The other device, switch or sensor that holds this pin. */
  usedBy: GpioPinUsage | null;
  /** The pin currently saved for the entity being edited. */
  isCurrent: boolean;
  /**
   * Where the pin lives: on one of the two main headers, on an extra solder
   * pad, or only on the board itself (internal signals and on-board parts).
   */
  location: GpioPinLocation;
  /** 1 = best suggestion for the selected type; null when not suggested. */
  suggestionRank: number | null;
}

export interface GpioPinSelectorModel {
  requirement: PinOperationRequirement;
  entries: GpioPinSelectorEntry[];
  /** Suggested pins, best first. */
  suggestions: number[];
  counts: Record<GpioPinState, number>;
}

/** The board fields the policy reads. Catalog and custom boards both fit. */
export type GpioPinSelectorBoard = Pick<
  BoardProfileSpec,
  | "manufacturer"
  | "model"
  | "chip_family"
  | "flash_size_mb"
  | "psram_size_mb"
  | "gpio_definitions"
> &
  Partial<Pick<BoardProfileSpec, "slug" | "boot_button_gpio" | "board_layout" | "chip_variant" | "revision">>;

const REQUIREMENT_LABELS: Record<PinOperationRequirement, string> = {
  digital_out: "digital output",
  digital_in: "digital input",
  pwm: "PWM output",
  adc: "analog input (ADC)",
  i2c: "I2C",
  pull_up: "an internal pull-up",
  pull_down: "an internal pull-down",
};

export function gpioRequirementLabel(requirement: PinOperationRequirement): string {
  return REQUIREMENT_LABELS[requirement] ?? requirement.replace("_", " ");
}

const BUS_ROLES = ["SDA", "SCL", "MOSI", "MISO", "SCK", "TX", "RX"] as const;
const REQUIREMENT_TAGS: Record<PinOperationRequirement, string> = {
  digital_out: "NO OUTPUT",
  digital_in: "NO INPUT",
  pwm: "NO PWM",
  adc: "NO ADC",
  i2c: "NO I2C",
  pull_up: "NO PULL-UP",
  pull_down: "NO PULL-DOWN",
};

/** Names what a reserved pin is reserved for, from the board's own note. */
function reservedTag(reason: string | undefined): string {
  const text = (reason ?? "").toLowerCase();
  if (/psram/.test(text)) return "PSRAM";
  if (/flash/.test(text)) return "FLASH";
  if (/uart|console|serial/.test(text)) return "UART";
  if (/usb|jtag/.test(text)) return "USB";
  if (/antenna|rf\b|radio/.test(text)) return "RADIO";
  if (/camera/.test(text)) return "CAMERA";
  if (/sd\b|card/.test(text)) return "SD CARD";
  if (/batter/.test(text)) return "BATTERY";
  return "RESERVED";
}
const LED_KINDS = new Set(["led", "rgb_led"]);
const MAX_SUGGESTIONS = 3;

interface PolicyContext {
  board: GpioPinSelectorBoard;
  spec: BoardProfileSpec;
  requirement: PinOperationRequirement;
  facts: ReturnType<typeof readBoardLayoutFacts>;
  bootButtonGpio: number | null;
  usageByPin: Map<number, GpioPinUsage | null>;
  headerByPin: Map<number, BoardHeaderPin>;
  /** GPIOs that sit on an extra solder pad instead of a main header. */
  extraPadPins: Set<number>;
  currentPin: number | null;
}

function toSpec(board: GpioPinSelectorBoard): BoardProfileSpec {
  return {
    slug: board.slug ?? "",
    manufacturer: board.manufacturer,
    model: board.model,
    revision: board.revision ?? "",
    chip_family: board.chip_family,
    chip_variant: board.chip_variant ?? "",
    flash_size_mb: board.flash_size_mb,
    psram_size_mb: board.psram_size_mb,
    boot_button_gpio: board.boot_button_gpio ?? null,
    board_layout: board.board_layout ?? null,
    gpio_definitions: board.gpio_definitions,
  };
}

function createContext(params: {
  board: GpioPinSelectorBoard;
  requirement: PinOperationRequirement;
  usedPins?: Array<number | GpioPinUsage>;
  editing?: { entityKind: GpioPinEntityKind; id: string } | null;
  currentPin?: number | null;
}): PolicyContext {
  const spec = toSpec(params.board);
  const usageByPin = new Map<number, GpioPinUsage | null>();
  let currentPin = params.currentPin ?? null;

  for (const raw of params.usedPins ?? []) {
    if (typeof raw === "number") {
      if (!usageByPin.has(raw)) usageByPin.set(raw, null);
      continue;
    }
    if (
      params.editing &&
      raw.entityKind === params.editing.entityKind &&
      raw.id === params.editing.id
    ) {
      // The entity being edited does not conflict with itself.
      if (currentPin === null) currentPin = raw.pin;
      continue;
    }
    if (!usageByPin.get(raw.pin)) usageByPin.set(raw.pin, raw);
  }

  const headerByPin = new Map<number, BoardHeaderPin>();
  const extraPadPins = new Set<number>();
  const layout = params.board.board_layout;
  for (const hpin of [...(layout?.leftHeader?.pins ?? []), ...(layout?.rightHeader?.pins ?? [])]) {
    if (typeof hpin?.gpioPin === "number" && !headerByPin.has(hpin.gpioPin)) {
      headerByPin.set(hpin.gpioPin, hpin);
    }
  }
  for (const hpin of layout?.extraPads?.pins ?? []) {
    if (typeof hpin?.gpioPin === "number" && !headerByPin.has(hpin.gpioPin)) {
      headerByPin.set(hpin.gpioPin, hpin);
      extraPadPins.add(hpin.gpioPin);
    }
  }

  return {
    board: params.board,
    spec,
    requirement: params.requirement,
    facts: readBoardLayoutFacts({
      board_layout: params.board.board_layout ?? null,
      gpio_definitions: params.board.gpio_definitions,
    }),
    bootButtonGpio: resolveBoardFirmwareCompatibility(spec).boot_button_gpio,
    usageByPin,
    headerByPin,
    extraPadPins,
    currentPin,
  };
}

function capabilityTags(def: GpioPinDefinition): GpioCapabilityTag[] {
  const caps = def.capabilities ?? ({} as GpioPinDefinition["capabilities"]);
  const tags: GpioCapabilityTag[] = [];
  if (caps.digital_out) tags.push("OUT");
  if (caps.digital_in) tags.push("IN");
  if (caps.pwm) tags.push("PWM");
  if (caps.adc) tags.push("ADC");
  if (caps.i2c) tags.push("I2C");
  if (caps.touch) tags.push("TOUCH");
  return tags;
}

function busRoles(def: GpioPinDefinition, header: BoardHeaderPin | undefined): string[] {
  const haystack = [
    ...(header?.aliases ?? []),
    ...(header?.pinName ?? "").split(/[\s/]+/),
    ...(def.board_pin_name ?? "").split(/[\s/]+/),
  ].map((token) => token.trim().toUpperCase());
  return BUS_ROLES.filter((role) => haystack.includes(role));
}

function usedExplanation(pin: number, usage: GpioPinUsage | null): string {
  return usage
    ? `GPIO ${pin} is already assigned to ${usage.entityKind} "${usage.name}" on this controller.`
    : `GPIO ${pin} is already assigned to another device, switch, or sensor on this controller.`;
}

function evaluateDefinition(def: GpioPinDefinition, ctx: PolicyContext): GpioPinSelectorEntry {
  const pin = def.pin;
  const res = def.restrictions ?? ({} as GpioPinDefinition["restrictions"]);
  const header = ctx.headerByPin.get(pin);
  const hw = collectBoardPinHardwareFacts(def, ctx.facts, ctx.bootButtonGpio);
  const isCurrent = ctx.currentPin === pin;
  const isUsed = ctx.usageByPin.has(pin);
  const usedBy = ctx.usageByPin.get(pin) ?? null;
  const drivesLedOnly =
    hw.offHeader &&
    !hw.hardwareReserved &&
    hw.restricted.length === 0 &&
    hw.onboardKinds.some((kind) => LED_KINDS.has(kind));

  let state: GpioPinState = "available";
  let selectable = true;
  let caution = false;
  let explanation: string | null = null;
  let reasonTag: string | null = null;

  if (isUsed) {
    state = "used";
    selectable = false;
    explanation = usedExplanation(pin, usedBy);
    reasonTag = "IN USE";
  } else if (hw.hardwareReserved) {
    state = "dangerous";
    selectable = false;
    reasonTag = res.flash_psram_conflict
      ? "FLASH"
      : res.reserved
        ? reservedTag(res.reserved_reason)
        : "ON-BOARD";
    explanation = res.flash_psram_conflict
      ? `GPIO ${pin} is wired to the internal flash / PSRAM of ${ctx.board.model}. Using it would crash the controller.`
      : res.reserved
        ? `GPIO ${pin} is reserved by the board (${res.reserved_reason ?? "internal use"}) and must not be assigned.`
        : `GPIO ${pin} is used by the board's own hardware and must not be assigned.`;
  } else if (res.strapping_pin) {
    state = "restricted";
    selectable = false;
    reasonTag = "STRAP";
    explanation = `GPIO ${pin} is a boot-strapping pin: ${res.strapping_note ?? "it is sampled when the board starts"}. Hardware wired to it can stop the controller from starting.`;
  } else if (res.usb_jtag_conflict) {
    state = "restricted";
    selectable = false;
    reasonTag = "USB";
    explanation = `GPIO ${pin} carries the USB / JTAG connection. Assigning it would cut off USB flashing and the serial console.`;
  } else if (ctx.bootButtonGpio !== null && pin === ctx.bootButtonGpio) {
    state = "restricted";
    selectable = false;
    reasonTag = "BOOT";
    explanation = `GPIO ${pin} is wired to the BOOT / recovery button of ${ctx.board.model}.`;
  } else if (hw.restricted.length > 0) {
    state = "restricted";
    selectable = false;
    reasonTag = "ON-BOARD";
    explanation = `GPIO ${pin}: ${hw.restricted[0]}.`;
  } else if (hw.offHeader && !drivesLedOnly) {
    state = "restricted";
    selectable = false;
    reasonTag = "NO PAD";
    explanation = `GPIO ${pin} is not broken out to a header pin on ${ctx.board.model}.`;
  } else {
    const check = validateGpioAssignment({
      board: ctx.spec,
      pin,
      requirement: ctx.requirement,
      usedPinsOnController: [],
    });
    if (!check.valid) {
      state = "restricted";
      selectable = false;
      const isOutput = ctx.requirement === "digital_out" || ctx.requirement === "pwm";
      reasonTag = isOutput && res.input_only ? "INPUT ONLY" : REQUIREMENT_TAGS[ctx.requirement];
      explanation =
        isOutput && res.input_only
          ? `GPIO ${pin} is input-only and cannot drive outputs.`
          : `GPIO ${pin} does not support ${gpioRequirementLabel(ctx.requirement)}, which this type needs.`;
    } else if (drivesLedOnly) {
      caution = true;
      explanation = `GPIO ${pin} drives the on-board LED. It is not broken out to a header pin.`;
    } else if (hw.shared.length > 0) {
      caution = true;
      explanation = `GPIO ${pin}: ${hw.shared[0]}.`;
    }
  }

  // An existing assignment is never taken away: the entity keeps its saved pin
  // even when that pin would not be offered today.
  if (isCurrent && !selectable && state !== "used") {
    selectable = true;
    caution = true;
    explanation = `Currently assigned here. ${explanation ?? ""}`.trim();
  }
  if (selectable) reasonTag = null;

  // A silk label that only repeats the GPIO number ("7", "IO7", "GPIO7") adds nothing.
  const rawPinName = (def.board_pin_name ?? "").trim();
  const boardPinName =
    rawPinName && !new RegExp(`^(GPIO|IO|G)?\\s*${pin}$`, "i").test(rawPinName) ? rawPinName : null;

  return {
    pin,
    label: `GPIO${pin}`,
    boardPinName,
    state,
    selectable,
    explanation,
    reasonTag,
    caution,
    capabilities: capabilityTags(def),
    roles: busRoles(def, header),
    usedBy,
    isCurrent,
    location: hw.offHeader ? "onboard" : ctx.extraPadPins.has(pin) ? "pad" : "header",
    suggestionRank: null,
  };
}

function suggestionScore(
  entry: GpioPinSelectorEntry,
  def: GpioPinDefinition,
  requirement: PinOperationRequirement
): number {
  const caps = def.capabilities ?? ({} as GpioPinDefinition["capabilities"]);
  let score = 0;

  // Main header pins first, extra solder pads next; pins that share an
  // on-board part, or exist only on the board, come last.
  if (entry.caution) score += 100;
  if (entry.location === "pad") score += 40;
  if (entry.location === "onboard") score += 200;

  if (requirement === "i2c") {
    // The board's own SDA pad is where an I2C sensor belongs. The pads of
    // the other buses (SPI, UART) stay free for those buses.
    if (entry.roles.includes("SDA")) score -= 50;
    else if (entry.roles.includes("SCL")) score += 20;
    else score += entry.roles.length * 10;
  } else {
    // Keep the default bus pads free for the buses they are labelled for.
    score += entry.roles.length * 10;
    // Keep analog-capable pins free for analog sensors.
    if (requirement !== "adc" && caps.adc) score += 4;
  }

  // Prefer the least versatile pin that still does the job.
  score +=
    Number(Boolean(caps.digital_out)) +
    Number(Boolean(caps.pwm)) +
    Number(Boolean(caps.adc)) +
    Number(Boolean(caps.i2c)) +
    Number(Boolean(caps.pull_up));

  return score;
}

/**
 * Builds the complete selector model for one board and one device / switch /
 * sensor type: every pin with its state, capability, assignment and
 * explanation, plus the suggested pins.
 */
export function buildGpioPinSelectorModel(params: {
  board: GpioPinSelectorBoard;
  requirement: PinOperationRequirement;
  /** Pins in use on the same controller. */
  usedPins?: Array<number | GpioPinUsage>;
  /** The entity being edited; its own pin is not a conflict. */
  editing?: { entityKind: GpioPinEntityKind; id: string } | null;
  /** The pin currently saved for the entity being edited. */
  currentPin?: number | null;
}): GpioPinSelectorModel {
  const ctx = createContext(params);
  const definitions = [...(params.board.gpio_definitions ?? [])].sort((a, b) => a.pin - b.pin);
  const defByPin = new Map(definitions.map((d) => [d.pin, d]));
  const entries = definitions.map((def) => evaluateDefinition(def, ctx));

  const ranked = entries
    .filter((e) => e.selectable && e.state === "available")
    .map((e) => ({ pin: e.pin, score: suggestionScore(e, defByPin.get(e.pin)!, params.requirement) }))
    .sort((a, b) => (a.score !== b.score ? a.score - b.score : a.pin - b.pin))
    .slice(0, MAX_SUGGESTIONS)
    .map((r) => r.pin);

  ranked.forEach((pin, index) => {
    const entry = entries.find((e) => e.pin === pin);
    if (entry) entry.suggestionRank = index + 1;
  });

  const counts: Record<GpioPinState, number> = {
    available: 0,
    used: 0,
    restricted: 0,
    dangerous: 0,
  };
  for (const entry of entries) counts[entry.state] += 1;

  return { requirement: params.requirement, entries, suggestions: ranked, counts };
}

export interface GpioPinChoiceVerdict {
  allowed: boolean;
  state: GpioPinState;
  /** Why the pin cannot be used; null when it is allowed without remarks. */
  explanation: string | null;
}

/** The verdict for one specific pin. Used by the API before saving. */
export function evaluateGpioPinChoice(params: {
  board: GpioPinSelectorBoard;
  pin: number;
  requirement: PinOperationRequirement;
  usedPins?: Array<number | GpioPinUsage>;
  editing?: { entityKind: GpioPinEntityKind; id: string } | null;
  currentPin?: number | null;
}): GpioPinChoiceVerdict {
  const def = (params.board.gpio_definitions ?? []).find((g) => g.pin === params.pin);
  if (!def) {
    return {
      allowed: false,
      state: "restricted",
      explanation: `GPIO ${params.pin} does not exist on ${params.board.model}.`,
    };
  }
  const entry = evaluateDefinition(def, createContext(params));
  return { allowed: entry.selectable, state: entry.state, explanation: entry.explanation };
}
