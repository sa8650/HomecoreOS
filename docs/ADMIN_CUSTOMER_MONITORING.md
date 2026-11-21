# Admin Customer Board & Device Monitoring

Read-only customer inspection for Platform Admins. An admin opens
**Users & Staff → Customer Accounts → Details** and sees one customer's complete
board inventory, firmware state, connected devices/sensors/switches, and
environment health on a dedicated page.

> **Monitoring only.** Admins observe and diagnose. The page never controls
> customer hardware: no power toggles, brightness sliders, configuration
> editors, restart buttons, firmware installation, MQTT publishes, or EMQX
> calls. Every Worker route below is `GET`, and the loaders in
> `apps/worker/src/lib/customer-monitoring.ts` only issue `SELECT`s.

## Where it lives

| Layer | Location |
| --- | --- |
| Page | `apps/web/src/features/admin/AdminCustomerDetailsPage.tsx` (`AdminCustomerDetailsPage`, `BoardDetailsDialog`) |
| Route | `/admin/accounts/:id` — matched in `apps/web/src/App.tsx`, highlights *Users & Staff* |
| Entry point | Details button in the Customer Accounts table (`AdminAccountsAndBoardsPages.tsx`) |
| API | `apps/worker/src/routes/admin.ts` — `GET /api/admin/accounts/:id/monitoring` and friends |
| Logic | `apps/worker/src/lib/customer-monitoring.ts` — health engine + loaders |

The Details button is visible to every admin role, including read-only
`support`, because the page exposes no write actions. Pause / Reactivate /
Delete on the same table row remain gated by `canManageAccounts` /
`isSuperAdmin` exactly as before.

## API endpoints

