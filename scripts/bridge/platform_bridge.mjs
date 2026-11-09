#!/usr/bin/env node
/**
 * Platform ingress bridge: the always-on service that carries controller messages
 * from the MQTT broker to the HomecoreOS API.
 *
 * Why it exists: the API runs on Cloudflare Pages Functions, which cannot hold an
 * MQTT subscription open. Without this service a controller can connect, authenticate
 * and publish, yet the platform never sees the message, so pairing can never finish.
 *
 * What it does:
 *   - connects to the broker with its own platform account (subscribe-only, see
 *     DEPLOYMENT.md), never with a controller's credentials;
 *   - subscribes to the device ingress filter v1/tenants/+/devices/+/+;
 *   - forwards state, telemetry and availability messages to
 *     POST {HOMECOREOS_API}/internal/mqtt/event, signed with HMAC-SHA256 over
 *     "<timestamp>.<body>" using SIGNING_KEY, which the API verifies;
 *   - sends a heartbeat to POST {HOMECOREOS_API}/internal/bridge/heartbeat every
 *     30 seconds, carrying its real broker connection state and counters. The Owner
 *     Console shows that heartbeat; nothing else is taken as proof the bridge runs;
 *   - retries transient failures with backoff. A message the API rejects for good
 *     (4xx other than 429) is dropped and logged, never retried forever.
 *
 * Identity is not taken from this process. The API resolves the device from the
 * topic, and the broker's ACL is what guarantees that a controller can publish only
 * to its own topics.
 *
 * Usage (long-running service; see homecoreos-bridge.service):
 *   MQTT_URL=mqtts://<broker-host>:8883 BRIDGE_MQTT_USERNAME=... BRIDGE_MQTT_PASSWORD=... \
 *   HOMECOREOS_API=https://<site> SIGNING_KEY=... node scripts/bridge/platform_bridge.mjs
 * Optional: MQTT_CA_FILE (PEM for the broker certificate), BRIDGE_QUEUE_MAX (default 500).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';

const VERSION = '1.1.0';
const FILTER = 'v1/tenants/+/devices/+/+';
const FORWARDED_KINDS = new Set(['state', 'telemetry', 'availability']);
const MAX_ATTEMPTS = 8;
const HEARTBEAT_MS = 30000;

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[bridge] missing ${name}`);
    process.exit(2);
  }
  return value;
}

const config = {
  url: required('MQTT_URL'),
  username: required('BRIDGE_MQTT_USERNAME'),
  password: required('BRIDGE_MQTT_PASSWORD'),
  api: required('HOMECOREOS_API').replace(/\/$/, ''),
  secret: required('SIGNING_KEY'),
  ca: process.env.MQTT_CA_FILE ? readFileSync(process.env.MQTT_CA_FILE) : undefined,
  queueMax: Number(process.env.BRIDGE_QUEUE_MAX || 500),
};

/** Observed facts only. Each field changes when the event actually happens. */
const stats = {
  started_at: new Date().toISOString(),
  connected: false,
  subscribed: false,
  received: 0,
  forwarded: 0,
  dropped: 0,
  last_message_at: null,
  last_forward_ok_at: null,
  last_error: null,
  last_error_at: null,
};

const queue = [];
let draining = false;

