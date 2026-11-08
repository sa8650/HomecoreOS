# Deploy HomecoreOS — web dashboards only

You need four accounts: **GitHub**, **Cloudflare**, **Supabase**, **EMQX Cloud**. Every step below is done in a browser. No PC terminal, no CLI, no local tools and no Cloudflare bindings.

The database is **Supabase PostgreSQL** (Supabase Auth is not used). Firmware binaries go into a **private Cloudflare R2 bucket**, reached with encrypted server-side S3 API credentials. Devices connect to **EMQX Cloud Serverless** over TLS on port **8883**.

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

   Exact deletion steps: open your repository on GitHub → **Settings** → in the left sidebar **Secrets and variables** → **Actions** → under **Repository secrets** find each name → click **Delete** → confirm. If you used **Environment secrets**, open **Settings → Environments → your environment → Environment secrets** and delete them there too. If they were stored at organisation level, open your organisation → **Settings → Secrets and variables → Actions → Organization secrets** → **Delete**. Do **not** disconnect GitHub from Cloudflare and do **not** add new GitHub secrets. The R2 keys described below go into **Cloudflare Pages**, not GitHub.

---

## 2. Supabase — database only (no Supabase Auth)

1. In Supabase, choose **New project**, set a database password, and wait for it to finish.
2. Open **SQL Editor → New query**. On GitHub, open `supabase/schema.sql`, click **Raw**, and copy **the whole file**. Paste it into the SQL Editor and click **Run** once. This creates all application tables, the custom authentication tables, the firmware metadata tables, the board catalog, and the security-definer functions. It also enables `pgcrypto` for password hashing and seeds the default security limits.
3. The script is safe to re-run. On an existing project it adds the new firmware, board-library and security-event columns/tables without deleting customer data.
4. Confirm **pgcrypto** is available: in Supabase open **Database → Extensions** and check that **pgcrypto** is enabled. If extension creation was blocked, enable it there once and run `supabase/schema.sql` again.
5. Open **Project Settings → API Keys** (the **Connect** dialog also shows the URL):
   - **Project URL** → `SUPABASE_URL`, shaped like `https://xxxxxxxxxxxx.supabase.co`.
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY`. The legacy `service_role` JWT or the newer `sb_secret_…` secret key both work.
6. You do **not** need the anon / publishable key, a JWT secret, a database URL, an auth provider, redirect/callback URLs, or Supabase Storage setup. The service-role key is only ever used on the server.

---

## 3. EMQX Cloud — Serverless messaging

1. Create an EMQX Cloud account, then choose **New Deployment → Serverless** and wait until it is **Running**.
2. On the deployment **Overview** page, find the **MQTT connection information**:
   - **Broker address / hostname** (host only, no `mqtts://` and no port) → `EMQX_BROKER_HOST`.
   - TLS port → `EMQX_TLS_PORT` = **8883**.
3. On the same **Overview** page open **Deployment API Key → + New API Key**:
   - **App ID** → `EMQX_APP_ID`.
   - **App Secret** → `EMQX_APP_SECRET`. It is shown **only once** — copy it immediately into Cloudflare.
   - The **API endpoint** shown there → `EMQX_API_BASE`. It must end in `/api/v5`, with no trailing slash.
4. These API credentials are **not** MQTT device usernames/passwords. The app creates one built-in-database user and ACL rule per device. They are never sent to the browser.

---

## 4. Cloudflare R2 — private firmware bucket (exact beginner steps)

This is a **bucket + API credentials**, not a Pages binding. Nothing here is added under "Functions → Bindings".

### 4.1 Create the private bucket

1. In the Cloudflare dashboard, open **R2 Object Storage** in the left sidebar. If this is your first time, choose **Get started / Enable R2** and confirm the plan (there is a free allowance; a card may be required to enable the service).
2. Choose **Create bucket**.
3. **Bucket name**: type `homecoreos-firmware` (you may choose another lowercase name; remember it exactly).
4. **Location**: choose **Automatic** or the region closest to you.
5. Click **Create bucket**.
6. Open the bucket → **Settings**. Under **Public access / R2.dev subdomain**, make sure public access is **disabled**. Keep the bucket private: no public URL, no custom domain, no CORS policy is needed.
7. While on the R2 overview page, note your **Account ID** (shown on the right side of the R2 overview, or under **Account Home**). This is `R2_ACCOUNT_ID`.

