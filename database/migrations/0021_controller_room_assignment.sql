-- Optional direct room assignment for controllers, mirroring the existing
-- room_id relationship carried by switches / devices / sensors.
-- NULL means "no room assigned" (controller visible as unassigned).
-- ON DELETE SET NULL so removing a room never deletes a controller.

ALTER TABLE public.controllers
  ADD COLUMN IF NOT EXISTS room_id UUID REFERENCES public.rooms(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_controllers_room ON public.controllers (room_id) WHERE room_id IS NOT NULL AND deleted_at IS NULL;
