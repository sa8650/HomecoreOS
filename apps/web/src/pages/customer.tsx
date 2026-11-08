import React, { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useLiveData, useAction } from '../api';
import { useAuth } from '../state';
import {
  Badge, Card, CopyButton, DataTable, EmptyState, Field, Icon, Loading, MiniChart, Modal,
  Notice, PageHead, Progress, Skeleton, Stat, StatusBadge, Tabs, fmt, fmtBytes, timeAgo, timeFull,
  DEVICE_ICONS, SENSOR_ICONS, ROOM_ICONS,
} from '../components';
import { DEVICE_TYPES, SENSOR_CATEGORIES, PROVISIONING_METHODS, CHIP_FAMILIES, evaluatePin } from '@homecoreos/core';

function useToast() { return useAuth().toast; }
const human = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function ConfirmModal({ title, text, confirmLabel = 'Delete', danger = true, onConfirm, onClose, children }: {
  title: string; text: string; confirmLabel?: string; danger?: boolean; onConfirm: () => Promise<void> | void; onClose: () => void; children?: React.ReactNode;
}) {
  const { run, busy } = useAction();
  return <Modal title={title} onClose={onClose} footer={<>
    <button className="btn" onClick={onClose}>Cancel</button>
    <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={async () => { await run(async () => { await onConfirm(); }); onClose(); }}>{confirmLabel}</button>
  </>}><p className="muted" style={{ lineHeight: 1.6 }}>{text}</p>{children}</Modal>;
}

// ============================================================================
// Overview
// ============================================================================
export function CustomerOverview() {
  const { tenant, can } = useAuth();
  const { data, loading, refresh } = useLiveData<any>('/api/overview');
  const stats = data?.stats || {};
  const [pending, setPending] = useState<string | null>(null);
  const toast = useToast();
  const toggle = async (d: any) => {
    setPending(d.id);
    try {
      const value = d.reported_state !== 'on';
      await api.post(`/api/devices/${d.id}/command`, { action: 'set_state', value });
      toast(`${d.name}: command sent, waiting for device acknowledgement`);
      setTimeout(refresh, 700);
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setPending(null); }
  };
  return <>
    <PageHead title="Overview" desc={tenant?.name} actions={<>
      <Link className="btn" to="/rooms"><Icon.pin />Manage rooms</Link>
      {can('devices.manage') && <Link className="btn btn-primary" to="/setup"><Icon.plus />Add Controller</Link>}
    </>} />
    {loading ? <Loading rows={4} /> : <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Rooms" value={stats.rooms ?? 0} icon="pin" foot="Organised spaces" />
        <Stat label="Controllers" value={stats.boards ?? 0} icon="cpu" foot={`${stats.boards_online ?? 0} online`} />
        <Stat label="Devices" value={stats.devices ?? 0} icon="power" foot={`${stats.devices_on ?? 0} confirmed ON`} />
        <Stat label="Sensors" value={stats.sensors ?? 0} icon="gauge" foot={`${stats.readings_24h ?? 0} readings / 24h`} />
      </div>
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card title="Quick control" sub="Acknowledged physical state, not button intent" actions={<Link className="btn btn-sm" to="/switches">All switches <Icon.next /></Link>}>
          {!data?.devices?.length ? <EmptyState icon="power" title="No devices yet" text="Register a controller and add a switch to start controlling real hardware." action={<Link className="btn btn-primary btn-sm" to="/setup">Start setup</Link>} /> :
            <div className="grid grid-2">{data.devices.slice(0, 6).map((d: any) => <DeviceCard key={d.id} d={d} onToggle={() => toggle(d)} pending={pending === d.id} compact />)}</div>}
        </Card>
        <div style={{ display: 'grid', gap: 14 }}>
          <Card title="Controllers" sub="Live connection state" actions={<Link className="btn btn-sm" to="/controllers">Open <Icon.next /></Link>}>
            {!data?.boards?.length ? <EmptyState icon="cpu" title="No controllers" text="Pair your first ESP32 to create a controller." /> :
              <>{data.boards.slice(0, 5).map((b: any) => <div className="list-item" key={b.id}>
                <div className="icon-box"><Icon.cpu /></div>
                <div className="grow"><div className="title">{b.name}</div><div className="meta mono">{b.device_id}</div></div>
                <StatusBadge status={b.status} />
              </div>)}</>}
          </Card>
          <Card title="Recent activity" sub="Audit trail from this workspace">
            {!data?.recent_activity?.length ? <EmptyState icon="activity" title="No activity yet" text="Administrative and device operations will appear here." /> :
              data.recent_activity.slice(0, 6).map((a: any) => <div className="list-item" key={a.id}>
                <div className="icon-box"><Icon.activity /></div>
                <div className="grow"><div className="title">{human(a.action.replace(/\./g, ' '))}</div><div className="meta">{a.actor_email || a.actor_type}</div></div>
                <span className="tiny">{timeAgo(a.created_at)}</span>
              </div>)}
          </Card>
        </div>
      </div>
    </>}
  </>;
}

function DeviceCard({ d, onToggle, pending, compact = false, readOnly = false }: { d: any; onToggle: () => void; pending?: boolean; compact?: boolean; readOnly?: boolean }) {
  const boardOffline = d.board_status && d.board_status !== 'online';
  const confirmed = d.reported_state === 'on';
  const requested = d.requested_state;
  const stateLabel = boardOffline ? 'Controller offline' :
    d.reported_state === 'unknown' ? 'State unknown' :
      requested && requested !== d.reported_state ? `Requested ${String(requested).toUpperCase()} — awaiting acknowledgement` :
        `Confirmed ${String(d.reported_state).toUpperCase()}`;
  const I = Icon[DEVICE_ICONS[d.device_type] || 'power'];
  return <div className="card device-card">
    <div className="device-top">
      <div style={{ display: 'flex', gap: 10 }}><div className="device-icon"><I /></div>
        <div><div className="device-name">{d.name}</div><div className="device-meta">{human(d.device_type)} · {d.room_name || 'No room'}</div></div></div>
      <StatusBadge status={d.reported_state} />
    </div>
    {!compact && <div className="kv" style={{ gridTemplateColumns: '100px 1fr' }}>
      <dt>GPIO</dt><dd className="mono">{d.output_gpio ?? '—'}</dd>
      <dt>Logic</dt><dd>{d.active_low ? 'Active low' : 'Active high'}</dd>
      <dt>Interface</dt><dd>{human(d.interface || 'gpio')}</dd>
      <dt>Last update</dt><dd>{timeAgo(d.last_state_at)}</dd>
    </div>}
    <div className="device-state">
      <div><div className="tiny">{stateLabel}</div><div className="state-line">{boardOffline ? 'Commands cannot be confirmed right now' : requested ? 'Command in flight' : 'Device-reported state'}</div></div>
      <button className={`switch ${confirmed ? 'on' : ''}`} disabled={pending || readOnly || boardOffline} onClick={onToggle} aria-label={`Toggle ${d.name}`} aria-pressed={confirmed} />
    </div>
  </div>;
}

// ============================================================================
// Rooms
// ============================================================================
export function RoomsPage() {
  const { data, loading, refresh } = useLiveData<any[]>('/api/rooms');
  const { can } = useAuth();
  const toast = useToast();
  const { run, busy, error } = useAction();
  const [form, setForm] = useState<any>(null);
  const [del, setDel] = useState<any>(null);
  const [strategy, setStrategy] = useState('unassign');
  const [view, setView] = useState<any>(null);
  const save = async () => {
    const ok = await run(async () => {
      if (form.id) await api.patch(`/api/rooms/${form.id}`, form); else await api.post('/api/rooms', form);
      setForm(null); refresh(); toast('Room saved');
    });
    if (!ok && error) toast(error, 'error');
  };
  return <>
    <PageHead title="Rooms" desc="Organise devices by space. Room assignment is independent of GPIO allocation." actions={can('rooms.manage') && <button className="btn btn-primary" onClick={() => setForm({ name: '', icon: 'home', floor: '' })}><Icon.plus />New room</button>} />
    {loading ? <Loading rows={3} /> : !data?.length ? <Card><EmptyState icon="pin" title="No rooms yet" text="Create rooms first, then add switches and sensors to them." action={can('rooms.manage') && <button className="btn btn-primary" onClick={() => setForm({ name: '', icon: 'home' })}>Create room</button>} /></Card> :
      <div className="grid grid-3">{data.map((r: any) => {
        const I = Icon[ROOM_ICONS[r.icon] || 'home'];
        return <div className="card" key={r.id}>
          <div className="card-pad">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div className="icon-box" style={{ width: 38, height: 38 }}><I /></div>
              <div style={{ display: 'flex', gap: 4 }}>
                {can('rooms.manage') && <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setForm({ ...r })}><Icon.edit /></button>}
                {can('rooms.manage') && <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setDel(r)}><Icon.trash /></button>}
              </div>
            </div>
            <h3 style={{ fontSize: 15, fontWeight: 650, marginTop: 14 }}>{r.name}</h3>
            <div className="tiny">{r.floor || 'No floor'} · {r.devices.length} devices · {r.sensors.length} sensors {r.archived_at ? '· Archived' : ''}</div>
            <div className="divider" />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-sm" onClick={() => setView(r)}><Icon.eye />View devices</button>
              <Link className="btn btn-sm" to="/switches"><Icon.power />Control</Link>
            </div>
          </div>
        </div>;
      })}</div>}
    {form && <Modal title={form.id ? 'Edit room' : 'New room'} onClose={() => setForm(null)} footer={<>
      <button className="btn" onClick={() => setForm(null)}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !form.name} onClick={save}>{busy ? 'Saving…' : 'Save room'}</button>
    </>}>
      <Field label="Room name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Living Room" /></Field>
      <div className="form-row">
        <Field label="Icon"><select className="select" value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })}>{Object.keys(ROOM_ICONS).map((x) => <option key={x} value={x}>{human(x)}</option>)}</select></Field>
        <Field label="Floor / area"><input className="input" value={form.floor || ''} onChange={(e) => setForm({ ...form, floor: e.target.value })} placeholder="Ground floor" /></Field>
      </div>
      <Field label="Description" hint="Optional"><input className="input" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      <label className="check"><input type="checkbox" checked={!!form.archived_at} onChange={(e) => setForm({ ...form, archived: e.target.checked, archived_at: e.target.checked ? (form.archived_at || new Date().toISOString()) : null })} />Archive this room</label>
    </Modal>}
    {del && <ConfirmModal title={`Delete ${del.name}?`} confirmLabel="Delete room" text="Choose what happens to devices in this room. Their GPIO assignments are only released if you delete the devices." onClose={() => setDel(null)} onConfirm={async () => {
      try { await api.del(`/api/rooms/${del.id}?strategy=${strategy}`); toast('Room deleted'); refresh(); }
      catch (e: any) { toast(e.message, 'error'); }
    }}>
      <div className="divider" />
      <Field label="Existing devices">{[
        ['unassign', 'Keep devices, remove room assignment'],
        ['delete_devices', 'Delete devices and release their GPIOs'],
        ['archive_only', 'Archive room only, keep everything'],
      ].map(([id, label]) => <label className="check" key={id} style={{ marginBottom: 8 }}><input type="radio" name="strategy" checked={strategy === id} onChange={() => setStrategy(id!)} />{label}</label>)}</Field>
    </ConfirmModal>}
    {view && <Modal title={`${view.name} · devices`} onClose={() => setView(null)} wide>
      <h4 style={{ fontSize: 12.5, marginBottom: 8 }}>Switches</h4>
      {!view.devices.length ? <p className="muted tiny">No switches assigned.</p> : view.devices.map((d: any) => <div className="list-item" key={d.id}><div className="icon-box"><Icon.power /></div><div className="grow"><div className="title">{d.name}</div><div className="meta mono">GPIO {d.output_gpio ?? '—'}</div></div><StatusBadge status={d.reported_state} /></div>)}
      <div className="divider" /><h4 style={{ fontSize: 12.5, marginBottom: 8 }}>Sensors</h4>
      {!view.sensors.length ? <p className="muted tiny">No sensors assigned.</p> : view.sensors.map((s: any) => <div className="list-item" key={s.id}><div className="icon-box"><Icon.gauge /></div><div className="grow"><div className="title">{s.name}</div><div className="meta">{human(s.category)}</div></div><span className="mono">{fmt(s.last_value)} {s.unit}</span></div>)}
    </Modal>}
  </>;
}

// ============================================================================
// Shared wizard: pin selection + communication summary
// ============================================================================
function useHardware() {
  const boards = useLiveData<any[]>('/api/boards');
  const rooms = useLiveData<any[]>('/api/rooms');
  return { boards, rooms };
}

