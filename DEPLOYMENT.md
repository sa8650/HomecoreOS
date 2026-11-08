# HomecoreOS — Deployment & Platform Configuration

This guide is for the **platform owner**. The goal is that no ordinary environment-variable spreadsheet is needed: add two native Cloudflare bindings and one bootstrap secret, redeploy, then finish everything else in the Owner Console.

---

## 1. Choose one database provider

| | Cloudflare D1 (recommended) | Supabase PostgreSQL |
|---|---|---|
| Detection | native `DB` binding present | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` bootstrap values |
| Migrations | automatic, idempotent, first request | apply `supabase/migrations/*.sql` once |
| Connection settings in Cloudflare | none | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Extra API tokens / URLs | **none** | no D1/R2 tokens; only the two Supabase bootstrap values |
| Auth | local HS256 JWT (PBKDF2 hashes) | Supabase GoTrue + JWT verification |
| Direct client DB access | none (Pages Functions only) | RLS-protected Realtime/direct access |

**Never configure both at once.** The runtime detects exactly one provider from the `DB` binding or the Supabase bootstrap values. Both providers use the same `DataClient` contract, the same 39 tables, the same seed (9 boards / 106 verified pins / 12 permissions) and the same feature behaviour.

---

## 2. The only manual Cloudflare steps (D1 path)

Cloudflare Dashboard → **Workers & Pages** → your **Pages project** → **Settings**:

1. **Bindings** → **Add** → **D1 database** → variable name `DB` → select your D1 database.
2. **Bindings** → **Add** → **R2 bucket** → variable name `FIRMWARE_BUCKET` → select your R2 bucket.
3. **Variables and Secrets** → **Add** → type `Encrypted secret` → name `SECRETS_KEY`, value = 64 hex characters (32 random bytes, e.g. `openssl rand -hex 32`).
4. **Save and redeploy.**

That is the entire server-side bootstrap. No R2 access keys, D1 API tokens, database URLs, service-role keys or `wrangler secret put` calls. Do **not** put `SECRETS_KEY` in GitHub, source, docs, `.env` files or the frontend bundle.

For the Supabase path instead: set `SECRETS_KEY`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` under Variables and Secrets, apply the SQL migrations once (section 5), and redeploy. `FIRMWARE_BUCKET` is still required.

---

## 3. First account and the setup wizard

On a fresh database, **the first signup becomes the platform owner** automatically — no SQL editing. Sign in, open **Owner Console → Initial Setup** (`/owner/setup`) and:

1. Choose the provider in the wizard (D1 or Supabase). This is a one-time decision.
2. Verify the six-item checklist: Database configured · R2 bucket connected · EMQX API connected · MQTT broker connected · Encryption initialized · Firmware storage ready.
3. Open **Platform Settings → Integrations & Secrets** (`/owner/settings/integrations`) and fill in the credentials you actually need.
4. Press **Test connection** for Supabase / EMQX. Status, last successful check, last error and hints are shown; results are stored in `platform_settings` (never plaintext values).
5. Press **Test R2 upload/download** to run a real put → get → delete round-trip against `FIRMWARE_BUCKET`.

The page clearly separates **Required configuration**, **Optional configuration**, **Cloudflare bindings** and **Encrypted integration secrets**. Customers never see these pages.

---

## 4. Integrations & Secrets

| Group | Fields | Where they live |
|---|---|---|
| Supabase | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` | URL + service-role key are bootstrap values; anon key and JWT secret are encrypted in `platform_secrets`. Hidden when D1 is selected. |
| EMQX | `EMQX_API_BASE`, `EMQX_APP_ID`, `EMQX_APP_SECRET`, `EMQX_BROKER_HOST`, `EMQX_TLS_PORT`, `EMQX_WSS_URL`, `MQTT_BRIDGE_USERNAME`, `MQTT_BRIDGE_PASSWORD` | encrypted in `platform_secrets` (AES-256-GCM with `SECRETS_KEY`) |
| Platform | `INGRESS_HMAC_SECRET`, `PUBLIC_API_BASE` | encrypted; optional (fall back to `SECRETS_KEY` / request origin) |
| Encryption | `SECRETS_KEY` | **bootstrap only** — Cloudflare Pages encrypted variable, never stored in the DB |

Rules:

- Add, update and rotate credentials from the Owner Console. Saved values are **never displayed again**: only configured status, `••••••••••••`, a SHA-256 fingerprint and the update time.
- Service-role keys, MQTT credentials and administrative API secrets never reach browsers, customers, frontend bundles, browser storage, GitHub, docs or logs.
- `SECRETS_KEY` cannot be written through the API. If it changes while encrypted rows exist, those rows become undecryptable and the console lists them as corrupt so they can be re-entered.
- Optional WSS/bridge fields are only needed for the advanced Durable Object ingress bridge; the normal HMAC webhook path needs only the EMQX API + broker host/TLS port.
- Do not request Supabase variables when D1 is selected, and vice versa.

### API endpoints (owner only)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/owner/setup` | provider, wizard, checklist, bindings, required/optional/encrypted groups, connections |
| GET | `/api/owner/integrations` | organized fields + connection statuses |
| PUT | `/api/owner/integrations` | add/update credentials (encrypted) |
| POST | `/api/owner/integrations/rotate/:key` | rotate one credential |
| DELETE | `/api/owner/integrations/:key` | remove one credential |
| POST | `/api/owner/integrations/test` | `{ "target": "supabase" \| "emqx" }` live server-side check |
| POST | `/api/owner/setup/test-bucket` | real R2 put/get/delete probe |
| POST | `/api/owner/setup/provider` | one-time provider selection |
| GET | `/api/owner/setup/backup` | portable backup + HMAC migration token |
| POST | `/api/owner/setup/switch` | guided provider migration |

---

## 5. Migrations

**Cloudflare D1** — no CLI step. `apps/api/src/db/d1-schema.ts` is generated from the Postgres migrations by `scripts/d1-schema.mjs` and contains `0001_schema.sql` + `0002_seed.sql`. `D1Adapter.migrate()` applies them once per database on the first request and records them in `_d1_migrations`. Re-running is a no-op. Regenerate after changing the Postgres schema:

```bash
node scripts/d1-schema.mjs
git add apps/api/src/db/d1-schema.ts
```

**Supabase PostgreSQL** — apply in order, once, from a maintenance step (not on every push):

```bash
supabase db push
# or: for f in supabase/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

The GitHub workflow deliberately does **not** auto-run Supabase migrations.

---

## 6. Backups and switching providers

Switching is **not** a settings toggle — it requires a real data migration:

1. On the current provider: **Initial Setup → Export backup**. Save the JSON privately; it contains platform data and encrypted secrets plus a server-signed `migration_token`.
2. Change the Cloudflare binding / bootstrap variables to the new provider, **Save and redeploy**.
3. On the new (empty) provider: **Initial Setup → Run provider migration**. Paste the exact backup, choose the target, type `MIGRATE`.
4. The server verifies the HMAC token with `SECRETS_KEY`, applies D1 migrations if needed, imports every application table, records `platform.database_provider` and writes an `audit_logs` entry.

Warnings returned by the migration note that Supabase Auth accounts live in GoTrue and must be exported/imported with the Supabase CLI if you switch to or from Supabase. Firmware binaries stay in R2 (the same `FIRMWARE_BUCKET` binding); keep the `firmware_releases` registry and SHA-256 digests with the database backup.

Also enable Supabase Point-in-Time Recovery (Supabase path) or Cloudflare D1 time-travel backups (D1 path) in the provider console.

---

## 7. GitHub + Cloudflare Pages deployment

`.github/workflows/deploy.yml`:

- install → `npm run typecheck` → `npm test` → `npm run build`
- verify `board-catalog.json`, `0008_board_catalog.sql` and `d1-schema.ts` are in sync
- `npx wrangler pages functions build` to prove the Functions bundle compiles
- `wrangler pages deploy apps/web/dist --project-name=homecoreos`

`wrangler pages deploy` uploads both the static build and the root `functions/` directory. Root `wrangler.toml` contains only `name`, `pages_build_output_dir` and `compatibility_date`; bindings and secrets are configured in the Cloudflare dashboard. `apps/web/public/_routes.json` restricts Functions to `/api/*` and `/internal/*`.

Secrets needed by the workflow: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. No Supabase access token, no R2 keys, no D1 tokens.

```bash
# production build, locally
npm ci
npm run typecheck
npm test
npm run build
npx wrangler pages functions build --outdir /tmp/homecoreos-pages-worker
```

### Independent database verification

```bash
npm run dev && npm test               # Postgres/PGlite configuration
DB_DRIVER=d1 npm run dev && npm test  # Cloudflare D1 emulator configuration
```

`tests/d1.test.mjs` always runs the D1 configuration in-process; `tests/api.test.mjs` follows whichever server is up. Both configurations must show 30/30 passing.

---

## 8. R2 firmware upload/download

`FIRMWARE_BUCKET` is used directly by `R2ObjectStore` through the native binding — no SigV4 REST credentials. Releases are created with a binary + SHA-256, listed, and deployed via OTA. `GET /api/firmware/download/:key` requires a valid short-lived HMAC signature, an unexpired URL and a **published** release with a matching `r2_key`; it returns `X-Checksum` and `Cache-Control: private, no-store`. Verify with **Test R2 upload/download** in Initial Setup and by publishing a release + starting an OTA in the customer console.

---

## 9. EMQX connection and device communication

Enter `EMQX_API_BASE` (ending in `/api/v5`), `EMQX_APP_ID`, `EMQX_APP_SECRET`, `EMQX_BROKER_HOST` and `EMQX_TLS_PORT` in Integrations & Secrets, then press **Test connection**. Success calls `/clients?limit=1&page=1` and reports the live client count.

Post-deployment checks (see `docs/TESTING.md`):

1. `GET /api/health` → `200`.
2. Sign up two accounts; A cannot read B's rooms/boards.
3. Device Setup Wizard → generate a pairing token → claim a device (`npm run sim -- <token>` for the simulator, or real ESP32). Confirm unique MQTT credentials shown once.
4. Verify config sync `Synced`, board `online`, and telemetry rows after the device publishes.
5. Toggle a switch: `requested` → `confirmed` only after the device ack; `device_commands.status = acknowledged`.
6. Create two devices on GPIO 5 → the second is rejected; delete the first → GPIO 5 free again.
7. Publish a firmware release and start an OTA; verify SHA-256 and rollback reporting.

Device ingress is the HMAC-signed `/internal/mqtt/event` endpoint (EMQX rule/webhook or the local broker). The optional standalone Worker + `MqttIngressDO` provides a long-lived WSS bridge; it is not required for normal operation. See `docs/EMQX.md` for the exact API paths and ACL rules.

---

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| `503 Platform setup required` | Add the `DB` binding (or Supabase bootstrap vars), `FIRMWARE_BUCKET` and `SECRETS_KEY`; redeploy |
| `SECRETS_KEY is missing or invalid` | Must be exactly 64 hex chars, stored as an encrypted Pages variable |
| `No database configured` | Bindings are case-sensitive: `DB`, `FIRMWARE_BUCKET` |
| Owner routes `403` | First signup becomes owner; ensure you are using that account, or insert a `platform_admins` row |
| EMQX Test connection fails | AppID/AppSecret, `/api/v5` suffix, deployment firewall, built-in-DB authenticator enabled |
| Supabase Test connection fails | Bootstrap URL / service-role key, migrations applied |
| Firmware storage not ready | `FIRMWARE_BUCKET` binding missing or the R2 round-trip probe failed |
| Encrypted secrets corrupt | `SECRETS_KEY` was rotated; re-enter the listed credentials in Integrations & Secrets |
| Provider change rejected | Export a backup, change bindings, redeploy, then run the guided migration — not `/setup/provider` |
| Device connects but no telemetry | HMAC webhook signer, topic tenant/device match, broker ACL, `INGRESS_HMAC_SECRET` |
| Command stays `published` | Device subscribed to `command`, not expired, ack published on `state` |
| Pages `/api` 404 | `_routes.json` missing from `apps/web/dist`, or `functions/` was not uploaded by Wrangler |

---

## 11. Credential rotation

| Credential | Procedure |
|---|---|
| EMQX AppID/AppSecret | Integrations & Secrets → Rotate → Test connection → delete the old EMQX application |
| Supabase anon / JWT secret | Integrations & Secrets → Rotate → Test connection |
| Supabase bootstrap URL / service-role key | Cloudflare Pages → Variables and Secrets → update → redeploy (these cannot be changed from the console because the DB connection itself depends on them) |
| `INGRESS_HMAC_SECRET` | Integrations & Secrets → Rotate; update any external webhook signer simultaneously. Invalidates pending signed firmware URLs |
| `SECRETS_KEY` | Do **not** rotate while encrypted rows exist. Export a backup, rotate in Cloudflare, redeploy, then re-enter every credential so it is sealed with the new key |
| Single device credential | Customer console → Controllers → Rotate credentials; update firmware/NVS |

All owner actions are recorded in `audit_logs`.
