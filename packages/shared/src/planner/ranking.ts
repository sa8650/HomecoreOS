/**
 * Smart Home Planner — (6) recommendation ranking.
 *
 * A strict, explainable ordering. No scores, weights or learned preferences:
 * candidates are compared one criterion at a time, most important first, so the
 * reason a board ranks above another can always be stated in a sentence.
 */
import { plannerFirmwareStateRank } from "./firmware";
import type {
  PlannerBoardStatusCode,
  PlannerFirmwareState,
  PlannerReadiness,
} from "./types";

export interface PlannerRankFacts {
  boardId: string;
  label: string;
  catalogCategory: string | null;
  readiness: PlannerReadiness;
  /** Every channel received a validated pin. */
  fits: boolean;
  unallocated: number;
  boardStatus: PlannerBoardStatusCode;
  firmwareState: PlannerFirmwareState;
  installable: boolean;
  validatedForBoard: boolean;
  otaAvailable: boolean;
  controllerCount: number;
  futureSatisfied: boolean;
  sparePins: number;
}

const READINESS_ORDER: Record<PlannerReadiness, number> = {
  ready: 0,
  partially_ready: 1,
  not_supported: 2,
};

const BOARD_STATUS_ORDER: Record<PlannerBoardStatusCode, number> = {
  published: 0,
  unpublished: 1,
  unverified: 2,
  unsupported: 3,
};

/** Same source ordering the Board Library uses for its own listing. */
function categoryOrder(category: string | null): number {
  if (category === "official_espressif") return 0;
  if (category === "partner") return 1;
  return 2;
}

function flag(value: boolean): number {
  return value ? 0 : 1;
}

/** Negative when `a` is the better recommendation. */
export function comparePlannerCandidates(a: PlannerRankFacts, b: PlannerRankFacts): number {
  return (
    READINESS_ORDER[a.readiness] - READINESS_ORDER[b.readiness] ||
    flag(a.fits) - flag(b.fits) ||
    a.unallocated - b.unallocated ||
    BOARD_STATUS_ORDER[a.boardStatus] - BOARD_STATUS_ORDER[b.boardStatus] ||
    flag(a.installable) - flag(b.installable) ||
    plannerFirmwareStateRank(b.firmwareState) - plannerFirmwareStateRank(a.firmwareState) ||
    flag(a.validatedForBoard) - flag(b.validatedForBoard) ||
    flag(a.otaAvailable) - flag(b.otaAvailable) ||
    a.controllerCount - b.controllerCount ||
    flag(a.futureSatisfied) - flag(b.futureSatisfied) ||
    b.sparePins - a.sparePins ||
    categoryOrder(a.catalogCategory) - categoryOrder(b.catalogCategory) ||
    a.label.localeCompare(b.label) ||
    a.boardId.localeCompare(b.boardId)
  );
}

export function rankPlannerCandidates<T extends { facts: PlannerRankFacts }>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => comparePlannerCandidates(a.facts, b.facts));
}

function controllers(count: number): string {
  return `${count} controller${count === 1 ? "" : "s"}`;
}

/** Sentences explaining how `candidate` differs from the recommended plan. */
export function comparePlannerPlanToBest(candidate: PlannerRankFacts, best: PlannerRankFacts): string[] {
  const notes: string[] = [];
  if (candidate.controllerCount !== best.controllerCount && candidate.fits && best.fits) {
    notes.push(
      candidate.controllerCount > best.controllerCount
        ? `Needs ${controllers(candidate.controllerCount)} instead of ${best.controllerCount}.`
        : `Needs only ${controllers(candidate.controllerCount)} instead of ${best.controllerCount}.`
    );
  }
  if (candidate.boardStatus !== best.boardStatus) {
    notes.push(
      BOARD_STATUS_ORDER[candidate.boardStatus] > BOARD_STATUS_ORDER[best.boardStatus]
        ? "Its Board Library status is weaker than the recommended board's."
        : "Its Board Library status is stronger than the recommended board's."
    );
  }
  if (candidate.installable !== best.installable) {
    notes.push(
      candidate.installable
        ? "Unlike the recommended board, it has an installable firmware release."
        : "Unlike the recommended board, it has no installable firmware release yet."
    );
  } else if (candidate.firmwareState !== best.firmwareState) {
    notes.push("Its firmware is at a different stage than the recommended board's.");
  }
  if (candidate.fits && best.fits && candidate.sparePins !== best.sparePins) {
    notes.push(
      candidate.sparePins > best.sparePins
        ? `Leaves ${candidate.sparePins - best.sparePins} more spare pins for future devices.`
        : `Leaves ${best.sparePins - candidate.sparePins} fewer spare pins for future devices.`
    );
  }
  return notes;
}
