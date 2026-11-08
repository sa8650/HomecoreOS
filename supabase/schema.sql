create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
create or replace function public.current_profile_id()
returns uuid language sql stable as $$
  select null::uuid
$$;

create table if not exists public.profiles (
  id            uuid primary key,
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
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.tg_set_updated_at();
create table if not exists public.platform_admins (
  profile_id  uuid primary key references public.profiles(id) on delete cascade,
  level       text not null default 'admin' check (level in ('owner','admin','support')),
  note        text,
  granted_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
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
drop trigger if exists tenants_touch on public.tenants;
create trigger tenants_touch before update on public.tenants
  for each row execute function public.tg_set_updated_at();
create table if not exists public.permissions (
  key         text primary key,
  category    text not null,
  label       text not null,
  description text,
  sort_order  integer not null default 0
);
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
drop trigger if exists tenant_members_touch on public.tenant_members;
create trigger tenant_members_touch before update on public.tenant_members
  for each row execute function public.tg_set_updated_at();
create table if not exists public.member_permissions (
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  member_id      uuid not null references public.tenant_members(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  effect         text not null check (effect in ('allow','deny')),
  updated_by     uuid references public.profiles(id),
  updated_at     timestamptz not null default now(),
  primary key (member_id, permission_key)
);
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
create or replace function public.can_access_room(p_tenant uuid, p_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_tenant_member(p_tenant) and not exists (
    select 1 from member_access_rules r
    where r.member_id = public.member_id_for(p_tenant)
      and r.scope = 'room' and r.target_id = p_room and r.allowed = false
  )
$$;
create or replace function public.tg_guard_member_escalation()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := public.current_profile_id();
  v_actor_role text;
begin
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
drop trigger if exists tenant_members_guard on public.tenant_members;
create trigger tenant_members_guard
  before insert or update of role_key on public.tenant_members
  for each row execute function public.tg_guard_member_escalation();

create table if not exists public.board_catalog (
  id             text primary key,
  manufacturer   text not null,
  model          text not null,
  variant        text,
  chip_family    text not null,
  chip_variant   text not null,
  revision       text,
  category       text not null default 'devkit',
  image_url      text,
  pinout_url     text,
  doc_source_url text,
  summary        text,
  connectivity   jsonb not null default '{}'::jsonb,
  attributes     jsonb not null default '{}'::jsonb,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
drop trigger if exists board_catalog_touch on public.board_catalog;
create trigger board_catalog_touch before update on public.board_catalog
  for each row execute function public.tg_set_updated_at();
create table if not exists public.board_catalog_versions (
  id         uuid primary key default gen_random_uuid(),
  board_id   text not null references public.board_catalog(id) on delete cascade,
  version    integer not null,
  changelog  text,
  published  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (board_id, version)
);
create table if not exists public.board_catalog_pins (
  id             uuid primary key default gen_random_uuid(),
  board_id       text not null references public.board_catalog(id) on delete cascade,
  gpio           integer not null,
  header_label   text,
  side           text,
  header_pin     integer,
  functions      text[] not null default '{}',
  adc_channels   text[] not null default '{}',
  adc_bits       integer,
  input_only     boolean not null default false,
  exposed        boolean not null default true,
  boot_strapping  boolean not null default false,
  usb_jtag        boolean not null default false,
  flash_connected boolean not null default false,
  psram_connected boolean not null default false,
  touch_channel  text,
  rtc_gpio       boolean not null default false,
  restricted     boolean not null default false,
  restriction_note text,
  notes          text,
  unique (board_id, gpio)
);
create table if not exists public.user_boards (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  catalog_board_id     text references public.board_catalog(id),
  custom_board         jsonb,
  name                 text not null,
  device_id            text not null unique,
  mqtt_client_id       text not null unique,
  hardware_revision    text,
  firmware_version     text,
  firmware_channel     text not null default 'stable',
  config_version       integer not null default 0,
  applied_config_version integer not null default 0,
  config_sync_status   text not null default 'pending'
                       check (config_sync_status in ('pending','synced','failed','stale')),
  config_ack_at        timestamptz,
  status               text not null default 'unclaimed'
                       check (status in ('unclaimed','provisioning','online','offline','disabled')),
  last_seen_at         timestamptz,
  last_telemetry_at    timestamptz,
  last_ip              text,
  rssi                 integer,
  uptime_seconds       bigint,
  fw_build             text,
  provisioned_at       timestamptz,
  created_by           uuid references public.profiles(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  constraint user_boards_catalog_or_custom check (catalog_board_id is not null or custom_board is not null)
);
create index if not exists user_boards_tenant on public.user_boards (tenant_id) where deleted_at is null;
create unique index if not exists user_boards_device_id_key on public.user_boards (device_id);
drop trigger if exists user_boards_touch on public.user_boards;
create trigger user_boards_touch before update on public.user_boards
  for each row execute function public.tg_set_updated_at();
create table if not exists public.device_pairing_tokens (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  user_board_id uuid references public.user_boards(id) on delete cascade,
  token_hash    text not null unique,
  board_name    text,
  catalog_board_id text references public.board_catalog(id),
  created_by    uuid references public.profiles(id),
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  consumed_ip   text,
  attempts      integer not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists pairing_open on public.device_pairing_tokens (tenant_id)
  where consumed_at is null;
create table if not exists public.mqtt_credentials_metadata (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  user_board_id  uuid not null references public.user_boards(id) on delete cascade,
  username       text not null unique,
  password_hash  text not null,
  provider       text not null default 'emqx',
  provider_ref   jsonb not null default '{}'::jsonb,
  status         text not null default 'active' check (status in ('active','rotated','revoked')),
  rotated_at     timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz not null default now()
);
create unique index if not exists mqtt_credentials_one_active
  on public.mqtt_credentials_metadata (user_board_id) where status = 'active';
create or replace function public.tg_seed_board_pins()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.board_pins (tenant_id, user_board_id, gpio, header_label, state, restricted, boot_strapping,
                                 usb_jtag, flash_connected, psram_connected, input_only, functions, adc_channels, notes)
  select new.tenant_id, new.id, p.gpio, p.header_label,
         case when p.restricted then 'system' when p.exposed then 'available' else 'system' end,
         p.restricted, p.boot_strapping, p.usb_jtag, p.flash_connected, p.psram_connected, p.input_only,
         p.functions, p.adc_channels, p.notes
  from public.board_catalog_pins p
  where p.board_id = new.catalog_board_id and p.exposed
  on conflict (tenant_id, user_board_id, gpio) do nothing;
  return new;
end $$;
create table if not exists public.board_pins (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  user_board_id   uuid not null references public.user_boards(id) on delete cascade,
  gpio            integer not null,
  header_label    text,
  state           text not null default 'available'
                  check (state in ('available','assigned','system','restricted')),
  restricted      boolean not null default false,
  boot_strapping   boolean not null default false,
  usb_jtag        boolean not null default false,
  flash_connected boolean not null default false,
  psram_connected boolean not null default false,
  input_only      boolean not null default false,
  functions       text[] not null default '{}',
  adc_channels    text[] not null default '{}',
  notes           text,
  created_at      timestamptz not null default now(),
  unique (tenant_id, user_board_id, gpio)
);
create index if not exists board_pins_board on public.board_pins (user_board_id);
drop trigger if exists user_boards_seed_pins on public.user_boards;
create trigger user_boards_seed_pins
  after insert on public.user_boards
  for each row execute function public.tg_seed_board_pins();
create table if not exists public.shared_buses (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  user_board_id  uuid not null references public.user_boards(id) on delete cascade,
  kind           text not null check (kind in ('i2c','spi','uart','onewire')),
  label          text not null,
  sda_gpio       integer,
  scl_gpio       integer,
  mosi_gpio      integer,
  miso_gpio      integer,
  sck_gpio       integer,
  tx_gpio        integer,
  rx_gpio        integer,
  frequency_hz   integer,
  config         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  unique (user_board_id, label)
);
create index if not exists shared_buses_tenant on public.shared_buses (tenant_id);
create table if not exists public.exclusive_allocations (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  user_board_id  uuid not null references public.user_boards(id) on delete cascade,
  gpio           integer not null,
  owner_type     text not null check (owner_type in ('device','sensor','bus','system')),
  owner_id       uuid,
  function_kind  text not null,
  bus_id         uuid references public.shared_buses(id) on delete cascade,
  created_at     timestamptz not null default now(),
  unique (user_board_id, gpio)
);
create index if not exists exclusive_allocations_tenant on public.exclusive_allocations (tenant_id);
create index if not exists exclusive_allocations_bus on public.exclusive_allocations (bus_id) where bus_id is not null;
create or replace function public.assign_pin_exclusive(
  p_tenant uuid, p_board uuid, p_gpio integer, p_owner_type text, p_owner_id uuid,
  p_function_kind text, p_bus uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_pin board_pins%rowtype;
  v_id uuid;
begin
  select * into v_pin from board_pins
    where tenant_id = p_tenant and user_board_id = p_board and gpio = p_gpio for update;
  if not found then
    raise exception 'GPIO % is not exposed on this board', p_gpio using errcode = '22023';
  end if;
  if v_pin.restricted then
    raise exception 'GPIO % is reserved by the hardware and cannot be assigned', p_gpio using errcode = '22023';
  end if;
  if p_function_kind in ('output','pwm') and v_pin.input_only then
    raise exception 'GPIO % is input-only and cannot drive an output', p_gpio using errcode = '22023';
  end if;
  if p_function_kind = 'adc' and coalesce(array_length(v_pin.adc_channels,1),0) = 0 then
    raise exception 'GPIO % has no ADC channel on this board', p_gpio using errcode = '22023';
  end if;
  insert into exclusive_allocations (tenant_id, user_board_id, gpio, owner_type, owner_id, function_kind, bus_id)
  values (p_tenant, p_board, p_gpio, p_owner_type, p_owner_id, p_function_kind, p_bus)
  returning id into v_id;
  update board_pins set state = 'assigned' where user_board_id = p_board and gpio = p_gpio;
  return v_id;
exception when unique_violation then
  raise exception 'GPIO % is already allocated on this board', p_gpio using errcode = '23505';
end $$;
create or replace function public.release_allocations_for_owner(p_owner_type text, p_owner_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  with gone as (
    delete from exclusive_allocations
      where owner_type = p_owner_type and owner_id = p_owner_id
      returning user_board_id, gpio, tenant_id
  )
  update board_pins bp set state = 'available'
    from gone g
    where bp.user_board_id = g.user_board_id and bp.gpio = g.gpio
      and not bp.restricted;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  icon        text not null default 'home',
  color       text,
  image_url   text,
  floor       text,
  description text,
  sort_order  integer not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, name)
);
create index if not exists rooms_tenant on public.rooms (tenant_id);
drop trigger if exists rooms_touch on public.rooms;
create trigger rooms_touch before update on public.rooms
  for each row execute function public.tg_set_updated_at();
create table if not exists public.device_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants(id) on delete cascade,
  key         text not null,
  name        text not null,
  device_type text not null,
  icon        text not null default 'power',
  default_config jsonb not null default '{}'::jsonb,
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (tenant_id, key)
);
create table if not exists public.devices (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  room_id           uuid references public.rooms(id) on delete set null,
  user_board_id     uuid not null references public.user_boards(id) on delete cascade,
  name              text not null,
  slug              text not null,
  device_type       text not null default 'relay'
                    check (device_type in ('light','fan','water_pump','relay','smart_socket','motor','main_line_monitor','custom')),
  icon              text not null default 'power',
  output_gpio       integer,
  interface         text not null default 'gpio' check (interface in ('gpio','pwm','dac','i2c_relay','shift_register','none')),
  interface_config  jsonb not null default '{}'::jsonb,
  active_low        boolean not null default false,
  initial_state     text not null default 'off' check (initial_state in ('off','on','restore')),
  pulse_ms          integer,
  physical_input_gpio integer,
  reported_state    text not null default 'unknown' check (reported_state in ('on','off','unknown')),
  requested_state   text,
  requested_at      timestamptz,
  last_state_at     timestamptz,
  last_command_id   uuid,
  state_source      text,
  power_rating_w    numeric(8,2),
  metering          jsonb not null default '{}'::jsonb,
  automation_enabled boolean not null default true,
  control_permission text not null default 'device.control',
  sort_order        integer not null default 0,
  created_by        uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create unique index if not exists devices_tenant_slug
  on public.devices (tenant_id, slug) where deleted_at is null;
create index if not exists devices_tenant on public.devices (tenant_id) where deleted_at is null;
create index if not exists devices_board on public.devices (user_board_id) where deleted_at is null;
create index if not exists devices_room on public.devices (room_id) where deleted_at is null;
drop trigger if exists devices_touch on public.devices;
create trigger devices_touch before update on public.devices
  for each row execute function public.tg_set_updated_at();
create table if not exists public.sensors (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  room_id           uuid references public.rooms(id) on delete set null,
  user_board_id     uuid not null references public.user_boards(id) on delete cascade,
  name              text not null,
  slug              text not null,
  category          text not null check (category in
                    ('temperature','humidity','motion','water_level','rain','light','soil_moisture',
                     'contact','voltage','current','power','gas','air_quality','custom')),
  sensor_model      text,
  interface         text not null default 'gpio' check (interface in ('gpio','adc','i2c','spi','uart','virtual','onewire')),
  gpio              integer,
  bus_id            uuid references public.shared_buses(id) on delete set null,
  i2c_address       text,
  unit              text not null default 'celsius',
  decimals          smallint not null default 1,
  min_valid         numeric,
  max_valid         numeric,
  sampling_interval_s integer not null default 60,
  reporting_interval_s integer not null default 60,
  report_on_change  boolean not null default true,
  delta_threshold   numeric,
  thresholds        jsonb not null default '{}'::jsonb,
  topic_suffix      text,
  payload_path      text,
  transform         jsonb not null default '{}'::jsonb,
  last_value        numeric,
  last_value_at     timestamptz,
  last_status       text not null default 'unknown',
  enabled           boolean not null default true,
  created_by        uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create unique index if not exists sensors_tenant_slug
  on public.sensors (tenant_id, slug) where deleted_at is null;
create index if not exists sensors_tenant on public.sensors (tenant_id) where deleted_at is null;
create index if not exists sensors_board on public.sensors (user_board_id) where deleted_at is null;
drop trigger if exists sensors_touch on public.sensors;
create trigger sensors_touch before update on public.sensors
  for each row execute function public.tg_set_updated_at();
create table if not exists public.sensor_readings (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  sensor_id   uuid not null references public.sensors(id) on delete cascade,
  board_id    uuid references public.user_boards(id) on delete cascade,
  value       numeric not null,
  unit        text not null,
  status      text not null default 'valid' check (status in ('valid','warning','invalid','stale')),
  recorded_at timestamptz not null,
  received_at timestamptz not null default now(),
  metadata    jsonb not null default '{}'::jsonb
);
create index if not exists sensor_readings_sensor_time on public.sensor_readings (sensor_id, recorded_at desc);
create index if not exists sensor_readings_tenant_time on public.sensor_readings (tenant_id, recorded_at desc);
create table if not exists public.switch_states (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  device_id     uuid not null references public.devices(id) on delete cascade,
  command_id    uuid,
  requested     text,
  reported      text,
  source        text not null default 'cloud' check (source in ('cloud','device','automation','local','manual','physical')),
  actor_id      uuid references public.profiles(id),
  status        text not null default 'confirmed'
                check (status in ('pending','confirmed','failed','expired','superseded')),
  latency_ms    integer,
  recorded_at   timestamptz not null default now()
);
create index if not exists switch_states_device_time on public.switch_states (device_id, recorded_at desc);
create table if not exists public.device_commands (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  user_board_id uuid not null references public.user_boards(id) on delete cascade,
  component_type text not null check (component_type in ('device','sensor','board')),
  component_id  uuid,
  action        text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'queued'
                check (status in ('queued','published','acknowledged','failed','expired','rejected')),
  actor_id      uuid references public.profiles(id),
  idempotency_key text,
  expires_at    timestamptz not null,
  published_at  timestamptz,
  acknowledged_at timestamptz,
  error         text,
  created_at    timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);
create index if not exists device_commands_pending on public.device_commands (user_board_id, status)
  where status in ('queued','published');
create table if not exists public.device_configurations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  user_board_id uuid not null references public.user_boards(id) on delete cascade,
  version       integer not null,
  config        jsonb not null,
  checksum      text not null,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  unique (user_board_id, version)
);

create table if not exists public.automations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  name          text not null,
  description   text,
  enabled       boolean not null default true,
  mode          text not null default 'single' check (mode in ('single','restart','queued')),
  execution     text not null default 'cloud' check (execution in ('cloud','local','hybrid')),
  when_config   jsonb not null default '[]'::jsonb,
  conditions    jsonb not null default '[]'::jsonb,
  actions       jsonb not null default '[]'::jsonb,
  cooldown_s    integer not null default 0,
  last_run_at   timestamptz,
  last_result   text,
  run_count     integer not null default 0,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists automations_tenant on public.automations (tenant_id);
drop trigger if exists automations_touch on public.automations;
create trigger automations_touch before update on public.automations
  for each row execute function public.tg_set_updated_at();
create table if not exists public.automation_logs (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  automation_id uuid references public.automations(id) on delete cascade,
  trigger_kind text,
  status       text not null check (status in ('success','failed','skipped')),
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists automation_logs_tenant on public.automation_logs (tenant_id, created_at desc);
create table if not exists public.firmware_releases (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references public.tenants(id) on delete cascade,
  channel       text not null default 'stable' check (channel in ('stable','beta','dev')),
  version       text not null,
  chip_family   text not null default 'esp32',
  board_models  text[] not null default '{}',
  r2_key        text not null,
  size_bytes    bigint,
  sha256        text not null,
  min_app_version text,
  notes         text,
  rollout_pct   smallint not null default 100 check (rollout_pct between 0 and 100),
  mandatory     boolean not null default false,
  status        text not null default 'draft' check (status in ('draft','published','archived')),
  published_at  timestamptz,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now()
);
-- The version index is created further down, once every column it sorts on
-- exists (artifact_kind is added by the alter table block below). Creating it
-- here would fail on a fresh database.
drop index if exists public.firmware_release_version;
-- owner firmware console: exact image metadata, retirement trail and the
-- explicit owner control over whether a release may be installed over the air
alter table public.firmware_releases add column if not exists hw_config text;
alter table public.firmware_releases add column if not exists ota_eligible boolean not null default true;
alter table public.firmware_releases add column if not exists superseded_by uuid references public.firmware_releases(id) on delete set null;
alter table public.firmware_releases add column if not exists retired_reason text;
alter table public.firmware_releases add column if not exists retired_at timestamptz;
alter table public.firmware_releases add column if not exists retired_by uuid references public.profiles(id);
create table if not exists public.device_firmware_history (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  user_board_id uuid not null references public.user_boards(id) on delete cascade,
  firmware_release_id uuid references public.firmware_releases(id) on delete set null,
  from_version  text,
  to_version    text not null,
  status        text not null default 'queued'
                check (status in ('queued','downloading','installing','verifying','success','failed','rolled_back')),
  progress      smallint not null default 0,
  bytes_total   bigint,
  bytes_done    bigint,
  error         text,
  initiated_by  uuid references public.profiles(id),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists fw_history_board on public.device_firmware_history (user_board_id, started_at desc);
create table if not exists public.platform_settings (
  key         text primary key,
  value       jsonb not null,
  is_secret   boolean not null default false,
  updated_by  uuid references public.profiles(id),
  updated_at  timestamptz not null default now()
);
create table if not exists public.emqx_usage_snapshots (
  id             uuid primary key default gen_random_uuid(),
  period_start   timestamptz not null,
  period_end     timestamptz not null,
  granularity    text not null default 'day' check (granularity in ('hour','day','month')),
  source         text not null check (source in ('provider_api','owner_manual','provider_dashboard')),
  traffic_bytes  bigint,
  traffic_in_bytes  bigint,
  traffic_out_bytes bigint,
  packets        bigint,
  session_minutes bigint,
  connections_peak integer,
  messages       bigint,
  rule_actions   bigint,
  raw            jsonb not null default '{}'::jsonb,
  recorded_by    uuid references public.profiles(id),
  recorded_at    timestamptz not null default now(),
  unique (period_start, granularity, source)
);
create index if not exists emqx_usage_period on public.emqx_usage_snapshots (period_start desc);
create table if not exists public.emqx_sync_runs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('usage','health','credential','acl')),
  status      text not null check (status in ('success','partial','failed')),
  detail      jsonb not null default '{}'::jsonb,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  actor_id    uuid references public.profiles(id)
);
create table if not exists public.audit_logs (
  id          bigint generated always as identity primary key,
  tenant_id   uuid references public.tenants(id) on delete cascade,
  actor_id    uuid references public.profiles(id) on delete set null,
  actor_email text,
  actor_type  text not null default 'user' check (actor_type in ('user','device','system','platform_admin')),
  action      text not null,
  entity_type text,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists audit_logs_tenant on public.audit_logs (tenant_id, created_at desc);
create index if not exists audit_logs_action on public.audit_logs (action, created_at desc);
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  title       text not null,
  body        text,
  severity    text not null default 'info' check (severity in ('info','warning','critical')),
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create table if not exists public.system_announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null,
  severity    text not null default 'info' check (severity in ('info','warning','critical')),
  audience    text not null default 'all' check (audience in ('all','owners','admins')),
  active      boolean not null default true,
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
create table if not exists public.usage_counters (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  bucket      timestamptz not null,
  metric      text not null,
  value       bigint not null default 0,
  primary key (tenant_id, bucket, metric)
);

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
alter table public.emqx_usage_snapshots    enable row level security;
alter table public.emqx_sync_runs          enable row level security;
alter table public.audit_logs              enable row level security;
alter table public.notifications           enable row level security;
alter table public.system_announcements    enable row level security;
alter table public.usage_counters          enable row level security;
drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles for select
  using (id = current_profile_id() or public.is_platform_admin());
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update
  using (id = current_profile_id()) with check (id = current_profile_id());
drop policy if exists platform_admin_only_settings on public.platform_settings;
create policy platform_admin_only_settings on public.platform_settings for select using (public.is_platform_admin());
drop policy if exists platform_admin_only_admins on public.platform_admins;
create policy platform_admin_only_admins on public.platform_admins for select using (public.is_platform_admin());
drop policy if exists platform_admin_only_usage on public.emqx_usage_snapshots;
create policy platform_admin_only_usage on public.emqx_usage_snapshots for select using (public.is_platform_admin());
drop policy if exists platform_admin_only_sync on public.emqx_sync_runs;
create policy platform_admin_only_sync on public.emqx_sync_runs for select using (public.is_platform_admin());
drop policy if exists platform_admin_only_audit on public.audit_logs;
create policy platform_admin_only_audit on public.audit_logs for select
  using (public.is_platform_admin() or (tenant_id is not null and public.is_tenant_member(tenant_id)));
drop policy if exists catalog_read on public.board_catalog;
create policy catalog_read on public.board_catalog for select using (true);
drop policy if exists catalog_versions_read on public.board_catalog_versions;
create policy catalog_versions_read on public.board_catalog_versions for select using (true);
drop policy if exists catalog_pins_read on public.board_catalog_pins;
create policy catalog_pins_read on public.board_catalog_pins for select using (true);
drop policy if exists permissions_read on public.permissions;
create policy permissions_read on public.permissions for select using (true);
drop policy if exists roles_read on public.roles;
create policy roles_read on public.roles for select using (tenant_id is null or public.is_tenant_member(tenant_id));
drop policy if exists role_permissions_read on public.role_permissions;
create policy role_permissions_read on public.role_permissions for select
  using (exists (select 1 from roles r where r.id = role_id and (r.tenant_id is null or public.is_tenant_member(r.tenant_id))));
drop policy if exists announcements_read on public.system_announcements;
create policy announcements_read on public.system_announcements for select using (true);
drop policy if exists device_templates_read on public.device_templates;
create policy device_templates_read on public.device_templates for select
  using (tenant_id is null or public.is_tenant_member(tenant_id));
drop policy if exists firmware_read on public.firmware_releases;
create policy firmware_read on public.firmware_releases for select
  using (tenant_id is null or public.is_tenant_member(tenant_id));
drop policy if exists tenants_member on public.tenants;
create policy tenants_member on public.tenants for select
  using (public.is_tenant_member(id) or public.is_platform_admin());
drop policy if exists members_read on public.tenant_members;
create policy members_read on public.tenant_members for select
  using (public.is_tenant_member(tenant_id));
drop policy if exists member_perms_read on public.member_permissions;
create policy member_perms_read on public.member_permissions for select
  using (public.is_tenant_member(tenant_id));
drop policy if exists member_rules_read on public.member_access_rules;
create policy member_rules_read on public.member_access_rules for select
  using (public.is_tenant_member(tenant_id));
drop policy if exists invitations_read on public.staff_invitations;
create policy invitations_read on public.staff_invitations for select
  using (public.is_tenant_member(tenant_id) and public.tenant_role(tenant_id) = 'owner');
drop policy if exists rooms_rw on public.rooms;
create policy rooms_rw on public.rooms for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'rooms.manage') or public.tenant_role(tenant_id) = 'owner');
drop policy if exists boards_rw on public.user_boards;
create policy boards_rw on public.user_boards for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'boards.manage') or public.tenant_role(tenant_id) = 'owner');
drop policy if exists board_pins_rw on public.board_pins;
create policy board_pins_rw on public.board_pins for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'boards.manage') or public.tenant_role(tenant_id) = 'owner');
drop policy if exists pairing_tokens_rw on public.device_pairing_tokens;
create policy pairing_tokens_rw on public.device_pairing_tokens for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'devices.manage') or public.tenant_role(tenant_id) = 'owner');
drop policy if exists mqtt_creds_read on public.mqtt_credentials_metadata;
create policy mqtt_creds_read on public.mqtt_credentials_metadata for select
  using (false);
