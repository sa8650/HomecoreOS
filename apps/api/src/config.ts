/**
 * Platform configuration, encrypted secret storage and the owner setup model.
 *
 * Design rules (deliberately strict):
 *  - ONLY `SECRETS_KEY` is a one-time bootstrap secret. With D1, the owner also
 *    adds the two native bindings (`DB`, `FIRMWARE_BUCKET`). With Supabase, the
 *    two values needed to REACH the database are bootstrap variables.
 *  - Everything the owner enters in the console is AES-256-GCM sealed with
 *    SECRETS_KEY and stored in `platform_secrets`. No plaintext is ever
 *    returned to a browser, logged, committed or bundled.
 *  - Native bindings are discovered, never configured with API keys/URLs.
 *  - Exactly one database provider is active per runtime.
 */
import type { DataClient } from '@homecoreos/core';
import type { Env } from './env';
import { seal, unseal, sha256Hex, hmacHex } from './crypto';
import { D1_TABLES } from './db/d1-schema';

export type DbProvider = 'supabase' | 'd1';
export type FieldSource = 'bootstrap' | 'encrypted' | 'binding';

export interface SecretField {
  key: string;
  label: string;
  hint: string;
  source: FieldSource;
  /** 'always' | 'supabase' | 'd1' | 'never' — never = optional. */
  requiredWhen: 'always' | 'supabase' | 'd1' | 'never';
  sensitive: boolean;
  input: 'text' | 'password' | 'url' | 'number';
  placeholder?: string;
}

export interface SecretGroup {
  id: 'supabase' | 'emqx' | 'platform' | 'encryption';
  label: string;
  description: string;
  fields: SecretField[];
}

export const SECRET_GROUPS: SecretGroup[] = [
  {
    id: 'supabase', label: 'Supabase PostgreSQL',
    description: 'Only needed when Supabase is the selected database. The two bootstrap values are set in Cloudflare so the API can reach the database before decryption is possible.',
    fields: [
      { key: 'SUPABASE_URL', label: 'Project URL', hint: 'Bootstrap variable (Cloudflare Pages → Settings).', source: 'bootstrap', requiredWhen: 'supabase', sensitive: false, input: 'url', placeholder: 'https://your-project.supabase.co' },
      { key: 'SUPABASE_SERVICE_ROLE_KEY', label: 'Service role key', hint: 'Bootstrap secret (Cloudflare Pages → Settings). Never sent to browsers.', source: 'bootstrap', requiredWhen: 'supabase', sensitive: true, input: 'password' },
      { key: 'SUPABASE_ANON_KEY', label: 'Anon key', hint: 'Used by server-side GoTrue calls only. Encrypted at rest.', source: 'encrypted', requiredWhen: 'supabase', sensitive: true, input: 'password' },
      { key: 'SUPABASE_JWT_SECRET', label: 'JWT secret', hint: 'Verifies Supabase-issued sessions. Encrypted at rest.', source: 'encrypted', requiredWhen: 'supabase', sensitive: true, input: 'password' },
    ],
  },
  {
    id: 'emqx', label: 'EMQX / MQTT',
    description: 'Deployment API credentials and the broker address devices use. All values are encrypted at rest; administrative credentials never reach a browser.',
    fields: [
      { key: 'EMQX_API_BASE', label: 'Deployment API base', hint: 'e.g. https://your-deployment.example:443/api/v5', source: 'encrypted', requiredWhen: 'always', sensitive: false, input: 'url' },
      { key: 'EMQX_APP_ID', label: 'App ID', hint: 'EMQX Cloud Deployment API application ID.', source: 'encrypted', requiredWhen: 'always', sensitive: true, input: 'password' },
      { key: 'EMQX_APP_SECRET', label: 'App secret', hint: 'EMQX Cloud Deployment API application secret.', source: 'encrypted', requiredWhen: 'always', sensitive: true, input: 'password' },
      { key: 'EMQX_BROKER_HOST', label: 'Broker host', hint: 'TLS hostname ESP32 devices connect to.', source: 'encrypted', requiredWhen: 'always', sensitive: false, input: 'text' },
      { key: 'EMQX_TLS_PORT', label: 'TLS port', hint: 'Usually 8883.', source: 'encrypted', requiredWhen: 'always', sensitive: false, input: 'number', placeholder: '8883' },
      { key: 'EMQX_WSS_URL', label: 'WSS URL (optional)', hint: 'Only needed for the optional platform-side WebSocket bridge.', source: 'encrypted', requiredWhen: 'never', sensitive: false, input: 'url' },
      { key: 'MQTT_BRIDGE_USERNAME', label: 'Bridge username (optional)', hint: 'Dedicated platform bridge credential, not a device credential.', source: 'encrypted', requiredWhen: 'never', sensitive: true, input: 'password' },
      { key: 'MQTT_BRIDGE_PASSWORD', label: 'Bridge password (optional)', hint: 'Used only by the optional WebSocket bridge.', source: 'encrypted', requiredWhen: 'never', sensitive: true, input: 'password' },
    ],
  },
  {
    id: 'platform', label: 'Platform',
    description: 'Server-side platform values. Optional unless you need an explicit public API origin.',
    fields: [
      { key: 'INGRESS_HMAC_SECRET', label: 'Ingress HMAC secret (optional)', hint: 'Falls back to SECRETS_KEY when not set. Rotating it invalidates pending signed URLs.', source: 'encrypted', requiredWhen: 'never', sensitive: true, input: 'password' },
      { key: 'PUBLIC_API_BASE', label: 'Public API base (optional)', hint: 'Used to build firmware download URLs; defaults to the request origin.', source: 'encrypted', requiredWhen: 'never', sensitive: false, input: 'url' },
    ],
  },
  {
    id: 'encryption', label: 'Encryption',
    description: 'One-time bootstrap secret. It is never stored in the database and never shown again.',
    fields: [
      { key: 'SECRETS_KEY', label: 'Secrets encryption key', hint: 'Cloudflare Pages → Settings → Variables and Secrets → add as an encrypted secret. 64 hex characters (32 random bytes).', source: 'bootstrap', requiredWhen: 'always', sensitive: true, input: 'password' },
    ],
  },
];

