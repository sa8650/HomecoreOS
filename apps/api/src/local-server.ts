/**
 * Local development / test server.
 *
 * DB_DRIVER=pglite (default) -> real Postgres via PGlite + all SQL migrations.
 * DB_DRIVER=d1               -> the Cloudflare D1 emulator (sql.js) + the SAME
 *                               generated D1 schema and portable domain RPCs.
 * DB_DRIVER=supabase         -> Supabase PostgREST with the service-role key.
 *
 * Both local drivers are faithful, independent configurations used by the test
 * suite. Secrets are resolved exactly as they are in Pages Functions.
 */
import { serve } from '@hono/node-server';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, handleIngress } from './app';
import { PGliteAdapter, SupabaseRestAdapter } from './db/adapters';
import { D1Adapter } from './db/d1';
import { createAuth } from './auth';
import { createMqttProvider } from './providers';
import { EventBus, createStore } from './services/runtime';
import type { Runtime } from './services/runtime';
import { randomHex } from './crypto';
import { loadSecrets, effectiveEnv } from './config';
import type { Env } from './env';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const DATA_DIR = resolve(ROOT, '.pglite-data');
// Keep generated dev secrets in their own directory: PGlite owns .pglite-data
// exclusively and refuses to initialise if unrelated files are present.
const DEV_CONFIG_DIR = resolve(ROOT, '.local-dev');
const KEY_FILE = resolve(DEV_CONFIG_DIR, 'secrets-key');

function localSecretsKey(): string {
  if (process.env.SECRETS_KEY && /^[0-9a-fA-F]{64}$/.test(process.env.SECRETS_KEY)) return process.env.SECRETS_KEY;
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, 'utf8').trim();
  const key = randomHex(32);
  mkdirSync(DEV_CONFIG_DIR, { recursive: true });
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}

