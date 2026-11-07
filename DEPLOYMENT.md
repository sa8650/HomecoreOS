# Helios Deployment Guide

> All values below are placeholders. Never commit real credentials, tokens or secrets. Worker secrets are set with `wrangler secret put`; Supabase/EMQX/R2 values are set in their own dashboards. `.env.example` contains safe placeholders only.

## 0. Deployment topology

| Delivery | Component |
|---|---|
| GitHub | Source of truth; pushes trigger Pages + Worker deployments |
| Cloudflare Pages | `apps/web` build output (`dist`) |
| Cloudflare Workers | `apps/api` (`src/worker.ts`), Durable Object `MqttIngressDO`, R2 binding |
| Supabase | Postgres + Auth + Realtime |
| EMQX Cloud Serverless | MQTT broker + Deployment API |
| Cloudflare R2 | Firmware binaries |
| ESP32 | Outbound MQTT/TLS, no inbound ports |

No VPS is required.

---

## 1. GitHub repository setup

```bash
git init
git add .
git commit -m "Initial Helios platform"
git branch -M main
git remote add origin https://github.com/<org>/<repo>.git
git push -u origin main
```

Protect `main`: require PR review + passing CI (`.github/workflows/deploy.yml`). Add repository secrets (GitHub Actions → Secrets):

```
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
SUPABASE_ACCESS_TOKEN          # for supabase CLI migration deploys (optional)
SUPABASE_DB_PASSWORD           # optional, for psql migrations
```

Never store `SUPABASE_SERVICE_ROLE_KEY`, `EMQX_APP_SECRET`, `SECRETS_KEY` or MQTT credentials in GitHub **variables**; use encrypted secrets or `wrangler secret put`.

## 2. Supabase project configuration

1. Create a Supabase project. Note `Project URL`, `anon key`, `service_role key`, `JWT secret`.
2. Enable Email auth (decide whether email confirmation is required; `SupabaseAuthAdapter` surfaces a clear message when confirmation is pending).
3. Apply migrations in order (`supabase/migrations/0001_*.sql` … `0015_*.sql`):

```bash
# Option A: Supabase CLI (recommended)
supabase link --project-ref <project-ref>
supabase db push

# Option B: psql with the project's connection string
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

4. Verify RLS: in the SQL editor run

```sql
select relname, relrowsecurity from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname;
```

Every customer-owned table must show `true`. `0006_rls.sql` also grants PostgREST roles, revokes secret tables from `anon`/`authenticated`, and adds tenant tables to the `supabase_realtime` publication.

5. Create the `handle_new_user` trigger (Supabase Auth → Database → Triggers, or SQL):

```sql
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

6. Bootstrap the first platform owner **after** signing up that account:

```sql
insert into public.platform_admins (profile_id, level)
values ((select id from public.profiles where email = 'owner@example.com'), 'owner');
```

Do not seed customers, devices or readings. Registration creates real tenants.

## 3. EMQX Cloud Serverless deployment

1. Create a **Serverless** deployment in EMQX Cloud. Note the broker hostname, TLS port (`8883`), WSS endpoint and port (`8084`), and the deployment API base ending in `/api/v5`.
2. On the deployment overview, **Create Application** to obtain AppID / AppSecret (basic auth for the Deployment API).
3. Confirm the deployment enables the built-in-database (`password_based:built_in_database`) authenticator and built-in-database authorization. HTTP authentication is **not supported** on Serverless; the platform does not rely on it.
4. Create ONE dedicated **platform ingress bridge** user with subscribe-only ACL for:
   ```
   v1/tenants/+/devices/+/state
   v1/tenants/+/devices/+/telemetry
   v1/tenants/+/devices/+/availability
   ```
   This credential is used only by the Durable Object. Devices and browsers never receive it.
5. Set authorization `no_match = deny` so each device's allow-list is the only permission it has. Per-device users and ACL rules are created automatically by `EmqxCloudProvider.provisionDevice` during pairing.
6. Download the deployment root CA and place it in `firmware/helios_esp32/ca_cert.cpp` (gitignored). See `docs/EMQX.md`.

### Verified endpoint contract

```
POST   /api/v5/authentication/password_based%3Abuilt_in_database/users   {user_id,password,is_superuser:false}
PUT    /api/v5/authentication/password_based%3Abuilt_in_database/users/{user_id}  {password}
DELETE /api/v5/authentication/password_based%3Abuilt_in_database/users/{user_id}
POST   /api/v5/authorization/sources/built_in_database/rules/users  [{username,rules:[{topic,permission,action}]}]
PUT    /api/v5/authorization/sources/built_in_database/rules/users/{username}
DELETE /api/v5/authorization/sources/built_in_database/rules/users/{username}
POST   /api/v5/publish   {topic,payload,qos,retain:false}
GET    /api/v5/clients   (live connection count)
DELETE /api/v5/clients/{clientid}/authorization/cache
```

