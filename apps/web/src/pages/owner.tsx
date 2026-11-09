import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, useLiveData } from '../api';
import { useAuth } from '../state';
import {
  Badge, Card, DataTable, EmptyState, Field, Icon, Loading, MiniChart, Modal, Notice,
  PageHead, Progress, Skeleton, Stat, StatusBadge, fmt, fmtBytes, timeAgo, timeFull, human } from '../components';
import { EMQX_QUOTAS, WARNING_THRESHOLDS } from '@homecoreos/core';

function useToast() { return useAuth().toast; }

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
/** Facts from the bridge's own heartbeat and from accepted controller messages. */
function BridgeFacts({ data }: { data: any }) {
  const b = data?.bridge || {};
  const ing = data?.ingress || null;
  const reg = data?.last_registration || null;
  const row = (label: string, value: React.ReactNode) => <div className="metric-row" style={{ marginBottom: 8 }}><span>{label}</span><span className="v" style={{ textAlign: 'right' }}>{value}</span></div>;
  if (!data) return <p className="tiny">Loading…</p>;
  const runState = b.state === 'running' ? <Badge tone="on">Running · heartbeat {b.age_seconds ?? 0} s ago</Badge>
    : b.state === 'stale' ? <Badge tone="danger">Not reporting · last heartbeat {b.age_seconds} s ago</Badge>
      : <Badge tone="danger">Never reported</Badge>;
  const brokerState = b.mqtt_connected && b.subscribed ? <Badge tone="on">Connected and subscribed</Badge>
    : b.state === 'running' ? <Badge tone="danger">Not connected to the broker</Badge>
      : <Badge tone="danger">Unknown: the bridge is not reporting</Badge>;
  return <>
    {row('Bridge process', runState)}
    {row('Bridge to the MQTT broker', brokerState)}
    {b.last_error && row('Last bridge error', <span className="tiny" style={{ color: 'var(--danger, #d33)' }}>{b.last_error}{b.last_error_at ? ` · ${timeAgo(b.last_error_at)}` : ''}</span>)}
    {row('Messages received by the bridge', `${b.received ?? 0} received · ${b.forwarded ?? 0} forwarded · ${b.dropped ?? 0} dropped`)}
    {row('Last controller message accepted by HomecoreOS', ing?.last_accepted_at ? timeAgo(ing.last_accepted_at) : 'Never')}
    {row('Last controller registration confirmed', reg?.at ? timeAgo(reg.at) : 'Never')}
    {!b.state || b.state !== 'running' ? <Notice tone="warn">Controllers cannot finish pairing while the bridge is not running. Start it as a supervised service (DEPLOYMENT.md, section 3A).</Notice> : null}
  </>;
}

export function OwnerEmqx() {
  const { data, loading, refresh } = useLiveData<any>('/api/owner/emqx/settings');
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [authCheck, setAuthCheck] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const s = data?.settings || {};
  const val = (k: string) => {
    const v = s[k] ?? s[`mqtt.${k}`];
    if (v == null || v === '') return 'Not configured';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  return <>
    <PageHead title="EMQX Management" desc="Deployment status, device provisioning strategy and usage synchronization. Credentials are encrypted Cloudflare secrets and never exposed to frontend JavaScript." actions={<><Link className="btn btn-primary" to="/owner/settings/integrations"><Icon.link />View integration status</Link>
      <button className="btn" disabled={testing} onClick={async () => { setTesting(true); try { const h = await api.post('/api/owner/emqx/test'); toast(h.connected ? 'Broker connection successful' : `Unavailable: ${h.detail}`, h.connected ? 'ok' : 'error'); refresh(); } catch (e: any) { toast(e.message, 'error'); } finally { setTesting(false); } }}><Icon.refresh />{testing ? 'Testing…' : 'Test connection'}</button>
      <button className="btn" disabled={syncing} onClick={async () => { setSyncing(true); try { const r = await api.post('/api/owner/emqx/sync-usage'); toast(r.message); refresh(); } catch (e: any) { toast(e.message, 'error'); } finally { setSyncing(false); } }}>{syncing ? 'Syncing…' : 'Sync usage'}</button>
      <button className="btn" disabled={checking} onClick={async () => {
        setChecking(true); setAuthCheck(null);
        try { const r = await api.post('/api/owner/emqx/device-auth-check'); setAuthCheck(r);
          toast(r.ok ? 'Device authentication works end to end' : 'Device authentication needs attention', r.ok ? 'ok' : 'error'); }
        catch (e: any) { toast(e.message, 'error'); }
        finally { setChecking(false); }
      }}><Icon.shieldOk />{checking ? 'Checking…' : 'Check device authentication'}</button></>} />
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
          <dt>Last usage sync</dt><dd>{s['mqtt.last_sync_at'] ? timeAgo(s['mqtt.last_sync_at']) : 'Never'}</dd>
        </div>
      </Card>
      <div style={{ display: 'grid', gap: 14 }}>
        <Card title="Platform bridge and broker" sub="Each line is reported by the component it describes. The REST check below is not proof of MQTT.">
          <BridgeFacts data={data} />
        </Card>
        <Card title="Deployment API (REST only)" sub="Shows that the website can call EMQX's management API. It says nothing about the bridge or controllers.">
          <HealthRow ok={data?.health?.connected} label={data?.health?.detail} foot={data?.health?.checked_at ? timeFull(data.health.checked_at) : undefined} />
          {data?.health?.clientCount != null && <div className="metric-row" style={{ marginTop: 10 }}><span>Client connections at EMQX (all clients, including the bridge)</span><span className="v">{data.health.clientCount}</span></div>}</Card>
        <Card title="Provisioning strategy"><div className="kv">
          <dt>Authentication</dt><dd>Built-in database, one user per device</dd>
          <dt>Authorization</dt><dd>Per-username allow rules + deny-all fallback</dd>
          <dt>HTTP auth hook</dt><dd>Not supported on Serverless</dd>
          <dt>Device topics</dt><dd className="mono">v1/tenants/{"{id}"}/devices/{"{id}"}/…</dd>
          <dt>Admin secrets</dt><dd>Never sent to browsers or devices</dd>
        </div><div className="divider" />{(data?.capability_notes || []).map((n: string, i: number) => <p className="tiny" key={i} style={{ marginBottom: 6 }}>• {n}</p>)}</Card>
        <Card title="Device authentication self-check"
          sub="Runs the provisioning calls pairing uses, then removes the probe account">
          {!authCheck ? <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
            Nothing here is assumed. The check creates one temporary device account, confirms the authenticator holds it,
            and deletes it again, so you can see what this deployment really supports before a customer pairs a controller.
          </p> : <div style={{ display: 'grid', gap: 8 }}>
            {authCheck.checks.map((c: any) => <div key={c.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              {c.ok ? <Badge tone="on" icon="check">Works</Badge> : <Badge tone="danger" icon="fail">Failed</Badge>}
              <div><div style={{ fontSize: 12.5, fontWeight: 600 }}>{c.label}</div><div className="tiny">{c.detail}</div></div>
            </div>)}
            <div className="tiny">{authCheck.note}</div>
          </div>}
        </Card>
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
