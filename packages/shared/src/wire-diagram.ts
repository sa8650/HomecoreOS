/**
 * Interactive Wire Diagram — connection resolution engine.
 *
 * Pure declarations only (no import-time side effects) to preserve
 * `@homecoreos/shared` `"sideEffects": false` tree-shaking guarantees.
 *
 * Truthfulness contract (enforced by the UI as well):
 * - GPIO assignments, pin capabilities, voltages and connections shown here
 *   come from (a) the entity's configured record, (b) the controller board's
 *   profile in the Board Library / Custom Board Builder, and (c) the shared
 *   sensor driver registry. Nothing is invented.
 * - A board whose profile cannot be trusted (missing pin map, unverified or
 *   unpublished catalog entry) produces an explicit "unavailable" state with
 *   the exact reasons instead of a fabricated diagram.
 * - Every connection is labelled as what it is: a configured logical
 *   assignment, a shared logical bus, a reference rail, an advisory, or a
 *   conflict / invalid assignment. HomecoreOS never claims to have detected a
 *   physically wired connection.
 * - Power (VCC) legs are listed but never auto-wired: module supply
 *   requirements are not documented anywhere in HomecoreOS, so choosing a
 *   rail for the user would be fabrication. Ground reference legs are drawn
 *   from the header GND pin the board profile documents.
 */
import {
  SUPPORTED_DEVICE_TYPES,
  chipFamilyLabel,
  type BoardHeaderPin,
  type BoardProfileSpec,
  type SupportedDeviceType,
  type SupportedSensorType,
} from "./index";
import {
  buildCircuitDesign,
  type CircuitDesign,
  type CircuitRailAnchor,
} from "./circuit-design";
import {
  canSensorsShareGpioPin,
  deriveBoardHardwareCapabilityProfile,
  findDocumentedI2cBus,
  getSensorDriverForMeasurement,
  getSensorMeasurementByType,
  normalizeI2cAddress,
  type SensorDriverDefinition,
} from "./sensor-drivers";
import {
  requiredPinCapabilityForDevice,
  requiredPinCapabilityForSensor,
  validateGpioAssignment,
  type PinOperationRequirement,
} from "./board-validation";
import { readBoardLayoutFacts } from "./planner/board-capability";
import { resolveBoardHardwareSpecs } from "./board-catalog-data";

export type WireDiagramEntityKind = "switch" | "device" | "sensor";

/** What a wire electrically is — shown verbatim in the UI. */
export type WireDiagramConnectionKind =
  | "Configured (Logical)"
  | "Shared Bus (Logical)"
  | "Reference Rail"
  | "Advisory Warning"
  | "Pin Conflict / Invalid";

export type WireDiagramTerminalRole = "signal" | "power" | "ground" | "load";

export type WireDiagramPlacement = "header" | "extra_pad" | "onboard" | "none";

export interface WireDiagramEntityInput {
  kind: WireDiagramEntityKind;
  id: string;
  name: string;
  controllerId: string;
  /** The configured GPIO, or null for an I2C sensor on the controller's default bus. */
  gpioPin: number | null;
  /** Switch only: Active-LOW relay logic when true. */
  inverted?: boolean;
  /** Device only: SUPPORTED_DEVICE_TYPES value. */
  deviceType?: string | null;
  /** Sensor only: SUPPORTED_SENSOR_TYPES value. */
  sensorType?: string | null;
  /** Sensor only: stored I2C address (e.g. "0x76"), when configured. */
  i2cAddress?: string | null;
  /** Sensor only: stored driver id, shown when present (never required). */
  driverId?: string | null;
  isOnline?: boolean | null;
}

export interface WireDiagramControllerInput {
  id: string;
  name: string;
  boardCatalogId?: string | null;
  customBoardId?: string | null;
  boardModel?: string | null;
  firmwareVersion?: string | null;
  status?: string | null;
}

/** Another device / switch / sensor holding pin(s) on the same controller. */
export interface WireDiagramSiblingPin {
  pin: number;
  entityKind: WireDiagramEntityKind;
  id: string;
  name: string;
  sensorType?: string;
}

/** The board profile plus the Board Library availability flag (catalog boards only). */
export type WireDiagramBoardInput = BoardProfileSpec & {
  is_available?: boolean | null;
};

export interface WireDiagramParams {
  entity: WireDiagramEntityInput;
  controller?: WireDiagramControllerInput | null;
  board?: WireDiagramBoardInput | null;
  /** Pins already held by *other* entities on the controller (any pin number). */
  siblingPins?: WireDiagramSiblingPin[];
  roomName?: string | null;
}

export interface WireDiagramTerminal {
  id: string;
  label: string;
  role: WireDiagramTerminalRole;
  /** What the terminal does — generic for the module class, not module-specific. */
  function: string;
  /** True when HomecoreOS draws a wire to this terminal in the diagram. */
  drawn: boolean;
}

export interface WireDiagramConnection {
  id: string;
  terminalId: string;
  terminalLabel: string;
  role: WireDiagramTerminalRole;
  /** GPIO number, or null when the leg is a rail/terminal with no GPIO. */
  pin: number | null;
  /** Board pin name printed on the pad, e.g. "D4". */
  pinName: string | null;
  headerName: string | null;
  headerPosition: number | null;
  /** `${headerName}:${position}` — matches headerPinKey() in BoardVectorSvg. */
  headerKey: string | null;
  side: "left" | "right" | null;
  /** Index of the pad within its side rail (for vertical routing order). */
  index: number | null;
  placement: WireDiagramPlacement;
  /** Extra (back) pad name when placement === "extra_pad", e.g. "D11". */
  extraPadName: string | null;
  /** Onboard peripheral label when placement === "onboard". */
  onboardFeatureLabel: string | null;
  /** Short signal name, e.g. "Digital Output", "I2C SDA", "ADC", "GND". */
  signal: string;
  /** Documented voltage for the leg, or "Not documented". */
  voltage: string;
  kind: WireDiagramConnectionKind;
  warnings: string[];
  /** One-line explanation rendered in the inspector / table. */
  detail: string;
  /** Sibling entity names legally sharing this pin (empty when exclusive). */
  sharedWith: string[];
}

export interface WireDiagramBoardFacts {
  name: string;
  isCustom: boolean;
  layoutDocumented: boolean;
  chipLabel: string;
  processor: string;
  wireless: string;
  memory: string;
  usb: string;
  revision: string;
  flashSizeMb: number;
  psramSizeMb: number;
  usbId: string | null;
  verificationStatus: string;
  docsUrl: string | null;
  datasheetUrl: string | null;
  powerRails: string[];
  groundRailDocumented: boolean;
  onboardFeatures: Array<{ label: string; gpioPin: number | null; kind: string }>;
}

export interface WireDiagramSensorDriverFacts {
  driverId: string;
  driverDisplayName: string;
  driverVersion: string | null;
  interfaceLabel: string;
  hardwareVerificationStatus: string;
  supportedModels: string[];
  measurements: string[];
  defaultUnit: string | null;
  i2cAddress: string | null;
  defaultI2cAddresses: string[];
  requiresPullUp: boolean;
  minIntervalMs: number | null;
  debounceMs: number | null;
  samplesPerRead: number | null;
}

