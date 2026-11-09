/**
 * Customer Console — firmware for a home's controllers.
 *
 * Every write to a controller is done here, and only here:
 *   - Update and Restore: the controller downloads an app image over HTTPS and
 *     reports its own progress.
 *   - Fresh install: a factory image written over USB in this browser with
 *     esptool-js. It is the only path that can recover a controller that no
 *     longer boots.
 *
 * Progress shown is only what the browser transfer or the controller itself
 * reports. Nothing advances on a timer.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useLiveData } from '../api';
import { useAuth } from '../state';
import {
  Badge, Card, CopyButton, DeviceIllustration, EmptyState, ErrorState, Icon, Loading,
  Modal, Notice, PageHead, Progress, StatusBadge, fmtBytes, timeAgo, timeFull,
} from '../components';
import {
  USB_STEPS, espWebToolsUrl, fetchPackage, flashOverSerial, imageChipId, installModeLabel,
  serialSupported, verifyImage,
} from '../installer';
import type { InstallProgress } from '../installer';

/* ---------------------------------------------------------------- types -- */

/** One published release as the customer console receives it. */
type Release = {
  id: string; name: string; version: string; channel: string; artifact_kind: string;
  chip_family: string; chip_id: number | null; flash_offset: number; size_bytes: number; sha256: string;
  notes: string | null; mandatory: boolean; ota_eligible: boolean; published_at: string | null;
  board_models: string[]; board_labels: string[]; owned_controller_ids: string[];
  download_path: string; install_path: string;
};

type BoardType = {
  id: string; manufacturer: string; model: string; variant: string | null; chip_family: string;
  summary: string | null; flash_mb: number | null; psram_mb: number | null;
  owned_controllers: number; release_count: number; factory_release_count: number;
};

/** A controller in this home, as the catalogue reports it. */
type Controller = {
  id: string; name: string; device_id: string; status: string; online: boolean; last_seen_at: string | null;
  catalog_board_id: string | null; board_label: string | null; chip_family: string | null;
  installed_version: string | null;
  latest: { id: string; version: string; notes: string | null; size_bytes: number; sha256: string;
    mandatory: boolean; update_available: boolean } | null;
  restore_candidates: Release[];
  active_update: { id: string; status: string; progress: number | null; error: string | null;
    started_at: string; to_version: string | null } | null;
  last_success_at: string | null;
  last_failure: { id: string; status: string; error: string | null; finished_at: string | null; to_version: string | null } | null;
};

type Catalog = {
  board_types: BoardType[];
  releases: Release[];
  controllers: Controller[];
};

/** Install package for one factory or app release, from POST install-package. */
type InstallPackage = {
  id: string; version: string; name: string; notes: string | null; channel: string;
  artifact_kind: string; chip_family: string; chip_id: number | null; size_bytes: number;
  sha256: string; flash_offset: number; published_at: string | null; url: string;
};

const OPEN_STATES = ['queued', 'downloading', 'installing', 'verifying'];

/** Release channel, shown as a badge tone. */
function channelTone(channel: string): 'on' | 'warn' | '' {
  return channel === 'stable' ? 'on' : channel === 'beta' ? 'warn' : '';
}

function boardName(t: { manufacturer: string; model: string; variant: string | null }) {
  return `${t.manufacturer} ${t.model}${t.variant ? ` ${t.variant}` : ''}`;
}

/** Opens a factory image for USB installation. The server signs the URL. */
async function prepareUsb(release: Release): Promise<InstallPackage> {
  return api.post<InstallPackage>(release.install_path, {});
}

/* -------------------------------------------- fresh install over USB -- */

