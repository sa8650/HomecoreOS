/** Owner Console — one firmware pipeline for USB and over-the-air installs. */
import React, { useMemo, useState } from 'react';
import { api, useLiveData } from '../api';
import { useAuth } from '../state';
import {
  Badge, Card, DataTable, EmptyState, Field, Icon, Loading, Modal, Notice,
  PageHead, Progress, StatusBadge, fmtBytes, timeFull, timeAgo,
} from '../components';
import type {
  ControllerEntry, FirmwareRelease, OwnerFirmwareOverview, PackageUploadResult, UpdateHistoryRow,
} from '../firmware';
import { publishReadiness, releaseKindLabel } from '../firmware';

function useToast() { return useAuth().toast; }

function sha256Browser(file: File): Promise<string> {
  return file.arrayBuffer().then((buf) => crypto.subtle.digest('SHA-256', buf))
    .then((d) => Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join(''));
}
function toBase64(file: File): Promise<string> {
  return file.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(s);
  });
}

const CHANNELS = [
  { id: 'stable', label: 'Stable', hint: 'Offered to every compatible controller by default.' },
  { id: 'beta', label: 'Beta', hint: 'Opt-in builds. A controller on stable never receives these automatically.' },
  { id: 'dev', label: 'Development', hint: 'Internal builds for testing. Never offered as the latest stable release.' },
];

/**
 * Owner Console: upload the release ZIP that GitHub Actions produces.
 *
 * The ZIP is sent to the server unchanged and validated there: the archive is
 * re-read, both images are checked structurally, every checksum is recomputed and
 * the signature is verified with the configured public key. This dialog only shows
 * what came back, step by step, so a failure names the exact reason.
 */
function PackageUploadModal({ data, onClose, onDone }: {
  data: OwnerFirmwareOverview; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [digest, setDigest] = useState('');
  const [channel, setChannel] = useState('stable');
  const [status, setStatus] = useState('draft');
  const [notes, setNotes] = useState('');
  const [boards, setBoards] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'idle' | 'reading' | 'uploading'>('idle');
  const [error, setError] = useState('');
  const [result, setResult] = useState<PackageUploadResult | null>(null);
  const maxBytes = Number(data.limits?.package_max_bytes || 12 * 1024 * 1024);
  const esp32Boards = (data.board_catalog || []).filter((b) => /ESP32-S3/i.test(b.chip_family));
  const signing = data.signing;

  const choose = async (next: File | null) => {
    setError(''); setResult(null); setDigest(''); setFile(next);
    if (!next) return;
    if (!/\.zip$/i.test(next.name)) {
      setError('Choose the release ZIP (homecoreos-<version>.zip) from GitHub Actions or Releases. A single .bin belongs in "Upload single image".');
      setFile(null); return;
    }
    if (!next.size) { setError('This file is empty.'); setFile(null); return; }
    if (next.size > maxBytes) {
      setError(`This ZIP is ${fmtBytes(next.size)}; a release package is smaller than ${fmtBytes(maxBytes)}.`);
      setFile(null); return;
    }
    try { setDigest(await sha256Browser(next)); }
    catch { setError('The browser could not read this file.'); setFile(null); }
  };

  const upload = async () => {
    if (!file) { setError('Choose the release ZIP first.'); return; }
    setError(''); setResult(null); setBusy(true);
    try {
      setStage('reading');
      const payload = await toBase64(file);
      setStage('uploading');
      const res = await api.post<PackageUploadResult>('/api/owner/firmware/upload-package', {
        package_base64: payload,
        status, channel, notes: notes.trim() || undefined,
        board_models: boards.length ? boards : undefined,
      });
      setResult(res);
      if (res.ok) toast(`${res.version} ${res.status === 'published' ? 'published' : 'stored as a draft'}`);
      else toast(`${res.version} stored as a draft: ${res.problems.length} check(s) failed`, 'error');
      onDone();
    } catch (e: any) {
      setError(e.message || 'The package could not be uploaded.');
      if (Array.isArray(e?.detail?.problems) && e.detail.problems.length) {
        setResult({
          ok: false, status: 'draft', version: '', channel, name: '', board_models: [],
          signature: { present: false, algorithm: null, verified: null },
          checks: Array.isArray(e.detail.checks) ? e.detail.checks : [],
          problems: e.detail.problems, releases: [],
        });
      }
    } finally { setBusy(false); setStage('idle'); }
  };

  return <Modal title="Upload release package" wide
    description="Upload the ZIP from GitHub Actions or Releases. The manifest, both images, the checksums and the signature are verified before anything is stored."
    onClose={onClose} footer={<>
      <button className="btn" onClick={onClose} disabled={busy}>{result ? 'Close' : 'Cancel'}</button>
      <button className="btn btn-primary" onClick={upload} disabled={busy || !file}>
        {busy ? <><Icon.loader className="spinner" />{stage === 'reading' ? 'Reading…' : 'Uploading…'}</>
          : <><Icon.cloudUp />{result ? 'Upload again' : 'Upload and validate'}</>}
      </button>
    </>}>
    {signing && !signing.configured && <Notice tone="warn" title="Signing key not configured">
      {signing.note}
    </Notice>}

    <div style={{ marginTop: 12 }}>
      <input className="input" type="file" accept=".zip,application/zip"
        onChange={(e) => choose(e.target.files?.[0] || null)} disabled={busy} />
      <div className="tiny" style={{ marginTop: 8 }}>
        Expected inside the ZIP: <code>manifest.json</code>, the OTA image
        (<code>homecoreos-&lt;version&gt;-app.bin</code>) and the USB image
        (<code>homecoreos-&lt;version&gt;-usb.bin</code>). Do not unzip or rename anything.
      </div>
      {file && <div className="card card-pad" style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <Icon.box />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.name}</div>
          <div className="tiny">{fmtBytes(file.size)}</div>
          <div className="mono tiny" style={{ wordBreak: 'break-all' }}>SHA-256 {digest || 'calculating…'}</div>
        </div>
      </div>}
    </div>

    {busy && <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
      <div className="upload-bar"><span className={stage === 'reading' ? 'upload-bar-fill' : 'upload-bar-done'} /></div>
      <div className="tiny">{stage === 'reading' ? 'Reading the package in this browser…' : 'Uploading and validating on the server…'}</div>
    </div>}

    {error && <div className="notice danger" style={{ marginTop: 14 }}><Icon.fail />{error}</div>}

    {result && <div style={{ marginTop: 16, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {result.ok ? <Badge tone="on" icon="check">Every check passed</Badge>
          : <Badge tone="warn" icon="alert">{result.problems.length} check(s) failed</Badge>}
        <Badge tone={result.status === 'published' ? 'on' : 'warn'}>{result.status === 'published' ? 'Published' : 'Saved as draft'}</Badge>
        {result.signature.present
          ? <Badge tone={result.signature.verified ? 'on' : result.signature.verified === false ? 'danger' : 'warn'} icon="shieldOk">
              {result.signature.verified ? 'Signature verified' : result.signature.verified === false ? 'Signature invalid' : 'Signature not checked'}
            </Badge>
          : <Badge tone="warn" icon="shieldOk">Unsigned · signing key not configured</Badge>}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {result.checks.map((c) => <div key={c.id} className="check-row"
          style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 10,
            background: c.ok ? 'var(--state-on-soft, rgba(34,197,94,.08))' : 'var(--state-danger-soft, rgba(239,68,68,.08))' }}>
          {c.ok ? <Icon.check /> : <Icon.fail />}
          <div><div style={{ fontSize: 13, fontWeight: 600 }}>{c.label}</div><div className="tiny">{c.detail}</div></div>
        </div>)}
      </div>
      {result.problems.length > 0 && <div className="notice danger">
        <Icon.alert />
        <div><b>Why it is not published</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{result.problems.map((p) => <li key={p} className="tiny">{p}</li>)}</ul>
        </div>
      </div>}
      {result.releases.length > 0 && <div className="tiny">
        Stored: {result.releases.map((r) => `${r.kind === 'app' ? 'OTA image' : 'USB image'} ${fmtBytes(r.size_bytes)}`).join(' · ')}
      </div>}
    </div>}

    <div className="form-row" style={{ marginTop: 16 }}>
      <Field label="Channel">
        <select className="select" value={channel} onChange={(e) => setChannel(e.target.value)} disabled={busy}>
          {CHANNELS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <div className="tiny" style={{ marginTop: 6 }}>{CHANNELS.find((c) => c.id === channel)?.hint}</div>
      </Field>
      <Field label="After upload">
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} disabled={busy}>
          <option value="draft">Save as draft — publish after reviewing the checks</option>
          <option value="published">Publish now (only if every check passes)</option>
        </select>
      </Field>
    </div>
    <Field label="Compatible controller models"
      hint="Defaults to the models named in manifest.json. Narrow it here if the build is meant for some of them only.">
      <select className="select" multiple size={Math.min(6, Math.max(3, esp32Boards.length))} value={boards}
        disabled={busy} onChange={(e) => setBoards(Array.from(e.target.selectedOptions).map((o) => o.value))}>
        {esp32Boards.map((b) => <option key={b.id} value={b.id}>{b.manufacturer} {b.model}</option>)}
      </select>
    </Field>
    <Field label="Notes for this upload" hint="Optional. Overrides the notes inside manifest.json.">
      <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy}
        placeholder="Workflow run 42. Fixes reconnect after a router restart." />
    </Field>
  </Modal>;
}

