# Firmware upload: missing `flash_offset`

```
ERROR 23502: null value in column "flash_offset" of relation "firmware_releases"
             violates not-null constraint
POST /rest/v1/firmware_releases → 400 Bad Request
```

**Cause:** the uploader sent `flash_offset: null` for every **application** image, in both
upload paths. The column was nullable, so nothing objected until it became `NOT NULL`.

---

## The exact column and why it was null

`firmware_releases.flash_offset` is the flash address the browser installer writes the bytes
at. Two places wrote the row, and **both** hardcoded `null` for an app image:

| File | Before | After |
|---|---|---|
| `apps/api/src/firmware/releases.ts` (package upload, app row) | `flash_offset: null` | `flashOffsetFor('app')` → `65536` |
| `apps/api/src/firmware/releases.ts` (single-image upload) | `input.artifactKind === 'factory' ? 0 : null` | `flashOffsetFor(input.artifactKind)` |
| `apps/api/src/app.ts` (route → `UploadInput`) | `artifactKind === 'factory' ? 0 : null` | `FACTORY_FLASH_OFFSET` / `APP_FLASH_OFFSET` |

`UploadInput.flashOffset` was declared but **never read** by `createRelease`, so the route's
value was discarded as well. Only the factory row was ever written with a real number — which
is why a factory-only upload appeared to work and the app row failed.

Two things hid it:

1. **The column was nullable.** My previous schema added `flash_offset bigint` with no
   `NOT NULL`, so a null was stored silently instead of failing. When the constraint was
   added later, the latent bug surfaced as your `23502`.
2. **`installPackage` guessed the offset** with `release.artifact_kind === 'factory' ? 0 : 0x10000`
   instead of reading the stored value. So every consumer saw a correct-looking offset while
   the database held `null`. It now reads the record — that is what makes a bad row visible.

## The fix, layer by layer

**1. One source of truth** — `apps/api/src/firmware/releases.ts`

```ts
export const APP_FLASH_OFFSET = 0x10000;     // 65536
export const FACTORY_FLASH_OFFSET = 0x0;     // 0
export function flashOffsetFor(artifactKind: unknown): number {
  return String(artifactKind) === 'factory' ? FACTORY_FLASH_OFFSET : APP_FLASH_OFFSET;
}
```

The offset is derived from the artifact kind, so it can never be one value for both. This is
**not** a blanket default — the two kinds get different values by construction.

**2. Both write paths** now call `flashOffsetFor(...)` instead of passing `null`.

**3. `completeReleaseRow`** — the single place the row is assembled — fills `flash_offset`
from the artifact kind if a caller omits it, and rejects the row **before anything is
written** if the value is not an integer or does not match the kind.

**4. The database** now enforces it (`supabase/schema.sql`):

```sql
-- repair existing rows first
update public.firmware_releases
   set flash_offset = case when artifact_kind = 'factory' then 0 else 65536 end
 where flash_offset is null
    or flash_offset <> (case when artifact_kind = 'factory' then 0 else 65536 end);
alter table public.firmware_releases alter column flash_offset set not null;
alter table public.firmware_releases
  add constraint firmware_releases_flash_offset_check
  check (flash_offset = case when artifact_kind = 'factory' then 0 else 65536 end);
```

`NOT NULL` is **added**, not weakened. The `CHECK` goes further: it rejects an app image at
`0x0` (which would overwrite the bootloader) and a factory image at `0x10000` (which would be
corrupt).

**5. Manifest validation** (`apps/api/src/artifacts/package.ts`) — the build must now *state*
both offsets and the API enforces them. A package that omits an offset, or puts the app image
at `0x0`, is stored as a draft with the reason shown. It is reported, not silently corrected.

**6. Owner Console** — `rpc_firmware_overview` now returns `artifact_kind`, `flash_offset`,
`ota_eligible` and the signature fields, and the release dialog shows **Written at**
(`0x10000` / `0x0`, or "not recorded" in red). Previously the console could not display the
field at all.

**7. The GitHub build** (`scripts/firmware/hc_package.mjs`) already emitted integers
(`65536` / `0`); it now documents that contract in the code and derives both from the shared
`FLASH` map (`FLASH.app`, `FLASH.bootloader`) rather than one literal.

## A second defect fixed along the way

`rpc_firmware_overview` was defined at line 2867, *before* `artifact_kind` (3032) and
`flash_offset` (3027) were added. A SQL function body is validated when it is created, so
SELECTing those columns there failed the whole schema apply with
`column r.artifact_kind does not exist`, rolling back everything after it — the same class of
failure as the `42P01` you reported. The function is now defined after both columns exist, and
a test asserts that ordering.

Also: an `HttpError` with status 500 was replaced with the string `"Internal error"` by the
error handler, which is why a schema mismatch is opaque in production. An `HttpError` now
shows its own message; only a genuinely unexpected exception is described generically.

---

## Files changed