// Writes a factory image with esptool-js (Web Serial). The same modal serves
// new controllers, recovery, and the library.
function UsbInstallModal({ pkg, onClose }: { pkg: InstallPackage; onClose: () => void }) {
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
  const webTools = useMemo(() => ({ script: espWebToolsUrl() }), []);

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


/* --------------------------------------------------- wireless restore -- */

/**
 * Wireless restore: the controller fetches an earlier app image it has run before
 * or any other compatible app image, through the same update path as an update.
 * It cannot recover a controller that no longer boots, so that case is routed to
 * a USB fresh install with a factory image.
 */
function RestoreModal({ controller, onClose, onDone, onUsbRecovery }: {
  controller: Controller; onClose: () => void; onDone: () => void;
  onUsbRecovery: () => void;
}) {
  const toast = useAuth().toast;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const restore = async (release: Release) => {
    setBusy(release.id); setError('');
    try {
      await api.post('/api/firmware/rollback', { board_id: controller.id, release_id: release.id });
      toast(`Restore to ${release.version} queued. The controller reports its own progress.`);
      onDone(); onClose();
    } catch (e: any) { setError(e.message || 'The restore could not be queued.'); }
    finally { setBusy(null); }
  };
  const busyNow = !!controller.active_update;
  return <Modal title={`Restore · ${controller.name}`} wide onClose={onClose}
    description={`Installed now: ${controller.installed_version || 'not reported'}`}
    footer={<button className="btn" onClick={onClose}>Close</button>}>
    {error && <div className="notice danger" style={{ marginBottom: 16 }}><Icon.fail />{error}</div>}
    {busyNow && <div style={{ marginBottom: 12 }}><Notice tone="warn" title="An update is already running">
      Wait for it to finish before starting a restore.
    </Notice></div>}
    <Notice tone="info" title="Wireless restore">
      Restores an application image that this controller can take over the air. The controller checks the SHA-256, writes the inactive slot and reboots into it. If it cannot connect afterwards it returns to the version it runs now.
    </Notice>
    <div style={{ marginTop: 14 }}>
      {controller.restore_candidates.length === 0
        ? <EmptyState icon="layers" title="No other application image is available"
          text="The owner has not published another compatible application image for this controller." />
        : <div style={{ display: 'grid', gap: 8 }}>
          {controller.restore_candidates.map((r) => <div key={r.id} className="list-item" style={{ padding: '8px 0' }}>
            <span className="icon-box"><Icon.layers /></span>
            <span className="grow">
              <span className="title mono">{r.version}</span>{' '}
              <Badge tone={channelTone(r.channel)}>{r.channel}</Badge>{r.mandatory && <> <Badge tone="warn">Mandatory</Badge></>}
              <span className="meta" style={{ display: 'block' }}>{fmtBytes(r.size_bytes)} · {r.published_at ? timeFull(r.published_at) : 'Not dated'}</span>
            </span>
            <button className="btn btn-sm" disabled={busyNow || busy !== null} onClick={() => restore(r)}>
              {busy === r.id ? <><Icon.loader className="spinner" />Queueing…</> : <><Icon.retry />Restore</>}
            </button>
          </div>)}
        </div>}
    </div>
    <div className="divider" />
    <h4 style={{ fontSize: 13, marginBottom: 4 }}>The controller no longer starts?</h4>
    <p className="tiny" style={{ marginBottom: 8 }}>
      A wireless restore needs a controller that still runs. Connect it by USB and install a factory image instead.
    </p>
    <button className="btn btn-sm" onClick={onUsbRecovery}><Icon.usb />Fresh install over USB</button>
  </Modal>;
}

/* ------------------------------------------------- factory picker (USB) -- */

/**
 * Lists the factory images for one board type. Choosing one opens the USB
 * installer. The list is the only source of what can be installed here.
 */
function FactoryPicker({ title, releases, onPick, onClose }: {
  title: string; releases: Release[]; onPick: (pkg: InstallPackage) => void; onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pick = async (r: Release) => {
    setBusy(r.id); setError('');
    try { onPick(await prepareUsb(r)); }
    catch (e: any) { setError(e.message || 'The image could not be prepared.'); }
    finally { setBusy(null); }
  };
  return <Modal title={title} wide onClose={onClose}
    description="A factory image writes the whole controller over USB, including its bootloader. Use it for a new controller or one that will not start."
    footer={<button className="btn" onClick={onClose}>Close</button>}>
    {error && <div className="notice danger" style={{ marginBottom: 16 }}><Icon.fail />{error}</div>}
    {!serialSupported() && <div style={{ marginBottom: 12 }}><Notice tone="warn" title="Use Chrome or Edge on a computer">
      This browser has no Web Serial support, so the installer cannot open the controller's USB port.
    </Notice></div>}
    {releases.length === 0
      ? <EmptyState icon="usb" title="No factory image published" text="An owner has to publish a factory image for this board before it can be installed over USB." />
      : <div style={{ display: 'grid', gap: 8 }}>
        {releases.map((r) => <div key={r.id} className="list-item" style={{ padding: '8px 0' }}>
          <span className="icon-box"><Icon.usb /></span>
          <span className="grow">
            <span className="title mono">{r.version}</span>{' '}
            <Badge tone={channelTone(r.channel)}>{r.channel}</Badge>
            <span className="meta" style={{ display: 'block' }}>{fmtBytes(r.size_bytes)} · {r.chip_family} · {r.published_at ? timeFull(r.published_at) : 'Not dated'}</span>
          </span>
          <button className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => pick(r)}>
            {busy === r.id ? <><Icon.loader className="spinner" />Preparing…</> : <><Icon.usb />Install over USB</>}</button>
        </div>)}
      </div>}
  </Modal>;
}

/* --------------------------------------------------------------- page -- */

export function InstallPage() {
  const { data, loading, error, refresh } = useLiveData<Catalog>('/api/firmware/catalog');
  const toast = useAuth().toast;
  const [usb, setUsb] = useState<InstallPackage | null>(null);
  const [picker, setPicker] = useState<{ title: string; releases: Release[] } | null>(null);
  const [restoring, setRestoring] = useState<Controller | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState<'all' | 'app' | 'factory'>('all');
  const [query, setQuery] = useState('');
  const [preparing, setPreparing] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState('');

  const boardTypes = data?.board_types || [];
  const releases = data?.releases || [];
  const controllers = data?.controllers || [];
  const anyActive = controllers.some((c) => !!c.active_update);

  // While a controller is working, reload the catalogue so its progress is current.
  useEffect(() => {
    if (!anyActive) return;
    const id = window.setInterval(() => refresh(), 5000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyActive]);

  const factoriesFor = (boardId: string) =>
    releases.filter((r) => r.artifact_kind === 'factory' && r.board_models.includes(boardId));

  const openFactory = (title: string, list: Release[]) => setPicker({ title, releases: list });

  const update = async (controller: Controller) => {
    setBusy(controller.id);
    try {
      await api.post('/api/firmware/update', { board_id: controller.id });
      toast(`Update to ${controller.latest?.version} queued. The controller reports its own progress.`);
      refresh();
    } catch (e: any) { toast(e.message || 'The update could not be queued', 'error'); }
    finally { setBusy(null); }
  };

  const openLibraryUsb = async (release: Release) => {
    setPreparing(release.id); setLibraryError('');
    try { setUsb(await prepareUsb(release)); }
    catch (e: any) { setLibraryError(e.message || 'The image could not be prepared.'); }
    finally { setPreparing(null); }
  };

  const libraryRows = releases.filter((r) =>
    (kind === 'all' || r.artifact_kind === kind) &&
    (!query || `${r.version} ${r.name} ${r.board_labels.join(' ')}`.toLowerCase().includes(query.toLowerCase())));

  return <>
    <PageHead title="Firmware" eyebrow="Home console"
      desc="Update, restore or fresh-install the controllers in this home. Every image comes from a release the owner published."
      actions={<Link className="btn" to="/setup"><Icon.cpu />Add a controller<Icon.next /></Link>} />

    {error && <div style={{ marginBottom: 16 }}><ErrorState text={error} onRetry={refresh} /></div>}

    {/* ---------------------------------------------- your controllers */}
    <Card title="Your controllers" icon="circuitry" pad={false}
      sub={`${controllers.filter((c) => c.status === 'online').length} of ${controllers.length} online · wireless updates need a controller that can reach the internet`}>
      {loading ? <div className="card-pad"><Loading rows={3} shape="table" /></div>
        : !controllers.length ? <div className="card-pad"><EmptyState icon="cpu" title="No controllers paired yet"
          text="Install a controller over USB from the board list below, then add it to this home with the setup guide."
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
                      : <Badge>No update offered</Badge>}
                </div>
              </div>

              {c.active_update && <div>
                <div className="tiny" style={{ marginBottom: 4 }}>
                  {c.active_update.status}{c.active_update.to_version ? ` to ${c.active_update.to_version}` : ''} · {c.active_update.progress ?? 0}%
                  {c.active_update.error ? ` · ${c.active_update.error}` : ''}
                </div>
                <Progress value={c.active_update.progress || 0} tone="warn" />
              </div>}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-sm btn-primary"
                  disabled={!c.latest?.update_available || !!c.active_update || busy === c.id || !c.online}
                  onClick={() => update(c)} title={!c.online ? 'The controller must be online to update' : undefined}>
                  {busy === c.id ? <><Icon.loader className="spinner" />Queueing…</> : <><Icon.download />Update{c.latest?.update_available ? ` to ${c.latest.version}` : ''}</>}
                </button>
                <button className="btn btn-sm" disabled={!!c.active_update || c.restore_candidates.length === 0}
                  onClick={() => setRestoring(c)}>
                  <Icon.retry />Restore</button>
                <button className="btn btn-sm" disabled={!c.catalog_board_id}
                  onClick={() => c.catalog_board_id && openFactory(`Fresh install · ${c.name}`, factoriesFor(c.catalog_board_id))}>
                  <Icon.usb />Fresh install over USB</button>
                <Link className="btn btn-sm" to={`/boards/${c.id}`}><Icon.sliders />Pin manager</Link>
              </div>

              {c.last_failure && <div className="tiny" style={{ color: 'var(--state-danger)' }}>
                Last attempt to {c.last_failure.to_version || 'a new version'} failed {timeAgo(c.last_failure.finished_at)}: {c.last_failure.error || 'no reason reported'}
              </div>}
            </div>)}
          </div>}
    </Card>

    {/* ------------------------------------------------------ board types */}
    <div style={{ height: 16 }} />
    <Card title="Board types" icon="cube" pad={false}
      sub="Every board the owner has published firmware for. Fresh install writes a factory image over USB.">
      {loading ? <div className="card-pad"><Loading rows={3} shape="table" /></div>
        : !boardTypes.length ? <div className="card-pad"><EmptyState icon="cube" title="No board types yet" text="The board catalogue is empty." /></div>
          : <div className="card-pad" style={{ display: 'grid', gap: 10 }}>
            {boardTypes.map((t) => <div key={t.id} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="icon-box"><Icon.circuitry /></span>
              <span className="grow" style={{ flex: 1, minWidth: 180 }}>
                <span className="title">{boardName(t)}</span>
                <span className="meta" style={{ display: 'block' }}>
                  {t.chip_family}{t.flash_mb ? ` · ${t.flash_mb} MB flash` : ''}{t.psram_mb ? ` · ${t.psram_mb} MB PSRAM` : ''}
                  {' · '}{t.owned_controllers} in this home · {t.release_count} release{t.release_count === 1 ? '' : 's'}
                </span>
              </span>
              <button className="btn btn-sm" disabled={t.factory_release_count === 0}
                onClick={() => openFactory(`Fresh install · ${boardName(t)}`, factoriesFor(t.id))}>
                <Icon.usb />{t.factory_release_count ? 'Fresh install' : 'No factory image'}</button>
            </div>)}
          </div>}
    </Card>

    {/* ----------------------------------------------------------- library */}
    <div style={{ height: 16 }} />
    <Card title="Firmware library" icon="archive" pad={false}
      sub="Published releases. Factory images install over USB; application images update controllers over the air.">
      <div className="card-pad" style={{ paddingBottom: 0 }}>
        <div className="filter-bar">
          <div className="segmented" role="group" aria-label="Filter by image type">
            {(['all', 'app', 'factory'] as const).map((k) => <button key={k} className={kind === k ? 'on' : ''}
              onClick={() => setKind(k)}>{k === 'all' ? 'All' : k === 'app' ? 'Application' : 'Factory'}</button>)}
          </div>
          <div className="search">
            <Icon.search />
            <input className="input" placeholder="Search version or board" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search firmware" />
          </div>
        </div>
        {libraryError && <div className="notice danger" style={{ marginBottom: 12 }}><Icon.fail />{libraryError}</div>}
      </div>
      {loading ? <div className="card-pad"><Loading rows={3} shape="table" /></div>
        : !releases.length ? <div className="card-pad"><EmptyState icon="archive" title="No release published yet"
          text="An owner has to publish a firmware release before it appears here." /></div>
          : !libraryRows.length ? <div className="card-pad"><EmptyState icon="search" title="No matching release" text="Try another version or type." /></div>
            : <div style={{ overflowX: 'auto' }}>
              <table className="tbl">
                <thead><tr><th>Version</th><th>Type</th><th>Boards</th><th>Size</th><th>Published</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
                <tbody>
                  {libraryRows.map((r) => <tr key={r.id}>
                    <td><div className="mono" style={{ fontWeight: 700 }}>{r.version}</div>
                      <div className="tiny"><Badge tone={channelTone(r.channel)}>{r.channel}</Badge>{r.mandatory && <> <Badge tone="warn">Mandatory</Badge></>}</div></td>
                    <td>{installModeLabel(r.artifact_kind).label}</td>
                    <td className="tiny">{r.board_labels.join(', ') || '—'}</td>
                    <td>{fmtBytes(r.size_bytes)}</td>
                    <td className="tiny">{r.published_at ? timeAgo(r.published_at) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {r.artifact_kind === 'factory'
                          ? <button className="btn btn-sm" disabled={preparing !== null} onClick={() => openLibraryUsb(r)}>
                            {preparing === r.id ? <><Icon.loader className="spinner" />Preparing…</> : <><Icon.usb />Install over USB</>}</button>
                          : <a className="btn btn-sm" href={r.download_path}><Icon.download />Download</a>}
                      </div>
                    </td>
                  </tr>)}
                </tbody>
              </table>
            </div>}
    </Card>

    {usb && <UsbInstallModal pkg={usb} onClose={() => setUsb(null)} />}
    {picker && <FactoryPicker title={picker.title} releases={picker.releases}
      onPick={(pkg) => { setPicker(null); setUsb(pkg); }} onClose={() => setPicker(null)} />}
    {restoring && <RestoreModal controller={restoring} onClose={() => setRestoring(null)} onDone={refresh}
      onUsbRecovery={() => {
        const target = restoring;
        setRestoring(null);
        if (target.catalog_board_id) openFactory(`Fresh install · ${target.name}`, factoriesFor(target.catalog_board_id));
      }} />}
  </>;
}
