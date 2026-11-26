import {
  normalizeBindingGeneration,
  normalizeBindingState,
  selectCloudRoute,
  type BindingState,
  type CloudRouteState,
  type EspNowConnectionState,
} from "@homecoreos/shared";

export const TELEMETRY_FRESH_MS = 60_000;
export const ROSTER_FRESH_MS = 30_000;

export interface RouteAuthorityRow {
  id: string;
  board_role?: string | null;
  assigned_controller_id?: string | null;
  binding_id?: string | null;
  binding_state?: string | null;
  binding_generation?: number | string | null;
  cloud_route?: string | null;
  route_generation?: number | string | null;
  mqtt_connected?: boolean | null;
  status?: string | null;
  node_link_state?: string | null;
  comm_mode?: string | null;
  last_heartbeat_at?: string | null;
  last_communication_at?: string | null;
  node_last_linked_at?: string | null;
  espnow_telemetry?: Record<string, unknown> | null;
}

export interface RouteAuthorityDecision {
  route: CloudRouteState;
  relayControllerId: string | null;
  generation: number;
  bindingState: BindingState;
  commandId: string | null;
  reasons: string[];
}

function freshnessMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? Date.now() - t : null;
}

export function isTelemetryFresh(row: RouteAuthorityRow | null): boolean {
  if (!row) return false;
  const age = Math.min(
    ...[
      freshnessMs(row.last_communication_at),
      freshnessMs(row.last_heartbeat_at),
      freshnessMs(row.node_last_linked_at),
    ].filter((n): n is number => n !== null)
  );
  return Number.isFinite(age) && age <= TELEMETRY_FRESH_MS;
}

function rosterEntry(row: RouteAuthorityRow, nodeId: string): Record<string, unknown> | null {
  const tel = row.espnow_telemetry;
  if (!tel || typeof tel !== "object") return null;
  const roster = tel.roster;
  if (!Array.isArray(roster)) return null;
  const found = roster.find(
    (r) => r && typeof r === "object" && (r as Record<string, unknown>).id === nodeId
  );
  return found ? (found as Record<string, unknown>) : null;
}

export interface ControllerRouteInput {
  node: RouteAuthorityRow;
  controller: RouteAuthorityRow | null;
  nodeId: string;
  commandId?: string | null;
  now?: number;
}

/**
 * The single routing authority for Node command delivery. A route is usable
 * only with fresh telemetry, a current binding generation, a Controller roster
 * entry and a live Controller MQTT session. A healthy Node MQTT session is
 * always a valid direct route, including during a handoff.
 */
export function decideNodeRoute(input: ControllerRouteInput): RouteAuthorityDecision {
  const node = input.node;
  const generation = normalizeBindingGeneration(node.binding_generation);
  const bindingState = normalizeBindingState(node.binding_state);
  const reasons: string[] = [];
  const controllerId = node.assigned_controller_id ?? null;
  const controller = input.controller;

  const nodeMqttHealthy =
    Boolean(node.mqtt_connected) && node.status === "online";
  const telemetryFresh = isTelemetryFresh(node);
  if (!telemetryFresh) reasons.push("stale_node_telemetry");
  if (!nodeMqttHealthy) reasons.push("node_mqtt_unavailable");

  let controllerMqttHealthy = false;
  let espnowLinked = false;
  let inRoster = false;
  let rosterFresh = false;

  if (controller && controllerId === controller.id) {
    controllerMqttHealthy =
      controller.status === "online" && Boolean(controller.mqtt_connected);
    if (!controllerMqttHealthy) reasons.push("controller_mqtt_unavailable");
    const entry = rosterEntry(controller, input.nodeId);
    if (entry) {
      const reportedState = String(entry.link ?? "linked");
      espnowLinked = reportedState === "linked";
      inRoster = espnowLinked;
      const reportedAt = freshnessMs(controller.last_communication_at);
      rosterFresh = reportedAt !== null && reportedAt <= ROSTER_FRESH_MS;
      const entryGeneration = normalizeBindingGeneration(entry.gen ?? entry.generation);
      if (generation > 0 && entryGeneration > 0 && entryGeneration !== generation) {
        reasons.push("binding_generation_mismatch");
        inRoster = false;
        espnowLinked = false;
      }
      if (entry.bid && node.binding_id && entry.bid !== node.binding_id) {
        reasons.push("binding_id_mismatch");
        inRoster = false;
        espnowLinked = false;
      }
    } else {
      reasons.push("node_missing_from_controller_roster");
    }
    if (!rosterFresh) {
      reasons.push("stale_controller_roster");
      espnowLinked = false;
      inRoster = false;
    }
  } else {
    reasons.push("assigned_controller_unavailable");
  }

  if (bindingState === "revoked" || bindingState === "unpaired") {
    reasons.push("binding_not_active");
    espnowLinked = false;
    inRoster = false;
  }

  const route = selectCloudRoute({
    nodeMqttHealthy,
    controllerMqttHealthy,
    espnowLinked,
    inRoster,
    telemetryFresh,
  });

  return {
    route,
    relayControllerId: route === "controller_mqtt" ? controllerId : null,
    generation,
    bindingState,
    commandId: input.commandId ?? null,
    reasons,
  };
}

/**
 * Stable command identity across a failover. Callers pass the same key when
 * retrying, so a toggle is never re-issued as a fresh non-idempotent command.
 */
export function commandIdentity(payload: Record<string, unknown>): string {
  const explicit = payload.command_id ?? payload.id;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `cmd-${(hash >>> 0).toString(16)}-${canonical.length}`;
}

export function routeLabel(route: CloudRouteState): string {
  switch (route) {
    case "direct_node_mqtt": return "Connected directly";
    case "controller_mqtt": return "Connected through Controller";
    case "connecting": return "Reconnecting automatically";
    default: return "Cloud unavailable";
  }
}

export function espNowLabel(state: EspNowConnectionState): string {
  return state;
}
