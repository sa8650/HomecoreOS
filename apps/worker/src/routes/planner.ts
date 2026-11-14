/**
 * Smart Home Planner API (customer console).
 *
 *   POST   /api/planner/analyze      analyze requirements against the live catalog
 *   GET    /api/planner/plans        list the account's saved plans
 *   POST   /api/planner/plans        save a plan (always analyzed server-side)
 *   GET    /api/planner/plans/:id    open a saved plan
 *   PATCH  /api/planner/plans/:id    rename a plan or change its requirements
 *   DELETE /api/planner/plans/:id    delete a plan
 *
 * Every recommendation is produced by the deterministic rule engine in
 * @homecoreos/shared from the boards and firmware releases administrators
 * manage. The client never supplies a result: what is stored and returned is
 * always computed here.
 *
 * Saved results are reused only while the board and firmware records they were
 * computed from are unchanged. That is decided by comparing a fingerprint of
 * the live records with the one stored next to the result, so any admin change
 * (publish, unpublish, verify, deprecate, upload, pin-map edit, limit change)
 * invalidates the stored result without the admin code knowing about the planner.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  PLANNER_ENGINE_VERSION,
  PlannerStageTracker,
  buildIncompletePlannerResult,
  describePlannerRequirements,
  evaluatePlannerCatalog,
  normalizePlannerRequirements,
  toPlannerRequirementsInput,
  type PlannerRequirementsInput,
  type PlannerResult,
  type PlannerResultState,
  type PlannerStageEvent,
} from "@homecoreos/shared";
import { recordActivity } from "../lib/audit";
import type { DbClient } from "../lib/db";
import { PlannerCatalogError, loadPlannerCatalog } from "../lib/planner-catalog";
import { requireStaffRole, requireUserSession } from "../middleware/auth";
import type { AppEnv } from "../types/context";

/** Requirements are small; anything larger than this is not a planner request. */
const MAX_BODY_CHARS = 200_000;
export const MAX_SAVED_PLANS_PER_ACCOUNT = 30;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESULT_STATES: readonly PlannerResultState[] = [
  "ready",
  "partially_ready",
  "not_supported",
  "incomplete",
];

const SUMMARY_COLUMNS =
  "id,name,result_state,result_summary,catalog_revision,engine_version,analyzed_at,created_at,updated_at";
const DETAIL_COLUMNS = `${SUMMARY_COLUMNS},requirements,result`;

// The rule engine validates and clamps every field itself, so the HTTP layer
// only insists on the outer shape.
const requirementsSchema = z.record(z.unknown());
const planNameSchema = z.string().trim().min(1).max(80);

const analyzeSchema = z.object({ requirements: requirementsSchema });
const createPlanSchema = z.object({ name: planNameSchema, requirements: requirementsSchema });
const updatePlanSchema = z
  .object({ name: planNameSchema.optional(), requirements: requirementsSchema.optional() })
  .refine((value) => value.name !== undefined || value.requirements !== undefined);

type CacheReason = "first_analysis" | "catalog_changed" | "engine_updated" | "requirements_changed";

interface PlanCacheInfo {
  /** "reused": the stored result was returned. "recomputed": it was analyzed just now. */
  status: "reused" | "recomputed";
  reason: CacheReason | null;
}

interface PlanListingSummary {
  headline: string;
  summary: string;
  recommendation: string | null;
  rooms: number;
  devices: number;
  connections: number;
}

interface PlanRow {
  id: string;
  name: string;
  result_state: string | null;
  result_summary: Partial<PlanListingSummary> | null;
  catalog_revision: string | null;
  engine_version: number | null;
  analyzed_at: string | null;
  created_at: string;
  updated_at: string;
  requirements?: PlannerRequirementsInput | null;
  result?: PlannerResult | null;
}

interface Analysis {
  result: PlannerResult;
  /** Canonical form of what was analyzed; this is what gets stored. */
  requirements: PlannerRequirementsInput;
}

async function readJsonBody(
  c: Context<AppEnv>
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string }> {
  const tooLarge = {
    ok: false as const,
    status: 413 as const,
    error: "This plan is too large to analyze. Split it into smaller plans.",
  };
  if (Number(c.req.header("content-length") ?? "0") > MAX_BODY_CHARS) return tooLarge;
  const raw = await c.req.text();
  if (raw.length > MAX_BODY_CHARS) return tooLarge;
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400, error: "Request body must be valid JSON." };
  }
}

/** Only messages written for customers leave the Worker; everything else is logged. */
function publicErrorMessage(error: unknown): string {
  if (error instanceof PlannerCatalogError) return error.message;
  console.error("Smart Home Planner analysis failed:", error);
  return "The analysis could not be completed. Please try again.";
}

