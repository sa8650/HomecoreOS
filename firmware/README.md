# HomecoreOS firmware: recovery console

The running ESP-IDF firmware implements protocol v1 in `main/recovery_logic.{h,c}` and `main/recovery_console.{h,c}`. This is an application-level repair console, **not** an esptool/ROM flashing protocol. ESP8266 has an isolated firmware profile and is not supported by this console.

## Transports

- UART0, 115200 baud, newline-terminated commands and JSON responses. USB-UART bridge boards are the initial target. Native USB CDC/JTAG-only boards need explicit port-routing validation; selecting a serial port does not prove it carries UART0.
- Temporary Wi-Fi AP: GET/POST `/api/recovery`.
- Encrypted BLE provisioning service: `action: "hc HC ..."`. The BLE handler removes the lowercase relay prefix and forwards the inner command to the same console handler. Responses may use up to eight 150-byte chunks.

Commands: `HC PING`, `HC HELLO`, `HC STATUS`, `HC REPAIR {json}`. Mutations are guarded against simultaneous local transport execution. Ordinary Wi-Fi, MQTT and configuration repairs preserve pairing and installed assignments. Account re-pair and factory reset require current recovery mode; remembered setup confirmation cannot authorize them. Factory reset additionally requires explicit confirmation and is never selected by the browser recovery engine.

To enter application recovery, use the board's physical BOOT / recovery gesture while HomecoreOS is running. A ROM download-mode board will not answer these commands. Close Arduino/idf.py/esptool serial monitors before opening browser USB recovery.

## Host validation

```sh
gcc -Wall -Wextra -Werror -std=c11 firmware/test/test_recovery_logic.c firmware/main/recovery_logic.c -o /tmp/recovery-test
/tmp/recovery-test
```

Host tests validate parsing, gating, formatting and redaction, not ESP-IDF integration or real peripherals. The board matrix/build pipeline is `.github/workflows/build-firmware.yml`; production validation must include an ESP-IDF build plus real UART/BLE/AP tests. Confirm recovery does not alter board identity, NVS assignments or MQTT credentials during ordinary network repairs. Verify interrupting a repair releases browser serial/GATT resources and a repeat attempt starts with diagnosis rather than replaying a mutation.

Operator steps, API contracts, architecture, browser/hardware compatibility and troubleshooting: [Unified Board Recovery](../docs/BOARD_RECOVERY.md).
