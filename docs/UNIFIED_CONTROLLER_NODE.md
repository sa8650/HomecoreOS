# Unified Controller & Node Architecture

Date: 2026-11-18
Status: implemented and verified (automated gates green; ESP-NOW transport unbuilt locally — see §10).

This document is the final report for the unified Controller/Node firmware work: one single
firmware image that runs either role, chosen at runtime by the user in the web console.

---

## 1. Design in one page

| | Controller mode | Node mode |
|---|---|---|
| Defined in | `device_role = 'controller'` (default for every existing device) | `device_role = 'node'` |
| Cloud | Wi-Fi + EMQX MQTT (unchanged) | **no MQTT session** while the ESP-NOW link is healthy; HTTPS heartbeat only |
| Peer link | hosts Nodes over ESP-NOW | links to **one** assigned Controller over ESP-NOW |
| Fallback | — | after losing its Controller it retries, then runs as **“Standalone Node — Controller Disconnected”** over Wi-Fi/MQTT |
| Auto-promotion | — | **never**; a Node stays a Node |
| OTA | EMQX `ota/cmd` on its own topic | EMQX instruction relayed by the Controller, then a temporary Wi-Fi/EMQX window for the download |
| Identity | device row, pairing, credentials, firmware history | **same row** — a role change never recreates the device |

The role is a **column on the existing `controllers` table**, not a new device type, so switches,
devices, sensors, automations, rooms, audit history, OTA history and MQTT credentials all survive
a promotion or a demotion untouched.

## 2. Shared contract (`packages/shared/src/device-role.ts`)

Exported from `@homecoreos/shared`, used by the Worker, the web console and (in behaviour) the
firmware, so all three agree on the rules:

- `DeviceRole` (`controller` | `node`), `NodeCommMode` (`espnow` | `wifi_mqtt` | `offline`),
  `NodeLinkState` (`linked` | `controller_lost` | `reconnecting` | `standalone` | `unassigned`).
- Timing contract: `ESPNOW_HEARTBEAT_INTERVAL_MS = 2 s`, `ESPNOW_LINK_TIMEOUT_MS = 10 s`,
  `ESPNOW_RECONNECT_WINDOW_MS = 45 s`, `ESPNOW_CONTROLLER_PROBE_MS = 15 s`,
  `ESPNOW_NODE_STALE_MS = 20 s`.
- Capability gates: `boardSupportsEspNow`, `boardSupportsControllerRole` (Wi-Fi radio required;
  ESP-NOW shares it).
- Presentation: `deviceStatusLabel` (the only place “Standalone Node — Controller Disconnected”
  is produced), `nodeCommModeLabel`, `deviceRoleLabel`, `isNodeStandalone`, `deriveCommMode`.
- Guards: `roleChangeBlocker`, `canAssignNodeToController` — the Worker and the console run the
  same functions, so a UI that allows something the API rejects is a bug both sides can catch.
- 7 unit tests in `packages/shared/test/device-role.test.ts`.

## 3. Database (`database/migrations/0002_device_roles.sql`)

Additive only (no table rebuild, no data loss):

| Column | Type / constraint |
|---|---|
| `device_role` | `text NOT NULL DEFAULT 'controller'`, check `controller \| node` |
| `assigned_controller_id` | `uuid` FK → `controllers(id)` `ON DELETE SET NULL`, ≠ `id`, only when `device_role='node'` |
| `comm_mode` | `espnow \| wifi_mqtt \| offline` |
| `node_link_state` | `linked \| controller_lost \| reconnecting \| standalone \| unassigned` |
| `espnow_channel` | `smallint` 1–13, `NULL` = follow the Wi-Fi STA channel |
| `node_last_linked_at`, `role_changed_at` | timestamps |

Indexes: `idx_controllers_device_role (account_id, device_role)` (partial on non-deleted rows) and
`idx_controllers_assigned_controller`. `database/verify` snapshot rebaselined
(32 tables, 5 functions, 345 seeded rows); `npm run db:verify` → *schema matches snapshot ✓*.

Because the default is `controller`, every pre-existing row keeps behaving exactly as before.

