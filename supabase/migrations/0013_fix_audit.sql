-- Idempotent correction for deployments that applied 0009 before the fix.
create or replace function public.log_audit(
  p_tenant uuid, p_actor uuid, p_action text, p_entity text, p_entity_id text,
  p_before jsonb default null, p_after jsonb default null, p_actor_type text default 'user'
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into audit_logs (tenant_id, actor_id, actor_email, actor_type, action, entity_type, entity_id, before, after)
  values (p_tenant, p_actor, (select email from profiles where id = p_actor), p_actor_type,
          p_action, p_entity, p_entity_id, p_before, p_after);
end $$;
