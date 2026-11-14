import { useEffect, useId, useRef, useState } from "react";
import {
  RiAlertLine,
  RiArrowRightLine,
  RiCheckLine,
  RiCloseLine,
  RiCpuLine,
  RiQuestionLine,
  RiUsbLine,
} from "@remixicon/react";
import {
  usbBoardMismatchImpact,
  type UsbBoardCheckStatus,
  type UsbBoardMismatchImpact,
} from "@homecoreos/shared";
import type { UsbFlashBoardReport, UsbFlashTargetBoardSpec } from "@/lib/usb-flasher";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

const IMPACT_COPY: Record<
  UsbBoardMismatchImpact,
  { badge: string; consequence: string; acknowledge: string }
> = {
  will_not_start: {
    badge: "Will not start",
    consequence:
      "This firmware is built for a different chip. If you force it, the controller will not start until matching firmware is installed again over USB.",
    acknowledge: "I understand that this firmware cannot start on the connected board.",
  },
  may_not_start: {
    badge: "May not start",
    consequence:
      "This firmware expects different hardware. If you force it, the controller may not start, or may be unstable.",
    acknowledge: "I understand that this firmware may not start on the connected board.",
  },
  different_board: {
    badge: "Different board",
    consequence:
      "This firmware should start on the connected board. But the controller would be set up as the selected board, so the pin map and pin warnings shown in HomecoreOS would be those of a different board.",
    acknowledge: "I understand that the controller will be set up as a different board.",
  },
  different_variant: {
    badge: "Different variant",
    consequence:
      "The firmware should run, but the controller would be set up as a different board than the one connected, so its memory and pin map would be wrong.",
    acknowledge: "I understand that the controller will be set up as a different board.",
  },
};

/**
 * What to tell the user after a forced flash finished: the image is written,
 * and this is what the mismatch means for the controller now.
 */
export function describeForcedFlashOutcome(report: UsbFlashBoardReport | null): string {
  const selected = report?.selected?.label ?? "the selected board";
  const impact = report ? usbBoardMismatchImpact(report.mismatches) : null;
  if (impact === "will_not_start") {
    return "The controller will not start with it. Install the firmware again over USB with the matching board selected.";
  }
  if (impact === "different_board" || impact === "different_variant") {
    return `The controller should start, but it is set up as ${selected}, so the pin map shown in HomecoreOS is not the one of the connected board. To correct it, install the firmware again with the matching board selected.`;
  }
  return "The controller may not start. If it does not appear for setup, install the firmware again with the matching board selected.";
}

/** "No PSRAM" → "no PSRAM": start mid-sentence without flattening acronyms. */
function lowerFirst(text: string): string {
  return text.length > 1 && text[1] === text[1].toLowerCase()
    ? text[0].toLowerCase() + text.slice(1)
    : text;
}

function CheckIcon({ status }: { status: UsbBoardCheckStatus }) {
  if (status === "match") {
    return <RiCheckLine className="size-3.5 text-success" aria-label="Matches" />;
  }
  if (status === "mismatch") {
    return <RiCloseLine className="size-3.5 text-destructive" aria-label="Differs" />;
  }
  return <RiQuestionLine className="size-3.5 text-muted-foreground" aria-label="Not reported" />;
}

export interface UsbBoardRecommendationAction {
  /** A USB firmware release exists for this board, so it can be switched to. */
  canSwitch: boolean;
  /** Why it cannot be switched to, shown instead of the button. */
  note?: string;
}

/**
 * Shown while a USB flash is paused because the connected board is not the
 * selected one. Nothing has been written yet. The user can stop (the safe
 * default), switch to the recommended board, or explicitly force the flash.
 */
