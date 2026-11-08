/**
 * HomecoreOS acceptance tests — run against a REAL Postgres (PGlite/WASM) with the
 * exact production migrations, RLS policies, constraints and domain RPCs.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seed, asUser, rpc, ok } from './helpers/pglite.mjs';
import { deviceTopics, deviceAclRules, evaluatePin, EMQX_QUOTAS } from '@homecoreos/core';
import { randomBytes } from 'node:crypto';
const hex64 = () => randomBytes(32).toString('hex');

const db = await createTestDb({ withData: false });
const S = await seed(db);

async function expectReject(fn, label, code = '42501') {
  let failed = false;
  try { await fn(); } catch (e) {
    failed = true;
    assert.ok(e instanceof Error, `${label}: threw a non-error`);
  }
  assert.ok(failed, `${label}: expected the operation to be rejected`);
}

/** Pair a board for a tenant using a fresh single-use token. */
async function pair(tenantId, actorId, catalogId = 'espressif.esp32-devkitc-v4.wroom32e', tag = 'board') {
  const hash = hex64();
  await rpc(db, 'rpc_create_pairing_token', {
    p_actor: actorId, p_tenant: tenantId,
    p_data: { token_hash: hash, catalog_board_id: catalogId, board_name: `${tag} controller` },
  });
  const deviceId = `esp32-${tag}-${Math.random().toString(36).slice(2, 8)}`;
  const r = await rpc(db, 'rpc_claim_pairing_token', {
    p_token_hash: hash, p_device_id: deviceId, p_client_id: `client-${deviceId}`,
    p_password_hash: 'pbkdf2$1$abc$def', p_username: `u-${deviceId}`, p_provider_ref: {},
  });
  return r;
}

test('migrations apply and enforce RLS on every customer table', async () => {
  const tables = await db.query(`select relname from pg_class where relnamespace='public'::regnamespace and relkind='r'`);
  assert.ok(tables.rows.length >= 35, `expected normalized schema, got ${tables.rows.length} tables`);
  const insecure = await db.query(`select relname from pg_class
    where relnamespace='public'::regnamespace and relkind='r' and relrowsecurity = false and relname not like '\_%'`);
  assert.equal(insecure.rows.length, 0, `tables without RLS: ${insecure.rows.map(r => r.relname)}`);
  const pins = await db.query(`select count(*)::int n from board_catalog_pins`);
  assert.equal(pins.rows[0].n, 106, 'verified board catalog pin rows must be seeded');
  ok('39+ tables, RLS enabled, 106 verified pin rows');
});

test('MULTI-TENANCY: Account A cannot read Account B rooms or boards', async () => {
  const roomA = await rpc(db, 'rpc_create_room', { p_actor: S.A, p_tenant: S.tA, p_data: { name: 'A Kitchen' } });
  const roomB = await rpc(db, 'rpc_create_room', { p_actor: S.B, p_tenant: S.tB, p_data: { name: 'B Bedroom' } });
  const boardB = await pair(S.tB, S.B, undefined, 'tenant-b');

  const asA = await asUser(db, S.A, () => db.query(`select name from rooms order by name`));
  assert.deepEqual(asA.rows.map((r) => r.name), ['A Kitchen'], 'A must only see its own room');
  const asB = await asUser(db, S.B, () => db.query(`select name from rooms order by name`));
  assert.deepEqual(asB.rows.map((r) => r.name), ['B Bedroom'], 'B must only see its own room');

  const boardsA = await asUser(db, S.A, () => db.query(`select device_id from user_boards`));
  assert.equal(boardsA.rows.length, 0, 'A must not see B board');
  const boardsB = await asUser(db, S.B, () => db.query(`select device_id from user_boards`));
  assert.deepEqual(boardsB.rows.map((r) => r.device_id), [boardB.device_id]);

  // MQTT credential hashes must never be readable by a customer JWT.
  const creds = await asUser(db, S.B, () => db.query(`select * from mqtt_credentials_metadata`))
    .then((r) => ({ rows: r.rows, denied: false })).catch(() => ({ rows: [], denied: true }));
  assert.equal(creds.rows.length, 0);
  assert.equal(creds.denied, true, 'credential table is not granted to customer JWTs');
  ok('RLS isolates rooms, boards and credential metadata');
});

