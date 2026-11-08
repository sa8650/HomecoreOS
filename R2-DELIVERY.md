# HomecoreOS R2 — firmware system, UI and docs

Delivery summary. Everything below was run in this environment; the "not verified" list at the end is what cannot be run without a physical board, a browser with Web Serial, or your signing key.

---

## 1. Bugs found and fixed (not just added features)

These were real defects in the existing code that the new pipeline exposed:

| Bug | Effect | Fix |
| --- | --- | --- |
| ESP image checksum was read from byte 23 | **Every real Arduino build was rejected as corrupt.** Byte 23 is the "hash appended" flag, not the checksum | `artifacts/image.ts` now walks the segment headers, XORs the segment data from the `0xEF` seed, and reads the checksum byte from its true position (last byte before the appended SHA-256) |
| Release version taken from the ESP-IDF descriptor | The Arduino core fills that field with its **own build hash** (`6671d0b`), so version validation could never pass and `runningVersion()` reported a foreign value | The firmware now prints `hcver:<version>` at boot; the build script, the API and `OtaEngine::runningVersion()` all use that marker |
| `writeFlash({...})` + `after('hard_reset')` in `installer.ts` | Wrong esptool-js call shape for 0.7.1, and a hand-rolled "MD5" that could only ever fail the loader's own comparison | Real API: `writeFlash(FlashOptions)`, `flashAfter('hard_reset')`, `flashFreq: '80m'`; no fabricated hash; the flash is **read back and compared with the published SHA-256** instead |
| One row per `(channel, version)` | A release package holds two artifacts (OTA + USB), so storing both was impossible | Unique index is now `(tenant, channel, version, chip_family, artifact_kind)`; duplicate checks are per artifact kind |
| Board cards showed `GPIO available: 0` for unverified boards | A zero is a claim in the other direction | Verified maps only; unverified cards say *pin map not verified* and show **no numbers at all** |
| `DESIGN_AUDIT.md` committed | Build-artifact document inside the repo | Deleted |

---

## 2. Firmware build and release

**`scripts/firmware/hc_build.mjs`** (rewritten) — validates and stamps the version, the API origin and both TLS anchors; refuses a bad `HC_FW_PUBKEY` (must be base64 of the raw 32-byte Ed25519 key) or `alg`/key combinations that disagree.

**`scripts/firmware/hc_package.mjs`** (new, the whole packaging step in one file):

1. finds the application image, bootloader, partition table and OTA data page in the arduino-cli build directory;
2. checks ESP magic, chip id 9 (ESP32-S3), application descriptor and the `hcver:` version marker;
3. writes the merged **USB factory image** — bootloader `0x0`, partitions `0x8000`, OTA data `0xE000`, app `0x10000` (0xFF-filled gaps, no 16 MB padding);
4. writes `manifest.json` **from the bytes on disk**, `SHA256SUMS.txt`, and an Ed25519 signature over the **lowercase hex SHA-256 string** (exactly what the controller has after streaming) — only when `--sign-key` is given, and the signature is verified against its own public key before it is written;
5. writes one ZIP (stored entries, real CRC32) ready for the console.

**`.github/workflows/firmware.yml`** (rewritten, still the only workflow) — `workflow_dispatch` + `fw-v*` tags, compile with the CI FQBN, run the packaging script, then re-verify the ZIP with the same rules the server uses (magic bytes, chip id, descriptor, partition table at `0x8000`, identical application inside both images, `hcver:` marker) before uploading the artifact and the GitHub Release. No R2 upload, no Pages deploy, no new required secrets.

Measured: **1,155,779 B of 3,145,728 (36%)**, globals 62,940 B (19%). Release ZIP **2,379,877 B** with app 1,155,920 B and USB image 1,221,456 B.

---

## 3. Ed25519 in the firmware (new, verified)

`firmware/homecoreos_esp32/hc_ed25519.h` — TweetNaCl port (public domain), verification only, using the device's own `mbedtls_sha512`. Needed because arduino-esp32 3.3.12 ships mbedtls **without** Ed25519.

