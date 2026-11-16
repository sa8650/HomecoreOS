import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  RiAlertLine,
  RiArrowLeftLine,
  RiArrowRightLine,
  RiBluetoothConnectLine,
  RiCheckLine,
  RiCheckboxCircleFill,
  RiCpuLine,
  RiErrorWarningLine,
  RiEyeLine,
  RiEyeOffLine,
  RiFileCopyLine,
  RiLoader4Line,
  RiRouterLine,
  RiShieldCheckLine,
  RiWifiLine,
} from "@remixicon/react";
import {
  supportsBleProvisioningForBoard,
  type BleCommandPayload,
  type BleDeviceInfoPayload,
  type BleStatusPayload,
} from "@homecoreos/shared";
import { apiFetch, ApiError } from "@/lib/api";
import {
  BleClientError,
  HomecoreBleClient,
  isWebBluetoothSupported,
} from "@/lib/ble-provisioning";
import { cn } from "@/lib/utils";
import type {
  BoardProfileItem,
  ControllerItem,
  HomeItem,
} from "@/features/types";
import { Badge } from "@/components/reui/badge";
import { Frame, FramePanel } from "@/components/reui/frame";
import { FormField, StatusAlert } from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type ControllerSetupView =
  | "entry"
  | "setup_ble"
  | "setup_wifi"
  | "recover_ble"
  | "recover_wifi";

type BleFlowScreen = "discover" | "wifi" | "progress";

type ProgressStepState = "pending" | "active" | "done" | "error";

const SETUP_PROGRESS_LABELS = [
  "1. Securely connecting to controller",
  "2. Saving Wi-Fi configuration",
  "3. Connecting controller to Wi-Fi",
  "4. Pairing controller with your HomecoreOS account",
  "5. Connecting controller to MQTT",
  "6. Verifying controller connection",
] as const;

const RECOVERY_PROGRESS_LABELS = [
  "1. Securely connecting to controller",
  "2. Saving Wi-Fi configuration",
  "3. Connecting controller to Wi-Fi",
  "4. Verifying controller recovery",
  "5. Connecting controller to MQTT",
  "6. Verifying controller connection",
] as const;

function normalizeHexSuffix(value?: string | null): string {
  return (value ?? "").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
}

function matchBoardForDeviceInfo(
  deviceInfo: BleDeviceInfoPayload | null,
  catalogBoards: BoardProfileItem[],
  customBoards: BoardProfileItem[]
): { kind: "catalog" | "custom"; board: BoardProfileItem } | null {
  const all: Array<{ kind: "catalog" | "custom"; board: BoardProfileItem }> = [
    ...catalogBoards.map((board) => ({ kind: "catalog" as const, board })),
    ...customBoards.map((board) => ({ kind: "custom" as const, board })),
  ];
  if (all.length === 0) return null;

  if (deviceInfo?.board) {
    const bySlug = all.find(
      (entry) => entry.board.slug.toLowerCase() === deviceInfo.board!.toLowerCase()
    );
    if (bySlug) return bySlug;
  }
  if (deviceInfo?.chip) {
    const byChip = all.find(
      (entry) =>
        entry.board.chip_family.toLowerCase() === deviceInfo.chip.toLowerCase() &&
        entry.board.supports_wifi !== false
    );
    if (byChip) return byChip;
  }
  return all.find((entry) => entry.board.supports_wifi !== false) ?? all[0];
}

function matchControllerByBleInfo(
  deviceInfo: BleDeviceInfoPayload | null,
  controllers: ControllerItem[],
  trashedControllers: ControllerItem[],
  explicitTarget?: ControllerItem | null
):
  | { kind: "active"; controller: ControllerItem }
  | { kind: "trashed"; controller: ControllerItem }
  | { kind: "missing" } {
  if (explicitTarget) {
    const activeMatch = controllers.find((c) => c.id === explicitTarget.id);
    if (activeMatch) return { kind: "active", controller: activeMatch };
    const trashedMatch = trashedControllers.find((c) => c.id === explicitTarget.id);
    if (trashedMatch) return { kind: "trashed", controller: trashedMatch };
    return { kind: "active", controller: explicitTarget };
  }

  const suffix = normalizeHexSuffix(deviceInfo?.mac_suffix);
  if (suffix.length >= 4) {
    const activeByMac = controllers.find((c) =>
      normalizeHexSuffix(c.hardware_uid).endsWith(suffix)
    );
    if (activeByMac) return { kind: "active", controller: activeByMac };

    const trashedByMac = trashedControllers.find((c) =>
      normalizeHexSuffix(c.hardware_uid).endsWith(suffix)
    );
    if (trashedByMac) return { kind: "trashed", controller: trashedByMac };
  }

  return { kind: "missing" };
}

