import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VERIFIED_BOARD_CATALOG } from "@homecoreos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimezoneContext } from "../lib/timezone";
import { invalidateApiCache } from "../lib/api";
import { BoardLibraryCard } from "./boards/BoardLibraryCard";
import { FirmwarePage } from "../features/user/FirmwarePage";
import { ConsoleShell } from "./layout/ConsoleShell";
import { Badge, badgeVariants } from "./reui/badge";
import { Alert, AlertTitle } from "./reui/alert";
import { Card, CardAction, CardHeader, CardTitle } from "./ui/card";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { InteractiveBoardPinout } from "./boards/InteractiveBoardPinout";
import { BoardVerificationDialog } from "../features/admin/BoardVerificationDialog";
import { OfficialBoardImportDialog } from "../features/admin/OfficialBoardImportDialog";
import { AdminAuthPage } from "../features/auth/AdminAuthPage";
import type { BoardProfileItem } from "../features/types";

describe("UI, layout, layering, and theme conflict regression tests", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
  });

  it("layers mobile ConsoleShell drawer above Dynamic Island (z-[78]) and lets admin header wrap safely", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ConsoleShell
        consoleTitle="Admin Console"
        navItems={[{ id: "overview", label: "Overview", icon: <span /> }]}
        activeNav="overview"
        onSelectNav={vi.fn()}
        userEmail="admin@homecoreos.local"
        userName="Admin"
        onSignOut={vi.fn()}
        themeMode="light"
        onToggleTheme={vi.fn()}
        headerActions={<button type="button">Action</button>}
      >
        <div>Body</div>
      </ConsoleShell>
    );

    const header = container.querySelector("header");
    const headerClasses = (header?.className ?? "").split(/\s+/);
    expect(headerClasses).toContain("min-h-14");
    expect(headerClasses).toContain("flex-wrap");
    expect(headerClasses).not.toContain("h-14");

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const closeBtn = screen.getByRole("button", { name: "Close navigation" });
    const drawerOverlay = closeBtn.closest("div.fixed.inset-0");
    expect(drawerOverlay?.className).toContain("z-[78]");
  });

  it("applies high-contrast dark/light classes across Badge variants", () => {
    expect(badgeVariants({ variant: "warning" })).toContain("text-slate-950");
    expect(badgeVariants({ variant: "success" })).toContain("dark:text-slate-950");
    expect(badgeVariants({ variant: "destructive" })).toContain("dark:text-slate-950");
    expect(badgeVariants({ variant: "info" })).toContain("dark:text-slate-950");
    expect(badgeVariants({ variant: "focus-light" })).not.toContain("text-focus-foreground");
    expect(badgeVariants({ variant: "focus-outline" })).not.toContain("text-focus-foreground");
    expect(badgeVariants({ variant: "invert-outline" })).toContain("text-invert");
    expect(badgeVariants({ variant: "invert-outline" })).not.toContain("text-invert-foreground");

    render(<Badge variant="warning">Beta</Badge>);
    expect(screen.getByText("Beta").className).toContain("text-slate-950");
  });

  it("guards AlertDialogContent viewport sizing and dark-mode modal overlays", () => {
    const alertView = render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Confirm removal</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>
    );

    const alertDialog = screen.getByRole("alertdialog");
    expect(alertDialog.className).toContain("max-h-[90dvh]");
    expect(alertDialog.className).toContain("overflow-y-auto");
    expect(alertDialog.className).toContain("max-w-[calc(100%-2rem)]");
    expect(
      document.querySelector('[data-slot="alert-dialog-overlay"]')?.className
    ).toContain("dark:bg-black/60");
    alertView.unmount();

    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Details</DialogTitle>
          <DialogDescription>Dialog body</DialogDescription>
        </DialogContent>
      </Dialog>
    );
    expect(
      document.querySelector('[data-slot="dialog-overlay"]')?.className
    ).toContain("dark:bg-black/60");
  });

  it("prevents horizontal overflow in TabsList, CardHeader, and Alert icon/title layout", () => {
    const { container } = render(
      <div>
        <Tabs defaultValue="a">
          <TabsList>
            <TabsTrigger value="a">First Tab</TabsTrigger>
            <TabsTrigger value="b">Second Tab</TabsTrigger>
          </TabsList>
        </Tabs>
        <Card>
          <CardHeader>
            <CardTitle>Long Card Title</CardTitle>
            <CardAction>
              <button type="button">Edit</button>
            </CardAction>
          </CardHeader>
        </Card>
        <Alert variant="warning">
          <svg aria-hidden="true" />
          <AlertTitle>A longer alert heading that wraps cleanly on narrow screens</AlertTitle>
        </Alert>
      </div>
    );

    const tabsList = container.querySelector('[data-slot="tabs-list"]');
    expect(tabsList?.className).toContain("max-w-full");
    expect(tabsList?.className).toContain("overflow-x-auto");

    const cardHeader = container.querySelector('[data-slot="card-header"]');
    expect(cardHeader?.className).toContain("grid-cols-[minmax(0,1fr)_auto]");

    const alert = container.querySelector('[data-slot="alert"]');
    expect(alert?.className).toContain("grid-cols-[calc(var(--spacing)*4)_1fr]");

    const alertTitle = container.querySelector('[data-slot="alert-title"]');
    expect(alertTitle?.className).not.toContain("line-clamp-1");
  });

  it("allows horizontal scrolling on InteractiveBoardPinout diagram container", () => {
    const s3Board = VERIFIED_BOARD_CATALOG.find(
      (b) => b.slug === "esp32-s3-devkitc-1-n16r8"
    )!;
    const board: BoardProfileItem = {
      ...s3Board,
      id: "cat-s3",
      is_available: true,
      compatible_firmware_count: 1,
    };

    const { container } = render(<InteractiveBoardPinout board={board} />);
    const scrollWrapper = container.querySelector(".overflow-x-auto");
    expect(scrollWrapper).not.toBeNull();
  });

  it("renders BoardVerificationDialog GPIO table with bidirectional scroll and opaque sticky header", () => {
    const s3Board = VERIFIED_BOARD_CATALOG.find(
      (b) => b.slug === "esp32-s3-devkitc-1-n16r8"
    )!;
    const board: BoardProfileItem = {
      ...s3Board,
      id: "cat-s3",
      is_available: true,
      compatible_firmware_count: 1,
    };

    render(
      <BoardVerificationDialog
        board={board}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    const table = document.querySelector("table");
    expect(table?.className).toContain("min-w-[540px]");
    expect(table?.parentElement?.className).toContain("overflow-auto");

    const thead = table?.querySelector("thead");
    expect(thead?.className).toContain("bg-muted");
    expect(thead?.className).not.toContain("bg-muted/60");
  });

  it("renders the 4-provider board import source radio group in a balanced 2x2 grid", () => {
    render(
      <OfficialBoardImportDialog
        open
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />
    );

    const radioGroup = screen.getByRole("radiogroup", { name: "Board source" });
    expect(radioGroup.className).toContain("sm:grid-cols-2");
    expect(screen.getAllByRole("radio").length).toBe(4);
  });

  it("wraps AdminAuthPage header actions on narrow screens without clipping", () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ needsBootstrap: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof fetch;

    try {
      const { container } = render(
        <AdminAuthPage onAuthenticated={vi.fn()} onNavigate={vi.fn()} />
      );
      const headerRow = container.querySelector("header > div");
      expect(headerRow?.className).toContain("flex-wrap");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses card surface background in Light Mode and black in Dark Mode behind BoardLibraryCard board map", () => {
    const s3Board = VERIFIED_BOARD_CATALOG.find(
      (b) => b.slug === "esp32-s3-devkitc-1-n16r8"
    )!;
    const board: BoardProfileItem = {
      ...s3Board,
      id: "cat-s3",
      is_available: true,
      compatible_firmware_count: 1,
    };

    render(
      <BoardLibraryCard
        board={board}
        source="official"
        onOpenDetails={vi.fn()}
      />
    );

    const stage = screen.getByTestId("board-library-card-stage");
    const tokens = stage.className.split(/\s+/);
    expect(tokens).toContain("bg-card");
    expect(tokens).toContain("dark:bg-[#0b0e12]");
    expect(tokens).not.toContain("bg-[#0b0e12]");
  });

  it("renders User Console FirmwarePage filters in a single horizontal row and respects admin download OFF setting", async () => {
    const user = userEvent.setup();
    const originalFetch = globalThis.fetch;
    invalidateApiCache();

    const s3Board = VERIFIED_BOARD_CATALOG.find(
      (b) => b.slug === "esp32-s3-devkitc-1-n16r8"
    )!;
    const board: BoardProfileItem = {
      ...s3Board,
      id: "cat-s3",
      is_available: true,
      compatible_firmware_count: 1,
    };

    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/firmware/releases")) {
        return new Response(
          JSON.stringify({
            firmwareDownloadsEnabled: false,
            releases: [
              {
                id: "rel-1",
                name: "HomecoreOS S3",
                version: "2.1.0",
                channel: "stable",
                chip_family: "esp32s3",
                chip_variant: "ESP32-S3-N16R8",
                compatible_board_ids: ["cat-s3"],
                compatible_boards: [board],
                hardware_verified: true,
                status: "published",
                usb_available: true,
                ota_available: true,
                release_notes: "Production build",
                published_at: "2026-11-15T10:00:00Z",
                files: [
                  {
                    id: "file-usb-1",
                    file_type: "usb_factory",
                    file_name: "homecore-s3-factory.bin",
                    size_bytes: 1024000,
                    sha256: "a".repeat(64),
                    flash_address: "0x0",
                    flash_size: "16MB",
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/api/board-library/catalog")) {
        return new Response(JSON.stringify({ boards: [board] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/board-library/custom")) {
        return new Response(JSON.stringify({ boards: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/firmware/updates")) {
        return new Response(
          JSON.stringify({ applicableUpdates: [], history: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      render(
        <TimezoneContext.Provider value="UTC">
          <FirmwarePage
            canManage
            onNavigate={vi.fn()}
          />
        </TimezoneContext.Provider>
      );

      const filterBar = await screen.findByTestId("firmware-filter-bar");
      expect(filterBar.className).toContain("lg:flex-nowrap");
      expect(
        within(filterBar).getByRole("combobox", { name: "Filter by board compatibility" })
      ).toBeInTheDocument();
      expect(
        within(filterBar).getByRole("combobox", { name: "Filter by version" })
      ).toBeInTheDocument();
      expect(
        within(filterBar).getByRole("combobox", { name: "Filter by channel" })
      ).toBeInTheDocument();
      expect(
        within(filterBar).getByRole("combobox", { name: "Filter by artifact type" })
      ).toBeInTheDocument();
      expect(
        within(filterBar).getByRole("combobox", { name: "Filter chip" })
      ).toBeInTheDocument();
      expect(within(filterBar).getByTestId("firmware-total-count")).toHaveTextContent(
        "Showing 1 of 1 releases"
      );

      // Open Inspect Details -> direct Download link hidden, Downloads Off badge + notice shown
      await user.click(await screen.findByRole("button", { name: /Inspect Details/i }));
      expect(
        await screen.findByTestId("firmware-downloads-disabled-notice")
      ).toBeInTheDocument();
      expect(screen.getByText("Downloads Off")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Download/i })).not.toBeInTheDocument();
    } finally {
      globalThis.fetch = originalFetch;
      invalidateApiCache();
    }
  });
});
