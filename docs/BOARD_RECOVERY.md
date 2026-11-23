# Board setup, repair and recovery

This document describes the implemented Wi-Fi / BLE / USB setup and repair
flows, the shared diagnostic engine they all use, and what still requires
physical-board validation.

## Architecture

```
packages/shared/src/recovery.ts          pure engine: diagnostics → plan → verify → report
packages/shared/src/recovery-protocol.ts protocol v1 parsing ↔ telemetry
apps/web/src/lib/recovery-engine.ts      browser orchestration (11 steps, 3 transports)
apps/web/src/lib/recovery-transport.ts   Wi-Fi portal / BLE relay / USB serial adapters
apps/web/src/components/controllers/      setup + recovery UI
apps/worker/src/routes/recovery.ts       account-scoped sessions, independent verification
apps/worker/src/lib/recovery.ts          server-side telemetry from the board's own rows
firmware/main/recovery_logic.c           the board's answers (host-tested)
firmware/main/recovery_console.c         repair execution (USB / BLE / portal)
firmware/main/wifi_portal.c              local setup & recovery page + /api/recovery
firmware/main/ble_provisioning.c         encrypted BLE channel
```

The same eleven steps run for all three transports, so a report is comparable
no matter how the browser reached the board:

`detect → read → wifi_check → backend_check → link_check → system_check → plan
→ repair → restart → verify → report`

## Setup

### Setup with Wi-Fi

1. Add Board → **Setup Board** → **Setup with Wi-Fi**.
2. Choose the board model and, if you want, a name, then press
   **Generate Pairing Code**. The website creates the board record and shows a
   single-use 6-digit code plus this website's URL.
3. Power the board (a freshly flashed board opens its temporary network
   immediately) and join **HomecoreOS-Setup-XXXX** in your OS Wi-Fi settings.
4. Open `http://192.168.4.1` and enter **SSID / Password / Website URL / Pairing
   Code**, then **Save and Restart**.
5. The board saves, restarts its Wi-Fi connection, pairs through the Worker,
   authenticates with EMQX, and closes its temporary Wi-Fi by itself. The modal
   watches the account record and only reports success once the board is paired
   **and** connected to MQTT.

A board whose ID already exists under the account resolves to that record (see
migration `0007`); no second board is created, and devices, rooms, sensors,
switches and Nodes are preserved.

### Setup with BLE

1. **Setup Board** → **Setup with BLE** → **Discover BLE Board** (animated
   discovery, then Web Bluetooth chooser).
2. The board is identified, paired and authenticated automatically; the code
   the browser needs is created by the website behind the scenes.
3. Enter **Wi-Fi SSID** and **Password** only, then **Save & Connect**.
4. The board saves the credentials, the website URL and the MQTT material,
   restarts, verifies MQTT, and turns BLE off. The same board ID is updated.

### Setup with Wi-Fi when BLE is unavailable

The Wi-Fi setup panel is the fallback offered when Web Bluetooth is missing or
permission is denied. It shows the exact network name to join and the local page
address, so nothing has to be guessed.

## Repair / recovery

Open **Repair / Recover Board** and choose a transport. No board dropdown is
needed: discovery identifies the board and matches it to exactly one account
record. Unknown, missing or ambiguous identities stop the flow rather than
picking the first record.

Diagnostics check, in this order: board identity, recovery access, Wi-Fi
configuration/connection/signal/DHCP, internet, Worker reachability, the **server
URL stored on the board**, pairing, MQTT, **ESP-NOW**, the **local webpage and
temporary Wi-Fi**, heartbeat, **firmware validity and information**, **OTA
capability**, configuration revision, entities, Nodes and recorded errors.

A fact the board does not report is reported as *unable to verify*, never as a
pass and never as a failure. The server re-runs the same diagnosis on its own
rows, so a browser cannot declare success on its own.

### Repair with BLE

1. Hold BOOT / Recovery for 3 seconds. Both the BLE interface and the temporary
   Wi-Fi network open.
2. Press **Discover BLE Board** and pick the board.
3. Diagnosis runs automatically. Ordinary, credential-free repairs run without
   further input; a Wi-Fi change asks for the SSID/password first, and a
   re-pairing repair is a separate, explicitly labelled action.