function PinPicker({ boardId, fn, value, onChange }: { boardId: string; fn: 'output' | 'input' | 'adc' | 'pwm' | 'i2c'; value: number | null; onChange: (v: number | null) => void }) {
  const { data, loading } = useLiveData<any>(boardId ? `/api/boards/${boardId}` : null, [boardId]);
  if (!boardId) return <Notice>Select a controller board first.</Notice>;
  if (loading) return <Skeleton height={120} />;
  const pins = (data?.pins || []).filter((x: any) => x.exposed !== false);
  return <>
    <div className="pin-legend" style={{ marginBottom: 10 }}>
      <span><i className="pin-swatch" style={{ background: 'var(--pin-available)' }} />Available</span>
      <span><i className="pin-swatch" style={{ background: 'var(--pin-assigned)' }} />Assigned</span>
      <span><i className="pin-swatch" style={{ background: 'var(--pin-restricted)' }} />Restricted</span>
      <span><i className="pin-swatch" style={{ background: '#fff', opacity: .5 }} />Incompatible</span>
    </div>
    <div className="pin-rail">{pins.map((pin: any) => {
      const ev = evaluatePin(pin, fn);
      const disabled = ev.state !== 'available';
      return <button type="button" key={pin.gpio} className={`pin ${ev.state}`} disabled={disabled}
        onClick={() => onChange(pin.gpio)} title={ev.reason || ev.warnings.join(' ')}>
        <span className="pin-badge" /><div className="gpio">GPIO {pin.gpio}</div>
        <div className="label">{pin.header_label || pin.side}</div>
        <div className="alloc-note">{pin.state === 'assigned' ? 'Assigned' : ev.state === 'restricted' ? 'Reserved' : ev.state === 'incompatible' ? ev.reason : ev.warnings.length ? 'Warning' : pin.side || ''}</div>
      </button>;
    })}</div>
    {value !== null && <p className="tiny" style={{ marginTop: 10 }}>Selected GPIO {value}. {data?.pins?.find((x: any) => x.gpio === value)?.notes || ''}</p>}
  </>;
}

function CommunicationSummary({ boardId, component }: { boardId: string; component: 'device' | 'sensor' }) {
  const { data } = useLiveData<any>(boardId ? `/api/boards/${boardId}` : null, [boardId]);
  const board = data?.board;
  if (!board) return null;
  const base = `v1/tenants/<tenant>/devices/${board.device_id}`;
  return <div className="notice" style={{ display: 'block', background: 'var(--surface-2)', borderLeftColor: 'var(--border-strong)', color: 'var(--text-2)' }}>
    <strong style={{ color: 'var(--text)' }}>Communication path</strong>
    <div style={{ marginTop: 6 }}>Website → Cloudflare Pages Functions → EMQX → {board.name}</div>
    <div style={{ marginTop: 8 }} className="code">{component === 'device'
      ? `Subscribes: ${base}/command\nPublishes:  ${base}/state`
      : `Publishes:  ${base}/telemetry\nField:      sensors.<component_id>.value`}</div>
    <div className="tiny" style={{ marginTop: 8 }}>The ESP32 keeps an outbound TLS connection. Tenant identity comes from its authenticated MQTT session, never from the JSON payload.</div>
  </div>;
}

