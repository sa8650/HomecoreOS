import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerApp } from "../src/index";
import type { WorkerBindings } from "../src/config/env";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName} in ${header}`);
  return `${cookieName}=${match[1]}`;
}

describe("Regional Timezone Inheritance, 2D Floor Plan Geometry, and Hardware Room Reassignment", () => {
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

  it("supports platform default timezone inheritance, user/admin overrides, connected floor-plan placement, and room reassignment", async () => {
    // 1. Bootstrap admin
    const bootRes = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "tzadmin@homecoreos.local",
        fullName: "TZ Admin",
        password: "AdminPassword123!",
      }),
    });
    expect(bootRes.status).toBe(201);
    const adminCookie = extractCookie(bootRes, "hc_admin_session");

    // 2. Super admin updates platform default timezone to Asia/Dhaka
    const setSettings = await req("/api/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ default_timezone: "Asia/Dhaka" }),
    });
    expect(setSettings.status).toBe(200);
    const settingsJson = (await setSettings.json()) as {
      settings: { default_timezone: string };
    };
    expect(settingsJson.settings.default_timezone).toBe("Asia/Dhaka");

    // Reject invalid timezone
    const badSettings = await req("/api/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ default_timezone: "Invalid/Mars_Zone" }),
    });
    expect(badSettings.status).toBe(400);

    // 3. Register customer without explicit timezone -> inherits platform default Asia/Dhaka
    const regUser = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "tzuser@example.com",
        password: "UserPassword123!",
        fullName: "Time User",
        accountName: "Dhaka Home",
      }),
    });
    expect(regUser.status).toBe(201);
    const regJson = (await regUser.json()) as {
      user: { timezone: string | null };
      platformDefaultTimezone: string;
      effectiveTimezone: string;
    };
    expect(regJson.user.timezone).toBeNull();
    expect(regJson.platformDefaultTimezone).toBe("Asia/Dhaka");
    expect(regJson.effectiveTimezone).toBe("Asia/Dhaka");
    const userCookie = extractCookie(regUser, "hc_user_session");

    // Built-in avatars persist on the user profile and arbitrary uploads/values are rejected.
    const avatarPatch = await req("/api/auth/profile", {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ avatarSeed: "homecore-3" }),
    });
    expect(avatarPatch.status).toBe(200);
    const avatarMe = await req("/api/auth/me", { headers: { Cookie: userCookie } });
    expect(((await avatarMe.json()) as { user: { avatarSeed: string | null } }).user.avatarSeed).toBe("homecore-3");
    const invalidAvatar = await req("/api/auth/profile", {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ avatarSeed: "https://example.com/upload.png" }),
    });
    expect(invalidAvatar.status).toBe(400);
    const clearAvatar = await req("/api/auth/profile", {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ avatarSeed: null }),
    });
    expect(clearAvatar.status).toBe(200);
    // User overrides personal timezone to America/New_York
    const patchProfile = await req("/api/auth/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ timezone: "America/New_York" }),
    });
    expect(patchProfile.status).toBe(200);
    const meAfter = await req("/api/auth/me", { headers: { Cookie: userCookie } });
    const meJson = (await meAfter.json()) as {
      user: { timezone: string | null };
      effectiveTimezone: string;
    };
    expect(meJson.user.timezone).toBe("America/New_York");
    expect(meJson.effectiveTimezone).toBe("America/New_York");

    // Admin overrides own personal timezone to Europe/London
    const adminPatch = await req("/api/admin/auth/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ timezone: "Europe/London" }),
    });
    expect(adminPatch.status).toBe(200);
    const adminMe = await req("/api/admin/auth/me", { headers: { Cookie: adminCookie } });
    const adminMeJson = (await adminMe.json()) as {
      effectiveTimezone: string;
      platformDefaultTimezone: string;
    };
    expect(adminMeJson.platformDefaultTimezone).toBe("Asia/Dhaka");
    expect(adminMeJson.effectiveTimezone).toBe("Europe/London");

    // 4. Connected 2D floor plan auto-placement & editing
    const homesRes = await req("/api/homes", { headers: { Cookie: userCookie } });
    const homeId = ((await homesRes.json()) as { homes: Array<{ id: string }> }).homes[0]!.id;

    const r1Res = await req("/api/homes/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ homeId, name: "Living Room", roomType: "living_room" }),
    });
    expect(r1Res.status).toBe(201);
    const r1 = ((await r1Res.json()) as {
      room: { id: string; floor_x: number; floor_y: number; floor_w: number; floor_h: number };
    }).room;
    expect(r1.floor_x).toBe(0);
    expect(r1.floor_y).toBe(0);

    // Second room snaps adjacent without overlapping first room
    const r2Res = await req("/api/homes/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ homeId, name: "Kitchen", roomType: "kitchen" }),
    });
    expect(r2Res.status).toBe(201);
    const r2 = ((await r2Res.json()) as {
      room: { id: string; floor_x: number; floor_y: number; floor_w: number; floor_h: number };
    }).room;
    const overlaps =
      r2.floor_x < r1.floor_x + r1.floor_w &&
      r2.floor_x + r2.floor_w > r1.floor_x &&
      r2.floor_y < r1.floor_y + r1.floor_h &&
      r2.floor_y + r2.floor_h > r1.floor_y;
    expect(overlaps).toBe(false);

    // Update room geometry and layoutConfig
    const r2Patch = await req(`/api/homes/rooms/${r2.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        floorX: 380,
        floorY: 20,
        floorW: 340,
        floorH: 260,
        layoutConfig: {
          floorStyle: "tile",
          doors: [{ id: "d1", wall: "left", offset: 0.5, width: 48 }],
          windows: [{ id: "w1", wall: "top", offset: 0.5, width: 80 }],
        },
      }),
    });
    expect(r2Patch.status).toBe(200);
    const r2Updated = ((await r2Patch.json()) as {
      room: { floor_x: number; layout_config: { floorStyle: string } };
    }).room;
    expect(r2Updated.floor_x).toBe(380);
    expect(r2Updated.layout_config.floorStyle).toBe("tile");

    // 5. Hardware room reassignment via PATCH /api/{switches,devices,sensors}/:id
    const boardsRes = await req("/api/boards/catalog", { headers: { Cookie: userCookie } });
    const boardId = ((await boardsRes.json()) as { boards: Array<{ id: string }> }).boards[0]!.id;
    const ctrlRes = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ name: "Floorplan Hub", boardCatalogId: boardId, homeId }),
    });
    const ctrlId = ((await ctrlRes.json()) as { controller: { id: string } }).controller.id;

    const swRes = await req("/api/switches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ controllerId: ctrlId, name: "Pendant Light", gpioPin: 4 }),
    });
    const swId = ((await swRes.json()) as { switch: { id: string } }).switch.id;

    const swAssign = await req(`/api/switches/${swId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ roomId: r2.id }),
    });
    expect(swAssign.status).toBe(200);
    const swUpdated = ((await swAssign.json()) as { switch: { room_id: string } }).switch;
    expect(swUpdated.room_id).toBe(r2.id);
  });
});
