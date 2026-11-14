import { Hono } from "hono";
import { z } from "zod";
import {
  compileFlowGraphToRuleConfigs,
  flowGraphFromLegacyRule,
  isValidIanaTimezone,
  normalizeConditionGroups,
  normalizeTriggerList,
  validateFlowGraph,
  type AutomationActionItem,
  type AutomationConditionsConfig,
  type AutomationTriggerConfig,
  type FlowActionNodeConfig,
  type FlowConditionNodeConfig,
  type FlowGraph,
  type FlowTriggerNodeConfig,
} from "@homecoreos/shared";
import { recordActivity } from "../lib/audit";
import {
  evaluateScheduledAutomations,
  executeAutomationActions,
  executeOrTestFlowGraph,
  parseExpectedBoolean,
  testAutomationRule,
} from "../lib/automation-engine";
import { syncControllersForAccount } from "../lib/controller-config";
import { requireStaffRole, requireUserSession } from "../middleware/auth";
import type { DbClient } from "../lib/db";
import type { AppEnv } from "../types/context";

const singleTriggerSchema = z
  .object({
    id: z.string().max(64).optional(),
    type: z.enum(["sensor_value", "time", "device_state", "sun_event"]),
    sensorId: z.string().uuid().optional(),
    operator: z.enum(["gt", "gte", "lt", "lte", "eq", "neq"]).optional(),
    threshold: z.number().finite().optional(),
    deviceId: z.string().uuid().optional(),
    switchId: z.string().uuid().optional(),
    expectedState: z.union([z.string(), z.boolean()]).optional(),
    cronTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24h HH:MM format")
      .optional(),
    days: z.array(z.string().trim().min(2).max(12)).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    sunEvent: z.enum(["sunrise", "sunset"]).optional(),
    offsetMinutes: z.number().int().min(-180).max(180).optional(),
    latitude: z.number().finite().min(-90).max(90).optional(),
    longitude: z.number().finite().min(-180).max(180).optional(),
  })
  .superRefine((trig, ctx) => {
    if (trig.type === "sensor_value") {
      if (!trig.sensorId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sensorId"],
          message: "Select a trigger sensor.",
        });
      }
      if (!trig.operator) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["operator"],
          message: "Select a comparison operator.",
        });
      }
      if (typeof trig.threshold !== "number" || !Number.isFinite(trig.threshold)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["threshold"],
          message: "Provide a numeric threshold.",
        });
      }
    } else if (trig.type === "device_state") {
      const hasSwitch = Boolean(trig.switchId);
      const hasDevice = Boolean(trig.deviceId);
      if (hasSwitch === hasDevice) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Select either one switch or one device as the state trigger.",
        });
      }
      if (hasSwitch && parseExpectedBoolean(trig.expectedState) === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expectedState"],
          message: "Switch trigger requires expectedState (ON/true or OFF/false).",
        });
      }
      if (hasDevice && (!trig.expectedState || String(trig.expectedState).trim() === "")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expectedState"],
          message: "Device trigger requires an expected target state.",
        });
      }
    } else if (trig.type === "time") {
      if (!trig.cronTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cronTime"],
          message: "Schedule trigger requires time in HH:MM format.",
        });
      }
      if (trig.timezone && !isValidIanaTimezone(trig.timezone)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["timezone"],
          message: "Invalid IANA timezone identifier.",
        });
      }
    } else if (trig.type === "sun_event") {
      if (!trig.sunEvent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sunEvent"],
          message: "Select sunrise or sunset.",
        });
      }
      if (trig.timezone && !isValidIanaTimezone(trig.timezone)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["timezone"],
          message: "Invalid IANA timezone identifier.",
        });
      }
    }
  });

const triggerSchema = singleTriggerSchema.and(
  z.object({
    triggers: z.array(singleTriggerSchema).min(1).max(10).optional(),
  })
);

