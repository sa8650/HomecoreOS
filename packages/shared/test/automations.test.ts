import { describe, expect, it } from "vitest";
import {
  analyzeLocalAutomationCapability,
  buildTriggerConfigFromList,
  computeSunTimeHHMM,
  normalizeConditionGroups,
  normalizeTriggerList,
  validateAutomationDraft,
} from "../src/automations";

describe("Shared Automation Helpers & NOAA Solar Calculator", () => {
  it("computes realistic sunrise/sunset HH:MM times with offsets across timezones", () => {
    const winterDate = new Date("2026-11-10T06:00:00Z");
    const dhakaSunrise = computeSunTimeHHMM({
      date: winterDate,
      event: "sunrise",
      timezone: "Asia/Dhaka",
    });
    const dhakaSunset = computeSunTimeHHMM({
      date: winterDate,
      event: "sunset",
      timezone: "Asia/Dhaka",
    });
    const dhakaEarlySunset = computeSunTimeHHMM({
      date: winterDate,
      event: "sunset",
      timezone: "Asia/Dhaka",
      offsetMinutes: -30,
    });

    expect(dhakaSunrise).toMatch(/^0[56]:\d{2}$/);
    expect(dhakaSunset).toMatch(/^1[78]:\d{2}$/);
    expect(dhakaEarlySunset < dhakaSunset).toBe(true);
  });

  it("normalizes single/multi triggers and flat/grouped conditions", () => {
    const multi = buildTriggerConfigFromList([
      { type: "sensor_value", sensorId: "s1", operator: "gt", threshold: 30 },
      { type: "sun_event", sunEvent: "sunset", offsetMinutes: -15 },
    ]);
    expect(normalizeTriggerList(multi)).toHaveLength(2);

    const flatGroups = normalizeConditionGroups([
      { type: "switch_state", switchId: "sw1", expectedState: true },
    ]);
    expect(flatGroups.logic).toBe("AND");
    expect(flatGroups.groups).toHaveLength(1);
    expect(flatGroups.groups[0].conditions).toHaveLength(1);
  });

  it("validates drafts and detects single-controller local offline eligibility", () => {
    const invalid = validateAutomationDraft({
      name: "  ",
      triggers: [],
      conditions: { logic: "AND", groups: [] },
      actions: [{ type: "scene", sceneName: "", targets: [] }],
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.length).toBeGreaterThanOrEqual(3);

    const switchControllerById = new Map([
      ["sw1", "ctrl-a"],
      ["sw2", "ctrl-b"],
    ]);
    const sensorControllerById = new Map([["sen1", "ctrl-a"]]);
    const deviceControllerById = new Map<string, string>();

    const localOk = analyzeLocalAutomationCapability({
      triggers: [{ type: "sensor_value", sensorId: "sen1", operator: "gt", threshold: 25 }],
      conditions: { logic: "AND", groups: [] },
      actions: [{ type: "switch_on", switchId: "sw1" }],
      switchControllerById,
      deviceControllerById,
      sensorControllerById,
    });
    expect(localOk.supported).toBe(true);
    expect(localOk.controllerId).toBe("ctrl-a");

    const crossCtrl = analyzeLocalAutomationCapability({
      triggers: [{ type: "sensor_value", sensorId: "sen1", operator: "gt", threshold: 25 }],
      conditions: {
        logic: "AND",
        groups: [
          {
            logic: "AND",
            conditions: [{ type: "room_state", roomId: "r1", roomMatch: "any_on" }],
          },
        ],
      },
      actions: [{ type: "switch_on", switchId: "sw2" }],
      switchControllerById,
      deviceControllerById,
      sensorControllerById,
    });
    expect(crossCtrl.supported).toBe(false);
    expect(crossCtrl.reasons.length).toBeGreaterThanOrEqual(2);
  });
});
