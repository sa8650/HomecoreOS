import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The page, the flash session hook and the flasher are real. Only the serial
// loader is replaced, so the test decides what the connected hardware reports.
const loader = vi.hoisted(() => ({
  main: vi.fn(async () => "ESP32-S3"),
  detectFlashSize: vi.fn(async () => "16MB"),
  writeFlash: vi.fn(async () => {}),
  flashMd5sum: vi.fn(async () => ""),
  after: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  features: vi.fn<() => Promise<string[] | null>>(async () => null),
}));

vi.mock("esptool-js", () => ({
  Transport: class MockTransport {
    disconnect = loader.disconnect;
  },
  ESPLoader: class MockESPLoader {
    main = loader.main;
    detectFlashSize = loader.detectFlashSize;
    writeFlash = loader.writeFlash;
    flashMd5sum = loader.flashMd5sum;
    after = loader.after;
    chip = { getChipFeatures: loader.features };
  },
}));

import { SEEED_XIAO_OFFICIAL_BOARDS, VERIFIED_BOARD_CATALOG } from "@homecoreos/shared";
import { Toaster } from "@/components/ui/sonner";
import { invalidateApiCache, sha256HexClient } from "@/lib/api";
import { TimezoneContext } from "@/lib/timezone";
import { md5Hex } from "@/lib/usb-flasher";
import type { BoardProfileItem, FirmwareReleaseItem } from "../types";
import { MyBoardsPage } from "./MyBoardsPage";

const originalFetch = globalThis.fetch;
const image = new Uint8Array([0xe9, 0x04, 0x02, 0x20, 0x10, 0x00, 0x00, 0x00]);

const devkit: BoardProfileItem = {
  ...VERIFIED_BOARD_CATALOG.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!,
  id: "id-devkit",
  is_available: true,
};
const xiaoC3: BoardProfileItem = {
  ...SEEED_XIAO_OFFICIAL_BOARDS.find((b) => b.seed.slug === "seeed-xiao-esp32c3")!.seed,
  id: "id-xiao-c3",
  is_available: true,
};
const xiaoPlus: BoardProfileItem = {
  ...SEEED_XIAO_OFFICIAL_BOARDS.find((b) => b.seed.slug === "seeed-xiao-esp32s3-plus")!.seed,
  id: "id-xiao-plus",
  is_available: true,
};

interface FlashEvent {
  status: string;
  releaseId: string;
  reportedBoardSlug?: string;
  boardCheck?: { result: string; forced: boolean; mismatches: string[]; selectedBoardSlug?: string };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function release(
  id: string,
  board: BoardProfileItem,
  fileId: string
): Promise<FirmwareReleaseItem> {
  return {
    id,
    name: "HomecoreOS",
    version: "1.4.0",
    channel: "stable",
    chip_family: board.chip_family,
    target_board_slug: board.slug,
    flash_size_mb: board.flash_size_mb,
    compatible_board_ids: [board.id],
    compatible_board_slugs: [board.slug],
    ota_available: false,
    usb_available: true,
    status: "published",
    release_notes: "",
    published_at: "2026-11-10T09:00:00Z",
    files: [
      {
        id: fileId,
        release_id: id,
        file_type: "usb_factory",
        file_name: "homecoreos-usb-factory.bin",
        size_bytes: image.byteLength,
        sha256: await sha256HexClient(image),
        flash_address: "0x0",
        flash_mode: "dio",
        flash_freq: "80m",
        flash_size: `${board.flash_size_mb}MB`,
        validated: true,
      },
    ],
  } as FirmwareReleaseItem;
}

/** Serves the page's API and records the USB flash events it reports. */
async function serve(releases: FirmwareReleaseItem[], boards: BoardProfileItem[]): Promise<FlashEvent[]> {
  const events: FlashEvent[] = [];
  const sha = await sha256HexClient(image);
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/firmware/releases") return json({ releases });
    if (url === "/api/board-library/catalog") return json({ boards });
    if (url === "/api/board-library/custom") return json({ boards: [] });
    if (url === "/api/firmware/updates") return json({ applicableUpdates: [], history: [] });
    if (url === "/api/board-instances") return json({ controllers: [] });
    if (url === "/api/board-instances/trash") return json({ controllers: [] });
    if (url === "/api/homes") return json({ homes: [] });
    if (url === "/api/homes/rooms") return json({ rooms: [] });
    if (url.endsWith("/download")) {
      return new Response(image, { status: 200, headers: { "X-Firmware-Sha256": sha } });
    }
    if (url === "/api/firmware/usb-flash-events") {
      events.push(JSON.parse(String(init?.body ?? "{}")) as FlashEvent);
      return json({ ok: true });
    }
    return json({});
  }) as unknown as typeof fetch;
  return events;
}

