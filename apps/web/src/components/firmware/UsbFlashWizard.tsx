import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  RiCheckLine,
  RiErrorWarningLine,
  RiInformationLine,
  RiLoader4Line,
} from "@remixicon/react";
import {
  chipFamilyLabel,
  evaluateReleaseCompatibilityForBoard,
  supportsBleProvisioningForBoard,
  usbBoardMismatchImpact,
} from "@homecoreos/shared";
import { toast } from "sonner";
import { cachedGet, invalidateApiCache } from "@/lib/api";
import { cn } from "@/lib/utils";
import { isWebSerialSupported, UsbBoardMismatchError, type UsbFlashTargetBoardSpec } from "@/lib/usb-flasher";
import { useUsbFlashSession } from "@/lib/use-usb-flash";
import {
  UsbFlashIllustration,
  UsbFlashStagePipeline,
} from "@/components/firmware/FirmwareProgressPipeline";
import {
  UsbBoardMismatchPanel,
  describeForcedFlashOutcome,
} from "@/components/firmware/UsbBoardMismatchPanel";
import { StatusAlert } from "@/components/shared/AppUi";
import { Onboarding } from "@/components/ui/onboarding";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { BoardProfileItem, FirmwareReleaseItem } from "@/features/types";

export type UsbFlashWizardState = {
  /** 0 = board + firmware picker, 1 = USB write, 2 = done. */
  step: number;
  /** True while firmware is streaming. */
  busy: boolean;
  /** Board and factory image chosen, so the flow can move on. */
  ready: boolean;
  /** The write can actually run: chosen, supported browser and allowed. */
  writable: boolean;
  /** The write finished and the board is ready for setup. */
  completed: boolean;
  /** A forced write onto the wrong chip leaves a board that cannot pair. */
  forcedWillNotStart: boolean;
  /** Stopped at the board check, waiting for the mismatch answer. */
  paused: boolean;
};

export type UsbFlashWizardHandle = {
  /** True while firmware is streaming to the controller. */
  isBusy: () => boolean;
  /** 0-based index of the visible step, for the dialog's progress rail. */
  stepIndex: () => number;
  /** Advances one step, only when the current step allows it. */
  next: () => void;
  /** Previous step, or out of the flasher when already on the first. */
  back: () => void;
  /** Starts the USB write (only possible once the board and image are chosen). */
  startFlash: () => void;
  /** Back to the board picker after a finished write. */
  restart: () => void;
  /** Drops a paused board-mismatch prompt (the safe answer: write nothing). */
  settlePendingDecision: () => void;
};

type LoadedData = {
  releases: FirmwareReleaseItem[];
  boards: BoardProfileItem[];
};

/** True when a published USB factory image can be written to this board. */
function releaseSupportsBoard(
  release: FirmwareReleaseItem,
  board: { id?: string | null; slug?: string | null; chip_family?: string | null }
): boolean {
  if (!release.usb_available || !board.slug) return false;
  if (release.compatible_boards && release.compatible_boards.length > 0) {
    return release.compatible_boards.some((b) => b.slug === board.slug);
  }
  if (release.compatible_board_ids.length > 0) {
    return Boolean(board.id) && release.compatible_board_ids.includes(board.id!);
  }
  return release.chip_family === board.chip_family;
}

/**
 * The Browser USB Factory Flasher workflow (Web Serial), extracted from the
 * Firmware page so it can live inside the unified controller action modal.
 *
 * Everything the flasher needs is owned here: the USB release catalog, board
 * compatibility detection, chip verification, mismatch protection, the erase
 * option, progress pipeline, logs and the completion screen.
 */
