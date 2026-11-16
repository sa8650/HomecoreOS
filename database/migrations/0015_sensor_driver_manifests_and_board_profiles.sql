-- HomecoreOS Board-Aware Sensor Driver Manifests & Multi-Board Compatibility (Additive Migration)
-- Preserves all historical migrations (0001..0014), existing board slugs/IDs, firmware records, and user sensors.

-- 1. Extend firmware_releases with compiled sensor driver manifest metadata
--    Legacy rows retain driver_manifest = NULL and compiled_sensor_drivers = '{}' so they
--    safely resolve to an unknown/legacy driver state until updated firmware metadata is published.
ALTER TABLE public.firmware_releases
  ADD COLUMN IF NOT EXISTS driver_manifest JSONB,
  ADD COLUMN IF NOT EXISTS compiled_sensor_drivers TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS supported_sensor_types TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS manifest_version TEXT,
  ADD COLUMN IF NOT EXISTS manifest_hash TEXT;

CREATE INDEX IF NOT EXISTS firmware_releases_board_version_lookup_idx
  ON public.firmware_releases (chip_family, target_board_slug, version)
  WHERE deleted_at IS NULL;

-- 2. Associate controllers with their matched published firmware release record
--    (reported_driver_manifest_hash is diagnostic only; authorization always uses firmware_releases).
ALTER TABLE public.controllers
  ADD COLUMN IF NOT EXISTS installed_firmware_release_id UUID REFERENCES public.firmware_releases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reported_driver_manifest_hash TEXT;

CREATE INDEX IF NOT EXISTS controllers_installed_fw_release_idx
  ON public.controllers (installed_firmware_release_id)
  WHERE deleted_at IS NULL AND installed_firmware_release_id IS NOT NULL;

-- 3. Distinguish ESP-IDF vs non-ESP-IDF (ESP8266) build platforms explicitly on boards
ALTER TABLE public.board_catalog
  ADD COLUMN IF NOT EXISTS build_platform TEXT NOT NULL DEFAULT 'esp_idf';

ALTER TABLE public.board_catalog DROP CONSTRAINT IF EXISTS board_catalog_build_platform_check;
ALTER TABLE public.board_catalog
  ADD CONSTRAINT board_catalog_build_platform_check
  CHECK (build_platform IN ('esp_idf', 'esp8266_rtos_sdk'));

ALTER TABLE public.custom_boards
  ADD COLUMN IF NOT EXISTS build_platform TEXT NOT NULL DEFAULT 'esp_idf';

ALTER TABLE public.custom_boards DROP CONSTRAINT IF EXISTS custom_boards_build_platform_check;
ALTER TABLE public.custom_boards
  ADD CONSTRAINT custom_boards_build_platform_check
  CHECK (build_platform IN ('esp_idf', 'esp8266_rtos_sdk'));

-- 4. Reconcile exact hardware compatibility specs for existing published partner/community boards
--    Never auto-promotes firmware_status or publishes unverified/draft boards.
UPDATE public.board_catalog SET
  build_platform = 'esp8266_rtos_sdk',
  partition_scheme = 'dual_ota_4mb',
  psram_mode = 'none',
  flash_mode = 'dio',
  flash_freq = '40m',
  bootloader_offset = '0x0',
  ota_app_offset = '0x20000',
  boot_button_gpio = 0,
  supports_wifi = true,
  supports_ble = false,
  supports_ble_wifi_provisioning = false,
  supports_ota_rollback = false,
  firmware_compat_key = 'esp8266-4m-dio-none-dual_ota_4mb-b0',
  connectivity_note = 'ESP8266EX (non-ESP-IDF silicon, no BLE). Requires the dedicated firmware/esp8266 build path rather than ESP-IDF.'
WHERE slug = 'nodemcu-esp8266';

UPDATE public.board_catalog SET
  build_platform = 'esp_idf',
  partition_scheme = 'dual_ota_4mb',
  psram_mode = 'quad',
  flash_mode = 'qio',
  flash_freq = '80m',
  bootloader_offset = '0x0',
  ota_app_offset = '0x20000',
  boot_button_gpio = 0,
  firmware_compat_key = 'esp32s3-4m-qio-quad2m-dual_ota_4mb-b0'
WHERE slug = 'waveshare-esp32-s3-zero';