If an endpoint is unavailable on your deployment, `/api/device/claim` returns a clear 502 and **no device is registered**. Never replace isolation with a shared credential.

## 4. Cloudflare Workers configuration

`apps/api/wrangler.toml` defines `DB_DRIVER=supabase`, `MQTT_PROVIDER=emqx`, the Durable Object binding, the R2 binding and an hourly cron.

```bash
cd apps/api
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put SUPABASE_JWT_SECRET
wrangler secret put EMQX_API_BASE
wrangler secret put EMQX_APP_ID
wrangler secret put EMQX_APP_SECRET
wrangler secret put EMQX_BROKER_HOST
wrangler secret put EMQX_WSS_URL
wrangler secret put MQTT_BRIDGE_USERNAME
wrangler secret put MQTT_BRIDGE_PASSWORD
wrangler secret put INGRESS_HMAC_SECRET
wrangler secret put SECRETS_KEY      # 64-char hex, random
wrangler secret put PUBLIC_API_BASE  # https://api.example.com
wrangler deploy
```

Environment variable reference:

| Variable | Purpose | Secret |
|---|---|---|
| `SUPABASE_URL` | PostgREST/GoTrue base | no |
| `SUPABASE_ANON_KEY` | GoTrue signup/login from the Worker | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side DB writes | **yes** |
| `SUPABASE_JWT_SECRET` | Verify user JWTs | **yes** |
| `EMQX_API_BASE` | Deployment API `/api/v5` | no |
| `EMQX_APP_ID` / `EMQX_APP_SECRET` | Deployment API basic auth | **yes** |
| `EMQX_BROKER_HOST`, `EMQX_TLS_PORT`, `EMQX_WSS_URL` | Returned to firmware at pairing | no |
| `MQTT_BRIDGE_USERNAME` / `MQTT_BRIDGE_PASSWORD` | Durable Object ingress only | **yes** |
| `INGRESS_HMAC_SECRET` | Signs internal ingress events | **yes** |
| `SECRETS_KEY` | AES-256-GCM key for `platform_secrets`; also signs short-lived firmware download URLs | **yes** |
| `PUBLIC_API_BASE` | Absolute Worker URL in OTA commands | no |
| `FIRMWARE_BUCKET` | R2 binding (not an env var) | binding |

Start the ingress Durable Object after deploy:

```bash
curl -X POST "https://<worker>/internal/do/start"   # if exposed through your own admin route
# or rely on the hourly cron in wrangler.toml which calls /start
```

The owner console also stores non-secret endpoint/port settings in `platform_settings` and optional API credentials encrypted in `platform_secrets`; the Worker falls back to its environment when those rows are empty.

## 5. Cloudflare R2 firmware storage

```bash
wrangler r2 bucket create helios-firmware
# wrangler.toml binds it as FIRMWARE_BUCKET
```

The Worker stores binaries via the binding, verifies the SHA-256 digest from the upload, and serves them from `/api/firmware/download/<base64-key>` with an `X-Checksum` header. OTA commands carry the Worker URL + digest; the ESP32 verifies before writing and uses ESP-IDF rollback on failure. No public bucket, no presigned credential, no S3 keys in the browser.

## 6. Cloudflare Pages deployment

In Cloudflare Pages → Create project → Connect to Git:

| Setting | Value |
|---|---|
| Build command | `npm install && npm run build -w packages/core && npm run build -w apps/web` |
| Build output | `apps/web/dist` |
| Root directory | `/` |
| Node version | `20` |
| `VITE_API_BASE` | `https://<worker-domain>` (optional; same-origin `/api` proxy is preferred) |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | optional, for direct Supabase Realtime with the user's JWT |

For same-origin API calls, add a Pages Function/redirect proxy for `/api/*` → Worker, or deploy Pages and Worker on the same zone with a route. The app uses relative `/api` paths; browser code never calls `localhost`.

### Production build commands

```bash
npm ci
npm run build                  # core + web + api typecheck/build
npm test                       # acceptance tests
npm run build -w apps/web      # Pages artifact: apps/web/dist
cd apps/api && wrangler deploy # Worker artifact
```

## 7. GitHub deployment workflow

