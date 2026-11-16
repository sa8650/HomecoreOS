import type { MiddlewareHandler } from "hono";
import type {
  AccountStatus,
  PlatformAdminRole,
  StaffRole,
} from "@homecoreos/shared";
import { createDbClient } from "../lib/db";
import {
  ADMIN_SESSION_COOKIE,
  USER_SESSION_COOKIE,
  parseCookies,
} from "../lib/cookies";
import { sha256Hex } from "../lib/crypto";
import type { AppEnv, AuthenticatedUserContext } from "../types/context";

interface ResolvedUserRpcRow {
  session_id: string;
  user_id: string;
  email: string;
  full_name: string;
  appearance_preference: "light" | "dark" | "system";
  timezone: string | null;
  account_id: string;
  account_name: string;
  account_slug: string;
  account_status: AccountStatus;
  staff_id: string;
  staff_role: StaffRole;
}

interface ResolvedAdminRpcRow {
  session_id: string;
  user_id: string;
  email: string;
  full_name: string;
  appearance_preference: "light" | "dark" | "system";
  timezone: string | null;
  platform_staff_id: string;
  platform_role: PlatformAdminRole;
}

export function dbMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get("deps") ?? {};
    const db = createDbClient(c.env ?? {}, deps.dbFetch);
    c.set("db", db);
    await next();
  };
}

export async function resolveUserSessionFromRequest(
  c: Parameters<MiddlewareHandler<AppEnv>>[0]
): Promise<AuthenticatedUserContext | null> {
  const cookies = parseCookies(c.req.header("cookie"));
  const rawToken = cookies[USER_SESSION_COOKIE];
  if (!rawToken) return null;

  const tokenHash = await sha256Hex(rawToken);
  const db = c.get("db");

  const { data } = await db.rpc("resolve_user_session_context", {
    p_token_hash: tokenHash,
  });

  const rows = (Array.isArray(data) ? data : data ? [data] : []) as ResolvedUserRpcRow[];
  const row = rows[0];
  if (!row) return null;

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    fullName: row.full_name,
    appearancePreference: row.appearance_preference,
    timezone: row.timezone ?? null,
    accountId: row.account_id,
    accountName: row.account_name,
    accountSlug: row.account_slug,
    accountStatus: row.account_status,
    staffId: row.staff_id,
    staffRole: row.staff_role,
  };
}

export function requireUserSession(options?: {
  allowPausedAccount?: boolean;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ctx = await resolveUserSessionFromRequest(c);
    if (!ctx) {
      return c.json({ error: "Authentication required.", code: "UNAUTHORIZED" }, 401);
    }

    if (!options?.allowPausedAccount && ctx.accountStatus !== "active") {
      return c.json(
        {
          error:
            ctx.accountStatus === "paused"
              ? "This account is currently paused. Protected operations are disabled."
              : "This account is pending deletion. Protected operations are disabled.",
          code:
            ctx.accountStatus === "paused"
              ? "ACCOUNT_PAUSED"
              : "ACCOUNT_PENDING_DELETION",
        },
        403
      );
    }

    c.set("userAuth", ctx);
    await next();
  };
}

export function requireStaffRole(
  ...allowedRoles: StaffRole[]
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("userAuth");
    if (!auth) {
      return c.json({ error: "Authentication required.", code: "UNAUTHORIZED" }, 401);
    }
    if (!allowedRoles.includes(auth.staffRole)) {
      return c.json(
        {
          error: "Insufficient staff permissions for this operation.",
          code: "FORBIDDEN_STAFF_ROLE",
        },
        403
      );
    }
    await next();
  };
}

export function requireAdminSession(
  ...allowedRoles: PlatformAdminRole[]
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cookies = parseCookies(c.req.header("cookie"));
    const rawToken = cookies[ADMIN_SESSION_COOKIE];
    if (!rawToken) {
      return c.json(
        { error: "Platform administrator authentication required.", code: "ADMIN_UNAUTHORIZED" },
        401
      );
    }

    const tokenHash = await sha256Hex(rawToken);
    const db = c.get("db");

    const { data } = await db.rpc("resolve_admin_session_context", {
      p_token_hash: tokenHash,
    });
    const rows = (Array.isArray(data) ? data : data ? [data] : []) as ResolvedAdminRpcRow[];
    const row = rows[0];
    if (!row) {
      return c.json(
        { error: "Admin session expired or invalid.", code: "ADMIN_UNAUTHORIZED" },
        401
      );
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(row.platform_role)) {
      return c.json(
        { error: "Insufficient platform administrator role.", code: "ADMIN_FORBIDDEN" },
        403
      );
    }

    c.set("adminAuth", {
      sessionId: row.session_id,
      userId: row.user_id,
      email: row.email,
      fullName: row.full_name,
      appearancePreference: row.appearance_preference,
      timezone: row.timezone ?? null,
      platformStaffId: row.platform_staff_id,
      platformRole: row.platform_role,
    });

    await next();
  };
}

export function requireDeviceBearerAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return c.json({ error: "Device credentials required." }, 401);
    }
    const tokenHash = await sha256Hex(match[1]!.trim());
    const db = c.get("db");

    const { data: cred } = await db
      .from("mqtt_credentials_metadata")
      .select("controller_id,account_id,mqtt_username,mqtt_client_id,topic_prefix,status")
      .eq("device_token_hash", tokenHash)
      .eq("status", "active")
      .maybeSingle();

    if (!cred) {
      return c.json({ error: "Invalid or revoked controller token." }, 401);
    }

    const row = cred as {
      controller_id: string;
      account_id: string;
      mqtt_username: string;
      mqtt_client_id: string;
      topic_prefix: string;
    };

    const [accountRes, controllerRes] = await Promise.all([
      db
        .from("accounts")
        .select("id,status,deleted_at")
        .eq("id", row.account_id)
        .is("deleted_at", null)
        .maybeSingle(),
      db
        .from("controllers")
        .select("id,home_id,deleted_at")
        .eq("id", row.controller_id)
        .eq("account_id", row.account_id)
        .is("deleted_at", null)
        .maybeSingle(),
    ]);

    const account = accountRes.data;
    if (!account || (account as { status: string }).status !== "active") {
      return c.json({ error: "Account is paused or inactive." }, 403);
    }

    const controller = controllerRes.data;
    if (!controller) {
      return c.json({ error: "Controller not found or deleted." }, 401);
    }

    c.set("deviceAuth", {
      controllerId: row.controller_id,
      accountId: row.account_id,
      homeId: (controller as { home_id: string }).home_id,
      mqttUsername: row.mqtt_username,
      mqttClientId: row.mqtt_client_id,
      topicPrefix: row.topic_prefix,
    });

    await next();
  };
}
