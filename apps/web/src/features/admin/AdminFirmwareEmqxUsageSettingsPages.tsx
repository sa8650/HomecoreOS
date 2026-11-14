import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  RiArchiveLine,
  RiCheckDoubleLine,
  RiCpuLine,
  RiDeleteBinLine,
  RiEditLine,
  RiEyeOffLine,
  RiHistoryLine,
  RiMore2Fill,
  RiRefreshLine,
  RiRouterLine,
  RiShieldCheckLine,
  RiTimeLine,
  RiUploadCloud2Line,
} from "@remixicon/react";
import {
  SUPPORTED_CHIP_FAMILIES,
  getBoardSelectionConflictReason,
  inspectEspIdfBinary,
  resolveBoardSelectionBuildConfig,
  validateFirmwareBoardsCompatibility,
  type AdminNotificationPreferences,
  type PsramMode,
} from "@homecoreos/shared";
import { toast } from "sonner";
import {
  apiFetch,
  apiUploadWithProgress,
  ApiError,
  sha256HexClient,
} from "@/lib/api";
import {
  getBrowserTimezoneFallback,
  useEffectiveTimezone,
} from "@/lib/timezone";
import { BoardMultiSelect } from "@/components/firmware/BoardMultiSelect";
import { Badge } from "@/components/reui/badge";
import {
  ConfirmDeleteDialog,
  EmptyStatePanel,
  FormField,
  PageHeader,
  StatusAlert,
  TimezoneSelect,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  AdminSessionData,
  BoardProfileItem,
  FirmwareReleaseItem,
} from "../types";

const ADMIN_PREFERENCE_DEFS: Array<{
  key: keyof AdminNotificationPreferences;
  label: string;
  description: string;
}> = [
  {
    key: "new_user_registrations",
    label: "New Customer Registrations",
    description: "Alert when a new household customer account is created.",
  },
  {
    key: "controller_activity",
    label: "Controller Fleet Activity",
    description: "Track controller registrations, pairing claims, and fleet offline alerts.",
  },
  {
    key: "firmware_publishing",
    label: "Firmware Release Publishing",
    description: "Log firmware package uploads and public release publications.",
  },
  {
    key: "platform_errors",
    label: "Platform & Worker Errors",
    description: "Alert on unexpected API exceptions and backend platform errors.",
  },
  {
    key: "service_health_alerts",
    label: "EMQX & R2 Health Alerts",
    description: "Alert when EMQX Serverless or R2 connectivity fails health checks.",
  },
];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

interface FileInspectionMeta {
  name: string;
  sizeBytes: number;
  sha256: string;
  bytes: Uint8Array;
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file."));
    reader.readAsArrayBuffer(file);
  });
}

async function inspectSelectedFile(file: File | null): Promise<FileInspectionMeta | null> {
  if (!file) return null;
  const bytes = await readFileBytes(file);
  const sha256 = await sha256HexClient(bytes);
  return { name: file.name, sizeBytes: file.size, sha256, bytes };
}