## 4. Worker (`apps/worker`)

**Role management** — `src/lib/device-roles.ts`:

- `listAttachedNodes` — Nodes hosted by one Controller.
- `changeDeviceRole` — promote/demote with the shared guards (board capability, self-reference,
  attached Nodes), audit (`controller.role_changed`), explicit release of hosted Nodes to
  `comm_mode='wifi_mqtt'` / `node_link_state='unassigned'`, and forced config sync for the device
  and the released Nodes.
- `assignNodeToController` — `null` clears the assignment; validates with
  `canAssignNodeToController` (a Node may only be hosted by an **online Controller in the same
  home**), sets `comm_mode='espnow'` + `node_link_state='reconnecting'`, audits
  (`controller.node_assigned` / `controller.node_unassigned`) and force-syncs both devices.

**Routes** — `src/routes/controllers.ts`:

| Route | Purpose |
|---|---|
| `GET /api/controllers` | now returns `device_role`, `node_comm_mode`, `node_link_state`, `assigned_controller_id`, `assigned_controller_name`, `connected_node_count`, `role_changed_at`, `node_last_linked_at` (single pass, no N+1) |
| `GET /api/controllers/:id/nodes` | Nodes hosted by a Controller (used by the demote dialog) |
| `PATCH /api/controllers/:id/role` | `{role, acknowledgeAttachedNodes}` → 409 `attached_nodes` with the affected Nodes when unacknowledged |
| `POST /api/controllers/:id/assign-controller` | `{controllerId \| null}` |
| `POST /api/controllers/:id/relink` | Node re-link request; delivered straight to a standalone Node, or relayed through its Controller when the Node has no MQTT session |
| `PATCH /api/controllers/:id` | extended with `espnowChannel` (1–13 or `null`); changing it re-syncs every hosted Node |

**Config snapshot** (`src/lib/controller-config.ts`) now carries a `role` block:

```json
"role": {
  "mode": "node",
  "assignedControllerId": "…",
  "assignedControllerMac": "AA:BB:CC:DD:EE:FF",
  "espnowChannel": 6,
  "reconnectWindowMs": 45000,
  "linkTimeoutMs": 10000,
  "nodeIds": []
}
```

`role` is part of the hashed structural payload, so any role/assignment/channel change bumps the
revision and republishes the snapshot.

**Heartbeat ingest** (`src/routes/device-api.ts`) accepts `role`/`cm`/`ls` and a Controller
`nodes[]` roster. A linked Node runs no cloud session of its own, so the Controller's roster is
what keeps its `status`, `comm_mode`, `node_link_state` and `last_heartbeat_at` honest; Nodes
missing from the roster become `controller_lost` only after `ESPNOW_NODE_STALE_MS`, and a Node
reporting its own `standalone` state is never overwritten.

**OTA** (`src/routes/firmware.ts`): `applicableUpdates` carry `deviceRole`; a Node whose MQTT
session is not connected gets the instruction relayed to its Controller
(`{action:"ota_relay", node_id, ota:{…, wifi_window:true}}`); the release/history records are the
same ones used for Controllers.

## 5. Firmware (`firmware/main`)

