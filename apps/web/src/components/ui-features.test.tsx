import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEsp32S3N16R8PinMap, VERIFIED_BOARD_CATALOG } from "@homecoreos/shared";
import { TimezoneContext } from "../lib/timezone";
import { HomeFloorPlan } from "./floorplan/HomeFloorPlan";
import { InteractiveBoardPinout } from "./boards/InteractiveBoardPinout";
import { OtaProgressPipeline, UsbFlashStagePipeline } from "./firmware/FirmwareProgressPipeline";
import { SwitchEditorModal } from "./hardware/EntityModals";
import { ConsoleShell } from "./layout/ConsoleShell";
import { Card } from "./ui/card";
import { Toaster } from "./ui/sonner";
import { AutomationsPage } from "../features/user/AutomationsPage";
import { BoardLibraryPage } from "../features/user/BoardLibraryPage";
import { AdminBoardsPage } from "../features/admin/AdminAccountsAndBoardsPages";
import { ControllersPage } from "../features/user/ControllersPage";
import {
  DevicesPage,
  SensorsPage,
  SwitchesPage,
} from "../features/user/DevicesSwitchesSensorsPages";
import { FirmwarePage } from "../features/user/FirmwarePage";
import { UserSettingsPage } from "../features/user/ActivityAndSettingsPages";
import { NotificationsPage } from "../features/notifications/NotificationsPage";
import { NotificationBellPopover } from "./notifications/NotificationBellPopover";
import { BoardMultiSelect } from "./firmware/BoardMultiSelect";
import type {
  BoardProfileItem,
  ControllerItem,
  DeviceItem,
  FirmwareUpdateHistoryItem,
  HomeItem,
  RoomItem,
  SensorItem,
  SwitchItem,
} from "../features/types";
import type { HardwareContext } from "../lib/board-pin-helpers";

const originalFetch = globalThis.fetch;
const originalSecureContext = window.isSecureContext;

