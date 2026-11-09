/**
 * A stand-in for the EMQX Cloud Serverless Deployment API, so the pairing and
 * firmware paths can be exercised without a real broker.
 *
 *   node scripts/dev/emqx_stub.mjs
 *
 * It answers the handful of endpoints the platform calls, records what it was
 * asked to do, and never connects to a real broker.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.EMQX_PORT || 3004);
const AUTH_ID = 'password_based:built_in_database';

const users = new Map();
const aclUsers = new Map();
const published = [];

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const bodyText = Buffer.concat(chunks).toString('utf8');
  let body = null;
  try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = bodyText; }
  const path = url.pathname;
  const method = req.method;

  // Basic auth is what the platform sends; accept anything.
  if (!req.headers.authorization) return send(res, 401, { message: 'unauthorized' });

  if (path === '/api/v5/clients' && method === 'GET') {
    return send(res, 200, { meta: { count: 0, page: 1, limit: 1, total: 0 }, data: [] });
  }
  if (path === '/api/v5/health' || path === '/api/v5/status') {
    return send(res, 200, { status: 'running' });
  }
  if (path === `/api/v5/authentication/${AUTH_ID}/users` && method === 'POST') {
    users.set(String(body?.user_id), body);
    return send(res, 201, { user_id: body?.user_id });
  }
  if (path.startsWith(`/api/v5/authentication/${AUTH_ID}/users/`) && method === 'DELETE') {
    users.delete(decodeURIComponent(path.split('/').pop()));
    return send(res, 204, {});
  }
  if (path.startsWith(`/api/v5/authentication/${AUTH_ID}/users/`) && method === 'PUT') {
    return send(res, 200, { user_id: decodeURIComponent(path.split('/').pop()) });
  }
  if (path === '/api/v5/authorization/sources/users' && method === 'POST') {
    for (const u of body || []) aclUsers.set(String(u.username), u);
    return send(res, 204, {});
  }
  if (path.startsWith('/api/v5/authorization/sources/users/') && method === 'DELETE') {
    aclUsers.delete(decodeURIComponent(path.split('/').pop()));
    return send(res, 204, {});
  }
  if (path === '/api/v5/publish' && method === 'POST') {
    published.push(body);
    return send(res, 204, {});
  }
  if (path.includes('/authorization/cache') && method === 'DELETE') {
    return send(res, 204, {});
  }
  if (path.startsWith('/api/v5/clients/') && method === 'DELETE') {
    return send(res, 204, {});
  }
  // Any usage endpoint: answer with an empty but well-formed snapshot.
  if (path.includes('/usage') || path.includes('/statistics')) {
    return send(res, 200, { meta: { count: 0, page: 1, limit: 100, total: 0 }, data: [] });
  }

  return send(res, 200, {});
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[emqx-stub] ${PORT}`);
  console.log(`[emqx-stub] users=${users.size} acl=${aclUsers.size} published=${published.length}`);
});
