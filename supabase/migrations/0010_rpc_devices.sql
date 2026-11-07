-- ============================================================================
-- Helios — 0010 devices, sensors, commands, telemetry ingest
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Device (switch) creation: transactional pin allocation + config version bump.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_create_device(p_actor uuid, p_tenant uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_board uuid; v_room uuid; v_gpio integer; v_func text; v_version integer;
  v_slug text; v_phys integer;
begin
  perform public.assert_permission(p_actor, p_tenant, 'devices.manage');
  v_board := (p_data->>'user_board_id')::uuid;
  if not exists (select 1 from user_boards where id=v_board and tenant_id=p_tenant and deleted_at is null) then
    raise exception 'Controller board not found in this workspace' using errcode = '42501';
  end if;
  if (p_data->>'room_id') is not null then
    v_room := (p_data->>'room_id')::uuid;
    if not exists (select 1 from rooms where id=v_room and tenant_id=p_tenant) then
      raise exception 'Room not found in this workspace' using errcode = '42501';
    end if;
  end if;
  v_slug := coalesce(p_data->>'slug', lower(regexp_replace(p_data->>'name','[^a-zA-Z0-9]+','-','g')) || '-' || substr(gen_random_uuid()::text,1,8));
  v_gpio := (p_data->>'output_gpio')::int;
  v_phys := (p_data->>'physical_input_gpio')::int;
  v_func := case when p_data->>'interface' = 'pwm' then 'pwm' else 'output' end;

  insert into devices (tenant_id, room_id, user_board_id, name, slug, device_type, icon,
    output_gpio, interface, interface_config, active_low, initial_state, pulse_ms,
    physical_input_gpio, power_rating_w, metering, automation_enabled, reported_state, created_by)
  values (p_tenant, v_room, v_board, p_data->>'name', v_slug,
    coalesce(p_data->>'device_type','relay'), coalesce(p_data->>'icon','power'),
    v_gpio, coalesce(p_data->>'interface','gpio'), coalesce(p_data->'interface_config','{}'::jsonb),
    coalesce((p_data->>'active_low')::boolean,false), coalesce(p_data->>'initial_state','off'),
    (p_data->>'pulse_ms')::int, v_phys, (p_data->>'power_rating_w')::numeric,
    coalesce(p_data->'metering','{}'::jsonb), coalesce((p_data->>'automation_enabled')::boolean,true),
    'unknown', p_actor)
  returning id into v_id;

  if v_gpio is not null then
    perform public.assign_pin_exclusive(p_tenant, v_board, v_gpio, 'device', v_id, v_func);
  end if;
  if v_phys is not null then
    perform public.assign_pin_exclusive(p_tenant, v_board, v_phys, 'device', v_id, 'input');
  end if;
  v_version := public.bump_board_config(v_board);
  perform public.log_audit(p_tenant, p_actor, 'device.create', 'device', v_id::text, null, p_data);
  return jsonb_build_object('id', v_id, 'slug', v_slug, 'config_version', v_version);
end $$;

create or replace function public.rpc_update_device(p_actor uuid, p_tenant uuid, p_device uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_before jsonb; v_gpio integer; v_old_gpio integer; v_board uuid; v_version integer;
begin
  perform public.assert_permission(p_actor, p_tenant, 'devices.manage');
  select to_jsonb(d), output_gpio, user_board_id into v_before, v_old_gpio, v_board
    from devices d where id=p_device and tenant_id=p_tenant and deleted_at is null;
  if v_before is null then raise exception 'Device not found' using errcode='P0002'; end if;

  v_gpio := case when p_data ? 'output_gpio' then (p_data->>'output_gpio')::int else v_old_gpio end;
  if v_gpio is distinct from v_old_gpio then
    perform public.release_allocations_for_owner('device', p_device);
    if v_gpio is not null then
      perform public.assign_pin_exclusive(p_tenant, v_board, v_gpio, 'device', p_device,
        case when coalesce(p_data->>'interface', v_before->>'interface')='pwm' then 'pwm' else 'output' end);
    end if;
  end if;

  update devices set
    name = coalesce(p_data->>'name', name),
    icon = coalesce(p_data->>'icon', icon),
    device_type = coalesce(p_data->>'device_type', device_type),
    room_id = case when p_data ? 'room_id' then (p_data->>'room_id')::uuid else room_id end,
    output_gpio = v_gpio,
    interface = coalesce(p_data->>'interface', interface),
    active_low = coalesce((p_data->>'active_low')::boolean, active_low),
    initial_state = coalesce(p_data->>'initial_state', initial_state),
    pulse_ms = coalesce((p_data->>'pulse_ms')::int, pulse_ms),
    power_rating_w = coalesce((p_data->>'power_rating_w')::numeric, power_rating_w),
    automation_enabled = coalesce((p_data->>'automation_enabled')::boolean, automation_enabled)
  where id=p_device and tenant_id=p_tenant;
  v_version := public.bump_board_config(v_board);
  perform public.log_audit(p_tenant, p_actor, 'device.update', 'device', p_device::text, v_before, p_data);
  return jsonb_build_object('id', p_device, 'config_version', v_version);
end $$;

-- Soft delete: release pins only AFTER the delete commits inside this transaction.
create or replace function public.rpc_delete_device(p_actor uuid, p_tenant uuid, p_device uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_board uuid; v_version integer; v_before jsonb;
begin
  perform public.assert_permission(p_actor, p_tenant, 'devices.manage');
  select to_jsonb(d), user_board_id into v_before, v_board from devices d
    where id=p_device and tenant_id=p_tenant and deleted_at is null;
  if v_before is null then raise exception 'Device not found' using errcode='P0002'; end if;
  update devices set deleted_at = now() where id=p_device and tenant_id=p_tenant;
  perform public.release_allocations_for_owner('device', p_device);
  v_version := public.bump_board_config(v_board);
  perform public.log_audit(p_tenant, p_actor, 'device.delete', 'device', p_device::text, v_before, null);
  return jsonb_build_object('deleted', true, 'config_version', v_version);
end $$;

-- Restore revalidates pin availability before applying the old configuration.
create or replace function public.rpc_restore_device(p_actor uuid, p_tenant uuid, p_device uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v devices%rowtype; v_version integer;
begin
  perform public.assert_permission(p_actor, p_tenant, 'devices.manage');
  select * into v from devices where id=p_device and tenant_id=p_tenant and deleted_at is not null;
  if not found then raise exception 'No deleted device to restore' using errcode='P0002'; end if;
  if v.output_gpio is not null then
    perform public.assign_pin_exclusive(p_tenant, v.user_board_id, v.output_gpio, 'device', v.id,
      case when v.interface='pwm' then 'pwm' else 'output' end);
  end if;
  if v.physical_input_gpio is not null then
    perform public.assign_pin_exclusive(p_tenant, v.user_board_id, v.physical_input_gpio, 'device', v.id, 'input');
  end if;
  update devices set deleted_at = null, reported_state='unknown' where id=p_device;
  v_version := public.bump_board_config(v.user_board_id);
  perform public.log_audit(p_tenant, p_actor, 'device.restore', 'device', p_device::text);
  return jsonb_build_object('restored', true, 'config_version', v_version);
end $$;

-- ---------------------------------------------------------------------------
-- Sensors. Exclusive pins OR explicit shared bus membership.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_create_sensor(p_actor uuid, p_tenant uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_board uuid; v_bus uuid; v_gpio integer; v_slug text; v_version integer;
begin
  perform public.assert_permission(p_actor, p_tenant, 'devices.manage');
  v_board := (p_data->>'user_board_id')::uuid;
  if not exists (select 1 from user_boards where id=v_board and tenant_id=p_tenant and deleted_at is null) then
    raise exception 'Controller board not found in this workspace' using errcode='42501';
  end if;
  if (p_data->>'room_id') is not null and not exists (
    select 1 from rooms where id=(p_data->>'room_id')::uuid and tenant_id=p_tenant) then
    raise exception 'Room not found in this workspace' using errcode='42501';
  end if;
  v_gpio := (p_data->>'gpio')::int;
  v_bus := (p_data->>'bus_id')::uuid;
  if v_bus is not null and not exists (
    select 1 from shared_buses where id=v_bus and user_board_id=v_board and tenant_id=p_tenant) then
    raise exception 'Bus does not belong to this board' using errcode='42501';
  end if;
  if v_bus is null and v_gpio is null and p_data->>'interface' <> 'virtual' then
    raise exception 'A GPIO or a shared bus is required' using errcode='22023';
  end if;
  v_slug := coalesce(p_data->>'slug', lower(regexp_replace(p_data->>'name','[^a-zA-Z0-9]+','-','g')) || '-' || substr(gen_random_uuid()::text,1,8));
  insert into sensors (tenant_id, room_id, user_board_id, name, slug, category, sensor_model,
    interface, gpio, bus_id, i2c_address, unit, decimals, min_valid, max_valid,
    sampling_interval_s, reporting_interval_s, report_on_change, delta_threshold,
    thresholds, topic_suffix, payload_path, transform, enabled, created_by)
  values (p_tenant, (p_data->>'room_id')::uuid, v_board, p_data->>'name', v_slug,
    coalesce(p_data->>'category','custom'), p_data->>'sensor_model',
    coalesce(p_data->>'interface','gpio'), v_gpio, v_bus, p_data->>'i2c_address',
    coalesce(p_data->>'unit','celsius'), coalesce((p_data->>'decimals')::smallint,1),
    (p_data->>'min_valid')::numeric, (p_data->>'max_valid')::numeric,
    coalesce((p_data->>'sampling_interval_s')::int,60), coalesce((p_data->>'reporting_interval_s')::int,60),
    coalesce((p_data->>'report_on_change')::boolean,true), (p_data->>'delta_threshold')::numeric,
    coalesce(p_data->'thresholds','{}'::jsonb), p_data->>'topic_suffix',
    coalesce(p_data->>'payload_path','sensors.'||v_slug||'.value'),
    coalesce(p_data->'transform','{}'::jsonb), true, p_actor)
  returning id into v_id;

  -- Exclusive GPIO sensors (ADC / single-wire) claim their pin transactionally.
  -- Bus sensors (I2C/SPI/UART) do NOT: their pins are owned by the shared bus.
  if v_bus is null and v_gpio is not null and (p_data->>'interface') <> 'virtual' then
    perform public.assign_pin_exclusive(p_tenant, v_board, v_gpio, 'sensor', v_id,
      case when (p_data->>'interface')='adc' then 'adc' else 'input' end);
  end if;
  v_version := public.bump_board_config(v_board);
  perform public.log_audit(p_tenant, p_actor, 'sensor.create', 'sensor', v_id::text, null, p_data);
  return jsonb_build_object('id', v_id, 'slug', v_slug, 'config_version', v_version);
end $$;

create or replace function public.rpc_delete_sensor(p_actor uuid, p_tenant uuid, p_sensor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_board uuid; v_version integer;
begin
  perform public.assert_permission(p_actor, p_tenant, 'devices.manage');
  select user_board_id into v_board from sensors where id=p_sensor and tenant_id=p_tenant and deleted_at is null;
  if v_board is null then raise exception 'Sensor not found' using errcode='P0002'; end if;
  update sensors set deleted_at=now() where id=p_sensor and tenant_id=p_tenant;
  perform public.release_allocations_for_owner('sensor', p_sensor);
  v_version := public.bump_board_config(v_board);
  perform public.log_audit(p_tenant, p_actor, 'sensor.delete', 'sensor', p_sensor::text);
  return jsonb_build_object('deleted', true, 'config_version', v_version);
end $$;

-- ---------------------------------------------------------------------------
-- Commands: unique id, TTL, idempotency, ack handling.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_issue_command(p_actor uuid, p_tenant uuid, p_board uuid, p_component_id uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_expires timestamptz; v_key text; v_existing jsonb; v_ttl integer;
begin
  perform public.assert_permission(p_actor, p_tenant, 'devices.control');
  if not exists (select 1 from user_boards where id=p_board and tenant_id=p_tenant and deleted_at is null) then
    raise exception 'Board not found in this workspace' using errcode='42501';
  end if;
  if p_component_id is not null and not exists (
    select 1 from devices where id=p_component_id and tenant_id=p_tenant and user_board_id=p_board and deleted_at is null) then
    raise exception 'Device not found on this board' using errcode='42501';
  end if;
  v_ttl := coalesce((select value::int from platform_settings where key='security.command_ttl_seconds'),30);
  v_key := p_data->>'idempotency_key';
  if v_key is not null then
    select to_jsonb(c) into v_existing from device_commands c
      where tenant_id=p_tenant and idempotency_key=v_key and created_at > now() - interval '5 minutes';
    if v_existing is not null then
      return jsonb_build_object('idempotent', true, 'command', v_existing);
    end if;
  end if;
  -- Rate limit per tenant per minute.
  insert into usage_counters (tenant_id, bucket, metric, value)
  values (p_tenant, date_trunc('minute', now()), 'commands', 1)
  on conflict (tenant_id, bucket, metric) do update set value = usage_counters.value + 1;
  if (select value from usage_counters where tenant_id=p_tenant and bucket=date_trunc('minute',now()) and metric='commands') >
     coalesce((select value::int from platform_settings where key='security.cmd_rate_limit_per_minute'),60) then
    raise exception 'Command rate limit exceeded' using errcode='42901';
  end if;

  insert into device_commands (id, tenant_id, user_board_id, component_type, component_id, action,
    payload, actor_id, idempotency_key, expires_at, status)
  values (gen_random_uuid(), p_tenant, p_board, coalesce(p_data->>'component_type','device'),
    p_component_id, p_data->>'action', coalesce(p_data->'payload','{}'::jsonb), p_actor, v_key,
    now() + (v_ttl || ' seconds')::interval, 'queued')
  returning id, expires_at into v_id, v_expires;

  select to_jsonb(c) into v_existing from device_commands c where id=v_id;
  perform public.log_audit(p_tenant, p_actor, 'device.command', 'command', v_id::text, null, p_data);
  return jsonb_build_object('idempotent', false, 'command', v_existing);
end $$;

create or replace function public.rpc_mark_command_published(p_command uuid, p_topic text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update device_commands set status='published', published_at=now(),
    payload = payload || jsonb_build_object('topic',p_topic)
  where id=p_command and status='queued';
  return jsonb_build_object('published', true);
end $$;

create or replace function public.rpc_expire_commands()
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update device_commands set status='expired', error='No acknowledgement before expiry'
    where status in ('queued','published') and expires_at < now();
  get diagnostics v_count = row_count;
  update devices d set requested_state = null
    from device_commands c
    where c.id = d.last_command_id and c.status='expired' and d.requested_state is not null;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- DEVICE INGEST. p_board is resolved from the authenticated MQTT session.
-- tenant_id is derived from user_boards; any tenant_id in the JSON is ignored.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_ingest_telemetry(p_board uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid; v_key text; v_item jsonb; v_sensor sensors%rowtype;
  v_value numeric; v_status text; v_accepted int := 0; v_rejected jsonb := '[]'::jsonb;
  v_ts timestamptz; v_unit text; v_cfg_version int;
begin
  select tenant_id into v_tenant from user_boards where id=p_board and deleted_at is null;
  if v_tenant is null then raise exception 'Unknown board' using errcode='42501'; end if;
  if coalesce((p_payload->>'schema_version')::int,0) <> 1 then
    raise exception 'Unsupported telemetry schema_version' using errcode='22023';
  end if;
  -- Ignore any device_id/tenant_id in the payload: board identity is authoritative.
  v_ts := to_timestamp(coalesce((p_payload->>'timestamp')::bigint, extract(epoch from now())::bigint));
  v_cfg_version := coalesce((p_payload->>'config_version')::int, 0);

  for v_key in select jsonb_object_keys(coalesce(p_payload->'sensors','{}'::jsonb)) loop
    v_item := p_payload->'sensors'->v_key;
    select * into v_sensor from sensors
      where tenant_id=v_tenant and user_board_id=p_board and slug=v_key
        and deleted_at is null and enabled;
    if not found then
      v_rejected := v_rejected || jsonb_build_array(jsonb_build_object('field',v_key,'reason','unknown_sensor'));
      continue;
    end if;
    if v_item->>'value' is null or jsonb_typeof(v_item->'value') not in ('number','string') then
      v_rejected := v_rejected || jsonb_build_array(jsonb_build_object('field',v_key,'reason','invalid_value'));
      continue;
    end if;
    v_value := (v_item->>'value')::numeric;
    v_unit := coalesce(v_item->>'unit', v_sensor.unit);
    v_status := coalesce(v_item->>'status','valid');
    if v_unit is distinct from v_sensor.unit
       or (v_sensor.min_valid is not null and v_value < v_sensor.min_valid)
       or (v_sensor.max_valid is not null and v_value > v_sensor.max_valid)
       or v_status = 'invalid' then
      v_rejected := v_rejected || jsonb_build_array(jsonb_build_object('field',v_key,'reason','validation_failed'));
      continue;
    end if;
    insert into sensor_readings (tenant_id, sensor_id, board_id, value, unit, status, recorded_at, metadata)
    values (v_tenant, v_sensor.id, p_board, v_value, v_unit,
      case when v_status in ('valid','warning','stale') then v_status else 'valid' end,
      v_ts, jsonb_build_object('config_version',v_cfg_version));
    update sensors set last_value=v_value, last_value_at=now(), last_status='valid' where id=v_sensor.id;
    v_accepted := v_accepted + 1;
  end loop;

  update user_boards set last_telemetry_at=now(), last_seen_at=now(), status='online',
    applied_config_version = case when v_cfg_version > applied_config_version then v_cfg_version else applied_config_version end
  where id=p_board;
  insert into usage_counters (tenant_id, bucket, metric, value)
  values (v_tenant, date_trunc('hour',now()), 'telemetry_messages', 1)
  on conflict (tenant_id,bucket,metric) do update set value=usage_counters.value+1;
  return jsonb_build_object('accepted',v_accepted,'rejected',v_rejected,'tenant_id',v_tenant);
end $$;

-- State/acknowledgement messages from a device.
create or replace function public.rpc_ingest_state(p_board uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid; v_cmd uuid; v_dev devices%rowtype; v_actual text; v_status text;
  v_state text; v_key text; v_item jsonb; v_board_status text;
begin
  select tenant_id into v_tenant from user_boards where id=p_board and deleted_at is null;
  if v_tenant is null then raise exception 'Unknown board' using errcode='42501'; end if;
  v_board_status := coalesce(p_payload->>'availability','online');
  update user_boards set last_seen_at=now(), status = case when v_board_status='offline' then 'offline' else 'online' end
    where id=p_board;

  -- Acknowledgements: command must belong to THIS board and tenant.
  if p_payload ? 'command_id' and (p_payload->>'command_id') <> '' then
    v_cmd := (p_payload->>'command_id')::uuid;
    select * into v_dev from devices where slug=p_payload->>'component_id'
      and user_board_id=p_board and tenant_id=v_tenant and deleted_at is null;
    v_status := coalesce(p_payload->>'status','confirmed');
    v_actual := case when (p_payload->>'actual_state')::boolean is true then 'on'
                     when (p_payload->>'actual_state')::boolean is false then 'off' else 'unknown' end;
    update device_commands set
      status = case when v_status in ('failed','rejected') then v_status else 'acknowledged' end,
      acknowledged_at = now(), error = p_payload->>'error'
    where id=v_cmd and tenant_id=v_tenant and user_board_id=p_board and status in ('queued','published');
    if found and v_dev.id is not null then
      update devices set reported_state = v_actual, last_state_at = now(), state_source='device',
        requested_state = case when v_status='confirmed' then null else requested_state end,
        last_command_id = v_cmd
      where id=v_dev.id and tenant_id=v_tenant;
      insert into switch_states (tenant_id, device_id, command_id, requested, reported, source, status, latency_ms)
      values (v_tenant, v_dev.id, v_cmd, p_payload->>'requested_state', v_actual, 'device',
        case when v_status='failed' then 'failed' else 'confirmed' end,
        extract(epoch from (now() - (select created_at from device_commands where id=v_cmd)))::int * 1000);
    end if;
  end if;

  -- Periodic full state report (in addition to command acks).
  for v_key in select jsonb_object_keys(coalesce(p_payload->'devices','{}'::jsonb)) loop
    v_item := p_payload->'devices'->v_key;
    select * into v_dev from devices where slug=v_key and user_board_id=p_board
      and tenant_id=v_tenant and deleted_at is null;
    if found then
      v_state := case when v_item->>'state' = 'on' then 'on'
                      when v_item->>'state' = 'off' then 'off' else 'unknown' end;
      update devices set reported_state=v_state, last_state_at=now(), state_source='device'
      where id=v_dev.id;
    end if;
  end loop;
  return jsonb_build_object('ok',true,'tenant_id',v_tenant);
end $$;

create or replace function public.rpc_ack_config(p_board uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_version int; v_status text;
begin
  select tenant_id into v_tenant from user_boards where id=p_board and deleted_at is null;
  if v_tenant is null then raise exception 'Unknown board' using errcode='42501'; end if;
  v_version := (p_payload->>'config_version')::int;
  v_status := coalesce(p_payload->>'status','applied');
  update user_boards set
    applied_config_version = case when v_status='applied' then greatest(applied_config_version, v_version) else applied_config_version end,
    config_sync_status = case when v_status='applied' then 'synced' else 'failed' end,
    config_ack_at = now(), last_seen_at = now(), status='online'
  where id=p_board;
  perform public.log_audit(v_tenant, null, 'config.ack', 'board', p_board::text, null, p_payload, 'device');
  return jsonb_build_object('ok',true,'config_version',v_version,'status',v_status);
end $$;

create or replace function public.rpc_board_from_client(p_client_id text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  select jsonb_build_object('board_id',b.id,'tenant_id',b.tenant_id,'device_id',b.device_id,
    'credential_id',c.id,'username',c.username,'password_hash',c.password_hash,
    'credential_status',c.status,'board_status',b.status,
    'topics', jsonb_build_object(
      'command','v1/tenants/'||b.tenant_id||'/devices/'||b.device_id||'/command',
      'config','v1/tenants/'||b.tenant_id||'/devices/'||b.device_id||'/config',
      'state','v1/tenants/'||b.tenant_id||'/devices/'||b.device_id||'/state',
      'telemetry','v1/tenants/'||b.tenant_id||'/devices/'||b.device_id||'/telemetry',
      'availability','v1/tenants/'||b.tenant_id||'/devices/'||b.device_id||'/availability'))
  into v
  from user_boards b
  join mqtt_credentials_metadata c on c.user_board_id=b.id and c.status='active'
  where b.mqtt_client_id=p_client_id and b.deleted_at is null and b.status <> 'disabled';
  return v;
end $$;
