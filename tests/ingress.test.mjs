/**
 * Ingress acceptance: the MQTT→Postgres path used by both the local broker and
 * the Cloudflare Durable Object bridge. Verifies that identity comes from the
 * database (never from JSON), and that mismatched topics/devices are rejected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestDb, seed, rpc } from './helpers/pglite.mjs';
import { deviceTopics } from '@helios/core';
import { handleIngress } from '../apps/api/src/app.ts';
import { PGliteAdapter } from '../apps/api/src/db/adapters.ts';
import { createMqttProvider } from '../apps/api/src/providers/index.ts';
import { EventBus } from '../apps/api/src/services/runtime.ts';

const db = await createTestDb({ withData: false });
const S = await seed(db);
const data = new PGliteAdapter(db);
const env = { DB_DRIVER: 'pglite', MQTT_PROVIDER: 'local', JWT_SECRET: 'test-jwt-secret' };
const events = new EventBus();
const rt = {
  env, db: data, auth: {}, mqtt: createMqttProvider(env), store: null, events,
  emit: (tenantId, type, payload = {}) => events.publish(tenantId, { type, ...payload }),
};

const tokenHash = randomBytes(32).toString('hex');
await rpc(db, 'rpc_create_pairing_token', { p_actor: S.A, p_tenant: S.tA,
  p_data: { token_hash: tokenHash, catalog_board_id: 'espressif.esp32-devkitc-v4.wroom32e' } });
const claimed = await rpc(db, 'rpc_claim_pairing_token', {
  p_token_hash: tokenHash, p_device_id: 'esp32-ingress', p_client_id: 'client-ingress',
  p_password_hash: 'pbkdf2$1$a$b', p_username: 'u-ingress', p_provider_ref: {},
});
assert.equal(claimed.tenant_id, S.tA);

const sensor = await rpc(db, 'rpc_create_sensor', { p_actor: S.A, p_tenant: S.tA,
  p_data: { name: 'Ingress Temp', category: 'temperature', user_board_id: claimed.board_id,
    interface: 'adc', gpio: 32, unit: 'celsius', min_valid: -20, max_valid: 80 } });
const topics = deviceTopics(S.tA, claimed.device_id);

const message = (extra = {}) => ({
  schema_version: 1, device_id: claimed.device_id, timestamp: 1794110000,
  sensors: { [sensor.slug]: { value: 24.5, unit: 'celsius', status: 'valid' } }, ...extra,
});

test('0015 lookup resolves tenant/device without an MQTT client id', async () => {
  const row = await rpc(db, 'rpc_board_from_device', { p_tenant: S.tA, p_device_id: claimed.device_id });
  assert.equal(row.tenant_id, S.tA);
  assert.equal(row.device_id, claimed.device_id);
  assert.equal(row.topics.state, topics.state);
  const wrongTenant = await rpc(db, 'rpc_board_from_device', { p_tenant: S.tB, p_device_id: claimed.device_id });
  assert.equal(wrongTenant, null, 'a device cannot be resolved under another tenant');
});

test('INGRESS: forged JSON tenant_id is stripped and rows stay in the real tenant', async () => {
  const r = await handleIngress(rt, { topic: topics.telemetry, payload: message({ tenant_id: S.tB }) });
  assert.equal(r.accepted, 1, JSON.stringify(r));
  const rows = await db.query(`select tenant_id, value from sensor_readings`);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].tenant_id, S.tA);
});

test('INGRESS: authenticated client id path also ignores payload tenant_id', async () => {
  const r = await handleIngress(rt, { clientId: claimed.mqtt_client_id, topic: topics.telemetry,
    payload: JSON.stringify(message({ tenantId: S.tB })) });
  assert.equal(r.accepted, 1, JSON.stringify(r));
  const rows = await db.query(`select tenant_id from sensor_readings`);
  assert.equal(rows.rows.length, 2);
  assert.ok(rows.rows.every((x) => x.tenant_id === S.tA));
});

test('INGRESS: mismatched topic, device id, publish kind and invalid schema are rejected', async () => {
  const wrongTenant = await handleIngress(rt, { topic: deviceTopics(S.tB, claimed.device_id).telemetry, payload: message() });
  assert.equal(wrongTenant.ignored, true);
  const wrongDevice = await handleIngress(rt, { topic: topics.telemetry, payload: message({ device_id: 'esp32-other' }) });
  assert.equal(wrongDevice.ignored, true);
  const commandTopic = await handleIngress(rt, { topic: topics.command, payload: message() });
  assert.equal(commandTopic.ignored, true, 'devices may not publish to command topics');
  const badSchema = await handleIngress(rt, { topic: topics.telemetry, payload: { schema_version: 1 } });
  assert.equal(badSchema.ignored, true);
  const invalidUnit = await handleIngress(rt, { topic: topics.telemetry,
    payload: { ...message(), sensors: { [sensor.slug]: { value: 1, unit: 'kelvin', status: 'valid' } } } });
  assert.equal(invalidUnit.accepted, 0);
  const rows = await db.query(`select count(*)::int n from sensor_readings`);
  assert.equal(rows.rows[0].n, 2, 'no rejected message was stored');
});