async function analyzeRequirements(
  db: DbClient,
  accountId: string,
  raw: unknown,
  onStage?: (event: PlannerStageEvent) => void
): Promise<Analysis> {
  const tracker = new PlannerStageTracker(onStage);
  const normalized = tracker.run(
    "requirements",
    () => normalizePlannerRequirements(raw),
    describePlannerRequirements
  );
  const requirements = toPlannerRequirementsInput(normalized, raw);

  // Missing answers are reported straight away; the catalog is not even read.
  if (!normalized.complete) {
    return { result: buildIncompletePlannerResult(normalized, { tracker }), requirements };
  }
  const catalog = await loadPlannerCatalog(db, accountId, tracker);
  return { result: evaluatePlannerCatalog(normalized, catalog, { tracker }), requirements };
}

function summarizeForListing(result: PlannerResult): PlanListingSummary {
  const best = result.plans[0];
  const recommended = result.state === "ready" || result.state === "partially_ready";
  return {
    headline: result.headline,
    summary: result.summary,
    recommendation:
      best && recommended
        ? `${best.controllerCount} × ${best.board.manufacturer} ${best.board.model}`.trim()
        : null,
    rooms: result.requirements.totals.rooms,
    devices: result.requirements.totals.physicalDevices,
    connections: result.requirements.totals.gpioChannels,
  };
}

function resultColumns(analysis: Analysis) {
  return {
    requirements: analysis.requirements,
    result: analysis.result,
    result_state: analysis.result.state,
    result_summary: summarizeForListing(analysis.result),
    catalog_revision: analysis.result.catalogRevision,
    engine_version: PLANNER_ENGINE_VERSION,
    analyzed_at: new Date().toISOString(),
  };
}

function storedState(row: PlanRow): PlannerResultState | null {
  return RESULT_STATES.find((state) => state === row.result_state) ?? null;
}

/**
 * Why a stored result may not be reused, or null when it is still valid for the
 * given fingerprint of the live board and firmware records.
 */
function staleReason(row: PlanRow, currentRevision: string | null): CacheReason | null {
  const state = storedState(row);
  if (!state) return "first_analysis";
  if (row.engine_version !== PLANNER_ENGINE_VERSION) return "engine_updated";
  // An "incomplete" result never read the catalog, so the catalog cannot outdate it.
  if (state === "incomplete") return null;
  return row.catalog_revision && row.catalog_revision === currentRevision ? null : "catalog_changed";
}

/** True when deciding staleness needs the live catalog fingerprint. */
function needsCatalogToValidate(row: PlanRow): boolean {
  const state = storedState(row);
  return state !== null && state !== "incomplete" && row.engine_version === PLANNER_ENGINE_VERSION;
}

