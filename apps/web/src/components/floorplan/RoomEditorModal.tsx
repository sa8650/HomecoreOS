import { useEffect, useRef, useState } from "react";
import {
  ROOM_TYPES,
  ROOM_TYPE_LABELS,
  type FloorDoor,
  type FloorStyle,
  type FloorWindow,
  type RoomType,
  type WallSide,
} from "@homecoreos/shared";
import { RiAddLine, RiDeleteBinLine } from "@remixicon/react";
import { apiFetch, ApiError } from "@/lib/api";
import { FormField, StatusAlert } from "@/components/shared/AppUi";
import { Frame, FramePanel } from "@/components/reui/frame";
import { Button } from "@/components/ui/button";
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
import type { RoomItem } from "@/features/types";

const WALLS: WallSide[] = ["top", "right", "bottom", "left"];

export function RoomEditorModal({
  open,
  room,
  homeId,
  onClose,
  onSaved,
}: {
  open: boolean;
  room: RoomItem | null;
  homeId: string;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const isEditing = Boolean(room);

  const [name, setName] = useState("");
  const [roomType, setRoomType] = useState<RoomType>("living_room");
  const [floorStyle, setFloorStyle] = useState<FloorStyle>("wood");
  const [floorX, setFloorX] = useState(0);
  const [floorY, setFloorY] = useState(0);
  const [floorW, setFloorW] = useState(340);
  const [floorH, setFloorH] = useState(260);
  const [doors, setDoors] = useState<FloorDoor[]>([]);
  const [windows, setWindows] = useState<FloorWindow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (room) {
      setName(room.name);
      setRoomType(room.room_type ?? "living_room");
      setFloorStyle(room.layout_config?.floorStyle ?? "wood");
      setFloorX(room.floor_x ?? 0);
      setFloorY(room.floor_y ?? 0);
      setFloorW(room.floor_w ?? 320);
      setFloorH(room.floor_h ?? 240);
      setDoors(room.layout_config?.doors ?? []);
      setWindows(room.layout_config?.windows ?? []);
    } else {
      setName("");
      setRoomType("living_room");
      setFloorStyle("wood");
      setFloorX(0);
      setFloorY(0);
      setFloorW(340);
      setFloorH(260);
      setDoors([{ id: "d1", wall: "bottom", offset: 0.5, width: 48 }]);
      setWindows([{ id: "w1", wall: "top", offset: 0.5, width: 76 }]);
    }
  }, [open, room]);

  async function handleSubmit() {
    if (savingRef.current) return;
    if (!name.trim()) {
      setError("Room name is required.");
      return;
    }
    const parsedX = Number.isFinite(Number(floorX))
      ? Math.max(-2000, Math.min(4000, Math.round(Number(floorX))))
      : 0;
    const parsedY = Number.isFinite(Number(floorY))
      ? Math.max(-2000, Math.min(4000, Math.round(Number(floorY))))
      : 0;
    const parsedW = Number.isFinite(Number(floorW))
      ? Math.max(120, Math.min(1200, Math.round(Number(floorW))))
      : 340;
    const parsedH = Number.isFinite(Number(floorH))
      ? Math.max(120, Math.min(1200, Math.round(Number(floorH))))
      : 260;

    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const payload = isEditing
        ? {
            name: name.trim(),
            roomType,
            floorX: parsedX,
            floorY: parsedY,
            floorW: parsedW,
            floorH: parsedH,
            layoutConfig: {
              floorStyle,
              doors,
              windows,
            },
          }
        : {
            homeId,
            name: name.trim(),
            roomType,
            floorW: parsedW,
            floorH: parsedH,
            layoutConfig: {
              floorStyle,
              doors,
              windows,
            },
          };

      const url = isEditing ? `/api/homes/rooms/${room!.id}` : "/api/homes/rooms";
      const method = isEditing ? "PATCH" : "POST";
      await apiFetch(url, {
        method,
        body: JSON.stringify(payload),
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save room layout.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? `Edit Room: ${room?.name}` : "Add Room to Floor Plan"}
          </DialogTitle>
          <DialogDescription>
            Configure room architecture, floor material, position, and openings.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {error && <StatusAlert tone="danger">{error}</StatusAlert>}

          <div className="grid gap-3 sm:grid-cols-3">
            <FormField id="room-name" label="Room name">
              <Input
                id="room-name"
                placeholder="e.g. Living Room"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </FormField>

            <FormField id="room-type" label="Room type (furniture)">
              <Select
                value={roomType}
                onValueChange={(val) => {
                  const next = val as RoomType;
                  setRoomType(next);
                  if (next === "bathroom" || next === "toilet" || next === "hallway") {
                    setFloorStyle("tile");
                  } else if (next === "patio" || next === "garage") {
                    setFloorStyle("stone");
                  } else {
                    setFloorStyle("wood");
                  }
                }}
              >
                <SelectTrigger id="room-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROOM_TYPES.map((rt) => (
                    <SelectItem key={rt} value={rt}>
                      {ROOM_TYPE_LABELS[rt]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField id="room-floor" label="Flooring finish">
              <Select
                value={floorStyle}
                onValueChange={(val) => setFloorStyle(val as FloorStyle)}
              >
                <SelectTrigger id="room-floor" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="wood">Warm Wood Planks</SelectItem>
                  <SelectItem value="tile">Ceramic Tile</SelectItem>
                  <SelectItem value="stone">Architectural Stone</SelectItem>
                  <SelectItem value="carpet">Woven Carpet</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            {isEditing && (
              <>
                <FormField id="room-x" label="X Position (px)">
                  <Input
                    id="room-x"
                    type="number"
                    step={20}
                    value={floorX}
                    onChange={(e) => setFloorX(Number(e.target.value))}
                  />
                </FormField>
                <FormField id="room-y" label="Y Position (px)">
                  <Input
                    id="room-y"
                    type="number"
                    step={20}
                    value={floorY}
                    onChange={(e) => setFloorY(Number(e.target.value))}
                  />
                </FormField>
              </>
            )}
            <FormField id="room-w" label="Width (px)">
              <Input
                id="room-w"
                type="number"
                min={140}
                max={900}
                step={20}
                value={floorW}
                onChange={(e) => setFloorW(Number(e.target.value))}
              />
            </FormField>
            <FormField id="room-h" label="Height (px)">
              <Input
                id="room-h"
                type="number"
                min={140}
                max={700}
                step={20}
                value={floorH}
                onChange={(e) => setFloorH(Number(e.target.value))}
              />
            </FormField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Frame spacing="sm">
              <FramePanel className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-foreground">
                    Doors ({doors.length})
                  </p>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      setDoors((prev) => [
                        ...prev,
                        {
                          id: `d-${crypto.randomUUID?.() ?? `${Date.now()}-${prev.length}`}`,
                          wall: "bottom",
                          offset: 0.5,
                          width: 48,
                        },
                      ])
                    }
                  >
                    <RiAddLine className="size-3.5" aria-hidden="true" />
                    Door
                  </Button>
                </div>
                <div className="space-y-2">
                  {doors.length === 0 && (
                    <p className="text-[11px] text-muted-foreground">No doors configured.</p>
                  )}
                  {doors.map((d, idx) => (
                    <div key={d.id} className="flex items-center gap-2">
                      <Select
                        value={d.wall}
                        onValueChange={(val) => {
                          const wall = val as WallSide;
                          setDoors((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, wall } : item))
                          );
                        }}
                      >
                        <SelectTrigger aria-label="Door wall" size="sm" className="w-28 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WALLS.map((w) => (
                            <SelectItem key={w} value={w}>
                              {w} wall
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <input
                        type="range"
                        aria-label="Door offset"
                        min={0.15}
                        max={0.85}
                        step={0.05}
                        value={d.offset}
                        onChange={(e) => {
                          const offset = Number(e.target.value);
                          setDoors((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, offset } : item))
                          );
                        }}
                        className="flex-1 accent-primary"
                      />
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Remove door"
                        onClick={() => setDoors((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        <RiDeleteBinLine className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </FramePanel>
            </Frame>

            <Frame spacing="sm">
              <FramePanel className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-foreground">
                    Windows ({windows.length})
                  </p>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      setWindows((prev) => [
                        ...prev,
                        {
                          id: `w-${crypto.randomUUID?.() ?? `${Date.now()}-${prev.length}`}`,
                          wall: "top",
                          offset: 0.5,
                          width: 76,
                        },
                      ])
                    }
                  >
                    <RiAddLine className="size-3.5" aria-hidden="true" />
                    Window
                  </Button>
                </div>
                <div className="space-y-2">
                  {windows.length === 0 && (
                    <p className="text-[11px] text-muted-foreground">No windows configured.</p>
                  )}
                  {windows.map((win, idx) => (
                    <div key={win.id} className="flex items-center gap-2">
                      <Select
                        value={win.wall}
                        onValueChange={(val) => {
                          const wall = val as WallSide;
                          setWindows((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, wall } : item))
                          );
                        }}
                      >
                        <SelectTrigger aria-label="Window wall" size="sm" className="w-28 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WALLS.map((w) => (
                            <SelectItem key={w} value={w}>
                              {w} wall
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <input
                        type="range"
                        aria-label="Window offset"
                        min={0.15}
                        max={0.85}
                        step={0.05}
                        value={win.offset}
                        onChange={(e) => {
                          const offset = Number(e.target.value);
                          setWindows((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, offset } : item))
                          );
                        }}
                        className="flex-1 accent-primary"
                      />
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Remove window"
                        onClick={() => setWindows((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        <RiDeleteBinLine className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </FramePanel>
            </Frame>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={saving}>
            {saving ? "Saving..." : isEditing ? "Save Room Layout" : "Create Room"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
