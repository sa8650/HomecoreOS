/** Customer Device Setup Wizard — six-digit pairing, real connection evidence only. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useLiveData } from '../api';
import { useAuth } from '../state';
import {
  Badge, Card, CopyButton, DeviceIllustration, EmptyState, ErrorState, Field,
  Icon, Loading, Notice, PageHead, Progress, StatusBadge, SuccessState, timeFull,
} from '../components';

type PairingProgress = {
  id: string; claimed: boolean; expired: boolean; revoked: boolean; locked: boolean;
  failed_attempts: number; remaining_attempts: number; expires_at: string; seconds_left: number;
  board: null | {
    id: string; name: string; device_id: string; status: string; online: boolean;
    firmware_version?: string; catalog_board_id?: string; chip_model?: string; chip_family?: string;
    mac_address?: string; sdk_version?: string; fw_build?: string; hardware_revision?: string;
    last_seen_at?: string; rssi?: number; config_version?: number; config_sync_status?: string;
  };
};

const STEPS = ['Get ready', 'Pairing code', 'Join the controller', 'Connected'];

function countdown(seconds: number) {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

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
  const [session, setSession] = useState<{ id: string; code: string } | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [progress, setProgress] = useState<PairingProgress | null>(null);
  const [pollError, setPollError] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const selected = (catalog.data || []).find((b: any) => b.id === boardId);
  const catalogRows = (catalog.data || []).filter((b: any) => b.attributes?.pin_status === 'verified'
    && `${b.model} ${b.manufacturer} ${b.chip_family}`.toLowerCase().includes(boardSearch.toLowerCase()));
  const canManage = can('devices.manage');
  const claimedBoard = progress?.board;
  const online = !!claimedBoard?.online && claimedBoard?.status === 'online';

  const issue = async () => {
    setBusy(true); setPollError(''); setProgress(null);
    try {
      const r: any = await api.post('/api/pairing/code', {
        catalog_board_id: boardId || null,
        board_name: name.trim() || selected?.model || 'My controller',
      });
      if (!/^[0-9]{6}$/.test(String(r?.code || ''))) throw new Error('The server did not return a six-digit code. Please try again.');
      setSession({ id: String(r.session_id), code: String(r.code) });
      setSeconds(Number(r.seconds_left) || 300);
      setStep(2);
    } catch (e: any) { toast(e.message || 'Could not create a pairing code', 'error'); }
    finally { setBusy(false); }
  };

  // The countdown is the server's own expiry, ticking locally between polls.
  useEffect(() => {
    if (!session) return;
    const t = window.setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(t);
  }, [session]);

  // Real progress only: the controller consumes the code and then reports its
  // own status. Nothing here advances because time passed.
  useEffect(() => {
    if (step !== 2 || !session) return;
    let alive = true;
    let done = false;
    const poll = async () => {
      try {
        const r = await api.get<PairingProgress>(`/api/pairing/progress?session=${encodeURIComponent(session.id)}`);
        if (!alive) return;
        setProgress(r); setSeconds(r.seconds_left); setPollError('');
        if (r.claimed && r.board?.online) {
          done = true;
          boards.refresh();
          setStep(3);
          return;
        }
      } catch (e: any) {
        if (alive) setPollError(e.message || 'Could not check the pairing state.');
      }
      if (alive && !done) timer.current = window.setTimeout(poll, 2500);
    };
    void poll();
    return () => { alive = false; if (timer.current) window.clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, session?.id]);

  const cancel = async () => {
    if (session) await api.post('/api/pairing/cancel', { session_id: session.id }).catch(() => {});
    setSession(null); setProgress(null); setSeconds(0); setPollError(''); setStep(0);
  };
  const restart = async () => {
    if (session) await api.post('/api/pairing/cancel', { session_id: session.id }).catch(() => {});
    setSession(null); setProgress(null); setSeconds(0); setPollError('');
    setStep(1);
    await issue();
  };

  const expired = !!progress?.expired || (!!session && seconds <= 0);
  const illustration = online ? 'done' : step === 2 ? (progress?.claimed ? 'cloud' : 'scanning') : step === 1 ? 'ready' : 'wifi';

  const stages = useMemo(() => [
    { key: 'code', title: 'Pairing code created',
      state: session ? 'done' : 'active' as const,
      detail: session ? `Valid until ${timeFull(progress?.expires_at || '')}` : 'Not created yet' },
    { key: 'wifi', title: 'Controller joined your Wi-Fi',
      state: claimedBoard ? 'done' : step === 2 ? 'active' : 'waiting' as const,
      detail: claimedBoard ? 'The controller reached HomecoreOS over the internet' : 'Happens on the controller after you save the network details' },
    { key: 'redeem', title: 'Pairing code accepted',
      state: progress?.claimed ? 'done' : progress?.failed_attempts ? 'failed' : step === 2 ? 'active' : 'waiting' as const,
      detail: progress?.claimed ? 'The code was used once and is now invalid'
        : progress?.failed_attempts ? `${progress.failed_attempts} rejected attempt(s), ${progress.remaining_attempts} left on this code`
          : 'Waiting for the controller to submit the code' },
    { key: 'identity', title: 'Private credentials issued',
      state: progress?.claimed ? 'done' : 'waiting' as const,
      detail: progress?.claimed ? 'The controller has its own MQTT identity for this home' : 'Issued by the server when the code is redeemed' },
    { key: 'online', title: 'Reporting to your home',
      state: online ? 'done' : expired ? 'failed' : step === 2 ? 'active' : 'waiting' as const,
      detail: online ? 'The controller confirmed it is online' : expired ? 'The pairing code expired before a connection was confirmed'
        : 'Waiting for a real status report from the controller' },
  ], [session, claimedBoard, progress, online, expired, step]);

  return <>
    <PageHead title="Add a controller" eyebrow="Device setup"
      desc="Install the firmware over USB, choose your Wi-Fi on the controller and pair it with one six-digit code. Nothing is called connected until the controller says so."
      actions={<Link className="btn" to="/firmware"><Icon.download />Firmware & updates<Icon.next /></Link>} />

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
            A new controller needs its firmware written once over USB. If yours is already running HomecoreOS, skip to the pairing code.
          </p>
          <div className="wizard-illustration" style={{ marginBottom: 20 }}><DeviceIllustration state="ready" /></div>
          <Field label="Write the firmware (first time only)" hint="Chrome or Edge on a computer with a USB data cable.">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Link className="btn" to="/firmware"><Icon.usb />Open the USB installer</Link>
              <Link className="btn btn-ghost" to="/firmware"><Icon.info />What happens during the install</Link>
            </div>
          </Field>
          <div className="divider" />
          <Field label="Which board is it?" hint="Boards with a verified pin map can be added.">
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
              <dt>Flash / PSRAM</dt><dd>{selected.attributes?.flash_mb || '—'} MB / {selected.attributes?.psram_mb || '0'} MB</dd>
              <dt>Documented pins</dt><dd>{selected.pins?.length || 0}</dd></div>
            {selected.pinout_url && <a className="btn btn-sm" style={{ marginTop: 12 }} href={selected.pinout_url}
              target="_blank" rel="noreferrer"><Icon.book />See the official pinout</a>}
          </div>}
          <button className="btn btn-primary btn-block" disabled={!boardId || !canManage} onClick={() => setStep(1)}>
            Continue <Icon.next /></button>
          {!canManage && <div style={{ marginTop: 12 }}><Notice tone="warn">Your account cannot add controllers. Ask the home owner for access.</Notice></div>}
        </>}

        {step === 1 && <>
          <h2 className="text-h6">2. Create a pairing code</h2>
          <p className="muted" style={{ margin: '8px 0 20px', fontSize: 13 }}>
            The code has six digits, is generated by the server, works once and expires after five minutes.
          </p>
          <div className="wizard-illustration" style={{ marginBottom: 20 }}><DeviceIllustration state="ready" /></div>
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div className="kv"><dt>Controller</dt><dd>{name.trim() || selected?.model || 'My controller'}</dd>
              <dt>Board</dt><dd>{selected?.model || 'Not selected'}</dd>
              <dt>Code lifetime</dt><dd>5 minutes, single use</dd>
              <dt>Bound to</dt><dd>this account, this home and this browser session</dd></div>
          </div>
          <Notice tone="info" title="Keep this page open">You will type the code into the controller's own setup page together with your Wi-Fi details. Nothing is sent from this website to the controller.</Notice>
          <div className="divider" />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => setStep(0)}><Icon.back />Back</button>
            <button className="btn btn-primary" onClick={issue} disabled={busy || !canManage}>
              {busy ? <><Icon.loader className="spinner" />Creating…</> : <>Create pairing code <Icon.next /></>}</button>
            <button className="btn btn-ghost" onClick={cancel}>Cancel setup</button>
          </div>
        </>}

        {step === 2 && session && <>
          <h2 className="text-h6">3. Join the controller to your Wi-Fi</h2>
          <p className="muted" style={{ margin: '8px 0 16px', fontSize: 13 }}>
            The controller makes its own temporary network. Open it, enter your Wi-Fi details and the code below, then come back to this page.
          </p>
          <div className="wizard-illustration" style={{ marginBottom: 16 }}><DeviceIllustration state={illustration as any} /></div>
          <div className="card card-pad" style={{ marginBottom: 16, textAlign: 'center' }}>
            <div className="tiny" style={{ marginBottom: 4 }}>Your one-time pairing code</div>
            <div className="mono" style={{ fontSize: 38, letterSpacing: 9, fontWeight: 700 }}>{session.code}</div>
            <div className="tiny" style={{ marginTop: 6 }}>{seconds > 0 ? `Expires in ${countdown(seconds)}` : 'Expired — create a new code'}</div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              <CopyButton value={session.code} label="Copy code" />
              <button className="btn btn-sm" onClick={restart} disabled={busy}><Icon.refresh />New code</button>
            </div>
          </div>
          <Field label="On your phone or laptop" hint="The Wi-Fi password never leaves the controller.">
            <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 2.1, fontSize: 13 }}>
              <li>Open Wi-Fi settings and join <b>HomecoreOS-Setup-…</b>.</li>
              <li>If no page opens, browse to <b>192.168.4.1</b>.</li>
              <li>Enter your home Wi-Fi name, its password and the six-digit code.</li>
              <li>Press <b>Save and connect</b>, wait for the controller to restart, then watch this page.</li>
            </ol>
          </Field>
          <div className="card card-pad" style={{ margin: '16px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ fontSize: 13 }}>Live status</strong>
              <span className="status-live"><span className="dot pulse" style={{ color: 'var(--accent)' }} />
                {online ? 'Connected' : expired ? 'Stopped' : 'Checking every few seconds'}</span>
            </div>
            <Progress value={online ? 100 : claimedBoard ? 80 : 15}
              tone={expired ? 'danger' : online ? 'on' : 'warn'} />
            {stages.map(({ key, ...stage }) => <StageLine key={key} {...stage as any} />)}
          </div>
          {pollError && <div className="notice danger" style={{ marginBottom: 12 }}><Icon.fail />{pollError}</div>}
          {expired && !online && <div style={{ marginBottom: 12 }}><ErrorState title="The pairing code expired"
            text="Nothing was paired. Ask for a new code and enter it on the controller's setup page; your Wi-Fi details stay saved on the controller."
            onRetry={restart} /></div>}
          {progress?.locked && !online && <div style={{ marginBottom: 12 }}><Notice tone="danger" title="Too many wrong codes">
            This code was locked after several incorrect attempts. Create a new code and try again.</Notice></div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => setStep(1)}><Icon.back />Back</button>
            <button className="btn btn-ghost" onClick={cancel}>Cancel setup</button>
          </div>
        </>}

        {step === 3 && <>
          {online ? <>
            <div style={{ marginBottom: 16 }}><SuccessState title="Your controller is connected"
              text={`${claimedBoard?.name || 'Controller'} reported that it is online. You can add switches, lights and sensors to it now.`} /></div>
            <div className="wizard-illustration" style={{ marginBottom: 16 }}><DeviceIllustration state="done" /></div>
            <Card title="Reported by the controller" sub="Not typed in by hand" icon="card">
              <div className="kv">
                <dt>Name</dt><dd>{claimedBoard?.name || '—'}</dd>
                <dt>Status</dt><dd><StatusBadge status={claimedBoard?.status || 'unknown'} /></dd>
                <dt>Device ID</dt><dd className="mono">{claimedBoard?.device_id || '—'}</dd>
                <dt>Chip</dt><dd>{claimedBoard?.chip_model || claimedBoard?.chip_family || 'Not reported'}</dd>
                <dt>Wi-Fi address</dt><dd className="mono">{claimedBoard?.mac_address || 'Not reported'}</dd>
                <dt>Firmware</dt><dd className="mono">{claimedBoard?.firmware_version || 'Not reported'}</dd>
                <dt>Build</dt><dd className="mono tiny">{claimedBoard?.fw_build || 'Not reported'}</dd>
                <dt>Signal</dt><dd>{claimedBoard?.rssi ? `${claimedBoard.rssi} dBm` : 'Not reported'}</dd>
                <dt>Configuration</dt><dd>v{claimedBoard?.config_version ?? 0} · <StatusBadge status={claimedBoard?.config_sync_status || 'unknown'} /></dd>
                <dt>Last seen</dt><dd>{claimedBoard?.last_seen_at ? timeFull(claimedBoard.last_seen_at) : 'Just now'}</dd>
              </div>
            </Card>
          </> : <ErrorState title="A connection has not been confirmed yet"
            text="The code was used, but the controller has not reported that it is online. Check that it is powered and near your router, then wait a moment."
            onRetry={() => setStep(2)} />}
          <div className="divider" />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link className="btn btn-primary" to="/controllers"><Icon.cpu />View controllers <Icon.next /></Link>
            <Link className="btn" to="/firmware"><Icon.download />Firmware & updates</Link>
            <button className="btn btn-ghost" onClick={() => { setSession(null); setProgress(null); setStep(0); setName(''); }}><Icon.plus />Add another</button>
          </div>
        </>}
      </Card>

      <div style={{ display: 'grid', gap: 16 }}>
        <Card title="What happens during setup" icon="network">
          <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 2, fontSize: 13 }}>
            <li>You create a six-digit code for this home.</li>
            <li>The controller joins your Wi-Fi.</li>
            <li>It sends the code once and receives its own private credentials.</li>
            <li>It reports its real status back to this console.</li>
          </ol>
          <div className="divider" />
          <div className="tiny">The code is stored only as a hash, is bound to your account and this session, and cannot be used again. It is never the controller's permanent password.</div>
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
          <p className="tiny" style={{ lineHeight: 1.8 }}>
            Cancelling makes the current code unusable immediately. To pair again, create a new code; the controller keeps the Wi-Fi details it already has. A factory reset reopens the controller's setup network.
          </p>
          <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={cancel}><Icon.close />Cancel setup</button>
        </Card>
      </div>
    </div>
  </>;
}
