import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/sonner";
import { invalidateApiCache } from "@/lib/api";
import { TimezoneContext } from "@/lib/timezone";
import type {
  ApplicableFirmwareUpdateItem,
  BoardProfileItem,
  FirmwareReleaseItem,
  FirmwareUpdateHistoryItem,
} from "../types";
import { FirmwarePage } from "./FirmwarePage";

const originalFetch = globalThis.fetch;

const devkit: BoardProfileItem = {
  id: "b1",
  slug: "esp32-s3-devkitc-1-n16r8",
  manufacturer: "Espressif",
  model: "ESP32-S3-DevKitC-1-N16R8",
  revision: "1.0",
  chip_family: "esp32s3",
  chip_variant: "ESP32-S3",
  flash_size_mb: 16,
  psram_size_mb: 8,
  supports_wifi: true,
  supports_ble: true,
  supports_ble_wifi_provisioning: true,
  boot_button_gpio: 0,
  usb_interface: "USB-OTG + UART",
  gpio_definitions: [],
} as BoardProfileItem;

const release: FirmwareReleaseItem = {
  id: "rel-1",
  name: "HomecoreOS Core",
  version: "1.5.0",
  channel: "stable",
  chip_family: "esp32s3",
  target_board_slug: "esp32-s3-devkitc-1-n16r8",
  flash_size_mb: 16,
  compatible_board_ids: ["b1"],
  compatible_board_slugs: ["esp32-s3-devkitc-1-n16r8"],
  ota_available: true,
  usb_available: true,
  status: "published",
  release_notes: "Recovery portal improvements",
  published_at: "2026-11-10T09:00:00Z",
  files: [],
} as unknown as FirmwareReleaseItem;

const pendingUpdate: FirmwareUpdateHistoryItem = {
  id: "hist-1",
  board_instance_id: "ctrl-1",
  release_id: "rel-1",
  update_type: "ota",
  method: "ota",
  from_version: "1.4.0",
  to_version: "1.5.0",
  status: "pending",
  progress_percent: 0,
  error_message: null,
  started_at: "2026-11-16T09:00:00Z",
  completed_at: null,
  created_at: "2026-11-16T09:00:00Z",
} as unknown as FirmwareUpdateHistoryItem;

const applicableUpdate: ApplicableFirmwareUpdateItem = {
  boardInstanceId: "ctrl-1",
  controllerName: "Living Room Hub",
  boardModel: "ESP32-S3-DevKitC-1-N16R8",
  controllerStatus: "online",
  currentVersion: "1.4.0",
  availableRelease: {
    id: "rel-1",
    name: "HomecoreOS Core",
    version: "1.5.0",
    channel: "stable",
    chip_family: "esp32s3",
    target_board_slug: "esp32-s3-devkitc-1-n16r8",
    hardware_verified: true,
    release_notes: "Recovery portal improvements",
    published_at: "2026-11-10T09:00:00Z",
  },
  activeUpdate: pendingUpdate,
};

/** A second controller with the same update available and nothing queued yet. */
const readyUpdate: ApplicableFirmwareUpdateItem = {
  ...applicableUpdate,
  boardInstanceId: "ctrl-2",
  controllerName: "Kitchen Hub",
  activeUpdate: null,
};

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The Firmware & Updates page keeps the catalog, downloads and OTA updates, and
 * no longer carries any part of the USB flashing workflow.
 */
describe("Firmware & Updates page: OTA only, no USB flashing", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    invalidateApiCache();
  });

  function serve() {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/firmware/releases") return json({ releases: [release] });
      if (url === "/api/board-library/catalog") return json({ boards: [devkit] });
      if (url === "/api/board-library/custom") return json({ boards: [] });
      if (url === "/api/firmware/updates") {
        return json({ applicableUpdates: [applicableUpdate, readyUpdate], history: [pendingUpdate] });
      }
      return json({});
    }) as unknown as typeof fetch;
    return calls;
  }

  it("shows the release catalog and details without any USB flashing entry point", async () => {
    const user = userEvent.setup();
    serve();
    render(
      <TimezoneContext.Provider value="UTC">
        <FirmwarePage canManage onNavigate={vi.fn()} />
        <Toaster />
      </TimezoneContext.Provider>
    );

    expect(await screen.findByText(/HomecoreOS Core/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Inspect Details/i })).toBeInTheDocument();

    // Nothing about the Web Serial flasher survives on this page.
    expect(screen.queryByRole("button", { name: /USB Browser Flasher/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Install via USB/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Browser USB Flasher/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Flash board over USB/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Full chip erase before flashing/i)).not.toBeInTheDocument();

    // Release details still open, and still offer no flashing action.
    await user.click(screen.getByRole("button", { name: /Inspect Details/i }));
    const details = await screen.findByRole("dialog");
    expect(within(details).queryByRole("button", { name: /Install via USB/i })).toBeNull();
    expect(within(details).queryByText(/Install via USB/i)).toBeNull();
    await user.click(within(details).getAllByRole("button", { name: /^Close$/i })[0]!);
  });

  it("still starts, reports and cancels OTA updates from the Updates tab", async () => {
    const user = userEvent.setup();
    const calls = serve();
    render(
      <TimezoneContext.Provider value="UTC">
        <FirmwarePage canManage onNavigate={vi.fn()} />
        <Toaster />
      </TimezoneContext.Provider>
    );

    await user.click(await screen.findByRole("tab", { name: /Updates/i }));
    expect((await screen.findAllByText(/Living Room Hub/i)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1\.5\.0/).length).toBeGreaterThan(0);

    // A queued OTA update can still be cancelled.
    await user.click(screen.getAllByRole("button", { name: /^Cancel$/i })[0]!);
    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.url === "/api/firmware/ota/hist-1/cancel" && c.method === "POST"
        )
      ).toBe(true);
    });

    // ...and a new one can be started for a controller with nothing queued.
    await user.click(screen.getByRole("button", { name: /^Update$/i }));
    await waitFor(() => {
      expect(
        calls.some((c) => c.url === "/api/firmware/ota/start" && c.method === "POST")
      ).toBe(true);
    });
  });
});
