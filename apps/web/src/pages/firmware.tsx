/** Owner Console — Firmware management over the native private R2 binding. */
import React, { useMemo, useState } from 'react';
import { api, useLiveData } from '../api';
import { useAuth } from '../state';
import {
  Badge, Card, DataTable, EmptyState, Field, Icon, Loading, Modal, Notice,
  PageHead, Progress, StatusBadge, fmtBytes, timeFull, timeAgo,
} from '../components';

type Release = {
  id: string; name: string; description?: string; version: string; channel: string;
  chip_family: string; board_models: string[]; storage_backend: string;
  size_bytes: number; sha256: string; status: string; checksum_verified: boolean;
  created_at: string; updated_at: string; published_at?: string; archived_at?: string;
  deployments: number; successful: number; failed: number; pending: number;
};

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

function UploadModal({ catalog, limits, onClose, onDone }: {
  catalog: any[]; limits: any; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', version: '', description: '', channel: 'stable', status: 'draft' });
  const [boards, setBoards] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [digest, setDigest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const maxBytes = Number(limits?.max_bytes || 16 * 1024 * 1024);
  const choose = async (next: File | null) => {
    setError(''); setFile(next); setDigest('');
    if (!next) return;
    if (!/\.(bin|elf|img)$/i.test(next.name)) { setError('Choose a .bin, .elf or .img firmware file.'); setFile(null); return; }
    if (next.size > maxBytes) { setError(`The file is larger than ${fmtBytes(maxBytes)}. Choose a smaller build.`); setFile(null); return; }
    if (!next.size) { setError('This file is empty.'); setFile(null); return; }
    try { setDigest(await sha256Browser(next)); }
    catch { setError('Could not calculate the file checksum in this browser.'); setFile(null); }
  };
  const save = async () => {
    if (!f.name.trim() || !f.version.trim()) { setError('Add a name and a version.'); return; }
    if (!file) { setError('Choose a firmware file.'); return; }
    if (f.status === 'published' && !boards.length) { setError('Select compatible boards before publishing.'); return; }
    setBusy(true); setError('');
    try {
      await api.post('/api/owner/firmware/upload', {
        name: f.name.trim(), version: f.version.trim(), description: f.description.trim(),
        channel: f.channel, status: f.status, board_models: boards,
        filename: file.name, size_bytes: file.size, sha256: digest,
        binary_base64: await toBase64(file),
      });
      toast('Firmware uploaded and checksum verified'); onDone(); onClose();
    } catch (e: any) { setError(e.message || 'The upload failed.'); }
    finally { setBusy(false); }
  };
  return <Modal title="Upload firmware" description="The binary goes to your private R2 bucket through the Pages binding. Only its checksum and details are stored in the database."
    onClose={onClose} wide footer={<>
      <button className="btn" onClick={onClose} disabled={busy} aria-busy={busy || undefined}>Cancel</button>
      <button className="btn btn-primary" onClick={save} disabled={busy || !digest}>
        {busy ? <><Icon.loader className="spinner" />Uploading…</> : <><Icon.cloudUp />Upload firmware</>}
      </button>
    </>}>
    {error && <div className="notice danger" style={{ marginBottom: 16 }}><Icon.fail />{error}</div>}
    <div className="form-row">
      <Field label="Release name" required error={undefined}><input className="input" value={f.name}
        onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Living room controller build" /></Field>
      <Field label="Version" required><input className="input mono" value={f.version}
        onChange={(e) => setF({ ...f, version: e.target.value })} placeholder="1.2.0" /></Field>
    </div>
    <Field label="Description" hint="What changed, and which controllers should install it.">
      <textarea className="textarea" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })}
        placeholder="Fixes the reconnect timer and adds support for the board's second ADC channel." /></Field>
    <div className="form-row">
      <Field label="Channel"><select className="select" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
        <option value="stable">Stable</option><option value="beta">Beta</option><option value="dev">Development</option>
      </select></Field>
      <Field label="After upload"><select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
        <option value="draft">Save as draft</option><option value="published">Publish now</option>
      </select></Field>
    </div>
    <Field label="Firmware file" hint={`.bin, .elf or .img · up to ${fmtBytes(maxBytes)} · SHA-256 is calculated here and checked again on the server`}>
      <input className="input" type="file" accept=".bin,.elf,.img" onChange={(e) => choose(e.target.files?.[0] || null)} />
    </Field>
    {file && <div className="card card-pad" style={{ marginBottom: 16, display: 'grid', gap: 6 }}>
      <div className="tiny">{file.name} · {fmtBytes(file.size)}</div>
      <div className="mono tiny" style={{ wordBreak: 'break-all' }}>SHA-256 {digest || 'calculating…'}</div>
      {digest && <Badge tone="on" icon="shieldOk">Checksum ready</Badge>}
    </div>}
    <Field label="Compatible ESP32 board models" hint="Only boards in this list can be assigned this release. Hold Ctrl or Cmd to select several.">
      <select className="select" multiple size={Math.min(6, Math.max(3, catalog.length))} value={boards}
        onChange={(e) => setBoards(Array.from(e.target.selectedOptions).map((o) => o.value))}>
        {catalog.map((b) => <option key={b.id} value={b.id}>{b.manufacturer} {b.model} · {b.chip_family}</option>)}
      </select>
    </Field>
    {boards.length > 0 && <div className="tiny">Selected: {boards.length} board{boards.length === 1 ? '' : 's'}</div>}
  </Modal>;
}