function AddDeviceWizard({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { boards, rooms } = useHardware();
  const toast = useToast();
  const { run, busy, error } = useAction();
  const [f, setF] = useState<any>({
    name: '', device_type: 'light', room_id: '', user_board_id: '', output_gpio: null,
    interface: 'gpio', active_low: false, initial_state: 'off', automation_enabled: true,
  });
  const [step, setStep] = useState(0);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const fn = f.interface === 'pwm' ? 'pwm' : 'output';
  const submit = async () => {
    const payload = { ...f, room_id: f.room_id || null };
    const ok = await run(async () => { await api.post('/api/devices', payload); toast('Device created and configuration published'); onDone(); onClose(); });
    if (!ok) toast(error || 'Could not create device', 'error');
  };
  return <Modal title="Add device" onClose={onClose} wide footer={<>
    {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}><Icon.back />Back</button>}
    <button className="btn" onClick={onClose}>Cancel</button>
    {step < 2 ? <button className="btn btn-primary" disabled={step === 0 ? (!f.name || !f.user_board_id) : f.output_gpio === null} onClick={() => setStep(step + 1)}>Next <Icon.next /></button> :
      <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Create device'}</button>}
  </>}>
    <div className="stepper">{[ 'Device', 'GPIO', 'Review' ].map((s, i) => <React.Fragment key={s}><div className={`step ${i === step ? 'on' : i < step ? 'done' : ''}`}><span className="num">{i < step ? '✓' : i + 1}</span><span>{s}</span></div>{i < 2 && <span className="step-line" />}</React.Fragment>)}</div>
    {step === 0 && <>
      <div className="form-row">
        <Field label="Device name"><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Bedroom Light" /></Field>
        <Field label="Device type"><select className="select" value={f.device_type} onChange={(e) => set('device_type', e.target.value)}>{DEVICE_TYPES.map((t) => <option key={t} value={t}>{human(t)}</option>)}</select></Field>
      </div>
      <div className="form-row">
        <Field label="Room"><select className="select" value={f.room_id} onChange={(e) => set('room_id', e.target.value)}><option value="">No room</option>{(rooms.data || []).map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        <Field label="Controller board" hint="Register a controller first if this list is empty"><select className="select" value={f.user_board_id} onChange={(e) => { set('user_board_id', e.target.value); set('output_gpio', null); }}><option value="">Select board</option>{(boards.data || []).map((b: any) => <option key={b.id} value={b.id}>{b.name} · {b.device_id}</option>)}</select></Field>
      </div>
      <div className="form-row">
        <Field label="Hardware interface"><select className="select" value={f.interface} onChange={(e) => set('interface', e.target.value)}>{['gpio', 'pwm', 'i2c_relay'].map((x) => <option key={x} value={x}>{human(x)}</option>)}</select></Field>
        <Field label="Safe power-on state"><select className="select" value={f.initial_state} onChange={(e) => set('initial_state', e.target.value)}><option value="off">Off</option><option value="on">On</option><option value="restore">Restore last</option></select></Field>
      </div>
      <label className="check"><input type="checkbox" checked={f.active_low} onChange={(e) => set('active_low', e.target.checked)} />Active-low relay logic</label>
      <div style={{ height: 10 }} />
      <label className="check"><input type="checkbox" checked={f.automation_enabled} onChange={(e) => set('automation_enabled', e.target.checked)} />Allow automation to control this device</label>
      {!(boards.data || []).length && <div style={{ marginTop: 14 }}><Notice tone="warn">No controller is registered yet. <Link to="/setup" style={{ textDecoration: 'underline' }}>Open the Device Setup Wizard</Link> to pair an ESP32 first.</Notice></div>}
    </>}
    {step === 1 && <><p className="muted" style={{ marginBottom: 12, fontSize: 12.5 }}>Choose one exclusive output GPIO. Assigned, restricted and incompatible pins cannot be selected. Allocation is scoped to this physical board.</p><PinPicker boardId={f.user_board_id} fn={fn} value={f.output_gpio} onChange={(v) => set('output_gpio', v)} /></>}
    {step === 2 && <>
      <div className="kv"><dt>Name</dt><dd>{f.name}</dd><dt>Type</dt><dd>{human(f.device_type)}</dd><dt>Board</dt><dd>{(boards.data || []).find((b: any) => b.id === f.user_board_id)?.name}</dd><dt>Room</dt><dd>{(rooms.data || []).find((r: any) => r.id === f.room_id)?.name || 'No room'}</dd><dt>Output GPIO</dt><dd className="mono">GPIO {f.output_gpio}</dd><dt>Logic</dt><dd>{f.active_low ? 'Active low' : 'Active high'}</dd></div>
      <div className="divider" /><CommunicationSummary boardId={f.user_board_id} component="device" />
    </>}
  </Modal>;
}

function AddSensorWizard({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { boards, rooms } = useHardware();
  const toast = useToast();
  const { run, busy } = useAction();
  const [f, setF] = useState<any>({
    name: '', category: 'temperature', sensor_model: '', room_id: '', user_board_id: '',
    interface: 'adc', gpio: null, bus_id: '', i2c_address: '', unit: 'celsius',
    sampling_interval_s: 60, reporting_interval_s: 60, min_valid: '', max_valid: '', delta_threshold: '0.5',
  });
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const buses = useLiveData<any[]>('/api/buses');
  const boardBuses = (buses.data || []).filter((b: any) => b.user_board_id === f.user_board_id);
  const submit = async () => {
    const payload: any = { ...f, room_id: f.room_id || null, bus_id: f.bus_id || null,
      gpio: f.gpio, min_valid: f.min_valid === '' ? null : Number(f.min_valid),
      max_valid: f.max_valid === '' ? null : Number(f.max_valid), delta_threshold: Number(f.delta_threshold) || 0.5,
      payload_path: `sensors.${(f.name || 'sensor').toLowerCase().replace(/[^a-z0-9]+/g, '_')}.value` };
    const ok = await run(async () => { await api.post('/api/sensors', payload); toast('Sensor created; telemetry mapping published'); onDone(); onClose(); });
    if (!ok) toast('Could not create sensor — check GPIO/bus rules', 'error');
  };
  const units: Record<string, string> = { temperature: 'celsius', humidity: 'percent', motion: 'boolean', water_level: 'percent', rain: 'boolean', light: 'lux', soil_moisture: 'percent', contact: 'boolean', voltage: 'volts', current: 'amperes', power: 'watts', gas: 'ppm', air_quality: 'index', custom: 'custom' };
  return <Modal title="Add sensor" onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !f.name || !f.user_board_id} onClick={submit}>{busy ? 'Creating…' : 'Create sensor'}</button></>}>
    <div className="form-row">
      <Field label="Sensor name"><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Living Room Temperature" /></Field>
      <Field label="Category"><select className="select" value={f.category} onChange={(e) => { set('category', e.target.value); set('unit', units[e.target.value]); }}>{SENSOR_CATEGORIES.map((t) => <option key={t} value={t}>{human(t)}</option>)}</select></Field>
    </div>
    <div className="form-row">
      <Field label="Room"><select className="select" value={f.room_id} onChange={(e) => set('room_id', e.target.value)}><option value="">No room</option>{(rooms.data || []).map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
      <Field label="Controller board"><select className="select" value={f.user_board_id} onChange={(e) => { set('user_board_id', e.target.value); set('gpio', null); }}><option value="">Select board</option>{(boards.data || []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
    </div>
    <div className="form-row">
      <Field label="Interface" hint="I2C/SPI/UART sensors share an explicit bus"><select className="select" value={f.interface} onChange={(e) => set('interface', e.target.value)}>{['adc', 'gpio', 'i2c', 'spi', 'uart', 'onewire', 'virtual'].map((x) => <option key={x} value={x}>{human(x)}</option>)}</select></Field>
      <Field label="Unit"><input className="input" value={f.unit} onChange={(e) => set('unit', e.target.value)} /></Field>
    </div>
    {f.interface === 'i2c' || f.interface === 'spi' || f.interface === 'uart' ? <>
      <Field label="Shared bus" hint="Multiple compatible sensors can share one bus; bus pins belong to the bus, not to individual sensors."><select className="select" value={f.bus_id} onChange={(e) => set('bus_id', e.target.value)}><option value="">Select bus</option>{boardBuses.map((b: any) => <option key={b.id} value={b.id}>{b.label} ({b.kind.toUpperCase()})</option>)}</select></Field>
      {f.interface === 'i2c' && <Field label="I2C address"><input className="input mono" value={f.i2c_address} onChange={(e) => set('i2c_address', e.target.value)} placeholder="0x76" /></Field>}
      {!boardBuses.length && <Notice tone="warn">No shared bus on this board yet. Create one from the Board page before adding a bus sensor.</Notice>}
    </> : f.interface !== 'virtual' && <Field label="GPIO"><PinPicker boardId={f.user_board_id} fn={f.interface === 'adc' ? 'adc' : 'input'} value={f.gpio} onChange={(v) => set('gpio', v)} /></Field>}
    <div className="form-row">
      <Field label="Sampling interval (s)"><input className="input" type="number" value={f.sampling_interval_s} onChange={(e) => set('sampling_interval_s', Number(e.target.value))} /></Field>
      <Field label="Reporting interval (s)"><input className="input" type="number" value={f.reporting_interval_s} onChange={(e) => set('reporting_interval_s', Number(e.target.value))} /></Field>
    </div>
    <div className="form-row">
      <Field label="Minimum valid value"><input className="input" type="number" value={f.min_valid} onChange={(e) => set('min_valid', e.target.value)} placeholder="Optional" /></Field>
      <Field label="Maximum valid value"><input className="input" type="number" value={f.max_valid} onChange={(e) => set('max_valid', e.target.value)} placeholder="Optional" /></Field>
    </div>
    <div className="divider" /><CommunicationSummary boardId={f.user_board_id} component="sensor" />
  </Modal>;
}

// ============================================================================
// Devices / Switches
// ============================================================================
export function DevicesPage() {
  const { data, loading, refresh } = useLiveData<any[]>('/api/devices');
  const rooms = useLiveData<any[]>('/api/rooms');
  const boards = useLiveData<any[]>('/api/boards');
  const { can } = useAuth();
  const toast = useToast();
  const [add, setAdd] = useState(false);
  const [del, setDel] = useState<any>(null);
  const [msg, setMsg] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const rows = (data || []).filter((d: any) => d.name.toLowerCase().includes(filter.toLowerCase()));
  return <>
    <PageHead title="Devices" desc="Every switch is a device record bound to a controller and an exclusive GPIO." actions={<>{can('devices.manage') && <button className="btn btn-primary" onClick={() => setAdd(true)}><Icon.plus />Add device</button>}</>} />
    <Card pad={false}>
      <div className="card-head"><div><h3>Registered devices</h3><div className="sub">{rows.length} records</div></div><div className="search" style={{ width: 220 }}><Icon.search /><input className="input" placeholder="Search devices" value={filter} onChange={(e) => setFilter(e.target.value)} /></div></div>
      {loading ? <div className="card-pad"><Skeleton height={160} /></div> : <DataTable columns={[
        { key: 'name', label: 'Device', render: (d: any) => <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}><div className="icon-box"><Icon.power /></div><div><div style={{ fontWeight: 600 }}>{d.name}</div><div className="tiny mono">{d.slug}</div></div></div> },
        { key: 'type', label: 'Type', render: (d: any) => human(d.device_type) },
        { key: 'room', label: 'Room', render: (d: any) => (rooms.data || []).find((r: any) => r.id === d.room_id)?.name || '—' },
        { key: 'board', label: 'Controller', render: (d: any) => (boards.data || []).find((b: any) => b.id === d.user_board_id)?.name || '—' },
        { key: 'gpio', label: 'GPIO', render: (d: any) => <span className="mono">{d.output_gpio ?? '—'}</span> },
        { key: 'state', label: 'State', render: (d: any) => <StatusBadge status={d.reported_state} /> },
        { key: 'actions', label: '', render: (d: any) => <div className="row-actions">
          <button className="btn btn-ghost btn-icon btn-sm" title="Communication" onClick={async () => setMsg(await api.get(`/api/messages/${d.id}`))}><Icon.link /></button>
          {can('devices.manage') && <button className="btn btn-ghost btn-icon btn-sm" title="Delete" onClick={() => setDel(d)}><Icon.trash /></button>}
        </div> },
      ]} rows={rows} empty={<EmptyState icon="box" title="No devices" text="Add a switch after pairing a controller and creating rooms." action={can('devices.manage') && <button className="btn btn-primary" onClick={() => setAdd(true)}>Add device</button>} />} />}
    </Card>
    {add && <AddDeviceWizard onClose={() => setAdd(false)} onDone={refresh} />}
    {del && <ConfirmModal title={`Delete ${del.name}?`} text="The device is soft-deleted and its exclusive GPIO is released only after the transaction commits. Restoring revalidates pin availability." onClose={() => setDel(null)} onConfirm={async () => {
      try { await api.del(`/api/devices/${del.id}`); toast('Device deleted and GPIO released'); refresh(); } catch (e: any) { toast(e.message, 'error'); }
    }} />}
    {msg && <MessageModal data={msg} onClose={() => setMsg(null)} />}
  </>;
}

function MessageModal({ data, onClose }: { data: any; onClose: () => void }) {
  return <Modal title="Communication configuration" onClose={onClose} wide footer={<button className="btn" onClick={onClose}>Close</button>}>
    <div className="kv"><dt>Controller</dt><dd>{data.controller?.name} <span className="mono tiny">{data.controller?.device_id}</span></dd>
      <dt>Path</dt><dd>{data.path?.join(' → ')}</dd>
      <dt>Interface</dt><dd>{human(data.interface?.type || 'gpio')}{data.interface?.gpio != null ? ` · GPIO ${data.interface.gpio}` : ''}{data.interface?.i2c_address ? ` · ${data.interface.i2c_address}` : ''}</dd>
      <dt>Mapping</dt><dd className="mono">{data.mapping?.telemetry_field}</dd></div>
    <div className="divider" /><h4 style={{ fontSize: 12.5, marginBottom: 8 }}>Publishes</h4>
    {data.publishes?.map((x: any, i: number) => <div key={i}><div className="tiny mono" style={{ marginBottom: 4 }}>{x.topic}</div><div className="code">{JSON.stringify(x.example, null, 2)}</div></div>)}
    <h4 style={{ fontSize: 12.5, margin: '16px 0 8px' }}>Subscribes</h4>
    {!data.subscribes?.length ? <p className="tiny">This component does not subscribe to commands.</p> : data.subscribes.map((x: any, i: number) => <div key={i}><div className="tiny mono" style={{ marginBottom: 4 }}>{x.topic}</div><div className="code">{JSON.stringify(x.example, null, 2)}</div></div>)}
    <div className="divider" /><p className="tiny">Config topic: <span className="mono">{data.config_topic}</span> · Availability: <span className="mono">{data.availability_topic}</span></p>
  </Modal>;
}

export function SwitchesPage() {
  const { data, loading, refresh } = useLiveData<any[]>('/api/devices');
  const boards = useLiveData<any[]>('/api/boards');
  const [pending, setPending] = useState<string | null>(null);
  const [msg, setMsg] = useState<any>(null);
  const { can } = useAuth();
  const toast = useToast();
  const toggle = async (d: any) => {
    setPending(d.id);
    try {
      await api.post(`/api/devices/${d.id}/command`, { action: 'set_state', value: d.reported_state !== 'on' });
      toast('Command published — waiting for ESP32 acknowledgement');
      setTimeout(refresh, 500);
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setPending(null); }
  };
  const withBoard = (data || []).map((d: any) => ({ ...d,
    board_status: (boards.data || []).find((b: any) => b.id === d.user_board_id)?.status || 'offline' }));
  return <>
    <PageHead title="Switches" desc="ON/OFF reflects the ESP32-reported state. Requests are shown separately until acknowledged." actions={<Link className="btn" to="/devices">All devices <Icon.next /></Link>} />
    {loading ? <Loading rows={3} /> : !withBoard.length ? <Card><EmptyState icon="power" title="No switches" text="Add a device to control a relay, light, fan or pump." action={<Link className="btn btn-primary" to="/devices">Add device</Link>} /></Card> :
      <div className="grid grid-3">{withBoard.map((d: any) => <div key={d.id}>
        <DeviceCard d={d} onToggle={() => toggle(d)} pending={pending === d.id} readOnly={!can('devices.control')} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <button className="btn btn-ghost btn-sm" onClick={async () => setMsg(await api.get(`/api/messages/${d.id}`))}><Icon.link />Communication</button>
        </div>
      </div>)}</div>}
    {msg && <MessageModal data={msg} onClose={() => setMsg(null)} />}
  </>;
}

// ============================================================================
// Sensors
// ============================================================================
export function SensorsPage() {
  const { data, loading, refresh } = useLiveData<any[]>('/api/sensors');
  const rooms = useLiveData<any[]>('/api/rooms');
  const { can } = useAuth();
  const toast = useToast();
  const [add, setAdd] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [readings, setReadings] = useState<any[]>([]);
  const [del, setDel] = useState<any>(null);
  const open = async (s: any) => { setDetail(s); setReadings(await api.get(`/api/sensors/${s.id}/readings?limit=60`)); };
  return <>
    <PageHead title="Sensors" desc="Sensor definitions are separate from readings; telemetry is validated and stored in the database." actions={can('devices.manage') && <button className="btn btn-primary" onClick={() => setAdd(true)}><Icon.plus />Add sensor</button>} />
    {loading ? <Loading rows={3} /> : !data?.length ? <Card><EmptyState icon="gauge" title="No sensors" text="Add a temperature, humidity, motion, water level or custom sensor." action={<button className="btn btn-primary" onClick={() => setAdd(true)}>Add sensor</button>} /></Card> :
      <div className="grid grid-3">{data.map((s: any) => {
        const I = Icon[SENSOR_ICONS[s.category] || 'gauge'];
        return <div className="card card-pad" key={s.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div className="icon-box"><I /></div><StatusBadge status={s.last_status} />
          </div>
          <h3 style={{ fontSize: 14, fontWeight: 650, marginTop: 12 }}>{s.name}</h3>
          <div className="tiny">{human(s.category)} · {(rooms.data || []).find((r: any) => r.id === s.room_id)?.name || 'No room'}</div>
          <div style={{ fontSize: 25, fontWeight: 650, letterSpacing: '-.04em', margin: '10px 0 2px' }}>{fmt(s.last_value)} <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-3)' }}>{s.unit}</span></div>
          <div className="tiny">Last reading {timeAgo(s.last_value_at)} · every {s.reporting_interval_s}s</div>
          <div className="divider" />
          <div className="kv" style={{ gridTemplateColumns: '80px 1fr' }}><dt>Interface</dt><dd>{human(s.interface)}{s.gpio != null ? ` · GPIO ${s.gpio}` : ''}{s.i2c_address ? ` · ${s.i2c_address}` : ''}</dd></div>
          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            <button className="btn btn-sm" onClick={() => open(s)}><Icon.chart />History</button>
            <button className="btn btn-sm" onClick={async () => setDetail(await api.get(`/api/messages/${s.id}`))}><Icon.link />Messages</button>
            {can('devices.manage') && <button className="btn btn-ghost btn-icon btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setDel(s)}><Icon.trash /></button>}
          </div>
        </div>;
      })}</div>}
    {add && <AddSensorWizard onClose={() => setAdd(false)} onDone={refresh} />}
    {detail && <Modal title={detail.name || 'Communication configuration'} onClose={() => setDetail(null)} wide footer={<button className="btn" onClick={() => setDetail(null)}>Close</button>}>
      {detail.publishes ? <>
        <div className="kv"><dt>Controller</dt><dd>{detail.controller?.name}</dd><dt>Path</dt><dd>{detail.path?.join(' → ')}</dd><dt>Interface</dt><dd>{human(detail.interface?.type || '')}{detail.interface?.gpio != null ? ` · GPIO ${detail.interface.gpio}` : ''}</dd><dt>Field mapping</dt><dd className="mono">{detail.mapping?.telemetry_field}</dd></div>
        <div className="divider" /><div className="tiny mono">{detail.publishes?.[0]?.topic}</div><div className="code">{JSON.stringify(detail.publishes?.[0]?.example, null, 2)}</div>
        <p className="tiny" style={{ marginTop: 10 }}>Values outside the configured min/max or with a mismatched unit are rejected at the API boundary and never stored.</p>
      </> : <>
        {readings.length ? <><MiniChart points={readings.slice().reverse().map((r: any) => Number(r.value))} labels={readings.slice().reverse().filter((_: any, i: number) => i % 12 === 0).map((r: any) => new Date(r.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))} />
          <DataTable columns={[
            { key: 'recorded_at', label: 'Time', render: (r: any) => timeFull(r.recorded_at) },
            { key: 'value', label: 'Value', render: (r: any) => <span className="mono">{fmt(r.value, 2)} {r.unit}</span> },
            { key: 'status', label: 'Status', render: (r: any) => <StatusBadge status={r.status === 'valid' ? 'confirmed' : 'failed'} /> },
          ]} rows={readings.slice(0, 20)} /></> : <EmptyState icon="chart" title="No readings yet" text="Telemetry from the ESP32 will appear here once the sensor reports." />}
      </>}
    </Modal>}
    {del && <ConfirmModal title={`Delete ${del.name}?`} text="The sensor definition is removed from the device configuration and its exclusive GPIO (if any) is released. Shared bus pins remain with the bus." onClose={() => setDel(null)} onConfirm={async () => {
      try { await api.del(`/api/sensors/${del.id}`); toast('Sensor deleted'); refresh(); } catch (e: any) { toast(e.message, 'error'); }
    }} />}
  </>;
}

// ============================================================================
// Controllers
// ============================================================================
export function ControllersPage() {
  const { data, loading, refresh } = useLiveData<any[]>('/api/boards');
  const toast = useToast();
  const [unclaim, setUnclaim] = useState<any>(null);
  const [confirmText, setConfirmText] = useState('');
  const [rotated, setRotated] = useState<any>(null);
  const { can } = useAuth();
  return <>
    <PageHead title="Controllers" desc="Registered ESP32 boards, their per-device MQTT identity and configuration sync status." actions={<Link className="btn btn-primary" to="/setup"><Icon.plus />Add Controller</Link>} />
    <Card pad={false}>
      {loading ? <div className="card-pad"><Skeleton height={180} /></div> : <DataTable columns={[
        { key: 'name', label: 'Controller', render: (b: any) => <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><div className="icon-box"><Icon.cpu /></div><div><div style={{ fontWeight: 600 }}>{b.name}</div><div className="tiny mono">{b.device_id}</div></div></div> },
        { key: 'model', label: 'Board', render: (b: any) => b.catalog?.model || 'Custom board' },
        { key: 'status', label: 'Connection', render: (b: any) => <StatusBadge status={b.status} /> },
        { key: 'pins', label: 'GPIO', render: (b: any) => <span className="mono">{b.pins_used} used / {b.pins_available} free / {b.pins_reserved} reserved</span> },
        { key: 'config', label: 'Config', render: (b: any) => <span>v{b.config_version} · <StatusBadge status={b.config_sync_status} /></span> },
        { key: 'fw', label: 'Firmware', render: (b: any) => b.firmware_version || '—' },
        { key: 'last', label: 'Last seen', render: (b: any) => timeAgo(b.last_seen_at) },
        { key: 'actions', label: '', render: (b: any) => <div className="row-actions">
          <Link className="btn btn-ghost btn-icon btn-sm" title="Pin manager" to={`/boards/${b.id}`}><Icon.sliders /></Link>
          {can('devices.configure') && <button className="btn btn-ghost btn-icon btn-sm" title="Rotate credentials" onClick={async () => { try { setRotated(await api.post(`/api/boards/${b.id}/rotate-credentials`)); toast('Credentials rotated'); } catch (e: any) { toast(e.message, 'error'); } }}><Icon.refresh /></button>}
          {can('devices.manage') && <button className="btn btn-ghost btn-icon btn-sm" title="Unclaim" onClick={() => { setUnclaim(b); setConfirmText(''); }}><Icon.trash /></button>}
        </div> },
      ]} rows={data || []} empty={<EmptyState icon="cpu" title="No controllers registered" text="Pair an ESP32 with a one-time token to create your first controller." action={<Link className="btn btn-primary" to="/setup">Start setup wizard</Link>} />} />}
    </Card>
    {unclaim && <Modal title="Unclaim controller" onClose={() => setUnclaim(null)} footer={<><button className="btn" onClick={() => setUnclaim(null)}>Cancel</button><button className="btn btn-danger" disabled={confirmText !== unclaim.device_id} onClick={async () => {
      try { await api.del(`/api/boards/${unclaim.id}`, { confirm: confirmText }); toast('Controller unclaimed and credentials revoked'); refresh(); setUnclaim(null); } catch (e: any) { toast(e.message, 'error'); }
    }}>Unclaim & revoke</button></>}>
      <Notice tone="danger">This revokes the device's MQTT identity and releases all its GPIO assignments. Ownership transfer requires this explicit unclaim followed by a reset.</Notice>
      <Field label={`Type ${unclaim.device_id} to confirm`}><input className="input mono" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} /></Field>
    </Modal>}
    {rotated && <Modal title="New device credentials" onClose={() => setRotated(null)} footer={<button className="btn" onClick={() => setRotated(null)}>Done</button>}>
      <Notice tone="warn">Shown once. Update the firmware/NVS on the physical board; the old password is no longer valid.</Notice>
      <div className="kv" style={{ marginTop: 14 }}><dt>Username</dt><dd className="mono">{rotated.username}</dd><dt>Password</dt><dd className="mono" style={{ wordBreak: 'break-all' }}>{rotated.password}</dd></div>
      <div style={{ marginTop: 12 }}><CopyButton value={`${rotated.username}:${rotated.password}`} label="Copy credentials" /></div>
    </Modal>}
  </>;
}

// ============================================================================
// Board library
// ============================================================================
export function BoardLibraryPage() {
  const catalog = useLiveData<any[]>('/api/board-catalog');
  const mine = useLiveData<any[]>('/api/boards');
  const navigate = useNavigate();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [family, setFamily] = useState('all');
  const [category, setCategory] = useState('all');
  const [view, setView] = useState<any>(null);
  const [custom, setCustom] = useState(false);
  const [tab, setTab] = useState('catalog');
  const filtered = (catalog.data || []).filter((b: any) =>
    (family === 'all' || b.chip_family === family) &&
    (category === 'all' || b.category === category) &&
    (b.model + b.manufacturer + b.chip_variant).toLowerCase().includes(search.toLowerCase()));
  return <>
    <PageHead title="Board Library" desc="Verified Espressif header pin maps, separate from your registered physical boards." actions={<Link className="btn btn-primary" to="/setup"><Icon.plus />Add Board</Link>} />
    <Tabs value={tab} onChange={setTab} items={[{ id: 'catalog', label: 'Board catalog' }, { id: 'mine', label: `My Boards (${(mine.data || []).length})` }, { id: 'custom', label: 'Custom board' }]} />
    {tab === 'catalog' && <>
      <div className="pin-toolbar">
        <div className="search" style={{ width: 260 }}><Icon.search /><input className="input" placeholder="Search by board model" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <select className="select" style={{ width: 160 }} value={family} onChange={(e) => setFamily(e.target.value)}><option value="all">All chip families</option>{CHIP_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}</select>
        <select className="select" style={{ width: 150 }} value={category} onChange={(e) => setCategory(e.target.value)}><option value="all">All categories</option><option value="devkit">Dev kits</option><option value="chip_family">Chip families</option><option value="custom">Custom</option></select>
        <span className="tiny">{filtered.length} definitions</span>
      </div>
      {catalog.loading ? <Loading rows={3} /> : <div className="grid grid-3">{filtered.map((b: any) => {
        const status = b.attributes?.pin_status;
        return <div className="board-tile" key={b.id}>
          <div className="art"><BoardArt /></div>
          <div className="body">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><h4>{b.model}</h4>{status === 'verified' ? <Badge tone="on">Verified</Badge> : <Badge tone="warn">Pin map pending</Badge>}</div>
            <div className="model">{b.manufacturer} · {b.chip_family} · {b.chip_variant}</div>
            <p className="tiny" style={{ margin: '10px 0', minHeight: 32 }}>{b.summary}</p>
            <div className="divider" style={{ margin: '10px 0' }} />
            <div className="tiny">GPIO available: <strong>{b.pins.filter((p: any) => !p.restricted).length}</strong> · Reserved: <strong>{b.pins.filter((p: any) => p.restricted).length}</strong> · ADC: <strong>{b.pins.filter((p: any) => p.adc_channels?.length).length}</strong></div>
            <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
              <button className="btn btn-sm" disabled={!b.pins.length} onClick={() => setView(b)}><Icon.eye />View Pinout</button>
              <button className="btn btn-primary btn-sm" disabled={status !== 'verified'} onClick={() => navigate(`/setup?board=${encodeURIComponent(b.id)}`)}><Icon.plus />Add Board</button>
            </div>
            <a className="tiny" href={b.doc_source_url} target="_blank" rel="noreferrer" style={{ display: 'block', marginTop: 10, textDecoration: 'underline' }}>Official documentation ↗</a>
          </div>
        </div>;
      })}</div>}
    </>}
    {tab === 'mine' && <Card pad={false}>{mine.loading ? <div className="card-pad"><Skeleton height={140} /></div> : <DataTable columns={[
      { key: 'name', label: 'Board name', render: (b: any) => <div><div style={{ fontWeight: 600 }}>{b.name}</div><div className="tiny">{b.catalog?.model || 'Custom'}</div></div> },
      { key: 'device_id', label: 'Device ID', render: (b: any) => <span className="mono">{b.device_id}</span> },
      { key: 'status', label: 'Connection', render: (b: any) => <StatusBadge status={b.status} /> },
      { key: 'used', label: 'Used pins', render: (b: any) => b.pins_used },
      { key: 'available', label: 'Available', render: (b: any) => b.pins_available },
      { key: 'reserved', label: 'Reserved', render: (b: any) => b.pins_reserved },
      { key: 'fw', label: 'Firmware', render: (b: any) => b.firmware_version || '—' },
      { key: 'last', label: 'Last communication', render: (b: any) => timeAgo(b.last_seen_at) },
      { key: 'actions', label: '', render: (b: any) => <Link className="btn btn-sm" to={`/boards/${b.id}`}>Open <Icon.next /></Link> },
    ]} rows={mine.data || []} empty={<EmptyState icon="cpu" title="No boards registered" text="Pair a controller to see it here." />} />}</Card>}
    {tab === 'custom' && <CustomBoardForm />}
    {view && <PinoutModal board={view} onClose={() => setView(null)} />}
  </>;
}

function BoardArt() {
  return <svg viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="24" y="12" width="52" height="76" rx="5" fill="#FFFFFF" stroke="#C9CBD6" />
    <rect x="34" y="32" width="32" height="34" rx="3" fill="#E9EBF2" stroke="#C9CBD6" />
    <rect x="40" y="4" width="20" height="10" rx="2" fill="#D8DAE4" stroke="#C9CBD6" />
    {Array.from({ length: 12 }).map((_, i) => <React.Fragment key={i}><line x1="24" y1={17 + i * 6} x2="17" y2={17 + i * 6} /><line x1="76" y1={17 + i * 6} x2="83" y2={17 + i * 6} /></React.Fragment>)}
  </svg>;
}

function PinoutModal({ board, onClose }: { board: any; onClose: () => void }) {
  const [fn, setFn] = useState<'output' | 'input' | 'adc' | 'pwm'>('output');
  const [pin, setPin] = useState<any>(null);
  return <Modal title={`${board.model} · pinout`} onClose={onClose} wide footer={<button className="btn" onClick={onClose}>Close</button>}>
    <Notice>Transcribed from <a href={board.doc_source_url} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>the official Espressif user guide</a>. Chip capabilities are not assumed — only physically exposed header pins are listed.</Notice>
    <div className="pin-toolbar" style={{ marginTop: 14 }}>
      <span className="tiny">Check compatibility for</span>
      <select className="select" style={{ width: 160 }} value={fn} onChange={(e) => setFn(e.target.value as any)}><option value="output">Digital output</option><option value="input">Digital input</option><option value="adc">ADC input</option><option value="pwm">PWM output</option></select>
    </div>
    <div className="pin-rail">{board.pins.map((p: any) => {
      const ev = evaluatePin({ ...p, state: 'available' }, fn);
      return <button key={p.gpio} className={`pin ${ev.state}`} onClick={() => setPin(p)}><span className="pin-badge" /><div className="gpio">GPIO {p.gpio}</div><div className="label">{p.header_label || p.side}</div><div className="alloc-note">{p.restricted ? 'Restricted' : p.input_only ? 'Input only' : p.adc_channels?.length ? p.adc_channels[0] : p.side}</div></button>;
    })}</div>
    {pin && <div className="card card-pad" style={{ marginTop: 16 }}>
      <h4 style={{ fontSize: 13.5, fontWeight: 650 }}>GPIO {pin.gpio} · {pin.header_label}</h4>
      <div className="kv" style={{ marginTop: 12 }}>
        <dt>Header</dt><dd>{pin.side} pin {pin.header_pin}</dd>
        <dt>Functions</dt><dd>{pin.functions?.join(', ')}</dd>
        <dt>ADC</dt><dd>{pin.adc_channels?.join(', ') || 'None'}</dd>
        <dt>Direction</dt><dd>{pin.input_only ? 'Input only' : 'Input / output'}</dd>
        <dt>Boot strapping</dt><dd>{pin.boot_strapping ? 'Yes — verify level at reset' : 'No'}</dd>
        <dt>USB / JTAG</dt><dd>{pin.usb_jtag ? 'Yes — unavailable while USB active' : 'No'}</dd>
        <dt>Flash / PSRAM</dt><dd>{pin.flash_connected ? 'Flash' : pin.psram_connected ? 'Module-variant PSRAM' : 'No'}</dd>
        <dt>Restricted</dt><dd>{pin.restricted ? pin.restriction_note : 'No'}</dd>
      </div>
      {pin.notes && <p className="tiny" style={{ marginTop: 10 }}>{pin.notes}</p>}
    </div>}
  </Modal>;
}

function CustomBoardForm() {
  const toast = useToast();
  const [rows, setRows] = useState([{ gpio: '4', header_label: 'IO4', functions: 'gpio,pwm', adc_channels: '', input_only: false, restricted: false, boot_strapping: false }]);
  const [meta, setMeta] = useState({ model: '', manufacturer: '', chip_family: 'ESP32', chip_variant: '', doc_source_url: '' });
  const submit = async () => {
    try {
      await api.post('/api/boards/custom', { ...meta, pins: rows.map((r) => ({ ...r, gpio: Number(r.gpio),
        functions: r.functions.split(',').map((x) => x.trim()).filter(Boolean),
        adc_channels: r.adc_channels.split(',').map((x) => x.trim()).filter(Boolean) })) });
      toast('Custom board definition added');
    } catch (e: any) { toast(e.message, 'error'); }
  };
  return <Card title="Add a custom board" sub="Only enter pins you verified against the manufacturer's documentation.">
    <Notice tone="warn">We never invent a pin map. If you are unsure of a header position, add a chip-family entry with no pins and use the manufacturer's pinout to fill this form.</Notice>
    <div className="form-row" style={{ marginTop: 16 }}>
      <Field label="Board model"><input className="input" value={meta.model} onChange={(e) => setMeta({ ...meta, model: e.target.value })} placeholder="My ESP32 Relay Board v2" /></Field>
      <Field label="Manufacturer"><input className="input" value={meta.manufacturer} onChange={(e) => setMeta({ ...meta, manufacturer: e.target.value })} /></Field>
    </div>
    <div className="form-row">
      <Field label="Chip family"><select className="select" value={meta.chip_family} onChange={(e) => setMeta({ ...meta, chip_family: e.target.value })}>{CHIP_FAMILIES.map((f) => <option key={f}>{f}</option>)}</select></Field>
      <Field label="Chip / module variant"><input className="input" value={meta.chip_variant} onChange={(e) => setMeta({ ...meta, chip_variant: e.target.value })} placeholder="ESP32-WROOM-32E" /></Field>
    </div>
    <Field label="Pin documentation URL"><input className="input" value={meta.doc_source_url} onChange={(e) => setMeta({ ...meta, doc_source_url: e.target.value })} placeholder="https://…" /></Field>
    <div className="divider" /><h4 style={{ fontSize: 13, marginBottom: 10 }}>Exposed GPIO rows</h4>
    {rows.map((r, i) => <div key={i} className="form-row" style={{ gridTemplateColumns: '70px 1fr 1fr 1fr auto', alignItems: 'end' }}>
      <Field label="GPIO"><input className="input" value={r.gpio} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, gpio: e.target.value } : x))} /></Field>
      <Field label="Header label"><input className="input" value={r.header_label} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, header_label: e.target.value } : x))} /></Field>
      <Field label="Functions"><input className="input" value={r.functions} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, functions: e.target.value } : x))} /></Field>
      <Field label="ADC channels"><input className="input" value={r.adc_channels} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, adc_channels: e.target.value } : x))} /></Field>
      <button className="btn btn-ghost btn-icon" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Icon.trash /></button>
    </div>)}
    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
      <button className="btn btn-sm" onClick={() => setRows([...rows, { gpio: '', header_label: '', functions: 'gpio,pwm', adc_channels: '', input_only: false, restricted: false, boot_strapping: false }])}><Icon.plus />Add pin row</button>
      <button className="btn btn-primary btn-sm" disabled={!meta.model || rows.some((r) => !r.gpio)} onClick={submit}>Save board definition</button>
    </div>
  </Card>;
}

