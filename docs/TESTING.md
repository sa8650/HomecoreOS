# Testing & acceptance

HomecoreOS is tested against **real Postgres** (`@electric-sql/pglite`, WASM PostgreSQL) with the exact production migrations, and against an independent **Cloudflare D1** configuration using a faithful D1 binding emulator (`sql.js`) with the generated D1 schema and seed. There are no mocked dashboards or fixture devices. Both database configurations must be verified separately.

## Run

```bash
npm ci
npm run typecheck       # all workspaces
npm test                # 30 tests (18 Postgres/API/ingress + 8 independent D1 + 4 Pages Functions)
npm run build           # core + web + api production builds
node scripts/d1-schema.mjs   # verify D1 schema/seed regenerates from Postgres migrations
```

For the full live HTTP suite, run the stack in another terminal first:

```bash
npm run dev             # PGlite + Aedes broker :1883/:1885 + API :8787 + Vite :5173
# or, independently:
DB_DRIVER=d1 npm run dev  # D1 emulator + the same broker/API/web
```

`tests/api.test.mjs` detects `/api/health`; if the API is not running it skips, so CI does not need a broker. The schema suite and `tests/d1.test.mjs` always run. **Validate both configurations independently** (`npm run dev && npm test` and `DB_DRIVER=d1 npm run dev && npm test`); a passing Postgres run does not prove the D1 path.

## Automated coverage

| # | Suite | Scenario | Result |
|---|---|---|---|
| 1 | schema | Migrations apply; all customer tables have RLS; 106 verified pin rows seeded | pass |
| 2 | schema | Account A cannot read Account B rooms/boards; credential table revoked from customer JWTs | pass |
| 3 | ingress | `0015` resolves tenant/device without an MQTT client id; wrong tenant returns null | pass |
| 4 | ingress | Bridge path (no client id): forged JSON `tenant_id` stripped; rows stay in the real tenant | pass |
| 5 | ingress | Authenticated client-id path: forged JSON `tenant_id` also stripped | pass |
| 6 | ingress | Mismatched topic, device id, publish kind and invalid schema messages rejected | pass |
| 7 | schema | A cannot publish commands to B devices; malicious `tenant_id` in telemetry ignored | pass |
| 8 | schema | Per-device ACL: publish state/telemetry/availability only, subscribe command/config only | pass |
| 9 | schema | Viewer cannot control or modify GPIO; operator cannot change settings; self-escalation blocked; revocation immediate | pass |
| 10 | schema | Board-specific pin map; duplicate exclusive GPIO rejected; same GPIO on two boards allowed; release on delete; restore revalidation | pass |
| 11 | schema | Shared I2C bus: two sensors share it; bus controller pins allocated once; bus with sensors cannot be deleted | pass |
| 12 | schema | Pairing token single-use, expiring, hashed; device id cannot be re-claimed by another tenant | pass |
| 13 | schema | Telemetry validation, command idempotency, ack → confirmed state, expiry ledger | pass |
| 14 | schema | Versioned config, checksum, config ack, sync status | pass |
| 15 | schema | Owner-only operations audited; usage snapshot sources validated; secrets not exposed via RLS | pass |
| 16 | schema | Room deletion requires explicit device strategy; devices kept on `unassign` | pass |
| 17 | api | Full HTTP path: signup → catalog → pairing → claim → room → device → GPIO conflict → sensor → command → cross-tenant denial → owner console | pass |
| 18 | api | A brand-new account has zero rooms/boards/devices/sensors/automations (no hardcoded demo data) | pass |

### Independent D1 suite (`tests/d1.test.mjs`, 8 tests)

| # | Scenario | Result |
|---|---|---|
| 1 | D1 schema generated from the same Postgres migrations; 39 tables, 106 pins, 9 boards, 12 permissions; D1 health | pass |
| 2 | First D1 signup becomes owner; setup wizard reports provider, bindings, checklist, wizard and selection | pass |
| 3 | Owner secrets are AES-256-GCM encrypted at rest, never returned plaintext, masked, rotatable and removable; bootstrap-only values are not written to the DB | pass |
| 4 | Supabase and EMQX Test Connection report honest status/endpoint/hint without exposing credentials | pass |
| 5 | Native R2 binding: firmware upload → SHA-256 → signed URL → byte-for-byte download → tampered/expired URLs rejected | pass |
| 6 | MQTT device communication: tenant isolation, forged `tenant_id` ignored, command ledger, GPIO conflict, telemetry | pass |
| 7 | Backup export + HMAC migration token; provider switch requires an exact backup and `MIGRATE`; restore succeeds | pass |
| 8 | Config detects exactly one provider from the `DB` binding or Supabase bootstrap values; both together is rejected | pass |

