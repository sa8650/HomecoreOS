-- HomecoreOS Initial PostgreSQL Schema
-- Supabase is used strictly as PostgreSQL.
-- Row Level Security (RLS) is intentionally NOT enabled; all database access
-- goes exclusively through the Cloudflare Worker using service_role.

-- Updated-at trigger helper
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 1. Users (customer users and platform administrators strictly separated by user_kind)
CREATE TABLE public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  user_kind TEXT NOT NULL CHECK (user_kind IN ('customer', 'platform_admin')),
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  appearance_preference TEXT NOT NULL DEFAULT 'system' CHECK (appearance_preference IN ('light', 'dark', 'system')),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT users_email_kind_unique UNIQUE (email, user_kind)
);

CREATE INDEX idx_users_email_kind ON public.users (lower(email), user_kind) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. Platform Staff (platform administrators only)
CREATE TABLE public.platform_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'operator', 'support')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_platform_staff_updated_at
  BEFORE UPDATE ON public.platform_staff
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. Customer Accounts
CREATE TABLE public.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'pending_deletion')),
  paused_at TIMESTAMPTZ,
  deletion_requested_at TIMESTAMPTZ,
  deletion_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_accounts_owner ON public.accounts (owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_accounts_status ON public.accounts (status) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_accounts_updated_at
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 4. Customer Staff
CREATE TABLE public.staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'administrator', 'operator', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  invited_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT staff_account_user_unique UNIQUE (account_id, user_id)
);

CREATE INDEX idx_staff_account ON public.staff (account_id);
CREATE INDEX idx_staff_user ON public.staff (user_id);

CREATE TRIGGER trg_staff_updated_at
  BEFORE UPDATE ON public.staff
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 5. Shareable Staff Invitations (no paid email provider required)
CREATE TABLE public.staff_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  code_prefix TEXT NOT NULL,
  invited_email TEXT,
  role TEXT NOT NULL CHECK (role IN ('administrator', 'operator', 'viewer')),
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses INT NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  used_count INT NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_staff_invitations_account ON public.staff_invitations (account_id);

-- 6. Database-backed Sessions (store only SHA-256 token_hash)
CREATE TABLE public.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  active_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  session_scope TEXT NOT NULL CHECK (session_scope IN ('user_console', 'admin_console')),
  token_hash TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_user_scope ON public.sessions (user_id, session_scope) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_expires ON public.sessions (expires_at);

-- 7. Login Attempt Protection
CREATE TABLE public.login_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  first_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT login_attempts_ident_ip_unique UNIQUE (identifier, ip_address)
);

-- 8. Homes
CREATE TABLE public.homes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_homes_account ON public.homes (account_id) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_homes_updated_at
  BEFORE UPDATE ON public.homes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 9. Rooms
CREATE TABLE public.rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  home_id UUID NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'RiHomeLine',
  floor_order INT NOT NULL DEFAULT 0,
  grid_col_span INT NOT NULL DEFAULT 1 CHECK (grid_col_span BETWEEN 1 AND 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_rooms_account_home ON public.rooms (account_id, home_id) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_rooms_updated_at
  BEFORE UPDATE ON public.rooms
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 10. Areas (nested inside Rooms)
CREATE TABLE public.areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'RiLayoutGridLine',
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_areas_account_room ON public.areas (account_id, room_id) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_areas_updated_at
  BEFORE UPDATE ON public.areas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 11. Board Catalog (platform-managed supported ESP32 boards)
CREATE TABLE public.board_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  manufacturer TEXT NOT NULL,
  model TEXT NOT NULL,
  revision TEXT NOT NULL DEFAULT 'v1.0',
  chip_family TEXT NOT NULL CHECK (chip_family IN ('esp32s3', 'esp32', 'esp32c3', 'esp32c6', 'esp32s2')),
  chip_variant TEXT NOT NULL,
  flash_size_mb INT NOT NULL CHECK (flash_size_mb BETWEEN 2 AND 64),
  psram_size_mb INT NOT NULL DEFAULT 0 CHECK (psram_size_mb BETWEEN 0 AND 32),
  usb_vid TEXT,
  usb_pid TEXT,
  is_available BOOLEAN NOT NULL DEFAULT true,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_board_catalog_available ON public.board_catalog (chip_family, is_available) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_board_catalog_updated_at
  BEFORE UPDATE ON public.board_catalog
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 12. Custom Boards (account-scoped validated hardware profiles)
CREATE TABLE public.custom_boards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  model TEXT NOT NULL,
  revision TEXT NOT NULL DEFAULT 'v1.0',
  chip_family TEXT NOT NULL CHECK (chip_family IN ('esp32s3', 'esp32', 'esp32c3', 'esp32c6', 'esp32s2')),
  chip_variant TEXT NOT NULL,
  flash_size_mb INT NOT NULL CHECK (flash_size_mb BETWEEN 2 AND 64),
  psram_size_mb INT NOT NULL DEFAULT 0 CHECK (psram_size_mb BETWEEN 0 AND 32),
  is_validated BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT custom_boards_account_slug_unique UNIQUE (account_id, slug)
);

