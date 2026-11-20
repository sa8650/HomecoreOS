# Real-Time State Synchronization

Everything the console shows about hardware — switch and device state, sensor readings,
Controller/Node ONLINE-OFFLINE, OTA progress, automation execution results and the 2D floor
plan — is pushed to the browser. Pages do not poll for device state, and nobody has to
refresh or re-enter a page to see a change.

## Root cause this replaces

The browser had no push channel. Each page either fetched once on mount or ran its own
interval (`Overview` every 10 s, `My Boards` pairing every 3 s, `Firmware` OTA every 2.5 s,
the notification bell every 30 s). A change that the Worker persisted between two polls was
invisible, so the console looked frozen until a manual refresh. The polling also cost one
Worker request plus one or more Supabase queries per interval per open tab, and every tab
paid it separately.

## Architecture

```
ESP32 device ──HTTPS /api/device/*──▶ Cloudflare Worker ──▶ Supabase Postgres
        │                                   │
        └──MQTT (8883, per-device ACL)──┐   │ publishes one envelope per state change
                                        ▼   ▼
                                   EMQX Serverless
                                        │  topic: homecore/<accountId>/realtime/events
                                        ▼
                        Browser (ONE MQTT-over-WebSocket session)
                                        │
                              BroadcastChannel (other tabs)
                                        ▼
                     RealtimeSyncClient → shared version map + cache invalidation
                                        ▼
                     `useLiveSync()` per page → coalesced reload / live patch
```

| Layer | Responsibility |
| --- | --- |
| Device | Reports telemetry, switch/device state, heartbeats and OTA progress over HTTPS; consumes commands over its own MQTT session. |
| Worker (`apps/worker/src/lib/realtime.ts`) | Persists the change, then publishes a single account-scoped event envelope. Best-effort: a broker failure never fails the HTTP request. |
| EMQX Serverless | Fan-out. Only the account's `realtime/#` tree is involved; device topics are untouched. |
| Browser (`apps/web/src/lib/realtime/`) | One connection per account, one version map, one cache-invalidation path, multi-tab leadership. |
| Pages | Subscribe through `useLiveSync()` and reload their existing endpoints when a relevant entity changes. |

### Why not Supabase Realtime or Worker-held sockets

* **Supabase Realtime** would add a second real-time vendor, duplicate the Worker's
  authorization decisions, and expose row-level change feeds that the Worker already
  authorizes and shapes.
* **A Worker-held WebSocket/SSE endpoint** cannot fan out across isolates without a Durable
  Object, which the deployment does not use (see `DEPLOYMENT.md`). EMQX already is the
  fan-out layer and is part of the free tier.
* **Polling** was the original defect; it is kept only as a *fallback* while the channel is
  not live (see below).

## Topics

| Topic | Direction | Purpose |
| --- | --- | --- |
| `homecore/<accountId>/realtime/events` | Worker → browser | The only browser-facing topic. JSON envelope, not retained. QoS 1 for human-triggered state chunks, QoS 0 for chunks carrying sensor telemetry. |
| `homecore/<accountId>/board-instances/<boardInstanceId>/cmd/#` | Worker → device | Device commands (unchanged). |
| `homecore/<accountId>/board-instances/<boardInstanceId>/config/#`, `ota/cmd` | Worker → device | Config snapshots and OTA commands (unchanged). |
| `homecore/<accountId>/board-instances/<boardInstanceId>/telemetry/#`, `state/#`, `status/#`, `ota/progress`, `config/ack` | Device → Worker | Device reports (unchanged). |

The browser never subscribes to a device topic and never publishes anywhere.

### Envelope

```json
{
  "v": 1,
  "accountId": "…",
  "sentAt": "2026-01-01T10:00:05.000Z",
  "events": [
    {
      "entity": "switch",
      "action": "state",
      "id": "…",
      "ts": "2026-01-01T10:00:05.000Z",
      "version": "2026-01-01T10:00:04.900Z",
      "phase": "confirmed",
      "patch": { "isOn": true, "isOnline": true, "lastChangedAt": "…" }
    }
  ]
}
```

Two timestamps, two jobs:

* **`ts`** is the Worker's publish time. It orders deliveries and is the only thing the
  duplicate/late/out-of-order guard compares.
* Both timestamps survive a bounded retry: a chunk that was actually delivered but
  acknowledged late is re-published with the same per-event `ts`, and the client drops the
  duplicate.

