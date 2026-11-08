import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Runtime } from './services/runtime';
import { HttpError, actor, context, ownerOnly, p, body, runtime, auditEvent,
  SESSION_COOKIE, clearSessionCookie } from './context';
import { deviceTopics, parseTopic, topic, EMQX_QUOTAS, WARNING_THRESHOLDS } from '@homecoreos/core';
import { SwitchCommand, TelemetryMessage, StateReport, ConfigAck, OtaProgress } from '@homecoreos/core';
import { randomHex, randomToken, sha256Hex, verifyPassword, hmacHex, fromB64, toHex } from './crypto';
import { testConnection, recordCheck, testStorage, setupStatus } from './config';
import {
  authenticateDevice, hashDevicePassword, sanitizeHardware, verifyDevicePassword, requestIp, originOf,
  resetPairingFailures,
} from './device-auth';
import { issuePairingSession, redeemPairingCode } from './firmware/pairing';
import {
  ALLOWED_CHANNELS, createPackageRelease, createRelease, customerDownload, deviceDownload, firmwareCheck,
  installPackage, latestForBoard, normalizeBoardModels, publishOtaCommand, queueOta,
  serveSignedDownload, type UploadInput,
} from './firmware/releases';
import { MAX_ARCHIVE_BYTES } from './artifacts/package';

