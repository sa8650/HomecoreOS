/**
 * Shared model + pure validation helpers for the per-user Dynamic Island
 * "Action Button". Programs are ordered steps with optional delays, assigned
 * per gesture (single / double / long press).
 *
 * Steps operate exclusively on existing account resources (switches, devices,
 * rooms, automation rules). Sensors are intentionally never addressable here.
 */

export const ACTION_BUTTON_CATEGORIES = [
  "global",
  "room",
  "group",
  "automation",
  "custom",
] as const;
export type ActionButtonCategory = (typeof ACTION_BUTTON_CATEGORIES)[number];

export const ACTION_BUTTON_CATEGORY_LABELS: Record<ActionButtonCategory, string> = {
  global: "All Switches & Devices",
  room: "Room",
  group: "Selected Devices",
  automation: "Scene / Automation",
  custom: "Custom Sequence",
};

export const ACTION_BUTTON_GESTURES = ["single", "double", "long"] as const;
export type ActionButtonGesture = (typeof ACTION_BUTTON_GESTURES)[number];

export const ACTION_BUTTON_GESTURE_LABELS: Record<ActionButtonGesture, string> = {
  single: "Single Press",
  double: "Double Press",
  long: "Long Press",
};

export const ACTION_BUTTON_ICONS = [
  "zap",
  "power",
  "lightbulb",
  "plug",
  "outlet",
  "tv",
  "lock",
  "wifi",
  "home",
  "moon",
  "sun",
  "star",
  "coffee",
  "speaker",
  "airplay",
  "leaf",
  "remote",
  "sparkles",
] as const;
export type ActionButtonIcon = (typeof ACTION_BUTTON_ICONS)[number];

export const ACTION_BUTTON_COLORS = [
  "blue",
  "amber",
  "emerald",
  "red",
  "violet",
  "teal",
  "orange",
  "slate",
] as const;
export type ActionButtonColor = (typeof ACTION_BUTTON_COLORS)[number];

/** Hex values used by the web UI (chips, glow states). Kept here so both
 * worker validation and web rendering agree on the allowed set. */
export const ACTION_BUTTON_COLOR_HEX: Record<ActionButtonColor, string> = {
  blue: "#3b76f6",
  amber: "#f59e0b",
  emerald: "#10b981",
  red: "#ef4444",
  violet: "#8b5cf6",
  teal: "#14b8a6",
  orange: "#f97316",
  slate: "#64748b",
};

export const ACTION_BUTTON_MAX_STEPS = 12;
export const ACTION_BUTTON_MAX_DELAY_MS = 10_000;
export const ACTION_BUTTON_MAX_TOTAL_DELAY_MS = 15_000;
export const ACTION_BUTTON_COOLDOWN_MS = 2_000;

export type ActionButtonOp = "on" | "off" | "toggle";
export const ACTION_BUTTON_OPS = ["on", "off", "toggle"] as const;

export type ActionButtonBulkTarget = "switches" | "devices" | "all";

export type ActionButtonStep =
  | { id: string; kind: "switch"; switchId: string; op: ActionButtonOp }
  | { id: string; kind: "device"; deviceId: string; op: ActionButtonOp }
  | {
      id: string;
      kind: "room";
      roomId: string;
      target: ActionButtonBulkTarget;
      op: ActionButtonOp;
    }
  | { id: string; kind: "all"; target: ActionButtonBulkTarget; op: ActionButtonOp }
  | { id: string; kind: "automation"; automationId: string }
  | { id: string; kind: "delay"; ms: number };

export const ACTION_BUTTON_STEP_KINDS = [
  "switch",
  "device",
  "room",
  "all",
  "automation",
  "delay",
] as const;
export type ActionButtonStepKind = (typeof ACTION_BUTTON_STEP_KINDS)[number];

