import { Hono } from "hono";
import { unzipSync, strFromU8 } from "fflate";
import { z } from "zod";
import {
  SUPPORTED_CHIP_FAMILIES,
  chipSupportsBle,
  defaultBootloaderOffsetForChip,
  inspectEspIdfBinary,
  isNewerFirmwareVersion,
  isValidIanaTimezone,
  parseFlashSizeMb,
  resolveBoardFirmwareCompatibility,
  resolveBoardSelectionBuildConfig,
  resolveEffectiveTimezone,
  validateBoardProfileSpec,
  validateBoardPublicationReady,
  validateFirmwareBoardsCompatibility,
  type BoardBuildConfigInput,
  type BoardProfileSpec,
  type FirmwareCompatibleBoardItem,
  type PartitionScheme,
  type PsramMode,
} from "@homecoreos/shared";
import { inspectConfiguration } from "../config/env";
import { recordActivity } from "../lib/audit";
import { runOfficialCatalogSync } from "../lib/espressif-catalog-sync";
import {
  checkControllerReleaseCompatibility,
  syncBoardFirmwareStatuses,
  type CompatBoardRecord,
} from "../lib/firmware-compatibility";
import {
  ADMIN_SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  isHttpsRequest,
  serializeClearCookie,
  serializeSessionCookie,
} from "../lib/cookies";
import {
  generateRandomToken,
  generateSlugSuffix,
  hashPassword,
  sha256Hex,
  verifyPassword,
} from "../lib/crypto";
import type { DbClient } from "../lib/db";
import { EmqxClient, isEmqxConfigured } from "../lib/emqx";
import { emitNotification } from "../lib/notifications";
import {
  checkR2Health,
  deleteFirmwareObject,
  putFirmwareObject,
} from "../lib/r2";
import {
  checkAttemptAllowed,
  extractClientIp,
  recordFailedAttempt,
  resetAttempts,
} from "../lib/rate-limit";
import { requireAdminSession } from "../middleware/auth";
import type { AppEnv } from "../types/context";

const bootstrapSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(10).max(256),
  fullName: z.string().trim().min(2).max(120),
});

const adminLoginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(256),
});

const adminCreateAccountSchema = z.object({
  accountName: z.string().trim().min(2).max(120),
  ownerEmail: z.string().trim().email().max(200),
  ownerFullName: z.string().trim().min(2).max(120),
  ownerPassword: z.string().min(8).max(256),
  status: z.enum(["active", "paused"]).default("active"),
});

const adminStaffCreateSchema = z.object({
  email: z.string().trim().email().max(200),
  fullName: z.string().trim().min(2).max(120),
  password: z.string().min(8).max(256),
  role: z.enum(["owner", "administrator", "operator", "viewer"]),
});

const platformStaffCreateSchema = z.object({
  email: z.string().trim().email().max(200),
  fullName: z.string().trim().min(2).max(120),
  password: z.string().min(10).max(256),
  role: z.enum(["super_admin", "operator", "support"]),
});

const platformSettingsPatchSchema = z.object({
  customer_registration_enabled: z.boolean().optional(),
  pairing_code_expiration_seconds: z.number().int().min(60).max(1800).optional(),
  default_account_status: z.enum(["active", "paused"]).optional(),
  controller_heartbeat_interval_seconds: z.number().int().min(10).max(300).optional(),
  controller_offline_timeout_seconds: z.number().int().min(30).max(900).optional(),
  max_devices_per_account: z.number().int().min(1).max(5000).optional(),
  max_controllers_per_account: z.number().int().min(1).max(500).optional(),
  supported_firmware_channels: z.array(z.enum(["stable", "beta", "development"])).min(1).optional(),
  maintenance_mode: z.boolean().optional(),
  board_catalog_enabled: z.boolean().optional(),
  default_timezone: z.string().trim().min(1).max(64).optional(),
});

const boardCatalogSchema = z.object({
  slug: z.string().trim().min(2).max(120),
  manufacturer: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  revision: z.string().trim().min(1).max(32).default("v1.0"),
  chipFamily: z.enum(SUPPORTED_CHIP_FAMILIES),
  chipVariant: z.string().trim().min(1).max(80),
  flashSizeMb: z.number().int().min(2).max(64),
  psramSizeMb: z.number().int().min(0).max(32),
  usbVid: z.string().max(16).optional(),
  usbPid: z.string().max(16).optional(),
  description: z.string().max(500).optional(),
  isAvailable: z.boolean().default(true),
  catalogCategory: z
    .enum(["official_espressif", "partner", "custom"])
    .optional(),
  series: z.string().max(48).nullable().optional(),
  imageUrl: z.string().max(500).nullable().optional(),
  docsUrl: z.string().max(500).nullable().optional(),
  datasheetUrl: z.string().max(500).nullable().optional(),
  sourceUrl: z.string().max(500).nullable().optional(),
  verificationStatus: z.enum(["verified", "needs_verification"]).default("verified"),
  firmwareStatus: z
    .enum(["firmware_supported", "catalog_only", "build_pending", "unsupported"])
    .default("catalog_only"),
  revisionNotes: z.string().max(1000).nullable().optional(),
  boardLayout: z.record(z.unknown()).nullable().optional(),
  gpioDefinitions: z.array(
    z.object({
      pin: z.number().int().min(0).max(54),
      label: z.string().trim().min(1).max(64),
      board_pin_name: z.string().trim().max(48).nullable().optional(),
      header_side: z.enum(["left", "right"]).nullable().optional(),
      header_position: z.number().int().min(1).max(40).nullable().optional(),
      board_note: z.string().trim().max(160).nullable().optional(),
      capabilities: z.object({
        digital_in: z.boolean(),
        digital_out: z.boolean(),
        pwm: z.boolean(),
        adc: z.boolean(),
        i2c: z.boolean(),
        spi: z.boolean(),
        uart: z.boolean(),
        touch: z.boolean(),
        pull_up: z.boolean(),
        pull_down: z.boolean(),
      }),
      restrictions: z.object({
        input_only: z.boolean(),
        reserved: z.boolean(),
        reserved_reason: z.string().max(200).optional(),
        strapping_pin: z.boolean(),
        strapping_note: z.string().max(200).optional(),
        flash_psram_conflict: z.boolean(),
        usb_jtag_conflict: z.boolean(),
      }),
    })
  ),
});

const packageManifestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(64),
  channel: z.enum(["stable", "beta", "development"]).default("stable"),
  chip_family: z.enum(SUPPORTED_CHIP_FAMILIES),
  chip_variant: z.string().trim().max(80).optional(),
  target_board_slug: z.string().trim().max(120).optional(),
  partition_scheme: z
    .enum(["dual_ota_4mb", "dual_ota_8mb", "dual_ota_16mb", "dual_ota_32mb"])
    .optional(),
  psram_mode: z.enum(["none", "quad", "octal"]).optional(),
  supports_wifi: z.boolean().optional(),
  supports_ble: z.boolean().optional(),
  supports_ble_wifi_provisioning: z.boolean().optional(),
  idf_version: z.string().trim().max(32).optional(),
  hardware_verified: z.boolean().optional(),
  verified_on_hardware: z.boolean().optional(),
  ci_run_url: z.string().trim().max(500).optional(),
  ci_commit_sha: z.string().trim().max(64).optional(),
  release_notes: z.string().max(4000).default(""),
  compatible_board_slugs: z.array(z.string()).default([]),
  files: z
    .array(
      z.object({
        file_type: z.enum(["ota_app", "usb_factory", "manifest"]),
        file_name: z.string().trim().min(1).max(200),
        sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
        file_size_bytes: z.number().int().positive().optional(),
        flash_address: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
        flash_mode: z.string().max(16).optional(),
        flash_freq: z.string().max(16).optional(),
        flash_size: z.string().max(16).optional(),
      })
    )
    .min(1),
});

function isValidEspIdfBinary(
  bytes: Uint8Array,
  fileType: "ota_app" | "usb_factory",
  chipFamily?: string
): boolean {
  return inspectEspIdfBinary(bytes, fileType, { chipFamily }).valid;
}

