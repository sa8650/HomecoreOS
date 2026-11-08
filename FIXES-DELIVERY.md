# HomecoreOS — Firmware Upload & Supabase RLS fixes

Two defects were reported. Investigating the whole repository turned up **five** actual
bugs: the two reported, plus three that would have caused the fixes to appear to work
while the feature stayed broken. All five are fixed in source, with no workarounds.

---

## The short version

| # | Bug | Root cause | Where it was fixed |
|---|---|---|---|
| 1 | `42P01: relation "public.app_user_credentials" does not exist` | The security section created that table, copied from it, dropped it, then tried to `alter table … enable row level security` on the dropped table | `supabase/schema.sql` |
| 2 | Upload fails `400` / `23502` on `firmware_releases` | A `NOT NULL` column was not written by the uploader; the row was assembled differently from the table | `apps/api/src/firmware/releases.ts`, `supabase/schema.sql` |
| 3 | **A published release was stored with `board_models = {}`** | The uploader used its board list for its own checks but never wrote it into the row | `apps/api/src/firmware/releases.ts` |
| 4 | **Sign-in would fail with `permission denied for table app_users`** | `grant … on all tables` ran *before* the `app_*` auth tables were created, so the backend's `service_role` had no privilege on them | `supabase/schema.sql` |
| 5 | Legacy passwords above 100 000 PBKDF2 iterations could never be verified | The schema marked them `recovery-required`; the verifier refused anything above its own cost | `apps/api/src/crypto.ts`, `supabase/schema.sql` |

Bugs 3 and 4 are why "the upload works now" is not the same as "the feature works now".
Bug 3 meant a release uploaded cleanly, was listed in the Owner Console as published, and
was then offered to **no controller at all**. Bug 4 meant no one could sign in on a fresh
install. Both are now covered by regression tests.

---

## 1. The RLS `42P01` failure

**What was happening.** `supabase/schema.sql` created `public.app_user_credentials`, copied
its password hashes into `app_users`, and dropped it — then a later statement referenced it
again to enable row level security. Because Supabase's SQL editor runs the file as **one
transaction**, that single error rolled back the whole script: no tables changed, no RLS
enabled. It also failed on every re-run, so the database could never converge.

**The fix.** The table is no longer created. A guarded block reads it *only if the database
already has it* (decided at run time with `to_regclass`, so a fresh database never mentions
it):

- database has the legacy table → hashes are migrated into `app_users`, then the table is
  dropped. If anything still depends on it, the drop is refused and it is instead locked
  down with RLS plus revoked grants, with a `NOTICE` saying so. A password-hash table must
  never be left readable in the `public` schema.
- database does not have it → every existing profile is marked as needing a password reset,
  exactly as before.

Nothing later in the file depends on the table, so the `42P01` cannot come back.

**Verified:** a fresh database applies cleanly **three times in a row** with
`ON_ERROR_STOP=1`, giving **0 errors, 49 tables, 49/49 with RLS enabled**, and
`app_user_credentials` absent.

## 2. The upload `23502`

**What was happening.** `23502` means a `NOT NULL` column received `NULL`. The failing row
in the report — `(91de425e-…, null, dev, 1.0.0, esp32-s3, …)` — cannot identify the column
from the tuple alone, because `23502`'s own field and the nullable `tenant_id` shift every
position after them. Under PostgREST a *missing* key also produces `23502`, not `42703`.

**The fix, in both layers, because either alone can produce this error:**

- **Schema layer:** every `NOT NULL` column on `firmware_releases` now has an explicit
  default and a `comment on column` saying what it holds. Existing rows with a `NULL` in a
  column that is now `NOT NULL` are repaired first.
- **API layer:** `completeReleaseRow()` is the single place that builds the row. It fills
  every required column, validates `version`, `r2_key` and a 64-hex `sha256`, and throws
  **before anything is written** if the row is incomplete. Both upload paths — the ZIP
  package and the single image — go through it.

**Verified:** the row the uploader builds was compared against the live table.
`NOT NULL`-without-default columns: `r2_key`, `sha256`, `version` — all three present in
both artifacts. No null lands in a required column, and no key names a column that does not
exist.

## 3. Partial failures leave nothing behind

Both artifact images are uploaded to R2, each one read back and re-hashed to prove the
stored bytes match, and only then is the record written. If the record insert fails, both
objects are deleted; if the second image fails its read-back, the first is deleted.

Tested against a fake bucket that records every write and delete:

| Scenario | Objects written | Deleted | Left behind |
|---|---|---|---|
| Record insert fails after both images stored (the `23502` shape) | 2 | 2 | **0** |
| Factory image fails its read-back checksum | 2 | 2 | **0** |
| Success | 2 | 0 | 2 (correct) |

