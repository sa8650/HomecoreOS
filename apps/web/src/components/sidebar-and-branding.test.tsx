import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConsoleShell,
  SIDEBAR_HIDDEN_STORAGE_KEY,
  type SidebarControls,
} from "@/components/layout/ConsoleShell";
import { UserIslandWorkspaceBar } from "@/components/dynamic-island/UserIslandWorkspaceBar";
import type { UserSessionData } from "@/features/types";

afterEach(() => {
  localStorage.clear();
});

const userSession = {
  account: { id: "acct-1", name: "Rivera Household", status: "active" },
  user: { id: "user-1", fullName: "Alex Rivera", email: "alex@example.com" },
} as unknown as UserSessionData;

/** Renders the shell with the real island wired to its sidebar controls. */
function renderConsole(options: { sidebarHidden?: boolean } = {}) {
  if (options.sidebarHidden) localStorage.setItem(SIDEBAR_HIDDEN_STORAGE_KEY, "1");

  const seen: SidebarControls[] = [];
  const utils = render(
    <ConsoleShell
      consoleTitle="Rivera Household"
      navItems={[
        { id: "overview", label: "Overview", icon: <span>O</span> },
        { id: "rooms", label: "Rooms", icon: <span>R</span> },
      ]}
      activeNav="overview"
      onSelectNav={vi.fn()}
      userEmail="alex@example.com"
      userName="Alex Rivera"
      onSignOut={vi.fn()}
      themeMode="light"
      onToggleTheme={vi.fn()}
      floatingBar={(controls) => {
        seen.push(controls);
        return (
          <UserIslandWorkspaceBar
            userSession={userSession}
            routes={[{ id: "overview", label: "Overview", path: "/", icon: <span>O</span> }]}
            activeRouteId="overview"
            themeMode="light"
            onToggleTheme={vi.fn()}
            onNavigate={vi.fn()}
            onSwitchAccount={vi.fn()}
            onSignOut={vi.fn()}
            onOpenMobileNav={controls.openMobileNav}
            sidebarHidden={controls.sidebarHidden}
            onToggleSidebar={controls.toggleSidebar}
          />
        );
      }}
    >
      <div>Workspace body</div>
    </ConsoleShell>
  );
  return { ...utils, controls: () => seen[seen.length - 1]! };
}

/** Expands the island, then opens its Quick Navigation panel. */
async function openQuickNavigation(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("dynamic-island-face"));
  await waitFor(() => expect(screen.getByTestId("dynamic-island-actions")).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: /quick navigation/i }));
  await waitFor(() =>
    expect(screen.getByTestId("island-launcher-panel")).toBeInTheDocument()
  );
}

describe("Console sidebar collapse", () => {
  it("hides the sidebar from its own button and gives the content the full width", async () => {
    const user = userEvent.setup();
    const { container } = renderConsole();

    expect(screen.getByTestId("console-sidebar")).toBeInTheDocument();
    const column = container.querySelector('[data-testid="console-workspace-column"]');
    expect(column?.className).toContain("lg:pl-64");

    await user.click(screen.getByTestId("sidebar-hide-button"));

    await waitFor(() =>
      expect(screen.queryByTestId("console-sidebar")).not.toBeInTheDocument()
    );
    // The Dynamic Island (and therefore every one of its controls) stays put:
    // hiding the sidebar must never take the island with it.
    expect(screen.getByTestId("dynamic-island-shell")).toBeInTheDocument();
    expect(screen.getByTestId("dynamic-island-face")).toBeInTheDocument();
    expect(
      container.querySelector('[data-testid="console-workspace-column"]')?.className
    ).toContain("lg:pl-0");
    // Content also drops the reading-width cap, so nothing sits in a gutter.
    const main = container.querySelector("main");
    expect(main).toHaveAttribute("data-sidebar-hidden", "true");
    expect(main?.className).toContain("max-w-none");
    expect(localStorage.getItem(SIDEBAR_HIDDEN_STORAGE_KEY)).toBe("1");
  });

  it("keeps the island's expand/collapse icon and the sidebar button in sync", async () => {
    const user = userEvent.setup();
    const { container } = renderConsole();

    await openQuickNavigation();
    const toggle = screen.getByTestId("island-sidebar-toggle");
    expect(toggle).toHaveAttribute("aria-label", "Hide sidebar");
    expect(toggle).toHaveAttribute("data-sidebar-hidden", "false");

    // Collapse from the island.
    await user.click(toggle);
    await waitFor(() =>
      expect(screen.queryByTestId("console-sidebar")).not.toBeInTheDocument()
    );
    expect(screen.getByTestId("island-sidebar-toggle")).toHaveAttribute(
      "aria-label",
      "Show sidebar"
    );

    // Re-open from the island: the sidebar (and its own hide button) is back.
    await user.click(screen.getByTestId("island-sidebar-toggle"));
    await waitFor(() => expect(screen.getByTestId("console-sidebar")).toBeInTheDocument());
    expect(screen.getByTestId("sidebar-hide-button")).toBeInTheDocument();
    expect(
      container.querySelector('[data-testid="console-workspace-column"]')?.className
    ).toContain("lg:pl-64");
  });

  it("restores a collapsed sidebar from a previous visit", async () => {
    const { container } = renderConsole({ sidebarHidden: true });

    expect(screen.queryByTestId("console-sidebar")).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-testid="console-workspace-column"]')?.className
    ).toContain("lg:pl-0");

    // The island still offers the way back.
    await openQuickNavigation();
    expect(screen.getByTestId("island-sidebar-toggle")).toHaveAttribute(
      "aria-label",
      "Show sidebar"
    );
  });
});
