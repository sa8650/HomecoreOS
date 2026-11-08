import React, { useEffect, useState } from 'react';
import { makeIcon } from './icons';

/** One icon family, one stroke weight, semantic keys used by every screen. */
export const Icon = {
  activity: makeIcon('Pulse'), alert: makeIcon('WarningCircle'), warning: makeIcon('Warning'), back: makeIcon('ArrowLeft'), next: makeIcon('ArrowRight'),
  bell: makeIcon('Bell'), bluetooth: makeIcon('Bluetooth'), box: makeIcon('Package'), check: makeIcon('Check'), ok: makeIcon('CheckCircle'), down: makeIcon('CaretDown'),
  cpu: makeIcon('Cpu'), download: makeIcon('DownloadSimple'), eye: makeIcon('Eye'), fan: makeIcon('Fan'), gauge: makeIcon('Gauge'), drive: makeIcon('HardDrives'),
  home: makeIcon('House'), info: makeIcon('Info'), layers: makeIcon('Stack'), light: makeIcon('Lightbulb'), link: makeIcon('LinkSimple'), lock: makeIcon('Lock'),
  pin: makeIcon('MapPin'), more: makeIcon('DotsThree'), edit: makeIcon('PencilSimple'), plug: makeIcon('Plug'), plus: makeIcon('Plus'), power: makeIcon('Power'),
  radio: makeIcon('Radio'), refresh: makeIcon('ArrowClockwise'), search: makeIcon('MagnifyingGlass'), server: makeIcon('Database'),
  settings: makeIcon('GearSix'), shield: makeIcon('Shield'), sliders: makeIcon('SlidersHorizontal'), trash: makeIcon('TrashSimple'), usb: makeIcon('Usb'),
  users: makeIcon('UsersThree'), wifi: makeIcon('WifiHigh'), close: makeIcon('X'), zap: makeIcon('Lightning'), droplet: makeIcon('Drop'),
  cog: makeIcon('Wrench'), thermometer: makeIcon('Thermometer'), waves: makeIcon('Waves'), sun: makeIcon('Sun'), door: makeIcon('Door'),
  battery: makeIcon('BatteryFull'), chart: makeIcon('ChartBar'), file: makeIcon('FileText'), clock: makeIcon('Clock'), copy: makeIcon('CopySimple'),
  help: makeIcon('Question'), cube: makeIcon('Cube'), stack: makeIcon('StackSimple'), archive: makeIcon('Archive'), upload: makeIcon('UploadSimple'),
  cloudUp: makeIcon('CloudArrowUp'), cloudOk: makeIcon('CloudCheck'), cloudOff: makeIcon('CloudX'), calendar: makeIcon('CalendarBlank'),
  hash: makeIcon('HashStraight'), fingerprint: makeIcon('Fingerprint'), shieldOk: makeIcon('ShieldCheck'), user: makeIcon('UserCircle'),
  key: makeIcon('Key'), signOut: makeIcon('SignOut'), right: makeIcon('CaretRight'), external: makeIcon('ArrowSquareOut'), spinner: makeIcon('SpinnerGap'),
  moon: makeIcon('Moon'), system: makeIcon('Monitor'), list: makeIcon('List'), filter: makeIcon('FunnelSimple'), tree: makeIcon('TreeStructure'),
  grid: makeIcon('SquaresFour'), bed: makeIcon('Bed'), kitchen: makeIcon('ForkKnife'), bath: makeIcon('Bathtub'), garden: makeIcon('Flower'),
  garage: makeIcon('Garage'), office: makeIcon('Briefcase'), car: makeIcon('Car'), lamp: makeIcon('Lamp'), wind: makeIcon('Wind'), circuitry: makeIcon('Circuitry'),
  memory: makeIcon('Memory'), note: makeIcon('NotePencil'), retry: makeIcon('ArrowCounterClockwise'), block: makeIcon('Prohibit'),
  fail: makeIcon('XCircle'), book: makeIcon('BookOpen'), timer: makeIcon('Timer'), card: makeIcon('IdentificationCard'), loader: makeIcon('CircleNotch'),
  upDown: makeIcon('CaretUpDown'), globe: makeIcon('GlobeHemisphereWest'), network: makeIcon('Network'), plugCharge: makeIcon('PlugCharging'),
};
export type IconKey = keyof typeof Icon;

