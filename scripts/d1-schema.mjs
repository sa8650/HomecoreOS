/**
 * Generates the Cloudflare D1 (SQLite) schema + seed from the SAME Postgres
 * migrations and board catalog that Supabase uses. This keeps column names,
 * table names and feature data identical across both database providers.
 *
 * Run: node scripts/d1-schema.mjs
 * Output: apps/api/src/db/d1-schema.ts (embedded SQL, so Cloudflare's bundler
 *         needs no filesystem or raw-SQL loader).
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const OUT = resolve(ROOT, 'apps/api/src/db/d1-schema.ts');

/** Split a SQL file into statements, respecting $$ bodies, quotes, comments, parens. */
function statements(sql) {
  const out = [];
  let cur = '', depth = 0, quote = null, dollar = false, lineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], n = sql[i + 1];
    if (lineComment) { if (c === '\n') { lineComment = false; cur += c; } continue; }
    if (dollar) {
      cur += c;
      if (c === '$' && n === '$') { cur += n; i++; dollar = false; }
      continue;
    }
    if (quote) {
      cur += c;
      if (c === quote) { if (n === quote) { cur += n; i++; } else quote = null; }
      continue;
    }
    if (c === '-' && n === '-') { lineComment = true; i++; continue; }
    if (c === '$' && n === '$') { dollar = true; cur += c + n; i++; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ';' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((s) => s && !s.startsWith('--'));
}

