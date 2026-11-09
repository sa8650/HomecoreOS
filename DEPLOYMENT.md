# Deploy HomecoreOS — web dashboards only

You need four accounts: **GitHub**, **Cloudflare**, **Supabase**, **EMQX Cloud**. Every step below is done in a browser. No PC terminal, no CLI and no local tools.

The database is **Supabase PostgreSQL** (Supabase Auth is not used). Firmware binaries go into a **private Cloudflare R2 bucket** attached to the Pages project as the native **`FIRMWARE_BUCKET` binding**. Devices connect to **EMQX Cloud Serverless** over TLS on port **8883**.

There are **no R2 API keys and no `R2_…` secrets**. The binding is configured once in the Cloudflare dashboard and is available to the Pages Function at runtime; nothing about it is sent to the browser.

---

## 1. Put the code on GitHub

1. Open this repository on GitHub and choose **Fork** (or **Use this template**).
2. Keep the default branch name **main**.
3. Keep the GitHub → Cloudflare Pages connection. Cloudflare builds and deploys the website automatically on every push. The only GitHub Actions workflow in this repository is **Firmware**, and it only compiles the controller firmware and publishes a release ZIP — it never deploys the website and needs **no deployment secrets**.
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

## 4. Cloudflare R2 — private bucket + native binding (exact beginner steps)

This is a **bucket plus a Pages binding**. No R2 API token, no Access Key ID, no Secret Access Key, no Account ID and no S3 endpoint are needed anywhere.

### 4.1 Create the private bucket

1. In the Cloudflare dashboard, open **R2 Object Storage** in the left sidebar. If this is your first time, choose **Get started / Enable R2** and confirm the plan (there is a free allowance; a card may be required to enable the service).
2. Choose **Create bucket**.
3. **Bucket name**: type `homecoreos-firmware` (you may choose another lowercase name; remember it exactly).
4. **Location**: choose **Automatic** or the region closest to you.
5. Click **Create bucket**.
6. Open the bucket → **Settings**. Under **Public access / R2.dev subdomain**, make sure public access is **disabled**. Keep the bucket private: no public URL, no custom domain and no CORS policy is needed.

### 4.2 Attach the bucket to the Pages project

1. Cloudflare dashboard → **Workers & Pages** → open your **Pages** project.
2. Open **Settings → Functions**.
3. Scroll to **R2 bucket bindings** and choose **Add binding**.
4. Set **Variable name** to exactly `FIRMWARE_BUCKET` (uppercase, with the underscore). `R2_BUCKET` is also accepted if you prefer that name.
5. Under **R2 bucket**, select the private `homecoreos-firmware` bucket you created. The bucket must belong to the same Cloudflare account as the Pages project.
6. Choose the **Production** environment and click **Save**.
7. Bindings are attached at deploy time, so redeploy once after saving (see section 7).

### 4.3 What the binding is used for

The Pages Function reads and writes the bucket through the native binding; no HTTP signing, S3 client or SDK is involved. The bucket stays private and browsers never receive a credential. Firmware downloads use a short-lived, signed URL served by the API, or an owner-authorised server-side download. The ESP32 verifies the SHA-256 checksum before installing. Metadata (name, version, size, checksum, status, board compatibility and update history) lives in Supabase PostgreSQL; only the binary lives in R2.

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

Go to your Pages project → **Settings → Environment variables** (shown as **Variables and Secrets**) → **Add variables**. Add these **seven** values to **Production**, choosing **Secret / Encrypt** for each so the value is stored encrypted and cannot be read back afterwards.

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

Add the **R2 bucket binding** from section 4.2 under **Settings → Functions → R2 bucket bindings**: `FIRMWARE_BUCKET` → your private bucket. That is the complete list.

**No `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` or `R2_ENDPOINT` value belongs here.** If you previously added any of those secrets, or a plain text variable called `R2_BUCKET`, delete them from **Settings → Environment variables**; they are ignored by the application. (`R2_BUCKET` is meaningful only as the *name of the binding* in section 4.2, not as a variable or secret.) Do not add an R2 API token either.

