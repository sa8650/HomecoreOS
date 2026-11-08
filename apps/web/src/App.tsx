import React, { useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './state';
import { api } from './api';
import { Icon } from './components';
import {
  CustomerOverview, RoomsPage, DevicesPage, SwitchesPage, SensorsPage, ControllersPage,
  BoardLibraryPage, BoardDetailPage, AutomationPage, FirmwarePage, ActivityPage,
  StaffPage, SettingsPage, SetupWizardPage,
} from './pages/customer';
import {
  OwnerOverview, OwnerCustomers, OwnerCustomerDetail, OwnerStaff, OwnerEmqx,
  OwnerUsage, OwnerBoards, OwnerSettings, OwnerAudit, OwnerSecurity,
} from './pages/owner';
import { OwnerSetup, OwnerIntegrations, PlatformSettingsLinks } from './pages/platform-setup';
import { LogOut, ChevronDown, ArrowUpRight } from 'lucide-react';

const CUSTOMER_NAV = [
  { group: 'Home', items: [
    { to: '/', label: 'Overview', icon: 'home' },
    { to: '/rooms', label: 'Rooms', icon: 'pin' },
  ] },
  { group: 'Devices', items: [
    { to: '/devices', label: 'Devices', icon: 'box' },
    { to: '/switches', label: 'Switches', icon: 'power' },
    { to: '/sensors', label: 'Sensors', icon: 'gauge' },
    { to: '/controllers', label: 'Controllers', icon: 'cpu' },
    { to: '/boards', label: 'Board Library', icon: 'layers' },
  ] },
  { group: 'Manage', items: [
    { to: '/automation', label: 'Automation', icon: 'zap' },
    { to: '/firmware', label: 'Firmware', icon: 'download' },
    { to: '/activity', label: 'Activity', icon: 'activity' },
    { to: '/staff', label: 'Staff', icon: 'users' },
    { to: '/settings', label: 'Settings', icon: 'settings' },
  ] },
] as const;

const OWNER_NAV = [
  { group: 'Platform', items: [
    { to: '/owner', label: 'Overview', icon: 'home' },
    { to: '/owner/setup', label: 'Setup status', icon: 'check' },
    { to: '/owner/customers', label: 'Customers', icon: 'users' },
    { to: '/owner/staff', label: 'Staff & Access', icon: 'shield' },
  ] },
  { group: 'Infrastructure', items: [
    { to: '/owner/emqx', label: 'EMQX Management', icon: 'radio' },
    { to: '/owner/usage', label: 'Usage & Monitoring', icon: 'chart' },
    { to: '/owner/boards', label: 'Board Library', icon: 'layers' },
  ] },
  { group: 'Governance', items: [
    { to: '/owner/settings', label: 'Platform Settings', icon: 'settings' },
    { to: '/owner/settings/integrations', label: 'Integrations', icon: 'link' },
    { to: '/owner/audit', label: 'Audit Logs', icon: 'file' },
    { to: '/owner/security', label: 'Authentication', icon: 'shield' },
  ] },
] as const;

function Shell({ owner, children }: { owner: boolean; children: React.ReactNode }) {
  const { tenant, role, profile, platform_admin, signOut } = useAuth();
  const nav = owner ? OWNER_NAV : CUSTOMER_NAV;
  const [menu, setMenu] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const current = nav.flatMap((g) => [...g.items]).find((i) => i.to === location.pathname);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">HC</div>
          <div><div className="brand-name">HomecoreOS</div><div className="brand-sub">{owner ? 'Platform Owner' : 'Home Console'}</div></div>
        </div>
        {nav.map((g) => (
          <div key={g.group}>
            <div className="nav-group-label">{g.group}</div>
            {g.items.map((i) => {
              const I = Icon[i.icon as keyof typeof Icon];
              return <NavLink key={i.to} to={i.to} end={i.to === '/' || i.to === '/owner'} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                <I /><span>{i.label}</span>
              </NavLink>;
            })}
          </div>
        ))}
        <div className="sidebar-foot">
          {platform_admin && (
            <button className="nav-item" onClick={() => navigate(owner ? '/' : '/owner')} style={{ marginBottom: 6 }}>
              {owner ? <Icon.home /> : <Icon.shield />}<span>{owner ? 'Customer console' : 'Owner console'}</span><ArrowUpRight size={13} style={{ marginLeft: 'auto' }} />
            </button>
          )}
          <div className="workspace-chip">
            <div className="avatar">{(profile?.full_name || profile?.email || 'U').slice(0, 2).toUpperCase()}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="name">{owner ? 'Platform administration' : (tenant?.name || 'My Home')}</div>
              <div className="role">{owner ? 'Platform admin' : role}</div>
            </div>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setMenu((m) => !m)} aria-label="Account menu"><ChevronDown size={14} /></button>
          </div>
          {menu && (
            <div className="card" style={{ marginTop: 8, padding: 6 }}>
              <button className="nav-item" onClick={() => signOut()}><LogOut size={15} />Sign out</button>
            </div>
          )}
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <span className="breadcrumb">{owner ? 'Platform' : (tenant?.name || 'Home')}</span>
            <span className="breadcrumb">/</span>
            <span className="topbar-title">{current?.label || (owner ? 'Overview' : 'Overview')}</span>
          </div>
          <div className="topbar-right">
            {!owner && <button className="btn btn-primary btn-sm" onClick={() => navigate('/setup')}><Icon.plus />Add Controller</button>}
            <span className="badge info"><span className="dot pulse" />Live</span>
          </div>
        </header>
        <div className="content"><div className="content-inner">{children}</div></div>
      </main>
    </div>
  );
}

