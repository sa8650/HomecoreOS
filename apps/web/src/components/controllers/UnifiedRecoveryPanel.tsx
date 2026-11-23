import { useEffect, useMemo, useRef, useState } from "react";
import { RiArrowRightLine, RiCheckLine, RiCpuLine, RiErrorWarningLine, RiLoader4Line, RiSubtractLine } from "@remixicon/react";
import { describeTransportCapability, type RecoveryTransportKind } from "@homecoreos/shared";
import type { BoardProfileItem, ControllerItem } from "@/features/types";
import { HomecoreBleClient, isWebBluetoothSupported } from "@/lib/ble-provisioning";
import { createRecoveryController } from "@/lib/recovery-engine";
import { recoveryServerApi } from "@/lib/recovery-api";
import { createBleRecoveryTransport, createUsbRecoveryTransport, createWifiRecoveryTransport, isRecoverySerialSupported, type WifiRecoveryCodeState } from "@/lib/recovery-transport";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/reui/badge";
import { Frame, FramePanel } from "@/components/reui/frame";
import { FormField, StatusAlert } from "@/components/shared/AppUi";
import { UsbFlashIllustration } from "@/components/firmware/FirmwareProgressPipeline";
import { BleDiscoveryArtwork, WifiPortalArtwork } from "./RecoveryArtwork";

const EMPTY_PROFILES: BoardProfileItem[] = [];
const suffix = (uid: string | null | undefined) => uid?.replace(/[^a-f0-9]/gi, "").slice(-4).toUpperCase();

/** Discovery chooses the account record, never the other way round. */
export function matchRecoveryBoard(controllers: ControllerItem[], uid: string | null, target?: ControllerItem | null) {
  const detected = suffix(uid);
  if (!detected || detected.length !== 4) throw new Error("The board did not provide a verifiable identity. No changes were made.");
  if (target) {
    if (target.deleted_at || suffix(target.hardware_uid) !== detected) throw new Error("This is not the controller you opened. Connect the correct board and try again. No changes were made.");
    return target;
  }
  const matches = controllers.filter((board) => !board.deleted_at && suffix(board.hardware_uid) === detected);
  if (matches.length !== 1) throw new Error(matches.length ? "More than one controller matches this identity. Open Repair / Recover from the intended controller’s details." : "This board could not be matched to your account. Restore it from My Boards trash if deleted, or use Setup Board for a new installation.");
  return matches[0];
}

