/**
 * Calls the API's auth path directly, with the real database behind it, and
 * prints the real error instead of the generic "Internal error" the console
 * would show.
 *
 *   node scripts/dev/probe_auth.mjs
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const repo = '/home/user/repo';
const require = createRequire(repo + '/x.js');

const outDir = join(repo, 'node_modules', '.hc-local-api');
const coreUrl = pathToFileURL(join(outDir, '_core', 'index.mjs')).href;
const { register } = require('node:module');
register(
  `data:text/javascript,${encodeURIComponent(`
    import { pathToFileURL } from 'node:url';
    export function resolve(specifier, context, next) {
      if (specifier === '@homecoreos/core') return { url: '${coreUrl}', shortCircuit: true };
      return next(specifier, context);
    }
  `)}`,
  pathToFileURL('/tmp/hc-local-api/hooks.mjs'),
);

const { createCloudRuntime } = await import(pathToFileURL(join(outDir, 'runtime/cloud.mjs')).href);
const key = readFileSync('/tmp/service_role.jwt', 'utf8').trim();
const rt = await createCloudRuntime({
  SUPABASE_URL: 'http://127.0.0.1:3002',
  SUPABASE_SERVICE_ROLE_KEY: key,
});

const email = process.argv[2] || `probe-${Date.now()}@example.com`;
try {
  const r = await rt.auth.signup(email, 'correct-horse-battery',
    { full_name: 'Probe', home_name: 'Probe Home', timezone: 'UTC' }, {});
  console.log('signup OK:', JSON.stringify({ ...r, recoveryCodes: (r.recoveryCodes || []).length }));
} catch (e) {
  console.log('signup FAILED:', e?.constructor?.name, '-', e?.message);
  console.log(e?.stack?.split('\n').slice(0, 10).join('\n'));
}