// ============================================================================
// GPIO Pin Manager
// ============================================================================
export function BoardDetailPage() {
  const { id } = useParams();
  const { data, loading, refresh } = useLiveData<any>(id ? `/api/boards/${id}` : null, [id]);
  const toast = useToast();
  const [fn, setFn] = useState<'output' | 'input' | 'adc' | 'pwm'>('output');
  const [pin, setPin] = useState<any>(null);
  const [bus, setBus] = useState<any>(null);
  const [tab, setTab] = useState('pins');
  const [config, setConfig] = useState<any>(null);
  const { can } = useAuth();
  const board = data?.board;
  const pins = data?.pins || [];
  const createBus = async () => {
    try {
      await api.post('/api/buses', { ...bus, user_board_id: id });
      toast('Shared bus created'); setBus(null); refresh();
    } catch (e: any) { toast(e.message, 'error'); }
  };
  return <>
    <PageHead title={board?.name || 'Board'} desc={board ? `${board.catalog_board_id || 'Custom board'} · ${board.device_id}` : undefined} actions={<><Link className="btn" to="/boards"><Icon.back />Library</Link><button className="btn" onClick={async () => setConfig(await api.get(`/api/boards/${id}/config`))}><Icon.file />View config</button></>} />
    {loading ? <Loading rows={2} /> : !board ? <EmptyState title="Board not found" text="It may have been unclaimed." /> : <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Connection" value={<StatusBadge status={board.status} />} foot={timeAgo(board.last_seen_at)} icon="wifi" />
        <Stat label="Used GPIO" value={pins.filter((p: any) => p.state === 'assigned').length} icon="sliders" />
        <Stat label="Available GPIO" value={pins.filter((p: any) => p.state === 'available').length} icon="check" />
        <Stat label="Config" value={`v${board.config_version}`} foot={`Applied v${board.applied_config_version}`} icon="file" />
      </div>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'pins', label: 'GPIO Pin Manager' }, { id: 'buses', label: `Shared buses (${(data?.buses || []).length})` }, { id: 'components', label: 'Components' }]} />
      {tab === 'pins' && <Card title="Physical pin map" sub="Pin ownership is scoped to THIS board instance" actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="tiny">Validate against</span>
          <select className="select" style={{ width: 150 }} value={fn} onChange={(e) => setFn(e.target.value as any)}><option value="output">Digital output</option><option value="input">Digital input</option><option value="adc">ADC input</option><option value="pwm">PWM output</option></select></div>}>
        <div className="pin-legend" style={{ marginBottom: 14 }}>
          <span><i className="pin-swatch" style={{ background: 'var(--pin-available)' }} />Available</span>
          <span><i className="pin-swatch" style={{ background: 'var(--pin-assigned)' }} />Assigned</span>
          <span><i className="pin-swatch" style={{ background: 'var(--pin-system)' }} />System reserved</span>
          <span><i className="pin-swatch" style={{ background: 'var(--pin-restricted)' }} />Restricted</span>
          <span><i className="pin-swatch" style={{ background: '#fff', opacity: .5 }} />Incompatible</span>
        </div>
        <div className="board-visual">
          <div><div className="tiny" style={{ marginBottom: 8 }}>Left header</div><div className="pin-rail" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(76px,1fr))' }}>
            {pins.filter((p: any) => p.side === 'J1' || p.side === 'J2').map((p: any) => <PinCell key={p.gpio} pin={p} fn={fn} onClick={() => setPin(p)} />)}</div></div>
          <div className="board-chip">{board.catalog_board_id ? board.catalog_board_id.split('.')[1] : 'CUSTOM'}<br />ESP32<br />—<br />{board.device_id.slice(-6)}</div>
          <div><div className="tiny" style={{ marginBottom: 8 }}>Right header</div><div className="pin-rail" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(76px,1fr))' }}>
            {pins.filter((p: any) => p.side !== 'J1' && p.side !== 'J2').map((p: any) => <PinCell key={p.gpio} pin={p} fn={fn} onClick={() => setPin(p)} />)}</div></div>
        </div>
      </Card>}
      {tab === 'buses' && <Card title="Shared buses" sub="I2C/SPI/UART bus pins are owned by the bus; compatible sensors share it" actions={can('devices.manage') && <button className="btn btn-primary btn-sm" onClick={() => setBus({ kind: 'i2c', label: 'i2c-0', sda_gpio: '', scl_gpio: '', frequency_hz: 100000 })}><Icon.plus />New bus</button>}>
        {!data?.buses?.length ? <EmptyState icon="layers" title="No shared buses" text="Create an I2C or SPI bus to attach multiple compatible sensors without duplicate GPIO ownership." /> :
          data.buses.map((b: any) => <div className="list-item" key={b.id}><div className="icon-box"><Icon.layers /></div>
            <div className="grow"><div className="title">{b.label}</div><div className="meta mono">{b.kind.toUpperCase()} · SDA {b.sda_gpio ?? '—'} · SCL {b.scl_gpio ?? '—'} · MOSI {b.mosi_gpio ?? '—'}</div></div>
            <span className="tiny">{(data.sensors || []).filter((s: any) => s.bus_id === b.id).length} sensors</span>
            {can('devices.manage') && <button className="btn btn-ghost btn-icon btn-sm" onClick={async () => { try { await api.del(`/api/buses/${b.id}`); toast('Bus deleted'); refresh(); } catch (e: any) { toast(e.message, 'error'); } }}><Icon.trash /></button>}
          </div>)}
      </Card>}
      {tab === 'components' && <div className="grid grid-2">
        <Card title="Devices on this board"><DataTable columns={[
          { key: 'name', label: 'Device' }, { key: 'output_gpio', label: 'GPIO' }, { key: 'reported_state', label: 'State', render: (d: any) => <StatusBadge status={d.reported_state} /> },
        ]} rows={data?.devices || []} empty={<EmptyState icon="power" title="No devices" text="Add a device using this controller." />} /></Card>
        <Card title="Sensors on this board"><DataTable columns={[
          { key: 'name', label: 'Sensor' }, { key: 'interface', label: 'Interface' }, { key: 'gpio', label: 'GPIO / bus' },
        ]} rows={data?.sensors || []} empty={<EmptyState icon="gauge" title="No sensors" text="Add a sensor using this controller." />} /></Card>
      </div>}
      {pin && <PinDetailModal pin={pin} onClose={() => setPin(null)} />}
      {bus && <Modal title="Create shared bus" onClose={() => setBus(null)} footer={<><button className="btn" onClick={() => setBus(null)}>Cancel</button><button className="btn btn-primary" onClick={createBus}>Create bus</button></>}>
        <div className="form-row">
          <Field label="Bus kind"><select className="select" value={bus.kind} onChange={(e) => setBus({ ...bus, kind: e.target.value })}>{['i2c', 'spi', 'uart', 'onewire'].map((x) => <option key={x} value={x}>{x.toUpperCase()}</option>)}</select></Field>
          <Field label="Label"><input className="input" value={bus.label} onChange={(e) => setBus({ ...bus, label: e.target.value })} /></Field>
        </div>
        {bus.kind === 'i2c' && <div className="form-row"><Field label="SDA GPIO"><input className="input" type="number" value={bus.sda_gpio} onChange={(e) => setBus({ ...bus, sda_gpio: e.target.value === '' ? '' : Number(e.target.value) })} /></Field><Field label="SCL GPIO"><input className="input" type="number" value={bus.scl_gpio} onChange={(e) => setBus({ ...bus, scl_gpio: e.target.value === '' ? '' : Number(e.target.value) })} /></Field></div>}
        {bus.kind === 'spi' && <div className="form-row"><Field label="MOSI"><input className="input" type="number" value={bus.mosi_gpio || ''} onChange={(e) => setBus({ ...bus, mosi_gpio: Number(e.target.value) })} /></Field><Field label="MISO"><input className="input" type="number" value={bus.miso_gpio || ''} onChange={(e) => setBus({ ...bus, miso_gpio: Number(e.target.value) })} /></Field><Field label="SCK"><input className="input" type="number" value={bus.sck_gpio || ''} onChange={(e) => setBus({ ...bus, sck_gpio: Number(e.target.value) })} /></Field></div>}
        {bus.kind === 'uart' && <div className="form-row"><Field label="TX"><input className="input" type="number" value={bus.tx_gpio || ''} onChange={(e) => setBus({ ...bus, tx_gpio: Number(e.target.value) })} /></Field><Field label="RX"><input className="input" type="number" value={bus.rx_gpio || ''} onChange={(e) => setBus({ ...bus, rx_gpio: Number(e.target.value) })} /></Field></div>}
        <Notice>Bus controller pins are allocated exclusively to the bus in one transaction. Sensors on the bus do not claim those GPIOs again.</Notice>
      </Modal>}
      {config && <Modal title={`Device configuration v${config.version}`} onClose={() => setConfig(null)} wide footer={<button className="btn" onClick={() => setConfig(null)}>Close</button>}>
        <div className="kv"><dt>Version</dt><dd>{config.version}</dd><dt>Checksum</dt><dd className="mono">{config.checksum}</dd><dt>Generated</dt><dd>{timeFull(config.created_at)}</dd></div>
        <div className="code" style={{ marginTop: 14, maxHeight: 380, overflow: 'auto' }}>{JSON.stringify(config.config, null, 2)}</div>
      </Modal>}
    </>}
  </>;
}

