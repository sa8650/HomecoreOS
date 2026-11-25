import { describe, expect, it } from "vitest";
import {
  ESPNOW_CONTROLLER_PROBE_MS,
  ESPNOW_HEARTBEAT_INTERVAL_MS,
  ESPNOW_LINK_TIMEOUT_MS,
  ESPNOW_NODE_STALE_MS,
  ESPNOW_RECONNECT_WINDOW_MS,
  boardSupportsControllerRole,
  boardSupportsEspNow,
  canAssignNodeToController,
  deriveCommMode,
  boardRoleLabel,
  deviceStatusLabel,
  isNodeStandalone,
  nodeCommModeLabel,
  normalizeBoardRole,
  normalizeNodeLinkState,
  roleChangeBlocker,
  evaluateNodeControllerLink,
} from "../src/board-role";

describe("device roles", () => {
  it("pins the ESP-NOW timing contract mirrored by firmware/main/role_logic.h", () => {
    // These values are the shared half of the firmware contract: the Node
    // heartbeats every 2 s, a 10 s silence drops the link, a Node keeps retrying
    // its Controller for 45 s before the Wi-Fi/MQTT fallback, probes it every
    // 15 s while standalone, and a Controller calls a Node stale after 20 s.
    expect(ESPNOW_HEARTBEAT_INTERVAL_MS).toBe(2_000);
    expect(ESPNOW_LINK_TIMEOUT_MS).toBe(10_000);
    expect(ESPNOW_RECONNECT_WINDOW_MS).toBe(45_000);
    expect(ESPNOW_CONTROLLER_PROBE_MS).toBe(15_000);
    expect(ESPNOW_NODE_STALE_MS).toBe(20_000);
  });

  it("treats legacy rows without a stored role as Controllers", () => {
    expect(normalizeBoardRole(null)).toBe("controller");
    expect(normalizeBoardRole(undefined)).toBe("controller");
    expect(normalizeBoardRole("")).toBe("controller");
    expect(normalizeBoardRole("controller")).toBe("controller");
    expect(normalizeBoardRole("node")).toBe("node");
    expect(normalizeBoardRole("NODE")).toBe("controller");
    expect(normalizeNodeLinkState("nonsense")).toBe("unassigned");
    expect(normalizeNodeLinkState("standalone")).toBe("standalone");
  });

  it("labels roles and communication modes", () => {
    expect(boardRoleLabel("controller")).toBe("Controller");
    expect(boardRoleLabel("node")).toBe("Node");
    expect(nodeCommModeLabel("espnow")).toBe("ESP-NOW");
    expect(nodeCommModeLabel("wifi_mqtt")).toBe("Wi-Fi / MQTT");
    expect(nodeCommModeLabel(null)).toBe("Unknown");
  });

  it("never describes a standalone Node as a Controller", () => {
    expect(
      deviceStatusLabel({
        role: "node",
        online: true,
        commMode: "wifi_mqtt",
        linkState: "standalone",
        assignedControllerName: "Living Room Hub",
      })
    ).toBe("Standalone Node — Controller Disconnected");

    expect(
      deviceStatusLabel({
        role: "node",
        online: true,
        commMode: "espnow",
        linkState: "linked",
        assignedControllerName: "Living Room Hub",
      })
    ).toBe("Linked to Living Room Hub");

    // A lost or reconnecting link must never be shown as "Linked", even when the
    // last roster report still says `espnow`.
    expect(
      deviceStatusLabel({
        role: "node",
        online: true,
        commMode: "espnow",
        linkState: "controller_lost",
        assignedControllerName: "Living Room Hub",
      })
    ).toBe("Standalone Node — Controller Disconnected");
    expect(
      deviceStatusLabel({
        role: "node",
        online: true,
        commMode: "espnow",
        linkState: "reconnecting",
      })
    ).toBe("Standalone Node — Controller Disconnected");
    expect(
      deviceStatusLabel({ role: "node", online: true, linkState: "unassigned" })
    ).toBe("No Controller assigned");

    expect(deviceStatusLabel({ role: "controller", online: true })).toBe("Online");
    expect(deviceStatusLabel({ role: "node", online: false })).toBe("Offline");
    expect(isNodeStandalone({ role: "node", commMode: "wifi_mqtt" })).toBe(true);
    expect(isNodeStandalone({ role: "node", linkState: "reconnecting" })).toBe(true);
    expect(isNodeStandalone({ role: "node", commMode: "espnow" })).toBe(false);
    expect(isNodeStandalone({ role: "controller", commMode: "wifi_mqtt" })).toBe(false);
  });

  it("derives the reported communication mode from link state", () => {
    expect(
      deriveCommMode({ role: "controller", online: true, mqttConnected: true })
    ).toBe("wifi_mqtt");
    expect(deriveCommMode({ role: "node", online: true, espNowLinked: true })).toBe("espnow");
    expect(
      deriveCommMode({ role: "node", online: true, espNowLinked: false, mqttConnected: true })
    ).toBe("wifi_mqtt");
    expect(
      deriveCommMode({ role: "node", online: true, espNowLinked: false, mqttConnected: false })
    ).toBe("offline");
    expect(deriveCommMode({ role: "node", online: false })).toBe("offline");
  });

  it("gates ESP-NOW and the Controller role on the board profile", () => {
    expect(boardSupportsEspNow({ chip_family: "esp32s3", supports_wifi: true })).toBe(true);
    expect(boardSupportsEspNow({ chip_family: "esp32c3" })).toBe(true);
    expect(boardSupportsEspNow({ chip_family: "esp32h2", supports_wifi: false })).toBe(false);
    expect(boardSupportsEspNow({ chip_family: "esp8266" })).toBe(false);
    expect(boardSupportsEspNow({ chip_family: "esp32s3", supports_wifi: false })).toBe(false);
    expect(boardSupportsEspNow(null)).toBe(false);
    expect(boardSupportsControllerRole({ chip_family: "esp32s3" })).toBe(true);
    expect(boardSupportsControllerRole({ chip_family: "esp32h2" })).toBe(false);
  });

  it("blocks demoting a Controller that still hosts Nodes until it is acknowledged", () => {
    const blocked = roleChangeBlocker({
      targetRole: "node",
      currentRole: "controller",
      boardSupported: true,
      attachedNodeCount: 2,
    });
    expect(blocked?.code).toBe("attached_nodes");
    expect(blocked && "attachedNodeCount" in blocked ? blocked.attachedNodeCount : null).toBe(2);

    expect(
      roleChangeBlocker({
        targetRole: "node",
        currentRole: "controller",
        boardSupported: true,
        attachedNodeCount: 2,
        acknowledgeAttachedNodes: true,
      })
    ).toBeNull();

    // Promoting an idle Node, or re-applying the current role, is always allowed.
    expect(
      roleChangeBlocker({
        targetRole: "controller",
        currentRole: "node",
        boardSupported: true,
        attachedNodeCount: 0,
      })
    ).toBeNull();
    expect(
      roleChangeBlocker({
        targetRole: "controller",
        currentRole: "controller",
        boardSupported: false,
        attachedNodeCount: 0,
      })
    ).toBeNull();

    expect(
      roleChangeBlocker({
        targetRole: "controller",
        currentRole: "node",
        boardSupported: false,
        attachedNodeCount: 0,
      })?.code
    ).toBe("board_unsupported");

    // The refusal explains the role that was actually requested.
    const promoteBlocker = roleChangeBlocker({
      targetRole: "controller",
      currentRole: "node",
      boardSupported: false,
      attachedNodeCount: 0,
    });
    expect(promoteBlocker?.message).toMatch(/Controller role/i);
    const demoteBlocker = roleChangeBlocker({
      targetRole: "node",
      currentRole: "controller",
      boardSupported: false,
      attachedNodeCount: 0,
    });
    expect(demoteBlocker?.message).toMatch(/Node role/i);
  });

  it("only assigns Nodes to an online Controller in the same home", () => {
    const base = {
      nodeId: "node-1",
      boardInstanceId: "ctrl-1",
      controllerRole: "controller" as const,
      controllerOnline: true,
      sameHome: true,
    };
    expect(canAssignNodeToController(base)).toEqual({ ok: true });
    expect(canAssignNodeToController({ ...base, boardInstanceId: "node-1" })).toMatchObject({
      ok: false,
    });
    expect(canAssignNodeToController({ ...base, controllerOnline: false })).toMatchObject({
      ok: false,
    });
    expect(canAssignNodeToController({ ...base, sameHome: false })).toMatchObject({ ok: false });
    expect(
      canAssignNodeToController({
        ...base,
        boardInstanceId: "other-node",
        controllerRole: "node",
      })
    ).toMatchObject({ ok: false });
  });

  it("evaluates Node-Controller ESP-NOW verification strictly from real hardware state", () => {
    const baseNode = {
      id: "node-1",
      name: "Hallway Node",
      status: "online",
      board_role: "node" as const,
      assigned_controller_id: "ctrl-1",
      node_comm_mode: "espnow" as const,
      node_link_state: "reconnecting" as const,
      config_revision: 5,
      last_synced_config_revision: 4,
      pending_config_sync: true,
    };
    const baseCtrl = {
      id: "ctrl-1",
      name: "Living Hub",
      status: "online",
      board_role: "controller" as const,
      hardware_uid: "AA:BB:CC:DD:EE:01",
      mqtt_connected: true,
      wifi_connected: true,
      connected_node_count: 1, // another Node may be connected — must NOT fool verification!
      reported_nodes: [{ id: "other-node", link: "linked" as const, rssi: -60, channel: 6 }],
    };

    // 1. Waiting for Node config sync: never claims connected.
    const waitingCfg = evaluateNodeControllerLink({
      node: baseNode,
      controller: baseCtrl,
    });
    expect(waitingCfg.connected).toBe(false);
    expect(waitingCfg.tone).toBe("waiting");
    expect(waitingCfg.stages.find((s) => s.id === "node_config")?.status).toBe("active");

    // 2. Node reports linked, but Controller's reported_nodes only contains OTHER node:
    // connected_node_count === 1 alone MUST NOT mark connected!
    const waitingRoster = evaluateNodeControllerLink({
      node: {
        ...baseNode,
        node_link_state: "linked",
        last_synced_config_revision: 5,
        pending_config_sync: false,
      },
      controller: baseCtrl,
    });
    expect(waitingRoster.connected).toBe(false);
    expect(waitingRoster.inControllerRoster).toBe(false);
    expect(waitingRoster.tone).toBe("waiting");

    // 3. Full bidirectional hardware + Controller roster + Controller MQTT confirmation -> connected!
    const connected = evaluateNodeControllerLink({
      node: {
        ...baseNode,
        node_link_state: "linked",
        last_synced_config_revision: 5,
        pending_config_sync: false,
        espnow_telemetry: { keepaliveTxSeq: 2, ackRxSeq: 2, ackConfirmed: true, rssi: -49, channel: 6 },
      },
      controller: {
        ...baseCtrl,
        reported_nodes: [
          { id: "other-node", link: "linked", rssi: -60, channel: 6 },
          { id: "node-1", link: "linked", rssi: -48, channel: 6, seq: 2 },
        ],
      },
    });
    expect(connected.connected).toBe(true);
    expect(connected.tone).toBe("connected");
    expect(connected.inControllerRoster).toBe(true);
    expect(connected.effectiveChannel).toBe(6);
    expect(connected.effectiveRssi).toBe(-48);

    // 4. Controller MQTT drops while ESP-NOW stays linked -> degraded (amber), NOT green connected!
    const mqttDown = evaluateNodeControllerLink({
      node: {
        ...baseNode,
        node_link_state: "linked",
        last_synced_config_revision: 5,
        pending_config_sync: false,
      },
      controller: {
        ...baseCtrl,
        mqtt_connected: false,
        reported_nodes: [{ id: "node-1", link: "linked", rssi: -48, channel: 6 }],
      },
    });
    expect(mqttDown.connected).toBe(false);
    expect(mqttDown.tone).toBe("degraded");
    expect(mqttDown.faultTarget).toBe("cloud_link");

    // 5. Standalone Wi-Fi/MQTT fallback -> degraded (amber), never ESP-NOW connected!
    const standalone = evaluateNodeControllerLink({
      node: {
        ...baseNode,
        node_comm_mode: "wifi_mqtt",
        node_link_state: "standalone",
        last_synced_config_revision: 5,
        pending_config_sync: false,
      },
      controller: baseCtrl,
    });
    expect(standalone.connected).toBe(false);
    expect(standalone.tone).toBe("degraded");
    expect(standalone.faultTarget).toBe("espnow_link");

    // 6. Live disconnect after previous connected state -> connectionLostAfterSuccess!
    const lost = evaluateNodeControllerLink({
      node: {
        ...baseNode,
        node_link_state: "controller_lost",
        last_synced_config_revision: 5,
        pending_config_sync: false,
      },
      controller: { ...baseCtrl, reported_nodes: [] },
      wasEverConnected: true,
    });
    expect(lost.connected).toBe(false);
    expect(lost.connectionLostAfterSuccess).toBe(true);
    expect(lost.tone).toBe("failed");
    expect(lost.faultTarget).toBe("espnow_link");

    // 7. Missing Controller MAC -> failed with controller faultTarget.
    const missingMac = evaluateNodeControllerLink({
      node: {
        ...baseNode,
        last_synced_config_revision: 5,
        pending_config_sync: false,
      },
      controller: { ...baseCtrl, hardware_uid: null, reported_nodes: [] },
    });
    expect(missingMac.connected).toBe(false);
    expect(missingMac.tone).toBe("failed");
    expect(missingMac.faultTarget).toBe("controller");
  });
});
