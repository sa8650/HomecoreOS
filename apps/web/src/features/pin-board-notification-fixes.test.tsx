import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEsp32S3N16R8PinMap } from "@homecoreos/shared";
import { emitNotificationSync, resetApiCache, subscribeNotificationSync } from "@/lib/api";
import { resolvePinMap } from "@/lib/board-pin-helpers";
import { getNotificationTargetUrl } from "@/components/notifications/NotificationBellPopover";
import { AdminBoardsPage } from "./admin/AdminAccountsAndBoardsPages";
import { OfficialBoardImportDialog } from "./admin/OfficialBoardImportDialog";
import type { BoardProfileItem, ControllerItem, NotificationItem } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeBoard(overrides: Partial<BoardProfileItem> = {}): BoardProfileItem {
  return {
    id: "board-1",
    slug: "espressif-esp32-s3-devkitc-1-n16r8",
    manufacturer: "Espressif",
    model: "ESP32-S3-DevKitC-1 N16R8",
    revision: "v1.1",
    chip_family: "esp32s3",
    chip_variant: "ESP32-S3-WROOM-1-N16R8",
    flash_size_mb: 16,
    psram_size_mb: 8,
    is_available: true,
    verification_status: "verified",
    firmware_status: "firmware_supported",
    catalog_category: "official_espressif",
    gpio_definitions: buildEsp32S3N16R8PinMap(),
    ...overrides,
  };
}

describe("Pin Management, Board Import/Update, and Notification UI Fixes", () => {
  afterEach(() => {
    cleanup();
    resetApiCache();
    vi.restoreAllMocks();
  });

  it("preserves isCurrent on shared-bus sensor editing in resolvePinMap", () => {
    const board = makeBoard();
    const controller: ControllerItem = {
      id: "ctrl-1",
      account_id: "acct-1",
      home_id: "home-1",
      board_profile_id: board.id,
      custom_board_profile_id: null,
      name: "Living Hub",
      hardware_uid: "esp32s3-001",
      board_model: board.model,
      chip_variant: board.chip_variant,
      flash_size_mb: board.flash_size_mb,
      psram_size_mb: board.psram_size_mb,
      firmware_version: "1.2.0",
      status: "online",
      mqtt_connected: true,
      wifi_ssid: "HomeNet",
      wifi_rssi: -52,
      local_ip: "192.168.1.40",
      last_heartbeat_at: new Date().toISOString(),
      last_communication_at: new Date().toISOString(),
      paired_at: new Date().toISOString(),
      connection_history: [],
    };

    const usedPinsByController = new Map([
      [
        controller.id,
        [
          {
            pin: 4,
            entityKind: "sensor" as const,
            id: "sen-temp",
            name: "DHT Temp",
            sensorType: "temperature_dht22",
          },
          {
            pin: 4,
            entityKind: "sensor" as const,
            id: "sen-hum",
            name: "DHT Humidity",
            sensorType: "humidity_dht22",
          },
        ],
      ],
    ]);

    const pinMap = resolvePinMap({
      controller,
      boardsById: new Map([[board.id, board]]),
      requirement: "digital_in",
      usedPinsByController,
      excludeEntity: { kind: "sensor", id: "sen-temp" },
      sensorType: "temperature_dht22",
    });

    const entry4 = pinMap.model?.entries.find((e) => e.pin === 4);
    expect(entry4).toBeDefined();
    expect(entry4?.isCurrent).toBe(true);
    expect(entry4?.selectable).toBe(true);
  });

  it("routes admin controller and emqx notifications cleanly and tags sync source", () => {
    const baseNotif: NotificationItem = {
      id: "n-1",
      scope: "admin",
      account_id: null,
      user_id: null,
      category: "controller",
      event_key: "admin.controller_offline",
      preference_key: "controller_activity",
      severity: "warning",
      title: "Controller Offline",
      message: "Hub offline",
      metadata: {},
      is_read: false,
      read_at: null,
      created_at: new Date().toISOString(),
    };

    expect(getNotificationTargetUrl(baseNotif, "admin")).toBe("/admin/usage");
    expect(
      getNotificationTargetUrl({ ...baseNotif, category: "emqx" }, "admin")
    ).toBe("/admin/emqx");

    const received: Array<{ scope: string; source?: string }> = [];
    const unsub = subscribeNotificationSync((evt) => {
      received.push({ scope: evt.scope, source: evt.source });
    });
    emitNotificationSync("user", 2, "page");
    emitNotificationSync("admin", 0, "bell");
    unsub();

    expect(received).toEqual([
      { scope: "user", source: "page" },
      { scope: "admin", source: "bell" },
    ]);
  });

  it("gates board mutations from read-only support admins and allows verifying unverified boards via BoardVerificationDialog", async () => {
    const unverifiedBoard = makeBoard({
      id: "board-unverified",
      slug: "espressif-esp32-s3-box-3",
      model: "ESP32-S3-BOX-3",
      is_available: false,
      verification_status: "needs_verification",
      gpio_definitions: [],
    });

    const patchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let currentBoards = [unverifiedBoard];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/admin/boards") && method === "GET") {
        return jsonResponse({ boards: currentBoards, syncRuns: [] });
      }
      if (url.endsWith(`/api/admin/boards/${unverifiedBoard.id}`) && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        patchCalls.push({ url, body });
        currentBoards = [
          {
            ...unverifiedBoard,
            verification_status: "verified",
            is_available: Boolean(body.is_available),
            gpio_definitions: (body.gpio_definitions as BoardProfileItem["gpio_definitions"]) ?? [],
          },
        ];
        return jsonResponse({ board: currentBoards[0] });
      }
      return jsonResponse({});
    });

    // 1. Read-only support role sees no mutation buttons
    const { unmount } = render(
      <AdminBoardsPage isSuperAdmin={false} canManageBoards={false} />
    );
    await screen.findByText("Espressif ESP32-S3-BOX-3");
    expect(screen.getByText(/Read-only access/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Import Board/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Update Board/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Verify Pins/i })).not.toBeInTheDocument();
    unmount();

    // 2. Operator/Super Admin can open Verify Pins, quick-add GPIOs, and verify + publish
    const user = userEvent.setup();
    render(<AdminBoardsPage isSuperAdmin={true} canManageBoards={true} />);
    const verifyBtn = await screen.findByRole("button", { name: /Verify Pins/i });
    await user.click(verifyBtn);

    const bulkInput = await screen.findByLabelText(/Quick-add GPIO numbers/i);
    await user.type(bulkInput, "4, 5");
    await user.click(screen.getByRole("button", { name: /Add List/i }));

    await user.click(screen.getByLabelText(/Publish to Board Library immediately/i));
    await user.click(screen.getByRole("button", { name: /Save & Verify Pinout/i }));

    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0]!.body.verification_status).toBe("verified");
    expect(patchCalls[0]!.body.is_available).toBe(true);
    expect(
      (patchCalls[0]!.body.gpio_definitions as Array<{ pin: number }>).map((g) => g.pin)
    ).toEqual([4, 5]);
  });

  it("exposes NodeMCU / Community Partner provider inside OfficialBoardImportDialog", async () => {
    render(
      <OfficialBoardImportDialog
        open={true}
        onOpenChange={() => {}}
        onImported={() => {}}
      />
    );
    expect(await screen.findByText(/NodeMCU \/ Community Partner/i)).toBeInTheDocument();
  });
});