function BleDiscoveryArtwork({
  mode,
  connected,
}: {
  mode: "setup" | "recover";
  connected?: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#2563eb] via-[#3b76f6] to-[#1d4ed8] px-6 py-7 text-white shadow-sm">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-12 -top-12 size-44 rounded-full bg-white/10 blur-2xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-14 -left-10 size-40 rounded-full bg-sky-300/15 blur-2xl"
      />

      <div className="relative flex flex-col items-center text-center">
        <div className="relative flex size-28 items-center justify-center">
          {/* Subtle concentric animated Bluetooth signal waves (respects prefers-reduced-motion) */}
          <span
            aria-hidden="true"
            className="hc-ble-wave absolute inset-0 rounded-full border border-white/35"
          />
          <span
            aria-hidden="true"
            className="hc-ble-wave-2 absolute inset-1.5 rounded-full border border-white/25"
          />
          <span
            aria-hidden="true"
            className="hc-ble-wave-3 absolute inset-3 rounded-full border border-white/20"
          />

          {/* Local lightweight HomecoreOS controller + Bluetooth badge SVG illustration */}
          <div className="relative z-10 flex size-20 items-center justify-center rounded-2xl border border-white/25 bg-white/12 shadow-inner backdrop-blur-xs">
            <svg
              viewBox="0 0 80 80"
              className="size-16"
              fill="none"
              aria-hidden="true"
            >
              {/* PCB outline */}
              <rect
                x="18"
                y="14"
                width="44"
                height="52"
                rx="7"
                fill="rgba(15, 23, 42, 0.42)"
                stroke="rgba(255,255,255,0.75)"
                strokeWidth="2"
              />
              {/* Antenna trace */}
              <path
                d="M28 14V9H52V14"
                stroke="rgba(191, 219, 254, 0.9)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* Side GPIO pins */}
              <g stroke="rgba(255,255,255,0.55)" strokeWidth="2" strokeLinecap="round">
                <line x1="13" y1="24" x2="17" y2="24" />
                <line x1="13" y1="32" x2="17" y2="32" />
                <line x1="13" y1="40" x2="17" y2="40" />
                <line x1="13" y1="48" x2="17" y2="48" />
                <line x1="13" y1="56" x2="17" y2="56" />
                <line x1="63" y1="24" x2="67" y2="24" />
                <line x1="63" y1="32" x2="67" y2="32" />
                <line x1="63" y1="40" x2="67" y2="40" />
                <line x1="63" y1="48" x2="67" y2="48" />
                <line x1="63" y1="56" x2="67" y2="56" />
              </g>
              {/* MCU / Bluetooth core */}
              <rect
                x="28"
                y="24"
                width="24"
                height="22"
                rx="4"
                fill="rgba(255,255,255,0.16)"
                stroke="rgba(255,255,255,0.65)"
                strokeWidth="1.5"
              />
              {/* Bluetooth rune inside chip */}
              <path
                d="M40 28V42M40 28L45 32.5L36 38M40 42L45 37.5L36 32"
                stroke="#ffffff"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* USB-C port */}
              <rect
                x="33"
                y="59"
                width="14"
                height="7"
                rx="2"
                fill="rgba(255,255,255,0.28)"
              />
              {/* BOOT / Recovery button */}
              <circle
                cx="53"
                cy="54"
                r="4"
                fill={mode === "recover" ? "#fbbf24" : "rgba(255,255,255,0.65)"}
                stroke="#ffffff"
                strokeWidth="1.4"
              />
              {mode === "recover" && (
                <circle
                  cx="53"
                  cy="54"
                  r="7"
                  stroke="#fde68a"
                  strokeWidth="1.4"
                  className="hc-boot-press"
                />
              )}
            </svg>
          </div>
        </div>

        <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium text-white backdrop-blur-xs">
          <RiBluetoothConnectLine className="size-3.5" aria-hidden="true" />
          <span>
            {connected
              ? "Connected over Bluetooth"
              : mode === "recover"
                ? "Bluetooth Controller Recovery"
                : "Bluetooth Controller Setup"}
          </span>
        </div>

        <h3 className="mt-3 text-lg font-semibold tracking-tight text-white">
          {mode === "recover"
            ? "Prepare Controller for Recovery"
            : "Discover HomecoreOS Controller"}
        </h3>
        <p className="mt-1.5 max-w-sm text-sm text-blue-50/95">
          {mode === "recover"
            ? "Hold the BOOT / Recovery button on your controller for 3 seconds."
            : "Turn on your HomecoreOS controller and keep it nearby."}
        </p>
      </div>
    </div>
  );
}

