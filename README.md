# HomecoreOS

A multi-tenant smart-home platform for ESP32 controllers: a device-focused React console, a serverless API, per-device MQTT credentials, GPIO allocation, commands, telemetry, automations, a guided setup wizard, board management and firmware updates stored in a private Cloudflare R2 bucket attached as a native Pages binding.

## How it is hosted

| Part | Service |
| --- | --- |
| Code and automatic deploys | GitHub → Cloudflare Pages (Git integration) |
| Website | Cloudflare Pages static build |
| API and authentication | Cloudflare Pages Functions in `functions/` |
| Database, accounts, sessions, permissions, firmware metadata | Supabase PostgreSQL (database only, no Supabase Auth) |
| Firmware binaries | Private Cloudflare R2 bucket via the native `FIRMWARE_BUCKET` Pages binding |
| Device messaging | EMQX Cloud Serverless, MQTT over TLS on port 8883 |

**A Cloudflare D1 database is not used.** Firmware storage uses the one native R2 bucket binding named `FIRMWARE_BUCKET`, added once in Cloudflare Pages → Settings → Functions → R2 bucket bindings; the bucket itself stays private. All other configuration is entered in Cloudflare Pages → Settings → Variables and Secrets. There are no R2 API keys or `R2_…` secrets. GitHub stays directly connected to Cloudflare Pages; there is no deploy workflow and no GitHub deployment secret.

## What is in the box

**Both consoles** share one design system: one typeface, a two-layer colour-token system with light and dark modes, flat surfaces, one restrained accent, tokenised spacing and radii, Phosphor icons at one weight, composed loading/empty/error/success states, visible focus rings, reduced-motion support and a 390 px mobile layout.

- **Customer Console** — areas and device-focused cards with real reported states, controllers, switches, sensors, rooms, board library, pin maps, automation rules, firmware releases, activity, staff and account security. The **Add a controller** wizard uses plain language, inline illustrations and live server-side progress; its success screen appears only after a controller actually reports online.
- **Owner Console — Firmware management** — upload validated firmware binaries to private R2, list/filter versions, edit name/description/version/board compatibility, show size, upload date, checksum and deployment counts, publish/unpublish/archive, delete with confirmation, assign updates to compatible controllers, and follow real OTA results and update history. Every mutation is owner-only.
- **Owner Console — Board library** — verified manufacturer pin maps stay read-only; custom boards are added with owner-supplied name, manufacturer, ESP32 variant, description, board image and pinout reference. GPIO rows declare input-only, boot-strapping, reserved, flash/PSRAM and unavailable pins, plus ADC/PWM/I²C/SPI/UART capabilities. Duplicates, duplicate GPIO numbers, invalid ranges and impossible capability combinations are rejected. GPIO assignments are validated against the selected board. No board specifications are invented.
- **Owner Console — Platform settings** — grouped, plain-language settings with current values, Save/Cancel, validation and confirmation for sensitive changes. Only settings actually enforced by the API are shown.
- **Owner Console — Authentication & security** — real database-backed status, registration control, sign-in protection, password policy, session lifetime, recovery-code policy, account and active-session management, roles/permissions and a security-event history. No decorative scores.

## Authentication

Authentication is entirely custom and database-backed. There is no Supabase Auth, no Google/Firebase/Clerk/Auth0 login, no external OTP provider and no third-party identity service.

- Accounts, password hashes, sessions, roles, permissions, recovery codes, login-attempt counters, security events and configurable security limits live in Supabase PostgreSQL (`app_users`, `app_sessions`, `app_roles`, `app_permissions`, `app_user_roles`, `app_recovery_codes`, `app_login_attempts`, `app_auth_config`, `app_security_events`).
- Passwords are hashed inside PostgreSQL with bcrypt (`pgcrypto`) using a server-side HMAC pepper derived from the Cloudflare secret. Plaintext passwords and password hashes never reach the browser, and hashing does not consume Cloudflare CPU time.
- Sessions are random tokens whose SHA-256 hash is stored in the database. The browser receives only an `HttpOnly; Secure; SameSite=Lax` cookie — no token in `localStorage`, no JWT in the frontend, and no bearer header.
- Every protected API call resolves the session in the database. Owner Console APIs additionally verify the account's role and `owner.console` permission in the database; changing a frontend URL cannot grant access.
- Registration, login, recovery and password changes are protected by per-account and per-IP attempt limits, an optional registration lock, session expiry, idle timeout and a per-account session limit. All limits are adjustable from the Owner Console and enforced by the API and the database.
- The first successfully registered account becomes the **Platform Owner** in one atomic database transaction. Every later account is a normal customer with its own home workspace.