drop policy if exists buses_rw on public.shared_buses;
create policy buses_rw on public.shared_buses for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'devices.manage') or public.tenant_role(tenant_id) = 'owner');
drop policy if exists allocations_rw on public.exclusive_allocations;
create policy allocations_rw on public.exclusive_allocations for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'devices.manage') or public.tenant_role(tenant_id) = 'owner');
drop policy if exists devices_rw on public.devices;
create policy devices_rw on public.devices for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'devices.manage') or public.tenant_role(tenant_id) = 'owner');
drop policy if exists sensors_rw on public.sensors;
create policy sensors_rw on public.sensors for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'devices.manage') or public.tenant_role(tenant_id) = 'owner');
drop policy if exists readings_read on public.sensor_readings;
create policy readings_read on public.sensor_readings for select using (public.is_tenant_member(tenant_id));
drop policy if exists switch_states_read on public.switch_states;
create policy switch_states_read on public.switch_states for select using (public.is_tenant_member(tenant_id));
drop policy if exists device_commands_read on public.device_commands;
create policy device_commands_read on public.device_commands for select using (public.is_tenant_member(tenant_id));
drop policy if exists configs_read on public.device_configurations;
create policy configs_read on public.device_configurations for select using (public.is_tenant_member(tenant_id));
drop policy if exists automations_rw on public.automations;
create policy automations_rw on public.automations for all
  using (public.is_tenant_member(tenant_id))
  with check (public.has_permission(tenant_id, 'automation.manage') or public.tenant_role(tenant_id) = 'owner');
drop policy if exists automation_logs_read on public.automation_logs;
create policy automation_logs_read on public.automation_logs for select using (public.is_tenant_member(tenant_id));
drop policy if exists fw_history_read on public.device_firmware_history;
create policy fw_history_read on public.device_firmware_history for select using (public.is_tenant_member(tenant_id));
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select using (public.is_tenant_member(tenant_id));
drop policy if exists usage_counters_read on public.usage_counters;
create policy usage_counters_read on public.usage_counters for select using (public.is_tenant_member(tenant_id));
grant usage on schema public to anon, authenticated, service_role;
grant select on all tables in schema public to anon, authenticated, service_role;
grant insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
revoke all on public.mqtt_credentials_metadata from anon, authenticated;
revoke all on public.member_permissions, public.member_access_rules, public.staff_invitations,
            public.device_pairing_tokens, public.platform_settings, public.platform_admins,
            public.emqx_usage_snapshots, public.emqx_sync_runs, public.usage_counters,
            public.audit_logs from anon, authenticated;
grant execute on function public.current_profile_id(), public.is_tenant_member(uuid),
  public.tenant_role(uuid), public.has_permission(uuid,text), public.is_platform_admin(),
  public.can_access_room(uuid,uuid) to anon, authenticated, service_role;
revoke execute on function public.assign_pin_exclusive(uuid,uuid,integer,text,uuid,text,uuid),
  public.release_allocations_for_owner(text,uuid),
  public.member_id_for(uuid) from public, anon, authenticated;
grant execute on function public.assign_pin_exclusive(uuid,uuid,integer,text,uuid,text,uuid),
  public.release_allocations_for_owner(text,uuid), public.member_id_for(uuid) to service_role;
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

insert into public.permissions (key, category, label, description, sort_order) values
 ('dashboard.view',        'Dashboard access',      'View dashboard',           'Read the home overview and live status', 10),
 ('rooms.manage',          'Room management',       'Manage rooms',             'Create, edit and archive rooms', 20),
 ('boards.manage',         'Board management',      'Manage controllers',       'Register boards and edit pin assignments', 30),
 ('devices.manage',        'Device management',     'Manage devices',           'Create, edit and delete switches and sensors', 40),
 ('devices.control',       'Switch control',        'Control switches',         'Send ON/OFF commands to devices', 50),
 ('sensors.view',          'Sensor monitoring',     'View sensor telemetry',    'Read sensor values and history', 60),
 ('automation.manage',     'Automation management', 'Manage automation',        'Create, edit and run automations', 70),
 ('devices.configure',     'Device configuration',  'Configure devices',        'Change firmware config, mappings and sync', 80),
 ('firmware.update',       'Firmware updates',      'Manage firmware',          'Publish releases and start OTA updates', 90),
 ('staff.manage',          'Staff management',      'Manage staff',             'Invite, remove and change staff permissions', 100),
 ('usage.view',            'Usage viewing',         'View usage',               'View account usage estimates', 110),
 ('settings.manage',       'Account settings',      'Manage account settings',  'Change home, security and notification settings', 120)
on conflict (key) do nothing;
insert into public.roles (tenant_id, key, name, description, rank, is_system) values
 (null,'owner',        'Owner',        'Complete workspace access', 0,   true),
 (null,'administrator','Administrator','Manage home hardware and automation', 10, true),
 (null,'operator',     'Operator',     'Control permitted devices', 20,  true),
 (null,'viewer',       'Viewer',       'Read-only access', 30, true)
on conflict do nothing;
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r cross join public.permissions p
where r.tenant_id is null and (
  r.key = 'owner'
  or (r.key = 'administrator' and p.key <> all (array['staff.manage','settings.manage']))
  or (r.key = 'operator' and p.key = any (array['dashboard.view','devices.control','sensors.view','automation.manage']))
  or (r.key = 'viewer' and p.key = any (array['dashboard.view','sensors.view']))
)
on conflict do nothing;
insert into public.device_templates (tenant_id, key, name, device_type, icon, default_config, is_system) values
 (null,'light',        'Light',          'light',       'lightbulb', '{"initial_state":"off","active_low":false,"interface":"gpio"}'::jsonb, true),
 (null,'fan',          'Fan',            'fan',         'fan',       '{"initial_state":"off","active_low":false,"interface":"gpio"}'::jsonb, true),
 (null,'water_pump',   'Water pump',     'water_pump',  'droplet',   '{"initial_state":"off","active_low":false,"interface":"gpio"}'::jsonb, true),
 (null,'relay',        'Relay',          'relay',       'power',     '{"initial_state":"off","active_low":false,"interface":"gpio"}'::jsonb, true),
 (null,'smart_socket', 'Smart socket',   'smart_socket','plug',      '{"initial_state":"off","active_low":false,"interface":"gpio"}'::jsonb, true),
 (null,'motor',        'Motor',          'motor',       'cog',       '{"initial_state":"off","active_low":false,"interface":"gpio"}'::jsonb, true),
 (null,'main_line',    'Main line monitor','main_line_monitor','activity','{"interface":"adc"}'::jsonb, true)
