import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, useLiveData } from '../api';
import { useAuth } from '../state';
import {
  Badge, Card, DataTable, EmptyState, Field, Icon, Loading, MiniChart, Modal, Notice,
  PageHead, Progress, Skeleton, Stat, StatusBadge, fmt, fmtBytes, timeAgo, timeFull,
} from '../components';
import { EMQX_QUOTAS, WARNING_THRESHOLDS } from '@homecoreos/core';
import { PlatformSettingsLinks } from './platform-setup';

function useToast() { return useAuth().toast; }
const human = (v: string) => String(v || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function OwnerOverview() {
  const { data, loading } = useLiveData<any>('/api/owner/overview');
  const toast = useToast();
  const s = data || {};
  return <>
    <PageHead title="Platform Overview" desc="SaaS-wide metrics. Customer home data stays in each tenant." actions={<Link className="btn" to="/owner/usage">Usage & Monitoring <Icon.next /></Link>} />
    {loading ? <Loading rows={4} /> : <>
      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Stat label="Registered accounts" value={s.accounts ?? 0} icon="users" foot={`${s.active_accounts ?? 0} active · ${s.suspended_accounts ?? 0} suspended`} />
        <Stat label="ESP32 controllers" value={s.boards ?? 0} icon="cpu" foot={`${s.boards_online ?? 0} online · ${s.boards_offline ?? 0} offline`} />
        <Stat label="Switches" value={s.devices ?? 0} icon="power" foot={`${s.sensors ?? 0} sensors`} />
        <Stat label="Rooms" value={s.rooms ?? 0} icon="pin" foot={`${s.staff ?? 0} active staff`} />
      </div>
      <div className="grid grid-3" style={{ marginBottom: 14 }}>
        <Card title="MQTT connection health" sub="EMQX deployment API"><HealthRow ok={s.mqtt_health?.connected} label={s.mqtt_health?.detail} foot={s.mqtt_health?.checked_at ? timeAgo(s.mqtt_health.checked_at) : 'Not checked'} /></Card>
        <Card title="System API health"><HealthRow ok={s.api_health?.connected} label="Cloudflare Pages Functions responding" foot="All console routes served through the same-origin API" /></Card>
        <Card title="Database health"><HealthRow ok={s.database_health?.connected} label="Supabase PostgreSQL · connected" foot="Tenant isolation enforced server-side" /></Card>
      </div>
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card title="Platform metrics" sub="Last 24 hours"><div className="metric-row"><span>Commands</span><span className="v">{fmt(s.commands_24h, 0)}</span></div>
          <div className="metric-row"><span>Telemetry readings</span><span className="v">{fmt(s.telemetry_24h, 0)}</span></div>
          <div className="metric-row"><span>Active staff</span><span className="v">{fmt(s.staff, 0)}</span></div>
          <div className="metric-row"><span>Warning thresholds</span><span className="v">{(s.thresholds || WARNING_THRESHOLDS).join(' / ')}%</span></div></Card>
        <Card title="Recent platform activity" sub="Audited administrative operations">{!s.recent_activity?.length ? <EmptyState icon="activity" title="No activity" text="Platform actions will be recorded here." /> :
          s.recent_activity.slice(0, 8).map((a: any) => <div className="list-item" key={a.id}><div className="icon-box"><Icon.activity /></div>
            <div className="grow"><div className="title">{a.action.replace(/\./g, ' ')}</div><div className="meta">{a.actor_email || a.actor_type} · {a.entity_type || ''}</div></div>
            <span className="tiny">{timeAgo(a.created_at)}</span></div>)}</Card>
      </div>
    </>}
  </>;
}

function HealthRow({ ok, label, foot }: { ok?: boolean; label?: string; foot?: string }) {
  return <><div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
    {ok ? <Badge tone="on">Healthy</Badge> : <Badge tone="danger">Unavailable</Badge>}</div>
    <div style={{ fontSize: 12.5 }}>{label || 'Not checked'}</div><div className="tiny" style={{ marginTop: 5 }}>{foot}</div></>;
}

export function OwnerCustomers() {
  const { data, loading, refresh } = useLiveData<any[]>('/api/owner/customers');
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [detail, setDetail] = useState<any>(null);
  const [suspend, setSuspend] = useState<any>(null);
  const rows = (data || []).filter((t: any) => (status === 'all' || t.status === status) && (t.name + t.slug + (t.owner?.profile_id || '')).toLowerCase().includes(search.toLowerCase()));
  return <>
    <PageHead title="Customers" desc="All registered accounts, their boards, usage and access controls." />
    <Card pad={false}>
      <div className="card-head"><div><h3>Accounts</h3><div className="sub">{rows.length} shown</div></div>
        <div style={{ display: 'flex', gap: 8 }}><div className="search" style={{ width: 220 }}><Icon.search /><input className="input" placeholder="Search accounts" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <select className="select" style={{ width: 140 }} value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="closed">Closed</option></select></div></div>
      {loading ? <div className="card-pad"><Skeleton height={180} /></div> : <DataTable columns={[
        { key: 'name', label: 'Account', render: (t: any) => <div><div style={{ fontWeight: 600 }}>{t.name}</div><div className="tiny mono">{t.slug}</div></div> },
        { key: 'status', label: 'Status', render: (t: any) => <StatusBadge status={t.status} /> },
        { key: 'boards', label: 'Boards', render: (t: any) => t.boards.length },
        { key: 'device_count', label: 'Devices', render: (t: any) => t.device_count },
        { key: 'sensor_count', label: 'Sensors', render: (t: any) => t.sensor_count },
        { key: 'staff_count', label: 'Staff', render: (t: any) => t.staff_count },
        { key: 'registration', label: 'Registration', render: (t: any) => t.device_registration_enabled ? <Badge tone="on">Enabled</Badge> : <Badge tone="danger">Blocked</Badge> },
        { key: 'created_at', label: 'Created', render: (t: any) => timeAgo(t.created_at) },
        { key: 'actions', label: '', render: (t: any) => <div className="row-actions">
          <button className="btn btn-sm" onClick={async () => setDetail(await api.get(`/api/owner/customers/${t.id}`))}><Icon.eye />Details</button>
          <button className="btn btn-sm" onClick={() => setSuspend(t)}>{t.status === 'active' ? 'Suspend' : 'Reactivate'}</button>
        </div> },
      ]} rows={rows} empty={<EmptyState icon="users" title="No customers" text="Accounts appear as soon as users register." />} />}
    </Card>
    {detail && <CustomerDetailModal data={detail} onClose={() => setDetail(null)} onChanged={refresh} />}
    {suspend && <SuspendModal tenant={suspend} onClose={() => setSuspend(null)} onDone={refresh} />}
  </>;
}

function SuspendModal({ tenant, onClose, onDone }: any) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const next = tenant.status === 'active' ? 'suspended' : 'active';
  return <Modal title={next === 'suspended' ? `Suspend ${tenant.name}?` : `Reactivate ${tenant.name}?`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
    <button className={`btn ${next === 'suspended' ? 'btn-danger' : 'btn-primary'}`} onClick={async () => {
      try { await api.post(`/api/owner/customers/${tenant.id}/status`, { status: next, reason }); toast(`Account ${next}`); onDone(); onClose(); } catch (e: any) { toast(e.message, 'error'); }
    }}>{next === 'suspended' ? 'Suspend account' : 'Reactivate account'}</button></>}>
    <Notice tone={next === 'suspended' ? 'warn' : 'info'}>Suspending blocks all API requests and tenant access for this workspace. Devices remain registered but cannot be operated until reactivation.</Notice>
    <Field label="Reason (audited)"><textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
  </Modal>;
}

