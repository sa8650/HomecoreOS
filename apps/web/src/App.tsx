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
  OwnerUsage, OwnerBoards, OwnerSettings, OwnerAudit,
} from './pages/owner';
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
    { to: '/owner/audit', label: 'Audit Logs', icon: 'file' },
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
          <div className="brand-mark">H</div>
          <div><div className="brand-name">Helios</div><div className="brand-sub">{owner ? 'Platform Owner' : 'Home Console'}</div></div>
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
  const { signIn, signUp, toast } = useAuth();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [form, setForm] = useState({ email: '', password: '', full_name: '', home_name: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      if (mode === 'in') await signIn(form.email, form.password);
      else await signUp(form);
    } catch (err: any) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="auth-wrap">
      <div className="auth-art">
        <div className="sidebar-brand" style={{ padding: 0 }}><div className="brand-mark">H</div><div><div className="brand-name">Helios</div><div className="brand-sub">Smart Home Platform</div></div></div>
        <div>
          <h2>One platform. Every home, independently secure.</h2>
          <p>Multi-tenant control for ESP32 boards: real GPIO allocation, per-device MQTT credentials, acknowledged commands, telemetry and automation — with tenant isolation enforced at every layer.</p>
          <div className="auth-diagram">
            <span>Website</span><i>→</i><span>Cloudflare Worker</span><i>→</i><span>EMQX</span><i>→</i><span>ESP32</span>
          </div>
        </div>
        <div className="tiny">Cloudflare Pages · Workers · Supabase Postgres · EMQX Serverless · R2</div>
      </div>
      <div className="auth-panel">
        <div className="auth-card">
          <h1>{mode === 'in' ? 'Sign in to your home' : 'Create your account'}</h1>
          <p className="lead">{mode === 'in' ? 'Your home workspace and devices are private to your account.' : 'Each account gets an independent home workspace.'}</p>
          <div className="segmented" style={{ marginBottom: 22 }}>
            <button className={mode === 'in' ? 'on' : ''} onClick={() => setMode('in')}>Sign in</button>
            <button className={mode === 'up' ? 'on' : ''} onClick={() => setMode('up')}>Create account</button>
          </div>
          <form onSubmit={submit}>
            {mode === 'up' && <>
              <div className="field"><label>Full name</label><input className="input" value={form.full_name} onChange={(e) => set('full_name', e.target.value)} placeholder="Alex Morgan" /></div>
              <div className="field"><label>Home name</label><input className="input" value={form.home_name} onChange={(e) => set('home_name', e.target.value)} placeholder="Morgan Residence" /></div>
            </>}
            <div className="field"><label>Email</label><input className="input" type="email" required value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="you@example.com" /></div>
            <div className="field"><label>Password</label><input className="input" type="password" required minLength={10} value={form.password} onChange={(e) => set('password', e.target.value)} placeholder="At least 10 characters" /></div>
            <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : 'Create account'}</button>
          </form>
          <p className="tiny" style={{ marginTop: 18, textAlign: 'center' }}>Sessions are signed server-side. Tenant isolation is enforced by Postgres RLS and Worker authorization.</p>
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
        <Route path="/owner/settings" element={<OwnerSettings />} />
        <Route path="/owner/audit" element={<OwnerAudit />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return <AuthProvider><RoutesView /></AuthProvider>;
}
