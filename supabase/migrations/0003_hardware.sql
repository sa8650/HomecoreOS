-- ============================================================================
-- Helios — 0003 board catalog, physical boards, GPIO pin management
-- ============================================================================

-- Versioned, platform-maintained board catalog (never a physical device).
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

-- Per-board physical pin map. chip_variant pins are identical across boards of
-- the same module, kept per board row so overrides (e.g. DevKitC GPIO6-11) fit.
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

-- Physical controller registered by a tenant.
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
create trigger user_boards_touch before update on public.user_boards
  for each row execute function public.tg_set_updated_at();

-- Pairing tokens: single-use, expiring, hashed at rest.
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

-- MQTT credentials per physical device (never stored in plaintext).
create table if not exists public.mqtt_credentials_metadata (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  user_board_id  uuid not null references public.user_boards(id) on delete cascade,
  username       text not null unique,
  password_hash  text not null,          -- local verification mirror (bcrypt/scrypt)
  provider       text not null default 'emqx',
  provider_ref   jsonb not null default '{}'::jsonb,
  status         text not null default 'active' check (status in ('active','rotated','revoked')),
  rotated_at     timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz not null default now()
);
create unique index if not exists mqtt_credentials_one_active
  on public.mqtt_credentials_metadata (user_board_id) where status = 'active';

-- Created automatically for every physical board so pins can be assigned
-- before a device exists. Function-based board semantics use a header key.
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

create trigger user_boards_seed_pins
  after insert on public.user_boards
  for each row execute function public.tg_seed_board_pins();

-- ---------------------------------------------------------------------------
-- GPIO allocation is transactional and enforced by the database.
-- A component occupying a pin exclusively holds one exclusive_allocations row.
-- Shared buses (I2C/SPI) are represented explicitly via shared_buses and never
-- consume exclusive ownership.
-- ---------------------------------------------------------------------------
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
  owner_id       uuid,                          -- devices.id / sensors.id once they exist
  function_kind  text not null,                 -- output | input | adc | pwm | dac | pulse ...
  bus_id         uuid references public.shared_buses(id) on delete cascade,
  created_at     timestamptz not null default now(),
  -- the real guarantee: one exclusive owner per (board, gpio)
  unique (user_board_id, gpio)
);
create index if not exists exclusive_allocations_tenant on public.exclusive_allocations (tenant_id);
create index if not exists exclusive_allocations_bus on public.exclusive_allocations (bus_id) where bus_id is not null;

-- ---------------------------------------------------------------------------
-- Procedural pin assignment used by the Worker inside a transaction.
-- Returns void; raises SQLSTATE 23505 (conflict) or 22023 (invalid).
-- ---------------------------------------------------------------------------
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
