-- HomecoreOS Controller Recovery, Soft-Delete Trash, Identity Separation & Cancelled OTA Support

ALTER TABLE public.controllers
  ADD COLUMN IF NOT EXISTS wifi_connected BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pairing_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wifi_last_connected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mqtt_last_connected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trash_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS permanently_deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS controller_identity_secret_hash TEXT;

ALTER TABLE public.controllers
  DROP CONSTRAINT IF EXISTS controllers_pairing_status_check;

ALTER TABLE public.controllers
  ADD CONSTRAINT controllers_pairing_status_check
  CHECK (pairing_status IN ('pending', 'paired', 'revoked', 'recovery_pending'));

-- Backfill pairing_status & trash_expires_at for existing controller rows
UPDATE public.controllers
SET
  pairing_status = CASE
    WHEN deleted_at IS NOT NULL THEN 'revoked'
    WHEN paired_at IS NOT NULL THEN 'paired'
    ELSE 'pending'
  END,
  wifi_connected = CASE
    WHEN deleted_at IS NULL AND status = 'online' THEN true
    ELSE wifi_connected
  END,
  trash_expires_at = CASE
    WHEN deleted_at IS NOT NULL AND trash_expires_at IS NULL THEN deleted_at + INTERVAL '30 days'
    ELSE trash_expires_at
  END;

CREATE INDEX IF NOT EXISTS idx_controllers_trash
  ON public.controllers (account_id, deleted_at)
  WHERE deleted_at IS NOT NULL AND permanently_deleted_at IS NULL;

-- Track pairing code purpose (initial pairing vs recovery re-pairing)
ALTER TABLE public.pairing_codes
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'initial_pair',
  ADD COLUMN IF NOT EXISTS requires_physical_confirmation BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.pairing_codes
  DROP CONSTRAINT IF EXISTS pairing_codes_purpose_check;

ALTER TABLE public.pairing_codes
  ADD CONSTRAINT pairing_codes_purpose_check
  CHECK (purpose IN ('initial_pair', 'recovery'));

-- Track entity deletion reason so restoring a controller from Trash restores
-- its associated devices, switches, and sensors cleanly without resurrecting items
-- that were individually deleted prior to controller deletion.
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS deleted_reason TEXT,
  ADD COLUMN IF NOT EXISTS permanently_deleted_at TIMESTAMPTZ;

ALTER TABLE public.switches
  ADD COLUMN IF NOT EXISTS deleted_reason TEXT,
  ADD COLUMN IF NOT EXISTS permanently_deleted_at TIMESTAMPTZ;

ALTER TABLE public.sensors
  ADD COLUMN IF NOT EXISTS deleted_reason TEXT,
  ADD COLUMN IF NOT EXISTS permanently_deleted_at TIMESTAMPTZ;

-- Support 'cancelled' in firmware_update_history status
ALTER TABLE public.firmware_update_history
  DROP CONSTRAINT IF EXISTS firmware_update_history_status_check;

ALTER TABLE public.firmware_update_history
  ADD CONSTRAINT firmware_update_history_status_check
  CHECK (status IN ('pending', 'downloading', 'flashing', 'verifying', 'rebooting', 'succeeded', 'rolled_back', 'failed', 'cancelled'));

-- Update atomic single-use pairing code verification RPC to return purpose & physical confirmation requirement
DROP FUNCTION IF EXISTS public.claim_pairing_code(TEXT);

CREATE OR REPLACE FUNCTION public.claim_pairing_code(p_code_hash TEXT)
RETURNS TABLE (
  pairing_code_id UUID,
  account_id UUID,
  controller_id UUID,
  account_status TEXT,
  purpose TEXT,
  requires_physical_confirmation BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row public.pairing_codes%ROWTYPE;
  v_account_status TEXT;
BEGIN
  SELECT * INTO v_row
  FROM public.pairing_codes
  WHERE code_hash = p_code_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_row.used_at IS NOT NULL OR v_row.expires_at <= now() OR v_row.attempt_count >= v_row.max_attempts THEN
    UPDATE public.pairing_codes
    SET attempt_count = attempt_count + 1
    WHERE id = v_row.id;
    RETURN;
  END IF;

  SELECT a.status INTO v_account_status
  FROM public.accounts a
  WHERE a.id = v_row.account_id AND a.deleted_at IS NULL;

  IF v_account_status IS NULL OR v_account_status <> 'active' THEN
    RETURN;
  END IF;

  UPDATE public.pairing_codes
  SET used_at = now(),
      attempt_count = attempt_count + 1
  WHERE id = v_row.id;

  RETURN QUERY SELECT
    v_row.id,
    v_row.account_id,
    v_row.controller_id,
    v_account_status,
    v_row.purpose,
    v_row.requires_physical_confirmation;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.claim_pairing_code(TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.claim_pairing_code(TEXT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.claim_pairing_code(TEXT) TO service_role;
  END IF;
END $$;
