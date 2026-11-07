# Board catalog sources and verification policy

**Rule: no GPIO mapping is invented.** Every pin row in `packages/core/data/board-catalog.json` and `supabase/migrations/0008_board_catalog.sql` is transcribed from the "Header Block" table of the official Espressif dev-kit user guide listed below. Chip theoretical capabilities are never used to fill a board header.

`scripts/board-catalog.mjs` is the single source of truth. `node scripts/board-catalog.mjs` regenerates both the JSON and the SQL migration.

## Verified development boards

| Board ID | Revision / module | Pins | Official source |
|---|---|---|---|
| `espressif.esp32-devkitc-v4.wroom32e` | ESP32-DevKitC V4, ESP32-WROOM-32E | 32 (J2 + J3) | https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html |
| `espressif.esp32-s3-devkitc-1.v1.1` | ESP32-S3-DevKitC-1 v1.1 | 36 (J1 + J3) | https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html |
| `espressif.esp32-c3-devkitm-1.v1` | ESP32-C3-DevKitM-1 v1, MINI-1 (N4X) | 15 (J1 + J3) | https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c3/esp32-c3-devkitm-1/user_guide.html |
| `espressif.esp32-c6-devkitc-1.v1.2` | ESP32-C6-DevKitC-1 v1.2, WROOM-1 | 23 (J1 + J3) | https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c6/esp32-c6-devkitc-1/user_guide.html |

Pinout image references are stored per board (`pinout_url`) and link to the official guide's pin layout figure.

## Board-specific restrictions captured

- **ESP32-DevKitC V4**: GPIO6–11 are internal SPI flash pins (`restricted`). GPIO34–39 are input-only. GPIO0/2/4/5/12/15 are boot-strapping; GPIO16/17 are PSRAM pins on WROVER variants. ADC2 channels are unusable while Wi-Fi is active.
- **ESP32-S3-DevKitC-1 v1.1**: GPIO0/3/45/46 are strapping; GPIO19/20 are native USB D-/D+; GPIO35/36/37 are occupied by octal flash/PSRAM on N16R8/N32R16V variants; GPIO38 drives the RGB LED on some variants; GPIO43/44 are U0TXD/U0RXD.
- **ESP32-C3-DevKitM-1**: GPIO9 is the BOOT button + strapping (`restricted`), GPIO8 drives the RGB LED and is strapping, GPIO18/19 are USB D-/D+, GPIO21/20 are U0TXD/U0RXD, flash SPI pins are not broken out.
- **ESP32-C6-DevKitC-1 v1.2**: GPIO8/9/15 are strapping, GPIO12/13 are USB D-/D+, GPIO4–7 are JTAG, GPIO16/17 are U0TXD/U0RXD, GPIO18–23 are SDIO.

Every warning is version/variant-specific and shown in the GPIO Pin Manager detail dialog. When a customer's exact module differs, the UI instructs them to verify their module rather than assuming.

## Registered chip families (pin map pending verification)

These families are supported by the platform but no dev-board header table has been transcribed yet. They have `pins: []`, `pin_status: "pending_verification"`, and cannot be selected for GPIO allocation until a verified board is added.

| Family | Reference |
|---|---|
| ESP32-S2 | https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s2/index.html |
| ESP32-C2 | https://www.espressif.com/en/products/socs/esp32-c2 |
| ESP32-C5 | https://www.espressif.com/en/products/socs/esp32-c5 |
| ESP32-H2 | https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32h2/index.html |
| ESP32-P4 | https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32p4/index.html |

ESP32, ESP32-S3, ESP32-C3, ESP32-C6 and ESP32-C5/H2/P4/S2/C2 are all listed as chip families in `packages/core/src/constants.ts` so future verified boards can be added without schema changes.

## Adding a board

1. Open the official manufacturer user guide → "Header Block" tables.
2. Add pin rows to `scripts/board-catalog.mjs` with header label, side, header position, functions, ADC channels, direction, boot/USB/flash/PSRAM flags and notes.
3. Set `doc_source_url`, `pinout_url`, `revision`, `chip_variant` and a new `version` + changelog.
4. Run `node scripts/board-catalog.mjs`; commit the regenerated JSON + SQL.
5. Add a migration that inserts the new `board_catalog_versions` row when needed (the generator handles `ON CONFLICT` idempotently).

## Custom boards

Customers can add a custom board from **Board Library → Custom board**. The form requires the customer to supply each exposed GPIO, its header label, functions and ADC channels, plus a documentation URL. The definition is stored as tenant-owned `board_catalog` rows with `pin_status: "customer_supplied"` and `board_catalog_versions.published = false`. The UI explicitly warns that no pin map is inferred.
