import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimezoneContext } from "../../lib/timezone";
import { AdminCustomerDetailsPage } from "./AdminCustomerDetailsPage";
import { AdminAccountsStaffPage } from "./AdminAccountsAndBoardsPages";
import { jsonResponse } from "@/test/http";

const originalFetch = globalThis.fetch;

const board = {
  id: "11111111-1111-4111-8111-111111111111",
  account_id: "acc-1",
  home_id: "home-1",
  room_id: "room-1",
  board_profile_id: "profile-1",
  custom_board_profile_id: null,
  name: "Living Room Controller",
  hardware_uid: "AA:BB:CC:DD:EE:01",
  board_model: "ESP32-S3 DevKit",
  chip_variant: "esp32s3",
  flash_size_mb: 16,
  psram_size_mb: 8,
  firmware_version: "1.5.0",
  status: "online",
  pairing_status: "paired",
  board_role: "controller",
  comm_mode: null,
  node_link_state: null,
  assigned_controller_id: null,
  assigned_controller_name: null,
  attached_node_count: 0,
  mqtt_connected: true,
  wifi_connected: true,
  wifi_ssid: "HomeWiFi",
  wifi_rssi: -55,
  local_ip: "192.168.1.44",
  last_heartbeat_at: "2026-11-21T11:59:30.000Z",
  last_communication_at: "2026-11-21T11:59:30.000Z",
  wifi_last_connected_at: "2026-11-21T11:59:30.000Z",
  mqtt_last_connected_at: "2026-11-21T11:59:30.000Z",
  last_error: null,
  last_error_at: null,
  paired_at: "2026-11-01T00:00:00.000Z",
  connection_history: [{ event: "heartbeat", at: "2026-11-21T11:59:30.000Z" }],
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-21T11:59:30.000Z",
  config_revision: 3,
  config_hash: "abc123",
  last_synced_config_revision: 3,
  last_config_published_at: "2026-11-21T11:00:00.000Z",
  last_config_synced_at: "2026-11-21T11:59:00.000Z",
  pending_config_sync: false,
  heartbeat_interval_sec: 30,
  detected_flash_size_mb: 16,
  detected_chip_name: "ESP32-S3",
  reported_board_slug: "esp32-s3-devkitc-1-n16r8",
  provisioning_transport: "ble",
  installed_firmware_release_id: "rel-1",
  reported_driver_manifest_hash: "hash123",
  board_profile: {
    id: "profile-1",
    slug: "esp32-s3-devkitc-1-n16r8",
    manufacturer: "Espressif",
    model: "ESP32-S3 DevKit",
    revision: "v1.0",
    chip_family: "esp32s3",
    chip_variant: "esp32s3",
    flash_size_mb: 16,
    psram_size_mb: 8,
    firmware_status: "firmware_supported",
    verification_status: "verified",
    catalog_category: "official_espressif",
  },
  custom_board_profile: null,
  room_name: "Living Room",
  home_name: "Primary Home",
  mqtt: {
    mqtt_username: "ctrl-user",
    mqtt_client_id: "ctrl-client",
    topic_prefix: "homecore/acc-1/board-instances/11111111-1111-4111-8111-111111111111",
    emqx_synced: true,
    status: "active",
    last_rotated_at: "2026-11-01T00:00:00.000Z",
  },
  installed_release: {
    id: "rel-1",
    name: "HomecoreOS S3",
    version: "1.5.0",
    channel: "stable",
    status: "published",
    published_at: "2026-11-10T00:00:00.000Z",
  },
  available_update: null,
  counts: { devices: 1, devicesOnline: 1, sensors: 1, sensorsOnline: 1, sensorsStale: 0, switches: 1, switchesOnline: 1 },
  health: {
    status: "healthy",
    reasons: [],
    telemetry: {
      hasTelemetry: true,
      heartbeatAgeSeconds: 30,
      communicationAgeSeconds: 30,
      heartbeatFresh: true,
      offlineTimeoutSeconds: 180,
      sensorStaleSeconds: 900,
    },
  },
};

const monitoringPayload = {
  account: {
    id: "acc-1",
    name: "Maple Residence",
    slug: "maple-residence",
    status: "active",
    created_at: "2026-06-01T00:00:00.000Z",
    paused_at: null,
    owner_user_id: "user-1",
  },
  owner: { id: "user-1", email: "owner@maple.example", full_name: "Maple Owner", created_at: "2026-06-01T00:00:00.000Z" },
  summary: {
    totalBoards: 1,
    totalDevices: 1,
    totalSensors: 1,
    totalSwitches: 1,
    onlineBoards: 1,
    offlineBoards: 0,
    controllers: 1,
    nodes: 0,
    lastSyncAt: "2026-11-21T11:59:00.000Z",
    lastHeartbeatAt: "2026-11-21T11:59:30.000Z",
    lastCommunicationAt: "2026-11-21T11:59:30.000Z",
    lastActivityAt: "2026-11-21T11:59:30.000Z",
  },
  health: {
    status: "healthy",
    counts: { healthy: 1, warning: 0, offline: 0, unknown: 0 },
    offlineTimeoutSeconds: 180,
    heartbeatIntervalSeconds: 30,
  },
  settings: { offlineTimeoutSeconds: 180, heartbeatIntervalSeconds: 30 },
  pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1, hasNext: false, hasPrev: false },
  boards: [board],
};

function mockMonitoringFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/monitoring")) return jsonResponse(monitoringPayload);
    if (url.endsWith("/boards/11111111-1111-4111-8111-111111111111")) {
      return jsonResponse({
        board,
        firmwareHistory: [],
        recentActivity: [],
        attachedNodes: [],
        parentBoard: null,
        sensorCompatibility: null,
      });
    }
    if (url.includes("/devices")) {
      return jsonResponse({
        items: [
          { id: "dev-1", name: "Lamp", device_type: "light", gpio_pin: 4, state: "on", is_online: true },
        ],
        pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
      });
    }
    if (url.includes("/sensors")) {
      return jsonResponse({
        items: [
          { id: "sen-1", name: "Temp", sensor_type: "temperature_bme280", gpio_pin: 21, unit: "°C", last_value: 22.5, is_online: true, last_reading_at: "2026-11-21T11:59:30.000Z" },
        ],
        pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
      });
    }
    if (url.includes("/switches")) {
      return jsonResponse({
        items: [
          { id: "sw-1", name: "Wall Switch", gpio_pin: 13, is_on: true, is_online: true, last_changed_at: "2026-11-21T11:00:00.000Z" },
        ],
        pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
      });
    }
    return jsonResponse({});
  }) as typeof fetch;
}

describe("Admin Customer Details (read-only monitoring)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders customer overview, summary cards and board inventory", async () => {
    mockMonitoringFetch();
    render(
      <TimezoneContext.Provider value="UTC">
        <AdminCustomerDetailsPage accountId="acc-1" onNavigate={vi.fn()} />
      </TimezoneContext.Provider>
    );

    expect((await screen.findAllByText("Maple Residence")).length).toBeGreaterThan(0);
    expect(screen.getByText(/owner@maple\.example/)).toBeInTheDocument();
    expect(screen.getByText(/Account ID: acc-1/)).toBeInTheDocument();
    expect(screen.getByText(/Read-only monitoring/i)).toBeInTheDocument();
    expect(screen.getByText("Total boards")).toBeInTheDocument();
    expect(screen.getByText("Total devices")).toBeInTheDocument();
    expect(screen.getByText("Total sensors")).toBeInTheDocument();
    expect(screen.getByText("Total switches")).toBeInTheDocument();
    expect(screen.getByText("Online boards")).toBeInTheDocument();
    expect(screen.getByText("Offline boards")).toBeInTheDocument();
    expect(screen.getByText("Living Room Controller")).toBeInTheDocument();
    expect(screen.getAllByText(/v1\.5\.0/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /View Details/i })).toBeInTheDocument();
    // No device controls anywhere on the monitoring page.
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /restart/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /install firmware/i })).not.toBeInTheDocument();
  });

  it("opens a read-only board details dialog with no control actions", async () => {
    const user = userEvent.setup();
    mockMonitoringFetch();
    render(
      <TimezoneContext.Provider value="UTC">
        <AdminCustomerDetailsPage accountId="acc-1" onNavigate={vi.fn()} />
      </TimezoneContext.Provider>
    );

    await user.click(await screen.findByRole("button", { name: /View Details/i }));

    expect(await screen.findByText(/Board Details \(Read-only\)/i)).toBeInTheDocument();
    expect(screen.getAllByText(/cannot control customer hardware/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/MQTT \(recorded state only\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Configuration \(recorded revisions\)/i)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /restart/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /turn on|turn off|toggle/i })).not.toBeInTheDocument();
  });

  it("shows an empty state when the customer has no boards", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        ...monitoringPayload,
        summary: { ...monitoringPayload.summary, totalBoards: 0, onlineBoards: 0, offlineBoards: 0 },
        health: { ...monitoringPayload.health, status: "unknown", counts: { healthy: 0, warning: 0, offline: 0, unknown: 0 } },
        boards: [],
        pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1, hasNext: false, hasPrev: false },
      })
    ) as typeof fetch;
    render(
      <TimezoneContext.Provider value="UTC">
        <AdminCustomerDetailsPage accountId="acc-1" onNavigate={vi.fn()} />
      </TimezoneContext.Provider>
    );
    expect(await screen.findByText("No boards registered")).toBeInTheDocument();
  });

  it("shows an error state with retry when the API fails", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: "Customer account not found." }, 404)
    ) as typeof fetch;
    render(
      <TimezoneContext.Provider value="UTC">
        <AdminCustomerDetailsPage accountId="missing" onNavigate={vi.fn()} />
      </TimezoneContext.Provider>
    );
    expect(await screen.findByText(/Could not load customer monitoring data/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
  });
});

describe("Customer Accounts Details button", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("navigates to the customer details page from the Action column", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/admin/accounts")) {
        return jsonResponse({
          accounts: [
            { id: "acc-1", name: "Maple Residence", slug: "maple-residence", status: "active", created_at: "2026-06-01T00:00:00.000Z" },
          ],
        });
      }
      if (url.endsWith("/api/admin/platform-staff")) return jsonResponse({ platformStaff: [] });
      return jsonResponse({});
    }) as typeof fetch;

    render(
      <TimezoneContext.Provider value="UTC">
        <AdminAccountsStaffPage isSuperAdmin canManageAccounts onNavigate={onNavigate} />
      </TimezoneContext.Provider>
    );

    const details = await screen.findByRole("button", { name: /^Details$/i });
    await user.click(details);
    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith("/admin/accounts/acc-1");
    });
  });

  it("shows Details to read-only support admins without write buttons", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/admin/accounts")) {
        return jsonResponse({
          accounts: [
            { id: "acc-1", name: "Maple Residence", slug: "maple-residence", status: "active", created_at: "2026-06-01T00:00:00.000Z" },
          ],
        });
      }
      return jsonResponse({ platformStaff: [] });
    }) as typeof fetch;

    render(
      <TimezoneContext.Provider value="UTC">
        <AdminAccountsStaffPage isSuperAdmin={false} canManageAccounts={false} onNavigate={vi.fn()} />
      </TimezoneContext.Provider>
    );

    expect(await screen.findByRole("button", { name: /^Details$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pause$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Provision Customer Account/i })).not.toBeInTheDocument();
  });
});
