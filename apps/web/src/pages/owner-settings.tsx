/** Owner Console — Platform Settings and Authentication & Security. */
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useLiveData } from '../api';
import { useAuth } from '../state';
import {
  Badge, Card, DataTable, EmptyState, ErrorState, Field, Icon, Loading,
  Modal, Notice, PageHead, StatusBadge, timeAgo, timeFull,
} from '../components';

function useToast() { return useAuth().toast; }

/* -------------------------------------------------------------------------- */
/* Platform Settings — only values the backend actually reads                */
/* -------------------------------------------------------------------------- */

type SettingDef = {
  key: string; title: string; description: string; kind: 'boolean' | 'number' | 'json';
  unit?: string; min?: number; max?: number; sensitive?: boolean;
};
const SETTING_GROUPS: { id: string; title: string; description: string; icon: any; settings: SettingDef[] }[] = [
  { id: 'registration', title: 'Registration & pairing', description: 'How long a controller pairing code stays valid, and how many codes a home can request.', icon: 'plug', settings: [
    { key: 'registration.pairing_ttl_seconds', title: 'Pairing code lifetime', description: 'How many seconds a one-time controller code stays valid. Shorter is safer; 900 seconds (15 minutes) is the default.', kind: 'number', unit: 'seconds', min: 60, max: 86400, sensitive: true },
    { key: 'registration.rate_limit_per_hour', title: 'Pairing codes per hour', description: 'The maximum number of new codes one home can create in an hour. This limits repeated setup attempts.', kind: 'number', unit: 'per hour', min: 1, max: 100, sensitive: true },
  ] },
  { id: 'features', title: 'Customer features', description: 'Turn a feature off and the API stops accepting requests for it immediately. Changes are confirmed before saving.', icon: 'grid', settings: [
    { key: 'features.ota', title: 'Firmware updates', description: 'When off, controllers cannot be sent a firmware update. Existing releases and update history stay untouched.', kind: 'boolean', sensitive: true },
    { key: 'features.automation', title: 'Automation rules', description: 'When off, new rules cannot be created and existing rules cannot be run manually. Stored rules are kept.', kind: 'boolean', sensitive: true },
    { key: 'features.custom_boards', title: 'Custom board definitions', description: 'When off, customers cannot add their own board pin maps. Verified manufacturer boards remain available.', kind: 'boolean', sensitive: true },
    { key: 'features.staff_invites', title: 'Staff invitations', description: 'When off, home owners cannot invite additional staff accounts. Existing staff keep their access.', kind: 'boolean', sensitive: true },
  ] },
  { id: 'usage', title: 'Usage warnings', description: 'Thresholds used across the platform when showing quota usage. These change the display, not your provider limits.', icon: 'chart', settings: [
    { key: 'usage.warning_thresholds', title: 'Warning thresholds', description: 'Percentages between 1 and 100 that trigger a warning colour on usage charts. Enter a comma-separated list, for example 50, 75, 90, 100.', kind: 'json' },
    { key: 'usage.quotas', title: 'Displayed quota reference', description: 'Reference values shown next to measured usage. Your real limits are set by your EMQX plan.', kind: 'json' },
  ] },
];

