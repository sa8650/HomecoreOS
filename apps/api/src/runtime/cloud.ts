/**
 * Cloudflare Pages Functions runtime — Supabase PostgreSQL is the only database
 * provider. No D1 database, R2 bucket or other native binding is required.
 */
import type { DataClient } from '@homecoreos/core';
import type { Env } from '../env';
import type { Runtime } from '../services/runtime';
import { EventBus, createStore } from '../services/runtime';
import { createAuth } from '../auth';
import { SupabaseRestAdapter } from '../db/adapters';
import { EmqxCloudProvider } from '../providers/emqx';
import { buildEnv } from '../config';

export interface CloudRuntime extends Runtime {
  bootstrap: Env;
}

export async function createCloudRuntime(bindings: Record<string, unknown>): Promise<CloudRuntime> {
  const env = await buildEnv(bindings);
  env.FIRMWARE_BUCKET = bindings.FIRMWARE_BUCKET;
  const db: DataClient = new SupabaseRestAdapter(env);
  const events = new EventBus();
  return {
    env, db,
    auth: createAuth(db, env),
    mqtt: new EmqxCloudProvider(env),
    store: createStore(env),
    events,
    emit: (tenantId, type, payload = {}) => events.publish(tenantId, { type, ...payload }),
    bootstrap: bindings as Env,
  };
}

/** Cached per isolate so configuration changes are picked up promptly. */
let cache: { key: string; at: number; rt: CloudRuntime } | null = null;
export async function getCloudRuntime(bindings: Record<string, unknown>): Promise<CloudRuntime> {
  const key = [
    String(bindings.SUPABASE_URL || ''),
    String(bindings.SUPABASE_SERVICE_ROLE_KEY || '').slice(0, 12),
    String(bindings.EMQX_API_BASE || ''),
    Boolean(bindings.FIRMWARE_BUCKET),
  ].join('|');
  if (cache && cache.key === key && Date.now() - cache.at < 30_000) return cache.rt;
  const rt = await createCloudRuntime(bindings);
  cache = { key, at: Date.now(), rt };
  return rt;
}
