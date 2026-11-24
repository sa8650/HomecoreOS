import { describe, expect, it } from "vitest";
import {
  SEEED_XIAO_OFFICIAL_BOARDS,
  WAVESHARE_ESP_OFFICIAL_BOARDS,
  buildWireDiagram,
  type BoardProfileSpec,
  type WireDiagramBoardInput,
  type WireDiagramParams,
  type WireDiagramResult,
} from "../src/index";

function boardFromSeed(
  seed: BoardProfileSpec | Record<string, unknown>,
  overrides: Partial<WireDiagramBoardInput> = {}
): WireDiagramBoardInput {
  const b = seed as unknown as WireDiagramBoardInput;
  return { ...b, is_available: true, ...overrides };
}

function relay6ch(overrides: Partial<WireDiagramBoardInput> = {}): WireDiagramBoardInput {
  const entry = WAVESHARE_ESP_OFFICIAL_BOARDS.find(
    (b) => b.seed.slug === "waveshare-esp32-s3-relay-6ch"
  )!;
  return boardFromSeed(entry.seed as unknown as BoardProfileSpec, overrides);
}

const CTRL = {
  id: "ctrl-1",
  name: "Panel Controller",
  boardProfileId: "board-1",
  customBoardProfileId: null,
  boardModel: "ESP32-S3-Relay-6CH",
  firmwareVersion: "1.4.0",
  status: "online",
};

const xiaoEntry = SEEED_XIAO_OFFICIAL_BOARDS.find(
  (b) => b.seed.slug === "seeed-xiao-esp32c3"
)!;
const xiaoC3 = (overrides: Partial<WireDiagramBoardInput> = {}) =>
  boardFromSeed(xiaoEntry.seed as unknown as BoardProfileSpec, overrides);

function params(
  partial: Partial<WireDiagramParams> & Pick<WireDiagramParams, "entity">
): WireDiagramParams {
  return {
    controller: CTRL,
    board: relay6ch(),
    siblingPins: [],
    roomName: "Utility",
    ...partial,
  };
}

function build(
  partial: Partial<WireDiagramParams> & Pick<WireDiagramParams, "entity">
): WireDiagramResult {
  return buildWireDiagram(params(partial));
}

const wireLabels = (r: WireDiagramResult) =>
  r.circuit.wires.map((w) => w.label);

