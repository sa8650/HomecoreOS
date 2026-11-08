/** Owner Console — Board library. No board specifications are invented. */
import React, { useMemo, useState } from 'react';
import { api, useLiveData } from '../api';
import { useAuth } from '../state';
import {
  Badge, Card, DataTable, EmptyState, Field, Icon, Loading, Modal, Notice,
  PageHead, timeAgo,
} from '../components';

function useToast() { return useAuth().toast; }

const CAPS = [
  { id: 'gpio', label: 'GPIO' }, { id: 'adc', label: 'ADC' }, { id: 'pwm', label: 'PWM' },
  { id: 'i2c', label: 'I²C' }, { id: 'spi', label: 'SPI' }, { id: 'uart', label: 'UART' },
  { id: 'touch', label: 'Touch' }, { id: 'rtc', label: 'RTC' },
];

type PinRow = {
  gpio: string; header_label: string; side: string; header_pin: string;
  functions: string[]; adc_channels: string; input_only: boolean;
  boot_strapping: boolean; flash_connected: boolean; psram_connected: boolean;
  exposed: boolean; usb_jtag: boolean; rtc_gpio: boolean;
  restriction_note: string; notes: string;
};

const blankPin = (): PinRow => ({
  gpio: '', header_label: '', side: '', header_pin: '', functions: ['gpio'],
  adc_channels: '', input_only: false, boot_strapping: false, flash_connected: false,
  psram_connected: false, exposed: true, usb_jtag: false, rtc_gpio: false,
  restriction_note: '', notes: '',
});

const fromServer = (p: any): PinRow => ({
  gpio: String(p.gpio ?? ''), header_label: p.header_label || '', side: p.side || '',
  header_pin: p.header_pin == null ? '' : String(p.header_pin),
  functions: p.functions || [], adc_channels: (p.adc_channels || []).join(', '),
  input_only: !!p.input_only, boot_strapping: !!p.boot_strapping,
  flash_connected: !!p.flash_connected, psram_connected: !!p.psram_connected,
  exposed: p.exposed !== false, usb_jtag: !!p.usb_jtag, rtc_gpio: !!p.rtc_gpio,
  restriction_note: p.restriction_note || '', notes: p.notes || '',
});

function validatePinsLocal(rows: PinRow[]): string | null {
  if (!rows.length) return 'Add at least one GPIO row from the manufacturer pinout.';
  const seen = new Set<string>();
  for (const r of rows) {
    const n = Number(r.gpio);
    if (!Number.isInteger(n) || n < 0 || n > 48) return `GPIO "${r.gpio || '(empty)'}" must be a whole number from 0 to 48.`;
    if (seen.has(String(n))) return `GPIO ${n} appears more than once.`;
    seen.add(String(n));
    if (r.input_only && r.functions.some((f) => ['pwm', 'spi', 'uart'].includes(f))) {
      return `GPIO ${n} is input-only, so PWM, SPI and UART output cannot be assigned to it.`;
    }
    if (r.functions.includes('adc') && !r.adc_channels.trim()) {
      return `GPIO ${n} is marked ADC. Enter its ADC channel (for example ADC1_CH0).`;
    }
  }
  return null;
}

