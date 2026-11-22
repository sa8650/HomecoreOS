-- A code may be generated before a freshly flashed board can report its UID.
-- Resolve that temporary slot to the installed record under the SAME account.
-- Serialize resolution per account; never transfer ownership or delete inventory.
CREATE OR REPLACE FUNCTION public.resolve_pairing_board(p_code_id uuid, p_hardware_uid text, p_identity_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code public.pairing_codes%ROWTYPE;
  v_target public.board_instances%ROWTYPE;
  v_existing uuid;
  v_matches integer;
BEGIN
  SELECT * INTO v_code FROM pairing_codes WHERE id = p_code_id;
  IF NOT FOUND OR v_code.used_at IS NULL THEN RAISE EXCEPTION 'Pairing code must be claimed first'; END IF;
  PERFORM id FROM accounts WHERE id = v_code.account_id FOR UPDATE;
  SELECT * INTO v_target FROM board_instances WHERE id = v_code.board_instance_id AND account_id = v_code.account_id FOR UPDATE;
  IF NOT FOUND OR v_target.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Target controller unavailable'; END IF;

  IF EXISTS (SELECT 1 FROM board_instances WHERE account_id <> v_code.account_id
    AND deleted_at IS NULL AND permanently_deleted_at IS NULL
    AND ((nullif(p_hardware_uid, '') IS NOT NULL AND
          upper(regexp_replace(hardware_uid, '[^a-fA-F0-9]', '', 'g')) = upper(regexp_replace(p_hardware_uid, '[^a-fA-F0-9]', '', 'g')))
      OR (nullif(p_identity_hash, '') IS NOT NULL AND board_instance_identity_secret_hash = p_identity_hash)))
  THEN RAISE EXCEPTION 'Board identity is already assigned to another account'; END IF;

  SELECT count(*), min(id::text)::uuid INTO v_matches, v_existing FROM board_instances
  WHERE account_id = v_code.account_id AND deleted_at IS NULL AND permanently_deleted_at IS NULL
    AND id <> v_target.id
    AND ((nullif(p_hardware_uid, '') IS NOT NULL AND
          upper(regexp_replace(hardware_uid, '[^a-fA-F0-9]', '', 'g')) = upper(regexp_replace(p_hardware_uid, '[^a-fA-F0-9]', '', 'g')))
      OR (nullif(p_identity_hash, '') IS NOT NULL AND board_instance_identity_secret_hash = p_identity_hash));
  IF v_matches > 1 THEN RAISE EXCEPTION 'Ambiguous installed board identity'; END IF;
  IF v_existing IS NOT NULL THEN
    -- Only an empty, never-paired provisional slot can be discarded.
    IF v_target.paired_at IS NOT NULL OR v_target.hardware_uid IS NOT NULL OR v_target.room_id IS NOT NULL OR v_target.assigned_controller_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM devices WHERE board_instance_id = v_target.id)
      OR EXISTS (SELECT 1 FROM sensors WHERE board_instance_id = v_target.id)
      OR EXISTS (SELECT 1 FROM switches WHERE board_instance_id = v_target.id)
      OR EXISTS (SELECT 1 FROM board_instances WHERE assigned_controller_id = v_target.id)
    THEN RAISE EXCEPTION 'Cannot merge a controller with existing identity or assignments'; END IF;
    UPDATE pairing_codes SET board_instance_id = v_existing WHERE board_instance_id = v_target.id AND account_id = v_code.account_id;
    DELETE FROM board_instances WHERE id = v_target.id AND account_id = v_code.account_id;
    RETURN v_existing;
  END IF;
  -- Reserve the UID under the account lock before the rest of provisioning.
  IF nullif(p_hardware_uid, '') IS NOT NULL THEN
    UPDATE board_instances SET hardware_uid = p_hardware_uid WHERE id = v_target.id;
  END IF;
  RETURN v_target.id;
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_pairing_board(uuid, text, text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.resolve_pairing_board(uuid, text, text) TO service_role;
  END IF;
END $$;
