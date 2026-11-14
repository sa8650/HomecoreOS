/**
 * Smart Home Planner — (2) board capability evaluation.
 *
 * Reads one admin-managed board record and answers: what is its catalog status,
 * and which of its pins can the planner safely hand out for which job? Pin
 * safety is decided by the platform's existing validateGpioAssignment() rules,
 * so the planner can never propose a pin the Devices / Switches / Sensors pages
 * would reject or warn about.
 */
import { normalizeChipFamily, resolveBoardHardwareSpecs } from "../board-catalog-data";
import { resolveBoardFirmwareCompatibility } from "../board-firmware-compat";
import {
  validateBoardProfileSpec,
  validateGpioAssignment,
  type PinOperationRequirement,
} from "../board-validation";
import { chipFamilyLabel, type BoardProfileSpec, type GpioPinDefinition } from "../index";
import {
  PLANNER_FIRMWARE_MAX_IO_ITEMS,
  type PlannerBoardCapability,
  type PlannerBoardRecord,
  type PlannerBoardStatus,
  type PlannerCapabilityCounts,
  type PlannerPinDemand,
  type PlannerPinInfo,
  type PlannerPinTier,
} from "./types";

export const PLANNER_PIN_DEMANDS: readonly PlannerPinDemand[] = [
  "digital_out",
  "pwm",
  "digital_in",
  "contact_in",
  "adc",
  "i2c",
];

/** How each planner demand maps onto the existing GPIO validator. */
export function plannerDemandRule(demand: PlannerPinDemand): {
  requirement: PinOperationRequirement;
  requirePullUp: boolean;
} {
  switch (demand) {
    case "digital_out":
      return { requirement: "digital_out", requirePullUp: false };
    case "pwm":
      return { requirement: "pwm", requirePullUp: false };
    case "digital_in":
      return { requirement: "digital_in", requirePullUp: false };
    case "contact_in":
      // A dry contact floats unless the pin can pull it up.
      return { requirement: "digital_in", requirePullUp: true };
    case "adc":
      return { requirement: "adc", requirePullUp: false };
    case "i2c":
      return { requirement: "i2c", requirePullUp: false };
  }
}

/** A BoardProfileSpec view of a planner record, or null for an unknown chip. */
export function toPlannerBoardSpec(board: PlannerBoardRecord): BoardProfileSpec | null {
  const chipFamily = normalizeChipFamily(board.chip_family);
  if (!chipFamily) return null;
  return {
    id: board.id,
    slug: board.slug,
    manufacturer: board.manufacturer,
    model: board.model,
    revision: board.revision,
    chip_family: chipFamily,
    chip_variant: board.chip_variant,
    flash_size_mb: board.flash_size_mb,
    psram_size_mb: board.psram_size_mb,
    verification_status: board.verification_status ?? undefined,
    board_layout: board.board_layout ?? null,
    gpio_definitions: Array.isArray(board.gpio_definitions) ? board.gpio_definitions : [],
  };
}

export function classifyPlannerBoardStatus(board: PlannerBoardRecord): PlannerBoardStatus {
  const isCustom = board.source === "custom";
  const isVerified = !isCustom && board.verification_status === "verified";
  const chipKnown = normalizeChipFamily(board.chip_family) !== null;

  if (!chipKnown) {
    return {
      code: "unsupported",
      label: "Unsupported",
      detail: `The chip family "${board.chip_family}" is not supported by HomecoreOS.`,
      isPublished: false,
      isVerified,
      isCustom,
    };
  }
  if (board.firmware_status === "unsupported") {
    return {
      code: "unsupported",
      label: "Unsupported",
      detail: "This board is marked as unsupported in the Board Library.",
      isPublished: false,
      isVerified,
      isCustom,
    };
  }
  if (isCustom) {
    return {
      code: "unverified",
      label: "Unverified (custom board)",
      detail:
        "This is your own Custom Board Builder profile. HomecoreOS has not verified its pin map.",
      isPublished: false,
      isVerified: false,
      isCustom: true,
    };
  }
  if (!isVerified) {
    return {
      code: "unverified",
      label: "Unverified",
      detail: "The pin map of this board is still waiting to be verified by HomecoreOS.",
      isPublished: false,
      isVerified: false,
      isCustom: false,
    };
  }
  if (!board.is_available) {
    return {
      code: "unpublished",
      label: "Not published in catalog",
      detail: "This board is verified but is not currently published in the Board Library.",
      isPublished: false,
      isVerified: true,
      isCustom: false,
    };
  }
  return {
    code: "published",
    label: "Published in catalog",
    detail: "This board is verified and published in the Board Library.",
    isPublished: true,
    isVerified: true,
    isCustom: false,
  };
}

interface LayoutFacts {
  /** GPIOs physically broken out on a documented header, or null if undocumented. */
  headerPins: Set<number> | null;
  powerRails: string[];
  features: Map<number, Array<{ kind: string; label: string }>>;
}