export function ControllerSetupModal({
  open,
  onClose,
  initialView = "entry",
  targetController = null,
  controllers = [],
  trashedControllers = [],
  homes = [],
  catalogBoards = [],
  customBoards = [],
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  initialView?: ControllerSetupView;
  targetController?: ControllerItem | null;
  controllers?: ControllerItem[];
  trashedControllers?: ControllerItem[];
  homes?: HomeItem[];
  catalogBoards?: BoardProfileItem[];
  customBoards?: BoardProfileItem[];
  onSuccess?: (message: string) => void;
}) {
  const [view, setView] = useState<ControllerSetupView>(initialView);
  const [bleScreen, setBleScreen] = useState<BleFlowScreen>("discover");

  // BLE discovery & connection state
  const [bleConnecting, setBleConnecting] = useState(false);
  const [bleError, setBleError] = useState<string | null>(null);
  const [bleErrorCode, setBleErrorCode] = useState<string | null>(null);
  const [connectedDeviceName, setConnectedDeviceName] = useState("");
  const [deviceInfo, setDeviceInfo] = useState<BleDeviceInfoPayload | null>(null);

  // Temporary Wi-Fi credentials — kept strictly in component React state and wiped on finish/cancel
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPass, setWifiPass] = useState("");
  const [showWifiPass, setShowWifiPass] = useState(false);

  // Automatic 6-step configuration state
  const [activeStepIdx, setActiveStepIdx] = useState(0);
  const [stepStates, setStepStates] = useState<ProgressStepState[]>(() =>
    Array.from({ length: 6 }, () => "pending")
  );
  const [progressError, setProgressError] = useState<string | null>(null);
  const [progressDone, setProgressDone] = useState(false);

  // Preserved Setup / Recover with Wi-Fi (192.168.4.1) state
  const [wifiPortalName, setWifiPortalName] = useState("HomecoreOS Controller");
  const [wifiPortalBoardChoice, setWifiPortalBoardChoice] = useState("");
  const [wifiPortalTargetId, setWifiPortalTargetId] = useState("");
  const [wifiPortalRecoverDeleted, setWifiPortalRecoverDeleted] = useState(false);
  const [wifiPortalCode, setWifiPortalCode] = useState<string | null>(null);
  const [wifiPortalControllerId, setWifiPortalControllerId] = useState<string | null>(null);
  const [wifiPortalBusy, setWifiPortalBusy] = useState(false);
  const [wifiPortalError, setWifiPortalError] = useState<string | null>(null);
  const [wifiPortalOnline, setWifiPortalOnline] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const clientRef = useRef<HomecoreBleClient | null>(null);
  const activeControllerIdRef = useRef<string | null>(null);
  const bleExpectedDisconnectRef = useRef(false);
  const disconnectRejectRef = useRef<((err: Error) => void) | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);

  const clearTimers = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const clearSensitiveState = useCallback(() => {
    clearTimers();
    bleExpectedDisconnectRef.current = true;
    disconnectRejectRef.current = null;
    clientRef.current?.disconnect();
    clientRef.current = null;
    activeControllerIdRef.current = null;
    setWifiSsid("");
    setWifiPass("");
    setShowWifiPass(false);
    setConnectedDeviceName("");
    setDeviceInfo(null);
    setBleError(null);
    setBleErrorCode(null);
    setProgressError(null);
    setProgressDone(false);
    setStepStates(Array.from({ length: 6 }, () => "pending"));
    setActiveStepIdx(0);
    setWifiPortalCode(null);
    setWifiPortalControllerId(null);
    setWifiPortalError(null);
    setWifiPortalOnline(false);
  }, [clearTimers]);

  // Reset cleanly on open/close and unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearTimers();
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, [clearTimers]);

  const wasOpenRef = useRef(false);
  const controllersRef = useRef(controllers);
  controllersRef.current = controllers;

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;

    if (justOpened) {
      clearSensitiveState();
      setView(initialView);
      setBleScreen("discover");
      if (targetController?.wifi_ssid) {
        setWifiSsid(targetController.wifi_ssid);
      }
      if (targetController?.id) {
        setWifiPortalTargetId(targetController.id);
        setWifiPortalRecoverDeleted(false);
      } else if (controllersRef.current.length > 0) {
        setWifiPortalTargetId(controllersRef.current[0].id);
        setWifiPortalRecoverDeleted(false);
      } else {
        setWifiPortalRecoverDeleted(true);
      }
    } else if (!open) {
      clearSensitiveState();
    }
  }, [open, initialView, targetController, clearSensitiveState]);

  const boardOptions = useMemo(() => {
    const list = [
      ...catalogBoards.map((b) => ({
        id: `catalog:${b.id}`,
        board: b,
        label: `${b.manufacturer} ${b.model}`,
      })),
      ...customBoards.map((b) => ({
        id: `custom:${b.id}`,
        board: b,
        label: `Custom: ${b.manufacturer} ${b.model}`,
      })),
    ];
    return list;
  }, [catalogBoards, customBoards]);

  useEffect(() => {
    if (!wifiPortalBoardChoice && boardOptions.length > 0) {
      const preferred =
        boardOptions.find((o) => o.board.supports_wifi !== false) ?? boardOptions[0];
      setWifiPortalBoardChoice(preferred.id);
    }
  }, [boardOptions, wifiPortalBoardChoice]);

  // Live poll controller online status when waiting on Setup/Recover with Wi-Fi (192.168.4.1)
  useEffect(() => {
    if (
      !open ||
      !wifiPortalControllerId ||
      (view !== "setup_wifi" && view !== "recover_wifi")
    ) {
      return;
    }
    let active = true;
    const poll = async () => {
      try {
        const res = await apiFetch<{ controller: ControllerItem }>(
          `/api/controllers/${wifiPortalControllerId}`
        );
        if (
          active &&
          res.controller &&
          res.controller.pairing_status === "paired" &&
          (res.controller.mqtt_connected || res.controller.status === "online")
        ) {
          setWifiPortalOnline(true);
        }
      } catch {
        // ignore transient poll failures
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [open, wifiPortalControllerId, view]);

  const bleSupport = isWebBluetoothSupported();
  const serverOrigin =
    typeof window !== "undefined" ? window.location.origin : "https://homecoreos.app";
  const isRecoveryBle = view === "recover_ble";
  const progressLabels = isRecoveryBle
    ? RECOVERY_PROGRESS_LABELS
    : SETUP_PROGRESS_LABELS;

  function setStepProgress(doneBeforeIdx: number, currentIdx: number, errorAtIdx?: number) {
    setActiveStepIdx(currentIdx);
    setStepStates(
      Array.from({ length: 6 }, (_, i) => {
        if (errorAtIdx !== undefined && i === errorAtIdx) return "error";
        if (i < doneBeforeIdx) return "done";
        if (i === currentIdx && errorAtIdx === undefined) return "active";
        return "pending";
      })
    );
  }

  function handleCloseModal() {
    clearSensitiveState();
    onClose();
  }

  function handleBackToEntry() {
    clearSensitiveState();
    setBleScreen("discover");
    setView("entry");
  }

  function handleBackToWifiDiscover() {
    bleExpectedDisconnectRef.current = true;
    clientRef.current?.disconnect();
    clientRef.current = null;
    setWifiPass("");
    setShowWifiPass(false);
    setConnectedDeviceName("");
    setDeviceInfo(null);
    setBleError(null);
    setBleErrorCode(null);
    setBleScreen("discover");
  }

  async function handleDiscoverBle() {
    setBleError(null);
    setBleErrorCode(null);

    if (!bleSupport.supported) {
      setBleErrorCode(bleSupport.code ?? "UNSUPPORTED");
      setBleError(
        bleSupport.reason ??
          "Web Bluetooth is unavailable in this browser. Switch to Wi-Fi setup below."
      );
      return;
    }

    if (targetController?.board_compat?.supports_ble === false) {
      setBleErrorCode("UNSUPPORTED");
      setBleError(
        `${targetController.board_model} does not have a Bluetooth radio. Use ${
          isRecoveryBle ? "Recover with Wi-Fi" : "Setup with Wi-Fi"
        } instead.`
      );
      return;
    }

    clientRef.current?.disconnect();
    bleExpectedDisconnectRef.current = false;
    const client = new HomecoreBleClient();
    clientRef.current = client;
    setBleConnecting(true);

    try {
      const candidatePins: string[] = [];
      if (targetController?.ble_setup_pin) {
        candidatePins.push(targetController.ble_setup_pin);
      }
      for (const c of controllers) {
        if (c.ble_setup_pin && !candidatePins.includes(c.ble_setup_pin)) {
          candidatePins.push(c.ble_setup_pin);
        }
      }

      const { deviceInfo: info } = await client.connectAndAuthenticate({
        candidatePins,
        onDisconnected: () => {
          if (!isMountedRef.current || bleExpectedDisconnectRef.current) return;
          if (disconnectRejectRef.current) {
            disconnectRejectRef.current(
              new BleClientError(
                "DISCONNECTED",
                "Bluetooth connection dropped during configuration. Keep your controller nearby and try again."
              )
            );
          } else {
            setBleErrorCode("DISCONNECTED");
            setBleError(
              "Bluetooth connection to the controller was lost. Click Discover BLE Controller to reconnect."
            );
            setBleScreen("discover");
          }
        },
      });

      // ESP32-H2 or non-Wi-Fi board check: keep unavailable as standalone Wi-Fi/MQTT controller
      if (info.wifi === false) {
        bleExpectedDisconnectRef.current = true;
        client.disconnect();
        clientRef.current = null;
        setBleErrorCode("UNSUPPORTED");
        setBleError(
          "This ESP32-H2 board has no integrated Wi-Fi radio and cannot be set up as a standalone Wi-Fi/MQTT HomecoreOS controller."
        );
        return;
      }

      const displayName =
        client.deviceName ||
        (info.mac_suffix ? `HomecoreOS-${info.mac_suffix}` : "HomecoreOS Controller");
      setConnectedDeviceName(displayName);
      setDeviceInfo(info);

      // In recovery mode, pre-fill known SSID if matched (never passwords)
      if (isRecoveryBle && !wifiSsid) {
        const matched = matchControllerByBleInfo(
          info,
          controllers,
          trashedControllers,
          targetController
        );
        if (matched.kind === "active" && matched.controller.wifi_ssid) {
          setWifiSsid(matched.controller.wifi_ssid);
        }
      }

      setBleScreen("wifi");
    } catch (err) {
      client.disconnect();
      clientRef.current = null;
      if (err instanceof BleClientError) {
        setBleErrorCode(err.code);
        setBleError(err.message);
      } else {
        setBleErrorCode("UNKNOWN");
        setBleError(
          err instanceof Error
            ? err.message
            : "Could not connect to a HomecoreOS controller over Bluetooth."
        );
      }
    } finally {
      if (isMountedRef.current) {
        setBleConnecting(false);
      }
    }
  }

  async function issuePairingAuthorization(
    isRecovery: boolean,
    info: BleDeviceInfoPayload | null,
    deviceLabel: string
  ): Promise<{ controllerId: string; pairingCode: string }> {
    const matched = matchControllerByBleInfo(
      info,
      controllers,
      trashedControllers,
      targetController
    );

    if (isRecovery) {
      if (matched.kind === "active") {
        activeControllerIdRef.current = matched.controller.id;
        const res = await apiFetch<{ controller: ControllerItem; pairingCode: string }>(
          "/api/controllers/recover",
          {
            method: "POST",
            body: JSON.stringify({ controllerId: matched.controller.id }),
          }
        );
        return { controllerId: res.controller.id, pairingCode: res.pairingCode };
      }

      if (matched.kind === "trashed") {
        const res = await apiFetch<{
          controller: ControllerItem;
          pairingCode?: string | null;
        }>(`/api/controllers/${matched.controller.id}/restore`, {
          method: "POST",
        });
        activeControllerIdRef.current = res.controller.id;
        if (res.pairingCode) {
          return { controllerId: res.controller.id, pairingCode: res.pairingCode };
        }
        const rec = await apiFetch<{ controller: ControllerItem; pairingCode: string }>(
          "/api/controllers/recover",
          {
            method: "POST",
            body: JSON.stringify({ controllerId: res.controller.id }),
          }
        );
        return { controllerId: rec.controller.id, pairingCode: rec.pairingCode };
      }

      // Permanently deleted or missing from account -> create a fresh recovery slot bound to user's account
      const matchedBoard = matchBoardForDeviceInfo(info, catalogBoards, customBoards);
      if (!matchedBoard) {
        throw new Error(
          "No compatible board profile is available in your catalog for this controller."
        );
      }
      const res = await apiFetch<{ controller: ControllerItem; pairingCode: string }>(
        "/api/controllers/recover",
        {
          method: "POST",
          body: JSON.stringify({
            name:
              activeControllerIdRef.current && targetController?.name
                ? targetController.name
                : deviceLabel || "Recovered Controller",
            homeId: homes[0]?.id,
            ...(matchedBoard.kind === "catalog"
              ? { boardCatalogId: matchedBoard.board.id }
              : { customBoardId: matchedBoard.board.id }),
          }),
        }
      );
      activeControllerIdRef.current = res.controller.id;
      return { controllerId: res.controller.id, pairingCode: res.pairingCode };
    }

    // New Controller Setup authorization
    if (activeControllerIdRef.current || targetController?.id) {
      const existingId = activeControllerIdRef.current ?? targetController!.id;
      activeControllerIdRef.current = existingId;
      const res = await apiFetch<{ pairingCode: string }>(
        `/api/controllers/${existingId}/regenerate-pairing-code`,
        { method: "POST" }
      );
      return { controllerId: existingId, pairingCode: res.pairingCode };
    }

    const matchedBoard = matchBoardForDeviceInfo(info, catalogBoards, customBoards);
    if (!matchedBoard) {
      throw new Error(
        "No compatible board profile is available in your catalog for this controller."
      );
    }

    const res = await apiFetch<{ controller: ControllerItem; pairingCode: string }>(
      "/api/controllers",
      {
        method: "POST",
        body: JSON.stringify({
          name: deviceLabel || matchedBoard.board.model,
          homeId: homes[0]?.id,
          ...(matchedBoard.kind === "catalog"
            ? { boardCatalogId: matchedBoard.board.id }
            : { customBoardId: matchedBoard.board.id }),
        }),
      }
    );
    activeControllerIdRef.current = res.controller.id;
    return { controllerId: res.controller.id, pairingCode: res.pairingCode };
  }

  async function waitForControllerOnlineOnBackend(controllerId: string): Promise<boolean> {
    const deadline = Date.now() + 18_000;
    while (Date.now() < deadline) {
      if (!isMountedRef.current) return false;
      try {
        const res = await apiFetch<{ controller: ControllerItem }>(
          `/api/controllers/${controllerId}`
        );
        const ctrl = res.controller;
        if (ctrl && ctrl.pairing_status === "paired" && ctrl.mqtt_connected) {
          return true;
        }
      } catch {
        // retry polling
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    return false;
  }

  async function sendAndAwaitBleStatus(
    client: HomecoreBleClient,
    command: BleCommandPayload,
    mode: "wifi_only" | "pair_or_recover"
  ): Promise<{ status: BleStatusPayload }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finishResolve = (val: { status: BleStatusPayload }) => {
        if (settled) return;
        settled = true;
        clearTimers();
        disconnectRejectRef.current = null;
        resolve(val);
      };
      const finishReject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        disconnectRejectRef.current = null;
        reject(err);
      };

      disconnectRejectRef.current = finishReject;

      timeoutRef.current = window.setTimeout(() => {
        finishReject(
          new BleClientError(
            "TIMEOUT",
            "Timed out waiting for the controller to connect. Verify your Wi-Fi network and try again."
          )
        );
      }, 45_000);

      client.onStatusUpdate(
        (st) => {
          if (st.state === "connecting_wifi") {
            setStepProgress(2, 2);
            return;
          }
          if (st.state === "wifi_failed") {
            finishReject(
              new Error(
                st.error || "Could not join Wi-Fi. Check your Wi-Fi password and router availability."
              )
            );
            return;
          }
          if (st.state === "wifi_connected") {
            if (mode === "wifi_only") {
              if (st.mqtt_connected) {
                bleExpectedDisconnectRef.current = true;
                setStepProgress(5, 5);
                finishResolve({ status: st });
              } else {
                setStepProgress(4, 4);
              }
            } else {
              setStepProgress(3, 3);
            }
            return;
          }
          if (st.state === "pairing") {
            if (st.paired && !st.mqtt_connected) {
              setStepProgress(4, 4);
            } else {
              setStepProgress(3, 3);
            }
            return;
          }
          if (st.state === "paired") {
            if (st.mqtt_connected) {
              bleExpectedDisconnectRef.current = true;
              setStepProgress(5, 5);
              finishResolve({ status: st });
            } else {
              // Paired with backend, waiting for MQTT authentication & broker handshake
              setStepProgress(4, 4);
            }
            return;
          }
          if (st.state === "error") {
            const failStep = st.paired ? 4 : st.wifi_connected ? 3 : 2;
            const err = new Error(
              st.error ||
                (st.paired
                  ? "Controller paired, but MQTT authentication or broker connection failed."
                  : "Controller pairing failed with HomecoreOS.")
            );
            (err as Error & { stepIdx?: number }).stepIdx = failStep;
            finishReject(err);
          }
        },
        () => {
          // Ignore transient status decryption issues while waiting
        }
      );

      void client
        .sendEncryptedCommand(command, { supportsWifi: true })
        .then(() => {
          setStepProgress(2, 2);
        })
        .catch((err) => {
          finishReject(err instanceof Error ? err : new Error("Failed to send Wi-Fi settings."));
        });
    });
  }

  async function handleSubmitBleWifi(e: FormEvent) {
    e.preventDefault();
    const cleanSsid = wifiSsid.trim();
    if (!cleanSsid) {
      setBleError("Enter your 2.4 GHz Wi-Fi network name (SSID).");
      return;
    }

    const client = clientRef.current;
    if (!client || !client.isConnected) {
      setBleErrorCode("DISCONNECTED");
      setBleError("Bluetooth connection to the controller was lost. Reconnect and try again.");
      setBleScreen("discover");
      return;
    }

    setBleError(null);
    setProgressError(null);
    setProgressDone(false);
    setBleScreen("progress");
    bleExpectedDisconnectRef.current = false;

    let currentErrorStep = 1;

    try {
      // Step 1 complete (secure BLE session established) -> Step 2 active (Saving Wi-Fi configuration)
      setStepProgress(1, 1);

      if (!isRecoveryBle) {
        // Setup with BLE: auto-generate pairing code from authenticated account & send encrypted payload
        const { controllerId, pairingCode } = await issuePairingAuthorization(
          false,
          deviceInfo,
          connectedDeviceName
        );
        currentErrorStep = 2;
        const { status } = await sendAndAwaitBleStatus(
          client,
          {
            action: "provision_wifi",
            ssid: cleanSsid,
            password: wifiPass,
            backend_url: serverOrigin,
            pair_code: pairingCode,
          },
          "pair_or_recover"
        );

        currentErrorStep = 4;
        setStepProgress(5, 5);
        const backendVerified =
          status.mqtt_connected && (await waitForControllerOnlineOnBackend(controllerId));
        if (!backendVerified) {
          const err = new Error(
            "Controller did not complete MQTT verification. Please check your network and retry."
          );
          (err as Error & { stepIdx?: number }).stepIdx = 4;
          throw err;
        }
      } else {
        // Recover with BLE: determine Case A (Wi-Fi changed only) vs Case B (Account / controller re-pair)
        const matched = matchControllerByBleInfo(
          deviceInfo,
          controllers,
          trashedControllers,
          targetController
        );
        const canTryWifiOnly =
          matched.kind === "active" &&
          matched.controller.pairing_status === "paired" &&
          Boolean(matched.controller.paired_at) &&
          deviceInfo?.paired !== false;

        let verifiedControllerId: string | null =
          matched.kind === "active" ? matched.controller.id : null;

        if (canTryWifiOnly && matched.kind === "active") {
          activeControllerIdRef.current = matched.controller.id;
          try {
            currentErrorStep = 2;
            await sendAndAwaitBleStatus(
              client,
              {
                action: "wifi_only",
                ssid: cleanSsid,
                password: wifiPass,
              },
              "wifi_only"
            );
          } catch (caseAErr) {
            const failStep =
              (caseAErr as Error & { stepIdx?: number }).stepIdx ?? currentErrorStep;
            // If Wi-Fi connected (step >= 3) but MQTT / pairing verification failed, auto-escalate to Case B re-pair!
            if (failStep >= 3 && client.isConnected) {
              setStepProgress(3, 3);
              const { controllerId, pairingCode } = await issuePairingAuthorization(
                true,
                deviceInfo,
                connectedDeviceName
              );
              verifiedControllerId = controllerId;
              currentErrorStep = 3;
              await sendAndAwaitBleStatus(
                client,
                {
                  action: "recover",
                  ssid: cleanSsid,
                  password: wifiPass,
                  backend_url: serverOrigin,
                  pair_code: pairingCode,
                  physical_confirm: true,
                },
                "pair_or_recover"
              );
            } else {
              throw caseAErr;
            }
          }
        } else {
          // Case B: Controller was deleted, in Trash, recovery_pending, or factory reset
          const { controllerId, pairingCode } = await issuePairingAuthorization(
            true,
            deviceInfo,
            connectedDeviceName
          );
          verifiedControllerId = controllerId;
          currentErrorStep = 2;
          await sendAndAwaitBleStatus(
            client,
            {
              action: "recover",
              ssid: cleanSsid,
              password: wifiPass,
              backend_url: serverOrigin,
              pair_code: pairingCode,
              physical_confirm: true,
            },
            "pair_or_recover"
          );
        }

        currentErrorStep = 5;
        setStepProgress(5, 5);
        if (verifiedControllerId) {
          const onlineOk = await waitForControllerOnlineOnBackend(verifiedControllerId);
          if (!onlineOk) {
            const err = new Error(
              "Controller connected to Wi-Fi, but MQTT verification with HomecoreOS did not succeed."
            );
            (err as Error & { stepIdx?: number }).stepIdx = 4;
            throw err;
          }
        }
      }

      // Clear sensitive temporary credentials immediately upon verified completion
      bleExpectedDisconnectRef.current = true;
      client.disconnect();
      clientRef.current = null;
      setWifiPass("");
      setShowWifiPass(false);
      setStepStates(Array.from({ length: 6 }, () => "done"));
      setActiveStepIdx(5);
      setProgressDone(true);
      onSuccess?.(
        `${connectedDeviceName || "Controller"} is connected and ready.`
      );
    } catch (err) {
      const explicitIdx = (err as Error & { stepIdx?: number }).stepIdx;
      const failIdx = explicitIdx ?? activeStepIdx ?? currentErrorStep;
      setStepProgress(failIdx, failIdx, failIdx);
      setProgressError(
        err instanceof Error
          ? err.message
          : "Could not complete controller configuration over Bluetooth."
      );
      // Wipe password if BLE disconnected so user reconnects cleanly
      if (err instanceof BleClientError && err.code === "DISCONNECTED") {
        setWifiPass("");
      }
    }
  }

  async function handleGenerateWifiPortalCode(e: FormEvent) {
    e.preventDefault();
    setWifiPortalBusy(true);
    setWifiPortalError(null);
    setWifiPortalOnline(false);

    try {
      if (view === "setup_wifi") {
        const [kind, id] = wifiPortalBoardChoice.split(":");
        if (!id) {
          throw new Error("Select a board model for this controller.");
        }
        const res = await apiFetch<{ controller: ControllerItem; pairingCode: string }>(
          "/api/controllers",
          {
            method: "POST",
            body: JSON.stringify({
              name: wifiPortalName.trim() || "HomecoreOS Controller",
              homeId: homes[0]?.id,
              boardCatalogId: kind === "catalog" ? id : undefined,
              customBoardId: kind === "custom" ? id : undefined,
            }),
          }
        );
        setWifiPortalControllerId(res.controller.id);
        setWifiPortalCode(res.pairingCode);
      } else if (view === "recover_wifi") {
        if (!wifiPortalRecoverDeleted && wifiPortalTargetId) {
          const res = await apiFetch<{ controller: ControllerItem; pairingCode: string }>(
            "/api/controllers/recover",
            {
              method: "POST",
              body: JSON.stringify({ controllerId: wifiPortalTargetId }),
            }
          );
          setWifiPortalControllerId(res.controller.id);
          setWifiPortalCode(res.pairingCode);
        } else {
          const [kind, id] = wifiPortalBoardChoice.split(":");
          if (!id) {
            throw new Error("Select the controller board model.");
          }
          const res = await apiFetch<{ controller: ControllerItem; pairingCode: string }>(
            "/api/controllers/recover",
            {
              method: "POST",
              body: JSON.stringify({
                name: wifiPortalName.trim() || "Recovered Controller",
                homeId: homes[0]?.id,
                boardCatalogId: kind === "catalog" ? id : undefined,
                customBoardId: kind === "custom" ? id : undefined,
              }),
            }
          );
          setWifiPortalControllerId(res.controller.id);
          setWifiPortalCode(res.pairingCode);
        }
      }
    } catch (err) {
      setWifiPortalError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not prepare pairing code."
      );
    } finally {
      setWifiPortalBusy(false);
    }
  }

  async function handleCopyText(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(key);
      window.setTimeout(() => {
        if (isMountedRef.current) setCopiedField(null);
      }, 1600);
    } catch {
      // clipboard unsupported in test/non-secure context
    }
  }

  const wifiAlternativeView: ControllerSetupView =
    view === "recover_ble" ? "recover_wifi" : "setup_wifi";

  function openChildView(nextView: ControllerSetupView) {
    clearSensitiveState();
    if (
      (nextView === "recover_ble" || nextView === "recover_wifi") &&
      targetController?.wifi_ssid
    ) {
      setWifiSsid(targetController.wifi_ssid);
    }
    if (targetController?.id) {
      setWifiPortalTargetId(targetController.id);
      setWifiPortalRecoverDeleted(false);
    } else if (controllersRef.current.length > 0) {
      setWifiPortalTargetId(controllersRef.current[0].id);
      setWifiPortalRecoverDeleted(false);
    }
    setBleScreen("discover");
    setView(nextView);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleCloseModal()}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        {view === "entry" && (
          <>
            <DialogHeader>
              <DialogTitle>Add or Recover Controller</DialogTitle>
              <DialogDescription>
                Choose how you want to set up a new controller or reconnect an existing one.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5">
              {/* Section 1: New Controller Setup */}
              <div className="space-y-2.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  New Controller Setup
                </p>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => openChildView("setup_ble")}
                    className="group flex flex-col items-start gap-2.5 rounded-xl border border-border bg-card p-4 text-left transition hover:border-primary/60 hover:bg-primary/5 cursor-pointer"
                  >
                    <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <RiBluetoothConnectLine className="size-5" aria-hidden="true" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">Setup with BLE</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Fast wireless setup from this browser using Bluetooth.
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => openChildView("setup_wifi")}
                    className="group flex flex-col items-start gap-2.5 rounded-xl border border-border bg-card p-4 text-left transition hover:border-primary/60 hover:bg-primary/5 cursor-pointer"
                  >
                    <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <RiWifiLine className="size-5" aria-hidden="true" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">Setup with Wi-Fi</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Setup by connecting to the controller&apos;s HomecoreOS-Setup-XXXX Wi-Fi network.
                      </p>
                    </div>
                  </button>
                </div>
              </div>

              {/* Section 2: Controller Recovery */}
              <div className="space-y-2.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Controller Recovery
                </p>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => openChildView("recover_ble")}
                    className="group flex flex-col items-start gap-2.5 rounded-xl border border-border bg-card p-4 text-left transition hover:border-primary/60 hover:bg-primary/5 cursor-pointer"
                  >
                    <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <RiShieldCheckLine className="size-5" aria-hidden="true" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">Recover with BLE</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Reconnect or re-pair an existing controller via Bluetooth.
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => openChildView("recover_wifi")}
                    className="group flex flex-col items-start gap-2.5 rounded-xl border border-border bg-card p-4 text-left transition hover:border-primary/60 hover:bg-primary/5 cursor-pointer"
                  >
                    <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <RiRouterLine className="size-5" aria-hidden="true" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">Recover with Wi-Fi</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Reconnect or re-pair using the controller&apos;s local 192.168.4.1 webpage.
                      </p>
                    </div>
                  </button>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleCloseModal}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}

        {(view === "setup_ble" || view === "recover_ble") && (
          <>
            <DialogHeader className="sr-only">
              <DialogTitle>
                {isRecoveryBle ? "Recover with BLE" : "Setup with BLE"}
              </DialogTitle>
              <DialogDescription>
                Connect your HomecoreOS controller over Bluetooth and configure Wi-Fi.
              </DialogDescription>
            </DialogHeader>

            {bleScreen === "discover" && (
              <div className="space-y-4">
                <BleDiscoveryArtwork
                  mode={isRecoveryBle ? "recover" : "setup"}
                />

                {!bleSupport.supported && (
                  <StatusAlert
                    tone="warning"
                    title="Bluetooth Unavailable"
                    action={
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          clearSensitiveState();
                          setView(wifiAlternativeView);
                        }}
                      >
                        {isRecoveryBle ? "Recover with Wi-Fi" : "Setup with Wi-Fi"}
                      </Button>
                    }
                  >
                    {bleSupport.reason}
                  </StatusAlert>
                )}

                {bleError && (
                  <StatusAlert
                    tone={bleErrorCode === "CANCELLED" ? "info" : "danger"}
                    title={
                      bleErrorCode === "CANCELLED"
                        ? "Selection Canceled"
                        : "Bluetooth Connection Issue"
                    }
                    action={
                      (bleErrorCode === "PERMISSION_DENIED" ||
                        bleErrorCode === "NO_BLE_SERVICE" ||
                        bleErrorCode === "UNSUPPORTED") && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            clearSensitiveState();
                            setView(wifiAlternativeView);
                          }}
                        >
                          {isRecoveryBle ? "Recover with Wi-Fi" : "Setup with Wi-Fi"}
                        </Button>
                      )
                    }
                  >
                    {bleError}
                  </StatusAlert>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="flex items-center gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={handleBackToEntry}>
                      <RiArrowLeftLine className="size-4" aria-hidden="true" />
                      Back
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={handleCloseModal}>
                      Cancel
                    </Button>
                  </div>
                  <Button
                    type="button"
                    disabled={bleConnecting || !bleSupport.supported}
                    onClick={() => void handleDiscoverBle()}
                  >
                    {bleConnecting ? (
                      <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <RiBluetoothConnectLine className="size-4" aria-hidden="true" />
                    )}
                    {bleConnecting ? "Connecting..." : "Discover BLE Controller"}
                  </Button>
                </div>
              </div>
            )}

            {bleScreen === "wifi" && (
              <form onSubmit={handleSubmitBleWifi} className="space-y-4">
                <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                      <RiCpuLine className="size-4" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {connectedDeviceName || "HomecoreOS Controller"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {isRecoveryBle
                          ? "Ready to update Wi-Fi and recover connection"
                          : "Ready for Wi-Fi setup"}
                      </p>
                    </div>
                  </div>
                  <Badge variant="success-light" radius="full">
                    Connected
                  </Badge>
                </div>

                {bleError && <StatusAlert tone="danger">{bleError}</StatusAlert>}

                <div className="space-y-3">
                  <FormField id="hc-ble-wifi-ssid" label="Wi-Fi Network Name (SSID)">
                    <Input
                      id="hc-ble-wifi-ssid"
                      required
                      autoComplete="off"
                      placeholder="Enter your 2.4 GHz Wi-Fi name"
                      value={wifiSsid}
                      onChange={(e) => setWifiSsid(e.target.value)}
                    />
                  </FormField>

                  <FormField id="hc-ble-wifi-pass" label="Wi-Fi Password">
                    <div className="relative">
                      <Input
                        id="hc-ble-wifi-pass"
                        type={showWifiPass ? "text" : "password"}
                        autoComplete="off"
                        placeholder="Enter Wi-Fi password"
                        value={wifiPass}
                        onChange={(e) => setWifiPass(e.target.value)}
                        className="pr-10"
                      />
                      <button
                        type="button"
                        aria-label={showWifiPass ? "Hide Wi-Fi password" : "Show Wi-Fi password"}
                        onClick={() => setShowWifiPass((v) => !v)}
                        className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground cursor-pointer"
                      >
                        {showWifiPass ? (
                          <RiEyeOffLine className="size-4" aria-hidden="true" />
                        ) : (
                          <RiEyeLine className="size-4" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </FormField>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleBackToWifiDiscover}
                    >
                      <RiArrowLeftLine className="size-4" aria-hidden="true" />
                      Back
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={handleCloseModal}>
                      Cancel
                    </Button>
                  </div>
                  <Button type="submit" disabled={!wifiSsid.trim()}>
                    {isRecoveryBle ? "Save & Recover" : "Save & Connect"}
                    <RiArrowRightLine className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </form>
            )}

            {bleScreen === "progress" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-base font-semibold text-foreground">
                      {progressDone
                        ? "Your controller is ready!"
                        : isRecoveryBle
                          ? "Recovering your controller"
                          : "Setting up your controller"}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {connectedDeviceName || "HomecoreOS Controller"}
                    </p>
                  </div>
                  {progressDone ? (
                    <Badge variant="success-light" radius="full">
                      Ready
                    </Badge>
                  ) : progressError ? (
                    <Badge variant="destructive-light" radius="full">
                      Attention Needed
                    </Badge>
                  ) : (
                    <Badge variant="info-light" radius="full">
                      In Progress
                    </Badge>
                  )}
                </div>

                <Frame spacing="sm">
                  <FramePanel className="space-y-2.5 p-4">
                    {progressLabels.map((label, idx) => {
                      const state = stepStates[idx] ?? "pending";
                      return (
                        <div
                          key={label}
                          className={cn(
                            "flex items-center gap-3 rounded-lg px-2.5 py-2 text-xs transition-colors",
                            state === "active" && "bg-primary/8 font-medium text-foreground",
                            state === "done" && "text-foreground",
                            state === "error" && "bg-destructive/10 text-destructive font-medium",
                            state === "pending" && "text-muted-foreground"
                          )}
                        >
                          {state === "done" ? (
                            <RiCheckboxCircleFill
                              className="size-4 shrink-0 text-success"
                              aria-hidden="true"
                            />
                          ) : state === "active" ? (
                            <RiLoader4Line
                              className="size-4 shrink-0 animate-spin text-primary"
                              aria-hidden="true"
                            />
                          ) : state === "error" ? (
                            <RiErrorWarningLine
                              className="size-4 shrink-0 text-destructive"
                              aria-hidden="true"
                            />
                          ) : (
                            <span
                              aria-hidden="true"
                              className="size-4 shrink-0 rounded-full border border-border bg-muted/40"
                            />
                          )}
                          <span>{label}</span>
                        </div>
                      );
                    })}
                  </FramePanel>
                </Frame>

                {progressDone && (
                  <StatusAlert tone="success" title="Your controller is ready!">
                    {isRecoveryBle
                      ? "Wi-Fi and MQTT connection verified. Your controller has returned to normal operation."
                      : "Your controller is paired to your HomecoreOS account and online over MQTT."}
                  </StatusAlert>
                )}

                {progressError && (
                  <StatusAlert tone="danger" title="Could Not Complete Setup">
                    {progressError}
                  </StatusAlert>
                )}

                <DialogFooter className="flex-wrap justify-between gap-2">
                  {progressDone ? (
                    <Button type="button" className="ml-auto" onClick={handleCloseModal}>
                      Done
                    </Button>
                  ) : progressError ? (
                    <>
                      <Button type="button" variant="outline" onClick={handleCloseModal}>
                        Cancel
                      </Button>
                      <div className="flex items-center gap-2">
                        {clientRef.current?.isConnected ? (
                          <Button
                            type="button"
                            onClick={() => {
                              setProgressError(null);
                              setBleScreen("wifi");
                            }}
                          >
                            Edit Wi-Fi &amp; Retry
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            onClick={() => {
                              setProgressError(null);
                              setBleScreen("discover");
                            }}
                          >
                            Reconnect via Bluetooth
                          </Button>
                        )}
                      </div>
                    </>
                  ) : (
                    <Button type="button" variant="outline" onClick={handleCloseModal}>
                      Cancel
                    </Button>
                  )}
                </DialogFooter>
              </div>
            )}
          </>
        )}

        {(view === "setup_wifi" || view === "recover_wifi") && (
          <>
            <DialogHeader>
              <DialogTitle>
                {view === "recover_wifi" ? "Recover with Wi-Fi" : "Setup with Wi-Fi"}
              </DialogTitle>
              <DialogDescription>
                {view === "recover_wifi"
                  ? "Reconnect or re-pair your controller using its local http://192.168.4.1 recovery webpage."
                  : "Set up your controller by joining its temporary HomecoreOS-Setup-XXXX Wi-Fi network."}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <Frame spacing="sm">
                <FramePanel className="space-y-2 p-4 text-xs leading-relaxed text-muted-foreground">
                  <p className="text-sm font-semibold text-foreground">
                    {view === "recover_wifi"
                      ? "Steps on your controller & browser"
                      : "Steps to set up via Wi-Fi"}
                  </p>
                  <ol className="list-decimal space-y-1.5 pl-4">
                    <li>
                      {view === "recover_wifi"
                        ? "Hold the BOOT / Recovery button on your controller for 3 seconds."
                        : "Power on your new HomecoreOS controller."}
                    </li>
                    <li>
                      Connect your phone or computer to{" "}
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                        HomecoreOS-Setup-XXXX
                      </code>
                      .
                    </li>
                    <li>
                      Open{" "}
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                        http://192.168.4.1
                      </code>{" "}
                      in your browser.
                    </li>
                    {view === "recover_wifi" ? (
                      <li>
                        If only your Wi-Fi network changed, choose{" "}
                        <strong>Update Wi-Fi Credentials Only</strong> and click{" "}
                        <strong>Save &amp; Apply</strong>. If re-pairing is needed, choose{" "}
                        <strong>Recover / Re-pair Existing Controller</strong> and enter your
                        Wi-Fi details, server URL, and 6-digit recovery code below.
                      </li>
                    ) : (
                      <li>
                        Enter your Wi-Fi SSID, Wi-Fi password, 6-digit pairing code, and
                        HomecoreOS server URL, then click <strong>Save &amp; Apply</strong>.
                      </li>
                    )}
                  </ol>
                </FramePanel>
              </Frame>

              {/* Server URL copy card */}
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/35 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    HomecoreOS Server URL
                  </p>
                  <p className="truncate font-mono text-xs text-foreground">
                    {serverOrigin}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void handleCopyText("url", serverOrigin)}
                >
                  {copiedField === "url" ? (
                    <RiCheckLine className="size-3.5" aria-hidden="true" />
                  ) : (
                    <RiFileCopyLine className="size-3.5" aria-hidden="true" />
                  )}
                  {copiedField === "url" ? "Copied" : "Copy"}
                </Button>
              </div>

              {wifiPortalError && <StatusAlert tone="danger">{wifiPortalError}</StatusAlert>}

              {!wifiPortalCode ? (
                <form onSubmit={handleGenerateWifiPortalCode} className="space-y-3">
                  {view === "recover_wifi" && controllers.length > 0 && (
                    <div className="space-y-2">
                      <FormField id="wifi-rec-target" label="Controller to Re-pair (if needed)">
                        <Select
                          value={wifiPortalRecoverDeleted ? "__deleted__" : wifiPortalTargetId}
                          onValueChange={(val) => {
                            if (val === "__deleted__") {
                              setWifiPortalRecoverDeleted(true);
                            } else {
                              setWifiPortalRecoverDeleted(false);
                              setWifiPortalTargetId(val);
                            }
                          }}
                        >
                          <SelectTrigger id="wifi-rec-target" className="w-full">
                            <SelectValue placeholder="Select controller..." />
                          </SelectTrigger>
                          <SelectContent>
                            {controllers.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name} ({c.board_model})
                              </SelectItem>
                            ))}
                            <SelectItem value="__deleted__">
                              Deleted / Not Listed Controller
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </FormField>
                    </div>
                  )}

                  {(view === "setup_wifi" || wifiPortalRecoverDeleted || controllers.length === 0) && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <FormField id="wifi-portal-name" label="Controller Name">
                        <Input
                          id="wifi-portal-name"
                          required
                          placeholder="e.g. Hallway Controller"
                          value={wifiPortalName}
                          onChange={(e) => setWifiPortalName(e.target.value)}
                        />
                      </FormField>
                      <FormField id="wifi-portal-board" label="Board Model">
                        <Select
                          value={wifiPortalBoardChoice}
                          onValueChange={setWifiPortalBoardChoice}
                        >
                          <SelectTrigger id="wifi-portal-board" className="w-full">
                            <SelectValue placeholder="Select board..." />
                          </SelectTrigger>
                          <SelectContent>
                            {boardOptions.map((o) => (
                              <SelectItem key={o.id} value={o.id}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormField>
                    </div>
                  )}

                  {(() => {
                    const sel = boardOptions.find((o) => o.id === wifiPortalBoardChoice)?.board;
                    if (sel && sel.supports_wifi === false) {
                      return (
                        <StatusAlert tone="warning" title="No Wi-Fi Radio on Selected Board">
                          <span className="inline-flex items-center gap-1.5">
                            <RiAlertLine className="size-4 shrink-0" aria-hidden="true" />
                            ESP32-H2 does not have an integrated Wi-Fi radio and is unavailable as a standalone Wi-Fi/MQTT controller.
                          </span>
                        </StatusAlert>
                      );
                    }
                    if (sel && supportsBleProvisioningForBoard(sel).supportsBle === false) {
                      return (
                        <StatusAlert tone="info">
                          {sel.model} uses Wi-Fi Setup AP (no Bluetooth LE radio on this board).
                        </StatusAlert>
                      );
                    }
                    return null;
                  })()}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <Button type="button" variant="ghost" size="sm" onClick={handleBackToEntry}>
                      <RiArrowLeftLine className="size-4" aria-hidden="true" />
                      Back
                    </Button>
                    <Button
                      type="submit"
                      disabled={
                        wifiPortalBusy ||
                        boardOptions.find((o) => o.id === wifiPortalBoardChoice)?.board
                          .supports_wifi === false
                      }
                    >
                      {wifiPortalBusy
                        ? "Preparing..."
                        : view === "recover_wifi"
                          ? "Get 6-Digit Recovery Code"
                          : "Get 6-Digit Pairing Code"}
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="space-y-3">
                  <Frame spacing="sm">
                    <FramePanel className="p-4 text-center space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {view === "recover_wifi"
                          ? "6-Digit Recovery Code"
                          : "6-Digit Pairing Code"}
                      </p>
                      <p className="font-mono text-3xl font-bold tracking-[0.25em] text-primary tabular-nums">
                        {wifiPortalCode}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void handleCopyText("code", wifiPortalCode)}
                      >
                        {copiedField === "code" ? (
                          <RiCheckLine className="size-3.5" aria-hidden="true" />
                        ) : (
                          <RiFileCopyLine className="size-3.5" aria-hidden="true" />
                        )}
                        {copiedField === "code" ? "Copied Code" : "Copy Code"}
                      </Button>
                    </FramePanel>
                  </Frame>

                  {wifiPortalOnline ? (
                    <StatusAlert tone="success" title="Your controller is ready!">
                      Controller paired and connected online over MQTT.
                    </StatusAlert>
                  ) : (
                    <StatusAlert tone="info">
                      Waiting for your controller to apply settings from{" "}
                      <code className="font-mono">http://192.168.4.1</code> and connect...
                    </StatusAlert>
                  )}

                  <div className="flex items-center justify-between pt-1">
                    <Button type="button" variant="ghost" size="sm" onClick={handleBackToEntry}>
                      <RiArrowLeftLine className="size-4" aria-hidden="true" />
                      Back
                    </Button>
                    <Button
                      type="button"
                      onClick={() => {
                        if (wifiPortalOnline) {
                          onSuccess?.("Controller configured via Wi-Fi.");
                        }
                        handleCloseModal();
                      }}
                    >
                      {wifiPortalOnline ? "Done" : "Close"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
