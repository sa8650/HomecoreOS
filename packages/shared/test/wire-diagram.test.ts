import { describe, expect, it } from "vitest";
import {
  SEEED_XIAO_OFFICIAL_BOARDS,
  WAVESHARE_ESP_OFFICIAL_BOARDS,
  buildWireDiagram,
  type BoardProfileSpec,
  type WireDiagramBoardInput,
  type WireDiagramParams,
} from "../src/index";

function boardFromSeed(
  seed: BoardProfileSpec | Record<string, unknown>,
  overrides: Partial<WireDiagramBoardInput> = {}
): WireDiagramBoardInput {
  const b = seed as unknown as WireDiagramBoardInput;
  return {
    ...b,
    is_available: true,
    ...overrides,
  };
}

function relay6ch(overrides: Partial<WireDiagramBoardInput> = {}): WireDiagramBoardInput {
  const entry = WAVESHARE_ESP_OFFICIAL_BOARDS.find(
    (b) => b.seed.slug === "waveshare-esp32-s3-relay-6ch"
  )!;
  return boardFromSeed(entry.seed as unknown as BoardProfileSpec, overrides);
}

function xiaoC3(overrides: Partial<WireDiagramBoardInput> = {}): WireDiagramBoardInput {
  const entry = SEEED_XIAO_OFFICIAL_BOARDS.find(
    (b) => b.seed.slug === "seeed-xiao-esp32c3"
  )!;
  return boardFromSeed(entry.seed as unknown as BoardProfileSpec, overrides);
}

const CTRL = {
  id: "ctrl-1",
  name: "Panel Controller",
  boardCatalogId: "board-1",
  customBoardId: null,
  boardModel: "ESP32-S3-Relay-6CH",
  firmwareVersion: "1.4.0",
  status: "online",
};

function params(partial: Partial<WireDiagramParams> & Pick<WireDiagramParams, "entity">): WireDiagramParams {
  return {
    controller: CTRL,
    board: relay6ch(),
    siblingPins: [],
    roomName: "Utility",
    ...partial,
  };
}

describe("buildWireDiagram — availability gates", () => {
  it("returns unavailable when the controller is missing", () => {
    const result = buildWireDiagram(
      params({
        controller: null,
        entity: {
          kind: "switch",
          id: "sw-1",
          name: "Pump relay",
          controllerId: "ctrl-1",
          gpioPin: 4,
        },
      })
    );
    expect(result.state).toBe("unavailable");
    expect(result.unavailableReasons.join(" ")).toMatch(/controller/i);
    expect(result.connections).toHaveLength(0);
  });

  it("returns unavailable when the board profile is missing", () => {
    const result = buildWireDiagram(
      params({
        board: null,
        entity: {
          kind: "device",
          id: "dev-1",
          name: "Porch light",
          controllerId: "ctrl-1",
          gpioPin: 4,
          deviceType: "light",
        },
      })
    );
    expect(result.state).toBe("unavailable");
    expect(result.unavailableReasons.join(" ")).toMatch(/Board Library/);
  });

  it("returns unavailable for needs_verification catalog boards", () => {
    const result = buildWireDiagram(
      params({
        board: relay6ch({ verification_status: "needs_verification" }),
        entity: {
          kind: "switch",
          id: "sw-1",
          name: "Pump relay",
          controllerId: "ctrl-1",
          gpioPin: 4,
        },
      })
    );
    expect(result.state).toBe("unavailable");
    expect(result.unavailableReasons.join(" ")).toMatch(/needs verification/i);
  });

  it("returns unavailable for withdrawn catalog boards", () => {
    const result = buildWireDiagram(
      params({
        board: relay6ch({ is_available: false }),
        entity: {
          kind: "switch",
          id: "sw-1",
          name: "Pump relay",
          controllerId: "ctrl-1",
          gpioPin: 4,
        },
      })
    );
    expect(result.state).toBe("unavailable");
    expect(result.unavailableReasons.join(" ")).toMatch(/withdrawn|not available/i);
  });

  it("returns unavailable when no default I2C bus is documented and no pin is assigned", () => {
    // A generic board whose profile documents no SDA/SCL pads anywhere.
    const anonymousBoard: WireDiagramBoardInput = {
      id: "anon-1",
      slug: "anon-devkit",
      manufacturer: "Anon",
      model: "DevKit",
      revision: "1",
      chip_family: "esp32s3",
      chip_variant: "generic",
      flash_size_mb: 4,
      psram_size_mb: 0,
      gpio_definitions: [4, 5, 16, 17].map((pin) => ({
        pin,
        label: `GPIO${pin}`,
        capabilities: {
          digital_in: true,
          digital_out: true,
          pwm: true,
          adc: false,
          i2c: true,
          spi: true,
          uart: true,
          touch: false,
          pull_up: true,
          pull_down: true,
        },
        restrictions: {
          input_only: false,
          reserved: false,
          strapping_pin: false,
          flash_psram_conflict: false,
          usb_jtag_conflict: false,
        },
      })),
      board_layout: {
        formFactor: "devkit",
        orientation: "vertical",
        aspectRatio: 88 / 122,
        usbEdge: "bottom",
        leftHeader: {
          name: "J1",
          pins: [0, 1, 2, 3].map((i) => ({
            position: i + 1,
            headerName: "J1",
            pinName: String([4, 5, 16, 17][i]),
            gpioPin: [4, 5, 16, 17][i],
            kind: "gpio" as const,
          })),
        },
        rightHeader: { name: "J3", pins: [] },
      },
    };
    const result = buildWireDiagram(
      params({
        board: anonymousBoard,
        entity: {
          kind: "sensor",
          id: "sen-1",
          name: "Climate",
          controllerId: "ctrl-1",
          gpioPin: null,
          sensorType: "temperature_bme280",
        },
      })
    );
    expect(result.state).toBe("unavailable");
    expect(result.unavailableReasons.join(" ")).toMatch(/I2C/i);
  });
});

