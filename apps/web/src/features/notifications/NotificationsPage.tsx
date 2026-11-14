import { useCallback, useEffect, useState } from "react";
import {
  RiAlertLine,
  RiArrowRightLine,
  RiCheckDoubleLine,
  RiCheckLine,
  RiCheckboxCircleLine,
  RiDeleteBinLine,
  RiErrorWarningLine,
  RiInformationLine,
  RiNotification3Line,
  RiRefreshLine,
} from "@remixicon/react";
import { toast } from "sonner";
import {
  apiFetch,
  ApiError,
  cachedGet,
  emitNotificationSync,
  getCachedSnapshot,
  subscribeNotificationSync,
} from "@/lib/api";
import { formatTimestamp, useEffectiveTimezone } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { getNotificationTargetUrl } from "@/components/notifications/NotificationBellPopover";
import { Badge } from "@/components/reui/badge";
import { Frame, FramePanel } from "@/components/reui/frame";
import {
  EmptyStatePanel,
  PageHeader,
  StatusAlert,
} from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { NotificationItem } from "@/features/types";

const USER_CATEGORIES = [
  { value: "all", label: "All Categories" },
  { value: "controller", label: "Controllers" },
  { value: "device", label: "Devices" },
  { value: "sensor", label: "Sensors" },
  { value: "automation", label: "Automations" },
  { value: "firmware", label: "Firmware" },
  { value: "security", label: "Security" },
];

const ADMIN_CATEGORIES = [
  { value: "all", label: "All Categories" },
  { value: "user", label: "Users & Accounts" },
  { value: "controller", label: "Controllers" },
  { value: "firmware", label: "Firmware" },
  { value: "system", label: "Platform & Errors" },
  { value: "emqx", label: "EMQX & Services" },
];

function severityBadgeVariant(severity: NotificationItem["severity"]) {
  switch (severity) {
    case "danger":
      return "destructive-light";
    case "warning":
      return "warning-light";
    case "success":
      return "success-light";
    default:
      return "info-light";
  }
}

function SeverityGlyph({ severity }: { severity: NotificationItem["severity"] }) {
  switch (severity) {
    case "danger":
      return <RiErrorWarningLine className="size-4 text-destructive" aria-hidden="true" />;
    case "warning":
      return <RiAlertLine className="size-4 text-warning" aria-hidden="true" />;
    case "success":
      return <RiCheckboxCircleLine className="size-4 text-success" aria-hidden="true" />;
    default:
      return <RiInformationLine className="size-4 text-primary" aria-hidden="true" />;
  }
}

