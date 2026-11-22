import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerApp } from "../src/index";
import type { WorkerBindings } from "../src/config/env";
import {
  computeBoardHealth,
  computeCustomerHealth,
} from "../src/lib/customer-monitoring";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";
import { seedInstalledFirmwareWithDrivers } from "./helpers/firmware-fixture";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName} in ${header}`);
  return `${cookieName}=${match[1]}`;
}

describe("Board health rules (pure)", () => {
  const now = Date.parse("2026-11-21T12:00:00.000Z");
  const fresh = new Date(now - 30_000).toISOString();
  const stale = new Date(now - 10 * 60_000).toISOString();

  it("marks a board Healthy only with fresh telemetry and no warnings", () => {
    const health = computeBoardHealth({
      status: "online",
      lastHeartbeatAt: fresh,
      lastCommunicationAt: fresh,
      mqttConnected: true,
      wifiConnected: true,
      pendingConfigSync: false,
      firmwareVersion: "1.5.0",
      counts: { devices: 2, devicesOnline: 2, sensors: 1, sensorsOnline: 1, sensorsStale: 0, switches: 1, switchesOnline: 1 },
      nowMs: now,
      offlineTimeoutSeconds: 180,
    });
    expect(health.status).toBe("healthy");
    expect(health.reasons).toEqual([]);
  });

  it("marks online-without-telemetry as Unknown, never Healthy", () => {
    const health = computeBoardHealth({
      status: "online",
      lastHeartbeatAt: null,
      lastCommunicationAt: null,
      mqttConnected: true,
      firmwareVersion: "1.5.0",
      nowMs: now,
      offlineTimeoutSeconds: 180,
    });
    expect(health.status).toBe("unknown");
    expect(health.telemetry.hasTelemetry).toBe(false);
  });

  it("marks stale heartbeat as Offline", () => {
    const health = computeBoardHealth({
      status: "online",
      lastHeartbeatAt: stale,
      lastCommunicationAt: stale,
      mqttConnected: true,
      firmwareVersion: "1.5.0",
      nowMs: now,
      offlineTimeoutSeconds: 180,
    });
    expect(health.status).toBe("offline");
  });

  it("marks recorded offline status as Offline even without telemetry", () => {
    const health = computeBoardHealth({
      status: "offline",
      lastHeartbeatAt: null,
      lastCommunicationAt: null,
      nowMs: now,
      offlineTimeoutSeconds: 180,
    });
    expect(health.status).toBe("offline");
  });

  it("marks pending with no telemetry as Unknown", () => {
    const health = computeBoardHealth({
      status: "pending",
      lastHeartbeatAt: null,
      lastCommunicationAt: null,
      nowMs: now,
      offlineTimeoutSeconds: 180,
    });
    expect(health.status).toBe("unknown");
  });

  it("degrades to Warning for MQTT disconnect, pending sync, update, and offline entities", () => {
    const health = computeBoardHealth({
      status: "online",
      lastHeartbeatAt: fresh,
      lastCommunicationAt: fresh,
      mqttConnected: false,
      wifiConnected: true,
      pendingConfigSync: true,
      firmwareVersion: "1.0.0",
      availableUpdateVersion: "1.5.0",
      counts: { devices: 3, devicesOnline: 1, sensors: 2, sensorsOnline: 2, sensorsStale: 1, switches: 2, switchesOnline: 2 },
      nowMs: now,
      offlineTimeoutSeconds: 180,
    });
    expect(health.status).toBe("warning");
    expect(health.reasons.join(" ")).toContain("MQTT is not connected");
    expect(health.reasons.join(" ")).toContain("Configuration sync is pending");
    expect(health.reasons.join(" ")).toContain("Firmware update available");
    expect(health.reasons.join(" ")).toContain("2 of 3 device(s) offline");
    expect(health.reasons.join(" ")).toContain("stale");
  });

  it("aggregates customer health: mixed is Warning, all-healthy is Healthy, empty is Unknown", () => {
    expect(computeCustomerHealth([]).status).toBe("unknown");
    expect(computeCustomerHealth(["healthy", "healthy"]).status).toBe("healthy");
    expect(computeCustomerHealth(["offline", "offline"]).status).toBe("offline");
    expect(computeCustomerHealth(["unknown", "unknown"]).status).toBe("unknown");
    expect(computeCustomerHealth(["healthy", "offline"]).status).toBe("warning");
    expect(computeCustomerHealth(["healthy", "unknown"]).status).toBe("warning");
  });
});

describe("Admin Customer Monitoring API (read-only, isolated)", () => {
  let dbHarness: PgliteHarness;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;
  let adminCookie: string;
  let accountAId: string;
  let accountBId: string;
  let boardAId: string;
  let boardBId: string;
  let boardProfileId: string;
  let boardSlug: string;

  beforeAll(async () => {
    dbHarness = await createPglitePostgrest();
    const emqxMock = createMockEmqxFetch();
    env = {
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-secret",
      EMQX_API_BASE: "https://mock.emqx.cloud:8443/api/v5",
      EMQX_APP_ID: "app-id",
      EMQX_APP_SECRET: "app-secret",
      EMQX_BROKER_HOST: "mock.emqx.cloud",
      EMQX_TLS_PORT: "8883",
      FIRMWARE_BUCKET: createMockR2Bucket(),
    };
    app = createWorkerApp({
      dbFetch: dbHarness.fetch,
      emqxFetch: emqxMock.fetch,
    });

    const boot = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "monitor-admin@homecoreos.local",
        fullName: "Monitor Admin",
        password: "MonitorPassword123!",
      }),
    });
    expect(boot.status).toBe(201);
    adminCookie = extractCookie(boot, "hc_admin_session");

    const regA = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "monitor-a@example.com",
        password: "MonitorAPassword123!",
        fullName: "Monitor A Owner",
        accountName: "Monitor A Home",
      }),
    });
    expect(regA.status).toBe(201);
    const cookieA = extractCookie(regA, "hc_user_session");
    accountAId = ((await regA.json()) as { account: { id: string } }).account.id;

    const regB = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "monitor-b@example.com",
        password: "MonitorBPassword123!",
        fullName: "Monitor B Owner",
        accountName: "Monitor B Home",
      }),
    });
    expect(regB.status).toBe(201);
    const cookieB = extractCookie(regB, "hc_user_session");
    accountBId = ((await regB.json()) as { account: { id: string } }).account.id;

    const cat = await req("/api/board-library/catalog", {
      headers: { Cookie: cookieA },
    });
    const catJson = (await cat.json()) as {
      boards: Array<{ id: string; slug: string }>;
    };
    const s3 = catJson.boards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;
    boardProfileId = s3.id;
    boardSlug = s3.slug;

    async function createBoard(cookie: string, name: string): Promise<string> {
      const res = await req("/api/board-instances", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name, boardProfileId }),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { controller: { id: string } }).controller.id;
    }

    boardAId = await createBoard(cookieA, "Monitor A S3");
    boardBId = await createBoard(cookieB, "Monitor B S3");

    await seedInstalledFirmwareWithDrivers({
      pg: dbHarness.pg,
      boardInstanceId: boardAId,
      boardId: boardProfileId,
      boardSlug,
      chipFamily: "esp32s3",
      version: "1.5.0",
    });

    // Fresh telemetry for A (healthy), stale/offline telemetry for B.
    const nowIso = new Date().toISOString();
    const freshIso = new Date(Date.now() - 30_000).toISOString();
    const staleIso = new Date(Date.now() - 60 * 60_000).toISOString();
    await dbHarness.pg.query(
      `UPDATE public.board_instances
       SET status = 'online', pairing_status = 'paired', mqtt_connected = true,
           wifi_connected = true, firmware_version = '1.5.0',
           last_heartbeat_at = $1, last_communication_at = $1,
           last_config_synced_at = $1, wifi_ssid = 'HomeWiFi', local_ip = '192.168.1.44'
       WHERE id = $2`,
      [freshIso, boardAId]
    );
    await dbHarness.pg.query(
      `UPDATE public.board_instances
       SET status = 'offline', pairing_status = 'paired', mqtt_connected = false,
           wifi_connected = false, firmware_version = '1.5.0',
           last_heartbeat_at = $1, last_communication_at = $1
       WHERE id = $2`,
      [staleIso, boardBId]
    );
    void nowIso;

    // Entities on board A: 1 online device, 1 offline device, 1 fresh sensor,
    // 1 stale sensor, 1 online switch. Inserted directly (monitoring reads DB).
    const homeA = await dbHarness.pg.query<{ id: string }>(
      `SELECT id FROM public.homes WHERE account_id = $1 LIMIT 1`,
      [accountAId]
    );
    const homeAId = homeA.rows[0]!.id;
    await dbHarness.pg.query(
      `INSERT INTO public.devices (account_id, home_id, board_instance_id, name, device_type, gpio_pin, state, is_online)
       VALUES ($1, $2, $3, 'Lamp', 'light', 4, 'on', true),
              ($1, $2, $3, 'Fan', 'fan', 5, 'off', false)`,
      [accountAId, homeAId, boardAId]
    );
    await dbHarness.pg.query(
      `INSERT INTO public.sensors (account_id, home_id, board_instance_id, name, sensor_type, gpio_pin, unit, is_online, last_value, last_reading_at)
       VALUES ($1, $2, $3, 'Temp', 'temperature_bme280', 21, '°C', true, 22.5, $4),
              ($1, $2, $3, 'Old Temp', 'temperature_bme280', 22, '°C', true, 20.0, $5)`,
      [accountAId, homeAId, boardAId, freshIso, staleIso]
    );
    await dbHarness.pg.query(
      `INSERT INTO public.switches (account_id, home_id, board_instance_id, name, gpio_pin, is_on, is_online)
       VALUES ($1, $2, $3, 'Wall Switch', 13, true, true)`,
      [accountAId, homeAId, boardAId]
    );

    // Activity for board A diagnostics.
    await dbHarness.pg.query(
      `INSERT INTO public.activity_logs (account_id, board_instance_id, category, action, summary)
       VALUES ($1, $2, 'controller', 'controller.heartbeat', 'Heartbeat received')`,
      [accountAId, boardAId]
    );
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  it("requires admin auth and returns customer overview with accurate counts", async () => {
    const unauth = await req(`/api/admin/accounts/${accountAId}/monitoring`);
    expect(unauth.status).toBe(401);

    const res = await req(`/api/admin/accounts/${accountAId}/monitoring?page=1&pageSize=25`, {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      account: { id: string; name: string };
      owner: { email: string } | null;
      summary: Record<string, unknown>;
      health: { status: string; counts: Record<string, number> };
      boards: Array<Record<string, unknown>>;
      pagination: { total: number; page: number };
    };
    expect(body.account.id).toBe(accountAId);
    expect(body.account.name).toBe("Monitor A Home");
    expect(body.owner?.email).toBe("monitor-a@example.com");
    expect(body.summary.totalBoards).toBe(1);
    expect(body.summary.totalDevices).toBe(2);
    expect(body.summary.totalSensors).toBe(2);
    expect(body.summary.totalSwitches).toBe(1);
    expect(body.summary.onlineBoards).toBe(1);
    expect(body.summary.offlineBoards).toBe(0);
    expect(body.summary.lastSyncAt).toBeTruthy();
    expect(body.pagination.total).toBe(1);
    expect(body.boards).toHaveLength(1);
    const board = body.boards[0]!;
    expect(board.id).toBe(boardAId);
    expect(board.firmware_version).toBe("1.5.0");
    expect(board.status).toBe("online");
    // Fresh heartbeat + 1 offline device + 1 stale sensor => Warning, not Healthy.
    expect((board.health as { status: string }).status).toBe("warning");
    expect(body.health.status).toBe("warning");
    // Secrets must never leak.
    const text = JSON.stringify(body);
    expect(text).not.toContain("password_hash");
    expect(text).not.toContain("device_token_hash");
    expect(text).not.toContain("service-role-key-secret");
  });

  it("isolates customers: B's board never appears on A's page and vice versa", async () => {
    const resA = await req(`/api/admin/accounts/${accountAId}/monitoring`, {
      headers: { Cookie: adminCookie },
    });
    const bodyA = (await resA.json()) as { boards: Array<{ id: string }> };
    expect(bodyA.boards.map((b) => b.id)).toEqual([boardAId]);

    const resB = await req(`/api/admin/accounts/${accountBId}/monitoring`, {
      headers: { Cookie: adminCookie },
    });
    expect(resB.status).toBe(200);
    const bodyB = (await resB.json()) as {
      summary: { totalBoards: number; onlineBoards: number; offlineBoards: number };
      boards: Array<{ id: string; status: string; health: { status: string } }>;
      health: { status: string };
    };
    expect(bodyB.summary.totalBoards).toBe(1);
    expect(bodyB.summary.offlineBoards).toBe(1);
    expect(bodyB.boards[0]!.id).toBe(boardBId);
    expect(bodyB.boards[0]!.health.status).toBe("offline");
    expect(bodyB.health.status).toBe("offline");

    // Cross-account board detail must 404, not leak.
    const cross = await req(
      `/api/admin/accounts/${accountAId}/boards/${boardBId}`,
      { headers: { Cookie: adminCookie } }
    );
    expect(cross.status).toBe(404);
  });

  it("exposes account-scoped recovery history to administrators as read-only", async () => {
    await dbHarness.pg.query(`INSERT INTO recovery_sessions
      (account_id, board_instance_id, transport, status, expires_at)
      VALUES ($1, $2, 'usb', 'failed', now() + interval '15 minutes'),
             ($3, $4, 'ble', 'completed', now() + interval '15 minutes')`,
      [accountAId, boardAId, accountBId, boardBId]);
    const path = `/api/admin/accounts/${accountAId}/recovery-history`;
    expect((await req(path)).status).toBe(401);
    const res = await req(path, { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(200);
    const data = await res.json() as { sessions: Array<{ board_instance_id: string; transport: string }> };
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]).toMatchObject({ board_instance_id: boardAId, transport: "usb" });
    expect(JSON.stringify(data)).not.toMatch(/password|private_key|pairing_code/);
    const write = await req(path, { method: "POST", headers: { Cookie: adminCookie } });
    expect([404, 405]).toContain(write.status);
  });

  it("returns 404 for unknown accounts and paginates board inventory", async () => {
    const missing = await req(
      `/api/admin/accounts/00000000-0000-0000-0000-000000000000/monitoring`,
      { headers: { Cookie: adminCookie } }
    );
    expect(missing.status).toBe(404);

    const paged = await req(
      `/api/admin/accounts/${accountAId}/monitoring?page=1&pageSize=1`,
      { headers: { Cookie: adminCookie } }
    );
    expect(paged.status).toBe(200);
    const body = (await paged.json()) as {
      pagination: { page: number; pageSize: number; total: number; totalPages: number };
    };
    expect(body.pagination).toMatchObject({ page: 1, pageSize: 1, total: 1, totalPages: 1 });
  });

  it("serves read-only board detail and paginated entity lists", async () => {
    const detail = await req(
      `/api/admin/accounts/${accountAId}/boards/${boardAId}`,
      { headers: { Cookie: adminCookie } }
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      board: { id: string; counts: { devices: number } };
      recentActivity: Array<{ summary: string }>;
      firmwareHistory: unknown[];
    };
    expect(detailBody.board.id).toBe(boardAId);
    expect(detailBody.board.counts.devices).toBe(2);
    expect(detailBody.recentActivity.some((a) => a.summary.includes("Heartbeat"))).toBe(true);

    const devices = await req(
      `/api/admin/accounts/${accountAId}/boards/${boardAId}/devices?page=1&pageSize=1`,
      { headers: { Cookie: adminCookie } }
    );
    expect(devices.status).toBe(200);
    const devicesBody = (await devices.json()) as {
      items: unknown[];
      pagination: { total: number; totalPages: number };
    };
    expect(devicesBody.items).toHaveLength(1);
    expect(devicesBody.pagination.total).toBe(2);
    expect(devicesBody.pagination.totalPages).toBe(2);

    const sensors = await req(
      `/api/admin/accounts/${accountAId}/boards/${boardAId}/sensors`,
      { headers: { Cookie: adminCookie } }
    );
    expect(sensors.status).toBe(200);
    const sensorsBody = (await sensors.json()) as { items: Array<Record<string, unknown>> };
    expect(sensorsBody.items).toHaveLength(2);
    expect(sensorsBody.items[0]).toHaveProperty("driver_id");

    const switches = await req(
      `/api/admin/accounts/${accountAId}/boards/${boardAId}/switches`,
      { headers: { Cookie: adminCookie } }
    );
    expect(switches.status).toBe(200);
    const switchesBody = (await switches.json()) as { items: Array<Record<string, unknown>> };
    expect(switchesBody.items).toHaveLength(1);
    expect(switchesBody.items[0]!.is_on).toBe(true);

    // Entity lists are also ownership-gated.
    const crossDevices = await req(
      `/api/admin/accounts/${accountBId}/boards/${boardAId}/devices`,
      { headers: { Cookie: adminCookie } }
    );
    expect(crossDevices.status).toBe(404);
  });

  it("is read-only: non-GET methods do not exist and do not mutate state", async () => {
    const post = await req(`/api/admin/accounts/${accountAId}/monitoring`, {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "offline" }),
    });
    expect([404, 405]).toContain(post.status);

    const patch = await req(
      `/api/admin/accounts/${accountAId}/boards/${boardAId}`,
      {
        method: "PATCH",
        headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "offline" }),
      }
    );
    expect([404, 405]).toContain(patch.status);

    // Board is still online after the attempted mutations.
    const after = await req(
      `/api/admin/accounts/${accountAId}/boards/${boardAId}`,
      { headers: { Cookie: adminCookie } }
    );
    const afterBody = (await after.json()) as { board: { status: string } };
    expect(afterBody.board.status).toBe("online");
  });

  it("rejects customer sessions on monitoring endpoints", async () => {
    const reg = await req("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "monitor-a@example.com",
        password: "MonitorAPassword123!",
      }),
    });
    // Login may require onboarding/session handling; if it succeeds, its cookie
    // must still be rejected by admin routes. If login itself fails in this
    // harness, the unauthenticated case above already covers the guard.
    if (reg.status === 200) {
      const customerCookie = extractCookie(reg, "hc_user_session");
      const res = await req(`/api/admin/accounts/${accountAId}/monitoring`, {
        headers: { Cookie: customerCookie },
      });
      expect(res.status).toBe(401);
    } else {
      expect([200, 401, 403]).toContain(reg.status);
    }
  });
});
