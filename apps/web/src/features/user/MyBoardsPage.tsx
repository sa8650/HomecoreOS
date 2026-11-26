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
import { useLiveSync } from "@/lib/realtime/RealtimeProvider";
import { getRealtimeClient } from "@/lib/realtime/sync-client";
import { formatTimestamp, useEffectiveTimezone } from "@/lib/timezone";
import {
  ControllerSetupModal,
  type ControllerSetupView,
} from "@/components/controllers/ControllerSetupModal";
import { ControllerCard } from "@/components/controllers/ControllerCard";
import { NodeCard } from "@/components/controllers/NodeCard";
import { NodeControllerLinkDialog } from "@/components/controllers/NodeControllerLinkDialog";
import {
  canAssignNodeToController,
  getBoardCapabilities,
  normalizeBoardRole,
  supportsRole,
} from "@homecoreos/shared";
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
    boardInstanceId: string;
    availableRelease?: { version?: string } | null;
  }>;
};

export function MyBoardsPage({
  canManage,
  canOperate,
  onNavigate,
}: {
  canManage: boolean;
  canOperate: boolean;
  onNavigate: (path: string) => void;
}) {
  const timezone = useEffectiveTimezone();
  const cachedCtrls = getCachedSnapshot<{ controllers: ControllerItem[] }>("/api/board-instances");
  const [activeTab, setActiveTab] = useState<"active" | "nodes" | "trash">("active");
  const [search, setSearch] = useState("");
  const [controllers, setControllers] = useState<ControllerItem[]>(
    () => cachedCtrls?.controllers ?? []
  );
  const [trashedControllers, setTrashedControllers] = useState<ControllerItem[]>([]);
  const [catalogBoards, setCatalogBoards] = useState<BoardProfileItem[]>([]);
  const [customBoardProfiles, setCustomBoards] = useState<BoardProfileItem[]>([]);
  const [updateVersionByController, setUpdateVersionByController] = useState<
    Map<string, string>
  >(new Map());
  const [homes, setHomes] = useState<HomeItem[]>([]);
  const [rooms, setRooms] = useState<RoomItem[]>([]);
  const [loading, setLoading] = useState(!cachedCtrls);

  const [renameTarget, setRenameTarget] = useState<ControllerItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);

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
    boardInstanceId: string;
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

  const [roleTarget, setRoleTarget] = useState<{
    device: ControllerItem;
    role: "controller" | "node";
  } | null>(null);
  const [makeNodeControllerId, setMakeNodeControllerId] = useState<string>("");
  const [roleSubmitting, setRoleSubmitting] = useState(false);
  const [makeNodePartialFailure, setMakeNodePartialFailure] = useState<{
    nodeId: string;
    error: string;
  } | null>(null);
  const [attachedNodeWarning, setAttachedNodeWarning] = useState<{
    device: ControllerItem;
    count: number;
    selectedControllerId: string;
  } | null>(null);
  const [assignNodeTarget, setAssignNodeTarget] = useState<ControllerItem | null>(null);
  const [assignNodeSelection, setAssignNodeSelection] = useState<string>("");
  const [relinkTarget, setRelinkTarget] = useState<ControllerItem | null>(null);
  const [linkVerification, setLinkVerification] = useState<{
    nodeId: string;
    controllerId: string;
  } | null>(null);
  const [linkRetrying, setLinkRetrying] = useState(false);
  const [linkRetryError, setLinkRetryError] = useState<string | null>(null);

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
    if (!getCachedSnapshot("/api/board-instances")) {
      setLoading(true);
    }
    try {
      const primaryPromise = cachedGet<{ controllers: ControllerItem[] }>(
        "/api/board-instances",
        { ttlMs: 15_000, force }
      ).then((cRes) => {
        setControllers(cRes.controllers);
        setLoading(false);
        return cRes;
      });

      const secondaryPromise = Promise.allSettled([
        cachedGet<{ controllers: ControllerItem[] }>("/api/board-instances/trash", {
          ttlMs: 15_000,
          force,
        }),
        cachedGet<{ boards: BoardProfileItem[] }>("/api/board-library/catalog", {
          ttlMs: 60_000,
          force,
        }),
        cachedGet<{ boards: BoardProfileItem[] }>("/api/board-library/custom", {
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
            if (version) next.set(update.boardInstanceId, version);
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
    for (const board of customBoardProfiles) map.set(board.id, board);
    return map;
  }, [catalogBoards, customBoardProfiles]);
  const boardBySlug = useMemo(
    () => new Map([...boardById.values()].map((board) => [board.slug, board])),
    [boardById]
  );
  const boardForController = useCallback(
    (ctrl: ControllerItem): BoardProfileItem | null => {
      const byId = ctrl.board_profile_id
        ? boardById.get(ctrl.board_profile_id)
        : ctrl.custom_board_profile_id
          ? boardById.get(ctrl.custom_board_profile_id)
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

  function openRename(device: ControllerItem) {
    setRenameValue(device.name);
    setRenameTarget(device);
  }

  /** Renames a Controller or a Node. The device record itself is untouched. */
  async function handleRename(e: FormEvent) {
    e.preventDefault();
    if (!renameTarget || renaming) return;
    const name = renameValue.trim();
    if (!name || name === renameTarget.name) return;
    setRenaming(true);
    try {
      const res = await apiFetch<{ controller: ControllerItem }>(
        `/api/board-instances/${renameTarget.id}`,
        { method: "PATCH", body: JSON.stringify({ name }) }
      );
      setControllers((prev) =>
        prev.map((c) => (c.id === res.controller.id ? { ...c, ...res.controller } : c))
      );
      toast.success(`Renamed to ${res.controller.name ?? name}.`);
      setRenameTarget(null);
      void load(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Rename failed.");
    } finally {
      setRenaming(false);
    }
  }

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
        `/api/board-instances/${roomTarget.id}/room`,
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

  // Every device is either a Controller or a Node; the console keeps them apart
  // instead of showing one mixed list.
  const controllerDevices = useMemo(
    () => controllers.filter((c) => (c.board_role ?? "controller") !== "node"),
    [controllers]
  );
  const nodeDevices = useMemo(
    () => controllers.filter((c) => c.board_role === "node"),
    [controllers]
  );

  // A Node can only be hosted by an online Controller in the same home — the
  // Worker enforces exactly this, so the picker never offers a choice it would
  // reject (an offline Controller cannot answer an ESP-NOW link).
  const nodeTargetCandidates = useMemo(() => {
    const node = assignNodeTarget;
    if (!node) return [];
    return controllerDevices.filter(
      (c) =>
        canAssignNodeToController({
          nodeId: node.id,
          boardInstanceId: c.id,
          controllerRole: normalizeBoardRole(c.board_role),
          controllerOnline: c.status === "online",
          sameHome: !node.home_id || c.home_id === node.home_id,
        }).ok
    );
  }, [assignNodeTarget, controllerDevices]);

  const makeNodeCandidates = useMemo(() => {
    const device = roleTarget?.role === "node" ? roleTarget.device : null;
    if (!device) return [];
    return controllerDevices.filter((c) => {
      const board = boardForController(c);
      const boardId = board?.slug ?? c.board_compat?.slug ?? c.reported_board_slug ?? null;
      const registryBoard = getBoardCapabilities(boardId);
      if (registryBoard && !supportsRole(boardId, "controller")) return false;
      return canAssignNodeToController({
        nodeId: device.id,
        boardInstanceId: c.id,
        controllerRole: normalizeBoardRole(c.board_role),
        controllerOnline: c.status === "online",
        sameHome: !device.home_id || c.home_id === device.home_id,
      }).ok;
    });
  }, [roleTarget, controllerDevices]);

  const filteredControllers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return controllerDevices;
    return controllerDevices.filter((c) =>
      `${c.name} ${c.board_model} ${c.chip_variant} ${c.wifi_ssid ?? ""} ${c.local_ip ?? ""} ${c.hardware_uid ?? ""}`
        .toLowerCase()
        .includes(q)
    );
  }, [controllerDevices, search]);

  const filteredNodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return nodeDevices;
    return nodeDevices.filter((c) =>
      `${c.name} ${c.board_model} ${c.chip_variant} ${c.assigned_controller_name ?? ""} ${c.hardware_uid ?? ""}`
        .toLowerCase()
        .includes(q)
    );
  }, [nodeDevices, search]);

  /** Controller -> Node, or Node -> Controller. The device record is preserved. */
  async function handleRoleChange(
    device: ControllerItem,
    role: "controller" | "node",
    acknowledgeAttachedNodes = false,
    selectedControllerId = ""
  ) {
    if (roleSubmitting) return;
    setRoleSubmitting(true);
    try {
      const alreadyConvertedNode =
        role === "node" && makeNodePartialFailure?.nodeId === device.id;

      if (!alreadyConvertedNode) {
        try {
          await apiFetch(`/api/board-instances/${device.id}/role`, {
            method: "PATCH",
            body: JSON.stringify({ role, acknowledgeAttachedNodes }),
          });
        } catch (err) {
          if (err instanceof ApiError) {
            // The Worker reports how many Nodes would be released, so the operator
            // confirms the fallback explicitly instead of silently losing the link.
            const details = err.details as
              | { attachedNodeCount?: number }
              | undefined;
            if (err.code === "attached_nodes" && !acknowledgeAttachedNodes) {
              setRoleTarget(null);
              setAttachedNodeWarning({
                device,
                count: details?.attachedNodeCount ?? device.connected_node_count ?? 0,
                selectedControllerId,
              });
              return;
            }
            toast.error(err.message);
            return;
          }
          toast.error("Failed to change the device role.");
          return;
        }
      }

      if (role === "node" && selectedControllerId) {
        try {
          await apiFetch(`/api/board-instances/${device.id}/assign-controller`, {
            method: "POST",
            body: JSON.stringify({ boardInstanceId: selectedControllerId }),
          });
          toast.success(`${device.name} is now a Node assigned to its Controller.`);
          setMakeNodePartialFailure(null);
          setRoleTarget(null);
          setLinkRetryError(null);
          setLinkVerification({
            nodeId: device.id,
            controllerId: selectedControllerId,
          });
          await load(true);
          return;
        } catch (assignErr) {
          const errMsg =
            assignErr instanceof ApiError
              ? assignErr.message
              : "Failed to assign the selected Controller.";
          await load(true);
          setMakeNodePartialFailure({ nodeId: device.id, error: errMsg });
          toast.error(
            `${device.name} was converted to a Node, but Controller assignment failed: ${errMsg}`
          );
          return;
        }
      }

      toast.success(
        role === "node"
          ? `${device.name} is now a Node.`
          : `${device.name} is now a Controller.`
      );
      setMakeNodePartialFailure(null);
      setRoleTarget(null);
      await load(true);
    } finally {
      setRoleSubmitting(false);
    }
  }

  async function handleAssignNode(node: ControllerItem, boardInstanceId: string | null) {
    try {
      await apiFetch(`/api/board-instances/${node.id}/assign-controller`, {
        method: "POST",
        body: JSON.stringify({ boardInstanceId }),
      });
      toast.success(
        boardInstanceId ? `${node.name} assigned to its Controller.` : "Controller assignment cleared."
      );
      setAssignNodeTarget(null);
      if (boardInstanceId) {
        setLinkRetryError(null);
        setLinkVerification({ nodeId: node.id, controllerId: boardInstanceId });
      }
      await load(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to assign the Node.");
    }
  }

  async function handleRelink(node: ControllerItem) {
    try {
      const res = await apiFetch<{ deliveredVia: "node" | "controller" }>(
        `/api/board-instances/${node.id}/relink`,
        { method: "POST" }
      );
      toast.success(
        res.deliveredVia === "node"
          ? `Asked ${node.name} to re-link to its Controller.`
          : `Sent the re-link request through ${node.assigned_controller_name ?? "the Controller"}.`
      );
      if (node.assigned_controller_id) {
        setLinkRetryError(null);
        setLinkVerification({
          nodeId: node.id,
          controllerId: node.assigned_controller_id,
        });
      }
      await load(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to re-link the Node.");
    }
  }

  async function handleRetryLinkConnection() {
    if (!linkVerification || linkRetrying) return;
    const liveNode = controllers.find((c) => c.id === linkVerification.nodeId);
    if (!liveNode) return;
    setLinkRetrying(true);
    setLinkRetryError(null);
    try {
      if (liveNode.assigned_controller_id !== linkVerification.controllerId) {
        await apiFetch(`/api/board-instances/${liveNode.id}/assign-controller`, {
          method: "POST",
          body: JSON.stringify({ boardInstanceId: linkVerification.controllerId }),
        });
      } else {
        await apiFetch(`/api/board-instances/${liveNode.id}/relink`, {
          method: "POST",
        });
      }
      await load(true);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Failed to retry the ESP-NOW connection.";
      setLinkRetryError(msg);
      toast.error(msg);
    } finally {
      setLinkRetrying(false);
    }
  }

  const filteredTrash = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return trashedControllers;
    return trashedControllers.filter((c) =>
      `${c.name} ${c.board_model} ${c.chip_variant}`.toLowerCase().includes(q)
    );
  }, [trashedControllers, search]);

  // The board list itself stays current through the shared real-time channel.
  useLiveSync(() => load(true), {
    kinds: ["board", "switch", "device", "sensor", "home"],
    minIntervalMs: linkVerification ? 250 : 2_000,
    fallbackMs: 60_000,
  });

  // While the pairing modal is open, refresh that one controller as soon as its
  // real-time event arrives instead of polling every 3 seconds. The interval is
  // only a fallback for when the broker is unreachable.
  const pairingControllerId = pairingModal?.boardInstanceId ?? null;
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
          `/api/board-instances/${pairingControllerId}`
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
    const unsubscribe = getRealtimeClient().subscribe((batch) => {
      const touched = batch.events.some(
        (event) => event.entity === "board" && event.id === pairingControllerId
      );
      if (touched || batch.resync) void poll();
    });
    const timer = window.setInterval(() => void poll(), 10_000);
    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [pairingControllerId, load]);

  async function handleAction(
    ctrl: ControllerItem,
    action: "disconnect" | "reconnect" | "restart" | "reset"
  ) {
    try {
      await apiFetch(`/api/board-instances/${ctrl.id}/${action}`, { method: "POST" });
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
      await apiFetch(`/api/board-instances/${trashTarget.id}`, { method: "DELETE" });
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
      }>(`/api/board-instances/${ctrl.id}/restore`, { method: "POST" });

      const counts = res.restoredCounts;
      const countNote = counts
        ? ` Restored ${counts.switches} switches, ${counts.devices} devices, and ${counts.sensors} sensors.`
        : "";

      toast.success(`Restored "${ctrl.name}" with fresh MQTT credentials.${countNote}`);
      setActiveTab("active");
      if (res.pairingCode) {
        const bootGpio = ctrl.board_compat?.boot_button_gpio ?? 0;
        setPairingModal({
          boardInstanceId: ctrl.id,
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
      await apiFetch(`/api/board-instances/${permanentDeleteTarget.id}/permanent`, {
        method: "DELETE",
      });
      toast.success(
        `Permanently deleted "${permanentDeleteTarget.name}". You can still re-add the physical hardware later via Recover Existing Board.`
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
      await apiFetch(`/api/board-instances/${wifiTarget.id}/wifi`, {
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
        ariaLabel="My Boards Header"
        title="My Boards"
        subtitle={
          <>
            Manage your{" "}
            <span className="font-medium text-foreground/85">
              Controllers &amp; ESP-NOW Nodes,
            </span>{" "}
            live Wi-Fi &amp; MQTT health,{" "}
            <br className="hidden sm:inline" />
            <span className="font-semibold text-blue-700 dark:text-sky-400">
              Role Switching,
            </span>{" "}
            USB Flashing, and 30-Day Trash Recovery
          </>
        }
        leftIcons={CONTROLLERS_HERO_ICONS.left}
        rightIcons={CONTROLLERS_HERO_ICONS.right}
        searchValue={search}
        onSearchChange={setSearch}
        searchAriaLabel="Search boards"
        searchPlaceholder="Search boards (name, role, model, chip, IP, SSID)..."
        actions={
          <>
            {canManage && (
              <Button size="sm" onClick={() => openSetupFlow("entry")}>
                <RiAddLine className="size-4" aria-hidden="true" />
                Add Board
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => void load(true)}>
              <RiRefreshLine className="size-4" aria-hidden="true" />
              Refresh
            </Button>
          </>
        }
      />

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "active" | "nodes" | "trash")}
        className="space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="active">
              Controllers ({controllerDevices.length})
            </TabsTrigger>
            <TabsTrigger value="nodes">
              Nodes ({nodeDevices.length})
            </TabsTrigger>
          </TabsList>
          {/* My Boards has exactly two role tabs. Deleted boards live behind
              this control so restoring them never turns into a third tab. */}
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={activeTab === "trash"}
            onClick={() => setActiveTab(activeTab === "trash" ? "active" : "trash")}
          >
            <RiHistoryLine className="size-3.5" aria-hidden="true" />
            {activeTab === "trash"
              ? "Back to boards"
              : `Trash (${trashedControllers.length})`}
          </Button>
        </div>

        <TabsContent value="active" className="space-y-4">
          {filteredControllers.length === 0 ? (
            controllerDevices.length > 0 ? (
              <EmptyStatePanel
                icon={<RiCpuLine />}
                title="No matching controllers"
                description={`No Controller matches "${search}".`}
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
                description="Add a new board over Bluetooth or Wi-Fi, or recover an existing HomecoreOS board."
                action={
                  canManage ? (
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button onClick={() => openSetupFlow("entry")}>
                        <RiAddLine className="size-4" aria-hidden="true" />
                        Add Board
                      </Button>
                      <Button variant="outline" onClick={() => openSetupFlow("recover")}>
                        <RiShieldCheckLine className="size-4" aria-hidden="true" />
                        Recover Existing Board
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
                  onRename={() => openRename(ctrl)}
                  onRecover={() => openSetupFlow("recover", ctrl)}
                  onConfigureWifi={() => {
                    setWifiTarget(ctrl);
                    setWifiSsid(ctrl.wifi_ssid ?? "");
                  }}
                  onAssignRoom={() => openRoomAssign(ctrl)}
                  onAction={(action) => void handleAction(ctrl, action)}
                  onMoveToTrash={() => setTrashTarget(ctrl)}
                  onMakeNode={() => {
                    const board = boardForController(ctrl);
                    const boardId = board?.slug ?? ctrl.board_compat?.slug ?? null;
                    if (getBoardCapabilities(boardId) && !supportsRole(boardId, "node")) return;
                    setMakeNodeControllerId("");
                    setMakeNodePartialFailure(null);
                    setRoleTarget({ device: ctrl, role: "node" });
                  }}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="nodes" className="space-y-4">
          {filteredNodes.length === 0 ? (
            nodeDevices.length > 0 ? (
              <EmptyStatePanel
                icon={<RiWifiLine />}
                title="No matching Nodes"
                description={`No Node matches "${search}".`}
                action={
                  <Button variant="outline" onClick={() => setSearch("")}>
                    Clear Search
                  </Button>
                }
              />
            ) : (
              <EmptyStatePanel
                icon={<RiWifiLine />}
                title="No Nodes yet"
                description="A Node runs the same firmware in Node mode: it owns its switches and sensors and reports through its Controller over ESP-NOW, with no separate cloud session. Turn any Controller into a Node from its Actions menu, then assign it to the Controller that will host it."
                action={
                  canManage ? (
                    <Button variant="outline" onClick={() => setActiveTab("active")}>
                      <RiCpuLine className="size-4" aria-hidden="true" />
                      Go to Controllers
                    </Button>
                  ) : undefined
                }
              />
            )
          ) : (
            <div
              data-testid="nodes-card-grid"
              className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
            >
              {filteredNodes.map((node) => (
                <NodeCard
                  key={node.id}
                  node={node}
                  board={boardForController(node)}
                  canManage={canManage}
                  canOperate={canOperate}
                  timezone={timezone}
                  onViewDetails={() => setDetailTarget(node)}
                  onRename={() => openRename(node)}
                  onAssignController={() => {
                    setAssignNodeSelection(node.assigned_controller_id ?? "");
                    setAssignNodeTarget(node);
                  }}
                  onRelink={() => setRelinkTarget(node)}
                  onPromote={() => setRoleTarget({ device: node, role: "controller" })}
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

      {/* Unified Controller / Node role dialogs. A role change never recreates
          the device: identity, pairing, firmware history and hardware config
          stay exactly as they are. */}
      <Dialog
        open={roleTarget !== null}
        onOpenChange={(open) => {
          if (!open && !roleSubmitting) {
            setMakeNodePartialFailure(null);
            setRoleTarget(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {roleTarget?.role === "node" ? "Make this a Node?" : "Make this a Controller?"}
            </DialogTitle>
            <DialogDescription>
              {roleTarget?.role === "node"
                ? `${roleTarget?.device.name ?? "This device"} keeps its switches, sensors, devices, room links, pairing and firmware history. As a Node it reaches HomecoreOS through a Controller over ESP-NOW instead of its own cloud session.`
                : `${roleTarget?.device.name ?? "This device"} will host its own cloud connection again and can host Nodes over ESP-NOW.`}
            </DialogDescription>
          </DialogHeader>

          {roleTarget && (
            <div
              className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs"
              data-testid="role-dialog-board-summary"
            >
              <div className="flex min-w-0 items-center gap-2">
                <RiCpuLine className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="truncate font-semibold text-foreground">
                    {roleTarget.device.name}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {roleTarget.device.board_compat?.model ?? roleTarget.device.board_model}
                  </p>
                </div>
              </div>
              <Badge variant="secondary" size="sm" radius="full">
                {roleTarget.role === "node" ? "Controller → Node" : "Node → Controller"}
              </Badge>
            </div>
          )}

          {roleTarget?.role === "node" ? (
            <div className="space-y-3">
              {makeNodePartialFailure && (
                <StatusAlert
                  tone="warning"
                  title="Converted to Node — Controller assignment failed"
                >
                  <p>
                    {roleTarget.device.name} is safely saved as an unassigned Node on Wi-Fi /
                    MQTT, but assigning it to the selected Controller failed:{" "}
                    <span className="font-semibold">{makeNodePartialFailure.error}</span>.
                    Choose an online Controller below to retry assignment, or leave it unassigned.
                  </p>
                </StatusAlert>
              )}

              <div className="space-y-1.5 text-xs text-muted-foreground">
                <p>
                  The board switches into Node mode and seeks the Controller you assign over 2.4 GHz
                  ESP-NOW. If that Controller becomes unreachable, it falls back to Standalone Node
                  Wi-Fi / MQTT without ever promoting itself to a Controller.
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-foreground">Choose Controller</p>
                  <span className="text-[11px] text-muted-foreground">Optional</span>
                </div>

                <div
                  role="radiogroup"
                  aria-label="Choose Controller"
                  className="max-h-60 space-y-1.5 overflow-y-auto"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={makeNodeControllerId === ""}
                    onClick={() => setMakeNodeControllerId("")}
                    className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                      makeNodeControllerId === ""
                        ? "border-primary/50 bg-primary/6 ring-1 ring-primary/30"
                        : "hover:bg-muted/50"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground">
                        Set Controller Later
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        Convert to Node now and assign a Controller later
                      </span>
                    </span>
                    {makeNodeControllerId === "" && (
                      <RiCheckLine
                        className="size-4 shrink-0 text-primary"
                        aria-hidden="true"
                      />
                    )}
                  </button>

                  {makeNodeCandidates.map((candidate) => {
                    const selected = makeNodeControllerId === candidate.id;
                    const candidateModel =
                      candidate.board_compat?.model ?? candidate.board_model;
                    const mqttUp = candidate.mqtt_connected !== false;
                    return (
                      <button
                        key={candidate.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setMakeNodeControllerId(candidate.id)}
                        className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                          selected
                            ? "border-primary/50 bg-primary/6 ring-1 ring-primary/30"
                            : "hover:bg-muted/50"
                        }`}
                      >
                        <span className="flex min-w-0 items-start gap-2.5">
                          <RiCpuLine
                            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 space-y-1">
                            <span className="block truncate font-medium text-foreground">
                              {candidate.name}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {candidateModel} · {candidate.connected_node_count ?? 0} Node
                              {(candidate.connected_node_count ?? 0) === 1 ? "" : "s"} linked
                            </span>
                            <span className="flex flex-wrap items-center gap-1 pt-0.5">
                              <Badge variant="success-light" size="xs" radius="full">
                                Online
                              </Badge>
                              <Badge
                                variant={mqttUp ? "success-light" : "warning-light"}
                                size="xs"
                                radius="full"
                              >
                                {mqttUp ? "MQTT Connected" : "MQTT Disconnected"}
                              </Badge>
                            </span>
                          </span>
                        </span>
                        {selected && (
                          <RiCheckLine
                            className="size-4 shrink-0 text-primary"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>

                {makeNodeCandidates.length === 0 && (
                  <p
                    className="rounded-lg border border-dashed border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                    data-testid="make-node-no-controllers-note"
                  >
                    No online Controllers are available in this home right now. Keep{" "}
                    <span className="font-medium text-foreground">Set Controller Later</span>{" "}
                    selected to convert this board now and assign a Controller once one is online.
                  </p>
                )}

                {makeNodeControllerId !== "" &&
                  !makeNodeCandidates.some((c) => c.id === makeNodeControllerId) && (
                    <StatusAlert tone="warning" title="Selected Controller Offline">
                      The selected Controller is no longer online. Choose another online Controller
                      or select Set Controller Later.
                    </StatusAlert>
                  )}
              </div>
            </div>
          ) : (
            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                A Controller needs Wi-Fi and ESP-NOW. Devices on boards without a Wi-Fi radio
                cannot take this role.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              disabled={roleSubmitting}
              onClick={() => {
                setMakeNodePartialFailure(null);
                setRoleTarget(null);
              }}
            >
              {makeNodePartialFailure ? "Close" : "Cancel"}
            </Button>
            <Button
              disabled={
                roleSubmitting ||
                (roleTarget?.role === "node" &&
                  makeNodeControllerId !== "" &&
                  !makeNodeCandidates.some((c) => c.id === makeNodeControllerId))
              }
              onClick={() => {
                if (!roleTarget) return;
                const target = roleTarget;
                void handleRoleChange(
                  target.device,
                  target.role,
                  false,
                  target.role === "node" ? makeNodeControllerId : ""
                );
              }}
            >
              {roleSubmitting
                ? "Saving…"
                : makeNodePartialFailure
                  ? makeNodeControllerId
                    ? "Retry Assignment"
                    : "Leave Unassigned"
                  : roleTarget?.role === "node"
                    ? "Make Node"
                    : "Make Controller"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={attachedNodeWarning !== null}
        onOpenChange={(open) => {
          if (!open && !roleSubmitting) setAttachedNodeWarning(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Nodes still rely on this Controller</DialogTitle>
            <DialogDescription>
              {attachedNodeWarning?.count ?? 0} Node
              {(attachedNodeWarning?.count ?? 0) === 1 ? "" : "s"} are linked to{" "}
              {attachedNodeWarning?.device.name ?? "this Controller"}. Making it a Node releases
              them: each one switches to its Wi-Fi connection and keeps running as a Standalone
              Node until you assign it to another Controller.
              {attachedNodeWarning?.selectedControllerId
                ? ` After releasing them, ${attachedNodeWarning.device.name} will be assigned to ${
                    controllerDevices.find(
                      (c) => c.id === attachedNodeWarning.selectedControllerId
                    )?.name ?? "the selected Controller"
                  }.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={roleSubmitting}
              onClick={() => setAttachedNodeWarning(null)}
            >
              Keep as Controller
            </Button>
            <Button
              disabled={roleSubmitting}
              onClick={() => {
                const warning = attachedNodeWarning;
                if (!warning) return;
                setAttachedNodeWarning(null);
                void handleRoleChange(
                  warning.device,
                  "node",
                  true,
                  warning.selectedControllerId
                );
              }}
            >
              Release Nodes and Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={assignNodeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setAssignNodeTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Assign a Controller</DialogTitle>
            <DialogDescription>
              Choose the Controller that will host {assignNodeTarget?.name ?? "this Node"} over
              ESP-NOW. It must be online and in the same home.
            </DialogDescription>
          </DialogHeader>
          <div
            role="radiogroup"
            aria-label="Select a Controller"
            className="max-h-72 space-y-1.5 overflow-y-auto"
          >
            <button
              type="button"
              role="radio"
              aria-checked={assignNodeSelection === ""}
              onClick={() => setAssignNodeSelection("")}
              className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                assignNodeSelection === ""
                  ? "border-primary/50 bg-primary/6 ring-1 ring-primary/30"
                  : "hover:bg-muted/50"
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-foreground">
                  No Controller (remove assignment)
                </span>
                <span className="block text-xs text-muted-foreground">
                  The Node stays reachable over Wi-Fi only
                </span>
              </span>
              {assignNodeSelection === "" && (
                <RiCheckLine className="size-4 shrink-0 text-primary" aria-hidden="true" />
              )}
            </button>
            {nodeTargetCandidates.map((candidate) => {
              const selected = assignNodeSelection === candidate.id;
              return (
                <button
                  key={candidate.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setAssignNodeSelection(candidate.id)}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                    selected
                      ? "border-primary/50 bg-primary/6 ring-1 ring-primary/30"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <RiCpuLine
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground">
                        {candidate.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {candidate.connected_node_count ?? 0} Node
                        {(candidate.connected_node_count ?? 0) === 1 ? "" : "s"} linked ·{" "}
                        {candidate.status}
                      </span>
                    </span>
                  </span>
                  {selected && (
                    <RiCheckLine className="size-4 shrink-0 text-primary" aria-hidden="true" />
                  )}
                </button>
              );
            })}
            {nodeTargetCandidates.length === 0 && (
              <EmptyStatePanel
                compact
                icon={<RiCpuLine className="size-5" />}
                tone="neutral"
                title="No Controller available"
                description="Add or bring a Controller online first. A Node needs an online Controller in the same home."
              />
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignNodeTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={!assignNodeTarget}
              onClick={() => {
                if (!assignNodeTarget) return;
                void handleAssignNode(
                  assignNodeTarget,
                  assignNodeSelection === "" ? null : assignNodeSelection
                );
              }}
            >
              Save Assignment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={relinkTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRelinkTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Re-link this Node?</DialogTitle>
            <DialogDescription>
              {relinkTarget?.name ?? "This Node"} will drop its Wi-Fi/MQTT fallback and look for{" "}
              {relinkTarget?.assigned_controller_name ?? "its Controller"} over ESP-NOW again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRelinkTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const target = relinkTarget;
                if (!target) return;
                setRelinkTarget(null);
                void handleRelink(target);
              }}
            >
              Re-link Now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {(() => {
        const liveLinkNode = linkVerification
          ? controllers.find((c) => c.id === linkVerification.nodeId) ?? null
          : null;
        const liveLinkController = linkVerification
          ? controllers.find((c) => c.id === linkVerification.controllerId) ?? null
          : null;
        return (
          <NodeControllerLinkDialog
            open={linkVerification !== null}
            node={liveLinkNode}
            controller={liveLinkController}
            nodeBoard={liveLinkNode ? boardForController(liveLinkNode) : null}
            controllerBoard={
              liveLinkController ? boardForController(liveLinkController) : null
            }
            timezone={timezone}
            retrying={linkRetrying}
            retryError={linkRetryError}
            canOperate={canOperate}
            canManage={canManage}
            onRetryConnection={() => void handleRetryLinkConnection()}
            onChangeController={() => {
              if (!liveLinkNode) return;
              setLinkVerification(null);
              setAssignNodeSelection(liveLinkNode.assigned_controller_id ?? "");
              setAssignNodeTarget(liveLinkNode);
            }}
            onClose={() => {
              setLinkRetryError(null);
              setLinkVerification(null);
            }}
          />
        );
      })()}

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

      {/* Rename Controller / Node Dialog */}
      <Dialog
        open={Boolean(renameTarget)}
        onOpenChange={(open) => !open && setRenameTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleRename} className="space-y-4">
            <DialogHeader>
              <DialogTitle>
                Edit {renameTarget?.board_role === "node" ? "Node" : "Controller"} name
              </DialogTitle>
              <DialogDescription>
                The name identifies this {renameTarget?.board_role === "node" ? "Node" : "Controller"}{" "}
                everywhere in the console: cards, rooms, notifications and activity history.
              </DialogDescription>
            </DialogHeader>
            <FormField id="rename-device" label="Name">
              <Input
                id="rename-device"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                maxLength={120}
                autoFocus
                required
              />
            </FormField>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenameTarget(null)}
                disabled={renaming}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  renaming ||
                  !renameValue.trim() ||
                  renameValue.trim() === (renameTarget?.name ?? "")
                }
              >
                {renaming ? "Saving…" : "Save Name"}
              </Button>
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
                      {canManage && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const target = detailTarget;
                            setDetailTarget(null);
                            openSetupFlow(target.paired_at ? "recover" : "setup", target);
                          }}
                        >
                          <RiShieldCheckLine className="size-4" aria-hidden="true" />
                          {detailTarget.paired_at ? "Repair / Recover" : "Setup Board"}
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
                (c) => c.id === pairingModal?.boardInstanceId
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
        description="This permanently erases the controller record, MQTT credentials, and attached switches/devices/sensors from HomecoreOS. You can still re-add the physical hardware later via Recover Existing Board."
        confirmLabel="Delete Permanently"
        busy={deleting}
        onConfirm={handlePermanentDelete}
      />

      {/* One modal owns flashing, setup and repair/recovery */}
      <ControllerSetupModal
        open={setupModal.open}
        initialView={setupModal.initialView}
        targetController={setupModal.targetController}
        controllers={controllers}
        trashedControllers={trashedControllers}
        homes={homes}
        catalogBoards={catalogBoards}
        customBoardProfiles={customBoardProfiles}
        canManage={canManage}
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
