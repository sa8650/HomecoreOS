import { useEffect, useState, type ReactNode } from "react";
import {
  RiApps2Line,
  RiMenuLine,
  RiMoonLine,
  RiNotification3Line,
  RiSideBarLine,
  RiSunLine,
} from "@remixicon/react";
import { HomecoreLogoMark } from "@/components/graphics/HomecoreGraphics";
import {
  NotificationPopoverBody,
  useNotificationFeed,
} from "@/components/notifications/NotificationBellPopover";
import {
  DynamicIsland,
  IslandControl,
  IslandDivider,
} from "@/components/dynamic-island/DynamicIsland";
import { IslandProfileTrigger } from "@/components/dynamic-island/IslandProfileMenu";

export interface IslandNavRoute {
  id: string;
  label: string;
  path: string;
  icon: ReactNode;
}

type ActivePanel = "launcher" | "notifications" | "profile" | null;

export interface IslandWorkspaceBarProps {
  routes: IslandNavRoute[];
  activeRouteId: string;
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
  onNavigate: (path: string) => void;
  onOpenMobileNav: () => void;
  /**
   * Sidebar visibility shared with `ConsoleShell`. The Quick Navigation header
   * owns the expand/collapse control, so both stay in sync with the sidebar's own
   * hide button.
   */
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
  /** Which notification feed to subscribe to. */
  notificationScope: "user" | "admin";
  faceAriaLabel: string;
  actionsAriaLabel: string;
  launcherTitle: string;
  profile: {
    name: string;
    email: string;
    avatarSeed?: string | null;
  };
  /** Renders the profile layer; call the argument to close the island. */
  renderProfilePanel: (close: () => void) => ReactNode;
  /** Extra controls slotted between the launcher and the theme toggle. */
  extraActions?: ReactNode;
}

/**
 * Shared workspace quick bar used by both consoles. The admin and user islands
 * differ only in their notification scope, profile menu and slot controls, so
 * the shell, launcher grid and panel state live here once.
 */
