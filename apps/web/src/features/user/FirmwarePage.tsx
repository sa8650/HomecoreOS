import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiCloseCircleLine,
  RiCpuLine,
  RiDownloadLine,
  RiEyeLine,
  RiHistoryLine,
  RiLoader4Line,
  RiRefreshLine,
  RiShieldCheckLine,
  RiUsbLine,
} from "@remixicon/react";
import {
  chipFamilyLabel,
  compareFirmwareVersions,
  SUPPORTED_CHIP_FAMILIES,
} from "@homecoreos/shared";
import { toast } from "sonner";
import {
  apiFetch,
  ApiError,
  cachedGet,
  getCachedSnapshot,
  invalidateApiCache,
} from "@/lib/api";
import { formatTimestamp, useEffectiveTimezone } from "@/lib/timezone";
import { OtaProgressPipeline } from "@/components/firmware/FirmwareProgressPipeline";
import { Badge } from "@/components/reui/badge";
import { Frame, FramePanel } from "@/components/reui/frame";
import { EmptyStatePanel, StatusAlert } from "@/components/shared/AppUi";
import { FIRMWARE_HERO_ICONS } from "@/components/shared/HeroDomainIcons";
import { PageHeroHeader } from "@/components/shared/PageHeroHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MagicCard } from "@/components/ui/magic-card";
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
  ApplicableFirmwareUpdateItem,
  BoardProfileItem,
  FirmwareReleaseItem,
  FirmwareUpdateHistoryItem,
} from "@/features/types";

const ACTIVE_OTA_STATUSES = new Set([
  "pending",
  "downloading",
  "flashing",
  "verifying",
  "rebooting",
]);

