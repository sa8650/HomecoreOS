import type { DataClient, MqttProvider, AuthPort, ObjectStore } from '@homecoreos/core';
import type { Env } from '../env';
import { hmacHex } from '../crypto';

/** Per-request/per-isolate runtime assembled at startup. */
export interface Runtime {
  env: Env;
  db: DataClient;
  auth: AuthPort;
  mqtt: MqttProvider;
  store: ObjectStore | null;
  events: EventBus;
  emit: (tenantId: string, type: string, payload?: Record<string, unknown>) => void;
  /** Exactly one active database provider per runtime. */
  provider?: 'supabase' | 'd1';
  /** Bootstrap env (no decrypted secrets) for setup diagnostics. */
  bootstrap?: Env;
}

type Listener = (event: any) => void;

/**
 * In-process SSE fan-out for local development and as a fallback in production.
 * In production the browser can additionally subscribe to Supabase Realtime
 * (RLS-protected); both channels carry the same event shapes.
 */
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

/** In-memory object store used ONLY by the Node local-development server. */
export class LocalObjectStore implements ObjectStore {
  private mem = new Map<string, Uint8Array>();
  constructor(private publicBase = '/api/firmware/download', private secret = '') {}
  async put(key: string, data: ArrayBuffer | Uint8Array) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.mem.set(key, bytes);
    return { key, size: bytes.byteLength };
  }
  async get(key: string) { const v = this.mem.get(key); return v ? v.buffer.slice(0) as ArrayBuffer : null; }
  async signedUrl(key: string, expiresSeconds = 3600) {
    const expires = Math.floor(Date.now() / 1000) + expiresSeconds;
    const sig = await hmacHex(this.secret, `${key}\n${expires}`);
    return `${this.publicBase}/${encodeURIComponent(btoa(key))}?expires=${expires}&sig=${sig}`;
  }
  async delete(key: string) { this.mem.delete(key); }
}

/**
 * Cloudflare R2 binding — the API never exposes bucket credentials.
 * Firmware binaries are served through an authenticated Worker download route
 * instead of public presigned URLs.
 */
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
  async signedUrl(key: string, expiresSeconds = 3600): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + expiresSeconds;
    const sig = await hmacHex(this.secret, `${key}\n${expires}`);
    return `${this.publicBase.replace(/\/$/, '')}/api/firmware/download/${encodeURIComponent(btoa(key))}?expires=${expires}&sig=${sig}`;
  }
  async delete(key: string): Promise<void> { await this.bucket.delete(key); }
}

export function createStore(env: Env): ObjectStore | null {
  // HMAC secret signs short-lived firmware download URLs. It never leaves the
  // server; the ESP32 receives only the signed URL and the SHA-256 digest.
  const secret = String(env.SECRETS_KEY || env.INGRESS_HMAC_SECRET || '');
  if ((env as any).FIRMWARE_BUCKET) {
    return new R2ObjectStore((env as any).FIRMWARE_BUCKET, String(env.PUBLIC_API_BASE || ''), secret);
  }
  // Local development (pglite or the local D1 emulator) keeps working with an
  // in-process store; production without the native R2 binding reports missing.
  // A hosted D1 deployment without FIRMWARE_BUCKET must honestly report
  // "not connected" — never substitute the in-memory dev store.
  if (env.LOCAL_DEV) return new LocalObjectStore('/api/firmware/download', secret);
  return null;
}
