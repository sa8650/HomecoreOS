import { useId, useRef, useState, type KeyboardEvent } from "react";
import {
  GPIO_PIN_STATE_DESCRIPTIONS,
  GPIO_PIN_STATE_LABELS,
  type GpioCapabilityTag,
  type GpioPinSelectorEntry,
  type GpioPinState,
  type PinOperationRequirement,
} from "@homecoreos/shared";
import {
  RiAlertLine,
  RiCheckLine,
  RiLock2Line,
  RiPlugLine,
  RiSparkling2Line,
} from "@remixicon/react";
import type { PinSelection } from "@/lib/board-pin-helpers";
import { cn } from "@/lib/utils";
import { FormField } from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const STATE_ORDER: GpioPinState[] = ["available", "used", "restricted", "dangerous"];

/** One colour per state. The selected pin uses the brand colour on top. */
const STATE_TILE: Record<GpioPinState, string> = {
  available:
    "border-success/40 bg-success/10 text-success-foreground hover:border-success/80 hover:bg-success/20",
  used: "border-foreground/15 bg-foreground/[0.07] text-muted-foreground",
  restricted: "border-warning/45 bg-warning/10 text-warning-foreground",
  dangerous: "border-destructive/45 bg-destructive/10 text-destructive",
};

const STATE_DOT: Record<GpioPinState, string> = {
  available: "bg-success",
  used: "bg-muted-foreground/70",
  restricted: "bg-warning",
  dangerous: "bg-destructive",
};

const REQUIRED_TAG: Partial<Record<PinOperationRequirement, GpioCapabilityTag>> = {
  pwm: "PWM",
  adc: "ADC",
  i2c: "I2C",
};

function StateIcon({ state, className }: { state: GpioPinState; className?: string }) {
  if (state === "used") return <RiPlugLine className={className} aria-hidden="true" />;
  if (state === "restricted") return <RiLock2Line className={className} aria-hidden="true" />;
  if (state === "dangerous") return <RiAlertLine className={className} aria-hidden="true" />;
  return null;
}

/** Everything the pin can do beyond plain digital I/O, e.g. "PWM · ADC · I2C". */
function capabilityList(entry: GpioPinSelectorEntry, requirement: PinOperationRequirement): string[] {
  const special: GpioCapabilityTag[] = entry.capabilities.filter((c) => c !== "OUT" && c !== "IN");
  const wanted = REQUIRED_TAG[requirement];
  // What the selected type needs comes first, so it survives the short form.
  if (wanted && special.includes(wanted)) {
    return [wanted, ...special.filter((c) => c !== wanted)];
  }
  return special;
}

function capabilityText(entry: GpioPinSelectorEntry, requirement: PinOperationRequirement): string {
  const special = capabilityList(entry, requirement);
  const digital = entry.capabilities.includes("OUT")
    ? "digital in/out"
    : entry.capabilities.includes("IN")
      ? "digital input only"
      : null;
  return [digital, ...special].filter(Boolean).join(", ") || "nothing assignable";
}

/** At most two tags: the tile is small, the full list is in the explanation. */
function capabilityShort(entry: GpioPinSelectorEntry, requirement: PinOperationRequirement): string {
  const special = capabilityList(entry, requirement);
  if (special.length > 0) return special.slice(0, 2).join(" ");
  if (entry.capabilities.includes("OUT")) return "I/O";
  if (entry.capabilities.includes("IN")) return "IN";
  return "—";
}

/** Who holds the pin, when another device, switch or sensor does. */
function assignmentText(entry: GpioPinSelectorEntry): string | null {
  if (entry.usedBy) return entry.usedBy.name;
  if (entry.state === "used") return "In use";
  return null;
}

function pinTitle(entry: GpioPinSelectorEntry): string {
  return entry.boardPinName ? `${entry.label} (${entry.boardPinName})` : entry.label;
}

