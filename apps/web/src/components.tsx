import React, { useEffect } from 'react';
import {
  Activity, AlertCircle, AlertTriangle, ArrowLeft, ArrowRight, Bell, Bluetooth, Box, Check,
  CheckCircle2, ChevronDown, Cpu, Download, Eye, Fan, Gauge, HardDrive, Home, Info, Layers,
  Lightbulb, Link2, Lock, MapPin, MoreHorizontal, Pencil, Plug, Plus, Power, Radio, RefreshCw,
  Search, Server, Settings, Shield, Sliders, Trash2, Usb, Users, Wifi, X, Zap, Droplet, Cog,
  Thermometer, Waves, Sun, DoorOpen, Battery, BarChart3, FileText, Clock, Copy, CircleHelp,
} from 'lucide-react';

export const Icon = {
  activity: Activity, alert: AlertCircle, warning: AlertTriangle, back: ArrowLeft, next: ArrowRight,
  bell: Bell, bluetooth: Bluetooth, box: Box, check: Check, ok: CheckCircle2, down: ChevronDown,
  cpu: Cpu, download: Download, eye: Eye, fan: Fan, gauge: Gauge, drive: HardDrive, home: Home,
  info: Info, layers: Layers, light: Lightbulb, link: Link2, lock: Lock, pin: MapPin, more: MoreHorizontal,
  edit: Pencil, plug: Plug, plus: Plus, power: Power, radio: Radio, refresh: RefreshCw, search: Search,
  server: Server, settings: Settings, shield: Shield, sliders: Sliders, trash: Trash2, usb: Usb,
  users: Users, wifi: Wifi, close: X, zap: Zap, droplet: Droplet, cog: Cog, thermometer: Thermometer,
  waves: Waves, sun: Sun, door: DoorOpen, battery: Battery, chart: BarChart3, file: FileText,
  clock: Clock, copy: Copy, help: CircleHelp,
};

export function PageHead({ title, desc, actions }: { title: string; desc?: string; actions?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{desc && <p className="desc">{desc}</p>}</div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, sub, actions, children, pad = true, className = '' }: {
  title?: string; sub?: string; actions?: React.ReactNode; children: React.ReactNode; pad?: boolean; className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <div><h3>{title}</h3>{sub && <div className="sub">{sub}</div>}</div>
          {actions}
        </div>
      )}
      {pad ? <div className="card-pad">{children}</div> : children}
    </section>
  );
}

