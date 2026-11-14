import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOARD_REVISION_UNSPECIFIED,
  SEEED_XIAO_OFFICIAL_BOARDS,
  VERIFIED_BOARD_CATALOG,
  buildGpioPinSelectorModel,
  verifyUsbBoardIdentity,
  type DetectedUsbBoard,
} from "@homecoreos/shared";
import { BoardDetailsDialog } from "@/components/boards/BoardDetailsDialog";
import { BoardLibraryCard, countOnBoardOnlyGpios } from "@/components/boards/BoardLibraryCard";
import { UsbFlashStagePipeline } from "@/components/firmware/FirmwareProgressPipeline";
import {
  UsbBoardMismatchPanel,
  describeForcedFlashOutcome,
} from "@/components/firmware/UsbBoardMismatchPanel";
import { SensorEditorModal, SwitchEditorModal } from "@/components/hardware/EntityModals";
import { Toaster } from "@/components/ui/sonner";
import type { HardwareContext } from "@/lib/board-pin-helpers";
import { TimezoneContext } from "@/lib/timezone";
import type { UsbFlashBoardReport, UsbFlashTargetBoardSpec } from "@/lib/usb-flasher";
import { AdminBoardsPage } from "./admin/AdminAccountsAndBoardsPages";
import { BoardRemovalDialog } from "./admin/BoardRemovalDialog";
import { OfficialBoardImportDialog } from "./admin/OfficialBoardImportDialog";
import type {
  BoardImportCandidate,
  BoardImportPreview,
  BoardImportRun,
  BoardProfileItem,
  BoardUsageInfo,
  ControllerItem,
  SensorItem,
} from "./types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Replaces fetch with a router and records every request it sees. */
function mockApi(
  route: (call: RecordedCall) => Response | Promise<Response> | undefined
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: typeof input === "string" ? input : input.toString(),
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    return (await route(call)) ?? json({});
  }) as unknown as typeof fetch;
  return calls;
}

const seeed = (slug: string) => {
  const found = SEEED_XIAO_OFFICIAL_BOARDS.find((b) => b.seed.slug === slug);
  if (!found) throw new Error(`missing reference board ${slug}`);
  return found;
};

function seeedItem(slug: string, extra: Partial<BoardProfileItem> = {}): BoardProfileItem {
  return { ...seeed(slug).seed, id: `id-${slug}`, is_available: true, ...extra };
}

const devkit: BoardProfileItem = {
  ...VERIFIED_BOARD_CATALOG.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!,
  id: "id-devkit",
  is_available: true,
};

// ---------------------------------------------------------------------------
// Admin: Import Official Boards
// ---------------------------------------------------------------------------

function candidate(
  slug: string,
  overrides: Partial<BoardImportCandidate> = {}
): BoardImportCandidate {
  const ref = seeed(slug);
  return {
    slug,
    provider: "seeed_xiao",
    name: `${ref.seed.manufacturer} ${ref.seed.model}`,
    status: "new",
    statusDetail: "Not in the Board Library yet.",
    selectable: true,
    verification: "verified",
    verificationNote: "Pin map confirmed against the official Seeed Studio pin table just now.",
    existingBoardId: null,
    board: seeedItem(slug, { id: `preview-${slug}` }),
    highlights: ref.highlights,
    sources: ref.sources,
    checks: [
      {
        key: "pin_table",
        label: "Pin table (Seeed Studio wiki)",
        status: "confirmed",
        detail: "All pads match the official pin table.",
        url: ref.wikiUrl,
      },
      {
        key: "manifest",
        label: "Board manifest (Seeed PlatformIO platform)",
        status: "confirmed",
        detail: "MCU and flash size match the official manifest.",
      },
    ],
    ...overrides,
  };
}

const unsupportedCandidate: BoardImportCandidate = {
  slug: "seeed-xiao-nrf52840",
  provider: "seeed_xiao",
  name: "Seeed Studio XIAO nRF52840",
  status: "unsupported",
  statusDetail: "Uses a chip HomecoreOS does not run on.",
  selectable: false,
  verification: "needs_verification",
  verificationNote: "",
  existingBoardId: null,
  board: null,
  highlights: [],
  sources: [],
  checks: [],
};

function seeedPreview(
  candidates: BoardImportCandidate[],
  overrides: Partial<BoardImportPreview> = {}
): BoardImportPreview {
  return {
    provider: "seeed_xiao",
    providerLabel: "Seeed Studio XIAO",
    fetchedAt: "2026-11-14T10:00:00.000Z",
    liveSourcesReached: 10,
    sourceUrls: [],
    notes: ["Seeed Studio wiki: 4 of 4 pages read", "Seeed PlatformIO manifests: 5 of 5 read"],
    candidates,
    ...overrides,
  };
}

function importRun(slugs: string[], overrides: Partial<BoardImportRun> = {}): BoardImportRun {
  return {
    runId: "run-1",
    provider: "seeed_xiao",
    providerLabel: "Seeed Studio XIAO",
    status: "succeeded",
    requestedCount: slugs.length,
    importedCount: slugs.length,
    restoredCount: 0,
    skippedCount: 0,
    needsVerificationCount: 0,
    outcomes: slugs.map((slug) => ({
      slug,
      name: `Seeed Studio ${seeed(slug).seed.model}`,
      action: "imported",
      detail: "Added with its verified pin map and published.",
      boardId: `new-${slug}`,
      published: true,
      verification: "verified",
    })),
    sourceNotes: ["Seeed Studio wiki: 4 of 4 pages read"],
    summaryNotes: `Seeed Studio wiki: 4 of 4 pages read · Import: ${slugs.length} added, 0 restored, 0 skipped of ${slugs.length} selected.`,
    ...overrides,
  };
}

function renderImportDialog(onImported = vi.fn(), onOpenChange = vi.fn()) {
  render(
    <>
      <OfficialBoardImportDialog open onOpenChange={onOpenChange} onImported={onImported} />
      <Toaster />
    </>
  );
  return { onImported, onOpenChange };
}

const row = (slug: string) => screen.getByTestId(`import-candidate-${slug}`);
const importButton = () =>
  screen.getByRole("button", { name: /^(Import \d+ boards?|Select boards to import|Importing\.\.\.)$/ });

