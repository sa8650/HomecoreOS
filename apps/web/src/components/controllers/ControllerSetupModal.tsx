import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  RiAlertLine,
  RiArrowLeftLine,
  RiArrowRightLine,
  RiArrowRightSLine,
  RiBluetoothConnectLine,
  RiCheckLine,
  RiCheckboxCircleFill,
  RiCloseLine,
  RiCpuLine,
  RiErrorWarningLine,
  RiEyeLine,
  RiEyeOffLine,
  RiFileCopyLine,
  RiLoader4Line,
  RiPauseCircleLine,
  RiUsbLine,
} from "@remixicon/react";
import {
  supportsBleProvisioningForBoard,
  type BleCommandPayload,
  type BleDeviceInfoPayload,
  type BleStatusPayload,
} from "@homecoreos/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { getRealtimeClient } from "@/lib/realtime/sync-client";
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
import { ControllerActionArtwork } from "@/components/controllers/ControllerActionArtwork";
import {
  BluetoothGlyph,
  BluetoothPairingAnimation,
  WifiSignalAnimation,
} from "@/components/graphics/ConnectionAnimations";
import {
  UsbFlashWizard,
  type UsbFlashWizardHandle,
  type UsbFlashWizardState,
} from "@/components/firmware/UsbFlashWizard";
import { Badge } from "@/components/reui/badge";
import { Frame, FramePanel } from "@/components/reui/frame";
import { FormField, StatusAlert } from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
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
  | "flash"
  | "setup"
  | "recover"
  | "setup_ble"
  | "setup_wifi"
  | "recover_ble"
  | "recover_wifi";

/** The screen a "Back" button returns to from a leaf flow. */
function parentViewOf(view: ControllerSetupView): ControllerSetupView {
  if (view === "setup_ble" || view === "setup_wifi") return "setup";
  if (view === "recover_ble" || view === "recover_wifi") return "recover";
  return "entry";
}

type BleFlowScreen = "discover" | "wifi" | "progress";

type ProgressStepState = "pending" | "active" | "done" | "error";

const SETUP_PROGRESS_LABELS = [
  "1. Securely connecting to board",
  "2. Saving Wi-Fi configuration",
  "3. Connecting board to Wi-Fi",
  "4. Pairing board with your HomecoreOS account",
  "5. Connecting board to MQTT",
  "6. Verifying board connection",
] as const;

const RECOVERY_PROGRESS_LABELS = [
  "1. Securely connecting to board",
  "2. Saving Wi-Fi configuration",
  "3. Connecting board to Wi-Fi",
  "4. Verifying board recovery",
  "5. Connecting board to MQTT",
  "6. Verifying board connection",
] as const;

function normalizeHexSuffix(value?: string | null): string {
  return (value ?? "").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
}