function UploadModal({ catalog, limits, onClose, onDone }: {
  catalog: OwnerFirmwareOverview['board_catalog']; limits: OwnerFirmwareOverview['limits'];
  onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [f, setF] = useState({
    name: '', version: '', description: '', release_notes: '',
    channel: 'stable', status: 'draft', artifact_kind: 'app', chip_family: 'ESP32-S3',
  });
  const [boards, setBoards] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [digest, setDigest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const maxBytes = Number(limits?.max_bytes || 3 * 1024 * 1024);
  const esp32Boards = catalog.filter((b) => /ESP32-S3/i.test(b.chip_family));

  const choose = async (next: File | null) => {
    setError(''); setProblems([]); setFile(next); setDigest('');
    if (!next) return;
    if (!/\.bin$/i.test(next.name)) { setError('Choose the .bin file produced by the firmware workflow.'); setFile(null); return; }
    if (!next.size) { setError('This file is empty.'); setFile(null); return; }
    if (f.artifact_kind === 'app' && next.size > maxBytes) {
      setError(`An over-the-air image must fit the 3 MB application slot; this file is ${fmtBytes(next.size)}.`);
      setFile(null); return;
    }
    try { setDigest(await sha256Browser(next)); }
    catch { setError('The browser could not calculate the checksum of this file.'); setFile(null); }
  };

  const save = async () => {
    setError(''); setProblems([]);
    if (!f.name.trim() || !f.version.trim()) { setError('Give the release a name and the version the build reports.'); return; }
    if (!file) { setError('Choose a firmware file.'); return; }
    if (f.status === 'published' && !boards.length) { setError('Select at least one compatible controller model before publishing.'); return; }
    setBusy(true);
    try {
      const result = await api.post('/api/owner/firmware/upload', {
        name: f.name.trim(), version: f.version.trim(), description: f.description.trim(),
        release_notes: f.release_notes.trim() || f.description.trim(),
        channel: f.channel, status: f.status, board_models: boards,
        artifact_kind: f.artifact_kind, chip_family: f.chip_family,
        filename: file.name, size_bytes: file.size, sha256: digest,
        binary_base64: await toBase64(file),
      });
      toast(result?.status === 'published' ? `${f.version} published` : `${f.version} saved as a draft`);
      onDone(); onClose();
    } catch (e: any) {
      const list = Array.isArray(e?.detail?.problems) ? e.detail.problems : [];
      setProblems(list);
      setError(e.message || 'The upload failed.');
    } finally { setBusy(false); }
  };

  return <Modal title="Upload firmware" wide
    description="The image is validated on the server before it is stored: chip family, image structure, version and the appended SHA-256 must all agree."
    onClose={onClose} footer={<>
      <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
      <button className="btn btn-primary" onClick={save} disabled={busy || !digest}>
        {busy ? <><Icon.loader className="spinner" />Uploading…</> : <><Icon.cloudUp />Upload release</>}
      </button>
    </>}>
    {error && <div className="notice danger" style={{ marginBottom: 16 }}><Icon.fail />{error}
      {problems.length > 0 && <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>{problems.map((p) => <li key={p} className="tiny">{p}</li>)}</ul>}
    </div>}
    <div className="form-row">
      <Field label="Release name" required><input className="input" value={f.name}
        onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Living room controller 1.3.0" /></Field>
      <Field label="Version" required hint="Must match the version compiled into the image.">
        <input className="input mono" value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} placeholder="1.3.0" /></Field>
    </div>
    <div className="form-row">
      <Field label="Update type">
        <select className="select" value={f.artifact_kind} onChange={(e) => setF({ ...f, artifact_kind: e.target.value })}>
          <option value="app">Application image — over-the-air, and over USB at 0x10000</option>
          <option value="factory">Factory image — USB at 0x0, for a first install or recovery</option>
        </select>
      </Field>
      <Field label="Controller model">
        <select className="select" value={f.chip_family} onChange={(e) => setF({ ...f, chip_family: e.target.value })}>
          <option value="ESP32-S3">ESP32-S3</option>
        </select>
      </Field>
    </div>
    <Field label="What changed" hint="Shown to customers before they install.">
      <textarea className="textarea" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })}
        placeholder="Reconnects faster after a router restart and reports signal strength again." /></Field>
    <Field label="Release notes" hint="Optional detail for the owner console.">
      <textarea className="textarea" value={f.release_notes} onChange={(e) => setF({ ...f, release_notes: e.target.value })}
        placeholder="Include the workflow run number and anything a support engineer should know." /></Field>
    <div className="form-row">
      <Field label="Channel">
        <select className="select" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
          {CHANNELS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <div className="tiny" style={{ marginTop: 6 }}>{CHANNELS.find((c) => c.id === f.channel)?.hint}</div>
      </Field>
      <Field label="After upload">
        <select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="draft">Save as draft — verify before publishing</option>
          <option value="published">Publish now</option>
        </select>
      </Field>
    </div>
    <Field label="Firmware file"
      hint={`.bin up to ${fmtBytes(maxBytes)} for over-the-air · the checksum is calculated in this browser and recomputed on the server`}>
      <input className="input" type="file" accept=".bin" onChange={(e) => choose(e.target.files?.[0] || null)} />
    </Field>
    {file && <div className="card card-pad" style={{ marginBottom: 16, display: 'grid', gap: 6 }}>
      <div className="tiny">{file.name} · {fmtBytes(file.size)}</div>
      <div className="mono tiny" style={{ wordBreak: 'break-all' }}>SHA-256 {digest || 'calculating…'}</div>
      {digest && <Badge tone="on" icon="shieldOk">Checksum ready</Badge>}
    </div>}
    <Field label="Compatible controller models"
      hint="Only these models are offered the release. Hold Ctrl or Cmd to select several.">
      <select className="select" multiple size={Math.min(6, Math.max(3, esp32Boards.length))} value={boards}
        onChange={(e) => setBoards(Array.from(e.target.selectedOptions).map((o) => o.value))}>
        {esp32Boards.map((b) => <option key={b.id} value={b.id}>{b.manufacturer} {b.model}</option>)}
      </select>
    </Field>
  </Modal>;
}

