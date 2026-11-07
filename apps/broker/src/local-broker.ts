/**
 * Helios local development MQTT broker.
 *
 * This is a REAL broker with the same isolation contract as EMQX Cloud:
 *  - per-device username/password verified against the API's credential metadata
 *  - per-device ACL: publish only state/telemetry/availability, subscribe only
 *    command/config, everything else denied
 *  - device publishes are forwarded to the Worker ingress (with the AUTHENTIC
 *    MQTT client id) via an HMAC-signed internal event
 *
 * Production uses EMQX Cloud Serverless with built-in-database users + ACL
 * rules; no application code changes when switching providers.
 */
import aedes from 'aedes';
import { createServer as createTcpServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import websocketStream from 'websocket-stream';
import { createHmac } from 'node:crypto';

const API_BASE = process.env.API_URL || 'http://127.0.0.1:8787';
const HMAC_SECRET = process.env.INGRESS_HMAC_SECRET || 'local-ingress-secret';
const BRIDGE_PASSWORD = process.env.MQTT_BRIDGE_PASSWORD || 'local-dev-bridge';
const TCP_PORT = Number(process.env.MQTT_TCP_PORT || 1883);
const ADMIN_PORT = Number(process.env.MQTT_ADMIN_PORT || 1884);
const WS_PORT = Number(process.env.MQTT_WS_PORT || 1885);

const broker = aedes();
const stats = { clients: 0, messages: 0, packets: 0, publishes: 0, started_at: new Date().toISOString() };

async function post(path: string, body: any): Promise<any> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return res.ok ? await res.json() : null;
  } catch (e) {
    console.error('[broker] API unavailable:', (e as Error).message);
    return null;
  }
}

broker.authenticate = async (client, username, password, done) => {
  const u = username?.toString() || '';
  const pw = password?.toString() || '';
  // Platform-side publisher only (never given to devices or browsers).
  if (u === 'helios-platform' && pw === BRIDGE_PASSWORD) return done(null, true);
  const result = await post('/internal/mqtt/auth', { clientId: client.id, username: u, password: pw });
  if (!result?.ok) return done(new Error('authentication failed'), false);
  (client as any).helios = { boardId: result.board_id, tenantId: result.tenant_id };
  done(null, true);
};

broker.authorizePublish = async (client, packet, done) => {
  if (client.id.startsWith('helios-platform')) return done(null);
  const result = await post('/internal/mqtt/acl', { clientId: client.id, topic: packet.topic, action: 'publish' });
  done(result?.allowed ? null : new Error('publish denied by ACL'));
};

broker.authorizeSubscribe = async (client, sub, done) => {
  if (client.id.startsWith('helios-platform')) return done(null, sub);
  const result = await post('/internal/mqtt/acl', { clientId: client.id, topic: sub.topic, action: 'subscribe' });
  done(null, result?.allowed ? sub : null);
};

broker.on('client', () => { stats.clients = broker.connectedClients; });
broker.on('clientDisconnect', () => { stats.clients = broker.connectedClients; });
broker.on('publish', async (packet, client) => {
  stats.packets++;
  if (!client || client.id.startsWith('helios-platform')) return;
  if (!/^v1\/tenants\/[^/]+\/devices\/[^/]+\/(state|telemetry|availability|config)$/.test(packet.topic)) return;
  stats.publishes++;
  const body = JSON.stringify({ clientId: client.id, topic: packet.topic, payload: packet.payload.toString() });
  const ts = Date.now().toString();
  const sig = createHmac('sha256', HMAC_SECRET).update(`${ts}.${body}`).digest('hex');
  try {
    await fetch(`${API_BASE}/internal/mqtt/event`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Helios-Signature': sig, 'X-Helios-Timestamp': ts,
    }, body });
  } catch (e) { console.error('[broker] ingress forward failed:', (e as Error).message); }
});

const tcp = createTcpServer(broker.handle);
tcp.listen(TCP_PORT, '0.0.0.0', () => console.log(`[broker] MQTT TCP on 0.0.0.0:${TCP_PORT}`));

const wsServer = createHttpServer();
websocketStream.createServer({ server: wsServer, path: '/mqtt' }, broker.handle as any);
wsServer.listen(WS_PORT, '0.0.0.0', () => console.log(`[broker] MQTT WebSocket on 0.0.0.0:${WS_PORT}/mqtt`));

const admin = createHttpServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/stats') {
    res.end(JSON.stringify({ clients: broker.connectedClients, messages: stats.publishes, packets: stats.packets, started_at: stats.started_at }));
    return;
  }
  if (req.url === '/kick' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { clientId } = JSON.parse(raw || '{}');
    const client = broker.clients[clientId];
    if (client) client.conn.destroy();
    res.end(JSON.stringify({ kicked: !!client }));
    return;
  }
  res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
});
admin.listen(ADMIN_PORT, '0.0.0.0', () => console.log(`[broker] admin on 0.0.0.0:${ADMIN_PORT}`));

process.on('SIGTERM', () => broker.close(() => process.exit(0)));