describe("Import Official Boards", () => {
  it("previews the source without saving, imports only the selected boards and reports each one", async () => {
    const user = userEvent.setup();
    const preview = seeedPreview([
      candidate("seeed-xiao-esp32s3", {
        status: "in_library",
        selectable: false,
        statusDetail: "Already in the Board Library (published). Its configuration is left untouched.",
        existingBoardId: "cat-xiao",
      }),
      candidate("seeed-xiao-esp32c3"),
      candidate("seeed-xiao-esp32c6"),
      candidate("seeed-xiao-esp32s3-plus"),
      unsupportedCandidate,
    ]);
    const calls = mockApi((call) => {
      if (call.url === "/api/admin/boards/import/preview") return json({ preview });
      if (call.url === "/api/admin/boards/import") {
        return json({ run: importRun((call.body as { slugs: string[] }).slugs) });
      }
      return undefined;
    });
    const { onImported } = renderImportDialog();

    // Step 1: the source. Nothing is requested until the admin asks for a preview.
    expect(screen.getByRole("radio", { name: /Seeed Studio XIAO/i })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /Preview boards/i }));

    // Step 2: every board of the source, with its state in the library.
    await screen.findByRole("list", { name: /Boards found at the source/i });
    expect(calls).toEqual([
      { url: "/api/admin/boards/import/preview", method: "POST", body: { provider: "seeed_xiao" } },
    ]);
    expect(screen.getByText(/4 boards · 3 can be imported/)).toBeInTheDocument();
    expect(screen.getByText(/Checked against 10 official sources/)).toBeInTheDocument();

    // A board that is already in the library cannot be selected.
    const existing = row("seeed-xiao-esp32s3");
    expect(within(existing).getByText("Already in library")).toBeInTheDocument();
    expect(within(existing).getByText(/Its configuration is left untouched/)).toBeInTheDocument();
    expect(within(existing).getByRole("checkbox")).toBeDisabled();

    // A board that cannot run HomecoreOS is listed apart, not among the choices.
    expect(screen.queryByTestId("import-candidate-seeed-xiao-nrf52840")).not.toBeInTheDocument();
    const others = screen.getByRole("button", { name: /1 other board at this source cannot be imported/ });
    expect(screen.queryByText("Seeed Studio XIAO nRF52840")).not.toBeInTheDocument();
    await user.click(others);
    expect(screen.getByText("Seeed Studio XIAO nRF52840")).toBeInTheDocument();

    // Nothing is selected by default, so nothing can be imported by accident.
    expect(importButton()).toHaveTextContent("Select boards to import");
    expect(importButton()).toBeDisabled();

    await user.click(within(row("seeed-xiao-esp32c3")).getByRole("checkbox"));
    expect(importButton()).toHaveTextContent("Import 1 board");
    await user.click(within(row("seeed-xiao-esp32s3-plus")).getByRole("checkbox"));
    expect(importButton()).toHaveTextContent("Import 2 boards");
    expect(importButton()).toBeEnabled();

    // The preview itself wrote nothing.
    expect(calls.filter((c) => c.url === "/api/admin/boards/import")).toHaveLength(0);
    await user.click(importButton());

    // Step 3: only the two selected boards were sent, by slug. No pin data leaves the browser.
    await screen.findByRole("list", { name: /Import result per board/i });
    expect(calls[calls.length - 1]).toEqual({
      url: "/api/admin/boards/import",
      method: "POST",
      body: {
        provider: "seeed_xiao",
        slugs: ["seeed-xiao-esp32c3", "seeed-xiao-esp32s3-plus"],
        publish: true,
      },
    });
    expect(screen.getByText("2 imported · 0 restored · 0 skipped")).toBeInTheDocument();
    const outcomes = within(screen.getByRole("list", { name: /Import result per board/i }));
    expect(outcomes.getAllByRole("listitem")).toHaveLength(2);
    expect(outcomes.getByText("Seeed Studio XIAO ESP32-C3")).toBeInTheDocument();
    expect(outcomes.getByText("Seeed Studio XIAO ESP32-S3 Plus")).toBeInTheDocument();
    expect(outcomes.getAllByText("Imported")).toHaveLength(2);
    expect(outcomes.getAllByText("Published")).toHaveLength(2);
    // The counts are stated once, in the title; the note below does not repeat them.
    expect(screen.getByText(/Seeed Studio wiki: 4 of 4 pages read/)).toBeInTheDocument();
    expect(screen.queryByText(/Import: 2 added/)).not.toBeInTheDocument();

    expect(onImported).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(/2 boards added to the Board Library from Seeed Studio XIAO/)
    ).toBeInTheDocument();
  });

  it("selects every importable board at once, and can add them hidden", async () => {
    const user = userEvent.setup();
    const preview = seeedPreview([
      candidate("seeed-xiao-esp32s3", { status: "in_library", selectable: false }),
      candidate("seeed-xiao-esp32c3"),
      candidate("seeed-xiao-esp32c5", {
        verification: "needs_verification",
        verificationNote: "The official pin table disagrees with the built-in profile: D3.",
        checks: [
          {
            key: "pin_table",
            label: "Pin table (Seeed Studio wiki)",
            status: "conflict",
            detail: "D3 is GPIO26 in the official table, GPIO7 in the profile.",
          },
        ],
      }),
    ]);
    const calls = mockApi((call) => {
      if (call.url === "/api/admin/boards/import/preview") return json({ preview });
      if (call.url === "/api/admin/boards/import") {
        const slugs = (call.body as { slugs: string[] }).slugs;
        return json({
          run: importRun(slugs, {
            needsVerificationCount: 1,
            outcomes: importRun(slugs).outcomes.map((o) =>
              o.slug === "seeed-xiao-esp32c5"
                ? {
                    ...o,
                    published: false,
                    verification: "needs_verification",
                    detail: "Added hidden. The pin map must be verified before it can be published.",
                  }
                : { ...o, published: false, detail: "Added with its verified pin map, hidden from users." }
            ),
          }),
        });
      }
      return undefined;
    });
    renderImportDialog();
    await user.click(screen.getByRole("button", { name: /Preview boards/i }));
    await screen.findByRole("list", { name: /Boards found at the source/i });

    // A board whose official source disagrees is offered, but flagged.
    const conflict = row("seeed-xiao-esp32c5");
    expect(within(conflict).getByText("Needs verification")).toBeInTheDocument();
    expect(within(conflict).getByText(/disagrees with the built-in profile/)).toBeInTheDocument();
    expect(within(conflict).getByText(/: Conflict/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Select all (2)" }));
    expect(importButton()).toHaveTextContent("Import 2 boards");
    expect(within(row("seeed-xiao-esp32s3")).getByRole("checkbox")).not.toBeChecked();
    expect(
      screen.getByText(/1 selected board will be added hidden, because its pin map is not verified/)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(importButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Select all (2)" }));

    await user.click(screen.getByRole("switch", { name: /Publish verified boards right away/i }));
    await user.click(importButton());

    await screen.findByRole("list", { name: /Import result per board/i });
    expect(calls[calls.length - 1]!.body).toEqual({
      provider: "seeed_xiao",
      slugs: ["seeed-xiao-esp32c3", "seeed-xiao-esp32c5"],
      publish: false,
    });
    expect(screen.getAllByText("Hidden")).toHaveLength(2);
    expect(screen.getByText(/1 added hidden: verify the pin map before publishing/)).toBeInTheDocument();
  });

  it("shows the pinout and the official sources of a board before it is imported", async () => {
    const user = userEvent.setup();
    const plus = seeed("seeed-xiao-esp32s3-plus");
    mockApi((call) =>
      call.url === "/api/admin/boards/import/preview"
        ? json({ preview: seeedPreview([candidate("seeed-xiao-esp32s3-plus")]) })
        : undefined
    );
    renderImportDialog();
    await user.click(screen.getByRole("button", { name: /Preview boards/i }));
    await screen.findByRole("list", { name: /Boards found at the source/i });

    const toggle = screen.getByRole("button", { name: /Show details of Seeed Studio XIAO ESP32-S3 Plus/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(
      screen.getByRole("button", { name: /Hide details of Seeed Studio XIAO ESP32-S3 Plus/ })
    ).toHaveAttribute("aria-expanded", "true");

    // The pad table follows the maker's own names, including the back pads,
    // and every pad shows the GPIO that Seeed's pin table prints for it.
    const table = screen.getByRole("table", { name: /Pads of Seeed Studio XIAO ESP32-S3 Plus/ });
    const padHeaders = within(table).getAllByRole("rowheader");
    const gpioOfPad = (pad: string) => {
      // A pad is printed as "D11" or with its bus role, as in "D4 / SDA".
      const header = padHeaders.find(
        (th) => th.textContent === pad || th.textContent?.startsWith(`${pad} /`)
      );
      if (!header) throw new Error(`pad ${pad} is missing from the table`);
      return within(header.closest("tr")!).getAllByRole("cell")[0]!.textContent;
    };
    expect(Object.keys(plus.officialPinMap)).toHaveLength(20);
    for (const [pad, gpio] of Object.entries(plus.officialPinMap)) {
      expect(gpioOfPad(pad), pad).toBe(`GPIO${gpio}`);
    }
    expect(gpioOfPad("D11")).toBe("GPIO38");
    expect(gpioOfPad("D4")).toBe("GPIO5");
    // One row per GPIO pad. Power and ground pads are not GPIOs and are left out.
    expect(padHeaders).toHaveLength(20);
    expect(within(table).queryByRole("rowheader", { name: "GND" })).not.toBeInTheDocument();

    // Each check names its source and links to it.
    const pinCheck = screen.getByText(/Pin table \(Seeed Studio wiki\): Confirmed\./);
    const link = within(pinCheck.closest("li")!).getByRole("link", { name: /Open source/ });
    expect(link).toHaveAttribute("href", plus.wikiUrl);
    expect(link).toHaveAttribute("target", "_blank");
    for (const source of plus.sources) {
      expect(screen.getByRole("link", { name: source.label })).toHaveAttribute("href", source.url);
    }
  });

  it("says so when the official sources cannot be reached, and when the preview fails", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const calls = mockApi((call) => {
      if (call.url !== "/api/admin/boards/import/preview") return undefined;
      attempt += 1;
      if (attempt === 1) return json({ error: "The import source did not answer." }, 502);
      return json({
        preview: seeedPreview(
          [
            candidate("seeed-xiao-esp32c3", {
              verificationNote: "Built-in profile. The official sources could not be reached to compare it.",
              checks: [
                {
                  key: "pin_table",
                  label: "Pin table (Seeed Studio wiki)",
                  status: "unreachable",
                  detail: "The page could not be read.",
                },
              ],
            }),
          ],
          { liveSourcesReached: 0, notes: ["Seeed Studio wiki: 0 of 4 pages read"] }
        ),
      });
    });
    renderImportDialog();
    await user.click(screen.getByRole("button", { name: /Preview boards/i }));

    // A failed preview is an error with a way forward, not an empty list.
    expect(await screen.findByText("The preview could not be loaded")).toBeInTheDocument();
    expect(screen.getByText("The import source did not answer.")).toBeInTheDocument();
    expect(importButton()).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /Try again/i }));
    await screen.findByRole("list", { name: /Boards found at the source/i });
    expect(calls).toHaveLength(2);
    expect(screen.queryByText("The preview could not be loaded")).not.toBeInTheDocument();

    // Offline: the boards come from the built-in profiles, and the dialog says that.
    expect(screen.getByText("Official sources not reachable")).toBeInTheDocument();
    expect(screen.getByText("Preview from built-in profiles")).toBeInTheDocument();
    expect(screen.queryByText(/Checked against/)).not.toBeInTheDocument();
    expect(within(row("seeed-xiao-esp32c3")).getByText(/: Source not reachable/)).toBeInTheDocument();
  });

  it("keeps the selection and explains the error when the import fails", async () => {
    const user = userEvent.setup();
    mockApi((call) => {
      if (call.url === "/api/admin/boards/import/preview") {
        return json({ preview: seeedPreview([candidate("seeed-xiao-esp32c6")]) });
      }
      if (call.url === "/api/admin/boards/import") {
        return json({ error: "The Board Library could not be updated." }, 500);
      }
      return undefined;
    });
    const { onImported } = renderImportDialog();
    await user.click(screen.getByRole("button", { name: /Preview boards/i }));
    await screen.findByRole("list", { name: /Boards found at the source/i });
    await user.click(within(row("seeed-xiao-esp32c6")).getByRole("checkbox"));
    await user.click(importButton());

    expect(await screen.findByText("The Board Library could not be updated.")).toBeInTheDocument();
    // Still on the preview, with the same board selected, ready to retry.
    expect(within(row("seeed-xiao-esp32c6")).getByRole("checkbox")).toBeChecked();
    expect(importButton()).toHaveTextContent("Import 1 board");
    expect(importButton()).toBeEnabled();
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.queryByRole("list", { name: /Import result per board/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Admin: removing a board
// ---------------------------------------------------------------------------

const freeUsage: BoardUsageInfo = {
  controllerCount: 0,
  savedByAccountCount: 1,
  firmwareReleaseCount: 0,
  canRemove: true,
  blockers: [],
  consequences: [
    "The board disappears from the user Board Library and from new controller setups.",
    "1 account has it in My Boards. It is hidden there until the board is restored.",
  ],
};

const blockedUsage: BoardUsageInfo = {
  controllerCount: 2,
  savedByAccountCount: 1,
  firmwareReleaseCount: 1,
  canRemove: false,
  blockers: [
    "2 controllers run on this board. Removing it would leave them without a pin map. Hide the board instead.",
  ],
  consequences: [],
};

describe("Removing a board from the Board Library", () => {
  const board = seeedItem("seeed-xiao-esp32s3-plus", { id: "board-plus" });

  it("shows what depends on the board and removes it only after confirmation", async () => {
    const user = userEvent.setup();
    let releaseUsage: (response: Response) => void = () => {};
    const calls = mockApi((call) => {
      if (call.url === "/api/admin/boards/board-plus/usage") {
        return new Promise<Response>((resolve) => {
          releaseUsage = resolve;
        });
      }
      return undefined;
    });
    const onRemoved = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <>
        <BoardRemovalDialog board={board} onOpenChange={onOpenChange} onRemoved={onRemoved} />
        <Toaster />
      </>
    );

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText('Remove "Seeed Studio XIAO ESP32-S3 Plus"?')).toBeInTheDocument();
    // Until the server has said what uses the board, it cannot be removed.
    expect(within(dialog).getByText(/Checking what uses this board/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remove board" })).toBeDisabled();

    releaseUsage(json({ usage: freeUsage }));
    const consequences = await within(dialog).findByRole("list", { name: /What removing the board does/ });
    expect(within(consequences).getAllByRole("listitem")).toHaveLength(2);
    expect(within(dialog).getByText(/1 account has it in My Boards/)).toBeInTheDocument();
    expect(within(dialog).getByText("Saved by accounts").previousElementSibling).toHaveTextContent("1");

    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Remove board" }));

    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([
      { url: "/api/admin/boards/board-plus", method: "DELETE", body: null },
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(
      await screen.findByText('Removed "Seeed Studio XIAO ESP32-S3 Plus" from the Board Library.')
    ).toBeInTheDocument();
  });

  it("refuses to remove a board that controllers run on", async () => {
    const user = userEvent.setup();
    const calls = mockApi((call) =>
      call.url === "/api/admin/boards/board-plus/usage" ? json({ usage: blockedUsage }) : undefined
    );
    const onRemoved = vi.fn();
    const onOpenChange = vi.fn();
    render(<BoardRemovalDialog board={board} onOpenChange={onOpenChange} onRemoved={onRemoved} />);

    const dialog = await screen.findByRole("alertdialog");
    expect(
      await within(dialog).findByText('"Seeed Studio XIAO ESP32-S3 Plus" cannot be removed')
    ).toBeInTheDocument();
    const blockers = within(dialog).getByRole("list", { name: /Why the board cannot be removed/ });
    expect(within(blockers).getByText(/2 controllers run on this board/)).toBeInTheDocument();
    expect(within(dialog).getByText("Controllers").previousElementSibling).toHaveTextContent("2");

    // There is no way to remove it from here: the only action closes the dialog.
    expect(within(dialog).queryByRole("button", { name: "Remove board" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("shows the fresh state when the board came into use while the dialog was open", async () => {
    const user = userEvent.setup();
    let usageRequests = 0;
    mockApi((call) => {
      if (call.url === "/api/admin/boards/board-plus/usage") {
        usageRequests += 1;
        return json({ usage: usageRequests === 1 ? freeUsage : blockedUsage });
      }
      if (call.method === "DELETE") {
        return json({ error: "This board is in use by 2 controllers and cannot be removed." }, 409);
      }
      return undefined;
    });
    const onRemoved = vi.fn();
    const onOpenChange = vi.fn();
    render(<BoardRemovalDialog board={board} onOpenChange={onOpenChange} onRemoved={onRemoved} />);

    const dialog = await screen.findByRole("alertdialog");
    await within(dialog).findByRole("list", { name: /What removing the board does/ });
    await user.click(within(dialog).getByRole("button", { name: "Remove board" }));

    // The server refused: the dialog switches to the blocked state instead of closing.
    expect(
      await within(dialog).findByText('"Seeed Studio XIAO ESP32-S3 Plus" cannot be removed')
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/2 controllers run on this board/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Remove board" })).not.toBeInTheDocument();
    expect(usageRequests).toBe(2);
    expect(onRemoved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("offers removal in the admin table only to super admins, and removes the board from the list", async () => {
    const user = userEvent.setup();
    const rows = [{ ...devkit, id: "board-devkit" }, board];
    const removed = new Set<string>();
    const calls = mockApi((call) => {
      if (call.url === "/api/admin/boards" && call.method === "GET") {
        return json({ boards: rows.filter((row) => !removed.has(row.id)), syncRuns: [] });
      }
      if (call.url === "/api/admin/boards/board-plus/usage") {
        return json({ board, usage: freeUsage });
      }
      if (call.url === "/api/admin/boards/board-plus" && call.method === "DELETE") {
        removed.add("board-plus");
        return json({ ok: true, removed: board, usage: freeUsage });
      }
      return undefined;
    });

    // The Worker lets only super admins remove a board, so operators and
    // support staff are not offered the control at all.
    const operatorView = render(
      <TimezoneContext.Provider value="UTC">
        <AdminBoardsPage />
      </TimezoneContext.Provider>
    );
    expect(await screen.findByText("XIAO ESP32-S3 Plus")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import Official Boards/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();
    operatorView.unmount();

    render(
      <TimezoneContext.Provider value="UTC">
        <AdminBoardsPage isSuperAdmin />
        <Toaster />
      </TimezoneContext.Provider>
    );
    expect(await screen.findAllByRole("button", { name: /^Remove / })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Remove Seeed Studio XIAO ESP32-S3 Plus" }));

    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Remove board" });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    await user.click(confirm);

    // The row is gone after the reload; the other board is untouched.
    await waitFor(() => expect(screen.queryByText("XIAO ESP32-S3 Plus")).not.toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(1);
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.url)).toEqual([
      "/api/admin/boards/board-plus",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Board Library cards and the Details view
// ---------------------------------------------------------------------------

describe("Board Library card and details", () => {
  /** Label -> value, as a screen reader meets the rows of a card. */
  function cardFields(card: HTMLElement): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const term of within(card).getAllByRole("term")) {
      fields[term.textContent ?? ""] = term.nextElementSibling?.textContent ?? "";
    }
    return fields;
  }

  it("gives every card the same fields in the same order, with the drawing on top", () => {
    const boards = [devkit, seeedItem("seeed-xiao-esp32c3"), seeedItem("seeed-xiao-esp32s3-plus")];
    render(
      <div>
        {boards.map((board) => (
          <div key={board.id} data-testid={`card-${board.slug}`}>
            <BoardLibraryCard
              board={board}
              source={board.catalog_category === "partner" ? "partner" : "official"}
              onOpenDetails={vi.fn()}
              action={<button type="button">Save</button>}
            />
          </div>
        ))}
      </div>
    );

    const order = ["Chip", "Memory", "Wireless", "Pins", "Firmware"];
    for (const board of boards) {
      const card = screen.getByTestId(`card-${board.slug}`);
      expect(Object.keys(cardFields(card)), board.slug).toEqual(order);
      // The drawing comes before the name, the name before the fields, the actions last.
      const drawing = within(card).getByRole("button", { name: `Preview ${board.model} vector pin diagram` });
      const title = within(card).getByRole("heading", { name: board.model });
      const details = within(card).getByRole("button", { name: "Details" });
      const save = within(card).getByRole("button", { name: "Save" });
      const follows = (a: Element, b: Element) =>
        Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      expect(follows(drawing, title)).toBe(true);
      expect(follows(title, within(card).getAllByRole("term")[0]!)).toBe(true);
      expect(follows(within(card).getAllByRole("term")[4]!, details)).toBe(true);
      expect(follows(details, save)).toBe(true);
    }

    expect(cardFields(screen.getByTestId("card-esp32-s3-devkitc-1-n16r8"))).toMatchObject({
      Chip: "ESP32-S3-WROOM-1-N16R8",
      Memory: "16MB Flash + 8MB PSRAM",
      Pins: "36 on headers",
      Firmware: "Firmware Supported",
    });
    expect(cardFields(screen.getByTestId("card-seeed-xiao-esp32c3"))).toMatchObject({
      Chip: "ESP32-C3",
      Memory: "4MB Flash",
      Pins: "11 on headers",
      Firmware: "Catalog Only",
    });
    // Extra solder pads are counted apart from the header pins.
    expect(cardFields(screen.getByTestId("card-seeed-xiao-esp32s3-plus")).Pins).toBe(
      "11 on headers + 9 pads"
    );

    const plus = screen.getByTestId("card-seeed-xiao-esp32s3-plus");
    expect(within(plus).getByText("Partner")).toBeInTheDocument();
    expect(within(plus).getByText("Verified")).toBeInTheDocument();
    expect(within(plus).getByText("Seeed Studio · v1.1")).toBeInTheDocument();
    expect(within(screen.getByTestId("card-esp32-s3-devkitc-1-n16r8")).getByText("Official")).toBeInTheDocument();
  });

  it("opens the details from the card, and never shows a revision the maker did not publish", async () => {
    const user = userEvent.setup();
    const c5 = seeedItem("seeed-xiao-esp32c5");
    expect(c5.revision).toBe(BOARD_REVISION_UNSPECIFIED);
    const onOpenDetails = vi.fn();
    const { rerender } = render(
      <BoardLibraryCard board={c5} source="partner" onOpenDetails={onOpenDetails} />
    );

    // The card names the maker only. No placeholder, no guessed "v1.0".
    expect(screen.getByText("Seeed Studio")).toBeInTheDocument();
    expect(screen.queryByText(/unspecified/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/v1\.0/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Details" }));
    await user.click(screen.getByRole("button", { name: /Preview XIAO ESP32-C5 vector pin diagram/ }));
    expect(onOpenDetails).toHaveBeenCalledTimes(2);

    rerender(
      <TimezoneContext.Provider value="UTC">
        <BoardDetailsDialog board={c5} onClose={vi.fn()} />
      </TimezoneContext.Provider>
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Seeed Studio XIAO ESP32-C5" })).toBeInTheDocument();
    expect(within(dialog).getByText("Revision").nextElementSibling).toHaveTextContent(
      "Not stated by the maker"
    );
    expect(within(dialog).queryByText(/unspecified/i)).not.toBeInTheDocument();
  });

  it("splits the details into board details and pinout details, with the official resources", async () => {
    const user = userEvent.setup();
    const plus = seeedItem("seeed-xiao-esp32s3-plus");
    render(
      <TimezoneContext.Provider value="UTC">
        <BoardDetailsDialog board={plus} onClose={vi.fn()} />
      </TimezoneContext.Provider>
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Seeed Studio XIAO ESP32-S3 Plus (v1.1)" })
    ).toBeInTheDocument();

    const field = (label: string) => within(dialog).getByText(label).nextElementSibling;
    expect(within(dialog).getByRole("tab", { name: "Board details" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(field("Manufacturer")).toHaveTextContent("Seeed Studio");
    expect(field("Flash size")).toHaveTextContent("16 MB");
    expect(field("PSRAM size")).toHaveTextContent("8 MB");
    expect(field("USB ID")).toHaveTextContent("0x2886:0x0056");
    expect(field("Boot button")).toHaveTextContent("GPIO0");
    expect(field("GPIO pins")).toHaveTextContent("11 on headers + 9 pads");
    // 20 GPIOs can be wired; the user LED (GPIO21) and the BOOT button (GPIO0)
    // are in the profile too, and the count says where the difference comes from.
    expect(field("GPIO in the profile")).toHaveTextContent("22, of which 2 on-board only");
    expect(countOnBoardOnlyGpios(plus)).toBe(2);
    const padGpios = new Set(
      Object.values(
        SEEED_XIAO_OFFICIAL_BOARDS.find((b) => b.seed.slug === "seeed-xiao-esp32s3-plus")!.officialPinMap
      )
    );
    expect(
      plus.gpio_definitions
        .map((gpio) => gpio.pin)
        .filter((pin) => !padGpios.has(pin))
        .sort((a, b) => a - b)
    ).toEqual([0, 21]);
    expect(field("Back pads (D11-D19)")).toHaveTextContent("D11, D12, D13, D14, D15, D16, D17, D18, D19");
    expect(within(dialog).getByRole("link", { name: /Documentation/ })).toHaveAttribute(
      "href",
      plus.docs_url
    );
    expect(within(dialog).getByRole("link", { name: /Datasheet/ })).toHaveAttribute(
      "href",
      plus.datasheet_url
    );
    expect(within(dialog).getByRole("link", { name: /Official pinout diagram/ })).toHaveAttribute(
      "href",
      plus.pinout_image_url
    );

    // The pinout is one click away and includes the nine back pads.
    await user.click(within(dialog).getByRole("tab", { name: "Pinout details" }));
    const pads = await within(dialog).findByTestId("extra-pads");
    expect(within(pads).getAllByRole("button")).toHaveLength(9);
    expect(within(pads).getByRole("button", { name: /D11/ })).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: /open the official pinout diagram/ })
    ).toHaveAttribute("href", plus.pinout_image_url);
  });
});

// ---------------------------------------------------------------------------
// GPIO pin selector
// ---------------------------------------------------------------------------

function controller(id: string, name: string, boardId: string, board: BoardProfileItem): ControllerItem {
  return {
    id,
    account_id: "a1",
    home_id: "h1",
    name,
    board_catalog_id: boardId,
    custom_board_id: null,
    board_model: board.model,
    chip_variant: board.chip_variant,
    flash_size_mb: board.flash_size_mb,
    psram_size_mb: board.psram_size_mb,
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
  };
}

const usedOnHub = [
  { entityKind: "switch" as const, id: "sw-1", name: "Hallway Sconce", pin: 4 },
  { entityKind: "device" as const, id: "dev-2", name: "Door Lock", pin: 7 },
];

function hubContext(): HardwareContext {
  return {
    rooms: [],
    controllers: [controller("c1", "Hall Hub", devkit.id, devkit)],
    boardsById: new Map([[devkit.id, devkit]]),
    usedPinsByController: new Map([["c1", usedOnHub]]),
  };
}

describe("GPIO pin selector", () => {
  const tile = (pin: number) => {
    const found = screen.getByTestId("gpio-pin-map").querySelector<HTMLButtonElement>(`button[data-pin="${pin}"]`);
    if (!found) throw new Error(`no tile for GPIO${pin}`);
    return found;
  };
  const pinField = () => screen.getByLabelText("GPIO Pin") as HTMLInputElement;

  it("starts a new switch on a suggested pin and shows the state of every pin of the board", () => {
    mockApi(() => undefined);
    render(<SwitchEditorModal open onOpenChange={vi.fn()} switchItem={null} ctx={hubContext()} onSaved={vi.fn()} />);

    const model = buildGpioPinSelectorModel({ board: devkit, requirement: "digital_out", usedPins: usedOnHub });
    expect(model.suggestions.length).toBeGreaterThan(0);
    // The field starts on the best suggestion, never on a pin that would be refused.
    expect(pinField().value).toBe(String(model.suggestions[0]));
    expect(tile(model.suggestions[0]!)).toHaveAttribute("aria-pressed", "true");
    expect(tile(model.suggestions[0]!)).toHaveAttribute("data-state", "available");

    // One tile per pin of the board, each in exactly one of the four states.
    const map = screen.getByTestId("gpio-pin-map");
    const tiles = Array.from(map.querySelectorAll<HTMLButtonElement>("button[data-pin]"));
    expect(tiles).toHaveLength(devkit.gpio_definitions.length);
    for (const state of ["available", "used", "restricted", "dangerous"] as const) {
      expect(tiles.filter((t) => t.dataset.state === state), state).toHaveLength(model.counts[state]);
    }
    const legend = within(map).getByRole("list", { name: "Pin states" });
    expect(legend).toHaveTextContent(`Available${model.counts.available}`);
    expect(legend).toHaveTextContent(`Used${model.counts.used}`);
    expect(legend).toHaveTextContent(`Restricted${model.counts.restricted}`);
    expect(legend).toHaveTextContent(`Dangerous${model.counts.dangerous}`);

    // Each state is told apart by more than colour: the tile says it.
    expect(tile(4)).toHaveAttribute("data-state", "used");
    expect(tile(4)).toHaveTextContent("Hallway Sconce");
    expect(tile(4)).toHaveAccessibleName(/GPIO 4, used.*Hallway Sconce/);
    expect(tile(0)).toHaveAttribute("data-state", "restricted");
    expect(tile(0)).toHaveTextContent("STRAP");
    expect(tile(35)).toHaveAttribute("data-state", "dangerous");
    expect(tile(35)).toHaveTextContent("FLASH");
    expect(tile(35)).toHaveAttribute("aria-disabled", "true");
    expect(tile(model.suggestions[1]!)).toHaveAttribute("data-suggested", "true");
    expect(tile(model.suggestions[1]!)).toHaveAccessibleName(/suggested/);

    // The whole map is a single tab stop.
    expect(tiles.filter((t) => t.tabIndex === 0)).toHaveLength(1);
  });

  it("prevents conflicting choices and explains every pin that cannot be chosen", async () => {
    const user = userEvent.setup();
    const calls = mockApi(() => undefined);
    const onSaved = vi.fn();
    render(<SwitchEditorModal open onOpenChange={vi.fn()} switchItem={null} ctx={hubContext()} onSaved={onSaved} />);
    const map = screen.getByTestId("gpio-pin-map");
    const start = pinField().value;
    const create = screen.getByRole("button", { name: "Create Switch" });

    // A pin another device holds: the choice stays, and the map names the device.
    await user.click(tile(7));
    expect(pinField().value).toBe(start);
    expect(within(map).getByText(/GPIO7 · Used\./)).toBeInTheDocument();
    expect(
      within(map).getByText(/GPIO 7 is already assigned to device "Door Lock" on this controller\./)
    ).toBeInTheDocument();

    // A pin wired to the flash: refused, with the reason.
    await user.click(tile(35));
    expect(pinField().value).toBe(start);
    expect(within(map).getByText(/GPIO35 · Dangerous\./)).toBeInTheDocument();
    expect(within(map).getByText(/wired to the internal flash \/ PSRAM/)).toBeInTheDocument();

    // A boot-strapping pin: refused, with the reason.
    await user.click(tile(0));
    expect(pinField().value).toBe(start);
    expect(within(map).getByText(/GPIO 0 is a boot-strapping pin/)).toBeInTheDocument();
    expect(create).toBeEnabled();

    // Typing a taken pin is caught as well, and it cannot be saved.
    await user.clear(pinField());
    await user.type(pinField(), "7");
    expect(pinField()).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getAllByText(/GPIO 7 is already assigned to device "Door Lock" on this controller\./).length
    ).toBeGreaterThan(0);
    expect(tile(7)).toHaveAttribute("aria-pressed", "true");
    expect(create).toBeDisabled();
    await user.clear(pinField());
    expect(screen.getByText("Choose a GPIO pin from the map, or type its number.")).toBeInTheDocument();
    expect(create).toBeDisabled();

    // A free pin is taken over into the field, and that is what gets saved.
    await user.click(tile(9));
    expect(pinField().value).toBe("9");
    expect(tile(9)).toHaveAttribute("aria-pressed", "true");
    expect(pinField()).toHaveAttribute("aria-invalid", "false");
    expect(create).toBeEnabled();

    await user.type(screen.getByLabelText("Switch Name"), "Porch Light");
    await user.click(create);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls).toEqual([
      {
        url: "/api/switches",
        method: "POST",
        body: { name: "Porch Light", controllerId: "c1", roomId: null, gpioPin: 9, invertedLogic: false },
      },
    ]);
  });

  it("offers suggested pins as one-click choices and moves through the map with the arrow keys", async () => {
    const user = userEvent.setup();
    mockApi(() => undefined);
    render(<SwitchEditorModal open onOpenChange={vi.fn()} switchItem={null} ctx={hubContext()} onSaved={vi.fn()} />);
    const model = buildGpioPinSelectorModel({ board: devkit, requirement: "digital_out", usedPins: usedOnHub });
    const [first, second] = model.suggestions as [number, number];

    expect(screen.getByText("Suggested for a switch")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `Use suggested GPIO${second}` }));
    expect(pinField().value).toBe(String(second));
    expect(tile(second)).toHaveAttribute("aria-pressed", "true");
    expect(tile(first)).toHaveAttribute("aria-pressed", "false");

    // Arrow keys walk the tiles in reading order; Home and End jump to the ends.
    const tiles = Array.from(
      screen.getByTestId("gpio-pin-map").querySelectorAll<HTMLButtonElement>("button[data-pin]")
    );
    const index = tiles.indexOf(tile(second));
    tile(second).focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tiles[index + 1]);
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(document.activeElement).toBe(tiles[index - 1]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(tiles[0]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(tiles[tiles.length - 1]);
    // Moving the focus only inspects a pin. It never changes the choice.
    expect(pinField().value).toBe(String(second));

    // Enter on a free pin chooses it; on a blocked pin it explains instead.
    tile(1).focus();
    await user.keyboard("{Enter}");
    expect(pinField().value).toBe("1");
    tile(35).focus();
    await user.keyboard("{Enter}");
    expect(pinField().value).toBe("1");
    expect(screen.getByText(/wired to the internal flash \/ PSRAM/)).toBeInTheDocument();
  });

  it("keeps the pin of an I2C sensor optional and shows the pad names printed on the board", async () => {
    const user = userEvent.setup();
    const xiao = seeedItem("seeed-xiao-esp32c3");
    const sensor: SensorItem = {
      id: "sen-1",
      account_id: "a1",
      home_id: "h1",
      room_id: null,
      controller_id: "c2",
      name: "Desk Climate",
      sensor_type: "temperature_bme280",
      gpio_pin: 6,
      i2c_address: "0x76",
      unit: "°C",
      last_value: null,
      last_raw_payload: null,
      is_online: true,
      last_reading_at: null,
    };
    const ctx: HardwareContext = {
      rooms: [],
      controllers: [controller("c2", "Desk XIAO", xiao.id, xiao)],
      boardsById: new Map([[xiao.id, xiao]]),
      usedPinsByController: new Map([
        ["c2", [{ entityKind: "sensor" as const, id: "sen-1", name: "Desk Climate", pin: 6 }]],
      ]),
    };
    const calls = mockApi(() => undefined);
    const onSaved = vi.fn();
    render(<SensorEditorModal open onOpenChange={vi.fn()} sensorItem={sensor} ctx={ctx} onSaved={onSaved} />);

    const field = screen.getByLabelText("I2C SDA GPIO (Optional)") as HTMLInputElement;
    // The sensor's own pin is not a conflict with itself.
    expect(field.value).toBe("6");
    expect(field).toHaveAttribute("aria-invalid", "false");
    expect(tile(6)).toHaveAttribute("aria-pressed", "true");
    expect(tile(6)).toHaveAttribute("data-state", "available");
    // XIAO pads carry the names printed on the board, also on the saved pin.
    expect(tile(6)).toHaveTextContent("D4 / SDA");
    expect(tile(6)).toHaveTextContent("Current");
    expect(tile(6)).toHaveAccessibleName(/GPIO 6, pad D4 \/ SDA.*currently assigned here/);
    expect(tile(7)).toHaveTextContent("D5 / SCL");
    expect(tile(7)).not.toHaveTextContent("Current");
    expect(screen.getByText("Suggested for an I2C sensor")).toBeInTheDocument();

    // Without a pin the sensor uses the default bus: that is valid and can be saved.
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(field.value).toBe("");
    expect(field).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("Choose a GPIO pin from the map, or type its number.")).not.toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save Sensor" });
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls).toEqual([
      {
        url: "/api/sensors/sen-1",
        method: "PATCH",
        body: {
          name: "Desk Climate",
          sensorType: "temperature_bme280",
          controllerId: "c2",
          roomId: null,
          gpioPin: null,
          i2cAddress: "0x76",
        },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// USB board verification: the mismatch warning
// ---------------------------------------------------------------------------

const library: UsbFlashTargetBoardSpec[] = [
  ...VERIFIED_BOARD_CATALOG.map((b) => ({ ...b, id: `id-${b.slug}` })),
  ...SEEED_XIAO_OFFICIAL_BOARDS.filter((b) => b.seed.slug !== "seeed-xiao-esp32s3").map((b) => ({
    ...b.seed,
    id: `id-${b.seed.slug}`,
  })),
];
const libraryBoard = (slug: string) => library.find((b) => b.slug === slug)!;

function report(detected: DetectedUsbBoard, selectedSlug: string): UsbFlashBoardReport {
  return verifyUsbBoardIdentity<UsbFlashTargetBoardSpec>({
    detected,
    selectedBoard: libraryBoard(selectedSlug),
    candidateBoards: library,
    firmware: { chipFamily: "esp32s3", minFlashMb: 16, label: "HomecoreOS v1.4.0" },
  });
}

const s3N16R8: DetectedUsbBoard = {
  chipName: "ESP32-S3 (QFN56) (revision v0.2)",
  flashSizeMb: 16,
  psramSizeMb: 8,
  usbVendorId: 0x10c4,
  usbProductId: 0xea60,
};

describe("USB board mismatch warning", () => {
  it("shows both boards and the differing checks, and makes stopping the default", async () => {
    const user = userEvent.setup();
    const mismatch = report({ ...s3N16R8, flashSizeMb: 8, psramSizeMb: 0 }, "esp32-s3-devkitc-1-n16r8");
    expect(mismatch.result).toBe("mismatch");
    const onCancel = vi.fn();
    const onForce = vi.fn();
    render(
      <UsbBoardMismatchPanel
        report={mismatch}
        firmwareLabel="HomecoreOS v1.4.0"
        onCancel={onCancel}
        onForce={onForce}
      />
    );

    const panel = screen.getByRole("alertdialog", {
      name: "The connected board is not the board you selected",
    });
    expect(within(panel).getByText(/Flashing is paused\. Nothing has been written/)).toBeInTheDocument();
    expect(within(panel).getByText("ESP32-S3 · 8 MB flash · no PSRAM")).toBeInTheDocument();
    expect(within(panel).getByText("Espressif ESP32-S3-DevKitC-1 N16R8")).toBeInTheDocument();
    expect(within(panel).getByText("Firmware: HomecoreOS v1.4.0")).toBeInTheDocument();
    expect(within(panel).getByText("May not start")).toBeInTheDocument();

    // The comparison names what agrees and what differs.
    const table = within(panel).getByRole("table", { name: /Connected board compared with the selected board/ });
    const status = (check: string) =>
      within(table).getByRole("rowheader", { name: check }).closest("tr")!.getAttribute("data-status");
    expect(status("Chip")).toBe("match");
    expect(status("Flash")).toBe("mismatch");
    expect(status("PSRAM")).toBe("mismatch");

    // A board from the library that fits the connected hardware is recommended.
    expect(within(panel).getByText("Recommended board")).toBeInTheDocument();
    expect(mismatch.recommended.length).toBeGreaterThan(0);
    expect(within(panel).getByText(mismatch.recommended[0]!.label)).toBeInTheDocument();

    // The safe answer has the focus, so Enter stops instead of forcing.
    const cancel = within(panel).getByRole("button", { name: "Cancel flashing" });
    const force = within(panel).getByRole("button", { name: "Force to Flash" });
    expect(cancel).toHaveFocus();
    expect(force).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onForce).not.toHaveBeenCalled();

    // Forcing needs an explicit acknowledgement first.
    await user.click(force);
    expect(onForce).not.toHaveBeenCalled();
    await user.click(
      within(panel).getByRole("checkbox", {
        name: "I understand that this firmware may not start on the connected board.",
      })
    );
    expect(force).toBeEnabled();
    await user.click(force);
    expect(onForce).toHaveBeenCalledTimes(1);
  });

  it("words the consequence by what actually differs", () => {
    const cases: Array<{ report: UsbFlashBoardReport; badge: string; consequence: RegExp; outcome: RegExp }> = [
      {
        // Another chip family.
        report: report(
          { chipName: "ESP32-C3 (QFN32) (revision v0.4)", flashSizeMb: 4, psramSizeMb: 0, usbVendorId: 0x303a, usbProductId: 0x1001 },
          "esp32-s3-devkitc-1-n16r8"
        ),
        badge: "Will not start",
        consequence: /built for a different chip.*will not start/,
        outcome: /will not start with it/,
      },
      {
        // Same chip, less memory.
        report: report({ ...s3N16R8, flashSizeMb: 8 }, "esp32-s3-devkitc-1-n16r8"),
        badge: "May not start",
        consequence: /may not start, or may be unstable/,
        outcome: /may not start/,
      },
      {
        // Same chip and memory, another maker's board: it runs, but as the wrong board.
        report: report({ ...s3N16R8, usbVendorId: 0x2886, usbProductId: 0x0056 }, "esp32-s3-devkitc-1-n16r8"),
        badge: "Different board",
        consequence: /should start on the connected board.*pin map/,
        outcome: /should start, but it is set up as Espressif ESP32-S3-DevKitC-1 N16R8/,
      },
    ];

    for (const item of cases) {
      expect(item.report.result, item.badge).toBe("mismatch");
      const { unmount } = render(
        <UsbBoardMismatchPanel
          report={item.report}
          firmwareLabel="HomecoreOS v1.4.0"
          onCancel={vi.fn()}
          onForce={vi.fn()}
        />
      );
      const panel = screen.getByRole("alertdialog");
      expect(within(panel).getByText(item.badge)).toBeInTheDocument();
      expect(within(panel).getByText(item.consequence)).toBeInTheDocument();
      expect(describeForcedFlashOutcome(item.report)).toMatch(item.outcome);
      unmount();
    }

    // A wrong-board warning must not claim a boot failure the check did not find.
    const vendorOnly = cases[2]!.report;
    expect(vendorOnly.mismatches.map((m) => m.code)).toEqual(["usb_vendor"]);
    expect(describeForcedFlashOutcome(vendorOnly)).not.toMatch(/may not start|will not start/);
  });

  it("offers to switch to the recommended board only when firmware exists for it", async () => {
    const user = userEvent.setup();
    const mismatch = report({ ...s3N16R8, usbVendorId: 0x2886, usbProductId: 0x0056 }, "esp32-s3-devkitc-1-n16r8");
    const recommended = mismatch.recommended.map((r) => r.board.slug);
    expect(recommended).toContain("seeed-xiao-esp32s3-plus");
    const onUseBoard = vi.fn();
    const { rerender } = render(
      <UsbBoardMismatchPanel
        report={mismatch}
        firmwareLabel="HomecoreOS v1.4.0"
        describeRecommendation={() => ({ canSwitch: false, note: "No USB firmware is published for this board yet." })}
        onCancel={vi.fn()}
        onForce={vi.fn()}
        onUseBoard={onUseBoard}
      />
    );
    expect(screen.getByText("Seeed Studio XIAO ESP32-S3 Plus")).toBeInTheDocument();
    expect(screen.getAllByText(/No USB firmware is published for this board yet\./).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Use this board/ })).not.toBeInTheDocument();

    rerender(
      <UsbBoardMismatchPanel
        report={mismatch}
        firmwareLabel="HomecoreOS v1.4.0"
        describeRecommendation={(board) => ({ canSwitch: board.slug === "seeed-xiao-esp32s3-plus" })}
        onCancel={vi.fn()}
        onForce={vi.fn()}
        onUseBoard={onUseBoard}
      />
    );
    const use = screen.getAllByRole("button", { name: /Use this board/ });
    expect(use).toHaveLength(1);
    await user.click(use[0]!);
    expect(onUseBoard).toHaveBeenCalledTimes(1);
    expect(onUseBoard.mock.calls[0]![0]).toMatchObject({ slug: "seeed-xiao-esp32s3-plus" });
  });

  it("reports the board check in the progress view without claiming more than has happened", () => {
    const mismatch = report({ ...s3N16R8, flashSizeMb: 8 }, "esp32-s3-devkitc-1-n16r8");
    const view = (stage: "writing" | "completed" | "error", forced: boolean, result = mismatch.result) => (
      <UsbFlashStagePipeline
        stage={stage}
        percent={50}
        phase="Working"
        logs={[]}
        boardCheck={{ result, headline: mismatch.headline, forced }}
      />
    );
    const { rerender } = render(view("writing", true));
    const line = () => screen.getByTestId("usb-board-check");
    expect(line()).toHaveAttribute("data-result", "mismatch");
    expect(line()).toHaveTextContent(/Board check: Board mismatch: connected ESP32-S3 · 8 MB flash/);
    expect(line()).toHaveTextContent("Flashing anyway at your request.");
    expect(line()).not.toHaveTextContent("Flashed anyway");

    rerender(view("completed", true));
    expect(line()).toHaveTextContent("Flashed anyway at your request.");

    rerender(view("error", true));
    expect(line()).toHaveTextContent("Force to Flash was chosen, but the flash did not complete.");
    expect(line()).not.toHaveTextContent("Flashed anyway");

    // Not forced: nothing about forcing is said.
    rerender(view("completed", false, "match"));
    expect(line()).toHaveAttribute("data-result", "match");
    expect(line()).not.toHaveTextContent(/anyway|Force/);
  });
});
