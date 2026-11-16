/**
 * Smart Home Planner — required external hardware.
 *
 * Lists what the customer must add around the controller boards. Quantities are
 * derived from the validated pin plan, so the list never includes hardware for
 * a connection that could not be wired.
 */
import type {
  PlannerAllocation,
  PlannerDeviceCategory,
  PlannerExternalHardwareItem,
  PlannerNormalizedRequirements,
} from "./types";

const COMMON_RELAY_MODULE_SIZES = [1, 2, 4, 8, 16];

/** A neutral example of how many relay modules cover `channels` relay channels. */
export function suggestRelayModules(channels: number): string {
  if (channels <= 0) return "";
  const single = COMMON_RELAY_MODULE_SIZES.find((size) => size >= channels);
  if (single) return `one ${single}-channel module`;
  const largest = COMMON_RELAY_MODULE_SIZES[COMMON_RELAY_MODULE_SIZES.length - 1]!;
  const full = Math.floor(channels / largest);
  const rest = channels % largest;
  const tail = rest > 0 ? COMMON_RELAY_MODULE_SIZES.find((size) => size >= rest) : null;
  return tail ? `${full} × ${largest}-channel + one ${tail}-channel module` : `${full} × ${largest}-channel modules`;
}

const SENSOR_HARDWARE: Partial<Record<PlannerDeviceCategory, { label: string; detail: string }>> = {
  motion_sensors: {
    label: "Motion sensor modules (PIR)",
    detail: "One per motion sensor, with a 3.3 V-compatible digital output.",
  },
  contact_sensors: {
    label: "Door / window contacts (reed switches)",
    detail: "One magnetic contact per door or window sensor.",
  },
  gas_smoke_sensors: {
    label: "Gas / smoke sensor modules",
    detail:
      "One per sensor, with an analog output of at most 3.3 V. For monitoring only, never as a replacement for certified alarms.",
  },
  leak_sensors: {
    label: "Water-leak probes",
    detail: "One per sensor, with a contact (dry) output.",
  },
};

export function buildPlannerExternalHardware(
  requirements: PlannerNormalizedRequirements,
  allocation: PlannerAllocation
): PlannerExternalHardwareItem[] {
  const items: PlannerExternalHardwareItem[] = [];
  const controllers = allocation.controllers;
  if (controllers.length === 0) return items;

  const assignments = controllers.flatMap((c) => c.assignments);
  const countCategory = (category: PlannerDeviceCategory) =>
    assignments.filter((a) => a.category === category).length;

  const relayChannels = controllers.reduce((sum, c) => sum + c.relayChannels, 0);
  if (relayChannels > 0) {
    const breakdown = controllers
      .filter((c) => c.relayChannels > 0)
      .map(
        (c) =>
          `Controller ${c.index}: ${c.relayChannels} channel${c.relayChannels === 1 ? "" : "s"} (for example ${suggestRelayModules(c.relayChannels)})`
      )
      .join("; ");
    items.push({
      kind: "relay_module",
      label: "Relay modules",
      quantity: relayChannels,
      unit: relayChannels === 1 ? "relay channel" : "relay channels",
      detail: `${breakdown}. Choose modules whose inputs switch reliably from a 3.3 V signal and whose contacts are rated above each load.`,
      required: true,
    });
  }

  const speedControllers = assignments.filter((a) => a.demand === "pwm").length;
  if (speedControllers > 0) {
    items.push({
      kind: "fan_speed_controller",
      label: "Fan speed-controller modules",
      quantity: speedControllers,
      unit: speedControllers === 1 ? "module" : "modules",
      detail: "One per speed-controlled fan. Each must accept a 3.3 V PWM signal and be rated for its fan.",
      required: true,
    });
  }

  // Each curtain occupies two relay channels (open and close).
  const curtains = Math.floor(countCategory("curtains") / 2);
  if (curtains > 0) {
    items.push({
      kind: "curtain_controller",
      label: "Curtain motor interlock",
      quantity: curtains,
      unit: curtains === 1 ? "curtain" : "curtains",
      detail:
        "A motor controller with a built-in interlock, or interlocked relay wiring, so the open and close windings are never powered together.",
      required: true,
    });
  }

  const pumps = countCategory("pumps");
  if (pumps > 0) {
    items.push({
      kind: "motor_contactor",
      label: "Contactors or motor-rated relays",
      quantity: pumps,
      unit: pumps === 1 ? "pump" : "pumps",
      detail: "One per pump, rated for the motor's starting current and switched by the controller's relay channel.",
      required: true,
    });
  }

  const climate = countCategory("climate_sensors");
  if (climate > 0) {
    const onBus = assignments.filter(
      (a) => a.category === "climate_sensors" && a.demand === "i2c_bus"
    ).length;
    const singleWire = climate - onBus;
    const parts: string[] = [];
    if (singleWire > 0) parts.push(`${singleWire} single-wire (DHT22-type)`);
    if (onBus > 0) parts.push(`${onBus} I2C (BME280-type)`);
    items.push({
      kind: "sensor_module",
      label: "Temperature & humidity sensors",
      quantity: climate,
      unit: climate === 1 ? "sensor" : "sensors",
      detail: `${parts.join(" and ")}.`,
      required: true,
    });
  }

  for (const category of ["motion_sensors", "contact_sensors", "gas_smoke_sensors", "leak_sensors"] as const) {
    const count = countCategory(category);
    const meta = SENSOR_HARDWARE[category];
    if (count > 0 && meta) {
      items.push({
        kind: "sensor_module",
        label: meta.label,
        quantity: count,
        unit: count === 1 ? "sensor" : "sensors",
        detail: meta.detail,
        required: true,
      });
    }
  }

  items.push({
    kind: "power_supply",
    label: "Power supplies",
    quantity: controllers.length,
    unit: controllers.length === 1 ? "controller" : "controllers",
    detail:
      relayChannels > 0
        ? "A stable USB supply for each controller, plus a separate 5 V supply for its relay modules sized for all relay coils."
        : "A stable USB supply for each controller.",
    required: true,
  });

  const environment = requirements.installation.environment;
  items.push({
    kind: "enclosure",
    label: "Enclosures",
    quantity: controllers.length,
    unit: controllers.length === 1 ? "controller" : "controllers",
    detail:
      environment === "outdoor"
        ? "A weatherproof enclosure (IP65 or better) for each controller and its relay modules."
        : environment === "damp"
          ? "A sealed enclosure (IP65 or better) for each controller and its relay modules."
          : "An insulated enclosure that keeps each controller and its relay modules away from touch and from mains wiring.",
    required: true,
  });

  return items;
}
