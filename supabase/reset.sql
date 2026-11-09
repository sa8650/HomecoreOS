-- ===========================================================================
-- HomecoreOS — Supabase reset
-- ===========================================================================
--
-- This file removes ONLY the objects HomecoreOS owns, so the fresh
-- supabase/schema.sql can be installed on top. It deliberately does NOT:
--
--   * drop the public schema,
--   * drop any Supabase-managed object (auth, storage, realtime, graphql,
--     extensions, vault, supabase_* schemas),
--   * touch any extension,
--   * touch an object that does not belong to this application.
--
-- Everything it drops is listed explicitly below, by name. If an object does
-- not exist, the drop is skipped silently, so the file is safe to run on a
-- project that never had HomecoreOS installed, and safe to run twice.
--
-- ORDER:
--   1. supabase/reset.sql   - this file
--   2. supabase/schema.sql  - create the new schema
--   3. verify the installation
--   4. create the first Platform Owner through the signup flow
--
-- DESTRUCTIVE: every HomecoreOS account, home, controller, device, sensor
-- and firmware release is removed. That is intended: this is a fresh start.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Realtime publication entries added by the HomecoreOS schema
-- ---------------------------------------------------------------------------
-- The publication itself belongs to Supabase, so only the tables HomecoreOS
-- added to it are removed.
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array[
      'rooms','user_boards','board_pins','shared_buses','exclusive_allocations',
      'devices','sensors','sensor_readings','device_commands','switch_states',
      'automations','device_firmware_history','notifications','audit_logs'
    ] loop
      if exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime drop table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Policies on HomecoreOS tables
-- ---------------------------------------------------------------------------
-- Policies are dropped with their table, but they are listed explicitly so
-- that a policy left behind by an older schema version is also removed.

do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in (
        -- authentication
        'app_users','app_sessions','app_login_attempts','app_recovery_codes',
        'app_auth_config','app_roles','app_permissions','app_role_permissions',
        'app_user_roles','app_security_events',
        -- identity and homes
        'profiles','platform_admins','tenants','permissions','roles',
        'role_permissions','tenant_members','member_permissions',
        'member_access_rules','staff_invitations',
        -- hardware
        'board_catalog','board_catalog_versions','board_catalog_pins',
        'user_boards','board_pins','shared_buses','exclusive_allocations',
        'device_pairing_tokens','mqtt_credentials_metadata',
        -- customer data
        'rooms','device_templates','devices','sensors','sensor_readings',
        'switch_states','device_commands','device_configurations',
        'automations','automation_logs',
        -- firmware
        'firmware_releases','device_firmware_history','firmware_storage_tests',
        -- platform
        'platform_settings','emqx_usage_snapshots','emqx_sync_runs',
        'audit_logs','notifications','system_announcements','usage_counters'
      )
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Functions and triggers owned by HomecoreOS
-- ---------------------------------------------------------------------------
-- Triggers are dropped with their table, but they are listed explicitly so a
-- trigger attached to a table that is not being dropped is also removed.

do $$
declare r record;
begin
  for r in
    select n.nspname as schema_name, c.relname as table_name, t.tgname as trigger_name
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and not t.tgisinternal
      and c.relname in (
        'app_users','profiles','tenants','tenant_members','board_catalog',
        'user_boards','rooms','devices','sensors','automations','firmware_releases'
      )
  loop
    execute format('drop trigger if exists %I on %I.%I', r.trigger_name, r.schema_name, r.table_name);
  end loop;
end $$;

-- The functions below are created by supabase/schema.sql. Dropping them with
-- CASCADE removes the triggers that depend on them as well.
drop function if exists public.tg_set_updated_at() cascade;
drop function if exists public.current_profile_id() cascade;
drop function if exists public.tg_seed_board_pins() cascade;
drop function if exists public.tg_guard_member_escalation() cascade;

drop function if exists public.is_platform_admin_for(uuid) cascade;
drop function if exists public.is_platform_admin() cascade;
drop function if exists public.is_tenant_member(uuid) cascade;
drop function if exists public.tenant_role(uuid) cascade;
drop function if exists public.tenant_role_for(uuid, uuid) cascade;
drop function if exists public.member_id_for(uuid) cascade;
drop function if exists public.has_permission(uuid, text) cascade;
drop function if exists public.permission_granted(uuid, uuid, text) cascade;
drop function if exists public.assert_permission(uuid, uuid, text) cascade;
drop function if exists public.assert_member(uuid, uuid) cascade;
drop function if exists public.can_access_room(uuid, uuid) cascade;