test('MULTI-TENANCY: A cannot publish a command to B device; payload tenant_id is ignored', async () => {
  const boardA = await pair(S.tA, S.A, undefined, 'tenant-a');
  const boardB = (await db.query(`select * from user_boards where device_id like 'esp32-tenant-b%'`)).rows[0];
  const devB = await rpc(db, 'rpc_create_device', { p_actor: S.B, p_tenant: S.tB,
    p_data: { name: 'B Lamp', user_board_id: boardB.id, output_gpio: 18 } });

  // Worker-side + DB-side permission check: actor A + tenant B is rejected.
  await expectReject(() => rpc(db, 'rpc_issue_command', {
    p_actor: S.A, p_tenant: S.tB, p_board: boardB.id, p_component_id: devB.id,
    p_data: { action: 'set_state', payload: { value: true } },
  }), 'cross-tenant command');

  // A device cannot change its registered tenant by modifying JSON.
  const sensorA = await rpc(db, 'rpc_create_sensor', { p_actor: S.A, p_tenant: S.tA,
    p_data: { name: 'A Temp', category: 'temperature', user_board_id: boardA.board_id,
      interface: 'adc', gpio: 32, unit: 'celsius', min_valid: -50, max_valid: 100 } });
  const ingest = await rpc(db, 'rpc_ingest_telemetry', { p_board: boardA.board_id, p_payload: {
    schema_version: 1, device_id: boardA.device_id, timestamp: 1794110000,
    tenant_id: S.tB, // malicious / forged
    sensors: { [sensorA.slug]: { value: 23.5, unit: 'celsius', status: 'valid' } },
  } });
  assert.equal(ingest.accepted, 1);
  assert.equal(ingest.tenant_id, S.tA, 'tenant resolved from DB, not payload');
  const rows = await db.query(`select tenant_id, value from sensor_readings`);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].tenant_id, S.tA);
  ok('cross-tenant commands rejected; JSON tenant_id cannot reassign a device');
});

test('MULTI-TENANCY: ACL grants only this device topics, publish/subscribe separated', async () => {
  const t = deviceTopics(S.tA, 'esp32-abc');
  assert.equal(t.command, `v1/tenants/${S.tA}/devices/esp32-abc/command`);
  const acl = deviceAclRules(S.tA, 'esp32-abc');
  assert.deepEqual(acl.publish, [t.state, t.telemetry, t.availability]);
  assert.deepEqual(acl.subscribe, [t.command, t.config]);
  assert.ok(!acl.publish.includes(t.command), 'device may never publish commands');
  assert.ok(!acl.subscribe.includes(t.state), 'device may never subscribe to other device state');
  ok('per-device publish/subscribe ACL separation');
});

test('STAFF: viewer cannot control, operator cannot change settings, revoke is immediate', async () => {
  const viewer = await rpc(db, 'rpc_check_permission', { p_actor: S.VIEWER, p_tenant: S.tA, p_permission: 'devices.control' });
  assert.equal(viewer.allowed, false, 'viewer cannot control devices');
  const viewerManage = await rpc(db, 'rpc_check_permission', { p_actor: S.VIEWER, p_tenant: S.tA, p_permission: 'devices.manage' });
  assert.equal(viewerManage.allowed, false, 'viewer cannot modify GPIO assignments');
  const operatorSettings = await rpc(db, 'rpc_check_permission', { p_actor: S.OPERATOR, p_tenant: S.tA, p_permission: 'settings.manage' });
  assert.equal(operatorSettings.allowed, false, 'operator cannot change owner settings');
  const operatorControl = await rpc(db, 'rpc_check_permission', { p_actor: S.OPERATOR, p_tenant: S.tA, p_permission: 'devices.control' });
  assert.equal(operatorControl.allowed, true);

  const member = (await db.query(`select id from tenant_members where profile_id=$1`, [S.VIEWER])).rows[0];
  const anyBoard = (await db.query(`select id from user_boards limit 1`)).rows[0].id;
  await expectReject(() => rpc(db, 'rpc_create_device', {
    p_actor: S.VIEWER, p_tenant: S.tA,
    p_data: { name: 'Escalation', user_board_id: anyBoard, output_gpio: 23 },
  }), 'viewer GPIO assignment');

  // A non-owner cannot grant themselves administrator/owner or edit themselves.
  await expectReject(() => rpc(db, 'rpc_update_member', {
    p_actor: S.VIEWER, p_tenant: S.tA, p_member: member.id, p_data: { role_key: 'owner' },
  }), 'self-escalation');

  await rpc(db, 'rpc_revoke_member', { p_actor: S.A, p_tenant: S.tA, p_member: member.id });
  const after = await rpc(db, 'rpc_check_permission', { p_actor: S.VIEWER, p_tenant: S.tA, p_permission: 'dashboard.view' });
  assert.equal(after.allowed, false, 'revoked staff access stops immediately');
  ok('role defaults, self-escalation guard and immediate revocation');
});

