import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiCache } from "@/lib/api";
import { TimezoneContext } from "@/lib/timezone";
import { MyBoardsPage } from "./MyBoardsPage";
import type { ControllerItem } from "@/features/types";

const originalFetch = globalThis.fetch;

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const controller: ControllerItem = {
  id: "c1",
  account_id: "a1",
  home_id: "h1",
  room_id: "r1",
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
  last_heartbeat_at: null,
  last_communication_at: null,
  paired_at: "2026-10-01T00:00:00Z",
  connection_history: [],
};

const rooms = [
  { id: "r1", account_id: "a1", home_id: "h1", name: "Living Room", icon: "sofa", floor_order: 1, grid_col_span: 1 },
  { id: "r2", account_id: "a1", home_id: "h1", name: "Kitchen", icon: "kitchen", floor_order: 2, grid_col_span: 1 },
];

function mockFetch(current: { controller: ControllerItem }) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.startsWith("/api/board-instances/c1/room") && method === "PATCH") {
      const parsed = JSON.parse(String(init!.body)) as { roomId: string | null };
      current.controller = { ...current.controller, room_id: parsed.roomId };
      return jsonResponse({ controller: current.controller });
    }
    if (url === "/api/board-instances") return jsonResponse({ controllers: [current.controller] });
    if (url === "/api/board-instances/trash") return jsonResponse({ controllers: [] });
    if (url === "/api/board-library/catalog") return jsonResponse({ boards: [] });
    if (url === "/api/board-library/custom") return jsonResponse({ boards: [] });
    if (url === "/api/homes")
      return jsonResponse({ homes: [{ id: "h1", account_id: "a1", name: "Main Home", timezone: "UTC" }] });
    if (url === "/api/homes/rooms") return jsonResponse({ rooms });
    return jsonResponse({ ok: true });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return calls;
}

describe("MyBoardsPage room assignment", () => {
  beforeEach(() => {
    resetApiCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetApiCache();
  });

  it("assigns a controller to a different room via the three-dot menu", async () => {
    const user = userEvent.setup();
    const current = { controller: { ...controller } };
    const calls = mockFetch(current);

    render(
      <TimezoneContext.Provider value="UTC">
        <MyBoardsPage canManage={true} canOperate={true} onNavigate={vi.fn()} />
      </TimezoneContext.Provider>
    );

    // Current assignment shown on the card
    expect((await screen.findAllByText("Living Room")).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Actions for Living Hub" }));
    await user.click(await screen.findByText("Assign to Room"));

    // Dialog lists this home's rooms; switch to Kitchen
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Kitchen/i }));
    await user.click(screen.getByRole("button", { name: /Save Assignment/i }));

    await waitFor(() => {
      const patch = calls.find((c) => c.url === "/api/board-instances/c1/room" && c.method === "PATCH");
      expect(patch?.body).toEqual({ roomId: "r2" });
    });
    // Card reflects the new room immediately
    expect((await screen.findAllByText("Kitchen")).length).toBeGreaterThan(0);
  });

  it("removes the assignment via the 'No room' option", async () => {
    const user = userEvent.setup();
    const current = { controller: { ...controller } };
    const calls = mockFetch(current);

    render(
      <TimezoneContext.Provider value="UTC">
        <MyBoardsPage canManage={true} canOperate={true} onNavigate={vi.fn()} />
      </TimezoneContext.Provider>
    );

    await screen.findAllByText("Living Room");
    await user.click(screen.getByRole("button", { name: "Actions for Living Hub" }));
    await user.click(await screen.findByText("Assign to Room"));
    await user.click(await screen.findByRole("radio", { name: /No room/i }));
    await user.click(screen.getByRole("button", { name: /Remove Assignment/i }));

    await waitFor(() => {
      const patch = calls.find((c) => c.url === "/api/board-instances/c1/room" && c.method === "PATCH");
      expect(patch?.body).toEqual({ roomId: null });
    });
  });

  it("hides the assign action for view-only roles", async () => {
    const user = userEvent.setup();
    mockFetch({ controller: { ...controller } });

    render(
      <TimezoneContext.Provider value="UTC">
        <MyBoardsPage canManage={false} canOperate={false} onNavigate={vi.fn()} />
      </TimezoneContext.Provider>
    );

    await screen.findAllByText("Living Hub");
    await user.click(screen.getByRole("button", { name: "Actions for Living Hub" }));
    expect(screen.queryByText("Assign to Room")).not.toBeInTheDocument();
  });
});
