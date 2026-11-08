-- ============================================================================
-- HomecoreOS — 0011 automation, firmware, staff, platform ops RPCs
-- ============================================================================

create or replace function public.rpc_delete_bus(p_actor uuid, p_tenant uuid, p_bus uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_used int; v_board uuid;
begin
  perform public.assert_permission(p_actor, p_tenant, 'devices.manage');
  select user_board_id into v_board from shared_buses where id=p_bus and tenant_id=p_tenant;
  if v_board is null then raise exception 'Bus not found' using errcode='P0002'; end if;
  select count(*) into v_used from sensors where bus_id=p_bus and deleted_at is null;
  if v_used > 0 then
    raise exception 'Cannot delete a bus with % attached sensor(s)', v_used using errcode='23503';
  end if;
  delete from exclusive_allocations where bus_id=p_bus;
  delete from shared_buses where id=p_bus;
  -- Restore pin states for released bus pins using the remaining allocations.
  update board_pins bp set state = case
      when exists (select 1 from exclusive_allocations e where e.user_board_id=bp.user_board_id and e.gpio=bp.gpio)
        then 'assigned' else 'available' end
    where bp.user_board_id=v_board and not bp.restricted;
  perform public.bump_board_config(v_board);
  perform public.log_audit(p_tenant, p_actor, 'bus.delete', 'shared_bus', p_bus::text);
  return jsonb_build_object('deleted',true);
end $$;

-- ---------------------------------------------------------------------------
-- Automation
-- ---------------------------------------------------------------------------
create or replace function public.rpc_save_automation(p_actor uuid, p_tenant uuid, p_id uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_before jsonb; v_board uuid;
begin
  perform public.assert_permission(p_actor, p_tenant, 'automation.manage');
  if coalesce(jsonb_array_length(coalesce(p_data->'when','[]'::jsonb)),0) = 0 then
    raise exception 'Automation requires at least one WHEN trigger' using errcode='22023';
  end if;
  if coalesce(jsonb_array_length(coalesce(p_data->'then','[]'::jsonb)),0) = 0 then
    raise exception 'Automation requires at least one THEN action' using errcode='22023';
  end if;
  if p_id is null then
    insert into automations (tenant_id, name, description, enabled, execution, mode,
      when_config, conditions, actions, cooldown_s, created_by)
    values (p_tenant, p_data->>'name', p_data->>'description',
      coalesce((p_data->>'enabled')::boolean,true), coalesce(p_data->>'execution','cloud'),
      coalesce(p_data->>'mode','single'), p_data->'when', coalesce(p_data->'conditions','[]'::jsonb),
      p_data->'then', coalesce((p_data->>'cooldown_s')::int,0), p_actor)
    returning id into v_id;
  else
    select to_jsonb(a) into v_before from automations a where id=p_id and tenant_id=p_tenant;
    if v_before is null then raise exception 'Automation not found' using errcode='P0002'; end if;
    update automations set name=coalesce(p_data->>'name',name),
      description=coalesce(p_data->>'description',description),
      enabled=coalesce((p_data->>'enabled')::boolean,enabled),
      execution=coalesce(p_data->>'execution',execution), mode=coalesce(p_data->>'mode',mode),
      when_config=coalesce(p_data->'when',when_config),
      conditions=coalesce(p_data->'conditions',conditions), actions=coalesce(p_data->'then',actions),
      cooldown_s=coalesce((p_data->>'cooldown_s')::int,cooldown_s)
    where id=p_id and tenant_id=p_tenant;
    v_id := p_id;
  end if;
  -- Local/hybrid automations must reach every board in the workspace.
  for v_board in select id from user_boards where tenant_id=p_tenant and deleted_at is null loop
    perform public.bump_board_config(v_board);
  end loop;
  perform public.log_audit(p_tenant, p_actor, 'automation.save', 'automation', v_id::text, v_before, p_data);
  return jsonb_build_object('id',v_id);
end $$;

create or replace function public.rpc_delete_automation(p_actor uuid, p_tenant uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_permission(p_actor, p_tenant, 'automation.manage');
  delete from automations where id=p_id and tenant_id=p_tenant;
  perform public.log_audit(p_tenant, p_actor, 'automation.delete', 'automation', p_id::text);
  return jsonb_build_object('deleted',true);
end $$;

-- Cloud automation evaluation: called by the Worker on telemetry events / cron.
create or replace function public.rpc_evaluate_automations(p_tenant uuid, p_event jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record; v_trigger jsonb; v_cond jsonb; v_pass boolean; v_action jsonb;
  v_sensor sensors%rowtype; v_value numeric; v_fired jsonb := '[]'::jsonb; v_allowed boolean;
begin
  for a in select * from automations where tenant_id=p_tenant and enabled
                 and execution in ('cloud','hybrid') order by created_at loop
    v_allowed := false;
    for v_trigger in select jsonb_array_elements(a.when_config) loop
      if (v_trigger->>'kind' = 'sensor_event'
          and ((v_trigger->>'sensor_id') is null
               or (v_trigger->>'sensor_id') = (p_event->>'sensor_id'))) then
        v_allowed := true;
      elsif v_trigger->>'kind' = 'time_schedule' then
        v_allowed := true;  -- cron scheduler passes matching schedules only
      elsif v_trigger->>'kind' = 'device_state_change'
        and v_trigger->>'device_id' = p_event->>'device_id' then
        v_allowed := true;
      end if;
    end loop;
    if not v_allowed then continue; end if;
    if a.last_run_at is not null and a.cooldown_s > 0
       and a.last_run_at > now() - (a.cooldown_s || ' seconds')::interval then continue; end if;
    v_pass := true;
    for v_cond in select jsonb_array_elements(a.conditions) loop
      select * into v_sensor from sensors
        where tenant_id=p_tenant and slug=v_cond->>'sensor_slug' and deleted_at is null;
      if not found then v_pass := false; exit; end if;
      v_value := v_sensor.last_value;
      if v_value is null then v_pass := false; exit; end if;
      v_pass := v_pass and (
        (v_cond->>'op' = 'gt'  and v_value >  (v_cond->>'value')::numeric) or
        (v_cond->>'op' = 'lt'  and v_value <  (v_cond->>'value')::numeric) or
        (v_cond->>'op' = 'gte' and v_value >= (v_cond->>'value')::numeric) or
        (v_cond->>'op' = 'lte' and v_value <= (v_cond->>'value')::numeric) or
        (v_cond->>'op' = 'eq'  and v_value =  (v_cond->>'value')::numeric)
      );
      exit when not v_pass;
    end loop;
    if v_pass then
      for v_action in select jsonb_array_elements(a.actions) loop
        v_fired := v_fired || jsonb_build_array(jsonb_build_object(
          'automation_id', a.id, 'action', v_action));
      end loop;
      update automations set last_run_at=now(), last_result='success', run_count=run_count+1 where id=a.id;
      insert into automation_logs (tenant_id, automation_id, trigger_kind, status, detail)
      values (p_tenant, a.id, p_event->>'kind', 'success', p_event);
    end if;
  end loop;
  return jsonb_build_object('actions',v_fired);
end $$;

-- ---------------------------------------------------------------------------
-- Firmware releases and OTA progress (binaries live in R2)
-- ---------------------------------------------------------------------------
create or replace function public.rpc_create_firmware_release(p_actor uuid, p_tenant uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.assert_permission(p_actor, p_tenant, 'firmware.update');
  if p_data->>'r2_key' is null or p_data->>'sha256' is null or length(p_data->>'sha256') <> 64 then
    raise exception 'r2_key and a 64-char SHA-256 digest are required' using errcode='22023';
  end if;
  insert into firmware_releases (tenant_id, channel, version, chip_family, board_models, r2_key,
    size_bytes, sha256, notes, rollout_pct, mandatory, status, published_at, created_by)
  values (p_tenant, coalesce(p_data->>'channel','stable'), p_data->>'version',
    coalesce(p_data->>'chip_family','esp32'),
    coalesce(array(select jsonb_array_elements_text(coalesce(p_data->'board_models','[]'::jsonb))),'{}'),
    p_data->>'r2_key', (p_data->>'size_bytes')::bigint, p_data->>'sha256', p_data->>'notes',
    coalesce((p_data->>'rollout_pct')::smallint,100), coalesce((p_data->>'mandatory')::boolean,false),
    coalesce(p_data->>'status','draft'),
    case when coalesce(p_data->>'status','draft')='published' then now() else null end, p_actor)
  returning id into v_id;
  perform public.log_audit(p_tenant, p_actor, 'firmware.publish', 'firmware_release', v_id::text, null, p_data);
  return jsonb_build_object('id',v_id);
end $$;

create or replace function public.rpc_ota_progress(p_board uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_status text;
begin
  select tenant_id into v_tenant from user_boards where id=p_board;
  v_status := coalesce(p_payload->>'status','downloading');
  update device_firmware_history set status=v_status,
    progress=coalesce((p_payload->>'progress')::smallint,progress),
    bytes_done=coalesce((p_payload->>'bytes_done')::bigint,bytes_done),
    error=p_payload->>'error',
    finished_at=case when v_status in ('success','failed','rolled_back') then now() else null end
  where user_board_id=p_board and tenant_id=v_tenant
    and id=(select id from device_firmware_history where user_board_id=p_board order by started_at desc limit 1);
  if v_status='success' then
    update user_boards set firmware_version=p_payload->>'version', last_seen_at=now() where id=p_board;
  end if;
  return jsonb_build_object('ok',true);
end $$;

-- ---------------------------------------------------------------------------
-- Staff management
-- ---------------------------------------------------------------------------
create or replace function public.rpc_invite_staff(p_actor uuid, p_tenant uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_role text; v_id uuid;
begin
  perform public.assert_permission(p_actor, p_tenant, 'staff.manage');
  if public.tenant_role_for(p_actor,p_tenant) <> 'owner' then
    raise exception 'Only the workspace owner may invite staff' using errcode='42501';
  end if;
  v_role := coalesce(p_data->>'role_key','viewer');
  if v_role = 'owner' then raise exception 'Cannot invite another owner' using errcode='22023'; end if;
  if not exists (select 1 from roles r where r.key=v_role and (r.tenant_id is null or r.tenant_id=p_tenant)) then
    raise exception 'Unknown role' using errcode='22023';
  end if;
  insert into staff_invitations (tenant_id, email, role_key, token_hash, invited_by, message, expires_at)
  values (p_tenant, lower(p_data->>'email'), v_role, p_data->>'token_hash', p_actor,
          p_data->>'message', now() + interval '7 days')
  returning id into v_id;
  perform public.log_audit(p_tenant, p_actor, 'staff.invite', 'invitation', v_id::text, null,
    jsonb_build_object('email',p_data->>'email','role_key',v_role));
  return jsonb_build_object('id',v_id);
end $$;

create or replace function public.tenant_role_for(p_actor uuid, p_tenant uuid)
returns text language sql stable security definer set search_path = public as $$
  select role_key from tenant_members where tenant_id=p_tenant and profile_id=p_actor and status='active' limit 1
$$;

create or replace function public.rpc_update_member(p_actor uuid, p_tenant uuid, p_member uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_before jsonb;
begin
  if public.tenant_role_for(p_actor,p_tenant) <> 'owner' then
    raise exception 'Only the workspace owner may change staff permissions' using errcode='42501';
  end if;
  if p_member = (select id from tenant_members where tenant_id=p_tenant and profile_id=p_actor) then
    raise exception 'A member cannot change their own permissions' using errcode='42501';
  end if;
  select to_jsonb(m) into v_before from tenant_members m where id=p_member and tenant_id=p_tenant;
  if v_before is null then raise exception 'Member not found' using errcode='P0002'; end if;
  if p_data ? 'role_key' then
    update tenant_members set role_key=p_data->>'role_key' where id=p_member;
  end if;
  if p_data ? 'status' then
    update tenant_members set status=p_data->>'status' where id=p_member;
  end if;
  if p_data ? 'permissions' then
    delete from member_permissions where member_id=p_member;
    insert into member_permissions (tenant_id, member_id, permission_key, effect, updated_by)
    select p_tenant, p_member, e->>'key', e->>'effect', p_actor
    from jsonb_array_elements(p_data->'permissions') e;
  end if;
  if p_data ? 'access_rules' then
    delete from member_access_rules where member_id=p_member;
    insert into member_access_rules (tenant_id, member_id, scope, target_id, allowed)
    select p_tenant, p_member, e->>'scope', (e->>'target_id')::uuid, (e->>'allowed')::boolean
    from jsonb_array_elements(p_data->'access_rules') e;
  end if;
  perform public.log_audit(p_tenant, p_actor, 'staff.update', 'member', p_member::text, v_before, p_data);
  return jsonb_build_object('id',p_member);
end $$;

create or replace function public.rpc_revoke_member(p_actor uuid, p_tenant uuid, p_member uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if public.tenant_role_for(p_actor,p_tenant) <> 'owner' then
    raise exception 'Only the workspace owner may revoke staff' using errcode='42501';
  end if;
  update tenant_members set status='revoked' where id=p_member and tenant_id=p_tenant;
  delete from member_permissions where member_id=p_member;
  perform public.log_audit(p_tenant, p_actor, 'staff.revoke', 'member', p_member::text);
  return jsonb_build_object('revoked',true);
end $$;

-- ---------------------------------------------------------------------------
-- Platform owner operations (Worker verifies is_platform_admin before calls)
-- ---------------------------------------------------------------------------
create or replace function public.rpc_set_tenant_status(p_actor uuid, p_tenant uuid, p_status text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin_for(p_actor) then
    raise exception 'Platform admin required' using errcode='42501';
  end if;
  if p_status not in ('active','suspended','closed') then raise exception 'Invalid status' using errcode='22023'; end if;
  update tenants set status=p_status, suspended_reason=p_reason where id=p_tenant;
  insert into audit_logs (tenant_id, actor_id, actor_type, action, entity_type, entity_id, after)
  values (p_tenant, p_actor, 'platform_admin', 'platform.tenant.status', 'tenant', p_tenant::text,
          jsonb_build_object('status',p_status,'reason',p_reason));
  return jsonb_build_object('status',p_status);
end $$;

create or replace function public.is_platform_admin_for(p_actor uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where profile_id=p_actor)
$$;

create or replace function public.rpc_set_platform_setting(p_actor uuid, p_key text, p_value jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin_for(p_actor) then raise exception 'Platform admin required' using errcode='42501'; end if;
  insert into platform_settings (key, value, updated_by) values (p_key, p_value, p_actor)
  on conflict (key) do update set value=excluded.value, updated_by=excluded.updated_by, updated_at=now();
  insert into audit_logs (actor_id, actor_type, action, entity_type, entity_id, after)
  values (p_actor, 'platform_admin', 'platform.setting.update', 'setting', p_key,
          jsonb_build_object('key',p_key,'value',case when p_key ilike '%secret%' or p_key ilike '%token%' then '***' else p_value end));
  return jsonb_build_object('key',p_key);
end $$;

-- Snapshots are only ever created from real provider data or explicit owner input.
create or replace function public.rpc_record_usage_snapshot(p_actor uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_platform_admin_for(p_actor) then raise exception 'Platform admin required' using errcode='42501'; end if;
  if p_data->>'source' not in ('provider_api','owner_manual','provider_dashboard') then
    raise exception 'Invalid usage source' using errcode='22023';
  end if;
  insert into emqx_usage_snapshots (period_start, period_end, granularity, source,
    traffic_bytes, traffic_in_bytes, traffic_out_bytes, packets, session_minutes,
    connections_peak, messages, rule_actions, raw, recorded_by)
  values ((p_data->>'period_start')::timestamptz, (p_data->>'period_end')::timestamptz,
    coalesce(p_data->>'granularity','day'), p_data->>'source',
    (p_data->>'traffic_bytes')::bigint, (p_data->>'traffic_in_bytes')::bigint,
    (p_data->>'traffic_out_bytes')::bigint, (p_data->>'packets')::bigint,
    (p_data->>'session_minutes')::bigint, (p_data->>'connections_peak')::integer,
    (p_data->>'messages')::bigint, (p_data->>'rule_actions')::bigint,
    coalesce(p_data->'raw','{}'::jsonb), p_actor)
  on conflict (period_start, granularity, source) do update set
    traffic_bytes=excluded.traffic_bytes, traffic_in_bytes=excluded.traffic_in_bytes,
    traffic_out_bytes=excluded.traffic_out_bytes, packets=excluded.packets,
    session_minutes=excluded.session_minutes, connections_peak=excluded.connections_peak,
    messages=excluded.messages, rule_actions=excluded.rule_actions, raw=excluded.raw,
    recorded_at=now(), recorded_by=excluded.recorded_by
  returning id into v_id;
  insert into audit_logs (actor_id, actor_type, action, entity_type, entity_id, after)
  values (p_actor, 'platform_admin', 'platform.usage.record', 'usage_snapshot', v_id::text,
          jsonb_build_object('source',p_data->>'source','period_start',p_data->>'period_start'));
  return jsonb_build_object('id',v_id);
end $$;