| File | Role |
|---|---|
| `role_logic.h/.c` | hardware-independent role state machine — link states, action bitmask, epoch-bumped command dedupe, `hc_role_can_change`. **13 host test functions** (`firmware/test/test_role_logic.c`, run in CI with `-Wall -Wextra -Werror`). |
| `role_runtime.h/.c` | glue: persisted config ↔ state machine ↔ transports. Owns the MQTT start/stop decision, the keepalive cadence, the channel sweep, the OTA window, the Controller's Node roster and the `role` block of the config snapshot. |
| `espnow_link.h/.c` | ESP-NOW transport (host + seek, peer management, 12-byte header + ≤200-byte JSON payload, RSSI). Compiled only where `HOMECORE_HAS_WIFI`. |
| `nvs_store.c` | new keys `role`, `asg_ctrl`, `asg_mac`, `esp_ch`, `node_link`, `rl_epoch`, `rl_seq`; absent → Controller (legacy behaviour). `hc_nvs_factory_reset()` erases every configuration/role key in the namespace (so a reset device returns as a Controller) and then re-writes the immutable `ident_key`, which is factory hardware identity, not setup configuration. |
| `main.c` | `hc_role_init()` after NVS load, `hc_role_tick(&s_config, 500)` in the supervision loop, role-aware cloud sync, role in the boot banner, explicit 10 s-reset log line. |
| `pairing_client.c` | applies the snapshot's `role` block, adds `role`/`cm`/`ls`/`nodes[]` to every heartbeat. |
| `mqtt_manager.c` | same role application on the MQTT snapshot path; new system actions `relink_controller` (Node), `relink_node` and `ota_relay` (Controller → ESP-NOW relay). |
| `Kconfig.projbuild` | `HOMECORE_ROLE_DEFAULT` (default `controller`) and `HOMECORE_ESPNOW_CHANNEL` (default 0 = follow the Wi-Fi channel). |
| `CMakeLists.txt` | builds `role_logic.c`, `role_runtime.c`, `espnow_link.c`; `esp_now` component added for Wi-Fi targets. |

**Boot behaviour (unchanged mechanism, role-aware):**

- BOOT held ~3 s and released → Recovery Mode (BLE + Setup AP, 15-minute window, config preserved).
- BOOT held 10 s → full factory reset: every configuration key is erased — pairing, Wi-Fi/MQTT
  credentials **and the role** — so the device reboots as an unpaired Controller and must be set up
  again. The immutable factory identity (`ident_key`) and the hardware MAC are preserved; the 10 s
  hold always wins over the 3 s recovery action.
- A plain power cycle never changes the role.

**Node link lifecycle:**

1. Boot as Node → read `assigned_controller_id`/`assigned_controller_mac` from NVS.
2. Seek the Controller (pinned channel, or sweep 1–13 when `espnow_channel` is `NULL`), keepalive
   every 2 s, adopt the Controller's channel.
3. Link lost → `controller_lost`, retry for up to 45 s with **no** MQTT session (a flapping link
   must not open a competing command channel).
4. Still lost → `standalone`, open Wi-Fi/MQTT, report `cm=wifi_mqtt`, `ls=standalone`; the console
   shows “Standalone Node — Controller Disconnected”. The Node keeps probing every 15 s.
5. Controller returns → `linked`, the fallback session is closed automatically, the epoch bumps so
   replayed commands from the fallback window cannot execute twice.
6. Switches and sensors keep working locally in every state.

## 6. Web console (`apps/web`)

`ControllersPage.tsx` is now split into **Controllers** and **Nodes** tabs (Trash keeps its own
utility tab so the existing 30-day recoverable-deletion workflow is unchanged):

- Controllers tab: the existing cards, each with a new `Nodes` row (`N linked`) and a
  **“Make this a Node”** action.
- Nodes tab: a dedicated `NodeCard` — role badge, status line from `deviceStatusLabel`, comm-mode
  badge (ESP-NOW / Wi-Fi / MQTT / Offline), hosting Controller, last-linked time, firmware, and
  actions *Assign/Change Controller*, *Re-link to Controller*, *Make this a Controller*.
- Dialogs: role change (explains the consequences), **attached-Nodes confirmation** (the Worker's
  409 is turned into “N Nodes still rely on this Controller → Release Nodes and Continue”), and a
  Controller picker that only offers online Controllers in the same home.
- Nothing else in the console changed: same navigation, same setup/recover/flash modals, same
  Firmware page and OTA flow.

## 7. OTA — EMQX only, Nodes included

- Controllers: unchanged `POST /api/firmware/ota/start` → EMQX `…/ota/cmd` → `esp_https_ota`.
- Linked Nodes (no MQTT session): the instruction is published to the **Controller's** topic as
  `ota_relay`; the Controller forwards a compact `{cmd:"ota", …}` frame over ESP-NOW; the Node opens
  a temporary Wi-Fi/EMQX window (`HC_ROLE_ACT_OTA_WINDOW`, 3 minutes) and downloads over HTTPS.
