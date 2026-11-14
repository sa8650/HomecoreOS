import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  RiAddLine,
  RiDeleteBinLine,
  RiDoorOpenLine,
  RiDropLine,
  RiEditLine,
  RiEyeLine,
  RiFireLine,
  RiLightbulbLine,
  RiLockLine,
  RiMapPinLine,
  RiMore2Fill,
  RiSensorLine,
  RiSunLine,
  RiTempColdLine,
  RiToggleLine,
  RiTv2Line,
  RiWindyLine,
} from "@remixicon/react";
import { isDeviceStateActive } from "@homecoreos/shared";
import { toast } from "sonner";
import { apiFetch, ApiError, cachedGet, getCachedSnapshot } from "@/lib/api";
import {
  fetchBasicHardwareContext,
  fetchHardwareContext,
  isEntityOnline,
  type HardwareContext,
} from "@/lib/board-pin-helpers";
import { formatTimestamp, useEffectiveTimezone } from "@/lib/timezone";
import {
  DeviceEditorModal,
  HardwareDetailsModal,
  MoveHardwareRoomModal,
  SensorEditorModal,
  SwitchEditorModal,
  type HardwareDetailsSubject,
} from "@/components/hardware/EntityModals";
import { Badge } from "@/components/reui/badge";
import { IconTile } from "@/components/reui/icon-tile";
import {
  ConfirmDeleteDialog,
  EmptyStatePanel,
} from "@/components/shared/AppUi";
import {
  DEVICES_HERO_ICONS,
  SENSORS_HERO_ICONS,
  SWITCHES_HERO_ICONS,
} from "@/components/shared/HeroDomainIcons";
import { PageHeroHeader, type HeroTone } from "@/components/shared/PageHeroHeader";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MagicCard } from "@/components/ui/magic-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import type {
  ControllerItem,
  DeviceItem,
  RoomItem,
  SensorItem,
  SwitchItem,
} from "@/features/types";

interface HardwareEntityCardProps {
  name: string;
  typeLabel: string;
  roomName: string;
  icon: ReactNode;
  iconToneClass: string;
  spotlightTone: HeroTone;
  canManage: boolean;
  onViewDetails: () => void;
  onEdit: () => void;
  onMoveRoom: () => void;
  onDelete: () => void;
  children: ReactNode;
}

