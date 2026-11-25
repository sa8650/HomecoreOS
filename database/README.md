# Database

## Migrations

`migrations/0001_init.sql` is the complete baseline schema: every table,
constraint, index, trigger and RPC function, plus the seeded Board Library and
platform settings row. Every later change is its own numbered file.

Apply every migration to an empty database in filename order:

```bash
for file in database/migrations/*.sql; do
  psql "$DATABASE_URL" -f "$file"
done
```

`0001_init.sql` stays frozen the way any applied migration does; new schema
changes are new numbered files (`0004_*.sql`, `0005_*.sql`, …).

Applied migrations:

| File | Purpose |
|---|---|
| `0001_init.sql` | Complete baseline schema (frozen). |
| `0002_board_roles.sql` | Board roles on `board_instances`: `board_role` (default `controller`), `assigned_controller_id` (Node → hosting Controller), `comm_mode`, `node_link_state`, `espnow_channel`, `node_last_linked_at`, `role_changed_at`, with role/assignment CHECK constraints and the `idx_board_instances_board_role` / `idx_board_instances_assigned_controller` indexes. |
| `0003_user_onboarding.sql` | Mandatory four-step onboarding on `users`: `onboarding_step` (1..4, default 1), `onboarding_started_at`, `onboarding_completed_at`, the two CHECK constraints that keep steps in range and only allow completion at step 4, the partial index `idx_users_onboarding_pending`, and a one-time backfill that marks every pre-existing user as completed so nobody is interrupted. |
| `0004_password_reset_otp.sql` | Password recovery by emailed six-digit code: the `password_reset_otps` table (hashed code, attempt counter, expiry, single-use reset token) with its indexes, plus the administrator-managed Brevo sender columns `brevo_from_name`, `brevo_from_email` and `brevo_reply_to` on `platform_settings`. |
| `0005_realtime_sync.sql` | Browser real-time channel bookkeeping: the `realtime_web_sessions` table (one row per login session holding only the provisioned, subscribe-only MQTT username and its lifecycle timestamps; the broker password is derived from the EMQX app secret and is never stored) with its partial index and its foreign keys to `sessions`, `accounts` and `users`. |
| `0006_recovery_sessions.sql` | Persisted board-repair sessions, structured diagnostics, staged events, final reports, expiry, and the one-active-session-per-board guard. Recovery records intentionally exclude credentials. |
| `0007_pairing_identity_reuse.sql` | `resolve_pairing_board(...)` safely reuses an existing board identity for a same-account setup slot, with ownership checks and no destructive merge of boards that already hold inventory or assignments. |
| `0008_board_recovery_health.sql` | Additive nullable health facts on `board_instances` (partition, uptime, heap, backend URL, OTA state, ESP-NOW state, and Wi-Fi/BLE capability) for server-side recovery diagnosis. |
| `0009_physical_sensor_instances.sql` | Adds `physical_sensor_instances`, links measurement entities through `sensors.physical_sensor_id`, stores driver configuration, and backfills existing sensor bindings without replacing sensor IDs or telemetry history. |

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

PGlite-backed integration tests in `apps/worker/test` use
`test/helpers/pglite-postgrest.ts` to apply this directory before exercising
Worker behavior. The full Worker suite also includes unit and route-level tests;
not every test creates a database instance.