export function createApp(rt: Runtime) {
  const app = new Hono<{ Variables: { rt: Runtime } }>();
  app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'X-HomecoreOS-Signature', 'X-HomecoreOS-Timestamp'], allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] }));
  app.use('*', async (c, next) => { c.set('rt', rt); await next(); });
  let lastExpiry = 0;
  app.use('/api/*', async (c, next) => {
    const method = c.req.method.toUpperCase();
    const origin = c.req.header('Origin');
    if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      let same = false;
      try { same = new URL(origin).host === new URL(c.req.url).host; } catch { same = false; }
      if (!same) throw new HttpError(403, 'Cross-origin request rejected');
    }
    if (Date.now() - lastExpiry > 60_000) {
      lastExpiry = Date.now();
      await rt.db.rpc('rpc_expire_commands', {}).catch(() => {});
    }
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.onError((err, c) => {
    const e = err as HttpError & { retryAfter?: number };
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status === 500) console.error('[api]', err);
    if (status === 429 && e.retryAfter) c.header('Retry-After', String(e.retryAfter));
    if (status === 401) {
      deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true, sameSite: 'Lax' });
    }
    return c.json({ error: status === 500 ? 'Internal error' : (err.message || 'Internal error'),
      detail: status === 500 ? null : (e.detail ?? null) }, status as any);
  });
  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  const emit = (tenantId: string, type: string, payload: Record<string, unknown> = {}) =>
    auditEvent(rt, tenantId, type, payload);

  // ==========================================================================
  // Health + authentication
  // ==========================================================================
  app.get('/api/health', (c) => c.json({
    ok: true, service: 'homecoreos-api', provider: rt.mqtt.id,
    database: 'supabase', time: new Date().toISOString(),
  }));

  app.post('/api/auth/signup', async (c) => {
    const b = await body(c);
    const r = await rt.auth.signup(
      String(b.email || '').trim().toLowerCase(), String(b.password || ''),
      { full_name: String(b.full_name || ''), home_name: String(b.home_name || ''), timezone: String(b.timezone || 'UTC') },
      requestInfo(c));
    setSessionCookie(c, r.token, r.expiresAt);
    return c.json({ profile_id: r.userId, email: r.email, role: r.role,
      expires_at: r.expiresAt, recovery_codes: r.recoveryCodes || [] }, 201);
  });
  app.post('/api/auth/login', async (c) => {
    const b = await body(c);
    const r = await rt.auth.login(String(b.email || '').trim().toLowerCase(), String(b.password || ''), requestInfo(c));
    setSessionCookie(c, r.token, r.expiresAt);
    return c.json({ profile_id: r.userId, email: r.email, role: r.role, expires_at: r.expiresAt });
  });
  app.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await rt.auth.logout(token);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });
  app.get('/api/auth/me', async (c) => {
    const a = await actor(c);
    const ctx: any = await rt.db.rpc('rpc_context', { p_actor: a.profileId });
    const profile = await rt.db.select('profiles', { eq: { id: a.profileId }, limit: 1 });
    return c.json({ profile: profile[0] || null, context: ctx,
      session: { id: a.sessionId, email: a.email, expires_at: a.expiresAt,
        role: a.role, permissions: a.permissions, platform_admin: a.platformAdmin } });
  });
  app.post('/api/auth/password', async (c) => {
    const a = await actor(c);
    const b = await body(c);
    await rt.auth.changePassword(a.profileId, String(b.current_password || ''),
      String(b.new_password || ''), a.tokenHash);
    return c.json({ ok: true });
  });
  app.get('/api/auth/sessions', async (c) => {
    const a = await actor(c);
    return c.json(await rt.db.rpc<any>('rpc_auth_sessions',
      { p_user_id: a.profileId, p_current: a.tokenHash }));
  });
  app.delete('/api/auth/sessions/:id', async (c) => {
    const a = await actor(c);
    await rt.db.rpc('rpc_auth_session_revoke_id',
      { p_user_id: a.profileId, p_session_id: p(c, 'id') });
    return c.json({ ok: true });
  });
  app.post('/api/auth/logout-all', async (c) => {
    const a = await actor(c);
    await rt.db.rpc('rpc_auth_sessions_revoke_other',
      { p_user_id: a.profileId, p_keep_token_hash: a.tokenHash });
    return c.json({ ok: true });
  });
  app.post('/api/auth/recovery/codes', async (c) => {
    const a = await actor(c);
    return c.json({ recovery_codes: await rt.auth.regenerateRecoveryCodes(a.profileId) });
  });
  app.post('/api/auth/recovery/reset', async (c) => {
    const b = await body(c);
    await rt.auth.recover(String(b.email || '').trim().toLowerCase(),
      String(b.code || ''), String(b.password || ''), requestInfo(c));
    return c.json({ ok: true });
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
    const rooms = await rt.db.select('rooms', { eq: { tenant_id: ctx.tenantId }, isNull: ['archived_at'], order: { column: 'name' } });
    const sensors = await rt.db.select('sensors', { eq: { tenant_id: ctx.tenantId }, isNull: ['deleted_at'], order: { column: 'created_at', ascending: false }, limit: 12 });
    const automations = await rt.db.select('automations', { eq: { tenant_id: ctx.tenantId } });
    return c.json({ stats, boards, devices, rooms, sensors, automations, recent_activity: recent });
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
    if (!(await featureEnabled('features.custom_boards'))) throw new HttpError(403, 'Custom boards are turned off in Platform Settings');
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
  // Pairing — six-digit, single-use, HMAC-stored, five-minute lifetime
  // ==========================================================================
  app.post('/api/pairing/code', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const b = await body(c);
    const boardId = b.catalog_board_id ? String(b.catalog_board_id) : null;
    await resetPairingFailures(rt, requestIp(c));
    const issued = await issuePairingSession(rt, {
      actorProfileId: ctx.profileId,
      tenantId: ctx.tenantId,
      sessionId: ctx.sessionId,
      ip: requestIp(c),
      catalogBoardId: boardId,
      boardName: b.board_name ? String(b.board_name).slice(0, 60) : null,
      homeName: b.home_name ? String(b.home_name).slice(0, 60) : null,
    });
    emit(ctx.tenantId, 'pairing.code.issued', { id: issued.id });
    return c.json({
      session_id: issued.id,
      code: issued.code,
      expires_at: issued.expiresAt,
      seconds_left: issued.secondsLeft,
      note: 'Enter this code on the controller. It cannot be recovered afterwards.',
    }, 201);
  });
  app.get('/api/pairing/progress', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const id = String(c.req.query('session') || '');
    if (!UUID.test(id)) throw new HttpError(404, 'Pairing session not found');
    try {
      const progress = await rt.db.rpc('rpc_pairing_progress', {
        p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_id: id,
      });
      return c.json(progress);
    } catch (e: any) {
      if (String(e?.message || '').includes('Pairing session not found')) {
        throw new HttpError(404, 'Pairing session not found');
      }
      throw rpcError(e, 'The pairing session could not be read');
    }
  });
  app.post('/api/pairing/cancel', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const b = await body(c);
    if (!b.session_id) throw new HttpError(400, 'A pairing session is required');
    await rt.db.rpc('rpc_pairing_cancel', {
      p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_id: String(b.session_id),
    });
    return c.json({ cancelled: true });
  });

  /** Called by the controller once the code has been entered in its setup portal. */
  app.post('/api/device/pair', async (c) => {
    const b = await body(c);
    const open = await rt.db.select('device_pairing_tokens', {
      isNull: ['consumed_at', 'revoked_at'], limit: 1,
    });
    const outcome = await redeemPairingCode(rt, {
      code: b.code,
      ip: requestIp(c),
      hardware: b.hardware,
      windowOpen: open.length > 0,
    });
    if (outcome.status >= 400) {
      await rt.db.insert('app_security_events', {
        event_type: 'device_pairing_failed', ip: requestIp(c),
        detail: `code rejected with ${outcome.status}`,
      }).catch(() => {});
    }
    return c.json(outcome.body, outcome.status as any);
  });

  /** Configuration refresh for an already-paired controller. */
  app.post('/api/device/config', async (c) => {
    const b = await body(c);
    const device = await authenticateDevice(rt, String(b.client_id || ''), String(b.password || ''));
    if (!device) throw new HttpError(401, 'Invalid device credentials');
    const hardware = sanitizeHardware(b.hardware);
    if (Object.keys(hardware).length) {
      await rt.db.update('user_boards', { id: device.board_id }, hardware).catch(() => {});
    }
    const cfg = await rt.db.select('device_configurations', {
      eq: { user_board_id: device.board_id }, order: { column: 'version', ascending: false }, limit: 1,
    });
    return c.json({ config: (cfg[0] as any)?.config || null, topics: device.topics });
  });

  /** Firmware negotiation: the controller reports what it runs, the API answers. */
  app.post('/api/device/firmware-check', async (c) => {
    const b = await body(c);
    const device = await authenticateDevice(rt, String(b.client_id || ''), String(b.password || ''));
    if (!device) throw new HttpError(401, 'Invalid device credentials');
    return c.json(await firmwareCheck(rt, device, originOf(c), b));
  });

  /** Credential-authenticated binary download used by OTA. */
  app.post('/api/device/firmware-download', async (c) => deviceDownload(rt, c));

  /** Credential-authenticated OTA progress (never trusted from the browser). */
  app.post('/api/device/firmware-progress', async (c) => {
    const b = await body(c);
    const device = await authenticateDevice(rt, String(b.client_id || ''), String(b.password || ''));
    if (!device) throw new HttpError(401, 'Invalid device credentials');
    const result = await rt.db.rpc('rpc_ota_report', {
      p_board: device.board_id,
      p_payload: {
        status: b.status, version: b.version, progress: b.progress,
        bytes_done: b.bytes_done, bytes_total: b.bytes_total, error: b.error,
        fw_build: b.fw_build,
      },
    });
    rt.emit(device.tenant_id, 'firmware.progress', { board_id: device.board_id, ...b });
    return c.json(result);
  });

  /** Owner-authorised credential rotation. */
  app.post('/api/boards/:id/rotate-credentials', async (c) => {
    const ctx = await context(c, 'devices.configure');
    const boards = await rt.db.select('user_boards', { eq: { id: p(c, 'id'), tenant_id: ctx.tenantId }, limit: 1 });
    if (!boards.length) throw new HttpError(404, 'Board not found');
    const password = randomToken(32);
    const hash = await hashDevicePassword(rt, password);
    await rt.db.rpc('rpc_rotate_device_credentials', {
      p_actor: ctx.profileId, p_tenant: ctx.tenantId, p_board: p(c, 'id'),
      p_password_hash: hash, p_provider_ref: {},
    });
    const active = await rt.db.select<any>('mqtt_credentials_metadata', {
      eq: { user_board_id: p(c, 'id'), tenant_id: ctx.tenantId, status: 'active' }, limit: 1,
    });
    await rt.mqtt.rotateDevice({
      username: active[0]?.username || '', password, clientId: (boards[0] as any).mqtt_client_id,
    });
    emit(ctx.tenantId, 'board.credentials.rotated', { id: p(c, 'id') });
    return c.json({
      rotated: true, username: active[0]?.username, password,
      note: 'Shown once. The controller must be re-provisioned if this device is offline.',
    });
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
      path: ['Website', 'Cloudflare Pages Functions', rt.mqtt.displayName, 'ESP32'],
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
    if (!(await featureEnabled('features.automation'))) throw new HttpError(403, 'Automation is turned off in Platform Settings');
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
    if (!(await featureEnabled('features.automation'))) throw new HttpError(403, 'Automation is turned off in Platform Settings');
    const r: any = await rt.db.rpc('rpc_evaluate_automations', { p_tenant: ctx.tenantId, p_event: { kind: 'manual_trigger', automation_id: p(c, 'id') } });
    const executed = await executeAutomationActions(rt, ctx, r.actions || []);
    return c.json({ ...r, executed });
  });

  // ==========================================================================
  // Customer firmware: catalogue, update check, download and history
  // ==========================================================================
  app.get('/api/firmware/catalog', async (c) => {
    const ctx = await context(c, 'dashboard.view');
    const boards = await rt.db.select<any>('user_boards', {
      eq: { tenant_id: ctx.tenantId }, isNull: ['deleted_at'], order: { column: 'created_at', ascending: false },
    });
    const catalog = await rt.db.select<any>('board_catalog', { eq: { active: true } });
    const controllers = [];
    for (const board of boards) {
      const latest = await rt.db.rpc<any>('rpc_firmware_latest', { p_board: board.id }).catch(() => null);
      const history = await rt.db.select<any>('device_firmware_history', {
        eq: { user_board_id: board.id }, order: { column: 'started_at', ascending: false }, limit: 5,
      });
      const lastSuccess = (history as any[]).find((h) => h.status === 'success');
      const open = (history as any[]).find((h) =>
        ['queued', 'downloading', 'installing', 'verifying'].includes(h.status));
      const boardCatalog = (catalog as any[]).find((x) => x.id === board.catalog_board_id);
      controllers.push({
        id: board.id,
        name: board.name,
        device_id: board.device_id,
        status: board.status,
        last_seen_at: board.last_seen_at,
        catalog_board_id: board.catalog_board_id,
        board_label: boardCatalog ? `${boardCatalog.manufacturer} ${boardCatalog.model}` : null,
        chip_family: boardCatalog?.chip_family || board.chip_family || null,
        installed_version: board.firmware_version || null,
        latest: latest ? {
          id: latest.id, version: latest.version, notes: latest.notes,
          size_bytes: latest.size_bytes, sha256: latest.sha256,
          signature_present: !!latest.signature, mandatory: !!latest.mandatory,
          update_available: !!latest.update_available && board.status !== 'unclaimed',
        } : null,
        update: open ? {
          id: open.id, status: open.status, progress: open.progress,
          error: open.error, started_at: open.started_at, to_version: open.to_version,
        } : null,
        last_success_at: lastSuccess?.finished_at || null,
        last_failure: (history as any[]).find((h) => h.status === 'failed' || h.status === 'rolled_back') || null,
      });
    }
    const installable: any[] = [];
    const seen = new Set<string>();
    for (const board of boards) {
      const boardId = String(board.catalog_board_id || '');
      if (!boardId || seen.has(boardId)) continue;
      seen.add(boardId);
      for (const kind of ['app', 'factory'] as const) {
        const release = await latestForBoard(rt, boardId, kind);
        if (!release) continue;
        const pkg = await installPackage(rt, String(release.id), originOf(c));
        if (!installable.some((x) => x.id === pkg.id)) installable.push(pkg);
      }
    }
    const rollback: Record<string, unknown> = {};
    for (const board of boards) {
      const target = await rt.db.rpc<any>('rpc_firmware_rollback_target', {
        p_board: board.id, p_actor: ctx.profileId, p_tenant: ctx.tenantId,
      }).catch(() => null);
      rollback[board.id] = target
        ? { available: true, version: target.version, sha256: target.sha256, size_bytes: target.size_bytes }
        : { available: false, version: null, reason: 'No earlier signed release has been installed on this controller' };
    }
    return c.json({
      controllers: controllers.map((entry: any) => ({ ...entry, rollback: rollback[entry.id] })),
      install: installable,
      usb_installer: {
        flash_size_mb: 16,
        requires_https: true,
        requires_chrome_or_edge: true,
        note: 'The image is written over a USB serial connection in this browser. Nothing is installed until the detected chip matches the release.',
      },
    });
  });

  /** Expiring install package for the in-browser flasher (customer session). */
  app.post('/api/firmware/:id/install-package', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const releaseId = p(c, 'id');
    if (!UUID.test(releaseId)) throw new HttpError(404, 'Firmware release not found');
    const releases = await rt.db.select<any>('firmware_releases', { eq: { id: releaseId }, limit: 1 });
    const release = releases[0];
    if (!release || release.deleted_at) throw new HttpError(404, 'Firmware release not found');
    const boards = await rt.db.select<any>('user_boards', {
      eq: { tenant_id: ctx.tenantId }, isNull: ['deleted_at'],
    });
    if (!(boards as any[]).some((b) => (release.board_models || []).includes(b.catalog_board_id))) {
      throw new HttpError(403, 'This release is not offered for your controllers');
    }
    return c.json(await installPackage(rt, releaseId, originOf(c)));
  });

  /** Signed, expiring storage path handed to the browser flasher. */
  app.get('/api/firmware/object/:key', async (c) => {
    await context(c, 'dashboard.view');
    let key = '';
    try { key = atob(decodeURIComponent(p(c, 'key'))); } catch { throw new HttpError(400, 'Invalid firmware path'); }
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(key)) throw new HttpError(400, 'Invalid firmware path');
    return serveSignedDownload(rt, rt.env, key, String(c.req.query('expires') || ''), String(c.req.query('sig') || ''));
  });

  /** Direct download of a published release for a signed-in customer. */
  app.get('/api/firmware/download/:id', async (c) => {
    const ctx = await context(c, 'devices.manage');
    const releaseId = p(c, 'id');
    if (!UUID.test(releaseId)) throw new HttpError(404, 'Firmware release not found');
    const releases = await rt.db.select<any>('firmware_releases', { eq: { id: releaseId }, limit: 1 });
    if (!releases.length) throw new HttpError(404, 'Firmware release not found');
    const boards = await rt.db.select<any>('user_boards', {
      eq: { tenant_id: ctx.tenantId }, isNull: ['deleted_at'],
    });
    if (!(boards as any[]).some((b) => ((releases[0] as any).board_models || []).includes(b.catalog_board_id))) {
      throw new HttpError(403, 'This release is not offered for your controllers');
    }
    return customerDownload(rt, releaseId);
  });

  app.post('/api/firmware/update', async (c) => {
    const ctx = await context(c, 'devices.manage');
    if (!(await featureEnabled('features.ota'))) {
      throw new HttpError(403, 'Firmware updates are turned off in Platform Settings');
    }
    const b = await body(c);
    const boardId = String(b.board_id || '');
    if (!boardId) throw new HttpError(400, 'Choose a controller');
    const boards = await rt.db.select<any>('user_boards', {
      eq: { id: boardId, tenant_id: ctx.tenantId }, isNull: ['deleted_at'], limit: 1,
    });
    if (!boards.length) throw new HttpError(404, 'Controller not found');
    const board = boards[0];
    if (board.status === 'unclaimed' || board.status === 'disabled') {
      throw new HttpError(409, 'This controller must be paired and online before it can be updated');
    }
    const openUpdate = await rt.db.select<any>('device_firmware_history', {
      eq: { user_board_id: board.id }, limit: 1,
    }).then((rows) => rows.filter((r: any) =>
      ['queued', 'downloading', 'installing', 'verifying'].includes(r.status)));
    if (openUpdate.length) throw new HttpError(409, 'An update is already running on this controller');

    let releaseId = b.release_id ? String(b.release_id) : '';
    if (!releaseId) {
      const latest = await rt.db.rpc<any>('rpc_firmware_latest', { p_board: board.id });
      if (!latest) throw new HttpError(409, 'No compatible firmware release is available for this controller');
      if (!latest.update_available) throw new HttpError(409, 'This controller already runs the latest firmware');
      releaseId = String(latest.id);
    }
    const signingRequired = await featureEnabled('firmware.require_signature', false);
    const plan = await queueOta(rt, {
      releaseId, boardId: board.id, ip: requestIp(c), allowUnsigned: !signingRequired,
    });
    await publishOtaCommand(rt, plan);
    return c.json({
      queued: true,
      version: plan.version,
      size_bytes: plan.size_bytes,
      sha256: plan.sha256,
      board_id: board.id,
    }, 202);
  });

  /** Owner-controlled rollback of one controller to a previous stable release. */
  app.post('/api/firmware/rollback', async (c) => {
    const ctx = await context(c, 'devices.configure');
    const b = await body(c);
    const boardId = String(b.board_id || '');
    const boards = await rt.db.select<any>('user_boards', {
      eq: { id: boardId, tenant_id: ctx.tenantId }, isNull: ['deleted_at'], limit: 1,
    });
    if (!boards.length) throw new HttpError(404, 'Controller not found');
    const target = await rt.db.rpc<any>('rpc_firmware_rollback_target', {
      p_board: boardId, p_actor: ctx.profileId, p_tenant: ctx.tenantId,
    });
    if (!target) throw new HttpError(409, 'No previous stable release is available for this controller');
    if (target.requires_usb_reinstall) {
      throw new HttpError(409, 'That release is a factory image and can only be installed over USB');
    }
    const plan = await queueOta(rt, {
      releaseId: String(target.id), boardId, ip: requestIp(c), allowUnsigned: true,
    });
    await publishOtaCommand(rt, plan);
    emit(ctx.tenantId, 'firmware.rollback.started', { board_id: boardId, version: target.version });
    return c.json({ queued: true, version: target.version, from_version: target.installed }, 202);
  });

  app.get('/api/firmware/history', async (c) => {
    const ctx = await context(c, 'dashboard.view');
    return c.json(await rt.db.select('device_firmware_history', {
      eq: { tenant_id: ctx.tenantId }, order: { column: 'started_at', ascending: false }, limit: 100,
    }));
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
    if (!(await featureEnabled('features.staff_invites'))) throw new HttpError(403, 'Staff invitations are turned off in Platform Settings');
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
    const health = await rt.mqtt.health();
    const platformSettings = await rt.db.select('platform_settings');
    const thresholds = (platformSettings.find((x: any) => x.key === 'usage.warning_thresholds')?.value) || WARNING_THRESHOLDS;
    return c.json({ ...stats, recent_activity: activity, mqtt_health: health, thresholds,
      database_health: { connected: true, driver: 'supabase' },
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

  // --- EMQX management: credentials come from encrypted Cloudflare secrets ---
  app.get('/api/owner/emqx/settings', async (c) => {
    await ownerOnly(c);
    const settings = (await rt.db.select('platform_settings')).filter((x: any) => x.key.startsWith('mqtt.'));
    const health = await rt.mqtt.health();
    const configured = (k: string) => Boolean(String((rt.env as any)[k] || '').trim());
    return c.json({ settings: {
      ...Object.fromEntries(settings.map((x: any) => [x.key, x.value])),
      'mqtt.deployment_endpoint': rt.env.EMQX_API_BASE || null,
      'mqtt.broker_host': rt.env.EMQX_BROKER_HOST || null,
      'mqtt.port_tls': Number(rt.env.EMQX_TLS_PORT || 8883),
    },
      secrets: Object.fromEntries(['EMQX_APP_ID', 'EMQX_APP_SECRET']
        .filter(configured).map((k) => [k, { configured: true, masked: '••••••••••••' }])),
      health, provider: rt.mqtt.displayName,
      capability_notes: [
        'EMQX Cloud Serverless supports built-in-database authentication and per-identity ACL rules through the Deployment API.',
        'HTTP authentication hooks are NOT supported on Serverless deployments; per-device users are provisioned instead.',
        'Monthly quota usage is visible on the EMQX Cloud console (hourly) but is not exposed by the Deployment API.',
      ] });
  });
  /**
   * Device-authentication self-check.
   *
   * EMQX Cloud Serverless capabilities differ between deployments, so nothing is
   * assumed: this runs the same calls pairing will make, reports each one, and
   * removes the probe account afterwards. A probe that cannot be cleaned up is
   * reported, never hidden.
   */
  app.post('/api/owner/emqx/device-auth-check', async (c) => {
    const ctx = await ownerOnly(c);
    const checks: Array<{ id: string; label: string; ok: boolean; detail: string }> = [];
    const provider = rt.mqtt as any;
    const suffix = randomHex(4);
    const username = `hc_selfcheck_${suffix}`;
    const clientId = `hc-selfcheck-${suffix}`;
    const password = randomToken(24);
    let provisioned = false;

    const run = async (id: string, label: string, fn: () => Promise<string>) => {
      try { checks.push({ id, label, ok: true, detail: await fn() }); return true; }
      catch (e: any) { checks.push({ id, label, ok: false, detail: String(e?.message || e).slice(0, 300) }); return false; }
    };

    await run('api', 'Deployment API reachable', async () => {
      const health = await rt.mqtt.health();
      if (!health.connected) throw new Error(health.detail || 'The Deployment API did not answer');
      return `${health.provider} responded${health.clientCount !== null && health.clientCount !== undefined ? ` · ${health.clientCount} connected client(s)` : ''}`;
    });

    await run('provision', 'Per-device account can be created', async () => {
      if (typeof provider.provisionDevice !== 'function') throw new Error('This broker provider cannot provision per-device accounts');
      await provider.provisionDevice({
        username, password, clientId, tenantId: String(ctx.tenantId || 'platform'), deviceId: clientId,
      });
      provisioned = true;
      return `Created ${username} with access rules for its own topics only`;
    });

    if (provisioned) {
      await run('connect', 'The provisioned account can authenticate', async () => {
        if (typeof provider.probeCredential !== 'function') {
          return 'Not probed: this provider exposes no credential probe, so the broker itself was not contacted with the new password';
        }
        await provider.probeCredential({ username, password, clientId });
        return 'The broker accepted the credentials';
      });
      await run('cleanup', 'The probe account can be removed', async () => {
        await provider.revokeDevice({ username, clientId });
        return 'Probe account and its access rules were deleted';
      });
    } else {
      checks.push({ id: 'cleanup', label: 'The probe account can be removed', ok: true, detail: 'Nothing was created, so nothing needed removing' });
    }

    await rt.db.insert('audit_logs', {
      actor_id: ctx.profileId, actor_type: 'platform_admin',
      action: 'platform.emqx.device_auth_check', entity_type: 'broker', entity_id: rt.mqtt.id,
      after: { checks } as any,
    }).catch(() => {});
    return c.json({
      ok: checks.every((x) => x.ok),
      provider: rt.mqtt.displayName,
      checks,
      note: 'This runs the exact provisioning calls pairing uses. Accounts created here are probes and are always removed again.',
    });
  });

  app.post('/api/owner/emqx/test', async (c) => {
    const ctx = await ownerOnly(c);
    const provider = rt.mqtt;
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
    const provider = rt.mqtt;
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
    const allowed = ['active', 'summary', 'doc_source_url', 'manufacturer', 'model', 'variant',
      'chip_family', 'chip_variant', 'revision', 'image_url', 'pinout_url', 'capabilities'];
    const patch = Object.fromEntries(allowed.filter((k) => k in b).map((k) => [k, b[k]]));
    if ('model' in patch && !String(patch.model || '').trim()) throw new HttpError(400, 'A board name is required');
    if (Object.keys(patch).length) await rt.db.update('board_catalog', { id: p(c, 'id') }, patch);
    await rt.db.insert('audit_logs', { actor_id: ctx.profileId, actor_type: 'platform_admin', action: 'platform.board.update', entity_type: 'board_catalog', entity_id: p(c, 'id'), after: b });
    return c.json({ ok: true });
  });
  app.get('/api/owner/settings', async (c) => {
    await ownerOnly(c);
    // Never expose raw values for anything that looks like a credential.
    const rows = await rt.db.select('platform_settings', { order: { column: 'key' } });
    return c.json(rows.map((r: any) => ({ ...r,
      value: /secret|token|password|key/i.test(String(r.key)) ? '***' : r.value })));
  });
  app.post('/api/owner/settings', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    // Only settings that the API genuinely reads and enforces can be changed.
    const allowedKeys = new Set([
      'registration.pairing_ttl_seconds', 'registration.rate_limit_per_hour',
      'features.ota', 'features.automation', 'features.custom_boards', 'features.staff_invites',
      'usage.warning_thresholds', 'usage.quotas',
    ]);
    for (const [k, v] of Object.entries(b)) {
      if (k === 'confirm' || k === '__confirm') continue;
      if (!allowedKeys.has(k) || /secret|token|password|key/i.test(k)) {
        throw new HttpError(400, `This setting is not editable here: ${k}`);
      }
      const sensitive = /^(features|registration)\./.test(k);
      if (sensitive && b.confirm !== true && b.__confirm !== true) {
        throw new HttpError(400, `Confirm this change before saving ${k}`);
      }
      if (k === 'registration.pairing_ttl_seconds' && (!Number.isInteger(Number(v)) || Number(v) < 60 || Number(v) > 86400)) {
        throw new HttpError(400, 'Pairing code lifetime must be between 60 and 86400 seconds');
      }
      if (k === 'registration.rate_limit_per_hour' && (!Number.isInteger(Number(v)) || Number(v) < 1 || Number(v) > 100)) {
        throw new HttpError(400, 'Pairing attempts must be between 1 and 100 per hour');
      }
      if (k === 'usage.warning_thresholds') {
        const arr = Array.isArray(v) ? v.map(Number) : [];
        if (!arr.length || arr.some((n) => !Number.isFinite(n) || n < 1 || n > 100)) throw new HttpError(400, 'Warning thresholds must be numbers from 1 to 100');
      }
      if (/^features\./.test(k) && typeof v !== 'boolean') throw new HttpError(400, 'Feature switches must be true or false');
      await rt.db.rpc('rpc_set_platform_setting', { p_actor: ctx.profileId, p_key: k, p_value: v });
    }
    return c.json({ saved: true, keys: Object.keys(b).filter((k) => k !== 'confirm' && k !== '__confirm') });
  });
  // =========================================================================
  // Platform Settings -> Setup status (owner only, read-only)
  // Configuration lives in Cloudflare Pages -> Variables and Secrets.
  // =========================================================================
  const dbHealth = async () => {
    try {
      await rt.db.select('platform_settings', { limit: 1 });
      return { connected: true, provider: 'supabase' };
    } catch (e: any) {
      return { connected: false, provider: 'supabase', error: e?.message || 'unavailable' };
    }
  };
  const buildStatus = async () => {
    const [supabase, emqx, storage, health, authHealth] = await Promise.all([
      testConnection(rt.env, 'supabase'), testConnection(rt.env, 'emqx'),
      testStorage(rt.store as any), dbHealth(), rt.auth.health(),
    ]);
    return setupStatus({ env: rt.env, db: rt.db, tests: { supabase, emqx }, storage, dbHealth: health, authHealth });
  };
  app.get('/api/owner/setup', async (c) => {
    await ownerOnly(c);
    return c.json(await buildStatus());
  });
  app.get('/api/owner/integrations', async (c) => {
    await ownerOnly(c);
    const st = await buildStatus();
    return c.json({ variables: st.variables, connections: st.connections,
      setup_complete: st.setup_complete, notes: st.notes });
  });
  app.post('/api/owner/integrations/test', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    const target = String(b.target || '') === 'emqx' ? 'emqx' : 'supabase';
    const result = await testConnection(rt.env, target);
    await recordCheck(rt.db, target, result);
    await rt.db.insert('audit_logs', { actor_id: ctx.profileId, actor_type: 'platform_admin',
      action: 'platform.integration.test', entity_type: 'configuration', entity_id: target,
      after: { connected: result.connected } }).catch(() => {});
    return c.json(result);
  });
  app.post('/api/owner/setup/test-bucket', async (c) => {
    await ownerOnly(c);
    return c.json(await testStorage(rt.store as any));
  });

  app.get('/api/owner/auth', async (c) => {
    await ownerOnly(c);
    const [config, health, accounts] = await Promise.all([
      rt.auth.config(), rt.auth.health(), rt.db.rpc<any>('rpc_auth_accounts', {}),
    ]);
    return c.json({ config, health, accounts: accounts || [] });
  });
  app.post('/api/owner/auth/config', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    const key = String(b.key || ''), value = Number(b.value);
    if (!Number.isFinite(value)) throw new HttpError(400, 'Invalid value');
    const config = await rt.auth.setConfig(key, value);
    await rt.db.insert('audit_logs', { actor_id: ctx.profileId, actor_type: 'platform_admin',
      action: 'platform.auth.config', entity_type: 'configuration', entity_id: key,
      after: { value } }).catch(() => {});
    return c.json({ config });
  });
  app.post('/api/owner/auth/attempts/reset', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    if (b.email) await rt.db.rpc('rpc_auth_guard_reset_for', { p_email: String(b.email) });
    else await rt.db.rpc('rpc_auth_guard_reset', {});
    await rt.db.insert('audit_logs', { actor_id: ctx.profileId, actor_type: 'platform_admin',
      action: 'platform.auth.attempts.reset', entity_type: 'configuration', entity_id: String(b.email || 'all'),
      after: {} }).catch(() => {});
    return c.json({ ok: true });
  });
  app.post('/api/owner/auth/accounts/:id/status', async (c) => {
    const ctx = await ownerOnly(c);
    const status = String((await body(c)).status || '');
    if (!['active', 'suspended'].includes(status)) throw new HttpError(400, 'Invalid status');
    try {
      await rt.db.rpc('rpc_auth_account_status', { p_user_id: p(c, 'id'), p_status: status });
    } catch (e: any) { throw rpcError(e, 'Could not update the account'); }
    await rt.db.insert('audit_logs', { actor_id: ctx.profileId, actor_type: 'platform_admin',
      action: 'platform.auth.account.status', entity_type: 'account', entity_id: p(c, 'id'),
      after: { status } }).catch(() => {});
    return c.json({ ok: true });
  });
  app.post('/api/owner/auth/accounts/:id/reset-password', async (c) => {
    const ctx = await ownerOnly(c);
    const password = String((await body(c)).password || '');
    await rt.auth.adminResetPassword(p(c, 'id'), password);
    await rt.db.insert('audit_logs', { actor_id: ctx.profileId, actor_type: 'platform_admin',
      action: 'platform.auth.password.reset', entity_type: 'account', entity_id: p(c, 'id'),
      after: {} }).catch(() => {});
    return c.json({ ok: true });
  });
  app.post('/api/owner/auth/accounts/:id/recovery-codes', async (c) => {
    await ownerOnly(c);
    const codes = await rt.auth.regenerateRecoveryCodes(p(c, 'id'));
    return c.json({ recovery_codes: codes });
  });
  app.post('/api/owner/announcements', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    const rows = await rt.db.insert('system_announcements', { title: b.title, body: b.body, severity: b.severity || 'info', audience: b.audience || 'all', ends_at: b.ends_at || null, created_by: ctx.profileId });
    return c.json(rows[0], 201);
  });
  app.get('/api/announcements', async (c) => {
    await actor(c);
    return c.json(await rt.db.select('system_announcements', { eq: { active: true }, order: { column: 'starts_at', ascending: false }, limit: 10 }));
  });

  // ==========================================================================
  // INTERNAL: MQTT broker authn/authz + device message ingress
  // ==========================================================================
  app.post('/internal/mqtt/auth', async (c) => {
    const raw = await c.req.text();
    await verifyInternal(c, raw);
    const b = JSON.parse(raw);
    const info: any = await rt.db.rpc('rpc_board_from_client', { p_client_id: String(b.clientId || b.client_id || '') });
    if (!info || info.credential_status !== 'active' || info.board_status === 'disabled') return c.json({ ok: false, reason: 'unknown client' }, 401);
    if (info.username !== String(b.username || '')) return c.json({ ok: false, reason: 'username mismatch' }, 401);
    if (!(await verifyDevicePassword(rt, String(b.password || ''), info.password_hash))) return c.json({ ok: false, reason: 'bad credentials' }, 401);
    return c.json({ ok: true, board_id: info.board_id, tenant_id: info.tenant_id });
  });
  app.post('/internal/mqtt/acl', async (c) => {
    const raw = await c.req.text();
    await verifyInternal(c, raw);
    const b = JSON.parse(raw);
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
  app.get('/internal/health', async (c) => {
    await verifyInternal(c);
    return c.json({ ok: true, provider: rt.mqtt.id, listeners: rt.events.size });
  });


  // ==========================================================================
  // Configuration helpers — every value below is actually enforced in the API
  // ==========================================================================
  const settingValue = async (key: string, fallback: any = null) => {
    const rows = await rt.db.select('platform_settings', { eq: { key }, limit: 1 });
    return rows.length ? (rows[0] as any).value : fallback;
  };
  const featureEnabled = async (key: string, fallback = true) => {
    const v = await settingValue(key, fallback);
    return v === null ? fallback : v !== false && v !== 'false' && v !== 0;
  };

  // ==========================================================================
  // Owner Console — Firmware management over the native private R2 binding
  // ==========================================================================
  const MAX_FIRMWARE_BYTES = 16 * 1024 * 1024;
  const storageStatus = async () => {
    const rows = await rt.db.select('firmware_storage_tests', { order: { column: 'checked_at', ascending: false }, limit: 1 });
    const last = (rows[0] as any) || null;
    return {
      backend: rt.storageBackend,
      configured: rt.storageBackend !== 'none',
      r2_configured: rt.storageBackend === 'r2',
      connected: last ? last.backend === rt.storageBackend && !!last.connected : false,
      last_test: last ? { connected: !!last.connected, detail: last.detail, checked_at: last.checked_at } : null,
      hint: rt.storageBackend === 'r2'
        ? 'Run the upload/download test to verify the native FIRMWARE_BUCKET R2 binding.'
        : 'No FIRMWARE_BUCKET R2 binding was found. Add it in Cloudflare Pages → Settings → Functions → R2 bucket bindings, then redeploy. Firmware currently uses private Supabase Storage.',
    };
  };
  app.get('/api/owner/firmware', async (c) => {
    await ownerOnly(c);
    const [overview, catalog, storage] = await Promise.all([
      rt.db.rpc<any>('rpc_firmware_overview', {}),
      rt.db.select('board_catalog', { eq: { active: true }, order: { column: 'model' } }),
      storageStatus(),
    ]);
    const signingKey = String(rt.env.FW_SIGNING_PUBKEY || '').trim();
    return c.json({ ...(overview || {}), board_catalog: catalog, storage,
      signing: {
        configured: /^[A-Za-z0-9+/]{43}=$/.test(signingKey),
        algorithm: 'ed25519',
        public_key_suffix: signingKey ? signingKey.slice(-8) : null,
        note: /^[A-Za-z0-9+/]{43}=$/.test(signingKey)
          ? 'Packages are checked against this key when they are uploaded.'
          : 'Add FW_SIGNING_PUBKEY in Cloudflare Pages → Settings → Variables and Secrets to verify release signatures. Until then every package reports "signing key not configured".',
      },
      limits: {
        max_bytes: MAX_FIRMWARE_BYTES, allowed_extensions: ['.bin'],
        package_max_bytes: MAX_ARCHIVE_BYTES, package_extensions: ['.zip'],
      } });
  });
  app.post('/api/owner/firmware/test-storage', async (c) => {
    const ctx = await ownerOnly(c);
    let result: any;
    if (rt.r2) result = await rt.r2.roundTrip();
    else result = await testStorage(rt.store);
    await rt.db.insert('firmware_storage_tests', {
      backend: rt.storageBackend, connected: !!result.ok || !!result.connected,
      detail: String(result.detail || ''), tested_by: ctx.profileId,
    }).catch(() => {});
    await rt.db.insert('audit_logs', { actor_id: ctx.profileId, actor_type: 'platform_admin',
      action: 'platform.firmware.storage.test', entity_type: 'storage', entity_id: rt.storageBackend,
      after: { connected: !!result.ok || !!result.connected } }).catch(() => {});
    return c.json({ connected: !!result.ok || !!result.connected, detail: result.detail,
      checked_at: result.checkedAt || new Date().toISOString(), backend: rt.storageBackend });
  });
  app.post('/api/owner/firmware/upload', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    const name = String(b.name || '').trim();
    const version = String(b.version || '').trim();
    if (!name) throw new HttpError(400, 'A release name is required');
    if (!/^[A-Za-z0-9._+-]{1,32}$/.test(version)) {
      throw new HttpError(400, 'Use letters, numbers, dots, dashes or plus signs for the version (for example 1.2.0)');
    }
    if (!b.binary_base64) throw new HttpError(400, 'Choose a firmware file to upload');
    let bytes: Uint8Array;
    try {
      bytes = fromB64(String(b.binary_base64));
    } catch {
      throw new HttpError(400, 'The uploaded file could not be decoded');
    }
    const channel = (ALLOWED_CHANNELS as readonly string[]).includes(String(b.channel)) ? String(b.channel) : 'stable';
    const status = ['draft', 'published'].includes(String(b.status)) ? String(b.status) : 'draft';
    const artifactKind = String(b.artifact_kind) === 'factory' ? 'factory' : 'app';
    const input: UploadInput = {
      name,
      version,
      description: String(b.description || '').trim().slice(0, 2000),
      releaseNotes: String(b.release_notes || b.description || '').trim().slice(0, 8000),
      channel,
      status,
      boardModels: normalizeBoardModels(b.board_models),
      chipFamily: String(b.chip_family || 'ESP32-S3'),
      hwConfig: String(b.hw_config || '').trim().slice(0, 120),
      artifactKind,
      flashOffset: artifactKind === 'factory' ? 0 : null,
      bytes,
      filename: String(b.filename || 'firmware.bin'),
      declaredSha: b.sha256 ? String(b.sha256).toLowerCase() : null,
    };
    try {
      const result = await createRelease(rt, input, ctx.profileId);
      emit(ctx.tenantId || 'platform', 'firmware.release.created', { id: result.id, version });
      return c.json(result, 201);
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, `The release could not be stored: ${String(e?.message || e).slice(0, 200)}`);
    }
  });

  /**
   * Upload a complete release ZIP produced by GitHub Actions: manifest.json, the
   * OTA application image, the merged USB factory image, SHA256SUMS.txt and an
   * optional Ed25519 signature. Both artifacts are stored in one step and the
   * owner sees exactly which checks passed.
   */
  app.post('/api/owner/firmware/upload-package', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    if (!b.package_base64) throw new HttpError(400, 'Choose the release ZIP downloaded from GitHub Actions or Releases');
    let bytes: Uint8Array;
    try {
      bytes = fromB64(String(b.package_base64));
    } catch {
      throw new HttpError(400, 'The ZIP could not be decoded. Download it again and upload the file unchanged.');
    }
    if (!bytes.byteLength) throw new HttpError(400, 'The ZIP is empty');
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
      throw new HttpError(413, `The ZIP is ${Math.round(bytes.byteLength / 1048576)} MB; a release package is smaller than ${Math.round(MAX_ARCHIVE_BYTES / 1048576)} MB.`);
    }
    // A ZIP always starts with "PK"; check that before unpacking anything, so a
    // file that was renamed to .zip is refused immediately.
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      throw new HttpError(400, 'That file is not a ZIP archive. Use "Upload release package" for the release ZIP, or "Upload single image" for a .bin file.');
    }
    const boardModels = normalizeBoardModels(b.board_models);
    try {
      const result = await createPackageRelease(rt, {
        bytes,
        status: String(b.status || 'draft'),
        channel: b.channel ? String(b.channel) : null,
        notes: b.notes ? String(b.notes).slice(0, 4000) : null,
        name: b.name ? String(b.name).slice(0, 120) : null,
        boardModels: boardModels.length ? boardModels : null,
      }, ctx.profileId, String(rt.env.FW_SIGNING_PUBKEY || ''));
      emit(ctx.tenantId || 'platform', 'firmware.release.created', {
        id: result.releases[0]?.id, version: result.version, package: true,
      });
      return c.json(result, 201);
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, `The release package could not be stored: ${String(e?.message || e).slice(0, 200)}`);
    }
  });

  /** Attach a detached signature over the published digest. */
  app.post('/api/owner/firmware/:id/signature', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    try {
      await rt.db.rpc('rpc_firmware_signature_set', {
        p_id: p(c, 'id'),
        p_signature: String(b.signature || '').trim(),
        p_alg: String(b.algorithm || 'ecdsa-p256-sha256'),
        p_actor: ctx.profileId,
      });
    } catch (e: any) {
      throw rpcError(e, 'The signature could not be attached');
    }
    return c.json({ ok: true });
  });

  /** Retire a problem release and report the previous stable one as fallback. */
  app.post('/api/owner/firmware/:id/retire', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c).catch(() => ({} as any));
    const result = await rt.db.rpc<any>('rpc_firmware_retire', {
      p_id: p(c, 'id'), p_actor: ctx.profileId, p_reason: String(b.reason || 'retired by owner'),
    });
    emit(ctx.tenantId || 'platform', 'firmware.release.retired', { id: p(c, 'id') });
    return c.json(result);
  });

  /** Which controllers a release can reach, with their running version. */
  app.get('/api/owner/firmware/:id/targets', async (c) => {
    await ownerOnly(c);
    const rows = await rt.db.select<any>('firmware_releases', { eq: { id: p(c, 'id') }, limit: 1 });
    const release = rows[0];
    if (!release) throw new HttpError(404, 'Release not found');
    const boards = await rt.db.select<any>('user_boards', { isNull: ['deleted_at'], order: { column: 'name' } });
    const catalog = await rt.db.select<any>('board_catalog');
    const models: string[] = release.board_models || [];
    return c.json({
      release: { id: release.id, version: release.version, kind: release.artifact_kind, signature: !!release.signature },
      controllers: (boards as any[]).map((board) => {
        const cat = (catalog as any[]).find((x) => x.id === board.catalog_board_id);
        const compatible = models.includes(board.catalog_board_id)
          || (cat && models.includes(cat.chip_family));
        return {
          id: board.id, name: board.name, tenant_id: board.tenant_id,
          status: board.status, installed_version: board.firmware_version,
          catalog_board_id: board.catalog_board_id,
          chip_family: cat?.chip_family || board.chip_family || null,
          compatible,
          already_running: board.firmware_version === release.version,
          reason: compatible ? null : 'board model is not supported by this release',
        };
      }),
    });
  });

  app.get('/api/owner/firmware/download/:id', async (c) => {
    await ownerOnly(c);
    const rows = await rt.db.select('firmware_releases', { eq: { id: p(c, 'id') }, limit: 1 });
    if (!rows.length) throw new HttpError(404, 'Release not found');
    const rel: any = rows[0];
    const data = await rt.store?.get(rel.r2_key);
    if (!data) throw new HttpError(404, 'Firmware binary not found in storage');
    const digest = await sha256Hex(new Uint8Array(data));
    if (digest !== rel.sha256) throw new HttpError(409, 'Stored binary failed checksum verification');
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', `attachment; filename="${String(rel.version).replace(/[^A-Za-z0-9._-]/g, '_')}.bin"`);
    c.header('X-Checksum-SHA256', digest);
    return new Response(data, { headers: new Headers(c.res.headers) });
  });
  app.patch('/api/owner/firmware/:id', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    const rows = await rt.db.select('firmware_releases', { eq: { id: p(c, 'id') }, limit: 1 });
    if (!rows.length || (rows[0] as any).deleted_at) throw new HttpError(404, 'Release not found');
    const patch: Record<string, unknown> = {};
    if ('name' in b) {
      const name = String(b.name || '').trim();
      if (!name) throw new HttpError(400, 'A name is required');
      patch.name = name.slice(0, 120);
    }
    if ('description' in b) patch.description = String(b.description || '').slice(0, 2000) || null;
    if ('version' in b) {
      const version = String(b.version || '').trim();
      if (!/^[A-Za-z0-9._+\- ]{1,64}$/.test(version)) throw new HttpError(400, 'Invalid version');
      const dup = await rt.db.select('firmware_releases', { eq: { version }, limit: 5 });
      if (dup.some((x: any) => x.id !== p(c, 'id') && !x.deleted_at)) throw new HttpError(409, 'Another release already uses this version');
      patch.version = version;
    }
    if ('channel' in b) {
      if (!['stable', 'beta', 'dev'].includes(String(b.channel))) throw new HttpError(400, 'Invalid channel');
      patch.channel = String(b.channel);
    }
    if ('board_models' in b) {
      const ids: string[] = Array.isArray(b.board_models) ? b.board_models.map(String) : [];
      const catalog = await rt.db.select('board_catalog', { eq: { active: true } });
      for (const id of ids) if (!(catalog as any[]).some((x: any) => x.id === id)) throw new HttpError(400, `Unknown board model: ${id}`);
      patch.board_models = ids;
    }
    if ('notes' in b) patch.notes = String(b.notes || '').slice(0, 2000) || null;
    if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to change');
    await rt.db.update('firmware_releases', { id: p(c, 'id') }, patch);
    await rt.db.insert('audit_logs', { actor_id: ctx.profileId, actor_type: 'platform_admin',
      action: 'platform.firmware.update', entity_type: 'firmware_release', entity_id: p(c, 'id'),
      after: patch }).catch(() => {});
    return c.json({ ok: true });
  });
  app.post('/api/owner/firmware/:id/status', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    const status = String(b.status || '');
    if (!['draft', 'published', 'archived'].includes(status)) throw new HttpError(400, 'Unknown status');
    const rows = await rt.db.select('firmware_releases', { eq: { id: p(c, 'id') }, limit: 1 });
    if (!rows.length || (rows[0] as any).deleted_at) throw new HttpError(404, 'Release not found');
    const rel: any = rows[0];
    if (status === 'published' && !(rel.board_models || []).length) throw new HttpError(400, 'Add compatible board models before publishing');
    try { await rt.db.rpc('rpc_firmware_set_status', { p_actor: ctx.profileId, p_id: p(c, 'id'), p_status: status }); }
    catch (e: any) { throw rpcError(e, 'Could not change the release status'); }
    return c.json({ ok: true, status });
  });
  app.delete('/api/owner/firmware/:id', async (c) => {
    const ctx = await ownerOnly(c);
    const confirm = String(c.req.query('confirm') || (await body(c).catch(() => ({} as any))).confirm || '');
    if (confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm');
    const rows = await rt.db.select('firmware_releases', { eq: { id: p(c, 'id') }, limit: 1 });
    if (!rows.length) throw new HttpError(404, 'Release not found');
    const rel: any = rows[0];
    const running = await rt.db.select('device_firmware_history', {
      eq: { firmware_release_id: rel.id }, limit: 200 });
    if (running.some((h: any) => ['queued', 'downloading', 'installing', 'verifying'].includes(h.status))) {
      throw new HttpError(409, 'An update is still running on a controller. Wait until it finishes.');
    }
    await rt.db.update('firmware_releases', { id: rel.id }, { deleted_at: new Date().toISOString() });
    try { await rt.store?.delete(rel.r2_key); }
    catch (e: any) {
      await rt.db.update('firmware_releases', { id: rel.id }, { deleted_at: null });
      throw new HttpError(502, `Safe deletion aborted: ${e?.message || 'storage delete failed'}`);
    }
    await rt.db.remove('firmware_releases', { id: rel.id });
    await rt.db.insert('audit_logs', { actor_id: ctx.profileId, actor_type: 'platform_admin',
      action: 'platform.firmware.delete', entity_type: 'firmware_release', entity_id: rel.id,
      after: { version: rel.version, key: rel.r2_key, object_deleted: true } }).catch(() => {});
    return c.json({ ok: true, object_deleted: true });
  });
  app.post('/api/owner/firmware/:id/deploy', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    if (!(await featureEnabled('features.ota'))) {
      throw new HttpError(403, 'Firmware updates are turned off in Platform Settings');
    }
    const all = b.all_compatible === true;
    const ids: string[] = Array.isArray(b.board_ids) ? b.board_ids.map(String) : [];
    if (!all && !ids.length) throw new HttpError(400, 'Select at least one controller, or all compatible controllers');
    const signingRequired = await featureEnabled('firmware.require_signature', false);
    const targets = all
      ? (await rt.db.select<any>('user_boards', { isNull: ['deleted_at'] })).map((row) => String(row.id))
      : ids;
    const results: any[] = [];
    for (const boardId of targets) {
      try {
        const plan = await queueOta(rt, {
          releaseId: p(c, 'id'), boardId, ip: requestIp(c), allowUnsigned: !signingRequired,
        });
        await publishOtaCommand(rt, plan);
        results.push({ board_id: boardId, ok: true, version: plan.version });
      } catch (e: any) {
        results.push({
          board_id: boardId, ok: false,
          reason: e instanceof HttpError ? e.message : 'Could not queue the update',
        });
      }
    }
    await rt.db.insert('audit_logs', {
      actor_id: ctx.profileId, actor_type: 'platform_admin',
      action: 'platform.firmware.deploy', entity_type: 'firmware_release', entity_id: p(c, 'id'),
      after: { controllers: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length },
    }).catch(() => {});
    return c.json({
      queued: results.filter((r) => r.ok).length,
      skipped: results.filter((r) => !r.ok).length,
      results,
    });
  });

  // ==========================================================================
  // Owner Console — Board library (custom definitions, validated GPIO)
  // ==========================================================================
  const CAPABILITY_KEYS = ['gpio', 'adc', 'pwm', 'i2c', 'spi', 'uart', 'touch', 'rtc', 'usb_jtag', 'flash', 'psram'];
  const normalizePins = (raw: any) => {
    if (!Array.isArray(raw)) throw new HttpError(400, 'Provide a list of GPIO rows');
    if (!raw.length) throw new HttpError(400, 'A board needs at least one GPIO row');
    if (raw.length > 60) throw new HttpError(400, 'A board cannot have more than 60 GPIO rows');
    const seen = new Set<number>();
    return raw.map((x: any) => {
      const gpio = Number(x.gpio);
      if (!Number.isInteger(gpio) || gpio < 0 || gpio > 48) throw new HttpError(400, `GPIO ${x.gpio} must be a whole number from 0 to 48`);
      if (seen.has(gpio)) throw new HttpError(400, `GPIO ${gpio} is listed more than once`);
      seen.add(gpio);
      const functions: string[] = Array.isArray(x.functions)
        ? x.functions.map((f: unknown) => String(f)).filter((f: string) => CAPABILITY_KEYS.includes(f)) : [];
      const adcChannels: string[] = Array.isArray(x.adc_channels) ? x.adc_channels.map((v: unknown) => String(v)) : [];
      const inputOnly = !!x.input_only;
      const exposed = x.exposed !== false;
      const restricted = !!x.restricted || !!x.boot_strapping || !!x.flash_connected || !!x.psram_connected || !exposed;
      if (inputOnly && functions.some((f) => ['pwm', 'spi', 'uart'].includes(f))) {
        throw new HttpError(400, `GPIO ${gpio} is input-only and cannot be assigned PWM, SPI or UART output`);
      }
      if (functions.includes('adc') && !adcChannels.length) {
        throw new HttpError(400, `GPIO ${gpio} is marked ADC but has no ADC channel`);
      }
      if (adcChannels.length && !functions.includes('adc')) functions.push('adc');
      return {
        board_id: '', gpio, header_label: String(x.header_label || `GPIO${gpio}`).slice(0, 40),
        side: x.side ? String(x.side).slice(0, 20) : null,
        header_pin: Number.isInteger(Number(x.header_pin)) && x.header_pin !== null && x.header_pin !== '' ? Number(x.header_pin) : null,
        functions, adc_channels: adcChannels, adc_bits: adcChannels.length ? 12 : null,
        input_only: inputOnly, exposed,
        boot_strapping: !!x.boot_strapping, usb_jtag: !!x.usb_jtag,
        flash_connected: !!x.flash_connected, psram_connected: !!x.psram_connected,
        touch_channel: x.touch_channel ? String(x.touch_channel).slice(0, 20) : null,
        rtc_gpio: !!x.rtc_gpio, restricted,
        restriction_note: x.restriction_note ? String(x.restriction_note).slice(0, 200)
          : (x.boot_strapping ? 'Boot-strapping pin: state affects startup' : x.flash_connected ? 'Connected to internal flash' : x.psram_connected ? 'Connected to PSRAM' : !exposed ? 'Not broken out on this board' : null),
        notes: x.notes ? String(x.notes).slice(0, 200) : null,
      };
    });
  };
  const boardPayload = (b: any) => Object.fromEntries([
    'manufacturer', 'model', 'variant', 'chip_family', 'chip_variant', 'revision', 'summary',
    'image_url', 'pinout_url', 'doc_source_url', 'capabilities', 'active',
  ].filter((k) => k in b).map((k) => [k, b[k]]));
  app.post('/api/owner/boards', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    const model = String(b.model || '').trim();
    const manufacturer = String(b.manufacturer || '').trim();
    const chipFamily = String(b.chip_family || '').trim();
    if (!model || !manufacturer || !chipFamily) throw new HttpError(400, 'Board name, manufacturer and ESP32 variant are required');
    const catalog = await rt.db.select('board_catalog');
    const knownFamilies = [...new Set((catalog as any[]).map((x: any) => String(x.chip_family)).filter(Boolean))];
    if (!knownFamilies.includes(chipFamily)) throw new HttpError(400, `Unknown ESP32 variant. Choose one already documented in the catalog: ${knownFamilies.join(', ')}`);
    if ((catalog as any[]).some((x: any) => x.model.toLowerCase() === model.toLowerCase()
      && String(x.manufacturer).toLowerCase() === manufacturer.toLowerCase())) {
      throw new HttpError(409, 'A board with this name and manufacturer already exists');
    }
    const pins = normalizePins(b.pins);
    const id = `owner.${randomHex(6)}`;
    const payload: any = {
      id, manufacturer, model, variant: b.variant || null, chip_family: chipFamily,
      chip_variant: b.chip_variant || null, revision: b.revision || null, category: 'custom',
      image_url: b.image_url || null, pinout_url: b.pinout_url || null,
      doc_source_url: b.doc_source_url || null,
      summary: b.summary ? String(b.summary).slice(0, 500) : 'Owner-supplied board. Pin information comes from the manufacturer documentation.',
      connectivity: {}, attributes: { pin_status: 'owner_supplied', catalog_version: 1 },
      capabilities: b.capabilities || {}, active: b.active !== false, is_custom: true,
    };
    await rt.db.insert('board_catalog', payload);
    await rt.db.insert('board_catalog_versions', { board_id: id, version: 1,
      changelog: 'Owner supplied pin map', published: false });
    await rt.db.insert('board_catalog_pins', pins.map((x) => ({ ...x, board_id: id })));
    await rt.db.insert('audit_logs', { actor_id: ctx.profileId, actor_type: 'platform_admin',
      action: 'platform.board.create', entity_type: 'board_catalog', entity_id: id,
      after: { model, manufacturer, chip_family: chipFamily, pins: pins.length } }).catch(() => {});
    return c.json({ id, pin_count: pins.length }, 201);
  });
  app.get('/api/owner/boards/:id/pins', async (c) => {
    await ownerOnly(c);
    const rows = await rt.db.select('board_catalog_pins', { eq: { board_id: p(c, 'id') }, order: { column: 'gpio' } });
    return c.json(rows);
  });
  app.put('/api/owner/boards/:id/pins', async (c) => {
    const ctx = await ownerOnly(c);
    const b = await body(c);
    const rows = await rt.db.select('board_catalog', { eq: { id: p(c, 'id') }, limit: 1 });
    if (!rows.length) throw new HttpError(404, 'Board not found');
    if (!(rows[0] as any).is_custom && String((rows[0] as any).category) !== 'custom') {
      throw new HttpError(409, 'Verified manufacturer pin maps are read-only. Create a custom board instead.');
    }
    const pins = normalizePins(b.pins);
    await rt.db.remove('board_catalog_pins', { board_id: p(c, 'id') });
    await rt.db.insert('board_catalog_pins', pins.map((x) => ({ ...x, board_id: p(c, 'id') })));
    if (b.capabilities) await rt.db.update('board_catalog', { id: p(c, 'id') }, { capabilities: b.capabilities });
    await rt.db.insert('audit_logs', { actor_id: ctx.profileId, actor_type: 'platform_admin',
      action: 'platform.board.pins', entity_type: 'board_catalog', entity_id: p(c, 'id'),
      after: { pin_count: pins.length } }).catch(() => {});
    return c.json({ ok: true, pin_count: pins.length });
  });
  app.post('/api/owner/boards/:id/archive', async (c) => {
    const ctx = await ownerOnly(c);
    const rows = await rt.db.select('board_catalog', { eq: { id: p(c, 'id') }, limit: 1 });
    if (!rows.length) throw new HttpError(404, 'Board not found');
    const active = !(rows[0] as any).active;
    await rt.db.update('board_catalog', { id: p(c, 'id') },
      { active, archived_at: active ? null : new Date().toISOString() });
    await rt.db.insert('audit_logs', { actor_id: ctx.profileId, actor_type: 'platform_admin',
      action: active ? 'platform.board.restore' : 'platform.board.archive',
      entity_type: 'board_catalog', entity_id: p(c, 'id'), after: {} }).catch(() => {});
    return c.json({ ok: true, active });
  });
  app.delete('/api/owner/boards/:id', async (c) => {
    const ctx = await ownerOnly(c);
    const confirm = String(c.req.query('confirm') || (await body(c).catch(() => ({} as any))).confirm || '');
    if (confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm');
    const rows = await rt.db.select('board_catalog', { eq: { id: p(c, 'id') }, limit: 1 });
    if (!rows.length) throw new HttpError(404, 'Board not found');
    if (!(rows[0] as any).is_custom && String((rows[0] as any).category) !== 'custom') {
      throw new HttpError(409, 'Verified manufacturer boards cannot be deleted');
    }
    const used = await rt.db.select('user_boards', { eq: { catalog_board_id: p(c, 'id') }, limit: 1 });
    if (used.length) throw new HttpError(409, 'Controllers still use this board. Archive it instead.');
    await rt.db.remove('board_catalog', { id: p(c, 'id') });
    await rt.db.insert('audit_logs', { actor_id: ctx.profileId, actor_type: 'platform_admin',
      action: 'platform.board.delete', entity_type: 'board_catalog', entity_id: p(c, 'id'), after: {} }).catch(() => {});
    return c.json({ ok: true });
  });
  app.post('/api/board-catalog/validate-gpio', async (c) => {
    await actor(c);
    const b = await body(c);
    const boardId = String(b.board_id || ''), gpio = Number(b.gpio);
    const capability = String(b.capability || 'gpio');
    const rows = await rt.db.select('board_catalog_pins', { eq: { board_id: boardId, gpio }, limit: 1 });
    if (!rows.length) return c.json({ allowed: false, reason: `GPIO ${gpio} is not documented for this board` });
    const pin: any = rows[0];
    if (!pin.exposed) return c.json({ allowed: false, reason: `GPIO ${gpio} is not available on the header` });
    if (pin.restricted || pin.flash_connected || pin.psram_connected) {
      return c.json({ allowed: false, reason: pin.restriction_note || `GPIO ${gpio} is reserved by the board` });
    }
    if (pin.boot_strapping) return c.json({ allowed: false, reason: `GPIO ${gpio} is a boot-strapping pin` });
    if (pin.input_only && ['pwm', 'spi', 'uart', 'output'].includes(capability)) {
      return c.json({ allowed: false, reason: `GPIO ${gpio} is input-only` });
    }
    if (!['gpio', 'output'].includes(capability) && !(pin.functions || []).includes(capability)) {
      return c.json({ allowed: false, reason: `GPIO ${gpio} does not support ${capability.toUpperCase()}` });
    }
    return c.json({ allowed: true, pin });
  });

  // ==========================================================================
  // Customer Device Setup Wizard — real progress, never a simulated success
  // ==========================================================================
  // ==========================================================================
  // Owner Console — Authentication & Security (backend-enforced state)
  // ==========================================================================
  app.get('/api/owner/auth/security', async (c) => {
    await ownerOnly(c);
    const [config, health, accounts, sessions, events, roles, settings] = await Promise.all([
      rt.auth.config(), rt.auth.health(),
      rt.db.rpc<any>('rpc_auth_accounts', {}),
      rt.db.rpc<any>('rpc_auth_all_sessions', {}),
      rt.db.rpc<any>('rpc_auth_security_events', { p_limit: 100 }),
      rt.db.rpc<any>('rpc_auth_roles', {}),
      rt.db.select('platform_settings'),
    ]);
    return c.json({
      config, health, accounts: accounts || [], sessions: sessions || [],
      events: events || [], roles: roles || { roles: [], permissions: [] },
      registration_control: {
        enabled: config.registration_enabled !== 0,
        note: 'Changing this setting takes effect on the next registration request.',
      },
      storage: { backend: rt.storageBackend, r2_configured: rt.storageBackend === 'r2' },
    });
  });
  app.post('/api/owner/auth/sessions/:id/revoke', async (c) => {
    const ctx = await ownerOnly(c);
    await rt.db.rpc('rpc_auth_session_revoke_any', { p_session_id: p(c, 'id') });
    await rt.db.insert('app_security_events', { event_type: 'session_revoked',
      detail: `Administrator ended session ${p(c, 'id')}` }).catch(() => {});
    await rt.db.insert('audit_logs', { actor_id: ctx.profileId, actor_type: 'platform_admin',
      action: 'platform.auth.session.revoke', entity_type: 'session', entity_id: p(c, 'id'), after: {} }).catch(() => {});
    return c.json({ ok: true });
  });

  return app;
}