describe("buildWireDiagram — switches on the Relay-6CH board", () => {
  it("detects an onboard relay pin and draws no external control wire", () => {
    const result = buildWireDiagram(
      params({
        entity: {
          kind: "switch",
          id: "sw-1",
          name: "Main valve",
          controllerId: "ctrl-1",
          gpioPin: 1,
          inverted: false,
        },
      })
    );
    expect(result.state).toBe("ready");
    const signal = result.connections.find((c) => c.terminalId === "in")!;
    expect(signal.placement).toBe("onboard");
    expect(signal.onboardFeatureLabel).toBe("Relay CH1");
    expect(signal.headerKey).toBe("Relays:1");
    expect(signal.detail).toMatch(/mains/i);
    // No fabricated external wire for the control leg
    expect(signal.pin).toBe(1);
    // An on-board relay replaces the external module entirely: no external
    // ground or supply legs are drawn.
    expect(result.connections).toHaveLength(1);
  });

  it("maps an expansion-header pin to its pad and marks a sibling conflict", () => {
    const result = buildWireDiagram(
      params({
        siblingPins: [
          { pin: 4, entityKind: "device", id: "dev-9", name: "Porch light" },
        ],
        entity: {
          kind: "switch",
          id: "sw-1",
          name: "Garden light",
          controllerId: "ctrl-1",
          gpioPin: 4,
        },
      })
    );
    expect(result.state).toBe("ready");
    const signal = result.connections.find((c) => c.terminalId === "in")!;
    expect(signal.placement).toBe("header");
    expect(signal.headerName).toBe("Expansion");
    expect(signal.headerKey).toBe("Expansion:3");
    expect(signal.kind).toBe("Pin Conflict / Invalid");
    expect(signal.warnings.join(" ")).toMatch(/Porch light/);
    expect(result.totals.invalid).toBeGreaterThanOrEqual(1);
  });

  it("draws a clean configured wire when the assignment is valid", () => {
    const result = buildWireDiagram(
      params({
        entity: {
          kind: "switch",
          id: "sw-1",
          name: "Garden light",
          controllerId: "ctrl-1",
          gpioPin: 4,
          inverted: true,
        },
      })
    );
    expect(result.state).toBe("ready");
    const signal = result.connections.find((c) => c.terminalId === "in")!;
    expect(signal.kind).toBe("Configured (Logical)");
    expect(signal.signal).toBe("Digital output");
    expect(signal.voltage).toBe("3.3V logic");
    expect(result.entity?.relayLogic).toBe("Active-LOW (inverted)");
    expect(result.warnings.join(" ")).toMatch(/Active-LOW/);
    // Supply leg is advisory, not auto-wired
    const supply = result.connections.find((c) => c.role === "power")!;
    expect(supply.kind).toBe("Advisory Warning");
    expect(supply.placement).toBe("none");
    expect(supply.voltage).toBe("Not documented");
  });
});

