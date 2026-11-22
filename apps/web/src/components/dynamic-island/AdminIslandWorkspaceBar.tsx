import { AdminIslandProfileMenuContent } from "@/components/dynamic-island/IslandProfileMenu";
import {
  IslandWorkspaceBar,
  type IslandNavRoute,
} from "@/components/dynamic-island/IslandWorkspaceBar";
import type { AdminSessionData } from "@/features/types";

export function AdminIslandWorkspaceBar({
  adminSession,
  routes,
  activeRouteId,
  themeMode,
  onToggleTheme,
  onNavigate,
  onSignOut,
  onOpenMobileNav,
  sidebarHidden,
  onToggleSidebar,
}: {
  adminSession: AdminSessionData;
  routes: IslandNavRoute[];
  activeRouteId: string;
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
  onNavigate: (path: string) => void;
  onSignOut: () => void;
  onOpenMobileNav: () => void;
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
}) {
  return (
    <IslandWorkspaceBar
      routes={routes}
      activeRouteId={activeRouteId}
      themeMode={themeMode}
      onToggleTheme={onToggleTheme}
      onNavigate={onNavigate}
      onOpenMobileNav={onOpenMobileNav}
      sidebarHidden={sidebarHidden}
      onToggleSidebar={onToggleSidebar}
      notificationScope="admin"
      faceAriaLabel="Open admin quick bar"
      actionsAriaLabel="Platform admin quick bar"
      launcherTitle="Admin Quick Navigation"
      profile={{
        name: adminSession.admin.fullName,
        email: adminSession.admin.email,
      }}
      renderProfilePanel={(close) => (
        <AdminIslandProfileMenuContent
          adminSession={adminSession}
          onOpenSettings={() => {
            onNavigate("/admin/settings");
            close();
          }}
          onSignOut={() => {
            close();
            onSignOut();
          }}
        />
      )}
    />
  );
}