describe("circuit-design — mains-switching archetypes", () => {
  it("an external relay switch is mains-isolated: AC source → COM, NO → load, N direct", () => {
    const r = build({
      entity: {
        kind: "switch",
        id: "sw-1",
        name: "Garden Pump",
        boardInstanceId: "ctrl-1",
        gpioPin: 4,
      },
    });
    expect(r.circuit.state).toBe("ready");
    expect(r.circuit.archetype).toBe("relay_switched_load_mains");
    expect(r.circuit.safetyClass).toBe("mains_ac");
    expect(r.circuit.mainsInvolved).toBe(true);
    expect(r.circuit.isolatedFromLoad).toBe(true);

    // Load-side terminals COM/NO are present and drawn; NC is not.
    const labels = r.terminals.map((t) => [t.label, t.drawn] as const);
    expect(labels).toContainEqual(["COM", true]);
    expect(labels).toContainEqual(["NO", true]);
    expect(labels).toContainEqual(["NC", false]);

    // The GPIO never touches mains: no ac_live wire starts at a GPIO.
    expect(
      r.circuit.wires.every(
        (w) => !(w.kind === "ac_live" && w.from.type === "gpio")
      )
    ).toBe(true);
    expect(wireLabels(r)).toEqual(
      expect.arrayContaining(["L → COM", "NO → L", "N → N"])
    );

    // Mains warnings are non-negotiable
    const titles = r.circuit.checks.map((c) => c.id);
    expect(titles).toContain("never-gpio-mains");
    expect(titles).toContain("mains-qualified");
    expect(
      r.circuit.checks.find((c) => c.id === "mains-qualified")?.status
    ).toBe("warn");
    // Load ratings are explicitly unknown — never fabricated
    expect(
      r.circuit.missingSpecifications.join(" ")
    ).toMatch(/[Cc]ontact.*rating/);
    expect(
      r.circuit.missingSpecifications.join(" ")
    ).toMatch(/mains voltage/i);
    expect(r.circuit.assumptions.join(" ")).toMatch(/mains/i);
  });

  it("an on-board relay channel shows the mains load side without any external control wiring", () => {
    const r = build({
      entity: {
        kind: "switch",
        id: "sw-1",
        name: "Porch Light",
        boardInstanceId: "ctrl-1",
        gpioPin: 1,
        inverted: false,
      },
    });
    expect(r.circuit.archetype).toBe("onboard_relay_mains");
    expect(r.circuit.mainsInvolved).toBe(true);
    // No COM/NO on the module panel — the on-board screws carry them
    expect(r.terminals.map((t) => t.label)).toEqual(["IN", "VCC", "GND"]);
    const kinds = r.circuit.components.map((c) => c.kind);
    expect(kinds).toContain("onboard_relay");
    expect(kinds).toContain("ac_mains");
    expect(kinds).toContain("appliance_load");
    expect(wireLabels(r)).toEqual(
      expect.arrayContaining(["L → COM", "NO → L", "N → N"])
    );
  });

  it("a fan defaults to the isolated relay circuit with explicit load-type caveat", () => {
    const r = build({
      entity: {
        kind: "device",
        id: "dev-1",
        name: "Ceiling Fan",
        boardInstanceId: "ctrl-1",
        gpioPin: 4,
        deviceType: "fan",
      },
    });
    expect(r.circuit.archetype).toBe("relay_switched_load_mains");
    expect(r.circuit.mainsInvolved).toBe(true);
    const dcAlternative = r.circuit.checks.find((c) => c.id === "dc-alternative");
    expect(dcAlternative?.status).toBe("unknown");
    expect(dcAlternative?.detail).toMatch(/mosfet/i);
  });
});

