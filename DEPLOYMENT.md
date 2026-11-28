# HomecoreOS — Complete Deployment Guide

This guide walks through deploying **HomecoreOS** using browser dashboards (GitHub, Supabase, Cloudflare, EMQX Cloud) with minimal terminal work, targeting **free infrastructure tiers**.

> Never commit private credentials, API keys, service role keys, or `.dev.vars` files into GitHub.

---

## 1. Prerequisites & Configuration Reference

HomecoreOS uses **only** the following Cloudflare Worker environment variables, secrets, and R2 binding:

| Name | Type | Where to get it |
| --- | --- | --- |
| `SUPABASE_URL` | Variable | Supabase Project Settings → Data API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | Supabase Project Settings → API Keys → `service_role` secret |
| `EMQX_API_BASE` | Variable | EMQX Serverless Deployment Overview → HTTP API / Endpoint URL |
| `EMQX_APP_ID` | Variable | EMQX Serverless Deployment Overview → Deployment API Key → App ID |
| `EMQX_APP_SECRET` | Secret | EMQX Serverless Deployment Overview → Deployment API Key → App Secret |
| `EMQX_BROKER_HOST` | Variable | EMQX Serverless Deployment Overview → Connect Address |
| `EMQX_TLS_PORT` | Variable | `8883` (EMQX Serverless MQTT over TLS port) |
| `EMQX_WS_URL` | Variable (optional) | Full `wss://…` MQTT-over-WebSocket URL for the browser console. Omit to derive it (next row). |
| `EMQX_WS_PORT` | Variable (optional) | `8084` (MQTT over WebSocket TLS port) when `EMQX_WS_URL` is omitted. |
| `EMQX_WS_PATH` | Variable (optional) | `/mqtt` (WebSocket path) when `EMQX_WS_URL` is omitted. |
| `BREVO_API_KEY` | Secret | Brevo → SMTP & API → API Keys (sends password-recovery codes; optional) |
| `FIRMWARE_BUCKET` | R2 Binding | Cloudflare R2 private bucket (`homecoreos-firmware`) |
| `BOARD_LOG_ENABLED` | Variable (optional) | Per-board live Log capture. Set to `false` to stop writing new log rows; the console keeps reading the stored history. Defaults to enabled. |
| `BOARD_LOG_RETENTION_DAYS` | Variable (optional) | Retention window for the stored per-board log rows. Defaults to `14` days. |

> **Do not create** `JWT_SECRET`, `APP_SECRET`, Supabase Auth keys, Firebase keys, or Cloudflare D1 bindings.

---

## 2. GitHub Setup & Firmware Compilation

1. Push this repository to a new GitHub repository (`main` branch).
2. Repository layout:
   - `apps/web` — React + Vite frontend
   - `apps/worker` — Cloudflare Worker + Hono backend
   - `firmware` — ESP-IDF C/C++ project
   - `database/migrations` — PostgreSQL schema migrations
   - `.github/workflows` — CI & firmware builds
3. **Compile ESP32-S3 N16R8 Firmware via GitHub Actions**:
   - In GitHub, open the **Actions** tab.
   - Select **Build HomecoreOS ESP32 Firmware** (`.github/workflows/build-firmware.yml`).
   - Click **Run workflow**, enter the firmware version (for example `1.0.0`) and release channel (`stable`), and run.
   - Once complete, open the workflow run and download the ZIP release artifact (for example `homecoreos-esp32s3-v1.0.0.zip`).
   - Do not unzip it if you want to upload the full package in the Admin Console (**Upload Release Package (.zip)**).

---

## 3. Supabase PostgreSQL Setup (Database Only)

HomecoreOS uses Supabase **strictly as PostgreSQL**. Do **not** enable Supabase Auth or Row Level Security (RLS).

