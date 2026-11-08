# Deploy HomecoreOS — web dashboards only

You need four free-start accounts: **GitHub**, **Cloudflare**, **Supabase**, **EMQX Cloud**. Everything below is done in a browser. No PC terminal, no CLI, no local tools, no Cloudflare bindings.

The database is **Supabase** (PostgreSQL only — Supabase Auth is not used). Firmware files go into a private **Supabase Storage** bucket that the app creates for you. Devices connect to **EMQX Cloud Serverless** over TLS on port **8883**.

---

## 1. Put the code on GitHub

1. Open this repository on GitHub and choose **Fork** (or **Use this template**).
2. Keep the default branch name **main**.
3. Keep the GitHub → Cloudflare Pages connection. Cloudflare builds and deploys automatically on every push. There is no GitHub Actions workflow in this repository and **no GitHub deployment secrets are needed**.
4. If this repository was previously used with a deployment workflow, delete these now-obsolete GitHub secrets (repository files cannot delete secrets):

   | Obsolete secret | Why it is no longer needed |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | Was only used by the removed Wrangler/Actions deploy workflow. |
   | `CLOUDFLARE_ACCOUNT_ID` | Was only used by the removed Wrangler/Actions deploy workflow. |
   | Any other Wrangler/Actions-only variable (for example a Cloudflare zone or project API token) | Cloudflare's Git integration deploys on its own. |

   Exact deletion steps: open your repository on GitHub → **Settings** → in the left sidebar **Secrets and variables** → **Actions** → under **Repository secrets** find each name → click **Delete** → confirm. If you used **Environment secrets**, open **Settings → Environments → your environment → Environment secrets** and delete them there too. If they were stored at organisation level, open your organisation → **Settings → Secrets and variables → Actions → Organization secrets** → **Delete**. Do **not** disconnect GitHub from Cloudflare and do **not** add new GitHub secrets.

---

## 2. Supabase — database only (no Supabase Auth)

1. In Supabase, choose **New project**, set a database password, and wait for it to finish.
2. Open **SQL Editor → New query**. On GitHub, open `supabase/schema.sql`, click **Raw**, and copy **the whole file**. Paste it into the SQL Editor and click **Run** once. This creates all application tables plus the custom authentication tables (`app_users`, `app_sessions`, `app_roles`, `app_permissions`, `app_role_permissions`, `app_user_roles`, `app_recovery_codes`, `app_login_attempts`, `app_auth_config`), enables the `pgcrypto` extension for password hashing, installs the security-definer functions, and seeds the board catalog and default security limits.
3. The script is safe to re-run. On an existing project it copies any previous `app_user_credentials` rows into `app_users`, keeps the earliest account as the Platform Owner, and leaves all customer data untouched. Accounts whose old hash cannot be verified on Cloudflare are flagged for a password reset — the Platform Owner can set a new password or issue recovery codes from **Owner Console → Authentication → Accounts**.
4. Confirm **pgcrypto** is available: in the Supabase dashboard open **Database → Extensions** and check that **pgcrypto** is enabled. If extension creation was blocked, enable it there once and run `supabase/schema.sql` again. The Owner Console → **Setup status** and **Authentication** pages also report its status.
5. Open **Project Settings → API Keys** (the **Connect** dialog also shows the URL):
   - **Project URL** → this is `SUPABASE_URL`, shaped like `https://xxxxxxxxxxxx.supabase.co`.
   - **service_role** key → this is `SUPABASE_SERVICE_ROLE_KEY`. Use the legacy `service_role` JWT if it is shown; the newer `sb_secret_…` secret key also works.
6. You do **not** need the anon / publishable key, a JWT secret, a database URL, an auth provider, redirect/callback URLs, or any Storage setup. The private `firmware` bucket is created automatically on first use, and the service-role key is only ever used on the server.

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
| **Build comments** | **Off / disabled** — no separate GitHub Actions checks are used. If the option is not shown during setup, find it later under **Settings → Builds & deployments** |

3. Click **Save and Deploy**. The first deploy may fail until the variables below are added; that is expected.

---

## 5. Cloudflare Pages — Variables and Secrets (complete list)

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

