import { describe, expect, it } from "vitest";
import {
  boardSupportsControllerRole,
  boardSupportsEspNow,
  canAssignNodeToController,
  deriveCommMode,
  deviceRoleLabel,
  deviceStatusLabel,
  isNodeStandalone,
  nodeCommModeLabel,
  normalizeDeviceRole,
  normalizeNodeLinkState,
  roleChangeBlocker,
} from "../src/device-role";

describe("device roles", () => {
  it("treats legacy rows without a stored role as Controllers", () => {
    expect(normalizeDeviceRole(null)).toBe("controller");
    expect(normalizeDeviceRole(undefined)).toBe("controller");
    expect(normalizeDeviceRole("")).toBe("controller");
    expect(normalizeDeviceRole("controller")).toBe("controller");
    expect(normalizeDeviceRole("node")).toBe("node");
    expect(normalizeDeviceRole("NODE")).toBe("controller");
    expect(normalizeNodeLinkState("nonsense")).toBe("unassigned");
    expect(normalizeNodeLinkState("standalone")).toBe("standalone");
  });

  it("labels roles and communication modes", () => {
    expect(deviceRoleLabel("controller")).toBe("Controller");
    expect(deviceRoleLabel("node")).toBe("Node");
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
  });

  it("only assigns Nodes to an online Controller in the same home", () => {
    const base = {
      nodeId: "node-1",
      controllerId: "ctrl-1",
      controllerRole: "controller" as const,
      controllerOnline: true,
      sameHome: true,
    };
    expect(canAssignNodeToController(base)).toEqual({ ok: true });
    expect(canAssignNodeToController({ ...base, controllerId: "node-1" })).toMatchObject({
      ok: false,
    });
    expect(canAssignNodeToController({ ...base, controllerOnline: false })).toMatchObject({
      ok: false,
    });
    expect(canAssignNodeToController({ ...base, sameHome: false })).toMatchObject({ ok: false });
    expect(
      canAssignNodeToController({
        ...base,
        controllerId: "other-node",
        controllerRole: "node",
      })
    ).toMatchObject({ ok: false });
  });
});
