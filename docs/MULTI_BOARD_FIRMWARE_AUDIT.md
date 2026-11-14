# HomecoreOS Multi-Board Firmware Architecture & Gap Audit

Date: 2026-11-10

This document captures the Step 1 & Step 2 audit of HomecoreOS's existing firmware pipeline, database schema, R2 storage layout, Web Serial USB flasher, OTA system, and board catalog, alongside the target multi-board compatibility specification for all 11 cataloged hardware boards.

---

## 1. Existing Functionality Inventory

### 1.1 Board Catalog & Hardware Profiles (`packages/shared`, `database/migrations/0008_*`)
- `VERIFIED_BOARD_CATALOG` defines **11 hardware boards** across 9 chip families (`esp32s3`, `esp32c6`, `esp32c3`, `esp32`, `esp32s2`, `esp32c5`, `esp32c61`, `esp32c2`, `esp32h2`), with complete GPIO pin definitions, header layouts (`J1`/`J3`/`P1`/`P2`), USB VID/PID, flash/PSRAM sizes, and `BoardVectorSvg` hardware specs.
- Only `esp32-s3-devkitc-1-n16r8` currently has `firmware_status = 'firmware_supported'`. All other 10 boards are seeded as `'catalog_only'`.
- `SUPPORTED_CHIP_FAMILIES` in `packages/shared/src/index.ts` enumerates 13 chip families (`esp32`, `esp32s2`, `esp32s3`, `esp32s31`, `esp32c2`, `esp32c3`, `esp32c5`, `esp32c6`, `esp32c61`, `esp32h2`, `esp32h21`, `esp32h4`, `esp32p4`).

### 1.2 ESP-IDF Firmware & CI (`firmware/`, `.github/workflows/build-firmware.yml`)
- `firmware/main/` implements modular ESP-IDF v5.4 C modules:
  - `main.c`: BOOT button hold detection (3s AP/recovery, 10s factory reset), supervision loop, local offline rule evaluation, periodic heartbeat/telemetry.
  - `nvs_store.c`: Persistent `identity_key` (preserved across Wi-Fi changes and re-pairing), NVS credentials, cached IO/automation JSON.
  - `wifi_portal.c`: SoftAP + STA portal (`HomecoreOS-Setup-XXXX` at `192.168.4.1`), Wi-Fi-only update without clearing pairing, exponential backoff reconnect.
  - `pairing_client.c`: HTTP `/api/device/pair`, `/api/device/recover-pair`, `/api/device/config`, `/api/device/heartbeat`, `/api/device/telemetry`.
  - `io_manager.c`: Dynamic GPIO binding from cloud config snapshot (`switches`, `devices`, `sensors`, `localAutomations`).
  - `mqtt_manager.c`: EMQX TLS 8883 client, command handlers, consolidated config snapshot sync + ack, OTA trigger listener.
  - `ota_manager.c`: Streaming `esp_https_ota` with Bearer device token, progress callbacks (`/api/device/ota/progress`), and `esp_ota_mark_app_valid_cancel_rollback()` confirmation after MQTT/Wi-Fi verification.
- `.github/workflows/build-firmware.yml` currently contains a single `build-esp32s3` job targeting `esp32s3` with 16MB flash + 8MB Octal PSRAM and emits `homecoreos-esp32s3-v<ver>.zip`.

### 1.3 Database, R2 Storage & Worker API (`database/migrations/`, `apps/worker/`)
- `firmware_releases` stores release metadata, `chip_family`, `compatible_board_ids UUID[]`, `compatible_board_slugs TEXT[]`, and `status IN ('draft', 'published', 'archived')`.
- `firmware_files` stores individual `usb_factory` and `ota_app` binary references in private R2 (`FIRMWARE_BUCKET`), SHA-256 checksums, `flash_address`, `flash_mode`, `flash_freq`, and `flash_size`.
- `apps/worker/src/lib/r2.ts` stores binaries under `firmware/{chipFamily}/{version}/{releaseId}/{fileName}` with strict private bucket access and streaming downloads.
- `apps/worker/src/routes/firmware.ts` serves user catalog listings, single/manifest USB download payloads (including `manifest` endpoint returning SHA-256 + flash offsets), and triggers EMQX OTA updates (`POST /api/firmware/ota/start`).
- `apps/worker/src/routes/device-api.ts` validates device Bearer token, chip family, and board compatibility before streaming `ota_app` binary (`GET /api/device/firmware/ota/:releaseId`) and logs state transitions to `firmware_update_history`.

