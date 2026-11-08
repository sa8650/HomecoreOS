import type { DataClient, MqttProvider, AuthPort, ObjectStore } from '@homecoreos/core';
import type { Env } from '../env';
import { serviceRoleHeaders } from '../db/adapters';
import { signedPath } from '../storage/signed-url';
import { R2ObjectStore, createR2Store, r2Binding } from '../storage/r2';

/** Per-request/per-isolate runtime assembled at startup. */
export interface Runtime {
  env: Env;
  db: DataClient;
  auth: AuthPort;
  mqtt: MqttProvider;
  store: ObjectStore | null;
  r2: R2ObjectStore | null;
  storageBackend: 'r2' | 'supabase' | 'none';
  events: EventBus;
  emit: (tenantId: string, type: string, payload?: Record<string, unknown>) => void;
  /** Raw Cloudflare bindings, kept only for diagnostics. */
  bootstrap?: Env;
}

type Listener = (event: any) => void;

/** In-process SSE fan-out; browsers can additionally use Supabase Realtime. */
export class EventBus {
  private listeners = new Map<string, Set<Listener>>();
  subscribe(tenantId: string, fn: Listener): () => void {
    if (!this.listeners.has(tenantId)) this.listeners.set(tenantId, new Set());
    this.listeners.get(tenantId)!.add(fn);
    return () => this.listeners.get(tenantId)?.delete(fn);
  }
  publish(tenantId: string, event: any) {
    for (const fn of this.listeners.get(tenantId) || []) {
      try { fn(event); } catch { /* disconnected client */ }
    }
  }
  get size() { return [...this.listeners.values()].reduce((n, s) => n + s.size, 0); }
}

/**
 * Fallback firmware store: a private Supabase Storage bucket. Used only when
 * no native R2 bucket binding has been added in Cloudflare Pages.
 */
export class SupabaseObjectStore implements ObjectStore {
  private ready?: Promise<void>;
  constructor(
    private url: string,
    private key: string,
    private bucket = 'firmware',
    private publicBase = '',
    private secret = '',
  ) {}
  private get base() { return `${this.url.replace(/\/$/, '')}/storage/v1`; }
  private headers(extra: Record<string, string> = {}) {
    return serviceRoleHeaders(this.key, extra);
  }
  private objectPath(key: string) {
    if (!/^[A-Za-z0-9._\-/]+$/.test(key)) throw new Error('Invalid object key');
    return `${this.base}/object/${encodeURIComponent(this.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
  private async ensure() {
    if (!this.ready) {
      this.ready = (async () => {
        const res = await fetch(`${this.base}/bucket`, {
          method: 'POST',
          headers: this.headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ id: this.bucket, name: this.bucket, public: false }),
        });
        if (res.ok) return;
        const text = await res.text().catch(() => '');
        if (res.status === 409 || /already exists|duplicate/i.test(text)) return;
        throw new Error(`Supabase Storage bucket could not be created (${res.status}: ${text.slice(0, 160)})`);
      })().catch((e) => { this.ready = undefined; throw e; });
    }
    return this.ready;
  }
  async put(key: string, data: ArrayBuffer | Uint8Array, _meta: Record<string, string> = {}) {
    await this.ensure();
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const res = await fetch(this.objectPath(key), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' }),
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    });
    if (!res.ok) throw new Error(`Supabase Storage upload failed (${res.status}: ${(await res.text()).slice(0, 160)})`);
    return { key, size: bytes.byteLength };
  }
  async get(key: string): Promise<ArrayBuffer | null> {
    const res = await fetch(this.objectPath(key), { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Supabase Storage download failed (${res.status})`);
    return res.arrayBuffer();
  }
  async signedUrl(key: string, expiresSeconds = 3600) {
    await this.ensure();
    return signedPath(this.secret, this.publicBase, key, expiresSeconds);
  }
  async delete(key: string) {
    const res = await fetch(this.objectPath(key), { method: 'DELETE', headers: this.headers() });
    if (!res.ok && res.status !== 404) throw new Error(`Supabase Storage delete failed (${res.status})`);
  }
}

export function createStore(env: Env): ObjectStore | null {
  const secret = String(env.SIGNING_KEY || '');
  const publicBase = String((env as any).PUBLIC_API_BASE || '');
  const bucket = String((env as any).STORAGE_BUCKET || 'firmware');
  const r2 = createR2Store(env as Record<string, unknown>);
  if (r2) return r2;
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseObjectStore(String(env.SUPABASE_URL), String(env.SUPABASE_SERVICE_ROLE_KEY), bucket, publicBase, secret);
  }
  return null;
}

export function storageBackend(env: Env): 'r2' | 'supabase' | 'none' {
  if (r2Binding(env as Record<string, unknown>)) return 'r2';
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) return 'supabase';
  return 'none';
}