function EditModal({ release, catalog, onClose, onDone }: {
  release: FirmwareRelease; catalog: OwnerFirmwareOverview['board_catalog'];
  onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [f, setF] = useState({
    name: release.name || '', version: release.version, description: release.description || '',
    release_notes: release.release_notes || '', channel: release.channel,
  });
  const [boards, setBoards] = useState<string[]>(release.board_models || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (!f.name.trim() || !f.version.trim()) { setError('A name and version are required.'); return; }
    setBusy(true); setError('');
    try {
      await api.patch(`/api/owner/firmware/${release.id}`, { ...f, board_models: boards });
      toast('Release details saved'); onDone(); onClose();
    } catch (e: any) { setError(e.message || 'The release could not be saved.'); }
    finally { setBusy(false); }
  };
  return <Modal title="Edit release" description={`Version ${release.version} · ${fmtBytes(release.size_bytes)}`}
    onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={save} disabled={busy} aria-busy={busy || undefined}>
        {busy ? 'Saving…' : 'Save changes'}</button></>}>
    {error && <div className="notice danger" style={{ marginBottom: 16 }}><Icon.fail />{error}</div>}
    <div className="form-row">
      <Field label="Release name" required><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Version" required hint="The binary itself is unchanged; only the label.">
        <input className="input mono" value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} /></Field>
    </div>
    <Field label="What changed"><textarea className="textarea" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    <Field label="Release notes"><textarea className="textarea" value={f.release_notes} onChange={(e) => setF({ ...f, release_notes: e.target.value })} /></Field>
    <Field label="Channel"><select className="select" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
      {CHANNELS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></Field>
    <Field label="Compatible controller models"><select className="select" multiple size={Math.min(6, Math.max(3, catalog.length))}
      value={boards} onChange={(e) => setBoards(Array.from(e.target.selectedOptions).map((o) => o.value))}>
      {catalog.filter((b) => /ESP32-S3/i.test(b.chip_family)).map((b) =>
        <option key={b.id} value={b.id}>{b.manufacturer} {b.model}</option>)}
    </select></Field>
    <div className="code" style={{ marginTop: 8 }}>SHA-256 {release.sha256}</div>
  </Modal>;
}

