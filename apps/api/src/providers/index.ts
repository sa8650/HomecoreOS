import type { MqttProvider } from '@helios/core';
import type { Env } from '../env';
import { EmqxCloudProvider } from './emqx';
import { LocalMqttProvider } from './local';

/**
 * Provider factory — the ONLY place that knows which MQTT backend is in use.
 * Set MQTT_PROVIDER=emqx (production) or local (development). Migrating to a
 * self-hosted EMQX/Mosquitto means adding one adapter implementing MqttProvider.
 */
export function createMqttProvider(env: Env): MqttProvider {
  if (String(env.MQTT_PROVIDER || (env.DB_DRIVER === 'supabase' ? 'emqx' : 'local')) === 'emqx') {
    return new EmqxCloudProvider(env);
  }
  return new LocalMqttProvider({
    brokerUrl: String(env.MQTT_BRIDGE_URL || 'mqtt://127.0.0.1:1883'),
    adminUrl: String(env.MQTT_BROKER_ADMIN_URL || 'http://127.0.0.1:1884'),
  });
}
export { EmqxCloudProvider, LocalMqttProvider };
