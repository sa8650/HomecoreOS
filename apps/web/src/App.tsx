import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import {
  RiBarChartBoxLine,
  RiCpuLine,
  RiDashboardLine,
  RiDoorOpenLine,
  RiFlashlightLine,
  RiHardDrive2Line,
  RiHistoryLine,
  RiHomeGearLine,
  RiLightbulbLine,
  RiNotification3Line,
  RiRouterLine,
  RiSensorLine,
  RiSettings3Line,
  RiShieldCheckLine,
  RiStackLine,
  RiToggleLine,
  RiUserSettingsLine,
} from "@remixicon/react";
import { apiFetch } from "@/lib/api";
import { TimezoneContext } from "@/lib/timezone";
import { UserIslandWorkspaceBar } from "@/components/dynamic-island/UserIslandWorkspaceBar";
import { ConsoleShell, type NavItem } from "@/components/layout/ConsoleShell";
import { NotificationBellPopover } from "@/components/notifications/NotificationBellPopover";
import { StatusAlert } from "@/components/shared/AppUi";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CustomerAuthPage } from "@/features/auth/CustomerAuthPage";
import { Toaster } from "@/components/ui/sonner";
import type { AdminSessionData, UserSessionData } from "@/features/types";

const AdminAuthPage = lazy(() =>
  import("@/features/auth/AdminAuthPage").then((m) => ({
    default: m.AdminAuthPage,
  }))
);
const AdminOverviewPage = lazy(() =>
  import("@/features/admin/AdminOverviewAndSetupPages").then((m) => ({
    default: m.AdminOverviewPage,
  }))
);
const AdminSetupStatusPage = lazy(() =>
  import("@/features/admin/AdminOverviewAndSetupPages").then((m) => ({
    default: m.AdminSetupStatusPage,
  }))
);
const AdminAccountsStaffPage = lazy(() =>
  import("@/features/admin/AdminAccountsAndBoardsPages").then((m) => ({
    default: m.AdminAccountsStaffPage,
  }))
);
const AdminBoardsPage = lazy(() =>
  import("@/features/admin/AdminAccountsAndBoardsPages").then((m) => ({
    default: m.AdminBoardsPage,
  }))
);
const AdminEmqxPage = lazy(() =>
  import("@/features/admin/AdminFirmwareEmqxUsageSettingsPages").then((m) => ({
    default: m.AdminEmqxPage,
  }))
);
const AdminFirmwarePage = lazy(() =>
  import("@/features/admin/AdminFirmwareEmqxUsageSettingsPages").then((m) => ({
    default: m.AdminFirmwarePage,
  }))
);
const AdminSettingsPage = lazy(() =>
  import("@/features/admin/AdminFirmwareEmqxUsageSettingsPages").then((m) => ({
    default: m.AdminSettingsPage,
  }))
);
const AdminUsagePage = lazy(() =>
  import("@/features/admin/AdminFirmwareEmqxUsageSettingsPages").then((m) => ({
    default: m.AdminUsagePage,
  }))
);
const NotificationsPage = lazy(() =>
  import("@/features/notifications/NotificationsPage").then((m) => ({
    default: m.NotificationsPage,
  }))
);
const ActivityPage = lazy(() =>
  import("@/features/user/ActivityAndSettingsPages").then((m) => ({
    default: m.ActivityPage,
  }))
);
const UserSettingsPage = lazy(() =>
  import("@/features/user/ActivityAndSettingsPages").then((m) => ({
    default: m.UserSettingsPage,
  }))
);
const AutomationsPage = lazy(() =>
  import("@/features/user/AutomationsPage").then((m) => ({
    default: m.AutomationsPage,
  }))
);
const BoardLibraryPage = lazy(() =>
  import("@/features/user/BoardLibraryPage").then((m) => ({
    default: m.BoardLibraryPage,
  }))
);
const ControllersPage = lazy(() =>
  import("@/features/user/ControllersPage").then((m) => ({
    default: m.ControllersPage,
  }))
);
const DevicesPage = lazy(() =>
  import("@/features/user/DevicesSwitchesSensorsPages").then((m) => ({
    default: m.DevicesPage,
  }))
);
const SwitchesPage = lazy(() =>
  import("@/features/user/DevicesSwitchesSensorsPages").then((m) => ({
    default: m.SwitchesPage,
  }))
);
const SensorsPage = lazy(() =>
  import("@/features/user/DevicesSwitchesSensorsPages").then((m) => ({
    default: m.SensorsPage,
  }))
);
const FirmwarePage = lazy(() =>
  import("@/features/user/FirmwarePage").then((m) => ({
    default: m.FirmwarePage,
  }))
);
const SmartHomePlannerPage = lazy(() =>
  import("@/features/user/SmartHomePlannerPage").then((m) => ({
    default: m.SmartHomePlannerPage,
  }))
);
const OverviewPage = lazy(() =>
  import("@/features/user/OverviewPage").then((m) => ({
    default: m.OverviewPage,
  }))
);
const RoomsPage = lazy(() =>
  import("@/features/user/RoomsPage").then((m) => ({
    default: m.RoomsPage,
  }))
);

