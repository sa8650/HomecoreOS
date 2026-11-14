-- HomecoreOS Multi-Board Firmware Compatibility, Release Verification & Lifecycle Schema

-- 1. Add board-specific firmware compatibility metadata to board_catalog and custom_boards
ALTER TABLE public.board_catalog
  ADD COLUMN IF NOT EXISTS partition_scheme TEXT NOT NULL DEFAULT 'dual_ota_4mb',
  ADD COLUMN IF NOT EXISTS psram_mode TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS flash_mode TEXT NOT NULL DEFAULT 'dio',
  ADD COLUMN IF NOT EXISTS flash_freq TEXT NOT NULL DEFAULT '80m',
  ADD COLUMN IF NOT EXISTS bootloader_offset TEXT NOT NULL DEFAULT '0x0',
  ADD COLUMN IF NOT EXISTS ota_app_offset TEXT NOT NULL DEFAULT '0x20000',
  ADD COLUMN IF NOT EXISTS boot_button_gpio INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usb_interface TEXT NOT NULL DEFAULT 'USB-C / UART',
  ADD COLUMN IF NOT EXISTS supports_wifi BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS supports_ota_rollback BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS firmware_compat_key TEXT,
  ADD COLUMN IF NOT EXISTS connectivity_note TEXT;

ALTER TABLE public.board_catalog DROP CONSTRAINT IF EXISTS board_catalog_psram_mode_check;
ALTER TABLE public.board_catalog ADD CONSTRAINT board_catalog_psram_mode_check CHECK (psram_mode IN ('none', 'quad', 'octal'));
ALTER TABLE public.board_catalog DROP CONSTRAINT IF EXISTS board_catalog_flash_mode_check;
ALTER TABLE public.board_catalog ADD CONSTRAINT board_catalog_flash_mode_check CHECK (flash_mode IN ('qio', 'qout', 'dio', 'dout'));

ALTER TABLE public.custom_boards
  ADD COLUMN IF NOT EXISTS partition_scheme TEXT NOT NULL DEFAULT 'dual_ota_4mb',
  ADD COLUMN IF NOT EXISTS psram_mode TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS flash_mode TEXT NOT NULL DEFAULT 'dio',
  ADD COLUMN IF NOT EXISTS flash_freq TEXT NOT NULL DEFAULT '80m',
  ADD COLUMN IF NOT EXISTS bootloader_offset TEXT NOT NULL DEFAULT '0x0',
  ADD COLUMN IF NOT EXISTS ota_app_offset TEXT NOT NULL DEFAULT '0x20000',
  ADD COLUMN IF NOT EXISTS boot_button_gpio INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usb_interface TEXT NOT NULL DEFAULT 'USB-C / UART',
  ADD COLUMN IF NOT EXISTS supports_wifi BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS supports_ota_rollback BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS firmware_compat_key TEXT,
  ADD COLUMN IF NOT EXISTS connectivity_note TEXT;

-- 2. Backfill exact compatibility metadata for all 11 cataloged boards
UPDATE public.board_catalog SET
  partition_scheme = 'dual_ota_16mb', psram_mode = 'octal', flash_mode = 'qio', flash_freq = '80m',
  bootloader_offset = '0x0', ota_app_offset = '0x20000', boot_button_gpio = 0,
  usb_interface = 'Dual USB-C (UART + Native OTG)', supports_wifi = true, supports_ota_rollback = true,
  firmware_compat_key = 'esp32s3-16m-qio-octal8m-dual_ota_16mb-b0', connectivity_note = NULL,
  firmware_status = 'firmware_supported'
WHERE slug = 'esp32-s3-devkitc-1-n16r8';

UPDATE public.board_catalog SET
  partition_scheme = 'dual_ota_8mb', psram_mode = 'octal', flash_mode = 'qio', flash_freq = '80m',
  bootloader_offset = '0x0', ota_app_offset = '0x20000', boot_button_gpio = 0,
  usb_interface = 'Native USB-C (CDC/JTAG)', supports_wifi = true, supports_ota_rollback = true,
  firmware_compat_key = 'esp32s3-8m-qio-octal8m-dual_ota_8mb-b0', connectivity_note = NULL
WHERE slug = 'seeed-xiao-esp32s3';

UPDATE public.board_catalog SET
  partition_scheme = 'dual_ota_8mb', psram_mode = 'octal', flash_mode = 'qio', flash_freq = '80m',
  bootloader_offset = '0x0', ota_app_offset = '0x20000', boot_button_gpio = 0,
  usb_interface = 'Dual USB-C (UART + Native OTG)', supports_wifi = true, supports_ota_rollback = true,
  firmware_compat_key = 'esp32s3-8m-qio-octal8m-dual_ota_8mb-b0', connectivity_note = NULL