function CustomerDetailModal({ data, onClose, onChanged }: any) {
  const toast = useToast();
  const t = data.tenant;
  const [flags, setFlags] = useState({ device_registration_enabled: t.device_registration_enabled, max_boards: t.max_boards, max_devices: t.max_devices, plan: t.plan });
  return <Modal title={t.name} onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={async () => {
    try { await api.patch(`/api/owner/customers/${t.id}`, flags); toast('Account settings saved'); onChanged(); onClose(); } catch (e: any) { toast(e.message, 'error'); }
  }}>Save changes</button></>}>
    <div className="grid grid-4" style={{ marginBottom: 16 }}>
      <Stat label="Boards" value={data.boards.length} /><Stat label="Devices" value={data.devices.length} /><Stat label="Sensors" value={data.sensors.length} /><Stat label="Staff" value={data.members.length} />
    </div>
    <div className="form-row"><Field label="Plan"><input className="input" value={flags.plan} onChange={(e) => setFlags({ ...flags, plan: e.target.value })} /></Field>
      <Field label="Max boards"><input className="input" type="number" value={flags.max_boards} onChange={(e) => setFlags({ ...flags, max_boards: Number(e.target.value) })} /></Field></div>
    <Field label="Max devices"><input className="input" type="number" value={flags.max_devices} onChange={(e) => setFlags({ ...flags, max_devices: Number(e.target.value) })} /></Field>
    <label className="check"><input type="checkbox" checked={flags.device_registration_enabled} onChange={(e) => setFlags({ ...flags, device_registration_enabled: e.target.checked })} />Allow new device registration / feature access</label>
    <div className="divider" /><h4 style={{ fontSize: 13, marginBottom: 8 }}>Registered controllers and boards</h4>
    {!data.boards.length ? <p className="tiny">None registered.</p> : data.boards.map((b: any) => <div className="list-item" key={b.id}><div className="icon-box"><Icon.cpu /></div><div className="grow"><div className="title">{b.name}</div><div className="meta mono">{b.device_id} · {b.catalog_board_id || 'custom'}</div></div><StatusBadge status={b.status} /></div>)}
    <div className="divider" /><h4 style={{ fontSize: 13, marginBottom: 8 }}>Recent account activity & audit history</h4>
    {!data.activity.length ? <p className="tiny">No activity.</p> : data.activity.slice(0, 8).map((a: any) => <div className="list-item" key={a.id}><div className="grow"><div className="title">{a.action.replace(/\./g, ' ')}</div><div className="meta">{a.actor_email || a.actor_type}</div></div><span className="tiny">{timeAgo(a.created_at)}</span></div>)}
  </Modal>;
}

export function OwnerCustomerDetail() {
  const { id } = useParams();
  const { data, loading } = useLiveData<any>(id ? `/api/owner/customers/${id}` : null, [id]);
  if (loading) return <Loading />;
  if (!data) return <EmptyState title="Not found" text="Customer not found." />;
  return <><PageHead title={data.tenant.name} desc="Customer detail" actions={<Link className="btn" to="/owner/customers"><Icon.back />Back</Link>} />
    <div className="grid grid-4" style={{ marginBottom: 14 }}><Stat label="Boards" value={data.boards.length} /><Stat label="Devices" value={data.devices.length} /><Stat label="Sensors" value={data.sensors.length} /><Stat label="Staff" value={data.members.length} /></div>
    <Card title="Audit history" pad={false}><DataTable columns={[
      { key: 'created_at', label: 'When', render: (a: any) => timeFull(a.created_at) }, { key: 'action', label: 'Action' }, { key: 'actor_email', label: 'Actor' },
    ]} rows={data.activity} empty={<EmptyState icon="file" title="No history" text="No audited actions yet." />} /></Card></>;
}