describe("HomecoreOS interactive UI workflows", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(window, "isSecureContext", {
      value: originalSecureContext,
      configurable: true,
    });
    try {
      delete (navigator as unknown as { serial?: unknown }).serial;
    } catch {
      // ignore if read-only in test env
    }
  });

  it("renders Interactive 2D Floor Plan, selects rooms, toggles switches, and opens Room Editor", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const homes: HomeItem[] = [{ id: "h1", account_id: "a1", name: "Main Home", timezone: "Asia/Dhaka" }];
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
        floor_w: 360,
        floor_h: 280,
        layout_config: { floorStyle: "wood" },
      },
      {
        id: "r2",
        account_id: "a1",
        home_id: "h1",
        name: "Kitchen",
        icon: "kitchen",
        floor_order: 2,
        grid_col_span: 1,
        room_type: "kitchen",
        floor_x: 360,
        floor_y: 0,
        floor_w: 320,
        floor_h: 280,
        layout_config: { floorStyle: "tile" },
      },
    ];
    const switches: SwitchItem[] = [
      {
        id: "sw1",
        account_id: "a1",
        home_id: "h1",
        room_id: "r1",
        controller_id: "c1",
        name: "Chandelier",
        gpio_pin: 4,
        inverted: false,
        is_on: true,
        is_online: true,
        last_changed_at: null,
      },
      {
        id: "sw2",
        account_id: "a1",
        home_id: "h1",
        room_id: "r2",
        controller_id: "c1",
        name: "Under Cabinet",
        gpio_pin: 5,
        inverted: false,
        is_on: false,
        is_online: true,
        last_changed_at: null,
      },
    ];

    const onReload = vi.fn();

    render(
      <TimezoneContext.Provider value="Asia/Dhaka">
        <HomeFloorPlan
          homes={homes}
          rooms={rooms}
          switches={switches}
          devices={[]}
          sensors={[]}
          onReload={onReload}
          canEdit
        />
      </TimezoneContext.Provider>
    );

    expect(screen.getByText(/Interactive 2D Home Floor Plan/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Chandelier/i).length).toBeGreaterThan(0);

    // Select Kitchen via keyboard Enter on its SVG room group
    const kitchenBtn = screen.getByRole("button", { name: "Kitchen room" });
    kitchenBtn.focus();
    await user.keyboard("{Enter}");
    expect(screen.getAllByText(/Under Cabinet/i).length).toBeGreaterThan(0);

    // Toggle Under Cabinet switch -> POST /api/switches/sw2/toggle
    const toggleBtn = screen.getByRole("switch", { name: /Toggle Under Cabinet/i });
    await user.click(toggleBtn);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/switches/sw2/toggle",
        expect.objectContaining({ method: "POST" })
      );
    });

    // Open Add Room modal
    await user.click(screen.getByRole("button", { name: /Add Room/i }));
    expect(
      screen.getByRole("heading", { name: /Add Room to Floor Plan/i })
    ).toBeInTheDocument();
  });

  it("renders truthful multi-stage USB and OTA firmware progress pipelines", () => {
    const otaUpdate: FirmwareUpdateHistoryItem = {
      id: "upd1",
      account_id: "a1",
      controller_id: "c1",
      release_id: "rel1",
      previous_version: "1.1.0",
      target_version: "1.2.0",
      update_type: "ota",
      status: "verifying",
      progress_percent: 82,
      error_message: null,
      started_at: "2026-11-10T10:00:00Z",
      completed_at: null,
    };

    render(
      <div>
        <UsbFlashStagePipeline
          stage="writing"
          percent={64}
          phase="Writing merged factory image..."
          chipDetected="ESP32-S3"
          flashSize="16MB"
          bytesWritten={655360}
          totalBytes={1024000}
          logs={["Stub running...", "Writing at 0x00010000... (64%)"]}
        />
        <OtaProgressPipeline update={otaUpdate} controllerName="Living Room Hub" />
      </div>
    );

    expect(screen.getByText(/Writing merged factory image/i)).toBeInTheDocument();
    expect(screen.getByText(/ESP32-S3 \(16MB\)/i)).toBeInTheDocument();
    expect(screen.getByText(/640 \/ 1000 KB/i)).toBeInTheDocument();
    expect(screen.getAllByText(/64%/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Living Room Hub · v1\.2\.0/i)).toBeInTheDocument();
    expect(screen.getByText(/Checking the update\.\.\./i)).toBeInTheDocument();
    expect(screen.getByText(/82%/i)).toBeInTheDocument();
  });

  it("renders ConsoleShell with fixed desktop sidebar and supports creating/editing automations via modal", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TimezoneContext.Provider value="Asia/Dhaka">
        <ConsoleShell
          consoleTitle="Main Console"
          navItems={[{ id: "rooms", label: "Rooms", icon: <span>R</span> }]}
          activeNav="rooms"
          onSelectNav={vi.fn()}
          userEmail="user@example.com"
          userName="Owner"
          onSignOut={vi.fn()}
          themeMode="light"
          onToggleTheme={vi.fn()}
        >
          <div>Workspace body</div>
        </ConsoleShell>
      </TimezoneContext.Provider>
    );

    const aside = container.querySelector("aside");
    expect(aside?.className).toContain("lg:fixed");

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/automations" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ automations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/automations" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            automations: [],
            automation: { id: "rule-1" },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/sensors") {
        return new Response(JSON.stringify({ sensors: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/switches") {
        return new Response(
          JSON.stringify({
            switches: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                account_id: "a1",
                home_id: "h1",
                room_id: null,
                controller_id: "c1",
                name: "Wall Switch",
                gpio_pin: 4,
                is_on: true,
                inverted: false,
                is_online: true,
                last_changed_at: null,
              },
              {
                id: "22222222-2222-4222-8222-222222222222",
                account_id: "a1",
                home_id: "h1",
                room_id: null,
                controller_id: "c1",
                name: "Night Light",
                gpio_pin: 5,
                is_on: false,
                inverted: false,
                is_online: true,
                last_changed_at: null,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/devices") {
        return new Response(JSON.stringify({ devices: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      <TimezoneContext.Provider value="Asia/Dhaka">
        <AutomationsPage canManage canOperate />
      </TimezoneContext.Provider>
    );

    const createBtn = await screen.findByRole("button", { name: /Create Rule/i });
    await user.click(createBtn);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/High Temp Exhaust Fan/i)).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText(/High Temp Exhaust Fan/i), "Night Light When Off");

    await user.click(screen.getByLabelText(/Trigger Type/i));
    await user.click(await screen.findByRole("option", { name: /Switch Turned ON \/ OFF/i }));

    await user.click(screen.getByLabelText(/When Switch Becomes/i));
    await user.click(await screen.findByRole("option", { name: /Turned OFF/i }));

    await user.click(screen.getByRole("button", { name: /Save Automation Rule/i }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (call) =>
          call[0] === "/api/automations" &&
          call[1]?.method === "POST"
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall![1]!.body as string);
      expect(body.triggerConfig.type).toBe("device_state");
      expect(body.triggerConfig.expectedState).toBe(false);
    });
  });

  it("edits an existing switch via SwitchEditorModal with PATCH and GPIO conflict detection", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const existingSwitch: SwitchItem = {
      id: "sw-edit-1",
      account_id: "a1",
      home_id: "h1",
      room_id: "r1",
      controller_id: "c1",
      name: "Hallway Sconce",
      gpio_pin: 4,
      inverted: false,
      is_on: false,
      is_online: true,
      last_changed_at: null,
    };

    const ctx: HardwareContext = {
      rooms: [
        {
          id: "r1",
          account_id: "a1",
          home_id: "h1",
          name: "Hallway",
          icon: "sofa",
          floor_order: 1,
          grid_col_span: 1,
        },
      ],
      controllers: [
        {
          id: "c1",
          account_id: "a1",
          home_id: "h1",
          name: "Hallway Hub",
          board_catalog_id: "b1",
          custom_board_id: null,
          board_model: "ESP32-S3",
          chip_variant: "ESP32-S3",
          flash_size_mb: 16,
          psram_size_mb: 8,
          status: "online",
          mqtt_connected: true,
          wifi_ssid: "HomeNet",
          wifi_rssi: -50,
          local_ip: "192.168.1.50",
          firmware_version: "1.0.0",
          hardware_uid: "AA:BB:CC:DD:EE:01",
          last_heartbeat_at: null,
          last_communication_at: null,
          paired_at: null,
          connection_history: [],
        },
      ],
      boardsById: new Map([
        [
          "b1",
          {
            id: "b1",
            slug: "esp32s3",
            manufacturer: "Espressif",
            model: "ESP32-S3",
            revision: "v1.0",
            chip_family: "esp32s3",
            chip_variant: "ESP32-S3",
            flash_size_mb: 16,
            psram_size_mb: 8,
            gpio_definitions: buildEsp32S3N16R8PinMap(),
          },
        ],
      ]),
      usedPinsByController: new Map([
        [
          "c1",
          [
            { entityKind: "switch", id: "sw-edit-1", name: "Hallway Sconce", pin: 4 },
            { entityKind: "device", id: "dev-2", name: "Door Lock", pin: 7 },
          ],
        ],
      ]),
    };

    const onSaved = vi.fn();

    render(
      <SwitchEditorModal
        open
        onOpenChange={vi.fn()}
        switchItem={existingSwitch}
        ctx={ctx}
        onSaved={onSaved}
      />
    );

    const pinInput = screen.getByLabelText(/GPIO Pin/i);
    await user.clear(pinInput);
    await user.type(pinInput, "7");
    expect(
      screen.getByText(/GPIO 7 is already assigned to device "Door Lock"/i)
    ).toBeInTheDocument();

    await user.clear(pinInput);
    await user.type(pinInput, "6");

    const nameInput = screen.getByLabelText(/Switch Name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Hallway Lamp");

    await user.click(screen.getByRole("button", { name: /Save Switch/i }));

      await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/switches/sw-edit-1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            name: "Hallway Lamp",
            controllerId: "c1",
            roomId: "r1",
            gpioPin: 6,
            invertedLogic: false,
          }),
        })
      );
      expect(onSaved).toHaveBeenCalled();
    });
  });

  it("renders ControllersPage Add Controller dropdown, Connection & Recovery details, Trash restore/permanent delete, and ReUI IconStack empty state", async () => {
    const user = userEvent.setup();
    let restored = false;

    const fetchMock = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/controllers") {
        return new Response(
          JSON.stringify({
            controllers: [
              {
                id: "c1",
                account_id: "a1",
                home_id: "h1",
                name: "Living Room Hub",
                board_catalog_id: "b1",
                custom_board_id: null,
                board_model: "ESP32-S3-DevKitC-1 N16R8",
                chip_variant: "ESP32-S3-N16R8",
                flash_size_mb: 16,
                psram_size_mb: 8,
                firmware_version: "1.1.0",
                hardware_uid: "AA:BB:CC:DD:EE:01",
                status: "offline",
                pairing_status: "paired",
                wifi_connected: true,
                mqtt_connected: false,
                wifi_ssid: "Home24G",
                wifi_rssi: -64,
                local_ip: "192.168.1.44",
                last_error: "Broker TLS connection timed out",
                last_error_at: "2026-11-10T10:00:00Z",
                last_heartbeat_at: "2026-11-10T10:00:00Z",
                last_communication_at: "2026-11-10T10:00:00Z",
                paired_at: "2026-11-09T10:00:00Z",
                connection_history: [],
                offline_recovery_instructions: ["Hold BOOT (GPIO0) for 3s to open setup AP"],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/controllers/trash") {
        return new Response(
          JSON.stringify({
            controllers: restored
              ? []
              : [
                  {
                    id: "c-trash",
                    account_id: "a1",
                    home_id: "h1",
                    name: "Garage Deleted Hub",
                    board_catalog_id: "b1",
                    custom_board_id: null,
                    board_model: "ESP32-S3",
                    chip_variant: "ESP32-S3",
                    flash_size_mb: 16,
                    psram_size_mb: 8,
                    firmware_version: "1.1.0",
                    hardware_uid: "AA:BB:CC:DD:EE:99",
                    status: "offline",
                    mqtt_connected: false,
                    wifi_ssid: null,
                    wifi_rssi: null,
                    local_ip: null,
                    last_heartbeat_at: null,
                    last_communication_at: null,
                    paired_at: null,
                    deleted_at: "2026-11-09T10:00:00Z",
                    days_remaining: 29,
                    recoverable_counts: { switches: 2, devices: 1, sensors: 1 },
                    connection_history: [],
                  },
                ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/controllers/c-trash/restore" && init?.method === "POST") {
        restored = true;
        return new Response(
          JSON.stringify({
            controller: { id: "c-trash", name: "Garage Deleted Hub" },
            restoredCounts: { switches: 2, devices: 1, sensors: 1 },
            pairingCode: "654321",
            expiresAt: "2026-11-10T12:00:00Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/boards/catalog") {
        return new Response(JSON.stringify({ boards: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/boards/custom") {
        return new Response(JSON.stringify({ boards: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/homes") {
        return new Response(
          JSON.stringify({ homes: [{ id: "h1", account_id: "a1", name: "Home", timezone: "UTC" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/firmware/releases") {
        return new Response(JSON.stringify({ releases: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(
      <TimezoneContext.Provider value="UTC">
        <ControllersPage canManage canOperate onNavigate={vi.fn()} />
      </TimezoneContext.Provider>
    );

    await waitFor(() => {
      expect(screen.getByText("Living Room Hub")).toBeInTheDocument();
    });
    expect(screen.getByText(/Wi-Fi Connected/i)).toBeInTheDocument();
    expect(screen.getByText(/MQTT Disconnected/i)).toBeInTheDocument();
    expect(screen.getByText(/Broker TLS connection timed out/i)).toBeInTheDocument();

    // Open Add Controller modal and verify the 4 simplified options
    await user.click(screen.getByRole("button", { name: /Add Controller/i }));
    expect(screen.getByText(/New Controller Setup/i)).toBeInTheDocument();
    expect(screen.getByText(/Setup with BLE/i)).toBeInTheDocument();
    expect(screen.getByText(/Setup with Wi-Fi/i)).toBeInTheDocument();
    expect(screen.getByText(/Recover with BLE/i)).toBeInTheDocument();
    expect(screen.getByText(/Recover with Wi-Fi/i)).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // Switch to Trash tab, verify recoverable counts & restore -> renders IconStack empty state afterward
    await user.click(screen.getByRole("tab", { name: /Trash \(1\)/i }));
    expect(screen.getByText("Garage Deleted Hub")).toBeInTheDocument();
    expect(screen.getByText(/29 days left/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Restore Controller/i }));
    await waitFor(() => {
      expect(screen.getByText("654321")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Done/i }));
    await user.click(screen.getByRole("tab", { name: /Trash \(0\)/i }));
    expect(screen.getByText(/Controller Trash is empty/i)).toBeInTheDocument();
    expect(document.querySelector('[data-slot="icon-stack"]')).not.toBeNull();
  });

  it("renders two-tab Firmware & Updates page with applicable updates, cancel action, ReUI IconStack empty states, and Card interactive styling", async () => {
    const user = userEvent.setup();
    let updatesCount = 1;

    const fetchMock = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/firmware/releases") {
        return new Response(
          JSON.stringify({
            releases: [
              {
                id: "rel-1",
                name: "HomecoreOS Core",
                version: "1.3.0",
                channel: "stable",
                chip_family: "esp32s3",
                compatible_board_ids: ["b1"],
                ota_available: true,
                usb_available: true,
                status: "published",
                release_notes: "Recovery portal improvements",
                published_at: "2026-11-10T09:00:00Z",
                files: [
                  {
                    id: "f1",
                    release_id: "rel-1",
                    file_type: "usb_factory",
                    file_name: "homecoreos-factory.bin",
                    size_bytes: 1048576,
                    sha256: "abc123",
                    flash_address: "0x0",
                    flash_mode: "dio",
                    flash_freq: "80m",
                    flash_size: "16MB",
                    validated: true,
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/boards/catalog") {
        return new Response(
          JSON.stringify({
            boards: [
              {
                id: "b1",
                slug: "esp32-s3",
                manufacturer: "Espressif",
                model: "ESP32-S3-DevKitC-1",
                revision: "v1",
                chip_family: "esp32s3",
                chip_variant: "ESP32-S3",
                flash_size_mb: 16,
                psram_size_mb: 8,
                gpio_definitions: [],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/boards/custom") {
        return new Response(JSON.stringify({ boards: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/firmware/updates") {
        return new Response(
          JSON.stringify({
            applicableUpdates:
              updatesCount > 0
                ? [
                    {
                      controllerId: "c1",
                      controllerName: "Hallway Hub",
                      boardModel: "ESP32-S3-DevKitC-1",
                      controllerStatus: "online",
                      currentVersion: "1.1.0",
                      availableRelease: {
                        id: "rel-1",
                        name: "HomecoreOS Core",
                        version: "1.3.0",
                        channel: "stable",
                        chip_family: "esp32s3",
                        release_notes: "Recovery portal improvements",
                        published_at: "2026-11-10T09:00:00Z",
                      },
                      activeUpdate: {
                        id: "upd-1",
                        account_id: "a1",
                        controller_id: "c1",
                        release_id: "rel-1",
                        update_type: "ota",
                        previous_version: "1.1.0",
                        target_version: "1.3.0",
                        status: "pending",
                        progress_percent: 5,
                        error_message: null,
                        started_at: "2026-11-10T10:00:00Z",
                        completed_at: null,
                      },
                    },
                  ]
                : [],
            history: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/firmware/ota/upd-1/cancel" && init?.method === "POST") {
        updatesCount = 0;
        return new Response(JSON.stringify({ update: { id: "upd-1", status: "cancelled" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { container } = render(
      <div>
        <Card data-testid="static-card">Static</Card>
        <Card interactive data-testid="interactive-card">Interactive</Card>
        <TimezoneContext.Provider value="UTC">
          <FirmwarePage canManage onNavigate={vi.fn()} />
        </TimezoneContext.Provider>
      </div>
    );

    expect(screen.getByTestId("static-card")).not.toHaveAttribute("data-interactive");
    expect(screen.getByTestId("interactive-card")).toHaveAttribute("data-interactive", "true");
    expect(screen.getByTestId("interactive-card").className).toContain("hover:-translate-y-0.5");

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Firmware \(1\)/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /Updates \(1\)/i })).toBeInTheDocument();
    });

    // Tab 1 shows interactive release card & Inspect Details modal
    await user.click(screen.getByRole("button", { name: /Inspect Details/i }));
    expect(screen.getByText(/SHA-256: abc123/i)).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // Tab 2 shows compatible update with Cancel action, then IconStack empty state when none apply
    await user.click(screen.getByRole("tab", { name: /Updates \(1\)/i }));
    expect(screen.getAllByText(/Hallway Hub/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/v1\.3\.0/i).length).toBeGreaterThan(0);

    const cancelButtons = screen.getAllByRole("button", { name: /^Cancel$/i });
    await user.click(cancelButtons[0]);

    await waitFor(() => {
      expect(screen.getByText(/All controllers are up to date/i)).toBeInTheDocument();
    });
    expect(container.querySelector('[data-slot="icon-stack"]')).not.toBeNull();
  });

  it("supports HomeFloorPlan zoom/fit controls, lighting-only warm glow, and clicking animated SVG fixtures", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const homes: HomeItem[] = [{ id: "h1", account_id: "a1", name: "Main", timezone: "UTC" }];
    const rooms: RoomItem[] = [
      {
        id: "r1",
        account_id: "a1",
        home_id: "h1",
        name: "Media Lounge",
        icon: "sofa",
        floor_order: 1,
        grid_col_span: 1,
        room_type: "living_room",
        floor_x: 0,
        floor_y: 0,
        floor_w: 360,
        floor_h: 260,
      },
      {
        id: "r2",
        account_id: "a1",
        home_id: "h1",
        name: "Study",
        icon: "desk",
        floor_order: 2,
        grid_col_span: 1,
        room_type: "office",
        floor_x: 360,
        floor_y: 0,
        floor_w: 320,
        floor_h: 260,
      },
    ];
    const devices: DeviceItem[] = [
      {
        id: "dev-tv-1",
        account_id: "a1",
        home_id: "h1",
        room_id: "r1",
        controller_id: "c1",
        name: "OLED TV",
        device_type: "tv",
        gpio_pin: 12,
        state: "on",
        is_online: true,
      },
    ];
    const switches: SwitchItem[] = [
      {
        id: "sw-desk-lamp",
        account_id: "a1",
        home_id: "h1",
        room_id: "r2",
        controller_id: "c1",
        name: "Desk Lamp",
        gpio_pin: 4,
        inverted: false,
        is_on: true,
        is_online: true,
        last_changed_at: null,
      },
    ];

    const { container } = render(
      <TimezoneContext.Provider value="UTC">
        <HomeFloorPlan
          homes={homes}
          rooms={rooms}
          switches={switches}
          devices={devices}
          sensors={[]}
          onReload={vi.fn()}
          canEdit
        />
      </TimezoneContext.Provider>
    );

    // Only Study (with lighting switch ON) gets warm glow; Media Lounge with TV ON does NOT!
    const warmGlowRects = container.querySelectorAll('rect[fill="url(#hc-room-warm-glow)"]');
    expect(warmGlowRects.length).toBe(1);

    // Zoom controls & Fit button
    expect(screen.getByText("100%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Zoom in floor plan/i }));
    expect(screen.getByText("120%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Reset floor plan view/i }));
    expect(screen.getByText("100%")).toBeInTheDocument();

    // No room jump pill row above map
    expect(screen.queryByRole("button", { name: /Jump to /i })).not.toBeInTheDocument();

    // Header bar hosts tooltip trigger, view switcher, Arrange Floor Plan, and Add Room
    const headerBar = screen.getByTestId("floorplan-header-bar");
    expect(within(headerBar).getByRole("button", { name: /Arrange Floor Plan/i })).toBeInTheDocument();
    expect(within(headerBar).getByRole("button", { name: /Add Room/i })).toBeInTheDocument();

    // Hovering / focusing info trigger reveals exact tooltip title & body
    const infoBtn = within(headerBar).getByRole("button", {
      name: /Interactive 2D Home Floor Plan details/i,
    });
    await user.hover(infoBtn);
    expect(
      await screen.findByText(
        /Click fixtures directly on the map to toggle hardware, drag to pan, or jump between rooms\./i
      )
    ).toBeInTheDocument();

    // 3-state view switching: Standard View -> Wide View -> Full Screen -> Exit Full Screen
    const containerEl = screen.getByTestId("floorplan-container");
    expect(containerEl).toHaveAttribute("data-view-mode", "standard");

    await user.click(within(headerBar).getByRole("button", { name: /^Wide View$/i }));
    expect(containerEl).toHaveAttribute("data-view-mode", "wide");

    await user.click(within(headerBar).getByRole("button", { name: /^Full Screen$/i }));
    expect(containerEl).toHaveAttribute("data-view-mode", "fullscreen");
    expect(containerEl.className).toContain("fixed");
    expect(containerEl.className).toContain("inset-0");
    expect(document.documentElement.getAttribute("data-hc-fullscreen-map")).toBe("true");

    // Clicking a room in Full Screen opens its controls & sensors popup inside the blueprint
    await user.click(screen.getByRole("button", { name: /^Media Lounge room$/i }));
    const popup = await screen.findByTestId("fullscreen-room-popup");
    expect(popup.closest(".hc-blueprint-bg")).not.toBeNull();
    expect(within(popup).getByText(/OLED TV/i)).toBeInTheDocument();

    // First Escape closes room popup, second Escape exits Full Screen back to Standard View
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("fullscreen-room-popup")).not.toBeInTheDocument();
    expect(containerEl).toHaveAttribute("data-view-mode", "fullscreen");

    await user.keyboard("{Escape}");
    expect(containerEl).toHaveAttribute("data-view-mode", "standard");
    expect(document.documentElement.hasAttribute("data-hc-fullscreen-map")).toBe(false);

    // Select Media Lounge in Standard View and inspect TV control
    await user.click(screen.getByRole("button", { name: /^Media Lounge room$/i }));
    expect(screen.getAllByText(/OLED TV/i).length).toBeGreaterThan(0);

    // Clicking TV fixture directly toggles TV state via POST /api/devices/dev-tv-1/command
    const tvFixture = container.querySelector('[data-fixture-id="dev-tv-1"]')!;
    expect(tvFixture).toBeTruthy();
    await user.click(tvFixture);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/devices/dev-tv-1/command",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ state: "off" }),
        })
      );
    });
  });

  it("renders NotificationBellPopover, NotificationsPage actions, and UserSettingsPage notification preferences", async () => {
    const user = userEvent.setup();
    let notifications = [
      {
        id: "n-1",
        scope: "user" as const,
        account_id: "a1",
        category: "controller",
        event_key: "controller.offline",
        severity: "warning" as const,
        title: "Controller Offline: Main Hub",
        message: "Main Hub has not sent a heartbeat.",
        metadata: {},
        is_read: false,
        read_at: null,
        created_at: "2026-11-10T10:00:00Z",
      },
      {
        id: "n-2",
        scope: "user" as const,
        account_id: "a1",
        category: "firmware",
        event_key: "firmware.update_available",
        severity: "info" as const,
        title: "Firmware Update Available: v1.5.0",
        message: "OTA release ready for Main Hub.",
        metadata: {},
        is_read: true,
        read_at: "2026-11-10T09:00:00Z",
        created_at: "2026-11-10T08:00:00Z",
      },
    ];
    const prefs = {
      controller_offline_online: true,
      device_disconnected: true,
      sensor_alerts: true,
      automation_failures: true,
      firmware_updates: true,
      firmware_install_results: true,
      security_events: true,
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/notifications?") && (!init?.method || init.method === "GET")) {
        const parsedUrl = new URL(url, "https://homecore.local");
        const status = parsedUrl.searchParams.get("status");
        const list =
          status === "unread" ? notifications.filter((n) => !n.is_read) : notifications;
        const unreadCount = notifications.filter((n) => !n.is_read).length;
        return new Response(JSON.stringify({ notifications: list, unreadCount }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/notifications/mark-all-read" && init?.method === "POST") {
        notifications = notifications.map((n) => ({ ...n, is_read: true }));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/unread") && init?.method === "POST") {
        const id = url.split("/")[3];
        notifications = notifications.map((n) => (n.id === id ? { ...n, is_read: false } : n));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.startsWith("/api/notifications/") && init?.method === "DELETE") {
        const id = url.split("/").pop();
        notifications = notifications.filter((n) => n.id !== id);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/notifications/preferences" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ preferences: prefs }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/notifications/preferences" && init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body ?? "{}"));
        Object.assign(prefs, patch);
        return new Response(JSON.stringify({ preferences: prefs }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/auth/sessions") {
        return new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/account/staff") {
        return new Response(JSON.stringify({ staff: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const onNavigate = vi.fn();

    render(
      <TimezoneContext.Provider value="UTC">
        <div>
          <NotificationBellPopover scope="user" onNavigate={onNavigate} />
          <NotificationsPage scope="user" onNavigate={onNavigate} />
          <UserSettingsPage
            session={{
              user: {
                id: "u1",
                email: "owner@example.com",
                fullName: "Owner",
                appearancePreference: "light",
                timezone: null,
              },
              account: {
                id: "a1",
                name: "Main Home",
                slug: "main-home",
                status: "active",
                staffRole: "owner",
              },
              accounts: [
                {
                  id: "a1",
                  name: "Main Home",
                  slug: "main-home",
                  status: "active",
                  staffRole: "owner",
                },
              ],
            }}
            onSessionRefresh={vi.fn(async () => {})}
          />
        </div>
      </TimezoneContext.Provider>
    );

    // Unread badge = 1, popover opens and marks all read
    await waitFor(() => {
      expect(screen.getByTestId("notification-unread-badge")).toHaveTextContent("1");
    });

    await user.click(screen.getByRole("button", { name: /^Notifications$/i }));
    expect(await screen.findByText(/View all notifications/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Mark all read$/i }));
    await waitFor(() => {
      expect(screen.queryByTestId("notification-unread-badge")).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /View all notifications/i }));
    expect(onNavigate).toHaveBeenCalledWith("/notifications");

    // NotificationsPage toggles unread filter and deletes an alert
    await user.click(screen.getByLabelText(/Unread only/i));
    await waitFor(() => {
      expect(screen.getByText(/No unread notifications/i)).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText(/Unread only/i));
    await waitFor(() => {
      expect(screen.getByText(/Controller Offline: Main Hub/i)).toBeInTheDocument();
    });

    const delButtons = screen.getAllByRole("button", { name: /Delete notification/i });
    await user.click(delButtons[0]!);
    await waitFor(() => {
      expect(screen.queryByText(/Controller Offline: Main Hub/i)).not.toBeInTheDocument();
    });

    // UserSettingsPage notification preference switch calls PATCH /api/notifications/preferences
    const fwToggle = await screen.findByRole("switch", { name: /New Firmware Releases/i });
    await user.click(fwToggle);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/notifications/preferences",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ firmware_updates: false }),
        })
      );
    });
  });

  it("opens dedicated USB Browser Flasher Dialog and guards active flash close with AlertDialog", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "isSecureContext", {
      value: true,
      configurable: true,
    });
    (navigator as unknown as { serial?: unknown }).serial = {
      requestPort: vi.fn(),
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/firmware/releases") {
        return new Response(
          JSON.stringify({
            releases: [
              {
                id: "rel-usb-1",
                name: "HomecoreOS Core",
                version: "1.4.0",
                channel: "stable",
                chip_family: "esp32s3",
                compatible_board_ids: ["b1"],
                ota_available: true,
                usb_available: true,
                status: "published",
                release_notes: "Consolidated config sync",
                published_at: "2026-11-10T09:00:00Z",
                files: [
                  {
                    id: "f1",
                    release_id: "rel-usb-1",
                    file_type: "usb_factory",
                    file_name: "factory.bin",
                    size_bytes: 524288,
                    sha256: "abc",
                    flash_address: "0x0",
                    flash_mode: "dio",
                    flash_freq: "80m",
                    flash_size: "16MB",
                    validated: true,
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/firmware/files/f1/download") {
        // Keep download pending so flashing=true remains active during close test
        return new Promise<Response>(() => {});
      }
      if (url === "/api/boards/catalog") {
        return new Response(JSON.stringify({ boards: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/boards/custom") {
        return new Response(JSON.stringify({ boards: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/firmware/updates") {
        return new Response(JSON.stringify({ applicableUpdates: [], history: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(
      <TimezoneContext.Provider value="UTC">
        <FirmwarePage canManage onNavigate={vi.fn()} />
      </TimezoneContext.Provider>
    );

    const flashBtn = await screen.findByRole("button", { name: /USB Browser Flasher/i });
    await user.click(flashBtn);

    expect(
      await screen.findByText(/Install on a Fresh Controller \(Browser USB Flasher\)/i)
    ).toBeInTheDocument();

    // Start flashing -> stays in active flashing state while downloading
    await user.click(screen.getByRole("button", { name: /Connect USB & Flash Factory Image/i }));
    await waitFor(() => {
      expect(screen.getByText(/Flashing via USB\.\.\./i)).toBeInTheDocument();
    });

    // Attempting to close via Escape opens AlertDialog confirmation
    await user.keyboard("{Escape}");
    expect(await screen.findByText(/USB Flash Currently in Progress/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Keep Open/i }));
    expect(screen.queryByText(/USB Flash Currently in Progress/i)).not.toBeInTheDocument();
  });

  it("renders BoardMultiSelect with chip mismatch warning badge and bulk ESP32S3 selection", async () => {
    const user = userEvent.setup();
    const boards: BoardProfileItem[] = [
      {
        id: "b-s3",
        slug: "esp32-s3-n16r8",
        manufacturer: "Espressif",
        model: "ESP32-S3 DevKitC N16R8",
        revision: "v1.0",
        chip_family: "esp32s3",
        chip_variant: "ESP32-S3",
        flash_size_mb: 16,
        psram_size_mb: 8,
        gpio_definitions: [],
      },
      {
        id: "b-c3",
        slug: "esp32-c3-mini",
        manufacturer: "Espressif",
        model: "ESP32-C3 Mini",
        revision: "v1.0",
        chip_family: "esp32c3",
        chip_variant: "ESP32-C3",
        flash_size_mb: 4,
        psram_size_mb: 0,
        gpio_definitions: [],
      },
    ];
    let selected = ["b-c3"];
    const onChange = vi.fn((next: string[]) => {
      selected = next;
    });

    const { rerender } = render(
      <BoardMultiSelect
        boards={boards}
        selectedIds={selected}
        onChange={onChange}
        chipFamily="esp32s3"
      />
    );

    // Chip badge displays selected mismatched board
    expect(screen.getByText(/ESP32-C3 Mini \(4MB\)/i)).toBeInTheDocument();

    // Open popover -> shows Chip mismatch badge & Select all ESP32S3 boards action
    await user.click(screen.getByRole("combobox", { name: /Compatible Boards/i }));
    expect(screen.getByText(/Chip mismatch/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Select all ESP32S3 boards/i }));
    expect(onChange).toHaveBeenCalledWith(["b-c3", "b-s3"]);

    rerender(
      <BoardMultiSelect
        boards={boards}
        selectedIds={selected}
        onChange={onChange}
        chipFamily="esp32s3"
      />
    );

    await user.click(screen.getByRole("button", { name: /Remove ESP32-C3 Mini/i }));
    expect(onChange).toHaveBeenLastCalledWith(["b-s3"]);
  });

  it("builds multi-trigger, AND/OR conditions, and scene actions in Visual Automation Builder with dry-run test and save", async () => {
    const user = userEvent.setup();
    const sensor1: SensorItem = {
      id: "11111111-1111-4111-8111-111111111111",
      account_id: "a1",
      home_id: "h1",
      room_id: "r1",
      controller_id: "c1",
      name: "Living Temp",
      sensor_type: "dht22",
      gpio_pin: 5,
      unit: "°C",
      last_value: 29,
      last_raw_payload: null,
      is_online: true,
      last_reading_at: null,
    };
    const switch1: SwitchItem = {
      id: "22222222-2222-4222-8222-222222222222",
      account_id: "a1",
      home_id: "h1",
      room_id: "r1",
      controller_id: "c1",
      name: "Porch Light",
      gpio_pin: 4,
      is_on: false,
      inverted: false,
      is_online: true,
      last_changed_at: null,
    };
    const room1: RoomItem = {
      id: "33333333-3333-4333-8333-333333333333",
      account_id: "a1",
      home_id: "h1",
      name: "Living Room",
      icon: "sofa",
      floor_order: 1,
      grid_col_span: 1,
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/automations" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ automations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/sensors") {
        return new Response(JSON.stringify({ sensors: [sensor1] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/switches") {
        return new Response(JSON.stringify({ switches: [switch1] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/devices") {
        return new Response(JSON.stringify({ devices: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/homes/rooms") {
        return new Response(JSON.stringify({ rooms: [room1] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/controllers") {
        return new Response(
          JSON.stringify({
            controllers: [
              {
                id: "c1",
                account_id: "a1",
                home_id: "h1",
                board_catalog_id: null,
                custom_board_id: null,
                name: "Main Hub",
                hardware_uid: "esp-1",
                board_model: "ESP32-S3",
                chip_variant: "ESP32-S3",
                flash_size_mb: 16,
                psram_size_mb: 8,
                firmware_version: "1.2.0",
                status: "online",
                mqtt_connected: true,
                wifi_ssid: "Home",
                wifi_rssi: -50,
                local_ip: "192.168.1.20",
                last_heartbeat_at: null,
                last_communication_at: null,
                paired_at: null,
                connection_history: [],
              } satisfies ControllerItem,
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/automations/test") {
        return new Response(
          JSON.stringify({
            ok: true,
            dryRun: true,
            conditionsMatched: true,
            conditionTrace: [],
            plannedActions: [
              { type: "switch_on", targetName: "act-1", summary: "Turn ON Porch Light" },
            ],
            flowTrace: {
              evaluatedAt: "2026-11-10T12:00:00Z",
              triggered: true,
              conditionsMatched: true,
              executed: false,
              nodeResults: {
                "trig-1": {
                  nodeId: "trig-1",
                  label: "Sensor Trigger",
                  kind: "trigger",
                  status: "passed",
                  detail: "Simulated trigger active",
                },
              },
              edgeStates: {},
              variablesSnapshot: {},
              actionsPlanned: [
                {
                  nodeId: "act-1",
                  actionType: "switch_on",
                  detail: "Turn ON Porch Light",
                },
              ],
              notes: [],
            },
            executedCount: 0,
            errors: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ ok: true, automation: { id: "a-new" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      <TimezoneContext.Provider value="Asia/Dhaka">
        <AutomationsPage canManage canOperate />
      </TimezoneContext.Provider>
    );

    const builderTab = await screen.findByRole("tab", { name: /Visual Builder/i });
    await user.click(builderTab);

    expect(screen.getByTestId("visual-flow-canvas")).toBeInTheDocument();

    // Clean full-width canvas by default (no side inspector or minimap clutter)
    expect(screen.queryByRole("button", { name: /Close inspector/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Flows \(0\)/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Settings/i })).toBeInTheDocument();

    // Validation catches missing flow name before save
    await user.click(screen.getByRole("button", { name: /Save Flow/i }));
    expect(await screen.findByText(/Flow name is required\./i)).toBeInTheDocument();

    // Fill flow name, folder, add Condition + Delay nodes, and auto-arrange
    await user.type(screen.getByLabelText(/Automation Name/i), "Sunset Porch Scene");
    const folderInput = screen.getByLabelText(/^Folder$/i);
    await user.clear(folderInput);
    await user.type(folderInput, "First Floor");

    await user.click(screen.getByRole("button", { name: /\+ If/i }));
    expect(screen.getByRole("button", { name: /Close inspector/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\+ True Action/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\+ False Action/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /\+ Delay/i }));
    expect(screen.getByRole("button", { name: /\+ Next Action/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Auto-Arrange/i }));
    await user.click(screen.getByRole("button", { name: /Close inspector/i }));
    expect(screen.queryByRole("button", { name: /Close inspector/i })).not.toBeInTheDocument();

    // Cloud Engine badge appears when Delay node is present
    expect(screen.getAllByText(/Cloud Engine/i).length).toBeGreaterThan(0);

    // Dry-run test calls /api/automations/test with flowGraph and renders trace
    await user.click(screen.getByRole("button", { name: /Test \(Dry Run\)/i }));
    expect(await screen.findByText(/Dry-Run Flow Evaluation Trace/i)).toBeInTheDocument();
    expect(screen.getByText(/Conditions Matched/i)).toBeInTheDocument();

    // Save flow -> submits flowGraph, folderName, and compiled rule configs
    await user.click(screen.getByRole("button", { name: /Save Flow/i }));
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c) => c[0] === "/api/automations" && c[1]?.method === "POST"
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall![1]!.body as string);
      expect(body.name).toBe("Sunset Porch Scene");
      expect(body.folderName).toBe("First Floor");
      expect(body.flowGraph.nodes.some((n: { kind: string }) => n.kind === "condition")).toBe(true);
      expect(body.flowGraph.nodes.some((n: { kind: string }) => n.kind === "delay")).toBe(true);
      expect(body.flowGraph.edges.length).toBeGreaterThan(0);
    });
  });

  it("renders redesigned ReUI Devices, Switches, and Sensors cards with Switch control, optimistic rollback, and three-dot DropdownMenu actions", async () => {
    const user = userEvent.setup();
    const rooms: RoomItem[] = [
      {
        id: "r1",
        account_id: "a1",
        home_id: "h1",
        name: "Living Room",
        icon: "sofa",
        floor_order: 1,
        grid_col_span: 1,
      },
      {
        id: "r2",
        account_id: "a1",
        home_id: "h1",
        name: "Bedroom",
        icon: "bed",
        floor_order: 2,
        grid_col_span: 1,
      },
    ];
    const ctrl: ControllerItem = {
      id: "c1",
      account_id: "a1",
      home_id: "h1",
      board_catalog_id: null,
      custom_board_id: null,
      name: "Living Hub",
      hardware_uid: "esp-01",
      board_model: "ESP32-S3",
      chip_variant: "ESP32-S3",
      flash_size_mb: 16,
      psram_size_mb: 8,
      firmware_version: "1.2.0",
      status: "online",
      mqtt_connected: true,
      wifi_ssid: "Home",
      wifi_rssi: -48,
      local_ip: "192.168.1.42",
      last_heartbeat_at: null,
      last_communication_at: null,
      paired_at: null,
      connection_history: [],
    };
    const dev: DeviceItem = {
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
    };
    const sw: SwitchItem = {
      id: "sw1",
      account_id: "a1",
      home_id: "h1",
      room_id: "r1",
      controller_id: "c1",
      name: "Hallway Lamp",
      gpio_pin: 4,
      is_on: false,
      inverted: false,
      is_online: true,
      last_changed_at: null,
    };
    const sen: SensorItem = {
      id: "sen1",
      account_id: "a1",
      home_id: "h1",
      room_id: "r1",
      controller_id: "c1",
      name: "Room Thermometer",
      sensor_type: "dht22",
      gpio_pin: 5,
      unit: "°C",
      last_value: 24.6,
      last_raw_payload: null,
      is_online: true,
      last_reading_at: "2026-11-10T08:00:00.000Z",
    };

    let failDeviceCmd = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/devices") {
        return new Response(JSON.stringify({ devices: [dev] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/switches") {
        return new Response(JSON.stringify({ switches: [sw] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/sensors") {
        return new Response(JSON.stringify({ sensors: [sen] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/controllers") {
        return new Response(JSON.stringify({ controllers: [ctrl] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/homes/rooms") {
        return new Response(JSON.stringify({ rooms }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/boards/catalog" || url === "/api/boards/my-boards") {
        return new Response(JSON.stringify({ boards: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/devices/d1/command" && init?.method === "POST") {
        if (failDeviceCmd) {
          return new Response(JSON.stringify({ error: "Device broker offline" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ device: { ...dev, state: "active" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/devices/d1" && init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ device: { ...dev, room_id: "r2" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // 1. DevicesPage: ReUI Switch, no inline Activate/Edit/Remove buttons, optimistic rollback, three-dot DropdownMenu
    const devView = render(
      <TimezoneContext.Provider value="UTC">
        <DevicesPage canManage canOperate />
        <Toaster />
      </TimezoneContext.Provider>
    );

    const fanSwitch = await screen.findByRole("switch", { name: "Toggle Ceiling Fan" });
    expect(screen.queryByRole("button", { name: /^Activate$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/GPIO12/i)).not.toBeInTheDocument();
    expect(fanSwitch).toHaveAttribute("aria-checked", "false");

    // Failed command rolls back optimistic UI and displays error toast
    await user.click(fanSwitch);
    await waitFor(() => {
      expect(screen.getByText(/Device broker offline/i)).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: "Toggle Ceiling Fan" })).toHaveAttribute(
        "aria-checked",
        "false"
      );
    });

    // Successful toggle keeps ON state
    failDeviceCmd = false;
    await user.click(screen.getByRole("switch", { name: "Toggle Ceiling Fan" }));
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Toggle Ceiling Fan" })).toHaveAttribute(
        "aria-checked",
        "true"
      );
    });

    // Open three-dot DropdownMenu -> View details shows GPIO12 cleanly in modal
    await user.click(screen.getByRole("button", { name: "Actions for Ceiling Fan" }));
    await user.click(await screen.findByRole("menuitem", { name: /View details/i }));
    expect(await screen.findByText(/GPIO12/i)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /^Close$/i })[0]!);

    // Open three-dot DropdownMenu -> Move to another room
    await user.click(screen.getByRole("button", { name: "Actions for Ceiling Fan" }));
    await user.click(await screen.findByRole("menuitem", { name: /Move to another room/i }));
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Bedroom" }));
    await user.click(screen.getByRole("button", { name: /Move to Room/i }));
    await waitFor(() => {
      expect(screen.getByText("Bedroom")).toBeInTheDocument();
    });
    devView.unmount();

    // 2. SwitchesPage: clean card + three-dot DropdownMenu without inline Select/Remove clutter
    const swView = render(
      <TimezoneContext.Provider value="UTC">
        <SwitchesPage canManage canOperate />
      </TimezoneContext.Provider>
    );
    expect(await screen.findByRole("switch", { name: "Toggle Hallway Lamp" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/GPIO4/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actions for Hallway Lamp" }));
    expect(await screen.findByRole("menuitem", { name: /Edit/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Move to another room/i })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: /Delete/i }));
    await user.click(await screen.findByRole("button", { name: /Remove Switch/i }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          (c) => c[0] === "/api/switches/sw1" && c[1]?.method === "DELETE"
        )
      ).toBe(true);
    });
    swView.unmount();

    // 3. SensorsPage: actual reading + Online badge, NO ON/OFF switch, three-dot DropdownMenu
    const senView = render(
      <TimezoneContext.Provider value="UTC">
        <SensorsPage canManage />
      </TimezoneContext.Provider>
    );
    expect(await screen.findByText("24.6 °C")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actions for Room Thermometer" }));
    await user.click(await screen.findByRole("menuitem", { name: /View details/i }));
    expect(await screen.findByText(/GPIO5/i)).toBeInTheDocument();
    senView.unmount();
  });

  it("renders BoardLibraryPage with category/chip filters and InteractiveBoardPinout clickable hardware pin inspector", async () => {
    const user = userEvent.setup();
    const s3Board = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;
    const xiaoBoard = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "seeed-xiao-esp32s3")!;
    const catalogPayload: BoardProfileItem[] = [
      { ...s3Board, id: "cat-s3", is_available: true, compatible_firmware_count: 1 },
      { ...xiaoBoard, id: "cat-xiao", is_available: true, compatible_firmware_count: 0 },
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/boards/catalog") {
        return new Response(JSON.stringify({ boards: catalogPayload }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/boards/my-boards") {
        return new Response(JSON.stringify({ catalogBoards: [], customBoards: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = render(<BoardLibraryPage canManage />);

    expect(await screen.findByText(s3Board.model)).toBeInTheDocument();
    expect(screen.getAllByText(xiaoBoard.model).length).toBeGreaterThan(0);

    // Hub-style Hero Header with page title, subtitle, illustrations & centered search (no top-right Saved Boards button)
    expect(
      screen.getByRole("heading", { name: /HomecoreOS Board Library/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/GPIO Constraints,/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Saved Boards/i })).not.toBeInTheDocument();
    const heroSearch = screen.getByRole("textbox", { name: /Search board catalog/i });
    await user.type(heroSearch, "XIAO");
    expect(screen.queryByText(s3Board.model)).not.toBeInTheDocument();
    expect(screen.getAllByText(xiaoBoard.model).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /Clear search/i }));
    expect(screen.getByText(s3Board.model)).toBeInTheDocument();

    // Tabs and all 3 catalog filter dropdowns share the same horizontal row
    const tabList = screen.getByRole("tablist");
    const tabRow = tabList.parentElement!;
    const sourceFilter = screen.getByRole("combobox", { name: /Filter by board source/i });
    const chipFilter = screen.getByRole("combobox", { name: /Filter by chip family/i });
    const fwFilter = screen.getByRole("combobox", { name: /Filter by firmware support/i });
    expect(tabRow).toContainElement(sourceFilter);
    expect(tabRow).toContainElement(chipFilter);
    expect(tabRow).toContainElement(fwFilter);

    // Cards render in a compact 3-column desktop grid with crisp vector SVG board diagrams & specs
    expect(container.querySelector(".lg\\:grid-cols-3")).not.toBeNull();
    expect(container.querySelectorAll("img").length).toBe(0);
    expect(
      screen.getByRole("img", { name: new RegExp(`${s3Board.model} vector PCB diagram`, "i") })
    ).toBeInTheDocument();
    expect(screen.getAllByText(s3Board.chip_variant).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/16MB Flash \+ 8MB PSRAM/i).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /^Details$/i }).length).toBe(2);
    await user.click(screen.getAllByRole("button", { name: /^Details$/i })[0]!);
    expect(screen.getByRole("tab", { name: /board details/i })).toBeInTheDocument();
    expect(screen.getByText(/2x USB-C/i)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /pinout details/i }));
    expect(screen.getByText(/Pin Inspector/i)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /^Close$/i })[0]!);

    // Filter to Partner Boards via Source dropdown -> shows Seeed XIAO ESP32-S3
    await user.click(sourceFilter);
    await user.click(await screen.findByRole("option", { name: /Partner Boards/i }));
    expect(screen.getAllByText(xiaoBoard.model).length).toBeGreaterThan(0);
    expect(screen.queryByText(s3Board.model)).not.toBeInTheDocument();

    // Inspect interactive pinout directly for Seeed XIAO ESP32-S3
    const { container: pinContainer, unmount } = render(
      <InteractiveBoardPinout board={catalogPayload[1]!} />
    );
    expect(screen.getByText(/Pin Inspector/i)).toBeInTheDocument();
    expect(pinContainer.querySelector('svg[role="img"]')).not.toBeNull();
    expect(pinContainer.querySelectorAll("img").length).toBe(0);
    const d5Btn = screen.getByRole("button", { name: /D5/i });
    await user.click(d5Btn);
    expect(screen.getAllByText(/GPIO 6/i).length).toBeGreaterThan(0);
    unmount();
  });

  it("supports Official Espressif Catalog sync and verification publication guard on AdminBoardsPage", async () => {
    const user = userEvent.setup();
    const s3Board = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;
    const boardsPayload: BoardProfileItem[] = [
      { ...s3Board, id: "cat-s3", is_available: true },
      {
        id: "cat-unverified",
        slug: "esp32-c5-new-devkit",
        manufacturer: "Espressif",
        model: "ESP32-C5-New-DevKit",
        revision: "v1.0",
        chip_family: "esp32c5",
        chip_variant: "ESP32-C5",
        flash_size_mb: 8,
        psram_size_mb: 0,
        catalog_category: "official_espressif",
        verification_status: "needs_verification",
        firmware_status: "catalog_only",
        is_available: false,
        gpio_definitions: [],
      },
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/admin/boards" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ boards: boardsPayload, syncRuns: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/admin/boards/sync" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            run: {
              status: "succeeded",
              discoveredCount: 15,
              insertedCount: 1,
              updatedCount: 11,
              needsVerificationCount: 1,
              summaryNotes: "Synced from Espressif",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      <TimezoneContext.Provider value="UTC">
        <AdminBoardsPage />
        <Toaster />
      </TimezoneContext.Provider>
    );

    expect((await screen.findAllByText(/ESP32-C5-New-DevKit/i)).length).toBeGreaterThan(0);

    // Needs-verification board's Publish button must be disabled
    const publishButtons = screen.getAllByRole("button", { name: /^Publish$/i });
    expect(publishButtons[0]).toBeDisabled();

    // Sync Official Catalog calls POST /api/admin/boards/sync
    await user.click(screen.getByRole("button", { name: /Sync Official Catalog/i }));
    expect(await screen.findByText(/Official Espressif sync succeeded: 15 boards checked/i)).toBeInTheDocument();
  });

  it("renders medium 3-column Controller Cards with dropdown actions & details modal, non-overflowing Notification Popover actions, and responsive Firmware modals", async () => {
    const user = userEvent.setup();
    const longUrl =
      "https://updates.homecoreos.local/releases/1.2.9/esp32s3/very-long-unbroken-diagnostic-payload-0123456789abcdef0123456789abcdef";

    const ctrlList = [
      {
        id: "c-card-1",
        account_id: "a1",
        home_id: "h1",
        board_catalog_id: "b1",
        custom_board_id: null,
        board_model: "ESP32-S3-DevKitC-1",
        chip_variant: "ESP32-S3",
        flash_size_mb: 16,
        psram_size_mb: 8,
        name: "Living Room Hub",
        hardware_uid: "AA:BB:CC:DD:EE:01",
        firmware_version: "1.2.9",
        status: "online",
        pairing_status: "paired",
        wifi_connected: true,
        wifi_ssid: "HomeCore-2G",
        wifi_rssi: -52,
        local_ip: "192.168.1.44",
        mqtt_connected: false,
        last_error: "Broker TLS connection timed out",
        last_error_at: "2026-11-10T10:00:00Z",
        last_heartbeat_at: "2026-11-10T10:05:00Z",
        last_communication_at: "2026-11-10T10:05:00Z",
        paired_at: "2026-11-10T08:00:00Z",
        mqtt: { mqtt_username: "hc_1" },
        offline_recovery_instructions: ["Hold BOOT (GPIO0) for 3s to open setup AP."],
      },
    ];

    let notifList = [
      {
        id: "n-long-1",
        scope: "user" as const,
        category: "firmware" as const,
        event_key: "firmware.install_result",
        severity: "danger" as const,
        title: "OTA Update Rolled Back on Living Room Hub Controller With Long Diagnostic Title",
        message: `Checksum mismatch while verifying payload at ${longUrl}`,
        metadata: {},
        is_read: false,
        read_at: null,
        created_at: "2026-11-10T10:06:00Z",
      },
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/controllers") {
        return new Response(JSON.stringify({ controllers: ctrlList }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/controllers/trash") {
        return new Response(JSON.stringify({ controllers: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/boards/catalog" || url === "/api/boards/custom") {
        return new Response(JSON.stringify({ boards: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/homes") {
        return new Response(JSON.stringify({ homes: [{ id: "h1", name: "Main Home" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/firmware/releases") {
        return new Response(
          JSON.stringify({
            releases: [
              {
                id: "rel-resp-1",
                name: "HomecoreOS Core",
                version: "1.2.9",
                channel: "stable",
                chip_family: "esp32s3",
                compatible_board_ids: [],
                ota_available: true,
                usb_available: true,
                status: "published",
                release_notes: "OTA reliability release",
                published_at: "2026-11-10T09:00:00Z",
                files: [
                  {
                    id: "f-long-1",
                    release_id: "rel-resp-1",
                    file_type: "ota_app",
                    file_name: "homecoreos-v1.2.9-esp32-s3-ota-production-signed.bin",
                    size_bytes: 1048576,
                    sha256: "deadbeef1234567890deadbeef1234567890deadbeef1234567890deadbeef12",
                    flash_address: "0x10000",
                    flash_mode: "dio",
                    flash_freq: "80m",
                    flash_size: "16MB",
                    validated: true,
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/firmware/updates") {
        return new Response(JSON.stringify({ applicableUpdates: [], history: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.startsWith("/api/notifications?") && (!init?.method || init.method === "GET")) {
        return new Response(
          JSON.stringify({
            notifications: notifList,
            unreadCount: notifList.filter((n) => !n.is_read).length,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/notifications/n-long-1/read" && init?.method === "POST") {
        notifList = notifList.map((n) => (n.id === "n-long-1" ? { ...n, is_read: true } : n));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/notifications/n-long-1" && init?.method === "DELETE") {
        notifList = [];
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const onNavigate = vi.fn();
    const ctrlView = render(
      <TimezoneContext.Provider value="UTC">
        <div>
          <NotificationBellPopover scope="user" onNavigate={onNavigate} />
          <ControllersPage canManage canOperate onNavigate={onNavigate} />
          <FirmwarePage canManage onNavigate={onNavigate} />
        </div>
      </TimezoneContext.Provider>
    );

    // 1. Medium Controller Cards grid & top-right DropdownMenu + card click Details modal
    const cardGrid = await screen.findByTestId("controllers-card-grid");
    expect(cardGrid.className).toContain("md:grid-cols-2");
    expect(cardGrid.className).toContain("lg:grid-cols-3");
    expect(screen.getByText("Living Room Hub")).toBeInTheDocument();
    expect(screen.getByText(/Wi-Fi Connected/i)).toBeInTheDocument();
    expect(screen.getByText(/MQTT Disconnected/i)).toBeInTheDocument();

    // Clicking three-dot actions menu opens menu WITHOUT opening Details modal
    await user.click(screen.getByRole("button", { name: "Actions for Living Room Hub" }));
    expect(await screen.findByRole("menuitem", { name: /Configure Wi-Fi/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Recover with BLE/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Setup with BLE/i })).not.toBeInTheDocument();
    const recoverMenuItem = screen.getByRole("menuitem", { name: /Recover \/ Re-pair/i });
    expect(screen.queryByText(/Recovery Instructions \(online\)/i)).not.toBeInTheDocument();

    // Clicking single "Recover / Re-pair" opens the "Add or Recover Controller" modal
    await user.click(recoverMenuItem);
    expect(await screen.findByText(/Add or Recover Controller/i)).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // Click card -> opens Controller Details modal with full recovery guidance
    await user.click(screen.getByRole("button", { name: "View details for Living Room Hub" }));
    expect(await screen.findByText(/Recovery Instructions \(online\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Hold BOOT \(GPIO0\) for 3s to open setup AP/i)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /^Close$/i })[0]!);

    // 2. Notification Popover fixed header/footer, non-truncating wrapping, and click-to-open items (no Open / Mark read buttons)
    await user.click(screen.getByRole("button", { name: /^Notifications$/i }));
    expect(await screen.findByTestId("notification-popover-header")).toBeInTheDocument();
    const listEl = screen.getByTestId("notification-popover-list");
    expect(listEl.className).toContain("overflow-y-auto");
    expect(listEl.className).toContain("overflow-x-hidden");
    expect(screen.getByTestId("notification-popover-footer")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(longUrl))).toBeInTheDocument();
    expect(within(listEl).queryByRole("button", { name: /^Open$/i })).not.toBeInTheDocument();
    expect(within(listEl).queryByRole("button", { name: /^Mark read$/i })).not.toBeInTheDocument();
    expect(within(listEl).queryByRole("button", { name: /^Mark unread$/i })).not.toBeInTheDocument();

    // Clicking the notification item itself marks it read and navigates to its target route
    await user.click(within(listEl).getByText(new RegExp(longUrl)));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/notifications/n-long-1/read",
        expect.objectContaining({ method: "POST" })
      );
      expect(onNavigate).toHaveBeenCalledWith("/firmware");
    });

    // Re-open popover and dismiss the notification
    await user.click(screen.getByRole("button", { name: /^Notifications$/i }));
    await user.click(await screen.findByRole("button", { name: /Dismiss notification:/i }));
    await waitFor(() => {
      expect(screen.getByText(/All caught up/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /^Close notifications$/i }));

    // 3. Firmware Inspect Details uses responsive artifact cards without horizontal table overflow
    await user.click(screen.getByRole("button", { name: /Inspect Details/i }));
    expect(await screen.findByTestId("inspect-artifact-f-long-1")).toBeInTheDocument();
    expect(screen.getByText(/SHA-256: deadbeef123456/i)).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // 4. Open USB Flasher modal -> verify responsive 2/3-col grid instead of cramped 6-col row
    await user.click(screen.getByRole("button", { name: /Install via USB/i }));
    const nextBtn = await screen.findByRole("button", { name: /^Next$/i });
    await user.click(nextBtn);
    const stageGrid = await screen.findByTestId("usb-stage-grid");
    expect(stageGrid.className).toContain("grid-cols-2");
    expect(stageGrid.className).toContain("sm:grid-cols-2");
    await user.keyboard("{Escape}");

    ctrlView.unmount();
  });
});