function AuthPage() {
  const { signIn, signUp, refresh, toast } = useAuth();
  const [mode, setMode] = useState<'in' | 'up' | 'recover' | 'codes'>('in');
  const [form, setForm] = useState({ email: '', password: '', full_name: '', home_name: '', code: '', new_password: '' });
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      if (mode === 'in') await signIn(form.email, form.password);
      else if (mode === 'up') { setCodes(await signUp(form)); setMode('codes'); }
      else if (mode === 'recover') {
        await api.post('/api/auth/recovery/reset', {
          email: form.email, code: form.code, password: form.new_password,
        });
        toast('Password updated. Sign in with your new password.');
        setMode('in'); setForm((f) => ({ ...f, password: '', code: '', new_password: '' }));
      }
    } catch (err: any) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  };
  const copyCodes = async () => {
    try { await navigator.clipboard.writeText(codes.join('\n')); toast('Recovery codes copied'); }
    catch { toast('Select and copy the codes manually', 'error'); }
  };
  return (
    <div className="auth-wrap">
      <div className="auth-art">
        <div className="sidebar-brand" style={{ padding: 0 }}><div className="brand-mark">HC</div><div><div className="brand-name">HomecoreOS</div><div className="brand-sub">Smart Home Platform</div></div></div>
        <div>
          <h2>One platform. Every home, independently secure.</h2>
          <p>Multi-tenant control for ESP32 boards: real GPIO allocation, per-device MQTT credentials, acknowledged commands, telemetry and automation — with tenant isolation enforced at every layer.</p>
          <div className="auth-diagram">
            <span>Website</span><i>→</i><span>Cloudflare Pages</span><i>→</i><span>EMQX</span><i>→</i><span>ESP32</span>
          </div>
        </div>
        <div className="tiny">Cloudflare Pages · Supabase · EMQX Serverless · Supabase Storage</div>
      </div>
      <div className="auth-panel">
        <div className="auth-card">
          {mode === 'codes' ? <>
            <h1>Save your recovery codes</h1>
            <p className="lead">Each code works once if you lose your password. They are shown only now — store them somewhere safe.</p>
            <div className="card" style={{ padding: 14, marginBottom: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }} className="mono">
                {codes.map((c) => <div key={c}>{c}</div>)}
              </div>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              <button className="btn" onClick={copyCodes}>Copy all codes</button>
              <button className="btn btn-primary btn-block" onClick={async () => { await refresh(); }}>I saved them — continue</button>
            </div>
          </> : <>
            <h1>{mode === 'in' ? 'Sign in to your home' : mode === 'up' ? 'Create your account' : 'Recover your account'}</h1>
            <p className="lead">{mode === 'in' ? 'Your home workspace and devices are private to your account.'
              : mode === 'up' ? 'The first account on a new platform becomes the Platform Owner.'
              : 'Enter your email, one recovery code and a new password.'}</p>
            {mode !== 'recover' && <div className="segmented" style={{ marginBottom: 22 }}>
              <button className={mode === 'in' ? 'on' : ''} onClick={() => setMode('in')}>Sign in</button>
              <button className={mode === 'up' ? 'on' : ''} onClick={() => setMode('up')}>Create account</button>
            </div>}
            <form onSubmit={submit}>
              {mode === 'up' && <>
                <div className="field"><label>Full name</label><input className="input" value={form.full_name} onChange={(e) => set('full_name', e.target.value)} placeholder="Alex Morgan" /></div>
                <div className="field"><label>Home name</label><input className="input" value={form.home_name} onChange={(e) => set('home_name', e.target.value)} placeholder="Morgan Residence" /></div>
              </>}
              <div className="field"><label>Email</label><input className="input" type="email" required value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="you@example.com" /></div>
              {mode !== 'recover' && <div className="field"><label>Password</label><input className="input" type="password" required minLength={10} value={form.password} onChange={(e) => set('password', e.target.value)} placeholder="At least 10 characters" /></div>}
              {mode === 'recover' && <>
                <div className="field"><label>Recovery code</label><input className="input" required value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" /></div>
                <div className="field"><label>New password</label><input className="input" type="password" required minLength={10} value={form.new_password} onChange={(e) => set('new_password', e.target.value)} placeholder="At least 10 characters" /></div>
              </>}
              <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create account' : 'Reset password'}</button>
            </form>
            <div style={{ marginTop: 18, textAlign: 'center' }}>
              {mode === 'recover'
                ? <button className="btn btn-ghost btn-sm" onClick={() => setMode('in')}>Back to sign in</button>
                : <button className="btn btn-ghost btn-sm" onClick={() => setMode('recover')}>Forgot password? Use a recovery code</button>}
            </div>
            <p className="tiny" style={{ marginTop: 12, textAlign: 'center' }}>Passwords are hashed in the database. Sessions use secure HttpOnly cookies and are verified server-side.</p>
          </>}
        </div>
      </div>
    </div>
  );
}

