/**
 * A local stand-in for Supabase Storage, so the firmware upload path can be
 * exercised without a Supabase project. Objects are kept in a directory on
 * disk and served back with the same shape the API expects.
 *
 *   node scripts/dev/storage_proxy.mjs
 *
 * It is mounted by scripts/dev/rest_proxy.mjs under /storage/v1.
 */

import { createServer } from 'node:http';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const PORT = Number(process.env.STORAGE_PORT || 3003);
const ROOT = process.env.STORAGE_ROOT || '/tmp/hc-storage';
const BUCKETS = new Set(['firmware']);
mkdirSync(ROOT, { recursive: true });

function pathFor(bucket, key) {
  return join(ROOT, bucket, key.replace(/\.\./g, '_'));
}
function safeKey(key) {
  return decodeURIComponent(key).replace(/^\/+/, '');
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  // /storage/v1/bucket
  if (url.pathname === '/storage/v1/bucket' && req.method === 'POST') {
    return send(200, { id: 'firmware', name: 'firmware', public: false });
  }
  if (url.pathname === '/storage/v1/bucket' && req.method === 'GET') {
    return send(200, [...BUCKETS].map((b) => ({ id: b, name: b, public: false })));
  }

  // /storage/v1/object/<bucket>/<key>
  const m = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.*)$/);
  if (m) {
    const bucket = m[1];
    const key = safeKey(m[2]);
    const file = pathFor(bucket, key);
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!existsSync(file)) return send(404, { message: 'Object not found' });
      const data = readFileSync(file);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(data.length),
      });
      return res.end(req.method === 'HEAD' ? undefined : data);
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.concat(chunks));
      return send(200, { Key: key });
    }
    if (req.method === 'DELETE') {
      rmSync(file, { force: true });
      return send(200, { message: 'deleted' });
    }
  }

  // /storage/v1/object/list/<bucket>
  const listMatch = url.pathname.match(/^\/storage\/v1\/object\/list\/([^/]+)$/);
  if (listMatch && req.method === 'POST') {
    const bucket = listMatch[1];
    const dir = join(ROOT, bucket);
    const names = [];
    const walk = (d, prefix = '') => {
      if (!existsSync(d)) return;
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(d, entry.name), rel);
        else names.push({ name: rel });
      }
    };
    walk(dir);
    return send(200, names);
  }

  return send(404, { message: `No route for ${req.method} ${url.pathname}` });
}).listen(PORT, '0.0.0.0', () => console.log(`[storage] ${PORT} -> ${ROOT}`));