- Standalone Nodes: they already have an EMQX session, so they receive the normal `ota/cmd`.
- USB flashing continues to exist for factory recovery, but no update path requires it.

## 8. Board capability audit

Rules (`boardSupportsEspNow` / `boardSupportsControllerRole`): ESP-NOW shares the Wi-Fi radio, so a
usable **Wi-Fi radio is mandatory** for the Controller role and for ESP-NOW on a Node. A board
without Wi-Fi can neither host Nodes nor join a Controller.

| Board slug | Chip family | Module | Wi-Fi | Unified roles | Firmware status |
|---|---|---|---|---|---|
| **esp32-s3-devkitc-1-n16r8** | esp32s3 | **ESP32-S3-WROOM-1-N16R8** | yes | **Controller + Node** | **firmware_supported** |
| esp32-s3-devkitc-1-v1-0 | esp32s3 | ESP32-S3-WROOM-1-N8R8 | yes | Controller + Node | catalog_only |
| seeed-xiao-esp32s3 | esp32s3 | ESP32-S3R8 | yes | Controller + Node | catalog_only |
| waveshare-esp32-s3-zero | esp32s3 | ESP32-S3FH4R2 | yes | Controller + Node | catalog_only |
| esp32-c5-devkitc-1 | esp32c5 | ESP32-C5-WROOM-1-N8R8 | yes | Controller + Node | catalog_only |
| esp32-c6-devkitc-1 | esp32c6 | ESP32-C6-WROOM-1-N8 | yes | Controller + Node | catalog_only |
| esp32-c61-devkitc-1 | esp32c61 | ESP32-C6…/C61-WROOM-1-N8R2 | yes | Controller + Node | catalog_only |
| esp32-c3-devkitm-1 | esp32c3 | ESP32-C3-MINI-1-N4 | yes | Controller + Node | catalog_only |
| esp8684-devkitm-1 | esp32c2 | ESP8684-MINI-1-N4 | yes | Controller + Node | catalog_only |
| esp32-s2-devkitc-1 | esp32s2 | ESP32-S2-SOLO-2-N4R2 | yes | Controller + Node | catalog_only |
| esp32-devkitc-v4 | esp32 | ESP32-WROOM-32E | yes | Controller + Node | catalog_only |
| esp32-h2-devkitm-1 | esp32h2 | ESP32-H2-MINI-1-N4 | **no** | not supported (no Wi-Fi radio) | catalog_only |
| nodemcu-esp8266 | esp8266 | ESP8266EX (ESP-12E) | yes | not supported (outside the ESP-IDF v5 image) | catalog_only |

**Recommendation: ESP32-S3-WROOM-1 N16R8** (`esp32-s3-devkitc-1-n16r8`) for every Controller and
Node — it is the only board with `firmware_supported` status, has Wi-Fi + BLE for dual-transport
provisioning, 16 MB flash / 8 MB octal PSRAM for the dual-OTA layout, and enough headroom for the
ESP-NOW peer table. The other Wi-Fi boards are valid Nodes and Controllers in the catalog, but ship
as `catalog_only` until each gets a firmware build in CI. ESP32-H2 must stay Controller-less (no
Wi-Fi), and ESP8266 remains a separate legacy layer.

## 9. The ten testing scenarios

| # | Scenario | Where it is proven |
|---|---|---|
| 1 | Legacy device defaults to Controller, nothing breaks | `apps/worker/test/unified-device-roles.test.ts` — *“lists every device as a Controller by default”* |
| 2 | Controller → Node keeps the same device record (identity, pairing, firmware) | same file — *“demotes a Controller to a Node without creating a second device record”* |
| 3 | Node assignment + role published in the config snapshot | same file — *“assigns the Node to a Controller and publishes the role in its config snapshot”* |
| 4 | Controller roster keeps an MQTT-less Node visible | same file — *“keeps a Node visible through its Controller's ESP-NOW roster”* |
| 5 | Node fallback never promotes the device | same file — *“accepts a standalone Node reporting its Wi-Fi/MQTT fallback”* |
| 6 | Demoting a Controller with attached Nodes is refused until acknowledged | same file — *“refuses to demote a Controller that still hosts Nodes…”* |
| 7 | Node → Controller promotion keeps identity/history; invalid assignments rejected | same file — *“…promotes a Node back to Controller…”*, *“rejects assigning a Node to another Node or to an offline Controller”* |
| 8 | Node OTA is relayed through the Controller and stays in the shared history | same file — *“relays a Node OTA instruction…”*, *“keeps the Node OTA record in the shared update history”*. Client side: `apps/web/src/components/firmware/firmware-ota-only.test.tsx` |
| 9 | Two-tab console: Controllers vs Nodes, standalone wording, role dialogs, assign, re-link | `apps/web/src/features/user/controllers-page-roles.test.tsx` (5 tests) |
| 10 | Firmware link state machine: link/loss/reconnect/standalone/return, command dedupe, role guards | `firmware/test/test_role_logic.c` (13 functions), run in `build-firmware.yml` |

