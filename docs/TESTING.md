# Testing & acceptance

Helios is tested against **real Postgres** (`@electric-sql/pglite`, WASM PostgreSQL) with the exact production migrations, plus an end-to-end HTTP suite against the running local stack. There are no mocked dashboards or fixture devices.

## Run

```bash
npm install
npm test                 # 18 tests: schema/acceptance + ingress + live API (skips if API down)
npm run test:schema       # schema/acceptance only
npm run build             # production builds + typechecks
npm run typecheck         # all workspaces
```

For the full live suite, run the stack in another terminal first:

```bash
npm run dev              # Aedes broker :1883/:1885, API :8787, Vite :5173
```

`tests/api.test.mjs` detects `/api/health`; if the API is not running it skips, so CI does not need a broker. The schema suite always runs.

## Automated coverage

| # | Suite | Scenario | Result |
|---|---|---|---|
| 1 | schema | Migrations apply; all customer tables have RLS; 106 verified pin rows seeded | pass |
| 2 | schema | Account A cannot read Account B rooms/boards; credential table revoked from customer JWTs | pass |
| 3 | ingress | `0015` resolves tenant/device without an MQTT client id; wrong tenant returns null | pass |
| 4 | ingress | Bridge path (no client id): forged JSON `tenant_id` stripped; rows stay in the real tenant | pass |
| 5 | ingress | Authenticated client-id path: forged JSON `tenant_id` also stripped | pass |
| 6 | ingress | Mismatched topic, device id, publish kind and invalid schema messages are rejected and not stored | pass |
| 7 | schema | A cannot publish commands to B devices; malicious `tenant_id` in telemetry is ignored; tenant resolved from DB | pass |
| 8 | schema | Per-device ACL: publish state/telemetry/availability only, subscribe command/config only | pass |
| 9 | schema | Viewer cannot control or modify GPIO; operator cannot change settings; self-escalation blocked; revocation immediate | pass |
| 10 | schema | Multiple boards; board-specific pin map; duplicate exclusive GPIO rejected; same GPIO on two boards allowed; release on delete; restore revalidation; restricted/input-only/ADC rules | pass |
| 11 | schema | Shared I2C bus: two sensors share it, bus controller pins allocated once, exclusive conflict rejected, bus with sensors cannot be deleted | pass |
| 12 | schema | Pairing token single-use, expiring, hashed; device id cannot be re-claimed by another tenant | pass |
| 13 | schema | Telemetry validation (unit/range/unknown sensor), command idempotency, ack updates confirmed state, expiry ledger | pass |
| 14 | schema | Versioned config, checksum, config ack, sync status | pass |
| 15 | schema | Owner-only operations, audited; usage snapshot sources validated; secrets not exposed via RLS | pass |
| 16 | schema | Room deletion requires explicit device strategy; devices kept on `unassign` | pass |
| 17 | api | Full HTTP path: signup → catalog → pairing → claim → room → device → GPIO conflict → sensor → command → cross-tenant denial → owner console | pass |
| 18 | api | A brand-new account has zero rooms/boards/devices/sensors/automations (no hardcoded demo data) | pass |

## Live device verification (real MQTT)

```bash
# 1. Generate a one-time pairing token in Device Setup Wizard (or /api/pairing-tokens)
# 2. Start a virtual ESP32 that uses the REAL claim + MQTT flow
npm run sim -- <pairing-token>
# or click "Start local simulator (development)" in the Setup Wizard
```

Verified manually in the development stack:

- Per-device username/password/client id authenticates against the broker; wrong credentials are refused.
- Device can subscribe only to its `command` + `config` topics; other topics are denied by ACL.
- Device receives versioned config on `config`, acknowledges on `state`; `config_sync_status` becomes `synced`.
- ON/OFF command published with `retain:false` → ESP32 ack → `device_commands.status = acknowledged`, `devices.reported_state = on`, `requested_state` cleared.
- Sensor telemetry validated and stored in `sensor_readings` with the correct `tenant_id`.
- LWT/availability flips the board to `offline`; reconnect restores `online`.
- A message with a mismatched topic tenant/device or a forged payload `tenant_id` is ignored by ingress.

## Manual acceptance checklist (production)

Deploy per `DEPLOYMENT.md`, then verify:

- [ ] Production build succeeds; `npm test` passes; migrations replay on a clean Supabase project.
- [ ] All 12 customer routes and 8 owner routes load; no broken CSS, no 404s, no console errors.
- [ ] Two accounts are isolated (rooms, boards, devices, sensors, activity).
- [ ] EMQX Management → Test connection succeeds; App Secret is masked in the UI and absent from browser network responses.
- [ ] Usage & Monitoring shows "Unavailable" with reasons before any snapshot; owner manual entry renders charts only from real recorded values; estimates are clearly labelled.
- [ ] Platform owner actions appear in Audit Logs; a customer gets 403 on `/api/owner/*`.
- [ ] Pairing works with real hardware: single-use token, unique credentials, config download.
- [ ] ACL: with a device credential, subscribing to another tenant's topic is denied; publishing to a command topic is denied.
- [ ] Switch shows requested → confirmed only after ack; expired commands do not linger.
- [ ] Firmware OTA: signed URL serves only published releases; tampered/expired URLs are 403; hash mismatch preserves the last known good image and reports rollback.
- [ ] Credential rotation invalidates the old password immediately.
