import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
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
import { ApiError, apiFetch } from "@/lib/api";
import { TimezoneContext } from "@/lib/timezone";
import {
  AppErrorFallback,
  RouteErrorBoundary,
  isChunkLoadError,
} from "@/components/layout/ErrorBoundary";
import { AdminIslandWorkspaceBar } from "@/components/dynamic-island/AdminIslandWorkspaceBar";
import { UserIslandWorkspaceBar } from "@/components/dynamic-island/UserIslandWorkspaceBar";
import { ConsoleShell, type NavItem } from "@/components/layout/ConsoleShell";
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

const STAFF_ROLES = ["owner", "administrator", "operator", "viewer"] as const;
const PLATFORM_ADMIN_ROLES = ["super_admin", "operator", "support"] as const;
const ACCOUNT_STATUSES = ["active", "paused", "pending_deletion"] as const;

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * `/api/auth/me` is the one response the whole customer console is built on. A
 * missing or malformed payload used to be assigned straight to state, and the
 * first `session.account.status` read threw during render - blanking the app
 * with no way back. Validate it instead and fall back to the sign-in screen.
 */
export function normalizeUserSession(raw: unknown): UserSessionData | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<UserSessionData>;
  const user = candidate.user as Partial<UserSessionData["user"]> | undefined;
  const account = candidate.account as Partial<UserSessionData["account"]> | undefined;
  if (!user || typeof user.id !== "string" || !account || typeof account.id !== "string") {
    return null;
  }
  const normalizeAccount = (value: unknown) => {
    const item = value as Partial<UserSessionData["accounts"][number]> | undefined;
    if (!item || typeof item.id !== "string") return null;
    return {
      id: item.id,
      name: asString(item.name, "Account"),
      slug: asString(item.slug, item.id),
      status: pickEnum(item.status, ACCOUNT_STATUSES, "active"),
      staffRole: pickEnum(item.staffRole, STAFF_ROLES, "viewer"),
    };
  };
  const accounts = Array.isArray(candidate.accounts)
    ? candidate.accounts
        .map(normalizeAccount)
        .filter((item): item is NonNullable<typeof item> => item !== null)
    : [];
  const activeAccount = normalizeAccount(account);
  if (!activeAccount) return null;
  return {
    user: {
      id: user.id,
      email: asString(user.email),
      fullName: asString(user.fullName) || asString(user.email, "Member"),
      avatarSeed: typeof user.avatarSeed === "string" ? user.avatarSeed : null,
      appearancePreference: pickEnum(
        user.appearancePreference,
        ["light", "dark", "system"] as const,
        "system"
      ),
      timezone: typeof user.timezone === "string" ? user.timezone : null,
    },
    account: activeAccount,
    accounts: accounts.length > 0 ? accounts : [activeAccount],
    platformDefaultTimezone:
      typeof candidate.platformDefaultTimezone === "string"
        ? candidate.platformDefaultTimezone
        : undefined,
    effectiveTimezone:
      typeof candidate.effectiveTimezone === "string" ? candidate.effectiveTimezone : undefined,
  };
}