function tileLabel(entry: GpioPinSelectorEntry, requirement: PinOperationRequirement): string {
  const parts = [`GPIO ${entry.pin}`];
  if (entry.boardPinName) parts.push(`pad ${entry.boardPinName}`);
  parts.push(GPIO_PIN_STATE_LABELS[entry.state].toLowerCase());
  if (entry.suggestionRank) parts.push("suggested");
  if (entry.isCurrent) parts.push("currently assigned here");
  parts.push(`can do ${capabilityText(entry, requirement)}`);
  const sentence = parts.join(", ");
  return entry.explanation ? `${sentence}. ${entry.explanation}` : `${sentence}.`;
}

/**
 * Calendar-style GPIO pin selector.
 *
 * The number field stays the source of truth and stays typeable. The pin map
 * below it shows every pin of the controller's board as a tile, colour-coded
 * by state, with its capability and its current assignment. A pin that cannot
 * be chosen says why instead of silently refusing.
 *
 * All rules come from the shared pin policy (see resolvePinSelection), so the
 * map, the field message and the API always agree.
 */
export function GpioPinPicker({
  id,
  label,
  value,
  onChange,
  selection,
  requirement,
  typeLabel,
  optional = false,
}: {
  id: string;
  label: string;
  /** Text of the pin field. An empty string means "no pin". */
  value: string;
  onChange: (raw: string) => void;
  selection: PinSelection;
  requirement: PinOperationRequirement;
  /** What is being wired, e.g. "a relay switch". Used in the suggestion line. */
  typeLabel: string;
  /** The pin may be left empty (I2C sensors on the default bus). */
  optional?: boolean;
}) {
  const mapId = useId();
  const mapRef = useRef<HTMLDivElement>(null);
  const [inspectedPin, setInspectedPin] = useState<number | null>(null);

  const { model, board, entry: selectedEntry } = selection;
  const isEmpty = value.trim() === "";
  const selectedPin = isEmpty ? null : Number(value);

  const wired = model ? model.entries.filter((e) => e.location !== "onboard") : [];
  const onboard = model ? model.entries.filter((e) => e.location === "onboard") : [];
  const suggestions = model
    ? model.suggestions
        .map((pin) => model.entries.find((e) => e.pin === pin))
        .filter((e): e is GpioPinSelectorEntry => Boolean(e))
    : [];

  const inspected =
    inspectedPin !== null && inspectedPin !== selectedPin
      ? (model?.entries.find((e) => e.pin === inspectedPin) ?? null)
      : null;

  // One tab stop for the whole map; the arrow keys move between pins.
  const tabStopPin =
    selectedEntry?.pin ?? suggestions[0]?.pin ?? wired[0]?.pin ?? onboard[0]?.pin ?? null;

  const missing = !optional && isEmpty;
  const fieldError = missing
    ? "Choose a GPIO pin from the map, or type its number."
    : selection.blocked
      ? selection.reason
      : undefined;
  const fieldHint = !missing && !selection.blocked ? selection.reason : undefined;

  function choose(entry: GpioPinSelectorEntry) {
    if (!entry.selectable) {
      // Keep the current choice and say why this pin cannot be used.
      setInspectedPin(entry.pin);
      return;
    }
    setInspectedPin(null);
    onChange(String(entry.pin));
  }

  function handleMapKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const tiles = Array.from(
      mapRef.current?.querySelectorAll<HTMLButtonElement>("button[data-pin]") ?? []
    );
    const index = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;

    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowRight") next = tiles[index + 1];
    else if (event.key === "ArrowLeft") next = tiles[index - 1];
    else if (event.key === "Home") next = tiles[0];
    else if (event.key === "End") next = tiles[tiles.length - 1];
    else {
      // Up / down: the nearest pin in the same column of the neighbouring row.
      const from = tiles[index]!.getBoundingClientRect();
      const down = event.key === "ArrowDown";
      let best = Number.POSITIVE_INFINITY;
      for (const tile of tiles) {
        const rect = tile.getBoundingClientRect();
        const distance = down ? rect.top - from.top : from.top - rect.top;
        if (distance <= 1 || Math.abs(rect.left - from.left) > 2) continue;
        if (distance < best) {
          best = distance;
          next = tile;
        }
      }
    }
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  function renderTile(entry: GpioPinSelectorEntry) {
    const entered = entry.pin === selectedPin;
    // Only a pin that may be saved looks selected. A blocked pin that was
    // typed into the field is outlined as an error instead.
    const selected = entered && entry.selectable;
    const rejected = entered && !entry.selectable;
    const middle = assignmentText(entry) ?? entry.boardPinName;
    return (
      <button
        key={entry.pin}
        type="button"
        data-pin={entry.pin}
        data-state={entry.state}
        data-suggested={entry.suggestionRank ? "true" : undefined}
        tabIndex={entry.pin === tabStopPin ? 0 : -1}
        aria-pressed={entered}
        aria-disabled={!entry.selectable}
        aria-label={tileLabel(entry, requirement)}
        onClick={() => choose(entry)}
        onMouseEnter={() => setInspectedPin(entry.pin)}
        onMouseLeave={() => setInspectedPin((current) => (current === entry.pin ? null : current))}
        onFocus={() => setInspectedPin(entry.pin)}
        onBlur={() => setInspectedPin((current) => (current === entry.pin ? null : current))}
        className={cn(
          "relative flex h-[3.25rem] min-w-0 flex-col items-center justify-center gap-px rounded-lg border px-1 text-center outline-none transition-[background-color,border-color,box-shadow,transform] duration-150",
          "focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          STATE_TILE[entry.state],
          entry.selectable ? "cursor-pointer active:scale-[0.96]" : "cursor-not-allowed",
          entry.suggestionRank && !selected && "border-primary/60 ring-1 ring-primary/35",
          selected &&
            "border-primary bg-primary text-primary-foreground shadow-sm ring-2 ring-primary/30 hover:border-primary hover:bg-primary",
          rejected && "border-destructive ring-2 ring-destructive/50"
        )}
      >
        {selected ? (
          <RiCheckLine className="absolute right-0.5 top-0.5 size-3" aria-hidden="true" />
        ) : entry.suggestionRank ? (
          <RiSparkling2Line
            className="absolute right-0.5 top-0.5 size-3 text-primary"
            aria-hidden="true"
          />
        ) : (
          <StateIcon state={entry.state} className="absolute right-0.5 top-0.5 size-3 opacity-75" />
        )}
        <span className="text-sm font-semibold leading-none tabular-nums">{entry.pin}</span>
        {middle && (
          <span className="w-full truncate text-[9px] font-medium leading-tight opacity-90">
            {middle}
          </span>
        )}
        {/*
          A usable pin says what it can do; a blocked pin says why in a word.
          The saved pin of the entity being edited is marked here, so the line
          above keeps the name printed on the board.
        */}
        <span className="w-full truncate text-[8px] font-medium uppercase leading-tight tracking-wide opacity-70">
          {entry.isCurrent
            ? "Current"
            : entry.state === "used" || !entry.reasonTag
              ? capabilityShort(entry, requirement)
              : entry.reasonTag}
        </span>
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <FormField id={id} label={label} error={fieldError} hint={fieldHint}>
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={0}
            max={54}
            value={value}
            placeholder={optional ? "Default I2C bus" : "Pin number"}
            aria-invalid={Boolean(fieldError)}
            aria-controls={model ? mapId : undefined}
            onChange={(e) => onChange(e.target.value)}
          />
          {optional && !isEmpty && (
            <Button type="button" variant="outline" onClick={() => onChange("")}>
              Clear
            </Button>
          )}
        </div>
      </FormField>

      {model ? (
        <div
          id={mapId}
          ref={mapRef}
          data-testid="gpio-pin-map"
          onKeyDown={handleMapKeyDown}
          className="hc-step-enter space-y-2.5 rounded-xl border bg-muted/30 p-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <p className="text-[11px] font-semibold text-foreground">
              Pin map <span className="font-normal text-muted-foreground">· {board?.model}</span>
            </p>
            <ul className="flex flex-wrap items-center gap-x-2.5 gap-y-1" aria-label="Pin states">
              {STATE_ORDER.map((state) => (
                <li
                  key={state}
                  title={GPIO_PIN_STATE_DESCRIPTIONS[state]}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground"
                >
                  <span className={cn("size-2 rounded-full", STATE_DOT[state])} aria-hidden="true" />
                  {GPIO_PIN_STATE_LABELS[state]}
                  <span className="tabular-nums text-foreground/70">{model.counts[state]}</span>
                </li>
              ))}
            </ul>
          </div>

          {suggestions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <RiSparkling2Line className="size-3.5 text-primary" aria-hidden="true" />
                Suggested for {typeLabel}
              </span>
              {suggestions.map((entry) => (
                <Button
                  key={entry.pin}
                  type="button"
                  size="xs"
                  variant={entry.pin === selectedPin ? "default" : "outline"}
                  className="tabular-nums"
                  aria-label={`Use suggested ${pinTitle(entry)}`}
                  onClick={() => choose(entry)}
                >
                  {entry.label}
                  {entry.boardPinName && (
                    <span className="font-normal opacity-70">{entry.boardPinName}</span>
                  )}
                </Button>
              ))}
            </div>
          ) : (
            <p className="flex items-start gap-1.5 text-[11px] text-warning-foreground">
              <RiAlertLine className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              No free pin on this board can serve {typeLabel}. Free a pin, or choose another
              controller.
            </p>
          )}

          {wired.length > 0 && (
            <div
              role="group"
              aria-label="Board pins. Use the arrow keys to move between pins."
              className="grid grid-cols-5 gap-1 sm:grid-cols-8"
            >
              {wired.map(renderTile)}
            </div>
          )}

          {onboard.length > 0 && (
            <div className="space-y-1">
              {wired.length > 0 && (
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  On the board only · not on the pin headers
                </p>
              )}
              <div
                role="group"
                aria-label="Pins that are not on the pin headers"
                className="grid grid-cols-5 gap-1 sm:grid-cols-8"
              >
                {onboard.map(renderTile)}
              </div>
            </div>
          )}

          <p className="min-h-[2.25rem] text-[11px] leading-snug text-muted-foreground">
            {inspected ? (
              <>
                <span className="font-semibold text-foreground">
                  {pinTitle(inspected)} · {GPIO_PIN_STATE_LABELS[inspected.state]}.
                </span>{" "}
                {inspected.explanation ??
                  `${inspected.suggestionRank ? `A good fit for ${typeLabel}. ` : "Free. "}Can do ${capabilityText(inspected, requirement)}.`}
              </>
            ) : selectedEntry && !selection.blocked ? (
              <>
                <span className="font-semibold text-foreground">
                  {pinTitle(selectedEntry)} selected.
                </span>{" "}
                Can do {capabilityText(selectedEntry, requirement)}. Point at any pin to see why it
                is or is not available.
              </>
            ) : selectedEntry ? (
              <>
                <span className="font-semibold text-foreground">
                  {pinTitle(selectedEntry)} cannot be used here.
                </span>{" "}
                Pick one of the green pins instead.
              </>
            ) : (
              "Pick a pin from the map, or type its number. Point at any pin to see why it is or is not available."
            )}
          </p>
        </div>
      ) : (
        !board && (
          <p className="text-[11px] text-muted-foreground">
            The pin map of this controller's board is not available, so only conflicts with other
            hardware on the same controller can be checked here.
          </p>
        )
      )}
    </div>
  );
}
