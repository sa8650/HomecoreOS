/**
 * Cloudflare Pages Functions request tests.
 *
 * These exercise the ACTUAL deployment entry point (`functions/[[path]].ts`)
 * with native `DB` and `FIRMWARE_BUCKET` bindings, independently of the Node
 * local server. A local compilation of the Functions bundle is not enough: an
 * actual request through `onRequest` must reach the D1 adapter, apply
 * migrations, detect the provider and serve the API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { SqliteD1 } from '../apps/api/src/db/sqlite-d1.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const hex64 = () => randomBytes(32).toString('hex');
const { onRequest } = await import(pathToFileURL(resolve(ROOT, 'functions/[[path]].ts')).href);

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

function ctxFor(path, env, { method = 'GET', body, token } = {}) {
  const request = new Request(`https://homecoreos.pages.dev${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    request, env,
    next: async () => new Response('static asset', { status: 200 }),
  };
}

async function call(path, env, opts) {
  const res = await onRequest(ctxFor(path, env, opts));
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, text };
}

test('Pages Functions: native DB + FIRMWARE_BUCKET bindings serve the D1 API', async () => {
  const db = await SqliteD1.create();
  await db.migrate();
  const bucket = fakeBucket();
  const env = { SECRETS_KEY: hex64(), DB: db, FIRMWARE_BUCKET: bucket };

  const health = await call('/api/health', env);
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.database, 'd1');
  assert.equal(health.data.service, 'homecoreos-api');

  const signup = await call('/api/auth/signup', env, { method: 'POST', body: {
    email: 'pages-owner@example.test', password: 'PagesOwnerPass123!',
    full_name: 'Pages Owner', home_name: 'Pages Home',
  } });
  assert.equal(signup.status, 201, signup.text);
  const token = signup.data.token;

  const setup = await call('/api/owner/setup', env, { token });
  assert.equal(setup.status, 200, setup.text);
  assert.equal(setup.data.provider, 'd1');
  assert.ok(setup.data.bindings.find((b) => b.name === 'DB')?.connected);
  assert.ok(setup.data.bindings.find((b) => b.name === 'FIRMWARE_BUCKET')?.connected);

  const probe = await call('/api/owner/setup/test-bucket', env, { method: 'POST', body: {}, token });
  assert.equal(probe.status, 200, probe.text);
  assert.equal(probe.data.connected, true);
  assert.equal(bucket.data.size, 0, 'the R2 round-trip probe must delete its temporary object');

  // Credentials written through the real Pages entry are sealed, not plaintext.
  const put = await call('/api/owner/integrations', env, { method: 'PUT', token,
    body: { EMQX_APP_SECRET: 'pages-integration-secret' } });
  assert.equal(put.status, 200, put.text);
  const rows = await db.prepare('select ciphertext, iv, tag from platform_secrets where key = ?')
    .bind('EMQX_APP_SECRET').all();
  assert.equal(rows.results.length, 1);
  assert.ok(!JSON.stringify(rows.results[0]).includes('pages-integration-secret'));
  const get = await call('/api/owner/integrations', env, { token });
  assert.equal(get.status, 200);
  assert.ok(!get.text.includes('pages-integration-secret'));
});

test('Pages Functions: static paths are left to the Pages asset server', async () => {
  const env = { SECRETS_KEY: hex64(), DB: await SqliteD1.create(), FIRMWARE_BUCKET: fakeBucket() };
  const asset = await call('/assets/index.js', env);
  assert.equal(asset.status, 200);
  assert.equal(asset.text, 'static asset');
  const root = await call('/', env);
  assert.equal(root.text, 'static asset');
});

test('Pages Functions: missing bindings produce actionable 503 setup guidance', async () => {
  const env = { SECRETS_KEY: hex64() };
  const res = await call('/api/health', env);
  assert.equal(res.status, 503);
  assert.equal(res.data.error, 'Platform setup required');
  assert.equal(res.data.owner_console, '/owner/setup');
  assert.match(res.data.instructions, /DB/);
  assert.match(res.data.instructions, /FIRMWARE_BUCKET/);
  assert.match(res.data.instructions, /SECRETS_KEY/);
  assert.ok(!JSON.stringify(res.data).includes(env.SECRETS_KEY));
});

test('Pages Functions: _routes.json limits Functions to /api/* and /internal/*', () => {
  const routes = JSON.parse(readFileSync(resolve(ROOT, 'apps/web/public/_routes.json'), 'utf8'));
  assert.equal(routes.version, 1);
  assert.deepEqual(routes.include, ['/api/*', '/internal/*']);
  const built = JSON.parse(readFileSync(resolve(ROOT, 'apps/web/dist/_routes.json'), 'utf8'));
  assert.deepEqual(built.include, routes.include);
});