function SettingRow({ def, value, onSaved }: { def: SettingDef; value: any; onSaved: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = () => {
    setDraft(def.kind === 'boolean' ? String(value === true)
      : def.kind === 'json' ? (Array.isArray(value) ? value.join(', ') : JSON.stringify(value ?? {}))
      : String(value ?? ''));
    setConfirm(false); setError(''); setEditing(true);
  };
  const parse = (): any => {
    if (def.kind === 'boolean') return draft === 'true';
    if (def.kind === 'number') {
      const n = Number(draft);
      if (!Number.isInteger(n) || (def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
        throw new Error(`Enter a whole number between ${def.min} and ${def.max}.`);
      }
      return n;
    }
    if (def.key === 'usage.warning_thresholds') {
      const arr = draft.split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
      if (!arr.length || arr.some((n) => n < 1 || n > 100)) throw new Error('Enter percentages from 1 to 100, separated by commas.');
      return arr;
    }
    return JSON.parse(draft);
  };
  const save = async () => {
    let parsed: any;
    try { parsed = parse(); } catch (e: any) { setError(e.message || 'Enter a valid value.'); return; }
    if (def.sensitive && !confirm) { setError('Tick the confirmation box before saving this change.'); return; }
    setBusy(true); setError('');
    try {
      await api.post('/api/owner/settings', { [def.key]: parsed, confirm: true });
      toast(`${def.title} saved`); setEditing(false); onSaved();
    } catch (e: any) { setError(e.message || 'Could not save this setting.'); }
    finally { setBusy(false); }
  };
  const display = def.kind === 'boolean' ? (value === true ? 'On' : 'Off')
    : def.kind === 'json' ? (Array.isArray(value) ? value.join(', ') : JSON.stringify(value))
    : `${value ?? '—'}${def.unit ? ` ${def.unit}` : ''}`;
  return <div className="setting-row">
    <div><div className="setting-title">{def.title}</div><div className="setting-desc">{def.description}</div>
      <div style={{ marginTop: 8 }}><Badge tone={def.kind === 'boolean' ? (value === true ? 'on' : 'off') : 'info'}>
        Current: {display}</Badge></div></div>
    <div className="setting-control">
      {!editing ? <button className="btn btn-sm" onClick={start}><Icon.edit />Change</button> : <>
        {def.kind === 'boolean' ? <select className="select" style={{ width: 120 }} value={draft} onChange={(e) => setDraft(e.target.value)}>
          <option value="true">On</option><option value="false">Off</option></select>
          : <input className="input mono" style={{ width: 180 }} value={draft} onChange={(e) => setDraft(e.target.value)} />}
        <button className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy} aria-busy={busy || undefined}>{busy ? 'Saving…' : 'Save'}</button>
      </>}
    </div>
    {editing && <div style={{ gridColumn: '1 / -1' }}>
      {def.sensitive && <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={confirm}
        onChange={(e) => setConfirm(e.target.checked)} />I understand this changes what customers can do immediately</label>}
      {error && <div className="field-msg field-msg-error" style={{ marginTop: 8 }}><Icon.alert />{error}</div>}
    </div>}
  </div>;
}

export function OwnerSettings() {
  const { data, loading, error, refresh } = useLiveData<any[]>('/api/owner/settings');
  const [announcement, setAnnouncement] = useState(false);
  const values = useMemo(() => Object.fromEntries((data || []).map((s: any) => [s.key, s.value])), [data]);
  return <>
    <PageHead title="Platform settings" eyebrow="Owner console"
      desc="Every setting shown here is read and enforced by the server. Connection credentials are managed separately as encrypted Cloudflare secrets."
      actions={<button className="btn" onClick={() => setAnnouncement(true)}><Icon.bell />New announcement</button>} />
    <Notice tone="info" title="Where credentials live">Supabase, EMQX and R2 keys are encrypted Cloudflare Pages secrets. They are never displayed or edited here.
      <Link to="/owner/settings/integrations" style={{ textDecoration: 'underline' }}> View integration status</Link>.</Notice>
    {error && <div style={{ margin: '16px 0' }}><ErrorState text={error} onRetry={refresh} /></div>}
    {loading ? <div style={{ marginTop: 16 }}><Loading rows={3} /></div> : SETTING_GROUPS.map((g) => {
      const G = Icon[g.icon as keyof typeof Icon];
      return <Card key={g.id} title={g.title} sub={g.description} icon={g.icon as any} style={{ marginTop: 16 }}>
        {g.settings.map((s) => <SettingRow key={s.key} def={s} value={values[s.key]} onSaved={refresh} />)}
      </Card>;
    })}
    <Card title="Connection status" sub="Read-only — configured in Cloudflare Pages" icon="link" style={{ marginTop: 16 }}>
      <div className="grid grid-2">
        <div><strong className="text-title-sm">Automatic deployment</strong>
          <p className="tiny" style={{ marginTop: 4, lineHeight: 1.8 }}>GitHub is connected directly to Cloudflare Pages. A change pushed to the production branch builds and deploys automatically. No duplicate workflow or repository secret is used.</p></div>
        <div><strong className="text-title-sm">Firmware files</strong>
          <p className="tiny" style={{ marginTop: 4, lineHeight: 1.8 }}>Binaries live in a private Cloudflare R2 bucket accessed with server-side S3 credentials. Metadata and checksums live in Supabase PostgreSQL. <Link to="/owner/firmware" style={{ textDecoration: 'underline' }}>Open firmware management</Link>.</p></div>
      </div>
      <div className="divider" />
      <Link className="btn btn-sm" to="/owner/setup"><Icon.cloudOk />Open setup checklist</Link>
    </Card>
    {announcement && <AnnouncementModal onClose={() => setAnnouncement(false)} />}
  </>;
}

function AnnouncementModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ title: '', body: '', severity: 'info', audience: 'all', ends_at: '' });
  return <Modal title="System announcement" onClose={onClose} footer={<>
    <button className="btn" onClick={onClose}>Cancel</button>
    <button className="btn btn-primary" disabled={!f.title || !f.body} onClick={async () => {
      try { await api.post('/api/owner/announcements', { ...f, ends_at: f.ends_at ? new Date(f.ends_at).toISOString() : null });
        toast('Announcement published'); onClose(); } catch (e: any) { toast(e.message, 'error'); }
    }}>Publish</button></>}>
    <Field label="Title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
    <Field label="Message"><textarea className="textarea" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
    <div className="form-row">
      <Field label="Severity"><select className="select" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
        <option value="info">Information</option><option value="warning">Warning</option><option value="critical">Critical</option></select></Field>
      <Field label="Audience"><select className="select" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}>
        <option value="all">Everyone</option><option value="owners">Home owners</option><option value="admins">Administrators</option></select></Field>
    </div>
    <Field label="Ends on (optional)"><input className="input" type="date" value={f.ends_at} onChange={(e) => setF({ ...f, ends_at: e.target.value })} /></Field>
  </Modal>;
}

