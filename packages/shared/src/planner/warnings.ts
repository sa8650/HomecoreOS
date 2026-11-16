/**
 * Smart Home Planner — (7) warning generation.
 *
 * Every warning states five things in plain language: how serious it is, what
 * the problem means, which requirement or catalog fact caused it, what happens
 * if it is ignored, and a practical way to resolve it.
 *
 * Severity says how serious a warning is; `effect` says what it does to the
 * plan. They are separate on purpose: a mains-safety warning is serious but
 * does not stop a plan from being ready, while a missing firmware release does.
 */
import { describePlannerDemand } from "./allocation";
import type {
  PlannerAllocation,
  PlannerAvailability,
  PlannerBoardCapability,
  PlannerBoardRecord,
  PlannerFirmwareEvaluation,
  PlannerNormalizedRequirements,
  PlannerWarning,
  PlannerWarningCategory,
  PlannerWarningCode,
  PlannerWarningEffect,
  PlannerWarningSeverity,
} from "./types";

const SEVERITY_ORDER: Record<PlannerWarningSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const CATEGORY_ORDER: Record<PlannerWarningCategory, number> = {
  electrical: 0,
  hardware: 1,
  firmware: 2,
  connectivity: 3,
  availability: 4,
  expansion: 5,
  information: 6,
};

export function sortPlannerWarnings(warnings: PlannerWarning[]): PlannerWarning[] {
  return [...warnings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] ||
      a.id.localeCompare(b.id)
  );
}

interface WarningText {
  title: string;
  meaning: string;
  cause: string;
  impact: string;
  resolution: string;
}

function make(
  code: PlannerWarningCode,
  severity: PlannerWarningSeverity,
  category: PlannerWarningCategory,
  effect: PlannerWarningEffect,
  text: WarningText,
  idSuffix?: string
): PlannerWarning {
  return { id: idSuffix ? `${code}:${idSuffix}` : code, code, severity, category, effect, ...text };
}