### 1.4 Web Serial USB Flasher & UI (`apps/web/`)
- `apps/web/src/lib/usb-flasher.ts` uses Web Serial + `esptool-js@0.7.1` to connect, detect chip, parse merged/split binaries, write flash with progress callbacks, and hard-reset via RTS/DTR.
- `FirmwarePage.tsx`, `ControllersPage.tsx`, and `ControllerSetupWizard.tsx` expose USB flashing, setup guidance, and OTA updates.
- `AdminFirmwareEmqxUsageSettingsPages.tsx` provides single `.bin` upload, `.zip` package upload, board compatibility multi-select, publish, archive, and delete actions.

---

## 2. Identified Missing Components & Hardware Compatibility Risks

### 2.1 Firmware & Build Matrix Gaps
1. **Single-target partition table**: `firmware/partitions.csv` allocates two 3MB OTA slots (`0x20000` and `0x320000`), which exceeds 4MB flash (`0x400000`) and leaves tight margin on 8MB. Dedicated `partitions_4mb.csv`, `partitions_8mb.csv`, and `partitions_16mb.csv` are needed while keeping `nvs` (`0x9000` `0x6000`), `otadata` (`0xf000` `0x2000`), `phy_init` (`0x11000` `0x1000`), and `ota_0` (`0x20000`) aligned across all tables so NVS identity/Wi-Fi/MQTT persist safely.
2. **Hardcoded S3 GPIO & BOOT button assumptions**:
   - `HOMECORE_BOOT_BUTTON_GPIO` is hardcoded to `0`, whereas RISC-V targets (`esp32c2`, `esp32c3`, `esp32c5`, `esp32c6`, `esp32c61`, `esp32h2`) use `GPIO 9` as the BOOT/strapping button.
   - `hc_io_is_safe_gpio()` in `io_manager.c` applies ESP32-S3 SPI flash/PSRAM pin exclusions (`22-37`) uniformly to all chips, blocking valid GPIOs on ESP32/S2/C3/C6 and permitting invalid high GPIOs (`> max_gpio`) on smaller pin-count chips.
3. **No-Wi-Fi Silicon (`esp32-h2-devkitm-1` / `esp32h2`)**: ESP32-H2 has IEEE 802.15.4 + BLE 5.3 only (`CONFIG_SOC_WIFI_SUPPORTED == 0`). `wifi_portal.c`, `pairing_client.c`, and `main.c` call `esp_wifi.h` unconditionally, which fails compilation on `esp32h2`. Firmware and compatibility metadata must reflect `supports_wifi` and guard Wi-Fi APIs cleanly.
4. **Board Identity Reporting**: Firmware `pairing_client.c` only sends `chipVariant: CONFIG_IDF_TARGET` and does not report `boardSlug`, `flashSizeMb`, `psramSizeMb`, or `partitionScheme` to `/api/device/pair` and `/api/device/heartbeat`.
5. **Single-job CI Workflow**: `.github/workflows/build-firmware.yml` lacks a multi-board matrix covering the 11 cataloged boards, board-specific `sdkconfig` overlays, ESP-IDF v5.5 support for `esp32c5`/`esp32c61`, and per-board release ZIP manifests.

