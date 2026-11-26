-- 0011: Worker-authorized Controller/Node binding and cloud route authority.
--
-- Enrollment (board_instances.account_id/home_id) is deliberately separate
-- from Controller/Node binding. A binding has its own persistent id and a
-- monotonic generation; a higher generation is authoritative even when the
-- device has been offline. Connection telemetry stays volatile in the Worker
-- and in RAM on the device, never in these columns.

ALTER TABLE public.board_instances
  ADD COLUMN IF NOT EXISTS binding_id uuid,
  ADD COLUMN IF NOT EXISTS binding_state text DEFAULT 'verified'::text NOT NULL,
  ADD COLUMN IF NOT EXISTS binding_generation bigint DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS binding_verified_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS cloud_route text,
  ADD COLUMN IF NOT EXISTS route_generation bigint DEFAULT 0 NOT NULL;

ALTER TABLE public.board_instances
  ADD CONSTRAINT board_instances_binding_state_check
    CHECK (binding_state = ANY (ARRAY['unpaired'::text, 'pairing'::text, 'assigned'::text, 'verified'::text, 'revoked'::text])),
  ADD CONSTRAINT board_instances_binding_generation_check
    CHECK (binding_generation >= 0),
  ADD CONSTRAINT board_instances_cloud_route_check
    CHECK (cloud_route IS NULL OR cloud_route = ANY (ARRAY['direct_node_mqtt'::text, 'controller_mqtt'::text, 'connecting'::text, 'unavailable'::text])),
  ADD CONSTRAINT board_instances_route_generation_check
    CHECK (route_generation >= 0);

CREATE INDEX IF NOT EXISTS idx_board_instances_binding_generation
  ON public.board_instances USING btree (account_id, binding_generation)
  WHERE (deleted_at IS NULL);

-- Short-lived Worker-issued binding challenges. They are consumed once and
-- never used as a connection proof: verification still requires hardware
-- telemetry from both ends and a healthy Controller cloud session.
CREATE TABLE public.board_binding_challenges (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  node_id uuid NOT NULL,
  controller_id uuid NOT NULL,
  nonce text NOT NULL,
  generation bigint NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  CONSTRAINT board_binding_challenges_pkey PRIMARY KEY (id),
  CONSTRAINT board_binding_challenges_account_fkey FOREIGN KEY (account_id)
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  CONSTRAINT board_binding_challenges_node_fkey FOREIGN KEY (node_id)
    REFERENCES public.board_instances(id) ON DELETE CASCADE,
  CONSTRAINT board_binding_challenges_controller_fkey FOREIGN KEY (controller_id)
    REFERENCES public.board_instances(id) ON DELETE CASCADE,
  CONSTRAINT board_binding_challenges_generation_check CHECK (generation > 0),
  CONSTRAINT board_binding_challenges_distinct_check CHECK (node_id <> controller_id)
);

CREATE INDEX IF NOT EXISTS idx_board_binding_challenge_lookup
  ON public.board_binding_challenges USING btree (account_id, node_id, controller_id, expires_at);