function PinCell({ pin, fn, onClick }: { pin: any; fn: any; onClick: () => void }) {
  const ev = evaluatePin(pin, fn);
  return <button className={`pin ${ev.state}`} onClick={onClick} title={ev.reason || ev.warnings.join(' ')}>
    <span className="pin-badge" /><div className="gpio">{pin.gpio}</div><div className="label">{pin.header_label || pin.side || ''}</div>
    <div className="alloc-note">{pin.allocation ? `${pin.allocation.owner_type} · ${pin.allocation.function_kind}` : ev.state === 'restricted' ? 'Reserved' : ev.state === 'incompatible' ? ev.reason?.slice(0, 26) : ev.warnings.length ? 'Warning' : pin.side || ''}</div>
  </button>;
}

function PinDetailModal({ pin, onClose }: { pin: any; onClose: () => void }) {
  const ev = evaluatePin(pin, 'output');
  return <Modal title={`GPIO ${pin.gpio} · ${pin.header_label || pin.side || ''}`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
    <div style={{ marginBottom: 14 }}>{pin.state === 'assigned' ? <Badge tone="on">Assigned</Badge> : pin.restricted ? <Badge tone="danger">Restricted</Badge> : <Badge tone="info">Available</Badge>}
      {pin.boot_strapping && <> <Badge tone="warn">Boot strapping</Badge></>}{pin.usb_jtag && <> <Badge tone="warn">USB/JTAG</Badge></>}</div>
    <div className="kv">
      <dt>Header</dt><dd>{pin.side || '—'} · position {pin.header_pin || '—'}</dd>
      <dt>State</dt><dd>{pin.state}</dd>
      <dt>Functions</dt><dd>{pin.functions?.join(', ') || '—'}</dd>
      <dt>ADC channels</dt><dd>{pin.adc_channels?.join(', ') || 'None'}</dd>
      <dt>Direction</dt><dd>{pin.input_only ? 'Input only' : 'Input / output'}</dd>
      <dt>Boot strapping</dt><dd>{pin.boot_strapping ? 'Yes' : 'No'}</dd>
      <dt>Flash</dt><dd>{pin.flash_connected ? 'Connected to internal flash' : 'No'}</dd>
      <dt>PSRAM</dt><dd>{pin.psram_connected ? 'Module-variant dependent' : 'No'}</dd>
      <dt>Allocation</dt><dd>{pin.allocation ? `${pin.allocation.owner_type} · ${pin.allocation.function_kind}` : 'None'}</dd>
    </div>
    {(pin.notes || pin.restriction_note) && <Notice tone={pin.restricted ? 'danger' : 'warn'}>{pin.restriction_note || pin.notes}</Notice>}
    {ev.warnings.length > 0 && <div style={{ marginTop: 12 }}><h4 style={{ fontSize: 12.5, marginBottom: 6 }}>Limitations</h4>{ev.warnings.map((w, i) => <p className="tiny" key={i} style={{ marginBottom: 4 }}>• {w}</p>)}</div>}
  </Modal>;
}

// ============================================================================
// Device Setup Wizard
// ============================================================================
export function SetupWizardPage() {
  const catalog = useLiveData<any[]>('/api/board-catalog');
  const boards = useLiveData<any[]>('/api/boards');
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [boardId, setBoardId] = useState(new URLSearchParams(window.location.search).get('board') || '');
  const [name, setName] = useState('');
  const [method, setMethod] = useState('mqtt_tls');
  const [issued, setIssued] = useState<any>(null);
  const [status, setStatus] = useState<'idle' | 'waiting' | 'paired'>('idle');
  const { can } = useAuth();
  const selected = (catalog.data || []).find((b: any) => b.id === boardId);
  const generate = async () => {
    try {
      const r = await api.post('/api/pairing-tokens', { catalog_board_id: boardId || null, board_name: name || selected?.model || 'ESP32 Controller' });
      setIssued(r); setStatus('waiting'); setStep(3);
    } catch (e: any) { toast(e.message, 'error'); }
  };
  // Poll board list until the newly paired controller appears.
  React.useEffect(() => {
    if (status !== 'waiting') return;
    const before = new Set((boards.data || []).map((b: any) => b.id));
    const timer = setInterval(async () => {
      try {
        const list: any[] = await api.get('/api/boards');
        const fresh = list.find((b) => !before.has(b.id));
        if (fresh) { setStatus('paired'); setStep(4); boards.refresh(); clearInterval(timer); }
      } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(timer);
  }, [status]);
  return <>
    <PageHead title="Device Setup Wizard" desc="Pair an ESP32 through a single-use token. Cloud control stays outbound — no router port forwarding." actions={<Link className="btn" to="/controllers">Controllers <Icon.next /></Link>} />
    <div className="stepper">{['Board', 'Method', 'Token', 'Provision', 'Status'].map((s, i) => <React.Fragment key={s}><div className={`step ${i === step ? 'on' : i < step ? 'done' : ''}`}><span className="num">{i < step ? '✓' : i + 1}</span><span>{s}</span></div>{i < 4 && <span className="step-line" />}</React.Fragment>)}</div>
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <Card title={step === 0 ? 'Select your controller board' : step === 1 ? 'Connection method' : step === 2 ? 'Generate pairing token' : step === 3 ? 'Provision the ESP32' : 'Connection status'}>
        {step === 0 && <>
          <div className="search" style={{ marginBottom: 12 }}><Icon.search /><input className="input" placeholder="Search board models" onChange={(e) => { /* filtered below */ }} id="board-search" /></div>
          <Field label="Verified board definition" hint="Only boards with a verified header pin map can be registered"><select className="select" value={boardId} onChange={(e) => { setBoardId(e.target.value); setName(''); }}><option value="">Select a board</option>{(catalog.data || []).filter((b: any) => b.attributes?.pin_status === 'verified').map((b: any) => <option key={b.id} value={b.id}>{b.model} · {b.chip_family}</option>)}</select></Field>
          <Field label="Board name in your home"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Living Room Controller" /></Field>
          {selected && <div className="kv"><dt>Revision</dt><dd>{selected.revision || '—'}</dd><dt>Exposed GPIO</dt><dd>{selected.pins.length}</dd><dt>Source</dt><dd><a className="tiny" href={selected.doc_source_url} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>Official Espressif guide ↗</a></dd></div>}
          <div className="divider" /><button className="btn btn-primary btn-block" disabled={!boardId || !can('devices.manage')} onClick={() => setStep(1)}>Continue <Icon.next /></button>
        </>}
        {step === 1 && <>
          <Notice>Worldwide cloud control is MQTT over TLS. Bluetooth LE, SoftAP and USB serial are provisioning/recovery paths only — they do not replace the cloud connection.</Notice>
          <div style={{ marginTop: 14 }}>{PROVISIONING_METHODS.map((m) => <label key={m.id} className="card card-pad" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 8, cursor: 'pointer', borderColor: method === m.id ? 'var(--text)' : undefined }}>
            <input type="radio" name="method" checked={method === m.id} onChange={() => setMethod(m.id)} style={{ marginTop: 3 }} />
            <div><div style={{ fontWeight: 600, fontSize: 12.5 }}>{m.label} <Badge tone={m.scope === 'cloud' ? 'on' : m.scope === 'local' ? 'info' : ''}>{m.scope}</Badge></div><div className="tiny" style={{ marginTop: 3 }}>{m.detail}</div></div>
          </label>)}</div>
          <div className="divider" /><div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={() => setStep(0)}><Icon.back />Back</button><button className="btn btn-primary" onClick={() => setStep(2)}>Continue <Icon.next /></button></div>
        </>}
        {step === 2 && <>
          <div className="kv"><dt>Board</dt><dd>{selected?.model || 'Custom / unspecified'}</dd><dt>Name</dt><dd>{name || 'ESP32 Controller'}</dd><dt>Method</dt><dd>{PROVISIONING_METHODS.find((m) => m.id === method)?.label}</dd><dt>Token lifetime</dt><dd>15 minutes, single-use</dd></div>
          <div className="divider" /><Notice>Pairing tokens are stored as SHA-256 hashes. The plaintext token is shown once and consumed when the device claims it.</Notice>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}><button className="btn" onClick={() => setStep(1)}><Icon.back />Back</button><button className="btn btn-primary" onClick={generate}>Generate token <Icon.next /></button></div>
        </>}
        {step === 3 && issued && <>
          <Field label="One-time pairing token" hint="Expires after 15 minutes; cannot be reused"><div className="code" style={{ marginBottom: 8 }}>{issued.token}</div><CopyButton value={issued.token} /></Field>
          <div className="divider" />
          <h4 style={{ fontSize: 12.5, marginBottom: 8 }}>Finish on the device</h4>
          <div className="code">{`${window.location.origin}/api/device/claim`}</div>
          <p className="tiny" style={{ marginTop: 10 }}>Enter this one-time token in the HomecoreOS firmware setup. The device claims it over TLS and receives a unique MQTT username, password and client ID for this board only. Store them in NVS; they are never retrievable again.</p>
          <div className="divider" />
          <div className="notice"><Icon.info /><div>Cloud flow: Website → Cloudflare Pages Functions → EMQX → ESP32. The device keeps its own outbound TLS connection; no inbound ports are opened on your router.</div></div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => setStep(2)}><Icon.back />Back</button>
            <span className="tiny muted" style={{ alignSelf: 'center' }}>This page advances automatically when the device claims the token.</span>
          </div>
        </>}
        {step === 4 && <>
          <div style={{ textAlign: 'center', padding: '20px 0' }}><div className="icon-box" style={{ width: 52, height: 52, margin: '0 auto 12px', background: 'var(--state-on-bg)', color: 'var(--state-on)' }}><Icon.ok /></div>
            <h3 style={{ fontSize: 16, fontWeight: 650 }}>Controller paired</h3><p className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>The device now owns its own MQTT credentials and has received its configuration.</p></div>
          <div className="divider" /><div style={{ display: 'flex', gap: 8 }}><Link className="btn btn-primary" to="/controllers">View controllers <Icon.next /></Link><button className="btn" onClick={() => { setStep(0); setIssued(null); setStatus('idle'); }}>Add another</button></div>
        </>}
      </Card>
      <div style={{ display: 'grid', gap: 14 }}>
        <Card title="Security model"><div className="kv">
          <dt>Tenant topics</dt><dd className="mono">v1/tenants/{"{id}"}/devices/{"{id}"}/…</dd>
          <dt>Publish</dt><dd>state · telemetry · availability</dd>
          <dt>Subscribe</dt><dd>command · config</dd>
          <dt>Identity</dt><dd>From the authenticated MQTT session</dd>
          <dt>Shared admin creds</dt><dd>Never distributed to devices or browsers</dd>
        </div></Card>
        <Card title="Registered controllers" actions={<button className="btn btn-ghost btn-icon btn-sm" onClick={boards.refresh}><Icon.refresh /></button>}>
          {!boards.data?.length ? <EmptyState icon="cpu" title="None yet" text="Pair a board to see its live status here." /> : boards.data.map((b: any) => <div className="list-item" key={b.id}><div className="icon-box"><Icon.cpu /></div><div className="grow"><div className="title">{b.name}</div><div className="meta mono">{b.device_id}</div></div><StatusBadge status={b.status} /></div>)}
        </Card>
      </div>
    </div>
  </>;
}

