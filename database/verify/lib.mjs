import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
let PGlite;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  // Not hoisted to the repo root (npm workspace layout can differ): fall back to
  // the worker workspace, which declares it as a devDependency.
  ({ PGlite } = await import("../../apps/worker/node_modules/@electric-sql/pglite/dist/index.js"));
}

export const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

/** Apply a list of .sql files (absolute paths, applied in order) to a fresh PGlite database. */
export async function buildDatabase(files) {
  const pg = new PGlite();
  await pg.waitReady;
  for (const file of files) {
    const sql = fs.readFileSync(file, "utf8");
    try {
      await pg.exec(sql);
    } catch (err) {
      throw new Error(`Failed applying ${path.basename(file)}: ${err.message}`);
    }
  }
  return pg;
}

export function sqlFilesIn(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => path.join(dir, f));
}

const q = async (pg, sql) => (await pg.query(sql)).rows;

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_PREFERENCE = ["slug", "email", "code_hash", "hardware_uid", "name"];

/** Public tables, excluding extension-owned relations. */
async function listTables(pg) {
  return (
    await q(
      pg,
      `SELECT c.relname n FROM pg_class c
         JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'public' AND c.relkind = 'r'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
        ORDER BY 1`
    )
  ).map((r) => r.n);
}

async function columnsOf(pg, table) {
  return q(
    pg,
    `SELECT a.attname col, format_type(a.atttypid, a.atttypmod) type,
            a.attnotnull nn, a.attidentity ident,
            COALESCE(pg_get_expr(d.adbin, d.adrelid), '') def
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'public.${table}'::regclass
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`
  );
}

/** PK columns and foreign-key columns per table. */
async function relationsOf(pg) {
  const pks = new Map();
  const fks = new Map();
  const rows = await q(
    pg,
    `SELECT t.relname tbl, c.contype type, c.conname name,
            a.attname col, rt.relname reftbl, ra.attname refcol
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace s ON s.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       LEFT JOIN pg_class rt ON rt.oid = c.confrelid
       LEFT JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = ANY (c.confkey)
      WHERE s.nspname = 'public' AND c.contype IN ('p', 'f')
      ORDER BY t.relname, c.conname, a.attname`
  );
  for (const r of rows) {
    if (r.type === "p") {
      if (!pks.has(r.tbl)) pks.set(r.tbl, new Set());
      pks.get(r.tbl).add(r.col);
    } else {
      if (!fks.has(r.tbl)) fks.set(r.tbl, new Map());
      fks.get(r.tbl).set(r.col, { table: r.reftbl, column: r.refcol });
    }
  }
  return { pks, fks };
}

/**
 * Rows are compared with surrogate keys abstracted away: a row's own UUID key
 * becomes `<pk>` and a foreign-key UUID becomes the referenced row's readable
 * label (board slug, user email, ...). Fresh UUIDs therefore compare equal
 * while every meaningful value and every relationship is still verified.
 */
async function serializeRows(pg, table, rows, pks, fks) {
  const pkCols = pks.get(table) ?? new Set();
  const fkCols = fks.get(table) ?? new Map();

  // Resolve reference labels once per referenced table.
  const labelMaps = new Map();
  for (const ref of fkCols.values()) {
    if (labelMaps.has(ref.table)) continue;
    let map = null;
    const refCols = (await columnsOf(pg, ref.table)).map((c) => c.col);
    const labelCol = LABEL_PREFERENCE.find((c) => refCols.includes(c));
    if (labelCol) {
      const refRows = await q(pg, `SELECT id::text AS id, ${labelCol}::text AS label FROM public.${ref.table}`);
      map = new Map(refRows.map((r) => [r.id, r.label]));
    }
    labelMaps.set(ref.table, map);
  }

  const out = [];
  for (const row of rows) {
    const obj = {};
    for (const [col, value] of Object.entries(row)) {
      if (value instanceof Date) {
        obj[col] = "<timestamp>";
      } else if (typeof value === "string" && TIMESTAMP_RE.test(value)) {
        obj[col] = "<timestamp>";
      } else if (typeof value === "bigint") {
        obj[col] = String(value);
      } else if (typeof value === "string" && UUID_RE.test(value)) {
        if (pkCols.has(col)) {
          obj[col] = "<pk>";
        } else if (fkCols.has(col)) {
          const ref = fkCols.get(col);
          const label = labelMaps.get(ref.table)?.get(value);
          obj[col] = label !== undefined ? `ref:${label}` : "<uuid>";
        } else {
          obj[col] = "<uuid>";
        }
      } else {
        obj[col] = value;
      }
    }
    out.push(JSON.stringify(obj));
  }
  return out.sort();
}

