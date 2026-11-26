# Universal multi-board connectivity, binding and automatic failover

This document describes the connectivity architecture as implemented. The
canonical source of truth for board hardware is
`packages/shared/src/board-capabilities.data.json`; this document explains how
that data is used.

## 1. What changed from the earlier Controller/Node design

The earlier design in `UNIFIED_CONTROLLER_NODE.md` treated an assignment as
effectively a connection and intentionally closed a Node's MQTT session while
seeking its Controller. That behaviour is superseded:

- Assignment, binding and connection are three different states.
- A Node **never** closes a working MQTT session merely because it is assigned
  or searching. Its MQTT session is closed only after a Worker-confirmed
  Controller relay is healthy.
- Binding has a persistent ID and a monotonically increasing generation. A
  higher generation is authoritative even if the device was offline; stale
  generations and unknown binding IDs are rejected at the radio layer.
- The Worker, not the device, marks a binding verified and changes the
  authoritative cloud route.
- Capabilities come from an explicit per-board-ID registry. Chip-family names
  and flash sizes are never used as a proxy.

## 2. Capability registry

`packages/shared/src/board-capabilities.data.json` contains one entry for each
of the 22 board profiles in the repository (21 ESP-IDF overlays plus the
isolated ESP8266 profile). Each entry records:

- exact board ID, chip target and variant;
- firmware framework and exact SDK version used by the build matrix;
- Wi-Fi, MQTT, ESP-NOW, BLE provisioning, SoftAP provisioning and USB recovery;
- flash, PSRAM mode/size and nominal SRAM;
- ESP-NOW v1 payload ceiling (250 bytes), peer and encrypted-peer limits;
- maximum supported Controller Node count and the maximum **tested** count;
- supported roles, supported transports and support status
  (`supported` / `experimental` / `unsupported`);
- per-board resource limits: queue depth, MQTT buffer, telemetry cadence,
  keepalive, link timeout, rapid-recovery window, discovery interval and task
  stack size.

`packages/shared/src/board-capabilities.ts` is the typed wrapper used by the
Worker and web console. `firmware/scripts/generate_board_capabilities.py`
generates two C headers from the same JSON:

- `firmware/main/generated/hc_board_capabilities.h` — the complete lookup table;
- `hc_board_capabilities_selected.h` — generated at CMake configure time for
  the exact `CONFIG_HOMECORE_BOARD_SLUG`, so each image compiles with only its
  own board's limits and roles.

`firmware/scripts/verify_board_capabilities.py` fails CI if a registry entry,
an sdkconfig overlay, the ESP8266 profile, the firmware build matrix or a
generated header drifts out of sync.

### Board support policy

| Board family | Roles | Transports | Policy |
|---|---|---|---|
| ESP32, ESP32-S2, ESP32-S3, ESP32-C3, ESP32-C6 | Controller + Node | Wi-Fi/MQTT, ESP-NOW | ESP-NOW enabled only for the exact SDK target and board overlay that build in CI |
| ESP32-C2 (ESP8684), ESP32-C5, ESP32-C61 | Controller + Node | Wi-Fi/MQTT, ESP-NOW | `experimental`: enabled only from the verified SDK build (`v5.4` / `v5.5.2`), no physical radio claim |
| ESP8266 (NodeMCU v2 / ESP-12E) | Node only | Wi-Fi/MQTT | Direct MQTT retained. ESP-NOW Node and Controller remain disabled until mixed-chip interoperability tests pass |
| ESP32-H2 | none | none | No 2.4 GHz Wi-Fi radio; outside the Wi-Fi Controller/Node architecture until a gateway profile exists |
| ESP32-P4 | none until a companion is registered | none | `chip_wireless_policy` requires an explicitly supported external wireless companion before network roles are enabled |

No board profile was removed. Boards that differ in capability are marked
`experimental` rather than being deleted or over-advertised.

## 3. Three separate state families

The firmware connectivity manager (`firmware/main/connectivity_logic.c`) keeps:

- **Hardware capability** — from the generated compile-time profile.
- **Binding state** — `unpaired`, `pairing`, `assigned`, `verified`, `revoked`.
- **Connection state** — ESP-NOW: `unavailable`, `searching`, `linked`, `lost`,
  `reconnecting`; cloud: `direct_node_mqtt`, `controller_mqtt`, `connecting`,
  `unavailable`.

An assignment never proves a connection; an ESP-NOW link never proves a cloud
route. Local GPIO/automation is a separate, always-available transport and is
not stopped by route changes.

`firmware/main/transport.h/.c` provides the common transport descriptor
(`wifi_mqtt`, `espnow`, `local_io`). A board receives only descriptors its
capability profile allows; new transports can be added without duplicating the
connection manager.

## 4. Controller and Node behaviour

### Controller

- Keeps Wi-Fi/MQTT and ESP-NOW hosting independent.
- Hosts at most `limits.max_controller_nodes` Nodes from its own profile; the
  global peer table is still a hard ceiling (compile-time assertion).
- Validates every Node keepalive against the Worker-issued binding generation
  and binding ID before adding it to the live roster.
- Continues local operations when the cloud is down.

### Node

- Unassigned: direct MQTT, no ESP-NOW seeking.
- Assigned but not verified: keeps direct MQTT **and** searches for the
  Controller using the 2-second keepalive.
- Verified with a healthy Controller cloud route: Controller relay becomes the
  authoritative route; the Node's own MQTT session is closed only after the
  Worker-confirmed `confirm_route` command arrives.
- Controller MQTT fails: direct MQTT is restored automatically; no re-pairing.
- ESP-NOW link fails: retries within the 45-second rapid window, then probes
  every 15 seconds. Binding, generation and identity survive reboots, router
  failures and temporary Controller outages.
