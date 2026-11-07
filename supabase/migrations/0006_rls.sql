-- ============================================================================
-- Helios — 0006 Row Level Security (defense-in-depth tenant isolation)
-- ============================================================================
-- The Worker authorizes every request server-side and writes with the service
-- role. RLS protects direct PostgREST/Realtime access using the user's JWT:
-- a browser can only see rows of tenants where it is an ACTIVE member.
-- ----------------------------------------------------------------------------

alter table public.profiles                enable row level security;
alter table public.platform_admins         enable row level security;
alter table public.tenants                 enable row level security;
alter table public.permissions             enable row level security;
alter table public.roles                   enable row level security;
alter table public.role_permissions        enable row level security;
alter table public.tenant_members          enable row level security;
alter table public.member_permissions      enable row level security;
alter table public.member_access_rules     enable row level security;
alter table public.staff_invitations       enable row level security;
alter table public.rooms                   enable row level security;
alter table public.board_catalog           enable row level security;
alter table public.board_catalog_versions  enable row level security;
alter table public.board_catalog_pins      enable row level security;
alter table public.user_boards             enable row level security;
alter table public.device_pairing_tokens   enable row level security;
alter table public.mqtt_credentials_metadata enable row level security;
alter table public.board_pins              enable row level security;
alter table public.shared_buses            enable row level security;
alter table public.exclusive_allocations   enable row level security;
alter table public.device_templates        enable row level security;
alter table public.devices                 enable row level security;
alter table public.sensors                 enable row level security;
alter table public.sensor_readings         enable row level security;
alter table public.switch_states           enable row level security;
alter table public.device_commands         enable row level security;
alter table public.device_configurations   enable row level security;
alter table public.automations             enable row level security;
alter table public.automation_logs         enable row level security;
alter table public.firmware_releases       enable row level security;
alter table public.device_firmware_history enable row level security;
alter table public.platform_settings       enable row level security;
alter table public.platform_secrets        enable row level security;
alter table public.emqx_usage_snapshots    enable row level security;
alter table public.emqx_sync_runs          enable row level security;
alter table public.audit_logs              enable row level security;
alter table public.notifications           enable row level security;
alter table public.system_announcements    enable row level security;
alter table public.usage_counters          enable row level security;

-- profiles: only your own row; platform admins can read all for the console.
create policy profiles_self on public.profiles for select
  using (id = current_profile_id() or public.is_platform_admin());
create policy profiles_self_update on public.profiles for update
  using (id = current_profile_id()) with check (id = current_profile_id());

-- Platform-only tables: no customer access at all. Worker uses service role.
create policy platform_admin_only_settings on public.platform_settings for select using (public.is_platform_admin());
create policy platform_admin_only_admins on public.platform_admins for select using (public.is_platform_admin());
create policy platform_admin_only_secrets on public.platform_secrets for select using (false); -- never readable over PostgREST
create policy platform_admin_only_usage on public.emqx_usage_snapshots for select using (public.is_platform_admin());
create policy platform_admin_only_sync on public.emqx_sync_runs for select using (public.is_platform_admin());
create policy platform_admin_only_audit on public.audit_logs for select
  using (public.is_platform_admin() or (tenant_id is not null and public.is_tenant_member(tenant_id)));

-- Platform catalog is public-readable (no tenant secrets in it).
create policy catalog_read on public.board_catalog for select using (true);
create policy catalog_versions_read on public.board_catalog_versions for select using (true);
create policy catalog_pins_read on public.board_catalog_pins for select using (true);
create policy permissions_read on public.permissions for select using (true);
create policy roles_read on public.roles for select using (tenant_id is null or public.is_tenant_member(tenant_id));
create policy role_permissions_read on public.role_permissions for select
  using (exists (select 1 from roles r where r.id = role_id and (r.tenant_id is null or public.is_tenant_member(r.tenant_id))));
create policy announcements_read on public.system_announcements for select using (true);
create policy device_templates_read on public.device_templates for select
  using (tenant_id is null or public.is_tenant_member(tenant_id));
create policy firmware_read on public.firmware_releases for select
  using (tenant_id is null or public.is_tenant_member(tenant_id));

-- Tenants: members see their own workspace only.
create policy tenants_member on public.tenants for select
  using (public.is_tenant_member(id) or public.is_platform_admin());

