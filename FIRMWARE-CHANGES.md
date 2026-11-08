# Firmware delivery — what changed

Everything below is in the working tree of the repository; nothing was committed
or pushed. Validation results are at the bottom.

## Owner Console — firmware management (`apps/web/src/pages/firmware.tsx`)

One release list with draft / published / archived views, channel filter and
search. Each release shows size, compatible models, artifact verification,
signature state, install counts and the exact stored SHA-256.

- **Upload** validates on the server before anything is stored: image magic, S3
  chip id, application descriptor, appended SHA-256, declared version, board
  model ids. A mapped image counts as a factory build and is checked for the
  bootloader at `0x0` and the partition table at `0x8000`.
- **Publish** is gated by a checklist (verified artifact, 64-hex checksum, at
  least one board model, fits the 3 MB slot, signature) instead of a bare button.
- **Deploy** lists real controllers from `/api/owner/firmware/:id/targets`,
  greys out incompatible ones with the reason, and queues per-board OTA
  commands; the response reports `queued` / `skipped` / per-board results.
- **Retire** archives a release, removes it from the latest-stable answer and
  reports which earlier stable build becomes the rollback target.
- **Signature** attaches a detached ECDSA P-256 / Ed25519 signature to the digest.
- Installed version per controller, "update available" markers, update history
  with progress and failure detail, storage round-trip test.

## Customer Console — install and update (`apps/web/src/pages/install.tsx`)

Two options, both fed by the same published release.

**A. Install over USB in the browser.** `apps/web/src/installer.ts` uses
`esptool-js@0.7.1` (lazy import) over Web Serial: download → verify SHA-256 →
compare the image chip id → write → hard reset. Progress is the transfer itself;
a mismatch on the detected chip aborts before anything is erased. The same modal
offers the file download and the official ESP Web Tools page.

**B. Wireless update from a controller.** Installed vs available version, notes,
size, checksum, signature state, live progress, last success, failure reason and
a rollback button that is only enabled when an earlier signed build actually ran
on that controller.

## Pairing (`apps/web/src/pages/setup-wizard.tsx`)

Replaced the old token/long-code flow with the six-digit contract:
`POST /api/pairing/code` → `{session_id, code, expires_at, seconds_left}`, polled
through `GET /api/pairing/progress?session=` with the server's own countdown,
attempt counter, regenerate and cancel. Nothing advances on a timer.

## Backend

- `apps/api/src/app.ts` — owner firmware routes (upload, signature, retire,
  targets, deploy, status, patch, delete, download), customer firmware routes
  (`catalog` now also returns install packages and rollback availability,
  `install-package`, signed `object/:key`, `download/:id`), and
  `POST /api/owner/emqx/device-auth-check`.
- `apps/api/src/firmware/releases.ts` — `installPackage`, `latestForBoard`,
  `customerDownload`, `serveSignedDownload`, `firmwareCheck`, merged-image
  validation.
- `apps/api/src/artifacts/image.ts` — `inspectMergedImage`.
- `apps/api/src/providers/emqx.ts` — `probeCredential` for the self-check.
- `packages/core/src/ports.ts` — optional `probeCredential` on the broker port.
- `supabase/schema.sql` — N16R8 catalog row + pin map (GPIO35–37 reserved for
  octal PSRAM), `version_lt`, `rpc_pairing_address_reset`, OTA-eligible rollback
  targets, `HC404` for cross-tenant pairing reads.

## Release process

- `scripts/firmware/hc_build.mjs` generates `hc_build.h` (version, API origin,
  both TLS anchors, signing public key — empty means "not configured").
- `.github/workflows/firmware.yml` builds once with arduino-cli, verifies the
  image header itself, writes `-app.bin`, a 4-segment `-usb.bin`
  (`0x0 / 0x8000 / 0xE000 / 0x10000`), `manifest.json` and `SHA256SUMS.txt`, then
  uploads artifacts and creates the GitHub Release. No deploy step: Cloudflare
  Pages keeps deploying through the existing GitHub integration.

## Validation run

| Check | Result |
| --- | --- |
| `tsc --noEmit -p apps/api/tsconfig.json` | 0 errors |
| `apps/web` `tsc --noEmit` | 0 errors |
| `apps/web` `vite build` | builds, esptool-js split into per-chip chunks |
| `supabase/schema.sql` re-applied twice on a live database | 0 errors, idempotent |
| Integration harness against real PostgreSQL (`/.harness/run.ts`) | 63 passed, 0 failed |
| arduino-cli compile, ESP32-S3 N16R8 | 1,155,843 B of 3,145,728 (36 %), RAM 19 % |
| Merge of USB image | bootloader `0x0`, partitions `0x8000`, ota data `0xE000`, app `0x10000`, 1,221,520 B |

The harness covers: owner-only access to every firmware route, upload rejection
(bad chip, corrupt body, version mismatch, missing partition table), the six-digit
code (format, five-minute expiry, no plaintext storage, single use, wrong-code
rejection, per-address rate limit and lockout, atomic redemption), per-device
MQTT credentials and tenant topics, device-authenticated OTA download and
progress, installed version only after success, rollback refusal without an
earlier build, retire behaviour, cross-tenant isolation on update / pairing /
install packages, and the broker self-check.

## Still open

- **Signing key not supplied.** `HC_FW_PUBKEY` / `HC_FW_SIGNING_ALG` are empty, so
  the firmware compiles keyless and reports "signing key not configured"; no
  signature is verified anywhere. Add the public key as a repository variable and
  re-run the workflow.
- **Production EMQX call not exercised.** The self-check route and UI are in
  place; only a real owner run against the deployment proves device
  authentication there.
- **Real hardware flash not exercised.** Web Serial needs Chrome/Edge on a
  desktop; the flash path is compiled and wired but has not been run against a
  physical board from this environment.
- **Firmware version string.** `package.json` still says `1.0.0`, so a local build
  reports `1.0.0`; pass `HC_FW_VERSION` (the workflow does this from the tag).
