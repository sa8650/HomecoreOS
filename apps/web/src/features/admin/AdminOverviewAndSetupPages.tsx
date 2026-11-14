import { useEffect, useState } from "react";
import {
  RiCheckDoubleLine,
  RiCpuLine,
  RiDatabase2Line,
  RiHardDrive2Line,
  RiRefreshLine,
  RiRouterLine,
  RiUserSettingsLine,
} from "@remixicon/react";
import { ApiError, cachedGet, getCachedSnapshot } from "@/lib/api";
import { formatTimestamp, useEffectiveTimezone } from "@/lib/timezone";
import { Badge } from "@/components/reui/badge";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { IconTile } from "@/components/reui/icon-tile";
import {
  EmptyStatePanel,
  PageHeader,
  StatCard,
  StatusAlert,
} from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ActivityItem } from "../types";

interface AdminOverviewResponse {
  counts: {
    accounts: number;
    customerUsers: number;
    controllers: number;
    onlineControllers: number;
    firmwareReleases: number;
    catalogBoards: number;
  };
  recentActivity: ActivityItem[];
}

interface SetupStatusResponse {
  supabase: { configured: boolean; connected: boolean; error?: string };
  emqx: {
    configured: boolean;
    connected: boolean;
    brokerHost?: string;
    tlsPort?: number;
    activeClientsCount?: number;
    error?: string;
  };
  r2: {
    status: "connected" | "not_configured" | "failed";
    objectCount?: number;
    totalBytes?: number;
    error?: string;
  };
  entries: Array<{
    key: string;
    kind: "variable" | "secret" | "binding";
    configured: boolean;
    valid: boolean;
    status: string;
    message: string;
  }>;
}

