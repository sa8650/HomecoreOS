import { useMemo, useState } from "react";
import {
  resolveBoardHardwareSpecs,
  type BoardHeaderPin,
  type GpioPinDefinition,
} from "@homecoreos/shared";
import {
  RiAlertLine,
  RiFlashlightLine,
  RiInformationLine,
  RiLockLine,
  RiSearchLine,
  RiShieldCheckLine,
} from "@remixicon/react";
import {
  BoardVectorSvg,
  getVectorVerticalPinPercents,
  resolveBoardPinRails,
} from "@/components/boards/BoardVectorSvg";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { BoardProfileItem } from "@/features/types";

type PinFilter =
  | "all"
  | "safe_gpio"
  | "adc"
  | "pwm"
  | "bus"
  | "touch"
  | "reserved"
  | "power";

function classifyPin(
  hp: BoardHeaderPin | null,
  def: GpioPinDefinition | undefined,
  usedPins: Set<number>
): {
  tone: "safe" | "warning" | "shared" | "blocked" | "input" | "power" | "ground" | "reset" | "nc";
  tag: string;
  reason?: string;
} {
  if (hp) {
    if (hp.kind === "power") return { tone: "power", tag: hp.voltage || "PWR", reason: hp.note };
    if (hp.kind === "ground") return { tone: "ground", tag: "GND", reason: hp.note };
    if (hp.kind === "reset") return { tone: "reset", tag: "RST", reason: hp.note };
    if (hp.kind === "nc") return { tone: "nc", tag: "NC", reason: "No connect" };
  }

  if (!def) {
    return { tone: "nc", tag: "GPIO", reason: hp?.note };
  }

  if (def.restrictions.flash_psram_conflict || def.restrictions.reserved) {
    return {
      tone: "blocked",
      tag: def.restrictions.flash_psram_conflict ? "BUS" : "RSVD",
      reason: def.restrictions.reserved_reason || hp?.note || "Reserved hardware pin",
    };
  }
  if (usedPins.has(def.pin)) {
    return { tone: "blocked", tag: "USED", reason: "Already assigned on controller" };
  }
  if (def.restrictions.input_only) {
    return { tone: "input", tag: "IN", reason: "Input-only GPIO (no digital output/PWM)" };
  }
  if (def.restrictions.strapping_pin) {
    return {
      tone: "warning",
      tag: "STRAP",
      reason: def.restrictions.strapping_note || "Boot strapping pin",
    };
  }
  if (def.restrictions.usb_jtag_conflict || (hp?.note && /led|rgb|uart/i.test(hp.note))) {
    return {
      tone: "shared",
      tag: def.restrictions.usb_jtag_conflict ? "USB" : "IO",
      reason: hp?.note || "Shared with onboard peripheral",
    };
  }
  return { tone: "safe", tag: `GPIO${def.pin}` };
}

