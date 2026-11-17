import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import {
  createMockEmqxFetch,
  createMockR2Bucket,
} from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";
import { seedInstalledFirmwareWithDrivers } from "./helpers/firmware-fixture";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName}`);
  return `${cookieName}=${match[1]}`;
}

describe("Action Button (Dynamic Island custom action button)", () => {
  let dbHarness: PgliteHarness;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;
  let cookie: string;
  let controllerId: string;
  let switchId1: string;
  let switchId2: string;
  let deviceId: string;

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

    const regRes = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "action-button-owner@homecoreos.local",
        password: "ActionButton123!",
        fullName: "Action Button Owner",
        accountName: "Action Button Home",
        timezone: "Asia/Dhaka",
      }),
    });
    expect(regRes.status).toBe(201);
    cookie = extractCookie(regRes, "hc_user_session");

    const catRes = await req("/api/boards/catalog", { headers: { Cookie: cookie } });
    const firstBoard = ((await catRes.json()) as {
      boards: Array<{ id: string; slug: string; chip_family: "esp32s3" }>;
    }).boards[0]!;

    const ctrlRes = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Action Hub", boardCatalogId: firstBoard.id }),
    });
    const ctrlJson = (await ctrlRes.json()) as {
      controller: { id: string };
      pairingCode: string;
    };
    controllerId = ctrlJson.controller.id;

    const pairRes = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: ctrlJson.pairingCode }),
    });
    expect(pairRes.status).toBe(200);
    await seedInstalledFirmwareWithDrivers({
      pg: dbHarness.pg,
      controllerId,
      boardId: firstBoard.id,
      boardSlug: firstBoard.slug,
      chipFamily: firstBoard.chip_family,
    });

    const sw1Res = await req("/api/switches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ controllerId, name: "Porch Light", gpioPin: 4 }),
    });
    switchId1 = ((await sw1Res.json()) as { switch: { id: string } }).switch.id;

    const sw2Res = await req("/api/switches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ controllerId, name: "Cabinet Strip", gpioPin: 5 }),
    });
    switchId2 = ((await sw2Res.json()) as { switch: { id: string } }).switch.id;

    const devRes = await req("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        controllerId,
        name: "Ceiling Fan",
        deviceType: "fan",
        gpioPin: 6,
      }),
    });
    deviceId = ((await devRes.json()) as { device: { id: string } }).device.id;
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  function postJson(path: string, body: unknown, method = "POST") {
    return req(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });
  }

  it("validates references and rejects unknown targets", async () => {
    const res = await postJson("/api/action-button/configs", {
      name: "Broken Button",
      icon: "zap",
      color: "blue",
      category: "group",
      config: {
        single: [
          {
            id: "s1",
            kind: "switch",
            switchId: "00000000-0000-0000-0000-000000000000",
            op: "toggle",
          },
        ],
        double: null,
        long: null,
      },
    });
    expect(res.status).toBe(400);

    const emptyRes = await postJson("/api/action-button/configs", {
      name: "Empty Button",
      icon: "zap",
      color: "blue",
      category: "custom",
      config: { single: [], double: null, long: null },
    });
    expect(emptyRes.status).toBe(400);

    const hugeDelay = await postJson("/api/action-button/configs", {
      name: "Slow Button",
      icon: "zap",
      color: "blue",
      category: "custom",
      config: {
        single: [{ id: "d1", kind: "delay", ms: 999_999 }],
        double: null,
        long: null,
      },
    });
    expect(hugeDelay.status).toBe(400);
  });

  it("creates, lists, activates, executes, toggles, and deletes a configuration", async () => {
    // Create global "all on" button
    const createRes = await postJson("/api/action-button/configs", {
      name: "All On",
      icon: "lightbulb",
      color: "amber",
      category: "global",
      config: {
        single: [{ id: "g1", kind: "all", target: "all", op: "on" }],
        double: null,
        long: null,
      },
      isActive: true,
      confirmationRequired: false,
    });
    expect(createRes.status).toBe(201);
    const created = ((await createRes.json()) as {
      config: { id: string; isActive: boolean };
    }).config;
    expect(created.isActive).toBe(true);

    // List shows it active with aggregate states
    const listRes = await req("/api/action-button/configs", {
      headers: { Cookie: cookie },
    });
    const listed = ((await listRes.json()) as {
      configs: Array<{
        id: string;
        name: string;
        isActive: boolean;
        states: { on: number; off: number } | null;
      }>;
    }).configs;
    const stored = listed.find((c) => c.id === created.id);
    expect(stored).toBeTruthy();
    expect(stored?.states?.on).toBe(0); // two switches + one fan, all off initially
    expect(stored?.states?.off).toBe(3);

    // Execute: turns 2 switches + 1 device ON
    const execRes = await postJson(
      `/api/action-button/configs/${created.id}/execute`,
      { gesture: "single" }
    );
    expect(execRes.status).toBe(200);
    const execJson = (await execRes.json()) as {
      ok: boolean;
      execution: {
        executedCount: number;
        failedCount: number;
        states: { on: number; off: number } | null;
        results: Array<{ status: string }>;
      };
    };
    expect(execJson.ok).toBe(true);
    expect(execJson.execution.executedCount).toBe(3);
    expect(execJson.execution.failedCount).toBe(0);
    expect(execJson.execution.states).toEqual({ on: 3, off: 0 });

    // Verify persisted intent. `is_on` is the controller-confirmed state and
    // does not flip until the device reports back, so assert on the intent.
    const swList = await req("/api/switches", { headers: { Cookie: cookie } });
    const sws = ((await swList.json()) as {
      switches: Array<{
        id: string;
        is_on: boolean;
        state_status?: string;
        desired_state?: Record<string, unknown>;
      }>;
    }).switches;
    for (const id of [switchId1, switchId2]) {
      const row = sws.find((s) => s.id === id);
      expect(row?.state_status).toBe("pending");
      expect(row?.desired_state).toEqual({ on: true });
    }
    const devList = await req("/api/devices", { headers: { Cookie: cookie } });
    const devs = ((await devList.json()) as {
      devices: Array<{
        id: string;
        state: string;
        state_status?: string;
        desired_state?: Record<string, unknown>;
      }>;
    }).devices;
    const targetDev = devs.find((d) => d.id === deviceId);
    expect(targetDev?.state_status).toBe("pending");
    expect(targetDev?.desired_state).toEqual({ state: "active" });

    // Cooldown: immediate re-execute is rejected
    const cooldownRes = await postJson(
      `/api/action-button/configs/${created.id}/execute`,
      { gesture: "single" }
    );
    expect(cooldownRes.status).toBe(429);

    // Create a second button and activate it; first must lose activation
    const create2 = await postJson("/api/action-button/configs", {
      name: "Toggle Porch",
      icon: "star",
      color: "teal",
      category: "group",
      config: {
        single: [
          { id: "t1", kind: "switch", switchId: switchId1, op: "toggle" },
        ],
        double: null,
        long: null,
      },
      isActive: true,
    });
    expect(create2.status).toBe(201);
    const secondId = ((await create2.json()) as { config: { id: string } }).config.id;

    const list2 = await req("/api/action-button/configs", {
      headers: { Cookie: cookie },
    });
    const listed2 = ((await list2.json()) as {
      configs: Array<{ id: string; isActive: boolean }>;
    }).configs;
    expect(listed2.find((c) => c.id === created.id)?.isActive).toBe(false);
    expect(listed2.find((c) => c.id === secondId)?.isActive).toBe(true);

    // Delete the second button
    const delRes = await req(`/api/action-button/configs/${secondId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(delRes.status).toBe(200);
    const list3 = await req("/api/action-button/configs", {
      headers: { Cookie: cookie },
    });
    const listed3 = ((await list3.json()) as {
      configs: Array<{ id: string }>;
    }).configs;
    expect(listed3.some((c) => c.id === secondId)).toBe(false);
  });

  it("runs an automation step from the button", async () => {
    // Ensure switches start ON, then automation turns Porch Light OFF
    await postJson(`/api/switches/${switchId1}/toggle`, { isOn: true });

    const ruleRes = await postJson("/api/automations", {
      name: "Button Scene Goodnight",
      executionMode: "cloud",
      triggerConfig: { type: "manual" },
      actionsConfig: [{ type: "switch_off", switchId: switchId1 }],
    });
    expect(ruleRes.status).toBe(201);
    const ruleId = ((await ruleRes.json()) as { automation: { id: string } }).automation.id;

    const createRes = await postJson("/api/action-button/configs", {
      name: "Goodnight",
      icon: "moon",
      color: "violet",
      category: "automation",
      config: {
        single: [{ id: "a1", kind: "automation", automationId: ruleId }],
        double: null,
        long: null,
      },
    });
    expect(createRes.status).toBe(201);
    const buttonId = ((await createRes.json()) as { config: { id: string } }).config.id;

    const execRes = await postJson(
      `/api/action-button/configs/${buttonId}/execute`,
      { gesture: "single" }
    );
    expect(execRes.status).toBe(200);
    const execJson = (await execRes.json()) as {
      ok: boolean;
      execution: { executedCount: number; failedCount: number };
    };
    expect(execJson.ok).toBe(true);
    expect(execJson.execution.failedCount).toBe(0);

    const swList = await req("/api/switches", { headers: { Cookie: cookie } });
    const sws = ((await swList.json()) as {
      switches: Array<{ id: string; is_on: boolean }>;
    }).switches;
    expect(sws.find((s) => s.id === switchId1)?.is_on).toBe(false);
  });

  it("fails gracefully when the controller is offline", async () => {
    await postJson(`/api/switches/${switchId2}/toggle`, { isOn: false });

    const createRes = await postJson("/api/action-button/configs", {
      name: "Offline Toggle",
      icon: "power",
      color: "red",
      category: "group",
      config: {
        single: [{ id: "g1", kind: "switch", switchId: switchId2, op: "on" }],
        double: null,
        long: null,
      },
    });
    const buttonId = ((await createRes.json()) as { config: { id: string } }).config.id;

    await dbHarness.pg.query(
      "UPDATE controllers SET status = 'offline' WHERE id = $1",
      [controllerId]
    );

    const execRes = await postJson(
      `/api/action-button/configs/${buttonId}/execute`,
      { gesture: "single" }
    );
    expect(execRes.status).toBe(200);
    const execJson = (await execRes.json()) as {
      ok: boolean;
      execution: {
        executedCount: number;
        failedCount: number;
        results: Array<{ status: string; error?: string }>;
        states: { on: number; off: number } | null;
      };
    };
    // Offline is no longer a failure: the intent is queued and applied when the
    // controller reconnects, so the button reports success and the command is
    // recorded as pending.
    expect(execJson.ok).toBe(true);
    expect(execJson.execution.executedCount).toBe(1);
    expect(execJson.execution.failedCount).toBe(0);

    // The safety property is unchanged and is the important one: the relay must
    // NOT be reported as flipped while the controller is unreachable.
    const swList = await req("/api/switches", { headers: { Cookie: cookie } });
    const sws = ((await swList.json()) as {
      switches: Array<{ id: string; is_on: boolean; state_status?: string; desired_state?: { on?: boolean } | null }>;
    }).switches;
    const queued = sws.find((s) => s.id === switchId2);
    expect(queued?.is_on).toBe(false);
    expect(queued?.state_status).toBe("pending");
    expect(queued?.desired_state).toEqual({ on: true });

    await dbHarness.pg.query(
      "UPDATE controllers SET status = 'online' WHERE id = $1",
      [controllerId]
    );
  });

  it("rejects double-press commands that are not configured", async () => {
    const listRes = await req("/api/action-button/configs", {
      headers: { Cookie: cookie },
    });
    const configs = ((await listRes.json()) as {
      configs: Array<{ id: string; name: string }>;
    }).configs;
    const target = configs.find((c) => c.name === "All On")!;

    const res = await postJson(
      `/api/action-button/configs/${target.id}/execute`,
      { gesture: "double" }
    );
    expect(res.status).toBe(400);
  });
});
