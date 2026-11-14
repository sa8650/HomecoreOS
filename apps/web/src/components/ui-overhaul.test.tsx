import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VERIFIED_BOARD_CATALOG } from "@homecoreos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { TimezoneContext } from "../lib/timezone";
import { HERO_SPOTLIGHT_PALETTES } from "./ui/magic-card";
import { Toaster } from "./ui/sonner";
import { AutomationsPage } from "../features/user/AutomationsPage";
import { BoardLibraryPage } from "../features/user/BoardLibraryPage";
import { ControllersPage } from "../features/user/ControllersPage";
import {
  DevicesPage,
  SensorsPage,
  SwitchesPage,
} from "../features/user/DevicesSwitchesSensorsPages";
import { FirmwarePage } from "../features/user/FirmwarePage";
import { RoomsPage } from "../features/user/RoomsPage";
import { UserSettingsPage } from "../features/user/ActivityAndSettingsPages";
import type {
  AutomationItem,
  BoardProfileItem,
  ControllerItem,
  DeviceItem,
  FirmwareReleaseItem,
  HomeItem,
  RoomItem,
  SensorItem,
  SwitchItem,
  UserSessionData,
} from "../features/types";

const originalFetch = globalThis.fetch;

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeSampleFixtures() {
  const s3Board = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;
  const xiaoBoard = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "seeed-xiao-esp32s3")!;
  const catalogBoards: BoardProfileItem[] = [
    { ...s3Board, id: "cat-s3", is_available: true, compatible_firmware_count: 1 },
    { ...xiaoBoard, id: "cat-xiao", is_available: true, compatible_firmware_count: 0 },
  ];
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
      floor_order: 0,
      room_type: "living_room",
      grid_col_span: 2,
    },
    {
      id: "r2",
      account_id: "a1",
      home_id: "h1",
      name: "Bedroom",
      icon: "bed",
      floor_order: 1,
      room_type: "bedroom",
      grid_col_span: 1,
    },
  ];
  const controllers: ControllerItem[] = [
    {
      id: "c1",
      account_id: "a1",
      home_id: "h1",
      board_catalog_id: "cat-s3",
      custom_board_id: null,
      name: "Living Room Hub",
      hardware_uid: "AA:BB:CC:DD:EE:01",
      board_model: "ESP32-S3-DevKitC-1",
      chip_variant: "ESP32-S3",
      flash_size_mb: 16,
      psram_size_mb: 8,
      firmware_version: "1.4.0",
      status: "online",
      pairing_status: "paired",
      wifi_connected: true,
      wifi_ssid: "HomeCore-5G",
      wifi_rssi: -48,
      local_ip: "192.168.1.44",
      mqtt_connected: true,
      paired_at: "2026-10-01T10:00:00Z",
      last_heartbeat_at: "2026-10-10T10:00:00Z",
      last_communication_at: "2026-10-10T10:00:00Z",
      last_error: null,
      deleted_at: null,
      connection_history: [],
      board_compat: {
        slug: "esp32-s3-devkitc-1-n16r8",
        model: "ESP32-S3-DevKitC-1",
        chip_family: "esp32s3",
        partition_scheme: "dual_ota_16mb",
        boot_button_gpio: 0,
        usb_interface: "2x USB-C",
        supports_wifi: true,
        supports_ble: true,
        connectivity_note: null,
      },
    },
    {
      id: "c2",
      account_id: "a1",
      home_id: "h1",
      board_catalog_id: "cat-s3",
      custom_board_id: null,
      name: "Garage Node",
      hardware_uid: "AA:BB:CC:DD:EE:02",
      board_model: "ESP32-S3-DevKitC-1",
      chip_variant: "ESP32-S3",
      flash_size_mb: 16,
      psram_size_mb: 8,
      firmware_version: "1.3.0",
      status: "offline",
      pairing_status: "paired",
      wifi_connected: false,
      wifi_ssid: null,
      wifi_rssi: null,
      local_ip: null,
      mqtt_connected: false,
      paired_at: "2026-10-01T10:00:00Z",
      last_heartbeat_at: null,
      last_communication_at: null,
      last_error: null,
      deleted_at: null,
      connection_history: [],
    },
  ];
  const switches: SwitchItem[] = [
    {
      id: "sw1",
      account_id: "a1",
      home_id: "h1",
      room_id: "r1",
      controller_id: "c1",
      name: "Hallway Lamp",
      gpio_pin: 4,
      inverted: false,
      is_on: false,
      is_online: true,
      last_changed_at: null,
    },
    {
      id: "sw2",
      account_id: "a1",
      home_id: "h1",
      room_id: "r2",
      controller_id: "c1",
      name: "Porch Relay",
      gpio_pin: 5,
      inverted: false,
      is_on: true,
      is_online: true,
      last_changed_at: null,
    },
  ];
  const devices: DeviceItem[] = [
    {
      id: "d1",
      account_id: "a1",
      home_id: "h1",
      room_id: "r1",
      controller_id: "c1",
      name: "Ceiling Fan",
      device_type: "fan",
      gpio_pin: 12,
      state: "inactive",
      is_online: true,
    },
    {
      id: "d2",
      account_id: "a1",
      home_id: "h1",
      room_id: "r2",
      controller_id: "c1",
      name: "Front Door Lock",
      device_type: "lock",
      gpio_pin: 13,
      state: "active",
      is_online: true,
    },
  ];
  const sensors: SensorItem[] = [
    {
      id: "sn1",
      account_id: "a1",
      home_id: "h1",
      room_id: "r1",
      controller_id: "c1",
      name: "Room Thermometer",
      sensor_type: "dht22_temp",
      gpio_pin: 6,
      unit: "°C",
      last_value: 23.8,
      last_raw_payload: null,
      last_reading_at: "2026-10-10T10:00:00Z",
      is_online: true,
    },
    {
      id: "sn2",
      account_id: "a1",
      home_id: "h1",
      room_id: "r2",
      controller_id: "c1",
      name: "Window Contact",
      sensor_type: "contact",
      gpio_pin: 7,
      unit: "state",
      last_value: 0,
      last_raw_payload: null,
      last_reading_at: "2026-10-10T10:00:00Z",
      is_online: true,
    },
  ];
  const releases: FirmwareReleaseItem[] = [
    {
      id: "fw1",
      name: "HomecoreOS Core",
      version: "1.4.0",
      chip_family: "esp32s3",
      channel: "stable",
      status: "published",
      release_notes: "BLE provisioning improvements",
      published_at: "2026-10-05T10:00:00Z",
      compatible_board_ids: ["cat-s3"],
      usb_available: true,
      ota_available: true,
      hardware_verified: true,
      files: [],
    },
    {
      id: "fw2",
      name: "HomecoreOS Beta C6",
      version: "1.5.0-beta.1",
      chip_family: "esp32c6",
      channel: "beta",
      status: "published",
      release_notes: "Thread beta build",
      published_at: "2026-10-09T10:00:00Z",
      compatible_board_ids: [],
      usb_available: false,
      ota_available: true,
      hardware_verified: false,
      files: [],
    },
  ];
  const automations: AutomationItem[] = [
    {
      id: "au1",
      account_id: "a1",
      home_id: "h1",
      name: "Morning Lights",
      description: "Turn on hallway lamp at sunrise",
      folder_name: "Lighting",
      enabled: true,
      execution_mode: "cloud",
      trigger_config: { type: "time", cronTime: "07:00", days: ["mon", "tue"], timezone: "UTC" },
      actions_config: [{ type: "switch_on", switchId: "sw1" }],
      last_execution_status: "success",
      last_executed_at: "2026-10-10T07:00:00Z",
      last_error: null,
    },
    {
      id: "au2",
      account_id: "a1",
      home_id: "h1",
      name: "Cooling Boost",
      description: "Enable fan when temperature rises",
      folder_name: "Climate",
      enabled: true,
      execution_mode: "hybrid",
      trigger_config: { type: "sensor_value", sensorId: "sn1", operator: "gt", threshold: 28 },
      actions_config: [{ type: "device_state", deviceId: "d1", targetState: "active" }],
      last_execution_status: "never",
      last_executed_at: null,
      last_error: null,
    },
  ];

  return {
    catalogBoards,
    homes,
    rooms,
    controllers,
    switches,
    devices,
    sensors,
    releases,
    automations,
  };
}