// ============================================================================
// Automation builder
// ============================================================================
export function AutomationPage() {
  const { data, loading, refresh } = useLiveData<any[]>('/api/automations');
  const devices = useLiveData<any[]>('/api/devices');
  const sensors = useLiveData<any[]>('/api/sensors');
  const toast = useToast();
  const [edit, setEdit] = useState<any>(null);
  const [del, setDel] = useState<any>(null);
  const { can } = useAuth();
  return <>
    <PageHead title="Automation" desc="WHEN / IF / THEN rules. Safety interlocks are stored on the ESP32 so they keep working offline." actions={can('automation.manage') && <button className="btn btn-primary" onClick={() => setEdit(blankAutomation())}><Icon.plus />New automation</button>} />
    <Notice tone="warn">Pump dry-run prevention, overflow protection and emergency shutdown are enforced locally in firmware. Cloud automation never overrides those interlocks.</Notice>
    <div style={{ height: 14 }} />
    {loading ? <Loading rows={2} /> : !data?.length ? <Card><EmptyState icon="zap" title="No automation yet" text="Build a rule from a sensor event, a time schedule or a manual trigger." action={<button className="btn btn-primary" onClick={() => setEdit(blankAutomation())}>Create automation</button>} /></Card> :
      <div className="grid grid-2">{data.map((a: any) => <Card key={a.id} title={a.name} sub={a.description || undefined} actions={<div style={{ display: 'flex', gap: 6 }}>
        <StatusBadge status={a.enabled ? 'active' : 'off'} />
        <button className="btn btn-sm" onClick={async () => { try { const r = await api.post(`/api/automations/${a.id}/run`); toast(`${(r.executed || []).filter((x: any) => x.executed).length} action(s) executed`); refresh(); } catch (e: any) { toast(e.message, 'error'); } }}><Icon.zap />Run</button>
        {can('automation.manage') && <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setEdit(a)}><Icon.edit /></button>}
        {can('automation.manage') && <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setDel(a)}><Icon.trash /></button>}
      </div>}>
        <RuleSection label="WHEN" items={a.when_config.map((w: any) => `${human(w.kind)}${w.sensor_id ? ' · sensor' : ''}`)} />
        <RuleSection label="IF" items={(a.conditions || []).length ? a.conditions.map((c: any) => `${c.sensor_slug || 'any'} ${c.op || ''} ${c.value ?? ''}`) : ['Always']} />
        <RuleSection label="THEN" items={a.actions.map((x: any) => `${human(x.type || x.action || 'action')}${x.component_id ? ` · ${x.component_id}` : ''}${x.value !== undefined ? ` → ${x.value ? 'ON' : 'OFF'}` : ''}`)} />
        <div className="divider" /><div className="tiny">Execution: {a.execution} · Runs: {a.run_count} · Last: {timeAgo(a.last_run_at)}</div>
      </Card>)}</div>}
    {edit && <AutomationBuilder value={edit} devices={devices.data || []} sensors={sensors.data || []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh(); }} />}
    {del && <ConfirmModal title={`Delete ${del.name}?`} text="Local safety automations are removed from the ESP32 configuration on the next config sync." onClose={() => setDel(null)} onConfirm={async () => { try { await api.del(`/api/automations/${del.id}`); toast('Automation deleted'); refresh(); } catch (e: any) { toast(e.message, 'error'); } }} />}
  </>;
}
function blankAutomation() {
  return { name: '', description: '', enabled: true, execution: 'cloud', mode: 'single', cooldown_s: 60,
    when: [{ kind: 'sensor_event' }], if: [], then: [{ type: 'device.set_state', value: true }] };
}
function RuleSection({ label, items }: { label: string; items: string[] }) {
  return <div style={{ display: 'flex', gap: 10, marginBottom: 8, alignItems: 'flex-start' }}>
    <span className="badge" style={{ minWidth: 52, justifyContent: 'center' }}>{label}</span>
    <div style={{ fontSize: 12 }}>{items.map((x, i) => <div key={i}>{x}</div>)}</div>
  </div>;
}
function AutomationBuilder({ value, devices, sensors, onClose, onSaved }: any) {
  const toast = useToast();
  const [f, setF] = useState<any>({ ...value, when: value.when || value.when_config || [], if: value.if || value.conditions || [], then: value.then || value.actions || [] });
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const setAt = (k: string, i: number, key: string, v: any) => set(k, f[k].map((r: any, j: number) => j === i ? { ...r, [key]: v } : r));
  const save = async () => {
    try { await api.post('/api/automations', f); toast('Automation saved and configuration published'); onSaved(); }
    catch (e: any) { toast(e.message, 'error'); }
  };
  return <Modal title={f.id ? 'Edit automation' : 'New automation'} onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!f.name || !f.when.length || !f.then.length} onClick={save}>Save automation</button></>}>
    <div className="form-row"><Field label="Name"><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Turn on pump when tank is low" /></Field>
      <Field label="Execution" hint="Local rules run on the ESP32 during internet outages"><select className="select" value={f.execution} onChange={(e) => set('execution', e.target.value)}><option value="cloud">Cloud</option><option value="local">Local (ESP32)</option><option value="hybrid">Hybrid</option></select></Field></div>
    <div className="form-row"><Field label="Cooldown (seconds)"><input className="input" type="number" value={f.cooldown_s} onChange={(e) => set('cooldown_s', Number(e.target.value))} /></Field>
      <Field label="State"><select className="select" value={f.enabled ? 'true' : 'false'} onChange={(e) => set('enabled', e.target.value === 'true')}><option value="true">Enabled</option><option value="false">Disabled</option></select></Field></div>
    <div className="divider" /><h4 style={{ fontSize: 13, marginBottom: 10 }}>WHEN</h4>
    {f.when.map((w: any, i: number) => <div className="form-row" key={i}><Field label="Trigger"><select className="select" value={w.kind} onChange={(e) => setAt('when', i, 'kind', e.target.value)}>{['sensor_event', 'time_schedule', 'device_state_change', 'manual_trigger', 'controller_event'].map((x) => <option key={x} value={x}>{human(x)}</option>)}</select></Field>
      {w.kind === 'sensor_event' && <Field label="Sensor"><select className="select" value={w.sensor_id || ''} onChange={(e) => setAt('when', i, 'sensor_id', e.target.value)}><option value="">Any sensor</option>{sensors.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
      {w.kind === 'time_schedule' && <Field label="Cron / time"><input className="input" value={w.cron || ''} onChange={(e) => setAt('when', i, 'cron', e.target.value)} placeholder="0 7 * * *" /></Field>}</div>)}
    <button className="btn btn-sm" onClick={() => set('when', [...f.when, { kind: 'sensor_event' }])}><Icon.plus />Add trigger</button>
    <div className="divider" /><h4 style={{ fontSize: 13, marginBottom: 10 }}>IF</h4>
    {f.if.map((c: any, i: number) => <div className="form-row" key={i} style={{ gridTemplateColumns: '1fr 100px 90px auto' }}>
      <Field label="Sensor"><select className="select" value={c.sensor_slug || ''} onChange={(e) => setAt('if', i, 'sensor_slug', e.target.value)}>{sensors.map((s: any) => <option key={s.id} value={s.slug}>{s.name}</option>)}</select></Field>
      <Field label="Operator"><select className="select" value={c.op || 'gt'} onChange={(e) => setAt('if', i, 'op', e.target.value)}>{['gt', 'gte', 'lt', 'lte', 'eq'].map((x) => <option key={x} value={x}>{x}</option>)}</select></Field>
      <Field label="Value"><input className="input" type="number" value={c.value ?? ''} onChange={(e) => setAt('if', i, 'value', Number(e.target.value))} /></Field>
      <button className="btn btn-ghost btn-icon" style={{ marginTop: 20 }} onClick={() => set('if', f.if.filter((_: any, j: number) => j !== i))}><Icon.trash /></button></div>)}
    <button className="btn btn-sm" onClick={() => set('if', [...f.if, { sensor_slug: sensors[0]?.slug || '', op: 'gt', value: 25 }])}><Icon.plus />Add condition</button>
    <div className="divider" /><h4 style={{ fontSize: 13, marginBottom: 10 }}>THEN</h4>
    {f.then.map((a: any, i: number) => <div className="form-row" key={i} style={{ gridTemplateColumns: '1fr 1fr 100px auto' }}>
      <Field label="Action"><select className="select" value={a.type || 'device.set_state'} onChange={(e) => setAt('then', i, 'type', e.target.value)}>{['device.set_state', 'notification', 'automation.run'].map((x) => <option key={x} value={x}>{human(x)}</option>)}</select></Field>
      {a.type === 'device.set_state' && <><Field label="Device"><select className="select" value={a.component_id || ''} onChange={(e) => setAt('then', i, 'component_id', e.target.value)}>{devices.map((d: any) => <option key={d.id} value={d.slug}>{d.name}</option>)}</select></Field>
        <Field label="State"><select className="select" value={a.value ? 'on' : 'off'} onChange={(e) => setAt('then', i, 'value', e.target.value === 'on')}><option value="on">ON</option><option value="off">OFF</option></select></Field></>}
      <button className="btn btn-ghost btn-icon" style={{ marginTop: 20 }} onClick={() => set('then', f.then.filter((_: any, j: number) => j !== i))}><Icon.trash /></button></div>)}
    <button className="btn btn-sm" onClick={() => set('then', [...f.then, { type: 'device.set_state', component_id: devices[0]?.slug || '', value: true }])}><Icon.plus />Add action</button>
  </Modal>;
}

// ============================================================================
// Firmware
// ============================================================================
export function FirmwarePage() {
  const releases = useLiveData<any[]>('/api/firmware/releases');
  const history = useLiveData<any[]>('/api/firmware/history');
  const boards = useLiveData<any[]>('/api/boards');
  const toast = useToast();
  const [add, setAdd] = useState(false);
  const [ota, setOta] = useState<any>(null);
  const { can } = useAuth();
  return <>
    <PageHead title="Firmware" desc="ESP-IDF OTA releases stored in Supabase Storage with SHA-256 verification and rollback tracking." actions={can('firmware.update') && <button className="btn btn-primary" onClick={() => setAdd(true)}><Icon.plus />New release</button>} />
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <Card title="Releases" sub="Only published binaries are offered to devices" pad={false}>{releases.loading ? <div className="card-pad"><Skeleton height={120} /></div> : <DataTable columns={[
        { key: 'version', label: 'Version', render: (r: any) => <span className="mono">{r.version}</span> },
        { key: 'channel', label: 'Channel' }, { key: 'size', label: 'Size', render: (r: any) => fmtBytes(r.size_bytes) },
        { key: 'hash', label: 'SHA-256', render: (r: any) => <span className="mono tiny">{r.sha256?.slice(0, 12)}…</span> },
        { key: 'status', label: 'Status', render: (r: any) => <StatusBadge status={r.status === 'published' ? 'active' : 'queued'} /> },
        { key: 'actions', label: '', render: (r: any) => can('firmware.update') ? <button className="btn btn-sm" onClick={() => setOta({ release_id: r.id, board_id: '' })}>Deploy</button> : null },
      ]} rows={releases.data || []} empty={<EmptyState icon="download" title="No firmware releases" text="Publish a signed firmware binary to offer OTA updates." />} />}</Card>
      <Card title="Installed firmware" sub="Reported by controllers" pad={false}>{boards.loading ? <div className="card-pad"><Skeleton height={120} /></div> : <DataTable columns={[
        { key: 'name', label: 'Controller' }, { key: 'firmware_version', label: 'Installed', render: (b: any) => b.firmware_version || '—' },
        { key: 'channel', label: 'Channel', render: (b: any) => b.firmware_channel },
        { key: 'sync', label: 'Config', render: (b: any) => <StatusBadge status={b.config_sync_status} /> },
      ]} rows={boards.data || []} empty={<EmptyState icon="cpu" title="No controllers" text="Firmware state appears after pairing." />} />}</Card>
    </div>
    <div style={{ height: 14 }} />
    <Card title="Update history" pad={false}>{history.loading ? <div className="card-pad"><Skeleton height={100} /></div> : <DataTable columns={[
      { key: 'started_at', label: 'Started', render: (r: any) => timeFull(r.started_at) },
      { key: 'from_version', label: 'From', render: (r: any) => r.from_version || '—' },
      { key: 'to_version', label: 'To' },
      { key: 'progress', label: 'Progress', render: (r: any) => <div style={{ width: 110 }}><Progress value={r.progress} tone={r.status === 'failed' ? 'danger' : ''} /></div> },
      { key: 'status', label: 'Result', render: (r: any) => <StatusBadge status={r.status} /> },
      { key: 'error', label: 'Error', render: (r: any) => r.error || '—' },
    ]} rows={history.data || []} empty={<EmptyState icon="clock" title="No updates yet" text="OTA progress, verification and rollback results will appear here." />} />}</Card>
    {add && <FirmwareReleaseModal onClose={() => setAdd(false)} onDone={releases.refresh} />}
    {ota && <Modal title="Start OTA update" onClose={() => setOta(null)} footer={<><button className="btn" onClick={() => setOta(null)}>Cancel</button><button className="btn btn-primary" disabled={!ota.board_id} onClick={async () => {
      try { await api.post('/api/firmware/ota', ota); toast('OTA command published to the device'); history.refresh(); setOta(null); } catch (e: any) { toast(e.message, 'error'); }
    }}>Start update</button></>}>
      <Notice>The API publishes a command with a short-lived signed download URL and SHA-256 digest. The ESP32 verifies the hash before applying; invalid images preserve the last known good partition and roll back.</Notice>
      <Field label="Controller"><select className="select" value={ota.board_id} onChange={(e) => setOta({ ...ota, board_id: e.target.value })}><option value="">Select controller</option>{(boards.data || []).map((b: any) => <option key={b.id} value={b.id}>{b.name} · {b.firmware_version || 'unknown'}</option>)}</select></Field>
    </Modal>}
  </>;
}

function FirmwareReleaseModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ version: '', channel: 'stable', chip_family: 'esp32', notes: '', sha256: '', r2_key: '' });
  const [file, setFile] = useState<File | null>(null);
  const save = async () => {
    try {
      let payload: any = { ...f, size_bytes: file?.size || 0, status: 'published' };
      if (file) {
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
        payload.binary_base64 = btoa(bin);
        const digest = await crypto.subtle.digest('SHA-256', buf);
        payload.sha256 = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
      }
      await api.post('/api/firmware/releases', payload);
      toast('Firmware release published'); onDone(); onClose();
    } catch (e: any) { toast(e.message, 'error'); }
  };
  return <Modal title="Publish firmware release" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!f.version} onClick={save}>Publish</button></>}>
    <div className="form-row"><Field label="Version"><input className="input" value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} placeholder="1.2.0" /></Field>
      <Field label="Channel"><select className="select" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="stable">Stable</option><option value="beta">Beta</option><option value="dev">Dev</option></select></Field></div>
    <Field label="Firmware binary" hint="SHA-256 is computed in the browser and verified by the API before storage"><input className="input" type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>
    {!file && <Field label="Existing object key" hint="Use when the binary was uploaded out of band"><input className="input mono" value={f.r2_key} onChange={(e) => setF({ ...f, r2_key: e.target.value })} /></Field>}
    {!file && <Field label="SHA-256 of remote binary"><input className="input mono" value={f.sha256} onChange={(e) => setF({ ...f, sha256: e.target.value })} /></Field>}
    <Field label="Release notes"><textarea className="textarea" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
  </Modal>;
}

