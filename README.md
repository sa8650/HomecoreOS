# HomecoreOS

HomecoreOS is a multi-user smart-home automation platform and ESP32 device fleet control plane built from scratch with:

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4, self-hosted **Geist** & **Geist Mono** typography (`@fontsource-variable/geist`), and a custom HomecoreOS UI component system (`apps/web`)
- **Backend API & Static Host**: Cloudflare Workers + Hono (`apps/worker`)
- **Database**: Supabase PostgreSQL via Worker-only PostgREST (`database/migrations`, no RLS, no Supabase Auth)
- **Authentication**: Custom Argon2id + cryptographic random session tokens (SHA-256 hashed in DB) + HTTP-only cookies
- **Firmware Storage**: Private Cloudflare R2 (`FIRMWARE_BUCKET`)
- **Device Messaging**: EMQX Serverless (MQTT over TLS 8883 + EMQX v5 REST API)
- **ESP32 Firmware**: Native ESP-IDF C/C++ targeting **ESP32-S3 N16R8** (`firmware/`)
- **Browser USB Flashing**: Espressif `esptool-js` + Web Serial API with real multi-stage verification
- **Firmware CI Pipeline**: GitHub Actions (`.github/workflows/build-firmware.yml`)

## Workspaces

1. **User Console (`/`)** — Overview with Interactive 2D Architectural Floor Plan & Room Editor, Rooms, Devices, Switches, Sensors (the Add and Edit forms of devices, switches and sensors have a visual GPIO pin selector that shows every pin of the controller's board as available, used, restricted or dangerous, explains why, and suggests pins), Controllers (8-step Guided Setup Wizard, Quick Register, Existing/Recover Controller with physical confirmation, live Wi-Fi/MQTT diagnostics, and 30-day Trash & Restore), Board Library (11 verified Espressif DevKits + Seeed Studio XIAO ESP32-S3, plus the boards an admin imports, on uniform cards with a Details view, clickable interactive physical pinout diagrams, My Boards, and Custom Board Builder; see `docs/BOARD_LIBRARY_WORKFLOWS.md`), Smart Home Planner (guided wizard that checks a described home against the live Board Library and Firmware Management records and recommends controllers, pin assignments and required parts; see `docs/SMART_HOME_PLANNER.md`), Automations (Cloud + offline controller rule sync + `@xyflow/react` Visual Flow Graph Builder with folders, true/false branching, ALL/ANY join gates, delays, notifications, HTTP webhooks, flow variables, and dry-run trace highlighting), two-tab Firmware & Updates (filterable Firmware catalog + Web Serial USB Flasher that checks the connected board against the selected one before writing and warns with a recommended board, and compatible OTA Updates with pending cancellation & history), Activity Log, and User Settings (including Regional Timezone preferences).
2. **Admin Console (`/admin`)** — Platform Overview, Setup Status, Users & Staff Management, Firmware Management (Single Image & ZIP Release Package with per-board slug/ID targeting), Board Library Management (Import Official Boards from Seeed Studio XIAO and Espressif sources with preview and selection, one-click Official Espressif Catalog Sync, safe board removal, GPIO verification publication guard, firmware support flags, and pinout inspector), EMQX Management, Usage & Monitoring, and Platform Settings (including Global Default Regional Timezone).

## Repository Structure

```text
apps/
  web/              React + TypeScript + Vite + HomecoreOS UI, 2D Floor Plan, Interactive Board Pinouts & @xyflow/react Flow Builder
  worker/           Cloudflare Workers + Hono API backend
packages/
  shared/           Shared TypeScript types, verified board catalog & pinouts, flow-graph compiler/validator, timezone & version helpers
firmware/           ESP-IDF C/C++ firmware project (ESP32-S3 N16R8, persistent identity, AP+STA recovery, local automation sync)
database/
  migrations/       PostgreSQL schema & seed migrations (0001..0013)
  seeds/            Development-only seed data
.github/workflows/  CI checks & automated ESP-IDF firmware build pipeline
DESIGN_SYSTEM.md    HomecoreOS Geist design tokens, ReUI/Radix primitives & architectural floor-plan spec
DEPLOYMENT.md       Browser dashboard deployment guide
```

## Quick Commands

```bash
npm install
npm run typecheck
npm run lint
npm run build
npm run test
```

See `DEPLOYMENT.md` for full setup instructions across GitHub, Supabase, Cloudflare Workers, Cloudflare R2, and EMQX Serverless, and `DESIGN_SYSTEM.md` for UI rules.
