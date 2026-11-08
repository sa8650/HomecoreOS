/**
 * Cloudflare D1 adapter — the second half of the common database contract.
 *
 * The Supabase provider executes the Postgres RPCs in supabase/migrations.
 * D1 cannot run PL/pgSQL, so the SAME domain operations are implemented here
 * in TypeScript on top of SQLite. Table names, column names, JSON payloads and
 * return shapes are identical, so app/feature code is provider-agnostic.
 *
 * Only one provider is ever active per runtime (see runtime/cloud.ts).
 */
import type { DataClient } from '@homecoreos/core';
import {
  D1_MIGRATIONS, D1_COLUMNS, D1_JSON_COLUMNS, D1_ARRAY_COLUMNS,
  D1_BOOL_COLUMNS, D1_AUTO_ID_TABLES, D1_TABLES,
} from './d1-schema';

/** Structural subset of the Cloudflare D1 binding (no Node types here). */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): any;
    all<T = any>(): Promise<{ results: T[] }>;
    first<T = any>(column?: string): Promise<T | null>;
    run(): Promise<unknown>;
  };
  batch(statements: any[]): Promise<unknown[]>;
  exec(sql: string): Promise<unknown>;
}

export interface SelectOpts {
  columns?: string;
  eq?: Record<string, unknown>;
  in?: Record<string, unknown[]>;
  gt?: Record<string, unknown>;
  gte?: Record<string, unknown>;
  lt?: Record<string, unknown>;
  lte?: Record<string, unknown>;
  neq?: Record<string, unknown>;
  isNull?: string[];
  notNull?: string[];
  like?: Record<string, string>;
  order?: { column: string; ascending?: boolean };
  limit?: number;
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const has = (list: Record<string, string[]>, table: string, col: string) => (list[table] || []).includes(col);
const iso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const IDENT = /^[a-z_][a-z0-9_.]*$/i;
const ident = (s: string) => { if (!IDENT.test(s)) throw new Error(`Unsafe identifier: ${s}`); return s; };

export class D1Adapter implements DataClient {
  readonly kind = 'd1' as const;
  constructor(private db: D1Like) {}

  // -------------------------------------------------------------------------
  // Low-level helpers
  // -------------------------------------------------------------------------
  async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const st = this.db.prepare(sql);
    const r = params.length ? await st.bind(...params).all() : await st.all<T>();
    return (r?.results || []) as T[];
  }
  async run(sql: string, params: unknown[] = []) {
    const st = this.db.prepare(sql);
    await (params.length ? st.bind(...params).run() : st.run());
  }
  async scalar<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<any>(sql, params);
    return rows.length ? (Object.values(rows[0])[0] as T) : null;
  }
  async count(table: string, where: Record<string, unknown> = {}): Promise<number> {
    const { sql, params } = this.where({ eq: where });
    return Number(await this.scalar<number>(`select count(*) n from ${ident(table)}${sql}`, params) || 0);
  }
  async one<T = any>(table: string, where: Record<string, unknown> = {}): Promise<T | null> {
    const { sql, params } = this.where({ eq: where });
    const rows = await this.query<any>(`select * from ${ident(table)}${sql} limit 1`, params);
    return rows.length ? (this.decode(table, rows[0]) as T) : null;
  }

  private encodeValue(table: string, col: string, v: unknown): any {
    // JSON columns are NOT NULL in the shared schema: keep a JSON `null`
    // literal rather than a SQL NULL so backups/restore stay lossless.
    if (v === null && (has(D1_JSON_COLUMNS, table, col) || has(D1_ARRAY_COLUMNS, table, col))) return 'null';
    if (v === undefined || v === null) return null;
    if (has(D1_BOOL_COLUMNS, table, col)) return v === true || v === 1 || v === 'true' ? 1 : 0;
    if (has(D1_JSON_COLUMNS, table, col) || has(D1_ARRAY_COLUMNS, table, col)) {
      return typeof v === 'string' ? v : JSON.stringify(v);
    }
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  }
  private encode(table: string, row: Record<string, unknown>): Record<string, any> {
    const cols = D1_COLUMNS[table];
    if (!cols) throw new Error(`Unknown table: ${table}`);
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(row)) {
      if (!cols.includes(k) || v === undefined) continue;
      out[k] = this.encodeValue(table, k, v);
    }
    if (cols.includes('id') && out.id == null && !(D1_AUTO_ID_TABLES as readonly string[]).includes(table)) out.id = uuid();
    if (cols.includes('created_at') && out.created_at == null) out.created_at = iso();
    if (cols.includes('updated_at') && out.updated_at == null) out.updated_at = iso();
    return out;
  }
  private decode(table: string, row: any): any {
    if (!row) return row;
    const out: any = { ...row };
    for (const c of D1_JSON_COLUMNS[table] || []) {
      if (typeof out[c] === 'string' && out[c] !== '') { try { out[c] = JSON.parse(out[c]); } catch { /* leave as text */ } }
    }
    for (const c of D1_ARRAY_COLUMNS[table] || []) {
      if (typeof out[c] === 'string' && out[c] !== '') { try { out[c] = JSON.parse(out[c]); } catch { out[c] = []; } }
    }
    for (const c of D1_BOOL_COLUMNS[table] || []) {
      if (out[c] !== null && out[c] !== undefined) out[c] = out[c] === 1 || out[c] === true || out[c] === '1';
    }
    return out;
  }
  private where(o: SelectOpts) {
    const clauses: string[] = []; const params: any[] = [];
    const eq: Record<string, unknown> = o.eq || {};
    for (const [k, v] of Object.entries(eq)) {
      ident(k);
      if (v === null) clauses.push(`${k} is null`);
      else { clauses.push(`${k} = ?`); params.push(v); }
    }
    const s = o as SelectOpts;
    for (const [k, v] of Object.entries(s.neq || {})) { clauses.push(`${ident(k)} <> ?`); params.push(v); }
    for (const [k, v] of Object.entries(s.gt || {})) { clauses.push(`${ident(k)} > ?`); params.push(v); }
    for (const [k, v] of Object.entries(s.gte || {})) { clauses.push(`${ident(k)} >= ?`); params.push(v); }
    for (const [k, v] of Object.entries(s.lt || {})) { clauses.push(`${ident(k)} < ?`); params.push(v); }
    for (const [k, v] of Object.entries(s.lte || {})) { clauses.push(`${ident(k)} <= ?`); params.push(v); }
    for (const [k, list] of Object.entries(s.in || {})) {
      if (!list.length) { clauses.push('1 = 0'); continue; }
      clauses.push(`${ident(k)} in (${list.map(() => '?').join(',')})`); params.push(...list);
    }
    for (const [k, v] of Object.entries(s.like || {})) { clauses.push(`${ident(k)} like ?`); params.push(`%${v}%`); }
    for (const k of s.isNull || []) clauses.push(`${ident(k)} is null`);
    for (const k of s.notNull || []) clauses.push(`${ident(k)} is not null`);
    return { sql: clauses.length ? ` where ${clauses.join(' and ')}` : '', params };
  }

  // -------------------------------------------------------------------------
  // DataClient
  // -------------------------------------------------------------------------
  async select<T = any>(table: string, o: SelectOpts = {}): Promise<T[]> {
    const { sql, params } = this.where({ ...o, eq: o.eq || {} });
    let q = `select ${o.columns && /^[a-z_*, ]+$/i.test(o.columns) ? o.columns : '*'} from ${ident(table)}${sql}`;
    if (o.order) q += ` order by ${ident(o.order.column)} ${o.order.ascending === false ? 'desc' : 'asc'}`;
    if (o.limit) q += ` limit ${Number(o.limit)}`;
    const rows = await this.query<any>(q, params);
    return rows.map((r) => this.decode(table, r)) as T[];
  }
  async insert<T = any>(table: string, row: any): Promise<T[]> {
    const rows = Array.isArray(row) ? row : [row];
    const out: T[] = [];
    for (const r of rows) {
      const e = this.encode(table, r);
      const keys = Object.keys(e);
      if (!keys.length) continue;
      const sql = `insert or replace into ${ident(table)} (${keys.join(',')}) values (${keys.map(() => '?').join(',')})`;
      await this.run(sql, keys.map((k) => e[k]));
      out.push(this.decode(table, e) as T);
    }
    return out;
  }
  async upsert<T = any>(table: string, row: any): Promise<T[]> { return this.insert<T>(table, row); }
  async update<T = any>(table: string, match: Record<string, unknown>, patch: Record<string, unknown>): Promise<T[]> {
    const w = this.where({ eq: match });
    const e = this.encode(table, patch);
    delete e.id; delete e.created_at;
    if (D1_COLUMNS[table]?.includes('updated_at')) e.updated_at = iso();
    const keys = Object.keys(e);
    if (!keys.length) return this.select<T>(table, { eq: match });
    await this.run(`update ${ident(table)} set ${keys.map((k) => `${k} = ?`).join(',')}${w.sql}`,
      [...keys.map((k) => e[k]), ...w.params]);
    return this.select<T>(table, { eq: match });
  }
  async remove(table: string, match: Record<string, unknown>): Promise<void> {
    const w = this.where({ eq: match });
    await this.run(`delete from ${ident(table)}${w.sql}`, w.params);
  }
  async rpc<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return d1Rpc(this, name, args) as Promise<T>;
  }
  /** Portable SQL escape hatch used by the auth + secret helpers. */
  async raw<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    let q = sql.replace(/public\./gi, '').replace(/auth\.users/gi, 'auth_users')
      .replace(/\$\d+(?:::[a-z_ ]+)?/gi, '?')
      .replace(/now\(\)/gi, `(${NOW_SQL})`);
    const rows = await this.query<any>(q, params);
    return rows as T[];
  }

  // -------------------------------------------------------------------------
  // Migrations, backups, provider switch
  // -------------------------------------------------------------------------
  async migrate(): Promise<{ applied: string[]; tables: number }> {
    const applied: string[] = [];
    for (const m of D1_MIGRATIONS) {
      const ready = await this.query<any>(`select name from sqlite_master where type='table' and name='_d1_migrations'`);
      const exists = ready.length
        ? await this.query<any>(`select name from _d1_migrations where name = ?`, [m.name]) : [];
      if (exists.length) continue;
      await this.db.exec(m.sql);
      await this.run(`insert or ignore into _d1_migrations (name) values (?)`, [m.name]);
      applied.push(m.name);
    }
    const tables = await this.scalar<number>(`select count(*) n from sqlite_master where type='table'`);
    return { applied, tables: Number(tables || 0) };
  }
  async health() {
    const tables = await this.scalar<number>(`select count(*) n from sqlite_master where type='table'`);
    const migrations = await this.scalar<number>(`select count(*) n from _d1_migrations`);
    return { connected: true, provider: 'd1', tables: Number(tables || 0), migrations: Number(migrations || 0) };
  }
  /** Logical backup: all application tables, portable to Supabase. */
  async backup() {
    const names = await this.query<{ name: string }>(`select name from sqlite_master where type='table' and name not like 'sqlite_%'`);
    const tables: Record<string, any[]> = {};
    for (const { name } of names) {
      if (!D1_COLUMNS[name]) continue;
      tables[name] = await this.select(name);
    }
    return { schema_version: 1, provider: 'd1', exported_at: iso(), tables };
  }
  /** Explicit, owner-confirmed import. Used only by the provider-switch flow. */
  async restore(backup: any, opts: { replace?: boolean } = {}) {
    if (backup?.schema_version !== 1 || !backup.tables) throw new Error('Unrecognised backup format');
    const order = [...D1_TABLES, 'auth_users', '_d1_migrations'];
    const stmts: any[] = [];
    if (opts.replace) for (const t of order) if (D1_COLUMNS[t]) stmts.push(this.db.prepare(`delete from ${t}`));
    for (const [table, rows] of Object.entries(backup.tables as Record<string, any[]>)) {
      if (!D1_COLUMNS[table]) continue;
      for (const r of rows) {
        const e = this.encode(table, r);
        const keys = Object.keys(e);
        stmts.push(this.db.prepare(
          `insert or replace into ${ident(table)} (${keys.join(',')}) values (${keys.map(() => '?').join(',')})`
        ).bind(...keys.map((k) => e[k])));
      }
    }
    if (stmts.length) await this.db.batch(stmts);
    return { imported_tables: Object.keys(backup.tables).length,
      imported_rows: Object.values(backup.tables as Record<string, any[]>).reduce((n, r) => n + r.length, 0) };
  }
}

