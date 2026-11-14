import { describe, expect, it } from "vitest";
import {
  SEEED_XIAO_OFFICIAL_BOARDS,
  VERIFIED_BOARD_CATALOG,
  buildGpioPinSelectorModel,
  evaluateGpioPinChoice,
  evaluatePlannerBoardCapability,
  validateGpioAssignment,
  type GpioPinSelectorEntry,
  type GpioPinUsage,
  type PinOperationRequirement,
} from "../src/index";

const s3 = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;
const xiaoS3 = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "seeed-xiao-esp32s3")!;
const xiaoC3 = SEEED_XIAO_OFFICIAL_BOARDS.find((b) => b.seed.slug === "seeed-xiao-esp32c3")!.seed;
const xiaoPlus = SEEED_XIAO_OFFICIAL_BOARDS.find((b) => b.seed.slug === "seeed-xiao-esp32s3-plus")!.seed;

const used: GpioPinUsage[] = [
  { pin: 4, entityKind: "switch", id: "sw-1", name: "Hallway Sconce" },
  { pin: 7, entityKind: "device", id: "dev-2", name: "Door Lock" },
];

function entry(entries: GpioPinSelectorEntry[], pin: number): GpioPinSelectorEntry {
  const found = entries.find((e) => e.pin === pin);
  if (!found) throw new Error(`pin ${pin} missing`);
  return found;
}