export function UnifiedRecoveryPanel({ kind, controllers, target, profiles = EMPTY_PROFILES, canManage, onFlash }: {
  kind: RecoveryTransportKind;
  controllers: ControllerItem[];
  profiles?: BoardProfileItem[];
  target?: ControllerItem | null;
  canManage: boolean;
  onFlash: () => void;
}) {
  const accountInputs = useRef({ controllers, target, profiles });
  accountInputs.current = { controllers, target, profiles };
  // The Wi-Fi transport speaks to the board's local page, which needs the
  // recovery code the website generated. The holder is created before the code
  // exists and filled in right before a re-pairing repair runs.
  const wifiCodeState = useRef<WifiRecoveryCodeState>({ code: null, generated: false });
  const mounted = useRef(true);
  const [matched, setMatched] = useState<ControllerItem | null>(null);
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [authorizing, setAuthorizing] = useState(false);
  const [authorizationError, setAuthorizationError] = useState("");
  const controller = useMemo(() => createRecoveryController({
    boardInstanceId: "",
    backendUrl: window.location.origin,
    resolveBoard: (hello) => {
      const { controllers, target } = accountInputs.current;
      const board = matchRecoveryBoard(controllers, hello.uidSuffix, target);
      setMatched(board);
      setSsid(board.wifi_ssid ?? "");
      return { id: board.id, hardwareUid: board.hardware_uid, model: board.board_model };
    },
    api: recoveryServerApi,
    capabilityFor: (transport) => {
      const ble = isWebBluetoothSupported();
      const usb = isRecoverySerialSupported();
      const { profiles, target } = accountInputs.current;
      const profile = profiles.find((p) => p.id === (target?.board_profile_id ?? target?.custom_board_profile_id));
      return describeTransportCapability({ transport,
        browserSupported: transport === "ble" ? ble.supported : transport === "usb" ? usb.available : true,
        browserReason: transport === "ble" ? ble.reason : usb.reason,
        boardSupportsWifi: profile?.supports_wifi !== false,
        boardSupportsBle: profile?.supports_ble !== false,
        boardFirmwareSupportsDiagnostics: true,
      });
    },
    createTransport: (transport) => transport === "usb" ? createUsbRecoveryTransport({})
      : transport === "wifi" ? createWifiRecoveryTransport({ codeState: wifiCodeState.current })
        : createBleRecoveryTransport({ createClient: () => new HomecoreBleClient(),
          setupPinForDevice: (info) => matchRecoveryBoard(accountInputs.current.controllers, info.mac_suffix ?? null, accountInputs.current.target).ble_setup_pin ?? undefined,
          support: isWebBluetoothSupported() }),
  }), []);
  const [state, setState] = useState(controller.getState);
  useEffect(() => {
    mounted.current = true;
    setState(controller.getState());
    const unsubscribe = controller.subscribe(setState);
    return () => { mounted.current = false; unsubscribe(); void controller.cancel("Recovery dialog closed."); };
  }, [controller]);
  useEffect(() => {
    if (state.error || state.phase === "report") setPassword("");
  }, [state.error, state.phase]);

  const busy = ["identifying", "diagnostics", "repairing", "verifying"].includes(state.phase) || authorizing;
  const ready = state.phase === "plan" || state.phase === "awaiting_input";
  const wifiNeeded = Boolean(state.plan?.actions.some((action) => action.requiresSecret === "wifi"));
  const pairingNeeded = Boolean(state.plan?.actions.some((action) => action.changesIdentity));
  const started = state.phase !== "idle";
  const complete = state.phase === "report";
  const verified = state.report?.finalStatus === "completed";
  const method = kind === "ble" ? "Bluetooth" : kind === "wifi" ? "Wi-Fi" : "USB";
  const support = kind === "ble" ? isWebBluetoothSupported() : kind === "usb" ? (() => { const usb = isRecoverySerialSupported(); return { supported: usb.available, reason: usb.reason }; })() : { supported: true, reason: null };

  async function discover() {
    setPassword(""); setMatched(null); setAuthorizationError("");
    await controller.cancel();
    if (!mounted.current) return;
    await controller.connect(kind);
    if (!mounted.current) return;
    if (controller.getState().phase !== "identified") return;
    await controller.diagnose();
    if (!mounted.current) return;
    const next = controller.getState();
    // Ordinary, credential-free repairs continue without an extra checklist.
    // Wi-Fi changes and identity-changing repairs wait for the user's input.
    if (next.phase === "plan" && next.plan && !next.plan.requiresFirmwareWorkflow &&
        !next.plan.actions.some((action) => action.requiresSecret || action.changesIdentity)) {
      await controller.repair({});
    }
  }

  async function recover() {
    let pairingCode: string | undefined;
    setAuthorizationError("");
    if (pairingNeeded) {
      if (!matched || !state.sessionId || state.boardStatus?.mode !== "recovery") return;
      setAuthorizing(true);
      try {
        const result = await apiFetch<{ pairingCode: string }>("/api/board-instances/recover", {
          method: "POST", body: JSON.stringify({ boardInstanceId: matched.id }),
        });
        pairingCode = result.pairingCode;
        // The protocol line the board receives carries the same code, so the
        // local page and the website never disagree about which code is live.
        wifiCodeState.current.code = result.pairingCode;
        wifiCodeState.current.generated = true;
      } catch (error) {
        setAuthorizationError(error instanceof Error ? error.message : "Account recovery could not be authorized.");
        return;
      } finally { setAuthorizing(false); }
    }
    await controller.repair({ wifi: wifiNeeded ? { ssid, password } : undefined, pairingCode, consentToRePair: pairingNeeded });
    setPassword("");
  }

  return <section className="space-y-4" aria-label="Unified board recovery">
    {!started || state.phase === "identifying" || state.phase === "error" ? <>
      {kind === "ble" ? <BleDiscoveryArtwork mode="recover" /> : kind === "wifi" ? <>
        <WifiPortalArtwork recovery />
        <div className="space-y-1"><h3 className="text-[15px] font-semibold">Recover over Wi-Fi</h3><p className="text-[12.5px] leading-relaxed text-muted-foreground">Hold BOOT / Recovery for 3 seconds, then join <strong className="font-medium text-foreground">HomecoreOS-Setup-XXXX</strong> in your Wi-Fi settings.</p></div>
        <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2.5 text-xs"><span className="text-muted-foreground">Board’s local portal</span><code className="font-medium">http://192.168.4.1</code></div>
      </> : <>
        <UsbFlashIllustration />
        <div className="space-y-1"><h3 className="text-[15px] font-semibold">Recover your board over USB</h3><p className="text-[12.5px] leading-relaxed text-muted-foreground">Connect a USB data cable and close any serial monitor. Leave the board powered on with HomecoreOS running — no button press is needed, because the installed firmware answers over USB.</p></div>
      </>}
      <p className="text-[12px] leading-relaxed text-muted-foreground">{kind === "ble" ? "Keep your board nearby. We’ll identify it, find it in your account and check what needs repairing." : kind === "wifi" ? "Once connected, we’ll identify your board automatically and check its connection." : "We’ll identify the connected board automatically. This repairs your installed controller — no flashing or erasing."}</p>
      {!support.supported && <StatusAlert tone="warning">{support.reason}</StatusAlert>}
      {state.error && <StatusAlert tone="danger">{state.error.message}</StatusAlert>}
      {state.phase === "identifying" && <p role="status" className="text-xs text-muted-foreground">{state.progress ?? "Looking for your board…"}</p>}
      <div className="flex items-center justify-between gap-3 border-t pt-3">
        <span className="text-[11.5px] text-muted-foreground">{kind === "usb" ? "Desktop Chrome / Edge · HTTPS" : kind === "ble" ? "Bluetooth enabled · Chrome / Edge" : "Local network access required"}</span>
        <Button disabled={!canManage || busy || !support.supported} onClick={discover}>
          {busy ? <RiLoader4Line className="size-4 animate-spin" /> : <RiArrowRightLine className="size-4" />}
          {state.phase === "identifying" ? "Connecting…" : state.phase === "error" ? "Reconnect & retry" : kind === "ble" ? "Discover BLE Board" : kind === "usb" ? "Connect USB Board" : "Connect to Board"}
        </Button>
      </div>
    </> : <>
      {kind === "usb" && <UsbFlashIllustration active={busy} size="sm" />}
      {matched && <div className="flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"><RiCpuLine className="size-4" /></div>
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{matched.name}</p><p className="text-xs text-muted-foreground">{state.board.firmwareVersion ? `Firmware ${state.board.firmwareVersion} · ` : ""}{method} · {state.board.hardwareUid}</p></div>
        <Badge variant={verified ? "success-light" : "secondary"} radius="full">{complete ? verified ? "Verified" : "Needs attention" : "Identified"}</Badge>
      </div>}
      <div className="space-y-1"><h3 className="text-base font-semibold">{complete ? verified ? "Your board is ready!" : "Recovery needs attention" : ready ? wifiNeeded ? "Update your Wi-Fi connection" : pairingNeeded ? "Authorize account recovery" : "Recovery plan" : "Recovering your board"}</h3>
        <p className="text-xs text-muted-foreground" role="status">{state.progress ?? (complete ? state.report?.nextAction ?? "Connection checked. Your board identity and assignments are preserved." : "We’ve checked your board. Only the necessary repairs will be applied.")}</p>
      </div>
      {!ready && <Frame spacing="sm"><FramePanel className="p-0"><ol aria-label="Recovery progress" className="divide-y">{state.steps.map((step) => <li key={step.id} className="flex items-center gap-3 px-3 py-2.5">
        <span className={`flex size-5 shrink-0 items-center justify-center rounded-full ${step.state === "done" ? "bg-emerald-500/10 text-emerald-600" : step.state === "active" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
          {step.state === "active" ? <RiLoader4Line className="size-3.5 animate-spin" /> : step.state === "done" ? <RiCheckLine className="size-3.5" /> : step.state === "error" || step.state === "warning" ? <RiErrorWarningLine className="size-3.5 text-amber-600" /> : <RiSubtractLine className="size-3" />}
        </span><span className={`flex-1 text-[12.5px] ${step.state === "pending" ? "text-muted-foreground" : "font-medium"}`}>{step.label}</span><span className="text-[10.5px] capitalize text-muted-foreground">{step.state === "done" ? "Completed" : step.state === "active" ? "In progress" : step.state}</span>
      </li>)}</ol></FramePanel></Frame>}
      {ready && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void recover(); }}>
        {state.plan?.summary.length ? <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">{state.plan.summary.map((row, i) => <p key={i} className={i ? "mt-2" : ""}><strong className="font-medium text-foreground">{row.problem}</strong><br />{row.action}</p>)}</div> : null}
        {wifiNeeded && <div className="space-y-3">
          <FormField id="recovery-ssid" label="Wi-Fi Network Name (SSID)"><Input id="recovery-ssid" value={ssid} onChange={(event) => setSsid(event.target.value)} placeholder="Enter your 2.4 GHz Wi-Fi name" autoComplete="off" required /></FormField>
          <FormField id="recovery-password" label="Wi-Fi Password"><Input id="recovery-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter Wi-Fi password" autoComplete="new-password" /></FormField>
        </div>}
        {pairingNeeded && <StatusAlert tone="warning">Account recovery replaces this board’s authentication credentials. Your devices and assignments stay in place. Choose Authorize & Recover only if you want to re-pair this board. A live server session and physical recovery mode are required.</StatusAlert>}
        {(authorizationError || state.needs) && <StatusAlert tone="danger">{authorizationError || state.needs?.message}</StatusAlert>}
        {state.plan?.requiresFirmwareWorkflow ? <><StatusAlert tone="warning">This firmware cannot support the required repair. Recovery will not write or erase firmware.</StatusAlert><Button type="button" onClick={onFlash}>Open separate Flash Board workflow</Button></> : <div className="flex justify-end border-t pt-3"><Button disabled={!canManage || busy || (wifiNeeded && !ssid.trim()) || (pairingNeeded && (!state.sessionId || state.boardStatus?.mode !== "recovery"))} type="submit">{authorizing && <RiLoader4Line className="size-4 animate-spin" />}{pairingNeeded ? "Authorize & Recover" : "Save & Recover"}<RiArrowRightLine className="size-4" /></Button></div>}
      </form>}
      {complete && <>
        <StatusAlert tone={verified ? "success" : "warning"}>{state.report?.verification.summary}{state.report?.sessionId === "local" ? " This report is local only; the server could not record it." : ""}</StatusAlert>
        <div className="flex justify-end"><Button variant="outline" onClick={discover} disabled={!canManage || busy}>Check again</Button></div>
      </>}
    </>}
    {started && <details className="rounded-lg border text-xs"><summary className="cursor-pointer px-3 py-2.5 font-medium text-muted-foreground">Diagnostic details</summary><div className="space-y-4 border-t px-3 py-3">
      {state.diagnostics && <ul className="space-y-2">{state.diagnostics.checks.map((check) => <li key={check.id}><div className="flex justify-between gap-3"><strong className="font-medium">{check.label}</strong><span className="text-muted-foreground">{check.status === "unknown" ? "Unable to verify" : check.status}</span></div><p className="mt-0.5 text-muted-foreground">{check.summary}</p></li>)}</ul>}
      {state.report && <><h4 className="font-medium">Final verification</h4><ul className="space-y-2">{state.report.verification.checks.map((check) => <li key={check.id}>{check.label}: {check.status === "unknown" ? "Unable to verify" : check.status}<p className="text-muted-foreground">{check.detail}</p></li>)}</ul><p>Session: {state.report.sessionId}</p><p>Unresolved: {state.report.unresolvedProblems.join(", ") || "None confirmed"}</p></>}
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{state.technical.join("\n")}</pre>
    </div></details>}
  </section>;
}
