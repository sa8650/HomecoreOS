import {
  DEFAULT_ADMIN_NOTIFICATION_PREFERENCES,
  DEFAULT_USER_NOTIFICATION_PREFERENCES,
  type AdminNotificationPreferences,
  type NotificationScope,
  type NotificationSeverity,
  type UserNotificationPreferences,
} from "@homecoreos/shared";
import type { WorkerBindings } from "../config/env";
import type { CustomFetch, DbClient } from "./db";
import { makeRealtimeEvent, publishRealtimeEvents } from "./realtime";

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

async function getActiveGroupMemberIds(
  db: DbClient,
  scope: NotificationScope,
  accountId: string | null
): Promise<string[]> {
  if (scope === "user") {
    if (!accountId) return [];
    const { data } = await db
      .from("staff")
      .select("user_id")
      .eq("account_id", accountId)
      .eq("status", "active");
    return Array.from(
      new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id).filter(Boolean))
    );
  }
  const { data } = await db
    .from("platform_staff")
    .select("user_id")
    .eq("status", "active");
  return Array.from(
    new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id).filter(Boolean))
  );
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

  const [{ data }, memberIds] = await Promise.all([
    query,
    params.userId
      ? Promise.resolve<string[]>([])
      : getActiveGroupMemberIds(db, params.scope, params.accountId ?? null),
  ]);

  const rows = (data ?? []) as Array<{
    user_id: string;
    preferences: Record<string, boolean> | null;
  }>;

  if (params.userId) {
    const specific = rows.find((r) => r.user_id === params.userId);
    if (specific?.preferences && params.preferenceKey in specific.preferences) {
      return specific.preferences[params.preferenceKey] !== false;
    }
    return true;
  }

  if (memberIds.length > 0) {
    const prefByUserId = new Map(rows.map((r) => [r.user_id, r.preferences]));
    // Emit if ANY active member still has this preference enabled (missing row defaults to true)
    return memberIds.some((memberId) => {
      const prefs = prefByUserId.get(memberId);
      return !prefs || prefs[params.preferenceKey] !== false;
    });
  }

  if (rows.length === 0) {
    return true;
  }

  // Fallback when no staff/platform_staff rows exist in test fixtures
  return rows.some(
    (r) => !r.preferences || r.preferences[params.preferenceKey] !== false
  );
}

