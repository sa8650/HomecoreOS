import {
  PLANNER_STAGE_LABELS,
  PLANNER_STAGE_ORDER,
  type PlannerStage,
  type PlannerStageEvent,
} from "@homecoreos/shared";
import {
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiLoader4Line,
  RiSubtractLine,
} from "@remixicon/react";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";

/** Every stage starts as "pending" and only changes when the Worker reports it. */
export function createPendingStages(): PlannerStage[] {
  return PLANNER_STAGE_ORDER.map((id) => ({
    id,
    label: PLANNER_STAGE_LABELS[id],
    status: "pending",
    durationMs: null,
    detail: null,
  }));
}

/** Applies one stage event exactly as the Worker sent it. */
export function applyStageEvent(stages: PlannerStage[], event: PlannerStageEvent): PlannerStage[] {
  return stages.map((stage) =>
    stage.id === event.id
      ? {
          ...stage,
          status: event.status,
          durationMs: event.durationMs ?? null,
          detail: event.detail ?? null,
        }
      : stage
  );
}

/** Marks stages that were still in flight when the analysis stopped. */
export function failRunningStages(stages: PlannerStage[]): PlannerStage[] {
  return stages.map((stage) =>
    stage.status === "running" ? { ...stage, status: "failed" } : stage
  );
}

function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  if (durationMs < 1) return "under 1 ms";
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]!.toLowerCase()}`;
}

function countStages(stages: PlannerStage[]): { completed: number; skipped: number } {
  let completed = 0;
  let skipped = 0;
  for (const stage of stages) {
    if (stage.status === "completed") completed += 1;
    else if (stage.status === "skipped") skipped += 1;
  }
  return { completed, skipped };
}

export function describePlannerProgress(stages: PlannerStage[]): string {
  if (stages.some((stage) => stage.status === "failed")) return "The analysis stopped";
  const running = stages.filter((stage) => stage.status === "running");
  if (running.length > 0) return joinLabels(running.map((stage) => stage.label));
  const { completed, skipped } = countStages(stages);
  if (completed + skipped === stages.length) {
    // Steps are only skipped when the planner cannot go on, so that is not "complete".
    return skipped > 0 ? "Analysis ended early" : "Analysis complete";
  }
  if (completed + skipped === 0) return "Sending your requirements";
  return "Waiting for the next step";
}

/** "2 of 9 steps", counting only steps that really ran to the end. */
export function describePlannerStepCount(stages: PlannerStage[]): string {
  const { completed, skipped } = countStages(stages);
  const ran = `${completed} of ${stages.length} steps`;
  return skipped > 0 ? `${ran}, ${skipped} skipped` : ran;
}

/**
 * Shows the planner's stages. Nothing here is timed or simulated: a stage is
 * "running" or "completed" only because the Worker said so, and the detail and
 * duration under each stage are the values it measured.
 */
export function PlannerAnalysisProgress({
  stages,
  live = false,
  className,
}: {
  stages: PlannerStage[];
  /** True while the analysis is still running. */
  live?: boolean;
  className?: string;
}) {
  // Only steps that really ran move the bar. A skipped step is not progress.
  const { completed } = countStages(stages);
  const failed = stages.some((stage) => stage.status === "failed");
  const percent = stages.length === 0 ? 0 : Math.round((completed / stages.length) * 100);
  const status = describePlannerProgress(stages);
  const stepCount = describePlannerStepCount(stages);

  return (
    <div className={cn("min-w-0 space-y-3", className)} data-testid="planner-stage-progress">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {live && !failed && (
            <span className="relative flex size-2.5 shrink-0">
              <span className="hc-pulse-ring absolute inline-flex h-full w-full rounded-full bg-primary" />
              <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
            </span>
          )}
          <p
            role="status"
            aria-live="polite"
            className="min-w-0 break-words text-xs font-semibold text-foreground"
          >
            {status}
          </p>
        </div>
        <p className="shrink-0 text-xs tabular-nums text-muted-foreground">{stepCount}</p>
      </div>

      {/* The shared Progress only styles its bar, so the value is stated for assistive tech here. */}
      <Progress
        value={percent}
        aria-label="Analysis progress"
        aria-valuenow={percent}
        aria-valuetext={`${stepCount} finished`}
        className={cn(
          "h-1.5",
          failed && "[&>[data-slot=progress-indicator]]:bg-destructive",
          !failed && completed === stages.length && "[&>[data-slot=progress-indicator]]:bg-success",
          live && !failed && "[&>[data-slot=progress-indicator]]:hc-progress-shimmer"
        )}
      />

      <ol className="grid grid-cols-1 gap-1.5 md:grid-cols-3" aria-label="Analysis steps">
        {stages.map((stage, index) => {
          const duration = formatDuration(stage.durationMs);
          return (
            <li
              key={stage.id}
              data-stage={stage.id}
              data-status={stage.status}
              className={cn(
                "min-w-0 rounded-lg border-l-2 px-3 py-2 transition-colors duration-300",
                stage.status === "completed" && "border-success/40 bg-success/10",
                stage.status === "running" && "hc-stage-active border-primary/55 bg-primary/10",
                stage.status === "failed" && "border-destructive/45 bg-destructive/10",
                stage.status === "skipped" && "border-border bg-muted/50",
                stage.status === "pending" && "border-border bg-card opacity-70"
              )}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums",
                    stage.status === "completed" && "bg-success text-white",
                    stage.status === "running" && "bg-primary text-primary-foreground",
                    stage.status === "failed" && "bg-destructive text-white",
                    (stage.status === "pending" || stage.status === "skipped") &&
                      "bg-muted text-muted-foreground"
                  )}
                >
                  {stage.status === "completed" ? (
                    <RiCheckboxCircleFill className="size-3.5" aria-hidden="true" />
                  ) : stage.status === "running" ? (
                    <RiLoader4Line className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : stage.status === "failed" ? (
                    <RiCloseCircleFill className="size-3.5" aria-hidden="true" />
                  ) : stage.status === "skipped" ? (
                    <RiSubtractLine className="size-3.5" aria-hidden="true" />
                  ) : (
                    index + 1
                  )}
                </span>
                <p className="min-w-0 flex-1 break-words text-[11px] font-semibold leading-tight text-foreground">
                  {stage.label}
                </p>
                {duration && (
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    {duration}
                  </span>
                )}
              </div>
              <p className="mt-1 min-h-[14px] break-words text-[10px] leading-snug text-muted-foreground">
                <span className="sr-only">
                  {stage.status === "completed"
                    ? "Done. "
                    : stage.status === "running"
                      ? "In progress. "
                      : stage.status === "failed"
                        ? "Stopped. "
                        : stage.status === "skipped"
                          ? "Not needed. "
                          : "Waiting. "}
                </span>
                {stage.detail ??
                  (stage.status === "running"
                    ? "Working…"
                    : stage.status === "skipped"
                      ? "Not needed for this plan"
                      : stage.status === "failed"
                        ? "Did not finish"
                        : "")}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
