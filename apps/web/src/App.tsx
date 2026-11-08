import React, { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './state';
import { api } from './api';
import { Icon, PageHead, EmptyState, Loading } from './components';
import type { IconKey } from './components';
import {
  CustomerOverview, RoomsPage, DevicesPage, SwitchesPage, SensorsPage, ControllersPage,
  BoardLibraryPage, BoardDetailPage, AutomationPage, FirmwarePage, ActivityPage,
  StaffPage, SettingsPage,
} from './pages/customer';
import {
  OwnerOverview, OwnerCustomers, OwnerCustomerDetail, OwnerStaff, OwnerEmqx,
  OwnerUsage, OwnerAudit,
} from './pages/owner';
import { OwnerSetup, OwnerIntegrations } from './pages/platform-setup';
import { OwnerFirmware } from './pages/firmware';
import { OwnerBoards } from './pages/board-admin';
import { OwnerSettings, OwnerSecurity } from './pages/owner-settings';
import { SetupWizardPage } from './pages/setup-wizard';
import { ThemeMenu } from './theme-menu';
import { getTheme, observeReveals } from './theme';

type NavItem = { to: string; label: string; icon: IconKey };
type NavGroup = { group: string; items: NavItem[] };

const CUSTOMER_NAV: NavGroup[] = [
  { group: 'Home', items: [
    { to: '/', label: 'Overview', icon: 'home' },
    { to: '/rooms', label: 'Rooms & areas', icon: 'pin' },
  ] },
  { group: 'Devices', items: [
    { to: '/devices', label: 'Devices', icon: 'box' },
    { to: '/switches', label: 'Switches', icon: 'power' },
    { to: '/sensors', label: 'Sensors', icon: 'gauge' },
    { to: '/controllers', label: 'Controllers', icon: 'cpu' },
    { to: '/boards', label: 'Board library', icon: 'layers' },
  ] },
  { group: 'Manage', items: [
    { to: '/setup', label: 'Add a controller', icon: 'plugCharge' },
    { to: '/automation', label: 'Automation', icon: 'zap' },
    { to: '/firmware', label: 'Firmware', icon: 'download' },
    { to: '/activity', label: 'Activity', icon: 'activity' },
    { to: '/staff', label: 'Staff', icon: 'users' },
    { to: '/settings', label: 'Settings', icon: 'settings' },
  ] },
];

const OWNER_NAV: NavGroup[] = [
  { group: 'Platform', items: [
    { to: '/owner', label: 'Overview', icon: 'home' },
    { to: '/owner/setup', label: 'Setup status', icon: 'cloudOk' },
    { to: '/owner/customers', label: 'Customers', icon: 'users' },
    { to: '/owner/staff', label: 'Staff & access', icon: 'shield' },
  ] },
  { group: 'Devices & updates', items: [
    { to: '/owner/firmware', label: 'Firmware management', icon: 'cloudUp' },
    { to: '/owner/boards', label: 'Board library', icon: 'circuitry' },
    { to: '/owner/emqx', label: 'EMQX management', icon: 'radio' },
    { to: '/owner/usage', label: 'Usage & monitoring', icon: 'chart' },
  ] },
  { group: 'Governance', items: [
    { to: '/owner/settings', label: 'Platform settings', icon: 'settings' },
    { to: '/owner/settings/integrations', label: 'Integrations', icon: 'link' },
    { to: '/owner/security', label: 'Authentication & security', icon: 'shieldOk' },
    { to: '/owner/audit', label: 'Audit logs', icon: 'file' },
  ] },
];

function Shell({ owner, children }: { owner: boolean; children: React.ReactNode }) {
  const { tenant, role, profile, platform_admin, signOut } = useAuth();
  const nav = owner ? OWNER_NAV : CUSTOMER_NAV;
  const [menu, setMenu] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const current = nav.flatMap((g) => g.items).find((i) => i.to === location.pathname);

  useEffect(() => { setNavOpen(false); setMenu(false); }, [location.pathname]);
  useEffect(() => {
    const id = window.setTimeout(() => observeReveals(), 30);
    return () => { window.clearTimeout(id); };
  }, [location.pathname]);

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <div className={`app-shell ${navOpen ? 'nav-open' : ''}`}>
        {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
        <aside className="sidebar" aria-label="Main navigation">
          <div className="sidebar-brand">
            <div className="brand-mark">HC</div>
            <div><div className="brand-name">HomecoreOS</div>
              <div className="brand-sub">{owner ? 'Platform owner' : 'Home console'}</div></div>
          </div>
          <nav>
            {nav.map((g) => (
              <div key={g.group}>
                <div className="nav-group-label">{g.group}</div>
                {g.items.map((i) => {
                  const I = Icon[i.icon];
                  return <NavLink key={i.to} to={i.to} end={i.to === '/' || i.to === '/owner'}
                    className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                    <I /><span>{i.label}</span>
                  </NavLink>;
                })}
              </div>
            ))}
          </nav>
          <footer className="sidebar-foot" aria-label="Account">
            {platform_admin && (
              <button className="nav-item" onClick={() => navigate(owner ? '/' : '/owner')} style={{ marginBottom: 6 }}>
                {owner ? <Icon.home /> : <Icon.shield />}
                <span>{owner ? 'Customer console' : 'Owner console'}</span>
                <Icon.external />
              </button>
            )}
            <div className="workspace-chip">
              <div className="avatar">{(profile?.full_name || profile?.email || 'U').slice(0, 2).toUpperCase()}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="name">{owner ? 'Platform administration' : (tenant?.name || 'My Home')}</div>
                <div className="role">{owner ? 'Platform admin' : role}</div>
              </div>
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setMenu((m) => !m)}
                aria-label="Account menu" aria-expanded={menu}><Icon.down /></button>
            </div>
            {menu && (
              <div className="card" style={{ marginTop: 8, padding: 6 }}>
                <button className="nav-item" onClick={() => signOut()}><Icon.signOut />Sign out</button>
              </div>
            )}
          </footer>
        </aside>
        <div className="main">
          <header className="topbar">
            <div className="topbar-left">
              <button className="btn btn-ghost btn-icon sidebar-toggle" onClick={() => setNavOpen(true)} aria-label="Open navigation"><Icon.list /></button>
              <span className="breadcrumb">{owner ? 'Platform' : (tenant?.name || 'Home')}</span>
              <span className="breadcrumb">/</span>
              <span className="topbar-title">{current?.label || 'Overview'}</span>
            </div>
            <div className="topbar-right">
              {!owner && <button className="btn btn-primary btn-sm" onClick={() => navigate('/setup')}>
                <Icon.plus />Add controller</button>}
              <ThemeMenu initial={getTheme()} />
            </div>
          </header>
          <main className="content" id="main-content"><div className="content-inner">{children}</div></main>
        </div>
      </div>
    </>
  );
}

