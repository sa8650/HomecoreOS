-- ============================================================================
-- Helios — 0004 rooms, devices, sensors, telemetry
-- ============================================================================

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
create trigger rooms_touch before update on public.rooms
  for each row execute function public.tg_set_updated_at();

-- Device templates (platform default + tenant overrides).
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

-- Switches / relays / actuators — one row per controllable electronic device.
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
create trigger devices_touch before update on public.devices
  for each row execute function public.tg_set_updated_at();

-- Sensor definitions (configuration) — readings live in sensor_readings.
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
  thresholds        jsonb not null default '{}'::jsonb,   -- {low,high,emergency_low,emergency_high}
  topic_suffix      text,
  payload_path      text,                                 -- e.g. sensors.temperature_01.value
  transform         jsonb not null default '{}'::jsonb,   -- {multiplier, offset}
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
create trigger sensors_touch before update on public.sensors
  for each row execute function public.tg_set_updated_at();

-- Telemetry readings partitioned logically by time; retention handled by cron.
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

-- State transition audit for switches (requested vs confirmed).
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

-- Command ledger: guarantees idempotency, expiry and ack tracking for every
-- cloud -> device command, regardless of transport provider.
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

-- Config sync: immutable versioned configs the device downloads.
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
