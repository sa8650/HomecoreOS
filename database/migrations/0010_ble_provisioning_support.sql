-- Migration 0010: Dual BLE + Wi-Fi Provisioning & Recovery support
-- Tracks per-board and per-release BLE + BLE Wi-Fi provisioning capabilities,
-- plus controller provisioning transport & optional per-device recovery setup PIN.

ALTER TABLE public.board_catalog
  ADD COLUMN IF NOT EXISTS supports_ble BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS supports_ble_wifi_provisioning BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.custom_boards
  ADD COLUMN IF NOT EXISTS supports_ble BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS supports_ble_wifi_provisioning BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.firmware_releases
  ADD COLUMN IF NOT EXISTS supports_ble BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS supports_ble_wifi_provisioning BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.controllers
  ADD COLUMN IF NOT EXISTS ble_setup_pin TEXT,
  ADD COLUMN IF NOT EXISTS provisioning_transport TEXT
    CHECK (provisioning_transport IS NULL OR provisioning_transport IN ('ble', 'softap', 'usb', 'manual'));

-- Backfill board_catalog radio provisioning matrix across all ESP32 variants
UPDATE public.board_catalog
SET
  supports_ble = CASE
    WHEN slug = 'esp32-s2-devkitc-1' OR lower(chip_family) IN ('esp32s2', 'esp32p4') THEN false
    ELSE true
  END,
  supports_ble_wifi_provisioning = CASE
    WHEN slug IN ('esp32-s2-devkitc-1', 'esp32-h2-devkitm-1')
      OR lower(chip_family) IN ('esp32s2', 'esp32p4', 'esp32h2', 'esp32h21', 'esp32h4')
      OR supports_wifi = false
    THEN false
    ELSE true
  END;

-- Backfill custom_boards
UPDATE public.custom_boards
SET
  supports_ble = CASE
    WHEN lower(chip_family) IN ('esp32s2', 'esp32p4') THEN false
    ELSE true
  END,
  supports_ble_wifi_provisioning = CASE
    WHEN lower(chip_family) IN ('esp32s2', 'esp32p4', 'esp32h2', 'esp32h21', 'esp32h4')
      OR supports_wifi = false
    THEN false
    ELSE true
  END;

-- Backfill firmware_releases
UPDATE public.firmware_releases
SET
  supports_ble = CASE
    WHEN target_board_slug = 'esp32-s2-devkitc-1' OR lower(chip_family) IN ('esp32s2', 'esp32p4') THEN false
    ELSE true
  END,
  supports_ble_wifi_provisioning = CASE
    WHEN target_board_slug IN ('esp32-s2-devkitc-1', 'esp32-h2-devkitm-1')
      OR lower(chip_family) IN ('esp32s2', 'esp32p4', 'esp32h2', 'esp32h21', 'esp32h4')
    THEN false
    ELSE true
  END;