export function normalizeAdminSession(raw: unknown): AdminSessionData | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<AdminSessionData>;
  const admin = candidate.admin as Partial<AdminSessionData["admin"]> | undefined;
  if (!admin || typeof admin.id !== "string") return null;
  return {
    admin: {
      id: admin.id,
      email: asString(admin.email),
      fullName: asString(admin.fullName) || asString(admin.email, "Administrator"),
      role: pickEnum(admin.role, PLATFORM_ADMIN_ROLES, "support"),
      appearancePreference:
        typeof admin.appearancePreference === "string" ? admin.appearancePreference : undefined,
      timezone: typeof admin.timezone === "string" ? admin.timezone : null,
    },
    platformDefaultTimezone:
      typeof candidate.platformDefaultTimezone === "string"
        ? candidate.platformDefaultTimezone
        : undefined,
    effectiveTimezone:
      typeof candidate.effectiveTimezone === "string" ? candidate.effectiveTimezone : undefined,
  };
}

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
  const [sessionError, setSessionError] = useState<unknown>(null);
  const sessionLoadSeqRef = useRef(0);

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
    setSessionError(null);
    setPath(nextPath);
  }, []);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const loadCurrentSession = useCallback(async () => {
    const seq = ++sessionLoadSeqRef.current;
    setLoadingSession(true);
    try {
      if (isAdminArea) {
        const res = await apiFetch<unknown>("/api/admin/auth/me");
        if (sessionLoadSeqRef.current === seq) {
          setAdminSession(normalizeAdminSession(res));
          setSessionError(null);
        }
      } else {
        const res = await apiFetch<unknown>("/api/auth/me");
        if (sessionLoadSeqRef.current === seq) {
          setUserSession(normalizeUserSession(res));
          setSessionError(null);
        }
      }
    } catch (err) {
      if (sessionLoadSeqRef.current === seq) {
        if (isAdminArea) setAdminSession(null);
        else setUserSession(null);
        // 401/403 is the normal "signed out" answer; anything else (5xx,
        // non-JSON payload, network failure) is worth surfacing so the user
        // sees a recovery path instead of an unexplained sign-in form.
        const status = err instanceof ApiError ? err.status : 0;
        setSessionError(status === 401 || status === 403 ? null : err);
      }
    } finally {
      if (sessionLoadSeqRef.current === seq) {
        setLoadingSession(false);
      }
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
          Loading Smart Things...
        </div>
        <Toaster theme={themeMode} />
      </>
    );
  }

  // ---------------- ADMIN CONSOLE WORKSPACE ----------------
  if (isAdminArea) {
    if (!adminSession) {
      if (sessionError && !isChunkLoadError(sessionError)) {
        return (
          <TooltipProvider delayDuration={200}>
            <div className="flex min-h-screen items-center justify-center bg-background px-4">
              <div className="w-full max-w-xl">
                <AppErrorFallback
                  error={sessionError}
                  onRetry={() => {
                    setSessionError(null);
                    void loadCurrentSession();
                  }}
                />
              </div>
            </div>
            <Toaster theme={themeMode} />
          </TooltipProvider>
        );
      }
      return (
        <TooltipProvider delayDuration={200}>
          <RouteErrorBoundary path="admin-auth">
            <Suspense fallback={<RouteLoadingFallback />}>
              <AdminAuthPage
                onAuthenticated={async () => {
                  await loadCurrentSession();
                  navigate("/admin");
                }}
                onNavigate={navigate}
              />
            </Suspense>
          </RouteErrorBoundary>
          <Toaster theme={themeMode} />
        </TooltipProvider>
      );
    }

    const isSuperAdmin = adminSession.admin.role === "super_admin";
    const canOperateAdmin =
      adminSession.admin.role === "super_admin" ||
      adminSession.admin.role === "operator";
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
          return (
            <AdminAccountsStaffPage
              isSuperAdmin={isSuperAdmin}
              canManageAccounts={canOperateAdmin}
            />
          );
        case "/admin/firmware":
          return (
            <AdminFirmwarePage
              isSuperAdmin={isSuperAdmin}
              canManageFirmware={canOperateAdmin}
            />
          );
        case "/admin/boards":
          return (
            <AdminBoardsPage
              isSuperAdmin={isSuperAdmin}
              canManageBoards={canOperateAdmin}
            />
          );
        case "/admin/emqx":
          return <AdminEmqxPage canManageEmqx={canOperateAdmin} />;
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
            workspaceClassName="hc-admin-lavender-bg"
            floatingBar={({ openMobileNav }) => (
              <AdminIslandWorkspaceBar
                adminSession={adminSession}
                routes={ADMIN_ROUTES}
                activeRouteId={activeAdminRoute.id}
                themeMode={themeMode}
                onToggleTheme={toggleTheme}
                onNavigate={navigate}
                onSignOut={() => void handleAdminLogout()}
                onOpenMobileNav={openMobileNav}
              />
            )}
            userEmail={adminSession.admin.email}
            userName={adminSession.admin.fullName}
            onSignOut={() => void handleAdminLogout()}
            themeMode={themeMode}
            onToggleTheme={toggleTheme}
          >
            <RouteErrorBoundary path={`admin:${path}`}>
              <Suspense fallback={<RouteLoadingFallback />}>
                {renderAdminPage()}
              </Suspense>
            </RouteErrorBoundary>
          </ConsoleShell>
        </TimezoneContext.Provider>
        <Toaster theme={themeMode} />
      </TooltipProvider>
    );
  }

  // ---------------- CUSTOMER USER CONSOLE WORKSPACE ----------------
  if (!userSession) {
    if (sessionError && !isChunkLoadError(sessionError)) {
      return (
        <TooltipProvider delayDuration={200}>
          <div className="flex min-h-screen items-center justify-center bg-background px-4">
            <div className="w-full max-w-xl">
              <AppErrorFallback
                error={sessionError}
                onRetry={() => {
                  setSessionError(null);
                  void loadCurrentSession();
                }}
              />
            </div>
          </div>
          <Toaster theme={themeMode} />
        </TooltipProvider>
      );
    }

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
          <RouteErrorBoundary path={`user:${path}`}>
            <Suspense fallback={<RouteLoadingFallback />}>
              {renderUserPage()}
            </Suspense>
          </RouteErrorBoundary>
        </ConsoleShell>
      </TimezoneContext.Provider>
      <Toaster theme={themeMode} />
    </TooltipProvider>
  );
}

export default App;
