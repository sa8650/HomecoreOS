import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RiArrowDownSLine,
  RiArrowLeftLine,
  RiArrowRightLine,
  RiArrowUpSLine,
  RiCheckDoubleLine,
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
  supportsBleProvisioningForBoard,
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
import { isWebSerialSupported } from "@/lib/usb-flasher";
import { useUsbFlashSession } from "@/lib/use-usb-flash";
import {
  OtaProgressPipeline,
  UsbFlashIllustration,
  UsbFlashStagePipeline,
} from "@/components/firmware/FirmwareProgressPipeline";
import { Badge } from "@/components/reui/badge";
import { Frame, FramePanel } from "@/components/reui/frame";
import { IconTile } from "@/components/reui/icon-tile";
import {
  EmptyStatePanel,
  FormField,
  StatusAlert,
} from "@/components/shared/AppUi";
import { FIRMWARE_HERO_ICONS } from "@/components/shared/HeroDomainIcons";
import { PageHeroHeader } from "@/components/shared/PageHeroHeader";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Label } from "@/components/ui/label";
import { Onboarding } from "@/components/ui/onboarding";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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

  // Tab 1: Dedicated Fresh Controller Web Serial USB Flasher Dialog
  const [usbDialogOpen, setUsbDialogOpen] = useState(false);
  const [confirmCloseFlash, setConfirmCloseFlash] = useState(false);
  const [usbStep, setUsbStep] = useState(1);
  const [usbReleaseId, setUsbReleaseId] = useState("");
  const [usbBoardSlug, setUsbBoardSlug] = useState("");
  const [eraseAll, setEraseAll] = useState(false);
  const {
    flashing,
    flashStage,
    flashPhase,
    flashProgress,
    flashLogs,
    chipDetected,
    flashSize,
    bytesWritten,
    totalBytes,
    flashError,
    capturedSetupInfo,
    startUsbFlash,
  } = useUsbFlashSession();

  // Tab 2: OTA action state
  const [otaBusyControllerId, setOtaBusyControllerId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const serialSupport = isWebSerialSupported();

  const load = useCallback(async (force = false) => {
    if (!getCachedSnapshot("/api/firmware/releases")) {
      setLoading(true);
    }
    try {
      const [relRes, catRes, custRes, updRes] = await Promise.all([
        cachedGet<{ releases: FirmwareReleaseItem[] }>("/api/firmware/releases", {
          ttlMs: 60_000,
          force,
        }),
        cachedGet<{ boards: BoardProfileItem[] }>("/api/boards/catalog", {
          ttlMs: 60_000,
          force,
        }).catch(() => ({
          boards: [] as BoardProfileItem[],
        })),
        cachedGet<{ boards: BoardProfileItem[] }>("/api/boards/custom", {
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
      setBoards([...catRes.boards, ...custRes.boards]);
      setApplicableUpdates(updRes.applicableUpdates);
      setHistory(updRes.history);

      const firstUsb = relRes.releases.find((r) => r.usb_available);
      setUsbReleaseId((prev) => prev || firstUsb?.id || "");
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
        invalidateApiCache("/api/firmware", "/api/controllers");
      } catch {
        // ignore transient poll failures
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [hasActiveOta]);

  async function handleStartOta(controllerId: string, releaseId: string) {
    setOtaBusyControllerId(controllerId);
    try {
      await apiFetch("/api/firmware/ota/start", {
        method: "POST",
        body: JSON.stringify({ controllerId, releaseId }),
      });
      toast.success(
        "Firmware update started. We will verify it automatically after your controller restarts."
      );
      invalidateApiCache("/api/firmware", "/api/controllers");
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
      invalidateApiCache("/api/firmware", "/api/controllers");
      await load(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to cancel OTA update.");
    } finally {
      setCancellingId(null);
    }
  }

  const selectedUsbRelease = useMemo(
    () => releases.find((r) => r.id === usbReleaseId) ?? null,
    [releases, usbReleaseId]
  );

  const usbMatchingBoards = useMemo(() => {
    if (!selectedUsbRelease) return [];
    if (
      selectedUsbRelease.compatible_boards &&
      selectedUsbRelease.compatible_boards.length > 0
    ) {
      return selectedUsbRelease.compatible_boards;
    }
    return boards.filter((b) =>
      selectedUsbRelease.compatible_board_ids.length > 0
        ? selectedUsbRelease.compatible_board_ids.includes(b.id)
        : b.chip_family === selectedUsbRelease.chip_family
    );
  }, [selectedUsbRelease, boards]);

  useEffect(() => {
    if (!selectedUsbRelease) {
      setUsbBoardSlug("");
      return;
    }
    const preferredSlug =
      selectedUsbRelease.target_board_slug ||
      usbMatchingBoards[0]?.slug ||
      "";
    setUsbBoardSlug((prev) =>
      prev && usbMatchingBoards.some((b) => b.slug === prev)
        ? prev
        : preferredSlug
    );
  }, [selectedUsbRelease, usbMatchingBoards]);

  const usbTargetBoard = useMemo(
    () =>
      boards.find((b) => b.slug === usbBoardSlug) ??
      usbMatchingBoards.find((b) => b.slug === usbBoardSlug) ??
      null,
    [boards, usbMatchingBoards, usbBoardSlug]
  );

  async function handleUsbFlash() {
    if (!selectedUsbRelease) return;
    setUsbStep(2);
    try {
      const result = await startUsbFlash({
        release: selectedUsbRelease,
        targetBoard: usbTargetBoard,
        eraseAll,
      });
      toast.success(`Firmware installed cleanly on ${result.chipDetected}.`);
      setUsbStep(3);
      invalidateApiCache("/api/firmware", "/api/controllers");
      await load(true);
    } catch {
      // hook state renders error inside UsbFlashStagePipeline
    }
  }

  function handleSelectReleaseForUsb(release: FirmwareReleaseItem) {
    setUsbReleaseId(release.id);
    setUsbStep(1);
    setActiveTab("firmware");
    setUsbDialogOpen(true);
  }

  function requestCloseUsbDialog() {
    if (flashing) {
      setConfirmCloseFlash(true);
      return;
    }
    setUsbDialogOpen(false);
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

  const usbReleases = releases.filter((r) => r.usb_available);

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
            Flash verified{" "}
            <span className="font-medium text-foreground/85">
              ESP-IDF Factory Releases over USB
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
            <Button
              size="sm"
              disabled={!canManage || usbReleases.length === 0}
              onClick={() => {
                if (!usbReleaseId && usbReleases[0]) setUsbReleaseId(usbReleases[0].id);
                setUsbStep(1);
                setUsbDialogOpen(true);
              }}
            >
              <RiUsbLine className="size-4" aria-hidden="true" />
              USB Browser Flasher
            </Button>
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

        {/* TAB 1: FIRMWARE CATALOG (ReUI Table 12/13) + DEDICATED USB FLASHER DIALOG */}
        <TabsContent value="firmware" className="space-y-5">
          <Frame spacing="sm">
            <FramePanel className="space-y-3">
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <Select value={boardFilter} onValueChange={setBoardFilter}>
                  <SelectTrigger aria-label="Filter by board compatibility" size="sm" className="w-full">
                    <SelectValue placeholder="Board" />
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
                  <SelectTrigger aria-label="Filter by version" size="sm" className="w-full">
                    <SelectValue placeholder="Version" />
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
                  <SelectTrigger aria-label="Filter by channel" size="sm" className="w-full">
                    <SelectValue placeholder="Channel" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Channels</SelectItem>
                    <SelectItem value="stable">Stable</SelectItem>
                    <SelectItem value="beta">Beta</SelectItem>
                    <SelectItem value="development">Development</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger aria-label="Filter by artifact type" size="sm" className="w-full">
                    <SelectValue placeholder="Artifact" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Artifacts</SelectItem>
                    <SelectItem value="usb">USB Flashable</SelectItem>
                    <SelectItem value="ota">OTA Ready</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                  <span>Chip filter:</span>
                  <Select value={chipFilter} onValueChange={setChipFilter}>
                    <SelectTrigger aria-label="Filter chip" size="sm" className="w-40">
                      <SelectValue />
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
                  <span className="tabular-nums text-[11px]">
                    Showing {filteredReleases.length} of {releases.length} releases
                  </span>
                </div>
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
                          <TableCell className="max-w-[260px]">
                            <p className="font-semibold text-foreground">{rel.name}</p>
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
                          <TableCell className="max-w-[220px]">
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
                              {rel.usb_available && (
                                <Button
                                  size="xs"
                                  disabled={!canManage}
                                  onClick={() => handleSelectReleaseForUsb(rel)}
                                >
                                  <RiUsbLine className="size-3.5" aria-hidden="true" />
                                  Install via USB
                                </Button>
                              )}
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
            />
          ) : (
            <div className="space-y-4">
              {applicableUpdates.map((item) => {
                const active = item.activeUpdate;
                const isBusy = otaBusyControllerId === item.controllerId;
                const canTrigger =
                  canManage &&
                  item.controllerStatus === "online" &&
                  !active &&
                  !isBusy;

                return (
                  <Card
                    key={item.controllerId}
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
                              void handleStartOta(item.controllerId, item.availableRelease.id)
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
                                  void handleStartOta(item.controllerId, item.availableRelease.id)
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
                            {h.controller_name ?? h.controller_id.slice(0, 8)}
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
              Compatible controllers, release summary, and downloadable files.
            </DialogDescription>
          </DialogHeader>
          {inspectRelease && (
            <div className="min-w-0 space-y-4 text-xs">
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
                        <Button variant="outline" size="xs" asChild>
                          <a href={`/api/firmware/files/${f.id}/download`}>
                            <RiDownloadLine className="size-3" aria-hidden="true" />
                            Download
                          </a>
                        </Button>
                      </div>
                    </div>
                  ))}
                </FramePanel>
              </Frame>
            </div>
          )}
          <DialogFooter className="flex-wrap gap-2">
            {inspectRelease?.usb_available && canManage && (
              <Button
                onClick={() => {
                  const target = inspectRelease;
                  setInspectRelease(null);
                  handleSelectReleaseForUsb(target);
                }}
              >
                <RiUsbLine className="size-4" aria-hidden="true" />
                Install via USB
              </Button>
            )}
            <Button variant="outline" onClick={() => setInspectRelease(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dedicated Browser USB Flasher Dialog with Active-Flash Close Protection */}
      <Dialog
        open={usbDialogOpen}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            setUsbDialogOpen(true);
          } else {
            requestCloseUsbDialog();
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto overflow-x-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5">
              <IconTile variant="solid" size="xs" className="shrink-0">
                <RiUsbLine className="size-4" aria-hidden="true" />
              </IconTile>
              <span className="min-w-0 break-words">
                Install on a Fresh Controller (Browser USB Flasher)
              </span>
            </DialogTitle>
            <DialogDescription>
              Connect your controller with a USB cable to automatically verify and install the
              firmware image.
            </DialogDescription>
          </DialogHeader>

          <Onboarding
            value={usbStep}
            onValueChange={setUsbStep}
            totalSteps={3}
            canGoNext={(s: number) =>
              s === 1 ? Boolean(usbReleaseId) : s === 2 ? flashStage === "completed" : true
            }
            onComplete={() => {
              setUsbDialogOpen(false);
              onNavigate("/controllers");
            }}
            className="min-w-0 space-y-4 overflow-hidden border-0 p-0 shadow-none"
          >
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <Onboarding.StepIndicator variant="pills" className="w-28" />
              <Badge
                variant={serialSupport.supported ? "success-light" : "warning-light"}
                radius="full"
              >
                {serialSupport.supported ? "Web Serial Ready" : "Unsupported Browser"}
              </Badge>
            </div>

            {!serialSupport.supported && (
              <StatusAlert tone="warning">{serialSupport.reason}</StatusAlert>
            )}

            <Onboarding.Step step={1} className="min-w-0 space-y-4">
              <UsbFlashIllustration />
              <FormField id="usb-rel" label="Factory Firmware Release">
                <Select
                  value={usbReleaseId || "__none__"}
                  onValueChange={(v) => setUsbReleaseId(v === "__none__" ? "" : v)}
                  disabled={usbReleases.length === 0 || flashing}
                >
                  <SelectTrigger
                    id="usb-rel"
                    className="w-full min-w-0 max-w-full [&_[data-slot=select-value]]:truncate"
                  >
                    <SelectValue placeholder="No USB factory releases published" />
                  </SelectTrigger>
                  <SelectContent>
                    {usbReleases.length === 0 && (
                      <SelectItem value="__none__">No USB factory releases published</SelectItem>
                    )}
                    {usbReleases.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name} v{r.version} ({chipFamilyLabel(r.chip_family)} · {r.channel})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              {usbMatchingBoards.length > 0 && (
                <FormField id="usb-board" label="Target Development Board">
                  <Select
                    value={usbBoardSlug || "__auto__"}
                    onValueChange={(v) => setUsbBoardSlug(v === "__auto__" ? "" : v)}
                    disabled={flashing}
                  >
                    <SelectTrigger
                      id="usb-board"
                      className="w-full min-w-0 max-w-full [&_[data-slot=select-value]]:truncate"
                    >
                      <SelectValue placeholder="Auto-detect compatible board" />
                    </SelectTrigger>
                    <SelectContent>
                      {usbMatchingBoards.map((b) => (
                        <SelectItem key={b.slug} value={b.slug}>
                          {b.manufacturer} {b.model} ({b.flash_size_mb}MB · BOOT GPIO
                          {b.boot_button_gpio ?? 0})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              )}

              {usbTargetBoard && (
                <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary" size="xs">
                      BOOT: GPIO{usbTargetBoard.boot_button_gpio ?? 0}
                    </Badge>
                    <Badge variant="outline" size="xs">
                      {usbTargetBoard.flash_size_mb}MB Flash
                    </Badge>
                    {usbTargetBoard.usb_interface && (
                      <Badge variant="outline" size="xs">
                        {usbTargetBoard.usb_interface}
                      </Badge>
                    )}
                    {usbTargetBoard.supports_wifi === false ? (
                      <Badge variant="warning-light" size="xs">
                        No Wi-Fi Radio
                      </Badge>
                    ) : supportsBleProvisioningForBoard(usbTargetBoard).supportsBle ? (
                      <Badge variant="info-light" size="xs">
                        BLE + Wi-Fi
                      </Badge>
                    ) : (
                      <Badge variant="outline" size="xs">
                        Setup AP Only (No BLE)
                      </Badge>
                    )}
                  </div>
                  <p className="text-[11px]">
                    If the serial port does not enter download mode automatically, hold{" "}
                    <strong className="text-foreground">
                      BOOT (GPIO{usbTargetBoard.boot_button_gpio ?? 0})
                    </strong>{" "}
                    and tap <strong className="text-foreground">RESET/EN</strong> before clicking
                    Connect.
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2.5">
                <Label htmlFor="usb-erase" className="cursor-pointer text-xs text-foreground">
                  Full chip erase before flashing
                </Label>
                <Switch
                  id="usb-erase"
                  checked={eraseAll}
                  disabled={flashing}
                  onCheckedChange={setEraseAll}
                />
              </div>

              <div className="flex justify-end">
                <Button
                  disabled={!canManage || !serialSupport.supported || !usbReleaseId || flashing}
                  onClick={() => void handleUsbFlash()}
                >
                  <RiUsbLine className="size-4" aria-hidden="true" />
                  Connect USB & Flash Factory Image
                </Button>
              </div>
            </Onboarding.Step>

            <Onboarding.Step step={2} className="min-w-0 space-y-4">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Automatic verification and USB installation progress.
                </p>
                <Button
                  size="sm"
                  disabled={!canManage || !serialSupport.supported || !usbReleaseId || flashing}
                  onClick={() => void handleUsbFlash()}
                >
                  {flashing ? (
                    <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <RiUsbLine className="size-4" aria-hidden="true" />
                  )}
                  {flashing ? "Flashing via USB..." : "Start / Retry USB Flash"}
                </Button>
              </div>
              <UsbFlashStagePipeline
                stage={flashStage}
                percent={flashProgress}
                phase={flashPhase}
                chipDetected={chipDetected}
                flashSize={flashSize}
                bytesWritten={bytesWritten}
                totalBytes={totalBytes}
                logs={flashLogs}
                error={flashError}
                onRetry={() => void handleUsbFlash()}
              />
            </Onboarding.Step>

            <Onboarding.Step step={3} className="min-w-0 space-y-3">
              <StatusAlert
                tone="success"
                title="Factory Firmware Verified & Flashed"
                action={
                  <Button
                    size="sm"
                    onClick={() => {
                      setUsbDialogOpen(false);
                      onNavigate("/controllers");
                    }}
                  >
                    Continue to Controllers
                    <RiArrowRightLine className="size-4" aria-hidden="true" />
                  </Button>
                }
              >
                Your controller rebooted with HomecoreOS firmware. Continue to the Controllers tab to choose Setup with BLE or Setup with Wi-Fi.
              </StatusAlert>
              {capturedSetupInfo?.bleName && (
                <StatusAlert tone="info" title="Controller Ready">
                  Bluetooth Name:{" "}
                  <code className="rounded bg-background/80 px-1.5 py-0.5 font-mono font-bold">
                    {capturedSetupInfo.bleName}
                  </code>
                </StatusAlert>
              )}
            </Onboarding.Step>

            <Onboarding.Navigation className="flex items-center justify-between border-t pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={usbStep <= 1 || flashing}
                onClick={() => setUsbStep((s) => Math.max(1, s - 1))}
              >
                <RiArrowLeftLine className="size-3.5" aria-hidden="true" />
                Back
              </Button>
              {usbStep < 3 ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={usbStep === 1 ? !usbReleaseId : flashStage !== "completed"}
                  onClick={() => setUsbStep((s) => Math.min(3, s + 1))}
                >
                  Next
                  <RiArrowRightLine className="size-3.5" aria-hidden="true" />
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setUsbDialogOpen(false);
                    onNavigate("/controllers");
                  }}
                >
                  <RiCheckDoubleLine className="size-3.5" aria-hidden="true" />
                  Go to Pairing
                </Button>
              )}
            </Onboarding.Navigation>
          </Onboarding>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmCloseFlash} onOpenChange={setConfirmCloseFlash}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>USB Flash Currently in Progress</AlertDialogTitle>
            <AlertDialogDescription>
              Firmware is actively streaming to your ESP32 over Web Serial. Closing this window hides
              progress tracking—are you sure you want to close?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Open</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmCloseFlash(false);
                setUsbDialogOpen(false);
              }}
            >
              Close Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
