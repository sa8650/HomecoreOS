import {
  ONBOARDING_TOTAL_STEPS,
  isOnboardingStep,
  normalizeOnboardingStep,
  resolveOnboardingState,
  type OnboardingState,
  type OnboardingStepId,
} from "@homecoreos/shared";
import { recordActivity } from "./audit";
import type { DbClient } from "./db";

export const ONBOARDING_COLUMNS =
  "onboarding_step,onboarding_started_at,onboarding_completed_at";

interface OnboardingRow {
  onboarding_step?: number | string | null;
  onboarding_started_at?: string | null;
  onboarding_completed_at?: string | null;
}

/** Read the persisted onboarding state for one user. Missing rows mean "fresh user". */
export async function readOnboardingState(
  db: DbClient,
  userId: string
): Promise<OnboardingState> {
  const { data } = await db
    .from("users")
    .select(ONBOARDING_COLUMNS)
    .eq("id", userId)
    .maybeSingle();

  return resolveOnboardingState(data as OnboardingRow | null);
}

export interface SaveOnboardingResult {
  ok: boolean;
  status: number;
  error?: string;
  code?: "invalid_step" | "not_found";
  state?: OnboardingState;
}

/**
 * Persist the step a user is on, exactly as they left it, so a refresh (or a
 * second tab) resumes on the same screen. A completion timestamp is never
 * cleared or rewritten, so finishing can never be undone by going Back.
 */
export async function saveOnboardingProgress(
  db: DbClient,
  userId: string,
  rawStep: unknown
): Promise<SaveOnboardingResult> {
  if (!isOnboardingStep(rawStep)) {
    return { ok: false, status: 400, error: "Pick a step between 1 and 4.", code: "invalid_step" };
  }
  const step = normalizeOnboardingStep(rawStep);

  const current = await readOnboardingState(db, userId);
  if (current.completedAt) {
    return { ok: true, status: 200, state: current };
  }

  const nextStep: OnboardingStepId = step;

  const patch: Record<string, unknown> = { onboarding_step: nextStep };
  if (!current.startedAt) patch.onboarding_started_at = new Date().toISOString();

  const { error } = await db.from("users").update(patch).eq("id", userId);
  if (error) {
    return { ok: false, status: 500, error: "Your onboarding progress could not be saved." };
  }

  return {
    ok: true,
    status: 200,
    state: {
      required: true,
      step: nextStep,
      completedAt: null,
      startedAt: current.startedAt ?? (patch.onboarding_started_at as string),
    },
  };
}

/**
 * Finish onboarding. Idempotent: completing twice keeps the original timestamp,
 * so a double click or a retried request never rewrites history.
 */
export async function completeOnboarding(
  db: DbClient,
  userId: string,
  accountId: string | null,
  options?: { actorEmail?: string | null }
): Promise<SaveOnboardingResult> {
  const current = await readOnboardingState(db, userId);
  if (current.completedAt) {
    return { ok: true, status: 200, state: current };
  }

  const completedAt = new Date().toISOString();
  const { error } = await db
    .from("users")
    .update({
      onboarding_step: ONBOARDING_TOTAL_STEPS,
      onboarding_completed_at: completedAt,
      onboarding_started_at: current.startedAt ?? completedAt,
    })
    .eq("id", userId);

  if (error) {
    return { ok: false, status: 500, error: "Onboarding could not be completed." };
  }

  if (accountId) {
    await recordActivity(db, {
      accountId,
      actorUserId: userId,
      category: "account",
      action: "account.onboarding_completed",
      summary: `${options?.actorEmail ?? "The account owner"} finished the four-step onboarding`,
    }).catch(() => null);
  }

  return {
    ok: true,
    status: 200,
    state: {
      required: false,
      step: ONBOARDING_TOTAL_STEPS,
      completedAt,
      startedAt: current.startedAt ?? completedAt,
    },
  };
}