function PublishModal({ release, onClose, onDone }: { release: FirmwareRelease; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const readiness = publishReadiness(release);
  const compatible = (release.board_models || []).length;
  const [busy, setBusy] = useState(false);
  const publish = async () => {
    setBusy(true);
    try {
      await api.post(`/api/owner/firmware/${release.id}/status`, { status: 'published' });
      toast(`${release.version} published`); onDone(); onClose();
    } catch (e: any) { toast(e.message || 'The release could not be published', 'error'); }
    finally { setBusy(false); }
  };
  return <Modal title={`Publish ${release.version}`} onClose={onClose} footer={<>
    <button className="btn" onClick={onClose}>Cancel</button>
    <button className="btn btn-primary" onClick={publish} disabled={busy || !readiness.ready}>
      <Icon.cloudUp />{busy ? 'Publishing…' : 'Publish release'}</button>
  </>}>
    <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
      {readiness.checks.map((c) => <div key={c.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        {c.ok ? <Badge tone="on" icon="check">Ready</Badge> : <Badge tone="warn" icon="alert">Missing</Badge>}
        <div><div style={{ fontSize: 13, fontWeight: 600 }}>{c.label}</div><div className="tiny">{c.detail}</div></div>
      </div>)}
    </div>
    {!release.signature && <Notice tone="warn" title="Unsigned build">
      Controllers verify the SHA-256 of every download, but a detached signature is what proves the image came from you. Attach one before publishing if signing is enforced in Platform Settings.
    </Notice>}
    <div style={{ marginTop: 12 }}><Notice tone="info" title={`${compatible} controller model(s) can install this`}>
      Publishing makes the release the latest stable build for those models. Controllers only receive it when someone starts an update from a controller or you send it from here.
    </Notice></div>
  </Modal>;
}

function DeployModal({ release, onClose, onDone }: { release: FirmwareRelease; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const targets = useLiveData<{ controllers: any[]; release: any }>(`/api/owner/firmware/${release.id}/targets`);
  const [selected, setSelected] = useState<string[]>([]);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const compatible = (targets.data?.controllers || []).filter((c) => c.compatible);
  const incompatible = (targets.data?.controllers || []).filter((c) => !c.compatible);
  const deploy = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/owner/firmware/${release.id}/deploy`,
        all ? { all_compatible: true } : { board_ids: selected });
      setResult(r); onDone();
    } catch (e: any) { toast(e.message || 'The update could not be queued', 'error'); }
    finally { setBusy(false); }
  };
  return <Modal title="Send this release to controllers" wide description={`${release.name} · ${release.version}`}
    onClose={onClose} footer={result ? <button className="btn btn-primary" onClick={onClose}>Done</button> : <>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={deploy} disabled={busy || (!all && !selected.length)}>
        {busy ? <><Icon.loader className="spinner" />Queueing…</> : `Send to ${all ? `${compatible.length} controllers` : `${selected.length || ''} controller${selected.length === 1 ? '' : 's'}`}`}
      </button></>}>
    {result ? <>
      <div className={`notice ${result.queued ? 'success' : 'warn'}`} style={{ marginBottom: 16 }}>
        <Icon.cloudOk />{result.queued} update{result.queued === 1 ? '' : 's'} queued
        {result.skipped ? `, ${result.skipped} skipped` : ''}. A controller records its own progress as it downloads, verifies and installs.
      </div>
      {(result.results || []).filter((r: any) => !r.ok).map((r: any) =>
        <div key={r.board_id} className="notice danger" style={{ marginBottom: 8 }}><Icon.fail />{r.board_id}: {r.reason}</div>)}
    </> : <>
      {targets.loading ? <Loading rows={4} shape="row" /> : <>
        <Notice tone="info">Compatibility is checked again on the server for every controller. A controller downloads the image over HTTPS and verifies the SHA-256 before installing it into the inactive slot.</Notice>
        <label className="check card card-pad" style={{ marginTop: 16, cursor: 'pointer' }}>
          <input type="checkbox" checked={all} onChange={(e) => { setAll(e.target.checked); setSelected([]); }} />
          <span style={{ flex: 1 }}><b>All compatible controllers</b>
            <span className="tiny" style={{ display: 'block' }}>{compatible.length} controller{compatible.length === 1 ? '' : 's'} can install {release.version}</span></span>
        </label>
        {!all && <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          {compatible.length ? compatible.map((c: any) => <label key={c.id} className="check card card-pad" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={selected.includes(c.id)} onChange={(e) =>
              setSelected((s) => e.target.checked ? [...s, c.id] : s.filter((x) => x !== c.id))} />
            <span style={{ flex: 1 }}><b>{c.name}</b><span className="tiny" style={{ display: 'block' }}>
              {c.chip_family || 'Unknown board'} · installed {c.installed_version || 'unknown'}
              {c.already_running ? ' · already on this version' : ''}</span></span>
            <StatusBadge status={c.status} />
          </label>) : <EmptyState icon="cpu" title="No compatible controllers"
            text="No registered controller uses a model assigned to this release. Add the model under Edit release, or pair a matching controller first." />}
        </div>}
        {incompatible.length > 0 && <div style={{ marginTop: 16 }}>
          <div className="tiny" style={{ marginBottom: 6 }}>{incompatible.length} controller{incompatible.length === 1 ? ' is' : 's are'} not offered this release:</div>
          {incompatible.slice(0, 6).map((c: any) => <div key={c.id} className="tiny">· {c.name} — {c.reason}</div>)}
        </div>}
      </>}
    </>}
  </Modal>;
}

function RetireModal({ release, onClose, onDone }: { release: FirmwareRelease; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const retire = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/owner/firmware/${release.id}/retire`, { reason: reason.trim() });
      setResult(r); onDone(); toast(`${release.version} retired`);
    } catch (e: any) { toast(e.message || 'The release could not be retired', 'error'); }
    finally { setBusy(false); }
  };
  return <Modal title={`Retire ${release.version}`} onClose={onClose}
    footer={result ? <button className="btn btn-primary" onClick={onClose}>Done</button> : <>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-danger" onClick={retire} disabled={busy || reason.trim().length < 4}>
        <Icon.archive />{busy ? 'Retiring…' : 'Retire release'}</button></>}>
    <Notice tone="danger" title="Retiring stops new installs">
      The release is archived, removed from the latest-stable answer and from the USB installer. Controllers already running it keep working, and the previous stable build becomes the rollback target.
    </Notice>
    <div style={{ marginTop: 14 }}>
      <Field label="Why is it retired?" required hint="Stored with the release and in the audit log.">
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Wi-Fi reconnects stalled after a router reboot" />
      </Field>
    </div>
    {result && <div className="notice success" style={{ marginTop: 12 }}><Icon.ok />
      Retired. {result.fallback_version ? `Controllers can fall back to ${result.fallback_version}.` : 'No earlier stable build is available for rollback.'}
    </div>}
  </Modal>;
}