export interface WireDiagramEntityFacts {
  kind: WireDiagramEntityKind;
  typeLabel: string;
  manufacturer: string;
  interfaceLabel: string;
  signalLabel: string;
  /** Operating voltage of the module — never invented. */
  operatingVoltage: string;
  /** Current requirement — never invented. */
  currentDraw: string;
  driver: WireDiagramSensorDriverFacts | null;
  /** Switch only: Active-HIGH / Active-LOW relay logic. */
  relayLogic: string | null;
  /** Terminal definitions used for this class of module (generic, documented). */
  terminals: WireDiagramTerminal[];
}

export interface WireDiagramResult {
  state: "ready" | "unavailable";
  /** Non-empty iff state === "unavailable". Exact, user-presentable reasons. */
  unavailableReasons: string[];
  /** Device-specific circuit plan: required external components, load-side
   *  wiring, safety validation and explicit assumptions. Never invents specs. */
  circuit: CircuitDesign;
  entityName: string;
  entityKind: WireDiagramEntityKind;
  entityOnline: boolean | null;
  controllerName: string | null;
  roomName: string | null;
  board: WireDiagramBoardFacts | null;
  entity: WireDiagramEntityFacts | null;
  terminals: WireDiagramTerminal[];
  connections: WireDiagramConnection[];
  /** Global advisory notes (pull-ups, mains wiring, dividers, …). */
  warnings: string[];
  /** True when every drawn wire sits on a documented header pin. */
  allPlacementDocumented: boolean;
  totals: {
    connections: number;
    shared: number;
    invalid: number;
    advisory: number;
  };
}

/**
 * Locates a documented power rail and anchors it to a drawable pin. Returns
 * null when the board profile documents no such rail — the caller must then
 * show an external supply requirement instead of picking a rail.
 */
function findRailAnchor(
  board: WireDiagramBoardInput,
  pattern: RegExp
): CircuitRailAnchor | null {
  const layout = board.board_layout ?? null;
  const scan = (
    pins: BoardHeaderPin[] | undefined
  ): CircuitRailAnchor | null => {
    if (!pins) return null;
    for (const hp of pins) {
      if (hp.kind !== "power") continue;
      const voltage = (hp.voltage ?? "").trim();
      const name = (hp.pinName ?? "").trim();
      if (pattern.test(voltage) || pattern.test(name)) {
        return {
          headerKey: `${hp.headerName}:${hp.position}`,
          extraPadName: null,
          label: name || voltage,
        };
      }
    }
    return null;
  };
  const fromHeaders =
    scan(layout?.leftHeader?.pins as BoardHeaderPin[] | undefined) ??
    scan(layout?.rightHeader?.pins as BoardHeaderPin[] | undefined);
  if (fromHeaders) return fromHeaders;
  // Extra (back) pads: no header key — anchor by pad name for the chip view.
  for (const hp of layout?.extraPads?.pins ?? []) {
    if (hp.kind !== "power") continue;
    const voltage = (hp.voltage ?? "").trim();
    const name = (hp.pinName ?? "").trim();
    if (pattern.test(voltage) || pattern.test(name)) {
      return { headerKey: null, extraPadName: name, label: name || voltage };
    }
  }
  return null;
}

interface BoardLayoutPinLookup {
  byGpio: Map<number, { hp: BoardHeaderPin; side: "left" | "right"; index: number }>;
  groundPin: { hp: BoardHeaderPin; side: "left" | "right"; index: number } | null;
  extraByGpio: Map<number, BoardHeaderPin>;
  documentedRails: string[];
  layoutDocumented: boolean;
}

function readLayoutPins(
  board: BoardProfileSpec
): BoardLayoutPinLookup {
  const layout = board.board_layout ?? null;
  const byGpio = new Map<number, { hp: BoardHeaderPin; side: "left" | "right"; index: number }>();
  const left = layout?.leftHeader?.pins ?? [];
  const right = layout?.rightHeader?.pins ?? [];

  const register = (pins: BoardHeaderPin[], side: "left" | "right") => {
    pins.forEach((hp, index) => {
      if (hp.kind === "gpio" && typeof hp.gpioPin === "number") {
        if (!byGpio.has(hp.gpioPin)) byGpio.set(hp.gpioPin, { hp, side, index });
      }
    });
  };
  register(left, "left");
  register(right, "right");

  const layoutDocumented = left.length > 0 || right.length > 0;

  let groundPin: BoardLayoutPinLookup["groundPin"] = null;
  const findRail = (kind: BoardHeaderPin["kind"], voltage?: string) => {
    const scan = (
      pins: BoardHeaderPin[],
      side: "left" | "right"
    ): BoardLayoutPinLookup["groundPin"] => {
      for (let index = 0; index < pins.length; index += 1) {
        const hp = pins[index]!;
        if (hp.kind !== kind) continue;
        if (voltage && (hp.voltage ?? "").trim() !== voltage) continue;
        return { hp, side, index };
      }
      return null;
    };
    return scan(left, "left") ?? scan(right, "right");
  };
  groundPin = findRail("ground") ?? null;

  const extraByGpio = new Map<number, BoardHeaderPin>();
  for (const hp of layout?.extraPads?.pins ?? []) {
    if (hp.kind === "gpio" && typeof hp.gpioPin === "number") {
      if (!extraByGpio.has(hp.gpioPin)) extraByGpio.set(hp.gpioPin, hp);
    }
  }

  // Documented power rails come from the layout facts the planner uses, so the
  // diagram agrees with the rest of the product.
  const facts = readBoardLayoutFacts({
    board_layout: board.board_layout ?? null,
    gpio_definitions: board.gpio_definitions ?? [],
  });
  const documentedRails = facts.powerRails.filter((r) => /3\.?3|5/.test(r));

  return {
    byGpio,
    groundPin,
    extraByGpio,
    documentedRails,
    layoutDocumented,
  };
}

interface HeaderAnchor {
  hp: BoardHeaderPin;
  side: "left" | "right";
  index: number;
}

function baseConnection(
  anchor: HeaderAnchor | null,
  gpioPin: number | null,
  terminal: WireDiagramTerminal,
  identity: { id: string }
): WireDiagramConnection {
  const header = anchor
    ? {
        pinName: anchor.hp.pinName,
        headerName: anchor.hp.headerName,
        headerPosition: anchor.hp.position,
        headerKey: `${anchor.hp.headerName}:${anchor.hp.position}`,
        side: anchor.side,
        index: anchor.index,
        placement: "header" as WireDiagramPlacement,
      }
    : {
        pinName: null,
        headerName: null,
        headerPosition: null,
        headerKey: null,
        side: null,
        index: null,
        placement: "none" as WireDiagramPlacement,
      };

  return {
    id: identity.id,
    terminalId: terminal.id,
    terminalLabel: terminal.label,
    role: terminal.role,
    pin: gpioPin,
    ...header,
    extraPadName: null,
    onboardFeatureLabel: null,
    signal: "",
    voltage: "",
    kind: "Configured (Logical)",
    warnings: [],
    detail: "",
    sharedWith: [],
  };
}

function siblingShares(
  entitySensorType: string | null,
  sibling: WireDiagramSiblingPin
): boolean {
  if (entitySensorType && sibling.sensorType) {
    return canSensorsShareGpioPin(entitySensorType, sibling.sensorType);
  }
  return false;
}

