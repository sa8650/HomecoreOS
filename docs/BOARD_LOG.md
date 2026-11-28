# Per-board live Log

Every Controller and every Node has its own **Log**: the operational history of
*that* board. The Log answers one question — *what happened on this individual
board?* — and it is scoped by board id and by account.

A Controller's Log and a Node's Log are never merged. A Node appears in a
Controller's Log only as the **peer** of a communication event ("Node `…` is
linked over ESP-NOW"), and a Controller appears in a Node's Log only as the peer
of the link it belongs to.

## What is captured

| Category | Events |
| --- | --- |
| `connection` | online / offline, reboot (uptime going backwards), link established / lost, missed heartbeat and recovery |
| `communication` | MQTT session up/down, Wi-Fi up/down, route changes, ESP-NOW keepalive link, one-way reception, relay hand-off |
| `command` | created, sent, received, acknowledged, executed, rejected, duplicate, failed, timeout, offline |
| `device_activity` | switch state changes, device state changes, sensor reading failures and recoveries |
| `binding` | assignment, unassignment, binding verification, revocation, role change, generation mismatch |
| `system` | firmware version change, board-reported errors, operator commands (restart / reset / disconnect) |

## The vocabulary is strict

| Status | Meaning | Source |
| --- | --- | --- |
| `created` | the console accepted the request | Worker |
| `sent` | the Worker handed the command to a transport — **a publish, nothing more** | Worker |
| `received` | the destination board confirms it received the command | **the board itself** |
| `acknowledged` | the sender received a valid acknowledgement for it | **the board itself** |
| `executed` | the destination board confirms it applied the command | **the board itself** |
| `rejected` | the destination board refused the command | **the board itself** |
| `duplicate` | the destination board had already seen this command | **the board itself** |
| `failed` | the command could not be delivered or could not be applied | Worker / board |
| `timeout` | no confirmation arrived before the deadline | Worker |
| `offline` | the destination board was not reachable | Worker |

A publish on the Worker side is **never** presented as a receipt. The states
`received`, `acknowledged` and `executed` are only ever written from a fact the
*destination* board reported about itself.

## How the facts reach the Worker

The firmware has **no per-log MQTT publisher**, no dedicated task and no flash
write. Instead it keeps a small, fixed-size ring of facts in RAM
(`firmware/main/board_log.c`) and ships them inside the heartbeat it already
sends:

```
POST /api/device/heartbeat
{ …, "sid": 4242, "fx": [ { "k":"cmd", "s":"received", "m":"mqtt", "c":"cmd-…", "ts": 7 } ] }
```

The ring holds 12 facts with fixed-length fields, so its RAM cost is known at
compile time and never grows. A fact is only cleared once the report actually
succeeded — a failed heartbeat retries with the next one instead of losing it.
Facts are evicted by priority: a rare command fact is never pushed out by a
stream of routine link facts.

The batch that travels with the heartbeat is bounded as well (900 bytes). If
not every pending fact fits into that payload, the batch is still written as
valid JSON with the facts that fit, and the remaining facts stay in the ring
for the next heartbeat. Only the facts that were really sent are dropped from
the ring after a successful report, so a partial batch never loses a fact.
The Worker's heartbeat schema accepts up to 12 facts per report — the same
bound as the firmware ring — so a completely full ring is still reported
instead of being rejected.

The Worker turns those facts into log rows (`apps/worker/src/lib/board-log.ts`).

## Storage

One dedicated table, `board_log_events` (migration `0012`), rather than a reuse
of `activity_logs`:

* `activity_logs.category` has a fixed `CHECK` constraint and no per-board
  filtering, so it cannot express the console's vocabulary without weakening an
  existing constraint.
* The console reads newest-first with a stable cursor, which needs a composite
  `(account_id, board_instance_id, seq DESC)` index.
* Log rows are pruned on their own schedule and never mix with the account-wide
  audit trail.

Columns: `category`, `severity`, `status`, `method`, `source`, `destination`,
`message` and a bounded `metadata` JSONB. No payloads, no command bodies, no
sensor values — only identifiers and short tokens.

`dedupe_key` is the identity of the logical event: the same key is never stored
twice, so a retried request or a replayed device report cannot duplicate a line.

## Performance protections

| Protection | Where |
| --- | --- |
| No row per heartbeat — only *transitions* are written | Worker capture points |
| No per-log MQTT publish, no permanent logging loop | Firmware |
| Bounded RAM ring (12 facts, fixed field lengths) | `firmware/main/board_log.c` |
| No NVS/flash write per event | Firmware |
| One broker message per user action or device report — the log entries travel in the same envelope as the state change | Worker (`BoardLogCollector`) |
| Per-board rate limit (120 low-priority entries/minute); warnings and errors are never dropped | `apps/worker/src/lib/board-log.ts` |
| Retention window (default 14 days) and per-board row ceiling (2000 rows) | `pruneBoardLogs` on the Worker's scheduled tick |
| Command timeout sweep reads a bounded window, never the whole table | `expireUnconfirmedCommands` |
| Bounded metadata (20 keys, 240 characters per value) | `sanitizeBoardLogMetadata` |

The capture can be switched off per deployment with `BOARD_LOG_ENABLED=false`;
the console keeps reading the history that was already stored.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/board-logs/:boardInstanceId` | The board's newest entries, with `?limit`, `?before` (cursor), `?category`, `?severity` and `?q` (search). Returns the board's identity and status next to the entries. |

The board is resolved with the session's account id in the same query, so a
user can never read the log of a board they do not own (a foreign board is
reported as *not found*, never as *forbidden*).

There is **no delete endpoint**: "Clear View" in the console only hides the
entries; the stored records are removed by the retention sweep.

## Console

The Log opens from the three-dot menu of a Controller card and of a Node card.
It shows the board's name and id, its connection status, its last-seen time, a
live indicator, a search field, the seven documented filters (All,
Communication, Device Activity, Connection, Commands, Warning, Error), and one
line per entry with an icon, a description, a timestamp, the status, the
method, the source and the destination.

Live entries arrive over the existing account real-time channel
(`entity: "log"`); the modal never polls. While the view is paused the
incoming entries are **buffered** and applied on resume. The view can be
refreshed, older pages can be loaded with the server's cursor, and the
auto-scroll toggle follows the newest entry.

## Verification

```bash
npx vitest run test/board-log.test.ts --root apps/worker   # isolation, ownership, vocabulary, dedupe, pagination, retention, timeout sweep
npx vitest run src/components/boards/board-log-dialog.test.tsx --root apps/web
npx vitest run src/features/user/my-boards-log.test.tsx --root apps/web
npx vitest run test/board-log.test.ts --root packages/shared
gcc -Wall -Wextra -Werror -std=c11 firmware/test/test_board_log.c firmware/main/board_log.c -o /tmp/test_board_log && /tmp/test_board_log
```

## Limitations

* The ESP32 firmware could not be built or flashed in this environment, so the
  firmware side is **host-tested and code-reviewed**, not hardware-verified.
  The CI workflow builds every ESP32 target of the release matrix; the
  ESP8266 profile stays isolated and is not part of this feature.
* A board that produces more facts between two heartbeats than the payload
  can carry keeps only the newest ones in its RAM ring. The Log then shows
  the facts the board could actually report — it is a bounded history, not an
  audit-grade recorder.
* `received` / `acknowledged` / `executed` require a board that runs the
  firmware version that reports facts. An older board still produces
  `created` / `sent` and the Worker's own transitions, but never claims a
  receipt it cannot prove.
* The Worker can only time out a command it published; a command that never
  left the Worker is recorded as `failed`/`offline` at once.
