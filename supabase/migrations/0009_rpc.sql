-- ============================================================================
-- HomecoreOS — 0009 domain RPCs (atomic, tenant-safe, transport-independent)
-- ============================================================================
-- The Worker calls these via PostgREST /rpc/<name>. Every function takes the
-- ACTOR id resolved server-side from the verified JWT, never from the request
-- body, and re-verifies tenant membership + permission inside the database.
-- Device-ingest functions take the board identity resolved from the MQTT
-- session and derive tenant_id from the database; payload tenant ids ignored.
-- ----------------------------------------------------------------------------

create or replace function public.permission_granted(p_actor uuid, p_tenant uuid, p_permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from tenant_members m
    join tenants t on t.id = m.tenant_id and t.status = 'active'
    left join lateral (
      select mp.effect from member_permissions mp
      where mp.member_id = m.id and mp.permission_key = p_permission
    ) ov on true
    where m.tenant_id = p_tenant and m.profile_id = p_actor and m.status = 'active'
      and (
        m.role_key = 'owner'
        or coalesce(ov.effect, (
          select case when exists (
            select 1 from role_permissions rp join roles r on r.id = rp.role_id
            where r.key = m.role_key and (r.tenant_id is null or r.tenant_id = m.tenant_id)
              and rp.permission_key = p_permission
          ) then 'allow' else 'deny' end
        )) = 'allow'
      )
  )
$$;

create or replace function public.assert_permission(p_actor uuid, p_tenant uuid, p_permission text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.permission_granted(p_actor, p_tenant, p_permission) then
    raise exception 'Permission denied: %', p_permission using errcode = '42501';
  end if;
end $$;

create or replace function public.assert_member(p_actor uuid, p_tenant uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from tenant_members m join tenants t on t.id = m.tenant_id
                 where m.tenant_id = p_tenant and m.profile_id = p_actor
                   and m.status = 'active' and t.status = 'active') then
    raise exception 'Not an active member of this workspace' using errcode = '42501';
  end if;
end $$;

create or replace function public.log_audit(
  p_tenant uuid, p_actor uuid, p_action text, p_entity text, p_entity_id text,
  p_before jsonb default null, p_after jsonb default null, p_actor_type text default 'user'
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into audit_logs (tenant_id, actor_id, actor_email, actor_type, action, entity_type, entity_id, before, after)
  values (p_tenant, p_actor, (select email from profiles where id = p_actor), p_actor_type,
          p_action, p_entity, p_entity_id, p_before, p_after);
end $$;

-- ---------------------------------------------------------------------------
-- Config sync: rebuild immutable config from the database (master source).
-- ---------------------------------------------------------------------------
create or replace function public.build_board_config(p_board uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  select jsonb_build_object(
    'schema_version', 1,
    'board_id', b.device_id,
    'config_version', b.config_version,
    'generated_at', now(),
    'command_ttl_seconds', coalesce((select value::int from platform_settings where key='security.command_ttl_seconds'),30),
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'component_id', d.slug, 'id', d.id, 'name', d.name, 'type', d.device_type,
        'gpio', d.output_gpio, 'interface', d.interface, 'active_low', d.active_low,
        'initial_state', d.initial_state, 'pulse_ms', d.pulse_ms,
        'physical_input_gpio', d.physical_input_gpio, 'automation_enabled', d.automation_enabled
      ) order by d.created_at) from devices d
      where d.user_board_id = b.id and d.deleted_at is null), '[]'::jsonb),
    'sensors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'component_id', s.slug, 'id', s.id, 'name', s.name, 'category', s.category,
        'interface', s.interface, 'gpio', s.gpio, 'bus', sb.label, 'i2c_address', s.i2c_address,
        'unit', s.unit, 'sampling_interval_s', s.sampling_interval_s,
        'reporting_interval_s', s.reporting_interval_s, 'delta_threshold', s.delta_threshold,
        'thresholds', s.thresholds, 'transform', s.transform,
        'min_valid', s.min_valid, 'max_valid', s.max_valid
      ) order by s.created_at) from sensors s
      left join shared_buses sb on sb.id = s.bus_id
      where s.user_board_id = b.id and s.deleted_at is null and s.enabled), '[]'::jsonb),
    'buses', coalesce((
      select jsonb_agg(jsonb_build_object('label', sb.label, 'kind', sb.kind,
        'sda', sb.sda_gpio, 'scl', sb.scl_gpio, 'mosi', sb.mosi_gpio,
        'miso', sb.miso_gpio, 'sck', sb.sck_gpio, 'tx', sb.tx_gpio, 'rx', sb.rx_gpio,
        'frequency_hz', sb.frequency_hz) order by sb.created_at)
      from shared_buses sb where sb.user_board_id = b.id), '[]'::jsonb),
    'local_automations', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name,
        'when', a.when_config, 'if', a.conditions, 'then', a.actions,
        'cooldown_s', a.cooldown_s) order by a.created_at)
      from automations a where a.enabled and a.execution in ('local','hybrid')), '[]'::jsonb),
    'safety', jsonb_build_object(
      'pump_dry_run_local', true, 'overflow_local', true, 'emergency_shutdown_local', true,
      'fail_safe_outputs_offline', false,
      'note', 'Safety interlocks are enforced in firmware and never depend on cloud connectivity.'
    )
  ) into v
  from user_boards b where b.id = p_board;
  return v;