WHERE slug = 'esp32-s3-devkitc-1-v1-0';

UPDATE public.board_catalog SET
  partition_scheme = 'dual_ota_8mb', psram_mode = 'none', flash_mode = 'dio', flash_freq = '80m',
  bootloader_offset = '0x0', ota_app_offset = '0x20000', boot_button_gpio = 9,
  usb_interface = 'Dual USB-C (UART + Native JTAG)', supports_wifi = true, supports_ota_rollback = true,
  firmware_compat_key = 'esp32c6-8m-dio-none-dual_ota_8mb-b9', connectivity_note = NULL
WHERE slug = 'esp32-c6-devkitc-1';

UPDATE public.board_catalog SET
  partition_scheme = 'dual_ota_4mb', psram_mode = 'none', flash_mode = 'dio', flash_freq = '80m',
  bootloader_offset = '0x0', ota_app_offset = '0x20000', boot_button_gpio = 9,
  usb_interface = 'USB-UART Bridge (CP2102N)', supports_wifi = true, supports_ota_rollback = true,
  firmware_compat_key = 'esp32c3-4m-dio-none-dual_ota_4mb-b9', connectivity_note = NULL
WHERE slug = 'esp32-c3-devkitm-1';

UPDATE public.board_catalog SET
  partition_scheme = 'dual_ota_4mb', psram_mode = 'none', flash_mode = 'dio', flash_freq = '40m',
  bootloader_offset = '0x1000', ota_app_offset = '0x20000', boot_button_gpio = 0,
  usb_interface = 'USB-UART Bridge (CP2102N)', supports_wifi = true, supports_ota_rollback = true,
  firmware_compat_key = 'esp32-4m-dio-none-dual_ota_4mb-b0', connectivity_note = NULL
WHERE slug = 'esp32-devkitc-v4';

UPDATE public.board_catalog SET
  partition_scheme = 'dual_ota_4mb', psram_mode = 'quad', flash_mode = 'dio', flash_freq = '80m',
  bootloader_offset = '0x1000', ota_app_offset = '0x20000', boot_button_gpio = 0,
  usb_interface = 'Dual Micro-USB (UART + Native OTG)', supports_wifi = true, supports_ota_rollback = true,
  firmware_compat_key = 'esp32s2-4m-dio-quad2m-dual_ota_4mb-b0', connectivity_note = NULL
WHERE slug = 'esp32-s2-devkitc-1';

UPDATE public.board_catalog SET
  partition_scheme = 'dual_ota_8mb', psram_mode = 'quad', flash_mode = 'dio', flash_freq = '80m',
  bootloader_offset = '0x2000', ota_app_offset = '0x20000', boot_button_gpio = 28,
  usb_interface = 'Dual USB-C (UART + Native JTAG)', supports_wifi = true, supports_ota_rollback = true,
  firmware_compat_key = 'esp32c5-8m-dio-quad8m-dual_ota_8mb-b28', connectivity_note = NULL
WHERE slug = 'esp32-c5-devkitc-1';

UPDATE public.board_catalog SET
  partition_scheme = 'dual_ota_8mb', psram_mode = 'quad', flash_mode = 'dio', flash_freq = '80m',
  bootloader_offset = '0x0', ota_app_offset = '0x20000', boot_button_gpio = 9,
  usb_interface = 'Dual USB-C (UART + Native JTAG)', supports_wifi = true, supports_ota_rollback = true,
  firmware_compat_key = 'esp32c61-8m-dio-quad2m-dual_ota_8mb-b9', connectivity_note = NULL
WHERE slug = 'esp32-c61-devkitc-1';

UPDATE public.board_catalog SET
  partition_scheme = 'dual_ota_4mb', psram_mode = 'none', flash_mode = 'dio', flash_freq = '60m',
  bootloader_offset = '0x0', ota_app_offset = '0x20000', boot_button_gpio = 9,
  usb_interface = 'USB-UART Bridge (CP2102N)', supports_wifi = true, supports_ota_rollback = true,
  firmware_compat_key = 'esp32c2-4m-dio-none-dual_ota_4mb-b9', connectivity_note = NULL
WHERE slug = 'esp8684-devkitm-1';

