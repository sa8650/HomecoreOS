import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  RiAlertLine,
  RiCheckDoubleLine,
  RiCheckboxCircleLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiErrorWarningLine,
  RiInformationLine,
  RiNotification3Line,
} from "@remixicon/react";
import { apiFetch, cachedGet, emitNotificationSync, subscribeNotificationSync } from "@/lib/api";
import { formatShortTime, useEffectiveTimezone } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { NotificationItem } from "@/features/types";

function SeverityIcon({ severity }: { severity: NotificationItem["severity"] }) {
  switch (severity) {
    case "danger":
      return <RiErrorWarningLine className="size-4 shrink-0 text-destructive" aria-hidden="true" />;
    case "warning":
      return <RiAlertLine className="size-4 shrink-0 text-warning" aria-hidden="true" />;
    case "success":
      return <RiCheckboxCircleLine className="size-4 shrink-0 text-success" aria-hidden="true" />;
    default:
      return <RiInformationLine className="size-4 shrink-0 text-primary" aria-hidden="true" />;
  }
}

export function getNotificationTargetUrl(
  item: NotificationItem,
  scope: "user" | "admin"
): string {
  const metaUrl = item.metadata?.actionUrl;
  if (typeof metaUrl === "string" && metaUrl.startsWith("/")) return metaUrl;

  if (scope === "admin") {
    switch (item.category) {
      case "user":
        return "/admin/accounts";
      case "firmware":
        return "/admin/firmware";
      case "emqx":
        return "/admin/emqx";
      case "system":
        return "/admin/setup";
      default:
        return "/admin/notifications";
    }
  }

  switch (item.category) {
    case "controller":
      return "/controllers";
    case "device":
      return "/devices";
    case "sensor":
      return "/sensors";
    case "automation":
      return "/automations";
    case "firmware":
      return "/firmware";
    case "security":
      return "/settings";
    default:
      return "/notifications";
  }
}

export function useNotificationFeed(
  scope: "user" | "admin",
  onNavigate: (path: string) => void
) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const lastFetchedAtRef = useRef(0);
  const unreadCountRef = useRef(0);
  unreadCountRef.current = unreadCount;

  const apiBase = scope === "admin" ? "/api/admin/notifications" : "/api/notifications";
  const allPath = scope === "admin" ? "/admin/notifications" : "/notifications";

  const loadNotifications = useCallback(
    async (force = false) => {
      if (lastFetchedAtRef.current === 0) setLoading(true);
      try {
        const res = await cachedGet<{
          notifications?: NotificationItem[];
          unreadCount?: number;
        }>(`${apiBase}?limit=20`, { ttlMs: 10_000, force });
        lastFetchedAtRef.current = Date.now();
        setItems(Array.isArray(res?.notifications) ? res.notifications : []);
        const nextUnread = typeof res?.unreadCount === "number" ? res.unreadCount : 0;
        unreadCountRef.current = nextUnread;
        setUnreadCount(nextUnread);
      } catch {
        // Ignore transient network errors in header polling
      } finally {
        setLoading(false);
      }
    },
    [apiBase]
  );

  useEffect(() => {
    void loadNotifications();
    const unsub = subscribeNotificationSync((evt) => {
      if (evt.scope !== scope) return;
      if (typeof evt.unreadCount === "number") {
        unreadCountRef.current = evt.unreadCount;
        setUnreadCount(evt.unreadCount);
      }
      void loadNotifications(true);
    });
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadNotifications(true);
      }
    }, 30000);
    return () => {
      unsub();
      window.clearInterval(timer);
    };
  }, [loadNotifications, scope]);

  const refreshIfStale = useCallback(async () => {
    if (Date.now() - lastFetchedAtRef.current > 5_000) {
      await loadNotifications(true);
    }
  }, [loadNotifications]);

  const markReadAndOpen = useCallback(
    async (item: NotificationItem, onAfterClose?: () => void) => {
      if (!item.is_read) {
        const nextCount = Math.max(0, unreadCountRef.current - 1);
        unreadCountRef.current = nextCount;
        setItems((prev) =>
          prev.map((n) => (n.id === item.id ? { ...n, is_read: true } : n))
        );
        setUnreadCount(nextCount);
        await apiFetch(`${apiBase}/${item.id}/read`, { method: "POST" }).catch(() => {});
        emitNotificationSync(scope, nextCount);
      }
      onAfterClose?.();
      onNavigate(getNotificationTargetUrl(item, scope));
    },
    [apiBase, onNavigate, scope]
  );

  const dismiss = useCallback(
    async (item: NotificationItem) => {
      const nextCount = !item.is_read
        ? Math.max(0, unreadCountRef.current - 1)
        : unreadCountRef.current;
      setItems((prev) => prev.filter((n) => n.id !== item.id));
      if (!item.is_read) {
        unreadCountRef.current = nextCount;
        setUnreadCount(nextCount);
      }
      await apiFetch(`${apiBase}/${item.id}`, { method: "DELETE" }).catch(() => {});
      emitNotificationSync(scope, nextCount);
    },
    [apiBase, scope]
  );

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    unreadCountRef.current = 0;
    setUnreadCount(0);
    await apiFetch(`${apiBase}/mark-all-read`, { method: "POST" }).catch(() => {});
    emitNotificationSync(scope, 0);
  }, [apiBase, scope]);

  return {
    items,
    unreadCount,
    loading,
    allPath,
    refreshIfStale,
    markReadAndOpen,
    dismiss,
    markAllRead,
  };
}

