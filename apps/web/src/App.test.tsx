import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HomecoreOS SPA routing & console isolation", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    window.history.pushState({}, "", "/");
  });

  it("renders Customer Sign In when unauthenticated on /", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/auth/me")) {
        return jsonResponse({ error: "Authentication required." }, 401);
      }
      return jsonResponse({});
    }) as typeof fetch;

    window.history.pushState({}, "", "/");
    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /Customer User Console/i })
      ).toBeInTheDocument();
    });
    expect(screen.getAllByText(/HomecoreOS/i).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: /Sign In to User Console/i })
    ).toBeInTheDocument();
  });

  it("renders Admin Bootstrap when unauthenticated on /admin and no platform admin exists", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/admin/auth/me")) {
        return jsonResponse({ error: "Admin auth required." }, 401);
      }
      if (url.endsWith("/api/admin/auth/bootstrap-status")) {
        return jsonResponse({ needsBootstrap: true });
      }
      return jsonResponse({});
    }) as typeof fetch;

    window.history.pushState({}, "", "/admin");
    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /Bootstrap Root Administrator/i })
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /Create Initial Super Admin/i })
    ).toBeInTheDocument();
  });

  it("renders authenticated Customer Console with Interactive 2D Floor Plan, timezone, and no Admin routes", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/auth/me")) {
        return jsonResponse({
          user: {
            id: "u1",
            email: "alice@example.com",
            fullName: "Alice Owner",
            appearancePreference: "system",
            timezone: "America/New_York",
          },
          account: {
            id: "a1",
            name: "Alice Residence",
            slug: "alice-res",
            status: "active",
            staffRole: "owner",
          },
          accounts: [
            {
              id: "a1",
              name: "Alice Residence",
              slug: "alice-res",
              status: "active",
              staffRole: "owner",
            },
          ],
          platformDefaultTimezone: "UTC",
          effectiveTimezone: "America/New_York",
        });
      }
      if (url.endsWith("/api/homes/overview")) {
        return jsonResponse({
          summary: {
            totalRooms: 1,
            totalDevices: 0,
            activeDevices: 0,
            totalSwitches: 1,
            activeSwitches: 1,
            totalSensors: 0,
            totalControllers: 1,
            onlineControllers: 1,
            offlineControllers: 0,
          },
          homes: [{ id: "h1", account_id: "a1", name: "Main Home", timezone: "America/New_York" }],
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
            },
          ],
          controllers: [
            {
              id: "c1",
              account_id: "a1",
              home_id: "h1",
              name: "Hub S3",
              board_catalog_id: "b1",
              custom_board_id: null,
              board_model: "ESP32-S3",
              chip_family: "esp32s3",
              chip_variant: "ESP32-S3",
              flash_size_mb: 16,
              psram_size_mb: 8,
              status: "online",
              mqtt_connected: true,
              wifi_ssid: "HomeNet",
              wifi_rssi: -52,
              local_ip: "192.168.1.40",
              firmware_version: "1.0.0",
              hardware_uid: "AA:BB:CC:DD:EE:FF",
              last_heartbeat_at: null,
              last_communication_at: null,
              paired_at: null,
              connection_history: [],
            },
          ],
          switches: [
            {
              id: "sw1",
              account_id: "a1",
              home_id: "h1",
              room_id: "r1",
              controller_id: "c1",
              name: "Ceiling Light",
              gpio_pin: 4,
              inverted: false,
              is_on: true,
              is_online: true,
              last_changed_at: null,
            },
          ],
          devices: [],
          sensors: [],
          recentActivity: [],
        });
      }
      return jsonResponse({});
    }) as typeof fetch;

    window.history.pushState({}, "", "/");
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Interactive 2D Home Floor Plan/i)).toBeInTheDocument();
    });
    expect(screen.getAllByText(/^Rooms$/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Rooms & Areas/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Board Library/i)).toBeInTheDocument();
    expect(screen.getByText(/Ceiling Light/i)).toBeInTheDocument();
    expect(screen.getAllByText(/America\/New_York/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/EMQX Management/i)).not.toBeInTheDocument();
  });

  it("displays Account Paused banner and blocks operational views when customer account is paused", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/auth/me")) {
        return jsonResponse({
          user: {
            id: "u1",
            email: "alice@example.com",
            fullName: "Alice Owner",
            appearancePreference: "system",
            timezone: null,
          },
          account: {
            id: "a1",
            name: "Paused Home",
            slug: "paused-home",
            status: "paused",
            staffRole: "owner",
          },
          accounts: [
            {
              id: "a1",
              name: "Paused Home",
              slug: "paused-home",
              status: "paused",
              staffRole: "owner",
            },
          ],
          platformDefaultTimezone: "UTC",
          effectiveTimezone: "UTC",
        });
      }
      if (url.endsWith("/api/auth/sessions")) {
        return jsonResponse({ sessions: [] });
      }
      return jsonResponse({});
    }) as typeof fetch;

    window.history.pushState({}, "", "/");
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Account Paused/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Interactive 2D Home Floor Plan/i)).not.toBeInTheDocument();
  });

  it("renders authenticated Admin Console on /admin with Setup Status and Platform Overview", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/admin/auth/me")) {
        return jsonResponse({
          admin: {
            id: "adm1",
            email: "ops@homecore.local",
            fullName: "Root Operator",
            role: "super_admin",
            timezone: null,
          },
          platformDefaultTimezone: "Asia/Tokyo",
          effectiveTimezone: "Asia/Tokyo",
        });
      }
      if (url.endsWith("/api/admin/overview")) {
        return jsonResponse({
          counts: {
            accounts: 4,
            customerUsers: 7,
            controllers: 9,
            onlineControllers: 6,
            firmwareReleases: 2,
            catalogBoards: 1,
          },
          recentActivity: [],
        });
      }
      return jsonResponse({});
    }) as typeof fetch;

    window.history.pushState({}, "", "/admin");
    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /Platform Overview/i })
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/Setup Status/i)).toBeInTheDocument();
    expect(screen.getByText(/EMQX Management/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Asia\/Tokyo/i).length).toBeGreaterThan(0);
  });
});