// ============================================================================
// Helpers
// ============================================================================


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rpcError(e: any, fallback: string): HttpError {
  const raw = String(e?.message || '');
  if (/invalid input syntax for type uuid/.test(raw)) return new HttpError(404, fallback);
  const known = [
    'The Platform Owner account cannot be suspended',
    'Invalid status', 'Account not found', 'Unknown authentication setting',
    'Value out of range', 'bcrypt_cost must be between 4 and 15',
    'password_min_length must be between 8 and 128',
    'Enable the pgcrypto extension in Supabase to use password authentication',
  ];
  for (const k of known) if (raw.includes(k)) return new HttpError(400, k);
  return new HttpError(400, fallback);
}

function requestInfo(c: any) {
  return {
    ip: (String(c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '').split(',')[0] || '').trim(),
    userAgent: String(c.req.header('User-Agent') || '').slice(0, 200),
  };
}

function setSessionCookie(c: any, token: string, expiresAt: string) {
  const target = new Date(expiresAt).getTime();
  const seconds = Number.isFinite(target) ? Math.floor((target - Date.now()) / 1000) : 604800;
  setCookie(c, SESSION_COOKIE, token, {
    path: '/', httpOnly: true, secure: true, sameSite: 'Lax',
    maxAge: Math.max(60, Math.min(60 * 60 * 24 * 30, seconds || 604800)),
  });
}
async function verifyInternal(c: any, raw?: string) {
  const rt = runtime(c);
  const secret = String(rt.env.SIGNING_KEY || '');
  if (!secret) throw new HttpError(503, 'Server signing key is not available');
  const sig = c.req.header('X-HomecoreOS-Signature') || '';
  if (raw !== undefined) {
    const ts = c.req.header('X-HomecoreOS-Timestamp') || '';
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
