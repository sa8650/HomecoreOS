-- 0002: board roles (Controller / Node) for the unified board ecosystem.
--
-- Board Library profiles describe hardware; `board_instances` rows describe one
-- physical registered board. `board_role` is the operating role that row is in
-- right now, so a compatible board can move between Controller and Node without
-- ever being re-registered.

ALTER TABLE public.board_instances
  ADD COLUMN board_role text DEFAULT 'controller'::text NOT NULL,
  ADD COLUMN assigned_controller_id uuid,
  ADD COLUMN comm_mode text,
  ADD COLUMN node_link_state text,
  ADD COLUMN espnow_channel smallint,
  ADD COLUMN node_last_linked_at timestamp with time zone,
  ADD COLUMN role_changed_at timestamp with time zone;

ALTER TABLE public.board_instances
  ADD CONSTRAINT board_instances_board_role_check
    CHECK (board_role = ANY (ARRAY['controller'::text, 'node'::text])),
  ADD CONSTRAINT board_instances_comm_mode_check
    CHECK (comm_mode IS NULL OR comm_mode = ANY (ARRAY['espnow'::text, 'wifi_mqtt'::text, 'offline'::text])),
  ADD CONSTRAINT board_instances_node_link_state_check
    CHECK (node_link_state IS NULL OR node_link_state = ANY (ARRAY['linked'::text, 'controller_lost'::text, 'reconnecting'::text, 'standalone'::text, 'unassigned'::text])),
  ADD CONSTRAINT board_instances_espnow_channel_check
    CHECK (espnow_channel IS NULL OR (espnow_channel >= 1 AND espnow_channel <= 13)),
  -- A Node may not be its own Controller.
  ADD CONSTRAINT board_instances_assignment_not_self_check
    CHECK (assigned_controller_id IS NULL OR assigned_controller_id <> id),
  -- Only a Node has an uplink Controller.
  ADD CONSTRAINT board_instances_assignment_role_check
    CHECK (board_role = 'node'::text OR assigned_controller_id IS NULL),
  ADD CONSTRAINT board_instances_assigned_controller_fkey
    FOREIGN KEY (assigned_controller_id) REFERENCES public.board_instances(id) ON DELETE SET NULL;

CREATE INDEX idx_board_instances_board_role
  ON public.board_instances USING btree (account_id, board_role)
  WHERE ((deleted_at IS NULL) AND (permanently_deleted_at IS NULL));

CREATE INDEX idx_board_instances_assigned_controller
  ON public.board_instances USING btree (assigned_controller_id)
  WHERE ((assigned_controller_id IS NOT NULL) AND (deleted_at IS NULL));