export function IslandWorkspaceBar({
  routes,
  activeRouteId,
  themeMode,
  onToggleTheme,
  onNavigate,
  onOpenMobileNav,
  sidebarHidden,
  onToggleSidebar,
  notificationScope,
  faceAriaLabel,
  actionsAriaLabel,
  launcherTitle,
  profile,
  renderProfilePanel,
  extraActions,
}: IslandWorkspaceBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);

  const {
    items,
    unreadCount,
    loading,
    allPath,
    refreshIfStale,
    markReadAndOpen,
    dismiss,
    markAllRead,
  } = useNotificationFeed(notificationScope, onNavigate);

  const closeAll = () => {
    setActivePanel(null);
    setExpanded(false);
  };

  // Global Cmd/Ctrl+K shortcut expands the island & opens the quick route launcher.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setExpanded(true);
        setActivePanel((prev) => (prev === "launcher" ? null : "launcher"));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const togglePanel = (panel: Exclude<ActivePanel, null>) => {
    setActivePanel((prev) => {
      const next = prev === panel ? null : panel;
      if (next === "notifications") {
        void refreshIfStale();
      }
      return next;
    });
  };

  const renderLayer = () => {
    if (activePanel === "launcher") {
      return (
        <div
          data-island-layer=""
          data-testid="island-launcher-panel"
          className="island-launcher-panel"
        >
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-xs font-semibold">{launcherTitle}</span>
            <span className="flex items-center gap-1.5">
              <span className="hidden rounded border px-1.5 py-0.5 font-mono text-[10px] opacity-70 sm:inline">
                ⌘K
              </span>
              <button
                type="button"
                data-testid="island-sidebar-toggle"
                data-sidebar-hidden={sidebarHidden ? "true" : "false"}
                className="island-launcher-toggle"
                aria-label={sidebarHidden ? "Show sidebar" : "Hide sidebar"}
                aria-pressed={!sidebarHidden}
                title={sidebarHidden ? "Show sidebar" : "Hide sidebar"}
                onClick={onToggleSidebar}
              >
                {sidebarHidden ? (
                  <RiSideBarLine className="size-3.5" aria-hidden="true" />
                ) : (
                  <RiSideBarLine className="size-3.5 rotate-180" aria-hidden="true" />
                )}
              </button>
            </span>
          </div>
          <div className="island-launcher-grid">
            {routes.map((route) => {
              const isActive = route.id === activeRouteId;
              return (
                <button
                  key={route.id}
                  type="button"
                  data-active={isActive ? "true" : undefined}
                  className="island-launcher-tile"
                  onClick={() => {
                    onNavigate(route.path);
                    closeAll();
                  }}
                >
                  <span className="shrink-0">{route.icon}</span>
                  <span className="w-full truncate">{route.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      );
    }

    if (activePanel === "notifications") {
      return (
        <div
          data-island-layer=""
          data-testid="notification-popover-content"
          className="island-notification-panel"
        >
          <NotificationPopoverBody
            items={items}
            unreadCount={unreadCount}
            loading={loading}
            onClose={() => setActivePanel(null)}
            onMarkAllRead={() => void markAllRead()}
            onMarkReadAndOpen={(item) => void markReadAndOpen(item, closeAll)}
            onDismiss={(item) => void dismiss(item)}
            onViewAll={() => {
              closeAll();
              onNavigate(allPath);
            }}
          />
        </div>
      );
    }

    if (activePanel === "profile") {
      return renderProfilePanel(closeAll);
    }

    return null;
  };

  return (
    <DynamicIsland
      expanded={expanded}
      onExpandedChange={(next) => {
        setExpanded(next);
        if (!next) setActivePanel(null);
      }}
      hasActiveLayer={activePanel !== null}
      onCloseLayer={() => setActivePanel(null)}
      faceAriaLabel={faceAriaLabel}
      actionsAriaLabel={actionsAriaLabel}
      face={
        <>
          <HomecoreLogoMark className="h-[19px] w-[24px] shrink-0" />
          {unreadCount > 0 && (
            <span
              data-testid="island-unread-dot"
              className="island-face-dot"
              aria-label={`${unreadCount} unread notifications`}
            />
          )}
        </>
      }
      layer={renderLayer()}
    >
      <button
        type="button"
        data-island-control=""
        className="island-sections"
        aria-label="Open navigation"
        title="Open navigation"
        onClick={() => {
          closeAll();
          onOpenMobileNav();
        }}
      >
        <RiMenuLine className="size-4" aria-hidden="true" />
      </button>

      <IslandControl
        active={activePanel === "launcher"}
        aria-label="Quick navigation"
        aria-expanded={activePanel === "launcher"}
        title="Quick navigation (Ctrl/⌘ K)"
        onClick={() => togglePanel("launcher")}
      >
        <RiApps2Line className="size-4" aria-hidden="true" />
      </IslandControl>

      {extraActions}

      <button
        type="button"
        data-island-control=""
        className="ds-theme-toggle"
        aria-label={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        title={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        onClick={onToggleTheme}
      >
        {themeMode === "dark" ? (
          <RiSunLine className="size-4" aria-hidden="true" />
        ) : (
          <RiMoonLine className="size-4" aria-hidden="true" />
        )}
      </button>

      <IslandControl
        active={activePanel === "notifications"}
        className="notification-button"
        aria-label="Notifications"
        aria-expanded={activePanel === "notifications"}
        title="Notifications"
        onClick={() => togglePanel("notifications")}
      >
        <RiNotification3Line className="size-4" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            data-testid="notification-unread-badge"
            className="notification-dot"
            aria-label={`${unreadCount} unread notifications`}
          />
        )}
      </IslandControl>

      <IslandDivider />

      <IslandProfileTrigger
        name={profile.name}
        email={profile.email}
        avatarSeed={profile.avatarSeed}
        open={activePanel === "profile"}
        onClick={() => togglePanel("profile")}
      />
    </DynamicIsland>
  );
}