### 4.2 Create an R2 API token

1. On the **R2 Object Storage** overview page, choose **Manage R2 API tokens** (sometimes shown as **API tokens** or under **Account → R2 tokens**).
2. Choose **Create API token**.
3. Give it a name such as `HomecoreOS firmware`.
4. Set **Permissions** to **Object Read & Write** (also called **Edit**). Set **Specify bucket** / **Apply to** to **only `homecoreos-firmware`**. Do not choose "All buckets" and do not use an account-wide Admin token.
5. Leave TTL blank (or set a long expiry) and click **Create API Token**.
6. The next screen shows three values. Copy them now — the **Secret Access Key** is shown only once:
   - **Access Key ID** → `R2_ACCESS_KEY_ID`
   - **Secret Access Key** → `R2_SECRET_ACCESS_KEY`
   - The **S3 endpoint / Jurisdiction-specific endpoint** shown on the same page looks like `https://<account-id>.r2.cloudflarestorage.com`. You do **not** need to add it as a secret; the app builds that URL from your Account ID. (`R2_ENDPOINT` is an optional override for special cases only.)
7. Keep this browser tab open until the values are saved in Cloudflare Pages below.

### 4.3 What the secrets are used for

The Pages Function signs every R2 request with AWS Signature Version 4 using WebCrypto. The bucket stays private; browsers never receive a key. Firmware downloads use a short-lived, signed URL served by the API, or an owner-authorised server-side download. The ESP32 verifies the SHA-256 checksum before installing. Metadata (name, version, size, checksum, status, board compatibility and update history) lives in Supabase PostgreSQL; only the binary lives in R2.

---

## 5. Cloudflare Pages — exact project settings

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

## 6. Cloudflare Pages — Variables and Secrets (complete list)

Go to your Pages project → **Settings → Environment variables** (shown as **Variables and Secrets**) → **Add variables**. Add these to **Production**. For every value in the first table choose **Secret / Encrypt**, so the value is stored encrypted and cannot be read back afterwards.

| Name | Value comes from | Type |
| --- | --- | --- |
| `SUPABASE_URL` | Supabase → Project Settings → API / Connect | Secret |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → `service_role` | Secret |
| `EMQX_API_BASE` | EMQX → Deployment Overview → Deployment API endpoint, ending `/api/v5` | Secret |
| `EMQX_APP_ID` | EMQX → Deployment API Key → App ID | Secret |
| `EMQX_APP_SECRET` | EMQX → Deployment API Key → App Secret (shown once) | Secret |
| `EMQX_BROKER_HOST` | EMQX → Deployment Overview → broker hostname | Secret |
| `EMQX_TLS_PORT` | `8883` | Secret |
| `R2_ACCOUNT_ID` | Cloudflare → R2 Object Storage overview → Account ID | Secret |
| `R2_BUCKET` | `homecoreos-firmware` (the exact bucket name) | Secret |
| `R2_ACCESS_KEY_ID` | Cloudflare → R2 → Manage R2 API tokens → Access Key ID | Secret |
| `R2_SECRET_ACCESS_KEY` | Cloudflare → R2 → Manage R2 API tokens → Secret Access Key (shown once) | Secret |

Add one **plain** variable (not a secret — it is needed during the build):

| Name | Value |
| --- | --- |
| `NODE_VERSION` | `20` |

That is the complete list. **No authentication secrets are added.** The password pepper is derived server-side from `SUPABASE_SERVICE_ROLE_KEY`; session secrets are random and stored only as hashes in the database. If you ever rotate the Supabase service-role key, existing passwords must be reset with recovery codes or from **Owner Console → Authentication & security**.