export function createAdminRoutes() {
  const app = new Hono<AppEnv>();

  // ---------------- ADMIN AUTH ----------------
  app.get("/auth/bootstrap-status", async (c) => {
    const db = c.get("db");
    const { count } = await db
      .from("platform_staff")
      .select("id", { count: "exact", head: true });
    return c.json({ needsBootstrap: (count ?? 0) === 0 });
  });

  app.post("/auth/bootstrap", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = bootstrapSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Valid email, fullName, and password (10+ chars) are required." },
        400
      );
    }

    const db = c.get("db");
    const passwordHash = await hashPassword(parsed.data.password);

    const { data, error } = await db.rpc("bootstrap_platform_admin", {
      p_email: parsed.data.email.toLowerCase(),
      p_password_hash: passwordHash,
      p_full_name: parsed.data.fullName,
    });

    if (error) {
      if (error.message.includes("PLATFORM_ADMIN_ALREADY_EXISTS")) {
        return c.json(
          { error: "Initial platform administrator has already been created." },
          409
        );
      }
      return c.json({ error: error.message }, 400);
    }

    const created = Array.isArray(data)
      ? (data[0] as { user_id: string; email: string; full_name: string; role: string })
      : (data as { user_id: string; email: string; full_name: string; role: string });

    const rawToken = generateRandomToken(32);
    const tokenHash = await sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

    await db.from("sessions").insert({
      user_id: created.user_id,
      session_scope: "admin_console",
      token_hash: tokenHash,
      ip_address: extractClientIp(c.req.raw),
      user_agent: c.req.header("user-agent") ?? null,
      expires_at: expiresAt,
    });

    await recordActivity(db, {
      actorUserId: created.user_id,
      category: "admin",
      action: "admin.bootstrapped",
      summary: `Initial super_admin "${created.email}" bootstrapped`,
    });

    c.header(
      "Set-Cookie",
      serializeSessionCookie(
        ADMIN_SESSION_COOKIE,
        rawToken,
        SESSION_TTL_SECONDS,
        isHttpsRequest(c.req.raw)
      )
    );

    return c.json(
      {
        admin: {
          id: created.user_id,
          email: created.email,
          fullName: created.full_name,
          role: created.role,
        },
      },
      201
    );
  });

  app.post("/auth/login", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = adminLoginSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Email and password required." }, 400);

    const db = c.get("db");
    const email = parsed.data.email.toLowerCase();
    const ip = extractClientIp(c.req.raw);
    const rateKey = `admin:${email}`;

    const attemptCheck = await checkAttemptAllowed(db, rateKey, ip);
    if (!attemptCheck.allowed) {
      return c.json(
        { error: `Too many failed admin logins. Retry in ${attemptCheck.retryAfterSeconds}s.` },
        429
      );
    }

    const { data: userData } = await db
      .from("users")
      .select("id,email,password_hash,full_name,status,appearance_preference,deleted_at")
      .eq("email", email)
      .eq("user_kind", "platform_admin")
      .is("deleted_at", null)
      .maybeSingle();

    const user = userData as {
      id: string;
      email: string;
      password_hash: string;
      full_name: string;
      status: "active" | "disabled";
      appearance_preference: string;
    } | null;

    if (!user || !(await verifyPassword(user.password_hash, parsed.data.password))) {
      const attempt = await recordFailedAttempt(db, rateKey, ip);
      return c.json(
        {
          error: attempt.locked
            ? "Too many failed login attempts. Temporarily locked."
            : "Invalid administrator email or password.",
        },
        attempt.locked ? 429 : 401
      );
    }

    if (user.status !== "active") {
      return c.json({ error: "Administrator account is disabled." }, 403);
    }

    const { data: pStaff } = await db
      .from("platform_staff")
      .select("id,role,status")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();

    if (!pStaff) {
      return c.json({ error: "Administrator staff profile suspended or missing." }, 403);
    }

    await resetAttempts(db, rateKey, ip);

    const rawToken = generateRandomToken(32);
    const tokenHash = await sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

    await db.from("sessions").insert({
      user_id: user.id,
      session_scope: "admin_console",
      token_hash: tokenHash,
      ip_address: ip,
      user_agent: c.req.header("user-agent") ?? null,
      expires_at: expiresAt,
    });

    await db
      .from("users")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", user.id);

    c.header(
      "Set-Cookie",
      serializeSessionCookie(
        ADMIN_SESSION_COOKIE,
        rawToken,
        SESSION_TTL_SECONDS,
        isHttpsRequest(c.req.raw)
      )
    );

    return c.json({
      admin: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: (pStaff as { role: string }).role,
        appearancePreference: user.appearance_preference,
      },
    });
  });

  app.post("/auth/logout", async (c) => {
    // Clear cookie even if session already expired
    c.header(
      "Set-Cookie",
      serializeClearCookie(ADMIN_SESSION_COOKIE, isHttpsRequest(c.req.raw))
    );
    return c.json({ ok: true });
  });

  // All routes below require authenticated Platform Admin session
  for (const prefix of [
    "/auth/me",
    "/auth/profile",
    "/setup-status",
    "/overview",
    "/accounts",
    "/accounts/*",
    "/staff/*",
    "/platform-staff",
    "/platform-staff/*",
    "/firmware",
    "/firmware/*",
    "/boards",
    "/boards/*",
    "/emqx/*",
    "/usage",
    "/settings",
  ]) {
    app.use(prefix, requireAdminSession());
  }

  app.get("/auth/me", async (c) => {
    const admin = c.get("adminAuth")!;
    const db = c.get("db");
    const { data: pCfg } = await db
      .from("platform_settings")
      .select("default_timezone")
      .eq("id", 1)
      .maybeSingle();
    const platformDefaultTimezone =
      (pCfg as { default_timezone?: string } | null)?.default_timezone ?? "UTC";

    return c.json({
      admin: {
        id: admin.userId,
        email: admin.email,
        fullName: admin.fullName,
        role: admin.platformRole,
        appearancePreference: admin.appearancePreference,
        timezone: admin.timezone,
      },
      platformDefaultTimezone,
      effectiveTimezone: resolveEffectiveTimezone(
        admin.timezone,
        platformDefaultTimezone
      ),
    });
  });

  app.patch("/auth/profile", async (c) => {
    const body = await c.req.json().catch(() => null) as {
      timezone?: string | null;
      fullName?: string;
      appearancePreference?: "light" | "dark" | "system";
    } | null;

    if (body?.timezone !== undefined && body.timezone !== null) {
      if (!isValidIanaTimezone(body.timezone)) {
        return c.json({ error: "Invalid IANA time zone identifier." }, 400);
      }
    }

    const admin = c.get("adminAuth")!;
    const db = c.get("db");
    const updates: Record<string, unknown> = {};
    if (body?.fullName && body.fullName.trim().length >= 2) {
      updates.full_name = body.fullName.trim().slice(0, 120);
    }
    if (body?.appearancePreference) {
      updates.appearance_preference = body.appearancePreference;
    }
    if (body?.timezone !== undefined) {
      updates.timezone = body.timezone;
    }
    if (Object.keys(updates).length > 0) {
      await db.from("users").update(updates).eq("id", admin.userId);
    }
    return c.json({ ok: true });
  });

  // ---------------- SETUP STATUS ----------------
  app.get("/setup-status", async (c) => {
    const env = c.env ?? {};
    const db = c.get("db");
    const deps = c.get("deps") ?? {};
    const cfg = inspectConfiguration(env);

    // 1. Supabase PostgreSQL check
    let supabaseStatus: {
      configured: boolean;
      connected: boolean;
      error?: string;
    } = { configured: cfg.supabaseReady, connected: false };

    if (cfg.supabaseReady) {
      try {
        const { error } = await db.from("platform_settings").select("id").limit(1);
        supabaseStatus = {
          configured: true,
          connected: !error,
          error: error?.message,
        };
      } catch (err) {
        supabaseStatus = {
          configured: true,
          connected: false,
          error: err instanceof Error ? err.message : "Database ping failed",
        };
      }
    }

    // 2. EMQX Serverless API & Broker TLS check
    let emqxStatus: {
      configured: boolean;
      connected: boolean;
      brokerHost?: string;
      tlsPort?: number;
      activeClientsCount?: number;
      error?: string;
    } = { configured: cfg.emqxReady, connected: false };

    if (cfg.emqxReady) {
      const emqx = new EmqxClient(env, deps.emqxFetch);
      const check = await emqx.checkConnection();
      emqxStatus = {
        configured: true,
        connected: check.connected,
        brokerHost: env.EMQX_BROKER_HOST,
        tlsPort: Number(env.EMQX_TLS_PORT ?? 8883),
        activeClientsCount: check.activeClientsCount,
        error: check.error,
      };
      if (!check.connected) {
        await emitNotification(db, {
          scope: "admin",
          category: "system",
          eventKey: "admin.service_health",
          preferenceKey: "service_health_alerts",
          severity: "warning",
          title: "EMQX Broker Connection Failed",
          message: check.error ?? "Unable to reach EMQX Serverless management API.",
          dedupKey: "admin:health:emqx",
          dedupWindowSeconds: 1800,
        }).catch(() => null);
      }
    }

    // 3. R2 Firmware Bucket check
    const r2Health = await checkR2Health(env);
    if (r2Health.status === "failed") {
      await emitNotification(db, {
        scope: "admin",
        category: "system",
        eventKey: "admin.service_health",
        preferenceKey: "service_health_alerts",
        severity: "danger",
        title: "Cloudflare R2 Storage Error",
        message: r2Health.error ?? "R2 firmware bucket check failed.",
        dedupKey: "admin:health:r2",
        dedupWindowSeconds: 1800,
      }).catch(() => null);
    }

    const missingVariables = cfg.entries
      .filter((e) => e.kind !== "secret" && !e.valid)
      .map((e) => e.key);
    const missingSecrets = cfg.entries
      .filter((e) => e.kind === "secret" && !e.valid)
      .map((e) => e.key);

    return c.json({
      supabase: supabaseStatus,
      emqx: emqxStatus,
      r2: r2Health,
      entries: cfg.entries,
      missingVariables,
      missingSecrets,
    });
  });

  // ---------------- PLATFORM OVERVIEW ----------------
  app.get("/overview", async (c) => {
    const db = c.get("db");
    const [
      acctsRes,
      custUsersRes,
      ctrlRes,
      onlineCtrlRes,
      relRes,
      boardsRes,
      activityRes,
    ] = await Promise.all([
      db.from("accounts").select("id", { count: "exact", head: true }).is("deleted_at", null),
      db.from("users").select("id", { count: "exact", head: true }).eq("user_kind", "customer").is("deleted_at", null),
      db.from("controllers").select("id", { count: "exact", head: true }).is("deleted_at", null),
      db.from("controllers").select("id", { count: "exact", head: true }).eq("status", "online").is("deleted_at", null),
      db.from("firmware_releases").select("id", { count: "exact", head: true }).is("deleted_at", null),
      db.from("board_catalog").select("id", { count: "exact", head: true }).is("deleted_at", null),
      db.from("activity_logs").select("*").order("created_at", { ascending: false }).limit(25),
    ]);

    return c.json({
      counts: {
        accounts: acctsRes.count ?? 0,
        customerUsers: custUsersRes.count ?? 0,
        controllers: ctrlRes.count ?? 0,
        onlineControllers: onlineCtrlRes.count ?? 0,
        firmwareReleases: relRes.count ?? 0,
        catalogBoards: boardsRes.count ?? 0,
      },
      recentActivity: activityRes.data ?? [],
    });
  });

  // ---------------- CUSTOMER ACCOUNTS & STAFF ----------------
  app.get("/accounts", async (c) => {
    const db = c.get("db");
    const { data: accounts } = await db
      .from("accounts")
      .select("*")
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    return c.json({ accounts: accounts ?? [] });
  });

  app.post(
    "/accounts",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = adminCreateAccountSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: "Invalid account payload." }, 400);

      const admin = c.get("adminAuth")!;
      const db = c.get("db");
      const email = parsed.data.ownerEmail.toLowerCase();

      let userId: string;
      const { data: existingUser } = await db
        .from("users")
        .select("id")
        .eq("email", email)
        .eq("user_kind", "customer")
        .is("deleted_at", null)
        .maybeSingle();

      if (existingUser) {
        userId = (existingUser as { id: string }).id;
      } else {
        const hash = await hashPassword(parsed.data.ownerPassword);
        const { data: u, error: uErr } = await db
          .from("users")
          .insert({
            email,
            user_kind: "customer",
            password_hash: hash,
            full_name: parsed.data.ownerFullName,
            status: "active",
          })
          .select("id")
          .single();
        if (uErr || !u) return c.json({ error: uErr?.message ?? "User creation failed." }, 400);
        userId = (u as { id: string }).id;
      }

      const slug = `${parsed.data.accountName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 28)}-${generateSlugSuffix(5)}`;
      const { data: account, error: aErr } = await db
        .from("accounts")
        .insert({
          name: parsed.data.accountName,
          slug,
          owner_user_id: userId,
          status: parsed.data.status,
          paused_at: parsed.data.status === "paused" ? new Date().toISOString() : null,
        })
        .select("*")
        .single();

      if (aErr || !account) return c.json({ error: aErr?.message ?? "Account failed." }, 400);

      const accountId = (account as { id: string }).id;
      await db.from("staff").insert({
        account_id: accountId,
        user_id: userId,
        role: "owner",
        status: "active",
      });
      await db.from("homes").insert({
        account_id: accountId,
        name: "Primary Home",
      });

      await recordActivity(db, {
        accountId,
        actorUserId: admin.userId,
        category: "admin",
        action: "admin.account_created",
        summary: `Platform admin created customer account "${parsed.data.accountName}"`,
      });

      return c.json({ account }, 201);
    }
  );

  app.post(
    "/accounts/:id/pause",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const admin = c.get("adminAuth")!;
      const db = c.get("db");
      const accountId = c.req.param("id");
      const { data } = await db
        .from("accounts")
        .update({ status: "paused", paused_at: new Date().toISOString() })
        .eq("id", accountId)
        .is("deleted_at", null)
        .select("id")
        .maybeSingle();

      if (!data) return c.json({ error: "Account not found." }, 404);
      await recordActivity(db, {
        accountId,
        actorUserId: admin.userId,
        category: "admin",
        action: "admin.account_paused",
        summary: "Account paused by platform administrator",
      });
      return c.json({ ok: true });
    }
  );

  app.post(
    "/accounts/:id/reactivate",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const admin = c.get("adminAuth")!;
      const db = c.get("db");
      const accountId = c.req.param("id");
      const { data } = await db
        .from("accounts")
        .update({ status: "active", paused_at: null })
        .eq("id", accountId)
        .is("deleted_at", null)
        .select("id")
        .maybeSingle();

      if (!data) return c.json({ error: "Account not found." }, 404);
      await recordActivity(db, {
        accountId,
        actorUserId: admin.userId,
        category: "admin",
        action: "admin.account_reactivated",
        summary: "Account reactivated by platform administrator",
      });
      return c.json({ ok: true });
    }
  );

  app.delete(
    "/accounts/:id",
    requireAdminSession("super_admin"),
    async (c) => {
      const admin = c.get("adminAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};
      const accountId = c.req.param("id");

      const { data: creds } = await db
        .from("mqtt_credentials_metadata")
        .select("id,mqtt_username,mqtt_client_id")
        .eq("account_id", accountId)
        .eq("status", "active");

      const emqx = isEmqxConfigured(c.env ?? {})
        ? new EmqxClient(c.env!, deps.emqxFetch)
        : null;

      for (const cred of (creds ?? []) as Array<{
        id: string;
        mqtt_username: string;
        mqtt_client_id: string;
      }>) {
        if (emqx) {
          try {
            await emqx.revokeControllerCredentials(
              cred.mqtt_username,
              cred.mqtt_client_id
            );
          } catch {
            // Continue deleting account cleanly
          }
        }
        await db
          .from("mqtt_credentials_metadata")
          .update({ status: "revoked", revoked_at: new Date().toISOString() })
          .eq("id", cred.id);
      }

      const now = new Date().toISOString();
      await db
        .from("accounts")
        .update({ deleted_at: now, status: "pending_deletion" })
        .eq("id", accountId);

      await db
        .from("sessions")
        .update({ revoked_at: now })
        .eq("active_account_id", accountId)
        .is("revoked_at", null);

      await recordActivity(db, {
        accountId,
        actorUserId: admin.userId,
        category: "admin",
        action: "admin.account_deleted",
        summary: "Account soft-deleted and EMQX credentials revoked by super_admin",
      });

      return c.json({ ok: true });
    }
  );

  app.get("/accounts/:id/staff", async (c) => {
    const db = c.get("db");
    const accountId = c.req.param("id");
    const { data: staffRows } = await db
      .from("staff")
      .select("id,user_id,role,status,created_at")
      .eq("account_id", accountId);

    const rows = (staffRows ?? []) as Array<{
      id: string;
      user_id: string;
      role: string;
      status: string;
      created_at: string;
    }>;

    const ids = rows.map((r) => r.user_id);
    let userMap = new Map<string, { email: string; full_name: string }>();
    if (ids.length > 0) {
      const { data: users } = await db
        .from("users")
        .select("id,email,full_name")
        .in("id", ids);
      userMap = new Map(
        ((users ?? []) as Array<{ id: string; email: string; full_name: string }>).map(
          (u) => [u.id, u]
        )
      );
    }

    return c.json({
      staff: rows.map((r) => ({
        ...r,
        email: userMap.get(r.user_id)?.email ?? "",
        fullName: userMap.get(r.user_id)?.full_name ?? "",
      })),
    });
  });

  app.post(
    "/accounts/:id/staff",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = adminStaffCreateSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: "Invalid staff payload." }, 400);

      const db = c.get("db");
      const accountId = c.req.param("id");
      const email = parsed.data.email.toLowerCase();

      let userId: string;
      const { data: existing } = await db
        .from("users")
        .select("id")
        .eq("email", email)
        .eq("user_kind", "customer")
        .is("deleted_at", null)
        .maybeSingle();

      if (existing) {
        userId = (existing as { id: string }).id;
      } else {
        const hash = await hashPassword(parsed.data.password);
        const { data: created } = await db
          .from("users")
          .insert({
            email,
            user_kind: "customer",
            password_hash: hash,
            full_name: parsed.data.fullName,
            status: "active",
          })
          .select("id")
          .single();
        userId = (created as { id: string }).id;
      }

      const { data: staffRow, error } = await db
        .from("staff")
        .insert({
          account_id: accountId,
          user_id: userId,
          role: parsed.data.role,
          status: "active",
        })
        .select("*")
        .single();

      if (error) return c.json({ error: error.message }, 400);
      return c.json({ staff: staffRow }, 201);
    }
  );

  // ---------------- SEPARATE PLATFORM STAFF ----------------
  app.get("/platform-staff", async (c) => {
    const db = c.get("db");
    const { data: staffRows } = await db
      .from("platform_staff")
      .select("id,user_id,role,status,created_at")
      .order("created_at", { ascending: true });

    const rows = (staffRows ?? []) as Array<{
      id: string;
      user_id: string;
      role: string;
      status: string;
      created_at: string;
    }>;

    const ids = rows.map((r) => r.user_id);
    const { data: users } = await db
      .from("users")
      .select("id,email,full_name,last_login_at")
      .in("id", ids)
      .eq("user_kind", "platform_admin");

    const userMap = new Map(
      ((users ?? []) as Array<{
        id: string;
        email: string;
        full_name: string;
        last_login_at: string | null;
      }>).map((u) => [u.id, u])
    );

    return c.json({
      platformStaff: rows.map((r) => ({
        ...r,
        email: userMap.get(r.user_id)?.email ?? "",
        fullName: userMap.get(r.user_id)?.full_name ?? "",
        lastLoginAt: userMap.get(r.user_id)?.last_login_at ?? null,
      })),
    });
  });

  app.post(
    "/platform-staff",
    requireAdminSession("super_admin"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = platformStaffCreateSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid platform staff payload." }, 400);
      }

      const admin = c.get("adminAuth")!;
      const db = c.get("db");
      const email = parsed.data.email.toLowerCase();

      const { data: existing } = await db
        .from("users")
        .select("id")
        .eq("email", email)
        .eq("user_kind", "platform_admin")
        .is("deleted_at", null)
        .maybeSingle();

      if (existing) {
        return c.json({ error: "Platform admin with this email already exists." }, 409);
      }

      const hash = await hashPassword(parsed.data.password);
      const { data: user, error: uErr } = await db
        .from("users")
        .insert({
          email,
          user_kind: "platform_admin",
          password_hash: hash,
          full_name: parsed.data.fullName,
          status: "active",
        })
        .select("id")
        .single();

      if (uErr || !user) return c.json({ error: uErr?.message ?? "Failed." }, 400);

      const { data: pStaff, error: psErr } = await db
        .from("platform_staff")
        .insert({
          user_id: (user as { id: string }).id,
          role: parsed.data.role,
          status: "active",
        })
        .select("*")
        .single();

      if (psErr) return c.json({ error: psErr.message }, 400);

      await recordActivity(db, {
        actorUserId: admin.userId,
        category: "admin",
        action: "admin.platform_staff_added",
        summary: `Added platform ${parsed.data.role}: ${email}`,
      });

      return c.json({ platformStaff: pStaff }, 201);
    }
  );

  // ---------------- FIRMWARE MANAGEMENT ----------------
  app.get("/firmware", async (c) => {
    const db = c.get("db");
    const { data: releases } = await db
      .from("firmware_releases")
      .select("*")
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    const relList = (releases ?? []) as Array<{
      id: string;
      compatible_board_ids?: string[];
    }>;
    const ids = relList.map((r) => r.id);
    const filesMap = new Map<string, unknown[]>();
    const otaStatsMap = new Map<
      string,
      { total: number; succeeded: number; failed: number; active: number }
    >();

    if (ids.length > 0) {
      const [filesRes, histRes] = await Promise.all([
        db.from("firmware_files").select("*").in("release_id", ids),
        db
          .from("firmware_update_history")
          .select("release_id,status")
          .in("release_id", ids),
      ]);
      for (const f of (filesRes.data ?? []) as Array<{ release_id: string }>) {
        const arr = filesMap.get(f.release_id) ?? [];
        arr.push(f);
        filesMap.set(f.release_id, arr);
      }
      for (const h of (histRes.data ?? []) as Array<{
        release_id: string | null;
        status: string;
      }>) {
        if (!h.release_id) continue;
        const curr = otaStatsMap.get(h.release_id) ?? {
          total: 0,
          succeeded: 0,
          failed: 0,
          active: 0,
        };
        curr.total += 1;
        if (h.status === "succeeded") curr.succeeded += 1;
        else if (h.status === "failed" || h.status === "rolled_back") curr.failed += 1;
        else if (
          ["pending", "downloading", "flashing", "verifying", "rebooting"].includes(h.status)
        ) {
          curr.active += 1;
        }
        otaStatsMap.set(h.release_id, curr);
      }
    }

    const boardLookup = await loadCompatibleBoardMap(db, relList);

    return c.json({
      releases: relList.map((r) => ({
        ...r,
        files: filesMap.get(r.id) ?? [],
        ota_stats: otaStatsMap.get(r.id) ?? {
          total: 0,
          succeeded: 0,
          failed: 0,
          active: 0,
        },
        compatible_boards: (r.compatible_board_ids ?? [])
          .map((bid) => boardLookup.get(bid))
          .filter(Boolean),
      })),
    });
  });

  app.post(
    "/firmware/single",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const form = await c.req.formData().catch(() => null);
      if (!form) return c.json({ error: "Multipart form data required." }, 400);

      const rawFile = form.get("file") as unknown;
      if (
        !rawFile ||
        typeof rawFile !== "object" ||
        typeof (rawFile as { arrayBuffer?: unknown }).arrayBuffer !== "function"
      ) {
        return c.json({ error: "Firmware binary file is required." }, 400);
      }
      const file = rawFile as { name?: string; arrayBuffer: () => Promise<ArrayBuffer> };

      const name = String(form.get("name") ?? "").trim();
      const version = String(form.get("version") ?? "").trim();
      const channel = String(form.get("channel") ?? "stable").trim();
      const chipFamily = String(form.get("chipFamily") ?? "").trim();
      const fileType = String(form.get("fileType") ?? "").trim() as "ota_app" | "usb_factory";
      const flashAddress = String(form.get("flashAddress") ?? (fileType === "usb_factory" ? "0x0" : "0x20000")).trim();
      const flashMode = String(form.get("flashMode") ?? "dio").trim();
      const flashFreq = String(form.get("flashFreq") ?? "80m").trim();
      const flashSize = String(form.get("flashSize") ?? "16MB").trim();
      const targetBoardSlug = String(form.get("targetBoardSlug") ?? "").trim() || null;
      const partitionSchemeRaw = String(form.get("partitionScheme") ?? "").trim() || null;
      const psramModeRaw = String(form.get("psramMode") ?? "").trim() || null;
      const hardwareVerified = String(form.get("hardwareVerified") ?? "false") === "true";
      const verificationNotes = String(form.get("verificationNotes") ?? "").trim() || null;
      const releaseNotes = String(form.get("releaseNotes") ?? "").trim();
      const boardIdsRaw = String(form.get("compatibleBoardIds") ?? "[]");
      const publishNow = String(form.get("publish") ?? "false") === "true";

      if (!name || !version || !chipFamily || (fileType !== "ota_app" && fileType !== "usb_factory")) {
        return c.json({ error: "Missing required firmware metadata." }, 400);
      }
      if (!SUPPORTED_CHIP_FAMILIES.includes(chipFamily as (typeof SUPPORTED_CHIP_FAMILIES)[number])) {
        return c.json({ error: `Unsupported chip family "${chipFamily}".` }, 400);
      }

      let compatibleBoardIds: string[] = [];
      try {
        const parsedIds = JSON.parse(boardIdsRaw);
        if (Array.isArray(parsedIds)) compatibleBoardIds = [...new Set(parsedIds.map(String).filter(Boolean))];
      } catch {
        return c.json({ error: "compatibleBoardIds must be JSON array." }, 400);
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isValidEspIdfBinary(bytes, fileType, chipFamily)) {
        return c.json(
          {
            error:
              fileType === "usb_factory"
                ? `Invalid ESP-IDF USB factory binary for ${chipFamily} (missing 0xE9 bootloader/image header at expected offset ${defaultBootloaderOffsetForChip(chipFamily)}).`
                : "Invalid ESP-IDF OTA application binary (missing 0xE9 magic header).",
          },
          400
        );
      }

      if (fileType === "ota_app" && flashAddress === "0x0") {
        return c.json(
          { error: "An OTA application-only binary must never be tagged for flash offset 0x0." },
          400
        );
      }

      const admin = c.get("adminAuth")!;
      const db = c.get("db");
      const flashSizeMb = parseFlashSizeMb(flashSize);
      const psramMode =
        psramModeRaw && ["none", "quad", "octal"].includes(psramModeRaw)
          ? (psramModeRaw as PsramMode)
          : null;
      const partitionScheme =
        partitionSchemeRaw &&
        ["dual_ota_4mb", "dual_ota_8mb", "dual_ota_16mb", "dual_ota_32mb"].includes(
          partitionSchemeRaw
        )
          ? (partitionSchemeRaw as PartitionScheme)
          : null;

      const boardCheck = await resolveAndValidateFirmwareBoards(db, {
        boardIds: compatibleBoardIds,
        boardSlugs: targetBoardSlug ? [targetBoardSlug] : undefined,
        chipFamily,
        flashSizeMb,
        psramMode,
        partitionScheme,
      });
      if ("error" in boardCheck) {
        return c.json({ error: boardCheck.error }, 400);
      }

      const resolvedTargetSlug =
        targetBoardSlug ??
        (boardCheck.boardSlugs.length === 1 ? boardCheck.boardSlugs[0] : null);

      const { data: rel, error: relErr } = await db
        .from("firmware_releases")
        .insert({
          name,
          version,
          channel,
          chip_family: chipFamily,
          target_board_slug: resolvedTargetSlug,
          partition_scheme: partitionScheme,
          psram_mode: psramMode,
          flash_mode: flashMode,
          flash_freq: flashFreq,
          flash_size_mb: flashSizeMb,
          supports_ble: chipSupportsBle(chipFamily),
          supports_ble_wifi_provisioning:
            chipSupportsBle(chipFamily) && chipFamily !== "esp32h2",
          build_status: "manual",
          hardware_verified: hardwareVerified,
          verified_board_ids: hardwareVerified ? boardCheck.boardIds : [],
          verified_board_slugs: hardwareVerified ? boardCheck.boardSlugs : [],
          verification_notes: verificationNotes,
          compatible_board_ids: boardCheck.boardIds,
          compatible_board_slugs: boardCheck.boardSlugs,
          ota_available: fileType === "ota_app",
          usb_available: fileType === "usb_factory",
          status: publishNow ? "published" : "draft",
          release_notes: releaseNotes,
          created_by: admin.userId,
          published_at: publishNow ? new Date().toISOString() : null,
        })
        .select("*")
        .single();

      if (relErr || !rel) {
        return c.json({ error: relErr?.message ?? "Failed to create firmware release." }, 400);
      }

      const releaseId = (rel as { id: string }).id;
      const safeName = (file.name ?? "firmware.bin").replace(/[^a-zA-Z0-9._-]/g, "_");
      const r2Key = `releases/${chipFamily}/${version}/${releaseId}/${safeName}`;

      const putRes = await putFirmwareObject(c.env ?? {}, r2Key, bytes, {
        releaseId,
        fileType,
        chipFamily,
        version,
      });

      const { data: fileRow, error: fErr } = await db
        .from("firmware_files")
        .insert({
          release_id: releaseId,
          file_type: fileType,
          r2_key: r2Key,
          file_name: safeName,
          size_bytes: putRes.sizeBytes,
          sha256: putRes.sha256,
          flash_address: flashAddress,
          flash_mode: flashMode,
          flash_freq: flashFreq,
          flash_size: flashSize,
          partition_scheme: partitionScheme,
          psram_mode: psramMode,
          validated: true,
        })
        .select("*")
        .single();

      if (fErr) return c.json({ error: fErr.message }, 400);

      await recordActivity(db, {
        actorUserId: admin.userId,
        category: "admin",
        action: "admin.firmware_uploaded",
        summary: `Uploaded single ${fileType} firmware "${name}" v${version} (${chipFamily})`,
      });

      if (publishNow) {
        await syncBoardFirmwareStatuses(db, boardCheck.boardIds).catch(() => null);
        await notifyFirmwareReleasePublished(db, rel as Record<string, unknown>).catch(() => null);
      }

      return c.json(
        {
          release: { ...rel, compatible_boards: boardCheck.boards },
          files: [fileRow],
        },
        201
      );
    }
  );

  // Combined Release Uploader: create one release with USB factory + OTA binaries together
  app.post(
    "/firmware/release",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const form = await c.req.formData().catch(() => null);
      if (!form) return c.json({ error: "Multipart form data required." }, 400);

      const rawUsb = form.get("usbFile") as unknown;
      const rawOta = form.get("otaFile") as unknown;
      const hasUsb =
        rawUsb &&
        typeof rawUsb === "object" &&
        typeof (rawUsb as { arrayBuffer?: unknown }).arrayBuffer === "function";
      const hasOta =
        rawOta &&
        typeof rawOta === "object" &&
        typeof (rawOta as { arrayBuffer?: unknown }).arrayBuffer === "function";

      if (!hasUsb && !hasOta) {
        return c.json(
          { error: "Provide at least one binary (USB factory .bin or OTA app .bin)." },
          400
        );
      }

      const name = String(form.get("name") ?? "").trim();
      const version = String(form.get("version") ?? "").trim();
      const channel = String(form.get("channel") ?? "stable").trim();
      const chipFamilyRaw = String(form.get("chipFamily") ?? "").trim().toLowerCase();
      const targetBoardSlugRaw = String(form.get("targetBoardSlug") ?? "").trim() || null;
      const partitionSchemeRaw = String(form.get("partitionScheme") ?? "").trim() || null;
      const psramModeRaw = String(form.get("psramMode") ?? "").trim() || null;
      const flashModeRaw = String(form.get("flashMode") ?? "").trim() || null;
      const flashFreqRaw = String(form.get("flashFreq") ?? "").trim() || null;
      const flashSizeRaw = String(form.get("flashSize") ?? "").trim() || null;
      const otaFlashAddressRaw = String(form.get("otaFlashAddress") ?? "").trim() || null;
      const releaseNotes = String(form.get("releaseNotes") ?? "").trim();
      const hardwareVerified = String(form.get("hardwareVerified") ?? "false") === "true";
      const verificationNotes = String(form.get("verificationNotes") ?? "").trim() || null;
      const boardIdsRaw = String(form.get("compatibleBoardIds") ?? "[]");
      const publishNow = String(form.get("publish") ?? "false") === "true";

      if (!name || !version) {
        return c.json({ error: "Release name and version are required." }, 400);
      }

      let compatibleBoardIds: string[] = [];
      try {
        const parsedIds = JSON.parse(boardIdsRaw);
        if (Array.isArray(parsedIds)) compatibleBoardIds = [...new Set(parsedIds.map(String).filter(Boolean))];
      } catch {
        return c.json({ error: "compatibleBoardIds must be JSON array." }, 400);
      }

      if (compatibleBoardIds.length === 0 && !chipFamilyRaw) {
        return c.json(
          {
            error:
              "Select at least one compatible board from the catalog to resolve firmware hardware settings.",
          },
          400
        );
      }

      const admin = c.get("adminAuth")!;
      const db = c.get("db");

      let resolvedBuild: ReturnType<typeof resolveBoardSelectionBuildConfig> | null = null;
      if (compatibleBoardIds.length > 0) {
        const { data: selectedRows } = await db
          .from("board_catalog")
          .select(
            "id,slug,manufacturer,model,chip_family,chip_variant,flash_size_mb,psram_size_mb,psram_mode,partition_scheme,flash_mode,flash_freq,bootloader_offset,ota_app_offset,boot_button_gpio,supports_wifi,supports_ble,supports_ble_wifi_provisioning,firmware_status,verification_status"
          )
          .in("id", compatibleBoardIds)
          .is("deleted_at", null);

        const rowMap = new Map(
          ((selectedRows ?? []) as BoardBuildConfigInput[]).map((b) => [String(b.id), b])
        );
        if (compatibleBoardIds.some((id) => !rowMap.has(id))) {
          return c.json(
            { error: "One or more selected compatible boards no longer exist in the catalog." },
            400
          );
        }
        const orderedBoards = compatibleBoardIds.map((id) => rowMap.get(id)!);
        resolvedBuild = resolveBoardSelectionBuildConfig(orderedBoards);
        if (!resolvedBuild.valid) {
          return c.json(
            { error: resolvedBuild.errors[0] ?? "Selected boards require separate firmware binaries." },
            400
          );
        }
      }

      const chipFamily = chipFamilyRaw || resolvedBuild?.chipFamily || "";
      if (!chipFamily || !SUPPORTED_CHIP_FAMILIES.includes(chipFamily as (typeof SUPPORTED_CHIP_FAMILIES)[number])) {
        return c.json({ error: `Unsupported chip family "${chipFamily}".` }, 400);
      }

      const targetBoardSlug = targetBoardSlugRaw ?? resolvedBuild?.targetBoardSlug ?? null;
      const partitionScheme =
        partitionSchemeRaw &&
        ["dual_ota_4mb", "dual_ota_8mb", "dual_ota_16mb", "dual_ota_32mb"].includes(
          partitionSchemeRaw
        )
          ? (partitionSchemeRaw as PartitionScheme)
          : resolvedBuild?.partitionScheme ?? null;
      const psramMode =
        psramModeRaw && ["none", "quad", "octal"].includes(psramModeRaw)
          ? (psramModeRaw as PsramMode)
          : resolvedBuild?.psramMode ?? null;
      const flashMode = flashModeRaw ?? resolvedBuild?.flashMode ?? "dio";
      const flashFreq = flashFreqRaw ?? resolvedBuild?.flashFreq ?? "80m";
      const flashSize = flashSizeRaw ?? resolvedBuild?.flashSizeLabel ?? "16MB";
      const otaFlashAddress = otaFlashAddressRaw ?? resolvedBuild?.otaAppOffset ?? "0x20000";
      const flashSizeMb = parseFlashSizeMb(flashSize) ?? resolvedBuild?.flashSizeMb ?? null;
      const bootloaderOffset =
        resolvedBuild?.bootloaderOffset ?? defaultBootloaderOffsetForChip(chipFamily);

      if (resolvedBuild?.valid) {
        if (chipFamily !== resolvedBuild.chipFamily) {
          return c.json(
            {
              error: `Resolved chip family ${resolvedBuild.chipFamily?.toUpperCase()} conflicts with provided ${chipFamily.toUpperCase()}.`,
            },
            400
          );
        }
        if (partitionScheme && partitionScheme !== resolvedBuild.partitionScheme) {
          return c.json(
            {
              error: `Partition scheme ${partitionScheme} is incompatible with selected board layout (${resolvedBuild.partitionScheme}).`,
            },
            400
          );
        }
        if (psramMode && psramMode !== resolvedBuild.psramMode) {
          return c.json(
            {
              error: `PSRAM mode ${psramMode} is incompatible with selected board PSRAM (${resolvedBuild.psramMode}).`,
            },
            400
          );
        }
        if (flashSizeMb && resolvedBuild.flashSizeMb && flashSizeMb > resolvedBuild.flashSizeMb) {
          return c.json(
            {
              error: `Target flash size ${flashSizeMb}MB exceeds selected board flash (${resolvedBuild.flashSizeMb}MB).`,
            },
            400
          );
        }
      }

      if (hasOta && otaFlashAddress === "0x0") {
        return c.json(
          { error: "OTA application-only binary must never target flash offset 0x0." },
          400
        );
      }

      const usbBytes = hasUsb
        ? new Uint8Array(await (rawUsb as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer())
        : null;
      const otaBytes = hasOta
        ? new Uint8Array(await (rawOta as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer())
        : null;

      if (usbBytes) {
        const usbInspect = inspectEspIdfBinary(usbBytes, "usb_factory", {
          chipFamily,
          flashSizeMb,
          bootloaderOffset,
        });
        if (!usbInspect.valid) {
          return c.json(
            {
              error:
                usbInspect.error ??
                `Invalid ESP-IDF USB factory binary for ${chipFamily} (expected 0xE9 bootloader magic at ${bootloaderOffset}).`,
            },
            400
          );
        }
      }
      if (otaBytes) {
        const otaInspect = inspectEspIdfBinary(otaBytes, "ota_app", {
          chipFamily,
          flashSizeMb,
          bootloaderOffset,
        });
        if (!otaInspect.valid) {
          return c.json(
            {
              error:
                otaInspect.error ??
                "Invalid ESP-IDF OTA application binary (missing 0xE9 magic header).",
            },
            400
          );
        }
      }

      const boardCheck = await resolveAndValidateFirmwareBoards(db, {
        boardIds: compatibleBoardIds,
        boardSlugs: targetBoardSlug ? [targetBoardSlug] : undefined,
        chipFamily,
        flashSizeMb,
        psramMode,
        partitionScheme,
      });
      if ("error" in boardCheck) {
        return c.json({ error: boardCheck.error }, 400);
      }

      const resolvedTargetSlug =
        targetBoardSlug ??
        (boardCheck.boardSlugs.length === 1 ? boardCheck.boardSlugs[0] : null);

      const { data: rel, error: relErr } = await db
        .from("firmware_releases")
        .insert({
          name,
          version,
          channel,
          chip_family: chipFamily,
          target_board_slug: resolvedTargetSlug,
          partition_scheme: partitionScheme,
          psram_mode: psramMode,
          flash_mode: flashMode,
          flash_freq: flashFreq,
          flash_size_mb: flashSizeMb,
          supports_ble: chipSupportsBle(chipFamily),
          supports_ble_wifi_provisioning:
            chipSupportsBle(chipFamily) && chipFamily !== "esp32h2",
          build_status: "manual",
          hardware_verified: hardwareVerified,
          verified_board_ids: hardwareVerified ? boardCheck.boardIds : [],
          verified_board_slugs: hardwareVerified ? boardCheck.boardSlugs : [],
          verification_notes: verificationNotes,
          compatible_board_ids: boardCheck.boardIds,
          compatible_board_slugs: boardCheck.boardSlugs,
          ota_available: Boolean(otaBytes),
          usb_available: Boolean(usbBytes),
          status: "draft",
          release_notes: releaseNotes,
          created_by: admin.userId,
          published_at: null,
        })
        .select("*")
        .single();

      if (relErr || !rel) {
        return c.json({ error: relErr?.message ?? "Failed to create firmware release." }, 400);
      }

      const releaseId = (rel as { id: string }).id;
      const insertedFiles: unknown[] = [];
      const uploadedR2Keys: string[] = [];

      const artifacts: Array<{
        kind: "usb_factory" | "ota_app";
        bytes: Uint8Array;
        rawName: string;
        flashAddress: string;
      }> = [];
      if (usbBytes) {
        artifacts.push({
          kind: "usb_factory",
          bytes: usbBytes,
          rawName:
            (rawUsb as { name?: string }).name ?? `homecoreos-${chipFamily}-usb-factory.bin`,
          flashAddress: "0x0",
        });
      }
      if (otaBytes) {
        artifacts.push({
          kind: "ota_app",
          bytes: otaBytes,
          rawName: (rawOta as { name?: string }).name ?? `homecoreos-${chipFamily}-ota.bin`,
          flashAddress: otaFlashAddress,
        });
      }

      try {
        for (const art of artifacts) {
          const safeName = art.rawName.replace(/[^a-zA-Z0-9._-]/g, "_");
          const r2Key = `releases/${chipFamily}/${version}/${releaseId}/${art.kind}-${safeName}`;
          const putRes = await putFirmwareObject(c.env ?? {}, r2Key, art.bytes, {
            releaseId,
            fileType: art.kind,
            chipFamily,
            version,
          });
          uploadedR2Keys.push(r2Key);
          const { data: fRow, error: fErr } = await db
            .from("firmware_files")
            .insert({
              release_id: releaseId,
              file_type: art.kind,
              r2_key: r2Key,
              file_name: safeName,
              size_bytes: putRes.sizeBytes,
              sha256: putRes.sha256,
              flash_address: art.flashAddress,
              flash_mode: flashMode,
              flash_freq: flashFreq,
              flash_size: flashSize,
              partition_scheme: partitionScheme,
              psram_mode: psramMode,
              validated: true,
            })
            .select("*")
            .single();
          if (fErr) {
            throw new Error(fErr.message);
          }
          if (fRow) insertedFiles.push(fRow);
        }
      } catch (uploadErr) {
        for (const key of uploadedR2Keys) {
          await deleteFirmwareObject(c.env ?? {}, key).catch(() => null);
        }
        await db.from("firmware_files").delete().eq("release_id", releaseId);
        await db.from("firmware_releases").delete().eq("id", releaseId);
        return c.json(
          {
            error:
              uploadErr instanceof Error
                ? uploadErr.message
                : "Firmware upload failed before publication.",
          },
          500
        );
      }

      let finalRel = rel as Record<string, unknown>;
      if (publishNow && insertedFiles.length > 0) {
        const publishedAt = new Date().toISOString();
        const { data: pubRow, error: pubErr } = await db
          .from("firmware_releases")
          .update({
            status: "published",
            published_at: publishedAt,
          })
          .eq("id", releaseId)
          .select("*")
          .single();
        if (pubErr || !pubRow) {
          return c.json(
            { error: pubErr?.message ?? "Uploaded binaries, but failed to publish release." },
            500
          );
        }
        finalRel = pubRow as Record<string, unknown>;
      }

      await recordActivity(db, {
        actorUserId: admin.userId,
        category: "admin",
        action: "admin.firmware_uploaded",
        summary: `Uploaded release "${name}" v${version} (${chipFamily}, ${artifacts.map((a) => a.kind).join("+")})`,
      });

      if (publishNow && insertedFiles.length > 0) {
        await syncBoardFirmwareStatuses(db, boardCheck.boardIds).catch(() => null);
        await notifyFirmwareReleasePublished(db, finalRel).catch(() => null);
      }

      return c.json(
        {
          release: { ...finalRel, compatible_boards: boardCheck.boards },
          files: insertedFiles,
        },
        201
      );
    }
  );

  // Attach/replace a USB factory or OTA binary on an existing release
  app.post(
    "/firmware/:id/attach",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const releaseId = c.req.param("id");
      const form = await c.req.formData().catch(() => null);
      if (!form) return c.json({ error: "Multipart form data required." }, 400);

      const rawFile = form.get("file") as unknown;
      if (
        !rawFile ||
        typeof rawFile !== "object" ||
        typeof (rawFile as { arrayBuffer?: unknown }).arrayBuffer !== "function"
      ) {
        return c.json({ error: "Firmware binary file is required." }, 400);
      }

      const fileType = String(form.get("fileType") ?? "").trim() as "ota_app" | "usb_factory";
      if (fileType !== "ota_app" && fileType !== "usb_factory") {
        return c.json({ error: "fileType must be 'ota_app' or 'usb_factory'." }, 400);
      }
      const flashAddress = String(
        form.get("flashAddress") ?? (fileType === "usb_factory" ? "0x0" : "0x20000")
      ).trim();
      if (fileType === "ota_app" && flashAddress === "0x0") {
        return c.json(
          { error: "OTA application-only binary must never target flash offset 0x0." },
          400
        );
      }

      const db = c.get("db");
      const admin = c.get("adminAuth")!;
      const { data: relRow } = await db
        .from("firmware_releases")
        .select("*")
        .eq("id", releaseId)
        .is("deleted_at", null)
        .maybeSingle();
      if (!relRow) return c.json({ error: "Firmware release not found." }, 404);
      const rel = relRow as {
        id: string;
        chip_family: string;
        version: string;
        partition_scheme?: string | null;
        psram_mode?: string | null;
        flash_mode?: string | null;
        flash_freq?: string | null;
        flash_size_mb?: number | null;
      };

      const file = rawFile as { name?: string; arrayBuffer: () => Promise<ArrayBuffer> };
      const bytes = new Uint8Array(await file.arrayBuffer());
      const attachInspect = inspectEspIdfBinary(bytes, fileType, {
        chipFamily: rel.chip_family,
        flashSizeMb: rel.flash_size_mb ?? null,
        bootloaderOffset: defaultBootloaderOffsetForChip(rel.chip_family),
      });
      if (!attachInspect.valid) {
        return c.json(
          {
            error:
              attachInspect.error ??
              (fileType === "usb_factory"
                ? `Invalid ESP-IDF USB factory binary for ${rel.chip_family}.`
                : "Invalid ESP-IDF OTA application binary (missing 0xE9 header)."),
          },
          400
        );
      }

      const flashMode = String(form.get("flashMode") ?? rel.flash_mode ?? "dio").trim();
      const flashFreq = String(form.get("flashFreq") ?? rel.flash_freq ?? "80m").trim();
      const flashSize = String(
        form.get("flashSize") ?? (rel.flash_size_mb ? `${rel.flash_size_mb}MB` : "8MB")
      ).trim();

      const safeName = (file.name ?? `${fileType}.bin`).replace(/[^a-zA-Z0-9._-]/g, "_");
      const r2Key = `releases/${rel.chip_family}/${rel.version}/${releaseId}/${fileType}-${safeName}`;
      const putRes = await putFirmwareObject(c.env ?? {}, r2Key, bytes, {
        releaseId,
        fileType,
        chipFamily: rel.chip_family,
        version: rel.version,
      });

      const { data: fRow, error: fErr } = await db
        .from("firmware_files")
        .insert({
          release_id: releaseId,
          file_type: fileType,
          r2_key: r2Key,
          file_name: safeName,
          size_bytes: putRes.sizeBytes,
          sha256: putRes.sha256,
          flash_address: flashAddress,
          flash_mode: flashMode,
          flash_freq: flashFreq,
          flash_size: flashSize,
          partition_scheme: rel.partition_scheme ?? null,
          psram_mode: rel.psram_mode ?? null,
          validated: true,
        })
        .select("*")
        .single();
      if (fErr) return c.json({ error: fErr.message }, 400);

      const relUpdates =
        fileType === "ota_app" ? { ota_available: true } : { usb_available: true };
      const { data: updatedRel } = await db
        .from("firmware_releases")
        .update(relUpdates)
        .eq("id", releaseId)
        .select("*")
        .single();

      await recordActivity(db, {
        actorUserId: admin.userId,
        category: "admin",
        action: "admin.firmware_artifact_attached",
        summary: `Attached ${fileType} artifact "${safeName}" to release v${rel.version}`,
      });

      return c.json({ release: updatedRel, file: fRow }, 201);
    }
  );

  app.post(
    "/firmware/package",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const form = await c.req.formData().catch(() => null);
      if (!form) return c.json({ error: "Multipart form data required." }, 400);

      const rawPkg = form.get("package") as unknown;
      if (
        !rawPkg ||
        typeof rawPkg !== "object" ||
        typeof (rawPkg as { arrayBuffer?: unknown }).arrayBuffer !== "function"
      ) {
        return c.json({ error: "ZIP release package is required." }, 400);
      }
      const file = rawPkg as { arrayBuffer: () => Promise<ArrayBuffer> };
      const publishNow = String(form.get("publish") ?? "false") === "true";
      const boardIdsFormRaw = form.get("compatibleBoardIds");
      let formBoardIds: string[] = [];
      if (typeof boardIdsFormRaw === "string" && boardIdsFormRaw.trim().length > 0) {
        try {
          const parsedIds = JSON.parse(boardIdsFormRaw);
          if (Array.isArray(parsedIds)) formBoardIds = [...new Set(parsedIds.map(String).filter(Boolean))];
        } catch {
          return c.json({ error: "compatibleBoardIds must be JSON array." }, 400);
        }
      }

      const zipBytes = new Uint8Array(await file.arrayBuffer());
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipSync(zipBytes);
      } catch {
        return c.json({ error: "Uploaded file is not a valid ZIP archive." }, 400);
      }

      // Support manifest.json at root or inside a single top-level directory
      const manifestKey = Object.keys(entries).find(
        (k) => k === "manifest.json" || /^[^/]+\/manifest\.json$/.test(k)
      );
      if (!manifestKey) {
        return c.json({ error: "ZIP release package must contain manifest.json." }, 400);
      }

      const prefix = manifestKey.includes("/")
        ? manifestKey.slice(0, manifestKey.lastIndexOf("/") + 1)
        : "";

      let manifestJson: unknown;
      try {
        manifestJson = JSON.parse(strFromU8(entries[manifestKey]!));
      } catch {
        return c.json({ error: "manifest.json is not valid JSON." }, 400);
      }

      const parsedManifest = packageManifestSchema.safeParse(manifestJson);
      if (!parsedManifest.success) {
        return c.json(
          { error: "manifest.json failed validation.", details: parsedManifest.error.flatten() },
          400
        );
      }

      const m = parsedManifest.data;
      if (m.supports_ble === true && !chipSupportsBle(m.chip_family)) {
        return c.json(
          { error: `Chip family "${m.chip_family}" has no Bluetooth hardware and cannot claim supports_ble=true.` },
          400
        );
      }
      if (
        m.supports_ble_wifi_provisioning === true &&
        (!chipSupportsBle(m.chip_family) || m.chip_family === "esp32h2" || m.supports_wifi === false)
      ) {
        return c.json(
          { error: `Chip family "${m.chip_family}" cannot claim supports_ble_wifi_provisioning=true.` },
          400
        );
      }
      const verifiedArtifacts: Array<{
        spec: (typeof m.files)[number];
        bytes: Uint8Array;
        sha256: string;
      }> = [];

      for (const fSpec of m.files) {
        const entryKey = entries[fSpec.file_name]
          ? fSpec.file_name
          : `${prefix}${fSpec.file_name}`;
        const artifactBytes = entries[entryKey];
        if (!artifactBytes) {
          return c.json(
            { error: `Manifest file "${fSpec.file_name}" is missing from ZIP.` },
            400
          );
        }
        const actualSha = await sha256Hex(artifactBytes);
        if (actualSha.toLowerCase() !== fSpec.sha256.toLowerCase()) {
          return c.json(
            { error: `SHA-256 checksum mismatch for "${fSpec.file_name}".` },
            400
          );
        }
        if (fSpec.file_type === "ota_app" || fSpec.file_type === "usb_factory") {
          if (!isValidEspIdfBinary(artifactBytes, fSpec.file_type, m.chip_family)) {
            return c.json(
              { error: `Invalid ESP-IDF image header for "${fSpec.file_name}".` },
              400
            );
          }
        }
        verifiedArtifacts.push({ spec: fSpec, bytes: artifactBytes, sha256: actualSha });
      }

      const db = c.get("db");
      const admin = c.get("adminAuth")!;

      const manifestFlashSize = m.files.find((f) => f.flash_size)?.flash_size;
      const manifestFlashMode = m.files.find((f) => f.flash_mode)?.flash_mode ?? null;
      const manifestFlashFreq = m.files.find((f) => f.flash_freq)?.flash_freq ?? null;
      const flashSizeMb = parseFlashSizeMb(manifestFlashSize);
      const boardSlugs = m.target_board_slug
        ? Array.from(new Set([...m.compatible_board_slugs, m.target_board_slug]))
        : m.compatible_board_slugs;

      const boardCheck = await resolveAndValidateFirmwareBoards(db, {
        boardIds: formBoardIds,
        boardSlugs,
        chipFamily: m.chip_family,
        flashSizeMb,
        psramMode: m.psram_mode ?? null,
        partitionScheme: m.partition_scheme ?? null,
      });
      if ("error" in boardCheck) {
        return c.json({ error: boardCheck.error }, 400);
      }

      const hasOta = m.files.some((f) => f.file_type === "ota_app");
      const hasUsb = m.files.some((f) => f.file_type === "usb_factory");
      const hardwareVerified =
        Boolean(m.hardware_verified ?? m.verified_on_hardware) ||
        String(form.get("hardwareVerified") ?? "false") === "true";
      const targetBoardSlug =
        m.target_board_slug ??
        (boardCheck.boardSlugs.length === 1 ? boardCheck.boardSlugs[0] : null);

      const supportsBle = m.supports_ble ?? chipSupportsBle(m.chip_family);
      const supportsWifi = m.supports_wifi ?? m.chip_family !== "esp32h2";
      const supportsBleWifi =
        m.supports_ble_wifi_provisioning ??
        (supportsBle && supportsWifi && m.chip_family !== "esp32h2");

      const { data: rel, error: relErr } = await db
        .from("firmware_releases")
        .insert({
          name: m.name,
          version: m.version,
          channel: m.channel,
          chip_family: m.chip_family,
          target_board_slug: targetBoardSlug,
          partition_scheme: m.partition_scheme ?? null,
          psram_mode: m.psram_mode ?? null,
          flash_mode: manifestFlashMode,
          flash_freq: manifestFlashFreq,
          flash_size_mb: flashSizeMb,
          supports_ble: supportsBle,
          supports_ble_wifi_provisioning: supportsBleWifi,
          build_status: m.ci_commit_sha || m.idf_version ? "succeeded" : "manual",
          hardware_verified: hardwareVerified,
          verified_board_ids: hardwareVerified ? boardCheck.boardIds : [],
          verified_board_slugs: hardwareVerified ? boardCheck.boardSlugs : [],
          ci_run_url: m.ci_run_url ?? null,
          ci_commit_sha: m.ci_commit_sha ?? null,
          compatible_board_ids: boardCheck.boardIds,
          compatible_board_slugs: boardCheck.boardSlugs,
          ota_available: hasOta,
          usb_available: hasUsb,
          status: publishNow ? "published" : "draft",
          release_notes: m.release_notes,
          manifest: m,
          created_by: admin.userId,
          published_at: publishNow ? new Date().toISOString() : null,
        })
        .select("*")
        .single();

      if (relErr || !rel) {
        return c.json({ error: relErr?.message ?? "Release creation failed." }, 400);
      }

      const releaseId = (rel as { id: string }).id;
      const insertedFiles: unknown[] = [];

      for (const art of verifiedArtifacts) {
        const safeName = art.spec.file_name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const r2Key = `releases/${m.chip_family}/${m.version}/${releaseId}/${safeName}`;
        await putFirmwareObject(c.env ?? {}, r2Key, art.bytes, {
          releaseId,
          fileType: art.spec.file_type,
          chipFamily: m.chip_family,
          version: m.version,
        });

        const { data: fRow } = await db
          .from("firmware_files")
          .insert({
            release_id: releaseId,
            file_type: art.spec.file_type,
            r2_key: r2Key,
            file_name: safeName,
            size_bytes: art.bytes.byteLength,
            sha256: art.sha256,
            flash_address: art.spec.flash_address ?? null,
            flash_mode: art.spec.flash_mode ?? null,
            flash_freq: art.spec.flash_freq ?? null,
            flash_size: art.spec.flash_size ?? null,
            partition_scheme: m.partition_scheme ?? null,
            psram_mode: m.psram_mode ?? null,
            validated: true,
          })
          .select("*")
          .single();

        if (fRow) insertedFiles.push(fRow);
      }

      await recordActivity(db, {
        actorUserId: admin.userId,
        category: "admin",
        action: "admin.firmware_package_uploaded",
        summary: `Uploaded ZIP firmware release "${m.name}" v${m.version} (${verifiedArtifacts.length} artifacts)`,
      });

      if (publishNow) {
        await syncBoardFirmwareStatuses(db, boardCheck.boardIds).catch(() => null);
        await notifyFirmwareReleasePublished(db, rel as Record<string, unknown>).catch(() => null);
      }

      return c.json(
        {
          release: { ...rel, compatible_boards: boardCheck.boards },
          files: insertedFiles,
        },
        201
      );
    }
  );

  app.post(
    "/firmware/:id/publish",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const db = c.get("db");
      const { data } = await db
        .from("firmware_releases")
        .update({ status: "published", published_at: new Date().toISOString() })
        .eq("id", c.req.param("id"))
        .is("deleted_at", null)
        .select("*")
        .maybeSingle();
      if (!data) return c.json({ error: "Release not found." }, 404);
      const boardIds = Array.isArray((data as { compatible_board_ids?: unknown }).compatible_board_ids)
        ? ((data as { compatible_board_ids: string[] }).compatible_board_ids)
        : undefined;
      await syncBoardFirmwareStatuses(db, boardIds).catch(() => null);
      await notifyFirmwareReleasePublished(db, data as Record<string, unknown>).catch(() => null);
      return c.json({ release: data });
    }
  );

  app.post(
    "/firmware/:id/unpublish",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const db = c.get("db");
      const { data } = await db
        .from("firmware_releases")
        .update({ status: "draft", published_at: null })
        .eq("id", c.req.param("id"))
        .is("deleted_at", null)
        .select("*")
        .maybeSingle();
      if (!data) return c.json({ error: "Release not found." }, 404);
      const boardIds = Array.isArray((data as { compatible_board_ids?: unknown }).compatible_board_ids)
        ? ((data as { compatible_board_ids: string[] }).compatible_board_ids)
        : undefined;
      await syncBoardFirmwareStatuses(db, boardIds).catch(() => null);
      return c.json({ release: data });
    }
  );

  app.post(
    "/firmware/:id/deprecate",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        supersededByReleaseId?: string | null;
        reason?: string | null;
      };
      const db = c.get("db");
      const updates: Record<string, unknown> = { status: "deprecated" };
      if (body.supersededByReleaseId) {
        updates.superseded_by_release_id = body.supersededByReleaseId;
      }
      if (body.reason) {
        updates.verification_notes = body.reason;
      }
      const { data } = await db
        .from("firmware_releases")
        .update(updates)
        .eq("id", c.req.param("id"))
        .is("deleted_at", null)
        .select("*")
        .maybeSingle();
      if (!data) return c.json({ error: "Release not found." }, 404);
      const boardIds = Array.isArray((data as { compatible_board_ids?: unknown }).compatible_board_ids)
        ? ((data as { compatible_board_ids: string[] }).compatible_board_ids)
        : undefined;
      await syncBoardFirmwareStatuses(db, boardIds).catch(() => null);
      return c.json({ release: data });
    }
  );

  app.post(
    "/firmware/:id/verify",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const body = (await c.req.json().catch(() => null)) as {
        hardware_verified?: boolean;
        verified_board_ids?: string[];
        verification_notes?: string | null;
      } | null;
      const db = c.get("db");
      const admin = c.get("adminAuth")!;
      const releaseId = c.req.param("id");

      const { data: existing } = await db
        .from("firmware_releases")
        .select("id,name,version,compatible_board_ids,compatible_board_slugs")
        .eq("id", releaseId)
        .is("deleted_at", null)
        .maybeSingle();
      if (!existing) return c.json({ error: "Release not found." }, 404);
      const rel = existing as {
        id: string;
        name: string;
        version: string;
        compatible_board_ids: string[];
        compatible_board_slugs: string[];
      };

      const verified = body?.hardware_verified ?? true;
      const verifiedBoardIds = verified
        ? body?.verified_board_ids && body.verified_board_ids.length > 0
          ? body.verified_board_ids
          : rel.compatible_board_ids
        : [];
      let verifiedBoardSlugs: string[] = [];
      if (verifiedBoardIds.length > 0) {
        const { data: bRows } = await db
          .from("board_catalog")
          .select("slug")
          .in("id", verifiedBoardIds);
        verifiedBoardSlugs = ((bRows ?? []) as Array<{ slug: string }>).map((b) => b.slug);
      }

      const { data: updated } = await db
        .from("firmware_releases")
        .update({
          hardware_verified: verified,
          verified_board_ids: verifiedBoardIds,
          verified_board_slugs: verifiedBoardSlugs,
          ...(body && "verification_notes" in body
            ? { verification_notes: body.verification_notes ?? null }
            : {}),
        })
        .eq("id", releaseId)
        .select("*")
        .single();

      await syncBoardFirmwareStatuses(
        db,
        Array.from(new Set([...rel.compatible_board_ids, ...verifiedBoardIds]))
      ).catch(() => null);

      await recordActivity(db, {
        actorUserId: admin.userId,
        category: "admin",
        action: verified ? "admin.firmware_verified" : "admin.firmware_unverified",
        summary: `${verified ? "Verified" : "Cleared verification for"} "${rel.name}" v${rel.version}`,
      });

      return c.json({ release: updated });
    }
  );

  app.post(
    "/firmware/:id/rollback",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        targetReleaseId?: string | null;
        reason?: string | null;
      };
      const db = c.get("db");
      const admin = c.get("adminAuth")!;
      const releaseId = c.req.param("id");

      const { data: current } = await db
        .from("firmware_releases")
        .select("id,name,version,chip_family,target_board_slug,compatible_board_ids")
        .eq("id", releaseId)
        .is("deleted_at", null)
        .maybeSingle();
      if (!current) return c.json({ error: "Release not found." }, 404);
      const cur = current as {
        id: string;
        name: string;
        version: string;
        chip_family: string;
        target_board_slug: string | null;
        compatible_board_ids: string[];
      };

      const targetId = body.targetReleaseId ?? null;
      if (targetId) {
        const { data: targetRel } = await db
          .from("firmware_releases")
          .select("id,chip_family,status")
          .eq("id", targetId)
          .is("deleted_at", null)
          .maybeSingle();
        if (!targetRel) return c.json({ error: "Target fallback release not found." }, 404);
        if ((targetRel as { chip_family: string }).chip_family !== cur.chip_family) {
          return c.json({ error: "Rollback release must match chip family." }, 400);
        }
        await db
          .from("firmware_releases")
          .update({
            status: "published",
            published_at: new Date().toISOString(),
            rollback_from_release_id: cur.id,
          })
          .eq("id", targetId);
      }

      const { data: deprecated } = await db
        .from("firmware_releases")
        .update({
          status: "deprecated",
          ...(targetId ? { superseded_by_release_id: targetId } : {}),
          verification_notes: body.reason
            ? `Rolled back: ${body.reason}`
            : "Deprecated via admin release rollback",
        })
        .eq("id", releaseId)
        .select("*")
        .single();

      await syncBoardFirmwareStatuses(db, cur.compatible_board_ids).catch(() => null);

      await recordActivity(db, {
        actorUserId: admin.userId,
        category: "admin",
        action: "admin.firmware_rolled_back",
        summary: `Rolled back release "${cur.name}" v${cur.version}${targetId ? ` to fallback release ${targetId}` : ""}`,
      });

      return c.json({ release: deprecated });
    }
  );

  app.post(
    "/firmware/:id/archive",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const db = c.get("db");
      const { data } = await db
        .from("firmware_releases")
        .update({ status: "archived" })
        .eq("id", c.req.param("id"))
        .is("deleted_at", null)
        .select("*")
        .maybeSingle();
      if (!data) return c.json({ error: "Release not found." }, 404);
      const boardIds = Array.isArray((data as { compatible_board_ids?: unknown }).compatible_board_ids)
        ? ((data as { compatible_board_ids: string[] }).compatible_board_ids)
        : undefined;
      await syncBoardFirmwareStatuses(db, boardIds).catch(() => null);
      return c.json({ release: data });
    }
  );

  app.delete(
    "/firmware/:id",
    requireAdminSession("super_admin"),
    async (c) => {
      const db = c.get("db");
      const releaseId = c.req.param("id");
      const [{ data: files }, { data: relRow }] = await Promise.all([
        db
          .from("firmware_files")
          .select("r2_key")
          .eq("release_id", releaseId),
        db
          .from("firmware_releases")
          .select("compatible_board_ids")
          .eq("id", releaseId)
          .maybeSingle(),
      ]);

      for (const f of (files ?? []) as Array<{ r2_key: string }>) {
        try {
          await deleteFirmwareObject(c.env ?? {}, f.r2_key);
        } catch {
          // Best-effort cleanup
        }
      }

      await db
        .from("firmware_releases")
        .update({ deleted_at: new Date().toISOString(), status: "archived" })
        .eq("id", releaseId);

      const boardIds = Array.isArray((relRow as { compatible_board_ids?: unknown } | null)?.compatible_board_ids)
        ? ((relRow as { compatible_board_ids: string[] }).compatible_board_ids)
        : undefined;
      await syncBoardFirmwareStatuses(db, boardIds).catch(() => null);

      return c.json({ ok: true });
    }
  );

  // ---------------- BOARD CATALOG MANAGEMENT ----------------
  app.get("/boards", async (c) => {
    const db = c.get("db");
    const [boardsRes, gpiosRes, syncRunsRes] = await Promise.all([
      db
        .from("board_catalog")
        .select("*")
        .is("deleted_at", null)
        .order("manufacturer", { ascending: true }),
      db
        .from("board_gpio_definitions")
        .select(
          "board_catalog_id,pin,label,board_pin_name,header_side,header_position,board_note,capabilities,restrictions"
        )
        .not("board_catalog_id", "is", null)
        .order("pin", { ascending: true }),
      db
        .from("board_catalog_sync_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(10),
    ]);

    const gpioByBoard = new Map<string, unknown[]>();
    for (const g of (gpiosRes.data ?? []) as Array<{ board_catalog_id: string }>) {
      const arr = gpioByBoard.get(g.board_catalog_id) ?? [];
      arr.push(g);
      gpioByBoard.set(g.board_catalog_id, arr);
    }

    const boards = ((boardsRes.data ?? []) as Array<Record<string, unknown>>)
      .map(
        (b): Record<string, unknown> => ({
          ...b,
          gpio_definitions: gpioByBoard.get(String(b.id)) ?? [],
        })
      )
      .sort((a, b) => {
        const score = (x: Record<string, unknown>) =>
          (x.firmware_status === "firmware_supported" ? 0 : 10) +
          (x.catalog_category === "official_espressif" ? 0 : x.catalog_category === "partner" ? 1 : 2);
        const diff = score(a) - score(b);
        if (diff !== 0) return diff;
        return String(a.model ?? "").localeCompare(String(b.model ?? ""));
      });

    return c.json({
      boards,
      syncRuns: syncRunsRes.data ?? [],
    });
  });

  app.post(
    "/boards/sync",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const admin = c.get("adminAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};

      const run = await runOfficialCatalogSync({
        db,
        adminUserId: admin.userId,
        syncFetch: deps.syncFetch,
      });

      await recordActivity(db, {
        actorUserId: admin.userId,
        category: "admin",
        action: "admin.boards_synced",
        summary: `Official board catalog sync ${run.status}: ${run.discoveredCount} boards (${run.insertedCount} new, ${run.updatedCount} updated, ${run.needsVerificationCount} awaiting GPIO verification)`,
        metadata: {
          runId: run.runId,
          status: run.status,
          discoveredCount: run.discoveredCount,
          needsVerificationCount: run.needsVerificationCount,
        },
      });

      return c.json({ run });
    }
  );

  app.post(
    "/boards",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = boardCatalogSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: "Invalid board payload." }, 400);

      const spec: BoardProfileSpec = {
        slug: parsed.data.slug,
        manufacturer: parsed.data.manufacturer,
        model: parsed.data.model,
        revision: parsed.data.revision,
        chip_family: parsed.data.chipFamily,
        chip_variant: parsed.data.chipVariant,
        flash_size_mb: parsed.data.flashSizeMb,
        psram_size_mb: parsed.data.psramSizeMb,
        usb_vid: parsed.data.usbVid,
        usb_pid: parsed.data.usbPid,
        verification_status: parsed.data.verificationStatus,
        firmware_status: parsed.data.firmwareStatus,
        gpio_definitions: parsed.data.gpioDefinitions,
      };

      const validation = validateBoardProfileSpec(spec);
      if (!validation.valid) {
        return c.json(
          { error: "Board specification failed validation.", details: validation.errors },
          400
        );
      }

      if (parsed.data.isAvailable) {
        const pubCheck = validateBoardPublicationReady(spec);
        if (!pubCheck.ready) {
          return c.json(
            { error: pubCheck.errors[0] ?? "Board cannot be published until verified.", details: pubCheck.errors },
            400
          );
        }
      }

      const inferredCategory =
        parsed.data.catalogCategory ??
        (spec.manufacturer.toLowerCase().includes("espressif")
          ? "official_espressif"
          : "partner");

      const db = c.get("db");
      const compat = resolveBoardFirmwareCompatibility(spec);
      const { data: board, error } = await db
        .from("board_catalog")
        .insert({
          slug: spec.slug,
          manufacturer: spec.manufacturer,
          model: spec.model,
          revision: spec.revision,
          chip_family: spec.chip_family,
          chip_variant: spec.chip_variant,
          flash_size_mb: spec.flash_size_mb,
          psram_size_mb: spec.psram_size_mb,
          usb_vid: spec.usb_vid ?? null,
          usb_pid: spec.usb_pid ?? null,
          description: parsed.data.description ?? null,
          is_available: parsed.data.isAvailable,
          catalog_category: inferredCategory,
          series: parsed.data.series ?? spec.chip_family.toUpperCase(),
          image_url: parsed.data.imageUrl ?? null,
          docs_url: parsed.data.docsUrl ?? null,
          datasheet_url: parsed.data.datasheetUrl ?? null,
          source_url: parsed.data.sourceUrl ?? null,
          source_provider: "manual",
          verification_status: parsed.data.verificationStatus,
          firmware_status: parsed.data.firmwareStatus,
          partition_scheme: compat.partition_scheme,
          psram_mode: compat.psram_mode,
          flash_mode: compat.flash_mode,
          flash_freq: compat.flash_freq,
          bootloader_offset: compat.bootloader_offset,
          ota_app_offset: compat.ota_app_offset,
          boot_button_gpio: compat.boot_button_gpio,
          usb_interface: compat.usb_interface,
          supports_wifi: compat.supports_wifi,
          supports_ble: compat.supports_ble,
          supports_ble_wifi_provisioning: compat.supports_ble_wifi_provisioning,
          supports_ota_rollback: compat.supports_ota_rollback,
          firmware_compat_key: compat.firmware_compat_key,
          connectivity_note: compat.connectivity_note,
          revision_notes: parsed.data.revisionNotes ?? null,
          board_layout: parsed.data.boardLayout ?? {},
        })
        .select("*")
        .single();

      if (error || !board) return c.json({ error: error?.message ?? "Board insert failed." }, 400);

      const boardId = (board as { id: string }).id;
      await db.from("board_gpio_definitions").insert(
        spec.gpio_definitions.map((g) => ({
          board_catalog_id: boardId,
          pin: g.pin,
          label: g.label,
          board_pin_name: g.board_pin_name ?? null,
          header_side: g.header_side ?? null,
          header_position: g.header_position ?? null,
          board_note: g.board_note ?? null,
          capabilities: g.capabilities,
          restrictions: g.restrictions,
        }))
      );

      return c.json({ board }, 201);
    }
  );

  app.delete(
    "/boards/:id",
    requireAdminSession("super_admin"),
    async (c) => {
      const db = c.get("db");
      await db
        .from("board_catalog")
        .update({ deleted_at: new Date().toISOString(), is_available: false })
        .eq("id", c.req.param("id"));
      return c.json({ ok: true });
    }
  );

  // ---------------- EMQX MANAGEMENT ----------------
  app.get("/emqx/status", async (c) => {
    const db = c.get("db");
    const deps = c.get("deps") ?? {};
    const { data: credentials } = await db
      .from("mqtt_credentials_metadata")
      .select("id,account_id,controller_id,mqtt_username,mqtt_client_id,topic_prefix,emqx_synced,status,last_rotated_at,revoked_at")
      .order("created_at", { ascending: false })
      .limit(100);

    let brokerStatus: Record<string, unknown> = { configured: false, connected: false };
    let liveClients: unknown[] = [];

    if (isEmqxConfigured(c.env ?? {})) {
      const emqx = new EmqxClient(c.env!, deps.emqxFetch);
      const check = await emqx.checkConnection();
      brokerStatus = {
        configured: true,
        connected: check.connected,
        brokerHost: c.env?.EMQX_BROKER_HOST,
        tlsPort: Number(c.env?.EMQX_TLS_PORT ?? 8883),
        error: check.error,
      };
      if (!check.connected) {
        await emitNotification(db, {
          scope: "admin",
          category: "system",
          eventKey: "admin.service_health",
          preferenceKey: "service_health_alerts",
          severity: "warning",
          title: "EMQX Broker Connection Failed",
          message: check.error ?? "Unable to query EMQX management API.",
          dedupKey: "admin:health:emqx",
          dedupWindowSeconds: 1800,
        }).catch(() => null);
      }
      if (check.connected) {
        try {
          const clientsRes = await emqx.listClients(1, 50);
          liveClients = clientsRes.data;
        } catch {
          liveClients = [];
        }
      }
    }

    return c.json({
      brokerStatus,
      liveClients,
      credentials: credentials ?? [],
    });
  });

  app.post(
    "/emqx/credentials/:controllerId/revoke",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const db = c.get("db");
      const deps = c.get("deps") ?? {};
      const controllerId = c.req.param("controllerId");

      const { data: cred } = await db
        .from("mqtt_credentials_metadata")
        .select("id,account_id,mqtt_username,mqtt_client_id")
        .eq("controller_id", controllerId)
        .maybeSingle();

      if (!cred) return c.json({ error: "Credentials not found." }, 404);
      const row = cred as {
        id: string;
        account_id: string;
        mqtt_username: string;
        mqtt_client_id: string;
      };

      if (isEmqxConfigured(c.env ?? {})) {
        const emqx = new EmqxClient(c.env!, deps.emqxFetch);
        await emqx.revokeControllerCredentials(row.mqtt_username, row.mqtt_client_id);
      }

      await db
        .from("mqtt_credentials_metadata")
        .update({ status: "revoked", revoked_at: new Date().toISOString() })
        .eq("id", row.id);

      await db
        .from("controllers")
        .update({ status: "disconnected", mqtt_connected: false })
        .eq("id", controllerId);

      return c.json({ ok: true });
    }
  );

  // ---------------- USAGE & MONITORING (REAL PROVIDER METRICS ONLY) ----------------
  app.get("/usage", async (c) => {
    const db = c.get("db");
    const deps = c.get("deps") ?? {};
    const emqxReady = isEmqxConfigured(c.env ?? {});
    const emqx = emqxReady ? new EmqxClient(c.env!, deps.emqxFetch) : null;

    const [r2Health, emqxMetrics, clientsRes, acctRes, ctrlRes, devRes, fileRes] =
      await Promise.all([
        checkR2Health(c.env ?? {}),
        emqx ? emqx.getMetrics().catch(() => null) : Promise.resolve(null),
        emqx ? emqx.listClients(1, 1).catch(() => null) : Promise.resolve(null),
        db.from("accounts").select("id", { count: "exact", head: true }).is("deleted_at", null),
        db.from("controllers").select("id", { count: "exact", head: true }).is("deleted_at", null),
        db.from("devices").select("id", { count: "exact", head: true }).is("deleted_at", null),
        db.from("firmware_files").select("size_bytes"),
      ]);

    const activeMqttConnections: number | null = clientsRes
      ? (clientsRes.meta?.count ?? clientsRes.data.length)
      : null;

    const firmwareDbBytes = ((fileRes.data ?? []) as Array<{ size_bytes: number }>).reduce(
      (sum, f) => sum + Number(f.size_bytes ?? 0),
      0
    );

    const r2TotalBytes = r2Health.totalBytes ?? firmwareDbBytes;
    const freeTierLimitBytes = 10 * 1024 * 1024 * 1024;
    if (r2Health.status === "failed" || r2TotalBytes / freeTierLimitBytes >= 0.8) {
      await emitNotification(db, {
        scope: "admin",
        category: "system",
        eventKey: "admin.service_health",
        preferenceKey: "service_health_alerts",
        severity: r2Health.status === "failed" ? "danger" : "warning",
        title:
          r2Health.status === "failed"
            ? "R2 Firmware Bucket Unavailable"
            : "R2 Storage Approaching Free Tier Quota",
        message:
          r2Health.status === "failed"
            ? r2Health.error ?? "R2 firmware bucket error."
            : `Firmware storage reached ${(r2TotalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB of 10 GB.`,
        dedupKey: "admin:health:r2",
        dedupWindowSeconds: 1800,
      }).catch(() => null);
    }

    return c.json({
      database: {
        accounts: acctRes.count ?? 0,
        controllers: ctrlRes.count ?? 0,
        devices: devRes.count ?? 0,
      },
      r2: {
        status: r2Health.status,
        objectCount: r2Health.objectCount ?? null,
        totalBytes: r2TotalBytes,
        freeTierLimitBytes, // 10 GB Cloudflare R2 free tier
      },
      emqx: {
        configured: isEmqxConfigured(c.env ?? {}),
        activeConnections: activeMqttConnections,
        serverlessMaxConnections: 1000,
        metrics: emqxMetrics,
      },
    });
  });

  // ---------------- PLATFORM SETTINGS ----------------
  app.get("/settings", async (c) => {
    const db = c.get("db");
    const { data } = await db
      .from("platform_settings")
      .select("*")
      .eq("id", 1)
      .single();
    return c.json({ settings: data });
  });

  app.patch(
    "/settings",
    requireAdminSession("super_admin"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = platformSettingsPatchSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid platform settings.", details: parsed.error.flatten() },
          400
        );
      }

      if (
        parsed.data.default_timezone !== undefined &&
        !isValidIanaTimezone(parsed.data.default_timezone)
      ) {
        return c.json(
          { error: "Invalid default_timezone IANA time zone identifier." },
          400
        );
      }

      const admin = c.get("adminAuth")!;
      const db = c.get("db");

      const { data, error } = await db
        .from("platform_settings")
        .update({
          ...parsed.data,
          updated_by: admin.userId,
        })
        .eq("id", 1)
        .select("*")
        .single();

      if (error) return c.json({ error: error.message }, 400);

      await recordActivity(db, {
        actorUserId: admin.userId,
        category: "admin",
        action: "admin.settings_updated",
        summary: "Updated platform settings",
      });

      return c.json({ settings: data });
    }
  );

  // Additional Admin management endpoints
  app.get("/accounts/:id/controllers", async (c) => {
    const db = c.get("db");
    const { data } = await db
      .from("controllers")
      .select("*")
      .eq("account_id", c.req.param("id"))
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    return c.json({ controllers: data ?? [] });
  });

  app.patch(
    "/staff/:staffId",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const body = await c.req.json().catch(() => null) as {
        role?: string;
        status?: string;
      } | null;
      const db = c.get("db");
      const updates: Record<string, unknown> = {};
      if (body?.role && ["owner", "administrator", "operator", "viewer"].includes(body.role)) {
        updates.role = body.role;
      }
      if (body?.status && ["active", "suspended"].includes(body.status)) {
        updates.status = body.status;
      }
      const { data } = await db
        .from("staff")
        .update(updates)
        .eq("id", c.req.param("staffId"))
        .select("*")
        .maybeSingle();
      if (!data) return c.json({ error: "Staff member not found." }, 404);
      return c.json({ staff: data });
    }
  );

  app.delete(
    "/staff/:staffId",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const db = c.get("db");
      await db.from("staff").delete().eq("id", c.req.param("staffId"));
      return c.json({ ok: true });
    }
  );

  app.patch(
    "/platform-staff/:id",
    requireAdminSession("super_admin"),
    async (c) => {
      const body = await c.req.json().catch(() => null) as {
        role?: string;
        status?: string;
      } | null;
      const db = c.get("db");
      const updates: Record<string, unknown> = {};
      if (body?.role && ["super_admin", "operator", "support"].includes(body.role)) {
        updates.role = body.role;
      }
      if (body?.status && ["active", "suspended"].includes(body.status)) {
        updates.status = body.status;
      }
      const { data } = await db
        .from("platform_staff")
        .update(updates)
        .eq("id", c.req.param("id"))
        .select("*")
        .maybeSingle();
      if (!data) return c.json({ error: "Platform staff member not found." }, 404);
      return c.json({ platformStaff: data });
    }
  );

  app.patch(
    "/boards/:id",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const body = (await c.req.json().catch(() => null)) as {
        is_available?: boolean;
        description?: string;
        verification_status?: "verified" | "needs_verification";
        firmware_status?:
          | "firmware_supported"
          | "catalog_only"
          | "build_pending"
          | "unsupported";
        catalog_category?: "official_espressif" | "partner" | "custom";
        image_url?: string | null;
        docs_url?: string | null;
        revision_notes?: string | null;
        gpio_definitions?: BoardProfileSpec["gpio_definitions"];
      } | null;
      const db = c.get("db");
      const boardId = c.req.param("id");

      const { data: currentBoard } = await db
        .from("board_catalog")
        .select("*")
        .eq("id", boardId)
        .is("deleted_at", null)
        .maybeSingle();

      if (!currentBoard) return c.json({ error: "Board not found." }, 404);
      const cur = currentBoard as Record<string, unknown>;

      const { data: existingGpios } = await db
        .from("board_gpio_definitions")
        .select(
          "pin,label,board_pin_name,header_side,header_position,board_note,capabilities,restrictions"
        )
        .eq("board_catalog_id", boardId)
        .order("pin", { ascending: true });

      const nextGpios = Array.isArray(body?.gpio_definitions)
        ? body!.gpio_definitions
        : ((existingGpios ?? []) as BoardProfileSpec["gpio_definitions"]);

      const nextVerificationStatus =
        body?.verification_status ??
        (cur.verification_status as "verified" | "needs_verification" | undefined) ??
        "needs_verification";
      const nextIsAvailable =
        typeof body?.is_available === "boolean"
          ? body.is_available
          : Boolean(cur.is_available);

      if (nextIsAvailable) {
        const check = validateBoardPublicationReady({
          slug: String(cur.slug),
          manufacturer: String(cur.manufacturer),
          model: String(cur.model),
          revision: String(cur.revision),
          chip_family: cur.chip_family as BoardProfileSpec["chip_family"],
          chip_variant: String(cur.chip_variant),
          flash_size_mb: Number(cur.flash_size_mb),
          psram_size_mb: Number(cur.psram_size_mb),
          verification_status: nextVerificationStatus,
          gpio_definitions: nextGpios,
        });
        if (!check.ready) {
          return c.json(
            {
              error:
                check.errors[0] ??
                "Board cannot be published until pin definitions are verified.",
              details: check.errors,
            },
            400
          );
        }
      }

      const updates: Record<string, unknown> = {};
      if (typeof body?.is_available === "boolean") updates.is_available = body.is_available;
      if (typeof body?.description === "string") updates.description = body.description;
      if (
        body?.verification_status === "verified" ||
        body?.verification_status === "needs_verification"
      ) {
        updates.verification_status = body.verification_status;
      }
      if (
        body?.firmware_status &&
        ["firmware_supported", "catalog_only", "build_pending", "unsupported"].includes(
          body.firmware_status
        )
      ) {
        updates.firmware_status = body.firmware_status;
      }
      if (
        body?.catalog_category &&
        ["official_espressif", "partner", "custom"].includes(body.catalog_category)
      ) {
        updates.catalog_category = body.catalog_category;
      }
      if (body && "image_url" in body) updates.image_url = body.image_url ?? null;
      if (body && "docs_url" in body) updates.docs_url = body.docs_url ?? null;
      if (body && "revision_notes" in body) {
        updates.revision_notes = body.revision_notes ?? null;
      }

      if (Array.isArray(body?.gpio_definitions)) {
        await db.from("board_gpio_definitions").delete().eq("board_catalog_id", boardId);
        if (body.gpio_definitions.length > 0) {
          await db.from("board_gpio_definitions").insert(
            body.gpio_definitions.map((g) => ({
              board_catalog_id: boardId,
              pin: g.pin,
              label: g.label,
              board_pin_name: g.board_pin_name ?? null,
              header_side: g.header_side ?? null,
              header_position: g.header_position ?? null,
              board_note: g.board_note ?? null,
              capabilities: g.capabilities,
              restrictions: g.restrictions,
            }))
          );
        }
      }

      const { data } =
        Object.keys(updates).length > 0
          ? await db
              .from("board_catalog")
              .update(updates)
              .eq("id", boardId)
              .is("deleted_at", null)
              .select("*")
              .maybeSingle()
          : { data: currentBoard };

      if (!data) return c.json({ error: "Board not found." }, 404);
      return c.json({ board: data });
    }
  );

  app.patch(
    "/firmware/:id",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const body = await c.req.json().catch(() => null) as {
        channel?: string;
        release_notes?: string;
        compatible_board_ids?: string[];
        target_board_slug?: string | null;
        partition_scheme?: PartitionScheme | null;
        psram_mode?: PsramMode | null;
        hardware_verified?: boolean;
        verification_notes?: string | null;
      } | null;
      const db = c.get("db");
      const releaseId = c.req.param("id");
      const updates: Record<string, unknown> = {};
      if (body?.channel && ["stable", "beta", "development"].includes(body.channel)) {
        updates.channel = body.channel;
      }
      if (typeof body?.release_notes === "string") updates.release_notes = body.release_notes;
      if (body && "target_board_slug" in body) {
        updates.target_board_slug = body.target_board_slug ?? null;
      }
      if (
        body?.partition_scheme &&
        ["dual_ota_4mb", "dual_ota_8mb", "dual_ota_16mb", "dual_ota_32mb"].includes(
          body.partition_scheme
        )
      ) {
        updates.partition_scheme = body.partition_scheme;
      }
      if (body?.psram_mode && ["none", "quad", "octal"].includes(body.psram_mode)) {
        updates.psram_mode = body.psram_mode;
      }
      if (typeof body?.hardware_verified === "boolean") {
        updates.hardware_verified = body.hardware_verified;
      }
      if (body && "verification_notes" in body) {
        updates.verification_notes = body.verification_notes ?? null;
      }

      if (Array.isArray(body?.compatible_board_ids)) {
        const { data: rel } = await db
          .from("firmware_releases")
          .select("id,chip_family,partition_scheme,psram_mode,flash_size_mb")
          .eq("id", releaseId)
          .is("deleted_at", null)
          .maybeSingle();
        if (!rel) return c.json({ error: "Release not found." }, 404);
        const relMeta = rel as {
          chip_family: string;
          partition_scheme?: PartitionScheme | null;
          psram_mode?: PsramMode | null;
          flash_size_mb?: number | null;
        };

        const { data: relFiles } = await db
          .from("firmware_files")
          .select("flash_size")
          .eq("release_id", releaseId);
        const flashSizeStr = ((relFiles ?? []) as Array<{ flash_size?: string | null }>).find(
          (f) => f.flash_size
        )?.flash_size;

        const boardCheck = await resolveAndValidateFirmwareBoards(db, {
          boardIds: body.compatible_board_ids,
          chipFamily: relMeta.chip_family,
          flashSizeMb: relMeta.flash_size_mb ?? parseFlashSizeMb(flashSizeStr),
          psramMode: body?.psram_mode ?? relMeta.psram_mode ?? null,
          partitionScheme: body?.partition_scheme ?? relMeta.partition_scheme ?? null,
        });
        if ("error" in boardCheck) {
          return c.json({ error: boardCheck.error }, 400);
        }
        updates.compatible_board_ids = boardCheck.boardIds;
        updates.compatible_board_slugs = boardCheck.boardSlugs;
        if (typeof body?.hardware_verified === "boolean") {
          updates.verified_board_ids = body.hardware_verified ? boardCheck.boardIds : [];
          updates.verified_board_slugs = body.hardware_verified ? boardCheck.boardSlugs : [];
        }
      }

      const { data } = await db
        .from("firmware_releases")
        .update(updates)
        .eq("id", releaseId)
        .is("deleted_at", null)
        .select("*")
        .maybeSingle();
      if (!data) return c.json({ error: "Release not found." }, 404);

      if (
        typeof body?.hardware_verified === "boolean" ||
        Array.isArray(body?.compatible_board_ids)
      ) {
        const boardIds = Array.isArray((data as { compatible_board_ids?: unknown }).compatible_board_ids)
          ? ((data as { compatible_board_ids: string[] }).compatible_board_ids)
          : undefined;
        await syncBoardFirmwareStatuses(db, boardIds).catch(() => null);
      }

      return c.json({ release: data });
    }
  );

  app.post(
    "/emqx/clients/:clientId/kick",
    requireAdminSession("super_admin", "operator"),
    async (c) => {
      const deps = c.get("deps") ?? {};
      if (!isEmqxConfigured(c.env ?? {})) {
        return c.json({ error: "EMQX is not configured." }, 503);
      }
      const emqx = new EmqxClient(c.env!, deps.emqxFetch);
      await emqx.kickClient(c.req.param("clientId"));
      return c.json({ ok: true });
    }
  );

  return app;
}

