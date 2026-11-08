/**
 * Platform configuration. Everything the owner sets lives in Cloudflare Pages
 * → Settings → Variables and Secrets. No configuration is written back to the
 * database, and no saved value is ever returned to a browser.
 */
import type { DataClient } from '@homecoreos/core';
import type { Env } from './env';
import { loadEnv } from './env';
import { hmacHex } from './crypto';
import { serviceRoleHeaders } from './db/adapters';
import { r2Binding } from './storage/r2';

export interface ConfigField {
  key: string;
  label: string;
  group: 'supabase' | 'emqx' | 'firmware';
  required: boolean;
  sensitive: boolean;
  hint: string;
}

export const CONFIG_FIELDS: ConfigField[] = [
  { key: 'SUPABASE_URL', label: 'Project URL', group: 'supabase', required: true, sensitive: false,
    hint: 'Supabase → Project Settings → API (or Connect). Example: https://your-project.supabase.co' },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', label: 'Service role key', group: 'supabase', required: true, sensitive: true,
    hint: 'Supabase → Project Settings → API Keys → service_role. Server-side only, never in the frontend.' },
  { key: 'EMQX_API_BASE', label: 'Deployment API base', group: 'emqx', required: true, sensitive: false,
    hint: 'EMQX Cloud → Deployment Overview → API endpoint, ending in /api/v5' },
  { key: 'EMQX_APP_ID', label: 'App ID', group: 'emqx', required: true, sensitive: true,
    hint: 'EMQX Cloud → Deployment Overview → Deployment API Key → + New API Key' },
  { key: 'EMQX_APP_SECRET', label: 'App secret', group: 'emqx', required: true, sensitive: true,
    hint: 'Shown only once when the API key is created.' },
  { key: 'EMQX_BROKER_HOST', label: 'Broker host', group: 'emqx', required: true, sensitive: false,
    hint: 'EMQX Cloud → Deployment Overview → MQTT connection information → broker address (host only).' },
  { key: 'EMQX_TLS_PORT', label: 'TLS port', group: 'emqx', required: false, sensitive: false,
    hint: 'Defaults to 8883. Use 8883 for EMQX Cloud Serverless.' },
  { key: 'FW_SIGNING_PUBKEY', label: 'Firmware signing public key', group: 'firmware', required: false, sensitive: false,
    hint: 'Base64 of the raw 32-byte Ed25519 public key (44 characters). Optional: without it the console reports "signing key not configured" and never claims a signature was verified.' },
];

/** Only these two are needed for the app to boot. EMQX enables devices; the R2 binding enables firmware. */
export const REQUIRED_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

/**
 * Build the effective runtime env. A single server-side signing key is derived
 * from the service-role key so no SECRETS_KEY, JWT secret or HMAC secret needs
 * to be configured. It is never exposed to the browser.
 */
export async function buildEnv(bindings: Record<string, unknown>): Promise<Env> {
  const bootstrap = loadEnv(bindings);
  const missing = REQUIRED_VARS.filter((k) => !String(bootstrap[k] || '').trim());
  if (missing.length) {
    throw new Error(
      `Missing required configuration: ${missing.join(', ')}. Add them in Cloudflare Pages → Settings → Variables and Secrets, then redeploy.`
    );
  }
  const key = await hmacHex(String(bootstrap.SUPABASE_SERVICE_ROLE_KEY), 'homecoreos-signing-key-v1');
  return {
    ...bootstrap,
    SIGNING_KEY: key,
    EMQX_TLS_PORT: String(bootstrap.EMQX_TLS_PORT || '8883'),
  };
}

export interface ConnectionResult {
  connected: boolean;
  target: string;
  endpoint: string | null;
  checkedAt: string;
  detail: string;
  hint?: string;
  clientCount?: number | null;
}

