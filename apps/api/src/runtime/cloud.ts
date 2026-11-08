/**
 * Cloudflare Pages Functions runtime.
 *
 * One provider only:
 *   - `DB` native binding present  -> Cloudflare D1 (D1Adapter, auto-migrations)
 *   - bootstrap Supabase variables -> Supabase PostgreSQL (SupabaseRestAdapter)
 *
 * The bootstrap env is used ONLY to open the database. Owner-console-managed
 * integration secrets are then decrypted with SECRETS_KEY and merged into the
 * effective env for the rest of the request. No service-role key, MQTT password
 * or administrative secret is ever returned to a browser or a customer.
 */
import type { DataClient } from '@homecoreos/core';
import type { Env } from '../env';
import { loadEnv } from '../env';
import type { Runtime } from '../services/runtime';
import { EventBus, createStore } from '../services/runtime';
import { createAuth } from '../auth';
import { SupabaseRestAdapter } from '../db/adapters';
import { D1Adapter } from '../db/d1';
import { EmqxCloudProvider } from '../providers/emqx';
import { detectProvider, loadSecrets, effectiveEnv, type DbProvider } from '../config';

export interface CloudRuntime extends Runtime {
  provider: DbProvider;
  bootstrap: Env;
  secretsLoaded: string[];
}

export async function createCloudRuntime(bindings: Record<string, unknown>): Promise<CloudRuntime> {
  const bootstrap = loadEnv(bindings);
  const provider = detectProvider(bootstrap);
  if (!provider) {
    throw new Error(
      'No database configured. In Cloudflare Dashboard → Workers & Pages → your Pages project → Settings → Bindings, add a D1 database named DB (recommended) and an R2 bucket named FIRMWARE_BUCKET; add SECRETS_KEY under Variables and Secrets; then Save and redeploy. Alternatively set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY as bootstrap values for Supabase PostgreSQL.'
    );
  }

  let db: DataClient;
  if (provider === 'd1') {
    const d1 = new D1Adapter(bindings.DB as any);
    // Idempotent: applies 0001_schema + 0002_seed once per D1 database.
    await d1.migrate();
    db = d1;
  } else {
    db = new SupabaseRestAdapter(bootstrap);
  }

  const secrets = await loadSecrets(db, bootstrap);
  const env = effectiveEnv(bootstrap, secrets.values);
  env.DB_DRIVER = provider;
  env.DATABASE_PROVIDER = provider;
  env.DB = bindings.DB;
  env.FIRMWARE_BUCKET = bindings.FIRMWARE_BUCKET;
  if (!env.PUBLIC_API_BASE) env.PUBLIC_API_BASE = '';

  const events = new EventBus();
  return {
    env, db,
    auth: createAuth(db, env),
    mqtt: new EmqxCloudProvider(env),
    store: createStore(env),
    events,
    emit: (tenantId, type, payload = {}) => events.publish(tenantId, { type, ...payload }),
    provider, bootstrap, secretsLoaded: secrets.keys,
  };
}

/** Cached per isolate; refreshed so secret rotation takes effect promptly. */
let cache: { key: string; at: number; rt: CloudRuntime } | null = null;
export async function getCloudRuntime(bindings: Record<string, unknown>): Promise<CloudRuntime> {
  const key = [
    String((bindings as any).SECRETS_KEY || '').slice(0, 12),
    String((bindings as any).SUPABASE_URL || ''),
    String((bindings as any).DATABASE_PROVIDER || ''),
    Boolean((bindings as any).DB),
  ].join('|');
  if (cache && cache.key === key && Date.now() - cache.at < 30_000) return cache.rt;
  const rt = await createCloudRuntime(bindings);
  cache = { key, at: Date.now(), rt };
  return rt;
}