export function PageHead({ title, desc, actions, eyebrow }: {
  title: string; desc?: string; actions?: React.ReactNode; eyebrow?: string;
}) {
  return (
    <header className="page-head reveal">
      <div>
        {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {desc && <p className="desc">{desc}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, sub, actions, children, pad = true, className = '', style, icon }: {
  title?: string; sub?: string; actions?: React.ReactNode; children: React.ReactNode;
  pad?: boolean; className?: string; style?: React.CSSProperties; icon?: IconKey;
}) {
  const Glyph = icon ? Icon[icon] : null;
  return (
    <section className={`card reveal ${className}`} style={style}>
      {(title || actions) && (
        <div className="card-head">
          <div className="card-head-text">
            {Glyph && <span className="card-head-icon"><Glyph /></span>}
            <div><h3>{title}</h3>{sub && <div className="sub">{sub}</div>}</div>
          </div>
          {actions}
        </div>
      )}
      {pad ? <div className="card-pad">{children}</div> : children}
    </section>
  );
}

export function Stat({ label, value, foot, icon }: {
  label: string; value: React.ReactNode; foot?: string; icon?: IconKey;
}) {
  const I = icon ? Icon[icon] : null;
  return (
    <div className="card stat reveal">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {I && <span className="stat-icon"><I /></span>}
      </div>
      <div className="stat-value">{value}</div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}

export function Badge({ children, tone = '', icon }: {
  children: React.ReactNode; tone?: 'on' | 'off' | 'warn' | 'danger' | 'info' | ''; icon?: IconKey;
}) {
  const Glyph = icon ? Icon[icon] : null;
  return <span className={`badge ${tone}`}>{Glyph ? <Glyph /> : <span className="dot" />}{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string, IconKey]> = {
    online: ['Online', 'on', 'cloudOk'], offline: ['Offline', 'off', 'cloudOff'],
    active: ['Active', 'on', 'ok'], provisioning: ['Connecting', 'warn', 'loader'],
    unclaimed: ['Not paired', 'off', 'plug'], disabled: ['Disabled', 'danger', 'block'],
    suspended: ['Suspended', 'danger', 'block'], synced: ['In sync', 'on', 'ok'],
    pending: ['Waiting', 'warn', 'timer'], failed: ['Failed', 'danger', 'fail'],
    stale: ['No recent data', 'warn', 'clock'], on: ['On', 'on', 'power'],
    off: ['Off', 'off', 'power'], unknown: ['Unknown', '', 'help'],
    published: ['Published', 'info', 'cloudOk'], acknowledged: ['Acknowledged', 'on', 'ok'],
    confirmed: ['Confirmed', 'on', 'ok'], queued: ['Queued', 'warn', 'timer'],
    downloading: ['Downloading', 'warn', 'download'], installing: ['Installing', 'warn', 'upload'],
    verifying: ['Verifying', 'warn', 'shieldOk'], expired: ['Expired', 'danger', 'clock'],
    success: ['Successful', 'on', 'ok'], rolled_back: ['Rolled back', 'warn', 'retry'],
    draft: ['Draft', '', 'note'], archived: ['Archived', 'off', 'archive'],
  };
  const [label, tone, glyph] = map[status] || [status, '', 'info'];
  return <Badge tone={tone as any} icon={glyph}>{label}</Badge>;
}

export function EmptyState({ icon = 'box', title, text, action }: {
  icon?: IconKey; title: string; text: string; action?: React.ReactNode;
}) {
  const I = Icon[icon];
  return (
    <div className="state-panel reveal">
      <div className="state-art"><I /></div>
      <h4>{title}</h4>
      <p>{text}</p>
      {action && <div className="state-actions">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = 'Could not load this section', text, onRetry }: {
  title?: string; text: string; onRetry?: () => void;
}) {
  return (
    <div className="state-panel state-error reveal" role="alert">
      <div className="state-art"><Icon.alert /></div>
      <h4>{title}</h4><p>{text}</p>
      {onRetry && <div className="state-actions"><button className="btn" onClick={onRetry}><Icon.retry /> Try again</button></div>}
    </div>
  );
}

export function SuccessState({ title, text, action }: {
  title: string; text: string; action?: React.ReactNode;
}) {
  return (
    <div className="state-panel state-success reveal" role="status">
      <div className="state-art"><Icon.ok /></div>
      <h4>{title}</h4><p>{text}</p>
      {action && <div className="state-actions">{action}</div>}
    </div>
  );
}

export function Skeleton({ height = 120, radius = 'var(--r-8)' }: { height?: number; radius?: string }) {
  return <div className="skeleton" style={{ height, borderRadius: radius }} />;
}

export function Loading({ rows = 3, shape = 'card' }: { rows?: number; shape?: 'card' | 'row' | 'table' }) {
  if (shape === 'table') return (
    <div className="skeleton-table" aria-busy="true" aria-label="Loading">
      <Skeleton height={38} />
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} height={52} />)}
    </div>
  );
  if (shape === 'row') return (
    <div className="skeleton-rows" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => <div className="skeleton-row" key={i}>
        <Skeleton height={34} radius="var(--r-full)" /><Skeleton height={14} /><Skeleton height={14} />
      </div>)}
    </div>
  );
  return (
    <div className="grid grid-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => <div className="card card-pad skeleton-card" key={i}>
        <Skeleton height={34} radius="var(--r-full)" /><Skeleton height={13} /><Skeleton height={26} />
      </div>)}
    </div>
  );
}