function formatUsbId(board: BoardProfileSpec): string | null {
  if (board.usb_vid && board.usb_pid) return `${board.usb_vid}:${board.usb_pid}`;
  return board.usb_vid ?? board.usb_pid ?? null;
}

function verificationLabel(board: BoardProfileSpec): string {
  if (board.catalog_category === "custom") return "Custom board (unverified profile)";
  return board.verification_status === "verified"
    ? "Verified"
    : "Unverified — awaiting Board Library verification";
}

interface DeviceClassSpec {
  label: string;
  signal: string;
  requirementLabel: string;
  interfaceLabel: string;
  terminals: Array<Omit<WireDiagramTerminal, "drawn">>;
  /** Passive load-side terminals appended when the channel is not on-board. */
  loadTerminals?: Array<Omit<WireDiagramTerminal, "drawn">>;
  currentNote: string | null;
}

/**
 * Passive load-side contacts (isolated switching stage) — appended to the
 * module terminals for switching archetypes, never for channels hardwired to
 * on-board output circuitry (the screws are not in the pin profile).
 */
const RELAY_LOAD_TERMINALS: Array<Omit<WireDiagramTerminal, "drawn">> = [
  {
    id: "com",
    label: "COM",
    role: "load",
    function: "Common contact of the isolated relay stage — the switched circuit enters here (load side).",
  },
  {
    id: "no",
    label: "NO",
    role: "load",
    function: "Normally open contact — closes to COM when the controlling input is driven.",
  },
  {
    id: "nc",
    label: "NC",
    role: "load",
    function: "Normally closed contact — closed to COM at rest (unwired here).",
  },
];

const SOLENOID_LOAD_TERMINALS: Array<Omit<WireDiagramTerminal, "drawn">> = [
  {
    id: "sp",
    label: "S+",
    role: "load",
    function: "Solenoid coil + terminal — fed by the external supply (load side).",
  },
  {
    id: "sm",
    label: "S−",
    role: "load",
    function: "Solenoid coil − terminal — switched to 0V through the low-side driver.",
  },
];

const RELAY_CLASS: DeviceClassSpec = {
  label: "Relay channel",
  signal: "Digital output",
  requirementLabel: "digital output",
  interfaceLabel: "GPIO (digital output)",
  terminals: [
    {
      id: "in",
      label: "IN",
      role: "signal",
      function: "Trigger input — the firmware drives this pin to pull the channel in.",
    },
    {
      id: "vcc",
      label: "VCC",
      role: "power",
      function: "Module supply — connect to a rail matching your module's datasheet.",
    },
    {
      id: "gnd",
      label: "GND",
      role: "ground",
      function: "Signal ground — shared reference with the controller.",
    },
  ],
  loadTerminals: RELAY_LOAD_TERMINALS,
  currentNote: null,
};

const DEVICE_CLASS_SPECS: Record<SupportedDeviceType, DeviceClassSpec> = {
  relay: RELAY_CLASS,
  valve: {
    label: "Valve (solenoid)",
    signal: "Low-side switched coil",
    requirementLabel: "digital output",
    interfaceLabel: "GPIO → external low-side driver",
    terminals: [],
    loadTerminals: SOLENOID_LOAD_TERMINALS,
    currentNote: null,
  },
  lock: {
    label: "Electronic lock (solenoid)",
    signal: "Low-side switched coil",
    requirementLabel: "digital output",
    interfaceLabel: "GPIO → external low-side driver",
    terminals: [],
    loadTerminals: SOLENOID_LOAD_TERMINALS,
    currentNote: null,
  },
  light: {
    ...RELAY_CLASS,
    label: "Switched lighting load",
  },
  tv: {
    label: "TV control module",
    signal: "Digital output",
    requirementLabel: "digital output",
    interfaceLabel: "GPIO (digital output)",
    loadTerminals: RELAY_LOAD_TERMINALS,
    terminals: [
      {
        id: "sig",
        label: "SIG",
        role: "signal",
        function: "Control pulse output — typically an IR emitter driver for TVs.",
      },
      {
        id: "vcc",
        label: "VCC",
        role: "power",
        function: "Module supply — connect to a rail matching your module's datasheet.",
      },
      {
        id: "gnd",
        label: "GND",
        role: "ground",
        function: "Signal ground — shared reference with the controller.",
      },
    ],
    currentNote: null,
  },
  fan: {
    ...RELAY_CLASS,
    label: "Fan (switched)",
  },
  dimmer_pwm: {
    label: "PWM dimmer",
    signal: "PWM output",
    requirementLabel: "PWM output",
    interfaceLabel: "GPIO (PWM)",
    loadTerminals: [
      {
        id: "out",
        label: "OUT",
        role: "load",
        function: "Switched low-voltage output — typically the LED strip's negative (−) return, switched by the dimmer's power stage.",
      },
    ],
    terminals: [
      {
        id: "pwm",
        label: "PWM",
        role: "signal",
        function: "PWM control input — duty cycle sets the output level.",
      },
      {
        id: "vcc",
        label: "VCC",
        role: "power",
        function: "Module supply — connect to a rail matching your module's datasheet.",
      },
      {
        id: "gnd",
        label: "GND",
        role: "ground",
        function: "Signal ground — shared reference with the controller.",
      },
    ],
    currentNote: null,
  },
  buzzer: {
    label: "Buzzer",
    signal: "Digital output",
    requirementLabel: "digital output",
    interfaceLabel: "GPIO (digital output)",
    terminals: [
      {
        id: "io",
        label: "I/O",
        role: "signal",
        function: "Drive signal — the firmware toggles this pin to sound the buzzer.",
      },
      {
        id: "vcc",
        label: "VCC",
        role: "power",
        function: "Module supply — connect to a rail matching your module's datasheet.",
      },
      {
        id: "gnd",
        label: "GND",
        role: "ground",
        function: "Signal ground — shared reference with the controller.",
      },
    ],
    currentNote: null,
  },
  status_led: {
    label: "Status LED",
    signal: "Digital output",
    requirementLabel: "digital output",
    interfaceLabel: "GPIO (digital output)",
    terminals: [
      {
        id: "a",
        label: "A",
        role: "signal",
        function: "Anode — wire through a series resistor (e.g. 330 Ω) to the GPIO.",
      },
      {
        id: "k",
        label: "K",
        role: "ground",
        function: "Cathode — to GND (through the resistor loop).",
      },
    ],
    currentNote: null,
  },
};

interface SensorInterfaceSpec {
  signal: string;
  interfaceLabel: string;
  typeLabel: string;
  terminals: Array<Omit<WireDiagramTerminal, "drawn">>;
}

