-- ============================================================================
-- Helios — 0005 automation, firmware, platform ops, EMQX usage, audit
-- ============================================================================

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

-- Firmware binaries live in R2; this table is the release registry.
create table if not exists public.firmware_releases (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references public.tenants(id) on delete cascade,  -- null = platform-wide
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
create unique index if not exists firmware_release_version
  on public.firmware_releases (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), channel, version, chip_family);

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

-- Secrets are stored encrypted (AES-256-GCM, key in Worker secret).
create table if not exists public.platform_secrets (
  key         text primary key,
  ciphertext  text not null,
  iv          text not null,
  tag         text not null,
  fingerprint text,
  updated_by  uuid references public.profiles(id),
  updated_at  timestamptz not null default now()
);

-- Provider-reported EMQX usage. Nothing here is ever invented: a row exists
-- only when a value was obtained from the provider API or entered by the owner
-- with source='owner_manual'. Application estimates live in emqx_usage_estimates.
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

-- Usage counters for rate limiting and quotas (per tenant, per minute bucket).
create table if not exists public.usage_counters (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  bucket      timestamptz not null,
  metric      text not null,
  value       bigint not null default 0,
  primary key (tenant_id, bucket, metric)
);
