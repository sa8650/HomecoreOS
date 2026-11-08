import type { ObjectStore } from '@homecoreos/core';
import { hmacHex, toHex } from '../crypto';

const enc = new TextEncoder();

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  publicBase?: string;
  signingKey?: string;
}

const REGION = 'auto';
const SERVICE = 's3';
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function validKey(key: string) {
  if (!/^[A-Za-z0-9._\-/]+$/.test(key) || key.includes('..') || key.startsWith('/')) {
    throw new Error('Invalid object key');
  }
}

async function sha256HexBytes(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

async function hmacRaw(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const b of enc.encode(value)) {
    const ch = String.fromCharCode(b);
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')
      || ch === '-' || ch === '_' || ch === '.' || ch === '~') out += ch;
    else if (ch === '/' && !encodeSlash) out += '/';
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** AWS Signature Version 4 over the S3-compatible R2 API, using WebCrypto only. */
export class R2Client {
  private endpoint: string;
  constructor(private cfg: R2Config) {
    this.endpoint = String(cfg.endpoint || `https://${cfg.accountId}.r2.cloudflarestorage.com`).replace(/\/$/, '');
  }

  get bucket() { return this.cfg.bucket; }
  get configured() {
    return !!(this.cfg.accountId && this.cfg.bucket && this.cfg.accessKeyId && this.cfg.secretAccessKey);
  }

  private async authorization(method: string, key: string, body: Uint8Array | null,
    contentType?: string): Promise<Record<string, string>> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const host = new URL(this.endpoint).host;
    const canonicalUri = '/' + uriEncode(this.cfg.bucket, false) + '/' + uriEncode(key, false);
    const payloadHash = body ? await sha256HexBytes(body) : EMPTY_HASH;

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) headers['content-type'] = contentType;
    const sorted = Object.keys(headers).sort();
    const signedHeaders = sorted.join(';');
    const canonicalHeaders = sorted.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('');
    const canonicalRequest = [
      method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');
    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256HexBytes(canonicalRequest)].join('\n');

    let keyBytes = await hmacRaw(enc.encode(`AWS4${this.cfg.secretAccessKey}`), dateStamp);
    keyBytes = await hmacRaw(keyBytes, REGION);
    keyBytes = await hmacRaw(keyBytes, SERVICE);
    keyBytes = await hmacRaw(keyBytes, 'aws4_request');
    const signature = toHex(await hmacRaw(keyBytes, stringToSign));

    const out: Record<string, string> = {
      Authorization: `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) out['Content-Type'] = contentType;
    return out;
  }

  private url(key: string) {
    validKey(key);
    return `${this.endpoint}/${uriEncode(this.cfg.bucket, false)}/${uriEncode(key, false)}`;
  }

  private async request(method: string, key: string, body: Uint8Array | null,
    contentType?: string): Promise<Response> {
    const headers = await this.authorization(method, key, body, contentType);
    const res = await fetch(this.url(key), {
      method, headers,
      body: body ? (body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`R2 ${method} failed (${res.status}): ${text.slice(0, 220)}`);
    }
    return res;
  }

  async put(key: string, data: Uint8Array, contentType = 'application/octet-stream') {
    await this.request('PUT', key, data, contentType);
    return { key, size: data.byteLength };
  }

  async get(key: string): Promise<Uint8Array | null> {
    const headers = await this.authorization('GET', key, null);
    const res = await fetch(this.url(key), { method: 'GET', headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 GET failed (${res.status}): ${(await res.text()).slice(0, 220)}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(key: string) {
    try { await this.request('DELETE', key, null); }
    catch (e: any) { if (!/404/.test(String(e?.message || ''))) throw e; }
  }

  async head(key: string): Promise<number | null> {
    const headers = await this.authorization('HEAD', key, null);
    const res = await fetch(this.url(key), { method: 'HEAD', headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 HEAD failed (${res.status})`);
    return Number(res.headers.get('content-length') || 0);
  }

  /** Real round trip: upload, read back, verify checksum, then remove. */
  async roundTrip(): Promise<{ ok: boolean; detail: string; checkedAt: string }> {
    const checkedAt = new Date().toISOString();
    if (!this.configured) return { ok: false, checkedAt, detail: 'R2 credentials are not configured.' };
    const key = `__setup_probe__/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const bytes = enc.encode('homecoreos-r2-round-trip');
    const digest = await sha256HexBytes(bytes);
    try {
      await this.put(key, bytes);
      const read = await this.get(key);
      if (!read) throw new Error('Object was not returned by R2');
      const readDigest = await sha256HexBytes(read);
      if (readDigest !== digest) throw new Error('Downloaded checksum does not match the upload');
      await this.delete(key);
      const gone = await this.head(key);
      if (gone !== null) throw new Error('Probe object was not removed');
      return { ok: true, checkedAt, detail: 'Upload, download, checksum and delete verified against R2.' };
    } catch (e: any) {
      await this.delete(key).catch(() => {});
      return { ok: false, checkedAt, detail: `R2 round trip failed: ${e?.message || 'unknown error'}` };
    }
  }
}

/** Private R2 bucket over the S3 API. No Cloudflare binding is required. */
export class R2ObjectStore implements ObjectStore {
  constructor(public client: R2Client, private publicBase = '', private secret = '') {}
  get backend() { return 'r2' as const; }
  async put(key: string, data: ArrayBuffer | Uint8Array, _meta: Record<string, string> = {}) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return this.client.put(key, bytes);
  }
  async get(key: string): Promise<ArrayBuffer | null> {
    const bytes = await this.client.get(key);
    if (!bytes) return null;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  async delete(key: string) { await this.client.delete(key); }
  async signedUrl(key: string, expiresSeconds = 600) {
    const base = this.publicBase.replace(/\/$/, '');
    const expires = Math.floor(Date.now() / 1000) + expiresSeconds;
    const sig = await hmacHex(this.secret, `${key}\n${expires}`);
    return `${base}/api/firmware/download/${encodeURIComponent(btoa(key))}?expires=${expires}&sig=${sig}`;
  }
}

export function r2Config(env: Record<string, unknown>): R2Config | null {
  const accountId = String(env.R2_ACCOUNT_ID || '').trim();
  const bucket = String(env.R2_BUCKET || '').trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    accountId, bucket, accessKeyId, secretAccessKey,
    endpoint: String(env.R2_ENDPOINT || '').trim() || undefined,
    publicBase: String(env.PUBLIC_API_BASE || ''),
    signingKey: String(env.SIGNING_KEY || ''),
  };
}