function sensorInterfaceSpec(
  driver: SensorDriverDefinition,
  measurementShort: string | null
): SensorInterfaceSpec {
  const base = {
    typeLabel: measurementShort ?? driver.displayName,
  };
  switch (driver.interface) {
    case "i2c":
      return {
        ...base,
        signal: "I2C",
        interfaceLabel: driver.interfaceLabel,
        terminals: [
          {
            id: "sda",
            label: "SDA",
            role: "signal",
            function: "I2C data line (open-drain) — requires pull-up resistors, often on the module.",
          },
          {
            id: "scl",
            label: "SCL",
            role: "signal",
            function: "I2C clock line (open-drain) — requires pull-up resistors, often on the module.",
          },
          {
            id: "vcc",
            label: "VCC",
            role: "power",
            function: "Module supply — connect to a rail matching your module's datasheet.",
          },
          {
            id: "gnd",
            label: "GND",
            role: "ground",
            function: "Signal ground — shared reference with the controller.",
          },
        ],
      };
    case "onewire":
      return {
        ...base,
        signal: "1-Wire data",
        interfaceLabel: driver.interfaceLabel,
        terminals: [
          {
            id: "dq",
            label: "DQ",
            role: "signal",
            function: "1-Wire data line — requires a ~4.7 kΩ pull-up to the supply rail.",
          },
          {
            id: "vcc",
            label: "VCC",
            role: "power",
            function: "Probe supply — connect to a rail matching your probe's datasheet.",
          },
          {
            id: "gnd",
            label: "GND",
            role: "ground",
            function: "Signal ground — shared reference with the controller.",
          },
        ],
      };
    case "adc":
      return {
        ...base,
        signal: "ADC input",
        interfaceLabel: driver.interfaceLabel,
        terminals: [
          {
            id: "sig",
            label: "SIG",
            role: "signal",
            function: "ADC input — 0–3.3 V only. Scale higher voltages with a divider.",
          },
          {
            id: "gnd",
            label: "GND",
            role: "ground",
            function: "Signal ground — shared reference with the controller.",
          },
        ],
      };
    case "gpio_single_wire":
      return {
        ...base,
        signal: "Single-wire data",
        interfaceLabel: driver.interfaceLabel,
        terminals: [
          {
            id: "data",
            label: "DATA",
            role: "signal",
            function: "Bi-directional data line — requires a pull-up resistor (4.7–10 kΩ), often on the module.",
          },
          {
            id: "vcc",
            label: "VCC",
            role: "power",
            function: "Module supply — connect to a rail matching your module's datasheet.",
          },
          {
            id: "gnd",
            label: "GND",
            role: "ground",
            function: "Signal ground — shared reference with the controller.",
          },
        ],
      };
    case "gpio_digital_in":
      if (driver.busConfig.requiresPullUp && driver.id === "reed") {
        return {
          ...base,
          signal: "Dry contact (GPIO input)",
          interfaceLabel: driver.interfaceLabel,
          terminals: [
            {
              id: "sig",
              label: "SIG",
              role: "signal",
              function: "One side of the reed contact — the firmware reads this as a pulled-up input.",
            },
            {
              id: "gnd",
              label: "GND",
              role: "ground",
              function: "Other side of the reed contact — closing the contact pulls SIG to GND.",
            },
          ],
        };
      }
      return {
        ...base,
        signal: "Digital input",
        interfaceLabel: driver.interfaceLabel,
        terminals: [
          {
            id: "out",
            label: "OUT",
            role: "signal",
            function: "Digital output of the sensor — the firmware reads it as a debounced input.",
          },
          {
            id: "vcc",
            label: "VCC",
            role: "power",
            function: "Module supply — connect to a rail matching your module's datasheet.",
          },
          {
            id: "gnd",
            label: "GND",
            role: "ground",
            function: "Signal ground — shared reference with the controller.",
          },
        ],
      };
  }
}

const NOT_DOCUMENTED = "Not documented";

interface SiblingIndex {
  all: WireDiagramSiblingPin[];
}

function siblingsOn(index: SiblingIndex, pin: number): WireDiagramSiblingPin[] {
  return index.all.filter((s) => s.pin === pin);
}

function shareableSensors(
  entitySensorType: string | null,
  sibling: WireDiagramSiblingPin
): boolean {
  if (!entitySensorType || !sibling.sensorType) return false;
  return siblingShares(entitySensorType, sibling);
}

/** Human-readable conflict names used in validation & warnings. */
function conflictNames(
  pin: number,
  index: SiblingIndex,
  entitySensorType: string | null
): string[] {
  return siblingsOn(index, pin)
    .filter((s) => !shareableSensors(entitySensorType, s))
    .map((s) => `${s.entityKind} "${s.name}"`);
}

function shareableNames(
  pin: number,
  index: SiblingIndex,
  entitySensorType: string | null
): string[] {
  if (!entitySensorType) return [];
  return siblingsOn(index, pin)
    .filter((s) => shareableSensors(entitySensorType, s))
    .map((s) => `${s.entityKind} "${s.name}"`);
}

function isWholePin(pin: number | null | undefined): pin is number {
  return typeof pin === "number" && Number.isInteger(pin) && pin >= 0 && pin <= 64;
}

function boardFactsOf(board: WireDiagramBoardInput): WireDiagramBoardFacts {
  const hardware = resolveBoardHardwareSpecs({
    slug: board.slug,
    model: board.model,
    chip_family: board.chip_family,
    chip_variant: board.chip_variant,
    flash_size_mb: board.flash_size_mb,
    psram_size_mb: board.psram_size_mb,
    board_layout: board.board_layout ?? null,
  });
  const layout = board.board_layout ?? null;
  const lookup = readLayoutPins(board);
  return {
    name: `${board.manufacturer} ${board.model}`.trim(),
    isCustom: board.catalog_category === "custom",
    layoutDocumented: lookup.layoutDocumented,
    chipLabel: chipFamilyLabel(board.chip_family),
    processor: hardware.processor,
    wireless: hardware.wireless,
    memory: hardware.memory,
    usb: hardware.usb,
    revision: board.revision,
    flashSizeMb: board.flash_size_mb,
    psramSizeMb: board.psram_size_mb,
    usbId: formatUsbId(board),
    verificationStatus: verificationLabel(board),
    docsUrl: board.docs_url ?? null,
    datasheetUrl: board.datasheet_url ?? null,
    powerRails: lookup.documentedRails,
    groundRailDocumented: lookup.groundPin !== null,
    onboardFeatures: (layout?.onboardFeatures ?? []).map((f) => ({
      label: f.label,
      gpioPin: f.gpioPin,
      kind: f.kind,
    })),
  };
}

function emptyIncomplete(
  params: WireDiagramParams,
  reasons: string[]
): WireDiagramResult {
  const board = params.board ?? null;
  return {
    state: "unavailable",
    unavailableReasons: reasons,
    entityName: params.entity.name,
    entityKind: params.entity.kind,
    entityOnline: params.entity.isOnline ?? null,
    controllerName: params.controller?.name ?? null,
    roomName: params.roomName ?? null,
    board: board ? boardFactsOf(board) : null,
    entity: null,
    terminals: [],
    connections: [],
    warnings: [],
    allPlacementDocumented: false,
    totals: { connections: 0, shared: 0, invalid: 0, advisory: 0 },
    circuit: buildCircuitDesign({
      entity: params.entity,
      boardModel: board?.model ?? null,
      terminals: [],
      signalPin: null,
      i2cSclPin: null,
      gpioHeaderKey: null,
      gpioExtraPadName: null,
      rails: { fiveVolt: null, threeThreeVolt: null, ground: null },
      onboardFeature: null,
      sensorDriver: null,
      unavailable: true,
    }),
  };
}

