-- Correct command-ack status mapping (device_commands.status check constraint).
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