const conditionSchema = z
  .object({
    id: z.string().max(64).optional(),
    type: z.enum([
      "sensor_value",
      "switch_state",
      "device_state",
      "room_state",
      "time_range",
    ]),
    sensorId: z.string().uuid().optional(),
    operator: z.enum(["gt", "gte", "lt", "lte", "eq", "neq"]).optional(),
    threshold: z.number().finite().optional(),
    switchId: z.string().uuid().optional(),
    deviceId: z.string().uuid().optional(),
    expectedState: z.union([z.string(), z.boolean()]).optional(),
    roomId: z.string().uuid().optional(),
    roomMatch: z.enum(["all_on", "all_off", "any_on"]).optional(),
    startTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24h HH:MM format")
      .optional(),
    endTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24h HH:MM format")
      .optional(),
    days: z.array(z.string().trim().min(2).max(12)).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .superRefine((cond, ctx) => {
    if (cond.type === "sensor_value") {
      if (!cond.sensorId || typeof cond.threshold !== "number") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Sensor condition requires a sensor and numeric threshold.",
        });
      }
    } else if (cond.type === "switch_state") {
      if (!cond.switchId || parseExpectedBoolean(cond.expectedState) === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Switch condition requires a switch and expected ON/OFF state.",
        });
      }
    } else if (cond.type === "device_state") {
      if (!cond.deviceId || !String(cond.expectedState ?? "").trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Device condition requires a device and expected state.",
        });
      }
    } else if (cond.type === "room_state") {
      if (!cond.roomId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Room condition requires selecting a room.",
        });
      }
    } else if (cond.type === "time_range") {
      if (!cond.startTime || !cond.endTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Time range condition requires start and end HH:MM values.",
        });
      }
      if (cond.timezone && !isValidIanaTimezone(cond.timezone)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid timezone identifier on time range condition.",
        });
      }
    }
  });

const conditionGroupSchema = z.object({
  id: z.string().max(64).optional(),
  logic: z.enum(["AND", "OR"]).default("AND"),
  conditions: z.array(conditionSchema).max(10),
});

const conditionsConfigSchema = z.union([
  z.array(conditionSchema).max(20),
  z.object({
    logic: z.enum(["AND", "OR"]).default("AND"),
    groups: z.array(conditionGroupSchema).max(10),
  }),
]);

const sceneTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("switch"),
    switchId: z.string().uuid(),
    isOn: z.boolean(),
  }),
  z.object({
    kind: z.literal("device"),
    deviceId: z.string().uuid(),
    targetState: z.string().trim().min(1).max(64),
  }),
]);

const actionSchema = z
  .object({
    id: z.string().max(64).optional(),
    type: z.enum(["switch_on", "switch_off", "device_state", "scene"]),
    switchId: z.string().uuid().optional(),
    deviceId: z.string().uuid().optional(),
    targetState: z.string().trim().max(64).optional(),
    sceneName: z.string().trim().max(120).optional(),
    targets: z.array(sceneTargetSchema).max(25).optional(),
  })
  .superRefine((act, ctx) => {
    if ((act.type === "switch_on" || act.type === "switch_off") && !act.switchId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["switchId"],
        message: "Switch action requires selecting a target switch.",
      });
    }
    if (act.type === "device_state") {
      if (!act.deviceId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deviceId"],
          message: "Device command action requires selecting a target device.",
        });
      }
      if (!act.targetState || act.targetState.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targetState"],
          message: "Device command action requires a target state.",
        });
      }
    }
    if (act.type === "scene") {
      if (!act.sceneName || act.sceneName.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sceneName"],
          message: "Scene action requires a scene name.",
        });
      }
      if (!Array.isArray(act.targets) || act.targets.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets"],
          message: "Scene action requires at least one switch or device target.",
        });
      }
    }
  });

const flowVariableSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(64),
  type: z.enum(["string", "number", "boolean"]),
  initialValue: z.union([z.string(), z.number(), z.boolean()]),
});

const flowNodeSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(["trigger", "condition", "logic", "delay", "action", "end"]),
  position: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  label: z.string().trim().min(1).max(120),
  config: z.record(z.unknown()),
});

const flowEdgeSchema = z.object({
  id: z.string().min(1).max(120),
  source: z.string().min(1).max(64),
  sourceHandle: z.string().max(32).nullable().optional(),
  target: z.string().min(1).max(64),
  targetHandle: z.string().max(32).nullable().optional(),
  label: z.string().max(64).optional(),
});