`.github/workflows/deploy.yml` runs install → typecheck → tests → web build → Worker deploy → Pages deploy on pushes to `main`. It uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Migrations are applied manually via `supabase db push` (change-controlled) or by enabling the commented migration step with `SUPABASE_ACCESS_TOKEN`.

## 8. Post-deployment testing

Run in order (see `docs/TESTING.md` for the automated suite):

1. `GET /api/health` → `{"ok":true,...}` with `provider:"emqx"`.
2. Sign up two accounts. Account A cannot read Account B's rooms/boards (`GET /api/rooms`, `/api/boards`).
3. Owner login → `/api/owner/overview`, `/api/owner/emqx/settings` (secrets masked), `/api/owner/usage` (unavailable states honest).
4. Owner → **EMQX Management → Test connection**; verify `connected: true`.
5. Customer → **Device Setup Wizard**: select a verified board, generate a token, claim a device (firmware or `npm run sim -- <token>`).
6. Verify the board appears online, config sync `Synced`, and MQTT ACL rejects a wrong topic (use a test client with the device credentials).
7. Create a room + device on GPIO 5; attempt a second device on GPIO 5 → conflict. Delete the first → GPIO 5 available again.
8. Toggle the switch: observe `requested` then `confirmed` only after the ESP32 ack; check `device_commands.status = acknowledged`.
9. Create a sensor; wait for telemetry; verify `sensor_readings` rows and validation of a wrong unit/out-of-range value.
10. Invite a Viewer; verify control is denied; revoke and verify access stops immediately.
11. Publish a firmware release and start an OTA; verify SHA-256 and rollback reporting.
12. Production build, migration replay, all routes load, no broken CSS, no fake data.

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| `401 Session expired or invalid` | `SUPABASE_JWT_SECRET` matches the Supabase project; token not expired |
| `No active home workspace` | `handle_new_user` trigger created the tenant + owner membership |
| Owner routes `403` even for owner | `platform_admins` row inserted for the profile id |
| Pairing returns 502 | `EMQX_API_BASE`, AppID/AppSecret, built-in-DB authenticator + authorization enabled; check Deployment API response in Worker logs |
| Device connects but no telemetry | Durable Object `/status`, WSS URL, bridge ACL, `INGRESS_HMAC_SECRET`, topic tenant/device match |
| Command stays "published" | Device subscribed to `command`, command not expired, ack published on `state`; check `device_commands` |
| Config stuck "Pending sync" | Device received config on `config`, ack with `type:"config_ack", status:"applied"` on `state` |
| Usage shows "Unavailable" | Expected. Enter owner-verified console values or sync live connection counts |
| Pages `/api` 404 | Pages → Worker proxy/route not configured |
| RLS leaks | Re-run `0006_rls.sql`, verify `relrowsecurity`, ensure client uses the user's JWT not the service role |

## 10. Credential rotation

| Credential | Procedure |
|---|---|
| Supabase service role / JWT secret | Rotate in Supabase → update Worker secrets → redeploy Worker |
| EMQX AppID/AppSecret | Create a new application in EMQX Cloud → `wrangler secret put` → verify **EMQX Management → Test connection** → delete old application |
| Platform ingress bridge | Create a new built-in-DB user + subscribe-only ACL → update Worker secrets → restart DO (`/stop` then `/start`) → delete old user |
| Single device credential | Customer console → Controllers → Rotate credentials; update firmware/NVS. Old password stops working immediately |
| `SECRETS_KEY` | Do **not** rotate while encrypted rows exist; decrypt with the old key and re-seal with the new key in a maintenance window |
| `INGRESS_HMAC_SECRET` | Update Worker + any external EMQX rule/webhook signer simultaneously; existing firmware URLs signed with the fallback are invalidated |

All owner actions are recorded in `audit_logs`.

## 11. Backup and recovery

- Enable Supabase Point-in-Time Recovery / daily backups; test a restore into a staging project quarterly.
- **Settings → Export data** in the Customer Home Console produces a JSON of tenant records (no credentials).
- Firmware binaries are immutable in R2; keep the `firmware_releases` registry + SHA-256 digests with the DB backup.
- Pin allocation is recoverable from `exclusive_allocations` + `board_pins`; do not hand-edit these tables — use the domain RPCs.
- Pairing tokens cannot be recovered (only hashes are stored); issue a new token.
- On EMQX migration to self-hosted EMQX/Mosquitto: implement a new `MqttProvider`, export device credential metadata, recreate per-device users/ACLs, then switch `MQTT_PROVIDER`. Application, firmware topic contract and UI do not change.
