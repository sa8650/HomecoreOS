/**
 * Independent Cloudflare D1 configuration tests.
 *
 * These run in-process against a faithful D1 binding emulator (sql.js) with the
 * SAME generated schema/seed the Pages Function uses, so the D1 path is tested
 * separately from the Supabase/Postgres path in schema.test.mjs / api.test.mjs.
 * Covers: schema parity, setup wizard, encrypted secrets, Test Connection,
 * native R2 round-trip, device communication, backup and provider migration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqliteD1 } from '../apps/api/src/db/sqlite-d1.ts';
import { D1Adapter } from '../apps/api/src/db/d1.ts';
import { D1_TABLES, D1_COLUMNS, D1_SCHEMA_SQL } from '../apps/api/src/db/d1-schema.ts';
import { createApp, handleIngress } from '../apps/api/src/app.ts';
import { createAuth } from '../apps/api/src/auth.ts';
import { EventBus, createStore } from '../apps/api/src/services/runtime.ts';
import { detectProvider, effectiveEnv, migrationToken, exportBackup } from '../apps/api/src/config.ts';
import { deviceTopics } from '@homecoreos/core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const hex64 = () => randomBytes(32).toString('hex');

function fakeBucket() {
  const data = new Map();
  return {
    data,
    async put(key, bytes) { data.set(key, new Uint8Array(bytes)); },
    async get(key) {
      const v = data.get(key);
      return v ? { async arrayBuffer() { return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength); } } : null;
    },
    async delete(key) { data.delete(key); },
  };
}

function fakeMqtt() {
  const published = [];
  return {
    published, id: 'test', displayName: 'Test MQTT broker',
    async provisionDevice(i) { return { ...i, providerRef: {} }; },
    async revokeDevice() {}, async rotateDevice() {},
    async publish(i) { published.push(i); },
    async health() { return { connected: true, provider: 'test', endpoint: 'test', checkedAt: new Date().toISOString(), detail: 'ok' }; },
    async fetchUsage() { return null; },
  };
}

async function makeRuntime() {
  const d1 = await SqliteD1.create();
  await d1.migrate();
  const db = new D1Adapter(d1);
  const SECRETS_KEY = hex64();
  const bootstrap = {
    SECRETS_KEY, DB_DRIVER: 'd1', DATABASE_PROVIDER: 'd1',
    JWT_SECRET: SECRETS_KEY, INGRESS_HMAC_SECRET: 'test-ingress-hmac',
    MQTT_PROVIDER: 'local', PUBLIC_API_BASE: 'http://local',
    DB: d1, FIRMWARE_BUCKET: fakeBucket(),
  };
  const env = effectiveEnv(bootstrap, {});
  const events = new EventBus();
  const mqtt = fakeMqtt();
  const rt = {
    env, db, auth: createAuth(db, env), mqtt, store: createStore(env), events,
    emit: (tenantId, type, payload = {}) => events.publish(tenantId, { type, ...payload }),
    provider: 'd1', bootstrap,
  };
  const app = createApp(rt);
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await app.fetch(new Request(`http://local${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, undefined);
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return { rt, db, d1, app, call, env, mqtt, bucket: bootstrap.FIRMWARE_BUCKET };
}

test('D1: schema is generated from the same Postgres migrations (parity)', async () => {
  const { db } = await makeRuntime();
  const pgTables = new Set();
  for (const f of readdirSync(MIGRATIONS).filter((x) => /^000[2-5]_.*\.sql$/.test(x))) {
    const sql = readFileSync(resolve(MIGRATIONS, f), 'utf8');
    for (const m of sql.matchAll(/create\s+table\s+if\s+not\s+exists\s+public\.([a-z_][a-z0-9_]*)/gi)) pgTables.add(m[1]);
  }
  assert.equal(D1_TABLES.length, pgTables.size, 'D1 must have the same number of tables as Postgres');
  for (const t of pgTables) assert.ok(D1_TABLES.includes(t), `missing D1 table ${t}`);
  assert.ok(D1_COLUMNS.platform_secrets.includes('ciphertext'));
  assert.ok(D1_COLUMNS.firmware_releases.includes('sha256'));
  assert.ok(D1_SCHEMA_SQL.includes('FIRMWARE_BUCKET') === false, 'bindings are not hardcoded in schema');
  const health = await db.health();
  assert.equal(health.connected, true);
  assert.ok(health.tables >= 39);
  assert.equal((await db.select('board_catalog_pins')).length, 106, 'all 106 verified pins must be seeded');
  assert.equal((await db.select('board_catalog')).length, 9);
  assert.equal((await db.select('permissions')).length, 12);
});

test('D1: first signup becomes owner; initial setup wizard + checklist', async () => {
  const { call } = await makeRuntime();
  const signup = await call('/api/auth/signup', { method: 'POST', body: {
    email: 'd1-owner@example.test', password: 'D1OwnerPass123!', full_name: 'D1 Owner', home_name: 'D1 Home',
  } });
  assert.equal(signup.status, 201);
  const token = signup.data.token;
  const ctx = await call('/api/context', { token });
  assert.equal(ctx.status, 200);
  assert.equal(ctx.data.tenant.name, 'D1 Home');

  const setup = await call('/api/owner/setup', { token });
  assert.equal(setup.status, 200);
  assert.equal(setup.data.provider, 'd1');
  assert.equal(setup.data.wizard.needs_selection, true);
  assert.equal(setup.data.checklist.length, 6);
  assert.deepEqual(setup.data.checklist.map((x) => x.label), [
    'Database configured', 'R2 bucket connected', 'EMQX API connected',
    'MQTT broker connected', 'Encryption initialized', 'Firmware storage ready',
  ]);
  const bindings = setup.data.bindings.map((b) => b.name);
  assert.deepEqual(bindings, ['DB', 'FIRMWARE_BUCKET']);
  assert.ok(setup.data.bindings.every((b) => b.connected));
  // D1 must not ask the owner for Supabase variables, but EMQX stays required.
  const supabaseFields = ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_ANON_KEY','SUPABASE_JWT_SECRET'];
  const requested = [...setup.data.required, ...setup.data.optional, ...setup.data.encrypted_secrets].map((f) => f.key);
  assert.ok(supabaseFields.every((k) => !requested.includes(k)), 'D1 must not request Supabase variables');
  assert.equal(setup.data.groups.find((g) => g.id === 'supabase').applicable, false);
  assert.equal(setup.data.groups.find((g) => g.id === 'emqx').applicable, true);
  assert.ok(requested.includes('EMQX_APP_SECRET'), 'EMQX credentials remain required on D1');

  const selected = await call('/api/owner/setup/provider', { method: 'POST', token, body: { provider: 'd1' } });
  assert.equal(selected.status, 201);
  const again = await call('/api/owner/setup/provider', { method: 'POST', token, body: { provider: 'supabase' } });
  assert.equal(again.status, 409, 'switching is not a settings toggle');
  assert.match(again.data.error, /data migration/i);

  const customer = await call('/api/auth/signup', { method: 'POST', body: {
    email: 'd1-customer@example.test', password: 'D1Customer123!', home_name: 'Customer Home',
  } });
  const forbidden = await call('/api/owner/setup', { token: customer.data.token });
  assert.equal(forbidden.status, 403, 'ordinary customers never see technical configuration');
});

test('D1: owner secrets are encrypted at rest, masked, rotatable and removable', async () => {
  const { call, db } = await makeRuntime();
  const signup = await call('/api/auth/signup', { method: 'POST', body: {
    email: 'd1-secrets@example.test', password: 'SecretsPass123!', home_name: 'Secrets Home',
  } });
  const token = signup.data.token;
  const secret = 'app-secret-do-not-leak-9f3a';
  const saved = await call('/api/owner/integrations', { method: 'PUT', token, body: { secrets: {
    EMQX_API_BASE: 'https://emqx.example.test/api/v5', EMQX_APP_ID: 'app-id',
    EMQX_APP_SECRET: secret, EMQX_BROKER_HOST: 'emqx.example.test', EMQX_TLS_PORT: '8883',
  } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.saved, 5);
  assert.equal(saved.data.secrets_masked, true);
  assert.ok(!JSON.stringify(saved.data).includes(secret));

  const rows = await db.select('platform_secrets');
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => !JSON.stringify(r).includes(secret)), 'ciphertext must not contain plaintext');
  const before = rows.find((r) => r.key === 'EMQX_APP_SECRET').fingerprint;

  const integrations = await call('/api/owner/integrations', { token });
  assert.ok(!JSON.stringify(integrations.data).includes(secret), 'never display a saved value again');
  const field = integrations.data.groups.find((g) => g.id === 'emqx').fields.find((f) => f.key === 'EMQX_APP_SECRET');
  assert.equal(field.configured, true);
  assert.equal(field.masked, '••••••••••••');

  const rotated = await call('/api/owner/integrations/rotate/EMQX_APP_SECRET', { method: 'POST', token, body: { value: 'rotated-value-abc' } });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.data.fingerprint, before);
  assert.ok(!JSON.stringify(rotated.data).includes('rotated-value-abc'));

  const removed = await call('/api/owner/integrations/EMQX_APP_SECRET', { method: 'DELETE', token });
  assert.equal(removed.status, 200);
  assert.equal((await db.select('platform_secrets', { eq: { key: 'EMQX_APP_SECRET' } })).length, 0);

  const bad = await call('/api/owner/integrations', { method: 'PUT', token, body: { secrets: { SUPABASE_SERVICE_ROLE_KEY: 'x' } } });
  assert.equal(bad.status, 200);
  assert.equal(bad.data.saved, 0, 'bootstrap-only keys cannot be written through the console');
});

test('D1: Test Connection reports status, last success and useful errors', async () => {
  const { call } = await makeRuntime();
  const signup = await call('/api/auth/signup', { method: 'POST', body: {
    email: 'd1-test@example.test', password: 'TestConn123!', home_name: 'Test Home',
  } });
  const token = signup.data.token;
  const missing = await call('/api/owner/integrations/test', { method: 'POST', token, body: { target: 'emqx' } });
  assert.equal(missing.status, 200);
  assert.equal(missing.data.connected, false);
  assert.match(missing.data.detail, /EMQX_API_BASE/);
  assert.ok(missing.data.hint);

  await call('/api/owner/integrations', { method: 'PUT', token, body: { secrets: {
    EMQX_API_BASE: 'https://emqx.example.test/api/v5', EMQX_APP_ID: 'app', EMQX_APP_SECRET: 'secret',
  } } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes('/clients'), 'must call the EMQX Deployment API');
    return new Response(JSON.stringify({ meta: { count: 2 }, data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const ok = await call('/api/owner/integrations/test', { method: 'POST', token, body: { target: 'emqx' } });
    assert.equal(ok.data.connected, true);
    assert.equal(ok.data.clientCount, 2);
    const st = await call('/api/owner/integrations', { token });
    assert.equal(st.data.connections.emqx.connected, true);
    assert.ok(st.data.connections.emqx.last_success);
  } finally { globalThis.fetch = realFetch; }
});

test('D1: native R2 binding upload/download + signed OTA URL', async () => {
  const { call, bucket, rt } = await makeRuntime();
  const signup = await call('/api/auth/signup', { method: 'POST', body: {
    email: 'd1-r2@example.test', password: 'R2RoundTrip123!', home_name: 'R2 Home',
  } });
  const token = signup.data.token;
  const claim = await (async () => {
    const pairing = await call('/api/pairing-tokens', { method: 'POST', token, body: {
      catalog_board_id: 'espressif.esp32-devkitc-v4.wroom32e', board_name: 'R2 Board',
    } });
    return call('/api/device/claim', { method: 'POST', body: { pairing_token: pairing.data.token } });
  })();
  assert.equal(claim.status, 201, JSON.stringify(claim.data));

  const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x48, 0x4f, 0x4d, 0x45]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const release = await call('/api/firmware/releases', { method: 'POST', token, body: {
    version: '1.0.0', status: 'published', binary_base64: Buffer.from(bytes).toString('base64'), sha256: digest,
  } });
  assert.equal(release.status, 201, JSON.stringify(release.data));
  assert.equal(bucket.data.size, 1, 'binary really written to the R2 binding');

  const ota = await call('/api/firmware/ota', { method: 'POST', token, body: { release_id: release.data.id, board_id: claim.data.board_id } });
  assert.equal(ota.status, 200, JSON.stringify(ota.data));
  const url = new URL(ota.data.download_url, 'http://local');
  const fetched = await call(`${url.pathname}${url.search}`, { token });
  assert.equal(fetched.status, 200, JSON.stringify(fetched.data));
  assert.equal(fetched.headers.get('X-Checksum'), digest);
  assert.equal(fetched.headers.get('Cache-Control'), 'private, no-store');

  const tampered = await call(`${url.pathname}${url.search.replace(/sig=[^&]+/, 'sig=deadbeef')}`, { token });
  assert.equal(tampered.status, 403);
  const expired = await call(`${url.pathname}${url.search.replace(/expires=\d+/, 'expires=1')}`, { token });
  assert.equal(expired.status, 403);

  const probe = await call('/api/owner/setup/test-bucket', { method: 'POST', token, body: {} });
  assert.equal(probe.data.connected, true, JSON.stringify(probe.data));
});

test('D1: MQTT device communication, tenant isolation and command ledger', async () => {
  const { call, rt } = await makeRuntime();
  const signup = await call('/api/auth/signup', { method: 'POST', body: {
    email: 'd1-device@example.test', password: 'DevicePass123!', home_name: 'Device Home',
  } });
  const token = signup.data.token;
  const ctx = await call('/api/context', { token });
  const tenantId = ctx.data.tenant.id;

  const pairing = await call('/api/pairing-tokens', { method: 'POST', token, body: {
    catalog_board_id: 'espressif.esp32-devkitc-v4.wroom32e', board_name: 'Comm Board',
  } });
  const claim = await call('/api/device/claim', { method: 'POST', body: { pairing_token: pairing.data.token } });
  const boardId = claim.data.board_id, deviceId = claim.data.device_id;

  const sensor = await call('/api/sensors', { method: 'POST', token, body: {
    name: 'Room Temp', category: 'temperature', user_board_id: boardId,
    interface: 'adc', gpio: 32, unit: 'celsius', min_valid: -20, max_valid: 80,
  } });
  assert.equal(sensor.status, 201, JSON.stringify(sensor.data));
  const slug = sensor.data.slug;
  const topics = deviceTopics(tenantId, deviceId);

  // Forged tenant_id in the payload must not change the stored tenant.
  const telemetry = await handleIngress(rt, { clientId: claim.data.mqtt.client_id,
    topic: topics.telemetry, payload: { schema_version: 1, device_id: deviceId,
      timestamp: Math.floor(Date.now() / 1000), tenant_id: randomBytes(12).toString('hex'),
      sensors: { [slug]: { value: 26.5, unit: 'celsius' } } } });
  assert.equal(telemetry.accepted, 1, JSON.stringify(telemetry));
  const readings = await rt.db.select('sensor_readings');
  assert.equal(readings.length, 1);
  assert.equal(readings[0].tenant_id, tenantId);

  const device = await call('/api/devices', { method: 'POST', token, body: {
    name: 'Lamp', user_board_id: boardId, output_gpio: 5, device_type: 'light',
  } });
  assert.equal(device.status, 201, JSON.stringify(device.data));
  const cmd = await call(`/api/devices/${device.data.id}/command`, { method: 'POST', token, body: { action: 'set_state', value: true } });
  assert.equal(cmd.status, 202, JSON.stringify(cmd.data));
  assert.ok(rt.mqtt.published.some((p) => p.topic === topics.command), 'command published to device topic');

  const ack = await handleIngress(rt, { clientId: claim.data.mqtt.client_id,
    topic: topics.state, payload: { command_id: cmd.data.command.id, component_id: device.data.slug,
      status: 'confirmed', actual_state: true } });
  assert.equal(ack.ok, true);
  const commands = await rt.db.select('device_commands');
  assert.equal(commands[0].status, 'acknowledged');

  const gpioConflict = await call('/api/devices', { method: 'POST', token, body: {
    name: 'Duplicate GPIO', user_board_id: boardId, output_gpio: 5, device_type: 'light',
  } });
  assert.equal(gpioConflict.status, 500); // surfaced as an error, never silently accepted
  assert.match(gpioConflict.data.error, /already allocated/);
});

test('D1: provider switch requires an exported backup and a matching migration token', async () => {
  const { call, db, rt } = await makeRuntime();
  const signup = await call('/api/auth/signup', { method: 'POST', body: {
    email: 'd1-migrate@example.test', password: 'MigratePass123!', home_name: 'Migrate Home',
  } });
  const token = signup.data.token;
  await call('/api/rooms', { method: 'POST', token, body: { name: 'Keep This Room' } });
  const selected = await call('/api/owner/setup/provider', { method: 'POST', token, body: { provider: 'd1' } });
  assert.equal(selected.status, 201);

  const backup = await call('/api/owner/setup/backup', { token });
  assert.equal(backup.data.schema_version, 1);
  assert.equal(typeof backup.data.migration_token, 'string');
  assert.equal((await migrationToken(backup.data, rt.env)), backup.data.migration_token);

  // Simulate a previous Supabase selection (the runtime has already switched to D1).
  await db.upsert('platform_settings', { key: 'platform.database_provider', value: 'supabase' }, ['key']);
  const noToken = await call('/api/owner/setup/switch', { method: 'POST', token, body: {
    provider: 'd1', backup: backup.data, migration_token: 'wrong', confirm: 'MIGRATE',
  } });
  assert.equal(noToken.status, 400);
  assert.match(noToken.data.error, /token/i);

  const switched = await call('/api/owner/setup/switch', { method: 'POST', token, body: {
    provider: 'd1', backup: backup.data, migration_token: backup.data.migration_token, confirm: 'MIGRATE',
  } });
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  assert.equal(switched.data.migrated, true);
  assert.equal(switched.data.to, 'd1');
  assert.ok(switched.data.imported_rows > 0);
  const rooms = await db.select('rooms');
  assert.ok(rooms.some((r) => r.name === 'Keep This Room'), 'data survived the provider migration');
  assert.equal((await db.select('platform_settings', { eq: { key: 'platform.database_provider' } }))[0].value, 'd1');

  // Portable backup works for both provider shapes.
  const portable = await exportBackup(db, 'd1');
  assert.equal(portable.schema_version, 1);
  assert.ok(portable.tables.rooms.length >= 1);
});

test('Config: exactly one provider is detected from bindings or bootstrap values', async () => {
  assert.equal(detectProvider({ DB: {} }), 'd1');
  assert.equal(detectProvider({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }), 'supabase');
  assert.equal(detectProvider({ DB: {}, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }), 'd1',
    'native DB binding wins; never both databases');
  assert.equal(detectProvider({}), null);
  await assert.rejects(() => migrationToken({ tables: {} }, { SECRETS_KEY: 'short' }), /SECRETS_KEY/);
});