export function OwnerStaff() {
  const { data, loading } = useLiveData<any[]>('/api/owner/staff');
  const [search, setSearch] = useState('');
  const rows = (data || []).filter((m: any) => ((m.profile?.email || '') + (m.tenant_name || '') + m.role_key).toLowerCase().includes(search.toLowerCase()));
  return <>
    <PageHead title="Staff & Access" desc="All memberships across customer workspaces. Permission changes are enforced server-side." />
    <Card pad={false}><div className="card-head"><h3>Memberships</h3><div className="search" style={{ width: 220 }}><Icon.search /><input className="input" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} /></div></div>
      {loading ? <div className="card-pad"><Skeleton height={160} /></div> : <DataTable columns={[
        { key: 'email', label: 'Member', render: (m: any) => m.profile?.email || m.invited_email || '—' },
        { key: 'tenant_name', label: 'Workspace' }, { key: 'role_key', label: 'Role' },
        { key: 'status', label: 'Status', render: (m: any) => <StatusBadge status={m.status} /> },
        { key: 'created_at', label: 'Added', render: (m: any) => timeAgo(m.created_at) },
      ]} rows={rows} empty={<EmptyState icon="users" title="No memberships" text="Staff invitations appear here." />} />}</Card>
  </>;
}

// ============================================================================
// EMQX management — read-only status; credentials live in Cloudflare Pages secrets
// ============================================================================
export function OwnerEmqx() {
  const { data, loading, refresh } = useLiveData<any>('/api/owner/emqx/settings');
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const s = data?.settings || {};
  const val = (k: string) => {
    const v = s[k] ?? s[`mqtt.${k}`];
    if (v == null || v === '') return 'Not configured';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  return <>
    <PageHead title="EMQX Management" desc="Deployment status, device provisioning strategy and usage synchronization. Credentials are encrypted Cloudflare secrets and never exposed to frontend JavaScript." actions={<><Link className="btn btn-primary" to="/owner/settings/integrations"><Icon.link />View integration status</Link>
      <button className="btn" disabled={testing} onClick={async () => { setTesting(true); try { const h = await api.post('/api/owner/emqx/test'); toast(h.connected ? 'Broker connection successful' : `Unavailable: ${h.detail}`, h.connected ? 'ok' : 'error'); refresh(); } catch (e: any) { toast(e.message, 'error'); } finally { setTesting(false); } }}><Icon.refresh />{testing ? 'Testing…' : 'Test connection'}</button>
      <button className="btn" disabled={syncing} onClick={async () => { setSyncing(true); try { const r = await api.post('/api/owner/emqx/sync-usage'); toast(r.message); refresh(); } catch (e: any) { toast(e.message, 'error'); } finally { setSyncing(false); } }}>{syncing ? 'Syncing…' : 'Sync usage'}</button></>} />
    <Notice tone="info">This page is read-only. Set EMQX API credentials and broker addresses in Cloudflare Pages → Settings → Variables and Secrets, then redeploy. Saved values are never displayed in the browser. <Link to="/owner/settings/integrations">View integration status</Link>.</Notice>
    {loading ? <Loading rows={2} /> : <div className="grid grid-2" style={{ alignItems: 'start', marginTop: 14 }}>
      <Card title="Deployment configuration" sub="Non-secret status from platform_settings and encrypted credential metadata">
        <div className="kv">
          <dt>Deployment API endpoint</dt><dd className="mono">{val('deployment_endpoint')}</dd>
          <dt>MQTT broker hostname</dt><dd className="mono">{val('broker_host')}</dd>
          <dt>TLS port</dt><dd className="mono">{val('port_tls')}</dd>
          <dt>WSS port</dt><dd className="mono">{val('wss_port')}</dd>
          <dt>WebSocket endpoint</dt><dd className="mono">{val('wss_host')}</dd>
          <dt>Provider</dt><dd>{data?.provider || 'EMQX Cloud Serverless'}</dd>
          <dt>Broker status</dt><dd>{data?.health?.connected ? <Badge tone="on">Connected</Badge> : <Badge tone="danger">Unavailable</Badge>}</dd>
          <dt>Last sync</dt><dd>{s['mqtt.last_sync_at'] ? timeAgo(s['mqtt.last_sync_at']) : 'Never'}</dd>
        </div>
      </Card>
      <div style={{ display: 'grid', gap: 14 }}>
        <Card title="Connection status"><HealthRow ok={data?.health?.connected} label={data?.health?.detail} foot={data?.health?.checked_at ? timeFull(data.health.checked_at) : undefined} />
          {data?.health?.clientCount != null && <div className="metric-row" style={{ marginTop: 10 }}><span>Active client connections</span><span className="v">{data.health.clientCount}</span></div>}</Card>
        <Card title="Provisioning strategy"><div className="kv">
          <dt>Authentication</dt><dd>Built-in database, one user per device</dd>
          <dt>Authorization</dt><dd>Per-username allow rules + deny-all fallback</dd>
          <dt>HTTP auth hook</dt><dd>Not supported on Serverless</dd>
          <dt>Device topics</dt><dd className="mono">v1/tenants/{"{id}"}/devices/{"{id}"}/…</dd>
          <dt>Admin secrets</dt><dd>Never sent to browsers or devices</dd>
        </div><div className="divider" />{(data?.capability_notes || []).map((n: string, i: number) => <p className="tiny" key={i} style={{ marginBottom: 6 }}>• {n}</p>)}</Card>
        <Card title="Provider portability"><p className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>All MQTT operations go through the <span className="mono">MqttProvider</span> port. Switching to a self-hosted EMQX or Mosquitto means adding one adapter — device, tenant and UI code do not change.</p></Card>
      </div>
    </div>}
  </>;
}

// ============================================================================
// Usage & monitoring — honest unavailable states
// ============================================================================
export function OwnerUsage() {
  const { data, loading, refresh } = useLiveData<any>('/api/owner/usage');
  const toast = useToast();
  const [manual, setManual] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const q = data?.quotas || EMQX_QUOTAS;
  const thresholds: number[] = data?.thresholds || WARNING_THRESHOLDS as any;
  const o = data?.official || {};
  const pct = (v: any, total: number) => v == null || !o.available ? null : Math.min(100, (Number(v) / total) * 100);
  const quotaRows = [
    { key: 'traffic_bytes', label: 'Monthly traffic', value: o.traffic_bytes, quota: q.trafficBytes ?? 1_073_741_824, fmt: fmtBytes },
    { key: 'session_minutes', label: 'Session minutes', value: o.session_minutes, quota: q.sessionMinutes, fmt: (x: any) => fmt(x, 0) },
    { key: 'rule_actions', label: 'Rule actions', value: o.rule_actions, quota: q.ruleActions, fmt: (x: any) => fmt(x, 0) },
    { key: 'connections_peak', label: 'Connections', value: o.connections_peak, quota: q.maxConnections ?? 1000, fmt: (x: any) => fmt(x, 0) },
  ] as any[];
  return <>
    <PageHead title="Usage & Monitoring" desc="Official provider-reported values are shown separately from application-side estimates. Unavailable metrics are labelled, never invented." actions={<><button className="btn" disabled={syncing} onClick={async () => { setSyncing(true); try { const r = await api.post('/api/owner/emqx/sync-usage'); toast(r.message); refresh(); } catch (e: any) { toast(e.message, 'error'); } finally { setSyncing(false); } }}><Icon.refresh />{syncing ? 'Syncing…' : 'Sync from EMQX'}</button>
      <button className="btn btn-primary" onClick={() => setManual(true)}><Icon.plus />Enter console values</button></>} />
    {loading ? <Loading rows={3} /> : <>
      {!o.available && <div style={{ marginBottom: 14 }}><Notice tone="warn">No provider-reported usage snapshot has been recorded for this month. The EMQX Cloud Serverless Deployment API does not expose monthly traffic, session minutes or rule actions — those are shown on the provider console (updated hourly). Use “Enter console values” to record an owner-verified snapshot.</Notice></div>}
      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Stat label="Traffic quota" value={fmtBytes(q.trafficBytes)} foot="Provider free tier" icon="drive" />
        <Stat label="Session minutes quota" value={fmt(q.sessionMinutes, 0)} foot="Per month" icon="clock" />
        <Stat label="Active connections" value={o.connections_peak ?? 'Unavailable'} foot={`Max ${fmt(q.maxConnections ?? 1000, 0)}`} icon="wifi" />
        <Stat label="Warning thresholds" value={`${thresholds.join('/')}%`} foot="Configurable in Platform Settings" icon="warning" />
      </div>
      <div className="grid grid-2" style={{ alignItems: 'start', marginBottom: 14 }}>
        <Card title="Quota utilisation" sub="Based only on recorded official / owner-verified snapshots">
          {quotaRows.map((r) => {
            const v = pct(r.value, r.quota);
            const unavailable = !o.available || r.value == null;
            return <div key={r.key} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.label}</span>
                <span className="mono tiny">{unavailable ? 'Unavailable' : `${r.fmt(r.value)} / ${r.fmt(r.quota)}`}</span></div>
              {unavailable ? <div className="progress"><div style={{ width: 0 }} /></div> : <Progress value={v!} tone={v! >= 90 ? 'danger' : v! >= 75 ? 'warn' : ''} />}
              <div className="tiny" style={{ marginTop: 5 }}>{unavailable ? data?.unavailable?.[r.key] || 'Not provided by the EMQX Serverless Deployment API' : `${v!.toFixed(1)}% used · ${r.fmt(Number(r.quota) - Number(r.value))} remaining`}</div>
            </div>;
          })}
        </Card>
        <Card title="Traffic breakdown" sub="Only values actually reported by the provider or owner">
          <div className="metric-row"><span>Inbound traffic</span><span className="v">{data?.unavailable?.trafficInBytes && !o.traffic_in_bytes ? 'Unavailable' : fmtBytes(o.traffic_in_bytes)}</span></div>
          <div className="metric-row"><span>Outbound traffic</span><span className="v">{data?.unavailable?.trafficOutBytes && !o.traffic_out_bytes ? 'Unavailable' : fmtBytes(o.traffic_out_bytes)}</span></div>
          <div className="metric-row"><span>Packets</span><span className="v">{o.packets ? fmt(o.packets, 0) : 'Unavailable'}</span></div>
          <div className="metric-row"><span>Message volume</span><span className="v">{o.messages ? fmt(o.messages, 0) : 'Unavailable'}</span></div>
          {Object.entries(data?.unavailable || {}).filter(([, v]) => !!v).map(([k, v]: any) => <p className="tiny" key={k} style={{ marginTop: 8 }}>• {v}</p>)}
        </Card>
      </div>
      <div className="grid grid-2" style={{ alignItems: 'start', marginBottom: 14 }}>
        <Card title="Usage history" sub="Daily snapshots" actions={<span className="tiny">{data?.charts?.daily?.length || 0} points</span>}>
          {data?.charts?.daily?.length ? <MiniChart points={data.charts.daily.map((s: any) => Number(s.traffic_bytes || s.connections_peak || 0))} labels={data.charts.daily.map((s: any) => new Date(s.period_start).toLocaleDateString([], { month: 'short', day: 'numeric' }))} /> : <EmptyState icon="chart" title="No daily history" text={data?.unavailable?.dailyChart || 'No daily provider snapshot available.'} />}
        </Card>
        <Card title="Monthly history" sub="Recorded snapshots">{data?.charts?.monthly?.length ? <MiniChart points={data.charts.monthly.map((s: any) => Number(s.traffic_bytes || 0))} labels={data.charts.monthly.map((s: any) => new Date(s.period_start).toLocaleDateString([], { month: 'short' }))} /> : <EmptyState icon="chart" title="No monthly history" text="Owner-verified monthly snapshots will appear here." />}</Card>
      </div>
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card title="Application-side estimates" sub="Clearly separated from official provider usage">
          <div className="metric-row"><span>Command messages</span><span className="v">{fmt(data?.estimates?.command_messages, 0)}</span></div>
          <div className="metric-row"><span>Telemetry messages</span><span className="v">{fmt(data?.estimates?.telemetry_messages, 0)}</span></div>
          <div className="metric-row"><span>Estimated payload bytes</span><span className="v">{fmtBytes(data?.estimates?.estimated_bytes)}</span></div>
          <div className="tiny" style={{ marginTop: 10 }}>{data?.estimates?.note}</div>
        </Card>
        <Card title="Snapshot log" sub="Source and recorded time" pad={false}><DataTable columns={[
          { key: 'period_start', label: 'Period', render: (s: any) => new Date(s.period_start).toLocaleDateString() },
          { key: 'source', label: 'Source', render: (s: any) => <Badge tone={s.source === 'provider_api' ? 'on' : 'info'}>{s.source}</Badge> },
          { key: 'traffic_bytes', label: 'Traffic', render: (s: any) => s.traffic_bytes != null ? fmtBytes(s.traffic_bytes) : '—' },
          { key: 'connections_peak', label: 'Connections', render: (s: any) => s.connections_peak ?? '—' },
          { key: 'recorded_at', label: 'Recorded', render: (s: any) => timeAgo(s.recorded_at) },
        ]} rows={data?.snapshots || []} empty={<EmptyState icon="file" title="No snapshots" text="Sync live connection counts or enter console values." />} /></Card>
      </div>
      <div style={{ height: 14 }} />
      <Card title="Synchronisation runs" pad={false}><DataTable columns={[
        { key: 'started_at', label: 'Started', render: (r: any) => timeFull(r.started_at) }, { key: 'kind', label: 'Kind' },
        { key: 'status', label: 'Result', render: (r: any) => <StatusBadge status={r.status === 'success' ? 'success' : 'pending'} /> },
        { key: 'detail', label: 'Detail', render: (r: any) => <span className="tiny">{r.detail?.note || '—'}</span> },
      ]} rows={data?.sync_runs || []} empty={<EmptyState icon="refresh" title="No sync runs" text="Run a sync to see what the provider actually exposes." />} /></Card>
    </>}
    {manual && <ManualSnapshotModal onClose={() => setManual(false)} onDone={refresh} />}
  </>;
}