function PinEditor({ rows, setRows, boardId }: { rows: PinRow[]; setRows: (r: PinRow[]) => void; boardId?: string }) {
  const toast = useToast();
  const [checking, setChecking] = useState<number | null>(null);
  const [checked, setChecked] = useState<Record<number, { allowed: boolean; reason?: string }>>({});
  const update = (i: number, patch: Partial<PinRow>) => {
    const next = rows.map((r, j) => j === i ? { ...r, ...patch } : r);
    setRows(next);
  };
  const check = async (i: number) => {
    if (!boardId) { toast('Save the board first, then check its GPIO assignments.', 'error'); return; }
    setChecking(i);
    const row = rows[i]!;
    try {
      const r = await api.post('/api/board-catalog/validate-gpio', {
        board_id: boardId, gpio: Number(row.gpio),
        capability: row.functions.find((f) => f !== 'gpio') || 'gpio',
      });
      setChecked((m) => ({ ...m, [i]: r }));
    } catch (e: any) { setChecked((m) => ({ ...m, [i]: { allowed: false, reason: e.message } })); }
    finally { setChecking(null); }
  };
  return <div style={{ display: 'grid', gap: 12 }}>
    <Notice tone="info" title="Use the manufacturer's pinout">No pins, ADC channels or capabilities are generated for you. Copy each row from the official documentation for the exact board revision, then mark the restrictions that apply.</Notice>
    {rows.map((r, i) => <div className="card card-pad" key={i} style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>GPIO row {i + 1}</strong>
        {checked[i] && <Badge tone={checked[i].allowed ? 'on' : 'danger'} icon={checked[i].allowed ? 'ok' : 'fail'}>
          {checked[i].allowed ? 'Valid assignment' : checked[i].reason || 'Not allowed'}</Badge>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="btn btn-sm" onClick={() => check(i)} disabled={checking === i || !r.gpio}>
            <Icon.shieldOk />Check pin</button>
          <button className="btn btn-sm btn-danger" onClick={() => setRows(rows.filter((_, j) => j !== i))}
            aria-label={`Remove GPIO row ${i + 1}`}><Icon.trash /></button>
        </div>
      </div>
      <div className="form-row">
        <Field label="GPIO number" required><input className="input mono" inputMode="numeric" value={r.gpio}
          onChange={(e) => update(i, { gpio: e.target.value })} placeholder="e.g. 4" /></Field>
        <Field label="Header label"><input className="input" value={r.header_label}
          onChange={(e) => update(i, { header_label: e.target.value })} placeholder="e.g. D4 / IO4" /></Field>
      </div>
      <div className="form-row">
        <Field label="Side"><input className="input" value={r.side} onChange={(e) => update(i, { side: e.target.value })} placeholder="left / right" /></Field>
        <Field label="Header pin number"><input className="input mono" inputMode="numeric" value={r.header_pin}
          onChange={(e) => update(i, { header_pin: e.target.value })} placeholder="Physical pin" /></Field>
      </div>
      <Field label="Supported functions">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {CAPS.map((c) => <label key={c.id} className="check" style={{ minWidth: 92 }}>
            <input type="checkbox" checked={r.functions.includes(c.id)} onChange={(e) => update(i, {
              functions: e.target.checked ? [...r.functions, c.id] : r.functions.filter((x) => x !== c.id),
            })} />{c.label}</label>)}
        </div>
      </Field>
      {r.functions.includes('adc') && <Field label="ADC channel(s)" hint="Separate several channels with commas.">
        <input className="input mono" value={r.adc_channels} onChange={(e) => update(i, { adc_channels: e.target.value })}
          placeholder="ADC1_CH0" /></Field>}
      <Field label="Pin restrictions">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {([
            ['input_only', 'Input only'], ['boot_strapping', 'Boot-strapping'],
            ['flash_connected', 'Internal flash'], ['psram_connected', 'PSRAM'],
            ['usb_jtag', 'USB / JTAG'], ['rtc_gpio', 'RTC GPIO'],
          ] as [keyof PinRow, string][]).map(([k, label]) => <label key={k} className="check" style={{ minWidth: 132 }}>
            <input type="checkbox" checked={!!r[k]} onChange={(e) => update(i, { [k]: e.target.checked } as any)} />{label}</label>)}
          <label className="check" style={{ minWidth: 160 }}>
            <input type="checkbox" checked={!r.exposed} onChange={(e) => update(i, { exposed: !e.target.checked })} />
            Not available on header</label>
        </div>
      </Field>
      <div className="form-row">
        <Field label="Restriction note"><input className="input" value={r.restriction_note}
          onChange={(e) => update(i, { restriction_note: e.target.value })} placeholder="Why this pin is restricted" /></Field>
        <Field label="Notes"><input className="input" value={r.notes}
          onChange={(e) => update(i, { notes: e.target.value })} placeholder="Optional documentation note" /></Field>
      </div>
    </div>)}
    <button className="btn" onClick={() => setRows([...rows, blankPin()])}><Icon.plus />Add GPIO row</button>
  </div>;
}

function BoardEditor({ board, families, onClose, onDone }: {
  board: any | null; families: string[]; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const editing = !!board;
  const [f, setF] = useState({
    model: board?.model || '', manufacturer: board?.manufacturer || '',
    chip_family: board?.chip_family || '', chip_variant: board?.chip_variant || '',
    variant: board?.variant || '', revision: board?.revision || '',
    summary: board?.summary || '', image_url: board?.image_url || '',
    pinout_url: board?.pinout_url || '', doc_source_url: board?.doc_source_url || '',
  });
  const [pins, setPins] = useState<PinRow[]>([]);
  const [loadedPins, setLoadedPins] = useState(false);
  const [tab, setTab] = useState<'details' | 'pins'>('details');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  React.useEffect(() => {
    if (!editing) { setLoadedPins(true); return; }
    api.get<any[]>(`/api/owner/boards/${board.id}/pins`).then((rows) => {
      setPins(rows.map(fromServer)); setLoadedPins(true);
    }).catch((e) => { setError(e.message); setLoadedPins(true); });
  }, [editing, board?.id]);

  const save = async () => {
    setError('');
    if (!f.model.trim() || !f.manufacturer.trim() || !f.chip_family) {
      setError('Board name, manufacturer and ESP32 variant are required.'); return;
    }
    const problem = validatePinsLocal(pins);
    if (problem) { setTab('pins'); setError(problem); return; }
    const payloadPins = pins.map((r) => ({
      gpio: Number(r.gpio), header_label: r.header_label || undefined,
      side: r.side || undefined, header_pin: r.header_pin || undefined,
      functions: r.functions,
      adc_channels: r.adc_channels.split(',').map((x) => x.trim()).filter(Boolean),
      input_only: r.input_only, boot_strapping: r.boot_strapping,
      flash_connected: r.flash_connected, psram_connected: r.psram_connected,
      exposed: r.exposed, usb_jtag: r.usb_jtag, rtc_gpio: r.rtc_gpio,
      restriction_note: r.restriction_note || undefined, notes: r.notes || undefined,
    }));
    setBusy(true);
    try {
      if (editing) {
        await api.patch(`/api/owner/boards/${board.id}`, { ...f, summary: f.summary || undefined });
        await api.put(`/api/owner/boards/${board.id}/pins`, { pins: payloadPins, capabilities: {} });
      } else {
        await api.post('/api/owner/boards', { ...f, pins: payloadPins, capabilities: {} });
      }
      toast(editing ? 'Board definition saved' : 'Custom board created'); onDone(); onClose();
    } catch (e: any) { setError(e.message || 'Could not save the board.'); }
    finally { setBusy(false); }
  };

  return <Modal title={editing ? `Edit ${board.model}` : 'Add a custom board'}
    description={editing ? 'Only owner-supplied boards can be edited. Verified manufacturer maps stay read-only.'
      : 'Enter the specifications exactly as published by the manufacturer. Nothing is filled in automatically.'}
    onClose={onClose} wide footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={save} disabled={busy || !loadedPins}>
        {busy ? <><Icon.loader className="spinner" />Saving…</> : 'Save board'}</button>
    </>}>
    <div className="tabs" style={{ marginBottom: 16 }}>
      <button className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}><Icon.card />Board details</button>
      <button className={tab === 'pins' ? 'on' : ''} onClick={() => setTab('pins')}><Icon.circuitry />GPIO & capabilities ({pins.length})</button>
    </div>
    {error && <div className="notice danger" style={{ marginBottom: 16 }}><Icon.fail />{error}</div>}
    {tab === 'details' ? <div>
      <div className="form-row">
        <Field label="Board name" required><input className="input" value={f.model}
          onChange={(e) => setF({ ...f, model: e.target.value })} placeholder="ESP32-DevKitC V4" /></Field>
        <Field label="Manufacturer" required><input className="input" value={f.manufacturer}
          onChange={(e) => setF({ ...f, manufacturer: e.target.value })} placeholder="Espressif" /></Field>
      </div>
      <div className="form-row">
        <Field label="ESP32 variant" required hint="Only variants already documented in the catalog are accepted.">
          <select className="select" value={f.chip_family} onChange={(e) => setF({ ...f, chip_family: e.target.value })}>
            <option value="">Select a variant</option>
            {families.map((x) => <option key={x} value={x}>{x}</option>)}
          </select></Field>
        <Field label="Module / chip"><input className="input" value={f.chip_variant}
          onChange={(e) => setF({ ...f, chip_variant: e.target.value })} placeholder="ESP32-WROOM-32E" /></Field>
      </div>
      <div className="form-row">
        <Field label="Board variant"><input className="input" value={f.variant}
          onChange={(e) => setF({ ...f, variant: e.target.value })} placeholder="N8 / N16R8" /></Field>
        <Field label="Revision"><input className="input" value={f.revision}
          onChange={(e) => setF({ ...f, revision: e.target.value })} placeholder="v1.1" /></Field>
      </div>
      <Field label="Description"><textarea className="textarea" value={f.summary}
        onChange={(e) => setF({ ...f, summary: e.target.value })}
        placeholder="What this board is, and anything a customer should know before assigning pins." /></Field>
      <Field label="Board image URL" hint="A link to the manufacturer's product photo. Leave empty if you do not have one.">
        <input className="input mono" value={f.image_url} onChange={(e) => setF({ ...f, image_url: e.target.value })} placeholder="https://…" /></Field>
      <Field label="Pinout reference URL"><input className="input mono" value={f.pinout_url}
        onChange={(e) => setF({ ...f, pinout_url: e.target.value })} placeholder="https://…/pinlayout.png" /></Field>
      <Field label="Official documentation URL"><input className="input mono" value={f.doc_source_url}
        onChange={(e) => setF({ ...f, doc_source_url: e.target.value })} placeholder="https://docs.espressif.com/…" /></Field>
      {f.doc_source_url && <a className="btn btn-sm" href={f.doc_source_url} target="_blank" rel="noreferrer">
        <Icon.external />Open documentation</a>}
    </div> : loadedPins ? <PinEditor rows={pins} setRows={setPins} boardId={editing ? board.id : undefined} />
      : <Loading rows={3} shape="row" />}
  </Modal>;
}

