/**
 * Owner Console — Initial Setup wizard and Platform Settings → Integrations &
 * Secrets. This file never receives a saved secret value: the API returns only
 * configured/unconfigured status, masked placeholders, fingerprints and dates.
 * Form state lives only in React memory and is cleared immediately after save.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useLiveData } from '../api';
import { useAuth } from '../state';
import {
  Badge, Card, Field, Icon, Loading, Modal, Notice, PageHead, Stat,
} from '../components';

function useToast() { return useAuth().toast; }
const masked = '••••••••••••';

function CloudflareSteps({ compact = false }: { compact?: boolean }) {
  return <Notice tone="info">
    <div style={{ display: 'grid', gap: 7 }}>
      <strong>One-time Cloudflare setup (recommended: Cloudflare D1)</strong>
      <div className="tiny">Cloudflare Dashboard → Workers &amp; Pages → your Pages project → Settings:</div>
      <ol style={{ margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.7, fontSize: 12.5 }}>
        <li><b>Bindings</b> → add a <b>D1 database</b> named <code>DB</code>.</li>
        <li><b>Bindings</b> → add an <b>R2 bucket</b> named <code>FIRMWARE_BUCKET</code>.</li>
        <li><b>Variables and Secrets</b> → add the encrypted <code>SECRETS_KEY</code> (64 hex characters).</li>
        <li><b>Save and redeploy</b>. Migrations run automatically on the first request.</li>
      </ol>
      {!compact && <div className="tiny">Using Supabase instead? Set <code>SUPABASE_URL</code> and <code>SUPABASE_SERVICE_ROLE_KEY</code> as bootstrap values, apply the SQL migrations once, then enter the remaining credentials below. Never configure both providers at once.</div>}
      <div className="tiny">No R2 access keys, D1 API tokens or database URLs are needed when native bindings are available.</div>
    </div>
  </Notice>;
}

function StatusDot({ status }: { status: string }) {
  const tone = status === 'ok' ? 'on' : status === 'error' ? 'danger' : 'warn';
  const label = status === 'ok' ? 'Ready' : status === 'error' ? 'Needs attention' : 'Not configured';
  return <Badge tone={tone as any}>{label}</Badge>;
}

function SourceBadge({ source }: { source: string }) {
  const labels: Record<string, string> = {
    binding: 'Cloudflare binding', bootstrap: 'Bootstrap variable',
    encrypted: 'Encrypted integration secret', integration: 'Integration',
  };
  return <Badge tone="info">{labels[source] || source}</Badge>;
}

// ---------------------------------------------------------------------------
// Initial setup
// ---------------------------------------------------------------------------
export function OwnerSetup() {
  const { data, loading, refresh } = useLiveData<any>('/api/owner/setup');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [migrate, setMigrate] = useState(false);
  const [backupText, setBackupText] = useState('');
  const [target, setTarget] = useState('d1');
  const [confirm, setConfirm] = useState('');
  const [bucket, setBucket] = useState<any>(null);

  const choose = async (provider: string) => {
    setBusy(true);
    try { await api.post('/api/owner/setup/provider', { provider }); toast(`${provider === 'd1' ? 'Cloudflare D1' : 'Supabase PostgreSQL'} selected`); refresh(); }
    catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  const exportBackup = async () => {
    setBusy(true);
    try {
      const b = await api.get<any>('/api/owner/setup/backup');
      const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `homecoreos-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(url);
      toast('Backup downloaded. Keep it private — it contains encrypted secrets and platform data.');
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  const runMigration = async () => {
    setBusy(true);
    try {
      const parsed = JSON.parse(backupText);
      await api.post('/api/owner/setup/switch', {
        provider: target, backup: parsed, migration_token: parsed.migration_token, confirm,
      });
      toast('Provider migration completed'); setMigrate(false); setBackupText(''); setConfirm(''); refresh();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  const testR2 = async () => {
    setBusy(true);
    try { setBucket(await api.post<any>('/api/owner/setup/test-bucket', {})); refresh(); }
    catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  if (loading || !data) return <><PageHead title="Initial setup" desc="Configure the platform in a few steps." /><Loading rows={4} /></>;
  const checklist: any[] = data.checklist || [];
  const ready = checklist.filter((x) => x.status === 'ok').length;

  return <>
    <PageHead title="Initial setup" desc="One database, native Cloudflare bindings, and encrypted integration credentials. Ordinary customers never see these settings."
      actions={<><Link className="btn" to="/owner/settings/integrations"><Icon.lock />Integrations &amp; Secrets</Link></>} />
    <div className="grid grid-3" style={{ marginBottom: 14 }}>
      <Stat label="Setup progress" value={`${ready} / ${checklist.length}`} icon="check" foot={data.setup_complete ? 'Platform is ready' : 'Finish the checklist below'} />
      <Stat label="Database provider" value={data.provider === 'd1' ? 'Cloudflare D1' : data.provider === 'supabase' ? 'Supabase' : 'Not detected'} icon="drive" foot="Exactly one provider is active" />
      <Stat label="Encrypted secrets" value={(data.encrypted_secrets || []).filter((f: any) => f.configured).length} icon="lock" foot="AES-256-GCM at rest" />
    </div>

    <CloudflareSteps />

    {data.wizard?.needs_selection && <Card title="Step 1 — Choose your database" sub="This is a one-time decision. Changing it later requires a real data migration." style={{ marginTop: 14 }}>
      <div className="grid grid-2">
        {(data.wizard.options || []).map((o: any) => <div className="card" key={o.id} style={{ padding: 16, border: o.id === 'd1' ? '1px solid var(--focus)' : undefined }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}><Icon.drive /><strong>{o.label}</strong>{o.id === 'd1' && <Badge tone="on">Recommended</Badge>}</div>
          <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.6, margin: '0 0 12px' }}>{o.description}</p>
          {!o.applicable && <div className="tiny" style={{ marginBottom: 10 }}>Add the required Cloudflare binding / bootstrap variables and redeploy before selecting.</div>}
          <button className="btn btn-primary" disabled={busy || (!o.applicable && data.provider !== 'pglite')} onClick={() => choose(o.id)}>Use {o.label}</button>
        </div>)}
      </div>
    </Card>}

    {data.migration_required && <div style={{ marginTop: 14 }}><Notice tone="warn">
      <div><strong>Provider change detected.</strong> A different database was previously selected. Switching is not a settings toggle — export a backup, change the Cloudflare binding/variables, redeploy, then run the guided migration below.</div>
      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" disabled={busy} onClick={exportBackup}><Icon.download />Export backup</button>
        <button className="btn btn-primary" onClick={() => setMigrate(true)}>Run provider migration</button>
      </div>
    </Notice></div>}

    <Card title="Setup checklist" sub="Required configuration, native bindings and encrypted integration secrets are clearly separated." style={{ marginTop: 14 }}
      actions={<button className="btn btn-sm" onClick={refresh}><Icon.refresh />Refresh</button>}>
      <div style={{ display: 'grid', gap: 10 }}>
        {checklist.map((x: any) => <div className="list-item" key={x.id} style={{ alignItems: 'flex-start' }}>
          <div className="icon-box">{x.status === 'ok' ? <Icon.ok /> : <Icon.info />}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 13 }}>{x.label}</strong>
              <StatusDot status={x.status} /><SourceBadge source={x.source} />
              {x.required ? <Badge tone="danger">Required</Badge> : <Badge>Optional</Badge>}
            </div>
            <div className="tiny" style={{ marginTop: 5 }}>{x.detail}</div>
            {(x.last_success || x.last_checked) && <div className="tiny" style={{ marginTop: 3 }}>Last successful check: {x.last_success || '—'} · Last checked: {x.last_checked || '—'}</div>}
          </div>
        </div>)}
      </div>
      <div className="divider" />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" disabled={busy} onClick={testR2}><Icon.drive />Test R2 upload/download</button>
        <button className="btn" disabled={busy} onClick={exportBackup}><Icon.download />Export backup</button>
        <Link className="btn" to="/owner/settings/integrations"><Icon.lock />Manage credentials</Link>
        {bucket && <Badge tone={bucket.connected ? 'on' : 'danger'}>{bucket.detail}</Badge>}
      </div>
    </Card>

    <div className="grid grid-2" style={{ marginTop: 14, alignItems: 'start' }}>
      <Card title="Required configuration" sub="Bootstrap values and native bindings configured once in Cloudflare.">
        <ConfigList items={(data.required || []).concat((data.bindings || []).filter((b: any) => b.required).map((b: any) => ({ key: b.name, label: b.label, configured: b.connected, source: 'binding', hint: b.detail, required: true })))} />
      </Card>
      <Card title="Optional configuration" sub="Only requested when the selected provider or integration needs it.">
        <ConfigList items={data.optional || []} />
      </Card>
    </div>

    <div className="grid grid-2" style={{ marginTop: 14, alignItems: 'start' }}>
      <Card title="Cloudflare bindings" sub="Native bindings — no credentials, tokens or URLs in the app.">
        {(data.bindings || []).map((b: any) => <div className="list-item" key={b.name}>
          <div className="icon-box"><Icon.link /></div>
          <div style={{ flex: 1 }}><div className="title mono">{b.name}</div><div className="meta">{b.label} · {b.detail}</div></div>
          <StatusDot status={b.connected ? 'ok' : 'missing'} />
        </div>)}
      </Card>
      <Card title="Encrypted integration secrets" sub="AES-256-GCM sealed with SECRETS_KEY. Saved values are never displayed again.">
        <ConfigList items={(data.encrypted_secrets || []).map((f: any) => ({ ...f, hint: f.configured ? `${f.masked} · updated ${f.updated_at ? new Date(f.updated_at).toLocaleString() : '—'}` : f.hint }))} />
        <div style={{ marginTop: 10 }}><Link className="btn btn-sm" to="/owner/settings/integrations">Open Integrations &amp; Secrets <Icon.next /></Link></div>
      </Card>
    </div>

    {migrate && <Modal title="Provider migration" wide onClose={() => setMigrate(false)} footer={<>
      <button className="btn" onClick={() => setMigrate(false)}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !backupText || confirm !== 'MIGRATE'} onClick={runMigration}>Migrate data</button>
    </>}>
      <Notice tone="warn"><div>Export a backup from the <b>current</b> provider first, then change the Cloudflare binding/variables and redeploy. Paste that exact backup file here. The migration token inside it is verified server-side.</div></Notice>
      <Field label="Exported backup JSON" hint="Downloaded from this console before switching bindings."><textarea className="textarea mono" style={{ minHeight: 130 }} value={backupText} onChange={(e) => setBackupText(e.target.value)} placeholder="Paste homecoreos-backup-….json" /></Field>
      <div className="form-row">
        <Field label="Target provider"><select className="select" value={target} onChange={(e) => setTarget(e.target.value)}><option value="d1">Cloudflare D1</option><option value="supabase">Supabase PostgreSQL</option></select></Field>
        <Field label="Confirm" hint="Type MIGRATE"><input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="MIGRATE" /></Field>
      </div>
    </Modal>}
  </>;
}

function ConfigList({ items }: { items: any[] }) {
  if (!items?.length) return <div className="tiny muted" style={{ padding: '10px 0' }}>Nothing else is required.</div>;
  return <div style={{ display: 'grid', gap: 8 }}>
    {items.map((f: any) => <div className="list-item" key={f.key || f.name}>
      <div className="icon-box">{f.source === 'binding' ? <Icon.link /> : f.configured ? <Icon.lock /> : <Icon.info />}</div>
      <div style={{ flex: 1, minWidth: 0 }}><div className="title mono">{f.key || f.name}{f.label && f.label !== f.key ? ` · ${f.label}` : ''} {f.required ? <Badge tone="danger">Required</Badge> : null}</div>
        <div className="meta">{f.hint}</div></div>
      <StatusDot status={f.configured ? 'ok' : 'missing'} />
    </div>)}
  </div>;
}

// ---------------------------------------------------------------------------
// Integrations & Secrets
// ---------------------------------------------------------------------------
function SecretFieldRow({ field, groupLabel, onSaved }: { field: any; groupLabel: string; onSaved: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const save = async (rotate = false) => {
    if (!value.trim()) { toast('Enter a new value first', 'error'); return; }
    setBusy(true);
    try {
      if (rotate) await api.post(`/api/owner/integrations/rotate/${field.key}`, { value });
      else await api.put('/api/owner/integrations', { secrets: { [field.key]: value } });
      setValue(''); setReveal(false); toast(`${field.label} saved and encrypted`); onSaved();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await api.del(`/api/owner/integrations/${field.key}`); toast(`${field.label} removed`); onSaved(); }
    catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  if (field.source !== 'encrypted') {
    return <div className="list-item" style={{ alignItems: 'flex-start' }}>
      <div className="icon-box"><Icon.shield /></div>
      <div style={{ flex: 1 }}>
        <div className="title mono">{field.key} · {field.label}</div>
        <div className="meta">{field.hint}</div>
        <div className="tiny" style={{ marginTop: 4 }}>{groupLabel} · Set once in Cloudflare Pages → Settings → Variables and Secrets. Never stored in the database or shown here.</div>
      </div>
      <StatusDot status={field.configured ? 'ok' : 'missing'} />
    </div>;
  }
  return <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span className="mono" style={{ fontSize: 12.5 }}>{field.key}</span>
      <span className="muted" style={{ fontSize: 12.5 }}>{field.label}</span>
      {field.required ? <Badge tone="danger">Required</Badge> : <Badge>Optional</Badge>}
      <StatusDot status={field.configured ? 'ok' : 'missing'} />
      {field.configured && <span className="tiny mono">{masked}{field.fingerprint ? ` · ${field.fingerprint}` : ''}</span>}
    </div>
    <div className="tiny muted" style={{ margin: '5px 0 8px' }}>{field.hint}</div>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <input className="input" style={{ maxWidth: 380 }} type={field.sensitive && !reveal ? 'password' : field.input === 'number' ? 'number' : 'text'}
        value={value} placeholder={field.configured ? 'Enter a new value to rotate' : (field.placeholder || 'Enter value')}
        onChange={(e) => setValue(e.target.value)} autoComplete="off" />
      {field.sensitive && <button className="btn btn-ghost btn-sm" onClick={() => setReveal((r) => !r)}>{reveal ? 'Hide' : 'Show'}</button>}
      <button className="btn btn-primary btn-sm" disabled={busy || !value.trim()} onClick={() => save(field.configured)}>
        {field.configured ? 'Rotate' : 'Save'}
      </button>
      {field.configured && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={remove}><Icon.trash />Remove</button>}
    </div>
    {field.updated_at && <div className="tiny" style={{ marginTop: 6 }}>Last updated {new Date(field.updated_at).toLocaleString()} · value is never displayed again.</div>}
  </div>;
}

function TestCard({ target, label, status, onTest }: { target: string; label: string; status: any; onTest: (t: string) => void }) {
  const [busy, setBusy] = useState(false);
  const click = async () => { setBusy(true); try { await onTest(target); } finally { setBusy(false); } };
  const s = status || {};
  return <Card title={label} sub="Server-side check. Credentials never leave the platform.">
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
      <StatusDot status={s.connected ? 'ok' : 'error'} />
      {s.client_count != null && <Badge tone="info">{s.client_count} connected clients</Badge>}
    </div>
    <div style={{ fontSize: 12.5 }}>{s.connected ? 'Connected' : (s.last_error || 'Not checked yet')}</div>
    {s.hint && <div className="tiny" style={{ marginTop: 6, color: 'var(--state-warn)' }}>{s.hint}</div>}
    <div className="kv" style={{ marginTop: 12 }}>
      <dt>Endpoint</dt><dd className="mono">{s.endpoint || '—'}</dd>
      <dt>Last successful check</dt><dd>{s.stored_last_success || s.last_success || '—'}</dd>
      <dt>Last checked</dt><dd>{s.last_checked || '—'}</dd>
    </div>
    <div style={{ marginTop: 12 }}><button className="btn btn-sm" disabled={busy} onClick={click}><Icon.refresh />Test connection</button></div>
  </Card>;
}

export function OwnerIntegrations() {
  const { data, loading, refresh } = useLiveData<any>('/api/owner/integrations');
  const toast = useToast();
  const [tab, setTab] = useState('groups');
  const test = async (target: string) => {
    try { const r = await api.post<any>('/api/owner/integrations/test', { target }); toast(r.connected ? `${target} connection succeeded` : `${target}: ${r.detail}`, r.connected ? 'ok' : 'error'); refresh(); }
    catch (e: any) { toast(e.message, 'error'); }
  };
  if (loading || !data) return <><PageHead title="Integrations & Secrets" desc="Secure, server-side platform configuration." /><Loading rows={4} /></>;
  const groups: any[] = data.groups || [];
  return <>
    <PageHead title="Integrations & Secrets" desc="Platform Settings · organized credential forms, encrypted at rest with SECRETS_KEY. Saved values are never displayed again."
      actions={<><Link className="btn" to="/owner/setup"><Icon.check />Setup checklist</Link><Link className="btn" to="/owner/settings">Platform Settings</Link></>} />
    <div className="segmented" style={{ marginBottom: 14, maxWidth: 480 }}>
      <button className={tab === 'groups' ? 'on' : ''} onClick={() => setTab('groups')}>Credentials</button>
      <button className={tab === 'connections' ? 'on' : ''} onClick={() => setTab('connections')}>Connection status</button>
      <button className={tab === 'bindings' ? 'on' : ''} onClick={() => setTab('bindings')}>Cloudflare bindings</button>
    </div>

    {tab === 'groups' && <>
      <Notice tone="warn"><div><strong>Never share these values.</strong> Service-role keys, MQTT credentials and administrative API secrets are stored encrypted on the server and are never sent to browsers or customers. Only status, masked placeholders and fingerprints are shown here.</div></Notice>
      {groups.map((g: any) => <Card key={g.id} title={g.label} sub={g.description} style={{ marginTop: 14 }}
        actions={<Badge tone={g.applicable ? 'info' : ''}>{g.applicable ? (g.fields.some((f: any) => f.required) ? 'Required configuration' : 'Optional configuration') : 'Not needed with D1'}</Badge>}>
        {!g.applicable
          ? <div className="tiny muted">Supabase variables are not requested when Cloudflare D1 is the selected database. Switch providers through the guided migration in <Link to="/owner/setup">Initial setup</Link> if you need them.</div>
          : g.fields.map((f: any) => <SecretFieldRow key={f.key} field={f} groupLabel={g.label} onSaved={refresh} />)}
      </Card>)}
    </>}

    {tab === 'connections' && <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <TestCard target="supabase" label="Supabase PostgreSQL" status={data.connections?.supabase} onTest={test} />
      <TestCard target="emqx" label="EMQX / MQTT" status={data.connections?.emqx} onTest={test} />
      <div style={{ gridColumn: '1 / -1' }}><Card title="Required vs optional" sub="Only the fields needed for the selected provider and integrations are requested.">
        <div className="grid grid-2"><ConfigList items={data.required || []} /><ConfigList items={data.optional || []} /></div>
      </Card></div>
    </div>}

    {tab === 'bindings' && <Card title="Native Cloudflare bindings" sub="Configured in Cloudflare Pages → Settings → Bindings. No API credentials.">
      {(data.bindings || []).map((b: any) => <div className="list-item" key={b.name}>
        <div className="icon-box"><Icon.link /></div>
        <div style={{ flex: 1 }}><div className="title mono">{b.name}</div><div className="meta">{b.label} · {b.detail}</div></div>
        <StatusDot status={b.connected ? 'ok' : 'missing'} />
      </div>)}
      <div className="divider" /><CloudflareSteps compact />
    </Card>}

    {!!(data.corrupt_secrets || []).length && <div style={{ marginTop: 14 }}><Notice tone="danger"><div>Some encrypted entries could not be decrypted (likely after a SECRETS_KEY change): {(data.corrupt_secrets || []).join(', ')}. Re-enter them below to rotate.</div></Notice></div>}
  </>;
}

/** Inserted at the top of Platform Settings to make the secure sub-pages obvious. */
export function PlatformSettingsLinks() {
  return <div className="grid grid-2" style={{ marginBottom: 14 }}>
    <Link className="card" to="/owner/setup" style={{ padding: 16, textDecoration: 'none', color: 'inherit' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><div className="icon-box"><Icon.check /></div>
        <div><strong>Initial setup &amp; checklist</strong><div className="tiny muted">Choose the database provider, verify bindings, run migrations and backups.</div></div><Icon.next style={{ marginLeft: 'auto' }} /></div>
    </Link>
    <Link className="card" to="/owner/settings/integrations" style={{ padding: 16, textDecoration: 'none', color: 'inherit' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><div className="icon-box"><Icon.lock /></div>
        <div><strong>Integrations &amp; Secrets</strong><div className="tiny muted">Encrypted Supabase, EMQX and platform credentials with Test Connection.</div></div><Icon.next style={{ marginLeft: 'auto' }} /></div>
    </Link>
  </div>;
}
