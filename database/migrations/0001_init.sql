-- ============================================================================
-- HomecoreOS — consolidated schema (single migration)
-- ============================================================================
-- This file is the complete, authoritative database schema. It replaces the
-- historical chain 0001..0021: every CREATE/ALTER/DROP from those migrations is
-- folded into the final shape below, so a fresh database needs exactly one
-- migration. Objects that were created and later dropped (areas, legacy board
-- PNG URLs, superseded CHECK constraints) are gone, and redundant indexes that
-- duplicated a wider one were removed.
--
-- Sections: 1 tables + indexes, 2 functions, 3 triggers, 4 foreign keys,
--           5 privileges, 6 seed data (board catalog + platform settings).
--
-- Guarded by database/verify/verify-schema.mjs, which compares the schema this
-- file produces against database/verify/schema-snapshot.json.
--
-- Apply with:  psql "$DATABASE_URL" -f 0001_init.sql
-- ============================================================================
-- 1. Tables and indexes
-- ============================================================================
--
-- Redundant indexes dropped by this consolidation (each was fully covered by a
-- wider index on the same table, so removing it cannot change a query plan that
-- was using it):
--   idx_devices_account              prefix of idx_devices_account_created
--   idx_devices_controller           prefix of unique idx_devices_unique_pin (gpio_pin is NOT NULL)
--   idx_sensors_account              prefix of idx_sensors_account_created
--   idx_switches_account             prefix of idx_switches_account_created
--   idx_switches_controller          prefix of unique idx_switches_unique_pin (gpio_pin is NOT NULL)
--   idx_staff_account                prefix of unique staff_account_user_unique
--   idx_platform_staff_user_active   prefix of unique platform_staff_user_id_key (token_hash is unique)
--   idx_sessions_token_scope_active  token_hash is already unique in sessions_token_hash_key
--

-- account_saved_boards
CREATE TABLE public.account_saved_boards (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  board_profile_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT account_saved_boards_pkey PRIMARY KEY (id),
  CONSTRAINT account_saved_boards_unique UNIQUE (account_id, board_profile_id)
);

-- accounts
CREATE TABLE public.accounts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  owner_user_id uuid NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  paused_at timestamp with time zone,
  deletion_requested_at timestamp with time zone,
  deletion_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone,
  CONSTRAINT accounts_pkey PRIMARY KEY (id),
  CONSTRAINT accounts_slug_key UNIQUE (slug),
  CONSTRAINT accounts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'pending_deletion'::text])))
);
CREATE INDEX idx_accounts_owner ON public.accounts USING btree (owner_user_id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_accounts_status ON public.accounts USING btree (status) WHERE (deleted_at IS NULL);

-- action_button_configs
CREATE TABLE public.action_button_configs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  icon text DEFAULT 'zap'::text NOT NULL,
  color text DEFAULT 'blue'::text NOT NULL,
  category text DEFAULT 'custom'::text NOT NULL,
  config jsonb DEFAULT '{"long": null, "double": null, "single": []}'::jsonb NOT NULL,
  confirmation_required boolean DEFAULT false NOT NULL,
  is_enabled boolean DEFAULT true NOT NULL,
  is_active boolean DEFAULT false NOT NULL,
  last_executed_at timestamp with time zone,
  last_execution_status text,
  last_error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT action_button_configs_pkey PRIMARY KEY (id),
  CONSTRAINT action_button_configs_category_check CHECK ((category = ANY (ARRAY['global'::text, 'room'::text, 'group'::text, 'automation'::text, 'custom'::text]))),
  CONSTRAINT action_button_configs_last_execution_status_check CHECK ((last_execution_status = ANY (ARRAY['success'::text, 'partial'::text, 'failed'::text])))
);
CREATE UNIQUE INDEX idx_action_button_configs_one_active ON public.action_button_configs USING btree (user_id, account_id) WHERE is_active;
CREATE INDEX idx_action_button_configs_user_account ON public.action_button_configs USING btree (user_id, account_id, created_at DESC);

-- activity_logs
CREATE TABLE public.activity_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid,
  actor_user_id uuid,
  board_instance_id uuid,
  category text NOT NULL,
  action text NOT NULL,
  summary text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT activity_logs_pkey PRIMARY KEY (id),
  CONSTRAINT activity_logs_category_check CHECK ((category = ANY (ARRAY['controller'::text, 'device'::text, 'switch'::text, 'sensor'::text, 'pairing'::text, 'firmware'::text, 'account'::text, 'staff'::text, 'automation'::text, 'admin'::text, 'security'::text])))
);
CREATE INDEX idx_activity_logs_account_created ON public.activity_logs USING btree (account_id, created_at DESC);
CREATE INDEX idx_activity_logs_created ON public.activity_logs USING btree (created_at DESC);

-- automation_rules
CREATE TABLE public.automation_rules (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  home_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  enabled boolean DEFAULT true NOT NULL,
  execution_mode text DEFAULT 'cloud'::text NOT NULL,
  trigger_config jsonb NOT NULL,
  conditions_config jsonb DEFAULT '[]'::jsonb NOT NULL,
  actions_config jsonb NOT NULL,
  last_execution_status text DEFAULT 'idle'::text NOT NULL,
  last_executed_at timestamp with time zone,
  last_error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone,
  folder_name text DEFAULT 'General'::text NOT NULL,
  flow_graph jsonb,
  flow_version integer DEFAULT 1 NOT NULL,
  last_run_trace jsonb,
  CONSTRAINT automation_rules_pkey PRIMARY KEY (id),
  CONSTRAINT automation_rules_execution_mode_check CHECK ((execution_mode = ANY (ARRAY['cloud'::text, 'controller'::text, 'hybrid'::text]))),
  CONSTRAINT automation_rules_last_execution_status_check CHECK ((last_execution_status = ANY (ARRAY['idle'::text, 'success'::text, 'failed'::text, 'skipped'::text])))
);
CREATE INDEX idx_automation_rules_account ON public.automation_rules USING btree (account_id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_automation_rules_account_enabled ON public.automation_rules USING btree (account_id, enabled) WHERE ((deleted_at IS NULL) AND (enabled = true));
CREATE INDEX idx_automation_rules_folder ON public.automation_rules USING btree (account_id, folder_name) WHERE (deleted_at IS NULL);

-- board_profiles
CREATE TABLE public.board_profiles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  slug text NOT NULL,
  manufacturer text NOT NULL,
  model text NOT NULL,
  revision text DEFAULT 'v1.0'::text NOT NULL,
  chip_family text NOT NULL,
  chip_variant text NOT NULL,
  flash_size_mb integer NOT NULL,
  psram_size_mb integer DEFAULT 0 NOT NULL,
  usb_vid text,
  usb_pid text,
  is_available boolean DEFAULT true NOT NULL,
  description text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone,
  catalog_category text DEFAULT 'official_espressif'::text NOT NULL,
  series text,
  image_url text,
  pinout_image_url text,
  docs_url text,
  datasheet_url text,
  source_url text,
  source_provider text DEFAULT 'manual'::text NOT NULL,
  verification_status text DEFAULT 'needs_verification'::text NOT NULL,
  firmware_status text DEFAULT 'catalog_only'::text NOT NULL,
  board_layout jsonb DEFAULT '{}'::jsonb NOT NULL,
  revision_notes text,
  last_synced_at timestamp with time zone,
  partition_scheme text DEFAULT 'dual_ota_4mb'::text NOT NULL,
  psram_mode text DEFAULT 'none'::text NOT NULL,
  flash_mode text DEFAULT 'dio'::text NOT NULL,
  flash_freq text DEFAULT '80m'::text NOT NULL,
  bootloader_offset text DEFAULT '0x0'::text NOT NULL,
  ota_app_offset text DEFAULT '0x20000'::text NOT NULL,
  boot_button_gpio integer DEFAULT 0 NOT NULL,
  usb_interface text DEFAULT 'USB-C / UART'::text NOT NULL,
  supports_wifi boolean DEFAULT true NOT NULL,
  supports_ota_rollback boolean DEFAULT true NOT NULL,
  firmware_compat_key text,
  connectivity_note text,
  supports_ble boolean DEFAULT true NOT NULL,
  supports_ble_wifi_provisioning boolean DEFAULT true NOT NULL,
  build_platform text DEFAULT 'esp_idf'::text NOT NULL,
  CONSTRAINT board_profiles_pkey PRIMARY KEY (id),
  CONSTRAINT board_profiles_slug_key UNIQUE (slug),
  CONSTRAINT board_profiles_build_platform_check CHECK ((build_platform = ANY (ARRAY['esp_idf'::text, 'esp8266_rtos_sdk'::text]))),
  CONSTRAINT board_profiles_category_check CHECK ((catalog_category = ANY (ARRAY['official_espressif'::text, 'partner'::text, 'custom'::text]))),
  CONSTRAINT board_profiles_chip_family_check CHECK ((chip_family = ANY (ARRAY['esp32'::text, 'esp32s2'::text, 'esp32s3'::text, 'esp32s31'::text, 'esp32c2'::text, 'esp32c3'::text, 'esp32c5'::text, 'esp32c6'::text, 'esp32c61'::text, 'esp32h2'::text, 'esp32h21'::text, 'esp32h4'::text, 'esp32p4'::text, 'esp8266'::text]))),
  CONSTRAINT board_profiles_firmware_status_check CHECK ((firmware_status = ANY (ARRAY['firmware_supported'::text, 'catalog_only'::text, 'build_pending'::text, 'unsupported'::text]))),
  CONSTRAINT board_profiles_flash_mode_check CHECK ((flash_mode = ANY (ARRAY['qio'::text, 'qout'::text, 'dio'::text, 'dout'::text]))),
  CONSTRAINT board_profiles_flash_size_mb_check CHECK (((flash_size_mb >= 2) AND (flash_size_mb <= 64))),
  CONSTRAINT board_profiles_psram_mode_check CHECK ((psram_mode = ANY (ARRAY['none'::text, 'quad'::text, 'octal'::text]))),
  CONSTRAINT board_profiles_psram_size_mb_check CHECK (((psram_size_mb >= 0) AND (psram_size_mb <= 32))),
  CONSTRAINT board_profiles_verification_check CHECK ((verification_status = ANY (ARRAY['verified'::text, 'needs_verification'::text])))
);
CREATE INDEX idx_board_profiles_available ON public.board_profiles USING btree (chip_family, is_available) WHERE (deleted_at IS NULL);

-- board_profile_sync_runs
CREATE TABLE public.board_profile_sync_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  source_name text NOT NULL,
  status text NOT NULL,
  triggered_by_admin_id uuid,
  discovered_count integer DEFAULT 0 NOT NULL,
  inserted_count integer DEFAULT 0 NOT NULL,
  updated_count integer DEFAULT 0 NOT NULL,
  needs_verification_count integer DEFAULT 0 NOT NULL,
  source_urls jsonb DEFAULT '[]'::jsonb NOT NULL,
  summary_notes text,
  error_message text,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  CONSTRAINT board_profile_sync_runs_pkey PRIMARY KEY (id),
  CONSTRAINT board_profile_sync_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'partial'::text, 'failed'::text])))
);
CREATE INDEX idx_board_sync_runs_started ON public.board_profile_sync_runs USING btree (started_at DESC);

-- board_gpio_definitions
CREATE TABLE public.board_gpio_definitions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  board_profile_id uuid,
  custom_board_profile_id uuid,
  pin integer NOT NULL,
  label text NOT NULL,
  capabilities jsonb NOT NULL,
  restrictions jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  board_pin_name text,
  header_side text,
  header_position integer,
  board_note text,
  CONSTRAINT board_gpio_definitions_pkey PRIMARY KEY (id),
  CONSTRAINT board_gpio_definitions_pin_check CHECK (((pin >= 0) AND (pin <= 54))),
  CONSTRAINT board_gpio_parent_check CHECK ((((board_profile_id IS NOT NULL) AND (custom_board_profile_id IS NULL)) OR ((board_profile_id IS NULL) AND (custom_board_profile_id IS NOT NULL))))
);
CREATE UNIQUE INDEX idx_gpio_catalog_pin ON public.board_gpio_definitions USING btree (board_profile_id, pin) WHERE (board_profile_id IS NOT NULL);
CREATE UNIQUE INDEX idx_gpio_custom_pin ON public.board_gpio_definitions USING btree (custom_board_profile_id, pin) WHERE (custom_board_profile_id IS NOT NULL);

-- board_instances
CREATE TABLE public.board_instances (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  home_id uuid NOT NULL,
  board_profile_id uuid,
  custom_board_profile_id uuid,
  name text NOT NULL,
  hardware_uid text,
  board_model text NOT NULL,
  chip_variant text NOT NULL,
  flash_size_mb integer NOT NULL,
  psram_size_mb integer DEFAULT 0 NOT NULL,
  firmware_version text,
  status text DEFAULT 'pending'::text NOT NULL,
  mqtt_connected boolean DEFAULT false NOT NULL,
  wifi_ssid text,
  wifi_rssi integer,
  local_ip text,
  last_heartbeat_at timestamp with time zone,
  last_communication_at timestamp with time zone,
  paired_at timestamp with time zone,
  connection_history jsonb DEFAULT '[]'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone,
  wifi_connected boolean DEFAULT false NOT NULL,
  pairing_status text DEFAULT 'pending'::text NOT NULL,
  last_error text,
  last_error_at timestamp with time zone,
  wifi_last_connected_at timestamp with time zone,
  mqtt_last_connected_at timestamp with time zone,
  trash_expires_at timestamp with time zone,
  permanently_deleted_at timestamp with time zone,
  board_instance_identity_secret_hash text,
  config_revision integer DEFAULT 1 NOT NULL,
  config_hash text,
  last_synced_config_revision integer DEFAULT 0 NOT NULL,
  last_config_published_at timestamp with time zone,
  last_config_synced_at timestamp with time zone,
  pending_config_sync boolean DEFAULT false NOT NULL,
  heartbeat_interval_sec integer DEFAULT 60 NOT NULL,
  detected_flash_size_mb integer,
  detected_chip_name text,
  reported_board_slug text,
  ble_setup_pin text,
  provisioning_transport text,
  installed_firmware_release_id uuid,
  reported_driver_manifest_hash text,
  room_id uuid,
  CONSTRAINT board_instances_pkey PRIMARY KEY (id),
  CONSTRAINT board_instances_board_ref_check CHECK ((((board_profile_id IS NOT NULL) AND (custom_board_profile_id IS NULL)) OR ((board_profile_id IS NULL) AND (custom_board_profile_id IS NOT NULL)))),
  CONSTRAINT board_instances_pairing_status_check CHECK ((pairing_status = ANY (ARRAY['pending'::text, 'paired'::text, 'revoked'::text, 'recovery_pending'::text]))),
  CONSTRAINT board_instances_provisioning_transport_check CHECK (((provisioning_transport IS NULL) OR (provisioning_transport = ANY (ARRAY['ble'::text, 'softap'::text, 'usb'::text, 'manual'::text])))),
  CONSTRAINT board_instances_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'online'::text, 'offline'::text, 'disconnected'::text, 'reset_pending'::text, 'updating'::text])))
);
CREATE INDEX board_instances_installed_fw_release_idx ON public.board_instances USING btree (installed_firmware_release_id) WHERE ((deleted_at IS NULL) AND (installed_firmware_release_id IS NOT NULL));
CREATE INDEX idx_board_instances_account ON public.board_instances USING btree (account_id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_board_instances_active_created ON public.board_instances USING btree (account_id, created_at DESC) WHERE ((deleted_at IS NULL) AND (permanently_deleted_at IS NULL));
CREATE INDEX idx_board_instances_online_heartbeat ON public.board_instances USING btree (status, last_heartbeat_at) WHERE ((deleted_at IS NULL) AND (permanently_deleted_at IS NULL) AND (status = 'online'::text));
CREATE INDEX idx_board_instances_pending_sync ON public.board_instances USING btree (account_id, pending_config_sync) WHERE ((deleted_at IS NULL) AND (pending_config_sync = true));
CREATE INDEX idx_board_instances_room ON public.board_instances USING btree (room_id) WHERE ((room_id IS NOT NULL) AND (deleted_at IS NULL));
CREATE INDEX idx_board_instances_status ON public.board_instances USING btree (status) WHERE (deleted_at IS NULL);
CREATE INDEX idx_board_instances_trash ON public.board_instances USING btree (account_id, deleted_at) WHERE ((deleted_at IS NOT NULL) AND (permanently_deleted_at IS NULL));

-- custom_board_profiles
CREATE TABLE public.custom_board_profiles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  slug text NOT NULL,
  manufacturer text NOT NULL,
  model text NOT NULL,
  revision text DEFAULT 'v1.0'::text NOT NULL,
  chip_family text NOT NULL,
  chip_variant text NOT NULL,
  flash_size_mb integer NOT NULL,
  psram_size_mb integer DEFAULT 0 NOT NULL,
  is_validated boolean DEFAULT false NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone,
  catalog_category text DEFAULT 'custom'::text NOT NULL,
  image_url text,
  docs_url text,
  board_layout jsonb DEFAULT '{}'::jsonb NOT NULL,
  partition_scheme text DEFAULT 'dual_ota_4mb'::text NOT NULL,
  psram_mode text DEFAULT 'none'::text NOT NULL,
  flash_mode text DEFAULT 'dio'::text NOT NULL,
  flash_freq text DEFAULT '80m'::text NOT NULL,
  bootloader_offset text DEFAULT '0x0'::text NOT NULL,
  ota_app_offset text DEFAULT '0x20000'::text NOT NULL,
  boot_button_gpio integer DEFAULT 0 NOT NULL,
  usb_interface text DEFAULT 'USB-C / UART'::text NOT NULL,
  supports_wifi boolean DEFAULT true NOT NULL,
  supports_ota_rollback boolean DEFAULT true NOT NULL,
  firmware_compat_key text,
  connectivity_note text,
  supports_ble boolean DEFAULT true NOT NULL,
  supports_ble_wifi_provisioning boolean DEFAULT true NOT NULL,
  build_platform text DEFAULT 'esp_idf'::text NOT NULL,
  CONSTRAINT custom_board_profiles_pkey PRIMARY KEY (id),
  CONSTRAINT custom_board_profiles_account_slug_unique UNIQUE (account_id, slug),
  CONSTRAINT custom_board_profiles_build_platform_check CHECK ((build_platform = ANY (ARRAY['esp_idf'::text, 'esp8266_rtos_sdk'::text]))),
  CONSTRAINT custom_board_profiles_chip_family_check CHECK ((chip_family = ANY (ARRAY['esp32'::text, 'esp32s2'::text, 'esp32s3'::text, 'esp32s31'::text, 'esp32c2'::text, 'esp32c3'::text, 'esp32c5'::text, 'esp32c6'::text, 'esp32c61'::text, 'esp32h2'::text, 'esp32h21'::text, 'esp32h4'::text, 'esp32p4'::text, 'esp8266'::text]))),
  CONSTRAINT custom_board_profiles_flash_size_mb_check CHECK (((flash_size_mb >= 2) AND (flash_size_mb <= 64))),
  CONSTRAINT custom_board_profiles_psram_size_mb_check CHECK (((psram_size_mb >= 0) AND (psram_size_mb <= 32)))
);
CREATE INDEX idx_custom_board_profiles_account ON public.custom_board_profiles USING btree (account_id) WHERE (deleted_at IS NULL);

-- devices
CREATE TABLE public.devices (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  home_id uuid NOT NULL,
  room_id uuid,
  board_instance_id uuid NOT NULL,
  name text NOT NULL,
  device_type text NOT NULL,
  gpio_pin integer NOT NULL,
  config jsonb DEFAULT '{}'::jsonb NOT NULL,
  state text DEFAULT 'inactive'::text NOT NULL,
  is_online boolean DEFAULT false NOT NULL,
  last_state_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone,
  deleted_reason text,
  permanently_deleted_at timestamp with time zone,
  CONSTRAINT devices_pkey PRIMARY KEY (id),
  CONSTRAINT devices_gpio_pin_check CHECK (((gpio_pin >= 0) AND (gpio_pin <= 54)))
);
CREATE INDEX idx_devices_account_created ON public.devices USING btree (account_id, created_at DESC) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX idx_devices_unique_pin ON public.devices USING btree (board_instance_id, gpio_pin) WHERE (deleted_at IS NULL);

-- firmware_files
CREATE TABLE public.firmware_files (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  release_id uuid NOT NULL,
  file_type text NOT NULL,
  r2_key text NOT NULL,
  file_name text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  flash_address text,
  flash_mode text,
  flash_freq text,
  flash_size text,
  validated boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  partition_scheme text,
  psram_mode text,
  CONSTRAINT firmware_files_pkey PRIMARY KEY (id),
  CONSTRAINT firmware_files_r2_key_key UNIQUE (r2_key),
  CONSTRAINT firmware_files_file_type_check CHECK ((file_type = ANY (ARRAY['ota_app'::text, 'usb_factory'::text, 'manifest'::text]))),
  CONSTRAINT firmware_files_size_bytes_check CHECK ((size_bytes > 0))
);
CREATE INDEX idx_firmware_files_release ON public.firmware_files USING btree (release_id);

-- firmware_releases
CREATE TABLE public.firmware_releases (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  version text NOT NULL,
  channel text NOT NULL,
  chip_family text NOT NULL,
  compatible_board_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  compatible_board_slugs text[] DEFAULT '{}'::text[] NOT NULL,
  ota_available boolean DEFAULT false NOT NULL,
  usb_available boolean DEFAULT false NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  release_notes text DEFAULT ''::text NOT NULL,
  manifest jsonb,
  created_by uuid,
  published_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone,
  target_board_slug text,
  partition_scheme text,
  psram_mode text,
  flash_mode text,
  flash_freq text,
  flash_size_mb integer,
  build_status text DEFAULT 'manual'::text NOT NULL,
  hardware_verified boolean DEFAULT false NOT NULL,
  verified_board_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  verified_board_slugs text[] DEFAULT '{}'::text[] NOT NULL,
  verification_notes text,
  rollback_from_release_id uuid,
  superseded_by_release_id uuid,
  ci_run_url text,
  ci_commit_sha text,
  supports_ble boolean DEFAULT true NOT NULL,
  supports_ble_wifi_provisioning boolean DEFAULT true NOT NULL,
  driver_manifest jsonb,
  compiled_sensor_drivers text[] DEFAULT '{}'::text[] NOT NULL,
  supported_sensor_types text[] DEFAULT '{}'::text[] NOT NULL,
  manifest_version text,
  manifest_hash text,
  CONSTRAINT firmware_releases_pkey PRIMARY KEY (id),
  CONSTRAINT firmware_releases_build_status_check CHECK ((build_status = ANY (ARRAY['pending'::text, 'building'::text, 'succeeded'::text, 'failed'::text, 'manual'::text]))),
  CONSTRAINT firmware_releases_channel_check CHECK ((channel = ANY (ARRAY['stable'::text, 'beta'::text, 'development'::text]))),
  CONSTRAINT firmware_releases_chip_family_check CHECK ((chip_family = ANY (ARRAY['esp32'::text, 'esp32s2'::text, 'esp32s3'::text, 'esp32s31'::text, 'esp32c2'::text, 'esp32c3'::text, 'esp32c5'::text, 'esp32c6'::text, 'esp32c61'::text, 'esp32h2'::text, 'esp32h21'::text, 'esp32h4'::text, 'esp32p4'::text, 'esp8266'::text]))),
  CONSTRAINT firmware_releases_psram_mode_check CHECK (((psram_mode IS NULL) OR (psram_mode = ANY (ARRAY['none'::text, 'quad'::text, 'octal'::text])))),
  CONSTRAINT firmware_releases_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'deprecated'::text, 'archived'::text])))
);
CREATE INDEX firmware_releases_board_version_lookup_idx ON public.firmware_releases USING btree (chip_family, target_board_slug, version) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX firmware_releases_name_ver_chip_board_unique ON public.firmware_releases USING btree (name, version, chip_family, COALESCE(target_board_slug, ''::text)) WHERE (deleted_at IS NULL);
CREATE INDEX idx_firmware_releases_published ON public.firmware_releases USING btree (status, published_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX idx_firmware_releases_status ON public.firmware_releases USING btree (status, channel) WHERE (deleted_at IS NULL);

-- firmware_update_history
CREATE TABLE public.firmware_update_history (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  board_instance_id uuid NOT NULL,
  release_id uuid NOT NULL,
  update_type text NOT NULL,
  previous_version text,
  target_version text NOT NULL,
  status text NOT NULL,
  progress_percent integer DEFAULT 0 NOT NULL,
  error_message text,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  CONSTRAINT firmware_update_history_pkey PRIMARY KEY (id),
  CONSTRAINT firmware_update_history_progress_percent_check CHECK (((progress_percent >= 0) AND (progress_percent <= 100))),
  CONSTRAINT firmware_update_history_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'downloading'::text, 'flashing'::text, 'verifying'::text, 'rebooting'::text, 'succeeded'::text, 'rolled_back'::text, 'failed'::text, 'cancelled'::text]))),
  CONSTRAINT firmware_update_history_update_type_check CHECK ((update_type = ANY (ARRAY['ota'::text, 'usb_factory'::text])))
);
CREATE INDEX idx_fw_history_account ON public.firmware_update_history USING btree (account_id, started_at DESC);
CREATE INDEX idx_fw_history_controller ON public.firmware_update_history USING btree (board_instance_id, started_at DESC);