// ============================================================================
// Activity
// ============================================================================
export function ActivityPage() {
  const { data, loading } = useLiveData<any[]>('/api/activity');
  const [filter, setFilter] = useState('');
  const rows = (data || []).filter((r: any) => (r.action + (r.actor_email || '')).toLowerCase().includes(filter.toLowerCase()));
  return <>
    <PageHead title="Activity" desc="Audit trail of staff changes, device commands and administrative operations." />
    <Card pad={false}><div className="card-head"><h3>Workspace activity</h3><div className="search" style={{ width: 220 }}><Icon.search /><input className="input" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} /></div></div>
      {loading ? <div className="card-pad"><Skeleton height={180} /></div> : <DataTable columns={[
        { key: 'created_at', label: 'When', render: (r: any) => timeFull(r.created_at) },
        { key: 'action', label: 'Action', render: (r: any) => human(r.action.replace(/\./g, ' ')) },
        { key: 'entity', label: 'Entity', render: (r: any) => `${r.entity_type || '—'} ${r.entity_id ? r.entity_id.slice(0, 8) : ''}` },
        { key: 'actor', label: 'Actor', render: (r: any) => r.actor_email || r.actor_type },
      ]} rows={rows} empty={<EmptyState icon="activity" title="No activity" text="Actions appear here as soon as you make changes." />} />}</Card>
  </>;
}

