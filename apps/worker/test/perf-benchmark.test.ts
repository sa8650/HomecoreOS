import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName}`);
  return `${cookieName}=${match[1]}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("HomecoreOS Performance Benchmark", () => {
  let dbHarness: PgliteHarness;
  let env: WorkerBindings;
  let dbCalls = 0;
  let emqxCalls = 0;
  let simulatedDbRttMs = 0;
  let simulatedEmqxRttMs = 0;
  let app: ReturnType<typeof createWorkerApp>;

  let adminCookie = "";
  let userCookie = "";
  let controllerId = "";
  let roomId = "";
  const switchIds: string[] = [];
  let deviceId = "";

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

    const timedDbFetch: typeof fetch = async (input, init) => {
      dbCalls += 1;
      if (simulatedDbRttMs > 0) await sleep(simulatedDbRttMs);
      return dbHarness.fetch(input, init);
    };

    const timedEmqxFetch: typeof fetch = async (input, init) => {
      emqxCalls += 1;
      if (simulatedEmqxRttMs > 0) await sleep(simulatedEmqxRttMs);
      return emqxMock.fetch(input, init);
    };

    app = createWorkerApp({
      dbFetch: timedDbFetch,
      emqxFetch: timedEmqxFetch,
    });

    // Seed realistic fixture data (1 admin, 1 customer account, 1 home, 2 rooms, 2 controllers, 5 switches, 1 device, 1 automation)
    const bootRes = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "bench-admin@homecoreos.local",
        fullName: "Bench Admin",
        password: "AdminPassword123!",
      }),
    });
    adminCookie = extractCookie(bootRes, "hc_admin_session");

    const regRes = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "bench-user@homecoreos.local",
        password: "UserPassword123!",
        fullName: "Bench User",
        accountName: "Bench Home",
      }),
    });
    userCookie = extractCookie(regRes, "hc_user_session");

    const homesRes = await req("/api/homes", { headers: { Cookie: userCookie } });
    const { homes } = (await homesRes.json()) as { homes: Array<{ id: string }> };
    const homeId = homes[0]!.id;

    const roomRes = await req("/api/homes/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ homeId, name: "Living Room", roomType: "living_room" }),
    });
    roomId = ((await roomRes.json()) as { room: { id: string } }).room.id;

    const boardsRes = await req("/api/boards/catalog", { headers: { Cookie: userCookie } });
    const { boards } = (await boardsRes.json()) as { boards: Array<{ id: string }> };
    const boardId = boards[0]!.id;

    for (let i = 0; i < 2; i++) {
      const cRes = await req("/api/controllers", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userCookie },
        body: JSON.stringify({ name: `Hub ${i + 1}`, homeId, boardCatalogId: boardId }),
      });
      const { controller, pairingCode } = (await cRes.json()) as {
        controller: { id: string };
        pairingCode: string;
      };
      if (i === 0) controllerId = controller.id;
      await req("/api/device/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairingCode,
          macAddress: `AA:BB:CC:DD:EE:0${i + 1}`,
          firmwareVersion: "1.2.0",
        }),
      });
    }

    for (let pin = 4; pin <= 8; pin++) {
      const swRes = await req("/api/switches", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userCookie },
        body: JSON.stringify({
          name: `Switch ${pin}`,
          controllerId,
          roomId,
          gpioPin: pin,
        }),
      });
      switchIds.push(((await swRes.json()) as { switch: { id: string } }).switch.id);
    }

    const devRes = await req("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Living Room TV",
        deviceType: "tv",
        controllerId,
        roomId,
        gpioPin: 10,
      }),
    });
    deviceId = ((await devRes.json()) as { device: { id: string } }).device.id;
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  async function req(path: string, init?: RequestInit): Promise<Response> {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  async function measureOp(
    label: string,
    fn: () => Promise<Response | Response[]>
  ): Promise<{ label: string; ms: number; dbCalls: number; emqxCalls: number }> {
    dbCalls = 0;
    emqxCalls = 0;
    const t0 = performance.now();
    const res = await fn();
    const ms = Number((performance.now() - t0).toFixed(1));
    const list = Array.isArray(res) ? res : [res];
    for (const r of list) {
      expect(r.ok).toBe(true);
    }
    return { label, ms, dbCalls, emqxCalls };
  }

  it("measures API round-trips and simulated cloud latencies across core flows", async () => {
    // Measure with realistic 12ms PostgREST RTT + 25ms EMQX Cloud API RTT
    simulatedDbRttMs = 12;
    simulatedEmqxRttMs = 25;

    const results = [
      await measureOp("GET /api/auth/me", () =>
        req("/api/auth/me", { headers: { Cookie: userCookie } })
      ),
      await measureOp("GET /api/homes/overview", () =>
        req("/api/homes/overview", { headers: { Cookie: userCookie } })
      ),
      await measureOp("GET /api/controllers (2 hubs)", () =>
        req("/api/controllers", { headers: { Cookie: userCookie } })
      ),
      await measureOp("GET /api/boards/catalog", () =>
        req("/api/boards/catalog", { headers: { Cookie: userCookie } })
      ),
      await measureOp("GET /api/notifications?limit=15", () =>
        req("/api/notifications?limit=15", { headers: { Cookie: userCookie } })
      ),
      await measureOp("POST /api/switches/:id/toggle", () =>
        req(`/api/switches/${switchIds[0]}/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: userCookie },
          body: JSON.stringify({ isOn: true }),
        })
      ),
      await measureOp("POST /api/devices/:id/command", () =>
        req(`/api/devices/${deviceId}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: userCookie },
          body: JSON.stringify({ state: "on" }),
        })
      ),
      await measureOp("PATCH /api/switches/:id (rename/room)", () =>
        req(`/api/switches/${switchIds[0]}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: userCookie },
          body: JSON.stringify({ name: "Renamed Lamp" }),
        })
      ),
      await measureOp("PATCH /api/homes/rooms/:id (drag move)", () =>
        req(`/api/homes/rooms/${roomId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: userCookie },
          body: JSON.stringify({ floorX: 40, floorY: 20 }),
        })
      ),
      await measureOp("5 concurrent switch toggles", () =>
        Promise.all(
          switchIds.map((id) =>
            req(`/api/switches/${id}/toggle`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Cookie: userCookie },
              body: JSON.stringify({ isOn: true }),
            })
          )
        )
      ),
      await measureOp("GET /api/admin/overview", () =>
        req("/api/admin/overview", { headers: { Cookie: adminCookie } })
      ),
    ];

    simulatedDbRttMs = 0;
    simulatedEmqxRttMs = 0;

    console.log("\n=== HOMECOREOS PERF BENCHMARK (12ms DB RTT, 25ms EMQX RTT) ===");
    for (const r of results) {
      console.log(
        `${r.label.padEnd(42)} | ${String(r.ms).padStart(7)} ms | DB: ${String(r.dbCalls).padStart(2)} | EMQX: ${r.emqxCalls}`
      );
    }
    expect(results.length).toBeGreaterThan(0);
  });
});