export function OwnerBoards() {
  const { data, loading, error, refresh } = useLiveData<any[]>('/api/owner/boards');
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [editor, setEditor] = useState<any | null | undefined>(undefined);
  const [confirm, setConfirm] = useState<any>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const boards = data || [];
  const families = useMemo(() => [...new Set(boards.map((b: any) => String(b.chip_family)).filter(Boolean))].sort(), [boards]);
  const filtered = boards.filter((b: any) => {
    const q = search.toLowerCase();
    return (!q || `${b.model} ${b.manufacturer} ${b.chip_family} ${b.id}`.toLowerCase().includes(q))
      && (filter === 'all' || (filter === 'custom' ? (b.is_custom || b.category === 'custom')
        : filter === 'verified' ? !(b.is_custom || b.category === 'custom') && b.active
        : filter === 'archived' ? !b.active : true));
  });
  const archive = async (b: any) => {
    setBusy(b.id);
    try { await api.post(`/api/owner/boards/${b.id}/archive`, {});
      toast(b.active ? 'Board archived' : 'Board restored'); refresh(); }
    catch (e: any) { toast(e.message || 'Could not change the board', 'error'); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    if (!confirm || typed !== 'DELETE') return;
    setBusy(confirm.id);
    try { await api.del(`/api/owner/boards/${confirm.id}?confirm=DELETE`);
      toast('Board definition deleted'); setConfirm(null); setTyped(''); refresh(); }
    catch (e: any) { toast(e.message || 'Deletion failed', 'error'); }
    finally { setBusy(null); }
  };

  return <>
    <PageHead title="Board library" eyebrow="Owner console"
      desc="Verified manufacturer pin maps, plus custom ESP32 boards you define from official documentation. GPIO rules are enforced when customers assign pins."
      actions={<button className="btn btn-primary" onClick={() => setEditor(null)}><Icon.plus />Add custom board</button>} />
    <Notice tone="info" title="Specifications come from documentation">Existing verified boards show the real pin maps seeded from Espressif documentation and stay read-only. Custom boards start with an empty pin list — you enter every GPIO, capability and restriction yourself.</Notice>
    {error && <div style={{ margin: '16px 0' }}><div className="notice danger"><Icon.fail />{error}
      <button className="btn btn-sm" onClick={refresh}><Icon.retry />Try again</button></div></div>}
    <Card title="Board models" sub="Search by name, manufacturer or ESP32 variant" pad={false} icon="circuitry" style={{ marginTop: 16 }}>
      <div className="card-pad filter-bar">
        <div className="search"><Icon.search /><input className="input" placeholder="Search board models"
          value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <select className="select" style={{ width: 190 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All boards</option><option value="verified">Verified & enabled</option>
          <option value="custom">Custom boards</option><option value="archived">Archived</option></select>
        <span className="tiny">{filtered.length} of {boards.length}</span>
      </div>
      {loading ? <div className="card-pad"><Loading rows={5} shape="table" /></div>
        : <DataTable columns={[
          { key: 'model', label: 'Board model', render: (b) => <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {b.image_url ? <img src={b.image_url} alt="" style={{ width: 42, height: 34, objectFit: 'contain', borderRadius: 6 }} />
              : <span className="icon-box"><Icon.cpu /></span>}
            <div><div style={{ fontWeight: 700 }}>{b.model}</div><div className="tiny">{b.manufacturer} · {b.chip_family}</div></div>
          </div> },
          { key: 'variant', label: 'Variant / revision', render: (b) => <span className="tiny">{b.variant || '—'}{b.revision ? ` · ${b.revision}` : ''}</span> },
          { key: 'pins', label: 'GPIO rows', render: (b) => b.pin_count ? <Badge tone="on">{b.pin_count} documented</Badge> : <Badge tone="warn">No pin map</Badge> },
          { key: 'type', label: 'Source', render: (b) => (b.is_custom || b.category === 'custom')
            ? <Badge tone="info">Custom</Badge> : <Badge>Verified</Badge> },
          { key: 'status', label: 'Availability', render: (b) => b.active ? <Badge tone="on" icon="ok">Enabled</Badge> : <Badge tone="off" icon="archive">Archived</Badge> },
          { key: 'docs', label: 'Reference', render: (b) => b.pinout_url || b.doc_source_url
            ? <a className="btn btn-sm" href={b.pinout_url || b.doc_source_url} target="_blank" rel="noreferrer"><Icon.book />Docs</a>
            : <span className="tiny">—</span> },
          { key: 'updated', label: 'Updated', render: (b) => <span className="tiny">{timeAgo(b.updated_at)}</span> },
          { key: 'actions', label: '', render: (b) => <div className="row-actions">
            {(b.is_custom || b.category === 'custom')
              ? <button className="btn btn-sm" onClick={() => setEditor(b)}><Icon.edit />Edit</button>
              : <span className="tiny muted">Read only</span>}
            <button className="btn btn-sm" disabled={busy === b.id} onClick={() => archive(b)}>
              {b.active ? 'Archive' : 'Restore'}</button>
            {(b.is_custom || b.category === 'custom') && <button className="btn btn-sm btn-danger"
              onClick={() => { setConfirm(b); setTyped(''); }}><Icon.trash /></button>}
          </div> },
        ]} rows={filtered} empty={<EmptyState icon="circuitry" title="No boards match this filter"
          text="Try a different search, or add a custom board using its official pinout."
          action={<button className="btn btn-primary" onClick={() => setEditor(null)}><Icon.plus />Add custom board</button>} />} />}
    </Card>
    <div style={{ marginTop: 16 }}><Card title="How GPIO validation works" icon="shieldOk">
      <div className="grid grid-3">
        <div><strong className="text-title-sm">Restricted pins</strong><p className="tiny" style={{ marginTop: 4 }}>Input-only, boot-strapping, internal flash, PSRAM and unexposed pins are blocked from assignment.</p></div>
        <div><strong className="text-title-sm">Capability checks</strong><p className="tiny" style={{ marginTop: 4 }}>ADC, PWM, I²C, SPI and UART are accepted only on pins where you documented that function.</p></div>
        <div><strong className="text-title-sm">Duplicate protection</strong><p className="tiny" style={{ marginTop: 4 }}>GPIO numbers must be unique, from 0 to 48, and a board name cannot be added twice for one manufacturer.</p></div>
      </div>
    </Card></div>
    {editor !== undefined && <BoardEditor board={editor} families={families} onClose={() => setEditor(undefined)} onDone={refresh} />}
    {confirm && <Modal title="Delete custom board" onClose={() => setConfirm(null)} footer={<>
      <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
      <button className="btn btn-danger" onClick={remove} disabled={typed !== 'DELETE' || busy === confirm.id}>
        <Icon.trash />Delete board</button></>}>
      <Notice tone="danger" title="Only unused custom boards can be deleted">If a customer controller uses this board, archive it instead so its devices keep working. The pin map is removed with the board.</Notice>
      <div className="kv" style={{ margin: '16px 0' }}><dt>Board</dt><dd>{confirm.model}</dd>
        <dt>Manufacturer</dt><dd>{confirm.manufacturer}</dd><dt>GPIO rows</dt><dd>{confirm.pin_count || 0}</dd></div>
      <Field label="Type DELETE to confirm"><input className="input mono" value={typed}
        onChange={(e) => setTyped(e.target.value)} placeholder="DELETE" /></Field>
    </Modal>}
  </>;
}
