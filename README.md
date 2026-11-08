# HomecoreOS

A multi-tenant smart-home platform for ESP32 boards: a React dashboard, a serverless API, per-device MQTT credentials, GPIO allocation, commands, telemetry, automations and signed firmware updates.

## How it is hosted

| Part | Service |
| --- | --- |
| Code and automatic deploys | GitHub → Cloudflare Pages (Git integration) |
| Website | Cloudflare Pages static build |
| API and authentication | Cloudflare Pages Functions in `functions/` |
| Database, accounts, sessions, permissions | Supabase PostgreSQL (database only, no Supabase Auth) |
| Firmware files | Private Supabase Storage bucket (created automatically) |
| Device messaging | EMQX Cloud Serverless, MQTT over TLS on port 8883 |

**No Cloudflare D1 database and no R2 bucket are needed.** No native bindings have to be added in Cloudflare. All configuration is entered once in Cloudflare Pages → Settings → Variables and Secrets.

## Authentication

Authentication is entirely custom and database-backed. There is no Supabase Auth, no Google/Firebase/Clerk/Auth0 login, no external OTP provider and no third-party identity service.

- Accounts, password hashes, sessions, roles, permissions, recovery codes, login-attempt counters and configurable security limits live in Supabase PostgreSQL (`app_users`, `app_sessions`, `app_roles`, `app_permissions`, `app_user_roles`, `app_recovery_codes`, `app_login_attempts`, `app_auth_config`).
- Passwords are hashed inside PostgreSQL with bcrypt (`pgcrypto`) using a server-side HMAC pepper derived from the Cloudflare secret. Plaintext passwords and password hashes never reach the browser, and hashing does not consume Cloudflare CPU time.
- Sessions are random tokens whose SHA-256 hash is stored in the database. The browser receives only an `HttpOnly; Secure; SameSite=Lax` cookie — no token in `localStorage`, no JWT in the frontend, and no bearer header.
- Every protected API call resolves the session in the database. Owner Console APIs additionally verify the account's role and `owner.console` permission in the database; changing a frontend URL or account data cannot grant access.
- Registration, login, recovery and password changes are protected by per-account and per-IP attempt limits with a configurable lockout window. Owner-adjustable limits are in **Owner Console → Authentication**.
- The first successfully registered account becomes the **Platform Owner** in a single atomic database transaction. Every later account is a normal customer with its own home workspace.
- Account recovery uses single-use codes shown once at registration (or regenerated from Settings / Owner Console). Change password, sign out other sessions and revoke a session are available in the Customer Console.

## Deploy it

Everything is done in web dashboards — GitHub, Cloudflare, Supabase and EMQX. No PC terminal, no CLI and no local tools.

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the exact values to copy into each dashboard, the GitHub secrets to delete, and the Platform Owner registration steps.

In short:

1. Fork / import this repository to your GitHub account.
2. Create a Cloudflare Pages project connected to that repository (the exact build settings are in DEPLOYMENT.md).
3. Create a Supabase project, run `supabase/schema.sql` once in its SQL Editor, and copy the Project URL and service-role key.
4. Create an EMQX Cloud **Serverless** deployment and copy its API base, App ID, App Secret and broker host.
5. Add those seven values in Cloudflare Pages → Settings → Variables and Secrets as encrypted **Secrets**, add `NODE_VERSION=20` as a plain variable, then redeploy.
6. Open your Pages URL and register the first account — it becomes the Platform Owner. Save the recovery codes shown after registration.

## Configuration

Only two values are required for the site to start:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Five more values enable devices (EMQX Cloud Serverless). `EMQX_TLS_PORT` is optional and defaults to `8883`. There is no anon key, no JWT secret, no `SECRETS_KEY`, no auth-provider key and no database URL to configure. See [.env.example](.env.example) for the complete list.

Secrets are never sent to the browser, never written to the database and never shown again in the dashboard. The Owner Console shows only which values are set and live connection checks.

## What is in the box

- Owner Console: setup checklist, customers, staff, board library, usage, EMQX status, firmware storage test, account/session/rate-limit administration.
- Customer Console: homes, boards and pins, devices, telemetry, commands, automations, firmware releases and OTA with SHA-256 verification, account security.
- Server API: sign-up, sign-in, logout, session expiry, password change, recovery, tenant isolation, pairing, provisioning, GPIO allocation, ingress, quotas, audit log.
- `supabase/schema.sql`: the complete database schema, custom auth tables, roles, policies, functions and board catalog — one file, run once. Re-running it is safe and preserves existing accounts.
- `functions/[[path]].ts`: the server-side Pages Function.
- Cloudflare's Git integration builds and deploys on every push; no GitHub Actions workflow is used.

## Safety notes

- The Supabase service-role key and EMQX App Secret are server-side only. Never prefix them with `VITE_` and never commit them.
- EMQX App Secret is displayed only once when you create the API key — copy it straight into an encrypted Cloudflare Secret.
- The first account created after deployment becomes the Platform Owner. Create it yourself on your own deployment URL, and store its recovery codes securely.
