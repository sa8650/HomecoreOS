# Owner guide — running HomecoreOS

This is the walkthrough for the **Platform Owner**: the first account registered on a fresh deployment. Every step is a click in the website. No terminal, no local tools.

The owner console lives at **`/owner`** after sign-in. Its sidebar entries are:

| Section | What it is for |
| --- | --- |
| **Overview** | Live state of the platform: accounts, homes, controllers, storage and broker health |
| **Customers** | Every home workspace, its controllers and its usage |
| **Staff & roles** | Who can sign in to the owner console and what they may do |
| **Broker (EMQX)** | Live connection test and the device-authentication self-check |
| **Firmware management** | Upload, validate, publish and assign firmware releases |
| **Board library** | Verified manufacturer pin maps, plus custom boards you add |
| **Platform settings** | Feature switches that the API and the database actually enforce |
| **Authentication & security** | Registration, sign-in limits, password policy, sessions, recovery codes, account actions |
| **Usage** | Counts and limits |
| **Audit log** | Every privileged action with who, when and what changed |

Deployment itself is covered in **[DEPLOYMENT.md](DEPLOYMENT.md)**; firmware in **[FIRMWARE_GUIDE.md](FIRMWARE_GUIDE.md)**; the customer side in **[USER_GUIDE.md](USER_GUIDE.md)**.

---

## 1. First sign-in

1. Open your Pages address, for example `https://homecoreos.pages.dev`.
2. Click **Create account** and register. **The first account to register becomes the Platform Owner.** Every later account is a normal customer with its own home workspace.
3. Save the recovery codes shown once at the end of registration. They are the only way back in if you lose your password and cannot sign in.
4. The sidebar now shows **Owner console**. The server checks your role in the database on every owner request, so a customer typing `/owner` gets nothing.

If you are already signed in as a customer and expect owner access, check **Authentication & security → Accounts** for the role on that account.

---

## 2. Check that the platform is wired up

Open **Setup status** (in the owner console) once after every deployment.

| Card | What it should say | If not |
| --- | --- | --- |
| Supabase PostgreSQL | **Ready** | Check `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Cloudflare Pages → Settings → Variables and Secrets, and that `supabase/schema.sql` was run once in the SQL editor |
| EMQX Cloud | **Ready** | Check the four EMQX values, then redeploy |
| Firmware storage binding | **Binding present** | Add the `FIRMWARE_BUCKET` native R2 binding under Settings → Functions → R2 bucket bindings for Production, then redeploy |
| Firmware storage test | **Connected** | Click **Test firmware upload & download**; it uploads, downloads, verifies and deletes a real object |

Two values are optional and are reported honestly when absent:

- **Firmware signing** (`FW_SIGNING_PUBKEY`) — without it the console says *signing key not configured* and never claims a signature was verified.
- **EMQX device authentication** — the **Broker** page has a self-check that proves, step by step, that the broker accepts a controller's own credentials and only its own topics.

---

## 3. The broker self-check

Open **Owner console → Broker (EMQX)** and click **Run device-authentication self-check**.

It performs four separate steps and reports each one:

| Step | What it proves |
| --- | --- |
| `api` | The EMQX management API answers with your App ID and secret |
| `provision` | A test controller identity can be created inside EMQX |
| `connect` | The broker accepts that controller's own username and password over TLS |
| `cleanup` | The test identity is removed again |

A step marked **failed** carries the broker's own words. This is a real check against your deployment, not an assumption — and it is exactly the mechanism controllers use when they pair.

---

## 4. Firmware management

The full procedure is in **[FIRMWARE_GUIDE.md](FIRMWARE_GUIDE.md)**. The short version:

1. GitHub → **Actions → Firmware → Run workflow** builds a release ZIP.
2. Download the ZIP from the finished run's **Artifacts**.
3. **Firmware management → Upload release package**, choose the ZIP, review the check-by-check report, then publish or keep it as a draft.
4. **Assign** the release to compatible controllers, or let each customer install it from their own **Firmware** page.

Two things are worth remembering:

- A **USB factory image** can never be sent as a wireless update; the server refuses it. Factory images are for a first install or a recovery over USB.
- A release only reaches a controller whose board model it supports. The **Assign** dialog shows compatibility, the installed version and the reason for any refusal.

---

## 5. Board library

Open **Owner console → Board library**.

- **Verified boards** have a pin map taken from the manufacturer's documentation. They are read-only, and their pin maps are never guessed or generated.
- **Pending boards** exist in the catalog but have no verified pin map. Their cards say *Pin map not verified* and show **no GPIO counts at all**, because a count would be a claim you cannot back up.
- **Custom boards** can be added with a name, manufacturer, ESP32 variant, description, image and pinout reference. Add GPIO rows one by one, marking input-only, bootstrapping, reserved, flash/PSRAM and unavailable pins, plus ADC/PWM/I²C/SPI/UART capabilities. The page rejects duplicate pins, out-of-range numbers and impossible capability combinations.

Pins become assignable to devices only after their board is verified, and a pin can only be used once.

---

## 6. Platform settings

Settings are grouped and written in plain language. **Only settings that the API and the database actually enforce are shown.** Each change is validated before it is saved, and sensitive changes ask for confirmation.

If you switch a feature off, the corresponding customer action fails with a clear message instead of silently doing nothing.

---

## 7. Authentication and security

| You can | Where |
| --- | --- |
| Turn registration on or off | **Authentication & security → Registration** |
| Set the password policy | **Authentication & security → Password policy** |
| Set sign-in attempt limits and lockout | **Authentication & security → Sign-in protection** |
| Set session lifetime and the per-account session limit | **Authentication & security → Sessions** |
| View accounts, suspend one, reset a password, issue new recovery codes | **Authentication & security → Accounts** |
| End any active session | **Authentication & security → Sessions** |
| Read the security-event history | **Authentication & security → Events** |

Notes that matter in practice:

- Suspending an account ends its sessions; it does not delete the home or its devices.
- Resetting a password or issuing recovery codes is audited with your account, the time and the target.
- The platform never stores a password in a form that can be read back, and nothing about authentication depends on a third-party identity service.

---

## 8. Customers, staff and audit

- **Customers** lists every home workspace with its controllers and usage. Open one to see its boards, devices and recent activity; you can suspend or archive a home from there.
- **Staff & roles** controls who has owner-console access and what each role may do. Give the smallest role that does the job.
- **Audit log** records every privileged action: actor, action, entity, and the before/after values where they apply. Firmware uploads, publishes, deletes, deployments and security changes all appear there.

---

## 9. What the owner console will not do

The owner console will not:

- claim a firmware release is verified when a check failed — it is stored as a draft with the reasons listed;
- report a storage round trip as verified when it did not happen;
- report a signature as valid when no key is configured;
- invent a pin map for a board that has none;
- install a release on a controller whose board model it does not support;
- delete a release while an update is running on a controller.

If a screen shows a problem, it is a real problem you can act on.