/** Stored in the `config` JSONB column of action_button_configs. */
export interface ActionButtonGestures {
  single: ActionButtonStep[];
  double: ActionButtonStep[] | null;
  long: ActionButtonStep[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOp(value: unknown): value is ActionButtonOp {
  return value === "on" || value === "off" || value === "toggle";
}

function isBulkTarget(value: unknown): value is ActionButtonBulkTarget {
  return value === "switches" || value === "devices" || value === "all";
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Shape-check a single step. Returns a list of problems (empty when valid). */
export function validateActionButtonStep(step: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(step)) return ["Step must be an object."];
  const id = step.id;
  if (!isNonEmptyId(id)) errors.push("Step is missing a valid id.");
  const kind = step.kind;

  switch (kind) {
    case "switch":
      if (!isNonEmptyId(step.switchId)) errors.push("Switch step is missing switchId.");
      if (!isOp(step.op)) errors.push("Switch step op must be on, off, or toggle.");
      break;
    case "device":
      if (!isNonEmptyId(step.deviceId)) errors.push("Device step is missing deviceId.");
      if (!isOp(step.op)) errors.push("Device step op must be on, off, or toggle.");
      break;
    case "room":
      if (!isNonEmptyId(step.roomId)) errors.push("Room step is missing roomId.");
      if (!isBulkTarget(step.target))
        errors.push("Room step target must be switches, devices, or all.");
      if (!isOp(step.op)) errors.push("Room step op must be on, off, or toggle.");
      break;
    case "all":
      if (!isBulkTarget(step.target))
        errors.push("All step target must be switches, devices, or all.");
      if (!isOp(step.op)) errors.push("All step op must be on, off, or toggle.");
      break;
    case "automation":
      if (!isNonEmptyId(step.automationId))
        errors.push("Automation step is missing automationId.");
      break;
    case "delay": {
      const ms = step.ms;
      if (typeof ms !== "number" || !Number.isFinite(ms)) {
        errors.push("Delay step requires a numeric ms value.");
      } else if (ms < 0 || ms > ACTION_BUTTON_MAX_DELAY_MS) {
        errors.push(
          `Delay must be between 0 and ${ACTION_BUTTON_MAX_DELAY_MS} ms.`
        );
      }
      break;
    }
    default:
      errors.push(`Unknown step kind (${String(kind)}).`);
  }
  return errors;
}

/** Shape-check a list of steps with count + shared-delay budget limits. */
export function validateActionButtonSteps(
  steps: unknown,
  options?: { maxSteps?: number; maxTotalDelayMs?: number; label?: string }
): string[] {
  const errors: string[] = [];
  const maxSteps = options?.maxSteps ?? ACTION_BUTTON_MAX_STEPS;
  const maxTotalDelayMs = options?.maxTotalDelayMs ?? ACTION_BUTTON_MAX_TOTAL_DELAY_MS;
  const label = options?.label ?? "Program";

  if (!Array.isArray(steps)) return [`${label}: steps must be an array.`];
  if (steps.length > maxSteps) {
    errors.push(`${label}: at most ${maxSteps} steps are allowed.`);
  }
  let totalDelay = 0;
  steps.forEach((step, index) => {
    const stepErrors = validateActionButtonStep(step);
    for (const err of stepErrors) errors.push(`${label} step ${index + 1}: ${err}`);
    if (isRecord(step) && step.kind === "delay" && typeof step.ms === "number") {
      totalDelay += step.ms;
    }
  });
  if (totalDelay > maxTotalDelayMs) {
    errors.push(
      `${label}: total delay (${totalDelay} ms) exceeds the ${maxTotalDelayMs} ms budget.`
    );
  }
  return errors;
}

export interface ActionButtonGestureValidation {
  ok: boolean;
  errors: string[];
}

/** Validate the full gestures payload stored in the config column. */
export function validateActionButtonGestures(
  config: unknown
): ActionButtonGestureValidation {
  const errors: string[] = [];
  if (!isRecord(config)) {
    return { ok: false, errors: ["Config must be an object with single/double/long gestures."] };
  }

  const { single, double, long } = config as {
    single?: unknown;
    double?: unknown;
    long?: unknown;
  };

  if (!Array.isArray(single) || single.length === 0) {
    errors.push("Single press must contain at least one step.");
  } else {
    errors.push(...validateActionButtonSteps(single, { label: "Single press" }));
  }

  for (const [key, value] of [
    ["Double press", double],
    ["Long press", long],
  ] as const) {
    if (value === null || value === undefined) continue;
    if (!Array.isArray(value) || value.length === 0) {
      errors.push(`${key}: provide steps or clear the gesture.`);
      continue;
    }
    errors.push(...validateActionButtonSteps(value, { label: key }));
  }

  return { ok: errors.length === 0, errors };
}

/** True when the gesture is configured (non-empty steps). */
export function isGestureConfigured(
  gestures: ActionButtonGestures,
  gesture: ActionButtonGesture
): boolean {
  const steps = gestures[gesture];
  return Array.isArray(steps) && steps.length > 0;
}

/** Aggregate every referenced resource id in a gesture payload (for
 * server-side existence checks and summary rendering). */
export function collectActionButtonReferences(config: ActionButtonGestures): {
  switchIds: Set<string>;
  deviceIds: Set<string>;
  roomIds: Set<string>;
  automationIds: Set<string>;
  includesBulkTargets: boolean;
} {
  const switchIds = new Set<string>();
  const deviceIds = new Set<string>();
  const roomIds = new Set<string>();
  const automationIds = new Set<string>();
  let includesBulkTargets = false;

  const walk = (steps: ActionButtonStep[] | null) => {
    if (!steps) return;
    for (const step of steps) {
      switch (step.kind) {
        case "switch":
          switchIds.add(step.switchId);
          break;
        case "device":
          deviceIds.add(step.deviceId);
          break;
        case "room":
          roomIds.add(step.roomId);
          includesBulkTargets = true;
          break;
        case "all":
          includesBulkTargets = true;
          break;
        case "automation":
          automationIds.add(step.automationId);
          break;
        case "delay":
          break;
      }
    }
  };

  walk(config.single);
  walk(config.double);
  walk(config.long);

  return { switchIds, deviceIds, roomIds, automationIds, includesBulkTargets };
}

/** Rough human summary of a single gesture's steps (ids must be resolved by caller). */
export function countActionButtonSteps(config: ActionButtonGestures): {
  single: number;
  double: number;
  long: number;
} {
  return {
    single: config.single?.length ?? 0,
    double: config.double?.length ?? 0,
    long: config.long?.length ?? 0,
  };
}