function AuthPage() {
  const { signIn, signUp, refresh, toast } = useAuth();
  const [mode, setMode] = useState<'in' | 'up' | 'recover' | 'codes'>('in');
  const [form, setForm] = useState({ email: '', password: '', full_name: '', home_name: '', code: '', new_password: '' });
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: string, v: string) => { setForm((f) => ({ ...f, [k]: v })); setError(''); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
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
    } catch (err: any) { setError(err.message || 'Something went wrong. Please try again.'); }
    finally { setBusy(false); }
  };
  const copyCodes = async () => {
    try { await navigator.clipboard.writeText(codes.join('\n')); toast('Recovery codes copied'); }
    catch { toast('Select and copy the codes manually', 'error'); }
  };
  return (
    <div className="auth-wrap">
      <div className="auth-art">
        <div className="sidebar-brand" style={{ padding: 0 }}>
          <div className="brand-mark">HC</div>
          <div><div className="brand-name">HomecoreOS</div><div className="brand-sub">Smart home platform</div></div>
        </div>
        <div className="reveal is-visible">
          <h2>Every home, organised around its devices.</h2>
          <p>Rooms, ESP32 controllers, sensors, switches and automations in one console. Each home has its own workspace, and every controller has its own credentials.</p>
          <div className="auth-diagram">
            <span>Home console</span><i>→</i><span>Cloudflare Pages</span><i>→</i><span>EMQX</span><i>→</i><span>ESP32</span>
          </div>
        </div>
        <div className="tiny">Cloudflare Pages · Supabase PostgreSQL · EMQX Serverless · Cloudflare R2</div>
      </div>
      <div className="auth-panel">
        <div className="auth-card">
          {mode === 'codes' ? <>
            <h1>Save your recovery codes</h1>
            <p className="lead">Each code works once if you lose your password. They are shown only now, so keep them somewhere safe.</p>
            <div className="card card-pad" style={{ marginBottom: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }} className="mono">
                {codes.map((c) => <div key={c}>{c}</div>)}
              </div>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              <button className="btn" onClick={copyCodes}><Icon.copy />Copy all codes</button>
              <button className="btn btn-primary btn-block" onClick={async () => { await refresh(); }}>I saved them — continue</button>
            </div>
          </> : <>
            <h1>{mode === 'in' ? 'Sign in to your home' : mode === 'up' ? 'Create your account' : 'Recover your account'}</h1>
            <p className="lead">{mode === 'in' ? 'Your home workspace and devices are private to your account.'
              : mode === 'up' ? 'The first account on a new platform becomes the Platform Owner.'
              : 'Enter your email, one recovery code and a new password.'}</p>
            {mode !== 'recover' && <div className="segmented" style={{ marginBottom: 22 }}>
              <button className={mode === 'in' ? 'on' : ''} onClick={() => { setMode('in'); setError(''); }}>Sign in</button>
              <button className={mode === 'up' ? 'on' : ''} onClick={() => { setMode('up'); setError(''); }}>Create account</button>
            </div>}
            <form onSubmit={submit} noValidate>
              {mode === 'up' && <>
                <div className="field"><label>Full name</label><input className="input" value={form.full_name} onChange={(e) => set('full_name', e.target.value)} placeholder="Alex Morgan" /></div>
                <div className="field"><label>Home name</label><input className="input" value={form.home_name} onChange={(e) => set('home_name', e.target.value)} placeholder="Morgan Residence" /></div>
              </>}
              <div className="field"><label>Email address</label><input className="input" type="email" required value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="you@example.com" autoComplete="email" /></div>
              {mode !== 'recover' && <div className="field"><label>Password</label><input className="input" type="password" required minLength={10} value={form.password} onChange={(e) => set('password', e.target.value)} placeholder="At least 10 characters" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} /></div>}
              {mode === 'recover' && <>
                <div className="field"><label>Recovery code</label><input className="input" required value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" /></div>
                <div className="field"><label>New password</label><input className="input" type="password" required minLength={10} value={form.new_password} onChange={(e) => set('new_password', e.target.value)} placeholder="At least 10 characters" /></div>
              </>}
              {error && <div className="notice danger" style={{ marginBottom: 16 }}><Icon.fail />{error}</div>}
              <button className="btn btn-primary btn-block" disabled={busy} aria-busy={busy || undefined}>
                {busy ? <><Icon.loader className="spinner" />Please wait…</> : mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create account' : 'Reset password'}
              </button>
            </form>
            <div style={{ marginTop: 18, textAlign: 'center' }}>
              {mode === 'recover'
                ? <button className="btn btn-ghost btn-sm" onClick={() => { setMode('in'); setError(''); }}><Icon.back />Back to sign in</button>
                : <button className="btn btn-ghost btn-sm" onClick={() => { setMode('recover'); setError(''); }}>Forgot password? Use a recovery code</button>}
            </div>
            <p className="tiny" style={{ marginTop: 12, textAlign: 'center' }}>Passwords are hashed in the database. Sessions use secure HttpOnly cookies and are checked on every request.</p>
          </>}
        </div>
      </div>
    </div>
  );
}

