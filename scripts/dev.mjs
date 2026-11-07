/** One command for the whole local stack: broker + API + Pages frontend. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const procs = [];
function start(name, cmd, args, env = {}) {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  p.on('exit', (code) => console.log(`[${name}] exited ${code}`));
  procs.push(p);
  return p;
}
start('broker', process.execPath, ['--import', 'tsx', 'apps/broker/src/local-broker.ts']);
await new Promise((r) => setTimeout(r, 900));
// No --watch on the API: PGlite keeps a single-writer WASM Postgres data dir.
// Restart `npm run dev` after backend edits to avoid two processes opening it.
start('api', process.execPath, ['--import', 'tsx', 'apps/api/src/local-server.ts']);
await new Promise((r) => setTimeout(r, 1400));
start('web', 'npm', ['run', 'dev', '-w', 'apps/web', '--', '--port', '5173']);
process.on('SIGTERM', () => { for (const p of procs) p.kill('SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { for (const p of procs) p.kill('SIGTERM'); process.exit(0); });
