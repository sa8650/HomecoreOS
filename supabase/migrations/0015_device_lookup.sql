-- Resolve an authenticated board from its tenant + device identity when the
-- ingress path (EMQX rule/webhook or platform MQTT bridge) does not expose the
-- MQTT client id. The topic still never supplies trust: it is checked against
-- the database row for that exact tenant/device pair.
create or replace function public.rpc_board_from_device(p_tenant uuid, p_device_id text)
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
  where b.tenant_id=p_tenant and b.device_id=p_device_id
    and b.deleted_at is null and b.status <> 'disabled';
  return v;
end $$;