-- homes
CREATE TABLE public.homes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  name text NOT NULL,
  timezone text DEFAULT 'UTC'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone,
  CONSTRAINT homes_pkey PRIMARY KEY (id)
);
CREATE INDEX idx_homes_account ON public.homes USING btree (account_id) WHERE (deleted_at IS NULL);

-- login_attempts
CREATE TABLE public.login_attempts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  identifier text NOT NULL,
  ip_address text NOT NULL,
  attempt_count integer DEFAULT 0 NOT NULL,
  first_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
  locked_until timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT login_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT login_attempts_ident_ip_unique UNIQUE (identifier, ip_address)
);

-- mqtt_credentials_metadata
CREATE TABLE public.mqtt_credentials_metadata (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  board_instance_id uuid NOT NULL,
  mqtt_username text NOT NULL,
  mqtt_client_id text NOT NULL,
  device_token_hash text,
  topic_prefix text NOT NULL,
  emqx_synced boolean DEFAULT false NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  last_rotated_at timestamp with time zone DEFAULT now() NOT NULL,
  revoked_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT mqtt_credentials_metadata_pkey PRIMARY KEY (id),
  CONSTRAINT mqtt_credentials_metadata_board_instance_id_key UNIQUE (board_instance_id),
  CONSTRAINT mqtt_credentials_metadata_device_token_hash_key UNIQUE (device_token_hash),
  CONSTRAINT mqtt_credentials_metadata_mqtt_client_id_key UNIQUE (mqtt_client_id),
  CONSTRAINT mqtt_credentials_metadata_mqtt_username_key UNIQUE (mqtt_username),
  CONSTRAINT mqtt_credentials_metadata_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'pending_sync'::text])))
);
CREATE INDEX idx_mqtt_creds_account ON public.mqtt_credentials_metadata USING btree (account_id);
CREATE INDEX idx_mqtt_creds_ctrl_acct_active ON public.mqtt_credentials_metadata USING btree (board_instance_id, account_id) WHERE (status = 'active'::text);

-- notification_preferences
CREATE TABLE public.notification_preferences (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  scope text NOT NULL,
  user_id uuid NOT NULL,
  account_id uuid,
  account_key text DEFAULT ''::text NOT NULL,
  preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT notification_preferences_pkey PRIMARY KEY (id),
  CONSTRAINT notification_preferences_scope_user_id_account_key_key UNIQUE (scope, user_id, account_key),
  CONSTRAINT notification_preferences_scope_check CHECK ((scope = ANY (ARRAY['user'::text, 'admin'::text])))
);

-- notification_user_states
CREATE TABLE public.notification_user_states (
  notification_id uuid NOT NULL,
  user_id uuid NOT NULL,
  is_read boolean DEFAULT false NOT NULL,
  read_at timestamp with time zone,
  cleared_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT notification_user_states_pkey PRIMARY KEY (notification_id, user_id)
);
CREATE INDEX idx_notification_user_states_user ON public.notification_user_states USING btree (user_id, cleared_at, is_read);

-- notifications
CREATE TABLE public.notifications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  scope text NOT NULL,
  account_id uuid,
  user_id uuid,
  category text NOT NULL,
  event_key text NOT NULL,
  preference_key text NOT NULL,
  severity text DEFAULT 'info'::text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  dedup_key text,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  is_read boolean DEFAULT false NOT NULL,
  read_at timestamp with time zone,
  cleared_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_scope_check CHECK ((scope = ANY (ARRAY['user'::text, 'admin'::text]))),
  CONSTRAINT notifications_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'success'::text, 'warning'::text, 'danger'::text])))
);
CREATE INDEX idx_notifications_dedup ON public.notifications USING btree (scope, dedup_key, created_at DESC) WHERE ((cleared_at IS NULL) AND (dedup_key IS NOT NULL));
CREATE INDEX idx_notifications_unread ON public.notifications USING btree (scope, account_id, is_read) WHERE ((cleared_at IS NULL) AND (is_read = false));
CREATE INDEX idx_notifications_user_active ON public.notifications USING btree (scope, account_id, created_at DESC) WHERE (cleared_at IS NULL);

-- pairing_codes
CREATE TABLE public.pairing_codes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  board_instance_id uuid NOT NULL,
  code_hash text NOT NULL,
  attempt_count integer DEFAULT 0 NOT NULL,
  max_attempts integer DEFAULT 5 NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  used_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  purpose text DEFAULT 'initial_pair'::text NOT NULL,
  requires_physical_confirmation boolean DEFAULT false NOT NULL,
  CONSTRAINT pairing_codes_pkey PRIMARY KEY (id),
  CONSTRAINT pairing_codes_code_hash_key UNIQUE (code_hash),
  CONSTRAINT pairing_codes_purpose_check CHECK ((purpose = ANY (ARRAY['initial_pair'::text, 'recovery'::text])))
);
CREATE INDEX idx_pairing_codes_controller ON public.pairing_codes USING btree (board_instance_id) WHERE (used_at IS NULL);

-- planner_plans
CREATE TABLE public.planner_plans (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  created_by uuid,
  name text NOT NULL,
  requirements jsonb DEFAULT '{}'::jsonb NOT NULL,
  result jsonb,
  result_state text,
  result_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
  catalog_revision text,
  engine_version integer DEFAULT 1 NOT NULL,
  analyzed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone,
  CONSTRAINT planner_plans_pkey PRIMARY KEY (id),
  CONSTRAINT planner_plans_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80))),
  CONSTRAINT planner_plans_result_state_check CHECK (((result_state IS NULL) OR (result_state = ANY (ARRAY['ready'::text, 'partially_ready'::text, 'not_supported'::text, 'incomplete'::text]))))
);
CREATE INDEX idx_planner_plans_account ON public.planner_plans USING btree (account_id, created_at DESC) WHERE (deleted_at IS NULL);

-- platform_settings
CREATE TABLE public.platform_settings (
  id integer DEFAULT 1 NOT NULL,
  customer_registration_enabled boolean DEFAULT true NOT NULL,
  pairing_code_expiration_seconds integer DEFAULT 300 NOT NULL,
  default_account_status text DEFAULT 'active'::text NOT NULL,
  controller_heartbeat_interval_seconds integer DEFAULT 30 NOT NULL,
  controller_offline_timeout_seconds integer DEFAULT 90 NOT NULL,
  max_devices_per_account integer DEFAULT 100 NOT NULL,
  max_board_instances_per_account integer DEFAULT 25 NOT NULL,
  supported_firmware_channels text[] DEFAULT ARRAY['stable'::text, 'beta'::text, 'development'::text] NOT NULL,
  maintenance_mode boolean DEFAULT false NOT NULL,
  board_library_enabled boolean DEFAULT true NOT NULL,
  updated_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  default_timezone text DEFAULT 'UTC'::text NOT NULL,
  firmware_downloads_enabled boolean DEFAULT true NOT NULL,
  CONSTRAINT platform_settings_pkey PRIMARY KEY (id),
  CONSTRAINT platform_settings_controller_heartbeat_interval_seconds_check CHECK (((controller_heartbeat_interval_seconds >= 10) AND (controller_heartbeat_interval_seconds <= 300))),
  CONSTRAINT platform_settings_controller_offline_timeout_seconds_check CHECK (((controller_offline_timeout_seconds >= 30) AND (controller_offline_timeout_seconds <= 900))),
  CONSTRAINT platform_settings_default_account_status_check CHECK ((default_account_status = ANY (ARRAY['active'::text, 'paused'::text]))),
  CONSTRAINT platform_settings_id_check CHECK ((id = 1)),
  CONSTRAINT platform_settings_max_board_instances_per_account_check CHECK (((max_board_instances_per_account >= 1) AND (max_board_instances_per_account <= 500))),
  CONSTRAINT platform_settings_max_devices_per_account_check CHECK (((max_devices_per_account >= 1) AND (max_devices_per_account <= 5000))),
  CONSTRAINT platform_settings_pairing_code_expiration_seconds_check CHECK (((pairing_code_expiration_seconds >= 60) AND (pairing_code_expiration_seconds <= 1800)))
);

-- platform_staff
CREATE TABLE public.platform_staff (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT platform_staff_pkey PRIMARY KEY (id),
  CONSTRAINT platform_staff_user_id_key UNIQUE (user_id),
  CONSTRAINT platform_staff_role_check CHECK ((role = ANY (ARRAY['super_admin'::text, 'operator'::text, 'support'::text]))),
  CONSTRAINT platform_staff_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text])))
);

-- rooms
CREATE TABLE public.rooms (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  home_id uuid NOT NULL,
  name text NOT NULL,
  icon text DEFAULT 'RiHomeLine'::text NOT NULL,
  floor_order integer DEFAULT 0 NOT NULL,
  grid_col_span integer DEFAULT 1 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone,
  room_type text DEFAULT 'living_room'::text NOT NULL,
  floor_x integer DEFAULT 0 NOT NULL,
  floor_y integer DEFAULT 0 NOT NULL,
  floor_w integer DEFAULT 320 NOT NULL,
  floor_h integer DEFAULT 240 NOT NULL,
  layout_config jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT rooms_pkey PRIMARY KEY (id),
  CONSTRAINT rooms_grid_col_span_check CHECK (((grid_col_span >= 1) AND (grid_col_span <= 3)))
);
CREATE INDEX idx_rooms_account_home ON public.rooms USING btree (account_id, home_id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_rooms_account_order ON public.rooms USING btree (account_id, floor_order) WHERE (deleted_at IS NULL);

-- sensor_readings
CREATE TABLE public.sensor_readings (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  sensor_id uuid NOT NULL,
  account_id uuid NOT NULL,
  value double precision NOT NULL,
  unit text NOT NULL,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT sensor_readings_pkey PRIMARY KEY (id)
);
CREATE INDEX idx_sensor_readings_account_time ON public.sensor_readings USING btree (account_id, recorded_at DESC);
CREATE INDEX idx_sensor_readings_sensor_time ON public.sensor_readings USING btree (sensor_id, recorded_at DESC);

-- sensors
CREATE TABLE public.sensors (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  home_id uuid NOT NULL,
  room_id uuid,
  board_instance_id uuid NOT NULL,
  name text NOT NULL,
  sensor_type text NOT NULL,
  gpio_pin integer,
  unit text NOT NULL,
  last_value double precision,
  last_raw_payload jsonb,
  is_online boolean DEFAULT false NOT NULL,
  last_reading_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone,
  deleted_reason text,
  permanently_deleted_at timestamp with time zone,
  CONSTRAINT sensors_pkey PRIMARY KEY (id),
  CONSTRAINT sensors_gpio_pin_check CHECK (((gpio_pin >= 0) AND (gpio_pin <= 54)))
);
CREATE INDEX idx_sensors_account_created ON public.sensors USING btree (account_id, created_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX idx_sensors_controller ON public.sensors USING btree (board_instance_id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_sensors_controller_pin ON public.sensors USING btree (board_instance_id, gpio_pin) WHERE ((deleted_at IS NULL) AND (gpio_pin IS NOT NULL));

-- sessions
CREATE TABLE public.sessions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  active_account_id uuid,
  session_scope text NOT NULL,
  token_hash text NOT NULL,
  ip_address text,
  user_agent text,
  expires_at timestamp with time zone NOT NULL,
  revoked_at timestamp with time zone,
  last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT sessions_pkey PRIMARY KEY (id),
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT sessions_session_scope_check CHECK ((session_scope = ANY (ARRAY['user_console'::text, 'admin_console'::text])))
);
CREATE INDEX idx_sessions_expires ON public.sessions USING btree (expires_at);
CREATE INDEX idx_sessions_user_scope ON public.sessions USING btree (user_id, session_scope) WHERE (revoked_at IS NULL);

-- staff
CREATE TABLE public.staff (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  invited_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT staff_pkey PRIMARY KEY (id),
  CONSTRAINT staff_account_user_unique UNIQUE (account_id, user_id),
  CONSTRAINT staff_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'administrator'::text, 'operator'::text, 'viewer'::text]))),
  CONSTRAINT staff_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text])))
);
CREATE INDEX idx_staff_user ON public.staff USING btree (user_id);
CREATE INDEX idx_staff_user_active_account ON public.staff USING btree (user_id, account_id, created_at) WHERE (status = 'active'::text);

-- staff_invitations
CREATE TABLE public.staff_invitations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  code_hash text NOT NULL,
  code_prefix text NOT NULL,
  invited_email text,
  role text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  max_uses integer DEFAULT 1 NOT NULL,
  used_count integer DEFAULT 0 NOT NULL,
  revoked_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT staff_invitations_pkey PRIMARY KEY (id),
  CONSTRAINT staff_invitations_code_hash_key UNIQUE (code_hash),
  CONSTRAINT staff_invitations_max_uses_check CHECK ((max_uses >= 1)),
  CONSTRAINT staff_invitations_role_check CHECK ((role = ANY (ARRAY['administrator'::text, 'operator'::text, 'viewer'::text])))
);
CREATE INDEX idx_staff_invitations_account ON public.staff_invitations USING btree (account_id);

-- switches
CREATE TABLE public.switches (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  home_id uuid NOT NULL,
  room_id uuid,
  board_instance_id uuid NOT NULL,
  name text NOT NULL,
  gpio_pin integer NOT NULL,
  is_on boolean DEFAULT false NOT NULL,
  inverted boolean DEFAULT false NOT NULL,
  is_online boolean DEFAULT false NOT NULL,
  last_changed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone,
  deleted_reason text,
  permanently_deleted_at timestamp with time zone,
  CONSTRAINT switches_pkey PRIMARY KEY (id),
  CONSTRAINT switches_gpio_pin_check CHECK (((gpio_pin >= 0) AND (gpio_pin <= 54)))
);
CREATE INDEX idx_switches_account_created ON public.switches USING btree (account_id, created_at DESC) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX idx_switches_unique_pin ON public.switches USING btree (board_instance_id, gpio_pin) WHERE (deleted_at IS NULL);

-- users
CREATE TABLE public.users (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  email text NOT NULL,
  user_kind text NOT NULL,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  appearance_preference text DEFAULT 'system'::text NOT NULL,
  last_login_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone,
  timezone text,
  avatar_seed text,
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_email_kind_unique UNIQUE (email, user_kind),
  CONSTRAINT users_appearance_preference_check CHECK ((appearance_preference = ANY (ARRAY['light'::text, 'dark'::text, 'system'::text]))),
  CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text]))),
  CONSTRAINT users_user_kind_check CHECK ((user_kind = ANY (ARRAY['customer'::text, 'platform_admin'::text])))
);
CREATE INDEX idx_users_email_kind ON public.users USING btree (lower(email), user_kind) WHERE (deleted_at IS NULL);

-- ============================================================================
-- 2. Functions
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bootstrap_platform_admin(p_email text, p_password_hash text, p_full_name text)
 RETURNS TABLE(user_id uuid, email text, full_name text, role text)
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.claim_pairing_code(p_code_hash text)
 RETURNS TABLE(pairing_code_id uuid, account_id uuid, board_instance_id uuid, account_status text, purpose text, requires_physical_confirmation boolean)
 LANGUAGE plpgsql
AS $function$
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
    v_row.board_instance_id,
    v_account_status,
    v_row.purpose,
    v_row.requires_physical_confirmation;
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_admin_session_context(p_token_hash text)
 RETURNS TABLE(session_id uuid, user_id uuid, email text, full_name text, appearance_preference text, timezone text, platform_staff_id uuid, platform_role text)
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.resolve_user_session_context(p_token_hash text)
 RETURNS TABLE(session_id uuid, user_id uuid, email text, full_name text, appearance_preference text, timezone text, account_id uuid, account_name text, account_slug text, account_status text, staff_id uuid, staff_role text)
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- 3. Triggers
-- ============================================================================

CREATE TRIGGER trg_accounts_updated_at BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_automation_rules_updated_at BEFORE UPDATE ON public.automation_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_board_profiles_updated_at BEFORE UPDATE ON public.board_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_board_instances_updated_at BEFORE UPDATE ON public.board_instances FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_custom_board_profiles_updated_at BEFORE UPDATE ON public.custom_board_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_devices_updated_at BEFORE UPDATE ON public.devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_firmware_releases_updated_at BEFORE UPDATE ON public.firmware_releases FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_homes_updated_at BEFORE UPDATE ON public.homes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_mqtt_creds_updated_at BEFORE UPDATE ON public.mqtt_credentials_metadata FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_planner_plans_updated_at BEFORE UPDATE ON public.planner_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_platform_settings_updated_at BEFORE UPDATE ON public.platform_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_platform_staff_updated_at BEFORE UPDATE ON public.platform_staff FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_rooms_updated_at BEFORE UPDATE ON public.rooms FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sensors_updated_at BEFORE UPDATE ON public.sensors FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_staff_updated_at BEFORE UPDATE ON public.staff FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_switches_updated_at BEFORE UPDATE ON public.switches FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 4. Foreign keys (declared after every table exists)
-- ============================================================================

