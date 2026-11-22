import { Hono } from "hono";
import { z } from "zod";
import {
  isValidIanaTimezone,
  resolveEffectiveTimezone,
  ONBOARDING_TOTAL_STEPS,
  resolveOnboardingState,
} from "@homecoreos/shared";
import { recordActivity } from "../lib/audit";
import { loadBrevoSender, sendPasswordRecoveryEmail } from "../lib/brevo";
import {
  ONBOARDING_COLUMNS,
  completeOnboarding,
  readOnboardingState,
  saveOnboardingProgress,
} from "../lib/onboarding";
import { emitNotification } from "../lib/notifications";
import {
  SESSION_TTL_SECONDS,
  USER_SESSION_COOKIE,
  isHttpsRequest,
  serializeClearCookie,
  serializeSessionCookie,
} from "../lib/cookies";
import {
  generateRandomToken,
  generateSixDigitPairingCode,
  generateSlugSuffix,
  hashPassword,
  sha256Hex,
  verifyPassword,
} from "../lib/crypto";
import {
  checkAttemptAllowed,
  extractClientIp,
  recordFailedAttempt,
  resetAttempts,
} from "../lib/rate-limit";
import {
  requireUserSession,
  resolveUserSessionFromRequest,
} from "../middleware/auth";
import {
  revokeRealtimeCredential,
  revokeRealtimeCredentialsForSessions,
} from "../lib/realtime";
import type { AppEnv } from "../types/context";

const registerSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(8).max(256),
  fullName: z.string().trim().min(2).max(120),
  accountName: z.string().trim().min(2).max(120).optional(),
  homeName: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().min(1).max(64).optional().nullable(),
});

const onboardingStepSchema = z.object({
  step: z.preprocess(
    (value) => (typeof value === "string" ? Number(value) : value),
    z.number().int().min(1).max(ONBOARDING_TOTAL_STEPS)
  ),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(256),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
});

const profileSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  appearancePreference: z.enum(["light", "dark", "system"]).optional(),
  avatarSeed: z.enum(["homecore-1", "homecore-2", "homecore-3", "homecore-4", "homecore-5", "homecore-6", "homecore-7", "homecore-8"]).nullable().optional(),
  timezone: z.string().trim().min(1).max(64).nullable().optional(),
});

const passwordResetRequestSchema = z.object({
  email: z.string().trim().email().max(200),
});

const passwordResetVerifySchema = z.object({
  email: z.string().trim().email().max(200),
  otp: z.string().trim().regex(/^\d{6}$/, "Enter the six-digit code."),
});

const passwordResetConfirmSchema = z.object({
  resetToken: z.string().trim().min(16).max(200),
  newPassword: z.string().min(8).max(256),
});

/** A recovery code lives for ten minutes and tolerates five wrong guesses. */
const PASSWORD_RESET_TTL_MINUTES = 10;
const PASSWORD_RESET_MAX_ATTEMPTS = 5;
const PASSWORD_RESET_RESEND_SECONDS = 60;
const PASSWORD_RESET_MAX_PER_HOUR = 5;

/** Salts the stored code hash with the user id, so a hash is worthless alone. */
function hashRecoveryCode(userId: string, code: string): Promise<string> {
  return sha256Hex(`${userId}:${code}`);
}

const switchAccountSchema = z.object({
  accountId: z.string().uuid(),
});

const acceptInviteSchema = z.object({
  code: z.string().trim().min(6).max(64),
});

function slugifyAccountName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `${base || "home"}-${generateSlugSuffix(6)}`;
}