1. Go to [supabase.com](https://supabase.com), create a free account and a new project.
2. Wait for provisioning, then go to **Project Settings → Data API / API Keys**:
   - Copy **Project URL** → this is `SUPABASE_URL`.
   - Reveal and copy the **`service_role`** key → this is `SUPABASE_SERVICE_ROLE_KEY`.
3. Open **SQL Editor** in the Supabase dashboard.
4. Apply the migrations in `database/migrations/` in filename order:
   - `0001_init.sql` creates every platform table, foreign key, index, trigger and atomic RPC function, seeds the platform settings row (including `default_timezone`) and the full Board Library with GPIO definitions, and keeps RLS **disabled** while revoking direct `anon`/`authenticated` PostgREST access.
   - `0002_board_roles.sql`, `0003_user_onboarding.sql`, `0004_password_reset_otp.sql` and `0005_realtime_sync.sql` add Controller/Node roles, mandatory onboarding, password-recovery codes and the browser real-time session bookkeeping on top of that baseline.
   - Paste each file into the SQL Editor in order (or run `psql "$DATABASE_URL" -f <file>` for each) and verify no errors appear.
   - `npm run db:verify` replays every migration against a throwaway Postgres and fails if the schema drifts from `database/verify/schema-snapshot.json`.
5. **Initial Platform Administrator**:
   - After deploying the Cloudflare Worker, open HomecoreOS in your browser and go to `/admin` (or click **Platform Admin Console** on the sign-in screen). When zero platform administrators exist, the initial root bootstrap form is presented automatically.
   - Once the first `super_admin` administrator is created, the bootstrap route automatically locks permanently.

---

## 4. Cloudflare R2 Firmware Storage

1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com).
2. Go to **R2 Object Storage → Create bucket**.
3. Name the bucket `homecoreos-firmware` (keep **Public Access disabled** — firmware must remain strictly private).
4. Note the bucket name for binding as `FIRMWARE_BUCKET` on your Worker.

---

## 5. EMQX Serverless Setup

