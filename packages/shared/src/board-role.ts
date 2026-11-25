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

/** Entry in a Controller's firmware-reported ESP-NOW Node roster. */
export interface EspNowRosterEntry {
  id: string;
  link: NodeLinkState;
  rssi?: number | null;
  channel?: number | null;
  seq?: number | null;
}

/** Hardware-reported ESP-NOW diagnostics stored per board instance. */
export interface EspNowBoardTelemetry {
  channel?: number | null;
  rssi?: number | null;
  keepaliveTxSeq?: number | null;
  ackRxSeq?: number | null;
  ackConfirmed?: boolean | null;
  nodeReportedLinkState?: NodeLinkState | null;
  nodeReportedAt?: string | null;
  controllerHeardAt?: string | null;
  controllerReportedRssi?: number | null;
  controllerReportedChannel?: number | null;
  roster?: EspNowRosterEntry[] | null;
  rosterReportedAt?: string | null;
}

export type NodeControllerVerificationTone =
  | "waiting"
  | "connected"
  | "degraded"
  | "failed";

export type NodeControllerFaultTarget =
  | "node"
  | "controller"
  | "espnow_link"
  | "cloud_link"
  | "assignment"
  | null;

export type NodeControllerStageId =
  | "save"
  | "node_config"
  | "controller_ready"
  | "espnow_attempt"
  | "bidirectional_ack"
  | "controller_cloud"
  | "verdict";

export type NodeControllerStageStatus =
  | "pending"
  | "active"
  | "confirmed"
  | "warning"
  | "failed";

export interface NodeControllerLifecycleStage {
  id: NodeControllerStageId;
  label: string;
  detail: string;
  status: NodeControllerStageStatus;
}

export interface NodeSnapshotForVerification {
  id: string;
  name: string;
  status: string;
  board_role?: BoardRole | string | null;
  assigned_controller_id?: string | null;
  node_comm_mode?: NodeCommMode | string | null;
  comm_mode?: NodeCommMode | string | null;
  node_link_state?: NodeLinkState | string | null;
  espnow_channel?: number | null;
  config_revision?: number | null;
  last_synced_config_revision?: number | null;
  pending_config_sync?: boolean | null;
  last_heartbeat_at?: string | null;
  last_communication_at?: string | null;
  node_last_linked_at?: string | null;
  espnow_telemetry?: EspNowBoardTelemetry | null;
}

export interface ControllerSnapshotForVerification {
  id: string;
  name: string;
  status: string;
  board_role?: BoardRole | string | null;
  hardware_uid?: string | null;
  mqtt_connected?: boolean | null;
  wifi_connected?: boolean | null;
  espnow_channel?: number | null;
  connected_node_count?: number | null;
  reported_nodes?: EspNowRosterEntry[] | null;
  hosted_node_ids?: string[] | null;
  last_heartbeat_at?: string | null;
  last_communication_at?: string | null;
  espnow_telemetry?: EspNowBoardTelemetry | null;
}

export interface NodeControllerLinkEvaluation {
  connected: boolean;
  connectionLostAfterSuccess: boolean;
  tone: NodeControllerVerificationTone;
  faultTarget: NodeControllerFaultTarget;
  headline: string;
  summary: string;
  nodeOnline: boolean;
  controllerOnline: boolean;
  controllerMqttHealthy: boolean;
  nodeConfigSynced: boolean;
  keepaliveSentOrHeard: boolean;
  controllerHeardNode: boolean;
  nodeAckConfirmed: boolean;
  rosterAvailable: boolean;
  inControllerRoster: boolean;
  channelMismatch: boolean;
  effectiveChannel: number | null;
  effectiveRssi: number | null;
  stages: NodeControllerLifecycleStage[];
}

/**
 * Pure hardware-truthful evaluator for the Node <-> Controller ESP-NOW link.
 *
 * Never uses timers or simulated progress to claim a connection: `connected`
 * becomes true ONLY when server-reported hardware data confirms all required
 * Node, Controller, ESP-NOW, roster and MQTT invariants.
 */
