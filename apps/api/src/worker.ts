/**
 * Cloudflare Workers entry point.
 *
 * - `fetch` serves the entire API (Hono) using Supabase PostgREST with the
 *   service-role key. Every request is authorized server-side; the service key
 *   never reaches the browser.
 * - `MqttIngressDO` holds one outbound MQTT-over-WSS subscription for device
 *   messages. It is started by the platform owner (or a scheduled trigger) and
 *   forwards into the same tenant-safe ingress used locally.
 * - Firmware binaries live in an R2 binding and are served through a Worker
 *   download route. No bucket credentials or presigned secrets are exposed.
 */
import { createApp, handleIngress } from './app';
import { SupabaseRestAdapter } from './db/adapters';
import { createAuth } from './auth';
import { createMqttProvider } from './providers';
import { EventBus, createStore } from './services/runtime';
import type { Runtime } from './services/runtime';
import { loadEnv } from './env';
import type { Env } from './env';
import { MqttWsBridge } from './ingress/mqtt-ws';

function createRuntime(bindings: Record<string, unknown>): Runtime {
  const env = loadEnv({
    ...bindings,
    DB_DRIVER: 'supabase',
    MQTT_PROVIDER: bindings.MQTT_PROVIDER || 'emqx',
    JWT_SECRET: bindings.SUPABASE_JWT_SECRET,
  });
  const db = new SupabaseRestAdapter(env);
  const events = new EventBus();
  return {
    env, db, auth: createAuth(db, env), mqtt: createMqttProvider(env),
    store: createStore(env), events,
    emit: (tenantId, type, payload = {}) => events.publish(tenantId, { type, ...payload }),
  };
}

let cached: { key: string; rt: Runtime } | null = null;
function getRuntime(env: Record<string, unknown>): Runtime {
  const key = String(env.SUPABASE_URL || '') + '|' + String(env.EMQX_API_BASE || '');
  if (!cached || cached.key !== key) cached = { key, rt: createRuntime(env) };
  return cached.rt;
}

const worker = {
  async fetch(request: Request, env: Record<string, unknown>, ctx: any): Promise<Response> {
    const rt = getRuntime(env);
    const app = createApp(rt);
    return app.fetch(request, env, ctx);
  },
  async scheduled(_event: any, env: Record<string, unknown>, ctx: any) {
    // Hourly: expire stale commands and wake the ingress Durable Object.
    const rt = getRuntime(env);
    ctx.waitUntil((async () => {
      await rt.db.rpc('rpc_expire_commands', {}).catch(() => {});
      const id = (env as any).MQTT_INGRESS?.idFromName?.('platform-ingress');
      if (id) {
        const stub = (env as any).MQTT_INGRESS.get(id);
        await stub.fetch('https://internal/start').catch(() => {});
      }
    })());
  },
};

export default worker;

/**
 * One Durable Object instance owns the platform MQTT bridge connection.
 * Only the platform credential is used here — never a device or admin secret
 * from a browser, and never a shared credential on an ESP32.
 */
export class MqttIngressDO {
  private bridge: MqttWsBridge | null = null;
  private state: 'idle' | 'connecting' | 'connected' | 'disconnected' = 'idle';
  private lastDetail = '';
  constructor(private doState: any, private env: Record<string, unknown>) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/stop') { this.bridge?.stop(); this.bridge = null; this.state = 'idle'; }
    else if (url.pathname === '/status') {
      return Response.json({ state: this.state, detail: this.lastDetail, connected: !!this.bridge?.connected });
    } else {
      this.start();
      await this.doState.storage.setAlarm(Date.now() + 30_000);
    }
    return Response.json({ started: this.state !== 'idle', state: this.state });
  }

  async alarm() {
    if (!this.bridge) this.start();
    else this.bridge.tick();
    await this.doState.storage.setAlarm(Date.now() + 30_000);
  }

  private start() {
    if (this.bridge) return;
    const rt = getRuntime(this.env);
    const url = String(this.env.EMQX_WSS_URL || '');
    if (!url) { this.state = 'disconnected'; this.lastDetail = 'EMQX_WSS_URL not configured'; return; }
    this.bridge = new MqttWsBridge({
      url,
      clientId: `helios-ingress-${String(this.env.INGRESS_INSTANCE || 'primary')}`,
      username: String(this.env.MQTT_BRIDGE_USERNAME || ''),
      password: String(this.env.MQTT_BRIDGE_PASSWORD || ''),
      topics: [
        'v1/tenants/+/devices/+/state',
        'v1/tenants/+/devices/+/telemetry',
        'v1/tenants/+/devices/+/availability',
      ],
      onState: (s, d) => { this.state = s === 'connecting' ? 'connecting' : s === 'connected' ? 'connected' : 'disconnected'; this.lastDetail = d || ''; },
      onPublish: async (topic, payload) => {
        let body: unknown;
        try { body = JSON.parse(new TextDecoder().decode(payload)); } catch { body = {}; }
        // No client id here: handleIngress resolves tenant/device from the DB
        // using the parsed topic, and re-checks it against that row.
        await handleIngress(rt, { topic, payload: body }).catch(() => {});
      },
    });
    this.bridge.connect();
  }
}