describe("GPIO pin selector policy", () => {
  it("sorts every pin of a board into the four states", () => {
    const model = buildGpioPinSelectorModel({ board: s3, requirement: "digital_out", usedPins: used });

    expect(entry(model.entries, 5)).toMatchObject({ state: "available", selectable: true });
    expect(entry(model.entries, 7)).toMatchObject({ state: "used", selectable: false });
    expect(entry(model.entries, 0)).toMatchObject({ state: "restricted", selectable: false });
    expect(entry(model.entries, 19)).toMatchObject({ state: "restricted", selectable: false });
    expect(entry(model.entries, 35)).toMatchObject({ state: "dangerous", selectable: false });
    expect(entry(model.entries, 27)).toMatchObject({ state: "dangerous", selectable: false });

    const total = Object.values(model.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(s3.gpio_definitions.length);
    expect(model.counts.used).toBe(2);
  });

  it("prevents conflicting assignments and names the entity that holds the pin", () => {
    const model = buildGpioPinSelectorModel({ board: s3, requirement: "digital_out", usedPins: used });
    const pin7 = entry(model.entries, 7);
    expect(pin7.usedBy).toMatchObject({ entityKind: "device", name: "Door Lock" });
    expect(pin7.explanation).toBe(
      'GPIO 7 is already assigned to device "Door Lock" on this controller.'
    );
    expect(model.suggestions).not.toContain(7);
    expect(model.suggestions).not.toContain(4);

    const verdict = evaluateGpioPinChoice({ board: s3, pin: 7, requirement: "digital_out", usedPins: [4, 7] });
    expect(verdict).toMatchObject({ allowed: false, state: "used" });
    expect(verdict.explanation).toMatch(/already assigned/i);
  });

  it("does not let an entity conflict with its own pin while it is edited", () => {
    const model = buildGpioPinSelectorModel({
      board: s3,
      requirement: "digital_out",
      usedPins: used,
      editing: { entityKind: "switch", id: "sw-1" },
    });
    expect(entry(model.entries, 4)).toMatchObject({ state: "available", selectable: true, isCurrent: true });
    expect(entry(model.entries, 7)).toMatchObject({ state: "used", selectable: false });
  });

  it("explains every pin that cannot be selected", () => {
    for (const requirement of ["digital_out", "pwm", "digital_in", "adc", "i2c"] as PinOperationRequirement[]) {
      for (const board of [s3, xiaoS3, xiaoC3, xiaoPlus]) {
        const model = buildGpioPinSelectorModel({ board, requirement, usedPins: used });
        for (const e of model.entries) {
          if (!e.selectable) {
            expect(e.explanation, `${board.slug} GPIO${e.pin} ${requirement}`).toBeTruthy();
            expect(e.explanation).toContain(`GPIO ${e.pin}`);
          }
        }
      }
    }
  });

  it("restricts pins that cannot do what the selected type needs", () => {
    const output = buildGpioPinSelectorModel({ board: s3, requirement: "digital_out" });
    expect(entry(output.entries, 46)).toMatchObject({ state: "restricted", selectable: false });

    const analog = buildGpioPinSelectorModel({ board: s3, requirement: "adc" });
    const pin21 = entry(analog.entries, 21);
    expect(pin21).toMatchObject({ state: "restricted", selectable: false });
    expect(pin21.explanation).toMatch(/does not support analog input \(ADC\)/);
    // The same pin is fine for a relay.
    expect(entry(output.entries, 21)).toMatchObject({ state: "available", selectable: true });
  });

  it("blocks restricted pins: boot strapping, USB / JTAG and the BOOT button", () => {
    const model = buildGpioPinSelectorModel({ board: xiaoC3, requirement: "digital_out" });
    for (const pin of [2, 8, 9]) {
      const e = entry(model.entries, pin);
      expect(e).toMatchObject({ state: "restricted", selectable: false });
      expect(e.explanation).toMatch(/boot-strapping pin/);
    }
    const usb = evaluateGpioPinChoice({ board: s3, pin: 19, requirement: "digital_out" });
    expect(usb).toMatchObject({ allowed: false, state: "restricted" });
    expect(usb.explanation).toMatch(/USB \/ JTAG/);
  });

  it("suggests suitable pins for the selected type", () => {
    // I2C sensor: the board's own SDA pad first.
    expect(buildGpioPinSelectorModel({ board: xiaoS3, requirement: "i2c" }).suggestions[0]).toBe(5);
    expect(buildGpioPinSelectorModel({ board: xiaoC3, requirement: "i2c" }).suggestions[0]).toBe(6);

    // Analog sensor: only pins that can read analog voltages.
    const analog = buildGpioPinSelectorModel({ board: xiaoC3, requirement: "adc" });
    expect(analog.suggestions).toEqual([3, 4]);

    // Relay output: avoids the labelled bus pads while free plain pins exist.
    const relay = buildGpioPinSelectorModel({ board: xiaoC3, requirement: "digital_out" });
    expect(relay.suggestions[0]).toBe(5);
    for (const pin of relay.suggestions) {
      expect(entry(relay.entries, pin)).toMatchObject({ state: "available", selectable: true });
    }
    expect(relay.suggestions.map((pin) => entry(relay.entries, pin).suggestionRank)).toEqual([1, 2, 3]);

    // Suggestions move on once a pin is taken.
    const next = buildGpioPinSelectorModel({
      board: xiaoC3,
      requirement: "digital_out",
      usedPins: [{ pin: 5, entityKind: "device", id: "d", name: "Fan" }],
    });
    expect(next.suggestions).not.toContain(5);
  });

  it("gives every blocked pin a short reason tag and none to a selectable pin", () => {
    const model = buildGpioPinSelectorModel({ board: s3, requirement: "digital_out", usedPins: used });
    expect(entry(model.entries, 7).reasonTag).toBe("IN USE");
    expect(entry(model.entries, 35).reasonTag).toBe("FLASH");
    expect(entry(model.entries, 0).reasonTag).toBe("STRAP");
    expect(entry(model.entries, 19).reasonTag).toBe("USB");
    for (const e of model.entries) {
      if (e.selectable) expect(e.reasonTag, `GPIO${e.pin}`).toBeNull();
      else expect(e.reasonTag, `GPIO${e.pin}`).toMatch(/^[A-Z0-9][A-Z0-9 /-]*$/);
    }

    // A capability the pin lacks is named, so the tile says what is missing.
    const analog = buildGpioPinSelectorModel({ board: xiaoC3, requirement: "adc" });
    const noAdc = analog.entries.filter((e) => e.reasonTag === "NO ADC").map((e) => e.pin);
    expect(noAdc.length).toBeGreaterThan(0);
    for (const pin of noAdc) expect(entry(analog.entries, pin).state).toBe("restricted");
  });

  it("shows the name printed on the board only when it says more than the GPIO number", () => {
    // The DevKitC silk prints bare numbers: nothing to add next to "GPIO11".
    const devkit = buildGpioPinSelectorModel({ board: s3, requirement: "digital_out" });
    expect(entry(devkit.entries, 11).boardPinName).toBeNull();
    expect(entry(devkit.entries, 11).label).toBe("GPIO11");
    // A XIAO pad has its own name, which is what the user reads on the board.
    const xiao = buildGpioPinSelectorModel({ board: xiaoC3, requirement: "digital_out" });
    expect(entry(xiao.entries, 6).boardPinName).toBe("D4 / SDA");
    expect(entry(xiao.entries, 6).roles).toContain("SDA");
  });

  it("suggests the board's SDA pad for an I2C sensor and keeps off the other bus pads", () => {
    const model = buildGpioPinSelectorModel({ board: xiaoC3, requirement: "i2c" });
    expect(model.suggestions[0]).toBe(6);
    const roles = (pin: number) => entry(model.entries, pin).roles;
    for (const pin of model.suggestions.slice(1)) {
      // No SCL, UART or SPI pad is proposed as an SDA line while plain pins are free.
      expect(roles(pin), `GPIO${pin}`).toEqual([]);
    }
    // With the SDA pad taken, the suggestions still avoid the labelled bus pads.
    const taken = buildGpioPinSelectorModel({
      board: xiaoC3,
      requirement: "i2c",
      usedPins: [{ pin: 6, entityKind: "sensor", id: "s", name: "Air Quality" }],
    });
    expect(taken.suggestions).not.toContain(6);
    expect(taken.suggestions.length).toBeGreaterThan(0);
    for (const pin of taken.suggestions) expect(entry(taken.entries, pin).roles, `GPIO${pin}`).toEqual([]);
  });

  it("prefers main header pins over extra solder pads and on-board parts", () => {
    const model = buildGpioPinSelectorModel({ board: xiaoPlus, requirement: "digital_out" });
    for (const pin of model.suggestions) {
      expect(entry(model.entries, pin).location).toBe("header");
    }
    // Back pads stay selectable, the on-board LED is selectable with a note.
    expect(entry(model.entries, 38)).toMatchObject({ location: "pad", selectable: true, state: "available" });
    expect(entry(model.entries, 21)).toMatchObject({ location: "onboard", selectable: true, caution: true });
  });

  it("keeps an existing assignment selectable even on a pin it would not offer today", () => {
    const model = buildGpioPinSelectorModel({
      board: s3,
      requirement: "digital_out",
      usedPins: [{ pin: 0, entityKind: "device", id: "legacy", name: "Old Relay" }],
      editing: { entityKind: "device", id: "legacy" },
    });
    const pin0 = entry(model.entries, 0);
    expect(pin0).toMatchObject({ state: "restricted", selectable: true, isCurrent: true, caution: true });
    expect(pin0.explanation).toMatch(/^Currently assigned here\./);
    // Without the existing assignment the same pin is refused.
    expect(evaluateGpioPinChoice({ board: s3, pin: 0, requirement: "digital_out" }).allowed).toBe(false);
  });

  it("refuses pins that do not exist on the board", () => {
    const verdict = evaluateGpioPinChoice({ board: xiaoC3, pin: 40, requirement: "digital_out" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.explanation).toBe("GPIO 40 does not exist on XIAO ESP32-C3.");
  });

  it("never offers a pin the existing GPIO validator rejects or warns about", () => {
    const boards = [...VERIFIED_BOARD_CATALOG, ...SEEED_XIAO_OFFICIAL_BOARDS.map((b) => b.seed)];
    for (const board of boards) {
      for (const requirement of ["digital_out", "pwm", "digital_in", "adc", "i2c"] as PinOperationRequirement[]) {
        const model = buildGpioPinSelectorModel({ board, requirement });
        for (const e of model.entries.filter((x) => x.selectable)) {
          const check = validateGpioAssignment({
            board,
            pin: e.pin,
            requirement,
            usedPinsOnController: [],
          });
          expect(check.valid, `${board.slug} GPIO${e.pin} ${requirement}`).toBe(true);
          expect(check.warnings, `${board.slug} GPIO${e.pin} ${requirement}`).toEqual([]);
        }
      }
    }
  });

  it("agrees with the Smart Home Planner: every pin the planner hands out is selectable", () => {
    for (const board of VERIFIED_BOARD_CATALOG) {
      const capability = evaluatePlannerBoardCapability({
        ...board,
        id: board.slug,
        source: "catalog",
        is_available: true,
        verification_status: "verified",
      });
      const demands: Array<[keyof typeof capability.pinsFor, PinOperationRequirement]> = [
        ["digital_out", "digital_out"],
        ["pwm", "pwm"],
        ["digital_in", "digital_in"],
        ["adc", "adc"],
        ["i2c", "i2c"],
      ];
      for (const [demand, requirement] of demands) {
        const model = buildGpioPinSelectorModel({ board, requirement });
        const selectable = new Set(model.entries.filter((e) => e.selectable).map((e) => e.pin));
        for (const pin of capability.pinsFor[demand]) {
          expect(selectable.has(pin), `${board.slug} ${demand} GPIO${pin}`).toBe(true);
        }
      }
    }
  });
});
