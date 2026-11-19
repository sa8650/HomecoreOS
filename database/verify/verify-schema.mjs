#!/usr/bin/env node
// Verifies that database/migrations/ rebuilds exactly the schema captured in
// database/verify/schema-snapshot.json.
//
//   node database/verify/verify-schema.mjs            # check
//   node database/verify/verify-schema.mjs --update   # rewrite the snapshot
//
// The check applies every migration to a throwaway Postgres (PGlite, the same
// engine the worker tests use) and compares tables, columns, constraints,
// indexes, triggers, functions, sequences and seed rows against the snapshot.
// Exit code is 1 on any drift, so it can run in CI before a deploy.

import fs from "node:fs";
import path from "node:path";
import { buildDatabase, sqlFilesIn, fingerprint, diffFingerprints, REPO_ROOT } from "./lib.mjs";

const MIGRATIONS_DIR = path.join(REPO_ROOT, "database/migrations");
const SNAPSHOT_PATH = path.join(REPO_ROOT, "database/verify/schema-snapshot.json");

const files = sqlFilesIn(MIGRATIONS_DIR);
const pg = await buildDatabase(files);
const actual = await fingerprint(pg);
await pg.close();

const tableCount = Object.keys(actual.tables).length;
const seedRows = Object.values(actual.tables).reduce((n, t) => n + t.rowCount, 0);
console.log(
  `schema built from ${files.length} migration file(s): ` +
    `${tableCount} tables, ${Object.keys(actual.functions).length} functions, ${seedRows} seeded rows`
);

if (process.argv.includes("--update")) {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(actual, null, 2) + "\n");
  console.log(`snapshot updated: ${path.relative(REPO_ROOT, SNAPSHOT_PATH)}`);
  process.exit(0);
}

if (!fs.existsSync(SNAPSHOT_PATH)) {
  console.error(`missing snapshot: ${path.relative(REPO_ROOT, SNAPSHOT_PATH)} (run with --update)`);
  process.exit(1);
}

const expected = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
const diffs = diffFingerprints(expected, actual);

if (diffs.length === 0) {
  console.log("schema matches snapshot ✓");
  process.exit(0);
}

console.error(`\nschema drift detected (${diffs.length} difference(s)):`);
for (const d of diffs) console.error("  " + d);
console.error(
  "\nIf the change is intended, re-run with --update and commit the new snapshot."
);
process.exit(1);
