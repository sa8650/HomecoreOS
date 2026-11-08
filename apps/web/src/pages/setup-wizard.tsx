/** Customer Device Setup Wizard — plain language, real connection evidence only. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useLiveData } from '../api';
import { useAuth } from '../state';
import {
  Badge, Card, CopyButton, DeviceIllustration, EmptyState, ErrorState, Field,
  Icon, Loading, Notice, PageHead, Progress, StatusBadge, SuccessState, timeFull,
} from '../components';

type ProgressResponse = {
  claimed: boolean; expired: boolean; expires_at: string; seconds_left: number;
  board: null | {
    id: string; name: string; device_id: string; status: string; firmware_version?: string;
    firmware_channel?: string; chip_family?: string; chip_model?: string; chip_revision?: string;
    mac_address?: string; sdk_version?: string; fw_build?: string; hardware_revision?: string;
    catalog_board_id?: string; last_seen_at?: string; rssi?: number; uptime_seconds?: number;
  };
};

const STEPS = ['Get ready', 'Connect to Wi-Fi', 'Pairing code', 'Watch it connect', 'All set'];

function StageLine({ state, title, detail }: { state: 'waiting' | 'active' | 'done' | 'failed'; title: string; detail: string }) {
  const glyph = state === 'done' ? 'ok' : state === 'failed' ? 'fail' : state === 'active' ? 'loader' : 'clock';
  const G = Icon[glyph];
  return <div className={`wizard-stage-line ${state}`}>
    <span className="stage-icon"><G className={state === 'active' ? 'spinner' : ''} /></span>
    <span className="grow"><span className="stage-label">{title}</span><br /><span className="stage-detail">{detail}</span></span>
    {state === 'done' && <Badge tone="on" icon="ok">Confirmed</Badge>}
    {state === 'failed' && <Badge tone="danger" icon="fail">Needs attention</Badge>}
  </div>;
}

export function SetupWizardPage() {
  const catalog = useLiveData<any[]>('/api/board-catalog');
  const boards = useLiveData<any[]>('/api/boards');
  const toast = useAuth().toast;
  const { can } = useAuth();
  const [step, setStep] = useState(0);
  const [boardId, setBoardId] = useState(new URLSearchParams(window.location.search).get('board') || '');
  const [name, setName] = useState('');
  const [boardSearch, setBoardSearch] = useState('');
  const [token, setToken] = useState('');
  const [issuedAt, setIssuedAt] = useState(0);
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [pollError, setPollError] = useState('');
  const [timeout, setTimeoutState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hardware, setHardware] = useState<any>(null);
  const timer = useRef<number | null>(null);

  const selected = (catalog.data || []).find((b: any) => b.id === boardId);
  const catalogRows = (catalog.data || []).filter((b: any) => b.attributes?.pin_status === 'verified'
    && `${b.model} ${b.manufacturer} ${b.chip_family}`.toLowerCase().includes(boardSearch.toLowerCase()));
  const canManage = can('devices.manage');

  const generate = async () => {
    setBusy(true); setPollError(''); setTimeoutState(false); setProgress(null); setHardware(null);
    try {
      const r: any = await api.post('/api/pairing-tokens', {
        catalog_board_id: boardId || null,
        board_name: name.trim() || selected?.model || 'My controller',
      });
      if (!r?.token) throw new Error('The pairing code could not be created. Please try again.');
      setToken(String(r.token)); setIssuedAt(Date.now()); setStep(3);
    } catch (e: any) { toast(e.message || 'Could not create a pairing code', 'error'); }
    finally { setBusy(false); }
  };

  // Real progress: the API reports whether the token was consumed and whether a
  // controller has actually come online. Nothing here advances on a timer alone.
  useEffect(() => {
    if (step !== 3 || !token) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await api.get<ProgressResponse>(`/api/setup/progress?token=${encodeURIComponent(token)}`);
        if (!alive) return;
        setProgress(r); setPollError('');
        if (r.expired) { setTimeoutState(true); }
        if (r.board && (r.board.status === 'online' || r.board.status === 'provisioning')) {
          const fresh: any[] = await api.get('/api/boards');
          const match = fresh.find((b) => b.id === r.board!.id);
          if (match) setHardware({ ...r.board, ...match, name: match.name || r.board!.name });
          else setHardware(r.board);
          if (r.board.status === 'online') {
            boards.refresh();
            setStep(4);
            return;
          }
        }
      } catch (e: any) {
        if (alive) setPollError(e.message || 'Could not check the connection.');
      }
      if (alive) timer.current = window.setTimeout(poll, 2000);
    };
    void poll();
    return () => { alive = false; if (timer.current) window.clearTimeout(timer.current); };
  }, [step, token]);

  useEffect(() => {
    if (step !== 3 || !token) return;
    const t = window.setInterval(() => {
      if (Date.now() - issuedAt > 5 * 60 * 1000) setTimeoutState(true);
    }, 5000);
    return () => window.clearInterval(t);
  }, [step, token, issuedAt]);

  const cancel = async () => {
    if (token) { try { await api.post('/api/setup/cancel', { token }); } catch { /* already expired */ } }
    setToken(''); setProgress(null); setHardware(null); setTimeoutState(false);
    setPollError(''); setStep(0);
  };
  const retry = () => { setToken(''); setProgress(null); setHardware(null); setTimeoutState(false); setPollError(''); setStep(2); };

  const online = step === 4 && hardware?.status === 'online';
  const claimed = !!progress?.claimed;
  const elapsed = issuedAt ? Math.min(100, Math.round(((Date.now() - issuedAt) / 1000 / 300) * 100)) : 0;
  const illustrationState = step === 4 && online ? 'done' : timeout || (step === 3 && pollError) ? 'error'
    : step === 3 ? (claimed ? 'cloud' : 'scanning') : step === 1 ? 'wifi' : 'ready';
  const secondsLeft = progress?.seconds_left ?? 0;

  const stages = useMemo(() => [
    { key: 'ready', title: 'Controller ready', state: step >= 1 ? 'done' : 'active',
      detail: step >= 1 ? 'Board and name chosen' : 'Choose your board and give it a name' },
    { key: 'wifi', title: 'Joining your Wi-Fi', state: step >= 2 ? 'done' : 'waiting',
      detail: 'This happens on the controller. The console cannot see your Wi-Fi password.' },
    { key: 'code', title: 'Pairing code entered', state: claimed || step >= 4 ? 'done' : step === 3 ? 'active' : 'waiting',
      detail: claimed ? 'The controller used the one-time code' : 'Waiting for the controller to use the code' },
    { key: 'secure', title: 'Secure identity registered', state: claimed ? 'done' : 'waiting',
      detail: claimed ? 'The controller now has its own private credentials' : 'Happens automatically after pairing' },
    { key: 'online', title: 'Connected to your home', state: online ? 'done' : timeout ? 'failed' : step === 3 ? 'active' : 'waiting',
      detail: online ? 'The controller reported that it is online' : timeout ? 'No connection was confirmed' : 'Waiting for a real status report from the controller' },
  ] as { key: string; title: string; state: 'waiting' | 'active' | 'done' | 'failed'; detail: string }[],
  [step, claimed, online, timeout]);

  return <>
    <PageHead title="Add a controller" eyebrow="Device setup"
      desc="A short guided setup for your ESP32 controller. We only call it connected once the controller actually reports back."
      actions={<Link className="btn" to="/controllers"><Icon.cpu />My controllers<Icon.next /></Link>} />
    <div className="stepper" aria-label="Setup progress">
      {STEPS.map((s, i) => <React.Fragment key={s}>
        <div className={`step ${i === step ? 'on' : i < step ? 'done' : ''}`}>
          <span className="num">{i < step ? <Icon.check /> : i + 1}</span><span>{s}</span>
        </div>{i < STEPS.length - 1 && <span className="step-line" />}
      </React.Fragment>)}
    </div>

    {catalog.loading && <Loading rows={3} />}
    {catalog.error && <ErrorState text={catalog.error} onRetry={catalog.refresh} />}

    <div className="wizard-layout">
      <Card>
        {step === 0 && <>
          <h2 className="text-h6">1. Get your controller ready</h2>
          <p className="muted" style={{ margin: '8px 0 20px', fontSize: 13 }}>
            Choose the board you have, then give it a name you will recognise at home.
          </p>
          <div className="wizard-illustration" style={{ marginBottom: 20 }}>
            <DeviceIllustration state="ready" />
          </div>
          <Field label="What to do now" hint="You do not need any cables or computer software for this step.">
            <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 2, fontSize: 13 }}>
              <li>Place the controller near your Wi-Fi router.</li>
              <li>Connect its USB power cable and wait about 30 seconds.</li>
              <li>Leave the controller powered on until setup is finished.</li>
            </ol>
          </Field>
          <div className="divider" />
          <Field label="Find your board" hint="Only boards with a checked pin map can be added.">
            <div className="search" style={{ marginBottom: 8 }}><Icon.search />
              <input className="input" placeholder="Search board models" value={boardSearch}
                onChange={(e) => setBoardSearch(e.target.value)} /></div>
            <select className="select" value={boardId} onChange={(e) => { setBoardId(e.target.value); setName(''); }}>
              <option value="">Select a board</option>
              {catalogRows.map((b: any) => <option key={b.id} value={b.id}>{b.manufacturer} {b.model} · {b.chip_family}</option>)}
            </select>
          </Field>
          <Field label="Name this controller"><input className="input" value={name}
            onChange={(e) => setName(e.target.value)} placeholder="Living room controller" /></Field>
          {selected && <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div className="kv"><dt>Board</dt><dd>{selected.model}</dd>
              <dt>Chip</dt><dd>{selected.chip_family} · {selected.chip_variant}</dd>
              <dt>Revision</dt><dd>{selected.revision || 'Not stated'}</dd>
              <dt>Documented pins</dt><dd>{selected.pins?.length || 0}</dd></div>
            {selected.pinout_url && <a className="btn btn-sm" style={{ marginTop: 12 }} href={selected.pinout_url}
              target="_blank" rel="noreferrer"><Icon.book />See the official pinout</a>}
          </div>}
          <button className="btn btn-primary btn-block" disabled={!boardId || !canManage}
            onClick={() => setStep(1)}>Continue <Icon.next /></button>
          {!canManage && <div style={{ marginTop: 12 }}><Notice tone="warn">Your account does not have permission to add controllers. Ask the home owner for access.</Notice></div>}
        </>}

        {step === 1 && <>
          <h2 className="text-h6">2. Connect it to your Wi-Fi</h2>
          <p className="muted" style={{ margin: '8px 0 20px', fontSize: 13 }}>
            The controller makes its own temporary Wi-Fi network so you can tell it which home network to use.
          </p>
          <div className="wizard-illustration" style={{ marginBottom: 20 }}>
            <DeviceIllustration state="wifi" />
          </div>
          <Field label="Do exactly this on your phone or laptop">
            <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 2.1, fontSize: 13 }}>
              <li>Open your Wi-Fi settings.</li>
              <li>Choose the network that starts with <b>HomecoreOS-Setup-</b>.</li>
              <li>A setup page opens. If it does not, open <b>192.168.4.1</b> in your browser.</li>
              <li>Select your home Wi-Fi, enter its password and press <b>Save</b>.</li>
              <li>Wait for the controller to restart, then come back here.</li>
            </ol>
          </Field>
          <Notice tone="info" title="Keep this page open">Your Wi-Fi password is entered on the controller, never on this website. The controller will connect on its own.</Notice>
          <div className="divider" />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => setStep(0)}><Icon.back />Back</button>
            <button className="btn btn-primary" onClick={() => setStep(2)}>My controller is connected <Icon.next /></button>
            <button className="btn btn-ghost" onClick={cancel}>Cancel setup</button>
          </div>
        </>}

        {step === 2 && <>
          <h2 className="text-h6">3. Create a one-time pairing code</h2>
          <p className="muted" style={{ margin: '8px 0 20px', fontSize: 13 }}>
            This code links the controller to your home. It works once and expires after 15 minutes.
          </p>
          <div className="wizard-illustration" style={{ marginBottom: 20 }}>
            <DeviceIllustration state="ready" />
          </div>
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div className="kv"><dt>Controller</dt><dd>{name.trim() || selected?.model || 'My controller'}</dd>
              <dt>Board</dt><dd>{selected?.model || 'Not selected'}</dd>
              <dt>Code lifetime</dt><dd>15 minutes, single use</dd></div>
          </div>
          <Notice title="Where to enter the code">On the controller's setup page, paste the code into the HomecoreOS pairing field and press Connect. You will copy the code on the next screen.</Notice>
          <div className="divider" />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => setStep(1)}><Icon.back />Back</button>
            <button className="btn btn-primary" onClick={generate} disabled={busy || !canManage}>
              {busy ? <><Icon.loader className="spinner" />Creating…</> : <>Create pairing code <Icon.next /></>}
            </button>
            <button className="btn btn-ghost" onClick={cancel}>Cancel setup</button>
          </div>
        </>}

        {step === 3 && <>
          <h2 className="text-h6">4. Watch it connect</h2>
          <p className="muted" style={{ margin: '8px 0 20px', fontSize: 13 }}>
            Paste this code into the controller's setup page. The list below updates from real device reports.
          </p>
          <div className="wizard-illustration" style={{ marginBottom: 16 }}>
            <DeviceIllustration state={illustrationState as any} />
          </div>
          <Field label="One-time pairing code" hint="It disappears when you leave this step. You can create a new one if needed.">
            <div className="code" style={{ marginBottom: 8 }}>{token}</div>
            <CopyButton value={token} label="Copy code" />
          </Field>
          <div className="card card-pad" style={{ margin: '16px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ fontSize: 13 }}>Live connection status</strong>
              <span className="status-live"><span className="dot pulse" style={{ color: 'var(--accent)' }} />
                {timeout ? 'Stopped' : 'Checking every 2 seconds'}</span>
            </div>
            <Progress value={online ? 100 : claimed ? 70 : elapsed} tone={timeout ? 'danger' : online ? 'on' : 'warn'} />
            {stages.map(({ key, ...stage }) => <StageLine key={key} {...stage} />)}
            {secondsLeft > 0 && !timeout && <div className="tiny" style={{ marginTop: 8 }}>
              Code expires in {Math.floor(secondsLeft / 60)} min {secondsLeft % 60} s</div>}
          </div>
          {pollError && <div style={{ marginBottom: 12 }}><div className="notice danger"><Icon.fail />{pollError}</div></div>}
          {timeout && <div style={{ marginBottom: 12 }}><ErrorState title="We could not confirm a connection"
            text="The controller has not reported back, or the pairing code expired. Check that it has power and Wi-Fi, then try again with a new code."
            onRetry={retry} /></div>}
          {!timeout && progress?.expired && <div style={{ marginBottom: 12 }}><Notice tone="warn" title="The pairing code expired">Create a new code to continue.</Notice></div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => setStep(2)}><Icon.back />Back</button>
            <button className="btn" onClick={retry}><Icon.retry />New code</button>
            <button className="btn btn-ghost" onClick={cancel}>Cancel setup</button>
          </div>
        </>}

        {step === 4 && <>
          {online ? <>
            <div style={{ marginBottom: 16 }}><SuccessState title="Your controller is connected"
              text={`${hardware?.name || 'Controller'} reported that it is online. You can now add switches, lights and sensors to it.`} /></div>
            <div className="wizard-illustration" style={{ marginBottom: 16 }}>
              <DeviceIllustration state="done" />
            </div>
            <Card title="Detected device information" sub="Reported by the controller, not entered by hand" icon="card">
              <div className="kv">
                <dt>Name</dt><dd>{hardware?.name || '—'}</dd>
                <dt>Status</dt><dd><StatusBadge status={hardware?.status || 'unknown'} /></dd>
                <dt>Device ID</dt><dd className="mono">{hardware?.device_id || '—'}</dd>
                <dt>Chip</dt><dd>{hardware?.chip_model || hardware?.chip_family || 'Not reported by this firmware'}</dd>
                <dt>Chip revision</dt><dd>{hardware?.chip_revision || 'Not reported'}</dd>
                <dt>Wi-Fi address</dt><dd className="mono">{hardware?.mac_address || 'Not reported'}</dd>
                <dt>Firmware version</dt><dd className="mono">{hardware?.firmware_version || 'Not reported'}</dd>
                <dt>Build</dt><dd className="mono tiny">{hardware?.fw_build || 'Not reported'}</dd>
                <dt>SDK</dt><dd>{hardware?.sdk_version || 'Not reported'}</dd>
                <dt>Board revision</dt><dd>{hardware?.hardware_revision || 'Not reported'}</dd>
                <dt>Last seen</dt><dd>{hardware?.last_seen_at ? timeFull(hardware.last_seen_at) : 'Just now'}</dd>
              </div>
              {!hardware?.chip_model && <div style={{ marginTop: 12 }}><Notice tone="info">This controller did not send hardware details. Fields above show “Not reported” until firmware that supports hardware reporting connects.</Notice></div>}
            </Card>
          </> : <ErrorState title="Setup is not finished"
            text="A connection has not been confirmed. Go back and check the controller, then wait for a real status report."
            onRetry={() => setStep(3)} />}
          <div className="divider" />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link className="btn btn-primary" to="/controllers"><Icon.cpu />View controllers <Icon.next /></Link>
            <button className="btn" onClick={() => { setStep(0); setToken(''); setProgress(null); setHardware(null); }}><Icon.plus />Add another</button>
          </div>
        </>}
      </Card>

      <div style={{ display: 'grid', gap: 16 }}>
        <Card title="What happens during setup" icon="network">
          <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 2, fontSize: 13 }}>
            <li>The controller joins your Wi-Fi.</li>
            <li>It uses the one-time code to register with your home.</li>
            <li>It receives its own private connection identity.</li>
            <li>It reports its real status back to this console.</li>
          </ol>
          <div className="divider" />
          <div className="tiny">Everything stays separate from other homes. The controller keeps its own credentials and only talks to its own space.</div>
        </Card>
        <Card title="Your controllers" icon="cpu" actions={<button className="btn btn-ghost btn-icon btn-sm"
          onClick={boards.refresh} aria-label="Refresh controllers"><Icon.refresh /></button>}>
          {boards.loading ? <Loading rows={2} shape="row" />
            : !boards.data?.length ? <EmptyState icon="cpu" title="No controllers yet"
              text="A controller appears here after it reports back as connected." />
            : boards.data.map((b: any) => <div className="list-item" key={b.id} style={{ padding: '10px 0' }}>
              <span className="icon-box"><Icon.cpu /></span>
              <span className="grow"><span className="title">{b.name}</span>
                <span className="meta mono">{b.device_id}</span></span>
              <StatusBadge status={b.status} />
            </div>)}
        </Card>
        <Card title="Need to start over?" icon="help">
          <p className="tiny" style={{ lineHeight: 1.8 }}>You can cancel at any time. Cancelling makes the current pairing code unusable. Power the controller off and back on to begin again with a new code.</p>
          <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={cancel}><Icon.close />Cancel setup</button>
        </Card>
      </div>
    </div>
  </>;
}