### 2.2 Database & Schema Gaps (`database/migrations/0001`, `0008`)
1. **`firmware_releases_name_ver_chip_unique` constraint**: `UNIQUE (name, version, chip_family)` prevents creating independent per-board releases that share a `chip_family` (e.g., `esp32-s3-devkitc-1-n16r8` 16MB vs `seeed-xiao-esp32s3` 8MB vs `esp32-s3-devkitc-1-v1-0` 8MB).
2. **Missing compatibility & release lifecycle fields**:
   - `board_catalog` lacks structured firmware compatibility columns: `partition_scheme`, `psram_mode`, `flash_mode`, `flash_freq`, `bootloader_offset`, `boot_button_gpio`, `usb_interface`, `supports_wifi`, `supports_ota_rollback`, and `firmware_compat_key`.
   - `firmware_releases` lacks `target_board_slug`, `partition_scheme`, `psram_mode`, `flash_mode`, `flash_freq`, `flash_size_mb`, `build_status`, `hardware_verified`, `verified_board_ids`, `rollback_from_release_id`, and `deprecated` status.
3. **Catalog status drift**: `board_catalog.firmware_status` is static in migrations and not synchronized when verified releases are published, unpublished, deprecated, or archived.

### 2.3 Admin & User API / UI Gaps
1. **Admin Firmware Lifecycle**:
   - Single-image upload only supports `esp32s3`, `esp32`, `esp32c3`, `esp32c6` in the dropdown (missing `esp32s2`, `esp32c2`, `esp32c5`, `esp32c61`, `esp32h2`, etc.), lacks release notes, cannot upload/replace `usb_factory` and `ota_app` on the same release, and lacks real XHR upload progress + file size/SHA display.
   - Missing admin endpoints & UI controls to **unpublish** (`published -> draft`), **deprecate** (`published -> deprecated`), **rollback** (create/promote rollback pointer or mark replacement release), and toggle **hardware verification** (`verified_board_ids`) before elevating a board to `firmware_supported`.
2. **Compatibility Filtering & Cross-Flash Prevention**:
   - Worker OTA (`device-api.ts` & `firmware.ts`) and User USB manifest endpoints do not reject flash-capacity mismatches (e.g. flashing a 16MB/8MB binary onto a 4MB board), PSRAM mode mismatches (`octal` vs `quad` vs `none`), partition layout mismatches, or non-Wi-Fi targets.
