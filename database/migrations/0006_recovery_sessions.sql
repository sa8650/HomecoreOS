-- 0006: Unified Repair & Recovery sessions, diagnostics and audit trail.
--
-- The console used to repair a controller in one browser tab with no record:
-- the backend saw only the final pair/recover call, so two tabs could fight
-- over the same board, an interrupted repair left no trace, and a "success"
-- could not be distinguished from "a command was sent". This migration adds
-- the persistence the shared recovery engine needs on the server side:
--
--   recovery_sessions       one row per repair attempt (transport, stage,
--                           diagnostics, plan, verification, final report)
--   recovery_events         append-only stage log inside a session, so the
--                           console can resume an interrupted session and
--                           admins can read the history
--
-- Two invariants the Worker enforces on top of this schema:
--   * at most ONE active session per board (partial unique index);
--   * nothing secret is stored. Wi-Fi passwords, MQTT passwords, device API
--     tokens and pairing codes never appear in these tables — the console
--     writes Wi-Fi credentials straight to the board, and pairing codes are
--     single-use hashes in pairing_codes.
--
-- Diagnostics are stored as structured JSON (check id + status + problem code),
-- never as free text with credentials in it.

CREATE TABLE public.recovery_sessions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  board_instance_id uuid,
  created_by uuid,
  transport text NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  stage text DEFAULT 'discovery'::text NOT NULL,
  -- Identity snapshot read at discovery (no secrets: board slug, chip, fw).
  board_slug text,
  chip_variant text,
  hardware_uid_suffix text,
  firmware_version_before text,
  firmware_version_after text,
  pairing_status_before text,
  -- Structured engine output.
  detected_problems text[] DEFAULT '{}'::text[] NOT NULL,
  diagnostics jsonb DEFAULT '[]'::jsonb NOT NULL,
  repair_plan jsonb DEFAULT '[]'::jsonb NOT NULL,
  actions_attempted jsonb DEFAULT '[]'::jsonb NOT NULL,
  verification jsonb,
  report jsonb,
  unresolved_problems text[] DEFAULT '{}'::text[] NOT NULL,
  next_action text,
  failure_reason text,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  last_stage_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT recovery_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT recovery_sessions_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  CONSTRAINT recovery_sessions_board_instance_id_fkey FOREIGN KEY (board_instance_id)
    REFERENCES public.board_instances(id) ON DELETE SET NULL,
  CONSTRAINT recovery_sessions_created_by_fkey FOREIGN KEY (created_by)
    REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT recovery_sessions_transport_check
    CHECK (transport = ANY (ARRAY['wifi'::text, 'ble'::text, 'usb'::text])),
  CONSTRAINT recovery_sessions_status_check
    CHECK (status = ANY (ARRAY[
      'active'::text, 'completed'::text, 'failed'::text,
      'unverified'::text, 'expired'::text, 'abandoned'::text
    ])),
  CONSTRAINT recovery_sessions_stage_check
    CHECK (stage = ANY (ARRAY[
      'discovery'::text, 'diagnostics'::text, 'plan'::text,
      'repair'::text, 'verification'::text, 'report'::text
    ]))
);

-- One active recovery per board. Two browsers can never repair the same
-- controller at the same time; an expired/closed row drops out of the index.
CREATE UNIQUE INDEX idx_recovery_sessions_one_active_per_board
  ON public.recovery_sessions USING btree (board_instance_id)
  WHERE (status = 'active'::text AND board_instance_id IS NOT NULL);

CREATE INDEX idx_recovery_sessions_account_started
  ON public.recovery_sessions USING btree (account_id, started_at DESC);

CREATE INDEX idx_recovery_sessions_board_started
  ON public.recovery_sessions USING btree (board_instance_id, started_at DESC)
  WHERE (board_instance_id IS NOT NULL);

CREATE INDEX idx_recovery_sessions_expiry
  ON public.recovery_sessions USING btree (expires_at)
  WHERE (status = 'active'::text);

COMMENT ON TABLE public.recovery_sessions IS
  'One row per Repair & Recovery attempt across Wi-Fi, BLE and USB. Never stores Wi-Fi passwords, pairing codes, MQTT passwords or device tokens.';

CREATE TABLE public.recovery_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  session_id uuid NOT NULL,
  account_id uuid NOT NULL,
  board_instance_id uuid,
  stage text NOT NULL,
  status text NOT NULL,
  step text,
  message text,
  problem_codes text[] DEFAULT '{}'::text[] NOT NULL,
  detail jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT recovery_events_pkey PRIMARY KEY (id),
  CONSTRAINT recovery_events_session_id_fkey FOREIGN KEY (session_id)
    REFERENCES public.recovery_sessions(id) ON DELETE CASCADE,
  CONSTRAINT recovery_events_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  CONSTRAINT recovery_events_stage_check
    CHECK (stage = ANY (ARRAY[
      'discovery'::text, 'diagnostics'::text, 'plan'::text,
      'repair'::text, 'verification'::text, 'report'::text
    ])),
  CONSTRAINT recovery_events_status_check
    CHECK (status = ANY (ARRAY[
      'started'::text, 'progress'::text, 'succeeded'::text,
      'failed'::text, 'unknown'::text, 'skipped'::text
    ]))
);

CREATE INDEX idx_recovery_events_session_created
  ON public.recovery_events USING btree (session_id, created_at ASC);

CREATE INDEX idx_recovery_events_account_created
  ON public.recovery_events USING btree (account_id, created_at DESC);

COMMENT ON TABLE public.recovery_events IS
  'Append-only stage log of a recovery session (diagnostics, repairs, verification). Safe to show to the customer and to admins; no credentials.';