**No authentication secrets are added.** The password pepper is derived server-side from `SUPABASE_SERVICE_ROLE_KEY`; session secrets are random and stored only as hashes in the database. If you ever rotate the Supabase service-role key, existing passwords must be reset with recovery codes or from **Owner Console → Authentication & security**.

Only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are required for the site to start. The five EMQX values enable devices; the `FIRMWARE_BUCKET` binding enables firmware upload to R2. **Never** add a `VITE_` variable for any of these and never put a service-role key in the website build. If the binding is not attached, the app falls back to private Supabase Storage for firmware and the Owner Console reports the binding as **missing** — it never claims a working R2 connection without a real round trip.

No D1 database binding, KV namespace or service binding is used. The Git integration stays connected and no deployment workflow or GitHub secret is used.

---

## 7. Redeploy and register the Platform Owner

1. Cloudflare Pages → **Deployments** → on the latest deployment choose **Retry deployment** (or simply push any change to GitHub). Do this **after** saving the R2 binding.
2. Wait for **Success**, then open the `*.pages.dev` URL.
3. Choose **Create account** and register with your email and a password of at least 10 characters. **The first successfully registered account becomes the Platform Owner** — the decision is made atomically inside one database transaction. Every later registration is a normal customer.
4. **Save the recovery codes** shown once after registration. They are the only way to regain access without the Owner Console if you lose your password.
5. After continuing, the sidebar shows **Owner console**. Owner Console APIs are authorised from database roles/permissions on every request — a normal customer cannot reach them by typing the URL.
6. Go to **Setup status** in the Owner Console. All checks should be **Ready**, including **Firmware storage ready**. The **Firmware storage binding** card shows **Binding present** when `FIRMWARE_BUCKET` is attached. Use **Test connection** (Supabase, EMQX) and **Test firmware upload & download** to confirm live connectivity. The firmware test performs a real upload, download, checksum verification and delete.
7. Open **Firmware management → Test R2 binding**. The status changes to **Verified** only when that real round trip succeeds. Until then the page shows **Not verified** or **R2 binding missing** — this is intentional, so you are never told storage is connected when it is not.
8. In **Owner Console → Authentication & security** you can change registration, sign-in limits, password policy, session lifetime and recovery-code policy; view accounts, active sessions, roles and security events; end a session; suspend an account; reset a password; and issue new recovery codes. Every value is enforced by the API and the database.

If a check is not ready: confirm the value in Cloudflare, then **redeploy** — Pages Functions read variables and bindings at deploy time.

---

## How to test firmware upload and device connection

### Step 1 — Build the firmware (GitHub, in the browser)

You do not compile anything yourself. GitHub does it for you.

1. Open the repository on GitHub and click the **Actions** tab.
2. In the left list click **Firmware**, then click **Run workflow** on the right.
3. Fill in:
   - **Release version** — the version the controller will report, for example `1.3.0`. Use only letters, digits, dots, dashes or plus signs.
   - **Channel** — `stable` for customers, `beta` or `dev` for testing.
   - **Mark the GitHub release as a pre-release** — leave off for a normal release.
4. Click **Run workflow** and wait. The run takes about 5–8 minutes and shows these steps: *Generate the build header*, *Install the ESP32 core*, *Compile the controller image*, *Build the release package*, *Verify the package the way the server will*.
5. When the run is green, open the finished run and download **`homecoreos-<version>.zip`** from the **Artifacts** box at the bottom. The same ZIP is also attached to the release on the **Releases** page of the repository.

If a step fails, the run page shows the exact line. Nothing has been published at that point — a failed build cannot reach a customer.

### Step 2 — Upload the release package (Owner Console, in the browser)