function RouteLoadingFallback() {
  return (
    <div className="py-12 text-center text-xs text-muted-foreground">
      Loading view...
    </div>
  );
}

interface RouteNavDef {
  id: string;
  label: string;
  path: string;
  icon: NavItem["icon"];
}

const USER_ROUTES: RouteNavDef[] = [
  { id: "overview", label: "Overview", path: "/", icon: <RiDashboardLine className="size-4" /> },
  { id: "rooms", label: "Rooms", path: "/rooms", icon: <RiDoorOpenLine className="size-4" /> },
  { id: "devices", label: "Devices", path: "/devices", icon: <RiLightbulbLine className="size-4" /> },
  { id: "switches", label: "Switches", path: "/switches", icon: <RiToggleLine className="size-4" /> },
  { id: "sensors", label: "Sensors", path: "/sensors", icon: <RiSensorLine className="size-4" /> },
  { id: "controllers", label: "Controllers", path: "/controllers", icon: <RiCpuLine className="size-4" /> },
  { id: "boards", label: "Board Library", path: "/boards", icon: <RiStackLine className="size-4" /> },
  { id: "planner", label: "Smart Home Planner", path: "/planner", icon: <RiHomeGearLine className="size-4" /> },
  { id: "automations", label: "Automation", path: "/automations", icon: <RiFlashlightLine className="size-4" /> },
  { id: "firmware", label: "Firmware & Updates", path: "/firmware", icon: <RiHardDrive2Line className="size-4" /> },
  { id: "notifications", label: "Notifications", path: "/notifications", icon: <RiNotification3Line className="size-4" /> },
  { id: "activity", label: "Activity", path: "/activity", icon: <RiHistoryLine className="size-4" /> },
  { id: "settings", label: "User Settings", path: "/settings", icon: <RiSettings3Line className="size-4" /> },
];

const ADMIN_ROUTES: RouteNavDef[] = [
  { id: "admin-overview", label: "Platform Overview", path: "/admin", icon: <RiDashboardLine className="size-4" /> },
  { id: "admin-setup", label: "Setup Status", path: "/admin/setup", icon: <RiShieldCheckLine className="size-4" /> },
  { id: "admin-accounts", label: "Users & Staff", path: "/admin/accounts", icon: <RiUserSettingsLine className="size-4" /> },
  { id: "admin-firmware", label: "Firmware Management", path: "/admin/firmware", icon: <RiHardDrive2Line className="size-4" /> },
  { id: "admin-boards", label: "Board Library", path: "/admin/boards", icon: <RiStackLine className="size-4" /> },
  { id: "admin-emqx", label: "EMQX Management", path: "/admin/emqx", icon: <RiRouterLine className="size-4" /> },
  { id: "admin-usage", label: "Usage & Monitoring", path: "/admin/usage", icon: <RiBarChartBoxLine className="size-4" /> },
  { id: "admin-notifications", label: "Notifications", path: "/admin/notifications", icon: <RiNotification3Line className="size-4" /> },
  { id: "admin-settings", label: "Platform Settings", path: "/admin/settings", icon: <RiSettings3Line className="size-4" /> },
];

function getInitialTheme(): "light" | "dark" {
  try {
    if (localStorage.getItem("homecoreos:theme") === "dark") return "dark";
  } catch {
    // ignore storage failures
  }
  return "light";
}

