import {
  DEFAULT_ADMIN_NOTIFICATION_PREFERENCES,
  DEFAULT_USER_NOTIFICATION_PREFERENCES,
  type AdminNotificationPreferences,
  type NotificationScope,
  type NotificationSeverity,
  type UserNotificationPreferences,
} from "@homecoreos/shared";
import type { DbClient } from "./db";

export type UserPreferenceKey = keyof UserNotificationPreferences;
export type AdminPreferenceKey = keyof AdminNotificationPreferences;
export type NotificationPreferenceKey = UserPreferenceKey | AdminPreferenceKey;

export interface NotificationRow {
  id: string;
  scope: NotificationScope;
  account_id: string | null;
  user_id: string | null;
  category: string;
  event_key: string;
  preference_key: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  dedup_key: string | null;
  metadata: Record<string, unknown>;
  is_read: boolean;
  read_at: string | null;
  cleared_at: string | null;
  created_at: string;
}

export interface EmitNotificationParams {
  scope: NotificationScope;
  accountId?: string | null;
  userId?: string | null;
  category: string;
  eventKey: string;
  preferenceKey: NotificationPreferenceKey;
  severity?: NotificationSeverity;
  title: string;
  message: string;
  dedupKey?: string | null;
  /** Suppress identical dedupKey notifications within this window (default 300s). */
  dedupWindowSeconds?: number;
  /** If true, suppress when any unread active notification with the same dedupKey already exists. */
  dedupWhileUnread?: boolean;
  metadata?: Record<string, unknown>;
}

async function isNotificationEnabledForTarget(
  db: DbClient,
  params: EmitNotificationParams
): Promise<boolean> {
  if (params.scope === "user" && !params.accountId) return false;

  let query = db
    .from("notification_preferences")
    .select("user_id,preferences")
    .eq("scope", params.scope);

  if (params.scope === "user" && params.accountId) {
    query = query.eq("account_id", params.accountId);
  }
  if (params.userId) {
    query = query.eq("user_id", params.userId);
  }

  const { data } = await query;
  const rows = (data ?? []) as Array<{
    user_id: string;
    preferences: Record<string, boolean> | null;
  }>;

  if (rows.length === 0) {
    return true;
  }

  if (params.userId) {
    const specific = rows.find((r) => r.user_id === params.userId);
    if (specific?.preferences && params.preferenceKey in specific.preferences) {
      return specific.preferences[params.preferenceKey] !== false;
    }
    return true;
  }

  // If all preference rows for the account/admin group have disabled this key, suppress
  const anyEnabled = rows.some(
    (r) => !r.preferences || r.preferences[params.preferenceKey] !== false
  );
  return anyEnabled;
}

export async function emitNotification(
  db: DbClient,
  params: EmitNotificationParams
): Promise<{ created: boolean; notification?: NotificationRow; skippedReason?: string }> {
  try {
    const dedupCheckPromise = params.dedupKey
      ? (() => {
          let dedupQuery = db
            .from("notifications")
            .select("id,is_read,created_at")
            .eq("scope", params.scope)
            .eq("dedup_key", params.dedupKey)
            .is("cleared_at", null)
            .order("created_at", { ascending: false })
            .limit(1);

          if (params.scope === "user" && params.accountId) {
            dedupQuery = dedupQuery.eq("account_id", params.accountId);
          } else if (params.scope === "admin") {
            dedupQuery = dedupQuery.is("account_id", null);
          }
          return dedupQuery;
        })()
      : Promise.resolve({ data: null });

    const [enabled, dedupRes] = await Promise.all([
      isNotificationEnabledForTarget(db, params),
      dedupCheckPromise,
    ]);

    if (!enabled) {
      return { created: false, skippedReason: "preference_disabled" };
    }

    if (params.dedupKey) {
      const windowSec = params.dedupWindowSeconds ?? 300;
      const sinceIso = new Date(Date.now() - windowSec * 1000).toISOString();
      const existingRows = dedupRes.data;
      const latest = (existingRows ?? [])[0] as
        | { id: string; is_read: boolean; created_at: string }
        | undefined;

      if (latest) {
        if (params.dedupWhileUnread && !latest.is_read) {
          return { created: false, skippedReason: "dedup_unread" };
        }
        if (latest.created_at >= sinceIso) {
          return { created: false, skippedReason: "dedup_window" };
        }
      }
    }

    const { data, error } = await db
      .from("notifications")
      .insert({
        scope: params.scope,
        account_id: params.scope === "user" ? params.accountId ?? null : null,
        user_id: params.userId ?? null,
        category: params.category,
        event_key: params.eventKey,
        preference_key: params.preferenceKey,
        severity: params.severity ?? "info",
        title: params.title.slice(0, 180),
        message: params.message.slice(0, 800),
        dedup_key: params.dedupKey ?? null,
        metadata: params.metadata ?? {},
      })
      .select("*")
      .single();

    if (error || !data) {
      return { created: false, skippedReason: error?.message ?? "insert_failed" };
    }

    return { created: true, notification: data as NotificationRow };
  } catch {
    return { created: false, skippedReason: "exception" };
  }
}