CREATE INDEX idx_custom_boards_account ON public.custom_boards (account_id) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_custom_boards_updated_at
  BEFORE UPDATE ON public.custom_boards
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 13. Saved Customer Boards ("My Boards" tab)
CREATE TABLE public.account_saved_boards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  board_catalog_id UUID NOT NULL REFERENCES public.board_catalog(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_saved_boards_unique UNIQUE (account_id, board_catalog_id)
);

-- 14. Board GPIO Definitions
CREATE TABLE public.board_gpio_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_catalog_id UUID REFERENCES public.board_catalog(id) ON DELETE CASCADE,
  custom_board_id UUID REFERENCES public.custom_boards(id) ON DELETE CASCADE,
  pin INT NOT NULL CHECK (pin BETWEEN 0 AND 54),
  label TEXT NOT NULL,
  capabilities JSONB NOT NULL,
  restrictions JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT board_gpio_parent_check CHECK (
    (board_catalog_id IS NOT NULL AND custom_board_id IS NULL) OR
    (board_catalog_id IS NULL AND custom_board_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_gpio_catalog_pin ON public.board_gpio_definitions (board_catalog_id, pin) WHERE board_catalog_id IS NOT NULL;
CREATE UNIQUE INDEX idx_gpio_custom_pin ON public.board_gpio_definitions (custom_board_id, pin) WHERE custom_board_id IS NOT NULL;

-- 15. Controllers
CREATE TABLE public.controllers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  home_id UUID NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  board_catalog_id UUID REFERENCES public.board_catalog(id) ON DELETE RESTRICT,
  custom_board_id UUID REFERENCES public.custom_boards(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  hardware_uid TEXT,
  board_model TEXT NOT NULL,
  chip_variant TEXT NOT NULL,
  flash_size_mb INT NOT NULL,
  psram_size_mb INT NOT NULL DEFAULT 0,
  firmware_version TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'online', 'offline', 'disconnected', 'reset_pending', 'updating')),
  mqtt_connected BOOLEAN NOT NULL DEFAULT false,
  wifi_ssid TEXT,
  wifi_rssi INT,
  local_ip TEXT,
  last_heartbeat_at TIMESTAMPTZ,
  last_communication_at TIMESTAMPTZ,
  paired_at TIMESTAMPTZ,
  connection_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT controllers_board_ref_check CHECK (
    (board_catalog_id IS NOT NULL AND custom_board_id IS NULL) OR
    (board_catalog_id IS NULL AND custom_board_id IS NOT NULL)
  )
);

