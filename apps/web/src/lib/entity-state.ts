import type { ControllerItem, DeviceStateStatus } from "@/features/types";

/**
 * Single source of truth for how a controllable entity is presented.
 *
 * The requirement is that the UI never shows a state as successful before the
 * controller has confirmed it. Rather than sprinkling optimistic flags through
 * each page, every surface derives its badge from these helpers.
 */

export type EntityVisualState = "on" | "off" | "pending-on" | "pending-off" | "failed" | "offline";

export interface EntityStateInput {
  /** Last state confirmed by the controller. */
  appliedOn: boolean;
  /** Outstanding intent, if any. */
  desiredOn?: boolean | null;
  status?: DeviceStateStatus;
  ctrl?: Pick<ControllerItem, "status" | "mqtt_connected"> | undefined;
  /** Entity-level reachability flag from the API. */
  entityOnline?: boolean;
}

/**
 * Resolves the display state.
 *
 * Precedence matters: a failed command is more important than a pending one,
 * and "offline" is only reported when there is no outstanding intent (otherwise
 * the honest answer is "pending" - the command is queued and will be applied).
 */
export function resolveEntityVisualState(input: EntityStateInput): EntityVisualState {
  const { appliedOn, desiredOn, status, ctrl, entityOnline } = input;

  if (status === "failed") return "failed";

  const hasIntent = status === "pending" && typeof desiredOn === "boolean";
  if (hasIntent) return desiredOn ? "pending-on" : "pending-off";

  // The controller's heartbeat-driven status is the authoritative reachability
  // signal (it is refreshed by a stale-state sweep). Entity-level `is_online`
  // is only written when a controller reports, so treating a missing value as
  // "offline" would leave never-yet-reported entities stuck as offline.
  if (ctrl && ctrl.status !== "online") return "offline";
  // Only an explicit negative report marks the entity itself unreachable.
  if (entityOnline === false) return "offline";

  return appliedOn ? "on" : "off";
}

export interface EntityStateMeta {
  /** Short label for the badge. */
  label: string;
  /** Longer, plain-language explanation for tooltips. */
  description: string;
  /** Tailwind text colour token used by existing cards. */
  tone: "on" | "off" | "pending" | "failed" | "offline";
  /** Whether the entity should render as visually "active". */
  showAsOn: boolean;
  /** True while the cloud is waiting for controller confirmation. */
  isPending: boolean;
}

export function describeEntityState(state: EntityVisualState): EntityStateMeta {
  switch (state) {
    case "pending-on":
      return {
        label: "Turning on",
        description: "Command sent - waiting for the controller to confirm.",
        tone: "pending",
        showAsOn: true,
        isPending: true,
      };
    case "pending-off":
      return {
        label: "Turning off",
        description: "Command sent - waiting for the controller to confirm.",
        tone: "pending",
        showAsOn: false,
        isPending: true,
      };
    case "failed":
      return {
        label: "Not applied",
        description: "The controller did not accept the last command.",
        tone: "failed",
        showAsOn: false,
        isPending: false,
      };
    case "offline":
      return {
        label: "Offline",
        description: "Controller is unreachable. Changes will apply when it reconnects.",
        tone: "offline",
        showAsOn: false,
        isPending: false,
      };
    case "on":
      return {
        label: "On",
        description: "Confirmed on by the controller.",
        tone: "on",
        showAsOn: true,
        isPending: false,
      };
    default:
      return {
        label: "Off",
        description: "Confirmed off by the controller.",
        tone: "off",
        showAsOn: false,
        isPending: false,
      };
  }
}

/** Convenience wrapper: visual state plus its presentation metadata. */
export function entityStateMeta(input: EntityStateInput): EntityStateMeta {
  return describeEntityState(resolveEntityVisualState(input));
}

/**
 * True while a command is in flight or awaiting confirmation. Used to disable
 * the toggle so a user cannot queue contradictory commands against a controller
 * that has not caught up yet.
 */
export function isEntityCommandInFlight(input: EntityStateInput): boolean {
  return input.status === "pending";
}