1. Open **Owner Console → Firmware management → Test storage**. Wait for the green result. If it fails, confirm the `FIRMWARE_BUCKET` binding is attached to **Production**, that the bucket still exists, then redeploy Pages.
2. Click **Upload release package** and choose the ZIP you downloaded. Do not unzip it and do not rename anything inside it.
3. Fill in, or leave the defaults:
   - **Channel** — `stable` for customers.
   - **After upload** — **Save as draft** (recommended the first time) or **Publish now**.
   - **Compatible controller models** — leave empty to use the models from `manifest.json`.
   - **Notes for this upload** — optional, shown to customers.
4. Click **Upload and validate** and read the checklist. Every line is a real server-side check:

   | Check | What it proves |
   | --- | --- |
   | manifest.json is readable JSON | The archive is intact and from this project |
   | OTA application image | The image is a real ESP32-S3 application build |
   | USB factory image | Bootloader, partition table and application are at the right offsets |
   | Checksums match the files | Nothing was altered after the build |
   | Board compatibility | The models named exist in the board catalog |
   | Hardware configuration | The build is for 16 MB flash |

5. If every check passes, the release is stored and — when you chose it — published. If a check fails, the release is saved as a **draft** only and the dialog lists every reason. Fix the cause in a new build; never edit the ZIP by hand.

The ZIP holds two images, and the console keeps them apart:

- **OTA application image** (`…-app.bin`) — installed wirelessly by a paired controller, and over USB at `0x10000` on a controller that already runs HomecoreOS.
- **USB factory image** (`…-usb.bin`) — the whole flash layout from `0x0`, used for a first install or a recovery. It can **never** be sent as a wireless update; the server refuses that.

### Step 3 — Send it to controllers

1. Open the release and click **Assign**.
2. Tick the compatible controllers, or choose **all compatible controllers**, and send.
3. Each controller downloads the image over HTTPS from the private bucket, verifies the SHA-256, writes it to the inactive slot, reboots, and only reports success once it reconnects and states the new version.
4. **Update history** shows queued, downloading, installing, verifying, successful, failed and rolled-back results exactly as controllers report them. Nothing is simulated, and a failed report is never shown as a success.

### Step 4 — Managing releases

- **Edit** changes the name, description, version, channel or compatible boards. The binary never changes.
- **Publish / Archive** controls who can install it. Only a published release is offered.
- **Download** gives you the stored bytes back; the server re-verifies the checksum first.
- **Delete** removes metadata and the stored file. Type `DELETE` to confirm. A release with an update in progress cannot be deleted.

### Firmware integrity — no signing keys

Firmware releases are **not signed**, and no key has to be configured anywhere. Integrity
comes from the SHA-256 digest of every image:

- GitHub Actions computes the digest of each image and writes it into `manifest.json`
  and `SHA256SUMS.txt`;
- the Owner Console recomputes the digest from the uploaded bytes and refuses a package
  whose digest does not match;
- the controller recomputes the digest of the image it downloads before it boots it.

There is no `FW_SIGNING_KEY`, no `FW_SIGNING_PUBKEY`, no `HC_FW_PUBKEY` and no `.sig`
file. If you added any of those to GitHub, Cloudflare Pages or your environment, delete
them: nothing reads them.

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

## You DO need

- One private **Cloudflare R2 bucket** and its native **`FIRMWARE_BUCKET` binding** under **Settings → Functions → R2 bucket bindings**.
- Seven encrypted Cloudflare Pages secrets and `NODE_VERSION=20`.

## You do NOT need any of these