describe("buildWireDiagram — devices", () => {
  it("pwm dimmer requires and validates a PWM-capable pin", () => {
    const result = buildWireDiagram(
      params({
        entity: {
          kind: "device",
          id: "dev-1",
          name: "Kitchen LED strip",
          controllerId: "ctrl-1",
          gpioPin: 4,
          deviceType: "dimmer_pwm",
        },
      })
    );
    expect(result.state).toBe("ready");
    const signal = result.connections.find((c) => c.terminalId === "pwm")!;
    expect(signal.signal).toBe("PWM output");
    expect(signal.kind).toBe("Configured (Logical)");
    expect(result.entity?.interfaceLabel).toBe("GPIO (PWM)");
  });

  it("rejects an unsupported device type with an explicit reason", () => {
    const result = buildWireDiagram(
      params({
        entity: {
          kind: "device",
          id: "dev-1",
          name: "Mystery box",
          controllerId: "ctrl-1",
          gpioPin: 4,
          deviceType: "flux_capacitor",
        },
      })
    );
    expect(result.state).toBe("unavailable");
    expect(result.unavailableReasons.join(" ")).toMatch(/Unsupported device type/);
  });

  it("status_led exposes A/K terminals and a series-resistor advisory", () => {
    const result = buildWireDiagram(
      params({
        entity: {
          kind: "device",
          id: "dev-2",
          name: "Status LED",
          controllerId: "ctrl-1",
          gpioPin: 4,
          deviceType: "status_led",
        },
      })
    );
    expect(result.state).toBe("ready");
    expect(result.terminals.map((t) => t.label)).toEqual(["A", "K"]);
    expect(result.warnings.join(" ")).toMatch(/series resistor/i);
  });
});

describe("buildWireDiagram — sensors", () => {
  it("wires a DHT22 on the XIAO ESP32-C3 with a pull-up advisory", () => {
    const board = xiaoC3();
    const result = buildWireDiagram(
      params({
        board,
        entity: {
          kind: "sensor",
          id: "sen-1",
          name: "Bedroom climate",
          controllerId: "ctrl-1",
          gpioPin: 4,
          sensorType: "temperature_dht22",
        },
      })
    );
    expect(result.state).toBe("ready");
    const data = result.connections.find((c) => c.terminalId === "data")!;
    expect(data.pin).toBe(4);
    expect(data.signal).toBe("Single-wire data");
    expect(data.placement).toBe("header");
    expect(result.warnings.join(" ")).toMatch(/pull-up resistor/i);
    expect(result.entity?.driver?.driverId).toBe("dht22");
  });

  it("shares the DHT22 pin between temperature and humidity siblings", () => {
    const board = xiaoC3();
    const result = buildWireDiagram(
      params({
        board,
        siblingPins: [
          {
            pin: 4,
            entityKind: "sensor",
            id: "sen-humidity",
            name: "Bedroom humidity",
            sensorType: "humidity_dht22",
          },
        ],
        entity: {
          kind: "sensor",
          id: "sen-temp",
          name: "Bedroom temperature",
          controllerId: "ctrl-1",
          gpioPin: 4,
          sensorType: "temperature_dht22",
        },
      })
    );
    expect(result.state).toBe("ready");
    const data = result.connections.find((c) => c.terminalId === "data")!;
    expect(data.kind).toBe("Shared Bus (Logical)");
    expect(data.sharedWith.join(" ")).toMatch(/Bedroom humidity/);
  });

  it("resolves a BME280 on the Relay-6CH default I2C bus (GP8/GP9)", () => {
    const result = buildWireDiagram(
      params({
        entity: {
          kind: "sensor",
          id: "sen-1",
          name: "Utility climate",
          controllerId: "ctrl-1",
          gpioPin: null,
          sensorType: "temperature_bme280",
          i2cAddress: "0x76",
        },
      })
    );
    expect(result.state).toBe("ready");
    const sda = result.connections.find((c) => c.terminalId === "sda")!;
    const scl = result.connections.find((c) => c.terminalId === "scl")!;
    expect(sda.pin).toBe(8);
    expect(sda.signal).toBe("I2C SDA");
    expect(sda.headerKey).toBe("Expansion:7");
    expect(sda.kind).toBe("Shared Bus (Logical)");
    expect(scl.pin).toBe(9);
    expect(scl.signal).toBe("I2C SCL");
    expect(scl.headerKey).toBe("Expansion:8");
    expect(result.entity?.driver?.i2cAddress).toBe("0x76");
  });

  it("honours an explicitly assigned SDA pin and keeps the documented SCL", () => {
    const result = buildWireDiagram(
      params({
        entity: {
          kind: "sensor",
          id: "sen-1",
          name: "Utility climate",
          controllerId: "ctrl-1",
          gpioPin: 4,
          sensorType: "temperature_bme280",
        },
      })
    );
    expect(result.state).toBe("ready");
    const sda = result.connections.find((c) => c.terminalId === "sda")!;
    const scl = result.connections.find((c) => c.terminalId === "scl")!;
    expect(sda.pin).toBe(4);
    expect(scl.pin).toBe(9);
    expect(scl.warnings.join(" ")).toMatch(/explicit SDA/i);
  });

  it("wires a reed contact as a 2-wire passive contact with no VCC leg", () => {
    const board = xiaoC3();
    const result = buildWireDiagram(
      params({
        board,
        entity: {
          kind: "sensor",
          id: "sen-1",
          name: "Front door",
          controllerId: "ctrl-1",
          gpioPin: 3,
          sensorType: "contact_reed",
        },
      })
    );
    expect(result.state).toBe("ready");
    expect(result.terminals.map((t) => t.label)).toEqual(["SIG", "GND"]);
    expect(result.connections.some((c) => c.role === "power")).toBe(false);
    const gnd = result.connections.find((c) => c.role === "ground")!;
    expect(gnd.kind).toBe("Reference Rail");
  });

  it("an ADC sensor reports the documented 0-3.3V input range", () => {
    const board = xiaoC3();
    const result = buildWireDiagram(
      params({
        board,
        entity: {
          kind: "sensor",
          id: "sen-1",
          name: "Soil voltage",
          controllerId: "ctrl-1",
          gpioPin: 3,
          sensorType: "analog_voltage",
        },
      })
    );
    expect(result.state).toBe("ready");
    const sig = result.connections.find((c) => c.terminalId === "sig")!;
    expect(sig.voltage).toBe("0–3.3V");
  });

  it("rejects a configured pin that is input-only for a DHT22", () => {
    // GPIO44 on XIAO ESP32-C3 is UART RX (reserved) — use flash-free input-only
    // on ESP32 classic: GPIO34 is input-only there. Find one on the C3 profile instead:
    // the C3 has no input-only pins, so assert the equivalent via the relay board's
    // CH6 pin (GPIO46 input-only) for a device instead.
    const result = buildWireDiagram(
      params({
        entity: {
          kind: "sensor",
          id: "sen-1",
          name: "HVAC loop",
          controllerId: "ctrl-1",
          gpioPin: 46,
          sensorType: "temperature_ds18b20",
        },
      })
    );
    expect(result.state).toBe("ready");
    const dq = result.connections.find((c) => c.terminalId === "dq")!;
    expect(dq.kind).toBe("Pin Conflict / Invalid");
    expect(dq.warnings.join(" ")).toMatch(/input-only/i);
  });

  it("rejects a sensor pin that is hardwired to an onboard relay", () => {
    const result = buildWireDiagram(
      params({
        entity: {
          kind: "sensor",
          id: "sen-1",
          name: "Sneaky input",
          controllerId: "ctrl-1",
          gpioPin: 1,
          sensorType: "motion_pir",
        },
      })
    );
    expect(result.state).toBe("ready");
    const out = result.connections.find((c) => c.terminalId === "out")!;
    expect(out.kind).toBe("Pin Conflict / Invalid");
    expect(out.warnings.join(" ")).toMatch(/on-board output|hardwired/i);
  });

  it("flags an assignment to a pin with no documented pad as invalid, not invented", () => {
    const result = buildWireDiagram(
      params({
        entity: {
          kind: "switch",
          id: "sw-1",
          name: "Ghost pin",
          controllerId: "ctrl-1",
          gpioPin: 47,
        },
      })
    );
    // GPIO47 exists in the ESP32-S3 SoC range but is not on any documented pad.
    expect(result.state).toBe("ready");
    const signal = result.connections.find((c) => c.terminalId === "in")!;
    expect(signal.kind).toBe("Pin Conflict / Invalid");
    expect(signal.placement).toBe("none");
  });
});

