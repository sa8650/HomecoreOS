import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ControllerWiringPreview } from "./ControllerWiringPreview";
import type {
  ControllerItem,
  DeviceItem,
  SensorItem,
  SwitchItem,
} from "@/features/types";

function makeController(overrides: Partial<ControllerItem> = {}): ControllerItem {
  return {
    id: "c1",
    account_id: "a1",
    home_id: "h1",
    board_profile_id: "b1",
    custom_board_profile_id: null,
    name: "Living Hub",
    hardware_uid: "esp-1",
    board_model: "ESP32-S3-N16R8",
    chip_variant: "ESP32-S3",
    flash_size_mb: 16,
    psram_size_mb: 8,
    firmware_version: "1.2.0",
    status: "online",
    mqtt_connected: true,
    wifi_ssid: "HomeNet",
    wifi_rssi: -52,
    local_ip: "192.168.1.40",
    last_heartbeat_at: null,
    last_communication_at: null,
    paired_at: "2026-10-01T00:00:00Z",
    connection_history: [],
    ...overrides,
  };
}

function makeSwitch(overrides: Partial<SwitchItem> = {}): SwitchItem {
  return {
    id: "sw1",
    account_id: "a1",
    home_id: "h1",
    room_id: "r1",
    board_instance_id: "c1",
    name: "Porch Light",
    gpio_pin: 12,
    is_on: true,
    inverted: false,
    is_online: true,
    last_changed_at: null,
    ...overrides,
  };
}

function makeDevice(overrides: Partial<DeviceItem> = {}): DeviceItem {
  return {
    id: "d1",
    account_id: "a1",
    home_id: "h1",
    room_id: "r1",
    board_instance_id: "c1",
    name: "Ceiling Fan",
    device_type: "fan",
    gpio_pin: 14,
    state: "on",
    is_online: true,
    ...overrides,
  };
}

function makeSensor(overrides: Partial<SensorItem> = {}): SensorItem {
  return {
    id: "s1",
    account_id: "a1",
    home_id: "h1",
    room_id: "r1",
    board_instance_id: "c1",
    name: "Lab Temp",
    sensor_type: "temperature_bme280",
    gpio_pin: null,
    i2c_address: "0x76",
    unit: "°C",
    last_value: 23.1,
    last_raw_payload: { i2c_address: "0x76" },
    is_online: true,
    last_reading_at: "2026-11-16T00:00:00Z",
    ...overrides,
  };
}