The `23502` case now returns a clean `502` explaining that nothing was stored, instead of a
raw PostgREST rejection.

## 4. Existing data is preserved

A database built from the **previous** schema and seeded with a published release, an
account and a profile was migrated with the fixed script:

- release `0.9.0` — same version, channel, status and SHA-256 afterwards
- account — same email, same password hash **byte for byte**, same `pbkdf2-legacy` algorithm
- profiles/passwords unchanged; the new columns are filled with their defaults
  (`storage_backend=supabase`, `artifact_kind=app`, `ota_eligible=true`), never with guesses
- a release stored with an empty model list is repaired **only** when a sibling artifact of
  the same version names the boards; a release with no such information is left untouched
- re-running the script is a no-op: 0 errors, all rows preserved

## 5. Sign-in is not broken by the RLS work

This is the check that matters most for "RLS enabled but the site still works":

- `service_role` (the backend) can read **every one of the 49 tables** — verified per table
  with `has_table_privilege`.
- `anon` and `authenticated` cannot read any backend-only table: `app_users`,
  `app_sessions`, `app_recovery_codes`, `app_login_attempts`, `app_auth_config`,
  `app_security_events`, `mqtt_credentials_metadata`, `platform_admins`, and the rest.
- `app_users` has RLS enabled **and** no policy **and** no grant — deny-all to PostgREST,
  which is the correct posture for a password table.
- The integration harness now connects as `service_role` rather than a superuser, so a
  missing grant fails locally instead of only in production. Removing the grants makes the
  harness fail with exit code 1.

RLS was never disabled, no `NOT NULL` was dropped, no service-role key is exposed, and
signature verification was not weakened.

---

## Verified locally

PostgreSQL 17, the real `supabase/schema.sql`, the real API code, direct SQL inserts and
REST-equivalent calls.

- fresh schema: 3 consecutive applies, 0 errors, 49 tables, 49/49 RLS (`ON_ERROR_STOP=1`)
- `42P01` reproduced **only** by referencing the dropped table; 0 occurrences in the fix
- integration harness: **87 passed / 0 failed**; with a real signed release ZIP,
  **91 passed / 0 failed**
- the real ZIP (built by `scripts/firmware/hc_package.mjs` from actual ESP32-S3 images,
  app 1 155 984 B + merged USB 1 221 520 B, Ed25519-signed) passes every server check,
  is offered to a customer at flash offset `0x10000`, and streams back byte for byte
- upload row vs. live table: required columns all present
- partial failures: 0 orphaned objects in both failure paths
- `tsc` clean for `apps/api`, `apps/web`, `packages/core`; `vite build` succeeds
- the two new regression checks fail loudly when either bug is reintroduced (mutation-tested)

## Still needs a real Supabase + Cloudflare deployment test

I could not and did not run these, and the results above must not be read as covering them:

1. **A real upload through the deployed Owner Console** into your live Supabase project —
   same code path, real PostgREST, real R2 binding.
2. **The R2 round trip against your actual private bucket**, including the dashboard-bound
   `FIRMWARE_BUCKET` and its permissions. Locally this is a fake bucket; the read-back
   verification is real, but the network and R2 credentials are not.
3. **Applying the schema in the Supabase SQL editor**, which runs it as one transaction
   under a different role than my local superuser.
4. **The browser installer** writing a ZIP to a physical ESP32-S3 over Web Serial.
5. **Existing production data.** The migration is proven on a seeded replica, not on your
   real rows. Take a Supabase backup before running the script (§ "To apply this").

## To apply this

1. Supabase → **SQL Editor** → **New query**. Open `supabase/schema.sql` on GitHub, click
   **Raw**, copy the whole file, paste, **Run** once. Safe to run again; it reports no errors.
2. Commit the changed source files so Cloudflare Pages redeploys — the uploader and the table
   must be the same version, or the mismatch returns.
3. Owner Console → **Firmware Management** → upload the release ZIP.
4. If a previously uploaded release still shows no controllers, re-upload its ZIP. Releases
   with a describable sibling artifact are repaired automatically by step 1.

## Files changed

- `supabase/schema.sql` — legacy-table guard, firmware column defaults/comments, trailing
  grants pass, `board_models` repair, PBKDF2 threshold aligned with the verifier
- `apps/api/src/firmware/releases.ts` — `completeReleaseRow`, `insertRelease` cleanup,
  `board_models` written into every row, published-release guard
- `apps/api/src/crypto.ts` — PBKDF2 verification ceiling matches the migration
- `DEPLOYMENT.md` — troubleshooting rows for both reported errors