on conflict do nothing;
insert into public.platform_settings (key, value, is_secret) values
 ('mqtt.provider',            '"emqx"'::jsonb, false),
 ('mqtt.broker_host',         '""'::jsonb, false),
 ('mqtt.port_tls',            '8883'::jsonb, false),
 ('mqtt.wss_host',            '""'::jsonb, false),
 ('mqtt.wss_port',            '8084'::jsonb, false),
 ('mqtt.deployment_endpoint', '""'::jsonb, false),
 ('mqtt.last_sync_at',        'null'::jsonb, false),
 ('registration.enabled',     'true'::jsonb, false),
 ('registration.pairing_ttl_seconds', '900'::jsonb, false),
 ('registration.rate_limit_per_hour', '10'::jsonb, false),
 ('features.ota',             'true'::jsonb, false),
 ('features.automation',      'true'::jsonb, false),
 ('features.custom_boards',   'true'::jsonb, false),
 ('features.staff_invites',   'true'::jsonb, false),
 ('security.command_ttl_seconds', '30'::jsonb, false),
 ('security.cmd_rate_limit_per_minute', '60'::jsonb, false),
 ('usage.warning_thresholds', '[50,75,90,100]'::jsonb, false),
 ('usage.quotas', '{"session_minutes":1000000,"traffic_bytes":1073741824,"rule_actions":1000000,"connections":1000}'::jsonb, false)
on conflict (key) do nothing;