* **`version`** is the *row* version the snapshot also reports for that entity
  (`switches.last_changed_at`, `devices.last_state_at`, `sensors.last_reading_at`,
  `automation_rules.last_executed_at`, `board_instances.last_communication_at`/`updated_at`,
  `homes.updated_at`). Because both sides speak about the same revision, an entity that was
  already updated by an event does not trigger a redundant reload on the next reconcile.

* The two version strings must be **identical**, never merely close. Timestamp columns that
  carry a `set_updated_at` trigger are stamped with the database clock (`now()`, the
  transaction start), which can be a millisecond away from the Worker's `new Date()`. The
  home publisher therefore writes `homes.updated_at` and reads the stored value back
  (`update(...).select("updated_at")`) before publishing, so the event version is the
  snapshot version byte for byte. Adding a new publisher over a trigger-managed column must
  do the same — publishing a locally generated timestamp is a drift bug, not a rounding
  detail.

An envelope carries at most **40 events** (`REALTIME_MAX_EVENTS_PER_MESSAGE`) so the payload
stays small. A bulk action that touches more entities than that is split across several
envelopes — never truncated. Publishing each chunk is independently retried once, so one
transient broker error cannot drop a tail of switch updates.

`entity` is one of `board`, `switch`, `device`, `sensor`, `automation`, `notification`,
`home`. Pairing, recovery, role changes, room moves, config revisions and OTA progress all
arrive as `board` events, and a newly created user notification arrives as a `notification`
event. `action` is `created`, `updated`, `deleted`, `state`, `run` or `alert`. `ts` is the
authoritative ordering key.

### Command lifecycle (`phase`)

| Phase | Meaning | Example |
| --- | --- | --- |
| `desired` | The user asked for this state; nothing has been sent to hardware. | Broker not configured, or a Node with no uplink. |
| `accepted` | The Worker published the command to the device's own MQTT topic. The broker accepted it; the hardware has **not** confirmed yet. | Switch toggle with `mqttDispatched: true`. |
| `confirmed` | The hardware reported the state over telemetry/heartbeat. | Device sends `switches: [{ switchId, isOn }]`. |
| `failed` | The command never left the Worker (publish error). The API also returns `502`. | EMQX REST publish failed. |

The same rules apply everywhere state is written: an individual switch/device control, the
Dynamic Island Action Button (including its room-wide and all-device gestures), an
automation rule or a visual flow graph all publish `accepted` for the entities they actually
changed, and only hardware telemetry publishes `confirmed`.

UI rule: never render a button press as hardware truth. `desired`/`accepted` may show a
pulse or a "sending" state; only `confirmed` may flip the persisted label, and `failed`
must revert the optimistic update.

## Authorization

`GET /api/realtime/config` returns a **per-login-session, subscribe-only** broker identity:

* username `hcweb-<accountId>-<sessionId>` (one per cookie session);
* password = `HMAC-SHA256(EMQX_APP_SECRET, "homecoreos:realtime:<sessionId>")`, derived on
  demand — it is never stored in Postgres, never logged and never in the bundle;
* ACL: `allow subscribe homecore/<accountId>/realtime/#` then `deny all #` — no publish, no
  device topics, no cross-account topics;
* broker client id `hcweb-<accountId>-<sessionId>`, so one login session owns exactly one
  connection and a revocation can kick the live socket immediately.

Revocation is part of every path that ends a session's authority:

| Event | What happens |
| --- | --- |
| `POST /api/auth/logout` | Broker user deleted, ACL deleted, live client kicked, `realtime_web_sessions.revoked_at` set. |
| `PATCH /api/auth/change-password` | Every *other* session of the user is revoked in Postgres **and** loses its broker identity in one batched call; the current session keeps working and re-provisions on next login. |
| `POST /api/auth/password-reset/confirm` | Every session of the user is revoked with its broker identity, so a still-open tab stops receiving private events. |
| `DELETE /api/auth/sessions/:id` | The revoked session's broker identity is deleted and its socket kicked. |
| `POST /api/auth/switch-account` | The previous account's identity is revoked before the console boots the new one; the next `GET /api/realtime/config` provisions the new account's username, topic and ACL. |

The frontend never receives device credentials. A leaked browser credential can only read
its own account's already-authorized state stream, and rotating `EMQX_APP_SECRET`
invalidates every outstanding browser credential at once.

## Sync, reconnect and ordering