function RoutesView() {
  const { signedIn, loading, platform_admin } = useAuth();
  const location = useLocation();
  if (loading) return <div style={{ height: '100vh', display: 'grid', placeItems: 'center' }}><div className="skeleton" style={{ width: 220, height: 40 }} /></div>;
  if (!signedIn) return <AuthPage />;
  const owner = location.pathname.startsWith('/owner');
  if (owner && !platform_admin) return <Navigate to="/" replace />;
  return (
    <Shell owner={owner}>
      <Routes>
        <Route path="/" element={<CustomerOverview />} />
        <Route path="/rooms" element={<RoomsPage />} />
        <Route path="/devices" element={<DevicesPage />} />
        <Route path="/switches" element={<SwitchesPage />} />
        <Route path="/sensors" element={<SensorsPage />} />
        <Route path="/controllers" element={<ControllersPage />} />
        <Route path="/boards" element={<BoardLibraryPage />} />
        <Route path="/boards/:id" element={<BoardDetailPage />} />
        <Route path="/setup" element={<SetupWizardPage />} />
        <Route path="/automation" element={<AutomationPage />} />
        <Route path="/firmware" element={<FirmwarePage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/staff" element={<StaffPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/owner" element={<OwnerOverview />} />
        <Route path="/owner/customers" element={<OwnerCustomers />} />
        <Route path="/owner/customers/:id" element={<OwnerCustomerDetail />} />
        <Route path="/owner/staff" element={<OwnerStaff />} />
        <Route path="/owner/emqx" element={<OwnerEmqx />} />
        <Route path="/owner/usage" element={<OwnerUsage />} />
        <Route path="/owner/boards" element={<OwnerBoards />} />
        <Route path="/owner/setup" element={<OwnerSetup />} />
        <Route path="/owner/settings" element={<OwnerSettings />} />
        <Route path="/owner/settings/integrations" element={<OwnerIntegrations />} />
        <Route path="/owner/audit" element={<OwnerAudit />} />
        <Route path="/owner/security" element={<OwnerSecurity />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return <AuthProvider><RoutesView /></AuthProvider>;
}
