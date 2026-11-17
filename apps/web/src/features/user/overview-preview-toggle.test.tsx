import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiCache } from "@/lib/api";
import { TimezoneContext } from "@/lib/timezone";
import { OverviewPage } from "./OverviewPage";
import type { OverviewData } from "@/features/types";

const originalFetch = globalThis.fetch;

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const overview: OverviewData = {
  summary: {
    totalRooms: 1,
    totalDevices: 0,
    activeDevices: 0,
    totalSwitches: 0,
    activeSwitches: 0,
    totalSensors: 0,
    totalControllers: 1,
    onlineControllers: 1,
    offlineControllers: 0,
  },
  homes: [{ id: "h1", account_id: "a1", name: "Main Home", timezone: "UTC" }],
  rooms: [
    {
      id: "r1",
      account_id: "a1",
      home_id: "h1",
      name: "Living Room",
      icon: "sofa",
      floor_order: 1,
      grid_col_span: 1,
      room_type: "living_room",
      floor_x: 0,
      floor_y: 0,
      floor_w: 360,
      floor_h: 280,
      layout_config: { floorStyle: "wood" },
    } as OverviewData["rooms"][number],
  ],
  controllers: [
    {
      id: "c1",
      account_id: "a1",
      home_id: "h1",
      room_id: null,
      board_catalog_id: "b1",
      custom_board_id: null,
      name: "Office Hub",
      hardware_uid: "esp-9",
      board_model: "ESP32-S3-N16R8",
      chip_variant: "ESP32-S3",
      flash_size_mb: 16,
      psram_size_mb: 8,
      firmware_version: "1.4.0",
      status: "online",
      mqtt_connected: true,
      wifi_ssid: "HomeNet",
      wifi_rssi: -55,
      local_ip: "192.168.1.50",
      last_heartbeat_at: null,
      last_communication_at: null,
      paired_at: "2026-10-01T00:00:00Z",
      connection_history: [],
    },
  ],
  devices: [],
  switches: [],
  sensors: [],
  recentActivity: [],
};

describe("Overview preview toggle", () => {
  beforeEach(() => {
    resetApiCache();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/homes/overview") {
        return jsonResponse(overview);
      }
      return jsonResponse({ ok: true });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetApiCache();
  });

  it("switches between Home Preview and Controller Preview in place", async () => {
    const user = userEvent.setup();
    render(
      <TimezoneContext.Provider value="UTC">
        <OverviewPage canManage={true} canOperate={true} onNavigate={vi.fn()} />
      </TimezoneContext.Provider>
    );

    // Default: Home Preview visible, Controller Preview not mounted
    expect(await screen.findByTestId("floorplan-container")).toBeInTheDocument();
    expect(screen.queryByTestId("controller-preview-panel")).not.toBeInTheDocument();

    const homeTab = screen.getByRole("tab", { name: /Home Preview/i });
    const controllerTab = screen.getByRole("tab", { name: /Controller Preview/i });
    expect(homeTab).toHaveAttribute("aria-selected", "true");
    expect(controllerTab).toHaveAttribute("aria-selected", "false");

    // Switch to Controller Preview — same page, no navigation
    await user.click(controllerTab);
    expect(await screen.findByTestId("controller-preview-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("floorplan-container")).not.toBeInTheDocument();
    expect(screen.getByText("Office Hub")).toBeInTheDocument();
    expect(controllerTab).toHaveAttribute("aria-selected", "true");

    // Switch back
    await user.click(homeTab);
    expect(await screen.findByTestId("floorplan-container")).toBeInTheDocument();
    expect(screen.queryByTestId("controller-preview-panel")).not.toBeInTheDocument();
  });
});