async function resolveAndValidateFirmwareBoards(
  db: DbClient,
  opts: {
    boardIds?: string[];
    boardSlugs?: string[];
    chipFamily: string;
    flashSizeMb: number | null;
    psramMode?: PsramMode | null;
    partitionScheme?: PartitionScheme | null;
  }
): Promise<
  | {
      boardIds: string[];
      boardSlugs: string[];
      boards: FirmwareCompatibleBoardItem[];
    }
  | { error: string }
> {
  const uniqueIds = [...new Set((opts.boardIds ?? []).filter(Boolean))];
  const uniqueSlugs = [...new Set((opts.boardSlugs ?? []).filter(Boolean))];

  if (uniqueIds.length === 0 && uniqueSlugs.length === 0) {
    return { boardIds: [], boardSlugs: [], boards: [] };
  }

  const foundMap = new Map<string, FirmwareCompatibleBoardItem>();

  if (uniqueIds.length > 0) {
    const { data: rowsById } = await db
      .from("board_catalog")
      .select(
        "id,slug,manufacturer,model,chip_family,chip_variant,flash_size_mb,psram_size_mb,psram_mode,partition_scheme,flash_mode,flash_freq,bootloader_offset,ota_app_offset,boot_button_gpio,supports_wifi,supports_ble,supports_ble_wifi_provisioning,firmware_status,verification_status"
      )
      .in("id", uniqueIds)
      .is("deleted_at", null);
    for (const b of (rowsById ?? []) as FirmwareCompatibleBoardItem[]) {
      foundMap.set(b.id, b);
    }
    const missing = uniqueIds.filter((id) => !foundMap.has(id));
    if (missing.length > 0) {
      return { error: "One or more selected compatible boards no longer exist in the catalog." };
    }
  }

  if (uniqueSlugs.length > 0) {
    const { data: rowsBySlug } = await db
      .from("board_catalog")
      .select(
        "id,slug,manufacturer,model,chip_family,chip_variant,flash_size_mb,psram_size_mb,psram_mode,partition_scheme,flash_mode,flash_freq,bootloader_offset,ota_app_offset,boot_button_gpio,supports_wifi,supports_ble,supports_ble_wifi_provisioning,firmware_status,verification_status"
      )
      .in("slug", uniqueSlugs)
      .is("deleted_at", null);
    for (const b of (rowsBySlug ?? []) as FirmwareCompatibleBoardItem[]) {
      foundMap.set(b.id, b);
    }
  }

  const boards = Array.from(foundMap.values());
  const unsupported = boards.find((b) => b.firmware_status === "unsupported");
  if (unsupported) {
    return {
      error: `Board "${unsupported.manufacturer} ${unsupported.model}" is marked unsupported and cannot be assigned firmware releases.`,
    };
  }

  const schemeMinFlash =
    opts.partitionScheme === "dual_ota_32mb"
      ? 32
      : opts.partitionScheme === "dual_ota_16mb"
        ? 16
        : opts.partitionScheme === "dual_ota_8mb"
          ? 8
          : opts.partitionScheme === "dual_ota_4mb"
            ? 4
            : null;
  const effectiveFlashMb = Math.max(opts.flashSizeMb ?? 0, schemeMinFlash ?? 0) || null;

  const validation = validateFirmwareBoardsCompatibility({
    chipFamily: opts.chipFamily,
    flashSizeMb: effectiveFlashMb,
    psramMode: opts.psramMode,
    boards,
  });

  if (!validation.valid) {
    return { error: validation.errors[0] ?? "Selected compatible boards are incompatible with this firmware." };
  }

  return {
    boardIds: boards.map((b) => b.id),
    boardSlugs: boards.map((b) => b.slug),
    boards,
  };
}