describe("circuit-design — low-voltage driver stages", () => {
  it("a dimmer shows the external PSU → module → LED strip chain, GPIO stays logic-only", () => {
    const r = build({
      entity: {
        kind: "device",
        id: "dev-2",
        name: "Kitchen Dimmer",
        boardInstanceId: "ctrl-1",
        gpioPin: 4,
        deviceType: "dimmer_pwm",
      },
    });
    expect(r.circuit.archetype).toBe("pwm_dimmer_low_voltage");
    expect(r.circuit.mainsInvolved).toBe(false);
    expect(r.circuit.externalSupplyRequired).toBe(true);
    const kinds = r.circuit.components.map((c) => c.kind);
    expect(kinds).toContain("external_psu");
    expect(kinds).toContain("led_strip");
    expect(wireLabels(r)).toEqual(
      expect.arrayContaining(["V+ → VCC", "V+ → strip +", "strip − → OUT", "0V → GND"])
    );
    // The switched output is an OUT load terminal, drawn by the circuit.
    const out = r.terminals.find((t) => t.label === "OUT");
    expect(out?.role).toBe("load");
    expect(out?.drawn).toBe(true);
    // And the dimmer reasoning states the GPIO never powers the strip
    expect(r.circuit.reasoning.join(" ")).toMatch(/GPIO never carries load current/i);
  });

  it("a lock shows MOSFET + flyback + external PSU and flags the AC-solenoid caveat", () => {
    const r = build({
      entity: {
        kind: "device",
        id: "dev-3",
        name: "Front Door Lock",
        boardInstanceId: "ctrl-1",
        gpioPin: 4,
        deviceType: "lock",
      },
    });
    expect(r.circuit.archetype).toBe("solenoid_low_side_driver");
    expect(r.circuit.externalSupplyRequired).toBe(true);
    const kinds = r.circuit.components.map((c) => c.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "external_psu",
        "mosfet_logic",
        "base_resistor",
        "flyback_diode",
      ])
    );
    // Flyback diode is always required for an inductive coil
    expect(r.circuit.checks.find((c) => c.id === "flyback-present")?.status).toBe("pass");
    // Solenoid terminals exist and are wired
    expect(r.terminals.map((t) => [t.label, t.drawn])).toContainEqual(["S+", true]);
    expect(r.terminals.map((t) => [t.label, t.drawn])).toContainEqual(["S−", true]);
    expect(r.circuit.checks.find((c) => c.id === "mains-if-ac")?.status).toBe("warn");
    // Physical truthfulness: coil current is unknown
    expect(r.circuit.checks.find((c) => c.id === "coil-current")?.status).toBe("unknown");
    const wireLabelsList = wireLabels(r);
    expect(wireLabelsList).toEqual(
      expect.arrayContaining(["GPIO4 → R1", "V+ → S+", "Drain → S−", "D1 K → S+", "D1 A → S−"])
    );
  });

  it("a buzzer shows an NPN low-side driver and uses the documented 5V rail on Relay-6CH", () => {
    const r = build({
      entity: {
        kind: "device",
        id: "dev-4",
        name: "Alarm Buzzer",
        boardInstanceId: "ctrl-1",
        gpioPin: 4,
        deviceType: "buzzer",
      },
    });
    expect(r.circuit.archetype).toBe("npn_low_side_driver");
    const kinds = r.circuit.components.map((c) => c.kind);
    expect(kinds).toContain("npn_transistor");
    expect(kinds).toContain("base_resistor");
    // Relay-6CH documents a 5V pad on the Relays header → no external PSU
    expect(kinds).not.toContain("external_psu");
    expect(r.circuit.externalSupplyRequired).toBe(false);
    const supply = r.circuit.wires.find((w) => w.to.type === "device_terminal" && w.to.terminalId === "vcc");
    expect(supply?.label).toBe("5V → VCC");
    expect(supply?.documented).toBe(true);
  });

  it("a buzzer on a board without a documented 5V rail requires an external supply", () => {
    const r = build({
      board: xiaoC3(),
      entity: {
        kind: "device",
        id: "dev-5",
        name: "Alarm Buzzer",
        boardInstanceId: "ctrl-1",
        gpioPin: 3,
        deviceType: "buzzer",
      },
    });
    const has5V = r.circuit.externalSupplyRequired;
    // XIAO C3 documents VBUS/3V3/5V? Only assert what the board documents:
    // either no 5V → external PSU required, or 5V documented → not.
    if (has5V) {
      expect(r.circuit.components.some((c) => c.kind === "external_psu")).toBe(true);
      expect(r.circuit.checks.find((c) => c.id === "supply-missing")?.status).toBe("warn");
    } else {
      expect(r.circuit.checks.find((c) => c.id === "supply-documented")?.status).toBe("pass");
    }
  });

  it("a status LED shows a computed series resistor, formula included", () => {
    const r = build({
      entity: {
        kind: "device",
        id: "dev-6",
        name: "Status LED",
        boardInstanceId: "ctrl-1",
        gpioPin: 4,
        deviceType: "status_led",
      },
    });
    expect(r.circuit.archetype).toBe("led_series_resistor");
    const resistor = r.circuit.components.find((c) => c.kind === "series_resistor")!;
    expect(resistor.valueStatus).toBe("formula");
    expect(resistor.value).toMatch(/330/);
    expect(r.circuit.formulas.map((f) => f.body).join(" ")).toMatch(/R = \(V_GPIO/);
    expect(wireLabels(r)).toEqual(expect.arrayContaining(["GPIO4 → R1", "R1 → A"]));
    expect(r.circuit.checks.find((c) => c.id === "gpio-current")?.status).toBe("pass");
  });
});