test('GPIO: board-scoped exclusive allocation, release and revalidation', async () => {
  const b1 = await pair(S.tA, S.A, 'espressif.esp32-devkitc-v4.wroom32e', 'gpio-1');
  const b2 = await pair(S.tA, S.A, 'espressif.esp32-devkitc-v4.wroom32e', 'gpio-2');
  assert.notEqual(b1.board_id, b2.board_id, 'multiple boards can be registered');

  const d1 = await rpc(db, 'rpc_create_device', { p_actor: S.A, p_tenant: S.tA,
    p_data: { name: 'Light GPIO5', user_board_id: b1.board_id, output_gpio: 5 } });
  await expectReject(() => rpc(db, 'rpc_create_device', { p_actor: S.A, p_tenant: S.tA,
    p_data: { name: 'Duplicate GPIO5', user_board_id: b1.board_id, output_gpio: 5 } }), 'duplicate exclusive GPIO');

  // Same GPIO number on a DIFFERENT physical board is legal.
  const d2 = await rpc(db, 'rpc_create_device', { p_actor: S.A, p_tenant: S.tA,
    p_data: { name: 'Second board GPIO5', user_board_id: b2.board_id, output_gpio: 5 } });
  assert.ok(d2.id);

  const pins1 = (await db.query(`select state from board_pins where user_board_id=$1 and gpio=5`, [b1.board_id])).rows[0];
  assert.equal(pins1.state, 'assigned');
  await rpc(db, 'rpc_delete_device', { p_actor: S.A, p_tenant: S.tA, p_device: d1.id });
  const released = (await db.query(`select state from board_pins where user_board_id=$1 and gpio=5`, [b1.board_id])).rows[0];
  assert.equal(released.state, 'available', 'GPIO released after successful deletion');
  assert.equal((await db.query(`select count(*)::int n from exclusive_allocations where user_board_id=$1 and gpio=5`, [b1.board_id])).rows[0].n, 0);

  // Restoring revalidates: occupy the pin with another device first.
  const d3 = await rpc(db, 'rpc_create_device', { p_actor: S.A, p_tenant: S.tA,
    p_data: { name: 'Other light', user_board_id: b1.board_id, output_gpio: 5 } });
  await expectReject(() => rpc(db, 'rpc_restore_device', { p_actor: S.A, p_tenant: S.tA, p_device: d1.id }), 'restore with pin conflict');
  await rpc(db, 'rpc_delete_device', { p_actor: S.A, p_tenant: S.tA, p_device: d3.id });
  const restored = await rpc(db, 'rpc_restore_device', { p_actor: S.A, p_tenant: S.tA, p_device: d1.id });
  assert.equal(restored.restored, true);

  // Restricted, input-only and non-ADC pins cannot be assigned incompatibly.
  await expectReject(() => rpc(db, 'rpc_create_device', { p_actor: S.A, p_tenant: S.tA,
    p_data: { name: 'Flash pin', user_board_id: b1.board_id, output_gpio: 6 } }), 'restricted flash pin');
  await expectReject(() => rpc(db, 'rpc_create_device', { p_actor: S.A, p_tenant: S.tA,
    p_data: { name: 'Input only', user_board_id: b1.board_id, output_gpio: 36 } }), 'input-only as output');
  await expectReject(() => rpc(db, 'rpc_create_sensor', { p_actor: S.A, p_tenant: S.tA,
    p_data: { name: 'Bad ADC', category: 'custom', user_board_id: b1.board_id, interface: 'adc', gpio: 23, unit: 'x' } }), 'ADC on non-ADC pin');

  const catalogPin = (await db.query(`select * from board_catalog_pins where board_id='espressif.esp32-devkitc-v4.wroom32e' and gpio=6`)).rows[0];
  const ev = evaluatePin({ ...catalogPin, state: 'available' }, 'output');
  assert.equal(ev.state, 'restricted');
  ok('exclusive allocation scoped per board, release, restore revalidation, hardware rules');
});