4. The plan is applied, the board **restarts**, and verification runs against
   fresh telemetry (a small `uptime_sec` is what proves the restart).
5. A short report lists what was found, what was applied, what was verified and
   what remains unresolved. BLE then closes.

### Repair with Wi-Fi

1. In the website, choose the board (or "deleted / not listed") and press
   **Generate Recovery Code**. The 6-digit code and this website's URL are shown;
   the code is single-use and is bound to that board.
2. Hold BOOT / Recovery for 3 seconds, join **HomecoreOS-Setup-XXXX**, open
   `http://192.168.4.1`.
3. On the local page enter **only what is needed**: SSID/password when the
   network changed, the website URL when it is missing or wrong, and the
   recovery code. Then **Save and Restart**.
4. The board repairs itself, restarts with its existing board ID, reconnects to
   MQTT and closes the temporary Wi-Fi automatically. The website reports
   success only once that has actually happened.

### Leaving recovery mode (all three transports)

Exactly one place owns the temporary interfaces (`apply_interface_plan` in
`firmware/main/main.c`): it compares the provisioning mode against what is
actually running and opens or closes the AP and BLE to match. Every exit — a
completed pairing, a Wi-Fi-only repair, a local-page save, a USB/BLE `restart`
repair, the 15-minute timeout and an unpair — reaches it, so no path can leave
the AP or BLE advertising behind. On the way out the board also restores the
cloud transport its role uses: MQTT for a Controller (or a standalone/unassigned
Node), and an ESP-NOW re-link for a linked Node, which deliberately runs no EMQX
session of its own.

Two consequences worth knowing:

- A board that is still **unprovisioned** when recovery times out keeps BLE and
  the setup AP up — they are how setup gets finished — but the recovery session
  itself ends and its 15-minute window restarts from zero.
- Opening BLE on a NORMAL board needs the BLE controller memory, which NORMAL
  operation releases to save RAM. NimBLE cannot be re-initialised in place, so
  the board persists the recovery request and restarts once instead of reporting
  a recovery mode whose BLE never came up.

### Repair with USB

Same steps over Web Serial (115200 baud, running HomecoreOS firmware — not the
ROM bootloader). **No button press is needed**: the installed firmware answers
`HC PING`/`HC HELLO` on whichever USB port carries its console (UART0 on a
USB-UART bridge board, USB-Serial-JTAG on a native-USB board). A BOOT press is
only useful if the console is silent *and* the board is otherwise stuck. Flashing
is never part of repair.

## What recovery never does

- **It never flashes or updates firmware.** A firmware problem is reported with
  its reason and the Flash Board workflow is offered as a *separate* action.
  Flash Board itself is unchanged.
- It never re-pairs without explicit consent and physical recovery mode.
- It never transfers board ownership and never introduces a duplicate board
  record; an existing board ID is updated in place and its devices, nodes,
  rooms and configuration are preserved.
- It never treats a sent command, a password write or an unknown telemetry
  value as success.

## Device protocol (v1)

Newline-delimited ASCII lines: `HC PING`, `HC HELLO`, `HC STATUS`,
`HC REPAIR {json}`. Repair actions are `wifi`, `mqtt`, `config`, `espnow`,
`restart`, `pair` and `factory_reset`. Every field added for the expanded
diagnostics is optional and additive: an older image simply omits it and the
console reports Unknown.

- **Wi-Fi**: `GET /api/recovery` returns `{recovery, status}` in one round trip;
  `POST /api/recovery` accepts `{"command":"HC …"}`. Reads are cache-busted
  (`?t=…`) so a post-repair status is never served from cache.
- **BLE**: encrypted command action `hc HC …`; responses arrive as
  `{chunk:{i,n,d}}` notifications (150-byte chunks, up to ten).
- **USB**: one JSON response per line; boot log lines are ignored.

### Status fields

`hc` `proto` `mode` `fw` `paired` `wifi_connected` `ssid` `rssi` `ip`
`wifi_error` `mqtt_connected` `mqtt_error` `backend_reachable`
`backend_authenticated` `backend_ok` `config_revision` `synced_config_revision`
`pending_config` `heartbeat_age_sec` `heartbeat_interval_sec`
`entities_known` `sensors_total` `sensors_reporting` `switches_total`
`switches_reporting` `nodes_known` `nodes_total` `nodes_linked`
`board` `partition` `uptime_sec` `free_heap` `backend_url`
`ota_supported` `ota_pending` `ota_error`
`has_wifi` `has_ble` `espnow_supported` `espnow_link`
`last_error`

