# HomecoreOS firmware: setup, repair and recovery

The running ESP-IDF firmware implements protocol v1 in
`main/recovery_logic.{h,c}` and `main/recovery_console.{h,c}`, the local setup
page in `main/wifi_portal.c`, and the encrypted provisioning channel in
`main/ble_provisioning.c`. This is an application-level setup/repair console,
**not** an esptool/ROM flashing protocol. ESP8266 has an isolated firmware
profile and is not supported by this console.

## Transports

- UART0, 115200 baud, newline-terminated commands and JSON responses. USB-UART
  bridge boards are the initial target. Native USB CDC/JTAG-only boards need
  explicit port-routing validation; selecting a serial port does not prove it
  carries UART0.
- Temporary Wi-Fi AP at `http://192.168.4.1`:
  - `/` — the local setup & recovery page. SSID, password, website URL and the
    6-digit pairing/recovery code, then **Save and Restart**. Submitting stores
    the values, reconnects the station, and asks the supervisor to close the AP
    once HomecoreOS confirms the board.
  - `GET /api/recovery` — discovery + status in one round trip
    (`{"recovery":{…},"status":{…}}`), cache-busted by the browser.
  - `POST /api/recovery` — `{"command":"HC …"}`; the exact same line parser and
    guards as USB and BLE.
- Encrypted BLE provisioning service: `action: "hc HC ..."`. The BLE handler
  removes the lowercase relay prefix and forwards the inner command to the same
  console handler. Responses may use up to ten 150-byte chunks (the status
  payload now also carries running-image and capability facts).

## Commands

`HC PING`, `HC HELLO`, `HC STATUS`, `HC REPAIR {json}`. Repair actions are
`wifi`, `mqtt`, `config`, `espnow`, `restart`, `pair` and `factory_reset`.
Mutations are guarded against simultaneous local transport execution.

- `wifi`, `mqtt`, `config`, `espnow` and `restart` are ordinary repairs: no BOOT
  press, no confirmation, and they preserve pairing, identity, board capacity
  and every device/Node assignment. `espnow` re-opens the radio and re-syncs the
  role block so a Controller and its Nodes find each other again.
- `pair` (re-pairing) rotates MQTT credentials, so it requires the board to be in
  its *current* physical recovery mode plus a single-use 6-digit code.
- `factory_reset` additionally requires explicit confirmation and is never
  chosen by the browser recovery engine.

Recovery **never writes or updates firmware**. `restart` acknowledges before
rebooting; the portal and BLE paths only restart once the acknowledgement is on
the wire.

## Snapshot published to every transport

`publish_recovery_snapshot()` in `main.c` measures, and only measures:

- identity: board slug, chip, firmware version (from the app description),
  hardware UID (only the last four hex characters are transmitted in `HELLO`);
- the running image: partition label, `uptime_sec`, `free_heap`, OTA
  support (does a second app slot exist?), OTA pending-verify and its reason;
- `backend_url` exactly as stored, so the website can detect a missing or stale
  endpoint and repair it;
- radios: Wi-Fi, BLE, ESP-NOW availability and the ESP-NOW link state
  (`linked` / `controller_lost` / `reconnecting` / `standalone` / `unassigned`);
- entities: real sensor and switch counts from the IO manager, and Node counts
  from the role runtime, or `*_known: false` when they cannot be counted.

A field the image does not fill in is omitted, and the console reports *unable
to verify* rather than inventing a failure. There is no path by which a
password, identity key or setup PIN appears in a status answer.

The same facts are posted with the heartbeat (`up`, `heap`, `bu`, `os`, `oe`,
`es`, `els`, `sw`, `sb`) and stored in `board_instances`, so the Worker can
diagnose a board that is offline.

## Entering recovery

Hold BOOT / Recovery for 3 seconds while HomecoreOS is running: this opens
**both** the temporary Wi-Fi network and BLE, preserving all saved settings.
Holding for 10 seconds is still the factory reset. A board in ROM download mode
will not answer these commands. Close Arduino/idf.py/esptool serial monitors
before opening browser USB recovery.

## Host validation

```sh
gcc -Wall -Wextra -Werror -std=c11 firmware/test/test_recovery_logic.c firmware/main/recovery_logic.c -o /tmp/recovery-test && /tmp/recovery-test
gcc -Wall -Wextra -Werror -std=c11 firmware/test/test_provisioning_logic.c firmware/main/provisioning_logic.c -o /tmp/prov-test && /tmp/prov-test
```

Host tests validate parsing, action gating (including that a 3-second press
opens both temporary interfaces and that `espnow` needs no confirmation),
JSON formatting, escaping/redaction, and that the status/heartbeat field names
stay stable. They do not validate ESP-IDF integration or real peripherals.

The board matrix/build pipeline is `.github/workflows/build-firmware.yml`; it
compiles every overlay. ESP-IDF is not installed in the development environment
used for this change, so an on-target build and real UART/BLE/AP tests are still
required. Confirm:

- ordinary network repairs never alter board identity, NVS assignments or MQTT
  credentials;
- the AP and BLE both close after "Save and Restart" once the cloud confirms the
  board, and stay open if it never does;
- interrupting a repair releases browser serial/GATT resources, and a repeat
  attempt starts with diagnosis rather than replaying a mutation.

Operator steps, API contracts, architecture, migrations, browser/hardware
compatibility and troubleshooting: [Board Setup, Repair and
Recovery](../docs/BOARD_RECOVERY.md).
