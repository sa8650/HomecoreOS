import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  normalizePlannerRequirements,
  type PlannerRequirementsInput,
  type PlannerResult,
  type PlannerStage,
} from "@homecoreos/shared";
import { RiArrowLeftLine, RiRefreshLine, RiSave3Line } from "@remixicon/react";
import { toast } from "sonner";
import {
  PlannerAnalysisProgress,
  applyStageEvent,
  createPendingStages,
  failRunningStages,
} from "@/components/planner/PlannerAnalysisProgress";
import { PlannerResultView } from "@/components/planner/PlannerResultView";
import { PlannerSavedPlans } from "@/components/planner/PlannerSavedPlans";
import { PlannerWizard } from "@/components/planner/PlannerWizard";
import {
  createEmptyDraft,
  draftToRequirements,
  loadStoredDraft,
  type PlannerPlanLink,
  requirementsToDraft,
  storeDraft,
  type PlannerDraft,
} from "@/components/planner/planner-draft";
import { Frame, FramePanel } from "@/components/reui/frame";
import { ConfirmDeleteDialog, FormField, StatusAlert } from "@/components/shared/AppUi";
import { PLANNER_HERO_ICONS } from "@/components/shared/HeroDomainIcons";
import { PageHeroHeader } from "@/components/shared/PageHeroHeader";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { BoardProfileItem } from "@/features/types";
import { ApiError, cachedGet } from "@/lib/api";
import {
  analyzePlannerRequirements,
  createPlannerPlan,
  deletePlannerPlan,
  getCachedPlannerPlans,
  listPlannerPlans,
  openPlannerPlan,
  updatePlannerPlan,
  type PlannerPlanCache,
  type PlannerPlanDetail,
  type PlannerPlanSummary,
} from "@/lib/planner-api";
import { formatTimestamp, useEffectiveTimezone } from "@/lib/timezone";

const PLAN_NAME_MAX = 80;

type PlannerView = "wizard" | "analyzing" | "result";

interface AnalysisState {
  /** Changes with every result, so per-result UI state starts fresh. */
  serial: number;
  result: PlannerResult;
  /** The validated requirements the Worker computed the result from. */
  requirements: PlannerRequirementsInput;
  /** Fingerprint of the wizard answers this result belongs to. */
  draftKey: string;
}

interface PlanNote {
  title: string;
  body: string;
}