export async function getEffectiveNotificationPreferences(
  db: DbClient,
  scope: NotificationScope,
  userId: string,
  accountId: string | null
): Promise<UserNotificationPreferences | AdminNotificationPreferences> {
  const accountKey = scope === "user" && accountId ? accountId : "";
  const { data } = await db
    .from("notification_preferences")
    .select("preferences")
    .eq("scope", scope)
    .eq("user_id", userId)
    .eq("account_key", accountKey)
    .maybeSingle();

  const stored = (data as { preferences?: Record<string, boolean> } | null)?.preferences ?? {};
  if (scope === "user") {
    return {
      ...DEFAULT_USER_NOTIFICATION_PREFERENCES,
      ...stored,
    };
  }
  return {
    ...DEFAULT_ADMIN_NOTIFICATION_PREFERENCES,
    ...stored,
  };
}

export async function saveNotificationPreferences(
  db: DbClient,
  scope: NotificationScope,
  userId: string,
  accountId: string | null,
  patch: Record<string, boolean>
): Promise<UserNotificationPreferences | AdminNotificationPreferences> {
  const accountKey = scope === "user" && accountId ? accountId : "";
  const current = await getEffectiveNotificationPreferences(
    db,
    scope,
    userId,
    accountId
  );
  const merged = { ...current } as Record<string, boolean>;
  for (const [key, val] of Object.entries(patch)) {
    if (key in merged && typeof val === "boolean") {
      merged[key] = val;
    }
  }

  const now = new Date().toISOString();
  const { data: existing } = await db
    .from("notification_preferences")
    .select("id")
    .eq("scope", scope)
    .eq("user_id", userId)
    .eq("account_key", accountKey)
    .maybeSingle();

  if (existing) {
    await db
      .from("notification_preferences")
      .update({
        preferences: merged,
        updated_at: now,
      })
      .eq("id", (existing as { id: string }).id);
  } else {
    await db.from("notification_preferences").insert({
      scope,
      user_id: userId,
      account_id: scope === "user" ? accountId : null,
      account_key: accountKey,
      preferences: merged,
      updated_at: now,
    });
  }

  return merged as unknown as
    | UserNotificationPreferences
    | AdminNotificationPreferences;
}

/**
 * Transitions controllers whose heartbeat has exceeded controller_offline_timeout_seconds
 * from online -> offline once, emitting deduplicated user & admin notifications.
 */
export async function refreshStaleControllerStates(
  db: DbClient,
  accountId?: string
): Promise<number> {
  let onlineQuery = db
    .from("controllers")
    .select("id,account_id,name,last_heartbeat_at,connection_history")
    .eq("status", "online")
    .is("deleted_at", null)
    .is("permanently_deleted_at", null);

  if (accountId) {
    onlineQuery = onlineQuery.eq("account_id", accountId);
  }

  const [{ data: settings }, { data: onlineRows }] = await Promise.all([
    db
      .from("platform_settings")
      .select("controller_offline_timeout_seconds")
      .eq("id", 1)
      .maybeSingle(),
    onlineQuery,
  ]);

  const timeoutSec =
    (settings as { controller_offline_timeout_seconds?: number } | null)
      ?.controller_offline_timeout_seconds ?? 180;
  const cutoffMs = Date.now() - timeoutSec * 1000;

  const list = ((onlineRows ?? []) as Array<{
    id: string;
    account_id: string;
    name: string;
    last_heartbeat_at: string | null;
    connection_history: unknown[];
  }>).filter((ctrl) => {
    if (!ctrl.last_heartbeat_at) return false;
    return new Date(ctrl.last_heartbeat_at).getTime() < cutoffMs;
  });

  if (list.length === 0) return 0;

  let transitioned = 0;
  const nowIso = new Date().toISOString();

  await Promise.all(
    list.map(async (ctrl) => {
      const history = Array.isArray(ctrl.connection_history)
        ? ctrl.connection_history.slice(-19)
        : [];

      await Promise.all([
        db
          .from("controllers")
          .update({
            status: "offline",
            mqtt_connected: false,
            connection_history: [
              ...history,
              { event: "heartbeat_timeout", at: nowIso },
            ],
          })
          .eq("id", ctrl.id)
          .eq("status", "online"),
        emitNotification(db, {
          scope: "user",
          accountId: ctrl.account_id,
          category: "controller",
          eventKey: "controller.offline",
          preferenceKey: "controller_offline_online",
          severity: "warning",
          title: `Controller Offline: ${ctrl.name}`,
          message: `${ctrl.name} missed its heartbeat window (${timeoutSec}s) and is now offline.`,
          dedupKey: `ctrl:${ctrl.id}:offline`,
          dedupWhileUnread: true,
          dedupWindowSeconds: 1800,
          metadata: { controllerId: ctrl.id, timeoutSec },
        }),
        emitNotification(db, {
          scope: "admin",
          category: "controller",
          eventKey: "admin.controller_offline",
          preferenceKey: "controller_activity",
          severity: "warning",
          title: `Controller Went Offline: ${ctrl.name}`,
          message: `Controller ${ctrl.id.slice(0, 8)} (${ctrl.name}) timed out after ${timeoutSec}s.`,
          dedupKey: `admin:ctrl:${ctrl.id}:offline`,
          dedupWhileUnread: true,
          dedupWindowSeconds: 1800,
          metadata: { controllerId: ctrl.id, accountId: ctrl.account_id },
        }),
      ]);

      transitioned += 1;
    })
  );

  return transitioned;
}
