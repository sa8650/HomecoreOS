-- Remove deprecated areas table and area_id columns from hardware tables
ALTER TABLE public.devices DROP COLUMN IF EXISTS area_id;
ALTER TABLE public.switches DROP COLUMN IF EXISTS area_id;
ALTER TABLE public.sensors DROP COLUMN IF EXISTS area_id;
DROP TABLE IF EXISTS public.areas CASCADE;