/**
 * Resolves everything the Wire Diagram renders for one entity: controller,
 * board profile, pins, buses, terminal wiring, conflicts and datasheet facts.
 *
 * Never throws for missing data — returns `state: "unavailable"` with exact
 * reasons instead. Only programmer errors (none expected) would throw.
 */
export function buildWireDiagram(params: WireDiagramParams): WireDiagramResult {
  const entity = params.entity;
  const controller = params.controller ?? null;
  const board = params.board ?? null;
  const reasons: string[] = [];

  // ---------------- Controller & board gates ----------------
  if (!controller) {
    reasons.push(
      "The controller record for this entity could not be loaded. Reload the page and try again."
    );
  }
  if (!board) {
    reasons.push(
      "The Board Library has no profile for this controller's board. Assign a published board (or a Custom Board Builder profile) to the controller before wiring it."
    );
  } else {
    if (board.catalog_category !== "custom") {
      if (board.is_available === false) {
        reasons.push(
          `The Board Library profile for ${board.manufacturer} ${board.model} is withdrawn from the catalog (not available), so its pin map cannot be trusted for wiring.`
        );
      }
      if (board.verification_status === "needs_verification") {
        reasons.push(
          `The Board Library profile for ${board.manufacturer} ${board.model} is marked "needs verification". HomecoreOS does not draw wiring from an unverified pin map.`
        );
      }
    }
    if (!Array.isArray(board.gpio_definitions) || board.gpio_definitions.length === 0) {
      reasons.push(
        `The board profile for ${board.manufacturer} ${board.model} does not include GPIO definitions, so pin capabilities cannot be checked.`
      );
    }
  }

  // ---------------- Entity-specific resolution ----------------
  const sensorType = entity.kind === "sensor" ? entity.sensorType?.trim() ?? "" : "";
  const deviceType =
    entity.kind === "device" ? entity.deviceType?.trim().toLowerCase() ?? "" : "";
  const sensorDriver =
    entity.kind === "sensor" ? getSensorDriverForMeasurement(sensorType) ?? null : null;
  const sensorMeasurement =
    entity.kind === "sensor" ? getSensorMeasurementByType(sensorType) ?? null : null;

  if (entity.kind === "device" && !(SUPPORTED_DEVICE_TYPES as readonly string[]).includes(deviceType)) {
    reasons.push(
      `Unsupported device type "${entity.deviceType ?? "(empty)"}". HomecoreOS wires: ${SUPPORTED_DEVICE_TYPES.join(", ")}.`
    );
  }
  if (entity.kind === "sensor") {
    if (!sensorType) {
      reasons.push("The sensor has no sensor_type configured.");
    } else if (!sensorDriver || !sensorMeasurement) {
      reasons.push(
        `Unsupported sensor type "${sensorType}". It is not in the HomecoreOS sensor driver registry, so no terminal definitions exist for it.`
      );
    }
  }

  const isI2cSensor = sensorDriver?.interface === "i2c";
  const assignedPin = entity.gpioPin;
  const pinDefs = new Map((board?.gpio_definitions ?? []).map((g) => [g.pin, g]));
  const capabilityProfile =
    board && (board.gpio_definitions?.length ?? 0) > 0
      ? deriveBoardHardwareCapabilityProfile(board)
      : null;

  // Resolve the I2C bus (assigned SDA pin wins; otherwise the documented default bus).
  let i2cSdaPin: number | null = null;
  let i2cSclPin: number | null = null;
  let i2cFromDefaultBus = false;
  if (entity.kind === "sensor" && isI2cSensor) {
    // Only a documented bus is ever drawn — never the capability profile's
    // lowest-two-pins fallback.
    const defaultBus = board
      ? findDocumentedI2cBus(board)
      : { sdaPin: null, sclPin: null };
    if (isWholePin(assignedPin)) {
      i2cSdaPin = assignedPin;
      i2cSclPin = defaultBus.sclPin;
      if (i2cSclPin === null) {
        reasons.push(
          `The board profile does not document the SCL pin for the default I2C bus, so the clock line of ${sensorDriver?.displayName ?? "this sensor"} cannot be resolved. Assign the sensor to a board whose profile documents an I2C bus.`
        );
      }
    } else {
      i2cSdaPin = defaultBus.sdaPin;
      i2cSclPin = defaultBus.sclPin;
      i2cFromDefaultBus = true;
      if (i2cSdaPin === null || i2cSclPin === null) {
        reasons.push(
          "This sensor uses the controller's default I2C bus, but the board profile does not document one (no SDA/SCL pads marked in its headers). Assign an explicit GPIO pin for the sensor's SDA line instead."
        );
      }
    }
  }

  const signalPin: number | null =
    entity.kind === "sensor" && isI2cSensor
      ? i2cSdaPin
      : isWholePin(assignedPin)
        ? assignedPin
        : null;

  if (entity.kind !== "sensor" || !isI2cSensor) {
    if (!isWholePin(assignedPin)) {
      reasons.push(
        entity.kind === "switch"
          ? "The switch has no configured GPIO pin."
          : entity.kind === "device"
            ? "The device has no configured GPIO pin."
            : `${sensorDriver?.displayName ?? "This sensor"} requires a configured GPIO pin.`
      );
    }
  }

  if (reasons.length > 0) {
    return emptyIncomplete(params, reasons);
  }

  // ---------------- Shared evaluation context ----------------
  const siblingIndex: SiblingIndex = {
    all: (params.siblingPins ?? []).filter(
      (s) => !(s.id === entity.id && s.entityKind === entity.kind)
    ),
  };
  const lookup = readLayoutPins(board!);
  const layout = board!.board_layout ?? null;
  const documentedRails = lookup.documentedRails;
  const gpioLogicVoltage = documentedRails.includes("3.3V")
    ? "3.3V logic"
    : NOT_DOCUMENTED;

  const onboardFeatureForPin = (pin: number | null) =>
    pin === null
      ? null
      : (layout?.onboardFeatures ?? []).find((f) => f.gpioPin === pin) ?? null;

  const warnings: string[] = [];
  if (!lookup.layoutDocumented) {
    warnings.push(
      "This board profile does not document a pin layout. The PCB is drawn from an auto-generated pin map, so wire endpoints are listed in the Connections tab instead of being drawn."
    );
  }
  if (documentedRails.length === 0) {
    warnings.push(
      "The board profile does not document its power rails. Connect power according to the board's own documentation — HomecoreOS does not choose a rail for you."
    );
  }

  const connections: WireDiagramConnection[] = [];
  const push = (conn: WireDiagramConnection) => {
    conn.id = `conn-${connections.length + 1}`;
    connections.push(conn);
  };

  const anchorConnection = (
    pin: number | null,
    terminal: WireDiagramTerminal,
    partial?: {
      onboardLabel?: string | null;
    }
  ): WireDiagramConnection => {
    const anchor = pin === null ? null : lookup.byGpio.get(pin) ?? null;
    const extra = pin === null ? undefined : lookup.extraByGpio.get(pin);
    const base = baseConnection(
      anchor,
      pin,
      terminal,
      { id: "pending" }
    );
    if (!anchor && extra) {
      base.placement = "extra_pad";
      base.extraPadName = extra.pinName;
      base.pinName = extra.pinName;
      base.headerName = extra.headerName;
      base.headerPosition = extra.position;
      base.headerKey = `${extra.headerName}:${extra.position}`;
    }
    if (partial?.onboardLabel) {
      base.placement = "onboard";
      base.onboardFeatureLabel = partial.onboardLabel;
      base.headerKey = anchor?.hp
        ? `${anchor.hp.headerName}:${anchor.hp.position}`
        : base.headerKey;
    }
    return base;
  };

  const validatePin = (
    pin: number,
    requirement: PinOperationRequirement,
    sensorTypeForRules: string | null
  ): { errors: string[]; warnings: string[] } => {
    const result = validateGpioAssignment({
      board: board!,
      pin,
      requirement,
      usedPinsOnController: [],
    });
    const errors = [...result.errors];
    const named = conflictNames(
      pin,
      siblingIndex,
      sensorTypeForRules
    );
    if (named.length > 0) {
      errors.push(
        `GPIO${pin} is already assigned to ${named.join(", ")} on this controller.`
      );
    }
    return { errors, warnings: result.warnings };
  };

  // Hardwired on-board output stage for the configured pin (relay / buzzer).
  // Known before the class section so load terminals can be omitted for
  // on-board channels (their screws are not in the pin profile).
  const onboardFeatureNow =
    signalPin !== null && signalPin !== undefined
      ? (board?.board_layout?.onboardFeatures ?? []).find(
          (f) => f.gpioPin === signalPin
        ) ?? null
      : null;
  const hardOnboardNow = Boolean(
    onboardFeatureNow &&
      entity.kind !== "sensor" &&
      (onboardFeatureNow.kind === "relay" || onboardFeatureNow.kind === "buzzer")
  );

  // ---------------- Entity class / terminal model ----------------
  let classTypeLabel: string;
  let classInterfaceLabel: string;
  let classSignal: string;
  let classTerminals: WireDiagramTerminal[];
  let sensorDriverFacts: WireDiagramSensorDriverFacts | null = null;
  let relayLogic: string | null = null;
  let requirement: PinOperationRequirement;

  if (entity.kind === "switch") {
    const spec = RELAY_CLASS;
    classTypeLabel = "Relay switch channel";
    classInterfaceLabel = spec.interfaceLabel;
    classSignal = spec.signal;
    requirement = "digital_out";
    classTerminals = [...spec.terminals, ...(hardOnboardNow ? [] : spec.loadTerminals ?? [])].map((t) => ({ ...t, drawn: false }));
    relayLogic = entity.inverted ? "Active-LOW (inverted)" : "Active-HIGH (standard)";
    if (entity.inverted) {
      warnings.push(
        "Relay logic is Active-LOW (inverted): the channel energizes when the GPIO is LOW. Confirm the module matches this configuration."
      );
    }
  } else if (entity.kind === "device") {
    const spec = DEVICE_CLASS_SPECS[deviceType as SupportedDeviceType];
    classTypeLabel = spec.label;
    classInterfaceLabel = spec.interfaceLabel;
    classSignal = spec.signal;
    requirement = requiredPinCapabilityForDevice(deviceType as SupportedDeviceType);
    classTerminals = [...spec.terminals, ...(hardOnboardNow ? [] : spec.loadTerminals ?? [])].map((t) => ({ ...t, drawn: false }));
    if (deviceType === "tv") {
      warnings.push(
        "HomecoreOS does not document the TV control interface. Verify your module expects a 3.3V digital pulse train (e.g. an IR emitter) before wiring it to a GPIO."
      );
    }
    if (deviceType === "lock" || deviceType === "valve") {
      warnings.push(
        `${spec.label} circuits often switch mains or motor loads. The mains-side wiring is outside the scope of this diagram — follow the relay module and load requirements, and use a qualified electrician where mains is involved.`
      );
    }
    if (deviceType === "status_led") {
      warnings.push(
        "A status LED needs a series resistor (e.g. 330 Ω) between the GPIO and the anode. Connecting it directly can damage the GPIO."
      );
    }
    if (deviceType === "buzzer") {
      warnings.push(
        "Active buzzers sound from a steady level; passive buzzers need a tone. Match the firmware to the buzzer type you wired."
      );
    }
  } else {
    const driver = sensorDriver!;
    const measurement = sensorMeasurement;
    const spec = sensorInterfaceSpec(driver, measurement?.displayName ?? null);
    classTypeLabel = spec.typeLabel;
    classInterfaceLabel = spec.interfaceLabel;
    classSignal = spec.signal;
    requirement = requiredPinCapabilityForSensor(sensorType as SupportedSensorType);
    classTerminals = spec.terminals.map((t) => ({ ...t, drawn: false }));

    if (driver.busConfig.requiresPullUp) {
      warnings.push(
        `${driver.displayName} requires a pull-up resistor on its data line (about 4.7 kΩ, often mounted on the module). Without it the sensor will not be read reliably.`
      );
    }
    if (driver.interface === "i2c") {
      warnings.push(
        "I2C is an open-drain bus: SDA and SCL need pull-up resistors (4.7 kΩ typical, usually on the module). All I2C devices on this controller share the two lines."
      );
    }
    if (driver.interface === "adc") {
      warnings.push(
        "ADC inputs are 0–3.3V only. Anything higher must go through a voltage divider — a direct 5V+ signal will damage the input."
      );
    }

    const effectiveAddress =
      normalizeI2cAddress(entity.i2cAddress) ??
      normalizeI2cAddress(driver.busConfig.defaultAddresses?.[0]) ??
      null;
    if (entity.i2cAddress && entity.i2cAddress.trim() && !normalizeI2cAddress(entity.i2cAddress)) {
      warnings.push(
        `The stored I2C address "${entity.i2cAddress}" is not a valid 7-bit address (0x08–0x77). Fix it in the sensor's settings.`
      );
    }
    sensorDriverFacts = {
      driverId: driver.id,
      driverDisplayName: driver.displayName,
      driverVersion: driver.driverVersion ?? null,
      interfaceLabel: driver.interfaceLabel,
      hardwareVerificationStatus: driver.hardwareVerificationStatus,
      supportedModels: [...driver.supportedModels],
      measurements: [...driver.measurements],
      defaultUnit:
        driver.defaultUnits[sensorType as SupportedSensorType] ??
        measurement?.defaultUnit ??
        null,
      i2cAddress: effectiveAddress,
      defaultI2cAddresses: [...(driver.busConfig.defaultAddresses ?? [])],
      requiresPullUp: Boolean(driver.busConfig.requiresPullUp),
      minIntervalMs: driver.busConfig.minIntervalMs ?? null,
      debounceMs: driver.busConfig.debounceMs ?? null,
      samplesPerRead: driver.busConfig.samplesPerRead ?? null,
    };
  }

  const signalTerminal = classTerminals.find((t) => t.role === "signal") ?? classTerminals[0]!;
  const powerTerminal = classTerminals.find((t) => t.role === "power") ?? null;
  const groundTerminal = classTerminals.find((t) => t.role === "ground") ?? null;

  // ---------------- Signal leg(s) ----------------
  const usesI2c = entity.kind === "sensor" && sensorDriver?.interface === "i2c";
  const signalType = usesI2c ? "i2c" : sensorDriver?.interface ?? "gpio";
  const isBus = signalType === "i2c" || signalType === "onewire";

  const signalPinNow = signalPin!;
  const onboardFeature = onboardFeatureForPin(signalPinNow);
  const sharesSignal = shareableNames(signalPinNow, siblingIndex, entity.kind === "sensor" ? sensorType : null);

  const applyValidation = (
    pin: number,
    req: PinOperationRequirement
  ): { errors: string[]; warnings: string[] } =>
    validatePin(pin, req, entity.kind === "sensor" ? sensorType : null);

  const signalCheck = applyValidation(signalPinNow, requirement);
  const signalErrors = [...signalCheck.errors];
  const signalWarnings = [...signalCheck.warnings];

  if (entity.kind === "sensor" && sensorDriver) {
    const pinDef = pinDefs.get(signalPinNow);
    if (
      pinDef &&
      sensorDriver.requiresBidirectionalGpio &&
      (pinDef.restrictions.input_only || !pinDef.capabilities.digital_out)
    ) {
      signalErrors.push(
        `GPIO${signalPinNow} is input-only and cannot drive ${sensorDriver.displayName}, which requires bidirectional GPIO signaling.`
      );
    }
    if (capabilityProfile) {
      const hardOnboard = [
        ...capabilityProfile.onboardPeripherals.relays,
        ...capabilityProfile.onboardPeripherals.buzzers,
      ];
      if (hardOnboard.includes(signalPinNow)) {
        signalErrors.push(
          `GPIO${signalPinNow} is hardwired to on-board output circuitry on ${board!.model} and cannot be used for ${sensorDriver.displayName}.`
        );
      }
    }
    // Reused by an on-board non-output part (LED, button, …): not fatal.
    for (const f of layout?.onboardFeatures ?? []) {
      if (f.gpioPin === signalPinNow && f.kind !== "relay" && f.kind !== "buzzer") {
        signalWarnings.push(`GPIO${signalPinNow} is shared with the on-board ${f.label} (${f.kind}).`);
      }
    }
    // Pull-up the pin cannot provide internally.
    if (sensorDriver.busConfig.requiresPullUp && pinDefs.get(signalPinNow) && !pinDefs.get(signalPinNow)!.capabilities.pull_up) {
      signalWarnings.push(
        `GPIO${signalPinNow} does not document an internal pull-up — add an external resistor.`
      );
    }
  }

  // Reused by an on-board non-output part (LED, button, …): not fatal.
  // (Already emitted inside the sensor branch above.)
  if (entity.kind !== "sensor") {
    for (const f of layout?.onboardFeatures ?? []) {
      if (f.gpioPin === signalPinNow && f.kind !== "relay" && f.kind !== "buzzer") {
        signalWarnings.push(`GPIO${signalPinNow} is shared with the on-board ${f.label} (${f.kind}).`);
      }
    }
  }

  const kindFor = (errors: string[], shared: string[], bus: boolean): WireDiagramConnectionKind => {
    if (errors.length > 0) return "Pin Conflict / Invalid";
    if (bus || shared.length > 0) return "Shared Bus (Logical)";
    return "Configured (Logical)";
  };

    const pushSignalLike = (
    terminal: WireDiagramTerminal,
    pin: number,
    signalText: string,
    voltage: string,
    shared: string[],
    errors: string[],
    extraWarnings: string[],
    detail: string,
    bus: boolean,
    onboardLabel?: string | null
  ) => {
    const row = anchorConnection(
      pin,
      terminal,
      onboardLabel ? { onboardLabel } : undefined
    );
    row.signal = signalText;
    row.voltage = voltage;
    row.kind = kindFor(errors, shared, bus);
    row.warnings = [...errors, ...extraWarnings];
    row.sharedWith = shared;
    row.detail = detail;
    if (row.placement === "none" && errors.length === 0 && lookup.layoutDocumented) {
      // Not on any documented pad → cannot map.
      row.kind = "Pin Conflict / Invalid";
      row.warnings = [
        ...row.warnings,
        `GPIO${pin} is not present on this board's documented headers or solder pads.`,
      ];
      row.detail = `GPIO${pin} (configured) does not map to any pad this board profile documents — it cannot be wired.`;
    }
    push(row);
    return row;
  };

  if (usesI2c) {
    const sdaTerminal = classTerminals.find((t) => t.id === "sda")!;
    const sclTerminal = classTerminals.find((t) => t.id === "scl")!;
    const address = sensorDriverFacts?.i2cAddress ?? null;
    const addrText = address ? ` Address ${address}.` : "";
    const busNote =
      assignedPin === null
        ? " on the board's documented default I2C bus"
        : "";
    pushSignalLike(
      sdaTerminal,
      signalPinNow,
      "I2C SDA",
      gpioLogicVoltage,
      sharesSignal,
      signalErrors,
      signalWarnings,
      `${i2cFromDefaultBus ? "Default I2C bus" : "Configured"} SDA: GPIO${signalPinNow} → module SDA.${addrText}${busNote}`.replace(" .", "."),
      true
    );

    const sclPin = i2cSclPin!;
    const sclCheck = applyValidation(sclPin, "i2c");
    const sclShares = shareableNames(sclPin, siblingIndex, sensorType);
    const sclErrors = [...sclCheck.errors];
    const sclWarnings = [...sclCheck.warnings];
    if (assignedPin !== null) {
      sclWarnings.push(
        "The sensor was assigned an explicit SDA line; SCL is shown from the board's documented default I2C bus. Confirm your firmware bit-bangs or drives the same SCL."
      );
    }
    pushSignalLike(
      sclTerminal,
      sclPin,
      "I2C SCL",
      gpioLogicVoltage,
      sclShares,
      sclErrors,
      sclWarnings,
      `Default I2C bus SCL: GPIO${sclPin} → module SCL.${assignedPin !== null ? " (Board default — verify against firmware.)" : ""}`,
      true
    );
  } else {
    const bus = isBus;
    const voltage =
      requirement === "adc" ? "0–3.3V" : gpioLogicVoltage;
    const signalText =
      requirement === "pwm"
        ? "PWM output"
        : requirement === "adc"
          ? "ADC input"
          : entity.kind === "sensor"
            ? sensorDriver?.interface === "onewire"
              ? "1-Wire data"
              : sensorDriver?.interface === "gpio_single_wire"
                ? "Single-wire data"
                : sensorDriver?.id === "reed"
                  ? "Dry contact (GPIO input)"
                  : "Digital input"
            : requirement === "digital_out"
              ? "Digital output"
              : "Digital input";
    // "On-board" placement applies only when the pin is hardwired to an on-board
    // output stage (relay / buzzer) that *replaces* an external module — for
    // sensors that pin is an error, for LEDs/buttons it is merely a shared line
    // and the external wire still exists.
    const hardOnboardLabel =
      onboardFeature && (onboardFeature.kind === "relay" || onboardFeature.kind === "buzzer")
        ? onboardFeature.label
        : null;
    const featureLabel = hardOnboardLabel;
    const sharedForKind = sharesSignal;
    const detail = featureLabel
      ? `GPIO${signalPinNow} is wired on the PCB to ${featureLabel}${onboardFeature ? ` (${onboardFeature.kind})` : ""} — no external control wiring for the control leg. HomecoreOS does not cover the mains-side wiring of the load.`
      : lookup.layoutDocumented
        ? `Configured ${signalText} from GPIO${signalPinNow}${pinDefs.get(signalPinNow)?.board_pin_name ? ` (pad ${pinDefs.get(signalPinNow)?.board_pin_name})` : ""} to the module's ${signalTerminal.label} terminal.${sharedForKind.length > 0 ? ` Shared with ${sharedForKind.join(", ")}.` : ""}`
        : `GPIO${signalPinNow} is configured for this channel; the board profile documents no layout, so the wire cannot be drawn. See the Connections table.`;
    pushSignalLike(
      signalTerminal,
      signalPinNow,
      signalText,
      voltage,
      sharedForKind,
      signalErrors,
      signalWarnings,
      detail,
      bus,
      featureLabel
    );
  }

  // When the configured pin is hardwired to an on-board output stage (relay /
  // buzzer) there is no external module, so no ground or supply leg is drawn.
  const onboardOnly = Boolean(
    entity.kind !== "sensor" &&
      onboardFeature &&
      (onboardFeature.kind === "relay" || onboardFeature.kind === "buzzer")
  );

  // ---------------- Ground reference leg ----------------
  if (groundTerminal && !onboardOnly) {
    const gAnchor = lookup.groundPin;
    const extraGnd =
      (layout?.extraPads?.pins ?? []).find((p) => p.kind === "ground") ?? null;
    const row = baseConnection(null, null, groundTerminal, { id: "pending" });
    if (gAnchor) {
      row.pinName = gAnchor.hp.pinName;
      row.headerName = gAnchor.hp.headerName;
      row.headerPosition = gAnchor.hp.position;
      row.headerKey = `${gAnchor.hp.headerName}:${gAnchor.hp.position}`;
      row.side = gAnchor.side;
      row.index = gAnchor.index;
      row.placement = "header";
    } else if (extraGnd) {
      row.placement = "extra_pad";
      row.extraPadName = extraGnd.pinName;
      row.pinName = extraGnd.pinName;
      row.headerName = extraGnd.headerName;
      row.headerPosition = extraGnd.position;
      row.headerKey = `${extraGnd.headerName}:${extraGnd.position}`;
    } else {
      row.placement = "none";
      warnings.push(
        "The board profile does not document a GND pad, so the ground reference is not drawn. Connect ground according to the board's own documentation."
      );
    }
    row.signal = "GND";
    row.voltage = "0V (reference)";
    row.kind = "Reference Rail";
    row.detail =
      row.placement === "none"
        ? "Ground reference — not drawn: the board profile documents no GND pad."
        : `Ground reference at pad ${row.pinName}${row.headerName ? ` (${row.headerName}, pin ${row.headerPosition})` : ""} — connect the module's ${groundTerminal.label} terminal here.`;
    push(row);
  }

  // ---------------- Supply leg (advisory — never auto-wired) ----------------
  if (powerTerminal && !onboardOnly) {
    const row = baseConnection(null, null, powerTerminal, { id: "pending" });
    const rails = documentedRails.length > 0 ? documentedRails.join(" and ") : null;
    row.placement = "none";
    row.signal = "Supply (not auto-wired)";
    row.voltage = NOT_DOCUMENTED;
    row.kind = "Advisory Warning";
    row.detail = rails
      ? `HomecoreOS does not document the supply requirement of this module class, so no rail is chosen for you. Connect VCC to a rail matching your module's datasheet. Documented rails on this board: ${rails}.`
      : "HomecoreOS does not document the supply requirement of this module class, and this board profile documents no rails. Connect VCC to a rail matching your module's datasheet, per the board's own documentation.";
    row.warnings = [
      "Module supply requirement is not documented — choose a rail per your module's datasheet.",
    ];
    push(row);
  }

  // ---------------- Terminal drawn flags ----------------
  for (const conn of connections) {
    const term = classTerminals.find((t) => t.id === conn.terminalId);
    if (term) {
      term.drawn = conn.placement === "header" || conn.placement === "extra_pad";
    }
  }

  // ---------------- Datasheet & result assembly ----------------
  const boardFacts = boardFactsOf(board!);
  const entityFacts: WireDiagramEntityFacts = {
    kind: entity.kind,
    typeLabel: classTypeLabel,
    manufacturer: NOT_DOCUMENTED,
    interfaceLabel: classInterfaceLabel,
    signalLabel: classSignal,
    operatingVoltage:
      requirement === "adc" ? "0–3.3V input (driver spec)" : NOT_DOCUMENTED,
    currentDraw: NOT_DOCUMENTED,
    driver: sensorDriverFacts,
    relayLogic,
    terminals: classTerminals,
  };

  const totals = {
    connections: connections.length,
    shared: connections.filter((c) => c.kind === "Shared Bus (Logical)").length,
    invalid: connections.filter((c) => c.kind === "Pin Conflict / Invalid").length,
    advisory: connections.filter((c) => c.kind === "Advisory Warning").length,
  };

  // ---------------- Circuit synthesis (device-specific) ----------------
  const signalAnchor =
    signalPinNow !== null && signalPinNow !== undefined
      ? lookup.byGpio.get(signalPinNow) ?? null
      : null;
  const signalExtra =
    signalPinNow !== null && signalPinNow !== undefined
      ? lookup.extraByGpio.get(signalPinNow) ?? null
      : null;
  const groundAnchor = lookup.groundPin
    ? {
        headerKey: `${lookup.groundPin.hp.headerName}:${lookup.groundPin.hp.position}`,
        extraPadName: null,
        label: lookup.groundPin.hp.pinName ?? "GND",
      }
    : null;
  const circuit = buildCircuitDesign({
    entity,
    boardModel: board!.model,
    terminals: classTerminals,
    signalPin: signalPinNow,
    i2cSclPin: entity.kind === "sensor" && isI2cSensor ? i2cSclPin : null,
    gpioHeaderKey: signalAnchor
      ? `${signalAnchor.hp.headerName}:${signalAnchor.hp.position}`
      : null,
    gpioExtraPadName: signalExtra?.pinName ?? null,
    rails: {
      fiveVolt: findRailAnchor(board!, /^5/),
      threeThreeVolt: findRailAnchor(board!, /3\.?3|3V3/i),
      ground: groundAnchor,
    },
    onboardFeature:
      hardOnboardNow && onboardFeatureNow
        ? {
            label: onboardFeatureNow.label,
            kind: onboardFeatureNow.kind,
          }
        : null,
    sensorDriver: sensorDriver ?? null,
    unavailable: false,
  });

  return {
    state: "ready",
    unavailableReasons: [],
    circuit,
    entityName: entity.name,
    entityKind: entity.kind,
    entityOnline: entity.isOnline ?? null,
    controllerName: controller?.name ?? null,
    roomName: params.roomName ?? null,
    board: boardFacts,
    entity: entityFacts,
    terminals: classTerminals,
    connections,
    warnings,
    allPlacementDocumented: connections.every((c) => c.placement !== "none"),
    totals,
  };
}
