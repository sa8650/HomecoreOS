import { useCallback, useState } from "react";
import type { ParsedSerialSetupInfo } from "@/lib/ble-provisioning";
import {
  flashFreshControllerViaUsb,
  type UsbFlashStage,
  type UsbFlashTargetBoardSpec,
} from "@/lib/usb-flasher";
import type { FirmwareReleaseItem } from "@/features/types";

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

  const startUsbFlash = useCallback(
    async (params: {
      release: FirmwareReleaseItem;
      targetBoard?: UsbFlashTargetBoardSpec | null;
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
      setFlashStage("preparing_firmware");
      setFlashPhase("Initializing USB flasher...");

      try {
        return await flashFreshControllerViaUsb({
          release: params.release,
          targetBoard: params.targetBoard,
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
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "USB flash failed.";
        setFlashError(msg);
        setFlashPhase(`Failed: ${msg}`);
        setFlashLogs((prev) => [...prev, `ERROR: ${msg}`]);
        throw err;
      } finally {
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
    startUsbFlash,
    resetUsbFlash,
  };
}
