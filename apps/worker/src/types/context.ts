import type { StaffRole, PlatformAdminRole, AccountStatus } from "@homecoreos/shared";
import type { WorkerBindings } from "../config/env";
import type { CustomFetch, DbClient } from "../lib/db";

export interface AuthenticatedUserContext {
  sessionId: string;
  userId: string;
  email: string;
  fullName: string;
  appearancePreference: "light" | "dark" | "system";
  timezone: string | null;
  accountId: string;
  accountName: string;
  accountSlug: string;
  accountStatus: AccountStatus;
  staffId: string;
  staffRole: StaffRole;
}

export interface AuthenticatedAdminContext {
  sessionId: string;
  userId: string;
  email: string;
  fullName: string;
  appearancePreference: "light" | "dark" | "system";
  timezone: string | null;
  platformStaffId: string;
  platformRole: PlatformAdminRole;
}

export interface AuthenticatedDeviceContext {
  controllerId: string;
  accountId: string;
  homeId: string;
  mqttUsername: string;
  mqttClientId: string;
  topicPrefix: string;
}

export interface WorkerRuntimeDeps {
  dbFetch?: CustomFetch;
  emqxFetch?: CustomFetch;
  syncFetch?: CustomFetch;
  webhookFetch?: CustomFetch;
}

export interface AppVariables {
  db: DbClient;
  deps: WorkerRuntimeDeps;
  userAuth?: AuthenticatedUserContext;
  adminAuth?: AuthenticatedAdminContext;
  deviceAuth?: AuthenticatedDeviceContext;
}

export type AppEnv = {
  Bindings: WorkerBindings;
  Variables: AppVariables;
};
