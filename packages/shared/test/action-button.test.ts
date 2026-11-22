import { describe, expect, it } from "vitest";
import {
  ACTION_BUTTON_MAX_STEPS,
  collectActionButtonReferences,
  countActionButtonSteps,
  isGestureConfigured,
  validateActionButtonGestures,
  validateActionButtonSteps,
  type ActionButtonGestures,
} from "../src/action-button";

const validSingle = { id: "s1", kind: "switch", switchId: "sw-1", op: "toggle" } as const;

describe("action-button shared validation", () => {
  it("accepts a minimal valid gestures payload", () => {
    const result = validateActionButtonGestures({
      single: [validSingle],
      double: null,
      long: null,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("requires at least one single-press step", () => {
    const result = validateActionButtonGestures({ single: [], double: null, long: null });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Single press/);
  });

  it("rejects unknown step kinds and bad ops", () => {
    const result = validateActionButtonGestures({
      single: [
        { id: "x", kind: "sensor", sensorId: "s", op: "on" },
        { id: "y", kind: "switch", switchId: "sw-1", op: "blink" },
      ],
      double: null,
      long: null,
    } as unknown as ActionButtonGestures);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Unknown step kind/);
    expect(result.errors.join(" ")).toMatch(/op must be/);
  });

  it("enforces delay ceilings per step and in total", () => {
    const perStep = validateActionButtonGestures({
      single: [{ id: "d", kind: "delay", ms: 20_000 }],
      double: null,
      long: null,
    });
    expect(perStep.ok).toBe(false);

    const totalBudget = validateActionButtonGestures({
      single: Array.from({ length: 3 }, (_, i) => ({
        id: `d${i}`,
        kind: "delay" as const,
        ms: 6_000,
      })),
      double: null,
      long: null,
    });
    expect(totalBudget.ok).toBe(false);
    expect(totalBudget.errors.join(" ")).toMatch(/total delay/i);
  });

  it("caps the step count", () => {
    const steps = Array.from({ length: ACTION_BUTTON_MAX_STEPS + 1 }, (_, i) => ({
      id: `s${i}`,
      kind: "delay" as const,
      ms: 1,
    }));
    const errors = validateActionButtonSteps(steps);
    expect(errors.join(" ")).toMatch(/at most/);
  });

  it("validates double/long gestures when present and clears when null", () => {
    const configured = validateActionButtonGestures({
      single: [validSingle],
      double: [{ id: "d1", kind: "device", deviceId: "dev-1", op: "on" }],
      long: [{ id: "l1", kind: "all", target: "switches", op: "off" }],
    });
    expect(configured.ok).toBe(true);

    const emptyOptional = validateActionButtonGestures({
      single: [validSingle],
      double: [],
      long: null,
    });
    expect(emptyOptional.ok).toBe(false);
  });

  it("collects references across all gestures", () => {
    const refs = collectActionButtonReferences({
      single: [
        { id: "1", kind: "switch", switchId: "sw-1", op: "on" },
        { id: "2", kind: "room", roomId: "room-1", target: "all", op: "off" },
      ],
      double: [{ id: "3", kind: "device", deviceId: "dev-1", op: "toggle" }],
      long: [{ id: "4", kind: "automation", automationId: "aut-1" }],
    });
    expect([...refs.switchIds]).toEqual(["sw-1"]);
    expect([...refs.deviceIds]).toEqual(["dev-1"]);
    expect([...refs.roomIds]).toEqual(["room-1"]);
    expect([...refs.automationIds]).toEqual(["aut-1"]);
    expect(refs.includesBulkTargets).toBe(true);
  });

  it("reports gesture configuration state and step counts", () => {
    const gestures: ActionButtonGestures = {
      single: [validSingle],
      double: [validSingle],
      long: null,
    };
    expect(isGestureConfigured(gestures, "single")).toBe(true);
    expect(isGestureConfigured(gestures, "double")).toBe(true);
    expect(isGestureConfigured(gestures, "long")).toBe(false);
    expect(countActionButtonSteps(gestures)).toEqual({ single: 1, double: 1, long: 0 });
  });
});
