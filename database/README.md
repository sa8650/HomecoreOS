# Database

## One migration

`migrations/0001_init.sql` is the complete schema: 32 tables, every constraint,
index, trigger and RPC function, plus the seeded board catalog and platform
settings row. It is the merged result of the historical `0001`–`0021` chain —
objects that those migrations created and later dropped (the `areas` table,
legacy board PNG URLs, superseded CHECK constraints) do not appear, and eight
indexes that were fully covered by a wider index on the same table were removed
(they are listed at the top of section 1 in the file).

Apply it to an empty database:

```bash
psql "$DATABASE_URL" -f database/migrations/0001_init.sql
```

Future schema changes are new numbered files (`0002_*.sql`, `0003_*.sql`, …);
`0001_init.sql` stays frozen the way any applied migration does.

Applied migrations:

| File | Purpose |
|---|---|
| `0001_init.sql` | Complete baseline schema (frozen). |
| `0002_device_roles.sql` | Unified Controller/Node roles: `device_role` (default `controller`, so every existing row keeps its behaviour), `assigned_controller_id`, `comm_mode`, `node_link_state`, `espnow_channel`, `node_last_linked_at`, `role_changed_at`, plus the two role indexes. Purely additive. |

## Verifying the schema

```bash
npm run db:verify            # replay migrations, compare with the snapshot
npm run db:verify -- --update  # accept the current schema as the new baseline
```

`verify-schema.mjs` builds a throwaway Postgres (PGlite — the same engine the
worker tests use), applies every migration in filename order and fingerprints
the result: tables, column types/defaults/nullability, constraints, indexes,
triggers, function bodies, sequences and seed rows. Surrogate keys are abstracted
away (`<pk>` and referenced labels such as a board `slug`), so a rebuilt database
compares equal even though UUIDs and `now()` stamps differ per run.

The fingerprint lives in `verify/schema-snapshot.json` and is committed, so a
pull request that changes schema without a migration fails `npm run db:verify`.

The worker test suite (`apps/worker/test`) also applies this directory on every
run through `test/helpers/pglite-postgrest.ts`, so the migration is exercised by
70 integration tests covering auth, isolation, MQTT ingest, firmware and planner
flows.
