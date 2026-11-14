import { useEffect, useState, type FormEvent } from "react";
import {
  SUPPORTED_CHIP_FAMILIES,
  buildEsp32S3N16R8PinMap,
  type BoardFirmwareStatus,
  type ChipFamily,
} from "@homecoreos/shared";
import {
  RiAddLine,
  RiCpuLine,
  RiDeleteBinLine,
  RiDownloadCloud2Line,
  RiExternalLinkLine,
  RiRefreshLine,
  RiUserSettingsLine,
} from "@remixicon/react";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api";
import { formatTimestamp, useEffectiveTimezone } from "@/lib/timezone";
import { BoardVectorSvg } from "@/components/boards/BoardVectorSvg";
import { InteractiveBoardPinout } from "@/components/boards/InteractiveBoardPinout";
import { Badge } from "@/components/reui/badge";
import {
  ConfirmDeleteDialog,
  EmptyStatePanel,
  FormField,
  PageHeader,
} from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
import type { BoardProfileItem, BoardSyncRunItem } from "../types";
import { BoardRemovalDialog } from "./BoardRemovalDialog";
import { OfficialBoardImportDialog } from "./OfficialBoardImportDialog";

interface AdminAccountRow {
  id: string;
  name: string;
  slug: string;
  status: "active" | "paused" | "pending_deletion";
  created_at: string;
}

interface PlatformStaffRow {
  id: string;
  email: string;
  fullName: string;
  role: "super_admin" | "operator" | "support";
  status: "active" | "suspended";
}

