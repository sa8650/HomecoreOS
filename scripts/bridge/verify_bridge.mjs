#!/usr/bin/env node
/**
 * Operator check for the platform bridge. Run it on the host that will run the bridge,
 * before starting the service. Each step reports what it actually observed.
 *
 *   1. Deployment API: EMQX REST API accepts the App ID / App Secret (optional).
 *   2. Broker: TLS connects to MQTT and the bridge account is authorised to subscribe
 *      to the device ingress filter. The subscription is confirmed by the broker (SUBACK).
 *   3. Platform: the HomecoreOS API accepts a signed bridge heartbeat (optional).
 *
 * Nothing here publishes device data or changes broker state.
 *
 *   MQTT_URL=mqtts://<broker-host>:8883 BRIDGE_MQTT_USERNAME=... BRIDGE_MQTT_PASSWORD=... \
 *   [EMQX_API_BASE=https://<host>:8443/api/v5 EMQX_APP_ID=... EMQX_APP_SECRET=...] \
 *   [HOMECOREOS_API=https://<site> SIGNING_KEY=...] \
 *   node scripts/bridge/verify_bridge.mjs
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';

const FILTER = 'v1/tenants/+/devices/+/+';
let failures = 0;
const report = (ok, name, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function checkDeploymentApi() {
  const base = process.env.EMQX_API_BASE;
  const id = process.env.EMQX_APP_ID;
  const secret = process.env.EMQX_APP_SECRET;
  if (!base && !id && !secret) return report(true, 'Deployment API: skipped (EMQX_API_BASE not set)');
  if (!base || !id || !secret) return report(false, 'Deployment API: needs EMQX_API_BASE, EMQX_APP_ID and EMQX_APP_SECRET');
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/clients?limit=1&page=1`, {
      headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, Accept: 'application/json' },
    });
    report(res.ok, 'Deployment API accepts the App ID and App Secret', `HTTP ${res.status}`);
  } catch (error) {
    report(false, 'Deployment API reachable', String(error.message || error));
  }
}

function checkBroker() {
  return new Promise((resolve) => {
    const url = process.env.MQTT_URL;
    const ca = process.env.MQTT_CA_FILE ? readFileSync(process.env.MQTT_CA_FILE) : undefined;
    const client = mqtt.connect(url, {
      username: process.env.BRIDGE_MQTT_USERNAME,
      password: process.env.BRIDGE_MQTT_PASSWORD,
      clientId: `hc-verify-${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 15000,
      ca,
      rejectUnauthorized: true,
    });
    const timer = setTimeout(() => {
      report(false, 'Broker answered within 20 seconds');
      client.end(true);
      resolve(false);
    }, 20000);
    client.on('error', (error) => {
      clearTimeout(timer);
      report(false, 'Broker accepted the bridge account and TLS', String(error.message || error));
      client.end(true);
      resolve(false);
    });
    client.on('connect', () => {
      report(true, 'Broker accepted the bridge account over TLS');
      client.subscribe(FILTER, { qos: 1 }, (error, granted) => {
        clearTimeout(timer);
        const ok = !error && granted?.[0] && granted[0].qos !== 128;
        report(!!ok, `Broker confirmed the subscription to ${FILTER}`,
          error ? String(error.message || error) : `granted qos ${granted?.[0]?.qos}`);
        client.end(true, {}, () => resolve(!!ok));
      });
    });
  });
}

async function checkPlatform() {
  const api = process.env.HOMECOREOS_API;
  const secret = process.env.SIGNING_KEY;
  if (!api && !secret) return report(true, 'Platform heartbeat: skipped (HOMECOREOS_API not set)');
  if (!api || !secret) return report(false, 'Platform heartbeat: needs HOMECOREOS_API and SIGNING_KEY');
  const raw = JSON.stringify({ connected: true, subscribed: true, started_at: new Date().toISOString(), version: 'verify' });
  const ts = String(Date.now());
  const signature = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  try {
    const res = await fetch(`${api.replace(/\/$/, '')}/internal/bridge/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-HomecoreOS-Timestamp': ts, 'X-HomecoreOS-Signature': signature },
      body: raw,
    });
    report(res.ok, 'HomecoreOS accepts the bridge signature (SIGNING_KEY matches the platform)', `HTTP ${res.status}`);
  } catch (error) {
    report(false, 'HomecoreOS reachable', String(error.message || error));
  }
}

if (!process.env.MQTT_URL || !process.env.BRIDGE_MQTT_USERNAME || !process.env.BRIDGE_MQTT_PASSWORD) {
  console.error('Set MQTT_URL, BRIDGE_MQTT_USERNAME and BRIDGE_MQTT_PASSWORD.');
  process.exit(2);
}
await checkDeploymentApi();
await checkBroker();
await checkPlatform();
console.log(failures ? `\n${failures} check(s) failed. Fix them before starting the bridge.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