function ManualSnapshotModal({ onClose, onDone }: any) {
  const toast = useToast();
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const [f, setF] = useState<any>({
    period_start: start.toISOString().slice(0, 10), period_end: end.toISOString().slice(0, 10),
    granularity: 'month', source: 'owner_manual', traffic_bytes: '', traffic_in_bytes: '', traffic_out_bytes: '',
    packets: '', session_minutes: '', connections_peak: '', messages: '', rule_actions: '', raw: { note: 'Entered from the EMQX Cloud console by the platform owner' },
  });
  const num = (v: string) => v === '' ? null : Number(v);
  return <Modal title="Record provider-console usage" onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={async () => {
    try { await api.post('/api/owner/usage/snapshots', { ...f,
      period_start: new Date(f.period_start).toISOString(), period_end: new Date(f.period_end).toISOString(),
      traffic_bytes: num(f.traffic_bytes), traffic_in_bytes: num(f.traffic_in_bytes), traffic_out_bytes: num(f.traffic_out_bytes),
      packets: num(f.packets), session_minutes: num(f.session_minutes), connections_peak: num(f.connections_peak),
      messages: num(f.messages), rule_actions: num(f.rule_actions) }); toast('Owner-verified snapshot recorded'); onDone(); onClose(); } catch (e: any) { toast(e.message, 'error'); }
  }}>Save snapshot</button></>}>
    <Notice>Only enter values you read from the EMQX Cloud console. Leave a field blank if the provider does not report it; it will be shown as “Unavailable”, not zero.</Notice>
    <div className="form-row" style={{ marginTop: 14 }}><Field label="Period start"><input className="input" type="date" value={f.period_start} onChange={(e) => setF({ ...f, period_start: e.target.value })} /></Field>
      <Field label="Period end"><input className="input" type="date" value={f.period_end} onChange={(e) => setF({ ...f, period_end: e.target.value })} /></Field></div>
    <div className="form-row"><Field label="Traffic (bytes)"><input className="input" type="number" value={f.traffic_bytes} onChange={(e) => setF({ ...f, traffic_bytes: e.target.value })} /></Field>
      <Field label="Inbound (bytes)"><input className="input" type="number" value={f.traffic_in_bytes} onChange={(e) => setF({ ...f, traffic_in_bytes: e.target.value })} /></Field></div>
    <div className="form-row"><Field label="Outbound (bytes)"><input className="input" type="number" value={f.traffic_out_bytes} onChange={(e) => setF({ ...f, traffic_out_bytes: e.target.value })} /></Field>
      <Field label="Packets"><input className="input" type="number" value={f.packets} onChange={(e) => setF({ ...f, packets: e.target.value })} /></Field></div>
    <div className="form-row"><Field label="Session minutes"><input className="input" type="number" value={f.session_minutes} onChange={(e) => setF({ ...f, session_minutes: e.target.value })} /></Field>
      <Field label="Peak connections"><input className="input" type="number" value={f.connections_peak} onChange={(e) => setF({ ...f, connections_peak: e.target.value })} /></Field></div>
    <div className="form-row"><Field label="Messages"><input className="input" type="number" value={f.messages} onChange={(e) => setF({ ...f, messages: e.target.value })} /></Field>
      <Field label="Rule actions"><input className="input" type="number" value={f.rule_actions} onChange={(e) => setF({ ...f, rule_actions: e.target.value })} /></Field></div>
  </Modal>;
}