ALTER TABLE public.account_saved_boards ADD CONSTRAINT account_saved_boards_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.account_saved_boards ADD CONSTRAINT account_saved_boards_board_profile_id_fkey FOREIGN KEY (board_profile_id) REFERENCES board_profiles(id) ON DELETE CASCADE;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.action_button_configs ADD CONSTRAINT action_button_configs_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.action_button_configs ADD CONSTRAINT action_button_configs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_board_instance_id_fkey FOREIGN KEY (board_instance_id) REFERENCES board_instances(id) ON DELETE SET NULL;
ALTER TABLE public.automation_rules ADD CONSTRAINT automation_rules_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.automation_rules ADD CONSTRAINT automation_rules_home_id_fkey FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE;
ALTER TABLE public.board_profile_sync_runs ADD CONSTRAINT board_profile_sync_runs_triggered_by_admin_id_fkey FOREIGN KEY (triggered_by_admin_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE public.board_gpio_definitions ADD CONSTRAINT board_gpio_definitions_board_profile_id_fkey FOREIGN KEY (board_profile_id) REFERENCES board_profiles(id) ON DELETE CASCADE;
ALTER TABLE public.board_gpio_definitions ADD CONSTRAINT board_gpio_definitions_custom_board_profile_id_fkey FOREIGN KEY (custom_board_profile_id) REFERENCES custom_board_profiles(id) ON DELETE CASCADE;
ALTER TABLE public.board_instances ADD CONSTRAINT board_instances_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.board_instances ADD CONSTRAINT board_instances_board_profile_id_fkey FOREIGN KEY (board_profile_id) REFERENCES board_profiles(id) ON DELETE RESTRICT;
ALTER TABLE public.board_instances ADD CONSTRAINT board_instances_custom_board_profile_id_fkey FOREIGN KEY (custom_board_profile_id) REFERENCES custom_board_profiles(id) ON DELETE RESTRICT;
ALTER TABLE public.board_instances ADD CONSTRAINT board_instances_home_id_fkey FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE;
ALTER TABLE public.board_instances ADD CONSTRAINT board_instances_installed_firmware_release_id_fkey FOREIGN KEY (installed_firmware_release_id) REFERENCES firmware_releases(id) ON DELETE SET NULL;
ALTER TABLE public.board_instances ADD CONSTRAINT board_instances_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL;
ALTER TABLE public.custom_board_profiles ADD CONSTRAINT custom_board_profiles_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.custom_board_profiles ADD CONSTRAINT custom_board_profiles_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE public.devices ADD CONSTRAINT devices_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.devices ADD CONSTRAINT devices_board_instance_id_fkey FOREIGN KEY (board_instance_id) REFERENCES board_instances(id) ON DELETE CASCADE;
ALTER TABLE public.devices ADD CONSTRAINT devices_home_id_fkey FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE;
ALTER TABLE public.devices ADD CONSTRAINT devices_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL;
ALTER TABLE public.firmware_files ADD CONSTRAINT firmware_files_release_id_fkey FOREIGN KEY (release_id) REFERENCES firmware_releases(id) ON DELETE CASCADE;
ALTER TABLE public.firmware_releases ADD CONSTRAINT firmware_releases_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE public.firmware_releases ADD CONSTRAINT firmware_releases_rollback_from_release_id_fkey FOREIGN KEY (rollback_from_release_id) REFERENCES firmware_releases(id) ON DELETE SET NULL;
ALTER TABLE public.firmware_releases ADD CONSTRAINT firmware_releases_superseded_by_release_id_fkey FOREIGN KEY (superseded_by_release_id) REFERENCES firmware_releases(id) ON DELETE SET NULL;
ALTER TABLE public.firmware_update_history ADD CONSTRAINT firmware_update_history_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.firmware_update_history ADD CONSTRAINT firmware_update_history_board_instance_id_fkey FOREIGN KEY (board_instance_id) REFERENCES board_instances(id) ON DELETE CASCADE;
ALTER TABLE public.firmware_update_history ADD CONSTRAINT firmware_update_history_release_id_fkey FOREIGN KEY (release_id) REFERENCES firmware_releases(id) ON DELETE RESTRICT;
ALTER TABLE public.homes ADD CONSTRAINT homes_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.mqtt_credentials_metadata ADD CONSTRAINT mqtt_credentials_metadata_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.mqtt_credentials_metadata ADD CONSTRAINT mqtt_credentials_metadata_board_instance_id_fkey FOREIGN KEY (board_instance_id) REFERENCES board_instances(id) ON DELETE CASCADE;
ALTER TABLE public.notification_preferences ADD CONSTRAINT notification_preferences_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.notification_preferences ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE public.notification_user_states ADD CONSTRAINT notification_user_states_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE;
ALTER TABLE public.notification_user_states ADD CONSTRAINT notification_user_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE public.pairing_codes ADD CONSTRAINT pairing_codes_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.pairing_codes ADD CONSTRAINT pairing_codes_board_instance_id_fkey FOREIGN KEY (board_instance_id) REFERENCES board_instances(id) ON DELETE CASCADE;
ALTER TABLE public.pairing_codes ADD CONSTRAINT pairing_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE public.planner_plans ADD CONSTRAINT planner_plans_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.planner_plans ADD CONSTRAINT planner_plans_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE public.platform_settings ADD CONSTRAINT platform_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE public.platform_staff ADD CONSTRAINT platform_staff_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE public.platform_staff ADD CONSTRAINT platform_staff_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_home_id_fkey FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE;
ALTER TABLE public.sensor_readings ADD CONSTRAINT sensor_readings_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.sensor_readings ADD CONSTRAINT sensor_readings_sensor_id_fkey FOREIGN KEY (sensor_id) REFERENCES sensors(id) ON DELETE CASCADE;
ALTER TABLE public.sensors ADD CONSTRAINT sensors_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.sensors ADD CONSTRAINT sensors_board_instance_id_fkey FOREIGN KEY (board_instance_id) REFERENCES board_instances(id) ON DELETE CASCADE;
ALTER TABLE public.sensors ADD CONSTRAINT sensors_home_id_fkey FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE;
ALTER TABLE public.sensors ADD CONSTRAINT sensors_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_active_account_id_fkey FOREIGN KEY (active_account_id) REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE public.staff ADD CONSTRAINT staff_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.staff ADD CONSTRAINT staff_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE public.staff ADD CONSTRAINT staff_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE public.staff_invitations ADD CONSTRAINT staff_invitations_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.staff_invitations ADD CONSTRAINT staff_invitations_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE public.switches ADD CONSTRAINT switches_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.switches ADD CONSTRAINT switches_board_instance_id_fkey FOREIGN KEY (board_instance_id) REFERENCES board_instances(id) ON DELETE CASCADE;
ALTER TABLE public.switches ADD CONSTRAINT switches_home_id_fkey FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE;
ALTER TABLE public.switches ADD CONSTRAINT switches_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL;

-- ============================================================================
-- 5. Privileges — lock out PostgREST client roles, keep service_role full access
-- ============================================================================

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

-- ============================================================================
-- 6. Seed data
-- ============================================================================

-- seed: board_profiles (13 rows)
INSERT INTO public.board_profiles (id, slug, manufacturer, model, revision, chip_family, chip_variant, flash_size_mb, psram_size_mb, usb_vid, usb_pid, is_available, description, deleted_at, catalog_category, series, image_url, pinout_image_url, docs_url, datasheet_url, source_url, source_provider, verification_status, firmware_status, board_layout, revision_notes, last_synced_at, partition_scheme, psram_mode, flash_mode, flash_freq, bootloader_offset, ota_app_offset, boot_button_gpio, usb_interface, supports_wifi, supports_ota_rollback, firmware_compat_key, connectivity_note, supports_ble, supports_ble_wifi_provisioning, build_platform) VALUES
  ('559d161b-291d-47e3-8c74-c7544b7e3e4f', 'esp32-devkitc-v4', 'Espressif', 'ESP32-DevKitC V4', 'v4.0', 'esp32', 'ESP32-WROOM-32E', 4, 0, '0x10C4', '0xEA60', TRUE, 'Classic dual-core Xtensa ESP32 DevKit. GPIO34-39 are input-only; GPIO6-11 connect internal SPI Flash.', NULL, 'official_espressif', 'ESP32', NULL, NULL, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html', 'https://www.espressif.com/sites/default/files/documentation/esp32_datasheet_en.pdf', 'https://www.espressif.com/products/devkits', 'espressif_devkits', 'verified', 'catalog_only', '{"usbEdge":"bottom","usbLabel":"Micro-USB UART","formFactor":"devkit","imageFrame":{"pinTopPct":15.5,"pinBottomPct":94},"leftHeader":{"name":"J2","pins":[{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":1,"headerName":"J2"},{"kind":"reset","note":"CHIP_PU reset","gpioPin":null,"pinName":"EN","position":2,"headerName":"J2"},{"kind":"gpio","note":"Input-only","aliases":["SENSOR_VP","ADC1_CH0"],"gpioPin":36,"pinName":"VP / 36","position":3,"headerName":"J2"},{"kind":"gpio","note":"Input-only","aliases":["SENSOR_VN","ADC1_CH3"],"gpioPin":39,"pinName":"VN / 39","position":4,"headerName":"J2"},{"kind":"gpio","note":"Input-only","aliases":["ADC1_CH6"],"gpioPin":34,"pinName":"34","position":5,"headerName":"J2"},{"kind":"gpio","note":"Input-only","aliases":["ADC1_CH7"],"gpioPin":35,"pinName":"35","position":6,"headerName":"J2"},{"kind":"gpio","aliases":["ADC1_CH4","TOUCH9"],"gpioPin":32,"pinName":"32","position":7,"headerName":"J2"},{"kind":"gpio","aliases":["ADC1_CH5","TOUCH8"],"gpioPin":33,"pinName":"33","position":8,"headerName":"J2"},{"kind":"gpio","aliases":["DAC_1"],"gpioPin":25,"pinName":"25","position":9,"headerName":"J2"},{"kind":"gpio","aliases":["DAC_2"],"gpioPin":26,"pinName":"26","position":10,"headerName":"J2"},{"kind":"gpio","aliases":["TOUCH7"],"gpioPin":27,"pinName":"27","position":11,"headerName":"J2"},{"kind":"gpio","aliases":["TOUCH6","HSPI_CLK"],"gpioPin":14,"pinName":"14","position":12,"headerName":"J2"},{"kind":"gpio","note":"Strapping (keep LOW at boot)","aliases":["TOUCH5","MTDI"],"gpioPin":12,"pinName":"12","position":13,"headerName":"J2"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":14,"headerName":"J2"},{"kind":"gpio","aliases":["TOUCH4","HSPI_MOSI"],"gpioPin":13,"pinName":"13","position":15,"headerName":"J2"},{"kind":"gpio","note":"SPI Flash D2 (reserved)","gpioPin":9,"pinName":"D2 / 9","position":16,"headerName":"J2"},{"kind":"gpio","note":"SPI Flash D3 (reserved)","gpioPin":10,"pinName":"D3 / 10","position":17,"headerName":"J2"},{"kind":"gpio","note":"SPI Flash CMD (reserved)","gpioPin":11,"pinName":"CMD / 11","position":18,"headerName":"J2"},{"kind":"power","gpioPin":null,"pinName":"5V","voltage":"5V","position":19,"headerName":"J2"}]},"antennaEdge":"top","aspectRatio":0.5319148936170213,"orientation":"vertical","rightHeader":{"name":"J3","pins":[{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":1,"headerName":"J3"},{"kind":"gpio","aliases":["VSPI_MOSI"],"gpioPin":23,"pinName":"23","position":2,"headerName":"J3"},{"kind":"gpio","aliases":["I2C_SCL"],"gpioPin":22,"pinName":"22","position":3,"headerName":"J3"},{"kind":"gpio","note":"UART0 TX","gpioPin":1,"pinName":"TXD0 / 1","position":4,"headerName":"J3"},{"kind":"gpio","note":"UART0 RX","gpioPin":3,"pinName":"RXD0 / 3","position":5,"headerName":"J3"},{"kind":"gpio","aliases":["I2C_SDA"],"gpioPin":21,"pinName":"21","position":6,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":7,"headerName":"J3"},{"kind":"gpio","aliases":["VSPI_MISO"],"gpioPin":19,"pinName":"19","position":8,"headerName":"J3"},{"kind":"gpio","aliases":["VSPI_CLK"],"gpioPin":18,"pinName":"18","position":9,"headerName":"J3"},{"kind":"gpio","note":"Strapping","aliases":["VSPI_CS0"],"gpioPin":5,"pinName":"5","position":10,"headerName":"J3"},{"kind":"gpio","aliases":["U2TXD"],"gpioPin":17,"pinName":"17","position":11,"headerName":"J3"},{"kind":"gpio","aliases":["U2RXD"],"gpioPin":16,"pinName":"16","position":12,"headerName":"J3"},{"kind":"gpio","aliases":["TOUCH0"],"gpioPin":4,"pinName":"4","position":13,"headerName":"J3"},{"kind":"gpio","note":"BOOT button & strapping","gpioPin":0,"pinName":"0","position":14,"headerName":"J3"},{"kind":"gpio","note":"Strapping / Onboard LED","gpioPin":2,"pinName":"2","position":15,"headerName":"J3"},{"kind":"gpio","note":"Strapping","aliases":["MTDO"],"gpioPin":15,"pinName":"15","position":16,"headerName":"J3"},{"kind":"gpio","note":"SPI Flash D1 (reserved)","gpioPin":8,"pinName":"D1 / 8","position":17,"headerName":"J3"},{"kind":"gpio","note":"SPI Flash D0 (reserved)","gpioPin":7,"pinName":"D0 / 7","position":18,"headerName":"J3"},{"kind":"gpio","note":"SPI Flash CLK (reserved)","gpioPin":6,"pinName":"CLK / 6","position":19,"headerName":"J3"}]},"antennaLabel":"PCB Antenna","hardwareSpecs":{"usb":"1x Micro-USB","buttons":"EN + BOOT","wireless":"Wi-Fi 4, BLE 4.2","processor":"Dual-Core Xtensa LX6 (240 MHz)","resetLabel":"EN","usbConnector":"micro-usb","usbPortCount":1,"hasUartBridge":true,"modulePackage":"wroom"},"onboardFeatures":[{"kind":"button","note":"GPIO0 active-low boot mode","label":"BOOT Button","gpioPin":0},{"kind":"flash","note":"GPIO6-11 internal SPI Flash","label":"SPI Flash","gpioPin":6}]}'::jsonb, 'Classic dual-core Xtensa ESP32 DevKit. GPIO34-39 are input-only; GPIO6-11 connect internal SPI Flash.', '2026-11-18T12:34:41.555Z', 'dual_ota_4mb', 'none', 'dio', '40m', '0x1000', '0x20000', 0, 'USB-UART Bridge (CP2102N)', TRUE, TRUE, 'esp32-4m-dio-none-dual_ota_4mb-b0', NULL, TRUE, TRUE, 'esp_idf'),
  ('c70dc168-947b-415e-b86a-19298331b90e', 'esp32-s3-devkitc-1-n16r8', 'Espressif', 'ESP32-S3-DevKitC-1 N16R8', 'v1.1', 'esp32s3', 'ESP32-S3-WROOM-1-N16R8', 16, 8, '0x303A', '0x1001', TRUE, 'Dual-core Xtensa LX7 with 16 MB QIO Flash and 8 MB Octal (OPI) PSRAM. GPIO 26-37 are reserved for Flash/Octal PSRAM.', NULL, 'official_espressif', 'ESP32-S3', NULL, NULL, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html', 'https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf', 'https://www.espressif.com/products/devkits', 'espressif_devkits', 'verified', 'firmware_supported', '{"usbEdge":"bottom","usbLabel":"UART + Native USB-C","formFactor":"devkit","imageFrame":{"pinTopPct":14.5,"pinBottomPct":89.5},"leftHeader":{"name":"J1","pins":[{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":1,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":2,"headerName":"J1"},{"kind":"reset","note":"CHIP_PU / EN reset","gpioPin":null,"pinName":"RST","position":3,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH3","TOUCH4"],"gpioPin":4,"pinName":"4","position":4,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH4","TOUCH5"],"gpioPin":5,"pinName":"5","position":5,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH5","TOUCH6"],"gpioPin":6,"pinName":"6","position":6,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH6","TOUCH7"],"gpioPin":7,"pinName":"7","position":7,"headerName":"J1"},{"kind":"gpio","aliases":["XTAL_32K_P"],"gpioPin":15,"pinName":"15","position":8,"headerName":"J1"},{"kind":"gpio","aliases":["XTAL_32K_N"],"gpioPin":16,"pinName":"16","position":9,"headerName":"J1"},{"kind":"gpio","aliases":["UART1_TX"],"gpioPin":17,"pinName":"17","position":10,"headerName":"J1"},{"kind":"gpio","aliases":["UART1_RX"],"gpioPin":18,"pinName":"18","position":11,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH7","TOUCH8"],"gpioPin":8,"pinName":"8","position":12,"headerName":"J1"},{"kind":"gpio","note":"Strapping (JTAG)","aliases":["ADC1_CH2","TOUCH3"],"gpioPin":3,"pinName":"3","position":13,"headerName":"J1"},{"kind":"gpio","note":"Input-only strapping","gpioPin":46,"pinName":"46","position":14,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH8","TOUCH9"],"gpioPin":9,"pinName":"9","position":15,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH9","TOUCH10"],"gpioPin":10,"pinName":"10","position":16,"headerName":"J1"},{"kind":"gpio","aliases":["TOUCH11"],"gpioPin":11,"pinName":"11","position":17,"headerName":"J1"},{"kind":"gpio","aliases":["TOUCH12"],"gpioPin":12,"pinName":"12","position":18,"headerName":"J1"},{"kind":"gpio","aliases":["TOUCH13"],"gpioPin":13,"pinName":"13","position":19,"headerName":"J1"},{"kind":"gpio","aliases":["TOUCH14"],"gpioPin":14,"pinName":"14","position":20,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"5V","voltage":"5V","position":21,"headerName":"J1"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":22,"headerName":"J1"}]},"antennaEdge":"top","aspectRatio":0.4603174603174603,"orientation":"vertical","rightHeader":{"name":"J3","pins":[{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":1,"headerName":"J3"},{"kind":"gpio","note":"UART0 TX","aliases":["U0TXD"],"gpioPin":43,"pinName":"TX","position":2,"headerName":"J3"},{"kind":"gpio","note":"UART0 RX","aliases":["U0RXD"],"gpioPin":44,"pinName":"RX","position":3,"headerName":"J3"},{"kind":"gpio","aliases":["ADC1_CH0","TOUCH1"],"gpioPin":1,"pinName":"1","position":4,"headerName":"J3"},{"kind":"gpio","aliases":["ADC1_CH1","TOUCH2"],"gpioPin":2,"pinName":"2","position":5,"headerName":"J3"},{"kind":"gpio","aliases":["MTMS"],"gpioPin":42,"pinName":"42","position":6,"headerName":"J3"},{"kind":"gpio","aliases":["MTDI"],"gpioPin":41,"pinName":"41","position":7,"headerName":"J3"},{"kind":"gpio","aliases":["MTDO"],"gpioPin":40,"pinName":"40","position":8,"headerName":"J3"},{"kind":"gpio","aliases":["MTCK"],"gpioPin":39,"pinName":"39","position":9,"headerName":"J3"},{"kind":"gpio","note":"Onboard RGB LED (v1.1)","gpioPin":38,"pinName":"38","position":10,"headerName":"J3"},{"kind":"gpio","note":"Octal PSRAM (unavailable on R8)","gpioPin":37,"pinName":"37","position":11,"headerName":"J3"},{"kind":"gpio","note":"Octal PSRAM (unavailable on R8)","gpioPin":36,"pinName":"36","position":12,"headerName":"J3"},{"kind":"gpio","note":"Octal PSRAM (unavailable on R8)","gpioPin":35,"pinName":"35","position":13,"headerName":"J3"},{"kind":"gpio","note":"BOOT button & strapping","gpioPin":0,"pinName":"0","position":14,"headerName":"J3"},{"kind":"gpio","note":"Strapping (VDD_SPI)","gpioPin":45,"pinName":"45","position":15,"headerName":"J3"},{"kind":"gpio","note":"General GPIO","gpioPin":48,"pinName":"48","position":16,"headerName":"J3"},{"kind":"gpio","gpioPin":47,"pinName":"47","position":17,"headerName":"J3"},{"kind":"gpio","gpioPin":21,"pinName":"21","position":18,"headerName":"J3"},{"kind":"gpio","note":"USB D+","aliases":["USB_D+"],"gpioPin":20,"pinName":"20","position":19,"headerName":"J3"},{"kind":"gpio","note":"USB D-","aliases":["USB_D-"],"gpioPin":19,"pinName":"19","position":20,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":21,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":22,"headerName":"J3"}]},"antennaLabel":"PCB Antenna","hardwareSpecs":{"usb":"2x USB-C (UART + Native OTG)","buttons":"RST + BOOT","wireless":"Wi-Fi 4, BLE 5.0","processor":"Dual-Core Xtensa LX7 (240 MHz)","resetLabel":"RST","usbConnector":"usb-c","usbPortCount":2,"hasUartBridge":true,"modulePackage":"wroom"},"onboardFeatures":[{"kind":"rgb_led","note":"GPIO38 on v1.1 revision","label":"WS2812 RGB LED","gpioPin":38},{"kind":"button","note":"GPIO0 active-low boot mode","label":"BOOT Button","gpioPin":0},{"kind":"psram","note":"GPIO35-37 reserved (N16R8)","label":"Octal PSRAM","gpioPin":35}]}'::jsonb, 'v1.1 uses GPIO38 for onboard WS2812 RGB LED (v1.0 used GPIO48). GPIO35-37 reserved for 8 MB Octal PSRAM.', '2026-11-18T12:34:41.555Z', 'dual_ota_16mb', 'octal', 'qio', '80m', '0x0', '0x20000', 0, 'Dual USB-C (UART + Native OTG)', TRUE, TRUE, 'esp32s3-16m-qio-octal8m-dual_ota_16mb-b0', NULL, TRUE, TRUE, 'esp_idf'),
  ('ec0706d5-7f03-4586-9c73-dc499371bb5b', 'seeed-xiao-esp32s3', 'Seeed Studio', 'XIAO ESP32-S3', 'v1.0', 'esp32s3', 'ESP32-S3R8', 8, 8, '0x2886', '0x0056', TRUE, 'Ultra-compact 21x17.8mm thumb-sized board. Exposes 11 GPIO pins across 7+7 castellations; onboard orange USER_LED on GPIO21 (active-low). B2B GPIO41/42 are digital-only.', NULL, 'partner', 'ESP32-S3', NULL, NULL, 'https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/', 'https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32S3/res/esp32-s3_datasheet_en.pdf', 'https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/', 'seeed_partner', 'verified', 'catalog_only', '{"usbEdge":"top","usbLabel":"USB Type-C","formFactor":"xiao","imageFrame":{"pinTopPct":18.5,"pinBottomPct":87.5},"leftHeader":{"name":"Left (D0-D6)","pins":[{"kind":"gpio","aliases":["A0","D0","ADC1_CH0","TOUCH1"],"gpioPin":1,"pinName":"D0 / A0","position":1,"headerName":"Left"},{"kind":"gpio","aliases":["A1","D1","ADC1_CH1","TOUCH2"],"gpioPin":2,"pinName":"D1 / A1","position":2,"headerName":"Left"},{"kind":"gpio","aliases":["A2","D2","ADC1_CH2","TOUCH3"],"gpioPin":3,"pinName":"D2 / A2","position":3,"headerName":"Left"},{"kind":"gpio","aliases":["A3","D3","ADC1_CH3","TOUCH4"],"gpioPin":4,"pinName":"D3 / A3","position":4,"headerName":"Left"},{"kind":"gpio","note":"I2C SDA","aliases":["A4","D4","SDA","ADC1_CH4"],"gpioPin":5,"pinName":"D4 / SDA","position":5,"headerName":"Left"},{"kind":"gpio","note":"I2C SCL","aliases":["A5","D5","SCL","ADC1_CH5"],"gpioPin":6,"pinName":"D5 / SCL","position":6,"headerName":"Left"},{"kind":"gpio","note":"UART TX (free GPIO)","aliases":["D6","TX","U0TXD"],"gpioPin":43,"pinName":"D6 / TX","position":7,"headerName":"Left"}]},"antennaEdge":"bottom","aspectRatio":0.7911975435005117,"orientation":"vertical","rightHeader":{"name":"Right (Power / D7-D10)","pins":[{"kind":"power","note":"USB VBUS 5V","gpioPin":null,"pinName":"5V","voltage":"5V","position":1,"headerName":"Right"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":2,"headerName":"Right"},{"kind":"power","note":"Regulated 3.3V out","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":3,"headerName":"Right"},{"kind":"gpio","note":"SPI MOSI","aliases":["A10","D10","MOSI"],"gpioPin":9,"pinName":"D10 / MOSI","position":4,"headerName":"Right"},{"kind":"gpio","note":"SPI MISO","aliases":["A9","D9","MISO"],"gpioPin":8,"pinName":"D9 / MISO","position":5,"headerName":"Right"},{"kind":"gpio","note":"SPI SCK","aliases":["A8","D8","SCK"],"gpioPin":7,"pinName":"D8 / SCK","position":6,"headerName":"Right"},{"kind":"gpio","note":"UART RX (free GPIO)","aliases":["D7","RX","U0RXD"],"gpioPin":44,"pinName":"D7 / RX","position":7,"headerName":"Right"}]},"antennaLabel":"U.FL / B2B","hardwareSpecs":{"usb":"1x USB-C","buttons":"RESET + BOOT","wireless":"Wi-Fi 4, BLE 5.0","processor":"Dual-Core Xtensa LX7 (240 MHz)","resetLabel":"RESET","usbConnector":"usb-c","usbPortCount":1,"hasUartBridge":false,"modulePackage":"xiao"},"onboardFeatures":[{"kind":"led","note":"Orange LED active-low on GPIO21","label":"USER LED","gpioPin":21},{"kind":"button","note":"Top-right tactile BOOT button","label":"BOOT Button","gpioPin":0},{"kind":"usb","note":"GPIO19/20 USB Type-C","label":"USB Serial / JTAG","gpioPin":19}]}'::jsonb, 'Ultra-compact 21x17.8mm thumb-sized board. Exposes 11 GPIO pins across 7+7 castellations; onboard orange USER_LED on GPIO21 (active-low). B2B GPIO41/42 are digital-only.', '2026-11-18T12:34:41.555Z', 'dual_ota_8mb', 'octal', 'qio', '80m', '0x0', '0x20000', 0, 'Native USB-C (CDC/JTAG)', TRUE, TRUE, 'esp32s3-8m-qio-octal8m-dual_ota_8mb-b0', NULL, TRUE, TRUE, 'esp_idf'),
  ('51dd4142-a8ee-4b09-acd7-a487eba79aa7', 'esp32-s3-devkitc-1-v1-0', 'Espressif', 'ESP32-S3-DevKitC-1 v1.0', 'v1.0', 'esp32s3', 'ESP32-S3-WROOM-1-N8R8', 8, 8, '0x303A', '0x1001', TRUE, 'Earlier v1.0 hardware revision: onboard WS2812 RGB LED is wired to GPIO48 instead of GPIO38.', NULL, 'official_espressif', 'ESP32-S3', NULL, NULL, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.0.html', 'https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf', 'https://www.espressif.com/products/devkits', 'espressif_devkits', 'verified', 'catalog_only', '{"usbEdge":"bottom","usbLabel":"UART + Native USB-C","formFactor":"devkit","imageFrame":{"pinTopPct":14.5,"pinBottomPct":89.5},"leftHeader":{"name":"J1","pins":[{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":1,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":2,"headerName":"J1"},{"kind":"reset","note":"CHIP_PU / EN reset","gpioPin":null,"pinName":"RST","position":3,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH3","TOUCH4"],"gpioPin":4,"pinName":"4","position":4,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH4","TOUCH5"],"gpioPin":5,"pinName":"5","position":5,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH5","TOUCH6"],"gpioPin":6,"pinName":"6","position":6,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH6","TOUCH7"],"gpioPin":7,"pinName":"7","position":7,"headerName":"J1"},{"kind":"gpio","aliases":["XTAL_32K_P"],"gpioPin":15,"pinName":"15","position":8,"headerName":"J1"},{"kind":"gpio","aliases":["XTAL_32K_N"],"gpioPin":16,"pinName":"16","position":9,"headerName":"J1"},{"kind":"gpio","aliases":["UART1_TX"],"gpioPin":17,"pinName":"17","position":10,"headerName":"J1"},{"kind":"gpio","aliases":["UART1_RX"],"gpioPin":18,"pinName":"18","position":11,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH7","TOUCH8"],"gpioPin":8,"pinName":"8","position":12,"headerName":"J1"},{"kind":"gpio","note":"Strapping (JTAG)","aliases":["ADC1_CH2","TOUCH3"],"gpioPin":3,"pinName":"3","position":13,"headerName":"J1"},{"kind":"gpio","note":"Input-only strapping","gpioPin":46,"pinName":"46","position":14,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH8","TOUCH9"],"gpioPin":9,"pinName":"9","position":15,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH9","TOUCH10"],"gpioPin":10,"pinName":"10","position":16,"headerName":"J1"},{"kind":"gpio","aliases":["TOUCH11"],"gpioPin":11,"pinName":"11","position":17,"headerName":"J1"},{"kind":"gpio","aliases":["TOUCH12"],"gpioPin":12,"pinName":"12","position":18,"headerName":"J1"},{"kind":"gpio","aliases":["TOUCH13"],"gpioPin":13,"pinName":"13","position":19,"headerName":"J1"},{"kind":"gpio","aliases":["TOUCH14"],"gpioPin":14,"pinName":"14","position":20,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"5V","voltage":"5V","position":21,"headerName":"J1"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":22,"headerName":"J1"}]},"antennaEdge":"top","aspectRatio":0.4603174603174603,"orientation":"vertical","rightHeader":{"name":"J3","pins":[{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":1,"headerName":"J3"},{"kind":"gpio","note":"UART0 TX","aliases":["U0TXD"],"gpioPin":43,"pinName":"TX","position":2,"headerName":"J3"},{"kind":"gpio","note":"UART0 RX","aliases":["U0RXD"],"gpioPin":44,"pinName":"RX","position":3,"headerName":"J3"},{"kind":"gpio","aliases":["ADC1_CH0","TOUCH1"],"gpioPin":1,"pinName":"1","position":4,"headerName":"J3"},{"kind":"gpio","aliases":["ADC1_CH1","TOUCH2"],"gpioPin":2,"pinName":"2","position":5,"headerName":"J3"},{"kind":"gpio","aliases":["MTMS"],"gpioPin":42,"pinName":"42","position":6,"headerName":"J3"},{"kind":"gpio","aliases":["MTDI"],"gpioPin":41,"pinName":"41","position":7,"headerName":"J3"},{"kind":"gpio","aliases":["MTDO"],"gpioPin":40,"pinName":"40","position":8,"headerName":"J3"},{"kind":"gpio","aliases":["MTCK"],"gpioPin":39,"pinName":"39","position":9,"headerName":"J3"},{"kind":"gpio","note":"General GPIO (free on v1.0)","gpioPin":38,"pinName":"38","position":10,"headerName":"J3"},{"kind":"gpio","note":"Octal PSRAM (unavailable on R8)","gpioPin":37,"pinName":"37","position":11,"headerName":"J3"},{"kind":"gpio","note":"Octal PSRAM (unavailable on R8)","gpioPin":36,"pinName":"36","position":12,"headerName":"J3"},{"kind":"gpio","note":"Octal PSRAM (unavailable on R8)","gpioPin":35,"pinName":"35","position":13,"headerName":"J3"},{"kind":"gpio","note":"BOOT button & strapping","gpioPin":0,"pinName":"0","position":14,"headerName":"J3"},{"kind":"gpio","note":"Strapping (VDD_SPI)","gpioPin":45,"pinName":"45","position":15,"headerName":"J3"},{"kind":"gpio","note":"Onboard RGB LED (v1.0)","gpioPin":48,"pinName":"48","position":16,"headerName":"J3"},{"kind":"gpio","gpioPin":47,"pinName":"47","position":17,"headerName":"J3"},{"kind":"gpio","gpioPin":21,"pinName":"21","position":18,"headerName":"J3"},{"kind":"gpio","note":"USB D+","aliases":["USB_D+"],"gpioPin":20,"pinName":"20","position":19,"headerName":"J3"},{"kind":"gpio","note":"USB D-","aliases":["USB_D-"],"gpioPin":19,"pinName":"19","position":20,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":21,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":22,"headerName":"J3"}]},"antennaLabel":"PCB Antenna","hardwareSpecs":{"usb":"2x USB-C (UART + Native OTG)","buttons":"RST + BOOT","wireless":"Wi-Fi 4, BLE 5.0","processor":"Dual-Core Xtensa LX7 (240 MHz)","resetLabel":"RST","usbConnector":"usb-c","usbPortCount":2,"hasUartBridge":true,"modulePackage":"wroom"},"onboardFeatures":[{"kind":"rgb_led","note":"GPIO48 on v1.0 revision","label":"WS2812 RGB LED","gpioPin":48},{"kind":"button","note":"GPIO0 active-low boot mode","label":"BOOT Button","gpioPin":0}]}'::jsonb, 'Earlier v1.0 hardware revision: onboard WS2812 RGB LED is wired to GPIO48 instead of GPIO38.', '2026-11-18T12:34:41.555Z', 'dual_ota_8mb', 'octal', 'qio', '80m', '0x0', '0x20000', 0, 'Dual USB-C (UART + Native OTG)', TRUE, TRUE, 'esp32s3-8m-qio-octal8m-dual_ota_8mb-b0', NULL, TRUE, TRUE, 'esp_idf'),
  ('35e465f2-2f3e-4606-8e75-15c750bc6924', 'esp32-c6-devkitc-1', 'Espressif', 'ESP32-C6-DevKitC-1', 'v1.2', 'esp32c6', 'ESP32-C6-WROOM-1-N8', 8, 0, '0x303A', '0x1001', TRUE, 'RISC-V Wi-Fi 6 + BLE 5 + IEEE 802.15.4 (Thread/Zigbee). RGB LED on GPIO8; USB D-/D+ on GPIO12/13.', NULL, 'official_espressif', 'ESP32-C6', NULL, NULL, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c6/esp32-c6-devkitc-1/user_guide.html', 'https://www.espressif.com/sites/default/files/documentation/esp32-c6_datasheet_en.pdf', 'https://www.espressif.com/products/devkits', 'espressif_devkits', 'verified', 'catalog_only', '{"usbEdge":"bottom","usbLabel":"UART + Native USB-C","formFactor":"devkit","imageFrame":{"pinTopPct":15,"pinBottomPct":87},"leftHeader":{"name":"J1","pins":[{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":1,"headerName":"J1"},{"kind":"reset","note":"CHIP_EN reset","gpioPin":null,"pinName":"RST","position":2,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH0","XTAL_32K_P"],"gpioPin":0,"pinName":"0","position":3,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH1","XTAL_32K_N"],"gpioPin":1,"pinName":"1","position":4,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH2"],"gpioPin":2,"pinName":"2","position":5,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH3"],"gpioPin":3,"pinName":"3","position":6,"headerName":"J1"},{"kind":"gpio","note":"Strapping","aliases":["ADC1_CH4","MTMS"],"gpioPin":4,"pinName":"4","position":7,"headerName":"J1"},{"kind":"gpio","note":"Strapping","aliases":["ADC1_CH5","MTDI"],"gpioPin":5,"pinName":"5","position":8,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH6","MTCK"],"gpioPin":6,"pinName":"6","position":9,"headerName":"J1"},{"kind":"gpio","aliases":["MTDO"],"gpioPin":7,"pinName":"7","position":10,"headerName":"J1"},{"kind":"gpio","gpioPin":10,"pinName":"10","position":11,"headerName":"J1"},{"kind":"gpio","gpioPin":11,"pinName":"11","position":12,"headerName":"J1"},{"kind":"gpio","note":"Onboard RGB LED & strapping","gpioPin":8,"pinName":"8","position":13,"headerName":"J1"},{"kind":"gpio","note":"Strapping","gpioPin":15,"pinName":"15","position":14,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"5V","voltage":"5V","position":15,"headerName":"J1"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":16,"headerName":"J1"}]},"antennaEdge":"top","aspectRatio":0.4708994708994709,"orientation":"vertical","rightHeader":{"name":"J3","pins":[{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":1,"headerName":"J3"},{"kind":"gpio","note":"UART0 TX","gpioPin":16,"pinName":"TX / 16","position":2,"headerName":"J3"},{"kind":"gpio","note":"UART0 RX","gpioPin":17,"pinName":"RX / 17","position":3,"headerName":"J3"},{"kind":"gpio","gpioPin":23,"pinName":"23","position":4,"headerName":"J3"},{"kind":"gpio","gpioPin":22,"pinName":"22","position":5,"headerName":"J3"},{"kind":"gpio","gpioPin":21,"pinName":"21","position":6,"headerName":"J3"},{"kind":"gpio","gpioPin":20,"pinName":"20","position":7,"headerName":"J3"},{"kind":"gpio","gpioPin":19,"pinName":"19","position":8,"headerName":"J3"},{"kind":"gpio","gpioPin":18,"pinName":"18","position":9,"headerName":"J3"},{"kind":"gpio","gpioPin":14,"pinName":"14","position":10,"headerName":"J3"},{"kind":"gpio","note":"BOOT button & strapping","gpioPin":9,"pinName":"9","position":11,"headerName":"J3"},{"kind":"gpio","note":"USB D+","gpioPin":13,"pinName":"13","position":12,"headerName":"J3"},{"kind":"gpio","note":"USB D-","gpioPin":12,"pinName":"12","position":13,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":14,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":15,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":16,"headerName":"J3"}]},"antennaLabel":"PCB Antenna","hardwareSpecs":{"usb":"2x USB-C (UART + Native JTAG)","buttons":"RST + BOOT","wireless":"Wi-Fi 6, BLE 5.3, Zigbee / Thread","processor":"Single-Core RISC-V (160 MHz)","resetLabel":"RST","usbConnector":"usb-c","usbPortCount":2,"hasUartBridge":true,"modulePackage":"wroom"},"onboardFeatures":[{"kind":"rgb_led","note":"GPIO8 (also strapping pin)","label":"WS2812 RGB LED","gpioPin":8},{"kind":"button","note":"GPIO9 active-low boot mode","label":"BOOT Button","gpioPin":9}]}'::jsonb, 'RISC-V Wi-Fi 6 + BLE 5 + IEEE 802.15.4 (Thread/Zigbee). RGB LED on GPIO8; USB D-/D+ on GPIO12/13.', '2026-11-18T12:34:41.555Z', 'dual_ota_8mb', 'none', 'dio', '80m', '0x0', '0x20000', 9, 'Dual USB-C (UART + Native JTAG)', TRUE, TRUE, 'esp32c6-8m-dio-none-dual_ota_8mb-b9', NULL, TRUE, TRUE, 'esp_idf'),
  ('c655f6fd-8537-4ca4-a8fd-938d9251e27f', 'esp32-c3-devkitm-1', 'Espressif', 'ESP32-C3-DevKitM-1', 'v1.0', 'esp32c3', 'ESP32-C3-MINI-1-N4', 4, 0, '0x10C4', '0xEA60', TRUE, 'Single-core RISC-V Wi-Fi + BLE 5 entry DevKit. RGB LED on GPIO8; BOOT on GPIO9; USB D-/D+ on GPIO18/19.', NULL, 'official_espressif', 'ESP32-C3', NULL, NULL, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c3/esp32-c3-devkitm-1/user_guide.html', 'https://www.espressif.com/sites/default/files/documentation/esp32-c3_datasheet_en.pdf', 'https://www.espressif.com/products/devkits', 'espressif_devkits', 'verified', 'catalog_only', '{"usbEdge":"bottom","usbLabel":"Micro-USB UART","formFactor":"devkit","imageFrame":{"pinTopPct":16.5,"pinBottomPct":95},"leftHeader":{"name":"J1","pins":[{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":1,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":2,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":3,"headerName":"J1"},{"kind":"gpio","note":"Strapping","aliases":["ADC1_CH2"],"gpioPin":2,"pinName":"2","position":4,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH3"],"gpioPin":3,"pinName":"3","position":5,"headerName":"J1"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":6,"headerName":"J1"},{"kind":"reset","note":"CHIP_EN reset","gpioPin":null,"pinName":"RST","position":7,"headerName":"J1"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":8,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH0"],"gpioPin":0,"pinName":"0","position":9,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH1"],"gpioPin":1,"pinName":"1","position":10,"headerName":"J1"},{"kind":"gpio","gpioPin":10,"pinName":"10","position":11,"headerName":"J1"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":12,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"5V","voltage":"5V","position":13,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"5V","voltage":"5V","position":14,"headerName":"J1"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":15,"headerName":"J1"}]},"antennaEdge":"top","aspectRatio":0.5925925925925926,"orientation":"vertical","rightHeader":{"name":"J3","pins":[{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":1,"headerName":"J3"},{"kind":"gpio","note":"UART0 TX","gpioPin":21,"pinName":"TX / 21","position":2,"headerName":"J3"},{"kind":"gpio","note":"UART0 RX","gpioPin":20,"pinName":"RX / 20","position":3,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":4,"headerName":"J3"},{"kind":"gpio","note":"BOOT button & strapping","gpioPin":9,"pinName":"9","position":5,"headerName":"J3"},{"kind":"gpio","note":"Onboard RGB LED & strapping","gpioPin":8,"pinName":"8","position":6,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":7,"headerName":"J3"},{"kind":"gpio","gpioPin":7,"pinName":"7","position":8,"headerName":"J3"},{"kind":"gpio","gpioPin":6,"pinName":"6","position":9,"headerName":"J3"},{"kind":"gpio","gpioPin":5,"pinName":"5","position":10,"headerName":"J3"},{"kind":"gpio","aliases":["ADC1_CH4"],"gpioPin":4,"pinName":"4","position":11,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":12,"headerName":"J3"},{"kind":"gpio","note":"USB D-","gpioPin":18,"pinName":"18","position":13,"headerName":"J3"},{"kind":"gpio","note":"USB D+","gpioPin":19,"pinName":"19","position":14,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":15,"headerName":"J3"}]},"antennaLabel":"PCB Antenna","hardwareSpecs":{"usb":"1x Micro-USB","buttons":"RST + BOOT","wireless":"Wi-Fi 4, BLE 5.0","processor":"Single-Core RISC-V (160 MHz)","resetLabel":"RST","usbConnector":"micro-usb","usbPortCount":1,"hasUartBridge":true,"modulePackage":"mini"},"onboardFeatures":[{"kind":"rgb_led","note":"GPIO8","label":"WS2812 RGB LED","gpioPin":8},{"kind":"button","note":"GPIO9","label":"BOOT Button","gpioPin":9}]}'::jsonb, 'Single-core RISC-V Wi-Fi + BLE 5 entry DevKit. RGB LED on GPIO8; BOOT on GPIO9; USB D-/D+ on GPIO18/19.', '2026-11-18T12:34:41.555Z', 'dual_ota_4mb', 'none', 'dio', '80m', '0x0', '0x20000', 9, 'USB-UART Bridge (CP2102N)', TRUE, TRUE, 'esp32c3-4m-dio-none-dual_ota_4mb-b9', NULL, TRUE, TRUE, 'esp_idf'),
  ('04437f70-f575-4f46-894d-ef9447a42d27', 'esp32-s2-devkitc-1', 'Espressif', 'ESP32-S2-DevKitC-1', 'v1.0', 'esp32s2', 'ESP32-S2-SOLO-2-N4R2', 4, 2, '0x303A', '0x0002', TRUE, 'Single-core Xtensa ESP32-S2 Wi-Fi DevKit with USB OTG; RGB LED on GPIO18.', NULL, 'official_espressif', 'ESP32-S2', NULL, NULL, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s2/esp32-s2-devkitc-1/user_guide.html', 'https://www.espressif.com/sites/default/files/documentation/esp32-s2_datasheet_en.pdf', 'https://www.espressif.com/products/devkits', 'espressif_devkits', 'verified', 'catalog_only', '{"usbEdge":"bottom","usbLabel":"UART + USB OTG","formFactor":"devkit","imageFrame":{"pinTopPct":15.5,"pinBottomPct":93},"leftHeader":{"name":"J1","pins":[{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":1,"headerName":"J1"},{"kind":"gpio","note":"BOOT button & strapping","gpioPin":0,"pinName":"0","position":2,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH0","TOUCH1"],"gpioPin":1,"pinName":"1","position":3,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH1","TOUCH2"],"gpioPin":2,"pinName":"2","position":4,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH2","TOUCH3"],"gpioPin":3,"pinName":"3","position":5,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH3","TOUCH4"],"gpioPin":4,"pinName":"4","position":6,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH4","TOUCH5"],"gpioPin":5,"pinName":"5","position":7,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH5","TOUCH6"],"gpioPin":6,"pinName":"6","position":8,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH6","TOUCH7"],"gpioPin":7,"pinName":"7","position":9,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH7","TOUCH8"],"gpioPin":8,"pinName":"8","position":10,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH8","TOUCH9"],"gpioPin":9,"pinName":"9","position":11,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH9","TOUCH10"],"gpioPin":10,"pinName":"10","position":12,"headerName":"J1"},{"kind":"gpio","aliases":["TOUCH11"],"gpioPin":11,"pinName":"11","position":13,"headerName":"J1"},{"kind":"gpio","aliases":["TOUCH12"],"gpioPin":12,"pinName":"12","position":14,"headerName":"J1"},{"kind":"gpio","aliases":["TOUCH13"],"gpioPin":13,"pinName":"13","position":15,"headerName":"J1"},{"kind":"gpio","aliases":["TOUCH14"],"gpioPin":14,"pinName":"14","position":16,"headerName":"J1"},{"kind":"gpio","gpioPin":15,"pinName":"15","position":17,"headerName":"J1"},{"kind":"gpio","gpioPin":16,"pinName":"16","position":18,"headerName":"J1"},{"kind":"gpio","aliases":["DAC_1"],"gpioPin":17,"pinName":"17","position":19,"headerName":"J1"},{"kind":"gpio","note":"Onboard RGB LED","aliases":["DAC_2"],"gpioPin":18,"pinName":"18","position":20,"headerName":"J1"},{"kind":"gpio","note":"USB D-","gpioPin":19,"pinName":"19","position":21,"headerName":"J1"},{"kind":"gpio","note":"USB D+","gpioPin":20,"pinName":"20","position":22,"headerName":"J1"}]},"antennaEdge":"top","aspectRatio":0.4117647058823529,"orientation":"vertical","rightHeader":{"name":"J3","pins":[{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":1,"headerName":"J3"},{"kind":"gpio","gpioPin":21,"pinName":"21","position":2,"headerName":"J3"},{"kind":"gpio","note":"SPI Flash/PSRAM CS1 (reserved)","gpioPin":26,"pinName":"26","position":3,"headerName":"J3"},{"kind":"gpio","gpioPin":33,"pinName":"33","position":4,"headerName":"J3"},{"kind":"gpio","gpioPin":34,"pinName":"34","position":5,"headerName":"J3"},{"kind":"gpio","gpioPin":35,"pinName":"35","position":6,"headerName":"J3"},{"kind":"gpio","gpioPin":36,"pinName":"36","position":7,"headerName":"J3"},{"kind":"gpio","gpioPin":37,"pinName":"37","position":8,"headerName":"J3"},{"kind":"gpio","gpioPin":38,"pinName":"38","position":9,"headerName":"J3"},{"kind":"gpio","aliases":["MTCK"],"gpioPin":39,"pinName":"39","position":10,"headerName":"J3"},{"kind":"gpio","aliases":["MTDO"],"gpioPin":40,"pinName":"40","position":11,"headerName":"J3"},{"kind":"gpio","aliases":["MTDI"],"gpioPin":41,"pinName":"41","position":12,"headerName":"J3"},{"kind":"gpio","aliases":["MTMS"],"gpioPin":42,"pinName":"42","position":13,"headerName":"J3"},{"kind":"gpio","note":"UART0 TX","gpioPin":43,"pinName":"TX / 43","position":14,"headerName":"J3"},{"kind":"gpio","note":"UART0 RX","gpioPin":44,"pinName":"RX / 44","position":15,"headerName":"J3"},{"kind":"gpio","note":"Strapping (VDD_SPI)","gpioPin":45,"pinName":"45","position":16,"headerName":"J3"},{"kind":"gpio","note":"Input-only strapping","gpioPin":46,"pinName":"46","position":17,"headerName":"J3"},{"kind":"reset","note":"CHIP_PU reset","gpioPin":null,"pinName":"RST","position":18,"headerName":"J3"},{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":19,"headerName":"J3"},{"kind":"power","gpioPin":null,"pinName":"5V","voltage":"5V","position":20,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":21,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":22,"headerName":"J3"}]},"antennaLabel":"PCB Antenna","hardwareSpecs":{"usb":"2x Micro-USB (UART + OTG)","buttons":"RST + BOOT","wireless":"Wi-Fi 4 (No BLE)","processor":"Single-Core Xtensa LX7 (240 MHz)","resetLabel":"RST","usbConnector":"micro-usb","usbPortCount":2,"hasUartBridge":true,"modulePackage":"solo"},"onboardFeatures":[{"kind":"rgb_led","note":"GPIO18","label":"WS2812 RGB LED","gpioPin":18},{"kind":"button","note":"GPIO0","label":"BOOT Button","gpioPin":0}]}'::jsonb, 'Single-core Xtensa ESP32-S2 Wi-Fi DevKit with USB OTG; RGB LED on GPIO18.', '2026-11-18T12:34:41.555Z', 'dual_ota_4mb', 'quad', 'dio', '80m', '0x1000', '0x20000', 0, 'Dual Micro-USB (UART + Native OTG)', TRUE, TRUE, 'esp32s2-4m-dio-quad2m-dual_ota_4mb-b0', NULL, FALSE, FALSE, 'esp_idf'),
  ('9cbe2200-a27b-4662-8b96-edeec2389374', 'esp32-c5-devkitc-1', 'Espressif', 'ESP32-C5-DevKitC-1', 'v1.2', 'esp32c5', 'ESP32-C5-WROOM-1-N8R8', 8, 8, '0x303A', '0x1001', TRUE, 'Dual-band (2.4 / 5 GHz) Wi-Fi 6 + BLE 5 + Thread/Zigbee RISC-V DevKit. RGB LED on GPIO27; BOOT on GPIO28.', NULL, 'official_espressif', 'ESP32-C5', NULL, NULL, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c5/esp32-c5-devkitc-1/user_guide.html', 'https://www.espressif.com/sites/default/files/documentation/esp32-c5_datasheet_en.pdf', 'https://www.espressif.com/products/devkits', 'espressif_devkits', 'verified', 'catalog_only', '{"usbEdge":"bottom","usbLabel":"UART + Native USB-C","formFactor":"devkit","imageFrame":{"pinTopPct":15.5,"pinBottomPct":86},"leftHeader":{"name":"J1","pins":[{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":1,"headerName":"J1"},{"kind":"reset","note":"CHIP_EN reset","gpioPin":null,"pinName":"RST","position":2,"headerName":"J1"},{"kind":"gpio","note":"Strapping","aliases":["ADC1_CH1","MTMS"],"gpioPin":2,"pinName":"2","position":3,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH2","MTDI"],"gpioPin":3,"pinName":"3","position":4,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH3","MTCK"],"gpioPin":4,"pinName":"4","position":5,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH4","MTDO"],"gpioPin":5,"pinName":"5","position":6,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH5"],"gpioPin":6,"pinName":"6","position":7,"headerName":"J1"},{"kind":"gpio","note":"Strapping","gpioPin":7,"pinName":"7","position":8,"headerName":"J1"},{"kind":"gpio","gpioPin":8,"pinName":"8","position":9,"headerName":"J1"},{"kind":"gpio","gpioPin":9,"pinName":"9","position":10,"headerName":"J1"},{"kind":"gpio","gpioPin":10,"pinName":"10","position":11,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH0"],"gpioPin":1,"pinName":"1","position":12,"headerName":"J1"},{"kind":"gpio","aliases":["XTAL_32K_P"],"gpioPin":0,"pinName":"0","position":13,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"5V","voltage":"5V","position":14,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"5V","voltage":"5V","position":15,"headerName":"J1"},{"kind":"nc","gpioPin":null,"pinName":"NC","position":16,"headerName":"J1"}]},"antennaEdge":"top","aspectRatio":0.4421052631578947,"orientation":"vertical","rightHeader":{"name":"J3","pins":[{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":1,"headerName":"J3"},{"kind":"gpio","note":"UART0 TX","gpioPin":11,"pinName":"TX / 11","position":2,"headerName":"J3"},{"kind":"gpio","note":"UART0 RX","gpioPin":12,"pinName":"RX / 12","position":3,"headerName":"J3"},{"kind":"gpio","note":"Onboard RGB LED & strapping","gpioPin":27,"pinName":"27","position":4,"headerName":"J3"},{"kind":"gpio","gpioPin":26,"pinName":"26","position":5,"headerName":"J3"},{"kind":"gpio","note":"Strapping","gpioPin":25,"pinName":"25","position":6,"headerName":"J3"},{"kind":"gpio","gpioPin":24,"pinName":"24","position":7,"headerName":"J3"},{"kind":"gpio","gpioPin":23,"pinName":"23","position":8,"headerName":"J3"},{"kind":"gpio","gpioPin":15,"pinName":"15","position":9,"headerName":"J3"},{"kind":"gpio","note":"BOOT button & strapping","gpioPin":28,"pinName":"28","position":10,"headerName":"J3"},{"kind":"gpio","note":"USB D+","gpioPin":14,"pinName":"14","position":11,"headerName":"J3"},{"kind":"gpio","note":"USB D-","gpioPin":13,"pinName":"13","position":12,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":13,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":14,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":15,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":16,"headerName":"J3"}]},"antennaLabel":"Dual-Band Antenna","hardwareSpecs":{"usb":"2x USB-C (UART + Native JTAG)","buttons":"RST + BOOT","wireless":"Wi-Fi 6 (2.4 / 5 GHz), BLE 5.0, Zigbee / Thread","processor":"Single-Core RISC-V (240 MHz)","resetLabel":"RST","usbConnector":"usb-c","usbPortCount":2,"hasUartBridge":true,"modulePackage":"wroom"},"onboardFeatures":[{"kind":"rgb_led","note":"GPIO27","label":"WS2812 RGB LED","gpioPin":27},{"kind":"button","note":"GPIO28","label":"BOOT Button","gpioPin":28}]}'::jsonb, 'Dual-band (2.4 / 5 GHz) Wi-Fi 6 + BLE 5 + Thread/Zigbee RISC-V DevKit. RGB LED on GPIO27; BOOT on GPIO28.', '2026-11-18T12:34:41.555Z', 'dual_ota_8mb', 'quad', 'dio', '80m', '0x2000', '0x20000', 28, 'Dual USB-C (UART + Native JTAG)', TRUE, TRUE, 'esp32c5-8m-dio-quad8m-dual_ota_8mb-b28', NULL, TRUE, TRUE, 'esp_idf'),
  ('e52f8c12-a762-4e87-93f4-8292c8e8ae88', 'esp32-c61-devkitc-1', 'Espressif', 'ESP32-C61-DevKitC-1', 'v2.0', 'esp32c61', 'ESP32-C61-WROOM-1-N8R2', 8, 2, '0x303A', '0x1001', TRUE, 'Cost-optimized Wi-Fi 6 + BLE 5 + PSRAM RISC-V DevKit. RGB LED on GPIO8.', NULL, 'official_espressif', 'ESP32-C61', NULL, NULL, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c61/esp32-c61-devkitc-1/user_guide.html', NULL, 'https://www.espressif.com/products/devkits', 'espressif_devkits', 'verified', 'catalog_only', '{"usbEdge":"bottom","usbLabel":"UART + Native USB-C","formFactor":"devkit","imageFrame":{"pinTopPct":15.5,"pinBottomPct":86.5},"leftHeader":{"name":"J1","pins":[{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":1,"headerName":"J1"},{"kind":"reset","note":"CHIP_EN reset","gpioPin":null,"pinName":"RST","position":2,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH0","XTAL_32K_P"],"gpioPin":0,"pinName":"0","position":3,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH1","XTAL_32K_N"],"gpioPin":1,"pinName":"1","position":4,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH2","MTMS"],"gpioPin":2,"pinName":"2","position":5,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH3","MTDI"],"gpioPin":3,"pinName":"3","position":6,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH4","MTCK"],"gpioPin":4,"pinName":"4","position":7,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH5","MTDO"],"gpioPin":5,"pinName":"5","position":8,"headerName":"J1"},{"kind":"gpio","gpioPin":6,"pinName":"6","position":9,"headerName":"J1"},{"kind":"gpio","note":"Strapping","gpioPin":7,"pinName":"7","position":10,"headerName":"J1"},{"kind":"gpio","note":"Onboard RGB LED & strapping","gpioPin":8,"pinName":"8","position":11,"headerName":"J1"},{"kind":"gpio","gpioPin":21,"pinName":"21","position":12,"headerName":"J1"},{"kind":"nc","gpioPin":null,"pinName":"NC","position":13,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"5V","voltage":"5V","position":14,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"5V","voltage":"5V","position":15,"headerName":"J1"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":16,"headerName":"J1"}]},"antennaEdge":"top","aspectRatio":0.45698924731182794,"orientation":"vertical","rightHeader":{"name":"J3","pins":[{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":1,"headerName":"J3"},{"kind":"gpio","note":"UART0 TX","gpioPin":11,"pinName":"TX / 11","position":2,"headerName":"J3"},{"kind":"gpio","note":"UART0 RX","gpioPin":10,"pinName":"RX / 10","position":3,"headerName":"J3"},{"kind":"gpio","gpioPin":28,"pinName":"28","position":4,"headerName":"J3"},{"kind":"gpio","gpioPin":27,"pinName":"27","position":5,"headerName":"J3"},{"kind":"gpio","gpioPin":26,"pinName":"26","position":6,"headerName":"J3"},{"kind":"gpio","gpioPin":25,"pinName":"25","position":7,"headerName":"J3"},{"kind":"gpio","gpioPin":24,"pinName":"24","position":8,"headerName":"J3"},{"kind":"gpio","gpioPin":23,"pinName":"23","position":9,"headerName":"J3"},{"kind":"gpio","gpioPin":22,"pinName":"22","position":10,"headerName":"J3"},{"kind":"gpio","note":"BOOT button & strapping","gpioPin":9,"pinName":"9","position":11,"headerName":"J3"},{"kind":"gpio","note":"USB D+","gpioPin":13,"pinName":"13","position":12,"headerName":"J3"},{"kind":"gpio","note":"USB D-","gpioPin":12,"pinName":"12","position":13,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":14,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":15,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":16,"headerName":"J3"}]},"antennaLabel":"PCB Antenna","hardwareSpecs":{"usb":"2x USB-C (UART + Native JTAG)","buttons":"RST + BOOT","wireless":"Wi-Fi 6, BLE 5.0","processor":"Single-Core RISC-V (160 MHz)","resetLabel":"RST","usbConnector":"usb-c","usbPortCount":2,"hasUartBridge":true,"modulePackage":"wroom"},"onboardFeatures":[{"kind":"rgb_led","note":"GPIO8","label":"WS2812 RGB LED","gpioPin":8},{"kind":"button","note":"GPIO9","label":"BOOT Button","gpioPin":9}]}'::jsonb, 'Cost-optimized Wi-Fi 6 + BLE 5 + PSRAM RISC-V DevKit. RGB LED on GPIO8.', '2026-11-18T12:34:41.555Z', 'dual_ota_8mb', 'quad', 'dio', '80m', '0x0', '0x20000', 9, 'Dual USB-C (UART + Native JTAG)', TRUE, TRUE, 'esp32c61-8m-dio-quad2m-dual_ota_8mb-b9', NULL, TRUE, TRUE, 'esp_idf'),
  ('cc8c0958-f96a-4d14-a8cc-915af7051b9a', 'esp8684-devkitm-1', 'Espressif', 'ESP8684-DevKitM-1', 'v1.1', 'esp32c2', 'ESP8684-MINI-1-N4', 4, 0, '0x10C4', '0xEA60', TRUE, 'Ultra-low-cost ESP32-C2 / ESP8684 Wi-Fi 4 + BLE 5 DevKit. RGB LED on GPIO0/1/8.', NULL, 'official_espressif', 'ESP32-C2', NULL, NULL, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c2/esp8684-devkitm-1/user_guide.html', 'https://www.espressif.com/sites/default/files/documentation/esp8684_datasheet_en.pdf', 'https://www.espressif.com/products/devkits', 'espressif_devkits', 'verified', 'catalog_only', '{"usbEdge":"bottom","usbLabel":"Micro-USB UART","formFactor":"devkit","imageFrame":{"pinTopPct":16.5,"pinBottomPct":94.5},"leftHeader":{"name":"J1","pins":[{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":1,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":2,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":3,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH2"],"gpioPin":2,"pinName":"2","position":4,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH3"],"gpioPin":3,"pinName":"3","position":5,"headerName":"J1"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":6,"headerName":"J1"},{"kind":"reset","note":"CHIP_EN reset","gpioPin":null,"pinName":"RST","position":7,"headerName":"J1"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":8,"headerName":"J1"},{"kind":"gpio","note":"Onboard RGB Red","aliases":["ADC1_CH0"],"gpioPin":0,"pinName":"0","position":9,"headerName":"J1"},{"kind":"gpio","note":"Onboard RGB Green","aliases":["ADC1_CH1"],"gpioPin":1,"pinName":"1","position":10,"headerName":"J1"},{"kind":"gpio","gpioPin":10,"pinName":"10","position":11,"headerName":"J1"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":12,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"5V","voltage":"5V","position":13,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"5V","voltage":"5V","position":14,"headerName":"J1"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":15,"headerName":"J1"}]},"antennaEdge":"top","aspectRatio":0.5869565217391305,"orientation":"vertical","rightHeader":{"name":"J3","pins":[{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":1,"headerName":"J3"},{"kind":"gpio","note":"UART0 TX","gpioPin":20,"pinName":"TX / 20","position":2,"headerName":"J3"},{"kind":"gpio","note":"UART0 RX","gpioPin":19,"pinName":"RX / 19","position":3,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":4,"headerName":"J3"},{"kind":"gpio","note":"BOOT button & strapping","gpioPin":9,"pinName":"9","position":5,"headerName":"J3"},{"kind":"gpio","note":"RGB Blue & strapping","gpioPin":8,"pinName":"8","position":6,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":7,"headerName":"J3"},{"kind":"gpio","gpioPin":7,"pinName":"7","position":8,"headerName":"J3"},{"kind":"gpio","gpioPin":6,"pinName":"6","position":9,"headerName":"J3"},{"kind":"gpio","gpioPin":5,"pinName":"5","position":10,"headerName":"J3"},{"kind":"gpio","aliases":["ADC1_CH4"],"gpioPin":4,"pinName":"4","position":11,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":12,"headerName":"J3"},{"kind":"gpio","gpioPin":18,"pinName":"18","position":13,"headerName":"J3"},{"kind":"nc","gpioPin":null,"pinName":"NC","position":14,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"GND","voltage":"GND","position":15,"headerName":"J3"}]},"antennaLabel":"PCB Antenna","hardwareSpecs":{"usb":"1x Micro-USB","buttons":"RST + BOOT","wireless":"Wi-Fi 4, BLE 5.0","processor":"Single-Core RISC-V (120 MHz)","resetLabel":"RST","usbConnector":"micro-usb","usbPortCount":1,"hasUartBridge":true,"modulePackage":"mini"},"onboardFeatures":[{"kind":"rgb_led","note":"GPIO0 (R), GPIO1 (G), GPIO8 (B)","label":"Discrete RGB LED","gpioPin":0},{"kind":"button","note":"GPIO9","label":"BOOT Button","gpioPin":9}]}'::jsonb, 'Ultra-low-cost ESP32-C2 / ESP8684 Wi-Fi 4 + BLE 5 DevKit. RGB LED on GPIO0/1/8.', '2026-11-18T12:34:41.555Z', 'dual_ota_4mb', 'none', 'dio', '60m', '0x0', '0x20000', 9, 'USB-UART Bridge (CP2102N)', TRUE, TRUE, 'esp32c2-4m-dio-none-dual_ota_4mb-b9', NULL, TRUE, TRUE, 'esp_idf'),
  ('f2bd2610-9102-4648-8e9c-29a26047e6a7', 'esp32-h2-devkitm-1', 'Espressif', 'ESP32-H2-DevKitM-1', 'v1.2', 'esp32h2', 'ESP32-H2-MINI-1-N4', 4, 0, '0x303A', '0x1001', TRUE, 'IEEE 802.15.4 (Thread / Zigbee / Matter) + BLE 5 DevKit (no Wi-Fi radio). RGB LED on GPIO8.', NULL, 'official_espressif', 'ESP32-H2', NULL, NULL, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32h2/esp32-h2-devkitm-1/user_guide.html', 'https://www.espressif.com/sites/default/files/documentation/esp32-h2_datasheet_en.pdf', 'https://www.espressif.com/products/devkits', 'espressif_devkits', 'verified', 'catalog_only', '{"usbEdge":"bottom","usbLabel":"UART + Native USB-C","formFactor":"devkit","imageFrame":{"pinTopPct":15,"pinBottomPct":86.5},"leftHeader":{"name":"J1","pins":[{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":1,"headerName":"J1"},{"kind":"reset","note":"CHIP_EN reset","gpioPin":null,"pinName":"RST","position":2,"headerName":"J1"},{"kind":"gpio","gpioPin":0,"pinName":"0","position":3,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH0"],"gpioPin":1,"pinName":"1","position":4,"headerName":"J1"},{"kind":"gpio","note":"Strapping","aliases":["ADC1_CH1","MTMS"],"gpioPin":2,"pinName":"2","position":5,"headerName":"J1"},{"kind":"gpio","note":"Strapping","aliases":["ADC1_CH2","MTDI"],"gpioPin":3,"pinName":"3","position":6,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH3","MTCK"],"gpioPin":4,"pinName":"4","position":7,"headerName":"J1"},{"kind":"gpio","aliases":["ADC1_CH4","MTDO"],"gpioPin":5,"pinName":"5","position":8,"headerName":"J1"},{"kind":"gpio","gpioPin":10,"pinName":"10","position":9,"headerName":"J1"},{"kind":"gpio","gpioPin":11,"pinName":"11","position":10,"headerName":"J1"},{"kind":"gpio","note":"Onboard RGB LED & strapping","gpioPin":8,"pinName":"8","position":11,"headerName":"J1"},{"kind":"gpio","gpioPin":12,"pinName":"12","position":12,"headerName":"J1"},{"kind":"gpio","gpioPin":13,"pinName":"13","position":13,"headerName":"J1"},{"kind":"gpio","gpioPin":14,"pinName":"14","position":14,"headerName":"J1"},{"kind":"power","gpioPin":null,"pinName":"5V","voltage":"5V","position":15,"headerName":"J1"}]},"antennaEdge":"top","aspectRatio":0.5108695652173914,"orientation":"vertical","rightHeader":{"name":"J3","pins":[{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":1,"headerName":"J3"},{"kind":"gpio","note":"UART0 TX","gpioPin":24,"pinName":"TX / 24","position":2,"headerName":"J3"},{"kind":"gpio","note":"UART0 RX","gpioPin":23,"pinName":"RX / 23","position":3,"headerName":"J3"},{"kind":"gpio","note":"Strapping","gpioPin":25,"pinName":"25","position":4,"headerName":"J3"},{"kind":"gpio","gpioPin":22,"pinName":"22","position":5,"headerName":"J3"},{"kind":"gpio","note":"BOOT button & strapping","gpioPin":9,"pinName":"9","position":6,"headerName":"J3"},{"kind":"gpio","note":"USB D+","gpioPin":27,"pinName":"27","position":7,"headerName":"J3"},{"kind":"gpio","note":"USB D-","gpioPin":26,"pinName":"26","position":8,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":9,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":10,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":11,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":12,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":13,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":14,"headerName":"J3"},{"kind":"ground","gpioPin":null,"pinName":"G","voltage":"GND","position":15,"headerName":"J3"}]},"antennaLabel":"PCB Antenna","hardwareSpecs":{"usb":"2x USB-C (UART + Native JTAG)","buttons":"RST + BOOT","wireless":"BLE 5.3, Zigbee / Thread (No Wi-Fi)","processor":"Single-Core RISC-V (96 MHz)","resetLabel":"RST","usbConnector":"usb-c","usbPortCount":2,"hasUartBridge":true,"modulePackage":"mini"},"onboardFeatures":[{"kind":"rgb_led","note":"GPIO8","label":"WS2812 RGB LED","gpioPin":8},{"kind":"button","note":"GPIO9","label":"BOOT Button","gpioPin":9}]}'::jsonb, 'IEEE 802.15.4 (Thread / Zigbee / Matter) + BLE 5 DevKit (no Wi-Fi radio). RGB LED on GPIO8.', '2026-11-18T12:34:41.555Z', 'dual_ota_4mb', 'none', 'dio', '64m', '0x0', '0x20000', 9, 'Dual USB-C (UART + Native JTAG)', FALSE, TRUE, 'esp32h2-4m-dio-none-dual_ota_4mb-b9', 'IEEE 802.15.4 + BLE 5.3 only (no integrated Wi-Fi radio). Requires ESP-Hosted Wi-Fi companion or Thread/Matter bridge.', TRUE, FALSE, 'esp_idf'),
  ('00a2679f-ba95-4d82-b591-f3013f457d4d', 'nodemcu-esp8266', 'NodeMCU', 'NodeMCU ESP8266 (ESP-12E)', 'v2', 'esp8266', 'ESP8266EX (ESP-12E)', 4, 0, '0x10C4', '0xEA60', TRUE, 'Classic NodeMCU v2 Amica ESP-12E (ESP8266EX) Wi-Fi 4 development board with 4MB Flash, CP2102 Micro-USB bridge, and D0–D8 headers. Safe relay/sensor GPIOs: D1 (GPIO5), D2 (GPIO4), D5 (GPIO14), D6 (GPIO12), D7 (GPIO13).', NULL, 'partner', 'ESP8266 NodeMCU', NULL, NULL, 'https://nodemcu.readthedocs.io/en/release/getting-started/', 'https://www.espressif.com/sites/default/files/documentation/0a-esp8266ex_datasheet_en.pdf', 'https://github.com/nodemcu/nodemcu-devkit-v1.0', 'nodemcu_community', 'verified', 'catalog_only', '{"usbEdge":"bottom","usbLabel":"Micro-USB (CP2102)","formFactor":"devkit","leftHeader":{"name":"Left","pins":[{"kind":"nc","note":"10-bit Analog Input (0-3.3V)","aliases":["ADC0","TOUT"],"gpioPin":null,"pinName":"A0","position":1,"headerName":"Left"},{"kind":"nc","gpioPin":null,"pinName":"RSV","position":2,"headerName":"Left"},{"kind":"nc","gpioPin":null,"pinName":"RSV","position":3,"headerName":"Left"},{"kind":"gpio","note":"Internal SPI Flash (avoid)","aliases":["GPIO10"],"gpioPin":10,"pinName":"SD3","position":4,"headerName":"Left"},{"kind":"gpio","note":"Internal SPI Flash (avoid)","aliases":["GPIO9"],"gpioPin":9,"pinName":"SD2","position":5,"headerName":"Left"},{"kind":"gpio","note":"Internal SPI Flash","aliases":["GPIO8"],"gpioPin":8,"pinName":"SD1","position":6,"headerName":"Left"},{"kind":"gpio","note":"Internal SPI Flash","aliases":["GPIO11"],"gpioPin":11,"pinName":"CMD","position":7,"headerName":"Left"},{"kind":"gpio","note":"Internal SPI Flash","aliases":["GPIO7"],"gpioPin":7,"pinName":"SD0","position":8,"headerName":"Left"},{"kind":"gpio","note":"Internal SPI Flash","aliases":["GPIO6"],"gpioPin":6,"pinName":"CLK","position":9,"headerName":"Left"},{"kind":"ground","gpioPin":null,"pinName":"GND","position":10,"headerName":"Left"},{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":11,"headerName":"Left"},{"kind":"reset","note":"Chip enable","aliases":["CH_PD"],"gpioPin":null,"pinName":"EN","position":12,"headerName":"Left"},{"kind":"reset","gpioPin":null,"pinName":"RST","position":13,"headerName":"Left"},{"kind":"ground","gpioPin":null,"pinName":"GND","position":14,"headerName":"Left"},{"kind":"power","gpioPin":null,"pinName":"VIN","voltage":"5V","position":15,"headerName":"Left"}]},"antennaEdge":"top","aspectRatio":0.5263157894736842,"orientation":"vertical","rightHeader":{"name":"Right","pins":[{"kind":"gpio","note":"Deep-sleep wake / onboard LED (no pull-up/I2C)","aliases":["GPIO16","WAKE"],"gpioPin":16,"pinName":"D0","position":1,"headerName":"Right"},{"kind":"gpio","note":"Default I2C SCL (safe GPIO)","aliases":["GPIO5","SCL"],"gpioPin":5,"pinName":"D1","position":2,"headerName":"Right"},{"kind":"gpio","note":"Default I2C SDA (safe GPIO)","aliases":["GPIO4","SDA"],"gpioPin":4,"pinName":"D2","position":3,"headerName":"Right"},{"kind":"gpio","note":"FLASH boot strapping pin","aliases":["GPIO0","FLASH"],"gpioPin":0,"pinName":"D3","position":4,"headerName":"Right"},{"kind":"gpio","note":"ESP-12E onboard LED / boot strapping","aliases":["GPIO2","TXD1"],"gpioPin":2,"pinName":"D4","position":5,"headerName":"Right"},{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":6,"headerName":"Right"},{"kind":"ground","gpioPin":null,"pinName":"GND","position":7,"headerName":"Right"},{"kind":"gpio","note":"Safe GPIO / SPI CLK","aliases":["GPIO14","HSCLK"],"gpioPin":14,"pinName":"D5","position":8,"headerName":"Right"},{"kind":"gpio","note":"Safe GPIO / SPI MISO","aliases":["GPIO12","HMISO"],"gpioPin":12,"pinName":"D6","position":9,"headerName":"Right"},{"kind":"gpio","note":"Safe GPIO / SPI MOSI","aliases":["GPIO13","HMOSI"],"gpioPin":13,"pinName":"D7","position":10,"headerName":"Right"},{"kind":"gpio","note":"Boot strapping (pulled LOW via 10k)","aliases":["GPIO15","HCS"],"gpioPin":15,"pinName":"D8","position":11,"headerName":"Right"},{"kind":"gpio","note":"UART0 RX console","aliases":["GPIO3","RXD0"],"gpioPin":3,"pinName":"RX","position":12,"headerName":"Right"},{"kind":"gpio","note":"UART0 TX console","aliases":["GPIO1","TXD0"],"gpioPin":1,"pinName":"TX","position":13,"headerName":"Right"},{"kind":"ground","gpioPin":null,"pinName":"GND","position":14,"headerName":"Right"},{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":15,"headerName":"Right"}]},"antennaLabel":"ESP-12E PCB Antenna","hardwareSpecs":{"usb":"1x Micro-USB (CP2102 UART)","buttons":"RST + FLASH","wireless":"Wi-Fi 4 (2.4 GHz, No BLE)","processor":"Single-Core Xtensa L106 (80 / 160 MHz)","resetLabel":"RST","usbConnector":"micro-usb","usbPortCount":1,"hasUartBridge":true,"modulePackage":"wroom"},"onboardFeatures":[{"kind":"led","note":"GPIO2 / D4 (active-low)","label":"Onboard Blue LED","gpioPin":2},{"kind":"led","note":"GPIO16 / D0 (active-low)","label":"NodeMCU LED / Wake","gpioPin":16},{"kind":"button","note":"GPIO0 / D3","label":"FLASH Button","gpioPin":0}]}'::jsonb, 'Classic NodeMCU v2 Amica ESP-12E (ESP8266EX) Wi-Fi 4 development board with 4MB Flash, CP2102 Micro-USB bridge, and D0–D8 headers. Safe relay/sensor GPIOs: D1 (GPIO5), D2 (GPIO4), D5 (GPIO14), D6 (GPIO12), D7 (GPIO13).', '2026-11-18T12:34:41.650Z', 'dual_ota_4mb', 'none', 'dio', '40m', '0x0', '0x20000', 0, '1x Micro-USB (CP2102 UART)', TRUE, FALSE, 'esp8266-4m-dio-none-dual_ota_4mb-b0', 'ESP8266EX (non-ESP-IDF silicon, no BLE). Requires the dedicated firmware/esp8266 build path rather than ESP-IDF.', FALSE, FALSE, 'esp8266_rtos_sdk'),
  ('7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', 'waveshare-esp32-s3-zero', 'Waveshare', 'ESP32-S3-Zero', 'unspecified', 'esp32s3', 'ESP32-S3FH4R2', 4, 2, '0x303A', '0x1001', TRUE, 'Ultra-compact castellated ESP32-S3FH4R2 board with 4MB Flash, 2MB Quad PSRAM, ceramic antenna, USB-C, and onboard WS2812 RGB LED on GPIO21.', NULL, 'partner', 'Waveshare ESP32-Zero', NULL, NULL, 'https://www.waveshare.com/wiki/ESP32-S3-Zero', 'https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf', 'https://www.waveshare.com/wiki/ESP32-S3-Zero', 'waveshare_partner', 'verified', 'catalog_only', '{"usbEdge":"top","usbLabel":"Native USB-C","extraPads":{"name":"Bottom Pads","pins":[{"kind":"gpio","note":"Castellated bottom pad","gpioPin":14,"pinName":"GP14","position":1,"headerName":"Bottom"},{"kind":"gpio","note":"Castellated bottom pad","gpioPin":15,"pinName":"GP15","position":2,"headerName":"Bottom"},{"kind":"gpio","note":"Castellated bottom pad","gpioPin":16,"pinName":"GP16","position":3,"headerName":"Bottom"},{"kind":"gpio","note":"Castellated bottom pad","gpioPin":17,"pinName":"GP17","position":4,"headerName":"Bottom"},{"kind":"gpio","note":"Castellated bottom pad","gpioPin":18,"pinName":"GP18","position":5,"headerName":"Bottom"},{"kind":"gpio","note":"Onboard WS2812 RGB LED","gpioPin":21,"pinName":"GP21","position":6,"headerName":"Bottom"},{"kind":"gpio","note":"Castellated bottom pad (Quad PSRAM free)","gpioPin":33,"pinName":"GP33","position":7,"headerName":"Bottom"},{"kind":"gpio","note":"Castellated bottom pad (Quad PSRAM free)","gpioPin":34,"pinName":"GP34","position":8,"headerName":"Bottom"},{"kind":"gpio","note":"Castellated bottom pad (Quad PSRAM free)","gpioPin":35,"pinName":"GP35","position":9,"headerName":"Bottom"},{"kind":"gpio","note":"Castellated bottom pad (Quad PSRAM free)","gpioPin":36,"pinName":"GP36","position":10,"headerName":"Bottom"}]},"formFactor":"devkit","leftHeader":{"name":"Left","pins":[{"kind":"power","gpioPin":null,"pinName":"5V","voltage":"5V","position":1,"headerName":"Left"},{"kind":"ground","gpioPin":null,"pinName":"GND","position":2,"headerName":"Left"},{"kind":"power","gpioPin":null,"pinName":"3V3","voltage":"3.3V","position":3,"headerName":"Left"},{"kind":"gpio","aliases":["ADC1_CH0","TOUCH1"],"gpioPin":1,"pinName":"GP1","position":4,"headerName":"Left"},{"kind":"gpio","aliases":["ADC1_CH1","TOUCH2"],"gpioPin":2,"pinName":"GP2","position":5,"headerName":"Left"},{"kind":"gpio","aliases":["ADC1_CH2","STRAPPING"],"gpioPin":3,"pinName":"GP3","position":6,"headerName":"Left"},{"kind":"gpio","aliases":["ADC1_CH3","TOUCH4"],"gpioPin":4,"pinName":"GP4","position":7,"headerName":"Left"},{"kind":"gpio","aliases":["ADC1_CH4","TOUCH5"],"gpioPin":5,"pinName":"GP5","position":8,"headerName":"Left"},{"kind":"gpio","aliases":["ADC1_CH5","TOUCH6"],"gpioPin":6,"pinName":"GP6","position":9,"headerName":"Left"}]},"antennaEdge":"bottom","aspectRatio":0.7659574468085106,"orientation":"vertical","rightHeader":{"name":"Right","pins":[{"kind":"gpio","aliases":["U0TXD","GPIO43"],"gpioPin":43,"pinName":"TX","position":1,"headerName":"Right"},{"kind":"gpio","aliases":["U0RXD","GPIO44"],"gpioPin":44,"pinName":"RX","position":2,"headerName":"Right"},{"kind":"gpio","aliases":["SPI_MOSI","TOUCH13"],"gpioPin":13,"pinName":"GP13","position":3,"headerName":"Right"},{"kind":"gpio","aliases":["SPI_CLK","TOUCH12"],"gpioPin":12,"pinName":"GP12","position":4,"headerName":"Right"},{"kind":"gpio","aliases":["SPI_MOSI","TOUCH11"],"gpioPin":11,"pinName":"GP11","position":5,"headerName":"Right"},{"kind":"gpio","aliases":["SPI_CS","ADC1_CH9"],"gpioPin":10,"pinName":"GP10","position":6,"headerName":"Right"},{"kind":"gpio","aliases":["ADC1_CH8","TOUCH9"],"gpioPin":9,"pinName":"GP9","position":7,"headerName":"Right"},{"kind":"gpio","aliases":["I2C_SDA","ADC1_CH7"],"gpioPin":8,"pinName":"GP8","position":8,"headerName":"Right"},{"kind":"gpio","aliases":["I2C_SCL","ADC1_CH6"],"gpioPin":7,"pinName":"GP7","position":9,"headerName":"Right"}]},"antennaLabel":"Ceramic Antenna","hardwareSpecs":{"usb":"1x USB-C (Native OTG / JTAG)","buttons":"RST + BOOT","wireless":"Wi-Fi 4, BLE 5.0","processor":"Dual-Core Xtensa LX7 (240 MHz)","resetLabel":"RST","usbConnector":"usb-c","usbPortCount":1,"hasUartBridge":false,"modulePackage":"mini"},"onboardFeatures":[{"kind":"rgb_led","note":"GPIO21","label":"WS2812 RGB LED","gpioPin":21},{"kind":"button","note":"GPIO0","label":"BOOT Button","gpioPin":0}]}'::jsonb, 'Ultra-compact castellated ESP32-S3FH4R2 board with 4MB Flash, 2MB Quad PSRAM, ceramic antenna, USB-C, and onboard WS2812 RGB LED on GPIO21.', '2026-11-18T12:34:41.650Z', 'dual_ota_4mb', 'quad', 'qio', '80m', '0x0', '0x20000', 0, '1x USB-C (Native OTG / JTAG)', TRUE, TRUE, 'esp32s3-4m-qio-quad2m-dual_ota_4mb-b0', NULL, TRUE, TRUE, 'esp_idf');

-- seed: board_gpio_definitions (331 rows)
INSERT INTO public.board_gpio_definitions (id, board_profile_id, custom_board_profile_id, pin, label, capabilities, restrictions, board_pin_name, header_side, header_position, board_note) VALUES
  ('b04fba93-d950-4cee-9ab6-7e8391a43b34', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 0, 'GPIO0 (BOOT button & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot mode select (pull-up; LOW enters ROM download mode)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '0', 'right', 14, 'BOOT button & strapping'),
  ('bb3a9571-2d94-487e-8c20-a0d12dcb014e', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 1, 'GPIO1', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '1', 'right', 4, NULL),
  ('ba321fca-149f-4aba-a44c-0f7c7590393f', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 2, 'GPIO2', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '2', 'right', 5, NULL),
  ('de4ba20a-c8c0-4dea-8855-79e1cc4c00d6', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 3, 'GPIO3 (Strapping (JTAG))', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"JTAG signal source select","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '3', 'left', 13, 'Strapping (JTAG)'),
  ('14d2b1c4-e2df-41fa-a3b5-07abf18d8e8c', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 4, 'GPIO4', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '4', 'left', 4, NULL),
  ('a09024eb-84bb-4731-8413-bdf6455a178a', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 5, 'GPIO5', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '5', 'left', 5, NULL),
  ('33d1f65a-808b-49bc-973e-2119efe1d864', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 6, 'GPIO6', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '6', 'left', 6, NULL),
  ('7747688a-4c30-4238-9ba1-d5bab714c742', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 7, 'GPIO7', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '7', 'left', 7, NULL),
  ('59d43de0-f1e7-4f1a-a542-75d53f6c2c55', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 8, 'GPIO8', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '8', 'left', 12, NULL),
  ('13e880fe-89e0-4963-b445-41de837dca47', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 9, 'GPIO9', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '9', 'left', 15, NULL),
  ('d5ae41a4-1299-4b92-b603-2b3ab239b096', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 10, 'GPIO10', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '10', 'left', 16, NULL),
  ('f88d91fb-7392-4c87-801e-5eb9e85b2811', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 11, 'GPIO11', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '11', 'left', 17, NULL),
  ('51def654-af0c-45cd-9168-d82a764c835a', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 12, 'GPIO12', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '12', 'left', 18, NULL),
  ('732ed57b-4fe7-4ed1-a1cf-5b614c3fb3ad', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 13, 'GPIO13', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '13', 'left', 19, NULL),
  ('3441371f-60ef-4e4d-9c77-aef812129d42', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 14, 'GPIO14', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '14', 'left', 20, NULL),
  ('50d1c726-7b48-481a-82ea-235f87cfb6ec', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 15, 'GPIO15', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '15', 'left', 8, NULL),
  ('29225ebb-5c72-460b-8164-9c832f411220', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 16, 'GPIO16', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '16', 'left', 9, NULL),
  ('caa3845b-23ca-40cf-96bf-c11a41b18a77', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 17, 'GPIO17', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '17', 'left', 10, NULL),
  ('60b6f35b-d2e8-46a2-add7-739ecb8e7e20', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 18, 'GPIO18', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '18', 'left', 11, NULL),
  ('22f91db2-5509-4ecb-9135-4510726f578b', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 19, 'GPIO19 (USB D-)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '19', 'right', 20, 'USB D-'),
  ('ed6455c6-47d6-4d9b-a089-51e37cb99320', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 20, 'GPIO20 (USB D+)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '20', 'right', 19, 'USB D+'),
  ('75efb621-2cac-414c-b516-3c8bdc475632', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 21, 'GPIO21', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '21', 'right', 18, NULL),
  ('540691c4-959d-4269-b7b2-ab20ae6a1824', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 26, 'GPIO26', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI0/1 Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO26', NULL, NULL, NULL),
  ('6da08db4-8ffc-4825-84e0-178e6b1d82a7', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 27, 'GPIO27', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI0/1 Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO27', NULL, NULL, NULL),
  ('098da4dc-dd64-43b1-8337-d674ca293cf6', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 28, 'GPIO28', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI0/1 Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO28', NULL, NULL, NULL);
INSERT INTO public.board_gpio_definitions (id, board_profile_id, custom_board_profile_id, pin, label, capabilities, restrictions, board_pin_name, header_side, header_position, board_note) VALUES
  ('363385fa-c743-4900-8f57-9cbe5b52ae66', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 29, 'GPIO29', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI0/1 Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO29', NULL, NULL, NULL),
  ('e9a4bb4f-cdff-4c63-afb2-c41d483c9269', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 30, 'GPIO30', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI0/1 Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO30', NULL, NULL, NULL),
  ('291f1471-c7f2-4ff5-9bed-fb64bc536410', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 31, 'GPIO31', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI0/1 Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO31', NULL, NULL, NULL),
  ('659adc1f-61ba-4841-941d-bf76764d22f7', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 32, 'GPIO32', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI0/1 Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO32', NULL, NULL, NULL),
  ('fc0997fb-d467-4e07-8cd3-9828df8673f5', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 33, 'GPIO33', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal 8 MB Octal PSRAM bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO33', NULL, NULL, NULL),
  ('3659d488-2449-41de-8a88-157244cd7ae9', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 34, 'GPIO34', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal 8 MB Octal PSRAM bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO34', NULL, NULL, NULL),
  ('2a7a31f1-4ba2-4bc5-bf31-8f2723e626ef', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 35, 'GPIO35 (Octal PSRAM (unavailable on R8))', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal PSRAM bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, '35', 'right', 13, 'Octal PSRAM (unavailable on R8)'),
  ('2b492524-c0ff-4cc5-a3cb-7dfadf55266b', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 36, 'GPIO36 (Octal PSRAM (unavailable on R8))', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal PSRAM bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, '36', 'right', 12, 'Octal PSRAM (unavailable on R8)'),
  ('5e9479bf-b910-4f87-9ca9-31c741430373', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 37, 'GPIO37 (Octal PSRAM (unavailable on R8))', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal PSRAM bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, '37', 'right', 11, 'Octal PSRAM (unavailable on R8)'),
  ('2165d130-8ebb-4993-84b9-9138cdcfb5e0', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 38, 'GPIO38 (Onboard RGB LED (v1.1))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '38', 'right', 10, 'Onboard RGB LED (v1.1)'),
  ('22fcd8e4-0722-4d6a-b2b5-16659b64d576', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 39, 'GPIO39', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '39', 'right', 9, NULL),
  ('e34a1365-b5a3-44cb-9188-f0f216f04ca1', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 40, 'GPIO40', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '40', 'right', 8, NULL),
  ('d6199c64-45e5-45e1-ba86-88ea3f8b8806', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 41, 'GPIO41', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '41', 'right', 7, NULL),
  ('f8ab9f38-ce6c-4cca-8989-743a4ab20bc7', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 42, 'GPIO42', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '42', 'right', 6, NULL),
  ('1af67285-a5f4-4fbe-8619-4f29b13c2032', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 43, 'GPIO43 (UART0 TX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 TX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'TX', 'right', 2, 'UART0 TX'),
  ('a609b4fc-a617-4600-accb-146a8acfe17c', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 44, 'GPIO44 (UART0 RX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 RX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'RX', 'right', 3, 'UART0 RX'),
  ('9c127798-c0e9-495c-9d6c-ac621bb4106a', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 45, 'GPIO45 (Strapping (VDD_SPI))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"VDD_SPI flash voltage select (keep LOW for 3.3V)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '45', 'right', 15, 'Strapping (VDD_SPI)'),
  ('dd9f1149-e871-4f97-aa62-a3055f87bbed', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 46, 'GPIO46 (Input-only strapping)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":false,"input_only":true,"strapping_pin":true,"strapping_note":"Boot mode / ROM print enable (input-only strapping)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '46', 'left', 14, 'Input-only strapping'),
  ('48281c06-2730-4a28-b621-95a4d6aa0b88', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 47, 'GPIO47', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '47', 'right', 17, NULL),
  ('6a9f6654-fcdc-40ee-b379-11a26cff211b', 'c70dc168-947b-415e-b86a-19298331b90e', NULL, 48, 'GPIO48 (General GPIO)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '48', 'right', 16, 'General GPIO'),
  ('59dea02a-f11c-4dd1-aeaf-541527c8390f', 'ec0706d5-7f03-4586-9c73-dc499371bb5b', NULL, 0, 'GPIO0 (Onboard BOOT button)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"BOOT button (pull-up; LOW enters ROM download mode)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GPIO0', NULL, NULL, 'Onboard BOOT button'),
  ('8268cfeb-485d-4a96-a6a4-bf7076bb9bb4', 'ec0706d5-7f03-4586-9c73-dc499371bb5b', NULL, 1, 'GPIO1', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D0 / A0', 'left', 1, NULL),
  ('ce3d75c9-38d3-4923-9f3b-2c375c2779e9', 'ec0706d5-7f03-4586-9c73-dc499371bb5b', NULL, 2, 'GPIO2', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D1 / A1', 'left', 2, NULL),
  ('0b2d77e6-7c46-4ef7-b30d-00f3f40c4d09', 'ec0706d5-7f03-4586-9c73-dc499371bb5b', NULL, 3, 'GPIO3', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D2 / A2', 'left', 3, NULL),
  ('89bcdbaa-e89d-4fdb-8cb1-484cf14c0c37', 'ec0706d5-7f03-4586-9c73-dc499371bb5b', NULL, 4, 'GPIO4', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D3 / A3', 'left', 4, NULL);
INSERT INTO public.board_gpio_definitions (id, board_profile_id, custom_board_profile_id, pin, label, capabilities, restrictions, board_pin_name, header_side, header_position, board_note) VALUES
  ('54d8a40f-f832-4737-b02f-785a86a095db', 'ec0706d5-7f03-4586-9c73-dc499371bb5b', NULL, 5, 'GPIO5 (I2C SDA)', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D4 / SDA', 'left', 5, 'I2C SDA'),
  ('22c13627-4902-4856-9727-7e785680746e', 'ec0706d5-7f03-4586-9c73-dc499371bb5b', NULL, 6, 'GPIO6 (I2C SCL)', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D5 / SCL', 'left', 6, 'I2C SCL'),
  ('d5d574c3-737f-4a38-9139-5d9b7b5087a5', 'ec0706d5-7f03-4586-9c73-dc499371bb5b', NULL, 7, 'GPIO7 (SPI SCK)', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D8 / SCK', 'right', 6, 'SPI SCK'),
  ('08b4177f-7785-459b-a1b3-1c28c28308d8', 'ec0706d5-7f03-4586-9c73-dc499371bb5b', NULL, 8, 'GPIO8 (SPI MISO)', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D9 / MISO', 'right', 5, 'SPI MISO'),
  ('52221a02-b248-430c-ac30-96dd01ab775a', 'ec0706d5-7f03-4586-9c73-dc499371bb5b', NULL, 9, 'GPIO9 (SPI MOSI)', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D10 / MOSI', 'right', 4, 'SPI MOSI'),
  ('48e86bea-4296-4034-98cf-c2cde59c834a', 'ec0706d5-7f03-4586-9c73-dc499371bb5b', NULL, 21, 'GPIO21 (Onboard USER_LED (active-low; shared with Sense SD CS))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GPIO21', NULL, NULL, 'Onboard USER_LED (active-low; shared with Sense SD CS)'),
  ('d7a01731-b9e6-4fb1-baec-61901fbdef94', 'ec0706d5-7f03-4586-9c73-dc499371bb5b', NULL, 43, 'GPIO43 (UART TX (free GPIO))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D6 / TX', 'left', 7, 'UART TX (free GPIO)'),
  ('2c253aea-d128-4173-9792-3593bcfc60e8', 'ec0706d5-7f03-4586-9c73-dc499371bb5b', NULL, 44, 'GPIO44 (UART RX (free GPIO))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D7 / RX', 'right', 7, 'UART RX (free GPIO)'),
  ('ef992a60-3949-49a6-a839-69505ffd3546', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 0, 'GPIO0 (BOOT button & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot mode select (pull-up; LOW enters ROM download mode)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '0', 'right', 14, 'BOOT button & strapping'),
  ('801963ef-61b0-4a98-8702-bcdc34aab9a4', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 1, 'GPIO1', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '1', 'right', 4, NULL),
  ('2e951a42-663f-4741-906e-ef0c47f60483', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 2, 'GPIO2', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '2', 'right', 5, NULL),
  ('ce2597ba-b31e-40e4-960a-b34b88bafea9', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 3, 'GPIO3 (Strapping (JTAG))', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"JTAG signal source select","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '3', 'left', 13, 'Strapping (JTAG)'),
  ('4e1842da-a06a-4606-ac95-a651f30a241c', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 4, 'GPIO4', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '4', 'left', 4, NULL),
  ('eee51ec0-4818-4c97-82cf-99609c1e124d', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 5, 'GPIO5', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '5', 'left', 5, NULL),
  ('75260ad0-9369-42d9-b8d1-1d765d3bb1df', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 6, 'GPIO6', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '6', 'left', 6, NULL),
  ('813d61e0-5b91-44af-a37e-f3275acf6958', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 7, 'GPIO7', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '7', 'left', 7, NULL),
  ('0841dae9-c75f-469b-a011-4a3de7d31849', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 8, 'GPIO8', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '8', 'left', 12, NULL),
  ('29d77800-89e4-432d-b214-42a9b1e64111', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 9, 'GPIO9', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '9', 'left', 15, NULL),
  ('9b710544-b5c8-4f4f-8a36-c730ab3f2556', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 10, 'GPIO10', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '10', 'left', 16, NULL),
  ('c7b329e6-0f2e-4df1-8d0e-7891147d153e', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 11, 'GPIO11', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '11', 'left', 17, NULL),
  ('8751b5c8-f8ff-49b4-93bb-62655349e8f3', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 12, 'GPIO12', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '12', 'left', 18, NULL),
  ('9e0b3693-f8c1-4bf4-9165-37323c4eb71e', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 13, 'GPIO13', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '13', 'left', 19, NULL),
  ('4945f24a-54c8-477b-89fe-e1973ccbcb33', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 14, 'GPIO14', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '14', 'left', 20, NULL),
  ('0008a448-5164-4442-a291-fc52a3aae5c1', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 15, 'GPIO15', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '15', 'left', 8, NULL),
  ('90a335cf-ad35-4380-ad20-d705348445ac', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 16, 'GPIO16', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '16', 'left', 9, NULL);
INSERT INTO public.board_gpio_definitions (id, board_profile_id, custom_board_profile_id, pin, label, capabilities, restrictions, board_pin_name, header_side, header_position, board_note) VALUES
  ('ada01ce8-ca84-4928-872a-a221f1d9924b', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 17, 'GPIO17', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '17', 'left', 10, NULL),
  ('0bcf1f64-765c-4ad5-9bfb-4f612d1f72ba', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 18, 'GPIO18', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '18', 'left', 11, NULL),
  ('132c8f0e-f634-479e-9898-7877ffa5d6fa', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 19, 'GPIO19 (USB D-)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '19', 'right', 20, 'USB D-'),
  ('a39a32ec-abea-473d-a2d3-916aae4ee136', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 20, 'GPIO20 (USB D+)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '20', 'right', 19, 'USB D+'),
  ('e9f9bb7a-52bb-47b9-b666-f7045bbf86a9', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 21, 'GPIO21', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '21', 'right', 18, NULL),
  ('062522f1-b63f-4e3c-86c8-998d10049814', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 26, 'GPIO26', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO26', NULL, NULL, NULL),
  ('398c3b5e-1b8b-4cc0-995b-e49d661ef306', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 27, 'GPIO27', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO27', NULL, NULL, NULL),
  ('cedc673b-dce4-49c5-a8f2-18b978cd3dbc', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 28, 'GPIO28', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO28', NULL, NULL, NULL),
  ('c10e7d29-45b8-4031-bd63-cadf1a91f952', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 29, 'GPIO29', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO29', NULL, NULL, NULL),
  ('6e59e648-953f-4fe1-a02a-edea4e98644e', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 30, 'GPIO30', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO30', NULL, NULL, NULL),
  ('8c12447b-dfbe-40f0-a806-e6c369eb424e', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 31, 'GPIO31', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO31', NULL, NULL, NULL),
  ('ce45e27e-9570-46c0-8e58-19510c2ece2e', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 32, 'GPIO32', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO32', NULL, NULL, NULL),
  ('5de5dd15-c0b0-4c28-b0fc-59e624ff94ef', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 33, 'GPIO33', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal PSRAM bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO33', NULL, NULL, NULL),
  ('e76f392f-6dd6-47cd-ab9f-2a6c8914e1cc', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 34, 'GPIO34', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal PSRAM bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'GPIO34', NULL, NULL, NULL),
  ('365cd306-7bbb-4c6e-8f5c-9f4514c3d685', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 35, 'GPIO35 (Octal PSRAM (unavailable on R8))', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal PSRAM bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, '35', 'right', 13, 'Octal PSRAM (unavailable on R8)'),
  ('5b5bf6be-901a-4b13-9d9a-8f45b6e5832e', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 36, 'GPIO36 (Octal PSRAM (unavailable on R8))', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal PSRAM bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, '36', 'right', 12, 'Octal PSRAM (unavailable on R8)'),
  ('450c59a6-8b75-4885-b4a6-bed8bbadce17', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 37, 'GPIO37 (Octal PSRAM (unavailable on R8))', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal PSRAM bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, '37', 'right', 11, 'Octal PSRAM (unavailable on R8)'),
  ('33b211b4-ed63-46e8-88d4-78f28228be78', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 38, 'GPIO38 (General GPIO (free on v1.0))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '38', 'right', 10, 'General GPIO (free on v1.0)'),
  ('22134c99-c16a-4717-b99d-d5f7471bb2cf', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 39, 'GPIO39', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '39', 'right', 9, NULL),
  ('00dce99f-8ac9-40b6-b56c-637d655995f9', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 40, 'GPIO40', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '40', 'right', 8, NULL),
  ('47626d71-12b3-421c-a699-6e32c3c8c2dd', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 41, 'GPIO41', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '41', 'right', 7, NULL),
  ('82e65119-2d7c-4248-834f-b67b2f154b9f', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 42, 'GPIO42', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '42', 'right', 6, NULL),
  ('81c8675f-b555-4ea7-9e64-f27fe133ac91', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 43, 'GPIO43 (UART0 TX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 TX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'TX', 'right', 2, 'UART0 TX'),
  ('59ccc0bc-822f-47aa-aa3a-721e8fe5aa42', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 44, 'GPIO44 (UART0 RX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 RX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'RX', 'right', 3, 'UART0 RX'),
  ('5ffe75a1-a2a7-4975-bb50-58bfa1ed2daf', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 45, 'GPIO45 (Strapping (VDD_SPI))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"VDD_SPI flash voltage select (keep LOW for 3.3V)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '45', 'right', 15, 'Strapping (VDD_SPI)');
INSERT INTO public.board_gpio_definitions (id, board_profile_id, custom_board_profile_id, pin, label, capabilities, restrictions, board_pin_name, header_side, header_position, board_note) VALUES
  ('290f2974-d500-4085-9459-8655ef9c61c7', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 46, 'GPIO46 (Input-only strapping)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":false,"input_only":true,"strapping_pin":true,"strapping_note":"Boot mode / ROM print enable (input-only strapping)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '46', 'left', 14, 'Input-only strapping'),
  ('6530b014-f8c0-4992-8195-ca90bb930620', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 47, 'GPIO47', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '47', 'right', 17, NULL),
  ('f30986cb-fa54-43ae-9f95-49c581a07ffa', '51dd4142-a8ee-4b09-acd7-a487eba79aa7', NULL, 48, 'GPIO48 (Onboard RGB LED (v1.0))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '48', 'right', 16, 'Onboard RGB LED (v1.0)'),
  ('c194f1b8-9ef9-426c-b8db-fbec990f54d1', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 0, 'GPIO0', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '0', 'left', 3, NULL),
  ('9f601c54-c619-46db-b1f1-bd97dffbacdb', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 1, 'GPIO1', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '1', 'left', 4, NULL),
  ('059970d9-46ba-4fd5-95b7-4898acccac4f', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 2, 'GPIO2', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '2', 'left', 5, NULL),
  ('d5c06374-bba8-4e9b-bad3-ffda696f7ed3', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 3, 'GPIO3', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '3', 'left', 6, NULL),
  ('63e8e0dc-6862-44a3-86ea-9f5da4aa3dba', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 4, 'GPIO4 (Strapping)', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"MTMS JTAG/boot strapping","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '4', 'left', 7, 'Strapping'),
  ('309780ee-cafc-4fc3-af60-a2b7a01bd40d', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 5, 'GPIO5 (Strapping)', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"MTDI boot strapping","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '5', 'left', 8, 'Strapping'),
  ('301a3ff4-a2da-4481-ab74-1de7b0893b93', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 6, 'GPIO6', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '6', 'left', 9, NULL),
  ('33fec1f6-350a-4e91-98a9-fa77ce773fee', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 7, 'GPIO7', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '7', 'left', 10, NULL),
  ('31df1338-f576-4ed5-adcf-86fb4804e8c9', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 8, 'GPIO8 (Onboard RGB LED & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot mode / RGB LED strapping","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '8', 'left', 13, 'Onboard RGB LED & strapping'),
  ('9dfd5352-c42d-4675-83f4-9bd33300bb24', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 9, 'GPIO9 (BOOT button & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"BOOT button / download mode strapping","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '9', 'right', 11, 'BOOT button & strapping'),
  ('9105814f-672f-426c-aa8d-caeb0cdba8a6', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 10, 'GPIO10', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '10', 'left', 11, NULL),
  ('c8ce1b38-6dd7-420b-b293-7c5701f7f675', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 11, 'GPIO11', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '11', 'left', 12, NULL),
  ('15c57b08-4e76-433e-b2c6-6de5f6e67f10', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 12, 'GPIO12 (USB D-)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '12', 'right', 13, 'USB D-'),
  ('6727d75b-06a0-4243-b698-58105054e0d1', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 13, 'GPIO13 (USB D+)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '13', 'right', 12, 'USB D+'),
  ('50adf147-5677-46dc-9369-ad423b0ab16c', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 14, 'GPIO14', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '14', 'right', 10, NULL),
  ('27f964f3-4320-498e-bfec-168815a02719', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 15, 'GPIO15 (Strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"ROM log print control strapping","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '15', 'left', 14, 'Strapping'),
  ('c89d61d5-da3b-4df1-8c1a-d3285f05af9f', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 16, 'GPIO16 (UART0 TX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 TX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'TX / 16', 'right', 2, 'UART0 TX'),
  ('25d2e532-6355-4453-9370-b8a575242e7f', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 17, 'GPIO17 (UART0 RX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 RX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'RX / 17', 'right', 3, 'UART0 RX'),
  ('962be979-901a-494a-a728-101c5a495875', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 18, 'GPIO18', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '18', 'right', 9, NULL),
  ('1e531131-663b-486b-91da-ba4114ad0295', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 19, 'GPIO19', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '19', 'right', 8, NULL),
  ('4ffb4da3-95dd-4233-ad9e-db3e6aff297a', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 20, 'GPIO20', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '20', 'right', 7, NULL),
  ('10d78ab1-3284-4154-868d-6a3a3f5b7b18', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 21, 'GPIO21', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '21', 'right', 6, NULL);
INSERT INTO public.board_gpio_definitions (id, board_profile_id, custom_board_profile_id, pin, label, capabilities, restrictions, board_pin_name, header_side, header_position, board_note) VALUES
  ('9295bcf7-efc1-4b8d-a024-0366fbdca81f', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 22, 'GPIO22', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '22', 'right', 5, NULL),
  ('d4de351f-5fae-4c22-8caf-67563acb0ba7', '35e465f2-2f3e-4606-8e75-15c750bc6924', NULL, 23, 'GPIO23', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '23', 'right', 4, NULL),
  ('98dc3ce8-65b0-40c7-b250-5e96d64c2cad', 'c655f6fd-8537-4ca4-a8fd-938d9251e27f', NULL, 0, 'GPIO0', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '0', 'left', 9, NULL),
  ('e5032485-6629-4cd2-bbf1-881d1d8cb41b', 'c655f6fd-8537-4ca4-a8fd-938d9251e27f', NULL, 1, 'GPIO1', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '1', 'left', 10, NULL),
  ('e95eb88c-f96f-43b4-bb19-5b706ffbf7e4', 'c655f6fd-8537-4ca4-a8fd-938d9251e27f', NULL, 2, 'GPIO2 (Strapping)', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot mode strapping","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '2', 'left', 4, 'Strapping'),
  ('30659440-4216-4e80-b8e1-cb74b50542c0', 'c655f6fd-8537-4ca4-a8fd-938d9251e27f', NULL, 3, 'GPIO3', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '3', 'left', 5, NULL),
  ('e1ced32b-a898-4c59-8587-1a49ec12a21f', 'c655f6fd-8537-4ca4-a8fd-938d9251e27f', NULL, 4, 'GPIO4', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '4', 'right', 11, NULL),
  ('465cf4d5-5918-412f-8222-6c3d23a070ec', 'c655f6fd-8537-4ca4-a8fd-938d9251e27f', NULL, 5, 'GPIO5', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '5', 'right', 10, NULL),
  ('74305ffb-3867-466a-b8e7-cc931bc91dfd', 'c655f6fd-8537-4ca4-a8fd-938d9251e27f', NULL, 6, 'GPIO6', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '6', 'right', 9, NULL),
  ('f22b3126-6529-426b-b5bf-137c1cebae1c', 'c655f6fd-8537-4ca4-a8fd-938d9251e27f', NULL, 7, 'GPIO7', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '7', 'right', 8, NULL),
  ('564f72f4-48fb-4893-aea1-c4bab8d7dcd0', 'c655f6fd-8537-4ca4-a8fd-938d9251e27f', NULL, 8, 'GPIO8 (Onboard RGB LED & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot mode / onboard RGB LED (must not be pulled LOW at boot)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '8', 'right', 6, 'Onboard RGB LED & strapping'),
  ('a65058e2-d0c7-4d54-a871-9f50703a9a4a', 'c655f6fd-8537-4ca4-a8fd-938d9251e27f', NULL, 9, 'GPIO9 (BOOT button & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"BOOT button / download mode strapping","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '9', 'right', 5, 'BOOT button & strapping'),
  ('2d15a83c-c48c-49e7-956a-34ce2b5febf2', 'c655f6fd-8537-4ca4-a8fd-938d9251e27f', NULL, 10, 'GPIO10', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '10', 'left', 11, NULL),
  ('85aadf5e-742b-431c-ac4e-e82e8f720f63', 'c655f6fd-8537-4ca4-a8fd-938d9251e27f', NULL, 18, 'GPIO18 (USB D-)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '18', 'right', 13, 'USB D-'),
  ('1893c87c-197c-49de-868c-1f67916f881b', 'c655f6fd-8537-4ca4-a8fd-938d9251e27f', NULL, 19, 'GPIO19 (USB D+)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '19', 'right', 14, 'USB D+'),
  ('d2c7f5d0-f8a2-4561-a3d2-ec11f281df5e', 'c655f6fd-8537-4ca4-a8fd-938d9251e27f', NULL, 20, 'GPIO20 (UART0 RX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 RX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'RX / 20', 'right', 3, 'UART0 RX'),
  ('88e3e3ea-dd96-4739-9a25-b72a9ceb4f58', 'c655f6fd-8537-4ca4-a8fd-938d9251e27f', NULL, 21, 'GPIO21 (UART0 TX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 TX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'TX / 21', 'right', 2, 'UART0 TX'),
  ('8e88317b-82f1-4b96-92d5-7dea96f4cf8c', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 0, 'GPIO0 (BOOT button & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot mode select (pull-up; LOW enters download mode)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '0', 'right', 14, 'BOOT button & strapping'),
  ('5441401a-48e0-4fa7-a464-bd89be7491ff', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 1, 'GPIO1 (UART0 TX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 TX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'TXD0 / 1', 'right', 4, 'UART0 TX'),
  ('fd6f2a85-750a-484f-9014-05cb0dca90c8', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 2, 'GPIO2 (Strapping / Onboard LED)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Download boot / onboard LED strapping","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '2', 'right', 15, 'Strapping / Onboard LED'),
  ('c8618319-3069-4b9f-9da8-5d3b22d59a6a', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 3, 'GPIO3 (UART0 RX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 RX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'RXD0 / 3', 'right', 5, 'UART0 RX'),
  ('147767a0-fa8b-47b1-85af-530fc0c06495', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 4, 'GPIO4', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '4', 'right', 13, NULL),
  ('a6f48300-163c-4fa5-97f0-a5c08ea9576d', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 5, 'GPIO5 (Strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"SDIO timing strapping","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '5', 'right', 10, 'Strapping'),
  ('2ce6b4c4-1c07-4dff-a429-84bea09e121f', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 6, 'GPIO6 (SPI Flash CLK (reserved))', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'CLK / 6', 'right', 19, 'SPI Flash CLK (reserved)'),
  ('7715c7e4-1494-4fbc-a9e7-ed537add856f', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 7, 'GPIO7 (SPI Flash D0 (reserved))', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'D0 / 7', 'right', 18, 'SPI Flash D0 (reserved)');
INSERT INTO public.board_gpio_definitions (id, board_profile_id, custom_board_profile_id, pin, label, capabilities, restrictions, board_pin_name, header_side, header_position, board_note) VALUES
  ('217d30ae-650d-460d-9c1c-e2f648ef4694', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 8, 'GPIO8 (SPI Flash D1 (reserved))', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'D1 / 8', 'right', 17, 'SPI Flash D1 (reserved)'),
  ('ce8f3fee-1b10-422b-b850-de43c6e3f25c', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 9, 'GPIO9 (SPI Flash D2 (reserved))', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'D2 / 9', 'left', 16, 'SPI Flash D2 (reserved)'),
  ('8b2d63f1-c54a-4e4d-9017-678f4e528e54', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 10, 'GPIO10 (SPI Flash D3 (reserved))', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'D3 / 10', 'left', 17, 'SPI Flash D3 (reserved)'),
  ('49ccd2d6-d81f-4db9-9eaf-470cd42589c3', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 11, 'GPIO11 (SPI Flash CMD (reserved))', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'CMD / 11', 'left', 18, 'SPI Flash CMD (reserved)'),
  ('707daa69-8ce0-408c-80dc-74417211c32a', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 12, 'GPIO12 (Strapping (keep LOW at boot))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"MTDI flash voltage select (must be LOW on 3.3V flash boards!)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '12', 'left', 13, 'Strapping (keep LOW at boot)'),
  ('82180b49-096e-4e4d-bb83-c4bf7793f8c7', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 13, 'GPIO13', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '13', 'left', 15, NULL),
  ('70330909-6902-4091-984a-60e53c072a2d', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 14, 'GPIO14', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '14', 'left', 12, NULL),
  ('fff0007e-653a-45af-9ae5-1188599cf486', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 15, 'GPIO15 (Strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"MTDO boot log silencing strapping","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '15', 'right', 16, 'Strapping'),
  ('580fa92f-9184-47e4-b905-41231dcb08f1', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 16, 'GPIO16', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '16', 'right', 12, NULL),
  ('8a349a2a-2268-4fdf-8d7c-cbeeb3cba582', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 17, 'GPIO17', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '17', 'right', 11, NULL),
  ('56bf23e9-664f-4a86-af2f-ec50b6066265', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 18, 'GPIO18', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '18', 'right', 9, NULL),
  ('8f07bdb4-2d48-4d09-80e1-2a55d6524e83', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 19, 'GPIO19', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '19', 'right', 8, NULL),
  ('40a1e323-5e9f-4cf4-ace3-2f8d7350d9ef', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 21, 'GPIO21', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '21', 'right', 6, NULL),
  ('bd26f800-6e19-4852-b280-aac23db59589', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 22, 'GPIO22', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '22', 'right', 3, NULL),
  ('ea3701f7-00b5-48e7-8d49-4aac16799310', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 23, 'GPIO23', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '23', 'right', 2, NULL),
  ('c7e3ef85-7397-4dcf-9928-f96e0c2e2779', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 25, 'GPIO25', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '25', 'left', 9, NULL),
  ('01f036fd-3c8a-4845-8fd1-56425cd97a4f', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 26, 'GPIO26', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '26', 'left', 10, NULL),
  ('ea3f52c2-c86e-4ac5-8ff2-a886ed274e14', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 27, 'GPIO27', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '27', 'left', 11, NULL),
  ('0f6f6d3c-3e8a-4210-998e-b07774d63650', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 32, 'GPIO32', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '32', 'left', 7, NULL),
  ('9805db13-35af-4434-b7a7-6d08dde4f273', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 33, 'GPIO33', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '33', 'left', 8, NULL),
  ('1876f936-c4b5-415b-a264-a79fddefb06f', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 34, 'GPIO34 (Input-only)', '{"adc":true,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":false,"input_only":true,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '34', 'left', 5, 'Input-only'),
  ('0a492384-4c83-427a-bcc6-5e75f26d8004', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 35, 'GPIO35 (Input-only)', '{"adc":true,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":false,"input_only":true,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '35', 'left', 6, 'Input-only'),
  ('b5f5d606-59be-4589-9f92-290a3ba80aed', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 36, 'GPIO36 (Input-only)', '{"adc":true,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":false,"input_only":true,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'VP / 36', 'left', 3, 'Input-only'),
  ('4d14b661-409e-4176-ba0f-882a0ff83f2f', '559d161b-291d-47e3-8c74-c7544b7e3e4f', NULL, 39, 'GPIO39 (Input-only)', '{"adc":true,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":false,"input_only":true,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'VN / 39', 'left', 4, 'Input-only'),
  ('29b2c517-acc5-4a3f-960b-c7fae94a9938', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 0, 'GPIO0 (BOOT button & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot mode select (pull-up; LOW enters download mode)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '0', 'left', 2, 'BOOT button & strapping');
INSERT INTO public.board_gpio_definitions (id, board_profile_id, custom_board_profile_id, pin, label, capabilities, restrictions, board_pin_name, header_side, header_position, board_note) VALUES
  ('de763d86-6592-4acd-98e7-8f36fe9754ec', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 1, 'GPIO1', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '1', 'left', 3, NULL),
  ('009ff138-f8f5-4ecf-8296-293520c79c53', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 2, 'GPIO2', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '2', 'left', 4, NULL),
  ('429dd5df-1cd5-45aa-b220-a8de02732f63', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 3, 'GPIO3', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '3', 'left', 5, NULL),
  ('edb442d2-0e30-4019-8ece-062291ba701f', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 4, 'GPIO4', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '4', 'left', 6, NULL),
  ('ad78ed19-8570-49a8-b262-94309c4d9af1', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 5, 'GPIO5', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '5', 'left', 7, NULL),
  ('556a3aa2-1c41-4569-9bdf-ec9e17a6570e', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 6, 'GPIO6', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '6', 'left', 8, NULL),
  ('b8d945eb-abb1-4691-85fb-b4ea44ea9727', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 7, 'GPIO7', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '7', 'left', 9, NULL),
  ('1e665a01-4fd4-4234-88dd-02a845363555', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 8, 'GPIO8', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '8', 'left', 10, NULL),
  ('5f89b498-0842-4e64-8882-cdf1eebc6127', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 9, 'GPIO9', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '9', 'left', 11, NULL),
  ('70de6054-2b53-46b9-9c66-274e22f85a40', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 10, 'GPIO10', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '10', 'left', 12, NULL),
  ('c9791560-b6c3-4355-bb8d-831727655308', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 11, 'GPIO11', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '11', 'left', 13, NULL),
  ('72c2ac96-c819-4f0c-b8e4-b463b4fee817', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 12, 'GPIO12', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '12', 'left', 14, NULL),
  ('321a97e4-687b-4159-a9e4-175422dc29d1', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 13, 'GPIO13', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '13', 'left', 15, NULL),
  ('bed0b249-24be-4b31-9e0c-fe58f74567a9', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 14, 'GPIO14', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '14', 'left', 16, NULL),
  ('44de597a-d15a-430e-86c4-db44d290f688', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 15, 'GPIO15', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '15', 'left', 17, NULL),
  ('b9d73257-b27d-4e82-a989-542bab6beebc', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 16, 'GPIO16', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '16', 'left', 18, NULL),
  ('1fa69f00-b69b-47d5-9d80-15def822a635', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 17, 'GPIO17', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '17', 'left', 19, NULL),
  ('fe680f1c-9233-4d5d-9c50-af2add56577c', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 18, 'GPIO18 (Onboard RGB LED)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '18', 'left', 20, 'Onboard RGB LED'),
  ('f3d8333c-6e35-44af-b811-976c4d534057', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 19, 'GPIO19 (USB D-)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '19', 'left', 21, 'USB D-'),
  ('1d1a9acf-8658-4dcc-a4ee-2b43b41d13e1', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 20, 'GPIO20 (USB D+)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '20', 'left', 22, 'USB D+'),
  ('7fe99148-a33d-4984-a913-fb485e4ae387', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 21, 'GPIO21', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '21', 'right', 2, NULL),
  ('39d8c2e7-0276-485a-bbec-2b64ae468493', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 5, 'GPIO5', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '5', 'left', 6, NULL),
  ('6f1bda45-2904-40e8-b4c4-40dff52fedbd', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 26, 'GPIO26 (SPI Flash/PSRAM CS1 (reserved))', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, '26', 'right', 3, 'SPI Flash/PSRAM CS1 (reserved)'),
  ('a859cb59-e046-458d-8309-11f295e7f069', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 33, 'GPIO33', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '33', 'right', 4, NULL),
  ('173ddb1d-507a-4e04-81df-1c991c5364ca', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 34, 'GPIO34', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '34', 'right', 5, NULL);
INSERT INTO public.board_gpio_definitions (id, board_profile_id, custom_board_profile_id, pin, label, capabilities, restrictions, board_pin_name, header_side, header_position, board_note) VALUES
  ('8e495807-eb6e-4cba-b444-d02a6c2cff43', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 35, 'GPIO35', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '35', 'right', 6, NULL),
  ('864a9454-1654-41a1-ae8b-29df182272ec', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 36, 'GPIO36', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '36', 'right', 7, NULL),
  ('d0113560-7675-4171-aba6-b3cfab008f9d', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 37, 'GPIO37', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '37', 'right', 8, NULL),
  ('9155dd47-1aee-4589-b6e7-a91fcbcb7fe1', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 38, 'GPIO38', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '38', 'right', 9, NULL),
  ('972a33c4-c762-4594-acde-aaf8e141ad70', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 39, 'GPIO39', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '39', 'right', 10, NULL),
  ('c8b12622-6f49-460c-b82a-4325ad98a99d', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 40, 'GPIO40', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '40', 'right', 11, NULL),
  ('6bbb41fc-3d4a-46c7-bf80-cb2712c03a38', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 41, 'GPIO41', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '41', 'right', 12, NULL),
  ('a62724ea-f750-495d-be68-06c2eb081b39', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 42, 'GPIO42', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '42', 'right', 13, NULL),
  ('c694c584-a3a9-4670-aea3-9f06aadc560e', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 43, 'GPIO43 (UART0 TX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 TX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'TX / 43', 'right', 14, 'UART0 TX'),
  ('e817f015-f7f3-4bf5-ae56-0e9509d7f2c4', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 44, 'GPIO44 (UART0 RX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 RX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'RX / 44', 'right', 15, 'UART0 RX'),
  ('d540f8e2-7b89-4bd7-95e6-54e7735edcb2', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 45, 'GPIO45 (Strapping (VDD_SPI))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"VDD_SPI flash voltage select","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '45', 'right', 16, 'Strapping (VDD_SPI)'),
  ('5ad76e52-d383-481f-a87e-0baabdf1ad52', '04437f70-f575-4f46-894d-ef9447a42d27', NULL, 46, 'GPIO46 (Input-only strapping)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":false,"input_only":true,"strapping_pin":true,"strapping_note":"ROM log / download mode strapping (input-only)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '46', 'right', 17, 'Input-only strapping'),
  ('1f76a084-1838-43dd-b564-0a78e8b6e981', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 0, 'GPIO0', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '0', 'left', 13, NULL),
  ('dca4f512-b7fc-482b-8cab-ae7b89fb0673', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 1, 'GPIO1', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '1', 'left', 12, NULL),
  ('899fd57d-e12f-466a-aaf5-f8b7c33abc3a', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 2, 'GPIO2 (Strapping)', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot strapping pin","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '2', 'left', 3, 'Strapping'),
  ('fec0fc4f-671a-453e-999f-a0a6230f9f81', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 3, 'GPIO3', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '3', 'left', 4, NULL),
  ('db9397a9-2c13-45d4-aad8-441716f6d6fc', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 4, 'GPIO4', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '4', 'left', 5, NULL),
  ('e1b6df67-b8ba-44cd-ba10-6c2b5993f80f', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 6, 'GPIO6', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '6', 'left', 7, NULL),
  ('6ab0cbca-5ccb-497d-b70e-de4be237ffaf', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 7, 'GPIO7 (Strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot strapping pin","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '7', 'left', 8, 'Strapping'),
  ('1f93d8f6-f6d8-4176-b16f-25ea9be942ed', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 8, 'GPIO8', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '8', 'left', 9, NULL),
  ('949c2773-3b91-4eb0-a1fd-7811bc02cb20', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 9, 'GPIO9', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '9', 'left', 10, NULL),
  ('c28dbb1c-7531-4365-bd68-54243188e6d2', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 10, 'GPIO10', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '10', 'left', 11, NULL),
  ('ec7776e2-10ca-4413-b186-3a1af1521072', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 11, 'GPIO11 (UART0 TX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 TX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'TX / 11', 'right', 2, 'UART0 TX'),
  ('19e85067-052f-4645-863a-8daec807e1b2', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 12, 'GPIO12 (UART0 RX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 RX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'RX / 12', 'right', 3, 'UART0 RX'),
  ('fa7dcdfe-990d-4c26-83cc-912805c5d2a6', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 13, 'GPIO13 (USB D-)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '13', 'right', 12, 'USB D-');
INSERT INTO public.board_gpio_definitions (id, board_profile_id, custom_board_profile_id, pin, label, capabilities, restrictions, board_pin_name, header_side, header_position, board_note) VALUES
  ('26156f9d-cce9-40c6-90c5-a2f5b52012f6', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 14, 'GPIO14 (USB D+)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '14', 'right', 11, 'USB D+'),
  ('4273eb36-e2b3-4748-8d30-30c4973bf128', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 15, 'GPIO15', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '15', 'right', 9, NULL),
  ('512ca67b-3574-4593-9b3d-ffa8a87af782', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 23, 'GPIO23', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '23', 'right', 8, NULL),
  ('6240dc68-2668-4760-b0a8-5aa746b3e83f', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 24, 'GPIO24', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '24', 'right', 7, NULL),
  ('f5d9b738-d9eb-438d-b54b-0a0d1f070cbd', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 25, 'GPIO25 (Strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot strapping pin","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '25', 'right', 6, 'Strapping'),
  ('61dd3bda-ed31-4035-a038-0ac51fc21c24', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 26, 'GPIO26', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '26', 'right', 5, NULL),
  ('cd6b1e64-cae2-471b-85e3-793d4d5d05cb', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 27, 'GPIO27 (Onboard RGB LED & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot strapping / onboard RGB LED","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '27', 'right', 4, 'Onboard RGB LED & strapping'),
  ('fac21b07-31ad-4b56-9bb7-45b103334189', '9cbe2200-a27b-4662-8b96-edeec2389374', NULL, 28, 'GPIO28 (BOOT button & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"BOOT button / download mode strapping","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '28', 'right', 10, 'BOOT button & strapping'),
  ('568c3eab-a9c8-46b3-9992-dc00aab45e7c', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 0, 'GPIO0', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '0', 'left', 3, NULL),
  ('d86f1ce5-cac1-4344-8968-986f00943cdd', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 1, 'GPIO1', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '1', 'left', 4, NULL),
  ('243a5988-2a63-4a34-b991-c276986fd2e4', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 2, 'GPIO2', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '2', 'left', 5, NULL),
  ('7312f213-9537-4d2a-8ef7-2c5122273921', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 3, 'GPIO3', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '3', 'left', 6, NULL),
  ('7c37e9b7-cf93-4362-8797-b6a78c39982c', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 4, 'GPIO4', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '4', 'left', 7, NULL),
  ('0ddfd57f-6b80-4515-bf17-8f7c512d0f9e', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 5, 'GPIO5', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '5', 'left', 8, NULL),
  ('d1b14f4b-19a2-4e47-8707-f31cb7c524b0', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 6, 'GPIO6', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '6', 'left', 9, NULL),
  ('cb3ac0ad-133d-40f0-8d9e-ace06d552566', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 7, 'GPIO7 (Strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot strapping pin","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '7', 'left', 10, 'Strapping'),
  ('0615c195-acb1-4fcd-9b2d-e046d18aa07a', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 8, 'GPIO8 (Onboard RGB LED & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot strapping / onboard RGB LED","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '8', 'left', 11, 'Onboard RGB LED & strapping'),
  ('2fb7a6d6-e15e-4382-a88e-d874eda737e9', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 9, 'GPIO9 (BOOT button & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"BOOT button / download mode strapping","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '9', 'right', 11, 'BOOT button & strapping'),
  ('cd9bb0ef-19aa-43e2-b359-9868532934b5', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 10, 'GPIO10 (UART0 RX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 RX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'RX / 10', 'right', 3, 'UART0 RX'),
  ('7dc09c88-8b96-46a9-aed5-4e9651d4386b', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 11, 'GPIO11 (UART0 TX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 TX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'TX / 11', 'right', 2, 'UART0 TX'),
  ('e0844d61-ac18-49f8-b189-d3ada80de9c5', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 12, 'GPIO12 (USB D-)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '12', 'right', 13, 'USB D-'),
  ('7b4b9792-a6e0-406c-9a19-aacd48fcbd18', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 13, 'GPIO13 (USB D+)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '13', 'right', 12, 'USB D+'),
  ('15d8ad9d-f805-45f2-9e84-52d9e4e169b8', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 21, 'GPIO21', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '21', 'left', 12, NULL),
  ('f202a559-a5d3-47e9-96cf-3e71719bc84a', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 22, 'GPIO22', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '22', 'right', 10, NULL),
  ('ff16115b-1f4a-4c39-a594-d1759927a9e3', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 23, 'GPIO23', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '23', 'right', 9, NULL);
INSERT INTO public.board_gpio_definitions (id, board_profile_id, custom_board_profile_id, pin, label, capabilities, restrictions, board_pin_name, header_side, header_position, board_note) VALUES
  ('8d58f33b-441b-43a1-a071-7472d92bdb7f', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 24, 'GPIO24', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '24', 'right', 8, NULL),
  ('4ad229a2-a4c2-4e45-b223-e4aad8d08fa6', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 25, 'GPIO25', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '25', 'right', 7, NULL),
  ('febb4a58-1da9-47bd-a091-1745ac88998e', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 26, 'GPIO26', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '26', 'right', 6, NULL),
  ('ace8acc5-c889-42d7-8b0f-5a200ea6e069', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 27, 'GPIO27', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '27', 'right', 5, NULL),
  ('51cab61f-ad74-42ac-9e89-08b6b003cbec', 'e52f8c12-a762-4e87-93f4-8292c8e8ae88', NULL, 28, 'GPIO28', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '28', 'right', 4, NULL),
  ('ad2ec633-cc82-48ea-a3d4-8a82842d6b91', 'cc8c0958-f96a-4d14-a8cc-915af7051b9a', NULL, 0, 'GPIO0 (Onboard RGB Red)', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '0', 'left', 9, 'Onboard RGB Red'),
  ('40878281-b72d-4b39-a90e-47420eccd4f9', 'cc8c0958-f96a-4d14-a8cc-915af7051b9a', NULL, 1, 'GPIO1 (Onboard RGB Green)', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '1', 'left', 10, 'Onboard RGB Green'),
  ('71d9248e-0b04-40ba-ae84-924682bd7cd2', 'cc8c0958-f96a-4d14-a8cc-915af7051b9a', NULL, 2, 'GPIO2', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '2', 'left', 4, NULL),
  ('19cdb5e2-e85f-4dba-ba39-171d75dc7c3e', 'cc8c0958-f96a-4d14-a8cc-915af7051b9a', NULL, 3, 'GPIO3', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '3', 'left', 5, NULL),
  ('a9cfe5e6-a159-4472-80f2-24dc5ebb989c', 'cc8c0958-f96a-4d14-a8cc-915af7051b9a', NULL, 4, 'GPIO4', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '4', 'right', 11, NULL),
  ('f2b7441c-fe10-4e02-a2eb-69cb704bfd43', 'cc8c0958-f96a-4d14-a8cc-915af7051b9a', NULL, 5, 'GPIO5', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '5', 'right', 10, NULL),
  ('d3b715ca-5125-4857-ba2b-e02d7a498806', 'cc8c0958-f96a-4d14-a8cc-915af7051b9a', NULL, 6, 'GPIO6', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '6', 'right', 9, NULL),
  ('8eb31669-9c14-4bfd-91f2-6abb9958437c', 'cc8c0958-f96a-4d14-a8cc-915af7051b9a', NULL, 7, 'GPIO7', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '7', 'right', 8, NULL),
  ('3c2e6ad4-be1b-44f5-87ac-2dbe7c34d75d', 'cc8c0958-f96a-4d14-a8cc-915af7051b9a', NULL, 8, 'GPIO8 (RGB Blue & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot strapping / blue LED","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '8', 'right', 6, 'RGB Blue & strapping'),
  ('bfe12640-6ae9-4bc0-9ec7-78ab023bf29b', 'cc8c0958-f96a-4d14-a8cc-915af7051b9a', NULL, 9, 'GPIO9 (BOOT button & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"BOOT button / download mode strapping","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '9', 'right', 5, 'BOOT button & strapping'),
  ('8c87f367-179d-4aed-83b6-9e5e5ae0c137', 'cc8c0958-f96a-4d14-a8cc-915af7051b9a', NULL, 10, 'GPIO10', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '10', 'left', 11, NULL),
  ('a947b017-a389-4b09-8e5d-6a74e4406bc9', 'cc8c0958-f96a-4d14-a8cc-915af7051b9a', NULL, 18, 'GPIO18', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '18', 'right', 13, NULL),
  ('bab1496a-cd1e-4aa9-8e87-167974b387fa', 'cc8c0958-f96a-4d14-a8cc-915af7051b9a', NULL, 19, 'GPIO19 (UART0 RX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 RX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'RX / 19', 'right', 3, 'UART0 RX'),
  ('ad2c5a1c-1450-4bf8-a725-beaa0ed0f550', 'cc8c0958-f96a-4d14-a8cc-915af7051b9a', NULL, 20, 'GPIO20 (UART0 TX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 TX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'TX / 20', 'right', 2, 'UART0 TX'),
  ('00cd7155-5274-4f0c-b279-5c4cb99cee40', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 0, 'GPIO0', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '0', 'left', 3, NULL),
  ('4a4faaf8-c578-4452-8fde-8f1abdf0e7c1', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 1, 'GPIO1', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '1', 'left', 4, NULL),
  ('ab17106b-b692-4346-833d-0090fb0fcf3e', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 2, 'GPIO2 (Strapping)', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot strapping pin","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '2', 'left', 5, 'Strapping'),
  ('92ff8c40-54fe-4b76-8b91-31fc74a410b3', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 3, 'GPIO3 (Strapping)', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot strapping pin","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '3', 'left', 6, 'Strapping'),
  ('c8ff0704-b9d1-4581-aaaf-8d0b68794af8', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 4, 'GPIO4', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '4', 'left', 7, NULL),
  ('2d5b3510-17b2-4b8e-b27c-7baaf0ddb47f', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 5, 'GPIO5', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '5', 'left', 8, NULL);
INSERT INTO public.board_gpio_definitions (id, board_profile_id, custom_board_profile_id, pin, label, capabilities, restrictions, board_pin_name, header_side, header_position, board_note) VALUES
  ('8ee18c46-1776-4b32-897c-6361ab0604e3', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 8, 'GPIO8 (Onboard RGB LED & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot strapping / onboard RGB LED","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '8', 'left', 11, 'Onboard RGB LED & strapping'),
  ('b6fea338-7c6f-47c4-b7ec-eed513dc671f', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 9, 'GPIO9 (BOOT button & strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"BOOT button / download mode strapping","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '9', 'right', 6, 'BOOT button & strapping'),
  ('c9e28fab-01e0-444a-81e5-bb4df6a626ab', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 10, 'GPIO10', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '10', 'left', 9, NULL),
  ('f6c1bcfa-a8ea-442b-bfcd-bd0f64cd0023', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 11, 'GPIO11', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '11', 'left', 10, NULL),
  ('200971e1-52ea-4486-9e8d-e148a7e84736', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 12, 'GPIO12', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '12', 'left', 12, NULL),
  ('8c7c15c5-6259-441a-b51e-65ec2f632939', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 13, 'GPIO13', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '13', 'left', 13, NULL),
  ('19b77dbe-063a-462d-9638-6f01d2d13e61', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 14, 'GPIO14', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '14', 'left', 14, NULL),
  ('f8fbcf41-375c-4a40-a6b8-daac8e16ecf0', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 22, 'GPIO22', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '22', 'right', 5, NULL),
  ('81163872-33fa-41e5-8e68-3baf2e64f8d3', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 23, 'GPIO23 (UART0 RX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 RX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'RX / 23', 'right', 3, 'UART0 RX'),
  ('8d8bb79a-1514-4311-89a1-7a7c2bbf3c1a', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 24, 'GPIO24 (UART0 TX)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 TX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'TX / 24', 'right', 2, 'UART0 TX'),
  ('60109778-c184-437d-af0c-1535debbf55b', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 25, 'GPIO25 (Strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot strapping pin","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, '25', 'right', 4, 'Strapping'),
  ('ded3ff48-95aa-4077-b536-7886ea268f7d', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 26, 'GPIO26 (USB D-)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '26', 'right', 8, 'USB D-'),
  ('9e4df85d-cd7f-48b0-8619-a02e757a755d', 'f2bd2610-9102-4648-8e9c-29a26047e6a7', NULL, 27, 'GPIO27 (USB D+)', '{"adc":false,"i2c":false,"pwm":true,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":true,"flash_psram_conflict":false}'::jsonb, '27', 'right', 7, 'USB D+'),
  ('b5cdbc8b-228c-428c-a0ce-2e643d9fff2e', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 0, 'GPIO0 (Onboard BOOT button)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot mode select (pull-up; LOW enters ROM download mode)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'BOOT', NULL, NULL, 'Onboard BOOT button'),
  ('4a385d47-8155-4d71-8fae-b276f828731f', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 1, 'GPIO1', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP1', 'left', 4, NULL),
  ('07aa96c2-63c5-40e6-9ac7-2fddb3aeee38', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 2, 'GPIO2', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP2', 'left', 5, NULL),
  ('cdd5aaaf-2436-4850-86fb-9ca466d32777', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 3, 'GPIO3', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"JTAG signal source select","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP3', 'left', 6, NULL),
  ('0651bce1-9fd6-49be-8ffe-0db49f0643ea', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 4, 'GPIO4', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP4', 'left', 7, NULL),
  ('f72395b8-d71a-46ce-9b73-5665f658479e', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 5, 'GPIO5', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP5', 'left', 8, NULL),
  ('a98443d7-438f-4f58-8af7-ab6e9e5ca74b', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 6, 'GPIO6', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP6', 'left', 9, NULL),
  ('05a7d7aa-1db9-4557-9194-6713ae5634df', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 7, 'GPIO7', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP7', 'right', 9, NULL),
  ('7142bc85-80f6-40a9-9f5b-5098e0258db4', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 8, 'GPIO8', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP8', 'right', 8, NULL),
  ('ecf65d4e-ea8a-45f3-b13a-e0232a19c665', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 9, 'GPIO9', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP9', 'right', 7, NULL),
  ('b554fc07-873a-4745-8d37-76536f8c3b9f', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 10, 'GPIO10', '{"adc":true,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP10', 'right', 6, NULL),
  ('82928bd0-a5aa-435b-b4e6-cbfa6a94dd0c', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 11, 'GPIO11', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP11', 'right', 5, NULL);
INSERT INTO public.board_gpio_definitions (id, board_profile_id, custom_board_profile_id, pin, label, capabilities, restrictions, board_pin_name, header_side, header_position, board_note) VALUES
  ('0c91942e-bf3b-4c4d-9ef0-79bbb678c26d', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 12, 'GPIO12', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP12', 'right', 4, NULL),
  ('ed6c8db0-c18b-4fa1-91fb-97434f8944d9', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 13, 'GPIO13', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP13', 'right', 3, NULL),
  ('634207ae-c223-4229-8517-f0c693f91f78', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 14, 'GPIO14 (Castellated bottom pad)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":true,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP14', NULL, NULL, 'Castellated bottom pad'),
  ('3dab5e6c-b335-4b29-87e1-7aa7af2205d9', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 15, 'GPIO15 (Castellated bottom pad)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP15', NULL, NULL, 'Castellated bottom pad'),
  ('2502be8a-b2c6-4e9d-a148-8603d62b9a55', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 16, 'GPIO16 (Castellated bottom pad)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP16', NULL, NULL, 'Castellated bottom pad'),
  ('6ce17145-7493-447c-bef2-f22ee4a70bf4', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 17, 'GPIO17 (Castellated bottom pad)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP17', NULL, NULL, 'Castellated bottom pad'),
  ('eafe2a85-1b49-436f-bbf9-68ca3e30f98a', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 18, 'GPIO18 (Castellated bottom pad)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP18', NULL, NULL, 'Castellated bottom pad'),
  ('c4f5b126-dd9d-4b1d-8b94-4a26ccf7611b', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 21, 'GPIO21 (Onboard WS2812 RGB LED)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP21', NULL, NULL, 'Onboard WS2812 RGB LED'),
  ('a181fcd4-98a3-44a4-a120-571c2ca65ecf', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 33, 'GPIO33 (Castellated bottom pad (Quad PSRAM free))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP33', NULL, NULL, 'Castellated bottom pad (Quad PSRAM free)'),
  ('d1ad0a1e-bedc-4685-b448-35ac688abf2a', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 34, 'GPIO34 (Castellated bottom pad (Quad PSRAM free))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP34', NULL, NULL, 'Castellated bottom pad (Quad PSRAM free)'),
  ('af8d5d1e-8b69-42ef-a230-117cd96fe775', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 35, 'GPIO35 (Castellated bottom pad (Quad PSRAM free))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP35', NULL, NULL, 'Castellated bottom pad (Quad PSRAM free)'),
  ('72dc4291-f3ec-4477-ad87-214e05c932c0', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 36, 'GPIO36 (Castellated bottom pad (Quad PSRAM free))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'GP36', NULL, NULL, 'Castellated bottom pad (Quad PSRAM free)'),
  ('fa2feaf9-d73e-4666-b992-48d2095721dd', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 43, 'GPIO43', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'TX', 'right', 1, NULL),
  ('ce2a995e-966d-4940-a946-083a4503ceca', '7d3f4dc6-189b-4a8b-a796-87ae10e6fa4e', NULL, 44, 'GPIO44', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'RX', 'right', 2, NULL),
  ('62f40bb8-f5d5-419f-bc84-ae4899762778', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 0, 'GPIO0 (FLASH boot strapping pin)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot mode select (FLASH button; LOW at reset enters UART download mode)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D3', 'right', 4, 'FLASH boot strapping pin'),
  ('9f96e726-9542-4814-89c8-06dab812b57f', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 1, 'GPIO1 (UART0 TX console)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 TX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'TX', 'right', 13, 'UART0 TX console'),
  ('5dcda1c7-a485-47d4-aeb3-2484c16eceb9', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 2, 'GPIO2 (ESP-12E onboard LED / boot strapping)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot mode strapping & onboard LED (must stay HIGH on boot)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D4', 'right', 5, 'ESP-12E onboard LED / boot strapping'),
  ('ea5ccf21-0dd7-42b9-936a-283fa1c86f8e', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 3, 'GPIO3 (UART0 RX console)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"UART0 console (UART0 RX)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'RX', 'right', 12, 'UART0 RX console'),
  ('23af243d-cb1f-49c1-b269-8ea89bd3ad6f', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 4, 'GPIO4 (Default I2C SDA (safe GPIO))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D2', 'right', 3, 'Default I2C SDA (safe GPIO)'),
  ('db28931e-f66a-4e6f-b2af-b9cb75a87acf', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 5, 'GPIO5 (Default I2C SCL (safe GPIO))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D1', 'right', 2, 'Default I2C SCL (safe GPIO)'),
  ('6b5a2496-b29c-4684-802a-f3e5367f240b', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 6, 'GPIO6 (Internal SPI Flash)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'CLK', 'left', 9, 'Internal SPI Flash'),
  ('5c900519-02e7-4a52-95a7-545426058a85', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 7, 'GPIO7 (Internal SPI Flash)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'SD0', 'left', 8, 'Internal SPI Flash'),
  ('5fb6efee-38a2-45f7-b7ab-c6891e2d5ac3', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 8, 'GPIO8 (Internal SPI Flash)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'SD1', 'left', 6, 'Internal SPI Flash'),
  ('36f40214-b85b-4f4d-8655-a56ce9e33dde', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 9, 'GPIO9 (Internal SPI Flash (avoid))', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'SD2', 'left', 5, 'Internal SPI Flash (avoid)'),
  ('976e3d78-ddac-460d-9b4f-774402c1b8f9', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 10, 'GPIO10 (Internal SPI Flash (avoid))', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'SD3', 'left', 4, 'Internal SPI Flash (avoid)');
INSERT INTO public.board_gpio_definitions (id, board_profile_id, custom_board_profile_id, pin, label, capabilities, restrictions, board_pin_name, header_side, header_position, board_note) VALUES
  ('9d0b19eb-ea5b-4b14-9bf7-2d85dfb95dec', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 11, 'GPIO11 (Internal SPI Flash)', '{"adc":false,"i2c":false,"pwm":false,"spi":false,"uart":false,"touch":false,"pull_up":false,"pull_down":false,"digital_in":false,"digital_out":false}'::jsonb, '{"reserved":true,"input_only":false,"strapping_pin":false,"reserved_reason":"Internal SPI Flash bus","usb_jtag_conflict":false,"flash_psram_conflict":true}'::jsonb, 'CMD', 'left', 7, 'Internal SPI Flash'),
  ('7189864a-5a68-4357-a2f2-8a62d05f576b', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 12, 'GPIO12 (Safe GPIO / SPI MISO)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D6', 'right', 9, 'Safe GPIO / SPI MISO'),
  ('aaf77e86-876c-49ad-bb14-1f4fa9247d35', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 13, 'GPIO13 (Safe GPIO / SPI MOSI)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D7', 'right', 10, 'Safe GPIO / SPI MOSI'),
  ('14cbd6d2-5db3-46fd-831b-2aea603b9968', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 14, 'GPIO14 (Safe GPIO / SPI CLK)', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D5', 'right', 8, 'Safe GPIO / SPI CLK'),
  ('9ec13648-d7de-423c-abc8-2ff6618afde1', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 15, 'GPIO15 (Boot strapping (pulled LOW via 10k))', '{"adc":false,"i2c":true,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":true,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":true,"strapping_note":"Boot mode strapping (must stay LOW on boot; external 10k pull-down on NodeMCU)","usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D8', 'right', 11, 'Boot strapping (pulled LOW via 10k)'),
  ('bdf29752-20fd-4128-b33d-b891aeb96760', '00a2679f-ba95-4d82-b591-f3013f457d4d', NULL, 16, 'GPIO16 (Deep-sleep wake / onboard LED (no pull-up/I2C))', '{"adc":false,"i2c":false,"pwm":true,"spi":true,"uart":true,"touch":false,"pull_up":false,"pull_down":true,"digital_in":true,"digital_out":true}'::jsonb, '{"reserved":false,"input_only":false,"strapping_pin":false,"usb_jtag_conflict":false,"flash_psram_conflict":false}'::jsonb, 'D0', 'right', 1, 'Deep-sleep wake / onboard LED (no pull-up/I2C)');

-- seed: platform_settings (1 rows)
INSERT INTO public.platform_settings (id, customer_registration_enabled, pairing_code_expiration_seconds, default_account_status, controller_heartbeat_interval_seconds, controller_offline_timeout_seconds, max_devices_per_account, max_board_instances_per_account, supported_firmware_channels, maintenance_mode, board_library_enabled, updated_by, default_timezone, firmware_downloads_enabled) VALUES
  (1, TRUE, 300, 'active', 30, 90, 100, 25, ARRAY['stable', 'beta', 'development'], FALSE, TRUE, NULL, 'UTC', TRUE);