/** What the connected hardware reports: the chip, its flash, and the USB IDs of the port. */
function connect(hardware: {
  chip: string;
  flash: string;
  features: string[] | null;
  usb: { usbVendorId: number; usbProductId: number };
}) {
  loader.main.mockResolvedValue(hardware.chip);
  loader.detectFlashSize.mockResolvedValue(hardware.flash);
  loader.features.mockResolvedValue(hardware.features);
  Object.defineProperty(navigator, "serial", {
    value: { requestPort: vi.fn(async () => ({ getInfo: () => hardware.usb })) },
    configurable: true,
  });
}

/**
 * Flashing is only reachable from the Controllers page: Add Board opens the
 * single board-action modal, whose first action is the USB flasher.
 */
async function openFlasher(user: ReturnType<typeof userEvent.setup>) {
  render(
    <TimezoneContext.Provider value="UTC">
      <MyBoardsPage canManage canOperate onNavigate={vi.fn()} />
      <Toaster />
    </TimezoneContext.Provider>
  );
  const [addBoard] = await screen.findAllByRole("button", { name: /Add Board/i });
  await user.click(addBoard!);
  const actions = await screen.findByRole("dialog", { name: /Board Actions/ });
  await user.click(within(actions).getByRole("button", { name: /Flash Board/ }));
  return screen.findByRole("dialog", { name: /Flash Board over USB/ });
}

/** The write itself only exists on the flashing step, never on the picker. */
const startButton = () => screen.getByRole("button", { name: /Flash board over USB/i });

async function goToFlashStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^Next$/i }));
  await screen.findByRole("button", { name: /Flash board over USB/i });
}

/** The board is chosen first; its factory image is then selected automatically. */
async function selectBoard(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
  const trigger = screen.getByRole("combobox", { name: /Choose the board you are flashing/i });
  await user.click(trigger);
  const option = await screen.findByRole("option", { name: label });
  for (const boardOption of screen.getAllByRole("option")) {
    expect(boardOption).not.toHaveTextContent(/MB flash|PSRAM/i);
  }
  const boardName = option.textContent ?? "";
  await user.click(option);
  expect(trigger).toHaveTextContent(boardName);
  expect(trigger).not.toHaveTextContent(/MB flash|PSRAM/i);
}