drop function if exists public.log_audit(uuid, uuid, text, text, text, jsonb, jsonb, text) cascade;
drop function if exists public.build_board_config(uuid) cascade;
drop function if exists public.bump_board_config(uuid) cascade;
drop function if exists public.assign_pin_exclusive(uuid, uuid, integer, text, uuid, text, uuid) cascade;
drop function if exists public.release_allocations_for_owner(text, uuid) cascade;

drop function if exists public.rpc_auth_hash_secret(text) cascade;
drop function if exists public.rpc_auth_verify_secret(text, text) cascade;
drop function if exists public.rpc_auth_register(text, text, jsonb) cascade;
drop function if exists public.rpc_auth_lookup(text) cascade;
drop function if exists public.rpc_auth_guard(text, text, text, text) cascade;
drop function if exists public.rpc_auth_session_create(uuid, text, text, text) cascade;
drop function if exists public.rpc_auth_session_resolve(text) cascade;
drop function if exists public.rpc_auth_session_revoke(text) cascade;
drop function if exists public.rpc_auth_sessions(uuid, text) cascade;
drop function if exists public.rpc_auth_session_revoke_id(uuid, uuid) cascade;
drop function if exists public.rpc_auth_session_revoke_any(uuid) cascade;
drop function if exists public.rpc_auth_update_secret(uuid, text, text) cascade;
drop function if exists public.rpc_auth_recovery_codes_set(uuid, jsonb) cascade;
drop function if exists public.rpc_auth_recovery_redeem(text, text, text) cascade;
drop function if exists public.rpc_auth_config() cascade;
drop function if exists public.rpc_auth_config_set(text, integer) cascade;
drop function if exists public.rpc_auth_platform_permissions(uuid) cascade;
drop function if exists public.rpc_auth_accounts() cascade;
drop function if exists public.rpc_auth_account_status(uuid, text) cascade;
drop function if exists public.rpc_auth_sessions_revoke_other(uuid, text) cascade;
drop function if exists public.rpc_auth_guard_reset() cascade;
drop function if exists public.rpc_auth_guard_reset_for(text) cascade;
drop function if exists public.rpc_auth_health() cascade;
drop function if exists public.rpc_auth_security_events(integer) cascade;
drop function if exists public.rpc_auth_all_sessions() cascade;
drop function if exists public.rpc_auth_roles() cascade;

drop function if exists public.rpc_context(uuid) cascade;
drop function if exists public.rpc_check_permission(uuid, uuid, text) cascade;
drop function if exists public.rpc_owner_overview() cascade;
drop function if exists public.rpc_tenant_overview(uuid) cascade;
drop function if exists public.rpc_create_room(uuid, uuid, jsonb) cascade;
drop function if exists public.rpc_update_room(uuid, uuid, uuid, jsonb) cascade;
drop function if exists public.rpc_delete_room(uuid, uuid, uuid, text) cascade;
drop function if exists public.rpc_create_bus(uuid, uuid, jsonb) cascade;
drop function if exists public.rpc_delete_bus(uuid, uuid, uuid) cascade;
drop function if exists public.rpc_create_device(uuid, uuid, jsonb) cascade;
drop function if exists public.rpc_update_device(uuid, uuid, uuid, jsonb) cascade;
drop function if exists public.rpc_delete_device(uuid, uuid, uuid) cascade;
drop function if exists public.rpc_restore_device(uuid, uuid, uuid) cascade;
drop function if exists public.rpc_create_sensor(uuid, uuid, jsonb) cascade;
drop function if exists public.rpc_delete_sensor(uuid, uuid, uuid) cascade;
drop function if exists public.rpc_issue_command(uuid, uuid, uuid, uuid, jsonb) cascade;
drop function if exists public.rpc_mark_command_published(uuid, text) cascade;
drop function if exists public.rpc_expire_commands() cascade;
drop function if exists public.rpc_ingest_telemetry(uuid, jsonb) cascade;
drop function if exists public.rpc_ingest_state(uuid, jsonb) cascade;
drop function if exists public.rpc_ack_config(uuid, jsonb) cascade;
drop function if exists public.rpc_board_from_client(text) cascade;
drop function if exists public.rpc_board_from_device(uuid, text) cascade;

drop function if exists public.rpc_pairing_issue(uuid, uuid, text, text, text, jsonb) cascade;
drop function if exists public.rpc_pairing_cancel(uuid, uuid, uuid) cascade;
drop function if exists public.rpc_pairing_progress(uuid, uuid, uuid) cascade;
drop function if exists public.rpc_pairing_redeem(text, text, text, text, text, text, jsonb, text) cascade;
drop function if exists public.rpc_pairing_record_failure(text) cascade;
drop function if exists public.rpc_pairing_address_reset(text) cascade;
drop function if exists public.rpc_pairing_cleanup() cascade;