-- Membership rows: visible to members of the same tenant.
create policy members_read on public.tenant_members for select
  using (public.is_tenant_member(tenant_id));
create policy member_perms_read on public.member_permissions for select
  using (public.is_tenant_member(tenant_id));
create policy member_rules_read on public.member_access_rules for select
  using (public.is_tenant_member(tenant_id));
create policy invitations_read on public.staff_invitations for select
  using (public.is_tenant_member(tenant_id) and public.tenant_role(tenant_id) = 'owner');

-- Generic tenant tables: full read for active members.
-- Writes are additionally gated by permission where a matching key exists.
create policy rooms_rw on public.rooms for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'rooms.manage') or public.tenant_role(tenant_id) = 'owner');

create policy boards_rw on public.user_boards for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'boards.manage') or public.tenant_role(tenant_id) = 'owner');

create policy board_pins_rw on public.board_pins for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'boards.manage') or public.tenant_role(tenant_id) = 'owner');

create policy pairing_tokens_rw on public.device_pairing_tokens for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'devices.manage') or public.tenant_role(tenant_id) = 'owner');

create policy mqtt_creds_read on public.mqtt_credentials_metadata for select
  using (false); -- credential hashes are never exposed to browsers, even tenant owners

create policy buses_rw on public.shared_buses for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'devices.manage') or public.tenant_role(tenant_id) = 'owner');

create policy allocations_rw on public.exclusive_allocations for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'devices.manage') or public.tenant_role(tenant_id) = 'owner');

create policy devices_rw on public.devices for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'devices.manage') or public.tenant_role(tenant_id) = 'owner');

create policy sensors_rw on public.sensors for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'devices.manage') or public.tenant_role(tenant_id) = 'owner');

create policy readings_read on public.sensor_readings for select using (public.is_tenant_member(tenant_id));
create policy switch_states_read on public.switch_states for select using (public.is_tenant_member(tenant_id));
create policy device_commands_read on public.device_commands for select using (public.is_tenant_member(tenant_id));
create policy configs_read on public.device_configurations for select using (public.is_tenant_member(tenant_id));

create policy automations_rw on public.automations for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'automation.manage') or public.tenant_role(tenant_id) = 'owner');
create policy automation_logs_read on public.automation_logs for select using (public.is_tenant_member(tenant_id));
create policy fw_history_read on public.device_firmware_history for select using (public.is_tenant_member(tenant_id));
create policy notifications_read on public.notifications for select using (public.is_tenant_member(tenant_id));
create policy usage_counters_read on public.usage_counters for select using (public.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- PostgREST roles. Tables with no explicit grant still allow service_role
-- (bypasses RLS) — that is the only path the Worker uses for privileged writes.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant select on all tables in schema public to anon, authenticated, service_role;
grant insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
revoke all on public.platform_secrets from anon, authenticated;
revoke all on public.mqtt_credentials_metadata from anon, authenticated;
revoke all on public.member_permissions, public.member_access_rules, public.staff_invitations,
            public.device_pairing_tokens, public.platform_settings, public.platform_admins,
            public.emqx_usage_snapshots, public.emqx_sync_runs, public.usage_counters,
            public.audit_logs from anon, authenticated;
grant execute on function public.current_profile_id(), public.is_tenant_member(uuid),
  public.tenant_role(uuid), public.has_permission(uuid,text), public.is_platform_admin(),
  public.can_access_room(uuid,uuid) to anon, authenticated, service_role;
-- allocation functions are callable only by the service role (Worker)
revoke execute on function public.assign_pin_exclusive(uuid,uuid,integer,text,uuid,text,uuid),
  public.release_allocations_for_owner(text,uuid), public.handle_new_user(),
  public.member_id_for(uuid) from public, anon, authenticated;
grant execute on function public.assign_pin_exclusive(uuid,uuid,integer,text,uuid,text,uuid),
  public.release_allocations_for_owner(text,uuid), public.member_id_for(uuid) to service_role;

-- Realtime: only safe, tenant-scoped tables. Supabase applies RLS to changes.
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array[
      'rooms','user_boards','board_pins','shared_buses','exclusive_allocations',
      'devices','sensors','sensor_readings','device_commands','switch_states',
      'automations','device_firmware_history','notifications','audit_logs'
    ] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
