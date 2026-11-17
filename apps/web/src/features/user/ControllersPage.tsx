import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  RiAddLine,
  RiBluetoothConnectLine,
  RiCheckLine,
  RiCheckboxCircleFill,
  RiCpuLine,
  RiDeleteBinLine,
  RiDoorOpenLine,
  RiHistoryLine,
  RiRefreshLine,
  RiRestartLine,
  RiShieldCheckLine,
  RiWifiLine,
  RiWifiOffLine,
} from "@remixicon/react";
import { toast } from "sonner";
import { apiFetch, ApiError, cachedGet, getCachedSnapshot } from "@/lib/api";
import { formatTimestamp, useEffectiveTimezone } from "@/lib/timezone";
import {
  ControllerSetupModal,
  type ControllerSetupView,
} from "@/components/controllers/ControllerSetupModal";
import { ControllerCard } from "@/components/controllers/ControllerCard";
import { Badge } from "@/components/reui/badge";
import { Frame, FramePanel } from "@/components/reui/frame";
import {
  ConfirmDeleteDialog,
  EmptyStatePanel,
  FormField,
  StatusAlert,
} from "@/components/shared/AppUi";
import { CONTROLLERS_HERO_ICONS } from "@/components/shared/HeroDomainIcons";
import { PageHeroHeader } from "@/components/shared/PageHeroHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MagicCard } from "@/components/ui/magic-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  BoardProfileItem,
  ControllerItem,
  HomeItem,
  RoomItem,
} from "@/features/types";

/** Slice of `/api/firmware/updates` the controller cards need for version badges. */
type FirmwareUpdatesPayload = {
  applicableUpdates?: Array<{
    controllerId: string;
    availableRelease?: { version?: string } | null;
  }>;
};

