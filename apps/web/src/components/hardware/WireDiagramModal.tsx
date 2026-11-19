import { useEffect, useMemo, useState } from "react";
import {
  RiAlertLine,
  RiArrowLeftRightLine,
  RiShieldKeyholeLine,
  RiBookOpenLine,
  RiCheckboxCircleLine,
  RiCpuLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiFileTextLine,
  RiFlashlightLine,
  RiFocus3Line,
  RiInformationLine,
  RiPlugLine,
  RiSensorLine,
  RiShieldCheckLine,
  RiTableLine,
  RiToggleLine,
  RiRouteLine,
} from "@remixicon/react";
import {
  buildWireDiagram,
  type WireDiagramBoardInput,
  type WireDiagramResult,
} from "@homecoreos/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import { WireDiagramCanvas } from "@/components/hardware/WireDiagramCanvas";
import { DeviceIllustration } from "@/components/hardware/DeviceIllustration";
import {
  connectionStatus,
  pinCapabilityList,
  wireColor,
  wireDash,
  circuitWireColor,
  CIRCUIT_WIRE_LABELS,
} from "@/components/hardware/wire-diagram-shared";
import type { CircuitWire } from "@homecoreos/shared";
import type { HardwareContext } from "@/lib/board-pin-helpers";
import type {
  BoardProfileItem,
  ControllerItem,
  DeviceItem,
  SensorItem,
  SwitchItem,
} from "@/features/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Target type — the card that opened the dialog decides what is shown.
// ---------------------------------------------------------------------------
export type WireDiagramTarget =
  | { kind: "switch"; data: SwitchItem }
  | { kind: "device"; data: DeviceItem }
  | { kind: "sensor"; data: SensorItem };