describe("USB flashing from the Controllers page: board check before writing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateApiCache();
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    loader.flashMd5sum.mockResolvedValue(md5Hex(image));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("pauses when another chip is connected, and Cancel flashing leaves the controller untouched", async () => {
    const user = userEvent.setup();
    const events = await serve([await release("rel-s3", devkit, "file-s3")], [devkit, xiaoC3]);
    connect({
      chip: "ESP32-C3 (QFN32) (revision v0.4)",
      flash: "4MB",
      features: ["WiFi", "BLE"],
      usb: { usbVendorId: 0x303a, usbProductId: 0x1001 },
    });
    const dialog = await openFlasher(user);
    // Board first: choosing it pins the factory image built for that board.
    await selectBoard(user, /ESP32-S3-DevKitC-1 N16R8/);
    await goToFlashStep(user);
    await user.click(startButton());

    // The flash stops at the board check and asks.
    const warning = await within(dialog).findByRole("alertdialog", {
      name: "The connected board is not the board you selected",
    });
    expect(within(warning).getByText("Will not start")).toBeInTheDocument();
    expect(within(warning).getByText("Espressif ESP32-S3-DevKitC-1 N16R8")).toBeInTheDocument();
    expect(within(warning).getByText("Seeed Studio XIAO ESP32-C3")).toBeInTheDocument();
    // The page says it is waiting for an answer, not that it is flashing.
    expect(within(dialog).getByRole("button", { name: "Paused: board check" })).toBeDisabled();
    expect(within(dialog).queryByText("Flashing via USB...")).not.toBeInTheDocument();
    expect(loader.writeFlash).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);

    // No firmware exists for the recommended board, so it cannot be switched to.
    expect(within(warning).queryByRole("button", { name: /Use this board/ })).not.toBeInTheDocument();
    expect(within(warning).getByText(/No USB firmware is published for this board yet\./)).toBeInTheDocument();

    await user.click(within(warning).getByRole("button", { name: "Cancel flashing" }));

    // Back at the selection, with what was found and what to do next.
    const stopped = await within(dialog).findByText("Nothing was written to the controller");
    const alert = stopped.closest('[role="alert"], [role="status"]') ?? stopped.parentElement!;
    expect(alert).toHaveTextContent("The connected board is ESP32-C3 · 4 MB flash");
    expect(alert).toHaveTextContent("Recommended board: Seeed Studio XIAO ESP32-C3.");
    // The selection is still the board that did not match, so it says what to change.
    expect(alert).toHaveTextContent("Choose the matching board below, or connect the board you selected.");
    expect(within(dialog).getByRole("button", { name: /^Next$/i })).toBeEnabled();
    expect(within(dialog).queryByRole("alertdialog")).not.toBeInTheDocument();

    expect(loader.writeFlash).not.toHaveBeenCalled();
    expect(loader.disconnect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      status: "failed",
      releaseId: "rel-s3",
      boardCheck: { result: "mismatch", forced: false, selectedBoardSlug: "esp32-s3-devkitc-1-n16r8" },
    });
    expect(events[0]!.boardCheck!.mismatches).toContain("chip_family");
    expect(events[0]!.reportedBoardSlug).toBeUndefined();
  });

  it("asks for the board first and only offers the firmware built for it", async () => {
    const user = userEvent.setup();
    // Two very different boards, each with its own factory image.
    await serve(
      [await release("rel-s3", devkit, "file-s3"), await release("rel-xiao", xiaoC3, "file-xiao")],
      [devkit, xiaoC3]
    );
    connect({
      chip: "ESP32-S3 (QFN56) (revision v0.2)",
      flash: "16MB",
      features: ["WiFi", "BLE", "Embedded PSRAM 8MB (AP_3v3)"],
      usb: { usbVendorId: 0x303a, usbProductId: 0x1001 },
    });
    const dialog = await openFlasher(user);

    // Nothing is preselected, and this page carries no flash button at all.
    expect(within(dialog).getByRole("combobox", { name: /Choose the board you are flashing/i }))
      .toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", { name: /Factory firmware for this board/i }))
      .not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Flash board over USB/i })).toBeNull();
    expect(within(dialog).getByRole("button", { name: /^Next$/i })).toBeDisabled();

    // Choosing an ESP32-C3 board narrows the firmware to the C3 image.
    await selectBoard(user, /XIAO ESP32-C3/);
    const firmware = within(dialog).getByRole("combobox", {
      name: /Factory firmware for this board/i,
    });
    expect(firmware).toHaveTextContent(/HomecoreOS v1\.4\.0/);
    expect(within(dialog).getByText(/is built for this board/)).toBeInTheDocument();

    await user.click(firmware);
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([expect.stringMatching(/HomecoreOS v1\.4\.0/)]);

    // Switching to the ESP32-S3 board swaps the image to the S3 one.
    await user.keyboard("{Escape}");
    await selectBoard(user, /ESP32-S3-DevKitC-1 N16R8/);
    expect(
      within(dialog).getByRole("combobox", { name: /Factory firmware for this board/i })
    ).toHaveTextContent(/HomecoreOS v1\.4\.0/);

    // Only after the picker is done does Next open the step with the USB action.
    const next = within(dialog).getByRole("button", { name: /^Next$/i });
    expect(next).toBeEnabled();
    await user.click(next);
    expect(await screen.findByRole("button", { name: /Flash board over USB/i })).toBeEnabled();
  });

  it("writes only after Force to Flash is confirmed, and then does not send the user to pairing", async () => {
    const user = userEvent.setup();
    const events = await serve([await release("rel-s3", devkit, "file-s3")], [devkit, xiaoC3]);
    connect({
      chip: "ESP32-C3 (QFN32) (revision v0.4)",
      flash: "4MB",
      features: ["WiFi", "BLE"],
      usb: { usbVendorId: 0x303a, usbProductId: 0x1001 },
    });
    const dialog = await openFlasher(user);
    // Board first: choosing it pins the factory image built for that board.
    await selectBoard(user, /ESP32-S3-DevKitC-1 N16R8/);
    await goToFlashStep(user);
    await user.click(startButton());

    const warning = await within(dialog).findByRole("alertdialog");
    const force = within(warning).getByRole("button", { name: "Force to Flash" });
    expect(force).toBeDisabled();
    await user.click(
      within(warning).getByRole("checkbox", {
        name: "I understand that this firmware cannot start on the connected board.",
      })
    );
    expect(loader.writeFlash).not.toHaveBeenCalled();
    await user.click(force);

    // The image is written, and the result says plainly what that means.
    const result = await within(dialog).findByText("Firmware written to a board that does not match");
    expect(loader.writeFlash).toHaveBeenCalledTimes(1);
    const alert = result.closest('[role="alert"], [role="status"]') ?? result.parentElement!;
    expect(alert).toHaveTextContent("the connected board (ESP32-C3 · 4 MB flash) is not Espressif ESP32-S3-DevKitC-1 N16R8");
    expect(alert).toHaveTextContent("The controller will not start with it.");
    expect(within(dialog).queryByText("Factory Firmware Verified & Flashed")).not.toBeInTheDocument();
    expect(
      await screen.findByText(/Firmware written to ESP32-C3 .* although it does not match the selected board\./)
    ).toBeInTheDocument();

    // A controller that cannot start cannot be paired: the next step is the selection.
    expect(within(dialog).queryByRole("button", { name: /Continue to Setup/i })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Install again" }));
    expect(within(dialog).getByRole("button", { name: /^Next$/i })).toBeEnabled();

    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      status: "succeeded",
      boardCheck: { result: "mismatch", forced: true },
    });
    expect(events[0]!.reportedBoardSlug).toBeUndefined();
  });

  it("switches to the recommended board with one click and then flashes without a warning", async () => {
    const user = userEvent.setup();
    // A XIAO ESP32-S3 Plus is connected while the DevKitC is selected: same chip
    // and memory, another maker's USB ID. Firmware exists for both boards.
    const events = await serve(
      [await release("rel-s3", devkit, "file-s3"), await release("rel-xiao", xiaoPlus, "file-xiao")],
      [devkit, xiaoPlus]
    );
    connect({
      chip: "ESP32-S3 (QFN56) (revision v0.2)",
      flash: "16MB",
      features: ["WiFi", "BLE", "Embedded PSRAM 8MB (AP_3v3)"],
      usb: { usbVendorId: 0x2886, usbProductId: 0x0056 },
    });
    const dialog = await openFlasher(user);
    // Board first: choosing it pins the factory image built for that board.
    await selectBoard(user, /ESP32-S3-DevKitC-1 N16R8/);
    await goToFlashStep(user);
    await user.click(startButton());

    const warning = await within(dialog).findByRole("alertdialog");
    // Only the USB identity differs: the wording does not threaten a boot failure.
    expect(within(warning).getByText("Different board")).toBeInTheDocument();
    expect(within(warning).queryByText("May not start")).not.toBeInTheDocument();
    expect(within(warning).getByText("Seeed Studio XIAO ESP32-S3 Plus")).toBeInTheDocument();

    await user.click(within(warning).getByRole("button", { name: /Use this board/ }));
    expect(await screen.findByText("Switched to Seeed Studio XIAO ESP32-S3 Plus.")).toBeInTheDocument();
    expect(loader.writeFlash).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole("alertdialog")).not.toBeInTheDocument();

    // The selection now fits the connected board, so the notice no longer asks
    // for a board to be chosen: it says what is selected and what to do next.
    const stopped = await within(dialog).findByText("Nothing was written to the controller");
    const notice = stopped.closest('[role="alert"], [role="status"]') ?? stopped.parentElement!;
    expect(notice).toHaveTextContent("The connected board is ESP32-S3 · 16 MB flash · 8 MB PSRAM.");
    expect(notice).toHaveTextContent(
      "Seeed Studio XIAO ESP32-S3 Plus is selected now and matches it. Connect again to install the firmware."
    );
    expect(notice).not.toHaveTextContent("Choose the matching board");
    expect(notice).not.toHaveTextContent("does not match");

    // The same hardware, now with its own board selected, goes straight through.
    await goToFlashStep(user);
    await user.click(startButton());
    expect(await within(dialog).findByText("Factory Firmware Verified & Flashed")).toBeInTheDocument();
    expect(within(dialog).queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(loader.writeFlash).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole("button", { name: /Continue to Setup/i })).toBeInTheDocument();

    await waitFor(() => expect(events).toHaveLength(2));
    expect(events[0]).toMatchObject({ status: "failed", releaseId: "rel-s3" });
    expect(events[0]!.reportedBoardSlug).toBeUndefined();
    expect(events[1]).toMatchObject({
      status: "succeeded",
      releaseId: "rel-xiao",
      reportedBoardSlug: "seeed-xiao-esp32s3-plus",
      boardCheck: { result: "match", forced: false, mismatches: [] },
    });
  });

  it("keeps Continue to Setup after a forced flash onto a board that can still start", async () => {
    const user = userEvent.setup();
    const events = await serve([await release("rel-s3", devkit, "file-s3")], [devkit, xiaoPlus]);
    connect({
      chip: "ESP32-S3 (QFN56) (revision v0.2)",
      flash: "16MB",
      features: ["WiFi", "BLE", "Embedded PSRAM 8MB (AP_3v3)"],
      usb: { usbVendorId: 0x2886, usbProductId: 0x0056 },
    });
    const dialog = await openFlasher(user);
    // Board first: choosing it pins the factory image built for that board.
    await selectBoard(user, /ESP32-S3-DevKitC-1 N16R8/);
    await goToFlashStep(user);
    await user.click(startButton());

    const warning = await within(dialog).findByRole("alertdialog");
    await user.click(
      within(warning).getByRole("checkbox", {
        name: "I understand that the controller will be set up as a different board.",
      })
    );
    await user.click(within(warning).getByRole("button", { name: "Force to Flash" }));

    const result = await within(dialog).findByText("Firmware written to a board that does not match");
    const alert = result.closest('[role="alert"], [role="status"]') ?? result.parentElement!;
    expect(alert).toHaveTextContent("The controller should start, but it is set up as Espressif ESP32-S3-DevKitC-1 N16R8");
    expect(alert).not.toHaveTextContent("will not start");
    expect(within(dialog).getByRole("button", { name: /Continue to Setup/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Install again" })).not.toBeInTheDocument();

    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      status: "succeeded",
      boardCheck: { result: "mismatch", forced: true, mismatches: ["usb_vendor"] },
    });
  });
});