/* -------------------------------------------------------------------------- */
/* Authentication & Security — all values come from the database             */
/* -------------------------------------------------------------------------- */

const AUTH_GROUPS: { id: string; title: string; description: string; icon: any; keys: {
  key: string; label: string; unit: string; hint: string; min: number; max: number; sensitive?: boolean;
}[] }[] = [
  { id: 'signin', title: 'Sign-in protection', description: 'Limits repeated failed sign-ins. Checked on every login request, per account and per IP address.', icon: 'shield', keys: [
    { key: 'login_max_attempts', label: 'Failed attempts allowed', unit: 'attempts', hint: 'After this many failures the account and IP are temporarily blocked.', min: 1, max: 50, sensitive: true },
    { key: 'login_window_seconds', label: 'Attempt window', unit: 'seconds', hint: 'Failures are counted inside this rolling window.', min: 30, max: 86400 },
    { key: 'login_lockout_seconds', label: 'Block duration', unit: 'seconds', hint: 'How long a blocked account or IP must wait before trying again.', min: 30, max: 86400, sensitive: true },
  ] },
  { id: 'password', title: 'Password policy', description: 'Applied when an account is created, a password is changed, or an administrator resets one.', icon: 'key', keys: [
    { key: 'password_min_length', label: 'Minimum password length', unit: 'characters', hint: 'Shorter passwords are rejected by the API and the database.', min: 8, max: 128, sensitive: true },
    { key: 'bcrypt_cost', label: 'Password hashing cost', unit: 'bcrypt cost', hint: 'Higher is slower to attack and slower to verify. Applied to the next new or changed password.', min: 4, max: 15, sensitive: true },
  ] },
  { id: 'sessions', title: 'Session lifetime', description: 'Sessions are stored in the database. Expiry, idle timeout and the per-account limit are checked on every request.', icon: 'timer', keys: [
    { key: 'session_ttl_hours', label: 'Maximum session lifetime', unit: 'hours', hint: 'A session cannot be extended beyond this age.', min: 1, max: 8760, sensitive: true },
    { key: 'session_idle_hours', label: 'Idle timeout', unit: 'hours', hint: 'A session with no activity for this long is closed.', min: 1, max: 8760, sensitive: true },
    { key: 'max_sessions_per_user', label: 'Sessions per account', unit: 'sessions', hint: 'The oldest session is removed when a new one exceeds this limit.', min: 1, max: 50 },
  ] },
  { id: 'recovery', title: 'Recovery codes', description: 'Single-use codes shown once when an account is created or an administrator regenerates them.', icon: 'card', keys: [
    { key: 'recovery_code_count', label: 'Codes per account', unit: 'codes', hint: 'How many single-use codes are generated.', min: 1, max: 20 },
    { key: 'recovery_code_ttl_hours', label: 'Code lifetime', unit: 'hours', hint: 'Unused codes expire after this many hours.', min: 1, max: 8760 },
  ] },
];

