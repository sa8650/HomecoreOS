/**
 * Provider interfaces. The application talks ONLY to these ports, so EMQX Cloud
 * Serverless can be replaced by a self-hosted EMQX/Mosquitto without touching
 * device, tenant or UI code.
 */

export interface ProvisionedCredential {
  username: string;
  password: string; // returned ONCE at provisioning; never persisted in plaintext
  clientId: string;
  providerRef: Record<string, unknown>;
}

export interface BrokerHealth {
  connected: boolean;
  provider: string;
  endpoint: string | null;
  checkedAt: string;
  detail: string;
  clientCount?: number | null;
  unavailable?: string[];
}

export interface ProviderUsage {
  source: 'provider_api' | 'provider_dashboard' | 'owner_manual';
  periodStart?: string;
  periodEnd?: string;
  trafficBytes?: number | null;
  trafficInBytes?: number | null;
  trafficOutBytes?: number | null;
  packets?: number | null;
  sessionMinutes?: number | null;
  connectionsPeak?: number | null;
  messages?: number | null;
  ruleActions?: number | null;
  /** Metrics the deployment API does not expose, with the reason. */
  unavailable: Record<string, string>;
  raw: Record<string, unknown>;
}

export interface MqttProvider {
  readonly id: string;
  readonly displayName: string;
  /** Per-device built-in-database user + allow-list ACL. */
  provisionDevice(input: {
    username: string;
    password: string;
    clientId: string;
    tenantId: string;
    deviceId: string;
  }): Promise<ProvisionedCredential>;
  revokeDevice(input: { username: string; clientId: string }): Promise<void>;
  rotateDevice(input: { username: string; password: string; clientId: string }): Promise<void>;
  publish(input: { topic: string; payload: unknown; qos?: 0 | 1; retain?: boolean }): Promise<void>;
  health(): Promise<BrokerHealth>;
  /** Only returns values the provider actually reported. */
  fetchUsage(): Promise<ProviderUsage | null>;
  publishConfig?(input: { topic: string; payload: unknown }): Promise<void>;
}

export interface ObjectStore {
  put(key: string, data: ArrayBuffer | Uint8Array, meta?: Record<string, string>): Promise<{ key: string; size: number }>;
  get(key: string): Promise<ArrayBuffer | null>;
  signedUrl(key: string, expiresSeconds?: number): Promise<string>;
  delete(key: string): Promise<void>;
}

export interface DataClient {
  select<T = any>(table: string, opts?: Record<string, any>): Promise<T[]>;
  insert<T = any>(table: string, row: Record<string, unknown> | Record<string, unknown>[]): Promise<T[]>;
  update<T = any>(table: string, match: Record<string, unknown>, patch: Record<string, unknown>): Promise<T[]>;
  remove(table: string, match: Record<string, unknown>): Promise<void>;
  rpc<T = any>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** Provider-safe upsert (atomic rotate of owner-managed secrets). */
  upsert?<T = any>(table: string, row: Record<string, unknown>, conflictKeys?: string[]): Promise<T[]>;
  /** Dev-only raw SQL for the local Postgres adapter; production uses RPC/PostgREST. */
  raw?<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface AuthPort {
  signup(email: string, password: string, meta?: Record<string, string>): Promise<{ token: string; profileId: string }>;
  login(email: string, password: string): Promise<{ token: string; profileId: string }>;
  verify(token: string): Promise<{ profileId: string; email?: string; role?: string } | null>;
}

export interface IngressHandler {
  start(): Promise<void>;
  stop(): Promise<void>;
}