Only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are required for the site to start. The five EMQX values enable devices; the four `R2_…` values enable firmware upload. **Never** add a `VITE_` variable for any of these and never put a service-role key or R2 key in the website build. If the four R2 values are not all present, the app falls back to private Supabase Storage for firmware and the Owner Console reports R2 as **not configured** — it never claims a working R2 connection without a test.

**Do not add any binding**: no D1 database binding, no R2 bucket binding, no KV or service binding. The Git integration stays connected and no deployment workflow or GitHub secret is used.

---

## 7. Redeploy and register the Platform Owner

1. Cloudflare Pages → **Deployments** → on the latest deployment choose **Retry deployment** (or simply push any change to GitHub).
2. Wait for **Success**, then open the `*.pages.dev` URL.
3. Choose **Create account** and register with your email and a password of at least 10 characters. **The first successfully registered account becomes the Platform Owner** — the decision is made atomically inside one database transaction. Every later registration is a normal customer.
4. **Save the recovery codes** shown once after registration. They are the only way to regain access without the Owner Console if you lose your password.
5. After continuing, the sidebar shows **Owner console**. Owner Console APIs are authorised from database roles/permissions on every request — a normal customer cannot reach them by typing the URL.
6. Go to **Setup status** in the Owner Console. All checks should be **Ready**, including **Firmware storage ready**. Use **Test connection** (Supabase, EMQX) and **Test firmware upload & download** to confirm live connectivity. The firmware test performs a real upload, download, checksum verification and delete.
7. Open **Firmware management → Test R2 connection**. The status changes to **Verified** only when that real round trip succeeds. Until then the page shows **Not verified** or **R2 not configured** — this is intentional, so you are never told storage is connected when it is not.
8. In **Owner Console → Authentication & security** you can change registration, sign-in limits, password policy, session lifetime and recovery-code policy; view accounts, active sessions, roles and security events; end a session; suspend an account; reset a password; and issue new recovery codes. Every value is enforced by the API and the database.

If a check is not ready: confirm the value in Cloudflare, then **redeploy** — Pages Functions read variables at deploy time.

---

## How to test firmware upload and device connection

### Firmware upload (Owner Console)

1. Open **Owner Console → Firmware management → Test R2 connection**. Wait for **Upload, download, checksum and delete verified against R2**. If it fails, check the four `R2_…` secrets and the token's bucket permission, then redeploy.
2. Choose **Upload firmware**. Pick a `.bin`, `.elf` or `.img` build (16 MB maximum), give it a name, a version and a short description, choose a channel, select the compatible ESP32 board models, and choose **Save as draft** or **Publish now**.
3. The website computes the SHA-256 checksum locally; the API decodes the file, checks its size, rejects unknown board models and duplicate versions, writes the binary to the private bucket, reads it back and verifies the checksum again before saving metadata. Only then does the release appear in the table with its size, upload date, checksum and status.
4. Use **Edit** to change the name, description, version, channel or compatible boards. Use **Publish / Unpublish / Archive** to control availability. Use **Download** for an owner-authorised server-side download (the API re-verifies the checksum before returning bytes).
5. In **Assign an update**, choose a published release, then tick the compatible controllers and send the update. Each controller receives a short-lived signed URL and verifies the checksum before installing. **Update history** shows queued, downloading, installing, verifying, successful and failed results as devices report them — nothing is simulated.
6. Use **Delete** on a release only when you want to remove both the metadata and the stored binary. Type `DELETE` to confirm. A release with an update in progress cannot be deleted.

### Device connection (Customer Console)

1. Open **Customer Console → Add a controller**. Choose your verified board model, give it a name, and follow the illustrated steps.
2. Power the controller, join its temporary `HomecoreOS-Setup-…` Wi-Fi network from a phone or laptop, and enter your home Wi-Fi password **on the controller's own setup page**. The website never sees your Wi-Fi password.
3. Create a one-time pairing code and paste it into the controller's setup page. The wizard polls the server every two seconds and shows real stages: code created, controller found, private identity registered, and controller online.
4. The **All set** success screen appears only after the controller actually reports `online` in the database. A timeout, expired code or failed check shows a failure state with **New code**, **Back** and **Cancel setup** — never a false success animation.
5. When supported by the firmware, the completion screen shows real detected chip model, revision, Wi-Fi address, firmware version, build and SDK version. Fields that the device did not report are labelled **Not reported**.
6. Open **Controllers** to see the new controller and its live status; then add switches, lights and sensors from **Devices**.

