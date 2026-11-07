-- ============================================================================
-- Helios — 0012 request context helpers used by the Worker on every request
-- ============================================================================

create or replace function public.rpc_context(p_actor uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_tenant uuid;
begin
  select m.tenant_id into v_tenant from tenant_members m
    join tenants t on t.id=m.tenant_id and t.status='active'
    where m.profile_id=p_actor and m.status='active'
    order by case when m.role_key='owner' then 0 else 1 end, m.created_at limit 1;
  if v_tenant is null then
    return jsonb_build_object('tenant',null,'platform_admin',public.is_platform_admin_for(p_actor));
  end if;
  select jsonb_build_object(
    'tenant', to_jsonb(t),
    'member', to_jsonb(m),
    'role', m.role_key,
    'permissions', coalesce((
      select jsonb_agg(p.key order by p.sort_order) from permissions p
      where public.permission_granted(p_actor, v_tenant, p.key)), '[]'::jsonb),
    'overrides', coalesce((
      select jsonb_agg(jsonb_build_object('key',mp.permission_key,'effect',mp.effect))
      from member_permissions mp where mp.member_id=m.id), '[]'::jsonb),
    'access_rules', coalesce((
      select jsonb_agg(to_jsonb(r)) from member_access_rules r where r.member_id=m.id), '[]'::jsonb),
    'platform_admin', public.is_platform_admin_for(p_actor)
  ) into v
  from tenants t join tenant_members m on m.tenant_id=t.id
  where t.id=v_tenant and m.profile_id=p_actor;
  return v;
end $$;

create or replace function public.rpc_check_permission(p_actor uuid, p_tenant uuid, p_permission text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('allowed', public.permission_granted(p_actor,p_tenant,p_permission))
$$;

create or replace function public.rpc_owner_overview()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'accounts', (select count(*) from tenants),
    'active_accounts', (select count(*) from tenants where status='active'),
    'suspended_accounts', (select count(*) from tenants where status='suspended'),
    'boards', (select count(*) from user_boards where deleted_at is null),
    'boards_online', (select count(*) from user_boards where deleted_at is null and status='online'),
    'boards_offline', (select count(*) from user_boards where deleted_at is null and status in ('offline','unclaimed','provisioning','disabled')),
    'devices', (select count(*) from devices where deleted_at is null),
    'sensors', (select count(*) from sensors where deleted_at is null),
    'rooms', (select count(*) from rooms where archived_at is null),
    'staff', (select count(*) from tenant_members where status='active' and role_key<>'owner'),
    'commands_24h', (select count(*) from device_commands where created_at > now() - interval '24 hours'),
    'telemetry_24h', (select count(*) from sensor_readings where received_at > now() - interval '24 hours')
  )
$$;

create or replace function public.rpc_tenant_overview(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'rooms', (select count(*) from rooms where tenant_id=p_tenant and archived_at is null),
    'boards', (select count(*) from user_boards where tenant_id=p_tenant and deleted_at is null),
    'boards_online', (select count(*) from user_boards where tenant_id=p_tenant and deleted_at is null and status='online'),
    'devices', (select count(*) from devices where tenant_id=p_tenant and deleted_at is null),
    'devices_on', (select count(*) from devices where tenant_id=p_tenant and deleted_at is null and reported_state='on'),
    'sensors', (select count(*) from sensors where tenant_id=p_tenant and deleted_at is null),
    'automations', (select count(*) from automations where tenant_id=p_tenant and enabled),
    'staff', (select count(*) from tenant_members where tenant_id=p_tenant and status='active'),
    'commands_24h', (select count(*) from device_commands where tenant_id=p_tenant and created_at > now()-interval '24 hours'),
    'readings_24h', (select count(*) from sensor_readings where tenant_id=p_tenant and received_at > now()-interval '24 hours'),
    'pending_commands', (select count(*) from device_commands where tenant_id=p_tenant and status in ('queued','published'))
  )
$$;
