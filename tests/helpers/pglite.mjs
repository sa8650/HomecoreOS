import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');

/**
 * Boots a real Postgres (PGlite/WASM) with the exact production migrations.
 * Supabase-supplied objects (auth.users, roles, publications) are stubbed to
 * match the Supabase environment so the SQL is identical in both places.
 */
export async function createTestDb({ withData = true } = {}) {
  const db = await PGlite.create();
  await db.exec(`
    create schema if not exists auth;
    create table if not exists auth.users (
      id uuid primary key default gen_random_uuid(),
      email text not null unique,
      raw_user_meta_data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create publication supabase_realtime;
  `);
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(resolve(MIGRATIONS, f), 'utf8');
    try {
      await db.exec(sql);
    } catch (e) {
      throw new Error(`Migration ${f} failed: ${e.message}\n${e.stack}`);
    }
  }
  // Supabase fires this trigger on auth.users inserts; PGlite has no GoTrue.
  await db.exec(`create trigger on_auth_user_created after insert on auth.users
      for each row execute function public.handle_new_user();`);
  if (withData) await seed(db);
  return db;
}

export async function seed(db) {
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';
  const OWNER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const VIEWER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const OPERATOR = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  await db.query(`insert into auth.users (id,email,raw_user_meta_data) values
    ($1,'alice@example.test','{"full_name":"Alice","home_name":"Alice Home"}'),
    ($2,'bob@example.test','{"full_name":"Bob","home_name":"Bob Home"}'),
    ($3,'viewer@example.test','{"full_name":"Vera"}'),
    ($4,'operator@example.test','{"full_name":"Otto"}'),
    ($5,'owner@example.test','{"full_name":"Platform Owner"}')`,
    [A, B, VIEWER, OPERATOR, OWNER]);
  // Each auth user gets their own tenant from handle_new_user().
  const tenants = await db.query(`select id, owner_profile_id from tenants order by created_at`);
  const byOwner = Object.fromEntries(tenants.rows.map((r) => [r.owner_profile_id, r.id]));
  const tA = byOwner[A];
  const tB = byOwner[B];
  // Third/fourth/fifth tenants are not used; drop them to keep counts clean.
  await db.query(`delete from tenants where owner_profile_id in ($1,$2,$3)`, [VIEWER, OPERATOR, OWNER]);
  await db.query(`insert into tenant_members (tenant_id,profile_id,role_key,status,joined_at) values
    ($1,$2,'viewer','active',now()), ($3,$4,'operator','active',now())`, [tA, VIEWER, tA, OPERATOR]);
  await db.query(`insert into platform_admins (profile_id,level) values ($1,'owner')`, [OWNER]);
  return { A, B, VIEWER, OPERATOR, OWNER, tA, tB };
}

/** Execute as a PostgREST-like JWT user, with request.jwt.claims set. */
export async function asUser(db, profileId, fn) {
  await db.exec(`set role authenticated; set request.jwt.claims = '${JSON.stringify({ sub: profileId, role: 'authenticated' })}'`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; reset request.jwt.claims`);
  }
}

export async function rpc(db, name, args = {}) {
  const keys = Object.keys(args);
  const meta = await db.query(
    `select pg_get_function_arguments(p.oid) as args from pg_proc p
     join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname=$1 order by p.oid desc limit 1`, [name]);
  const declared = String(meta.rows[0]?.args || '')
    .split(',').map((part) => {
      const decl = String(part.split(/\s+DEFAULT\s+/i)[0]).trim();
      return (decl.match(/\s([a-z_ ]+(?:\(\d+\))?)$/i) || [])[1]?.trim();
    }).filter(Boolean);
  const casts = keys.map((_, i) => `$${i + 1}::${declared[i] || 'text'}`);
  const params = keys.map((k) => {
    const v = args[k];
    const t = declared[keys.indexOf(k)] || 'text';
    if (v === null || v === undefined) return null;
    if (t.includes('jsonb') || t.includes('json')) return JSON.stringify(v);
    return String(v);
  });
  const r = await db.query(`select public.${name}(${casts.join(',')}) as result`, params);
  const val = r.rows[0]?.result;
  return typeof val === 'string' ? JSON.parse(val) : val;
}

export function expectError(code) {
  return (fn) => async () => {
    try { await fn(); } catch (e) {
      if (code && e.code !== code && !String(e.message).includes(code)) {
        throw new Error(`Expected error ${code}, got ${e.code}: ${e.message}`);
      }
      return;
    }
    throw new Error('Expected an error but call succeeded');
  };
}

export const ok = (label) => console.log(`  ✓ ${label}`);