## Firmware storage and security

- A private R2 bucket is attached to the Pages project under **Settings → Functions → R2 bucket bindings** with the variable name **`FIRMWARE_BUCKET`** (`R2_BUCKET` also works). The Pages Function uses that binding directly; no R2 API token, access key, secret, account ID, S3 endpoint or SDK is configured anywhere.
- The binding never reaches the browser. No R2 credential is stored in PostgreSQL, in an environment variable, or shown in the dashboard.
- Uploads are limited to 16 MB and `.bin`/`.elf`/`.img`. The client and the server both compute SHA-256; the server verifies the size, rejects duplicate versions and unknown board models, stores the binary, reads it back and verifies the checksum before saving metadata.
- Download URLs are short-lived HMAC-signed API URLs, or owner-authorised server-side downloads that re-verify the checksum. The private bucket has no public URL.
- Deletion is two-step (`DELETE` confirmation plus a server-side `confirm=DELETE` check), refuses to run while an update is in progress, and only commits the metadata removal after the R2 object is deleted.
- The Owner Console reports R2 as **Verified** only after a real upload → download → checksum → delete round trip succeeds. Without the binding the app falls back to private Supabase Storage and says so explicitly.

## Deploy it

Everything is done in web dashboards — GitHub, Cloudflare, Supabase and EMQX. No PC terminal, no CLI and no local tools.

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for exact Cloudflare dashboard steps: creating a private R2 bucket, attaching the `FIRMWARE_BUCKET` binding, adding the seven encrypted secrets, the complete Pages build settings, testing firmware upload, and testing the device connection flow.

In short:

1. Fork / import this repository to your GitHub account.
2. Create a Cloudflare Pages project connected to that repository (exact build settings are in DEPLOYMENT.md).
3. Create a Supabase project and run `supabase/schema.sql` once in its SQL Editor; copy the Project URL and service-role key.
4. Create an EMQX Cloud **Serverless** deployment and copy its API base, App ID, App Secret and broker host.
5. Create a **private Cloudflare R2 bucket**. In the Pages project open **Settings → Functions → R2 bucket bindings** and add **`FIRMWARE_BUCKET`** pointing at that bucket for **Production**.
6. Add the seven Supabase/EMQX values as encrypted **Secrets** in Cloudflare Pages → Settings → Variables and Secrets, add `NODE_VERSION=20` as a plain variable, then redeploy so the binding is attached.
7. Open your Pages URL and register the first account — it becomes the Platform Owner. Save the recovery codes shown after registration. Run **Firmware management → Test R2 binding** before uploading a build.

## Configuration

Only two values are required for the site to start: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Five EMQX values enable devices; the `FIRMWARE_BUCKET` R2 binding enables private firmware storage. `EMQX_TLS_PORT` defaults to `8883`. There is no anon key, JWT secret, `SECRETS_KEY`, auth-provider key, database URL, R2 API token or `R2_…` variable to configure. See [.env.example](.env.example) for the complete list.

Secrets are never sent to the browser, never written to the database and never shown again in the dashboard. The Owner Console shows only which values are set and live connection checks.

## Implementation layout

| Path | Contents |
| --- | --- |
| `apps/web/src/styles.css` | Design tokens, light/dark themes, components, states, responsive rules |
| `apps/web/src/icons.tsx` | Phosphor regular glyph paths used by the app (no icon dependency shipped) |
| `apps/web/src/components.tsx` | Shared UI, composed states, device illustrations |
| `apps/web/src/pages/` | Customer and Owner Console pages, firmware, board library, setup wizard, settings, security |
| `apps/api/src/app.ts` | Hono API routes, validation, owner authorisation, tenant isolation |
| `apps/api/src/storage/r2.ts` | Native R2 binding store and real round-trip verification |
| `apps/api/src/auth.ts`, `context.ts` | Custom database-backed authentication and request context |
| `packages/core/` | Protocol, topics, board catalog, GPIO evaluation |
| `supabase/schema.sql` | Consolidated, re-runnable PostgreSQL schema and RPCs |
| `firmware/homecoreos_esp32/` | ESP32 firmware (pairing, hardware reporting, OTA verification) |
