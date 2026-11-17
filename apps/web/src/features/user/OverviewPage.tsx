import { useCallback, useEffect, useRef, useState } from "react";
import {
  RiCpuLine,
  RiDoorOpenLine,
  RiHomeLine,
  RiLightbulbLine,
  RiPulseLine,
  RiRefreshLine,
  RiSensorLine,
  RiToggleLine,
} from "@remixicon/react";
import { toast } from "sonner";
import { ApiError, cachedGet, getCachedSnapshot } from "@/lib/api";
import { formatTimestamp, useEffectiveTimezone } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { ControllerWiringPreview } from "@/components/controllers/ControllerWiringPreview";
import { HomeFloorPlan } from "@/components/floorplan/HomeFloorPlan";
import { Badge } from "@/components/reui/badge";
import {
  EmptyStatePanel,
  PageHeader,
  StatCard,
  StatusAlert,
} from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { OverviewData } from "@/features/types";

interface OverviewPageProps {
  canManage: boolean;
  canOperate: boolean;
  onNavigate: (path: string) => void;
}

export function OverviewPage({ canManage, canOperate, onNavigate }: OverviewPageProps) {
  const timezone = useEffectiveTimezone();
  const [previewMode, setPreviewMode] = useState<"home" | "controller">("home");
  const cached = getCachedSnapshot<OverviewData>("/api/homes/overview");
  const [data, setData] = useState<OverviewData | null>(() => cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const hasDataRef = useRef(Boolean(cached));
  hasDataRef.current = Boolean(data);

  const loadOverview = useCallback(async (force = false) => {
    if (!getCachedSnapshot("/api/homes/overview")) {
      setLoading(true);
    }
    setError(null);
    try {
      const res = await cachedGet<OverviewData>("/api/homes/overview", {
        ttlMs: 12_000,
        force,
      });
      setData(res);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to load overview.";
      setError(msg);
      if (hasDataRef.current) {
        toast.error(msg);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSilentReload = useCallback(async () => {
    try {
      const res = await cachedGet<OverviewData>("/api/homes/overview", {
        ttlMs: 12_000,
        force: true,
      });
      setData(res);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to refresh overview."
      );
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    let lastSyncAt = Date.now();
    const syncIfStale = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastSyncAt < 8_000) return;
      lastSyncAt = now;
      void loadOverview(true);
    };
    window.addEventListener("focus", syncIfStale);
    document.addEventListener("visibilitychange", syncIfStale);
    return () => {
      window.removeEventListener("focus", syncIfStale);
      document.removeEventListener("visibilitychange", syncIfStale);
    };
  }, [loadOverview]);

  if (loading && !data) {
    return (
      <div className="py-16 text-center text-xs text-muted-foreground">
        Loading home floor plan & live telemetry...
      </div>
    );
  }

  if (error && !data) {
    return <StatusAlert tone="danger">{error}</StatusAlert>;
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Home Command"
        title="Home Overview"
        description="Live 2D architectural floor plan, active lighting & switch states, sensor telemetry, and controller health."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadOverview(true)}
          >
            <RiRefreshLine className="size-4" aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Controllers"
          value={`${data.summary.onlineControllers} / ${data.summary.totalControllers}`}
          sublabel={`${data.summary.offlineControllers} offline or pending`}
          tone={data.summary.onlineControllers > 0 ? "success" : "neutral"}
          icon={<RiCpuLine className="size-4" />}
        />
        <StatCard
          label="Rooms"
          value={data.summary.totalRooms}
          sublabel={`${data.homes.length} configured home${data.homes.length === 1 ? "" : "s"}`}
          tone="accent"
          icon={<RiDoorOpenLine className="size-4" />}
        />
        <StatCard
          label="Active Switches & Devices"
          value={data.summary.activeSwitches + data.summary.activeDevices}
          sublabel={`${data.summary.totalSwitches} switches · ${data.summary.totalDevices} devices`}
          tone="warning"
          icon={<RiToggleLine className="size-4" />}
        />
        <StatCard
          label="Live Sensors"
          value={data.summary.totalSensors}
          sublabel={`Times shown in ${timezone}`}
          tone="success"
          icon={<RiSensorLine className="size-4" />}
        />
      </div>

      {/* Panel preview toggle — sits above the 2D panel, switches in place */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          2D Preview
        </p>
        <div
          role="tablist"
          aria-label="Preview panel mode"
          className="inline-flex items-center gap-1 rounded-xl border bg-muted/40 p-1"
        >
          {(
            [
              {
                id: "home",
                label: "Home Preview",
                icon: <RiHomeLine className="size-4" aria-hidden="true" />,
              },
              {
                id: "controller",
                label: "Controller Preview",
                icon: <RiCpuLine className="size-4" aria-hidden="true" />,
              },
            ] as const
          ).map((tab) => {
            const active = previewMode === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setPreviewMode(tab.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div key={previewMode} className="hc-step-enter">
        {previewMode === "home" ? (
          <HomeFloorPlan
            homes={data.homes}
            rooms={data.rooms}
            controllers={data.controllers}
            switches={data.switches}
            devices={data.devices}
            sensors={data.sensors}
            canEdit={canManage}
            canOperate={canOperate}
            onReload={handleSilentReload}
            onNavigateRooms={() => onNavigate("/rooms")}
          />
        ) : (
          <ControllerWiringPreview
            controllers={data.controllers}
            switches={data.switches}
            devices={data.devices}
            sensors={data.sensors}
            rooms={data.rooms}
            onNavigate={onNavigate}
          />
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="text-sm">Latest Sensor Readings</CardTitle>
            <CardAction>
              <Button variant="ghost" size="xs" onClick={() => onNavigate("/sensors")}>
                View all
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-2 pt-3">
            {data.sensors.length === 0 ? (
              <EmptyStatePanel
                compact
                icon={<RiSensorLine />}
                tone="neutral"
                title="No sensors configured yet"
                description="Attach temperature, humidity, contact, or motion sensors to view live readings here."
              />
            ) : (
              data.sensors.slice(0, 6).map((sen) => (
                <div
                  key={sen.id}
                  className="flex items-center justify-between rounded-lg border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">
                      {sen.name}
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {sen.sensor_type}
                    </p>
                  </div>
                  <Badge variant={sen.last_value !== null ? "success-light" : "secondary"}>
                    <RiPulseLine className="size-3" aria-hidden="true" />
                    <span className="tabular-nums">
                      {sen.last_value !== null ? `${sen.last_value} ${sen.unit}` : "Awaiting data"}
                    </span>
                  </Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle className="text-sm">Recent Activity</CardTitle>
            <CardAction>
              <Button variant="ghost" size="xs" onClick={() => onNavigate("/activity")}>
                Full log
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-2 pt-3">
            {data.recentActivity.length === 0 ? (
              <EmptyStatePanel
                compact
                icon={<RiLightbulbLine />}
                tone="neutral"
                title="No activity events yet"
                description="Controller pairings, switch toggles, OTA updates, and rule runs will appear here."
              />
            ) : (
              data.recentActivity.slice(0, 6).map((act) => (
                <div
                  key={act.id}
                  className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2"
                >
                  <div className="flex items-start gap-2 min-w-0">
                    <RiLightbulbLine className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground">
                        {act.summary}
                      </p>
                      <p className="text-[11px] tabular-nums text-muted-foreground">
                        {formatTimestamp(act.created_at, timezone)}
                      </p>
                    </div>
                  </div>
                  <Badge variant="secondary">{act.category}</Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
