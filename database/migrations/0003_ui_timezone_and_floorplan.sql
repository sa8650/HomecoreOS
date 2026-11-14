-- HomecoreOS Additive Migration: Regional Time Zones & 2D Floor Plan Room Geometry
-- Safe to run after 0001_initial_schema.sql and 0002_seed_catalog_and_settings.sql.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS timezone TEXT;

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS default_timezone TEXT NOT NULL DEFAULT 'UTC';

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS room_type TEXT NOT NULL DEFAULT 'living_room';

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS floor_x INT NOT NULL DEFAULT 0;

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS floor_y INT NOT NULL DEFAULT 0;

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS floor_w INT NOT NULL DEFAULT 320;

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS floor_h INT NOT NULL DEFAULT 240;

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS layout_config JSONB NOT NULL DEFAULT '{}'::jsonb;
