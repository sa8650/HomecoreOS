import { useEffect, useMemo, useState } from "react";
import { describeTransportCapability, type RecoveryTransportKind } from "@homecoreos/shared";
import type { BoardProfileItem, ControllerItem } from "@/features/types";
import { HomecoreBleClient, isWebBluetoothSupported } from "@/lib/ble-provisioning";
import { createRecoveryController } from "@/lib/recovery-engine";
import { recoveryServerApi } from "@/lib/recovery-api";
import { createBleRecoveryTransport, createUsbRecoveryTransport, createWifiRecoveryTransport, isRecoverySerialSupported } from "@/lib/recovery-transport";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function UnifiedRecoveryPanel({ kind, controllers, target, profiles = [], canManage, onFlash }: {
  kind: RecoveryTransportKind;
  controllers: ControllerItem[];
  profiles?: BoardProfileItem[];
  target?: ControllerItem | null;
  canManage: boolean;
  onFlash: () => void;
}) {
  const [selected, setSelected] = useState(target?.id ?? "");
  const board = target ?? controllers.find((item) => item.id === selected);
  if (!board) return <div className="space-y-3">
    <p>{kind === "wifi" ? "Join HomecoreOS-Setup-XXXX; local portal: http://192.168.4.1." : kind === "usb" ? "USB data cable and desktop Chrome/Edge required. No firmware is written." : "Bluetooth LE and Chrome/Edge over HTTPS required."}</p>
    <p>Select the existing controller to repair. Recovery never creates a duplicate board record.</p>
    <label className="block">Controller<select aria-label="Controller to repair" className="mt-1 w-full rounded border p-2" value={selected} onChange={(e) => setSelected(e.target.value)}>
      <option value="">Choose controller</option>
      {controllers.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.hardware_uid ?? "identity unknown"}</option>)}
    </select></label>
    {!controllers.length && <p>No installed controllers found. Restore deleted boards from My Boards trash before repairing them. Use Setup Board for a new installation.</p>}
  </div>;
  return <RecoveryRun key={`${kind}:${board.id}`} kind={kind} board={board} profile={profiles.find((p) => p.id === (board.board_profile_id ?? board.custom_board_profile_id))} canManage={canManage} onFlash={onFlash} />;
}

