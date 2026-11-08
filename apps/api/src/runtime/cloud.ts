/**
 * Cloudflare Pages Functions runtime — Supabase PostgreSQL is the database and
 * the native FIRMWARE_BUCKET R2 binding is the firmware store. No D1 binding,
 * S3 API token or other native binding is required.
 */
import type { DataClient } from '@homecoreos/core';
import type { Env } from '../env';
import type { Runtime } from '../services/runtime';
import { EventBus, createStore, storageBackend } from '../services/runtime';
import { createR2Store } from '../storage/r2';
import { createAuth } from '../auth';
import { SupabaseRestAdapter } from '../db/adapters';
import { EmqxCloudProvider } from '../providers/emqx';
import { buildEnv } from '../config';

export interface CloudRuntime extends Runtime {
  bootstrap: Env;
}

export async function createCloudRuntime(bindings: Record<string, unknown>): Promise<CloudRuntime> {
  const env = await buildEnv(bindings);
  const db: DataClient = new SupabaseRestAdapter(env);
  const events = new EventBus();
  const r2 = createR2Store(env as Record<string, unknown>);
  return {
    env, db,
    auth: createAuth(db, env),
    mqtt: new EmqxCloudProvider(env),
    store: createStore(env),
    r2,
    storageBackend: storageBackend(env),
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
    Boolean(bindings.R2_BUCKET),
  ].join('|');
  if (cache && cache.key === key && Date.now() - cache.at < 30_000) return cache.rt;
  const rt = await createCloudRuntime(bindings);
  cache = { key, at: Date.now(), rt };
  return rt;
}