export function NotificationsPage({
  scope,
  onNavigate,
}: {
  scope: "user" | "admin";
  onNavigate: (path: string) => void;
}) {
  const timezone = useEffectiveTimezone();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [category, setCategory] = useState("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const apiBase = scope === "admin" ? "/api/admin/notifications" : "/api/notifications";
  const categories = scope === "admin" ? ADMIN_CATEGORIES : USER_CATEGORIES;

  const load = useCallback(async (force = false) => {
    const qs = new URLSearchParams({
      limit: "60",
      status: unreadOnly ? "unread" : "all",
    });
    if (category !== "all") qs.set("category", category);
    const url = `${apiBase}?${qs.toString()}`;
    const cached = !force
      ? getCachedSnapshot<{ notifications?: NotificationItem[]; unreadCount?: number }>(url)
      : null;
    if (cached) {
      setItems(Array.isArray(cached.notifications) ? cached.notifications : []);
      setUnreadCount(typeof cached.unreadCount === "number" ? cached.unreadCount : 0);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const res = await cachedGet<{
        notifications?: NotificationItem[];
        unreadCount?: number;
      }>(url, { ttlMs: 10_000, force });
      setItems(Array.isArray(res?.notifications) ? res.notifications : []);
      setUnreadCount(typeof res?.unreadCount === "number" ? res.unreadCount : 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load notifications.");
    } finally {
      setLoading(false);
    }
  }, [apiBase, category, unreadOnly]);

  useEffect(() => {
    void load();
    const unsub = subscribeNotificationSync((evt) => {
      if (evt.scope !== scope) return;
      void load(true);
    });
    return () => unsub();
  }, [load, scope]);

  async function handleToggleRead(item: NotificationItem) {
    const nextRead = !item.is_read;
    const nextCount = Math.max(0, unreadCount + (nextRead ? -1 : 1));
    setItems((prev) =>
      prev.map((n) => (n.id === item.id ? { ...n, is_read: nextRead } : n))
    );
    setUnreadCount(nextCount);
    try {
      await apiFetch(`${apiBase}/${item.id}/${nextRead ? "read" : "unread"}`, {
        method: "POST",
      });
      emitNotificationSync(scope, nextCount);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update notification.");
      void load(true);
    }
  }

  async function handleDelete(id: string, wasUnread: boolean) {
    const nextCount = wasUnread ? Math.max(0, unreadCount - 1) : unreadCount;
    setItems((prev) => prev.filter((n) => n.id !== id));
    if (wasUnread) setUnreadCount(nextCount);
    try {
      await apiFetch(`${apiBase}/${id}`, { method: "DELETE" });
      emitNotificationSync(scope, nextCount);
      toast.success("Notification removed.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to remove notification.");
      void load(true);
    }
  }

  async function handleMarkAllRead() {
    setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setUnreadCount(0);
    try {
      await apiFetch(`${apiBase}/mark-all-read`, { method: "POST" });
      emitNotificationSync(scope, 0);
      toast.success("All notifications marked as read.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to mark notifications as read.");
      void load(true);
    }
  }

  async function handleClearAll() {
    setItems([]);
    setUnreadCount(0);
    try {
      await apiFetch(`${apiBase}/clear`, { method: "POST" });
      emitNotificationSync(scope, 0);
      toast.success("Cleared all notifications.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to clear notifications.");
      void load(true);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={scope === "admin" ? "Platform Alerts" : "Household Alerts"}
        title="Notifications"
        description={
          scope === "admin"
            ? "Monitor new customer registrations, controller health, firmware releases, and platform errors."
            : "Stay updated on controller status, sensor thresholds, automation failures, firmware releases, and account security."
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load(true)}>
              <RiRefreshLine className="size-4" aria-hidden="true" />
              Refresh
            </Button>
            {unreadCount > 0 && (
              <Button size="sm" onClick={() => void handleMarkAllRead()}>
                <RiCheckDoubleLine className="size-4" aria-hidden="true" />
                Mark All Read ({unreadCount})
              </Button>
            )}
            {items.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => void handleClearAll()}>
                <RiDeleteBinLine className="size-4" aria-hidden="true" />
                Clear All
              </Button>
            )}
          </div>
        }
      />

      {error && <StatusAlert tone="danger">{error}</StatusAlert>}

      <Frame spacing="sm">
        <FramePanel className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger aria-label="Filter notification category" size="sm" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2">
              <Switch
                id="notif-unread-only"
                checked={unreadOnly}
                onCheckedChange={setUnreadOnly}
              />
              <Label htmlFor="notif-unread-only" className="cursor-pointer text-xs">
                Unread only
              </Label>
            </div>
          </div>

          <Button
            variant="ghost"
            size="xs"
            onClick={() => onNavigate(scope === "admin" ? "/admin/settings" : "/settings")}
          >
            Notification Preferences
            <RiArrowRightLine className="size-3.5" aria-hidden="true" />
          </Button>
        </FramePanel>
      </Frame>

      {loading && items.length === 0 ? (
        <div className="py-12 text-center text-xs text-muted-foreground">
          Loading notifications...
        </div>
      ) : items.length === 0 ? (
        <EmptyStatePanel
          icon={<RiNotification3Line />}
          tone="neutral"
          title={unreadOnly ? "No unread notifications" : "No notifications yet"}
          description="Operational events and alerts matching your preferences appear here automatically."
          action={
            unreadOnly ? (
              <Button variant="outline" size="sm" onClick={() => setUnreadOnly(false)}>
                Show All Notifications
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Frame spacing="sm" stacked>
          {items.map((item) => {
            const targetUrl = getNotificationTargetUrl(item, scope);
            return (
              <FramePanel
                key={item.id}
                className={cn(
                  "flex min-w-0 flex-wrap items-start justify-between gap-3 overflow-hidden transition-colors",
                  !item.is_read && "bg-primary/[0.03] dark:bg-primary/[0.07]"
                )}
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <div className="mt-0.5 shrink-0">
                    <SeverityGlyph severity={item.severity} />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <h3
                        className={cn(
                          "min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] text-sm",
                          !item.is_read
                            ? "font-semibold text-foreground"
                            : "font-medium text-foreground/85"
                        )}
                      >
                        {item.title}
                      </h3>
                      <Badge variant={severityBadgeVariant(item.severity)} size="xs">
                        {item.severity}
                      </Badge>
                      <Badge variant="secondary" size="xs">
                        {item.category}
                      </Badge>
                      {!item.is_read && (
                        <Badge variant="primary-light" size="xs" radius="full">
                          Unread
                        </Badge>
                      )}
                    </div>
                    <p className="whitespace-normal break-words [overflow-wrap:anywhere] text-xs leading-relaxed text-muted-foreground">
                      {item.message}
                    </p>
                    <p className="whitespace-normal break-words [overflow-wrap:anywhere] text-[11px] text-muted-foreground tabular-nums">
                      {formatTimestamp(item.created_at, timezone)} ·{" "}
                      <span className="font-mono break-all">{item.event_key}</span>
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={async () => {
                      if (!item.is_read) await handleToggleRead(item);
                      onNavigate(targetUrl);
                    }}
                  >
                    Open
                    <RiArrowRightLine className="size-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void handleToggleRead(item)}
                  >
                    <RiCheckLine className="size-3.5" aria-hidden="true" />
                    {item.is_read ? "Mark unread" : "Mark read"}
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Delete notification"
                    onClick={() => void handleDelete(item.id, !item.is_read)}
                  >
                    <RiDeleteBinLine className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </FramePanel>
            );
          })}
        </Frame>
      )}
    </div>
  );
}
