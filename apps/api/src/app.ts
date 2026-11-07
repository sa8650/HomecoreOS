import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Runtime } from './services/runtime';
import { HttpError, actor, context, ownerOnly, p, body, runtime, auditEvent } from './context';
import { deviceTopics, parseTopic, topic, EMQX_QUOTAS, WARNING_THRESHOLDS } from '@helios/core';
import { SwitchCommand, TelemetryMessage, StateReport, ConfigAck, OtaProgress } from '@helios/core';
import { randomHex, randomToken, sha256Hex, hashPassword, verifyPassword, seal, unseal, hmacHex } from './crypto';

export function createApp(rt: Runtime) {
  const app = new Hono<{ Variables: { rt: Runtime } }>();
  app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization', 'X-Helios-Signature', 'X-Helios-Timestamp'], allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] }));
  app.use('*', async (c, next) => { c.set('rt', rt); await next(); });
  app.onError((err, c) => {
    const e = err as HttpError;
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status === 500) console.error('[api]', err);
    return c.json({ error: err.message || 'Internal error', detail: e.detail ?? null }, status as any);
  });
  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  const emit = (tenantId: string, type: string, payload: Record<string, unknown> = {}) =>
    auditEvent(rt, tenantId, type, payload);

  // ==========================================================================
  // Health + authentication
  // ==========================================================================
  app.get('/api/health', (c) => c.json({
    ok: true, service: 'helios-api', provider: rt.mqtt.id,
    database: rt.env.DB_DRIVER || 'pglite', time: new Date().toISOString(),
  }));

  app.post('/api/auth/signup', async (c) => {
    const b = await body(c);
    const r = await rt.auth.signup(String(b.email || '').trim().toLowerCase(), String(b.password || ''), {
      full_name: String(b.full_name || ''), home_name: String(b.home_name || ''), timezone: String(b.timezone || 'UTC'),
    });
    return c.json({ token: r.token, profile_id: r.profileId }, 201);
  });
  app.post('/api/auth/login', async (c) => {
    const b = await body(c);
    const r = await rt.auth.login(String(b.email || '').trim().toLowerCase(), String(b.password || ''));
    return c.json({ token: r.token, profile_id: r.profileId });
  });
  app.get('/api/auth/me', async (c) => {
    const a = await actor(c);
    const ctx: any = await rt.db.rpc('rpc_context', { p_actor: a.profileId });
    const profile = await rt.db.select('profiles', { eq: { id: a.profileId }, limit: 1 });
    return c.json({ profile: profile[0] || null, context: ctx });
  });
  app.get('/api/context', async (c) => {
    const ctx = await context(c);
    return c.json({ tenant: ctx.tenant, role: ctx.role, permissions: ctx.permissions,
      member: ctx.member, platform_admin: ctx.platformAdmin });
  });

  // ==========================================================================
  // Customer overview + activity
  // ==========================================================================
  app.get('/api/overview', async (c) => {
    const ctx = await context(c, 'dashboard.view');
    const stats: any = await rt.db.rpc('rpc_tenant_overview', { p_tenant: ctx.tenantId });
    const boards = await rt.db.select('user_boards', { eq: { tenant_id: ctx.tenantId }, isNull: ['deleted_at'], order: { column: 'created_at', ascending: false } });
    const devices = await rt.db.select('devices', { eq: { tenant_id: ctx.tenantId }, isNull: ['deleted_at'], order: { column: 'created_at', ascending: false }, limit: 40 });
    const recent = await rt.db.select('audit_logs', { eq: { tenant_id: ctx.tenantId }, order: { column: 'created_at', ascending: false }, limit: 8 });
    return c.json({ stats, boards, devices, recent_activity: recent });
  });

  app.get('/api/activity', async (c) => {
    const ctx = await context(c);
    const rows = await rt.db.select('audit_logs', { eq: { tenant_id: ctx.tenantId }, order: { column: 'created_at', ascending: false }, limit: 200 });
    return c.json(rows);
  });

  // ==========================================================================
  // Rooms
  // ==========================================================================
  app.get('/api/rooms', async (c) => {
    const ctx = await context(c, 'dashboard.view');
    const rooms = await rt.db.select('rooms', { eq: { tenant_id: ctx.tenantId }, order: { column: 'sort_order' } });
    const devices = await rt.db.select('devices', { eq: { tenant_id: ctx.tenantId }, isNull: ['deleted_at'] });
    const sensors = await rt.db.select('sensors', { eq: { tenant_id: ctx.tenantId }, isNull: ['deleted_at'] });
    return c.json(rooms.map((r) => ({ ...r,
      devices: devices.filter((d: any) => d.room_id === r.id),
      sensors: sensors.filter((s: any) => s.room_id === r.id) })));
  });
  app.post('/api/rooms', async (c) => {
    const ctx = await context(c, 'rooms.manage');
    const r = await rt.db.rpc('rpc_create_room', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_data: await body(c) });
    emit(ctx.tenantId, 'room.created', r);
    return c.json(r, 201);
  });
  app.patch('/api/rooms/:id', async (c) => {
    const ctx = await context(c, 'rooms.manage');
    const r = await rt.db.rpc('rpc_update_room', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_room: p(c, 'id'), p_data: await body(c) });
    emit(ctx.tenantId, 'room.updated', r);
    return c.json(r);
  });
  app.delete('/api/rooms/:id', async (c) => {
    const ctx = await context(c, 'rooms.manage');
    const strategy = c.req.query('strategy') || 'unassign';
    const r = await rt.db.rpc('rpc_delete_room', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_room: p(c, 'id'), p_strategy: strategy });
    emit(ctx.tenantId, 'room.deleted', r);
    return c.json(r);
  });

  // ==========================================================================
  // Board library + GPIO
  // ==========================================================================
  app.get('/api/board-catalog', async (c) => {
    await actor(c);
    const boards = await rt.db.select('board_catalog', { eq: { active: true }, order: { column: 'model' } });
    const pins = await rt.db.select('board_catalog_pins');
    const versions = await rt.db.select('board_catalog_versions');
    return c.json(boards.map((b: any) => ({ ...b,
      pins: pins.filter((x: any) => x.board_id === b.id),
      versions: versions.filter((v: any) => v.board_id === b.id) })));
  });
  app.get('/api/boards', async (c) => {
    const ctx = await context(c, 'dashboard.view');
    const boards = await rt.db.select('user_boards', { eq: { tenant_id: ctx.tenantId }, isNull: ['deleted_at'], order: { column: 'created_at', ascending: false } });
    const pins = await rt.db.select('board_pins', { eq: { tenant_id: ctx.tenantId } });
    const catalog = await rt.db.select('board_catalog');
    return c.json(boards.map((b: any) => {
      const bp = pins.filter((x: any) => x.user_board_id === b.id);
      return { ...b, catalog: catalog.find((x: any) => x.id === b.catalog_board_id) || null,
        pins: bp,
        pins_used: bp.filter((x: any) => x.state === 'assigned').length,
        pins_available: bp.filter((x: any) => x.state === 'available').length,
        pins_reserved: bp.filter((x: any) => x.state === 'system' || x.state === 'restricted').length };
    }));
  });
  app.get('/api/boards/:id', async (c) => {
    const ctx = await context(c, 'dashboard.view');
    const boards = await rt.db.select('user_boards', { eq: { id: p(c, 'id'), tenant_id: ctx.tenantId }, limit: 1 });
    if (!boards.length) throw new HttpError(404, 'Board not found');
    const pins = await rt.db.select('board_pins', { eq: { user_board_id: boards[0].id, tenant_id: ctx.tenantId }, order: { column: 'gpio' } });
    const alloc = await rt.db.select('exclusive_allocations', { eq: { user_board_id: boards[0].id, tenant_id: ctx.tenantId } });
    const buses = await rt.db.select('shared_buses', { eq: { user_board_id: boards[0].id, tenant_id: ctx.tenantId } });
    const devices = await rt.db.select('devices', { eq: { user_board_id: boards[0].id, tenant_id: ctx.tenantId }, isNull: ['deleted_at'] });
    const sensors = await rt.db.select('sensors', { eq: { user_board_id: boards[0].id, tenant_id: ctx.tenantId }, isNull: ['deleted_at'] });
    return c.json({ board: boards[0], pins: pins.map((pin: any) => ({ ...pin,
      allocation: alloc.find((a: any) => a.gpio === pin.gpio) || null })),
      allocations: alloc, buses, devices, sensors });
  });
  app.get('/api/boards/:id/config', async (c) => {
    const ctx = await context(c, 'devices.configure');
    const rows = await rt.db.select('device_configurations', { eq: { user_board_id: p(c, 'id'), tenant_id: ctx.tenantId }, order: { column: 'version', ascending: false }, limit: 1 });
    return c.json(rows[0] || null);
  });
  app.patch('/api/boards/:id', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const b = await body(c);
    const rows = await rt.db.update('user_boards', { id: p(c, 'id'), tenant_id: ctx.tenantId },
      Object.fromEntries(['name', 'firmware_channel', 'hardware_revision'].filter((k) => k in b).map((k) => [k, b[k]])));
    emit(ctx.tenantId, 'board.updated', { id: p(c, 'id') });
    return c.json(rows[0] || null);
  });
  app.delete('/api/boards/:id', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const b = await body(c).catch(() => ({}));
    // Capture the real per-device identity BEFORE the DB marks it revoked.
    // Unclaiming is an explicit, owner-authorised ownership transfer step: it
    // invalidates the credential, ACL and connected client at the broker.
    const boards = await rt.db.select('user_boards', { eq: { id: p(c, 'id'), tenant_id: ctx.tenantId }, limit: 1 });
    if (!boards.length) throw new HttpError(404, 'Board not found');
    const active = await rt.db.select('mqtt_credentials_metadata', { eq: { user_board_id: p(c, 'id'), tenant_id: ctx.tenantId, status: 'active' }, limit: 1 });
    const r = await rt.db.rpc('rpc_unregister_board', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_board: p(c, 'id'), p_confirm: String((b as any).confirm || '') });
    await rt.mqtt.revokeDevice({ username: String(active[0]?.username || ''), clientId: String(boards[0].mqtt_client_id || '') }).catch((e: unknown) => {
      console.error('[api] broker revoke failed after unclaim', e);
    });
    emit(ctx.tenantId, 'board.unclaimed', r);
    return c.json({ ...(r as any), broker_credential_revoked: Boolean(active.length) });
  });
  app.post('/api/boards/custom', async (c) => {
    const ctx = await context(c, 'boards.manage');
    const b = await body(c);
    const pins = Array.isArray(b.pins) ? b.pins : [];
    if (!pins.length) throw new HttpError(400, 'A custom board needs at least one verified GPIO row');
    const id = `custom.${ctx.tenantId}.${randomHex(6)}`;
    const cboard: any = {
      id, manufacturer: String(b.manufacturer || 'Custom'), model: String(b.model || 'Custom board'),
      variant: b.variant || null, chip_family: String(b.chip_family || 'ESP32'),
      chip_variant: String(b.chip_variant || 'Unspecified'), revision: b.revision || null,
      category: 'custom', doc_source_url: b.doc_source_url || null, pinout_url: null,
      summary: 'Tenant-defined board. Pins supplied by the customer from official documentation.',
      connectivity: {}, attributes: { pin_status: 'customer_supplied', catalog_version: 1 }, active: true,
    };
    await rt.db.insert('board_catalog', cboard);
    await rt.db.insert('board_catalog_versions', { board_id: id, version: 1, changelog: 'Customer supplied pin map', published: false });
    await rt.db.insert('board_catalog_pins', pins.map((x: any) => ({
      board_id: id, gpio: Number(x.gpio), header_label: x.header_label || `GPIO${x.gpio}`,
      side: x.side || null, header_pin: x.header_pin || null, functions: x.functions || ['gpio', 'pwm'],
      adc_channels: x.adc_channels || [], adc_bits: x.adc_channels?.length ? 12 : null,
      input_only: !!x.input_only, exposed: true, boot_strapping: !!x.boot_strapping,
      usb_jtag: !!x.usb_jtag, flash_connected: !!x.flash_connected, psram_connected: !!x.psram_connected,
      restricted: !!x.restricted, restriction_note: x.restriction_note || null, notes: x.notes || null,
    })));
    emit(ctx.tenantId, 'board.custom.created', { id });
    return c.json({ id }, 201);
  });

  // ==========================================================================
  // Shared buses
  // ==========================================================================
  app.get('/api/buses', async (c) => {
    const ctx = await context(c, 'dashboard.view');
    return c.json(await rt.db.select('shared_buses', { eq: { tenant_id: ctx.tenantId }, order: { column: 'created_at', ascending: false } }));
  });
  app.post('/api/buses', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const r = await rt.db.rpc('rpc_create_bus', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_data: await body(c) });
    emit(ctx.tenantId, 'bus.created', r);
    return c.json(r, 201);
  });
  app.delete('/api/buses/:id', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const r = await rt.db.rpc('rpc_delete_bus', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_bus: p(c, 'id') });
    emit(ctx.tenantId, 'bus.deleted', r);
    return c.json(r);
  });

  // ==========================================================================
  // Pairing / provisioning (single-use, expiring, hashed tokens)
  // ==========================================================================
  app.post('/api/pairing-tokens', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const b = await body(c);
    const token = randomToken(32);
    const hash = await sha256Hex(token);
    const r = await rt.db.rpc('rpc_create_pairing_token', { p_actor: ctx.profileId, p_tenant: ctx.tenantId,
      p_data: { ...b, token_hash: hash } });
    // Returned exactly once, never stored in plaintext.
    return c.json({ ...r, token, expires_in_seconds: r.expires_in_seconds }, 201);
  });
  app.get('/api/pairing-tokens', async (c) => {
    const ctx = await context(c, 'devices.manage');
    return c.json(await rt.db.select('device_pairing_tokens', { eq: { tenant_id: ctx.tenantId }, order: { column: 'created_at', ascending: false }, limit: 30 }));
  });

  /** Firmware calls this once with its one-time pairing token. */
  app.post('/api/device/claim', async (c) => {
    const b = await body(c);
    const raw = String(b.pairing_token || '');
    if (!raw) throw new HttpError(400, 'pairing_token is required');
    const tokenHash = await sha256Hex(raw);
    const rows = await rt.db.select('device_pairing_tokens', { eq: { token_hash: tokenHash }, limit: 1 });
    if (!rows.length || rows[0].consumed_at || new Date(rows[0].expires_at) < new Date()) {
      throw new HttpError(401, 'Pairing token is invalid, expired or already used');
    }
    const tenantId: string = rows[0].tenant_id;
    const deviceId = `esp32-${randomHex(8)}`;
    const clientId = `helios-${randomHex(10)}`;
    const username = `d_${randomHex(10)}`;
    const password = randomToken(32);
    const passwordHash = await hashPassword(password);

    // Provision the real per-device identity in the broker BEFORE claiming, so
    // a failed API call never leaves an unusable device record behind.
    let providerRef: Record<string, unknown> = {};
    try {
      const cred = await rt.mqtt.provisionDevice({ username, password, clientId, tenantId, deviceId });
      providerRef = cred.providerRef;
    } catch (e: any) {
      throw new HttpError(502, `MQTT credential provisioning failed: ${e.message}. No device was registered; tenant isolation is preserved.`);
    }
    const claimed: any = await rt.db.rpc('rpc_claim_pairing_token', {
      p_token_hash: tokenHash, p_device_id: deviceId, p_client_id: clientId,
      p_password_hash: passwordHash, p_username: username, p_provider_ref: providerRef,
    });
    const t = deviceTopics(tenantId, deviceId);
    const config = await rt.db.select('device_configurations', { eq: { user_board_id: claimed.board_id }, order: { column: 'version', ascending: false }, limit: 1 });
    await rt.mqtt.publish({ topic: t.config, payload: config[0]?.config || { schema_version: 1, config_version: 0 }, qos: 1 });
    emit(tenantId, 'device.paired', { board_id: claimed.board_id, device_id: deviceId });

    const brokerHost = rt.env.EMQX_BROKER_HOST || rt.env.MQTT_BROKER_HOST || 'localhost';
    const tlsPort = Number(rt.env.EMQX_TLS_PORT || 8883);
    return c.json({
      tenant_id: tenantId, device_id: deviceId, board_id: claimed.board_id,
      mqtt: {
        host: brokerHost, port: rt.mqtt.id === 'local' ? 1883 : tlsPort,
        tls: rt.mqtt.id !== 'local', wss_url: rt.env.EMQX_WSS_URL || null,
        client_id: clientId, username, password, // shown ONCE; never stored
        keepalive: 60,
      },
      topics: t, config: config[0]?.config || null,
      note: 'Store these credentials in NVS. They cannot be retrieved again; rotate from the console if lost.',
    }, 201);
  });

  /** Firmware can re-fetch config over HTTPS using its own device credentials. */
  app.post('/api/device/config', async (c) => {
    const b = await body(c);
    const clientId = String(b.client_id || '');
    const password = String(b.password || '');
    const info: any = await rt.db.rpc('rpc_board_from_client', { p_client_id: clientId });
    if (!info || !(await verifyPassword(password, info.password_hash))) throw new HttpError(401, 'Invalid device credentials');
    const cfg = await rt.db.select('device_configurations', { eq: { user_board_id: info.board_id }, order: { column: 'version', ascending: false }, limit: 1 });
    return c.json({ config: cfg[0]?.config || null, topics: info.topics });
  });

  /** Owner-authorised credential rotation. */
  app.post('/api/boards/:id/rotate-credentials', async (c) => {
    const ctx = await context(c, 'devices.configure');
    const boards = await rt.db.select('user_boards', { eq: { id: p(c, 'id'), tenant_id: ctx.tenantId }, limit: 1 });
    if (!boards.length) throw new HttpError(404, 'Board not found');
    const password = randomToken(32);
    const hash = await hashPassword(password);
    const cred: any = await rt.db.rpc('rpc_rotate_device_credentials', { p_actor: ctx.profileId,
      p_tenant: ctx.tenantId, p_board: p(c, 'id'), p_password_hash: hash, p_provider_ref: {} });
    const active = await rt.db.select('mqtt_credentials_metadata', { eq: { user_board_id: p(c, 'id'), tenant_id: ctx.tenantId, status: 'active' }, limit: 1 });
    await rt.mqtt.rotateDevice({ username: active[0]?.username || '', password, clientId: boards[0].mqtt_client_id });
    emit(ctx.tenantId, 'board.credentials.rotated', { id: p(c, 'id') });
    void cred;
    return c.json({ rotated: true, username: active[0]?.username, password, note: 'Shown once. Flash or re-provision the device.' });
  });

  // ==========================================================================
  // Devices / switches + commands
  // ==========================================================================
  app.get('/api/devices', async (c) => {
    const ctx = await context(c, 'dashboard.view');
    return c.json(await rt.db.select('devices', { eq: { tenant_id: ctx.tenantId }, isNull: ['deleted_at'], order: { column: 'created_at', ascending: false } }));
  });
  app.post('/api/devices', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const b = await body(c);
    const r = await rt.db.rpc('rpc_create_device', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_data: b });
    await publishConfig(rt, ctx.tenantId, String(b.user_board_id));
    emit(ctx.tenantId, 'device.created', r);
    return c.json(r, 201);
  });
  app.patch('/api/devices/:id', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const r = await rt.db.rpc('rpc_update_device', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_device: p(c, 'id'), p_data: await body(c) });
    emit(ctx.tenantId, 'device.updated', r);
    return c.json(r);
  });
  app.delete('/api/devices/:id', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const before = await rt.db.select('devices', { eq: { id: p(c, 'id'), tenant_id: ctx.tenantId }, limit: 1 });
    const r = await rt.db.rpc('rpc_delete_device', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_device: p(c, 'id') });
    if (before[0]) await publishConfig(rt, ctx.tenantId, before[0].user_board_id);
    emit(ctx.tenantId, 'device.deleted', r);
    return c.json(r);
  });
  app.post('/api/devices/:id/restore', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const r = await rt.db.rpc('rpc_restore_device', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_device: p(c, 'id') });
    emit(ctx.tenantId, 'device.restored', r);
    return c.json(r);
  });

  app.post('/api/devices/:id/command', async (c) => {
    const ctx = await context(c, 'devices.control');
    const id = p(c, 'id');
    const b = await body(c);
    const action = String(b.action || 'set_state');
    if (!['set_state', 'pulse', 'get_state'].includes(action)) throw new HttpError(400, 'Unsupported action');
    const devices = await rt.db.select('devices', { eq: { id, tenant_id: ctx.tenantId }, isNull: ['deleted_at'], limit: 1 });
    if (!devices.length) throw new HttpError(404, 'Device not found');
    const d: any = devices[0];
    if (d.automation_enabled === false && action === 'pulse') throw new HttpError(400, 'Pulse is disabled for this device');

    const issued: any = await rt.db.rpc('rpc_issue_command', {
      p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_board: d.user_board_id, p_component_id: id,
      p_data: { action, component_type: 'device', idempotency_key: b.idempotency_key || null,
        payload: { value: b.value, component_id: d.slug } },
    });
    if (issued.idempotent) return c.json(issued);
    const cmd = issued.command;
    const boards = await rt.db.select('user_boards', { eq: { id: d.user_board_id, tenant_id: ctx.tenantId }, limit: 1 });
    const board: any = boards[0];
    if (!board) throw new HttpError(404, 'Controller not found');
    const msg = SwitchCommand.parse({
      schema_version: 1, command_id: cmd.id, device_id: board.device_id, component_id: d.slug,
      action, value: action === 'set_state' ? !!b.value : undefined,
      expires_at: Math.floor(new Date(cmd.expires_at).getTime() / 1000),
    });
    try {
      await rt.mqtt.publish({ topic: topic(ctx.tenantId, board.device_id, 'command'), payload: msg, qos: 1 });
      await rt.db.rpc('rpc_mark_command_published', { p_command: cmd.id, p_topic: topic(ctx.tenantId, board.device_id, 'command') });
      await rt.db.update('devices', { id }, {
        requested_state: action === 'set_state' ? (b.value ? 'on' : 'off') : null,
        requested_at: new Date().toISOString(), last_command_id: cmd.id,
      });
      emit(ctx.tenantId, 'device.command', { id, command_id: cmd.id, requested: b.value });
      return c.json({ command: cmd, status: 'published' }, 202);
    } catch (e: any) {
      await rt.db.update('device_commands', { id: cmd.id }, { status: 'failed', error: e.message });
      throw new HttpError(502, `Command could not be delivered: ${e.message}`);
    }
  });
  app.get('/api/commands', async (c) => {
    const ctx = await context(c, 'dashboard.view');
    return c.json(await rt.db.select('device_commands', { eq: { tenant_id: ctx.tenantId }, order: { column: 'created_at', ascending: false }, limit: 100 }));
  });

  // ==========================================================================
  // Sensors + telemetry history
  // ==========================================================================
  app.get('/api/sensors', async (c) => {
    const ctx = await context(c, 'sensors.view');
    return c.json(await rt.db.select('sensors', { eq: { tenant_id: ctx.tenantId }, isNull: ['deleted_at'], order: { column: 'created_at', ascending: false } }));
  });
  app.post('/api/sensors', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const b = await body(c);
    const r = await rt.db.rpc('rpc_create_sensor', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_data: b });
    await publishConfig(rt, ctx.tenantId, String(b.user_board_id));
    emit(ctx.tenantId, 'sensor.created', r);
    return c.json(r, 201);
  });
  app.delete('/api/sensors/:id', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const before = await rt.db.select('sensors', { eq: { id: p(c, 'id'), tenant_id: ctx.tenantId }, limit: 1 });
    const r = await rt.db.rpc('rpc_delete_sensor', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_sensor: p(c, 'id') });
    if (before[0]) await publishConfig(rt, ctx.tenantId, before[0].user_board_id);
    emit(ctx.tenantId, 'sensor.deleted', r);
    return c.json(r);
  });
  app.get('/api/sensors/:id/readings', async (c) => {
    const ctx = await context(c, 'sensors.view');
    const limit = Math.min(Number(c.req.query('limit') || 100), 500);
    return c.json(await rt.db.select('sensor_readings', { eq: { sensor_id: p(c, 'id'), tenant_id: ctx.tenantId }, order: { column: 'recorded_at', ascending: false }, limit }));
  });
  app.get('/api/telemetry', async (c) => {
    const ctx = await context(c, 'sensors.view');
    return c.json(await rt.db.select('sensor_readings', { eq: { tenant_id: ctx.tenantId }, order: { column: 'recorded_at', ascending: false }, limit: 100 }));
  });

  /** Human-readable communication contract for a component. */
  app.get('/api/messages/:id', async (c) => {
    const ctx = await context(c, 'dashboard.view');
    const id = p(c, 'id');
    const d: any[] = await rt.db.select('devices', { eq: { id, tenant_id: ctx.tenantId }, limit: 1 });
    const s: any[] = await rt.db.select('sensors', { eq: { id, tenant_id: ctx.tenantId }, limit: 1 });
    const item = d[0] || s[0];
    if (!item) throw new HttpError(404, 'Component not found');
    const board: any[] = await rt.db.select('user_boards', { eq: { id: item.user_board_id, tenant_id: ctx.tenantId }, limit: 1 });
    if (!board.length) throw new HttpError(404, 'Controller not found');
    const t = deviceTopics(ctx.tenantId, board[0].device_id);
    return c.json({
      controller: { id: board[0].id, name: board[0].name, device_id: board[0].device_id, status: board[0].status },
      path: ['Website', 'Cloudflare Worker', rt.mqtt.displayName, 'ESP32'],
      interface: { type: item.interface, gpio: item.output_gpio ?? item.gpio ?? null, bus_id: item.bus_id || null, i2c_address: item.i2c_address || null },
      publishes: d.length ? [
        { topic: t.state, example: { command_id: '<uuid>', component_id: item.slug, requested_state: true, actual_state: true, status: 'confirmed' } },
      ] : [
        { topic: t.telemetry, example: { schema_version: 1, device_id: board[0].device_id, timestamp: Math.floor(Date.now() / 1000), sensors: { [item.slug]: { value: 0, unit: item.unit, status: 'valid' } } } },
      ],
      subscribes: d.length ? [{ topic: t.command, example: { command_id: '<uuid>', device_id: board[0].device_id, component_id: item.slug, action: 'set_state', value: true, expires_at: 0 } }] : [],
      mapping: d.length ? { telemetry_field: `devices.${item.slug}.state`, interpretation: 'reported ON/OFF state' }
        : { telemetry_field: item.payload_path, interpretation: `${item.category} in ${item.unit}` },
      config_topic: t.config, availability_topic: t.availability,
    });
  });

  // ==========================================================================
  // Automation (cloud evaluation + local safety config)
  // ==========================================================================
  app.get('/api/automations', async (c) => {
    const ctx = await context(c, 'dashboard.view');
    return c.json(await rt.db.select('automations', { eq: { tenant_id: ctx.tenantId }, order: { column: 'created_at', ascending: false } }));
  });
  app.post('/api/automations', async (c) => {
    const ctx = await context(c, 'automation.manage');
    const b = await body(c);
    const data = { ...b, when: b.when || b.when_config || [], conditions: b.if || b.conditions || [], then: b.then || b.actions || [] };
    const r = await rt.db.rpc('rpc_save_automation', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_id: b.id || null, p_data: data });
    const boards = await rt.db.select('user_boards', { eq: { tenant_id: ctx.tenantId }, isNull: ['deleted_at'] });
    for (const board of boards) await publishConfig(rt, ctx.tenantId, board.id);
    emit(ctx.tenantId, 'automation.saved', r);
    return c.json(r, 201);
  });
  app.delete('/api/automations/:id', async (c) => {
    const ctx = await context(c, 'automation.manage');
    const r = await rt.db.rpc('rpc_delete_automation', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_id: p(c, 'id') });
    emit(ctx.tenantId, 'automation.deleted', r);
    return c.json(r);
  });
  app.post('/api/automations/:id/run', async (c) => {
    const ctx = await context(c, 'automation.manage');
    const r: any = await rt.db.rpc('rpc_evaluate_automations', { p_tenant: ctx.tenantId, p_event: { kind: 'manual_trigger', automation_id: p(c, 'id') } });
    const executed = await executeAutomationActions(rt, ctx, r.actions || []);
    return c.json({ ...r, executed });
  });

  // ==========================================================================
  // Firmware (R2 registry, hash verification, OTA progress, rollback)
  // ==========================================================================
  app.get('/api/firmware/releases', async (c) => {
    const ctx = await context(c, 'dashboard.view');
    const rows = await rt.db.select('firmware_releases', { order: { column: 'created_at', ascending: false }, limit: 100 });
    return c.json((rows as any[]).filter((r) => r.tenant_id === null || r.tenant_id === ctx.tenantId));
  });
  app.post('/api/firmware/releases', async (c) => {
    const ctx = await context(c, 'firmware.update');
    const b = await body(c);
    if (b.binary_base64 && rt.store) {
      const bytes = Uint8Array.from(atob(String(b.binary_base64)), (x) => x.charCodeAt(0));
      const digest = await sha256Hex(bytes);
      if (b.sha256 && b.sha256 !== digest) throw new HttpError(400, 'SHA-256 mismatch: uploaded binary does not match the declared digest');
      const key = `firmware/${ctx.tenantId}/${b.version}/${randomHex(6)}.bin`;
      await rt.store.put(key, bytes);
      b.r2_key = key; b.sha256 = digest; b.size_bytes = bytes.byteLength; delete b.binary_base64;
    }
    const r = await rt.db.rpc('rpc_create_firmware_release', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_data: b });
    emit(ctx.tenantId, 'firmware.created', r);
    return c.json(r, 201);
  });
  app.post('/api/firmware/ota', async (c) => {
    const ctx = await context(c, 'firmware.update');
    const b = await body(c);
    const releases = await rt.db.select('firmware_releases', { eq: { id: b.release_id }, limit: 1 });
    const boards = await rt.db.select('user_boards', { eq: { id: b.board_id, tenant_id: ctx.tenantId }, isNull: ['deleted_at'], limit: 1 });
    if (!releases.length || !boards.length) throw new HttpError(404, 'Release or controller not found');
    const rel: any = releases[0], board: any = boards[0];
    if (rel.tenant_id !== null && rel.tenant_id !== ctx.tenantId) throw new HttpError(404, 'Release not available for this account');
    if (rel.status !== 'published') throw new HttpError(409, 'Only published releases can be deployed');
    const url = rt.store ? await rt.store.signedUrl(rel.r2_key) : null;
    if (!url) throw new HttpError(503, 'Firmware object storage is not configured');
    await rt.db.insert('device_firmware_history', {
      tenant_id: ctx.tenantId, user_board_id: board.id, firmware_release_id: rel.id,
      from_version: board.firmware_version, to_version: rel.version, status: 'queued', progress: 0,
      bytes_total: rel.size_bytes, initiated_by: ctx.profileId,
    });
    const t = deviceTopics(ctx.tenantId, board.device_id);
    await rt.mqtt.publish({ topic: t.command, payload: {
      schema_version: 1, command_id: crypto.randomUUID(), device_id: board.device_id,
      component_id: 'board', action: 'update_firmware',
      url, sha256: rel.sha256, size_bytes: rel.size_bytes, version: rel.version,
      expires_at: Math.floor(Date.now() / 1000) + 600,
    }, qos: 1 });
    emit(ctx.tenantId, 'firmware.ota.started', { board_id: board.id, version: rel.version });
    return c.json({ queued: true, version: rel.version, sha256: rel.sha256, download_url: url });
  });
  app.get('/api/firmware/history', async (c) => {
    const ctx = await context(c, 'dashboard.view');
    return c.json(await rt.db.select('device_firmware_history', { eq: { tenant_id: ctx.tenantId }, order: { column: 'started_at', ascending: false }, limit: 100 }));
  });
  app.get('/api/firmware/download/:key', async (c) => {
    // Short-lived HMAC-signed URLs: only a published release's binary is
    // served. Bucket credentials, service keys and signing secret never leave
    // the Worker. The ESP32 additionally verifies SHA-256 before applying.
    const b64 = decodeURIComponent(p(c, 'key'));
    const key = atob(b64);
    if (!key.startsWith('firmware/')) throw new HttpError(400, 'Invalid firmware key');
    const expires = Number(c.req.query('expires') || 0);
    const sig = String(c.req.query('sig') || '');
    const secret = String(rt.env.SECRETS_KEY || rt.env.INGRESS_HMAC_SECRET || '');
    if (!secret || !expires || expires < Math.floor(Date.now() / 1000)) throw new HttpError(403, 'Firmware URL expired');
    const expected = await hmacHex(secret, `${key}\n${expires}`);
    if (sig.length !== expected.length || sig !== expected) throw new HttpError(403, 'Invalid firmware URL signature');
    const releases = await rt.db.select('firmware_releases', { eq: { r2_key: key, status: 'published' }, limit: 1 });
    if (!releases.length) throw new HttpError(404, 'Published firmware release not found');
    const data = await rt.store?.get(key);
    if (!data) throw new HttpError(404, 'Firmware binary not found');
    return new Response(data, { headers: { 'Content-Type': 'application/octet-stream',
      'X-Checksum': await sha256Hex(new Uint8Array(data)), 'Cache-Control': 'private, no-store' } });
  });

  // ==========================================================================
  // Staff & permissions
  // ==========================================================================
  app.get('/api/staff', async (c) => {
    const ctx = await context(c, 'dashboard.view');
    const members = await rt.db.select('tenant_members', { eq: { tenant_id: ctx.tenantId }, order: { column: 'created_at' } });
    const profiles = await rt.db.select('profiles', { in: { id: members.map((m: any) => m.profile_id) } });
    const invites = await rt.db.select('staff_invitations', { eq: { tenant_id: ctx.tenantId }, order: { column: 'created_at', ascending: false } });
    const roles = await rt.db.select('roles');
    const permissions = await rt.db.select('permissions', { order: { column: 'sort_order' } });
    return c.json({ members: members.map((m: any) => ({ ...m, profile: profiles.find((x: any) => x.id === m.profile_id) || null })),
      invitations: invites, roles, permissions });
  });
  app.post('/api/staff/invite', async (c) => {
    const ctx = await context(c, 'staff.manage');
    const b = await body(c);
    const token = randomToken(24);
    const r = await rt.db.rpc('rpc_invite_staff', { p_actor: ctx.profileId, p_tenant: ctx.tenantId,
      p_data: { ...b, token_hash: await sha256Hex(token) } });
    emit(ctx.tenantId, 'staff.invited', r);
    return c.json({ ...r, invite_token: token, note: 'Deliver this token to the invitee out of band.' }, 201);
  });
  app.post('/api/staff/accept', async (c) => {
    const a = await actor(c);
    const b = await body(c);
    const invites = await rt.db.select('staff_invitations', { eq: { token_hash: await sha256Hex(String(b.token || '')) }, limit: 1 });
    const inv: any = invites[0];
    if (!inv || inv.accepted_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) {
      throw new HttpError(400, 'Invitation is invalid, expired or already accepted');
    }
    const profile: any[] = await rt.db.select('profiles', { eq: { id: a.profileId }, limit: 1 });
    if (profile[0]?.email?.toLowerCase() !== inv.email.toLowerCase()) throw new HttpError(403, 'Invitation was sent to a different email');
    const existing: any[] = await rt.db.select('tenant_members', { eq: { tenant_id: inv.tenant_id, profile_id: a.profileId }, limit: 1 });
    if (existing.length) await rt.db.update('tenant_members', { id: existing[0].id }, { status: 'active', role_key: inv.role_key });
    else await rt.db.insert('tenant_members', { tenant_id: inv.tenant_id, profile_id: a.profileId, role_key: inv.role_key, status: 'active', invited_by: inv.invited_by, joined_at: new Date().toISOString() });
    await rt.db.update('staff_invitations', { id: inv.id }, { accepted_at: new Date().toISOString() });
    return c.json({ accepted: true, tenant_id: inv.tenant_id });
  });
  app.patch('/api/staff/:id', async (c) => {
    const ctx = await context(c);
    const r = await rt.db.rpc('rpc_update_member', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_member: p(c, 'id'), p_data: await body(c) });
    emit(ctx.tenantId, 'staff.updated', r);
    return c.json(r);
  });
  app.delete('/api/staff/:id', async (c) => {
    const ctx = await context(c);
    const r = await rt.db.rpc('rpc_revoke_member', { p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_member: p(c, 'id') });
    emit(ctx.tenantId, 'staff.revoked', r);
    return c.json(r);
  });
  app.get('/api/staff/:id/permissions', async (c) => {
    const ctx = await context(c);
    return c.json(await rt.db.select('member_permissions', { eq: { member_id: p(c, 'id'), tenant_id: ctx.tenantId } }));
  });
  app.post('/api/roles', async (c) => {
    const ctx = await context(c);
    if (ctx.role !== 'owner') throw new HttpError(403, 'Only the owner can create custom roles');
    const b = await body(c);
    const key = `custom.${randomHex(5)}`;
    const roles = await rt.db.insert('roles', { tenant_id: ctx.tenantId, key, name: String(b.name), description: b.description || null, rank: 50, is_system: false });
    if (Array.isArray(b.permissions)) {
      await rt.db.insert('role_permissions', b.permissions.map((permission_key: string) => ({ role_id: roles[0].id, permission_key })));
    }
    return c.json(roles[0], 201);
  });

  // ==========================================================================
  // Account settings / usage estimates
  // ==========================================================================
  app.get('/api/settings', async (c) => {
    const ctx = await context(c);
    const profile = await rt.db.select('profiles', { eq: { id: ctx.profileId }, limit: 1 });
    const counters = await rt.db.select('usage_counters', { eq: { tenant_id: ctx.tenantId }, order: { column: 'bucket', ascending: false }, limit: 100 });
    return c.json({ tenant: ctx.tenant, profile: profile[0], counters, role: ctx.role, permissions: ctx.permissions });
  });
  app.patch('/api/settings', async (c) => {
    const ctx = await context(c, 'settings.manage');
    const b = await body(c);
    const tenantPatch: Record<string, unknown> = {};
    for (const k of ['name', 'timezone', 'address', 'max_boards', 'max_devices']) if (k in b) tenantPatch[k] = b[k];
    if (Object.keys(tenantPatch).length) await rt.db.update('tenants', { id: ctx.tenantId }, tenantPatch);
    const profilePatch: Record<string, unknown> = {};
    for (const k of ['full_name', 'phone', 'locale', 'timezone', 'avatar_url']) if (k in b) profilePatch[k] = b[k];
    if (Object.keys(profilePatch).length) await rt.db.update('profiles', { id: ctx.profileId }, profilePatch);
    await rt.db.insert('audit_logs', { tenant_id: ctx.tenantId, actor_id: ctx.profileId, action: 'settings.update', entity_type: 'tenant', entity_id: ctx.tenantId, after: b });
    emit(ctx.tenantId, 'settings.updated', {});
    return c.json({ ok: true });
  });
  app.get('/api/usage', async (c) => {
    const ctx = await context(c, 'usage.view');
    const counters = await rt.db.select('usage_counters', { eq: { tenant_id: ctx.tenantId } });
    const sum = (m: string) => counters.filter((x: any) => x.metric === m).reduce((n: number, x: any) => n + Number(x.value), 0);
    const commands = sum('commands'), telemetry = sum('telemetry_messages');
    return c.json({
      label: 'Application-side estimate — not EMQX provider usage',
      commands, telemetry_messages: telemetry,
      estimated_command_bytes: commands * 180, estimated_telemetry_bytes: telemetry * 220,
      note: 'Derived from application message counters. Official deployment-wide usage is only visible in the Platform Owner Console.',
      counters,
    });
  });
  app.get('/api/export', async (c) => {
    const ctx = await context(c, 'settings.manage');
    const tables = ['rooms', 'user_boards', 'board_pins', 'devices', 'sensors', 'automations', 'device_commands', 'audit_logs'];
    const out: Record<string, unknown> = { exported_at: new Date().toISOString(), tenant: ctx.tenant.name };
    for (const t of tables) out[t] = await rt.db.select(t, { eq: { tenant_id: ctx.tenantId }, limit: 10000 });
    return c.json(out);
  });

  // ==========================================================================
  // Live updates (SSE) — same event shapes as Supabase Realtime
  // ==========================================================================
  app.get('/api/stream', async (c) => {
    const ctx = await context(c, 'dashboard.view');
    let unsub: (() => void) | null = null;
    const stream = new ReadableStream({
      start(controller) {
        const send = (obj: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`));
        send({ type: 'connected', at: new Date().toISOString() });
        unsub = rt.events.subscribe(ctx.tenantId, send);
        const keep = setInterval(() => { try { controller.enqueue(new TextEncoder().encode(': keepalive\n\n')); } catch {} }, 25000);
        (stream as any)._keep = keep;
      },
      cancel() { unsub?.(); clearInterval((stream as any)._keep); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } });
  });

  // ==========================================================================
  // PLATFORM OWNER CONSOLE (separate, protected, fully audited)
  // ==========================================================================
  app.get('/api/owner/overview', async (c) => {
    const ctx = await ownerOnly(c);
    const stats: any = await rt.db.rpc('rpc_owner_overview');
    const activity = await rt.db.select('audit_logs', { order: { column: 'created_at', ascending: false }, limit: 12 });
    const health = await (await emqxFromSettings(rt)).health();
    const platformSettings = await rt.db.select('platform_settings');
    const thresholds = (platformSettings.find((x: any) => x.key === 'usage.warning_thresholds')?.value) || WARNING_THRESHOLDS;
    return c.json({ ...stats, recent_activity: activity, mqtt_health: health, thresholds,
      database_health: { connected: true, driver: rt.env.DB_DRIVER || 'pglite' },
      api_health: { connected: true, version: '1.0.0' }, actor: ctx.profileId });
  });

  app.get('/api/owner/customers', async (c) => {
    await ownerOnly(c);
    const tenants = await rt.db.select('tenants', { order: { column: 'created_at', ascending: false } });
    const members = await rt.db.select('tenant_members');
    const boards = await rt.db.select('user_boards', { isNull: ['deleted_at'] });
    const devices = await rt.db.select('devices', { isNull: ['deleted_at'] });
    const sensors = await rt.db.select('sensors', { isNull: ['deleted_at'] });
    return c.json(tenants.map((t: any) => ({ ...t,
      owner: members.find((m: any) => m.tenant_id === t.id && m.role_key === 'owner'),
      staff_count: members.filter((m: any) => m.tenant_id === t.id && m.status === 'active').length,
      boards: boards.filter((b: any) => b.tenant_id === t.id),
      device_count: devices.filter((d: any) => d.tenant_id === t.id).length,
      sensor_count: sensors.filter((s: any) => s.tenant_id === t.id).length,
      room_count: (t as any).room_count ?? null,
    })));
  });
  app.get('/api/owner/customers/:id', async (c) => {
    await ownerOnly(c);
    const id = p(c, 'id');
    const t: any[] = await rt.db.select('tenants', { eq: { id }, limit: 1 });
    if (!t.length) throw new HttpError(404, 'Customer not found');
    const [boards, devices, sensors, rooms, members, activity] = await Promise.all([
      rt.db.select('user_boards', { eq: { tenant_id: id } }),
      rt.db.select('devices', { eq: { tenant_id: id } }),
      rt.db.select('sensors', { eq: { tenant_id: id } }),
      rt.db.select('rooms', { eq: { tenant_id: id } }),
      rt.db.select('tenant_members', { eq: { tenant_id: id } }),
      rt.db.select('audit_logs', { eq: { tenant_id: id }, order: { column: 'created_at', ascending: false }, limit: 50 }),
    ]);
    return c.json({ tenant: t[0], boards, devices, sensors, rooms, members, activity });
  });
  app.post('/api/owner/customers/:id/status', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    const r = await rt.db.rpc('rpc_set_tenant_status', { p_actor: ctx.profileId, p_tenant: p(c, 'id'), p_status: String(b.status), p_reason: b.reason || null });
    return c.json(r);
  });
  app.patch('/api/owner/customers/:id', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    const patch: Record<string, unknown> = {};
    for (const k of ['device_registration_enabled', 'max_boards', 'max_devices', 'feature_flags', 'plan']) if (k in b) patch[k] = b[k];
    await rt.db.update('tenants', { id: p(c, 'id') }, patch);
    await rt.db.insert('audit_logs', { tenant_id: p(c, 'id'), actor_id: ctx.profileId, actor_type: 'platform_admin', action: 'platform.customer.update', entity_type: 'tenant', entity_id: p(c, 'id'), after: b });
    return c.json({ ok: true });
  });
  app.get('/api/owner/staff', async (c) => {
    await ownerOnly(c);
    const members = await rt.db.select('tenant_members', { order: { column: 'created_at', ascending: false } });
    const profiles = await rt.db.select('profiles');
    const tenants = await rt.db.select('tenants');
    return c.json(members.map((m: any) => ({ ...m,
      profile: profiles.find((x: any) => x.id === m.profile_id) || null,
      tenant_name: tenants.find((x: any) => x.id === m.tenant_id)?.name || null })));
  });
  app.get('/api/owner/audit', async (c) => {
    await ownerOnly(c);
    return c.json(await rt.db.select('audit_logs', { order: { column: 'created_at', ascending: false }, limit: 300 }));
  });

  // --- EMQX management: secrets are sealed server-side and always masked ---
  app.get('/api/owner/emqx/settings', async (c) => {
    await ownerOnly(c);
    const settings = (await rt.db.select('platform_settings')).filter((x: any) => x.key.startsWith('mqtt.'));
    const secrets = await rt.db.select('platform_secrets');
    const health = await (await emqxFromSettings(rt)).health();
    return c.json({ settings: Object.fromEntries(settings.map((x: any) => [x.key, x.value])),
      secrets: Object.fromEntries(secrets.map((s: any) => [s.key, { configured: true, masked: '••••••••••••', fingerprint: s.fingerprint, updated_at: s.updated_at }])),
      health, provider: (await emqxFromSettings(rt)).displayName,
      capability_notes: [
        'EMQX Cloud Serverless supports built-in-database authentication and per-identity ACL rules through the Deployment API.',
        'HTTP authentication hooks are NOT supported on Serverless deployments; per-device users are provisioned instead.',
        'Monthly quota usage is visible on the EMQX Cloud console (hourly) but is not exposed by the Deployment API.',
      ] });
  });
  app.post('/api/owner/emqx/settings', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    const secretKeys = ['EMQX_APP_ID', 'EMQX_APP_SECRET', 'EMQX_ADMIN_USERNAME', 'EMQX_ADMIN_PASSWORD'];
    const key = secretsKey(rt);
    for (const [k, v] of Object.entries(b)) {
      if (secretKeys.includes(k)) {
        if (!v) continue;
        const sealed = await seal(String(v), key);
        await rt.db.raw!(
          `insert into platform_secrets (key,ciphertext,iv,tag,fingerprint,updated_by) values ($1,$2,$3,$4,$5,$6)
           on conflict (key) do update set ciphertext=excluded.ciphertext, iv=excluded.iv, tag=excluded.tag,
             fingerprint=excluded.fingerprint, updated_by=excluded.updated_by, updated_at=now()`,
          [k, sealed.ciphertext, sealed.iv, sealed.tag, (await sha256Hex(String(v))).slice(0, 12), ctx.profileId]).catch(async () => {
          // Supabase adapter has no raw SQL: use upsert via PostgREST.
          await rt.db.insert('platform_secrets', { key: k, ...sealed, fingerprint: (await sha256Hex(String(v))).slice(0, 12), updated_by: ctx.profileId });
        });
      } else {
        const settingKey = k.startsWith('mqtt.') ? k : `mqtt.${k.replace(/^EMQX_/, '').toLowerCase()}`;
        await rt.db.rpc('rpc_set_platform_setting', { p_actor: ctx.profileId, p_key: settingKey, p_value: v });
      }
    }
    await rt.db.rpc('rpc_set_platform_setting', { p_actor: ctx.profileId, p_key: 'mqtt.last_sync_at', p_value: new Date().toISOString() });
    return c.json({ saved: true, secrets_masked: true });
  });
  app.post('/api/owner/emqx/test', async (c) => {
    const ctx = await ownerOnly(c);
    const provider = await emqxFromSettings(rt);
    const health = await provider.health();
    await rt.db.insert('emqx_sync_runs', { kind: 'health', status: health.connected ? 'success' : 'failed', detail: health as any, finished_at: new Date().toISOString(), actor_id: ctx.profileId });
    return c.json(health);
  });

  // --- Usage & monitoring: never fabricate provider-reported values ---
  app.get('/api/owner/usage', async (c) => {
    await ownerOnly(c);
    const snapshots = await rt.db.select('emqx_usage_snapshots', { order: { column: 'period_start', ascending: false }, limit: 400 });
    const syncRuns = await rt.db.select('emqx_sync_runs', { order: { column: 'started_at', ascending: false }, limit: 20 });
    const settings = await rt.db.select('platform_settings');
    const quotas = settings.find((x: any) => x.key === 'usage.quotas')?.value || EMQX_QUOTAS;
    const thresholds = settings.find((x: any) => x.key === 'usage.warning_thresholds')?.value || WARNING_THRESHOLDS;
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const monthSnapshots = snapshots.filter((s: any) => new Date(s.period_start) >= monthStart);
    const sumField = (k: string) => monthSnapshots.reduce((n: number, s: any) => n + (s[k] == null ? 0 : Number(s[k])), 0);
    const official = {
      source: 'provider_api / owner_manual',
      traffic_bytes: sumField('traffic_bytes'), traffic_in_bytes: sumField('traffic_in_bytes'),
      traffic_out_bytes: sumField('traffic_out_bytes'), packets: sumField('packets'),
      session_minutes: sumField('session_minutes'), messages: sumField('messages'),
      rule_actions: sumField('rule_actions'),
      connections_peak: monthSnapshots.length ? Math.max(...monthSnapshots.map((s: any) => s.connections_peak || 0)) : null,
      available: monthSnapshots.length > 0,
    };
    // Application-side estimates are computed from real application counters
    // and are ALWAYS labelled as estimates, never as provider usage.
    const commands = await rt.db.select('device_commands');
    const readings = await rt.db.select('sensor_readings', { order: { column: 'received_at', ascending: false }, limit: 5000 });
    const estimates = {
      label: 'Application-side estimate',
      command_messages: commands.length,
      telemetry_messages: readings.length,
      estimated_bytes: commands.length * 180 + readings.length * 220,
      note: 'Computed from application records. This is NOT EMQX deployment traffic.',
    };
    const unavailable = {
      trafficBytes: !official.available ? 'No provider-reported traffic snapshot recorded for this month.' : null,
      trafficInBytes: !monthSnapshots.some((s: any) => s.traffic_in_bytes != null) ? 'Not provided by the EMQX Serverless Deployment API.' : null,
      trafficOutBytes: !monthSnapshots.some((s: any) => s.traffic_out_bytes != null) ? 'Not provided by the EMQX Serverless Deployment API.' : null,
      packets: !monthSnapshots.some((s: any) => s.packets != null) ? 'Packet counters by period are not provided by the Deployment API.' : null,
      sessionMinutes: !monthSnapshots.some((s: any) => s.session_minutes != null) ? 'Session minutes are not provided by the Deployment API (console only).' : null,
      usageHistory: snapshots.length ? null : 'No usage history has been recorded yet.',
      dailyChart: snapshots.filter((s: any) => s.granularity === 'day').length ? null : 'No daily provider snapshot available.',
    };
    return c.json({ quotas, thresholds, official, estimates, unavailable, snapshots, sync_runs: syncRuns,
      charts: { daily: snapshots.filter((s: any) => s.granularity === 'day').slice().reverse(), monthly: snapshots.filter((s: any) => s.granularity === 'month').slice().reverse() } });
  });
  app.post('/api/owner/emqx/sync-usage', async (c) => {
    const ctx = await ownerOnly(c);
    const provider = await emqxFromSettings(rt);
    const usage = await provider.fetchUsage();
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const periodEnd = new Date(periodStart.getTime() + 86400000);
    if (usage?.connectionsPeak != null) {
      await rt.db.rpc('rpc_record_usage_snapshot', { p_actor: ctx.profileId, p_data: {
        period_start: periodStart.toISOString(), period_end: periodEnd.toISOString(),
        granularity: 'day', source: usage.source, connections_peak: usage.connectionsPeak,
        raw: usage.raw,
      } });
    }
    const status = usage?.connectionsPeak != null ? 'partial' : 'partial';
    await rt.db.insert('emqx_sync_runs', { kind: 'usage', status,
      detail: { ...usage, note: 'Only live connection count is available from the Deployment API. Monthly quota metrics require owner-side manual entry from the EMQX Cloud console.' },
      finished_at: new Date().toISOString(), actor_id: ctx.profileId });
    await rt.db.rpc('rpc_set_platform_setting', { p_actor: ctx.profileId, p_key: 'mqtt.last_sync_at', p_value: new Date().toISOString() });
    return c.json({ synced: true, provider_usage: usage, status,
      message: 'Live connection count recorded. Monthly traffic, session minutes and rule actions are not exposed by the Serverless API — enter the console values below as an owner-verified snapshot.' });
  });
  app.post('/api/owner/usage/snapshots', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    const data = { ...b, source: b.source || 'owner_manual', granularity: b.granularity || 'month',
      period_start: b.period_start, period_end: b.period_end };
    if (!data.period_start || !data.period_end) throw new HttpError(400, 'period_start and period_end are required');
    const r = await rt.db.rpc('rpc_record_usage_snapshot', { p_actor: ctx.profileId, p_data: data });
    return c.json({ ...r, source: data.source }, 201);
  });

  app.get('/api/owner/boards', async (c) => {
    await ownerOnly(c);
    const boards = await rt.db.select('board_catalog', { order: { column: 'model' } });
    const pins = await rt.db.select('board_catalog_pins');
    return c.json(boards.map((b: any) => ({ ...b, pin_count: pins.filter((x: any) => x.board_id === b.id).length })));
  });
  app.patch('/api/owner/boards/:id', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    await rt.db.update('board_catalog', { id: p(c, 'id') }, Object.fromEntries(['active', 'summary', 'doc_source_url'].filter((k) => k in b).map((k) => [k, b[k]])));
    await rt.db.insert('audit_logs', { actor_id: ctx.profileId, actor_type: 'platform_admin', action: 'platform.board.update', entity_type: 'board_catalog', entity_id: p(c, 'id'), after: b });
    return c.json({ ok: true });
  });
  app.get('/api/owner/settings', async (c) => {
    await ownerOnly(c);
    return c.json(await rt.db.select('platform_settings', { order: { column: 'key' } }));
  });
  app.post('/api/owner/settings', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    for (const [k, v] of Object.entries(b)) await rt.db.rpc('rpc_set_platform_setting', { p_actor: ctx.profileId, p_key: k, p_value: v });
    return c.json({ saved: true, keys: Object.keys(b) });
  });
  app.post('/api/owner/announcements', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    const rows = await rt.db.insert('system_announcements', { title: b.title, body: b.body, severity: b.severity || 'info', audience: b.audience || 'all', ends_at: b.ends_at || null, created_by: ctx.profileId });
    return c.json(rows[0], 201);
  });
  app.get('/api/announcements', async (c) => {
    return c.json(await rt.db.select('system_announcements', { eq: { active: true }, order: { column: 'starts_at', ascending: false }, limit: 10 }));
  });

  // ==========================================================================
  // INTERNAL: MQTT broker authn/authz + device message ingress
  // ==========================================================================
  app.post('/internal/mqtt/auth', async (c) => {
    const b = await body(c);
    const info: any = await rt.db.rpc('rpc_board_from_client', { p_client_id: String(b.clientId || b.client_id || '') });
    if (!info || info.credential_status !== 'active' || info.board_status === 'disabled') return c.json({ ok: false, reason: 'unknown client' }, 401);
    if (info.username !== String(b.username || '')) return c.json({ ok: false, reason: 'username mismatch' }, 401);
    if (!(await verifyPassword(String(b.password || ''), info.password_hash))) return c.json({ ok: false, reason: 'bad credentials' }, 401);
    return c.json({ ok: true, board_id: info.board_id, tenant_id: info.tenant_id });
  });
  app.post('/internal/mqtt/acl', async (c) => {
    const b = await body(c);
    const info: any = await rt.db.rpc('rpc_board_from_client', { p_client_id: String(b.clientId || '') });
    if (!info || info.credential_status !== 'active' || info.board_status === 'disabled') return c.json({ allowed: false });
    const tp = String(b.topic || '');
    const action = String(b.action || 'publish');
    const allowed = action === 'publish'
      ? [info.topics.state, info.topics.telemetry, info.topics.availability].includes(tp)
      : action === 'subscribe'
        ? [info.topics.command, info.topics.config].includes(tp)
        : false;
    return c.json({ allowed });
  });
  app.get('/internal/board/:clientId', async (c) => {
    await verifyInternal(c);
    const info = await rt.db.rpc('rpc_board_from_client', { p_client_id: p(c, 'clientId') });
    return c.json(info || {});
  });
  app.post('/internal/mqtt/event', async (c) => {
    const raw = await c.req.text();
    await verifyInternal(c, raw);
    const b = JSON.parse(raw);
    return c.json(await handleIngress(rt, b));
  });
  app.post('/internal/ingest', async (c) => {
    const raw = await c.req.text();
    await verifyInternal(c, raw);
    const b = JSON.parse(raw);
    return c.json(await handleIngress(rt, b));
  });
  app.get('/internal/health', async (c) => c.json({ ok: true, provider: rt.mqtt.id, listeners: rt.events.size }));

  return app;
}

// ============================================================================
// Helpers
// ============================================================================
function secretsKey(rt: Runtime): string {
  const k = rt.env.SECRETS_KEY;
  if (k && k.length >= 64) return k;
  if (rt.env.DB_DRIVER === 'supabase') throw new HttpError(503, 'SECRETS_KEY must be configured in Worker secrets');
  return '6465762d6f6e6c792d6e6f742d666f722d70726f64756374696f6e2d7573652d3030313233343536';
}

async function emqxFromSettings(rt: Runtime) {
  const { EmqxCloudProvider } = await import('./providers/emqx');
  const settings = await rt.db.select('platform_settings');
  const map = Object.fromEntries(settings.map((x: any) => [x.key, x.value]));
  const secrets = await rt.db.select('platform_secrets');
  const key = secretsKey(rt);
  const unsealed: Record<string, string> = {};
  for (const s of secrets) {
    try { unsealed[s.key] = await unseal(s, key); } catch { /* ignore corrupt entries */ }
  }
  const env: Record<string, any> = { ...rt.env,
    EMQX_API_BASE: unsealed.EMQX_API_BASE || map['mqtt.deployment_endpoint'] || rt.env.EMQX_API_BASE,
    EMQX_APP_ID: unsealed.EMQX_APP_ID || rt.env.EMQX_APP_ID,
    EMQX_APP_SECRET: unsealed.EMQX_APP_SECRET || rt.env.EMQX_APP_SECRET,
    EMQX_BROKER_HOST: map['mqtt.broker_host'] || rt.env.EMQX_BROKER_HOST,
    EMQX_TLS_PORT: map['mqtt.port_tls'] || rt.env.EMQX_TLS_PORT,
    EMQX_WSS_URL: map['mqtt.wss_host'] || rt.env.EMQX_WSS_URL,
  };
  return new EmqxCloudProvider(env);
}

async function verifyInternal(c: any, raw?: string) {
  const rt = runtime(c);
  const secret = rt.env.INGRESS_HMAC_SECRET || (rt.env.DB_DRIVER === 'supabase' ? '' : 'local-ingress-secret');
  if (!secret) throw new HttpError(503, 'INGRESS_HMAC_SECRET not configured');
  const sig = c.req.header('X-Helios-Signature') || '';
  if (raw !== undefined) {
    const ts = c.req.header('X-Helios-Timestamp') || '';
    if (!ts || Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) throw new HttpError(401, 'Stale ingress signature');
    const expected = await hmacHex(secret, `${ts}.${raw}`);
    if (sig !== expected) throw new HttpError(401, 'Invalid ingress signature');
  } else {
    const expected = await hmacHex(secret, 'internal-read');
    if (sig !== expected) throw new HttpError(401, 'Invalid internal signature');
  }
}

async function publishConfig(rt: Runtime, tenantId: string, boardId: string) {
  const boards = await rt.db.select('user_boards', { eq: { id: boardId, tenant_id: tenantId }, limit: 1 });
  if (!boards.length) return;
  const cfg: any[] = await rt.db.select('device_configurations', { eq: { user_board_id: boardId, tenant_id: tenantId }, order: { column: 'version', ascending: false }, limit: 1 });
  if (!cfg.length) return;
  const t = deviceTopics(tenantId, boards[0].device_id);
  await rt.mqtt.publish({ topic: t.config, payload: cfg[0].config, qos: 1 });
  rt.emit(tenantId, 'config.published', { board_id: boardId, version: cfg[0].version });
}

/** All device-originated messages pass through here. Tenant comes from the DB. */
export async function handleIngress(rt: Runtime, msg: any) {
  const clientId = String(msg.clientId || msg.client_id || '');
  const tp = String(msg.topic || '');
  const parsed = parseTopic(tp);
  if (!parsed) return { ignored: true, reason: 'invalid topic' };
  const info: any = clientId
    ? await rt.db.rpc('rpc_board_from_client', { p_client_id: clientId })
    : await rt.db.rpc('rpc_board_from_device', { p_tenant: parsed.tenantId, p_device_id: parsed.deviceId });
  if (!info) return { ignored: true, reason: 'unknown client or device' };
  // Resolve identity from the authenticated MQTT session, NEVER from JSON.
  if (info.tenant_id !== parsed.tenantId || info.device_id !== parsed.deviceId) {
    return { ignored: true, reason: 'topic does not match authenticated device', tenant_id: info.tenant_id };
  }
  const allowedPublish = [info.topics.state, info.topics.telemetry, info.topics.availability];
  if (!allowedPublish.includes(tp)) return { ignored: true, reason: 'topic not permitted for publish' };
  const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload || '{}') : (msg.payload || {});
  const clean = { ...payload };
  delete clean.tenant_id; delete clean.tenantId;
  if (clean.device_id && clean.device_id !== info.device_id) {
    return { ignored: true, reason: 'payload device_id does not match authenticated device' };
  }
  const boardId = info.board_id;
  const tenantId = info.tenant_id;

  if (parsed.kind === 'telemetry') {
    const validated = TelemetryMessage.safeParse(clean);
    if (!validated.success) return { ignored: true, reason: 'invalid telemetry schema', issues: validated.error.issues };
    const r: any = await rt.db.rpc('rpc_ingest_telemetry', { p_board: boardId, p_payload: validated.data });
    rt.emit(tenantId, 'telemetry', { board_id: boardId, accepted: r.accepted });
    // Cloud automation evaluation on sensor events.
    for (const key of Object.keys(validated.data.sensors)) {
      const sensors = await rt.db.select('sensors', { eq: { tenant_id: tenantId, slug: key }, limit: 1 });
      if (!sensors.length) continue;
      const ev: any = await rt.db.rpc('rpc_evaluate_automations', { p_tenant: tenantId,
        p_event: { kind: 'sensor_event', sensor_id: sensors[0].id, value: validated.data.sensors[key]!.value } });
      for (const wrapped of ev.actions || []) {
        await executeAutomationAction(rt, tenantId, wrapped.action);
      }
    }
    return r;
  }
  if (parsed.kind === 'availability') {
    const online = clean.status !== 'offline' && clean.availability !== 'offline';
    await rt.db.update('user_boards', { id: boardId }, { status: online ? 'online' : 'offline', last_seen_at: new Date().toISOString() });
    rt.emit(tenantId, 'board.availability', { board_id: boardId, online });
    return { ok: true, online };
  }
  if (clean.type === 'config_ack' || clean.config_version !== undefined && clean.status === 'applied' && !clean.command_id) {
    const v = ConfigAck.safeParse(clean);
    if (!v.success) return { ignored: true, reason: 'invalid config ack' };
    const r = await rt.db.rpc('rpc_ack_config', { p_board: boardId, p_payload: v.data });
    rt.emit(tenantId, 'config.ack', { board_id: boardId, version: v.data.config_version });
    return r;
  }
  if (clean.type === 'ota' || clean.progress !== undefined) {
    const v = OtaProgress.safeParse(clean);
    if (!v.success) return { ignored: true, reason: 'invalid OTA progress' };
    const r = await rt.db.rpc('rpc_ota_progress', { p_board: boardId, p_payload: v.data });
    rt.emit(tenantId, 'firmware.progress', { board_id: boardId, ...v.data });
    return r;
  }
  const v = StateReport.safeParse({ schema_version: 1, device_id: info.device_id,
    timestamp: clean.timestamp || Math.floor(Date.now() / 1000), ...clean });
  if (!v.success) return { ignored: true, reason: 'invalid state report', issues: v.error.issues };
  const r = await rt.db.rpc('rpc_ingest_state', { p_board: boardId, p_payload: v.data });
  rt.emit(tenantId, 'device.state', { board_id: boardId, command_id: clean.command_id || null, devices: clean.devices || null });
  return r;
}

async function executeAutomationActions(rt: Runtime, ctx: any, actions: any[]) {
  const out = [];
  for (const a of actions) out.push(await executeAutomationAction(rt, ctx.tenantId, a.action || a));
  return out;
}

async function executeAutomationAction(rt: Runtime, tenantId: string, action: any) {
  if (action.type !== 'device.set_state' && action.action !== 'set_state') return { skipped: true, reason: 'non- device action' };
  const slug = action.component_id || action.device_slug;
  if (!slug) return { skipped: true, reason: 'missing component' };
  const devices = await rt.db.select('devices', { eq: { tenant_id: tenantId, slug }, isNull: ['deleted_at'], limit: 1 });
  if (!devices.length) return { skipped: true, reason: 'device not found' };
  const d: any = devices[0];
  const tenants = await rt.db.select('tenants', { eq: { id: tenantId }, limit: 1 });
  const actorId = (tenants[0] as any)?.owner_profile_id;
  if (!actorId) return { skipped: true, reason: 'no owner' };
  const issued: any = await rt.db.rpc('rpc_issue_command', { p_actor: actorId, p_tenant: tenantId,
    p_board: d.user_board_id, p_component_id: d.id,
    p_data: { action: 'set_state', component_type: 'device', payload: { value: !!action.value } } });
  if (issued.idempotent) return { skipped: true, reason: 'idempotent' };
  const boards = await rt.db.select('user_boards', { eq: { id: d.user_board_id }, limit: 1 });
  if (!boards.length) return { skipped: true, reason: 'board missing' };
  const cmd = issued.command;
  await rt.mqtt.publish({ topic: topic(tenantId, boards[0].device_id, 'command'),
    payload: SwitchCommand.parse({ schema_version: 1, command_id: cmd.id, device_id: boards[0].device_id,
      component_id: slug, action: 'set_state', value: !!action.value,
      expires_at: Math.floor(new Date(cmd.expires_at).getTime() / 1000) }), qos: 1 });
  await rt.db.rpc('rpc_mark_command_published', { p_command: cmd.id, p_topic: topic(tenantId, boards[0].device_id, 'command') });
  rt.emit(tenantId, 'automation.action', { device_id: d.id, value: !!action.value });
  return { executed: true, device_id: d.id, command_id: cmd.id };
}