### Cloudflare Pages Functions (`tests/pages.test.mjs`, 4 tests)

| # | Scenario | Result |
|---|---|---|
| 1 | Real `onRequest` with native `DB` + `FIRMWARE_BUCKET` bindings: health, D1 migrations, first-owner signup, setup checklist, R2 probe, encrypted credential write with no plaintext in DB or response | pass |
| 2 | Static asset paths are passed through to the Pages asset server (`ctx.next()`) | pass |
| 3 | Missing bindings return 503 with Cloudflare binding instructions and no secret leakage | pass |
| 4 | `_routes.json` limits Functions to `/api/*` and `/internal/*` in source and built artifact | pass |

## Cloudflare Pages Functions bundle

```bash
npx wrangler pages functions build --outdir /tmp/homecoreos-pages-worker
grep -r "node:" /tmp/homecoreos-pages-worker   # must be empty: Web APIs only
```

The bundle must contain no `node:*` imports and no `compatibility_flags = ["nodejs_compat"]` in root `wrangler.toml`. Hosted deployment (`wrangler pages deploy`) with real native `DB` / `FIRMWARE_BUCKET` bindings is a manual operator step; local compilation does not prove hosted integrations.

## Live device verification (real MQTT)

```bash
# 1. Generate a one-time pairing token in Device Setup Wizard (or /api/pairing-tokens)
# 2. Start a virtual ESP32 that uses the REAL claim + MQTT flow
npm run sim -- <pairing-token>
```

Verified in the development stack:

- Per-device username/password/client id authenticates; wrong credentials refused.
- Device subscribes only to its `command` + `config` topics; other topics denied by ACL.
- Versioned config delivered on `config`, acknowledged on `state`; `config_sync_status` becomes `synced`.
- ON/OFF command (`retain:false`) → ack → `device_commands.status = acknowledged`, `devices.reported_state = on`, `requested_state` cleared.
- Sensor telemetry validated and stored in `sensor_readings` with the correct `tenant_id`.
- LWT/availability flips the board offline; reconnect restores online.
- Mismatched topic tenant/device or forged payload `tenant_id` ignored by ingress.

## Manual acceptance checklist (production)

Deploy per `DEPLOYMENT.md`, then verify:

- [ ] `npm run typecheck`, `npm test` (30/30), `npm run build`, Pages Functions bundle build all pass.
- [ ] D1 migrations apply automatically on a fresh database; Supabase migrations replay on a clean project.
- [ ] Owner setup wizard: correct provider detected; exactly one provider; checklist reflects real binding/connection status.
- [ ] `SECRETS_KEY` is only in Cloudflare encrypted variables; no credential appears in GitHub, frontend bundle, browser storage or network responses.
- [ ] Integrations & Secrets: save → masked + fingerprint, rotate, remove; GET returns no plaintext; corrupt secrets reported after key rotation.
- [ ] Test Connection for EMQX (and Supabase when selected), Test R2 upload/download.
- [ ] All customer and owner routes load; no broken CSS, no 404s, no console errors, no fake/demo data, no dead buttons.
- [ ] Two accounts isolated; a customer gets 403 on `/api/owner/*`; owner actions appear in Audit Logs.
- [ ] Pairing with real hardware: single-use token, unique credentials, config download.
- [ ] ACL: a device credential cannot subscribe to another tenant's topic or publish to `command`.
- [ ] Switch shows requested → confirmed only after ack; expired commands do not linger.
- [ ] Firmware OTA in R2: signed URL serves only published releases; tampered/expired URLs 403; hash mismatch preserves last-known-good and reports rollback.
- [ ] Backup export → binding change → redeploy → guided provider migration with the exact token restores the same data.
- [ ] Credential rotation invalidates the old password immediately.

## Not verified by automated tests

Real hosted Cloudflare D1/R2 bindings and Pages deployment, real EMQX Cloud Deployment API, real ESP32 TLS/WSS hardware, browser DOM/console/CSS visual rendering, GitHub Actions on a live Cloudflare account. These require owner credentials/hardware and are listed as explicit operator checks in `DEPLOYMENT.md`.