3. **Web Serial Flasher (`apps/web/src/lib/usb-flasher.ts`)**:
   - `chipMatchesFamily()` checks `!chip.includes("s3") && !chip.includes("c3")...` when `target === "esp32"`, causing newer chips (`ESP32-C2`/`ESP8684`, `ESP32-C5`, `ESP32-C61`, `ESP32-H2`, `ESP32-P4`) to falsely match `"esp32"` and breaking `esp32c2` (`ESP8684`) detection.
   - Does not inspect `esploader.getFlashSize()` (or detected flash KB) against target board & firmware requirements before writing flash.
   - Does not expose post-write flash MD5 verification (`flashMd5sum`) or clear board-specific USB/BOOT/RST recovery hints (`GPIO0` vs `GPIO9`, dual USB-C UART vs Native OTG vs CP2102N).
   - Must force `flashSize: "keep"`, `flashMode: "keep"`, `flashFreq: "keep"` when writing pre-merged `usb_factory` binaries at `0x0` (working around `esptool-js@0.7.1`'s `_updateImageFlashParams` SHA recalculation bug on merged images).

---

## 3. Target Compatibility Matrix (All 11 Cataloged Boards)

| # | Board Slug | Chip | Flash / PSRAM | Partition Scheme | Flash Mode / Freq | Bootloader Offset | BOOT Pin | USB Interface | Wi-Fi Radio | Target Compatibility Key |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `esp32-s3-devkitc-1-n16r8` | `esp32s3` | 16MB / 8MB Octal | `dual_ota_16mb` | `qio` / `80m` | `0x0` | `GPIO0` | Dual USB-C (UART + Native OTG) | Wi-Fi 4 | `esp32s3-16m-qio-octal8m-ota16m-b0` |
| 2 | `seeed-xiao-esp32s3` | `esp32s3` | 8MB / 8MB Octal | `dual_ota_8mb` | `qio` / `80m` | `0x0` | `GPIO0` | Native USB-C (CDC/JTAG) | Wi-Fi 4 | `esp32s3-8m-qio-octal8m-ota8m-b0` |
| 3 | `esp32-s3-devkitc-1-v1-0` | `esp32s3` | 8MB / 8MB Octal | `dual_ota_8mb` | `qio` / `80m` | `0x0` | `GPIO0` | Dual USB-C (UART + Native OTG) | Wi-Fi 4 | `esp32s3-8m-qio-octal8m-ota8m-b0` |
| 4 | `esp32-c6-devkitc-1` | `esp32c6` | 8MB / 0MB | `dual_ota_8mb` | `dio` / `80m` | `0x0` | `GPIO9` | Dual USB-C (UART + Native JTAG) | Wi-Fi 6 | `esp32c6-8m-dio-none-ota8m-b9` |
| 5 | `esp32-c3-devkitm-1` | `esp32c3` | 4MB / 0MB | `dual_ota_4mb` | `dio` / `80m` | `0x0` | `GPIO9` | USB-UART Bridge (CP2102N) | Wi-Fi 4 | `esp32c3-4m-dio-none-ota4m-b9` |
| 6 | `esp32-devkitc-v4` | `esp32` | 4MB / 0MB | `dual_ota_4mb` | `dio` / `40m` | `0x1000` | `GPIO0` | USB-UART Bridge (CP2102N) | Wi-Fi 4 | `esp32-4m-dio-none-ota4m-b0` |
| 7 | `esp32-s2-devkitc-1` | `esp32s2` | 4MB / 2MB Quad | `dual_ota_4mb` | `dio` / `80m` | `0x1000` | `GPIO0` | Dual USB (UART + Native OTG) | Wi-Fi 4 | `esp32s2-4m-dio-quad2m-ota4m-b0` |
| 8 | `esp32-c5-devkitc-1` | `esp32c5` | 8MB / 8MB Quad | `dual_ota_8mb` | `dio` / `80m` | `0x2000` | `GPIO28` | Dual USB-C (UART + Native JTAG) | Dual-Band Wi-Fi 6 | `esp32c5-8m-dio-quad8m-ota8m-b28` |
| 9 | `esp32-c61-devkitc-1` | `esp32c61` | 8MB / 2MB Quad | `dual_ota_8mb` | `dio` / `80m` | `0x0` | `GPIO9` | Dual USB-C (UART + Native JTAG) | Wi-Fi 6 | `esp32c61-8m-dio-quad2m-ota8m-b9` |
| 10 | `esp8684-devkitm-1` | `esp32c2` | 4MB / 0MB | `dual_ota_4mb` | `dio` / `60m` | `0x0` | `GPIO9` | USB-UART Bridge (CP2102N) | Wi-Fi 4 | `esp32c2-4m-dio-none-ota4m-b9` |
| 11 | `esp32-h2-devkitm-1` | `esp32h2` | 4MB / 0MB | `dual_ota_4mb` | `dio` / `64m` | `0x0` | `GPIO9` | Dual USB-C (UART + Native JTAG) | None (BLE/802.15.4) | `esp32h2-4m-dio-none-ota4m-b9` |

### Binary Sharing Rule
Only `seeed-xiao-esp32s3` and `esp32-s3-devkitc-1-v1-0` share an identical hardware binary profile (`esp32s3-8m-qio-octal8m-ota8m-b0`: ESP32-S3, 8MB QIO flash, 8MB Octal PSRAM, `dual_ota_8mb`, `BOOT=GPIO0`). Even where binaries are compatible, CI builds dedicated per-board packages and HomecoreOS enforces explicit `compatible_board_ids` / `compatible_board_slugs` / `firmware_compat_key` checks before flashing or OTA.

### Board `firmware_status` Governance
- Only `esp32-s3-devkitc-1-n16r8` starts as `firmware_supported`.
- All other 10 boards start as `catalog_only` (or `unsupported` where Wi-Fi is absent unless an ESP-Hosted/Thread bridge firmware is verified).
- A board transitions to `firmware_supported` **only after** a compatible release build succeeds, passes automated & hardware verification (`hardware_verified = true` / board in `verified_board_ids`), and is published.
