import React, { useMemo, useState } from 'react';
import { api, useLiveData } from '../api';
import { useAuth } from '../state';
import { Badge, Card, Field, Icon, Modal, Notice, StatusBadge, timeAgo } from '../components';

/**
 * Controller management for one controller: connection, Wi-Fi, cloud link and
 * pairing status, plus the owner's actions. Every action states what it changes.
 * Nothing is reported as done until the controller has confirmed it.
 */

type Action = 'reboot' | 'open_setup' | 'reset_wifi' | 'unpair' | 'factory_reset';

const ACTION_COPY: Record<Action, { title: string; button: string; body: string; tone: 'info' | 'warn' | 'danger' }> = {
  reboot: {
    title: 'Restart controller?', button: 'Restart', tone: 'info',
    body: 'The controller restarts and reconnects. Nothing is erased, and its pairing and Wi-Fi are kept.',
  },
  open_setup: {
    title: 'Change Wi-Fi?', button: 'Open setup network', tone: 'info',
    body: 'The controller opens its HomecoreOS-Setup network while it stays connected. Join that network from your phone, enter the new Wi-Fi details and the setup PIN. Its current Wi-Fi and pairing are kept until the new details are saved.',
  },
  reset_wifi: {
    title: 'Reset Wi-Fi?', button: 'Reset Wi-Fi', tone: 'warn',
    body: 'The controller forgets its Wi-Fi network and goes offline from HomecoreOS. Your home stays paired. To bring it back, join its setup network and enter Wi-Fi with the setup PIN, or hold the BOOT button for 3 seconds on the controller.',
  },
  unpair: {
    title: 'Unpair controller?', button: 'Unpair', tone: 'warn',
    body: 'The controller confirms, then returns to pairing mode and keeps its Wi-Fi. The HomecoreOS record is released only after that confirmation. To pair it again, use Re-pair.',
  },
  factory_reset: {
    title: 'Factory reset?', button: 'Factory reset', tone: 'danger',
    body: 'The controller erases its pairing, Wi-Fi, setup PIN and saved configuration, then returns to pairing mode. HomecoreOS releases it only after it confirms. The controller must be online for this. If it is offline, use Disconnect, or hold BOOT for 10 seconds on the controller.',
  },
};