function matchBoardForDeviceInfo(
  deviceInfo: BleDeviceInfoPayload | null,
  catalogBoards: BoardProfileItem[],
  customBoardProfiles: BoardProfileItem[]
): { kind: "catalog" | "custom"; board: BoardProfileItem } | null {
  const all: Array<{ kind: "catalog" | "custom"; board: BoardProfileItem }> = [
    ...catalogBoards.map((board) => ({ kind: "catalog" as const, board })),
    ...customBoardProfiles.map((board) => ({ kind: "custom" as const, board })),
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

/** A single illustrated action row on the controller action picker. */
function ActionCard({
  kind,
  title,
  description,
  meta,
  illustration,
  onClick,
}: {
  kind: "usb" | "bluetooth" | "wifi" | "recovery";
  title: string;
  description: string;
  meta?: string;
  /**
   * Optional live artwork for the 48px tile. When given it replaces the static
   * `ControllerActionArtwork`, which keeps the tile's tinted frame so the rows
   * still line up with one another.
   */
  illustration?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full cursor-pointer items-center gap-3 rounded-[10px] border bg-card px-3 py-2.5 text-left transition-colors hover:border-foreground/25 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {illustration ? (
        <span
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-blue-600/22 bg-[#eff6ff] dark:border-blue-400/25 dark:bg-blue-950/40"
        >
          {illustration}
        </span>
      ) : (
        <ControllerActionArtwork
          kind={kind}
          tone="light"
          className="size-12 shrink-0 [&>svg]:p-1"
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">{title}</span>
        </span>
        <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
          {meta ? `${meta} · ` : ""}
          {description}
        </span>
      </span>
      <RiArrowRightSLine
        aria-hidden="true"
        className="size-5 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
      />
    </button>
  );
}

function BleDiscoveryArtwork({
  mode,
  connected,
}: {
  mode: "setup" | "recover";
  connected?: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-[12px] border border-blue-600/20 bg-blue-50/60 px-5 py-6 text-center dark:border-blue-400/25 dark:bg-blue-950/30">
      <div className="flex justify-center">
        <BluetoothPairingAnimation className="size-24" />
      </div>

      <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-blue-600/25 bg-white px-2.5 py-1 text-[11.5px] font-medium text-blue-700 dark:border-blue-400/30 dark:bg-blue-950/60 dark:text-blue-200">
        <RiBluetoothConnectLine className="size-3.5" aria-hidden="true" />
        {connected
          ? "Connected over Bluetooth"
          : mode === "recover"
            ? "Bluetooth Board Recovery"
            : "Bluetooth Board Setup"}
      </span>

      <h3 className="mt-2.5 text-[15px] font-semibold tracking-[-0.01em] text-foreground">
        {mode === "recover"
          ? "Prepare Board for Recovery"
          : "Discover HomecoreOS Board"}
      </h3>
      <p className="mx-auto mt-1 max-w-[320px] text-[12.5px] leading-relaxed text-muted-foreground">
        {mode === "recover"
          ? "Hold the BOOT / Recovery button on your board for 3 seconds."
          : "Turn on your HomecoreOS Board and keep it nearby."}
      </p>
    </div>
  );
}

/**
 * Four-step Wi-Fi portal instruction artwork (matches the printed quick-start):
 * power the controller -> join HomecoreOS-Setup-XXXX -> open http://192.168.4.1
 * -> enter SSID / password / pairing code and press Save & Apply.
 * Inline SVG only; fixed light palette like the BleDiscoveryArtwork.
 */
function WifiPortalArtwork() {
  const badge = "#1e63e0";
  const ink = "#141a24";
  const softStroke = "#dfe3e8";
  const deviceStroke = "#8b939e";
  return (
    <div className="flex justify-center rounded-[12px] border border-border bg-muted/30 p-3">
      {/* ~35% of the previous full-width artwork: the four beats still read at
          this size, and the dialog stays short enough to scroll on a laptop.
          The animated Wi-Fi glyph lives on the "Setup with Wi-Fi" option row. */}
      <svg
        viewBox="0 0 1230 392"
        className="h-auto w-full max-w-[300px] select-none"
        role="img"
        aria-label="Four steps: 1. Plug the board into power. 2. Join its HomecoreOS-Setup-XXXX Wi-Fi network from your phone or computer. 3. Open http://192.168.4.1 in your browser. 4. Enter the Wi-Fi SSID, password and pairing code, then press Save and Apply."
      >
        {/* panel */}
        <rect x="6" y="6" width="1218" height="380" rx="18" fill="#fcfcfa" stroke="#e3e6ea" strokeWidth="2" />

        {/* step circles */}
        {[214, 488, 762, 1016].map((cx) => (
          <circle key={cx} cx={cx} cy="200" r="116" fill="#ffffff" stroke={softStroke} strokeWidth="2" />
        ))}

        {/* dotted connectors with chevrons */}
        {[[330, 382], [604, 656], [878, 930]].map(([x1, x2]) => (
          <g key={x1} stroke="#7a8089" strokeWidth="4" strokeLinecap="round" fill="none">
            <line x1={x1} y1="200" x2={x2 - 14} y2="200" strokeDasharray="0.1 11" />
            <polyline points={`${x2 - 8},190 ${x2 + 2},200 ${x2 - 8},210`} strokeLinejoin="round" />
          </g>
        ))}

        {/* step badges */}
        {[214 - 88, 488 - 88, 762 - 88, 1016 - 88].map((cx, i) => (
          <g key={i}>
            <circle cx={cx} cy="74" r="20" fill={badge} />
            <text x={cx} y="81.5" textAnchor="middle" fill="#ffffff" fontSize="21" fontWeight="800" fontFamily="ui-sans-serif, system-ui, sans-serif">
              {i + 1}
            </text>
          </g>
        ))}

        {/* ---------- step 1: outlet + plug + up arrow ---------- */}
        <g>
          {/* outlet plate */}
          <rect x="186" y="104" width="56" height="96" rx="8" fill="#f4f5f7" stroke="#d3d7de" strokeWidth="2" />
          {/* duplex sockets */}
          <rect x="196" y="113" width="36" height="32" rx="6" fill="#ffffff" stroke="#d0d5dc" strokeWidth="1.5" />
          <rect x="196" y="155" width="36" height="32" rx="6" fill="#ffffff" stroke="#d0d5dc" strokeWidth="1.5" />
          {/* top socket slots + ground */}
          <rect x="204" y="120" width="3.6" height="10" rx="1.8" fill="#41464f" />
          <rect x="221" y="120" width="3.6" height="10" rx="1.8" fill="#41464f" />
          <circle cx="214.3" cy="139.5" r="2.6" fill="#41464f" />
          {/* bottom socket slots + ground */}
          <rect x="204" y="162" width="3.6" height="10" rx="1.8" fill="#41464f" />
          <rect x="221" y="162" width="3.6" height="10" rx="1.8" fill="#41464f" />
          <circle cx="214.3" cy="181.5" r="2.6" fill="#41464f" />
          {/* plug prongs + body */}
          <rect x="193" y="212" width="6" height="26" rx="3" fill="#e6e8ec" stroke="#c6cbd3" strokeWidth="1.5" />
          <rect x="209" y="212" width="6" height="26" rx="3" fill="#e6e8ec" stroke="#c6cbd3" strokeWidth="1.5" />
          <rect x="184" y="238" width="44" height="24" rx="5" fill="#ffffff" stroke="#c9ced6" strokeWidth="2" />
          {/* cord */}
          <path d="M206 262 C206 282 220 290 214 312" fill="none" stroke="#c9ced6" strokeWidth="5" strokeLinecap="round" />
          {/* blue up arrow */}
          <path d="M267 176 L250 208 L259.5 208 L259.5 240 L274.5 240 L274.5 208 L284 208 Z" fill={badge} />
        </g>

        {/* ---------- step 2: phone + laptop on Wi-Fi ---------- */}
        <g>
          {/* laptop */}
          <rect x="476" y="128" width="88" height="76" rx="7" fill="#ffffff" stroke="#565e68" strokeWidth="2.5" />
          <rect x="483" y="135" width="74" height="57" rx="2" fill="#e8ecf1" />
          <rect x="466" y="207" width="108" height="7" rx="3.5" fill="#aeb4bd" />
          {/* laptop wifi arcs */}
          <g fill="none" stroke={badge} strokeWidth="3" strokeLinecap="round">
            <path d="M513 171.5 A9 9 0 0 1 527 171.5" />
            <path d="M508.5 166 A14.5 14.5 0 0 1 531.5 166" />
            <path d="M504 160.5 A20 20 0 0 1 536 160.5" />
          </g>
          <circle cx="520" cy="178" r="2.7" fill={badge} />
          {/* phone (in front) */}
          <rect x="424" y="126" width="42" height="90" rx="9" fill="#ffffff" stroke={deviceStroke} strokeWidth="2.5" />
          <rect x="438" y="130" width="14" height="2.4" rx="1.2" fill={deviceStroke} />
          <rect x="429" y="136" width="32" height="66" rx="3" fill="#e8ecf1" />
          {/* phone wifi arcs */}
          <g fill="none" stroke={badge} strokeWidth="3" strokeLinecap="round">
            <path d="M438.5 186.5 A8.5 8.5 0 0 1 451.5 186.5" />
            <path d="M434 181.5 A14 14 0 0 1 456 181.5" />
            <path d="M429.5 176.5 A19.5 19.5 0 0 1 460.5 176.5" />
          </g>
          <circle cx="445" cy="192.5" r="2.5" fill={badge} />
        </g>

        {/* ---------- step 3: browser at http://192.168.4.1 ---------- */}
        <g>
          <rect x="672" y="126" width="180" height="120" rx="10" fill="#ffffff" stroke={deviceStroke} strokeWidth="2" />
          {/* chrome bar */}
          <path d="M672 136 a10 10 0 0 1 10 -10 h160 a10 10 0 0 1 10 10 v14 H672 Z" fill="#e9edf1" />
          <line x1="672" y1="150" x2="852" y2="150" stroke="#d5dae0" strokeWidth="1.5" />
          <circle cx="683" cy="138.5" r="3.2" fill="#c3c9d1" />
          <circle cx="693" cy="138.5" r="3.2" fill="#c3c9d1" />
          <circle cx="703" cy="138.5" r="3.2" fill="#c3c9d1" />
          {/* address bar */}
          <rect x="682" y="162" width="160" height="28" rx="6" fill="#f1f4f8" stroke="#e1e6ec" strokeWidth="1.5" />
          <text x="762" y="181" textAnchor="middle" fill={badge} fontSize="14.5" fontWeight="650" fontFamily="ui-sans-serif, system-ui, sans-serif">
            http://192.168.4.1
          </text>
          {/* cursor pointer */}
          <path d="M796 196 L796 226 L803.5 219 L808.5 229 L813.5 227 L808.5 217 L817 217 Z" fill="#111111" stroke="#ffffff" strokeWidth="1.5" strokeLinejoin="round" />
        </g>

        {/* ---------- step 4: portal form + Save & Apply ---------- */}
        <g fontFamily="ui-sans-serif, system-ui, sans-serif">
          {/* labels */}
          <text x="954" y="112" fill={ink} fontSize="12.5" fontWeight="650">Wi-Fi SSID</text>
          <text x="954" y="180" fill={ink} fontSize="12.5" fontWeight="650">Password</text>
          <text x="954" y="248" fill={ink} fontSize="12.5" fontWeight="650">Pairing Code</text>
          {/* SSID field */}
          <rect x="954" y="118" width="152" height="23" rx="5" fill="#ffffff" stroke="#c9ced6" strokeWidth="1.5" />
          <text x="963" y="134" fill="#1f2937" fontSize="12.5">Home_Network</text>
          <g fill="none" stroke="#5b636e" strokeWidth="1.6" strokeLinecap="round">
            <path d="M1084 133.5 A5.2 5.2 0 0 1 1092.4 133.5" />
            <path d="M1081.6 129.8 A8.6 8.6 0 0 1 1094.8 129.8" />
          </g>
          <circle cx="1088.2" cy="136.6" r="1.4" fill="#5b636e" />
          {/* Password field */}
          <rect x="954" y="186" width="152" height="23" rx="5" fill="#ffffff" stroke="#c9ced6" strokeWidth="1.5" />
          <text x="963" y="202" fill="#111111" fontSize="13.5" letterSpacing="3.5">•••••••</text>
          <rect x="1083" y="194" width="13" height="10" rx="2" fill="none" stroke="#5b636e" strokeWidth="1.6" />
          <path d="M1085.8 194 v-2.4 a3.7 3.7 0 0 1 7.4 0 V194" fill="none" stroke="#5b636e" strokeWidth="1.6" />
          {/* Pairing code field */}
          <rect x="954" y="254" width="152" height="23" rx="5" fill="#ffffff" stroke="#c9ced6" strokeWidth="1.5" />
          <text x="963" y="270" fill="#1f2937" fontSize="12.5" fontFamily="ui-monospace, monospace">123456</text>
          {/* Save & Apply button */}
          <rect x="972" y="286" width="136" height="27" rx="6" fill={badge} />
          <text x="1040" y="304" textAnchor="middle" fill="#ffffff" fontSize="13" fontWeight="700">Save &amp; Apply</text>
        </g>
      </svg>
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
  customBoardProfiles = [],
  canManage = true,
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
  customBoardProfiles?: BoardProfileItem[];
  /** Owners/admins may install factory firmware over USB. */
  canManage?: boolean;
  onSuccess?: (message: string) => void;
}) {
  const [view, setView] = useState<ControllerSetupView>(initialView);
  const [confirmCloseFlash, setConfirmCloseFlash] = useState(false);
  const flashRef = useRef<UsbFlashWizardHandle | null>(null);
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
  const [wifiPortalName, setWifiPortalName] = useState("HomecoreOS Board");
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
      setConfirmCloseFlash(false);
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
      ...customBoardProfiles.map((b) => ({
        id: `custom:${b.id}`,
        board: b,
        label: `Custom: ${b.manufacturer} ${b.model}`,
      })),
    ];
    return list;
  }, [catalogBoards, customBoardProfiles]);

  const boardsForSlugLookup = useMemo(
    () => [...catalogBoards, ...customBoardProfiles],
    [catalogBoards, customBoardProfiles]
  );

  /**
   * The Board Library slug of the controller this action was opened from, so
   * "Flash Board" starts on the board the user already owns instead of an
   * empty select.
   */
  const initialFlashBoardSlug = useMemo(() => {
    if (!targetController) return undefined;
    const installed = boardsForSlugLookup.find((b) =>
      targetController.board_profile_id
        ? b.id === targetController.board_profile_id
        : b.id === targetController.custom_board_profile_id
    );
    return installed?.slug;
  }, [targetController, boardsForSlugLookup]);

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
          `/api/board-instances/${wifiPortalControllerId}`
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
    // The board announces itself over the real-time channel as soon as it is
    // paired; the interval is a ten-second fallback for an unreachable broker.
    const unsubscribe = getRealtimeClient().subscribe((batch) => {
      const touched = batch.events.some(
        (event) => event.entity === "board" && event.id === wifiPortalControllerId
      );
      if (touched || batch.resync) void poll();
    });
    const timer = window.setInterval(() => void poll(), 10_000);
    return () => {
      active = false;
      unsubscribe();
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
    // While firmware is streaming over USB, closing only hides progress — ask first.
    if (view === "flash" && flashRef.current?.isBusy()) {
      setConfirmCloseFlash(true);
      return;
    }
    flashRef.current?.settlePendingDecision();
    clearSensitiveState();
    onClose();
  }

  /** Back from a leaf flow returns to its chooser, then to the action picker. */
  function handleBackToEntry() {
    flashRef.current?.settlePendingDecision();
    clearSensitiveState();
    setBleScreen("discover");
    setView(parentViewOf(view));
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
                "Bluetooth connection dropped during configuration. Keep your board nearby and try again."
              )
            );
          } else {
            setBleErrorCode("DISCONNECTED");
            setBleError(
              "Bluetooth connection to the board was lost. Click Discover BLE Board to reconnect."
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
          "This ESP32-H2 board has no integrated Wi-Fi radio and cannot be set up as a standalone Wi-Fi/MQTT HomecoreOS board."
        );
        return;
      }

      const displayName =
        client.deviceName ||
        (info.mac_suffix ? `HomecoreOS-${info.mac_suffix}` : "HomecoreOS Board");
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
            : "Could not connect to a HomecoreOS Board over Bluetooth."
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
  ): Promise<{ boardInstanceId: string; pairingCode: string }> {
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
          "/api/board-instances/recover",
          {
            method: "POST",
            body: JSON.stringify({ boardInstanceId: matched.controller.id }),
          }
        );
        return { boardInstanceId: res.controller.id, pairingCode: res.pairingCode };
      }

      if (matched.kind === "trashed") {
        const res = await apiFetch<{
          controller: ControllerItem;
          pairingCode?: string | null;
        }>(`/api/board-instances/${matched.controller.id}/restore`, {
          method: "POST",
        });
        activeControllerIdRef.current = res.controller.id;
        if (res.pairingCode) {
          return { boardInstanceId: res.controller.id, pairingCode: res.pairingCode };
        }
        const rec = await apiFetch<{ controller: ControllerItem; pairingCode: string }>(
          "/api/board-instances/recover",
          {
            method: "POST",
            body: JSON.stringify({ boardInstanceId: res.controller.id }),
          }
        );
        return { boardInstanceId: rec.controller.id, pairingCode: rec.pairingCode };
      }

      // Permanently deleted or missing from account -> create a fresh recovery slot bound to user's account
      const matchedBoard = matchBoardForDeviceInfo(info, catalogBoards, customBoardProfiles);
      if (!matchedBoard) {
        throw new Error(
          "No compatible board profile is available in your catalog for this board."
        );
      }
      const res = await apiFetch<{ controller: ControllerItem; pairingCode: string }>(
        "/api/board-instances/recover",
        {
          method: "POST",
          body: JSON.stringify({
            name:
              activeControllerIdRef.current && targetController?.name
                ? targetController.name
                : deviceLabel || "Recovered Board",
            homeId: homes[0]?.id,
            ...(matchedBoard.kind === "catalog"
              ? { boardProfileId: matchedBoard.board.id }
              : { customBoardProfileId: matchedBoard.board.id }),
          }),
        }
      );
      activeControllerIdRef.current = res.controller.id;
      return { boardInstanceId: res.controller.id, pairingCode: res.pairingCode };
    }

    // New Controller Setup authorization
    if (activeControllerIdRef.current || targetController?.id) {
      const existingId = activeControllerIdRef.current ?? targetController!.id;
      activeControllerIdRef.current = existingId;
      const res = await apiFetch<{ pairingCode: string }>(
        `/api/board-instances/${existingId}/regenerate-pairing-code`,
        { method: "POST" }
      );
      return { boardInstanceId: existingId, pairingCode: res.pairingCode };
    }

    const matchedBoard = matchBoardForDeviceInfo(info, catalogBoards, customBoardProfiles);
    if (!matchedBoard) {
      throw new Error(
        "No compatible board profile is available in your catalog for this board."
      );
    }

    const res = await apiFetch<{ controller: ControllerItem; pairingCode: string }>(
      "/api/board-instances",
      {
        method: "POST",
        body: JSON.stringify({
          name: deviceLabel || matchedBoard.board.model,
          homeId: homes[0]?.id,
          ...(matchedBoard.kind === "catalog"
            ? { boardProfileId: matchedBoard.board.id }
            : { customBoardProfileId: matchedBoard.board.id }),
        }),
      }
    );
    activeControllerIdRef.current = res.controller.id;
    return { boardInstanceId: res.controller.id, pairingCode: res.pairingCode };
  }

  async function waitForControllerOnlineOnBackend(boardInstanceId: string): Promise<boolean> {
    const deadline = Date.now() + 18_000;
    while (Date.now() < deadline) {
      if (!isMountedRef.current) return false;
      try {
        const res = await apiFetch<{ controller: ControllerItem }>(
          `/api/board-instances/${boardInstanceId}`
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
            "Timed out waiting for the board to connect. Verify your Wi-Fi network and try again."
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
                  ? "Board paired, but MQTT authentication or broker connection failed."
                  : "Board pairing failed with HomecoreOS.")
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
      setBleError("Bluetooth connection to the board was lost. Reconnect and try again.");
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
        const { boardInstanceId, pairingCode } = await issuePairingAuthorization(
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
          status.mqtt_connected && (await waitForControllerOnlineOnBackend(boardInstanceId));
        if (!backendVerified) {
          const err = new Error(
            "Board did not complete MQTT verification. Please check your network and retry."
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
              const { boardInstanceId, pairingCode } = await issuePairingAuthorization(
                true,
                deviceInfo,
                connectedDeviceName
              );
              verifiedControllerId = boardInstanceId;
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
          const { boardInstanceId, pairingCode } = await issuePairingAuthorization(
            true,
            deviceInfo,
            connectedDeviceName
          );
          verifiedControllerId = boardInstanceId;
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
              "Board connected to Wi-Fi, but MQTT verification with HomecoreOS did not succeed."
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
        `${connectedDeviceName || "Board"} is connected and ready.`
      );
    } catch (err) {
      const explicitIdx = (err as Error & { stepIdx?: number }).stepIdx;
      const failIdx = explicitIdx ?? activeStepIdx ?? currentErrorStep;
      setStepProgress(failIdx, failIdx, failIdx);
      setProgressError(
        err instanceof Error
          ? err.message
          : "Could not complete board configuration over Bluetooth."
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
          throw new Error("Select a board model for this board.");
        }
        const res = await apiFetch<{ controller: ControllerItem; pairingCode: string }>(
          "/api/board-instances",
          {
            method: "POST",
            body: JSON.stringify({
              name: wifiPortalName.trim() || "HomecoreOS Board",
              homeId: homes[0]?.id,
              boardProfileId: kind === "catalog" ? id : undefined,
              customBoardProfileId: kind === "custom" ? id : undefined,
            }),
          }
        );
        setWifiPortalControllerId(res.controller.id);
        setWifiPortalCode(res.pairingCode);
      } else if (view === "recover_wifi") {
        if (!wifiPortalRecoverDeleted && wifiPortalTargetId) {
          const res = await apiFetch<{ controller: ControllerItem; pairingCode: string }>(
            "/api/board-instances/recover",
            {
              method: "POST",
              body: JSON.stringify({ boardInstanceId: wifiPortalTargetId }),
            }
          );
          setWifiPortalControllerId(res.controller.id);
          setWifiPortalCode(res.pairingCode);
        } else {
          const [kind, id] = wifiPortalBoardChoice.split(":");
          if (!id) {
            throw new Error("Select the board model.");
          }
          const res = await apiFetch<{ controller: ControllerItem; pairingCode: string }>(
            "/api/board-instances/recover",
            {
              method: "POST",
              body: JSON.stringify({
                name: wifiPortalName.trim() || "Recovered Board",
                homeId: homes[0]?.id,
                boardProfileId: kind === "catalog" ? id : undefined,
                customBoardProfileId: kind === "custom" ? id : undefined,
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

  // The prototype language: one dialog, one header, one 3-px progress rail,
  // a scrolling body and a grey footer bar with the actions.
  const flowTitle =
    view === "entry"
      ? "Board"
      : view === "flash"
        ? "Flash Board"
        : view === "setup"
          ? "Setup Board"
          : view === "recover"
            ? "Repair / Recover Board"
            : view === "setup_ble"
              ? "Setup with Bluetooth"
              : view === "setup_wifi"
                ? "Setup with Wi-Fi"
                : view === "recover_ble"
                  ? "Recover with Bluetooth"
                  : "Recover with Wi-Fi";
  /**
   * The accessible name of the dialog. It changes with the visible step, so
   * assistive tech announces "Flash Board over USB" once the flasher opens
   * instead of the umbrella "Board Actions" label.
   */
  const flowA11yTitle =
    view === "entry"
      ? "Board Actions"
      : view === "flash"
        ? "Flash Board over USB"
        : view === "setup"
          ? "Setup Board"
          : view === "recover"
            ? "Repair / Recover Board"
            : view === "setup_ble"
              ? "Setup with Bluetooth"
              : view === "setup_wifi"
                ? "Setup with Wi-Fi"
                : view === "recover_ble"
                  ? "Recover with Bluetooth"
                  : "Recover with Wi-Fi";

  const flowSubtitle =
    view === "entry"
      ? "What would you like to do?"
      : view === "flash"
        ? "Choose the board, then its firmware."
        : view === "setup"
          ? "Bluetooth or Wi-Fi."
          : view === "recover"
            ? "Offline, deleted or re-pairing."
            : view === "setup_wifi" || view === "recover_wifi"
              ? "Join the board's temporary HomecoreOS network."
              : "";
  /** Lifted by the flasher for the header rail and the footer bar. */
  const [flashState, setFlashState] = useState<UsbFlashWizardState>({
    step: 0,
    busy: false,
    ready: false,
    writable: false,
    completed: false,
    forcedWillNotStart: false,
    paused: false,
  });
  const showProgressRail = view === "flash";
  const flashStepIndex = showProgressRail ? flashState.step : 0;
  const flashingBusy = view === "flash" && flashState.busy;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleCloseModal()}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          // flex-col (not the base grid): the body needs flex-1 + min-h-0 so it
          // scrolls inside the dialog, and the footer stays pinned below it.
          "hc-flow flex max-h-[min(88dvh,760px)] grid-cols-none flex-col gap-0 overflow-hidden rounded-[14px] p-0 sm:max-w-[min(560px,calc(100vw-2rem))]",
          view === "setup_wifi" || view === "recover_wifi"
            ? "sm:max-w-[min(720px,calc(100vw-2rem))]"
            : ""
        )}
      >
        <DialogTitle className="sr-only">{flowA11yTitle}</DialogTitle>
        <div className="flex shrink-0 items-start gap-2 px-5 pt-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[16px] font-semibold tracking-[-0.01em] text-foreground">
              {flowTitle}
            </h2>
            {flowSubtitle ? (
              <p className="mt-0.5 text-[13px] text-muted-foreground">{flowSubtitle}</p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-mr-1 shrink-0 text-muted-foreground"
            aria-label="Close"
            onClick={handleCloseModal}
          >
            <RiCloseLine className="size-4" aria-hidden="true" />
          </Button>
        </div>

        {showProgressRail && (
          <div
            className="mt-3 flex shrink-0 gap-1 px-5"
            role="progressbar"
            aria-label="Flash progress"
            aria-valuemin={1}
            aria-valuemax={3}
          >
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={cn(
                  "h-[3px] flex-1 rounded-full transition-colors",
                  i <= flashStepIndex ? "bg-foreground" : "bg-border"
                )}
              />
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 pt-3 pb-4">
        {view === "entry" && (
          <>
            <div className="grid gap-2">
              <ActionCard
                kind="usb"
                title="Flash Board"
                description="New hardware over USB."
                onClick={() => openChildView("flash")}
              />
              <ActionCard
                kind="bluetooth"
                title="Setup Board"
                description="Bluetooth or Wi-Fi."
                onClick={() => openChildView("setup")}
              />
              <ActionCard
                kind="recovery"
                title="Repair / Recover Board"
                description="Offline · deleted · re-pairing."
                onClick={() => openChildView("recover")}
              />
            </div>
          </>
        )}

        {(view === "setup" || view === "recover") && (
          <>
            <p className="text-[13px] text-muted-foreground">
              {view === "recover"
                ? "Choose how to reach the board. Works for offline, disconnected, deleted and re-paired boards."
                : "Choose how this browser should talk to the board while you configure it."}
              {targetController ? (
                <span className="ml-1 font-medium text-foreground">
                  {targetController.name}
                </span>
              ) : null}
            </p>

            <div className="grid gap-2 sm:grid-cols-2">
              {view === "recover" ? (
                <>
                  <ActionCard
                    kind="bluetooth"
                    title="Recover with Bluetooth"
                    description="Push the Wi-Fi and pairing details back over Bluetooth."
                    onClick={() => openChildView("recover_ble")}
                  />
                  <ActionCard
                    kind="wifi"
                    title="Recover with Wi-Fi"
                    description="Join HomecoreOS-Setup-XXXX and recover from 192.168.4.1."
                    onClick={() => openChildView("recover_wifi")}
                  />
                </>
              ) : (
                <>
                  <ActionCard
                    kind="bluetooth"
                    title="Setup with Bluetooth"
                    description="Fastest: pair nearby and send Wi-Fi and home details."
                    onClick={() => openChildView("setup_ble")}
                  />
                  <ActionCard
                    kind="wifi"
                    title="Setup with Wi-Fi"
                    description="Join HomecoreOS-Setup-XXXX and configure from 192.168.4.1."
                    illustration={<WifiSignalAnimation className="size-9" />}
                    onClick={() => openChildView("setup_wifi")}
                  />
                </>
              )}
            </div>

            {view === "recover" && (
              <p className="rounded-[8px] border bg-muted/40 px-3 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
                Recovery needs the board's recovery code. Deleted boards stay listed in the My
                Boards trash so they can be restored to a home.
              </p>
            )}
          </>
        )}

        {view === "flash" && (
          <>
            <UsbFlashWizard
              key={initialFlashBoardSlug ?? "flash"}
              ref={flashRef}
              onStateChange={setFlashState}
              canManage={canManage}
              initialBoardSlug={initialFlashBoardSlug}
              onBack={handleBackToEntry}
              onContinueToSetup={() => {
                // Carry the board that was just flashed into setup, in the same
                // modal: nothing closes, nothing reloads.
                const board = boardsForSlugLookup.find((b) => b.slug === initialFlashBoardSlug);
                if (board && wifiPortalBoardChoice === "") {
                  setWifiPortalBoardChoice(`catalog:${board.id}`);
                }
                clearSensitiveState();
                setBleScreen("discover");
                setView("setup");
              }}
            />
          </>
        )}

        {(view === "setup_ble" || view === "recover_ble") && (
          <>

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

                <div className="flex justify-center pt-1">
                  <Button
                    type="button"
                    className="min-w-[190px]"
                    disabled={bleConnecting || !bleSupport.supported}
                    onClick={() => void handleDiscoverBle()}
                  >
                    {bleConnecting ? (
                      <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <BluetoothGlyph className="size-4" />
                    )}
                    {bleConnecting ? "Connecting..." : "Discover BLE Board"}
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
                        {connectedDeviceName || "HomecoreOS Board"}
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

                <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                  <Button type="button" variant="outline" size="sm" onClick={handleCloseModal}>
                    Cancel
                  </Button>
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
                        ? "Your board is ready!"
                        : isRecoveryBle
                          ? "Recovering your board"
                          : "Setting up your board"}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {connectedDeviceName || "HomecoreOS Board"}
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
                  <StatusAlert tone="success" title="Your board is ready!">
                    {isRecoveryBle
                      ? "Wi-Fi and MQTT connection verified. Your board has returned to normal operation."
                      : "Your board is paired to your HomecoreOS account and online over MQTT."}
                  </StatusAlert>
                )}

                {progressError && (
                  <StatusAlert tone="danger" title="Could Not Complete Setup">
                    {progressError}
                  </StatusAlert>
                )}

                <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
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
                </div>
              </div>
            )}
          </>
        )}

        {(view === "setup_wifi" || view === "recover_wifi") && (
          <>
            <div className="space-y-4">
              <WifiPortalArtwork />

              <Frame spacing="sm">
                <FramePanel className="space-y-2 p-4 text-xs leading-relaxed text-muted-foreground">
                  <p className="text-sm font-semibold text-foreground">
                    {view === "recover_wifi"
                      ? "Steps on your Board & browser"
                      : "Steps to set up via Wi-Fi"}
                  </p>
                  <ol className="list-decimal space-y-1.5 pl-4">
                    <li>
                      {view === "recover_wifi"
                        ? "Hold the BOOT / Recovery button on your board for 3 seconds."
                        : "Power on your new HomecoreOS Board."}
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
                        <strong>Recover / Re-pair Existing Board</strong> and enter your
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
                      <FormField id="wifi-rec-target" label="Board to Re-Pair (if needed)">
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
                            <SelectValue placeholder="Select board..." />
                          </SelectTrigger>
                          <SelectContent>
                            {controllers.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name} ({c.board_model})
                              </SelectItem>
                            ))}
                            <SelectItem value="__deleted__">
                              Deleted / Not Listed Board
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </FormField>
                    </div>
                  )}

                  {(view === "setup_wifi" || wifiPortalRecoverDeleted || controllers.length === 0) && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <FormField id="wifi-portal-name" label="Board Name">
                        <Input
                          id="wifi-portal-name"
                          required
                          placeholder="e.g. Hallway Board"
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

                  <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
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
                          ? "Get Recovery Code"
                          : "Get Pairing Code"}
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
                    <StatusAlert tone="success" title="Your board is ready!">
                      Board paired and connected online over MQTT.
                    </StatusAlert>
                  ) : (
                    <StatusAlert tone="info">
                      Waiting for your board to apply settings from{" "}
                      <code className="font-mono">http://192.168.4.1</code> and connect...
                    </StatusAlert>
                  )}

                  <div className="flex items-center justify-end pt-1">
                    <Button
                      type="button"
                      onClick={() => {
                        if (wifiPortalOnline) {
                          onSuccess?.("Board configured via Wi-Fi.");
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
        </div>

        {/* One footer for every step, like the prototype: a quiet Back on the
            left and the primary action on the right. Hidden on the chooser. */}
        {view !== "entry" && (
          <div className="flex shrink-0 items-center gap-2 border-t bg-muted/50 px-5 py-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={flashingBusy}
              onClick={() => {
                if (view === "flash" && flashRef.current) {
                  flashRef.current.back();
                  return;
                }
                if (view === "setup_ble" || view === "recover_ble") {
                  if (bleScreen === "discover") {
                    handleBackToEntry();
                  } else if (bleScreen === "wifi") {
                    handleBackToWifiDiscover();
                  } else {
                    handleBackToEntry();
                  }
                  return;
                }
                handleBackToEntry();
              }}
            >
              <RiArrowLeftLine className="size-4" aria-hidden="true" />
              Back
            </Button>
            <div className="ml-auto flex items-center gap-2">
              {view === "flash" ? (
                flashState.step === 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={!flashState.ready || flashState.busy}
                    onClick={() => flashRef.current?.next()}
                  >
                    Next
                  </Button>
                ) : flashState.step === 1 ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={!flashState.writable || flashState.busy || flashState.paused}
                    onClick={() => flashRef.current?.startFlash()}
                  >
                    {flashState.paused ? (
                      <RiPauseCircleLine className="size-3.5" aria-hidden="true" />
                    ) : flashState.busy ? (
                      <RiLoader4Line className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <RiUsbLine className="size-3.5" aria-hidden="true" />
                    )}
                    {flashState.paused
                      ? "Paused: board check"
                      : flashState.busy
                        ? "Flashing via USB..."
                        : "Flash board over USB"}
                  </Button>
                ) : flashState.forcedWillNotStart ? (
                  <Button type="button" size="sm" onClick={() => flashRef.current?.restart()}>
                    Install again
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      // Hand off to board setup in the same modal: nothing
                      // closes and nothing reloads.
                      const board = boardsForSlugLookup.find(
                        (b) => b.slug === initialFlashBoardSlug
                      );
                      if (board && wifiPortalBoardChoice === "") {
                        setWifiPortalBoardChoice(`catalog:${board.id}`);
                      }
                      clearSensitiveState();
                      setBleScreen("discover");
                      setView("setup");
                    }}
                  >
                    Continue to Setup
                  </Button>
                )
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={handleCloseModal}>
                  Close
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>

      {/* Closing mid-flash only hides progress tracking — confirm first. */}
      <AlertDialog open={confirmCloseFlash} onOpenChange={setConfirmCloseFlash}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>USB Flash Currently in Progress</AlertDialogTitle>
            <AlertDialogDescription>
              Firmware is actively streaming to your ESP32 over Web Serial. Closing this window
              hides progress tracking — are you sure you want to close?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Open</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmCloseFlash(false);
                flashRef.current?.settlePendingDecision();
                clearSensitiveState();
                onClose();
              }}
            >
              Close Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