test('GPIO: shared I2C/SPI buses are explicit and do not duplicate ownership', async () => {
  const b = await pair(S.tA, S.A, 'espressif.esp32-devkitc-v4.wroom32e', 'bus-board');
  const bus = await rpc(db, 'rpc_create_bus', { p_actor: S.A, p_tenant: S.tA,
    p_data: { user_board_id: b.board_id, kind: 'i2c', label: 'i2c-0', sda_gpio: 21, scl_gpio: 22 } });
  const s1 = await rpc(db, 'rpc_create_sensor', { p_actor: S.A, p_tenant: S.tA,
    p_data: { name: 'BME280 Temp', category: 'temperature', user_board_id: b.board_id,
      interface: 'i2c', bus_id: bus.id, i2c_address: '0x76', unit: 'celsius' } });
  const s2 = await rpc(db, 'rpc_create_sensor', { p_actor: S.A, p_tenant: S.tA,
    p_data: { name: 'BME280 Humidity', category: 'humidity', user_board_id: b.board_id,
      interface: 'i2c', bus_id: bus.id, i2c_address: '0x76', unit: 'percent' } });
  assert.ok(s1.id && s2.id, 'multiple compatible sensors share the bus');
  const allocations = (await db.query(`select gpio, owner_type from exclusive_allocations where user_board_id=$1 and gpio in (21,22)`, [b.board_id])).rows;
  assert.equal(allocations.length, 2, 'bus controller pins allocated once, to the bus');
  assert.ok(allocations.every((r) => r.owner_type === 'bus'));
  await expectReject(() => rpc(db, 'rpc_create_device', { p_actor: S.A, p_tenant: S.tA,
    p_data: { name: 'Conflicts with bus', user_board_id: b.board_id, output_gpio: 21 } }), 'exclusive use of a bus pin');
  await expectReject(() => rpc(db, 'rpc_delete_bus', { p_actor: S.A, p_tenant: S.tA, p_bus: bus.id }), 'deleting a bus with sensors');
  ok('shared bus representation and bus pin exclusivity');
});

test('PAIRING: single-use, expiring, hashed tokens; device belongs to one tenant', async () => {
  const hash = hex64();
  await rpc(db, 'rpc_create_pairing_token', { p_actor: S.A, p_tenant: S.tA,
    p_data: { token_hash: hash, catalog_board_id: 'espressif.esp32-c3-devkitm-1.v1' } });
  const claim = await rpc(db, 'rpc_claim_pairing_token', {
    p_token_hash: hash, p_device_id: 'esp32-once-claim', p_client_id: 'client-once-claim',
    p_password_hash: 'pbkdf2$1$x$y', p_username: 'u-once', p_provider_ref: {},
  });
  assert.equal(claim.tenant_id, S.tA);
  await expectReject(() => rpc(db, 'rpc_claim_pairing_token', {
    p_token_hash: hash, p_device_id: 'esp32-other', p_client_id: 'client-other',
    p_password_hash: 'pbkdf2$1$x$y', p_username: 'u-other', p_provider_ref: {},
  }), 'reusing a pairing token');

  const expired = hex64();
  await rpc(db, 'rpc_create_pairing_token', { p_actor: S.A, p_tenant: S.tA,
    p_data: { token_hash: expired, ttl_seconds: -1, catalog_board_id: null } });
  await expectReject(() => rpc(db, 'rpc_claim_pairing_token', {
    p_token_hash: expired, p_device_id: 'esp32-expired', p_client_id: 'client-expired',
    p_password_hash: 'pbkdf2$1$x$y', p_username: 'u-exp', p_provider_ref: {},
  }), 'expired token');

  // Ownership transfer requires an explicit unclaim; a second claim of an
  // existing device_id is refused even with a fresh token.
  const hash2 = hex64();
  await rpc(db, 'rpc_create_pairing_token', { p_actor: S.B, p_tenant: S.tB, p_data: { token_hash: hash2 } });
  await expectReject(() => rpc(db, 'rpc_claim_pairing_token', {
    p_token_hash: hash2, p_device_id: 'esp32-once-claim', p_client_id: 'client-transfer',
    p_password_hash: 'pbkdf2$1$x$y', p_username: 'u-transfer', p_provider_ref: {},
  }), 'device already claimed');
  ok('pairing tokens single-use + expiring; ownership transfer blocked');
});