function n(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const STEP_LABEL = { home: "Home", devices: "Devices", installation: "Installation" } as const;

/** Warnings caused by the customer's answers alone, whatever board is chosen. */
export function generatePlannerRequirementWarnings(
  requirements: PlannerNormalizedRequirements
): PlannerWarning[] {
  const warnings: PlannerWarning[] = [];
  const { installation, totals } = requirements;

  for (const item of requirements.missing) {
    warnings.push(
      item.blocking
        ? make(
            "incomplete_information",
            "high",
            "information",
            "blocks_plan",
            {
              title: "More information is needed",
              meaning: item.message,
              cause: `This was left empty in the ${STEP_LABEL[item.step]} step.`,
              impact: "The planner cannot recommend hardware until it is answered.",
              resolution: `Go back to the ${STEP_LABEL[item.step]} step and complete it.`,
            },
            item.code
          )
        : make(
            "incomplete_information",
            "low",
            "information",
            "advisory",
            {
              title: "A detail was assumed",
              meaning: item.message,
              cause: `This was left empty or marked "not sure" in the ${STEP_LABEL[item.step]} step.`,
              impact: "The recommendation still stands, but this point could not be checked.",
              resolution: `Fill it in on the ${STEP_LABEL[item.step]} step for a more precise plan.`,
            },
            item.code
          )
    );
  }

  if (installation.wifi === "none") {
    warnings.push(
      make("unsupported_connectivity", "critical", "connectivity", "blocks_plan", {
        title: "No Wi-Fi at the controller location",
        meaning:
          "HomecoreOS controllers reach the platform over Wi-Fi. Without it a controller cannot be paired, controlled or updated.",
        cause: "You answered that no Wi-Fi is available where the controllers will be installed.",
        impact:
          "No board in the Board Library can go online at this location, so the plan cannot be installed as specified.",
        resolution:
          "Extend Wi-Fi to the controller location with an access point or mesh node, then run the planner again.",
      }, "no_wifi")
    );
  } else if (installation.wifi === "weak") {
    warnings.push(
      make("weak_wifi", "medium", "connectivity", "action_required", {
        title: "Weak Wi-Fi at the controller location",
        meaning: "A weak signal makes controllers drop offline and can interrupt firmware updates.",
        cause: "You described the Wi-Fi signal at the controller location as weak.",
        impact:
          "Devices may respond slowly or appear offline, and wireless firmware updates may fail.",
        resolution: "Add an access point or mesh node near the controllers before installing them.",
      })
    );
  }

  if (installation.ethernet === "required") {
    warnings.push(
      make("unsupported_connectivity", "critical", "connectivity", "blocks_plan", {
        title: "Wired Ethernet is not available",
        meaning:
          "No board in the Board Library documents a wired Ethernet port, and HomecoreOS never assumes an interface that is not documented.",
        cause: "You marked wired Ethernet as required.",
        impact: "No validated configuration can meet this requirement.",
        resolution:
          'Change Ethernet to "Nice to have" or "Not needed" and use Wi-Fi, or ask your HomecoreOS provider whether an Ethernet-capable board will be added to the Board Library.',
      }, "ethernet_required")
    );
  } else if (installation.ethernet === "preferred") {
    warnings.push(
      make("unsupported_connectivity", "low", "connectivity", "advisory", {
        title: "Ethernet preference cannot be met",
        meaning: "No board in the Board Library documents a wired Ethernet port.",
        cause: "You said wired Ethernet would be nice to have.",
        impact: "The plan connects every controller over Wi-Fi instead.",
        resolution: "Make sure Wi-Fi coverage at each controller location is reliable.",
      }, "ethernet_preferred")
    );
  }

  if (
    totals.sensors > 0 &&
    (installation.sensorWiring === "wireless" || installation.sensorWiring === "rs485")
  ) {
    const kind = installation.sensorWiring === "wireless" ? "Wireless" : "RS-485 / Modbus";
    warnings.push(
      make("unsupported_sensor_interface", "critical", "hardware", "blocks_plan", {
        title: `${kind} sensors are not supported`,
        meaning: `HomecoreOS reads sensors wired to a controller pin or to its I2C bus. It has no sensor type for ${kind.toLowerCase()} sensors.`,
        cause: `You chose ${kind.toLowerCase()} as the way sensors connect, and the plan contains ${n(
          totals.sensors,
          "sensor",
          "sensors"
        )}.`,
        impact: `${n(totals.sensors, "sensor", "sensors")} cannot be connected, so the plan is not supported as specified.`,
        resolution:
          "Choose sensors that wire directly to the controller, or remove the sensors from the plan.",
      }, "wiring")
    );
  }

  const cable = installation.maxCableRunMeters;
  if (cable !== null && totals.i2cSensors > 0 && cable > 3) {
    warnings.push(
      make("unsupported_sensor_interface", "high", "hardware", "action_required", {
        title: "I2C sensors are not suited to long cables",
        meaning:
          "The I2C bus is designed for short connections inside an enclosure. Over longer cables its readings become unreliable.",
        cause: `You chose I2C bus sensors and a longest cable run of ${cable} m.`,
        impact: "Temperature and humidity readings may drop out or be wrong.",
        resolution:
          'Choose "wired directly" sensors, which tolerate longer cables, or keep each I2C sensor within about 1–3 m of its controller.',
      }, "i2c_distance")
    );
  }
  if (cable !== null && totals.sensors > 0 && cable > 20) {
    warnings.push(
      make("long_cable_run", "medium", "hardware", "action_required", {
        title: "Long sensor cable runs",
        meaning: "Low-voltage sensor signals weaken and pick up interference over long cables.",
        cause: `The longest cable run to a sensor is ${cable} m.`,
        impact:
          "Sensors at the far end may read unreliably; single-wire temperature and humidity sensors are typically limited to about 20 m.",
        resolution:
          "Add a controller location closer to the distant rooms, or use shielded cable and verify the readings after installation.",
      })
    );
  }

  if (totals.relayChannels > 0) {
    warnings.push(
      make("mains_safety", "high", "electrical", "action_required", {
        title: "Mains wiring must be done safely",
        meaning:
          "Controller pins carry a 3.3 V signal. They can only tell a relay to switch; they must never be connected to mains voltage or straight to a load.",
        cause: `Your plan switches ${n(
          totals.relayChannels,
          "mains-powered circuit",
          "mains-powered circuits"
        )} (lights, fans, sockets, pumps or appliances).`,
        impact: "Incorrect mains wiring can cause electric shock or fire, or destroy the controller.",
        resolution:
          "Have a qualified electrician install the relay modules and mains wiring, with every relay rated above the load it switches and every circuit protected by its own breaker.",
      })
    );
  }

  if (totals.byCategory.pumps.quantity > 0) {
    warnings.push(
      make("inductive_load", "medium", "electrical", "action_required", {
        title: "Pumps and motors need a suitably rated switch",
        meaning:
          "Motors draw several times their normal current for a moment when they start, which can weld the contacts of a small relay.",
        cause: `Your plan includes ${n(totals.byCategory.pumps.quantity, "pump", "pumps")}.`,
        impact: "An under-rated relay may stick on or fail early.",
        resolution:
          "Switch each pump through a contactor or a relay rated for motor (inductive) loads, driven by the controller's relay channel.",
      })
    );
  }

  if (totals.byCategory.curtains.independent > 0) {
    warnings.push(
      make("curtain_interlock", "high", "electrical", "action_required", {
        title: "Curtain motors need an interlock",
        meaning:
          "A curtain motor has separate open and close windings, and powering both at once can burn it out. HomecoreOS has no dedicated curtain device type: it drives the two directions as two separate relays and does not prevent this by itself.",
        cause: `Your plan includes ${n(
          totals.byCategory.curtains.independent,
          "separately controlled curtain",
          "separately controlled curtains"
        )}.`,
        impact: "Without an interlock, a wrong command or automation could power both directions.",
        resolution:
          "Use a curtain motor controller with a built-in interlock, or wire the two relays so only one direction can be powered at a time, and make sure the motor has its own limit switches.",
      })
    );
  }

  if (totals.pwmChannels > 0) {
    warnings.push(
      make("speed_controller_required", "medium", "hardware", "action_required", {
        title: "Fan speed control needs a speed-controller module",
        meaning:
          "A relay can only switch a fan fully on or off. To change speed, the controller sends a PWM signal to a separate module that regulates the fan.",
        cause: `${n(totals.pwmChannels, "fan was", "fans were")} marked as needing speed control.`,
        impact: "Without a compatible module the fan can only run at full speed or not at all.",
        resolution:
          'Fit each of these fans with a speed-controller module that accepts a 3.3 V PWM signal and is rated for the fan. In HomecoreOS, add it as a "PWM dimmer" device on the suggested pin.',
      })
    );
  }

  if (totals.byCategory.gas_smoke_sensors.quantity > 0) {
    warnings.push(
      make("life_safety_sensor", "high", "hardware", "action_required", {
        title: "Gas and smoke sensors are for monitoring only",
        meaning:
          "HomecoreOS has no dedicated gas or smoke sensor type. The planner connects these sensors as a generic analog voltage input, which reports a raw level and is not a certified alarm.",
        cause: `Your plan includes ${n(
          totals.byCategory.gas_smoke_sensors.quantity,
          "gas or smoke sensor",
          "gas or smoke sensors"
        )}.`,
        impact:
          "Readings depend on Wi-Fi, power and calibration, so they must not be your only protection.",
        resolution:
          "Keep certified stand-alone smoke and gas alarms installed, and treat the HomecoreOS readings as an additional notification only.",
      })
    );
  }

  if (installation.environment === "damp" || installation.environment === "outdoor") {
    const outdoor = installation.environment === "outdoor";
    warnings.push(
      make("installation_environment", "medium", "electrical", "action_required", {
        title: outdoor
          ? "Outdoor installation needs a weatherproof enclosure"
          : "Damp location needs a sealed enclosure",
        meaning: "Bare controller boards and relay modules have no protection against moisture.",
        cause: `You selected ${outdoor ? "an outdoor" : "a damp"} installation location.`,
        impact: "Moisture causes corrosion, short circuits and a shock hazard.",
        resolution: outdoor
          ? "Mount controllers and relay modules in a weatherproof enclosure (IP65 or better), shaded from direct sun, with sealed cable entries."
          : "Mount controllers and relay modules in a sealed enclosure (IP65 or better) and keep all mains terminals covered.",
      })
    );
  } else if (installation.environment === "electrical_panel") {
    warnings.push(
      make("installation_environment", "medium", "connectivity", "action_required", {
        title: "A metal panel can block Wi-Fi",
        meaning: "A metal distribution board shields radio signals.",
        cause: "You plan to install controllers inside the electrical panel.",
        impact: "Controllers inside the panel may have a weak or unstable connection.",
        resolution:
          "Check the Wi-Fi signal with the panel door closed. If it is weak, mount the controller in a plastic enclosure beside the panel, and keep low-voltage wiring separate from mains wiring.",
      })
    );
  }

  return warnings;
}

export interface PlannerPlanWarningContext {
  requirements: PlannerNormalizedRequirements;
  board: PlannerBoardRecord;
  capability: PlannerBoardCapability;
  allocation: PlannerAllocation;
  firmware: PlannerFirmwareEvaluation;
  availability: PlannerAvailability;
}

/** Warnings that depend on the specific board, its firmware and the pin plan. */
export function generatePlannerPlanWarnings(ctx: PlannerPlanWarningContext): PlannerWarning[] {
  const { requirements, board, capability, allocation, firmware, availability } = ctx;
  const warnings: PlannerWarning[] = [];
  const boardName = `${board.manufacturer} ${board.model}`.trim();
  const { installation, totals } = requirements;
  const controllerCount = allocation.controllers.length;
  const unallocated = allocation.unallocated;
  const version = firmware.release ? `v${firmware.release.version.replace(/^v/i, "")}` : null;
  const blocked: PlannerWarningSeverity = "critical";

  // --- Board status ---------------------------------------------------------
  if (capability.status.code === "unsupported") {
    warnings.push(
      make("board_unsupported", "critical", "hardware", "blocks_plan", {
        title: "Board is not supported",
        meaning: capability.status.detail,
        cause: `${boardName} has the status "Unsupported" in the Board Library.`,
        impact: "HomecoreOS cannot run on this board.",
        resolution: "Choose a board that is published and supported in the Board Library.",
      })
    );
  } else if (capability.status.code === "unverified") {
    warnings.push(
      make("unverified_board_specs", "high", "hardware", "blocks_installation", {
        title: "Board specifications are not verified",
        meaning: capability.status.isCustom
          ? "This is a custom board profile you entered yourself. HomecoreOS has not verified its pin map."
          : "This board's pin map has not yet been verified against its official documentation, so the fit check is provisional.",
        cause: `${boardName} has the status "${capability.status.label}".`,
        impact:
          "A wiring plan based on unverified pins could damage the board or simply not work, so the board is not presented as ready.",
        resolution: capability.status.isCustom
          ? "Check every pin against the manufacturer's pinout before wiring, or choose a verified board from the catalog."
          : "Choose a verified board, or wait until HomecoreOS has verified this one.",
      })
    );
  } else if (capability.status.code === "unpublished") {
    warnings.push(
      make("board_not_published", "high", "availability", "blocks_installation", {
        title: "Board is not published in the catalog",
        meaning:
          "The board exists in HomecoreOS but is not currently listed in the Board Library, so it cannot be selected when you add a controller.",
        cause: `${boardName} has the status "Not published in catalog".`,
        impact: "You cannot set up a controller with this board yet.",
        resolution: "Choose a published board, or wait until this board is published.",
      })
    );
  }

  if (!capability.evaluable) {
    warnings.push(
      make("unverified_board_specs", "critical", "hardware", "blocks_plan", {
        title: "Board has no usable pin map",
        meaning:
          "The board record does not contain a complete, valid pin map. HomecoreOS never assumes missing specifications are supported.",
        cause: capability.specIssues[0] ?? `${boardName} has no pin definitions on record.`,
        impact: "No wiring plan can be validated for this board.",
        resolution: "Choose a board with a verified pin map.",
      }, "no_pin_map")
    );
  }

  if (!capability.supportsWifi) {
    warnings.push(
      make("unsupported_connectivity", "critical", "connectivity", "blocks_plan", {
        title: "This board has no Wi-Fi",
        meaning:
          capability.connectivityNote ?? "The chip on this board has no built-in Wi-Fi radio.",
        cause: "HomecoreOS controllers connect to the platform over Wi-Fi.",
        impact: "The board cannot go online as a HomecoreOS controller.",
        resolution: "Choose a board with built-in Wi-Fi.",
      }, "board_wifi")
    );
  }

  // --- Capacity -------------------------------------------------------------
  const { pressure } = allocation;

  if (pressure.singleControllerLimit) {
    const count = unallocated.filter((u) => u.reason === "single_controller_limit").length;
    warnings.push(
      make("missing_expansion_modules", "critical", "expansion", "blocks_plan", {
        title: "More connections needed than one controller provides",
        meaning:
          "The devices at one location need more connections than a single controller has. HomecoreOS firmware cannot add pins to a controller with I/O-expander modules, so the only supported way to add capacity is another controller.",
        cause: "You chose not to allow additional controllers.",
        impact: `${n(count, "connection", "connections")} cannot be wired.`,
        resolution:
          "Allow additional controllers in the Installation step, or reduce the number of separately controlled devices.",
      })
    );
  }

  if (pressure.gpioShortage && !pressure.singleControllerLimit) {
    warnings.push(
      make(
        "insufficient_gpio_channels",
        allocation.feasible ? "medium" : blocked,
        "hardware",
        allocation.feasible ? "advisory" : "blocks_plan",
        {
          title: allocation.feasible ? "One controller is not enough" : "Not enough pins",
          meaning: `A single ${boardName} offers ${n(
            capability.counts.usable,
            "usable pin",
            "usable pins"
          )}, fewer than the connections needed at one location.`,
          cause: `Your plan needs ${n(totals.gpioChannels, "controller connection", "controller connections")}.`,
          impact: allocation.feasible
            ? `The plan uses ${n(controllerCount, "controller", "controllers")} and splits the devices between them.`
            : `${n(unallocated.length, "connection", "connections")} could not be given a pin.`,
          resolution: allocation.feasible
            ? "No action needed. To use fewer controllers, control fewer devices separately or choose a board with more pins."
            : "Choose a board with more pins, or reduce the number of separately controlled devices.",
        }
      )
    );
  }

  if (pressure.ioItemLimit) {
    warnings.push(
      make(
        "insufficient_io_capacity",
        allocation.feasible ? "medium" : blocked,
        "hardware",
        allocation.feasible ? "advisory" : "blocks_plan",
        {
          title: "Controller connection limit reached",
          meaning: `HomecoreOS firmware runs at most ${capability.maxIoItems} switches, devices and sensors on one controller, however many pins the board has.`,
          cause: `One location needs more than ${capability.maxIoItems} connections.`,
          impact: allocation.feasible
            ? "The devices were split across more than one controller."
            : "Some connections could not be assigned.",
          resolution: allocation.feasible
            ? "No action needed."
            : "Allow additional controllers, or reduce the number of separately controlled devices.",
        },
        "io_items"
      )
    );
  }

  if (pressure.capabilityShortage.length > 0) {
    const kinds = pressure.capabilityShortage.map(describePlannerDemand).join(", ");
    warnings.push(
      make(
        "insufficient_io_capacity",
        allocation.feasible ? "medium" : blocked,
        "hardware",
        allocation.feasible ? "advisory" : "blocks_plan",
        {
          title: "Not enough pins of the right kind",
          meaning: `Pins differ in what they can do. ${boardName} ran out of pins that can serve as ${kinds}.`,
          cause: "Your devices and sensors need more of this kind of connection than one controller offers.",
          impact: allocation.feasible
            ? "The affected connections were moved to an additional controller."
            : "The affected connections could not be assigned.",
          resolution: allocation.feasible
            ? "No action needed."
            : "Choose a board with more pins of this kind, or reduce the devices that need them.",
        },
        "capability"
      )
    );
  }

  if (pressure.restrictedPinsWithheld) {
    const held = capability.pins.filter((p) => p.tier === "restricted");
    const list = held
      .slice(0, 6)
      .map((p) => `GPIO${p.pin}`)
      .join(", ");
    warnings.push(
      make(
        "restricted_pin_conflict",
        allocation.feasible ? "medium" : "high",
        "hardware",
        allocation.feasible ? "advisory" : "blocks_plan",
        {
          title: "Some pins are held back for safety",
          meaning: `${boardName} has ${n(held.length, "pin", "pins")} the planner will not use (${list}${
            held.length > 6 ? ", …" : ""
          }). They are read while the board starts up, or belong to its USB port or BOOT button, and wiring a relay or sensor to them can stop the board from starting or being flashed.`,
          cause: "The plan needed more connections than the freely usable pins provide.",
          impact: allocation.feasible
            ? "Those connections were placed on an additional controller instead."
            : "Those connections could not be assigned.",
          resolution:
            "Leave these pins unconnected. Add a controller or control fewer devices separately rather than wiring restricted pins.",
        }
      )
    );
  }

  const sensorPinFailures = unallocated.filter(
    (u) => u.reason === "no_capable_pin" && u.demand !== "digital_out" && u.demand !== "pwm"
  );
  if (sensorPinFailures.length > 0) {
    const kinds = Array.from(new Set(sensorPinFailures.map((u) => describePlannerDemand(u.demand))));
    warnings.push(
      make("unsupported_sensor_interface", "critical", "hardware", "blocks_plan", {
        title: "This board cannot read some of your sensors",
        meaning: `${boardName} has no assignable pin that provides ${kinds.join(" or ")}.`,
        cause: `${n(sensorPinFailures.length, "sensor needs", "sensors need")} that kind of connection.`,
        impact: "Those sensors cannot be connected to this board.",
        resolution: "Choose a board that offers this kind of input.",
      }, "board")
    );
  }

  if (pressure.i2cFallbackSensors > 0) {
    warnings.push(
      make("unsupported_sensor_interface", "medium", "hardware", "action_required", {
        title: "The I2C bus carries only two of these sensors per controller",
        meaning:
          "Each temperature and humidity sensor on the I2C bus needs its own address, and this sensor type offers only two.",
        cause: "More than two I2C sensors were assigned to one controller.",
        impact: `${n(
          pressure.i2cFallbackSensors,
          "sensor was",
          "sensors were"
        )} planned as single-wire sensors on their own pin instead.`,
        resolution:
          'Buy single-wire temperature and humidity sensors for those rooms, or choose "wired directly" for all sensors.',
      }, "i2c_bus_full")
    );
  }

  // --- Relay and power hardware --------------------------------------------
  const relayChannels = allocation.controllers.reduce((sum, c) => sum + c.relayChannels, 0);
  if (relayChannels > capability.onboardRelayChannels) {
    warnings.push(
      installation.allowExternalRelayModules
        ? make("missing_relay_hardware", "medium", "hardware", "action_required", {
            title: "Relay modules are required",
            meaning:
              "Boards in the Board Library are bare controller boards with no built-in relays. Each mains-powered circuit needs one external relay channel between the controller pin and the load.",
            cause: `Your plan switches ${n(relayChannels, "circuit", "circuits")}.`,
            impact: "Without relay modules the controller cannot switch any load.",
            resolution: `Add relay modules providing at least ${n(
              relayChannels,
              "channel",
              "channels"
            )} in total, with inputs that work from a 3.3 V signal. See "Required hardware".`,
          })
        : make("missing_relay_hardware", "high", "hardware", "blocks_installation", {
            title: "No board with built-in relays is available",
            meaning:
              "No board in the Board Library documents built-in relays, and HomecoreOS does not assume hardware that is not documented.",
            cause: "You chose not to use external relay modules.",
            impact: `${n(relayChannels, "circuit has", "circuits have")} no relay to switch them, so the plan is incomplete.`,
            resolution: "Allow external relay modules in the Installation step.",
          })
    );
  }

  if (controllerCount > 0 && (relayChannels > 0 || totals.sensors > 0)) {
    const noFiveVolt = capability.powerRails.length > 0 && !capability.powerRails.includes("5V");
    warnings.push(
      make(
        "insufficient_power_capacity",
        relayChannels > 0 ? "high" : "low",
        "electrical",
        relayChannels > 0 ? "action_required" : "advisory",
        {
          title: "Controller power budget is not documented",
          meaning:
            "The Board Library records no current or power rating for this board, so HomecoreOS cannot confirm that it can power relay modules or sensors from its own pins, and does not assume it can.",
          cause: `The plan attaches ${n(relayChannels, "relay channel", "relay channels")} and ${n(
            totals.sensors,
            "sensor",
            "sensors"
          )} to ${n(controllerCount, "controller", "controllers")}.`,
          impact:
            relayChannels > 0
              ? "Drawing relay-coil current through the controller can make it reset or damage it."
              : "Too many sensors on the controller's own supply pin can make readings unstable.",
          resolution: `${
            relayChannels > 0
              ? "Power each controller's relay modules from a separate 5 V supply sized for all of its relay coils, and connect the grounds together."
              : "Check the current draw of your sensors against the board's datasheet."
          } Power the controller itself from a stable USB supply.${
            noFiveVolt ? " This board documents no 5 V pin on its headers." : ""
          }`,
        }
      )
    );
  }

  // --- Firmware -------------------------------------------------------------
  if (firmware.state === "no_compatible_release") {
    warnings.push(
      make("no_compatible_firmware", "high", "firmware", "blocks_installation", {
        title: "No compatible firmware",
        meaning: firmware.detail,
        cause: `${boardName} needs HomecoreOS firmware built for it.`,
        impact:
          "The board can host your devices on paper, but it cannot be installed through HomecoreOS.",
        resolution:
          "Choose a board whose firmware is published, or wait until a release for this board is published.",
      })
    );
  } else if (!firmware.published) {
    warnings.push(
      make("firmware_not_published", "high", "firmware", "blocks_installation", {
        title: `Firmware is not published (${firmware.label.toLowerCase()})`,
        meaning: firmware.detail,
        cause: `The firmware release for ${boardName} is at the stage "${firmware.label}".`,
        impact: "Nothing can be downloaded or flashed for this board yet.",
        resolution:
          firmware.state === "deprecated"
            ? "Choose a board with a current published release."
            : "Check back once the release is published, or choose a board whose firmware is already published.",
      })
    );
  } else {
    if (!firmware.usbFactoryAvailable) {
      warnings.push(
        make("missing_usb_artifact", "high", "firmware", "blocks_installation", {
          title: "No USB factory image",
          meaning: `Release ${version} is published but has no USB factory image. A brand-new board is first installed over USB.`,
          cause: `The published release for ${boardName} contains only a wireless (OTA) update file.`,
          impact:
            "A new board cannot be flashed through HomecoreOS. Only controllers already running HomecoreOS could be updated.",
          resolution:
            "Wait until a USB factory image is published for this board, or choose a board that has one.",
        })
      );
    }
    if (!firmware.otaAvailable) {
      warnings.push(
        make("missing_ota_artifact", "medium", "firmware", "advisory", {
          title: "No wireless (OTA) update image",
          meaning: `Release ${version} has no OTA image, so it cannot be delivered wirelessly.`,
          cause: `The published release for ${boardName} contains only a USB factory image.`,
          impact:
            "Initial installation over USB works, but updating to this release later needs a USB cable.",
          resolution: "No action needed for installation. Wireless updates work once an OTA image is published.",
        })
      );
    }
    if (!firmware.validatedForBoard) {
      warnings.push(
        make("firmware_not_validated", "high", "firmware", "blocks_installation", {
          title: "Firmware is not verified on this board",
          meaning: `Release ${version} lists ${boardName} as compatible, but it has not been marked as tested on the real hardware, and the board is not flagged "Firmware Supported".`,
          cause: "The release has no hardware verification for this board.",
          impact:
            "The firmware can be flashed, but HomecoreOS has not confirmed that it starts and runs correctly on this board.",
          resolution:
            "Choose a board marked Firmware Supported, or wait until this release is verified on the board.",
        })
      );
    }
  }

  // --- Expansion ------------------------------------------------------------
  if (allocation.feasible) {
    const { future, spare } = allocation;
    if (!future.satisfied) {
      warnings.push(
        make("insufficient_future_capacity", "medium", "expansion", "advisory", {
          title: "Not enough spare capacity for future devices",
          meaning: `After everything is connected, the controllers have room for ${future.accommodatedOutputs} more on/off outputs and ${future.accommodatedInputs} more sensor inputs.`,
          cause: `You plan to add ${future.requestedOutputs} outputs and ${future.requestedInputs} inputs later.`,
          impact: "Adding all of them later will need another controller.",
          resolution:
            "Plan space, power and Wi-Fi coverage for an extra controller now, or reduce the future additions.",
        })
      );
    } else if (future.requestedOutputs + future.requestedInputs === 0 && spare.pins <= 1) {
      warnings.push(
        make("insufficient_future_capacity", "low", "expansion", "advisory", {
          title: "Little room to grow",
          meaning: `The plan leaves ${n(spare.pins, "spare pin", "spare pins")} across all controllers.`,
          cause: "Almost every usable pin is taken by the devices you listed.",
          impact: "Adding a device later will probably need another controller.",
          resolution: "If you expect to add devices, enter them under future additions and run the planner again.",
        }, "tight")
      );
    }
  }

  // --- Availability ---------------------------------------------------------
  for (const check of availability.accountLimits) {
    if (!check.exceeded) continue;
    warnings.push(
      make("account_limit_exceeded", "high", "availability", "blocks_installation", {
        title: `Plan exceeds your account's ${check.kind === "controllers" ? "controller" : "device"} limit`,
        meaning: `Your account may have ${check.limit} ${check.kind}. It already has ${check.existing} and this plan adds ${check.planned}.`,
        cause: "Account limits are set by your HomecoreOS provider.",
        impact: `You will not be able to add every ${check.kind === "controllers" ? "controller" : "device"} in this plan.`,
        resolution:
          check.kind === "devices"
            ? 'Ask your HomecoreOS provider to raise the limit, or add simple on/off circuits as "Switches" instead of "Devices".'
            : "Ask your HomecoreOS provider to raise the limit, or remove controllers you no longer use.",
      }, check.kind)
    );
  }

  if (availability.stock.status === "unknown") {
    warnings.push(
      make("stock_unknown", "low", "availability", "advisory", {
        title: "Physical stock is not tracked",
        meaning: availability.stock.detail,
        cause: "The Board Library lists supported boards; it holds no inventory data.",
        impact: "A board that is published in the catalog may still be out of stock at your supplier.",
        resolution: "Confirm stock and price with your supplier before ordering.",
      })
    );
  }

  return warnings;
}

/** Raised when there is nothing in the Board Library to evaluate. */
export function plannerNoBoardsWarning(catalogEnabled: boolean): PlannerWarning {
  return make("no_boards_available", "critical", "availability", "blocks_plan", {
    title: "No boards available to evaluate",
    meaning: catalogEnabled
      ? "The Board Library does not contain any boards yet."
      : "The Board Library is currently switched off by the platform administrator.",
    cause: "The planner only recommends boards that exist in the Board Library.",
    impact: "No hardware can be recommended.",
    resolution:
      "Contact your HomecoreOS provider, or add your own board under Board Library → Custom Board Builder.",
  });
}