export function AdminAccountsStaffPage({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const timezone = useEffectiveTimezone();
  const [tab, setTab] = useState("customers");
  const [accounts, setAccounts] = useState<AdminAccountRow[]>([]);
  const [platformStaff, setPlatformStaff] = useState<PlatformStaffRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [createAccountOpen, setCreateAccountOpen] = useState(false);
  const [accountName, setAccountName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerFullName, setOwnerFullName] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");

  const [createStaffOpen, setCreateStaffOpen] = useState(false);
  const [psEmail, setPsEmail] = useState("");
  const [psName, setPsName] = useState("");
  const [psPassword, setPsPassword] = useState("");
  const [psRole, setPsRole] = useState<"super_admin" | "operator" | "support">("operator");

  const [deleteTarget, setDeleteTarget] = useState<AdminAccountRow | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [aRes, pRes] = await Promise.all([
        apiFetch<{ accounts: AdminAccountRow[] }>("/api/admin/accounts"),
        apiFetch<{ platformStaff: PlatformStaffRow[] }>("/api/admin/platform-staff"),
      ]);
      setAccounts(aRes.accounts);
      setPlatformStaff(pRes.platformStaff);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load accounts.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreateAccount(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/admin/accounts", {
        method: "POST",
        body: JSON.stringify({
          accountName,
          ownerEmail,
          ownerFullName,
          ownerPassword,
        }),
      });
      setAccountName("");
      setOwnerEmail("");
      setOwnerFullName("");
      setOwnerPassword("");
      setCreateAccountOpen(false);
      toast.success("Customer account provisioned.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create account.");
    }
  }

  async function handleAccountStatus(id: string, action: "pause" | "reactivate" | "delete") {
    try {
      if (action === "delete") {
        await apiFetch(`/api/admin/accounts/${id}`, { method: "DELETE" });
        toast.success("Customer account deleted.");
      } else {
        await apiFetch(`/api/admin/accounts/${id}/${action}`, { method: "POST" });
        toast.success(
          action === "pause"
            ? "Customer account paused."
            : "Customer account reactivated."
        );
      }
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Account status update failed.");
    }
  }

  async function handleCreatePlatformStaff(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/admin/platform-staff", {
        method: "POST",
        body: JSON.stringify({
          email: psEmail,
          fullName: psName,
          password: psPassword,
          role: psRole,
        }),
      });
      setPsEmail("");
      setPsName("");
      setPsPassword("");
      setCreateStaffOpen(false);
      toast.success("Platform administrator added.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to add platform staff.");
    }
  }

  if (loading && accounts.length === 0) {
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
        eyebrow="Tenant & Staff Isolation"
        title="Users & Staff Management"
        description="Customer accounts and their staff remain strictly isolated from Platform Admin staff."
        actions={
          <div className="flex flex-wrap gap-2">
            {tab === "customers" && (
              <Button size="sm" onClick={() => setCreateAccountOpen(true)}>
                <RiAddLine className="size-4" aria-hidden="true" />
                Provision Customer Account
              </Button>
            )}
            {tab === "platform" && isSuperAdmin && (
              <Button size="sm" onClick={() => setCreateStaffOpen(true)}>
                <RiAddLine className="size-4" aria-hidden="true" />
                Add Platform Admin
              </Button>
            )}
          </div>
        }
      />

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="customers">
            Customer Accounts <Badge variant="outline">{accounts.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="platform">
            Platform Admin Staff <Badge variant="outline">{platformStaff.length}</Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="customers">
          {accounts.length === 0 ? (
            <EmptyStatePanel
              icon={<RiUserSettingsLine />}
              title="No customer accounts yet"
              description="Provision your first isolated tenant household or enable customer self-registration."
              action={
                <Button onClick={() => setCreateAccountOpen(true)}>
                  <RiAddLine className="size-4" aria-hidden="true" />
                  Provision Customer Account
                </Button>
              }
            />
          ) : (
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created ({timezone})</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((acc) => (
                  <TableRow key={acc.id}>
                    <TableCell>
                      <p className="font-semibold text-foreground">{acc.name}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">{acc.slug}</p>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          acc.status === "active"
                            ? "success-light"
                            : acc.status === "paused"
                            ? "warning-light"
                            : "destructive-light"
                        }
                      >
                        {acc.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {formatTimestamp(acc.created_at, timezone)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {acc.status === "active" ? (
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => void handleAccountStatus(acc.id, "pause")}
                          >
                            Pause
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => void handleAccountStatus(acc.id, "reactivate")}
                          >
                            Reactivate
                          </Button>
                        )}
                        {isSuperAdmin && (
                          <Button
                            variant="destructive"
                            size="xs"
                            onClick={() => setDeleteTarget(acc)}
                          >
                            <RiDeleteBinLine className="size-3.5" aria-hidden="true" />
                            Delete
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          )}
        </TabsContent>

        <TabsContent value="platform">
          {platformStaff.length === 0 ? (
            <EmptyStatePanel
              icon={<RiUserSettingsLine />}
              tone="neutral"
              title="No platform staff accounts found"
              description="Add super admins, operators, or support engineers to manage the Platform Control Plane."
            />
          ) : (
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Administrator</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {platformStaff.map((ps) => (
                  <TableRow key={ps.id}>
                    <TableCell>
                      <p className="font-semibold text-foreground">{ps.fullName}</p>
                      <p className="text-[11px] text-muted-foreground">{ps.email}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant="info-light">{ps.role}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={ps.status === "active" ? "success-light" : "warning-light"}>
                        {ps.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={createAccountOpen} onOpenChange={setCreateAccountOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Provision Customer Account</DialogTitle>
            <DialogDescription>
              Create a new isolated tenant household and its primary owner account.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateAccount} className="space-y-3">
            <FormField id="adm-acc-name" label="Account Name">
              <Input
                id="adm-acc-name"
                required
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                placeholder="Rivera Residence"
              />
            </FormField>
            <FormField id="adm-owner-name" label="Owner Full Name">
              <Input
                id="adm-owner-name"
                required
                value={ownerFullName}
                onChange={(e) => setOwnerFullName(e.target.value)}
              />
            </FormField>
            <FormField id="adm-owner-email" label="Owner Email">
              <Input
                id="adm-owner-email"
                type="email"
                required
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
              />
            </FormField>
            <FormField id="adm-owner-pass" label="Initial Password">
              <Input
                id="adm-owner-pass"
                type="password"
                required
                value={ownerPassword}
                onChange={(e) => setOwnerPassword(e.target.value)}
              />
            </FormField>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateAccountOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">
                <RiAddLine className="size-4" aria-hidden="true" />
                Create Customer Account
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={createStaffOpen} onOpenChange={setCreateStaffOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Platform Administrator</DialogTitle>
            <DialogDescription>
              Grant access to the Platform Control Plane. Separate from customer accounts.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreatePlatformStaff} className="space-y-3">
            <FormField id="ps-name" label="Full Name">
              <Input
                id="ps-name"
                required
                value={psName}
                onChange={(e) => setPsName(e.target.value)}
              />
            </FormField>
            <FormField id="ps-email" label="Email">
              <Input
                id="ps-email"
                type="email"
                required
                value={psEmail}
                onChange={(e) => setPsEmail(e.target.value)}
              />
            </FormField>
            <FormField id="ps-pass" label="Password (10+ chars)">
              <Input
                id="ps-pass"
                type="password"
                required
                value={psPassword}
                onChange={(e) => setPsPassword(e.target.value)}
              />
            </FormField>
            <FormField id="ps-role" label="Role">
              <Select value={psRole} onValueChange={(v) => setPsRole(v as typeof psRole)}>
                <SelectTrigger id="ps-role" aria-label="Role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="super_admin">Super Admin</SelectItem>
                  <SelectItem value="operator">Operator</SelectItem>
                  <SelectItem value="support">Support</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateStaffOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">
                <RiAddLine className="size-4" aria-hidden="true" />
                Add Platform Admin
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
        title="Delete Customer Account?"
        description={
          deleteTarget
            ? `Permanently delete customer account "${deleteTarget.name}" (${deleteTarget.slug}) and revoke its controller MQTT credentials?`
            : ""
        }
        confirmLabel="Delete Account"
        onConfirm={async () => {
          if (deleteTarget) {
            await handleAccountStatus(deleteTarget.id, "delete");
            setDeleteTarget(null);
          }
        }}
      />
    </div>
  );
}

/**
 * `isSuperAdmin` decides whether boards can be removed here: the Worker lets
 * only super admins remove a board, so nobody else is offered the control.
 */
export function AdminBoardsPage({ isSuperAdmin = false }: { isSuperAdmin?: boolean } = {}) {
  const effectiveTimezone = useEffectiveTimezone();
  const [boards, setBoards] = useState<BoardProfileItem[]>([]);
  const [syncRuns, setSyncRuns] = useState<BoardSyncRunItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [filterTab, setFilterTab] = useState("all");
  const [inspectBoard, setInspectBoard] = useState<BoardProfileItem | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<BoardProfileItem | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [manufacturer, setManufacturer] = useState("Espressif");
  const [model, setModel] = useState("");
  const [chipFamily, setChipFamily] = useState<ChipFamily>("esp32s3");
  const [chipVariant, setChipVariant] = useState("ESP32-S3-WROOM-1");
  const [flashMb, setFlashMb] = useState(16);
  const [psramMb, setPsramMb] = useState(8);

  async function load() {
    // Only the first load shows the skeleton. A reload keeps the page (and any
    // open dialog, such as the import result) mounted.
    try {
      const res = await apiFetch<{
        boards: BoardProfileItem[];
        syncRuns?: BoardSyncRunItem[];
      }>("/api/admin/boards");
      setBoards(res.boards);
      setSyncRuns(res.syncRuns ?? []);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load board catalog.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleSyncOfficialCatalog() {
    setSyncing(true);
    try {
      const res = await apiFetch<{
        run: {
          status: string;
          discoveredCount: number;
          insertedCount: number;
          updatedCount: number;
          needsVerificationCount: number;
          summaryNotes: string;
        };
      }>("/api/admin/boards/sync", { method: "POST" });
      toast.success(
        `Official Espressif sync ${res.run.status}: ${res.run.discoveredCount} boards checked (${res.run.insertedCount} new, ${res.run.updatedCount} updated, ${res.run.needsVerificationCount} awaiting GPIO verification).`
      );
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Official catalog sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  async function handleAddBoard(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/admin/boards", {
        method: "POST",
        body: JSON.stringify({
          slug: slug.trim(),
          manufacturer: manufacturer.trim(),
          model: model.trim(),
          chipFamily,
          chipVariant: chipVariant.trim(),
          flashSizeMb: flashMb,
          psramSizeMb: psramMb,
          gpioDefinitions: buildEsp32S3N16R8PinMap(),
        }),
      });
      setSlug("");
      setModel("");
      setAddOpen(false);
      toast.success("Supported board added to global catalog.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to add board.");
    }
  }

  async function handleToggleAvailability(board: BoardProfileItem) {
    try {
      await apiFetch(`/api/admin/boards/${board.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_available: !board.is_available }),
      });
      toast.success(
        !board.is_available
          ? `Published "${board.model}".`
          : `Hidden "${board.model}" from catalog.`
      );
      await load();
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : "Board publication requires verified pin definitions."
      );
    }
  }

  async function handleFirmwareStatusChange(
    board: BoardProfileItem,
    firmwareStatus: BoardFirmwareStatus
  ) {
    try {
      await apiFetch(`/api/admin/boards/${board.id}`, {
        method: "PATCH",
        body: JSON.stringify({ firmware_status: firmwareStatus }),
      });
      toast.success(`Updated firmware status for "${board.model}".`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update firmware status.");
    }
  }

  if (loading && boards.length === 0) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const filteredBoards = boards.filter((b) => {
    if (filterTab === "verified") return b.verification_status === "verified";
    if (filterTab === "needs_verification") return b.verification_status === "needs_verification";
    if (filterTab === "official") return (b.catalog_category ?? "official_espressif") === "official_espressif";
    if (filterTab === "partner") return b.catalog_category === "partner";
    return true;
  });

  const latestSync = syncRuns[0] ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Global Hardware Catalog"
        title="Board Library Management"
        description="Import official Espressif & partner hardware boards, verify pin maps before publishing, and manage firmware compatibility flags."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
              <RiDownloadCloud2Line className="size-4" aria-hidden="true" />
              Import Official Boards
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={syncing}
              onClick={() => void handleSyncOfficialCatalog()}
            >
              <RiRefreshLine
                className={`size-4 ${syncing ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              {syncing ? "Syncing Espressif..." : "Sync Official Catalog"}
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <RiAddLine className="size-4" aria-hidden="true" />
              Add Supported Board
            </Button>
          </div>
        }
      />

      {latestSync && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={latestSync.status === "succeeded" ? "success-light" : "warning-light"}
              size="xs"
            >
              Last Sync: {latestSync.status}
            </Badge>
            <span className="font-medium text-foreground">{latestSync.source_name}</span>
            <span className="text-muted-foreground">
              · {formatTimestamp(latestSync.completed_at ?? latestSync.started_at, effectiveTimezone)}
            </span>
          </div>
          <span className="text-muted-foreground">
            {latestSync.discovered_count} discovered · {latestSync.needs_verification_count} awaiting GPIO verification
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted/40 p-1 w-fit text-xs">
        {(
          [
            ["all", `All (${boards.length})`],
            ["verified", `Verified (${boards.filter((b) => b.verification_status === "verified").length})`],
            [
              "needs_verification",
              `Needs Verification (${boards.filter((b) => b.verification_status === "needs_verification").length})`,
            ],
            ["official", "Official Espressif"],
            ["partner", "Partner"],
          ] as const
        ).map(([val, lbl]) => (
          <button
            key={val}
            type="button"
            onClick={() => setFilterTab(val)}
            className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
              filterTab === val
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {lbl}
          </button>
        ))}
      </div>

      {filteredBoards.length === 0 ? (
        <EmptyStatePanel
          icon={<RiCpuLine />}
          title="No matching boards"
          description="Import official boards, sync the Espressif catalog, or switch filter tabs."
          action={
            <Button onClick={() => void handleSyncOfficialCatalog()}>
              <RiRefreshLine className="size-4" aria-hidden="true" />
              Sync Official Catalog
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Board</TableHead>
                <TableHead>Chip & Memory</TableHead>
                <TableHead>Pinout Verification</TableHead>
                <TableHead>Firmware Support</TableHead>
                <TableHead>Visibility</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredBoards.map((b) => (
                <TableRow key={b.id}>
                  {/* Below 1420px the name may wrap, so the row actions stay in view on laptops. */}
                  <TableCell className="whitespace-normal min-[1420px]:whitespace-nowrap">
                    <div className="flex min-w-56 items-center gap-3">
                      <div className="flex h-11 w-16 shrink-0 items-center justify-center rounded-md border border-border bg-[#0b0e12] p-1">
                        <BoardVectorSvg
                          board={b}
                          orientation="horizontal"
                          compact
                          className="h-full w-full"
                        />
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground">
                          {b.manufacturer} {b.model}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-1.5">
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {b.slug}
                          </span>
                          <Badge variant="outline" size="xs">
                            {b.catalog_category === "partner" ? "Partner" : "Espressif"}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="text-xs font-medium">{b.chip_variant}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      {b.chip_family.toUpperCase()} · {b.flash_size_mb}MB / {b.psram_size_mb}MB
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {b.partition_scheme && (
                        <Badge variant="outline" size="xs">
                          {b.partition_scheme}
                        </Badge>
                      )}
                      {b.bootloader_offset && (
                        <Badge variant="outline" size="xs">
                          boot:{b.bootloader_offset}
                        </Badge>
                      )}
                      {typeof b.boot_button_gpio === "number" && (
                        <Badge variant="outline" size="xs">
                          GPIO{b.boot_button_gpio}
                        </Badge>
                      )}
                      {b.supports_wifi === false && (
                        <Badge variant="warning-light" size="xs">
                          No Wi-Fi
                        </Badge>
                      )}
                      {b.supports_ble === false ? (
                        <Badge variant="outline" size="xs">
                          No BLE
                        </Badge>
                      ) : b.supports_wifi !== false ? (
                        <Badge variant="info-light" size="xs">
                          BLE + Wi-Fi
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        b.verification_status === "verified" ? "success-light" : "warning-light"
                      }
                      size="xs"
                    >
                      {b.verification_status === "verified"
                        ? `Verified (${b.gpio_definitions?.length ?? 0} pins)`
                        : "Needs Verification"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={b.firmware_status ?? "catalog_only"}
                      onValueChange={(v) =>
                        void handleFirmwareStatusChange(b, v as BoardFirmwareStatus)
                      }
                    >
                      <SelectTrigger className="h-7 w-40 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="firmware_supported">Firmware Supported</SelectItem>
                        <SelectItem value="catalog_only">Catalog Only</SelectItem>
                        <SelectItem value="build_pending">Build Pending</SelectItem>
                        <SelectItem value="unsupported">Unsupported</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Badge variant={b.is_available ? "success-light" : "outline"} size="xs">
                      {b.is_available ? "Published" : "Draft / Hidden"}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-normal text-right">
                    {/* Two groups that wrap as units: two rows on laptops, one row on wide screens. */}
                    <div className="flex min-w-[6.5rem] flex-wrap items-center justify-end gap-1.5 min-[1420px]:flex-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        {(b.gpio_definitions?.length ?? 0) > 0 && (
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => setInspectBoard(b)}
                          >
                            Pinout
                          </Button>
                        )}
                        {b.docs_url && (
                          <a
                            href={b.docs_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex h-7 items-center rounded-md border border-border px-2 text-xs hover:bg-muted"
                            title="Official Hardware Docs"
                          >
                            <RiExternalLinkLine className="size-3.5" />
                          </a>
                        )}
                      </div>
                      <div className="inline-flex items-center gap-1.5">
                        <Button
                          variant={b.is_available ? "outline" : "default"}
                          size="xs"
                          disabled={
                            !b.is_available && b.verification_status === "needs_verification"
                          }
                          title={
                            b.verification_status === "needs_verification"
                              ? "Verify GPIO pin definitions before publishing"
                              : undefined
                          }
                          onClick={() => void handleToggleAvailability(b)}
                        >
                          {b.is_available ? "Hide" : "Publish"}
                        </Button>
                        {isSuperAdmin && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                            aria-label={`Remove ${b.manufacturer} ${b.model}`}
                            title="Remove from the Board Library"
                            onClick={() => setRemoveTarget(b)}
                          >
                            <RiDeleteBinLine className="size-3.5" aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog open={Boolean(inspectBoard)} onOpenChange={(o) => !o && setInspectBoard(null)}>
        <DialogContent className="sm:max-w-4xl max-h-[88vh] overflow-y-auto p-4 sm:p-5">
          <DialogHeader className="pb-1">
            <DialogTitle className="text-sm sm:text-base">
              {inspectBoard?.manufacturer} {inspectBoard?.model} — Pinout Verification
            </DialogTitle>
            <DialogDescription className="text-xs">
              {inspectBoard?.chip_variant} · {inspectBoard?.flash_size_mb} MB Flash ·{" "}
              {inspectBoard?.psram_size_mb} MB PSRAM
            </DialogDescription>
          </DialogHeader>
          {inspectBoard && <InteractiveBoardPinout board={inspectBoard} />}
          <DialogFooter className="pt-1">
            <Button size="sm" onClick={() => setInspectBoard(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OfficialBoardImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={load}
      />

      <BoardRemovalDialog
        board={removeTarget}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        onRemoved={load}
      />

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Catalog Board</DialogTitle>
            <DialogDescription>
              Register a hardware board profile in the global platform catalog.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddBoard} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField id="brd-slug" label="Slug">
                <Input
                  id="brd-slug"
                  required
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="waveshare-esp32-s3-relay-6ch"
                />
              </FormField>
              <FormField id="brd-mfg" label="Manufacturer">
                <Input
                  id="brd-mfg"
                  required
                  value={manufacturer}
                  onChange={(e) => setManufacturer(e.target.value)}
                />
              </FormField>
              <FormField id="brd-model" label="Model">
                <Input
                  id="brd-model"
                  required
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </FormField>
              <FormField id="brd-chip" label="Chip Family">
                <Select
                  value={chipFamily}
                  onValueChange={(v) => setChipFamily(v as ChipFamily)}
                >
                  <SelectTrigger id="brd-chip" aria-label="Chip Family">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPORTED_CHIP_FAMILIES.map((fam) => (
                      <SelectItem key={fam} value={fam}>
                        {fam.toUpperCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField id="brd-var" label="Chip Variant">
                <Input
                  id="brd-var"
                  required
                  value={chipVariant}
                  onChange={(e) => setChipVariant(e.target.value)}
                />
              </FormField>
              <div className="grid grid-cols-2 gap-2">
                <FormField id="brd-flash" label="Flash MB">
                  <Input
                    id="brd-flash"
                    type="number"
                    min={2}
                    max={64}
                    value={flashMb}
                    onChange={(e) => setFlashMb(Number(e.target.value))}
                  />
                </FormField>
                <FormField id="brd-psram" label="PSRAM MB">
                  <Input
                    id="brd-psram"
                    type="number"
                    min={0}
                    max={32}
                    value={psramMb}
                    onChange={(e) => setPsramMb(Number(e.target.value))}
                  />
                </FormField>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">
                <RiAddLine className="size-4" aria-hidden="true" />
                Add Supported Board
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