---

## Account recovery, without any third-party service

- A user who forgets a password clicks **Forgot password? Use a recovery code** on the sign-in page, enters their email, one unused code and a new password. The code is consumed atomically in the database and all existing sessions are revoked.
- Signed-in users can change their password and generate fresh codes from **Customer Console → Settings → Account security**.
- The Platform Owner can reset any account's password or generate new recovery codes from **Owner Console → Authentication & security → Accounts**.

---

## Appearance

Use **Appearance** in the top bar of either console to choose **Use system setting**, **Light theme** or **Dark theme**. The preference is stored only in that browser. Both themes use the same restrained blue accent, flat surfaces, tokenised spacing and the same components; animations respect the browser's reduced-motion setting.

---

## You do NOT need any of these

- Cloudflare **D1** database, an **R2 bucket binding**, a KV namespace, or any other native binding. (You *do* create an R2 **bucket** and four **encrypted secrets**, as described above — that is not a binding.)
- Supabase Auth, anon / publishable key, `SUPABASE_JWT_SECRET`, `SECRETS_KEY`, `JWT_SECRET`, `DB_DRIVER`, `PUBLIC_API_BASE`, redirect URLs or OAuth callbacks.
- Any Google / Firebase / Clerk / Auth0 / external OTP credentials, or any other third-party identity provider.
- Database connection strings, a public bucket URL, a public R2.dev subdomain, or frontend (`VITE_`) copies of secrets.
- GitHub Actions deployment secrets, a deploy workflow, or any local Node.js / CLI tooling.

## Quick fixes

| Symptom | Fix |
| --- | --- |
| `Platform setup required` / `Missing required configuration` | Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Cloudflare, then redeploy. |
| `relation "app_users" does not exist` or `Enable the pgcrypto extension` | Enable **pgcrypto** under Supabase → Database → Extensions and run `supabase/schema.sql` once in the SQL Editor, then redeploy. |
| `relation "platform_settings" does not exist` or a missing firmware column | Run the current `supabase/schema.sql` once in the Supabase SQL Editor. It is safe to re-run. |
| `Too many attempts` on sign-in | Wait for the lockout window, or use **Owner Console → Authentication & security → Clear lockouts**. |
| `This account needs a password reset` | Use a recovery code, or ask the Platform Owner to reset the password from **Owner Console → Authentication & security**. |
| Session expired / repeated sign-in prompts | The absolute and idle session lifetimes are configurable under **Owner Console → Authentication & security**. |
| EMQX check fails with 401/403 | Recreate the Deployment API Key (the App Secret cannot be retrieved), verify App ID/Secret, and confirm `EMQX_API_BASE` ends with `/api/v5`. |
| R2 test fails with `SignatureDoesNotMatch` / 403 | Re-check `R2_ACCESS_KEY_ID` and especially `R2_SECRET_ACCESS_KEY` (it is shown only once). Create a new R2 API token with **Object Read & Write** on this bucket if needed, redeploy, then test again. |
| R2 test fails with 404 / bucket not found | `R2_BUCKET` must match the bucket name exactly; `R2_ACCOUNT_ID` must be the account that owns the bucket. |
| Firmware upload says storage is not configured | Add all four `R2_…` encrypted secrets and redeploy, or use the private Supabase Storage fallback. The console will still report R2 as **not configured** until the round-trip test passes. |
| Firmware test passes but upload fails | Check the file extension (`.bin`, `.elf`, `.img`), the 16 MB limit, and that the version is not already used on that channel. |
| Devices cannot connect | Use the bare broker hostname and port `8883`, with TLS enabled. No `mqtts://` prefix in `EMQX_BROKER_HOST`. |