async function loadCompatibleBoardMap(
  db: DbClient,
  releases: Array<{ compatible_board_ids?: string[] }>
): Promise<Map<string, FirmwareCompatibleBoardItem>> {
  const allBoardIds = new Set<string>();
  for (const r of releases) {
    for (const bid of r.compatible_board_ids ?? []) {
      if (bid) allBoardIds.add(bid);
    }
  }
  const boardLookup = new Map<string, FirmwareCompatibleBoardItem>();
  if (allBoardIds.size > 0) {
    const { data: boards } = await db
      .from("board_catalog")
      .select(
        "id,slug,manufacturer,model,chip_family,chip_variant,flash_size_mb,psram_size_mb,psram_mode,partition_scheme,supports_wifi,supports_ble,supports_ble_wifi_provisioning"
      )
      .in("id", Array.from(allBoardIds))
      .is("deleted_at", null);
    for (const b of (boards ?? []) as FirmwareCompatibleBoardItem[]) {
      boardLookup.set(b.id, b);
    }
  }
  return boardLookup;
}

async function notifyFirmwareReleasePublished(
  db: DbClient,
  rel: Record<string, unknown>
): Promise<void> {
  const releaseId = String(rel.id);
  const name = String(rel.name ?? "Firmware");
  const version = String(rel.version ?? "");
  const channel = String(rel.channel ?? "stable");
  const chipFamily = String(rel.chip_family ?? "");
  const otaAvailable = Boolean(rel.ota_available);
  const compatIds = Array.isArray(rel.compatible_board_ids)
    ? (rel.compatible_board_ids as string[])
    : [];

  await emitNotification(db, {
    scope: "admin",
    category: "firmware",
    eventKey: "admin.firmware_published",
    preferenceKey: "firmware_publishing",
    severity: "success",
    title: `Firmware Published: ${name} v${version}`,
    message: `Published ${channel} release for ${chipFamily}${
      compatIds.length > 0 ? ` (${compatIds.length} board target(s))` : " (all chip-compatible boards)"
    }.`,
    dedupKey: `admin:fw_pub:${releaseId}`,
    dedupWindowSeconds: 86400,
    metadata: { releaseId, version, channel, chipFamily },
  });

  if (!otaAvailable) return;

  const [ctrlRes, catRes, custRes] = await Promise.all([
    db
      .from("controllers")
      .select("id,account_id,name,board_catalog_id,custom_board_id,firmware_version")
      .is("deleted_at", null)
      .is("permanently_deleted_at", null),
    db
      .from("board_catalog")
      .select(
        "id,slug,manufacturer,model,revision,chip_family,chip_variant,flash_size_mb,psram_size_mb,firmware_status,partition_scheme,psram_mode,flash_mode,flash_freq,bootloader_offset,ota_app_offset,boot_button_gpio,usb_interface,supports_wifi,supports_ota_rollback,firmware_compat_key"
      )
      .is("deleted_at", null),
    db
      .from("custom_boards")
      .select(
        "id,slug,manufacturer,model,revision,chip_family,chip_variant,flash_size_mb,psram_size_mb,partition_scheme,psram_mode,flash_mode,flash_freq,bootloader_offset,ota_app_offset,boot_button_gpio,usb_interface,supports_wifi,supports_ota_rollback,firmware_compat_key"
      )
      .is("deleted_at", null),
  ]);

  const catBoards = new Map(
    ((catRes.data ?? []) as CompatBoardRecord[]).map((b) => [
      b.id,
      { ...b, ...resolveBoardFirmwareCompatibility(b) },
    ])
  );
  const custBoards = new Map(
    ((custRes.data ?? []) as CompatBoardRecord[]).map((b) => [
      b.id,
      { ...b, ...resolveBoardFirmwareCompatibility(b), firmware_status: "custom" },
    ])
  );

  const releaseCompatMeta = {
    chip_family: chipFamily,
    status: String(rel.status ?? "published"),
    target_board_slug: (rel.target_board_slug as string | null | undefined) ?? null,
    compatible_board_ids: compatIds,
    compatible_board_slugs: Array.isArray(rel.compatible_board_slugs)
      ? (rel.compatible_board_slugs as string[])
      : [],
    partition_scheme: (rel.partition_scheme as string | null | undefined) ?? null,
    psram_mode: (rel.psram_mode as string | null | undefined) ?? null,
    flash_size_mb:
      typeof rel.flash_size_mb === "number" ? rel.flash_size_mb : null,
  };

  const accountMatches = new Map<string, string[]>();
  for (const c of (ctrlRes.data ?? []) as Array<{
    id: string;
    account_id: string;
    name: string;
    board_catalog_id: string | null;
    custom_board_id: string | null;
    firmware_version: string | null;
  }>) {
    const board = c.board_catalog_id
      ? catBoards.get(c.board_catalog_id) ?? null
      : c.custom_board_id
        ? custBoards.get(c.custom_board_id) ?? null
        : null;
    if (!board) continue;
    const compatCheck = checkControllerReleaseCompatibility({
      board,
      release: releaseCompatMeta,
      requirePublished: false,
    });
    if (!compatCheck.compatible) continue;
    if (!isNewerFirmwareVersion(version, c.firmware_version)) continue;

    const list = accountMatches.get(c.account_id) ?? [];
    list.push(c.name);
    accountMatches.set(c.account_id, list);
  }

  for (const [accountId, ctrlNames] of accountMatches.entries()) {
    await emitNotification(db, {
      scope: "user",
      accountId,
      category: "firmware",
      eventKey: "firmware.update_available",
      preferenceKey: "firmware_updates",
      severity: "info",
      title: `Firmware Update Available: v${version}`,
      message: `${name} v${version} (${channel}) is ready for ${ctrlNames.join(", ")}.`,
      dedupKey: `fw_avail:${accountId}:${releaseId}`,
      dedupWhileUnread: true,
      metadata: { releaseId, version, controllers: ctrlNames },
    });
  }
}

