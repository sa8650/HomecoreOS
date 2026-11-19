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
  RiLoader4Line,
  RiPauseCircleLine,
  RiRefreshLine,
  RiUsbLine,
} from "@remixicon/react";
import {
  chipFamilyLabel,
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
    /** Step 3 / navigation: carry on to provisioning after a successful flash. */
    onContinueToSetup: () => void;
    /** Back to the action picker (only reachable while nothing is streaming). */
    onBack: () => void;
  }
>(function UsbFlashWizard({ canManage, initialReleaseId, onContinueToSetup, onBack }, ref) {
  const [data, setData] = useState<LoadedData>({ releases: [], boards: [] });
  const [loading, setLoading] = useState(true);
  const [usbStep, setUsbStep] = useState(1);
  const [usbReleaseId, setUsbReleaseId] = useState(initialReleaseId ?? "");
  const [usbBoardSlug, setUsbBoardSlug] = useState("");
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
        cachedGet<{ boards: BoardProfileItem[] }>("/api/boards/catalog", {
          ttlMs: 60_000,
          force,
        }).catch(() => ({ boards: [] as BoardProfileItem[] })),
        cachedGet<{ boards: BoardProfileItem[] }>("/api/boards/custom", {
          ttlMs: 60_000,
          force,
        }).catch(() => ({ boards: [] as BoardProfileItem[] })),
      ]);
      setData({ releases: relRes.releases, boards: [...catRes.boards, ...custRes.boards] });
      const firstUsb = relRes.releases.find((r) => r.usb_available);
      setUsbReleaseId((prev) => prev || firstUsb?.id || "");
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

  const usbMatchingBoards = useMemo(() => {
    if (!selectedUsbRelease) return [];
    if (
      selectedUsbRelease.compatible_boards &&
      selectedUsbRelease.compatible_boards.length > 0
    ) {
      return selectedUsbRelease.compatible_boards;
    }
    return boards.filter((b) =>
      selectedUsbRelease.compatible_board_ids.length > 0
        ? selectedUsbRelease.compatible_board_ids.includes(b.id)
        : b.chip_family === selectedUsbRelease.chip_family
    );
  }, [selectedUsbRelease, boards]);

  useEffect(() => {
    if (!selectedUsbRelease) {
      setUsbBoardSlug("");
      return;
    }
    const preferredSlug = selectedUsbRelease.target_board_slug || usbMatchingBoards[0]?.slug || "";
    setUsbBoardSlug((prev) =>
      prev && usbMatchingBoards.some((b) => b.slug === prev) ? prev : preferredSlug
    );
  }, [selectedUsbRelease, usbMatchingBoards]);

  const usbTargetBoard = useMemo(
    () =>
      boards.find((b) => b.slug === usbBoardSlug) ??
      usbMatchingBoards.find((b) => b.slug === usbBoardSlug) ??
      null,
    [boards, usbMatchingBoards, usbBoardSlug]
  );

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
      invalidateApiCache("/api/firmware", "/api/controllers");
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
    const supports = (r: FirmwareReleaseItem) => {
      if (!r.usb_available) return false;
      if (r.compatible_boards && r.compatible_boards.length > 0) {
        return r.compatible_boards.some((b) => b.slug === board.slug);
      }
      if (r.compatible_board_ids.length > 0) {
        return Boolean(board.id) && r.compatible_board_ids.includes(board.id!);
      }
      return r.chip_family === board.chip_family;
    };
    // Prefer the release that is already selected, so only the board changes.
    if (selectedUsbRelease && supports(selectedUsbRelease)) return selectedUsbRelease;
    return releases.find(supports) ?? null;
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
        s === 1 ? Boolean(usbReleaseId) : s === 2 ? flashStage === "completed" : true
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
        <FormField id="usb-rel" label="Factory Firmware Release">
          <Select
            value={usbReleaseId || "__none__"}
            onValueChange={(v) => setUsbReleaseId(v === "__none__" ? "" : v)}
            disabled={usbReleases.length === 0 || flashing}
          >
            <SelectTrigger
              id="usb-rel"
              className="w-full min-w-0 max-w-full [&_[data-slot=select-value]]:truncate"
            >
              <SelectValue placeholder="No USB factory releases published" />
            </SelectTrigger>
            <SelectContent>
              {usbReleases.length === 0 && (
                <SelectItem value="__none__">No USB factory releases published</SelectItem>
              )}
              {usbReleases.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name} v{r.version} ({chipFamilyLabel(r.chip_family)} · {r.channel})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        {usbMatchingBoards.length > 0 && (
          <FormField id="usb-board" label="Target Development Board">
            <Select
              value={usbBoardSlug || "__auto__"}
              onValueChange={(v) => setUsbBoardSlug(v === "__auto__" ? "" : v)}
              disabled={flashing}
            >
              <SelectTrigger
                id="usb-board"
                className="w-full min-w-0 max-w-full [&_[data-slot=select-value]]:truncate"
              >
                <SelectValue placeholder="Auto-detect compatible board" />
              </SelectTrigger>
              <SelectContent>
                {usbMatchingBoards.map((b) => (
                  <SelectItem key={b.slug} value={b.slug}>
                    {b.manufacturer} {b.model} ({b.flash_size_mb}MB · BOOT GPIO
                    {b.boot_button_gpio ?? 0})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
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

        <div className="flex justify-end">
          <Button
            disabled={!canManage || !serialSupport.supported || !usbReleaseId || flashing}
            onClick={() => void handleUsbFlash()}
          >
            <RiUsbLine className="size-4" aria-hidden="true" />
            Connect USB &amp; Flash Factory Image
          </Button>
        </div>
      </Onboarding.Step>

      <Onboarding.Step step={2} className="min-w-0 space-y-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Automatic verification and USB installation progress.
          </p>
          <Button
            size="sm"
            disabled={!canManage || !serialSupport.supported || !usbReleaseId || flashing}
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
                : "Start / Retry USB Flash"}
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
            disabled={usbStep === 1 ? !usbReleaseId : flashStage !== "completed"}
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
