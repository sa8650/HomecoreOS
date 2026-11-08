# Deploy HomecoreOS — web dashboards only

You need four free-start accounts: **GitHub**, **Cloudflare**, **Supabase**, **EMQX Cloud**. Everything below is done in a browser. No terminal, no CLI, no local tools, no Cloudflare bindings.

The database is **Supabase**. Firmware files go into a private **Supabase Storage** bucket that the app creates for you. Devices connect to **EMQX Cloud Serverless** over TLS on port **8883**.

---

## 1. Put the code on GitHub

1. Open this repository on GitHub and choose **Fork** (or **Use this template**).
2. Keep the default branch name **main**.
3. Nothing else is needed here. The file `.github/workflows/deploy.yml` runs checks on every push; it does **not** deploy, and it needs **no GitHub Secrets**.

---

## 2. Supabase — database, auth and file storage

1. In Supabase, choose **New project**, set a database password, and wait for it to finish.
2. Open **SQL Editor → New query**. On GitHub, open `supabase/schema.sql`, click **Raw**, and copy **the whole file**. Paste it into the SQL Editor and click **Run** once. This creates all tables, roles, policies, functions and the board catalog.
3. Open **Project Settings → API Keys** (the **Connect** dialog also shows the URL):
   - **Project URL** → this is `SUPABASE_URL`, shaped like `https://xxxxxxxxxxxx.supabase.co`.
   - **service_role** key → this is `SUPABASE_SERVICE_ROLE_KEY`. Use the legacy `service_role` JWT if it is shown; the newer `sb_secret_…` secret key also works.
4. You do **not** need the anon / publishable key, a JWT secret, a database URL, or any Storage setup. The private `firmware` bucket is created automatically on first use, and the service-role key is only ever used on the server.

---

## 3. EMQX Cloud — Serverless messaging

1. Create an EMQX Cloud account, then choose **New Deployment → Serverless** (select the free/closest region) and wait until it is **Running**.
2. On the deployment **Overview** page, find the **MQTT connection information**:
   - **Broker address / hostname** (host only, no `mqtts://` and no port) → `EMQX_BROKER_HOST`.
   - TLS port → `EMQX_TLS_PORT` = **8883**.
3. On the same **Overview** page open **Deployment API Key → + New API Key**:
   - **App ID** → `EMQX_APP_ID`.
   - **App Secret** → `EMQX_APP_SECRET`. It is shown **only once** — copy it immediately into Cloudflare.
   - The **API endpoint** shown there → `EMQX_API_BASE`. It must end in `/api/v5` (for example `https://your-deployment-endpoint/api/v5`) with no trailing slash.
4. These API credentials are **not** MQTT device usernames/passwords. The app creates one built-in-database user and ACL rule per device. They are never sent to the browser.

---

## 4. Cloudflare Pages — exact project settings

1. Cloudflare dashboard → **Workers & Pages → Create application → Pages → Connect to Git** → choose GitHub and your forked repository → **Begin setup**.
2. Fill in **Set up builds and deployments** exactly like this:

| Field | Exact value |
| --- | --- |
| Project name | anything you like, e.g. `homecoreos` |
| Production branch | `main` |
| Framework preset | **None** |
| **Root directory** | leave **blank** (or `/`) — `package.json` and `functions/` are in the repository root |
| **Build command** | `npm run build` |
| **Build output directory** | `apps/web/dist` |
| **Build comments** | **Off / disabled** — GitHub Actions already reports checks, so Cloudflare PR comments are unnecessary. If the option is not shown during setup, find it later under **Settings → Builds & deployments** |

3. Click **Save and Deploy**. The first deploy may fail until the variables below are added; that is expected.

---

## 5. Cloudflare Pages — Variables and Secrets

Go to your Pages project → **Settings → Environment variables** (shown as **Variables and Secrets**) → **Add variables**. Add these to **Production**. Use the **Secret / Encrypt** option for all seven values so they are stored encrypted and cannot be read back.

| Name | Value comes from | Type |
| --- | --- | --- |
| `SUPABASE_URL` | Supabase → Project Settings → API / Connect | Secret |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → `service_role` | Secret |
| `EMQX_API_BASE` | EMQX → Deployment Overview → Deployment API endpoint, ending `/api/v5` | Secret |
| `EMQX_APP_ID` | EMQX → Deployment API Key → App ID | Secret |
| `EMQX_APP_SECRET` | EMQX → Deployment API Key → App Secret (shown once) | Secret |
| `EMQX_BROKER_HOST` | EMQX → Deployment Overview → broker hostname | Secret |
| `EMQX_TLS_PORT` | `8883` | Secret |

Add one **plain** variable (not a secret — it is needed during the build):

| Name | Value |
| --- | --- |
| `NODE_VERSION` | `20` |

That is the complete list. Only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are required for the site to start; the five EMQX values enable devices. `EMQX_TLS_PORT` defaults to `8883` if omitted. **Never** add a `VITE_` variable for any of these.

---

## 6. Redeploy and check

1. Cloudflare Pages → **Deployments** → on the latest deployment choose **Retry deployment** (or simply push any change to GitHub).
2. Wait for **Success**, then open the `*.pages.dev` URL.
3. **Create your account** on that page. The first account becomes the **platform owner** — do this yourself, on your own URL.
4. Go to **Setup status** in the Owner Console. All five checks should be **Ready**. Use **Test connection** (Supabase, EMQX) and **Test firmware storage** to confirm live connectivity; the storage test performs a real upload/read/delete probe.

If a check is not ready: confirm the value in Cloudflare, then **redeploy** — Pages Functions read variables at deploy time.

---

## What the GitHub workflow does

`.github/workflows/deploy.yml` runs on pushes and pull requests to `main`: `npm ci`, `npm run typecheck`, `npm run build`, a Pages Functions bundle build, and a guard that rejects Node built-ins in that bundle. Cloudflare's own Git integration performs the deployment. You do **not** need `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` GitHub Secrets.

---

## You do NOT need any of these

- Cloudflare **D1** database, **R2** bucket, or any manual binding.
- `SUPABASE_ANON_KEY` / publishable key, `SUPABASE_JWT_SECRET`, `SECRETS_KEY`, `JWT_SECRET`, `INGRESS_HMAC_SECRET`, `DB_DRIVER`, `PUBLIC_API_BASE`.
- Any R2 access keys, database connection strings, or frontend (`VITE_`) copies of secrets.
- A PC terminal, Node.js installed locally, Wrangler CLI, or migration scripts.

## Quick fixes

| Symptom | Fix |
| --- | --- |
| `Platform setup required` / `Missing required configuration` | Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Cloudflare, then redeploy. |
| `relation "platform_settings" does not exist` | Run `supabase/schema.sql` once in the Supabase SQL Editor. |
| EMQX check fails with 401/403 | Recreate the Deployment API Key (the App Secret cannot be retrieved), verify App ID/Secret, and confirm `EMQX_API_BASE` ends with `/api/v5`. |
| Firmware storage test fails | Check that the service-role key is correct; Supabase Storage must be enabled for the project. |
| Devices cannot connect | Use the bare broker hostname and port `8883`, with TLS enabled. No `mqtts://` prefix in `EMQX_BROKER_HOST`. |