export async function emitNotification(
  db: DbClient,
  params: EmitNotificationParams,
  /**
   * Optional real-time context. When present, a newly created user
   * notification is pushed to the account's console so the bell updates
   * without waiting for its fallback refresh.
   */
  realtime?: { env?: WorkerBindings; emqxFetch?: CustomFetch }
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

    if (realtime?.env && params.scope === "user" && params.accountId) {
      const row = data as NotificationRow;
      await publishRealtimeEvents(realtime.env, { emqxFetch: realtime.emqxFetch }, params.accountId, [
        makeRealtimeEvent("notification", "alert", row.id, {
          category: row.category,
          severity: row.severity,
          title: row.title,
          createdAt: row.created_at,
        }),
      ]);
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
  accountId?: string,
  realtime?: { env?: WorkerBindings; emqxFetch?: CustomFetch }
): Promise<number> {
  let onlineQuery = db
    .from("board_instances")
    .select(
      "id,account_id,name,board_role,last_heartbeat_at,last_communication_at,connection_history"
    )
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
    board_role?: string | null;
    last_heartbeat_at: string | null;
    last_communication_at?: string | null;
    connection_history: unknown[];
  }>).filter((ctrl) => {
    const hbMs = ctrl.last_heartbeat_at ? Date.parse(ctrl.last_heartbeat_at) : NaN;
    const commMs = ctrl.last_communication_at ? Date.parse(ctrl.last_communication_at) : NaN;
    const latestMs =
      Number.isFinite(hbMs) && Number.isFinite(commMs)
        ? Math.max(hbMs, commMs)
        : Number.isFinite(hbMs)
          ? hbMs
          : Number.isFinite(commMs)
            ? commMs
            : NaN;
    if (!Number.isFinite(latestMs)) return false;
    return latestMs < cutoffMs;
  });

  if (list.length === 0) return 0;

  let transitioned = 0;
  const nowIso = new Date().toISOString();

  await Promise.all(
    list.map(async (ctrl) => {
      const history = Array.isArray(ctrl.connection_history)
        ? ctrl.connection_history.slice(-19)
        : [];
      // A Node that stops reporting is never described as a Controller.
      const roleLabel = ctrl.board_role === "node" ? "Node" : "Controller";

      await Promise.all([
        db
          .from("board_instances")
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
          title: `${roleLabel} Offline: ${ctrl.name}`,
          message: `${ctrl.name} missed its heartbeat window (${timeoutSec}s) and is now offline.`,
          dedupKey: `ctrl:${ctrl.id}:offline`,
          dedupWhileUnread: true,
          dedupWindowSeconds: 1800,
          metadata: { boardInstanceId: ctrl.id, timeoutSec },
        }, realtime),
        emitNotification(db, {
          scope: "admin",
          category: "controller",
          eventKey: "admin.controller_offline",
          preferenceKey: "controller_activity",
          severity: "warning",
          title: `${roleLabel} Went Offline: ${ctrl.name}`,
          message: `${roleLabel} ${ctrl.id.slice(0, 8)} (${ctrl.name}) timed out after ${timeoutSec}s.`,
          dedupKey: `admin:ctrl:${ctrl.id}:offline`,
          dedupWhileUnread: true,
          dedupWindowSeconds: 1800,
          metadata: { boardInstanceId: ctrl.id, accountId: ctrl.account_id },
        }, realtime),
      ]);

      if (realtime?.env) {
        await publishRealtimeEvents(realtime.env, { emqxFetch: realtime.emqxFetch }, ctrl.account_id, [
          makeRealtimeEvent(
            "board",
            "state",
            ctrl.id,
            {
              status: "offline",
              mqttConnected: false,
              role: ctrl.board_role === "node" ? "node" : "controller",
              timedOutAfterSeconds: timeoutSec,
            },
            "confirmed"
          ),
        ]);
      }

      transitioned += 1;
    })
  );

  return transitioned;
}

interface NotificationUserStateRow {
  notification_id: string;
  user_id: string;
  is_read: boolean;
  read_at: string | null;
  cleared_at: string | null;
}

async function fetchUserNotificationStates(
  db: DbClient,
  userId: string,
  notificationIds: string[]
): Promise<Map<string, NotificationUserStateRow>> {
  if (notificationIds.length === 0) return new Map();
  const { data, error } = await db
    .from("notification_user_states")
    .select("notification_id,user_id,is_read,read_at,cleared_at")
    .eq("user_id", userId)
    .in("notification_id", notificationIds);
  if (error || !data) return new Map();
  return new Map(
    (data as NotificationUserStateRow[]).map((row) => [row.notification_id, row])
  );
}

async function queryBaseScopeNotifications(
  db: DbClient,
  params: {
    scope: NotificationScope;
    userId: string;
    accountId: string | null;
    limit: number;
  }
): Promise<NotificationRow[]> {
  let query = db
    .from("notifications")
    .select("*")
    .eq("scope", params.scope)
    .is("cleared_at", null)
    .or(`user_id.is.null,user_id.eq.${params.userId}`)
    .order("created_at", { ascending: false })
    .limit(params.limit);

  if (params.scope === "user" && params.accountId) {
    query = query.eq("account_id", params.accountId);
  } else if (params.scope === "admin") {
    query = query.is("account_id", null);
  }

  const { data } = await query;
  return (data ?? []) as NotificationRow[];
}