1. **One session per account.** The first tab leads; followers mirror it over a
   `BroadcastChannel` and never open a socket. Leadership is decided deterministically: a tab
   announces itself, waits out a 400 ms probe window, collects the ids of every tab that
   answered, and only the lowest id connects. If two tabs do start at the same instant and one
   wrongly claims leadership, the senior tab's `claim` makes the other close its socket and
   step down — the system converges on exactly one broker session. The leader publishes its
   own `state`/`synced` over the channel so follower tabs never sit on "Connecting".
2. **Subscribe, then reconcile.** On every (re)connect the client subscribes, buffers
   incoming events, fetches `GET /api/realtime/snapshot`, and applies the buffered events
   afterwards. The snapshot is a compact `id → version` map — not a data dump.
3. **Reconcile only drift.** Versions are compared per entity **and only with row-derived
   versions**, never with delivery timestamps. A snapshot older than what an event already
   taught the tab is not drift (the newer version is kept), which is what prevents a
   permanently "drifted" entity after a reconnect. A snapshot that is newer than the tab, or
   an entity that appeared/disappeared, reloads just those entity kinds.
4. **Ordering, duplicates, delay.** Each applied event raises a per-entity delivery watermark
   (`ts`); equal or older deliveries are dropped. A separate version map tracks row revisions,
   so ordering and reconciliation can never corrupt each other.
5. **Rejected identity self-heals once.** If the broker refuses the credential
   (`not authorized`, `bad username or password` — a rotated `EMQX_APP_SECRET`, a reaped
   session, an EMQX user removed outside the app), the client asks
   `GET /api/realtime/config?reprovision=1` once per session and reconnects with the fresh
   credential instead of retrying a dead one in a loop.
6. **Snapshot failure is not success.** If the snapshot request fails (Worker error, database
   error, network), the channel reports `degraded` / `synced: false` and retries with
   exponential backoff (2 s → 60 s). It only reports `live` **after** a snapshot has actually
   been applied, so "Live" in the UI always means "reconciled", never "socket connected".
7. **Reconnect backoff.** 1 s → 2 s → 4 s → 8 s → 16 s → 30 s (capped, jittered). No
   reconnect storm, no duplicated sockets (the old client is closed first).
8. **Tab visibility.** When a tab becomes visible again the leader refreshes the snapshot at
   most once a minute — an occasional repair, never polling. Events that arrived while hidden
   are applied when the page is shown, not lost.
9. **Fallback.** If the channel is disabled (EMQX not configured, account paused) or the
   socket cannot be established, `useLiveSync` falls back to one visible-only refresh per
   45–90 s. This is a degraded mode, not the primary path.

### What publishes, and when

| Write path | Publishes |
| --- | --- |
| Individual switch toggle / device command | `switch`/`device` `state` with `accepted` or `desired`, plus `failed` on a publish error. |
| Dynamic Island Action Button (all gestures, room-wide and all-device steps) | One `accepted` event per switch/device the press actually changed, flushed before every `delay` step so a long program cannot hold changes back. |
| Automation rule (actions, scenes) and visual flow graph | `accepted` events for every switch/device the run changed, in the same envelope as the `automation` `run` result. |
| Device telemetry (state, sensor values, OTA progress) | `confirmed` events for changed values only, plus `board` updates for ONLINE/OFFLINE, uplink and firmware transitions. |
| Node roster / ESP-NOW link changes | `confirmed` `board` events for linked and lost Nodes. |
| Heartbeat timeout sweep | One `board` offline transition plus the notification event. |
| CRUD (switch/device/sensor/board/automation/home), pairing, recovery, room moves, config revisions | `created`/`updated`/`deleted` events. |
| Room create/rename/resize/delete, floor-plan drags | A `home` event (`patch.reason: "rooms"`) plus a `homes.updated_at` touch whose stored value is read back and published as the event version, so the 2D map, Rooms grid and room selector follow live and a reconnect reconciles instead of reloading. |

## Quota discipline

