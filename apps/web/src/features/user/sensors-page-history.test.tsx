import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiCache } from "@/lib/api";
import { TimezoneContext } from "@/lib/timezone";
import { SensorsPage } from "./DevicesSwitchesSensorsPages";
import type { ControllerItem } from "@/features/types";

const originalFetch = globalThis.fetch;

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const controller: Partial<ControllerItem> = {
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
  firmware_version: "1.4.0",
  status: "online",
  mqtt_connected: true,
  wifi_ssid: "HomeNet",
  wifi_rssi: -50,
  local_ip: "192.168.1.40",
  last_heartbeat_at: null,
  last_communication_at: null,
  paired_at: "2026-10-01T00:00:00Z",
  connection_history: [],
};

const sensor = {
  id: "s1",
  account_id: "a1",
  home_id: "h1",
  room_id: null,
  controller_id: "c1",
  name: "Living Room Temp",
  sensor_type: "temperature_bme280",
  gpio_pin: null,
  i2c_address: "0x76",
  unit: "°C",
  last_value: 22.4,
  last_raw_payload: { i2c_address: "0x76", status: "ok" },
  is_online: true,
  last_reading_at: "2026-11-16T10:00:00Z",
};

function mockFetch(historyBody: unknown) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url.startsWith("/api/sensors/history")) return jsonResponse(historyBody);
    if (url === "/api/sensors") return jsonResponse({ sensors: [sensor] });
    if (url === "/api/controllers") return jsonResponse({ controllers: [controller] });
    if (url === "/api/homes/rooms") return jsonResponse({ rooms: [] });
    return jsonResponse({ ok: true });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return calls;
}

describe("SensorsPage history graphs", () => {
  beforeEach(() => {
    resetApiCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetApiCache();
  });

  it("loads the batched history endpoint and renders the card sparkline", async () => {
    const calls = mockFetch({
      history: {
        s1: [
          { value: 21.2, unit: "°C", recordedAt: "2026-11-16T09:00:00Z" },
          { value: 22.4, unit: "°C", recordedAt: "2026-11-16T10:00:00Z" },
        ],
      },
    });

    render(
      <TimezoneContext.Provider value="UTC">
        <SensorsPage canManage={true} />
      </TimezoneContext.Provider>
    );

    expect(await screen.findByText("Living Room Temp")).toBeInTheDocument();
    expect(await screen.findByTestId("sensor-sparkline")).toBeInTheDocument();
    // One batched history call carrying the sensor id — not one call per card
    const historyCalls = calls.filter((u) => u.startsWith("/api/sensors/history"));
    expect(historyCalls).toHaveLength(1);
    expect(decodeURIComponent(historyCalls[0]!)).toContain("ids=s1");
  });

  it("renders the empty state when no history has been recorded yet", async () => {
    mockFetch({ history: {} });

    render(
      <TimezoneContext.Provider value="UTC">
        <SensorsPage canManage={true} />
      </TimezoneContext.Provider>
    );

    expect(await screen.findByText("Living Room Temp")).toBeInTheDocument();
    expect(await screen.findByTestId("sensor-sparkline-empty")).toBeInTheDocument();
    // Never fabricates readings
    expect(screen.queryByTestId("sensor-sparkline")).not.toBeInTheDocument();
  });
});
