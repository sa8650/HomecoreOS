import { Hono } from "hono";
import { z } from "zod";
import {
  clearAllNotificationsForUser,
  clearNotificationForUser,
  getEffectiveNotificationPreferences,
  loadVisibleNotificationsForUser,
  markAllNotificationsReadForUser,
  refreshStaleControllerStates,
  saveNotificationPreferences,
  setNotificationReadStateForUser,
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

    await refreshStaleControllerStates(db, auth.accountId, {
      env: c.env ?? {},
      emqxFetch: c.get("deps")?.emqxFetch,
    }).catch(() => 0);

    const result = await loadVisibleNotificationsForUser(db, {
      scope: "user",
      userId: auth.userId,
      accountId: auth.accountId,
      status,
      category,
      limit,
      offset,
    });

    return c.json(result);
  });

  app.get("/unread-count", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");

    const { unreadCount } = await loadVisibleNotificationsForUser(db, {
      scope: "user",
      userId: auth.userId,
      accountId: auth.accountId,
      limit: 1,
      offset: 0,
    });

    return c.json({ unreadCount });
  });

  app.post("/:id/read", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const id = c.req.param("id");

    const updated = await setNotificationReadStateForUser(db, {
      scope: "user",
      userId: auth.userId,
      accountId: auth.accountId,
      notificationId: id,
      isRead: true,
    });

    if (!updated) return c.json({ error: "Notification not found." }, 404);
    return c.json({ notification: updated });
  });

  app.post("/:id/unread", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const id = c.req.param("id");

    const updated = await setNotificationReadStateForUser(db, {
      scope: "user",
      userId: auth.userId,
      accountId: auth.accountId,
      notificationId: id,
      isRead: false,
    });

    if (!updated) return c.json({ error: "Notification not found." }, 404);
    return c.json({ notification: updated });
  });

  app.post("/mark-all-read", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");

    await markAllNotificationsReadForUser(db, {
      scope: "user",
      userId: auth.userId,
      accountId: auth.accountId,
    });

    return c.json({ ok: true, unreadCount: 0 });
  });

  app.post("/clear", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");

    await clearAllNotificationsForUser(db, {
      scope: "user",
      userId: auth.userId,
      accountId: auth.accountId,
    });

    return c.json({ ok: true, unreadCount: 0 });
  });

  app.delete("/:id", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const id = c.req.param("id");

    const cleared = await clearNotificationForUser(db, {
      scope: "user",
      userId: auth.userId,
      accountId: auth.accountId,
      notificationId: id,
    });

    if (!cleared) return c.json({ error: "Notification not found." }, 404);
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
    const admin = c.get("adminAuth")!;
    const db = c.get("db");
    const status = (c.req.query("status") ?? "all").toLowerCase();
    const category = (c.req.query("category") ?? "all").toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

    await refreshStaleControllerStates(db, undefined, {
      env: c.env ?? {},
      emqxFetch: c.get("deps")?.emqxFetch,
    }).catch(() => 0);

    const result = await loadVisibleNotificationsForUser(db, {
      scope: "admin",
      userId: admin.userId,
      accountId: null,
      status,
      category,
      limit,
      offset,
    });

    return c.json(result);
  });

  app.get("/unread-count", async (c) => {
    const admin = c.get("adminAuth")!;
    const db = c.get("db");

    const { unreadCount } = await loadVisibleNotificationsForUser(db, {
      scope: "admin",
      userId: admin.userId,
      accountId: null,
      limit: 1,
      offset: 0,
    });

    return c.json({ unreadCount });
  });

  app.post("/:id/read", async (c) => {
    const admin = c.get("adminAuth")!;
    const db = c.get("db");
    const id = c.req.param("id");

    const updated = await setNotificationReadStateForUser(db, {
      scope: "admin",
      userId: admin.userId,
      accountId: null,
      notificationId: id,
      isRead: true,
    });

    if (!updated) return c.json({ error: "Notification not found." }, 404);
    return c.json({ notification: updated });
  });

  app.post("/:id/unread", async (c) => {
    const admin = c.get("adminAuth")!;
    const db = c.get("db");
    const id = c.req.param("id");

    const updated = await setNotificationReadStateForUser(db, {
      scope: "admin",
      userId: admin.userId,
      accountId: null,
      notificationId: id,
      isRead: false,
    });

    if (!updated) return c.json({ error: "Notification not found." }, 404);
    return c.json({ notification: updated });
  });

  app.post("/mark-all-read", async (c) => {
    const admin = c.get("adminAuth")!;
    const db = c.get("db");

    await markAllNotificationsReadForUser(db, {
      scope: "admin",
      userId: admin.userId,
      accountId: null,
    });

    return c.json({ ok: true, unreadCount: 0 });
  });

  app.post("/clear", async (c) => {
    const admin = c.get("adminAuth")!;
    const db = c.get("db");

    await clearAllNotificationsForUser(db, {
      scope: "admin",
      userId: admin.userId,
      accountId: null,
    });

    return c.json({ ok: true, unreadCount: 0 });
  });

  app.delete("/:id", async (c) => {
    const admin = c.get("adminAuth")!;
    const db = c.get("db");
    const id = c.req.param("id");

    const cleared = await clearNotificationForUser(db, {
      scope: "admin",
      userId: admin.userId,
      accountId: null,
      notificationId: id,
    });

    if (!cleared) return c.json({ error: "Notification not found." }, 404);
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