CREATE INDEX idx_controllers_account ON public.controllers (account_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_controllers_status ON public.controllers (status) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_controllers_updated_at
  BEFORE UPDATE ON public.controllers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 16. Pairing Codes (store ONLY SHA-256 code_hash)
CREATE TABLE public.pairing_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  controller_id UUID NOT NULL REFERENCES public.controllers(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pairing_codes_controller ON public.pairing_codes (controller_id) WHERE used_at IS NULL;

-- 17. Devices
CREATE TABLE public.devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  home_id UUID NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  room_id UUID REFERENCES public.rooms(id) ON DELETE SET NULL,
  area_id UUID REFERENCES public.areas(id) ON DELETE SET NULL,
  controller_id UUID NOT NULL REFERENCES public.controllers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  device_type TEXT NOT NULL,
  gpio_pin INT NOT NULL CHECK (gpio_pin BETWEEN 0 AND 54),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  state TEXT NOT NULL DEFAULT 'inactive',
  is_online BOOLEAN NOT NULL DEFAULT false,
  last_state_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_devices_account ON public.devices (account_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_devices_controller ON public.devices (controller_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_devices_unique_pin ON public.devices (controller_id, gpio_pin) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_devices_updated_at
  BEFORE UPDATE ON public.devices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 18. Switches
CREATE TABLE public.switches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  home_id UUID NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  room_id UUID REFERENCES public.rooms(id) ON DELETE SET NULL,
  area_id UUID REFERENCES public.areas(id) ON DELETE SET NULL,
  controller_id UUID NOT NULL REFERENCES public.controllers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  gpio_pin INT NOT NULL CHECK (gpio_pin BETWEEN 0 AND 54),
  is_on BOOLEAN NOT NULL DEFAULT false,
  inverted BOOLEAN NOT NULL DEFAULT false,
  is_online BOOLEAN NOT NULL DEFAULT false,
  last_changed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_switches_account ON public.switches (account_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_switches_controller ON public.switches (controller_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_switches_unique_pin ON public.switches (controller_id, gpio_pin) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_switches_updated_at
  BEFORE UPDATE ON public.switches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 19. Sensors
CREATE TABLE public.sensors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  home_id UUID NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  room_id UUID REFERENCES public.rooms(id) ON DELETE SET NULL,
  area_id UUID REFERENCES public.areas(id) ON DELETE SET NULL,
  controller_id UUID NOT NULL REFERENCES public.controllers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sensor_type TEXT NOT NULL,
  gpio_pin INT CHECK (gpio_pin BETWEEN 0 AND 54),
  unit TEXT NOT NULL,
  last_value DOUBLE PRECISION,
  last_raw_payload JSONB,
  is_online BOOLEAN NOT NULL DEFAULT false,
  last_reading_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_sensors_account ON public.sensors (account_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_sensors_controller ON public.sensors (controller_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_sensors_unique_pin ON public.sensors (controller_id, gpio_pin) WHERE deleted_at IS NULL AND gpio_pin IS NOT NULL;

CREATE TRIGGER trg_sensors_updated_at
  BEFORE UPDATE ON public.sensors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 20. Automation Rules
CREATE TABLE public.automation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  home_id UUID NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  execution_mode TEXT NOT NULL DEFAULT 'cloud' CHECK (execution_mode IN ('cloud', 'controller', 'hybrid')),
  trigger_config JSONB NOT NULL,
  conditions_config JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions_config JSONB NOT NULL,
  last_execution_status TEXT NOT NULL DEFAULT 'idle' CHECK (last_execution_status IN ('idle', 'success', 'failed', 'skipped')),
  last_executed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_automation_rules_account ON public.automation_rules (account_id) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_automation_rules_updated_at
  BEFORE UPDATE ON public.automation_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 21. Firmware Releases
CREATE TABLE public.firmware_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('stable', 'beta', 'development')),
  chip_family TEXT NOT NULL CHECK (chip_family IN ('esp32s3', 'esp32', 'esp32c3', 'esp32c6', 'esp32s2')),
  compatible_board_ids UUID[] NOT NULL DEFAULT '{}',
  compatible_board_slugs TEXT[] NOT NULL DEFAULT '{}',
  ota_available BOOLEAN NOT NULL DEFAULT false,
  usb_available BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  release_notes TEXT NOT NULL DEFAULT '',
  manifest JSONB,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT firmware_releases_name_ver_chip_unique UNIQUE (name, version, chip_family)
);

CREATE INDEX idx_firmware_releases_status ON public.firmware_releases (status, channel) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_firmware_releases_updated_at
  BEFORE UPDATE ON public.firmware_releases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 22. Firmware Files (R2 private object references)
CREATE TABLE public.firmware_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id UUID NOT NULL REFERENCES public.firmware_releases(id) ON DELETE CASCADE,
  file_type TEXT NOT NULL CHECK (file_type IN ('ota_app', 'usb_factory', 'manifest')),
  r2_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL,
  flash_address TEXT,
  flash_mode TEXT,
  flash_freq TEXT,
  flash_size TEXT,
  validated BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_firmware_files_release ON public.firmware_files (release_id);

-- 23. Firmware Update History
CREATE TABLE public.firmware_update_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  controller_id UUID NOT NULL REFERENCES public.controllers(id) ON DELETE CASCADE,
  release_id UUID NOT NULL REFERENCES public.firmware_releases(id) ON DELETE RESTRICT,
  update_type TEXT NOT NULL CHECK (update_type IN ('ota', 'usb_factory')),
  previous_version TEXT,
  target_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'downloading', 'flashing', 'verifying', 'rebooting', 'succeeded', 'rolled_back', 'failed')),
  progress_percent INT NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_fw_history_account ON public.firmware_update_history (account_id, started_at DESC);
CREATE INDEX idx_fw_history_controller ON public.firmware_update_history (controller_id, started_at DESC);

-- 24. MQTT Credentials Metadata (never stores plaintext passwords long-term; synced to EMQX)
CREATE TABLE public.mqtt_credentials_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  controller_id UUID NOT NULL UNIQUE REFERENCES public.controllers(id) ON DELETE CASCADE,
  mqtt_username TEXT NOT NULL UNIQUE,
  mqtt_client_id TEXT NOT NULL UNIQUE,
  device_token_hash TEXT UNIQUE,
  topic_prefix TEXT NOT NULL,
  emqx_synced BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'pending_sync')),
  last_rotated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mqtt_creds_account ON public.mqtt_credentials_metadata (account_id);

CREATE TRIGGER trg_mqtt_creds_updated_at
  BEFORE UPDATE ON public.mqtt_credentials_metadata
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 25. Activity Logs
CREATE TABLE public.activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  controller_id UUID REFERENCES public.controllers(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK (category IN ('controller', 'device', 'switch', 'sensor', 'pairing', 'firmware', 'account', 'staff', 'automation', 'admin', 'security')),
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_activity_logs_account_created ON public.activity_logs (account_id, created_at DESC);
CREATE INDEX idx_activity_logs_created ON public.activity_logs (created_at DESC);

-- 26. Platform Settings (singleton configuration row)
CREATE TABLE public.platform_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  customer_registration_enabled BOOLEAN NOT NULL DEFAULT true,
  pairing_code_expiration_seconds INT NOT NULL DEFAULT 300 CHECK (pairing_code_expiration_seconds BETWEEN 60 AND 1800),
  default_account_status TEXT NOT NULL DEFAULT 'active' CHECK (default_account_status IN ('active', 'paused')),
  controller_heartbeat_interval_seconds INT NOT NULL DEFAULT 30 CHECK (controller_heartbeat_interval_seconds BETWEEN 10 AND 300),
  controller_offline_timeout_seconds INT NOT NULL DEFAULT 90 CHECK (controller_offline_timeout_seconds BETWEEN 30 AND 900),
  max_devices_per_account INT NOT NULL DEFAULT 100 CHECK (max_devices_per_account BETWEEN 1 AND 5000),
  max_controllers_per_account INT NOT NULL DEFAULT 25 CHECK (max_controllers_per_account BETWEEN 1 AND 500),
  supported_firmware_channels TEXT[] NOT NULL DEFAULT ARRAY['stable', 'beta', 'development'],
  maintenance_mode BOOLEAN NOT NULL DEFAULT false,
  board_catalog_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_platform_settings_updated_at
  BEFORE UPDATE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Atomic single-use pairing code verification RPC (prevents race conditions)
CREATE OR REPLACE FUNCTION public.claim_pairing_code(p_code_hash TEXT)
RETURNS TABLE (
  pairing_code_id UUID,
  account_id UUID,
  controller_id UUID,
  account_status TEXT
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

  RETURN QUERY SELECT v_row.id, v_row.account_id, v_row.controller_id, v_account_status;
END;
$$;

-- Atomic initial platform administrator bootstrap (only succeeds when zero admins exist)
CREATE OR REPLACE FUNCTION public.bootstrap_platform_admin(
  p_email TEXT,
  p_password_hash TEXT,
  p_full_name TEXT
)
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  full_name TEXT,
  role TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing_count INT;
  v_user_id UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(784512903);

  SELECT COUNT(*) INTO v_existing_count
  FROM public.platform_staff ps
  JOIN public.users u ON u.id = ps.user_id
  WHERE u.deleted_at IS NULL;

  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_ALREADY_EXISTS';
  END IF;

  INSERT INTO public.users (email, user_kind, password_hash, full_name, status)
  VALUES (lower(trim(p_email)), 'platform_admin', p_password_hash, trim(p_full_name), 'active')
  RETURNING id INTO v_user_id;

  INSERT INTO public.platform_staff (user_id, role, status)
  VALUES (v_user_id, 'super_admin', 'active');

  RETURN QUERY SELECT v_user_id, lower(trim(p_email)), trim(p_full_name), 'super_admin'::TEXT;
END;
$$;

-- Lock down direct PostgREST access for public client roles (anon/authenticated)
-- while ensuring service_role has full DML/RPC access without RLS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA public FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT USAGE ON SCHEMA public TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
  END IF;
END $$;
