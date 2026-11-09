/**
 * Firmware storage through a native Cloudflare Pages R2 bucket binding.
 *
 * In the Cloudflare dashboard the binding is added under
 * Settings → Functions → R2 bucket bindings with the variable name
 * FIRMWARE_BUCKET (R2_BUCKET is accepted as an alias). No S3 API token,
 * access key, secret, account ID or endpoint is read from the environment.
 */
import type { ObjectStore } from '@homecoreos/core';
import { sha256Hex, randomHex } from '../crypto';
import { signedPath } from './signed-url';

/** The subset of the Workers R2Bucket API that HomecoreOS uses. */
export interface R2BucketBinding {
  put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream | string, options?: unknown): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size?: number } | null>;
  delete(key: string | string[]): Promise<void>;
  head?(key: string): Promise<{ size?: number } | null>;
}

/** Binding names accepted in the Cloudflare Pages dashboard, in priority order. */
export const R2_BINDING_NAMES = ['FIRMWARE_BUCKET', 'R2_BUCKET'] as const;

/** Find the native binding. Plain strings (old S3 secrets) are never mistaken for one. */
export function r2Binding(env: Record<string, unknown>): R2BucketBinding | null {
  for (const name of R2_BINDING_NAMES) {
    const value = env[name];
    if (!value || typeof value !== 'object') continue;
    const bucket = value as Partial<R2BucketBinding>;
    if (typeof bucket.put === 'function' && typeof bucket.get === 'function' && typeof bucket.delete === 'function') {
      return value as R2BucketBinding;
    }
  }
  return null;
}

function validKey(key: string) {
  if (!/^[A-Za-z0-9._\-/]+$/.test(key) || key.includes('..') || key.startsWith('/')) {
    throw new Error('Invalid object key');
  }
}

function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/** Private R2 bucket accessed through the native binding. */
export class R2ObjectStore implements ObjectStore {
  constructor(
    public bucket: R2BucketBinding,
    private publicBase = '',
    private secret = '',
  ) {}
  get backend() { return 'r2' as const; }

  async put(key: string, data: ArrayBuffer | Uint8Array, _meta: Record<string, string> = {}) {
    validKey(key);
    const buffer = toArrayBuffer(data);
    await this.bucket.put(key, buffer);
    return { key, size: buffer.byteLength };
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    validKey(key);
    const object = await this.bucket.get(key);
    return object ? await object.arrayBuffer() : null;
  }

  async delete(key: string) {
    validKey(key);
    await this.bucket.delete(key);
  }

  async head(key: string): Promise<number | null> {
    validKey(key);
    if (this.bucket.head) {
      const info = await this.bucket.head(key);
      return info ? Number(info.size || 0) : null;
    }
    const object = await this.bucket.get(key);
    return object ? Number(object.size || 0) : null;
  }

  async signedUrl(key: string, expiresSeconds = 600) {
    return signedPath(this.secret, this.publicBase, key, expiresSeconds);
  }

  /** Real round trip: upload, read back, verify SHA-256, delete, confirm removal. */
  async roundTrip(): Promise<{ ok: boolean; detail: string; checkedAt: string }> {
    const checkedAt = new Date().toISOString();
    const key = `__setup_probe__/${Date.now()}-${randomHex(4)}`;
    const bytes = new TextEncoder().encode('homecoreos-r2-round-trip');
    const digest = await sha256Hex(bytes);
    try {
      await this.put(key, bytes);
      const read = await this.get(key);
      if (!read) throw new Error('The object was not returned by R2');
      const readDigest = await sha256Hex(new Uint8Array(read));
      if (readDigest !== digest) throw new Error('The downloaded checksum does not match the upload');
      await this.delete(key);
      if (await this.head(key) !== null) throw new Error('The probe object was not removed');
      return { ok: true, checkedAt, detail: 'Upload, download, checksum and delete verified against the R2 binding.' };
    } catch (e: any) {
      await this.delete(key).catch(() => {});
      return { ok: false, checkedAt, detail: `R2 round trip failed: ${e?.message || 'unknown error'}` };
    }
  }
}

/** Build the R2 store from the effective runtime environment, or null. */
export function createR2Store(env: Record<string, unknown>): R2ObjectStore | null {
  const bucket = r2Binding(env);
  if (!bucket) return null;
  return new R2ObjectStore(bucket, String(env.PUBLIC_API_BASE || ''), String(env.SIGNING_KEY || ''));
}