That is the complete list. **No authentication secrets are added.** The password pepper is derived server-side from `SUPABASE_SERVICE_ROLE_KEY`; session secrets are random and stored only as hashes in the database. If you ever rotate the Supabase service-role key, existing passwords must be reset with recovery codes or from **Owner Console → Authentication** (their hashes are peppered with a value derived from that key). Only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are required for the site to start; the five EMQX values enable devices. `EMQX_TLS_PORT` defaults to `8883` if omitted. **Never** add a `VITE_` variable for any of these, and never put the service-role key in the website build.

No D1 database, R2 bucket or other binding is required or added.

---

## 6. Redeploy and register the Platform Owner

1. Cloudflare Pages → **Deployments** → on the latest deployment choose **Retry deployment** (or simply push any change to GitHub).
2. Wait for **Success**, then open the `*.pages.dev` URL.
3. Choose **Create account** and register with your email and a password of at least 10 characters. **The first successfully registered account becomes the Platform Owner** — the decision is made atomically inside one database transaction, so simultaneous registrations cannot create two owners. Every later registration is a normal customer.
4. **Save the recovery codes** shown once after registration. They are the only way to regain access without the Owner Console if you lose your password.
5. After continuing, the sidebar shows **Owner console** (and **Authentication** under Governance). Owner Console APIs are authorized from database roles/permissions on every request — a normal customer cannot reach them by typing the URL.
6. Go to **Setup status** in the Owner Console. All six checks should be **Ready**, including **Custom authentication ready**. Use **Test connection** (Supabase, EMQX) and **Test firmware storage** to confirm live connectivity; the storage test performs a real upload/read/delete probe.
7. In **Owner Console → Authentication** you can change the login-attempt limit, lockout duration, session lifetime and idle timeout, view accounts and active sessions, suspend accounts, reset a password and issue new recovery codes.

If a check is not ready: confirm the value in Cloudflare, then **redeploy** — Pages Functions read variables at deploy time.

---

## Account recovery, without any third-party service

- A user who forgets a password clicks **Forgot password? Use a recovery code** on the sign-in page, enters their email, one unused code and a new password. The code is consumed atomically in the database and all existing sessions are revoked.
- Signed-in users can change their password and generate fresh codes from **Customer Console → Settings → Account security**.
- The Platform Owner can reset any account's password or generate new recovery codes from **Owner Console → Authentication**.

---

## You do NOT need any of these

- Cloudflare **D1** database, **R2** bucket, or any manual binding.
- Supabase Auth, anon / publishable key, `SUPABASE_JWT_SECRET`, `SECRETS_KEY`, `JWT_SECRET`, `INGRESS_HMAC_SECRET`, `DB_DRIVER`, `PUBLIC_API_BASE`, redirect URLs or OAuth callbacks.
- Any Google / Firebase / Clerk / Auth0 / external OTP credentials, or any other third-party identity provider.
- Any R2 access keys, database connection strings, or frontend (`VITE_`) copies of secrets.
- GitHub Actions deployment secrets, a deploy workflow, or any local Node.js / CLI tooling.

## Quick fixes

| Symptom | Fix |
| --- | --- |
| `Platform setup required` / `Missing required configuration` | Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Cloudflare, then redeploy. |
| `relation "app_users" does not exist` or `Enable the pgcrypto extension` | Enable **pgcrypto** under Supabase → Database → Extensions and run `supabase/schema.sql` once in the SQL Editor, then redeploy. |
| `relation "platform_settings" does not exist` | Run `supabase/schema.sql` once in the Supabase SQL Editor. |
| `Too many attempts` on sign-in | Wait for the lockout window, or use **Owner Console → Authentication → Clear lockouts**. |
| `This account needs a password reset` | Use a recovery code, or ask the Platform Owner to reset the password from **Owner Console → Authentication → Accounts**. |
| Session expired / repeated sign-in prompts | The absolute and idle session lifetimes are configurable under **Owner Console → Authentication**. |
| EMQX check fails with 401/403 | Recreate the Deployment API Key (the App Secret cannot be retrieved), verify App ID/Secret, and confirm `EMQX_API_BASE` ends with `/api/v5`. |
| Firmware storage test fails | Check that the service-role key is correct; Supabase Storage must be enabled for the project. |
| Devices cannot connect | Use the bare broker hostname and port `8883`, with TLS enabled. No `mqtts://` prefix in `EMQX_BROKER_HOST`. |
