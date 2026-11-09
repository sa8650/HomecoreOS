/**
 * Mounts PostgREST under the same path Supabase uses, so the HomecoreOS API
 * can be exercised locally with no change to its source.
 *
 * Supabase serves PostgREST at <SUPABASE_URL>/rest/v1. A bare PostgREST
 * serves at the root, so this proxy forwards /rest/v1/* to it.
 *
 *   node scripts/dev/rest_proxy.mjs
 */

import { createServer } from 'node:http';

const TARGET = process.env.PGRST_TARGET || 'http://127.0.0.1:3001';
const STORAGE = process.env.STORAGE_TARGET || 'http://127.0.0.1:3003';
const PORT = Number(process.env.PGRST_PROXY_PORT || 3002);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // /storage/v1 goes to the local object store; /rest/v1 goes to PostgREST.
  const isStorage = url.pathname.startsWith('/storage/');
  const base = isStorage ? STORAGE : TARGET;
  const path = isStorage ? url.pathname : url.pathname.replace(/^\/rest\/v1/, '');
  const target = `${base}${path}${url.search}`;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const headers = Object.fromEntries(upstream.headers.entries());
    delete headers['content-encoding'];
    delete headers['content-length'];
    res.writeHead(upstream.status, headers);
    res.end(body);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
}).listen(PORT, '0.0.0.0', () => console.log(`[rest-proxy] ${PORT} -> rest:${TARGET} storage:${STORAGE}`));