insert into public.board_catalog (id, manufacturer, model, variant, chip_family, chip_variant, revision, category, image_url, pinout_url, doc_source_url, summary, connectivity, attributes, active) values
  ('espressif.esp32-devkitc-v4.wroom32e', 'Espressif', 'ESP32-DevKitC V4', 'ESP32-WROOM-32E / 32UE', 'ESP32', 'ESP32-WROOM-32E', 'V4', 'devkit', null, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/_images/esp32_devkitC_v4_pinlayout.png', 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html', 'Dual-core ESP32 classic devkit. 38-pin headers; GPIO6–11 are consumed by internal SPI flash.', '{}'::jsonb, '{"flash_mb":4,"psram_mb":0,"wifi":"2.4 GHz","ble":"BLE 4.2","cores":2,"usb":"USB-to-UART bridge","pin_status":"verified","catalog_version":1}'::jsonb, true),
  ('espressif.esp32-s3-devkitc-1.v1.1', 'Espressif', 'ESP32-S3-DevKitC-1', 'N8 / N16R8 / N32R16V', 'ESP32-S3', 'ESP32-S3-WROOM-1', 'v1.1', 'devkit', null, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/_images/ESP32-S3_DevKitC-1_pinlayout_v1.1.jpg', 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html', '44-pin dual headers, AI-vector instructions, native USB-OTG. Octal-PSRAM variants reserve GPIO35–37.', '{}'::jsonb, '{"flash_mb":"8/16/32","psram_mb":"0/2/8/16 (variant dependent)","wifi":"2.4 GHz","ble":"BLE 5","cores":2,"usb":"USB-OTG + USB-to-UART","pin_status":"verified","catalog_version":1}'::jsonb, true),
  ('espressif.esp32-s3-devkitc-1.n16r8', 'Espressif', 'ESP32-S3-DevKitC-1 N16R8', 'N16R8 (16 MB flash + 8 MB octal PSRAM)', 'ESP32-S3', 'ESP32-S3-WROOM-1-N16R8', 'v1.1', 'devkit', null, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/_images/ESP32-S3_DevKitC-1_pinlayout_v1.1.jpg', 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html', 'The N16R8 module used by HomecoreOS controllers: 16 MB quad flash and 8 MB octal PSRAM, so GPIO35–37 are consumed by the PSRAM and never available on the headers.', '{}'::jsonb, '{"flash_mb":16,"psram_mb":8,"psram_type":"octal","wifi":"2.4 GHz","ble":"BLE 5","cores":2,"usb":"USB-OTG + USB-to-UART","pin_status":"verified","catalog_version":1}'::jsonb, true),
  ('espressif.esp32-c3-devkitm-1.v1', 'Espressif', 'ESP32-C3-DevKitM-1', 'ESP32-C3-MINI-1 (N4X)', 'ESP32-C3', 'ESP32-C3-MINI-1', 'v1.0', 'devkit', null, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c3/_images/esp32-c3-devkitm-1-v1-pinout.png', 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c3/esp32-c3-devkitm-1/user_guide.html', 'Compact RISC-V board. Flash SPI pins are not broken out; GPIO9 is the BOOT button.', '{}'::jsonb, '{"flash_mb":4,"psram_mb":0,"wifi":"2.4 GHz","ble":"BLE 5","cores":1,"usb":"USB Serial/JTAG","pin_status":"verified","catalog_version":1}'::jsonb, true),
  ('espressif.esp32-c6-devkitc-1.v1.2', 'Espressif', 'ESP32-C6-DevKitC-1', 'ESP32-C6-WROOM-1', 'ESP32-C6', 'ESP32-C6-WROOM-1', 'v1.2', 'devkit', null, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c6/_images/esp32-c6-devkitc-1-pin-layout.png', 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c6/esp32-c6-devkitc-1/user_guide.html', 'Wi-Fi 6 / Thread / Zigbee RISC-V devkit with two USB-C ports and J5 current-measurement header.', '{}'::jsonb, '{"flash_mb":4,"psram_mb":0,"wifi":"2.4 GHz Wi-Fi 6","ieee802154":true,"cores":1,"usb":"USB Serial/JTAG","pin_status":"verified","catalog_version":1}'::jsonb, true),
  ('family.esp32s2', 'Espressif', 'ESP32-S2 family', 'ESP32-S2', 'ESP32-S2', 'ESP32-S2', null, 'chip_family', null, null, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s2/index.html', 'Single-core USB-OTG capable ESP32 variant.', '{}'::jsonb, '{"note":"Chip family entry. A verified dev-board header map is required before GPIO allocation.","pin_status":"pending_verification","catalog_version":1}'::jsonb, true),
  ('family.esp32c2', 'Espressif', 'ESP32-C2 family', 'ESP32-C2', 'ESP32-C2', 'ESP32-C2', null, 'chip_family', null, null, 'https://www.espressif.com/en/products/socs/esp32-c2', 'Cost-optimised RISC-V Wi-Fi + BLE variant.', '{}'::jsonb, '{"note":"Chip family entry. A verified dev-board header map is required before GPIO allocation.","pin_status":"pending_verification","catalog_version":1}'::jsonb, true),
  ('family.esp32c5', 'Espressif', 'ESP32-C5 family', 'ESP32-C5', 'ESP32-C5', 'ESP32-C5', null, 'chip_family', null, null, 'https://www.espressif.com/en/products/socs/esp32-c5', 'Dual-band Wi-Fi 6 RISC-V variant.', '{}'::jsonb, '{"note":"Chip family entry. A verified dev-board header map is required before GPIO allocation.","pin_status":"pending_verification","catalog_version":1}'::jsonb, true),
  ('family.esp32h2', 'Espressif', 'ESP32-H2 family', 'ESP32-H2', 'ESP32-H2', 'ESP32-H2', null, 'chip_family', null, null, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32h2/index.html', 'Thread / Zigbee / BLE SoC without Wi-Fi.', '{}'::jsonb, '{"note":"Chip family entry. A verified dev-board header map is required before GPIO allocation.","pin_status":"pending_verification","catalog_version":1}'::jsonb, true),
  ('family.esp32p4', 'Espressif', 'ESP32-P4 family', 'ESP32-P4', 'ESP32-P4', 'ESP32-P4', null, 'chip_family', null, null, 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32p4/index.html', 'High-performance MCU with no on-chip wireless; needs a host radio.', '{}'::jsonb, '{"note":"Chip family entry. A verified dev-board header map is required before GPIO allocation.","pin_status":"pending_verification","catalog_version":1}'::jsonb, true)
on conflict (id) do update set manufacturer = excluded.manufacturer, model = excluded.model, variant = excluded.variant, chip_family = excluded.chip_family, chip_variant = excluded.chip_variant, revision = excluded.revision, summary = excluded.summary, pinout_url = excluded.pinout_url, doc_source_url = excluded.doc_source_url, attributes = excluded.attributes, updated_at = now();
insert into public.board_catalog_versions (board_id, version, changelog, published) values
  ('espressif.esp32-devkitc-v4.wroom32e', 1, 'Initial verified header-pin map from official Espressif user guide.', true),
  ('espressif.esp32-s3-devkitc-1.v1.1', 1, 'Initial verified header-pin map from official Espressif user guide.', true),
  ('espressif.esp32-s3-devkitc-1.n16r8', 1, 'N16R8 module registered with the verified DevKitC-1 header map; GPIO35–37 are reserved for octal PSRAM.', true),
  ('espressif.esp32-c3-devkitm-1.v1', 1, 'Initial verified header-pin map from official Espressif user guide.', true),
  ('espressif.esp32-c6-devkitc-1.v1.2', 1, 'Initial verified header-pin map from official Espressif user guide.', true),
  ('family.esp32s2', 1, 'Chip family registered; dev-board pin map pending verification.', true),
  ('family.esp32c2', 1, 'Chip family registered; dev-board pin map pending verification.', true),
  ('family.esp32c5', 1, 'Chip family registered; dev-board pin map pending verification.', true),
  ('family.esp32h2', 1, 'Chip family registered; dev-board pin map pending verification.', true),
  ('family.esp32p4', 1, 'Chip family registered; dev-board pin map pending verification.', true)
on conflict (board_id, version) do nothing;
insert into public.board_catalog_pins (board_id, gpio, header_label, side, header_pin, functions, adc_channels, adc_bits, input_only, exposed, boot_strapping, usb_jtag, flash_connected, psram_connected, touch_channel, rtc_gpio, restricted, restriction_note, notes) values
  ('espressif.esp32-devkitc-v4.wroom32e', 36, 'VP', 'J2', 3, array['gpio','adc','rtc']::text[], array['ADC1_CH0']::text[], 12, true, true, false, false, false, false, null, true, false, null, 'ADC2 channels cannot be used while Wi-Fi is active on this chip; prefer ADC1 for analog sensors.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 39, 'VN', 'J2', 4, array['gpio','adc','rtc']::text[], array['ADC1_CH3']::text[], 12, true, true, false, false, false, false, null, true, false, null, null),
  ('espressif.esp32-devkitc-v4.wroom32e', 34, 'IO34', 'J2', 5, array['gpio','adc','rtc']::text[], array['ADC1_CH6']::text[], 12, true, true, false, false, false, false, null, true, false, null, null),
  ('espressif.esp32-devkitc-v4.wroom32e', 35, 'IO35', 'J2', 6, array['gpio','adc','rtc']::text[], array['ADC1_CH7']::text[], 12, true, true, false, false, false, false, null, true, false, null, null),
  ('espressif.esp32-devkitc-v4.wroom32e', 32, 'IO32', 'J2', 7, array['gpio','pwm','i2c','spi','uart','adc','dac']::text[], array['ADC1_CH4']::text[], 12, false, true, false, false, false, false, 'TOUCH9', true, false, null, null),
  ('espressif.esp32-devkitc-v4.wroom32e', 33, 'IO33', 'J2', 8, array['gpio','pwm','i2c','spi','uart','adc','dac']::text[], array['ADC1_CH5']::text[], 12, false, true, false, false, false, false, 'TOUCH8', true, false, null, null),
  ('espressif.esp32-devkitc-v4.wroom32e', 25, 'IO25', 'J2', 9, array['gpio','pwm','i2c','spi','uart','adc','dac']::text[], array['ADC2_CH8']::text[], 12, false, true, false, false, false, false, null, false, false, null, 'ADC2 channels cannot be used while Wi-Fi is active on this chip; prefer ADC1 for analog sensors.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 26, 'IO26', 'J2', 10, array['gpio','pwm','i2c','spi','uart','adc','dac']::text[], array['ADC2_CH9']::text[], 12, false, true, false, false, false, false, null, false, false, null, 'ADC2 channels cannot be used while Wi-Fi is active on this chip; prefer ADC1 for analog sensors.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 27, 'IO27', 'J2', 11, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC2_CH7']::text[], 12, false, true, false, false, false, false, 'TOUCH7', false, false, null, 'ADC2 channels cannot be used while Wi-Fi is active on this chip; prefer ADC1 for analog sensors.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 14, 'IO14', 'J2', 12, array['gpio','pwm','i2c','spi','uart','adc','jtag']::text[], array['ADC2_CH6']::text[], 12, false, true, false, false, false, false, 'TOUCH6', false, false, null, 'ADC2 channels cannot be used while Wi-Fi is active on this chip; prefer ADC1 for analog sensors.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 12, 'IO12', 'J2', 13, array['gpio','pwm','i2c','spi','uart','adc','jtag']::text[], array['ADC2_CH5']::text[], 12, false, true, true, false, false, false, 'TOUCH5', false, false, null, 'MTDI strapping pin: must be low at boot on 3.3 V flash modules; avoid as a relay output.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 13, 'IO13', 'J2', 15, array['gpio','pwm','i2c','spi','uart','adc','jtag']::text[], array['ADC2_CH4']::text[], 12, false, true, false, false, false, false, 'TOUCH4', false, false, null, 'ADC2 channels cannot be used while Wi-Fi is active on this chip; prefer ADC1 for analog sensors.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 9, 'D2', 'J2', 16, array['flash']::text[], array[]::text[], null, false, true, false, false, true, false, null, false, true, 'Connected to internal SPI flash (D2); not usable as GPIO on WROOM-32E modules.', null),
  ('espressif.esp32-devkitc-v4.wroom32e', 10, 'D3', 'J2', 17, array['flash']::text[], array[]::text[], null, false, true, false, false, true, false, null, false, true, 'Connected to internal SPI flash (D3); not usable as GPIO on WROOM-32E modules.', null),
  ('espressif.esp32-devkitc-v4.wroom32e', 11, 'CMD', 'J2', 18, array['flash']::text[], array[]::text[], null, false, true, false, false, true, false, null, false, true, 'Connected to internal SPI flash (CMD); not usable as GPIO.', null),
  ('espressif.esp32-devkitc-v4.wroom32e', 23, 'IO23', 'J3', 2, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, null),
  ('espressif.esp32-devkitc-v4.wroom32e', 22, 'IO22', 'J3', 3, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, null),
  ('espressif.esp32-devkitc-v4.wroom32e', 1, 'TX', 'J3', 4, array['gpio','uart','pwm']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'U0TXD — connected to the on-board USB-to-UART bridge; avoid for other uses while flashing or logging.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 3, 'RX', 'J3', 5, array['gpio','uart','pwm']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'U0RXD — connected to the on-board USB-to-UART bridge.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 21, 'IO21', 'J3', 6, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, null),
  ('espressif.esp32-devkitc-v4.wroom32e', 19, 'IO19', 'J3', 8, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, null),
  ('espressif.esp32-devkitc-v4.wroom32e', 18, 'IO18', 'J3', 9, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, null),
  ('espressif.esp32-devkitc-v4.wroom32e', 5, 'IO5', 'J3', 10, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, true, false, false, false, null, false, false, null, 'Strapping pin (SDIO slave / VDD_SDIO timing); state at boot matters. Verify before driving a relay.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 17, 'IO17', 'J3', 11, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, true, null, false, false, null, 'Used by PSRAM on WROVER-E / WROVER-IE variants. Available on WROOM-32E / WROOM-32UE only.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 16, 'IO16', 'J3', 12, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, true, null, false, false, null, 'Used by PSRAM on WROVER-E / WROVER-IE variants. Available on WROOM-32E / WROOM-32UE only.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 4, 'IO4', 'J3', 13, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC2_CH0']::text[], 12, false, true, true, false, false, false, 'TOUCH0', false, false, null, 'ADC2 channels cannot be used while Wi-Fi is active on this chip; prefer ADC1 for analog sensors.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 0, 'IO0', 'J3', 14, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC2_CH1']::text[], 12, false, true, true, false, false, false, 'TOUCH1', false, false, null, 'Boot button strapping pin. Must be high to run normally; driving it low at reset enters download mode.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 2, 'IO2', 'J3', 15, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC2_CH2']::text[], 12, false, true, true, false, false, false, 'TOUCH2', false, false, null, 'ADC2 channels cannot be used while Wi-Fi is active on this chip; prefer ADC1 for analog sensors.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 15, 'IO15', 'J3', 16, array['gpio','pwm','i2c','spi','uart','adc','jtag']::text[], array['ADC2_CH3']::text[], 12, false, true, true, false, false, false, 'TOUCH3', false, false, null, 'MTDO strapping pin; must be high at boot for normal SDIO operation.'),
  ('espressif.esp32-devkitc-v4.wroom32e', 8, 'D1', 'J3', 17, array['flash']::text[], array[]::text[], null, false, true, false, false, true, false, null, false, true, 'Connected to internal SPI flash (D1); not usable as GPIO.', null),
  ('espressif.esp32-devkitc-v4.wroom32e', 7, 'D0', 'J3', 18, array['flash']::text[], array[]::text[], null, false, true, false, false, true, false, null, false, true, 'Connected to internal SPI flash (D0); not usable as GPIO.', null),
  ('espressif.esp32-devkitc-v4.wroom32e', 6, 'CLK', 'J3', 19, array['flash']::text[], array[]::text[], null, false, true, false, false, true, false, null, false, true, 'Connected to internal SPI flash (CLK); not usable as GPIO.', null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 4, '4', 'J1', 4, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC1_CH3']::text[], 12, false, true, false, false, false, false, 'TOUCH4', true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 5, '5', 'J1', 5, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC1_CH4']::text[], 12, false, true, false, false, false, false, 'TOUCH5', true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 6, '6', 'J1', 6, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC1_CH5']::text[], 12, false, true, false, false, false, false, 'TOUCH6', true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 7, '7', 'J1', 7, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC1_CH6']::text[], 12, false, true, false, false, false, false, 'TOUCH7', true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 15, '15', 'J1', 8, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC2_CH4']::text[], 12, false, true, false, false, false, false, null, true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 16, '16', 'J1', 9, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC2_CH5']::text[], 12, false, true, false, false, false, false, null, true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 17, '17', 'J1', 10, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC2_CH6']::text[], 12, false, true, false, false, false, false, null, true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 18, '18', 'J1', 11, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC2_CH7']::text[], 12, false, true, false, false, false, false, null, true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 8, '8', 'J1', 12, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC1_CH7']::text[], 12, false, true, false, false, false, false, 'TOUCH8', true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 3, '3', 'J1', 13, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC1_CH2']::text[], 12, false, true, true, false, false, false, 'TOUCH3', true, false, null, 'Strapping pin on ESP32-S3 (JTAG signal source). Verify boot state before use.'),
  ('espressif.esp32-s3-devkitc-1.v1.1', 46, '46', 'J1', 14, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, true, false, false, false, null, false, false, null, 'Strapping pin: selects VDD_SPI source and controls ROM log printing.'),
  ('espressif.esp32-s3-devkitc-1.v1.1', 9, '9', 'J1', 15, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC1_CH8']::text[], 12, false, true, false, false, false, false, 'TOUCH9', true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 10, '10', 'J1', 16, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC1_CH9']::text[], 12, false, true, false, false, false, false, 'TOUCH10', true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 11, '11', 'J1', 17, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC2_CH0']::text[], 12, false, true, false, false, false, false, 'TOUCH11', true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 12, '12', 'J1', 18, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC2_CH1']::text[], 12, false, true, false, false, false, false, 'TOUCH12', true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 13, '13', 'J1', 19, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC2_CH2']::text[], 12, false, true, false, false, false, false, 'TOUCH13', true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 14, '14', 'J1', 20, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC2_CH3']::text[], 12, false, true, false, false, false, false, 'TOUCH14', true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 43, 'TX', 'J3', 2, array['gpio','uart','pwm']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'U0TXD — USB-to-UART bridge; reserved while flashing/logging.'),
  ('espressif.esp32-s3-devkitc-1.v1.1', 44, 'RX', 'J3', 3, array['gpio','uart','pwm']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'U0RXD — USB-to-UART bridge.'),
  ('espressif.esp32-s3-devkitc-1.v1.1', 1, '1', 'J3', 4, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC1_CH0']::text[], 12, false, true, false, false, false, false, 'TOUCH1', true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 2, '2', 'J3', 5, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC1_CH1']::text[], 12, false, true, false, false, false, false, 'TOUCH2', true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 42, '42', 'J3', 6, array['gpio','pwm','i2c','spi','uart','jtag']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'MTMS (JTAG).'),
  ('espressif.esp32-s3-devkitc-1.v1.1', 41, '41', 'J3', 7, array['gpio','pwm','i2c','spi','uart','jtag']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'MTDI (JTAG).'),
  ('espressif.esp32-s3-devkitc-1.v1.1', 40, '40', 'J3', 8, array['gpio','pwm','i2c','spi','uart','jtag']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'MTDO (JTAG).'),
  ('espressif.esp32-s3-devkitc-1.v1.1', 39, '39', 'J3', 9, array['gpio','pwm','i2c','spi','uart','jtag']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'MTCK (JTAG).'),
  ('espressif.esp32-s3-devkitc-1.v1.1', 38, '38', 'J3', 10, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'Drives the addressable RGB LED on some DevKitC-1 variants; check your module.'),
  ('espressif.esp32-s3-devkitc-1.v1.1', 37, '37', 'J3', 11, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, true, null, false, false, null, 'SPIDQS / FSPIIO — occupied by octal SPI flash/PSRAM on N16R8 and N32R16V variants. Verify your module before assigning.'),
  ('espressif.esp32-s3-devkitc-1.v1.1', 36, '36', 'J3', 12, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, true, null, false, false, null, 'FSPICLK — occupied by octal SPI flash/PSRAM on N16R8 and N32R16V variants.'),
  ('espressif.esp32-s3-devkitc-1.v1.1', 35, '35', 'J3', 13, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, true, null, false, false, null, 'FSPID — occupied by octal SPI flash/PSRAM on N16R8 and N32R16V variants.'),
  ('espressif.esp32-s3-devkitc-1.v1.1', 0, '0', 'J3', 14, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, true, false, false, false, null, true, false, null, 'Boot strapping pin (BOOT button).'),
  ('espressif.esp32-s3-devkitc-1.v1.1', 45, '45', 'J3', 15, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, true, false, false, false, null, false, false, null, 'Strapping pin: VDD_SPI voltage selection.'),
  ('espressif.esp32-s3-devkitc-1.v1.1', 48, '48', 'J3', 16, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 47, '47', 'J3', 17, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 21, '21', 'J3', 18, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, true, false, null, null),
  ('espressif.esp32-s3-devkitc-1.v1.1', 20, '20', 'J3', 19, array['gpio','pwm','i2c','spi','uart','usb']::text[], array['ADC2_CH9']::text[], 12, false, true, false, true, false, false, null, true, false, null, 'USB_D+ on ESP32-S3; do not use as GPIO when native USB is active.'),
  ('espressif.esp32-s3-devkitc-1.v1.1', 19, '19', 'J3', 20, array['gpio','pwm','i2c','spi','uart','usb']::text[], array['ADC2_CH8']::text[], 12, false, true, false, true, false, false, null, true, false, null, 'USB_D- on ESP32-S3; do not use as GPIO when native USB is active.'),
  ('espressif.esp32-c3-devkitm-1.v1', 2, 'IO2', 'J1', 4, array['gpio','pwm','i2c','spi','uart']::text[], array['ADC1_CH2']::text[], 12, false, true, true, false, false, false, null, false, false, null, 'Strapping pin (FSPIQ); also ADC1_CH2. Boot state matters.'),
  ('espressif.esp32-c3-devkitm-1.v1', 3, 'IO3', 'J1', 5, array['gpio','pwm','i2c','spi','uart']::text[], array['ADC1_CH3']::text[], 12, false, true, false, false, false, false, null, false, false, null, null),
  ('espressif.esp32-c3-devkitm-1.v1', 0, 'IO0', 'J1', 9, array['gpio','pwm','i2c','spi','uart']::text[], array['ADC1_CH0']::text[], 12, false, true, false, false, false, false, null, false, false, null, 'XTAL_32K_P; usable as GPIO with care.'),
  ('espressif.esp32-c3-devkitm-1.v1', 1, 'IO1', 'J1', 10, array['gpio','pwm','i2c','spi','uart']::text[], array['ADC1_CH1']::text[], 12, false, true, false, false, false, false, null, false, false, null, 'XTAL_32K_N; usable as GPIO with care.'),
  ('espressif.esp32-c3-devkitm-1.v1', 10, 'IO10', 'J1', 11, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'FSPICS0; typically free on MINI-1 modules.'),
  ('espressif.esp32-c3-devkitm-1.v1', 21, 'TX', 'J3', 2, array['gpio','uart','pwm']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'U0TXD — USB-to-UART bridge.'),
  ('espressif.esp32-c3-devkitm-1.v1', 20, 'RX', 'J3', 3, array['gpio','uart','pwm']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'U0RXD — USB-to-UART bridge.'),
  ('espressif.esp32-c3-devkitm-1.v1', 9, 'IO9', 'J3', 5, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, true, false, false, false, null, false, true, 'Connected to the BOOT button and is a strapping pin; held low to enter download mode. Not usable as a general output.', null),
  ('espressif.esp32-c3-devkitm-1.v1', 8, 'IO8', 'J3', 6, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, true, false, false, false, null, false, false, null, 'Drives the on-board addressable RGB LED and is a strapping pin. Usable but must be high at boot.'),
  ('espressif.esp32-c3-devkitm-1.v1', 7, 'IO7', 'J3', 8, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'FSPID / MTDO.'),
  ('espressif.esp32-c3-devkitm-1.v1', 6, 'IO6', 'J3', 9, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'FSPICLK / MTCK.'),
  ('espressif.esp32-c3-devkitm-1.v1', 5, 'IO5', 'J3', 10, array['gpio','pwm','i2c','spi','uart']::text[], array['ADC2_CH0']::text[], 12, false, true, false, false, false, false, null, false, false, null, 'FSPIWP / MTDI; ADC2_CH0.'),
  ('espressif.esp32-c3-devkitm-1.v1', 4, 'IO4', 'J3', 11, array['gpio','pwm','i2c','spi','uart']::text[], array['ADC1_CH4']::text[], 12, false, true, false, false, false, false, null, false, false, null, 'FSPIHD / MTMS; ADC1_CH4.'),
  ('espressif.esp32-c3-devkitm-1.v1', 18, 'IO18', 'J3', 13, array['gpio','pwm','i2c','spi','uart','usb']::text[], array[]::text[], null, false, true, false, true, false, false, null, false, false, null, 'USB_D- on ESP32-C3; unavailable as GPIO when native USB is in use.'),
  ('espressif.esp32-c3-devkitm-1.v1', 19, 'IO19', 'J3', 14, array['gpio','pwm','i2c','spi','uart','usb']::text[], array[]::text[], null, false, true, false, true, false, false, null, false, false, null, 'USB_D+ on ESP32-C3; unavailable as GPIO when native USB is in use.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 4, '4', 'J1', 3, array['gpio','pwm','i2c','spi','uart','adc','jtag']::text[], array['ADC1_CH4']::text[], 12, false, true, false, false, false, false, null, false, false, null, 'MTMS / LP_UART_RXD / FSPIHD.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 5, '5', 'J1', 4, array['gpio','pwm','i2c','spi','uart','adc','jtag']::text[], array['ADC1_CH5']::text[], 12, false, true, false, false, false, false, null, false, false, null, 'MTDI / LP_UART_TXD / FSPIWP.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 6, '6', 'J1', 5, array['gpio','pwm','i2c','spi','uart','adc','jtag']::text[], array['ADC1_CH6']::text[], 12, false, true, false, false, false, false, null, false, false, null, 'MTCK / LP_I2C_SDA / FSPICLK.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 7, '7', 'J1', 6, array['gpio','pwm','i2c','spi','uart','jtag']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'MTDO / LP_I2C_SCL / FSPID.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 0, '0', 'J1', 7, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC1_CH0']::text[], 12, false, true, false, false, false, false, null, false, false, null, 'XTAL_32K_P / LP_GPIO0.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 1, '1', 'J1', 8, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC1_CH1']::text[], 12, false, true, false, false, false, false, null, false, false, null, 'XTAL_32K_N / LP_GPIO1.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 8, '8', 'J1', 9, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, true, false, false, false, null, false, false, null, 'Strapping pin on ESP32-C6; boot state matters.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 10, '10', 'J1', 10, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, null),
  ('espressif.esp32-c6-devkitc-1.v1.2', 11, '11', 'J1', 11, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, null),
  ('espressif.esp32-c6-devkitc-1.v1.2', 2, '2', 'J1', 12, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC1_CH2']::text[], 12, false, true, false, false, false, false, null, false, false, null, 'LP_GPIO2 / FSPIQ.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 3, '3', 'J1', 13, array['gpio','pwm','i2c','spi','uart','adc']::text[], array['ADC1_CH3']::text[], 12, false, true, false, false, false, false, null, false, false, null, 'LP_GPIO3.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 16, 'TX', 'J3', 2, array['gpio','uart','pwm']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'U0TXD — USB-to-UART bridge / FSPICS0.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 17, 'RX', 'J3', 3, array['gpio','uart','pwm']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'U0RXD — USB-to-UART bridge / FSPICS1.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 15, '15', 'J3', 4, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, true, false, false, false, null, false, false, null, 'Strapping pin on ESP32-C6; verify boot state.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 23, '23', 'J3', 5, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'SDIO_DATA3.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 22, '22', 'J3', 6, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'SDIO_DATA2.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 21, '21', 'J3', 7, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'SDIO_DATA1 / FSPICS5.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 20, '20', 'J3', 8, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'SDIO_DATA0 / FSPICS4.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 19, '19', 'J3', 9, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'SDIO_CLK / FSPICS3.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 18, '18', 'J3', 10, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, false, false, false, false, null, false, false, null, 'SDIO_CMD / FSPICS2.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 9, '9', 'J3', 11, array['gpio','pwm','i2c','spi','uart']::text[], array[]::text[], null, false, true, true, false, false, false, null, false, false, null, 'Strapping pin on ESP32-C6; verify boot state.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 13, '13', 'J3', 13, array['gpio','pwm','i2c','spi','uart','usb']::text[], array[]::text[], null, false, true, false, true, false, false, null, false, false, null, 'USB_D+ on ESP32-C6; unavailable as GPIO when native USB is in use.'),
  ('espressif.esp32-c6-devkitc-1.v1.2', 12, '12', 'J3', 14, array['gpio','pwm','i2c','spi','uart','usb']::text[], array[]::text[], null, false, true, false, true, false, false, null, false, false, null, 'USB_D- on ESP32-C6; unavailable as GPIO when native USB is in use.')
on conflict (board_id, gpio) do update set header_label = excluded.header_label, side = excluded.side, header_pin = excluded.header_pin, functions = excluded.functions, adc_channels = excluded.adc_channels, input_only = excluded.input_only, boot_strapping = excluded.boot_strapping, usb_jtag = excluded.usb_jtag, flash_connected = excluded.flash_connected, psram_connected = excluded.psram_connected, restricted = excluded.restricted, restriction_note = excluded.restriction_note, notes = excluded.notes;

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
  foreach v_i in array v_pins loop
    perform public.assign_pin_exclusive(p_tenant, v_board, v_i, 'bus', v_bus,
      case when v_kind='i2c' then 'i2c' when v_kind='spi' then 'spi' else 'uart' end, v_bus);
  end loop;
  perform public.bump_board_config(v_board);
  perform public.log_audit(p_tenant, p_actor, 'bus.create', 'shared_bus', v_bus::text, null, p_data);
  return jsonb_build_object('id', v_bus);
end $$;

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
  update board_pins bp set state = case
      when exists (select 1 from exclusive_allocations e where e.user_board_id=bp.user_board_id and e.gpio=bp.gpio)
        then 'assigned' else 'available' end
    where bp.user_board_id=v_board and not bp.restricted;
  perform public.bump_board_config(v_board);
  perform public.log_audit(p_tenant, p_actor, 'bus.delete', 'shared_bus', p_bus::text);
  return jsonb_build_object('deleted',true);
end $$;
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
        v_allowed := true;
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
create or replace function public.rpc_set_platform_setting(p_actor uuid, p_key text, p_value jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin_for(p_actor) then raise exception 'Platform admin required' using errcode='42501'; end if;
  insert into platform_settings (key, value, updated_by) values (p_key, p_value, p_actor)
  on conflict (key) do update set value=excluded.value, updated_by=excluded.updated_by, updated_at=now();
  insert into audit_logs (actor_id, actor_type, action, entity_type, entity_id, after)
  values (p_actor, 'platform_admin', 'platform.setting.update', 'setting', p_key,
          jsonb_build_object('key',p_key,'value',case when p_key ilike '%secret%' or p_key ilike '%token%' then to_jsonb('***'::text) else p_value end));
  return jsonb_build_object('key',p_key);
end $$;
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

create or replace function public.log_audit(
  p_tenant uuid, p_actor uuid, p_action text, p_entity text, p_entity_id text,
  p_before jsonb default null, p_after jsonb default null, p_actor_type text default 'user'
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into audit_logs (tenant_id, actor_id, actor_email, actor_type, action, entity_type, entity_id, before, after)
  values (p_tenant, p_actor, (select email from profiles where id = p_actor), p_actor_type,
          p_action, p_entity, p_entity_id, p_before, p_after);
end $$;

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

do $$ begin
  create schema if not exists extensions;
  execute 'create extension if not exists pgcrypto with schema extensions';
exception when others then null; end $$;
alter table public.profiles drop constraint if exists profiles_id_fkey;
do $$ begin
  if exists (select 1 from pg_namespace where nspname='auth') then
    execute 'drop trigger if exists on_auth_user_created on auth.users';
  end if;
exception when others then null; end $$;
drop function if exists public.handle_new_user();

create table if not exists public.app_users (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null unique,
  password_hash       text not null,
  password_algo       text not null default 'bcrypt-pepper',
  password_updated_at timestamptz not null default now(),
  status              text not null default 'active' check (status in ('active','suspended')),
  failed_login_count  integer not null default 0,
  locked_until        timestamptz,
  last_login_at       timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists app_users_email_lower on public.app_users (lower(email));
create table if not exists public.app_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.app_users(id) on delete cascade,
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  ip            text,
  user_agent    text
);
create index if not exists app_sessions_active on public.app_sessions (user_id) where revoked_at is null;
create index if not exists app_sessions_expiry on public.app_sessions (expires_at);
create table if not exists public.app_login_attempts (
  scope_key         text primary key,
  attempts          integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until      timestamptz,
  updated_at        timestamptz not null default now()
);
create table if not exists public.app_recovery_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.app_users(id) on delete cascade,
  code_hash  text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index if not exists app_recovery_codes_user on public.app_recovery_codes (user_id);
create table if not exists public.app_auth_config (
  key        text primary key,
  value      integer not null,
  updated_at timestamptz not null default now()
);
insert into public.app_auth_config (key, value) values
 ('login_max_attempts',5), ('login_window_seconds',900), ('login_lockout_seconds',900),
 ('session_ttl_hours',168), ('session_idle_hours',72), ('max_sessions_per_user',10),
 ('password_min_length',10), ('bcrypt_cost',12), ('recovery_code_count',8),
 ('recovery_code_ttl_hours',720)
on conflict (key) do nothing;
create table if not exists public.app_roles (
  key         text primary key,
  description text not null,
  rank        integer not null default 100
);
insert into public.app_roles (key, description, rank) values
 ('platform_owner','Full platform administration',0),
 ('platform_admin','Platform administration',10),
 ('customer','Standard customer account',100)
on conflict (key) do nothing;
create table if not exists public.app_permissions (
  key   text primary key,
  label text not null
);
insert into public.app_permissions (key, label) values
 ('owner.console','Access the Owner Console'),
 ('owner.customers','Manage customer accounts'),
 ('owner.settings','Manage platform settings'),
 ('owner.security','Manage authentication security'),
 ('account.manage','Manage own account')
on conflict (key) do nothing;
create table if not exists public.app_role_permissions (
  role_key       text not null references public.app_roles(key) on delete cascade,
  permission_key text not null references public.app_permissions(key) on delete cascade,
  primary key (role_key, permission_key)
);
insert into public.app_role_permissions (role_key, permission_key)
select r.key, p.key from public.app_roles r cross join public.app_permissions p
where r.key in ('platform_owner','platform_admin')
   or (r.key = 'customer' and p.key = 'account.manage')
on conflict do nothing;
create table if not exists public.app_user_roles (
  user_id    uuid not null references public.app_users(id) on delete cascade,
  role_key   text not null references public.app_roles(key),
  granted_at timestamptz not null default now(),
  granted_by uuid references public.app_users(id),
  primary key (user_id, role_key)
);
-- Carry existing profiles into the account table.
--
-- An earlier version of this file created a temporary table here to read legacy
-- password hashes from, then dropped it again. Creating and dropping an object
-- inside a migration made every later statement depend on an object that no
-- longer exists: running the file a second time, running it with ON_ERROR_STOP,
-- or replaying only the security section failed with
--   42P01: relation "public.app_user_credentials" does not exist
-- so row level security could never be enabled on a database that had not
-- created that table.
--
-- Nothing is created now. The legacy table is only touched when a database
-- actually has it, which is decided at run time; on a fresh database this block
-- simply marks every existing profile as needing a password reset.
-- If the table does exist its hashes are migrated into app_users and the table
-- is retired: a password-hash table left in the public schema is published by
-- PostgREST while it has no row level security. The drop lives on a branch that
-- nothing later in this file depends on, so it cannot resurrect 42P01.
do $migrate_profile_accounts$
begin
  if to_regclass('public.app_user_credentials') is not null then
    insert into public.app_users (id, email, password_hash, password_algo, status, created_at)
    select p.id, lower(p.email),
           coalesce(c.password_hash, ''),
           case when c.password_hash is null then 'recovery-required'
                -- Must stay in step with PBKDF2_VERIFY_MAX in apps/api/src/crypto.ts:
                -- a hash we cannot verify has to be marked recovery-required, and a
                -- hash we can verify must not be.
                when split_part(c.password_hash, '$', 2) ~ '^[0-9]+$'
                     and split_part(c.password_hash, '$', 2)::integer > 1000000 then 'recovery-required'
                else 'pbkdf2-legacy' end,
           'active', p.created_at
    from public.profiles p
    left join public.app_user_credentials c on c.user_id = p.id
    where not exists (select 1 from public.app_users a where a.id = p.id)
    on conflict (id) do nothing;

    -- Retire the legacy table. If something still depends on it the drop is
    -- refused, so lock it down rather than leave the hashes reachable.
    begin
      execute 'drop table public.app_user_credentials';
    exception when others then
      execute 'alter table public.app_user_credentials enable row level security';
      execute 'revoke all on table public.app_user_credentials from anon, authenticated';
      raise notice 'app_user_credentials not dropped (%); RLS enabled and grants revoked', sqlerrm;
    end;
  else
    insert into public.app_users (id, email, password_hash, password_algo, status, created_at)
    select p.id, lower(p.email), '', 'recovery-required', 'active', p.created_at
    from public.profiles p
    where not exists (select 1 from public.app_users a where a.id = p.id)
    on conflict (id) do nothing;
  end if;
end $migrate_profile_accounts$;
insert into public.app_user_roles (user_id, role_key)
select u.id, 'customer' from public.app_users u
where not exists (select 1 from public.app_user_roles r where r.user_id = u.id)
on conflict do nothing;
do $$ declare v_id uuid; begin
  if not exists (select 1 from public.platform_admins)
     and not exists (select 1 from public.app_user_roles where role_key = 'platform_owner') then
    select u.id into v_id from public.app_users u
      join public.profiles p on p.id = u.id
      order by u.created_at, u.id limit 1;
    if v_id is not null then
      delete from public.app_user_roles where user_id = v_id;
      insert into public.app_user_roles (user_id, role_key) values (v_id, 'platform_owner');
      insert into public.platform_admins (profile_id, level) values (v_id, 'owner') on conflict do nothing;
    end if;
  end if;
end $$;
insert into public.app_user_roles (user_id, role_key)
select a.profile_id, 'platform_admin' from public.platform_admins a
where exists (select 1 from public.app_users u where u.id = a.profile_id)
on conflict do nothing;
create or replace function public.is_platform_admin_for(p_actor uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins a where a.profile_id = p_actor)
      or exists (select 1 from public.app_user_roles r
                 where r.user_id = p_actor and r.role_key in ('platform_owner','platform_admin'))
$$;
create or replace function public.rpc_auth_hash_secret(p_secret text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_schema text; v_cost integer; v_hash text;
begin
  select n.nspname into v_schema from pg_proc f join pg_namespace n on n.oid = f.pronamespace
    where f.proname = 'gen_salt' limit 1;
  if v_schema is null then
    raise exception 'Enable the pgcrypto extension in Supabase to use password authentication' using errcode = '42501';
  end if;
  select value into v_cost from public.app_auth_config where key = 'bcrypt_cost';
  v_cost := least(greatest(coalesce(v_cost, 12), 4), 15);
  execute format('select %I.crypt($1, %I.gen_salt(''bf'', $2))', v_schema, v_schema)
    using p_secret, v_cost into v_hash;
  return v_hash;
end $$;
create or replace function public.rpc_auth_verify_secret(p_secret text, p_hash text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_schema text; v_ok boolean;
begin
  if p_secret is null or p_hash is null or p_hash = '' then return false; end if;
  select n.nspname into v_schema from pg_proc f join pg_namespace n on n.oid = f.pronamespace
    where f.proname = 'crypt' limit 1;
  if v_schema is null then
    raise exception 'Enable the pgcrypto extension in Supabase to use password authentication' using errcode = '42501';
  end if;
  execute format('select %I.crypt($1, $2) = $2', v_schema) using p_secret, p_hash into v_ok;
  return coalesce(v_ok, false);
end $$;
create or replace function public.rpc_auth_register(p_email text, p_secret text, p_meta jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid; v_email text; v_name text; v_slug text; v_tenant uuid; v_role text; v_hash text;
begin
  perform pg_advisory_xact_lock(727814633901);
  v_email := lower(btrim(coalesce(p_email, '')));
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  if exists (select 1 from public.app_users where lower(email) = v_email)
     or exists (select 1 from public.profiles where lower(email) = v_email) then
    raise exception 'An account with this email already exists' using errcode = '23505';
  end if;
  if p_secret is null or length(p_secret) < 16 then
    raise exception 'Password is required' using errcode = '22023';
  end if;
  v_id := gen_random_uuid();
  v_name := coalesce(nullif(p_meta->>'full_name', ''), split_part(v_email, '@', 1));
  v_hash := public.rpc_auth_hash_secret(p_secret);
  insert into public.app_users (id, email, password_hash, password_algo)
  values (v_id, v_email, v_hash, 'bcrypt-pepper');
  insert into public.profiles (id, email, full_name, timezone)
  values (v_id, v_email, v_name, coalesce(nullif(p_meta->>'timezone', ''), 'UTC'));
  v_slug := lower(regexp_replace(split_part(v_email, '@', 1), '[^a-zA-Z0-9]+', '-', 'g'))
            || '-' || substr(replace(v_id::text, '-', ''), 1, 8);
  insert into public.tenants (name, slug, owner_profile_id, timezone)
  values (coalesce(nullif(p_meta->>'home_name', ''), v_name || '''s Home'), v_slug, v_id,
          coalesce(nullif(p_meta->>'timezone', ''), 'UTC'))
  returning id into v_tenant;
  insert into public.tenant_members (tenant_id, profile_id, role_key, status, joined_at)
  values (v_tenant, v_id, 'owner', 'active', now());
  if not exists (select 1 from public.platform_admins)
     and not exists (select 1 from public.app_user_roles where role_key = 'platform_owner') then
    v_role := 'platform_owner';
    insert into public.app_user_roles (user_id, role_key) values (v_id, 'platform_owner');
    insert into public.platform_admins (profile_id, level) values (v_id, 'owner');
  else
    v_role := 'customer';
    insert into public.app_user_roles (user_id, role_key) values (v_id, 'customer');
  end if;
  return jsonb_build_object('user_id', v_id, 'email', v_email, 'role', v_role, 'tenant_id', v_tenant);
end $$;
create or replace function public.rpc_auth_lookup(p_email text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_u public.app_users%rowtype;
begin
  select * into v_u from public.app_users
    where lower(email) = lower(btrim(coalesce(p_email, ''))) limit 1;
  if not found then return null; end if;
  return jsonb_build_object('user_id', v_u.id, 'email', v_u.email,
    'password_hash', v_u.password_hash, 'password_algo', v_u.password_algo,
    'status', v_u.status, 'locked_until', v_u.locked_until);
end $$;
create or replace function public.rpc_auth_guard(p_email text, p_ip text, p_action text, p_scope text default 'login')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := now();
  v_max integer; v_window integer; v_lockout integer;
  v_keys text[]; v_k text; v_locked timestamptz; v_blocked boolean := false;
  v_retry integer := 0; v_count integer; v_first timestamptz; v_new_lock timestamptz;
begin
  select value into v_max from public.app_auth_config where key = 'login_max_attempts';
  select value into v_window from public.app_auth_config where key = 'login_window_seconds';
  select value into v_lockout from public.app_auth_config where key = 'login_lockout_seconds';
  v_max := greatest(coalesce(v_max, 5), 1);
  v_window := greatest(coalesce(v_window, 900), 1);
  v_lockout := greatest(coalesce(v_lockout, 900), 1);
  v_keys := array[coalesce(p_scope, 'login') || ':e:' || lower(btrim(coalesce(p_email, ''))),
                  coalesce(p_scope, 'login') || ':i:' || coalesce(nullif(btrim(coalesce(p_ip, '')), ''), 'unknown')];
  if p_action = 'clear' then
    delete from public.app_login_attempts where scope_key = any(v_keys);
    return jsonb_build_object('allowed', true, 'retry_after', 0);
  end if;
  foreach v_k in array v_keys loop
    select locked_until into v_locked from public.app_login_attempts where scope_key = v_k;
    if found and v_locked is not null and v_locked > v_now then
      v_blocked := true;
      v_retry := greatest(v_retry, ceil(extract(epoch from (v_locked - v_now)))::integer);
    end if;
  end loop;
  if v_blocked or p_action = 'check' then
    return jsonb_build_object('allowed', not v_blocked, 'retry_after', v_retry, 'locked', v_blocked);
  end if;
  foreach v_k in array v_keys loop
    select attempts, window_started_at into v_count, v_first
      from public.app_login_attempts where scope_key = v_k;
    if not found or v_first < v_now - (v_window || ' seconds')::interval then
      v_count := 1; v_first := v_now;
    else
      v_count := v_count + 1;
    end if;
    v_new_lock := case when v_count >= v_max
      then v_now + (v_lockout || ' seconds')::interval else null end;
    insert into public.app_login_attempts (scope_key, attempts, window_started_at, locked_until, updated_at)
    values (v_k, v_count, v_first, v_new_lock, v_now)
    on conflict (scope_key) do update set
      attempts = excluded.attempts, window_started_at = excluded.window_started_at,
      locked_until = excluded.locked_until, updated_at = excluded.updated_at;
    if v_new_lock is not null then
      v_blocked := true; v_retry := greatest(v_retry, v_lockout);
    end if;
  end loop;
  return jsonb_build_object('allowed', not v_blocked, 'retry_after', v_retry, 'locked', v_blocked);
end $$;
create or replace function public.rpc_auth_session_create(p_user_id uuid, p_token_hash text, p_ip text, p_user_agent text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ttl integer; v_max integer; v_expires timestamptz; v_id uuid;
begin
  select value into v_ttl from public.app_auth_config where key = 'session_ttl_hours';
  select value into v_max from public.app_auth_config where key = 'max_sessions_per_user';
  v_ttl := greatest(coalesce(v_ttl, 168), 1);
  v_max := greatest(coalesce(v_max, 10), 1);
  v_expires := now() + (v_ttl || ' hours')::interval;
  delete from public.app_sessions where user_id = p_user_id
    and (expires_at <= now() or revoked_at is not null);
  insert into public.app_sessions (user_id, token_hash, expires_at, ip, user_agent)
  values (p_user_id, p_token_hash, v_expires,
          left(coalesce(p_ip, ''), 64), left(coalesce(p_user_agent, ''), 200))
  returning id into v_id;
  delete from public.app_sessions where user_id = p_user_id and id in (
    select id from public.app_sessions where user_id = p_user_id and revoked_at is null
    order by created_at desc offset v_max
  );
  update public.app_users set last_login_at = now(), failed_login_count = 0,
    locked_until = null, updated_at = now() where id = p_user_id;
  return jsonb_build_object('session_id', v_id, 'expires_at', v_expires);
end $$;
create or replace function public.rpc_auth_session_resolve(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_s public.app_sessions%rowtype; v_u public.app_users%rowtype;
  v_idle integer; v_role text; v_perms jsonb; v_admin boolean;
begin
  select * into v_s from public.app_sessions
    where token_hash = p_token_hash and revoked_at is null;
  if not found then return null; end if;
  select value into v_idle from public.app_auth_config where key = 'session_idle_hours';
  v_idle := greatest(coalesce(v_idle, 72), 1);
  if v_s.expires_at <= now() or v_s.last_seen_at < now() - (v_idle || ' hours')::interval then
    update public.app_sessions set revoked_at = now() where id = v_s.id;
    return null;
  end if;
  select * into v_u from public.app_users where id = v_s.user_id;
  if not found or v_u.status <> 'active' then
    update public.app_sessions set revoked_at = now() where id = v_s.id;
    return null;
  end if;
  update public.app_sessions set last_seen_at = now() where id = v_s.id;
  select coalesce((select role_key from public.app_user_roles where user_id = v_u.id
    order by case when role_key = 'platform_owner' then 0 when role_key = 'platform_admin' then 1 else 2 end
    limit 1), 'customer') into v_role;
  select coalesce(jsonb_agg(distinct rp.permission_key), '[]'::jsonb) into v_perms
    from public.app_user_roles ur
    join public.app_role_permissions rp on rp.role_key = ur.role_key
    where ur.user_id = v_u.id;
  v_admin := v_role in ('platform_owner','platform_admin') or public.is_platform_admin_for(v_u.id);
  return jsonb_build_object('user_id', v_u.id, 'email', v_u.email,
    'session_id', v_s.id, 'expires_at', v_s.expires_at,
    'role', v_role, 'permissions', v_perms, 'platform_admin', v_admin);
end $$;
create or replace function public.rpc_auth_session_revoke(p_token_hash text)
returns void language sql security definer set search_path = public as $$
  update public.app_sessions set revoked_at = now()
  where token_hash = p_token_hash and revoked_at is null;
$$;
create or replace function public.rpc_auth_sessions(p_user_id uuid, p_current text default '')
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'created_at', s.created_at,
    'last_seen_at', s.last_seen_at, 'expires_at', s.expires_at, 'ip', s.ip,
    'user_agent', s.user_agent, 'current', s.token_hash = p_current)
    order by s.created_at desc), '[]'::jsonb)
  from public.app_sessions s
  where s.user_id = p_user_id and s.revoked_at is null and s.expires_at > now();
$$;
create or replace function public.rpc_auth_session_revoke_id(p_user_id uuid, p_session_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.app_sessions set revoked_at = now()
  where id = p_session_id and user_id = p_user_id and revoked_at is null;
$$;
create or replace function public.rpc_auth_update_secret(p_user_id uuid, p_hash text, p_keep_token_hash text default '')
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_hash is null or p_hash = '' then
    raise exception 'Invalid password hash' using errcode = '22023';
  end if;
  update public.app_users set password_hash = p_hash, password_algo = 'bcrypt-pepper',
    password_updated_at = now(), updated_at = now() where id = p_user_id;
  if not found then raise exception 'Account not found' using errcode = 'P0002'; end if;
  update public.app_sessions set revoked_at = now()
  where user_id = p_user_id and revoked_at is null
    and token_hash <> coalesce(p_keep_token_hash, '');
end $$;
create or replace function public.rpc_auth_recovery_codes_set(p_user_id uuid, p_hashes jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ttl integer; v_count integer; v_item text;
begin
  select value into v_ttl from public.app_auth_config where key = 'recovery_code_ttl_hours';
  v_ttl := greatest(coalesce(v_ttl, 720), 1);
  delete from public.app_recovery_codes where user_id = p_user_id;
  v_count := 0;
  for v_item in select value::text from jsonb_array_elements_text(coalesce(p_hashes, '[]'::jsonb)) loop
    insert into public.app_recovery_codes (user_id, code_hash, expires_at)
    values (p_user_id, v_item, now() + (v_ttl || ' hours')::interval)
    on conflict (code_hash) do nothing;
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('count', v_count, 'expires_hours', v_ttl);
end $$;
create or replace function public.rpc_auth_recovery_redeem(p_email text, p_code_hash text, p_new_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user public.app_users%rowtype; v_code public.app_recovery_codes%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(lower(btrim(coalesce(p_email, ''))), 727814633902));
  select * into v_user from public.app_users
    where lower(email) = lower(btrim(coalesce(p_email, ''))) limit 1;
  if not found then
    raise exception 'Invalid or expired recovery code' using errcode = '42501';
  end if;
  select * into v_code from public.app_recovery_codes
  where user_id = v_user.id and code_hash = p_code_hash
    and used_at is null and expires_at > now()
  for update;
  if not found then
    raise exception 'Invalid or expired recovery code' using errcode = '42501';
  end if;
  if p_new_hash is null or p_new_hash = '' then
    raise exception 'A new password is required' using errcode = '22023';
  end if;
  update public.app_recovery_codes set used_at = now() where id = v_code.id;
  update public.app_users set password_hash = p_new_hash, password_algo = 'bcrypt-pepper',
    password_updated_at = now(), status = 'active', failed_login_count = 0,
    locked_until = null, updated_at = now() where id = v_user.id;
  update public.app_sessions set revoked_at = now()
    where user_id = v_user.id and revoked_at is null;
  delete from public.app_recovery_codes where user_id = v_user.id;
  delete from public.app_login_attempts
  where scope_key = 'login:e:' || lower(v_user.email)
     or scope_key = 'recovery:e:' || lower(v_user.email);
  return jsonb_build_object('ok', true, 'user_id', v_user.id);
end $$;
create or replace function public.rpc_auth_config()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from public.app_auth_config;
$$;
create or replace function public.rpc_auth_config_set(p_key text, p_value integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_key not in ('login_max_attempts','login_window_seconds','login_lockout_seconds',
    'session_ttl_hours','session_idle_hours','max_sessions_per_user',
    'password_min_length','bcrypt_cost','recovery_code_count','recovery_code_ttl_hours') then
    raise exception 'Unknown authentication setting' using errcode = '22023';
  end if;
  if p_value is null or p_value < 1 or p_value > 1000000 then
    raise exception 'Value out of range' using errcode = '22023';
  end if;
  if p_key = 'bcrypt_cost' and (p_value < 4 or p_value > 15) then
    raise exception 'bcrypt_cost must be between 4 and 15' using errcode = '22023';
  end if;
  if p_key = 'password_min_length' and (p_value < 8 or p_value > 128) then
    raise exception 'password_min_length must be between 8 and 128' using errcode = '22023';
  end if;
  insert into public.app_auth_config (key, value, updated_at) values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
  return public.rpc_auth_config();
end $$;
create or replace function public.rpc_auth_platform_permissions(p_actor uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'role', coalesce((select role_key from public.app_user_roles where user_id = p_actor
      order by case when role_key = 'platform_owner' then 0 when role_key = 'platform_admin' then 1 else 2 end
      limit 1), 'customer'),
    'permissions', coalesce((select jsonb_agg(distinct rp.permission_key)
      from public.app_user_roles ur join public.app_role_permissions rp on rp.role_key = ur.role_key
      where ur.user_id = p_actor), '[]'::jsonb),
    'platform_admin', public.is_platform_admin_for(p_actor));
$$;
create or replace function public.rpc_auth_accounts()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', u.id, 'email', u.email, 'status', u.status,
      'role', coalesce((select role_key from public.app_user_roles r where r.user_id = u.id
        order by case when role_key = 'platform_owner' then 0 when role_key = 'platform_admin' then 1 else 2 end
        limit 1), 'customer'),
      'created_at', u.created_at, 'last_login_at', u.last_login_at,
      'active_sessions', (select count(*) from public.app_sessions s
        where s.user_id = u.id and s.revoked_at is null and s.expires_at > now()),
      'recovery_codes', (select count(*) from public.app_recovery_codes c
        where c.user_id = u.id and c.used_at is null and c.expires_at > now()))
    order by u.created_at), '[]'::jsonb)
  from public.app_users u;
$$;
create or replace function public.rpc_auth_account_status(p_user_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_status not in ('active','suspended') then
    raise exception 'Invalid status' using errcode = '22023';
  end if;
  if p_status = 'suspended' and exists (
    select 1 from public.app_user_roles where user_id = p_user_id and role_key = 'platform_owner'
  ) then
    raise exception 'The Platform Owner account cannot be suspended' using errcode = '42501';
  end if;
  update public.app_users set status = p_status, updated_at = now() where id = p_user_id;
  if not found then raise exception 'Account not found' using errcode = 'P0002'; end if;
  if p_status = 'suspended' then
    update public.app_sessions set revoked_at = now()
      where user_id = p_user_id and revoked_at is null;
  end if;
end $$;
create or replace function public.rpc_auth_sessions_revoke_other(p_user_id uuid, p_keep_token_hash text default '')
returns void language sql security definer set search_path = public as $$
  update public.app_sessions set revoked_at = now()
  where user_id = p_user_id and revoked_at is null
    and token_hash <> coalesce(p_keep_token_hash, '');
$$;
create or replace function public.rpc_auth_guard_reset()
returns void language sql security definer set search_path = public as $$
  delete from public.app_login_attempts;
$$;
create or replace function public.rpc_auth_guard_reset_for(p_email text)
returns void language sql security definer set search_path = public as $$
  delete from public.app_login_attempts
  where scope_key = 'login:e:' || lower(btrim(coalesce(p_email, '')))
     or scope_key = 'recovery:e:' || lower(btrim(coalesce(p_email, '')));
$$;
create or replace function public.rpc_auth_health()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_pgcrypto boolean; v_accounts integer; v_sessions integer; v_locked integer;
begin
  select exists (select 1 from pg_proc f join pg_namespace n on n.oid = f.pronamespace
    where f.proname = 'gen_salt') into v_pgcrypto;
  select count(*) into v_accounts from public.app_users;
  select count(*) into v_sessions from public.app_sessions
    where revoked_at is null and expires_at > now();
  select count(*) into v_locked from public.app_login_attempts where locked_until > now();
  return jsonb_build_object('pgcrypto', v_pgcrypto, 'accounts', v_accounts,
    'active_sessions', v_sessions, 'locked_scopes', v_locked);
end $$;
alter table public.app_users enable row level security;
alter table public.app_sessions enable row level security;
alter table public.app_login_attempts enable row level security;
alter table public.app_recovery_codes enable row level security;
alter table public.app_auth_config enable row level security;
alter table public.app_roles enable row level security;
alter table public.app_permissions enable row level security;
alter table public.app_role_permissions enable row level security;
alter table public.app_user_roles enable row level security;
revoke all on public.app_users, public.app_sessions, public.app_login_attempts,
  public.app_recovery_codes, public.app_auth_config, public.app_user_roles
  from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
grant usage on schema public to service_role;
alter table public.firmware_releases add column if not exists name text;
alter table public.firmware_releases add column if not exists description text;
alter table public.firmware_releases add column if not exists storage_backend text not null default 'supabase';
alter table public.firmware_releases add column if not exists checksum_verified boolean not null default false;
alter table public.firmware_releases add column if not exists uploaded_by uuid references public.profiles(id);
alter table public.firmware_releases add column if not exists updated_at timestamptz not null default now();
alter table public.firmware_releases add column if not exists archived_at timestamptz;
alter table public.firmware_releases add column if not exists deleted_at timestamptz;
update public.firmware_releases set name = coalesce(name, 'Firmware ' || version) where name is null;
create index if not exists firmware_releases_live on public.firmware_releases (created_at desc) where deleted_at is null;
drop trigger if exists firmware_releases_touch on public.firmware_releases;
create trigger firmware_releases_touch before update on public.firmware_releases
  for each row execute function public.tg_set_updated_at();
create table if not exists public.firmware_storage_tests (
  id          uuid primary key default gen_random_uuid(),
  backend     text not null,
  connected   boolean not null,
  detail      text not null,
  checked_at  timestamptz not null default now(),
  tested_by   uuid references public.profiles(id)
);
create table if not exists public.app_security_events (
  id         uuid primary key default gen_random_uuid(),
  event_type text not null,
  email      text,
  user_id    uuid references public.app_users(id) on delete set null,
  ip         text,
  detail     text,
  created_at timestamptz not null default now()
);
create index if not exists app_security_events_recent on public.app_security_events (created_at desc);
insert into public.app_auth_config (key, value) values ('registration_enabled',1) on conflict (key) do nothing;
alter table public.board_catalog add column if not exists is_custom boolean not null default false;
alter table public.board_catalog add column if not exists archived_at timestamptz;
alter table public.board_catalog add column if not exists capabilities jsonb not null default '{}'::jsonb;
update public.board_catalog set is_custom = true where category = 'custom';
create or replace function public.rpc_firmware_set_status(p_actor uuid, p_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.firmware_releases%rowtype;
begin
  if not public.is_platform_admin_for(p_actor) then
    raise exception 'Platform admin required' using errcode = '42501';
  end if;
  if p_status not in ('draft','published','archived') then
    raise exception 'Unknown firmware status' using errcode = '22023';
  end if;
  select * into v_row from public.firmware_releases where id = p_id and deleted_at is null;
  if not found then raise exception 'Firmware release not found' using errcode = 'P0002'; end if;
  if p_status = 'published' and (v_row.sha256 is null or length(v_row.sha256) <> 64) then
    raise exception 'A verified checksum is required before publishing' using errcode = '22023';
  end if;
  update public.firmware_releases set status = p_status,
    published_at = case when p_status = 'published' then coalesce(published_at, now()) else published_at end,
    archived_at = case when p_status = 'archived' then now() else null end,
    updated_at = now()
  where id = p_id;
  insert into public.audit_logs (actor_id, actor_type, action, entity_type, entity_id, after)
  values (p_actor, 'platform_admin', 'platform.firmware.status', 'firmware_release', p_id::text,
          jsonb_build_object('status', p_status));
  return jsonb_build_object('ok', true, 'status', p_status);
end $$;
create or replace function public.rpc_auth_security_events(p_limit integer default 50)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id, 'event_type', e.event_type, 'email', e.email, 'ip', e.ip,
    'detail', e.detail, 'created_at', e.created_at) order by e.created_at desc), '[]'::jsonb)
  from (select * from public.app_security_events order by created_at desc limit greatest(1, least(coalesce(p_limit,50), 300))) e;
$$;
create or replace function public.rpc_auth_all_sessions()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'user_id', s.user_id, 'email', u.email,
    'created_at', s.created_at, 'last_seen_at', s.last_seen_at, 'expires_at', s.expires_at,
    'ip', s.ip, 'user_agent', s.user_agent) order by s.created_at desc), '[]'::jsonb)
  from public.app_sessions s join public.app_users u on u.id = s.user_id
  where s.revoked_at is null and s.expires_at > now();
$$;
create or replace function public.rpc_auth_session_revoke_any(p_session_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.app_sessions set revoked_at = now() where id = p_session_id and revoked_at is null;
$$;
create or replace function public.rpc_auth_roles()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'roles', coalesce((select jsonb_agg(jsonb_build_object(
      'key', r.key, 'description', r.description, 'rank', r.rank,
      'accounts', (select count(*) from public.app_user_roles ur where ur.role_key = r.key),
      'permissions', coalesce((select jsonb_agg(rp.permission_key order by rp.permission_key)
        from public.app_role_permissions rp where rp.role_key = r.key), '[]'::jsonb))
      order by r.rank) from public.app_roles r), '[]'::jsonb),
    'permissions', coalesce((select jsonb_agg(jsonb_build_object('key', p.key, 'label', p.label)
      order by p.key) from public.app_permissions p), '[]'::jsonb));
$$;
revoke all on public.firmware_storage_tests, public.app_security_events from anon, authenticated;
alter table public.firmware_storage_tests enable row level security;
alter table public.app_security_events enable row level security;
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
alter table public.user_boards add column if not exists chip_family text;
alter table public.user_boards add column if not exists mac_address text;
alter table public.user_boards add column if not exists chip_model text;
alter table public.user_boards add column if not exists chip_revision text;
alter table public.user_boards add column if not exists sdk_version text;
alter table public.device_pairing_tokens add column if not exists revoked_at timestamptz;
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
  if v_tok.revoked_at is not null then raise exception 'Pairing token was cancelled' using errcode = '42501'; end if;
  if v_tok.expires_at < now() then raise exception 'Pairing token expired' using errcode = '42501'; end if;
  if not exists (select 1 from tenants t where t.id = v_tok.tenant_id and t.status='active' and t.device_registration_enabled) then
    raise exception 'Workspace cannot register devices' using errcode = '42501'; end if;
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
  insert into mqtt_credentials_metadata (tenant_id, user_board_id, username, password_hash, provider_ref, status)
  values (v_tok.tenant_id, v_board_id, p_username, p_password_hash, coalesce(p_provider_ref,'{}'::jsonb), 'active');
  update device_pairing_tokens set consumed_at = now(), user_board_id = v_board_id where id = v_tok.id;
  return jsonb_build_object('board_id', v_board_id, 'tenant_id', v_tok.tenant_id);
end $$;
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- ============================================================================
-- Six-digit pairing, firmware artifacts and OTA rollout
-- ============================================================================

-- Pairing codes are stored as an HMAC, never in plain text, and are bound to the
-- workspace, the customer session that created them and the selected home.
alter table public.device_pairing_tokens add column if not exists code_hmac text;
alter table public.device_pairing_tokens add column if not exists created_by_session text;
alter table public.device_pairing_tokens add column if not exists created_ip text;
alter table public.device_pairing_tokens add column if not exists home_name text;
alter table public.device_pairing_tokens add column if not exists last_attempt_at timestamptz;
alter table public.device_pairing_tokens add column if not exists locked_until timestamptz;
alter table public.device_pairing_tokens add column if not exists failed_attempts integer not null default 0;
alter table public.device_pairing_tokens add column if not exists revoked_at timestamptz;
alter table public.device_pairing_tokens add column if not exists revoked_reason text;
alter table public.device_pairing_tokens add column if not exists consumed_board_id uuid references public.user_boards(id) on delete set null;
create unique index if not exists pairing_token_code_hmac on public.device_pairing_tokens (code_hmac) where code_hmac is not null;
create index if not exists pairing_token_open on public.device_pairing_tokens (expires_at) where consumed_at is null and revoked_at is null;

-- Releases: one row per artifact. `board_models` lists catalog ids; the artifact
-- is what the browser installer flashes and what OTA downloads.
alter table public.firmware_releases add column if not exists release_notes text;
alter table public.firmware_releases add column if not exists artifact_kind text not null default 'app';
alter table public.firmware_releases add column if not exists flash_offset bigint;
alter table public.firmware_releases add column if not exists hw_config text;
alter table public.firmware_releases add column if not exists chip_family_target text;
alter table public.firmware_releases add column if not exists signature text;
alter table public.firmware_releases add column if not exists signature_alg text;
alter table public.firmware_releases add column if not exists signed_at timestamptz;
alter table public.firmware_releases add column if not exists artifact_verified boolean not null default false;
alter table public.firmware_releases add column if not exists verification_detail jsonb not null default '{}'::jsonb;
alter table public.firmware_releases add column if not exists ota_eligible boolean not null default true;
alter table public.firmware_releases add column if not exists superseded_by uuid references public.firmware_releases(id) on delete set null;
alter table public.firmware_releases add column if not exists downloads integer not null default 0;
-- Public key the package was signed with (base64 of the raw 32-byte Ed25519 key),
-- so a stored release can be re-checked against the key it was signed with.
alter table public.firmware_releases add column if not exists signed_by_key text;
do $$ begin
  alter table public.firmware_releases
    add constraint firmware_releases_artifact_kind_check
    check (artifact_kind in ('app','factory'));
exception when duplicate_object then null; end $$;


-- One version per channel, chip family and artifact kind may exist at a time, so a
-- release package can hold both the OTA application image and the USB factory
-- image under one version number, while the same artifact is never stored twice.
-- This runs only after artifact_kind exists, so it is safe on a fresh database.
create unique index if not exists firmware_release_version
  on public.firmware_releases (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), channel, version, chip_family, artifact_kind);

-- A firmware upload is one release ZIP holding an OTA image and a USB image, so
-- every release row must be complete in the columns that describe its artifact.
-- Without these defaults a database created by an earlier version of this file
-- keeps them nullable, and a row written by a different code path (or repaired
-- by hand) can end up with a null artifact_class, which the code and the UI both
-- rely on. Filling them in is a repair, not a relaxation: the NOT NULL
-- constraints above (channel, version, chip_family, board_models, r2_key, sha256)
-- are unchanged and are what reject an incomplete release.
update public.firmware_releases set storage_backend = 'supabase' where storage_backend is null;
update public.firmware_releases set checksum_verified = false where checksum_verified is null;
update public.firmware_releases set artifact_verified = false where artifact_verified is null;
update public.firmware_releases set ota_eligible = (artifact_kind = 'app') where ota_eligible is null;
update public.firmware_releases set status = 'draft' where status is null;
update public.firmware_releases set artifact_kind = 'app' where artifact_kind is null;
-- flash_offset was nullable and the uploader sent null for application images, so
-- existing rows may hold null or a value that belongs to the other artifact kind.
-- Fill from the artifact kind first, which is the same rule the API now applies,
-- then make the column NOT NULL so the state can never come back.
update public.firmware_releases
   set flash_offset = case when artifact_kind = 'factory' then 0 else 65536 end
 where flash_offset is null
    or flash_offset <> (case when artifact_kind = 'factory' then 0 else 65536 end);
alter table public.firmware_releases alter column flash_offset set not null;
-- The offset is decided by the artifact kind, so the table itself refuses a row
-- that pairs them wrongly: an application image belongs at 0x10000 (65536) and a
-- merged factory image at 0x0. This is not a relaxation of the NOT NULL rule - it
-- is an additional guarantee that the value is the right one, not merely present.
do $$ begin
  alter table public.firmware_releases
    add constraint firmware_releases_flash_offset_check
    check (flash_offset = case when artifact_kind = 'factory' then 0 else 65536 end);
exception when duplicate_object then null; end $$;
alter table public.firmware_releases alter column storage_backend set default 'supabase';
alter table public.firmware_releases alter column checksum_verified set default false;
alter table public.firmware_releases alter column artifact_verified set default false;
alter table public.firmware_releases alter column artifact_kind set default 'app';

-- The owner console overview is defined here, after the columns it reports on
-- exist. A SQL function body is validated when it is created, so a function
-- that selects flash_offset or artifact_kind cannot be defined earlier in this
-- file than the `alter table ... add column` that creates them.
create or replace function public.rpc_firmware_overview()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'releases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', coalesce(r.name, 'Firmware ' || r.version), 'description', r.description,
        'version', r.version, 'channel', r.channel, 'chip_family', r.chip_family,
        'board_models', r.board_models, 'storage_backend', r.storage_backend,
        'size_bytes', r.size_bytes, 'sha256', r.sha256, 'status', r.status,
        -- Which artifact this row is, and the address the installer writes it at.
        -- Without these the console cannot tell an OTA image from a USB one, nor
        -- show a wrong offset.
        'artifact_kind', r.artifact_kind, 'flash_offset', r.flash_offset,
        'ota_eligible', r.ota_eligible, 'chip_family_target', r.chip_family_target,
        'signature', r.signature, 'signature_alg', r.signature_alg,
        'checksum_verified', r.checksum_verified, 'created_at', r.created_at,
        'updated_at', r.updated_at, 'published_at', r.published_at, 'archived_at', r.archived_at,
        'deployments', (select count(*) from public.device_firmware_history h where h.firmware_release_id = r.id),
        'successful', (select count(*) from public.device_firmware_history h where h.firmware_release_id = r.id and h.status = 'success'),
        'failed', (select count(*) from public.device_firmware_history h where h.firmware_release_id = r.id and h.status = 'failed'),
        'pending', (select count(*) from public.device_firmware_history h where h.firmware_release_id = r.id and h.status in ('queued','downloading','installing','verifying')))
        order by r.created_at desc)
      from public.firmware_releases r where r.deleted_at is null), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id, 'release_id', h.firmware_release_id, 'board_id', h.user_board_id,
        'board_name', (select name from public.user_boards b where b.id = h.user_board_id),
        'tenant_name', (select name from public.tenants t where t.id = h.tenant_id),
        'from_version', h.from_version, 'to_version', h.to_version, 'status', h.status,
        'progress', h.progress, 'error', h.error, 'started_at', h.started_at, 'finished_at', h.finished_at)
        order by h.started_at desc)
      from (select * from public.device_firmware_history order by started_at desc limit 200) h), '[]'::jsonb),
    'controllers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'name', b.name, 'catalog_board_id', b.catalog_board_id,
        'chip_family', (select chip_family from public.board_catalog c where c.id = b.catalog_board_id),
        'firmware_version', b.firmware_version, 'status', b.status,
        'tenant_name', (select name from public.tenants t where t.id = b.tenant_id))
        order by b.name)
      from public.user_boards b where b.deleted_at is null), '[]'::jsonb));
$$;


-- Every column the release upload writes, in one place, so a mismatch between the
-- code and the table is visible here instead of surfacing as a 23502 from PostgREST.
comment on column public.firmware_releases.channel is 'stable | beta | dev. Required.';
comment on column public.firmware_releases.version is 'Release version stamped into the image. Required.';
comment on column public.firmware_releases.chip_family is 'Lowercase chip family, for example esp32-s3. Required; the API always sends it.';
comment on column public.firmware_releases.chip_family_target is 'Chip family as reported by the image, for example ESP32-S3.';
comment on column public.firmware_releases.board_models is 'Catalog board ids offered this release. Required (may be empty for an unpublished draft).';
comment on column public.firmware_releases.r2_key is 'Private object key of this artifact. Required.';
comment on column public.firmware_releases.sha256 is 'SHA-256 of the exact stored bytes. Required.';
comment on column public.firmware_releases.artifact_kind is 'app (OTA and USB at 0x10000) or factory (USB at 0x0). Required, defaults to app.';
comment on column public.firmware_releases.flash_offset is 'Flash address in bytes this artifact is written at: 65536 (0x10000) for an app image, 0 for a factory image. Required, NOT NULL, and CHECKed against artifact_kind.';
comment on column public.firmware_releases.ota_eligible is 'True only for app artifacts; a factory image is never installed over the air.';
comment on column public.firmware_releases.signed_by_key is 'Base64 public key the package was signed with.';

-- One controller has at most one open update at a time; only 'success' is ever
-- written by the device after it reconnects on the new image.
alter table public.device_firmware_history add column if not exists stage_detail text;
alter table public.device_firmware_history add column if not exists source text not null default 'console';
alter table public.device_firmware_history add column if not exists command_id uuid;
alter table public.device_firmware_history add column if not exists signature_verified boolean not null default false;
create index if not exists fw_history_open on public.device_firmware_history (user_board_id)
  where status in ('queued','downloading','installing','verifying');

create or replace function public.rpc_pairing_issue(
  p_actor uuid, p_tenant uuid, p_code_hmac text, p_session text, p_ip text, p_data jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_board text; v_open int; v_limit int; v_ttl int; v_recent int; v_rate int;
begin
  perform public.assert_permission(p_actor, p_tenant, 'devices.manage');
  if not exists (select 1 from tenants where id = p_tenant and device_registration_enabled and status = 'active') then
    raise exception 'Device registration is disabled for this workspace' using errcode = '42501';
  end if;
  if p_code_hmac is null or length(p_code_hmac) < 32 then
    raise exception 'A pairing code digest is required' using errcode = '22023';
  end if;
  v_board := p_data->>'catalog_board_id';
  if v_board is not null and not exists (select 1 from board_catalog where id = v_board and active) then
    raise exception 'Unknown board catalog entry' using errcode = '22023';
  end if;
  v_limit := coalesce((select value::int from platform_settings where key = 'pairing.max_open_codes'), 5);
  select count(*) into v_open from device_pairing_tokens
    where tenant_id = p_tenant and created_by = p_actor
      and consumed_at is null and revoked_at is null and expires_at > now();
  if v_open >= v_limit then
    raise exception 'Too many open pairing codes. Finish or cancel the current setup first.' using errcode = '42901';
  end if;
  v_rate := coalesce((select value::int from platform_settings where key = 'pairing.issue_per_hour'), 10);
  select count(*) into v_recent from device_pairing_tokens
    where tenant_id = p_tenant and created_at > now() - interval '1 hour';
  if v_recent >= v_rate then
    raise exception 'Pairing code rate limit reached. Try again in a little while.' using errcode = '42901';
  end if;
  v_ttl := coalesce((p_data->>'ttl_seconds')::int,
                    (select value::int from platform_settings where key = 'pairing.code_ttl_seconds'), 300);
  insert into device_pairing_tokens (tenant_id, token_hash, code_hmac, board_name, catalog_board_id,
                                     created_by, created_by_session, created_ip, home_name, expires_at)
  values (p_tenant, p_code_hmac, p_code_hmac, p_data->>'board_name', v_board,
          p_actor, p_session, p_ip, p_data->>'home_name', now() + (v_ttl || ' seconds')::interval)
  returning id into v_id;
  perform public.log_audit(p_tenant, p_actor, 'pairing.code.issue', 'pairing_token', v_id::text, null,
                           jsonb_build_object('board', v_board, 'ttl_seconds', v_ttl));
  return jsonb_build_object('id', v_id, 'expires_in_seconds', v_ttl, 'expires_at',
                            now() + (v_ttl || ' seconds')::interval);
end $$;

create or replace function public.rpc_pairing_cancel(p_actor uuid, p_tenant uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_permission(p_actor, p_tenant, 'devices.manage');
  update device_pairing_tokens set revoked_at = now(), revoked_reason = 'cancelled by customer'
    where id = p_id and tenant_id = p_tenant and consumed_at is null;
  return jsonb_build_object('cancelled', true);
end $$;

create or replace function public.rpc_pairing_progress(p_actor uuid, p_tenant uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t device_pairing_tokens%rowtype; b user_boards%rowtype; v_online boolean;
begin
  perform public.assert_member(p_actor, p_tenant);
  select * into t from device_pairing_tokens where id = p_id and tenant_id = p_tenant;
  if not found then raise exception 'Pairing session not found' using errcode = 'HC404'; end if;
  if t.user_board_id is not null then
    select * into b from user_boards where id = t.user_board_id;
    v_online := coalesce(b.status = 'online' and b.last_seen_at > now() - interval '3 minutes', false);
  end if;
  return jsonb_build_object(
    'id', t.id,
    'claimed', t.consumed_at is not null,
    'expired', t.expires_at <= now() or t.revoked_at is not null,
    'revoked', t.revoked_at is not null,
    'locked', t.locked_until is not null and t.locked_until > now(),
    'failed_attempts', t.failed_attempts,
    'remaining_attempts', greatest(0, 5 - t.failed_attempts),
    'expires_at', t.expires_at,
    'seconds_left', greatest(0, floor(extract(epoch from (t.expires_at - now())))::int),
    'board', case when b.id is null then null else jsonb_build_object(
      'id', b.id, 'name', b.name, 'device_id', b.device_id, 'status', b.status,
      'online', v_online, 'firmware_version', b.firmware_version,
      'catalog_board_id', b.catalog_board_id, 'chip_model', b.chip_model,
      'chip_family', b.chip_family, 'mac_address', b.mac_address,
      'sdk_version', b.sdk_version, 'fw_build', b.fw_build,
      'hardware_revision', b.hardware_revision, 'last_seen_at', b.last_seen_at,
      'rssi', b.rssi, 'config_version', b.config_version,
      'config_sync_status', b.config_sync_status) end);
end $$;

/*
 * Redeem a code. Everything that matters is atomic:
 *  - the row is locked, so two controllers cannot redeem the same code;
 *  - every failure increments a counter and locks the code after five attempts;
 *  - success is claimed inside the same transaction that creates the board.
 */
create or replace function public.rpc_pairing_redeem(
  p_code_hmac text, p_board_name text, p_device_id text, p_client_id text,
  p_username text, p_password_hash text, p_provider_ref jsonb, p_ip text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t device_pairing_tokens%rowtype;
  v_board_id uuid;
  v_existing uuid;
begin
  select * into t from device_pairing_tokens where code_hmac = p_code_hmac for update;
  if not found then
    raise exception 'That pairing code is not valid' using errcode = '42501';
  end if;
  if t.consumed_at is not null then
    raise exception 'That pairing code has already been used' using errcode = '42501';
  end if;
  if t.revoked_at is not null then
    raise exception 'That pairing code was cancelled' using errcode = '42501';
  end if;
  if t.locked_until is not null and t.locked_until > now() then
    raise exception 'Too many attempts. Wait a few minutes and try again.' using errcode = '42902';
  end if;
  if t.expires_at <= now() then
    update device_pairing_tokens set failed_attempts = failed_attempts + 1, last_attempt_at = now()
      where id = t.id;
    raise exception 'That pairing code has expired' using errcode = '42501';
  end if;
  if not exists (select 1 from tenants x where x.id = t.tenant_id and x.status = 'active'
                 and x.device_registration_enabled) then
    raise exception 'This workspace cannot add controllers right now' using errcode = '42501';
  end if;
  select id into v_existing from user_boards where device_id = p_device_id;
  if v_existing is null then
    select id into v_existing from user_boards where mqtt_client_id = p_client_id limit 1;
  end if;
  if v_existing is not null then
    raise exception 'This controller is already registered to a home' using errcode = '23505';
  end if;

  insert into user_boards (tenant_id, catalog_board_id, custom_board, name, device_id, mqtt_client_id,
                           status, created_by, provisioned_at)
  values (t.tenant_id, t.catalog_board_id,
          case when t.catalog_board_id is null then '{}'::jsonb else null end,
          coalesce(t.board_name, p_board_name, 'ESP32 Controller'),
          p_device_id, p_client_id, 'provisioning', t.created_by, now())
  returning id into v_board_id;

  insert into mqtt_credentials_metadata (tenant_id, user_board_id, username, password_hash, provider, provider_ref, status)
  values (t.tenant_id, v_board_id, p_username, p_password_hash, 'emqx', coalesce(p_provider_ref, '{}'::jsonb), 'active');

  update device_pairing_tokens
    set consumed_at = now(), consumed_ip = p_ip, consumed_board_id = v_board_id, user_board_id = v_board_id
    where id = t.id;

  perform public.bump_board_config(v_board_id);
  perform public.log_audit(t.tenant_id, t.created_by, 'device.pair', 'board', v_board_id::text, null,
                           jsonb_build_object('device_id', p_device_id, 'catalog_board_id', t.catalog_board_id), 'device');
  return jsonb_build_object('board_id', v_board_id, 'tenant_id', t.tenant_id,
                            'device_id', p_device_id, 'reused_credentials', false);
end $$;

/*
 * A wrong code cannot be attributed to a row, so failures are counted per source
 * address: an attacker cannot burn out another customer's pending code, and a
 * guessing spree is stopped after a handful of tries.
 */
create or replace function public.rpc_pairing_record_failure(p_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_window interval := interval '10 minutes'; v_count int;
begin
  insert into public.platform_settings (key, value)
  values ('_pairing_fail:' || coalesce(nullif(p_ip, ''), 'unknown'), jsonb_build_object('n', 1, 'at', now()))
  on conflict (key) do update set value = jsonb_build_object(
    'n', case when (platform_settings.value->>'at')::timestamptz < now() - v_window then 1
              else coalesce((platform_settings.value->>'n')::int, 0) + 1 end,
    'at', now());
  select coalesce((value->>'n')::int, 0) into v_count from public.platform_settings
    where key = '_pairing_fail:' || coalesce(nullif(p_ip, ''), 'unknown');
  if v_count >= 10 then
    raise exception 'Too many incorrect pairing codes. Wait ten minutes and try again.' using errcode = '42902';
  end if;
  return jsonb_build_object('failures', v_count, 'locked', v_count >= 10);
end $$;

create or replace function public.rpc_pairing_address_reset(p_ip text)
returns void language sql security definer set search_path = public as $$
  delete from public.platform_settings where key = '_pairing_fail:' || coalesce(nullif(p_ip, ''), 'unknown');
$$;

create or replace function public.rpc_pairing_cleanup()
returns void language sql security definer set search_path = public as $$
  update device_pairing_tokens set revoked_at = now(), revoked_reason = 'expired unused'
    where revoked_at is null and consumed_at is null and expires_at < now();
  delete from platform_settings where key like '\_pairing\_fail:%' and (value->>'at')::timestamptz < now() - interval '1 day';
$$;

/* ---- firmware: latest compatible release ------------------------------- */

create or replace function public.rpc_firmware_latest(p_board uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare b user_boards%rowtype; c board_catalog%rowtype; r firmware_releases%rowtype;
begin
  select * into b from user_boards where id = p_board and deleted_at is null;
  if not found then return null; end if;
  if b.catalog_board_id is not null then
    select * into c from board_catalog where id = b.catalog_board_id;
  end if;
  select * into r from firmware_releases x
    where x.deleted_at is null and x.status = 'published' and x.channel = 'stable'
      and x.sha256 is not null and length(x.sha256) = 64
      and x.ota_eligible and x.artifact_kind = 'app'
      and (x.board_models @> array[b.catalog_board_id]::text[]
           or (c.chip_family is not null and x.board_models @> array[c.chip_family]::text[]))
    order by x.published_at desc nulls last, x.created_at desc
    limit 1;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', r.id, 'version', r.version, 'name', r.name, 'notes', coalesce(r.description, r.release_notes),
    'size_bytes', r.size_bytes, 'sha256', r.sha256, 'signature', r.signature,
    'signature_alg', r.signature_alg, 'mandatory', r.mandatory, 'channel', r.channel,
    'published_at', r.published_at, 'installed', b.firmware_version,
    'update_available', coalesce(b.firmware_version, '') <> r.version);
end $$;

/* ---- firmware: OTA progress reported by the controller ------------------ */

create or replace function public.rpc_ota_report(p_board uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_status text; v_row device_firmware_history%rowtype; v_prev text; v_new uuid;
begin
  select tenant_id, firmware_version into v_tenant, v_prev from user_boards where id = p_board and deleted_at is null;
  if v_tenant is null then raise exception 'Unknown board' using errcode = '42501'; end if;
  v_status := coalesce(p_payload->>'status', 'downloading');
  if v_status not in ('downloading','installing','verifying','installed','success','failed','rolled_back') then
    raise exception 'Unknown update status' using errcode = '22023';
  end if;
  select * into v_row from device_firmware_history
    where user_board_id = p_board and status in ('queued','downloading','installing','verifying')
    order by started_at desc limit 1;
  if v_row.id is null then
    insert into device_firmware_history (tenant_id, user_board_id, from_version, to_version, status,
      progress, bytes_total, bytes_done, error, source, started_at)
    values (v_tenant, p_board, v_prev, coalesce(p_payload->>'version', v_prev), v_status,
      coalesce((p_payload->>'progress')::smallint, 0), (p_payload->>'bytes_total')::bigint,
      (p_payload->>'bytes_done')::bigint, p_payload->>'error', 'device', now())
    returning id into v_new;
    select * into v_row from device_firmware_history where id = v_new;
  end if;
  update device_firmware_history set
    status = v_status,
    progress = greatest(coalesce((p_payload->>'progress')::smallint, progress), progress),
    bytes_total = coalesce((p_payload->>'bytes_total')::bigint, bytes_total),
    bytes_done = coalesce((p_payload->>'bytes_done')::bigint, bytes_done),
    error = nullif(p_payload->>'error', ''),
    finished_at = case when v_status in ('success','failed','rolled_back') then now() else finished_at end
  where id = v_row.id;
  if v_status = 'success' then
    update user_boards set firmware_version = coalesce(p_payload->>'version', firmware_version),
      fw_build = nullif(p_payload->>'fw_build', ''), last_seen_at = now(), status = 'online'
      where id = p_board;
    insert into audit_logs (tenant_id, actor_type, action, entity_type, entity_id, after)
    values (v_tenant, 'device', 'firmware.ota.confirmed', 'board', p_board::text,
      jsonb_build_object('from_version', v_prev, 'to_version', p_payload->>'version'));
  elsif v_status = 'rolled_back' then
    insert into audit_logs (tenant_id, actor_type, action, entity_type, entity_id, after)
    values (v_tenant, 'device', 'firmware.ota.rollback', 'board', p_board::text,
      jsonb_build_object('from_version', v_prev, 'error', p_payload->>'error'));
  end if;
  return jsonb_build_object('ok', true, 'status', v_status,
    'version', coalesce(p_payload->>'version', v_prev));
end $$;

create or replace function public.rpc_firmware_signature_set(
  p_id uuid, p_signature text, p_alg text, p_actor uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.firmware_releases%rowtype;
begin
  if not public.is_platform_admin_for(p_actor) then
    raise exception 'Platform admin required' using errcode = '42501';
  end if;
  if p_signature is null or length(p_signature) < 40 then
    raise exception 'A base64 signature is required' using errcode = '22023';
  end if;
  if p_alg not in ('ecdsa-p256-sha256','ed25519') then
    raise exception 'Unsupported signature algorithm' using errcode = '22023';
  end if;
  select * into v_row from public.firmware_releases where id = p_id and deleted_at is null;
  if not found then raise exception 'Firmware release not found' using errcode = 'P0002'; end if;
  if v_row.sha256 is null or length(v_row.sha256) <> 64 then
    raise exception 'The release has no trusted checksum' using errcode = '22023';
  end if;
  update public.firmware_releases
    set signature = p_signature, signature_alg = p_alg, signed_at = now(), updated_at = now()
    where id = p_id;
  insert into public.audit_logs (actor_id, actor_type, action, entity_type, entity_id, after)
  values (p_actor, 'platform_admin', 'platform.firmware.signature', 'firmware_release', p_id::text,
          jsonb_build_object('alg', p_alg));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.rpc_firmware_retire(p_id uuid, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.firmware_releases%rowtype; v_replacement uuid;
begin
  if not public.is_platform_admin_for(p_actor) then
    raise exception 'Platform admin required' using errcode = '42501';
  end if;
  select * into v_row from public.firmware_releases where id = p_id and deleted_at is null;
  if not found then raise exception 'Firmware release not found' using errcode = 'P0002'; end if;
  select id into v_replacement from public.firmware_releases
    where id <> p_id and deleted_at is null and status = 'published' and channel = 'stable'
      and artifact_kind = 'app' and published_at < coalesce(v_row.published_at, now())
    order by published_at desc nulls last limit 1;
  update public.firmware_releases
    set status = 'archived', archived_at = now(), ota_eligible = false,
        superseded_by = v_replacement, updated_at = now()
    where id = p_id;
  insert into public.audit_logs (actor_id, actor_type, action, entity_type, entity_id, after)
  values (p_actor, 'platform_admin', 'platform.firmware.retire', 'firmware_release', p_id::text,
          jsonb_build_object('reason', p_reason, 'replacement', v_replacement));
  return jsonb_build_object('retired', true, 'replacement_id', v_replacement,
                            'replacement_version',
                            (select version from public.firmware_releases where id = v_replacement));
end $$;

/*
 * Roll back a controller to a previous stable release. The running version is
 * read from the database, never from the request, and the target must be a
 * published, signed, OTA-eligible release compatible with that board.
 */
create or replace function public.version_lt(p_a text, p_b text)
returns boolean language sql immutable set search_path = public as $$
  with parts as (
    select i as idx,
      coalesce(nullif(regexp_replace(split_part(coalesce(p_a, ''), '.', i), '[^0-9].*$', ''), ''), '0')::int as va,
      coalesce(nullif(regexp_replace(split_part(coalesce(p_b, ''), '.', i), '[^0-9].*$', ''), ''), '0')::int as vb
    from generate_series(1, greatest(
      coalesce(array_length(string_to_array(coalesce(p_a, ''), '.'), 1), 1),
      coalesce(array_length(string_to_array(coalesce(p_b, ''), '.'), 1), 1))) i
  )
  select coalesce((select va < vb from parts where va <> vb order by idx limit 1), false);
$$;

create or replace function public.rpc_firmware_rollback_target(p_board uuid, p_actor uuid, p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare b public.user_boards%rowtype; c public.board_catalog%rowtype; r public.firmware_releases%rowtype;
begin
  if not public.is_platform_admin_for(p_actor) then
    perform public.assert_permission(p_actor, p_tenant, 'devices.configure');
  end if;
  select * into b from public.user_boards
    where id = p_board and deleted_at is null
      and (public.is_platform_admin_for(p_actor) or b.tenant_id = p_tenant);
  if not found then return null; end if;
  if b.catalog_board_id is not null then
    select * into c from public.board_catalog where id = b.catalog_board_id;
  end if;
  select * into r from public.firmware_releases x
    where x.deleted_at is null and x.channel = 'stable' and x.artifact_kind = 'app'
      and x.sha256 is not null and length(x.sha256) = 64
      and x.status in ('published','archived') and x.ota_eligible
      and x.signature is not null
      and public.version_lt(x.version, coalesce(b.firmware_version, ''))
      and (x.board_models @> array[b.catalog_board_id]::text[]
           or (c.chip_family is not null and x.board_models @> array[c.chip_family]::text[]))
      and exists (select 1 from public.device_firmware_history h
                  where h.user_board_id = b.id and h.firmware_release_id = x.id and h.status = 'success')
    order by x.published_at desc nulls last limit 1;
  if not found then
    select * into r from public.firmware_releases x
      where x.deleted_at is null and x.channel = 'stable' and x.artifact_kind = 'app'
        and x.sha256 is not null and length(x.sha256) = 64
        and x.status in ('published','archived') and x.ota_eligible
        and x.signature is not null
        and public.version_lt(x.version, coalesce(b.firmware_version, ''))
        and (x.board_models @> array[b.catalog_board_id]::text[]
             or (c.chip_family is not null and x.board_models @> array[c.chip_family]::text[]))
      order by x.published_at desc nulls last limit 1;
  end if;
  if not found then return null; end if;
  return jsonb_build_object('id', r.id, 'version', r.version, 'sha256', r.sha256,
    'signature', r.signature, 'size_bytes', r.size_bytes, 'installed', b.firmware_version,
    'requires_usb_reinstall', r.artifact_kind <> 'app');
end $$;

-- The N16R8 module shares the DevKitC-1 v1.1 header layout, so its pin map is the
-- same except that GPIO35-37 are inside the octal PSRAM package and never reach
-- the headers. Those three rows are therefore marked restricted, not exposed.
insert into public.board_catalog_pins (
  board_id, gpio, header_label, side, header_pin, functions, adc_channels, adc_bits,
  input_only, exposed, boot_strapping, usb_jtag, flash_connected, psram_connected,
  touch_channel, rtc_gpio, restricted, restriction_note, notes)
select 'espressif.esp32-s3-devkitc-1.n16r8', gpio, header_label, side, header_pin, functions, adc_channels, adc_bits,
  input_only, exposed, boot_strapping, usb_jtag, flash_connected, psram_connected,
  touch_channel, rtc_gpio,
  case when gpio in (35, 36, 37) then true else restricted end,
  case when gpio in (35, 36, 37) then 'Internal to the 8 MB octal PSRAM on the N16R8 module: not available on the headers.' else restriction_note end,
  notes
from public.board_catalog_pins where board_id = 'espressif.esp32-s3-devkitc-1.v1.1'
on conflict (board_id, gpio) do nothing;
update public.board_catalog_pins set functions = '{}', adc_channels = '{}', exposed = false
  where board_id = 'espressif.esp32-s3-devkitc-1.n16r8' and gpio in (35, 36, 37);
insert into public.board_catalog_versions (board_id, version, changelog, published)
values ('espressif.esp32-s3-devkitc-1.n16r8', 2, 'Pin map derived from DevKitC-1 v1.1 with the octal-PSRAM pins removed from the headers.', true)
on conflict (board_id, version) do nothing;

-- ---------------------------------------------------------------------------
-- Grants, applied last on purpose.
--
-- `grant ... on all tables in schema public` only covers the tables that exist
-- when it runs. This file creates the app_users/app_sessions/... auth tables in
-- a later section, so the grant above never reached them and the service_role the
-- API signs in with had no privilege on public.app_users at all: sign-in failed
-- with "permission denied for table app_users". Repeating the grants here, after
-- the last `create table`, gives every table - including any added above in
-- future - the privileges the backend and the PostgREST roles need.
--
-- Row level security, not these grants, is what isolates one customer's data
-- from another's: service_role carries BYPASSRLS (it is the backend's own role),
-- while anon and authenticated are still filtered by the policies defined above.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant select on all tables in schema public to anon, authenticated, service_role;
grant insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- Re-apply the deliberate revokes so the pass above cannot widen them: these
-- tables are backend-only and must stay unreadable to a signed-in customer.
revoke all on public.app_users, public.app_sessions, public.app_login_attempts,
            public.app_recovery_codes, public.app_auth_config, public.app_roles,
            public.app_permissions, public.app_role_permissions, public.app_user_roles,
            public.app_security_events
  from anon, authenticated;
revoke all on public.mqtt_credentials_metadata from anon, authenticated;
revoke all on public.member_permissions, public.member_access_rules, public.staff_invitations,
            public.device_pairing_tokens, public.platform_settings, public.platform_admins,
            public.emqx_usage_snapshots, public.emqx_sync_runs, public.usage_counters,
            public.firmware_storage_tests
  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Repair releases that were stored with no controller model.
--
-- An earlier uploader wrote the release row without its board_models, so a
-- published release could exist that no controller was ever offered. The models
-- are recoverable from the release it belongs to: the app and factory artifacts
-- of one upload share a version and channel and are always meant for the same
-- boards, so a row with an empty list takes the list from its siblings.
-- Nothing is deleted and no version changes; a release that even the siblings
-- cannot describe is left exactly as it is.
-- ---------------------------------------------------------------------------
update public.firmware_releases target
   set board_models = source.models
  from (
    select version, channel, chip_family, array_agg(distinct model) as models
      from public.firmware_releases r, unnest(r.board_models) as model
     where cardinality(r.board_models) > 0
     group by version, channel, chip_family
  ) source
 where target.version = source.version
   and target.channel = source.channel
   and target.chip_family = source.chip_family
   and cardinality(target.board_models) = 0;

grant execute on all functions in schema public to anon, authenticated, service_role;