function toPlanSummary(row: PlanRow, current: boolean) {
  const summary = row.result_summary ?? {};
  return {
    id: row.id,
    name: row.name,
    // An outdated plan never reports its old readiness: it is re-analyzed when opened.
    status: current ? ("current" as const) : ("outdated" as const),
    resultState: current ? storedState(row) : null,
    headline: current ? (summary.headline ?? null) : null,
    summary: current ? (summary.summary ?? null) : null,
    recommendation: current ? (summary.recommendation ?? null) : null,
    rooms: summary.rooms ?? 0,
    devices: summary.devices ?? 0,
    connections: summary.connections ?? 0,
    analyzedAt: row.analyzed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPlanDetail(row: PlanRow, analysis: Analysis, cache: PlanCacheInfo) {
  return {
    ...toPlanSummary(row, true),
    requirements: analysis.requirements,
    result: analysis.result,
    cache,
  };
}

async function findPlan(
  db: DbClient,
  accountId: string,
  planId: string,
  columns: string
): Promise<PlanRow | null> {
  if (!UUID_PATTERN.test(planId)) return null;
  const { data } = await db
    .from("planner_plans")
    .select(columns)
    .eq("id", planId)
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as PlanRow | null) ?? null;
}

async function storeAnalysis(
  db: DbClient,
  accountId: string,
  planId: string,
  analysis: Analysis,
  extra?: { name?: string }
): Promise<PlanRow | null> {
  const { data, error } = await db
    .from("planner_plans")
    .update({ ...resultColumns(analysis), ...(extra?.name ? { name: extra.name } : {}) })
    .eq("id", planId)
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .select(SUMMARY_COLUMNS)
    .maybeSingle();
  if (error) console.error("Smart Home Planner: storing a plan result failed:", error.message);
  return (data as PlanRow | null) ?? null;
}

/**
 * Returns the stored result when it is still valid, otherwise analyzes the
 * stored requirements again and saves the fresh result.
 */
async function resolvePlanResult(
  db: DbClient,
  accountId: string,
  row: PlanRow
): Promise<{ row: PlanRow; analysis: Analysis; cache: PlanCacheInfo }> {
  const stored = row.result ?? null;
  const requirements = (row.requirements ?? {}) as PlannerRequirementsInput;

  if (stored && !needsCatalogToValidate(row) && staleReason(row, null) === null) {
    return { row, analysis: { result: stored, requirements }, cache: { status: "reused", reason: null } };
  }

  const tracker = new PlannerStageTracker();
  const normalized = tracker.run(
    "requirements",
    () => normalizePlannerRequirements(requirements),
    describePlannerRequirements
  );

  let result: PlannerResult;
  let reason: CacheReason;
  if (!normalized.complete) {
    reason = staleReason(row, null) ?? "engine_updated";
    result = buildIncompletePlannerResult(normalized, { tracker });
  } else {
    const catalog = await loadPlannerCatalog(db, accountId, tracker);
    const stale = stored ? staleReason(row, catalog.revision) : "first_analysis";
    if (stored && stale === null) {
      return { row, analysis: { result: stored, requirements }, cache: { status: "reused", reason: null } };
    }
    reason = stale ?? "first_analysis";
    result = evaluatePlannerCatalog(normalized, catalog, { tracker });
  }

  const analysis: Analysis = { result, requirements: toPlannerRequirementsInput(normalized, requirements) };
  const updated = await storeAnalysis(db, accountId, row.id, analysis);
  return {
    row: updated ?? { ...row, ...resultColumns(analysis) },
    analysis,
    cache: { status: "recomputed", reason },
  };
}

function ndjsonStream(run: (send: (event: unknown) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        await run(send);
      } catch (error) {
        send({ type: "error", error: publicErrorMessage(error) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function createPlannerRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", requireUserSession());

  // Analysis reads the catalog and writes nothing, so any signed-in member may run it.
  app.post("/analyze", async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok) return c.json({ error: body.error }, body.status);
    const parsed = analyzeSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json({ error: "Planner requirements are missing or malformed." }, 400);
    }

    const auth = c.get("userAuth")!;
    const db = c.get("db");

    // Streaming clients receive each stage the moment it really starts or
    // finishes, followed by the result. Other clients get one JSON document.
    if ((c.req.header("accept") ?? "").includes("application/x-ndjson")) {
      return ndjsonStream(async (send) => {
        const analysis = await analyzeRequirements(
          db,
          auth.accountId,
          parsed.data.requirements,
          (stage) => send({ type: "stage", stage })
        );
        send({ type: "result", result: analysis.result, requirements: analysis.requirements });
      });
    }

    try {
      const analysis = await analyzeRequirements(db, auth.accountId, parsed.data.requirements);
      c.header("Cache-Control", "no-store");
      return c.json({ result: analysis.result, requirements: analysis.requirements });
    } catch (error) {
      return c.json({ error: publicErrorMessage(error) }, 503);
    }
  });

  app.get("/plans", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");

    const { data, error } = await db
      .from("planner_plans")
      .select(SUMMARY_COLUMNS)
      .eq("account_id", auth.accountId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(MAX_SAVED_PLANS_PER_ACCOUNT);
    if (error) return c.json({ error: "Saved plans could not be loaded." }, 503);

    const planRows = (data ?? []) as unknown as PlanRow[];

    // The fingerprint of the live catalog is only needed when a stored result
    // depends on it.
    let currentRevision: string | null = null;
    if (planRows.some(needsCatalogToValidate)) {
      try {
        currentRevision = (await loadPlannerCatalog(db, auth.accountId)).revision;
      } catch (loadError) {
        return c.json({ error: publicErrorMessage(loadError) }, 503);
      }
    }

    c.header("Cache-Control", "no-store");
    return c.json({
      plans: planRows.map((row) => toPlanSummary(row, staleReason(row, currentRevision) === null)),
      limit: MAX_SAVED_PLANS_PER_ACCOUNT,
    });
  });

  app.post("/plans", requireStaffRole("owner", "administrator"), async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok) return c.json({ error: body.error }, body.status);
    const parsed = createPlanSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json({ error: "A plan needs a name (up to 80 characters) and its requirements." }, 400);
    }

    const auth = c.get("userAuth")!;
    const db = c.get("db");

    const { count, error: countError } = await db
      .from("planner_plans")
      .select("id", { count: "exact", head: true })
      .eq("account_id", auth.accountId)
      .is("deleted_at", null);
    if (countError) return c.json({ error: "Saved plans could not be loaded." }, 503);
    if ((count ?? 0) >= MAX_SAVED_PLANS_PER_ACCOUNT) {
      return c.json(
        {
          error: `You can keep up to ${MAX_SAVED_PLANS_PER_ACCOUNT} saved plans. Delete one you no longer need first.`,
          code: "PLAN_LIMIT_REACHED",
        },
        409
      );
    }

    let analysis: Analysis;
    try {
      analysis = await analyzeRequirements(db, auth.accountId, parsed.data.requirements);
    } catch (error) {
      return c.json({ error: publicErrorMessage(error) }, 503);
    }

    const { data: created, error } = await db
      .from("planner_plans")
      .insert({
        account_id: auth.accountId,
        created_by: auth.userId,
        name: parsed.data.name,
        ...resultColumns(analysis),
      })
      .select(SUMMARY_COLUMNS)
      .single();
    if (error || !created) return c.json({ error: "The plan could not be saved." }, 500);

    const row = created as unknown as PlanRow;
    await recordActivity(db, {
      accountId: auth.accountId,
      actorUserId: auth.userId,
      category: "account",
      action: "planner.plan_saved",
      summary: `Saved Smart Home Planner plan "${row.name}".`,
      metadata: { planId: row.id, resultState: analysis.result.state },
    });

    return c.json(
      { plan: toPlanDetail(row, analysis, { status: "recomputed", reason: "first_analysis" }) },
      201
    );
  });

  app.get("/plans/:id", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const row = await findPlan(db, auth.accountId, c.req.param("id"), DETAIL_COLUMNS);
    if (!row) return c.json({ error: "Plan not found in your account." }, 404);

    try {
      const resolved = await resolvePlanResult(db, auth.accountId, row);
      c.header("Cache-Control", "no-store");
      return c.json({ plan: toPlanDetail(resolved.row, resolved.analysis, resolved.cache) });
    } catch (error) {
      return c.json({ error: publicErrorMessage(error) }, 503);
    }
  });

  app.patch("/plans/:id", requireStaffRole("owner", "administrator"), async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok) return c.json({ error: body.error }, body.status);
    const parsed = updatePlanSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json({ error: "Provide a new name, new requirements, or both." }, 400);
    }

    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const row = await findPlan(db, auth.accountId, c.req.param("id"), DETAIL_COLUMNS);
    if (!row) return c.json({ error: "Plan not found in your account." }, 404);

    try {
      if (parsed.data.requirements !== undefined) {
        const analysis = await analyzeRequirements(db, auth.accountId, parsed.data.requirements);
        const updated = await storeAnalysis(db, auth.accountId, row.id, analysis, {
          name: parsed.data.name,
        });
        if (!updated) return c.json({ error: "The plan could not be saved." }, 500);
        return c.json({
          plan: toPlanDetail(updated, analysis, { status: "recomputed", reason: "requirements_changed" }),
        });
      }

      const { data: renamed, error } = await db
        .from("planner_plans")
        .update({ name: parsed.data.name })
        .eq("id", row.id)
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .select(DETAIL_COLUMNS)
        .maybeSingle();
      if (error || !renamed) return c.json({ error: "The plan could not be saved." }, 500);

      const resolved = await resolvePlanResult(db, auth.accountId, renamed as unknown as PlanRow);
      return c.json({ plan: toPlanDetail(resolved.row, resolved.analysis, resolved.cache) });
    } catch (error) {
      return c.json({ error: publicErrorMessage(error) }, 503);
    }
  });

  app.delete("/plans/:id", requireStaffRole("owner", "administrator"), async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const row = await findPlan(db, auth.accountId, c.req.param("id"), "id,name");
    if (!row) return c.json({ error: "Plan not found in your account." }, 404);

    // Asking for the row back confirms that this request is the one that removed it.
    const { data: removed, error } = await db
      .from("planner_plans")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("account_id", auth.accountId)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (error) return c.json({ error: "The plan could not be deleted." }, 500);
    if (!removed) return c.json({ error: "Plan not found in your account." }, 404);

    await recordActivity(db, {
      accountId: auth.accountId,
      actorUserId: auth.userId,
      category: "account",
      action: "planner.plan_deleted",
      summary: `Deleted Smart Home Planner plan "${row.name}".`,
      metadata: { planId: row.id },
    });
    return c.json({ ok: true });
  });

  return app;
}