function AuthSettingRow({ def, value, onSaved }: {
  def: { key: string; label: string; unit: string; hint: string; min: number; max: number; sensitive?: boolean };
  value: number | undefined; onSaved: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < def.min || n > def.max) { setError(`Enter a whole number between ${def.min} and ${def.max}.`); return; }
    if (def.sensitive && !confirm) { setError('Confirm this change before saving.'); return; }
    setBusy(true); setError('');
    try { await api.post('/api/owner/auth/config', { key: def.key, value: n, confirm: true });
      toast(`${def.label} saved`); setEditing(false); setConfirm(false); onSaved(); }
    catch (e: any) { setError(e.message || 'Could not save the setting.'); }
    finally { setBusy(false); }
  };
  return <div className="setting-row">
    <div><div className="setting-title">{def.label}</div><div className="setting-desc">{def.hint}</div>
      <div style={{ marginTop: 8 }}><Badge tone="info">Current: {value ?? '—'} {def.unit}</Badge></div></div>
    <div className="setting-control">
      {!editing ? <button className="btn btn-sm" onClick={() => { setDraft(String(value ?? '')); setConfirm(false); setError(''); setEditing(true); }}><Icon.edit />Change</button>
        : <><input className="input mono" type="number" style={{ width: 110 }} min={def.min} max={def.max}
          value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={busy} aria-busy={busy || undefined}>{busy ? 'Saving…' : 'Save'}</button></>}
    </div>
    {editing && <div style={{ gridColumn: '1 / -1' }}>
      {def.sensitive && <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={confirm}
        onChange={(e) => setConfirm(e.target.checked)} />I understand this changes sign-in behaviour for every account</label>}
      {error && <div className="field-msg field-msg-error" style={{ marginTop: 8 }}><Icon.alert />{error}</div>}
    </div>}
  </div>;
}

function human(s: string) { return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase()); }

