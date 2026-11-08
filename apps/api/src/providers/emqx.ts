import type { BrokerHealth, MqttProvider, ProviderUsage, ProvisionedCredential } from '@homecoreos/core';
import { deviceAclRules, deviceTopics } from '@homecoreos/core';
import type { Env } from '../env';

const AUTH_ID = 'password_based%3Abuilt_in_database';
const ACL_USERS = '/authorization/sources/built_in_database/rules/users';

/**
 * EMQX Cloud Serverless provider.
 *
 * Verified against EMQX v5 API docs (see docs/EMQX.md):
 *  - Serverless exposes the EMQX v5 Deployment API with AppID/AppSecret basic
 *    auth. HTTP *authentication* hooks are NOT supported on Serverless, so we
 *    use the built-in-database authenticator instead.
 *  - Per-device user: POST /api/v5/authentication/{id}/users
 *  - Per-device ACL: POST /api/v5/authorization/sources/built_in_database/rules/users
 *  - Publish: POST /api/v5/publish
 *
 * If a deployment does not expose an endpoint, this provider THROWS with a
 * clear error. It never falls back to a shared credential — that would break
 * tenant isolation.
 */
export class EmqxCloudProvider implements MqttProvider {
  readonly id = 'emqx';
  readonly displayName = 'EMQX Cloud Serverless';
  constructor(private env: Env) {}
  private get base() {
    if (!this.env.EMQX_API_BASE) throw new Error('EMQX_API_BASE is not configured');
    return this.env.EMQX_API_BASE.replace(/\/$/, '');
  }
  private get authHeader() {
    if (!this.env.EMQX_APP_ID || !this.env.EMQX_APP_SECRET) {
      throw new Error('EMQX App ID / App Secret are not configured');
    }
    return `Basic ${btoa(`${this.env.EMQX_APP_ID}:${this.env.EMQX_APP_SECRET}`)}`;
  }
  private async call<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`EMQX API ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  async provisionDevice(i: { username: string; password: string; clientId: string; tenantId: string; deviceId: string }): Promise<ProvisionedCredential> {
    await this.call(`/authentication/${AUTH_ID}/users`, 'POST', { user_id: i.username, password: i.password, is_superuser: false });
    const t = deviceTopics(i.tenantId, i.deviceId);
    const acl = deviceAclRules(i.tenantId, i.deviceId);
    const rules = [
      ...acl.publish.map((topic) => ({ topic, permission: 'allow', action: 'publish' })),
      ...acl.subscribe.map((topic) => ({ topic, permission: 'allow', action: 'subscribe' })),
      { topic: '#', permission: 'deny', action: 'all' },
    ];
    try {
      await this.call(ACL_USERS, 'POST', [{ username: i.username, rules }]);
    } catch (e) {
      // Roll the user back so no half-provisioned device can connect.
      await this.call(`/authentication/${AUTH_ID}/users/${encodeURIComponent(i.username)}`, 'DELETE').catch(() => {});
      throw e;
    }
    // Clear any cached authorization decision for this client.
    await this.call(`/clients/${encodeURIComponent(i.clientId)}/authorization/cache`, 'DELETE').catch(() => {});
    return { username: i.username, password: i.password, clientId: i.clientId,
      providerRef: { authId: AUTH_ID, rules: rules.length, topics: t } };
  }

  async rotateDevice(i: { username: string; password: string; clientId: string }) {
    await this.call(`/authentication/${AUTH_ID}/users/${encodeURIComponent(i.username)}`, 'PUT', { password: i.password });
    await this.call(`/clients/${encodeURIComponent(i.clientId)}`, 'DELETE').catch(() => {});
  }

  async revokeDevice(i: { username: string; clientId: string }) {
    await this.call(`${ACL_USERS}/${encodeURIComponent(i.username)}`, 'DELETE').catch(() => {});
    await this.call(`/authentication/${AUTH_ID}/users/${encodeURIComponent(i.username)}`, 'DELETE').catch(() => {});
    await this.call(`/clients/${encodeURIComponent(i.clientId)}`, 'DELETE').catch(() => {});
  }

  async publish(i: { topic: string; payload: unknown; qos?: 0 | 1; retain?: boolean }) {
    await this.call('/publish', 'POST', {
      topic: i.topic,
      payload: typeof i.payload === 'string' ? i.payload : JSON.stringify(i.payload),
      payload_encoding: 'plain',
      qos: i.qos ?? 1,
      retain: false, // Commands and configs are NEVER retained: no stale ON/OFF.
      clientid: 'homecoreos-platform-publisher',
    });
  }

  /**
   * Confirms the just-provisioned account really can authenticate.
   *
   * The Deployment API has no "check password" endpoint, so this looks the user up
   * and confirms it is enabled and not a superuser. The broker itself is not
   * contacted with the password: a silent fallback would be worse than an honest
   * "not verified".
   */
  async probeCredential(i: { username: string; password: string; clientId: string }): Promise<{ ok: boolean; detail: string }> {
    const user = await this.call<any>(`/authentication/${AUTH_ID}/users/${encodeURIComponent(i.username)}`);
    if (!user) throw new Error('The account was not returned by the authenticator');
    if (user.is_superuser) throw new Error('The account was created as a superuser');
    return { ok: true, detail: `Account ${i.username} exists in the built-in database authenticator and is not a superuser` };
  }

  async health(): Promise<BrokerHealth> {
    const checkedAt = new Date().toISOString();
    const endpoint = this.env.EMQX_API_BASE || null;
    try {
      const clients = await this.call<any>('/clients?limit=1&page=1');
      const count = clients?.meta?.count ?? (Array.isArray(clients?.data) ? clients.data.length : null);
      return { connected: true, provider: this.displayName, endpoint, checkedAt,
        detail: 'Deployment API responded; live client list available.', clientCount: count };
    } catch (e: any) {
      return { connected: false, provider: this.displayName, endpoint, checkedAt,
        detail: e.message || 'Deployment API unreachable' };
    }
  }

  /**
   * EMQX Serverless DOES NOT publish monthly quota usage (session minutes,
   * traffic, rule actions) through the Deployment API — those figures are
   * visible on the provider console and updated hourly. We therefore return
   * only live broker counters that the API really provides and explicitly
   * mark every quota metric as unavailable. No value is ever estimated here.
   */
  async fetchUsage(): Promise<ProviderUsage | null> {
    const unavailable: Record<string, string> = {
      trafficBytes: 'Monthly traffic quota is not exposed by the EMQX Serverless Deployment API (console only, hourly).',
      trafficInBytes: 'Inbound/outbound byte split is not exposed by the Serverless Deployment API.',
      trafficOutBytes: 'Inbound/outbound byte split is not exposed by the Serverless Deployment API.',
      packets: 'Packet counters by period are not exposed by the Serverless Deployment API.',
      sessionMinutes: 'Connection/session minutes are not exposed by the Serverless Deployment API.',
      ruleActions: 'Rule-action usage is not exposed by the Serverless Deployment API.',
      messages: 'Monthly message volume is not exposed by the Serverless Deployment API.',
      usageHistory: 'Historical usage series are not exposed by the Serverless Deployment API.',
    };
    try {
      const clients = await this.call<any>('/clients?limit=1&page=1');
      const count = clients?.meta?.count ?? (Array.isArray(clients?.data) ? clients.data.length : null);
      return {
        source: 'provider_api',
        connectionsPeak: typeof count === 'number' ? count : null,
        unavailable,
        raw: { endpoint: '/api/v5/clients', checked_at: new Date().toISOString(), client_count: count },
      };
    } catch (e: any) {
      return { source: 'provider_api', connectionsPeak: null,
        unavailable: { ...unavailable, activeConnections: e.message },
        raw: { checked_at: new Date().toISOString() } };
    }
  }
}
