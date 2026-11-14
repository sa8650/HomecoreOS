import { useMemo, useState, type ReactNode } from "react";
import type {
  PlannerCandidatePlan,
  PlannerChannelKind,
  PlannerControllerPlan,
  PlannerMissingInformation,
  PlannerPinAssignment,
  PlannerReadiness,
  PlannerResult,
  PlannerResultState,
  PlannerWarning,
  PlannerWarningEffect,
  PlannerWarningSeverity,
} from "@homecoreos/shared";
import {
  RiArrowDownSLine,
  RiCheckboxCircleFill,
  RiCheckboxCircleLine,
  RiCloseCircleFill,
  RiCloseCircleLine,
  RiCpuLine,
  RiErrorWarningFill,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiQuestionFill,
  RiQuestionLine,
} from "@remixicon/react";
import { BoardVectorSvg } from "@/components/boards/BoardVectorSvg";
import { Badge, type BadgeProps } from "@/components/reui/badge";
import { Frame, FramePanel } from "@/components/reui/frame";
import { StatusAlert } from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BoardProfileItem } from "@/features/types";
import { cn } from "@/lib/utils";
import { PlannerAnalysisProgress } from "./PlannerAnalysisProgress";
import { plannerStepNumber } from "./PlannerWizard";

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

interface StateMeta {
  label: string;
  badge: BadgeVariant;
  panel: string;
  iconClass: string;
  icon: ReactNode;
}

/** Presentation of the four result states. The state itself always comes from the Worker. */
export const PLANNER_STATE_META: Record<PlannerResultState, StateMeta> = {
  ready: {
    label: "Ready",
    badge: "success",
    panel: "border-success/35 bg-success/[0.07]",
    iconClass: "bg-success/15 text-success",
    icon: <RiCheckboxCircleLine className="size-5" aria-hidden="true" />,
  },
  partially_ready: {
    label: "Partially ready",
    badge: "warning",
    panel: "border-warning/40 bg-warning/[0.08]",
    iconClass: "bg-warning/15 text-warning",
    icon: <RiErrorWarningLine className="size-5" aria-hidden="true" />,
  },
  not_supported: {
    label: "Not supported",
    badge: "destructive",
    panel: "border-destructive/35 bg-destructive/[0.06]",
    iconClass: "bg-destructive/12 text-destructive",
    icon: <RiCloseCircleLine className="size-5" aria-hidden="true" />,
  },
  incomplete: {
    label: "Incomplete",
    badge: "info",
    panel: "border-info/35 bg-info/[0.07]",
    iconClass: "bg-info/15 text-info",
    icon: <RiQuestionLine className="size-5" aria-hidden="true" />,
  },
};

const KIND_LABELS: Record<PlannerChannelKind, string> = {
  relay_output: "On/off output",
  pwm_output: "Speed signal (PWM)",
  digital_input: "Sensor input",
  contact_input: "Contact input",
  analog_input: "Analog input",
  i2c_sensor: "Sensor bus (I2C)",
};

const SEVERITY_META: Record<PlannerWarningSeverity, { label: string; badge: BadgeVariant; rank: number }> = {
  critical: { label: "Critical", badge: "destructive", rank: 0 },
  high: { label: "High", badge: "warning", rank: 1 },
  medium: { label: "Medium", badge: "warning-light", rank: 2 },
  low: { label: "Low", badge: "secondary", rank: 3 },
};

const EFFECT_LABELS: Record<PlannerWarningEffect, string> = {
  blocks_plan: "Blocks this plan",
  blocks_installation: "Blocks installation",
  action_required: "Action needed",
  advisory: "Good to know",
};

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function boardTitle(plan: PlannerCandidatePlan): string {
  return `${plan.board.manufacturer} ${plan.board.model}`.trim();
}

export function PlannerStateBadge({
  state,
  size = "default",
}: {
  state: PlannerResultState;
  size?: BadgeProps["size"];
}) {
  const meta = PLANNER_STATE_META[state];
  return (
    <Badge variant={meta.badge} size={size} radius="full" className="uppercase tracking-wide">
      {meta.label}
    </Badge>
  );
}

function Section({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={title} className={cn("min-w-0 space-y-2.5", className)}>
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/70 bg-background/70 px-3 py-2">
      <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
      <dd className="text-lg font-bold tabular-nums leading-tight text-foreground">{value}</dd>
    </div>
  );
}

