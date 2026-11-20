# HomecoreOS

HomecoreOS is a multi-user smart-home automation platform and ESP32 device fleet control plane built from scratch with:

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4, self-hosted **Geist** & **Geist Mono** typography (`@fontsource-variable/geist`), and a custom HomecoreOS UI component system (`apps/web`)
- **Backend API & Static Host**: Cloudflare Workers + Hono (`apps/worker`)
- **Database**: Supabase PostgreSQL via Worker-only PostgREST (`database/migrations`, no RLS, no Supabase Auth)
- **Authentication**: Custom Argon2id + cryptographic random session tokens (SHA-256 hashed in DB) + HTTP-only cookies
- **Firmware Storage**: Private Cloudflare R2 (`FIRMWARE_BUCKET`)
- **Device Messaging**: EMQX Serverless (MQTT over TLS 8883 for devices, MQTT over WebSocket for the browser console, EMQX v5 REST API)
- **Real-Time Sync**: one subscribe-only MQTT-over-WebSocket session per browser session drives every live component through a shared frontend store; row-version events, batched publishes, snapshot reconciliation and instant credential revocation are specified in `docs/REALTIME_SYNC.md`
- **ESP32 & ESP8266 Firmware**: Native ESP-IDF v5.4/v5.5.2 C firmware with board-aware sensor drivers (`firmware/`, 21 ESP-IDF board overlays) plus an isolated PlatformIO ESP8266 path for `nodemcu-esp8266` (`firmware/esp8266/`)
- **Browser USB Flashing**: Espressif `esptool-js` + Web Serial API with real multi-stage verification
- **Firmware CI Pipeline**: GitHub Actions (`.github/workflows/build-firmware.yml`) with host C tests, board overlay & ESP8266 isolation checks, 21-board ESP-IDF build matrix, and SHA-256 driver manifest verification

## Board ecosystem terminology

| Term | Meaning |
|---|---|
| **Board Library** | The hardware catalog: supported models, specs, GPIO maps, capabilities, firmware compatibility (`board_profiles`, `custom_board_profiles`, `board_gpio_definitions`). |
| **Board profile** | One hardware model in the Board Library (`board_profiles.id` / `custom_board_profiles.id`). Identified on a registered board by `board_profile_id` or `custom_board_profile_id`. |
| **Board instance** | One physical board registered to an account (`board_instances`). It keeps its identity, credentials, pairing, history and OTA records for life. |
| **Controller / Node** | The two operating roles of a board instance (`board_instances.board_role`). Roles are not hardware types: a compatible board can be switched in My Boards, and a Node never promotes itself to Controller. |
| **My Boards** | The user page for registered board instances, with two role tabs (Controllers, Nodes). |

Nothing in the Board Library duplicates a registered board: the library holds definitions, My Boards
holds instances, and Controllers/Nodes are filtered views of the same `board_instances` rows.

## Console chrome

Both consoles share one shell: a collapsible left sidebar and the floating **Dynamic Island**
quick bar. The sidebar's own hide button and the expand/collapse icon in the Dynamic Island's
Quick Navigation panel title drive the same state (persisted per browser), so collapsing the
sidebar hands the full width to the page while the island and every one of its controls stay
where they are. See `DESIGN_SYSTEM.md §8`.

## Workspaces

1. **User Console (`/`)** — a mandatory four-step onboarding tour for every new account (see `docs/USER_ONBOARDING.md`), Overview with a connected, interactive 2D smart-home floor map (pastel rooms, shared walls, doorways, live device badges, compact device controls, zoom/pan, and drag-to-arrange persistence) plus the Room Editor, Rooms, Devices, Switches, Sensors (the Add and Edit forms of devices, switches and sensors have a visual GPIO pin selector that shows every pin of the controller's board as available, used, restricted or dangerous, explains why, and suggests pins), My Boards (one page for every registered physical board, with exactly two role tabs — Controllers and Nodes — an 8-step Guided Setup Wizard, Quick Register, Existing/Recover Board with physical confirmation, live Wi-Fi/MQTT diagnostics, role switching, ESC pairing, and 30-day Trash & Restore), Board Library (verified Espressif DevKits and partner boards such as Seeed Studio XIAO and Waveshare, plus the board profiles an admin imports, on uniform cards with a Details view, clickable interactive physical pinout diagrams, Saved Profiles, and Custom Board Builder; see `docs/BOARD_LIBRARY_WORKFLOWS.md`), Smart Home Planner (guided wizard that checks a described home against the live Board Library and Firmware Management records and recommends controllers, pin assignments and required parts; see `docs/SMART_HOME_PLANNER.md`), Automations (Cloud + offline controller rule sync + `@xyflow/react` Visual Flow Graph Builder with folders, true/false branching, ALL/ANY join gates, delays, notifications, HTTP webhooks, flow variables, and dry-run trace highlighting), password recovery by six-digit email code sent through Brevo (the login page carries the Brevo attribution), two-tab Firmware & Updates (filterable Firmware catalog + Web Serial USB Flasher that checks the connected board against the selected one before writing and warns with a recommended board, and compatible OTA Updates with pending cancellation & history), Activity Log, and User Settings (including Regional Timezone preferences).
2. **Admin Console (`/admin`)** — Platform Overview, Setup Status, Users & Staff Management, Firmware Management (Single Image & ZIP Release Package with per-board slug/ID targeting), Board Library Management (Import Official Boards from Seeed Studio XIAO and Espressif sources with preview and selection, one-click Official Espressif Catalog Sync, safe board removal, GPIO verification publication guard, firmware support flags, and pinout inspector), EMQX Management, Usage & Monitoring, and Platform Settings (including Global Default Regional Timezone and the Brevo sender used for password-recovery email; the `BREVO_API_KEY` itself is a Worker secret).

## Repository Structure

```text
apps/
  web/              React + TypeScript + Vite + HomecoreOS UI, 2D Floor Plan, Interactive Board Pinouts & @xyflow/react Flow Builder
  worker/           Cloudflare Workers + Hono API backend
packages/
  shared/           Shared TypeScript types, verified Board Library & pinouts, flow-graph compiler/validator, timezone & version helpers
firmware/           ESP-IDF C firmware (21 board overlays, Kconfig sensor drivers, host C tests, verifier) & isolated firmware/esp8266/
database/
  migrations/       PostgreSQL schema: 0001_init.sql baseline, then 0002_board_roles.sql,
                    0003_user_onboarding.sql, 0004_password_reset_otp.sql and
                    0005_realtime_sync.sql
  verify/           Schema snapshot + `npm run db:verify` drift check
  seeds/            Development-only seed data
.github/workflows/  CI checks & automated ESP-IDF firmware build pipeline
DESIGN_SYSTEM.md    HomecoreOS Geist design tokens, ReUI/Radix primitives & architectural floor-plan spec
DEPLOYMENT.md       Browser dashboard deployment guide
docs/REALTIME_SYNC.md  Real-time channel: topics, ACLs, event flow, reconnect and quota rules
```

## Quick Commands

```bash
npm install
npm run typecheck
npm run lint
npm run build
npm run test
npm run db:verify   # replays migrations, fails on schema drift
```

See `DEPLOYMENT.md` for full setup instructions across GitHub, Supabase, Cloudflare Workers, Cloudflare R2, and EMQX Serverless, `DESIGN_SYSTEM.md` for UI rules, and `docs/REALTIME_SYNC.md` for how live state reaches the console.
