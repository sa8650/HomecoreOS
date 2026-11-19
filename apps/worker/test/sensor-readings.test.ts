import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";
import { seedInstalledFirmwareWithDrivers } from "./helpers/firmware-fixture";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName} in ${header}`);
  return `${cookieName}=${match[1]}`;
}

async function registerUser(
  req: (path: string, init?: RequestInit) => Promise<Response>,
  email: string,
  accountName: string
) {
  const res = await req("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "Password123!",
      fullName: "Sensor App Owner",
      accountName,
    }),
  });
  expect(res.status).toBe(201);
  return extractCookie(res, "hc_user_session");
}

describe("Sensor reading history & controller room assignment", () => {
  let dbHarness: PgliteHarness;
  let emqxMock: ReturnType<typeof createMockEmqxFetch>;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;

  beforeAll(async () => {
    dbHarness = await createPglitePostgrest();
    emqxMock = createMockEmqxFetch();
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

  async function req(path: string, init?: RequestInit): Promise<Response> {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  it("records rolling history from telemetry and scopes reads per account", async () => {
    const userCookie = await registerUser(req, "history-owner@example.com", "History Lab");

    // Home + board
    const homesRes = await req("/api/homes", { headers: { Cookie: userCookie } });
    const { homes } = (await homesRes.json()) as { homes: Array<{ id: string }> };
    const home = homes[0]!;
    const boardsRes = await req("/api/board-library/catalog", { headers: { Cookie: userCookie } });
    const { boards } = (await boardsRes.json()) as {
      boards: Array<{ id: string; slug: string; chip_family: string }>;
    };
    const s3Board = boards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;

    // Controller + pairing
    const ctrlRes = await req("/api/board-instances", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ name: "History Hub", homeId: home.id, boardProfileId: s3Board.id }),
    });
    expect(ctrlRes.status).toBe(201);
    const { controller, pairingCode } = (await ctrlRes.json()) as {
      controller: { id: string };
      pairingCode: string;
    };

    const pairRes = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode,
        macAddress: "AA:BB:CC:DD:EE:77",
        firmwareVersion: "1.4.0",
        boardSlug: s3Board.slug,
        chipVariant: "esp32s3",
        flashSizeMb: 16,
        psramSizeMb: 8,
      }),
    });
    expect(pairRes.status).toBe(200);
    const { device_api_token: deviceToken } = (await pairRes.json()) as {
      device_api_token: string;
    };

    // Link firmware with the bme280 driver so the compatibility gate passes
    const seeded = await seedInstalledFirmwareWithDrivers({
      pg: dbHarness.pg,
      boardInstanceId: controller.id,
      boardId: s3Board.id,
      boardSlug: s3Board.slug,
      chipFamily: "esp32s3",
      version: "1.4.0",
      driverIds: ["bme280"],
    });
    await dbHarness.pg.query(
      `UPDATE public.board_instances SET installed_firmware_release_id = $1 WHERE id = $2`,
      [seeded.releaseId, controller.id]
    );

    const sensorRes = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "History Temp",
        sensorType: "temperature_bme280",
        boardInstanceId: controller.id,
        gpioPin: null,
        i2cAddress: "0x76",
      }),
    });
    expect(sensorRes.status).toBe(201);
    const { sensor } = (await sensorRes.json()) as { sensor: { id: string; unit: string } };

    // Telemetry: two good readings + one error reading (must not be recorded)
    for (const value of [20.1, 21.5]) {
      const res = await req("/api/device/telemetry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deviceToken}`,
        },
        body: JSON.stringify({
          sensors: [{ sensorId: sensor.id, value, status: "ok", driverId: "bme280" }],
        }),
      });
      expect(res.status).toBe(200);
    }
    const errTelem = await req("/api/device/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        sensors: [{ sensorId: sensor.id, status: "error", error: "i2c_nack", driverId: "bme280" }],
      }),
    });
    expect(errTelem.status).toBe(200);

    const historyRes = await req(`/api/sensors/history?ids=${sensor.id}`, {
      headers: { Cookie: userCookie },
    });
    expect(historyRes.status).toBe(200);
    const { history } = (await historyRes.json()) as {
      history: Record<string, Array<{ value: number; unit: string; recordedAt: string }>>;
    };
    const points = history[sensor.id] ?? [];
    expect(points).toHaveLength(2);
    expect(points.map((p) => p.value)).toEqual([20.1, 21.5]);

    // Another account must not read this history (even with the sensor id)
    const otherCookie = await registerUser(req, "history-outsider@example.com", "Outsider Lab");
    const foreignRes = await req(`/api/sensors/history?ids=${sensor.id}`, {
      headers: { Cookie: otherCookie },
    });
    expect(foreignRes.status).toBe(200);
    const foreign = (await foreignRes.json()) as { history: Record<string, unknown> };
    expect(foreign.history[sensor.id]).toBeUndefined();

    // Non-uuid / empty input degrades gracefully
    const junkRes = await req(`/api/sensors/history?ids=not-a-uuid`, {
      headers: { Cookie: userCookie },
    });
    expect(junkRes.status).toBe(200);
    expect(await junkRes.json()).toEqual({ history: {} });
  });

  it("assigns, changes, and removes a controller room with strict account scoping", async () => {
    const userCookie = await registerUser(req, "room-owner@example.com", "Room Lab");
    const homesRes = await req("/api/homes", { headers: { Cookie: userCookie } });
    const { homes } = (await homesRes.json()) as { homes: Array<{ id: string }> };
    const home = homes[0]!;
    const boardsRes = await req("/api/board-library/catalog", { headers: { Cookie: userCookie } });
    const { boards } = (await boardsRes.json()) as {
      boards: Array<{ id: string; slug: string }>;
    };
    const s3Board = boards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;

    const ctrlRes = await req("/api/board-instances", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ name: "Room Hub", homeId: home.id, boardProfileId: s3Board.id }),
    });
    expect(ctrlRes.status).toBe(201);
    const { controller } = (await ctrlRes.json()) as { controller: { id: string } };

    // Create two rooms in the user's home
    const mkRoom = async (name: string) => {
      const res = await req("/api/homes/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userCookie },
        body: JSON.stringify({ homeId: home.id, name }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { room: { id: string } };
      return body.room.id;
    };
    const roomA = await mkRoom("Room A");
    const roomB = await mkRoom("Room B");

    // Assign
    const assignRes = await req(`/api/board-instances/${controller.id}/room`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ roomId: roomA }),
    });
    expect(assignRes.status).toBe(200);
    const assigned = (await assignRes.json()) as { controller: { room_id: string | null } };
    expect(assigned.controller.room_id).toBe(roomA);

    // Change assignment
    const changeRes = await req(`/api/board-instances/${controller.id}/room`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ roomId: roomB }),
    });
    expect(changeRes.status).toBe(200);
    const changed = (await changeRes.json()) as { controller: { room_id: string | null } };
    expect(changed.controller.room_id).toBe(roomB);

    // Reflected in the controllers list
    const listRes = await req("/api/board-instances", { headers: { Cookie: userCookie } });
    const { controllers } = (await listRes.json()) as {
      controllers: Array<{ id: string; room_id: string | null }>;
    };
    expect(controllers.find((c) => c.id === controller.id)?.room_id).toBe(roomB);

    // Cross-account room is rejected
    const otherCookie = await registerUser(req, "room-outsider@example.com", "Other Lab");
    const otherHomesRes = await req("/api/homes", { headers: { Cookie: otherCookie } });
    const { homes: otherHomes } = (await otherHomesRes.json()) as {
      homes: Array<{ id: string }>;
    };
    const otherRoomRes = await req("/api/homes/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: otherCookie },
      body: JSON.stringify({ homeId: otherHomes[0]!.id, name: "Foreign Room" }),
    });
    expect(otherRoomRes.status).toBe(201);
    const { room: foreignRoom } = (await otherRoomRes.json()) as { room: { id: string } };
    const foreignAssign = await req(`/api/board-instances/${controller.id}/room`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ roomId: foreignRoom.id }),
    });
    expect(foreignAssign.status).toBe(400);

    // Invalid payload rejected
    const badRes = await req(`/api/board-instances/${controller.id}/room`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ roomId: "not-a-uuid" }),
    });
    expect(badRes.status).toBe(400);

    // Remove assignment
    const removeRes = await req(`/api/board-instances/${controller.id}/room`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ roomId: null }),
    });
    expect(removeRes.status).toBe(200);
    const removed = (await removeRes.json()) as { controller: { room_id: string | null } };
    expect(removed.controller.room_id).toBeNull();
  });
});