const flowGraphSchema = z.object({
  version: z.number().int().min(1).default(1),
  nodes: z.array(flowNodeSchema).min(1).max(80),
  edges: z.array(flowEdgeSchema).max(160),
  variables: z.array(flowVariableSchema).max(40).default([]),
  viewport: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      zoom: z.number().finite().min(0.1).max(4),
    })
    .optional(),
});

const automationCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    folderName: z.string().trim().min(1).max(60).default("General"),
    description: z.string().trim().max(500).default(""),
    controllerId: z.string().uuid().optional().nullable(),
    enabled: z.boolean().default(true),
    executionMode: z.enum(["cloud", "controller", "hybrid"]).default("cloud"),
    triggerConfig: triggerSchema.optional(),
    conditionsConfig: conditionsConfigSchema.optional(),
    conditionConfig: z.union([conditionsConfigSchema, z.record(z.unknown())]).optional(),
    actionsConfig: z.array(actionSchema).min(1).max(20).optional(),
    flowGraph: flowGraphSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.flowGraph && (!val.triggerConfig || !val.actionsConfig)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either flowGraph or triggerConfig + actionsConfig.",
      });
    }
  });

const automationUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  folderName: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
  executionMode: z.enum(["cloud", "controller", "hybrid"]).optional(),
  triggerConfig: triggerSchema.optional(),
  conditionsConfig: conditionsConfigSchema.optional(),
  actionsConfig: z.array(actionSchema).min(1).max(20).optional(),
  flowGraph: flowGraphSchema.optional(),
});

const testDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(120).default("Draft Automation"),
    executionMode: z.enum(["cloud", "controller", "hybrid"]).default("cloud"),
    triggerConfig: triggerSchema.optional(),
    conditionsConfig: conditionsConfigSchema.optional(),
    actionsConfig: z.array(actionSchema).min(1).max(20).optional(),
    flowGraph: flowGraphSchema.optional(),
    simulatedVariables: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    dryRun: z.boolean().default(true),
  })
  .superRefine((val, ctx) => {
    if (!val.flowGraph && (!val.triggerConfig || !val.actionsConfig)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either flowGraph or triggerConfig + actionsConfig.",
      });
    }
  });

const toggleSchema = z.object({
  enabled: z.boolean(),
});

