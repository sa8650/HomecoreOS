# Helios — Multi-Tenant Smart Home Automation SaaS

Helios is a production-oriented, multi-tenant SaaS for controlling ESP32-based homes over the internet. Each customer account owns an isolated home workspace with multiple controllers, rooms, switches, sensors, staff, automation and firmware releases. A completely separate Platform Owner Console manages customers, EMQX integration, usage, the board catalog and audit logs.

**There is no demo dashboard.** Every form, control and table is backed by real Worker endpoints, real Postgres rows and real MQTT messages. Empty states describe the next real action; unavailable provider metrics say "Unavailable" with a reason.

---

## 1. Product overview

- Customer signup creates an independent tenant, owner membership and profile via a database trigger.
- A **Device Setup Wizard** pairs ESP32 boards with single-use, expiring, hashed tokens. Pairing returns unique per-device MQTT credentials (shown once) and the versioned device configuration.
- The **Board Library** holds verified, versioned Espressif dev-kit pin maps plus tenant custom boards. Chip families whose dev-board header map is not verified are registered with zero pins and a "pending verification" state — no pin map is invented.
- The **GPIO Pin Manager** shows available / assigned / system-reserved / restricted / incompatible pins and allocates exclusive GPIOs transactionally, scoped to the physical board instance. I2C/SPI/UART buses are explicit shared resources.
- Rooms organise devices independently of hardware allocation. Deleting a room requires an explicit decision about its devices.
- Switches distinguish **requested**, **confirmed**, **unknown**, **offline** and **failed** state. Commands have UUIDs, expiry, acknowledgement and idempotency and are never retained in MQTT.
- Sensors have versioned JSON telemetry, field mapping, unit/range validation and Postgres history.
- Config sync is versioned and acknowledged; the ESP32 keeps a last-known-good configuration and local safety interlocks continue offline.
- Automation supports WHEN / IF / THEN in cloud, local and hybrid modes.
- Firmware OTA uses an R2 binding, short-lived HMAC-signed download URLs, published-release checks, SHA-256 verification and ESP-IDF rollback. Website and config changes never require a firmware update.

## 2. Technology stack

| Component | Technology |
|---|---|
| Source | GitHub (monorepo, npm workspaces) |
| Frontend | React 18 + TypeScript + Vite (Cloudflare Pages) |
| Backend | Hono on Cloudflare Workers |
| Database | Supabase PostgreSQL + Supabase Realtime |
| Auth | Supabase Auth (GoTrue) / JWT verified in the Worker; local equivalent for development |
| MQTT | EMQX Cloud Serverless behind a swappable `MqttProvider` interface |
| Firmware storage | Cloudflare R2 binding |
| Firmware | ESP-IDF / Arduino-ESP32 with MQTT TLS, OTA and rollback |
| Local dev | PGlite (real Postgres/WASM), Aedes MQTT broker, ESP32 simulator |

## 3. System architecture

```
Browser (Cloudflare Pages)
   │  /api/*  (JWT)
   ▼
Cloudflare Worker  ───────────► Supabase Postgres (service role, server-side only)
   │  /rpc/* atomic domain functions        ▲ RLS for direct/Realtime access
   │  /internal/mqtt/event (HMAC)            │
   ▼                                        │
EMQX Cloud Serverless  ◄──── MQTT/TLS ─── ESP32 (outbound only)
   │  /api/v5 Deployment API                │
   │  per-device users + allow-list ACL     └── HTTPS /api/device/config, OTA binary
   ▼
Durable Object MQTT-over-WSS ingress bridge (platform-side credential)
   │
Cloudflare R2 (firmware binaries)
```

Primary cloud control path: **Website → Cloudflare Worker → EMQX → ESP32**. The ESP32 always initiates the outbound TLS connection. No home router port forwarding, no VPS, no inbound connection to the device.

Local provisioning (SoftAP, USB serial, BLE roadmap, LAN gateway roadmap) is clearly separated from worldwide cloud communication. See `firmware/README.md`.

## 4. Console separation

| Customer Home Console | Platform Owner Console |
|---|---|
| `/` Overview, Rooms, Devices, Switches, Sensors, Controllers, Board Library, Automation, Firmware, Activity, Staff, Settings, `/setup` | `/owner` Overview, Customers, Staff & Access, EMQX Management, Usage & Monitoring, Board Library, Platform Settings, Audit Logs |

Owner routes require a verified JWT **and** a `platform_admins` row. Customer routes require an active `tenant_members` row. The two never share a navigation tree or a permission check.