- Any `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` or `R2_ENDPOINT` variable, a plain text `R2_BUCKET` variable, any R2 API token, S3 endpoint, or AWS Signature Version 4 credential. (`R2_BUCKET` is only acceptable as the binding's variable name.)
- A Cloudflare **D1** database binding, a KV namespace or any other native binding.
- Supabase Auth, anon / publishable key, `SUPABASE_JWT_SECRET`, `SECRETS_KEY`, `JWT_SECRET`, `DB_DRIVER`, `PUBLIC_API_BASE`, redirect URLs or OAuth callbacks.
- Any Google / Firebase / Clerk / Auth0 / external OTP credentials, or any other third-party identity provider.
- Database connection strings, a public bucket URL, a public R2.dev subdomain, or frontend (`VITE_`) copies of secrets.
- GitHub Actions deployment secrets or a website deploy workflow. The one workflow (Firmware) only compiles firmware and publishes release artifacts; Cloudflare Pages deploys the site itself.

## Quick fixes

| Symptom | Fix |
| --- | --- |
| `Platform setup required` / `Missing required configuration` | Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Cloudflare, then redeploy. |
| `relation "app_users" does not exist` or `Enable the pgcrypto extension` | Enable **pgcrypto** under Supabase → Database → Extensions and run `supabase/schema.sql` once in the SQL Editor, then redeploy. |
| `relation "platform_settings" does not exist` or a missing firmware column | Run the current `supabase/schema.sql` once in the Supabase SQL Editor. It is safe to re-run. |
| `42P01: relation "public.app_user_credentials" does not exist` | An older `supabase/schema.sql` created that table, dropped it, and then tried to enable row level security on it. It no longer references it after the drop. Run the current `supabase/schema.sql` once — it completes and enables RLS on all 49 tables. |
| Firmware upload returns `23502` / `Supabase 400` | The version of the site is older than the current schema. Run `supabase/schema.sql`, then redeploy so the uploader and the table agree. A `23502` reply now deletes the images it had already stored, so nothing is left orphaned. |
| `null value in column "flash_offset"` | Fixed. `flash_offset` is now `NOT NULL` and set from the artifact kind: `65536` (`0x10000`) for an application image, `0` for a factory image. Run `supabase/schema.sql` once — it repairs existing rows to the correct offset before applying the constraint — then redeploy. |
| A release uploaded but no controller is offered it | A release must name at least one controller model. Re-upload and pick the models in the dialog; the current uploader refuses to publish a release that would be offered to nobody. |
| `Too many attempts` on sign-in | Wait for the lockout window, or use **Owner Console → Authentication & security → Clear lockouts**. |
| `This account needs a password reset` | Use a recovery code, or ask the Platform Owner to reset the password from **Owner Console → Authentication & security**. |
| Session expired / repeated sign-in prompts | The absolute and idle session lifetimes are configurable under **Owner Console → Authentication & security**. |
| EMQX check fails with 401/403 | Recreate the Deployment API Key (the App Secret cannot be retrieved), verify App ID/Secret, and confirm `EMQX_API_BASE` ends with `/api/v5`. |
| Owner Console says **R2 binding missing** | Add `FIRMWARE_BUCKET` under **Settings → Functions → R2 bucket bindings** for **Production**, select the private bucket, **Save**, then redeploy. A binding added to Preview only will not affect the live site. |
| Firmware test fails with a missing-object or permission error | Confirm the bucket still exists in the same Cloudflare account, that its name is selected in the binding, and that the binding is attached to the deployed environment. Redeploy, then test again. |
| Firmware upload says storage is not configured | Attach the `FIRMWARE_BUCKET` binding and redeploy, or use the private Supabase Storage fallback. The console will still report the binding as **missing** until the round-trip test passes. |
| Storage test passes but a package upload fails | Read the checklist in the dialog. The usual causes are a still-zipped folder instead of the release ZIP, a version that already exists on that channel, or an edited file whose checksum no longer matches `manifest.json`. |
| The dialog says the checksum does not match | The ZIP was modified after GitHub Actions built it, or it was uploaded from somewhere other than the build. Download the release again from GitHub Actions and upload it unchanged. |
| A controller stays on the old version after an update | Open the controller's update history: it shows the stage that failed and the reason the controller itself reported. A controller that cannot reconnect on the new image returns to the previous one by design. |
| Devices cannot connect | Use the bare broker hostname and port `8883`, with TLS enabled. No `mqtts://` prefix in `EMQX_BROKER_HOST`. |
