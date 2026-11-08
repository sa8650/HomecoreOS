import type { BrokerHealth, MqttProvider, ProviderUsage, ProvisionedCredential } from '@homecoreos/core';

/**
 * Local development provider — a real MQTT broker (Aedes) with the SAME
 * per-device username/password + per-device publish/subscribe ACL enforced by
 * the broker via the API's /internal/mqtt/auth and /internal/mqtt/acl handlers.
 * Swapping this for EmqxCloudProvider requires no application changes.
 */
export class LocalMqttProvider implements MqttProvider {
  readonly id = 'local';
  readonly displayName = 'Local EMQX-compatible broker (development)';
  private client: any = null;
  constructor(private cfg: { brokerUrl: string; apiBase?: string; adminUrl?: string }) {}

  private async connect() {
    if (this.client?.connected) return this.client;
    const mqtt = await import('mqtt');
    this.client = mqtt.connect(this.cfg.brokerUrl, {
      username: 'homecoreos-platform', password: process.env.MQTT_BRIDGE_PASSWORD || 'local-dev-bridge',
      clientId: 'homecoreos-platform-publisher', clean: true, reconnectPeriod: 1000,
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Local MQTT broker connection timeout')), 5000);
      this.client.once('connect', () => { clearTimeout(t); resolve(); });
      this.client.once('error', (e: Error) => { clearTimeout(t); reject(e); });
    });
    return this.client;
  }

  async provisionDevice(i: { username: string; password: string; clientId: string; tenantId: string; deviceId: string }): Promise<ProvisionedCredential> {
    // The broker validates credentials against mqtt_credentials_metadata and
    // derives the ACL from the DB, so nothing extra needs registering here.
    return { username: i.username, password: i.password, clientId: i.clientId,
      providerRef: { provider: 'local-aedes', aclSource: 'internal/mqtt/acl' } };
  }
  async rotateDevice() { /* broker re-reads the active credential on reconnect */ }
  async revokeDevice(i: { clientId: string }) {
    const c = await this.connect();
    // Aedes disconnects clients when authz state changes; kick via admin API.
    if (this.cfg.adminUrl) {
      await fetch(`${this.cfg.adminUrl}/kick`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: i.clientId }) }).catch(() => {});
    }
    void c;
  }
  async publish(i: { topic: string; payload: unknown; qos?: 0 | 1; retain?: boolean }) {
    const c = await this.connect();
    await new Promise<void>((resolve, reject) => {
      c.publish(i.topic, typeof i.payload === 'string' ? i.payload : JSON.stringify(i.payload),
        { qos: i.qos ?? 1, retain: false }, (e?: Error) => e ? reject(e) : resolve());
    });
  }
  async health(): Promise<BrokerHealth> {
    try {
      await this.connect();
      return { connected: true, provider: this.displayName, endpoint: this.cfg.brokerUrl,
        checkedAt: new Date().toISOString(), detail: 'Local broker connection is alive.' };
    } catch (e: any) {
      return { connected: false, provider: this.displayName, endpoint: this.cfg.brokerUrl,
        checkedAt: new Date().toISOString(), detail: e.message };
    }
  }
  async fetchUsage(): Promise<ProviderUsage | null> {
    if (!this.cfg.adminUrl) return null;
    try {
      const res = await fetch(`${this.cfg.adminUrl}/stats`);
      if (!res.ok) return null;
      const stats = await res.json() as any;
      return { source: 'provider_api', connectionsPeak: stats.clients ?? null,
        messages: stats.messages ?? null, packets: stats.packets ?? null,
        unavailable: {
          trafficBytes: 'Local development broker does not report byte-level quota usage.',
          sessionMinutes: 'Local development broker does not report session minutes.',
          ruleActions: 'Not applicable to a development broker.',
        }, raw: stats };
    } catch { return null; }
  }
}