- Boards without ESP-NOW stay direct-MQTT Nodes and never seek a Controller.

Timing values are per-board in the registry; the defaults remain 2 s, 10 s,
45 s and 15 s.

## 5. Binding authority

Account enrollment (`board_instances.account_id`, `home_id`) remains separate
from binding. Enrollment still uses BLE where available, otherwise SoftAP or
USB recovery.

Binding rules:

1. A user assigns a compatible Controller from My Boards. The Worker checks
   role capability, same account/home, online status, self-reference and the
   Controller's capability profile.
2. The Worker issues a short-lived single-use challenge
   (`POST /api/board-instances/:id/binding-challenge`) and publishes it to both
   the Node and the Controller over MQTT as `binding_challenge`. Firmware keeps
   it in RAM only: the Node echoes `chid`/`cnon`/`chg` in its heartbeat and the
   Controller in the matching roster entry. The Worker rejects verification
   when a pending challenge is not echoed identically, and consumes it once.
   A consumed route confirmation clears the challenge on both devices.
3. The assignment writes a persistent `binding_id`, increments
   `binding_generation`, sets `binding_state='assigned'` and publishes the
   authoritative binding block in the config snapshot.
4. The Node and Controller exchange binding ID, generation, identity and
   Controller cloud health in their ESP-NOW keepalive/ACK frames. ACKs with an
   unknown or stale generation are rejected.
5. The Worker alone marks a binding `verified`, and only when the Node reports
   a bidirectional ACK, the Controller lists it in its roster, both report the
   same generation and the Controller has a live MQTT session.
6. Unbind or reassignment increments the generation and revokes the old
   binding. Radio frames from the old generation are rejected.

`database/migrations/0011_binding_authority.sql` adds the binding columns,
route generation and the challenge table. Legacy rows start at generation 0
with state `verified`, so existing devices keep working.

## 6. Automatic cloud routing (make-before-break)

`apps/worker/src/lib/route-authority.ts` and
`packages/shared/src/board-capabilities.ts` implement the same route policy:

1. Keep the current working route.
2. Establish the alternative route.
3. Verify health with fresh telemetry, roster membership and matching binding
   generation.
4. Ask the Worker to change the authoritative route (the binding verification
   step).
5. Confirm the route change to the Node over ESP-NOW (`confirm_route`).
6. Only then close the previous route.

Routing rules:

| Condition | Route |
|---|---|
| Node MQTT healthy | direct delivery available |
| ESP-NOW verified, Node in roster, Controller MQTT healthy | Controller relay available (preferred) |
| Controller MQTT unavailable | Node MQTT if connected, otherwise unavailable |
| Node Wi-Fi unavailable, Controller route healthy | Controller relay |
| Neither route healthy | unavailable; delivery is deferred |

Command IDs are generated once and preserved across handoffs. The firmware
keeps a bounded in-memory ring of the last 32 command IDs per generation;
duplicate or replayed toggle/pulse commands are rejected. Only binding
credentials, generations and peer IDs are written to NVS, and only when they
change; route telemetry, challenges and dedupe entries stay in RAM. Clearing
pairing invalidates the NVS binding cache in the same boot so an old binding
cannot be resurrected by a later save.

## 7. Radio and channel rules

- ESP-NOW v1 payloads are capped at 250 bytes for mixed-generation devices.
  Larger application messages must be fragmented and reassembled; the relay
  frame includes only compact command data.
- Protocol version and capabilities are exchanged during provisioning/config
  sync; the registry records the SDK target and the capability profile.
- Peer channels are verified before a link is considered healthy. The ACK
  carries the Controller's active channel.
- Wi-Fi STA and ESP-NOW share one radio. The Node never channel-hops while
  associated with an AP; it follows the AP channel or a pinned Worker channel.
  A channel sweep is used only while unassociated/reconnecting. A healthy
  MQTT session is never dropped to scan.
- The Controller adds peers by MAC and rejects keepalives whose target ID,
  binding ID or generation do not match its authorized roster.
- ESP-NOW send success is not reported as application delivery; the Node
  requires a validated ACK and the Worker requires roster telemetry.
- Receive callbacks only record short frame data; link work runs in the
  500 ms supervision tick with bounded queues and retry counters.

## 8. Frontend

My Boards, Node cards, Controller cards and board details show:

- Connected directly
- Connected through Controller
- Reconnecting automatically
- Local connection active
- Cloud unavailable
- Device not supported for this connection method

Binding state is shown separately (for example "Assigned · not verified").
Actions for roles and transports a board does not support are hidden using
the same registry the Worker uses. Statuses come from Worker telemetry pushed
through `useLiveSync()`; no component-level polling was added.

## 9. Verification and limitations

Automated gates added for this work:

- `python3 firmware/scripts/verify_board_capabilities.py`
- `gcc ... firmware/test/test_connectivity_logic.c firmware/main/connectivity_logic.c`
- shared registry/route tests, Worker route-authority tests, frontend status tests
- existing firmware host suites, board overlay checks, 21-target IDF build
  matrix, workspace typecheck/tests and database schema verification

Hardware limitations, stated plainly:

- No physical boards were connected during this work or in the repository's
  test history. `hardware_tested` is false and `max_tested_controller_nodes`
  is 0 for every board. All 21 ESP-IDF overlays passed compiler/build
  verification, which is not hardware validation.
- Mixed ESP8266/ESP32 ESP-NOW interoperability has not been tested, so ESP8266
  ESP-NOW remains disabled.
- ESP32-H2 is intentionally outside the Wi-Fi Controller/Node architecture.
- ESP32-P4 needs an explicitly registered external radio companion before any
  network role is enabled.
- RSSI limits, real channel behaviour, encrypted peer support and multi-Node
  saturation still require physical validation.
