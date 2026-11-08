/**
 * Customer Console — firmware for a home's controllers.
 *
 * Two ways to install, both built from the same published release:
 *   A. over USB in this browser (recommended first install or recovery), and
 *   B. over the air from a paired controller that is already online.
 *
 * Progress shown here is only what the browser transfer or the controller itself
 * reports. Nothing advances on a timer.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useLiveData } from '../api';
import { useAuth } from '../state';
import {
  Badge, Card, CopyButton, DeviceIllustration, EmptyState, ErrorState, Field, Icon, Loading,
  Modal, Notice, PageHead, Progress, StatusBadge, fmtBytes, timeAgo, timeFull,
} from '../components';
import type { ControllerEntry } from '../firmware';
import {
  USB_STEPS, espWebToolsUrl, fetchPackage, flashOverSerial, imageChipId, installModeLabel,
  serialSupported, verifyImage,
} from '../installer';
import type { InstallProgress } from '../installer';

type Catalog = {
  controllers: ControllerEntry[];
  install: Array<{
    id: string; version: string; name: string; notes: string | null; channel: string;
    artifact_kind: string; chip_family: string; chip_id: number | null;
    size_bytes: number; sha256: string; signature_present: boolean; signature_alg: string | null;
    flash_offset: number; published_at: string; url: string;
  }>;
  usb_installer: { flash_size_mb: number; requires_https: boolean; requires_chrome_or_edge: boolean; note: string };
};

type PairingSession = {
  id: string; claimed: boolean; expired: boolean; revoked: boolean; locked: boolean;
  failed_attempts: number; remaining_attempts: number; expires_at: string; seconds_left: number;
  board: null | { id: string; name: string; status: string; online: boolean; firmware_version: string | null };
};

function countdown(seconds: number) {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Option A — USB installation in the browser
// ---------------------------------------------------------------------------
function UsbInstallModal({ pkg, onClose }: { pkg: Catalog['install'][number]; onClose: () => void }) {
  const toast = useAuth().toast;
  const [phase, setPhase] = useState<'intro' | 'ready' | 'downloading' | 'flashing' | 'done' | 'failed'>('intro');
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [error, setError] = useState('');
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [detected, setDetected] = useState('');
  const log = (line: string, level: 'info' | 'warn' | 'error' = 'info') => {
    setLogs((l) => [...l.slice(-300), `${level === 'error' ? '✗' : level === 'warn' ? '!' : '·'} ${line}`]);
  };
  const supported = serialSupported();
  const mode = installModeLabel(pkg.artifact_kind);

  const download = async () => {
    setError(''); setPhase('downloading'); setProgress({ written: 0, total: pkg.size_bytes, percent: 0, phase: 'Downloading the release' });
    try {
      const data = await fetchPackage(pkg.url, (loaded, total) =>
        setProgress({ written: loaded, total, percent: total ? Math.round((loaded / total) * 100) : 0, phase: 'Downloading the release' }));
      const check = await verifyImage(data, pkg.sha256);
      if (!check.ok) throw new Error(check.detail);
      log(check.detail);
      const chip = imageChipId(data);
      log(`Image chip id ${chip ?? 'unknown'} · ${fmtBytes(data.byteLength)}`);
      if (chip !== null && pkg.chip_id !== null && chip !== pkg.chip_id) {
        throw new Error('The downloaded image is for a different chip than this release. Nothing was flashed.');
      }
      setBytes(data);
      setPhase('ready');
    } catch (e: any) {
      setError(e.message || 'The download failed.'); setPhase('failed'); log(e.message, 'error');
    }
  };

  const flash = async () => {
    if (!bytes) return;
    setError(''); setPhase('flashing');
    try {
      const result = await flashOverSerial({
        bytes, offset: pkg.flash_offset, expectedChipId: pkg.chip_id,
        expectedSha256: pkg.sha256, onProgress: setProgress, log,
      });
      setDetected(result.detected);
      setPhase('done');
      toast('Firmware written. Continue with Wi-Fi setup.');
    } catch (e: any) {
      setError(e.message || 'The controller did not accept the firmware.'); setPhase('failed'); log(e.message, 'error');
    }
  };

  const webTools = useMemo(() => ({ script: espWebToolsUrl() }), []);

  return <Modal title={`Install ${pkg.version} over USB`} wide onClose={onClose}
    description={`${mode.label} · ${fmtBytes(pkg.size_bytes)} · version ${pkg.version}`}
    footer={phase === 'done'
      ? <><button className="btn" onClick={onClose}>Close</button>
        <Link className="btn btn-primary" to="/setup" onClick={onClose}>Set up Wi-Fi and pairing<Icon.next /></Link></>
      : <><button className="btn" onClick={onClose}>{phase === 'flashing' ? 'Hide' : 'Cancel'}</button>
        <button className="btn btn-primary" onClick={flash} disabled={!bytes || phase === 'flashing' || !supported}
          aria-busy={phase === 'flashing' || undefined}>
          {phase === 'flashing' ? 'Writing…' : 'Connect and install'}</button></>}>
    {!supported && <div style={{ marginBottom: 16 }}><Notice tone="warn" title="This browser cannot open a serial port">
      Web Serial works in Chrome, Edge and other Chromium browsers on a desktop or laptop, over an https address. You can still download the file and use the official ESP Web Tools installer, or update a paired controller over the air.
    </Notice></div>}
    {error && <div className="notice danger" style={{ marginBottom: 16 }}><Icon.fail />{error}</div>}

    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <div>
        <div className="wizard-illustration" style={{ marginBottom: 14 }}>
          <DeviceIllustration state={phase === 'done' ? 'done' : phase === 'flashing' ? 'scanning' : phase === 'failed' ? 'error' : 'ready'} />
        </div>
        <div className="kv">
          <dt>Release</dt><dd>{pkg.version} · {pkg.channel}</dd>
          <dt>Type</dt><dd>{mode.label}</dd>
          <dt>Written at</dt><dd className="mono">{`0x${pkg.flash_offset.toString(16)}`}</dd>
          <dt>Chip</dt><dd>{pkg.chip_family}</dd>
          <dt>Size</dt><dd>{fmtBytes(pkg.size_bytes)}</dd>
          <dt>Checksum</dt><dd className="mono tiny" style={{ wordBreak: 'break-all' }}>{pkg.sha256}</dd>
          <dt>Signature</dt><dd>{pkg.signature_present ? <Badge tone="on" icon="shieldOk">{pkg.signature_alg}</Badge> : <Badge tone="warn">Unsigned build</Badge>}</dd>
        </div>
        <div className="tiny" style={{ marginTop: 10 }}>{mode.detail}</div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={download} disabled={phase === 'downloading' || phase === 'flashing'}>
            <Icon.download />{bytes ? 'Download again' : 'Download and verify'}</button>
          <a className="btn btn-sm" href={`/api/firmware/download/${pkg.id}`}><Icon.file />Save the file</a>
        </div>
      </div>
      <div>
        <h4 style={{ fontSize: 13, marginBottom: 8 }}>What you will do</h4>
        <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9, fontSize: 12.5 }}>
          {USB_STEPS.map((s) => <li key={s.title}><b>{s.title}</b><div className="tiny">{s.detail}</div></li>)}
        </ol>
        {progress && <div style={{ marginTop: 14 }}>
          <div className="tiny" style={{ marginBottom: 6 }}>{progress.phase}{progress.total ? ` · ${fmtBytes(progress.written)} of ${fmtBytes(progress.total)}` : ''}</div>
          <Progress value={progress.percent} tone={phase === 'failed' ? 'danger' : phase === 'done' ? 'on' : 'warn'} />
        </div>}
        {phase === 'done' && <div className="notice success" style={{ marginTop: 12 }}><Icon.ok />
          Written and verified. The controller restarted{detected ? ` (${detected})` : ''}. It now creates its own setup network so you can choose your Wi-Fi.
        </div>}
        {phase === 'failed' && <div className="notice danger" style={{ marginTop: 12 }}><Icon.fail />
          Nothing was confirmed. Put the controller back into download mode (hold BOOT, tap RESET, release BOOT) and try again. The previous firmware is still in place unless the erase step had finished.
        </div>}
        <details style={{ marginTop: 14 }} open={showLogs} onToggle={(e) => setShowLogs((e.target as HTMLDetailsElement).open)}>
          <summary className="tiny" style={{ cursor: 'pointer' }}>Technical log</summary>
          <div className="code" style={{ marginTop: 8, maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {logs.length ? logs.join('\n') : 'Nothing yet.'}
          </div>
        </details>
      </div>
    </div>

    <div className="divider" />
    <h4 style={{ fontSize: 13, marginBottom: 6 }}>Prefer the official installer?</h4>
    <p className="tiny">ESP Web Tools is maintained by Espressif. Open it in Chrome or Edge, choose the same file, and follow the same steps.</p>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
      <a className="btn btn-sm" href="https://esphome.github.io/esp-web-tools/" target="_blank" rel="noreferrer">
        <Icon.external />Open ESP Web Tools</a>
      <CopyButton value={webTools.script} label="Copy installer script URL" />
    </div>
  </Modal>;
}

// ---------------------------------------------------------------------------
// Option B — wireless update on one controller
// ---------------------------------------------------------------------------
function OtaModal({ controller, onClose, onDone }: { controller: ControllerEntry; onClose: () => void; onDone: () => void }) {
  const toast = useAuth().toast;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [started, setStarted] = useState(false);
  const latest = controller.latest;
  const start = async () => {
    setBusy(true); setError('');
    try {
      await api.post('/api/firmware/update', { board_id: controller.id });
      setStarted(true); onDone();
      toast('Update queued. The controller reports its own progress.');
    } catch (e: any) { setError(e.message || 'The update could not be queued.'); }
    finally { setBusy(false); }
  };
  const rollback = async () => {
    setBusy(true); setError('');
    try {
      await api.post('/api/firmware/rollback', { board_id: controller.id });
      setStarted(true); onDone();
      toast('Rollback queued to the previous stable build.');
    } catch (e: any) { setError(e.message || 'The rollback could not be queued.'); }
    finally { setBusy(false); }
  };
  return <Modal title={`Wireless update · ${controller.name}`} onClose={onClose}
    footer={started ? <button className="btn btn-primary" onClick={onClose}>Close</button> : <>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={start} disabled={busy || !latest?.update_available}>
        {busy ? <><Icon.loader className="spinner" />Queueing…</> : <><Icon.download />Install {latest?.version}</>}</button>
    </>}>
    {error && <div className="notice danger" style={{ marginBottom: 16 }}><Icon.fail />{error}</div>}
    <div className="kv">
      <dt>Installed now</dt><dd className="mono">{controller.installed_version || 'Not reported'}</dd>
      <dt>Available</dt><dd className="mono">{latest?.version || 'None'}</dd>
      <dt>Size</dt><dd>{latest ? fmtBytes(latest.size_bytes) : '—'}</dd>
      <dt>Checksum</dt><dd className="mono tiny" style={{ wordBreak: 'break-all' }}>{latest?.sha256 || '—'}</dd>
      <dt>Connection</dt><dd><StatusBadge status={controller.status} /> · seen {timeAgo(controller.last_seen_at)}</dd>
      <dt>Previous success</dt><dd>{controller.last_success_at ? timeFull(controller.last_success_at) : 'None recorded'}</dd>
    </div>
    {latest?.notes && <div style={{ marginTop: 12 }}><h4 style={{ fontSize: 13, marginBottom: 4 }}>What changed in {latest.version}</h4>
      <p className="tiny" style={{ lineHeight: 1.7 }}>{latest.notes}</p></div>}
    <div style={{ marginTop: 14 }}><Notice tone="info" title="How the update runs">
      The controller downloads the image over HTTPS, checks the SHA-256{latest?.signature_present ? ' and the detached signature' : ''}, writes it to the inactive slot and reboots into it. If it cannot connect after the update it returns to the version running now.
    </Notice></div>
    {controller.status !== 'online' && <div style={{ marginTop: 12 }}><Notice tone="warn" title="The controller is not online">
      An update waits until the controller connects. Power and Wi-Fi must be available for the download to finish.
    </Notice></div>}
    {controller.last_failure && <div style={{ marginTop: 12 }}><Notice tone="danger" title="Last failure">
      {controller.last_failure.error || 'The controller reported a failed attempt.'} ({timeAgo(controller.last_failure.finished_at)})
    </Notice></div>}
    {controller.rollback?.available && <div className="divider" />}
    {controller.rollback?.available && <div>
      <h4 style={{ fontSize: 13, marginBottom: 4 }}>Go back to {controller.rollback.version}</h4>
      <p className="tiny" style={{ marginBottom: 8 }}>Only an earlier signed build that already ran on this controller can be restored.</p>
      <button className="btn btn-sm" onClick={rollback} disabled={busy}><Icon.retry />Roll back</button>
    </div>}
  </Modal>;
}

// ---------------------------------------------------------------------------
// Pairing — six-digit code with a live countdown
// ---------------------------------------------------------------------------
function PairingPanel() {
  const toast = useAuth().toast;
  const [session, setSession] = useState<{ session_id: string; code: string; seconds_left: number } | null>(null);
  const [progress, setProgress] = useState<PairingSession | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const boards = useLiveData<any[]>('/api/boards');

  useEffect(() => {
    if (!session) return;
    const id = window.setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(id);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await api.get<PairingSession>(`/api/pairing/progress?session=${encodeURIComponent(session.session_id)}`);
        if (!alive) return;
        setProgress(r); setSeconds(r.seconds_left); setError('');
        if (r.claimed) { boards.refresh(); toast('Controller paired'); return; }
      } catch (e: any) { if (alive) setError(e.message || 'Could not read the pairing state.'); }
      if (alive && !progress?.claimed) window.setTimeout(poll, 2500);
    };
    void poll();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.session_id]);

  const issue = async () => {
    setBusy(true); setError(''); setProgress(null);
    try {
      const r = await api.post<any>('/api/pairing/code', {});
      if (!/^[0-9]{6}$/.test(String(r?.code || ''))) throw new Error('The server did not return a six-digit code.');
      setSession({ session_id: r.session_id, code: String(r.code), seconds_left: Number(r.seconds_left) || 300 });
      setSeconds(Number(r.seconds_left) || 300);
    } catch (e: any) { setError(e.message || 'The code could not be created.'); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (session) await api.post('/api/pairing/cancel', { session_id: session.session_id }).catch(() => {});
    setSession(null); setProgress(null); setSeconds(0);
  };

  const claimedBoard = progress?.board;
  return <Card title="Pair a controller" icon="key"
    sub="A six-digit code, valid for five minutes and usable once.">
    {!session ? <>
      <Notice tone="info" title="When to use this">
        After the controller has joined your Wi-Fi it shows its setup page. Ask for a code here, type it there, and the controller registers itself with its own credentials.
      </Notice>
      <button className="btn btn-primary btn-block" style={{ marginTop: 14 }} onClick={issue} disabled={busy}>
        {busy ? <><Icon.loader className="spinner" />Creating…</> : <><Icon.key />Get a pairing code</>}</button>
    </> : <>
      <div style={{ textAlign: 'center', padding: '6px 0 14px' }}>
        <div className="mono" style={{ fontSize: 42, letterSpacing: 10, fontWeight: 700 }}>{session.code}</div>
        <div className="tiny" style={{ marginTop: 6 }}>
          {seconds > 0 ? `Expires in ${countdown(seconds)}` : 'This code has expired'}
        </div>
        <Progress value={Math.max(0, Math.min(100, (seconds / 300) * 100))} tone={seconds > 60 ? 'on' : 'danger'} />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        <CopyButton value={session.code} label="Copy code" />
        <button className="btn btn-sm" onClick={issue} disabled={busy}><Icon.refresh />New code</button>
        <button className="btn btn-sm btn-ghost" onClick={cancel}>Cancel</button>
      </div>
      {progress?.claimed && claimedBoard
        ? <div className="notice success" style={{ marginTop: 14 }}><Icon.ok />
          {claimedBoard.name} registered and is {claimedBoard.status}. The code is no longer valid.</div>
        : progress?.expired
          ? <div className="notice warn" style={{ marginTop: 14 }}><Icon.clock />This code expired before a controller used it. Get a new code.</div>
          : <div className="tiny" style={{ marginTop: 14 }}>
            Enter this code on the controller's setup page. {progress ? `${progress.remaining_attempts} attempt(s) left on this code.` : ''}
          </div>}
      {error && <div className="notice danger" style={{ marginTop: 12 }}><Icon.fail />{error}</div>}
    </>}
  </Card>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function InstallPage() {
  const { data, loading, error, refresh } = useLiveData<Catalog>('/api/firmware/catalog');
  const toast = useAuth().toast;
  const [usb, setUsb] = useState<Catalog['install'][number] | null>(null);
  const [ota, setOta] = useState<ControllerEntry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const install = data?.install || [];
  const controllers = data?.controllers || [];
  const online = controllers.filter((c) => c.status === 'online');
  const recommended = install.find((p) => p.artifact_kind === 'app') || install[0] || null;

  const update = async (controller: ControllerEntry) => {
    setBusy(controller.id);
    try {
      await api.post('/api/firmware/update', { board_id: controller.id });
      toast(`Update to ${controller.latest?.version} queued`);
      refresh();
    } catch (e: any) { toast(e.message || 'The update could not be queued', 'error'); }
    finally { setBusy(null); }
  };

  return <>
    <PageHead title="Firmware" eyebrow="Home console"
      desc="Install a published release over USB in this browser, or update a paired controller wirelessly."
      actions={<Link className="btn" to="/setup"><Icon.cpu />Add a controller<Icon.next /></Link>} />

    {error && <div style={{ marginBottom: 16 }}><ErrorState text={error} onRetry={refresh} /></div>}

    <div className="grid grid-2" style={{ marginBottom: 16, alignItems: 'start' }}>
      <Card title="Option A · Install over USB in this browser" icon="usb"
        sub="Recommended for a new controller, or when one needs recovery."
        actions={recommended ? <Badge tone="on">{recommended.version}</Badge> : <Badge tone="warn">No release</Badge>}>
        {loading ? <Loading rows={3} /> : !recommended ? <EmptyState icon="usb" title="No release published yet"
          text="An owner has to publish a firmware release before it can be installed here." />
          : <>
            <div className="kv">
              <dt>Version</dt><dd className="mono">{recommended.version}</dd>
              <dt>Size</dt><dd>{fmtBytes(recommended.size_bytes)}</dd>
              <dt>Chip</dt><dd>{recommended.chip_family}</dd>
              <dt>Checksum</dt><dd className="mono tiny" style={{ wordBreak: 'break-all' }}>{recommended.sha256}</dd>
              <dt>Type</dt><dd>{installModeLabel(recommended.artifact_kind).label}</dd>
            </div>
            {!serialSupported() && <div style={{ marginTop: 12 }}><Notice tone="warn" title="Use Chrome or Edge on a computer">
              This browser has no Web Serial support, so the in-browser installer cannot open a serial port. You can still download the file below.
            </Notice></div>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => setUsb(recommended)}>
                <Icon.usb />Install over USB</button>
              <a className="btn" href={`/api/firmware/download/${recommended.id}`}><Icon.download />Download the file</a>
            </div>
            <div className="divider" />
            <details>
              <summary className="tiny" style={{ cursor: 'pointer' }}>Instructions for a manual install</summary>
              <ol style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.9, fontSize: 12.5 }}>
                {USB_STEPS.map((s) => <li key={s.title}><b>{s.title}</b> — {s.detail}</li>)}
              </ol>
              <p className="tiny" style={{ marginTop: 8 }}>
                You never need the Arduino IDE. If you prefer an official tool, open ESP Web Tools and select the file you downloaded.
              </p>
              <a className="btn btn-sm" href="https://esphome.github.io/esp-web-tools/" target="_blank" rel="noreferrer">
                <Icon.external />ESP Web Tools install page</a>
            </details>
            {install.length > 1 && <div style={{ marginTop: 12 }}>
              <h4 style={{ fontSize: 12.5, marginBottom: 6 }}>Other published builds</h4>
              {install.filter((p) => p.id !== recommended.id).map((p) => <div key={p.id} className="list-item" style={{ padding: '8px 0' }}>
                <span className="icon-box"><Icon.layers /></span>
                <span className="grow"><span className="title">{p.version}</span>
                  <span className="meta">{installModeLabel(p.artifact_kind).label} · {fmtBytes(p.size_bytes)}</span></span>
                <button className="btn btn-sm" onClick={() => setUsb(p)}>Install</button>
              </div>)}
            </div>}
          </>}
      </Card>

      <PairingPanel />
    </div>

    <Card title="Your controllers" icon="circuitry" pad={false}
      sub={`${online.length} of ${controllers.length} online · wireless updates need a controller that can reach the internet`}>
      {loading ? <div className="card-pad"><Loading rows={4} shape="table" /></div>
        : !controllers.length ? <div className="card-pad"><EmptyState icon="cpu" title="No controllers paired yet"
          text="Install the firmware over USB above, then follow the Wi-Fi and pairing steps to add the controller to this home."
          action={<Link className="btn btn-primary" to="/setup">Start setup</Link>} /></div>
          : <div className="card-pad" style={{ display: 'grid', gap: 12 }}>
            {controllers.map((c) => <div key={c.id} className="card card-pad" style={{ display: 'grid', gap: 10 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div className="icon-box"><Icon.cpu /></div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontWeight: 700 }}>{c.name}</div>
                  <div className="tiny">{c.board_label || c.chip_family || 'Board not reported'} · <span className="mono">{c.device_id}</span></div>
                  <div className="tiny">Installed <span className="mono">{c.installed_version || 'not reported'}</span> · seen {timeAgo(c.last_seen_at)}</div>
                </div>
                <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
                  <StatusBadge status={c.status} />
                  {c.latest?.update_available
                    ? <Badge tone="warn" icon="alert">{c.latest.version} available</Badge>
                    : c.installed_version && c.latest
                      ? <Badge tone="on" icon="check">Up to date</Badge>
                      : <Badge>No release offered</Badge>}
                </div>
              </div>
              {c.update && <div>
                <div className="tiny" style={{ marginBottom: 4 }}>
                  {c.update.status} · {c.update.progress ?? 0}% {c.update.error ? `· ${c.update.error}` : ''}
                </div>
                <Progress value={c.update.progress || 0}
                  tone={c.update.status === 'failed' ? 'danger' : c.update.status === 'success' ? 'on' : 'warn'} />
              </div>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-sm btn-primary" disabled={!c.latest?.update_available || !!c.update || busy === c.id}
                  onClick={() => update(c)}>
                  {busy === c.id ? <><Icon.loader className="spinner" />Queueing…</> : <><Icon.download />Update to {c.latest?.version || 'latest'}</>}
                </button>
                <button className="btn btn-sm" onClick={() => setOta(c)}><Icon.info />Details{c.latest?.update_available ? '' : ' and rollback'}</button>
                <Link className="btn btn-sm" to={`/boards/${c.id}`}><Icon.sliders />Pin manager</Link>
              </div>
              {c.last_failure && <div className="tiny" style={{ color: 'var(--state-danger)' }}>
                Last attempt failed {timeAgo(c.last_failure.finished_at)}: {c.last_failure.error || 'no reason reported'}
              </div>}
            </div>)}
          </div>}
    </Card>

    {usb && <UsbInstallModal pkg={usb} onClose={() => setUsb(null)} />}
    {ota && <OtaModal controller={ota} onClose={() => setOta(null)} onDone={refresh} />}
  </>;
}
