import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  SUPPORTED_DEVICE_TYPES,
  SUPPORTED_SENSOR_TYPES,
} from "@homecoreos/shared";
import { apiFetch, ApiError } from "@/lib/api";
import {
  getPinHint,
  getRequirementForDeviceType,
  getRequirementForSensorType,
  type HardwareContext,
} from "@/lib/board-pin-helpers";
import { formatTimestamp } from "@/lib/timezone";
import { Badge } from "@/components/reui/badge";
import { FormField, StatusAlert } from "@/components/shared/AppUi";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type {
  ControllerItem,
  DeviceItem,
  RoomItem,
  SensorItem,
  SwitchItem,
} from "@/features/types";

const ROOM_NONE = "__none__";

export function SwitchEditorModal({
  open,
  onOpenChange,
  switchItem,
  ctx,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  switchItem: SwitchItem | null;
  ctx: HardwareContext;
  onSaved: () => Promise<void> | void;
}) {
  const isEditing = Boolean(switchItem);
  const [name, setName] = useState("");
  const [controllerId, setControllerId] = useState("");
  const [roomId, setRoomId] = useState(ROOM_NONE);
  const [gpioPin, setGpioPin] = useState(4);
  const [invertedLogic, setInvertedLogic] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const initializedOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      initializedOpenRef.current = false;
      return;
    }
    if (!initializedOpenRef.current) {
      initializedOpenRef.current = true;
      setError(null);
      if (switchItem) {
        setName(switchItem.name);
        setControllerId(switchItem.controller_id);
        setRoomId(switchItem.room_id ?? ROOM_NONE);
        setGpioPin(switchItem.gpio_pin);
        setInvertedLogic(Boolean(switchItem.inverted));
      } else {
        setName("");
        setControllerId(ctx.controllers[0]?.id ?? "");
        setRoomId(ROOM_NONE);
        setGpioPin(4);
        setInvertedLogic(false);
      }
    } else if (!switchItem && !controllerId && ctx.controllers[0]?.id) {
      setControllerId(ctx.controllers[0].id);
    }
  }, [open, switchItem, controllerId, ctx.controllers]);

  const selectedCtrl = ctx.controllers.find((c) => c.id === controllerId);
  const pinHint = getPinHint({
    controller: selectedCtrl,
    boardsById: ctx.boardsById,
    pinNum: gpioPin,
    requirement: "digital_out",
    usedPinsByController: ctx.usedPinsByController,
    excludeEntity: switchItem
      ? { kind: "switch", id: switchItem.id }
      : undefined,
  });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    if (!name.trim()) {
      setError("Switch name is required.");
      return;
    }
    if (!controllerId) {
      setError("Select a controller.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        controllerId,
        roomId: roomId === ROOM_NONE ? null : roomId,
        gpioPin: Number(gpioPin),
        invertedLogic,
      };
      if (isEditing && switchItem) {
        await apiFetch(`/api/switches/${switchItem.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch("/api/switches", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      await onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to save switch."
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? `Edit Switch: ${switchItem?.name}` : "Add Switch"}
          </DialogTitle>
          <DialogDescription>
            Bind a relay or lighting channel with real-time board GPIO validation.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <StatusAlert tone="danger">{error}</StatusAlert>}
          <FormField id="sw-name" label="Switch Name">
            <Input
              id="sw-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ceiling Lights"
            />
          </FormField>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField id="sw-ctrl" label="Controller">
              <Select value={controllerId} onValueChange={setControllerId}>
                <SelectTrigger id="sw-ctrl" className="w-full">
                  <SelectValue placeholder="Select controller..." />
                </SelectTrigger>
                <SelectContent>
                  {ctx.controllers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField id="sw-room" label="Room (Optional)">
              <Select value={roomId} onValueChange={setRoomId}>
                <SelectTrigger id="sw-room" className="w-full">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROOM_NONE}>Unassigned</SelectItem>
                  {ctx.rooms.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField
            id="sw-gpio"
            label="GPIO Pin"
            error={pinHint.blocked ? pinHint.reason : undefined}
            hint={!pinHint.blocked ? pinHint.reason : undefined}
          >
            <Input
              id="sw-gpio"
              type="number"
              min={0}
              max={54}
              value={gpioPin}
              aria-invalid={pinHint.blocked}
              onChange={(e) => setGpioPin(Number(e.target.value))}
            />
          </FormField>

          <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2.5">
            <Label htmlFor="sw-inv" className="text-xs font-medium cursor-pointer">
              Active-LOW / Inverted relay logic
            </Label>
            <Switch
              id="sw-inv"
              checked={invertedLogic}
              onCheckedChange={setInvertedLogic}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || !controllerId || pinHint.blocked}
            >
              {saving
                ? "Saving..."
                : isEditing
                  ? "Save Switch"
                  : "Create Switch"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeviceEditorModal({
  open,
  onOpenChange,
  deviceItem,
  ctx,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceItem: DeviceItem | null;
  ctx: HardwareContext;
  onSaved: () => Promise<void> | void;
}) {
  const isEditing = Boolean(deviceItem);
  const [name, setName] = useState("");
  const [deviceType, setDeviceType] = useState<string>(
    SUPPORTED_DEVICE_TYPES[0]
  );
  const [controllerId, setControllerId] = useState("");
  const [roomId, setRoomId] = useState(ROOM_NONE);
  const [gpioPin, setGpioPin] = useState(6);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const initializedOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      initializedOpenRef.current = false;
      return;
    }
    if (!initializedOpenRef.current) {
      initializedOpenRef.current = true;
      setError(null);
      if (deviceItem) {
        setName(deviceItem.name);
        setDeviceType(deviceItem.device_type);
        setControllerId(deviceItem.controller_id);
        setRoomId(deviceItem.room_id ?? ROOM_NONE);
        setGpioPin(deviceItem.gpio_pin);
      } else {
        setName("");
        setDeviceType(SUPPORTED_DEVICE_TYPES[0]);
        setControllerId(ctx.controllers[0]?.id ?? "");
        setRoomId(ROOM_NONE);
        setGpioPin(6);
      }
    } else if (!deviceItem && !controllerId && ctx.controllers[0]?.id) {
      setControllerId(ctx.controllers[0].id);
    }
  }, [open, deviceItem, controllerId, ctx.controllers]);

  const selectedCtrl = ctx.controllers.find((c) => c.id === controllerId);
  const pinHint = getPinHint({
    controller: selectedCtrl,
    boardsById: ctx.boardsById,
    pinNum: gpioPin,
    requirement: getRequirementForDeviceType(deviceType),
    usedPinsByController: ctx.usedPinsByController,
    excludeEntity: deviceItem
      ? { kind: "device", id: deviceItem.id }
      : undefined,
  });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    if (!name.trim()) {
      setError("Device name is required.");
      return;
    }
    if (!controllerId) {
      setError("Select a controller.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        deviceType,
        controllerId,
        roomId: roomId === ROOM_NONE ? null : roomId,
        gpioPin: Number(gpioPin),
      };
      if (isEditing && deviceItem) {
        await apiFetch(`/api/devices/${deviceItem.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch("/api/devices", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      await onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to save device."
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? `Edit Device: ${deviceItem?.name}` : "Add Device"}
          </DialogTitle>
          <DialogDescription>
            Configure actuator type, GPIO capability, controller, and room placement.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <StatusAlert tone="danger">{error}</StatusAlert>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField id="dev-name" label="Device Name">
              <Input
                id="dev-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ceiling Fan"
              />
            </FormField>
            <FormField id="dev-type" label="Device Type">
              <Select value={deviceType} onValueChange={setDeviceType}>
                <SelectTrigger id="dev-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_DEVICE_TYPES.map((dt) => (
                    <SelectItem key={dt} value={dt}>
                      {dt.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField id="dev-ctrl" label="Controller">
              <Select value={controllerId} onValueChange={setControllerId}>
                <SelectTrigger id="dev-ctrl" className="w-full">
                  <SelectValue placeholder="Select controller..." />
                </SelectTrigger>
                <SelectContent>
                  {ctx.controllers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField id="dev-room" label="Room (Optional)">
              <Select value={roomId} onValueChange={setRoomId}>
                <SelectTrigger id="dev-room" className="w-full">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROOM_NONE}>Unassigned</SelectItem>
                  {ctx.rooms.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField
            id="dev-gpio"
            label="GPIO Pin"
            error={pinHint.blocked ? pinHint.reason : undefined}
            hint={!pinHint.blocked ? pinHint.reason : undefined}
          >
            <Input
              id="dev-gpio"
              type="number"
              min={0}
              max={54}
              value={gpioPin}
              aria-invalid={pinHint.blocked}
              onChange={(e) => setGpioPin(Number(e.target.value))}
            />
          </FormField>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || !controllerId || pinHint.blocked}
            >
              {saving
                ? "Saving..."
                : isEditing
                  ? "Save Device"
                  : "Add Device"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SensorEditorModal({
  open,
  onOpenChange,
  sensorItem,
  ctx,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sensorItem: SensorItem | null;
  ctx: HardwareContext;
  onSaved: () => Promise<void> | void;
}) {
  const isEditing = Boolean(sensorItem);
  const [name, setName] = useState("");
  const [sensorType, setSensorType] = useState<string>(
    SUPPORTED_SENSOR_TYPES[0]
  );
  const [controllerId, setControllerId] = useState("");
  const [roomId, setRoomId] = useState(ROOM_NONE);
  const [gpioPin, setGpioPin] = useState<string>("5");
  const [i2cAddress, setI2cAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const initializedOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      initializedOpenRef.current = false;
      return;
    }
    if (!initializedOpenRef.current) {
      initializedOpenRef.current = true;
      setError(null);
      if (sensorItem) {
        setName(sensorItem.name);
        setSensorType(sensorItem.sensor_type);
        setControllerId(sensorItem.controller_id);
        setRoomId(sensorItem.room_id ?? ROOM_NONE);
        setGpioPin(sensorItem.gpio_pin !== null ? String(sensorItem.gpio_pin) : "");
        setI2cAddress(sensorItem.i2c_address ?? "");
      } else {
        setName("");
        setSensorType(SUPPORTED_SENSOR_TYPES[0]);
        setControllerId(ctx.controllers[0]?.id ?? "");
        setRoomId(ROOM_NONE);
        setGpioPin("5");
        setI2cAddress("");
      }
    } else if (!sensorItem && !controllerId && ctx.controllers[0]?.id) {
      setControllerId(ctx.controllers[0].id);
    }
  }, [open, sensorItem, controllerId, ctx.controllers]);

  const requirement = getRequirementForSensorType(sensorType);
  const isI2c = requirement === "i2c";
  const parsedPin =
    gpioPin.trim() === ""
      ? null
      : Number.isInteger(Number(gpioPin))
        ? Number(gpioPin)
        : Number.NaN;
  const selectedCtrl = ctx.controllers.find((c) => c.id === controllerId);
  const pinHint = getPinHint({
    controller: selectedCtrl,
    boardsById: ctx.boardsById,
    pinNum: Number.isFinite(parsedPin) ? parsedPin : null,
    requirement,
    usedPinsByController: ctx.usedPinsByController,
    excludeEntity: sensorItem
      ? { kind: "sensor", id: sensorItem.id }
      : undefined,
  });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    if (!name.trim()) {
      setError("Sensor name is required.");
      return;
    }
    if (!controllerId) {
      setError("Select a controller.");
      return;
    }
    if (gpioPin.trim() !== "" && !Number.isInteger(parsedPin)) {
      setError("Enter a valid whole-number GPIO pin (0-54).");
      return;
    }
    if (!isI2c && (parsedPin === null || !Number.isInteger(parsedPin))) {
      setError("Enter a valid GPIO pin for this sensor driver.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        sensorType,
        controllerId,
        roomId: roomId === ROOM_NONE ? null : roomId,
        gpioPin: parsedPin,
        i2cAddress: i2cAddress.trim() || null,
      };
      if (isEditing && sensorItem) {
        await apiFetch(`/api/sensors/${sensorItem.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch("/api/sensors", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      await onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to save sensor."
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? `Edit Sensor: ${sensorItem?.name}` : "Add Supported Sensor"}
          </DialogTitle>
          <DialogDescription>
            Select a firmware-verified ESP-IDF sensor driver and validate GPIO / I2C pin mapping.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <StatusAlert tone="danger">{error}</StatusAlert>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField id="sen-name" label="Sensor Name">
              <Input
                id="sen-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ambient Temperature"
              />
            </FormField>
            <FormField id="sen-type" label="Firmware Driver">
              <Select value={sensorType} onValueChange={setSensorType}>
                <SelectTrigger id="sen-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_SENSOR_TYPES.map((st) => (
                    <SelectItem key={st} value={st}>
                      {st}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField id="sen-ctrl" label="Controller">
              <Select value={controllerId} onValueChange={setControllerId}>
                <SelectTrigger id="sen-ctrl" className="w-full">
                  <SelectValue placeholder="Select controller..." />
                </SelectTrigger>
                <SelectContent>
                  {ctx.controllers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField id="sen-room" label="Room (Optional)">
              <Select value={roomId} onValueChange={setRoomId}>
                <SelectTrigger id="sen-room" className="w-full">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROOM_NONE}>Unassigned</SelectItem>
                  {ctx.rooms.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField
              id="sen-gpio"
              label={isI2c ? "I2C SDA GPIO (Optional)" : "GPIO Pin"}
              error={pinHint.blocked ? pinHint.reason : undefined}
              hint={!pinHint.blocked ? pinHint.reason : undefined}
            >
              <Input
                id="sen-gpio"
                type="number"
                min={0}
                max={54}
                value={gpioPin}
                aria-invalid={pinHint.blocked}
                onChange={(e) => setGpioPin(e.target.value)}
                placeholder={isI2c ? "e.g. 8 or leave empty" : "5"}
              />
            </FormField>
            {isI2c && (
              <FormField id="sen-i2c" label="I2C Address (Optional)">
                <Input
                  id="sen-i2c"
                  value={i2cAddress}
                  onChange={(e) => setI2cAddress(e.target.value)}
                  placeholder="0x76 or 0x23"
                />
              </FormField>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || !controllerId || pinHint.blocked}
            >
              {saving
                ? "Saving..."
                : isEditing
                  ? "Save Sensor"
                  : "Add Sensor"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MoveHardwareRoomModal({
  open,
  onOpenChange,
  entityKind,
  entityId,
  entityName,
  currentRoomId,
  rooms,
  onMoved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityKind: "switch" | "device" | "sensor";
  entityId: string;
  entityName: string;
  currentRoomId: string | null;
  rooms: RoomItem[];
  onMoved: (nextRoomId: string | null) => void;
}) {
  const [selectedRoom, setSelectedRoom] = useState<string>(
    currentRoomId ?? ROOM_NONE
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    if (open) {
      setSelectedRoom(currentRoomId ?? ROOM_NONE);
      setError(null);
    }
  }, [open, currentRoomId, entityId]);

  const initialKey = currentRoomId ?? ROOM_NONE;
  const unchanged = selectedRoom === initialKey;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (savingRef.current || unchanged) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);

    const targetRoomId = selectedRoom === ROOM_NONE ? null : selectedRoom;
    const base =
      entityKind === "switch"
        ? "/api/switches"
        : entityKind === "device"
          ? "/api/devices"
          : "/api/sensors";

    try {
      await apiFetch(`${base}/${entityId}`, {
        method: "PATCH",
        body: JSON.stringify({ roomId: targetRoomId }),
      });
      onMoved(targetRoomId);
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to move to another room."
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move "{entityName}"</DialogTitle>
          <DialogDescription>
            Choose the room where this {entityKind} is physically installed.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <StatusAlert tone="danger">{error}</StatusAlert>}
          <FormField id="move-room-select" label="Destination Room">
            <Select value={selectedRoom} onValueChange={setSelectedRoom}>
              <SelectTrigger id="move-room-select" className="w-full">
                <SelectValue placeholder="Select room..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ROOM_NONE}>Unassigned</SelectItem>
                {rooms.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || unchanged}>
              {saving ? "Moving..." : "Move to Room"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type HardwareDetailsSubject =
  | { kind: "switch"; data: SwitchItem }
  | { kind: "device"; data: DeviceItem }
  | { kind: "sensor"; data: SensorItem };

export function HardwareDetailsModal({
  open,
  onOpenChange,
  subject,
  controller,
  room,
  timezone,
  canManage,
  onEdit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subject: HardwareDetailsSubject | null;
  controller: ControllerItem | undefined;
  room: RoomItem | undefined;
  timezone: string;
  canManage: boolean;
  onEdit?: () => void;
}) {
  if (!subject) return null;

  const isSwitch = subject.kind === "switch";
  const isDevice = subject.kind === "device";
  const isSensor = subject.kind === "sensor";

  const controllerOnline =
    controller?.status === "online" ||
    (controller?.status !== "offline" &&
      controller?.status !== "disconnected" &&
      subject.data.is_online);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{subject.data.name}</DialogTitle>
          <DialogDescription>
            Hardware channel details, controller assignment, and telemetry status.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 rounded-xl border bg-muted/25 p-4 text-xs sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-medium text-muted-foreground">Category</p>
            <p className="mt-0.5 font-medium capitalize text-foreground">
              {isDevice
                ? subject.data.device_type.replace(/_/g, " ")
                : isSensor
                  ? subject.data.sensor_type
                  : "Relay / Light Switch"}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-medium text-muted-foreground">Status</p>
            <div className="mt-0.5 flex items-center gap-1.5">
              {isSwitch && (
                <Badge variant={subject.data.is_on ? "success-light" : "secondary"}>
                  {subject.data.is_on ? "ON" : "OFF"}
                </Badge>
              )}
              {isDevice && (
                <Badge
                  variant={
                    subject.data.state === "active" || subject.data.state === "on"
                      ? "success-light"
                      : "secondary"
                  }
                >
                  {subject.data.state}
                </Badge>
              )}
              <Badge variant={controllerOnline ? "success-light" : "warning-light"}>
                {controllerOnline ? "Online" : "Offline"}
              </Badge>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-medium text-muted-foreground">Room</p>
            <p className="mt-0.5 font-medium text-foreground">
              {room?.name ?? "Unassigned"}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-medium text-muted-foreground">Controller</p>
            <p className="mt-0.5 font-medium text-foreground">
              {controller?.name ?? "Unknown controller"}
              {controller?.board_model ? ` (${controller.board_model})` : ""}
            </p>
          </div>

          <div>
            <p className="text-[11px] font-medium text-muted-foreground">Pin / Bus</p>
            <p className="mt-0.5 font-mono text-foreground">
              {subject.data.gpio_pin !== null
                ? `GPIO${subject.data.gpio_pin}`
                : "I2C / Virtual"}
              {isSensor && subject.data.i2c_address
                ? ` · ${subject.data.i2c_address}`
                : ""}
            </p>
          </div>

          {isSwitch && (
            <div>
              <p className="text-[11px] font-medium text-muted-foreground">Relay Logic</p>
              <p className="mt-0.5 font-medium text-foreground">
                {subject.data.inverted ? "Active-LOW (Inverted)" : "Active-HIGH (Standard)"}
              </p>
            </div>
          )}

          {isSensor && (
            <div>
              <p className="text-[11px] font-medium text-muted-foreground">Latest Reading</p>
              <p className="mt-0.5 font-semibold tabular-nums text-foreground">
                {subject.data.last_value !== null
                  ? `${subject.data.last_value} ${subject.data.unit}`
                  : "No reading yet"}
              </p>
            </div>
          )}

          {isSwitch && subject.data.last_changed_at && (
            <div className="sm:col-span-2">
              <p className="text-[11px] font-medium text-muted-foreground">Last Changed</p>
              <p className="mt-0.5 text-foreground">
                {formatTimestamp(subject.data.last_changed_at, timezone)}
              </p>
            </div>
          )}

          {isSensor && subject.data.last_reading_at && (
            <div className="sm:col-span-2">
              <p className="text-[11px] font-medium text-muted-foreground">Last Telemetry</p>
              <p className="mt-0.5 text-foreground">
                {formatTimestamp(subject.data.last_reading_at, timezone)}
              </p>
            </div>
          )}

          {controller?.local_ip && (
            <div className="sm:col-span-2">
              <p className="text-[11px] font-medium text-muted-foreground">Controller Network</p>
              <p className="mt-0.5 font-mono text-foreground">
                {controller.local_ip}
                {controller.firmware_version ? ` · v${controller.firmware_version}` : ""}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          {canManage && onEdit && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
                onEdit();
              }}
            >
              Edit Configuration
            </Button>
          )}
          <Button type="button" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
