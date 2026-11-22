import { IslandActionButton } from "@/components/dynamic-island/IslandActionButton";
import { IslandProfileMenuContent } from "@/components/dynamic-island/IslandProfileMenu";
import {
  IslandWorkspaceBar,
  type IslandNavRoute,
} from "@/components/dynamic-island/IslandWorkspaceBar";
import type { UserSessionData } from "@/features/types";

export type { IslandNavRoute };

export function UserIslandWorkspaceBar({
  userSession,
  routes,
  activeRouteId,
  themeMode,
  onToggleTheme,
  onNavigate,
  onSwitchAccount,
  onSignOut,
  onOpenMobileNav,
  sidebarHidden,
  onToggleSidebar,
}: {
  userSession: UserSessionData;
  routes: IslandNavRoute[];
  activeRouteId: string;
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
  onNavigate: (path: string) => void;
  onSwitchAccount: (accountId: string) => void;
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
      notificationScope="user"
      faceAriaLabel="Open workspace quick bar"
      actionsAriaLabel="Customer workspace quick bar"
      launcherTitle="Quick Navigation"
      profile={{
        name: userSession.user.fullName,
        email: userSession.user.email,
        avatarSeed: userSession.user.avatarSeed,
      }}
      extraActions={<IslandActionButton />}
      renderProfilePanel={(close) => (
        <IslandProfileMenuContent
          userSession={userSession}
          onSwitchAccount={(accountId) => {
            onSwitchAccount(accountId);
            close();
          }}
          onOpenSettings={() => {
            onNavigate("/settings");
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
