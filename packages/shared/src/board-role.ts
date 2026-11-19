/**
 * Unified Controller / Node device roles.
 *
 * One firmware, one device record, one identity. A board picks an operating role
 * and keeps it until the user changes it; the role is never inferred from the
 * hardware, and it is never promoted automatically.
 *
 * This module is the single source of truth for role names, communication modes,
 * ESP-NOW link timing and the guards that protect role changes. The Worker, the
 * web console and the firmware (`firmware/main/role_logic.c`) all implement the
 * same rules; the C side mirrors these constants.
 */

export const DEVICE_ROLES = ["controller", "node"] as const;
export type BoardRole = (typeof DEVICE_ROLES)[number];

/** How a Node currently reaches HomecoreOS. */
export const NODE_COMM_MODES = ["espnow", "wifi_mqtt", "offline"] as const;
export type NodeCommMode = (typeof NODE_COMM_MODES)[number];

/**
 * Node link states reported by the firmware.
 * - `linked`        ESP-NOW link to the assigned Controller is healthy.
 * - `controller_lost` heartbeat missed; still trying the assigned Controller.
 * - `reconnecting`  ESP-NOW re-link attempt after the Controller came back.
 * - `standalone`    Wi-Fi/MQTT fallback; still logically a Node.
 * - `unassigned`    no Controller assigned yet.
 */
export const NODE_LINK_STATES = [
  "linked",
  "controller_lost",
  "reconnecting",
  "standalone",
  "unassigned",
] as const;
export type NodeLinkState = (typeof NODE_LINK_STATES)[number];

/** ESP-NOW heartbeat cadence from Node to its Controller. */
export const ESPNOW_HEARTBEAT_INTERVAL_MS = 2_000;
/** Missed heartbeats for this long mean the link is lost (5 missed beats). */
export const ESPNOW_LINK_TIMEOUT_MS = 10_000;
/** How long a Node keeps retrying its Controller before falling back to Wi-Fi. */
export const ESPNOW_RECONNECT_WINDOW_MS = 45_000;
/** While standalone, how often the Node probes for its Controller to return. */
export const ESPNOW_CONTROLLER_PROBE_MS = 15_000;
/** A Controller reports a Node offline after this long without a heartbeat. */
export const ESPNOW_NODE_STALE_MS = 20_000;

/**
 * Board capability gate for ESP-NOW. ESP-NOW needs the 2.4 GHz Wi-Fi radio, so
 * Wi-Fi-less boards (ESP32-H2/H21, ESP8266 in the shared ESP-IDF firmware) can
 * only ever be Nodes over Wi-Fi/MQTT, and cannot host a Controller link.
 */
export function boardSupportsEspNow(board: {
  chip_family?: string | null;
  supports_wifi?: boolean | null;
} | null | undefined): boolean {
  if (!board) return false;
  if (board.supports_wifi === false) return false;
  const chip = (board.chip_family ?? "").trim().toLowerCase();
  if (!chip) return false;
  return chip !== "esp8266" && chip !== "esp32h2" && chip !== "esp32h21";
}

/** True when the board can act as a Controller (needs Wi-Fi + MQTT + ESP-NOW). */
export function boardSupportsControllerRole(board: {
  chip_family?: string | null;
  supports_wifi?: boolean | null;
} | null | undefined): boolean {
  return boardSupportsEspNow(board);
}

/**
 * Legacy rows have no role stored. They are Controllers: every device that
 * existed before roles were introduced was one, and that must not change.
 */
export function normalizeBoardRole(value: unknown): BoardRole {
  return value === "node" ? "node" : "controller";
}

export function normalizeNodeCommMode(value: unknown): NodeCommMode | null {
  return value === "espnow" || value === "wifi_mqtt" || value === "offline" ? value : null;
}

export function normalizeNodeLinkState(value: unknown): NodeLinkState {
  return (NODE_LINK_STATES as readonly string[]).includes(value as string)
    ? (value as NodeLinkState)
    : "unassigned";
}

export function boardRoleLabel(role: BoardRole): string {
  return role === "node" ? "Node" : "Controller";
}

export function nodeCommModeLabel(mode: NodeCommMode | null | undefined): string {
  switch (mode) {
    case "espnow":
      return "ESP-NOW";
    case "wifi_mqtt":
      return "Wi-Fi / MQTT";
    case "offline":
      return "Offline";
    default:
      return "Unknown";
  }
}

/**
 * The one status line the UI shows for a device. A standalone Node is never
 * described as a Controller: it stays a Node that lost its Controller.
 */