Additionally: `npm run db:verify` (schema snapshot), `firmware/scripts/verify_firmware_image.py
--verify-board-overlays firmware/boards` (21 board overlays), and the full existing suites.

## 10. Command delivery to a linked Node (ESP-NOW relay)

A linked Node has no EMQX session, so an EMQX publish to its own `cmd/switch` / `cmd/device` topic
would be accepted by the broker but never delivered. Switch, device, automation and Action Button
commands for a Node therefore go through one shared resolver
(`apps/worker/src/lib/device-command-delivery.ts`):

| Device state | Delivery |
|---|---|
| Controller | straight to its own `…/cmd/switch` or `…/cmd/device` (unchanged) |
| Node with a live MQTT session (standalone fallback) | straight to its own topic |
| Node linked over ESP-NOW (no MQTT session) | `{action:"relay_to_node", node_id, kind, payload}` on the **Controller's** `…/cmd/system`, relayed as a compact `{cmd:"exec",…}` ESP-NOW frame |

The Node executes the relayed payload through `hc_command_apply()`, the same function its own MQTT
handlers use, so there is exactly one GPIO implementation. Commands carry the Controller's epoch and
sequence number, so a replay after a link transition is rejected. The epoch is bumped on every
Controller boot and on promotion to Controller, because the transmit sequence is RAM-only.

`/api/devices`, `/api/switches`, the automation engine and the Action Button executor all use the
resolver; a missing route is reported as `mqttDispatched: false` instead of a silent publish.

## 11. Verification status & known limits

Green at time of writing:

| Gate | Result |
|---|---|
| `packages/shared` — `vitest run` | 15 files / **206 tests** |
| `packages/shared` — `tsc --noEmit` | clean |
| `apps/worker` — `vitest run` | 21 files / **85 tests** (70 before this work) |
| `apps/worker` — `typecheck` | clean |
| `apps/web` — `vitest run` | 28 files / **225 tests** (219 before this work) |
| `apps/web` — `tsc --noEmit`, `eslint` | clean |
| Firmware host tests (`gcc -Wall -Wextra -Werror`) | `role_logic`, `provisioning_logic`, `ota_boot_logic`, `io_state_logic`, `sensor_driver_logic` — all pass |
| Board overlays | 21 verified |
| `npm run db:verify` | *schema matches snapshot ✓* |

Limits, stated plainly:

- ESP-IDF is not installed in this workspace, so `firmware/main` is validated by (a) host `gcc`
  tests for every hardware-independent module, (b) a `-fsyntax-only` pass of `role_runtime.c`,
  `espnow_link.c`, `mqtt_manager.c`, `main.c`, `nvs_store.c` and `pairing_client.c` against
  ESP-IDF-shaped stub headers (the stubs were scratch files and are not part of the repository),
  and (c) the CI matrix (21 boards, IDF v5.4/v5.5.2) which is the real compiler gate. **No
  hardware has run this yet.**
- The ESP-NOW transport uses the standard IDF v5 API (`esp_now_init`, `esp_now_register_recv_cb`,
  `esp_now_peer_info_t`, `esp_now_send`); its runtime behaviour (RSSI, channel hopping, maximum
  payload) must be confirmed on real devices.