// ============================================================================
// Platform board library + settings + audit
// ============================================================================
export function OwnerBoards() {
  const { data, loading, refresh } = useLiveData<any[]>('/api/owner/boards');
  const toast = useToast();
  return <>
    <PageHead title="Board Library" desc="Platform-wide catalog. Verified pin maps are versioned; customer custom boards are separate." />
    <Card pad={false}>{loading ? <div className="card-pad"><Skeleton height={180} /></div> : <DataTable columns={[
      { key: 'model', label: 'Model', render: (b: any) => <div><div style={{ fontWeight: 600 }}>{b.model}</div><div className="tiny mono">{b.id}</div></div> },
      { key: 'chip_family', label: 'Chip family' }, { key: 'revision', label: 'Revision' },
      { key: 'pin_count', label: 'Verified pin rows', render: (b: any) => b.pin_count || <Badge tone="warn">Pending</Badge> },
      { key: 'status', label: 'Availability', render: (b: any) => b.active ? <Badge tone="on">Enabled</Badge> : <Badge>Disabled</Badge> },
      { key: 'source', label: 'Source', render: (b: any) => b.doc_source_url ? <a className="tiny" href={b.doc_source_url} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>Official docs ↗</a> : '—' },
      { key: 'actions', label: '', render: (b: any) => <button className="btn btn-sm" onClick={async () => { try { await api.patch(`/api/owner/boards/${b.id}`, { active: !b.active }); toast('Board availability updated'); refresh(); } catch (e: any) { toast(e.message, 'error'); } }}>{b.active ? 'Disable' : 'Enable'}</button> },
    ]} rows={data || []} empty={<EmptyState icon="layers" title="No board definitions" text="Run supabase/schema.sql to seed verified boards." />} />}</Card>
  </>;
}