export function deviceStatusLabel(input: {
  role: BoardRole;
  online: boolean;
  commMode?: NodeCommMode | null;
  linkState?: NodeLinkState | null;
  assignedControllerName?: string | null;
}): string {
  const { role, online, commMode, linkState, assignedControllerName } = input;
  if (role === "controller") return online ? "Online" : "Offline";
  if (!online) return "Offline";
  // A lost/reconnecting link always wins over a stale `commMode`: the last
  // reported roster may still say "espnow" while the heartbeat has already timed
  // out, and the console must never claim a dead link is healthy.
  if (linkState === "controller_lost" || linkState === "reconnecting") {
    return "Standalone Node — Controller Disconnected";
  }
  if (commMode === "espnow" || linkState === "linked") {
    return assignedControllerName
      ? `Linked to ${assignedControllerName}`
      : "Linked to Controller";
  }
  if (commMode === "wifi_mqtt" || linkState === "standalone") {
    return "Standalone Node — Controller Disconnected";
  }
  if (linkState === "unassigned") return "No Controller assigned";
  return "Online";
}

/** True when a Node is running its Wi-Fi/MQTT fallback. */
export function isNodeStandalone(input: {
  role: BoardRole;
  commMode?: NodeCommMode | null;
  linkState?: NodeLinkState | null;
}): boolean {
  if (input.role !== "node") return false;
  if (input.linkState === "controller_lost" || input.linkState === "reconnecting") return true;
  return input.commMode === "wifi_mqtt" || input.linkState === "standalone";
}

/**
 * Communication mode derived from what a device reports. Nodes prefer ESP-NOW;
 * a Node that lost its Controller reports its Wi-Fi/MQTT fallback instead.
 */
export function deriveCommMode(input: {
  role: BoardRole;
  online: boolean;
  espNowLinked?: boolean | null;
  linkState?: NodeLinkState | null;
  mqttConnected?: boolean | null;
}): NodeCommMode {
  if (!input.online) return "offline";
  if (input.role === "controller") return input.mqttConnected === false ? "offline" : "wifi_mqtt";
  if (input.espNowLinked || input.linkState === "linked") return "espnow";
  if (input.mqttConnected) return "wifi_mqtt";
  return "offline";
}

/** Why a role change is blocked, if it is. */
export type RoleChangeBlocker =
  | { code: "board_unsupported"; message: string }
  | { code: "attached_nodes"; message: string; attachedNodeCount: number }
  | { code: "self_reference"; message: string }
  | { code: "unknown_controller"; message: string };

export function roleChangeBlocker(input: {
  targetRole: BoardRole;
  currentRole: BoardRole;
  boardSupported: boolean;
  attachedNodeCount: number;
  acknowledgeAttachedNodes?: boolean;
  selfReference?: boolean;
}): RoleChangeBlocker | null {
  if (input.currentRole === input.targetRole) return null;
  if (!input.boardSupported) {
    return {
      code: "board_unsupported",
      message:
        input.targetRole === "controller"
          ? "This board does not support the Controller role: ESP-NOW and a stable Wi-Fi link are required."
          : "This board does not support the Node role: a 2.4 GHz Wi-Fi radio is required for ESP-NOW and for the Wi-Fi/MQTT fallback.",
    };
  }
  if (
    input.currentRole === "controller" &&
    input.targetRole === "node" &&
    input.attachedNodeCount > 0 &&
    !input.acknowledgeAttachedNodes
  ) {
    return {
      code: "attached_nodes",
      message: `${input.attachedNodeCount} Node${input.attachedNodeCount === 1 ? "" : "s"} still rely on this Controller. Reassign or move them first, or confirm that they should fall back to Wi-Fi.`,
      attachedNodeCount: input.attachedNodeCount,
    };
  }
  if (input.selfReference) {
    return { code: "self_reference", message: "A device cannot be assigned to itself." };
  }
  return null;
}

/**
 * A Node's assigned Controller must be an online Controller in the same account
 * and home, and cannot be the Node itself.
 */
export function canAssignNodeToController(input: {
  nodeId: string;
  boardInstanceId: string;
  controllerRole: BoardRole;
  controllerOnline: boolean;
  sameHome: boolean;
}): { ok: true } | { ok: false; message: string } {
  if (input.boardInstanceId === input.nodeId) {
    return { ok: false, message: "A device cannot be assigned to itself." };
  }
  if (input.controllerRole !== "controller") {
    return { ok: false, message: "Only a device operating as a Controller can host Nodes." };
  }
  if (!input.sameHome) {
    return { ok: false, message: "A Node can only be assigned to a Controller in the same home." };
  }
  if (!input.controllerOnline) {
    return { ok: false, message: "The Controller must be online before Nodes can be assigned to it." };
  }
  return { ok: true };
}