UPDATE public.board_catalog SET
  partition_scheme = 'dual_ota_4mb', psram_mode = 'none', flash_mode = 'dio', flash_freq = '64m',
  bootloader_offset = '0x0', ota_app_offset = '0x20000', boot_button_gpio = 9,
  usb_interface = 'Dual USB-C (UART + Native JTAG)', supports_wifi = false, supports_ota_rollback = true,
  firmware_compat_key = 'esp32h2-4m-dio-none-dual_ota_4mb-b9',
  connectivity_note = 'IEEE 802.15.4 + BLE 5.3 only (no integrated Wi-Fi radio). Requires ESP-Hosted Wi-Fi companion or Thread/Matter bridge.'
WHERE slug = 'esp32-h2-devkitm-1';

-- 3. Extend firmware_releases for per-board targeting, compatibility validation, verification & rollback
ALTER TABLE public.firmware_releases DROP CONSTRAINT IF EXISTS firmware_releases_name_ver_chip_unique;

DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.firmware_releases'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
    EXECUTE format('ALTER TABLE public.firmware_releases DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.firmware_releases
  ADD CONSTRAINT firmware_releases_status_check CHECK (status IN ('draft', 'published', 'deprecated', 'archived'));

ALTER TABLE public.firmware_releases
  ADD COLUMN IF NOT EXISTS target_board_slug TEXT,
  ADD COLUMN IF NOT EXISTS partition_scheme TEXT,
  ADD COLUMN IF NOT EXISTS psram_mode TEXT,
  ADD COLUMN IF NOT EXISTS flash_mode TEXT,
  ADD COLUMN IF NOT EXISTS flash_freq TEXT,
  ADD COLUMN IF NOT EXISTS flash_size_mb INTEGER,
  ADD COLUMN IF NOT EXISTS build_status TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS hardware_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified_board_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS verified_board_slugs TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS verification_notes TEXT,
  ADD COLUMN IF NOT EXISTS rollback_from_release_id UUID REFERENCES public.firmware_releases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_by_release_id UUID REFERENCES public.firmware_releases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ci_run_url TEXT,
  ADD COLUMN IF NOT EXISTS ci_commit_sha TEXT;

ALTER TABLE public.firmware_releases DROP CONSTRAINT IF EXISTS firmware_releases_psram_mode_check;
ALTER TABLE public.firmware_releases ADD CONSTRAINT firmware_releases_psram_mode_check CHECK (psram_mode IS NULL OR psram_mode IN ('none', 'quad', 'octal'));
ALTER TABLE public.firmware_releases DROP CONSTRAINT IF EXISTS firmware_releases_build_status_check;
ALTER TABLE public.firmware_releases ADD CONSTRAINT firmware_releases_build_status_check CHECK (build_status IN ('pending', 'building', 'succeeded', 'failed', 'manual'));

CREATE UNIQUE INDEX IF NOT EXISTS firmware_releases_name_ver_chip_board_unique
  ON public.firmware_releases (name, version, chip_family, COALESCE(target_board_slug, ''))
  WHERE deleted_at IS NULL;

-- Backfill existing ESP32-S3 N16R8 releases with explicit compatibility fields
UPDATE public.firmware_releases
SET
  partition_scheme = COALESCE(partition_scheme, 'dual_ota_16mb'),
  psram_mode = COALESCE(psram_mode, 'octal'),
  flash_mode = COALESCE(flash_mode, 'qio'),
  flash_freq = COALESCE(flash_freq, '80m'),
  flash_size_mb = COALESCE(flash_size_mb, 16),
  build_status = CASE WHEN status = 'published' THEN 'succeeded' ELSE build_status END,
  hardware_verified = CASE WHEN status = 'published' THEN true ELSE hardware_verified END,
  verified_board_ids = CASE
    WHEN status = 'published' AND array_length(verified_board_ids, 1) IS NULL THEN compatible_board_ids
    ELSE verified_board_ids
  END,
  verified_board_slugs = CASE
    WHEN status = 'published' AND array_length(verified_board_slugs, 1) IS NULL THEN compatible_board_slugs
    ELSE verified_board_slugs
  END
WHERE chip_family = 'esp32s3' AND deleted_at IS NULL;

-- 4. Extend firmware_files & controllers with optional hardware detection metadata
ALTER TABLE public.firmware_files
  ADD COLUMN IF NOT EXISTS partition_scheme TEXT,
  ADD COLUMN IF NOT EXISTS psram_mode TEXT;

ALTER TABLE public.controllers
  ADD COLUMN IF NOT EXISTS detected_flash_size_mb INTEGER,
  ADD COLUMN IF NOT EXISTS detected_chip_name TEXT,
  ADD COLUMN IF NOT EXISTS reported_board_slug TEXT;
