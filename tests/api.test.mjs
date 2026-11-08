/**
 * End-to-end API acceptance test against a running local stack (`npm run dev`).
 * Skipped automatically when the API is not reachable, so `npm test` works in
 * CI without a broker. Covers the real HTTP path: auth -> pairing -> GPIO ->
 * command -> owner console, plus the honesty of owner usage reporting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';

const BASE = process.env.TEST_API_BASE || 'http://127.0.0.1:8787';

let available = false;
try {
  const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
  available = r.ok;
} catch { available = false; }

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

test('API: full onboarding, GPIO isolation, command ledger and owner console', { skip: !available && 'API not running' }, async () => {
  const email = `api-test-${randomBytes(5).toString('hex')}@example.test`;
  const password = 'IntegrationPass123!';
  const signup = await call('/api/auth/signup', { method: 'POST', body: { email, password, full_name: 'API Test', home_name: 'API Home' } });
  assert.equal(signup.status, 201);
  const token = signup.data.token;
  assert.ok(token);

  const ctx = await call('/api/context', { token });
  assert.equal(ctx.status, 200);
  assert.equal(ctx.data.tenant.name, 'API Home');
  assert.equal(ctx.data.role, 'owner');

  const catalog = await call('/api/board-catalog', { token });
  assert.equal(catalog.status, 200);
  assert.ok(catalog.data.some((b) => b.id === 'espressif.esp32-devkitc-v4.wroom32e' && b.pins.length === 32));
  assert.ok(catalog.data.some((b) => b.pins.length === 0 && b.attributes.pin_status === 'pending_verification'),
    'unverified chip families must not have invented pin maps');

  const pairing = await call('/api/pairing-tokens', { method: 'POST', token,
    body: { catalog_board_id: 'espressif.esp32-devkitc-v4.wroom32e', board_name: 'API Board' } });
  assert.equal(pairing.status, 201);
  const claim = await call('/api/device/claim', { method: 'POST', body: { pairing_token: pairing.data.token } });
  assert.equal(claim.status, 201, JSON.stringify(claim.data));
  assert.ok(claim.data.mqtt.username !== claim.data.mqtt.password);
  assert.equal(claim.data.topics.state, `v1/tenants/${claim.data.tenant_id}/devices/${claim.data.device_id}/state`);
  const reuse = await call('/api/device/claim', { method: 'POST', body: { pairing_token: pairing.data.token } });
  assert.equal(reuse.status, 401, 'pairing token is single-use');

  const boardId = claim.data.board_id;
  const room = await call('/api/rooms', { method: 'POST', token, body: { name: 'API Room' } });
  assert.equal(room.status, 201);
  const device = await call('/api/devices', { method: 'POST', token, body: {
    name: 'API Lamp', device_type: 'light', room_id: room.data.id, user_board_id: boardId, output_gpio: 5 } });
  assert.equal(device.status, 201);
  const duplicate = await call('/api/devices', { method: 'POST', token, body: {
    name: 'API Lamp 2', device_type: 'light', user_board_id: boardId, output_gpio: 5 } });
  assert.ok(duplicate.status >= 400, 'exclusive GPIO cannot be assigned twice');
  const restricted = await call('/api/devices', { method: 'POST', token, body: {
    name: 'Flash', device_type: 'light', user_board_id: boardId, output_gpio: 6 } });
  assert.ok(restricted.status >= 400, 'restricted flash pin rejected');

  const pins = await call(`/api/boards/${boardId}`, { token });
  assert.equal(pins.data.pins.find((p) => p.gpio === 5).state, 'assigned');

  const sensor = await call('/api/sensors', { method: 'POST', token, body: {
    name: 'API Temp', category: 'temperature', user_board_id: boardId, interface: 'adc',
    gpio: 32, unit: 'celsius', min_valid: -20, max_valid: 80 } });
  assert.equal(sensor.status, 201);

  const command = await call(`/api/devices/${device.data.id}/command`, { method: 'POST', token,
    body: { action: 'set_state', value: true } });
  assert.equal(command.status, 202);
  assert.ok(command.data.command.id);
  assert.ok(command.data.command.expires_at, 'commands have expiry');
  const afterCommand = await call('/api/devices', { token });
  const lamp = afterCommand.data.find((d) => d.id === device.data.id);
  assert.equal(lamp.reported_state, 'unknown', 'UI must not claim ON before device acknowledgement');

  const messages = await call(`/api/messages/${device.data.id}`, { token });
  assert.equal(messages.status, 200);
  assert.ok(messages.data.path.join(' ').includes('MQTT') || messages.data.path.join(' ').includes('broker') || messages.data.path.join(' ').includes('EMQX'));

  // Firmware OTA: real binary, SHA-256 registry, short-lived signed URL,
  // published-release check and tamper/expiry rejection.
  const binary = randomBytes(64);
  const digest = createHash('sha256').update(binary).digest('hex');
  const release = await call('/api/firmware/releases', { method: 'POST', token, body: {
    version: `1.0.${randomBytes(3).toString('hex')}`, channel: 'stable', chip_family: 'ESP32',
    size_bytes: binary.length, sha256: digest, status: 'published', notes: 'acceptance test',
    binary_base64: binary.toString('base64'),
  } });
  assert.equal(release.status, 201, JSON.stringify(release.data));
  const releases = await call('/api/firmware/releases', { token });
  assert.ok(releases.data.some((r) => r.id === release.data.id && r.status === 'published'));
  const ota = await call('/api/firmware/ota', { method: 'POST', token,
    body: { release_id: release.data.id, board_id: boardId } });
  assert.equal(ota.status, 200, JSON.stringify(ota.data));
  assert.equal(ota.data.sha256, digest);
  assert.ok(ota.data.download_url.includes('/api/firmware/download/'));
  const downloaded = await fetch(new URL(ota.data.download_url, BASE));
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('x-checksum'), digest);
  const got = new Uint8Array(await downloaded.arrayBuffer());
  assert.deepEqual([...got], [...binary], 'served binary matches the published SHA-256');
  const tampered = new URL(ota.data.download_url, BASE);
  tampered.searchParams.set('sig', '0'.repeat(64));
  assert.equal((await fetch(tampered)).status, 403, 'tampered signature rejected');
  const expired = new URL(ota.data.download_url, BASE);
  expired.searchParams.set('expires', '1');
  assert.equal((await fetch(expired)).status, 403, 'expired URL rejected');

  // A second account cannot see the first account's rooms, boards or devices.
  const signupB = await call('/api/auth/signup', { method: 'POST', body: {
    email: `api-test-b-${randomBytes(5).toString('hex')}@example.test`, password, home_name: 'Other Home' } });
  const tokenB = signupB.data.token;
  const roomsB = await call('/api/rooms', { token: tokenB });
  assert.equal(roomsB.data.length, 0, 'tenant B sees no rooms of tenant A');
  const boardsB = await call('/api/boards', { token: tokenB });
  assert.equal(boardsB.data.length, 0, 'tenant B sees no boards of tenant A');
  const crossCommand = await call(`/api/devices/${device.data.id}/command`, { method: 'POST', token: tokenB,
    body: { action: 'set_state', value: true } });
  assert.equal(crossCommand.status, 404, 'tenant B cannot command tenant A device');

  // Owner console: separate authentication and honest unavailable metrics.
  const ownerLogin = await call('/api/auth/login', { method: 'POST',
    body: { email: process.env.PLATFORM_OWNER_EMAIL || 'owner@homecoreos.local', password: process.env.PLATFORM_OWNER_PASSWORD || 'HomecoreOSOwner2026!' } });
  assert.equal(ownerLogin.status, 200);
  const ownerToken = ownerLogin.data.token;
  const denied = await call('/api/owner/overview', { token });
  assert.equal(denied.status, 403, 'customer cannot access platform administration');
  const overview = await call('/api/owner/overview', { token: ownerToken });
  assert.equal(overview.status, 200);
  assert.ok(overview.data.accounts >= 2);
  const usage = await call('/api/owner/usage', { token: ownerToken });
  assert.equal(usage.status, 200);
  assert.ok(usage.data.unavailable && Object.keys(usage.data.unavailable).length > 0,
    'owner usage must expose explicit unavailable metrics');
  assert.ok(usage.data.estimates.label.includes('estimate'));
  const settings = await call('/api/owner/emqx/settings', { token: ownerToken });
  assert.equal(settings.status, 200);
  for (const s of Object.values(settings.data.secrets)) {
    assert.equal(s.masked, '••••••••••••', 'secrets are masked');
    assert.ok(!('ciphertext' in s));
  }
});

test('API: no hardcoded demo devices are returned to a new account', { skip: !available && 'API not running' }, async () => {
  const email = `empty-${randomBytes(5).toString('hex')}@example.test`;
  const signup = await call('/api/auth/signup', { method: 'POST', body: { email, password: 'EmptyAccount123!', home_name: 'Empty Home' } });
  const t = signup.data.token;
  for (const path of ['/api/rooms', '/api/boards', '/api/devices', '/api/sensors', '/api/automations']) {
    const r = await call(path, { token: t });
    assert.deepEqual(r.data, [], `${path} must be empty for a new account`);
  }
});