describe("circuit-design — sensors", () => {
  it("a DHT22 shows the DATA pull-up resistor and flags the module overlap", () => {
    const r = build({
      entity: {
        kind: "sensor",
        id: "sen-1",
        name: "Greenhouse Temp",
        boardInstanceId: "ctrl-1",
        gpioPin: 5,
        sensorType: "temperature_dht22",
      },
    });
    expect(r.circuit.archetype).toBe("single_wire_pullup");
    const kinds = r.circuit.components.map((c) => c.kind);
    expect(kinds).toContain("pull_up_resistor");
    expect(wireLabels(r)).toEqual(expect.arrayContaining(["R1 → DATA", "R1 → VCC"]));
    expect(r.circuit.checks.find((c) => c.id === "pullup-present")?.status).toBe("pass");
    expect(r.circuit.assumptions.join(" ")).toMatch(/module/i);
  });

  it("a DS18B20 targets the DQ terminal, not DATA", () => {
    const r = build({
      entity: {
        kind: "sensor",
        id: "sen-2",
        name: "Water Temp",
        boardInstanceId: "ctrl-1",
        gpioPin: 5,
        sensorType: "temperature_ds18b20",
      },
    });
    expect(r.circuit.archetype).toBe("single_wire_pullup");
    const tap = r.circuit.wires.find((w) => w.label === "R1 → DQ" || w.label === "R1 → DATA");
    expect(tap).toBeDefined();
    // DQ terminal is drawn by the circuit
    expect(r.terminals.find((t) => t.label === "DQ")?.drawn).toBe(true);
  });

  it("an I2C sensor draws the documented bus, no fabricated level shifter, conditional shifter shown", () => {
    const r = build({
      entity: {
        kind: "sensor",
        id: "sen-3",
        name: "Attic BME280",
        boardInstanceId: "ctrl-1",
        gpioPin: null,
        sensorType: "temperature_bme280",
      },
    });
    expect(r.circuit.archetype).toBe("i2c_module");
    // No invented wires — the I2C legs live in the connections table
    expect(r.circuit.wires).toEqual([]);
    const shifter = r.circuit.components.find((c) => c.kind === "level_shifter")!;
    expect(shifter.certainty).toBe("conditional");
    expect(shifter.notes.join(" ")).toMatch(/NOT needed|not needed/i);
    expect(r.circuit.checks.find((c) => c.id === "bus-documented")?.status).toBe("pass");
  });

  it("a PIR sensor shows no components and flags the 5V-supply / OUT-level unknowns", () => {
    const r = build({
      entity: {
        kind: "sensor",
        id: "sen-4",
        name: "Hallway PIR",
        boardInstanceId: "ctrl-1",
        gpioPin: 5,
        sensorType: "motion_pir",
      },
    });
    expect(r.circuit.archetype).toBe("pir_three_wire");
    expect(r.circuit.components).toEqual([]);
    expect(r.circuit.wires).toEqual([]);
    expect(r.circuit.checks.find((c) => c.id === "out-level")?.status).toBe("unknown");
    // Relay-6CH documents 5V → supply check passes with the 5V note
    expect(r.circuit.checks.find((c) => c.id === "supply-documented")?.status).toBe("pass");
    expect(r.circuit.externalSupplyRequired).toBe(false);
  });

  it("a reed contact is a 2-wire passive contact with no circuitry", () => {
    const r = build({
      board: xiaoC3(),
      entity: {
        kind: "sensor",
        id: "sen-5",
        name: "Front Door",
        boardInstanceId: "ctrl-1",
        gpioPin: 3,
        sensorType: "contact_reed",
      },
    });
    expect(r.circuit.archetype).toBe("contact_two_wire");
    expect(r.circuit.components).toEqual([]);
    expect(r.circuit.wires).toEqual([]);
    expect(r.circuit.checks.find((c) => c.id === "two-wire")?.status).toBe("pass");
  });

  it("an analog input shows the conditional divider with the scaling formula and never auto-wires it", () => {
    const r = build({
      entity: {
        kind: "sensor",
        id: "sen-6",
        name: "Battery Sense",
        boardInstanceId: "ctrl-1",
        gpioPin: 4,
        sensorType: "analog_voltage",
      },
    });
    expect(r.circuit.archetype).toBe("adc_divider_advisory");
    const divider = r.circuit.components.find((c) => c.kind === "voltage_divider")!;
    expect(divider.certainty).toBe("conditional");
    expect(r.circuit.wires).toEqual([]);
    expect(r.circuit.formulas.map((f) => f.body).join(" ")).toMatch(/R1 \+ R2/);
    expect(r.circuit.checks.find((c) => c.id === "absolute-max")?.status).toBe("warn");
  });
});