Verified against **RFC 8032 §7.1 vectors** compiled natively:

```
rfc8032 #1 empty         PASS      corrupted signature      PASS (rejected)
rfc8032 #2 one byte      PASS      different message        PASS (rejected)
rfc8032 #3 two bytes     PASS      non-canonical S          PASS (rejected)
                                   invalid public key       PASS (rejected)
```

`hc_signature.h` now dispatches on `HOMECOREOS_FW_SIGNING_ALG`: `ed25519` → the port, `ecdsa-p256-sha256` → mbedtls (unchanged for older releases), anything else → `false`. Keyless builds compile and report `signing key not configured`.

**Proven chain:** package signed with an Ed25519 key → `openssl pkeyutl -verify` OK → **the firmware's own verifier** returns VALID → the Pages API (WebCrypto) returns `verified: true` for the same digest. A flipped signature byte is rejected by all three.

---

## 4. Owner Console — "Upload release package"

**`apps/api/src/artifacts/package.ts`** (new) — the untrusted-input boundary:

- reads the **central directory**, not the local headers;
- refuses: absolute paths, `..`, backslashes, control characters, folders, duplicate names, symlinks, encrypted entries, unsupported compression;
- caps: archive 12 MB, 24 entries, 16 MB unpacked (checked from declared sizes *and* produced bytes), 8 MB per firmware file, 1 MB per non-image file;
- implements **inflate** itself (`node:zlib` does not exist in the Pages runtime) — validated byte-for-byte against zlib on 1 MB of random data, repetitive data and text;
- verifies the **CRC of every entry**.

**`createPackageRelease()`** then never trusts the manifest: both images are re-inspected from their bytes, every declared checksum and size is recomputed, the `hcver:` marker must match the manifest version, the USB image must embed the same application as the OTA file, board models must exist in the catalog, flash must be 16 MB, and the Ed25519 signature is verified with `FW_SIGNING_PUBKEY`. Failures store a **draft** with every reason listed; they can never publish.

New route `POST /api/owner/firmware/upload-package` (Platform Owner only). Both artifacts are stored under `firmware/<version>/…` and proved by read-back. The single `.bin` upload stays for advanced use, with the same structural checks.

UI: **Upload release package** button → file picker (`.zip`, size checked, SHA-256 computed in the browser) → real two-stage progress bar → per-check report → publish/draft, with *"Unsigned · signing key not configured"* when that is the truth. **Upload single image** is the previous dialog, unchanged in behaviour.

Verified refusals (each with its own message): path traversal, absolute path, folder inside the ZIP, symlink, renamed `.bin`, missing `manifest.json`, missing USB image, unknown board model, tampered app bytes, checksum edit, USB/OTA application mismatch, factory image declared at a non-zero offset, duplicate version, customer (403), forged signature, signature from an unknown key.

---

## 5. Customer install

**Option A — Web Serial (Chrome/Edge desktop):** download → verify SHA-256 in the browser → chip id compared with the release → `writeFlash` at the release's own offset (`0x0` factory, `0x10000` app) → **read the flash back and compare with the published SHA-256** → hard reset. Failure at any step reports the real reason and never says "installed". A chip mismatch aborts **before** anything is erased.

**Option B — download:** version, compatible models, size, checksum, signature status and instructions, plus a save-file link.

**Wireless OTA:** the controller verifies the digest (and the signature when a key is compiled in), writes to the inactive slot and reboots; the API only writes `success` and the installed version after the device reconnects and reports. Rollback to an earlier signed build stays server-enforced. A factory image is refused for OTA at the queue step.

---

## 6. Board Library UI

Rebuilt against your screenshot: fixed 104 px illustration window with a contained SVG (76 px), title and badge on one row with the badge pinned right, description clamped to three lines, facts row separated by a rule, actions pushed to the bottom so cards are equal height, hatched art and *"Pin map not verified"* for unverified boards, `Pinout` disabled without pins, `Add board` disabled unless verified, grid 3 → 2 → 1 columns at 1100 px and 700 px.

