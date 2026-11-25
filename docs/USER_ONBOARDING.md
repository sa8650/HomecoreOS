# Mandatory Four-Step User Onboarding

Every newly registered HomecoreOS customer is introduced to the platform through the same four
steps before the dashboard unlocks. This document is the reference for the rules, the persistence
model and the automated coverage.

```text
register ──► /onboarding (step 1) ──Next──► step 2 ──Next──► step 3 ──Next──► step 4 ──Get Started──► dashboard
                    ▲                            │                                                     │
                    └──────── refresh / sign out / new tab: resume from the stored step ───────────────┘
```

## 1. Rules

| Rule | How it is enforced |
|---|---|
| Onboarding appears immediately after a new account is created | `POST /api/auth/register` returns `onboarding.required = true`, `App.tsx` renders the tour before the console shell |
| All four steps are compulsory | No Skip, Close, dismiss or "later" control exists; `App.tsx` has no dashboard branch while `onboarding.required` is true |
| Back and Next only, one step at a time | `canAdvanceOnboarding(from, to)` only accepts `from + 1`; the card renders exactly one Next control and a single Back control |
| Get Started only on step 4 | `Onboarding.Navigation` swaps Next for `Get Started` on the last step |
| Completion is stored on the account | `users.onboarding_completed_at` + `users.onboarding_step` (migration `0003_user_onboarding.sql`), not local storage |
| Refresh / reopen resumes the last step | `GET /api/auth/me` returns the stored step, the tour mounts on it, and every step change is `PUT /api/auth/onboarding` |
| Dashboard routes are protected | `App.tsx` redirects any customer path to `/onboarding` while the server says onboarding is required |
| Existing users are never interrupted | The migration backfills `onboarding_completed_at` for every user that already existed |
| Signing out never completes onboarding | `POST /api/auth/logout` only revokes the session; completion needs `POST /api/auth/onboarding/complete` |

A Node never enters the picture here: onboarding is purely the account-level product tour. No ESP-NOW,
MQTT, provisioning or OTA behaviour changes.

## 2. API

| Route | Purpose |
|---|---|
| `GET /api/auth/me` | Adds `onboarding: { required, step, completedAt, startedAt }` |
| `GET /api/auth/onboarding` | Reads the persisted state |
| `PUT /api/auth/onboarding` | `{ "step": 1..4 }` — saves the step the user is looking at (Back included); rejects other values with `400 INVALID_ONBOARDING_STEP` |
| `POST /api/auth/onboarding/complete` | Sets step 4 + `onboarding_completed_at` once, writes `account.onboarding_completed` to Activity, and is idempotent |

Registration and login responses also carry `onboarding`, so the console can route on the first
render without an extra round trip.

## 3. Database

`database/migrations/0003_user_onboarding.sql`:

| Column | Type | Notes |
|---|---|---|
| `onboarding_step` | `smallint NOT NULL DEFAULT 1` | CHECK 1..4 |
| `onboarding_started_at` | `timestamptz` | First time the user moved past step 1 |
| `onboarding_completed_at` | `timestamptz` | `NULL` = dashboard locked; CHECK only allows it when the step is 4 |

Partial index `idx_users_onboarding_pending (user_kind, onboarding_step)` covers the "who is still
onboarding" query. `npm run db:verify` replays every numbered migration into a clean database and
fingerprints the result.

## 4. UI

`apps/web/src/features/onboarding/UserOnboardingPage.tsx` is built on the Cult UI `Onboarding`
primitive (`Onboarding`, `Onboarding.Step`, `Onboarding.Header`, `Onboarding.StepIndicator`,
`Onboarding.Navigation`) with custom SVG art in `OnboardingArt.tsx`:

| Step | Title | Art |
|---|---|---|
| 1 | Welcome to Your Smart Home | House cutaway with rooms, devices and a dashboard card |
| 2 | Connect Your Hardware | Sensor / switch / relay → Node → home Wi-Fi → HomecoreOS |
| 3 | Control and Automate Your Home | Dashboard of room cards plus a motion → condition → light flow |
| 4 | Monitor, Manage and Expand | Three healthy Nodes, Activity feed, "add another Node" |

The layout is a two-column tour on desktop (`lg:grid-cols-[1.05fr_1fr]`), a single column on
tablet and mobile, with the progress rail, save indicator, Back/Next (or Get Started) and sign-out
always visible. Progress is saved automatically on every step change; a failed save shows an
inline alert with **Try again** and never marks the step as completed locally.

## 5. Automated coverage

| Where | What |
|---|---|
| `apps/worker/test/onboarding.test.ts` | 8 tests: register starts at step 1, DB persistence, Back saves, refresh resumes, sign-out/login resumes without completing, completion is idempotent + audited, legacy users stay completed, full register-to-completion journey, all routes require a session |
| `apps/web/src/features/onboarding/user-onboarding.test.tsx` | 8 tests: step 1 + indicator, no skip/close/dismiss, forward-only navigation with persistence, Back, resume from stored step, Get Started completes, failure keeps the tour open, sign-out does not complete |
| `apps/web/src/App.test.tsx` | Route protection: `/devices` for a new account renders onboarding at `/onboarding`, completed accounts go straight to the console |
| `packages/shared/test/user-onboarding.test.ts` | Contract: four steps, required/resolved states, normalization, one-step-at-a-time |

## 6. Physical / manual checks

Automated tests cannot open a browser or reach Supabase from CI. The remaining manual pass is:
register a real account, walk the four steps, refresh mid-tour, try a deep link, sign out and back
in, then complete and confirm the dashboard opens once and never again.
