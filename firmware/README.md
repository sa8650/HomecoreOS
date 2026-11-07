# Helios ESP32 firmware

`helios_esp32/helios_esp32.ino` is an Arduino-ESP32 (ESP-IDF underneath) reference firmware. It implements the production protocol used by the Worker and the local simulator.

## What it does

| Area | Implementation |
|---|---|
| Pairing | Single-use token → `POST /api/device/claim` → unique MQTT username/password/client id stored in NVS |
| Transport | Outbound MQTT over TLS (port 8883) to EMQX; no router port forwarding |
| Topics | `v1/tenants/{tenant_id}/devices/{device_id}/{command,config,state,telemetry,availability}` |
| ACL | Subscribe only `command` + `config`; publish only `state`, `telemetry`, `availability` |
| Commands | `command_id` dedupe, `expires_at` enforcement, `(requested_state, actual_state, status)` acknowledgement |
| State | Never shows ON from a button click: only ESP32-reported state is authoritative |
| Config | Versioned master config from Website/DB, validated before apply, last-known-good in NVS, ack on `state` topic |
| Telemetry | One aggregated `schema_version: 1` message, event-driven changes + reporting interval |
| Local safety | Pump dry-run / overflow / emergency shutdown rules run locally with no internet |
| OTA | HTTP download from the Worker, streaming SHA-256 verification, `Update` + `esp_ota_mark_app_valid_cancel_rollback`, rollback on failure |
| Reconnect | Exponential-ish retry, LWT `offline`, HTTPS config re-fetch, full state resync |

## Provisioning methods

| Method | Status | Notes |
|---|---|---|
| MQTT over TLS | Working | Primary worldwide cloud control path |
| MQTT over WSS | Supported by backend config | Use the WSS endpoint when port 8883 is blocked |
| SoftAP | Working | Temporary AP + local form for Wi-Fi credentials and pairing token; provisioning only |
| USB serial | Working | Send `TOKEN=<pairing-token>` over serial; also used for recovery/flashing |
| BLE | Not implemented | Roadmap: nearby discovery and credential hand-off only, never a cloud control path |
| LAN | Not implemented in firmware | A local gateway is required; it is not a substitute for cloud control |

## Build

1. Install Arduino IDE 2.x or `arduino-cli` with `esp32:esp32` core (ESP-IDF 5.x based).
2. Libraries: `PubSubClient`, `ArduinoJson` v7, `HTTPClient` (built in), `WebServer` (built in).
3. Set `HELIOS_API_BASE` in the sketch to your Cloudflare Worker URL.
4. Copy `ca_cert.cpp.example` → `ca_cert.cpp` and paste the **root CA of your EMQX Cloud deployment** (deployment overview → TLS certificate). `ca_cert.cpp` is gitignored.
5. Select your board (ESP32 / S3 / C3 / C6 DevKit) and partition scheme with **two OTA app slots** (e.g. `default_8MB.csv` or `min_spiffs.csv` with OTA).
6. Flash over USB serial. On first boot, either send `TOKEN=...` over serial or connect to the `Helios-Setup-XXXX` access point.
7. Generate a one-time pairing token in **Device Setup Wizard** in the customer console. Tokens expire (default 15 min) and are single-use.

## ESP-IDF native notes

For a pure ESP-IDF build:

- Use `esp_mqtt_client` with `esp_mqtt_client_config_t.credentials` and `broker.verification.certificate` for TLS.
- Use `esp_ota_begin` / `esp_ota_write` / `esp_ota_end` / `esp_ota_set_boot_partition`, plus `esp_ota_mark_app_valid_cancel_rollback()` after a successful boot and `esp_ota_mark_app_invalid_rollback_and_reboot()` on verification failure.
- Use `nvs_set_str` for the last-known-good configuration and `mbedtls_md` for SHA-256.
- Keep the same topic contract and JSON schemas from `packages/core/src/protocol.ts`.

## Never do this

- Never flash a shared MQTT admin credential.
- Never derive `tenant_id` from a JSON payload.
- Never publish retained ON/OFF commands.
- Never let a cloud automation override a local safety interlock.
