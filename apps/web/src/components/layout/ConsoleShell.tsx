import { memo, useEffect, useState, type ReactNode } from "react";
import {
  RiCloseLine,
  RiLogoutBoxRLine,
  RiMenuLine,
  RiSidebarFoldLine,
} from "@remixicon/react";
import { cn } from "cn";
import { HomecoreWordmark } from "@/components/graphics/HomecoreGraphics";
import { Badge } from "@/components/reui/badge";
import { ThemeToggleButton } from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export const SIDEBAR_HIDDEN_STORAGE_KEY = "hc:console:sidebar-hidden";

function readSidebarHidden(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_HIDDEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistSidebarHidden(hidden: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_HIDDEN_STORAGE_KEY, hidden ? "1" : "0");
  } catch {
    // Storage is optional; the console still toggles in memory.
  }
}

export interface NavItem {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: string | number;
}

export interface SidebarControls {
  openMobileNav: () => void;
  /** True when the desktop sidebar is collapsed and the workspace is full width. */
  sidebarHidden: boolean;
  hideSidebar: () => void;
  showSidebar: () => void;
  toggleSidebar: () => void;
}

export const ConsoleShell = memo(function ConsoleShell({
  consoleTitle,
  consoleBadge,
  navItems,
  activeNav,
  onSelectNav,
  headerActions,
  headerNotifications,
  floatingBar,
  workspaceClassName,
  userEmail,
  userName,
  onSignOut,
  themeMode,
  onToggleTheme,
  children,
}: {
  consoleTitle: string;
  consoleBadge?: string;
  navItems: NavItem[];
  activeNav: string;
  onSelectNav: (id: string) => void;
  headerActions?: ReactNode;
  headerNotifications?: ReactNode;
  floatingBar?: (controls: SidebarControls) => ReactNode;
  workspaceClassName?: string;
  userEmail: string;
  userName: string;
  onSignOut: () => void;
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  // The desktop sidebar is collapsible. One state is shared by its own hide
  // button and by the Dynamic Island's Quick Navigation toggle, so the two can
  // never disagree.
  const [sidebarHidden, setSidebarHidden] = useState(readSidebarHidden);

  useEffect(() => {
    persistSidebarHidden(sidebarHidden);
  }, [sidebarHidden]);

  useEffect(() => {
    // Keep parallel tabs of the same console in the same layout.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SIDEBAR_HIDDEN_STORAGE_KEY) return;
      setSidebarHidden(event.newValue === "1");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const hideSidebar = () => setSidebarHidden(true);
  const showSidebar = () => setSidebarHidden(false);
  const toggleSidebar = () => setSidebarHidden((previous) => !previous);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (
        document.querySelector(
          '[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [role="dialog"][aria-modal="true"]'
        )
      ) {
        return;
      }
      e.preventDefault();
      setMobileOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  const navContent = (
    <div className="flex h-full flex-col justify-between">
      <div className="space-y-5">
        <div className="px-2 pt-1">
          <div className="flex items-start justify-between gap-2">
            <HomecoreWordmark subtitle={consoleTitle} compact />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  data-testid="sidebar-hide-button"
                  onClick={hideSidebar}
                  aria-label="Hide sidebar"
                  className="hidden shrink-0 lg:inline-flex"
                >
                  <RiSidebarFoldLine className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Hide sidebar</TooltipContent>
            </Tooltip>
          </div>
          {consoleBadge && (
            <div className="mt-2.5">
              <Badge variant="primary-light" radius="full">
                {consoleBadge}
              </Badge>
            </div>
          )}
        </div>

        <nav className="space-y-1" aria-label={consoleTitle}>
          {navItems.map((item) => {
            const active = item.id === activeNav;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onSelectNav(item.id);
                  setMobileOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition cursor-pointer",
                  active
                    ? "bg-primary/10 text-primary font-semibold"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <span className="shrink-0 opacity-85">{item.icon}</span>
                  <span className="truncate">{item.label}</span>
                </span>
                {item.badge !== undefined && (
                  <Badge variant="secondary" size="xs" radius="full" className="tabular-nums">
                    {item.badge}
                  </Badge>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="space-y-3 pt-4">
        <Separator />
        <p className="px-1 text-[10px] font-medium text-muted-foreground/80">
          Powered by HomecoreOS
        </p>

        <div className="flex items-center justify-between gap-2 px-1">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-foreground">
              {userName}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">{userEmail}</p>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={onSignOut}
                aria-label="Sign out"
              >
                <RiLogoutBoxRLine className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Sign out</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen bg-background text-foreground">
        {/* Desktop Fixed Sidebar */}
        {!sidebarHidden && (
          <aside
            data-testid="console-sidebar"
            className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:flex lg:w-64 lg:flex-col lg:overflow-y-auto border-r border-sidebar-border bg-sidebar p-4"
          >
            {navContent}
          </aside>
        )}

        {/* Mobile Drawer */}
        {mobileOpen && (
          <div className="fixed inset-0 z-[78] flex lg:hidden">
            <div
              className="fixed inset-0 bg-slate-950/50 backdrop-blur-[1px]"
              onClick={() => setMobileOpen(false)}
            />
            <aside className="relative z-10 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar p-4 shadow-2xl">
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => setMobileOpen(false)}
                aria-label="Close navigation"
                className="absolute right-3 top-3"
              >
                <RiCloseLine className="size-4" />
              </Button>
              {navContent}
            </aside>
          </div>
        )}

        {/* Main Scrolling Workspace */}
        <div
          data-testid="console-workspace-column"
          className={cn(
            "relative flex min-h-screen min-w-0 flex-1 flex-col transition-[padding] duration-200",
            sidebarHidden ? "lg:pl-0" : "lg:pl-64",
            workspaceClassName
          )}
        >
          {floatingBar ? (
            floatingBar({
              openMobileNav: () => setMobileOpen(true),
              sidebarHidden,
              hideSidebar,
              showSidebar,
              toggleSidebar,
            })
          ) : (
            <header className="sticky top-0 z-30 flex min-h-14 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-sidebar-border bg-sidebar/95 px-4 py-2 text-sidebar-foreground backdrop-blur-md sm:px-6">
              <div className="flex items-center gap-2.5 min-w-0">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setMobileOpen(true)}
                  aria-label="Open navigation"
                  className="lg:hidden"
                >
                  <RiMenuLine className="size-5" />
                </Button>
                <span className="truncate text-sm font-semibold text-foreground lg:hidden">
                  {consoleTitle}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {headerActions}
                {headerNotifications}
                <ThemeToggleButton themeMode={themeMode} onToggleTheme={onToggleTheme} />
              </div>
            </header>
          )}

          <main
            data-sidebar-hidden={sidebarHidden ? "true" : "false"}
            className={cn(
              "mx-auto w-full flex-1",
              // With the rail gone the workspace owns the whole viewport: the
              // usual reading-width cap is dropped so grids fill the space
              // instead of leaving a centred gap where the sidebar used to be.
              sidebarHidden ? "max-w-none" : "max-w-[1640px]",
              floatingBar ? "px-4 pb-6 pt-14 sm:px-6" : "p-4 sm:p-6"
            )}
          >
            {children}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
});
