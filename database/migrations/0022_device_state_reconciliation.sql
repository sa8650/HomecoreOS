-- Reliable device state management: desired vs applied state with a monotonic
-- revision so the most recent command always wins.
--
-- Design notes
-- ------------
-- * `is_on` (switches) and `state` (devices) remain the authoritative
--   "last confirmed" mirror so existing firmware, API consumers and the current
--   UI keep working unchanged. `applied_state` is a structured view of the same
--   value, written in the same UPDATE statement so the two can never drift.
-- * `desired_state` is NULL when there is no outstanding intent, i.e. when
--   applied state is already what the user wants. That keeps the common case
--   free of extra rows/columns churn and makes "pending" unambiguous.
-- * `desired_rev` is monotonic and never decreases. It is compared against
--   `applied_rev` to decide whether a controller still has work to do.
-- * `state_status` is derived by the RPC below and never set by callers.

ALTER TABLE public.switches
  ADD COLUMN IF NOT EXISTS desired_state JSONB,
  ADD COLUMN IF NOT EXISTS applied_state JSONB,
  ADD COLUMN IF NOT EXISTS desired_rev BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS applied_rev BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS state_status TEXT NOT NULL DEFAULT 'synced',
  ADD COLUMN IF NOT EXISTS last_command_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS apply_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS state_error TEXT;

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS desired_state JSONB,
  ADD COLUMN IF NOT EXISTS applied_state JSONB,
  ADD COLUMN IF NOT EXISTS desired_rev BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS applied_rev BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS state_status TEXT NOT NULL DEFAULT 'synced',
  ADD COLUMN IF NOT EXISTS last_command_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS apply_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS state_error TEXT;

-- Backfill: seed applied state from the existing columns so every pre-existing
-- row starts from a known, consistent baseline.
UPDATE public.switches
SET applied_state = jsonb_build_object('on', is_on)
WHERE applied_state IS NULL;