/** Split a CREATE TABLE body on top-level commas. */
function splitColumns(body) {
  const out = [];
  let cur = '', depth = 0, quote = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i], n = body[i + 1];
    if (quote) {
      cur += c;
      if (c === quote) { if (n === quote) { cur += n; i++; } else quote = null; }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const jsonCols = {};
const arrayCols = {};
const boolCols = {};
const numericCols = {};
const tableNames = [];
const columns = {};
const autoIdTables = [];

function record(table, col, kind) {
  const m = { json: jsonCols, array: arrayCols, bool: boolCols, numeric: numericCols }[kind];
  (m[table] ||= []).push(col);
}

function stripBalanced(s, startIndex) {
  let depth = 0;
  for (let i = startIndex; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return s.length;
}

function convertColumn(table, raw) {
  let line = raw.replace(/--[^\n]*/g, '').trim();
  if (!line) return null;
  // Table-level constraints must be handled before the column parser: otherwise
  // `unique (a, b)` looks like a column named `unique`.
  if (/^(constraint\s+\w+\s+)?check\s*\(/i.test(line)) return null;
  if (/^constraint\s+\w+\s+foreign/i.test(line)) return null;
  if (/^constraint\s+\w+\s+unique/i.test(line)) return line.replace(/^constraint\s+\w+\s+/i, '');
  if (/^constraint\s+\w+\s+primary/i.test(line)) return line.replace(/^constraint\s+\w+\s+/i, '');
  if (/^(unique|primary\s+key|foreign\s+key)\s*\(/i.test(line)) return line;
  const first = line.match(/^([a-z_][a-z0-9_]*)\s+([\s\S]*)$/i);
  if (!first) return null;
  const col = first[1];
  let rest = first[2].replace(/\s+/g, ' ').trim();

  // Identity column -> SQLite autoincrement primary key.
  if (/generated\s+always\s+as\s+identity/i.test(rest)) {
    if (col === 'id') autoIdTables.push(table);
    return `${col} INTEGER PRIMARY KEY AUTOINCREMENT`;
  }

  // Detect the declared type (first token, possibly with parens / []).
  const typeMatch = rest.match(/^(uuid|timestamptz|timestamp|jsonb|text\[\]|text|boolean|smallint|bigint|integer|numeric\(\d+,\d+\)|numeric|real|double precision|bytea|date)\b/i);
  let type = typeMatch ? typeMatch[1].toLowerCase() : 'text';
  rest = typeMatch ? rest.slice(typeMatch[0].length).trim() : rest;

  let sqliteType = 'TEXT';
  if (type === 'jsonb') { sqliteType = 'TEXT'; record(table, col, 'json'); }
  else if (type === 'text[]') { sqliteType = 'TEXT'; record(table, col, 'array'); }
  else if (type === 'boolean') { sqliteType = 'INTEGER'; record(table, col, 'bool'); }
  else if (['smallint', 'bigint', 'integer'].includes(type)) sqliteType = 'INTEGER';
  else if (type.startsWith('numeric') || type === 'real' || type === 'double precision') { sqliteType = 'REAL'; record(table, col, 'numeric'); }
  else if (type === 'bytea') sqliteType = 'BLOB';

  // Drop CHECK clauses (enforced in the TypeScript domain layer for D1).
  rest = rest.replace(/check\s*\(/gi, ' CHECK_SENTINEL(');
  while (/CHECK_SENTINEL\(/i.test(rest)) {
    const i = rest.search(/CHECK_SENTINEL\(/i);
    const end = stripBalanced(rest, i + 'CHECK_SENTINEL'.length);
    rest = rest.slice(0, i) + rest.slice(end);
  }
  // Drop FK references (server-side tenant scoping is authoritative).
  rest = rest.replace(/references\s+[a-z_.]+\([^)]*\)(?:\s+on\s+delete\s+(?:cascade|set\s+null|restrict))?/gi, '');
  // Normalise defaults.
  rest = rest.replace(/default\s+gen_random_uuid\(\)/gi, '');
  rest = rest.replace(/default\s+now\(\)/gi, "default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
  rest = rest.replace(/default\s+'\{\}'::jsonb/gi, "default '{}'");
  rest = rest.replace(/'::jsonb/gi, "'");
  rest = rest.replace(/::jsonb/gi, '');
  rest = rest.replace(/default\s+true/gi, 'default 1').replace(/default\s+false/gi, 'default 0');
  rest = rest.replace(/default\s+'\{\}'/gi, "default '{}'");
  rest = rest.trim().replace(/\s+/g, ' ');
  return `${col} ${sqliteType}${rest ? ' ' + rest : ''}`;
}

const ddl = [];
ddl.push(`create table if not exists auth_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  raw_user_meta_data TEXT NOT NULL DEFAULT '{}',
  password_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);
ddl.push(`create table if not exists _d1_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);

const files = readdirSync(MIGRATIONS).filter((f) => /^000[2-5]_.*\.sql$/.test(f)).sort();
for (const f of files) {
  const sql = readFileSync(resolve(MIGRATIONS, f), 'utf8');
  for (const st of statements(sql)) {
    const tm = st.match(/^create\s+table\s+if\s+not\s+exists\s+public\.([a-z_][a-z0-9_]*)\s*\(([\s\S]*)\)$/i);
    if (tm) {
      const table = tm[1];
      tableNames.push(table);
      const cols = splitColumns(tm[2]).map((x) => convertColumn(table, x)).filter(Boolean);
      columns[table] = cols.map((c) => c.trim().split(/\s+/)[0]);
      ddl.push(`create table if not exists ${table} (\n  ${cols.join(',\n  ')}\n);`);
      continue;
    }
    const im = st.match(/^create\s+(unique\s+)?index\s+if\s+not\s+exists\s+/i);
    if (im) {
      let idx = st.replace(/public\./gi, '')
        .replace(/::[a-z][a-z0-9_ ]*/gi, '')
        .replace(/\s+/g, ' ').trim();
      // Ignore Postgres-only operator classes / expressions SQLite lacks.
      if (/lower\(email\)/.test(idx) && !/^\s*create\s+unique\s+index/i.test(idx)) continue;
      ddl.push(idx + ';');
    }
  }
}

// ---------------------------------------------------------------------------
// Seed: permissions, roles, role_permissions, templates, platform settings,
// board catalog + verified pin rows. Mirrors 0007_seed.sql / 0008 board data.
// ---------------------------------------------------------------------------
const q = (v) => v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
const permissions = [
  ['dashboard.view', 'Dashboard access', 'View dashboard', 'Read the home overview and live status', 10],
  ['rooms.manage', 'Room management', 'Manage rooms', 'Create, edit and archive rooms', 20],
  ['boards.manage', 'Board management', 'Manage controllers', 'Register boards and edit pin assignments', 30],
  ['devices.manage', 'Device management', 'Manage devices', 'Create, edit and delete switches and sensors', 40],
  ['devices.control', 'Switch control', 'Control switches', 'Send ON/OFF commands to devices', 50],
  ['sensors.view', 'Sensor monitoring', 'View sensor telemetry', 'Read sensor values and history', 60],
  ['automation.manage', 'Automation management', 'Manage automation', 'Create, edit and run automations', 70],
  ['devices.configure', 'Device configuration', 'Configure devices', 'Change firmware config, mappings and sync', 80],
  ['firmware.update', 'Firmware updates', 'Manage firmware', 'Publish releases and start OTA updates', 90],
  ['staff.manage', 'Staff management', 'Manage staff', 'Invite, remove and change staff permissions', 100],
  ['usage.view', 'Usage viewing', 'View usage', 'View account usage estimates', 110],
  ['settings.manage', 'Account settings', 'Manage account settings', 'Change home, security and notification settings', 120],
];
const roles = [
  ['00000000-0000-4000-8000-000000000001', 'owner', 'Owner', 'Complete workspace access', 0],
  ['00000000-0000-4000-8000-000000000002', 'administrator', 'Administrator', 'Manage home hardware and automation', 10],
  ['00000000-0000-4000-8000-000000000003', 'operator', 'Operator', 'Control permitted devices', 20],
  ['00000000-0000-4000-8000-000000000004', 'viewer', 'Viewer', 'Read-only access', 30],
];
const operatorPerms = ['dashboard.view', 'devices.control', 'sensors.view', 'automation.manage'];
const viewerPerms = ['dashboard.view', 'sensors.view'];
const adminExcluded = ['staff.manage', 'settings.manage'];

const seed = [];
seed.push('insert or ignore into permissions (key, category, label, description, sort_order) values\n' +
  permissions.map((p) => `  (${q(p[0])}, ${q(p[1])}, ${q(p[2])}, ${q(p[3])}, ${p[4]})`).join(',\n') + ';');
seed.push('insert or ignore into roles (id, tenant_id, key, name, description, rank, is_system) values\n' +
  roles.map((r) => `  (${q(r[0])}, null, ${q(r[1])}, ${q(r[2])}, ${q(r[3])}, ${r[4]}, 1)`).join(',\n') + ';');
const rp = [];
for (const r of roles) {
  for (const p of permissions) {
    const key = r[1], pk = p[0];
    const allowed = key === 'owner' || (key === 'administrator' && !adminExcluded.includes(pk))
      || (key === 'operator' && operatorPerms.includes(pk))
      || (key === 'viewer' && viewerPerms.includes(pk));
    if (allowed) rp.push(`  (${q(r[0])}, ${q(pk)})`);
  }
}
seed.push('insert or ignore into role_permissions (role_id, permission_key) values\n' + rp.join(',\n') + ';');

const templates = [
  ['light', 'Light', 'light', 'lightbulb'], ['fan', 'Fan', 'fan', 'fan'],
  ['water_pump', 'Water pump', 'water_pump', 'droplet'], ['relay', 'Relay', 'relay', 'power'],
  ['smart_socket', 'Smart socket', 'smart_socket', 'plug'], ['motor', 'Motor', 'motor', 'cog'],
  ['main_line', 'Main line monitor', 'main_line_monitor', 'activity'],
];
seed.push('insert or ignore into device_templates (id, tenant_id, key, name, device_type, icon, default_config, is_system) values\n' +
  templates.map((t, i) => `  (${q(`00000000-0000-4000-8000-00000000${String(1000 + i).padStart(4, '0')}`)}, null, ${q(t[0])}, ${q(t[1])}, ${q(t[2])}, ${q(t[3])}, ${q(JSON.stringify(t[0] === 'main_line' ? { interface: 'adc' } : { initial_state: 'off', active_low: false, interface: 'gpio' }))}, 1)`).join(',\n') + ';');

const settings = [
  ['mqtt.provider', '"emqx"'], ['mqtt.broker_host', '""'], ['mqtt.port_tls', '8883'],
  ['mqtt.wss_host', '""'], ['mqtt.wss_port', '8084'], ['mqtt.deployment_endpoint', '""'],
  ['mqtt.last_sync_at', 'null'], ['registration.enabled', 'true'],
  ['registration.pairing_ttl_seconds', '900'], ['registration.rate_limit_per_hour', '10'],
  ['features.ota', 'true'], ['features.automation', 'true'], ['features.custom_boards', 'true'],
  ['features.staff_invites', 'true'], ['security.command_ttl_seconds', '30'],
  ['security.cmd_rate_limit_per_minute', '60'], ['usage.warning_thresholds', '[50,75,90,100]'],
  ['usage.quotas', '{"session_minutes":1000000,"traffic_bytes":1073741824,"rule_actions":1000000,"connections":1000}'],
];
seed.push('insert or ignore into platform_settings (key, value, is_secret) values\n' +
  settings.map(([k, v]) => `  (${q(k)}, ${q(v)}, 0)`).join(',\n') + ';');

const catalog = JSON.parse(readFileSync(resolve(ROOT, 'packages/core/data/board-catalog.json'), 'utf8'));
const boards = catalog.boards;
seed.push('insert or ignore into board_catalog (id, manufacturer, model, variant, chip_family, chip_variant, revision, category, image_url, pinout_url, doc_source_url, summary, connectivity, attributes, active) values\n' +
  boards.map((b) => `  (${q(b.id)}, ${q(b.manufacturer)}, ${q(b.model)}, ${q(b.variant || null)}, ${q(b.chip_family)}, ${q(b.chip_variant)}, ${q(b.revision || null)}, ${q(b.category)}, null, ${q(b.pinout_url || null)}, ${q(b.doc_source_url || null)}, ${q(b.summary)}, ${q('{}')}, ${q(JSON.stringify({ ...b.attributes, pin_status: b.pin_status, catalog_version: b.version }))}, 1)`).join(',\n') + ';');
seed.push('insert or ignore into board_catalog_versions (id, board_id, version, changelog, published) values\n' +
  boards.map((b, i) => `  (${q(`00000000-0000-4000-8000-10000000${String(1000 + i).padStart(4, '0')}`)}, ${q(b.id)}, ${b.version || 1}, ${q(b.pin_status === 'verified' ? 'Initial verified header-pin map from official Espressif user guide.' : 'Chip family registered; dev-board pin map pending verification.')}, 1)`).join(',\n') + ';');
const pinRows = [];
let pinSeq = 0;
for (const b of boards) {
  for (const p of b.pins || []) {
    pinSeq++;
    const id = `00000000-0000-4000-8000-2000${String(pinSeq).padStart(8, '0')}`;
    pinRows.push(`  (${q(id)}, ${q(b.id)}, ${p.gpio}, ${q(p.header_label || null)}, ${q(p.side || null)}, ${p.header_pin ?? 'null'}, ${q(JSON.stringify(p.functions || []))}, ${q(JSON.stringify(p.adc_channels || []))}, ${p.adc_bits ?? 'null'}, ${p.input_only ? 1 : 0}, ${p.exposed === false ? 0 : 1}, ${p.boot_strapping ? 1 : 0}, ${p.usb_jtag ? 1 : 0}, ${p.flash_connected ? 1 : 0}, ${p.psram_connected ? 1 : 0}, ${q(p.touch_channel || null)}, ${p.rtc_gpio ? 1 : 0}, ${p.restricted ? 1 : 0}, ${q(p.restriction_note || null)}, ${q(p.notes || null)})`);
  }
}
if (pinRows.length) {
  seed.push('insert or ignore into board_catalog_pins (id, board_id, gpio, header_label, side, header_pin, functions, adc_channels, adc_bits, input_only, exposed, boot_strapping, usb_jtag, flash_connected, psram_connected, touch_channel, rtc_gpio, restricted, restriction_note, notes) values\n' + pinRows.join(',\n') + ';');
}

columns.auth_users = ['id', 'email', 'raw_user_meta_data', 'password_hash', 'created_at'];
columns._d1_migrations = ['name', 'applied_at'];
const schemaSql = ddl.join('\n\n') + '\n';
const seedSql = seed.join('\n\n') + '\n';
const ts = `/**
 * GENERATED by scripts/d1-schema.mjs from supabase/migrations 0002-0005,
 * 0007 seed and packages/core/data/board-catalog.json. DO NOT EDIT BY HAND.
 * The D1 and Supabase providers share identical table/column names and seed.
 */
export const D1_SCHEMA_SQL = ${JSON.stringify(schemaSql)};
export const D1_SEED_SQL = ${JSON.stringify(seedSql)};
export const D1_TABLES = ${JSON.stringify(tableNames)} as const;
export const D1_COLUMNS: Record<string, string[]> = ${JSON.stringify(columns, null, 2)};
export const D1_JSON_COLUMNS: Record<string, string[]> = ${JSON.stringify(jsonCols, null, 2)};
export const D1_ARRAY_COLUMNS: Record<string, string[]> = ${JSON.stringify(arrayCols, null, 2)};
export const D1_AUTO_ID_TABLES = ${JSON.stringify([...new Set(autoIdTables)])} as const;
export const D1_BOOL_COLUMNS: Record<string, string[]> = ${JSON.stringify(boolCols, null, 2)};
export const D1_NUMERIC_COLUMNS: Record<string, string[]> = ${JSON.stringify(numericCols, null, 2)};
export const D1_MIGRATIONS = [
  { name: '0001_schema.sql', sql: D1_SCHEMA_SQL },
  { name: '0002_seed.sql', sql: D1_SEED_SQL },
] as const;
`;
writeFileSync(OUT, ts);
console.log(`D1 schema: ${tableNames.length} tables, ${Object.values(jsonCols).flat().length} json columns, ${pinRows.length} verified pin rows -> ${OUT}`);