export function OwnerSettings() {
  const { data, loading, refresh } = useLiveData<any[]>('/api/owner/settings');
  const toast = useToast();
  const [edit, setEdit] = useState<any>(null);
  const [announcement, setAnnouncement] = useState(false);
  return <>
    <PageHead title="Platform Settings" desc="Global registration, feature availability, security and warning thresholds." actions={<button className="btn btn-primary" onClick={() => setAnnouncement(true)}><Icon.plus />New announcement</button>} />
    <PlatformSettingsLinks />
    <Notice tone="info">Credentials are encrypted Cloudflare secrets and are not edited here. This page only lists non-secret platform defaults. <Link to="/owner/settings/integrations">View integration status</Link>.</Notice>
    <Card pad={false} style={{ marginTop: 14 }}>{loading ? <div className="card-pad"><Skeleton height={180} /></div> : <DataTable columns={[
      { key: 'key', label: 'Setting', render: (s: any) => <span className="mono">{s.key}</span> },
      { key: 'value', label: 'Value', render: (s: any) => <span className="mono">{JSON.stringify(s.value)}</span> },
      { key: 'is_secret', label: 'Secret', render: (s: any) => s.is_secret ? <Badge tone="danger">Secret</Badge> : <Badge>Public</Badge> },
      { key: 'updated_at', label: 'Updated', render: (s: any) => timeAgo(s.updated_at) },
      { key: 'actions', label: '', render: (s: any) => /secret|token|password|key/i.test(String(s.key))
        ? <Link className="btn btn-ghost btn-sm" to="/owner/settings/integrations"><Icon.lock />Manage</Link>
        : /^(registration|features|security|usage|mqtt)\./.test(String(s.key))
          ? <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setEdit(s)}><Icon.edit /></button>
          : <span className="tiny muted">Managed automatically</span> },
    ]} rows={data || []} empty={<EmptyState icon="settings" title="No settings" text="Platform defaults are seeded by supabase/schema.sql." />} />}</Card>
    {edit && <EditSettingModal setting={edit} onClose={() => setEdit(null)} onDone={refresh} />}
    {announcement && <AnnouncementModal onClose={() => setAnnouncement(false)} />}
  </>;
}

function AnnouncementModal({ onClose }: any) {
  const toast = useToast();
  const [f, setF] = useState({ title: '', body: '', severity: 'info', audience: 'all', ends_at: '' });
  return <Modal title="System announcement" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!f.title || !f.body} onClick={async () => {
    try { await api.post('/api/owner/announcements', { ...f, ends_at: f.ends_at ? new Date(f.ends_at).toISOString() : null }); toast('Announcement published'); onClose(); } catch (e: any) { toast(e.message, 'error'); }
  }}>Publish</button></>}>
    <Field label="Title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
    <Field label="Body"><textarea className="textarea" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
    <div className="form-row"><Field label="Severity"><select className="select" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}><option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option></select></Field>
      <Field label="Audience"><select className="select" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}><option value="all">All</option><option value="owners">Owners</option><option value="admins">Admins</option></select></Field></div>
    <Field label="Ends at (optional)"><input className="input" type="date" value={f.ends_at} onChange={(e) => setF({ ...f, ends_at: e.target.value })} /></Field>
  </Modal>;
}

