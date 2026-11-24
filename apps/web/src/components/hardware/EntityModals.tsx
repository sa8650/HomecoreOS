import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  SENSOR_MEASUREMENT_REGISTRY,
  SUPPORTED_DEVICE_TYPES,
  SUPPORTED_SENSOR_TYPES,
  getSensorCategory,
  getSensorDriverById,
  getSensorDriverForMeasurement,
  getMeasurementOptionsForDriver,
  getSensorMeasurementByType,
  isDeviceStateActive,
  type ControllerSensorCompatibilityReport,
  type ControllerSensorOptionReport,
  type SensorDriverDefinition,
  type SensorResourcesConfig,
} from "@homecoreos/shared";
import { apiFetch, ApiError } from "@/lib/api";
import {
  getRequirementForDeviceType,
  getRequirementForSensorType,
  type HardwareContext,
} from "@/lib/board-pin-helpers";
import { useGpioPinField } from "@/lib/use-gpio-pin-field";
import { formatTimestamp } from "@/lib/timezone";
import { GpioPinPicker } from "@/components/hardware/GpioPinPicker";
import { readSensorI2cAddress } from "@/components/hardware/wire-diagram-shared";
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
} from "@/components/reui/select";
import { Switch } from "@/components/ui/switch";
import type {
  ControllerItem,
  DeviceItem,
  RoomItem,
  SensorItem,
  SwitchItem,
} from "@/features/types";

