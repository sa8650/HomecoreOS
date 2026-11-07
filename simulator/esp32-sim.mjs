/**
 * Helios virtual ESP32 — exercises the REAL cloud path end-to-end.
 *
 * Usage: node simulator/esp32-sim.mjs <pairing-token> [catalog-board-id] [api-url]
 *
 * It pairs through /api/device/claim, receives unique MQTT credentials, keeps
 * an outbound connection to the broker, subscribes only to command + config,
 * acknowledges commands with the firmware protocol, and publishes telemetry.
 * It is a development tool, never a production device record.
 */
import mqtt from 'mqtt';

const [token, boardId, apiBase = 'http://127.0.0.1:8787'] = process.argv.slice(2);
const brokerUrl = process.env.MQTT_BRIDGE_URL || 'mqtt://127.0.0.1:1883';
if (!token) { console.error('Usage: node simulator/esp32-sim.mjs <pairing-token>'); process.exit(1); }

const log = (...a) => console.log('[esp32]', ...a);
let config = { config_version: 0, devices: [], sensors: [] };
let acceptedVersion = 0;
const states = Object.create(null);
const lastKnownGood = { config, version: 0 };

async function claim() {
  const res = await fetch(`${apiBase}/api/device/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_token: token, catalog_board_id: boardId || null }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claim failed: ${data.error}`);
  return data;
}

const claimData = await claim();
log('paired:', claimData.device_id, 'tenant:', claimData.tenant_id, 'topics:', Object.keys(claimData.topics).join(','));
if (claimData.config) config = claimData.config;

const t = claimData.topics;
const client = mqtt.connect(brokerUrl, {
  clientId: claimData.mqtt.client_id,
  username: claimData.mqtt.username,
  password: claimData.mqtt.password,
  clean: true,
  keepalive: 30,
  reconnectPeriod: 2000,
  will: { topic: t.availability, payload: JSON.stringify({ schema_version: 1, device_id: claimData.device_id, status: 'offline' }), qos: 1, retain: false },
});

function publish(topic, obj) { client.publish(topic, JSON.stringify(obj), { qos: 1, retain: false }); }

client.on('connect', () => {
  log('MQTT connected as', claimData.mqtt.client_id);
  client.subscribe([t.command, t.config], { qos: 1 }, (err) => {
    if (err) return log('subscribe denied:', err.message);
    log('subscribed to command + config only');
    publish(t.availability, { schema_version: 1, device_id: claimData.device_id, status: 'online', timestamp: Math.floor(Date.now() / 1000) });
    publish(t.state, {
      schema_version: 1, device_id: claimData.device_id, timestamp: Math.floor(Date.now() / 1000),
      config_version: acceptedVersion, type: 'config_ack', status: 'applied', checksum: '',
    });
    publishFullState();
  });
});

client.on('error', (e) => log('error:', e.message));
client.on('close', () => log('disconnected — reconnecting'));

client.on('message', (topic, raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (topic === t.config) {
    if (!msg || msg.schema_version !== 1 || !Array.isArray(msg.devices) || !Array.isArray(msg.sensors)) {
      log('rejected invalid config — keeping last known good v' + lastKnownGood.version);
      publish(t.state, { schema_version: 1, device_id: claimData.device_id, config_version: msg?.config_version ?? 0, type: 'config_ack', status: 'rejected', error: 'invalid schema' });
      return;
    }
    config = msg;
    lastKnownGood.config = msg; lastKnownGood.version = msg.config_version;
    acceptedVersion = msg.config_version;
    for (const d of msg.devices) if (!(d.component_id in states)) states[d.component_id] = 'off';
    log('applied config v' + acceptedVersion);
    publish(t.state, { schema_version: 1, device_id: claimData.device_id, config_version: acceptedVersion,
      type: 'config_ack', status: 'applied', checksum: '' });
    publishFullState();
    return;
  }
  if (topic === t.command) {
    const now = Math.floor(Date.now() / 1000);
    if (!msg.command_id || !msg.component_id || !msg.expires_at) return;
    if (msg.expires_at < now) { log('ignored expired command', msg.command_id); return; }
    if (msg.action === 'update_firmware') {
      log('OTA command received for', msg.version, 'sha256', msg.sha256);
      publish(t.state, { schema_version: 1, device_id: claimData.device_id, progress: 100,
        status: 'success', version: msg.version, type: 'ota' });
      return;
    }
    if (msg.action !== 'set_state' && msg.action !== 'pulse') return;
    const component = config.devices.find((d) => d.component_id === msg.component_id);
    if (!component) {
      publish(t.state, { schema_version: 1, command_id: msg.command_id, component_id: msg.component_id,
        requested_state: msg.value, actual_state: null, status: 'failed', error: 'unknown component' });
      return;
    }
    const next = msg.action === 'pulse' ? 'on' : (msg.value === true ? 'on' : 'off');
    states[component.component_id] = next;
    log('command', msg.command_id, component.component_id, '->', next);
    publish(t.state, { schema_version: 1, command_id: msg.command_id, component_id: msg.component_id,
      requested_state: msg.value, actual_state: next === 'on', status: 'confirmed', timestamp: now });
    publishFullState();
    if (msg.action === 'pulse') setTimeout(() => { states[component.component_id] = 'off'; publishFullState(); }, 600);
  }
});

function publishFullState() {
  const devices = {};
  for (const d of config.devices || []) devices[d.component_id] = { state: states[d.component_id] || 'unknown', source: 'gpio' };
  publish(t.state, { schema_version: 1, device_id: claimData.device_id, timestamp: Math.floor(Date.now() / 1000),
    config_version: acceptedVersion, availability: 'online', devices });
}

function publishTelemetry() {
  const sensors = {};
  for (const s of config.sensors || []) {
    let value;
    switch (s.category) {
      case 'temperature': value = 24 + Math.sin(Date.now() / 60000) * 3; break;
      case 'humidity': value = 48 + Math.cos(Date.now() / 90000) * 8; break;
      case 'water_level': value = 60 + Math.round(Math.sin(Date.now() / 120000) * 15); break;
      case 'motion': value = Math.random() > 0.8 ? 1 : 0; break;
      case 'light': value = 300 + Math.round(Math.random() * 100); break;
      default: value = 20 + Math.round(Math.random() * 10);
    }
    sensors[s.component_id] = { value: Number(value.toFixed(2)), unit: s.unit || 'celsius', status: 'valid' };
  }
  if (Object.keys(sensors).length) {
    publish(t.telemetry, { schema_version: 1, device_id: claimData.device_id,
      timestamp: Math.floor(Date.now() / 1000), config_version: acceptedVersion, sensors });
  }
}

setInterval(publishTelemetry, 15000);
setInterval(publishFullState, 30000);
process.on('SIGTERM', () => client.end(true));