const COMMAND_STATUS: Record<string, { label: string; tone: 'on' | 'off' | 'warn' | 'danger' }> = {
  queued: { label: 'Sending…', tone: 'warn' },
  published: { label: 'Waiting for the controller to confirm…', tone: 'warn' },
  acknowledged: { label: 'Confirmed by the controller', tone: 'on' },
  failed: { label: 'Failed on the controller', tone: 'danger' },
  rejected: { label: 'Refused by the controller', tone: 'danger' },
  expired: { label: 'Not confirmed in time. Nothing was changed.', tone: 'danger' },
};

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function ControllerManagement({ board, onChanged }: { board: any; onChanged: () => void }) {
  const { can, toast } = useAuth() as any;  // same toast as the rest of the console
  const { data: commands, refresh: refreshCommands } = useLiveData<any[]>('/api/commands');
  const [confirm, setConfirm] = useState<Action | 'disconnect' | null>(null);
  const [typedId, setTypedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [trackedId, setTrackedId] = useState<string | null>(null);
  const [repairCode, setRepairCode] = useState<any>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');

  const conn = board?.connectivity || null;
  const offline = board?.status !== 'online';
  const unclaimed = board?.status === 'unclaimed';
  const pinSet = !!conn?.setup_pin_set;
  const canManage = can('devices.manage');

  const tracked = useMemo(
    () => (trackedId && commands ? (commands as any[]).find((c) => c.id === trackedId) || null : null),
    [trackedId, commands],
  );
  const trackedStatus = tracked ? COMMAND_STATUS[tracked.status] || { label: tracked.status, tone: 'warn' as const } : null;
  const released = tracked && tracked.status === 'acknowledged' && (tracked.action === 'unpair' || tracked.action === 'factory_reset') && unclaimed;

  const send = async (action: Action) => {
    setBusy(true);
    try {
      const r: any = await api.post(`/api/boards/${board.id}/command`, { action });
      setTrackedId(r.command?.id || null);
      refreshCommands();
      toast(`${ACTION_COPY[action].button} sent. Waiting for the controller to confirm.`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.del(`/api/boards/${board.id}`, { confirm: typedId });
      toast('Controller disconnected. Its old credentials are revoked.');
      setConfirm(null);
      onChanged();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const repair = async () => {
    setBusy(true);
    try {
      setRepairCode(await api.post(`/api/boards/${board.id}/repair`));
      onChanged();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const savePin = async () => {
    if (!/^[0-9]{6,12}$/.test(pin)) { toast('Use 6 to 12 digits', 'error'); return; }
    if (pin !== pinConfirm) { toast('The two PINs do not match', 'error'); return; }
    setBusy(true);
    try {
      // The PIN is hashed here. Only the hash of "<device id>:<PIN>" is sent.
      const pinHash = await sha256Hex(`${board.device_id}:${pin}`);
      const r: any = await api.post(`/api/boards/${board.id}/command`, { action: 'set_setup_pin', pin_hash: pinHash });
      setTrackedId(r.command?.id || null);
      refreshCommands();
      setPinOpen(false);
      setPin(''); setPinConfirm('');
      toast('Setup PIN sent. Waiting for the controller to confirm.');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // The controller must be online to confirm any of these. Offline, it is reached only on its own setup network.
  const actionDisabled = (a: Action) => busy || !canManage || offline || unclaimed || (a === 'open_setup' && !pinSet);

  return <>
    <div className="grid grid-2" style={{ marginBottom: 16 }}>
      <Card title="Live status" sub={conn?.updated_at ? `Reported ${timeAgo(conn.updated_at)}` : 'The controller has not reported its status yet'}>
        <dl className="kv">
          <dt>Connection</dt><dd><StatusBadge status={board.status} /> <span className="tiny">last seen {timeAgo(board.last_seen_at)}</span></dd>
          <dt>Pairing</dt><dd>{conn?.pairing?.state ? <Badge tone={conn.pairing.state === 'paired' ? 'on' : 'warn'}>{pairingLabel(conn.pairing.state)}</Badge> : <span className="tiny">Not reported</span>}</dd>
          <dt>Wi-Fi</dt><dd>{conn?.wifi ? <>
            {wifiLabel(conn.wifi.state)}{conn.wifi.ssid ? <> · {conn.wifi.ssid}</> : null}
            {conn.wifi.rssi != null && <span className="tiny"> · {conn.wifi.rssi} dBm</span>}
            {conn.wifi.ip && <span className="tiny mono"> · {conn.wifi.ip}</span>}
            {conn.wifi.last_error && <div className="tiny" style={{ color: 'var(--danger, #d33)' }}>Last failure: {wifiError(conn.wifi.last_error)}</div>}
            {conn.wifi.fallback_ap && <div><Badge tone="warn">Temporary setup network is open</Badge></div>}
          </> : <span className="tiny">Not reported</span>}</dd>
          <dt>Cloud link</dt><dd>{conn?.mqtt ? <>
            {conn.mqtt.state === 'connected' ? 'Connected' : 'Not connected'}
            {conn.mqtt.last_error === 'credentials_refused' && <div className="tiny" style={{ color: 'var(--danger, #d33)' }}>The platform refused this controller's credentials</div>}
          </> : <span className="tiny">Not reported</span>}</dd>
          <dt>Setup PIN</dt><dd>{conn ? (pinSet ? 'Set' : 'Not set. Wi-Fi changes need a PIN.') : <span className="tiny">Not reported</span>}</dd>
        </dl>
      </Card>

      <Card title="Actions" sub="Each action states what it changes. Success is shown only after the controller confirms.">
        {!canManage && <Notice tone="info">Your role can view this controller but cannot change it.</Notice>}
        {unclaimed && <Notice tone="warn" title="This controller is not paired">Re-pair it to bring it back into this home. Its MQTT identity was released.</Notice>}
        {!unclaimed && offline && <Notice tone="warn" title="The controller is offline">These actions need it online so it can confirm them. If it opened its HomecoreOS-Setup network, join that network and enter Wi-Fi with the setup PIN there. Otherwise, Disconnect now and re-pair it once it is reachable.</Notice>}
        {!unclaimed && !pinSet && <Notice tone="info">Set a setup PIN before changing Wi-Fi. Until then, Change Wi-Fi is off. The BOOT button still works on the controller.</Notice>}
        <div className="ctrl-actions" style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          <button className="btn" disabled={actionDisabled('open_setup')} onClick={() => setConfirm('open_setup')}><Icon.wifi />Change Wi-Fi</button>
          <button className="btn" disabled={actionDisabled('reboot')} onClick={() => setConfirm('reboot')}><Icon.refresh />Restart</button>
          <button className="btn" disabled={actionDisabled('reset_wifi')} onClick={() => setConfirm('reset_wifi')}><Icon.wifi />Reset Wi-Fi</button>
          <button className="btn" disabled={!canManage || busy || offline || unclaimed} onClick={() => { setPin(''); setPinConfirm(''); setPinOpen(true); }}><Icon.key />{pinSet ? 'Change setup PIN' : 'Set setup PIN'}</button>
          <button className="btn" disabled={actionDisabled('unpair')} onClick={() => setConfirm('unpair')}><Icon.link />Unpair</button>
          <button className="btn btn-danger" disabled={actionDisabled('factory_reset')} onClick={() => setConfirm('factory_reset')}><Icon.warning />Factory reset</button>
          <button className="btn btn-danger" disabled={!canManage || busy || unclaimed} onClick={() => { setTypedId(''); setConfirm('disconnect'); }}><Icon.trash />Disconnect</button>
          {unclaimed && <button className="btn btn-primary" disabled={!canManage || busy} onClick={repair}><Icon.plug />Re-pair</button>}
        </div>
        {tracked && trackedStatus && <div style={{ marginTop: 14 }} role="status">
          <div className="tiny">{ACTION_LABEL[tracked.action] || tracked.action}</div>
          <Badge tone={trackedStatus.tone}>{trackedStatus.label}</Badge>
          {tracked.error && <div className="tiny" style={{ marginTop: 4 }}>{tracked.error}</div>}
          {released && <div style={{ marginTop: 6 }}><Notice tone="success" title="Released">The controller confirmed and is back in pairing mode.</Notice></div>}
          {tracked.action === 'open_setup' && tracked.status === 'acknowledged' && <div style={{ marginTop: 6 }}><Notice tone="info" title="Setup network is open">Join its HomecoreOS-Setup network and open the setup page. The controller stays connected while you do this.</Notice></div>}
        </div>}
      </Card>
    </div>

    {confirm && confirm !== 'disconnect' && <Modal title={ACTION_COPY[confirm].title} onClose={() => setConfirm(null)}
      footer={<><button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
        <button className={`btn ${ACTION_COPY[confirm].tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={() => send(confirm)}>{ACTION_COPY[confirm].button}</button></>}>
      <Notice tone={ACTION_COPY[confirm].tone}>{ACTION_COPY[confirm].body}</Notice>
    </Modal>}

    {confirm === 'disconnect' && <Modal title="Disconnect controller?" onClose={() => setConfirm(null)}
      footer={<><button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
        <button className="btn btn-danger" disabled={typedId !== board.device_id || busy} onClick={disconnect}>Disconnect now</button></>}>
      <Notice tone="danger">Disconnect takes effect at once, even if the controller is offline. Its old MQTT identity is revoked and it cannot reach HomecoreOS again. It returns to pairing mode the next time it reaches the platform. Its Wi-Fi is kept. Re-pair it to bring it back.</Notice>
      <Field label={`Type ${board.device_id} to confirm`}><input className="input mono" value={typedId} onChange={(e) => setTypedId(e.target.value)} /></Field>
    </Modal>}

    {repairCode && <Modal title="Re-pair controller" onClose={() => setRepairCode(null)}
      footer={<button className="btn" onClick={() => setRepairCode(null)}>Done</button>}>
      <Notice tone="info">Enter this code on the controller in pairing mode. It expires in about {Math.round((repairCode.seconds_left || 300) / 60)} minutes and cannot be shown again.</Notice>
      <div className="mono" style={{ fontSize: 28, letterSpacing: '.3em', textAlign: 'center', margin: '18px 0' }}>{repairCode.code}</div>
      <p className="tiny">This page updates when the controller registers. Until then, nothing has been paired.</p>
    </Modal>}

    {pinOpen && <Modal title={pinSet ? 'Change setup PIN' : 'Set setup PIN'} onClose={() => setPinOpen(false)}
      footer={<><button className="btn" onClick={() => setPinOpen(false)}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={savePin}>Save PIN</button></>}>
      <Notice tone="info">The PIN is needed on the controller's setup page before Wi-Fi can be changed. It is hashed in your browser. HomecoreOS never stores the PIN itself. Five wrong tries lock the setup page for ten minutes.</Notice>
      <Field label="New setup PIN (6 to 12 digits)"><input className="input mono" inputMode="numeric" type="password" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} /></Field>
      <Field label="Repeat PIN"><input className="input mono" inputMode="numeric" type="password" autoComplete="off" value={pinConfirm} onChange={(e) => setPinConfirm(e.target.value)} /></Field>
    </Modal>}
  </>;
}

const ACTION_LABEL: Record<string, string> = {
  reboot: 'Restart', open_setup: 'Change Wi-Fi', reset_wifi: 'Reset Wi-Fi', unpair: 'Unpair',
  factory_reset: 'Factory reset', set_setup_pin: 'Setup PIN',
};

function pairingLabel(state: string) {
  return ({ paired: 'Paired', pending: 'Registering', unpaired: 'Not paired' } as Record<string, string>)[state] || state;
}

function wifiLabel(state: string) {
  return ({ connected: 'Connected', reconnecting: 'Reconnecting', connecting: 'Connecting', no_credentials: 'No Wi-Fi saved', idle: 'Idle' } as Record<string, string>)[state] || state;
}

function wifiError(code: string) {
  return ({
    wrong_password: 'wrong password',
    network_not_found: 'network not in range',
    router_unreachable: 'router unreachable',
    unknown: 'unknown reason',
  } as Record<string, string>)[code] || code;
}