UPDATE public.board_catalog SET
  build_platform = 'esp_idf',
  partition_scheme = 'dual_ota_4mb',
  psram_mode = 'none',
  flash_mode = 'dio',
  flash_freq = '80m',
  bootloader_offset = '0x0',
  ota_app_offset = '0x20000',
  boot_button_gpio = 9,
  firmware_compat_key = 'esp32c3-4m-dio-none-dual_ota_4mb-b9'
WHERE slug = 'waveshare-esp32-c3-zero';

UPDATE public.board_catalog SET
  build_platform = 'esp_idf',
  partition_scheme = 'dual_ota_4mb',
  psram_mode = 'none',
  flash_mode = 'dio',
  flash_freq = '80m',
  bootloader_offset = '0x0',
  ota_app_offset = '0x20000',
  boot_button_gpio = 9,
  firmware_compat_key = 'esp32c6-4m-dio-none-dual_ota_4mb-b9'
WHERE slug = 'waveshare-esp32-c6-zero';

UPDATE public.board_catalog SET
  build_platform = 'esp_idf',
  partition_scheme = 'dual_ota_16mb',
  psram_mode = 'quad',
  flash_mode = 'qio',
  flash_freq = '80m',
  bootloader_offset = '0x0',
  ota_app_offset = '0x20000',
  boot_button_gpio = 0,
  firmware_compat_key = 'esp32s3-16m-qio-quad2m-dual_ota_16mb-b0'
WHERE slug = 'waveshare-esp32-s3-pico';

UPDATE public.board_catalog SET
  build_platform = 'esp_idf',
  partition_scheme = 'dual_ota_16mb',
  psram_mode = 'octal',
  flash_mode = 'qio',
  flash_freq = '80m',
  bootloader_offset = '0x0',
  ota_app_offset = '0x20000',
  boot_button_gpio = 0,
  firmware_compat_key = 'esp32s3-16m-qio-octal8m-dual_ota_16mb-b0',
  connectivity_note = 'Onboard isolated relays occupy GPIO 1, 2, 41, 42, 45, 46 (outputs only). Expansion header exposes GP4–GP9 for sensors (ADC1 on GP4–GP7, I2C on GP8/GP9).'
WHERE slug = 'waveshare-esp32-s3-relay-6ch';

UPDATE public.board_catalog SET
  build_platform = 'esp_idf',
  partition_scheme = 'dual_ota_4mb',
  psram_mode = 'none',
  flash_mode = 'qio',
  flash_freq = '80m',
  bootloader_offset = '0x0',
  ota_app_offset = '0x20000',
  boot_button_gpio = 9,
  firmware_compat_key = 'esp32c3-4m-qio-none-dual_ota_4mb-b9'
WHERE slug = 'seeed-xiao-esp32c3';

UPDATE public.board_catalog SET
  build_platform = 'esp_idf',
  partition_scheme = 'dual_ota_8mb',
  psram_mode = 'quad',
  flash_mode = 'qio',
  flash_freq = '80m',
  bootloader_offset = '0x2000',
  ota_app_offset = '0x20000',
  boot_button_gpio = 28,
  firmware_compat_key = 'esp32c5-8m-qio-quad8m-dual_ota_8mb-b28'
WHERE slug = 'seeed-xiao-esp32c5';

UPDATE public.board_catalog SET
  build_platform = 'esp_idf',
  partition_scheme = 'dual_ota_4mb',
  psram_mode = 'none',
  flash_mode = 'qio',
  flash_freq = '80m',
  bootloader_offset = '0x0',
  ota_app_offset = '0x20000',
  boot_button_gpio = 9,
  firmware_compat_key = 'esp32c6-4m-qio-none-dual_ota_4mb-b9'
WHERE slug = 'seeed-xiao-esp32c6';

UPDATE public.board_catalog SET
  build_platform = 'esp_idf',
  partition_scheme = 'dual_ota_16mb',
  psram_mode = 'octal',
  flash_mode = 'qio',
  flash_freq = '80m',
  bootloader_offset = '0x0',
  ota_app_offset = '0x20000',
  boot_button_gpio = 0,
  firmware_compat_key = 'esp32s3-16m-qio-octal8m-dual_ota_16mb-b0'
WHERE slug = 'seeed-xiao-esp32s3-plus';
