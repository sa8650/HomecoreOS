import type { DataClient, MqttProvider, AuthPort, ObjectStore } from '@homecoreos/core';
import type { Env } from '../env';
import { hmacHex } from '../crypto';
import { serviceRoleHeaders } from '../db/adapters';

/** Per-request/per-isolate runtime assembled at startup. */
export interface Runtime {
  env: Env;
  db: DataClient;
  auth: AuthPort;
  mqtt: MqttProvider;
  store: ObjectStore | null;
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

function downloadPath(publicBase: string) {
  return `${publicBase.replace(/\/$/, '')}/api/firmware/download`;
}

/** Signed, short-lived firmware URLs served by the API (never a public bucket). */
async function signedPath(secret: string, publicBase: string, key: string, expiresSeconds: number) {
  const expires = Math.floor(Date.now() / 1000) + expiresSeconds;
  const sig = await hmacHex(secret, `${key}\n${expires}`);
  return `${downloadPath(publicBase)}/${encodeURIComponent(btoa(key))}?expires=${expires}&sig=${sig}`;
}

/**
 * Default firmware store: a private Supabase Storage bucket. Created on first
 * use with the service-role key; no Cloudflare R2 binding is needed.
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

/** Optional native R2 binding, used only when one is present. */
export class R2ObjectStore implements ObjectStore {
  constructor(private bucket: any, private publicBase: string, private secret = '') {}
  async put(key: string, data: ArrayBuffer | Uint8Array, meta: Record<string, string> = {}) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    await this.bucket.put(key, bytes, { customMetadata: meta });
    return { key, size: bytes.byteLength };
  }
  async get(key: string): Promise<ArrayBuffer | null> {
    const obj = await this.bucket.get(key);
    return obj ? obj.arrayBuffer() : null;
  }
  async signedUrl(key: string, expiresSeconds = 3600) {
    return signedPath(this.secret, this.publicBase, key, expiresSeconds);
  }
  async delete(key: string) { await this.bucket.delete(key); }
}

export function createStore(env: Env): ObjectStore | null {
  const secret = String(env.SIGNING_KEY || '');
  const publicBase = String((env as any).PUBLIC_API_BASE || '');
  const bucket = String((env as any).STORAGE_BUCKET || 'firmware');
  if (env.FIRMWARE_BUCKET) return new R2ObjectStore(env.FIRMWARE_BUCKET, publicBase, secret);
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseObjectStore(String(env.SUPABASE_URL), String(env.SUPABASE_SERVICE_ROLE_KEY), bucket, publicBase, secret);
  }
  return null;
}
