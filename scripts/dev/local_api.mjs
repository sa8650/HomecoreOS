/**
 * Local development API server.
 *
 * Runs the real HomecoreOS API against a local PostgREST and a local
 * PostgreSQL, so the console can be exercised without a deployed Pages
 * project. The API source is used unmodified.
 *
 *   node scripts/dev/local_api.mjs
 *
 * Configuration comes from the environment:
 *   SUPABASE_URL                 base URL of the PostgREST instance
 *   SUPABASE_SERVICE_ROLE_KEY    the service-role JWT
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const repo = '/home/user/repo';
const require = createRequire(repo + '/x.js');
const ts = require(join(repo, 'node_modules', 'typescript'));

const outDir = join(repo, 'node_modules', '.hc-local-api');
const work = '/tmp/hc-local-api';
mkdirSync(work, { recursive: true });
mkdirSync(outDir, { recursive: true });

function transpileTree(srcRoot, destRoot, rewrite) {
  const files = [];
  const collect = (dir) => {
    for (const name of execFileSync('ls', ['-1', dir]).toString().trim().split('\n')) {
      if (!name) continue;
      const full = join(dir, name);
      if (execFileSync('stat', ['-c', '%F', full]).toString().trim() === 'directory') collect(full);
      else if (name.endsWith('.ts')) files.push(full);
    }
  };
  collect(srcRoot);
  for (const file of files) {
    const rel = file.slice(srcRoot.length + 1).replace(/\.ts$/, '.mjs');
    const dest = join(destRoot, rel);
    execFileSync('mkdir', ['-p', dirname(dest)]);
    const source = readFileSync(file, 'utf8');
    let output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    output = rewrite(output);
    writeFileSync(dest, output);
  }
}

// The shared core package.
const coreSrc = join(repo, 'packages', 'core', 'src');
const coreOut = join(outDir, '_core');
transpileTree(coreSrc, coreOut, (o) => {
  let output = o.replace(/(from\s+['"])(\.\.?\/[^'"]+?)\.ts(['"])/g, '$1$2.mjs$3');
  output = output.replace(/(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g, (m, a, b, c) =>
    (b.endsWith('.mjs') ? m : `${a}${b}.mjs${c}`));
  return output;
});
writeFileSync(join(coreOut, 'package.json'), JSON.stringify({
  name: '@homecoreos/core', type: 'module', main: './index.mjs',
  exports: { '.': './index.mjs' },
}));

// The API itself.
const apiDir = join(repo, 'apps', 'api', 'src');
transpileTree(apiDir, outDir, (o) => {
  let output = o.replace(/(from\s+['"])(\.\.?\/[^'"]+?)\.ts(['"])/g, '$1$2.mjs$3');
  output = output.replace(/(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g, (m, a, b, c) =>
    (b.endsWith('.mjs') ? m : `${a}${b}.mjs${c}`));
  return output;
});
writeFileSync(join(outDir, 'package.json'), JSON.stringify({ name: 'hc-local-api', type: 'module' }));

// Resolve @homecoreos/core to the transpiled copy.
const coreUrl = pathToFileURL(join(coreOut, 'index.mjs')).href;
const { register } = require('node:module');
register(
  `data:text/javascript,${encodeURIComponent(`
    import { pathToFileURL } from 'node:url';
    export function resolve(specifier, context, next) {
      if (specifier === '@homecoreos/core') return { url: '${coreUrl}', shortCircuit: true };
      return next(specifier, context);
    }
  `)}`,
  pathToFileURL(join(work, 'hooks.mjs')),
);

const { createApp } = await import(pathToFileURL(join(outDir, 'app.mjs')).href);
const { createCloudRuntime } = await import(pathToFileURL(join(outDir, 'runtime/cloud.mjs')).href);

const bindings = {
  SUPABASE_URL: process.env.SUPABASE_URL || 'http://127.0.0.1:3002',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || readFileSync('/tmp/service_role.jwt', 'utf8').trim(),
  // The pepper for password hashing, pairing codes and signed links. It is
  // kept in a file so a restart does not invalidate every stored password.
  SIGNING_KEY: process.env.SIGNING_KEY || readSigningKey(),
  EMQX_API_BASE: process.env.EMQX_API_BASE || 'http://127.0.0.1:3004/api/v5',
  EMQX_APP_ID: process.env.EMQX_APP_ID || 'local',
  EMQX_APP_SECRET: process.env.EMQX_APP_SECRET || 'local',
  EMQX_BROKER_HOST: process.env.EMQX_BROKER_HOST || 'broker.local',
  EMQX_TLS_PORT: process.env.EMQX_TLS_PORT || '8883',
};

/** Reads the local signing key, creating it once if it is not there yet. */
function readSigningKey() {
  const file = process.env.SIGNING_KEY_FILE || '/tmp/homecoreos-signing.key';
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch { /* first run */ }
  const key = randomBytes(32).toString('hex');
  writeFileSync(file, key);
  return key;
}

const rt = await createCloudRuntime(bindings);
const app = createApp(rt);

const port = Number(process.env.PORT || 8787);
const server = (await import('node:http')).createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const url = `http://127.0.0.1:${port}${req.url}`;
  const init = {
    method: req.method,
    headers: Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  };
  try {
    const response = await app.fetch(new Request(url, init), bindings, {});
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error('[local-api]', e);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
});
server.listen(port, '0.0.0.0', () => console.log(`[local-api] listening on ${port}`));