`HC HELLO` adds `uid_suffix` and `partition`.

The heartbeat the board posts to the Worker carries the same facts (short keys
`up`, `heap`, `bu`, `os`, `oe`, `es`, `els`, `sw`, `sb`), and they are stored in
`board_instances` (migration `0008_board_recovery_health.sql`). The server can
therefore diagnose a board that is offline even when no local transport is in
use.

## Database

| Migration | Purpose |
| --- | --- |
| `0006_recovery_sessions.sql` | recovery sessions, events, reports |
| `0007_pairing_identity_reuse.sql` | resolve a provisional setup slot to the installed board under the same account |
| `0008_board_recovery_health.sql` | additive, nullable health facts (`uptime_sec`, `backend_url`, OTA/ESP-NOW/radio state, partition) |

Migrations are not applied automatically by the code change; apply them before
deploying the Worker. Existing columns keep their meaning, so already-installed
boards keep working and simply report Unknown for the new facts until they run
the updated firmware.

## API

All routes require an authenticated owner/administrator session and enforce
account scope.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/recovery/sessions` | Start/resume a 15-minute session (`boardInstanceId`, `transport`, optional `websiteUrl`) |
| GET | `/api/recovery/sessions/:id` | Session, events and server diagnostics |
| POST | `/api/recovery/sessions/:id/diagnostics` | Structured checks, stage and plan inputs; never credentials |
| POST | `/api/recovery/sessions/:id/complete` | Action outcomes; the server verifies health independently |
| POST | `/api/recovery/sessions/:id/abandon` | Cancel with a sanitized reason |
| GET | `/api/recovery/history` | Paginated account history, optionally filtered by board |
| GET | `/api/admin/accounts/:id/recovery-history` | Admin-only summary, latest 20 records; read-only |

401/403/404/409/410 never allow falling back to local repairs. A server outage
allows ordinary local diagnosis/repair but never a re-pair, and the report says
it is local-only.

## Safety

- Credentials stay in the current browser flow; diagnostics never store them.
- Unknown telemetry is neither a pass nor a fail.
- A repair command is sent exactly once: a lost acknowledgement is not proof a
  mutation failed, so a retry requires a fresh diagnosis.
- Sessions expire after 900 seconds; cancelling releases the transport and
  abandons the session.
- Re-pairing requires physical recovery mode plus a single-use code. A stored
  `physical_confirmed` flag from an earlier setup is not authorization.

## Browser / hardware compatibility

- **Wi-Fi** needs a board with a Wi-Fi radio and an OS-level choice of
  `HomecoreOS-Setup-XXXX`. HTTPS→HTTP portal access can be blocked by
  mixed-content/private-network policy; permit local network access, or use
  BLE/USB.
- **BLE** needs the board's BLE radio, a secure context and Web Bluetooth
  (Chrome/Edge desktop or Android; not Safari/iOS). The link is framed by both
  sides against the *negotiated* ATT MTU, so it works on platforms that stay at
  the 23-byte default (Chrome on Windows and many Android builds) instead of
  failing on a long GATT operation. See **Bluetooth: "GATT operation failed for
  unknown reason"** below.
- **USB** needs Web Serial in a secure desktop Chromium browser and the running
  firmware's console. The console task follows the board's configured transport:
  `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG` boards are read and answered over
  USB-Serial-JTAG, everything else over UART0 at 115200 baud. Classic ESP32 and
  ESP32-S2 boards only expose a USB port through an on-board USB-UART bridge, so
  they need that bridge to be present and its driver installed. A visible port is
  not proof it carries the console — if `HC PING` stays silent, try the other port
  the board exposes. ESP8266 and ROM download mode do not implement this
  protocol.

### Bluetooth: "GATT operation failed for unknown reason"

This was a real defect in earlier local builds, not a board fault: the security
handshake wrote a 66-byte Client Hello and read a 130-byte Device Hello as single
GATT operations. A BLE operation carries at most `ATT_MTU - 3` bytes, the default
MTU is 23, and Chrome turns the refused long write/read into exactly that
message. The banner title came from the UI, so the underlying failure was
invisible.

Both sides now frame every value and never exceed the budget
(`firmware/main/ble_protocol_logic.c`, `apps/web/src/lib/ble-provisioning.ts`):

- writes use `[0x10][len:2][offset:2][slice…]`, reads are served as
  `[0x20][len:2][offset:2][slice…]`, notifications as
  `[0x30][index][total:2][slice…]`;
- a value that fits one packet is still sent unframed, so a link that did
  negotiate a large MTU is unaffected;
- fragments always contain ciphertext, never plaintext — AES-GCM still
  authenticates the whole message after the page joins the pieces;
- the board reports its negotiated MTU as `att_mtu` in the device-info JSON, and
  the page sizes its writes from it (falling back to 20 bytes without it).

If the symptom persists on a board flashed **before** this change, the firmware
is the old one: re-flash from **Flash Board**. The message the page shows is now
classified — a transient link failure suggests moving closer and retrying, and
the panel always offers **Setup with Wi-Fi** so a Bluetooth problem is never a
dead end.

Related, not fixable in software: a reconnect within a few seconds of
disconnecting can land on the OS's still-dying link and fail. Waiting a moment
and pressing **Discover BLE Board** again connects normally.

## Validation performed

```bash
npm --workspace=packages/shared run test      # engine + protocol + plan/verify
npm --workspace=apps/worker run test          # sessions, heartbeat facts, URL compare
npm --workspace=apps/web run test             # UI flows, engine, transports
gcc -Wall -Wextra -Werror -std=c11 firmware/test/test_ble_protocol_logic.c \
    firmware/main/ble_protocol_logic.c -o /tmp/ble-test && /tmp/ble-test