function matchesPinFilter(
  filter: PinFilter,
  hp: BoardHeaderPin | null,
  def: GpioPinDefinition | undefined,
  search: string
): boolean {
  const q = search.trim().toLowerCase();
  if (q) {
    const hay = [
      hp?.pinName,
      hp?.note,
      ...(hp?.aliases ?? []),
      def ? `gpio${def.pin}` : "",
      def ? String(def.pin) : "",
      def?.label,
      def?.board_note,
      def?.restrictions.reserved_reason,
      def?.restrictions.strapping_note,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }

  if (filter === "all") return true;
  if (filter === "power") {
    return hp ? hp.kind === "power" || hp.kind === "ground" || hp.kind === "reset" : false;
  }
  if (!def) return false;
  if (filter === "safe_gpio") {
    return (
      !def.restrictions.reserved &&
      !def.restrictions.flash_psram_conflict &&
      !def.restrictions.input_only &&
      def.capabilities.digital_out
    );
  }
  if (filter === "adc") return def.capabilities.adc;
  if (filter === "pwm") return def.capabilities.pwm;
  if (filter === "bus") return def.capabilities.i2c || def.capabilities.spi || def.capabilities.uart;
  if (filter === "touch") return def.capabilities.touch;
  if (filter === "reserved") {
    return (
      def.restrictions.reserved ||
      def.restrictions.flash_psram_conflict ||
      def.restrictions.strapping_pin ||
      def.restrictions.input_only
    );
  }
  return true;
}

const TONE_CLASSES: Record<string, string> = {
  safe: "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20",
  shared: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300 hover:bg-sky-500/20",
  blocked: "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300 hover:bg-rose-500/20",
  input: "border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300 hover:bg-violet-500/20",
  power: "border-orange-500/35 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  ground: "border-border bg-muted/70 text-muted-foreground",
  reset: "border-indigo-500/35 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
  nc: "border-border/60 bg-muted/40 text-muted-foreground/70",
};

const DOT_CLASSES: Record<string, string> = {
  safe: "bg-emerald-500",
  warning: "bg-amber-500",
  shared: "bg-sky-500",
  blocked: "bg-rose-500",
  input: "bg-violet-500",
  power: "bg-orange-500",
  ground: "bg-slate-400",
  reset: "bg-indigo-500",
  nc: "bg-slate-300",
};

export function InteractiveBoardPinout({
  board,
  usedPins = [],
  selectedPin = null,
  onSelectPin,
}: {
  board: BoardProfileItem;
  usedPins?: number[];
  selectedPin?: number | null;
  onSelectPin?: (pin: number) => void;
}) {
  const layout = board.board_layout;
  const rails = useMemo(() => resolveBoardPinRails(board), [board]);
  const specs = useMemo(() => resolveBoardHardwareSpecs(board), [board]);
  const pinPercents = useMemo(() => getVectorVerticalPinPercents(board), [board]);
  const hasDiagram = rails.left.length > 0 || rails.right.length > 0;

  const [filter, setFilter] = useState<PinFilter>("all");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"diagram" | "table">(
    hasDiagram ? "diagram" : "table"
  );
  const [inspected, setInspected] = useState<{
    headerPin: BoardHeaderPin | null;
    gpio: GpioPinDefinition | null;
  } | null>(() => {
    const initialDef =
      selectedPin !== null
        ? board.gpio_definitions.find((g) => g.pin === selectedPin) ?? null
        : board.gpio_definitions.find(
            (g) =>
              !g.restrictions.reserved &&
              !g.restrictions.flash_psram_conflict &&
              g.capabilities.digital_out
          ) ??
          board.gpio_definitions[0] ??
          null;
    if (!initialDef) return null;
    const matchHeader =
      rails.left.find((p) => p.gpioPin === initialDef.pin) ??
      rails.right.find((p) => p.gpioPin === initialDef.pin) ??
      null;
    return { headerPin: matchHeader, gpio: initialDef };
  });

  const usedSet = useMemo(() => new Set(usedPins), [usedPins]);
  const gpioByPin = useMemo(
    () => new Map(board.gpio_definitions.map((g) => [g.pin, g])),
    [board.gpio_definitions]
  );

  const handleInspect = (hp: BoardHeaderPin | null, gpio: GpioPinDefinition | null) => {
    setInspected({ headerPin: hp, gpio });
    if (onSelectPin && gpio && !gpio.restrictions.reserved && !gpio.restrictions.flash_psram_conflict) {
      onSelectPin(gpio.pin);
    }
  };

  const renderPinButton = (hp: BoardHeaderPin, side: "left" | "right") => {
    const def = hp.gpioPin !== null ? gpioByPin.get(hp.gpioPin) : undefined;
    const cls = classifyPin(hp, def, usedSet);
    const matches = matchesPinFilter(filter, hp, def, search);
    const isActive =
      (selectedPin !== null && hp.gpioPin === selectedPin) ||
      (inspected?.headerPin?.headerName === hp.headerName &&
        inspected?.headerPin?.position === hp.position) ||
      (hp.gpioPin !== null && inspected?.gpio?.pin === hp.gpioPin);

    return (
      <button
        key={`${side}-${hp.headerName}-${hp.position}`}
        type="button"
        onClick={() => handleInspect(hp, def ?? null)}
        onMouseEnter={() => setInspected({ headerPin: hp, gpio: def ?? null })}
        data-testid={`pin-${side}-${hp.position}`}
        className={cn(
          "group flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-tight transition-all",
          side === "left" ? "flex-row-reverse text-right" : "flex-row text-left",
          TONE_CLASSES[cls.tone],
          isActive && "ring-1.5 ring-primary ring-offset-1 ring-offset-background shadow-xs",
          !matches && "opacity-25"
        )}
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASSES[cls.tone])} />
        <span className="font-mono font-semibold truncate">{hp.pinName}</span>
        {hp.gpioPin !== null && hp.pinName !== String(hp.gpioPin) && (
          <span className="text-[9px] opacity-75 font-mono">G{hp.gpioPin}</span>
        )}
      </button>
    );
  };

  const activeGpio = inspected?.gpio ?? null;
  const activeHeader = inspected?.headerPin ?? null;
  const activeClass = classifyPin(activeHeader, activeGpio ?? undefined, usedSet);

  return (
    <div className="space-y-2.5">
      {/* Compact Filter + Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 rounded-lg border border-border bg-muted/30 p-1.5">
        <div className="flex flex-wrap items-center gap-0.5">
          {(
            [
              ["all", "All"],
              ["safe_gpio", "Safe"],
              ["adc", "ADC"],
              ["pwm", "PWM"],
              ["bus", "I2C/SPI"],
              ["touch", "Touch"],
              ["reserved", "Caution"],
              ["power", "Power"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                filter === id
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <div className="relative w-36">
            <RiSearchLine className="pointer-events-none absolute left-2 top-1.5 size-3 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find GPIO / SDA..."
              className="h-6.5 pl-6.5 text-[11px]"
            />
          </div>
          {hasDiagram && (
            <div className="flex rounded border border-border bg-background p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setViewMode("diagram")}
                className={cn(
                  "rounded px-1.5 py-0.5 font-medium",
                  viewMode === "diagram" ? "bg-muted text-foreground" : "text-muted-foreground"
                )}
              >
                Diagram
              </button>
              <button
                type="button"
                onClick={() => setViewMode("table")}
                className={cn(
                  "rounded px-1.5 py-0.5 font-medium",
                  viewMode === "table" ? "bg-muted text-foreground" : "text-muted-foreground"
                )}
              >
                Table
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Compact Hardware Specs + Legend Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/75 bg-muted/20 px-2.5 py-1.5 text-[10px]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span>
            <span className="text-muted-foreground">CPU: </span>
            <strong className="text-foreground">{specs.processor}</strong>
          </span>
          <span>
            <span className="text-muted-foreground">Mem: </span>
            <strong className="text-amber-500 dark:text-amber-400">{specs.memory}</strong>
          </span>
          <span>
            <span className="text-muted-foreground">RF: </span>
            <strong className="text-foreground">{specs.wireless}</strong>
          </span>
          <span>
            <span className="text-muted-foreground">USB: </span>
            <strong className="text-foreground">{specs.usb}</strong>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-emerald-500" /> Safe
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-amber-500" /> Strap
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-sky-500" /> Shared
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-violet-500" /> In-Only
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-rose-500" /> Reserved
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-orange-500" /> Power
          </span>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_248px]">
        {/* Main Pinout Canvas or Table */}
        {viewMode === "diagram" && hasDiagram ? (
          <div className="rounded-lg border border-border bg-card p-2.5 shadow-xs">
            <div className="mx-auto grid max-w-[540px] grid-cols-[minmax(88px,1fr)_175px_minmax(88px,1fr)] items-stretch gap-1.5">
              {/* Left Rail Header */}
              <div className="flex flex-col justify-between">
                <div className="mb-0.5 text-right text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {rails.leftName}
                </div>
                <div
                  className="flex flex-1 flex-col justify-between gap-0.5"
                  style={{
                    paddingTop: `${Math.max(0, pinPercents.pinTopPct - 4)}%`,
                    paddingBottom: `${Math.max(0, 100 - pinPercents.pinBottomPct - 4)}%`,
                  }}
                >
                  {rails.left.map((hp) => renderPinButton(hp, "left"))}
                </div>
              </div>

              {/* Center Interactive Vector SVG PCB */}
              <div className="relative flex flex-col items-center justify-center rounded-lg border border-border/70 bg-[#0b0e12] px-1.5 py-2">
                <div className="mb-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-400">
                  {layout?.usbEdge === "top"
                    ? layout.usbLabel ?? "USB-C"
                    : layout?.antennaLabel ?? "PCB Antenna"}
                </div>
                <BoardVectorSvg
                  board={board}
                  orientation="vertical"
                  className="w-full max-h-[360px]"
                  usedPins={usedSet}
                  selectedPin={selectedPin}
                  activeHeaderPin={inspected?.headerPin ?? null}
                  pinDimmed={(hp) => {
                    const def = hp.gpioPin !== null ? gpioByPin.get(hp.gpioPin) : undefined;
                    return !matchesPinFilter(filter, hp, def, search);
                  }}
                  onPinClick={(hp) => {
                    const def = hp.gpioPin !== null ? gpioByPin.get(hp.gpioPin) ?? null : null;
                    handleInspect(hp, def);
                  }}
                  onPinHover={(hp) => {
                    if (!hp) return;
                    const def = hp.gpioPin !== null ? gpioByPin.get(hp.gpioPin) ?? null : null;
                    setInspected({ headerPin: hp, gpio: def });
                  }}
                />
                <div className="mt-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-400">
                  {layout?.usbEdge === "bottom"
                    ? layout.usbLabel ?? specs.usb
                    : layout?.antennaLabel ?? "U.FL / B2B"}
                </div>
              </div>

              {/* Right Rail Header */}
              <div className="flex flex-col justify-between">
                <div className="mb-0.5 text-left text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {rails.rightName}
                </div>
                <div
                  className="flex flex-1 flex-col justify-between gap-0.5"
                  style={{
                    paddingTop: `${Math.max(0, pinPercents.pinTopPct - 4)}%`,
                    paddingBottom: `${Math.max(0, 100 - pinPercents.pinBottomPct - 4)}%`,
                  }}
                >
                  {rails.right.map((hp) => renderPinButton(hp, "right"))}
                </div>
              </div>
            </div>

            {layout?.onboardFeatures && layout.onboardFeatures.length > 0 && (
              <div className="mt-2.5 flex flex-wrap items-center gap-1 border-t border-border pt-2">
                <span className="text-[10px] font-medium text-muted-foreground mr-0.5">
                  Onboard:
                </span>
                {layout.onboardFeatures.map((feat, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      if (feat.gpioPin !== null) {
                        const def = gpioByPin.get(feat.gpioPin) ?? null;
                        const hp =
                          rails.left.find((p) => p.gpioPin === feat.gpioPin) ??
                          rails.right.find((p) => p.gpioPin === feat.gpioPin) ??
                          null;
                        setInspected({ headerPin: hp, gpio: def });
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] hover:bg-muted"
                  >
                    <RiFlashlightLine className="size-2.5 text-primary" />
                    <span className="font-medium">{feat.label}</span>
                    {feat.gpioPin !== null && (
                      <span className="font-mono text-[9px] text-muted-foreground">
                        G{feat.gpioPin}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="max-h-[380px] overflow-auto rounded-lg border border-border bg-card p-2">
            <div className="grid gap-1 sm:grid-cols-2">
              {board.gpio_definitions
                .filter((g) => matchesPinFilter(filter, null, g, search))
                .map((g) => {
                  const cls = classifyPin(null, g, usedSet);
                  return (
                    <button
                      key={g.pin}
                      type="button"
                      onClick={() => handleInspect(null, g)}
                      className={cn(
                        "flex items-center justify-between rounded border px-2 py-1.5 text-left text-[11px] transition-all",
                        TONE_CLASSES[cls.tone],
                        selectedPin === g.pin && "ring-1.5 ring-primary"
                      )}
                    >
                      <div>
                        <div className="font-mono font-semibold">{g.label}</div>
                        <div className="text-[9px] opacity-75">
                          {[
                            g.capabilities.digital_out && "OUT",
                            g.capabilities.digital_in && "IN",
                            g.capabilities.adc && "ADC",
                            g.capabilities.pwm && "PWM",
                            g.capabilities.i2c && "I2C",
                            g.capabilities.touch && "TOUCH",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                      <span className="text-[9px] font-mono uppercase">{cls.tag}</span>
                    </button>
                  );
                })}
            </div>
          </div>
        )}

        {/* Compact Pin Dossier Inspector */}
        <div className="rounded-lg border border-border bg-card p-3 shadow-xs space-y-2 h-fit text-[11px]">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Pin Inspector
              </div>
              <h4 className="text-sm font-semibold font-mono mt-0.5">
                {activeGpio
                  ? `GPIO ${activeGpio.pin}`
                  : activeHeader
                    ? activeHeader.pinName
                    : "Select a pin"}
              </h4>
              {activeHeader && (
                <div className="text-[10px] text-muted-foreground">
                  {activeHeader.headerName} · Pin {activeHeader.position}
                  {activeHeader.pinName !== String(activeGpio?.pin ?? "") && (
                    <span> · Pad “{activeHeader.pinName}”</span>
                  )}
                </div>
              )}
            </div>
            <Badge
              variant={
                activeClass.tone === "safe"
                  ? "success-light"
                  : activeClass.tone === "blocked"
                    ? "destructive-light"
                    : activeClass.tone === "warning"
                      ? "warning-light"
                      : "secondary"
              }
              size="xs"
            >
              {activeClass.tag}
            </Badge>
          </div>

          {activeHeader?.aliases && activeHeader.aliases.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {activeHeader.aliases.map((a) => (
                <Badge key={a} variant="outline" size="xs" className="font-mono text-[9px]">
                  {a}
                </Badge>
              ))}
            </div>
          )}

          {(activeClass.reason || activeGpio?.board_note) && (
            <div
              className={cn(
                "flex items-start gap-1.5 rounded border px-2 py-1.5 text-[10px] leading-snug",
                activeClass.tone === "blocked"
                  ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                  : activeClass.tone === "warning"
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    : "border-border bg-muted/40 text-foreground"
              )}
            >
              {activeClass.tone === "blocked" ? (
                <RiLockLine className="size-3.5 shrink-0 mt-0.5" />
              ) : activeClass.tone === "warning" ? (
                <RiAlertLine className="size-3.5 shrink-0 mt-0.5" />
              ) : (
                <RiInformationLine className="size-3.5 shrink-0 mt-0.5 text-primary" />
              )}
              <span>{activeClass.reason || activeGpio?.board_note}</span>
            </div>
          )}

          {activeGpio ? (
            <>
              <div className="space-y-1">
                <div className="text-[10px] font-medium text-muted-foreground">
                  Capabilities
                </div>
                <div className="grid grid-cols-2 gap-1 text-[10px]">
                  {(
                    [
                      ["Digital Out", activeGpio.capabilities.digital_out],
                      ["Digital In", activeGpio.capabilities.digital_in],
                      ["PWM", activeGpio.capabilities.pwm],
                      ["ADC", activeGpio.capabilities.adc],
                      ["I2C Bus", activeGpio.capabilities.i2c],
                      ["SPI Bus", activeGpio.capabilities.spi],
                      ["UART", activeGpio.capabilities.uart],
                      ["Touch", activeGpio.capabilities.touch],
                      ["Pull-Up", activeGpio.capabilities.pull_up],
                      ["Pull-Down", activeGpio.capabilities.pull_down],
                    ] as const
                  ).map(([name, ok]) => (
                    <div
                      key={name}
                      className={cn(
                        "flex items-center justify-between rounded border px-1.5 py-0.5",
                        ok
                          ? "border-emerald-500/25 bg-emerald-500/5 text-foreground"
                          : "border-border/60 bg-muted/20 text-muted-foreground/55 line-through"
                      )}
                    >
                      <span>{name}</span>
                      {ok && <RiShieldCheckLine className="size-2.5 text-emerald-600" />}
                    </div>
                  ))}
                </div>
              </div>

              {onSelectPin &&
                !activeGpio.restrictions.reserved &&
                !activeGpio.restrictions.flash_psram_conflict &&
                !usedSet.has(activeGpio.pin) && (
                  <Button
                    type="button"
                    size="xs"
                    className="w-full"
                    onClick={() => onSelectPin(activeGpio.pin)}
                  >
                    Select GPIO {activeGpio.pin}
                  </Button>
                )}
            </>
          ) : (
            <p className="text-[10px] text-muted-foreground leading-snug">
              {activeHeader
                ? `${activeHeader.pinName} is a dedicated ${activeHeader.kind} pad and not a general-purpose GPIO.`
                : "Click or hover any pin on the board or rail to inspect electrical details."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