export function ControllersPage({
  canManage,
  canOperate,
  onNavigate,
}: {
  canManage: boolean;
  canOperate: boolean;
  onNavigate: (path: string) => void;
}) {
  const timezone = useEffectiveTimezone();
  const cachedCtrls = getCachedSnapshot<{ controllers: ControllerItem[] }>("/api/controllers");
  const [activeTab, setActiveTab] = useState<"active" | "trash">("active");
  const [search, setSearch] = useState("");
  const [controllers, setControllers] = useState<ControllerItem[]>(
    () => cachedCtrls?.controllers ?? []
  );
  const [trashedControllers, setTrashedControllers] = useState<ControllerItem[]>([]);
  const [catalogBoards, setCatalogBoards] = useState<BoardProfileItem[]>([]);
  const [customBoards, setCustomBoards] = useState<BoardProfileItem[]>([]);
  const [updateVersionByController, setUpdateVersionByController] = useState<
    Map<string, string>
  >(new Map());
  const [homes, setHomes] = useState<HomeItem[]>([]);
  const [rooms, setRooms] = useState<RoomItem[]>([]);
  const [loading, setLoading] = useState(!cachedCtrls);

  const [roomTarget, setRoomTarget] = useState<ControllerItem | null>(null);
  const [roomSelection, setRoomSelection] = useState<string>("");
  const [assigningRoom, setAssigningRoom] = useState(false);

  const [setupModal, setSetupModal] = useState<{
    open: boolean;
    initialView: ControllerSetupView;
    targetController: ControllerItem | null;
  }>({
    open: false,
    initialView: "entry",
    targetController: null,
  });

  const [pairingModal, setPairingModal] = useState<{
    controllerId: string;
    controllerName: string;
    code: string;
    expiresAt: string;
    isRecovery: boolean;
    physicalSteps?: string[];
  } | null>(null);
  const [livePairedStatus, setLivePairedStatus] = useState<ControllerItem | null>(null);

  const [wifiTarget, setWifiTarget] = useState<ControllerItem | null>(null);
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");

  const [trashTarget, setTrashTarget] = useState<ControllerItem | null>(null);
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<ControllerItem | null>(null);
  const [detailTarget, setDetailTarget] = useState<ControllerItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openSetupFlow(
    initialView: ControllerSetupView = "entry",
    targetController: ControllerItem | null = null
  ) {
    setSetupModal({ open: true, initialView, targetController });
  }

  const load = useCallback(async (force = false) => {
    if (!getCachedSnapshot("/api/controllers")) {
      setLoading(true);
    }
    try {
      const primaryPromise = cachedGet<{ controllers: ControllerItem[] }>(
        "/api/controllers",
        { ttlMs: 15_000, force }
      ).then((cRes) => {
        setControllers(cRes.controllers);
        setLoading(false);
        return cRes;
      });

      const secondaryPromise = Promise.allSettled([
        cachedGet<{ controllers: ControllerItem[] }>("/api/controllers/trash", {
          ttlMs: 15_000,
          force,
        }),
        cachedGet<{ boards: BoardProfileItem[] }>("/api/boards/catalog", {
          ttlMs: 60_000,
          force,
        }),
        cachedGet<{ boards: BoardProfileItem[] }>("/api/boards/custom", {
          ttlMs: 60_000,
          force,
        }),
        cachedGet<{ homes: HomeItem[] }>("/api/homes", {
          ttlMs: 60_000,
          force,
        }),
        cachedGet<{ rooms: RoomItem[] }>("/api/homes/rooms", {
          ttlMs: 60_000,
          force,
        }),
        cachedGet<FirmwareUpdatesPayload>("/api/firmware/updates", {
          ttlMs: 60_000,
          force,
        }),
      ]).then(([trashOut, catOut, custOut, homeOut, roomsOut, updatesOut]) => {
        if (trashOut.status === "fulfilled") {
          setTrashedControllers(trashOut.value.controllers);
        }
        if (catOut.status === "fulfilled") {
          setCatalogBoards(catOut.value.boards);
        }
        if (custOut.status === "fulfilled") {
          setCustomBoards(custOut.value.boards);
        }
        if (homeOut.status === "fulfilled" && Array.isArray(homeOut.value?.homes)) {
          setHomes(homeOut.value.homes);
        }
        if (roomsOut.status === "fulfilled" && Array.isArray(roomsOut.value?.rooms)) {
          setRooms(roomsOut.value.rooms);
        }
        if (updatesOut.status === "fulfilled") {
          const next = new Map<string, string>();
          for (const update of updatesOut.value?.applicableUpdates ?? []) {
            const version = update?.availableRelease?.version;
            if (version) next.set(update.controllerId, version);
          }
          setUpdateVersionByController(next);
        }
      });

      await Promise.all([primaryPromise, secondaryPromise]);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load controllers.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const roomById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);

  // Board Library profiles (catalog + custom) so every controller card can draw
  // the vector board map of the board it was provisioned with.
  const boardById = useMemo(() => {
    const map = new Map<string, BoardProfileItem>();
    for (const board of catalogBoards) map.set(board.id, board);
    for (const board of customBoards) map.set(board.id, board);
    return map;
  }, [catalogBoards, customBoards]);
  const boardBySlug = useMemo(
    () => new Map([...boardById.values()].map((board) => [board.slug, board])),
    [boardById]
  );
  const boardForController = useCallback(
    (ctrl: ControllerItem): BoardProfileItem | null => {
      const byId = ctrl.board_catalog_id
        ? boardById.get(ctrl.board_catalog_id)
        : ctrl.custom_board_id
          ? boardById.get(ctrl.custom_board_id)
          : undefined;
      if (byId) return byId;
      const slug = ctrl.board_compat?.slug ?? ctrl.reported_board_slug;
      return (slug ? boardBySlug.get(slug) : undefined) ?? null;
    },
    [boardById, boardBySlug]
  );
  const assignableRooms = useMemo(
    () => (roomTarget ? rooms.filter((r) => r.home_id === roomTarget.home_id) : []),
    [rooms, roomTarget]
  );

  function openRoomAssign(ctrl: ControllerItem) {
    setRoomSelection(ctrl.room_id ?? "");
    setRoomTarget(ctrl);
  }

  async function handleAssignRoom() {
    if (!roomTarget || assigningRoom) return;
    setAssigningRoom(true);
    try {
      const nextRoomId = roomSelection === "" ? null : roomSelection;
      const res = await apiFetch<{ controller: ControllerItem }>(
        `/api/controllers/${roomTarget.id}/room`,
        {
          method: "PATCH",
          body: JSON.stringify({ roomId: nextRoomId }),
        }
      );
      setControllers((prev) =>
        prev.map((c) => (c.id === res.controller.id ? { ...c, ...res.controller } : c))
      );
      toast.success(nextRoomId ? "Controller assigned to room." : "Room assignment removed.");
      setRoomTarget(null);
      void load(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update room assignment.");
    } finally {
      setAssigningRoom(false);
    }
  }

  const filteredControllers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return controllers;
    return controllers.filter((c) =>
      `${c.name} ${c.board_model} ${c.chip_variant} ${c.wifi_ssid ?? ""} ${c.local_ip ?? ""} ${c.hardware_uid ?? ""}`
        .toLowerCase()
        .includes(q)
    );
  }, [controllers, search]);

  const filteredTrash = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return trashedControllers;
    return trashedControllers.filter((c) =>
      `${c.name} ${c.board_model} ${c.chip_variant}`.toLowerCase().includes(q)
    );
  }, [trashedControllers, search]);

  // Live poll while recovery/pairing modal is open
  const pairingControllerId = pairingModal?.controllerId ?? null;
  useEffect(() => {
    if (!pairingControllerId) {
      setLivePairedStatus(null);
      return;
    }
    let active = true;
    let syncedOnline = false;
    const poll = async () => {
      try {
        const res = await apiFetch<{ controller: ControllerItem }>(
          `/api/controllers/${pairingControllerId}`
        );
        if (active && res.controller) {
          setLivePairedStatus(res.controller);
          if (
            !syncedOnline &&
            res.controller.pairing_status === "paired" &&
            res.controller.status === "online"
          ) {
            syncedOnline = true;
            void load();
          }
        }
      } catch {
        // ignore transient poll failures
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [pairingControllerId, load]);

  async function handleAction(
    ctrl: ControllerItem,
    action: "disconnect" | "reconnect" | "restart" | "reset"
  ) {
    try {
      await apiFetch(`/api/controllers/${ctrl.id}/${action}`, { method: "POST" });
      toast.success(`Dispatched "${action}" to ${ctrl.name}.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : `Failed to ${action} controller.`);
    }
  }

  async function handleMoveToTrash() {
    if (!trashTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/controllers/${trashTarget.id}`, { method: "DELETE" });
      toast.success(
        `Moved "${trashTarget.name}" to Trash (retained for 30 days) and paused its MQTT credentials.`
      );
      setTrashTarget(null);
      await load();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to move controller to Trash."
      );
    } finally {
      setDeleting(false);
    }
  }

  async function handleRestoreController(ctrl: ControllerItem) {
    try {
      const res = await apiFetch<{
        controller: ControllerItem;
        pairingCode?: string | null;
        expiresAt?: string | null;
        restoredCounts?: { switches: number; devices: number; sensors: number };
      }>(`/api/controllers/${ctrl.id}/restore`, { method: "POST" });

      const counts = res.restoredCounts;
      const countNote = counts
        ? ` Restored ${counts.switches} switches, ${counts.devices} devices, and ${counts.sensors} sensors.`
        : "";

      toast.success(`Restored "${ctrl.name}" with fresh MQTT credentials.${countNote}`);
      setActiveTab("active");
      if (res.pairingCode) {
        const bootGpio = ctrl.board_compat?.boot_button_gpio ?? 0;
        setPairingModal({
          controllerId: ctrl.id,
          controllerName: ctrl.name,
          code: res.pairingCode,
          expiresAt: res.expiresAt ?? "",
          isRecovery: true,
          physicalSteps: [
            "MQTT credentials were rotated for security after Trash deletion.",
            ctrl.board_compat?.supports_wifi === false
              ? `Hold BOOT (GPIO${bootGpio}) for 3 seconds to open BLE / local recovery mode and enter this recovery code via your companion bridge.`
              : `Hold BOOT (GPIO${bootGpio}) for 3 seconds to open HomecoreOS-Setup-XXXX -> http://192.168.4.1 and enter this recovery code.`,
          ],
        });
      }
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Restore failed.");
    }
  }

  async function handlePermanentDelete() {
    if (!permanentDeleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/controllers/${permanentDeleteTarget.id}/permanent`, {
        method: "DELETE",
      });
      toast.success(
        `Permanently deleted "${permanentDeleteTarget.name}". You can still re-add the physical hardware later via Recover Existing Controller.`
      );
      setPermanentDeleteTarget(null);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Permanent delete failed.");
    } finally {
      setDeleting(false);
    }
  }

  async function handleWifiUpdate(e: FormEvent) {
    e.preventDefault();
    if (!wifiTarget) return;
    try {
      await apiFetch(`/api/controllers/${wifiTarget.id}/wifi`, {
        method: "POST",
        body: JSON.stringify({ ssid: wifiSsid.trim(), password: wifiPassword }),
      });
      toast.success(`Updated Wi-Fi configuration sent to ${wifiTarget.name}.`);
      setWifiTarget(null);
      setWifiSsid("");
      setWifiPassword("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Wi-Fi update failed.");
    }
  }

  if (loading && controllers.length === 0 && trashedControllers.length === 0) {
    return (
      <div className="py-12 text-center text-xs text-muted-foreground">
        Loading controllers...
      </div>
    );
  }

  const pairingBadgeFor = (ctrl: ControllerItem) => {
    const state = ctrl.pairing_status ?? (ctrl.paired_at ? "paired" : "pending");
    if (state === "paired") return { variant: "success-light" as const, label: "Paired" };
    if (state === "recovery_pending") {
      return { variant: "warning-light" as const, label: "Recovery Pending" };
    }
    if (state === "revoked") return { variant: "destructive-light" as const, label: "Revoked" };
    return { variant: "primary-light" as const, label: "Pending Pairing" };
  };

  return (
    <div className="space-y-6">
      <PageHeroHeader
        tone="blue"
        ariaLabel="Controllers Header"
        title="Controllers"
        subtitle={
          <>
            Pair new{" "}
            <span className="font-medium text-foreground/85">
              ESP32 Boards over BLE or Wi-Fi,
            </span>{" "}
            recover existing nodes,{" "}
            <br className="hidden sm:inline" />
            inspect{" "}
            <span className="font-semibold text-blue-700 dark:text-sky-400">
              Live MQTT &amp; Signal Health,
            </span>{" "}
            and restore from 30-day Trash
          </>
        }
        leftIcons={CONTROLLERS_HERO_ICONS.left}
        rightIcons={CONTROLLERS_HERO_ICONS.right}
        searchValue={search}
        onSearchChange={setSearch}
        searchAriaLabel="Search controllers"
        searchPlaceholder="Search controllers (name, board, chip, IP, SSID)..."
        actions={
          <>
            {canManage && (
              <Button size="sm" onClick={() => openSetupFlow("entry")}>
                <RiAddLine className="size-4" aria-hidden="true" />
                Add Controller
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => onNavigate("/firmware")}>
              USB Flasher &amp; OTA
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
        onValueChange={(v) => setActiveTab(v as "active" | "trash")}
        className="space-y-4"
      >
        <TabsList>
          <TabsTrigger value="active">
            Active Controllers ({controllers.length})
          </TabsTrigger>
          <TabsTrigger value="trash">
            <RiHistoryLine className="size-3.5" aria-hidden="true" />
            Trash ({trashedControllers.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="active" className="space-y-4">
          {filteredControllers.length === 0 ? (
            controllers.length > 0 ? (
              <EmptyStatePanel
                icon={<RiCpuLine />}
                title="No matching controllers"
                description={`No active controllers match "${search}".`}
                action={
                  <Button variant="outline" onClick={() => setSearch("")}>
                    Clear Search
                  </Button>
                }
              />
            ) : (
              <EmptyStatePanel
                icon={<RiCpuLine />}
                title="No active controllers paired yet"
                description="Add a new controller over Bluetooth or Wi-Fi, or recover an existing HomecoreOS controller."
                action={
                  canManage ? (
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button onClick={() => openSetupFlow("entry")}>
                        <RiAddLine className="size-4" aria-hidden="true" />
                        Add Controller
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => openSetupFlow("recover_ble")}
                      >
                        <RiShieldCheckLine className="size-4" aria-hidden="true" />
                        Recover Existing Controller
                      </Button>
                    </div>
                  ) : undefined
                }
              />
            )
          ) : (
            <div
              data-testid="controllers-card-grid"
              className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
            >
              {filteredControllers.map((ctrl) => (
                <ControllerCard
                  key={ctrl.id}
                  ctrl={ctrl}
                  board={boardForController(ctrl)}
                  roomName={
                    ctrl.room_id
                      ? roomById.get(ctrl.room_id)?.name ?? "Assigned room"
                      : null
                  }
                  updateVersion={updateVersionByController.get(ctrl.id) ?? null}
                  timezone={timezone}
                  canManage={canManage}
                  canOperate={canOperate}
                  onViewDetails={() => setDetailTarget(ctrl)}
                  onRecover={() => openSetupFlow("entry", ctrl)}
                  onConfigureWifi={() => {
                    setWifiTarget(ctrl);
                    setWifiSsid(ctrl.wifi_ssid ?? "");
                  }}
                  onAssignRoom={() => openRoomAssign(ctrl)}
                  onAction={(action) => void handleAction(ctrl, action)}
                  onMoveToTrash={() => setTrashTarget(ctrl)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="trash" className="space-y-4">
          {filteredTrash.length === 0 ? (
            <EmptyStatePanel
              icon={<RiHistoryLine />}
              tone="neutral"
              title={
                trashedControllers.length > 0
                  ? "No matching controllers in Trash"
                  : "Controller Trash is empty"
              }
              description={
                trashedControllers.length > 0
                  ? `No trashed controllers match "${search}".`
                  : "Deleted controllers stay recoverable in Trash for 30 days along with their rooms, switches, devices, sensors, and board profiles."
              }
              action={
                trashedControllers.length > 0 ? (
                  <Button variant="outline" onClick={() => setSearch("")}>
                    Clear Search
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="space-y-4">
              <StatusAlert tone="info" title="30-Day Controller Recovery Window">
                Restoring a controller from Trash brings back its saved room links, switches, devices, and sensors and provisions fresh MQTT credentials automatically.
              </StatusAlert>
              {filteredTrash.map((ctrl) => (
                <Card
                  key={ctrl.id}
                  className="border-none p-0 shadow-none ring-0 transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md"
                >
                  <MagicCard
                    mode="orb"
                    spotlightTone="blue"
                    className="rounded-xl p-0"
                    contentClassName="py-4"
                  >
                    <CardContent className="flex flex-wrap items-center justify-between gap-4">
                      <div className="space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold text-foreground">{ctrl.name}</h3>
                          <Badge variant="warning-light" radius="full">
                            {ctrl.days_remaining ?? 30} days left
                          </Badge>
                          <Badge variant="secondary">
                            {ctrl.board_model}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Deleted {formatTimestamp(ctrl.deleted_at ?? null, timezone)} · Recoverable
                          hardware: {ctrl.recoverable_counts?.switches ?? 0} switches,{" "}
                          {ctrl.recoverable_counts?.devices ?? 0} devices,{" "}
                          {ctrl.recoverable_counts?.sensors ?? 0} sensors
                        </p>
                      </div>
                      {canManage && (
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleRestoreController(ctrl)}
                          >
                            <RiRefreshLine className="size-3.5" aria-hidden="true" />
                            Restore Controller
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => setPermanentDeleteTarget(ctrl)}
                          >
                            <RiDeleteBinLine className="size-3.5" aria-hidden="true" />
                            Delete Permanently
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </MagicCard>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Wi-Fi Update Modal (Online MQTT + Offline BLE / Portal Guidance) */}
      <Dialog open={Boolean(wifiTarget)} onOpenChange={(o) => !o && setWifiTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Configure Wi-Fi for {wifiTarget?.name}</DialogTitle>
            <DialogDescription>
              {wifiTarget?.status === "online"
                ? "Dispatches updated Wi-Fi credentials over encrypted MQTT."
                : "Controller is currently offline — push credentials over Bluetooth LE or configure locally via its Setup AP."}
            </DialogDescription>
          </DialogHeader>
          {wifiTarget && wifiTarget.board_compat?.supports_wifi === false && (
            <StatusAlert tone="warning" title="No Integrated Wi-Fi Radio">
              {wifiTarget.board_compat.connectivity_note ??
                `${wifiTarget.board_model} does not have an integrated Wi-Fi radio and requires a Thread Border Router or BLE provisioning.`}
            </StatusAlert>
          )}
          {wifiTarget &&
            wifiTarget.board_compat?.supports_wifi !== false &&
            wifiTarget.status !== "online" && (
              <StatusAlert tone="warning" title="Offline Wi-Fi Recovery">
                Hold <strong>BOOT (GPIO{wifiTarget.board_compat?.boot_button_gpio ?? 0})</strong>{" "}
                for 3 seconds on the board to enable{" "}
                {wifiTarget.board_compat?.supports_ble !== false
                  ? "Bluetooth LE setup and the open Setup AP ("
                  : "the open Setup AP ("}
                <code className="rounded bg-muted px-1 font-mono">HomecoreOS-Setup-XXXX</code>).
                {" "}Saved devices &amp; pairing stay intact!
              </StatusAlert>
            )}
          <form onSubmit={handleWifiUpdate} className="space-y-3">
            <FormField id="wifi-ssid" label="Wi-Fi SSID">
              <Input
                id="wifi-ssid"
                required
                value={wifiSsid}
                onChange={(e) => setWifiSsid(e.target.value)}
              />
            </FormField>
            <FormField id="wifi-pass" label="Wi-Fi Password">
              <Input
                id="wifi-pass"
                type="password"
                value={wifiPassword}
                onChange={(e) => setWifiPassword(e.target.value)}
              />
            </FormField>
            <DialogFooter className="flex-wrap justify-between gap-2">
              {wifiTarget &&
              wifiTarget.board_compat?.supports_ble !== false &&
              wifiTarget.status !== "online" ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const target = wifiTarget;
                    setWifiTarget(null);
                    openSetupFlow(target.paired_at ? "recover_ble" : "setup_ble", target);
                  }}
                >
                  <RiBluetoothConnectLine className="size-4" aria-hidden="true" />
                  {wifiTarget.paired_at ? "Recover with BLE" : "Setup with BLE"}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={() => setWifiTarget(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!wifiTarget || wifiTarget.status !== "online"}>
                  Send Over MQTT
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Assign to Room Dialog */}
      <Dialog
        open={Boolean(roomTarget)}
        onOpenChange={(open) => !open && setRoomTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Assign {roomTarget?.name} to a room</DialogTitle>
            <DialogDescription>
              The controller appears under the selected room across the console.
              Switches, devices, and sensors keep their own room assignments.
            </DialogDescription>
          </DialogHeader>
          <div
            role="radiogroup"
            aria-label="Select a room"
            className="max-h-72 space-y-1.5 overflow-y-auto"
          >
            <button
              type="button"
              role="radio"
              aria-checked={roomSelection === ""}
              onClick={() => setRoomSelection("")}
              className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                roomSelection === ""
                  ? "border-primary/50 bg-primary/6 ring-1 ring-primary/30"
                  : "hover:bg-muted/50"
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-foreground">
                  No room (remove assignment)
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  Controller stays visible as unassigned
                </span>
              </span>
              {roomSelection === "" && (
                <RiCheckLine className="size-4 shrink-0 text-primary" aria-hidden="true" />
              )}
            </button>
            {assignableRooms.map((room) => {
              const selected = roomSelection === room.id;
              return (
                <button
                  key={room.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setRoomSelection(room.id)}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                    selected
                      ? "border-primary/50 bg-primary/6 ring-1 ring-primary/30"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <RiDoorOpenLine
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="truncate font-medium text-foreground">
                      {room.name}
                    </span>
                  </span>
                  {selected && (
                    <RiCheckLine className="size-4 shrink-0 text-primary" aria-hidden="true" />
                  )}
                </button>
              );
            })}
            {roomTarget && assignableRooms.length === 0 && (
              <EmptyStatePanel
                compact
                icon={<RiDoorOpenLine className="size-5" />}
                tone="neutral"
                title="No rooms in this home yet"
                description="Create a room first, then come back to assign this controller."
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setRoomTarget(null);
                      onNavigate("/rooms");
                    }}
                  >
                    Go to Rooms
                  </Button>
                }
              />
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRoomTarget(null)}
              disabled={assigningRoom}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleAssignRoom()}
              disabled={
                assigningRoom ||
                (roomTarget ? roomSelection === (roomTarget.room_id ?? "") : true)
              }
            >
              {assigningRoom
                ? "Saving…"
                : roomSelection === ""
                  ? "Remove Assignment"
                  : "Save Assignment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move to Trash Dialog */}
      <ConfirmDeleteDialog
        open={Boolean(trashTarget)}
        onOpenChange={(open) => !open && setTrashTarget(null)}
        title={`Move "${trashTarget?.name ?? ""}" to Trash?`}
        description="This immediately pauses MQTT access and moves the controller (along with its room links, switches, devices, and sensors) to Trash for 30 days. You can restore it anytime within 30 days."
        confirmLabel="Move to Trash"
        busy={deleting}
        onConfirm={handleMoveToTrash}
      />

      {/* Controller Details Modal */}
      <Dialog open={Boolean(detailTarget)} onOpenChange={(o) => !o && setDetailTarget(null)}>
        <DialogContent className="sm:max-w-2xl">
          {detailTarget &&
            (() => {
              const pairingBadge = pairingBadgeFor(detailTarget);
              const wifiUp =
                detailTarget.wifi_connected ?? detailTarget.status === "online";
              const lastSeenAt =
                detailTarget.last_communication_at ?? detailTarget.last_heartbeat_at;
              return (
                <>
                  <DialogHeader>
                    <DialogTitle className="flex flex-wrap items-center gap-2">
                      <span>{detailTarget.name}</span>
                      <Badge
                        variant={
                          detailTarget.status === "online"
                            ? "success-light"
                            : detailTarget.status === "pending"
                              ? "primary-light"
                              : "warning-light"
                        }
                        radius="full"
                      >
                        {detailTarget.status}
                      </Badge>
                    </DialogTitle>
                    <DialogDescription>
                      {detailTarget.board_model} · {detailTarget.chip_variant} ·{" "}
                      {detailTarget.detected_flash_size_mb ?? detailTarget.flash_size_mb}MB Flash
                      {" · "}
                      {detailTarget.psram_size_mb}MB PSRAM
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={wifiUp ? "success-light" : "secondary"}>
                        {wifiUp ? (
                          <RiWifiLine className="size-3" aria-hidden="true" />
                        ) : (
                          <RiWifiOffLine className="size-3" aria-hidden="true" />
                        )}
                        {wifiUp ? "Wi-Fi Connected" : "Wi-Fi Disconnected"}
                      </Badge>
                      <Badge
                        variant={detailTarget.mqtt_connected ? "success-light" : "secondary"}
                      >
                        {detailTarget.mqtt_connected
                          ? "MQTT Connected"
                          : "MQTT Disconnected"}
                      </Badge>
                      <Badge variant={pairingBadge.variant}>{pairingBadge.label}</Badge>
                      {detailTarget.board_compat?.supports_wifi === false && (
                        <Badge variant="warning-light">No Wi-Fi (802.15.4 / BLE)</Badge>
                      )}
                    </div>

                    <Frame spacing="xs">
                      <FramePanel className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <div className="min-w-0">
                          <p className="text-[11px] text-muted-foreground">Firmware Version</p>
                          <p className="font-mono text-xs font-semibold text-foreground break-words">
                            {detailTarget.firmware_version ?? "Unpaired"}
                          </p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[11px] text-muted-foreground">Wi-Fi SSID</p>
                          <p className="text-xs font-semibold text-foreground break-words">
                            {detailTarget.wifi_ssid ?? "—"}
                          </p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[11px] text-muted-foreground">Signal (RSSI)</p>
                          <p className="font-mono text-xs font-semibold tabular-nums text-foreground">
                            {detailTarget.wifi_rssi !== null
                              ? `${detailTarget.wifi_rssi} dBm`
                              : "—"}
                          </p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[11px] text-muted-foreground">Local IP</p>
                          <p className="font-mono text-xs font-semibold text-foreground">
                            {detailTarget.local_ip ?? "—"}
                          </p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[11px] text-muted-foreground">Last Seen</p>
                          <p className="text-xs font-semibold tabular-nums text-foreground">
                            {formatTimestamp(lastSeenAt, timezone)}
                          </p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[11px] text-muted-foreground">Room</p>
                          <p className="flex items-center gap-1 text-xs font-semibold text-foreground break-words">
                            <RiDoorOpenLine className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                            {detailTarget.room_id
                              ? roomById.get(detailTarget.room_id)?.name ?? "Assigned room"
                              : "Unassigned"}
                          </p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[11px] text-muted-foreground">Hardware UID</p>
                          <p className="font-mono text-xs font-semibold text-foreground break-all">
                            {detailTarget.hardware_uid ?? "—"}
                          </p>
                        </div>
                        {detailTarget.board_compat && (
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">BOOT Button GPIO</p>
                            <p className="font-mono text-xs font-semibold text-foreground">
                              GPIO{detailTarget.board_compat.boot_button_gpio}
                            </p>
                          </div>
                        )}
                        {detailTarget.detected_chip_name && (
                          <div className="min-w-0 sm:col-span-2">
                            <p className="text-[11px] text-muted-foreground">
                              Reported Hardware Target
                            </p>
                            <p className="font-mono text-xs font-semibold text-foreground break-words">
                              {detailTarget.detected_chip_name}
                              {detailTarget.reported_board_slug
                                ? ` (${detailTarget.reported_board_slug})`
                                : ""}
                            </p>
                          </div>
                        )}
                      </FramePanel>
                    </Frame>

                    {detailTarget.last_error && (
                      <StatusAlert tone="danger" title="Connection Error Details">
                        <span className="font-medium break-words [overflow-wrap:anywhere]">
                          {detailTarget.last_error}
                        </span>
                        {detailTarget.last_error_at && (
                          <span className="ml-2 text-[11px] opacity-80">
                            ({formatTimestamp(detailTarget.last_error_at, timezone)})
                          </span>
                        )}
                      </StatusAlert>
                    )}

                    {detailTarget.offline_recovery_instructions && (
                      <StatusAlert
                        tone="warning"
                        title={`Recovery Instructions (${detailTarget.status})`}
                      >
                        <ul className="list-disc space-y-1 pl-4">
                          {detailTarget.offline_recovery_instructions.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ul>
                      </StatusAlert>
                    )}
                  </div>

                  <DialogFooter className="flex-wrap justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {canManage && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const target = detailTarget;
                            setDetailTarget(null);
                            setWifiTarget(target);
                            setWifiSsid(target.wifi_ssid ?? "");
                          }}
                        >
                          <RiWifiLine className="size-4" aria-hidden="true" />
                          Configure Wi-Fi
                        </Button>
                      )}
                      {canManage && detailTarget.board_compat?.supports_ble !== false && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const target = detailTarget;
                            setDetailTarget(null);
                            openSetupFlow(
                              target.paired_at ? "recover_ble" : "setup_ble",
                              target
                            );
                          }}
                        >
                          <RiBluetoothConnectLine className="size-4" aria-hidden="true" />
                          {detailTarget.paired_at ? "Recover with BLE" : "Setup with BLE"}
                        </Button>
                      )}
                      {canManage && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const target = detailTarget;
                            setDetailTarget(null);
                            openSetupFlow("entry", target);
                          }}
                        >
                          <RiShieldCheckLine className="size-4" aria-hidden="true" />
                          Recover / Re-pair
                        </Button>
                      )}
                      {canOperate && detailTarget.status === "online" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const target = detailTarget;
                            setDetailTarget(null);
                            void handleAction(target, "restart");
                          }}
                        >
                          <RiRestartLine className="size-4" aria-hidden="true" />
                          Restart
                        </Button>
                      )}
                    </div>
                    <Button variant="secondary" size="sm" onClick={() => setDetailTarget(null)}>
                      Close
                    </Button>
                  </DialogFooter>
                </>
              );
            })()}
        </DialogContent>
      </Dialog>

      {/* Post-Restore Recovery Code Modal */}
      <Dialog open={Boolean(pairingModal)} onOpenChange={(o) => !o && setPairingModal(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Recover &amp; Re-pair &ldquo;{pairingModal?.controllerName}&rdquo;
            </DialogTitle>
            <DialogDescription>
              Single-use 6-digit recovery code generated after restoring from Trash.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Frame spacing="sm">
              <FramePanel className="p-5 text-center">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  6-Digit Recovery Code
                </p>
                <p className="mt-2 font-mono text-3xl font-bold tracking-[0.25em] text-primary tabular-nums">
                  {pairingModal?.code}
                </p>
                {pairingModal?.expiresAt && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Expires {formatTimestamp(pairingModal.expiresAt, timezone)}
                  </p>
                )}
              </FramePanel>
            </Frame>

            {livePairedStatus?.pairing_status === "paired" &&
            livePairedStatus.status === "online" ? (
              <StatusAlert tone="success" title="Controller Verified & Online">
                <span className="inline-flex items-center gap-1.5">
                  <RiCheckboxCircleFill className="size-4" aria-hidden="true" />
                  {livePairedStatus.name} connected via MQTT from{" "}
                  {livePairedStatus.local_ip ?? "local network"}.
                </span>
              </StatusAlert>
            ) : (
              <StatusAlert tone="info" title="Waiting for Recovery">
                <ol className="list-decimal space-y-1 pl-4">
                  {(
                    pairingModal?.physicalSteps ?? [
                      "Hold your board's BOOT button for 3 seconds to open setup mode.",
                      "Connect to HomecoreOS-Setup-XXXX and open http://192.168.4.1, or click Recover with BLE below.",
                    ]
                  ).map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </StatusAlert>
            )}
          </div>
          <DialogFooter className="flex-wrap justify-between gap-2">
            {(() => {
              const modalCtrl = controllers.find(
                (c) => c.id === pairingModal?.controllerId
              );
              const bleCapable = modalCtrl?.board_compat?.supports_ble !== false;
              return bleCapable ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setPairingModal(null);
                    openSetupFlow("recover_ble", modalCtrl ?? null);
                  }}
                >
                  <RiBluetoothConnectLine className="size-4" aria-hidden="true" />
                  Recover with BLE
                </Button>
              ) : (
                <span />
              );
            })()}
            <Button onClick={() => setPairingModal(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Permanent Delete Dialog */}
      <ConfirmDeleteDialog
        open={Boolean(permanentDeleteTarget)}
        onOpenChange={(open) => !open && setPermanentDeleteTarget(null)}
        title={`Permanently delete "${permanentDeleteTarget?.name ?? ""}"?`}
        description="This permanently erases the controller record, MQTT credentials, and attached switches/devices/sensors from HomecoreOS. You can still re-add the physical hardware later via Recover Existing Controller."
        confirmLabel="Delete Permanently"
        busy={deleting}
        onConfirm={handlePermanentDelete}
      />

      {/* Unified 4-Option Controller Setup & Recovery Modal */}
      <ControllerSetupModal
        open={setupModal.open}
        initialView={setupModal.initialView}
        targetController={setupModal.targetController}
        controllers={controllers}
        trashedControllers={trashedControllers}
        homes={homes}
        catalogBoards={catalogBoards}
        customBoards={customBoards}
        onClose={() =>
          setSetupModal({ open: false, initialView: "entry", targetController: null })
        }
        onSuccess={(message) => {
          toast.success(message);
          void load(true);
        }}
      />
    </div>
  );
}