npm run typecheck

gcc -Wall -Wextra -Werror -std=c11 firmware/test/test_recovery_logic.c firmware/main/recovery_logic.c -o /tmp/t && /tmp/t
gcc -Wall -Wextra -Werror -std=c11 firmware/test/test_provisioning_logic.c firmware/main/provisioning_logic.c -o /tmp/t && /tmp/t
# …plus io_state, ota_boot, role, sensor_driver suites (see CI)
python3 firmware/scripts/verify_firmware_image.py --verify-board-overlays firmware/boards
```

**ESP-IDF is not available in this environment**, so target compilation was not
run here; the CI workflow compiles every board overlay. Everything above is
simulated/host-side.

## Requires physical-board testing

- Holding BOOT for exactly 3 seconds opening **both** the temporary AP and BLE,
  and the 10-second factory reset still working.
- Joining `HomecoreOS-Setup-XXXX` from Android/iOS/desktop and reaching
  `192.168.4.1`; mixed-content and private-network policies vary by browser.
- The portal's "Save and Restart" closing the AP by itself after the cloud
  confirms the board, and the 3-minute fallback (180 s) leaving it open otherwise.
- The restart stage over each transport (USB line drop, BLE disconnect, portal
  connection loss) and `uptime_sec` resetting.
- Every exit from Recovery Mode closing **both** the setup AP and BLE, and the
  station re-joining its saved network afterwards: a completed pairing, a
  Wi-Fi-only repair, a local-page save, a `restart` repair over USB/BLE, the
  15-minute timeout and an unpair.
- A NORMAL board with BT memory reclaimed re-entering Recovery Mode: it should
  restart once, come back with BLE advertising, and keep its pairing.
- USB repair on a native-USB board reading and answering on USB-Serial-JTAG
  (and on a USB-UART bridge board over UART0), including a browser that has to
  release the port before `idf.py monitor` can use it again.
- Real Wi-Fi password rejection, weak-signal and DHCP-failure classification;
  ESP-NOW relink between a Controller and its Nodes; OTA pending-verify state.
- Web Bluetooth handshake/chunking on the board's real NimBLE stack at the
  default 23-byte MTU (the framing above is host-tested, but notification
  ordering, retries on a busy GATT queue and reconnect-after-disconnect can only
  be observed on a real link), and USB serial ownership after the browser
  releases it.
- EMQX credential rotation during re-pairing, and Supabase migration `0008`
  applied to a real database.
