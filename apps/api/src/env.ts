/** Runtime configuration. Cloudflare passes bindings; Node dev reads process.env. */

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_JWT_SECRET?: string;
  JWT_SECRET?: string;
  SECRETS_KEY?: string;
  EMQX_API_BASE?: string;
  EMQX_APP_ID?: string;
  EMQX_APP_SECRET?: string;
  EMQX_BROKER_HOST?: string;
  EMQX_TLS_PORT?: string;
  EMQX_WSS_URL?: string;
  MQTT_PROVIDER?: string;
  MQTT_BRIDGE_URL?: string;
  MQTT_BRIDGE_USERNAME?: string;
  MQTT_BRIDGE_PASSWORD?: string;
  INGRESS_HMAC_SECRET?: string;
  /** True only in the Node local-development server; never in Pages/Workers. */
  LOCAL_DEV?: boolean;
  PUBLIC_API_BASE?: string;
  DATABASE_PROVIDER?: 'supabase' | 'd1';
  /** Native Cloudflare Pages bindings (never API credentials). */
  DB?: unknown;
  FIRMWARE_BUCKET?: unknown;
  MQTT_BROKER_ADMIN_URL?: string;
  DB_DRIVER?: 'pglite' | 'supabase' | 'd1';
  PLATFORM_OWNER_EMAIL?: string;
  PLATFORM_OWNER_PASSWORD?: string;
  [key: string]: unknown;
}

export function loadEnv(bindings?: Record<string, unknown>): Env {
  if (bindings && Object.keys(bindings).length) return bindings as Env;
  return process.env as unknown as Env;
}

export function jwtSecret(env: Env): string {
  const s = env.SUPABASE_JWT_SECRET || env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET (or SUPABASE_JWT_SECRET) is not configured');
  return s;
}
