# HomecoreOS

A multi-tenant smart-home platform for ESP32 boards: a React dashboard, a serverless API, per-device MQTT credentials, GPIO allocation, commands, telemetry, automations and signed firmware updates.

## How it is hosted

| Part | Service |
| --- | --- |
| Code and automatic deploys | GitHub → Cloudflare Pages (Git integration) |
| Website | Cloudflare Pages static build |
| API | Cloudflare Pages Functions in `functions/` |
| Database and auth | Supabase (PostgreSQL + Auth) |
| Firmware files | Private Supabase Storage bucket (created automatically) |
| Device messaging | EMQX Cloud Serverless, MQTT over TLS on port 8883 |

**No Cloudflare D1 database and no R2 bucket are needed.** No native bindings have to be added in Cloudflare. All configuration is entered once in Cloudflare Pages → Settings → Variables and Secrets.

## Deploy it

Everything is done in web dashboards — GitHub, Cloudflare, Supabase and EMQX. No PC terminal, no CLI and no local tools.

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the exact values to copy into each dashboard.

In short:

1. Fork / import this repository to your GitHub account.
2. Create a Cloudflare Pages project connected to that repository (the exact build settings are in DEPLOYMENT.md).
3. Create a Supabase project, run `supabase/schema.sql` once in its SQL Editor, and copy the Project URL and service-role key.
4. Create an EMQX Cloud **Serverless** deployment and copy its API base, App ID, App Secret and broker host.
5. Add those seven values in Cloudflare Pages → Settings → Variables and Secrets (keys and secrets as encrypted **Secrets**), then redeploy.
6. Open your Pages URL and create the first account — it becomes the platform owner.

## Configuration

Only two values are required for the site to start:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Five more values enable devices (EMQX Cloud Serverless). `EMQX_TLS_PORT` is optional and defaults to `8883`. There is no anon key, no JWT secret, no `SECRETS_KEY` and no database URL to configure. See [.env.example](.env.example) for the complete list.

Secrets are never sent to the browser, never written to the database and never shown again in the dashboard. The Owner Console shows only which values are set and live connection checks.

## What is in the box

- Owner Console: setup checklist, customers, staff, board library, usage, EMQX status, firmware storage test.
- Customer Console: homes, boards and pins, devices, telemetry, commands, automations, firmware releases and OTA with SHA-256 verification.
- Server API: sign-up/sign-in, tenant isolation, pairing, provisioning, GPIO allocation, ingress, quotas, audit log.
- `supabase/schema.sql`: the complete database schema, roles, policies, functions and board catalog — one file, run once.
- `functions/[[path]].ts`: the server-side Pages Function.
- `.github/workflows/deploy.yml`: type checks, builds and verifies the Pages Function bundle on every push.

## Safety notes

- The Supabase service-role key and EMQX App Secret are server-side only. Never prefix them with `VITE_` and never commit them.
- EMQX App Secret is displayed only once when you create the API key — copy it straight into an encrypted Cloudflare Secret.
- The first account created after deployment becomes the platform owner. Create it yourself on your own deployment URL.
