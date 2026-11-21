import {
  RiAlertLine,
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiCpuLine,
  RiLoader4Line,
  RiRestartLine,
  RiShieldCheckLine,
  RiTerminalBoxLine,
  RiWifiLine,
} from "@remixicon/react";
import { cn } from "@/lib/utils";
import type { UsbFlashStage } from "@/lib/usb-flasher";
import type { FirmwareUpdateHistoryItem } from "@/features/types";
import { Badge } from "@/components/reui/badge";
import { Frame, FramePanel } from "@/components/reui/frame";
import {
  Stepper,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperTitle,
} from "@/components/reui/stepper";
import { StatusAlert } from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

const USB_STAGES: Array<{ id: UsbFlashStage; label: string; detail: string }> = [
  { id: "preparing_firmware", label: "Prepare Firmware", detail: "Download & verify package" },
  { id: "connecting", label: "Connect USB", detail: "Select your controller" },
  { id: "detecting_board", label: "Check Board", detail: "Confirm controller hardware" },
  { id: "writing", label: "Install Firmware", detail: "Writing firmware" },
  { id: "verifying", label: "Restart", detail: "Starting up controller" },
  { id: "completed", label: "Complete", detail: "Ready for pairing" },
];

export function UsbFlashIllustration({ active = false }: { active?: boolean }) {
  // Flat, high-contrast artwork on a light green wash: the firmware leaves the
  // browser (monitor + download arrow), travels down a USB cable, and lands on
  // the controller board. Outlines stay ink-dark, the accents are the same
  // greens the hardware illustrations use, and the arrow only moves while a
  // flash is actually running.
  const ink = "#1f2933";
  const green = "#1f9d55";
  const paper = "#eef8f0";
  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-emerald-600/20 bg-emerald-50 px-5 py-4 dark:border-emerald-400/25 dark:bg-emerald-950/40"
      aria-label="USB connection illustration"
      data-testid="usb-flash-illustration"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-300">
            Direct connection
          </p>
          <p className="mt-1 text-sm font-semibold text-foreground">
            Flash the board over USB
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Firmware is written straight from this browser to the board&apos;s chip.
          </p>
        </div>
        <svg
          viewBox="0 0 220 120"
          className="h-20 w-36 shrink-0 sm:h-24 sm:w-44"
          aria-hidden="true"
          fill="none"
        >
          {/* Light card behind the drawing, like the reference illustration. */}
          <rect x="2" y="6" width="216" height="108" rx="16" fill={paper} />
          {/* Monitor: dark rounded screen frame with a green download arrow. */}
          <rect x="42" y="22" width="62" height="44" rx="7" fill="#ffffff" stroke={ink} strokeWidth="4" />
          <path d="M73 32v14" stroke={green} strokeWidth="4" strokeLinecap="round" />
          <path
            d="M66 41l7 8 7-8"
            stroke={green}
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Desk line under the monitor, then the cable into the board's plug. */}
          <path d="M28 72h84" stroke={ink} strokeWidth="4" strokeLinecap="round" />
          <path
            d="M112 72h30c9 0 6 12 14 12"
            stroke={ink}
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* USB plug nub, drawn before the board so only its left half shows. */}
          <rect x="150" y="70" width="18" height="16" rx="4" fill="#ffffff" stroke={ink} strokeWidth="4" />
          {/* Controller board: white body, green outline, green chip, amber LED. */}
          <rect x="168" y="26" width="40" height="56" rx="8" fill="#ffffff" stroke={green} strokeWidth="4" />
          <rect x="181" y="38" width="15" height="14" rx="3" fill={green} />
          <circle cx="176" cy="74" r="3" fill="#d97706" />
          {/* Three header pins on top of the board. */}
          <g stroke={green} strokeWidth="4" strokeLinecap="round">
            <path d="M178 26V16" />
            <path d="M188 26V16" />
            <path d="M198 26V16" />
          </g>
          {active && (
            <circle
              className="hc-usb-write"
              cx="188"
              cy="49"
              r="30"
              fill="none"
              stroke={green}
              strokeWidth="2"
            />
          )}
        </svg>
      </div>
    </div>
  );
}

export interface UsbFlashBoardCheckLine {
  result: "match" | "mismatch" | "unverified";
  /** One sentence describing what was found. */
  headline: string;
  /** The user chose "Force to Flash" after the mismatch warning. */
  forced: boolean;
}