function SignatureModal({ release, onClose, onDone }: { release: FirmwareRelease; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [signature, setSignature] = useState('');
  const [algorithm, setAlgorithm] = useState(release.signature_alg || 'ecdsa-p256-sha256');
  const [busy, setBusy] = useState(false);
  const attach = async () => {
    setBusy(true);
    try {
      await api.post(`/api/owner/firmware/${release.id}/signature`, { signature: signature.trim(), algorithm });
      toast('Signature attached'); onDone(); onClose();
    } catch (e: any) { toast(e.message || 'The signature was rejected', 'error'); }
    finally { setBusy(false); }
  };
  return <Modal title="Attach a detached signature" onClose={onClose} footer={<>
    <button className="btn" onClick={onClose}>Cancel</button>
    <button className="btn btn-primary" onClick={attach} disabled={busy || signature.trim().length < 40}>
      <Icon.shieldOk />{busy ? 'Attaching…' : 'Attach signature'}</button>
  </>}>
    <Notice tone="info" title="The signature covers the SHA-256 digest">
      Sign the release digest with the private key that matches the public key compiled into the firmware. Controllers check it before booting the new slot; the private key never leaves your signing machine.
    </Notice>
    <div className="code" style={{ margin: '14px 0' }}>SHA-256 {release.sha256}</div>
    <Field label="Algorithm"><select className="select" value={algorithm} onChange={(e) => setAlgorithm(e.target.value)}>
      <option value="ecdsa-p256-sha256">ECDSA P-256 / SHA-256</option>
      <option value="ed25519">Ed25519</option>
    </select></Field>
    <Field label="Signature" required hint="Base64 signature of the digest above.">
      <textarea className="textarea mono" value={signature} onChange={(e) => setSignature(e.target.value)}
        placeholder="MEUCIQ…" rows={4} />
    </Field>
    {release.signature && <div className="tiny">A signature is already attached ({release.signature_alg}); attaching another replaces it.</div>}
  </Modal>;
}

function ReleaseDetail({ release, controllers, history, catalog, onClose, onChanged }: {
  release: FirmwareRelease; controllers: OwnerFirmwareOverview['controllers']; history: UpdateHistoryRow[];
  catalog: OwnerFirmwareOverview['board_catalog']; onClose: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const readiness = publishReadiness(release);
  const image = release.verification_detail?.image;
  const installed = controllers.filter((c) => c.firmware_version === release.version);
  const boardNames = (release.board_models || []).map((id) =>
    catalog.find((b) => b.id === id)?.model || id);
  const rows = useMemo(() => history.filter((h) => h.release_id === release.id), [history, release.id]);
  const [signing, setSigning] = useState(false);
  const change = async (status: string) => {
    try {
      await api.post(`/api/owner/firmware/${release.id}/status`, { status });
      toast(status === 'archived' ? 'Release archived' : status === 'published' ? 'Release published' : 'Release moved back to draft');
      onChanged(); onClose();
    } catch (e: any) { toast(e.message || 'The status could not be changed', 'error'); }
  };
  return <Modal title={`${release.name} · ${release.version}`} wide onClose={onClose}
    description={release.description || undefined}
    footer={<>
      {release.status !== 'archived' && <button className="btn" onClick={() => change('archived')}><Icon.archive />Archive</button>}
      <button className="btn" onClick={() => setSigning(true)}><Icon.shieldOk />Signature</button>
      <button className="btn" onClick={onClose}>Close</button>
    </>}>
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <div>
        <div className="kv">
          <dt>Status</dt><dd><StatusBadge status={release.status} /> {release.status === 'published' ? `since ${timeAgo(release.published_at)}` : ''}</dd>
          <dt>Channel</dt><dd>{release.channel}</dd>
          <dt>Update type</dt><dd>{releaseKindLabel(release.artifact_kind)}</dd>
          {/* The address the installer writes this image at. Shown so a wrong value
              is visible here instead of surfacing as a failed flash or a rejected
              insert. It is stored per artifact, not shared between them. */}
          <dt>Written at</dt><dd className="mono">{release.flash_offset === null || release.flash_offset === undefined
            ? <span style={{ color: 'var(--danger)' }}>not recorded</span>
            : `0x${Number(release.flash_offset).toString(16)}`}</dd>
          <dt>Size</dt><dd>{fmtBytes(release.size_bytes)}</dd>
          <dt>Version in image</dt><dd className="mono">{image?.appVersion || 'not reported'}</dd>
          <dt>Project</dt><dd className="mono">{image?.projectName || '—'}</dd>
          <dt>IDF</dt><dd className="mono">{image?.idfVersion || '—'}</dd>
          <dt>Stored in</dt><dd>{release.storage_backend === 'r2' ? 'Cloudflare R2 (private)' : 'Supabase Storage (private)'}</dd>
          <dt>Downloads</dt><dd>{release.downloads}</dd>
        </div>
        <div className="code" style={{ marginTop: 12, wordBreak: 'break-all' }}>SHA-256 {release.sha256}</div>
        {release.signature
          ? <div style={{ marginTop: 10 }}><Badge tone="on" icon="shieldOk">Signed · {release.signature_alg} · {timeAgo(release.signed_at)}</Badge></div>
          : <div style={{ marginTop: 10 }}><Badge tone="warn" icon="alert">No detached signature</Badge></div>}
      </div>
      <div>
        <h4 style={{ fontSize: 13, marginBottom: 8 }}>Compatibility</h4>
        <div style={{ display: 'grid', gap: 4 }}>
          {(boardNames.length ? boardNames : ['No controller model assigned']).map((n) => <div key={n} className="tiny">· {n}</div>)}
        </div>
        <div className="tiny" style={{ marginTop: 6 }}>{installed.length} controller{installed.length === 1 ? '' : 's'} currently report this version.</div>
        <div className="divider" />
        <h4 style={{ fontSize: 13, marginBottom: 8 }}>Before publishing</h4>
        <div style={{ display: 'grid', gap: 6 }}>
          {readiness.checks.map((c) => <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {c.ok ? <Icon.check /> : <Icon.alert />}<span className="tiny">{c.label}</span>
          </div>)}
        </div>
        {release.status === 'draft' && <div style={{ marginTop: 12 }}>
          <button className="btn btn-primary btn-block" disabled={!readiness.ready} onClick={() => change('published')}>
            <Icon.cloudUp />Publish
          </button>
          {!readiness.ready && <div className="tiny" style={{ marginTop: 6 }}>Blocked by: {readiness.blockers.join(', ')}</div>}
        </div>}
      </div>
    </div>
    <div className="divider" />
    <h4 style={{ fontSize: 13, marginBottom: 8 }}>Update results for this release</h4>
    {rows.length ? <DataTable columns={[
      { key: 'board_name', label: 'Controller', render: (h) => <span>{h.board_name || 'Removed controller'} <span className="tiny">· {h.tenant_name}</span></span> },
      { key: 'started_at', label: 'Started', render: (h) => <span className="tiny">{timeFull(h.started_at)}</span> },
      { key: 'progress', label: 'Progress', render: (h) => <div style={{ width: 90 }}><Progress value={h.progress || 0}
        tone={h.status === 'failed' ? 'danger' : h.status === 'success' ? 'on' : 'warn'} /></div> },
      { key: 'status', label: 'Result', render: (h) => <StatusBadge status={h.status} /> },
      { key: 'error', label: 'Detail', render: (h) => <span className="tiny">{h.error || '—'}</span> },
    ]} rows={rows} empty={null} /> : <div className="tiny">No controller has reported an update for this release yet.</div>}
    {signing && <SignatureModal release={release} onClose={() => setSigning(false)} onDone={onChanged} />}
  </Modal>;
}

export function OwnerFirmware() {
  const { data, loading, error, refresh } = useLiveData<OwnerFirmwareOverview>('/api/owner/firmware');
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [channel, setChannel] = useState('all');
  const [upload, setUpload] = useState(false);
  const [uploadPackage, setUploadPackage] = useState(false);
  const [edit, setEdit] = useState<FirmwareRelease | null>(null);
  const [deploy, setDeploy] = useState<FirmwareRelease | null>(null);
  const [publish, setPublish] = useState<FirmwareRelease | null>(null);
  const [retire, setRetire] = useState<FirmwareRelease | null>(null);
  const [detail, setDetail] = useState<FirmwareRelease | null>(null);
  const [confirm, setConfirm] = useState<FirmwareRelease | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<any>(null);

  const releases = data?.releases || [];
  const history = data?.history || [];
  const catalog = data?.board_catalog || [];
  const controllers = data?.controllers || [];
  const storage = data?.storage || { backend: 'none', connected: false };
  const filtered = releases.filter((r) => {
    const q = search.toLowerCase();
    return (!q || `${r.name} ${r.version} ${r.description || ''} ${r.sha256}`.toLowerCase().includes(q))
      && (status === 'all' || r.status === status)
      && (channel === 'all' || r.channel === channel);
  });
  const latestStable = releases.find((r) => r.status === 'published' && r.channel === 'stable');
  const totals = releases.reduce((a, r) => ({
    successful: a.successful + (r.successful || 0), failed: a.failed + (r.failed || 0),
    pending: a.pending + (r.pending || 0),
  }), { successful: 0, failed: 0, pending: 0 });
  const needingAttention = controllers.filter((c) =>
    c.firmware_version && latestStable && c.firmware_version !== latestStable.version);

  const remove = async () => {
    if (!confirm || typed !== 'DELETE') return;
    setBusy(confirm.id);
    try {
      await api.del(`/api/owner/firmware/${confirm.id}?confirm=DELETE`);
      toast('Release and stored binary deleted'); setConfirm(null); setTyped(''); refresh();
    } catch (e: any) { toast(e.message || 'Deletion failed', 'error'); }
    finally { setBusy(null); }
  };
  const runTest = async () => {
    setBusy('storage'); setTest(null);
    try {
      const r = await api.post('/api/owner/firmware/test-storage', {});
      setTest(r); refresh();
      toast(r.connected ? 'Storage upload and download verified' : r.detail, r.connected ? 'ok' : 'error');
    } catch (e: any) { toast(e.message || 'The storage test failed', 'error'); }
    finally { setBusy(null); }
  };

  return <>
    <PageHead title="Firmware management" eyebrow="Owner console"
      desc="One verified image per version, used by both the in-browser USB installer and controller over-the-air updates."
      actions={<>
        <button className="btn" onClick={runTest} disabled={busy === 'storage'} aria-busy={busy === 'storage' || undefined}>
          <Icon.refresh />{busy === 'storage' ? 'Testing…' : 'Test storage'}</button>
        <button className="btn" onClick={() => setUpload(true)}><Icon.upload />Upload single image</button>
        <button className="btn btn-primary" onClick={() => setUploadPackage(true)}><Icon.cloudUp />Upload release package</button>
      </>} />

    <div className="grid grid-4" style={{ marginBottom: 16 }}>
      <Card title="Latest stable" icon="layers">
        {latestStable ? <div>
          <div className="stat-value mono" style={{ fontSize: 22 }}>{latestStable.version}</div>
          <div className="tiny">{latestStable.name} · {fmtBytes(latestStable.size_bytes)} · {timeAgo(latestStable.published_at)}</div>
          <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Badge tone={latestStable.signature ? 'on' : 'warn'} icon="shieldOk">{latestStable.signature ? 'Signed' : 'Unsigned'}</Badge>
            <Badge tone="on">{latestStable.board_models.length} model(s)</Badge>
          </div>
        </div> : <EmptyState icon="layers" title="Nothing published" text="Publish a release to offer it to controllers and the USB installer." />}
      </Card>
      <Card title="Successful updates" icon="ok">
        <div className="stat-value" style={{ color: 'var(--state-on)' }}>{totals.successful}</div>
        <div className="tiny">Confirmed by controllers</div></Card>
      <Card title="Failed or rolled back" icon="fail">
        <div className="stat-value" style={{ color: 'var(--state-danger)' }}>{totals.failed}</div>
        <div className="tiny">Needs investigation</div></Card>
      <Card title="Storage" icon="cloudUp">
        <Badge tone={storage.connected ? 'on' : 'warn'} icon={storage.connected ? 'cloudOk' : 'cloudOff'}>
          {storage.connected ? 'Verified' : 'Not verified'}</Badge>
        <div className="tiny" style={{ marginTop: 8 }}>{storage.backend === 'r2' ? 'Cloudflare R2 · private bucket'
          : storage.backend === 'supabase' ? 'Supabase Storage · private bucket' : 'No storage configured'}</div>
        {test && <div className={`notice ${test.connected ? 'success' : 'danger'}`} style={{ marginTop: 8 }}><Icon.info />{test.detail}</div>}
      </Card>
    </div>

    {error && <div style={{ marginBottom: 16 }}><div className="notice danger"><Icon.fail />{error}
      <button className="btn btn-sm" onClick={refresh}><Icon.retry />Try again</button></div></div>}

    {needingAttention.length > 0 && <div style={{ marginBottom: 16 }}><Notice tone="info" title={`${needingAttention.length} controller(s) are not on the latest stable build`}>
      {needingAttention.slice(0, 4).map((c) => `${c.name} (${c.firmware_version || 'unknown'})`).join(' · ')}
      {needingAttention.length > 4 ? ` and ${needingAttention.length - 4} more` : ''}. Use Assign next to a release, or let the customer start the update from their controller page.
    </Notice></div>}

    <Card title="Releases" sub="Metadata in Supabase PostgreSQL · binaries in private storage" pad={false} icon="layers">
      <div className="card-pad filter-bar">
        <div className="search"><Icon.search /><input className="input" placeholder="Search name, version or checksum"
          value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <select className="select" style={{ width: 170 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All statuses</option><option value="draft">Drafts</option>
          <option value="published">Published</option><option value="archived">Archived</option></select>
        <select className="select" style={{ width: 160 }} value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="all">All channels</option>{CHANNELS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
        <span className="tiny">{filtered.length} of {releases.length}</span>
      </div>
      {loading ? <div className="card-pad"><Loading rows={4} shape="table" /></div>
        : <DataTable columns={[
          { key: 'name', label: 'Release', render: (r) => <div>
            <button className="btn btn-sm" style={{ padding: 0, border: 0, background: 'none', fontWeight: 700 }}
              onClick={() => setDetail(r)}>{r.name}</button>
            <div className="tiny mono">{r.version} · {r.channel} · {r.artifact_kind === 'factory' ? 'USB' : 'OTA'}</div></div> },
          { key: 'size', label: 'Size', render: (r) => <span className="tiny">{fmtBytes(r.size_bytes)}<br />{r.size_bytes > 3 * 1024 * 1024 ? <Badge tone="danger">Too large</Badge> : null}</span> },
          { key: 'boards', label: 'Models', render: (r) => <span className="tiny">{r.board_models.length}</span> },
          { key: 'verified', label: 'Validation', render: (r) => <div style={{ display: 'grid', gap: 4 }}>
            <Badge tone={r.artifact_verified ? 'on' : 'danger'} icon={r.artifact_verified ? 'check' : 'fail'}>{r.artifact_verified ? 'Verified' : 'Failed'}</Badge>
            <Badge tone={r.signature ? 'on' : 'warn'} icon="shieldOk">{r.signature ? 'Signed' : 'Unsigned'}</Badge></div> },
          { key: 'deploy', label: 'Installs', render: (r) => <span className="tiny">
            <span style={{ color: 'var(--state-on)' }}>{r.successful} ok</span> · <span style={{ color: 'var(--state-danger)' }}>{r.failed} failed</span> · {r.pending} pending</span> },
          { key: 'status', label: 'Status', render: (r) => <div><StatusBadge status={r.status} />
            <div className="tiny">{r.status === 'published' ? timeAgo(r.published_at) : r.status === 'archived' ? timeAgo(r.archived_at) : timeAgo(r.created_at)}</div></div> },
          { key: 'actions', label: '', render: (r) => <div className="row-actions">
            <button className="btn btn-sm" onClick={() => setEdit(r)} title="Edit details"><Icon.edit /></button>
            {r.status === 'draft' && <button className="btn btn-sm" onClick={() => setPublish(r)} title="Publish"><Icon.cloudUp />Publish</button>}
            {r.status === 'published' && <>
              <button className="btn btn-sm" onClick={() => setDeploy(r)} title="Send to controllers"><Icon.upload />Assign</button>
              <button className="btn btn-sm" onClick={() => setRetire(r)} title="Retire"><Icon.archive /></button>
            </>}
            {r.status === 'draft' && <button className="btn btn-sm" disabled={busy === r.id}
              onClick={async () => { try { await api.post(`/api/owner/firmware/${r.id}/status`, { status: 'archived' }); toast('Release archived'); refresh(); } catch (e: any) { toast(e.message, 'error'); } }}
              title="Archive draft"><Icon.archive /></button>}
            <button className="btn btn-sm" onClick={() => window.open(`/api/owner/firmware/download/${r.id}`, '_blank', 'noopener')}
              title="Download the exact stored binary"><Icon.download /></button>
            <button className="btn btn-sm btn-danger" onClick={() => { setConfirm(r); setTyped(''); }} title="Delete"><Icon.trash /></button>
          </div> },
        ]} rows={filtered} empty={<EmptyState icon="cloudUp" title="No firmware releases yet"
          text="Build an image with the firmware workflow, then upload it here to publish it for USB and over-the-air installation."
          action={<button className="btn btn-primary" onClick={() => setUpload(true)}><Icon.plus />Upload firmware</button>} />} />}
    </Card>

    <div className="grid grid-2" style={{ marginTop: 16, alignItems: 'start' }}>
      <Card title="Controllers" sub="Installed version reported by each device" icon="circuitry" pad={false}>
        {loading ? <div className="card-pad"><Loading rows={3} shape="row" /></div>
          : <DataTable columns={[
            { key: 'name', label: 'Controller', render: (b) => <div><div style={{ fontWeight: 600 }}>{b.name}</div>
              <div className="tiny">{b.tenant_name}</div></div> },
            { key: 'chip', label: 'Model', render: (b) => <span className="tiny">{b.chip_family || b.catalog_board_id || 'Unknown'}</span> },
            { key: 'version', label: 'Installed', render: (b) => <span className="mono tiny">{b.firmware_version || 'Not reported'}</span> },
            { key: 'state', label: 'Update', render: (b) => {
              if (!b.firmware_version) return <Badge tone="warn">Unknown</Badge>;
              if (!latestStable) return <Badge>No stable release</Badge>;
              return b.firmware_version === latestStable.version
                ? <Badge tone="on" icon="check">Current</Badge>
                : <Badge tone="warn" icon="alert">Update available</Badge>;
            } },
            { key: 'status', label: 'Link', render: (b) => <div><StatusBadge status={b.status} />
              <div className="tiny">{timeAgo(b.last_seen_at)}</div></div> },
          ]} rows={controllers} empty={<EmptyState icon="cpu" title="No controllers"
            text="Controllers appear here after a customer completes device setup." />} />}
      </Card>
      <Card title="Update history" sub="Progress and results reported by controllers" icon="clock" pad={false}>
        {loading ? <div className="card-pad"><Loading rows={4} shape="table" /></div>
          : <DataTable columns={[
            { key: 'started_at', label: 'Started', render: (h) => <span className="tiny">{timeFull(h.started_at)}</span> },
            { key: 'board', label: 'Controller', render: (h) => <div><div style={{ fontWeight: 600 }}>{h.board_name || 'Removed controller'}</div>
              <div className="tiny">{h.tenant_name}</div></div> },
            { key: 'version', label: 'Update', render: (h) => <span className="mono tiny">{h.from_version || '—'} → {h.to_version}</span> },
            { key: 'progress', label: 'Progress', render: (h) => <div style={{ width: 90 }}>
              <Progress value={h.progress} tone={h.status === 'failed' ? 'danger' : h.status === 'success' ? 'on' : 'warn'} /></div> },
            { key: 'status', label: 'Result', render: (h) => <StatusBadge status={h.status} /> },
            { key: 'error', label: 'Detail', render: (h) => <span className="tiny">{h.error || (h.finished_at ? timeAgo(h.finished_at) : '—')}</span> },
          ]} rows={history} empty={<EmptyState icon="clock" title="No updates yet"
            text="Queued, failed and finished updates appear here as controllers report them." />} />}
      </Card>
    </div>

    {uploadPackage && data && <PackageUploadModal data={data} onClose={() => setUploadPackage(false)} onDone={refresh} />}
    {upload && <UploadModal catalog={catalog} limits={data!.limits} onClose={() => setUpload(false)} onDone={refresh} />}
    {edit && <EditModal release={edit} catalog={catalog} onClose={() => setEdit(null)} onDone={refresh} />}
    {deploy && <DeployModal release={deploy} onClose={() => setDeploy(null)} onDone={refresh} />}
    {publish && <PublishModal release={publish} onClose={() => setPublish(null)} onDone={refresh} />}
    {retire && <RetireModal release={retire} onClose={() => setRetire(null)} onDone={refresh} />}
    {detail && <ReleaseDetail release={detail} controllers={controllers} history={history} catalog={catalog}
      onClose={() => setDetail(null)} onChanged={refresh} />}
    {confirm && <Modal title="Delete firmware release" onClose={() => setConfirm(null)} footer={<>
      <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
      <button className="btn btn-danger" onClick={remove} disabled={typed !== 'DELETE' || busy === confirm.id}>
        <Icon.trash />{busy === confirm.id ? 'Deleting…' : 'Delete permanently'}</button>
    </>}>
      <Notice tone="danger" title="This removes the stored binary">
        The release metadata and the file are deleted together and the version can be reused. Update history is kept. Retire a release you may need again; delete only builds that should never be installed.
      </Notice>
      <div className="kv" style={{ margin: '16px 0' }}>
        <dt>Release</dt><dd>{confirm.name}</dd><dt>Version</dt><dd className="mono">{confirm.version}</dd>
        <dt>Size</dt><dd>{fmtBytes(confirm.size_bytes)}</dd>
      </div>
      <Field label="Type DELETE to confirm"><input className="input mono" value={typed}
        onChange={(e) => setTyped(e.target.value)} placeholder="DELETE" /></Field>
    </Modal>}
  </>;
}