function readLayoutFacts(board: PlannerBoardRecord): LayoutFacts {
  const layout = board.board_layout as
    | {
        leftHeader?: { pins?: unknown };
        rightHeader?: { pins?: unknown };
        onboardFeatures?: unknown;
      }
    | null
    | undefined;

  const headerEntries: Array<{ kind?: unknown; gpioPin?: unknown; voltage?: unknown }> = [];
  for (const header of [layout?.leftHeader, layout?.rightHeader]) {
    if (header && Array.isArray(header.pins)) {
      for (const pin of header.pins) {
        if (pin && typeof pin === "object") headerEntries.push(pin as Record<string, unknown>);
      }
    }
  }

  const headerPins = new Set<number>();
  const rails = new Set<string>();
  for (const entry of headerEntries) {
    if (entry.kind === "gpio" && typeof entry.gpioPin === "number") {
      headerPins.add(entry.gpioPin);
    }
    if (entry.kind === "power" && typeof entry.voltage === "string" && entry.voltage.trim()) {
      rails.add(entry.voltage.trim());
    }
  }

  let documentedPins: Set<number> | null = headerPins.size > 0 ? headerPins : null;
  if (!documentedPins) {
    const fromDefinitions = (board.gpio_definitions ?? [])
      .filter((g) => g.header_side === "left" || g.header_side === "right")
      .map((g) => g.pin);
    if (fromDefinitions.length > 0) documentedPins = new Set(fromDefinitions);
  }

  const features = new Map<number, Array<{ kind: string; label: string }>>();
  if (Array.isArray(layout?.onboardFeatures)) {
    for (const raw of layout.onboardFeatures) {
      if (!raw || typeof raw !== "object") continue;
      const feature = raw as { gpioPin?: unknown; kind?: unknown; label?: unknown };
      if (typeof feature.gpioPin !== "number" || typeof feature.kind !== "string") continue;
      const list = features.get(feature.gpioPin) ?? [];
      list.push({
        kind: feature.kind,
        label: typeof feature.label === "string" && feature.label ? feature.label : feature.kind,
      });
      features.set(feature.gpioPin, list);
    }
  }

  return {
    headerPins: documentedPins,
    powerRails: Array.from(rails).sort(),
    features,
  };
}

const RESTRICTED_FEATURE_KINDS = new Set(["button", "usb", "uart"]);
const BLOCKED_FEATURE_KINDS = new Set(["psram", "flash"]);

function classifyPin(
  def: GpioPinDefinition,
  facts: LayoutFacts,
  bootButtonGpio: number | null
): PlannerPinInfo {
  const caps = def.capabilities ?? ({} as GpioPinDefinition["capabilities"]);
  const res = def.restrictions ?? ({} as GpioPinDefinition["restrictions"]);
  const blocked: string[] = [];
  const restricted: string[] = [];
  const shared: string[] = [];

  if (res.reserved) blocked.push(`Reserved: ${res.reserved_reason ?? "internal use"}`);
  if (res.flash_psram_conflict) blocked.push("Wired to the board's internal flash / PSRAM");
  if (facts.headerPins && !facts.headerPins.has(def.pin)) {
    blocked.push("Not available on the board's pin headers");
  }
  if (!caps.digital_in && !caps.digital_out && !caps.adc) {
    blocked.push("No usable input or output function");
  }

  if (res.strapping_pin) {
    restricted.push(`Boot-strapping pin: ${res.strapping_note ?? "sampled when the board starts"}`);
  }
  if (res.usb_jtag_conflict) restricted.push("Shared with the USB / JTAG port");
  if (bootButtonGpio !== null && def.pin === bootButtonGpio) {
    restricted.push("Connected to the BOOT / recovery button");
  }

  for (const feature of facts.features.get(def.pin) ?? []) {
    if (BLOCKED_FEATURE_KINDS.has(feature.kind)) {
      blocked.push(`Used by on-board ${feature.label}`);
    } else if (RESTRICTED_FEATURE_KINDS.has(feature.kind)) {
      restricted.push(`Used by on-board ${feature.label}`);
    } else {
      shared.push(`Shared with on-board ${feature.label}`);
    }
  }

  const tier: PlannerPinTier =
    blocked.length > 0
      ? "blocked"
      : restricted.length > 0
        ? "restricted"
        : shared.length > 0
          ? "shared"
          : "free";

  return {
    pin: def.pin,
    label: def.label || `GPIO${def.pin}`,
    boardPinName: def.board_pin_name ?? null,
    tier,
    reasons: tier === "blocked" ? blocked : tier === "restricted" ? restricted : shared,
    digitalOut: Boolean(caps.digital_out),
    digitalIn: Boolean(caps.digital_in),
    pwm: Boolean(caps.pwm),
    adc: Boolean(caps.adc),
    i2c: Boolean(caps.i2c),
    spi: Boolean(caps.spi),
    uart: Boolean(caps.uart),
    pullUp: Boolean(caps.pull_up),
    inputOnly: Boolean(res.input_only),
  };
}

