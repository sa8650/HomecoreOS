import { memo, useState, type ReactNode } from "react";
import {
  RiCloseLine,
  RiLogoutBoxRLine,
  RiMenuLine,
  RiTimeLine,
} from "@remixicon/react";
import { cn } from "@/lib/utils";
import { formatClockWithZone, useEffectiveTimezone } from "@/lib/timezone";
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

export interface NavItem {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: string | number;
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
  floatingBar?: (controls: { openMobileNav: () => void }) => ReactNode;
  userEmail: string;
  userName: string;
  onSignOut: () => void;
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const timezone = useEffectiveTimezone();

  const navContent = (
    <div className="flex h-full flex-col justify-between">
      <div className="space-y-5">
        <div className="px-2 pt-1">
          <HomecoreWordmark subtitle={consoleTitle} compact />
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
        <div className="rounded-lg border bg-card px-3 py-2 text-[11px]">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <RiTimeLine className="size-3.5 text-primary shrink-0" aria-hidden="true" />
            <span className="truncate">{timezone}</span>
          </div>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
            {formatClockWithZone(timezone)}
          </p>
        </div>

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
        <aside className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:flex lg:w-64 lg:flex-col lg:overflow-y-auto border-r border-sidebar-border bg-sidebar p-4">
          {navContent}
        </aside>

        {/* Mobile Drawer */}
        {mobileOpen && (
          <div className="fixed inset-0 z-50 flex lg:hidden">
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
        <div className="relative flex min-h-screen min-w-0 flex-1 flex-col lg:pl-64">
          {floatingBar ? (
            floatingBar({ openMobileNav: () => setMobileOpen(true) })
          ) : (
            <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-sidebar-border bg-sidebar/95 px-4 text-sidebar-foreground backdrop-blur-md sm:px-6">
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
            className={cn(
              "mx-auto w-full max-w-[1640px] flex-1",
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