export const ALL_SECRET_KEYS = SECRET_GROUPS.flatMap((g) => g.fields.map((f) => f.key));
export const ENCRYPTED_KEYS = SECRET_GROUPS.flatMap((g) => g.fields.filter((f) => f.source === 'encrypted').map((f) => f.key));
export const BOOTSTRAP_KEYS = SECRET_GROUPS.flatMap((g) => g.fields.filter((f) => f.source === 'bootstrap').map((f) => f.key));

export const CLOUDFLARE_BINDINGS = [
  { name: 'DB', label: 'Cloudflare D1 database', requiredWhen: 'd1' as const, detail: 'Required only when D1 is the selected provider.' },
  { name: 'FIRMWARE_BUCKET', label: 'Cloudflare R2 bucket', requiredWhen: 'always' as const, detail: 'Firmware binaries. No access keys or tokens are needed.' },
];

/** Detect the ONE active provider from native bindings / bootstrap variables. */
export function detectProvider(env: Env): DbProvider | null {
  if ((env as any).DB) return 'd1';
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) return 'supabase';
  return null;
}

/** SECRETS_KEY must be 64 hex chars. No fallback key is ever embedded in code. */
export function secretsKey(env: Env): string {
  const k = String(env.SECRETS_KEY || '');
  if (!/^[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error('SECRETS_KEY is missing or invalid. Add a 64-character hex secret in Cloudflare Pages → Settings → Variables and Secrets, then redeploy.');
  }
  return k.toLowerCase();
}
export function encryptionReady(env: Env) { return /^[0-9a-fA-F]{64}$/.test(String(env.SECRETS_KEY || '')); }

/** Decrypt owner-console-managed integration secrets from the database. */
export async function loadSecrets(db: DataClient, env: Env): Promise<{ values: Record<string, string>; keys: string[]; corrupt: string[] }> {
  if (!encryptionReady(env)) return { values: {}, keys: [], corrupt: [] };
  let rows: any[] = [];
  try { rows = await db.select('platform_secrets'); } catch { return { values: {}, keys: [], corrupt: [] }; }
  const key = secretsKey(env);
  const values: Record<string, string> = {}, keys: string[] = [], corrupt: string[] = [];
  for (const r of rows) {
    if (!ENCRYPTED_KEYS.includes(String(r.key))) continue;
    keys.push(String(r.key));
    try { values[String(r.key)] = await unseal(r, key); }
    catch { corrupt.push(String(r.key)); }
  }
  return { values, keys, corrupt };
}

/**
 * Merge encrypted values into the runtime env. Bootstrap values always win so
 * a console edit can never break the database connection that loads it.
 */
export function effectiveEnv(bootstrap: Env, secrets: Record<string, string>): Env {
  const env: Env = { ...bootstrap };
  for (const k of ENCRYPTED_KEYS) if (secrets[k] && !env[k]) (env as any)[k] = secrets[k];
  if (!env.JWT_SECRET) env.JWT_SECRET = env.SUPABASE_JWT_SECRET || env.SECRETS_KEY;
  if (!env.INGRESS_HMAC_SECRET) env.INGRESS_HMAC_SECRET = env.SECRETS_KEY;
  if (!env.MQTT_PROVIDER) env.MQTT_PROVIDER = 'emqx';
  if (!env.EMQX_TLS_PORT) env.EMQX_TLS_PORT = '8883';
  return env;
}

/** Persist / rotate a secret. The plaintext exists only in this request. */
export async function saveSecret(db: DataClient, env: Env, key: string, value: string, actorId: string) {
  if (!ENCRYPTED_KEYS.includes(key)) throw new Error(`Not an owner-managed field: ${key}`);
  if (!value) throw new Error('Value cannot be empty');
  const sealed = await seal(value, secretsKey(env));
  const row = {
    key, ciphertext: sealed.ciphertext, iv: sealed.iv, tag: sealed.tag,
    fingerprint: (await sha256Hex(value)).slice(0, 12), updated_by: actorId,
    updated_at: new Date().toISOString(),
  };
  if (db.upsert) await db.upsert('platform_secrets', row, ['key']);
  else {
    // Legacy adapters: replace the row, then insert (atomic enough for a
    // single-owner operation; modern adapters all implement upsert).
    await db.remove('platform_secrets', { key });
    await db.insert('platform_secrets', row);
  }
  return { key, configured: true, fingerprint: row.fingerprint, updated_at: row.updated_at };
}

export async function deleteSecret(db: DataClient, key: string) {
  if (!ENCRYPTED_KEYS.includes(key)) throw new Error(`Not an owner-managed field: ${key}`);
  await db.remove('platform_secrets', { key });
  return { key, configured: false };
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

export interface ConnectionResult {
  connected: boolean;
  target: string;
  endpoint: string | null;
  checkedAt: string;
  detail: string;
  hint?: string;
  clientCount?: number | null;
}

/** Live, server-side connection check. Credentials never leave the server. */
export async function testConnection(env: Env, target: 'supabase' | 'emqx'): Promise<ConnectionResult> {
  const checkedAt = new Date().toISOString();
  if (target === 'supabase') {
    const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
    const service = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
    if (!url || !service) return { connected: false, target, endpoint: url || null, checkedAt,
      detail: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not configured.',
      hint: 'These are bootstrap values: set them in Cloudflare Pages → Settings → Variables and Secrets, then redeploy.' };
    try {
      const res = await fetch(`${url}/rest/v1/platform_settings?select=key&limit=1`, {
        headers: { apikey: service, Authorization: `Bearer ${service}`, Accept: 'application/json' },
      });
      const text = await res.text();
      if (!res.ok) return { connected: false, target, endpoint: url, checkedAt,
        detail: `Supabase responded ${res.status}: ${text.slice(0, 200)}`,
        hint: 'Check the project URL and service-role key, and confirm migrations 0001-0015 have been applied.' };
      return { connected: true, target, endpoint: url, checkedAt,
        detail: 'PostgREST reachable and the platform_settings table exists.' };
    } catch (e: any) {
      return { connected: false, target, endpoint: url, checkedAt,
        detail: `Network error: ${e?.message || 'unreachable'}`, hint: 'Verify the project URL and outbound access from Cloudflare.' };
    }
  }
  const base = String(env.EMQX_API_BASE || '').replace(/\/$/, '');
  const appId = String(env.EMQX_APP_ID || ''), appSecret = String(env.EMQX_APP_SECRET || '');
  if (!base || !appId || !appSecret) return { connected: false, target, endpoint: base || null, checkedAt,
    detail: 'EMQX_API_BASE, EMQX_APP_ID and EMQX_APP_SECRET are required.',
    hint: 'Enter them under Owner Console → Platform Settings → Integrations & Secrets.' };
  try {
    const res = await fetch(`${base}/clients?limit=1&page=1`, {
      headers: { Authorization: `Basic ${btoa(`${appId}:${appSecret}`)}`, Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) return { connected: false, target, endpoint: base, checkedAt,
      detail: `EMQX API responded ${res.status}: ${text.slice(0, 200)}`,
      hint: 'Verify AppID/AppSecret and that the API base ends with /api/v5.' };
    let count: number | null = null;
    try { const d = JSON.parse(text); count = d?.meta?.count ?? (Array.isArray(d?.data) ? d.data.length : null); } catch { /* opaque body */ }
    return { connected: true, target, endpoint: base, checkedAt,
      detail: 'Deployment API responded; live client list available.', clientCount: count };
  } catch (e: any) {
    return { connected: false, target, endpoint: base, checkedAt,
      detail: `Network error: ${e?.message || 'unreachable'}`, hint: 'Check the deployment endpoint and firewall rules.' };
  }
}

export async function recordCheck(db: DataClient, target: string, result: ConnectionResult) {
  await setSetting(db, `integration.${target}.last_check`, {
    ok: result.connected, at: result.checkedAt, message: result.detail,
  });
  if (result.connected) await setSetting(db, `integration.${target}.last_success`, result.checkedAt);
  await db.insert('emqx_sync_runs', {
    kind: `test_${target}`, status: result.connected ? 'success' : 'failed',
    detail: { target, detail: result.detail, endpoint: result.endpoint },
    finished_at: result.checkedAt,
  }).catch(() => {});
}

/** Real round-trip against the native R2 binding (put → get → delete). */
export async function testBucket(env: Env, store: { put(k: string, d: Uint8Array): Promise<any>; get(k: string): Promise<ArrayBuffer | null>; delete(k: string): Promise<void> } | null) {
  const checkedAt = new Date().toISOString();
  if (!store) return { connected: false, checkedAt, detail: 'FIRMWARE_BUCKET binding is not connected.',
    hint: 'Cloudflare Dashboard → Workers & Pages → Pages project → Settings → Bindings → add R2 bucket named FIRMWARE_BUCKET → Save and redeploy.' };
  const key = `__setup_probe__/${Date.now()}`;
  const bytes = new Uint8Array([0x48, 0x4f, 0x4d, 0x45]); // HOME
  try {
    await store.put(key, bytes);
    const got = await store.get(key);
    const same = !!got && new Uint8Array(got).length === bytes.length && new Uint8Array(got).every((b, i) => b === bytes[i]);
    await store.delete(key).catch(() => {});
    return { connected: same, checkedAt,
      detail: same ? 'R2 upload and download verified with a round-trip probe.' : 'Object read back did not match the uploaded bytes.' };
  } catch (e: any) {
    return { connected: false, checkedAt, detail: `R2 round-trip failed: ${e?.message || 'unknown error'}`,
      hint: 'Check the FIRMWARE_BUCKET binding and redeploy.' };
  }
}

function stable(v: any): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
export async function migrationToken(backup: any, env: Env) {
  return hmacHex(secretsKey(env), `homecoreos-provider-migration:${stable(backup?.tables || {})}`);
}

/** Portable logical backup of every application table. */
export async function exportBackup(db: DataClient, provider: string) {
  const tables: Record<string, any[]> = {};
  const warnings: string[] = [];
  for (const t of D1_TABLES) {
    try { tables[t] = await db.select(t); }
    catch { warnings.push(`Table ${t} could not be read; it may not exist on this provider yet.`); }
  }
  try {
    if (provider === 'd1' || provider === 'pglite') {
      tables.auth_users = provider === 'd1' ? await db.select('auth_users') : [];
    } else if (db.raw) {
      tables.auth_users = await db.raw<any>('select id, email, raw_user_meta_data, password_hash, created_at from auth.users');
    } else tables.auth_users = [];
  } catch { warnings.push('Auth user rows could not be exported; import them through Supabase Auth if needed.'); }
  if (provider !== 'd1' && provider !== 'pglite') {
    warnings.push('Supabase Auth accounts are managed by GoTrue; export/import them with the Supabase CLI when switching providers.');
  }
  return { schema_version: 1, provider, exported_at: new Date().toISOString(), tables, warnings };
}

/** Restore a backup into the currently bound provider (explicit switch only). */
export async function importBackup(db: DataClient, backup: any, provider: string, replace: boolean) {
  if (backup?.schema_version !== 1 || !backup.tables) throw new Error('Unrecognised backup format');
  const anyDb = db as any;
  if (provider === 'd1' && anyDb.restore) return anyDb.restore(backup, { replace });
  let rows = 0;
  const warnings: string[] = [];
  for (const [table, list] of Object.entries(backup.tables as Record<string, any[]>)) {
    if (!Array.isArray(list)) continue;
    if (table === 'auth_users') { warnings.push('Auth users must be imported through the target provider identity system.'); continue; }
    if (replace && anyDb.remove) { try { await anyDb.remove(table, {}); } catch { /* empty table */ } }
    for (const row of list) {
      try {
        const keys = row?.id ? ['id'] : row?.key ? ['key'] : [];
        if (anyDb.upsert && keys.length) await anyDb.upsert(table, row, keys);
        else await db.insert(table, row);
        rows++;
      } catch (e: any) { warnings.push(`${table}: ${e?.message || 'row skipped'}`); }
    }
  }
  return { imported_tables: Object.keys(backup.tables).length, imported_rows: rows, warnings };
}

/** Status model for the Owner Console. Never includes a saved value. */
export async function setupStatus(input: {
  env: Env; db: DataClient; provider: DbProvider | 'pglite' | null; secrets: Record<string, string>;
  corrupt: string[]; store: any; tests: { supabase: ConnectionResult; emqx: ConnectionResult };
  bucket: { connected: boolean; checkedAt: string; detail: string };
  dbHealth: any;
}) {
  const { env, db, provider, secrets, corrupt, tests, bucket, dbHealth } = input;
  const configured = (k: string) => Boolean(secrets[k] || (env as any)[k]);
  const masked = '••••••••••••';
  const secretRows = await db.select('platform_secrets').catch(() => [] as any[]);
  const meta = Object.fromEntries(secretRows.map((r: any) => [String(r.key), r]));
  const selected = await getSetting(db, 'platform.database_provider');
  const selectedProvider = selected === 'd1' || selected === 'supabase' ? selected : null;

  const groups = SECRET_GROUPS.map((g) => {
    const applicable = g.id !== 'supabase' || provider !== 'd1';
    return {
      id: g.id, label: g.label, description: g.description, applicable,
      fields: g.fields.map((f) => {
        const fromBootstrap = f.source === 'bootstrap';
        const isConfigured = fromBootstrap ? Boolean((env as any)[f.key]) : configured(f.key);
        const required = f.requiredWhen === 'always'
          || (f.requiredWhen === 'supabase' && provider === 'supabase')
          || (f.requiredWhen === 'd1' && provider === 'd1');
        return {
          key: f.key, label: f.label, hint: f.hint, source: f.source, required,
          sensitive: f.sensitive, input: f.input, placeholder: f.placeholder || '',
          configured: isConfigured, masked: isConfigured ? masked : '',
          editable: f.source === 'encrypted' && !fromBootstrap,
          fingerprint: meta[f.key]?.fingerprint || null,
          updated_at: meta[f.key]?.updated_at || null,
        };
      }),
    };
  });
  const supabaseCheck = await getSetting(db, 'integration.supabase.last_check');
  const emqxCheck = await getSetting(db, 'integration.emqx.last_check');
  const lastSuccess = (t: string) => getSetting(db, `integration.${t}.last_success`);
  const status = (target: 'supabase' | 'emqx') => {
    const live = tests[target];
    return {
      connected: live.connected, endpoint: live.endpoint,
      last_checked: live.checkedAt, last_success: live.connected ? live.checkedAt : null,
      last_error: live.connected ? null : live.detail,
      hint: live.hint || null, client_count: live.clientCount ?? null,
      stored_last_success: null as string | null,
    };
  };
  const supabaseStatus = status('supabase'), emqxStatus = status('emqx');
  supabaseStatus.stored_last_success = await lastSuccess('supabase');
  emqxStatus.stored_last_success = await lastSuccess('emqx');
  void supabaseCheck; void emqxCheck;

  const bindings = CLOUDFLARE_BINDINGS.map((b) => ({
    name: b.name, label: b.label, detail: b.detail,
    connected: Boolean((env as any)[b.name]),
    required: b.requiredWhen === 'always' || (b.requiredWhen === 'd1' && provider === 'd1'),
  }));
  const dbOk = Boolean(provider && dbHealth?.connected !== false);
  const emqxOk = emqxStatus.connected;
  const brokerConfigured = configured('EMQX_BROKER_HOST') && configured('EMQX_TLS_PORT');
  const encryptionOk = encryptionReady(env);
  const r2Ok = bindings.find((b) => b.name === 'FIRMWARE_BUCKET')?.connected || Boolean(env.LOCAL_DEV);
  const storageOk = bucket.connected;
  const checklist = [
    { id: 'database', label: 'Database configured', required: true, source: provider === 'd1' ? 'binding' : 'bootstrap',
      status: dbOk ? 'ok' : 'missing', detail: dbOk ? `${provider === 'd1' ? 'Cloudflare D1' : 'Supabase PostgreSQL'} connected via the native ${provider === 'd1' ? 'DB binding' : 'server-side configuration'}.` : 'No database binding or bootstrap connection detected.' },
    { id: 'r2', label: 'R2 bucket connected', required: true, source: 'binding',
      status: r2Ok ? 'ok' : 'missing', detail: r2Ok ? (env.LOCAL_DEV && !bindings.find((b) => b.name === 'FIRMWARE_BUCKET')?.connected ? 'Local development object store is active; add the FIRMWARE_BUCKET binding before deploying.' : 'FIRMWARE_BUCKET binding is present.') : 'Add the FIRMWARE_BUCKET R2 binding in Cloudflare Pages settings.' },
    { id: 'emqx_api', label: 'EMQX API connected', required: true, source: 'encrypted',
      status: emqxOk ? 'ok' : 'error', detail: emqxStatus.connected ? 'Deployment API responded.' : (emqxStatus.last_error || 'Not connected'),
      last_success: emqxStatus.stored_last_success, last_checked: emqxStatus.last_checked },
    { id: 'mqtt_broker', label: 'MQTT broker connected', required: true, source: 'encrypted',
      status: emqxOk && brokerConfigured ? 'ok' : 'missing',
      detail: emqxOk && brokerConfigured ? 'Broker host and TLS port configured; devices can reach the deployment.' : 'Configure the EMQX API and broker host/TLS port.' },
    { id: 'encryption', label: 'Encryption initialized', required: true, source: 'bootstrap',
      status: encryptionOk ? 'ok' : 'missing', detail: encryptionOk ? 'SECRETS_KEY is valid; owner-managed secrets are AES-256-GCM encrypted.' : 'Add SECRETS_KEY as an encrypted Cloudflare Pages variable.' },
    { id: 'firmware', label: 'Firmware storage ready', required: true, source: 'binding',
      status: storageOk ? 'ok' : 'error', detail: bucket.detail, last_success: storageOk ? bucket.checkedAt : null },
  ];
  const setupComplete = checklist.every((x) => x.status === 'ok');
  return {
    provider, selected_provider: selectedProvider,
    needs_provider_selection: !selectedProvider,
    setup_complete: setupComplete,
    migration_required: Boolean(selectedProvider && provider && selectedProvider !== provider),
    wizard: {
      needs_selection: !selectedProvider,
      options: [
        { id: 'd1', label: 'Cloudflare D1', description: 'Recommended. Add the DB binding; migrations run automatically. No database URL or API token.', applicable: Boolean((env as any).DB) },
        { id: 'supabase', label: 'Supabase PostgreSQL', description: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY as bootstrap values, then apply the SQL migrations once.', applicable: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) },
      ],
    },
    required: groups.filter((g) => g.applicable).flatMap((g) => g.fields.filter((f) => f.required && f.source === 'bootstrap')
      .map((f) => ({ group: g.id, ...f }))),
    optional: groups.filter((g) => g.applicable).flatMap((g) => g.fields.filter((f) => !f.required && f.source !== 'binding')
      .map((f) => ({ group: g.id, ...f }))),
    bindings,
    groups,
    encrypted_secrets: groups.flatMap((g) => g.applicable ? g.fields.filter((f) => f.source === 'encrypted').map((f) => ({ group: g.id, ...f })) : []),
    connections: { supabase: provider === 'supabase' ? supabaseStatus : { ...supabaseStatus, connected: false, last_error: 'Supabase is not the selected provider.', hint: 'Not needed with Cloudflare D1.' }, emqx: emqxStatus },
    checklist,
    corrupt_secrets: corrupt,
    database_health: dbHealth,
    notes: [
      'Never both databases at once: the provider is detected from the DB binding or the Supabase bootstrap variables.',
      'Switching providers requires exporting a backup and running the guided migration — it is not a settings toggle.',
      'R2 access keys, D1 API tokens and database URLs are never requested when native bindings are available.',
    ],
  };
}