| File | Change |
|---|---|
| `apps/api/src/firmware/releases.ts` | `flashOffsetFor` + `APP/FACTORY_FLASH_OFFSET`; both write paths use it; `completeReleaseRow` fills and validates the offset; `installPackage` reads the stored value instead of guessing |
| `apps/api/src/app.ts` | route supplies the real offsets; `HttpError` messages preserved on 500 |
| `apps/api/src/artifacts/package.ts` | manifest must declare both offsets; wrong or missing offset is a reported problem |
| `supabase/schema.sql` | repairs existing rows → `NOT NULL` → `CHECK` tied to `artifact_kind`; column comment; `rpc_firmware_overview` moved after the columns it selects and extended with `artifact_kind`/`flash_offset`/`ota_eligible`/signature |
| `apps/web/src/pages/firmware.tsx` | release dialog shows **Written at** |
| `apps/web/src/firmware.ts` | `flash_offset` added to the release type |
| `scripts/firmware/hc_package.mjs` | offset contract documented; both values from the shared `FLASH` map |
| `DEPLOYMENT.md`, `FIRMWARE_GUIDE.md` | troubleshooting row and the offset contract for both images |

## Tests performed

All run locally against PostgreSQL 17 with the real `schema.sql` and the real API code.

**Schema**
- fresh database: 3 consecutive applies with `ON_ERROR_STOP=1` → **0 errors** each time,
  49 tables, **49/49 RLS enabled**, `app_user_credentials` absent, **0** occurrences of `42P01`
- `flash_offset` is `bigint NOT NULL=NO`, and `firmware_releases_flash_offset_check` exists
- direct SQL: app + `NULL` → **reproduces your exact `23502`**; app + `65536` and factory + `0`
  → accepted; app + `0` and factory + `65536` → **rejected by the CHECK**
- ordering audit: column → `NOT NULL` → `CHECK` → `rpc_firmware_overview`, with **0**
  references to `flash_offset` before the column is created
- legacy migration: a database with `app=NULL`, `factory=NULL` and a mis-paired `app=0` →
  after the fix all three correct, **0 nulls**, 3/3 rows preserved, re-apply 0 errors
- `service_role` can read all 49 tables; `anon` cannot read `app_users`

**Upload paths**
- **100 passed / 0 failed** (96 baseline + 4 real-package) with a **real GitHub-built signed
  ZIP** (`scripts/firmware/hc_package.mjs`, app 1 155 984 B + merged USB 1 221 520 B,
  Ed25519-signed, verified)
- the stored rows for that upload: `app → flash_offset=65536`, `factory → flash_offset=0`,
  0 null offsets, 0 wrong-for-kind offsets
- the generated `manifest.json` carries `flash_offset=65536 (int)` and `0 (int)`
- both artifact types upload and register: package upload and the separate single-image
  upload (`flash_offset` 65536) are each asserted
- a package putting the app image at `0x0` is refused with the reason; a package declaring no
  offset is refused rather than guessed
- the Owner Console overview reports both offsets per artifact
- **mutation test:** reintroducing `flash_offset: null` on the app row fails **18** assertions,
  including all four offset checks — the tests catch the original bug

**Preserved behaviour**
- Ed25519: signed package verifies; forged signature caught and stays a draft; unknown-key
  package reported invalid; unsigned reports "signing key not configured" — all pass
- SHA-256: manifest checksum mismatch, tampered image and trailing-hash mismatch all still
  refused; the stored OTA image streams back byte for byte
- RLS unchanged: 49/49 enabled, backend access intact, customer isolation intact
- `app_user_credentials` still absent, `42P01` not reintroduced
- orphan cleanup: insert failure after both images stored → **0 objects left**; factory
  read-back failure → **0 objects left**
- written row vs live table: required columns all present, no unknown column names
- `tsc` clean for `apps/api`, `apps/web`, `packages/core`; `vite build` succeeds

## What still needs a real deployment

I have **not** run a production upload, and these results are local only:

1. Uploading your `1.1.0` / `dev` ZIP through the live Owner Console into real Supabase.
2. The R2 round trip against your actual private bucket (locally a fake bucket; the read-back
   hash check is real, the network and credentials are not).
3. Applying `schema.sql` in the Supabase SQL editor, which runs as one transaction under a
   different role than my local superuser, against your **real** rows.
4. Flashing a board from the browser installer to confirm the bytes land at `0x10000`.

## To apply

1. Commit the changed files so Cloudflare Pages redeploys.
2. Supabase → **SQL Editor** → paste all of `supabase/schema.sql` → **Run** once. It repairs
   the existing `flash_offset` values, then applies `NOT NULL` and the `CHECK`. Safe to re-run.
   Take a backup first — the repair rewrites offsets on existing rows.
3. Re-upload the `1.1.0` release ZIP. If a failed attempt already created a draft row, that
   version may now conflict: remove the draft in the Owner Console first, or bump the version.
