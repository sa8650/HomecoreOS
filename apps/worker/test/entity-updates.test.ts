import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName} in ${header}`);
  return `${cookieName}=${match[1]}`;
}

describe("Validated Entity PATCH updates (Switches, Devices, Sensors, Rooms) with GPIO & Tenant Guards", () => {
  let dbHarness: PgliteHarness;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;

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
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  it("validates full switch, device, sensor, and room updates while rejecting GPIO conflicts and cross-tenant writes", async () => {
    // 1. Register tenant A and tenant B
    const regA = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner-a@example.com",
        password: "PasswordA123!",
        fullName: "Owner A",
        accountName: "Home A",
      }),
    });
    expect(regA.status).toBe(201);
    const cookieA = extractCookie(regA, "hc_user_session");

    const regB = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner-b@example.com",
        password: "PasswordB123!",
        fullName: "Owner B",
        accountName: "Home B",
      }),
    });
    expect(regB.status).toBe(201);
    const cookieB = extractCookie(regB, "hc_user_session");

    // 2. Fetch home & catalog board for A
    const homesRes = await req("/api/homes", { headers: { Cookie: cookieA } });
    const homeA = ((await homesRes.json()) as { homes: Array<{ id: string }> }).homes[0]!;

    const boardsRes = await req("/api/boards/catalog", { headers: { Cookie: cookieA } });
    const board = ((await boardsRes.json()) as { boards: Array<{ id: string; slug: string }> }).boards.find(
      (b) => b.slug === "esp32-s3-devkitc-1-n16r8"
    )!;

    // 3. Create two controllers on A + one room
    const ctrl1Res = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ name: "Ctrl 1", homeId: homeA.id, boardCatalogId: board.id }),
    });
    const ctrl1 = ((await ctrl1Res.json()) as { controller: { id: string } }).controller;

    const ctrl2Res = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ name: "Ctrl 2", homeId: homeA.id, boardCatalogId: board.id }),
    });
    const ctrl2 = ((await ctrl2Res.json()) as { controller: { id: string } }).controller;

    const roomRes = await req("/api/homes/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ homeId: homeA.id, name: "Studio", roomType: "office" }),
    });
    const roomA = ((await roomRes.json()) as { room: { id: string } }).room;

    // 4. Create Switch (GPIO 4), Device (GPIO 6), Sensor (GPIO 5) on Ctrl 1
    const swRes = await req("/api/switches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        controllerId: ctrl1.id,
        roomId: roomA.id,
        name: "Desk Lamp",
        gpioPin: 4,
        invertedLogic: false,
      }),
    });
    expect(swRes.status).toBe(201);
    const sw = ((await swRes.json()) as { switch: { id: string } }).switch;

    const devRes = await req("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        controllerId: ctrl1.id,
        roomId: roomA.id,
        name: "Ceiling Fan",
        deviceType: "fan",
        gpioPin: 6,
      }),
    });
    expect(devRes.status).toBe(201);
    const dev = ((await devRes.json()) as { device: { id: string } }).device;

    const senRes = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        controllerId: ctrl1.id,
        roomId: roomA.id,
        name: "Ambient Temp",
        sensorType: "temperature_dht22",
        gpioPin: 5,
      }),
    });
    expect(senRes.status).toBe(201);
    const sen = ((await senRes.json()) as { sensor: { id: string } }).sensor;

    // 5. Reject Switch PATCH colliding with Device GPIO 6 on same controller
    const swCollision = await req(`/api/switches/${sw.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ gpioPin: 6 }),
    });
    expect(swCollision.status).toBe(400);

    // 6. Reject reserved Flash/PSRAM GPIO 28 on ESP32-S3
    const devReserved = await req(`/api/devices/${dev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ gpioPin: 28 }),
    });
    expect(devReserved.status).toBe(400);

    // 7. Allow Switch PATCH keeping its own pin OR moving to Ctrl 2 GPIO 12 + toggling invertedLogic
    const swValid = await req(`/api/switches/${sw.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        name: "Studio Lamp Updated",
        controllerId: ctrl2.id,
        roomId: null,
        gpioPin: 12,
        invertedLogic: true,
      }),
    });
    expect(swValid.status).toBe(200);
    const swUpdated = ((await swValid.json()) as {
      switch: { name: string; controller_id: string; gpio_pin: number; inverted: boolean; room_id: string | null };
    }).switch;
    expect(swUpdated.name).toBe("Studio Lamp Updated");
    expect(swUpdated.controller_id).toBe(ctrl2.id);
    expect(swUpdated.gpio_pin).toBe(12);
    expect(swUpdated.inverted).toBe(true);
    expect(swUpdated.room_id).toBeNull();

    // 8. Full Device PATCH (type + pin + name)
    const devValid = await req(`/api/devices/${dev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        name: "Hallway Dimmer",
        deviceType: "dimmer_pwm",
        gpioPin: 7,
      }),
    });
    expect(devValid.status).toBe(200);
    const devUpdated = ((await devValid.json()) as {
      device: { name: string; device_type: string; gpio_pin: number };
    }).device;
    expect(devUpdated.device_type).toBe("dimmer_pwm");
    expect(devUpdated.gpio_pin).toBe(7);

    // 9. Full Sensor PATCH (change type -> unit auto-updates, move pin, set I2C address)
    const senValid = await req(`/api/sensors/${sen.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        name: "Lux Sensor",
        sensorType: "light_bh1750",
        gpioPin: 8,
        i2cAddress: "0x23",
      }),
    });
    expect(senValid.status).toBe(200);
    const senUpdated = ((await senValid.json()) as {
      sensor: { name: string; sensor_type: string; unit: string; gpio_pin: number };
    }).sensor;
    expect(senUpdated.sensor_type).toBe("light_bh1750");
    expect(senUpdated.unit).toBe("lx");
    expect(senUpdated.gpio_pin).toBe(8);

    // 10. Tenant B cannot patch Tenant A's switch, device, sensor, or room
    for (const path of [
      `/api/switches/${sw.id}`,
      `/api/devices/${dev.id}`,
      `/api/sensors/${sen.id}`,
      `/api/homes/rooms/${roomA.id}`,
    ]) {
      const cross = await req(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookieB },
        body: JSON.stringify({ name: "Hijack" }),
      });
      expect(cross.status).toBe(404);
    }
  });
});