| Concern | Rule in this implementation |
| --- | --- |
| MQTT messages | One envelope per user action or device report, never per row. A telemetry batch with several sensors/switches/devices is a single message; more than 40 events becomes several envelopes rather than a truncated one. |
| Reconcile cost | Row versions let a reconnect prove an entity is current without reloading it, so a short blip usually costs zero page requests. |
| Message content | Only meaningful changes: ONLINE-OFFLINE transitions, actual state changes, changed sensor values (unchanged values are suppressed for five minutes), automation runs, config revisions. Steady heartbeats update Postgres silently. |
| Broker sessions | One per browser session (leader tab only, deterministic client id) + one per device. Extra tabs add no session; a revoked session is kicked rather than left connected. |
| QoS / retention | Chunks made only of low-volume events (switch, device, board, automation, home, notification) publish at QoS 1 so a dropped command result is retried by the broker; anything carrying sensor telemetry stays QoS 0, because acks on high-frequency readings would cost more than they save. Nothing is retained — the snapshot is the repair mechanism. |
| Worker requests | Reloads are coalesced (120 ms, plus a per-page minimum interval of 2–5 s) and only fire for the entity kinds a page uses. Idle pages make no requests. |
| Supabase | No new tables are written on the hot path except `realtime_web_sessions` (one row per login, no password). No Supabase Realtime. |
| EMQX API calls | One provision per sign-in (idempotent skip afterwards), one publish per change batch. |

## Scope

The channel covers the **user console**: Overview and the 2D floor plan, rooms, devices,
switches, sensors, My Boards (Controllers and Nodes), Automations, Firmware/OTA, Activity
and the notification bell, plus the pairing and controller-setup modals.

The **admin console** is not subscribed to account channels by design: platform staff read
aggregated data that is not tied to one home, and keeping admin out of the per-account
stream means an admin tab never consumes a home's real-time quota. Admin pages keep their
existing explicit refresh behaviour.

The `mqtt` client is loaded lazily: a console that never goes live (tests, EMQX not
configured) never downloads the transport chunk.

## Worker endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/realtime/config` | Returns the subscribe-only credential, broker URL, topic, and whether the channel is enabled. `?reprovision=1` forces re-provisioning. `Cache-Control: no-store`. |
| `GET /api/realtime/snapshot` | Compact `id → version` map for `boards`, `switches`, `devices`, `sensors`, `automations`, `homes`. `Cache-Control: no-store`. A database error returns **503** with `reason: "snapshot_unavailable"` — never an empty entity list. |

## Configuration

Required (already documented in `DEPLOYMENT.md`): `EMQX_API_BASE`, `EMQX_APP_ID`,
`EMQX_APP_SECRET`, `EMQX_BROKER_HOST`, `EMQX_TLS_PORT`.

Optional, for the browser channel:

| Variable | Default | Meaning |
| --- | --- | --- |
| `EMQX_WS_URL` | derived | Full `wss://…` URL. Use when the deployment's WebSocket listener is not the standard one. |
| `EMQX_WS_PORT` | `8084` | MQTT-over-WebSocket TLS port. |
| `EMQX_WS_PATH` | `/mqtt` | WebSocket path. |

The broker must allow MQTT over WebSocket (EMQX Serverless enables it by default; if your
deployment disables it, the console falls back to the per-minute refresh and reports
`Manual refresh`).

## Failure handling

| Failure | Behaviour |
| --- | --- |
| EMQX REST publish fails | The HTTP request still succeeds (state is in Postgres); the event is skipped with a Worker warning; the next reconcile or manual refresh shows the value. |
| Broker unreachable for the browser | Client reports `reconnecting`, retries with backoff, pages fall back to a 60 s visible refresh. |
| Device offline | No events; the heartbeat timeout transitions the board to offline once and pushes that transition. |
| Snapshot query fails | Worker answers `503 snapshot_unavailable`; the client stays `degraded`/`synced: false` and retries with backoff. The console never treats a failed read as "the account has no devices". |
| Snapshot read fails in the browser | Same degraded state; buffered events are still applied, but the channel does not claim to be synchronized. |
| Duplicate telemetry | Suppressed by the value/state comparison and by the client delivery watermark. |
| Two tabs start together | Deterministic election; the loser closes its socket and keeps receiving via BroadcastChannel. |
| Account paused / deleted | The config endpoint keeps working for reading but the account's operations are disabled; credentials are revoked on sign-out and by pruning. |

## Verification

```bash
npx vitest run test/realtime-sync.test.ts --root apps/worker   # channel, ACL, chunking, snapshot errors, revocation
npx vitest run src/lib/realtime --root apps/web                # store, versions, snapshot failure, election, hooks
```

Manual check: open the console in two tabs, toggle a switch in one, and confirm the other
tab, the 2D floor plan, the room card and the Dynamic Island master controls follow without
a refresh. Then stop the network for ten seconds, change a device state from the device
side, and confirm the tab reconciles on reconnect.