## 5. Multi-tenancy model

1. Every customer-owned table has `tenant_id` with a foreign key to `tenants`.
2. Supabase RLS policies (`supabase/migrations/0006_rls.sql`) restrict direct/Realtime access to tenants where the JWT subject is an **active** member.
3. The Worker resolves the actor from a verified JWT, loads `rpc_context`, and re-checks every permission with `rpc_check_permission`. Tenant/role claims are never read from request bodies.
4. Domain RPCs (`0009`–`0012`, `0015`) assert `permission_granted(actor, tenant, permission)` again inside Postgres.
5. MQTT topics are tenant-scoped: `v1/tenants/{tenant_id}/devices/{device_id}/{command|state|telemetry|config|availability}`.
6. Every device gets a unique built-in-database username/password/client id. ACL rules allow publish to its own `state`/`telemetry`/`availability` and subscribe to its own `command`/`config`, with deny-all fallback. No shared admin credential reaches an ESP32 or a browser.
7. Device ingest resolves `tenant_id` from the authenticated MQTT session (or from the DB row matching the topic) and **ignores any `tenant_id` in the JSON payload**.
8. Pairing tokens are SHA-256-hashed, single-use and expiring. A `device_id` can belong to exactly one tenant; transfer requires explicit unclaim + reset.

### EMQX Serverless reality (verified)

- HTTP authentication hooks are **not supported** on Serverless → the platform uses built-in-database users via `/api/v5/authentication/password_based%3Abuilt_in_database/users`.
- ACL rules are managed per username through `/api/v5/authorization/sources/built_in_database/rules/users`; the client authz cache is cleared after changes.
- The Deployment API does **not** expose monthly traffic, session minutes or rule actions. Those are on the provider console (hourly). The owner console therefore shows "Unavailable" plus a reason, records live connection counts that the API really returns, and offers owner-verified manual snapshots. No value is fabricated.
- If a deployment lacks an endpoint, provisioning fails loudly with a documented limitation; the system never falls back to shared credentials. See `docs/EMQX.md`.

## 6. Database overview

39 tables across `supabase/migrations/0001`–`0015`:

| Area | Tables |
|---|---|
| Identity | `profiles`, `platform_admins`, `tenants`, `tenant_members`, `staff_invitations`, `roles`, `permissions`, `role_permissions`, `member_permissions`, `member_access_rules` |
| Hardware | `board_catalog`, `board_catalog_versions`, `board_catalog_pins`, `user_boards`, `board_pins`, `exclusive_allocations`, `shared_buses`, `device_pairing_tokens`, `mqtt_credentials_metadata` |
| Home | `rooms`, `devices`, `sensors`, `device_templates`, `sensor_readings`, `switch_states`, `device_commands`, `device_configurations` |
| Operations | `automations`, `automation_logs`, `firmware_releases`, `device_firmware_history`, `platform_settings`, `platform_secrets`, `emqx_usage_snapshots`, `emqx_sync_runs`, `audit_logs`, `notifications`, `system_announcements`, `usage_counters` |

Key invariants:

- `exclusive_allocations UNIQUE (user_board_id, gpio)` — one exclusive owner per physical board. Two boards of the same tenant may both use GPIO 5.
- `assign_pin_exclusive()` validates restricted pins, input-only pins and ADC capability in a single transaction; device creation, pin allocation and config bump commit together.
- `release_allocations_for_owner()` frees pins only after delete commits; `rpc_restore_device()` revalidates before restoring.
- `shared_buses` owns its SDA/SCL or MOSI/MISO/SCK pins; bus sensors do not double-claim them.
- `device_commands` enforces TTL, idempotency and ack states; `rpc_expire_commands()` runs hourly.
- `devices` and `sensors` use partial unique indexes on `(tenant_id, slug)` for soft-deleted rows.

## 7. Device communication

Versioned JSON protocol lives in `packages/core/src/protocol.ts` and is shared by Worker, firmware and simulator.

```json
// telemetry (ESP32 -> Worker -> Postgres)
{ "schema_version": 1, "device_id": "esp32-…", "timestamp": 1794110000,
  "config_version": 12, "sensors": { "temperature_01": { "value": 29.5, "unit": "celsius", "status": "valid" } } }
```
```json
// command (Worker -> EMQX -> ESP32)
{ "command_id": "…", "device_id": "esp32-…", "component_id": "bedroom-light",
  "action": "set_state", "value": true, "expires_at": 1794110300 }
```
```json
// acknowledgement (ESP32 -> state topic)
{ "command_id": "…", "component_id": "bedroom-light", "requested_state": true,
  "actual_state": true, "status": "confirmed" }
```