Preview: `/home/user/preview/board-card.html` (self-contained, styles copied verbatim from `styles.css`).

---

## 7. Docs

| File | State |
| --- | --- |
| `README.md` | Firmware section rewritten around packages, validation and honest limits |
| `DEPLOYMENT.md` | New four-step firmware procedure (build in Actions → upload package → assign → manage), signing table, corrected "no workflows" claim, new troubleshooting rows |
| `FIRMWARE_GUIDE.md` | **New** — build, ZIP contents, every check explained, install, OTA, signing, flash layout, failure table |
| `OWNER_GUIDE.md` | **New** — owner console walkthrough, setup checks, broker self-check, board library, security |
| `USER_GUIDE.md` | **New** — customer walkthrough from USB install to Wi-Fi, pairing, updates, troubleshooting |

Click-by-click, no terminal, no new testing/mock/placeholder files.

---

## 8. Validation (all run just now)

| Check | Result |
| --- | --- |
| `apps/api` `tsc --noEmit` | 0 errors |
| `apps/web` `tsc --noEmit` | 0 errors |
| `packages/core` build | 0 errors |
| `vite build` | OK, 384.74 kB app chunk / 100 kB gzip |
| `supabase/schema.sql` applied twice | 0 errors both times |
| Integration harness (real Hono app + real PostgreSQL + real R2-equivalent store) | **89 passed, 0 failed** |
| …of which the **real compiled release ZIP** | accepted, both artifacts stored, offered to a customer at `0x10000`, streams back byte-identical |
| Real ZIP signed with a test key, harness configured with the matching public key | `verified: true`, published |
| Real ZIP signed with an unknown key | `verified: false`, stored as draft — **fail-closed** |
| Ed25519 RFC 8032 vectors (firmware header, native build) | 7/7 as expected |
| Firmware compile, keyless | 1,155,779 B (36%), RAM 62,940 B (19%) |
| Firmware compile **with** a real Ed25519 key | 1,160,251 B (36%) — Ed25519 path links and builds |
| Workflow's own package verification, reproduced locally | OK: 1.0.0, app 1,155,920 B, USB 1,221,456 B, identical application |
| Six-digit pairing, per-device MQTT credentials, tenant isolation, EMQX self-check, rollback rules | covered by the 89 assertions |

---

## 9. Secrets needed

| Where | Name | Kind | Required |
| --- | --- | --- | --- |
| Cloudflare Pages | `FW_SIGNING_PUBKEY` | plain variable, base64 of the raw 32-byte public key | optional — enables upload-time signature verification |
| GitHub → Actions → Secrets | `FW_SIGNING_KEY` | encrypted, Ed25519 PKCS#8 PEM | optional — enables signing in the workflow |
| GitHub → Actions → Variables | `HC_FW_PUBKEY` | plain, same base64 key | optional — compiles verification into the firmware |

Unchanged and still required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `EMQX_API_BASE`, `EMQX_APP_ID`, `EMQX_APP_SECRET`, `EMQX_BROKER_HOST`, plus the `FIRMWARE_BUCKET` R2 binding. No new Pages bindings, no D1, no Supabase Auth, no Cloudflare API deploy secret, no second workflow.

---

## 10. Still blocked on you

1. **The Ed25519 public key.** Give me the base64 of the raw 32-byte public key and I will set `FW_SIGNING_PUBKEY` / `HC_FW_PUBKEY` in the docs as a worked example and re-run the signed path against it. Until then every screen says *signing key not configured* — nothing pretends otherwise.
2. **A real board.** Nothing here was flashed to hardware, so I cannot claim the USB write, the boot, or the Wi-Fi/pairing cycle on a physical device.
3. **A GitHub Actions run.** The workflow's steps are reproduced locally, including its verification script, but it has not executed on GitHub's runners.

Also unverified in this environment: EMQX Cloud (no deployment available — the self-check reports the real step results, including failures), Cloudflare R2 through the live binding (exercised through an R2-compatible store), and Web Serial in a real browser (needs a desktop Chrome/Edge window with a device).