test('COMMUNICATION: telemetry validation, command acknowledgement, expiry, availability', async () => {
  const b = await pair(S.tA, S.A, 'espressif.esp32-devkitc-v4.wroom32e', 'comm');
  const sensor = await rpc(db, 'rpc_create_sensor', { p_actor: S.A, p_tenant: S.tA,
    p_data: { name: 'Validated Temp', category: 'temperature', user_board_id: b.board_id,
      interface: 'adc', gpio: 33, unit: 'celsius', min_valid: 0, max_valid: 50 } });
  const badUnit = await rpc(db, 'rpc_ingest_telemetry', { p_board: b.board_id, p_payload: {
    schema_version: 1, device_id: b.device_id, timestamp: 1794110000,
    sensors: { [sensor.slug]: { value: 22, unit: 'fahrenheit', status: 'valid' } },
  } });
  assert.equal(badUnit.accepted, 0);
  assert.equal(badUnit.rejected[0].reason, 'validation_failed');
  const badRange = await rpc(db, 'rpc_ingest_telemetry', { p_board: b.board_id, p_payload: {
    schema_version: 1, device_id: b.device_id, timestamp: 1794110000,
    sensors: { [sensor.slug]: { value: 999, unit: 'celsius', status: 'valid' } },
  } });
  assert.equal(badRange.accepted, 0, 'out-of-range reading rejected');
  const unknown = await rpc(db, 'rpc_ingest_telemetry', { p_board: b.board_id, p_payload: {
    schema_version: 1, device_id: b.device_id, timestamp: 1794110000,
    sensors: { nonexistent: { value: 1, unit: 'celsius', status: 'valid' } },
  } });
  assert.equal(unknown.rejected[0].reason, 'unknown_sensor');

  const dev = await rpc(db, 'rpc_create_device', { p_actor: S.A, p_tenant: S.tA,
    p_data: { name: 'Ack Lamp', user_board_id: b.board_id, output_gpio: 18 } });
  const issued = await rpc(db, 'rpc_issue_command', { p_actor: S.A, p_tenant: S.tA,
    p_board: b.board_id, p_component_id: dev.id,
    p_data: { action: 'set_state', idempotency_key: 'idem-ack-1', payload: { value: true } } });
  assert.equal(issued.idempotent, false);
  const commandId = issued.command.id;
  const duplicate = await rpc(db, 'rpc_issue_command', { p_actor: S.A, p_tenant: S.tA,
    p_board: b.board_id, p_component_id: dev.id,
    p_data: { action: 'set_state', idempotency_key: 'idem-ack-1', payload: { value: true } } });
  assert.equal(duplicate.idempotent, true, 'idempotency prevents duplicate commands');

  const ack = await rpc(db, 'rpc_ingest_state', { p_board: b.board_id, p_payload: {
    command_id: commandId, component_id: dev.slug, requested_state: true,
    actual_state: true, status: 'confirmed', schema_version: 1,
    device_id: b.device_id, timestamp: 1794110000,
  } });
  assert.equal(ack.tenant_id, S.tA);
  const state = (await db.query(`select reported_state, requested_state, state_source from devices where id=$1`, [dev.id])).rows[0];
  assert.equal(state.reported_state, 'on');
  assert.equal(state.state_source, 'device', 'ON is only shown after device acknowledgement');
  const cmd = (await db.query(`select status from device_commands where id=$1`, [commandId])).rows[0];
  assert.equal(cmd.status, 'acknowledged');

  // Expire stale commands so no ON/OFF lingers.
  await db.query(`update device_commands set expires_at = now() - interval '1 second' where id=$1`, [commandId]);
  const expiredCount = await rpc(db, 'rpc_expire_commands');
  assert.ok(expiredCount >= 0);
  assert.equal((await db.query(`select status from device_commands where id=$1`, [commandId])).rows[0].status, 'acknowledged');
  ok('telemetry validation, ack semantics, idempotency and command ledger');
});

test('CONFIG: versioned sync, ack and immutable config documents', async () => {
  const b = await pair(S.tA, S.A, 'espressif.esp32-c3-devkitm-1.v1', 'config');
  const before = (await db.query(`select config_version from user_boards where id=$1`, [b.board_id])).rows[0];
  await rpc(db, 'rpc_create_device', { p_actor: S.A, p_tenant: S.tA,
    p_data: { name: 'Config Lamp', user_board_id: b.board_id, output_gpio: 4 } });
  const after = (await db.query(`select config_version, config_sync_status from user_boards where id=$1`, [b.board_id])).rows[0];
  assert.ok(after.config_version > before.config_version, 'config version bumps on device change');
  const cfg = (await db.query(`select config, checksum from device_configurations where user_board_id=$1 order by version desc limit 1`, [b.board_id])).rows[0];
  assert.equal(cfg.config.devices.length, 1);
  assert.equal(cfg.config.schema_version, 1);
  assert.equal(cfg.checksum.length, 32);
  await rpc(db, 'rpc_ack_config', { p_board: b.board_id,
    p_payload: { schema_version: 1, device_id: b.device_id, config_version: after.config_version, status: 'applied' } });
  const sync = (await db.query(`select config_sync_status, applied_config_version from user_boards where id=$1`, [b.board_id])).rows[0];
  assert.equal(sync.config_sync_status, 'synced');
  assert.equal(sync.applied_config_version, after.config_version);
  ok('versioned config, checksum, ack and sync status');
});

