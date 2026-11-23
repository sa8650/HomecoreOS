import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimezoneContext } from "../../lib/timezone";
import { HomeFloorPlan } from "./HomeFloorPlan";
import type {
  DeviceItem,
  HomeItem,
  RoomItem,
  SensorItem,
  SwitchItem,
} from "../../features/types";
import { jsonResponse } from "@/test/http";

const originalFetch = globalThis.fetch;

describe("RoomControlsCard layout and interactions inside HomeFloorPlan", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders room icon header, master switch, Temperature/Humidity metric pills, 5-speed Fan Control, and active/inactive control rows", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/devices/fan-1/command")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { state: string };
        return jsonResponse({
          device: {
            id: "fan-1",
            state: body.state,
          },
        });
      }
      if (url.includes("/api/switches/sw-1/toggle")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { isOn: boolean };
        return jsonResponse({
          switch: {
            id: "sw-1",
            is_on: body.isOn,
          },
        });
      }
      if (url.includes("/api/switches/sw-2/toggle")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { isOn: boolean };
        return jsonResponse({
          switch: {
            id: "sw-2",
            is_on: body.isOn,
          },
        });
      }
      return jsonResponse({ ok: true });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const homes: HomeItem[] = [
      { id: "h1", account_id: "a1", name: "Main Home", timezone: "UTC" },
    ];
    const rooms: RoomItem[] = [
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
        floor_w: 320,
        floor_h: 240,
      },
    ];
    const switches: SwitchItem[] = [
      {
        id: "sw-1",
        account_id: "a1",
        home_id: "h1",
        room_id: "r1",
        board_instance_id: "c1",
        name: "Light 1",
        gpio_pin: 4,
        inverted: false,
        is_on: true,
        is_online: true,
        last_changed_at: null,
      },
      {
        id: "sw-2",
        account_id: "a1",
        home_id: "h1",
        room_id: "r1",
        board_instance_id: "c1",
        name: "Light 2",
        gpio_pin: 5,
        inverted: false,
        is_on: false,
        is_online: true,
        last_changed_at: null,
      },
    ];
    const devices: DeviceItem[] = [
      {
        id: "fan-1",
        account_id: "a1",
        home_id: "h1",
        room_id: "r1",
        board_instance_id: "c1",
        name: "Fan 1",
        device_type: "fan",
        gpio_pin: 12,
        state: "speed_5",
        is_online: true,
      },
    ];
    const sensors: SensorItem[] = [
      {
        id: "sen-1",
        account_id: "a1",
        home_id: "h1",
        room_id: "r1",
        board_instance_id: "c1",
        name: "Room Temperature",
        sensor_type: "temperature",
        gpio_pin: 6,
        unit: "°C",
        last_value: 22.5,
        last_raw_payload: null,
        last_reading_at: "2026-11-15T10:00:00Z",
        is_online: true,
      },
      {
        id: "sen-2",
        account_id: "a1",
        home_id: "h1",
        room_id: "r1",
        board_instance_id: "c1",
        name: "Room Humidity",
        sensor_type: "humidity",
        gpio_pin: 7,
        unit: "%",
        last_value: 48,
        last_raw_payload: null,
        last_reading_at: "2026-11-15T10:00:00Z",
        is_online: true,
      },
    ];

    render(
      <TimezoneContext.Provider value="UTC">
        <HomeFloorPlan
          homes={homes}
          rooms={rooms}
          switches={switches}
          devices={devices}
          sensors={sensors}
          canEdit
          canOperate
          onReload={vi.fn()}
        />
      </TimezoneContext.Provider>
    );

    const panel = screen.getByTestId("room-controls-panel");
    expect(panel.className).toContain("bg-card");
    expect(panel.parentElement?.className).not.toContain("rounded-[24px]");
    expect(within(panel).getByText("Living Room")).toBeInTheDocument();
    expect(within(panel).getByText("2 Lights · 1 Fan")).toBeInTheDocument();

    // 2-column sensor metric pills
    const sensorPills = within(panel).getByTestId("room-sensor-pills");
    expect(within(sensorPills).getByText("Temperature")).toBeInTheDocument();
    expect(within(sensorPills).getByText("22.5°C")).toBeInTheDocument();
    expect(within(sensorPills).getByText("Humidity")).toBeInTheDocument();
    expect(within(sensorPills).getByText("48%")).toBeInTheDocument();

    // 5-speed circular Fan Control dial (Speed 5 active initially)
    const fanControl = within(panel).getByTestId("room-fan-control");
    expect(within(fanControl).getByText("Fan Control")).toBeInTheDocument();
    expect(
      within(fanControl).getByRole("button", { name: "Fan 1 Speed 5" })
    ).toHaveAttribute("aria-pressed", "true");

    // Click Speed 3 -> dispatches POST /api/devices/fan-1/command with state: "speed_3"
    await user.click(within(fanControl).getByRole("button", { name: "Fan 1 Speed 3" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/devices/fan-1/command",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ state: "speed_3" }),
        })
      );
    });

    // Control rows (Light 1 active, Light 2 inactive, Fan 1 active)
    const controlRows = within(panel).getByTestId("room-control-rows");
    const light1Toggle = within(controlRows).getByRole("switch", { name: "Toggle Light 1" });
    const light2Toggle = within(controlRows).getByRole("switch", { name: "Toggle Light 2" });
    const fan1Toggle = within(controlRows).getByRole("switch", { name: "Toggle Fan 1" });

    expect(light1Toggle).toHaveAttribute("aria-checked", "true");
    expect(light2Toggle).toHaveAttribute("aria-checked", "false");
    expect(fan1Toggle).toHaveAttribute("aria-checked", "true");

    // Toggle Light 2 ON
    await user.click(light2Toggle);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/switches/sw-2/toggle",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ isOn: true }),
        })
      );
    });

    // Top master switch strictly controls whole-room ON/OFF (turns OFF both Light 1 and Fan 1)
    fetchMock.mockClear();
    const wholeRoomToggle = within(panel).getByRole("switch", {
      name: "Turn off Living Room",
    });
    expect(wholeRoomToggle).toHaveAttribute("aria-checked", "true");
    await user.click(wholeRoomToggle);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/switches/sw-1/toggle",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ isOn: false }),
        })
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/devices/fan-1/command",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ state: "off" }),
        })
      );
    });
  });

  it("turns ON every switch and device in the room when the top whole-room switch is toggled ON", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock as typeof fetch;

    const homes: HomeItem[] = [
      { id: "h1", account_id: "a1", name: "Main Home", timezone: "UTC" },
    ];
    const rooms: RoomItem[] = [
      {
        id: "r1",
        account_id: "a1",
        home_id: "h1",
        name: "Studio",
        icon: "sofa",
        floor_order: 1,
        grid_col_span: 1,
        room_type: "office",
        floor_x: 0,
        floor_y: 0,
        floor_w: 320,
        floor_h: 240,
      },
    ];
    const switches: SwitchItem[] = [
      {
        id: "sw-a",
        account_id: "a1",
        home_id: "h1",
        room_id: "r1",
        board_instance_id: "c1",
        name: "Desk Lamp",
        gpio_pin: 4,
        inverted: false,
        is_on: false,
        is_online: true,
        last_changed_at: null,
      },
    ];
    const devices: DeviceItem[] = [
      {
        id: "fan-a",
        account_id: "a1",
        home_id: "h1",
        room_id: "r1",
        board_instance_id: "c1",
        name: "Ceiling Fan",
        device_type: "fan",
        gpio_pin: 12,
        state: "off",
        is_online: true,
      },
      {
        id: "plug-a",
        account_id: "a1",
        home_id: "h1",
        room_id: "r1",
        board_instance_id: "c1",
        name: "Desk Outlet",
        device_type: "outlet",
        gpio_pin: 14,
        state: "off",
        is_online: true,
      },
    ];

    render(
      <TimezoneContext.Provider value="UTC">
        <HomeFloorPlan
          homes={homes}
          rooms={rooms}
          switches={switches}
          devices={devices}
          sensors={[]}
          canEdit
          canOperate
          onReload={vi.fn()}
        />
      </TimezoneContext.Provider>
    );

    const panel = screen.getByTestId("room-controls-panel");
    const wholeRoomToggle = within(panel).getByRole("switch", {
      name: "Turn on Studio",
    });
    expect(wholeRoomToggle).toHaveAttribute("aria-checked", "false");
    await user.click(wholeRoomToggle);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/switches/sw-a/toggle",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ isOn: true }),
        })
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/devices/fan-a/command",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ state: "on" }),
        })
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/devices/plug-a/command",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ state: "on" }),
        })
      );
    });
  });
});
