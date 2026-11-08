-- ============================================================================
-- HomecoreOS — 0002 identity, tenancy, roles & permissions
-- ============================================================================

create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  full_name     text,
  avatar_url    text,
  timezone      text not null default 'UTC',
  locale        text not null default 'en',
  phone         text,
  last_seen_at  timestamptz,
  suspended_at  timestamptz,
  suspended_reason text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists profiles_email_key on public.profiles (lower(email));
create trigger profiles_touch before update on public.profiles
  for each row execute function public.tg_set_updated_at();

-- Platform (SaaS owner) administrators. Separate from customer tenancy.
create table if not exists public.platform_admins (
  profile_id  uuid primary key references public.profiles(id) on delete cascade,
  level       text not null default 'admin' check (level in ('owner','admin','support')),
  note        text,
  granted_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

-- One home workspace per customer account.
create table if not exists public.tenants (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null,
  slug                        text not null unique,
  owner_profile_id            uuid not null references public.profiles(id),
  status                      text not null default 'active' check (status in ('active','suspended','closed')),
  suspended_reason            text,
  plan                        text not null default 'free',
  timezone                    text not null default 'UTC',
  address                     text,
  device_registration_enabled boolean not null default true,
  max_boards                  integer not null default 10,
  max_devices                 integer not null default 100,
  feature_flags               jsonb not null default '{}'::jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  archived_at                 timestamptz
);
create trigger tenants_touch before update on public.tenants
  for each row execute function public.tg_set_updated_at();

-- Permission catalog (platform-wide, not tenant data).
create table if not exists public.permissions (
  key         text primary key,
  category    text not null,
  label       text not null,
  description text,
  sort_order  integer not null default 0
);

-- Roles: system roles (tenant_id null) + tenant-defined custom roles.
create table if not exists public.roles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants(id) on delete cascade,
  key         text not null,
  name        text not null,
  description text,
  rank        integer not null default 100,
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (tenant_id, key)
);
create unique index if not exists roles_system_key on public.roles (key) where tenant_id is null;

create table if not exists public.role_permissions (
  role_id        uuid not null references public.roles(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);

create table if not exists public.tenant_members (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  role_key      text not null default 'viewer',
  status        text not null default 'active' check (status in ('invited','active','suspended','revoked')),
  invited_by    uuid references public.profiles(id),
  invited_email text,
  joined_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists tenant_members_unique on public.tenant_members (tenant_id, profile_id);
create index if not exists tenant_members_profile on public.tenant_members (profile_id) where status = 'active';
create trigger tenant_members_touch before update on public.tenant_members
  for each row execute function public.tg_set_updated_at();

-- Per-member permission overrides (on top of the role defaults).
create table if not exists public.member_permissions (
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  member_id      uuid not null references public.tenant_members(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  effect         text not null check (effect in ('allow','deny')),
  updated_by     uuid references public.profiles(id),
  updated_at     timestamptz not null default now(),
  primary key (member_id, permission_key)
);

-- Room / device level scoping for staff.
create table if not exists public.member_access_rules (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  member_id  uuid not null references public.tenant_members(id) on delete cascade,
  scope      text not null check (scope in ('room','device')),
  target_id  uuid not null,
  allowed    boolean not null default true,
  created_at timestamptz not null default now(),
  unique (member_id, scope, target_id)
);

create table if not exists public.staff_invitations (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  email        text not null,
  role_key     text not null default 'viewer',
  token_hash   text not null unique,
  invited_by   uuid references public.profiles(id),
  message      text,
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists staff_invitations_open on public.staff_invitations (tenant_id, lower(email))
  where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------------------------
-- Authorization helpers (SECURITY DEFINER avoids recursive RLS lookups).
-- ---------------------------------------------------------------------------
create or replace function public.is_tenant_member(p_tenant uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from tenant_members m
    join tenants t on t.id = m.tenant_id
    where m.tenant_id = p_tenant
      and m.profile_id = current_profile_id()
      and m.status = 'active'
      and t.status = 'active'
  )
$$;

create or replace function public.tenant_role(p_tenant uuid)
returns text language sql stable security definer set search_path = public as $$
  select m.role_key from tenant_members m
  where m.tenant_id = p_tenant and m.profile_id = current_profile_id() and m.status = 'active'
  limit 1
$$;

-- Effective permission: member override > role default > deny.
create or replace function public.has_permission(p_tenant uuid, p_permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from tenant_members m
    join tenants t on t.id = m.tenant_id and t.status = 'active'
    left join lateral (
      select mp.effect from member_permissions mp
      where mp.member_id = m.id and mp.permission_key = p_permission
    ) ov on true
    where m.tenant_id = p_tenant
      and m.profile_id = current_profile_id()
      and m.status = 'active'
      and (
        m.role_key = 'owner'
        or coalesce(ov.effect, (
          select case when exists (
            select 1 from role_permissions rp
            join roles r on r.id = rp.role_id
            where r.key = m.role_key
              and (r.tenant_id is null or r.tenant_id = m.tenant_id)
              and rp.permission_key = p_permission
          ) then 'allow' else 'deny' end
        )) = 'allow'
      )
  )
$$;

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins a where a.profile_id = current_profile_id())
$$;

create or replace function public.member_id_for(p_tenant uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select m.id from tenant_members m
  where m.tenant_id = p_tenant and m.profile_id = current_profile_id() and m.status = 'active'
  limit 1
$$;

-- Room access for the current member (default allow unless an explicit deny rule exists).
create or replace function public.can_access_room(p_tenant uuid, p_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_tenant_member(p_tenant) and not exists (
    select 1 from member_access_rules r
    where r.member_id = public.member_id_for(p_tenant)
      and r.scope = 'room' and r.target_id = p_room and r.allowed = false
  )
$$;

-- New auth user -> profile + personal tenant + owner membership.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_name text;
  v_slug text;
begin
  v_name := coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1));
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, v_name)
  on conflict (id) do nothing;

  v_slug := lower(regexp_replace(split_part(new.email, '@', 1), '[^a-zA-Z0-9]+', '-', 'g'))
            || '-' || substr(replace(new.id::text, '-', ''), 1, 8);

  insert into public.tenants (name, slug, owner_profile_id, timezone)
  values (coalesce(new.raw_user_meta_data->>'home_name', v_name || '''s Home'), v_slug, new.id,
          coalesce(new.raw_user_meta_data->>'timezone', 'UTC'))
  returning id into v_tenant;

  insert into public.tenant_members (tenant_id, profile_id, role_key, status, joined_at)
  values (v_tenant, new.id, 'owner', 'active', now());
  return new;
end $$;

-- Tenant setting cannot be silently transferred; ownership changes are explicit.
create or replace function public.tg_guard_member_escalation()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := public.current_profile_id();
  v_actor_role text;
begin
  -- Service role / system operations run with no JWT; allow them.
  if v_actor is null then return new; end if;
  select role_key into v_actor_role from tenant_members
    where tenant_id = new.tenant_id and profile_id = v_actor and status = 'active';
  if v_actor_role = 'owner' then return new; end if;
  if new.role_key = 'owner' or new.role_key = 'administrator' then
    raise exception 'Only the workspace owner can assign the % role', new.role_key
      using errcode = '42501';
  end if;
  return new;
end $$;

create trigger tenant_members_guard
  before insert or update of role_key on public.tenant_members
  for each row execute function public.tg_guard_member_escalation();
