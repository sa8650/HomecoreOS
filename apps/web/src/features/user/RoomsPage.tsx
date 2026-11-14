import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiAddLine,
  RiDeleteBinLine,
  RiDoorOpenLine,
  RiEditLine,
} from "@remixicon/react";
import { ROOM_TYPE_LABELS } from "@homecoreos/shared";
import { toast } from "sonner";
import { apiFetch, ApiError, cachedGet, getCachedSnapshot } from "@/lib/api";
import { RoomEditorModal } from "@/components/floorplan/RoomEditorModal";
import { Badge } from "@/components/reui/badge";
import { IconTile } from "@/components/reui/icon-tile";
import {
  ConfirmDeleteDialog,
  EmptyStatePanel,
} from "@/components/shared/AppUi";
import { ROOMS_HERO_ICONS } from "@/components/shared/HeroDomainIcons";
import { PageHeroHeader } from "@/components/shared/PageHeroHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MagicCard } from "@/components/ui/magic-card";
import type { HomeItem, RoomItem } from "@/features/types";

export function RoomsPage({ canManage }: { canManage: boolean }) {
  const cachedHomes = getCachedSnapshot<{ homes: HomeItem[] }>("/api/homes");
  const cachedRooms = getCachedSnapshot<{ rooms: RoomItem[] }>("/api/homes/rooms");

  const [homes, setHomes] = useState<HomeItem[]>(() => cachedHomes?.homes ?? []);
  const [rooms, setRooms] = useState<RoomItem[]>(() => cachedRooms?.rooms ?? []);
  const [loading, setLoading] = useState(!cachedRooms);
  const [search, setSearch] = useState("");

  const [selectedHomeId, setSelectedHomeId] = useState(() => cachedHomes?.homes[0]?.id ?? "");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState<RoomItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RoomItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);

  const loadAll = useCallback(async (force = false) => {
    if (!getCachedSnapshot("/api/homes/rooms")) {
      setLoading(true);
    }
    try {
      const [hRes, rRes] = await Promise.all([
        cachedGet<{ homes: HomeItem[] }>("/api/homes", { ttlMs: 60_000, force }),
        cachedGet<{ rooms: RoomItem[] }>("/api/homes/rooms", { ttlMs: 20_000, force }),
      ]);
      setHomes(hRes.homes);
      setRooms(rRes.rooms);
      setSelectedHomeId((prev) => prev || hRes.homes[0]?.id || "");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load rooms.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function handleConfirmDelete() {
    if (!deleteTarget || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      await apiFetch(`/api/homes/rooms/${deleteTarget.id}`, { method: "DELETE" });
      toast.success(`Removed "${deleteTarget.name}" from floor plan.`);
      setDeleteTarget(null);
      await loadAll(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete room.");
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  const filteredRooms = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter((room) => {
      const typeLabel = ROOM_TYPE_LABELS[room.room_type ?? "living_room"] ?? "Room";
      const homeName = homes.find((h) => h.id === room.home_id)?.name ?? "";
      return `${room.name} ${typeLabel} ${homeName}`.toLowerCase().includes(q);
    });
  }, [rooms, homes, search]);

  if (loading && rooms.length === 0) {
    return (
      <div className="py-12 text-center text-xs text-muted-foreground">
        Loading rooms...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeroHeader
        tone="teal"
        ariaLabel="Rooms Header"
        title="Rooms"
        subtitle={
          <>
            Define{" "}
            <span className="font-medium text-foreground/85">
              Rooms, Architectural Layouts, Doors, &amp; Flooring
            </span>{" "}
            <br className="hidden sm:inline" />
            synced live with your{" "}
            <span className="font-semibold text-teal-700 dark:text-teal-400">
              Interactive 2D Home Floor Plan
            </span>
          </>
        }
        leftIcons={ROOMS_HERO_ICONS.left}
        rightIcons={ROOMS_HERO_ICONS.right}
        searchValue={search}
        onSearchChange={setSearch}
        searchAriaLabel="Search rooms"
        searchPlaceholder="Search rooms by name, room type, or home..."
        actions={
          canManage && selectedHomeId ? (
            <Button
              size="sm"
              onClick={() => {
                setEditingRoom(null);
                setEditorOpen(true);
              }}
            >
              <RiAddLine className="size-4" aria-hidden="true" />
              Add Room
            </Button>
          ) : undefined
        }
      />

      {filteredRooms.length === 0 ? (
        rooms.length > 0 ? (
          <EmptyStatePanel
            icon={<RiDoorOpenLine className="size-6" />}
            title="No matching rooms"
            description={`No rooms match "${search}".`}
            action={
              <Button variant="outline" onClick={() => setSearch("")}>
                Clear Search
              </Button>
            }
          />
        ) : (
          <EmptyStatePanel
            icon={<RiDoorOpenLine className="size-6" />}
            title="No rooms created yet"
            description="Create your first room with custom flooring, dimensions, doors, and windows for the 2D floor plan."
            action={
              canManage && selectedHomeId ? (
                <Button
                  onClick={() => {
                    setEditingRoom(null);
                    setEditorOpen(true);
                  }}
                >
                  <RiAddLine className="size-4" aria-hidden="true" />
                  Add First Room
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <div
          data-testid="rooms-card-grid"
          className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
        >
          {filteredRooms.map((room) => {
            const home = homes.find((h) => h.id === room.home_id);
            const typeLabel = ROOM_TYPE_LABELS[room.room_type ?? "living_room"] ?? "Room";
            return (
              <Card
                key={room.id}
                className="h-full border-none p-0 shadow-none ring-0 transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md"
              >
                <MagicCard
                  mode="orb"
                  spotlightTone="teal"
                  className="h-full rounded-xl p-0"
                  contentClassName="flex h-full flex-col justify-between gap-3 py-4"
                >
                  <CardContent className="flex h-full flex-col justify-between gap-3">
                    <div className="flex items-start gap-2.5">
                      <IconTile variant="soft" size="default" className="shrink-0 text-primary">
                        <RiDoorOpenLine className="size-4" aria-hidden="true" />
                      </IconTile>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate text-sm font-semibold text-foreground">
                            {room.name}
                          </h3>
                          <Badge variant="secondary">{typeLabel}</Badge>
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {home?.name ?? "Primary Home"} ·{" "}
                          <span className="font-mono">
                            {room.floor_w ?? 320}×{room.floor_h ?? 240}px
                          </span>{" "}
                          at ({room.floor_x ?? 0}, {room.floor_y ?? 0})
                        </p>
                      </div>
                    </div>

                    {canManage && (
                      <div className="flex flex-wrap items-center justify-end gap-1.5 border-t pt-2.5">
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => {
                            setEditingRoom(room);
                            setEditorOpen(true);
                          }}
                        >
                          <RiEditLine className="size-3.5" aria-hidden="true" />
                          Edit Layout
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setDeleteTarget(room)}
                        >
                          <RiDeleteBinLine className="size-3.5" aria-hidden="true" />
                          Remove
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </MagicCard>
              </Card>
            );
          })}
        </div>
      )}

      <RoomEditorModal
        open={editorOpen}
        room={editingRoom}
        homeId={selectedHomeId}
        onClose={() => setEditorOpen(false)}
        onSaved={async () => {
          toast.success(editingRoom ? "Room updated." : "Room created.");
          await loadAll(true);
        }}
      />

      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Remove "${deleteTarget?.name ?? ""}"?`}
        description="Assigned switches, devices, and sensors will remain on their controller as unassigned until moved to another room."
        confirmLabel="Remove Room"
        busy={deleting}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
