/** Runtime configuration: Cloudflare Pages Variables and Secrets only. */

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  EMQX_API_BASE?: string;
  EMQX_APP_ID?: string;
  EMQX_APP_SECRET?: string;
  EMQX_BROKER_HOST?: string;
  EMQX_TLS_PORT?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
  /** Derived from the service-role key at runtime. Never set by the owner. */
  SIGNING_KEY?: string;
  [key: string]: unknown;
}

export function loadEnv(bindings?: Record<string, unknown>): Env {
  return (bindings || {}) as Env;
}

export function signingKey(env: Env): string {
  const k = String(env.SIGNING_KEY || '');
  if (!/^[0-9a-f]{64}$/.test(k)) throw new Error('Server signing key is not available');
  return k;
}
