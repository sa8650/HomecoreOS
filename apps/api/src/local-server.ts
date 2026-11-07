import { serve } from '@hono/node-server';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { PGliteAdapter } from './db/adapters';
import { LocalAuthAdapter } from './auth';
import { createMqttProvider } from './providers';
import { EventBus, createStore } from './services/runtime';
import type { Runtime } from './services/runtime';
import { handleIngress } from './app';
import { randomToken } from './crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const DATA_DIR = resolve(ROOT, '.pglite-data');

async function bootstrapDb() {
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
  const applied = await db.query(`select name from public._helios_migrations`).catch(() => ({ rows: [] as any[] }));
  const done = new Set((applied.rows as any[]).map((r) => r.name));
  await db.exec(`create table if not exists public._helios_migrations (name text primary key, applied_at timestamptz default now())`);
  for (const f of files) {
    if (done.has(f)) continue;
    console.log(`[db] applying ${f}`);
    await db.exec(readFileSync(resolve(MIGRATIONS, f), 'utf8'));
    await db.query(`insert into public._helios_migrations (name) values ($1)`, [f]);
  }
  await db.exec(`create trigger on_auth_user_created after insert on auth.users
    for each row execute function public.handle_new_user()`).catch((e) => {
      if (!String(e.message).includes('already exists')) throw e;
    });
  return db;
}

async function main() {
  const db = await bootstrapDb();
  const env: any = {
    ...process.env,
    DB_DRIVER: 'pglite',
    JWT_SECRET: process.env.JWT_SECRET || 'local-development-jwt-secret-change-me',
    INGRESS_HMAC_SECRET: process.env.INGRESS_HMAC_SECRET || 'local-ingress-secret',
    MQTT_BRIDGE_URL: process.env.MQTT_BRIDGE_URL || 'mqtt://127.0.0.1:1883',
    MQTT_BROKER_ADMIN_URL: process.env.MQTT_BROKER_ADMIN_URL || 'http://127.0.0.1:1884',
    MQTT_PROVIDER: process.env.MQTT_PROVIDER || 'local',
  };
  const data = new PGliteAdapter(db);
  const auth = new LocalAuthAdapter(data, env);
  const events = new EventBus();
  const rt: Runtime = {
    env, db: data, auth, mqtt: createMqttProvider(env), store: createStore(env), events,
    emit: (tenantId, type, payload = {}) => events.publish(tenantId, { type, ...payload }),
  };

  // Local-only bootstrap owner (never runs against Supabase/production).
  const ownerEmail = process.env.PLATFORM_OWNER_EMAIL || 'owner@helios.local';
  const ownerPassword = process.env.PLATFORM_OWNER_PASSWORD || 'HeliosOwner2026!';
  const existing = await db.query(`select id from auth.users where email=$1`, [ownerEmail]);
  let ownerId: string;
  if (!existing.rows.length) {
    const { hashPassword } = await import('./crypto');
    const r = await db.query(`insert into auth.users (email, raw_user_meta_data, password_hash)
      values ($1,$2::jsonb,$3) returning id`, [ownerEmail, JSON.stringify({ full_name: 'Platform Owner', home_name: 'Platform' }), await hashPassword(ownerPassword)]);
    ownerId = (r.rows[0] as any).id;
  } else ownerId = (existing.rows[0] as any).id;
  await db.query(`insert into platform_admins (profile_id, level) values ($1,'owner') on conflict do nothing`, [ownerId]);
  // Owner's auto-created tenant is not a customer home; archive it so counts stay honest.
  await db.query(`update tenants set status='closed' where owner_profile_id=$1`, [ownerId]);

  // The local broker forwards authenticated device publishes to this endpoint.
  // We call the same handler directly instead of an HTTP round-trip.
  (globalThis as any).__heliosIngress = (msg: any) => handleIngress(rt, msg);
  (globalThis as any).__heliosRuntime = rt;

  const app = createApp(rt);
  // Dev-only: start a virtual ESP32 through the REAL pairing flow.
  app.post('/api/dev/simulator/start', async (c) => {
    const { actor, context } = await import('./context');
    const ctx = await context(c, 'devices.manage');
    const b = await c.req.json().catch(() => ({}));
    const { sha256Hex } = await import('./crypto');
    const token = randomToken(32);
    await rt.db.rpc('rpc_create_pairing_token', { p_actor: ctx.profileId, p_tenant: ctx.tenantId,
      p_data: { token_hash: await sha256Hex(token), catalog_board_id: b.catalog_board_id || null,
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
    console.log(`[api] Helios API listening on http://0.0.0.0:${info.port}`);
    console.log(`[api] local platform owner: ${ownerEmail} / ${ownerPassword} (development only)`);
  });

  // Expire stale commands every 15 seconds so no command lingers indefinitely.
  setInterval(async () => {
    try { await rt.db.rpc('rpc_expire_commands'); } catch { /* db busy */ }
  }, 15000).unref();
}

main().catch((e) => { console.error(e); process.exit(1); });
