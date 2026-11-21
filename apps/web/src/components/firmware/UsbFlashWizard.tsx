import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import {
  RiArrowLeftLine,
  RiArrowRightLine,
  RiCheckDoubleLine,
  RiCpuLine,
  RiLoader4Line,
  RiPauseCircleLine,
  RiRefreshLine,
  RiUsbLine,
} from "@remixicon/react";
import {
  chipFamilyLabel,
  evaluateReleaseCompatibilityForBoard,
  supportsBleProvisioningForBoard,
  usbBoardMismatchImpact,
} from "@homecoreos/shared";
import { toast } from "sonner";
import { cachedGet, invalidateApiCache } from "@/lib/api";
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
import { Badge } from "@/components/reui/badge";
import { FormField, StatusAlert } from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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

export type UsbFlashWizardHandle = {
  /** True while firmware is streaming to the controller. */
  isBusy: () => boolean;
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
  }
>(function UsbFlashWizard(
  { canManage, initialReleaseId, initialBoardSlug, onContinueToSetup, onBack },
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

  useImperativeHandle(
    ref,
    () => ({
      isBusy: () => flashing,
      settlePendingDecision: () => {
        if (boardMismatch) decideBoardMismatch("cancel");
      },
    }),
    [flashing, boardMismatch, decideBoardMismatch]
  );

  const selectedUsbRelease = useMemo(
    () => releases.find((r) => r.id === usbReleaseId) ?? null,
    [releases, usbReleaseId]
  );

  // Board first: every board in the library can be picked, then the firmware
  // list shrinks to the releases that actually support that board.
  const usbBoards = useMemo(
    () =>
      [...boards].sort((a, b) =>
        `${a.manufacturer} ${a.model}`.localeCompare(`${b.manufacturer} ${b.model}`)
      ),
    [boards]
  );

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
      className="min-w-0 space-y-4 overflow-hidden border-0 p-0 shadow-none"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <Onboarding.StepIndicator variant="pills" className="w-28" />
        <Badge variant={serialSupport.supported ? "success-light" : "warning-light"} radius="full">
          {serialSupport.supported ? "Web Serial Ready" : "Unsupported Browser"}
        </Badge>
      </div>

      {!serialSupport.supported && <StatusAlert tone="warning">{serialSupport.reason}</StatusAlert>}

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
        <FormField id="usb-board" label="1. Choose the board you are flashing">
          <Select
            value={usbBoardSlug || "__none__"}
            onValueChange={(v) => setUsbBoardSlug(v === "__none__" ? "" : v)}
            disabled={usbBoards.length === 0 || flashing}
          >
            <SelectTrigger
              id="usb-board"
              className="w-full min-w-0 max-w-full [&_[data-slot=select-value]]:truncate"
            >
              <SelectValue placeholder="Select a board from your Board Library" />
            </SelectTrigger>
            <SelectContent>
              {usbBoards.length === 0 && (
                <SelectItem value="__none__">No boards in your Board Library</SelectItem>
              )}
              {usbBoards.map((b) => (
                <SelectItem key={b.slug} value={b.slug}>
                  {b.manufacturer} {b.model} ({chipFamilyLabel(b.chip_family)} · {b.flash_size_mb}MB)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        {usbTargetBoard && (
          <FormField
            id="usb-rel"
            label="2. Factory firmware for this board"
            hint={
              releasesForBoard.length > 0
                ? undefined
                : "No USB factory image is published for this board yet."
            }
          >
            <Select
              value={usbReleaseId || "__none__"}
              onValueChange={(v) => setUsbReleaseId(v === "__none__" ? "" : v)}
              disabled={releasesForBoard.length === 0 || flashing}
            >
              <SelectTrigger
                id="usb-rel"
                className="w-full min-w-0 max-w-full [&_[data-slot=select-value]]:truncate"
              >
                <SelectValue placeholder="No matching factory firmware" />
              </SelectTrigger>
              <SelectContent>
                {releasesForBoard.length === 0 && (
                  <SelectItem value="__none__">No matching factory firmware</SelectItem>
                )}
                {releasesForBoard.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name} v{r.version} ({chipFamilyLabel(r.chip_family)} · {r.channel})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}

        {usbTargetBoard && selectedUsbRelease && compatibility && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            <Badge
              variant={compatibility.compatible ? "success-light" : "warning-light"}
              size="xs"
            >
              <RiCpuLine className="size-3" aria-hidden="true" />
              {compatibility.compatible
                ? `Matches ${chipFamilyLabel(selectedUsbRelease.chip_family)} firmware`
                : "Check before flashing"}
            </Badge>
            {compatibility.compatible ? (
              <span>
                {selectedUsbRelease.name} v{selectedUsbRelease.version} is built for this board.
              </span>
            ) : (
              <span>{compatibility.reasons[0]}</span>
            )}
          </div>
        )}

        {usbTargetBoard && (
          <div className="space-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" size="xs">
                BOOT: GPIO{usbTargetBoard.boot_button_gpio ?? 0}
              </Badge>
              <Badge variant="outline" size="xs">
                {usbTargetBoard.flash_size_mb}MB Flash
              </Badge>
              {usbTargetBoard.usb_interface && (
                <Badge variant="outline" size="xs">
                  {usbTargetBoard.usb_interface}
                </Badge>
              )}
              {usbTargetBoard.supports_wifi === false ? (
                <Badge variant="warning-light" size="xs">
                  No Wi-Fi Radio
                </Badge>
              ) : supportsBleProvisioningForBoard(usbTargetBoard).supportsBle ? (
                <Badge variant="info-light" size="xs">
                  BLE + Wi-Fi
                </Badge>
              ) : (
                <Badge variant="outline" size="xs">
                  Setup AP Only (No BLE)
                </Badge>
              )}
            </div>
            <p className="text-[11px]">
              If the serial port does not enter download mode automatically, hold{" "}
              <strong className="text-foreground">
                BOOT (GPIO{usbTargetBoard.boot_button_gpio ?? 0})
              </strong>{" "}
              and tap <strong className="text-foreground">RESET/EN</strong> before clicking Connect.
            </p>
          </div>
        )}

        <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2.5">
          <Label htmlFor="usb-erase" className="cursor-pointer text-xs text-foreground">
            Full chip erase before flashing
          </Label>
          <Switch
            id="usb-erase"
            checked={eraseAll}
            disabled={flashing}
            onCheckedChange={setEraseAll}
          />
        </div>

        {/* No flash button on this page: the board and its image are chosen
            here, then Next starts the USB write on the flashing step. */}
        {usbTargetBoard && usbReleaseId && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Next installs{" "}
            <strong className="text-foreground">
              {selectedUsbRelease?.name} v{selectedUsbRelease?.version}
            </strong>{" "}
            on {usbTargetBoard.manufacturer} {usbTargetBoard.model}.
          </p>
        )}
      </Onboarding.Step>

      <Onboarding.Step step={2} className="min-w-0 space-y-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-foreground">
              {usbTargetBoard
                ? `Write ${selectedUsbRelease?.name ?? "firmware"} to ${usbTargetBoard.model}`
                : "USB installation"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              The browser verifies the chip before anything is written.
            </p>
          </div>
          <Button
            size="sm"
            disabled={
              !canManage || !serialSupport.supported || !usbTargetBoard || !usbReleaseId || flashing
            }
            onClick={() => void handleUsbFlash()}
          >
            {boardMismatch ? (
              <RiPauseCircleLine className="size-4" aria-hidden="true" />
            ) : flashing ? (
              <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <RiUsbLine className="size-4" aria-hidden="true" />
            )}
            {boardMismatch
              ? "Paused: board check"
              : flashing
                ? "Flashing via USB..."
                : "Flash board over USB"}
          </Button>
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
        {forcedFlash ? (
          <StatusAlert tone="warning" title="Firmware written to a board that does not match">
            <p>
              The image was written and its checksum verified, but the connected board
              {boardReport ? ` (${boardReport.detected.summary})` : ""} is not{" "}
              {boardReport?.selected?.label ?? "the selected board"}.{" "}
              {describeForcedFlashOutcome(boardReport)}
            </p>
          </StatusAlert>
        ) : (
          <StatusAlert tone="success" title="Factory Firmware Verified & Flashed">
            Your controller rebooted with HomecoreOS firmware. Continue to set up Bluetooth or
            Wi-Fi, or pair it later from the Controllers page.
          </StatusAlert>
        )}
        {capturedSetupInfo?.bleName && (
          <StatusAlert tone="info" title="Controller Ready">
            Bluetooth Name:{" "}
            <code className="rounded bg-background/80 px-1.5 py-0.5 font-mono font-bold">
              {capturedSetupInfo.bleName}
            </code>
          </StatusAlert>
        )}
      </Onboarding.Step>

      <Onboarding.Navigation className="flex items-center justify-between border-t pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={flashing}
          onClick={() => (usbStep <= 1 ? onBack() : setUsbStep((s) => Math.max(1, s - 1)))}
        >
          <RiArrowLeftLine className="size-3.5" aria-hidden="true" />
          {usbStep <= 1 ? "Back to options" : "Back"}
        </Button>
        {usbStep < 3 ? (
          <Button
            type="button"
            size="sm"
            disabled={
              usbStep === 1 ? !usbTargetBoard || !usbReleaseId : flashStage !== "completed"
            }
            onClick={() => setUsbStep((s) => Math.min(3, s + 1))}
          >
            Next
            <RiArrowRightLine className="size-3.5" aria-hidden="true" />
          </Button>
        ) : forcedFlashWillNotStart ? (
          // Pairing cannot work with firmware built for another chip, so the way
          // forward is the board selection, not the setup flow.
          <Button type="button" size="sm" onClick={() => setUsbStep(1)}>
            <RiRefreshLine className="size-3.5" aria-hidden="true" />
            Install again
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={onContinueToSetup}>
            <RiCheckDoubleLine className="size-3.5" aria-hidden="true" />
            Continue to Setup
          </Button>
        )}
      </Onboarding.Navigation>
    </Onboarding>
  );
});