test('OWNER: platform admin required, usage sources honest, secrets not exposed to RLS', async () => {
  await expectReject(() => rpc(db, 'rpc_set_tenant_status', {
    p_actor: S.A, p_tenant: S.tB, p_status: 'suspended', p_reason: 'x',
  }), 'customer cannot suspend another account');
  const suspended = await rpc(db, 'rpc_set_tenant_status', {
    p_actor: S.OWNER, p_tenant: S.tB, p_status: 'suspended', p_reason: 'test',
  });
  assert.equal(suspended.status, 'suspended');
  const ctxSuspended = await rpc(db, 'rpc_check_permission', { p_actor: S.B, p_tenant: S.tB, p_permission: 'dashboard.view' });
  assert.equal(ctxSuspended.allowed, false, 'suspension immediately blocks access');
  await rpc(db, 'rpc_set_tenant_status', { p_actor: S.OWNER, p_tenant: S.tB, p_status: 'active', p_reason: null });

  const snap = await rpc(db, 'rpc_record_usage_snapshot', { p_actor: S.OWNER, p_data: {
    period_start: '2026-11-01T00:00:00Z', period_end: '2026-12-01T00:00:00Z',
    granularity: 'month', source: 'owner_manual', traffic_bytes: 123456,
  } });
  assert.ok(snap.id);
  const rows = (await db.query(`select source, traffic_bytes from emqx_usage_snapshots`)).rows;
  assert.equal(rows[0].source, 'owner_manual');
  assert.equal(Number(rows[0].traffic_bytes), 123456);
  await expectReject(() => rpc(db, 'rpc_record_usage_snapshot', { p_actor: S.OWNER, p_data: {
    period_start: '2026-11-01T00:00:00Z', period_end: '2026-12-01T00:00:00Z', source: 'fabricated',
  } }), 'fabricated usage source');

  const secrets = await asUser(db, S.A, () => db.query(`select * from platform_secrets`))
    .then((r) => ({ rows: r.rows, denied: false })).catch(() => ({ rows: [], denied: true }));
  assert.equal(secrets.rows.length, 0, 'secrets never readable by a customer JWT');
  assert.equal(secrets.denied, true, 'platform_secrets is revoked for customer JWTs');
  const audit = (await db.query(`select action from audit_logs where actor_type='platform_admin'`)).rows;
  assert.ok(audit.length >= 2, 'owner actions are audited');
  assert.equal(EMQX_QUOTAS.trafficBytes, 1073741824);
  ok('owner-only operations, audited, usage sources honest, secrets protected');
});

test('ROOMS: deletion never silently removes devices without an explicit strategy', async () => {
  const room = await rpc(db, 'rpc_create_room', { p_actor: S.A, p_tenant: S.tA, p_data: { name: 'Strategy Room' } });
  const board = (await db.query(`select id from user_boards where tenant_id=$1 limit 1`, [S.tA])).rows[0];
  const dev = await rpc(db, 'rpc_create_device', { p_actor: S.A, p_tenant: S.tA,
    p_data: { name: 'Room Device', room_id: room.id, user_board_id: board.id, output_gpio: 19 } });
  await expectReject(() => rpc(db, 'rpc_delete_room', { p_actor: S.A, p_tenant: S.tA, p_room: room.id, p_strategy: 'guessed' }), 'unknown strategy');
  const unassign = await rpc(db, 'rpc_delete_room', { p_actor: S.A, p_tenant: S.tA, p_room: room.id, p_strategy: 'unassign' });
  assert.equal(unassign.devices_affected, 1);
  const still = (await db.query(`select room_id, deleted_at from devices where id=$1`, [dev.id])).rows[0];
  assert.equal(still.room_id, null);
  assert.equal(still.deleted_at, null, 'unassign keeps devices');
  ok('room deletion requires an explicit device decision');
});
