-- 0002: unified Controller / Node device roles.
--
-- Additive only: every existing row keeps working as a Controller, which is what
-- it was before roles existed. Nothing is renamed, dropped or rewritten.
--
-- One row per physical board (`controllers.id`) keeps its identity, history,
-- pairing records and MQTT credentials when its role changes. `device_role` says
-- how the board is being used right now; `assigned_controller_id` links a Node to
-- the Controller that hosts it.

ALTER TABLE public.controllers
  ADD COLUMN device_role text DEFAULT 'controller'::text NOT NULL,
  ADD COLUMN assigned_controller_id uuid,
  ADD COLUMN comm_mode text,
  ADD COLUMN node_link_state text,
  ADD COLUMN espnow_channel smallint,
  ADD COLUMN node_last_linked_at timestamp with time zone,
  ADD COLUMN role_changed_at timestamp with time zone;

ALTER TABLE public.controllers
  ADD CONSTRAINT controllers_device_role_check
    CHECK (device_role = ANY (ARRAY['controller'::text, 'node'::text])),
  ADD CONSTRAINT controllers_comm_mode_check
    CHECK (comm_mode IS NULL OR comm_mode = ANY (ARRAY['espnow'::text, 'wifi_mqtt'::text, 'offline'::text])),
  ADD CONSTRAINT controllers_node_link_state_check
    CHECK (node_link_state IS NULL OR node_link_state = ANY (ARRAY['linked'::text, 'controller_lost'::text, 'reconnecting'::text, 'standalone'::text, 'unassigned'::text])),
  ADD CONSTRAINT controllers_espnow_channel_check
    CHECK (espnow_channel IS NULL OR (espnow_channel >= 1 AND espnow_channel <= 13)),
  -- A Node may not be its own Controller.
  ADD CONSTRAINT controllers_assignment_not_self_check
    CHECK (assigned_controller_id IS NULL OR assigned_controller_id <> id),
  -- Only a Node has an uplink Controller.
  ADD CONSTRAINT controllers_assignment_role_check
    CHECK (device_role = 'node'::text OR assigned_controller_id IS NULL),
  ADD CONSTRAINT controllers_assigned_controller_fkey
    FOREIGN KEY (assigned_controller_id) REFERENCES public.controllers(id) ON DELETE SET NULL;

CREATE INDEX idx_controllers_device_role
  ON public.controllers USING btree (account_id, device_role)
  WHERE ((deleted_at IS NULL) AND (permanently_deleted_at IS NULL));

CREATE INDEX idx_controllers_assigned_controller
  ON public.controllers USING btree (assigned_controller_id)
  WHERE ((assigned_controller_id IS NOT NULL) AND (deleted_at IS NULL));
