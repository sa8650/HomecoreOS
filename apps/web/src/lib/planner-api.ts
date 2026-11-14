/**
 * Smart Home Planner API client.
 *
 * Recommendations are always computed by the Worker from the live Board Library
 * and Firmware Management records. This module only transports requirements,
 * stage events and results; it never derives a hardware or readiness decision.
 */
import type {
  PlannerRequirementsInput,
  PlannerResult,
  PlannerResultState,
  PlannerStageEvent,
} from "@homecoreos/shared";
import { ApiError, apiFetch, cachedGet, getCachedSnapshot } from "@/lib/api";

export interface PlannerPlanSummary {
  id: string;
  name: string;
  /** "outdated": boards or firmware changed since the stored result was computed. */
  status: "current" | "outdated";
  resultState: PlannerResultState | null;
  headline: string | null;
  summary: string | null;
  recommendation: string | null;
  rooms: number;
  devices: number;
  connections: number;
  analyzedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PlannerCacheReason =
  | "first_analysis"
  | "catalog_changed"
  | "engine_updated"
  | "requirements_changed";

export interface PlannerPlanCache {
  /** "reused": the stored result was still valid. "recomputed": analyzed just now. */
  status: "reused" | "recomputed";
  reason: PlannerCacheReason | null;
}

export interface PlannerPlanDetail extends PlannerPlanSummary {
  requirements: PlannerRequirementsInput;
  result: PlannerResult;
  cache: PlannerPlanCache;
}

export interface PlannerAnalysis {
  result: PlannerResult;
  /** The validated requirements the result was computed from. */
  requirements: PlannerRequirementsInput;
}

const ANALYZE_PATH = "/api/planner/analyze";
const PLANS_PATH = "/api/planner/plans";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toAnalysis(value: unknown): PlannerAnalysis | null {
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.stages)) return null;
  return {
    result: value.result as unknown as PlannerResult,
    requirements: (isRecord(value.requirements) ? value.requirements : {}) as PlannerRequirementsInput,
  };
}

/**
 * Runs an analysis and reports each stage the moment the Worker starts or
 * finishes it. `onStage` is only ever called with events the Worker sent, so a
 * progress display built on it shows what is really happening.
 */
export async function analyzePlannerRequirements(
  requirements: PlannerRequirementsInput,
  options?: { onStage?: (event: PlannerStageEvent) => void; signal?: AbortSignal }
): Promise<PlannerAnalysis> {
  const response = await fetch(ANALYZE_PATH, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson, application/json",
    },
    body: JSON.stringify({ requirements }),
    signal: options?.signal,
  });

  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok || !contentType.includes("application/x-ndjson")) {
    const parsed: unknown = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : null;
    if (!response.ok) {
      const body = isRecord(parsed) ? parsed : {};
      throw new ApiError(
        typeof body.error === "string" ? body.error : `Request failed (${response.status})`,
        response.status,
        typeof body.code === "string" ? body.code : undefined
      );
    }
    // A single JSON document: no stage events were sent, so none are reported.
    const analysis = toAnalysis(parsed);
    if (!analysis) throw new ApiError("The planner returned an unexpected response.", 502);
    return analysis;
  }

  // Held in an object because it is assigned from inside the line handler.
  const outcome: { analysis: PlannerAnalysis | null } = { analysis: null };

  const handleLine = (line: string) => {
    const text = line.trim();
    if (!text) return;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      throw new ApiError("The analysis was interrupted. Please try again.", 502);
    }
    if (!isRecord(event)) return;
    if (event.type === "stage" && isRecord(event.stage)) {
      options?.onStage?.(event.stage as unknown as PlannerStageEvent);
    } else if (event.type === "result") {
      outcome.analysis = toAnalysis(event);
    } else if (event.type === "error") {
      throw new ApiError(
        typeof event.error === "string"
          ? event.error
          : "The analysis could not be completed. Please try again.",
        503
      );
    }
  };

  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    handleLine(buffer + decoder.decode());
  } else {
    for (const line of (await response.text()).split("\n")) handleLine(line);
  }

  if (!outcome.analysis) {
    throw new ApiError("The analysis ended before a result arrived. Please try again.", 502);
  }
  return outcome.analysis;
}

export interface PlannerPlanList {
  plans: PlannerPlanSummary[];
  /** Most plans one account may keep. */
  limit: number;
}

export function listPlannerPlans(options?: { force?: boolean }): Promise<PlannerPlanList> {
  return cachedGet<PlannerPlanList>(PLANS_PATH, { ttlMs: 15_000, force: options?.force });
}

/** The list from a recent visit, so the page can render before the request returns. */
export function getCachedPlannerPlans(): PlannerPlanList | null {
  return getCachedSnapshot<PlannerPlanList>(PLANS_PATH);
}

/** Opens a saved plan. The Worker re-analyzes it first if boards or firmware changed. */
export function openPlannerPlan(planId: string): Promise<{ plan: PlannerPlanDetail }> {
  return apiFetch(`${PLANS_PATH}/${encodeURIComponent(planId)}`);
}

export function createPlannerPlan(
  name: string,
  requirements: PlannerRequirementsInput
): Promise<{ plan: PlannerPlanDetail }> {
  return apiFetch(PLANS_PATH, { method: "POST", body: JSON.stringify({ name, requirements }) });
}

export function updatePlannerPlan(
  planId: string,
  changes: { name?: string; requirements?: PlannerRequirementsInput }
): Promise<{ plan: PlannerPlanDetail }> {
  return apiFetch(`${PLANS_PATH}/${encodeURIComponent(planId)}`, {
    method: "PATCH",
    body: JSON.stringify(changes),
  });
}

export function deletePlannerPlan(planId: string): Promise<{ ok: boolean }> {
  return apiFetch(`${PLANS_PATH}/${encodeURIComponent(planId)}`, { method: "DELETE" });
}
