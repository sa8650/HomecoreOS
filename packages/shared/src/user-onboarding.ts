/**
 * Mandatory user onboarding contract shared by the Worker, the web console and tests.
 *
 * Every newly registered customer completes the same four steps before the
 * dashboard unlocks. Progress lives on the user row, so refreshing, reopening
 * the site or signing out and back in resumes exactly where the user stopped.
 */

export const ONBOARDING_TOTAL_STEPS = 4;

export type OnboardingStepId = 1 | 2 | 3 | 4;

export interface OnboardingStepDefinition {
  id: OnboardingStepId;
  key: "welcome" | "hardware" | "control" | "monitor";
  title: string;
  /** Short label used in the progress indicator and the resume toast. */
  shortLabel: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStepDefinition[] = [
  {
    id: 1,
    key: "welcome",
    title: "Welcome to Your Smart Home",
    shortLabel: "Welcome",
  },
  {
    id: 2,
    key: "hardware",
    title: "Connect Your Hardware",
    shortLabel: "Hardware",
  },
  {
    id: 3,
    key: "control",
    title: "Control and Automate Your Home",
    shortLabel: "Control",
  },
  {
    id: 4,
    key: "monitor",
    title: "Monitor, Manage and Expand",
    shortLabel: "Expand",
  },
] as const;

/** Persisted onboarding state, as returned by the API and stored on `users`. */
export interface OnboardingState {
  /** True while the account still has to finish the four steps. */
  required: boolean;
  /** 1-based step the user should resume on. */
  step: OnboardingStepId;
  completedAt: string | null;
  startedAt: string | null;
}

export const ONBOARDING_COMPLETED_STATE: OnboardingState = {
  required: false,
  step: ONBOARDING_TOTAL_STEPS,
  completedAt: null,
  startedAt: null,
};

export function isOnboardingStep(value: unknown): value is OnboardingStepId {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= ONBOARDING_TOTAL_STEPS
  );
}

/** Clamp any stored value into the valid 1..4 range (defensive against bad rows). */
export function normalizeOnboardingStep(value: unknown): OnboardingStepId {
  const numeric =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!isOnboardingStep(numeric)) return 1;
  return numeric;
}

/**
 * Build the state a client should act on from raw column values.
 *
 * A user counts as onboarded as soon as a completion timestamp exists, which is
 * also how pre-existing accounts were backfilled by the migration.
 */
export function resolveOnboardingState(row: {
  onboarding_step?: number | string | null;
  onboarding_started_at?: string | null;
  onboarding_completed_at?: string | null;
} | null | undefined): OnboardingState {
  const completedAt = row?.onboarding_completed_at ?? null;
  const rawStep =
    typeof row?.onboarding_step === "string" ? Number(row.onboarding_step) : row?.onboarding_step;
  const step = normalizeOnboardingStep(rawStep);
  return {
    required: completedAt === null,
    step: completedAt === null ? step : ONBOARDING_TOTAL_STEPS,
    completedAt,
    startedAt: row?.onboarding_started_at ?? null,
  };
}

export function onboardingStepDefinition(step: OnboardingStepId): OnboardingStepDefinition {
  return ONBOARDING_STEPS[step - 1] ?? ONBOARDING_STEPS[0]!;
}

/**
 * Guard for the "Next" control: a step can only be left once the user has been
 * on it, and the last step never reports a next step.
 */
export function canAdvanceOnboarding(from: OnboardingStepId, to: number): boolean {
  return to === from + 1 && to <= ONBOARDING_TOTAL_STEPS;
}
