import { Hono } from "hono";
import { z } from "zod";
import { recordActivity } from "../lib/audit";
import {
  generateRandomToken,
  hashPassword,
  sha256Hex,
} from "../lib/crypto";
import { EmqxClient, isEmqxConfigured } from "../lib/emqx";
import { requireStaffRole, requireUserSession } from "../middleware/auth";
import type { AppEnv } from "../types/context";

const updateAccountSchema = z.object({
  name: z.string().trim().min(2).max(120),
});

const requestDeletionSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

const createInviteSchema = z.object({
  role: z.enum(["administrator", "operator", "viewer"]),
  invitedEmail: z.string().trim().email().max(200).optional(),
  expiresInHours: z.number().int().min(1).max(168).default(48),
  maxUses: z.number().int().min(1).max(20).default(1),
});

const addDirectStaffSchema = z.object({
  email: z.string().trim().email().max(200),
  fullName: z.string().trim().min(2).max(120),
  password: z.string().min(8).max(256),
  role: z.enum(["administrator", "operator", "viewer"]),
});

const updateStaffSchema = z.object({
  role: z.enum(["owner", "administrator", "operator", "viewer"]).optional(),
  fullName: z.string().trim().min(2).max(120).optional(),
});

export function createAccountRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/", requireUserSession({ allowPausedAccount: true }), async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");

    const { data } = await db
      .from("accounts")
      .select("id,name,slug,status,paused_at,deletion_requested_at,created_at")
      .eq("id", auth.accountId)
      .single();

    return c.json({ account: data });
  });

  app.patch(
    "/",
    requireUserSession(),
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = updateAccountSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Account name must be 2-120 characters." }, 400);
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");

      const { data, error } = await db
        .from("accounts")
        .update({ name: parsed.data.name })
        .eq("id", auth.accountId)
        .select("id,name,slug,status")
        .single();

      if (error) return c.json({ error: error.message }, 400);

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        category: "account",
        action: "account.updated",
        summary: `Account renamed to "${parsed.data.name}"`,
      });

      return c.json({ account: data });
    }
  );

  app.post(
    "/pause",
    requireUserSession(),
    requireStaffRole("owner"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");

      await db
        .from("accounts")
        .update({ status: "paused", paused_at: new Date().toISOString() })
        .eq("id", auth.accountId);

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        category: "account",
        action: "account.paused",
        summary: "Account paused by owner",
      });

      return c.json({ ok: true, status: "paused" });
    }
  );

  app.post(
    "/request-deletion",
    requireUserSession(),
    requireStaffRole("owner"),
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const parsed = requestDeletionSchema.safeParse(body);
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};

      // Revoke active MQTT credentials for account controllers
      const { data: creds } = await db
        .from("mqtt_credentials_metadata")
        .select("id,mqtt_username,mqtt_client_id,status")
        .eq("account_id", auth.accountId)
        .eq("status", "active");

      const emqxReady = isEmqxConfigured(c.env ?? {});
      const emqx = emqxReady ? new EmqxClient(c.env!, deps.emqxFetch) : null;

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
            // Continue revoking DB records cleanly even if broker is unreachable
          }
        }
        await db
          .from("mqtt_credentials_metadata")
          .update({ status: "revoked", revoked_at: new Date().toISOString() })
          .eq("id", cred.id);
      }

      await db
        .from("accounts")
        .update({
          status: "pending_deletion",
          deletion_requested_at: new Date().toISOString(),
          deletion_reason: parsed.success ? (parsed.data.reason ?? null) : null,
        })
        .eq("id", auth.accountId);

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        category: "account",
        action: "account.deletion_requested",
        summary: "Account deletion requested; MQTT credentials revoked",
      });

      return c.json({ ok: true, status: "pending_deletion" });
    }
  );

  // Staff listing
  app.get("/staff", requireUserSession(), async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");

    const { data: staffRows } = await db
      .from("staff")
      .select("id,account_id,user_id,role,status,created_at,updated_at")
      .eq("account_id", auth.accountId)
      .order("created_at", { ascending: true });

    const rows = (staffRows ?? []) as Array<{
      id: string;
      user_id: string;
      role: string;
      status: string;
      created_at: string;
    }>;

    const userIds = rows.map((r) => r.user_id);
    let userMap = new Map<string, { email: string; full_name: string; last_login_at: string | null }>();
    if (userIds.length > 0) {
      const { data: usersData } = await db
        .from("users")
        .select("id,email,full_name,last_login_at")
        .in("id", userIds)
        .eq("user_kind", "customer")
        .is("deleted_at", null);

      userMap = new Map(
        ((usersData ?? []) as Array<{
          id: string;
          email: string;
          full_name: string;
          last_login_at: string | null;
        }>).map((u) => [u.id, u])
      );
    }

    const staff = rows.map((r) => {
      const u = userMap.get(r.user_id);
      return {
        id: r.id,
        userId: r.user_id,
        email: u?.email ?? "",
        fullName: u?.full_name ?? "Unknown User",
        role: r.role,
        status: r.status,
        lastLoginAt: u?.last_login_at ?? null,
        createdAt: r.created_at,
      };
    });

    return c.json({ staff });
  });

  // Directly provision a customer staff user (for teams that prefer adding members without waiting)
  app.post(
    "/staff",
    requireUserSession(),
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = addDirectStaffSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid staff member fields.", details: parsed.error.flatten() },
          400
        );
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const email = parsed.data.email.toLowerCase();

      if (parsed.data.role === "administrator" && auth.staffRole !== "owner") {
        return c.json(
          { error: "Only the account owner can add administrator staff." },
          403
        );
      }

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
        const passwordHash = await hashPassword(parsed.data.password);
        const { data: createdUser, error: uErr } = await db
          .from("users")
          .insert({
            email,
            user_kind: "customer",
            password_hash: passwordHash,
            full_name: parsed.data.fullName,
            status: "active",
          })
          .select("id")
          .single();

        if (uErr || !createdUser) {
          return c.json({ error: uErr?.message ?? "Failed to create staff user." }, 400);
        }
        userId = (createdUser as { id: string }).id;
      }

      const { data: existingMembership } = await db
        .from("staff")
        .select("id")
        .eq("account_id", auth.accountId)
        .eq("user_id", userId)
        .maybeSingle();

      if (existingMembership) {
        return c.json({ error: "User is already staff on this account." }, 409);
      }

      const { data: staffRow, error: sErr } = await db
        .from("staff")
        .insert({
          account_id: auth.accountId,
          user_id: userId,
          role: parsed.data.role,
          status: "active",
          invited_by: auth.userId,
        })
        .select("*")
        .single();

      if (sErr) return c.json({ error: sErr.message }, 400);

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        category: "staff",
        action: "staff.added",
        summary: `Added ${email} as ${parsed.data.role}`,
      });

      return c.json({ staff: staffRow }, 201);
    }
  );

  // Shareable invitation codes/links with expiration
  app.get(
    "/staff/invitations",
    requireUserSession(),
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");

      const { data } = await db
        .from("staff_invitations")
        .select("id,code_prefix,invited_email,role,expires_at,max_uses,used_count,revoked_at,created_at")
        .eq("account_id", auth.accountId)
        .order("created_at", { ascending: false });

      return c.json({ invitations: data ?? [] });
    }
  );

  app.post(
    "/staff/invitations",
    requireUserSession(),
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = createInviteSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid invitation payload." }, 400);
      }

      const auth = c.get("userAuth")!;
      if (parsed.data.role === "administrator" && auth.staffRole !== "owner") {
        return c.json(
          { error: "Only the account owner can invite administrators." },
          403
        );
      }

      const db = c.get("db");
      const rawCode = `HC-${generateRandomToken(9)}`;
      const codeHash = await sha256Hex(rawCode);
      const expiresAt = new Date(
        Date.now() + parsed.data.expiresInHours * 3600 * 1000
      ).toISOString();

      const { data, error } = await db
        .from("staff_invitations")
        .insert({
          account_id: auth.accountId,
          code_hash: codeHash,
          code_prefix: rawCode.slice(0, 8),
          invited_email: parsed.data.invitedEmail?.toLowerCase() ?? null,
          role: parsed.data.role,
          expires_at: expiresAt,
          max_uses: parsed.data.maxUses,
          created_by: auth.userId,
        })
        .select("id,code_prefix,invited_email,role,expires_at,max_uses,used_count,created_at")
        .single();

      if (error) return c.json({ error: error.message }, 400);

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        category: "staff",
        action: "staff.invitation_created",
        summary: `Created ${parsed.data.role} invitation expiring ${expiresAt}`,
      });

      const origin = new URL(c.req.url).origin;
      return c.json(
        {
          invitation: data,
          inviteCode: rawCode,
          inviteLink: `${origin}/invite?code=${encodeURIComponent(rawCode)}`,
        },
        201
      );
    }
  );

  app.delete(
    "/staff/invitations/:id",
    requireUserSession(),
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      await db
        .from("staff_invitations")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", c.req.param("id"))
        .eq("account_id", auth.accountId);
      return c.json({ ok: true });
    }
  );

  app.patch(
    "/staff/:staffId",
    requireUserSession(),
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = updateStaffSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid staff update payload." }, 400);
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const staffId = c.req.param("staffId");

      const { data: targetData } = await db
        .from("staff")
        .select("*")
        .eq("id", staffId)
        .eq("account_id", auth.accountId)
        .maybeSingle();

      const target = targetData as {
        id: string;
        user_id: string;
        role: string;
        status: string;
      } | null;

      if (!target) {
        return c.json({ error: "Staff member not found in your account." }, 404);
      }

      if (target.role === "owner" && auth.staffRole !== "owner") {
        return c.json({ error: "Only an owner can edit an owner." }, 403);
      }

      if (parsed.data.role === "owner" && auth.staffRole !== "owner") {
        return c.json({ error: "Only an owner can assign owner role." }, 403);
      }

      if (target.role === "owner" && parsed.data.role && parsed.data.role !== "owner") {
        const { count } = await db
          .from("staff")
          .select("id", { count: "exact", head: true })
          .eq("account_id", auth.accountId)
          .eq("role", "owner")
          .eq("status", "active");
        if ((count ?? 0) <= 1) {
          return c.json({ error: "Account must retain at least one active owner." }, 400);
        }
      }

      if (parsed.data.role) {
        await db
          .from("staff")
          .update({ role: parsed.data.role })
          .eq("id", target.id)
          .eq("account_id", auth.accountId);
      }

      if (parsed.data.fullName) {
        await db
          .from("users")
          .update({ full_name: parsed.data.fullName })
          .eq("id", target.user_id);
      }

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        category: "staff",
        action: "staff.updated",
        summary: `Updated staff member ${target.id}`,
      });

      return c.json({ ok: true });
    }
  );

  app.post(
    "/staff/:staffId/suspend",
    requireUserSession(),
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const staffId = c.req.param("staffId");

      const { data: target } = await db
        .from("staff")
        .select("id,user_id,role")
        .eq("id", staffId)
        .eq("account_id", auth.accountId)
        .maybeSingle();

      if (!target) return c.json({ error: "Staff member not found." }, 404);
      const row = target as { id: string; user_id: string; role: string };

      if (row.role === "owner") {
        return c.json({ error: "Account owner cannot be suspended." }, 400);
      }

      await db
        .from("staff")
        .update({ status: "suspended" })
        .eq("id", row.id)
        .eq("account_id", auth.accountId);

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        category: "staff",
        action: "staff.suspended",
        summary: `Suspended staff member ${row.id}`,
      });

      return c.json({ ok: true });
    }
  );

  app.post(
    "/staff/:staffId/reactivate",
    requireUserSession(),
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const staffId = c.req.param("staffId");

      const { data: updated } = await db
        .from("staff")
        .update({ status: "active" })
        .eq("id", staffId)
        .eq("account_id", auth.accountId)
        .select("id")
        .maybeSingle();

      if (!updated) return c.json({ error: "Staff member not found." }, 404);

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        category: "staff",
        action: "staff.reactivated",
        summary: `Reactivated staff member ${staffId}`,
      });

      return c.json({ ok: true });
    }
  );

  app.delete(
    "/staff/:staffId",
    requireUserSession(),
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const staffId = c.req.param("staffId");

      const { data: target } = await db
        .from("staff")
        .select("id,role")
        .eq("id", staffId)
        .eq("account_id", auth.accountId)
        .maybeSingle();

      if (!target) return c.json({ error: "Staff member not found." }, 404);
      if ((target as { role: string }).role === "owner") {
        return c.json({ error: "Account owner cannot be removed." }, 400);
      }

      await db
        .from("staff")
        .delete()
        .eq("id", staffId)
        .eq("account_id", auth.accountId);

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        category: "staff",
        action: "staff.removed",
        summary: `Removed staff member ${staffId}`,
      });

      return c.json({ ok: true });
    }
  );

  return app;
}
