import { describe, expect, it } from "vitest";
import { entityStateMeta, isEntityCommandInFlight, resolveEntityVisualState } from "./entity-state";

const online = { status: "online" as const, mqtt_connected: true };
const offline = { status: "offline" as const, mqtt_connected: false };

describe("entity state presentation", () => {
  it("shows the controller-confirmed state when nothing is outstanding", () => {
    expect(
      resolveEntityVisualState({ appliedOn: true, status: "synced", ctrl: online })
    ).toBe("on");
    expect(
      resolveEntityVisualState({ appliedOn: false, status: "synced", ctrl: online })
    ).toBe("off");
  });

  it("never reports an unconfirmed command as applied", () => {
    // Confirmed off, but the user asked for on and the controller has not
    // answered: this must read as pending, not "on".
    const meta = entityStateMeta({
      appliedOn: false,
      desiredOn: true,
      status: "pending",
      ctrl: online,
    });
    expect(meta.label).toBe("Turning on");
    expect(meta.isPending).toBe(true);
    expect(resolveEntityVisualState({
      appliedOn: false,
      desiredOn: true,
      status: "pending",
      ctrl: online,
    })).not.toBe("on");
  });

  it("treats a pending command on an offline controller as pending, not offline", () => {
    // The honest answer is "queued", because it will apply on reconnect.
    const state = resolveEntityVisualState({
      appliedOn: false,
      desiredOn: true,
      status: "pending",
      ctrl: offline,
    });
    expect(state).toBe("pending-on");
  });

  it("reports offline when there is no outstanding command", () => {
    expect(
      resolveEntityVisualState({ appliedOn: true, status: "synced", ctrl: offline })
    ).toBe("offline");
  });

  it("reports failure ahead of pending and offline", () => {
    expect(
      resolveEntityVisualState({
        appliedOn: false,
        desiredOn: true,
        status: "failed",
        ctrl: offline,
      })
    ).toBe("failed");
  });

  it("does not render an active toggle for an unconfirmed state", () => {
    const meta = entityStateMeta({
      appliedOn: false,
      desiredOn: true,
      status: "pending",
      ctrl: online,
    });
    // showAsOn reflects intent for the switch thumb, but the label makes clear
    // it is not yet confirmed.
    expect(meta.label).not.toBe("On");
  });

  it("flags in-flight commands so the toggle can be disabled", () => {
    expect(isEntityCommandInFlight({ appliedOn: false, status: "pending" })).toBe(true);
    expect(isEntityCommandInFlight({ appliedOn: false, status: "synced" })).toBe(false);
    expect(isEntityCommandInFlight({ appliedOn: false, status: "failed" })).toBe(false);
  });

  it("describes each state in plain language", () => {
    const states = [
      entityStateMeta({ appliedOn: true, status: "synced", ctrl: online }),
      entityStateMeta({ appliedOn: false, status: "synced", ctrl: online }),
      entityStateMeta({ appliedOn: false, desiredOn: true, status: "pending", ctrl: online }),
      entityStateMeta({ appliedOn: false, status: "failed", ctrl: online }),
      entityStateMeta({ appliedOn: false, status: "synced", ctrl: offline }),
    ];
    for (const meta of states) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
    // Every state is visually distinguishable.
    expect(new Set(states.map((s) => s.tone)).size).toBe(5);
  });
});