- Roles are user-driven only: no automatic Controller election exists anywhere in the codebase.

---

## 12. Repository-wide audit — 2026-11-19

A full pass over features, database, firmware and UI/UX found the unified role work sound at the
schema and API level, but five behaviour gaps and several presentation/capability conflicts. Every
item below is fixed and covered by a test where a test can reach it.

### Behaviour fixes

| # | Problem found | Fix |
|---|---|---|
| 1 | A paired Node started its own EMQX session at boot and kept it while the ESP-NOW link was healthy, because `main.c` started MQTT for every paired device and `role_runtime` only stopped sessions it had started itself. | `hc_role_wants_mqtt()` is now the single owner of the decision (Controller: always; Node: only standalone / unassigned / OTA window). `main.c` gates boot, cloud sync, BLE Wi-Fi recovery and the OTA retry loop on it, and `role_runtime` closes any stray session when the link is healthy. |
| 2 | ESP-NOW keepalives carried no identity, so the Controller's roster had no Node ids. The console could not name hosted Nodes and `relay_node` / `ota_relay` could never find a peer. | Keepalives now carry `{"id":"<device id>"}` (`hc_espnow_send_keepalive_json`); the Controller roster and the relay lookup use it. |
| 3 | Switch/device commands (dashboard, automation, Action Button) were published to a linked Node's own MQTT topic — accepted by EMQX, delivered to nobody. | New `device-command-delivery.ts` resolver plus `relay_to_node` → compact `exec` frame over ESP-NOW, executed by `hc_command_apply()` (the same GPIO code path as MQTT). |
| 4 | A Controller reporting an **empty** roster sent no `nodes` field at all, so its assigned Nodes stayed "linked" indefinitely after the link died. | The roster array is always present; the Worker reconciles when `nodes` is defined, marking stale Nodes `controller_lost`. |
| 5 | Config/role changes for a linked Node were published to EMQX (accepted, unsubscribed) and reported as delivered, so a role change could sit unseen until the next manual sync. | The heartbeat reports `sync_published:false` when the device has no MQTT session, and the firmware fetches the snapshot over HTTPS whenever it is not MQTT-connected. |
| 6 | A device could change its own `device_role` (and write Node uplink columns) through a heartbeat. | The persisted role is authoritative: mismatching reports are logged and ignored, and `comm_mode`/`node_link_state` are only applied to rows that are actually Nodes. |
| 7 | Relay dedupe could reject every command after a Controller reboot (epoch unchanged, RAM-only sequence restarted). | The epoch is bumped on Controller boot and on promotion to Controller. |
| 8 | A Node that lost its Controller never re-swept Wi-Fi channels, so a Controller that changed channel was never found again. | `hc_espnow_reseek()` restarts the 1–13 sweep on link loss when no channel is pinned. |
| 9 | The 10 s factory reset erased the immutable `ident_key` along with the configuration. | The reset preserves `ident_key` (factory identity) while erasing role, pairing, Wi-Fi and MQTT configuration. |
| 10 | The boot banner logged the role from a zeroed config (always "controller") before NVS was loaded. | The banner is emitted after `hc_nvs_load_config` / `hc_role_init`. |

### Presentation / capability fixes