export function App() {
  const [path, setPath] = useState<string>(() =>
    typeof window !== "undefined" ? window.location.pathname : "/"
  );
  const [themeMode, setThemeMode] = useState<"light" | "dark">(getInitialTheme);
  const [userSession, setUserSession] = useState<UserSessionData | null>(null);
  const [adminSession, setAdminSession] = useState<AdminSessionData | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);

  const isAdminArea = path.startsWith("/admin");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", themeMode === "dark");
    try {
      localStorage.setItem("homecoreos:theme", themeMode);
    } catch {
      // ignore
    }
  }, [themeMode]);

  const toggleTheme = useCallback(() => {
    setThemeMode((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  const navigate = useCallback((nextPath: string) => {
    if (typeof window !== "undefined" && window.location.pathname !== nextPath) {
      window.history.pushState({}, "", nextPath);
    }
    setPath(nextPath);
  }, []);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const loadCurrentSession = useCallback(async () => {
    setLoadingSession(true);
    try {
      if (isAdminArea) {
        const res = await apiFetch<AdminSessionData>("/api/admin/auth/me");
        setAdminSession(res);
      } else {
        const res = await apiFetch<UserSessionData>("/api/auth/me");
        setUserSession(res);
      }
    } catch {
      if (isAdminArea) setAdminSession(null);
      else setUserSession(null);
    } finally {
      setLoadingSession(false);
    }
  }, [isAdminArea]);

  useEffect(() => {
    void loadCurrentSession();
  }, [loadCurrentSession]);

  const handleUserLogout = useCallback(async () => {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUserSession(null);
    navigate("/login");
  }, [navigate]);

  const handleAdminLogout = useCallback(async () => {
    await apiFetch("/api/admin/auth/logout", { method: "POST" }).catch(() => {});
    setAdminSession(null);
    navigate("/admin/login");
  }, [navigate]);

  async function handleSwitchAccount(accountId: string) {
    await apiFetch("/api/auth/switch-account", {
      method: "POST",
      body: JSON.stringify({ accountId }),
    }).catch(() => {});
    await loadCurrentSession();
  }

  if (loadingSession) {
    return (
      <>
        <div className="flex min-h-screen items-center justify-center bg-background text-xs text-muted-foreground">
          Loading HomecoreOS...
        </div>
        <Toaster theme={themeMode} />
      </>
    );
  }

  // ---------------- ADMIN CONSOLE WORKSPACE ----------------
  if (isAdminArea) {
    if (!adminSession) {
      return (
        <TooltipProvider delayDuration={200}>
          <Suspense fallback={<RouteLoadingFallback />}>
            <AdminAuthPage
              onAuthenticated={async () => {
                await loadCurrentSession();
                navigate("/admin");
              }}
              onNavigate={navigate}
              themeMode={themeMode}
              onToggleTheme={toggleTheme}
            />
          </Suspense>
          <Toaster theme={themeMode} />
        </TooltipProvider>
      );
    }

    const isSuperAdmin = adminSession.admin.role === "super_admin";
    const adminEffectiveTz =
      adminSession.effectiveTimezone ??
      adminSession.admin.timezone ??
      adminSession.platformDefaultTimezone ??
      "UTC";

    const activeAdminRoute =
      ADMIN_ROUTES.find((r) => r.path === path) ?? ADMIN_ROUTES[0]!;

    const renderAdminPage = () => {
      switch (path) {
        case "/admin/setup":
          return <AdminSetupStatusPage />;
        case "/admin/accounts":
          return <AdminAccountsStaffPage isSuperAdmin={isSuperAdmin} />;
        case "/admin/firmware":
          return <AdminFirmwarePage />;
        case "/admin/boards":
          return <AdminBoardsPage isSuperAdmin={isSuperAdmin} />;
        case "/admin/emqx":
          return <AdminEmqxPage />;
        case "/admin/usage":
          return <AdminUsagePage />;
        case "/admin/notifications":
          return <NotificationsPage scope="admin" onNavigate={navigate} />;
        case "/admin/settings":
          return (
            <AdminSettingsPage
              isSuperAdmin={isSuperAdmin}
              adminSession={adminSession}
              onRefreshAdminSession={loadCurrentSession}
            />
          );
        case "/admin":
        default:
          return <AdminOverviewPage />;
      }
    };

    return (
      <TooltipProvider delayDuration={200}>
        <TimezoneContext.Provider value={adminEffectiveTz}>
          <ConsoleShell
            consoleTitle="Platform Admin Console"
            consoleBadge={`ADMIN · ${adminSession.admin.role.toUpperCase()}`}
            navItems={ADMIN_ROUTES}
            activeNav={activeAdminRoute.id}
            onSelectNav={(id) => {
              const target = ADMIN_ROUTES.find((r) => r.id === id);
              if (target) navigate(target.path);
            }}
            headerNotifications={
              <NotificationBellPopover scope="admin" onNavigate={navigate} />
            }
            userEmail={adminSession.admin.email}
            userName={adminSession.admin.fullName}
            onSignOut={() => void handleAdminLogout()}
            themeMode={themeMode}
            onToggleTheme={toggleTheme}
          >
            <Suspense fallback={<RouteLoadingFallback />}>
              {renderAdminPage()}
            </Suspense>
          </ConsoleShell>
        </TimezoneContext.Provider>
        <Toaster theme={themeMode} />
      </TooltipProvider>
    );
  }

  // ---------------- CUSTOMER USER CONSOLE WORKSPACE ----------------
  if (!userSession) {
    const searchParams =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : new URLSearchParams();
    const inviteCode = searchParams.get("code") ?? "";
    const initialTab =
      path === "/register" ? "register" : path === "/invite" || inviteCode ? "invite" : "login";

    return (
      <TooltipProvider delayDuration={200}>
        <CustomerAuthPage
          initialTab={initialTab}
          initialInviteCode={inviteCode}
          onAuthenticated={async () => {
            await loadCurrentSession();
            navigate("/");
          }}
          onNavigate={navigate}
          themeMode={themeMode}
          onToggleTheme={toggleTheme}
        />
        <Toaster theme={themeMode} />
      </TooltipProvider>
    );
  }

  const isAccountActive = userSession.account.status === "active";
  const role = userSession.account.staffRole;
  const canManage = isAccountActive && (role === "owner" || role === "administrator");
  const canOperate = isAccountActive && role !== "viewer";
  const userEffectiveTz =
    userSession.effectiveTimezone ??
    userSession.user.timezone ??
    userSession.platformDefaultTimezone ??
    "UTC";

  const activeUserRoute =
    USER_ROUTES.find((r) => r.path === path) ?? USER_ROUTES[0]!;

  const renderUserPage = () => {
    if (!isAccountActive && path !== "/settings") {
      return (
        <UserSettingsPage
          session={userSession}
          onSessionRefresh={loadCurrentSession}
        />
      );
    }

    switch (path) {
      case "/rooms":
        return <RoomsPage canManage={canManage} />;
      case "/devices":
        return <DevicesPage canManage={canManage} canOperate={canOperate} />;
      case "/switches":
        return <SwitchesPage canManage={canManage} canOperate={canOperate} />;
      case "/sensors":
        return <SensorsPage canManage={canManage} />;
      case "/controllers":
        return (
          <ControllersPage
            canManage={canManage}
            canOperate={canOperate}
            onNavigate={navigate}
          />
        );
      case "/boards":
        return <BoardLibraryPage canManage={canManage} />;
      case "/planner":
        return (
          <SmartHomePlannerPage
            // Remount on account switch so one account's unsaved answers never follow into another.
            key={userSession.account.id}
            canManage={canManage}
            onNavigate={navigate}
            accountId={userSession.account.id}
          />
        );
      case "/automations":
        return <AutomationsPage canManage={canManage} canOperate={canOperate} />;
      case "/firmware":
        return <FirmwarePage canManage={canManage} onNavigate={navigate} />;
      case "/notifications":
        return <NotificationsPage scope="user" onNavigate={navigate} />;
      case "/activity":
        return <ActivityPage />;
      case "/settings":
        return (
          <UserSettingsPage
            session={userSession}
            onSessionRefresh={loadCurrentSession}
          />
        );
      case "/":
      default:
        return (
          <OverviewPage
            canManage={canManage}
            canOperate={canOperate}
            onNavigate={navigate}
          />
        );
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <TimezoneContext.Provider value={userEffectiveTz}>
        <ConsoleShell
          consoleTitle={userSession.account.name}
          consoleBadge={`USER · ${userSession.account.staffRole.toUpperCase()}`}
          navItems={USER_ROUTES}
          activeNav={activeUserRoute.id}
          onSelectNav={(id) => {
            const target = USER_ROUTES.find((r) => r.id === id);
            if (target) navigate(target.path);
          }}
          floatingBar={({ openMobileNav }) => (
            <UserIslandWorkspaceBar
              userSession={userSession}
              routes={USER_ROUTES}
              activeRouteId={activeUserRoute.id}
              themeMode={themeMode}
              onToggleTheme={toggleTheme}
              onNavigate={navigate}
              onSwitchAccount={(accountId) => void handleSwitchAccount(accountId)}
              onSignOut={() => void handleUserLogout()}
              onOpenMobileNav={openMobileNav}
            />
          )}
          userEmail={userSession.user.email}
          userName={userSession.user.fullName}
          onSignOut={() => void handleUserLogout()}
          themeMode={themeMode}
          onToggleTheme={toggleTheme}
        >
          {userSession.account.status === "paused" && (
            <StatusAlert tone="warning" title="Account Paused" className="mb-5">
              This customer account is paused. Protected home operations are disabled while your data remains preserved.
            </StatusAlert>
          )}
          {userSession.account.status === "pending_deletion" && (
            <StatusAlert tone="danger" title="Account Pending Deletion" className="mb-5">
              This account is pending deletion and MQTT credentials have been revoked.
            </StatusAlert>
          )}
          <Suspense fallback={<RouteLoadingFallback />}>
            {renderUserPage()}
          </Suspense>
        </ConsoleShell>
      </TimezoneContext.Provider>
      <Toaster theme={themeMode} />
    </TooltipProvider>
  );
}

export default App;
