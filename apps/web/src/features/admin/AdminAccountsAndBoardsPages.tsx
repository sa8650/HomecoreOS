import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { BoardFirmwareStatus } from "@homecoreos/shared";
import {
  RiAddLine,
  RiCpuLine,
  RiDeleteBinLine,
  RiDownloadCloud2Line,
  RiExternalLinkLine,
  RiEyeLine,
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
} from "@/components/reui/select";
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
import { BoardVerificationDialog } from "./BoardVerificationDialog";
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

export function AdminAccountsStaffPage({
  isSuperAdmin,
  canManageAccounts = true,
  onNavigate,
}: {
  isSuperAdmin: boolean;
  canManageAccounts?: boolean;
  onNavigate?: (path: string) => void;
}) {
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [aRes, pRes] = await Promise.all([
        apiFetch<{ accounts: AdminAccountRow[] }>("/api/admin/accounts"),
        isSuperAdmin
          ? apiFetch<{ platformStaff: PlatformStaffRow[] }>("/api/admin/platform-staff").catch(
              () => ({ platformStaff: [] as PlatformStaffRow[] })
            )
          : Promise.resolve({ platformStaff: [] as PlatformStaffRow[] }),
      ]);
      setAccounts(aRes.accounts);
      setPlatformStaff(pRes.platformStaff);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load accounts.");
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

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
            {tab === "customers" && canManageAccounts && (
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
          {isSuperAdmin && (
            <TabsTrigger value="platform">
              Platform Admin Staff <Badge variant="outline">{platformStaff.length}</Badge>
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="customers">
          {accounts.length === 0 ? (
            <EmptyStatePanel
              icon={<RiUserSettingsLine />}
              title="No customer accounts yet"
              description="Provision your first isolated tenant household or enable customer self-registration."
              action={
                canManageAccounts ? (
                  <Button onClick={() => setCreateAccountOpen(true)}>
                    <RiAddLine className="size-4" aria-hidden="true" />
                    Provision Customer Account
                  </Button>
                ) : undefined
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
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => {
                            const target = `/admin/accounts/${acc.id}`;
                            if (onNavigate) {
                              onNavigate(target);
                            } else {
                              window.history.pushState({}, "", target);
                              window.dispatchEvent(new PopStateEvent("popstate"));
                            }
                          }}
                        >
                          <RiEyeLine className="size-3.5" aria-hidden="true" />
                          Details
                        </Button>
                        {canManageAccounts &&
                          (acc.status === "active" ? (
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
                          ))}
                        {canManageAccounts && isSuperAdmin && (
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
 * `canManageBoards` restricts import/update/edit/publish controls to super_admin
 * and operator roles (hiding them from read-only support admins).
 */
export function AdminBoardsPage({
  isSuperAdmin = false,
  canManageBoards = true,
}: {
  isSuperAdmin?: boolean;
  canManageBoards?: boolean;
} = {}) {
  const effectiveTimezone = useEffectiveTimezone();
  const [boards, setBoards] = useState<BoardProfileItem[]>([]);
  const [syncRuns, setSyncRuns] = useState<BoardSyncRunItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [filterTab, setFilterTab] = useState("all");
  const [inspectBoard, setInspectBoard] = useState<BoardProfileItem | null>(null);
  const [verifyBoard, setVerifyBoard] = useState<BoardProfileItem | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<BoardProfileItem | null>(null);

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

  async function handleUpdateCatalogBoards() {
    setUpdating(true);
    try {
      const res = await apiFetch<{
        run: {
          status: string;
          totalPresentCount: number;
          updatedCount: number;
          skippedCount: number;
          needsVerificationCount: number;
          summaryNotes: string;
        };
      }>("/api/admin/boards/update", { method: "POST" });
      toast.success(
        `Board catalog updated: refreshed ${res.run.updatedCount} of ${res.run.totalPresentCount} board${res.run.totalPresentCount === 1 ? "" : "s"}.`
      );
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Board catalog update failed.");
    } finally {
      setUpdating(false);
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
        description="Import Espressif, Seeed Studio, and Waveshare ESP boards, refresh existing catalog profiles, and manage firmware compatibility."
        actions={
          canManageBoards ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setImportOpen(true)}>
                <RiDownloadCloud2Line className="size-4" aria-hidden="true" />
                Import Board
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={updating}
                onClick={() => void handleUpdateCatalogBoards()}
              >
                <RiRefreshLine
                  className={`size-4 ${updating ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                {updating ? "Updating Boards..." : "Update Board"}
              </Button>
            </div>
          ) : (
            <Badge variant="outline" size="xs">
              Read-only access
            </Badge>
          )
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
            {latestSync.updated_count} updated · {latestSync.discovered_count} checked · {latestSync.needs_verification_count} awaiting GPIO verification
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
          description="Import Espressif, Seeed Studio, or Waveshare boards, update the catalog, or switch filter tabs."
          action={
            canManageBoards ? (
              <Button onClick={() => setImportOpen(true)}>
                <RiDownloadCloud2Line className="size-4" aria-hidden="true" />
                Import Board
              </Button>
            ) : undefined
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
                    {canManageBoards ? (
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
                    ) : (
                      <Badge variant="outline" size="xs">
                        {b.firmware_status ?? "catalog_only"}
                      </Badge>
                    )}
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
                        {canManageBoards && (
                          <Button
                            variant={
                              b.verification_status === "needs_verification"
                                ? "default"
                                : "outline"
                            }
                            size="xs"
                            onClick={() => setVerifyBoard(b)}
                          >
                            {b.verification_status === "needs_verification"
                              ? "Verify Pins"
                              : "Edit Pins"}
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
                      {canManageBoards && (
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
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog open={Boolean(inspectBoard)} onOpenChange={(o) => !o && setInspectBoard(null)}>
        <DialogContent className="sm:max-w-4xl max-h-[90dvh] overflow-y-auto p-4">
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

      <BoardVerificationDialog
        board={verifyBoard}
        onOpenChange={(open) => !open && setVerifyBoard(null)}
        onSaved={load}
      />
    </div>
  );
}