export function OwnerSecurity() {
  const { data, loading, error, refresh } = useLiveData<any>('/api/owner/auth/security');
  const toast = useToast();
  const [reset, setReset] = useState<any>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [tab, setTab] = useState<'accounts' | 'sessions' | 'events' | 'roles'>('accounts');
  const [busy, setBusy] = useState<string | null>(null);
  const [registrationConfirm, setRegistrationConfirm] = useState(false);
  const config = data?.config || {};
  const health = data?.health || {};
  const action = async (path: string, payload: any = {}, message = 'Account updated') => {
    setBusy(path);
    try { await api.post(path, payload); toast(message); refresh(); }
    catch (e: any) { toast(e.message || 'The action failed', 'error'); }
    finally { setBusy(null); }
  };
  const registrationNext = config.registration_enabled === 0 ? 1 : 0;
  const confirmRegistration = async () => {
    await action('/api/owner/auth/config', { key: 'registration_enabled', value: registrationNext, confirm: true },
      registrationNext === 1 ? 'New registrations are open' : 'New registrations are closed');
    setRegistrationConfirm(false);
  };
  return <>
    <PageHead title="Authentication & security" eyebrow="Owner console"
      desc="Custom database-backed accounts. Every value and event below is read from Supabase PostgreSQL — there is no third-party identity provider." />

    {loading ? <Loading rows={4} /> : error ? <ErrorState text={error} onRetry={refresh} /> : <>
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <Card title="Real security status" icon="shieldOk">
          <div className="kv">
            <dt>Password hashing</dt><dd>{health.pgcrypto ? <Badge tone="on" icon="ok">Ready</Badge> : <Badge tone="danger" icon="fail">pgcrypto missing</Badge>}</dd>
            <dt>Method</dt><dd>bcrypt + server-side pepper, in the database</dd>
            <dt>Accounts</dt><dd>{health.accounts ?? 0}</dd>
            <dt>Active sessions</dt><dd>{health.active_sessions ?? 0}</dd>
            <dt>Blocked scopes</dt><dd>{health.locked_scopes ?? 0}</dd>
          </div>
        </Card>
        <Card title="Registration control" icon="user">
          <p className="tiny" style={{ lineHeight: 1.8, marginBottom: 12 }}>
            {config.registration_enabled === 0
              ? 'New account creation is closed. The sign-up API rejects every new registration request.'
              : 'New accounts can be created. The first account on a new platform becomes the Platform Owner in one database transaction.'}
          </p>
          <Badge tone={config.registration_enabled === 0 ? 'warn' : 'on'} icon={config.registration_enabled === 0 ? 'block' : 'ok'}>
            {config.registration_enabled === 0 ? 'Closed' : 'Open'}</Badge>
          <div style={{ marginTop: 12 }}><button className="btn btn-sm" onClick={() => setRegistrationConfirm(true)} disabled={busy !== null}>
            {config.registration_enabled === 0 ? 'Allow new accounts' : 'Close new registrations'}</button></div>
        </Card>
        <Card title="Login lockouts" icon="lock">
          <p className="tiny" style={{ lineHeight: 1.8, marginBottom: 12 }}>Failed sign-ins are limited per account and per IP. Clearing lockouts lets a legitimate user try again immediately.</p>
          <button className="btn btn-sm" onClick={() => action('/api/owner/auth/attempts/reset', {}, 'Active lockouts cleared')}
            disabled={busy !== null}><Icon.retry />Clear lockouts</button>
          <div className="tiny" style={{ marginTop: 12 }}>This does not change the limits stored below.</div>
        </Card>
      </div>

      <Notice tone="info" title="Everything here is enforced server-side">Changing a value writes to the database and takes effect on the next request or the next password change. No setting is a decorative switch.</Notice>

      {AUTH_GROUPS.map((g) => <Card key={g.id} title={g.title} sub={g.description} icon={g.icon as any} style={{ marginTop: 16 }}>
        {g.keys.map((k) => <AuthSettingRow key={k.key} def={k} value={config[k.key]} onSaved={refresh} />)}
      </Card>)}

      <Card title="Accounts, sessions and security history" sub="Live records from the database" style={{ marginTop: 16 }} icon="users">
        <div className="tabs" style={{ marginBottom: 0 }}>
          <button className={tab === 'accounts' ? 'on' : ''} onClick={() => setTab('accounts')}><Icon.users />Accounts</button>
          <button className={tab === 'sessions' ? 'on' : ''} onClick={() => setTab('sessions')}><Icon.timer />Active sessions</button>
          <button className={tab === 'events' ? 'on' : ''} onClick={() => setTab('events')}><Icon.activity />Security events</button>
          <button className={tab === 'roles' ? 'on' : ''} onClick={() => setTab('roles')}><Icon.shield />Roles & permissions</button>
        </div>
        <div style={{ paddingTop: 8 }}>
          {tab === 'accounts' && <DataTable columns={[
            { key: 'email', label: 'Account', render: (r) => <div><div style={{ fontWeight: 700 }}>{r.email}</div><div className="tiny">{human(r.role)}</div></div> },
            { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'sessions', label: 'Sessions', render: (r) => String(r.active_sessions ?? 0) },
            { key: 'actions', label: '', render: (r) => <div className="row-actions">
              <button className="btn btn-sm" disabled={busy !== null} aria-busy={busy !== null || undefined} onClick={() => action(`/api/owner/auth/accounts/${r.user_id}/status`, { status: r.status === 'active' ? 'suspended' : 'active' })}>
                {r.status === 'active' ? 'Suspend' : 'Activate'}</button>
              <button className="btn btn-sm" onClick={() => setReset({ id: r.user_id, email: r.email, password: '' })}>Reset password</button>
              <button className="btn btn-sm" onClick={async () => {
                try { const r2: any = await api.post(`/api/owner/auth/accounts/${r.user_id}/recovery-codes`, {}); setCodes(r2.recovery_codes); refresh(); }
                catch (e: any) { toast(e.message, 'error'); }
              }}>Recovery codes</button>
            </div> },
          ]} rows={data?.accounts || []} empty={<EmptyState icon="users" title="No accounts" text="Accounts appear after the first registration." />} />}

          {tab === 'sessions' && <DataTable columns={[
            { key: 'email', label: 'Account', render: (r) => <span style={{ fontWeight: 600 }}>{r.email}</span> },
            { key: 'created_at', label: 'Started', render: (r) => <span className="tiny">{timeFull(r.created_at)}</span> },
            { key: 'last_seen_at', label: 'Last active', render: (r) => <span className="tiny">{timeAgo(r.last_seen_at)}</span> },
            { key: 'expires_at', label: 'Expires', render: (r) => <span className="tiny">{timeFull(r.expires_at)}</span> },
            { key: 'ip', label: 'IP', render: (r) => <span className="mono tiny">{r.ip || '—'}</span> },
            { key: 'actions', label: '', render: (r) => <button className="btn btn-sm btn-danger" disabled={busy !== null} aria-busy={busy !== null || undefined}
              onClick={() => action(`/api/owner/auth/sessions/${r.id}/revoke`, {}, 'Session ended')}><Icon.block />End session</button> },
          ]} rows={data?.sessions || []} empty={<EmptyState icon="timer" title="No active sessions" text="Every browser session is recorded in the database with its expiry." />} />}

          {tab === 'events' && <DataTable columns={[
            { key: 'created_at', label: 'When', render: (e) => <span className="tiny">{timeFull(e.created_at)}</span> },
            { key: 'event_type', label: 'Event', render: (e) => <Badge tone={/fail|locked|revoked/.test(e.event_type) ? 'warn' : /signup|login|password|recovery/.test(e.event_type) ? 'on' : ''}>
              {human(e.event_type)}</Badge> },
            { key: 'email', label: 'Account', render: (e) => <span className="tiny">{e.email || '—'}</span> },
            { key: 'ip', label: 'IP', render: (e) => <span className="mono tiny">{e.ip || '—'}</span> },
            { key: 'detail', label: 'Detail', render: (e) => <span className="tiny">{e.detail || '—'}</span> },
          ]} rows={data?.events || []} empty={<EmptyState icon="activity" title="No security events yet"
            text="Sign-ins, failed attempts, lockouts, password changes and administrator actions are recorded here." />} />}

          {tab === 'roles' && <div style={{ display: 'grid', gap: 12 }}>
            {(data?.roles?.roles || []).map((r: any) => <div key={r.key} className="card card-pad">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <strong>{human(r.key)}</strong><Badge tone="info">{r.accounts} account{r.accounts === 1 ? '' : 's'}</Badge>
              </div>
              <p className="tiny" style={{ marginTop: 6 }}>{r.description}</p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                {(r.permissions || []).map((p: string) => <Badge key={p} tone="on" icon="key">{p}</Badge>)}
                {!(r.permissions || []).length && <span className="tiny">No platform permissions</span>}
              </div>
            </div>)}
            <div className="tiny">Permissions are checked in the database for every owner API call. They cannot be changed from the browser.</div>
          </div>}
        </div>
      </Card>
    </>}

    {registrationConfirm && <Modal title={registrationNext === 0 ? 'Close new registrations' : 'Allow new accounts'}
      onClose={() => setRegistrationConfirm(false)} footer={<>
        <button className="btn" onClick={() => setRegistrationConfirm(false)}>Cancel</button>
        <button className="btn btn-primary" onClick={confirmRegistration} disabled={busy !== null} aria-busy={busy !== null || undefined}>Confirm change</button>
      </>}>
      <Notice tone={registrationNext === 0 ? 'warn' : 'info'} title="What changes">
        {registrationNext === 0
          ? 'The sign-up API will reject every new registration request on the next request. Existing accounts can still sign in, and their sessions are unaffected.'
          : 'New accounts can be created again. On a platform with no accounts, the first new registration becomes the Platform Owner.'}
      </Notice>
    </Modal>}
    {reset && <Modal title="Set a new password" onClose={() => setReset(null)} footer={<>
      <button className="btn" onClick={() => setReset(null)}>Cancel</button>
      <button className="btn btn-primary" disabled={reset.password.length < Number(config.password_min_length || 10)}
        onClick={async () => {
          try { await api.post(`/api/owner/auth/accounts/${reset.id}/reset-password`, { password: reset.password });
            toast('Password reset; all sessions revoked'); setReset(null); refresh(); }
          catch (e: any) { toast(e.message, 'error'); }
        }}>Reset password</button></>}>
      <div className="field"><label>Account</label><input className="input" value={reset.email} readOnly /></div>
      <Field label="New password" hint={`At least ${config.password_min_length || 10} characters. All existing sessions will be revoked.`}>
        <input className="input" type="password" minLength={Number(config.password_min_length || 10)} value={reset.password}
          onChange={(e) => setReset({ ...reset, password: e.target.value })} /></Field>
    </Modal>}
    {codes && <Modal title="New recovery codes" onClose={() => setCodes(null)}
      footer={<button className="btn btn-primary" onClick={() => setCodes(null)}>Done</button>}>
      <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>Give these single-use codes to the account holder. They are shown only once.</p>
      <div className="card card-pad"><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }} className="mono">
        {codes.map((c) => <div key={c}>{c}</div>)}</div></div>
    </Modal>}
  </>;
}