const HardwareEntityCard = memo(function HardwareEntityCard({
  name,
  typeLabel,
  roomName,
  icon,
  iconToneClass,
  spotlightTone,
  canManage,
  onViewDetails,
  onEdit,
  onMoveRoom,
  onDelete,
  children,
}: HardwareEntityCardProps) {
  return (
    <Card className="h-full border-none p-0 shadow-none ring-0 transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <MagicCard
        mode="orb"
        spotlightTone={spotlightTone}
        className="h-full rounded-xl p-0"
        contentClassName="flex h-full flex-col justify-between gap-3 py-4"
      >
        <CardHeader className="gap-1.5">
          <div className="flex min-w-0 items-start gap-3">
            <IconTile variant="soft" size="sm" className={iconToneClass}>
              {icon}
            </IconTile>
            <div className="min-w-0 flex-1 space-y-0.5">
              <CardTitle className="truncate text-sm font-semibold tracking-tight text-foreground">
                {name}
              </CardTitle>
              <CardDescription className="truncate text-xs capitalize text-muted-foreground">
                {typeLabel}
              </CardDescription>
              <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                <RiMapPinLine className="size-3 shrink-0 opacity-75" aria-hidden="true" />
                <span className="truncate">{roomName}</span>
              </p>
            </div>
          </div>

          <CardAction>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Actions for ${name}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <RiMore2Fill className="size-4" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Actions</DropdownMenuLabel>
                  <DropdownMenuItem onClick={onViewDetails}>
                    <RiEyeLine className="size-4" aria-hidden="true" />
                    View details
                  </DropdownMenuItem>
                  {canManage && (
                    <>
                      <DropdownMenuItem onClick={onEdit}>
                        <RiEditLine className="size-4" aria-hidden="true" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={onMoveRoom}>
                        <RiDoorOpenLine className="size-4" aria-hidden="true" />
                        Move to another room
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuGroup>
                {canManage && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={onDelete}>
                      <RiDeleteBinLine className="size-4" aria-hidden="true" />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </CardAction>
        </CardHeader>

        <CardContent className="pt-0">{children}</CardContent>
      </MagicCard>
    </Card>
  );
});

// ============================================================
// SWITCHES PAGE
// ============================================================

export function SwitchesPage({
  canManage,
  canOperate,
}: {
  canManage: boolean;
  canOperate: boolean;
}) {
  const timezone = useEffectiveTimezone();
  const cachedSw = getCachedSnapshot<{ switches: SwitchItem[] }>("/api/switches");
  const cachedCtrls = getCachedSnapshot<{ controllers: ControllerItem[] }>("/api/controllers");
  const cachedRooms = getCachedSnapshot<{ rooms: RoomItem[] }>("/api/homes/rooms");

  const [switches, setSwitches] = useState<SwitchItem[]>(() => cachedSw?.switches ?? []);
  const [controllers, setControllers] = useState<ControllerItem[]>(
    () => cachedCtrls?.controllers ?? []
  );
  const [rooms, setRooms] = useState<RoomItem[]>(() => cachedRooms?.rooms ?? []);
  const [modalCtx, setModalCtx] = useState<HardwareContext | null>(null);
  const [loading, setLoading] = useState(!cachedSw || !cachedCtrls);
  const [search, setSearch] = useState("");
  const [pendingToggleIds, setPendingToggleIds] = useState<Record<string, boolean>>({});

  const [modalOpen, setModalOpen] = useState(false);
  const [editingSwitch, setEditingSwitch] = useState<SwitchItem | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<SwitchItem | null>(null);
  const [moveTarget, setMoveTarget] = useState<SwitchItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SwitchItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const inFlightToggleIdsRef = useRef<Set<string>>(new Set());
  const toggleSeqRef = useRef<Map<string, number>>(new Map());
  const deletingRef = useRef(false);

  const controllerById = useMemo(
    () => new Map(controllers.map((c) => [c.id, c])),
    [controllers]
  );
  const roomById = useMemo(
    () => new Map(rooms.map((r) => [r.id, r])),
    [rooms]
  );

  const load = useCallback(async (force = false) => {
    if (!getCachedSnapshot("/api/switches")) {
      setLoading(true);
    }
    try {
      const [swRes, hw] = await Promise.all([
        cachedGet<{ switches: SwitchItem[] }>("/api/switches", {
          ttlMs: 12_000,
          force,
        }),
        fetchBasicHardwareContext({ force }),
      ]);
      setSwitches(swRes.switches);
      setControllers(hw.controllers);
      setRooms(hw.rooms);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load switches.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ensureModalContext = useCallback(async () => {
    if (modalCtx) return modalCtx;
    try {
      const full = await fetchHardwareContext(true);
      setModalCtx(full);
      return full;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load board pinout details.");
      return null;
    }
  }, [modalCtx]);

  const openEditor = useCallback(
    (target: SwitchItem | null) => {
      setEditingSwitch(target);
      setModalOpen(true);
      void ensureModalContext();
    },
    [ensureModalContext]
  );

  const handleToggle = useCallback(async (sw: SwitchItem, next: boolean) => {
    // Prevent duplicate MQTT commands while an identical or in-flight command is running
    if (inFlightToggleIdsRef.current.has(sw.id) || sw.is_on === next) {
      return;
    }

    inFlightToggleIdsRef.current.add(sw.id);
    const prevIsOn = sw.is_on;
    const seq = (toggleSeqRef.current.get(sw.id) ?? 0) + 1;
    toggleSeqRef.current.set(sw.id, seq);

    setSwitches((prev) =>
      prev.map((item) => (item.id === sw.id ? { ...item, is_on: next } : item))
    );
    setPendingToggleIds((prev) => ({ ...prev, [sw.id]: true }));

    try {
      const res = await apiFetch<{ switch?: SwitchItem }>(
        `/api/switches/${sw.id}/toggle`,
        {
          method: "POST",
          body: JSON.stringify({ isOn: next }),
        }
      );
      if (toggleSeqRef.current.get(sw.id) === seq && res.switch) {
        setSwitches((prev) =>
          prev.map((item) => (item.id === sw.id ? res.switch! : item))
        );
      }
    } catch (err) {
      if (toggleSeqRef.current.get(sw.id) === seq) {
        setSwitches((prev) =>
          prev.map((item) => (item.id === sw.id ? { ...item, is_on: prevIsOn } : item))
        );
      }
      toast.error(
        err instanceof ApiError ? err.message : `Failed to toggle "${sw.name}".`
      );
    } finally {
      inFlightToggleIdsRef.current.delete(sw.id);
      setPendingToggleIds((prev) => {
        const copy = { ...prev };
        delete copy[sw.id];
        return copy;
      });
    }
  }, []);

  async function handleConfirmDelete() {
    if (!deleteTarget || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    const target = deleteTarget;
    try {
      await apiFetch(`/api/switches/${target.id}`, { method: "DELETE" });
      setSwitches((prev) => prev.filter((item) => item.id !== target.id));
      setModalCtx(null);
      toast.success(`Removed switch "${target.name}".`);
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed.");
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  const filteredSwitches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return switches;
    return switches.filter((sw) => {
      const roomName = sw.room_id ? roomById.get(sw.room_id)?.name ?? "" : "";
      const ctrlName = controllerById.get(sw.controller_id)?.name ?? "";
      return `${sw.name} ${roomName} ${ctrlName}`.toLowerCase().includes(q);
    });
  }, [switches, search, roomById, controllerById]);

  if (loading && switches.length === 0 && controllers.length === 0) {
    return (
      <div className="py-12 text-center text-xs text-muted-foreground">
        Loading switches...
      </div>
    );
  }

  const effectiveModalCtx: HardwareContext = modalCtx ?? {
    controllers,
    rooms,
    boardsById: new Map(),
  };

  const detailsSubject: HardwareDetailsSubject | null = detailsTarget
    ? { kind: "switch", data: detailsTarget }
    : null;

  return (
    <div className="space-y-6">
      <PageHeroHeader
        tone="yellow"
        ariaLabel="Switches Header"
        title="Switches"
        subtitle={
          <>
            Toggle{" "}
            <span className="font-medium text-foreground/85">
              Relays &amp; Lighting Loads
            </span>{" "}
            with instant optimistic control,{" "}
            <br className="hidden sm:inline" />
            <span className="font-semibold text-amber-700 dark:text-amber-400">
              GPIO Channel Bindings,
            </span>{" "}
            &amp; room organization
          </>
        }
        leftIcons={SWITCHES_HERO_ICONS.left}
        rightIcons={SWITCHES_HERO_ICONS.right}
        searchValue={search}
        onSearchChange={setSearch}
        searchAriaLabel="Search switches"
        searchPlaceholder="Search switches by name, room, or controller..."
        actions={
          canManage ? (
            <Button
              size="sm"
              disabled={controllers.length === 0}
              onClick={() => openEditor(null)}
            >
              <RiAddLine className="size-4" aria-hidden="true" />
              Add Switch
            </Button>
          ) : undefined
        }
      />

      {filteredSwitches.length === 0 ? (
        switches.length > 0 ? (
          <EmptyStatePanel
            icon={<RiToggleLine className="size-6" />}
            title="No matching switches"
            description={`No switches match "${search}".`}
            action={
              <Button variant="outline" onClick={() => setSearch("")}>
                Clear Search
              </Button>
            }
          />
        ) : (
          <EmptyStatePanel
            icon={<RiToggleLine className="size-6" />}
            title="No switches configured yet"
            description="Bind your first relay or lighting channel to an available GPIO output pin on a controller."
            action={
              canManage && controllers.length > 0 ? (
                <Button onClick={() => openEditor(null)}>
                  <RiAddLine className="size-4" aria-hidden="true" />
                  Add First Switch
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filteredSwitches.map((sw) => {
            const ctrl = controllerById.get(sw.controller_id);
            const roomName = sw.room_id
              ? roomById.get(sw.room_id)?.name ?? "Assigned room"
              : "Unassigned";
            const isPending = Boolean(pendingToggleIds[sw.id]);
            const online = isEntityOnline(sw.is_online, ctrl);
            return (
              <HardwareEntityCard
                key={sw.id}
                name={sw.name}
                typeLabel="Relay switch"
                roomName={roomName}
                icon={<RiToggleLine className="size-4" aria-hidden="true" />}
                iconToneClass={sw.is_on ? "text-warning" : "text-primary"}
                spotlightTone="yellow"
                canManage={canManage}
                onViewDetails={() => setDetailsTarget(sw)}
                onEdit={() => openEditor(sw)}
                onMoveRoom={() => setMoveTarget(sw)}
                onDelete={() => setDeleteTarget(sw)}
              >
                <div className="flex items-center justify-between gap-2 border-t pt-3">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={sw.is_on ? "success-light" : "secondary"}
                      radius="full"
                    >
                      {sw.is_on ? "ON" : "OFF"}
                    </Badge>
                    {!online && (
                      <Badge variant="warning-light" radius="full">
                        Offline
                      </Badge>
                    )}
                    {isPending && (
                      <span className="text-[11px] text-muted-foreground">
                        Syncing...
                      </span>
                    )}
                  </div>
                  <Switch
                    checked={sw.is_on}
                    disabled={!canOperate || isPending}
                    aria-label={`Toggle ${sw.name}`}
                    onCheckedChange={(next) => void handleToggle(sw, next)}
                  />
                </div>
              </HardwareEntityCard>
            );
          })}
        </div>
      )}

      <SwitchEditorModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        switchItem={editingSwitch}
        ctx={effectiveModalCtx}
        onSaved={async () => {
          setModalCtx(null);
          toast.success(editingSwitch ? "Switch updated." : "Switch created.");
          await load(true);
        }}
      />

      {moveTarget && (
        <MoveHardwareRoomModal
          open={Boolean(moveTarget)}
          onOpenChange={(open) => !open && setMoveTarget(null)}
          entityKind="switch"
          entityId={moveTarget.id}
          entityName={moveTarget.name}
          currentRoomId={moveTarget.room_id}
          rooms={rooms}
          onMoved={(nextRoomId) => {
            setSwitches((prev) =>
              prev.map((item) =>
                item.id === moveTarget.id ? { ...item, room_id: nextRoomId } : item
              )
            );
            toast.success(`Updated room for "${moveTarget.name}".`);
          }}
        />
      )}

      <HardwareDetailsModal
        open={Boolean(detailsTarget)}
        onOpenChange={(open) => !open && setDetailsTarget(null)}
        subject={detailsSubject}
        controller={detailsTarget ? controllerById.get(detailsTarget.controller_id) : undefined}
        room={detailsTarget?.room_id ? roomById.get(detailsTarget.room_id) : undefined}
        timezone={timezone}
        canManage={canManage}
        onEdit={() => {
          if (detailsTarget) openEditor(detailsTarget);
        }}
      />

      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Remove switch "${deleteTarget?.name ?? ""}"?`}
        description="This releases its GPIO assignment and removes any direct switch bindings."
        confirmLabel="Remove Switch"
        busy={deleting}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}

// ============================================================
// DEVICES PAGE
// ============================================================

function DeviceTypeIcon({ type }: { type: string }) {
  switch (type.toLowerCase()) {
    case "tv":
      return <RiTv2Line className="size-4" aria-hidden="true" />;
    case "fan":
      return <RiWindyLine className="size-4" aria-hidden="true" />;
    case "ac":
      return <RiTempColdLine className="size-4" aria-hidden="true" />;
    case "heater":
      return <RiFireLine className="size-4" aria-hidden="true" />;
    case "lock":
    case "door_lock":
      return <RiLockLine className="size-4" aria-hidden="true" />;
    default:
      return <RiLightbulbLine className="size-4" aria-hidden="true" />;
  }
}

export function DevicesPage({
  canManage,
  canOperate,
}: {
  canManage: boolean;
  canOperate: boolean;
}) {
  const timezone = useEffectiveTimezone();
  const cachedDevs = getCachedSnapshot<{ devices: DeviceItem[] }>("/api/devices");
  const cachedCtrls = getCachedSnapshot<{ controllers: ControllerItem[] }>("/api/controllers");
  const cachedRooms = getCachedSnapshot<{ rooms: RoomItem[] }>("/api/homes/rooms");

  const [devices, setDevices] = useState<DeviceItem[]>(() => cachedDevs?.devices ?? []);
  const [controllers, setControllers] = useState<ControllerItem[]>(
    () => cachedCtrls?.controllers ?? []
  );
  const [rooms, setRooms] = useState<RoomItem[]>(() => cachedRooms?.rooms ?? []);
  const [modalCtx, setModalCtx] = useState<HardwareContext | null>(null);
  const [loading, setLoading] = useState(!cachedDevs || !cachedCtrls);
  const [search, setSearch] = useState("");
  const [pendingIds, setPendingIds] = useState<Record<string, boolean>>({});

  const [modalOpen, setModalOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState<DeviceItem | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<DeviceItem | null>(null);
  const [moveTarget, setMoveTarget] = useState<DeviceItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeviceItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const inFlightIdsRef = useRef<Set<string>>(new Set());
  const cmdSeqRef = useRef<Map<string, number>>(new Map());
  const deletingRef = useRef(false);

  const controllerById = useMemo(
    () => new Map(controllers.map((c) => [c.id, c])),
    [controllers]
  );
  const roomById = useMemo(
    () => new Map(rooms.map((r) => [r.id, r])),
    [rooms]
  );

  const load = useCallback(async (force = false) => {
    if (!getCachedSnapshot("/api/devices")) {
      setLoading(true);
    }
    try {
      const [dRes, hw] = await Promise.all([
        cachedGet<{ devices: DeviceItem[] }>("/api/devices", {
          ttlMs: 12_000,
          force,
        }),
        fetchBasicHardwareContext({ force }),
      ]);
      setDevices(dRes.devices);
      setControllers(hw.controllers);
      setRooms(hw.rooms);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load devices.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ensureModalContext = useCallback(async () => {
    if (modalCtx) return modalCtx;
    try {
      const full = await fetchHardwareContext(true);
      setModalCtx(full);
      return full;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load board pinout details.");
      return null;
    }
  }, [modalCtx]);

  const openEditor = useCallback(
    (target: DeviceItem | null) => {
      setEditingDevice(target);
      setModalOpen(true);
      void ensureModalContext();
    },
    [ensureModalContext]
  );

  const handleToggleDevice = useCallback(async (dev: DeviceItem, next: boolean) => {
    const currentlyActive = isDeviceStateActive(dev.state);
    if (inFlightIdsRef.current.has(dev.id) || currentlyActive === next) {
      return;
    }

    inFlightIdsRef.current.add(dev.id);
    const prevState = dev.state;
    const nextState = next ? "active" : "inactive";
    const seq = (cmdSeqRef.current.get(dev.id) ?? 0) + 1;
    cmdSeqRef.current.set(dev.id, seq);

    setDevices((prev) =>
      prev.map((item) => (item.id === dev.id ? { ...item, state: nextState } : item))
    );
    setPendingIds((prev) => ({ ...prev, [dev.id]: true }));

    try {
      const res = await apiFetch<{ device?: DeviceItem }>(
        `/api/devices/${dev.id}/command`,
        {
          method: "POST",
          body: JSON.stringify({ state: nextState }),
        }
      );
      if (cmdSeqRef.current.get(dev.id) === seq && res.device) {
        setDevices((prev) =>
          prev.map((item) => (item.id === dev.id ? res.device! : item))
        );
      }
    } catch (err) {
      if (cmdSeqRef.current.get(dev.id) === seq) {
        setDevices((prev) =>
          prev.map((item) => (item.id === dev.id ? { ...item, state: prevState } : item))
        );
      }
      toast.error(
        err instanceof ApiError ? err.message : `Failed to toggle "${dev.name}".`
      );
    } finally {
      inFlightIdsRef.current.delete(dev.id);
      setPendingIds((prev) => {
        const copy = { ...prev };
        delete copy[dev.id];
        return copy;
      });
    }
  }, []);

  async function handleConfirmDelete() {
    if (!deleteTarget || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    const target = deleteTarget;
    try {
      await apiFetch(`/api/devices/${target.id}`, { method: "DELETE" });
      setDevices((prev) => prev.filter((item) => item.id !== target.id));
      setModalCtx(null);
      toast.success(`Removed device "${target.name}".`);
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed.");
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  const filteredDevices = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return devices;
    return devices.filter((dev) => {
      const roomName = dev.room_id ? roomById.get(dev.room_id)?.name ?? "" : "";
      const ctrlName = controllerById.get(dev.controller_id)?.name ?? "";
      return `${dev.name} ${dev.device_type} ${roomName} ${ctrlName}`
        .toLowerCase()
        .includes(q);
    });
  }, [devices, search, roomById, controllerById]);

  if (loading && devices.length === 0 && controllers.length === 0) {
    return (
      <div className="py-12 text-center text-xs text-muted-foreground">
        Loading devices...
      </div>
    );
  }

  const effectiveModalCtx: HardwareContext = modalCtx ?? {
    controllers,
    rooms,
    boardsById: new Map(),
  };

  const detailsSubject: HardwareDetailsSubject | null = detailsTarget
    ? { kind: "device", data: detailsTarget }
    : null;

  return (
    <div className="space-y-6">
      <PageHeroHeader
        tone="purple"
        ariaLabel="Devices Header"
        title="Devices"
        subtitle={
          <>
            Control{" "}
            <span className="font-medium text-foreground/85">
              Dimmers, Fans, Smart Locks, &amp; Appliances
            </span>{" "}
            <br className="hidden sm:inline" />
            with{" "}
            <span className="font-semibold text-purple-700 dark:text-purple-400">
              Instant State Sync
            </span>{" "}
            &amp; verified GPIO pin bindings
          </>
        }
        leftIcons={DEVICES_HERO_ICONS.left}
        rightIcons={DEVICES_HERO_ICONS.right}
        searchValue={search}
        onSearchChange={setSearch}
        searchAriaLabel="Search devices"
        searchPlaceholder="Search devices by name, type, room, or controller..."
        actions={
          canManage ? (
            <Button
              size="sm"
              disabled={controllers.length === 0}
              onClick={() => openEditor(null)}
            >
              <RiAddLine className="size-4" aria-hidden="true" />
              Add Device
            </Button>
          ) : undefined
        }
      />

      {filteredDevices.length === 0 ? (
        devices.length > 0 ? (
          <EmptyStatePanel
            icon={<RiLightbulbLine className="size-6" />}
            title="No matching devices"
            description={`No devices match "${search}".`}
            action={
              <Button variant="outline" onClick={() => setSearch("")}>
                Clear Search
              </Button>
            }
          />
        ) : (
          <EmptyStatePanel
            icon={<RiLightbulbLine className="size-6" />}
            title="No devices configured yet"
            description="Add PWM dimmers, fans, smart outlets, locks, or valves linked to verified GPIO output pins."
            action={
              canManage && controllers.length > 0 ? (
                <Button onClick={() => openEditor(null)}>
                  <RiAddLine className="size-4" aria-hidden="true" />
                  Add First Device
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filteredDevices.map((dev) => {
            const ctrl = controllerById.get(dev.controller_id);
            const roomName = dev.room_id
              ? roomById.get(dev.room_id)?.name ?? "Assigned room"
              : "Unassigned";
            const isActive = isDeviceStateActive(dev.state);
            const isPending = Boolean(pendingIds[dev.id]);
            const online = isEntityOnline(dev.is_online, ctrl);
            return (
              <HardwareEntityCard
                key={dev.id}
                name={dev.name}
                typeLabel={dev.device_type.replace(/_/g, " ")}
                roomName={roomName}
                icon={<DeviceTypeIcon type={dev.device_type} />}
                iconToneClass={isActive ? "text-warning" : "text-primary"}
                spotlightTone="purple"
                canManage={canManage}
                onViewDetails={() => setDetailsTarget(dev)}
                onEdit={() => openEditor(dev)}
                onMoveRoom={() => setMoveTarget(dev)}
                onDelete={() => setDeleteTarget(dev)}
              >
                <div className="flex items-center justify-between gap-2 border-t pt-3">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={isActive ? "success-light" : "secondary"}
                      radius="full"
                    >
                      {isActive ? "ON" : "OFF"}
                    </Badge>
                    {!online && (
                      <Badge variant="warning-light" radius="full">
                        Offline
                      </Badge>
                    )}
                    {isPending && (
                      <span className="text-[11px] text-muted-foreground">
                        Syncing...
                      </span>
                    )}
                  </div>
                  <Switch
                    checked={isActive}
                    disabled={!canOperate || isPending}
                    aria-label={`Toggle ${dev.name}`}
                    onCheckedChange={(next) => void handleToggleDevice(dev, next)}
                  />
                </div>
              </HardwareEntityCard>
            );
          })}
        </div>
      )}

      <DeviceEditorModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        deviceItem={editingDevice}
        ctx={effectiveModalCtx}
        onSaved={async () => {
          setModalCtx(null);
          toast.success(editingDevice ? "Device updated." : "Device created.");
          await load(true);
        }}
      />

      {moveTarget && (
        <MoveHardwareRoomModal
          open={Boolean(moveTarget)}
          onOpenChange={(open) => !open && setMoveTarget(null)}
          entityKind="device"
          entityId={moveTarget.id}
          entityName={moveTarget.name}
          currentRoomId={moveTarget.room_id}
          rooms={rooms}
          onMoved={(nextRoomId) => {
            setDevices((prev) =>
              prev.map((item) =>
                item.id === moveTarget.id ? { ...item, room_id: nextRoomId } : item
              )
            );
            toast.success(`Updated room for "${moveTarget.name}".`);
          }}
        />
      )}

      <HardwareDetailsModal
        open={Boolean(detailsTarget)}
        onOpenChange={(open) => !open && setDetailsTarget(null)}
        subject={detailsSubject}
        controller={detailsTarget ? controllerById.get(detailsTarget.controller_id) : undefined}
        room={detailsTarget?.room_id ? roomById.get(detailsTarget.room_id) : undefined}
        timezone={timezone}
        canManage={canManage}
        onEdit={() => {
          if (detailsTarget) openEditor(detailsTarget);
        }}
      />

      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Remove device "${deleteTarget?.name ?? ""}"?`}
        description="This releases its GPIO assignment and stops cloud actuation for this channel."
        confirmLabel="Remove Device"
        busy={deleting}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}

// ============================================================
// SENSORS PAGE
// ============================================================

function SensorTypeIcon({ type }: { type: string }) {
  const lower = type.toLowerCase();
  if (lower.includes("temp") || lower.includes("dht") || lower.includes("ds18") || lower.includes("bme")) {
    return <RiTempColdLine className="size-4" aria-hidden="true" />;
  }
  if (lower.includes("humid")) {
    return <RiDropLine className="size-4" aria-hidden="true" />;
  }
  if (lower.includes("lux") || lower.includes("light") || lower.includes("bh1750")) {
    return <RiSunLine className="size-4" aria-hidden="true" />;
  }
  return <RiSensorLine className="size-4" aria-hidden="true" />;
}

export function SensorsPage({ canManage }: { canManage: boolean }) {
  const timezone = useEffectiveTimezone();
  const cachedSen = getCachedSnapshot<{ sensors: SensorItem[] }>("/api/sensors");
  const cachedCtrls = getCachedSnapshot<{ controllers: ControllerItem[] }>("/api/controllers");
  const cachedRooms = getCachedSnapshot<{ rooms: RoomItem[] }>("/api/homes/rooms");

  const [sensors, setSensors] = useState<SensorItem[]>(() => cachedSen?.sensors ?? []);
  const [controllers, setControllers] = useState<ControllerItem[]>(
    () => cachedCtrls?.controllers ?? []
  );
  const [rooms, setRooms] = useState<RoomItem[]>(() => cachedRooms?.rooms ?? []);
  const [modalCtx, setModalCtx] = useState<HardwareContext | null>(null);
  const [loading, setLoading] = useState(!cachedSen || !cachedCtrls);
  const [search, setSearch] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingSensor, setEditingSensor] = useState<SensorItem | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<SensorItem | null>(null);
  const [moveTarget, setMoveTarget] = useState<SensorItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SensorItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);

  const controllerById = useMemo(
    () => new Map(controllers.map((c) => [c.id, c])),
    [controllers]
  );
  const roomById = useMemo(
    () => new Map(rooms.map((r) => [r.id, r])),
    [rooms]
  );

  const load = useCallback(async (force = false) => {
    if (!getCachedSnapshot("/api/sensors")) {
      setLoading(true);
    }
    try {
      const [sRes, hw] = await Promise.all([
        cachedGet<{ sensors: SensorItem[] }>("/api/sensors", {
          ttlMs: 12_000,
          force,
        }),
        fetchBasicHardwareContext({ force }),
      ]);
      setSensors(sRes.sensors);
      setControllers(hw.controllers);
      setRooms(hw.rooms);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load sensors.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ensureModalContext = useCallback(async () => {
    if (modalCtx) return modalCtx;
    try {
      const full = await fetchHardwareContext(true);
      setModalCtx(full);
      return full;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load board pinout details.");
      return null;
    }
  }, [modalCtx]);

  const openEditor = useCallback(
    (target: SensorItem | null) => {
      setEditingSensor(target);
      setModalOpen(true);
      void ensureModalContext();
    },
    [ensureModalContext]
  );

  async function handleConfirmDelete() {
    if (!deleteTarget || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    const target = deleteTarget;
    try {
      await apiFetch(`/api/sensors/${target.id}`, { method: "DELETE" });
      setSensors((prev) => prev.filter((item) => item.id !== target.id));
      setModalCtx(null);
      toast.success(`Removed sensor "${target.name}".`);
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed.");
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  const filteredSensors = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sensors;
    return sensors.filter((sen) => {
      const roomName = sen.room_id ? roomById.get(sen.room_id)?.name ?? "" : "";
      const ctrlName = controllerById.get(sen.controller_id)?.name ?? "";
      return `${sen.name} ${sen.sensor_type} ${sen.unit} ${roomName} ${ctrlName}`
        .toLowerCase()
        .includes(q);
    });
  }, [sensors, search, roomById, controllerById]);

  if (loading && sensors.length === 0 && controllers.length === 0) {
    return (
      <div className="py-12 text-center text-xs text-muted-foreground">
        Loading sensors...
      </div>
    );
  }

  const effectiveModalCtx: HardwareContext = modalCtx ?? {
    controllers,
    rooms,
    boardsById: new Map(),
  };

  const detailsSubject: HardwareDetailsSubject | null = detailsTarget
    ? { kind: "sensor", data: detailsTarget }
    : null;

  return (
    <div className="space-y-6">
      <PageHeroHeader
        tone="green"
        ariaLabel="Sensors Header"
        title="Sensors"
        subtitle={
          <>
            Monitor live{" "}
            <span className="font-medium text-foreground/85">
              Temperature, Humidity, Light, Motion, &amp; Contact Telemetry
            </span>{" "}
            <br className="hidden sm:inline" />
            across rooms with{" "}
            <span className="font-semibold text-emerald-700 dark:text-emerald-400">
              Firmware-Verified Drivers
            </span>
          </>
        }
        leftIcons={SENSORS_HERO_ICONS.left}
        rightIcons={SENSORS_HERO_ICONS.right}
        searchValue={search}
        onSearchChange={setSearch}
        searchAriaLabel="Search sensors"
        searchPlaceholder="Search sensors by name, driver type, room, or unit..."
        actions={
          canManage ? (
            <Button
              size="sm"
              disabled={controllers.length === 0}
              onClick={() => openEditor(null)}
            >
              <RiAddLine className="size-4" aria-hidden="true" />
              Add Sensor
            </Button>
          ) : undefined
        }
      />

      {filteredSensors.length === 0 ? (
        sensors.length > 0 ? (
          <EmptyStatePanel
            icon={<RiSensorLine className="size-6" />}
            title="No matching sensors"
            description={`No sensors match "${search}".`}
            action={
              <Button variant="outline" onClick={() => setSearch("")}>
                Clear Search
              </Button>
            }
          />
        ) : (
          <EmptyStatePanel
            icon={<RiSensorLine className="size-6" />}
            title="No sensors configured yet"
            description="Attach temperature, humidity, barometric, light, motion, or contact sensors using verified firmware drivers."
            action={
              canManage && controllers.length > 0 ? (
                <Button onClick={() => openEditor(null)}>
                  <RiAddLine className="size-4" aria-hidden="true" />
                  Add First Sensor
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filteredSensors.map((sen) => {
            const ctrl = controllerById.get(sen.controller_id);
            const roomName = sen.room_id
              ? roomById.get(sen.room_id)?.name ?? "Assigned room"
              : "Unassigned";
            const online = isEntityOnline(sen.is_online, ctrl);
            return (
              <HardwareEntityCard
                key={sen.id}
                name={sen.name}
                typeLabel={sen.sensor_type}
                roomName={roomName}
                icon={<SensorTypeIcon type={sen.sensor_type} />}
                iconToneClass={online ? "text-success" : "text-muted-foreground"}
                spotlightTone="green"
                canManage={canManage}
                onViewDetails={() => setDetailsTarget(sen)}
                onEdit={() => openEditor(sen)}
                onMoveRoom={() => setMoveTarget(sen)}
                onDelete={() => setDeleteTarget(sen)}
              >
                <div className="flex items-center justify-between gap-2 border-t pt-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold tabular-nums text-foreground">
                      {sen.last_value !== null
                        ? `${sen.last_value} ${sen.unit}`
                        : "No reading"}
                    </p>
                    {sen.last_reading_at && (
                      <p className="truncate text-[11px] text-muted-foreground">
                        {formatTimestamp(sen.last_reading_at, timezone)}
                      </p>
                    )}
                  </div>
                  <Badge
                    variant={online ? "success-light" : "warning-light"}
                    radius="full"
                  >
                    {online ? "Online" : "Offline"}
                  </Badge>
                </div>
              </HardwareEntityCard>
            );
          })}
        </div>
      )}

      <SensorEditorModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        sensorItem={editingSensor}
        ctx={effectiveModalCtx}
        onSaved={async () => {
          setModalCtx(null);
          toast.success(editingSensor ? "Sensor updated." : "Sensor created.");
          await load(true);
        }}
      />

      {moveTarget && (
        <MoveHardwareRoomModal
          open={Boolean(moveTarget)}
          onOpenChange={(open) => !open && setMoveTarget(null)}
          entityKind="sensor"
          entityId={moveTarget.id}
          entityName={moveTarget.name}
          currentRoomId={moveTarget.room_id}
          rooms={rooms}
          onMoved={(nextRoomId) => {
            setSensors((prev) =>
              prev.map((item) =>
                item.id === moveTarget.id ? { ...item, room_id: nextRoomId } : item
              )
            );
            toast.success(`Updated room for "${moveTarget.name}".`);
          }}
        />
      )}

      <HardwareDetailsModal
        open={Boolean(detailsTarget)}
        onOpenChange={(open) => !open && setDetailsTarget(null)}
        subject={detailsSubject}
        controller={detailsTarget ? controllerById.get(detailsTarget.controller_id) : undefined}
        room={detailsTarget?.room_id ? roomById.get(detailsTarget.room_id) : undefined}
        timezone={timezone}
        canManage={canManage}
        onEdit={() => {
          if (detailsTarget) openEditor(detailsTarget);
        }}
      />

      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Remove sensor "${deleteTarget?.name ?? ""}"?`}
        description="This stops storing telemetry for this sensor and frees its GPIO pin."
        confirmLabel="Remove Sensor"
        busy={deleting}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
