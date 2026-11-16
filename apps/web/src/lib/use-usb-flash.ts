import { useCallback, useEffect, useRef, useState } from "react";
import type { ParsedSerialSetupInfo } from "@/lib/ble-provisioning";
import {
  flashFreshControllerViaUsb,
  UsbBoardMismatchError,
  type UsbBoardMismatchDecision,
  type UsbFlashBoardReport,
  type UsbFlashStage,
  type UsbFlashTargetBoardSpec,
} from "@/lib/usb-flasher";
import type { FirmwareReleaseItem } from "@/features/types";

/**
 * State of one browser USB flash, for a page that shows its progress.
 *
 * Contract for every page that uses this hook: when the connected board is
 * not the selected one, flashing pauses and `boardMismatch` is set. Nothing is
 * written until the page answers with `decideBoardMismatch("force" | "cancel")`,
 * so the page must show the warning (UsbBoardMismatchPanel) while
 * `boardMismatch` is set. Unmounting the page answers "cancel".
 */
export function useUsbFlashSession() {
  const [flashing, setFlashing] = useState(false);
  const [flashStage, setFlashStage] = useState<UsbFlashStage>("idle");
  const [flashPhase, setFlashPhase] = useState("");
  const [flashProgress, setFlashProgress] = useState(0);
  const [flashLogs, setFlashLogs] = useState<string[]>([]);
  const [chipDetected, setChipDetected] = useState<string | null>(null);
  const [flashSize, setFlashSize] = useState<string | null>(null);
  const [bytesWritten, setBytesWritten] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [flashError, setFlashError] = useState<string | null>(null);
  const [capturedSetupInfo, setCapturedSetupInfo] =
    useState<ParsedSerialSetupInfo | null>(null);
  // The identity check of the connected board against the selected one.
  const [boardReport, setBoardReport] = useState<UsbFlashBoardReport | null>(null);
  // Set while flashing is paused, waiting for the user to decide on a mismatch.
  const [boardMismatch, setBoardMismatch] = useState<UsbFlashBoardReport | null>(null);
  const [forcedFlash, setForcedFlash] = useState(false);
  const [stoppedOnMismatch, setStoppedOnMismatch] = useState(false);
  const decisionRef = useRef<((decision: UsbBoardMismatchDecision) => void) | null>(null);

  /** Answers the mismatch warning: "force" writes anyway, "cancel" stops. */
  const decideBoardMismatch = useCallback((decision: UsbBoardMismatchDecision) => {
    const resolve = decisionRef.current;
    decisionRef.current = null;
    setBoardMismatch(null);
    if (!resolve) return;
    if (decision === "force") setForcedFlash(true);
    resolve(decision);
  }, []);

  // Leaving the page must not leave a flash waiting (and the port open) forever.
  useEffect(
    () => () => {
      decisionRef.current?.("cancel");
      decisionRef.current = null;
    },
    []
  );

  const startUsbFlash = useCallback(
    async (params: {
      release: FirmwareReleaseItem;
      targetBoard?: UsbFlashTargetBoardSpec | null;
      /** Board Library profiles to recommend from when the board does not match. */
      candidateBoards?: UsbFlashTargetBoardSpec[];
      controllerId?: string;
      eraseAll?: boolean;
    }) => {
      setFlashing(true);
      setFlashError(null);
      setFlashLogs([]);
      setFlashProgress(0);
      setChipDetected(null);
      setFlashSize(null);
      setBytesWritten(0);
      setTotalBytes(0);
      setCapturedSetupInfo(null);
      setBoardReport(null);
      setBoardMismatch(null);
      setForcedFlash(false);
      setStoppedOnMismatch(false);
      setFlashStage("preparing_firmware");
      setFlashPhase("Initializing USB flasher...");

      try {
        return await flashFreshControllerViaUsb({
          release: params.release,
          targetBoard: params.targetBoard,
          candidateBoards: params.candidateBoards,
          controllerId: params.controllerId,
          eraseAll: params.eraseAll,
          callbacks: {
            onStage: setFlashStage,
            onPhase: setFlashPhase,
            onProgress: setFlashProgress,
            onLog: (line) => setFlashLogs((prev) => [...prev.slice(-80), line]),
            onChipDetected: (chip, size) => {
              setChipDetected(chip);
              setFlashSize(size ?? null);
            },
            onBytesProgress: (written, total) => {
              setBytesWritten(written);
              setTotalBytes(total);
            },
            onSetupCaptured: setCapturedSetupInfo,
            onBoardChecked: setBoardReport,
            // Flashing waits here until decideBoardMismatch() is called.
            onBoardMismatch: (report) =>
              new Promise<UsbBoardMismatchDecision>((resolve) => {
                decisionRef.current = resolve;
                setBoardMismatch(report);
              }),
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "USB flash failed.";
        if (err instanceof UsbBoardMismatchError && err.cancelledByUser) {
          // The user read the warning and stopped. Nothing was written.
          setStoppedOnMismatch(true);
          setFlashPhase("Stopped. Nothing was written to the controller.");
          setFlashLogs((prev) => [...prev, `STOPPED: ${msg}`]);
        } else {
          setFlashError(msg);
          setFlashPhase(`Failed: ${msg}`);
          setFlashLogs((prev) => [...prev, `ERROR: ${msg}`]);
        }
        throw err;
      } finally {
        decisionRef.current = null;
        setBoardMismatch(null);
        setFlashing(false);
      }
    },
    []
  );

  const resetUsbFlash = useCallback(() => {
    setFlashStage("idle");
    setFlashPhase("");
    setFlashProgress(0);
    setFlashLogs([]);
    setChipDetected(null);
    setFlashSize(null);
    setBytesWritten(0);
    setTotalBytes(0);
    setFlashError(null);
    setCapturedSetupInfo(null);
    setBoardReport(null);
    setForcedFlash(false);
    setStoppedOnMismatch(false);
  }, []);

  return {
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
    resetUsbFlash,
  };
}