async function bootstrapPglite(): Promise<any> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create(DATA_DIR);
  await db.exec(`
    create schema if not exists auth;
    create table if not exists auth.users (
      id uuid primary key default gen_random_uuid(),
      email text not null unique,
      raw_user_meta_data jsonb not null default '{}'::jsonb,
      password_hash text,
      created_at timestamptz not null default now()
    );
  `);
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
      if not exists (select 1 from pg_publication where pubname='supabase_realtime') then
        create publication supabase_realtime;
      end if;
    end $$;
  `);
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  const applied = await db.query(`select name from public._homecoreos_migrations`).catch(() => ({ rows: [] as any[] }));
  const done = new Set((applied.rows as any[]).map((r) => r.name));
  await db.exec(`create table if not exists public._homecoreos_migrations (name text primary key, applied_at timestamptz default now())`);
  for (const f of files) {
    if (done.has(f)) continue;
    console.log(`[db] applying ${f}`);
    await db.exec(readFileSync(resolve(MIGRATIONS, f), 'utf8'));
    await db.query(`insert into public._homecoreos_migrations (name) values ($1)`, [f]);
  }
  await db.exec(`create trigger on_auth_user_created after insert on auth.users
    for each row execute function public.handle_new_user()`).catch((e) => {
      if (!String(e.message).includes('already exists')) throw e;
    });
  return db;
}

async function main() {
  const driver = String(process.env.DB_DRIVER || 'pglite') as 'pglite' | 'd1' | 'supabase';
  const bootstrap: Env = {
    ...process.env,
    DB_DRIVER: driver,
    LOCAL_DEV: true,
    SECRETS_KEY: localSecretsKey(),
    JWT_SECRET: process.env.JWT_SECRET || localSecretsKey(),
    INGRESS_HMAC_SECRET: process.env.INGRESS_HMAC_SECRET || 'local-ingress-secret',
    MQTT_BRIDGE_URL: process.env.MQTT_BRIDGE_URL || 'mqtt://127.0.0.1:1883',
    MQTT_BROKER_ADMIN_URL: process.env.MQTT_BROKER_ADMIN_URL || 'http://127.0.0.1:1884',
    MQTT_PROVIDER: process.env.MQTT_PROVIDER || 'local',
  };

  let db: any;
  let provider: 'pglite' | 'd1' | 'supabase' = driver;
  if (driver === 'd1') {
    const { SqliteD1 } = await import('./db/sqlite-d1');
    const d1 = await SqliteD1.create();
    const applied = await d1.migrate();
    console.log(`[db] D1 migrations: ${applied.join(', ') || 'already applied'}`);
    db = new D1Adapter(d1);
  } else if (driver === 'supabase') {
    db = new SupabaseRestAdapter(bootstrap);
  } else {
    db = new PGliteAdapter(await bootstrapPglite());
  }

  const secrets = await loadSecrets(db, bootstrap);
  const env = effectiveEnv(bootstrap, secrets.values);
  const events = new EventBus();
  const rt: Runtime = {
    env, db, auth: createAuth(db, env), mqtt: createMqttProvider(env),
    store: createStore(env), events,
    emit: (tenantId, type, payload = {}) => events.publish(tenantId, { type, ...payload }),
    provider: driver === 'supabase' ? 'supabase' : driver === 'd1' ? 'd1' : undefined,
    bootstrap,
  };
  (rt as any).localProvider = provider;

  // Local-only bootstrap owner (never runs against hosted production).
  const ownerEmail = process.env.PLATFORM_OWNER_EMAIL || 'owner@homecoreos.local';
  const ownerPassword = process.env.PLATFORM_OWNER_PASSWORD || 'HomecoreOSOwner2026!';
  const { hashPassword } = await import('./crypto');
  let ownerId: string;
  if (driver === 'd1') {
    const existing = await db.select('auth_users', { eq: { email: ownerEmail }, limit: 1 });
    if (existing.length) ownerId = existing[0].id;
    else {
      ownerId = crypto.randomUUID();
      await db.insert('auth_users', { id: ownerId, email: ownerEmail,
        raw_user_meta_data: { full_name: 'Platform Owner', home_name: 'Platform' },
        password_hash: await hashPassword(ownerPassword) });
      await db.rpc('rpc_bootstrap_user', { p_actor: ownerId, p_email: ownerEmail,
        p_meta: { full_name: 'Platform Owner', home_name: 'Platform' } });
    }
  } else {
    const pg = (db as PGliteAdapter) as any;
    const existing = await pg.raw(`select id from auth.users where email=$1`, [ownerEmail]);
    if (existing.length) ownerId = existing[0].id;
    else {
      const r = await pg.raw(`insert into auth.users (email, raw_user_meta_data, password_hash)
        values ($1,$2::jsonb,$3) returning id`, [ownerEmail,
        JSON.stringify({ full_name: 'Platform Owner', home_name: 'Platform' }), await hashPassword(ownerPassword)]);
      ownerId = r[0].id;
    }
  }
  const admins = await db.select('platform_admins', { eq: { profile_id: ownerId }, limit: 1 }).catch(() => []);
  if (!admins.length) await db.insert('platform_admins', { profile_id: ownerId, level: 'owner' });
  // Owner's auto-created tenant is not a customer home; archive it so counts stay honest.
  await db.update('tenants', { owner_profile_id: ownerId }, { status: 'closed' }).catch(() => {});

  // The local broker forwards authenticated device publishes to this endpoint.
  (globalThis as any).__homecoreosIngress = (msg: any) => handleIngress(rt, msg);
  (globalThis as any).__homecoreosRuntime = rt;

  const app = createApp(rt);
  // Dev-only: start a virtual ESP32 through the REAL pairing flow.
  app.post('/api/dev/simulator/start', async (c) => {
    const { context } = await import('./context');
    const ctx = await context(c, 'devices.manage');
    const b = await c.req.json().catch(() => ({}));
    const token = (await import('./crypto')).randomToken(32);
    const hash = (await (await import('./crypto')).sha256Hex(token));
    await rt.db.rpc('rpc_create_pairing_token', { p_actor: ctx.profileId, p_tenant: ctx.tenantId,
      p_data: { token_hash: hash, catalog_board_id: b.catalog_board_id || null,
        board_name: b.board_name || 'Virtual ESP32', ttl_seconds: 900 } });
    const { spawn } = await import('node:child_process');
    const sim = resolve(ROOT, 'simulator/esp32-sim.mjs');
    const child = spawn(process.execPath, [sim, token, String(b.catalog_board_id || ''), String(process.env.API_URL || 'http://127.0.0.1:8787')],
      { detached: true, stdio: 'ignore', env: { ...process.env } });
    child.unref();
    return c.json({ started: true, note: 'A virtual ESP32 is pairing through the real device onboarding flow.' }, 202);
  });

  const port = Number(process.env.PORT || 8787);
  serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
    console.log(`[api] HomecoreOS API listening on http://0.0.0.0:${info.port} (${driver})`);
    console.log(`[api] local platform owner: ${ownerEmail} / ${ownerPassword} (development only)`);
  });

  setInterval(async () => {
    try { await rt.db.rpc('rpc_expire_commands'); } catch { /* db busy */ }
  }, 15000).unref();
}

main().catch((e) => { console.error(e); process.exit(1); });