function installDefaultFetchMock(fixtures = makeSampleFixtures()) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (url === "/api/boards/catalog") return jsonResponse({ boards: fixtures.catalogBoards });
    if (url === "/api/boards/my-boards") return jsonResponse({ catalogBoards: [], customBoards: [] });
    if (url === "/api/boards/custom") return jsonResponse({ boards: [] });
    if (url === "/api/homes") return jsonResponse({ homes: fixtures.homes });
    if (url === "/api/homes/rooms" && method === "GET") return jsonResponse({ rooms: fixtures.rooms });
    if (url.startsWith("/api/homes/rooms/") && method === "DELETE") return jsonResponse({ ok: true });
    if (url === "/api/controllers") return jsonResponse({ controllers: fixtures.controllers });
    if (url === "/api/controllers/trash") return jsonResponse({ controllers: [] });
    if (url.match(/^\/api\/controllers\/[^/]+\/(restart|disconnect|reconnect|reset)$/) && method === "POST") {
      return jsonResponse({ ok: true });
    }
    if (url === "/api/switches" && method === "GET") return jsonResponse({ switches: fixtures.switches });
    if (url === "/api/devices" && method === "GET") return jsonResponse({ devices: fixtures.devices });
    if (url === "/api/sensors" && method === "GET") return jsonResponse({ sensors: fixtures.sensors });
    if (url === "/api/firmware/releases") return jsonResponse({ releases: fixtures.releases });
    if (url === "/api/firmware/updates") return jsonResponse({ applicableUpdates: [], history: [] });
    if (url === "/api/automations") return jsonResponse({ automations: fixtures.automations });
    if (url === "/api/automations/au1/run" && method === "POST") {
      return jsonResponse({ executedCount: 1, errors: [] });
    }
    if (url === "/api/automations/au1/test" && method === "POST") {
      return jsonResponse({
        conditionsMatched: true,
        plannedActions: [{ summary: "Turn Hallway Lamp ON" }],
      });
    }
    if (url === "/api/auth/profile" && method === "PATCH") return jsonResponse({ ok: true });
    if (url === "/api/auth/sessions") return jsonResponse({ sessions: [] });
    if (url === "/api/notifications/preferences") return jsonResponse({ preferences: null });
    if (url === "/api/account/staff") return jsonResponse({ staff: [] });
    return jsonResponse({ ok: true });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("4-Part UI Overhaul: Heroes, Board Library Layout, Sonner Toasts & MagicCard", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    document.documentElement.classList.remove("dark");
  });

  it("renders unique color-toned hero headers with domain illustrations and live search across all 8 target pages", async () => {
    const user = userEvent.setup();
    installDefaultFetchMock();

    // 1. BoardLibraryPage -> orange
    const bView = render(<BoardLibraryPage canManage />);
    expect(await screen.findByRole("region", { name: "Board Library Header" })).toHaveAttribute("data-hero-tone", "orange");
    expect(bView.container.querySelector(".hc-hero-orange")).not.toBeNull();
    expect(bView.container.querySelectorAll("img").length).toBe(0);
    bView.unmount();

    // 2. SwitchesPage -> yellow + hero search filters cards
    const swView = render(
      <TimezoneContext.Provider value="UTC">
        <SwitchesPage canManage canOperate />
      </TimezoneContext.Provider>
    );
    expect(await screen.findByRole("region", { name: "Switches Header" })).toHaveAttribute("data-hero-tone", "yellow");
    expect(swView.container.querySelector(".hc-hero-yellow")).not.toBeNull();
    expect(screen.getByText("Hallway Lamp")).toBeInTheDocument();
    expect(screen.getByText("Porch Relay")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /Search switches/i }), "Porch");
    expect(screen.queryByText("Hallway Lamp")).not.toBeInTheDocument();
    expect(screen.getByText("Porch Relay")).toBeInTheDocument();
    swView.unmount();

    // 3. SensorsPage -> green + hero search filters cards
    const snView = render(
      <TimezoneContext.Provider value="UTC">
        <SensorsPage canManage />
      </TimezoneContext.Provider>
    );
    expect(await screen.findByRole("region", { name: "Sensors Header" })).toHaveAttribute("data-hero-tone", "green");
    expect(snView.container.querySelector(".hc-hero-green")).not.toBeNull();
    await user.type(screen.getByRole("textbox", { name: /Search sensors/i }), "Window");
    expect(screen.queryByText("Room Thermometer")).not.toBeInTheDocument();
    expect(screen.getByText("Window Contact")).toBeInTheDocument();
    snView.unmount();

    // 4. DevicesPage -> purple + hero search filters cards
    const dvView = render(
      <TimezoneContext.Provider value="UTC">
        <DevicesPage canManage canOperate />
      </TimezoneContext.Provider>
    );
    expect(await screen.findByRole("region", { name: "Devices Header" })).toHaveAttribute("data-hero-tone", "purple");
    expect(dvView.container.querySelector(".hc-hero-purple")).not.toBeNull();
    await user.type(screen.getByRole("textbox", { name: /Search devices/i }), "Lock");
    expect(screen.queryByText("Ceiling Fan")).not.toBeInTheDocument();
    expect(screen.getByText("Front Door Lock")).toBeInTheDocument();
    dvView.unmount();

    // 5. FirmwarePage -> red + typing in hero search from Updates tab auto-switches to Firmware tab
    const fwView = render(
      <TimezoneContext.Provider value="UTC">
        <FirmwarePage canManage onNavigate={vi.fn()} />
      </TimezoneContext.Provider>
    );
    expect(await screen.findByRole("region", { name: "Firmware Header" })).toHaveAttribute("data-hero-tone", "red");
    expect(fwView.container.querySelector(".hc-hero-red")).not.toBeNull();
    await user.click(screen.getByRole("tab", { name: /Updates/i }));
    await user.type(screen.getByRole("textbox", { name: /Search firmware/i }), "Beta");
    expect(screen.getByRole("tab", { name: /Firmware/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("HomecoreOS Beta C6")).toBeInTheDocument();
    expect(screen.queryByText("HomecoreOS Core")).not.toBeInTheDocument();
    fwView.unmount();

    // 6. RoomsPage -> teal + hero search filters rooms
    const rmView = render(<RoomsPage canManage />);
    expect(await screen.findByRole("region", { name: "Rooms Header" })).toHaveAttribute("data-hero-tone", "teal");
    expect(rmView.container.querySelector(".hc-hero-teal")).not.toBeNull();
    await user.type(screen.getByRole("textbox", { name: /Search rooms/i }), "Bedroom");
    expect(screen.queryByRole("heading", { name: "Living Room" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bedroom" })).toBeInTheDocument();
    rmView.unmount();

    // 7. ControllersPage -> blue + hero search filters controllers
    const ctView = render(
      <TimezoneContext.Provider value="UTC">
        <ControllersPage canManage canOperate onNavigate={vi.fn()} />
      </TimezoneContext.Provider>
    );
    expect(await screen.findByRole("region", { name: "Controllers Header" })).toHaveAttribute("data-hero-tone", "blue");
    expect(ctView.container.querySelector(".hc-hero-blue")).not.toBeNull();
    await user.type(screen.getByRole("textbox", { name: /Search controllers/i }), "Garage");
    expect(screen.queryByText("Living Room Hub")).not.toBeInTheDocument();
    expect(screen.getByText("Garage Node")).toBeInTheDocument();
    ctView.unmount();

    // 8. AutomationsPage -> pink + hero search auto-switches from Visual Builder to Rules tab
    const auView = render(
      <TimezoneContext.Provider value="UTC">
        <AutomationsPage canManage canOperate />
      </TimezoneContext.Provider>
    );
    expect(await screen.findByRole("region", { name: "Automation Header" })).toHaveAttribute("data-hero-tone", "pink");
    expect(auView.container.querySelector(".hc-hero-pink")).not.toBeNull();
    await user.click(screen.getByRole("tab", { name: /Visual Builder/i }));
    await user.type(screen.getByRole("textbox", { name: /Search automations/i }), "Cooling");
    expect(screen.getByRole("tab", { name: /Rules/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Cooling Boost")).toBeInTheDocument();
    expect(screen.queryByText("Morning Lights")).not.toBeInTheDocument();
    auView.unmount();
  });

  it("reorganizes BoardLibraryPage: removes Saved Boards button, uses Source Select dropdown, and aligns all 3 filters on the Tabs row", async () => {
    const user = userEvent.setup();
    installDefaultFetchMock();

    render(<BoardLibraryPage canManage />);
    await screen.findByRole("heading", { name: /HomecoreOS Board Library/i });

    expect(screen.queryByRole("button", { name: /Saved Boards/i })).not.toBeInTheDocument();

    const tabRow = screen.getByRole("tablist").parentElement!;
    const sourceSelect = screen.getByRole("combobox", { name: /Filter by board source/i });
    const chipSelect = screen.getByRole("combobox", { name: /Filter by chip family/i });
    const fwSelect = screen.getByRole("combobox", { name: /Filter by firmware support/i });

    expect(tabRow).toContainElement(sourceSelect);
    expect(tabRow).toContainElement(chipSelect);
    expect(tabRow).toContainElement(fwSelect);

    // Filter to Official Espressif via new dropdown
    await user.click(sourceSelect);
    await user.click(await screen.findByRole("option", { name: /Official Espressif/i }));
    expect(screen.getByText(/ESP32-S3-DevKitC-1/i)).toBeInTheDocument();
    expect(screen.queryByText(/XIAO/i)).not.toBeInTheDocument();

    // Switching to My Boards hides catalog filter dropdowns cleanly
    await user.click(screen.getByRole("tab", { name: /My Boards/i }));
    expect(screen.queryByRole("combobox", { name: /Filter by board source/i })).not.toBeInTheDocument();
  });

  it("renders MagicCard (orb mode) on ControllersPage active controller cards and preserves click, dropdown actions, and toasts", async () => {
    const user = userEvent.setup();
    installDefaultFetchMock();

    const { container } = render(
      <TimezoneContext.Provider value="UTC">
        <ControllersPage canManage canOperate onNavigate={vi.fn()} />
        <Toaster />
      </TimezoneContext.Provider>
    );

    const grid = await screen.findByTestId("controllers-card-grid");
    const magicCards = grid.querySelectorAll('[data-slot="magic-card"][data-mode="orb"]');
    expect(magicCards.length).toBe(2);

    // Dropdown action works without opening card details and triggers Sonner toast
    await user.click(screen.getByRole("button", { name: "Actions for Living Room Hub" }));
    await user.click(await screen.findByRole("menuitem", { name: /^Restart$/i }));
    expect(await screen.findByText(/Dispatched "restart" to Living Room Hub/i)).toBeInTheDocument();

    // Clicking the card opens controller details modal
    await user.click(screen.getByRole("button", { name: "View details for Living Room Hub" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/192\.168\.1\.44/)).toBeInTheDocument();

    // Theme class toggling updates dark state smoothly without breaking MagicCard
    act(() => {
      document.documentElement.classList.add("dark");
    });
    expect(container.querySelector('[data-slot="magic-card"]')).not.toBeNull();
  });

  it("shows Sonner toasts across AutomationsPage, RoomsPage, and UserSettingsPage actions", async () => {
    const user = userEvent.setup();
    installDefaultFetchMock();

    // Automations dry-run & run toasts
    const auView = render(
      <TimezoneContext.Provider value="UTC">
        <AutomationsPage canManage canOperate />
        <Toaster />
      </TimezoneContext.Provider>
    );
    await screen.findByText("Morning Lights");
    await user.click(screen.getAllByRole("button", { name: /^Test$/i })[0]!);
    expect(await screen.findByText(/Dry-run test for "Morning Lights": Conditions PASSED/i)).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /^Run Now$/i })[0]!);
    expect(await screen.findByText(/Executed "Morning Lights"/i)).toBeInTheDocument();
    auView.unmount();

    // Rooms delete toast
    const rmView = render(
      <>
        <RoomsPage canManage />
        <Toaster />
      </>
    );
    await screen.findByRole("heading", { name: "Living Room" });
    await user.click(screen.getAllByRole("button", { name: /Remove/i })[0]!);
    await user.click(await screen.findByRole("button", { name: /^Remove Room$/i }));
    expect(await screen.findByText(/Removed "Living Room" from floor plan/i)).toBeInTheDocument();
    rmView.unmount();

    // UserSettings profile save toast
    const mockSession: UserSessionData = {
      user: {
        id: "u1",
        email: "alex@homecore.local",
        fullName: "Alex Rivera",
        appearancePreference: "light",
        timezone: "UTC",
      },
      account: {
        id: "a1",
        name: "Rivera Home",
        slug: "rivera-home",
        status: "active",
        staffRole: "owner",
      },
      accounts: [
        {
          id: "a1",
          name: "Rivera Home",
          slug: "rivera-home",
          status: "active",
          staffRole: "owner",
        },
      ],
      platformDefaultTimezone: "UTC",
    };
    const setView = render(
      <TimezoneContext.Provider value="UTC">
        <UserSettingsPage session={mockSession} onSessionRefresh={vi.fn(async () => {})} />
        <Toaster />
      </TimezoneContext.Provider>
    );
    await user.click(await screen.findByRole("button", { name: /Save Changes/i }));
    await waitFor(() => {
      expect(screen.getByText(/Profile and regional timezone saved/i)).toBeInTheDocument();
    });
    setView.unmount();
  });

  it("applies hero-matched MagicCard spotlights across all 7 hardware/management pages and 3-column grid on RoomsPage", async () => {
    const user = userEvent.setup();
    installDefaultFetchMock();

    expect(Object.keys(HERO_SPOTLIGHT_PALETTES)).toEqual([
      "orange",
      "yellow",
      "green",
      "purple",
      "blue",
      "red",
      "teal",
      "pink",
    ]);

    // 1. BoardLibraryPage -> orange
    const bView = render(<BoardLibraryPage canManage />);
    await screen.findByText(/ESP32-S3-DevKitC-1/i);
    expect(bView.container.querySelectorAll('[data-slot="magic-card"][data-spotlight-tone="orange"]').length).toBeGreaterThanOrEqual(2);
    bView.unmount();

    // 2. SwitchesPage -> yellow
    const swView = render(
      <TimezoneContext.Provider value="UTC">
        <SwitchesPage canManage canOperate />
      </TimezoneContext.Provider>
    );
    await screen.findByText("Hallway Lamp");
    expect(swView.container.querySelectorAll('[data-slot="magic-card"][data-spotlight-tone="yellow"]').length).toBe(2);
    swView.unmount();

    // 3. SensorsPage -> green
    const snView = render(
      <TimezoneContext.Provider value="UTC">
        <SensorsPage canManage />
      </TimezoneContext.Provider>
    );
    await screen.findByText("Room Thermometer");
    expect(snView.container.querySelectorAll('[data-slot="magic-card"][data-spotlight-tone="green"]').length).toBe(2);
    snView.unmount();

    // 4. DevicesPage -> purple
    const dvView = render(
      <TimezoneContext.Provider value="UTC">
        <DevicesPage canManage canOperate />
      </TimezoneContext.Provider>
    );
    await screen.findByText("Ceiling Fan");
    expect(dvView.container.querySelectorAll('[data-slot="magic-card"][data-spotlight-tone="purple"]').length).toBe(2);
    dvView.unmount();

    // 5. FirmwarePage -> red (Catalog + Updates tabs)
    const fwView = render(
      <TimezoneContext.Provider value="UTC">
        <FirmwarePage canManage onNavigate={vi.fn()} />
      </TimezoneContext.Provider>
    );
    await screen.findByText("HomecoreOS Core");
    expect(fwView.container.querySelectorAll('[data-slot="magic-card"][data-spotlight-tone="red"]').length).toBeGreaterThanOrEqual(1);
    await user.click(screen.getByRole("tab", { name: /Updates/i }));
    expect(fwView.container.querySelectorAll('[data-slot="magic-card"][data-spotlight-tone="red"]').length).toBeGreaterThanOrEqual(1);
    fwView.unmount();

    // 6. RoomsPage -> teal + 3-column card grid
    const rmView = render(<RoomsPage canManage />);
    const roomsGrid = await screen.findByTestId("rooms-card-grid");
    expect(roomsGrid.className).toContain("md:grid-cols-2");
    expect(roomsGrid.className).toContain("lg:grid-cols-3");
    expect(roomsGrid.querySelectorAll('[data-slot="magic-card"][data-spotlight-tone="teal"]').length).toBe(2);
    rmView.unmount();

    // 7. ControllersPage -> blue
    const ctView = render(
      <TimezoneContext.Provider value="UTC">
        <ControllersPage canManage canOperate onNavigate={vi.fn()} />
      </TimezoneContext.Provider>
    );
    await screen.findByText("Living Room Hub");
    expect(ctView.container.querySelectorAll('[data-slot="magic-card"][data-spotlight-tone="blue"]').length).toBe(2);
    ctView.unmount();
  });

  it("renders Persora-style Dynamic Island in Customer User Console without top header and leaves Admin Console header intact", async () => {
    const user = userEvent.setup();
    let activeAccountId = "a1";
    let unreadCount = 2;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url === "/api/auth/me") {
        const activeAccount =
          activeAccountId === "a2"
            ? { id: "a2", name: "Cabin Retreat", slug: "cabin", status: "active", staffRole: "administrator" }
            : { id: "a1", name: "Alice Residence", slug: "alice-res", status: "active", staffRole: "owner" };
        return jsonResponse({
          user: {
            id: "u1",
            email: "alice@example.com",
            fullName: "Alice Owner",
            appearancePreference: "light",
            timezone: "UTC",
          },
          account: activeAccount,
          accounts: [
            { id: "a1", name: "Alice Residence", slug: "alice-res", status: "active", staffRole: "owner" },
            { id: "a2", name: "Cabin Retreat", slug: "cabin", status: "active", staffRole: "administrator" },
          ],
          platformDefaultTimezone: "UTC",
          effectiveTimezone: "UTC",
        });
      }
      if (url === "/api/auth/switch-account" && method === "POST") {
        const parsed = JSON.parse(String(init?.body ?? "{}")) as { accountId?: string };
        activeAccountId = parsed.accountId ?? "a1";
        return jsonResponse({ ok: true });
      }
      if (url === "/api/homes/overview") {
        return jsonResponse({
          summary: {
            totalRooms: 1,
            totalDevices: 0,
            activeDevices: 0,
            totalSwitches: 0,
            activeSwitches: 0,
            totalSensors: 0,
            totalControllers: 0,
            onlineControllers: 0,
            offlineControllers: 0,
          },
          homes: [{ id: "h1", account_id: activeAccountId, name: "Main Home", timezone: "UTC" }],
          rooms: [
            {
              id: "r1",
              account_id: activeAccountId,
              home_id: "h1",
              name: "Living Room",
              icon: "RiHomeLine",
              floor_order: 0,
              grid_col_span: 1,
            },
          ],
          controllers: [],
          switches: [],
          devices: [],
          sensors: [],
          recentActivity: [],
        });
      }
      if (url.startsWith("/api/notifications?") && method === "GET") {
        return jsonResponse({
          unreadCount,
          notifications: [
            {
              id: "n1",
              account_id: activeAccountId,
              category: "controller",
              severity: "warning",
              title: "Hub S3 reconnected",
              message: "Controller came back online after Wi-Fi blip.",
              is_read: unreadCount === 0,
              created_at: "2026-10-10T10:00:00Z",
              metadata: {},
            },
          ],
        });
      }
      if (url === "/api/notifications/mark-all-read" && method === "POST") {
        unreadCount = 0;
        return jsonResponse({ ok: true });
      }
      if (url === "/api/admin/auth/me") {
        return jsonResponse({
          admin: { id: "adm1", email: "ops@homecore.local", fullName: "Root Operator", role: "super_admin", timezone: null },
          platformDefaultTimezone: "UTC",
          effectiveTimezone: "UTC",
        });
      }
      if (url === "/api/admin/overview") {
        return jsonResponse({
          counts: { accounts: 1, customerUsers: 1, controllers: 0, onlineControllers: 0, firmwareReleases: 0, catalogBoards: 0 },
          recentActivity: [],
        });
      }
      if (url.startsWith("/api/admin/notifications?")) {
        return jsonResponse({ unreadCount: 0, notifications: [] });
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    window.history.pushState({}, "", "/");
    const userView = render(<App />);

    // Customer Console uses Dynamic Island instead of <header>
    const islandShell = await screen.findByTestId("dynamic-island-shell");
    expect(islandShell).toHaveAttribute("data-expanded", "false");
    expect(userView.container.querySelector("header")).toBeNull();
    expect(await screen.findByTestId("island-unread-dot")).toBeInTheDocument();

    // Full Screen 2D Floor Plan covers viewport while keeping Dynamic Island active and visible
    const fullScreenBtn = await screen.findByRole("button", { name: /^Full Screen$/i });
    await user.click(fullScreenBtn);
    expect(screen.getByTestId("floorplan-container")).toHaveAttribute("data-view-mode", "fullscreen");
    expect(document.documentElement.getAttribute("data-hc-fullscreen-map")).toBe("true");
    expect(screen.getByTestId("dynamic-island-shell")).toBeVisible();

    // Expanding Dynamic Island inside Full Screen map exposes toolbar controls above the map
    await user.click(screen.getByTestId("dynamic-island-face"));
    expect(islandShell).toHaveAttribute("data-expanded", "true");
    const toolbar = screen.getByTestId("dynamic-island-actions");
    expect(toolbar).toBeInTheDocument();

    // Open Quick Navigation launcher, press Escape to close popover first, then Escape again to collapse island (map stays fullscreen)
    const quickNavBtn = screen.getByRole("button", { name: /Quick navigation/i });
    await user.click(quickNavBtn);
    expect(await screen.findByTestId("island-launcher-panel")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("island-launcher-panel")).not.toBeInTheDocument();
    });
    expect(islandShell).toHaveAttribute("data-expanded", "true");

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(islandShell).toHaveAttribute("data-expanded", "false");
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId("dynamic-island-face"));
    });
    expect(screen.getByTestId("floorplan-container")).toHaveAttribute("data-view-mode", "fullscreen");

    // Exit Full Screen via header button before continuing island theme & notification checks
    await user.click(screen.getByRole("button", { name: /^Exit Full Screen$/i }));
    expect(document.documentElement.hasAttribute("data-hc-fullscreen-map")).toBe(false);

    // Re-expand and verify Theme toggle works inside Dynamic Island
    await user.click(screen.getByTestId("dynamic-island-face"));
    await user.click(screen.getByRole("button", { name: /Switch to dark mode/i }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    // Notifications popover inside Dynamic Island opens and clears unread count
    await user.click(
      within(screen.getByTestId("dynamic-island-actions")).getByRole("button", {
        name: /^Notifications$/i,
      })
    );
    expect(await screen.findByTestId("notification-popover-content")).toBeInTheDocument();
    expect(screen.getByText(/Hub S3 reconnected/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Mark all read/i }));
    await waitFor(() => {
      expect(screen.queryByTestId("notification-unread-badge")).not.toBeInTheDocument();
    });

    // Profile menu shows initials, household switcher, and Settings/Sign out items
    await user.click(screen.getByTestId("island-profile-trigger"));
    const profileMenu = await screen.findByTestId("island-profile-menu");
    expect(within(profileMenu).getByText("Alice Owner")).toBeInTheDocument();
    expect(within(profileMenu).getByRole("menuitemradio", { name: /Cabin Retreat/i })).toBeInTheDocument();
    expect(within(profileMenu).getByRole("menuitem", { name: /Account settings/i })).toBeInTheDocument();
    expect(within(profileMenu).getByRole("menuitem", { name: /Sign out/i })).toBeInTheDocument();

    // Switching household updates session
    await user.click(within(profileMenu).getByRole("menuitemradio", { name: /Cabin Retreat/i }));
    await waitFor(() => {
      expect(screen.getAllByText("Cabin Retreat").length).toBeGreaterThan(0);
    });
    userView.unmount();

    // Admin Console retains standard <header> topbar and has no Dynamic Island
    window.history.pushState({}, "", "/admin");
    const adminView = render(<App />);
    await screen.findByRole("heading", { name: /Platform Overview/i });
    expect(adminView.container.querySelector("header")).not.toBeNull();
    expect(screen.queryByTestId("dynamic-island-shell")).not.toBeInTheDocument();
    adminView.unmount();
    window.history.pushState({}, "", "/");
  });
});