export function OwnerAudit() {
  const { data, loading } = useLiveData<any[]>('/api/owner/audit');
  const [search, setSearch] = useState('');
  const rows = (data || []).filter((a: any) => (a.action + (a.actor_email || '') + (a.entity_id || '')).toLowerCase().includes(search.toLowerCase()));
  return <>
    <PageHead title="Audit Logs" desc="Every owner action, staff change, device command and administrative operation." />
    <Card pad={false}><div className="card-head"><h3>Platform audit trail</h3><div className="search" style={{ width: 240 }}><Icon.search /><input className="input" placeholder="Filter by action or actor" value={search} onChange={(e) => setSearch(e.target.value)} /></div></div>
      {loading ? <div className="card-pad"><Skeleton height={200} /></div> : <DataTable columns={[
        { key: 'created_at', label: 'When', render: (a: any) => timeFull(a.created_at) },
        { key: 'action', label: 'Action', render: (a: any) => <span className="mono">{a.action}</span> },
        { key: 'actor', label: 'Actor', render: (a: any) => a.actor_email || a.actor_type },
        { key: 'actor_type', label: 'Type', render: (a: any) => <Badge tone={a.actor_type === 'platform_admin' ? 'info' : ''}>{a.actor_type}</Badge> },
        { key: 'entity', label: 'Entity', render: (a: any) => `${a.entity_type || '—'} ${a.entity_id ? a.entity_id.slice(0, 8) : ''}` },
      ]} rows={rows} empty={<EmptyState icon="file" title="No audit records" text="Audited operations appear here." />} />}</Card>
  </>;
}


function EditSettingModal({ setting, onClose, onDone }: any) {
  const toast = useToast();
  const kind = Array.isArray(setting.value) || (setting.value && typeof setting.value === 'object') ? 'json'
    : typeof setting.value === 'boolean' ? 'boolean' : typeof setting.value === 'number' ? 'number' : 'text';
  const [text, setText] = useState(kind === 'json' ? JSON.stringify(setting.value, null, 2) : String(setting.value ?? ''));
  const [invalid, setInvalid] = useState(false);
  const parse = (): any => {
    if (kind === 'json') return JSON.parse(text);
    if (kind === 'boolean') return text === 'true';
    if (kind === 'number') return Number(text);
    return text;
  };
  const validate = (v: string) => {
    if (kind === 'json') { try { JSON.parse(v); setInvalid(false); } catch { setInvalid(true); } }
    else if (kind === 'number') setInvalid(!/^-?\d+(\.\d+)?$/.test(v));
    else setInvalid(false);
  };
  return <Modal title={setting.key} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
    <button className="btn btn-primary" disabled={invalid} onClick={async () => {
      let value: unknown;
      try { value = parse(); } catch { toast('Enter a valid value', 'error'); return; }
      try { await api.post('/api/owner/settings', { [setting.key]: value }); toast('Platform setting updated'); onDone(); onClose(); }
      catch (e: any) { toast(e.message, 'error'); }
    }}>Save</button></>}>
    {kind === 'boolean' ? <Field label="Enabled"><select className="select" value={text} onChange={(e) => setText(e.target.value)}><option value="true">Yes</option><option value="false">No</option></select></Field>
      : kind === 'number' ? <Field label="Number"><input className="input mono" type="number" value={text} onChange={(e) => { setText(e.target.value); validate(e.target.value); }} /></Field>
      : kind === 'text' ? <Field label="Value"><input className="input mono" value={text} onChange={(e) => { setText(e.target.value); validate(e.target.value); }} /></Field>
      : <Field label="Structured value (JSON)" hint="Used for lists and objects such as warning thresholds."><textarea className="textarea mono" value={text} onChange={(e) => { setText(e.target.value); validate(e.target.value); }} /></Field>}
    {invalid && <Notice tone="danger">{kind === 'number' ? 'Enter a valid number.' : 'Invalid JSON.'}</Notice>}
    <p className="tiny">Changes are audited. Credentials are managed in Integrations &amp; Secrets, never here.</p>
  </Modal>;
}

// ============================================================================
// Authentication (owner only, backend-verified)
// ============================================================================
const AUTH_SETTINGS: { key: string; label: string; unit: string; hint: string }[] = [
  { key: 'login_max_attempts', label: 'Max failed sign-ins', unit: 'attempts', hint: 'Per email and per IP inside the window' },
  { key: 'login_window_seconds', label: 'Attempt window', unit: 'seconds', hint: 'How long failed attempts are counted' },
  { key: 'login_lockout_seconds', label: 'Lockout duration', unit: 'seconds', hint: 'Block further attempts after the limit' },
  { key: 'session_ttl_hours', label: 'Absolute session lifetime', unit: 'hours', hint: 'Sessions expire even if still active' },
  { key: 'session_idle_hours', label: 'Idle session timeout', unit: 'hours', hint: 'Inactive sessions are revoked' },
  { key: 'max_sessions_per_user', label: 'Sessions per account', unit: 'sessions', hint: 'Oldest sessions are removed first' },
  { key: 'password_min_length', label: 'Minimum password length', unit: 'characters', hint: 'Minimum 8 characters' },
  { key: 'bcrypt_cost', label: 'Password hash cost', unit: '4–15', hint: 'bcrypt cost in the database (higher is slower)' },
  { key: 'recovery_code_count', label: 'Recovery codes per account', unit: 'codes', hint: 'Single-use codes shown once' },
  { key: 'recovery_code_ttl_hours', label: 'Recovery code lifetime', unit: 'hours', hint: 'Codes expire after this period' },
];