function EditModal({ release, catalog, onClose, onDone }: { release: Release; catalog: any[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: release.name || '', version: release.version, description: release.description || '', channel: release.channel });
  const [boards, setBoards] = useState<string[]>(release.board_models || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (!f.name.trim() || !f.version.trim()) { setError('A name and version are required.'); return; }
    setBusy(true); setError('');
    try {
      await api.patch(`/api/owner/firmware/${release.id}`, { ...f, board_models: boards });
      toast('Release details saved'); onDone(); onClose();
    } catch (e: any) { setError(e.message || 'Could not save the release.'); }
    finally { setBusy(false); }
  };
  return <Modal title="Edit release" description={`Version ${release.version} · ${fmtBytes(release.size_bytes)}`}
    onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={save} disabled={busy} aria-busy={busy || undefined}>{busy ? 'Saving…' : 'Save changes'}</button></>}>
    {error && <div className="notice danger" style={{ marginBottom: 16 }}><Icon.fail />{error}</div>}
    <div className="form-row">
      <Field label="Release name" required><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Version" required><input className="input mono" value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} /></Field>
    </div>
    <Field label="Description"><textarea className="textarea" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    <Field label="Channel"><select className="select" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
      <option value="stable">Stable</option><option value="beta">Beta</option><option value="dev">Development</option></select></Field>
    <Field label="Compatible boards"><select className="select" multiple size={Math.min(6, Math.max(3, catalog.length))}
      value={boards} onChange={(e) => setBoards(Array.from(e.target.selectedOptions).map((o) => o.value))}>
      {catalog.map((b) => <option key={b.id} value={b.id}>{b.manufacturer} {b.model} · {b.chip_family}</option>)}
    </select></Field>
    <div className="code" style={{ marginTop: 8 }}>SHA-256 {release.sha256}</div>
  </Modal>;
}