const ROOM_NONE = "__none__";
const MODULE_SEPARATE = "__separate__";

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
  const [boardInstanceId, setControllerId] = useState("");
  const [roomId, setRoomId] = useState(ROOM_NONE);
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
        setControllerId(switchItem.board_instance_id);
        setRoomId(switchItem.room_id ?? ROOM_NONE);
        setInvertedLogic(Boolean(switchItem.inverted));
      } else {
        setName("");
        setControllerId(ctx.controllers[0]?.id ?? "");
        setRoomId(ROOM_NONE);
        setInvertedLogic(false);
      }
    } else if (!switchItem && !boardInstanceId && ctx.controllers[0]?.id) {
      setControllerId(ctx.controllers[0].id);
    }
  }, [open, switchItem, boardInstanceId, ctx.controllers]);

  const selectedCtrl = ctx.controllers.find((c) => c.id === boardInstanceId);
  const pinField = useGpioPinField({
    open,
    savedPin: switchItem ? switchItem.gpio_pin : undefined,
    controller: selectedCtrl,
    ctx,
    requirement: "digital_out",
    entityKind: "switch",
    entityId: switchItem?.id,
    fallbackPin: "4",
  });
  const pinBlocked = pinField.pinNum === null || pinField.selection.blocked;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    if (!name.trim()) {
      setError("Switch name is required.");
      return;
    }
    if (!boardInstanceId) {
      setError("Select a controller.");
      return;
    }
    if (pinField.pinNum === null) {
      setError("Choose a GPIO pin for this switch.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        boardInstanceId,
        roomId: roomId === ROOM_NONE ? null : roomId,
        gpioPin: pinField.pinNum,
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
      <DialogContent className="sm:max-w-xl">
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
              <Select value={boardInstanceId} onValueChange={setControllerId}>
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

          <GpioPinPicker
            id="sw-gpio"
            label="GPIO Pin"
            value={pinField.text}
            onChange={pinField.setPin}
            selection={pinField.selection}
            requirement="digital_out"
            typeLabel="a switch"
          />

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
              disabled={saving || !boardInstanceId || pinBlocked}
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
  const [boardInstanceId, setControllerId] = useState("");
  const [roomId, setRoomId] = useState(ROOM_NONE);
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
        setControllerId(deviceItem.board_instance_id);
        setRoomId(deviceItem.room_id ?? ROOM_NONE);
      } else {
        setName("");
        setDeviceType(SUPPORTED_DEVICE_TYPES[0]);
        setControllerId(ctx.controllers[0]?.id ?? "");
        setRoomId(ROOM_NONE);
      }
    } else if (!deviceItem && !boardInstanceId && ctx.controllers[0]?.id) {
      setControllerId(ctx.controllers[0].id);
    }
  }, [open, deviceItem, boardInstanceId, ctx.controllers]);

  const selectedCtrl = ctx.controllers.find((c) => c.id === boardInstanceId);
  const requirement = getRequirementForDeviceType(deviceType);
  const pinField = useGpioPinField({
    open,
    savedPin: deviceItem ? deviceItem.gpio_pin : undefined,
    controller: selectedCtrl,
    ctx,
    requirement,
    entityKind: "device",
    entityId: deviceItem?.id,
    fallbackPin: "6",
  });
  const pinBlocked = pinField.pinNum === null || pinField.selection.blocked;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    if (!name.trim()) {
      setError("Device name is required.");
      return;
    }
    if (!boardInstanceId) {
      setError("Select a controller.");
      return;
    }
    if (pinField.pinNum === null) {
      setError("Choose a GPIO pin for this device.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        deviceType,
        boardInstanceId,
        roomId: roomId === ROOM_NONE ? null : roomId,
        gpioPin: pinField.pinNum,
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
      <DialogContent className="sm:max-w-xl">
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
              <Select value={boardInstanceId} onValueChange={setControllerId}>
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

          <GpioPinPicker
            id="dev-gpio"
            label="GPIO Pin"
            value={pinField.text}
            onChange={pinField.setPin}
            selection={pinField.selection}
            requirement={requirement}
            typeLabel={`a ${deviceType.replace(/_/g, " ")}`}
          />

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
              disabled={saving || !boardInstanceId || pinBlocked}
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
  fetchLiveCompatibility = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sensorItem: SensorItem | null;
  ctx: HardwareContext;
  onSaved: () => Promise<void> | void;
  fetchLiveCompatibility?: boolean;
}) {
  const isEditing = Boolean(sensorItem);
  const [name, setName] = useState("");
  const [sensorType, setSensorType] = useState<string>(
    SUPPORTED_SENSOR_TYPES[0]
  );
  const [boardInstanceId, setControllerId] = useState("");
  const [roomId, setRoomId] = useState(ROOM_NONE);
  const [i2cAddress, setI2cAddress] = useState("");
  const [driverId, setDriverId] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [auxPinText, setAuxPinText] = useState("");
  const [shareModuleId, setShareModuleId] = useState(MODULE_SEPARATE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveCompatByCtrl, setLiveCompatByCtrl] = useState<
    Record<string, ControllerSensorCompatibilityReport>
  >({});
  const [loadingCompat, setLoadingCompat] = useState(false);
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
        const savedDriver =
          sensorItem.driver_id ?? getSensorDriverForMeasurement(sensorItem.sensor_type)?.id ?? "";
        const savedResources = sensorItem.resources ??
          (sensorItem.last_raw_payload?.resources as SensorResourcesConfig | undefined);
        setName(sensorItem.name);
        setSensorType(sensorItem.sensor_type);
        setControllerId(sensorItem.board_instance_id);
        setRoomId(sensorItem.room_id ?? ROOM_NONE);
        setI2cAddress(readSensorI2cAddress(sensorItem) ?? "");
        setDriverId(savedDriver);
        setModel(sensorItem.model ?? savedResources?.model ?? getSensorDriverById(savedDriver)?.supportedModels[0] ?? "");
        setAuxPinText(
          String(savedResources?.pins?.i2c_scl ?? savedResources?.pins?.uart_rx ?? savedResources?.pins?.spi_cs ?? "")
        );
        setShareModuleId(MODULE_SEPARATE);
      } else {
        setName("");
        const initialCtrlId = ctx.controllers[0]?.id ?? "";
        const initialCompat =
          ctx.sensorCompatibilityByController?.get(initialCtrlId) ??
          ctx.controllers[0]?.sensor_compatibility ??
          null;
        setSensorType(
          initialCompat
            ? (initialCompat.compatibleSensors[0]?.sensorType ?? "")
            : SUPPORTED_SENSOR_TYPES[0]
        );
        setControllerId(initialCtrlId);
        setRoomId(ROOM_NONE);
        setI2cAddress("");
        setDriverId("");
        setModel("");
        setAuxPinText("");
        setShareModuleId(MODULE_SEPARATE);
      }
    } else if (!sensorItem && !boardInstanceId && ctx.controllers[0]?.id) {
      setControllerId(ctx.controllers[0].id);
    }
  }, [open, sensorItem, boardInstanceId, ctx.controllers, ctx.sensorCompatibilityByController]);

  const selectedCtrl = ctx.controllers.find((c) => c.id === boardInstanceId);

  useEffect(() => {
    if (!open || !boardInstanceId || !fetchLiveCompatibility) return;
    let cancelled = false;
    setLoadingCompat(true);
    apiFetch<ControllerSensorCompatibilityReport & { boardInstanceId?: string }>(
      `/api/board-instances/${boardInstanceId}/sensor-compatibility`
    )
      .then((res) => {
        if (!cancelled && res && Array.isArray(res.compatibleSensors)) {
          setLiveCompatByCtrl((prev) => ({ ...prev, [boardInstanceId]: res }));
        }
      })
      .catch(() => {
        // Fall back to preloaded controller compatibility from ctx if transient error occurs
      })
      .finally(() => {
        if (!cancelled) setLoadingCompat(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, boardInstanceId, fetchLiveCompatibility]);

  const activeCompat: ControllerSensorCompatibilityReport | null =
    (boardInstanceId ? liveCompatByCtrl[boardInstanceId] : undefined) ??
    (boardInstanceId ? ctx.sensorCompatibilityByController?.get(boardInstanceId) : undefined) ??
    selectedCtrl?.sensor_compatibility ??
    null;

  // When compatibility changes (e.g. user switches controller), ensure sensorType & driverId stay valid.
  useEffect(() => {
    if (!open || !activeCompat) return;
    const isStillCompatible = activeCompat.compatibleSensors.some(
      (s) => s.sensorType === sensorType
    );
    if (!isStillCompatible) {
      if (!isEditing || (sensorItem && boardInstanceId !== sensorItem.board_instance_id)) {
        const nextType = activeCompat.compatibleSensors[0]?.sensorType ?? "";
        const nextDriver = nextType ? getSensorDriverForMeasurement(nextType) : undefined;
        setSensorType(nextType);
        setDriverId(nextDriver?.id ?? "");
        setModel("");
        setAuxPinText("");
        setShareModuleId(MODULE_SEPARATE);
      }
    }
  }, [open, activeCompat, boardInstanceId, isEditing, sensorItem, sensorType]);

  const selectableOptions: ControllerSensorOptionReport[] = activeCompat
    ? activeCompat.compatibleSensors
    : SENSOR_MEASUREMENT_REGISTRY.map((m) => {
        const drv = getSensorDriverForMeasurement(m.sensorType);
        return {
          sensorType: m.sensorType,
          driverId: m.driverId,
          displayName: m.displayName,
          driverDisplayName: drv?.displayName ?? m.displayName,
          shortDescription: m.shortDescription,
          interface: drv?.interface ?? "gpio_digital_in",
          interfaceLabel: m.interfaceLabel,
          defaultUnit: m.defaultUnit,
          defaultI2cAddresses: drv?.busConfig.defaultAddresses ?? [],
          boardSupported: true,
          firmwareSupported: true,
          compatible: true,
          boardReasons: [],
          firmwareReasons: [],
          availablePins: [],
          driverVersion: drv?.driverVersion ?? null,
          hardwareVerificationStatus: drv?.hardwareVerificationStatus ?? "implemented_unverified",
        };
      });

  const currentTypeIsCompatible = activeCompat
    ? activeCompat.compatibleSensors.some((s) => s.sensorType === sensorType)
    : Boolean(sensorType);

  const selectedOption =
    selectableOptions.find((o) => o.sensorType === sensorType) ??
    activeCompat?.incompatibleSensors.find((o) => o.sensorType === sensorType) ??
    null;

  const selectedMeasurement = sensorType ? getSensorMeasurementByType(sensorType) : undefined;
  const measuredDriver = sensorType ? getSensorDriverForMeasurement(sensorType) : undefined;
  const selectedDriver = getSensorDriverById(driverId) ?? measuredDriver;
  const driversById = new Map<string, SensorDriverDefinition | undefined>();
  for (const option of selectableOptions) {
    driversById.set(option.driverId, getSensorDriverById(option.driverId));
  }
  const hardwareOptions = Array.from(driversById.values()).filter(
    (drv): drv is SensorDriverDefinition => Boolean(drv)
  );
  const driverMeasurements = selectedDriver
    ? getMeasurementOptionsForDriver(selectedDriver.id)
    : [];
  const compatibleDriver = selectedDriver
    ? selectableOptions.some((option) => option.driverId === selectedDriver.id)
    : false;
  const primaryRole = selectedDriver?.resources?.roles[0] ?? null;
  const secondaryRole = selectedDriver?.resources?.roles.find(
    (r) => r === "i2c_scl" || r === "uart_rx" || r === "spi_cs"
  ) ?? null;
  const auxPin = auxPinText.trim() === "" ? null : Number(auxPinText);

  interface SiblingModuleOption {
    id: string;
    name: string;
    pin: number | null;
    auxPin: number | null;
    i2cAddress: string | null;
    model: string | null;
    physicalSensorId: string | null;
  }

  const siblingModules: SiblingModuleOption[] = (() => {
    if (!selectedDriver) return [];
    const seen = new Set<string>();
    const out: SiblingModuleOption[] = [];

    for (const sen of ctx.sensorsByController?.get(boardInstanceId) ?? []) {
      if (sen.id === sensorItem?.id) continue;
      const drvId =
        sen.driver_id ?? getSensorDriverForMeasurement(sen.sensor_type)?.id ?? null;
      if (drvId !== selectedDriver.id || seen.has(sen.id)) continue;
      seen.add(sen.id);
      const res =
        sen.resources ??
        (sen.last_raw_payload?.resources as SensorResourcesConfig | undefined);
      const secPin =
        res?.pins?.i2c_scl ?? res?.pins?.uart_rx ?? res?.pins?.spi_cs ?? null;
      out.push({
        id: sen.id,
        name: sen.name,
        pin: sen.gpio_pin ?? null,
        auxPin: typeof secPin === "number" ? secPin : null,
        i2cAddress: readSensorI2cAddress(sen),
        model:
          sen.model ??
          res?.model ??
          (typeof sen.last_raw_payload?.model === "string"
            ? sen.last_raw_payload.model
            : null),
        physicalSensorId: sen.physical_sensor_id ?? null,
      });
    }

    for (const usage of ctx.usedPinsByController?.get(boardInstanceId) ?? []) {
      if (usage.entityKind !== "sensor" || usage.id === sensorItem?.id || seen.has(usage.id)) {
        continue;
      }
      if (getSensorDriverForMeasurement(usage.sensorType ?? "")?.id !== selectedDriver.id) {
        continue;
      }
      seen.add(usage.id);
      out.push({
        id: usage.id,
        name: usage.name,
        pin: usage.pin,
        auxPin: null,
        i2cAddress: usage.i2cAddress ?? null,
        model: null,
        physicalSensorId: usage.physicalSensorId ?? null,
      });
    }

    return out;
  })();

  function handleDriverChange(nextDriverId: string) {
    const drv = getSensorDriverById(nextDriverId);
    setDriverId(nextDriverId);
    setModel(drv?.supportedModels[0] ?? "");
    setAuxPinText("");
    setShareModuleId(MODULE_SEPARATE);
    const nextMeasurement = drv?.measurements.find((m) => m === sensorType) ?? drv?.measurements[0];
    if (nextMeasurement) setSensorType(nextMeasurement);
    if (drv && !drv.busConfig.defaultAddresses?.length) setI2cAddress("");
  }

  function handleMeasurementChange(nextType: string) {
    setSensorType(nextType);
    const owner = getSensorDriverForMeasurement(nextType);
    if (owner && owner.id !== driverId) {
      setDriverId(owner.id);
      setModel(owner.supportedModels[0] ?? "");
    }
  }

  function applySharedModule(moduleId: string) {
    setShareModuleId(moduleId);
    if (!moduleId || moduleId === MODULE_SEPARATE) return;
    const sibling = siblingModules.find((usage) => usage.id === moduleId);
    if (!sibling) return;
    if (sibling.pin !== null && (primaryRole !== "i2c_sda" || sibling.pin !== undefined)) {
      setPinText(String(sibling.pin));
    } else if (primaryRole === "i2c_sda" && sibling.pin === null) {
      setPinText("");
    }
    if (sibling.auxPin !== null) setAuxPinText(String(sibling.auxPin));
    if (sibling.i2cAddress) setI2cAddress(sibling.i2cAddress);
    if (sibling.model) setModel(sibling.model);
  }

  const requirement = getRequirementForSensorType(
    sensorType || SUPPORTED_SENSOR_TYPES[0]
  );
  const isI2c = requirement === "i2c";
  const pinField = useGpioPinField({
    open,
    savedPin: sensorItem ? sensorItem.gpio_pin : undefined,
    controller: selectedCtrl,
    ctx,
    requirement,
    entityKind: "sensor",
    entityId: sensorItem?.id,
    // An I2C sensor without a pin uses the controller's default bus.
    fallbackPin: isI2c ? "" : "5",
    sensorType: sensorType || undefined,
  });
  const setPinText = pinField.setPin;
  const parsedPin = pinField.pinNum;
  const pinBlocked = pinField.selection.blocked || (!isI2c && parsedPin === null);

  const savedI2cAddress = readSensorI2cAddress(sensorItem);
  const effectiveI2cAddress = isI2c ? (i2cAddress.trim() || null) : null;
  const savedAuxPin =
    secondaryRole && typeof sensorItem?.resources?.pins?.[secondaryRole] === "number"
      ? sensorItem.resources.pins[secondaryRole]
      : null;
  const hardwareBindingUnchanged = Boolean(
    isEditing &&
      sensorItem &&
      boardInstanceId === sensorItem.board_instance_id &&
      sensorType === sensorItem.sensor_type &&
      parsedPin === sensorItem.gpio_pin &&
      auxPin === savedAuxPin &&
      (selectedDriver?.id ?? null) === (sensorItem.driver_id ?? selectedDriver?.id ?? null) &&
      (model || null) === (sensorItem.model ?? null) &&
      effectiveI2cAddress === savedI2cAddress
  );

  const compatibilityBlocked = Boolean(
    activeCompat && !currentTypeIsCompatible && !hardwareBindingUnchanged
  );

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    if (!name.trim()) {
      setError("Sensor name is required.");
      return;
    }
    if (!boardInstanceId) {
      setError("Select a controller.");
      return;
    }
    if (!sensorType) {
      setError(
        activeCompat?.updateRecommendation ??
          "No compatible sensor drivers are available on this controller's current firmware."
      );
      return;
    }
    if (compatibilityBlocked) {
      setError(
        selectedOption?.firmwareReasons[0] ??
          selectedOption?.boardReasons[0] ??
          "This sensor is not supported by the selected controller's hardware and installed firmware."
      );
      return;
    }
    if (parsedPin !== null && !Number.isInteger(parsedPin)) {
      setError("Enter a valid whole-number GPIO pin (0-54).");
      return;
    }
    if (!isI2c && (parsedPin === null || !Number.isInteger(parsedPin))) {
      setError("Enter a valid GPIO pin for this sensor driver.");
      return;
    }
    if (auxPinText.trim() && (!Number.isInteger(auxPin) || (auxPin ?? -1) < 0)) {
      setError("Enter a valid whole-number GPIO pin for the secondary signal.");
      return;
    }
    if ((secondaryRole === "uart_rx" || secondaryRole === "spi_cs") && auxPin === null) {
      setError(
        secondaryRole === "uart_rx"
          ? "Enter a UART RX GPIO pin for this sensor."
          : "Enter an SPI CS GPIO pin for this sensor."
      );
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const bindingPins: Record<string, number> = {};
      if (primaryRole && parsedPin !== null) bindingPins[primaryRole] = parsedPin;
      if (secondaryRole && auxPin !== null && Number.isInteger(auxPin)) {
        bindingPins[secondaryRole] = auxPin;
      }
      const resources: SensorResourcesConfig | undefined = selectedDriver
        ? {
            driverId: selectedDriver.id,
            model: model || selectedDriver.supportedModels[0] || undefined,
            busId: null,
            pins: bindingPins,
            i2cAddress: isI2c ? (i2cAddress.trim() || null) : null,
          }
        : undefined;

      const selectedPhysicalId =
        shareModuleId && shareModuleId !== MODULE_SEPARATE
          ? siblingModules.find((s) => s.id === shareModuleId)?.physicalSensorId ?? undefined
          : sensorItem?.physical_sensor_id ?? undefined;

      const payload = {
        name: name.trim(),
        sensorType,
        boardInstanceId,
        roomId: roomId === ROOM_NONE ? null : roomId,
        gpioPin: parsedPin,
        i2cAddress: isI2c ? (i2cAddress.trim() || null) : null,
        driverId: selectedDriver?.id ?? null,
        model: model || null,
        resources,
        physicalSensorId: selectedPhysicalId,
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

  const defaultI2cAddrs =
    selectedDriver?.busConfig.defaultAddresses?.join(" or ") ?? "0x76 or 0x23";
  const defaultI2cBus = activeCompat?.boardCapabilities?.defaultI2cBus;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? `Edit Sensor: ${sensorItem?.name}` : "Add Supported Sensor"}
          </DialogTitle>
          <DialogDescription>
            Sensors are filtered to match both the selected controller&apos;s board hardware and its installed firmware drivers.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <StatusAlert tone="danger">{error}</StatusAlert>}

          {activeCompat && activeCompat.needsFirmwareUpdate && activeCompat.updateRecommendation && (
            <StatusAlert tone="warning" title="Firmware update needed for additional sensors">
              <div className="space-y-1">
                <p>{activeCompat.updateRecommendation}</p>
                {activeCompat.boardOnlySupportedSensors.length > 0 && (
                  <p className="text-[11px] opacity-90">
                    {activeCompat.boardOnlySupportedSensors.length} additional sensor measurement(s) are physically supported by{" "}
                    {activeCompat.boardName ?? "this board"} once firmware includes their drivers.
                  </p>
                )}
              </div>
            </StatusAlert>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField id="sen-ctrl" label="Controller">
              <Select value={boardInstanceId} onValueChange={setControllerId}>
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
            <FormField id="sen-name" label="Sensor Name">
              <Input
                id="sen-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ambient Temperature"
              />
            </FormField>
            <FormField id="sen-hardware" label="Hardware Model (Physical Driver)">
              <Select
                value={selectedDriver?.id ?? ""}
                onValueChange={handleDriverChange}
                disabled={loadingCompat || hardwareOptions.length === 0}
              >
                <SelectTrigger id="sen-hardware" className="w-full">
                  <SelectValue
                    placeholder={
                      hardwareOptions.length === 0
                        ? "No hardware supported by this firmware"
                        : "Select hardware model..."
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {hardwareOptions.map((drv) => (
                    <SelectItem key={drv.id} value={drv.id}>
                      {getSensorCategory(drv.category ?? "")?.displayName ?? "Sensor"} · {drv.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField id="sen-model" label="Model / Variant">
              <Select value={model} onValueChange={setModel} disabled={!selectedDriver}>
                <SelectTrigger id="sen-model" className="w-full">
                  <SelectValue placeholder="Select model..." />
                </SelectTrigger>
                <SelectContent>
                  {(selectedDriver?.supportedModels ?? []).map((item) => (
                    <SelectItem key={item} value={item}>{item}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField id="sen-type" label="Measurement Entity">
              <Select
                value={sensorType}
                onValueChange={handleMeasurementChange}
                disabled={loadingCompat || driverMeasurements.length === 0}
              >
                <SelectTrigger id="sen-type" className="w-full">
                  <SelectValue placeholder="Select measurement..." />
                </SelectTrigger>
                <SelectContent>
                  {driverMeasurements.map((m) => (
                    <SelectItem key={m.sensorType} value={m.sensorType}>
                      {m.displayName} · {m.defaultUnit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          {selectedDriver && (
            <div className="rounded-lg border bg-muted/25 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" radius="full">
                  {getSensorCategory(selectedDriver.category ?? "")?.displayName ?? "Sensor"}
                </Badge>
                <Badge variant="outline" radius="full">
                  {selectedDriver.interfaceLabel}
                </Badge>
                {!compatibleDriver && (
                  <Badge variant="warning" radius="full">Requires firmware update</Badge>
                )}
                <Badge variant="outline" radius="full">
                  {selectedDriver.hardwareVerificationStatus.replace(/_/g, " ")}
                </Badge>
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Driver <strong>{selectedDriver.id}</strong> v{selectedDriver.driverVersion} · protocol{" "}
                {selectedDriver.protocolFamily ?? selectedDriver.id} · shares one physical module across{" "}
                {driverMeasurements.length} measurement(s).
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Available measurements: {driverMeasurements.map((m) => m.displayName).join(", ")}
              </p>
              {selectedDriver.limitations && (
                <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                  {selectedDriver.limitations}
                </p>
              )}
              {siblingModules.length > 0 && (
                <div className="mt-2">
                  <label className="text-[11px] font-medium" htmlFor="sen-share-module">
                    Attach this measurement to an existing physical module
                  </label>
                  <Select value={shareModuleId} onValueChange={applySharedModule}>
                    <SelectTrigger id="sen-share-module" className="mt-1 w-full">
                      <SelectValue placeholder="Separate physical module" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={MODULE_SEPARATE}>Separate physical module</SelectItem>
                      {siblingModules.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name} (
                          {s.pin !== null
                            ? s.auxPin !== null
                              ? `GPIO ${s.pin} / ${s.auxPin}`
                              : `GPIO ${s.pin}`
                            : s.i2cAddress
                              ? `I2C ${s.i2cAddress}`
                              : "default I2C"}
                          )
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}

          {selectedOption && (
            <div className="rounded-lg border bg-muted/35 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground">
                  {selectedOption.displayName}
                </span>
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" radius="full">
                    {selectedOption.interfaceLabel}
                  </Badge>
                  {selectedOption.driverVersion && (
                    <Badge variant="success-light" radius="full">
                      Driver v{selectedOption.driverVersion}
                    </Badge>
                  )}
                </div>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {selectedOption.shortDescription}
                {selectedMeasurement ? ` Default unit: ${selectedMeasurement.defaultUnit}.` : ""}
              </p>
              {!currentTypeIsCompatible && isEditing && (
                <p className="mt-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                  Current saved sensor requires a firmware update on this controller before hardware binding changes can be saved.
                </p>
              )}
            </div>
          )}

          <GpioPinPicker
            id="sen-gpio"
            label={isI2c ? "I2C SDA GPIO (Optional)" : "GPIO Pin"}
            value={pinField.text}
            onChange={pinField.setPin}
            selection={pinField.selection}
            requirement={requirement}
            typeLabel={
              isI2c
                ? "an I2C sensor"
                : selectedDriver?.requiresBidirectionalGpio
                  ? `${selectedDriver.displayName} (bidirectional GPIO)`
                  : "this sensor"
            }
            optional={isI2c}
          />
          {isI2c && (
            <FormField
              id="sen-i2c"
              label="I2C Address (Optional)"
              hint={
                defaultI2cBus && defaultI2cBus.sdaPin !== null && defaultI2cBus.sclPin !== null
                  ? `Leave the pin empty to use the board's default I2C bus (SDA GPIO${defaultI2cBus.sdaPin} / SCL GPIO${defaultI2cBus.sclPin}). Default address: ${defaultI2cAddrs}.`
                  : `Leave the pin empty to use the controller's default I2C bus. Default address: ${defaultI2cAddrs}.`
              }
            >
              <Input
                id="sen-i2c"
                value={i2cAddress}
                onChange={(e) => setI2cAddress(e.target.value)}
                placeholder={defaultI2cAddrs}
              />
            </FormField>
          )}

          {secondaryRole && (
            <FormField
              id="sen-aux-pin"
              label={
                secondaryRole === "i2c_scl"
                  ? "I2C SCL GPIO (Optional)"
                  : secondaryRole === "uart_rx"
                    ? "UART RX GPIO"
                    : "SPI Chip Select (CS) GPIO"
              }
              hint={
                secondaryRole === "i2c_scl" && defaultI2cBus?.sclPin !== null && defaultI2cBus?.sclPin !== undefined
                  ? `Leave empty to use the documented board bus (SCL GPIO${defaultI2cBus.sclPin}).`
                  : "Required second signal for this physical driver."
              }
            >
              <Input
                id="sen-aux-pin"
                value={auxPinText}
                onChange={(e) => setAuxPinText(e.target.value)}
                placeholder={secondaryRole === "i2c_scl" ? String(defaultI2cBus?.sclPin ?? "") : "GPIO"}
              />
            </FormField>
          )}

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
              disabled={
                saving ||
                !boardInstanceId ||
                !sensorType ||
                compatibilityBlocked ||
                pinBlocked
              }
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
                    isDeviceStateActive(subject.data.state)
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
              {(() => {
                const res = isSensor
                  ? (subject.data.resources ??
                    (subject.data.last_raw_payload?.resources as
                      | SensorResourcesConfig
                      | undefined))
                  : undefined;
                const pinPairs = Object.entries(res?.pins ?? {}).filter(
                  (entry): entry is [string, number] => typeof entry[1] === "number"
                );
                if (pinPairs.length > 0) {
                  return pinPairs
                    .map(([role, p]) => `${role.toUpperCase()}:GPIO${p}`)
                    .join(" · ");
                }
                return subject.data.gpio_pin !== null
                  ? `GPIO${subject.data.gpio_pin}`
                  : "I2C / Virtual";
              })()}
              {isSensor && readSensorI2cAddress(subject.data)
                ? ` · ${readSensorI2cAddress(subject.data)}`
                : ""}
            </p>
            {isSensor && (subject.data.driver_id || subject.data.model) && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {[subject.data.driver_id, subject.data.model].filter(Boolean).join(" · ")}
              </p>
            )}
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