export function OwnerSecurity() {
  const { data, loading, refresh } = useLiveData<any>('/api/owner/auth');
  const { toast } = useAuth();
  const [values, setValues] = useState<Record<string, string>>({});
  const [reset, setReset] = useState<{ id: string; email: string; password: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  React.useEffect(() => {
    if (data?.config) setValues(Object.fromEntries(Object.entries(data.config).map(([k, v]) => [k, String(v)])));
  }, [data]);
  const save = async () => {
    try {
      for (const setting of AUTH_SETTINGS) {
        const raw = values[setting.key];
        if (raw !== undefined && String(data?.config?.[setting.key]) !== raw) {
          await api.post('/api/owner/auth/config', { key: setting.key, value: Number(raw) });
        }
      }
      toast('Authentication settings saved'); refresh();
    } catch (e: any) { toast(e.message, 'error'); }
  };
  const saveOne = async (key: string) => {
    try { await api.post('/api/owner/auth/config', { key, value: Number(values[key]) }); toast('Setting saved'); refresh(); }
    catch (e: any) { toast(e.message, 'error'); }
  };
  const doAction = async (path: string, payload: any) => {
    try { await api.post(path, payload); toast('Account updated'); refresh(); }
    catch (e: any) { toast(e.message, 'error'); }
  };
  const health = data?.health || {};
  const accounts: any[] = data?.accounts || [];
  return <>
    <PageHead title="Authentication & Security" desc="Custom database-backed accounts, sessions and rate limits. No third-party identity provider." />
    {loading ? <Loading rows={4} /> : <>
      <div className="grid grid-3" style={{ marginBottom: 14 }}>
        <Card title="Password hashing"><div className="kv">
          <dt>Status</dt><dd>{health.pgcrypto ? <Badge tone="on">Ready</Badge> : <Badge tone="danger">pgcrypto missing</Badge>}</dd>
          <dt>Algorithm</dt><dd>bcrypt + server-side HMAC pepper, inside Supabase PostgreSQL</dd>
        </div></Card>
        <Card title="Accounts & sessions"><div className="kv">
          <dt>Accounts</dt><dd>{health.accounts ?? '—'}</dd>
          <dt>Active sessions</dt><dd>{health.active_sessions ?? '—'}</dd>
          <dt>Locked scopes</dt><dd>{health.locked_scopes ?? '—'}</dd>
        </div></Card>
        <Card title="Login protection" actions={<button className="btn btn-sm" onClick={() => doAction('/api/owner/auth/attempts/reset', {})}>Clear lockouts</button>}>
          <p className="muted" style={{ fontSize: 12.5 }}>Failed sign-ins are limited per account and per IP. Clear lockouts here if a legitimate user is blocked.</p>
        </Card>
      </div>
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card title="Configurable limits" sub="Stored in the database, enforced on every request"
          actions={<button className="btn btn-primary btn-sm" onClick={save}>Save all</button>}>
          {AUTH_SETTINGS.map((setting) => <div className="form-row" key={setting.key} style={{ marginBottom: 8, alignItems: 'end' }}>
            <Field label={setting.label} hint={setting.hint}><input className="input" type="number" min={1} value={values[setting.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [setting.key]: e.target.value }))} /></Field>
            <div style={{ display: 'flex', gap: 6, paddingBottom: 2 }}>
              <span className="tiny" style={{ minWidth: 58, alignSelf: 'center' }}>{setting.unit}</span>
              <button className="btn btn-sm" onClick={() => saveOne(setting.key)}>Set</button>
            </div>
          </div>)}
        </Card>
        <div style={{ display: 'grid', gap: 14 }}>
          <Card title="Accounts" sub="Password hashes and tokens are never sent to the browser">
            <DataTable columns={[
              { key: 'email', label: 'Account' },
              { key: 'role', label: 'Role', render: (r: any) => human(r.role) },
              { key: 'status', label: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
              { key: 'sessions', label: 'Sessions', render: (r: any) => String(r.active_sessions ?? 0) },
              { key: 'actions', label: '', render: (r: any) => <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                <button className="btn btn-sm" onClick={() => doAction(`/api/owner/auth/accounts/${r.user_id}/status`, { status: r.status === 'active' ? 'suspended' : 'active' })}>{r.status === 'active' ? 'Suspend' : 'Activate'}</button>
                <button className="btn btn-sm" onClick={() => setReset({ id: r.user_id, email: r.email, password: '' })}>Reset password</button>
                <button className="btn btn-sm" onClick={async () => {
                  try { const r2 = await api.post<any>(`/api/owner/auth/accounts/${r.user_id}/recovery-codes`, {}); setCodes(r2.recovery_codes); refresh(); }
                  catch (e: any) { toast(e.message, 'error'); }
                }}>Recovery codes</button>
              </div> },
            ]} rows={accounts} empty="No accounts yet" />
          </Card>
          <Card title="How access is granted"><div className="kv">
            <dt>First account</dt><dd>Platform Owner, decided atomically in one database transaction</dd>
            <dt>Later accounts</dt><dd>Customer, with an independent home workspace</dd>
            <dt>Sessions</dt><dd>Random token, SHA-256 hash stored, HttpOnly · Secure · SameSite cookie</dd>
            <dt>Owner Console</dt><dd>Every API call checks role and permissions in the database</dd>
          </div></Card>
        </div>
      </div>
    </>}
    {reset && <Modal title="Set a new password" onClose={() => setReset(null)} footer={<>
      <button className="btn" onClick={() => setReset(null)}>Cancel</button>
      <button className="btn btn-primary" disabled={reset.password.length < 10} onClick={async () => {
        try { await api.post(`/api/owner/auth/accounts/${reset.id}/reset-password`, { password: reset.password }); toast('Password reset; all sessions revoked'); setReset(null); refresh(); }
        catch (e: any) { toast(e.message, 'error'); }
      }}>Reset password</button>
    </>}>
      <Field label="Account"><input className="input" value={reset.email} readOnly /></Field>
      <Field label="New password" hint="At least 10 characters. All existing sessions will be revoked."><input className="input" type="password" minLength={10} value={reset.password} onChange={(e) => setReset({ ...reset, password: e.target.value })} /></Field>
    </Modal>}
    {codes && <Modal title="New recovery codes" onClose={() => setCodes(null)} footer={<button className="btn btn-primary" onClick={() => setCodes(null)}>Done</button>}>
      <p className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>Give these single-use codes to the account holder. They are shown only once.</p>
      <div className="card" style={{ padding: 14 }}><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }} className="mono">{codes.map((c) => <div key={c}>{c}</div>)}</div></div>
    </Modal>}
  </>;
}
