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
    board_catalog_id: "b1",
    custom_board_id: null,
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
    controller_id: "c1",
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
    controller_id: "c1",
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
    controller_id: "c1",
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

    expect(screen.getByText("Living Hub")).toBeInTheDocument();
    expect(screen.getAllByText(/ESP32-S3-N16R8/).length).toBeGreaterThan(0);
    expect(screen.getByText("Porch Light")).toBeInTheDocument();
    expect(screen.getByText("GPIO 12")).toBeInTheDocument();
    expect(screen.getByText("GPIO 14")).toBeInTheDocument();
    // I²C address from the stored relationship — never invented
    expect(screen.getByText("I2C · 0x76")).toBeInTheDocument();
    expect(screen.getByText("Living Room")).toBeInTheDocument();
    expect(screen.getByText("1 switch · 1 device · 1 sensor")).toBeInTheDocument();
  });

  it("selecting a controller highlights it and dims the other stations", async () => {
    const user = userEvent.setup();
    render(
      <ControllerWiringPreview
        controllers={[
          makeController({ id: "c1", name: "Alpha Hub" }),
          makeController({ id: "c2", name: "Beta Hub" }),
        ]}
        switches={[makeSwitch({ controller_id: "c1" })]}
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
