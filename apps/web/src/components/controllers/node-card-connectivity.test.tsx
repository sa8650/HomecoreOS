import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NodeCard } from "./NodeCard";
import type { BoardProfileItem, ControllerItem } from "@/features/types";

const board: BoardProfileItem = {
  id: "b1",
  slug: "esp32-c3-devkitm-1",
  manufacturer: "Espressif",
  model: "ESP32-C3-DevKitM-1",
  revision: "1",
  chip_family: "esp32c3",
  chip_variant: "ESP32-C3",
  flash_size_mb: 4,
  psram_size_mb: 0,
  gpio_definitions: [],
  board_layout: null,
};

const node: ControllerItem = {
  id: "n1",
  account_id: "a1",
  home_id: "h1",
  board_profile_id: "b1",
  custom_board_profile_id: null,
  name: "Front Lamp",
  hardware_uid: "AA:BB:CC:DD:EE:02",
  board_model: "ESP32-C3-DevKitM-1",
  chip_variant: "ESP32-C3",
  flash_size_mb: 4,
  psram_size_mb: 0,
  firmware_version: "1.5.0",
  status: "online",
  mqtt_connected: true,
  wifi_ssid: "HomeNet",
  wifi_rssi: -55,
  local_ip: "192.168.1.51",
  last_heartbeat_at: null,
  last_communication_at: null,
  paired_at: "2026-10-01T00:00:00Z",
  connection_history: [],
  board_role: "node",
  node_comm_mode: "wifi_mqtt",
  node_link_state: "searching" as never,
  assigned_controller_id: "c1",
  assigned_controller_name: "Living Hub",
  binding_state: "assigned",
  binding_generation: 3,
  cloud_route: "direct_node_mqtt",
  connection_status: "Connected directly",
};

describe("NodeCard connectivity UX", () => {
  it("shows an accurate user status and a separate binding state", () => {
    render(
      <NodeCard
        node={node}
        board={board}
        canManage
        canOperate
        timezone="UTC"
        onViewDetails={vi.fn()}
        onRename={vi.fn()}
        onAssignController={vi.fn()}
        onRelink={vi.fn()}
        onPromote={vi.fn()}
      />
    );
    expect(screen.getByText("Connected directly")).toBeTruthy();
    expect(screen.getByText("Assigned · not verified")).toBeTruthy();
  });

  it("never advertises a Controller cloud badge when only ESP-NOW is active", () => {
    render(
      <NodeCard
        node={{
          ...node,
          connection_status: "Local connection active",
          cloud_route: "unavailable",
          node_comm_mode: "espnow",
        }}
        board={board}
        canManage
        canOperate
        timezone="UTC"
        onViewDetails={vi.fn()}
        onRename={vi.fn()}
        onAssignController={vi.fn()}
        onRelink={vi.fn()}
        onPromote={vi.fn()}
      />
    );
    expect(screen.getByText("Local connection active")).toBeTruthy();
    expect(screen.queryByText("Connected through Controller")).toBeNull();
  });
});
