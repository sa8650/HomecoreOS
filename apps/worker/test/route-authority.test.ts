import { describe, expect, it } from "vitest";
import {
  commandIdentity,
  decideNodeRoute,
  isTelemetryFresh,
  type RouteAuthorityRow,
} from "../src/lib/route-authority";

const now = new Date().toISOString();
const node: RouteAuthorityRow = {
  id: "node-1",
  board_role: "node",
  assigned_controller_id: "ctrl-1",
  binding_id: "binding-1",
  binding_state: "verified",
  binding_generation: 4,
  status: "online",
  mqtt_connected: true,
  last_communication_at: now,
};
const controller: RouteAuthorityRow = {
  id: "ctrl-1",
  board_role: "controller",
  status: "online",
  mqtt_connected: true,
  last_communication_at: now,
  espnow_telemetry: {
    roster: [{ id: "node-1", link: "linked", gen: 4, bid: "binding-1" }],
  },
};

describe("Worker route authority", () => {
  it("requires fresh telemetry", () => {
    expect(isTelemetryFresh(node)).toBe(true);
    expect(isTelemetryFresh({ ...node, last_communication_at: undefined })).toBe(false);
  });

  it("relays only with a verified, generation-matched roster and healthy Controller MQTT", () => {
    const decision = decideNodeRoute({ node, controller, nodeId: node.id });
    expect(decision.route).toBe("controller_mqtt");
    expect(decision.relayControllerId).toBe("ctrl-1");

    const staleGeneration = decideNodeRoute({
      node,
      controller: {
        ...controller,
        espnow_telemetry: { roster: [{ id: "node-1", link: "linked", gen: 3 }] },
      },
      nodeId: node.id,
    });
    expect(staleGeneration.route).toBe("direct_node_mqtt");
    expect(staleGeneration.reasons).toContain("binding_generation_mismatch");

    const offlineCloud = decideNodeRoute({
      node,
      controller: { ...controller, mqtt_connected: false },
      nodeId: node.id,
    });
    expect(offlineCloud.route).toBe("direct_node_mqtt");
  });

  it("uses direct MQTT while the ESP-NOW link is only searching", () => {
    const decision = decideNodeRoute({
      node,
      controller: { ...controller, espnow_telemetry: { roster: [] } },
      nodeId: node.id,
    });
    expect(decision.route).toBe("direct_node_mqtt");
  });

  it("defers when no route is healthy", () => {
    const decision = decideNodeRoute({
      node: { ...node, mqtt_connected: false },
      controller: { ...controller, mqtt_connected: false },
      nodeId: node.id,
    });
    expect(decision.route).toBe("unavailable");
    expect(decision.relayControllerId).toBeNull();
  });

  it("keeps command identity stable across a failover", () => {
    const payload = { switch_id: "s1", state: "on" };
    expect(commandIdentity(payload)).toBe(commandIdentity({ ...payload }));
    expect(commandIdentity({ ...payload, command_id: "fixed" })).toBe("fixed");
  });
});