drop function if exists public.rpc_firmware_latest(uuid) cascade;
drop function if exists public.rpc_firmware_overview() cascade;
drop function if exists public.rpc_firmware_set_status(uuid, uuid, text) cascade;
drop function if exists public.rpc_firmware_retire(uuid, uuid, text) cascade;
drop function if exists public.rpc_firmware_rollback_target(uuid, uuid, uuid) cascade;
drop function if exists public.rpc_ota_report(uuid, jsonb) cascade;
drop function if exists public.rpc_ota_progress(uuid, jsonb) cascade;
drop function if exists public.version_lt(text, text) cascade;

drop function if exists public.rpc_save_automation(uuid, uuid, uuid, jsonb) cascade;
drop function if exists public.rpc_delete_automation(uuid, uuid, uuid) cascade;
drop function if exists public.rpc_evaluate_automations(uuid, jsonb) cascade;
drop function if exists public.rpc_invite_staff(uuid, uuid, jsonb) cascade;
drop function if exists public.rpc_update_member(uuid, uuid, uuid, jsonb) cascade;
drop function if exists public.rpc_revoke_member(uuid, uuid, uuid) cascade;
drop function if exists public.rpc_set_tenant_status(uuid, uuid, text, text) cascade;
drop function if exists public.rpc_set_platform_setting(uuid, text, jsonb) cascade;
drop function if exists public.rpc_record_usage_snapshot(uuid, jsonb) cascade;

-- ---------------------------------------------------------------------------
-- 4. HomecoreOS tables
-- ---------------------------------------------------------------------------
-- Dropped in dependency order. CASCADE is used so a leftover foreign key from
-- an older schema version cannot block the reset.

-- Firmware and update history.
drop table if exists public.device_firmware_history cascade;
drop table if exists public.firmware_releases cascade;
drop table if exists public.firmware_storage_tests cascade;

-- Customer data.
drop table if exists public.automation_logs cascade;
drop table if exists public.automations cascade;
drop table if exists public.device_configurations cascade;
drop table if exists public.device_commands cascade;
drop table if exists public.switch_states cascade;
drop table if exists public.sensor_readings cascade;
drop table if exists public.sensors cascade;
drop table if exists public.devices cascade;
drop table if exists public.device_templates cascade;
drop table if exists public.rooms cascade;

-- Hardware.
drop table if exists public.mqtt_credentials_metadata cascade;
drop table if exists public.device_pairing_tokens cascade;
drop table if exists public.exclusive_allocations cascade;
drop table if exists public.shared_buses cascade;
drop table if exists public.board_pins cascade;
drop table if exists public.user_boards cascade;
drop table if exists public.board_catalog_pins cascade;
drop table if exists public.board_catalog_versions cascade;
drop table if exists public.board_catalog cascade;

-- Homes, members and staff.
drop table if exists public.staff_invitations cascade;
drop table if exists public.member_access_rules cascade;
drop table if exists public.member_permissions cascade;
drop table if exists public.tenant_members cascade;
drop table if exists public.role_permissions cascade;
drop table if exists public.roles cascade;
drop table if exists public.permissions cascade;
drop table if exists public.tenants cascade;
drop table if exists public.platform_admins cascade;
drop table if exists public.profiles cascade;

-- Platform.
drop table if exists public.usage_counters cascade;
drop table if exists public.system_announcements cascade;
drop table if exists public.notifications cascade;
drop table if exists public.audit_logs cascade;
drop table if exists public.emqx_sync_runs cascade;
drop table if exists public.emqx_usage_snapshots cascade;
drop table if exists public.platform_settings cascade;

-- Authentication.
drop table if exists public.app_security_events cascade;
drop table if exists public.app_user_roles cascade;
drop table if exists public.app_role_permissions cascade;
drop table if exists public.app_permissions cascade;
drop table if exists public.app_roles cascade;
drop table if exists public.app_auth_config cascade;
drop table if exists public.app_recovery_codes cascade;
drop table if exists public.app_login_attempts cascade;
drop table if exists public.app_sessions cascade;
drop table if exists public.app_users cascade;

-- ---------------------------------------------------------------------------
-- 5. The temporary table an earlier schema version used
-- ---------------------------------------------------------------------------
-- It was never part of the application and is not recreated by the new
-- schema. It is dropped here only if it actually exists.
drop table if exists public.app_user_credentials cascade;

-- ---------------------------------------------------------------------------
-- 6. Leftover objects from earlier schema versions
-- ---------------------------------------------------------------------------
-- These were part of the broken schema and are not in the new one. The drops
-- are conditional, so they are no-ops on a project that never had them.
drop table if exists public.handle_new_user_legacy cascade;
drop function if exists public.handle_new_user() cascade;

-- ===========================================================================
-- Reset complete. Run supabase/schema.sql next.
-- ===========================================================================