/** Deterministic fingerprint of the public schema plus its seed rows. */
export async function fingerprint(pg) {
  const fp = { tables: {}, functions: {}, sequences: {} };
  const tables = await listTables(pg);
  const { pks, fks } = await relationsOf(pg);

  for (const t of tables) {
    const columns = (await columnsOf(pg, t)).map(
      (c) =>
        `${c.col} ${c.type}${c.ident ? " identity=" + c.ident : ""}${c.nn ? " NOT NULL" : ""}${
          c.def ? " DEFAULT " + c.def : ""
        }`
    );

    const constraints = (
      await q(
        pg,
        `SELECT conname, contype, pg_get_constraintdef(oid) def FROM pg_constraint
          WHERE conrelid = 'public.${t}'::regclass ORDER BY conname`
      )
    ).map((c) => `${c.conname} ${c.contype} ${c.def}`);

    const indexes = (
      await q(
        pg,
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = '${t}' ORDER BY indexname`
      )
    ).map((i) => `${i.indexname} ${i.indexdef}`);

    const triggers = (
      await q(
        pg,
        `SELECT tgname, pg_get_triggerdef(oid) def FROM pg_trigger
          WHERE tgrelid = 'public.${t}'::regclass AND NOT tgisinternal ORDER BY tgname`
      )
    ).map((g) => `${g.tgname} ${g.def}`);

    const rows = await q(pg, `SELECT * FROM public.${t}`);
    const serialized = await serializeRows(pg, t, rows, pks, fks);

    fp.tables[t] = {
      columns,
      constraints,
      indexes,
      triggers,
      rowCount: rows.length,
      dataHash: crypto.createHash("sha256").update(serialized.join("\n")).digest("hex"),
    };
  }

  fp.functions = Object.fromEntries(
    (
      await q(
        pg,
        `SELECT p.proname n, pg_get_functiondef(p.oid) def FROM pg_proc p
           JOIN pg_namespace s ON s.oid = p.pronamespace
          WHERE s.nspname = 'public' AND p.prokind = 'f' ORDER BY 1`
      )
    ).map((f) => [f.n, f.def])
  );

  fp.sequences = Object.fromEntries(
    (
      await q(
        pg,
        `SELECT sequencename n, data_type, start_value, increment_by FROM pg_sequences
          WHERE schemaname = 'public' ORDER BY 1`
      )
    ).map((s) => [s.n, `${s.data_type} start=${s.start_value} inc=${s.increment_by}`])
  );

  return fp;
}

/** Human-readable list of differences between two fingerprints. */
export function diffFingerprints(expected, actual) {
  const diffs = [];
  const cmpList = (label, a = [], b = []) => {
    const setB = new Set(b);
    const setA = new Set(a);
    for (const x of a) if (!setB.has(x)) diffs.push(`- ${label}: ${x}`);
    for (const x of b) if (!setA.has(x)) diffs.push(`+ ${label}: ${x}`);
  };

  cmpList("table", Object.keys(expected.tables), Object.keys(actual.tables));

  for (const t of Object.keys(expected.tables)) {
    if (!actual.tables[t]) continue;
    const a = expected.tables[t];
    const b = actual.tables[t];
    cmpList(`${t} column`, a.columns, b.columns);
    cmpList(`${t} constraint`, a.constraints, b.constraints);
    cmpList(`${t} index`, a.indexes, b.indexes);
    cmpList(`${t} trigger`, a.triggers, b.triggers);
    if (a.rowCount !== b.rowCount) diffs.push(`~ ${t} rowCount: expected ${a.rowCount}, got ${b.rowCount}`);
    if (a.dataHash !== b.dataHash) diffs.push(`~ ${t} seed data differs`);
  }

  cmpList("function", Object.keys(expected.functions), Object.keys(actual.functions));
  for (const f of Object.keys(expected.functions)) {
    if (actual.functions[f] && actual.functions[f] !== expected.functions[f]) {
      diffs.push(`~ function body changed: ${f}`);
    }
  }
  cmpList("sequence", Object.keys(expected.sequences), Object.keys(actual.sequences));
  return diffs;
}