Commands and configs are published with `retain: false`. Acknowledgements and full state reports update `devices.reported_state`; the UI only displays confirmed state.

## 8. Board library & GPIO

`scripts/board-catalog.mjs` is the single source of truth. It generates `packages/core/data/board-catalog.json` and `supabase/migrations/0008_board_catalog.sql` from official Espressif dev-kit "Header Block" tables:

- ESP32-DevKitC V4 (ESP32-WROOM-32E) — J2/J3
- ESP32-S3-DevKitC-1 v1.1 — J1/J3
- ESP32-C3-DevKitM-1 v1 — J1/J3
- ESP32-C6-DevKitC-1 v1.2 — J1/J3
- Chip-family entries for ESP32-S2, C2, C5, H2, P4 with **zero pins** and `pending_verification`

Each pin row records GPIO, header label/side/position, functions, ADC channels, input-only, boot-strapping, USB/JTAG, flash/PSRAM, restrictions, notes and the official source URL. See `docs/BOARD_SOURCES.md`.

## 9. Development setup

```bash
npm install
npm run dev          # broker :1883/:1885, API :8787, Pages :5173
npm test             # acceptance tests on real Postgres via PGlite
npm run build        # core + web + api
npm run sim -- <pairing-token>   # virtual ESP32 through the REAL pairing flow
```

`npm run dev` creates a local Postgres (PGlite) in `.pglite-data/`, applies the exact production migrations, starts an Aedes broker with real per-device authn/authz, and serves the Vite app with `/api` proxied to the Worker-equivalent API. A local-only platform owner account is printed in the server log (never used in production). No demo devices, rooms or readings are seeded — sign up and pair a device to populate real records. The API process is not file-watched because PGlite is single-writer; restart `npm run dev` after backend changes.

Production build/deployment: see `DEPLOYMENT.md`.

## 10. Environment configuration

Copy `.env.example` → `.env.local` (placeholders only). Worker secrets are set with `wrangler secret put`; see `apps/api/.dev.vars.example`. Never place service-role keys, EMQX App Secrets or broker credentials in `VITE_` variables or in documentation.

## 11. Project directory structure

```
apps/
  web/                  React + Vite frontend (Cloudflare Pages)
  api/                  Hono Worker, provider adapters, Durable Object ingress
  broker/               Local development MQTT broker with real ACLs
packages/core/          Protocol, topics, permissions, pin rules, provider ports
supabase/migrations/    Postgres schema, RLS, seeds, domain RPCs
scripts/                Dev orchestration, board catalog generator
simulator/              Virtual ESP32 (real MQTT client)
firmware/helios_esp32/  ESP-IDF / Arduino-ESP32 firmware
tests/                  Acceptance + schema tests (real Postgres)
docs/                   EMQX, board sources, testing notes
design-system.md  typography.md  README.md  DEPLOYMENT.md  .env.example
```

## 12. Important implementation notes

- All MQTT logic is behind `MqttProvider`; switching to self-hosted EMQX/Mosquitto adds one adapter, no UI or firmware changes.
- All privileged writes go through Postgres RPC functions so pin allocation and config changes are atomic even over PostgREST.
- `platform_secrets` stores AES-256-GCM ciphertext; the Worker returns only masked fingerprints.
- Owner usage snapshots record `source` (`provider_api` / `owner_manual` / `provider_dashboard`); application estimates are separately labelled.
- Safety interlocks are enforced in firmware, not exclusively in the cloud.
- The owner console is reachable only with `platform_admins` membership; a suspended tenant is blocked in both the Worker and RLS.
- Rate limits: pairing token creation (10/hour/tenant) and commands (60/minute/tenant), enforced in Postgres.
- Staff cannot self-escalate: a DB trigger plus Worker checks block owner/administrator assignment by non-owners and self-permission edits.
- Realtime: the browser uses an authenticated SSE stream (`/api/stream`) with the same event shapes; Supabase Realtime can be enabled with `VITE_SUPABASE_*` for direct RLS-protected table changes.

## 13. Testing

See `docs/TESTING.md` and `tests/`. Acceptance tests cover multi-tenancy, staff permissions, GPIO rules, pairing, command acknowledgement, telemetry validation, owner console honesty and production builds.
