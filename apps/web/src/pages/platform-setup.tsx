/**
 * Owner Console — read-only setup status and integration checks.
 * Supabase/EMQX values live in Cloudflare Pages → Settings → Variables and Secrets;
 * firmware uses the native FIRMWARE_BUCKET R2 binding from Settings → Functions.
 * No secret value is ever sent to, stored in, or displayed by the browser.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useLiveData } from '../api';
import { useAuth } from '../state';
import { Badge, Card, Icon, Loading, Notice, PageHead } from '../components';

function CloudflareSteps() {
  return <Notice tone="info">
    <div style={{ display: 'grid', gap: 8 }}>
      <strong>One-time setup — all in web dashboards</strong>
      <ol style={{ margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.8, fontSize: 13 }}>
        <li>Cloudflare Pages → your project → <b>Settings → Variables and Secrets</b>: add the two Supabase values and the five EMQX values listed below. Store keys and secrets as <b>Secrets</b> (encrypted), never as plain text variables.</li>
        <li>Cloudflare dashboard → <b>R2 Object Storage → Create bucket</b>: create a private bucket (for example <code>homecoreos-firmware</code>) and leave public access <b>disabled</b>. No API token is needed.</li>
        <li>Cloudflare Pages → your project → <b>Settings → Functions → R2 bucket bindings → Add binding</b>: set the variable name to <code>FIRMWARE_BUCKET</code> and select that private bucket. <code>R2_BUCKET</code> also works as the variable name.</li>
        <li><b>Save</b>, then open <b>Deployments → Retry deployment</b> (or push to GitHub again). Bindings are attached at deploy time.</li>
        <li>In Supabase, run <code>supabase/schema.sql</code> once in the <b>SQL Editor</b>.</li>
      </ol>
      <div className="tiny">The R2 binding is server-side only. No R2 API token, access key, secret or Account ID is configured, and no R2 credential is ever sent to the browser. Firmware Management reports “Verified” only after a real upload and download test passes.</div>
    </div>
  </Notice>;
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === 'ok' ? 'on' : status === 'error' ? 'danger' : 'warn';
  const label = status === 'ok' ? 'Ready' : status === 'error' ? 'Needs attention' : 'Not configured';
  return <Badge tone={tone as any}>{label}</Badge>;
}

function Variables({ variables }: { variables: any[] }) {
  const supabase = (variables || []).filter((v: any) => v.group === 'supabase');
  const emqx = (variables || []).filter((v: any) => v.group === 'emqx');
  const group = (title: string, rows: any[]) => <div key={title} style={{ display: 'grid', gap: 8 }}>
    <div style={{ fontWeight: 650 }}>{title}</div>
    {rows.map((v: any) => <div key={v.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(170px, 1fr) auto', gap: 8, alignItems: 'start', borderBottom: '1px solid var(--line, #243044)', paddingBottom: 8 }}>
      <div>
        <code style={{ fontSize: 12.5 }}>{v.key}</code>
        <div className="tiny muted">{v.label}{v.sensitive ? ' · encrypted Secret' : ' · plain variable'}</div>
        <div className="tiny muted">{v.hint}</div>
      </div>
      <Badge tone={v.configured ? 'on' : 'warn'}>{v.configured ? v.sensitive ? 'Set (hidden)' : 'Set' : 'Missing'}</Badge>
    </div>)}
  </div>;
  return <Card title="Required configuration" sub="Values are only ever read by the server. Nothing here can be edited in the browser.">
    <div style={{ display: 'grid', gap: 18 }}>
      {group('Supabase PostgreSQL', supabase)}
      {group('EMQX Cloud Serverless', emqx)}
    </div>
  </Card>;
}

function StorageBinding({ storage }: { storage: any }) {
  const bound = storage?.backend === 'r2' || !!storage?.r2_configured;
  return <Card title="Firmware storage binding" sub="Added in Cloudflare Pages → Settings → Functions → R2 bucket bindings. Not a secret.">
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(170px, 1fr) auto', gap: 8, alignItems: 'center' }}>
        <div>
          <code style={{ fontSize: 12.5 }}>FIRMWARE_BUCKET</code>
          <div className="tiny muted">Native R2 bucket binding · private bucket · server-side only</div>
        </div>
        <Badge tone={bound ? 'on' : 'warn'} icon={bound ? 'cloudOk' : 'cloudOff'}>
          {bound ? 'Binding present' : 'Not bound'}
        </Badge>
      </div>
      <div className="tiny muted">{storage?.detail || 'Run the firmware upload and download test to confirm the binding works.'}</div>
      {!bound && <Notice tone="warn">No R2 bucket binding is attached. Add <code>FIRMWARE_BUCKET</code> under Settings → Functions → R2 bucket bindings and redeploy. Until then firmware uses private Supabase Storage and the console says so.</Notice>}
    </div>
  </Card>;
}

function Connections({ connections, onTest, busy }: { connections: any; onTest: (t: string) => void; busy: string | null }) {
  const rows = [
    { id: 'supabase', title: 'Supabase', icon: 'server' as const },
    { id: 'emqx', title: 'EMQX Cloud', icon: 'radio' as const },
  ];
  return <Card title="Live connection checks" sub="Each check runs on the server; credentials never leave Cloudflare.">
    <div style={{ display: 'grid', gap: 12 }}>
      {rows.map((r) => {
        const s = connections?.[r.id] || {};
        const Glyph = Icon[r.icon];
        return <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center', borderBottom: '1px solid var(--line, #243044)', paddingBottom: 10 }}>
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Glyph size={15} /><b>{r.title}</b>
              <Badge tone={s.connected ? 'on' : 'danger'}>{s.connected ? 'Connected' : 'Not connected'}</Badge>
            </div>
            <div className="tiny muted">{s.endpoint || 'Endpoint not configured'}</div>
            <div className="tiny muted">{s.last_error || s.detail || 'Run a test to check this connection.'}</div>
            {s.last_checked && <div className="tiny muted">Last checked: {new Date(s.last_checked).toLocaleString()}</div>}
          </div>
          <button className="btn" disabled={busy !== null} aria-busy={busy !== null || undefined} onClick={() => onTest(r.id)}>
            <Icon.refresh size={14} /> {busy === r.id ? 'Testing…' : 'Test connection'}
          </button>
        </div>;
      })}
    </div>
  </Card>;
}

function useChecks(refresh: () => void) {
  const toast = useAuth().toast;
  const [busy, setBusy] = useState<string | null>(null);
  const [storage, setStorage] = useState<any>(null);
  const test = async (target: string) => {
    setBusy(target);
    try {
      const r = await api.post<any>('/api/owner/integrations/test', { target });
      toast(r.connected ? `${target}: connected` : `${target}: ${r.detail}`, r.connected ? 'ok' : 'error');
    } catch (e: any) { toast(e.message || 'Test failed', 'error'); }
    finally { setBusy(null); refresh(); }
  };
  const testStorage = async () => {
    setBusy('storage');
    try {
      const r = await api.post<any>('/api/owner/setup/test-bucket', {});
      setStorage(r);
      toast(r.connected ? 'Firmware upload and download verified' : r.detail, r.connected ? 'ok' : 'error');
    } catch (e: any) { toast(e.message || 'Test failed', 'error'); }
    finally { setBusy(null); refresh(); }
  };
  return { busy, storage, test, testStorage };
}

export function OwnerSetup() {
  const { data, loading, error, refresh } = useLiveData<any>('/api/owner/setup');
  const checks = useChecks(refresh);
  return <>
    <PageHead title="Initial setup" desc="Supabase for data, EMQX Cloud Serverless for devices and a native private R2 bucket binding for firmware binaries."
      actions={<button className="btn" onClick={refresh}><Icon.refresh size={14} /> Refresh</button>} />
    <div style={{ display: 'grid', gap: 16 }}>
      <CloudflareSteps />
      {loading && <Loading rows={3} />}
      {error && <Notice tone="danger">{error}</Notice>}
      {data && <>
        <Card title="Setup checklist" sub={data.setup_complete ? 'Everything is ready.' : 'Finish the items marked below.'}>
          <div style={{ display: 'grid', gap: 10 }}>
            {(data.checklist || []).map((x: any) => <div key={x.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'start', borderBottom: '1px solid var(--line, #243044)', paddingBottom: 10 }}>
              <div>
                <b>{x.label}</b>
                <div className="tiny muted">{x.detail}</div>
                {x.hint && <div className="tiny muted">{x.hint}</div>}
              </div>
              <StatusBadge status={x.status} />
            </div>)}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button className="btn" disabled={checks.busy !== null} onClick={checks.testStorage}>
                <Icon.drive size={14} /> {checks.busy === 'storage' ? 'Testing…' : 'Test firmware upload & download'}
              </button>
              {checks.storage && <span className="tiny muted">{checks.storage.detail}</span>}
            </div>
          </div>
        </Card>
        <Variables variables={data.variables || []} />
        <StorageBinding storage={data.storage} />
        <Connections connections={data.connections} onTest={checks.test} busy={checks.busy} />
        <Card title="Notes"><div style={{ display: 'grid', gap: 6 }}>
          {(data.notes || []).map((n: string) => <div key={n} className="tiny muted">• {n}</div>)}
        </div></Card>
      </>}
      <Link className="btn" to="/owner/settings/integrations"><Icon.settings size={14} /> Integrations</Link>
    </div>
  </>;
}

export function OwnerIntegrations() {
  const { data, loading, error, refresh } = useLiveData<any>('/api/owner/integrations');
  const checks = useChecks(refresh);
  return <>
    <PageHead title="Integrations" desc="Read-only status of the encrypted Cloudflare secrets and the native R2 bucket binding used for firmware."
      actions={<><Link className="btn" to="/owner/setup"><Icon.check size={14} />Setup checklist</Link><Link className="btn" to="/owner/settings"><Icon.settings size={14} />Platform Settings</Link></>} />
    <div style={{ display: 'grid', gap: 16 }}>
      <CloudflareSteps />
      {loading && <Loading rows={3} />}
      {error && <Notice tone="danger">{error}</Notice>}
      {data && <>
        <Variables variables={data.variables || []} />
        <StorageBinding storage={data.storage} />
        <Connections connections={data.connections} onTest={checks.test} busy={checks.busy} />
        <Card title="Notes"><div style={{ display: 'grid', gap: 6 }}>
          {(data.notes || []).map((n: string) => <div key={n} className="tiny muted">• {n}</div>)}
        </div></Card>
      </>}
    </div>
  </>;
}

export function PlatformSettingsLinks() {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
    <Link className="card" to="/owner/setup" style={{ padding: 16, textDecoration: 'none', color: 'inherit' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}><Icon.check size={16} /><b>Initial setup</b></div>
      <div className="tiny muted">Checklist, encrypted secrets, R2 binding and live connection tests.</div>
    </Link>
    <Link className="card" to="/owner/settings/integrations" style={{ padding: 16, textDecoration: 'none', color: 'inherit' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}><Icon.link size={16} /><b>Integrations</b></div>
      <div className="tiny muted">Supabase, EMQX and R2 binding status. Configure it in Cloudflare Pages.</div>
    </Link>
  </div>;
}
