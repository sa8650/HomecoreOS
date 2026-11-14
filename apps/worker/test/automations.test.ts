import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeSunTimeHHMM } from "@homecoreos/shared";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import {
  createMockEmqxFetch,
  createMockR2Bucket,
} from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName}`);
  return `${cookieName}=${match[1]}`;
}

describe("Automations Engine (Switch OFF, Device Telemetry, Chaining Loop Guard, Regional Schedule, PATCH)", () => {
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

  it("fires switch OFF triggers, device telemetry triggers, prevents infinite loops, edits rules via PATCH, and evaluates regional schedules", async () => {
    const regRes = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "auto-owner@homecoreos.local",
        password: "AutoPassword123!",
        fullName: "Auto Owner",
        accountName: "Auto Home",
        timezone: "Asia/Dhaka",
      }),
    });
    expect(regRes.status).toBe(201);
    const cookie = extractCookie(regRes, "hc_user_session");

    // Pick catalog board & create + pair controller
    const catRes = await req("/api/boards/catalog", { headers: { Cookie: cookie } });
    const boardId = ((await catRes.json()) as { boards: Array<{ id: string }> }).boards[0]!.id;

    const ctrlRes = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Auto Hub", boardCatalogId: boardId }),
    });
    const ctrlJson = (await ctrlRes.json()) as {
      controller: { id: string };
      pairingCode: string;
    };

    const pairRes = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: ctrlJson.pairingCode }),
    });
    const pairJson = (await pairRes.json()) as { device_api_token: string };

    // Create two switches (GPIO4, GPIO5) and one device (GPIO6)
    const sw1Res = await req("/api/switches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        controllerId: ctrlJson.controller.id,
        name: "Main Wall Switch",
        gpioPin: 4,
      }),
    });
    const sw1Id = ((await sw1Res.json()) as { switch: { id: string } }).switch.id;

    const sw2Res = await req("/api/switches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        controllerId: ctrlJson.controller.id,
        name: "Night Lamp",
        gpioPin: 5,
      }),
    });
    const sw2Id = ((await sw2Res.json()) as { switch: { id: string } }).switch.id;

    const devRes = await req("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        controllerId: ctrlJson.controller.id,
        name: "Exhaust Fan",
        deviceType: "fan",
        gpioPin: 6,
      }),
    });
    const devId = ((await devRes.json()) as { device: { id: string } }).device.id;

    // 1. Reject invalid incomplete rule payload
    const badRes = await req("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Broken Rule",
        triggerConfig: { type: "sensor_value" },
        actionsConfig: [{ type: "switch_on" }],
      }),
    });
    expect(badRes.status).toBe(400);

    // 2. Create switch OFF trigger using string "false" -> turn Night Lamp ON
    const ruleOffRes = await req("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Night Lamp On Main Off",
        executionMode: "cloud",
        triggerConfig: {
          type: "device_state",
          switchId: sw1Id,
          expectedState: "false",
        },
        actionsConfig: [{ type: "switch_on", switchId: sw2Id }],
      }),
    });
    expect(ruleOffRes.status).toBe(201);
    const ruleOffId = ((await ruleOffRes.json()) as { automation: { id: string } }).automation.id;

    // Create opposite rule (Night Lamp ON -> Main Wall Switch ON) to ensure cycle guard terminates cleanly
    const cycleRes = await req("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Cycle Guard Test",
        executionMode: "cloud",
        triggerConfig: {
          type: "device_state",
          switchId: sw2Id,
          expectedState: true,
        },
        actionsConfig: [{ type: "switch_on", switchId: sw1Id }],
      }),
    });
    expect(cycleRes.status).toBe(201);

    // Send device telemetry reporting Main Wall Switch OFF
    const telSwitchRes = await req("/api/device/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pairJson.device_api_token}`,
      },
      body: JSON.stringify({
        switches: [{ switchId: sw1Id, isOn: false }],
      }),
    });
    expect(telSwitchRes.status).toBe(200);

    // Verify Night Lamp turned ON via Rule 1, AND Cycle Guard triggered Rule 2 turning Main back ON once without looping
    const swListAfter = await req("/api/switches", { headers: { Cookie: cookie } });
    const switches = ((await swListAfter.json()) as {
      switches: Array<{ id: string; is_on: boolean }>;
    }).switches;
    expect(switches.find((s) => s.id === sw2Id)?.is_on).toBe(true);
    expect(switches.find((s) => s.id === sw1Id)?.is_on).toBe(true);

    // 3. Edit rule via PATCH -> trigger on device state "active" -> turn Night Lamp OFF
    const patchRes = await req(`/api/automations/${ruleOffId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Lamp Off When Fan Active",
        triggerConfig: {
          type: "device_state",
          deviceId: devId,
          expectedState: "active",
        },
        actionsConfig: [{ type: "switch_off", switchId: sw2Id }],
      }),
    });
    expect(patchRes.status).toBe(200);

    // Send device telemetry reporting Exhaust Fan "active"
    const telDevRes = await req("/api/device/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pairJson.device_api_token}`,
      },
      body: JSON.stringify({
        devices: [{ deviceId: devId, state: "active" }],
      }),
    });
    expect(telDevRes.status).toBe(200);

    const swAfterDev = await req("/api/switches", { headers: { Cookie: cookie } });
    const sw2State = ((await swAfterDev.json()) as {
      switches: Array<{ id: string; is_on: boolean }>;
    }).switches.find((s) => s.id === sw2Id)?.is_on;
    expect(sw2State).toBe(false);

    // 4. Regional time schedule rule: 19:00 Asia/Dhaka = 13:00 UTC (Tuesday)
    const schedRes = await req("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Dhaka Evening Lamp",
        executionMode: "cloud",
        triggerConfig: {
          type: "time",
          cronTime: "19:00",
          days: ["tue"],
          timezone: "Asia/Dhaka",
        },
        actionsConfig: [{ type: "switch_on", switchId: sw2Id }],
      }),
    });
    expect(schedRes.status).toBe(201);

    // 2026-11-10T13:00:15Z is Tuesday 19:00:15 in Asia/Dhaka (+06:00)
    const eval1 = await req("/api/automations/evaluate-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ at: "2026-11-10T13:00:15.000Z" }),
    });
    expect(eval1.status).toBe(200);
    const eval1Json = (await eval1.json()) as { checked: number; triggered: number };
    expect(eval1Json.triggered).toBe(1);

    // Switch 2 should now be ON
    const swAfterSched = await req("/api/switches", { headers: { Cookie: cookie } });
    const sw2SchedOn = ((await swAfterSched.json()) as {
      switches: Array<{ id: string; is_on: boolean }>;
    }).switches.find((s) => s.id === sw2Id)?.is_on;
    expect(sw2SchedOn).toBe(true);

    // Re-running within the same minute must NOT double-fire
    const eval2 = await req("/api/automations/evaluate-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ at: "2026-11-10T13:00:45.000Z" }),
    });
    const eval2Json = (await eval2.json()) as { triggered: number };
    expect(eval2Json.triggered).toBe(0);

    // 7. Visual Builder flow: multi-trigger OR + grouped AND/OR conditions (room_state + time_range) + scene action + dry-run test
    const senCreate = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        controllerId: ctrlJson.controller.id,
        name: "Media Room Temp",
        sensorType: "temperature_dht22",
        gpioPin: 7,
      }),
    });
    expect(senCreate.status).toBe(201);
    const tempSensorId = ((await senCreate.json()) as { sensor: { id: string } }).sensor.id;

    const homesRes = await req("/api/homes", { headers: { Cookie: cookie } });
    const homeId = ((await homesRes.json()) as { homes: Array<{ id: string }> }).homes[0]!.id;

    const roomCreate = await req("/api/homes/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ homeId, name: "Media Lounge", icon: "sofa" }),
    });
    expect(roomCreate.status).toBe(201);
    const roomId = ((await roomCreate.json()) as { room: { id: string } }).room.id;

    // Put sw1 into Media Lounge and ensure it's ON so room_state any_on passes
    await req(`/api/switches/${sw1Id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ roomId }),
    });
    await req(`/api/switches/${sw1Id}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ isOn: true }),
    });
    await req(`/api/switches/${sw2Id}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ isOn: false }),
    });

    // Dry-run test draft before saving -> does NOT mutate sw2 or fan device
    const dryRunRes = await req("/api/automations/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Media Lounge Scene",
        executionMode: "cloud",
        triggerConfig: {
          type: "sensor_value",
          sensorId: tempSensorId,
          operator: "gte",
          threshold: 28,
          triggers: [
            { type: "sensor_value", sensorId: tempSensorId, operator: "gte", threshold: 28 },
            { type: "device_state", switchId: sw1Id, expectedState: true },
          ],
        },
        conditionsConfig: {
          logic: "AND",
          groups: [
            {
              logic: "OR",
              conditions: [
                { type: "room_state", roomId, roomMatch: "any_on" },
                { type: "switch_state", switchId: sw2Id, expectedState: true },
              ],
            },
          ],
        },
        actionsConfig: [
          {
            type: "scene",
            sceneName: "Cinema Mode",
            targets: [
              { kind: "switch", switchId: sw2Id, isOn: true },
              { kind: "device", deviceId: devId, targetState: "movie_low" },
            ],
          },
        ],
        dryRun: true,
      }),
    });
    expect(dryRunRes.status).toBe(200);
    const dryJson = (await dryRunRes.json()) as {
      conditionsMatched: boolean;
      executedCount: number;
      plannedActions: Array<{ summary: string }>;
    };
    expect(dryJson.conditionsMatched).toBe(true);
    expect(dryJson.executedCount).toBe(0);
    expect(dryJson.plannedActions).toHaveLength(2);

    // Save the visual automation rule
    const saveVisual = await req("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Media Lounge Scene",
        description: "Multi-trigger + OR group + scene",
        executionMode: "cloud",
        triggerConfig: {
          type: "sensor_value",
          sensorId: tempSensorId,
          operator: "gte",
          threshold: 28,
          triggers: [
            { type: "sensor_value", sensorId: tempSensorId, operator: "gte", threshold: 28 },
            { type: "device_state", switchId: sw1Id, expectedState: true },
          ],
        },
        conditionsConfig: {
          logic: "AND",
          groups: [
            {
              logic: "OR",
              conditions: [
                { type: "room_state", roomId, roomMatch: "any_on" },
                { type: "switch_state", switchId: sw2Id, expectedState: true },
              ],
            },
          ],
        },
        actionsConfig: [
          {
            type: "scene",
            sceneName: "Cinema Mode",
            targets: [
              { kind: "switch", switchId: sw2Id, isOn: true },
              { kind: "device", deviceId: devId, targetState: "movie_low" },
            ],
          },
        ],
      }),
    });
    expect(saveVisual.status).toBe(201);
    const visualRuleId = ((await saveVisual.json()) as { automation: { id: string } }).automation.id;

    // Live test endpoint executes scene targets via real EMQX + DB
    const liveTestRes = await req(`/api/automations/${visualRuleId}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ dryRun: false }),
    });
    expect(liveTestRes.status).toBe(200);
    const liveJson = (await liveTestRes.json()) as {
      conditionsMatched: boolean;
      executedCount: number;
    };
    expect(liveJson.conditionsMatched).toBe(true);
    expect(liveJson.executedCount).toBe(2);

    const afterSceneSw = await req("/api/switches", { headers: { Cookie: cookie } });
    const sw2AfterScene = ((await afterSceneSw.json()) as {
      switches: Array<{ id: string; is_on: boolean }>;
    }).switches.find((s) => s.id === sw2Id)?.is_on;
    expect(sw2AfterScene).toBe(true);

    // 8. Sunset solar trigger (sun_event) fires at exact computed NOAA minute
    await req(`/api/switches/${sw2Id}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ isOn: false }),
    });
    const sunsetDate = new Date("2026-11-10T11:15:00.000Z");
    const targetSunsetHhmm = computeSunTimeHHMM({
      date: sunsetDate,
      event: "sunset",
      timezone: "Asia/Dhaka",
      offsetMinutes: 0,
      latitude: 23.8103,
      longitude: 90.4125,
    });
    const [hh, mm] = targetSunsetHhmm.split(":").map(Number);
    // Asia/Dhaka is UTC+6: construct UTC timestamp matching local HH:MM
    const utcHour = (hh - 6 + 24) % 24;
    const matchUtcIso = `2026-11-10T${String(utcHour).padStart(2, "0")}:${String(mm).padStart(2, "0")}:15.000Z`;

    const sunCreate = await req("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Dhaka Sunset Porch Light",
        executionMode: "cloud",
        triggerConfig: {
          type: "sun_event",
          sunEvent: "sunset",
          offsetMinutes: 0,
          latitude: 23.8103,
          longitude: 90.4125,
          timezone: "Asia/Dhaka",
        },
        actionsConfig: [{ type: "switch_on", switchId: sw2Id }],
      }),
    });
    expect(sunCreate.status).toBe(201);

    const sunEval = await req("/api/automations/evaluate-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ at: matchUtcIso }),
    });
    expect(sunEval.status).toBe(200);
    expect(((await sunEval.json()) as { triggered: number }).triggered).toBe(1);

    // 9. Hybrid single-controller scene expands cleanly into localAutomations snapshot for offline firmware
    const hybridScene = await req("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Offline Cooling Scene",
        executionMode: "hybrid",
        triggerConfig: {
          type: "sensor_value",
          sensorId: tempSensorId,
          operator: "gt",
          threshold: 32,
        },
        actionsConfig: [
          {
            type: "scene",
            sceneName: "Cool Down",
            targets: [
              { kind: "switch", switchId: sw2Id, isOn: true },
              { kind: "device", deviceId: devId, targetState: "active" },
            ],
          },
        ],
      }),
    });
    expect(hybridScene.status).toBe(201);

    const devConfigRes = await req("/api/device/config", {
      headers: { Authorization: `Bearer ${pairJson.device_api_token}` },
    });
    expect(devConfigRes.status).toBe(200);
    const devConfigJson = (await devConfigRes.json()) as {
      localAutomations: Array<{ name: string; actions_config: Array<{ type: string }> }>;
    };
    const localSceneRule = devConfigJson.localAutomations.find(
      (r) => r.name === "Offline Cooling Scene"
    );
    expect(localSceneRule).toBeDefined();
    expect(localSceneRule?.actions_config).toHaveLength(2);
    expect(localSceneRule?.actions_config.map((a) => a.type)).toEqual([
      "switch_on",
      "device_state",
    ]);

    // 10. Device command state sync precision: semantic "active"/"inactive" preserved across generic "on"/"off" telemetry
    const setActiveRes = await req(`/api/devices/${devId}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ state: "active" }),
    });
    expect(setActiveRes.status).toBe(200);
    const setActiveJson = (await setActiveRes.json()) as { device: { state: string } };
    expect(setActiveJson.device.state).toBe("active");

    const telGenericOn = await req("/api/device/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pairJson.device_api_token}`,
      },
      body: JSON.stringify({
        devices: [{ deviceId: devId, state: "on" }],
      }),
    });
    expect(telGenericOn.status).toBe(200);

    const overviewAfterOn = await req("/api/homes/overview", { headers: { Cookie: cookie } });
    const overviewJson = (await overviewAfterOn.json()) as {
      devices: Array<{ id: string; state: string }>;
      summary: { activeDevices: number };
    };
    expect(overviewJson.devices.find((d) => d.id === devId)?.state).toBe("active");
    expect(overviewJson.summary.activeDevices).toBe(1);

    const setInactiveRes = await req(`/api/devices/${devId}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ state: "inactive" }),
    });
    expect(setInactiveRes.status).toBe(200);
    const overviewAfterOff = await req("/api/homes/overview", { headers: { Cookie: cookie } });
    const overviewOffJson = (await overviewAfterOff.json()) as {
      devices: Array<{ id: string; state: string }>;
      summary: { activeDevices: number };
    };
    expect(overviewOffJson.devices.find((d) => d.id === devId)?.state).toBe("inactive");
    expect(overviewOffJson.summary.activeDevices).toBe(0);
  });
});