// ============================================================================
// Staff & permissions
// ============================================================================
export function StaffPage() {
  const { data, loading, refresh } = useLiveData<any>('/api/staff');
  const { role, toast } = useAuth();
  const [invite, setInvite] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [revoke, setRevoke] = useState<any>(null);
  const [newRole, setNewRole] = useState(false);
  const isOwner = role === 'owner';
  return <>
    <PageHead title="Staff" desc="Roles, granular permissions and room/device access restrictions." actions={isOwner && <><button className="btn" onClick={() => setNewRole(true)}><Icon.plus />Custom role</button><button className="btn btn-primary" onClick={() => setInvite(true)}><Icon.plus />Invite staff</button></>} />
    <Card pad={false}><div className="card-head"><h3>Members</h3><div className="sub">{data?.permissions?.length || 12} permission categories</div></div>
      {loading ? <div className="card-pad"><Skeleton height={150} /></div> : <DataTable columns={[
        { key: 'name', label: 'Member', render: (m: any) => <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}><div className="avatar">{(m.profile?.full_name || m.invited_email || 'U').slice(0, 2).toUpperCase()}</div><div><div style={{ fontWeight: 600 }}>{m.profile?.full_name || m.invited_email || 'Pending'}</div><div className="tiny">{m.profile?.email || m.invited_email}</div></div></div> },
        { key: 'role_key', label: 'Role', render: (m: any) => human(m.role_key) },
        { key: 'status', label: 'Status', render: (m: any) => <StatusBadge status={m.status} /> },
        { key: 'joined_at', label: 'Joined', render: (m: any) => timeAgo(m.joined_at) },
        { key: 'actions', label: '', render: (m: any) => isOwner && m.role_key !== 'owner' ? <div className="row-actions">
          <button className="btn btn-sm" onClick={() => setEdit(m)}><Icon.shield />Permissions</button>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setRevoke(m)}><Icon.trash /></button></div> : <span className="tiny">Owner</span> },
      ]} rows={data?.members || []} empty={<EmptyState icon="users" title="No staff yet" text="Invite people by email. They must accept with the matching account." />} />}</Card>
    <div style={{ height: 14 }} />
    <Card title="Permission categories" sub="Applied server-side on every request"><div className="grid grid-3">{(data?.permissions || []).map((p: any) => <div className="list-item" key={p.key} style={{ padding: '8px 0', border: 0 }}><div className="icon-box"><Icon.shield /></div><div className="grow"><div className="title">{p.label}</div><div className="meta mono">{p.key}</div></div></div>)}</div></Card>
    {invite && <InviteModal onClose={() => setInvite(false)} roles={data?.roles || []} onDone={refresh} />}
    {edit && <PermissionsModal member={edit} permissions={data?.permissions || []} roles={data?.roles || []} onClose={() => setEdit(null)} onDone={refresh} />}
    {revoke && <ConfirmModal title={`Revoke ${revoke.profile?.full_name || 'member'}?`} confirmLabel="Revoke access" text="Access stops immediately: the API re-checks membership and permissions on every request." onClose={() => setRevoke(null)} onConfirm={async () => {
      try { await api.del(`/api/staff/${revoke.id}`); toast('Access revoked immediately'); refresh(); } catch (e: any) { toast(e.message, 'error'); }
    }} />}
    {newRole && <CustomRoleModal permissions={data?.permissions || []} onClose={() => setNewRole(false)} onDone={refresh} />}
  </>;
}

function InviteModal({ onClose, roles, onDone }: any) {
  const toast = useToast();
  const [f, setF] = useState({ email: '', role_key: 'viewer', message: '' });
  const [result, setResult] = useState<any>(null);
  return <Modal title="Invite staff member" onClose={onClose} footer={result ? <button className="btn" onClick={onClose}>Done</button> : <><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!f.email} onClick={async () => {
    try { setResult(await api.post('/api/staff/invite', f)); toast('Invitation created'); onDone(); } catch (e: any) { toast(e.message, 'error'); }
  }}>Create invitation</button></>}>
    {result ? <><Notice>Invitation created. Deliver the token to the invitee out of band; they accept it from their own account.</Notice><div className="code" style={{ marginTop: 14 }}>{result.invite_token}</div><div style={{ marginTop: 10 }}><CopyButton value={result.invite_token} /></div></> : <>
      <Field label="Email address"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <Field label="Role"><select className="select" value={f.role_key} onChange={(e) => setF({ ...f, role_key: e.target.value })}>{roles.filter((r: any) => r.key !== 'owner').map((r: any) => <option key={r.id} value={r.key}>{r.name}</option>)}</select></Field>
      <Field label="Message (optional)"><textarea className="textarea" value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
    </>}
  </Modal>;
}

function PermissionsModal({ member, permissions, roles, onClose, onDone }: any) {
  const toast = useToast();
  const [f, setF] = useState<any>({ role_key: member.role_key, status: member.status, permissions: [], access_rules: [] });
  const toggle = (key: string, effect: string) => setF((x: any) => ({ ...x, permissions: [...x.permissions.filter((p: any) => p.key !== key), { key, effect }] }));
  return <Modal title={`Permissions · ${member.profile?.full_name || 'Member'}`} onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={async () => {
    try { await api.patch(`/api/staff/${member.id}`, f); toast('Permissions updated'); onDone(); onClose(); } catch (e: any) { toast(e.message, 'error'); }
  }}>Save</button></>}>
    <div className="form-row"><Field label="Role"><select className="select" value={f.role_key} onChange={(e) => setF({ ...f, role_key: e.target.value })}>{roles.filter((r: any) => r.key !== 'owner').map((r: any) => <option key={r.id} value={r.key}>{r.name}</option>)}</select></Field>
      <Field label="Status"><select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="active">Active</option><option value="suspended">Suspended</option><option value="revoked">Revoked</option></select></Field></div>
    <Notice>Overrides are evaluated before role defaults. A member cannot change their own permissions — the database layer and API both block self-escalation.</Notice>
    <div className="divider" /><h4 style={{ fontSize: 13, marginBottom: 10 }}>Per-member overrides</h4>
    {permissions.map((p: any) => <div className="list-item" key={p.key} style={{ padding: '8px 0' }}><div className="grow"><div className="title">{p.label}</div><div className="meta mono">{p.key}</div></div>
      <div className="segmented">{['role', 'allow', 'deny'].map((e) => <button key={e} className={(f.permissions.find((x: any) => x.key === p.key)?.effect || 'role') === e ? 'on' : ''} onClick={() => e === 'role' ? setF({ ...f, permissions: f.permissions.filter((x: any) => x.key !== p.key) }) : toggle(p.key, e)}>{e}</button>)}</div></div>)}
  </Modal>;
}

function CustomRoleModal({ permissions, onClose, onDone }: any) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>(['dashboard.view', 'sensors.view']);
  return <Modal title="Create custom role" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!name} onClick={async () => {
    try { await api.post('/api/roles', { name, permissions: selected }); toast('Custom role created'); onDone(); onClose(); } catch (e: any) { toast(e.message, 'error'); }
  }}>Create role</button></>}>
    <Field label="Role name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Night operator" /></Field>
    <h4 style={{ fontSize: 12.5, marginBottom: 8 }}>Permissions</h4>
    {permissions.map((p: any) => <label className="check" key={p.key} style={{ marginBottom: 6 }}><input type="checkbox" checked={selected.includes(p.key)} onChange={(e) => setSelected(e.target.checked ? [...selected, p.key] : selected.filter((x) => x !== p.key))} />{p.label}</label>)}
  </Modal>;
}

// ============================================================================
// Settings
// ============================================================================
export function SettingsPage() {
  const { data, loading, refresh } = useLiveData<any>('/api/settings');
  const usage = useLiveData<any>('/api/usage');
  const { toast, can } = useAuth();
  const [f, setF] = useState<any>(null);
  React.useEffect(() => { if (data) setF({ name: data.tenant?.name, timezone: data.tenant?.timezone, address: data.tenant?.address || '', full_name: data.profile?.full_name || '', phone: data.profile?.phone || '' }); }, [data]);
  const exportData = async () => {
    const d = await api.get('/api/export');
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'homecoreos-export.json'; a.click();
    toast('Workspace data exported');
  };
  return <>
    <PageHead title="Settings" desc="Home profile, connection information and account-level usage estimates." />
    {loading || !f ? <Loading rows={2} /> : <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <div style={{ display: 'grid', gap: 14 }}>
        <Card title="Home & profile" actions={<button className="btn btn-primary btn-sm" disabled={!can('settings.manage')} onClick={async () => { try { await api.patch('/api/settings', f); toast('Settings saved'); refresh(); } catch (e: any) { toast(e.message, 'error'); } }}>Save changes</button>}>
          <Field label="Home name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="form-row"><Field label="Your name"><input className="input" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
            <Field label="Timezone"><input className="input" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field></div>
          <Field label="Address"><input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        </Card>
        <Card title="Connection information"><div className="kv">
          <dt>Workspace ID</dt><dd className="mono">{data.tenant?.id}</dd>
          <dt>Status</dt><dd><StatusBadge status={data.tenant?.status} /></dd>
          <dt>Plan</dt><dd>{data.tenant?.plan}</dd>
          <dt>Device registration</dt><dd>{data.tenant?.device_registration_enabled ? 'Enabled' : 'Disabled by platform owner'}</dd>
          <dt>Limits</dt><dd>{data.tenant?.max_boards} boards · {data.tenant?.max_devices} devices</dd>
          <dt>Your role</dt><dd>{human(data.role)}</dd>
        </div></Card>
      </div>
      <div style={{ display: 'grid', gap: 14 }}>
        <Card title="Account usage" sub="Application-side estimate, not EMQX deployment usage">
          <div className="metric-row"><span>Command messages</span><span className="v">{fmt(usage.data?.commands, 0)}</span></div>
          <div className="metric-row"><span>Telemetry messages</span><span className="v">{fmt(usage.data?.telemetry_messages, 0)}</span></div>
          <div className="metric-row"><span>Estimated payload</span><span className="v">{fmtBytes(usage.data?.estimated_command_bytes + usage.data?.estimated_telemetry_bytes)}</span></div>
          <div className="tiny" style={{ marginTop: 10 }}>{usage.data?.note}</div>
        </Card>
        <Card title="Data"><p className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>Export your workspace records. Account deletion requires platform-owner assistance so devices can be unclaimed first.</p>
          <button className="btn" onClick={exportData}><Icon.download />Export workspace data</button></Card>
        <Card title="Notification & security"><div className="kv">
          <dt>Sessions</dt><dd>Signed JWT, verified on every request</dd>
          <dt>Device credentials</dt><dd>Unique per controller; rotate from Controllers</dd>
          <dt>Isolation</dt><dd>Database authorization + API tenant checks + MQTT ACL</dd>
          <dt>Activity log</dt><dd><Link to="/activity" style={{ textDecoration: 'underline' }}>View audit trail</Link></dd>
        </div></Card>
      </div>
    </div>}
  </>;
}