function Verdict({ result }: { result: PlannerResult }) {
  const meta = PLANNER_STATE_META[result.state];
  const totals = result.requirements.totals;
  return (
    <section
      aria-label="Planner result"
      data-testid="planner-verdict"
      data-result-state={result.state}
      className={cn("hc-step-enter rounded-2xl border px-4 py-4 sm:px-5", meta.panel)}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl",
            meta.iconClass
          )}
        >
          {meta.icon}
        </span>
        <div className="min-w-0 space-y-1">
          <PlannerStateBadge state={result.state} />
          <h2 className="text-xl font-bold tracking-tight text-foreground">{result.headline}</h2>
          <p className="max-w-3xl text-sm leading-relaxed text-foreground/80">{result.summary}</p>
        </div>
      </div>
      <dl
        className={cn(
          "mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3",
          result.state !== "incomplete" && "lg:grid-cols-6"
        )}
      >
        <Stat label="Rooms" value={totals.rooms} />
        <Stat label="Devices" value={totals.physicalDevices} />
        <Stat label="Controller connections" value={totals.gpioChannels} />
        {/* An incomplete result never reads the catalog, so there is nothing to count. */}
        {result.state !== "incomplete" && (
          <>
            <Stat label="Boards checked" value={result.stats.boardsEvaluated} />
            <Stat label="Boards that fit" value={result.stats.boardsThatFit} />
            <Stat label="Published firmware" value={result.stats.publishedFirmwareReleases} />
          </>
        )}
      </dl>
    </section>
  );
}