async function verifyEntityReferences(
  db: DbClient,
  accountId: string,
  trigger?: AutomationTriggerConfig,
  conditions?: AutomationConditionsConfig,
  actions?: AutomationActionItem[],
  flowGraph?: FlowGraph
): Promise<string | null> {
  const sensorIds = new Set<string>();
  const switchIds = new Set<string>();
  const deviceIds = new Set<string>();
  const roomIds = new Set<string>();

  for (const trig of normalizeTriggerList(trigger)) {
    if (trig.sensorId) sensorIds.add(trig.sensorId);
    if (trig.switchId) switchIds.add(trig.switchId);
    if (trig.deviceId) deviceIds.add(trig.deviceId);
  }

  for (const grp of normalizeConditionGroups(conditions).groups) {
    for (const cond of grp.conditions) {
      if (cond.sensorId) sensorIds.add(cond.sensorId);
      if (cond.switchId) switchIds.add(cond.switchId);
      if (cond.deviceId) deviceIds.add(cond.deviceId);
      if (cond.roomId) roomIds.add(cond.roomId);
    }
  }

  for (const act of actions ?? []) {
    if (act.switchId) switchIds.add(act.switchId);
    if (act.deviceId) deviceIds.add(act.deviceId);
    for (const t of act.targets ?? []) {
      if (t.kind === "switch") switchIds.add(t.switchId);
      if (t.kind === "device") deviceIds.add(t.deviceId);
    }
  }

  if (flowGraph) {
    for (const n of flowGraph.nodes) {
      if (n.kind === "trigger") {
        const c = n.config as FlowTriggerNodeConfig;
        if (c.sensorId) sensorIds.add(c.sensorId);
        if (c.switchId) switchIds.add(c.switchId);
        if (c.deviceId) deviceIds.add(c.deviceId);
      } else if (n.kind === "condition") {
        const c = n.config as FlowConditionNodeConfig;
        if (c.sensorId) sensorIds.add(c.sensorId);
        if (c.switchId) switchIds.add(c.switchId);
        if (c.deviceId) deviceIds.add(c.deviceId);
        if (c.roomId) roomIds.add(c.roomId);
      } else if (n.kind === "action") {
        const c = n.config as FlowActionNodeConfig;
        if (c.switchId) switchIds.add(c.switchId);
        if (c.deviceId) deviceIds.add(c.deviceId);
        for (const t of c.targets ?? []) {
          if (t.kind === "switch") switchIds.add(t.switchId);
          if (t.kind === "device") deviceIds.add(t.deviceId);
        }
      }
    }
  }

  const [senRes, swRes, devRes, roomRes] = await Promise.all([
    sensorIds.size > 0
      ? db
          .from("sensors")
          .select("id")
          .eq("account_id", accountId)
          .in("id", Array.from(sensorIds))
          .is("deleted_at", null)
      : Promise.resolve({ data: [] }),
    switchIds.size > 0
      ? db
          .from("switches")
          .select("id")
          .eq("account_id", accountId)
          .in("id", Array.from(switchIds))
          .is("deleted_at", null)
      : Promise.resolve({ data: [] }),
    deviceIds.size > 0
      ? db
          .from("devices")
          .select("id")
          .eq("account_id", accountId)
          .in("id", Array.from(deviceIds))
          .is("deleted_at", null)
      : Promise.resolve({ data: [] }),
    roomIds.size > 0
      ? db
          .from("rooms")
          .select("id")
          .eq("account_id", accountId)
          .in("id", Array.from(roomIds))
          .is("deleted_at", null)
      : Promise.resolve({ data: [] }),
  ]);

  const foundSensors = new Set(((senRes.data ?? []) as Array<{ id: string }>).map((r) => r.id));
  for (const sid of sensorIds) {
    if (!foundSensors.has(sid)) return "Selected sensor not found in this account.";
  }

  const foundSwitches = new Set(((swRes.data ?? []) as Array<{ id: string }>).map((r) => r.id));
  for (const swId of switchIds) {
    if (!foundSwitches.has(swId)) return "Selected switch not found in this account.";
  }

  const foundDevices = new Set(((devRes.data ?? []) as Array<{ id: string }>).map((r) => r.id));
  for (const dId of deviceIds) {
    if (!foundDevices.has(dId)) return "Selected device not found in this account.";
  }

  const foundRooms = new Set(((roomRes.data ?? []) as Array<{ id: string }>).map((r) => r.id));
  for (const rId of roomIds) {
    if (!foundRooms.has(rId)) return "Selected room not found in this account.";
  }

  return null;
}

