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

/**
 * Legacy service-role JWTs are sent as both apikey and Bearer. New opaque
 * `sb_secret_...` keys are not JWTs: the Supabase gateway resolves them from
 * the apikey header, so sending them as a Bearer token would fail as bad_jwt.
 * Server-side only — these headers are never used in browser code.
 */
export function serviceRoleHeaders(key: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { apikey: key, ...extra };
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/** Cloudflare Pages Functions -> Supabase PostgREST with the service-role key. */
export class SupabaseRestAdapter implements DataClient {
  constructor(private env: Env) {}
  private get base() {
    if (!this.env.SUPABASE_URL) throw new Error('SUPABASE_URL not configured');
    return `${String(this.env.SUPABASE_URL).replace(/\/$/, '')}/rest/v1`;
  }
  private headers(extra: Record<string, string> = {}) {
    return serviceRoleHeaders(String(this.env.SUPABASE_SERVICE_ROLE_KEY || ''), {
      'Content-Type': 'application/json', ...extra,
    });
  }
  private async request(path: string, init: RequestInit): Promise<any> {
    const res = await fetch(`${this.base}${path}`, { ...init, headers: this.headers(init.headers as any) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${describeFailure(text)}`);
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
    // JSON.stringify drops properties whose value is undefined. PostgREST then
    // looks for a function overload with fewer parameters, does not find one
    // and answers 404, so an argument that is simply absent must still be sent
    // as null.
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) body[k] = v === undefined ? null : v;
    return this.request(`/rpc/${ident(name)}`, { method: 'POST', body: JSON.stringify(body) });
  }
}

function encodeValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return String(v);
  const s = String(v);
  return /[,()\\]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/**
 * Describes a failed request in a short form.
 *
 * The reply from the database gateway can be long, and the part that explains
 * the failure is at the end of it. Keeping the code and the message and
 * dropping the long detail makes the cause visible without hiding anything
 * important.
 */
function describeFailure(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const code = parsed.code ? String(parsed.code) : '';
      const message = parsed.message ? String(parsed.message) : '';
      const hint = parsed.hint ? String(parsed.hint) : '';
      const parts = [code, message, hint].filter(Boolean);
      if (parts.length) return parts.join(' | ');
    }
  } catch { /* the reply is not a structured body */ }
  return text.slice(0, 400);
}