function MissingInformation({
  items,
  onEditStep,
}: {
  items: PlannerMissingInformation[];
  onEditStep: (step: number) => void;
}) {
  const blocking = items.filter((item) => item.blocking);
  const optional = items.filter((item) => !item.blocking);
  return (
    <Section
      title="What the planner still needs"
      description="No hardware is suggested until these are answered, so nothing is guessed on your behalf."
    >
      <ul className="space-y-2">
        {blocking.map((item) => (
          <li
            key={item.code}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-info/30 bg-info/[0.06] px-3 py-2.5"
          >
            <span className="min-w-0 text-sm text-foreground">{item.message}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onEditStep(plannerStepNumber(item.step))}
            >
              Answer this
            </Button>
          </li>
        ))}
      </ul>
      {optional.length > 0 && (
        <div className="rounded-lg border border-dashed px-3 py-2.5">
          <p className="text-xs font-semibold text-foreground">Also worth answering</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
            {optional.map((item) => (
              <li key={item.code + item.message}>{item.message}</li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Plan options
// ---------------------------------------------------------------------------

const READINESS_STATE: Record<PlannerReadiness, PlannerResultState> = {
  ready: "ready",
  partially_ready: "partially_ready",
  not_supported: "not_supported",
};

function PlanPicker({
  plans,
  selected,
  recommended,
  onSelect,
}: {
  plans: PlannerCandidatePlan[];
  selected: number;
  recommended: boolean;
  onSelect: (index: number) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Hardware options"
      className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4"
    >
      {plans.map((plan, index) => {
        const active = index === selected;
        return (
          <button
            key={plan.board.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(index)}
            className={cn(
              "min-w-0 cursor-pointer rounded-xl border px-3 py-2.5 text-left outline-none transition-colors",
              "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              active
                ? "border-primary/60 bg-primary/[0.06] shadow-xs"
                : "border-border bg-card hover:border-primary/35"
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                {index === 0 && recommended ? "Recommended" : `Option ${plan.rank}`}
              </span>
              <PlannerStateBadge state={READINESS_STATE[plan.readiness]} size="xs" />
            </span>
            <span className="mt-1 block truncate text-sm font-semibold text-foreground">
              {plan.controllerCount} × {plan.board.model}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {plan.board.manufacturer} · {plan.board.chipLabel} · {plan.firmware.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

type CheckTone = "ok" | "attention" | "blocked" | "unknown";

const CHECK_ICONS: Record<CheckTone, ReactNode> = {
  ok: <RiCheckboxCircleFill className="size-4 text-success" aria-hidden="true" />,
  attention: <RiErrorWarningFill className="size-4 text-warning" aria-hidden="true" />,
  blocked: <RiCloseCircleFill className="size-4 text-destructive" aria-hidden="true" />,
  unknown: <RiQuestionFill className="size-4 text-muted-foreground" aria-hidden="true" />,
};

const CHECK_WORDS: Record<CheckTone, string> = {
  ok: "OK",
  attention: "Needs attention",
  blocked: "Blocked",
  unknown: "Unknown",
};

function CheckTile({
  tone,
  topic,
  label,
  detail,
}: {
  tone: CheckTone;
  topic: string;
  label: string;
  detail: ReactNode;
}) {
  return (
    <li className="min-w-0 rounded-lg border bg-card px-3 py-2.5" data-check-tone={tone}>
      <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {topic}
      </p>
      <p className="mt-1 flex items-start gap-1.5 text-sm font-semibold leading-snug text-foreground">
        <span className="mt-0.5 shrink-0">{CHECK_ICONS[tone]}</span>
        <span className="sr-only">{CHECK_WORDS[tone]}: </span>
        <span className="min-w-0">{label}</span>
      </p>
      <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</div>
    </li>
  );
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function CostDetail({ cost }: { cost: PlannerCandidatePlan["availability"]["cost"] }) {
  if (!cost.available) return <>{cost.reason}</>;
  return (
    <>
      {cost.lines.map((line) => (
        <span key={line.label} className="block">
          {line.quantity} × {line.label}: {formatMoney(line.subtotal, cost.currency)}
        </span>
      ))}
      {cost.excludes.length > 0 && (
        <span className="mt-1 block">Not included: {cost.excludes.join(", ")}.</span>
      )}
    </>
  );
}

function ReadinessChecks({ plan }: { plan: PlannerCandidatePlan }) {
  const { boardStatus, firmware, installation, availability } = plan;
  const cost = availability.cost;
  const boardTone: CheckTone =
    boardStatus.code === "published"
      ? "ok"
      : boardStatus.code === "unsupported"
        ? "blocked"
        : "attention";
  const stockTone: CheckTone =
    availability.stock.status === "in_stock"
      ? "ok"
      : availability.stock.status === "out_of_stock"
        ? "attention"
        : "unknown";

  return (
    <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
      {/* First, because nothing below matters when the board cannot carry the plan at all. */}
      <CheckTile
        tone={plan.fits ? "ok" : "blocked"}
        topic="Your requirements"
        label={plan.fit}
        detail={plan.fitDetail}
      />
      <CheckTile tone={boardTone} topic="Board" label={boardStatus.label} detail={boardStatus.detail} />
      <CheckTile
        tone={firmware.published ? "ok" : "attention"}
        topic="Firmware"
        label={firmware.label}
        detail={
          <>
            {firmware.detail}
            {firmware.notes.map((note) => (
              <span key={note} className="mt-1 block">
                {note}
              </span>
            ))}
          </>
        }
      />
      <CheckTile
        tone={installation.usbFactory.available ? "ok" : "attention"}
        topic="First installation over USB"
        label={installation.usbFactory.label}
        detail={installation.usbFactory.detail}
      />
      <CheckTile
        tone={installation.ota.available ? "ok" : "attention"}
        topic="Wireless updates (OTA)"
        label={installation.ota.label}
        detail={installation.ota.detail}
      />
      <CheckTile
        tone={stockTone}
        topic="Stock"
        label={availability.stock.label}
        detail={availability.stock.detail}
      />
      <CheckTile
        tone={cost.available ? "ok" : "unknown"}
        topic="Estimated cost"
        label={cost.available ? formatMoney(cost.total, cost.currency) : "No estimate"}
        detail={<CostDetail cost={cost} />}
      />
      {availability.accountLimits.map((limit) => (
        <CheckTile
          key={limit.kind}
          tone={limit.exceeded ? "blocked" : "ok"}
          topic={limit.kind === "controllers" ? "Account limit: controllers" : "Account limit: devices"}
          label={limit.exceeded ? "Over your account limit" : "Within your account limit"}
          detail={`${limit.existing} in use + ${limit.planned} in this plan, of ${limit.limit} allowed.`}
        />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Controllers and pins
// ---------------------------------------------------------------------------

/**
 * The short, unambiguous name of a pin. Board Library labels often carry a
 * description as well ("GPIO48 (General GPIO)"); that stays available as a
 * tooltip so the table reads as a plain wiring list.
 */
function pinName(assignment: PlannerPinAssignment): string {
  return assignment.pin === null ? "Shared bus" : `GPIO${assignment.pin}`;
}

function AssignmentRow({
  assignment,
  highlighted,
  onHover,
}: {
  assignment: PlannerPinAssignment;
  highlighted: boolean;
  onHover: (pin: number | null) => void;
}) {
  const headerName =
    assignment.boardPinName && assignment.boardPinName !== String(assignment.pin)
      ? assignment.boardPinName
      : null;
  return (
    <TableRow
      data-pin={assignment.pin ?? "bus"}
      data-state={highlighted ? "selected" : undefined}
      onMouseEnter={() => onHover(assignment.pin)}
      onMouseLeave={() => onHover(null)}
    >
      <TableCell
        className="py-1.5 font-mono text-xs font-semibold text-foreground"
        title={assignment.pinLabel !== pinName(assignment) ? assignment.pinLabel : undefined}
      >
        {pinName(assignment)}
        {headerName && (
          <span className="ml-1 font-normal text-muted-foreground">({headerName})</span>
        )}
      </TableCell>
      <TableCell className="whitespace-normal py-1.5 text-xs">
        <span className="font-medium text-foreground">{assignment.label}</span>
        {assignment.notes.map((note) => (
          <span key={note} className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
            {note}
          </span>
        ))}
      </TableCell>
      <TableCell className="py-1.5 text-xs text-muted-foreground">{assignment.roomName}</TableCell>
      <TableCell className="py-1.5 text-xs text-muted-foreground">
        {KIND_LABELS[assignment.kind]}
        {assignment.needsRelay && (
          <Badge variant="outline" size="xs" className="ml-1.5">
            Relay
          </Badge>
        )}
      </TableCell>
      <TableCell className="py-1.5 text-xs text-muted-foreground">
        {assignment.homecore.label}
      </TableCell>
    </TableRow>
  );
}

function ControllerCard({
  controller,
  board,
  boardName,
  showPins,
  defaultOpen,
}: {
  controller: PlannerControllerPlan;
  board: BoardProfileItem | null;
  boardName: string;
  /** False for boards the Board Library does not show; pin data is withheld then. */
  showPins: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [hoveredPin, setHoveredPin] = useState<number | null>(null);
  const assignedPins = useMemo(() => {
    const pins = new Set<number>();
    for (const assignment of controller.assignments) {
      if (assignment.pin !== null) pins.add(assignment.pin);
    }
    if (controller.i2cBus) {
      pins.add(controller.i2cBus.sda);
      pins.add(controller.i2cBus.scl);
    }
    return pins;
  }, [controller]);
  const byPin = useMemo(() => {
    const map = new Map<number, PlannerPinAssignment>();
    for (const assignment of controller.assignments) {
      if (assignment.pin !== null) map.set(assignment.pin, assignment);
    }
    return map;
  }, [controller]);
  const panelId = `planner-controller-${controller.index}`;
  const hovered = hoveredPin === null ? null : byPin.get(hoveredPin) ?? null;

  return (
    <li className="overflow-hidden rounded-xl border bg-card" data-testid="planner-controller">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/60"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-foreground">
            {controller.name}
          </span>
          <span className="block text-[11px] text-muted-foreground">
            {controller.rooms.map((room) => room.roomName).join(", ") || "No rooms"}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Badge variant="primary-light" size="sm" radius="full">
            {plural(controller.ioItemsUsed, "connection")}
          </Badge>
          <Badge variant="outline" size="sm" radius="full" className="hidden sm:inline-flex">
            {plural(controller.spare.pins, "spare pin")}
          </Badge>
          <RiArrowDownSLine
            aria-hidden="true"
            className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </span>
      </button>

      {open && (
        <div id={panelId} className="hc-step-enter space-y-3 border-t px-3.5 py-3.5">
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <div className="flex gap-1.5">
              <dt>Location:</dt>
              <dd className="font-medium text-foreground">{controller.locationName}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Pins used:</dt>
              <dd className="font-medium tabular-nums text-foreground">{controller.pinsUsed}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Relay channels:</dt>
              <dd className="font-medium tabular-nums text-foreground">{controller.relayChannels}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Room for:</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {plural(controller.spare.outputs, "more output")} or{" "}
                {plural(controller.spare.inputs, "more sensor input")}
              </dd>
            </div>
          </dl>

          {!showPins ? (
            <StatusAlert tone="info" title="Pin assignments are not shown for this board">
              This board is not listed in your Board Library, so its pin layout is not available
              here. The connection counts above are still the real result of the analysis.
            </StatusAlert>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
              <div className="space-y-2">
                <div className="flex items-center justify-center rounded-lg border border-border/60 bg-[#0b0e12] px-2 py-2.5">
                  {board ? (
                    <BoardVectorSvg
                      board={board}
                      orientation="vertical"
                      className="h-auto max-h-[30rem] w-full"
                      selectedPin={hoveredPin}
                      pinDimmed={(hp) => hp.gpioPin === null || !assignedPins.has(hp.gpioPin)}
                      onPinHover={(hp) =>
                        setHoveredPin(hp && hp.gpioPin !== null && assignedPins.has(hp.gpioPin) ? hp.gpioPin : null)
                      }
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-2 px-3 py-10 text-center text-slate-300">
                      <RiCpuLine className="size-8 opacity-70" aria-hidden="true" />
                      <p className="text-xs leading-relaxed">
                        No drawing is available for {boardName}. Use the pin table for wiring.
                      </p>
                    </div>
                  )}
                </div>
                <p
                  className="min-h-8 text-[11px] leading-snug text-muted-foreground"
                  aria-live="polite"
                  data-testid="planner-pin-readout"
                >
                  {hovered
                    ? `${pinName(hovered)}: ${hovered.label} (${hovered.roomName})`
                    : board
                      ? "Bright pins are used by this controller. Point at a pin or a table row to match them up."
                      : ""}
                </p>
              </div>

              <div className="min-w-0 rounded-lg border">
                <Table aria-label={`Pin assignments for ${controller.name}`}>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="h-8 text-[11px]">Pin</TableHead>
                      <TableHead className="h-8 text-[11px]">Connect</TableHead>
                      <TableHead className="h-8 text-[11px]">Room</TableHead>
                      <TableHead className="h-8 text-[11px]">Signal</TableHead>
                      <TableHead className="h-8 text-[11px]">Add in HomecoreOS as</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {controller.assignments.map((assignment) => (
                      <AssignmentRow
                        key={assignment.channelId}
                        assignment={assignment}
                        highlighted={assignment.pin !== null && assignment.pin === hoveredPin}
                        onHover={setHoveredPin}
                      />
                    ))}
                  </TableBody>
                </Table>
                {controller.i2cBus && (
                  <p className="border-t px-2.5 py-2 text-[11px] leading-snug text-muted-foreground">
                    Shared sensor bus: data (SDA) on GPIO{controller.i2cBus.sda}, clock (SCL) on GPIO
                    {controller.i2cBus.scl}, carrying {plural(controller.i2cBus.sensors, "sensor")}.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

function sortBySeverity(warnings: PlannerWarning[]): PlannerWarning[] {
  return warnings
    .map((warning, index) => ({ warning, index }))
    .sort(
      (a, b) =>
        SEVERITY_META[a.warning.severity].rank - SEVERITY_META[b.warning.severity].rank ||
        a.index - b.index
    )
    .map((entry) => entry.warning);
}

function WarningItem({ warning }: { warning: PlannerWarning }) {
  const severity = SEVERITY_META[warning.severity];
  const blocking = warning.effect === "blocks_plan" || warning.effect === "blocks_installation";
  return (
    <li>
      <details
        className="group rounded-lg border bg-card open:shadow-xs"
        open={blocking || warning.severity === "critical"}
        data-warning-code={warning.code}
        data-severity={warning.severity}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
          <Badge variant={severity.badge} size="sm" className="shrink-0">
            {severity.label}
          </Badge>
          <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{warning.title}</span>
          <span
            className={cn(
              "hidden shrink-0 text-[11px] sm:inline",
              blocking ? "font-semibold text-destructive" : "text-muted-foreground"
            )}
          >
            {EFFECT_LABELS[warning.effect]}
          </span>
          <RiArrowDownSLine
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          />
        </summary>
        <dl className="space-y-2 border-t px-3 py-2.5 text-xs leading-relaxed">
          <div>
            <dt className="font-semibold text-foreground">What it means</dt>
            <dd className="text-muted-foreground">{warning.meaning}</dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">Why it applies to you</dt>
            <dd className="text-muted-foreground">{warning.cause}</dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">What could happen</dt>
            <dd className="text-muted-foreground">{warning.impact}</dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">What to do</dt>
            <dd className="text-muted-foreground">{warning.resolution}</dd>
          </div>
        </dl>
      </details>
    </li>
  );
}

function WarningList({ warnings }: { warnings: PlannerWarning[] }) {
  const sorted = useMemo(() => sortBySeverity(warnings), [warnings]);
  if (sorted.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
        The planner found nothing to warn about.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5" data-testid="planner-warnings">
      {sorted.map((warning) => (
        <WarningItem key={warning.id} warning={warning} />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// One plan
// ---------------------------------------------------------------------------

/** Controllers rendered up front; larger plans reveal the rest on request. */
const CONTROLLER_PAGE_SIZE = 8;

function PlanDetail({
  plan,
  board,
  recommended,
  globalWarnings,
  onNavigate,
}: {
  plan: PlannerCandidatePlan;
  board: BoardProfileItem | null;
  recommended: boolean;
  globalWarnings: PlannerWarning[];
  onNavigate: (path: string) => void;
}) {
  const [shownControllers, setShownControllers] = useState(CONTROLLER_PAGE_SIZE);
  const showPins = plan.detailLevel === "full";
  const title = boardTitle(plan);
  const warnings = useMemo(
    () => [...plan.warnings, ...globalWarnings],
    [plan.warnings, globalWarnings]
  );
  const facts = [plan.board.chipLabel, plan.board.memory, plan.board.wireless].filter(
    (fact): fact is string => Boolean(fact)
  );

  return (
    <div className="hc-step-enter space-y-6" data-testid="planner-plan-detail">
      <div className="grid grid-cols-1 gap-4 rounded-xl border bg-card p-3.5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="flex items-center justify-center rounded-lg border border-border/60 bg-[#0b0e12] px-2 py-3">
          {board ? (
            <BoardVectorSvg board={board} orientation="horizontal" className="h-auto max-h-44 w-full" />
          ) : (
            <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-slate-300">
              <RiCpuLine className="size-8 opacity-70" aria-hidden="true" />
              <p className="text-xs leading-relaxed">
                {showPins
                  ? `No drawing is available for ${title}.`
                  : "This board is not shown in your Board Library, so no drawing is available."}
              </p>
            </div>
          )}
        </div>
        <div className="min-w-0 space-y-2.5">
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-primary">
              {recommended ? "Recommended hardware" : `Option ${plan.rank}`}
            </p>
            <h3 className="text-lg font-bold tracking-tight text-foreground">
              {plan.controllerCount} × {title}
            </h3>
            <div className="flex flex-wrap items-center gap-1.5">
              <PlannerStateBadge state={READINESS_STATE[plan.readiness]} size="sm" />
              {facts.map((fact) => (
                <Badge key={fact} variant="outline" size="sm">
                  {fact}
                </Badge>
              ))}
              {plan.board.source === "custom" && (
                <Badge variant="info-light" size="sm">
                  Your custom board
                </Badge>
              )}
            </div>
          </div>
          <ul
            aria-label="Why this option"
            className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground"
          >
            {plan.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {showPins && (
              <Button type="button" variant="outline" size="xs" onClick={() => onNavigate("/boards")}>
                Open Board Library
              </Button>
            )}
            {plan.firmware.published && (
              <Button type="button" variant="outline" size="xs" onClick={() => onNavigate("/firmware")}>
                Open Firmware &amp; Updates
              </Button>
            )}
            {plan.board.docsUrl && (
              <a
                href={plan.board.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Board documentation
                <RiExternalLinkLine className="size-3" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      </div>

      <Section
        title="Is it ready to install?"
        description="The first line checks your answers against this board. The others are read from the Board Library and Firmware Management records as they are right now."
      >
        <ReadinessChecks plan={plan} />
      </Section>

      {plan.unallocated.length > 0 && (
        <Section
          title="Could not be connected"
          description="These devices have no place in this option, which is why it is not supported."
        >
          <ul className="space-y-1.5">
            {plan.unallocated.map((channel) => (
              <li
                key={channel.channelId}
                className="rounded-lg border border-destructive/30 bg-destructive/[0.05] px-3 py-2 text-xs"
              >
                <span className="font-semibold text-foreground">
                  {channel.roomName}: {channel.label}
                </span>
                <span className="mt-0.5 block text-muted-foreground">{channel.detail}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {plan.controllers.length > 0 && (
        <Section
          title="Controllers and pin assignments"
          description="Which device goes on which pin of which controller. Follow the same assignments when you add the devices in HomecoreOS."
        >
          <ul className="space-y-2">
            {plan.controllers.slice(0, shownControllers).map((controller, index) => (
              <ControllerCard
                key={controller.index}
                controller={controller}
                board={board}
                boardName={title}
                showPins={showPins}
                defaultOpen={index === 0}
              />
            ))}
          </ul>
          {plan.controllers.length > shownControllers && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShownControllers((count) => count + CONTROLLER_PAGE_SIZE)}
            >
              Show {Math.min(CONTROLLER_PAGE_SIZE, plan.controllers.length - shownControllers)} more
              controllers
            </Button>
          )}
        </Section>
      )}

      {plan.externalHardware.length > 0 && (
        <Section
          title="What else you need"
          description="Parts that are not on the controller board. HomecoreOS does not sell or stock them; the quantities follow from your device counts."
        >
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {plan.externalHardware.map((item) => (
              <li key={item.kind + item.label} className="rounded-lg border bg-card px-3 py-2.5">
                <p className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">{item.label}</span>
                  <span className="shrink-0 text-xs font-medium tabular-nums text-foreground">
                    {item.quantity} {item.unit}
                  </span>
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
                {!item.required && (
                  <Badge variant="secondary" size="xs" className="mt-1.5">
                    Optional
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Room to grow">
        <div className="rounded-lg border bg-card px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <p>
            After everything is connected, this option leaves{" "}
            <span className="font-semibold text-foreground">
              {plural(plan.expansion.spare.pins, "spare pin")}
            </span>
            : room for up to {plural(plan.expansion.spare.outputs, "more output")} or{" "}
            {plural(plan.expansion.spare.inputs, "more sensor input")}.
          </p>
          {plan.expansion.requestedOutputs + plan.expansion.requestedInputs > 0 && (
            <p className="mt-1">
              You asked to reserve {plan.expansion.requestedOutputs} outputs and{" "}
              {plan.expansion.requestedInputs} sensor inputs for later:{" "}
              <span
                className={cn(
                  "font-semibold",
                  plan.expansion.satisfied ? "text-success" : "text-warning"
                )}
              >
                {plan.expansion.satisfied
                  ? "this option has room for all of them."
                  : `this option only has room for ${plan.expansion.accommodatedOutputs} outputs and ${plan.expansion.accommodatedInputs} sensor inputs.`}
              </span>
            </p>
          )}
        </div>
      </Section>

      <Section
        title={`Warnings and things to check (${warnings.length})`}
        description="Sorted by seriousness. Open one to see what it means, why it applies, and how to resolve it."
      >
        <WarningList warnings={warnings} />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface PlannerResultViewProps {
  result: PlannerResult;
  /** Boards the customer can see in the Board Library, keyed by board id. */
  boards: Map<string, BoardProfileItem>;
  /** Opens the wizard at a step (1-based) so an answer can be changed. */
  onEditStep: (step: number) => void;
  onNavigate: (path: string) => void;
}

export function PlannerResultView({ result, boards, onEditStep, onNavigate }: PlannerResultViewProps) {
  const [selected, setSelected] = useState(0);
  const recommended = result.state === "ready" || result.state === "partially_ready";
  const plan = result.plans[Math.min(selected, result.plans.length - 1)] ?? null;
  const planIndex = plan ? result.plans.indexOf(plan) : -1;

  return (
    <div className="space-y-6">
      <Verdict result={result} />

      {result.state === "incomplete" && (
        <MissingInformation items={result.missingInformation} onEditStep={onEditStep} />
      )}

      {result.requirements.adjustments.length > 0 && (
        <StatusAlert tone="info" title="Some answers were adjusted">
          <ul className="list-disc space-y-0.5 pl-4">
            {result.requirements.adjustments.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </StatusAlert>
      )}

      {result.state !== "incomplete" && result.plans.length === 0 && (
        <Section title="Why nothing could be suggested">
          <WarningList warnings={result.warnings} />
        </Section>
      )}

      {plan && (
        <Frame spacing="sm">
          <FramePanel className="min-w-0 space-y-5">
            <Section
              title={recommended ? "Hardware options" : "Closest options"}
              description={
                recommended
                  ? result.plans.length > 1
                    ? "The first option is the recommendation. The others also fit and are listed in ranked order."
                    : "This is the only board that meets your requirements."
                  : "None of these can be used as specified. They are the nearest matches, shown so you can see exactly what is missing."
              }
            >
              <PlanPicker
                plans={result.plans}
                selected={planIndex}
                recommended={recommended}
                onSelect={setSelected}
              />
            </Section>
            <PlanDetail
              key={plan.board.id}
              plan={plan}
              // A board the Board Library does not show is never drawn, even if
              // its drawing is still in memory from before it was hidden.
              board={plan.detailLevel === "full" ? (boards.get(plan.board.id) ?? null) : null}
              recommended={recommended && planIndex === 0}
              globalWarnings={result.warnings}
              onNavigate={onNavigate}
            />
          </FramePanel>
        </Frame>
      )}

      {result.evaluatedBoards.length > 0 && (
        <Section
          title={`Every board that was checked (${result.evaluatedBoards.length})`}
          description="Every board HomecoreOS has on record was evaluated, including the ones that did not qualify."
        >
          <div className="rounded-xl border bg-card">
            <Table aria-label="Boards evaluated by the planner">
              <TableHeader>
                <TableRow>
                  <TableHead className="h-9 text-xs">#</TableHead>
                  <TableHead className="h-9 text-xs">Board</TableHead>
                  <TableHead className="h-9 text-xs">Result</TableHead>
                  <TableHead className="h-9 text-xs">Does it fit?</TableHead>
                  <TableHead className="h-9 text-xs">Catalog</TableHead>
                  <TableHead className="h-9 text-xs">Firmware</TableHead>
                  <TableHead className="h-9 text-xs">USB</TableHead>
                  <TableHead className="h-9 text-xs">OTA</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.evaluatedBoards.map((board) => (
                  <TableRow key={board.boardId}>
                    <TableCell className="py-1.5 text-xs tabular-nums text-muted-foreground">
                      {board.rank}
                    </TableCell>
                    <TableCell className="py-1.5 text-xs">
                      <span className="font-medium text-foreground">{board.model}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {board.manufacturer} · {board.chipLabel}
                        {board.source === "custom" ? " · custom" : ""}
                      </span>
                    </TableCell>
                    <TableCell className="py-1.5">
                      <PlannerStateBadge state={READINESS_STATE[board.readiness]} size="xs" />
                    </TableCell>
                    <TableCell className="min-w-44 whitespace-normal py-1.5 text-xs text-muted-foreground">
                      {board.fit}
                    </TableCell>
                    <TableCell className="py-1.5 text-xs text-muted-foreground">
                      {board.boardStatus.label}
                    </TableCell>
                    <TableCell className="py-1.5 text-xs text-muted-foreground">
                      {board.firmwareLabel}
                    </TableCell>
                    <TableCell className="py-1.5 text-xs text-muted-foreground">
                      {board.usbFactoryAvailable ? "Yes" : "No"}
                    </TableCell>
                    <TableCell className="py-1.5 text-xs text-muted-foreground">
                      {board.otaAvailable ? "Yes" : "No"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      )}

      <details className="group rounded-xl border bg-card" data-testid="planner-analysis-log">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-foreground">
              How this result was worked out
            </span>
            <span className="block text-[11px] text-muted-foreground">
              The steps the planner ran, what each one found, and how long it took.
            </span>
          </span>
          <RiArrowDownSLine
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="border-t px-3.5 py-3.5">
          <PlannerAnalysisProgress stages={result.stages} />
        </div>
      </details>
    </div>
  );
}