end $$;

create or replace function public.bump_board_config(p_board uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare v_version integer; v_tenant uuid; v_config jsonb;
begin
  select tenant_id, config_version + 1 into v_tenant, v_version from user_boards where id = p_board for update;
  v_config := public.build_board_config(p_board);
  v_config := v_config || jsonb_build_object('config_version', v_version);
  insert into device_configurations (tenant_id, user_board_id, version, config, checksum)
  values (v_tenant, p_board, v_version, v_config, md5(v_config::text));
  update user_boards set config_version = v_version, config_sync_status = 'pending' where id = p_board;
  return v_version;
end $$;

-- ---------------------------------------------------------------------------
-- Rooms
-- ---------------------------------------------------------------------------
create or replace function public.rpc_create_room(p_actor uuid, p_tenant uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.assert_permission(p_actor, p_tenant, 'rooms.manage');
  insert into rooms (tenant_id, name, icon, color, image_url, floor, description, sort_order)
  values (p_tenant, p_data->>'name', coalesce(p_data->>'icon','home'), p_data->>'color',
          p_data->>'image_url', p_data->>'floor', p_data->>'description',
          coalesce((p_data->>'sort_order')::int, 0))
  returning id into v_id;
  perform public.log_audit(p_tenant, p_actor, 'room.create', 'room', v_id::text, null, p_data);
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.rpc_update_room(p_actor uuid, p_tenant uuid, p_room uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_before jsonb;
begin
  perform public.assert_permission(p_actor, p_tenant, 'rooms.manage');
  select to_jsonb(r) into v_before from rooms r where id = p_room and tenant_id = p_tenant;
  if v_before is null then raise exception 'Room not found' using errcode = 'P0002'; end if;
  update rooms set
    name = coalesce(p_data->>'name', name),
    icon = coalesce(p_data->>'icon', icon),
    color = coalesce(p_data->>'color', color),
    image_url = coalesce(p_data->>'image_url', image_url),
    floor = coalesce(p_data->>'floor', floor),
    description = coalesce(p_data->>'description', description),
    archived_at = case when p_data ? 'archived' then
      case when (p_data->>'archived')::boolean then now() else null end else archived_at end
  where id = p_room and tenant_id = p_tenant;
  perform public.log_audit(p_tenant, p_actor, 'room.update', 'room', p_room::text, v_before, p_data);
  return jsonb_build_object('id', p_room);
end $$;

-- Deleting a room requires an explicit decision about its devices.
create or replace function public.rpc_delete_room(p_actor uuid, p_tenant uuid, p_room uuid, p_strategy text default 'unassign')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  perform public.assert_permission(p_actor, p_tenant, 'rooms.manage');
  if p_strategy not in ('unassign','delete_devices','archive_only') then
    raise exception 'strategy must be unassign, delete_devices or archive_only' using errcode = '22023';
  end if;
  if not exists (select 1 from rooms where id = p_room and tenant_id = p_tenant) then
    raise exception 'Room not found' using errcode = 'P0002';
  end if;
  select count(*) into v_count from devices where room_id = p_room and tenant_id = p_tenant and deleted_at is null;

  if p_strategy = 'archive_only' then
    update rooms set archived_at = now() where id = p_room and tenant_id = p_tenant;
    return jsonb_build_object('archived', true, 'devices_affected', v_count);
  end if;
  if p_strategy = 'delete_devices' then
    perform public.rpc_delete_device(p_actor, p_tenant, d.id)
      from (select id from devices where room_id = p_room and tenant_id = p_tenant and deleted_at is null) d;
    update sensors set room_id = null where room_id = p_room and tenant_id = p_tenant;
  else
    update devices set room_id = null where room_id = p_room and tenant_id = p_tenant;
    update sensors set room_id = null where room_id = p_room and tenant_id = p_tenant;
  end if;
  delete from rooms where id = p_room and tenant_id = p_tenant;
  perform public.log_audit(p_tenant, p_actor, 'room.delete', 'room', p_room::text,
                           jsonb_build_object('strategy',p_strategy,'devices',v_count), null);
  return jsonb_build_object('deleted', true, 'devices_affected', v_count);
end $$;

-- ---------------------------------------------------------------------------
-- Boards & pairing
-- ---------------------------------------------------------------------------
create or replace function public.rpc_create_pairing_token(p_actor uuid, p_tenant uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_hash text; v_ttl integer; v_board_id text;
begin
  perform public.assert_permission(p_actor, p_tenant, 'devices.manage');
  if not exists (select 1 from tenants where id = p_tenant and device_registration_enabled and status='active') then
    raise exception 'Device registration is disabled for this workspace' using errcode = '42501';
  end if;
  v_hash := p_data->>'token_hash';
  if v_hash is null or length(v_hash) < 32 then
    raise exception 'token_hash required (SHA-256 hex)' using errcode = '22023';
  end if;
  v_board_id := p_data->>'catalog_board_id';
  if v_board_id is not null and not exists (select 1 from board_catalog where id = v_board_id and active) then
    raise exception 'Unknown board catalog entry' using errcode = '22023';
  end if;
  -- Rate limit pairing-token creation (10/hour by default).
  if (select count(*) from device_pairing_tokens
      where tenant_id = p_tenant and created_at > now() - interval '1 hour') >=
     coalesce((select value::int from platform_settings where key='registration.rate_limit_per_hour'),10) then
    raise exception 'Pairing token rate limit exceeded' using errcode = '42901';
  end if;
  v_ttl := coalesce((p_data->>'ttl_seconds')::int,
                    (select value::int from platform_settings where key='registration.pairing_ttl_seconds'),900);
  insert into device_pairing_tokens (tenant_id, token_hash, board_name, catalog_board_id, created_by, expires_at)
  values (p_tenant, v_hash, p_data->>'board_name', v_board_id, p_actor, now() + (v_ttl || ' seconds')::interval)
  returning id into v_id;
  perform public.log_audit(p_tenant, p_actor, 'pairing_token.create', 'pairing_token', v_id::text, null,
                           jsonb_build_object('board',v_board_id,'ttl_seconds',v_ttl));
  return jsonb_build_object('id', v_id, 'expires_in_seconds', v_ttl);
end $$;

-- Claim a pairing token ONCE. Called by the Worker after it has verified the
-- token hash; returns the permanently owned board identity. No JSON-supplied
-- tenant is ever accepted here: the tenant comes from the token row.
create or replace function public.rpc_claim_pairing_token(
  p_token_hash text, p_device_id text, p_client_id text, p_password_hash text,
  p_username text, p_provider_ref jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok device_pairing_tokens%rowtype; v_board_id uuid; v_existing uuid;
begin
  select * into v_tok from device_pairing_tokens
    where token_hash = p_token_hash for update;
  if not found then raise exception 'Invalid pairing token' using errcode = '42501'; end if;
  if v_tok.consumed_at is not null then raise exception 'Pairing token already used' using errcode = '42501'; end if;
  if v_tok.expires_at < now() then raise exception 'Pairing token expired' using errcode = '42501'; end if;
  if not exists (select 1 from tenants t where t.id = v_tok.tenant_id and t.status='active' and t.device_registration_enabled) then
    raise exception 'Workspace cannot register devices' using errcode = '42501';
  end if;

  -- A device_id belongs to exactly one tenant. Transfer requires explicit unclaim.
  select id into v_existing from user_boards where device_id = p_device_id;
  if v_existing is not null then
    update device_pairing_tokens set attempts = attempts + 1 where id = v_tok.id;
    raise exception 'Device is already claimed. Unclaim or reset it before transferring ownership.' using errcode = '23505';
  end if;

  insert into user_boards (tenant_id, catalog_board_id, custom_board, name, device_id, mqtt_client_id,
                           status, created_by, provisioned_at)
  values (v_tok.tenant_id, v_tok.catalog_board_id,
          case when v_tok.catalog_board_id is null then '{}'::jsonb else null end,
          coalesce(v_tok.board_name, 'ESP32 Controller'), p_device_id, p_client_id,
          'provisioning', v_tok.created_by, now())
  returning id into v_board_id;

  insert into mqtt_credentials_metadata (tenant_id, user_board_id, username, password_hash, provider, provider_ref)
  values (v_tok.tenant_id, v_board_id, p_username, p_password_hash, 'emqx', p_provider_ref);

  update device_pairing_tokens set consumed_at = now(), user_board_id = v_board_id where id = v_tok.id;
  perform public.bump_board_config(v_board_id);
  perform public.log_audit(v_tok.tenant_id, v_tok.created_by, 'device.pair', 'board', v_board_id::text, null,
                           jsonb_build_object('device_id',p_device_id,'catalog_board_id',v_tok.catalog_board_id), 'device');
  return jsonb_build_object(
    'board_id', v_board_id, 'tenant_id', v_tok.tenant_id, 'device_id', p_device_id,
    'mqtt_client_id', p_client_id, 'mqtt_username', p_username,
    'catalog_board_id', v_tok.catalog_board_id
  );
end $$;

create or replace function public.rpc_rotate_device_credentials(
  p_actor uuid, p_tenant uuid, p_board uuid, p_password_hash text, p_provider_ref jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_username text;
begin
  perform public.assert_permission(p_actor, p_tenant, 'devices.configure');
  select username into v_username from mqtt_credentials_metadata
    where user_board_id = p_board and tenant_id = p_tenant and status='active';
  if v_username is null then raise exception 'Board not found' using errcode = 'P0002'; end if;
  update mqtt_credentials_metadata set status='rotated', rotated_at=now() where user_board_id=p_board and status='active';
  insert into mqtt_credentials_metadata (tenant_id, user_board_id, username, password_hash, provider_ref)
    values (p_tenant, p_board, v_username || '-r' || floor(extract(epoch from now()))::text, p_password_hash, p_provider_ref);
  perform public.log_audit(p_tenant, p_actor, 'device.credentials.rotate', 'board', p_board::text);
  return jsonb_build_object('rotated', true);
end $$;

create or replace function public.rpc_unregister_board(p_actor uuid, p_tenant uuid, p_board uuid, p_confirm text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_device_id text;
begin
  perform public.assert_permission(p_actor, p_tenant, 'devices.manage');
  select device_id into v_device_id from user_boards where id=p_board and tenant_id=p_tenant and deleted_at is null;
  if v_device_id is null then raise exception 'Board not found' using errcode = 'P0002'; end if;
  if p_confirm <> v_device_id then
    raise exception 'Type the exact device id to confirm unclaim' using errcode = '22023';
  end if;
  delete from exclusive_allocations where user_board_id = p_board;
  update board_pins set state = case when restricted then state else 'available' end where user_board_id=p_board;
  update devices set deleted_at = now() where user_board_id=p_board and tenant_id=p_tenant;
  update sensors set deleted_at = now() where user_board_id=p_board and tenant_id=p_tenant;
  update mqtt_credentials_metadata set status='revoked', revoked_at=now() where user_board_id=p_board and status='active';
  update user_boards set deleted_at=now(), status='disabled' where id=p_board;
  perform public.log_audit(p_tenant, p_actor, 'board.unclaim', 'board', p_board::text,
                           jsonb_build_object('device_id',v_device_id), null);
  return jsonb_build_object('unclaimed', true, 'device_id', v_device_id);
end $$;

-- ---------------------------------------------------------------------------
-- Shared buses (explicit; never confused with exclusive GPIO ownership)
-- ---------------------------------------------------------------------------
create or replace function public.rpc_create_bus(p_actor uuid, p_tenant uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_board uuid; v_kind text; v_pins integer[]; v_i integer; v_bus uuid;
begin
  perform public.assert_permission(p_actor, p_tenant, 'devices.manage');
  v_board := (p_data->>'user_board_id')::uuid;
  if not exists (select 1 from user_boards where id=v_board and tenant_id=p_tenant and deleted_at is null) then
    raise exception 'Board not found in this workspace' using errcode = '42501';
  end if;
  v_kind := p_data->>'kind';
  if v_kind not in ('i2c','spi','uart','onewire') then raise exception 'Invalid bus kind' using errcode='22023'; end if;
  v_pins := array_remove(array[
    (p_data->>'sda_gpio')::int, (p_data->>'scl_gpio')::int,
    (p_data->>'mosi_gpio')::int, (p_data->>'miso_gpio')::int, (p_data->>'sck_gpio')::int,
    (p_data->>'tx_gpio')::int, (p_data->>'rx_gpio')::int
  ], null);
  if coalesce(array_length(v_pins,1),0) = 0 then
    raise exception 'A bus requires at least one pin' using errcode='22023';
  end if;

  insert into shared_buses (tenant_id, user_board_id, kind, label, sda_gpio, scl_gpio, mosi_gpio,
    miso_gpio, sck_gpio, tx_gpio, rx_gpio, frequency_hz, config)
  values (p_tenant, v_board, v_kind, p_data->>'label', (p_data->>'sda_gpio')::int,
    (p_data->>'scl_gpio')::int, (p_data->>'mosi_gpio')::int, (p_data->>'miso_gpio')::int,
    (p_data->>'sck_gpio')::int, (p_data->>'tx_gpio')::int, (p_data->>'rx_gpio')::int,
    (p_data->>'frequency_hz')::int, coalesce(p_data->'config','{}'::jsonb))
  returning id into v_bus;

  -- Bus controller pins are exclusive to THIS bus, shared by its members.
  foreach v_i in array v_pins loop
    perform public.assign_pin_exclusive(p_tenant, v_board, v_i, 'bus', v_bus,
      case when v_kind='i2c' then 'i2c' when v_kind='spi' then 'spi' else 'uart' end, v_bus);
  end loop;
  perform public.bump_board_config(v_board);
  perform public.log_audit(p_tenant, p_actor, 'bus.create', 'shared_bus', v_bus::text, null, p_data);
  return jsonb_build_object('id', v_bus);
end $$;
