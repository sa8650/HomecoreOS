import { Hono } from "hono";
import { z } from "zod";
import {
  getEffectiveNotificationPreferences,
  refreshStaleControllerStates,
  saveNotificationPreferences,
  type NotificationRow,
} from "../lib/notifications";
import { requireAdminSession, requireUserSession } from "../middleware/auth";
import type { AppEnv } from "../types/context";

const preferencesPatchSchema = z.record(z.boolean());

export function createUserNotificationRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", requireUserSession({ allowPausedAccount: true }));

  app.get("/", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const status = (c.req.query("status") ?? "all").toLowerCase();
    const category = (c.req.query("category") ?? "all").toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

    await refreshStaleControllerStates(db, auth.accountId).catch(() => 0);

    let query = db
      .from("notifications")
      .select("*")
      .eq("scope", "user")
      .eq("account_id", auth.accountId)
      .is("cleared_at", null)
      .or(`user_id.is.null,user_id.eq.${auth.userId}`)
      .order("created_at", { ascending: false })
      .limit(limit + offset);

    if (status === "unread") {
      query = query.eq("is_read", false);
    } else if (status === "read") {
      query = query.eq("is_read", true);
    }
    if (category && category !== "all") {
      query = query.eq("category", category);
    }

    const [{ data: rows }, { count: unreadCount }] = await Promise.all([
      query,
      db
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("scope", "user")
        .eq("account_id", auth.accountId)
        .is("cleared_at", null)
        .eq("is_read", false)
        .or(`user_id.is.null,user_id.eq.${auth.userId}`),
    ]);

    const paged = ((rows ?? []) as NotificationRow[]).slice(offset, offset + limit);

    return c.json({
      notifications: paged,
      unreadCount: unreadCount ?? 0,
    });
  });

  app.get("/unread-count", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");

    const { count } = await db
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("scope", "user")
      .eq("account_id", auth.accountId)
      .is("cleared_at", null)
      .eq("is_read", false)
      .or(`user_id.is.null,user_id.eq.${auth.userId}`);

    return c.json({ unreadCount: count ?? 0 });
  });

  app.post("/:id/read", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const id = c.req.param("id");
    const now = new Date().toISOString();

    const { data } = await db
      .from("notifications")
      .update({ is_read: true, read_at: now })
      .eq("id", id)
      .eq("scope", "user")
      .eq("account_id", auth.accountId)
      .is("cleared_at", null)
      .or(`user_id.is.null,user_id.eq.${auth.userId}`)
      .select("*")
      .maybeSingle();

    if (!data) return c.json({ error: "Notification not found." }, 404);
    return c.json({ notification: data });
  });

  app.post("/:id/unread", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const id = c.req.param("id");

    const { data } = await db
      .from("notifications")
      .update({ is_read: false, read_at: null })
      .eq("id", id)
      .eq("scope", "user")
      .eq("account_id", auth.accountId)
      .is("cleared_at", null)
      .or(`user_id.is.null,user_id.eq.${auth.userId}`)
      .select("*")
      .maybeSingle();

    if (!data) return c.json({ error: "Notification not found." }, 404);
    return c.json({ notification: data });
  });

  app.post("/mark-all-read", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const now = new Date().toISOString();

    await db
      .from("notifications")
      .update({ is_read: true, read_at: now })
      .eq("scope", "user")
      .eq("account_id", auth.accountId)
      .eq("is_read", false)
      .is("cleared_at", null)
      .or(`user_id.is.null,user_id.eq.${auth.userId}`);

    return c.json({ ok: true, unreadCount: 0 });
  });

  app.post("/clear", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const now = new Date().toISOString();

    await db
      .from("notifications")
      .update({ cleared_at: now })
      .eq("scope", "user")
      .eq("account_id", auth.accountId)
      .is("cleared_at", null)
      .or(`user_id.is.null,user_id.eq.${auth.userId}`);

    return c.json({ ok: true, unreadCount: 0 });
  });

  app.delete("/:id", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const id = c.req.param("id");
    const now = new Date().toISOString();

    const { data } = await db
      .from("notifications")
      .update({ cleared_at: now })
      .eq("id", id)
      .eq("scope", "user")
      .eq("account_id", auth.accountId)
      .is("cleared_at", null)
      .or(`user_id.is.null,user_id.eq.${auth.userId}`)
      .select("id")
      .maybeSingle();

    if (!data) return c.json({ error: "Notification not found." }, 404);
    return c.json({ ok: true });
  });

  app.get("/preferences", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const preferences = await getEffectiveNotificationPreferences(
      db,
      "user",
      auth.userId,
      auth.accountId
    );
    return c.json({ preferences });
  });

  app.patch("/preferences", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = preferencesPatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid notification preferences payload." }, 400);
    }

    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const preferences = await saveNotificationPreferences(
      db,
      "user",
      auth.userId,
      auth.accountId,
      parsed.data
    );
    return c.json({ preferences });
  });

  return app;
}

