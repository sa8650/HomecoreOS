/**
 * Shared presentation helpers for the Interactive Wire Diagram surfaces
 * (canvas, modal, tests). Pure functions only — no side effects.
 */
import type {
  GpioPinDefinition,
  WireDiagramConnection,
  WireDiagramConnectionKind,
} from "@homecoreos/shared";

export const WIRE_COLORS = {
  signal: "#fb923c",
  pwm: "#f472b6",
  adc: "#a78bfa",
  sda: "#38bdf8",
  scl: "#fbbf24",
  onewire: "#34d399",
  gnd: "#cbd5e1",
  invalid: "#f87171",
} as const;

/** Colour for a logical wire, by the electrical signal it carries. */
export function wireColor(conn: WireDiagramConnection): string {
  if (conn.kind === "Pin Conflict / Invalid") return WIRE_COLORS.invalid;
  if (conn.role === "ground") return WIRE_COLORS.gnd;
  switch (conn.signal) {
    case "PWM output":
      return WIRE_COLORS.pwm;
    case "ADC input":
      return WIRE_COLORS.adc;
    case "I2C SDA":
      return WIRE_COLORS.sda;
    case "I2C SCL":
      return WIRE_COLORS.scl;
    case "1-Wire data":
    case "Single-wire data":
      return WIRE_COLORS.onewire;
    default:
      return WIRE_COLORS.signal;
  }
}

export function wireDash(conn: WireDiagramConnection): string | undefined {
  if (conn.kind === "Pin Conflict / Invalid") return "7 6";
  if (conn.kind === "Reference Rail") return "2 5";
  return undefined;
}

export function wireLabel(conn: WireDiagramConnection): string {
  if (conn.role === "ground") return conn.pinName ?? "GND";
  if (conn.pin !== null) return `GPIO${conn.pin}`;
  if (conn.placement === "extra_pad") return conn.extraPadName ?? "PAD";
  return conn.terminalLabel;
}

/** Short capability tags for a documented GPIO, e.g. ["OUT", "PWM"]. */
export function pinCapabilityList(def: GpioPinDefinition | undefined): string[] {
  if (!def) return [];
  const caps: string[] = [];
  if (def.capabilities.digital_in) caps.push("IN");
  if (def.capabilities.digital_out) caps.push("OUT");
  if (def.capabilities.pwm) caps.push("PWM");
  if (def.capabilities.adc) caps.push("ADC");
  if (def.capabilities.i2c) caps.push("I2C");
  if (def.capabilities.spi) caps.push("SPI");
  if (def.capabilities.uart) caps.push("UART");
  if (def.capabilities.touch) caps.push("TOUCH");
  return caps;
}

export interface ConnectionStatus {
  label: string;
  badgeVariant:
    | "success-outline"
    | "info-outline"
    | "secondary"
    | "warning-light"
    | "destructive-light";
}

/** User-facing status for a connection row — always a *logical* statement. */
export function connectionStatus(kind: WireDiagramConnectionKind): ConnectionStatus {
  switch (kind) {
    case "Configured (Logical)":
      return { label: "Configured · Logical", badgeVariant: "success-outline" };
    case "Shared Bus (Logical)":
      return { label: "Shared bus · Logical", badgeVariant: "info-outline" };
    case "Reference Rail":
      return { label: "Reference rail", badgeVariant: "secondary" };
    case "Advisory Warning":
      return { label: "Advisory only", badgeVariant: "warning-light" };
    case "Pin Conflict / Invalid":
      return { label: "Invalid pin", badgeVariant: "destructive-light" };
  }
}