All routes sit behind the existing `requireAdminSession()` guard for
`/accounts` and `/accounts/*`, so authentication, admin-role checks, and session
handling are unchanged.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/admin/accounts/:id/monitoring?page=&pageSize=` | Customer overview, summary counts, environment health, paginated board inventory |
| GET | `/api/admin/accounts/:id/boards/:boardId` | One board with full detail, firmware history, recent activity, attached nodes, parent controller, sensor compatibility |
| GET | `/api/admin/accounts/:id/boards/:boardId/devices?page=&pageSize=` | Paginated devices on that board |
| GET | `/api/admin/accounts/:id/boards/:boardId/sensors?page=&pageSize=` | Paginated sensors on that board |
| GET | `/api/admin/accounts/:id/boards/:boardId/switches?page=&pageSize=` | Paginated switches on that board |

Ownership is enforced in SQL, not in the UI: the board lookup filters on
`account_id = :id`, so a `boardId` belonging to another customer returns
`404 Board not found for this customer account.` Board entity queries resolve
the board through the same account-scoped lookup first. Soft-deleted boards
(`deleted_at` / `permanently_deleted_at`) are excluded everywhere.

Pagination defaults: 25 boards per page (max 100), 50 entities per page
(max 100).

## Data sources (no new tables)

The feature reuses existing tables and relationships only:
`board_instances`, `board_profiles` / `custom_board_profiles`, `homes`, `rooms`,
`devices`, `sensors`, `switches`, `firmware_releases` / firmware files,
`mqtt_credentials_metadata`, `controller_firmware_history` (via the firmware
route helpers), `activity_logs`, and `platform_settings` for heartbeat and
offline-timeout values.

Firmware update availability uses `checkControllerReleaseCompatibility()` and
sensor driver compatibility uses `getControllerSensorCompatibilityReport()` —
the same helpers the customer console uses — so admin verdicts never disagree
with what customers see.

### Query shape (no N+1)

`loadCustomerMonitoring()` runs a fixed number of statements regardless of how
many boards a customer owns:

1. Account + owner lookup, platform health settings.
2. Head counts for boards (total/online/controllers/nodes), devices, sensors,
   switches; latest sync/heartbeat/communication timestamps.
3. One `board_instances` select for all of the customer's boards, then **batched**
   enrichment: profile catalog rows, custom profiles, rooms, homes, MQTT
   credentials, firmware releases, and parent/attached-node links are each
   fetched with a single `in(...)` query and joined in memory.
4. One grouped read of devices, sensors, and switches per board.

Boards per account are bounded by `platform_settings.max_board_instances_per_account`
(default 25, hard max 500), so enriching every board is cheap and lets the
customer-level verdict reflect **all** boards rather than just the visible page.
The inventory itself is paginated before serialization. No polling, no
subscriptions, and no EMQX traffic is introduced by monitoring.

## Environment health rules

Health is computed per board from recorded telemetry — never from mere
existence. Each board gets one of:

* **Healthy** — status `online`, a heartbeat within the offline timeout, plus no
  warnings. `reasons` is empty only in this case.
* **Warning** — degraded/transitional, or online with warnings (mixed state).
* **Offline** — recorded `offline` / `disconnected`, or a heartbeat older than
  the offline timeout, or revoked MQTT credentials.
* **Unknown** — telemetry unavailable: a board marked `online` with no heartbeat
  or communication timestamps, an unrecognised status, or an unpaired board that
  never reported. *Unknown is deliberately distinct from Offline*: it means "we
  cannot tell", not "it is down".

Thresholds come from `platform_settings` (`controller_offline_timeout_seconds`,
default `180`; heartbeat interval default `30`). Sensors count as stale after
`max(15 min, 5 × offline timeout)`.

Warnings that degrade Healthy → Warning:

* MQTT not connected, or MQTT credentials revoked.
* Wi-Fi not connected.
* Pending configuration sync (board has not acknowledged the latest revision).
* A board error recorded within the last 24 hours.
* Firmware version never reported, or a compatible firmware update available.
* Node role with a lost / reconnecting / unassigned / standalone controller link.
* Offline devices, offline or stale sensors, offline switches.

`computeCustomerHealth()` rolls the boards up: all healthy → **Healthy**, all
offline → **Offline**, all unknown → **Unknown**, empty inventory → **Unknown**,
anything mixed → **Warning**. A single degraded board can never be averaged away
into a green environment.

The UI shows the verdict badge together with its `reasons` list, so an admin can
see *why* a board is Warning instead of guessing, and it labels unavailable
telemetry explicitly ("No heartbeat or communication telemetry recorded").

## Page contents

**Customer overview** — name, email, account ID, account status, registration
date, plus summary cards for total boards, devices, sensors, switches, online and
offline boards, controllers/nodes, and last sync / heartbeat / activity times.

**Board inventory** — paginated table: name, board ID, model/hardware, firmware
version and release channel, status, last online / last sync, device–sensor–switch
counts, room/location, and a **View Details** action.

**Board details dialog (read-only)** — tabs for Overview, Devices, Sensors,
Switches, and Firmware & Activity. Shows hardware snapshot, firmware/OTA state,
MQTT/Wi-Fi recorded state, configuration revisions, health reasons, firmware
history, recent activity, attached nodes/parent controller, and paginated entity
lists. Nothing in the dialog is interactive beyond tab/page navigation.

**States** — loading skeletons while fetching, a per-section error banner with
Retry, and explicit empty states ("No boards registered", empty entity tabs).

## Tests

* `apps/worker/test/admin-customer-monitoring.test.ts` — health-rule unit tests
  (never-Healthy-without-telemetry, stale heartbeat, transitional states,
  warnings, customer rollup) plus API integration tests: auth required, counts,
  cross-customer isolation, pagination, board detail/entities, read-only route
  surface, and rejection of customer sessions.
* `apps/web/src/features/admin/AdminCustomerDetailsPage.test.tsx` — overview and
  inventory rendering, read-only board dialog, empty/error states, Details-button
  navigation, and Details visibility for read-only support admins.