export function evaluateNodeControllerLink(input: {
  node: NodeSnapshotForVerification | null | undefined;
  controller: ControllerSnapshotForVerification | null | undefined;
  saving?: boolean;
  saveError?: string | null;
  wasEverConnected?: boolean;
  waitingOverReconnectWindow?: boolean;
}): NodeControllerLinkEvaluation {
  const {
    node,
    controller,
    saving = false,
    saveError = null,
    wasEverConnected = false,
    waitingOverReconnectWindow = false,
  } = input;

  if (saving || !node || !controller) {
    const failed = Boolean(saveError);
    return {
      connected: false,
      connectionLostAfterSuccess: false,
      tone: failed ? "failed" : "waiting",
      faultTarget: failed ? "assignment" : null,
      headline: failed
        ? "Role or Controller assignment failed"
        : !node || !controller
          ? "Loading board state…"
          : "Saving role and Controller assignment…",
      summary:
        saveError ??
        "Updating role and publishing consolidated configuration snapshots to both boards.",
      nodeOnline: Boolean(node && node.status === "online"),
      controllerOnline: Boolean(controller && controller.status === "online"),
      controllerMqttHealthy: Boolean(controller?.mqtt_connected),
      nodeConfigSynced: false,
      keepaliveSentOrHeard: false,
      controllerHeardNode: false,
      nodeAckConfirmed: false,
      rosterAvailable: false,
      inControllerRoster: false,
      channelMismatch: false,
      effectiveChannel: null,
      effectiveRssi: null,
      stages: [
        {
          id: "save",
          label: "Saving role and Controller assignment",
          detail: saveError ?? "Writing assignment and updating configuration snapshots.",
          status: failed ? "failed" : "active",
        },
        {
          id: "node_config",
          label: "Waiting for Node to apply updated configuration",
          detail: "Pending assignment save.",
          status: "pending",
        },
        {
          id: "controller_ready",
          label: "Waiting for Controller to be ready and discoverable",
          detail: "Pending assignment save.",
          status: "pending",
        },
        {
          id: "espnow_attempt",
          label: "Attempting ESP-NOW link",
          detail: "Pending configuration sync.",
          status: "pending",
        },
        {
          id: "bidirectional_ack",
          label: "Confirming bidirectional Node-Controller communication",
          detail: "Waiting for keepalive and Controller ACK.",
          status: "pending",
        },
        {
          id: "controller_cloud",
          label: "Verifying Controller cloud / MQTT path",
          detail: "Pending link verification.",
          status: "pending",
        },
        {
          id: "verdict",
          label: failed ? "Assignment failed" : "Awaiting hardware confirmation",
          detail: saveError ?? "Connection is only confirmed from live hardware telemetry.",
          status: failed ? "failed" : "pending",
        },
      ],
    };
  }

  const nodeRole = normalizeBoardRole(node.board_role);
  const ctrlRole = normalizeBoardRole(controller.board_role);
  const nodeOnline = node.status === "online";
  const controllerOnline = controller.status === "online";
  const controllerMqttHealthy = controllerOnline && Boolean(controller.mqtt_connected);
  const controllerHasMac = Boolean(controller.hardware_uid && controller.hardware_uid.trim().length > 0);
  const assignmentMatches =
    nodeRole === "node" &&
    ctrlRole === "controller" &&
    node.assigned_controller_id === controller.id;

  const linkState = normalizeNodeLinkState(node.node_link_state);
  const commMode =
    normalizeNodeCommMode(node.node_comm_mode) ??
    normalizeNodeCommMode(node.comm_mode) ??
    deriveCommMode({
      role: nodeRole,
      online: nodeOnline,
      espNowLinked: linkState === "linked",
      linkState,
      mqttConnected: false,
    });

  const nodeTel = node.espnow_telemetry ?? null;
  const ctrlTel = controller.espnow_telemetry ?? null;

  // Roster verification: never rely on connected_node_count alone.
  const reportedRoster =
    Array.isArray(controller.reported_nodes)
      ? controller.reported_nodes
      : Array.isArray(ctrlTel?.roster)
        ? ctrlTel!.roster!
        : null;
  const rosterAvailable = reportedRoster !== null;
  const rosterEntry = reportedRoster
    ? reportedRoster.find((r) => r.id === node.id) ?? null
    : null;
  const inReportedRoster = Boolean(
    rosterEntry && normalizeNodeLinkState(rosterEntry.link ?? "linked") === "linked"
  );
  const hostedIds = Array.isArray(controller.hosted_node_ids)
    ? controller.hosted_node_ids
    : null;
  const inControllerRoster = rosterAvailable
    ? inReportedRoster
    : hostedIds !== null
      ? hostedIds.includes(node.id)
      : linkState === "linked" && commMode === "espnow";

  const nodeChannel = nodeTel?.channel ?? node.espnow_channel ?? null;
  const ctrlChannel =
    rosterEntry?.channel ?? ctrlTel?.channel ?? controller.espnow_channel ?? null;
  const effectiveChannel =
    rosterEntry?.channel ??
    nodeTel?.controllerReportedChannel ??
    nodeChannel ??
    ctrlChannel ??
    null;
  const effectiveRssi =
    rosterEntry?.rssi ??
    nodeTel?.rssi ??
    nodeTel?.controllerReportedRssi ??
    null;

  const channelMismatch = Boolean(
    nodeChannel &&
      ctrlChannel &&
      nodeChannel !== ctrlChannel &&
      linkState !== "linked"
  );

  // Config sync check: either the revision is explicitly acknowledged, or the
  // Node is already reporting post-assignment ESP-NOW activity.
  const revTarget = typeof node.config_revision === "number" ? node.config_revision : null;
  const revSynced =
    typeof node.last_synced_config_revision === "number"
      ? node.last_synced_config_revision
      : null;
  const configExplicitlySynced =
    node.pending_config_sync === false &&
    (revTarget === null || revSynced === null || revSynced >= revTarget);
  const nodeConfigSynced =
    configExplicitlySynced ||
    linkState === "linked" ||
    inReportedRoster ||
    Boolean(nodeTel?.keepaliveTxSeq && nodeTel.keepaliveTxSeq > 0);

  const controllerHeardNode =
    inReportedRoster || Boolean(nodeTel?.controllerHeardAt);
  const keepaliveSentOrHeard =
    controllerHeardNode ||
    Boolean(nodeTel?.keepaliveTxSeq && nodeTel.keepaliveTxSeq > 0) ||
    linkState === "linked";
  const nodeAckConfirmed =
    nodeOnline &&
    assignmentMatches &&
    linkState === "linked" &&
    commMode === "espnow" &&
    nodeTel?.ackConfirmed !== false;

  const connected =
    nodeOnline &&
    assignmentMatches &&
    linkState === "linked" &&
    commMode === "espnow" &&
    controllerOnline &&
    controllerMqttHealthy &&
    inControllerRoster &&
    nodeAckConfirmed;

  const connectionLostAfterSuccess = Boolean(wasEverConnected && !connected);

  // Determine overall tone, faultTarget, headline and summary from real state.
  let tone: NodeControllerVerificationTone = "waiting";
  let faultTarget: NodeControllerFaultTarget = null;
  let headline = "Connecting Node to Controller…";
  let summary =
    "Waiting for live ESP-NOW keepalive and Controller acknowledgement (2s keepalive · 10s timeout · 45s fallback window).";

  if (connected) {
    tone = "connected";
    faultTarget = null;
    headline = "Connected over ESP-NOW";
    summary = `${node.name} is linked to ${controller.name} over 2.4 GHz ESP-NOW and routing cloud traffic through ${controller.name}'s MQTT session.`;
  } else if (!assignmentMatches) {
    tone = "failed";
    faultTarget = "assignment";
    headline = "Controller assignment mismatch";
    summary =
      nodeRole !== "node"
        ? `${node.name} is no longer operating in the Node role.`
        : ctrlRole !== "controller"
          ? `${controller.name} is no longer operating as a Controller.`
          : `${node.name} is no longer assigned to ${controller.name}.`;
  } else if (!controllerOnline) {
    tone = "failed";
    faultTarget = "controller";
    headline = connectionLostAfterSuccess
      ? "Connection lost — Controller went offline"
      : "Selected Controller is offline";
    summary = `${controller.name} stopped reporting online status. Bring ${controller.name} back online so ${node.name} can link over ESP-NOW.`;
  } else if (!controllerHasMac && linkState !== "linked" && !inReportedRoster) {
    tone = "failed";
    faultTarget = "controller";
    headline = "Controller MAC address unavailable";
    summary = `${controller.name} has not reported its hardware MAC address yet, so ${node.name} cannot address ESP-NOW frames to it.`;
  } else if (!nodeOnline) {
    tone = "failed";
    faultTarget = "node";
    headline = connectionLostAfterSuccess
      ? "Connection lost — Node went offline"
      : !nodeConfigSynced
        ? "Node went offline before applying configuration"
        : "Node is offline";
    summary = !nodeConfigSynced
      ? `${node.name} went offline before acknowledging the updated role configuration.`
      : `${node.name} is currently offline and has not reported a fresh heartbeat or Controller roster entry.`;
  } else if (channelMismatch) {
    tone = "failed";
    faultTarget = "espnow_link";
    headline = "ESP-NOW Wi-Fi channel mismatch";
    summary = `${node.name} is operating on channel ${nodeChannel} while ${controller.name} is on channel ${ctrlChannel}. Both boards must share a 2.4 GHz channel to exchange ESP-NOW frames.`;
  } else if (linkState === "standalone") {
    tone = "degraded";
    faultTarget = "espnow_link";
    headline = connectionLostAfterSuccess
      ? "ESP-NOW link lost — running standalone Wi-Fi/MQTT fallback"
      : "Node fell back to standalone Wi-Fi/MQTT";
    summary = `${node.name} did not receive a Controller ACK within the 45s ESP-NOW window and opened its own Wi-Fi/MQTT fallback session while continuing to probe ${controller.name} every 15s.`;
  } else if (linkState === "controller_lost") {
    tone = "failed";
    faultTarget = "espnow_link";
    headline = connectionLostAfterSuccess
      ? "Connection lost — Controller unreachable over ESP-NOW"
      : "Node lost ESP-NOW contact with Controller";
    summary = controllerHeardNode
      ? `${controller.name} heard a keepalive from ${node.name}, but ${node.name} has not confirmed ${controller.name}'s ACK (missed the 10s link timeout).`
      : `${node.name} missed ESP-NOW acknowledgements from ${controller.name} past the 10s link timeout and is retrying before the 45s fallback window.`;
  } else if (linkState === "linked" && commMode === "espnow" && inControllerRoster && !controllerMqttHealthy) {
    tone = "degraded";
    faultTarget = "cloud_link";
    headline = "ESP-NOW linked, but Controller MQTT is disconnected";
    summary = `${node.name} and ${controller.name} are communicating over ESP-NOW, but ${controller.name}'s MQTT session to HomecoreOS is disconnected so cloud relay is degraded.`;
  } else if (linkState === "linked" && commMode === "espnow" && !inControllerRoster) {
    tone = "waiting";
    faultTarget = null;
    headline = "Waiting for Controller roster confirmation…";
    summary = `${node.name} confirmed an ESP-NOW link to ${controller.name}; waiting for ${controller.name}'s next heartbeat to include ${node.name} in its hosted Node roster.`;
  } else if (controllerHeardNode && !nodeAckConfirmed) {
    tone = "waiting";
    faultTarget = null;
    headline = "Controller heard keepalive — confirming Node ACK…";
    summary = `${controller.name} received ${node.name}'s ESP-NOW keepalive and sent an ACK; waiting for ${node.name} to confirm bidirectional link state.`;
  } else if (!nodeConfigSynced) {
    tone = "waiting";
    faultTarget = null;
    headline = "Waiting for Node to apply configuration…";
    summary = waitingOverReconnectWindow
      ? `Still waiting for ${node.name} to acknowledge configuration revision ${revTarget ?? "latest"}. Check that ${node.name} is powered and connected to Wi-Fi, or click Retry Connection.`
      : `Configuration snapshot published to ${node.name}; waiting for revision acknowledgement.`;
  } else {
    tone = "waiting";
    faultTarget = null;
    headline = waitingOverReconnectWindow
      ? "Still waiting for ESP-NOW confirmation from hardware"
      : "Attempting ESP-NOW link…";
    summary = waitingOverReconnectWindow
      ? `The 45s initial reconnect window has elapsed without a confirmed ESP-NOW link report yet. Verify both ESP32 boards are powered within 2.4 GHz range on compatible channels, or click Retry Connection.`
      : `${node.name} is sending 2s ESP-NOW keepalives to ${controller.name}; waiting for bidirectional ACK and roster report.`;
  }

  // Build the 7 truthful lifecycle stages.
  const stages: NodeControllerLifecycleStage[] = [
    {
      id: "save",
      label: "Saving role and Controller assignment",
      detail: assignmentMatches
        ? `Assigned ${node.name} (Node) to ${controller.name}.`
        : "Assignment no longer matches the selected Controller.",
      status: assignmentMatches ? "confirmed" : "failed",
    },
    {
      id: "node_config",
      label: "Waiting for Node to apply updated configuration",
      detail: !assignmentMatches
        ? "Blocked by assignment mismatch."
        : nodeConfigSynced
          ? revSynced
            ? `${node.name} synced configuration revision #${revSynced}.`
            : `${node.name} applied Node role configuration.`
          : !nodeOnline
            ? `${node.name} went offline before acknowledging configuration.`
            : `Waiting for ${node.name} to acknowledge revision ${revTarget ? `#${revTarget}` : "update"}…`,
      status: !assignmentMatches
        ? "failed"
        : nodeConfigSynced
          ? "confirmed"
          : !nodeOnline
            ? "failed"
            : "active",
    },
    {
      id: "controller_ready",
      label: "Waiting for Controller to be ready and discoverable",
      detail: !controllerOnline
        ? `${controller.name} is offline.`
        : !controllerHasMac && linkState !== "linked" && !inReportedRoster
          ? `${controller.name} has not reported its hardware MAC address.`
          : `${controller.name} is online${controllerHasMac ? ` (${controller.hardware_uid})` : ""}${ctrlChannel ? ` · Ch ${ctrlChannel}` : ""}.`,
      status:
        !controllerOnline || (!controllerHasMac && linkState !== "linked" && !inReportedRoster)
          ? "failed"
          : "confirmed",
    },
    {
      id: "espnow_attempt",
      label: "Attempting ESP-NOW link",
      detail: channelMismatch
        ? `Channel mismatch: Node on Ch ${nodeChannel}, Controller on Ch ${ctrlChannel}.`
        : !nodeOnline || !controllerOnline || !assignmentMatches
          ? "Paused until both boards are online and assigned."
          : keepaliveSentOrHeard
            ? `2.4 GHz ESP-NOW frames active${effectiveChannel ? ` on Ch ${effectiveChannel}` : ""}${nodeTel?.keepaliveTxSeq ? ` (keepalive #${nodeTel.keepaliveTxSeq})` : ""}.`
            : linkState === "standalone"
              ? "Initial 45s seek elapsed; probing every 15s from standalone fallback."
              : nodeConfigSynced
                ? "Transmitting 2s ESP-NOW keepalives to Controller…"
                : "Starts as soon as Node applies configuration.",
      status: channelMismatch
        ? "failed"
        : !nodeOnline || !controllerOnline || !assignmentMatches
          ? "pending"
          : keepaliveSentOrHeard
            ? "confirmed"
            : linkState === "standalone"
              ? "warning"
              : nodeConfigSynced
                ? "active"
                : "pending",
    },
    {
      id: "bidirectional_ack",
      label: "Confirming bidirectional Node-Controller communication",
      detail:
        nodeAckConfirmed && inControllerRoster
          ? `Confirmed: ${node.name} is linked over ESP-NOW and listed in ${controller.name}'s Node roster${effectiveRssi !== null ? ` (${effectiveRssi} dBm)` : ""}.`
          : linkState === "standalone"
            ? `${node.name} did not link within 45s and is running standalone over Wi-Fi/MQTT.`
            : linkState === "controller_lost"
              ? controllerHeardNode
                ? `Controller heard keepalive, but ${node.name} has not confirmed Controller ACK.`
                : `Missed Controller ACKs beyond the 10s link timeout.`
              : nodeAckConfirmed && !inControllerRoster
                ? `${node.name} confirmed ACK; waiting for ${controller.name}'s roster report.`
                : controllerHeardNode
                  ? `${controller.name} received keepalive; waiting for ${node.name} ACK confirmation.`
                  : "Waiting for Controller roster reception and Node ACK confirmation.",
      status:
        nodeAckConfirmed && inControllerRoster
          ? "confirmed"
          : linkState === "standalone"
            ? "warning"
            : linkState === "controller_lost"
              ? "failed"
              : keepaliveSentOrHeard || nodeConfigSynced
                ? "active"
                : "pending",
    },
    {
      id: "controller_cloud",
      label: "Verifying Controller cloud / MQTT path",
      detail: !controllerOnline
        ? `${controller.name} is offline — cloud relay unavailable.`
        : controllerMqttHealthy
          ? `${controller.name} has an active HomecoreOS MQTT session (Node intentionally closes its own MQTT when linked).`
          : `${controller.name} is online on Wi-Fi, but its MQTT session to HomecoreOS is disconnected.`,
      status: !controllerOnline
        ? "failed"
        : controllerMqttHealthy
          ? "confirmed"
          : "warning",
    },
    {
      id: "verdict",
      label: connected
        ? "Connected"
        : tone === "degraded"
          ? "Degraded / Fallback"
          : tone === "failed"
            ? connectionLostAfterSuccess
              ? "Connection Lost"
              : "Connection Failed"
            : "Waiting for Hardware Confirmation",
      detail: headline,
      status: connected
        ? "confirmed"
        : tone === "degraded"
          ? "warning"
          : tone === "failed"
            ? "failed"
            : "active",
    },
  ];

  return {
    connected,
    connectionLostAfterSuccess,
    tone,
    faultTarget,
    headline,
    summary,
    nodeOnline,
    controllerOnline,
    controllerMqttHealthy,
    nodeConfigSynced,
    keepaliveSentOrHeard,
    controllerHeardNode,
    nodeAckConfirmed,
    rosterAvailable,
    inControllerRoster,
    channelMismatch,
    effectiveChannel,
    effectiveRssi,
    stages,
  };
}