export const NotificationPopoverBody = memo(function NotificationPopoverBody({
  items,
  unreadCount,
  loading,
  onClose,
  onMarkAllRead,
  onMarkReadAndOpen,
  onDismiss,
  onViewAll,
}: {
  items: NotificationItem[];
  unreadCount: number;
  loading: boolean;
  onClose: () => void;
  onMarkAllRead: () => void;
  onMarkReadAndOpen: (item: NotificationItem) => void;
  onDismiss: (item: NotificationItem) => void;
  onViewAll: () => void;
}) {
  const timezone = useEffectiveTimezone();

  return (
    <>
      {/* Fixed Header */}
      <div
        data-testid="notification-popover-header"
        className="flex min-w-0 shrink-0 items-center justify-between gap-2 border-b bg-popover px-3.5 py-2.5"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-semibold text-foreground">Notifications</span>
          {unreadCount > 0 && (
            <Badge
              variant="destructive-light"
              size="xs"
              radius="full"
              className="shrink-0 tabular-nums"
            >
              {unreadCount} unread
            </Badge>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {unreadCount > 0 && (
            <Button
              size="xs"
              variant="ghost"
              onClick={onMarkAllRead}
              className="h-6 shrink-0 px-2 text-[11px]"
            >
              <RiCheckDoubleLine className="size-3.5" aria-hidden="true" />
              Mark all read
            </Button>
          )}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Close notifications"
            onClick={onClose}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <RiCloseLine className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Independent Scrollable List */}
      <div
        data-testid="notification-popover-list"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain divide-y"
      >
        {loading && items.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Loading notifications...
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1.5 p-7 text-center">
            <RiNotification3Line className="size-6 text-muted-foreground/60" aria-hidden="true" />
            <p className="text-xs font-medium text-foreground">All caught up</p>
            <p className="text-[11px] text-muted-foreground">
              No recent alerts or operational events.
            </p>
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              data-testid={`notification-item-${item.id}`}
              className={cn(
                "flex w-full min-w-0 items-start gap-2 px-3.5 py-3 transition-colors hover:bg-muted/50",
                !item.is_read && "bg-primary/[0.04] dark:bg-primary/[0.08]"
              )}
            >
              <button
                type="button"
                onClick={() => onMarkReadAndOpen(item)}
                className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 text-left"
              >
                <div className="mt-0.5 shrink-0">
                  <SeverityIcon severity={item.severity} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex w-full min-w-0 items-start justify-between gap-2">
                    <p
                      className={cn(
                        "min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere] text-xs leading-snug",
                        !item.is_read
                          ? "font-semibold text-foreground"
                          : "font-medium text-foreground/85"
                      )}
                    >
                      {item.title}
                    </p>
                    {!item.is_read && (
                      <span
                        className="mt-1 size-2 shrink-0 rounded-full bg-primary"
                        aria-label="Unread"
                      />
                    )}
                  </div>
                  <p className="mt-1 whitespace-normal break-words [overflow-wrap:anywhere] text-[12px] leading-relaxed text-muted-foreground">
                    {item.message}
                  </p>
                  <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
                    <span className="capitalize">{item.category}</span>
                    <span aria-hidden="true">·</span>
                    <span className="break-words [overflow-wrap:anywhere]">
                      {formatShortTime(item.created_at, timezone)}
                    </span>
                  </div>
                </div>
              </button>

              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Dismiss notification: ${item.title}`}
                onClick={() => onDismiss(item)}
                className="mt-0.5 shrink-0 text-muted-foreground hover:text-destructive"
              >
                <RiDeleteBinLine className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          ))
        )}
      </div>

      {/* Fixed Footer */}
      <div
        data-testid="notification-popover-footer"
        className="shrink-0 border-t bg-muted/30 p-2"
      >
        <Button
          variant="ghost"
          size="xs"
          className="w-full justify-center text-xs font-medium"
          onClick={onViewAll}
        >
          View all notifications
        </Button>
      </div>
    </>
  );
});

export const NotificationBellPopover = memo(function NotificationBellPopover({
  scope,
  onNavigate,
}: {
  scope: "user" | "admin";
  onNavigate: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const {
    items,
    unreadCount,
    loading,
    allPath,
    refreshIfStale,
    markReadAndOpen,
    dismiss,
    markAllRead,
  } = useNotificationFeed(scope, onNavigate);

  async function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      await refreshIfStale();
    }
  }

  return (
    <Popover open={open} onOpenChange={(next) => void handleOpenChange(next)}>
      <PopoverTrigger asChild>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Notifications"
          className="relative"
        >
          <RiNotification3Line className="size-4" aria-hidden="true" />
          {unreadCount > 0 && (
            <span
              data-testid="notification-unread-badge"
              className="absolute -top-1.5 -right-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-white tabular-nums"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        collisionPadding={8}
        data-testid="notification-popover-content"
        className="flex max-h-[85dvh] w-[min(calc(100vw-1rem),26rem)] max-w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden p-0 sm:w-[416px]"
      >
        <NotificationPopoverBody
          items={items}
          unreadCount={unreadCount}
          loading={loading}
          onClose={() => setOpen(false)}
          onMarkAllRead={() => void markAllRead()}
          onMarkReadAndOpen={(item) => void markReadAndOpen(item, () => setOpen(false))}
          onDismiss={(item) => void dismiss(item)}
          onViewAll={() => {
            setOpen(false);
            onNavigate(allPath);
          }}
        />
      </PopoverContent>
    </Popover>
  );
});