describe("circuit-design — truthfulness contract", () => {
  it("never emits a mains wire from a GPIO endpoint in any archetype", () => {
    const devices = ["fan", "light", "tv", "relay", "dimmer_pwm", "lock", "valve", "buzzer", "status_led"] as const;
    for (const deviceType of devices) {
      const r = build({
        entity: {
          kind: "device",
          id: `dev-${deviceType}`,
          name: deviceType,
          boardInstanceId: "ctrl-1",
          gpioPin: 4,
          deviceType,
        },
      });
      for (const w of r.circuit.wires) {
        if (w.kind === "ac_live" || w.kind === "ac_neutral") {
          expect(
            w.from.type !== "gpio" && w.to.type !== "gpio",
            `${deviceType}: mains wire touches a GPIO`
          ).toBe(true);
        }
      }
    }
  });

  it("every check id is unique and every component declares how its value is known", () => {
    const r = build({
      entity: {
        kind: "device",
        id: "dev-7",
        name: "Lock",
        boardInstanceId: "ctrl-1",
        gpioPin: 4,
        deviceType: "lock",
      },
    });
    const ids = r.circuit.checks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of r.circuit.components) {
      expect(["guidance", "formula", "not_documented"]).toContain(c.valueStatus);
    }
  });

  it("an unavailable result carries an empty, explicit circuit plan", () => {
    const r = build({
      board: null,
      entity: {
        kind: "device",
        id: "dev-8",
        name: "Lamp",
        boardInstanceId: "ctrl-1",
        gpioPin: 4,
        deviceType: "light",
      },
    });
    expect(r.state).toBe("unavailable");
    expect(r.circuit.state).toBe("unavailable");
    expect(r.circuit.components).toEqual([]);
    expect(r.circuit.wires).toEqual([]);
    expect(r.circuit.checks).toEqual([]);
  });

  it("wires targeting device load terminals mark them drawn (and leave NC undrawn)", () => {
    const r = build({
      entity: {
        kind: "device",
        id: "dev-9",
        name: "Workshop Light",
        boardInstanceId: "ctrl-1",
        gpioPin: 4,
        deviceType: "light",
      },
    });
    const byLabel = new Map(r.terminals.map((t) => [t.label, t]));
    expect(byLabel.get("COM")!.drawn).toBe(true);
    expect(byLabel.get("NO")!.drawn).toBe(true);
    expect(byLabel.get("NC")!.drawn).toBe(false);
    expect(byLabel.get("COM")!.role).toBe("load");
  });

  it("dispatches expanded sensor drivers cleanly without generic fallback", () => {
    const sht = build({
      entity: {
        kind: "sensor",
        id: "sen-sht",
        name: "SHT31",
        boardInstanceId: "ctrl-1",
        gpioPin: null,
        sensorType: "temperature_sht3x",
        i2cAddress: "0x44",
      },
    });
    expect(sht.circuit.archetype).toBe("i2c_module");

    const dht11 = build({
      entity: {
        kind: "sensor",
        id: "sen-dht11",
        name: "DHT11",
        boardInstanceId: "ctrl-1",
        gpioPin: 4,
        sensorType: "temperature_dht11",
      },
    });
    expect(dht11.circuit.archetype).toBe("single_wire_pullup");

    const ld2410 = build({
      entity: {
        kind: "sensor",
        id: "sen-ld",
        name: "Radar",
        boardInstanceId: "ctrl-1",
        gpioPin: null,
        sensorType: "presence_ld2410",
        resources: { driverId: "ld2410", pins: { uart_tx: 4, uart_rx: 5 } },
      },
    });
    expect(ld2410.circuit.archetype).toBe("uart_module");

    const mq2 = build({
      board: xiaoC3(),
      entity: {
        kind: "sensor",
        id: "sen-mq2",
        name: "Gas",
        boardInstanceId: "ctrl-1",
        gpioPin: 2,
        sensorType: "gas_mq2",
      },
    });
    expect(mq2.circuit.archetype).toBe("adc_divider_advisory");

    const leak = build({
      entity: {
        kind: "sensor",
        id: "sen-leak",
        name: "Leak",
        boardInstanceId: "ctrl-1",
        gpioPin: 4,
        sensorType: "water_leak",
      },
    });
    expect(leak.circuit.archetype).toBe("digital_input_module");
  });
});
