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
| `FIRMWARE_BUCKET` | R2 Binding | Cloudflare R2 private bucket (`homecoreos-firmware`) |

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
4. Run every migration file in `database/migrations/` in exact numeric order (`0001_initial_schema.sql`, `0002_seed_catalog_and_settings.sql`, `0003_ui_timezone_and_floorplan.sql`, `0004_remove_areas.sql`).
   - Verify no errors appear.
   - These scripts create the platform tables, foreign keys, indexes, atomic RPC functions, platform settings defaults (including `default_timezone`), user timezone overrides, 2D floor-plan room geometry columns, and the `ESP32-S3-DevKitC-1 N16R8` board catalog entry, while keeping RLS **disabled** and revoking direct `anon`/`authenticated` PostgREST access.
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
