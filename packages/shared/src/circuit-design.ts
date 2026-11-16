/**
 * Interactive Wire Diagram — circuit design engine.
 *
 * Device-specific circuit synthesis. This module answers the question the
 * pin-resolution engine cannot: *what else must exist in the wiring* between
 * the controller and the load, given the class of device being wired.
 *
 * Truthfulness contract (same spirit as wire-diagram.ts):
 * - Board facts (rails, pads, on-board features, GPIO capabilities) come from
 *   the board profile only and are never invented.
 * - Every circuit pattern below is a standard, published application circuit
 *   for the device class. It is *guidance*, not a measured design: values are
 *   shown with their status (`guidance`, `formula` or `not_documented`) and
 *   every plan lists its `assumptions` and `missingSpecifications` explicitly.
 * - Load-side details that HomecoreOS cannot know (mains voltage, cable
 *   ratings, exact module voltage/current) are never fabricated — they are
 *   surfaced as warnings and `missingSpecifications`.
 * - Mains AC is never connected to a GPIO. Where a mains load is involved the
 *   plan routes it through an isolated switching stage and marks the whole
 *   load side as `safetyClass: "mains_ac"`.
 * - A board without a documented rail produces an advisory/check marked
 *   `unknown` — the rail is never picked silently.
 *
 * Pure declarations only (no import-time side effects).
 */
import type {
  SupportedDeviceType,
  SupportedSensorType,
} from "./index";
import type {
  SensorDriverDefinition,
} from "./sensor-drivers";
import {
  type WireDiagramEntityInput,
  type WireDiagramTerminal,
} from "./wire-diagram";

export type CircuitSafetyClass =
  | "low_voltage_dc"
  | "mains_ac"
  | "mixed"
  | "unknown";

export type CircuitCheckStatus = "pass" | "warn" | "fail" | "unknown";

export interface CircuitCheck {
  id: string;
  status: CircuitCheckStatus;
  title: string;
  detail: string;
}

export type CircuitComponentKind =
  | "npn_transistor"
  | "mosfet_logic"
  | "flyback_diode"
  | "series_resistor"
  | "pull_up_resistor"
  | "base_resistor"
  | "external_psu"
  | "ac_mains"
  | "appliance_load"
  | "led_strip"
  | "onboard_relay"
  | "level_shifter"
  | "voltage_divider";

/** Whether a component is asserted, or only drawn when the user's module needs it. */
export type CircuitComponentCertainty = "required" | "conditional";

export type CircuitComponentValueStatus =
  /** Typical published value — the designer shows it as guidance. */
  | "guidance"
  /** Computed from a documented formula with the inputs shown. */
  | "formula"
  /** Not documented anywhere in HomecoreOS — user must check the module. */
  | "not_documented";

export interface CircuitComponentPin {
  id: string;
  label: string;
  /** Which edge of the card the pin dot sits on. */
  edge: "left" | "right" | "top" | "bottom";
  domain: "control" | "load";
  /** Row index from the top of the pin list (stable layout anchor). */
  row: number;
}

export interface CircuitComponent {
  id: string;
  kind: CircuitComponentKind;
  label: string;
  /** Value / rating text, or null when not documented (e.g. mains rating). */
  value: string | null;
  valueStatus: CircuitComponentValueStatus;
  role: string;
  certainty: CircuitComponentCertainty;
  side: "control" | "load";
  /** One- to three-line explanation rendered inside the card. */
  notes: string[];
  /** Illustration key for the canvas (see DeviceIllustration.tsx). */
  illustration?: string;
  pins: CircuitComponentPin[];
}

export type CircuitWireKind =
  | "signal"
  | "control"
  | "power_dc"
  | "ground"
  | "ac_live"
  | "ac_neutral";

export type CircuitWireDomain = "control" | "load";

export type CircuitEndpointRef =
  | {
      type: "gpio";
      pin: number | null;
      /** `${headerName}:${position}` when a pad is resolved on the layout. */
      headerKey: string | null;
      extraPadName: string | null;
      label: string;
    }
  | {
      type: "component";
      componentId: string;
      pinId: string;
    }
  | {
      type: "device_terminal";
      terminalId: string;
    };

export interface CircuitWire {
  id: string;
  from: CircuitEndpointRef;
  to: CircuitEndpointRef;
  label: string;
  kind: CircuitWireKind;
  domain: CircuitWireDomain;
  /** Plain-language description for the connections table. */
  description: string;
  /** True only when every fact involved comes from the board profile or the record. */
  documented: boolean;
  warnings?: string[];
}

export interface CircuitDesign {
  state: "ready" | "unavailable";
  /** Stable identifier for the chosen circuit archetype. */
  archetype: string;
  archetypeLabel: string;
  /** Why this circuit was chosen — shown verbatim in the Datasheet tab. */
  reasoning: string[];
  safetyClass: CircuitSafetyClass;
  mainsInvolved: boolean;
  /** An external supply beyond the board's rails is involved (typical for solenoids / LED strips). */
  externalSupplyRequired: boolean;
  /** True when an isolated switching stage sits between GPIO and the load. */
  isolatedFromLoad: boolean;
  components: CircuitComponent[];
  wires: CircuitWire[];
  /**
   * Terminal ids whose naive board→terminal base leg is REPLACED by this
   * circuit (the base connection would bypass a driver or short supplies),
   * so the canvas must not draw it. Terminals not listed keep their base leg.
   */
  replacesBaseLegs?: string[];
  /** Ordered safety / compatibility checklist. */
  checks: CircuitCheck[];
  /** Explicit assumptions the user must confirm. */
  assumptions: string[];
  /** Specifications HomecoreOS cannot provide — never invented. */
  missingSpecifications: string[];
  formulas: Array<{ title: string; body: string }>;
  notes: string[];
}

export interface CircuitRailAnchor {
  /** Header anchor when the rail is broken out on a header; null for extra pads. */
  headerKey: string | null;
  extraPadName?: string | null;
  label: string;
}

