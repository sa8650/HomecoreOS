import type { DataClient } from '@homecoreos/core';
import type { Env } from '../env';

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

const IDENT = /^[a-z_][a-z0-9_.]*$/i;
function ident(s: string): string {
  if (!IDENT.test(s)) throw new Error(`Unsafe identifier: ${s}`);
  return s;
}

/** Cloudflare Pages Functions -> Supabase PostgREST with the service-role key (server only). */
export class SupabaseRestAdapter implements DataClient {
  constructor(private env: Env) {}
  private get base() {
    if (!this.env.SUPABASE_URL) throw new Error('SUPABASE_URL not configured');
    return `${this.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
  }
  private headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.env.SUPABASE_SERVICE_ROLE_KEY || '',
      Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY || ''}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }
  private async request(path: string, init: RequestInit): Promise<any> {
    const res = await fetch(`${this.base}${path}`, { ...init, headers: this.headers(init.headers as any) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
  }
  async select<T = any>(table: string, o: SelectOpts = {}): Promise<T[]> {
    const p = new URLSearchParams();
    p.set('select', o.columns || '*');
    for (const [k, v] of Object.entries(o.eq || {})) p.set(k, `eq.${encodeValue(v)}`);
    for (const [k, v] of Object.entries(o.neq || {})) p.set(k, `neq.${encodeValue(v)}`);
    for (const [k, v] of Object.entries(o.gt || {})) p.set(k, `gt.${encodeValue(v)}`);
    for (const [k, v] of Object.entries(o.gte || {})) p.set(k, `gte.${encodeValue(v)}`);
    for (const [k, v] of Object.entries(o.lt || {})) p.set(k, `lt.${encodeValue(v)}`);
    for (const [k, v] of Object.entries(o.lte || {})) p.set(k, `lte.${encodeValue(v)}`);
    for (const [k, list] of Object.entries(o.in || {})) p.set(k, `in.(${list.map(encodeValue).join(',')})`);
    for (const [k, v] of Object.entries(o.like || {})) p.set(k, `ilike.*${v}*`);
    for (const k of o.isNull || []) p.set(k, 'is.null');
    for (const k of o.notNull || []) p.set(k, 'not.is.null');
    if (o.order) p.set('order', `${o.order.column}.${o.order.ascending === false ? 'desc' : 'asc'}`);
    if (o.limit) p.set('limit', String(o.limit));
    return this.request(`/${ident(table)}?${p}`, { method: 'GET' });
  }
  async insert<T = any>(table: string, row: any): Promise<T[]> {
    return this.request(`/${ident(table)}`, {
      method: 'POST', body: JSON.stringify(Array.isArray(row) ? row : [row]),
      headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
    });
  }
  async upsert<T = any>(table: string, row: any): Promise<T[]> {
    return this.request(`/${ident(table)}`, {
      method: 'POST', body: JSON.stringify(Array.isArray(row) ? row : [row]),
      headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
    });
  }
  async update<T = any>(table: string, match: Record<string, unknown>, patch: Record<string, unknown>): Promise<T[]> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(match)) p.set(k, `eq.${encodeValue(v)}`);
    return this.request(`/${ident(table)}?${p}`, {
      method: 'PATCH', body: JSON.stringify(patch), headers: { Prefer: 'return=representation' },
    });
  }
  async remove(table: string, match: Record<string, unknown>): Promise<void> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(match)) p.set(k, `eq.${encodeValue(v)}`);
    await this.request(`/${ident(table)}?${p}`, { method: 'DELETE' });
  }
  async rpc<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.request(`/rpc/${ident(name)}`, { method: 'POST', body: JSON.stringify(args) });
  }
}

function encodeValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return String(v);
  const s = String(v);
  return /[,()\\]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** Local development / tests: real Postgres via PGlite with the same migrations. */
export class PGliteAdapter implements DataClient {
  constructor(private db: any) {}
  private buildWhere(o: SelectOpts): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, op: string, value: unknown) => {
      params.push(toPg(value));
      clauses.push(`${ident(col)} ${op} $${params.length}`);
    };
    for (const [k, v] of Object.entries(o.eq || {})) add(k, '=', v);
    for (const [k, v] of Object.entries(o.neq || {})) add(k, '<>', v);
    for (const [k, v] of Object.entries(o.gt || {})) add(k, '>', v);
    for (const [k, v] of Object.entries(o.gte || {})) add(k, '>=', v);
    for (const [k, v] of Object.entries(o.lt || {})) add(k, '<', v);
    for (const [k, v] of Object.entries(o.lte || {})) add(k, '<=', v);
    for (const [k, list] of Object.entries(o.in || {})) {
      if (!list.length) { clauses.push('false'); continue; }
      const marks = list.map((v) => { params.push(toPg(v)); return `$${params.length}`; }).join(',');
      clauses.push(`${ident(k)} in (${marks})`);
    }
    for (const [k, v] of Object.entries(o.like || {})) add(k, 'ilike', `%${v}%`);
    for (const k of o.isNull || []) clauses.push(`${ident(k)} is null`);
    for (const k of o.notNull || []) clauses.push(`${ident(k)} is not null`);
    return { sql: clauses.length ? ` where ${clauses.join(' and ')}` : '', params };
  }
  async select<T = any>(table: string, o: SelectOpts = {}): Promise<T[]> {
    const { sql, params } = this.buildWhere(o);
    let q = `select ${o.columns === '*' || !o.columns ? '*' : o.columns.split(',').map((c) => ident(c.trim())).join(',')} from public.${ident(table)}${sql}`;
    if (o.order) q += ` order by ${ident(o.order.column)} ${o.order.ascending === false ? 'desc' : 'asc'} nulls last`;
    if (o.limit) q += ` limit ${Number(o.limit)}`;
    return (await this.db.query(q, params)).rows as T[];
  }
  async insert<T = any>(table: string, row: any): Promise<T[]> {
    const rows = Array.isArray(row) ? row : [row];
    if (!rows.length) return [];
    const cols = Object.keys(rows[0]);
    const params: unknown[] = [];
    const values = rows.map((r) => {
      const marks = cols.map((c) => { params.push(toPg(r[c])); return `$${params.length}`; });
      return `(${marks.join(',')})`;
    });
    const q = `insert into public.${ident(table)} (${cols.map(ident).join(',')}) values ${values.join(',')} returning *`;
    return (await this.db.query(q, params)).rows as T[];
  }
  async upsert<T = any>(table: string, row: any, conflictKeys: string[] = ['key']): Promise<T[]> {
    const keys = Object.keys(row);
    const params = keys.map((k) => toPg(row[k]));
    const marks = keys.map((_, i) => `$${i + 1}`).join(',');
    const sets = keys.filter((k) => !conflictKeys.includes(k)).map((k) => `${ident(k)} = excluded.${ident(k)}`).join(',');
    const conflict = conflictKeys.map(ident).join(',');
    const tail = sets ? ` on conflict (${conflict}) do update set ${sets}` : ` on conflict (${conflict}) do nothing`;
    const q = `insert into public.${ident(table)} (${keys.map(ident).join(',')}) values (${marks})${tail} returning *`;
    return (await this.db.query(q, params)).rows as T[];
  }
  async update<T = any>(table: string, match: Record<string, unknown>, patch: Record<string, unknown>): Promise<T[]> {
    const { sql, params } = this.buildWhere({ eq: match });
    const sets: string[] = [];
    for (const [k, v] of Object.entries(patch)) { params.push(toPg(v)); sets.push(`${ident(k)} = $${params.length}`); }
    if (!sets.length) return [];
    const q = `update public.${ident(table)} set ${sets.join(',')}${sql} returning *`;
    return (await this.db.query(q, params)).rows as T[];
  }
  async remove(table: string, match: Record<string, unknown>): Promise<void> {
    const { sql, params } = this.buildWhere({ eq: match });
    await this.db.query(`delete from public.${ident(table)}${sql}`, params);
  }
  async rpc<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const keys = Object.keys(args);
    const meta = await this.db.query(
      `select pg_get_function_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname=$1 order by p.oid desc limit 1`, [name]);
    const declared = String(meta.rows[0]?.args || '').split(',').map((part) => {
      const decl = part.split(/\s+DEFAULT\s+/i)[0]!.trim();
      const m = decl.match(/\s([a-z_]+(?:\(\d+\))?)\s*$/i);
      return m ? m[1]!.trim() : 'text';
    });
    const casts = keys.map((_, i) => `$${i + 1}::${declared[i] || 'text'}`);
    const params = keys.map((k, i) => {
      const v = args[k];
      if (v === null || v === undefined) return null;
      return (declared[i] || '').includes('jsonb') ? JSON.stringify(v) : String(v);
    });
    const r = await this.db.query(`select public.${ident(name)}(${casts.join(',')}) as result`, params);
    const val = r.rows[0]?.result;
    return (typeof val === 'string' ? JSON.parse(val) : val) as T;
  }
  async raw<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.query(sql, params)).rows as T[];
  }
}

function toPg(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return `{${v.map((x) => String(x)).join(',')}}`;
  return v;
}
