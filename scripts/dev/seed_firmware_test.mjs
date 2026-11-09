/**
 * End-to-end check of the firmware path: a customer registers a controller,
 * the owner publishes a release for that controller's model, and the customer
 * console must then show the release.
 *
 *   node scripts/dev/seed_firmware_test.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = process.env.HC_API || 'http://127.0.0.1:8787';
const OWNER = { email: 'owner@example.com', password: 'correct-horse-battery' };
const CUSTOMER = { email: 'customer@example.com', password: 'correct-horse-battery' };

const BOARD = 'espressif.esp32-s3-devkitc-1.n16r8';

function jar() {
  return { cookies: {} };
}
async function call(jar, method, path, body) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'seed' };
  const cookie = Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${API}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const raw of res.headers.getSetCookie?.() || []) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    jar.cookies[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function signIn(jar, who) {
  let r = await call(jar, 'POST', '/api/auth/login', who);
  if (r.status !== 200) {
    r = await call(jar, 'POST', '/api/auth/signup', {
      ...who, full_name: who.email === OWNER.email ? 'Owner' : 'Customer', home_name: 'Test Home',
    });
  }
  if (r.status !== 200 && r.status !== 201) throw new Error(`sign-in failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r;
}

/* ---------------------------------------------- a customer with a board -- */

const customer = jar();
await signIn(customer, CUSTOMER);

// Issue a pairing code for the controller, then redeem it the way the device does.
const code = await call(customer, 'POST', '/api/pairing/code', {
  catalog_board_id: BOARD, board_name: 'Living room controller',
});
if (code.status !== 200 && code.status !== 201) throw new Error(`pairing code failed: ${code.status} ${JSON.stringify(code.data)}`);
console.log('pairing code issued');

const redeem = await call(jar(), 'POST', '/api/device/pair', {
  code: code.data.code,
  hardware: { chip_family: 'ESP32-S3' },
});
console.log('pair redeemed:', redeem.status, redeem.status >= 400 ? JSON.stringify(redeem.data) : '');
const boards = await call(customer, 'GET', '/api/boards');
console.log('customer boards:', boards.data?.length, boards.data?.map?.((b) => b.catalog_board_id));

/* ------------------------------------------- the owner uploads a release -- */

const owner = jar();
await signIn(owner, OWNER);

const work = mkdtempSync(join(tmpdir(), 'hc-fw-'));
const { writeSyntheticBuild } = await import(pathToFileURL('/home/user/repo/scripts/firmware/synthetic_build.mjs').href);
const build = join(work, 'build');
writeSyntheticBuild(build, '3.1.4');
const zip = join(work, 'release.zip');
execFileSync('node', ['/home/user/repo/scripts/firmware/hc_package.mjs', '--build', build, '--out', zip], { stdio: 'pipe' });

const { readFileSync } = await import('node:fs');
const zipB64 = readFileSync(zip).toString('base64');
const upload = await call(owner, 'POST', '/api/owner/firmware/upload-package', {
  package_base64: zipB64, status: 'published', channel: 'stable',
  board_models: [BOARD], notes: 'Seed release for the synchronisation check',
});
console.log('upload:', upload.status, 'ok=', upload.data?.ok, 'problems=', JSON.stringify(upload.data?.problems || []));

const overview = await call(owner, 'GET', '/api/owner/firmware');
const releases = overview.data?.releases || [];
console.log('owner sees', releases.length, 'releases:',
  releases.map((r) => `${r.version}/${r.artifact_kind}/${r.status}/${r.channel}/${JSON.stringify(r.board_models)}`));

/* --------------------------------------- the customer must see it too -- */

const catalog = await call(customer, 'GET', '/api/firmware/catalog');
console.log('\ncustomer catalog controllers:', catalog.data?.controllers?.length);
console.log('customer catalog install   :', catalog.data?.install?.length,
  catalog.data?.install?.map?.((i) => `${i.version}/${i.artifact_kind}/${i.channel}`));

const history = await call(customer, 'GET', '/api/firmware/history');
console.log('customer history            :', history.data?.length);

rmSync(work, { recursive: true, force: true });