export function AdminFirmwarePage() {
  const [releases, setReleases] = useState<FirmwareReleaseItem[]>([]);
  const [boards, setBoards] = useState<BoardProfileItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [chipFilter, setChipFilter] = useState<string>("all");

  const [singleOpen, setSingleOpen] = useState(false);
  const [zipOpen, setZipOpen] = useState(false);

  const [editRelease, setEditRelease] = useState<FirmwareReleaseItem | null>(null);
  const [editBoardIds, setEditBoardIds] = useState<string[]>([]);
  const [editChannel, setEditChannel] = useState("stable");
  const [editReleaseNotes, setEditReleaseNotes] = useState("");
  const [editPartitionScheme, setEditPartitionScheme] = useState<string>("auto");
  const [editPsramMode, setEditPsramMode] = useState<string>("auto");
  const [editHardwareVerified, setEditHardwareVerified] = useState(false);
  const [editVerificationNotes, setEditVerificationNotes] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const [attachRelease, setAttachRelease] = useState<FirmwareReleaseItem | null>(null);
  const [attachFileType, setAttachFileType] = useState<"usb_factory" | "ota_app">("ota_app");
  const [attachFlashAddress, setAttachFlashAddress] = useState("0x20000");
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const [attachMeta, setAttachMeta] = useState<FileInspectionMeta | null>(null);

  const [rollbackRelease, setRollbackRelease] = useState<FirmwareReleaseItem | null>(null);
  const [rollbackTargetId, setRollbackTargetId] = useState<string>("none");
  const [rollbackReason, setRollbackReason] = useState("");
  const [rollingBack, setRollingBack] = useState(false);

  const [name, setName] = useState("HomecoreOS Firmware");
  const [version, setVersion] = useState("");
  const [channel, setChannel] = useState("stable");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [hardwareVerified, setHardwareVerified] = useState(false);
  const [singleBoardIds, setSingleBoardIds] = useState<string[]>([]);
  const [zipBoardIds, setZipBoardIds] = useState<string[]>([]);
  const [usbFile, setUsbFile] = useState<File | null>(null);
  const [usbMeta, setUsbMeta] = useState<FileInspectionMeta | null>(null);
  const [otaFile, setOtaFile] = useState<File | null>(null);
  const [otaMeta, setOtaMeta] = useState<FileInspectionMeta | null>(null);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [zipMeta, setZipMeta] = useState<FileInspectionMeta | null>(null);
  const [publishNow, setPublishNow] = useState(true);
  const [zipHardwareVerified, setZipHardwareVerified] = useState(false);
  const [zipPublishNow, setZipPublishNow] = useState(true);
  const [singleModalError, setSingleModalError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const [deleteTarget, setDeleteTarget] = useState<FirmwareReleaseItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [fwRes, boardRes] = await Promise.all([
        apiFetch<{ releases: FirmwareReleaseItem[] }>("/api/admin/firmware"),
        apiFetch<{ boards: BoardProfileItem[] }>("/api/admin/boards").catch(() => ({
          boards: [] as BoardProfileItem[],
        })),
      ]);
      setReleases(fwRes.releases);
      setBoards(boardRes.boards);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load firmware.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredReleases = useMemo(() => {
    return releases.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (chipFilter !== "all" && r.chip_family !== chipFilter) return false;
      return true;
    });
  }, [releases, statusFilter, chipFilter]);

  const catalogSelectableBoards = useMemo(
    () => boards.filter((b) => b.verification_status !== "needs_verification"),
    [boards]
  );

  const singleSelectedBoards = useMemo(
    () => boards.filter((b) => singleBoardIds.includes(b.id)),
    [boards, singleBoardIds]
  );

  const singleResolvedConfig = useMemo(
    () => resolveBoardSelectionBuildConfig(singleSelectedBoards),
    [singleSelectedBoards]
  );

  const usbValidation = useMemo(() => {
    if (!usbFile) return null;
    if (!usbFile.name.toLowerCase().endsWith(".bin")) {
      return { valid: false, error: "USB Factory Binary must be a .bin file." };
    }
    if (!usbMeta) return null;
    if (!singleResolvedConfig.valid) return { valid: true };
    return inspectEspIdfBinary(usbMeta.bytes, "usb_factory", {
      chipFamily: singleResolvedConfig.chipFamily,
      flashSizeMb: singleResolvedConfig.flashSizeMb,
      bootloaderOffset: singleResolvedConfig.bootloaderOffset,
    });
  }, [usbFile, usbMeta, singleResolvedConfig]);

  const otaValidation = useMemo(() => {
    if (!otaFile) return null;
    if (!otaFile.name.toLowerCase().endsWith(".bin")) {
      return { valid: false, error: "OTA App Binary must be a .bin file." };
    }
    if (!otaMeta) return null;
    if (!singleResolvedConfig.valid) return { valid: true };
    return inspectEspIdfBinary(otaMeta.bytes, "ota_app", {
      chipFamily: singleResolvedConfig.chipFamily,
      flashSizeMb: singleResolvedConfig.flashSizeMb,
      bootloaderOffset: singleResolvedConfig.bootloaderOffset,
      version: version.trim() || null,
    });
  }, [otaFile, otaMeta, singleResolvedConfig, version]);

  function openSingleUploadModal() {
    setSingleModalError(null);
    setHardwareVerified(false);
    setPublishNow(true);
    setSingleOpen(true);
  }

  function resetSingleUploadForm() {
    setUsbFile(null);
    setUsbMeta(null);
    setOtaFile(null);
    setOtaMeta(null);
    setVersion("");
    setReleaseNotes("");
    setHardwareVerified(false);
    setPublishNow(true);
    setSingleBoardIds([]);
    setSingleModalError(null);
  }

  const editBoardsTargetChip = editRelease?.chip_family ?? "esp32s3";
  const editBoardsTargetFlashStr = editRelease?.files.find((f) => f.flash_size)?.flash_size;
  const editBoardsFlashMb =
    editRelease?.flash_size_mb ??
    (editBoardsTargetFlashStr
      ? Number.parseInt(editBoardsTargetFlashStr.replace(/\D/g, ""), 10) || null
      : null);
  const editBoardCheck = validateFirmwareBoardsCompatibility({
    chipFamily: editBoardsTargetChip,
    flashSizeMb: editBoardsFlashMb,
    psramMode:
      editPsramMode !== "auto" ? (editPsramMode as PsramMode) : (editRelease?.psram_mode as PsramMode | undefined),
    boards: boards.filter((b) => editBoardIds.includes(b.id)),
  });

  async function handleReleaseUpload(e: FormEvent) {
    e.preventDefault();
    setSingleModalError(null);

    if (!singleResolvedConfig.valid || !singleResolvedConfig.chipFamily) {
      const msg =
        singleResolvedConfig.errors[0] ??
        "Select at least one compatible board with matching firmware settings.";
      setSingleModalError(msg);
      return;
    }

    if (!usbFile && !otaFile) {
      setSingleModalError(
        "Select at least one firmware artifact (USB Factory Binary and/or OTA App Binary)."
      );
      return;
    }

    if (usbValidation && !usbValidation.valid) {
      setSingleModalError(usbValidation.error ?? "Invalid USB Factory Binary.");
      return;
    }
    if (otaValidation && !otaValidation.valid) {
      setSingleModalError(otaValidation.error ?? "Invalid OTA App Binary.");
      return;
    }

    setUploading(true);
    setUploadProgress(5);
    try {
      const fd = new FormData();
      if (usbFile) fd.append("usbFile", usbFile);
      if (otaFile) fd.append("otaFile", otaFile);
      fd.append("name", name.trim());
      fd.append("version", version.trim());
      fd.append("channel", channel);
      fd.append("compatibleBoardIds", JSON.stringify(singleBoardIds));
      fd.append("releaseNotes", releaseNotes);

      // Automatically resolved from selected board catalog profile
      fd.append("chipFamily", singleResolvedConfig.chipFamily);
      if (singleResolvedConfig.targetBoardSlug) {
        fd.append("targetBoardSlug", singleResolvedConfig.targetBoardSlug);
      }
      if (singleResolvedConfig.partitionScheme) {
        fd.append("partitionScheme", singleResolvedConfig.partitionScheme);
      }
      if (singleResolvedConfig.psramMode) {
        fd.append("psramMode", singleResolvedConfig.psramMode);
      }
      if (singleResolvedConfig.flashMode) {
        fd.append("flashMode", singleResolvedConfig.flashMode);
      }
      if (singleResolvedConfig.flashFreq) {
        fd.append("flashFreq", singleResolvedConfig.flashFreq);
      }
      if (singleResolvedConfig.flashSizeLabel) {
        fd.append("flashSize", singleResolvedConfig.flashSizeLabel);
      }
      if (singleResolvedConfig.otaAppOffset) {
        fd.append("otaFlashAddress", singleResolvedConfig.otaAppOffset);
      }

      fd.append("hardwareVerified", String(hardwareVerified));
      fd.append("publish", String(publishNow));

      await apiUploadWithProgress("/api/admin/firmware/release", fd, setUploadProgress);
      const publishedFlag = publishNow;
      resetSingleUploadForm();
      setSingleOpen(false);
      toast.success(
        publishedFlag
          ? "Firmware release validated, uploaded to R2, and published."
          : "Firmware release validated, uploaded to R2, and saved as draft."
      );
      await load();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Upload failed.";
      setSingleModalError(msg);
      toast.error(msg);
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  async function handleZipUpload(e: FormEvent) {
    e.preventDefault();
    if (!zipFile) {
      toast.error("Select a .zip release package containing manifest.json.");
      return;
    }
    setUploading(true);
    setUploadProgress(5);
    try {
      const fd = new FormData();
      fd.append("package", zipFile);
      fd.append("publish", String(zipPublishNow));
      fd.append("hardwareVerified", String(zipHardwareVerified));
      if (zipBoardIds.length > 0) {
        fd.append("compatibleBoardIds", JSON.stringify(zipBoardIds));
      }
      await apiUploadWithProgress("/api/admin/firmware/package", fd, setUploadProgress);
      setZipFile(null);
      setZipMeta(null);
      setZipBoardIds([]);
      setZipHardwareVerified(false);
      setZipPublishNow(true);
      setZipOpen(false);
      toast.success("Release ZIP package verified & extracted to R2 storage.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Package upload failed.");
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  async function handleAttachArtifact(e: FormEvent) {
    e.preventDefault();
    if (!attachRelease || !attachFile) return;
    setUploading(true);
    setUploadProgress(5);
    try {
      const fd = new FormData();
      fd.append("file", attachFile);
      fd.append("fileType", attachFileType);
      fd.append("flashAddress", attachFlashAddress);
      await apiUploadWithProgress(
        `/api/admin/firmware/${attachRelease.id}/attach`,
        fd,
        setUploadProgress
      );
      setAttachRelease(null);
      setAttachFile(null);
      setAttachMeta(null);
      toast.success(`Attached ${attachFileType} binary.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to attach binary.");
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  function openEditDialog(r: FirmwareReleaseItem) {
    setEditRelease(r);
    setEditBoardIds(r.compatible_board_ids ?? []);
    setEditChannel(r.channel);
    setEditReleaseNotes(r.release_notes ?? "");
    setEditPartitionScheme(r.partition_scheme ?? "auto");
    setEditPsramMode(r.psram_mode ?? "auto");
    setEditHardwareVerified(Boolean(r.hardware_verified));
    setEditVerificationNotes(r.verification_notes ?? "");
  }

  async function handleSaveReleaseEdits(e: FormEvent) {
    e.preventDefault();
    if (!editRelease || !editBoardCheck.valid) return;
    setSavingEdit(true);
    try {
      await apiFetch(`/api/admin/firmware/${editRelease.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          channel: editChannel,
          release_notes: editReleaseNotes,
          compatible_board_ids: editBoardIds,
          ...(editPartitionScheme !== "auto" ? { partition_scheme: editPartitionScheme } : {}),
          ...(editPsramMode !== "auto" ? { psram_mode: editPsramMode } : {}),
          hardware_verified: editHardwareVerified,
          verification_notes: editVerificationNotes.trim() || null,
        }),
      });
      setEditRelease(null);
      toast.success("Release metadata & board compatibility updated.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update release.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleLifecycle(
    id: string,
    action: "publish" | "unpublish" | "deprecate" | "archive" | "delete"
  ) {
    try {
      if (action === "delete") {
        await apiFetch(`/api/admin/firmware/${id}`, { method: "DELETE" });
        toast.success("Firmware release deleted.");
      } else {
        await apiFetch(`/api/admin/firmware/${id}/${action}`, {
          method: "POST",
          body: action === "deprecate" ? JSON.stringify({}) : undefined,
        });
        toast.success(`Release ${action}ed.`);
      }
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : `Failed to ${action} release.`);
    }
  }

  async function handleQuickVerify(r: FirmwareReleaseItem) {
    try {
      const nextVerified = !r.hardware_verified;
      await apiFetch(`/api/admin/firmware/${r.id}/verify`, {
        method: "POST",
        body: JSON.stringify({
          hardware_verified: nextVerified,
          verified_board_ids: nextVerified ? r.compatible_board_ids : [],
        }),
      });
      toast.success(
        nextVerified
          ? `Marked ${r.name} v${r.version} hardware-verified.`
          : `Cleared hardware verification for ${r.name} v${r.version}.`
      );
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Verification update failed.");
    }
  }

  async function handleRollbackSubmit(e: FormEvent) {
    e.preventDefault();
    if (!rollbackRelease) return;
    setRollingBack(true);
    try {
      await apiFetch(`/api/admin/firmware/${rollbackRelease.id}/rollback`, {
        method: "POST",
        body: JSON.stringify({
          targetReleaseId: rollbackTargetId !== "none" ? rollbackTargetId : null,
          reason: rollbackReason.trim() || null,
        }),
      });
      setRollbackRelease(null);
      setRollbackTargetId("none");
      setRollbackReason("");
      toast.success("Release rolled back and deprecated cleanly.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Rollback failed.");
    } finally {
      setRollingBack(false);
    }
  }

  if (loading && releases.length === 0) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const rollbackCandidates = rollbackRelease
    ? releases.filter(
        (cand) =>
          cand.id !== rollbackRelease.id &&
          cand.chip_family === rollbackRelease.chip_family &&
          cand.status !== "archived"
      )
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Firmware Artifacts"
        title="Firmware Management"
        description="Upload validated USB + OTA ESP-IDF binaries or CI ZIP packages across all ESP32 board targets in private Cloudflare R2 storage."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={openSingleUploadModal}>
              <RiUploadCloud2Line className="size-4" aria-hidden="true" />
              Upload Binary / Release
            </Button>
            <Button size="sm" onClick={() => setZipOpen(true)}>
              <RiUploadCloud2Line className="size-4" aria-hidden="true" />
              Upload Release ZIP
            </Button>
          </div>
        }
      />

      {releases.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[150px] h-8 text-xs" aria-label="Filter by Status">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="published">Published</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="deprecated">Deprecated</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
          <Select value={chipFilter} onValueChange={setChipFilter}>
            <SelectTrigger className="w-[160px] h-8 text-xs" aria-label="Filter by Chip">
              <SelectValue placeholder="All Chips" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Chip Families</SelectItem>
              {SUPPORTED_CHIP_FAMILIES.map((chip) => (
                <SelectItem key={chip} value={chip}>
                  {chip.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-auto text-xs text-muted-foreground">
            Showing {filteredReleases.length} of {releases.length} releases
          </span>
        </div>
      )}

      {releases.length === 0 ? (
        <EmptyStatePanel
          icon={<RiUploadCloud2Line />}
          title="No firmware releases uploaded yet"
          description="Upload a verified .bin image pair (USB + OTA) or CI release .zip package to private Cloudflare R2 storage."
          action={
            <Button onClick={() => setZipOpen(true)}>
              <RiUploadCloud2Line className="size-4" aria-hidden="true" />
              Upload Release ZIP
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Release &amp; Notes</TableHead>
                <TableHead>Target / Compat</TableHead>
                <TableHead>Compatible Boards</TableHead>
                <TableHead>Status &amp; Rollout</TableHead>
                <TableHead>Artifacts</TableHead>
                <TableHead className="w-[70px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredReleases.map((r) => {
                const resolvedBoards =
                  r.compatible_boards && r.compatible_boards.length > 0
                    ? r.compatible_boards
                    : boards.filter((b) => r.compatible_board_ids.includes(b.id));
                const missingUsb = !r.usb_available;
                const missingOta = !r.ota_available;
                return (
                  <TableRow key={r.id}>
                    <TableCell className="max-w-[260px]">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="font-semibold text-foreground">
                          {r.name} <span className="font-mono">v{r.version}</span>
                        </p>
                        {r.hardware_verified ? (
                          <Badge variant="success-light" size="xs">
                            <RiShieldCheckLine className="size-3" aria-hidden="true" />
                            Verified
                          </Badge>
                        ) : (
                          <Badge variant="warning-light" size="xs">
                            Unverified
                          </Badge>
                        )}
                      </div>
                      {r.release_notes && (
                        <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                          {r.release_notes}
                        </p>
                      )}
                      {r.verification_notes && (
                        <p className="mt-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                          {r.verification_notes}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1 text-xs">
                        <div className="font-medium text-foreground">
                          {r.chip_family.toUpperCase()} · {r.channel}
                        </div>
                        <div className="flex flex-wrap gap-1 font-mono text-[10px] text-muted-foreground">
                          {r.partition_scheme && (
                            <Badge variant="outline" size="xs">
                              {r.partition_scheme}
                            </Badge>
                          )}
                          {r.psram_mode && (
                            <Badge variant="outline" size="xs">
                              psram:{r.psram_mode}
                            </Badge>
                          )}
                          {r.flash_size_mb && (
                            <Badge variant="outline" size="xs">
                              {r.flash_size_mb}MB
                            </Badge>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {resolvedBoards.length > 0 ? (
                          resolvedBoards.map((b) => (
                            <Badge key={b.id} variant="secondary" size="xs">
                              <RiCpuLine className="size-3" aria-hidden="true" />
                              {b.model}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {r.target_board_slug ?? `All ${r.chip_family.toUpperCase()}`}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <Badge
                          variant={
                            r.status === "published"
                              ? "success-light"
                              : r.status === "draft"
                                ? "info-light"
                                : r.status === "deprecated"
                                  ? "warning-light"
                                  : "outline"
                          }
                        >
                          {r.status}
                        </Badge>
                        {r.ota_stats && r.ota_stats.total > 0 && (
                          <p className="font-mono text-[10px] text-muted-foreground">
                            OTA: {r.ota_stats.succeeded} ok · {r.ota_stats.failed} fail
                            {r.ota_stats.active > 0 ? ` · ${r.ota_stats.active} active` : ""}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        {r.files.map((f) => (
                          <div
                            key={f.id}
                            className="font-mono text-[10px] text-muted-foreground"
                          >
                            <span className="font-semibold text-foreground">{f.file_type}</span> ·{" "}
                            {formatBytes(f.size_bytes)} · {f.sha256.slice(0, 10)}...
                          </div>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Actions for ${r.name} v${r.version}`}
                          >
                            <RiMore2Fill className="size-4" aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem onSelect={() => openEditDialog(r)}>
                            <RiEditLine className="size-4" aria-hidden="true" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void handleQuickVerify(r)}>
                            <RiCheckDoubleLine className="size-4" aria-hidden="true" />
                            {r.hardware_verified ? "Unverify" : "Verify"}
                          </DropdownMenuItem>
                          {(missingUsb || missingOta) && (
                            <DropdownMenuItem
                              onSelect={() => {
                                const nextType = missingOta ? "ota_app" : "usb_factory";
                                setAttachRelease(r);
                                setAttachFileType(nextType);
                                setAttachFlashAddress(
                                  nextType === "usb_factory" ? "0x0" : "0x20000"
                                );
                                setAttachFile(null);
                                setAttachMeta(null);
                              }}
                            >
                              <RiUploadCloud2Line className="size-4" aria-hidden="true" />
                              Attach {missingOta ? "OTA" : "USB"}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          {r.status !== "published" && (
                            <DropdownMenuItem
                              onSelect={() => void handleLifecycle(r.id, "publish")}
                            >
                              <RiShieldCheckLine className="size-4" aria-hidden="true" />
                              Publish
                            </DropdownMenuItem>
                          )}
                          {r.status === "published" && (
                            <>
                              <DropdownMenuItem
                                onSelect={() => void handleLifecycle(r.id, "unpublish")}
                              >
                                <RiEyeOffLine className="size-4" aria-hidden="true" />
                                Unpublish
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => {
                                  setRollbackRelease(r);
                                  setRollbackTargetId("none");
                                  setRollbackReason("");
                                }}
                              >
                                <RiHistoryLine className="size-4" aria-hidden="true" />
                                Rollback
                              </DropdownMenuItem>
                            </>
                          )}
                          {r.status !== "archived" && (
                            <DropdownMenuItem
                              onSelect={() => void handleLifecycle(r.id, "archive")}
                            >
                              <RiArchiveLine className="size-4" aria-hidden="true" />
                              Archive
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setDeleteTarget(r)}
                          >
                            <RiDeleteBinLine className="size-4" aria-hidden="true" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Simplified Firmware Release Upload Modal */}
      <Dialog
        open={singleOpen}
        onOpenChange={(open) => {
          setSingleOpen(open);
          if (!open) setSingleModalError(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Upload Firmware Release (.bin)</DialogTitle>
            <DialogDescription>
              Select compatible boards from the catalog and attach verified ESP-IDF firmware
              binaries. Board hardware settings are resolved automatically.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleReleaseUpload} className="space-y-4">
            <div className="space-y-3 rounded-lg border border-border/80 bg-muted/20 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Release Information
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <FormField id="fw-name" label="Release Name">
                  <Input
                    id="fw-name"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </FormField>
                <FormField id="fw-ver" label="Version">
                  <Input
                    id="fw-ver"
                    required
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    placeholder="1.2.0"
                  />
                </FormField>
                <FormField id="fw-chan" label="Channel">
                  <Select value={channel} onValueChange={setChannel}>
                    <SelectTrigger id="fw-chan" aria-label="Channel">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stable">Stable</SelectItem>
                      <SelectItem value="beta">Beta</SelectItem>
                      <SelectItem value="development">Development</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
              </div>

              <FormField
                id="fw-single-boards"
                label="Compatible Boards"
                hint="Choose one or more catalog boards sharing matching firmware requirements."
              >
                <BoardMultiSelect
                  boards={catalogSelectableBoards}
                  selectedIds={singleBoardIds}
                  onChange={(ids) => {
                    setSingleBoardIds(ids);
                    setSingleModalError(null);
                  }}
                  getBoardConflictReason={(candidate) =>
                    getBoardSelectionConflictReason(candidate, singleSelectedBoards)
                  }
                  ariaLabel="Compatible Boards"
                />
              </FormField>
              {singleBoardIds.length > 0 && !singleResolvedConfig.valid && (
                <StatusAlert tone="danger">{singleResolvedConfig.errors[0]}</StatusAlert>
              )}
              {singleResolvedConfig.valid && singleResolvedConfig.warnings.length > 0 && (
                <StatusAlert tone="warning">{singleResolvedConfig.warnings[0]}</StatusAlert>
              )}

              <FormField id="fw-notes" label="Release Notes">
                <textarea
                  id="fw-notes"
                  rows={2}
                  value={releaseNotes}
                  onChange={(e) => setReleaseNotes(e.target.value)}
                  placeholder="Summarize features, fixes, and upgrade guidance..."
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </FormField>
            </div>

            <div className="space-y-3 rounded-lg border border-border/80 bg-muted/20 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Firmware Binaries
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 rounded-lg border border-border bg-background p-3">
                  <label htmlFor="fw-usb-bin" className="block text-xs font-medium text-foreground">
                    USB Factory Binary (.bin)
                  </label>
                  <p className="text-[11px] text-muted-foreground">
                    Complete firmware image for USB flashing.
                  </p>
                  <input
                    id="fw-usb-bin"
                    type="file"
                    accept=".bin"
                    aria-label="USB Factory Binary"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      setUsbFile(f);
                      setSingleModalError(null);
                      void inspectSelectedFile(f).then(setUsbMeta);
                    }}
                    className="w-full rounded-lg border border-input bg-background p-2 text-xs"
                  />
                  {usbMeta && (
                    <p className="font-mono text-[10px] text-muted-foreground break-all">
                      {formatBytes(usbMeta.sizeBytes)} · SHA-256: {usbMeta.sha256.slice(0, 16)}...
                    </p>
                  )}
                  {usbValidation && !usbValidation.valid && (
                    <StatusAlert tone="danger">{usbValidation.error}</StatusAlert>
                  )}
                </div>

                <div className="space-y-1.5 rounded-lg border border-border bg-background p-3">
                  <label htmlFor="fw-ota-bin" className="block text-xs font-medium text-foreground">
                    OTA App Binary (.bin)
                  </label>
                  <p className="text-[11px] text-muted-foreground">
                    Application firmware for OTA updates.
                  </p>
                  <input
                    id="fw-ota-bin"
                    type="file"
                    accept=".bin"
                    aria-label="OTA App Binary"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      setOtaFile(f);
                      setSingleModalError(null);
                      void inspectSelectedFile(f).then(setOtaMeta);
                    }}
                    className="w-full rounded-lg border border-input bg-background p-2 text-xs"
                  />
                  {otaMeta && (
                    <p className="font-mono text-[10px] text-muted-foreground break-all">
                      {formatBytes(otaMeta.sizeBytes)} · SHA-256: {otaMeta.sha256.slice(0, 16)}...
                    </p>
                  )}
                  {otaValidation && !otaValidation.valid && (
                    <StatusAlert tone="danger">{otaValidation.error}</StatusAlert>
                  )}
                  {otaValidation?.valid &&
                    "versionMismatchWarning" in otaValidation &&
                    otaValidation.versionMismatchWarning && (
                      <StatusAlert tone="warning">
                        {otaValidation.versionMismatchWarning}
                      </StatusAlert>
                    )}
                </div>
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border/80 bg-muted/20 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Verification &amp; Publishing
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs">
                  <span className="font-medium text-foreground">
                    Verified on Physical Hardware
                  </span>
                  <Switch
                    checked={hardwareVerified}
                    onCheckedChange={setHardwareVerified}
                    aria-label="Verified on Physical Hardware"
                  />
                </label>
                <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs">
                  <span className="font-medium text-foreground">Publish Immediately</span>
                  <Switch
                    checked={publishNow}
                    onCheckedChange={setPublishNow}
                    aria-label="Publish Immediately"
                  />
                </label>
              </div>
            </div>

            {singleModalError && <StatusAlert tone="danger">{singleModalError}</StatusAlert>}

            {uploading && (
              <div className="space-y-1">
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>Uploading artifacts to private R2...</span>
                  <span>{uploadProgress}%</span>
                </div>
                <Progress value={uploadProgress} />
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSingleOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  uploading ||
                  !singleResolvedConfig.valid ||
                  (!usbFile && !otaFile) ||
                  Boolean(usbValidation && !usbValidation.valid) ||
                  Boolean(otaValidation && !otaValidation.valid)
                }
              >
                <RiUploadCloud2Line className="size-4" aria-hidden="true" />
                {uploading ? `Uploading (${uploadProgress}%)...` : "Upload Release"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ZIP Package Upload Modal */}
      <Dialog open={zipOpen} onOpenChange={setZipOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload Release Package (.zip)</DialogTitle>
            <DialogDescription>
              Upload the CI-generated ZIP containing{" "}
              <span className="font-mono">manifest.json</span>, merged USB factory image, OTA app
              image, and SHA-256 checksums.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleZipUpload} className="space-y-4">
            <div className="space-y-1.5">
              <input
                type="file"
                accept=".zip"
                aria-label="Select firmware ZIP package"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setZipFile(f);
                  void inspectSelectedFile(f).then(setZipMeta);
                }}
                className="w-full rounded-lg border border-input bg-background p-2 text-xs"
              />
              {zipMeta && (
                <p className="font-mono text-[10px] text-muted-foreground break-all">
                  {formatBytes(zipMeta.sizeBytes)} · SHA-256: {zipMeta.sha256.slice(0, 20)}...
                </p>
              )}
            </div>
            <FormField
              id="fw-zip-boards"
              label="Override / Pin Compatible Boards (Optional)"
              hint="Optional override merged with manifest.json board validation (chip & flash verified on upload)."
            >
              <BoardMultiSelect
                boards={boards}
                selectedIds={zipBoardIds}
                onChange={setZipBoardIds}
                ariaLabel="Release ZIP Compatible Boards"
              />
            </FormField>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={zipPublishNow} onCheckedChange={setZipPublishNow} />
                Publish on verification
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={zipHardwareVerified} onCheckedChange={setZipHardwareVerified} />
                Hardware verified
              </label>
            </div>
            {uploading && (
              <div className="space-y-1">
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>Extracting &amp; verifying ZIP package...</span>
                  <span>{uploadProgress}%</span>
                </div>
                <Progress value={uploadProgress} />
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setZipOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={uploading}>
                <RiUploadCloud2Line className="size-4" aria-hidden="true" />
                {uploading ? `Uploading (${uploadProgress}%)...` : "Verify & Upload ZIP"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Attach Missing USB / OTA Binary Dialog */}
      <Dialog
        open={Boolean(attachRelease)}
        onOpenChange={(open) => !open && setAttachRelease(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Attach Artifact · {attachRelease?.name} v{attachRelease?.version}
            </DialogTitle>
            <DialogDescription>
              Add a missing USB factory or OTA binary to this existing release.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAttachArtifact} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <FormField id="attach-type" label="Artifact Kind">
                <Select
                  value={attachFileType}
                  onValueChange={(v) => {
                    const kind = v as "usb_factory" | "ota_app";
                    setAttachFileType(kind);
                    setAttachFlashAddress(kind === "usb_factory" ? "0x0" : "0x20000");
                  }}
                >
                  <SelectTrigger id="attach-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="usb_factory">USB Factory (0x0)</SelectItem>
                    <SelectItem value="ota_app">OTA App (0x20000)</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField id="attach-addr" label="Flash Offset">
                <Input
                  id="attach-addr"
                  value={attachFlashAddress}
                  onChange={(e) => setAttachFlashAddress(e.target.value)}
                />
              </FormField>
            </div>
            <input
              type="file"
              accept=".bin"
              aria-label="Select binary to attach"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setAttachFile(f);
                void inspectSelectedFile(f).then(setAttachMeta);
              }}
              className="w-full rounded-lg border border-input bg-background p-2 text-xs"
            />
            {attachMeta && (
              <p className="font-mono text-[10px] text-muted-foreground break-all">
                {formatBytes(attachMeta.sizeBytes)} · SHA-256: {attachMeta.sha256.slice(0, 16)}...
              </p>
            )}
            {uploading && <Progress value={uploadProgress} />}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAttachRelease(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={uploading || !attachFile}>
                {uploading ? `Uploading (${uploadProgress}%)...` : "Attach Binary"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Release Compatibility & Metadata Dialog */}
      <Dialog
        open={Boolean(editRelease)}
        onOpenChange={(open) => !open && setEditRelease(null)}
      >
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Edit Release · {editRelease?.name} v{editRelease?.version}
            </DialogTitle>
            <DialogDescription>
              Manage compatible {editBoardsTargetChip.toUpperCase()} boards
              {editBoardsFlashMb ? ` (>= ${editBoardsFlashMb}MB flash)` : ""}, channel, release
              notes, and hardware verification.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveReleaseEdits} className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <FormField id="edit-chan" label="Channel">
                <Select value={editChannel} onValueChange={setEditChannel}>
                  <SelectTrigger id="edit-chan">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stable">Stable</SelectItem>
                    <SelectItem value="beta">Beta</SelectItem>
                    <SelectItem value="development">Development</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField id="edit-part" label="Partition Scheme">
                <Select value={editPartitionScheme} onValueChange={setEditPartitionScheme}>
                  <SelectTrigger id="edit-part">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto / Unset</SelectItem>
                    <SelectItem value="dual_ota_4mb">dual_ota_4mb</SelectItem>
                    <SelectItem value="dual_ota_8mb">dual_ota_8mb</SelectItem>
                    <SelectItem value="dual_ota_16mb">dual_ota_16mb</SelectItem>
                    <SelectItem value="dual_ota_32mb">dual_ota_32mb</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField id="edit-psram" label="PSRAM Mode">
                <Select value={editPsramMode} onValueChange={setEditPsramMode}>
                  <SelectTrigger id="edit-psram">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto / Unset</SelectItem>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="quad">Quad</SelectItem>
                    <SelectItem value="octal">Octal</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
            </div>
            <FormField id="edit-boards" label="Compatible Boards">
              <BoardMultiSelect
                boards={boards}
                selectedIds={editBoardIds}
                onChange={setEditBoardIds}
                chipFamily={editBoardsTargetChip}
                ariaLabel="Edit Release Compatible Boards"
              />
            </FormField>
            {!editBoardCheck.valid && (
              <StatusAlert tone="danger">{editBoardCheck.errors[0]}</StatusAlert>
            )}
            <FormField id="edit-notes" label="Release Notes">
              <textarea
                id="edit-notes"
                rows={3}
                value={editReleaseNotes}
                onChange={(e) => setEditReleaseNotes(e.target.value)}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </FormField>
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={editHardwareVerified}
                onCheckedChange={setEditHardwareVerified}
              />
              Verified on physical hardware
            </label>
            <FormField id="edit-ver-notes" label="Verification Notes">
              <Input
                id="edit-ver-notes"
                value={editVerificationNotes}
                onChange={(e) => setEditVerificationNotes(e.target.value)}
                placeholder="Hardware test log or known caveats"
              />
            </FormField>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditRelease(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={savingEdit || !editBoardCheck.valid}>
                {savingEdit ? "Saving..." : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Release Rollback & Deprecation Dialog */}
      <Dialog
        open={Boolean(rollbackRelease)}
        onOpenChange={(open) => !open && setRollbackRelease(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Rollback Release · {rollbackRelease?.name} v{rollbackRelease?.version}
            </DialogTitle>
            <DialogDescription>
              Deprecate this release and optionally restore/publish an earlier safe release for{" "}
              {rollbackRelease?.chip_family.toUpperCase()}.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleRollbackSubmit} className="space-y-4">
            <FormField id="rb-target" label="Promote Fallback Release (Optional)">
              <Select value={rollbackTargetId} onValueChange={setRollbackTargetId}>
                <SelectTrigger id="rb-target">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Deprecate only (no fallback promotion)</SelectItem>
                  {rollbackCandidates.map((cand) => (
                    <SelectItem key={cand.id} value={cand.id}>
                      {cand.name} v{cand.version} ({cand.status})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField id="rb-reason" label="Rollback Reason">
              <Input
                id="rb-reason"
                value={rollbackReason}
                onChange={(e) => setRollbackReason(e.target.value)}
                placeholder="e.g. Wi-Fi regression observed on v1.2.1"
              />
            </FormField>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRollbackRelease(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={rollingBack}>
                {rollingBack ? "Rolling Back..." : "Confirm Rollback"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete Firmware Release?"
        description={
          deleteTarget
            ? `Remove firmware release "${deleteTarget.name} v${deleteTarget.version}" and its private R2 artifacts?`
            : ""
        }
        confirmLabel="Delete Release"
        onConfirm={async () => {
          if (deleteTarget) {
            await handleLifecycle(deleteTarget.id, "delete");
            setDeleteTarget(null);
          }
        }}
      />
    </div>
  );
}

export function AdminEmqxPage() {
  const [data, setData] = useState<{
    brokerStatus: { configured: boolean; connected: boolean; brokerHost?: string; error?: string };
    liveClients: Array<{ clientid: string; connected?: boolean; ip_address?: string }>;
    credentials: Array<{
      id: string;
      controller_id: string;
      mqtt_username: string;
      mqtt_client_id: string;
      topic_prefix: string;
      status: string;
      emqx_synced: boolean;
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<NonNullable<typeof data>>("/api/admin/emqx/status");
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load EMQX status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRevoke(controllerId: string) {
    try {
      await apiFetch(`/api/admin/emqx/credentials/${controllerId}/revoke`, {
        method: "POST",
      });
      toast.success("Revoked controller MQTT credentials.");
      await load();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to revoke MQTT credentials."
      );
    }
  }

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error && !data) return <StatusAlert tone="danger">{error}</StatusAlert>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="MQTT Control Plane"
        title="EMQX Management"
        description="Per-controller MQTT credentials, strict topic-prefix ACLs, and active TLS clients."
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RiRefreshLine className="size-4" aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <Card className="p-4">
        <CardContent className="p-0 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">
              Broker: {data.brokerStatus.brokerHost || "Not configured"}
            </span>
            <Badge variant={data.brokerStatus.connected ? "success-light" : "warning-light"}>
              <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
              {data.brokerStatus.connected ? "EMQX API Connected" : "Not Connected"}
            </Badge>
          </div>
          {data.brokerStatus.error && (
            <p className="text-xs text-destructive">{data.brokerStatus.error}</p>
          )}
        </CardContent>
      </Card>

      {data.credentials.length === 0 ? (
        <EmptyStatePanel
          icon={<RiRouterLine />}
          tone="neutral"
          title="No controller MQTT credentials provisioned yet"
          description="Per-controller EMQX Serverless credentials and strict topic-prefix ACLs appear here once customers register controllers."
        />
      ) : (
      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>MQTT Username</TableHead>
              <TableHead>Topic Prefix</TableHead>
              <TableHead>EMQX Sync</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.credentials.map((cred) => (
              <TableRow key={cred.id}>
                <TableCell className="font-mono">{cred.mqtt_username}</TableCell>
                <TableCell className="font-mono text-[11px]">{cred.topic_prefix}</TableCell>
                <TableCell>{cred.emqx_synced ? "Synced" : "Pending"}</TableCell>
                <TableCell>
                  <Badge variant={cred.status === "active" ? "success-light" : "destructive-light"}>
                    {cred.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {cred.status === "active" && (
                    <Button
                      variant="destructive"
                      size="xs"
                      onClick={() => setRevokeTarget(cred.controller_id)}
                    >
                      Revoke
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      )}

      <ConfirmDeleteDialog
        open={Boolean(revokeTarget)}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title="Revoke MQTT Credentials?"
        description="Immediately disconnect this controller from EMQX Serverless and invalidate its broker credentials?"
        confirmLabel="Revoke Credentials"
        onConfirm={async () => {
          if (revokeTarget) {
            await handleRevoke(revokeTarget);
            setRevokeTarget(null);
          }
        }}
      />
    </div>
  );
}

export function AdminUsagePage() {
  const [usage, setUsage] = useState<{
    database: { accounts: number; controllers: number; devices: number };
    r2: { status: string; objectCount: number | null; totalBytes: number; freeTierLimitBytes: number };
    emqx: { configured: boolean; activeConnections: number | null; serverlessMaxConnections: number };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<NonNullable<typeof usage>>("/api/admin/usage")
      .then(setUsage)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load usage."));
  }, []);

  if (error && !usage) return <StatusAlert tone="danger">{error}</StatusAlert>;
  if (!usage) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  const r2Pct = Math.min(
    100,
    Math.round((usage.r2.totalBytes / usage.r2.freeTierLimitBytes) * 100)
  );
  const emqxPct =
    usage.emqx.activeConnections !== null
      ? Math.min(
          100,
          Math.round(
            (usage.emqx.activeConnections / usage.emqx.serverlessMaxConnections) * 100
          )
        )
      : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Provider Quotas"
        title="Usage & Monitoring"
        description="Live metrics reported from Supabase PostgreSQL, Cloudflare R2, and EMQX Serverless."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="p-4">
          <CardContent className="p-0 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-foreground">
                Cloudflare R2 Storage (Free Tier: 10 GB)
              </span>
              <span className="tabular-nums text-muted-foreground">
                {(usage.r2.totalBytes / (1024 * 1024)).toFixed(2)} MB · {usage.r2.objectCount ?? 0} objects
              </span>
            </div>
            <Progress value={r2Pct} />
          </CardContent>
        </Card>

        <Card className="p-4">
          <CardContent className="p-0 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-foreground">
                EMQX Serverless Connections (Cap: 1,000)
              </span>
            </div>
            {usage.emqx.activeConnections !== null ? (
              <div className="space-y-2">
                <p className="text-xs tabular-nums text-muted-foreground">
                  {usage.emqx.activeConnections} active connections
                </p>
                <Progress value={emqxPct} />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                EMQX connection telemetry unavailable until EMQX Serverless credentials are configured.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <CardContent className="p-0">
            <p className="text-xs text-muted-foreground">Active Accounts</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{usage.database.accounts}</p>
          </CardContent>
        </Card>
        <Card className="p-4">
          <CardContent className="p-0">
            <p className="text-xs text-muted-foreground">Controllers</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{usage.database.controllers}</p>
          </CardContent>
        </Card>
        <Card className="p-4">
          <CardContent className="p-0">
            <p className="text-xs text-muted-foreground">Devices</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{usage.database.devices}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function AdminSettingsPage({
  isSuperAdmin,
  adminSession,
  onRefreshAdminSession,
}: {
  isSuperAdmin: boolean;
  adminSession: AdminSessionData;
  onRefreshAdminSession: () => Promise<void>;
}) {
  const effectiveTimezone = useEffectiveTimezone();

  const [settings, setSettings] = useState<{
    customer_registration_enabled: boolean;
    pairing_code_expiration_seconds: number;
    default_account_status: "active" | "paused";
    default_timezone: string;
    controller_heartbeat_interval_seconds: number;
    controller_offline_timeout_seconds: number;
    max_devices_per_account: number;
    max_controllers_per_account: number;
    maintenance_mode: boolean;
    board_catalog_enabled: boolean;
  } | null>(null);

  const [adminTimezone, setAdminTimezone] = useState<string>(
    adminSession.admin.timezone ?? "__default__"
  );
  const [notifPrefs, setNotifPrefs] = useState<AdminNotificationPreferences | null>(null);
  const [savingNotifPrefs, setSavingNotifPrefs] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    setAdminTimezone(adminSession.admin.timezone ?? "__default__");
  }, [adminSession.admin.timezone]);

  useEffect(() => {
    apiFetch<{ settings: NonNullable<typeof settings> }>("/api/admin/settings")
      .then((res) => setSettings(res.settings))
      .catch((err) =>
        toast.error(err instanceof ApiError ? err.message : "Failed to load settings.")
      );
    apiFetch<{ preferences: AdminNotificationPreferences }>(
      "/api/admin/notifications/preferences"
    )
      .then((res) => setNotifPrefs(res.preferences))
      .catch(() => {});
  }, []);

  async function handleToggleNotifPref(
    key: keyof AdminNotificationPreferences,
    enabled: boolean
  ) {
    if (!notifPrefs) return;
    const nextPrefs: AdminNotificationPreferences = { ...notifPrefs, [key]: enabled };
    setNotifPrefs(nextPrefs);
    setSavingNotifPrefs(true);
    try {
      await apiFetch("/api/admin/notifications/preferences", {
        method: "PATCH",
        body: JSON.stringify({ [key]: enabled }),
      });
      toast.success("Admin notification preferences saved.");
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to save notification preferences."
      );
    } finally {
      setSavingNotifPrefs(false);
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    try {
      const res = await apiFetch<{ settings: NonNullable<typeof settings> }>(
        "/api/admin/settings",
        {
          method: "PATCH",
          body: JSON.stringify(settings),
        }
      );
      setSettings(res.settings);
      toast.success("Platform settings & default timezone saved.");
      await onRefreshAdminSession();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAdminTimezone(e: FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    try {
      await apiFetch("/api/admin/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({
          timezone: adminTimezone === "__default__" ? null : adminTimezone,
        }),
      });
      toast.success("Your personal admin timezone preference was saved.");
      await onRefreshAdminSession();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save admin timezone.");
    } finally {
      setSavingProfile(false);
    }
  }

  if (!settings) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="System Policy"
        title="Platform Settings"
        description="Global operational policies, limits, and regional timezone defaults persisted in PostgreSQL."
        actions={
          <Badge variant="info-light">
            <RiTimeLine className="size-3" aria-hidden="true" />
            Effective Admin Timezone: {effectiveTimezone}
          </Badge>
        }
      />

      <Card className="p-5">
        <CardContent className="p-0">
          <form
            onSubmit={handleSaveAdminTimezone}
            className="flex flex-wrap items-end justify-between gap-4"
          >
            <div className="flex-1 min-w-[260px]">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-foreground">
                  Your Admin Console Timezone
                </span>
                <button
                  type="button"
                  onClick={() => setAdminTimezone(getBrowserTimezoneFallback())}
                  className="text-[11px] font-medium text-primary hover:underline cursor-pointer"
                >
                  Use browser timezone
                </button>
              </div>
              <TimezoneSelect
                ariaLabel="Your Admin Console Timezone"
                value={adminTimezone}
                onValueChange={setAdminTimezone}
                inheritLabel={`Inherit Platform Default (${settings.default_timezone})`}
              />
            </div>
            <Button type="submit" variant="outline" size="sm" disabled={savingProfile}>
              {savingProfile ? "Saving..." : "Save Admin Timezone"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <form onSubmit={handleSave} className="space-y-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card className="p-5">
            <CardContent className="p-0 space-y-4">
              <h2 className="text-sm font-semibold text-foreground">
                Access, Catalog & Default Regional Timezone
              </h2>
              <label className="flex items-center justify-between gap-3 text-xs">
                <span>Allow new customer self-registration</span>
                <Switch
                  checked={settings.customer_registration_enabled}
                  disabled={!isSuperAdmin}
                  onCheckedChange={(v) =>
                    setSettings({ ...settings, customer_registration_enabled: v })
                  }
                />
              </label>
              <label className="flex items-center justify-between gap-3 text-xs">
                <span>Enable global Board Library catalog</span>
                <Switch
                  checked={settings.board_catalog_enabled}
                  disabled={!isSuperAdmin}
                  onCheckedChange={(v) => setSettings({ ...settings, board_catalog_enabled: v })}
                />
              </label>
              <label className="flex items-center justify-between gap-3 text-xs">
                <span>Platform maintenance mode</span>
                <Switch
                  checked={settings.maintenance_mode}
                  disabled={!isSuperAdmin}
                  onCheckedChange={(v) => setSettings({ ...settings, maintenance_mode: v })}
                />
              </label>
              <FormField id="adm-def-status" label="Default New Account Status">
                <Select
                  disabled={!isSuperAdmin}
                  value={settings.default_account_status}
                  onValueChange={(v) =>
                    setSettings({
                      ...settings,
                      default_account_status: v as "active" | "paused",
                    })
                  }
                >
                  <SelectTrigger id="adm-def-status" aria-label="Default New Account Status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active immediately</SelectItem>
                    <SelectItem value="paused">Paused pending approval</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField
                id="adm-def-tz"
                label="Platform Default Regional Timezone"
                hint="Applied globally across Customer & Admin consoles unless a user selects an override."
              >
                <TimezoneSelect
                  id="adm-def-tz"
                  ariaLabel="Platform Default Regional Timezone"
                  disabled={!isSuperAdmin}
                  value={settings.default_timezone}
                  onValueChange={(v) => setSettings({ ...settings, default_timezone: v })}
                />
              </FormField>
            </CardContent>
          </Card>

          <Card className="p-5">
            <CardContent className="p-0 grid grid-cols-1 gap-3 sm:grid-cols-2 content-start">
              <h2 className="sm:col-span-2 text-sm font-semibold text-foreground">
                Fleet Quotas & Heartbeat Policies
              </h2>
              <FormField id="adm-pair-exp" label="Pairing Code Expiry (s)">
                <Input
                  id="adm-pair-exp"
                  type="number"
                  disabled={!isSuperAdmin}
                  min={60}
                  max={1800}
                  value={settings.pairing_code_expiration_seconds}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      pairing_code_expiration_seconds: Number(e.target.value),
                    })
                  }
                />
              </FormField>
              <FormField id="adm-hb-int" label="Heartbeat Interval (s)">
                <Input
                  id="adm-hb-int"
                  type="number"
                  disabled={!isSuperAdmin}
                  min={10}
                  max={300}
                  value={settings.controller_heartbeat_interval_seconds}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      controller_heartbeat_interval_seconds: Number(e.target.value),
                    })
                  }
                />
              </FormField>
              <FormField id="adm-off-to" label="Offline Timeout (s)">
                <Input
                  id="adm-off-to"
                  type="number"
                  disabled={!isSuperAdmin}
                  min={30}
                  max={900}
                  value={settings.controller_offline_timeout_seconds}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      controller_offline_timeout_seconds: Number(e.target.value),
                    })
                  }
                />
              </FormField>
              <FormField id="adm-max-ctrl" label="Max Controllers / Account">
                <Input
                  id="adm-max-ctrl"
                  type="number"
                  disabled={!isSuperAdmin}
                  min={1}
                  max={500}
                  value={settings.max_controllers_per_account}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      max_controllers_per_account: Number(e.target.value),
                    })
                  }
                />
              </FormField>
              <FormField id="adm-max-dev" label="Max Devices / Account">
                <Input
                  id="adm-max-dev"
                  type="number"
                  disabled={!isSuperAdmin}
                  min={1}
                  max={5000}
                  value={settings.max_devices_per_account}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      max_devices_per_account: Number(e.target.value),
                    })
                  }
                />
              </FormField>
            </CardContent>
          </Card>
        </div>

        {isSuperAdmin && (
          <div className="flex justify-end">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save Platform Settings"}
            </Button>
          </div>
        )}
      </form>

      {notifPrefs && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between border-b">
            <CardTitle className="text-sm">Admin Notification Preferences</CardTitle>
            {savingNotifPrefs && (
              <span className="text-[11px] text-muted-foreground">Saving...</span>
            )}
          </CardHeader>
          <CardContent className="divide-y pt-2">
            {ADMIN_PREFERENCE_DEFS.map((pref) => (
              <div
                key={pref.key}
                className="flex items-center justify-between gap-4 py-3 first:pt-2 last:pb-2"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground">{pref.label}</p>
                  <p className="text-[11px] text-muted-foreground">{pref.description}</p>
                </div>
                <Switch
                  aria-label={pref.label}
                  checked={Boolean(notifPrefs[pref.key])}
                  onCheckedChange={(checked) => void handleToggleNotifPref(pref.key, checked)}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