describe("buildWireDiagram — custom boards", () => {
  const customBoard: WireDiagramBoardInput = {
    id: "custom-1",
    slug: "acme-thing",
    manufacturer: "Acme",
    model: "Thing One",
    revision: "1",
    chip_family: "esp32s3",
    chip_variant: "custom",
    flash_size_mb: 4,
    psram_size_mb: 0,
    catalog_category: "custom",
    gpio_definitions: [
      {
        pin: 4,
        label: "GPIO4",
        capabilities: {
          digital_in: true,
          digital_out: true,
          pwm: true,
          adc: false,
          i2c: true,
          spi: true,
          uart: true,
          touch: false,
          pull_up: true,
          pull_down: true,
        },
        restrictions: {
          input_only: false,
          reserved: false,
          strapping_pin: false,
          flash_psram_conflict: false,
          usb_jtag_conflict: false,
        },
      },
    ],
    board_layout: null,
  };

  it("produces an unavailable-position diagram with explicit advisories, never invented pads", () => {
    const result = buildWireDiagram(
      params({
        board: customBoard,
        entity: {
          kind: "switch",
          id: "sw-1",
          name: "Yard pump",
          controllerId: "ctrl-1",
          gpioPin: 4,
        },
      })
    );
    expect(result.state).toBe("ready");
    expect(result.allPlacementDocumented).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/does not document a pin layout/i);
    const signal = result.connections.find((c) => c.terminalId === "in")!;
    expect(signal.placement).toBe("none");
    expect(signal.kind).toBe("Configured (Logical)");
    expect(result.board?.isCustom).toBe(true);
  });
});
