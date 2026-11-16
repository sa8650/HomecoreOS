import {
  RiDeleteBinLine,
  RiEdit2Line,
  RiFolderOpenLine,
  RiHomeGearLine,
  RiLoader4Line,
} from "@remixicon/react";
import { Badge } from "@/components/reui/badge";
import { EmptyStatePanel, StatusAlert } from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { PlannerPlanSummary } from "@/lib/planner-api";
import { formatTimestamp, useEffectiveTimezone } from "@/lib/timezone";
import { PlannerStateBadge } from "./PlannerResultView";

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export function PlannerSavedPlans({
  plans,
  limit,
  loading,
  error,
  canManage,
  activePlanId,
  openingPlanId,
  onOpen,
  onRename,
  onDelete,
  onRetry,
  onStartNew,
}: {
  plans: PlannerPlanSummary[];
  limit: number;
  loading: boolean;
  error: string | null;
  canManage: boolean;
  activePlanId: string | null;
  openingPlanId: string | null;
  onOpen: (plan: PlannerPlanSummary) => void;
  onRename: (plan: PlannerPlanSummary) => void;
  onDelete: (plan: PlannerPlanSummary) => void;
  onRetry: () => void;
  onStartNew: () => void;
}) {
  const timezone = useEffectiveTimezone();

  if (loading && plans.length === 0) {
    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-busy="true" aria-label="Loading saved plans">
        <Skeleton className="h-36 rounded-xl" />
        <Skeleton className="h-36 rounded-xl" />
      </div>
    );
  }

  if (error && plans.length === 0) {
    return (
      <StatusAlert
        tone="danger"
        title="Saved plans could not be loaded"
        action={
          <Button type="button" size="xs" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        }
      >
        {error}
      </StatusAlert>
    );
  }

  if (plans.length === 0) {
    return (
      <EmptyStatePanel
        icon={<RiHomeGearLine />}
        title="No saved plans yet"
        description={
          canManage
            ? "Analyze your home, then save the result to come back to it later. Saved plans are re-checked whenever boards or firmware change."
            : "Plans saved by an owner or administrator of this account appear here."
        }
        action={
          <Button type="button" variant="outline" onClick={onStartNew}>
            Plan my home
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {plans.length} of {limit} saved plans. A plan is checked again when you open it, so the
        result always reflects the boards and firmware available at that moment.
      </p>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label="Saved plans">
        {plans.map((plan) => {
          const opening = openingPlanId === plan.id;
          const outdated = plan.status === "outdated" || plan.resultState === null;
          return (
            <li key={plan.id}>
              <Card
                className="h-full"
                data-testid="planner-saved-plan"
                data-plan-status={outdated ? "outdated" : "current"}
              >
                <CardContent className="flex h-full flex-col gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">
                        {plan.name}
                      </h3>
                      {outdated ? (
                        <Badge variant="secondary" size="sm" radius="full">
                          Needs re-check
                        </Badge>
                      ) : (
                        plan.resultState && <PlannerStateBadge state={plan.resultState} size="sm" />
                      )}
                      {activePlanId === plan.id && (
                        <Badge variant="primary-light" size="sm" radius="full">
                          Currently open
                        </Badge>
                      )}
                    </div>
                    {outdated ? (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        Boards or firmware have changed since this plan was last checked, so its old
                        result is no longer shown. Open it to analyze it again.
                      </p>
                    ) : (
                      <>
                        {plan.recommendation && (
                          <p className="text-sm font-medium text-foreground">{plan.recommendation}</p>
                        )}
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {plan.summary ?? plan.headline}
                        </p>
                      </>
                    )}
                  </div>

                  <p className="mt-auto text-[11px] tabular-nums text-muted-foreground">
                    {plural(plan.rooms, "room")} · {plural(plan.devices, "device")} ·{" "}
                    {plural(plan.connections, "connection")}
                    <span className="block">
                      {outdated || !plan.analyzedAt
                        ? `Saved ${formatTimestamp(plan.updatedAt, timezone)}`
                        : `Checked ${formatTimestamp(plan.analyzedAt, timezone)}`}
                    </span>
                  </p>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={openingPlanId !== null}
                      aria-label={`Open ${plan.name}`}
                      onClick={() => onOpen(plan)}
                    >
                      {opening ? (
                        <RiLoader4Line className="animate-spin" aria-hidden="true" />
                      ) : (
                        <RiFolderOpenLine aria-hidden="true" />
                      )}
                      {opening ? "Checking…" : "Open"}
                    </Button>
                    {canManage && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`Rename ${plan.name}`}
                          onClick={() => onRename(plan)}
                        >
                          <RiEdit2Line aria-hidden="true" />
                          Rename
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`Delete ${plan.name}`}
                          onClick={() => onDelete(plan)}
                        >
                          <RiDeleteBinLine aria-hidden="true" />
                          Delete
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
