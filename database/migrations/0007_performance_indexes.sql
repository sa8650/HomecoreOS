-- HomecoreOS Performance Indexes & Single-Roundtrip Session Resolution RPCs

-- 1. Covering & Partial Indexes for Hot Queries
CREATE INDEX IF NOT EXISTS idx_sessions_token_scope_active
  ON public.sessions (token_hash, session_scope)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_staff_user_active_account
  ON public.staff (user_id, account_id, created_at ASC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_platform_staff_user_active
  ON public.platform_staff (user_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_devices_account_created
  ON public.devices (account_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_switches_account_created
  ON public.switches (account_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sensors_account_created
  ON public.sensors (account_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rooms_account_order
  ON public.rooms (account_id, floor_order ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_controllers_active_created
  ON public.controllers (account_id, created_at DESC)
  WHERE deleted_at IS NULL AND permanently_deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_controllers_online_heartbeat
  ON public.controllers (status, last_heartbeat_at)
  WHERE deleted_at IS NULL AND permanently_deleted_at IS NULL AND status = 'online';

CREATE INDEX IF NOT EXISTS idx_automation_rules_account_enabled
  ON public.automation_rules (account_id, enabled)
  WHERE deleted_at IS NULL AND enabled = true;

CREATE INDEX IF NOT EXISTS idx_mqtt_creds_ctrl_acct_active
  ON public.mqtt_credentials_metadata (controller_id, account_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_firmware_releases_published
  ON public.firmware_releases (status, published_at DESC)
  WHERE deleted_at IS NULL;

-- 2. Single-Roundtrip User Session Context Resolution (collapses 5 sequential HTTP queries -> 1)
CREATE OR REPLACE FUNCTION public.resolve_user_session_context(p_token_hash TEXT)
RETURNS TABLE (
  session_id UUID,
  user_id UUID,
  email TEXT,
  full_name TEXT,
  appearance_preference TEXT,
  timezone TEXT,
  account_id UUID,
  account_name TEXT,
  account_slug TEXT,
  account_status TEXT,
  staff_id UUID,
  staff_role TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_session_id UUID;
  v_user_id UUID;
  v_active_account_id UUID;
  v_last_seen_at TIMESTAMPTZ;
  v_email TEXT;
  v_full_name TEXT;
  v_appearance TEXT;
  v_timezone TEXT;
  v_account_id UUID;
  v_account_name TEXT;
  v_account_slug TEXT;
  v_account_status TEXT;
  v_staff_id UUID;
  v_staff_role TEXT;
BEGIN
  SELECT s.id, s.user_id, s.active_account_id, s.last_seen_at
  INTO v_session_id, v_user_id, v_active_account_id, v_last_seen_at
  FROM public.sessions s
  WHERE s.token_hash = p_token_hash
    AND s.session_scope = 'user_console'
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT u.email, u.full_name, u.appearance_preference, u.timezone
  INTO v_email, v_full_name, v_appearance, v_timezone
  FROM public.users u
  WHERE u.id = v_user_id
    AND u.user_kind = 'customer'
    AND u.status = 'active'
    AND u.deleted_at IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT st.id, st.role, a.id, a.name, a.slug, a.status
  INTO v_staff_id, v_staff_role, v_account_id, v_account_name, v_account_slug, v_account_status
  FROM public.staff st
  JOIN public.accounts a ON a.id = st.account_id
  WHERE st.user_id = v_user_id
    AND st.status = 'active'
    AND a.deleted_at IS NULL
  ORDER BY (v_active_account_id IS NOT NULL AND st.account_id = v_active_account_id) DESC,
           st.created_at ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Throttle last_seen_at writes to once per 5 minutes to avoid write amplification on hot reads
  IF v_last_seen_at IS NULL OR v_last_seen_at < now() - INTERVAL '5 minutes' THEN
    UPDATE public.sessions
    SET last_seen_at = now()
    WHERE id = v_session_id;
  END IF;

  RETURN QUERY SELECT
    v_session_id,
    v_user_id,
    v_email,
    v_full_name,
    v_appearance,
    v_timezone,
    v_account_id,
    v_account_name,
    v_account_slug,
    v_account_status,
    v_staff_id,
    v_staff_role;
END;
$$;

-- 3. Single-Roundtrip Admin Session Context Resolution (collapses 4-5 sequential HTTP queries -> 1)
CREATE OR REPLACE FUNCTION public.resolve_admin_session_context(p_token_hash TEXT)
RETURNS TABLE (
  session_id UUID,
  user_id UUID,
  email TEXT,
  full_name TEXT,
  appearance_preference TEXT,
  timezone TEXT,
  platform_staff_id UUID,
  platform_role TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_session_id UUID;
  v_user_id UUID;
  v_last_seen_at TIMESTAMPTZ;
  v_email TEXT;
  v_full_name TEXT;
  v_appearance TEXT;
  v_timezone TEXT;
  v_pstaff_id UUID;
  v_pstaff_role TEXT;
BEGIN
  SELECT s.id, s.user_id, s.last_seen_at
  INTO v_session_id, v_user_id, v_last_seen_at
  FROM public.sessions s
  WHERE s.token_hash = p_token_hash
    AND s.session_scope = 'admin_console'
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT u.email, u.full_name, u.appearance_preference, u.timezone, ps.id, ps.role
  INTO v_email, v_full_name, v_appearance, v_timezone, v_pstaff_id, v_pstaff_role
  FROM public.users u
  JOIN public.platform_staff ps ON ps.user_id = u.id
  WHERE u.id = v_user_id
    AND u.user_kind = 'platform_admin'
    AND u.status = 'active'
    AND u.deleted_at IS NULL
    AND ps.status = 'active'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_last_seen_at IS NULL OR v_last_seen_at < now() - INTERVAL '5 minutes' THEN
    UPDATE public.sessions
    SET last_seen_at = now()
    WHERE id = v_session_id;
  END IF;

  RETURN QUERY SELECT
    v_session_id,
    v_user_id,
    v_email,
    v_full_name,
    v_appearance,
    v_timezone,
    v_pstaff_id,
    v_pstaff_role;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.resolve_user_session_context(TEXT) FROM anon;
    REVOKE ALL ON FUNCTION public.resolve_admin_session_context(TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.resolve_user_session_context(TEXT) FROM authenticated;
    REVOKE ALL ON FUNCTION public.resolve_admin_session_context(TEXT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.resolve_user_session_context(TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION public.resolve_admin_session_context(TEXT) TO service_role;
  END IF;
END $$;