/** Server-side live check. Credentials never leave the Pages Function. */
export async function testConnection(env: Env, target: 'supabase' | 'emqx'): Promise<ConnectionResult> {
  const checkedAt = new Date().toISOString();
  if (target === 'supabase') {
    const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
    const service = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
    if (!url || !service) return { connected: false, target, endpoint: url || null, checkedAt,
      detail: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not configured.',
      hint: 'Set them in Cloudflare Pages → Settings → Variables and Secrets, then redeploy.' };
    try {
      const res = await fetch(`${url}/rest/v1/platform_settings?select=key&limit=1`, {
        headers: serviceRoleHeaders(service, { Accept: 'application/json' }),
      });
      const text = await res.text();
      if (!res.ok) return { connected: false, target, endpoint: url, checkedAt,
        detail: `Supabase responded ${res.status}: ${text.slice(0, 200)}`,
        hint: 'Check the URL, the service-role key, and that supabase/schema.sql has been run in the SQL Editor.' };
      return { connected: true, target, endpoint: url, checkedAt,
        detail: 'Supabase PostgREST reachable and the schema is present.' };
    } catch (e: any) {
      return { connected: false, target, endpoint: url, checkedAt,
        detail: `Network error: ${e?.message || 'unreachable'}`, hint: 'Verify the project URL and outbound access from Cloudflare.' };
    }
  }
  const base = String(env.EMQX_API_BASE || '').replace(/\/$/, '');
  const appId = String(env.EMQX_APP_ID || ''), appSecret = String(env.EMQX_APP_SECRET || '');
  if (!base || !appId || !appSecret) return { connected: false, target, endpoint: base || null, checkedAt,
    detail: 'EMQX_API_BASE, EMQX_APP_ID and EMQX_APP_SECRET are required.',
    hint: 'Add them in Cloudflare Pages → Settings → Variables and Secrets, then redeploy.' };
  try {
    const res = await fetch(`${base}/clients?limit=1&page=1`, {
      headers: { Authorization: `Basic ${btoa(`${appId}:${appSecret}`)}`, Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) return { connected: false, target, endpoint: base, checkedAt,
      detail: `EMQX API responded ${res.status}: ${text.slice(0, 200)}`,
      hint: 'Verify App ID / App Secret and that the API base ends with /api/v5.' };
    let count: number | null = null;
    try { const d = JSON.parse(text); count = d?.meta?.count ?? (Array.isArray(d?.data) ? d.data.length : null); } catch { /* opaque body */ }
    return { connected: true, target, endpoint: base, checkedAt,
      detail: 'EMQX Deployment API responded.', clientCount: count };
  } catch (e: any) {
    return { connected: false, target, endpoint: base, checkedAt,
      detail: `Network error: ${e?.message || 'unreachable'}`, hint: 'Check the deployment endpoint and firewall rules.' };
  }
}

/** Real put → get → delete round-trip against the configured object store. */
export async function testStorage(store: {
  put(k: string, d: Uint8Array): Promise<any>;
  get(k: string): Promise<ArrayBuffer | null>;
  delete(k: string): Promise<void>;
} | null) {
  const checkedAt = new Date().toISOString();
  if (!store) return { connected: false, checkedAt, detail: 'Firmware storage is not configured.',
    hint: 'Add the FIRMWARE_BUCKET R2 binding in Cloudflare Pages → Settings → Functions → R2 bucket bindings, or check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' };
  const key = `__setup_probe__/${Date.now()}`;
  const bytes = new Uint8Array([0x48, 0x4f, 0x4d, 0x45]);
  try {
    await store.put(key, bytes);
    const got = await store.get(key);
    const same = !!got && new Uint8Array(got).length === bytes.length
      && new Uint8Array(got).every((b, i) => b === bytes[i]);
    await store.delete(key).catch(() => {});
    return { connected: same, checkedAt,
      detail: same ? 'Firmware upload and download verified with a round-trip probe.'
        : 'Object read back did not match the uploaded bytes.' };
  } catch (e: any) {
    return { connected: false, checkedAt, detail: `Storage round-trip failed: ${e?.message || 'unknown error'}`,
      hint: 'Check the Supabase Storage service and the service-role key.' };
  }
}

export async function getSetting(db: DataClient, key: string): Promise<any> {
  try {
    const rows = await db.select('platform_settings', { eq: { key }, limit: 1 });
    return rows[0]?.value ?? null;
  } catch { return null; }
}

export async function setSetting(db: DataClient, key: string, value: unknown) {
  const row = { key, value, is_secret: false, updated_at: new Date().toISOString() };
  if (db.upsert) await db.upsert('platform_settings', row, ['key']);
  else {
    const existing = await db.select('platform_settings', { eq: { key }, limit: 1 });
    if (existing.length) await db.update('platform_settings', { key }, { value, updated_at: row.updated_at });
    else await db.insert('platform_settings', row);
  }
}

export async function recordCheck(db: DataClient, target: string, result: ConnectionResult) {
  await setSetting(db, `integration.${target}.last_check`, {
    ok: result.connected, at: result.checkedAt, message: result.detail,
  }).catch(() => {});
  if (result.connected) await setSetting(db, `integration.${target}.last_success`, result.checkedAt).catch(() => {});
  await db.insert('emqx_sync_runs', {
    kind: `test_${target}`, status: result.connected ? 'success' : 'failed',
    detail: { target, detail: result.detail, endpoint: result.endpoint },
    finished_at: result.checkedAt,
  }).catch(() => {});
}

/** Read-only setup status for the Owner Console. Never includes a saved value. */
export async function setupStatus(input: {
  env: Env; db: DataClient;
  tests: { supabase: ConnectionResult; emqx: ConnectionResult };
  storage: { connected: boolean; checkedAt: string; detail: string };
  dbHealth: any;
  authHealth: any;
}) {
  const { env, db, tests, storage, dbHealth, authHealth } = input;
  const configured = (k: string) => Boolean(String((env as any)[k] || '').trim());
  const r2Bound = Boolean(r2Binding(env as Record<string, unknown>));
  const lastSuccess = (t: string) => getSetting(db, `integration.${t}.last_success`);
  const status = (target: 'supabase' | 'emqx') => {
    const live = tests[target];
    return {
      connected: live.connected, endpoint: live.endpoint,
      last_checked: live.checkedAt, last_success: live.connected ? live.checkedAt : null,
      last_error: live.connected ? null : live.detail, hint: live.hint || null,
      client_count: live.clientCount ?? null, stored_last_success: null as string | null,
    };
  };
  const supabase = status('supabase'), emqx = status('emqx');
  supabase.stored_last_success = await lastSuccess('supabase');
  emqx.stored_last_success = await lastSuccess('emqx');

  const dbOk = dbHealth?.connected !== false;
  const brokerConfig = configured('EMQX_BROKER_HOST');
  const checklist = [
    { id: 'database', label: 'Supabase database connected', required: true, source: 'cloudflare',
      status: dbOk ? 'ok' : 'error', detail: dbOk ? 'PostgREST reachable with the service-role key.'
        : (dbHealth?.error || 'Supabase is not reachable.') },
    { id: 'schema', label: 'Database schema installed', required: true, source: 'supabase',
      status: supabase.connected ? 'ok' : 'error', detail: supabase.connected ? 'platform_settings table found.'
        : (supabase.last_error || 'Run supabase/schema.sql in the Supabase SQL Editor.'),
      hint: supabase.hint },
    { id: 'emqx_api', label: 'EMQX API connected', required: true, source: 'cloudflare',
      status: emqx.connected ? 'ok' : 'error', detail: emqx.connected ? 'Deployment API responded.'
        : (emqx.last_error || 'Not connected'), hint: emqx.hint,
      last_success: emqx.stored_last_success, last_checked: emqx.last_checked },
    { id: 'mqtt_broker', label: 'MQTT broker address set', required: true, source: 'cloudflare',
      status: brokerConfig ? 'ok' : 'missing', detail: brokerConfig
        ? `Devices connect to ${env.EMQX_BROKER_HOST}:${env.EMQX_TLS_PORT || '8883'} over TLS.`
        : 'EMQX_BROKER_HOST is not configured.' },
    { id: 'firmware', label: 'Firmware storage ready', required: true, source: 'cloudflare',
      status: storage.connected ? 'ok' : 'error',
      detail: `${storage.detail} Backend: ${r2Bound ? 'private Cloudflare R2 (native FIRMWARE_BUCKET binding)' : 'private Supabase Storage fallback'}.`,
      last_success: storage.connected ? storage.checkedAt : null,
      hint: r2Bound ? '' : 'Add an R2 bucket binding named FIRMWARE_BUCKET in Cloudflare Pages → Settings → Functions → R2 bucket bindings, then redeploy.' },
    { id: 'auth', label: 'Custom authentication ready', required: true, source: 'supabase',
      status: authHealth?.pgcrypto ? 'ok' : 'error',
      detail: authHealth?.pgcrypto
        ? `${authHealth.accounts ?? 0} accounts · ${authHealth.active_sessions ?? 0} active sessions. Password hashing, sessions, roles and permissions are database-backed.`
        : 'Enable the pgcrypto extension and run supabase/schema.sql in the Supabase SQL Editor.' },
  ];
  return {
    provider: 'supabase', setup_complete: checklist.every((x) => x.status === 'ok'),
    checklist,
    variables: CONFIG_FIELDS.map((f) => ({
      ...f, configured: f.key === 'EMQX_TLS_PORT' ? true : configured(f.key),
      masked: configured(f.key) && f.sensitive ? '••••••••••••' : '',
    })),
    connections: { supabase, emqx },
    storage: { backend: r2Bound ? 'r2' : 'supabase',
      r2_configured: r2Bound, binding_name: r2Bound ? 'FIRMWARE_BUCKET' : null,
      connected: storage.connected, detail: storage.detail },
    notes: [
      'Supabase and EMQX values come from Cloudflare Pages → Settings → Variables and Secrets.',
      'Firmware uses the native FIRMWARE_BUCKET R2 bucket binding from Cloudflare Pages → Settings → Functions → R2 bucket bindings. No R2 API token or S3 keys are needed.',
      'R2 is reported as connected only after a real upload and download round trip succeeds.',
      'Sensitive values are encrypted Cloudflare secrets and are never shown again.',
      'The first registered account becomes the Platform Owner in a single atomic database transaction.',
    ],
  };
}
