import { Hono } from "hono";
import { z } from "zod";
import {
  ACTION_BUTTON_CATEGORIES,
  ACTION_BUTTON_COLORS,
  ACTION_BUTTON_COOLDOWN_MS,
  ACTION_BUTTON_ICONS,
  ACTION_BUTTON_MAX_STEPS,
  ACTION_BUTTON_MAX_DELAY_MS,
  ACTION_BUTTON_GESTURES,
  collectActionButtonReferences,
  validateActionButtonGestures,
  type ActionButtonGesture,
  type ActionButtonGestures,
  type ActionButtonStep,
} from "@homecoreos/shared";
import {
  aggregateTargetStates,
  executeActionButtonSteps,
  loadControllableInventory,
  resolveControllableTargets,
} from "../lib/action-button-executor";
import { requireStaffRole, requireUserSession } from "../middleware/auth";
import type { AppEnv } from "../types/context";

const opSchema = z.enum(["on", "off", "toggle"]);
const bulkTargetSchema = z.enum(["switches", "devices", "all"]);

const stepSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1).max(80),
    kind: z.literal("switch"),
    switchId: z.string().uuid(),
    op: opSchema,
  }),
  z.object({
    id: z.string().min(1).max(80),
    kind: z.literal("device"),
    deviceId: z.string().uuid(),
    op: opSchema,
  }),
  z.object({
    id: z.string().min(1).max(80),
    kind: z.literal("room"),
    roomId: z.string().uuid(),
    target: bulkTargetSchema,
    op: opSchema,
  }),
  z.object({
    id: z.string().min(1).max(80),
    kind: z.literal("all"),
    target: bulkTargetSchema,
    op: opSchema,
  }),
  z.object({
    id: z.string().min(1).max(80),
    kind: z.literal("automation"),
    automationId: z.string().uuid(),
  }),
  z.object({
    id: z.string().min(1).max(80),
    kind: z.literal("delay"),
    ms: z.number().int().min(0).max(ACTION_BUTTON_MAX_DELAY_MS),
  }),
]);

const gesturesSchema = z.object({
  single: z.array(stepSchema).min(1).max(ACTION_BUTTON_MAX_STEPS),
  double: z.array(stepSchema).min(1).max(ACTION_BUTTON_MAX_STEPS).nullable(),
  long: z.array(stepSchema).min(1).max(ACTION_BUTTON_MAX_STEPS).nullable(),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  icon: z.enum(ACTION_BUTTON_ICONS),
  color: z.enum(ACTION_BUTTON_COLORS),
  category: z.enum(ACTION_BUTTON_CATEGORIES),
  config: gesturesSchema,
  confirmationRequired: z.boolean().default(false),
  isEnabled: z.boolean().default(true),
  isActive: z.boolean().default(false),
});

const patchSchema = createSchema.partial();

interface ActionButtonConfigRow {
  id: string;
  account_id: string;
  user_id: string;
  name: string;
  icon: string;
  color: string;
  category: string;
  config: ActionButtonGestures;
  confirmation_required: boolean;
  is_enabled: boolean;
  is_active: boolean;
  last_executed_at: string | null;
  last_execution_status: "success" | "partial" | "failed" | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function serializeConfig(
  row: ActionButtonConfigRow,
  states?: { on: number; off: number } | null
) {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    category: row.category,
    config: row.config,
    confirmationRequired: row.confirmation_required,
    isEnabled: row.is_enabled,
    isActive: row.is_active,
    lastExecutedAt: row.last_executed_at,
    lastExecutionStatus: row.last_execution_status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(states !== undefined ? { states } : {}),
  };
}

/** Verify every referenced resource exists in this account. Returns an error message or null. */
async function validateStepReferences(
  db: AppEnv["Variables"]["db"],
  accountId: string,
  config: ActionButtonGestures
): Promise<string | null> {
  const refs = collectActionButtonReferences(config);

  const check = async (
    table: string,
    ids: Set<string>,
    label: string
  ): Promise<string | null> => {
    if (ids.size === 0) return null;
    const { data } = await db
      .from(table)
      .select("id")
      .eq("account_id", accountId)
      .in("id", Array.from(ids))
      .is("deleted_at", null);
    const found = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    const missing = Array.from(ids).filter((id) => !found.has(id));
    if (missing.length > 0) {
      return `${label} not found in your account: ${missing.length} reference(s).`;
    }
    return null;
  };

  const automationCheck = async (ids: Set<string>): Promise<string | null> => {
    if (ids.size === 0) return null;
    const { data } = await db
      .from("automation_rules")
      .select("id")
      .eq("account_id", accountId)
      .in("id", Array.from(ids))
      .is("deleted_at", null);
    const found = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    const missing = Array.from(ids).filter((id) => !found.has(id));
    if (missing.length > 0) {
      return `Scene / automation not found: ${missing.length} reference(s).`;
    }
    return null;
  };

  const [switchErr, deviceErr, roomErr, automationErr] = await Promise.all([
    check("switches", refs.switchIds, "Switch"),
    check("devices", refs.deviceIds, "Device"),
    check("rooms", refs.roomIds, "Room"),
    automationCheck(refs.automationIds),
  ]);
  return switchErr ?? deviceErr ?? roomErr ?? automationErr ?? null;
}

