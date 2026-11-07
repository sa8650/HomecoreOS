-- ============================================================================
-- Helios — 0007 platform seed: permission catalog, system roles, defaults
-- ============================================================================

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