export function Stat({ label, value, foot, icon }: { label: string; value: React.ReactNode; foot?: string; icon?: keyof typeof Icon }) {
  const I = icon ? Icon[icon] : null;
  return (
    <div className="card stat">
      {I && <div className="stat-icon"><I /></div>}
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}

export function Badge({ children, tone = '' }: { children: React.ReactNode; tone?: 'on' | 'off' | 'warn' | 'danger' | 'info' | '' }) {
  return <span className={`badge ${tone}`}><span className="dot" />{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    online: ['Online', 'on'], offline: ['Offline', 'off'], active: ['Active', 'on'],
    provisioning: ['Provisioning', 'warn'], unclaimed: ['Unclaimed', 'off'], disabled: ['Disabled', 'danger'],
    suspended: ['Suspended', 'danger'], synced: ['Synced', 'on'], pending: ['Pending sync', 'warn'],
    failed: ['Failed', 'danger'], stale: ['Stale', 'warn'], on: ['ON', 'on'], off: ['OFF', 'off'],
    unknown: ['Unknown', ''], published: ['Published', 'info'], acknowledged: ['Acknowledged', 'on'],
    confirmed: ['Confirmed', 'on'], queued: ['Queued', ''], expired: ['Expired', 'danger'],
    success: ['Success', 'on'], rolled_back: ['Rolled back', 'warn'],
  };
  const [label, tone] = map[status] || [status, ''];
  return <Badge tone={tone as any}>{label}</Badge>;
}

export function EmptyState({ icon = 'box', title, text, action }: { icon?: keyof typeof Icon; title: string; text: string; action?: React.ReactNode }) {
  const I = Icon[icon];
  return <div className="empty"><div className="empty-icon"><I /></div><h4>{title}</h4><p>{text}</p>{action}</div>;
}

export function Skeleton({ height = 120 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} />;
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return <div className="grid grid-3">{Array.from({ length: rows }).map((_, i) => <Skeleton key={i} height={110} />)}</div>;
}

export function Modal({ title, children, onClose, footer, wide = false }: {
  title: string; children: React.ReactNode; onClose: () => void; footer?: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2><button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><Icon.close /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <div className="field"><label>{label}</label>{children}{hint && <span className="hint">{hint}</span>}</div>;
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'danger'; children: React.ReactNode }) {
  const I = tone === 'warn' || tone === 'danger' ? Icon.warning : Icon.info;
  return <div className={`notice ${tone === 'info' ? '' : tone}`}><I /><div>{children}</div></div>;
}

export function Tabs({ items, value, onChange }: { items: { id: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return <div className="tabs">{items.map((i) => <button key={i.id} className={value === i.id ? 'on' : ''} onClick={() => onChange(i.id)}>{i.label}</button>)}</div>;
}

export function Progress({ value, tone = '' }: { value: number; tone?: '' | 'warn' | 'danger' }) {
  return <div className={`progress ${tone}`}><div style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
}

export function DataTable({ columns, rows, empty }: {
  columns: { key: string; label: string; render?: (r: any) => React.ReactNode; width?: string }[];
  rows: any[]; empty?: React.ReactNode;
}) {
  if (!rows.length) return <>{empty}</>;
  return (
    <div className="table-wrap"><table className="tbl">
      <thead><tr>{columns.map((c) => <th key={c.key} style={{ width: c.width }}>{c.label}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={r.id ?? i}>{columns.map((c) => <td key={c.key}>{c.render ? c.render(r) : String(r[c.key] ?? '—')}</td>)}</tr>)}</tbody>
    </table></div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  return <button className="btn btn-sm" onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
  }}>{copied ? <Icon.check /> : <Icon.copy />}{copied ? 'Copied' : label}</button>;
}

export const DEVICE_ICONS: Record<string, keyof typeof Icon> = {
  light: 'light', fan: 'fan', water_pump: 'droplet', relay: 'power', smart_socket: 'plug',
  motor: 'cog', main_line_monitor: 'activity', custom: 'box',
};
export const SENSOR_ICONS: Record<string, keyof typeof Icon> = {
  temperature: 'thermometer', humidity: 'waves', motion: 'activity', water_level: 'droplet',
  rain: 'droplet', light: 'sun', soil_moisture: 'droplet', contact: 'door', voltage: 'zap',
  current: 'zap', power: 'gauge', gas: 'waves', air_quality: 'waves', custom: 'box',
};
export const ROOM_ICONS: Record<string, keyof typeof Icon> = {
  home: 'home', living: 'light', bedroom: 'home', kitchen: 'plug', bathroom: 'droplet',
  garage: 'cog', garden: 'sun', pump: 'droplet', office: 'file', custom: 'box',
};

export function MiniChart({ points, height = 130, labels }: { points: number[]; height?: number; labels?: string[] }) {
  const w = 600, h = height;
  const max = Math.max(...points, 1), min = Math.min(...points, 0);
  const range = max - min || 1;
  const coords: [number, number][] = points.map((v, i) => [8 + (i * (w - 16)) / Math.max(1, points.length - 1), h - 14 - ((v - min) / range) * (h - 28)]);
  const path = coords.map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ');
  const area = points.length ? `${path} L${coords[coords.length - 1]?.[0]?.toFixed(1) ?? 0},${h - 14} L${coords[0]?.[0]?.toFixed(1) ?? 0},${h - 14} Z` : '';
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" height={height}>
      {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={w} y1={h * f} y2={h * f} stroke="#EDEEF3" strokeWidth="1" />)}
      {points.length > 0 && <><path d={area} fill="rgba(32,33,43,.05)" /><path className="spark-line" d={path} /></>}
      {labels && labels.map((l, i) => <text key={i} x={8 + (i * (w - 16)) / Math.max(1, labels.length - 1)} y={h - 2} fontSize="9" fill="#9395A4">{l}</text>)}
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