export function UsbFlashStagePipeline({
  stage,
  percent,
  phase,
  chipDetected,
  flashSize,
  bytesWritten,
  totalBytes,
  logs,
  error,
  onRetry,
  boardCheck,
}: {
  stage: UsbFlashStage;
  percent: number;
  phase: string;
  chipDetected?: string | null;
  flashSize?: string | null;
  bytesWritten?: number;
  totalBytes?: number;
  logs: string[];
  error?: string | null;
  onRetry?: () => void;
  /** Result of comparing the connected board with the selected one. */
  boardCheck?: UsbFlashBoardCheckLine | null;
}) {
  const boardDiffers = boardCheck?.result === "mismatch";
  const order = USB_STAGES.map((s) => s.id);
  const currentIdx = stage === "idle" ? -1 : order.indexOf(stage);
  const isFlashingActive =
    stage !== "idle" && stage !== "completed" && stage !== "error";
  const clampedPct = Math.max(0, Math.min(100, Math.round(percent)));
  const activeStepNumber = stage === "idle" ? 0 : currentIdx >= 0 ? currentIdx + 1 : 1;

  return (
    <Frame spacing="sm">
      <FramePanel className="min-w-0 space-y-4 overflow-hidden">
        <UsbFlashIllustration active={isFlashingActive} />
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {isFlashingActive && (
              <span className="relative flex size-2.5 shrink-0">
                <span className="hc-pulse-ring absolute inline-flex h-full w-full rounded-full bg-primary" />
                <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
              </span>
            )}
            <span className="min-w-0 break-words text-xs font-semibold text-foreground">
              {phase || "Ready to connect over USB"}
            </span>
            {chipDetected && (
              <Badge
                variant={boardDiffers ? "warning-light" : "success-light"}
                radius="full"
                className="shrink-0"
              >
                <RiCpuLine className="size-3" aria-hidden="true" />
                {chipDetected} {flashSize ? `(${flashSize})` : ""}
              </Badge>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
            {totalBytes && totalBytes > 0 ? (
              <span>
                {Math.round((bytesWritten ?? 0) / 1024)} / {Math.round(totalBytes / 1024)} KB
              </span>
            ) : null}
            <span className="font-semibold text-foreground">{clampedPct}%</span>
          </div>
        </div>

        <Progress
          value={clampedPct}
          aria-label="USB firmware flash progress"
          className={cn(
            "h-2",
            stage === "error" && "[&>[data-slot=progress-indicator]]:bg-destructive",
            stage === "completed" && "[&>[data-slot=progress-indicator]]:bg-success",
            isFlashingActive && "[&>[data-slot=progress-indicator]]:hc-progress-shimmer"
          )}
        />

        <Stepper value={activeStepNumber} className="w-full min-w-0">
          <StepperNav
            data-testid="usb-stage-grid"
            className="grid w-full min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-2"
          >
            {USB_STAGES.map((item, idx) => {
              const stepNum = idx + 1;
              const isCompleted =
                stage === "completed" || (currentIdx > idx && stage !== "error");
              const isActive = stage === item.id && stage !== "completed";
              const isFailed =
                stage === "error" && (currentIdx === idx || (currentIdx === -1 && idx === 0));

              return (
                <StepperItem
                  key={item.id}
                  step={stepNum}
                  completed={isCompleted}
                  loading={isActive}
                  className={cn(
                    "relative min-w-0 flex-col items-start justify-start overflow-hidden rounded-lg border-l-2 px-3 py-2 text-left transition-all duration-300 not-last:flex-none",
                    isCompleted
                      ? "border-success/35 bg-success/10"
                      : isFailed
                        ? "border-destructive/40 bg-destructive/10"
                        : isActive
                          ? "hc-stage-active border-primary/55 bg-primary/10"
                          : "border-border bg-card opacity-75"
                  )}
                >
                  <div className="flex w-full min-w-0 items-center gap-1.5">
                    <StepperIndicator
                      className={cn(
                        "size-5 shrink-0 text-[10px]",
                        isCompleted && "bg-success text-white",
                        isFailed && "bg-destructive text-white",
                        isActive && "bg-primary text-primary-foreground"
                      )}
                    >
                      {isCompleted ? (
                        <RiCheckboxCircleFill className="size-3.5" aria-hidden="true" />
                      ) : isFailed ? (
                        <RiCloseCircleFill className="size-3.5" aria-hidden="true" />
                      ) : isActive ? (
                        <RiLoader4Line className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        stepNum
                      )}
                    </StepperIndicator>
                    <StepperTitle className="min-w-0 flex-1 whitespace-normal break-words text-[11px] leading-tight font-semibold">
                      {item.label}
                    </StepperTitle>
                  </div>
                  <StepperDescription className="mt-1 w-full whitespace-normal break-words text-[10px] leading-snug">
                    {item.detail}
                  </StepperDescription>
                </StepperItem>
              );
            })}
          </StepperNav>
        </Stepper>

        {boardCheck && (
          <p
            data-testid="usb-board-check"
            data-result={boardCheck.result}
            className={cn(
              "flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug",
              boardDiffers
                ? "border-warning/40 bg-warning/10 text-warning-foreground"
                : boardCheck.result === "match"
                  ? "border-success/30 bg-success/10 text-success-foreground"
                  : "border-border bg-muted/40 text-muted-foreground"
            )}
          >
            {boardDiffers ? (
              <RiAlertLine className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <RiShieldCheckLine className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0 break-words">
              <span className="font-semibold">Board check:</span> {boardCheck.headline}
              {boardCheck.forced && (
                <span className="font-semibold">
                  {/* Says only what has happened so far. */}
                  {stage === "completed"
                    ? " Flashed anyway at your request."
                    : stage === "error"
                      ? " Force to Flash was chosen, but the flash did not complete."
                      : " Flashing anyway at your request."}
                </span>
              )}
            </span>
          </p>
        )}

        {error && (
          <StatusAlert
            tone="danger"
            title={error}
            action={
              onRetry ? (
                <Button size="xs" variant="outline" onClick={onRetry}>
                  Retry Flash
                </Button>
              ) : undefined
            }
          >
            <span className="flex items-start gap-1.5 text-[11px]">
              <RiAlertLine className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                Use a data-capable USB cable, close any other tab or tool using the USB port, and hold <strong>BOOT</strong> while tapping <strong>RST</strong> if your controller asks for download mode.
              </span>
            </span>
          </StatusAlert>
        )}

        {logs.length > 0 && (
          <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] text-slate-200">
            <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-400">
              <span className="flex items-center gap-1.5">
                <RiTerminalBoxLine className="size-3.5" aria-hidden="true" />
                Connection Activity
              </span>
              {isFlashingActive && (
                <span className="flex items-center gap-1 text-emerald-400">
                  streaming
                  <span className="hc-caret-blink inline-block h-2.5 w-1.5 bg-emerald-400" />
                </span>
              )}
            </div>
            <div className="max-h-36 space-y-0.5 overflow-y-auto">
              {logs.map((line, i) => (
                <div key={i} className="break-words [overflow-wrap:anywhere] leading-relaxed">
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}
      </FramePanel>
    </Frame>
  );
}

const OTA_STAGES = [
  { key: "downloading", label: "Preparing", statuses: ["pending", "downloading"] },
  { key: "flashing", label: "Installing", statuses: ["flashing"] },
  { key: "verifying", label: "Checking", statuses: ["verifying"] },
  { key: "rebooting", label: "Restarting", statuses: ["rebooting"] },
  { key: "succeeded", label: "Complete", statuses: ["succeeded"] },
];

function friendlyOtaStatusMessage(status: FirmwareUpdateHistoryItem["status"]): string {
  switch (status) {
    case "pending":
      return "Connecting to your controller...";
    case "downloading":
      return "Preparing firmware...";
    case "flashing":
      return "Installing firmware...";
    case "verifying":
      return "Checking the update...";
    case "rebooting":
      return "Restarting your controller...";
    case "succeeded":
      return "Your controller is up to date.";
    case "rolled_back":
      return "The update could not be completed. Your previous firmware is still available.";
    case "failed":
      return "The update could not be completed. Your previous firmware is still available.";
    case "cancelled":
      return "Update cancelled";
    default:
      return String(status).replace("_", " ");
  }
}

export function OtaProgressPipeline({
  update,
  controllerName,
  onRetry,
  onCancel,
}: {
  update: FirmwareUpdateHistoryItem;
  controllerName?: string;
  onRetry?: () => void;
  onCancel?: () => void;
}) {
  const isError = update.status === "failed" || update.status === "rolled_back";
  const isCancelled = update.status === "cancelled";
  const isActiveOta = !isError && !isCancelled && update.status !== "succeeded";
  const stageIdx = OTA_STAGES.findIndex((s) => s.statuses.includes(update.status));
  const activeStepNumber = stageIdx >= 0 ? stageIdx + 1 : 1;

  return (
    <Frame spacing="sm" className="hc-step-enter">
      <FramePanel className="min-w-0 space-y-3 overflow-hidden">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            {isActiveOta && (
              <span className="relative flex size-2.5 shrink-0">
                <span className="hc-pulse-ring absolute inline-flex h-full w-full rounded-full bg-primary" />
                <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
              </span>
            )}
            <div className="min-w-0">
              <p className="break-words text-xs font-semibold text-foreground">
                {controllerName ?? "Controller"} · v{update.target_version}
              </p>
              <p className="text-[11px] text-muted-foreground">
                <span className="font-medium">{friendlyOtaStatusMessage(update.status)}</span>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge
              variant={
                update.status === "succeeded"
                  ? "success-light"
                  : isError
                    ? "destructive-light"
                    : isCancelled
                      ? "secondary"
                      : "primary-light"
              }
              radius="full"
              className="tabular-nums"
            >
              {isCancelled ? "Cancelled" : `${update.progress_percent}%`}
            </Badge>
            {update.status === "pending" && onCancel && (
              <Button size="xs" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            )}
            {(isError || isCancelled) && onRetry && (
              <Button size="xs" variant="outline" onClick={onRetry}>
                Retry Update
              </Button>
            )}
          </div>
        </div>

        <Progress
          value={update.progress_percent}
          aria-label="OTA firmware update progress"
          className={cn(
            "h-2",
            isError && "[&>[data-slot=progress-indicator]]:bg-destructive",
            update.status === "succeeded" && "[&>[data-slot=progress-indicator]]:bg-success",
            isActiveOta && "[&>[data-slot=progress-indicator]]:hc-progress-shimmer"
          )}
        />

        <Stepper value={activeStepNumber} className="w-full min-w-0">
          <StepperNav className="grid w-full min-w-0 grid-cols-2 gap-1.5 sm:grid-cols-5">
            {OTA_STAGES.map((st, idx) => {
              const done =
                update.status === "succeeded" || (!isError && stageIdx > idx);
              const active =
                !isError && stageIdx === idx && update.status !== "succeeded";
              return (
                <StepperItem
                  key={st.key}
                  step={idx + 1}
                  completed={done}
                  loading={active}
                  className={cn(
                    "min-w-0 justify-center overflow-hidden rounded-md border px-2 py-1.5 text-center text-[11px] font-medium transition-all duration-300 not-last:flex-none",
                    done
                      ? "border-success/35 bg-success/10 text-success-foreground"
                      : active
                        ? "hc-stage-active border-primary/55 bg-primary/10 text-primary"
                        : "border-border bg-muted/50 text-muted-foreground"
                  )}
                >
                  <div className="flex min-w-0 items-center justify-center gap-1">
                    {done ? (
                      <RiCheckboxCircleFill className="size-3 shrink-0" />
                    ) : active ? (
                      st.key === "rebooting" ? (
                        <RiRestartLine className="size-3 shrink-0 animate-spin" />
                      ) : st.key === "verifying" ? (
                        <RiShieldCheckLine className="size-3 shrink-0 animate-pulse" />
                      ) : st.key === "downloading" ? (
                        <RiWifiLine className="size-3 shrink-0 animate-pulse" />
                      ) : (
                        <RiLoader4Line className="size-3 shrink-0 animate-spin" />
                      )
                    ) : null}
                    <span className="truncate">{st.label}</span>
                  </div>
                </StepperItem>
              );
            })}
          </StepperNav>
        </Stepper>

        {isError && (
          <StatusAlert tone="danger">
            The update could not be completed. Your previous firmware is still available.
          </StatusAlert>
        )}
      </FramePanel>
    </Frame>
  );
}