1. Create a free account at [emqx.com/en/cloud](https://www.emqx.com/en/cloud).
2. Create a **Serverless** deployment (free tier).
3. On the deployment **Overview** page, record:
   - **Connect Address** (hostname like `xxxxxx.ala.us-east-1.emqxsl.com`) → `EMQX_BROKER_HOST`
   - **MQTT over TLS Port** (`8883`) → `EMQX_TLS_PORT`
   - **REST API Endpoint** (e.g. `https://xxxxxx.ala.us-east-1.emqxsl.com:8443/api/v5`) → `EMQX_API_BASE`
4. Under **Deployment API Key** (on the Overview page), click **+ New API Key**:
   - Copy **App ID** → `EMQX_APP_ID`
   - Copy **App Secret** (shown once) → `EMQX_APP_SECRET`
5. Ensure **Built-in Database Authentication** and **Built-in Authorization** are enabled in Access Control so HomecoreOS can provision per-controller credentials and topic ACLs via the Deployment API.
6. Confirm **MQTT over WebSocket** is enabled (EMQX Serverless enables it on port `8084`, path `/mqtt`). The browser console uses it for live state; per-controller MQTT over TLS keeps using `8883`.

### Real-time channel check

After deploying, open the console and confirm the live channel works:

1. Open `/` in two browser tabs.
2. Toggle a switch in one tab. The other tab, the 2D floor plan, the room card and the
   Dynamic Island master controls must update without a refresh.
3. `GET /api/realtime/config` on the deployed Worker (while signed in) must return
   `"enabled": true` with `"brokerUrl": "wss://<EMQX_BROKER_HOST>:8084/mqtt"`.
   If it returns `"enabled": false`, the `reason` names the missing piece
   (`emqx_not_configured`, `provision_failed`, …).
4. If your deployment exposes WebSocket on a different port/path, set `EMQX_WS_URL`
   (preferred) or `EMQX_WS_PORT` + `EMQX_WS_PATH` and redeploy.
5. Revocation check: sign the same account in from a second browser, then revoke that session
   from **User Settings → Active Sessions**. The revoked tab must stop receiving updates
   immediately (EMQX deletes the broker user and kicks the client), and its
   `GET /api/realtime/config` must answer `401`. Changing the password or completing a
   password recovery must do the same for every other session automatically.
6. Account-scope check: with two accounts on one login, switch account and confirm
   `GET /api/realtime/config` returns the new account's topic
   (`homecore/<newAccountId>/realtime/#`) and that the previous username no longer exists in
   **EMQX → Access Control → Users**.
7. Console chrome check: hide the sidebar from its header button, then re-open it from the
   Dynamic Island → Quick Navigation expand/collapse icon. The layout must reflow to full
   width (no gap, no horizontal scrollbar) and the choice must survive a reload.

Until the WebSocket listener is reachable, the console keeps working and shows
`Manual refresh`: pages fall back to one visible-only refresh per minute instead of tight
polling. `Live` is only shown once a snapshot has actually been applied, so a failing database
read reads `Delayed` and retries with backoff rather than pretending the console is in sync.
Architecture, event flow, revocation and quota rules are documented in `docs/REALTIME_SYNC.md`.

---

## 6. Cloudflare Workers Deployment (Dashboard + GitHub)

1. In Cloudflare Dashboard, go to **Workers & Pages → Create → Workers → Connect to Git**.
2. Select your HomecoreOS GitHub repository.
3. Configure build settings:
   - **Root directory**: `/` (repository root)
   - **Build command**: `npm ci && npm run build`
   - **Deploy command**: `npx wrangler deploy --config apps/worker/wrangler.jsonc`
4. After the first deploy (or before deploying), open the Worker → **Settings → Variables and Secrets**:
   - Add **Variables** (Plaintext):
     - `SUPABASE_URL`
     - `EMQX_API_BASE`
     - `EMQX_APP_ID`
     - `EMQX_BROKER_HOST`
     - `EMQX_TLS_PORT` (`8883`)
   - Add **Secrets** (Encrypted):
     - `SUPABASE_SERVICE_ROLE_KEY`
     - `EMQX_APP_SECRET`
     - `BREVO_API_KEY` (needed for the emailed password-recovery code; see section 8)
5. Under **Settings → Bindings → Add binding → R2 bucket**:
   - Variable name: `FIRMWARE_BUCKET`
   - R2 bucket: `homecoreos-firmware`
6. Save and redeploy. (Notice `apps/worker/wrangler.jsonc` sets `"keep_vars": true` so future Git deploys do not erase Dashboard variables.)

---

## 7. Initial Platform Verification

1. Open your deployed HTTPS URL (`https://homecoreos.<subdomain>.workers.dev`).
2. Create the initial Platform Administrator at `/admin`.
3. Log in to **Admin Console** and open **Setup Status** (`/admin/setup`):
   - Confirm **Supabase PostgreSQL**, **EMQX Serverless**, and **Cloudflare R2 (FIRMWARE_BUCKET)** all show **Connected**.
4. Open **Board Library Management** and confirm `ESP32-S3-DevKitC-1 N16R8` is present and active.
5. Open **Firmware Management → Upload Release Package**, upload the ZIP downloaded from GitHub Actions, verify checksums, and **Publish** the release.
6. Register a customer account (or open **User Console**), pair and USB-flash your **ESP32-S3 N16R8** over Chrome/Edge Web Serial, configure Wi-Fi + 6-digit pairing code on the controller's local setup AP (`HomecoreOS-Setup-XXXX`), and verify live MQTT connectivity and OTA updates.

---

## 8. Password Recovery Email (Brevo)

Customers who forget a password recover it with a six-digit code emailed to them.
The sender identity lives in the Admin Console, the API key lives on the Worker.

1. Create a Brevo account and verify the sender domain or address you will send from.
2. Brevo → **SMTP & API → API Keys** → create a key, then add it to the Worker as the secret `BREVO_API_KEY`.
3. Admin Console → **Settings → Transactional Email (Brevo)**: set **From name**, **From email** (the verified sender) and an optional **Reply-to**, then save.
4. Confirm the badge next to that card reads **BREVO_API_KEY configured**.

Until both the key and a from address exist, the sign-in card's **Forgot password?** flow reports that recovery email is not configured instead of silently doing nothing. Recovery codes are stored hashed, expire after ten minutes, tolerate five wrong attempts, and unlock a single-use reset token that also revokes every active session when the new password is saved.
