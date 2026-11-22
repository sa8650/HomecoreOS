import { RecoveryHistory } from "@/components/controllers/RecoveryHistory";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  RiArrowLeftLine,
  RiCpuLine,
  RiEyeLine,
  RiHardDrive2Line,
  RiLightbulbLine,
  RiRefreshLine,
  RiSensorLine,
  RiShieldCheckLine,
  RiToggleLine,
  RiUserSettingsLine,
} from "@remixicon/react";
import { apiFetch, ApiError } from "@/lib/api";
import { formatTimestamp, useEffectiveTimezone } from "@/lib/timezone";
import { Badge } from "@/components/reui/badge";
import {
  EmptyStatePanel,
  PageHeader,
  StatCard,
  StatusAlert,
} from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  BoardDetailData,
  BoardHealthStatus,
  CustomerMonitoringData,
  MonitoredBoard,
} from "../types";

const HEALTH_LABELS: Record<BoardHealthStatus, string> = {
  healthy: "Healthy",
  warning: "Warning",
  offline: "Offline",
  unknown: "Unknown",
};

function healthBadgeVariant(status: BoardHealthStatus) {
  switch (status) {
    case "healthy":
      return "success-light" as const;
    case "warning":
      return "warning-light" as const;
    case "offline":
      return "destructive-light" as const;
    default:
      return "outline" as const;
  }
}

function statusBadgeVariant(status: string) {
  if (status === "online") return "success-light" as const;
  if (status === "offline" || status === "disconnected") return "destructive-light" as const;
  if (status === "updating" || status === "reset_pending") return "warning-light" as const;
  return "outline" as const;
}

function formatWhen(value: string | null | undefined, timezone: string): string {
  if (!value) return "—";
  return formatTimestamp(value, timezone);
}

function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function hardwareLabel(board: MonitoredBoard): string {
  const profile = board.board_profile ?? board.custom_board_profile;
  if (profile) return `${profile.manufacturer} ${profile.model}`;
  return board.board_model || "Unknown hardware";
}

function chipLabel(board: MonitoredBoard): string {
  const profile = board.board_profile ?? board.custom_board_profile;
  const family = profile?.chip_family ?? board.chip_variant ?? "";
  return [family, board.chip_variant].filter(Boolean).join(" · ") || "—";
}

type Field = { label: string; value: ReactNode };

