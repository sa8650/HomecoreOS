import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEsp32S3N16R8PinMap } from "@homecoreos/shared";
import {
  apiFetch,
  cachedGet,
  getCachedSnapshot,
  resetApiCache,
} from "../lib/api";
import { TimezoneContext } from "../lib/timezone";
import { HomeFloorPlan } from "./floorplan/HomeFloorPlan";
import { RoomEditorModal } from "./floorplan/RoomEditorModal";
import { SwitchEditorModal } from "./hardware/EntityModals";
import { NotificationBellPopover } from "./notifications/NotificationBellPopover";
import { Toaster } from "./ui/sonner";
import { SwitchesPage } from "../features/user/DevicesSwitchesSensorsPages";
import { NotificationsPage } from "../features/notifications/NotificationsPage";
import type {
  BoardProfileItem,
  ControllerItem,
  HomeItem,
  NotificationItem,
  RoomItem,
  SwitchItem,
} from "../features/types";
import type { HardwareContext } from "../lib/board-pin-helpers";

const originalFetch = globalThis.fetch;

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeController(overrides?: Partial<ControllerItem>): ControllerItem {
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
    paired_at: new Date().toISOString(),
    connection_history: [],
    ...overrides,
  };
}

describe("Phase 2 frontend caching, optimistic controls & concurrency guards", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetApiCache();
  });

  it("deduplicates concurrent cachedGet requests, reads snapshots, and invalidates affected prefixes on mutation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/boards/catalog") return jsonResponse({ boards: [{ id: "b1" }] });
      if (url === "/api/homes/overview") return jsonResponse({ homes: [{ id: "h1" }] });
      if (url === "/api/switches") return jsonResponse({ switches: [{ id: "sw1" }] });
      if (url === "/api/switches/sw1/toggle") return jsonResponse({ ok: true });
      return jsonResponse({});
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const [a, b] = await Promise.all([
      cachedGet<{ homes: Array<{ id: string }> }>("/api/homes/overview", { ttlMs: 30_000 }),
      cachedGet<{ homes: Array<{ id: string }> }>("/api/homes/overview", { ttlMs: 30_000 }),
    ]);
    expect(a.homes[0]?.id).toBe("h1");
    expect(b.homes[0]?.id).toBe("h1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await cachedGet("/api/boards/catalog", { ttlMs: 60_000 });
    await cachedGet("/api/switches", { ttlMs: 15_000 });
    expect(getCachedSnapshot("/api/homes/overview")).not.toBeNull();
    expect(getCachedSnapshot("/api/boards/catalog")).not.toBeNull();
    expect(getCachedSnapshot("/api/switches")).not.toBeNull();

    // Toggling a switch invalidates /api/switches and /api/homes/overview, NOT /api/boards/catalog
    await apiFetch("/api/switches/sw1/toggle", {
      method: "POST",
      body: JSON.stringify({ isOn: true }),
    });
    expect(getCachedSnapshot("/api/switches")).toBeNull();
    expect(getCachedSnapshot("/api/homes/overview")).toBeNull();
    expect(getCachedSnapshot("/api/boards/catalog")).not.toBeNull();
  });

  it("applies optimistic switch state immediately on HomeFloorPlan and rolls back with StatusAlert on API failure", async () => {
    const user = userEvent.setup();
    let resolveToggle!: (r: Response) => void;
    const pendingToggle = new Promise<Response>((res) => {
      resolveToggle = res;
    });

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/switches/sw1/toggle")) {
        return pendingToggle;
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const homes: HomeItem[] = [{ id: "h1", account_id: "a1", name: "Main Home", timezone: "UTC" }];
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
        layout_config: { floorStyle: "wood" },
      },
    ];
    const switches: SwitchItem[] = [
      {
        id: "sw1",
        account_id: "a1",
        home_id: "h1",
        room_id: "r1",
        controller_id: "c1",
        name: "Porch Light",
        gpio_pin: 4,
        inverted: false,
        is_on: false,
        is_online: true,
        last_changed_at: null,
      },
    ];

    render(
      <TimezoneContext.Provider value="UTC">
        <HomeFloorPlan
          homes={homes}
          rooms={rooms}
          switches={switches}
          devices={[]}
          sensors={[]}
          canEdit={true}
          canOperate={true}
          onReload={vi.fn()}
        />
        <Toaster />
      </TimezoneContext.Provider>
    );

    const toggleBtn = screen.getByRole("switch", { name: "Toggle Porch Light" });
    expect(toggleBtn).toHaveAttribute("aria-checked", "false");

    await user.click(toggleBtn);
    // Optimistically flipped before the network promise settles
    expect(screen.getByRole("switch", { name: "Toggle Porch Light" })).toHaveAttribute(
      "aria-checked",
      "true"
    );

    await act(async () => {
      resolveToggle(jsonResponse({ error: "Broker timeout" }, 500));
    });

    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Toggle Porch Light" })).toHaveAttribute(
        "aria-checked",
        "false"
      );
      expect(screen.getByText(/Broker timeout/i)).toBeInTheDocument();
    });
  });

  it("allows concurrent optimistic switch toggles on SwitchesPage and rolls back only failed switches", async () => {
    const user = userEvent.setup();
    let resolveSw1!: (r: Response) => void;
    let resolveSw2!: (r: Response) => void;

    const sw1Initial: SwitchItem = {
      id: "sw1",
      account_id: "a1",
      home_id: "h1",
      room_id: null,
      controller_id: "c1",
      name: "Lamp Alpha",
      gpio_pin: 4,
      inverted: false,
      is_on: false,
      is_online: true,
      last_changed_at: null,
    };
    const sw2Initial: SwitchItem = {
      id: "sw2",
      account_id: "a1",
      home_id: "h1",
      room_id: null,
      controller_id: "c1",
      name: "Lamp Beta",
      gpio_pin: 5,
      inverted: false,
      is_on: false,
      is_online: true,
      last_changed_at: null,
    };
    let serverSw1 = false;

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/switches") {
        return Promise.resolve(
          jsonResponse({ switches: [{ ...sw1Initial, is_on: serverSw1 }, sw2Initial] })
        );
      }
      if (url === "/api/controllers") {
        return Promise.resolve(jsonResponse({ controllers: [makeController()] }));
      }
      if (url === "/api/homes/rooms") return Promise.resolve(jsonResponse({ rooms: [] }));
      if (url === "/api/switches/sw1/toggle") {
        serverSw1 = true;
        return new Promise<Response>((res) => {
          resolveSw1 = res;
        });
      }
      if (url === "/api/switches/sw2/toggle") {
        return new Promise<Response>((res) => {
          resolveSw2 = res;
        });
      }
      return Promise.resolve(jsonResponse({}));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(
      <>
        <SwitchesPage canManage={true} canOperate={true} />
        <Toaster />
      </>
    );

    const sw1Toggle = await screen.findByRole("switch", { name: "Toggle Lamp Alpha" });
    const sw2Toggle = await screen.findByRole("switch", { name: "Toggle Lamp Beta" });

    // Click both concurrently while sw1 is still pending
    await user.click(sw1Toggle);
    await user.click(sw2Toggle);

    expect(sw1Toggle).toHaveAttribute("aria-checked", "true");
    expect(sw2Toggle).toHaveAttribute("aria-checked", "true");
    expect(fetchMock).toHaveBeenCalledWith("/api/switches/sw1/toggle", expect.anything());
    expect(fetchMock).toHaveBeenCalledWith("/api/switches/sw2/toggle", expect.anything());

    // sw2 fails while sw1 succeeds
    await act(async () => {
      resolveSw2(jsonResponse({ error: "GPIO write failed" }, 500));
      resolveSw1(jsonResponse({ switch: { ...sw1Initial, is_on: true } }));
    });

    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Toggle Lamp Alpha" })).toHaveAttribute(
        "aria-checked",
        "true"
      );
      expect(screen.getByRole("switch", { name: "Toggle Lamp Beta" })).toHaveAttribute(
        "aria-checked",
        "false"
      );
      expect(screen.getByText(/GPIO write failed/i)).toBeInTheDocument();
    });
  });

  it("prevents duplicate SwitchEditorModal & RoomEditorModal submits and does not overwrite form input on async ctx updates", async () => {
    const user = userEvent.setup();
    let resolvePost!: (res: Response) => void;
    let postCount = 0;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/switches" && init?.method === "POST") {
        postCount += 1;
        return new Promise<Response>((res) => {
          resolvePost = res;
        });
      }
      if (url === "/api/homes/rooms" && init?.method === "POST") {
        postCount += 1;
        return new Promise<Response>((res) => {
          resolvePost = res;
        });
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const board: BoardProfileItem = {
      id: "b1",
      slug: "esp32-s3",
      manufacturer: "Espressif",
      model: "ESP32-S3-N16R8",
      revision: "1.0",
      chip_family: "esp32s3",
      chip_variant: "ESP32-S3",
      flash_size_mb: 16,
      psram_size_mb: 8,
      is_available: true,
      is_validated: true,
      gpio_definitions: buildEsp32S3N16R8PinMap(),
    };
    const controller = makeController({ name: "Hallway Hub" });
    const initialCtx: HardwareContext = {
      controllers: [controller],
      rooms: [],
      boardsById: new Map([["b1", board]]),
    };

    const { rerender, unmount } = render(
      <SwitchEditorModal
        open={true}
        onOpenChange={vi.fn()}
        switchItem={null}
        ctx={initialCtx}
        onSaved={vi.fn()}
      />
    );

    const nameInput = screen.getByLabelText("Switch Name");
    await user.type(nameInput, "Desk Relay");

    // Simulate background ctx refresh arriving while user is mid-edit
    rerender(
      <SwitchEditorModal
        open={true}
        onOpenChange={vi.fn()}
        switchItem={null}
        ctx={{
          controllers: [{ ...controller, name: "Hallway Hub Updated" }],
          rooms: [],
          boardsById: initialCtx.boardsById,
        }}
        onSaved={vi.fn()}
      />
    );
    expect(screen.getByLabelText("Switch Name")).toHaveValue("Desk Relay");

    const createBtn = screen.getByRole("button", { name: "Create Switch" });
    await user.click(createBtn);
    await user.click(createBtn);
    expect(postCount).toBe(1);

    await act(async () => {
      resolvePost(jsonResponse({ switch: { id: "sw-new" } }));
    });
    unmount();

    // Also test RoomEditorModal duplicate submit prevention
    postCount = 0;
    render(
      <RoomEditorModal
        open={true}
        onClose={vi.fn()}
        homeId="h1"
        room={null}
        onSaved={vi.fn()}
      />
    );
    await user.type(screen.getByLabelText(/room name/i), "Studio");
    const saveRoomBtn = screen.getByRole("button", { name: "Create Room" });
    await user.click(saveRoomBtn);
    await user.click(saveRoomBtn);
    expect(postCount).toBe(1);

    await act(async () => {
      resolvePost(jsonResponse({ room: { id: "r-new" } }));
    });
  });

  it("synchronizes NotificationBellPopover unread badge when NotificationsPage marks an alert read", async () => {
    const user = userEvent.setup();
    const notifications: NotificationItem[] = [
      {
        id: "n1",
        scope: "user",
        account_id: "a1",
        user_id: "u1",
        category: "controller",
        event_key: "controller.offline",
        preference_key: "controller_offline_online",
        severity: "warning",
        title: "Hub Offline",
        message: "Living Hub missed a heartbeat",
        metadata: { targetUrl: "/controllers" },
        is_read: false,
        read_at: null,
        created_at: new Date().toISOString(),
      },
    ];
    let unread = 1;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/notifications/n1/read")) {
        notifications[0] = { ...notifications[0]!, is_read: true };
        unread = 0;
        return jsonResponse({ ok: true });
      }
      if (url.startsWith("/api/notifications")) {
        return jsonResponse({ notifications, unreadCount: unread });
      }
      return jsonResponse({});
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(
      <TimezoneContext.Provider value="UTC">
        <div>
          <NotificationBellPopover scope="user" onNavigate={vi.fn()} />
          <NotificationsPage scope="user" onNavigate={vi.fn()} />
        </div>
      </TimezoneContext.Provider>
    );

    const badge = await screen.findByTestId("notification-unread-badge");
    expect(badge).toHaveTextContent("1");

    const markReadBtn = await screen.findByRole("button", { name: "Mark read" });
    await user.click(markReadBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("notification-unread-badge")).toBeNull();
    });
  });

  it("prevents duplicate MQTT toggle commands when clicking an in-flight Switch card repeatedly", async () => {
    const user = userEvent.setup();
    let resolveToggle!: (r: Response) => void;
    const sw: SwitchItem = {
      id: "sw-dup",
      account_id: "a1",
      home_id: "h1",
      room_id: null,
      controller_id: "c1",
      name: "Patio Spotlight",
      gpio_pin: 14,
      inverted: false,
      is_on: false,
      is_online: true,
      last_changed_at: null,
    };

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/switches") return Promise.resolve(jsonResponse({ switches: [sw] }));
      if (url === "/api/controllers") return Promise.resolve(jsonResponse({ controllers: [makeController()] }));
      if (url === "/api/homes/rooms") return Promise.resolve(jsonResponse({ rooms: [] }));
      if (url === "/api/switches/sw-dup/toggle") {
        return new Promise<Response>((res) => {
          resolveToggle = res;
        });
      }
      return Promise.resolve(jsonResponse({}));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(<SwitchesPage canManage canOperate />);

    const toggleEl = await screen.findByRole("switch", { name: "Toggle Patio Spotlight" });
    await user.click(toggleEl);
    expect(toggleEl).toBeDisabled();

    // Clicking again while disabled/in-flight emits ZERO additional toggle calls
    await user.click(toggleEl);
    const toggleCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/switches/sw-dup/toggle"
    );
    expect(toggleCalls).toHaveLength(1);

    await act(async () => {
      resolveToggle(jsonResponse({ switch: { ...sw, is_on: true } }));
    });
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Toggle Patio Spotlight" })).not.toBeDisabled();
      expect(screen.getByRole("switch", { name: "Toggle Patio Spotlight" })).toHaveAttribute(
        "aria-checked",
        "true"
      );
    });
  });
});