function flexibility(pin: PlannerPinInfo): number {
  return (
    Number(pin.digitalOut) +
    Number(pin.pwm) +
    Number(pin.adc) +
    Number(pin.i2c) +
    Number(pin.pullUp)
  );
}

export function evaluatePlannerBoardCapability(
  board: PlannerBoardRecord,
  options?: { maxIoItems?: number }
): PlannerBoardCapability {
  const status = classifyPlannerBoardStatus(board);
  const spec = toPlannerBoardSpec(board);
  const compat = resolveBoardFirmwareCompatibility(board);
  const facts = readLayoutFacts(board);
  const definitions = Array.isArray(board.gpio_definitions) ? board.gpio_definitions : [];

  const specIssues: string[] = [];
  if (!spec) {
    specIssues.push(`Unknown chip family "${board.chip_family}".`);
  } else {
    specIssues.push(...validateBoardProfileSpec(spec).errors);
  }
  const evaluable = spec !== null && specIssues.length === 0;

  const pins = definitions
    .map((def) => classifyPin(def, facts, compat.boot_button_gpio))
    .sort((a, b) => a.pin - b.pin);

  // Preference: untouched pins first, then the least versatile pin that still
  // does the job, so versatile pins stay free for demands only they can meet.
  const preferred = pins
    .filter((p) => p.tier === "free" || p.tier === "shared")
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier === "free" ? -1 : 1;
      const diff = flexibility(a) - flexibility(b);
      return diff !== 0 ? diff : a.pin - b.pin;
    });

  const pinsFor = {} as Record<PlannerPinDemand, number[]>;
  for (const demand of PLANNER_PIN_DEMANDS) {
    const rule = plannerDemandRule(demand);
    pinsFor[demand] =
      evaluable && spec
        ? preferred
            .filter((p) => {
              const check = validateGpioAssignment({
                board: spec,
                pin: p.pin,
                requirement: rule.requirement,
                usedPinsOnController: [],
                requirePullUp: rule.requirePullUp,
              });
              return check.valid && check.warnings.length === 0;
            })
            .map((p) => p.pin)
        : [];
  }

  const usablePins = new Set<number>();
  for (const demand of PLANNER_PIN_DEMANDS) {
    for (const pin of pinsFor[demand]) usablePins.add(pin);
  }
  const usableInfo = pins.filter((p) => usablePins.has(p.pin));

  const counts: PlannerCapabilityCounts = {
    total: pins.length,
    usable: usableInfo.length,
    free: usableInfo.filter((p) => p.tier === "free").length,
    shared: usableInfo.filter((p) => p.tier === "shared").length,
    restricted: pins.filter((p) => p.tier === "restricted").length,
    blocked: pins.filter((p) => p.tier === "blocked").length,
    digitalOut: pinsFor.digital_out.length,
    digitalIn: pinsFor.digital_in.length,
    inputOnly: usableInfo.filter((p) => p.inputOnly).length,
    pwm: pinsFor.pwm.length,
    adc: pinsFor.adc.length,
    i2c: pinsFor.i2c.length,
    spi: usableInfo.filter((p) => p.spi).length,
    uart: usableInfo.filter((p) => p.uart).length,
    pullUp: pinsFor.contact_in.length,
  };

  const hardware = spec
    ? resolveBoardHardwareSpecs({
        slug: spec.slug,
        model: spec.model,
        chip_family: spec.chip_family,
        chip_variant: spec.chip_variant,
        flash_size_mb: spec.flash_size_mb,
        psram_size_mb: spec.psram_size_mb,
        board_layout: spec.board_layout,
      })
    : null;

  return {
    boardId: board.id,
    status,
    evaluable,
    specIssues,
    chipFamily: spec?.chip_family ?? board.chip_family,
    chipLabel: chipFamilyLabel(spec?.chip_family ?? board.chip_family),
    processor: hardware?.processor ?? "Not documented",
    wireless: hardware?.wireless ?? "Not documented",
    memory: hardware?.memory ?? `${board.flash_size_mb}MB Flash`,
    usb: hardware?.usb ?? "Not documented",
    supportsWifi: compat.supports_wifi,
    supportsBle: compat.supports_ble,
    ethernet: "not_documented",
    connectivityNote: compat.connectivity_note,
    powerRails: facts.powerRails,
    currentLimitDocumented: false,
    onboardRelayChannels: 0,
    maxIoItems: Math.max(1, options?.maxIoItems ?? PLANNER_FIRMWARE_MAX_IO_ITEMS),
    pins,
    counts,
    pinsFor,
  };
}