export function createAuthRoutes() {
  const app = new Hono<AppEnv>();

  app.post("/register", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid registration fields.", details: parsed.error.flatten() },
        400
      );
    }

    const db = c.get("db");
    const email = parsed.data.email.toLowerCase();

    const { data: settings } = await db
      .from("platform_settings")
      .select("customer_registration_enabled,default_account_status,maintenance_mode,default_timezone")
      .eq("id", 1)
      .maybeSingle();

    const cfg = settings as {
      customer_registration_enabled?: boolean;
      default_account_status?: "active" | "paused";
      maintenance_mode?: boolean;
      default_timezone?: string;
    } | null;

    if (parsed.data.timezone && !isValidIanaTimezone(parsed.data.timezone)) {
      return c.json({ error: "Invalid IANA time zone identifier." }, 400);
    }

    if (cfg?.maintenance_mode) {
      return c.json(
        { error: "Platform is currently in maintenance mode." },
        503
      );
    }

    if (cfg && cfg.customer_registration_enabled === false) {
      return c.json(
        { error: "Customer self-registration is currently disabled by the platform administrator." },
        403
      );
    }

    const { data: existingUser } = await db
      .from("users")
      .select("id")
      .eq("email", email)
      .eq("user_kind", "customer")
      .is("deleted_at", null)
      .maybeSingle();

    if (existingUser) {
      return c.json({ error: "An account with this email already exists." }, 409);
    }

    const passwordHash = await hashPassword(parsed.data.password);

    const { data: insertedUser, error: userErr } = await db
      .from("users")
      .insert({
        email,
        user_kind: "customer",
        password_hash: passwordHash,
        full_name: parsed.data.fullName,
        timezone: parsed.data.timezone ?? null,
        status: "active",
      })
      .select("id,email,full_name,appearance_preference,timezone")
      .single();

    if (userErr || !insertedUser) {
      return c.json(
        { error: userErr?.message ?? "Failed to create customer user." },
        400
      );
    }

    const userRow = insertedUser as {
      id: string;
      email: string;
      full_name: string;
      appearance_preference: "light" | "dark" | "system";
      timezone: string | null;
    };

    const accountName =
      parsed.data.accountName ?? `${parsed.data.fullName}'s Homecore`;
    const accountStatus = cfg?.default_account_status ?? "active";

    const { data: insertedAccount, error: acctErr } = await db
      .from("accounts")
      .insert({
        name: accountName,
        slug: slugifyAccountName(accountName),
        owner_user_id: userRow.id,
        status: accountStatus,
        paused_at: accountStatus === "paused" ? new Date().toISOString() : null,
      })
      .select("id,name,slug,status")
      .single();

    if (acctErr || !insertedAccount) {
      return c.json(
        { error: acctErr?.message ?? "Failed to create customer account." },
        500
      );
    }

    const accountRow = insertedAccount as {
      id: string;
      name: string;
      slug: string;
      status: "active" | "paused" | "pending_deletion";
    };

    await db.from("staff").insert({
      account_id: accountRow.id,
      user_id: userRow.id,
      role: "owner",
      status: "active",
    });

    await db.from("homes").insert({
      account_id: accountRow.id,
      name: parsed.data.homeName ?? "Primary Home",
      timezone: resolveEffectiveTimezone(userRow.timezone, cfg?.default_timezone),
    });

    const rawToken = generateRandomToken(32);
    const tokenHash = await sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

    await db.from("sessions").insert({
      user_id: userRow.id,
      active_account_id: accountRow.id,
      session_scope: "user_console",
      token_hash: tokenHash,
      ip_address: extractClientIp(c.req.raw),
      user_agent: c.req.header("user-agent") ?? null,
      expires_at: expiresAt,
    });

    await recordActivity(db, {
      accountId: accountRow.id,
      actorUserId: userRow.id,
      category: "account",
      action: "account.registered",
      summary: `Customer account "${accountRow.name}" registered by ${userRow.email}`,
    });

    await emitNotification(db, {
      scope: "admin",
      category: "account",
      eventKey: "admin.user_registered",
      preferenceKey: "new_user_registrations",
      severity: "info",
      title: `New Customer Account: ${accountRow.name}`,
      message: `${userRow.full_name} (${userRow.email}) registered a new customer workspace.`,
      metadata: { accountId: accountRow.id, email: userRow.email },
    }).catch(() => null);

    c.header(
      "Set-Cookie",
      serializeSessionCookie(
        USER_SESSION_COOKIE,
        rawToken,
        SESSION_TTL_SECONDS,
        isHttpsRequest(c.req.raw)
      )
    );

    const platformDefaultTimezone = cfg?.default_timezone ?? "UTC";
    return c.json(
      {
        user: {
          id: userRow.id,
          email: userRow.email,
          fullName: userRow.full_name,
          appearancePreference: userRow.appearance_preference,
          timezone: userRow.timezone ?? null,
        },
        account: {
          id: accountRow.id,
          name: accountRow.name,
          slug: accountRow.slug,
          status: accountRow.status,
          staffRole: "owner",
        },
        onboarding: resolveOnboardingState({
          onboarding_step: 1,
          onboarding_started_at: null,
          onboarding_completed_at: null,
        }),
        platformDefaultTimezone,
        effectiveTimezone: resolveEffectiveTimezone(userRow.timezone, platformDefaultTimezone),
      },
      201
    );
  });

  app.post("/login", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Email and password are required." }, 400);
    }

    const db = c.get("db");
    const email = parsed.data.email.toLowerCase();
    const ip = extractClientIp(c.req.raw);
    const rateKey = `user:${email}`;

    const attemptCheck = await checkAttemptAllowed(db, rateKey, ip);
    if (!attemptCheck.allowed) {
      return c.json(
        {
          error: `Too many failed login attempts. Try again in ${attemptCheck.retryAfterSeconds}s.`,
          code: "LOGIN_RATE_LIMITED",
        },
        429
      );
    }

    const { data: userData } = await db
      .from("users")
      .select(
        `id,email,password_hash,full_name,status,appearance_preference,timezone,deleted_at,${ONBOARDING_COLUMNS}`
      )
      .eq("email", email)
      .eq("user_kind", "customer")
      .is("deleted_at", null)
      .maybeSingle();

    const user = userData as {
      id: string;
      email: string;
      password_hash: string;
      full_name: string;
      status: "active" | "disabled";
      appearance_preference: "light" | "dark" | "system";
      timezone: string | null;
      onboarding_step: number | string | null;
      onboarding_started_at: string | null;
      onboarding_completed_at: string | null;
    } | null;

    if (!user || !(await verifyPassword(user.password_hash, parsed.data.password))) {
      const attempt = await recordFailedAttempt(db, rateKey, ip);
      if (attempt.locked && user) {
        const { data: staffMembership } = await db
          .from("staff")
          .select("account_id")
          .eq("user_id", user.id)
          .eq("status", "active")
          .limit(1)
          .maybeSingle();
        if (staffMembership) {
          await emitNotification(db, {
            scope: "user",
            accountId: (staffMembership as { account_id: string }).account_id,
            userId: user.id,
            category: "security",
            eventKey: "security.login_locked",
            preferenceKey: "security_events",
            severity: "warning",
            title: "Sign-in Temporarily Locked",
            message: `Multiple failed sign-in attempts locked login for ${user.email} from ${ip}.`,
            dedupKey: `sec:lock:${user.id}`,
            dedupWindowSeconds: 600,
          }).catch(() => null);
        }
      }
      return c.json(
        {
          error: attempt.locked
            ? "Too many failed login attempts. Account sign-in temporarily locked."
            : "Invalid email or password.",
          code: attempt.locked ? "LOGIN_RATE_LIMITED" : "INVALID_CREDENTIALS",
        },
        attempt.locked ? 429 : 401
      );
    }

    if (user.status !== "active") {
      return c.json(
        { error: "This user profile is disabled.", code: "USER_DISABLED" },
        403
      );
    }

    await resetAttempts(db, rateKey, ip);

    const { data: staffRows } = await db
      .from("staff")
      .select("account_id,role,status")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("created_at", { ascending: true });

    const memberships = (staffRows ?? []) as Array<{
      account_id: string;
      role: string;
      status: string;
    }>;

    if (memberships.length === 0) {
      return c.json(
        { error: "No active account membership found for this user.", code: "NO_ACTIVE_MEMBERSHIP" },
        403
      );
    }

    const primaryMembership = memberships[0]!;
    const { data: accountData } = await db
      .from("accounts")
      .select("id,name,slug,status")
      .eq("id", primaryMembership.account_id)
      .is("deleted_at", null)
      .maybeSingle();

    if (!accountData) {
      return c.json({ error: "Associated account no longer exists." }, 403);
    }

    const account = accountData as {
      id: string;
      name: string;
      slug: string;
      status: "active" | "paused" | "pending_deletion";
    };

    const rawToken = generateRandomToken(32);
    const tokenHash = await sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

    await db.from("sessions").insert({
      user_id: user.id,
      active_account_id: account.id,
      session_scope: "user_console",
      token_hash: tokenHash,
      ip_address: ip,
      user_agent: c.req.header("user-agent") ?? null,
      expires_at: expiresAt,
    });

    await db
      .from("users")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", user.id);

    await recordActivity(db, {
      accountId: account.id,
      actorUserId: user.id,
      category: "security",
      action: "auth.login",
      summary: `${user.email} signed in to User Console`,
    });

    c.header(
      "Set-Cookie",
      serializeSessionCookie(
        USER_SESSION_COOKIE,
        rawToken,
        SESSION_TTL_SECONDS,
        isHttpsRequest(c.req.raw)
      )
    );

    const { data: pCfg } = await db
      .from("platform_settings")
      .select("default_timezone")
      .eq("id", 1)
      .maybeSingle();
    const platformDefaultTimezone =
      (pCfg as { default_timezone?: string } | null)?.default_timezone ?? "UTC";

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        appearancePreference: user.appearance_preference,
        timezone: user.timezone ?? null,
      },
      account: {
        id: account.id,
        name: account.name,
        slug: account.slug,
        status: account.status,
        staffRole: primaryMembership.role,
      },
      onboarding: resolveOnboardingState(user),
      platformDefaultTimezone,
      effectiveTimezone: resolveEffectiveTimezone(user.timezone, platformDefaultTimezone),
    });
  });

  app.post("/logout", async (c) => {
    const auth = await resolveUserSessionFromRequest(c);
    if (auth) {
      const db = c.get("db");
      await db
        .from("sessions")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", auth.sessionId);
      // The browser's subscribe-only real-time identity dies with the session.
      await revokeRealtimeCredential({
        db,
        env: c.env ?? {},
        deps: c.get("deps") ?? {},
        sessionId: auth.sessionId,
      });
    }

    c.header(
      "Set-Cookie",
      serializeClearCookie(USER_SESSION_COOKIE, isHttpsRequest(c.req.raw))
    );
    return c.json({ ok: true });
  });

  app.get("/me", requireUserSession({ allowPausedAccount: true }), async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");

    const [{ data: staffRows }, { data: pCfg }, { data: avatarRow }, onboarding] = await Promise.all([
      db
        .from("staff")
        .select("account_id,role,status")
        .eq("user_id", auth.userId)
        .eq("status", "active"),
      db
        .from("platform_settings")
        .select("default_timezone")
        .eq("id", 1)
        .maybeSingle(),
      db.from("users").select("avatar_seed").eq("id", auth.userId).maybeSingle(),
      readOnboardingState(db, auth.userId),
    ]);

    const memberships = (staffRows ?? []) as Array<{
      account_id: string;
      role: string;
    }>;
    let accountsList: Array<{
      id: string;
      name: string;
      slug: string;
      status: string;
      staffRole: string;
    }> = [];

    if (memberships.length === 1 && memberships[0]!.account_id === auth.accountId) {
      accountsList = [
        {
          id: auth.accountId,
          name: auth.accountName,
          slug: auth.accountSlug,
          status: auth.accountStatus,
          staffRole: memberships[0]!.role,
        },
      ];
    } else if (memberships.length > 0) {
      const accountIds = memberships.map((r) => r.account_id);
      const { data: accts } = await db
        .from("accounts")
        .select("id,name,slug,status")
        .in("id", accountIds)
        .is("deleted_at", null);

      const roleByAcct = new Map(memberships.map((r) => [r.account_id, r.role]));

      accountsList = ((accts ?? []) as Array<{
        id: string;
        name: string;
        slug: string;
        status: string;
      }>).map((a) => ({
        ...a,
        staffRole: roleByAcct.get(a.id) ?? "viewer",
      }));
    }

    const platformDefaultTimezone =
      (pCfg as { default_timezone?: string } | null)?.default_timezone ?? "UTC";

    return c.json({
      user: {
        id: auth.userId,
        email: auth.email,
        fullName: auth.fullName,
        avatarSeed: (avatarRow as { avatar_seed?: string | null } | null)?.avatar_seed ?? null,
        appearancePreference: auth.appearancePreference,
        timezone: auth.timezone,
      },
      account: {
        id: auth.accountId,
        name: auth.accountName,
        slug: auth.accountSlug,
        status: auth.accountStatus,
        staffRole: auth.staffRole,
      },
      accounts: accountsList,
      onboarding,
      platformDefaultTimezone,
      effectiveTimezone: resolveEffectiveTimezone(auth.timezone, platformDefaultTimezone),
    });
  });

  // ---- Mandatory four-step onboarding -------------------------------------
  // Progress lives on the user row so it survives refreshes and sign-outs, and
  // only `POST /onboarding/complete` unlocks the dashboard. A paused account may
  // still finish the tour (its console stays read-only), so onboarding can never
  // dead-end.
  app.get("/onboarding", requireUserSession({ allowPausedAccount: true }), async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const onboarding = await readOnboardingState(db, auth.userId);
    return c.json({ onboarding });
  });

  app.put("/onboarding", requireUserSession({ allowPausedAccount: true }), async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = onboardingStepSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Pick a step between 1 and 4.", code: "INVALID_ONBOARDING_STEP" },
        400
      );
    }

    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const result = await saveOnboardingProgress(db, auth.userId, parsed.data.step);
    if (!result.ok) {
      return c.json(
        { error: result.error, code: result.code ?? "ONBOARDING_SAVE_FAILED" },
        result.status as 400 | 500
      );
    }
    return c.json({ onboarding: result.state });
  });

  app.post("/onboarding/complete", requireUserSession({ allowPausedAccount: true }), async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const result = await completeOnboarding(db, auth.userId, auth.accountId, {
      actorEmail: auth.email,
    });
    if (!result.ok) {
      return c.json(
        { error: result.error, code: result.code ?? "ONBOARDING_COMPLETE_FAILED" },
        500
      );
    }
    return c.json({ onboarding: result.state });
  });

  app.post(
    "/switch-account",
    requireUserSession({ allowPausedAccount: true }),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = switchAccountSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Valid accountId is required." }, 400);
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");

      const { data: membership } = await db
        .from("staff")
        .select("id,role,status")
        .eq("user_id", auth.userId)
        .eq("account_id", parsed.data.accountId)
        .eq("status", "active")
        .maybeSingle();

      if (!membership) {
        return c.json(
          { error: "You do not have active access to that account." },
          403
        );
      }

      const previousAccountId = auth.accountId;
      await db
        .from("sessions")
        .update({ active_account_id: parsed.data.accountId })
        .eq("id", auth.sessionId);

      // The browser identity is account-scoped (username, topic and ACL all
      // embed the account id). Revoke it before the console boots the new
      // account so the previous account's channel can never be reused.
      if (previousAccountId !== parsed.data.accountId) {
        await revokeRealtimeCredential({
          db,
          env: c.env ?? {},
          deps: c.get("deps") ?? {},
          sessionId: auth.sessionId,
        });
      }

      return c.json({
        ok: true,
        activeAccountId: parsed.data.accountId,
        realtimeReconciled: previousAccountId !== parsed.data.accountId,
      });
    }
  );

  app.patch(
    "/profile",
    requireUserSession({ allowPausedAccount: true }),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = profileSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid profile fields." }, 400);
      }

      if (parsed.data.timezone !== undefined && parsed.data.timezone !== null) {
        if (!isValidIanaTimezone(parsed.data.timezone)) {
          return c.json({ error: "Invalid IANA time zone identifier." }, 400);
        }
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const updates: Record<string, unknown> = {};
      if (parsed.data.fullName) updates.full_name = parsed.data.fullName;
      if (parsed.data.appearancePreference) {
        updates.appearance_preference = parsed.data.appearancePreference;
      }
      if (parsed.data.avatarSeed !== undefined) updates.avatar_seed = parsed.data.avatarSeed;
      if (parsed.data.timezone !== undefined) {
        updates.timezone = parsed.data.timezone;
      }

      if (Object.keys(updates).length > 0) {
        const { error } = await db.from("users").update(updates).eq("id", auth.userId).select("id").single();
        if (error) return c.json({ error: "Unable to save profile." }, 500);
      }

      const { data: pCfg } = await db
        .from("platform_settings")
        .select("default_timezone")
        .eq("id", 1)
        .maybeSingle();
      const platformDefaultTimezone =
        (pCfg as { default_timezone?: string } | null)?.default_timezone ?? "UTC";
      const nextTz =
        parsed.data.timezone !== undefined ? parsed.data.timezone : auth.timezone;

      return c.json({
        ok: true,
        timezone: nextTz,
        platformDefaultTimezone,
        effectiveTimezone: resolveEffectiveTimezone(nextTz, platformDefaultTimezone),
      });
    }
  );

  app.post(
    "/change-password",
    requireUserSession({ allowPausedAccount: true }),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = changePasswordSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Current password and a new password (8+ chars) are required." },
          400
        );
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");

      const { data: userRow } = await db
        .from("users")
        .select("id,password_hash")
        .eq("id", auth.userId)
        .single();

      if (
        !userRow ||
        !(await verifyPassword(
          (userRow as { password_hash: string }).password_hash,
          parsed.data.currentPassword
        ))
      ) {
        return c.json({ error: "Current password is incorrect." }, 401);
      }

      const newHash = await hashPassword(parsed.data.newPassword);
      await db
        .from("users")
        .update({ password_hash: newHash })
        .eq("id", auth.userId);

      // Revoke all OTHER sessions for this user, including their broker
      // identities: a revoked session must stop receiving private events at once.
      const { data: otherSessions } = await db
        .from("sessions")
        .select("id")
        .eq("user_id", auth.userId)
        .neq("id", auth.sessionId)
        .is("revoked_at", null);
      const otherSessionIds = ((otherSessions ?? []) as Array<{ id: string }>).map(
        (row) => row.id
      );

      await db
        .from("sessions")
        .update({ revoked_at: new Date().toISOString() })
        .eq("user_id", auth.userId)
        .neq("id", auth.sessionId)
        .is("revoked_at", null);

      await revokeRealtimeCredentialsForSessions({
        db,
        env: c.env ?? {},
        deps: c.get("deps") ?? {},
        sessionIds: otherSessionIds,
      });

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        category: "security",
        action: "auth.password_changed",
        summary: `${auth.email} changed account password and revoked other sessions`,
      });

      await emitNotification(db, {
        scope: "user",
        accountId: auth.accountId,
        userId: auth.userId,
        category: "security",
        eventKey: "security.password_changed",
        preferenceKey: "security_events",
        severity: "info",
        title: "Password Changed",
        message: "Your password was updated and all other active console sessions were revoked.",
      }).catch(() => null);

      return c.json({ ok: true });
    }
  );

  // ---------------- PASSWORD RECOVERY (6-digit OTP over Brevo) ----------------
  // Three steps, in order: ask for a code, verify the code, set a new password.
  // Nothing in the first step reveals whether an address has an account.
  app.post("/password-reset/request", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = passwordResetRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Enter the email address of your account." }, 400);
    }

    const db = c.get("db");
    const sender = await loadBrevoSender(db);
    if (!sender.fromEmail || !(c.env?.BREVO_API_KEY ?? "").trim()) {
      return c.json(
        {
          error:
            "Password recovery email is not configured yet. Ask your administrator to set the Brevo sender and BREVO_API_KEY.",
          code: "EMAIL_NOT_CONFIGURED",
        },
        503
      );
    }

    const email = parsed.data.email.toLowerCase();
    const ip = extractClientIp(c.req.raw);

    const { data: userData } = await db
      .from("users")
      .select("id,email,full_name,status")
      .eq("email", email)
      .eq("user_kind", "customer")
      .is("deleted_at", null)
      .maybeSingle();

    const user = userData as {
      id: string;
      email: string;
      full_name: string;
      status: "active" | "disabled";
    } | null;

    // The response is identical either way: an unknown address must not become
    // an account-existence oracle.
    const generic = {
      ok: true,
      expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
    } as const;
    if (!user) return c.json(generic);

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recentData } = await db
      .from("password_reset_otps")
      .select("id,created_at")
      .eq("user_id", user.id)
      .gte("created_at", hourAgo)
      .order("created_at", { ascending: false });

    const recent = (recentData ?? []) as Array<{ id: string; created_at: string }>;
    const last = recent[0];
    if (last) {
      const elapsedSeconds = Math.floor(
        (Date.now() - new Date(last.created_at).getTime()) / 1000
      );
      if (elapsedSeconds < PASSWORD_RESET_RESEND_SECONDS) {
        return c.json(
          {
            error: `A code was just sent. Try again in ${PASSWORD_RESET_RESEND_SECONDS - elapsedSeconds}s.`,
            code: "RESET_RATE_LIMITED",
            retryAfterSeconds: PASSWORD_RESET_RESEND_SECONDS - elapsedSeconds,
          },
          429
        );
      }
    }
    if (recent.length >= PASSWORD_RESET_MAX_PER_HOUR) {
      return c.json(
        {
          error: "Too many recovery codes requested. Try again in an hour.",
          code: "RESET_RATE_LIMITED",
        },
        429
      );
    }

    // Only the newest code is ever accepted.
    await db
      .from("password_reset_otps")
      .update({ consumed_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .is("consumed_at", null);

    const code = generateSixDigitPairingCode();
    const expiresAt = new Date(
      Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000
    ).toISOString();

    const { data: inserted, error: insertError } = await db
      .from("password_reset_otps")
      .insert({
        user_id: user.id,
        email,
        otp_hash: await hashRecoveryCode(user.id, code),
        expires_at: expiresAt,
        request_ip: ip,
      })
      .select("id")
      .single();

    if (insertError || !inserted) {
      return c.json({ error: "The recovery code could not be created." }, 500);
    }

    const sent = await sendPasswordRecoveryEmail({
      apiKey: c.env?.BREVO_API_KEY,
      sender,
      input: {
        to: email,
        code,
        expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
        recipientName: user.full_name,
      },
      mailFetch: (c.get("deps") ?? {}).mailFetch,
    });

    if (!sent.ok) {
      // A code that never reached the customer must not linger.
      await db.from("password_reset_otps").delete().eq("id", (inserted as { id: string }).id);
      return c.json(
        {
          error:
            sent.reason === "not_configured"
              ? "Password recovery email is not configured yet. Ask your administrator to set the Brevo sender and BREVO_API_KEY."
              : "The recovery email could not be sent. Please try again.",
          code: sent.reason === "not_configured" ? "EMAIL_NOT_CONFIGURED" : "EMAIL_SEND_FAILED",
        },
        sent.reason === "not_configured" ? 503 : 502
      );
    }

    return c.json(generic);
  });

  app.post("/password-reset/verify", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = passwordResetVerifySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Enter the six-digit code from the email." }, 400);
    }

    const db = c.get("db");
    const email = parsed.data.email.toLowerCase();

    const { data: rowData } = await db
      .from("password_reset_otps")
      .select("id,user_id,otp_hash,attempts,expires_at")
      .eq("email", email)
      .is("consumed_at", null)
      .is("reset_token_hash", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const row = rowData as {
      id: string;
      user_id: string;
      otp_hash: string;
      attempts: number;
      expires_at: string;
    } | null;

    if (!row) {
      return c.json(
        {
          error: "That code is no longer valid. Request a new one.",
          code: "OTP_INVALID",
        },
        400
      );
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return c.json(
        { error: "That code has expired. Request a new one.", code: "OTP_EXPIRED" },
        410
      );
    }
    if (row.attempts >= PASSWORD_RESET_MAX_ATTEMPTS) {
      return c.json(
        {
          error: "Too many incorrect codes. Request a new one.",
          code: "OTP_ATTEMPTS_EXCEEDED",
        },
        429
      );
    }

    const expected = await hashRecoveryCode(row.user_id, parsed.data.otp);
    if (expected !== row.otp_hash) {
      await db
        .from("password_reset_otps")
        .update({ attempts: row.attempts + 1 })
        .eq("id", row.id);
      const remaining = Math.max(0, PASSWORD_RESET_MAX_ATTEMPTS - (row.attempts + 1));
      return c.json(
        {
          error:
            remaining > 0
              ? `That code is not correct. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`
              : "That code is not correct. Request a new one.",
          code: "OTP_MISMATCH",
          attemptsRemaining: remaining,
        },
        400
      );
    }

    const resetToken = generateRandomToken(32);
    const tokenExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await db
      .from("password_reset_otps")
      .update({
        consumed_at: new Date().toISOString(),
        reset_token_hash: await sha256Hex(resetToken),
        reset_token_expires_at: tokenExpiresAt,
      })
      .eq("id", row.id);

    return c.json({ resetToken, expiresAt: tokenExpiresAt });
  });

  app.post("/password-reset/confirm", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = passwordResetConfirmSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "A verified code and a new password (8+ chars) are required." },
        400
      );
    }

    const db = c.get("db");
    const tokenHash = await sha256Hex(parsed.data.resetToken);

    const { data: rowData } = await db
      .from("password_reset_otps")
      .select("id,user_id,email,reset_token_expires_at,reset_token_used_at")
      .eq("reset_token_hash", tokenHash)
      .maybeSingle();

    const row = rowData as {
      id: string;
      user_id: string;
      email: string;
      reset_token_expires_at: string | null;
      reset_token_used_at: string | null;
    } | null;

    if (!row || row.reset_token_used_at) {
      return c.json(
        {
          error: "This password reset has expired. Start recovery again.",
          code: "RESET_TOKEN_INVALID",
        },
        400
      );
    }
    if (
      !row.reset_token_expires_at ||
      new Date(row.reset_token_expires_at).getTime() <= Date.now()
    ) {
      return c.json(
        {
          error: "This password reset has expired. Start recovery again.",
          code: "RESET_TOKEN_EXPIRED",
        },
        410
      );
    }

    const { data: userData } = await db
      .from("users")
      .select("id,email,status")
      .eq("id", row.user_id)
      .is("deleted_at", null)
      .maybeSingle();

    const user = userData as {
      id: string;
      email: string;
      status: "active" | "disabled";
    } | null;

    if (!user) {
      return c.json(
        { error: "This password reset is no longer valid.", code: "RESET_TOKEN_INVALID" },
        400
      );
    }
    if (user.status !== "active") {
      return c.json({ error: "This user profile is disabled.", code: "USER_DISABLED" }, 403);
    }

    const nowIso = new Date().toISOString();
    await db
      .from("users")
      .update({ password_hash: await hashPassword(parsed.data.newPassword) })
      .eq("id", user.id);

    // A recovery is a security event: every existing session is revoked, so the
    // console always signs in again with the new password.
    const { data: liveSessions } = await db
      .from("sessions")
      .select("id")
      .eq("user_id", user.id)
      .is("revoked_at", null);

    await db
      .from("sessions")
      .update({ revoked_at: nowIso })
      .eq("user_id", user.id)
      .is("revoked_at", null);

    // Revoked sessions must also lose their subscribe-only broker identity,
    // otherwise a still-open tab keeps receiving private account events.
    await revokeRealtimeCredentialsForSessions({
      db,
      env: c.env ?? {},
      deps: c.get("deps") ?? {},
      sessionIds: ((liveSessions ?? []) as Array<{ id: string }>).map((row) => row.id),
    });

    await db
      .from("password_reset_otps")
      .update({ reset_token_used_at: nowIso })
      .eq("user_id", user.id)
      .is("reset_token_used_at", null);

    const { data: staffMembership } = await db
      .from("staff")
      .select("account_id")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const accountId =
      (staffMembership as { account_id: string } | null)?.account_id ?? null;

    await recordActivity(db, {
      accountId,
      actorUserId: user.id,
      category: "security",
      action: "auth.password_recovered",
      summary: `${user.email} recovered the account password with an emailed code and revoked all sessions`,
    }).catch(() => null);

    if (accountId) {
      await emitNotification(db, {
        scope: "user",
        accountId,
        userId: user.id,
        category: "security",
        eventKey: "security.password_recovered",
        preferenceKey: "security_events",
        severity: "warning",
        title: "Password Recovered",
        message:
          "A recovery code was used to set a new password, and every active console session was signed out.",
        dedupKey: `sec:reset:${user.id}`,
        dedupWindowSeconds: 300,
      }).catch(() => null);
    }

    return c.json({ ok: true });
  });

  app.get(
    "/sessions",
    requireUserSession({ allowPausedAccount: true }),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");

      const { data } = await db
        .from("sessions")
        .select("id,ip_address,user_agent,expires_at,last_seen_at,created_at,revoked_at")
        .eq("user_id", auth.userId)
        .eq("session_scope", "user_console")
        .is("revoked_at", null)
        .order("last_seen_at", { ascending: false });

      const items = ((data ?? []) as Array<{
        id: string;
        ip_address: string | null;
        user_agent: string | null;
        expires_at: string;
        last_seen_at: string;
        created_at: string;
      }>).map((s) => ({
        ...s,
        isCurrent: s.id === auth.sessionId,
      }));

      return c.json({ sessions: items });
    }
  );

  app.delete(
    "/sessions/:id",
    requireUserSession({ allowPausedAccount: true }),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const targetId = c.req.param("id");

      await db
        .from("sessions")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", targetId)
        .eq("user_id", auth.userId);

      // Close the revoked session's live broker subscription immediately.
      await revokeRealtimeCredential({
        db,
        env: c.env ?? {},
        deps: c.get("deps") ?? {},
        sessionId: targetId,
      });

      if (targetId !== auth.sessionId) {
        await emitNotification(db, {
          scope: "user",
          accountId: auth.accountId,
          userId: auth.userId,
          category: "security",
          eventKey: "security.session_revoked",
          preferenceKey: "security_events",
          severity: "info",
          title: "Console Session Revoked",
          message: "An active console session was manually revoked from security settings.",
          dedupKey: `sec:rev_sess:${targetId}`,
          dedupWindowSeconds: 300,
        }).catch(() => null);
      }

      return c.json({ ok: true });
    }
  );

  app.post(
    "/invitations/accept",
    requireUserSession({ allowPausedAccount: true }),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = acceptInviteSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Valid invitation code is required." }, 400);
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const codeHash = await sha256Hex(parsed.data.code);

      const { data: invData } = await db
        .from("staff_invitations")
        .select("*")
        .eq("code_hash", codeHash)
        .is("revoked_at", null)
        .maybeSingle();

      const invite = invData as {
        id: string;
        account_id: string;
        invited_email: string | null;
        role: "administrator" | "operator" | "viewer";
        expires_at: string;
        max_uses: number;
        used_count: number;
      } | null;

      if (!invite) {
        return c.json({ error: "Invitation code is invalid or revoked." }, 404);
      }

      if (new Date(invite.expires_at).getTime() <= Date.now()) {
        return c.json({ error: "Invitation code has expired." }, 410);
      }

      if (invite.used_count >= invite.max_uses) {
        return c.json({ error: "Invitation code has reached its usage limit." }, 410);
      }

      if (
        invite.invited_email &&
        invite.invited_email.toLowerCase() !== auth.email.toLowerCase()
      ) {
        return c.json(
          { error: "This invitation was issued for a different email address." },
          403
        );
      }

      const { data: existingStaff } = await db
        .from("staff")
        .select("id")
        .eq("account_id", invite.account_id)
        .eq("user_id", auth.userId)
        .maybeSingle();

      if (!existingStaff) {
        await db.from("staff").insert({
          account_id: invite.account_id,
          user_id: auth.userId,
          role: invite.role,
          status: "active",
        });
      }

      await db
        .from("staff_invitations")
        .update({ used_count: invite.used_count + 1 })
        .eq("id", invite.id);

      await db
        .from("sessions")
        .update({ active_account_id: invite.account_id })
        .eq("id", auth.sessionId);

      await recordActivity(db, {
        accountId: invite.account_id,
        actorUserId: auth.userId,
        category: "staff",
        action: "staff.invitation_accepted",
        summary: `${auth.email} joined account as ${invite.role}`,
      });

      return c.json({
        ok: true,
        accountId: invite.account_id,
        role: invite.role,
      });
    }
  );

  return app;
}