export function FirmwarePage({
  canManage,
  onNavigate,
}: {
  canManage: boolean;
  onNavigate: (path: string) => void;
}) {
  const timezone = useEffectiveTimezone();
  const cachedRel = getCachedSnapshot<{ releases: FirmwareReleaseItem[] }>(
    "/api/firmware/releases"
  );
  const [activeTab, setActiveTab] = useState<"firmware" | "updates">("firmware");
  const [releases, setReleases] = useState<FirmwareReleaseItem[]>(
    () => cachedRel?.releases ?? []
  );
  const [boards, setBoards] = useState<BoardProfileItem[]>([]);
  const [applicableUpdates, setApplicableUpdates] = useState<ApplicableFirmwareUpdateItem[]>([]);
  const [history, setHistory] = useState<FirmwareUpdateHistoryItem[]>([]);
  const [loading, setLoading] = useState(!cachedRel);

  // Tab 1: Firmware Catalog filters, sorting & modals
  const [search, setSearch] = useState("");
  const [boardFilter, setBoardFilter] = useState("all");
  const [versionFilter, setVersionFilter] = useState("all");
  const [chipFilter, setChipFilter] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState<"name" | "version" | "published_at">("published_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [inspectRelease, setInspectRelease] = useState<FirmwareReleaseItem | null>(null);

  // Tab 2: OTA action state
  const [otaBusyControllerId, setOtaBusyControllerId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [firmwareDownloadsEnabled, setFirmwareDownloadsEnabled] = useState(true);

  const load = useCallback(async (force = false) => {
    if (!getCachedSnapshot("/api/firmware/releases")) {
      setLoading(true);
    }
    try {
      const [relRes, catRes, custRes, updRes] = await Promise.all([
        cachedGet<{
          releases: FirmwareReleaseItem[];
          firmwareDownloadsEnabled?: boolean;
        }>("/api/firmware/releases", {
          ttlMs: 60_000,
          force,
        }),
        cachedGet<{ boards: BoardProfileItem[] }>("/api/board-library/catalog", {
          ttlMs: 60_000,
          force,
        }).catch(() => ({
          boards: [] as BoardProfileItem[],
        })),
        cachedGet<{ boards: BoardProfileItem[] }>("/api/board-library/custom", {
          ttlMs: 60_000,
          force,
        }).catch(() => ({
          boards: [] as BoardProfileItem[],
        })),
        cachedGet<{
          applicableUpdates: ApplicableFirmwareUpdateItem[];
          history: FirmwareUpdateHistoryItem[];
        }>("/api/firmware/updates", { ttlMs: 15_000, force }).catch(async () => {
          const hist = await apiFetch<{ history: FirmwareUpdateHistoryItem[] }>(
            "/api/firmware/ota/history"
          );
          return {
            applicableUpdates: [] as ApplicableFirmwareUpdateItem[],
            history: hist.history,
          };
        }),
      ]);

      setReleases(relRes.releases);
      setFirmwareDownloadsEnabled(relRes.firmwareDownloadsEnabled ?? true);
      setBoards([...catRes.boards, ...custRes.boards]);
      setApplicableUpdates(updRes.applicableUpdates);
      setHistory(updRes.history);

    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load firmware.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasActiveOta = history.some(
    (h) => h.update_type === "ota" && ACTIVE_OTA_STATUSES.has(h.status)
  );
  useEffect(() => {
    if (!hasActiveOta) return;
    const timer = window.setInterval(async () => {
      try {
        const res = await apiFetch<{
          applicableUpdates: ApplicableFirmwareUpdateItem[];
          history: FirmwareUpdateHistoryItem[];
        }>("/api/firmware/updates");
        setApplicableUpdates(res.applicableUpdates);
        setHistory(res.history);
        invalidateApiCache("/api/firmware", "/api/board-instances");
      } catch {
        // ignore transient poll failures
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [hasActiveOta]);

  async function handleStartOta(boardInstanceId: string, releaseId: string) {
    setOtaBusyControllerId(boardInstanceId);
    try {
      await apiFetch("/api/firmware/ota/start", {
        method: "POST",
        body: JSON.stringify({ boardInstanceId, releaseId }),
      });
      toast.success(
        "Firmware update started. We will verify it automatically after your controller restarts."
      );
      invalidateApiCache("/api/firmware", "/api/board-instances");
      await load(true);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Could not start the firmware update."
      );
    } finally {
      setOtaBusyControllerId(null);
    }
  }

  async function handleCancelOta(historyId: string) {
    setCancellingId(historyId);
    try {
      await apiFetch(`/api/firmware/ota/${historyId}/cancel`, { method: "POST" });
      toast.success("Pending OTA update cancelled.");
      invalidateApiCache("/api/firmware", "/api/board-instances");
      await load(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to cancel OTA update.");
    } finally {
      setCancellingId(null);
    }
  }

  function handleSort(column: "name" | "version" | "published_at") {
    if (sortKey === column) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(column);
      setSortDir(column === "name" ? "asc" : "desc");
    }
  }

  const versionOptions = useMemo(
    () => Array.from(new Set(releases.map((r) => r.version))),
    [releases]
  );

  const selectedBoardProfile = useMemo(
    () => boards.find((b) => b.id === boardFilter) ?? null,
    [boards, boardFilter]
  );

  const filteredReleases = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = releases.filter((r) => {
      if (chipFilter !== "all" && r.chip_family !== chipFilter) return false;
      if (channelFilter !== "all" && r.channel !== channelFilter) return false;
      if (versionFilter !== "all" && r.version !== versionFilter) return false;
      if (statusFilter === "usb" && !r.usb_available) return false;
      if (statusFilter === "ota" && !r.ota_available) return false;
      if (selectedBoardProfile) {
        const hasExplicitIds = r.compatible_board_ids.length > 0;
        const hasExplicitSlugs = (r.compatible_board_slugs?.length ?? 0) > 0;
        const matchesExplicit =
          r.compatible_board_ids.includes(selectedBoardProfile.id) ||
          Boolean(r.compatible_board_slugs?.includes(selectedBoardProfile.slug));
        if (hasExplicitIds || hasExplicitSlugs) {
          if (!matchesExplicit) return false;
        } else {
          if (r.chip_family !== selectedBoardProfile.chip_family) return false;
          if (
            selectedBoardProfile.firmware_status &&
            selectedBoardProfile.firmware_status !== "firmware_supported"
          ) {
            return false;
          }
        }
      }
      if (q) {
        const boardNames = (r.compatible_boards ?? [])
          .map((b) => `${b.manufacturer} ${b.model}`)
          .join(" ");
        const hay = `${r.name} ${r.version} ${r.release_notes ?? ""} ${r.chip_family} ${boardNames}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const sorted = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") {
        cmp = a.name.localeCompare(b.name);
      } else if (sortKey === "version") {
        cmp = compareFirmwareVersions(a.version, b.version);
      } else {
        const ta = a.published_at ? Date.parse(a.published_at) : 0;
        const tb = b.published_at ? Date.parse(b.published_at) : 0;
        cmp = ta - tb;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [
    releases,
    search,
    chipFilter,
    channelFilter,
    versionFilter,
    statusFilter,
    selectedBoardProfile,
    sortKey,
    sortDir,
  ]);

  if (loading && releases.length === 0) {
    return (
      <div className="py-12 text-center text-xs text-muted-foreground">
        Loading firmware catalog & update status...
      </div>
    );
  }

  const hasActiveFilters =
    Boolean(search.trim()) ||
    boardFilter !== "all" ||
    versionFilter !== "all" ||
    chipFilter !== "all" ||
    channelFilter !== "all" ||
    statusFilter !== "all";

  return (
    <div className="space-y-6">
      <PageHeroHeader
        tone="red"
        ariaLabel="Firmware Header"
        title="Firmware & Updates"
        subtitle={
          <>
            Download verified{" "}
            <span className="font-medium text-foreground/85">
              HomecoreOS ESP-IDF Factory Releases
            </span>{" "}
            or deploy{" "}
            <br className="hidden sm:inline" />
            <span className="font-semibold text-rose-700 dark:text-rose-400">
              Signed OTA Updates
            </span>{" "}
            to paired household controllers
          </>
        }
        leftIcons={FIRMWARE_HERO_ICONS.left}
        rightIcons={FIRMWARE_HERO_ICONS.right}
        searchValue={search}
        onSearchChange={(next) => {
          setSearch(next);
          if (next && activeTab !== "firmware") {
            setActiveTab("firmware");
          }
        }}
        searchAriaLabel="Search firmware"
        searchPlaceholder="Search release name, version, board, or notes..."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void load(true)}>
              <RiRefreshLine className="size-4" aria-hidden="true" />
              Refresh
            </Button>
          </>
        }
      />

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "firmware" | "updates")}
        className="space-y-5"
      >
        <TabsList>
          <TabsTrigger value="firmware">
            <RiUsbLine className="size-3.5" aria-hidden="true" />
            Firmware ({releases.length})
          </TabsTrigger>
          <TabsTrigger value="updates">
            <RiShieldCheckLine className="size-3.5" aria-hidden="true" />
            Updates ({applicableUpdates.length})
          </TabsTrigger>
        </TabsList>

        {/* TAB 1: FIRMWARE CATALOG (ReUI Table 12/13) */}
        <TabsContent value="firmware" className="space-y-5">
          <Frame spacing="sm">
            <FramePanel className="py-2.5">
              <div
                data-testid="firmware-filter-bar"
                className="flex flex-wrap items-center gap-2 lg:flex-nowrap"
              >
                <Select value={boardFilter} onValueChange={setBoardFilter}>
                  <SelectTrigger
                    aria-label="Filter by board compatibility"
                    size="sm"
                    className="w-full min-w-0 sm:w-auto sm:flex-1 lg:min-w-[130px]"
                  >
                    <SelectValue placeholder="All Boards" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Boards</SelectItem>
                    {boards.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.manufacturer} {b.model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={versionFilter} onValueChange={setVersionFilter}>
                  <SelectTrigger
                    aria-label="Filter by version"
                    size="sm"
                    className="w-full min-w-0 sm:w-auto sm:flex-1 lg:min-w-[110px]"
                  >
                    <SelectValue placeholder="All Versions" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Versions</SelectItem>
                    {versionOptions.map((v) => (
                      <SelectItem key={v} value={v}>
                        v{v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={channelFilter} onValueChange={setChannelFilter}>
                  <SelectTrigger
                    aria-label="Filter by channel"
                    size="sm"
                    className="w-full min-w-0 sm:w-auto sm:flex-1 lg:min-w-[110px]"
                  >
                    <SelectValue placeholder="All Channels" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Channels</SelectItem>
                    <SelectItem value="stable">Stable</SelectItem>
                    <SelectItem value="beta">Beta</SelectItem>
                    <SelectItem value="development">Development</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger
                    aria-label="Filter by artifact type"
                    size="sm"
                    className="w-full min-w-0 sm:w-auto sm:flex-1 lg:min-w-[110px]"
                  >
                    <SelectValue placeholder="All Artifacts" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Artifacts</SelectItem>
                    <SelectItem value="usb">USB Flashable</SelectItem>
                    <SelectItem value="ota">OTA Ready</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={chipFilter} onValueChange={setChipFilter}>
                  <SelectTrigger
                    aria-label="Filter chip"
                    size="sm"
                    className="w-full min-w-0 sm:w-auto sm:flex-1 lg:min-w-[110px]"
                  >
                    <SelectValue placeholder="All Chips" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Chips</SelectItem>
                    {SUPPORTED_CHIP_FAMILIES.map((chip) => (
                      <SelectItem key={chip} value={chip}>
                        {chipFamilyLabel(chip)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground lg:pl-1">
                  <span
                    data-testid="firmware-total-count"
                    className="tabular-nums text-[11px]"
                  >
                    Showing {filteredReleases.length} of {releases.length} releases
                  </span>
                  {hasActiveFilters && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        setSearch("");
                        setBoardFilter("all");
                        setVersionFilter("all");
                        setChipFilter("all");
                        setChannelFilter("all");
                        setStatusFilter("all");
                      }}
                    >
                      Clear Filters
                    </Button>
                  )}
                </div>
              </div>
            </FramePanel>

            {filteredReleases.length === 0 ? (
              <FramePanel>
                <EmptyStatePanel
                  compact
                  icon={<RiCpuLine />}
                  title={
                    releases.length === 0
                      ? "No firmware releases published yet"
                      : "No firmware releases match your filters"
                  }
                  description={
                    releases.length === 0
                      ? "Platform administrators publish verified HomecoreOS ESP-IDF factory and OTA firmware binaries here."
                      : "Adjust your board compatibility, version, channel, or search filters to view available firmware."
                  }
                  action={
                    hasActiveFilters ? (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setSearch("");
                          setBoardFilter("all");
                          setVersionFilter("all");
                          setChipFilter("all");
                          setChannelFilter("all");
                          setStatusFilter("all");
                        }}
                      >
                        Reset Filters
                      </Button>
                    ) : undefined
                  }
                />
              </FramePanel>
            ) : (
              <MagicCard
                mode="orb"
                spotlightTone="red"
                className="rounded-(--frame-panel-radius) p-0"
              >
                <FramePanel className="overflow-hidden border-0 bg-transparent p-0">
                  <Table className="text-xs">
                  <TableHeader className="bg-muted/60">
                    <TableRow>
                      <TableHead>
                        <button
                          type="button"
                          onClick={() => handleSort("name")}
                          className="inline-flex items-center gap-1 font-semibold hover:text-foreground cursor-pointer"
                        >
                          Release
                          {sortKey === "name" &&
                            (sortDir === "asc" ? (
                              <RiArrowUpSLine className="size-3.5" />
                            ) : (
                              <RiArrowDownSLine className="size-3.5" />
                            ))}
                        </button>
                      </TableHead>
                      <TableHead>
                        <button
                          type="button"
                          onClick={() => handleSort("version")}
                          className="inline-flex items-center gap-1 font-semibold hover:text-foreground cursor-pointer"
                        >
                          Version
                          {sortKey === "version" &&
                            (sortDir === "asc" ? (
                              <RiArrowUpSLine className="size-3.5" />
                            ) : (
                              <RiArrowDownSLine className="size-3.5" />
                            ))}
                        </button>
                      </TableHead>
                      <TableHead>Chip / Channel</TableHead>
                      <TableHead>Compatible Boards</TableHead>
                      <TableHead>Artifacts</TableHead>
                      <TableHead>
                        <button
                          type="button"
                          onClick={() => handleSort("published_at")}
                          className="inline-flex items-center gap-1 font-semibold hover:text-foreground cursor-pointer"
                        >
                          Published ({timezone})
                          {sortKey === "published_at" &&
                            (sortDir === "asc" ? (
                              <RiArrowUpSLine className="size-3.5" />
                            ) : (
                              <RiArrowDownSLine className="size-3.5" />
                            ))}
                        </button>
                      </TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredReleases.map((rel) => {
                      const matchingBoards =
                        rel.compatible_boards && rel.compatible_boards.length > 0
                          ? rel.compatible_boards
                          : boards.filter((b) =>
                              rel.compatible_board_ids.length > 0
                                ? rel.compatible_board_ids.includes(b.id)
                                : b.chip_family === rel.chip_family
                            );
                      return (
                        <TableRow key={rel.id}>
                          <TableCell className="max-w-[260px] whitespace-normal">
                            <p className="truncate font-semibold text-foreground">{rel.name}</p>
                            <p className="truncate text-[11px] text-muted-foreground">
                              {rel.release_notes || "Verified ESP-IDF production image."}
                            </p>
                          </TableCell>
                          <TableCell>
                            <Badge variant="primary-light" className="font-mono">
                              v{rel.version}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant="secondary">{chipFamilyLabel(rel.chip_family)}</Badge>
                              <Badge
                                variant={
                                  rel.channel === "stable"
                                    ? "success-light"
                                    : rel.channel === "beta"
                                      ? "warning-light"
                                      : "secondary"
                                }
                              >
                                {rel.channel}
                              </Badge>
                              {rel.hardware_verified && (
                                <Badge variant="success-light" size="xs">
                                  Verified
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="max-w-[220px] whitespace-normal">
                            <div className="flex flex-wrap gap-1">
                              {matchingBoards.length > 0 ? (
                                matchingBoards.slice(0, 3).map((b) => (
                                  <Badge key={b.id} variant="outline" size="xs">
                                    {b.model}
                                  </Badge>
                                ))
                              ) : (
                                <span className="text-[11px] text-muted-foreground">
                                  {rel.chip_family.toUpperCase()} family
                                </span>
                              )}
                              {matchingBoards.length > 3 && (
                                <Badge variant="secondary" size="xs">
                                  +{matchingBoards.length - 3}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {rel.usb_available && <Badge variant="success-light">USB Factory</Badge>}
                              {rel.ota_available && <Badge variant="primary-light">OTA Ready</Badge>}
                            </div>
                          </TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {rel.published_at ? formatTimestamp(rel.published_at, timezone) : "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex flex-wrap justify-end gap-1.5">
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() => setInspectRelease(rel)}
                              >
                                <RiEyeLine className="size-3.5" aria-hidden="true" />
                                Inspect Details
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                  </Table>
                </FramePanel>
              </MagicCard>
            )}
          </Frame>
        </TabsContent>

        {/* TAB 2: APPLICABLE CONTROLLER OTA UPDATES & UPDATE HISTORY */}
        <TabsContent value="updates" className="space-y-6">
          {applicableUpdates.length === 0 ? (
            <EmptyStatePanel
              icon={<RiShieldCheckLine />}
              tone="success"
              title="All controllers are up to date"
              description="Every paired controller in your household is already running the latest compatible firmware."
              action={
                <Button variant="outline" size="sm" onClick={() => onNavigate("/controllers")}>
                  <RiCpuLine className="size-4" aria-hidden="true" />
                  Go to Controllers
                </Button>
              }
            />
          ) : (
            <div className="space-y-4">
              {applicableUpdates.map((item) => {
                const active = item.activeUpdate;
                const isBusy = otaBusyControllerId === item.boardInstanceId;
                const canTrigger =
                  canManage &&
                  item.controllerStatus === "online" &&
                  !active &&
                  !isBusy;

                return (
                  <Card
                    key={item.boardInstanceId}
                    className="border-none p-0 shadow-none ring-0 transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md"
                  >
                    <MagicCard
                      mode="orb"
                      spotlightTone="red"
                      className="rounded-xl p-0"
                      contentClassName="py-4"
                    >
                      <CardContent className="space-y-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-semibold text-foreground">
                              {item.controllerName}
                            </h3>
                            <Badge variant="secondary">
                              {item.boardRole === "node" ? "Node" : "Controller"}
                            </Badge>
                            <Badge variant="secondary">{item.boardModel}</Badge>
                            <Badge
                              variant={
                                item.controllerStatus === "online"
                                  ? "success-light"
                                  : "warning-light"
                              }
                            >
                              {item.controllerStatus}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Current:{" "}
                            <span className="font-mono text-foreground">
                              {item.currentVersion ?? "Unknown"}
                            </span>{" "}
                            → Available:{" "}
                            <span className="font-mono font-semibold text-primary">
                              v{item.availableRelease.version}
                            </span>{" "}
                            ({item.availableRelease.channel})
                            {item.availableRelease.hardware_verified && (
                              <Badge variant="success-light" size="xs" className="ml-2">
                                Verified
                              </Badge>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {item.availableRelease.release_notes || "Verified update release"}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          {active?.status === "pending" && canManage && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={cancellingId === active.id}
                              onClick={() => void handleCancelOta(active.id)}
                            >
                              <RiCloseCircleLine className="size-4" aria-hidden="true" />
                              {cancellingId === active.id ? "Cancelling..." : "Cancel"}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            disabled={!canTrigger}
                            onClick={() =>
                              void handleStartOta(item.boardInstanceId, item.availableRelease.id)
                            }
                          >
                            {isBusy ? (
                              <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
                            ) : (
                              <RiShieldCheckLine className="size-4" aria-hidden="true" />
                            )}
                            {isBusy ? "Starting..." : active ? "Updating..." : "Update"}
                          </Button>
                        </div>
                      </div>

                      {item.controllerStatus !== "online" && !active && (
                        <StatusAlert tone="warning">
                          Your controller needs to be online before this update can start.
                        </StatusAlert>
                      )}

                      {active && (
                        <OtaProgressPipeline
                          update={active}
                          controllerName={item.controllerName}
                          onCancel={
                            active.status === "pending" && canManage
                              ? () => void handleCancelOta(active.id)
                              : undefined
                          }
                          onRetry={
                            canManage
                              ? () =>
                                  void handleStartOta(item.boardInstanceId, item.availableRelease.id)
                              : undefined
                          }
                        />
                      )}
                    </CardContent>
                    </MagicCard>
                  </Card>
                );
              })}
            </div>
          )}

          <Card className="border-none p-0 shadow-none ring-0">
            <MagicCard
              mode="orb"
              spotlightTone="red"
              className="rounded-xl p-0"
              contentClassName="flex flex-col gap-4 py-4"
            >
              <CardHeader className="border-b">
              <CardTitle className="flex items-center gap-2 text-sm">
                <RiHistoryLine className="size-4 text-muted-foreground" aria-hidden="true" />
                Update History
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {history.length === 0 ? (
                <EmptyStatePanel
                  compact
                  icon={<RiHistoryLine />}
                  tone="neutral"
                  title="No OTA or USB update history yet"
                  description="Completed, failed, rolled-back, and cancelled firmware updates for your controllers are logged here."
                />
              ) : (
                <div className="overflow-hidden rounded-lg border">
                  <Table className="text-xs">
                    <TableHeader className="bg-muted/60">
                      <TableRow>
                        <TableHead>Controller</TableHead>
                        <TableHead>Version Transition</TableHead>
                        <TableHead>Method</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Progress</TableHead>
                        <TableHead>Started ({timezone})</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.map((h) => (
                        <TableRow key={h.id}>
                          <TableCell className="font-medium text-foreground">
                            {h.controller_name ?? h.board_instance_id.slice(0, 8)}
                          </TableCell>
                          <TableCell className="font-mono">
                            {h.previous_version ? `${h.previous_version} → ` : ""}
                            {h.target_version}
                          </TableCell>
                          <TableCell>
                            {h.update_type === "ota"
                              ? "Wi-Fi Update"
                              : h.update_type === "usb_factory"
                                ? "USB Install"
                                : h.update_type}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                h.status === "succeeded"
                                  ? "success-light"
                                  : h.status === "rolled_back" || h.status === "failed"
                                    ? "destructive-light"
                                    : h.status === "cancelled"
                                      ? "secondary"
                                      : "primary-light"
                              }
                            >
                              {h.status === "succeeded"
                                ? "Up to date"
                                : h.status === "rolled_back"
                                  ? "Restored previous"
                                  : h.status === "failed"
                                    ? "Not completed"
                                    : h.status === "cancelled"
                                      ? "Cancelled"
                                      : h.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono tabular-nums">
                            {h.progress_percent}%
                          </TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {formatTimestamp(h.started_at, timezone)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
            </MagicCard>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ReUI Table 17 Details Inspector Dialog */}
      <Dialog
        open={Boolean(inspectRelease)}
        onOpenChange={(open) => !open && setInspectRelease(null)}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto overflow-x-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <span className="break-words">{inspectRelease?.name}</span>
              {inspectRelease && (
                <Badge variant="primary-light" className="shrink-0 font-mono">
                  v{inspectRelease.version}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {firmwareDownloadsEnabled
                ? "Compatible controllers, release summary, and downloadable files."
                : "Compatible controllers, release summary, and artifact details."}
            </DialogDescription>
          </DialogHeader>
          {inspectRelease && (
            <div className="min-w-0 space-y-4 text-xs">
              {!firmwareDownloadsEnabled && (
                <div
                  data-testid="firmware-downloads-disabled-notice"
                  className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground"
                >
                  Direct firmware file downloads are currently disabled by the platform administrator. Controllers can still be set up and flashed from the Controllers page, and updated over Wi-Fi OTA.
                </div>
              )}
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge variant="secondary">{chipFamilyLabel(inspectRelease.chip_family)}</Badge>
                <Badge variant="outline">{inspectRelease.channel}</Badge>
                {inspectRelease.hardware_verified && (
                  <Badge variant="success-light">Verified</Badge>
                )}
                {inspectRelease.published_at && (
                  <span className="text-muted-foreground tabular-nums">
                    Published {formatTimestamp(inspectRelease.published_at, timezone)}
                  </span>
                )}
              </div>

              <p className="break-words text-muted-foreground [overflow-wrap:anywhere]">
                {inspectRelease.release_notes || "Production ESP-IDF release."}
              </p>

              <div className="min-w-0 space-y-1.5">
                <p className="font-semibold text-foreground">Compatible Boards</p>
                <div className="flex min-w-0 flex-wrap gap-1.5">
                  {(inspectRelease.compatible_boards &&
                  inspectRelease.compatible_boards.length > 0
                    ? inspectRelease.compatible_boards
                    : boards.filter((b) =>
                        inspectRelease.compatible_board_ids.length > 0
                          ? inspectRelease.compatible_board_ids.includes(b.id)
                          : b.chip_family === inspectRelease.chip_family
                      )
                  ).map((b) => (
                    <Badge key={b.id} variant="secondary" size="sm" className="max-w-full whitespace-normal">
                      <RiCpuLine className="size-3 shrink-0" aria-hidden="true" />
                      <span className="break-words">
                        {b.manufacturer} {b.model} ({b.flash_size_mb}MB)
                      </span>
                    </Badge>
                  ))}
                </div>
              </div>

              <Frame spacing="xs">
                <FramePanel className="min-w-0 divide-y overflow-hidden p-0">
                  {inspectRelease.files.map((f) => (
                    <div
                      key={f.id}
                      data-testid={`inspect-artifact-${f.id}`}
                      className="flex min-w-0 flex-col gap-2.5 p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <p className="font-mono text-xs font-semibold text-foreground break-all">
                            {f.file_name}
                          </p>
                          <Badge variant="secondary" size="xs" className="shrink-0 font-mono">
                            {f.file_type}
                          </Badge>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
                          <span>Offset: {f.flash_address ?? "—"}</span>
                          {f.flash_size && <span>Flash: {f.flash_size}</span>}
                          <span className="tabular-nums">
                            {Math.round(f.size_bytes / 1024)} KB
                          </span>
                        </div>
                        <p className="font-mono text-[10px] text-muted-foreground break-all">
                          SHA-256: {f.sha256}
                        </p>
                      </div>
                      <div className="shrink-0">
                        {firmwareDownloadsEnabled ? (
                          <Button variant="outline" size="xs" asChild>
                            <a href={`/api/firmware/files/${f.id}/download`}>
                              <RiDownloadLine className="size-3" aria-hidden="true" />
                              Download
                            </a>
                          </Button>
                        ) : (
                          <Badge variant="secondary" size="xs">
                            Downloads Off
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </FramePanel>
              </Frame>
            </div>
          )}
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => setInspectRelease(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