export function UsbBoardMismatchPanel({
  report,
  firmwareLabel,
  describeRecommendation,
  onCancel,
  onForce,
  onUseBoard,
}: {
  report: UsbFlashBoardReport;
  firmwareLabel: string;
  /** Tells whether a recommended board can be switched to right away. */
  describeRecommendation?: (board: UsbFlashTargetBoardSpec) => UsbBoardRecommendationAction;
  onCancel: () => void;
  onForce: () => void;
  onUseBoard?: (board: UsbFlashTargetBoardSpec) => void;
}) {
  const titleId = useId();
  const acknowledgeId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  // The wording follows what actually differs, so it never claims more than the check found.
  const impact = usbBoardMismatchImpact(report.mismatches) ?? "different_variant";
  const copy = IMPACT_COPY[impact];
  const critical = impact === "will_not_start";
  const usb = report.detected.usb;

  // The safe choice gets the focus, so Enter never forces a flash.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <section
      role="alertdialog"
      aria-labelledby={titleId}
      data-testid="usb-board-mismatch"
      className={cn(
        "hc-step-enter space-y-3 rounded-xl border p-3 sm:p-4",
        critical ? "border-destructive/40 bg-destructive/5" : "border-warning/45 bg-warning/5"
      )}
    >
      <header className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
            critical ? "bg-destructive/15 text-destructive" : "bg-warning/20 text-warning-foreground"
          )}
        >
          <RiAlertLine className="size-4.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={titleId} className="text-sm font-semibold text-foreground">
              The connected board is not the board you selected
            </h3>
            <Badge variant={critical ? "destructive-light" : "warning-light"} size="xs">
              {copy.badge}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Flashing is paused. Nothing has been written to the controller.
          </p>
        </div>
      </header>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="min-w-0 rounded-lg border bg-background/70 p-2.5">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <RiUsbLine className="size-3.5" aria-hidden="true" />
            Connected board
          </p>
          <p className="mt-1 break-words text-sm font-semibold text-foreground">
            {report.detected.summary}
          </p>
          <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
            {report.detected.chipName}
          </p>
          <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
            {usb.label}
            {usb.vendorName ? ` · ${usb.vendorName}` : ""}
            {usb.usbId ? ` · USB ${usb.usbId}` : ""}
          </p>
        </div>
        <div className="min-w-0 rounded-lg border bg-background/70 p-2.5">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <RiCpuLine className="size-3.5" aria-hidden="true" />
            Selected board
          </p>
          <p className="mt-1 break-words text-sm font-semibold text-foreground">
            {report.selected?.label ?? "No board selected"}
          </p>
          <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
            Firmware: {firmwareLabel}
          </p>
        </div>
      </div>

      {report.checks.length > 0 && (
        <table className="w-full table-fixed border-separate border-spacing-0 overflow-hidden rounded-lg border bg-background/70 text-[11px]">
          <caption className="sr-only">Connected board compared with the selected board</caption>
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="w-[22%] px-2.5 py-1.5 font-semibold">
                Check
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Connected
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Selected
              </th>
              <th scope="col" className="w-8 px-1 py-1.5">
                <span className="sr-only">Result</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {report.checks.map((check) => (
              <tr
                key={check.key}
                data-status={check.status}
                className={cn(check.status === "mismatch" && "bg-destructive/5")}
              >
                <th scope="row" className="border-t px-2.5 py-1.5 text-left font-medium text-foreground">
                  {check.label}
                </th>
                <td className="break-words border-t px-2.5 py-1.5 tabular-nums text-foreground">
                  {check.detected}
                </td>
                <td className="break-words border-t px-2.5 py-1.5 tabular-nums text-muted-foreground">
                  {check.expected}
                </td>
                <td className="border-t px-1 py-1.5 text-center">
                  <CheckIcon status={check.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ul className="space-y-1.5">
        {report.mismatches.map((mismatch) => (
          <li key={mismatch.code} className="text-xs leading-snug text-foreground">
            <span className="font-semibold">{mismatch.title}.</span>{" "}
            <span className="text-muted-foreground">{mismatch.detail}</span>
          </li>
        ))}
      </ul>

      <div className="space-y-1.5 rounded-lg border bg-background/70 p-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Recommended board
        </p>
        {report.recommended.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No board in your Board Library matches the connected hardware. Add the board to the
            library, or connect the board you selected.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {report.recommended.map((rec) => {
              const action = describeRecommendation?.(rec.board);
              return (
                <li
                  key={rec.board.id ?? rec.board.slug ?? rec.label}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="break-words text-xs font-semibold text-foreground">{rec.label}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {rec.exact
                        ? "Matches the connected hardware."
                        : `Closest board in the library. Still differs: ${rec.differences.map(lowerFirst).join(", ")}.`}
                      {action && !action.canSwitch && action.note ? ` ${action.note}` : ""}
                    </p>
                  </div>
                  {onUseBoard && action?.canSwitch && (
                    <Button size="sm" variant="outline" onClick={() => onUseBoard(rec.board)}>
                      Use this board
                      <RiArrowRightLine className="size-3.5" aria-hidden="true" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className={cn("text-xs leading-snug", critical ? "text-destructive" : "text-warning-foreground")}>
        {copy.consequence}
      </p>

      <div className="flex items-start gap-2">
        <Checkbox
          id={acknowledgeId}
          checked={acknowledged}
          onCheckedChange={(value) => setAcknowledged(value === true)}
          className="mt-0.5"
        />
        <Label htmlFor={acknowledgeId} className="cursor-pointer text-xs font-normal leading-snug">
          {copy.acknowledge}
        </Label>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          variant="destructive"
          disabled={!acknowledged}
          onClick={onForce}
          title={acknowledged ? undefined : "Confirm the statement above first"}
        >
          Force to Flash
        </Button>
        <Button ref={cancelRef} onClick={onCancel}>
          Cancel flashing
        </Button>
      </div>
    </section>
  );
}