function RecoveryRun({ kind, board, profile, canManage, onFlash }: { kind: RecoveryTransportKind; board: ControllerItem; profile?: BoardProfileItem; canManage: boolean; onFlash: () => void }) {
  const controller = useMemo(() => createRecoveryController({
    boardInstanceId: board.id,
    boardFallbacks: { model: board.board_model },
    expectedHardwareUid: board.hardware_uid,
    api: recoveryServerApi,
    capabilityFor: (transport) => {
      const ble = isWebBluetoothSupported();
      const usb = isRecoverySerialSupported();
      return describeTransportCapability({ transport,
        browserSupported: transport === "ble" ? ble.supported : transport === "usb" ? usb.available : true,
        browserReason: transport === "ble" ? ble.reason : usb.reason,
        boardSupportsWifi: profile?.supports_wifi !== false, boardSupportsBle: profile?.supports_ble !== false, boardFirmwareSupportsDiagnostics: true,
      });
    },
    createTransport: (transport) => transport === "usb" ? createUsbRecoveryTransport({})
      : transport === "wifi" ? createWifiRecoveryTransport({})
        : createBleRecoveryTransport({ createClient: () => new HomecoreBleClient(), candidatePins: board.ble_setup_pin ? [board.ble_setup_pin] : undefined, support: isWebBluetoothSupported() }),
  }), [board, profile]);
  const [state, setState] = useState(controller.getState);
  const [ssid, setSsid] = useState(board.wifi_ssid ?? "");
  const [password, setPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [issuingCode, setIssuingCode] = useState(false);
  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    return () => { unsubscribe(); void controller.cancel("Recovery dialog closed."); };
  }, [controller]);
  useEffect(() => {
    if (state.error) { setPassword(""); setCode(""); setConsent(false); }
  }, [state.error]);
  const busy = ["identifying", "diagnostics", "repairing", "verifying"].includes(state.phase);
  const ready = state.phase === "plan" || state.phase === "awaiting_input";
  const wifiNeeded = state.plan?.actions.some((a) => a.requiresSecret === "wifi");
  const pairingNeeded = state.plan?.actions.some((a) => a.id === "repair_pairing");
  const connected = Boolean(state.boardStatus) && state.phase !== "report" && state.phase !== "error";
  return <section className="space-y-4" aria-label="Unified board recovery">
    <div className="rounded border p-3 text-sm">
      <h3 className="font-semibold">Prepare Board for Recovery</h3>
      <p>Hold the BOOT / Recovery button on your board for 3 seconds.</p>
      {kind === "usb" ? <p>Use desktop Chrome or Edge over HTTPS and a USB data cable. Close serial monitors. This repairs installed firmware; it never flashes or erases the board.</p>
        : kind === "wifi" ? <p>Join HomecoreOS-Setup-XXXX in your device network settings, then connect below. Local portal: http://192.168.4.1. Permit local network access if prompted; this browser cannot select a Wi-Fi network for you.</p>
          : <p>Enable Bluetooth in Chrome or Edge over HTTPS. Choose the correct nearby HomecoreOS board in the browser prompt.</p>}
      <p>Selected: {board.name} · {board.hardware_uid ?? "identity unavailable"}</p>
      <p role="status">Connection: {connected ? "Connected" : busy ? "Connecting / working" : "Disconnected"}</p>
    </div>
    {(state.phase === "idle" || state.phase === "error" || state.phase === "report") && <Button disabled={!canManage || busy} onClick={async () => {
      setPassword(""); setCode(""); setConsent(false); setConfirmed(false);
      await controller.cancel();
      await controller.connect(kind);
    }}>{state.phase === "idle" ? "Connect & identify controller" : "Reconnect & retry"}</Button>}
    {state.boardStatus && <div className="rounded border p-3 text-sm">
      <p>Detected: {state.board.model ?? state.board.boardSlug} · ID suffix {state.board.hardwareUid ?? "unknown"}</p>
      <p>Hardware revision: {profile?.revision ?? "Unknown / Unable to verify"}</p>
      <p>Firmware: {state.board.firmwareVersion ?? "Unknown"} · {state.boardStatus.paired ? "Paired" : "Unpaired"} · {state.boardStatus.mode}</p>
      {!ready && !busy && state.phase !== "report" && state.phase !== "error" && <>
        <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I confirm this is the physical controller I intend to repair.</label>
        <Button disabled={!confirmed} onClick={() => controller.diagnose()}>Run diagnostics</Button>
      </>}
    </div>}
    <ol className="space-y-1 text-sm" aria-label="Recovery progress">{state.steps.map((step) => <li key={step.id}><strong>{step.label}</strong> — {step.state}{step.detail && <p className="text-muted-foreground">{step.detail}</p>}</li>)}</ol>
    {state.progress && <p role="status">{state.progress}</p>}
    {state.startedAt && state.finishedAt && <p>Elapsed: {Math.round((state.finishedAt - state.startedAt) / 1000)} seconds</p>}
    {state.error && <p role="alert">{state.error.message}</p>}
    {state.diagnostics && <div><h3 className="font-semibold">Diagnostics: {state.diagnostics.status}</h3><ul>{state.diagnostics.checks.map((check) => <li key={check.id} className="py-1 text-sm">{check.label}: <strong>{check.status === "unknown" ? "Unknown / Unable to verify" : check.status}</strong> — {check.summary}</li>)}</ul></div>}
    {state.plan && <div className="space-y-2"><h3 className="font-semibold">Proposed recovery plan</h3>
      {state.plan.noActionNeeded && <p>No changes are needed. Run verification to confirm health.</p>}
      {state.plan.summary.map((row, i) => <div className="rounded border p-2 text-sm" key={i}><p>Problem: {row.problem}</p><p>Repair: {row.action}</p><p>Verification: {row.verification}</p></div>)}
      {state.plan.requiresFirmwareWorkflow && <><p>Installed firmware cannot support this repair. No firmware will be written here.</p><Button onClick={onFlash}>Open separate Flash Board workflow</Button></>}
    </div>}
    {ready && <div className="space-y-3">
      {wifiNeeded && <><label className="block">Wi-Fi SSID<Input value={ssid} onChange={(e) => setSsid(e.target.value)} autoComplete="off" /></label><label className="block">Wi-Fi password<Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label></>}
      {pairingNeeded && <><p>Account re-pairing changes authentication credentials. Ordinary network repairs preserve pairing and assignments. Physical recovery mode is required.</p>
        <label className="flex gap-2"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />I authorize account re-pairing for this board.</label>
        <Button disabled={!canManage || !consent || issuingCode || Boolean(code) || !state.sessionId || state.boardStatus?.mode !== "recovery"} onClick={async () => {
          setIssuingCode(true); setCodeError("");
          try {
            const result = await apiFetch<{ pairingCode: string }>("/api/board-instances/recover", { method: "POST", body: JSON.stringify({ boardInstanceId: board.id }) });
            setCode(result.pairingCode);
          } catch (error) { setCodeError(error instanceof Error ? error.message : "Authorization failed"); }
          finally { setIssuingCode(false); }
        }}>Authorize re-pairing</Button>{codeError && <p role="alert">{codeError}</p>}{code && <p>Single-use authorization ready. Code is not displayed or logged.</p>}</>}
      {state.needs && <p role="alert">{state.needs.message}</p>}
      <Button disabled={!canManage || state.plan?.requiresFirmwareWorkflow || (pairingNeeded && (!consent || !code))} onClick={async () => {
        await controller.repair({ wifi: wifiNeeded ? { ssid, password } : undefined, consentToRePair: consent, pairingCode: code || undefined });
        setPassword(""); setCode("");
      }}>Apply plan & verify recovery</Button>
    </div>}
    {state.report && <div className="space-y-2 rounded border p-3"><h3 className="font-semibold">Recovery report: {state.report.finalStatus}</h3>
      <p>Session: {state.report.sessionId} · {state.report.sessionId === "local" ? "Local only — server could not record this session" : "Recorded on server"}</p>
      <p>Original problems: {state.report.detectedProblems.join(", ") || "None confirmed"}</p>
      <ul>{state.report.actions.map((action, i) => <li key={i}>{action.actionId}: {action.status} — {action.message}</li>)}</ul>
      <h4 className="font-semibold">Final verification</h4>
      <ul>{state.report.verification.checks.map((check) => <li key={check.id}>{check.label}: {check.status === "unknown" ? "Unknown / Unable to verify" : check.status} — {check.detail}</li>)}</ul>
      <p>Unresolved: {state.report.unresolvedProblems.join(", ") || "None confirmed; review unknown checks"}</p>
      <p>Wi-Fi: {String(state.report.finalTelemetry.connected ?? "Unknown")} · IP assigned: {String(state.report.finalTelemetry.ipAssigned ?? "Unknown")} · API: {String(state.report.finalTelemetry.apiReachable ?? "Unknown")}</p>
      <p>Firmware: {state.report.finalTelemetry.firmwareVersion ?? "Unknown"} · MQTT: {String(state.report.finalTelemetry.mqttConnected ?? "Unknown")} · Last sync: {state.report.finalTelemetry.lastSyncAt ?? "Unknown"}</p>
      <p>{state.report.nextAction}</p>
    </div>}
    <details><summary>Technical diagnostic details</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs">{state.technical.join("\n")}</pre></details>
  </section>;
}
