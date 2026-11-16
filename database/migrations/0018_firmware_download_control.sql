-- 0018_firmware_download_control.sql
-- Adds platform-level admin switch to allow or block direct customer firmware binary downloads.

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS firmware_downloads_enabled BOOLEAN NOT NULL DEFAULT true;
