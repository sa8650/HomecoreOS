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
| `homecore/<accountId>/realtime/events` | Worker → browser | The only browser-facing topic. JSON envelope, QoS 0, not retained. |
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
      "phase": "confirmed",
      "patch": { "isOn": true, "isOnline": true, "lastChangedAt": "…" }
    }
  ]
}
```

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
* revoked on sign-out (`POST /api/auth/logout`) and when the session row is pruned.

The frontend never receives device credentials. A leaked browser credential can only read
its own account's already-authorized state stream, and rotating `EMQX_APP_SECRET`
invalidates every outstanding browser credential at once.

## Sync, reconnect and ordering

1. **One session per account.** The first tab becomes the leader (BroadcastChannel probe,
   then a 10 s heartbeat). Followers receive the leader's events and never open a socket.
2. **Subscribe, then reconcile.** On every (re)connect the client subscribes, buffers
   incoming events, fetches `GET /api/realtime/snapshot`, and applies the buffered events
   afterwards. The snapshot is a compact `id → version` map — not a data dump.
3. **Reconcile only drift.** Versions are compared per entity. Only entities that are new,
   changed or missing trigger a reload; a short network blip usually reloads nothing.
4. **Ordering and duplicates.** Each applied event raises a per-entity version watermark
   (`ts`). Events with an equal or older `ts` are dropped, so delayed, duplicated or
   out-of-order broker deliveries are harmless.
5. **Reconnect backoff.** 1 s → 2 s → 4 s → 8 s → 16 s → 30 s (capped, jittered). No
   reconnect storm, no duplicated sockets (the old client is closed first).
6. **Tab visibility.** When a tab becomes visible again the client refreshes the snapshot;
   drift is repaired before the user reads stale numbers. Events that arrived while hidden
   are applied when the page is shown, not lost.
7. **Fallback.** If the channel is disabled (EMQX not configured, account paused) or the
   socket cannot be established, `useLiveSync` falls back to one visible-only refresh per
   minute. This is a degraded mode, not the primary path.

## Quota discipline

| Concern | Rule in this implementation |
| --- | --- |
| MQTT messages | One envelope per user action or device report, never per row. A telemetry batch with several sensors/switches/devices is a single message. |
| Message content | Only meaningful changes: ONLINE-OFFLINE transitions, actual state changes, changed sensor values (unchanged values are suppressed for five minutes), automation runs, config revisions. Steady heartbeats update Postgres silently. |
| Broker sessions | One per browser tab set (leader only) + one per device. The browser session is reused across page loads. |
| QoS / retention | Browser events are QoS 0 and not retained; a snapshot request repairs loss. No retained state storms. |
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
| `GET /api/realtime/snapshot` | Compact `id → version` map for `boards`, `switches`, `devices`, `sensors`, `automations`, `homes`. `Cache-Control: no-store`. |

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
| Duplicate telemetry | Suppressed by the value/state comparison and by the client version watermark. |
| Account paused / deleted | The config endpoint keeps working for reading but the account's operations are disabled; credentials are revoked on sign-out and by pruning. |

## Verification

```bash
npx vitest run test/realtime-sync.test.ts --root apps/worker   # Worker channel + ACL + quota behaviour
npx vitest run src/lib/realtime --root apps/web                # store, dedupe, reconnect, multi-tab, hooks
```

Manual check: open the console in two tabs, toggle a switch in one, and confirm the other
tab, the 2D floor plan, the room card and the Dynamic Island master controls follow without
a refresh. Then stop the network for ten seconds, change a device state from the device
side, and confirm the tab reconciles on reconnect.