function FieldGroup({ title, fields }: { title: string; fields: Field[] }) {
  const shown = fields.filter(
    (f) => f.value !== null && f.value !== undefined && f.value !== "" && f.value !== "—"
  );
  if (shown.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((field) => (
          <div
            key={field.label}
            className="rounded-lg border bg-muted/30 px-3 py-2"
          >
            <dt className="text-[11px] text-muted-foreground">{field.label}</dt>
            <dd className="mt-0.5 break-words text-sm font-medium text-foreground">
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function PaginationControls({
  page,
  totalPages,
  total,
  pageSize,
  onPage,
  onPageSize,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-muted-foreground">
      <span className="tabular-nums">
        Page {page} of {totalPages} · {total} total
      </span>
      <div className="flex items-center gap-2">
        {onPageSize && (
          <Select
            value={String(pageSize)}
            onValueChange={(v) => onPageSize(Number(v))}
          >
            <SelectTrigger className="h-7 w-24 text-xs" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="10">10 / page</SelectItem>
              <SelectItem value="25">25 / page</SelectItem>
              <SelectItem value="50">50 / page</SelectItem>
            </SelectContent>
          </Select>
        )}
        <Button
          variant="outline"
          size="xs"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

interface EntityPage {
  items: Array<Record<string, unknown>>;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

function useEntityPage(
  accountId: string,
  boardId: string | null,
  kind: "devices" | "sensors" | "switches",
  page: number
) {
  const [data, setData] = useState<EntityPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!boardId) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void apiFetch<EntityPage>(
      `/api/admin/accounts/${accountId}/boards/${boardId}/${kind}?page=${page}&pageSize=25`
    )
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Failed to load.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, boardId, kind, page]);

  return { data, loading, error };
}

function BoardDetailsDialog({
  accountId,
  boardId,
  onClose,
}: {
  accountId: string;
  boardId: string | null;
  onClose: () => void;
}) {
  const timezone = useEffectiveTimezone();
  const [detail, setDetail] = useState<BoardDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("overview");
  const [devicesPage, setDevicesPage] = useState(1);
  const [sensorsPage, setSensorsPage] = useState(1);
  const [switchesPage, setSwitchesPage] = useState(1);

  useEffect(() => {
    if (!boardId) {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTab("overview");
    setDevicesPage(1);
    setSensorsPage(1);
    setSwitchesPage(1);
    void apiFetch<BoardDetailData>(
      `/api/admin/accounts/${accountId}/boards/${boardId}`
    )
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Failed to load board details.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, boardId]);

  const devices = useEntityPage(accountId, boardId, "devices", devicesPage);
  const sensors = useEntityPage(accountId, boardId, "sensors", sensorsPage);
  const switches = useEntityPage(accountId, boardId, "switches", switchesPage);

  const board = detail?.board ?? null;
  const profile = board ? (board.board_profile ?? board.custom_board_profile) : null;

  return (
    <Dialog open={Boolean(boardId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {board ? `${board.name} — Board Details (Read-only)` : "Board Details (Read-only)"}
          </DialogTitle>
          <DialogDescription>
            Complete recorded information for this board. Administrators cannot control
            customer hardware from here — there are no device controls, configuration
            editors, or firmware actions on this view.
          </DialogDescription>
        </DialogHeader>

        {loading && !detail ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : error && !detail ? (
          <StatusAlert tone="danger" title="Could not load board details">
            {error}
          </StatusAlert>
        ) : board ? (
          <Tabs value={tab} onValueChange={setTab} className="space-y-4">
            <TabsList className="flex flex-wrap">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="devices">
                Devices ({board.counts.devices})
              </TabsTrigger>
              <TabsTrigger value="sensors">
                Sensors ({board.counts.sensors})
              </TabsTrigger>
              <TabsTrigger value="switches">
                Switches ({board.counts.switches})
              </TabsTrigger>
              <TabsTrigger value="firmware">Firmware & Activity</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={statusBadgeVariant(board.status)}>{board.status}</Badge>
                <Badge variant={healthBadgeVariant(board.health.status)}>
                  Health: {HEALTH_LABELS[board.health.status]}
                </Badge>
                <Badge variant="outline">
                  {board.board_role === "node" ? "Node" : "Controller"}
                </Badge>
                {board.available_update && (
                  <Badge variant="warning-light">
                    Update available: v{board.available_update.version}
                  </Badge>
                )}
              </div>

              {board.health.reasons.length > 0 && (
                <StatusAlert tone={board.health.status === "offline" ? "danger" : "warning"} title="Health reasons">
                  <ul className="list-disc space-y-1 pl-4">
                    {board.health.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </StatusAlert>
              )}
              {board.health.status === "unknown" && board.health.reasons.length === 0 && (
                <StatusAlert tone="info" title="Telemetry unavailable">
                  No heartbeat or communication telemetry is recorded for this board, so
                  its health cannot be confirmed. This is not a confirmed failure.
                </StatusAlert>
              )}

              <FieldGroup
                title="Identity & Hardware"
                fields={[
                  { label: "Board name", value: board.name },
                  {
                    label: "Board ID",
                    value: <span className="font-mono text-xs">{board.id}</span>,
                  },
                  {
                    label: "Hardware UID",
                    value: board.hardware_uid ? (
                      <span className="font-mono text-xs">{board.hardware_uid}</span>
                    ) : "—",
                  },
                  { label: "Model", value: hardwareLabel(board) },
                  { label: "Chip", value: chipLabel(board) },
                  { label: "Board slug", value: profile?.slug ?? board.reported_board_slug ?? "—" },
                  {
                    label: "Flash / PSRAM",
                    value: `${board.flash_size_mb} MB / ${board.psram_size_mb} MB`,
                  },
                  {
                    label: "Detected chip",
                    value: board.detected_chip_name ?? "—",
                  },
                  {
                    label: "Detected flash",
                    value:
                      board.detected_flash_size_mb != null
                        ? `${board.detected_flash_size_mb} MB`
                        : "—",
                  },
                  { label: "Room / location", value: board.room_name ?? "—" },
                  { label: "Home", value: board.home_name ?? "—" },
                  { label: "Registered", value: formatWhen(board.created_at, timezone) },
                ]}
              />

              <FieldGroup
                title="Connectivity & Heartbeat"
                fields={[
                  { label: "Status", value: board.status },
                  { label: "Pairing", value: board.pairing_status ?? "—" },
                  {
                    label: "Wi-Fi connected",
                    value:
                      board.wifi_connected == null
                        ? "Unknown"
                        : board.wifi_connected
                          ? "Yes"
                          : "No",
                  },
                  { label: "Wi-Fi SSID", value: board.wifi_ssid ?? "—" },
                  {
                    label: "Wi-Fi RSSI",
                    value: board.wifi_rssi != null ? `${board.wifi_rssi} dBm` : "—",
                  },
                  { label: "Local IP", value: board.local_ip ?? "—" },
                  {
                    label: "Last heartbeat",
                    value: formatWhen(board.last_heartbeat_at, timezone),
                  },
                  {
                    label: "Last communication",
                    value: formatWhen(board.last_communication_at, timezone),
                  },
                  {
                    label: "Wi-Fi last connected",
                    value: formatWhen(board.wifi_last_connected_at, timezone),
                  },
                  {
                    label: "MQTT last connected",
                    value: formatWhen(board.mqtt_last_connected_at, timezone),
                  },
                  {
                    label: "Heartbeat interval",
                    value:
                      board.heartbeat_interval_sec != null
                        ? `${board.heartbeat_interval_sec}s`
                        : "—",
                  },
                  {
                    label: "Paired at",
                    value: formatWhen(board.paired_at, timezone),
                  },
                ]}
              />

              <FieldGroup
                title="MQTT (recorded state only)"
                fields={[
                  {
                    label: "MQTT connected",
                    value: board.mqtt_connected ? "Yes" : "No",
                  },
                  {
                    label: "MQTT username",
                    value: board.mqtt?.mqtt_username ? (
                      <span className="font-mono text-xs">{board.mqtt.mqtt_username}</span>
                    ) : "—",
                  },
                  {
                    label: "MQTT client ID",
                    value: board.mqtt?.mqtt_client_id ? (
                      <span className="font-mono text-xs">{board.mqtt.mqtt_client_id}</span>
                    ) : "—",
                  },
                  {
                    label: "Topic prefix",
                    value: board.mqtt?.topic_prefix ? (
                      <span className="font-mono text-xs">{board.mqtt.topic_prefix}</span>
                    ) : "—",
                  },
                  {
                    label: "EMQX synced",
                    value: board.mqtt ? (board.mqtt.emqx_synced ? "Yes" : "No") : "—",
                  },
                  { label: "Credential status", value: board.mqtt?.status ?? "—" },
                  {
                    label: "Last rotated",
                    value: formatWhen(board.mqtt?.last_rotated_at, timezone),
                  },
                ]}
              />

              <FieldGroup
                title="Configuration (recorded revisions)"
                fields={[
                  {
                    label: "Config revision",
                    value: board.config_revision != null ? String(board.config_revision) : "—",
                  },
                  {
                    label: "Last synced revision",
                    value:
                      board.last_synced_config_revision != null
                        ? String(board.last_synced_config_revision)
                        : "—",
                  },
                  {
                    label: "Pending sync",
                    value: board.pending_config_sync ? "Yes" : "No",
                  },
                  {
                    label: "Last config published",
                    value: formatWhen(board.last_config_published_at, timezone),
                  },
                  {
                    label: "Last config synced",
                    value: formatWhen(board.last_config_synced_at, timezone),
                  },
                  {
                    label: "Config hash",
                    value: board.config_hash ? (
                      <span className="font-mono text-xs">{board.config_hash}</span>
                    ) : "—",
                  },
                ]}
              />

              <FieldGroup
                title="Role & Links"
                fields={[
                  { label: "Role", value: board.board_role === "node" ? "Node" : "Controller" },
                  { label: "Comm mode", value: board.comm_mode ?? "—" },
                  { label: "Node link state", value: board.node_link_state ?? "—" },
                  {
                    label: "Assigned Controller",
                    value: board.assigned_controller_name ?? board.assigned_controller_id ?? "—",
                  },
                  {
                    label: "Attached Nodes (linked & online)",
                    value: String(board.attached_node_count ?? 0),
                  },
                  {
                    label: "Provisioning transport",
                    value: board.provisioning_transport ?? "—",
                  },
                ]}
              />

              {detail?.parentBoard && (
                <p className="text-xs text-muted-foreground">
                  Uplink Controller: {detail.parentBoard.name} ({detail.parentBoard.status})
                </p>
              )}
              {detail && detail.attachedNodes.length > 0 && (
                <section className="space-y-1.5">
                  <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Attached Nodes
                  </h4>
                  <ul className="space-y-1 text-xs">
                    {detail.attachedNodes.map((node) => (
                      <li key={String(node.id)} className="rounded-lg border px-3 py-2">
                        <span className="font-medium">{String(node.name ?? "Node")}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {String(node.status ?? "")} · {String(node.node_link_state ?? "unassigned")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {board.last_error && (
                <StatusAlert tone="warning" title="Last recorded board error">
                  {board.last_error}
                  {board.last_error_at
                    ? ` (${formatWhen(board.last_error_at, timezone)})`
                    : ""}
                </StatusAlert>
              )}

              {board.connection_history && board.connection_history.length > 0 && (
                <section className="space-y-1.5">
                  <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Connection History (recent)
                  </h4>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {board.connection_history.slice(-10).map((entry, index) => (
                      <li key={`${entry.event}-${entry.at}-${index}`}>
                        {entry.event} · {formatWhen(entry.at, timezone)}
                        {entry.ip ? ` · ${entry.ip}` : ""}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </TabsContent>

            <TabsContent value="devices" className="space-y-3">
              {devices.loading ? (
                <Skeleton className="h-24 w-full" />
              ) : devices.error ? (
                <StatusAlert tone="danger" title="Could not load devices">{devices.error}</StatusAlert>
              ) : !devices.data || devices.data.items.length === 0 ? (
                <EmptyStatePanel
                  icon={<RiLightbulbLine />}
                  title="No devices on this board"
                  description="This board has no registered devices."
                  compact
                />
              ) : (
                <Card className="overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Device</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>GPIO</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Online</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {devices.data.items.map((d) => (
                        <TableRow key={String(d.id)}>
                          <TableCell className="font-medium">{String(d.name ?? "—")}</TableCell>
                          <TableCell>{String(d.device_type ?? "—")}</TableCell>
                          <TableCell className="tabular-nums">GPIO{String(d.gpio_pin ?? "—")}</TableCell>
                          <TableCell>{String(d.state ?? "—")}</TableCell>
                          <TableCell>
                            <Badge variant={d.is_online ? "success-light" : "outline"}>
                              {d.is_online ? "Online" : "Offline"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <PaginationControls
                    page={devices.data.pagination.page}
                    totalPages={devices.data.pagination.totalPages}
                    total={devices.data.pagination.total}
                    pageSize={devices.data.pagination.pageSize}
                    onPage={setDevicesPage}
                  />
                </Card>
              )}
            </TabsContent>

            <TabsContent value="sensors" className="space-y-3">
              {sensors.loading ? (
                <Skeleton className="h-24 w-full" />
              ) : sensors.error ? (
                <StatusAlert tone="danger" title="Could not load sensors">{sensors.error}</StatusAlert>
              ) : !sensors.data || sensors.data.items.length === 0 ? (
                <EmptyStatePanel
                  icon={<RiSensorLine />}
                  title="No sensors on this board"
                  description="This board has no registered sensors."
                  compact
                />
              ) : (
                <Card className="overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Sensor</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>GPIO</TableHead>
                        <TableHead>Last value</TableHead>
                        <TableHead>Online</TableHead>
                        <TableHead>Last reading</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sensors.data.items.map((s) => (
                        <TableRow key={String(s.id)}>
                          <TableCell className="font-medium">{String(s.name ?? "—")}</TableCell>
                          <TableCell>{String(s.sensor_type ?? "—")}</TableCell>
                          <TableCell className="tabular-nums">
                            {s.gpio_pin != null ? `GPIO${String(s.gpio_pin)}` : "—"}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {s.last_value != null
                              ? `${String(s.last_value)} ${String(s.unit ?? "")}`.trim()
                              : "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant={s.is_online ? "success-light" : "outline"}>
                              {s.is_online ? "Online" : "Offline"}
                            </Badge>
                          </TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {formatWhen(s.last_reading_at as string | null, timezone)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <PaginationControls
                    page={sensors.data.pagination.page}
                    totalPages={sensors.data.pagination.totalPages}
                    total={sensors.data.pagination.total}
                    pageSize={sensors.data.pagination.pageSize}
                    onPage={setSensorsPage}
                  />
                </Card>
              )}
            </TabsContent>

            <TabsContent value="switches" className="space-y-3">
              {switches.loading ? (
                <Skeleton className="h-24 w-full" />
              ) : switches.error ? (
                <StatusAlert tone="danger" title="Could not load switches">{switches.error}</StatusAlert>
              ) : !switches.data || switches.data.items.length === 0 ? (
                <EmptyStatePanel
                  icon={<RiToggleLine />}
                  title="No switches on this board"
                  description="This board has no registered switches."
                  compact
                />
              ) : (
                <Card className="overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Switch</TableHead>
                        <TableHead>GPIO</TableHead>
                        <TableHead>State (read-only)</TableHead>
                        <TableHead>Online</TableHead>
                        <TableHead>Last changed</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {switches.data.items.map((s) => (
                        <TableRow key={String(s.id)}>
                          <TableCell className="font-medium">{String(s.name ?? "—")}</TableCell>
                          <TableCell className="tabular-nums">GPIO{String(s.gpio_pin ?? "—")}</TableCell>
                          <TableCell>
                            <Badge variant={s.is_on ? "info-light" : "outline"}>
                              {s.is_on ? "On" : "Off"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={s.is_online ? "success-light" : "outline"}>
                              {s.is_online ? "Online" : "Offline"}
                            </Badge>
                          </TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {formatWhen(s.last_changed_at as string | null, timezone)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <PaginationControls
                    page={switches.data.pagination.page}
                    totalPages={switches.data.pagination.totalPages}
                    total={switches.data.pagination.total}
                    pageSize={switches.data.pagination.pageSize}
                    onPage={setSwitchesPage}
                  />
                </Card>
              )}
            </TabsContent>

            <TabsContent value="firmware" className="space-y-4">
              <FieldGroup
                title="Firmware"
                fields={[
                  {
                    label: "Running firmware",
                    value: board.firmware_version ? `v${board.firmware_version}` : "Not reported",
                  },
                  {
                    label: "Installed release",
                    value: board.installed_release
                      ? `${board.installed_release.name} v${board.installed_release.version} (${board.installed_release.channel})`
                      : "—",
                  },
                  {
                    label: "Available update",
                    value: board.available_update
                      ? `${board.available_update.name} v${board.available_update.version} (${board.available_update.channel})`
                      : "None compatible / newer",
                  },
                  {
                    label: "Driver manifest hash",
                    value: board.reported_driver_manifest_hash ? (
                      <span className="font-mono text-xs">{board.reported_driver_manifest_hash}</span>
                    ) : "—",
                  },
                ]}
              />

              <section className="space-y-1.5">
                <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Firmware Update History
                </h4>
                {(detail?.firmwareHistory ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No firmware update history recorded for this board.
                  </p>
                ) : (
                  <Card className="overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Target</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Started</TableHead>
                          <TableHead>Completed</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(detail?.firmwareHistory ?? []).map((h) => (
                          <TableRow key={String(h.id)}>
                            <TableCell>
                              v{String(h.target_version ?? "—")}
                              {h.release && typeof h.release === "object"
                                ? ` · ${String((h.release as Record<string, unknown>).name ?? "")}`
                                : ""}
                            </TableCell>
                            <TableCell>{String(h.update_type ?? "—")}</TableCell>
                            <TableCell>
                              <Badge variant={h.status === "succeeded" ? "success-light" : h.status === "failed" ? "destructive-light" : "outline"}>
                                {String(h.status ?? "—")}
                              </Badge>
                            </TableCell>
                            <TableCell className="tabular-nums text-muted-foreground">
                              {formatWhen(h.started_at as string | null, timezone)}
                            </TableCell>
                            <TableCell className="tabular-nums text-muted-foreground">
                              {formatWhen(h.completed_at as string | null, timezone)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>
                )}
              </section>

              <section className="space-y-1.5">
                <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Recent Activity
                </h4>
                {(detail?.recentActivity ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No recent activity recorded for this board.
                  </p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {(detail?.recentActivity ?? []).map((entry) => (
                      <li key={entry.id} className="rounded-lg border px-3 py-2">
                        <span className="font-medium">{entry.summary}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {entry.action} · {formatWhen(entry.created_at, timezone)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </TabsContent>
          </Tabs>
        ) : null}
        <DialogFooter>
          <p className="mr-auto text-[11px] text-muted-foreground">
            Read-only monitoring — no device controls are available to administrators.
          </p>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdminCustomerDetailsPage({
  accountId,
  onNavigate,
}: {
  accountId: string;
  onNavigate?: (path: string) => void;
}) {
  const timezone = useEffectiveTimezone();
  const [data, setData] = useState<CustomerMonitoringData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<CustomerMonitoringData>(
        `/api/admin/accounts/${accountId}/monitoring?page=${page}&pageSize=${pageSize}`
      );
      if (!signal?.aborted) setData(res);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof ApiError ? err.message : "Failed to load customer monitoring data.");
      setData(null);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [accountId, page, pageSize]);

  // Reload when the scope changes or the admin presses Refresh.
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);

  const goBack = useCallback(() => {
    if (onNavigate) {
      onNavigate("/admin/accounts");
      return;
    }
    window.history.pushState({}, "", "/admin/accounts");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [onNavigate]);

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="space-y-4">
        <PageHeader
          eyebrow="Customer Monitoring"
          title="Customer Details"
          description="Read-only board and device monitoring for this customer account."
          actions={
            <Button variant="outline" size="sm" onClick={goBack}>
              <RiArrowLeftLine className="size-4" aria-hidden="true" />
              Back to Customer Accounts
            </Button>
          }
        />
        <StatusAlert tone="danger" title="Could not load customer monitoring data">
          {error}
        </StatusAlert>
        <Button variant="outline" size="sm" onClick={() => setRefreshKey((k) => k + 1)}>
          <RiRefreshLine className="size-4" aria-hidden="true" />
          Retry
        </Button>
      </div>
    );
  }

  if (!data) return null;

  const { account, owner, summary, health, boards, pagination } = data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Customer Monitoring · Read-only"
        title={account.name}
        description="Inspect this customer's boards, firmware, devices, sensors, switches and environment health. This page is monitoring-only: administrators cannot control customer hardware from here."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={goBack}>
              <RiArrowLeftLine className="size-4" aria-hidden="true" />
              Back to Customer Accounts
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRefreshKey((k) => k + 1)}
              disabled={loading}
            >
              <RiRefreshLine
                className={`size-4 ${loading ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              Refresh
            </Button>
          </div>
        }
      />

      <RecoveryHistory endpoint={`/api/admin/accounts/${accountId}/recovery-history`} />
      <StatusAlert tone="info" title="Read-only monitoring">
        You can observe and diagnose this customer's hardware environment, but you cannot
        switch devices, change configurations, restart boards, or install firmware from
        this page. No MQTT commands are published for admin monitoring.
      </StatusAlert>

      <Card>
        <CardContent className="flex flex-wrap items-start justify-between gap-4 pt-5">
          <div className="min-w-0 space-y-1">
            <p className="text-base font-semibold text-foreground">{account.name}</p>
            <p className="text-xs text-muted-foreground">
              {owner ? `${owner.full_name} · ${owner.email}` : "Owner details unavailable"}
            </p>
            <p className="font-mono text-[11px] text-muted-foreground">
              Account ID: {account.id}
            </p>
            <p className="font-mono text-[11px] text-muted-foreground">Slug: {account.slug}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                account.status === "active"
                  ? "success-light"
                  : account.status === "paused"
                    ? "warning-light"
                    : "destructive-light"
              }
            >
              {account.status}
            </Badge>
            <Badge variant={healthBadgeVariant(health.status)}>
              Environment: {HEALTH_LABELS[health.status]}
            </Badge>
          </div>
          <dl className="grid w-full gap-2 text-xs sm:grid-cols-3">
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <dt className="text-muted-foreground">Registered</dt>
              <dd className="mt-0.5 font-medium">{formatWhen(account.created_at, timezone)}</dd>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <dt className="text-muted-foreground">Last board sync</dt>
              <dd className="mt-0.5 font-medium">{formatWhen(summary.lastSyncAt, timezone)}</dd>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <dt className="text-muted-foreground">Last activity</dt>
              <dd className="mt-0.5 font-medium">{formatWhen(summary.lastActivityAt, timezone)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total boards"
          value={summary.totalBoards}
          sub={`${summary.controllers} controllers · ${summary.nodes} nodes`}
          icon={<RiCpuLine className="size-5" aria-hidden="true" />}
          tone="accent"
        />
        <StatCard
          label="Total devices"
          value={summary.totalDevices}
          sub="Registered devices"
          icon={<RiLightbulbLine className="size-5" aria-hidden="true" />}
          tone="neutral"
        />
        <StatCard
          label="Total sensors"
          value={summary.totalSensors}
          sub="Registered sensors"
          icon={<RiSensorLine className="size-5" aria-hidden="true" />}
          tone="neutral"
        />
        <StatCard
          label="Total switches"
          value={summary.totalSwitches}
          sub="Registered switches"
          icon={<RiToggleLine className="size-5" aria-hidden="true" />}
          tone="neutral"
        />
        <StatCard
          label="Online boards"
          value={summary.onlineBoards}
          sub="Status: online"
          icon={<RiShieldCheckLine className="size-5" aria-hidden="true" />}
          tone="success"
        />
        <StatCard
          label="Offline boards"
          value={summary.offlineBoards}
          sub="Not currently online"
          icon={<RiHardDrive2Line className="size-5" aria-hidden="true" />}
          tone={summary.offlineBoards > 0 ? "warning" : "neutral"}
        />
        <StatCard
          label="Last heartbeat"
          value={summary.lastHeartbeatAt ? formatWhen(summary.lastHeartbeatAt, timezone) : "—"}
          sub={`Timeout ${health.offlineTimeoutSeconds}s · Interval ${health.heartbeatIntervalSeconds}s`}
          icon={<RiRefreshLine className="size-5" aria-hidden="true" />}
          tone="neutral"
        />
        <StatCard
          label="Environment health"
          value={HEALTH_LABELS[health.status]}
          sub={`${health.counts.healthy} healthy · ${health.counts.warning} warning · ${health.counts.offline} offline · ${health.counts.unknown} unknown`}
          icon={<RiShieldCheckLine className="size-5" aria-hidden="true" />}
          tone={
            health.status === "healthy"
              ? "success"
              : health.status === "warning"
                ? "warning"
                : health.status === "offline"
                  ? "danger"
                  : "neutral"
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <RiEyeLine className="size-4" aria-hidden="true" />
            Environment Health
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            Verdicts are derived from recorded heartbeat, MQTT, Wi-Fi, configuration-sync,
            firmware and entity telemetry — a board is only Healthy with fresh heartbeat
            telemetry and no outstanding warnings. Missing telemetry is shown as Unknown,
            not as a confirmed failure.
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge variant="success-light">Healthy: {health.counts.healthy}</Badge>
            <Badge variant="warning-light">Warning: {health.counts.warning}</Badge>
            <Badge variant="destructive-light">Offline: {health.counts.offline}</Badge>
            <Badge variant="outline">Unknown: {health.counts.unknown}</Badge>
          </div>
          <p>
            Heartbeat timeout {health.offlineTimeoutSeconds}s · Expected heartbeat interval{" "}
            {health.heartbeatIntervalSeconds}s · All times shown in {timezone}.
          </p>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Board Inventory</h2>
          <span className="text-xs text-muted-foreground">
            {summary.totalBoards} board{summary.totalBoards === 1 ? "" : "s"} registered
          </span>
        </div>

        {summary.totalBoards === 0 ? (
          <EmptyStatePanel
            icon={<RiCpuLine />}
            title="No boards registered"
            description="This customer has not registered any HomecoreOS boards yet. Boards, firmware and health information will appear here once a board is paired."
            action={
              <Button variant="outline" size="sm" onClick={goBack}>
                <RiArrowLeftLine className="size-4" aria-hidden="true" />
                Back to Customer Accounts
              </Button>
            }
          />
        ) : boards.length === 0 ? (
          <EmptyStatePanel
            icon={<RiCpuLine />}
            title="No boards on this page"
            description="Try a different page, or go back to the first page."
            compact
          />
        ) : (
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Board</TableHead>
                  <TableHead>Hardware</TableHead>
                  <TableHead>Firmware</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last heartbeat</TableHead>
                  <TableHead>Last sync</TableHead>
                  <TableHead>Entities</TableHead>
                  <TableHead>Room</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {boards.map((board) => (
                  <TableRow key={board.id}>
                    <TableCell>
                      <p className="font-semibold text-foreground">{board.name}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        {shortId(board.id)}
                      </p>
                      <div className="mt-1">
                        <Badge variant="outline" size="xs">
                          {board.board_role === "node" ? "Node" : "Controller"}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <p className="text-xs font-medium">{hardwareLabel(board)}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        {chipLabel(board)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <p className="text-xs font-medium tabular-nums">
                        {board.firmware_version ? `v${board.firmware_version}` : "Not reported"}
                      </p>
                      {board.installed_release ? (
                        <p className="text-[11px] text-muted-foreground">
                          {board.installed_release.channel} · v{board.installed_release.version}
                        </p>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">No release linked</p>
                      )}
                      {board.available_update && (
                        <Badge variant="warning-light" size="xs" className="mt-1">
                          Update: v{board.available_update.version}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <Badge variant={statusBadgeVariant(board.status)} size="xs">
                          {board.status}
                        </Badge>
                        <Badge variant={healthBadgeVariant(board.health.status)} size="xs">
                          {HEALTH_LABELS[board.health.status]}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {formatWhen(board.last_heartbeat_at, timezone)}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {formatWhen(board.last_config_synced_at, timezone)}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      <span title="Devices (online)">
                        {board.counts.devices} dev ({board.counts.devicesOnline} on)
                      </span>
                      <br />
                      <span title="Sensors (online)">
                        {board.counts.sensors} sens ({board.counts.sensorsOnline} on)
                      </span>
                      <br />
                      <span title="Switches (online)">
                        {board.counts.switches} sw ({board.counts.switchesOnline} on)
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {board.room_name ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => setSelectedBoardId(board.id)}
                      >
                        <RiEyeLine className="size-3.5" aria-hidden="true" />
                        View Details
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <PaginationControls
              page={pagination.page}
              totalPages={pagination.totalPages}
              total={pagination.total}
              pageSize={pagination.pageSize}
              onPage={setPage}
              onPageSize={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          </Card>
        )}
      </section>

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <RiUserSettingsLine className="size-3.5" aria-hidden="true" />
        Monitoring data is loaded on demand only — no live polling or extra MQTT traffic is
        generated for this page. Use Refresh to reload recorded state.
      </p>

      <BoardDetailsDialog
        accountId={accountId}
        boardId={selectedBoardId}
        onClose={() => setSelectedBoardId(null)}
      />
    </div>
  );
}
