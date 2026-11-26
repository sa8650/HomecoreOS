import { describe, expect, it } from "vitest";
import {
  BOARD_CAPABILITIES,
  BOARD_CAPABILITY_IDS,
  bindingBlocker,
  canClosePreviousRoute,
  getBoardCapabilities,
  maxHostedNodes,
  requiresExternalWirelessCompanion,
  selectCloudRoute,
  supportsProvisioning,
  supportsRole,
  supportsTransport,
  userConnectionStatus,
  type CloudRouteState,
} from "../src";

describe("canonical board capability registry", () => {
  it("covers every board profile in the repository with an explicit entry", () => {
    expect(BOARD_CAPABILITY_IDS).toHaveLength(22);
    expect(new Set(BOARD_CAPABILITY_IDS).size).toBe(BOARD_CAPABILITY_IDS.length);
    const expected = [
      "esp32-s3-devkitc-1-n16r8",
      "esp32-s3-devkitc-1-v1-0",
      "seeed-xiao-esp32s3",
      "seeed-xiao-esp32s3-sense",
      "seeed-xiao-esp32s3-plus",
      "waveshare-esp32-s3-zero",
      "waveshare-esp32-s3-pico",
      "waveshare-esp32-s3-relay-6ch",
      "esp32-devkitc-v4",
      "esp32-s2-devkitc-1",
      "esp32-c3-devkitm-1",
      "seeed-xiao-esp32c3",
      "waveshare-esp32-c3-zero",
      "esp32-c6-devkitc-1",
      "seeed-xiao-esp32c6",
      "waveshare-esp32-c6-zero",
      "esp32-c5-devkitc-1",
      "seeed-xiao-esp32c5",
      "esp32-c61-devkitc-1",
      "esp8684-devkitm-1",
      "esp32-h2-devkitm-1",
      "nodemcu-esp8266",
    ];
    for (const id of expected) expect(BOARD_CAPABILITIES[id]).toBeDefined();
  });

  it("does not infer capabilities for unknown board IDs", () => {
    expect(getBoardCapabilities("my-custom-board")).toBeNull();
    expect(supportsRole("my-custom-board", "controller")).toBe(false);
    expect(supportsTransport("my-custom-board", "espnow")).toBe(false);
    expect(bindingBlocker("my-custom-board", "node")).toContain("no verified capability profile");
    expect(userConnectionStatus({ boardId: "my-custom-board" })).toBe(
      "Device not supported for this connection method"
    );
  });

  it("keeps ESP32-H2 outside the Wi-Fi Controller/Node architecture", () => {
    const h2 = getBoardCapabilities("esp32-h2-devkitm-1")!;
    expect(h2.radio.wifi).toBe(false);
    expect(h2.radio.espnow).toBe(false);
    expect(h2.roles.supported).toEqual([]);
    expect(h2.transports).toEqual([]);
    expect(h2.support.status).toBe("unsupported");
    expect(bindingBlocker("esp32-h2-devkitm-1", "node")).not.toBeNull();
  });

  it("keeps ESP8266 on direct MQTT with no Controller role and no ESP-NOW", () => {
    const esp8266 = getBoardCapabilities("nodemcu-esp8266")!;
    expect(esp8266.radio.wifi).toBe(true);
    expect(esp8266.radio.mqtt).toBe(true);
    expect(esp8266.radio.espnow).toBe(false);
    expect(esp8266.roles.supported).toEqual(["node"]);
    expect(supportsRole("nodemcu-esp8266", "controller")).toBe(false);
    expect(supportsTransport("nodemcu-esp8266", "espnow")).toBe(false);
    expect(supportsProvisioning("nodemcu-esp8266", "ble")).toBe(false);
    expect(supportsProvisioning("nodemcu-esp8266", "softap")).toBe(true);
    expect(esp8266.limits.max_tested_controller_nodes).toBe(0);
  });

  it("records explicit SDK targets and resource limits per board", () => {
    const c5 = getBoardCapabilities("esp32-c5-devkitc-1")!;
    expect(c5.firmware.sdk_version).toBe("esp-idf v5.5.2");
    expect(c5.firmware.framework).toBe("esp_idf");
    expect(c5.memory.psram_mb).toBe(8);
    expect(c5.radio.espnow_mtu_bytes).toBe(250);
    expect(c5.limits.keepalive_ms).toBe(2000);
    expect(c5.limits.link_timeout_ms).toBe(10000);
    expect(c5.limits.recovery_window_ms).toBe(45000);
    expect(c5.limits.discovery_interval_ms).toBe(15000);
    expect(maxHostedNodes("esp32-c5-devkitc-1")).toBe(8);
    expect(maxHostedNodes("esp32-h2-devkitm-1")).toBe(0);
  });

  it("requires an external companion for P4-class silicon", () => {
    expect(requiresExternalWirelessCompanion("esp32p4")).toBe(true);
    expect(requiresExternalWirelessCompanion("esp32s3")).toBe(false);
  });

  it("never claims physical testing or a tested node count", () => {
    for (const board of Object.values(BOARD_CAPABILITIES)) {
      expect(board.limits.max_tested_controller_nodes).toBe(0);
      expect(board.support.hardware_tested).toBe(false);
    }
  });
});

describe("route policy", () => {
  it("prefers a healthy Controller relay but keeps direct MQTT available", () => {
    expect(
      selectCloudRoute({
        telemetryFresh: true,
        nodeMqttHealthy: true,
        controllerMqttHealthy: true,
        espnowLinked: true,
        inRoster: true,
      })
    ).toBe("controller_mqtt");
    expect(
      selectCloudRoute({
        telemetryFresh: true,
        nodeMqttHealthy: true,
        controllerMqttHealthy: false,
        espnowLinked: true,
        inRoster: true,
      })
    ).toBe("direct_node_mqtt");
  });

  it("only closes a route after the replacement is confirmed", () => {
    const current: CloudRouteState = "direct_node_mqtt";
    expect(
      canClosePreviousRoute({ current, next: "controller_mqtt", nextReady: true, confirmed: false })
    ).toBe(false);
    expect(
      canClosePreviousRoute({ current, next: "controller_mqtt", nextReady: true, confirmed: true })
    ).toBe(true);
  });
});
