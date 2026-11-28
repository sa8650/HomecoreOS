import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiCache } from "@/lib/api";
import { TimezoneContext } from "@/lib/timezone";
import { MyBoardsPage } from "./MyBoardsPage";
import type { ControllerItem } from "@/features/types";
import { jsonResponse } from "@/test/http";

const originalFetch = globalThis.fetch;

const controller: ControllerItem = {
  id: "c1",
  account_id: "a1",
  home_id: "h1",
  room_id: null,
  board_profile_id: "b1",
  custom_board_profile_id: null,
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
  last_heartbeat_at: "2026-10-01T00:00:00Z",
  last_communication_at: "2026-10-01T00:00:00Z",
  paired_at: "2026-10-01T00:00:00Z",
  connection_history: [],
  board_role: "controller",
};

const node: ControllerItem = {
  ...controller,
  id: "n1",
  name: "Bedroom Panel",
  board_role: "node",
  assigned_controller_id: "c1",
};

function mockFetch() {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.startsWith("/api/board-logs/c1")) {
      return jsonResponse({
        board: {
          id: "c1",
          name: "Living Hub",
          status: "online",
          boardRole: "controller",
          lastHeartbeatAt: "2026-10-01T00:00:00Z",
          lastCommunicationAt: "2026-10-01T00:00:00Z",
          mqttConnected: true,
          wifiConnected: true,
          nodeLinkState: null,
          commMode: null,
        },
        entries: [
          {
            id: "log-1",
            boardInstanceId: "c1",
            category: "connection",
            severity: "info",
            status: "online",
            method: "http",
            source: "c1",
            destination: null,
            message: "Living Hub came online.",
            metadata: {},
            createdAt: "2026-10-01T00:00:00Z",
          },
        ],
        nextCursor: null,
        hasMore: false,
      });
    }
    if (url.startsWith("/api/board-logs/n1")) {
      return jsonResponse({
        board: {
          id: "n1",
          name: "Bedroom Panel",
          status: "online",
          boardRole: "node",
          lastHeartbeatAt: "2026-10-01T00:00:00Z",
          lastCommunicationAt: "2026-10-01T00:00:00Z",
          mqttConnected: false,
          wifiConnected: true,
          nodeLinkState: "linked",
          commMode: "espnow",
        },
        entries: [
          {
            id: "log-n1",
            boardInstanceId: "n1",
            category: "communication",
            severity: "success",
            status: "linked",
            method: "espnow",
            source: "c1",
            destination: "n1",
            message: "Controller link established over ESP-NOW.",
            metadata: {},
            createdAt: "2026-10-01T00:00:00Z",
          },
        ],
        nextCursor: null,
        hasMore: false,
      });
    }
    if (url === "/api/board-instances") {
      return jsonResponse({ controllers: [controller, node] });
    }
    if (url === "/api/board-instances/trash") return jsonResponse({ controllers: [] });
    if (url === "/api/board-library/catalog") return jsonResponse({ boards: [] });
    if (url === "/api/board-library/custom") return jsonResponse({ boards: [] });
    if (url === "/api/homes") {
      return jsonResponse({
        homes: [{ id: "h1", account_id: "a1", name: "Main Home", timezone: "UTC" }],
      });
    }
    if (url === "/api/homes/rooms") return jsonResponse({ rooms: [] });
    return jsonResponse({ ok: true });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return calls;
}

describe("MyBoardsPage per-board Log", () => {
  beforeEach(() => {
    resetApiCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetApiCache();
  });

  it("opens the Controller's own log from the card menu", async () => {
    const calls = mockFetch();
    const user = userEvent.setup();

    render(
      <TimezoneContext.Provider value="UTC">
        <MyBoardsPage canManage canOperate onNavigate={() => {}} />
      </TimezoneContext.Provider>
    );

    await screen.findByText("Living Hub");
    await user.click(screen.getByLabelText("Actions for Living Hub"));
    await user.click(await screen.findByText("View Log"));

    expect(await screen.findByTestId("board-log-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("board-log-board-id")).toHaveTextContent("c1");
    expect(await screen.findByText("Living Hub came online.")).toBeInTheDocument();

    const logCalls = calls.filter((call) => call.url.startsWith("/api/board-logs/"));
    expect(logCalls.length).toBeGreaterThan(0);
    expect(logCalls.every((call) => call.url.startsWith("/api/board-logs/c1"))).toBe(true);
  });

  it("opens the Node's own log, which is never the Controller's log", async () => {
    const calls = mockFetch();
    const user = userEvent.setup();

    render(
      <TimezoneContext.Provider value="UTC">
        <MyBoardsPage canManage canOperate onNavigate={() => {}} />
      </TimezoneContext.Provider>
    );

    await user.click(await screen.findByRole("tab", { name: /node/i }));
    await screen.findByText("Bedroom Panel");
    await user.click(screen.getByLabelText("Actions for Bedroom Panel"));
    await user.click(await screen.findByText("View Log"));

    expect(await screen.findByTestId("board-log-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("board-log-board-id")).toHaveTextContent("n1");
    await waitFor(() => {
      expect(
        screen.getByText("Controller link established over ESP-NOW.")
      ).toBeInTheDocument();
    });

    const logCalls = calls.filter((call) => call.url.startsWith("/api/board-logs/"));
    expect(logCalls.length).toBeGreaterThan(0);
    expect(logCalls.every((call) => call.url.startsWith("/api/board-logs/n1"))).toBe(true);
  });
});