function DeployModal({ release, catalog, controllers, onClose, onDone }: {
  release: Release; catalog: any[]; controllers: any[]; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const compatible = useMemo(() => controllers.filter((b) =>
    (release.board_models || []).includes(b.catalog_board_id)
    || (release.board_models || []).includes(
      catalog.find((c) => c.id === b.catalog_board_id)?.chip_family)), [controllers, catalog, release]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const deploy = async () => {
    setBusy(true);
    try { const r = await api.post(`/api/owner/firmware/${release.id}/deploy`, { board_ids: selected }); setResult(r); onDone(); }
    catch (e: any) { toast(e.message || 'The update could not be queued', 'error'); }
    finally { setBusy(false); }
  };
  return <Modal title="Assign firmware to controllers" description={`${release.name} · ${release.version}`} onClose={onClose}
    footer={result ? <button className="btn btn-primary" onClick={onClose}>Done</button> : <>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={deploy} disabled={busy || !selected.length}>
        {busy ? <><Icon.loader className="spinner" />Sending…</> : `Send update to ${selected.length || ''} controller${selected.length === 1 ? '' : 's'}`}
      </button></>}>
    {result ? <>
      <div className={`notice ${result.queued ? 'success' : 'warn'}`} style={{ marginBottom: 16 }}>
        <Icon.cloudOk />{result.queued} update{result.queued === 1 ? '' : 's'} queued. Real progress appears in Update history as each controller reports back.
      </div>
      {(result.results || []).filter((r: any) => !r.ok).map((r: any) =>
        <div key={r.board_id} className="notice danger" style={{ marginBottom: 8 }}><Icon.fail />{r.name || r.board_id}: {r.reason}</div>)}
    </> : <>
      <Notice title="Only compatible controllers are shown">Assignment is checked again on the server. Each controller receives a short-lived, signed download link and verifies the SHA-256 checksum before installing.</Notice>
      {!compatible.length ? <div style={{ marginTop: 16 }}><EmptyState icon="cpu" title="No compatible controllers"
        text="No registered controller uses a board model assigned to this release. Add board compatibility in Edit release, or pair a matching controller first." /></div>
        : <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
          {compatible.map((b) => <label key={b.id} className="check card card-pad" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={selected.includes(b.id)} onChange={(e) =>
              setSelected((s) => e.target.checked ? [...s, b.id] : s.filter((x) => x !== b.id))} />
            <span style={{ flex: 1 }}><b>{b.name}</b><span className="tiny" style={{ display: 'block' }}>
              {b.tenant_name} · {b.chip_family || b.catalog_board_id} · installed {b.firmware_version || 'unknown'}</span></span>
            <StatusBadge status={b.status} />
          </label>)}
        </div>}
    </>}
  </Modal>;
}

export function OwnerFirmware() {
  const { data, loading, error, refresh } = useLiveData<any>('/api/owner/firmware');
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [channel, setChannel] = useState('all');
  const [upload, setUpload] = useState(false);
  const [edit, setEdit] = useState<Release | null>(null);
  const [deploy, setDeploy] = useState<Release | null>(null);
  const [confirm, setConfirm] = useState<Release | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<any>(null);

  const releases: Release[] = data?.releases || [];
  const history: any[] = data?.history || [];
  const catalog: any[] = data?.board_catalog || [];
  const controllers: any[] = data?.controllers || [];
  const storage = data?.storage || {};
  const filtered = releases.filter((r) => {
    const q = search.toLowerCase();
    return (!q || `${r.name} ${r.version} ${r.description || ''} ${r.sha256}`.toLowerCase().includes(q))
      && (status === 'all' || r.status === status)
      && (channel === 'all' || r.channel === channel);
  });
  const totals = releases.reduce((a, r) => ({
    successful: a.successful + (r.successful || 0), failed: a.failed + (r.failed || 0),
    pending: a.pending + (r.pending || 0),
  }), { successful: 0, failed: 0, pending: 0 });

  const changeStatus = async (r: Release, next: string) => {
    setBusy(r.id);
    try { await api.post(`/api/owner/firmware/${r.id}/status`, { status: next });
      toast(next === 'published' ? 'Release published' : next === 'archived' ? 'Release archived' : 'Release unpublished');
      refresh(); }
    catch (e: any) { toast(e.message || 'Could not change the status', 'error'); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    if (!confirm || typed !== 'DELETE') return;
    setBusy(confirm.id);
    try { await api.del(`/api/owner/firmware/${confirm.id}?confirm=DELETE`);
      toast('Release and stored binary deleted'); setConfirm(null); setTyped(''); refresh(); }
    catch (e: any) { toast(e.message || 'Deletion failed', 'error'); }
    finally { setBusy(null); }
  };
  const runTest = async () => {
    setBusy('storage'); setTest(null);
    try { const r = await api.post('/api/owner/firmware/test-storage', {}); setTest(r); refresh();
      toast(r.connected ? 'R2 upload and download verified' : r.detail, r.connected ? 'ok' : 'error'); }
    catch (e: any) { toast(e.message || 'The storage test failed', 'error'); }
    finally { setBusy(null); }
  };

  return <>
    <PageHead title="Firmware management" eyebrow="Owner console"
      desc="Store firmware in a private Cloudflare R2 bucket, publish versions and follow real update results on customer controllers."
      actions={<>
        <button className="btn" onClick={runTest} disabled={busy === 'storage'} aria-busy={busy === 'storage' || undefined}>
          <Icon.refresh />{busy === 'storage' ? 'Testing…' : 'Test R2 binding'}</button>
        <button className="btn btn-primary" onClick={() => setUpload(true)}><Icon.cloudUp />Upload firmware</button>
      </>} />

    <div className="grid grid-4" style={{ marginBottom: 16 }}>
      <Card title="Private storage" icon="cloudUp">
        <div style={{ display: 'grid', gap: 8 }}>
          <Badge tone={storage.connected ? 'on' : storage.r2_configured ? 'warn' : 'danger'} icon={storage.connected ? 'cloudOk' : 'cloudOff'}>
            {storage.connected ? 'Verified' : storage.r2_configured ? 'Not verified' : 'R2 binding missing'}</Badge>
          <div className="tiny">{storage.backend === 'r2' ? 'Cloudflare R2 · FIRMWARE_BUCKET Pages binding · private'
            : 'Supabase Storage fallback · add the FIRMWARE_BUCKET R2 binding to switch'}</div>
          {storage.last_test && <div className="tiny">Last check: {timeAgo(storage.last_test.checked_at)} · {storage.last_test.detail}</div>}
          {test && <div className={`notice ${test.connected ? 'success' : 'danger'}`}><Icon.info />{test.detail}</div>}
        </div>
      </Card>
      <Card title="Successful updates" icon="ok"><div className="stat-value" style={{ color: 'var(--state-on)' }}>{totals.successful}</div><div className="tiny">Reported by controllers</div></Card>
      <Card title="Failed updates" icon="fail"><div className="stat-value" style={{ color: 'var(--state-danger)' }}>{totals.failed}</div><div className="tiny">Needs investigation</div></Card>
      <Card title="In progress" icon="timer"><div className="stat-value" style={{ color: 'var(--state-warn)' }}>{totals.pending}</div><div className="tiny">Queued, downloading, installing or verifying</div></Card>
    </div>

    {!storage.connected && <div style={{ marginBottom: 16 }}><Notice tone="warn" title="R2 is not confirmed as connected">
      Attach the <code>FIRMWARE_BUCKET</code> R2 bucket binding in Cloudflare Pages → Settings → Functions, redeploy, then run the upload/download test. Until that real round trip succeeds no verified status is shown. Firmware currently uses private Supabase Storage.
    </Notice></div>}

    {error && <div style={{ marginBottom: 16 }}><div className="notice danger"><Icon.fail />{error} <button className="btn btn-sm" onClick={refresh}><Icon.retry />Try again</button></div></div>}

    <Card title="Firmware releases" sub="Metadata in Supabase PostgreSQL · binaries in private R2" pad={false} icon="layers">
      <div className="card-pad filter-bar">
        <div className="search"><Icon.search /><input className="input" placeholder="Search name, version or checksum"
          value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <select className="select" style={{ width: 170 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All statuses</option><option value="draft">Draft</option>
          <option value="published">Published</option><option value="archived">Archived</option></select>
        <select className="select" style={{ width: 160 }} value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="all">All channels</option><option value="stable">Stable</option>
          <option value="beta">Beta</option><option value="dev">Development</option></select>
        <span className="tiny">{filtered.length} of {releases.length}</span>
      </div>
      {loading ? <div className="card-pad"><Loading rows={4} shape="table" /></div>
        : <DataTable columns={[
          { key: 'name', label: 'Release', render: (r) => <div><div style={{ fontWeight: 700 }}>{r.name}</div>
            <div className="tiny mono">{r.version} · {r.channel}</div></div> },
          { key: 'size', label: 'Size', render: (r) => fmtBytes(r.size_bytes) },
          { key: 'uploaded', label: 'Uploaded', render: (r) => <span className="tiny">{timeAgo(r.created_at)}</span> },
          { key: 'sha256', label: 'Checksum', render: (r) => <span className="mono tiny">{r.sha256?.slice(0, 12)}…</span> },
          { key: 'boards', label: 'Boards', render: (r) => <span className="tiny">{(r.board_models || []).length || 'None'}</span> },
          { key: 'deploy', label: 'Updates', render: (r) => <span className="tiny">
            <span style={{ color: 'var(--state-on)' }}>{r.successful || 0} ok</span> · <span style={{ color: 'var(--state-danger)' }}>{r.failed || 0} failed</span> · {r.pending || 0} pending</span> },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          { key: 'actions', label: '', render: (r) => <div className="row-actions">
            <button className="btn btn-sm" onClick={() => setEdit(r)} title="Edit details"><Icon.edit />Edit</button>
            {r.status === 'published'
              ? <button className="btn btn-sm" disabled={busy === r.id} onClick={() => changeStatus(r, 'draft')}>Unpublish</button>
              : <button className="btn btn-sm" disabled={busy === r.id} onClick={() => changeStatus(r, 'published')}><Icon.cloudUp />Publish</button>}
            {r.status !== 'archived' && <button className="btn btn-sm" disabled={busy === r.id} onClick={() => changeStatus(r, 'archived')}>Archive</button>}
            <button className="btn btn-sm" onClick={() => window.open(`/api/owner/firmware/download/${r.id}`, '_blank', 'noopener')} title="Download binary"><Icon.download /></button>
            <button className="btn btn-sm btn-danger" onClick={() => { setConfirm(r); setTyped(''); }}><Icon.trash /></button>
          </div> },
        ]} rows={filtered} empty={<EmptyState icon="cloudUp" title="No firmware releases yet"
          text="Upload a firmware build to start managing versions, board compatibility and controller updates."
          action={<button className="btn btn-primary" onClick={() => setUpload(true)}><Icon.plus />Upload firmware</button>} />} />
      }
    </Card>

    <div className="grid grid-2" style={{ marginTop: 16, alignItems: 'start' }}>
      <Card title="Assign an update" sub="Published releases, compatible controllers only" icon="cpu">
        {!releases.filter((r) => r.status === 'published').length
          ? <EmptyState icon="download" title="Nothing to assign" text="Publish a release with compatible board models first." />
          : <div style={{ display: 'grid', gap: 8 }}>
            {releases.filter((r) => r.status === 'published').slice(0, 8).map((r) =>
              <div key={r.id} className="list-item" style={{ padding: '10px 0' }}>
                <span className="icon-box"><Icon.download /></span>
                <span className="grow"><span className="title">{r.name}</span>
                  <span className="meta">{r.version} · {(r.board_models || []).length} compatible boards · {r.deployments || 0} deployments</span></span>
                <button className="btn btn-sm" onClick={() => setDeploy(r)}>Assign <Icon.next /></button>
              </div>)}
          </div>}
      </Card>
      <Card title="Controller firmware" sub="Versions reported by real devices" icon="circuitry" pad={false}>
        {loading ? <div className="card-pad"><Loading rows={3} shape="row" /></div>
          : <DataTable columns={[
            { key: 'name', label: 'Controller', render: (b) => <div><div style={{ fontWeight: 600 }}>{b.name}</div><div className="tiny">{b.tenant_name}</div></div> },
            { key: 'chip', label: 'Board', render: (b) => <span className="tiny">{b.chip_family || b.catalog_board_id || 'Unknown'}</span> },
            { key: 'version', label: 'Installed', render: (b) => <span className="mono tiny">{b.firmware_version || 'Not reported'}</span> },
            { key: 'status', label: 'Connection', render: (b) => <StatusBadge status={b.status} /> },
          ]} rows={controllers} empty={<EmptyState icon="cpu" title="No controllers" text="Controllers appear after a customer completes device setup." />} />}
      </Card>
    </div>

    <div style={{ marginTop: 16 }}>
      <Card title="Update history" sub="Real OTA results reported by controllers" pad={false} icon="clock">
        {loading ? <div className="card-pad"><Loading rows={5} shape="table" /></div>
          : <DataTable columns={[
            { key: 'started_at', label: 'Started', render: (h) => <span className="tiny">{timeFull(h.started_at)}</span> },
            { key: 'board', label: 'Controller', render: (h) => <div><div style={{ fontWeight: 600 }}>{h.board_name || 'Removed controller'}</div><div className="tiny">{h.tenant_name}</div></div> },
            { key: 'version', label: 'Update', render: (h) => <span className="mono tiny">{h.from_version || '—'} → {h.to_version}</span> },
            { key: 'progress', label: 'Progress', render: (h) => <div style={{ width: 110 }}>
              <Progress value={h.progress} tone={h.status === 'failed' ? 'danger' : h.status === 'success' ? 'on' : 'warn'} /></div> },
            { key: 'status', label: 'Result', render: (h) => <StatusBadge status={h.status} /> },
            { key: 'error', label: 'Detail', render: (h) => <span className="tiny">{h.error || (h.finished_at ? timeAgo(h.finished_at) : '—')}</span> },
          ]} rows={history} empty={<EmptyState icon="clock" title="No updates yet"
            text="Successful, failed and pending updates appear here as controllers report their progress." />} />}
      </Card>
    </div>

    {upload && <UploadModal catalog={catalog} limits={data?.limits} onClose={() => setUpload(false)} onDone={refresh} />}
    {edit && <EditModal release={edit} catalog={catalog} onClose={() => setEdit(null)} onDone={refresh} />}
    {deploy && <DeployModal release={deploy} catalog={catalog} controllers={controllers}
      onClose={() => setDeploy(null)} onDone={refresh} />}
    {confirm && <Modal title="Delete firmware release" onClose={() => setConfirm(null)} footer={<>
      <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
      <button className="btn btn-danger" onClick={remove} disabled={typed !== 'DELETE' || busy === confirm.id}>
        <Icon.trash />{busy === confirm.id ? 'Deleting…' : 'Delete permanently'}</button>
    </>}>
      <Notice tone="danger" title="This removes the binary from R2">The release metadata and the stored file are deleted together. Update history is kept. A release with an update in progress cannot be deleted.</Notice>
      <div className="kv" style={{ margin: '16px 0' }}>
        <dt>Release</dt><dd>{confirm.name}</dd><dt>Version</dt><dd className="mono">{confirm.version}</dd>
        <dt>Size</dt><dd>{fmtBytes(confirm.size_bytes)}</dd><dt>Checksum</dt><dd className="mono tiny">{confirm.sha256}</dd>
      </div>
      <Field label="Type DELETE to confirm"><input className="input mono" value={typed}
        onChange={(e) => setTyped(e.target.value)} placeholder="DELETE" /></Field>
    </Modal>}
  </>;
}