function applyUserVisibilityAndState(
  rows: NotificationRow[],
  prefs: Record<string, boolean>,
  stateMap: Map<string, NotificationUserStateRow>
): NotificationRow[] {
  const visible: NotificationRow[] = [];
  for (const row of rows) {
    if (row.preference_key && prefs[row.preference_key] === false) {
      continue;
    }
    const state = stateMap.get(row.id);
    const effectiveClearedAt = state?.cleared_at ?? row.cleared_at;
    if (effectiveClearedAt) {
      continue;
    }
    visible.push({
      ...row,
      is_read: state ? Boolean(state.is_read) : Boolean(row.is_read),
      read_at: state ? state.read_at : row.read_at,
      cleared_at: null,
    });
  }
  return visible;
}

export async function loadVisibleNotificationsForUser(
  db: DbClient,
  params: {
    scope: NotificationScope;
    userId: string;
    accountId: string | null;
    status?: string;
    category?: string;
    limit?: number;
    offset?: number;
  }
): Promise<{ notifications: NotificationRow[]; unreadCount: number }> {
  const limit = Math.min(500, Math.max(1, params.limit ?? 50));
  const offset = Math.max(0, params.offset ?? 0);
  const fetchCap = Math.min(500, Math.max(200, (limit + offset) * 2));

  const [prefs, rawRows] = await Promise.all([
    getEffectiveNotificationPreferences(db, params.scope, params.userId, params.accountId),
    queryBaseScopeNotifications(db, {
      scope: params.scope,
      userId: params.userId,
      accountId: params.accountId,
      limit: fetchCap,
    }),
  ]);

  const stateMap = await fetchUserNotificationStates(
    db,
    params.userId,
    rawRows.map((r) => r.id)
  );
  const visible = applyUserVisibilityAndState(
    rawRows,
    prefs as unknown as Record<string, boolean>,
    stateMap
  );

  const unreadCount = visible.reduce((acc, n) => acc + (n.is_read ? 0 : 1), 0);

  const status = (params.status ?? "all").toLowerCase();
  const category = (params.category ?? "all").toLowerCase();

  const filtered = visible.filter((n) => {
    if (status === "unread" && n.is_read) return false;
    if (status === "read" && !n.is_read) return false;
    if (category && category !== "all" && n.category.toLowerCase() !== category) {
      return false;
    }
    return true;
  });

  return {
    notifications: filtered.slice(offset, offset + limit),
    unreadCount,
  };
}

async function shouldMirrorToSharedNotificationRow(
  db: DbClient,
  scope: NotificationScope,
  accountId: string | null,
  notification: NotificationRow,
  actingUserId: string
): Promise<boolean> {
  if (notification.user_id && notification.user_id === actingUserId) {
    return true;
  }
  const members = await getActiveGroupMemberIds(db, scope, accountId);
  return members.length <= 1;
}

export async function setNotificationReadStateForUser(
  db: DbClient,
  params: {
    scope: NotificationScope;
    userId: string;
    accountId: string | null;
    notificationId: string;
    isRead: boolean;
  }
): Promise<NotificationRow | null> {
  let query = db
    .from("notifications")
    .select("*")
    .eq("id", params.notificationId)
    .eq("scope", params.scope)
    .is("cleared_at", null)
    .or(`user_id.is.null,user_id.eq.${params.userId}`);

  if (params.scope === "user" && params.accountId) {
    query = query.eq("account_id", params.accountId);
  } else if (params.scope === "admin") {
    query = query.is("account_id", null);
  }

  const { data } = await query.maybeSingle();
  if (!data) return null;
  const row = data as NotificationRow;

  const existingStates = await fetchUserNotificationStates(db, params.userId, [row.id]);
  if (existingStates.get(row.id)?.cleared_at) {
    return null;
  }

  const now = new Date().toISOString();
  const readAt = params.isRead ? now : null;

  await db
    .from("notification_user_states")
    .upsert(
      {
        notification_id: row.id,
        user_id: params.userId,
        is_read: params.isRead,
        read_at: readAt,
        cleared_at: null,
        updated_at: now,
      },
      { onConflict: "notification_id,user_id" }
    );

  if (
    await shouldMirrorToSharedNotificationRow(
      db,
      params.scope,
      params.accountId,
      row,
      params.userId
    )
  ) {
    await db
      .from("notifications")
      .update({ is_read: params.isRead, read_at: readAt })
      .eq("id", row.id);
  }

  return {
    ...row,
    is_read: params.isRead,
    read_at: readAt,
  };
}