export function AdminOverviewPage() {
  const timezone = useEffectiveTimezone();
  const cached = getCachedSnapshot<AdminOverviewResponse>("/api/admin/overview");
  const [data, setData] = useState<AdminOverviewResponse | null>(() => cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  async function load(force = false) {
    if (!getCachedSnapshot("/api/admin/overview")) {
      setLoading(true);
    }
    setError(null);
    try {
      const res = await cachedGet<AdminOverviewResponse>("/api/admin/overview", {
        ttlMs: 15_000,
        force,
      });
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load admin overview.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error && !data) return <StatusAlert tone="danger">{error}</StatusAlert>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Control Plane"
        title="Platform Overview"
        description={`Real-time fleet counts and recent platform security/audit events (${timezone}).`}
        actions={
          <Button variant="outline" size="sm" onClick={() => void load(true)}>
            <RiRefreshLine className="size-4" aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Customer Accounts"
          value={data.counts.accounts}
          icon={<RiUserSettingsLine className="size-4" />}
          tone="accent"
        />
        <StatCard
          label="Customer Users"
          value={data.counts.customerUsers}
          icon={<RiUserSettingsLine className="size-4" />}
          tone="neutral"
        />
        <StatCard
          label="Online / Total Controllers"
          value={`${data.counts.onlineControllers} / ${data.counts.controllers}`}
          icon={<RiCpuLine className="size-4" />}
          tone="success"
        />
        <StatCard
          label="Firmware Releases"
          value={data.counts.firmwareReleases}
          icon={<RiHardDrive2Line className="size-4" />}
          tone="warning"
        />
      </div>

      <Frame>
        <FrameHeader>
          <FrameTitle>Recent Platform Activity</FrameTitle>
        </FrameHeader>
        <FramePanel className={data.recentActivity.length === 0 ? "p-4" : "p-0 overflow-hidden"}>
          {data.recentActivity.length === 0 ? (
            <EmptyStatePanel
              compact
              icon={<RiCpuLine />}
              tone="neutral"
              title="No platform activity yet"
              description="Customer provisioning, board catalog updates, and firmware publications will appear here."
            />
          ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Summary</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Time ({timezone})</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recentActivity.map((act) => (
                <TableRow key={act.id}>
                  <TableCell>{act.summary}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{act.category}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-[11px]">{act.action}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {formatTimestamp(act.created_at, timezone)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
        </FramePanel>
      </Frame>
    </div>
  );
}

export function AdminSetupStatusPage() {
  const cached = getCachedSnapshot<SetupStatusResponse>("/api/admin/setup-status");
  const [status, setStatus] = useState<SetupStatusResponse | null>(() => cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  async function load(force = false) {
    if (!getCachedSnapshot("/api/admin/setup-status")) {
      setLoading(true);
    }
    setError(null);
    try {
      const res = await cachedGet<SetupStatusResponse>("/api/admin/setup-status", {
        ttlMs: 15_000,
        force,
      });
      setStatus(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to inspect setup status.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading && !status) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error && !status) return <StatusAlert tone="danger">{error}</StatusAlert>;
  if (!status) return null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Infrastructure Readiness"
        title="Setup Status"
        description="Live readiness checks for Supabase PostgreSQL, EMQX Serverless, and Cloudflare R2 (secrets are never exposed)."
        actions={
          <Button variant="outline" size="sm" onClick={() => void load(true)}>
            <RiRefreshLine className="size-4" aria-hidden="true" />
            Re-check Connections
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="p-4">
          <CardContent className="p-0 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <IconTile variant="soft" size="sm">
                  <RiDatabase2Line className="size-4 text-primary" />
                </IconTile>
                Supabase PostgreSQL
              </span>
              <Badge variant={status.supabase.connected ? "success-light" : "warning-light"}>
                <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
                {status.supabase.connected
                  ? "Connected"
                  : status.supabase.configured
                  ? "Connection Failed"
                  : "Configuration Required"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {status.supabase.error ?? "PostgREST service_role database connection verified."}
            </p>
          </CardContent>
        </Card>

        <Card className="p-4">
          <CardContent className="p-0 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <IconTile variant="soft" size="sm">
                  <RiRouterLine className="size-4 text-primary" />
                </IconTile>
                EMQX Serverless
              </span>
              <Badge variant={status.emqx.connected ? "success-light" : "warning-light"}>
                <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
                {status.emqx.connected
                  ? "Connected"
                  : status.emqx.configured
                  ? "API Error"
                  : "Configuration Required"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {status.emqx.error ??
                (status.emqx.brokerHost
                  ? `Broker: ${status.emqx.brokerHost}:${status.emqx.tlsPort ?? 8883} (TLS)`
                  : "Configure EMQX variables & secret in Cloudflare Worker.")}
            </p>
          </CardContent>
        </Card>

        <Card className="p-4">
          <CardContent className="p-0 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <IconTile variant="soft" size="sm">
                  <RiCheckDoubleLine className="size-4 text-primary" />
                </IconTile>
                Cloudflare R2 (FIRMWARE_BUCKET)
              </span>
              <Badge
                variant={status.r2.status === "connected" ? "success-light" : "warning-light"}
              >
                <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
                {status.r2.status === "connected" ? "Connected" : "Configuration Required"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {status.r2.error ??
                (status.r2.status === "connected"
                  ? `${status.r2.objectCount ?? 0} private firmware object(s) stored.`
                  : "Bind FIRMWARE_BUCKET in Cloudflare Worker settings.")}
            </p>
          </CardContent>
        </Card>
      </div>

      <Frame>
        <FrameHeader>
          <FrameTitle>Allowed Worker Configuration Checklist</FrameTitle>
        </FrameHeader>
        <FramePanel className="p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Binding / Variable</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {status.entries.map((e) => (
                <TableRow key={e.key}>
                  <TableCell className="font-mono font-semibold">{e.key}</TableCell>
                  <TableCell>{e.kind}</TableCell>
                  <TableCell>
                    <Badge variant={e.valid ? "success-light" : "warning-light"}>
                      {e.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{e.message}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </FramePanel>
      </Frame>
    </div>
  );
}