describe("ControllerWiringPreview", () => {
  it("renders each controller with board info, GPIO pins, and I²C addresses", () => {
    render(
      <ControllerWiringPreview
        controllers={[makeController({ room_id: "r1" })]}
        switches={[makeSwitch()]}
        devices={[makeDevice()]}
        sensors={[makeSensor()]}
        rooms={[
          {
            id: "r1",
            account_id: "a1",
            home_id: "h1",
            name: "Living Room",
            icon: "RiHomeLine",
            floor_order: 0,
            grid_col_span: 1,
          },
        ]}
      />
    );

    expect(screen.getAllByText("Living Hub").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ESP32-S3-N16R8/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Porch Light").length).toBeGreaterThan(0);
    expect(screen.getAllByText("GPIO 12").length).toBeGreaterThan(0);
    expect(screen.getAllByText("GPIO 14").length).toBeGreaterThan(0);
    // I²C address from the stored relationship — never invented
    expect(screen.getAllByText("I2C · 0x76").length).toBeGreaterThan(0);
    expect(screen.getByText("Living Room")).toBeInTheDocument();
    expect(screen.getByText("1 switch · 1 device · 1 sensor")).toBeInTheDocument();
    expect(screen.getByTestId("blueprint-wiring-map")).toBeInTheDocument();
  });

  it("renders the blueprint floor map with controllers, ESP-NOW nodes, and room wiring", async () => {
    const user = userEvent.setup();
    render(
      <ControllerWiringPreview
        controllers={[
          makeController({ id: "c1", name: "Main Controller", board_role: "controller", room_id: "r1" }),
          makeController({
            id: "n1",
            name: "Kitchen Node",
            board_role: "node",
            assigned_controller_id: "c1",
            node_link_state: "linked",
            espnow_channel: 6,
            room_id: "r2",
          }),
        ]}
        switches={[makeSwitch({ id: "sw-k", board_instance_id: "n1", room_id: "r2", name: "Sink Light", gpio_pin: 5 })]}
        devices={[makeDevice({ id: "d-l", board_instance_id: "c1", room_id: "r1", name: "Main Fan", gpio_pin: 14 })]}
        sensors={[makeSensor({ id: "s-k", board_instance_id: "n1", room_id: "r2", name: "Air Temp" })]}
        rooms={[
          {
            id: "r1",
            account_id: "a1",
            home_id: "h1",
            name: "Living Room",
            icon: "RiHomeLine",
            floor_order: 0,
            grid_col_span: 1,
            floor_x: 0,
            floor_y: 0,
            floor_w: 320,
            floor_h: 240,
          },
          {
            id: "r2",
            account_id: "a1",
            home_id: "h1",
            name: "Kitchen",
            icon: "RiHomeLine",
            floor_order: 1,
            grid_col_span: 1,
            floor_x: 320,
            floor_y: 0,
            floor_w: 280,
            floor_h: 240,
          },
        ]}
      />
    );

    const blueprint = screen.getByTestId("blueprint-wiring-map");
    expect(blueprint).toBeInTheDocument();
    expect(screen.getByTestId("blueprint-board-c1")).toBeInTheDocument();
    expect(screen.getByTestId("blueprint-board-n1")).toBeInTheDocument();
    expect(screen.getByText("ESP-NOW CH6")).toBeInTheDocument();
    expect(screen.getByText("LIVING ROOM")).toBeInTheDocument();
    expect(screen.getByText("KITCHEN")).toBeInTheDocument();

    // Clicking the Node on the blueprint isolates it in the station grid too
    await user.click(screen.getByTestId("blueprint-board-n1"));
    expect(screen.getByTestId("controller-station-n1")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("controller-station-c1").className).toContain("opacity-45");
  });

  it("selecting a controller highlights it and dims the other stations", async () => {
    const user = userEvent.setup();
    render(
      <ControllerWiringPreview
        controllers={[
          makeController({ id: "c1", name: "Alpha Hub" }),
          makeController({ id: "c2", name: "Beta Hub" }),
        ]}
        switches={[makeSwitch({ board_instance_id: "c1" })]}
        devices={[]}
        sensors={[]}
      />
    );

    const alpha = screen.getByTestId("controller-station-c1");
    const beta = screen.getByTestId("controller-station-c2");
    expect(alpha).toHaveAttribute("aria-pressed", "false");

    await user.click(alpha);
    expect(alpha).toHaveAttribute("aria-pressed", "true");
    expect(beta.className).toContain("opacity-45");

    // Clicking again clears the isolation
    await user.click(alpha);
    expect(alpha).toHaveAttribute("aria-pressed", "false");
    expect(beta.className).not.toContain("opacity-45");
  });

  it("distinguishes offline and disconnected controllers", () => {
    render(
      <ControllerWiringPreview
        controllers={[
          makeController({ id: "c1", name: "Offline Hub", status: "offline" }),
          makeController({ id: "c2", name: "Dead Hub", status: "disconnected" }),
        ]}
        switches={[]}
        devices={[]}
        sensors={[]}
      />
    );

    expect(screen.getAllByText("Offline").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Disconnected").length).toBeGreaterThan(0);
    // Per-controller empty wiring note, not a fabricated diagram
    expect(screen.getAllByText(/No switches, devices, or sensors linked yet/)).toHaveLength(2);
  });

  it("shows an empty state when the account has no controllers", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <ControllerWiringPreview
        controllers={[]}
        switches={[]}
        devices={[]}
        sensors={[]}
        onNavigate={onNavigate}
      />
    );

    expect(screen.getByText("No controllers yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Go to Controllers/i }));
    expect(onNavigate).toHaveBeenCalledWith("/controllers");
  });
});
