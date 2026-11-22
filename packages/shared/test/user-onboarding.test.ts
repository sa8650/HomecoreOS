import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEPS,
  ONBOARDING_TOTAL_STEPS,
  canAdvanceOnboarding,
  isOnboardingStep,
  normalizeOnboardingStep,
  onboardingStepDefinition,
  resolveOnboardingState,
} from "../src/user-onboarding";

describe("user onboarding contract", () => {
  it("defines exactly four ordered steps with stable titles", () => {
    expect(ONBOARDING_TOTAL_STEPS).toBe(4);
    expect(ONBOARDING_STEPS.map((s) => s.id)).toEqual([1, 2, 3, 4]);
    expect(ONBOARDING_STEPS.map((s) => s.title)).toEqual([
      "Welcome to Your Smart Home",
      "Connect Your Hardware",
      "Control and Automate Your Home",
      "Monitor, Manage and Expand",
    ]);
    expect(onboardingStepDefinition(3).shortLabel).toBe("Control");
  });

  it("treats a missing completion timestamp as still required", () => {
    expect(resolveOnboardingState({ onboarding_step: 2 })).toEqual({
      required: true,
      step: 2,
      completedAt: null,
      startedAt: null,
    });
    expect(resolveOnboardingState(null)).toEqual({
      required: true,
      step: 1,
      completedAt: null,
      startedAt: null,
    });
  });

  it("never reports a completed account as required, whatever the stored step", () => {
    const state = resolveOnboardingState({
      onboarding_step: 1,
      onboarding_completed_at: "2026-11-19T10:00:00.000Z",
      onboarding_started_at: "2026-11-18T10:00:00.000Z",
    });
    expect(state.required).toBe(false);
    expect(state.step).toBe(4);
    expect(state.completedAt).toBe("2026-11-19T10:00:00.000Z");
  });

  it("normalizes strings, nulls and out-of-range values defensively", () => {
    expect(normalizeOnboardingStep("3")).toBe(3);
    expect(normalizeOnboardingStep(0)).toBe(1);
    expect(normalizeOnboardingStep(9)).toBe(1);
    expect(normalizeOnboardingStep(null)).toBe(1);
    expect(normalizeOnboardingStep(undefined)).toBe(1);
    expect(isOnboardingStep(4)).toBe(true);
    expect(isOnboardingStep(4.5)).toBe(false);
    expect(isOnboardingStep("4")).toBe(false);
  });

  it("only allows advancing one step forward, never skipping a step", () => {
    expect(canAdvanceOnboarding(1, 2)).toBe(true);
    expect(canAdvanceOnboarding(3, 4)).toBe(true);
    expect(canAdvanceOnboarding(1, 3)).toBe(false);
    expect(canAdvanceOnboarding(2, 2)).toBe(false);
    expect(canAdvanceOnboarding(2, 1)).toBe(false);
    expect(canAdvanceOnboarding(4, 5)).toBe(false);
  });
});