- Controllers tab cards now carry an explicit **Controller** role badge (Nodes already had one).
- Node cards show the **board model** and **last activity** (the spec's Node tab fields), not only last-linked.
- `deviceStatusLabel()` never reports a lost/reconnecting Node as "Linked" — a stale `comm_mode` from
  the last roster can no longer mask a dead link — and an unassigned Node reads "No Controller
  assigned" instead of the standalone wording.
- The role capability gate is shared: the Worker uses `boardSupportsControllerRole()`, the console
  hides "Make this a Controller"/"Make this a Node" for boards without a 2.4 GHz radio (e.g. ESP32-H2).
  A board that cannot be verified is not blocked.
- The "Assign Controller" picker only offers online Controllers in the same home, matching what the
  API accepts.
- Stale-device notifications say "Node Offline" for a Node, never "Controller Offline".
- Promoting a Node clears `comm_mode`/`node_link_state` instead of leaving Node-only values on a
  Controller row.
- Role-change refusals explain the role that was requested (Controller vs Node capability).

### Firmware validation performed

`role_runtime.c`, `espnow_link.c`, `mqtt_manager.c`, `main.c`, `nvs_store.c` and `pairing_client.c`
were compiled against ESP-IDF-shaped stub headers **and**, decisively, by the real ESP-IDF build
matrix (§13). The five host C suites (role, provisioning, OTA boot, IO state, sensor driver logic)
pass. This is not a hardware run: ESP-NOW peer linking, channel re-sweep,
relayed switch execution, the EMQX OTA window and the 3 s/10 s BOOT sequences still need the physical
ESP32-S3-WROOM-1 N16R8 validation listed in §11.

## 13. Firmware build gate restored — 2026-11-19

The first firmware build of this feature on `main` failed for **20 of 21 boards**: every Wi-Fi
target broke while `esp32-h2` (which skips the Wi-Fi component block) still built. Two real defects
were hiding behind each other, and both were invisible to the stub-header syntax check that had been
used as the firmware gate:

| # | Defect | Cause | Fix |
|---|---|---|---|
| 1 | `idf_component_register` could not resolve the `main` component's requirements on every Wi-Fi target | `firmware/main/CMakeLists.txt` added `esp_now` to `REQUIRES`. ESP-IDF v5.x has **no `esp_now` component** — ESP-NOW is built into `esp_wifi`. | Removed the requirement; the comment now records why. |
| 2 | `espnow_link.c` did not compile on any Wi-Fi target | The file included only `esp_wifi.h`, but `esp_now_peer_info_t`, `esp_now_recv_info_t`, `esp_now_add_peer()`, `esp_now_is_peer_exist()` and `ESP_ERR_ESPNOW_EXIST` live in `esp_now.h`. | Added `#include "esp_now.h"`. |

Two further issues found while re-validating the relay path:

- The relayed OTA instruction (`{"cmd":"ota","ota":{release_id,history_id,version}}`) also carried
  `epoch`/`seq` even though the ESP-NOW frame header already transports both. With two UUIDs plus a
  version string it could reach the `HC_ESPNOW_MAX_PAYLOAD` (200 byte) limit and fail silently. The
  JSON is now header-free, buffers are sized from `HC_ESPNOW_MAX_PAYLOAD`, and an instruction that
  genuinely does not fit is logged instead of dropped in silence.
- A Node demoted from Controller kept no cloud session even when it had no Controller to link to.
  The session is now closed only when the Node actually has an assigned Controller.
- `comm_mode` reported "offline" for a linked Node while its STA was between router associations;
  a healthy ESP-NOW link now wins over the Wi-Fi state.
- The Controllers card's "N linked" (and the assignment picker) counted *assigned* Nodes, so a Node
  that had lost its Controller still appeared hosted. It now requires `node_link_state = linked`
  **and** an online Node, matching what the card claims.
- The OTA boot logic now has an explicit regression test for an **interrupted** update (a pending
  record without a booted image resolves as a rollback, never as success).

Build-log visibility: the workflow now tees the ESP-IDF build to `firmware/build.log` and, when a
build fails, republishes the compiler/CMake errors as check-run annotations, so a red firmware matrix
states its cause in the Checks UI instead of only inside the raw log.

Verification runs (all on `arena/ab75b390-homecoreos`, dispatched with `board_slug=all`):

- 21/21 boards built, verified, packaged and manifest-checked:
  `esp32`, `esp32s2`, `esp32s3` (5 profiles), `esp32c2`, `esp32c3` (3), `esp32c5` (2), `esp32c6` (3),
  `esp32c61`, `esp32h2`.
- Per board: `verify_firmware_image.py --verify-build` (dual-OTA slots, `otadata`, `nvs`, app fits
  its slot, sdkconfig partition scheme/flash/PSRAM agreement), USB factory image merge, release
  archive + SHA-256 driver manifest, and `--verify-package`.

Physical hardware items in §11 remain open — the matrix proves the firmware compiles, links and
packages for every supported profile, not that the radio behaves.