function draftKeyOf(draft: PlannerDraft): string {
  return JSON.stringify(draftToRequirements(draft));
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** Explains whether a saved plan's result was reused or computed again, and why. */
function describePlanCache(
  cache: PlannerPlanCache,
  analyzedAt: string | null,
  timezone: string
): PlanNote {
  if (cache.status === "reused") {
    return {
      title: "This result is still up to date",
      body: `It was checked on ${formatTimestamp(analyzedAt, timezone)}. Boards and firmware have not changed since then, so the stored result is shown.`,
    };
  }
  switch (cache.reason) {
    case "catalog_changed":
      return {
        title: "Checked again just now",
        body: "Boards or firmware have changed since this plan was last checked, so it was analyzed again against the current records.",
      };
    case "engine_updated":
      return {
        title: "Checked again just now",
        body: "The planner's rules were updated since this plan was last checked, so it was analyzed again.",
      };
    case "requirements_changed":
      return {
        title: "Your changes were analyzed",
        body: "The saved plan now holds your new answers and the result computed from them.",
      };
    default:
      return {
        title: "Analyzed just now",
        body: "This plan was checked against the boards and firmware available right now.",
      };
  }
}

export function SmartHomePlannerPage({
  canManage,
  onNavigate,
  accountId = "",
}: {
  canManage: boolean;
  onNavigate: (path: string) => void;
  /** Keeps the unsaved draft in this browser tab separate for each account. */
  accountId?: string;
}) {
  const timezone = useEffectiveTimezone();
  const [restored] = useState(() => loadStoredDraft(accountId));
  const [cachedPlans] = useState(() => getCachedPlannerPlans());

  const [tab, setTab] = useState("planner");
  const [view, setView] = useState<PlannerView>("wizard");
  const [draft, setDraft] = useState<PlannerDraft>(() => restored?.draft ?? createEmptyDraft());
  const [step, setStep] = useState(() => restored?.step ?? 1);

  const [stages, setStages] = useState<PlannerStage[]>(createPendingStages);
  const [analysis, setAnalysis] = useState<AnalysisState | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [activePlan, setActivePlan] = useState<PlannerPlanLink | null>(() => restored?.plan ?? null);
  const [planNote, setPlanNote] = useState<PlanNote | null>(null);

  const [plans, setPlans] = useState<PlannerPlanSummary[]>(() => cachedPlans?.plans ?? []);
  const [planLimit, setPlanLimit] = useState(() => cachedPlans?.limit ?? 30);
  const [plansLoading, setPlansLoading] = useState(!cachedPlans);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [boards, setBoards] = useState<Map<string, BoardProfileItem>>(() => new Map());

  const [openingPlanId, setOpeningPlanId] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState<PlannerPlanSummary | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const [renameTarget, setRenameTarget] = useState<PlannerPlanSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PlannerPlanSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  /** Identifies the newest analysis so a slower, older response is ignored. */
  const analysisRun = useRef(0);
  /** The same for the saved-plan list. */
  const plansRequest = useRef(0);
  /** Always the saved plan the answers belong to right now, also inside pending requests. */
  const activePlanRef = useRef(activePlan);
  const analysisAbort = useRef<AbortController | null>(null);
  const resultSerial = useRef(0);
  const boardsRefetched = useRef<PlannerResult | null>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const lastPosition = useRef({ step, view });

  const requirements = useMemo(() => draftToRequirements(draft), [draft]);
  const normalized = useMemo(() => normalizePlannerRequirements(requirements), [requirements]);
  const draftKey = useMemo(() => JSON.stringify(requirements), [requirements]);

  const resultIsCurrent = analysis !== null && analysis.draftKey === draftKey;
  const hasUnsavedPlanChanges =
    activePlan !== null && analysis !== null && analysis.draftKey !== activePlan.savedKey;
  const planLimitReached = plans.length >= planLimit;

  // --- data loading ---------------------------------------------------------

  const linkPlan = useCallback((plan: PlannerPlanLink | null) => {
    activePlanRef.current = plan;
    setActivePlan(plan);
  }, []);

  const loadPlans = useCallback(
    async (force = false) => {
      plansRequest.current += 1;
      const request = plansRequest.current;
      try {
        const res = await listPlannerPlans({ force });
        if (plansRequest.current !== request) return;
        setPlans(res.plans);
        setPlanLimit(res.limit);
        setPlansError(null);

        // The open plan can be renamed or deleted in another tab or by another
        // member. Only a list fetched just now is trusted to say it is gone.
        const open = activePlanRef.current;
        const listed = open ? res.plans.find((plan) => plan.id === open.id) : undefined;
        if (open && listed && listed.name !== open.name) {
          linkPlan({ ...open, name: listed.name });
        } else if (open && !listed && force) {
          linkPlan(null);
          toast.error(
            `"${open.name}" has been deleted. Your answers are still here and can be saved as a new plan.`
          );
        }
      } catch (error) {
        if (plansRequest.current !== request) return;
        setPlansError(errorMessage(error, "Saved plans could not be loaded."));
      } finally {
        if (plansRequest.current === request) setPlansLoading(false);
      }
    },
    [linkPlan]
  );

  const loadBoards = useCallback(async (force = false) => {
    // Only used to draw the boards. A failure here never affects the analysis.
    const results = await Promise.allSettled([
      cachedGet<{ boards?: BoardProfileItem[] }>("/api/boards/catalog", { ttlMs: 60_000, force }),
      cachedGet<{ boards?: BoardProfileItem[] }>("/api/boards/custom", { ttlMs: 60_000, force }),
    ]);
    const next = new Map<string, BoardProfileItem>();
    for (const outcome of results) {
      if (outcome.status !== "fulfilled") continue;
      for (const board of outcome.value.boards ?? []) next.set(board.id, board);
    }
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Answers restored together with a saved plan: ask the Worker, not the
    // cache, whether that plan still exists.
    void loadPlans(activePlanRef.current !== null);
    void loadBoards().then((next) => {
      if (!cancelled) setBoards(next);
    });
    return () => {
      cancelled = true;
    };
  }, [loadPlans, loadBoards]);

  // A result can name a board that was published after this page loaded.
  useEffect(() => {
    const result = analysis?.result;
    if (!result || boardsRefetched.current === result) return;
    const missing = result.plans.some(
      (plan) => plan.detailLevel === "full" && !boards.has(plan.board.id)
    );
    if (!missing) return;
    boardsRefetched.current = result;
    let cancelled = false;
    void loadBoards(true).then((next) => {
      if (!cancelled) setBoards(next);
    });
    return () => {
      cancelled = true;
    };
  }, [analysis, boards, loadBoards]);

  useEffect(() => {
    const abort = analysisAbort;
    const run = analysisRun;
    const plansRun = plansRequest;
    return () => {
      run.current += 1;
      plansRun.current += 1;
      abort.current?.abort();
    };
  }, []);

  // Keep the answers, and the saved plan they belong to, if the customer leaves
  // the page and comes back.
  useEffect(() => {
    storeDraft(accountId, draft, step, activePlan);
  }, [accountId, draft, step, activePlan]);

  // Bring the top of the planner into view when the step or the view changes.
  useEffect(() => {
    const last = lastPosition.current;
    if (last.step === step && last.view === view) return;
    lastPosition.current = { step, view };
    const node = topRef.current;
    if (!node) return;
    if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "start" });
    if (view === "result") node.focus({ preventScroll: true });
  }, [step, view]);

  // --- wizard ---------------------------------------------------------------

  const updateDraft = useCallback((update: (current: PlannerDraft) => PlannerDraft) => {
    setDraft(update);
  }, []);

  const cancelAnalysis = useCallback(() => {
    analysisRun.current += 1;
    analysisAbort.current?.abort();
    analysisAbort.current = null;
  }, []);

  const editStep = useCallback(
    (nextStep: number) => {
      cancelAnalysis();
      setStep(Math.max(1, Math.min(4, nextStep)));
      setView("wizard");
    },
    [cancelAnalysis]
  );

  const runAnalysis = useCallback(async () => {
    cancelAnalysis();
    const run = analysisRun.current;
    const controller = new AbortController();
    analysisAbort.current = controller;
    const key = draftKey;

    setView("analyzing");
    setAnalysisError(null);
    setPlanNote(null);
    setStages(createPendingStages());

    try {
      const outcome = await analyzePlannerRequirements(requirements, {
        signal: controller.signal,
        onStage: (event) => {
          if (analysisRun.current === run) setStages((current) => applyStageEvent(current, event));
        },
      });
      if (analysisRun.current !== run) return;
      setStages(outcome.result.stages);
      resultSerial.current += 1;
      setAnalysis({
        serial: resultSerial.current,
        result: outcome.result,
        requirements: outcome.requirements,
        draftKey: key,
      });
      setView("result");
    } catch (error) {
      if (analysisRun.current !== run || controller.signal.aborted) return;
      setStages((current) => failRunningStages(current));
      setAnalysisError(
        errorMessage(
          error,
          "The analysis could not be completed. Check your connection and try again."
        )
      );
    }
  }, [cancelAnalysis, draftKey, requirements]);

  const resetPlanner = useCallback(() => {
    cancelAnalysis();
    setDraft(createEmptyDraft());
    setStep(1);
    setAnalysis(null);
    setAnalysisError(null);
    linkPlan(null);
    setPlanNote(null);
    setStages(createPendingStages());
    setView("wizard");
    setTab("planner");
    setResetOpen(false);
  }, [cancelAnalysis, linkPlan]);

  // --- saved plans ----------------------------------------------------------

  const showPlan = useCallback(
    (plan: PlannerPlanDetail) => {
      cancelAnalysis();
      const nextDraft = requirementsToDraft(plan.requirements);
      const key = draftKeyOf(nextDraft);
      setDraft(nextDraft);
      setStep(4);
      resultSerial.current += 1;
      setAnalysis({
        serial: resultSerial.current,
        result: plan.result,
        requirements: plan.requirements,
        draftKey: key,
      });
      setStages(plan.result.stages);
      setAnalysisError(null);
      linkPlan({ id: plan.id, name: plan.name, savedKey: key });
      setPlanNote(describePlanCache(plan.cache, plan.analyzedAt, timezone));
      setView("result");
      setTab("planner");
    },
    [cancelAnalysis, linkPlan, timezone]
  );

  const openPlan = useCallback(
    async (plan: PlannerPlanSummary) => {
      setPendingOpen(null);
      setOpeningPlanId(plan.id);
      try {
        const res = await openPlannerPlan(plan.id);
        showPlan(res.plan);
        // Opening re-checks the plan, so its status in the list may have changed.
        void loadPlans(true);
      } catch (error) {
        toast.error(errorMessage(error, "This plan could not be opened."));
        if (error instanceof ApiError && error.status === 404) void loadPlans(true);
      } finally {
        setOpeningPlanId(null);
      }
    },
    [loadPlans, showPlan]
  );

  const requestOpenPlan = (plan: PlannerPlanSummary) => {
    const hasUnsavedAnswers =
      draft.rooms.length > 0 && (activePlan === null || draftKey !== activePlan.savedKey);
    if (hasUnsavedAnswers) {
      setPendingOpen(plan);
      return;
    }
    void openPlan(plan);
  };

  const saveAsNewPlan = async (event: FormEvent) => {
    event.preventDefault();
    const name = saveName.trim();
    if (!analysis || !name || saving) return;
    setSaving(true);
    try {
      const res = await createPlannerPlan(name, analysis.requirements);
      showPlan(res.plan);
      setPlanNote(null);
      setSaveDialogOpen(false);
      toast.success(`Saved "${res.plan.name}".`);
      await loadPlans(true);
    } catch (error) {
      toast.error(errorMessage(error, "The plan could not be saved."));
    } finally {
      setSaving(false);
    }
  };

  const savePlanChanges = async () => {
    if (!analysis || !activePlan || saving) return;
    setSaving(true);
    try {
      const res = await updatePlannerPlan(activePlan.id, { requirements: analysis.requirements });
      showPlan(res.plan);
      setPlanNote(null);
      toast.success(`Saved changes to "${res.plan.name}".`);
      await loadPlans(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // Deleted in another tab or by another member. The answers and the
        // result stay on screen and can be saved as a new plan.
        linkPlan(null);
        toast.error(
          `"${activePlan.name}" no longer exists. Save your answers as a new plan to keep them.`
        );
        void loadPlans(true);
      } else {
        toast.error(errorMessage(error, "Your changes could not be saved."));
      }
    } finally {
      setSaving(false);
    }
  };

  const renamePlan = async (event: FormEvent) => {
    event.preventDefault();
    const name = renameValue.trim();
    if (!renameTarget || !name || renaming) return;
    setRenaming(true);
    try {
      const res = await updatePlannerPlan(renameTarget.id, { name });
      const open = activePlanRef.current;
      if (open && open.id === res.plan.id) linkPlan({ ...open, name: res.plan.name });
      setRenameTarget(null);
      toast.success(`Renamed to "${res.plan.name}".`);
      await loadPlans(true);
    } catch (error) {
      toast.error(errorMessage(error, "The plan could not be renamed."));
    } finally {
      setRenaming(false);
    }
  };

  const deletePlan = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await deletePlannerPlan(deleteTarget.id);
      if (activePlanRef.current?.id === deleteTarget.id) linkPlan(null);
      toast.success(`Deleted "${deleteTarget.name}".`);
      setDeleteTarget(null);
      await loadPlans(true);
    } catch (error) {
      toast.error(errorMessage(error, "The plan could not be deleted."));
      if (error instanceof ApiError && error.status === 404) {
        setDeleteTarget(null);
        void loadPlans(true);
      }
    } finally {
      setDeleting(false);
    }
  };

  const openSaveDialog = () => {
    setSaveName(activePlan ? `${activePlan.name} (copy)`.slice(0, PLAN_NAME_MAX) : "My home");
    setSaveDialogOpen(true);
  };

  // --- render ---------------------------------------------------------------

  return (
    <div className="space-y-6">
      <PageHeroHeader
        tone="indigo"
        ariaLabel="Smart Home Planner Header"
        title="Smart Home Planner"
        subtitle={
          <>
            Tell us about your home and what you want to control.{" "}
            <br className="hidden sm:inline" />
            The planner checks it against the{" "}
            <span className="font-medium text-foreground/85">boards and firmware</span> HomecoreOS
            offers right now and shows the{" "}
            <span className="font-semibold text-indigo-600 dark:text-indigo-400">
              hardware that fits
            </span>
            .
          </>
        }
        leftIcons={PLANNER_HERO_ICONS.left}
        rightIcons={PLANNER_HERO_ICONS.right}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="planner">Plan my home</TabsTrigger>
          <TabsTrigger value="saved">Saved plans ({plans.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="planner" className="pt-2">
          {/* The scroll margin keeps the first row clear of the app's floating top bar. */}
          <div ref={topRef} tabIndex={-1} className="scroll-mt-16 space-y-4 outline-none">
            {view === "wizard" && (
              <>
                {analysis &&
                  (resultIsCurrent ? (
                    <StatusAlert
                      tone="info"
                      title="You already have a result for these answers"
                      action={
                        <Button type="button" size="xs" variant="outline" onClick={() => setView("result")}>
                          View result
                        </Button>
                      }
                    >
                      Nothing has changed since the last analysis.
                    </StatusAlert>
                  ) : (
                    <StatusAlert tone="warning" title="Your answers have changed">
                      The last result no longer matches them. Analyze again on the Review step to see
                      what fits now.
                    </StatusAlert>
                  ))}
                {activePlan && (
                  <p className="text-xs text-muted-foreground" data-testid="planner-editing-plan">
                    {draftKey === activePlan.savedKey
                      ? `These are the answers of the saved plan "${activePlan.name}".`
                      : canManage
                        ? `These answers differ from the saved plan "${activePlan.name}". Analyze again to save the changes.`
                        : `These answers differ from the saved plan "${activePlan.name}".`}
                  </p>
                )}
                <PlannerWizard
                  draft={draft}
                  normalized={normalized}
                  step={step}
                  onStepChange={(next) => setStep(Math.max(1, Math.min(4, next)))}
                  onUpdate={updateDraft}
                  onAnalyze={() => void runAnalysis()}
                  onReset={() => setResetOpen(true)}
                />
              </>
            )}

            {view === "analyzing" && (
              <Frame spacing="sm">
                <FramePanel className="min-w-0 space-y-4">
                  <div className="space-y-1">
                    <h2 className="text-lg font-bold tracking-tight text-foreground">
                      {analysisError ? "The analysis did not finish" : "Analyzing your home"}
                    </h2>
                    <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
                      Your requirements are being checked against the boards and firmware releases
                      on record. Each step below updates when the planner really starts or finishes
                      it.
                    </p>
                  </div>
                  <PlannerAnalysisProgress stages={stages} live={!analysisError} />
                  {analysisError && (
                    <StatusAlert
                      tone="danger"
                      title="The analysis could not be completed"
                      action={
                        <Button type="button" size="xs" variant="outline" onClick={() => void runAnalysis()}>
                          Try again
                        </Button>
                      }
                    >
                      {analysisError}
                    </StatusAlert>
                  )}
                  <div className="border-t pt-3">
                    <Button type="button" variant="outline" size="sm" onClick={() => editStep(step)}>
                      <RiArrowLeftLine aria-hidden="true" />
                      Back to my answers
                    </Button>
                  </div>
                </FramePanel>
              </Frame>
            )}

            {view === "result" && analysis && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => editStep(4)}>
                      <RiArrowLeftLine aria-hidden="true" />
                      Change my answers
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => void runAnalysis()}>
                      <RiRefreshLine aria-hidden="true" />
                      Analyze again
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setResetOpen(true)}>
                      Start a new plan
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {activePlan && (
                      <span className="text-xs text-muted-foreground" data-testid="planner-save-status">
                        {hasUnsavedPlanChanges
                          ? `Changes to "${activePlan.name}" are not saved`
                          : `Saved as "${activePlan.name}"`}
                      </span>
                    )}
                    {canManage ? (
                      <>
                        {activePlan && hasUnsavedPlanChanges && (
                          <Button type="button" size="sm" disabled={saving} onClick={() => void savePlanChanges()}>
                            <RiSave3Line aria-hidden="true" />
                            {saving ? "Saving…" : "Save changes"}
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant={activePlan ? "outline" : "default"}
                          disabled={saving || planLimitReached}
                          title={
                            planLimitReached
                              ? `You have reached the limit of ${planLimit} saved plans. Delete one to save another.`
                              : undefined
                          }
                          onClick={openSaveDialog}
                        >
                          {!activePlan && <RiSave3Line aria-hidden="true" />}
                          {activePlan ? "Save as new plan" : "Save plan"}
                        </Button>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Only owners and administrators can save plans.
                      </span>
                    )}
                  </div>
                </div>

                {canManage && planLimitReached && !activePlan && (
                  <p className="text-xs text-muted-foreground">
                    You have reached the limit of {planLimit} saved plans. Delete one under Saved plans
                    to save this result.
                  </p>
                )}

                {planNote && (
                  <StatusAlert tone="info" title={planNote.title}>
                    {planNote.body}
                  </StatusAlert>
                )}

                <PlannerResultView
                  key={analysis.serial}
                  result={analysis.result}
                  boards={boards}
                  onEditStep={editStep}
                  onNavigate={onNavigate}
                />
              </>
            )}
          </div>
        </TabsContent>

        <TabsContent value="saved" className="pt-2">
          <PlannerSavedPlans
            plans={plans}
            limit={planLimit}
            loading={plansLoading}
            error={plansError}
            canManage={canManage}
            activePlanId={activePlan?.id ?? null}
            openingPlanId={openingPlanId}
            onOpen={requestOpenPlan}
            onRename={(plan) => {
              setRenameValue(plan.name);
              setRenameTarget(plan);
            }}
            onDelete={setDeleteTarget}
            onRetry={() => {
              setPlansLoading(true);
              void loadPlans(true);
            }}
            onStartNew={() => setTab("planner")}
          />
        </TabsContent>
      </Tabs>

      <Dialog open={saveDialogOpen} onOpenChange={(open) => !saving && setSaveDialogOpen(open)}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={(event) => void saveAsNewPlan(event)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Save this plan</DialogTitle>
              <DialogDescription>
                Your answers are stored with the result. Each time you open the plan it is checked
                again if boards or firmware have changed.
              </DialogDescription>
            </DialogHeader>
            <FormField id="planner-plan-name" label="Plan name">
              <Input
                id="planner-plan-name"
                value={saveName}
                maxLength={PLAN_NAME_MAX}
                autoFocus
                onChange={(event) => setSaveName(event.target.value)}
              />
            </FormField>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => setSaveDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving || saveName.trim().length === 0}>
                {saving ? "Saving…" : "Save plan"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open && !renaming) setRenameTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={(event) => void renamePlan(event)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Rename plan</DialogTitle>
              <DialogDescription>Only the name changes. The plan itself is untouched.</DialogDescription>
            </DialogHeader>
            <FormField id="planner-rename" label="Plan name">
              <Input
                id="planner-rename"
                value={renameValue}
                maxLength={PLAN_NAME_MAX}
                autoFocus
                onChange={(event) => setRenameValue(event.target.value)}
              />
            </FormField>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={renaming}
                onClick={() => setRenameTarget(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={renaming || renameValue.trim().length === 0}>
                {renaming ? "Saving…" : "Rename"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
        title={`Delete "${deleteTarget?.name ?? "this plan"}"?`}
        description="The saved answers and result are removed. This cannot be undone."
        confirmLabel="Delete plan"
        busy={deleting}
        onConfirm={deletePlan}
      />

      <ConfirmDeleteDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Start a new plan?"
        description="Your current answers are cleared. Saved plans are not affected."
        confirmLabel="Start over"
        onConfirm={resetPlanner}
      />

      <ConfirmDeleteDialog
        open={pendingOpen !== null}
        onOpenChange={(open) => {
          if (!open) setPendingOpen(null);
        }}
        title={`Open "${pendingOpen?.name ?? "this plan"}"?`}
        description="The answers you are working on have not been saved and will be replaced by this plan."
        confirmLabel="Open plan"
        onConfirm={() => {
          if (pendingOpen) void openPlan(pendingOpen);
        }}
      />
    </div>
  );
}