export function createAdminNotificationRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", requireAdminSession());

  app.get("/", async (c) => {
    const db = c.get("db");
    const status = (c.req.query("status") ?? "all").toLowerCase();
    const category = (c.req.query("category") ?? "all").toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

    await refreshStaleControllerStates(db).catch(() => 0);

    let query = db
      .from("notifications")
      .select("*")
      .eq("scope", "admin")
      .is("account_id", null)
      .is("cleared_at", null)
      .order("created_at", { ascending: false })
      .limit(limit + offset);

    if (status === "unread") {
      query = query.eq("is_read", false);
    } else if (status === "read") {
      query = query.eq("is_read", true);
    }
    if (category && category !== "all") {
      query = query.eq("category", category);
    }

    const [{ data: rows }, { count: unreadCount }] = await Promise.all([
      query,
      db
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("scope", "admin")
        .is("account_id", null)
        .is("cleared_at", null)
        .eq("is_read", false),
    ]);

    const paged = ((rows ?? []) as NotificationRow[]).slice(offset, offset + limit);

    return c.json({
      notifications: paged,
      unreadCount: unreadCount ?? 0,
    });
  });

  app.get("/unread-count", async (c) => {
    const db = c.get("db");

    const { count } = await db
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("scope", "admin")
      .is("account_id", null)
      .is("cleared_at", null)
      .eq("is_read", false);

    return c.json({ unreadCount: count ?? 0 });
  });

  app.post("/:id/read", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const now = new Date().toISOString();

    const { data } = await db
      .from("notifications")
      .update({ is_read: true, read_at: now })
      .eq("id", id)
      .eq("scope", "admin")
      .is("account_id", null)
      .is("cleared_at", null)
      .select("*")
      .maybeSingle();

    if (!data) return c.json({ error: "Notification not found." }, 404);
    return c.json({ notification: data });
  });

  app.post("/:id/unread", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const { data } = await db
      .from("notifications")
      .update({ is_read: false, read_at: null })
      .eq("id", id)
      .eq("scope", "admin")
      .is("account_id", null)
      .is("cleared_at", null)
      .select("*")
      .maybeSingle();

    if (!data) return c.json({ error: "Notification not found." }, 404);
    return c.json({ notification: data });
  });

  app.post("/mark-all-read", async (c) => {
    const db = c.get("db");
    const now = new Date().toISOString();

    await db
      .from("notifications")
      .update({ is_read: true, read_at: now })
      .eq("scope", "admin")
      .is("account_id", null)
      .eq("is_read", false)
      .is("cleared_at", null);

    return c.json({ ok: true, unreadCount: 0 });
  });

  app.post("/clear", async (c) => {
    const db = c.get("db");
    const now = new Date().toISOString();

    await db
      .from("notifications")
      .update({ cleared_at: now })
      .eq("scope", "admin")
      .is("account_id", null)
      .is("cleared_at", null);

    return c.json({ ok: true, unreadCount: 0 });
  });

  app.delete("/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const now = new Date().toISOString();

    const { data } = await db
      .from("notifications")
      .update({ cleared_at: now })
      .eq("id", id)
      .eq("scope", "admin")
      .is("account_id", null)
      .is("cleared_at", null)
      .select("id")
      .maybeSingle();

    if (!data) return c.json({ error: "Notification not found." }, 404);
    return c.json({ ok: true });
  });

  app.get("/preferences", async (c) => {
    const admin = c.get("adminAuth")!;
    const db = c.get("db");
    const preferences = await getEffectiveNotificationPreferences(
      db,
      "admin",
      admin.userId,
      null
    );
    return c.json({ preferences });
  });

  app.patch("/preferences", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = preferencesPatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid notification preferences payload." }, 400);
    }

    const admin = c.get("adminAuth")!;
    const db = c.get("db");
    const preferences = await saveNotificationPreferences(
      db,
      "admin",
      admin.userId,
      null,
      parsed.data
    );
    return c.json({ preferences });
  });

  return app;
}
