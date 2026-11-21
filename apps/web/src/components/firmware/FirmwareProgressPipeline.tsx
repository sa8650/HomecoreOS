import { useState } from "react";
import { UsbCableAnimation } from "@/components/graphics/ConnectionAnimations";
import {
  RiAlertLine,
  RiArrowDownSLine,
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
  StepperItem,
  StepperNav,
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

export function UsbFlashIllustration({
  active = false,
  size = "banner",
}: {
  active?: boolean;
  /** `banner` fills the dialog width; `sm` is the small status thumbnail; `none` hides it. */
  size?: "banner" | "sm" | "none";
}) {
  if (size === "none") return null;
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[10px] border border-blue-600/20 bg-blue-50/70 dark:border-blue-400/25 dark:bg-blue-950/40",
        size === "banner"
          ? "mb-4 flex h-[104px] w-full items-center justify-center"
          : "h-[51px] w-[68px] shrink-0"
      )}
      aria-label="USB connection illustration"
      data-testid="usb-flash-illustration"
      data-active={active ? "true" : "false"}
    >
      {/* Portrait artboard: in the banner it sits centred, tall enough to read
          the plug travel without stretching. */}
      <UsbCableAnimation
        active={active}
        className={cn(
          "block h-full w-auto",
          size === "banner" ? "py-1.5" : "",
          active ? "opacity-100" : "opacity-90"
        )}
      />
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
  const [showLogs, setShowLogs] = useState(false);
  const boardDiffers = boardCheck?.result === "mismatch";
  const order = USB_STAGES.map((s) => s.id);
  const currentIdx = stage === "idle" ? -1 : order.indexOf(stage);
  const clampedPct = Math.max(0, Math.min(100, Math.round(percent)));
  const barState =
    stage === "completed" ? "done" : stage === "error" ? "error" : "idle";

  return (
    <div className="min-w-0 space-y-3.5">
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            {error
              ? error
              : stage === "idle"
                ? "Waiting to start"
                : stage === "completed"
                  ? "Complete"
                  : phase || USB_STAGES[Math.max(0, currentIdx)]?.label}
          </span>
          <span className="flex shrink-0 items-center gap-2 tabular-nums">
            {totalBytes && totalBytes > 0 ? (
              <span className="text-[11px]">
                {Math.round((bytesWritten ?? 0) / 1024)} / {Math.round(totalBytes / 1024)} KB
              </span>
            ) : null}
            <strong className="font-semibold text-foreground">{clampedPct}%</strong>
          </span>
        </div>
        <div
          className="flow-bar"
          data-state={barState}
          role="progressbar"
          aria-label="USB firmware flash progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={clampedPct}
        >
          <i style={{ width: `${clampedPct}%` }} />
        </div>
      </div>

      {chipDetected && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={boardDiffers ? "warning-light" : "success-light"} radius="full">
            <RiCpuLine className="size-3" aria-hidden="true" />
            {chipDetected} {flashSize ? `(${flashSize})` : ""}
          </Badge>
          {boardCheck && (
            <Badge variant={boardDiffers ? "warning-light" : "outline"} radius="full">
              Board check: {boardCheck.result}
            </Badge>
          )}
        </div>
      )}

      <ol className="flow-steps" data-testid="usb-stage-grid">
        {USB_STAGES.map((item, idx) => {
          const stepNum = idx + 1;
          const isCompleted =
            stage === "completed" || (currentIdx > idx && stage !== "error");
          const isActive = stage === item.id && stage !== "completed";
          const isFailed =
            stage === "error" && (currentIdx === idx || (currentIdx === -1 && idx === 0));
          const state = isCompleted ? "done" : isFailed ? "error" : isActive ? "active" : "pending";
          const statusText =
            state === "done"
              ? "Done"
              : state === "error"
                ? "Stopped"
                : state === "active"
                  ? "In progress"
                  : "";

          return (
            <li key={item.id} className="flow-step" data-state={state} data-step={item.id}>
              <span className="flow-node" aria-hidden="true">
                <span data-step-number>{stepNum}</span>
                {state === "done" && <RiCheckboxCircleFill className="size-3.5" />}
                {state === "error" && <RiCloseCircleFill className="size-3.5" />}
              </span>
              <div className="min-w-0">
                <p className="flow-step-title">{item.label}</p>
                <p className="flow-step-detail">{item.detail}</p>
              </div>
              <span className="flow-step-state">{statusText}</span>
            </li>
          );
        })}
      </ol>

      {boardCheck && (
        <p
          data-testid="usb-board-check"
          data-result={boardCheck.result}
          className={cn(
            "flex items-start gap-1.5 rounded-[10px] border px-2.5 py-2 text-[11px] leading-snug",
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
        <div role="alert" className="space-y-2 rounded-[10px] border border-destructive/25 bg-destructive/8 px-3 py-2.5">
          <p className="text-xs leading-relaxed text-destructive-foreground">
            Use a data-capable USB cable, close any other tab or tool using the USB port, and hold{" "}
            <strong>BOOT</strong> while tapping <strong>RST</strong> if your board asks for download
            mode.
          </p>
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RiRestartLine className="size-3.5" aria-hidden="true" />
              Retry Flash
            </Button>
          )}
        </div>
      )}

      {logs.length > 0 && (
        <div className="flow-console" data-open={showLogs ? "true" : "false"}>
          <button
            type="button"
            className="flow-console-head"
            aria-expanded={showLogs}
            onClick={() => setShowLogs((v) => !v)}
          >
            <RiTerminalBoxLine className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>Log</span>
            <Badge variant="outline" size="xs" radius="full">
              {logs.length}
            </Badge>
            <RiArrowDownSLine
              className={cn(
                "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
                showLogs && "rotate-180"
              )}
              aria-hidden="true"
            />
          </button>
          {showLogs && (
            <div className="flow-console-lines" role="log" aria-label="Flash log">
              {logs.map((line, i) => {
                const parsed = /^\[(?<ts>[^\]]+)\]\s+(?<level>INFO|DEBUG|WARN|ERROR|OK)\s+(?<msg>.*)$/.exec(line);
                if (!parsed?.groups) {
                  return (
                    <div key={i} className="ln">
                      <span className="text-[#71717a]" />
                      <span className="lv-DEBUG">LOG</span>
                      <span>{line}</span>
                    </div>
                  );
                }
                const { ts, level, msg } = parsed.groups as {
                  ts: string;
                  level: string;
                  msg: string;
                };
                return (
                  <div key={i} className="ln">
                    <span className="text-[#71717a]">{ts}</span>
                    <span className={cn("font-medium", `lv-${level}`)}>{level}</span>
                    <span>{msg}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
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