export function createAutomationRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", requireUserSession());

  app.get("/", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const { data } = await db
      .from("automation_rules")
      .select("*")
      .eq("account_id", auth.accountId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    return c.json({
      automations: data ?? [],
      offlineAutomationVerified: false,
      note: "Cloud execution is active (telemetry, switch/device state events, AND/OR conditions, scenes, sunrise/sunset, and minute cron schedules). Single-controller sensor/state automations in Controller or Hybrid mode sync to hub storage for offline execution.",
    });
  });

  app.post(
    "/",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = automationCreateSchema.safeParse(body);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0]?.message ?? "Invalid automation rule fields.";
        return c.json(
          { error: firstIssue, details: parsed.error.flatten() },
          400
        );
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");

      let resolvedTrigger = parsed.data.triggerConfig as AutomationTriggerConfig | undefined;
      let resolvedConditions: AutomationConditionsConfig =
        parsed.data.conditionsConfig ??
        (Array.isArray(parsed.data.conditionConfig) ||
        (parsed.data.conditionConfig && "groups" in parsed.data.conditionConfig)
          ? (parsed.data.conditionConfig as AutomationConditionsConfig)
          : []);
      let resolvedActions = parsed.data.actionsConfig as AutomationActionItem[] | undefined;
      let resolvedFlowGraph = parsed.data.flowGraph as unknown as FlowGraph | undefined;

      if (resolvedFlowGraph) {
        const flowCheck = validateFlowGraph({
          name: parsed.data.name,
          graph: resolvedFlowGraph,
        });
        if (!flowCheck.valid) {
          return c.json(
            { error: flowCheck.errors[0] ?? "Flow validation failed.", details: flowCheck.errors },
            400
          );
        }
        const compiled = compileFlowGraphToRuleConfigs(resolvedFlowGraph);
        resolvedTrigger = resolvedTrigger ?? compiled.triggerConfig;
        if (!parsed.data.conditionsConfig && !parsed.data.conditionConfig) {
          resolvedConditions = compiled.conditionsConfig;
        }
        resolvedActions = resolvedActions ?? compiled.actionsConfig;
      } else if (resolvedTrigger && resolvedActions) {
        resolvedFlowGraph = flowGraphFromLegacyRule({
          name: parsed.data.name,
          trigger_config: resolvedTrigger,
          conditions_config: resolvedConditions,
          actions_config: resolvedActions,
        });
      }

      const refError = await verifyEntityReferences(
        db,
        auth.accountId,
        resolvedTrigger,
        resolvedConditions,
        resolvedActions,
        resolvedFlowGraph
      );
      if (refError) return c.json({ error: refError }, 400);

      let homeId: string | null = null;
      if (parsed.data.controllerId) {
        const { data: ctrl } = await db
          .from("controllers")
          .select("id,home_id")
          .eq("id", parsed.data.controllerId)
          .eq("account_id", auth.accountId)
          .is("deleted_at", null)
          .maybeSingle();
        if (!ctrl) return c.json({ error: "Controller not found." }, 404);
        homeId = (ctrl as { home_id: string }).home_id;
      } else {
        const { data: defaultHome } = await db
          .from("homes")
          .select("id")
          .eq("account_id", auth.accountId)
          .is("deleted_at", null)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (defaultHome) {
          homeId = (defaultHome as { id: string }).id;
        } else {
          const { data: createdHome } = await db
            .from("homes")
            .insert({ account_id: auth.accountId, name: "Primary Home" })
            .select("id")
            .single();
          homeId = (createdHome as { id: string }).id;
        }
      }

      const { data, error } = await db
        .from("automation_rules")
        .insert({
          account_id: auth.accountId,
          home_id: homeId,
          name: parsed.data.name,
          folder_name: parsed.data.folderName || "General",
          description: parsed.data.description,
          enabled: parsed.data.enabled,
          execution_mode: parsed.data.executionMode,
          trigger_config: resolvedTrigger ?? { type: "sensor_value" },
          conditions_config: resolvedConditions,
          actions_config: resolvedActions ?? [],
          flow_graph: resolvedFlowGraph ?? null,
          flow_version: resolvedFlowGraph?.version ?? 1,
        })
        .select("*")
        .single();

      if (error) return c.json({ error: error.message }, 400);

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        category: "automation",
        action: "automation.created",
        summary: `Created ${parsed.data.executionMode} automation flow "${parsed.data.name}"`,
      });

      if (
        parsed.data.executionMode === "controller" ||
        parsed.data.executionMode === "hybrid"
      ) {
        await syncControllersForAccount(
          db,
          c.env ?? {},
          c.get("deps") ?? {},
          auth.accountId,
          "config_change"
        ).catch(() => []);
      }

      return c.json({ automation: data }, 201);
    }
  );

  app.post(
    "/test",
    requireStaffRole("owner", "administrator", "operator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = testDraftSchema.safeParse(body);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0]?.message ?? "Invalid automation draft.";
        return c.json({ error: firstIssue, details: parsed.error.flatten() }, 400);
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};

      if (parsed.data.flowGraph) {
        const graph = parsed.data.flowGraph as unknown as FlowGraph;
        const flowCheck = validateFlowGraph({
          name: parsed.data.name,
          graph,
        });
        if (!flowCheck.valid) {
          return c.json(
            { error: flowCheck.errors[0] ?? "Flow validation failed.", details: flowCheck.errors },
            400
          );
        }

        const compiled = compileFlowGraphToRuleConfigs(graph);
        const refError = await verifyEntityReferences(
          db,
          auth.accountId,
          compiled.triggerConfig,
          compiled.conditionsConfig,
          compiled.actionsConfig,
          graph
        );
        if (refError) return c.json({ error: refError }, 400);

        const flowRes = await executeOrTestFlowGraph({
          db,
          env: c.env ?? {},
          emqxFetch: deps.emqxFetch,
          webhookFetch: deps.webhookFetch,
          accountId: auth.accountId,
          actorUserId: auth.userId,
          ruleId: null,
          ruleName: parsed.data.name,
          graph,
          dryRun: parsed.data.dryRun,
          triggerMode: "manual",
          simulatedVariables: parsed.data.simulatedVariables,
        });

        return c.json({
          ok: true,
          dryRun: parsed.data.dryRun,
          conditionsMatched: flowRes.trace.conditionsMatched,
          conditionTrace: [],
          plannedActions: flowRes.trace.actionsPlanned.map((a) => ({
            type: a.actionType,
            targetName: a.detail,
            summary: a.detail,
          })),
          groupResults: [],
          triggerPreview: Object.values(flowRes.trace.nodeResults)
            .filter((n) => n.kind === "trigger")
            .map((n) => ({
              type: "trigger",
              matchedNow: n.status === "passed",
              summary: n.detail,
            })),
          localExecution: flowRes.localExecution,
          executedCount: flowRes.executedCount,
          errors: flowRes.errors,
          flowTrace: flowRes.trace,
        });
      }

      const refError = await verifyEntityReferences(
        db,
        auth.accountId,
        parsed.data.triggerConfig as AutomationTriggerConfig,
        (parsed.data.conditionsConfig ?? []) as AutomationConditionsConfig,
        parsed.data.actionsConfig as AutomationActionItem[]
      );
      if (refError) return c.json({ error: refError }, 400);

      const res = await testAutomationRule({
        db,
        env: c.env ?? {},
        emqxFetch: deps.emqxFetch,
        accountId: auth.accountId,
        actorUserId: auth.userId,
        ruleId: null,
        ruleName: parsed.data.name,
        triggerConfig: parsed.data.triggerConfig as AutomationTriggerConfig,
        conditionsConfig: (parsed.data.conditionsConfig ?? []) as AutomationConditionsConfig,
        actionsConfig: parsed.data.actionsConfig as AutomationActionItem[],
        dryRun: parsed.data.dryRun,
      });

      return c.json({ ok: true, dryRun: parsed.data.dryRun, ...res });
    }
  );

  app.patch(
    "/:id",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = automationUpdateSchema.safeParse(body);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0]?.message ?? "Invalid automation update fields.";
        return c.json(
          { error: firstIssue, details: parsed.error.flatten() },
          400
        );
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const ruleId = c.req.param("id");

      const { data: existing } = await db
        .from("automation_rules")
        .select("id,name,execution_mode,trigger_config,conditions_config,actions_config")
        .eq("id", ruleId)
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .maybeSingle();

      if (!existing) return c.json({ error: "Automation rule not found." }, 404);
      const prevRow = existing as {
        id: string;
        name: string;
        execution_mode: string;
        trigger_config: AutomationTriggerConfig;
        conditions_config: AutomationConditionsConfig;
        actions_config: AutomationActionItem[];
      };

      const flowGraph = parsed.data.flowGraph as unknown as FlowGraph | undefined;
      if (flowGraph) {
        const flowCheck = validateFlowGraph({
          name: parsed.data.name ?? prevRow.name,
          graph: flowGraph,
        });
        if (!flowCheck.valid) {
          return c.json(
            { error: flowCheck.errors[0] ?? "Flow validation failed.", details: flowCheck.errors },
            400
          );
        }
      }

      const refError = await verifyEntityReferences(
        db,
        auth.accountId,
        parsed.data.triggerConfig as AutomationTriggerConfig | undefined,
        parsed.data.conditionsConfig as AutomationConditionsConfig | undefined,
        parsed.data.actionsConfig as AutomationActionItem[] | undefined,
        flowGraph
      );
      if (refError) return c.json({ error: refError }, 400);

      const updates: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.folderName !== undefined) updates.folder_name = parsed.data.folderName || "General";
      if (parsed.data.description !== undefined) updates.description = parsed.data.description;
      if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
      if (parsed.data.executionMode !== undefined) {
        updates.execution_mode = parsed.data.executionMode;
      }

      if (flowGraph) {
        const compiled = compileFlowGraphToRuleConfigs(flowGraph);
        updates.flow_graph = flowGraph;
        updates.flow_version = flowGraph.version ?? 1;
        updates.trigger_config = parsed.data.triggerConfig ?? compiled.triggerConfig;
        updates.conditions_config = parsed.data.conditionsConfig ?? compiled.conditionsConfig;
        updates.actions_config = parsed.data.actionsConfig ?? compiled.actionsConfig;
      } else {
        if (parsed.data.triggerConfig !== undefined) {
          updates.trigger_config = parsed.data.triggerConfig;
        }
        if (parsed.data.conditionsConfig !== undefined) {
          updates.conditions_config = parsed.data.conditionsConfig;
        }
        if (parsed.data.actionsConfig !== undefined) {
          updates.actions_config = parsed.data.actionsConfig;
        }
        if (
          parsed.data.triggerConfig !== undefined ||
          parsed.data.conditionsConfig !== undefined ||
          parsed.data.actionsConfig !== undefined
        ) {
          updates.flow_graph = flowGraphFromLegacyRule({
            name: parsed.data.name ?? prevRow.name,
            trigger_config:
              (parsed.data.triggerConfig as AutomationTriggerConfig | undefined) ??
              prevRow.trigger_config,
            conditions_config:
              (parsed.data.conditionsConfig as AutomationConditionsConfig | undefined) ??
              prevRow.conditions_config,
            actions_config:
              (parsed.data.actionsConfig as AutomationActionItem[] | undefined) ??
              prevRow.actions_config,
          });
        }
      }

      const { data, error } = await db
        .from("automation_rules")
        .update(updates)
        .eq("id", ruleId)
        .eq("account_id", auth.accountId)
        .select("*")
        .single();

      if (error) return c.json({ error: error.message }, 400);

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        category: "automation",
        action: "automation.updated",
        summary: `Updated automation rule "${(data as { name: string }).name}"`,
      });

      const nextExecutionMode = (data as { execution_mode: string }).execution_mode;
      if (prevRow.execution_mode !== "cloud" || nextExecutionMode !== "cloud") {
        await syncControllersForAccount(
          db,
          c.env ?? {},
          c.get("deps") ?? {},
          auth.accountId,
          "config_change"
        ).catch(() => []);
      }

      return c.json({ automation: data });
    }
  );

  app.post(
    "/:id/toggle",
    requireStaffRole("owner", "administrator", "operator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = toggleSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Boolean enabled field required." }, 400);
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");

      const { data } = await db
        .from("automation_rules")
        .update({ enabled: parsed.data.enabled })
        .eq("id", c.req.param("id"))
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .select("*")
        .maybeSingle();

      if (!data) return c.json({ error: "Automation rule not found." }, 404);
      if ((data as { execution_mode: string }).execution_mode !== "cloud") {
        await syncControllersForAccount(
          db,
          c.env ?? {},
          c.get("deps") ?? {},
          auth.accountId,
          "config_change"
        ).catch(() => []);
      }
      return c.json({ automation: data });
    }
  );

  app.post(
    "/:id/run",
    requireStaffRole("owner", "administrator", "operator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};

      const { data: rule } = await db
        .from("automation_rules")
        .select("*")
        .eq("id", c.req.param("id"))
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .maybeSingle();

      if (!rule) return c.json({ error: "Automation rule not found." }, 404);

      const r = rule as {
        id: string;
        name: string;
        actions_config: AutomationActionItem[];
        flow_graph?: FlowGraph | null;
      };

      if (r.flow_graph && Array.isArray(r.flow_graph.nodes) && r.flow_graph.nodes.length > 0) {
        const flowRes = await executeOrTestFlowGraph({
          db,
          env: c.env ?? {},
          emqxFetch: deps.emqxFetch,
          webhookFetch: deps.webhookFetch,
          accountId: auth.accountId,
          actorUserId: auth.userId,
          ruleId: r.id,
          ruleName: r.name,
          graph: r.flow_graph,
          dryRun: false,
          triggerMode: "manual",
        });
        return c.json({
          ok: true,
          executedCount: flowRes.executedCount,
          errors: flowRes.errors,
          flowTrace: flowRes.trace,
        });
      }

      const res = await executeAutomationActions({
        db,
        env: c.env ?? {},
        emqxFetch: deps.emqxFetch,
        accountId: auth.accountId,
        ruleId: r.id,
        ruleName: r.name,
        actions: r.actions_config ?? [],
        actorUserId: auth.userId,
      });

      return c.json({ ok: true, ...res });
    }
  );

  app.post(
    "/:id/test",
    requireStaffRole("owner", "administrator", "operator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};
      const body = await c.req.json().catch(() => ({}));
      const dryRun = (body as { dryRun?: boolean } | null)?.dryRun !== false;

      const { data: rule } = await db
        .from("automation_rules")
        .select("*")
        .eq("id", c.req.param("id"))
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .maybeSingle();

      if (!rule) return c.json({ error: "Automation rule not found." }, 404);

      const r = rule as {
        id: string;
        name: string;
        trigger_config: AutomationTriggerConfig;
        conditions_config: AutomationConditionsConfig;
        actions_config: AutomationActionItem[];
        flow_graph?: FlowGraph | null;
      };

      if (r.flow_graph && Array.isArray(r.flow_graph.nodes) && r.flow_graph.nodes.length > 0) {
        const flowRes = await executeOrTestFlowGraph({
          db,
          env: c.env ?? {},
          emqxFetch: deps.emqxFetch,
          webhookFetch: deps.webhookFetch,
          accountId: auth.accountId,
          actorUserId: auth.userId,
          ruleId: r.id,
          ruleName: r.name,
          graph: r.flow_graph,
          dryRun,
          triggerMode: "manual",
        });

        return c.json({
          ok: true,
          dryRun,
          conditionsMatched: flowRes.trace.conditionsMatched,
          conditionTrace: [],
          plannedActions: flowRes.trace.actionsPlanned.map((a) => ({
            type: a.actionType,
            targetName: a.nodeId,
            summary: a.detail,
          })),
          executedCount: flowRes.executedCount,
          errors: flowRes.errors,
          flowTrace: flowRes.trace,
        });
      }

      const res = await testAutomationRule({
        db,
        env: c.env ?? {},
        emqxFetch: deps.emqxFetch,
        accountId: auth.accountId,
        actorUserId: auth.userId,
        ruleId: r.id,
        ruleName: r.name,
        triggerConfig: r.trigger_config,
        conditionsConfig: r.conditions_config,
        actionsConfig: r.actions_config ?? [],
        dryRun,
      });

      return c.json({ ok: true, dryRun, ...res });
    }
  );

  app.post(
    "/evaluate-schedules",
    requireStaffRole("owner", "administrator", "operator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};
      const body = await c.req.json().catch(() => ({}));
      const atIso = (body as { at?: string } | null)?.at;
      const now = atIso ? new Date(atIso) : new Date();
      if (Number.isNaN(now.getTime())) {
        return c.json({ error: "Invalid timestamp for schedule check." }, 400);
      }
      const result = await evaluateScheduledAutomations({
        db,
        env: c.env ?? {},
        emqxFetch: deps.emqxFetch,
        accountId: auth.accountId,
        now,
      });
      return c.json({ ok: true, ...result });
    }
  );

  app.delete(
    "/:id",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const { data } = await db
        .from("automation_rules")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", c.req.param("id"))
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .select("id,execution_mode")
        .maybeSingle();
      if (!data) return c.json({ error: "Automation rule not found." }, 404);
      if ((data as { execution_mode: string }).execution_mode !== "cloud") {
        await syncControllersForAccount(
          db,
          c.env ?? {},
          c.get("deps") ?? {},
          auth.accountId,
          "config_change"
        ).catch(() => []);
      }
      return c.json({ ok: true });
    }
  );

  return app;
}
