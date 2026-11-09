/** Customer Device Setup Wizard — six-digit pairing, real connection evidence only. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useLiveData } from '../api';
import { useAuth } from '../state';
import {
  Badge, Card, CopyButton, DeviceIllustration, EmptyState, ErrorState, Field,
  Icon, Loading, Notice, PageHead, Progress, StatusBadge, SuccessState, timeFull,
} from '../components';

/** Server-side stage of one pairing session. Success is only 'completed'. */
type PairingStage = 'pending' | 'accepted' | 'reporting' | 'completed' | 'expired' | 'failed' | 'cancelled';

type PairingProgress = {
  id: string; stage: PairingStage; failure_reason: string | null; registered_at: string | null;
  claimed: boolean; expired: boolean; revoked: boolean; locked: boolean;
  failed_attempts: number; remaining_attempts: number; expires_at: string; seconds_left: number;
  /** Why pairing is stuck, from the platform's own checks (bridge, broker, controller). */
  diagnosis?: { code: string; title: string; text: string } | null;
  onboarding_seconds_left: number | null;
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

/** What the person can do about each failure. Shown instead of a generic message. */
const FAILURE_TEXT: Record<string, { title: string; text: string }> = {
  onboarding_timeout: {
    title: 'The controller did not finish connecting',
    text: 'The code was accepted, but the controller did not confirm its registration within 10 minutes. Check that it is powered, near your router and that its Wi-Fi details are right, then start again.',
  },
};

/** Which stage each line of the live status is at, in order. */
const STAGE_ORDER: PairingStage[] = ['pending', 'accepted', 'reporting', 'completed'];

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
  // Success means the backend confirmed the registration (stage 'completed').
  // A reporting or online flag alone is not enough.
  const online = progress?.stage === 'completed';
  const stage: PairingStage | null = progress?.stage ?? null;
  const failed = stage === 'failed';
  const accepted = !!progress?.claimed;

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
        if (r.stage === 'completed') {
          done = true;
          boards.refresh();
          setStep(3);
          return;
        }
        // An unaccepted code that ran out, or a cancelled code, will not change again.
        // A failed session keeps polling: a late but valid registration still completes it.
        if (r.stage === 'expired' || r.stage === 'cancelled') done = true;
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

  // 'expired' is the server's verdict for a code nobody used. After acceptance the code's
  // countdown is meaningless, so it is never treated as expiry.
  const expired = stage === 'expired';
  const illustration = online ? 'done' : failed ? 'scanning' : step === 2 ? (accepted ? 'cloud' : 'scanning') : step === 1 ? 'ready' : 'wifi';
  const seenByBackend = !!claimedBoard?.last_seen_at;

  // One line per real stage. Each line only changes when the server says so.
  const stages = useMemo(() => {
    const idx = stage ? STAGE_ORDER.indexOf(stage) : -1;
    const at = (s: PairingStage) => idx >= STAGE_ORDER.indexOf(s);
    const lineFor = (done: boolean, active: boolean) => done ? 'done' as const : active ? 'active' as const : 'waiting' as const;
    return [
      { key: 'code', title: 'Pairing code created',
        state: session ? 'done' as const : 'active' as const,
        detail: session ? `Valid until ${timeFull(progress?.expires_at || '')}` : 'Not created yet' },
      { key: 'accepted', title: 'Code accepted, controller credentials issued',
        state: accepted ? 'done' as const : progress?.failed_attempts ? 'failed' as const : lineFor(false, step === 2),
        detail: accepted ? 'The code was used once and the controller received its own identity for this home'
          : progress?.failed_attempts ? `${progress.failed_attempts} rejected attempt(s), ${progress.remaining_attempts} left on this code`
            : 'Waiting for the controller to submit the code' },
      { key: 'connecting', title: 'Connecting to your home over MQTT',
        state: seenByBackend || at('reporting') ? 'done' as const : lineFor(false, accepted && !failed),
        detail: seenByBackend ? 'The controller connected to the platform' : 'The controller is joining Wi-Fi and the platform' },
      { key: 'reporting', title: 'Waiting for the controller report',
        state: at('completed') ? 'done' as const : failed ? 'failed' as const : lineFor(false, at('reporting') && !online),
        detail: at('completed') ? 'The controller reported its identity to the platform'
          : failed ? 'No valid report arrived in time'
            : 'Waiting for the controller to say who it is and which home it belongs to' },
      { key: 'confirm', title: 'Confirming registration',
        state: online ? 'done' as const : failed ? 'failed' as const : 'waiting' as const,
        detail: online ? 'The platform saved the controller and acknowledged it'
          : 'The platform saves the controller only after a valid report' },
      { key: 'added', title: 'Added to your home',
        state: online ? 'done' as const : 'waiting' as const,
        detail: online ? 'The controller is part of your home' : 'Shown here once registration is confirmed' },
    ];
  }, [session, progress, claimedBoard, accepted, seenByBackend, stage, step, online, failed]);

  const percent = online ? 100 : failed ? 100 : accepted ? (seenByBackend ? 70 : 45) : session ? 15 : 0;
  const statusLabel = online ? 'Added'
    : failed ? 'Needs attention'
      : expired ? 'Code expired'
        : stage === 'cancelled' ? 'Cancelled'
          : stage === 'reporting' ? 'Waiting for report'
            : accepted ? 'Connecting to MQTT'
              : 'Waiting for the controller';
  const failureInfo = FAILURE_TEXT[progress?.failure_reason || ''] || (failed ? {
    title: 'The controller did not finish connecting', text: 'Start again with a new code.',
  } : null);

  return <>
    <PageHead title="Add a controller" eyebrow="Device setup"
      desc="Choose the board, join the controller to your Wi-Fi and pair it with one six-digit code. Nothing is called connected until the controller says so."
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
            Pick the board and name it, then pair it. A new controller needs its firmware first: that is installed from the Firmware page, not here.
          </p>
          <div className="wizard-illustration" style={{ marginBottom: 20 }}><DeviceIllustration state="ready" /></div>
          <Notice tone="info" title="Firmware is not installed here">
            If the controller has no firmware yet, install it from the Firmware page first, then come back.{' '}
            <Link className="btn btn-sm" to="/firmware" style={{ marginLeft: 8 }}><Icon.usb />Open Firmware</Link>
          </Notice>
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
            <div className="tiny" style={{ marginTop: 6 }}>{accepted
              ? (progress?.onboarding_seconds_left != null ? `Code used. Waiting up to ${countdown(progress.onboarding_seconds_left)} for the controller to report` : 'Code used')
              : expired ? 'Expired — create a new code'
                : seconds > 0 ? `Expires in ${countdown(seconds)}` : 'Expired — create a new code'}</div>
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
                {statusLabel}</span>
            </div>
            <Progress value={percent}
              tone={failed || expired ? 'danger' : online ? 'on' : 'warn'} />
            {stages.map(({ key, ...stage }) => <StageLine key={key} {...stage as any} />)}
          </div>
          {!online && !expired && !failed && progress?.diagnosis && <div style={{ marginBottom: 12 }}><Notice tone="warn" title={progress.diagnosis.title}>{progress.diagnosis.text}</Notice></div>}
          {pollError && <div className="notice danger" style={{ marginBottom: 12 }}><Icon.fail />{pollError}</div>}
          {expired && <div style={{ marginBottom: 12 }}><ErrorState title="The pairing code expired"
            text="Nothing was paired. Create a new code and enter it on the controller's setup page; your Wi-Fi details stay saved on the controller."
            onRetry={restart} /></div>}
          {failed && failureInfo && <div style={{ marginBottom: 12 }}><ErrorState title={failureInfo.title}
            text={`${failureInfo.text} This page keeps checking, so a late connection is still picked up.`}
            onRetry={restart} /></div>}
          {progress?.locked && !accepted && <div style={{ marginBottom: 12 }}><Notice tone="danger" title="Too many wrong codes">
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
          </> : <ErrorState title={failureInfo?.title || 'Registration is not confirmed yet'}
            text={failureInfo?.text || 'The controller has not finished registering. Keep this page open, or check that it is powered and near your router.'}
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