export function Modal({ title, children, onClose, footer, wide = false, description }: {
  title: string; description?: string; children: React.ReactNode; onClose: () => void;
  footer?: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div><h2>{title}</h2>{description && <p className="modal-desc">{description}</p>}</div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><Icon.close /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children, required }: {
  label: string; hint?: string; error?: string; children: React.ReactNode; required?: boolean;
}) {
  return (
    <div className={`field ${error ? 'field-error' : ''}`}>
      <label>{label}{required && <span className="required" aria-hidden="true"> *</span>}</label>
      {children}
      {error ? <span className="field-msg field-msg-error" role="alert"><Icon.alert /> {error}</span>
        : hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Notice({ tone = 'info', children, title }: {
  tone?: 'info' | 'warn' | 'danger' | 'success'; children: React.ReactNode; title?: string;
}) {
  const glyph: Record<string, IconKey> = { info: 'info', warn: 'warning', danger: 'fail', success: 'ok' };
  const G = Icon[glyph[tone] || 'info'];
  return (
    <div className={`notice ${tone}`} role={tone === 'danger' ? 'alert' : 'note'}>
      <G /><div>{title && <strong className="notice-title">{title}</strong>}{children}</div>
    </div>
  );
}

export function Tabs({ items, value, onChange }: {
  items: { id: string; label: string; icon?: IconKey }[]; value: string; onChange: (v: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((i) => {
        const G = i.icon ? Icon[i.icon] : null;
        return <button key={i.id} role="tab" aria-selected={value === i.id}
          className={value === i.id ? 'on' : ''} onClick={() => onChange(i.id)}>
          {G && <G />}{i.label}
        </button>;
      })}
    </div>
  );
}

export function Progress({ value, tone = '' }: { value: number; tone?: '' | 'warn' | 'danger' | 'on' }) {
  return (
    <div className={`progress ${tone}`} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function DataTable({ columns, rows, empty }: {
  columns: { key: string; label: string; render?: (r: any) => React.ReactNode; width?: string }[];
  rows: any[]; empty?: React.ReactNode;
}) {
  if (!rows.length) return <>{empty}</>;
  return (
    <div className="table-wrap"><table className="tbl">
      <thead><tr>{columns.map((c) => <th key={c.key} style={{ width: c.width }} scope="col">{c.label}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={r.id ?? i}>
        {columns.map((c) => <td key={c.key}>{c.render ? c.render(r) : String(r[c.key] ?? '—')}</td>)}
      </tr>)}</tbody>
    </table></div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="btn btn-sm" onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch { /* clipboard unavailable in a sandboxed preview */ }
  }}>{copied ? <Icon.check /> : <Icon.copy />}{copied ? 'Copied' : label}</button>;
}

export const DEVICE_ICONS: Record<string, IconKey> = {
  light: 'light', fan: 'fan', water_pump: 'droplet', relay: 'power', smart_socket: 'plug',
  motor: 'cog', main_line_monitor: 'activity', custom: 'box',
};
export const SENSOR_ICONS: Record<string, IconKey> = {
  temperature: 'thermometer', humidity: 'waves', motion: 'activity', water_level: 'droplet',
  rain: 'droplet', light: 'sun', soil_moisture: 'droplet', contact: 'door', voltage: 'zap',
  current: 'zap', power: 'gauge', gas: 'waves', air_quality: 'wind', custom: 'box',
};
export const ROOM_ICONS: Record<string, IconKey> = {
  home: 'home', living: 'lamp', bedroom: 'bed', kitchen: 'kitchen', bathroom: 'bath',
  garage: 'garage', garden: 'garden', pump: 'droplet', office: 'office', custom: 'cube',
};

export function MiniChart({ points, height = 130, labels }: {
  points: number[]; height?: number; labels?: string[];
}) {
  const w = 600, h = height;
  const max = Math.max(...points, 1), min = Math.min(...points, 0);
  const range = max - min || 1;
  const coords: [number, number][] = points.map((v, i) => [
    8 + (i * (w - 16)) / Math.max(1, points.length - 1),
    h - 14 - ((v - min) / range) * (h - 28),
  ]);
  const path = coords.map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ');
  const area = points.length
    ? `${path} L${coords[coords.length - 1]?.[0]?.toFixed(1) ?? 0},${h - 14} L${coords[0]?.[0]?.toFixed(1) ?? 0},${h - 14} Z` : '';
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" height={height} role="img" aria-label="Sensor trend">
      {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={w} y1={h * f} y2={h * f} stroke="var(--chart-grid)" strokeWidth="1" />)}
      {points.length > 0 && <><path d={area} fill="var(--chart-fill)" /><path className="spark-line" d={path} /></>}
      {labels && labels.map((l, i) => <text key={i} x={8 + (i * (w - 16)) / Math.max(1, labels.length - 1)} y={h - 2} fontSize="9" fill="var(--text-3)">{l}</text>)}
    </svg>
  );
}

/** Inline, dependency-free illustration of an ESP32 controller. */
export function DeviceIllustration({ state = 'ready', size = 168 }: {
  state?: 'ready' | 'scanning' | 'wifi' | 'cloud' | 'done' | 'error'; size?: number;
}) {
  const color = state === 'error' ? 'var(--state-danger)' : state === 'done' ? 'var(--state-on)' : 'var(--accent)';
  return (
    <svg viewBox="0 0 220 160" width={size} height={size * 160 / 220} role="img"
      aria-label={state === 'done' ? 'Controller connected' : 'ESP32 controller illustration'}>
      <rect x="46" y="30" width="128" height="100" rx="12" fill="var(--surface-3)" stroke="var(--border-strong)" strokeWidth="2" />
      <rect x="56" y="40" width="108" height="80" rx="8" fill="var(--surface-1)" stroke="var(--border)" strokeWidth="1.5" />
      <rect x="76" y="52" width="68" height="40" rx="4" fill="var(--surface-4)" stroke="var(--border-strong)" strokeWidth="1.5" />
      <text x="110" y="77" textAnchor="middle" fontSize="10" fill="var(--text-2)" fontFamily="monospace">ESP32</text>
      <rect x="66" y="100" width="88" height="12" rx="3" fill="var(--surface-4)" />
      {[0, 1, 2, 3, 4, 5, 6].map((i) => <rect key={i} x={72 + i * 12} y="102" width="5" height="8" rx="1" fill="var(--border-strong)" />)}
      <rect x="88" y="18" width="44" height="14" rx="3" fill="var(--surface-4)" stroke="var(--border-strong)" strokeWidth="1.2" />
      <circle cx="110" cy="112" r="3" fill={color} className={state === 'scanning' ? 'ill-pulse' : ''} />
      {state === 'wifi' && <g fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" className="ill-wave">
        <path d="M92 14 Q110 3 128 14" /><path d="M99 20 Q110 12 121 20" />
      </g>}
      {(state === 'cloud' || state === 'done') && <g fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" className="ill-wave">
        <path d="M20 80 Q110 -8 200 80" opacity=".45" /><circle cx="200" cy="80" r="6" fill={color} stroke="none" />
      </g>}
      {state === 'scanning' && <circle cx="110" cy="80" r="46" fill="none" stroke={color} strokeWidth="2" className="ill-scan" />}
      <text x="110" y="150" textAnchor="middle" fontSize="9" fill="var(--text-3)" fontFamily="monospace">HOMECOREOS · CONTROLLER</text>
    </svg>
  );
}

export function fmt(n: any, digits = 1) {
  if (n === null || n === undefined || n === '') return '—';
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: digits }) : String(n);
}
export function fmtBytes(n: any) {
  if (n === null || n === undefined) return 'Unavailable';
  const v = Number(n);
  if (!Number.isFinite(v)) return 'Unavailable';
  if (v >= 1073741824) return `${(v / 1073741824).toFixed(2)} GB`;
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
}
export function timeAgo(v: any) {
  if (!v) return 'Never';
  const d = new Date(v), diff = Date.now() - d.getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function timeFull(v: any) { return v ? new Date(v).toLocaleString() : '—'; }