export const UsbFlashWizard = forwardRef<
  UsbFlashWizardHandle,
  {
    canManage: boolean;
    /** Preselected factory release, when opened from a specific release. */
    initialReleaseId?: string;
    /**
     * The board to start on, when the controller action was opened from an
     * existing controller (its Board Library profile slug).
     */
    initialBoardSlug?: string;
    /** Step 3 / navigation: carry on to provisioning after a successful flash. */
    onContinueToSetup: () => void;
    /** Back to the action picker (only reachable while nothing is streaming). */
    onBack: () => void;
    /**
     * What the dialog needs to draw its progress rail and its footer: which
     * step is visible, whether a write is running and what the next action is.
     */
    onStateChange?: (state: UsbFlashWizardState) => void;
  }
>(function UsbFlashWizard(
  { canManage, initialReleaseId, initialBoardSlug, onContinueToSetup, onBack, onStateChange },
  ref
) {
  const [data, setData] = useState<LoadedData>({ releases: [], boards: [] });
  const [loading, setLoading] = useState(true);
  const [usbStep, setUsbStep] = useState(1);
  const [usbReleaseId, setUsbReleaseId] = useState(initialReleaseId ?? "");
  const [usbBoardSlug, setUsbBoardSlug] = useState(initialBoardSlug ?? "");
  const [eraseAll, setEraseAll] = useState(false);

  const {
    flashing,
    flashStage,
    flashPhase,
    flashProgress,
    flashLogs,
    chipDetected,
    flashSize,
    bytesWritten,
    totalBytes,
    flashError,
    capturedSetupInfo,
    boardReport,
    boardMismatch,
    forcedFlash,
    stoppedOnMismatch,
    decideBoardMismatch,
    startUsbFlash,
  } = useUsbFlashSession();

  const serialSupport = isWebSerialSupported();

  const { releases, boards } = data;
  const usbReleases = useMemo(() => releases.filter((r) => r.usb_available), [releases]);

  const loadReleases = useCallback(async (force = false) => {
    try {
      const [relRes, catRes, custRes] = await Promise.all([
        cachedGet<{ releases: FirmwareReleaseItem[] }>("/api/firmware/releases", {
          ttlMs: 60_000,
          force,
        }),
        cachedGet<{ boards: BoardProfileItem[] }>("/api/board-library/catalog", {
          ttlMs: 60_000,
          force,
        }).catch(() => ({ boards: [] as BoardProfileItem[] })),
        cachedGet<{ boards: BoardProfileItem[] }>("/api/board-library/custom", {
          ttlMs: 60_000,
          force,
        }).catch(() => ({ boards: [] as BoardProfileItem[] })),
      ]);
      setData({ releases: relRes.releases, boards: [...catRes.boards, ...custRes.boards] });
      // No factory image is preselected: the board is chosen first and its
      // compatible firmware follows. A release passed in explicitly wins.
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to load USB factory firmware releases."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReleases();
  }, [loadReleases]);

  const selectedUsbRelease = useMemo(
    () => releases.find((r) => r.id === usbReleaseId) ?? null,
    [releases, usbReleaseId]
  );

  // Board first: every board in the library can be picked, then the firmware
  // list shrinks to the releases that actually support that board.
  const usbBoards = useMemo(() => {
    // Catalog and custom endpoints can expose the same board. Radix Select
    // requires unique values; duplicate slugs made choosing those rows
    // unreliable. Prefer the first (catalog) profile and render one row.
    const uniqueBoards = new Map<string, BoardProfileItem>();
    for (const board of boards) {
      if (board.slug && !uniqueBoards.has(board.slug)) uniqueBoards.set(board.slug, board);
    }
    return [...uniqueBoards.values()].sort((a, b) =>
      `${a.manufacturer} ${a.model}`.localeCompare(`${b.manufacturer} ${b.model}`)
    );
  }, [boards]);

  const usbTargetBoard = useMemo(
    () => usbBoards.find((b) => b.slug === usbBoardSlug) ?? null,
    [usbBoards, usbBoardSlug]
  );

  const releasesForBoard = useMemo(
    () => (usbTargetBoard ? usbReleases.filter((r) => releaseSupportsBoard(r, usbTargetBoard)) : []),
    [usbReleases, usbTargetBoard]
  );

  // Choosing a board selects the factory image that was built for it. A release
  // the user picked by hand is kept as long as it still supports the board.
  useEffect(() => {
    if (!usbTargetBoard) {
      if (usbBoardSlug === "") setUsbReleaseId("");
      return;
    }
    setUsbReleaseId((prev) => {
      const stillValid = releasesForBoard.some((r) => r.id === prev);
      if (stillValid) return prev;
      const exact =
        releasesForBoard.find((r) => r.target_board_slug === usbTargetBoard.slug) ??
        releasesForBoard[0];
      return exact?.id ?? "";
    });
  }, [usbTargetBoard, releasesForBoard, usbBoardSlug]);

  // What the shared compatibility rules say about this board + image pair.
  const compatibility = useMemo(() => {
    if (!usbTargetBoard || !selectedUsbRelease) return null;
    return evaluateReleaseCompatibilityForBoard({
      release: selectedUsbRelease,
      board: usbTargetBoard,
      requirePublished: false,
    });
  }, [usbTargetBoard, selectedUsbRelease]);

  // After an attempt that stopped on a board mismatch: the board selected now,
  // when it is one the check found to fit the connected hardware exactly.
  const stoppedMatchLabel =
    stoppedOnMismatch && boardReport && usbTargetBoard
      ? (boardReport.recommended.find(
          (r) =>
            r.exact &&
            ((Boolean(r.board.id) && r.board.id === usbTargetBoard.id) ||
              (Boolean(r.board.slug) && r.board.slug === usbTargetBoard.slug))
        )?.label ?? null)
      : null;

  // After a forced flash onto another chip the controller cannot start, which
  // decides what the last step offers next.
  const forcedFlashWillNotStart =
    forcedFlash &&
    boardReport !== null &&
    usbBoardMismatchImpact(boardReport.mismatches) === "will_not_start";

  const canAdvance = Boolean(usbTargetBoard && usbReleaseId);

  // Tell the dialog which step is visible: it draws the progress rail and the
  // one footer every step shares.
  const completed = flashStage === "completed";
  useEffect(() => {
    onStateChange?.({
      step: usbStep - 1,
      busy: flashing,
      ready: Boolean(usbTargetBoard && usbReleaseId),
      writable:
        Boolean(usbTargetBoard && usbReleaseId) && serialSupport.supported && canManage,
      completed,
      forcedWillNotStart: forcedFlashWillNotStart,
      paused: Boolean(boardMismatch),
    });
  }, [
    onStateChange,
    usbStep,
    flashing,
    usbTargetBoard,
    usbReleaseId,
    serialSupport.supported,
    canManage,
    completed,
    forcedFlashWillNotStart,
    boardMismatch,
  ]);

  // The dialog drives the shared footer through this handle, so it stays a
  // stable object: each action reads the latest state through a ref.
  const latest = useRef({ flashing, usbStep, canAdvance, flashStage, onBack, boardMismatch, decideBoardMismatch, handleUsbFlash });
  latest.current = { flashing, usbStep, canAdvance, flashStage, onBack, boardMismatch, decideBoardMismatch, handleUsbFlash };

  useImperativeHandle(
    ref,
    () => ({
      isBusy: () => latest.current.flashing,
      stepIndex: () => latest.current.usbStep - 1,
      next: () => {
        const l = latest.current;
        if (l.flashing) return;
        setUsbStep((s) => {
          if (s === 1) return l.canAdvance ? 2 : s;
          if (s === 2) return l.flashStage === "completed" ? 3 : s;
          return s;
        });
      },
      back: () => {
        const l = latest.current;
        if (l.flashing) return;
        if (l.usbStep <= 1) {
          l.onBack();
          return;
        }
        setUsbStep((s) => Math.max(1, s - 1));
      },
      startFlash: () => {
        if (latest.current.flashing) return;
        void latest.current.handleUsbFlash();
      },
      restart: () => {
        if (latest.current.flashing) return;
        setUsbStep(1);
      },
      settlePendingDecision: () => {
        if (latest.current.boardMismatch) latest.current.decideBoardMismatch("cancel");
      },
    }),
    []
  );

  async function handleUsbFlash() {
    if (!selectedUsbRelease) return;
    setUsbStep(2);
    try {
      const result = await startUsbFlash({
        release: selectedUsbRelease,
        targetBoard: usbTargetBoard,
        // Used to recommend the right board when the connected one differs.
        candidateBoards: boards,
        eraseAll,
      });
      if (result.boardCheck?.forced) {
        toast.warning(
          `Firmware written to ${result.chipDetected} although it does not match the selected board.`
        );
      } else {
        toast.success(`Firmware installed cleanly on ${result.chipDetected}.`);
      }
      setUsbStep(3);
      invalidateApiCache("/api/firmware", "/api/board-instances");
      await loadReleases(true);
    } catch (err) {
      if (err instanceof UsbBoardMismatchError && err.cancelledByUser) {
        // Back to the selection, where the right board can be chosen.
        setUsbStep(1);
      }
      // Any other error is rendered by UsbFlashStagePipeline from the hook state.
    }
  }

  /** The USB release that can be installed on a board, if one is published. */
  function findUsbReleaseForBoard(board: UsbFlashTargetBoardSpec): FirmwareReleaseItem | null {
    // Prefer the release that is already selected, so only the board changes.
    if (selectedUsbRelease && releaseSupportsBoard(selectedUsbRelease, board)) {
      return selectedUsbRelease;
    }
    return usbReleases.find((r) => releaseSupportsBoard(r, board)) ?? null;
  }

  function handleUseRecommendedBoard(board: UsbFlashTargetBoardSpec) {
    const release = findUsbReleaseForBoard(board);
    if (!release || !board.slug) return;
    // Stops the paused flash; nothing has been written.
    decideBoardMismatch("cancel");
    setUsbReleaseId(release.id);
    setUsbBoardSlug(board.slug);
    setUsbStep(1);
    toast.info(
      `Switched to ${board.manufacturer ?? ""} ${board.model ?? board.slug}.`.replace(/\s+/g, " ")
    );
  }

  if (loading && usbReleases.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
        <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
        Loading factory firmware releases…
      </div>
    );
  }

  return (
    <Onboarding
      value={usbStep}
      onValueChange={setUsbStep}
      totalSteps={3}
      canGoNext={(s: number) =>
        s === 1
          ? Boolean(usbTargetBoard && usbReleaseId)
          : s === 2
            ? flashStage === "completed"
            : true
      }
      onComplete={onContinueToSetup}
      className="min-w-0 space-y-4 overflow-hidden border-0 bg-transparent p-0 shadow-none"
    >
      {!serialSupport.supported && (
        <StatusAlert tone="warning" title="This browser cannot flash over USB">
          {serialSupport.reason}
        </StatusAlert>
      )}

      <Onboarding.Step step={1} className="min-w-0 space-y-4">
        <UsbFlashIllustration />
        {stoppedOnMismatch && boardReport && (
          <StatusAlert
            tone={stoppedMatchLabel ? "info" : "warning"}
            title="Nothing was written to the controller"
          >
            {stoppedMatchLabel ? (
              <p>
                The connected board is{" "}
                <strong className="text-foreground">{boardReport.detected.summary}</strong>.{" "}
                {stoppedMatchLabel} is selected now and matches it. Connect again to install the
                firmware.
              </p>
            ) : (
              <p>
                The connected board is{" "}
                <strong className="text-foreground">{boardReport.detected.summary}</strong>, which
                does not match {boardReport.selected?.label ?? "the selected firmware"}.{" "}
                {boardReport.recommended[0]
                  ? `Recommended board: ${boardReport.recommended[0].label}.`
                  : "No board in your Board Library matches it yet."}{" "}
                Choose the matching board below, or connect the board you selected.
              </p>
            )}
          </StatusAlert>
        )}

        <div className="space-y-1.5">
          <label htmlFor="usb-board" className="block text-[13px] font-medium">
            Choose the board you are flashing
          </label>
          <Select
            value={usbBoardSlug || "__none__"}
            onValueChange={(v) => setUsbBoardSlug(v === "__none__" ? "" : v)}
            disabled={usbBoards.length === 0 || flashing}
          >
            <SelectTrigger id="usb-board" className="flow-trigger">
              <SelectValue placeholder="Select a board from your Board Library" />
            </SelectTrigger>
            <SelectContent
              position="popper"
              align="start"
              className="min-w-[var(--radix-select-trigger-width)]"
            >
              {usbBoards.length === 0 && (
                <SelectItem value="__none__">No boards in your Board Library</SelectItem>
              )}
              {usbBoards.map((board) => (
                <SelectItem key={board.slug} value={board.slug} className="py-2">
                  {board.manufacturer} {board.model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {usbTargetBoard && (
        <div className="space-y-1.5">
          <label htmlFor="usb-rel" className="block text-[13px] font-medium">
            Factory firmware for this board
          </label>
          <Select
            value={usbReleaseId || "__none__"}
            onValueChange={(v) => setUsbReleaseId(v === "__none__" ? "" : v)}
            disabled={!usbTargetBoard || releasesForBoard.length === 0 || flashing}
          >
            <SelectTrigger id="usb-rel" className="flow-trigger">
              {selectedUsbRelease ? (
                <span className="flex min-w-0 flex-col items-start leading-tight">
                  <span className="w-full truncate text-[13.5px] font-medium text-foreground">
                    {selectedUsbRelease.name} v{selectedUsbRelease.version}
                  </span>
                  <span className="w-full truncate text-[12px] text-muted-foreground">
                    {chipFamilyLabel(selectedUsbRelease.chip_family)} · {selectedUsbRelease.channel}
                  </span>
                </span>
              ) : (
                <SelectValue
                  placeholder={
                    usbTargetBoard ? "No matching factory firmware" : "Choose a board first"
                  }
                />
              )}
            </SelectTrigger>
            <SelectContent className="min-w-[var(--radix-select-trigger-width)]">
              {releasesForBoard.length === 0 && (
                <SelectItem value="__none__">No matching factory firmware</SelectItem>
              )}
              {releasesForBoard.map((r) => (
                <SelectItem key={r.id} value={r.id} className="py-2">
                  <span className="flex min-w-0 flex-col items-start gap-0.5">
                    <span className="w-full truncate text-[13px] font-medium">
                      {r.name} v{r.version}
                    </span>
                    <span className="w-full truncate text-[11.5px] text-muted-foreground">
                      {chipFamilyLabel(r.chip_family)} · {r.channel}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {releasesForBoard.length === 0 && (
            <p className="text-[12px] text-muted-foreground">
              No USB factory image is published for this board yet.
            </p>
          )}
        </div>
        )}

        {usbTargetBoard && selectedUsbRelease && compatibility && (
          <p
            className={cn(
              "flex items-start gap-1.5 rounded-[8px] px-2.5 py-2 text-[12px] leading-relaxed",
              compatibility.compatible
                ? "border border-success/25 bg-success/8 text-muted-foreground"
                : "border border-warning/40 bg-warning/10 text-warning-foreground"
            )}
          >
            <RiCheckLine
              className={cn(
                "mt-0.5 size-3.5 shrink-0",
                compatibility.compatible ? "text-success-foreground" : "hidden"
              )}
              aria-hidden="true"
            />
            <span>
              {compatibility.compatible ? (
                <>
                  <strong className="font-medium text-foreground">
                    {selectedUsbRelease.name} v{selectedUsbRelease.version}
                  </strong>{" "}
                  is built for this board.
                </>
              ) : (
                compatibility.reasons[0]
              )}
            </span>
          </p>
        )}

        {usbTargetBoard && (
          <div className="flex flex-wrap gap-1.5">
            <span className="inline-flex h-6 items-center rounded-md border bg-muted px-2 text-[12px] font-medium">
              <span className="mr-1 font-normal text-muted-foreground">BOOT:</span>GPIO
              {usbTargetBoard.boot_button_gpio ?? 0}
            </span>
            <span className="inline-flex h-6 items-center rounded-md border bg-muted px-2 text-[12px] font-medium">
              {usbTargetBoard.flash_size_mb}MB Flash
            </span>
            {usbTargetBoard.usb_interface && (
              <span className="inline-flex h-6 items-center rounded-md border bg-muted px-2 text-[12px] font-medium">
                {usbTargetBoard.usb_interface}
              </span>
            )}
            <span className="inline-flex h-6 items-center rounded-md border bg-muted px-2 text-[12px] font-medium">
              {usbTargetBoard.supports_wifi === false
                ? "No Wi-Fi radio"
                : supportsBleProvisioningForBoard(usbTargetBoard).supportsBle
                  ? "BLE + Wi-Fi"
                  : "Setup AP only"}
            </span>
          </div>
        )}

        {usbTargetBoard && (
          <div className="flex gap-2 rounded-[10px] border border-info/25 bg-info/8 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
            <RiInformationLine
              className="mt-0.5 size-4 shrink-0 text-info-foreground"
              aria-hidden="true"
            />
            <span>
              If the serial port does not enter download mode automatically, hold{" "}
              <code className="rounded border bg-card px-1 py-px font-mono text-[11px] text-foreground">
                BOOT
              </code>{" "}
              (GPIO{usbTargetBoard.boot_button_gpio ?? 0}) and tap{" "}
              <code className="rounded border bg-card px-1 py-px font-mono text-[11px] text-foreground">
                RESET/EN
              </code>{" "}
              before starting the flash.
            </span>
          </div>
        )}

        <div className="flex items-center gap-3 rounded-[10px] border px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium text-foreground">Chip erase before flashing</p>
            <p className="text-[12px] text-muted-foreground">Wipes all data on the board.</p>
          </div>
          <Switch
            id="usb-erase"
            checked={eraseAll}
            disabled={flashing}
            onCheckedChange={setEraseAll}
            aria-label="Chip erase before flashing"
          />
        </div>

        {eraseAll && (
          <p className="rounded-[8px] border border-warning/40 bg-warning/10 px-2.5 py-2 text-[12px] text-warning-foreground">
            All data will be erased. Adds about 20 seconds.
          </p>
        )}
      </Onboarding.Step>

      <Onboarding.Step step={2} className="min-w-0 space-y-4">
        <div className="flex items-center gap-3 rounded-[10px] border px-3 py-2.5">
          <UsbFlashIllustration size="sm" active={flashing} />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-medium text-foreground">
              {serialSupport.supported ? "Web Serial" : "Web Serial unavailable"}
              <span
                className={cn(
                  "inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium",
                  flashing
                    ? "border-info/40 bg-info/10 text-info-foreground"
                    : completed
                      ? "border-success/30 bg-success/10 text-success-foreground"
                      : "border-success/30 bg-success/10 text-success-foreground"
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    flashing ? "bg-info-foreground" : "bg-success-foreground"
                  )}
                />
                {flashing ? "Writing" : completed ? "Done" : "Ready"}
              </span>
            </p>
            <p className="truncate text-[12px] text-muted-foreground">
              {usbTargetBoard
                ? `Write ${selectedUsbRelease?.name ?? "firmware"} to ${usbTargetBoard.model}.`
                : "Connect your board with a USB cable."}
            </p>
          </div>
        </div>
        {boardMismatch && (
          <UsbBoardMismatchPanel
            report={boardMismatch}
            firmwareLabel={
              selectedUsbRelease
                ? `${selectedUsbRelease.name} v${selectedUsbRelease.version}`
                : "Selected firmware"
            }
            describeRecommendation={(board) =>
              findUsbReleaseForBoard(board)
                ? { canSwitch: true }
                : {
                    canSwitch: false,
                    note: "No USB firmware is published for this board yet.",
                  }
            }
            onCancel={() => decideBoardMismatch("cancel")}
            onForce={() => decideBoardMismatch("force")}
            onUseBoard={handleUseRecommendedBoard}
          />
        )}
        <UsbFlashStagePipeline
          stage={flashStage}
          percent={flashProgress}
          phase={flashPhase}
          chipDetected={chipDetected}
          flashSize={flashSize}
          bytesWritten={bytesWritten}
          totalBytes={totalBytes}
          logs={flashLogs}
          error={flashError}
          onRetry={() => void handleUsbFlash()}
          boardCheck={
            boardReport
              ? { result: boardReport.result, headline: boardReport.headline, forced: forcedFlash }
              : null
          }
        />
      </Onboarding.Step>

      <Onboarding.Step step={3} className="min-w-0 space-y-3">
        <div className="flex flex-col items-center pt-2 text-center">
          <span
            className={cn(
              "flex size-13 items-center justify-center rounded-full border",
              forcedFlash
                ? "border-warning/30 bg-warning/10 text-warning-foreground"
                : "border-success/30 bg-success/10 text-success-foreground"
            )}
          >
            {forcedFlash ? (
              <RiErrorWarningLine className="size-7" aria-hidden="true" />
            ) : (
              <RiCheckLine className="size-7" aria-hidden="true" />
            )}
          </span>
          <h3 className="mt-3 text-[17px] font-semibold tracking-[-0.01em] text-foreground">
            {forcedFlash ? "Flashed, but the board did not match" : "Factory Firmware Verified & Flashed"}
          </h3>
          <p className="mt-1 max-w-[380px] text-[13px] text-muted-foreground">
            {forcedFlash
              ? "The image was written and its checksum verified, but the board does not match what you selected."
              : "Your controller rebooted with HomecoreOS firmware. Continue to set up Bluetooth or Wi-Fi."}
          </p>
        </div>

        {forcedFlash && (
          <StatusAlert tone="warning" title="Firmware written to a board that does not match">
            <p>
              The image was written and its checksum verified, but the connected board
              {boardReport ? ` (${boardReport.detected.summary})` : ""} is not{" "}
              {boardReport?.selected?.label ?? "the selected board"}.{" "}
              {describeForcedFlashOutcome(boardReport)}
            </p>
          </StatusAlert>
        )}

        <div className="overflow-hidden rounded-[10px] border">
          {[
            ["Board", usbTargetBoard ? `${usbTargetBoard.manufacturer} ${usbTargetBoard.model}` : "—"],
            ["Firmware", selectedUsbRelease ? `${selectedUsbRelease.name} v${selectedUsbRelease.version}` : "—"],
            ["Chip detected", chipDetected || "—"],
            ["Transport", "USB · Web Serial"],
            ...(capturedSetupInfo?.bleName
              ? ([["Bluetooth name", capturedSetupInfo.bleName]] as [string, string][])
              : []),
          ].map(([label, value]) => (
            <div
              key={label}
              className="flex items-center justify-between gap-3 border-b px-3 py-2 text-[13px] last:border-0"
            >
              <span className="text-muted-foreground">{label}</span>
              <span className="min-w-0 truncate text-right font-medium text-foreground">
                {value}
              </span>
            </div>
          ))}
        </div>
      </Onboarding.Step>

    </Onboarding>
  );
});