// ===========================================================================
// Portable domain RPCs (the SQLite twin of supabase/migrations 0009-0015)
// ===========================================================================
const fail = (msg: string): never => { throw new Error(msg); };
const obj = (a: any): any => (a && typeof a === 'object' && !Array.isArray(a) ? a : {});
const num = (v: any) => (v === undefined || v === null || v === '' ? null : Number(v));

async function d1Rpc(a: D1Adapter, name: string, args: Record<string, unknown>): Promise<any> {
  const p = args as any;
  const now = iso();

  async function assertPermission(actor: string, tenant: string, permission: string) {
    const m = await a.one<any>('tenant_members', { tenant_id: tenant, profile_id: actor, status: 'active' });
    const t = await a.one<any>('tenants', { id: tenant });
    if (!m || !t || t.status !== 'active') fail('Permission denied: ' + permission);
    if (m.role_key === 'owner') return;
    const ov = await a.one<any>('member_permissions', { member_id: m.id, permission_key: permission });
    if (ov) { if (ov.effect !== 'allow') fail('Permission denied: ' + permission); return; }
    const roles = await a.select<any>('roles', { eq: { key: m.role_key } });
    const role = roles.find((r: any) => r.tenant_id === null || r.tenant_id === tenant);
    const rp = role ? await a.one<any>('role_permissions', { role_id: role.id, permission_key: permission }) : null;
    if (!rp) fail('Permission denied: ' + permission);
  }
  async function isPlatformAdmin(actor: string) {
    return !!(await a.one<any>('platform_admins', { profile_id: actor }));
  }
  async function audit(tenant: string | null, actor: string | null, action: string, entity: string,
    entityId: string | null, before: any = null, after: any = null, actorType = 'user') {
    const profile = actor ? await a.one<any>('profiles', { id: actor }) : null;
    await a.insert('audit_logs', {
      tenant_id: tenant, actor_id: actor, actor_email: profile?.email || null, actor_type: actorType,
      action, entity_type: entity, entity_id: entityId, before, after,
    });
  }
  async function permissionGranted(actor: string, tenant: string, permission: string) {
    try { await assertPermission(actor, tenant, permission); return true; } catch { return false; }
  }
  async function setting(key: string, fallback: any) {
    const s = await a.one<any>('platform_settings', { key });
    return s ? s.value : fallback;
  }
  function slugOf(name: string, supplied?: string) {
    if (supplied) return supplied;
    return `${String(name || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${uuid().slice(0, 8)}`;
  }
  async function seedBoardPins(boardId: string, tenantId: string, catalogBoardId: string | null) {
    if (!catalogBoardId) return;
    const pins = await a.select<any>('board_catalog_pins', { eq: { board_id: catalogBoardId } });
    for (const pin of pins) {
      const existing = await a.one<any>('board_pins', { tenant_id: tenantId, user_board_id: boardId, gpio: pin.gpio });
      if (existing) continue;
      await a.insert('board_pins', {
        tenant_id: tenantId, user_board_id: boardId, gpio: pin.gpio, header_label: pin.header_label,
        state: pin.restricted ? 'system' : (pin.exposed ? 'available' : 'system'),
        restricted: pin.restricted, boot_strapping: pin.boot_strapping, usb_jtag: pin.usb_jtag,
        flash_connected: pin.flash_connected, psram_connected: pin.psram_connected,
        input_only: pin.input_only, functions: pin.functions, adc_channels: pin.adc_channels, notes: pin.notes,
      });
    }
  }
  async function assignPin(tenant: string, board: string, gpio: number, ownerType: string,
    ownerId: string, fn: string, busId: string | null = null) {
    const pin = await a.one<any>('board_pins', { tenant_id: tenant, user_board_id: board, gpio });
    if (!pin) fail(`GPIO ${gpio} is not exposed on this board`);
    if (pin.restricted) fail(`GPIO ${gpio} is reserved by the hardware and cannot be assigned`);
    if (['output', 'pwm'].includes(fn) && pin.input_only) fail(`GPIO ${gpio} is input-only and cannot drive an output`);
    if (fn === 'adc' && !(pin.adc_channels || []).length) fail(`GPIO ${gpio} has no ADC channel on this board`);
    const taken = await a.one<any>('exclusive_allocations', { user_board_id: board, gpio });
    if (taken) fail(`GPIO ${gpio} is already allocated on this board`);
    await a.insert('exclusive_allocations', {
      tenant_id: tenant, user_board_id: board, gpio, owner_type: ownerType,
      owner_id: ownerId, function_kind: fn, bus_id: busId,
    });
    await a.update('board_pins', { user_board_id: board, gpio }, { state: 'assigned' });
  }
  async function releasePins(ownerType: string, ownerId: string) {
    const rows = await a.select<any>('exclusive_allocations', { eq: { owner_type: ownerType, owner_id: ownerId } });
    for (const r of rows) {
      await a.remove('exclusive_allocations', { id: r.id });
      const pin = await a.one<any>('board_pins', { user_board_id: r.user_board_id, gpio: r.gpio });
      if (pin && !pin.restricted) await a.update('board_pins', { id: pin.id }, { state: 'available' });
    }
    return rows.length;
  }
  async function buildConfig(boardId: string) {
    const devices = await a.select<any>('devices', { eq: { user_board_id: boardId }, isNull: ['deleted_at'] });
    const sensors = await a.select<any>('sensors', { eq: { user_board_id: boardId }, isNull: ['deleted_at'] });
    const buses = await a.select<any>('shared_buses', { eq: { user_board_id: boardId } });
    const automations = await a.select<any>('automations', { eq: { tenant_id: (await a.one<any>('user_boards', { id: boardId }))?.tenant_id } });
    return {
      schema_version: 1,
      devices: devices.map((d: any) => ({ id: d.id, slug: d.slug, name: d.name, type: d.device_type,
        output_gpio: d.output_gpio, interface: d.interface, interface_config: d.interface_config,
        active_low: d.active_low, initial_state: d.initial_state, pulse_ms: d.pulse_ms })),
      sensors: sensors.map((s: any) => ({ id: s.id, slug: s.slug, category: s.category, unit: s.unit,
        gpio: s.gpio, interface: s.interface, bus_id: s.bus_id, i2c_address: s.i2c_address,
        sampling_interval_s: s.sampling_interval_s, reporting_interval_s: s.reporting_interval_s,
        payload_path: s.payload_path, thresholds: s.thresholds })),
      buses: buses.map((b: any) => ({ id: b.id, label: b.label, kind: b.kind, sda_gpio: b.sda_gpio,
        scl_gpio: b.scl_gpio, mosi_gpio: b.mosi_gpio, miso_gpio: b.miso_gpio, sck_gpio: b.sck_gpio,
        tx_gpio: b.tx_gpio, rx_gpio: b.rx_gpio, frequency_hz: b.frequency_hz, config: b.config })),
      automations: automations.map((x: any) => ({ id: x.id, name: x.name, enabled: x.enabled,
        execution: x.execution, mode: x.mode, when: x.when_config, conditions: x.conditions,
        actions: x.actions, cooldown_s: x.cooldown_s })),
      safety: { command_ttl_seconds: await setting('security.command_ttl_seconds', 30),
        require_checksum: true, retained_commands: false },
    };
  }
  async function bumpConfig(boardId: string) {
    const board = await a.one<any>('user_boards', { id: boardId });
    if (!board) fail('Unknown board');
    const version = Number(board.config_version || 0) + 1;
    const config = { ...(await buildConfig(boardId)), config_version: version };
    await a.insert('device_configurations', {
      tenant_id: board.tenant_id, user_board_id: boardId, version, config,
      checksum: await simpleHash(JSON.stringify(config)), created_by: null,
    });
    await a.update('user_boards', { id: boardId }, { config_version: version, config_sync_status: 'pending' });
    return version;
  }
  async function simpleHash(text: string) {
    // FNV-1a 32-bit: deterministic, no Node crypto dependency in the edge bundle.
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  function topics(tenantId: string, deviceId: string) {
    return {
      command: `v1/tenants/${tenantId}/devices/${deviceId}/command`,
      config: `v1/tenants/${tenantId}/devices/${deviceId}/config`,
      state: `v1/tenants/${tenantId}/devices/${deviceId}/state`,
      telemetry: `v1/tenants/${tenantId}/devices/${deviceId}/telemetry`,
      availability: `v1/tenants/${tenantId}/devices/${deviceId}/availability`,
    };
  }
  async function incrementCounter(tenant: string, bucket: string, metric: string) {
    const cur = await a.one<any>('usage_counters', { tenant_id: tenant, bucket, metric });
    if (cur) await a.update('usage_counters', { tenant_id: tenant, bucket, metric }, { value: Number(cur.value || 0) + 1 });
    else await a.insert('usage_counters', { tenant_id: tenant, bucket, metric, value: 1 });
  }

  switch (name) {
    // ----- identity / context -------------------------------------------------
    case 'rpc_context': {
      const actor = String(p.p_actor);
      const members = await a.select<any>('tenant_members', { eq: { profile_id: actor, status: 'active' } });
      const active = [];
      for (const m of members) {
        const t = await a.one<any>('tenants', { id: m.tenant_id });
        if (t && t.status === 'active') active.push({ m, t });
      }
      active.sort((x, y) => (x.m.role_key === 'owner' ? 0 : 1) - (y.m.role_key === 'owner' ? 0 : 1));
      const platform_admin = await isPlatformAdmin(actor);
      if (!active.length) return { tenant: null, platform_admin };
      const chosen = active[0];
      if (!chosen) throw new Error('No active workspace');
      const { m, t } = chosen;
      const perms = [];
      for (const perm of await a.select<any>('permissions', { order: { column: 'sort_order' } })) {
        if (await permissionGranted(actor, t.id, perm.key)) perms.push(perm.key);
      }
      return {
        tenant: t, member: m, role: m.role_key, permissions: perms,
        overrides: await a.select<any>('member_permissions', { eq: { member_id: m.id } }),
        access_rules: await a.select<any>('member_access_rules', { eq: { member_id: m.id } }),
        platform_admin,
      };
    }
    case 'rpc_check_permission': return { allowed: await permissionGranted(String(p.p_actor), String(p.p_tenant), String(p.p_permission)) };
    case 'rpc_owner_overview': {
      const day = new Date(Date.now() - 86400000).toISOString();
      return {
        accounts: await a.count('tenants'),
        active_accounts: await a.count('tenants', { status: 'active' }),
        suspended_accounts: await a.count('tenants', { status: 'suspended' }),
        boards: await a.count('user_boards', { deleted_at: null }),
        boards_online: await a.count('user_boards', { status: 'online' }),
        boards_offline: await a.count('user_boards', { status: 'offline' }),
        devices: await a.count('devices', { deleted_at: null }),
        sensors: await a.count('sensors', { deleted_at: null }),
        rooms: await a.count('rooms', { archived_at: null }),
        staff: await a.count('tenant_members', { status: 'active' }),
        commands_24h: (await a.select<any>('device_commands', { gte: { created_at: day } })).length,
        telemetry_24h: (await a.select<any>('sensor_readings', { gte: { received_at: day } })).length,
      };
    }
    case 'rpc_tenant_overview': {
      const tenant = String(p.p_tenant), day = new Date(Date.now() - 86400000).toISOString();
      const by = (t: string, extra: Record<string, unknown> = {}) => a.count(t, { tenant_id: tenant, ...extra });
      return {
        rooms: await by('rooms', { archived_at: null }), boards: await by('user_boards', { deleted_at: null }),
        boards_online: await by('user_boards', { deleted_at: null, status: 'online' }),
        devices: await by('devices', { deleted_at: null }),
        devices_on: await by('devices', { deleted_at: null, reported_state: 'on' }),
        sensors: await by('sensors', { deleted_at: null }), automations: await by('automations', { enabled: true }),
        staff: await by('tenant_members', { status: 'active' }),
        commands_24h: (await a.select<any>('device_commands', { eq: { tenant_id: tenant }, gte: { created_at: day } })).length,
        readings_24h: (await a.select<any>('sensor_readings', { eq: { tenant_id: tenant }, gte: { received_at: day } })).length,
        pending_commands: (await a.select<any>('device_commands', { eq: { tenant_id: tenant }, in: { status: ['queued', 'published'] } })).length,
      };
    }

    // ----- rooms -------------------------------------------------------------
    case 'rpc_create_room': {
      await assertPermission(p.p_actor, p.p_tenant, 'rooms.manage');
      const d = obj(p.p_data);
      const [row] = await a.insert<any>('rooms', {
        tenant_id: p.p_tenant, name: d.name, icon: d.icon ?? 'home', color: d.color,
        image_url: d.image_url, floor: d.floor, description: d.description, sort_order: num(d.sort_order) ?? 0,
      });
      await audit(p.p_tenant, p.p_actor, 'room.create', 'room', row.id, null, d);
      return { id: row.id };
    }
    case 'rpc_update_room': {
      await assertPermission(p.p_actor, p.p_tenant, 'rooms.manage');
      const d = obj(p.p_data);
      const before = await a.one<any>('rooms', { id: p.p_room, tenant_id: p.p_tenant }) || fail('Room not found');
      const patch: any = {};
      for (const k of ['name', 'icon', 'color', 'image_url', 'floor', 'description']) if (d[k] !== undefined) patch[k] = d[k];
      if ('archived' in d) patch.archived_at = d.archived ? now : null;
      await a.update('rooms', { id: p.p_room, tenant_id: p.p_tenant }, patch);
      await audit(p.p_tenant, p.p_actor, 'room.update', 'room', String(p.p_room), before, d);
      return { id: p.p_room };
    }
    case 'rpc_delete_room': {
      await assertPermission(p.p_actor, p.p_tenant, 'rooms.manage');
      const strategy = String(p.p_strategy || 'unassign');
      if (!['unassign', 'delete_devices', 'archive_only'].includes(strategy)) fail('strategy must be unassign, delete_devices or archive_only');
      const room = await a.one<any>('rooms', { id: p.p_room, tenant_id: p.p_tenant }) || fail('Room not found');
      const devices = await a.select<any>('devices', { eq: { room_id: p.p_room, tenant_id: p.p_tenant }, isNull: ['deleted_at'] });
      if (strategy === 'archive_only') {
        await a.update('rooms', { id: p.p_room }, { archived_at: now });
        return { archived: true, devices_affected: devices.length };
      }
      if (strategy === 'delete_devices') for (const d of devices) await d1Rpc(a, 'rpc_delete_device', { p_actor: p.p_actor, p_tenant: p.p_tenant, p_device: d.id });
      await a.run(`update sensors set room_id = null where room_id = ? and tenant_id = ?`, [p.p_room, p.p_tenant]);
      if (strategy !== 'delete_devices') await a.run(`update devices set room_id = null where room_id = ? and tenant_id = ?`, [p.p_room, p.p_tenant]);
      await a.remove('rooms', { id: p.p_room, tenant_id: p.p_tenant });
      await audit(p.p_tenant, p.p_actor, 'room.delete', 'room', String(p.p_room), { strategy, devices: devices.length }, null);
      void room;
      return { deleted: true, devices_affected: devices.length };
    }

    // ----- boards, pairing, credentials --------------------------------------
    case 'rpc_create_pairing_token': {
      await assertPermission(p.p_actor, p.p_tenant, 'devices.manage');
      const d = obj(p.p_data);
      const ttl = Number(await setting('registration.pairing_ttl_seconds', 900)) || 900;
      const [row] = await a.insert<any>('device_pairing_tokens', {
        tenant_id: p.p_tenant, user_board_id: d.user_board_id || null, token_hash: d.token_hash,
        board_name: d.board_name || null, catalog_board_id: d.catalog_board_id || null,
        created_by: p.p_actor, expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
      });
      await audit(p.p_tenant, p.p_actor, 'pairing.create', 'pairing_token', row.id, null,
        { board: d.user_board_id, ttl_seconds: ttl });
      return { id: row.id, expires_in_seconds: ttl };
    }
    case 'rpc_claim_pairing_token': {
      const tok = await a.one<any>('device_pairing_tokens', { token_hash: p.p_token_hash }) || fail('Invalid pairing token');
      if (tok.consumed_at || new Date(tok.expires_at).getTime() < Date.now()) fail('Pairing token expired or already used');
      const boardId = tok.user_board_id || uuid();
      let board = await a.one<any>('user_boards', { id: boardId });
      if (!board) {
        const [created] = await a.insert<any>('user_boards', {
          id: boardId, tenant_id: tok.tenant_id, catalog_board_id: tok.catalog_board_id,
          name: tok.board_name || 'Controller', device_id: String(p.p_device_id),
          mqtt_client_id: String(p.p_client_id), status: 'provisioning', created_by: tok.created_by,
          provisioned_at: now, config_version: 0, applied_config_version: 0,
        });
        board = created;
        await seedBoardPins(boardId, tok.tenant_id, tok.catalog_board_id);
      } else {
        await a.update('user_boards', { id: boardId }, { device_id: p.p_device_id, mqtt_client_id: p.p_client_id, status: 'provisioning', provisioned_at: now });
      }
      await a.remove('mqtt_credentials_metadata', { user_board_id: boardId });
      const [cred] = await a.insert<any>('mqtt_credentials_metadata', {
        tenant_id: tok.tenant_id, user_board_id: boardId, username: p.p_username,
        password_hash: p.p_password_hash, provider_ref: p.p_provider_ref || {}, status: 'active',
      });
      await a.update('device_pairing_tokens', { id: tok.id }, { consumed_at: now });
      await bumpConfig(boardId);
      await audit(tok.tenant_id, null, 'pairing.claim', 'board', boardId, null,
        { device_id: p.p_device_id, catalog_board_id: tok.catalog_board_id }, 'device');
      return { board_id: boardId, tenant_id: tok.tenant_id, device_id: p.p_device_id,
        client_id: p.p_client_id, username: p.p_username, credential_id: cred.id };
    }
    case 'rpc_rotate_device_credentials': {
      await assertPermission(p.p_actor, p.p_tenant, 'devices.manage');
      const board = await a.one<any>('user_boards', { id: p.p_board, tenant_id: p.p_tenant }) || fail('Controller board not found');
      await a.update('mqtt_credentials_metadata', { user_board_id: board.id, status: 'active' },
        { status: 'rotated', rotated_at: now });
      await audit(p.p_tenant, p.p_actor, 'device.credentials.rotate', 'board', board.id);
      void p.p_password_hash; void p.p_provider_ref;
      return { rotated: true };
    }
    case 'rpc_unregister_board': {
      await assertPermission(p.p_actor, p.p_tenant, 'devices.manage');
      const board = await a.one<any>('user_boards', { id: p.p_board, tenant_id: p.p_tenant }) || fail('Controller board not found');
      if (String(p.p_confirm) !== board.device_id) fail('Confirm with the exact device id');
      await a.update('user_boards', { id: board.id }, { status: 'unclaimed', provisioned_at: null });
      await a.update('mqtt_credentials_metadata', { user_board_id: board.id, status: 'active' },
        { status: 'revoked', revoked_at: now });
      await audit(p.p_tenant, p.p_actor, 'board.unregister', 'board', board.id, null, { device_id: board.device_id });
      return { unclaimed: true, device_id: board.device_id };
    }
    case 'rpc_board_from_client': {
      const boards = await a.select<any>('user_boards', { eq: { mqtt_client_id: p.p_client_id }, isNull: ['deleted_at'] });
      const board = boards.find((b: any) => b.status !== 'disabled');
      if (!board) return null;
      const cred = await a.one<any>('mqtt_credentials_metadata', { user_board_id: board.id, status: 'active' });
      if (!cred) return null;
      return {
        board_id: board.id, tenant_id: board.tenant_id, device_id: board.device_id,
        credential_id: cred.id, username: cred.username, password_hash: cred.password_hash,
        credential_status: cred.status, board_status: board.status,
        topics: topics(board.tenant_id, board.device_id),
      };
    }
    case 'rpc_board_from_device': {
      const boards = await a.select<any>('user_boards', { eq: { tenant_id: p.p_tenant, device_id: p.p_device_id }, isNull: ['deleted_at'] });
      const board = boards.find((b: any) => b.status !== 'disabled');
      if (!board) return null;
      return {
        board_id: board.id, tenant_id: board.tenant_id, device_id: board.device_id,
        board_status: board.status, topics: topics(board.tenant_id, board.device_id),
      };
    }

    // ----- buses -------------------------------------------------------------
    case 'rpc_create_bus': {
      await assertPermission(p.p_actor, p.p_tenant, 'devices.manage');
      const d = obj(p.p_data);
      if (!await a.one<any>('user_boards', { id: d.user_board_id, tenant_id: p.p_tenant })) fail('Board not found in this workspace');
      if (!['i2c', 'spi', 'uart', 'onewire'].includes(d.kind)) fail('Invalid bus kind');
      const pinKeys = ['sda_gpio', 'scl_gpio', 'mosi_gpio', 'miso_gpio', 'sck_gpio', 'tx_gpio', 'rx_gpio'];
      const pins = pinKeys.map((k) => num(d[k])).filter((v) => v !== null) as number[];
      if (!pins.length) fail('A bus requires at least one pin');
      const [bus] = await a.insert<any>('shared_buses', {
        tenant_id: p.p_tenant, user_board_id: d.user_board_id, kind: d.kind, label: d.label,
        ...Object.fromEntries(pinKeys.map((k) => [k, num(d[k])])),
        frequency_hz: num(d.frequency_hz), config: d.config || {},
      });
      for (const gpio of pins) {
        await assignPin(p.p_tenant, d.user_board_id, gpio, 'bus', bus.id,
          d.kind === 'i2c' ? 'i2c' : d.kind === 'spi' ? 'spi' : 'uart', bus.id);
      }
      await bumpConfig(d.user_board_id);
      await audit(p.p_tenant, p.p_actor, 'bus.create', 'shared_bus', bus.id, null, d);
      return { id: bus.id };
    }
    case 'rpc_delete_bus': {
      await assertPermission(p.p_actor, p.p_tenant, 'devices.manage');
      const bus = await a.one<any>('shared_buses', { id: p.p_bus, tenant_id: p.p_tenant }) || fail('Bus not found');
      const used = await a.count('sensors', { bus_id: p.p_bus, deleted_at: null });
      if (used) fail(`Cannot delete a bus with ${used} attached sensor(s)`);
      await a.remove('exclusive_allocations', { bus_id: p.p_bus });
      await a.remove('shared_buses', { id: p.p_bus });
      const pins = await a.select<any>('board_pins', { eq: { user_board_id: bus.user_board_id } });
      for (const pin of pins) {
        const alloc = await a.one<any>('exclusive_allocations', { user_board_id: bus.user_board_id, gpio: pin.gpio });
        if (!pin.restricted) await a.update('board_pins', { id: pin.id }, { state: alloc ? 'assigned' : 'available' });
      }
      await bumpConfig(bus.user_board_id);
      await audit(p.p_tenant, p.p_actor, 'bus.delete', 'shared_bus', String(p.p_bus));
      return { deleted: true };
    }

    // ----- devices / sensors -------------------------------------------------
    case 'rpc_create_device': {
      await assertPermission(p.p_actor, p.p_tenant, 'devices.manage');
      const d = obj(p.p_data);
      if (!await a.one<any>('user_boards', { id: d.user_board_id, tenant_id: p.p_tenant, deleted_at: null })) fail('Controller board not found in this workspace');
      if (d.room_id && !await a.one<any>('rooms', { id: d.room_id, tenant_id: p.p_tenant })) fail('Room not found in this workspace');
      const slug = slugOf(d.name, d.slug);
      const [row] = await a.insert<any>('devices', {
        tenant_id: p.p_tenant, room_id: d.room_id || null, user_board_id: d.user_board_id,
        name: d.name, slug, device_type: d.device_type ?? 'relay', icon: d.icon ?? 'power',
        output_gpio: num(d.output_gpio), interface: d.interface ?? 'gpio',
        interface_config: d.interface_config ?? {}, active_low: d.active_low ?? false,
        initial_state: d.initial_state ?? 'off', pulse_ms: num(d.pulse_ms),
        physical_input_gpio: num(d.physical_input_gpio), power_rating_w: num(d.power_rating_w),
        metering: d.metering ?? {}, automation_enabled: d.automation_enabled ?? true,
        reported_state: 'unknown', created_by: p.p_actor,
      });
      const fn = d.interface === 'pwm' ? 'pwm' : 'output';
      if (num(d.output_gpio) !== null) await assignPin(p.p_tenant, d.user_board_id, Number(d.output_gpio), 'device', row.id, fn);
      if (num(d.physical_input_gpio) !== null) await assignPin(p.p_tenant, d.user_board_id, Number(d.physical_input_gpio), 'device', row.id, 'input');
      const version = await bumpConfig(d.user_board_id);
      await audit(p.p_tenant, p.p_actor, 'device.create', 'device', row.id, null, d);
      return { id: row.id, slug, config_version: version };
    }
    case 'rpc_update_device': {
      await assertPermission(p.p_actor, p.p_tenant, 'devices.manage');
      const d = obj(p.p_data);
      const before = await a.one<any>('devices', { id: p.p_device, tenant_id: p.p_tenant, deleted_at: null }) || fail('Device not found');
      const gpio = 'output_gpio' in d ? num(d.output_gpio) : before.output_gpio;
      if (gpio !== before.output_gpio) {
        await releasePins('device', String(p.p_device));
        if (gpio !== null) await assignPin(p.p_tenant, before.user_board_id, Number(gpio), 'device', String(p.p_device),
          (d.interface ?? before.interface) === 'pwm' ? 'pwm' : 'output');
      }
      const patch: any = {};
      for (const k of ['name', 'icon', 'device_type', 'interface', 'initial_state', 'automation_enabled', 'active_low']) if (d[k] !== undefined) patch[k] = d[k];
      for (const k of ['output_gpio', 'pulse_ms', 'power_rating_w']) if (k in d) patch[k] = num(d[k]);
      if ('room_id' in d) patch.room_id = d.room_id;
      await a.update('devices', { id: p.p_device, tenant_id: p.p_tenant }, patch);
      const version = await bumpConfig(before.user_board_id);
      await audit(p.p_tenant, p.p_actor, 'device.update', 'device', String(p.p_device), before, d);
      return { id: p.p_device, config_version: version };
    }
    case 'rpc_delete_device': {
      await assertPermission(p.p_actor, p.p_tenant, 'devices.manage');
      const d = await a.one<any>('devices', { id: p.p_device, tenant_id: p.p_tenant, deleted_at: null }) || fail('Device not found');
      await a.update('devices', { id: p.p_device }, { deleted_at: now });
      await releasePins('device', String(p.p_device));
      const version = await bumpConfig(d.user_board_id);
      await audit(p.p_tenant, p.p_actor, 'device.delete', 'device', String(p.p_device), d, null);
      return { deleted: true, config_version: version };
    }
    case 'rpc_restore_device': {
      await assertPermission(p.p_actor, p.p_tenant, 'devices.manage');
      const d = await a.one<any>('devices', { id: p.p_device, tenant_id: p.p_tenant }) || fail('Device not found');
      await a.update('devices', { id: p.p_device }, { deleted_at: null });
      const version = await bumpConfig(d.user_board_id);
      await audit(p.p_tenant, p.p_actor, 'device.restore', 'device', String(p.p_device));
      return { restored: true, config_version: version };
    }
    case 'rpc_create_sensor': {
      await assertPermission(p.p_actor, p.p_tenant, 'devices.manage');
      const d = obj(p.p_data);
      if (!await a.one<any>('user_boards', { id: d.user_board_id, tenant_id: p.p_tenant, deleted_at: null })) fail('Controller board not found in this workspace');
      if (d.room_id && !await a.one<any>('rooms', { id: d.room_id, tenant_id: p.p_tenant })) fail('Room not found in this workspace');
      if (d.bus_id && !await a.one<any>('shared_buses', { id: d.bus_id, user_board_id: d.user_board_id, tenant_id: p.p_tenant })) fail('Bus does not belong to this board');
      const gpio = num(d.gpio);
      if (!d.bus_id && gpio === null && d.interface !== 'virtual') fail('A GPIO or a shared bus is required');
      const slug = slugOf(d.name, d.slug);
      const [row] = await a.insert<any>('sensors', {
        tenant_id: p.p_tenant, room_id: d.room_id || null, user_board_id: d.user_board_id,
        name: d.name, slug, category: d.category ?? 'custom', sensor_model: d.sensor_model,
        interface: d.interface ?? 'gpio', gpio, bus_id: d.bus_id || null, i2c_address: d.i2c_address,
        unit: d.unit ?? 'celsius', decimals: num(d.decimals) ?? 1, min_valid: num(d.min_valid), max_valid: num(d.max_valid),
        sampling_interval_s: num(d.sampling_interval_s) ?? 60, reporting_interval_s: num(d.reporting_interval_s) ?? 60,
        report_on_change: d.report_on_change ?? true, delta_threshold: num(d.delta_threshold),
        thresholds: d.thresholds ?? {}, topic_suffix: d.topic_suffix,
        payload_path: d.payload_path ?? `sensors.${slug}.value`, transform: d.transform ?? {},
        last_status: 'unknown', enabled: true, created_by: p.p_actor,
      });
      if (!d.bus_id && gpio !== null && d.interface !== 'virtual') {
        await assignPin(p.p_tenant, d.user_board_id, Number(gpio), 'sensor', row.id, d.interface === 'adc' ? 'adc' : 'input');
      }
      const version = await bumpConfig(d.user_board_id);
      await audit(p.p_tenant, p.p_actor, 'sensor.create', 'sensor', row.id, null, d);
      return { id: row.id, slug, config_version: version };
    }
    case 'rpc_delete_sensor': {
      await assertPermission(p.p_actor, p.p_tenant, 'devices.manage');
      const s = await a.one<any>('sensors', { id: p.p_sensor, tenant_id: p.p_tenant, deleted_at: null }) || fail('Sensor not found');
      await a.update('sensors', { id: p.p_sensor }, { deleted_at: now });
      await releasePins('sensor', String(p.p_sensor));
      const version = await bumpConfig(s.user_board_id);
      await audit(p.p_tenant, p.p_actor, 'sensor.delete', 'sensor', String(p.p_sensor));
      return { deleted: true, config_version: version };
    }

    // ----- commands / ingest -------------------------------------------------
    case 'rpc_issue_command': {
      await assertPermission(p.p_actor, p.p_tenant, 'devices.control');
      if (!await a.one<any>('user_boards', { id: p.p_board, tenant_id: p.p_tenant, deleted_at: null })) fail('Board not found in this workspace');
      if (p.p_component_id && !await a.one<any>('devices', { id: p.p_component_id, tenant_id: p.p_tenant, user_board_id: p.p_board, deleted_at: null })) fail('Device not found on this board');
      const d = obj(p.p_data);
      const key = d.idempotency_key || null;
      if (key) {
        const since = new Date(Date.now() - 300000).toISOString();
        const prior = await a.select<any>('device_commands', { eq: { tenant_id: p.p_tenant, idempotency_key: key }, gte: { created_at: since } });
        if (prior.length) return { idempotent: true, command: prior[0] };
      }
      const minute = now.slice(0, 16) + ':00Z';
      await incrementCounter(p.p_tenant, minute, 'commands');
      const used = await a.one<any>('usage_counters', { tenant_id: p.p_tenant, bucket: minute, metric: 'commands' });
      const limit = Number(await setting('security.cmd_rate_limit_per_minute', 60)) || 60;
      if (Number(used?.value || 0) > limit) fail('Command rate limit exceeded');
      const ttl = Number(await setting('security.command_ttl_seconds', 30)) || 30;
      const [cmd] = await a.insert<any>('device_commands', {
        tenant_id: p.p_tenant, user_board_id: p.p_board, component_type: d.component_type ?? 'device',
        component_id: p.p_component_id, action: d.action, payload: d.payload ?? {},
        actor_id: p.p_actor, idempotency_key: key, status: 'queued',
        expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
      });
      await audit(p.p_tenant, p.p_actor, 'device.command', 'command', cmd.id, null, d);
      return { idempotent: false, command: cmd };
    }
    case 'rpc_mark_command_published': {
      const cmd = await a.one<any>('device_commands', { id: p.p_command, status: 'queued' });
      if (cmd) await a.update('device_commands', { id: p.p_command }, {
        status: 'published', published_at: now, payload: { ...(cmd.payload || {}), topic: p.p_topic },
      });
      return { published: true };
    }
    case 'rpc_expire_commands': {
      const stale = await a.select<any>('device_commands', { in: { status: ['queued', 'published'] }, lt: { expires_at: now } });
      for (const c of stale) {
        await a.update('device_commands', { id: c.id }, { status: 'expired', error: 'No acknowledgement before expiry' });
        await a.run(`update devices set requested_state = null where last_command_id = ? and requested_state is not null`, [c.id]);
      }
      return stale.length;
    }
    case 'rpc_ingest_telemetry': {
      const board = await a.one<any>('user_boards', { id: p.p_board, deleted_at: null }) || fail('Unknown board');
      const payload = obj(p.p_payload);
      if (Number(payload.schema_version ?? 0) !== 1) fail('Unsupported telemetry schema_version');
      const ts = payload.timestamp ? new Date(Number(payload.timestamp) * 1000).toISOString() : now;
      const cfgVersion = Number(payload.config_version ?? 0);
      const accepted: any[] = [], rejected: any[] = [];
      for (const [slug, item] of Object.entries(obj(payload.sensors))) {
        const sensor = await a.one<any>('sensors', {
          tenant_id: board.tenant_id, user_board_id: board.id, slug, deleted_at: null, enabled: true,
        });
        if (!sensor) { rejected.push({ field: slug, reason: 'unknown_sensor' }); continue; }
        const v = (item as any)?.value;
        if (v === null || v === undefined || !['number', 'string'].includes(typeof v)) { rejected.push({ field: slug, reason: 'invalid_value' }); continue; }
        const value = Number(v);
        const unit = (item as any).unit ?? sensor.unit;
        const status = (item as any).status ?? 'valid';
        if (unit !== sensor.unit || (sensor.min_valid !== null && value < sensor.min_valid)
          || (sensor.max_valid !== null && value > sensor.max_valid) || status === 'invalid' || Number.isNaN(value)) {
          rejected.push({ field: slug, reason: 'validation_failed' }); continue;
        }
        await a.insert('sensor_readings', {
          tenant_id: board.tenant_id, sensor_id: sensor.id, board_id: board.id, value, unit,
          status: ['valid', 'warning', 'stale'].includes(status) ? status : 'valid',
          recorded_at: ts, received_at: now, metadata: { config_version: cfgVersion },
        });
        await a.update('sensors', { id: sensor.id }, { last_value: value, last_value_at: now, last_status: 'valid' });
        accepted.push(slug);
      }
      await a.update('user_boards', { id: board.id }, {
        last_telemetry_at: now, last_seen_at: now, status: 'online',
        applied_config_version: Math.max(Number(board.applied_config_version || 0), cfgVersion),
      });
      await incrementCounter(board.tenant_id, now.slice(0, 13) + ':00:00Z', 'telemetry_messages');
      return { accepted: accepted.length, rejected, tenant_id: board.tenant_id };
    }
    case 'rpc_ingest_state': {
      const board = await a.one<any>('user_boards', { id: p.p_board, deleted_at: null }) || fail('Unknown board');
      const payload = obj(p.p_payload);
      await a.update('user_boards', { id: board.id }, {
        last_seen_at: now, status: payload.availability === 'offline' ? 'offline' : 'online',
      });
      if (payload.command_id) {
        const cmd = await a.one<any>('device_commands', {
          id: payload.command_id, tenant_id: board.tenant_id, user_board_id: board.id,
        });
        if (cmd && ['queued', 'published'].includes(cmd.status)) {
          const status = ['failed', 'rejected'].includes(payload.status) ? payload.status : 'acknowledged';
          await a.update('device_commands', { id: cmd.id }, { status, acknowledged_at: now, error: payload.error || null });
          const device = await a.one<any>('devices', { slug: payload.component_id, user_board_id: board.id, tenant_id: board.tenant_id, deleted_at: null });
          if (device) {
            const actual = payload.actual_state === true ? 'on' : payload.actual_state === false ? 'off' : 'unknown';
            await a.update('devices', { id: device.id }, {
              reported_state: actual, last_state_at: now, state_source: 'device',
              requested_state: payload.status === 'confirmed' ? null : device.requested_state,
              last_command_id: cmd.id,
            });
            await a.insert('switch_states', {
              tenant_id: board.tenant_id, device_id: device.id, command_id: cmd.id,
              requested: payload.requested_state || null, reported: actual, source: 'device',
              status: payload.status === 'failed' ? 'failed' : 'confirmed',
              latency_ms: Math.max(0, Date.now() - new Date(cmd.created_at).getTime()),
            });
          }
        }
      }
      for (const [slug, item] of Object.entries(obj(payload.devices))) {
        const device = await a.one<any>('devices', { slug, user_board_id: board.id, tenant_id: board.tenant_id, deleted_at: null });
        if (device) await a.update('devices', { id: device.id }, {
          reported_state: (item as any)?.state === 'on' ? 'on' : (item as any)?.state === 'off' ? 'off' : 'unknown',
          last_state_at: now, state_source: 'device',
        });
      }
      return { ok: true, tenant_id: board.tenant_id };
    }
    case 'rpc_ack_config': {
      const board = await a.one<any>('user_boards', { id: p.p_board, deleted_at: null }) || fail('Unknown board');
      const payload = obj(p.p_payload);
      const version = Number(payload.config_version ?? 0);
      const status = payload.status ?? 'applied';
      await a.update('user_boards', { id: board.id }, {
        applied_config_version: status === 'applied' ? Math.max(Number(board.applied_config_version || 0), version) : board.applied_config_version,
        config_sync_status: status === 'applied' ? 'synced' : 'failed',
        config_ack_at: now, last_seen_at: now, status: 'online',
      });
      await audit(board.tenant_id, null, 'config.ack', 'board', board.id, null, payload, 'device');
      return { ok: true, config_version: version, status };
    }

    // ----- automation / firmware --------------------------------------------
    case 'rpc_save_automation': {
      await assertPermission(p.p_actor, p.p_tenant, 'automation.manage');
      const d = obj(p.p_data);
      if (!Array.isArray(d.when) || !d.when.length) fail('Automation requires at least one WHEN trigger');
      if (!Array.isArray(d.then) || !d.then.length) fail('Automation requires at least one THEN action');
      let id = p.p_id || null, before = null;
      const fields = {
        tenant_id: p.p_tenant, name: d.name, description: d.description,
        enabled: d.enabled ?? true, execution: d.execution ?? 'cloud', mode: d.mode ?? 'single',
        when_config: d.when, conditions: d.conditions ?? [], actions: d.then,
        cooldown_s: num(d.cooldown_s) ?? 0,
      };
      if (!id) { const [r] = await a.insert<any>('automations', { ...fields, created_by: p.p_actor }); id = r.id; }
      else {
        before = await a.one<any>('automations', { id, tenant_id: p.p_tenant }) || fail('Automation not found');
        await a.update('automations', { id, tenant_id: p.p_tenant }, fields);
      }
      for (const b of await a.select<any>('user_boards', { eq: { tenant_id: p.p_tenant }, isNull: ['deleted_at'] })) await bumpConfig(b.id);
      await audit(p.p_tenant, p.p_actor, 'automation.save', 'automation', String(id), before, d);
      return { id };
    }
    case 'rpc_delete_automation': {
      await assertPermission(p.p_actor, p.p_tenant, 'automation.manage');
      await a.remove('automations', { id: p.p_id, tenant_id: p.p_tenant });
      await audit(p.p_tenant, p.p_actor, 'automation.delete', 'automation', String(p.p_id));
      return { deleted: true };
    }
    case 'rpc_evaluate_automations': {
      const event = obj(p.p_event), fired: any[] = [];
      for (const auto of await a.select<any>('automations', { eq: { tenant_id: p.p_tenant, enabled: true }, order: { column: 'created_at' } })) {
        if (!['cloud', 'hybrid'].includes(auto.execution)) continue;
        const triggers = Array.isArray(auto.when_config) ? auto.when_config : [];
        const allowed = triggers.some((t: any) =>
          (event.kind === 'manual_trigger' && event.automation_id === auto.id)
          || (t.kind === 'sensor_event' && (!t.sensor_id || t.sensor_id === event.sensor_id))
          || (t.kind === 'schedule' && event.kind === 'schedule')
          || (t.kind === 'device_state' && event.kind === 'device_state'));
        if (!allowed) continue;
        if (auto.last_run_at && Number(auto.cooldown_s || 0) > 0
          && new Date(auto.last_run_at).getTime() > Date.now() - Number(auto.cooldown_s) * 1000) continue;
        let pass = true;
        for (const cond of (Array.isArray(auto.conditions) ? auto.conditions : [])) {
          const sensor = await a.one<any>('sensors', { tenant_id: p.p_tenant, slug: cond.sensor_slug, deleted_at: null });
          const v = sensor?.last_value;
          if (!sensor || v === null || v === undefined) { pass = false; break; }
          const target = Number(cond.value);
          pass = pass && ((cond.op === 'gt' && v > target) || (cond.op === 'lt' && v < target)
            || (cond.op === 'gte' && v >= target) || (cond.op === 'lte' && v <= target)
            || (cond.op === 'eq' && v === target));
          if (!pass) break;
        }
        if (!pass) continue;
        for (const action of (Array.isArray(auto.actions) ? auto.actions : [])) fired.push({ automation_id: auto.id, action });
        await a.update('automations', { id: auto.id }, { last_run_at: now, last_result: 'success', run_count: Number(auto.run_count || 0) + 1 });
        await a.insert('automation_logs', {
          tenant_id: p.p_tenant, automation_id: auto.id, trigger_kind: event.kind || null,
          status: 'success', detail: event,
        });
      }
      return { actions: fired };
    }
    case 'rpc_create_firmware_release': {
      await assertPermission(p.p_actor, p.p_tenant, 'firmware.update');
      const d = obj(p.p_data);
      if (!d.r2_key || !d.sha256 || String(d.sha256).length !== 64) fail('r2_key and a 64-char SHA-256 digest are required');
      const status = d.status || (d.published ? 'published' : 'draft');
      const [row] = await a.insert<any>('firmware_releases', {
        tenant_id: p.p_tenant, version: d.version, channel: d.channel || 'stable',
        chip_family: d.chip_family || 'esp32', board_models: d.board_models || [],
        r2_key: d.r2_key, size_bytes: num(d.size_bytes), sha256: d.sha256,
        min_app_version: d.min_app_version, notes: d.notes,
        rollout_pct: num(d.rollout_pct) ?? 100, mandatory: d.mandatory ?? false,
        status, published_at: status === 'published' ? now : null, created_by: p.p_actor,
      });
      await audit(p.p_tenant, p.p_actor, 'firmware.publish', 'firmware_release', row.id, null, d);
      return { id: row.id };
    }
    case 'rpc_ota_progress': {
      const payload = obj(p.p_payload);
      const board = await a.one<any>('user_boards', { id: p.p_board }) || fail('Unknown board');
      const status = payload.status || 'downloading';
      const history = await a.select<any>('device_firmware_history', {
        eq: { user_board_id: board.id, tenant_id: board.tenant_id },
        order: { column: 'started_at', ascending: false }, limit: 1,
      });
      if (history.length) {
        const patch: any = { status, error: payload.error || null };
        if (payload.progress !== undefined) patch.progress = num(payload.progress);
        if (payload.bytes_done !== undefined) patch.bytes_done = num(payload.bytes_done);
        if (['success', 'failed', 'rolled_back'].includes(status)) patch.finished_at = now;
        await a.update('device_firmware_history', { id: history[0].id }, patch);
      }
      if (status === 'success' && payload.version) {
        await a.update('user_boards', { id: board.id }, { firmware_version: payload.version, last_seen_at: now });
      }
      return { ok: true };
    }

    // ----- staff / platform ops ----------------------------------------------
    case 'rpc_invite_staff': {
      await assertPermission(p.p_actor, p.p_tenant, 'staff.manage');
      const member = await a.one<any>('tenant_members', { tenant_id: p.p_tenant, profile_id: p.p_actor, status: 'active' });
      if (member?.role_key !== 'owner') fail('Only the workspace owner may invite staff');
      const d = obj(p.p_data), role = d.role_key ?? 'viewer';
      if (role === 'owner') fail('Cannot invite another owner');
      if (!(await a.select<any>('roles', { eq: { key: role } })).length) fail('Unknown role');
      const [row] = await a.insert<any>('staff_invitations', {
        tenant_id: p.p_tenant, email: String(d.email || '').toLowerCase(), role_key: role,
        token_hash: d.token_hash, invited_by: p.p_actor, message: d.message,
        expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      });
      await audit(p.p_tenant, p.p_actor, 'staff.invite', 'invitation', row.id, null, { email: d.email, role_key: role });
      return { id: row.id };
    }
    case 'rpc_update_member': {
      const actorMember = await a.one<any>('tenant_members', { tenant_id: p.p_tenant, profile_id: p.p_actor, status: 'active' });
      if (actorMember?.role_key !== 'owner') fail('Only the workspace owner may change staff permissions');
      const d = obj(p.p_data);
      const target = await a.one<any>('tenant_members', { id: p.p_member, tenant_id: p.p_tenant }) || fail('Member not found');
      if (target.profile_id === p.p_actor) fail('A member cannot change their own permissions');
      const patch: any = {};
      if ('role_key' in d) patch.role_key = d.role_key;
      if ('status' in d) patch.status = d.status;
      if (Object.keys(patch).length) await a.update('tenant_members', { id: p.p_member }, patch);
      if (Array.isArray(d.permissions)) {
        await a.remove('member_permissions', { member_id: p.p_member });
        for (const x of d.permissions) await a.insert('member_permissions', {
          tenant_id: p.p_tenant, member_id: p.p_member, permission_key: x.key, effect: x.effect, updated_by: p.p_actor,
        });
      }
      if (Array.isArray(d.access_rules)) {
        await a.remove('member_access_rules', { member_id: p.p_member });
        for (const x of d.access_rules) await a.insert('member_access_rules', {
          tenant_id: p.p_tenant, member_id: p.p_member, scope: x.scope, target_id: x.target_id, allowed: x.allowed,
        });
      }
      await audit(p.p_tenant, p.p_actor, 'staff.update', 'member', String(p.p_member), target, d);
      return { id: p.p_member };
    }
    case 'rpc_revoke_member': {
      const actorMember = await a.one<any>('tenant_members', { tenant_id: p.p_tenant, profile_id: p.p_actor, status: 'active' });
      if (actorMember?.role_key !== 'owner') fail('Only the workspace owner may revoke staff');
      await a.update('tenant_members', { id: p.p_member }, { status: 'revoked' });
      await a.remove('member_permissions', { member_id: p.p_member });
      await audit(p.p_tenant, p.p_actor, 'staff.revoke', 'member', String(p.p_member));
      return { revoked: true };
    }
    case 'rpc_set_tenant_status': {
      if (!await isPlatformAdmin(String(p.p_actor))) fail('Platform admin required');
      if (!['active', 'suspended', 'closed'].includes(String(p.p_status))) fail('Invalid status');
      await a.update('tenants', { id: p.p_tenant }, { status: p.p_status, suspended_reason: p.p_reason || null });
      await a.insert('audit_logs', {
        tenant_id: p.p_tenant, actor_id: p.p_actor, actor_type: 'platform_admin',
        action: 'platform.tenant.status', entity_type: 'tenant', entity_id: String(p.p_tenant),
        after: { status: p.p_status, reason: p.p_reason || null },
      });
      return { status: p.p_status };
    }
    case 'rpc_set_platform_setting': {
      if (!await isPlatformAdmin(String(p.p_actor))) fail('Platform admin required');
      const key = String(p.p_key);
      const existing = await a.one<any>('platform_settings', { key });
      if (existing) await a.update('platform_settings', { key }, { value: p.p_value, updated_by: p.p_actor });
      else await a.insert('platform_settings', { key, value: p.p_value, updated_by: p.p_actor, is_secret: false });
      await a.insert('audit_logs', {
        actor_id: p.p_actor, actor_type: 'platform_admin', action: 'platform.setting.update',
        entity_type: 'setting', entity_id: key,
        after: { key, value: /secret|token/i.test(key) ? '***' : p.p_value },
      });
      return { key };
    }
    case 'rpc_record_usage_snapshot': {
      if (!await isPlatformAdmin(String(p.p_actor))) fail('Platform admin required');
      const d = obj(p.p_data);
      if (!['provider_api', 'owner_manual', 'provider_dashboard'].includes(String(d.source))) fail('Invalid usage source');
      const existing = await a.one<any>('emqx_usage_snapshots', {
        period_start: d.period_start, granularity: d.granularity || 'day', source: d.source,
      });
      const row: any = {
        period_start: d.period_start, period_end: d.period_end,
        granularity: d.granularity || 'day', source: d.source,
        traffic_bytes: num(d.traffic_bytes), traffic_in_bytes: num(d.traffic_in_bytes),
        traffic_out_bytes: num(d.traffic_out_bytes), packets: num(d.packets),
        session_minutes: num(d.session_minutes), connections_peak: num(d.connections_peak),
        messages: num(d.messages), rule_actions: num(d.rule_actions),
        raw: d.raw ?? {}, recorded_by: p.p_actor,
      };
      let id: string;
      if (existing) { await a.update('emqx_usage_snapshots', { id: existing.id }, row); id = existing.id; }
      else { const [r] = await a.insert<any>('emqx_usage_snapshots', row); id = r.id; }
      await a.insert('audit_logs', {
        actor_id: p.p_actor, actor_type: 'platform_admin', action: 'platform.usage.record',
        entity_type: 'usage_snapshot', entity_id: id,
        after: { source: d.source, period_start: d.period_start },
      });
      return { id };
    }

    // ----- local user bootstrap (D1 auth adapter) ----------------------------
    case 'rpc_bootstrap_user': {
      const id = String(p.p_actor), email = String(p.p_email), meta = obj(p.p_meta);
      if (await a.one<any>('profiles', { id })) return { bootstrapped: true };
      const person = meta.full_name || email.split('@')[0];
      const localPart = email.split('@')[0] || 'home';
      const slug = `${localPart.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${id.replace(/-/g, '').slice(0, 8)}`;
      await a.insert('profiles', { id, email, full_name: person, timezone: 'UTC', locale: 'en' });
      const [tenant] = await a.insert<any>('tenants', {
        name: meta.home_name || `${person}'s Home`, slug, owner_profile_id: id, status: 'active',
        plan: 'free', timezone: meta.timezone || 'UTC', device_registration_enabled: true,
        max_boards: 10, max_devices: 100, feature_flags: {},
      });
      await a.insert('tenant_members', {
        tenant_id: tenant.id, profile_id: id, role_key: 'owner', status: 'active', joined_at: now,
      });
      return { bootstrapped: true, tenant_id: tenant.id };
    }
    default: fail(`Unknown D1 RPC: ${name}`);
  }
}