async function computeConfigStates(
  db: AppEnv["Variables"]["db"],
  accountId: string,
  rows: ActionButtonConfigRow[]
): Promise<Map<string, { on: number; off: number } | null>> {
  const map = new Map<string, { on: number; off: number } | null>();
  const needsInventory = rows.some((row) => row.is_enabled);
  if (!needsInventory) return map;
  const inventory = await loadControllableInventory(db, accountId);
  for (const row of rows) {
    const single = (row.config?.single ?? []) as ActionButtonStep[];
    const { targets } = resolveControllableTargets(single, inventory);
    map.set(row.id, aggregateTargetStates(targets));
  }
  return map;
}

async function loadRoomNames(
  db: AppEnv["Variables"]["db"],
  accountId: string
): Promise<Map<string, string>> {
  const { data } = await db
    .from("rooms")
    .select("id,name")
    .eq("account_id", accountId)
    .is("deleted_at", null);
  return new Map(
    ((data ?? []) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name])
  );
}

export function createActionButtonRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", requireUserSession());

  app.get("/configs", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");

    const { data, error } = await db
      .from("action_button_configs")
      .select("*")
      .eq("user_id", auth.userId)
      .eq("account_id", auth.accountId)
      .order("created_at", { ascending: true });
    if (error) return c.json({ error: error.message }, 400);

    const rows = (data ?? []) as ActionButtonConfigRow[];
    const states = await computeConfigStates(db, auth.accountId, rows);

    return c.json({
      configs: rows.map((row) => serializeConfig(row, states.get(row.id) ?? null)),
    });
  });

  app.post("/configs", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid action button configuration." }, 400);
    }

    const validation = validateActionButtonGestures(parsed.data.config);
    if (!validation.ok) {
      return c.json({ error: validation.errors.join(" ") }, 400);
    }

    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const refError = await validateStepReferences(db, auth.accountId, parsed.data.config);
    if (refError) return c.json({ error: refError }, 400);

    if (parsed.data.isActive) {
      await db
        .from("action_button_configs")
        .update({ is_active: false })
        .eq("user_id", auth.userId)
        .eq("account_id", auth.accountId)
        .eq("is_active", true);
    }

    const { data, error } = await db
      .from("action_button_configs")
      .insert({
        account_id: auth.accountId,
        user_id: auth.userId,
        name: parsed.data.name,
        icon: parsed.data.icon,
        color: parsed.data.color,
        category: parsed.data.category,
        config: parsed.data.config,
        confirmation_required: parsed.data.confirmationRequired,
        is_enabled: parsed.data.isEnabled,
        is_active: parsed.data.isActive,
        updated_at: new Date().toISOString(),
      })
      .select("*")
      .single();
    if (error) return c.json({ error: error.message }, 400);

    return c.json(
      { config: serializeConfig(data as ActionButtonConfigRow) },
      201
    );
  });

  app.patch("/configs/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid action button configuration." }, 400);
    }

    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const id = c.req.param("id");

    const { data: existingData } = await db
      .from("action_button_configs")
      .select("*")
      .eq("id", id)
      .eq("user_id", auth.userId)
      .eq("account_id", auth.accountId)
      .maybeSingle();
    if (!existingData) return c.json({ error: "Configuration not found." }, 404);

    if (parsed.data.config) {
      const validation = validateActionButtonGestures(parsed.data.config);
      if (!validation.ok) {
        return c.json({ error: validation.errors.join(" ") }, 400);
      }
      const refError = await validateStepReferences(
        db,
        auth.accountId,
        parsed.data.config
      );
      if (refError) return c.json({ error: refError }, 400);
    }

    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.name !== undefined) update.name = parsed.data.name;
    if (parsed.data.icon !== undefined) update.icon = parsed.data.icon;
    if (parsed.data.color !== undefined) update.color = parsed.data.color;
    if (parsed.data.category !== undefined) update.category = parsed.data.category;
    if (parsed.data.config !== undefined) update.config = parsed.data.config;
    if (parsed.data.confirmationRequired !== undefined)
      update.confirmation_required = parsed.data.confirmationRequired;
    if (parsed.data.isEnabled !== undefined) update.is_enabled = parsed.data.isEnabled;
    if (parsed.data.isActive !== undefined) update.is_active = parsed.data.isActive;

    if (parsed.data.isActive === true) {
      await db
        .from("action_button_configs")
        .update({ is_active: false })
        .eq("user_id", auth.userId)
        .eq("account_id", auth.accountId)
        .eq("is_active", true)
        .neq("id", id);
    }

    const { data, error } = await db
      .from("action_button_configs")
      .update(update)
      .eq("id", id)
      .eq("user_id", auth.userId)
      .eq("account_id", auth.accountId)
      .select("*")
      .single();
    if (error) return c.json({ error: error.message }, 400);

    return c.json({ config: serializeConfig(data as ActionButtonConfigRow) });
  });

  app.delete("/configs/:id", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const id = c.req.param("id");

    const { data, error } = await db
      .from("action_button_configs")
      .delete()
      .eq("id", id)
      .eq("user_id", auth.userId)
      .eq("account_id", auth.accountId)
      .select("id")
      .maybeSingle();
    if (error) return c.json({ error: error.message }, 400);
    if (!data) return c.json({ error: "Configuration not found." }, 404);
    return c.json({ ok: true });
  });

  app.post(
    "/configs/:id/execute",
    requireStaffRole("owner", "administrator", "operator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};
      const id = c.req.param("id");
      const body = await c.req.json().catch(() => ({}));
      const gestureRaw = (body as { gesture?: string } | null)?.gesture ?? "single";
      if (!(ACTION_BUTTON_GESTURES as readonly string[]).includes(gestureRaw)) {
        return c.json({ error: "Unknown gesture." }, 400);
      }
      const gesture = gestureRaw as ActionButtonGesture;

      const { data: existingData } = await db
        .from("action_button_configs")
        .select("*")
        .eq("id", id)
        .eq("user_id", auth.userId)
        .eq("account_id", auth.accountId)
        .maybeSingle();
      if (!existingData) return c.json({ error: "Configuration not found." }, 404);
      const config = existingData as ActionButtonConfigRow;

      if (!config.is_enabled) {
        return c.json({ error: "This action button is disabled." }, 409);
      }

      const steps = (config.config?.[gesture] ?? null) as ActionButtonStep[] | null;
      if (!steps || steps.length === 0) {
        return c.json(
          { error: `No ${gesture} press action is configured.` },
          400
        );
      }

      // Server-side repeat protection (double-tap / request retries).
      if (config.last_executed_at) {
        const elapsed = Date.now() - new Date(config.last_executed_at).getTime();
        if (Number.isFinite(elapsed) && elapsed < ACTION_BUTTON_COOLDOWN_MS) {
          return c.json(
            {
              error: "Action button was used moments ago. Try again shortly.",
              retryAfterMs: ACTION_BUTTON_COOLDOWN_MS - elapsed,
            },
            429
          );
        }
      }

      const roomNames = await loadRoomNames(db, auth.accountId);

      // Reserve the cooldown slot before dispatching so retried requests cannot
      // double-fire hardware commands.
      const reservedAt = new Date().toISOString();
      await db
        .from("action_button_configs")
        .update({ last_executed_at: reservedAt })
        .eq("id", config.id)
        .eq("account_id", auth.accountId);

      const execution = await executeActionButtonSteps({
        db,
        env: c.env ?? {},
        emqxFetch: deps.emqxFetch,
        accountId: auth.accountId,
        actorUserId: auth.userId,
        buttonName: config.name,
        configId: config.id,
        gesture,
        steps,
        roomNames,
      });

      const status =
        execution.failedCount === 0
          ? "success"
          : execution.executedCount > 0
            ? "partial"
            : "failed";
      const errorSummary = execution.results
        .filter((r) => r.error)
        .map((r) => r.error!)
        .join("; ");

      await db
        .from("action_button_configs")
        .update({
          last_execution_status: status,
          last_error: errorSummary.length > 0 ? errorSummary.slice(0, 500) : null,
          updated_at: reservedAt,
        })
        .eq("id", config.id)
        .eq("account_id", auth.accountId);

      return c.json({
        ok: execution.ok,
        execution: {
          ...execution,
          status,
        },
      });
    }
  );

  return app;
}