export interface CircuitDesignContext {
  entity: WireDiagramEntityInput;
  /** Resolved by the base engine; used for model labelling. */
  boardModel: string | null;
  /** Class terminals (already resolved) — the base engine sets `drawn`. */
  terminals: WireDiagramTerminal[];
  /** Signal pin resolved by the base engine (I2C SDA, or the assigned GPIO). */
  signalPin: number | null;
  /** SCL pin when the entity is an I2C sensor on a documented bus. */
  i2cSclPin: number | null;
  /** Header anchor of the control pad for the signal pin, when resolvable. */
  gpioHeaderKey: string | null;
  /** Extra-pad name when the control pin is broken out on a back pad only. */
  gpioExtraPadName: string | null;
  /** Documented rails on the board profile (header or extra-pad anchored). */
  rails: {
    fiveVolt: CircuitRailAnchor | null;
    threeThreeVolt: CircuitRailAnchor | null;
    ground: CircuitRailAnchor | null;
  };
  /** On-board output stage hardwired to the assigned pin (relay/buzzer), if any. */
  onboardFeature: { label: string; kind: string } | null;
  /** Resolved sensor driver facts needed for driver-side checks. */
  sensorDriver: SensorDriverDefinition | null;
  /** True when the base resolution failed — no wires, no components. */
  unavailable: boolean;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function comp(partial: Omit<CircuitComponent, "pins"> & { pins?: never }, pins: CircuitComponentPin[]): CircuitComponent {
  return { illustration: COMPONENT_ILLUSTRATION[partial.kind], ...partial, pins };
}

function leftPin(id: string, label: string, row: number, domain: "control" | "load"): CircuitComponentPin {
  return { id, label, edge: "left", domain, row };
}
function rightPin(id: string, label: string, row: number, domain: "control" | "load"): CircuitComponentPin {
  return { id, label, edge: "right", domain, row };
}
function topPin(id: string, label: string, domain: "control" | "load"): CircuitComponentPin {
  return { id, label, edge: "top", domain, row: 0 };
}
function bottomPin(id: string, label: string, domain: "control" | "load"): CircuitComponentPin {
  return { id, label, edge: "bottom", domain, row: 0 };
}

/** Default illustration per component kind; overridden for appliance loads. */
const COMPONENT_ILLUSTRATION: Record<CircuitComponentKind, string> = {
  npn_transistor: "npn",
  mosfet_logic: "mosfet",
  flyback_diode: "diode",
  series_resistor: "resistor",
  pull_up_resistor: "resistor",
  base_resistor: "resistor",
  external_psu: "psu",
  ac_mains: "ac_mains",
  appliance_load: "appliance",
  led_strip: "led_strip",
  onboard_relay: "relay",
  level_shifter: "shifter",
  voltage_divider: "divider",
};

/** Which illustration best represents the switched mains load. */
export function applianceIllustration(deviceType: string | null): string {
  switch (deviceType) {
    case "fan": return "fan";
    case "light": return "bulb";
    case "tv": return "tv";
    default: return "appliance";
  }
}

let wireCounter = 0;
const wireId = () => `circ-${(wireCounter += 1)}`;

function wire(
  from: CircuitEndpointRef,
  to: CircuitEndpointRef,
  label: string,
  kind: CircuitWireKind,
  domain: CircuitWireDomain,
  description: string,
  documented: boolean,
  warnings?: string[]
): CircuitWire {
  return { id: wireId(), from, to, label, kind, domain, description, documented, ...(warnings && warnings.length > 0 ? { warnings } : {}) };
}

const gpioRef = (
  pin: number | null,
  headerKey: string | null,
  label: string,
  extraPadName: string | null = null
): CircuitEndpointRef => ({
  type: "gpio",
  pin,
  headerKey,
  extraPadName,
  label,
});

/** Endpoint for the entity's control GPIO (header or extra-pad anchored). */
const gpioEP = (args: ArchetypeArgs): CircuitEndpointRef =>
  gpioRef(args.gpio.pin, args.gpio.headerKey, args.gpioLabel, args.gpio.extraPadName);

/** Board ground rail endpoint (header pad or back pad), when documented. */
function groundRailEndpoint(ctx: CircuitDesignContext): CircuitEndpointRef | null {
  const rail = ctx.rails.ground;
  if (!rail) return null;
  if (rail.headerKey) {
    return gpioRef(null, rail.headerKey, rail.label);
  }
  if (rail.extraPadName) {
    return gpioRef(null, null, rail.label, rail.extraPadName);
  }
  return null;
}
const compRef = (componentId: string, pinId: string): CircuitEndpointRef => ({
  type: "component",
  componentId,
  pinId,
});
const termRef = (terminalId: string): CircuitEndpointRef => ({
  type: "device_terminal",
  terminalId,
});

// ---------------------------------------------------------------------------
// Shared check building blocks
// ---------------------------------------------------------------------------
function ratingsCheck(): CircuitCheck {
  return {
    id: "module-ratings",
    status: "unknown",
    title: "Module ratings not documented",
    detail:
      "HomecoreOS stores no voltage, current or power ratings for this module class. Verify V, I and P against the module's datasheet before wiring.",
  };
}

function loadRatingCheck(loadLabel: string): CircuitCheck {
  return {
    id: "load-rating",
    status: "unknown",
    title: `Load rating unknown (${loadLabel})`,
    detail:
      "The load being switched is not recorded in HomecoreOS. Confirm its voltage, current and power, and choose a switching device rated for at least that — with margin.",
  };
}

function commonGroundCheck(): CircuitCheck {
  return {
    id: "common-ground",
    status: "pass",
    title: "Common ground between control sides",
    detail:
      "The external supply's 0V/negative is tied to the controller GND so the gate/base drive has a reference. Keep mains-side wiring strictly separate.",
  };
}

function isolationCheck(): CircuitCheck {
  return {
    id: "isolation",
    status: "pass",
    title: "Galvanic isolation present",
    detail:
      "The isolated relay stage separates the low-voltage logic from the mains load. Maintain creepage/clearance distances on the load side.",
  };
}

function mainsQualifiedCheck(): CircuitCheck {
  return {
    id: "mains-qualified",
    status: "warn",
    title: "Mains AC — qualified installer required",
    detail:
      "Load-side wiring is MAINS AC. De-energize the circuit, use an appropriately rated enclosure and cable, and consult a qualified electrician where local code requires one.",
  };
}

function neverGpioMainsCheck(): CircuitCheck {
  return {
    id: "never-gpio-mains",
    status: "pass",
    title: "Mains is not connected to the GPIO",
    detail:
      "The GPIO only drives the isolated stage's control input (3.3V logic). Mains exists exclusively on the load side of the relay.",
  };
}

// ---------------------------------------------------------------------------
// Archetype inputs — small facts the caller resolves
// ---------------------------------------------------------------------------
interface ResolvedGpio {
  /** Header key of the control pad, or null when it is off-layout/extra-pad. */
  headerKey: string | null;
  extraPadName: string | null;
  pin: number | null;
}

interface ArchetypeArgs {
  ctx: CircuitDesignContext;
  gpio: ResolvedGpio;
  gpioLabel: string;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
export function buildCircuitDesign(ctx: CircuitDesignContext): CircuitDesign {
  wireCounter = 0;
  const entity = ctx.entity;

  if (ctx.unavailable) {
    return {
      state: "unavailable",
      archetype: "unavailable",
      archetypeLabel: "Connection information unavailable",
      reasoning: [],
      safetyClass: "unknown",
      mainsInvolved: false,
      externalSupplyRequired: false,
      isolatedFromLoad: false,
      components: [],
      wires: [],
      checks: [],
      assumptions: [],
      missingSpecifications: [],
      formulas: [],
      notes: [],
    };
  }

  const gpio: ResolvedGpio = {
    pin: ctx.signalPin,
    headerKey: ctx.gpioHeaderKey,
    extraPadName: ctx.gpioExtraPadName,
  };
  const gpioLabel =
    ctx.signalPin !== null ? `GPIO${ctx.signalPin}` : "Assigned GPIO";

  const args: ArchetypeArgs = { ctx, gpio, gpioLabel };

  const archetype = pickArchetype(entity);
  const design = buildForArchetype(archetype, args);

  // Mark drawn flags on load terminals that received wires.
  const drawnTerminalIds = new Set(
    design.wires
      .flatMap((w) => [w.from, w.to])
      .filter((e): e is Extract<CircuitEndpointRef, { type: "device_terminal" }> => e.type === "device_terminal")
      .map((e) => e.terminalId)
  );
  for (const terminal of ctx.terminals) {
    if (drawnTerminalIds.has(terminal.id)) terminal.drawn = true;
  }

  return design;
}

function pickArchetype(entity: WireDiagramEntityInput): string {
  if (entity.kind === "switch") {
    // External switching stage by default; on-board channels are detected in
    // buildForArchetype via ctx.onboardFeature.
    return "relay_switched_load_mains";
  }
  if (entity.kind === "device") {
    switch (entity.deviceType as SupportedDeviceType) {
      case "relay":
      case "light":
      case "fan":
      case "tv":
        return "relay_switched_load_mains";
      case "dimmer_pwm":
        return "pwm_dimmer_low_voltage";
      case "lock":
      case "valve":
        return "solenoid_low_side_driver";
      case "buzzer":
        return "npn_low_side_driver";
      case "status_led":
        return "led_series_resistor";
      default:
        return "generic_direct";
    }
  }
  // Sensors follow their driver interface.
  const sensorType = entity.sensorType as SupportedSensorType | null;
  switch (sensorType) {
    case "temperature_dht22":
    case "humidity_dht22":
    case "temperature_ds18b20":
      return "single_wire_pullup";
    case "temperature_bme280":
    case "humidity_bme280":
    case "pressure_bme280":
    case "light_bh1750":
      return "i2c_module";
    case "motion_pir":
      return "pir_three_wire";
    case "contact_reed":
      return "contact_two_wire";
    case "analog_voltage":
      return "adc_divider_advisory";
    default:
      return "generic_direct";
  }
}

function buildForArchetype(archetype: string, args: ArchetypeArgs): CircuitDesign {
  const { ctx } = args;
  const entity = ctx.entity;

  // Switches need the on-board/off-board split before choosing.
  if (entity.kind === "switch") {
    if (ctx.onboardFeature?.kind === "relay") {
      return onboardRelayMains(args);
    }
    if (ctx.onboardFeature?.kind === "buzzer") {
      return onboardPeripheral(args, "On-board buzzer");
    }
    if (ctx.onboardFeature) {
      return onboardPeripheral(args, ctx.onboardFeature.label);
    }
    return relaySwitchedLoadMains(args);
  }

  // Devices whose configured pin drives an on-board stage.
  if (ctx.onboardFeature?.kind === "relay") {
    return onboardRelayMains(args);
  }
  if (ctx.onboardFeature?.kind === "buzzer" && entity.deviceType === "buzzer") {
    return onboardPeripheral(args, "On-board buzzer");
  }

  switch (archetype) {
    case "relay_switched_load_mains":
      return relaySwitchedLoadMains(args);
    case "pwm_dimmer_low_voltage":
      return pwmDimmerLowVoltage(args);
    case "solenoid_low_side_driver":
      return solenoidDriver(args);
    case "npn_low_side_driver":
      return npnDriver(args);
    case "led_series_resistor":
      return ledSeriesResistor(args);
    case "single_wire_pullup":
      return singleWirePullup(args);
    case "i2c_module":
      return i2cModule(args);
    case "pir_three_wire":
      return pirThreeWire(args);
    case "contact_two_wire":
      return contactTwoWire(args);
    case "adc_divider_advisory":
      return adcDividerAdvisory(args);
    default:
      return genericDirect(args);
  }
}

// ---------------------------------------------------------------------------
// A / B — Relay-switched (mains) loads
// ---------------------------------------------------------------------------
function relaySwitchedLoadMains(args: ArchetypeArgs): CircuitDesign {
  const { ctx } = args;
  const entityLabel =
    ctx.entity.kind === "switch"
      ? `relay switch channel`
      : `relay / switching module`;
  const applianceLabel =
    ctx.entity.deviceType === "fan"
      ? "Fan (example load)"
      : ctx.entity.deviceType === "tv"
        ? "Outlet / TV (example load)"
        : ctx.entity.deviceType === "light"
          ? "Lamp (example load)"
          : "Appliance (example load)";

  const acId = "c-ac-source";
  const loadId = "c-appliance";

  const components: CircuitComponent[] = [
    comp(
      {
        id: acId,
        kind: "ac_mains",
        label: "AC MAINS SUPPLY",
        value: null,
        valueStatus: "not_documented",
        role: "Load-side energy source (mains)",
        certainty: "required",
        side: "load",
        notes: [
          "Mains voltage is not recorded in HomecoreOS.",
          "De-energize before wiring. Follow local electrical code.",
        ],
      },
      [
        rightPin("L", "L (Live)", 0, "load"),
        rightPin("N", "N (Neutral)", 1, "load"),
      ]
    ),
    comp(
      {
        id: loadId,
        kind: "appliance_load",
        illustration: applianceIllustration(ctx.entity.deviceType ?? null),
        label: applianceLabel,
        value: null,
        valueStatus: "not_documented",
        role: "The load being switched (not an entity)",
        certainty: "required",
        side: "load",
        notes: [
          "Example load — replace with your actual appliance.",
          "Rating not documented in HomecoreOS.",
        ],
      },
      [
        leftPin("L", "L", 0, "load"),
        leftPin("N", "N", 1, "load"),
      ]
    ),
  ];

  const wires: CircuitWire[] = [
    wire(
      compRef(acId, "L"),
      termRef("com"),
      "L → COM",
      "ac_live",
      "load",
      `Mains Live feeds the relay's common (COM) contact.`,
      false,
      ["MAINS AC — rated enclosure, strain relief and cable required."]
    ),
    wire(
      termRef("no"),
      compRef(loadId, "L"),
      "NO → L",
      "ac_live",
      "load",
      "The normally-open contact feeds the load when the relay energizes.",
      false
    ),
    wire(
      compRef(acId, "N"),
      compRef(loadId, "N"),
      "N → N",
      "ac_neutral",
      "load",
      "Neutral runs directly to the load — it never passes through the controller.",
      false
    ),
  ];

  return {
    state: "ready",
    archetype: "relay_switched_load_mains",
    archetypeLabel: "Isolated relay-switched mains load",
    reasoning: [
      `This ${entityLabel} switches an external load rather than being driven by the GPIO directly.`,
      "A GPIO delivers milliamps at 3.3V — far below what any mains or motor load needs — so the GPIO only drives the relay's isolated control input.",
      "The relay module provides the galvanic barrier between the 3.3V logic and the mains wiring; its COM/NO contacts sit entirely on the load side.",
      "The relay's coil supply and the mains branch are separate domains: low-voltage logic on one side, mains on the other.",
    ],
    safetyClass: "mains_ac",
    mainsInvolved: true,
    externalSupplyRequired: false,
    isolatedFromLoad: true,
    components,
    wires,
    checks: [
      neverGpioMainsCheck(),
      isolationCheck(),
      mainsQualifiedCheck(),
      loadRatingCheck("mains appliance"),
      ratingsCheck(),
      {
        id: "relay-contact-rating",
        status: "unknown",
        title: "Relay contact rating unknown",
        detail:
          "HomecoreOS does not document the contact rating of this relay channel. Inductive loads (motors, compressors) need substantially derated contacts or a contactor/RC snubber.",
      },
      {
        id: "snubber",
        status: "warn",
        title: "Consider a flyback/snubber for inductive loads",
        detail:
          "Fans, pumps and solenoid valves kick back voltage when switched. A snubber across the contacts (or an RC/MOV network) extends relay life — see the relay datasheet.",
      },
      {
        id: "dc-alternative",
        status: "unknown",
        title: "Load type assumed to be mains AC",
        detail:
          "If this load is actually low-voltage DC, the correct circuit is a logic-level MOSFET low-side driver with a flyback diode — not a relay module. Confirm the load type.",
      },
    ],
    assumptions: [
      "The load is a mains AC branch (typical switched lighting / outlet / appliance).",
      "The relay module provides opto-isolation between its control input and its contacts (typical for 1-channel relay modules — verify the module).",
      "Mains wiring will be installed by someone qualified under local electrical code.",
    ],
    missingSpecifications: [
      "Mains voltage and branch current rating",
      "Relay contact voltage/current/power rating (incl. inductive derating)",
      "Appliance load ratings (V, A, W, inrush)",
      "Cable cross-section and insulation rating",
      "Relay coil current and module VCC requirement",
    ],
    formulas: [
      {
        title: "Isolation boundary",
        body: "Logic side: GPIO → IN (3.3V, mA). Load side: L → COM → NO → appliance → N. Never bridge the two sides.",
      },
      {
        title: "Contact selection",
        body: "Contact rating (V, A) ≥ load (V, A) × safety margin. Inductive AC loads: derate by ≥ 2–3× or add an RC snubber (e.g. 100 Ω + 100 nF X2) across the contacts.",
      },
    ],
    notes: [
      "NC (normally closed) is intentionally left unwired — wire through NC instead of NO if the load must be energized until the relay fires.",
      "Keep the load-side conductors physically separated from the low-voltage logic side.",
      "For a low-voltage DC motor instead of a mains load, use a logic-level MOSFET low-side driver with a flyback diode across the motor.",
    ],
  };
}

function onboardRelayMains(args: ArchetypeArgs): CircuitDesign {
  const { ctx } = args;
  const featureLabel = ctx.onboardFeature?.label ?? "On-board relay";
  const boardLabel = ctx.boardModel ?? "this board";

  const junctionId = "c-onboard-relay";
  const acId = "c-ac-source";
  const loadId = "c-appliance";

  const components: CircuitComponent[] = [
    comp(
      {
        id: junctionId,
        kind: "onboard_relay",
        label: `${featureLabel.toUpperCase()} (ON-BOARD)`,
        value: null,
        valueStatus: "not_documented",
        role: `Screw terminals of ${featureLabel} on ${boardLabel}`,
        certainty: "required",
        side: "load",
        notes: [
          "Screw positions are not mapped in the board profile — see the silkscreen.",
          "Isolation barrier lives inside this relay.",
        ],
      },
      [
        rightPin("COM", "COM", 0, "load"),
        rightPin("NO", "NO", 1, "load"),
        rightPin("NC", "NC", 2, "load"),
      ]
    ),
    comp(
      {
        id: acId,
        kind: "ac_mains",
        label: "AC MAINS SUPPLY",
        value: null,
        valueStatus: "not_documented",
        role: "Load-side energy source (mains)",
        certainty: "required",
        side: "load",
        notes: [
          "Mains voltage is not recorded in HomecoreOS.",
          "De-energize before wiring. Follow local electrical code.",
        ],
      },
      [
        rightPin("L", "L (Live)", 0, "load"),
        rightPin("N", "N (Neutral)", 1, "load"),
      ]
    ),
    comp(
      {
        id: loadId,
        kind: "appliance_load",
        illustration: applianceIllustration(ctx.entity.deviceType ?? null),
        label: "Appliance (example load)",
        value: null,
        valueStatus: "not_documented",
        role: "The load being switched (not an entity)",
        certainty: "required",
        side: "load",
        notes: [
          "Example load — replace with your actual appliance.",
          "Rating not documented in HomecoreOS.",
        ],
      },
      [
        leftPin("L", "L", 0, "load"),
        leftPin("N", "N", 1, "load"),
      ]
    ),
  ];

  const wires: CircuitWire[] = [
    wire(
      compRef(acId, "L"),
      compRef(junctionId, "COM"),
      "L → COM",
      "ac_live",
      "load",
      "Mains Live feeds the on-board relay's common contact.",
      false,
      ["MAINS AC — rated enclosure, strain relief and cable required."]
    ),
    wire(
      compRef(junctionId, "NO"),
      compRef(loadId, "L"),
      "NO → L",
      "ac_live",
      "load",
      "The normally-open screw feeds the load when the channel energizes.",
      false
    ),
    wire(
      compRef(acId, "N"),
      compRef(loadId, "N"),
      "N → N",
      "ac_neutral",
      "load",
      "Neutral runs directly to the load — it never passes through the controller.",
      false
    ),
  ];

  return {
    state: "ready",
    archetype: "onboard_relay_mains",
    archetypeLabel: `On-board relay switching a mains load (${featureLabel})`,
    reasoning: [
      `This channel is hardwired on ${boardLabel} to ${featureLabel} — the relay and its driver already exist on the PCB.`,
      "No external control wiring is required: firmware holds the GPIO, the board does the switching.",
      "The load side is a separate isolated domain: mains enters at the relay screws and never touches the logic side.",
      "The example mains branch below is what a typical installation looks like; the exact load is not recorded in HomecoreOS.",
    ],
    safetyClass: "mains_ac",
    mainsInvolved: true,
    externalSupplyRequired: false,
    isolatedFromLoad: true,
    components,
    wires,
    checks: [
      neverGpioMainsCheck(),
      isolationCheck(),
      mainsQualifiedCheck(),
      loadRatingCheck("mains appliance"),
      {
        id: "onboard-rating",
        status: "unknown",
        title: `Load rating vs ${featureLabel} unknown`,
        detail:
          "HomecoreOS records which GPIO feeds the relay, not the relay's contact rating. Check the board documentation for the maximum switched load and inductive derating.",
      },
      {
        id: "snubber",
        status: "warn",
        title: "Consider a snubber for inductive loads",
        detail:
          "Motors and compressors stress relay contacts — an RC snubber across COM/NO extends life.",
      },
    ],
    assumptions: [
      "The load is a mains AC branch.",
      "The on-board relay is rated by the board vendor for the intended load — verify in the board documentation.",
    ],
    missingSpecifications: [
      "Mains voltage and branch current",
      `${featureLabel} contact rating (V, A, inductive derating)`,
      "Appliance load ratings (V, A, W, inrush)",
      "Cable and enclosure ratings",
    ],
    formulas: [
      {
        title: "Isolation boundary",
        body: "Logic side: GPIO — nothing else. Load side: L → COM → NO → appliance → N. The PCB relay is the only bridge.",
      },
    ],
    notes: [
      "NC is shown unwired. Use NC instead of NO only if the load must stay energized until the channel fires.",
      "HomecoreOS never covers mains wiring work — involve a qualified electrician.",
    ],
  };
}

function onboardPeripheral(args: ArchetypeArgs, label: string): CircuitDesign {
  const { ctx } = args;
  return {
    state: "ready",
    archetype: "onboard_peripheral",
    archetypeLabel: `On-board peripheral (${label})`,
    reasoning: [
      `This channel drives ${label}, which is wired on the PCB itself.`,
      "No external stage, components or supplies are needed beyond the board.",
      "Load-side wiring (for a relay) or acoustic output (for a buzzer) is board-specific — see the board documentation.",
    ],
    safetyClass: "low_voltage_dc",
    mainsInvolved: false,
    externalSupplyRequired: false,
    isolatedFromLoad: true,
    components: [],
    wires: [],
    checks: [
      {
        id: "onboard",
        status: "pass",
        title: "No external components required",
        detail:
          "The output stage is integrated on the board. External circuitry would duplicate it.",
      },
      ratingsCheck(),
    ],
    assumptions: [],
    missingSpecifications: [`${label} ratings and wiring from the board documentation`],
    formulas: [],
    notes: [
      `GPIO wiring for the control leg is not shown — the on-board stage replaces it.`,
      ...(ctx.onboardFeature?.kind === "buzzer"
        ? ["Passive buzzers need a tone in firmware; active buzzers sound from a steady level."]
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// C — PWM dimmer (low-voltage LED strip)
// ---------------------------------------------------------------------------
function pwmDimmerLowVoltage(_args: ArchetypeArgs): CircuitDesign {
  const psuId = "c-psu";
  const stripId = "c-led-strip";

  const components: CircuitComponent[] = [
    comp(
      {
        id: psuId,
        kind: "external_psu",
        label: "EXTERNAL PSU (12/24 V)",
        value: null,
        valueStatus: "not_documented",
        role: "Powers the LED strip / dimmer module",
        certainty: "required",
        side: "load",
        notes: [
          "Match the PSU voltage to the strip — commonly 12 V or 24 V.",
          "Size the PSU for the strip's W per meter × length, with ≥ 20% margin.",
        ],
      },
      [
        rightPin("V+", "V+ (+)", 0, "load"),
        rightPin("V0", "0V (−)", 1, "load"),
      ]
    ),
    comp(
      {
        id: stripId,
        kind: "led_strip",
        label: "LED STRIP (example)",
        value: null,
        valueStatus: "not_documented",
        role: "The load being dimmed (not an entity)",
        certainty: "required",
        side: "load",
        notes: [
          "Example load — replace with your actual strip/fixture.",
          "Strip voltage and wattage are not documented.",
        ],
      },
      [
        leftPin("P", "+ (V+)", 0, "load"),
        leftPin("M", "− (PWM sink)", 1, "load"),
      ]
    ),
  ];

  const wires: CircuitWire[] = [
    wire(
      compRef(psuId, "V+"),
      termRef("vcc"),
      "V+ → VCC",
      "power_dc",
      "load",
      "PSU positive feeds the dimmer module's supply pin.",
      false
    ),
    wire(
      compRef(psuId, "V+"),
      compRef(stripId, "P"),
      "V+ → strip +",
      "power_dc",
      "load",
      "PSU positive feeds the LED strip common anode/plus rail.",
      false
    ),
    wire(
      compRef(stripId, "M"),
      termRef("out"),
      "strip − → OUT",
      "power_dc",
      "load",
      "The strip's negative returns through the dimmer's PWM-switched output (typical low-side PWM dimming).",
      false
    ),
    wire(
      compRef(psuId, "V0"),
      termRef("gnd"),
      "0V → GND",
      "ground",
      "control",
      "PSU 0V ties to controller GND so the PWM signal has a reference.",
      false
    ),
  ];

  return {
    state: "ready",
    archetype: "pwm_dimmer_low_voltage",
    archetypeLabel: "Logic-level PWM dimmer, low-voltage LED load",
    reasoning: [
      "A PWM GPIO drives the dimmer module's logic input — the GPIO never carries load current.",
      "The module contains the power stage (MOSFET or constant-current driver) that actually switches the strip.",
      "An external supply is required: the board's 3.3V logic rail cannot power an LED strip.",
      "The example wiring below is the standard low-side PWM pattern: V+ to the strip, strip − through the dimmer's OUT, common 0V/GND reference.",
    ],
    safetyClass: "low_voltage_dc",
    mainsInvolved: false,
    externalSupplyRequired: true,
    isolatedFromLoad: false,
    components,
    wires,
    checks: [
      {
        id: "logic-only-gpio",
        status: "pass",
        title: "GPIO carries logic-level PWM only",
        detail:
          "The GPIO sources the PWM control signal (3.3V, milliamps). The strip current flows through the dimmer module's output stage and the PSU — not through the GPIO.",
      },
      {
        id: "pwm-capable",
        status: "pass",
        title: "GPIO capability checked",
        detail:
          "PWM capability of the configured pin is validated by the board pin checks above.",
      },
      {
        id: "psu-sizing",
        status: "unknown",
        title: "PSU sizing cannot be verified",
        detail:
          "HomecoreOS does not know the strip's wattage. Size the PSU for (W/m × metres) with ≥ 20% headroom, and confirm the dimmer's maximum current.",
      },
      {
        id: "mains-dimmer",
        status: "warn",
        title: "Mains-dimmed loads are a different circuit",
        detail:
          "If this 'dimmer' actually dims a mains trailing-edge fixture, it needs an opto-isolated TRIAC/phase-cut dimmer module — never a low-voltage MOSFET stage. Confirm before wiring.",
      },
      ratingsCheck(),
    ],
    assumptions: [
      "The load is a low-voltage DC LED strip (12 V or 24 V) — the usual meaning of a PWM dimmer channel.",
      "The dimmer module switches the low side (−) of the strip, which is typical.",
      "The PSU voltage matches both the strip and the dimmer module's input rating.",
    ],
    missingSpecifications: [
      "LED strip voltage (12 V / 24 V) and wattage per metre / total length",
      "Dimmer module input voltage range and max output current",
      "PSU wattage and required margin",
      "Strip inrush current at switch-on",
    ],
    formulas: [
      {
        title: "Current check (must hold)",
        body: "I_strip = P_strip / V_PSU. Verify I_strip ≤ I_dimmer(max) and I_strip ≤ I_PSU(rated) with ≥ 20% margin.",
      },
      {
        title: "PWM duty → brightness",
        body: "Average LED current ≈ duty × I_strip. HomecoreOS does not calibrate firmware duty against actual lumens — tune per fixture.",
      },
    ],
    notes: [
      "Common ground between the PSU and the controller is mandatory — without it the PWM input floats.",
      "Long thin PSU/strip cables lose voltage; keep runs short or upsize the wire.",
      "For mains TRIAC dimmers, treat the wiring as mains AC: opto-isolated module, rated enclosure, qualified installer.",
    ],
  };
}

// ---------------------------------------------------------------------------
// C2 — Solenoid loads (lock / valve) — low-side MOSFET + flyback
// ---------------------------------------------------------------------------
function solenoidDriver(args: ArchetypeArgs): CircuitDesign {
  const { ctx } = args;
  const entityLabel = ctx.entity.deviceType === "lock" ? "lock" : "valve";
  const mosfetId = "c-mosfet";
  const gateId = "c-gate-r";
  const flybackId = "c-flyback";
  const psuId = "c-psu";

  const components: CircuitComponent[] = [
    comp(
      {
        id: psuId,
        kind: "external_psu",
        label: "EXTERNAL PSU (12 V typ.)",
        value: null,
        valueStatus: "not_documented",
        role: `Powers the ${entityLabel} solenoid`,
        certainty: "required",
        side: "load",
        notes: [
          "Typical solenoids run 12 V or 24 V DC — check the nameplate.",
          "Size for the solenoid's holding/inrush current with margin.",
        ],
      },
      [
        rightPin("V+", "V+ (+)", 0, "load"),
        rightPin("V0", "0V (−)", 1, "load"),
      ]
    ),
    comp(
      {
        id: gateId,
        kind: "base_resistor",
        label: "R1 — GATE RESISTOR, 220 Ω",
        value: "220 Ω",
        valueStatus: "guidance",
        role: "Limits GPIO peak current into the gate",
        certainty: "required",
        side: "control",
        notes: [
          "Guidance value; 100–470 Ω is typical. Limits edge-rate current.",
        ],
      },
      [
        leftPin("A", "A (GPIO side)", 0, "control"),
        bottomPin("B", "B (gate side)", "control"),
      ]
    ),
    comp(
      {
        id: mosfetId,
        kind: "mosfet_logic",
        label: "Q1 — N-CHANNEL MOSFET (logic level)",
        value: null,
        valueStatus: "not_documented",
        role: "Low-side power switch for the coil",
        certainty: "required",
        side: "load",
        notes: [
          "Pick logic-level gate: V_GS(th) ≤ 2.5 V, R_DS(on) low at 2.7 V.",
          "V_DS ≥ 2× coil voltage; I_D ≥ coil current.",
          "10 kΩ gate-to-0V pull-down keeps the coil off during reset.",
        ],
      },
      [
        topPin("G", "Gate", "control"),
        rightPin("S", "Source", 1, "load"),
        rightPin("D", "Drain", 0, "load"),
      ]
    ),
    comp(
      {
        id: flybackId,
        kind: "flyback_diode",
        label: "D1 — FLYBACK DIODE (1N4007-class)",
        value: "1 A / V_R ≥ coil V",
        valueStatus: "guidance",
        role: "Clamps the coil's inductive kick at switch-off",
        certainty: "required",
        side: "load",
        notes: [
          "Cathode (striped end) to the coil's + side.",
          "Required — without it the MOSFET is destroyed on switch-off.",
        ],
      },
      [
        rightPin("A", "Anode (− side of coil)", 1, "load"),
        rightPin("K", "Cathode (+ side of coil)", 0, "load"),
      ]
    ),
  ];

  const groundEP = groundRailEndpoint(args.ctx);
  const wires: CircuitWire[] = [
    wire(
      gpioEP(args),
      compRef(gateId, "A"),
      `${args.gpioLabel} → R1`,
      "control",
      "control",
      "The configured GPIO drives the base/gate resistor.",
      true
    ),
    wire(
      compRef(gateId, "B"),
      compRef(mosfetId, "G"),
      "R1 → Gate",
      "control",
      "control",
      "Current-limited gate drive for the MOSFET.",
      false
    ),
    wire(
      compRef(mosfetId, "S"),
      compRef(psuId, "V0"),
      "Source → 0V",
      "ground",
      "load",
      "Source returns to PSU 0V — the low side of the coil circuit.",
      false
    ),
    ...(groundEP
      ? [
          wire(
            compRef(psuId, "V0"),
            groundEP,
            "0V → GND",
            "ground",
            "control",
            "Common reference between PSU and controller — required for the gate drive to work.",
            true
          ),
        ]
      : []),
    wire(
      compRef(psuId, "V+"),
      termRef("sp"),
      "V+ → S+",
      "power_dc",
      "load",
      "PSU positive feeds the solenoid's + terminal.",
      false
    ),
    wire(
      compRef(mosfetId, "D"),
      termRef("sm"),
      "Drain → S−",
      "power_dc",
      "load",
      "Switched low side: drain pulls the solenoid negative when the GPIO drives high.",
      false
    ),
    wire(
      compRef(flybackId, "K"),
      termRef("sp"),
      "D1 K → S+",
      "power_dc",
      "load",
      "Flyback cathode to coil positive — clamps the turn-off spike.",
      false
    ),
    wire(
      compRef(flybackId, "A"),
      termRef("sm"),
      "D1 A → S−",
      "power_dc",
      "load",
      "Flyback anode to coil negative — completes the clamp loop.",
      false
    ),
  ];

  return {
    state: "ready",
    archetype: "solenoid_low_side_driver",
    archetypeLabel: `Low-side MOSFET driver for a solenoid ${entityLabel}`,
    // The naive GPIO → S+ leg bypasses the driver and lands on the coil — drop it.
    replacesBaseLegs: ["sp"],
    reasoning: [
      `This ${entityLabel} is an inductive solenoid load — it needs far more current than a GPIO can source and kicks back voltage at switch-off.`,
      "A logic-level N-channel MOSFET switches the low side of the coil; the GPIO only drives the gate (microamps to milliamps).",
      "A flyback diode across the coil clamps the inductive spike — without it the MOSFET is destroyed on every switch-off.",
      "An external supply powers the coil — the board's 3.3V logic rail cannot hold a solenoid.",
      "Gate pull-down (10 kΩ) guarantees the load is off while the controller boots and pins float.",
    ],
    safetyClass: "low_voltage_dc",
    mainsInvolved: false,
    externalSupplyRequired: true,
    isolatedFromLoad: false,
    components,
    wires,
    checks: [
      {
        id: "gpio-gate-only",
        status: "pass",
        title: "GPIO drives the gate only",
        detail:
          "Gate current is limited by R1 to well within GPIO ratings — the coil's full operating current flows through Q1 and the PSU, never the GPIO.",
      },
      {
        id: "flyback-present",
        status: "pass",
        title: "Inductive kick clamped",
        detail:
          "D1 across the coil gives the inductive current a path at switch-off.",
      },
      {
        id: "coil-current",
        status: "unknown",
        title: "Coil current cannot be verified",
        detail:
          "HomecoreOS does not document the solenoid's resistance/current. Measure it or read the nameplate — the MOSFET and PSU must handle it with margin.",
      },
      {
        id: "mains-if-ac",
        status: "warn",
        title: "If the coil is AC-mains, this is the wrong circuit",
        detail:
          "AC solenoids must be switched by a relay/contactor rated for the load — never MOSFETs or GPIOs. Confirm the coil supply type.",
      },
      groundEP
        ? commonGroundCheck()
        : {
            id: "common-ground",
            status: "warn" as const,
            title: "Controller ground reference not documented",
            detail:
              "The board profile documents no ground pad. Tie the PSU 0V to the controller's GND pin manually — the gate drive has no reference without it.",
          },
      ratingsCheck(),
    ],
    assumptions: [
      "The load is a low-voltage DC solenoid (commonly 12 V or 24 V) — typical for electric strikes and water/gas valves.",
      "The MOSFET is a generic logic-level N-channel part; specific part selection (IRLZ44N, AO3400, …) depends on coil current.",
      "D1 rating (guidance: 1 A, V_R ≥ coil voltage) matches the coil.",
    ],
    missingSpecifications: [
      "Solenoid rated voltage (12 / 24 V) and coil resistance / current",
      "Duty cycle (intermittent vs continuous) and thermal limits",
      "Inrush vs holding current",
      "Connector pinout of the specific strike/valve",
      ...(groundEP ? [] : ["Board ground pad for the common 0V tie"]),
    ],
    formulas: [
      {
        title: "Coil current",
        body: "I_coil = V_coil / R_coil. Required: I_coil × 1.25 ≤ I_D(mosfet, derated) and ≤ I_PSU rated.",
      },
      {
        title: "Flyback sizing",
        body: "D1: I_F ≥ I_coil; V_R ≥ 2 × V_coil. 1N4007 (1 A, 1000 V) covers typical 12/24 V solenoids.",
      },
      {
        title: "Power dissipated in Q1",
        body: "P_Q1 ≈ I_coil² × R_DS(on). For logic-level parts (R_DS(on) < 50 mΩ) this is milliwatts — no heatsink needed at these currents.",
      },
    ],
    notes: [
      "Add a 10 kΩ gate-to-0V pull-down if not already present — it guarantees the load stays off during boot/reset.",
      "Route the coil loop away from the sensor wiring; switching transients corrupt I2C.",
      "For mains AC solenoids use the relay-switched circuit instead.",
    ],
  };
}

// ---------------------------------------------------------------------------
// E — Buzzer via NPN low-side driver
// ---------------------------------------------------------------------------
function npnDriver(args: ArchetypeArgs): CircuitDesign {
  const { ctx } = args;
  const npnId = "c-npn";
  const baseId = "c-base-r";
  const psuId = "c-psu";
  const boardHas5V = ctx.rails.fiveVolt !== null;
  const supplyComponentId = boardHas5V ? null : psuId;

  const components: CircuitComponent[] = [
    comp(
      {
        id: baseId,
        kind: "base_resistor",
        label: "R1 — BASE RESISTOR, 1 kΩ",
        value: "1 kΩ",
        valueStatus: "guidance",
        role: "Sets base current from the GPIO",
        certainty: "required",
        side: "control",
        notes: [
          "Guidance: 470 Ω–2.2 kΩ. Limits GPIO current to a few mA.",
        ],
      },
      [
        leftPin("A", "A (GPIO side)", 0, "control"),
        bottomPin("B", "B (base side)", "control"),
      ]
    ),
    comp(
      {
        id: npnId,
        kind: "npn_transistor",
        label: "Q1 — NPN (2N2222 / BC547-class)",
        value: null,
        valueStatus: "not_documented",
        role: "Low-side switch for the buzzer",
        certainty: "required",
        side: "control",
        notes: [
          "Any small-signal NPN works for typical ≤ 100 mA buzzers.",
          "Base driven via R1; emitter to GND.",
        ],
      },
      [
        topPin("B", "Base", "control"),
        rightPin("E", "Emitter", 1, "control"),
        rightPin("C", "Collector", 0, "control"),
      ]
    ),
  ];
  if (supplyComponentId) {
    components.push(
      comp(
        {
          id: psuId,
          kind: "external_psu",
          label: "EXTERNAL 5 V PSU",
          value: null,
          valueStatus: "not_documented",
          role: "Buzzer supply (board documents no 5V rail)",
          certainty: "required",
          side: "load",
          notes: ["Match the buzzer's rated voltage — 5 V is common for active buzzers."],
        },
        [
          rightPin("V+", "V+ (+5V)", 0, "load"),
          rightPin("V0", "0V (−)", 1, "load"),
        ]
      )
    );
  }

  const fiveVoltEndpoint: CircuitEndpointRef = boardHas5V
    ? {
        type: "gpio",
        pin: null,
        headerKey: ctx.rails.fiveVolt!.headerKey,
        extraPadName: ctx.rails.fiveVolt!.extraPadName ?? null,
        label: "5V rail (documented on board)",
      }
    : compRef(psuId, "V+");

  const wires: CircuitWire[] = [
    wire(
      gpioEP(args),
      compRef(baseId, "A"),
      `${args.gpioLabel} → R1`,
      "control",
      "control",
      "The GPIO feeds the base resistor.",
      true
    ),
    wire(
      compRef(baseId, "B"),
      compRef(npnId, "B"),
      "R1 → Base",
      "control",
      "control",
      "Current-limited base drive.",
      false
    ),
    wire(
      compRef(npnId, "C"),
      termRef("io"),
      "Collector → I/O",
      "control",
      "control",
      "The switched low side returns to the buzzer's I/O pin.",
      false
    ),
    wire(
      fiveVoltEndpoint,
      termRef("vcc"),
      boardHas5V ? "5V → VCC" : "PSU 5V → VCC",
      "power_dc",
      "load",
      boardHas5V
        ? "Board-documented 5V rail powers the buzzer."
        : "External 5V supply powers the buzzer — the board does not document a 5V rail.",
      boardHas5V
    ),
    wire(
      compRef(npnId, "E"),
      termRef("gnd"),
      "Emitter → GND",
      "ground",
      "control",
      "Emitter returns current to ground/common.",
      false
    ),
  ];
  if (!boardHas5V) {
    wires.push(
      wire(
        compRef(psuId, "V0"),
        termRef("gnd"),
        "PSU 0V → GND",
        "ground",
        "control",
        "Common reference between PSU and controller.",
        false
      )
    );
  }

  return {
    state: "ready",
    archetype: "npn_low_side_driver",
    archetypeLabel: "NPN low-side driver (buzzer)",
    reasoning: [
      "Active buzzers typically draw more than a GPIO budget (≈ 12–20 mA) and inductive 'magnetic' buzzers kick back voltage.",
      "An NPN low-side switch lets the GPIO drive the buzzer with milliamps of base current.",
      boardHas5V
        ? "The board documents a 5V rail, which powers the buzzer directly."
        : "The board documents no 5V rail, so an external 5V supply is shown — check your buzzer's rated voltage.",
    ],
    safetyClass: "low_voltage_dc",
    mainsInvolved: false,
    externalSupplyRequired: !boardHas5V,
    isolatedFromLoad: false,
    components,
    wires,
    replacesBaseLegs: ["io"],
    checks: [
      {
        id: "gpio-base-only",
        status: "pass",
        title: "GPIO drives the base only",
        detail:
          "GPIO current is limited by R1 to a few mA — the buzzer's current flows through the transistor and the supply rail.",
      },
      {
        id: "buzzer-type",
        status: "unknown",
        title: "Buzzer type not documented",
        detail:
          "Active buzzers sound from a steady level; passive buzzers need a tone. Match the firmware to the module you wired.",
      },
      ...(boardHas5V
        ? [
            {
              id: "supply-documented",
              status: "pass" as CircuitCheckStatus,
              title: "5V rail documented on this board",
              detail: "The board profile documents a 5V pad — used for the buzzer supply.",
            },
          ]
        : [
            {
              id: "supply-missing",
              status: "warn" as CircuitCheckStatus,
              title: "No 5V rail on this board — external supply required",
              detail:
                "Wire the buzzer from an external 5V supply with common 0V to controller GND, or verify the buzzer works at 3.3V.",
            },
          ]),
      {
        id: "low-current-alternative",
        status: "unknown",
        title: "Direct drive possible only for very low-current buzzers",
        detail:
          "If the buzzer's datasheet shows ≤ 10 mA at 3.3V it may be driven directly — HomecoreOS cannot verify this from the record.",
      },
      commonGroundCheck(),
      ratingsCheck(),
    ],
    assumptions: [
      "The buzzer is a 5 V active module (very common) — verify the nameplate.",
      "The 2N2222/BC547-class NPN is interchangeable guidance, not a mandated part.",
    ],
    missingSpecifications: [
      "Buzzer rated voltage and current",
      "Active vs passive construction",
      "Resonant frequency (for passive buzzers)",
    ],
    formulas: [
      {
        title: "Base current",
        body: "I_B ≈ (3.3 V − 0.7 V) / R1 ≈ 2.6 mA with R1 = 1 kΩ — comfortably inside GPIO limits.",
      },
    ],
    notes: [
      "Passive buzzers need a tone (PWM) in firmware; active buzzers need only a level.",
      "A magnetic (inductive) buzzer benefits from a small flyback diode across it.",
    ],
  };
}

// ---------------------------------------------------------------------------
// F — Status LED with series resistor
// ---------------------------------------------------------------------------
function ledSeriesResistor(args: ArchetypeArgs): CircuitDesign {
  const rId = "c-series-r";

  const components: CircuitComponent[] = [
    comp(
      {
        id: rId,
        kind: "series_resistor",
        label: "R1 — SERIES RESISTOR, 330 Ω",
        value: "330 Ω",
        valueStatus: "formula",
        role: "Current limit for the LED",
        certainty: "required",
        side: "control",
        notes: [
          "Computed for a generic red/green LED on 3.3V logic — see the formula.",
          "A direct GPIO→LED connection can destroy the GPIO.",
        ],
      },
      [
        leftPin("A", "A (GPIO side)", 0, "control"),
        rightPin("B", "B (anode side)", 0, "control"),
      ]
    ),
  ];

  const wires: CircuitWire[] = [
    wire(
      gpioEP(args),
      compRef(rId, "A"),
      `${args.gpioLabel} → R1`,
      "control",
      "control",
      "The GPIO feeds the series resistor — never the LED directly.",
      true
    ),
    wire(
      compRef(rId, "B"),
      termRef("a"),
      "R1 → A",
      "control",
      "control",
      "Current-limited drive to the LED anode.",
      false
    ),
  ];

  return {
    state: "ready",
    archetype: "led_series_resistor",
    archetypeLabel: "Status LED with series resistor",
    reasoning: [
      "An LED without a series resistor draws unbounded current and destroys the GPIO pin within seconds.",
      "The resistor sets the LED current from the GPIO's 3.3V level.",
      "The LED's forward voltage and desired current determine the exact value — the shown 330 Ω suits a generic indicator on 3.3V.",
    ],
    safetyClass: "low_voltage_dc",
    mainsInvolved: false,
    externalSupplyRequired: false,
    isolatedFromLoad: false,
    components,
    wires,
    replacesBaseLegs: ["a"],
    checks: [
      {
        id: "resistor-present",
        status: "pass",
        title: "Series resistor included",
        detail: "R1 between the GPIO and the LED anode.",
      },
      {
        id: "gpio-current",
        status: "pass",
        title: "GPIO current within limits",
        detail:
          "≈ 4 mA at 3.3V with a 330 Ω series resistor — safe for the GPIO.",
      },
      {
        id: "forward-voltage",
        status: "unknown",
        title: "LED forward voltage assumed",
        detail:
          "Vf ≈ 2.0 V assumed (typical red/green). Blue/white LEDs need Vf ≈ 3.0–3.3 V — recompute R or the LED will be dim.",
      },
      ratingsCheck(),
    ],
    assumptions: [
      "Generic indicator LED, Vf ≈ 2.0 V, target current ≈ 4 mA.",
      "3.3V GPIO logic.",
    ],
    missingSpecifications: [
      "Exact LED Vf at the intended current",
      "Whether the 'status LED' is a bare LED or an indicator module with on-board resistor",
    ],
    formulas: [
      {
        title: "Series resistor",
        body: "R = (V_GPIO − V_F) / I_F = (3.3 − 2.0) / 0.004 ≈ 325 Ω → standard 330 Ω (E12/E24).",
      },
      {
        title: "Verify against your LED",
        body: "Blue/white (V_F ≈ 3.1 V): R = (3.3 − 3.1) / 0.004 ≈ 50 Ω — 330 Ω would make it nearly dark.",
      },
    ],
    notes: [
      "If the LED is inside an indicator module with a built-in resistor, do not add R1 — check the module documentation.",
      "Cathode (K) returns to GND — the engine already draws that leg.",
    ],
  };
}

// ---------------------------------------------------------------------------
// G — Single-wire sensors (DHT22 / DS18B20) — pull-up
// ---------------------------------------------------------------------------
function singleWirePullup(args: ArchetypeArgs): CircuitDesign {
  const { ctx } = args;
  const isOneWire = ctx.sensorDriver?.interface === "onewire";
  const rId = "c-pullup";
  const ds18 = ctx.entity.sensorType === "temperature_ds18b20";

  const components: CircuitComponent[] = [
    comp(
      {
        id: rId,
        kind: "pull_up_resistor",
        label: "R1 — DATA PULL-UP, 4.7 kΩ",
        value: "4.7 kΩ",
        valueStatus: "guidance",
        role: "Pull-up on the open-drain data line",
        certainty: "required",
        side: "control",
        notes: [
          "Often mounted on the sensor module — check before adding.",
          "DHT22: 4.7 kΩ–10 kΩ. DS18B20: 4.7 kΩ typical.",
        ],
      },
      [
        rightPin("A", "A (data line)", 0, "control"),
        rightPin("B", "B (to VCC)", 1, "control"),
      ]
    ),
  ];

  // DHT22-class single-wire modules use DATA; DS18B20 uses DQ — resolve dynamically.
  const signalTerminalId =
    ctx.terminals.find((t) => t.role === "signal")?.id ?? "data";
  const wires: CircuitWire[] = [
    wire(
      compRef(rId, "A"),
      termRef(signalTerminalId),
      "R1 → DATA",
      "control",
      "control",
      "Pull-up taps the data line.",
      false
    ),
    wire(
      compRef(rId, "B"),
      termRef("vcc"),
      "R1 → VCC",
      "power_dc",
      "control",
      "Pull-up tops out at the module's supply rail.",
      false
    ),
  ];

  return {
    state: "ready",
    archetype: "single_wire_pullup",
    archetypeLabel: isOneWire ? "1-Wire bus with pull-up" : "Single-wire data line with pull-up",
    reasoning: [
      "The data line is open-drain: the sensor only pulls it low. Without a pull-up the high level never rises and the bus reads stuck-low.",
      "A 4.7 kΩ resistor to VCC restores the high level (guidance; many modules include it).",
      "The single-wire protocol is bidirectional — the same pin transmits commands and receives replies.",
    ],
    safetyClass: "low_voltage_dc",
    mainsInvolved: false,
    externalSupplyRequired: false,
    isolatedFromLoad: false,
    components,
    wires,
    checks: [
      {
        id: "pullup-present",
        status: "pass",
        title: "Required pull-up shown",
        detail:
          "R1 between data and VCC. If the module already includes it, leave it in place and omit the external one.",
      },
      {
        id: "bidirectional-pin",
        status: "pass",
        title: "Bidirectional GPIO required",
        detail:
          "The configured pin must support both input and output — validated in the pin checks above.",
      },
      {
        id: "module-pullup",
        status: "unknown",
        title: "On-module pull-up cannot be verified",
        detail:
          "HomecoreOS cannot see your module. If reads are flaky, measure the data line resistance to VCC — ~4.7k means it is already present.",
      },
      ratingsCheck(),
    ],
    assumptions: [
      ds18
        ? "DS18B20 powered from VCC (not parasitic mode) — parasitic mode needs stronger pull-up and different firmware."
        : "DHT22 powered from VCC/DATA as documented.",
      "Module may already include the pull-up — verify to avoid doubling it (paralleled pull-ups are usually harmless but halve the resistance).",
    ],
    missingSpecifications: [
      "Whether the module includes an on-board pull-up",
      "Maximum bus length / capacitance (affects pull-up value)",
      ...(ds18 ? ["Parasite vs external power mode"] : []),
    ],
    formulas: [
      {
        title: "Pull-up value",
        body: "R_pullup ≈ 4.7 kΩ. Too strong (small R) → wasted current; too weak (large R) → slow edges and read errors.",
      },
    ],
    notes: [
      "Total bus capacitance must stay low — keep leads short or add a small capacitor for supply decoupling.",
      "Only one sensor type per GPIO unless the firmware is written for bus-share.",
    ],
  };
}

// ---------------------------------------------------------------------------
// H — I2C module
// ---------------------------------------------------------------------------
function i2cModule(args: ArchetypeArgs): CircuitDesign {
  const { ctx } = args;
  const shifterId = "c-level-shifter";

  const components: CircuitComponent[] = [
    comp(
      {
        id: shifterId,
        kind: "level_shifter",
        label: "LOGIC LEVEL SHIFTER (conditional)",
        value: null,
        valueStatus: "not_documented",
        role: "ONLY if the module is 5 V-only",
        certainty: "conditional",
        side: "control",
        notes: [
          "3.3V modules: NOT needed — do not install.",
          "5V-only modules: bidirectional shifter on SDA and SCL is required.",
        ],
      },
      [
        leftPin("LV1", "LV1 → SDA", 0, "control"),
        leftPin("LV2", "LV2 → SCL", 1, "control"),
        rightPin("HV1", "HV1 → SDA (5V)", 0, "control"),
        rightPin("HV2", "HV2 → SCL (5V)", 1, "control"),
      ]
    ),
  ];

  return {
    state: "ready",
    archetype: "i2c_module",
    archetypeLabel: "I2C module on the controller's documented bus",
    reasoning: [
      "I2C is a shared two-wire open-drain bus: SDA and SCL carry every sensor on this controller together.",
      "The module is powered from the board's 3.3V rail (or 5V if the module requires it) — never from the GPIO.",
      "Pull-ups are required on both lines; most breakout modules include 4.7 kΩ — external pull-ups only if the bus behaves badly.",
      "Only install the level shifter if the module is 5V-only; 3.3V modules must NOT go through one.",
    ],
    safetyClass: "low_voltage_dc",
    mainsInvolved: false,
    externalSupplyRequired: false,
    isolatedFromLoad: false,
    components,
    wires: [],
    checks: [
      {
        id: "bus-documented",
        status:
          ctx.i2cSclPin !== null ? "pass" : "unknown",
        title:
          ctx.i2cSclPin !== null
            ? "I2C bus pins documented on this board"
            : "I2C bus not documented on this board",
        detail:
          ctx.i2cSclPin !== null
            ? `SDA/SCL resolved from the board profile (SDA ${ctx.signalPin !== null ? `GPIO${ctx.signalPin}` : "?"}, SCL ${ctx.i2cSclPin !== null ? `GPIO${ctx.i2cSclPin}` : "?"}).`
            : "The board profile documents no I2C bus — assign the sensor an explicit SDA pin with a known SCL partner.",
      },
      {
        id: "pullups",
        status: "unknown",
        title: "Pull-ups assumed on the module",
        detail:
          "Both lines need pull-ups (typically 4.7 kΩ). Most modules include them. If the bus hangs, add external pull-ups or lower value (2.2 kΩ).",
      },
      {
        id: "address",
        status: "pass",
        title: "I2C address configured",
        detail:
          "The configured address is shown in the Datasheet tab; the firmware scans with it. Duplicate addresses on one bus are invalid — check other I2C entities on this controller.",
      },
      {
        id: "level-shift",
        status: "warn",
        title: "5V-only modules need a level shifter",
        detail:
          "Many sensor breakouts are 3.3V native. If yours is 5V-only, the I2C lines must be shifted — see the conditional component.",
      },
      ratingsCheck(),
    ],
    assumptions: [
      "The module is native 3.3V (most BME280/BH1750 breakouts are) — if it is 5V-only, the conditional shifter applies.",
      "On-module pull-ups are present (typical for breakout boards).",
    ],
    missingSpecifications: [
      "Whether the module includes on-board pull-ups (and their value)",
      "Module logic-level compatibility (3.3V vs 5V-only)",
      "Maximum bus capacitance vs trace length",
    ],
    formulas: [
      {
        title: "Bus capacitance limit",
        body: "Keep total bus capacitance < 400 pF (I2C spec). Long ribbon cables approach this limit fast — keep SDA/SCL short and twisted with ground.",
      },
    ],
    notes: [
      "All I2C devices on this controller share SDA/SCL — a misbehaving device blocks the whole bus.",
      "Assign unique addresses; duplicate addresses need a separate bus or multiplexer (not supported by HomecoreOS firmware).",
    ],
  };
}

// ---------------------------------------------------------------------------
// I — PIR motion sensor (3 wires)
// ---------------------------------------------------------------------------
function pirThreeWire(args: ArchetypeArgs): CircuitDesign {
  const boardHas5V = args.ctx.rails.fiveVolt !== null;

  return {
    state: "ready",
    archetype: "pir_three_wire",
    archetypeLabel: "PIR motion sensor (VCC / GND / OUT)",
    reasoning: [
      "A PIR module is a self-contained detector: it outputs a 3.3V-logic HIGH when motion is seen and LOW at rest.",
      "No external components are required — OUT goes straight to the configured GPIO.",
      "HC-SR501-class modules are typically powered from 5V (4.5–12V) but output 3.3V logic; 3.3V-native modules exist too.",
      boardHas5V
        ? "The board documents a 5V rail — power the PIR from it."
        : "The board documents no 5V rail — check whether your PIR module runs at 3.3V, else supply it externally.",
    ],
    safetyClass: "low_voltage_dc",
    mainsInvolved: false,
    externalSupplyRequired: !boardHas5V,
    isolatedFromLoad: false,
    components: [],
    wires: [],
    checks: [
      {
        id: "out-level",
        status: "unknown",
        title: "OUT logic level assumed 3.3V",
        detail:
          "HC-SR501-class outputs 3.3V logic at rest/high — but verify the module. A 5V OUT straight into the GPIO exceeds the input rating.",
      },
      boardHas5V
        ? {
            id: "supply-documented",
            status: "pass",
            title: "5V rail documented — use it for the PIR",
            detail: "Power the module from the 5V pad (Expansion/relays header, per the layout).",
          }
        : {
            id: "supply-undocumented",
            status: "warn",
            title: "Board documents no 5V rail",
            detail:
              "Verify the module runs at 3.3V, or supply 5V externally with common 0V to GND.",
          },
      {
        id: "warmup",
        status: "warn",
        title: "PIR modules need a warm-up",
        detail:
          "HC-SR501 needs 30–60 s after power-on before the first valid reading, and retrigger settings (H/L jumper) change behavior.",
      },
      commonGroundCheck(),
      ratingsCheck(),
    ],
    assumptions: [
      "HC-SR501-class module: 5V supply, 3.3V output, adjustable sensitivity/time, H or L retrigger jumper.",
      "Trigger mode understood and configured in firmware (repeat vs single-shot).",
    ],
    missingSpecifications: [
      "Module operating voltage (3.3V vs 5V)",
      "OUT high level under your supply",
      "Trigger mode and retrigger behavior vs firmware debounce (50 ms in driver)",
      "Power consumption at rest/trigger",
    ],
    formulas: [],
    notes: [
      "Direction detection requires two PIR elements — a single-element module only detects motion, not direction.",
      "Avoid placing the PIR where HVAC drafts or direct sunlight trigger it constantly.",
    ],
  };
}

// ---------------------------------------------------------------------------
// I2 — Reed / dry contact (2 wires)
// ---------------------------------------------------------------------------
function contactTwoWire(_args: ArchetypeArgs): CircuitDesign {
  return {
    state: "ready",
    archetype: "contact_two_wire",
    archetypeLabel: "Dry contact (reed) — 2 wires, no supply",
    reasoning: [
      "A reed switch is a passive dry contact: it closes (or opens) a path between two pins.",
      "One side goes to the configured GPIO, the other to GND — no VCC leg exists.",
      "The GPIO's internal (or external) pull-up defines the open-state level; firmware debounces the raw transitions.",
    ],
    safetyClass: "low_voltage_dc",
    mainsInvolved: false,
    externalSupplyRequired: false,
    isolatedFromLoad: false,
    components: [],
    wires: [],
    checks: [
      {
        id: "two-wire",
        status: "pass",
        title: "Two-wire passive contact",
        detail:
          "SIG → GPIO, other side → GND. No supply rail is required and none is drawn.",
      },
      {
        id: "pullup-state",
        status: "unknown",
        title: "Pull-up state depends on module",
        detail:
          "Bare reeds need the GPIO's internal pull-up enabled (or ~10 kΩ external). Modules with on-board resistors may already have it.",
      },
      {
        id: "contact-rating",
        status: "unknown",
        title: "Contact rating not documented",
        detail:
          "Reeds switch logic-level currents only. Never route mains or inductive loads through a reed wired to a GPIO.",
      },
    ],
    assumptions: [
      "Reed is wired as normally-open to GND (closed = triggered).",
      "Firmware enables the GPIO pull-up (or uses an external one).",
    ],
    missingSpecifications: [
      "Reed contact rating (V/A) — must exceed only logic levels here",
      "Whether the module includes pull-up/EMI components",
    ],
    formulas: [],
    notes: [
      "Twisted pair with GND reduces EMI on long cable runs.",
      "The driver debounces at 50 ms — contact bounce is ignored.",
    ],
  };
}

// ---------------------------------------------------------------------------
// K — Analog voltage input — divider advisory
// ---------------------------------------------------------------------------
function adcDividerAdvisory(_args: ArchetypeArgs): CircuitDesign {
  const divId = "c-divider";

  const components: CircuitComponent[] = [
    comp(
      {
        id: divId,
        kind: "voltage_divider",
        label: "VOLTAGE DIVIDER (conditional)",
        value: null,
        valueStatus: "not_documented",
        role: "ONLY if the source exceeds 3.3V",
        certainty: "conditional",
        side: "control",
        notes: [
          "Source ≤ 3.3V: do NOT install a divider.",
          "Source > 3.3V: R1/R2 scale it into 0–3.3V. See the formula.",
        ],
      },
      [
        leftPin("IN", "IN (source)", 0, "control"),
        rightPin("OUT", "OUT (→ GPIO/ADC)", 0, "control"),
        rightPin("GND", "GND (→ GND)", 1, "control"),
      ]
    ),
  ];

  return {
    state: "ready",
    archetype: "adc_divider_advisory",
    archetypeLabel: "Analog input (0–3.3V ADC)",
    reasoning: [
      "The ADC on this controller measures 0–3.3V only — anything higher destroys the input and reads full-scale.",
      "If the source is natively 0–3.3V (e.g. a potentiometer across 3.3V/GND), wire it directly and skip the divider.",
      "If the source exceeds 3.3V, a two-resistor divider scales it down — choose R1/R2 for the source's full-scale voltage.",
    ],
    safetyClass: "low_voltage_dc",
    mainsInvolved: false,
    externalSupplyRequired: false,
    isolatedFromLoad: false,
    components,
    wires: [],
    checks: [
      {
        id: "range",
        status: "unknown",
        title: "Source full-scale cannot be verified",
        detail:
          "HomecoreOS does not know the source voltage. Measure it or read the source datasheet — the ADC pin tolerates 3.3V absolute maximum.",
      },
      {
        id: "impedance",
        status: "unknown",
        title: "Source impedance matters",
        detail:
          "High-impedance sources (> ~10 kΩ) load the ADC sample capacitor and skew readings. Buffer with an op-amp or keep source impedance low.",
      },
      {
        id: "absolute-max",
        status: "warn",
        title: "Absolute maximum is 3.3V",
        detail:
          "Even a momentary excursion above 3.3V (charger fault, 12V accidental touch) can damage the pin. A clamp diode or divider with margin is prudent.",
      },
      ratingsCheck(),
    ],
    assumptions: [
      "The source is a low-voltage analog signal (e.g. NTC divider, LDR, trim pot) — not an unisolated mains-derived voltage.",
    ],
    missingSpecifications: [
      "Source full-scale voltage and output impedance",
      "Whether the source is isolated from mains (non-isolated mains references are forbidden)",
      "Required accuracy vs divider tolerance",
    ],
    formulas: [
      {
        title: "Divider sizing",
        body: "V_ADC = V_in × R2 / (R1 + R2) ≤ 3.3V. Example: V_in = 5V → R1 = 10k, R2 = 20k gives 3.33V (marginal) — use R1 = 10k, R2 = 15k → 3.0V.",
      },
      {
        title: "Recovery calibration",
        body: "V_actual = V_ADC × (R1 + R2) / R2 — the firmware reports raw ADC; scale in software.",
      },
    ],
    notes: [
      "Reference the divider's ground to controller GND — never to a mains-referenced ground.",
      "Add a 100 nF cap from the ADC pin to GND to average noise on slow signals.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Fallback — unknown class
// ---------------------------------------------------------------------------
function genericDirect(_args: ArchetypeArgs): CircuitDesign {
  return {
    state: "ready",
    archetype: "generic_direct",
    archetypeLabel: "Direct connection (no documented circuit pattern)",
    reasoning: [
      "No circuit pattern is documented for this device class.",
      "Only the configured logical pin assignment is shown; nothing about supply or load stages is implied.",
    ],
    safetyClass: "unknown",
    mainsInvolved: false,
    externalSupplyRequired: false,
    isolatedFromLoad: false,
    components: [],
    wires: [],
    checks: [ratingsCheck()],
    assumptions: [],
    missingSpecifications: [
      "Module supply voltage and current",
      "Required driver stage (if any)",
      "Load ratings",
    ],
    formulas: [],
    notes: ["Consult the module datasheet for the complete circuit."],
  };
}