UPDATE public.devices
SET applied_state = jsonb_build_object('state', state)
WHERE applied_state IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'switches_state_status_check'
  ) THEN
    ALTER TABLE public.switches
      ADD CONSTRAINT switches_state_status_check
      CHECK (state_status IN ('synced', 'pending', 'failed', 'expired'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_state_status_check'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_state_status_check
      CHECK (state_status IN ('synced', 'pending', 'failed', 'expired'));
  END IF;
END $$;

-- Partial indexes keep the reconciliation sweep cheap: it only ever looks for
-- rows with outstanding work.
CREATE INDEX IF NOT EXISTS idx_switches_pending_state
  ON public.switches (controller_id)
  WHERE state_status = 'pending' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_devices_pending_state
  ON public.devices (controller_id)
  WHERE state_status = 'pending' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_switches_pending_state_account
  ON public.switches (account_id)
  WHERE state_status = 'pending' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_devices_pending_state_account
  ON public.devices (account_id)
  WHERE state_status = 'pending' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Atomic command intake
-- ---------------------------------------------------------------------------
-- Single writer of desired state. Row-locked so concurrent toggles cannot
-- interleave, and monotonic so a late/duplicate request can never overwrite a
-- newer intent.
--
-- Returns the row after a successful update. `accepted = false` means the
-- command was a no-op (duplicate or stale) and MUST NOT be published to MQTT;
-- `reason` explains why.
CREATE OR REPLACE FUNCTION public.apply_entity_command(
  p_entity_kind TEXT,
  p_entity_id UUID,
  p_account_id UUID,
  p_desired_state JSONB,
  p_expected_rev BIGINT DEFAULT NULL
)
RETURNS TABLE (
  accepted BOOLEAN,
  reason TEXT,
  desired_state JSONB,
  applied_state JSONB,
  desired_rev BIGINT,
  applied_rev BIGINT,
  state_status TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_desired JSONB;
  v_applied JSONB;
  v_desired_rev BIGINT;
  v_applied_rev BIGINT;
  v_status TEXT;
  v_next BIGINT;
BEGIN
  IF p_entity_kind NOT IN ('switch', 'device') THEN
    RAISE EXCEPTION 'unsupported entity kind %', p_entity_kind;
  END IF;

  IF p_entity_kind = 'switch' THEN
    SELECT s.desired_state, s.applied_state, s.desired_rev, s.applied_rev, s.state_status
      INTO v_desired, v_applied, v_desired_rev, v_applied_rev, v_status
      FROM public.switches s
     WHERE s.id = p_entity_id AND s.account_id = p_account_id AND s.deleted_at IS NULL
     FOR UPDATE;
  ELSE
    SELECT d.desired_state, d.applied_state, d.desired_rev, d.applied_rev, d.state_status
      INTO v_desired, v_applied, v_desired_rev, v_applied_rev, v_status
      FROM public.devices d
     WHERE d.id = p_entity_id AND d.account_id = p_account_id AND d.deleted_at IS NULL
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Optimistic concurrency: a caller that observed an older revision must not
  -- be allowed to overwrite a newer intent (protects rapid toggle races).
  IF p_expected_rev IS NOT NULL AND p_expected_rev < COALESCE(v_desired_rev, 0) THEN
    RETURN QUERY SELECT FALSE, 'stale_revision'::TEXT, v_desired, v_applied,
      COALESCE(v_desired_rev, 0), COALESCE(v_applied_rev, 0), v_status;
    RETURN;
  END IF;

  -- The user is asking for the state the controller has already confirmed.
  IF v_desired IS NULL AND v_applied IS NOT DISTINCT FROM p_desired_state THEN
    RETURN QUERY SELECT FALSE, 'already_applied'::TEXT, v_desired, v_applied,
      COALESCE(v_desired_rev, 0), COALESCE(v_applied_rev, 0), v_status;
    RETURN;
  END IF;

  -- An identical intent is already queued: idempotent, do not re-publish.
  IF v_desired IS NOT DISTINCT FROM p_desired_state AND v_status = 'pending' THEN
    RETURN QUERY SELECT FALSE, 'duplicate_pending'::TEXT, v_desired, v_applied,
      COALESCE(v_desired_rev, 0), COALESCE(v_applied_rev, 0), v_status;
    RETURN;
  END IF;

  v_next := GREATEST(COALESCE(v_desired_rev, 0), COALESCE(v_applied_rev, 0)) + 1;

  IF v_applied IS NOT DISTINCT FROM p_desired_state THEN
    -- Intent matches confirmed reality again (e.g. user undid a pending change
    -- before it was delivered). Collapse to synced without a revision change.
    v_status := 'synced';
    v_desired := NULL;
    v_desired_rev := v_next;
  ELSE
    v_status := 'pending';
    v_desired := p_desired_state;
    v_desired_rev := v_next;
  END IF;

  IF p_entity_kind = 'switch' THEN
    UPDATE public.switches s
       SET desired_state = v_desired,
           desired_rev = v_desired_rev,
           state_status = v_status,
           last_command_at = now(),
           apply_attempts = CASE WHEN v_status = 'pending' THEN 0 ELSE s.apply_attempts END,
           state_error = CASE WHEN v_status = 'pending' THEN NULL ELSE s.state_error END,
           updated_at = now()
     WHERE s.id = p_entity_id AND s.account_id = p_account_id;
  ELSE
    UPDATE public.devices d
       SET desired_state = v_desired,
           desired_rev = v_desired_rev,
           state_status = v_status,
           last_command_at = now(),
           apply_attempts = CASE WHEN v_status = 'pending' THEN 0 ELSE d.apply_attempts END,
           state_error = CASE WHEN v_status = 'pending' THEN NULL ELSE d.state_error END,
           updated_at = now()
     WHERE d.id = p_entity_id AND d.account_id = p_account_id;
  END IF;

  RETURN QUERY SELECT TRUE, 'accepted'::TEXT, v_desired, v_applied,
    v_desired_rev, COALESCE(v_applied_rev, 0), v_status;
END;
$$;

-- ---------------------------------------------------------------------------
-- Controller confirmation
-- ---------------------------------------------------------------------------
-- Called when a controller reports the state it actually reached. Only a
-- report at least as new as the pending intent clears it; older reports are
-- ignored so a delayed duplicate acknowledgement cannot resurrect a stale state.
CREATE OR REPLACE FUNCTION public.confirm_entity_state(
  p_entity_kind TEXT,
  p_entity_id UUID,
  p_account_id UUID,
  p_applied_state JSONB,
  p_applied_rev BIGINT DEFAULT NULL
)
RETURNS TABLE (
  confirmed BOOLEAN,
  state_status TEXT,
  applied_rev BIGINT,
  desired_rev BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_desired_rev BIGINT;
  v_applied_rev BIGINT;
  v_status TEXT;
  v_reported BIGINT;
  v_has_desired BOOLEAN;
BEGIN
  IF p_entity_kind NOT IN ('switch', 'device') THEN
    RAISE EXCEPTION 'unsupported entity kind %', p_entity_kind;
  END IF;

  IF p_entity_kind = 'switch' THEN
    SELECT s.desired_rev, s.applied_rev, s.state_status, (s.desired_state IS NOT NULL)
      INTO v_desired_rev, v_applied_rev, v_status, v_has_desired
      FROM public.switches s
     WHERE s.id = p_entity_id AND s.account_id = p_account_id AND s.deleted_at IS NULL
     FOR UPDATE;
  ELSE
    SELECT d.desired_rev, d.applied_rev, d.state_status, (d.desired_state IS NOT NULL)
      INTO v_desired_rev, v_applied_rev, v_status, v_has_desired
      FROM public.devices d
     WHERE d.id = p_entity_id AND d.account_id = p_account_id AND d.deleted_at IS NULL
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Backward compatibility: firmware predating desired-state support reports no
  -- revision. We cannot order such a report, so we treat its arrival as the
  -- controller catching up with the latest intent. Otherwise legacy devices
  -- would sit in 'pending' forever after their first command.
  IF p_applied_rev IS NULL THEN
    v_reported := GREATEST(COALESCE(v_desired_rev, 0), COALESCE(v_applied_rev, 0));
  ELSE
    v_reported := GREATEST(p_applied_rev, COALESCE(v_applied_rev, 0));
  END IF;

  IF p_entity_kind = 'switch' THEN
    UPDATE public.switches s
       SET applied_state = p_applied_state,
           applied_rev = v_reported,
           is_on = COALESCE((p_applied_state ->> 'on')::BOOLEAN, s.is_on),
           -- Only an outstanding intent can leave the row 'pending'. A stale
           -- report arriving with nothing desired must not resurrect a pending
           -- state (that would make "pending" a permanent lie to the UI).
           state_status = CASE
             WHEN v_has_desired AND v_desired_rev > v_reported THEN 'pending'
             ELSE 'synced'
           END,
           desired_state = CASE
             WHEN v_has_desired AND v_desired_rev > v_reported THEN s.desired_state
             ELSE NULL
           END,
           state_error = NULL,
           last_changed_at = CASE
             WHEN s.applied_state IS DISTINCT FROM p_applied_state THEN now()
             ELSE s.last_changed_at
           END,
           updated_at = now()
     WHERE s.id = p_entity_id AND s.account_id = p_account_id;
  ELSE
    UPDATE public.devices d
       SET applied_state = p_applied_state,
           applied_rev = v_reported,
           state = COALESCE(p_applied_state ->> 'state', d.state),
           state_status = CASE
             WHEN v_has_desired AND v_desired_rev > v_reported THEN 'pending'
             ELSE 'synced'
           END,
           desired_state = CASE
             WHEN v_has_desired AND v_desired_rev > v_reported THEN d.desired_state
             ELSE NULL
           END,
           state_error = NULL,
           updated_at = now()
     WHERE d.id = p_entity_id AND d.account_id = p_account_id;
  END IF;

  RETURN QUERY
    SELECT TRUE,
           CASE WHEN v_has_desired AND v_desired_rev > v_reported THEN 'pending' ELSE 'synced' END,
           v_reported,
           v_desired_rev;
END;
$$;
