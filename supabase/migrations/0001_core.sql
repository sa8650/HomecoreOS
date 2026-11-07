-- ============================================================================
-- Helios Smart Home SaaS — 0001 core helpers
-- ============================================================================
-- Everything tenant-owned carries tenant_id. RLS is enforced in 0006.
-- Supabase provides auth.uid(); this file only defines app helpers.

create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- Resolve the caller's profile id (Supabase JWT sub).
create or replace function public.current_profile_id()
returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub','')::uuid
$$;

comment on function public.current_profile_id is
  'Reads sub claim from the PostgREST request JWT claims; returns null for anon.';