export async function markAllNotificationsReadForUser(
  db: DbClient,
  params: {
    scope: NotificationScope;
    userId: string;
    accountId: string | null;
  }
): Promise<void> {
  const { notifications } = await loadVisibleNotificationsForUser(db, {
    scope: params.scope,
    userId: params.userId,
    accountId: params.accountId,
    status: "unread",
    limit: 500,
    offset: 0,
  });

  if (notifications.length === 0) return;

  const now = new Date().toISOString();
  await db
    .from("notification_user_states")
    .upsert(
      notifications.map((n) => ({
        notification_id: n.id,
        user_id: params.userId,
        is_read: true,
        read_at: now,
        cleared_at: null,
        updated_at: now,
      })),
      { onConflict: "notification_id,user_id" }
    );

  const members = await getActiveGroupMemberIds(db, params.scope, params.accountId);
  const idsToMirror = notifications
    .filter((n) => members.length <= 1 || n.user_id === params.userId)
    .map((n) => n.id);
  if (idsToMirror.length > 0) {
    await db
      .from("notifications")
      .update({ is_read: true, read_at: now })
      .in("id", idsToMirror);
  }
}

export async function clearNotificationForUser(
  db: DbClient,
  params: {
    scope: NotificationScope;
    userId: string;
    accountId: string | null;
    notificationId: string;
  }
): Promise<boolean> {
  let query = db
    .from("notifications")
    .select("*")
    .eq("id", params.notificationId)
    .eq("scope", params.scope)
    .is("cleared_at", null)
    .or(`user_id.is.null,user_id.eq.${params.userId}`);

  if (params.scope === "user" && params.accountId) {
    query = query.eq("account_id", params.accountId);
  } else if (params.scope === "admin") {
    query = query.is("account_id", null);
  }

  const { data } = await query.maybeSingle();
  if (!data) return false;
  const row = data as NotificationRow;

  const existingStates = await fetchUserNotificationStates(db, params.userId, [row.id]);
  if (existingStates.get(row.id)?.cleared_at) {
    return false;
  }

  const now = new Date().toISOString();
  await db
    .from("notification_user_states")
    .upsert(
      {
        notification_id: row.id,
        user_id: params.userId,
        is_read: true,
        read_at: existingStates.get(row.id)?.read_at ?? row.read_at ?? now,
        cleared_at: now,
        updated_at: now,
      },
      { onConflict: "notification_id,user_id" }
    );

  if (
    await shouldMirrorToSharedNotificationRow(
      db,
      params.scope,
      params.accountId,
      row,
      params.userId
    )
  ) {
    await db
      .from("notifications")
      .update({ cleared_at: now })
      .eq("id", row.id);
  }

  return true;
}

export async function clearAllNotificationsForUser(
  db: DbClient,
  params: {
    scope: NotificationScope;
    userId: string;
    accountId: string | null;
  }
): Promise<void> {
  const { notifications } = await loadVisibleNotificationsForUser(db, {
    scope: params.scope,
    userId: params.userId,
    accountId: params.accountId,
    limit: 500,
    offset: 0,
  });

  if (notifications.length === 0) return;

  const now = new Date().toISOString();
  await db
    .from("notification_user_states")
    .upsert(
      notifications.map((n) => ({
        notification_id: n.id,
        user_id: params.userId,
        is_read: true,
        read_at: n.read_at ?? now,
        cleared_at: now,
        updated_at: now,
      })),
      { onConflict: "notification_id,user_id" }
    );

  const members = await getActiveGroupMemberIds(db, params.scope, params.accountId);
  const idsToMirror = notifications
    .filter((n) => members.length <= 1 || n.user_id === params.userId)
    .map((n) => n.id);
  if (idsToMirror.length > 0) {
    await db
      .from("notifications")
      .update({ cleared_at: now })
      .in("id", idsToMirror);
  }
}