function readSensorI2cAddress(sensor: SensorItem): string | null {
  if (typeof sensor.i2c_address === "string" && sensor.i2c_address.trim()) {
    return sensor.i2c_address.trim();
  }
  const raw = sensor.last_raw_payload?.i2c_address;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** BoardLibrary seeds use `undefined` for missing optional strings while the UI caches use `null`. */
function toWireBoardInput(board: BoardProfileItem): WireDiagramBoardInput {
  const { usb_vid, usb_pid, ...rest } = board;
  return {
    ...rest,
    usb_vid: usb_vid ?? undefined,
    usb_pid: usb_pid ?? undefined,
    is_available: board.is_available ?? null,
  };
}

function formatVerification(status: string | null | undefined): string {
  if (!status) return "Not documented";
  return status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function WireDiagramModal({
  open,
  onOpenChange,
  target,
  ctx,
  onEdit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: WireDiagramTarget | null;
  ctx: HardwareContext;
  /** Opens the entity's edit dialog (the host page owns it). */
  onEdit?: () => void;
}) {
  const [tab, setTab] = useState<"diagram" | "connections" | "datasheet">("diagram");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const targetId = target?.data.id ?? null;

  useEffect(() => {
    setSelectedId(null);
    setTab("diagram");
  }, [targetId, open]);

  const derived = useMemo(() => {
    if (!target) return null;
    const d = target.data;
    const controller =
      ctx.controllers.find((c) => c.id === d.board_instance_id) ?? null;
    const boardId =
      controller?.board_profile_id ?? controller?.custom_board_profile_id ?? null;
    const board = boardId ? (ctx.boardsById.get(boardId) ?? null) : null;
    const room = d.room_id
      ? (ctx.rooms.find((r) => r.id === d.room_id) ?? null)
      : null;

    const base = {
      kind: target.kind,
      id: d.id,
      name: d.name,
      boardInstanceId: d.board_instance_id,
      isOnline: d.is_online,
    } as const;
    const entity =
      target.kind === "switch"
        ? {
            ...base,
            gpioPin: target.data.gpio_pin,
            inverted: target.data.inverted,
          }
        : target.kind === "device"
          ? {
              ...base,
              gpioPin: target.data.gpio_pin,
              deviceType: target.data.device_type,
            }
          : {
              ...base,
              gpioPin: target.data.gpio_pin,
              sensorType: target.data.sensor_type,
              i2cAddress: readSensorI2cAddress(target.data),
            };

    const wireController = controller
      ? {
          id: controller.id,
          name: controller.name,
          boardProfileId: controller.board_profile_id,
          customBoardProfileId: controller.custom_board_profile_id,
          boardModel: controller.board_model,
          firmwareVersion: controller.firmware_version,
          status: controller.status,
        }
      : null;

    const siblingPins = (ctx.usedPinsByController?.get(d.board_instance_id) ?? [])
      .filter((u) => !(u.entityKind === target.kind && u.id === d.id))
      .map((u) => ({
        pin: u.pin,
        entityKind: u.entityKind,
        id: u.id,
        name: u.name,
        sensorType: u.sensorType,
      }));

    const result = buildWireDiagram({
      entity,
      controller: wireController,
      board: board ? toWireBoardInput(board) : null,
      siblingPins,
      roomName: room?.name ?? null,
    });

    return { result, board, controller, room };
  }, [target, ctx]);

  const result = derived?.result ?? null;
  const board = derived?.board ?? null;
  const controller = derived?.controller ?? null;
  const room = derived?.room ?? null;

  const gpioByPin = useMemo(
    () => new Map((board?.gpio_definitions ?? []).map((g) => [g.pin, g])),
    [board]
  );

  const selectedConnection =
    result?.connections.find((c) => c.id === selectedId) ?? null;

  const kindLabel =
    target?.kind === "switch"
      ? "Relay / Light switch"
      : target?.kind === "device"
        ? (target.data.device_type ?? "Device").replace(/_/g, " ")
        : target
          ? target.data.sensor_type
          : "Entity";

  const issueCount = result
    ? result.totals.invalid + result.totals.advisory
    : 0;

  if (!target || !result) return null;

  const unavailable = result.state === "unavailable";
  const HeaderIcon =
    target.kind === "switch"
      ? RiToggleLine
      : target.kind === "device"
        ? RiPlugLine
        : RiSensorLine;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[92dvh] max-h-[960px] w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl xl:max-w-7xl"
        aria-describedby={undefined}
        showCloseButton={false}
      >
        {/* ---------- Header ---------- */}
        <DialogHeader className="shrink-0 flex-row items-center gap-3 border-b px-4 py-3 pr-4 text-left">
          <div
            className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <HeaderIcon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-semibold tracking-tight">
              {result.entityName}
              <span className="sr-only"> — Interactive Wire Diagram</span>
            </DialogTitle>
            <DialogDescription className="mt-0.5 truncate text-[11px]">
              <span className="capitalize">{kindLabel}</span>
              {" · "}Controller{" "}
              <span className="font-medium text-foreground/80">
                {controller?.name ?? "Unknown controller"}
              </span>
              {board ? (
                <>
                  {" · "}
                  <span className="font-medium text-foreground/80">
                    {board.manufacturer} {board.model}
                  </span>
                </>
              ) : (
                " · No board profile resolved"
              )}
              {room ? ` · ${room.name}` : ""}
            </DialogDescription>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge
              variant={target.data.is_online ? "success-light" : "warning-light"}
              radius="full"
            >
              {target.data.is_online ? "Online" : "Offline"}
            </Badge>
            <CircuitSafetyBadge circuit={result.circuit} />
            <span className="hidden text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:block">
              Wire Diagram
            </span>
          </div>
        </DialogHeader>

        {/* ---------- Tabs ---------- */}
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as typeof tab)}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b bg-muted/20 px-3 sm:px-4">
            <TabsList className="h-8">
              <TabsTrigger value="diagram" className="gap-1.5">
                <RiRouteLine className="size-3.5" aria-hidden="true" />
                Diagram
              </TabsTrigger>
              <TabsTrigger value="connections" className="gap-1.5">
                <RiTableLine className="size-3.5" aria-hidden="true" />
                Connections
                <span className="ml-0.5 rounded-full bg-foreground/8 px-1.5 py-0.5 text-[9.5px] font-bold tabular-nums text-muted-foreground">
                  {result.connections.length + result.circuit.wires.length}
                </span>
                {issueCount > 0 && (
                  <span
                    className="ml-0.5 size-1.5 rounded-full bg-destructive"
                    aria-label={`${issueCount} advisories`}
                  />
                )}
              </TabsTrigger>
              <TabsTrigger value="datasheet" className="gap-1.5">
                <RiFileTextLine className="size-3.5" aria-hidden="true" />
                Datasheet
              </TabsTrigger>
            </TabsList>
            <div className="hidden items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground md:flex">
              <RiShieldCheckLine
                className="size-3.5 text-success"
                aria-hidden="true"
              />
              Logical assignment · not a physical inspection
            </div>
          </div>

          {/* ============ A. DIAGRAM ============ */}
          <TabsContent
            value="diagram"
            className="min-h-0 flex-1 overflow-hidden"
          >
            {unavailable ? (
              <UnavailablePanel reasons={result.unavailableReasons} />
            ) : (
              <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(0,46vh)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_330px] lg:grid-rows-none">
                <div className="relative min-h-[260px] overflow-hidden lg:min-h-0">
                  {board && (
                    <WireDiagramCanvas
                      board={board}
                      result={result}
                      selectedId={selectedId}
                      onSelectConnection={setSelectedId}
                      className="absolute inset-0"
                    />
                  )}
                </div>
                <aside className="min-h-0 flex-1 space-y-4 overflow-y-auto border-t bg-muted/15 p-4 lg:border-l lg:border-t-0">
                  <InspectorPanel
                    result={result}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    selectedConnection={selectedConnection}
                  />
                </aside>
              </div>
            )}
          </TabsContent>

          {/* ============ B. CONNECTIONS ============ */}
          <TabsContent
            value="connections"
            className="min-h-0 flex-1 overflow-hidden"
          >
            {unavailable ? (
              <UnavailablePanel reasons={result.unavailableReasons} />
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/25 px-4 py-2 text-[10.5px] text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <RiInformationLine className="size-3.5 shrink-0" aria-hidden="true" />
                    Configured logical assignments from the entity records —
                    HomecoreOS has <strong>not</strong> detected or verified
                    physical wiring.
                  </span>
                  {!result.allPlacementDocumented && (
                    <Badge variant="warning-outline">
                      Uses undocumented pads
                    </Badge>
                  )}
                  {result.totals.invalid > 0 && (
                    <Badge variant="destructive-light">
                      {result.totals.invalid} invalid assignment
                      {result.totals.invalid === 1 ? "" : "s"}
                    </Badge>
                  )}
                  {result.totals.shared > 0 && (
                    <Badge variant="info-outline">
                      {result.totals.shared} shared bus
                      {result.totals.shared === 1 ? "" : "es"}
                    </Badge>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  <Table className="min-w-[1020px]">
                    <TableHeader>
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableHead className="pl-4">Board pin</TableHead>
                        <TableHead>GPIO &amp; function</TableHead>
                        <TableHead>Device terminal</TableHead>
                        <TableHead>Signal</TableHead>
                        <TableHead>Voltage</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Warnings</TableHead>
                        <TableHead className="w-12" aria-label="Inspect" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.connections.map((conn) => {
                        const def =
                          conn.pin !== null
                            ? gpioByPin.get(conn.pin)
                            : undefined;
                        const caps = pinCapabilityList(def);
                        const status = connectionStatus(conn.kind);
                        const isSelected = conn.id === selectedId;
                        const restrictions: string[] = [];
                        if (def?.restrictions.input_only)
                          restrictions.push("input-only");
                        if (def?.restrictions.strapping_pin)
                          restrictions.push("bootstrapping");
                        return (
                          <TableRow
                            key={conn.id}
                            title={conn.detail}
                            className={cn(
                              "align-top",
                              isSelected && "bg-sky-500/5"
                            )}
                          >
                            <TableCell className="pl-4">
                              <BoardPinCell conn={conn} />
                            </TableCell>
                            <TableCell>
                              {conn.pin !== null ? (
                                <div className="space-y-0.5">
                                  <p className="font-mono text-[11px] font-bold">
                                    GPIO{conn.pin}
                                    {conn.pinName && (
                                      <span className="ml-1.5 font-sans font-medium text-muted-foreground">
                                        pad {conn.pinName}
                                      </span>
                                    )}
                                  </p>
                                  {caps.length > 0 && (
                                    <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                                      {caps.join(" · ")}
                                    </p>
                                  )}
                                  {restrictions.length > 0 && (
                                    <p className="text-[9px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-500">
                                      ⚠ {restrictions.join(" · ")}
                                    </p>
                                  )}
                                </div>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <p className="font-mono text-[11px] font-bold">
                                {conn.terminalLabel}
                              </p>
                              <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                                {conn.role}
                              </p>
                            </TableCell>
                            <TableCell>
                              <span className="flex items-center gap-1.5 text-[11px] font-medium">
                                <span
                                  className="inline-block size-2 rounded-full"
                                  style={{
                                    background: wireColor(conn),
                                  }}
                                  aria-hidden="true"
                                />
                                {conn.signal}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span
                                className={cn(
                                  "text-[11px]",
                                  conn.voltage === "Not documented" &&
                                    "italic text-muted-foreground"
                                )}
                              >
                                {conn.voltage}
                              </span>
                            </TableCell>
                            <TableCell>
                              <Badge variant={status.badgeVariant}>
                                {status.label}
                              </Badge>
                            </TableCell>
                            <TableCell className="max-w-64">
                              {conn.warnings.length > 0 ? (
                                <ul className="space-y-0.5 text-[10px] leading-snug text-amber-700 dark:text-amber-400">
                                  {conn.warnings.map((w, i) => (
                                    <li key={i}>⚠ {w}</li>
                                  ))}
                                </ul>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                aria-label={`Highlight ${conn.terminalLabel} in diagram`}
                                title="Show in diagram"
                                onClick={() => {
                                  setSelectedId(conn.id);
                                  setTab("diagram");
                                }}
                              >
                                <RiFocus3Line
                                  className="size-4"
                                  aria-hidden="true"
                                />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  {result.warnings.length > 0 && (
                    <div className="border-t bg-amber-500/5 px-4 py-3">
                      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-400">
                        <RiAlertLine className="size-3.5" aria-hidden="true" />
                        Advisories
                      </p>
                      <ul className="mt-1.5 space-y-1 text-[10.5px] leading-snug text-muted-foreground">
                        {result.warnings.map((warning, i) => (
                          <li key={i}>• {warning}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {result.circuit.wires.length > 0 && (
                    <CircuitWiringSection circuit={result.circuit} />
                  )}
                </div>
              </div>
            )}
          </TabsContent>

          {/* ============ C. DATASHEET ============ */}
          <TabsContent
            value="datasheet"
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <DatasheetPanel
              result={result}
              board={board}
              controller={controller}
              roomName={room?.name ?? null}
            />
          </TabsContent>
        </Tabs>

        {/* ---------- Footer ---------- */}
        <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-t bg-muted/20 px-3 sm:px-4">
          <p className="flex min-w-0 items-center gap-1.5 text-[9.5px] text-muted-foreground">
            <RiShieldCheckLine
              className="size-3.5 shrink-0 text-success"
              aria-hidden="true"
            />
            <span className="truncate">
              Logical assignment from configured records — not a physical
              inspection of wiring.
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {onEdit && (
              <Button type="button" variant="outline" size="sm" onClick={onEdit}>
                Edit configuration
              </Button>
            )}
            <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Unavailable state — verified connection data required
// ---------------------------------------------------------------------------
function UnavailablePanel({ reasons }: { reasons: string[] }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto p-6 text-center sm:p-10">
      <div
        className="flex size-12 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      >
        <RiErrorWarningLine className="size-6" />
      </div>
      <p className="text-sm font-semibold text-foreground">
        Connection information unavailable
      </p>
      <p className="max-w-md text-[11px] leading-relaxed text-muted-foreground">
        HomecoreOS could not verify the data needed to draw this wiring, so no
        pin assignments are shown. Nothing is assumed or invented.
      </p>
      <ul className="w-full max-w-md space-y-1.5 rounded-xl border bg-muted/30 p-3 text-left">
        {reasons.map((reason, i) => (
          <li
            key={i}
            className="flex items-start gap-2 text-[10.5px] leading-snug text-foreground/85"
          >
            <RiAlertLine
              className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
            <span>{reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diagram tab — inspector sidebar
// ---------------------------------------------------------------------------
function InspectorPanel({
  result,
  selectedId,
  onSelect,
  selectedConnection,
}: {
  result: WireDiagramResult;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  selectedConnection: WireDiagramResult["connections"][number] | null;
}) {
  const { totals } = result;
  const onboardOnly =
    result.connections.length > 0 &&
    result.connections.every((c) => c.placement === "onboard");

  return (
    <div className="space-y-4">
      {/* logical-assignment disclaimer */}
      <div className="flex items-start gap-2 rounded-xl border border-sky-500/25 bg-sky-500/5 p-2.5 text-[10px] leading-snug text-sky-900 dark:text-sky-200">
        <RiShieldCheckLine className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          <strong>Configured logical assignment.</strong> HomecoreOS has not
          measured or detected the physical wiring. Verify every connection
          with a multimeter before energizing loads.
        </span>
      </div>

      {onboardOnly && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-2.5 text-[10px] leading-snug text-amber-800 dark:text-amber-300">
          <RiAlertLine className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            This channel drives an <strong>on-board peripheral</strong> — no
            external wiring is required for the control leg.
          </span>
        </div>
      )}

      {/* selected connection detail */}
      {selectedConnection && (
        <div className="rounded-xl border p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              <span
                className="inline-block size-2.5 rounded-full"
                style={{ background: wireColor(selectedConnection) }}
                aria-hidden="true"
              />
              {selectedConnection.terminalLabel} · {selectedConnection.signal}
            </p>
            <button
              type="button"
              className="text-[10px] font-semibold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => onSelect(null)}
            >
              Clear
            </button>
          </div>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-foreground/85">
            {selectedConnection.detail}
          </p>
          {selectedConnection.sharedWith.length > 0 && (
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              Shared with:{" "}
              <span className="font-medium text-foreground/80">
                {selectedConnection.sharedWith.join(", ")}
              </span>
            </p>
          )}
        </div>
      )}

      {/* legend */}
      <div>
        <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          Legend
        </p>
        <div className="mt-1.5 grid grid-cols-2 gap-1">
          {[
            ["#fb923c", "GPIO signal"],
            ["#f472b6", "PWM output"],
            ["#a78bfa", "ADC input"],
            ["#38bdf8", "I2C SDA"],
            ["#fbbf24", "I2C SCL"],
            ["#34d399", "1-Wire data"],
            ["#22d3ee", "Control (logic)"],
            ["#f59e0b", "Power DC"],
            ["#cbd5e1", "GND reference"],
            ["#f87171", "MAINS Live"],
            ["#60a5fa", "MAINS Neutral"],
            ["#f87171", "Conflict / invalid"],
          ].map(([color, label]) => (
            <div
              key={label}
              className="flex items-center gap-1.5 rounded-md px-1 py-1 text-[10px] text-muted-foreground"
            >
              <span
                className="inline-block h-0.5 w-4 rounded-full"
                style={{ background: color }}
                aria-hidden="true"
              />
              {label}
            </div>
          ))}
        </div>
      </div>

      {/* connection list */}
      <div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
            Connections ({result.connections.length})
          </p>
          <div className="flex items-center gap-1.5 text-[9px] font-semibold">
            {totals.shared > 0 && (
              <span className="rounded-full bg-sky-500/10 px-1.5 py-0.5 text-sky-700 dark:text-sky-300">
                {totals.shared} shared
              </span>
            )}
            {totals.advisory > 0 && (
              <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
                {totals.advisory} advisory
              </span>
            )}
            {totals.invalid > 0 && (
              <span className="rounded-full bg-red-500/10 px-1.5 py-0.5 text-red-700 dark:text-red-300">
                {totals.invalid} invalid
              </span>
            )}
          </div>
        </div>
        <ul className="mt-1.5 space-y-1">
          {result.connections.map((conn) => {
            const isSelected = conn.id === selectedId;
            const endpoint =
              conn.pin !== null
                ? `GPIO${conn.pin}`
                : conn.placement === "extra_pad"
                  ? (conn.extraPadName ?? "PAD")
                  : conn.placement === "onboard"
                    ? "On-board"
                    : "—";
            const dash = wireDash(conn);
            return (
              <li key={conn.id}>
                <button
                  type="button"
                  data-nopan="true"
                  aria-pressed={isSelected}
                  onClick={() => onSelect(isSelected ? null : conn.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:bg-accent",
                    isSelected &&
                      "border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/10"
                  )}
                >
                  <svg width="18" height="4" className="shrink-0" aria-hidden="true">
                    <line
                      x1="0"
                      y1="2"
                      x2="18"
                      y2="2"
                      stroke={wireColor(conn)}
                      strokeWidth="2.6"
                      strokeLinecap="round"
                      strokeDasharray={dash === "2 5" ? "2 3" : dash}
                    />
                  </svg>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10.5px] font-medium leading-tight">
                      {conn.signal}
                      <span className="text-muted-foreground"> → </span>
                      {conn.terminalLabel}
                    </span>
                    <span className="mt-0.5 block font-mono text-[9px] leading-tight text-muted-foreground">
                      {endpoint}
                      {conn.headerName ? ` · ${conn.headerName} pin ${conn.headerPosition}` : ""}
                    </span>
                  </span>
                  {conn.kind !== "Configured (Logical)" && (
                    <Badge
                      variant={connectionStatus(conn.kind).badgeVariant}
                      className="shrink-0 px-1.5 py-0 text-[8px]"
                    >
                      {conn.kind === "Reference Rail"
                        ? "REF"
                        : conn.kind === "Advisory Warning"
                          ? "ADV"
                          : conn.kind === "Pin Conflict / Invalid"
                            ? "INVALID"
                            : "SHARED"}
                    </Badge>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* advisories */}
      {result.warnings.length > 0 && (
        <div>
          <p className="flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-400">
            <RiAlertLine className="size-3.5" aria-hidden="true" />
            Advisories ({result.warnings.length})
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {result.warnings.map((warning, i) => (
              <li
                key={i}
                className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 text-[10px] leading-snug text-muted-foreground"
              >
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connections tab — board pin cell
// ---------------------------------------------------------------------------
function BoardPinCell({
  conn,
}: {
  conn: WireDiagramResult["connections"][number];
}) {
  if (conn.placement === "header") {
    return (
      <div className="space-y-0.5">
        <p className="text-[11px] font-semibold leading-tight">
          {conn.headerName}
          <span className="text-muted-foreground"> · pin {conn.headerPosition}</span>
        </p>
        <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          {conn.side === "left" ? "Left" : "Right"} header
        </p>
      </div>
    );
  }
  if (conn.placement === "extra_pad") {
    return (
      <div className="space-y-0.5">
        <p className="text-[11px] font-semibold leading-tight">
          Back pad {conn.extraPadName}
        </p>
        <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          Not on headers
        </p>
      </div>
    );
  }
  if (conn.placement === "onboard") {
    return (
      <div className="space-y-0.5">
        <p className="text-[11px] font-semibold leading-tight">On-board</p>
        <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          {conn.onboardFeatureLabel ?? "Onboard peripheral"}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] font-semibold leading-tight text-muted-foreground">
        —
      </p>
      <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        Not drawn
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Datasheet tab
// ---------------------------------------------------------------------------
function DatasheetPanel({
  result,
  board,
  controller,
  roomName,
}: {
  result: WireDiagramResult;
  board: BoardProfileItem | null;
  controller: ControllerItem | null;
  roomName: string | null;
}) {
  const entity = result.entity;
  const boardFacts = result.board;

  const docs = [
    board?.docs_url ? { href: board.docs_url, label: "Official documentation" } : null,
    board?.datasheet_url
      ? { href: board.datasheet_url, label: "Controller datasheet (PDF)" }
      : null,
    board?.pinout_image_url
      ? { href: board.pinout_image_url, label: "Official pinout diagram" }
      : null,
    board?.source_url && board.source_url !== board?.docs_url
      ? { href: board.source_url, label: "Source / maker page" }
      : null,
  ].filter((r): r is { href: string; label: string } => r !== null);

  return (
    <div className="grid gap-4 p-4 xl:grid-cols-2">
      {/* Circuit design — device-specific electrical plan */}
      <div className="xl:col-span-2">
        <CircuitDesignPanel result={result} />
      </div>

      {/* Device / module */}
      <section className="rounded-xl border bg-card p-4">
        <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          <RiPlugLine className="size-4 text-primary" aria-hidden="true" />
          Device / module
        </h3>
        <dl className="mt-3 divide-y text-[11px]">
          <SpecRow label="Name" value={result.entityName} />
          <SpecRow
            label="Type"
            value={entity?.typeLabel ?? "Not documented"}
            capitalize
          />
          <SpecRow
            label="Manufacturer"
            value={entity?.manufacturer ?? "Not documented"}
            muted={!entity || entity.manufacturer === "Not documented"}
            note="HomecoreOS stores no manufacturer metadata for modules of this class."
          />
          <SpecRow
            label="Interface"
            value={entity?.interfaceLabel ?? "Not documented"}
          />
          <SpecRow
            label="Signal"
            value={entity?.signalLabel ?? "Not documented"}
          />
          <SpecRow
            label="Operating voltage"
            value={entity?.operatingVoltage ?? "Not documented"}
            muted={entity?.operatingVoltage === "Not documented"}
            note="No supply-voltage metadata exists for this module class in HomecoreOS — check the module datasheet."
          />
          <SpecRow
            label="Current requirement"
            value={entity?.currentDraw ?? "Not documented"}
            muted={entity?.currentDraw === "Not documented"}
          />
          {entity?.relayLogic && (
            <SpecRow label="Relay logic" value={entity.relayLogic} />
          )}
          <SpecRow
            label="Room"
            value={roomName ?? "Unassigned"}
          />
          <SpecRow
            label="Controller"
            value={
              controller
                ? `${controller.name}${controller.board_model ? ` · ${controller.board_model}` : ""}`
                : "Unknown controller"
            }
          />
          <SpecRow
            label="Entity status"
            value={
              result.entityOnline === null
                ? "Unknown"
                : result.entityOnline
                  ? "Online"
                  : "Offline"
            }
          />
        </dl>
      </section>

      {/* Terminal definitions */}
      <section className="rounded-xl border bg-card p-4">
        <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          <RiArrowLeftRightLine className="size-4 text-primary" aria-hidden="true" />
          Pin / terminal definitions
        </h3>
        <div className="mt-3 overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="pl-3">Terminal</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Function</TableHead>
                <TableHead>Draw</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(entity?.terminals ?? []).map((term) => (
                <TableRow key={term.id}>
                  <TableCell className="pl-3 font-mono text-[11px] font-bold">
                    {term.label}
                  </TableCell>
                  <TableCell className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {term.role}
                  </TableCell>
                  <TableCell className="max-w-56 text-[10.5px] leading-snug">
                    {term.function}
                  </TableCell>
                  <TableCell>
                    {term.drawn ? (
                      <Badge variant="success-outline" className="gap-1">
                        <RiCheckboxCircleLine className="size-3" aria-hidden="true" />
                        Wired
                      </Badge>
                    ) : (
                      <Badge variant="secondary">Not drawn</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="mt-2 text-[9.5px] leading-snug text-muted-foreground">
          Terminal names describe the module class, not a vendor-specific pinout.
          Supply (VCC) legs are advisory only — the correct rail depends on the
          module datasheet.
        </p>
      </section>

      {/* Sensor driver facts (sensors) / actuator note (switches, devices) */}
      {entity?.driver ? (
        <section className="rounded-xl border bg-card p-4">
          <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
            <RiSensorLine className="size-4 text-primary" aria-hidden="true" />
            Sensor driver electrical profile
          </h3>
          <dl className="mt-3 divide-y text-[11px]">
            <SpecRow
              label="Driver"
              value={`${entity.driver.driverDisplayName}${entity.driver.driverVersion ? ` · v${entity.driver.driverVersion}` : ""}`}
            />
            <SpecRow label="Driver ID" value={entity.driver.driverId} mono />
            <SpecRow label="Interface" value={entity.driver.interfaceLabel} />
            <SpecRow
              label="Driver verification"
              value={formatVerification(
                entity.driver.hardwareVerificationStatus
              )}
              muted={entity.driver.hardwareVerificationStatus !== "verified"}
              note={
                entity.driver.hardwareVerificationStatus !== "verified"
                  ? "Driver implemented but not yet hardware-verified by HomecoreOS."
                  : undefined
              }
            />
            <SpecRow
              label="Measurements"
              value={
                entity.driver.measurements.length > 0
                  ? entity.driver.measurements.join(", ")
                  : "Not documented"
              }
            />
            <SpecRow
              label="Supported models"
              value={
                entity.driver.supportedModels.length > 0
                  ? entity.driver.supportedModels.join(", ")
                  : "Not documented"
              }
            />
            <SpecRow
              label="Default unit"
              value={entity.driver.defaultUnit ?? "Not documented"}
            />
            <SpecRow
              label="Configured I2C address"
              value={entity.driver.i2cAddress ?? "Not set (bus default)"}
              mono={Boolean(entity.driver.i2cAddress)}
            />
            <SpecRow
              label="Default I2C addresses"
              value={
                entity.driver.defaultI2cAddresses.length > 0
                  ? entity.driver.defaultI2cAddresses.join(", ")
                  : "Not documented"
              }
              mono={entity.driver.defaultI2cAddresses.length > 0}
            />
            <SpecRow
              label="Pull-ups required"
              value={entity.driver.requiresPullUp ? "Yes — enable I2C pull-ups" : "No"}
            />
            <SpecRow
              label="Min read interval"
              value={
                entity.driver.minIntervalMs !== null
                  ? `${entity.driver.minIntervalMs} ms`
                  : "Not documented"
              }
            />
            <SpecRow
              label="Samples per read"
              value={
                entity.driver.samplesPerRead !== null
                  ? String(entity.driver.samplesPerRead)
                  : "Not documented"
              }
            />
          </dl>
        </section>
      ) : (
        <section className="rounded-xl border bg-card p-4">
          <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
            <RiFlashlightLine className="size-4 text-primary" aria-hidden="true" />
            Electrical behaviour
          </h3>
          <dl className="mt-3 divide-y text-[11px]">
            {entity?.relayLogic && (
              <SpecRow label="Relay logic" value={entity.relayLogic} />
            )}
            <SpecRow
              label="Drive type"
              value={
                result.entityKind === "switch"
                  ? "GPIO push-pull output stage (relay / load driver)"
                  : "GPIO output stage"
              }
            />
            <SpecRow
              label="Operating voltage"
              value={entity?.operatingVoltage ?? "Not documented"}
              muted
            />
            <SpecRow
              label="Current requirement"
              value={entity?.currentDraw ?? "Not documented"}
              muted
            />
          </dl>
          <p className="mt-2 text-[9.5px] leading-snug text-muted-foreground">
            Module-level electrical ratings (contact rating, coil current, load
            type) are not documented in HomecoreOS and must come from the
            module datasheet. Mains wiring is outside the scope of the
            controller&apos;s low-voltage domain.
          </p>
        </section>
      )}

      {/* Board & documentation */}
      <section className="rounded-xl border bg-card p-4">
        <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          <RiCpuLine className="size-4 text-primary" aria-hidden="true" />
          Controller board &amp; documentation
        </h3>
        {boardFacts ? (
          <>
            <dl className="mt-3 divide-y text-[11px]">
              <SpecRow label="Board" value={boardFacts.name} />
              <SpecRow label="Chip" value={boardFacts.chipLabel} />
              <SpecRow label="Processor" value={boardFacts.processor} />
              <SpecRow label="Wireless" value={boardFacts.wireless} />
              <SpecRow label="Memory" value={boardFacts.memory} />
              <SpecRow label="USB" value={boardFacts.usb} />
              {boardFacts.usbId && (
                <SpecRow label="USB ID" value={boardFacts.usbId} mono />
              )}
              <SpecRow label="Revision" value={boardFacts.revision} />
              <SpecRow
                label="Verification"
                value={formatVerification(boardFacts.verificationStatus)}
                muted={boardFacts.verificationStatus !== "verified"}
              />
              <SpecRow
                label="Layout documented"
                value={boardFacts.layoutDocumented ? "Yes" : "No — synthesized rails"}
              />
              <SpecRow
                label="GND rail documented"
                value={boardFacts.groundRailDocumented ? "Yes" : "No"}
              />
              <SpecRow
                label="Power rails"
                value={
                  boardFacts.powerRails.length > 0
                    ? boardFacts.powerRails.join(", ")
                    : "Not documented"
                }
              />
              <SpecRow
                label="On-board peripherals"
                value={
                  boardFacts.onboardFeatures.length > 0
                    ? boardFacts.onboardFeatures
                        .map((f) =>
                          f.gpioPin !== null
                            ? `${f.label} (GPIO${f.gpioPin})`
                            : f.label
                        )
                        .join(", ")
                    : "None documented"
                }
              />
            </dl>
            <div className="mt-3 border-t pt-3">
              <p className="flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                <RiBookOpenLine className="size-3.5" aria-hidden="true" />
                Official documentation
              </p>
              {docs.length > 0 ? (
                <ul className="mt-1.5 space-y-1">
                  {docs.map((link) => (
                    <li key={link.href}>
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1.5 text-[11px] font-medium text-primary underline-offset-2 hover:underline"
                      >
                        <RiExternalLinkLine className="size-3.5 shrink-0" aria-hidden="true" />
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
                  No datasheet or documentation link is recorded for this board
                  in HomecoreOS. Consult the module manufacturer&apos;s website
                  with the exact model number{" "}
                  {board ? (
                    <span className="font-mono font-semibold text-foreground/80">
                      {board.manufacturer} {board.model}
                    </span>
                  ) : null}
                  .
                </p>
              )}
              <p className="mt-2 text-[9px] leading-snug text-muted-foreground/80">
                Electrical specifications above are reported exactly as recorded
                in the Board Library profile and the driver registry. HomecoreOS
                does not invent electrical characteristics.
              </p>
            </div>
          </>
        ) : (
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            No controller board profile could be resolved for this entity, so
            board-level specifications are unavailable.
          </p>
        )}
      </section>
    </div>
  );
}

function SpecRow({
  label,
  value,
  muted = false,
  mono = false,
  capitalize = false,
  note,
}: {
  label: string;
  value: string;
  muted?: boolean;
  mono?: boolean;
  capitalize?: boolean;
  note?: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)] items-baseline gap-3 py-1.5">
      <dt className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "text-[11px] leading-snug",
          muted ? "italic text-muted-foreground" : "font-medium text-foreground",
          mono && "font-mono text-[10.5px]",
          capitalize && "capitalize"
        )}
      >
        {value}
        {note && (
          <span className="mt-0.5 block text-[9px] font-normal normal-case italic leading-snug text-muted-foreground/80">
            {note}
          </span>
        )}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Circuit design — safety badge, wiring table, datasheet section
// ---------------------------------------------------------------------------
type Circuit = WireDiagramResult["circuit"];

const SAFETY_BADGE: Record<
  Circuit["safetyClass"],
  { label: string; className: string }
> = {
  mains_ac: {
    label: "MAINS AC",
    className:
      "border-red-500/50 bg-red-500/15 text-red-700 dark:text-red-300",
  },
  low_voltage_dc: {
    label: "LOW-VOLTAGE DC",
    className:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  mixed: {
    label: "MIXED DC + MAINS",
    className:
      "border-amber-500/50 bg-amber-500/15 text-amber-800 dark:text-amber-300",
  },
  unknown: {
    label: "UNVERIFIED",
    className: "border-border bg-muted text-muted-foreground",
  },
};

function CircuitSafetyBadge({ circuit }: { circuit: Circuit }) {
  const cfg = SAFETY_BADGE[circuit.safetyClass];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.14em]",
        cfg.className
      )}
      title={
        circuit.mainsInvolved
          ? "This circuit involves mains AC on the load side — qualified installer required."
          : "This circuit is entirely low-voltage DC."
      }
    >
      {circuit.mainsInvolved && (
        <RiAlertLine className="size-3" aria-hidden="true" />
      )}
      {cfg.label}
    </span>
  );
}

function CircuitDomainBadge({ wire }: { wire: CircuitWire }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.12em]",
        wire.domain === "load"
          ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
          : "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
      )}
    >
      {wire.domain === "load" ? "Load side" : "Control side"}
    </span>
  );
}

function CircuitWiringSection({ circuit }: { circuit: Circuit }) {
  const control = circuit.wires.filter((w) => w.domain === "control");
  const load = circuit.wires.filter((w) => w.domain === "load");
  const groups: Array<{ title: string; wires: CircuitWire[] }> = [
    { title: "Control-side wiring (logic domain)", wires: control },
    { title: "Load-side wiring (power domain)", wires: load },
  ].filter((g) => g.wires.length > 0);

  return (
    <section className="border-t">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <p className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-foreground/80">
          <RiShieldKeyholeLine className="size-4 text-primary" aria-hidden="true" />
          Circuit wiring — device-specific plan ({circuit.wires.length})
        </p>
        <p className="mt-1 text-[9.5px] leading-snug text-muted-foreground">
          Synthesized for this device class. Values and ratings that are not
          documented in HomecoreOS are shown as guidance or explicitly left
          unknown — never invented. Verify with the module datasheet before
          energizing.
        </p>
      </div>
      {groups.map((group) => (
        <div key={group.title}>
          <p className="px-4 pt-2.5 text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            {group.title}
          </p>
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Wire</TableHead>
                <TableHead>Carries</TableHead>
                <TableHead>Domain</TableHead>
                <TableHead>Facts</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.wires.map((wire) => (
                <TableRow key={wire.id} className="align-top">
                  <TableCell className="pl-4">
                    <span className="flex items-center gap-2 font-mono text-[11px] font-bold">
                      <span
                        className="inline-block h-0.5 w-5 rounded-full"
                        style={{ background: circuitWireColor(wire.kind) }}
                        aria-hidden="true"
                      />
                      {wire.label}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-md">
                    <span className="text-[10.5px] leading-snug text-foreground/85">
                      {wire.description}
                    </span>
                    {wire.warnings?.map((w, i) => (
                      <span
                        key={i}
                        className="mt-0.5 block text-[9px] leading-snug text-red-600 dark:text-red-400"
                      >
                        ⚠ {w}
                      </span>
                    ))}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <CircuitDomainBadge wire={wire} />
                      <span className="text-[8px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {CIRCUIT_WIRE_LABELS[wire.kind]}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {wire.documented ? (
                      <Badge variant="success-light" className="text-[8.5px]">
                        Documented
                      </Badge>
                    ) : (
                      <Badge variant="warning-outline" className="text-[8.5px]">
                        Guidance
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </section>
  );
}

function checkIcon(status: Circuit["checks"][number]["status"]) {
  switch (status) {
    case "pass":
      return (
        <RiCheckboxCircleLine
          className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
      );
    case "warn":
      return (
        <RiAlertLine
          className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
      );
    case "fail":
      return (
        <RiErrorWarningLine
          className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400"
          aria-hidden="true"
        />
      );
    default:
      return (
        <RiInformationLine
          className="mt-0.5 size-4 shrink-0 text-slate-500 dark:text-slate-400"
          aria-hidden="true"
        />
      );
  }
}

const VALUE_STATUS_LABEL: Record<string, string> = {
  guidance: "Typical value",
  formula: "Computed",
  not_documented: "Not documented",
};

function CircuitDesignPanel({ result }: { result: WireDiagramResult }) {
  const circuit = result.circuit;
  if (circuit.state === "unavailable") {
    return null;
  }
  return (
    <section className="rounded-xl border border-primary/25 bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          <RiShieldKeyholeLine className="size-4 text-primary" aria-hidden="true" />
          Circuit design — {circuit.archetypeLabel}
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <CircuitSafetyBadge circuit={circuit} />
          {circuit.isolatedFromLoad && (
            <Badge variant="success-light" className="text-[8.5px] uppercase tracking-wide">
              Isolated from load
            </Badge>
          )}
          {circuit.externalSupplyRequired && (
            <Badge variant="warning-outline" className="text-[8.5px] uppercase tracking-wide">
              External supply required
            </Badge>
          )}
        </div>
      </div>

      {/* why this circuit */}
      <div className="mt-3">
        <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          Why this circuit
        </p>
        <ul className="mt-1 space-y-0.5 text-[10.5px] leading-snug text-foreground/85">
          {circuit.reasoning.map((line, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-primary">•</span>
              {line}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        {/* required components */}
        <div>
          <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
            Required components ({circuit.components.length})
          </p>
          {circuit.components.length === 0 ? (
            <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground">
              No additional components — a direct connection is sufficient for
              this device class.
            </p>
          ) : (
            <ul className="mt-1.5 space-y-1.5">
              {circuit.components.map((component) => (
                <li
                  key={component.id}
                  className="flex items-start gap-2 rounded-lg border bg-muted/20 p-1.5"
                >
                  <span
                    className="size-12 shrink-0 rounded-md border bg-[#0f172a] p-0.5"
                    aria-hidden="true"
                  >
                    <DeviceIllustration name={component.illustration ?? "appliance"} />
                  </span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10.5px] font-semibold leading-tight">
                        {component.label}
                      </span>
                      <Badge
                        variant={
                          component.certainty === "required"
                            ? "info-outline"
                            : "warning-outline"
                        }
                        className="px-1 py-0 text-[7.5px] uppercase tracking-wide"
                      >
                        {component.certainty === "required" ? "Required" : "If your module needs it"}
                      </Badge>
                    </span>
                    <span className="mt-0.5 block text-[9.5px] leading-snug text-muted-foreground">
                      {component.value ? (
                        <>
                          <span className="font-mono font-semibold text-foreground/80">
                            {component.value}
                          </span>{" "}
                          <span className="italic">
                            ({VALUE_STATUS_LABEL[component.valueStatus]})
                          </span>
                        </>
                      ) : (
                        <span className="italic">Value not documented</span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[8.5px] leading-snug text-muted-foreground/80">
                      {component.role}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* safety checks */}
        <div>
          <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
            Safety &amp; compatibility checks
          </p>
          <ul className="mt-1.5 space-y-1">
            {circuit.checks.map((check) => (
              <li
                key={check.id}
                className="flex items-start gap-1.5 rounded-lg border bg-muted/20 px-2 py-1.5"
              >
                {checkIcon(check.status)}
                <span className="min-w-0">
                  <span className="block text-[9.5px] font-semibold leading-snug">
                    {check.title}
                  </span>
                  <span className="mt-0.5 block text-[8.5px] leading-snug text-muted-foreground">
                    {check.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* assumptions + missing specifications */}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {circuit.assumptions.length > 0 && (
          <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-2.5">
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-sky-700 dark:text-sky-300">
              Assumptions you must confirm
            </p>
            <ul className="mt-1 space-y-0.5 text-[9px] leading-snug text-muted-foreground">
              {circuit.assumptions.map((a, i) => (
                <li key={i}>• {a}</li>
              ))}
            </ul>
          </div>
        )}
        {circuit.missingSpecifications.length > 0 && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5">
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
              Not documented — verify on the device
            </p>
            <ul className="mt-1 space-y-0.5 text-[9px] leading-snug text-muted-foreground">
              {circuit.missingSpecifications.map((m, i) => (
                <li key={i}>• {m}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {circuit.formulas.length > 0 && (
        <div className="mt-3">
          <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
            Formulas
          </p>
          <div className="mt-1 space-y-1">
            {circuit.formulas.map((f, i) => (
              <div
                key={i}
                className="rounded-lg border bg-muted/30 px-2.5 py-1.5"
              >
                <p className="text-[9px] font-semibold text-foreground/80">
                  {f.title}
                </p>
                <code className="mt-0.5 block whitespace-pre-wrap font-mono text-[9px] text-muted-foreground">
                  {f.body}
                </code>
              </div>
            ))}
          </div>
        </div>
      )}

      {circuit.notes.length > 0 && (
        <ul className="mt-3 space-y-1 border-t pt-2 text-[9.5px] leading-snug text-muted-foreground">
          {circuit.notes.map((note, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-primary">•</span>
              {note}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