function log(level, message, extra = {}) {
  const line = { at: new Date().toISOString(), level, message, ...extra };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

function fail(message) {
  stats.last_error = String(message).slice(0, 300);
  stats.last_error_at = new Date().toISOString();
}

/** Signs a body for the API. The same key and scheme as forwarding. */
function sign(raw) {
  const ts = String(Date.now());
  return { ts, signature: createHmac('sha256', config.secret).update(`${ts}.${raw}`).digest('hex') };
}

async function heartbeat() {
  const raw = JSON.stringify({ ...stats, version: VERSION });
  const { ts, signature } = sign(raw);
  try {
    const res = await fetch(`${config.api}/internal/bridge/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-HomecoreOS-Timestamp': ts, 'X-HomecoreOS-Signature': signature },
      body: raw,
    });
    if (!res.ok) log('warn', 'heartbeat refused by the platform', { status: res.status });
  } catch (error) {
    log('warn', 'heartbeat could not reach the platform', { error: String(error.message || error) });
  }
}

/** Signs and posts one message. Returns 'ok' | 'drop' | 'retry'. */
async function forward(item) {
  const raw = JSON.stringify({ topic: item.topic, payload: item.payload, qos: item.qos });
  const { ts, signature } = sign(raw);
  let res;
  try {
    res = await fetch(`${config.api}/internal/mqtt/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-HomecoreOS-Timestamp': ts,
        'X-HomecoreOS-Signature': signature,
      },
      body: raw,
    });
  } catch (error) {
    fail(`API unreachable: ${error.message || error}`);
    log('warn', 'API unreachable, will retry', { topic: item.topic, error: String(error.message || error) });
    return 'retry';
  }
  const text = await res.text().catch(() => '');
  if (res.ok) {
    let body = {};
    try { body = JSON.parse(text); } catch { /* empty body */ }
    if (body.ignored) log('info', 'message ignored by the platform', { topic: item.topic, reason: body.reason });
    stats.forwarded++;
    stats.last_forward_ok_at = new Date().toISOString();
    return 'ok';
  }
  if (res.status === 429 || res.status >= 500) {
    fail(`API refused with ${res.status}`);
    log('warn', 'API refused for now, will retry', { topic: item.topic, status: res.status });
    return 'retry';
  }
  fail(`API rejected a message with ${res.status}: ${text.slice(0, 120)}`);
  log('error', 'API rejected the message; dropped', { topic: item.topic, status: res.status, body: text.slice(0, 200) });
  return 'drop';
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const item = queue[0];
    let outcome = 'retry';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && outcome === 'retry'; attempt++) {
      outcome = await forward(item);
      if (outcome === 'retry' && attempt < MAX_ATTEMPTS) {
        const delay = Math.min(30000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    if (outcome === 'retry') {
      stats.dropped++;
      fail('giving up after retries');
      log('error', 'giving up after retries; dropped', { topic: item.topic });
    } else if (outcome === 'drop') {
      stats.dropped++;
    }
    queue.shift();
  }
  draining = false;
}

const client = mqtt.connect(config.url, {
  username: config.username,
  password: config.password,
  clientId: `hc-bridge-${randomBytes(4).toString('hex')}`,
  clean: true,
  reconnectPeriod: 5000,
  keepalive: 60,
  ca: config.ca,
  rejectUnauthorized: true,
});

client.on('connect', () => {
  stats.connected = true;
  log('info', 'connected to broker', { url: config.url });
  client.subscribe(FILTER, { qos: 1 }, (error) => {
    if (error) {
      stats.subscribed = false;
      fail(`subscribe failed: ${error.message || error}`);
      log('error', 'subscribe failed', { error: String(error.message || error) });
    } else {
      stats.subscribed = true;
      log('info', 'subscribed to device ingress', { filter: FILTER });
    }
    void heartbeat();
  });
});

client.on('error', (error) => {
  fail(`broker error: ${error.message || error}`);
  log('error', 'broker error', { error: String(error.message || error) });
});
client.on('close', () => {
  stats.connected = false;
  stats.subscribed = false;
  void heartbeat();
});
client.on('offline', () => {
  stats.connected = false;
  stats.subscribed = false;
  log('warn', 'broker offline; reconnecting');
});

client.on('message', (topic, payload) => {
  const parts = topic.split('/');
  const kind = parts[parts.length - 1];
  if (!FORWARDED_KINDS.has(kind)) return; // command and config are platform-originated
  stats.received++;
  stats.last_message_at = new Date().toISOString();
  if (queue.length >= config.queueMax) {
    stats.dropped++;
    fail('queue full; oldest message dropped');
    log('error', 'queue full; oldest message dropped', { topic: queue[0].topic });
    queue.shift();
  }
  queue.push({ topic, payload: payload.toString('utf8'), qos: 1 });
  void drain();
});

setInterval(() => { void heartbeat(); }, HEARTBEAT_MS);
void heartbeat();