function NotFoundPage() {
  return <>
    <PageHead title="Page not found" desc="This address does not belong to a page in HomecoreOS." />
    <div className="card"><EmptyState icon="help" title="We could not find that page"
      text="The link may be outdated. Choose a section below to get back to your home."
      action={<><Link className="btn btn-primary" to="/"><Icon.home />Overview</Link>
        <Link className="btn" to="/setup"><Icon.plug />Add a controller</Link></>} /></div>
  </>;
}

function RoutesView() {
  const { signedIn, loading, platform_admin } = useAuth();
  const location = useLocation();
  useEffect(() => { observeReveals(); }, [loading, signedIn]);
  if (loading) return <div style={{ height: '100dvh', display: 'grid', placeItems: 'center', padding: 24 }}><Loading rows={3} /></div>;
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
        <Route path="/owner/firmware" element={<OwnerFirmware />} />
        <Route path="/owner/boards" element={<OwnerBoards />} />
        <Route path="/owner/setup" element={<OwnerSetup />} />
        <Route path="/owner/settings" element={<OwnerSettings />} />
        <Route path="/owner/settings/integrations" element={<OwnerIntegrations />} />
        <Route path="/owner/audit" element={<OwnerAudit />} />
        <Route path="/owner/security" element={<OwnerSecurity />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return <AuthProvider><RoutesView /></AuthProvider>;
}
