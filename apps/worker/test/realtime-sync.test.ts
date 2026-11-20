import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import {
  buildRealtimeTopic,
  makeRealtimeEvent,
  publishRealtimeEvents,
  REALTIME_MAX_EVENTS_PER_MESSAGE,
} from "../src/lib/realtime";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";
import { seedInstalledFirmwareWithDrivers } from "./helpers/firmware-fixture";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName} in ${header}`);
  return `${cookieName}=${match[1]}`;
}

interface RealtimeEnvelopeLike {
  v: number;
  accountId: string;
  sentAt: string;
  events: Array<{
    entity: string;
    action: string;
    id: string;
    ts: string;
    phase?: string;
    version?: string;
    patch?: Record<string, unknown>;
  }>;
}

describe("Global real-time synchronization channel", () => {
  let dbHarness: PgliteHarness;
  let emqxMock: ReturnType<typeof createMockEmqxFetch>;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;

  let userCookie: string;
  let accountId: string;
  let controllerId: string;
  let switchId: string;
  let deviceId: string;
  let sensorId: string;
  let deviceToken: string;
  let topicPrefix: string;
  let userId: string;
  let otherAccountId: string;

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
    app = createWorkerApp({ dbFetch: dbHarness.fetch, emqxFetch: emqxMock.fetch });
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  function req(path: string, init?: RequestInit): Promise<Response> {
    return Promise.resolve(app.fetch(new Request(`https://homecore.local${path}`, init), env));
  }

  function realtimeMessages(): RealtimeEnvelopeLike[] {
    return emqxMock.state.published
      .filter((message) => message.topic.includes("/realtime/events"))
      .map((message) => JSON.parse(message.payload) as RealtimeEnvelopeLike);
  }

  it("bootstraps a paired controller with one switch, device and sensor", async () => {
    const regRes = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "realtime-owner@example.com",
        password: "Password123!",
        fullName: "Realtime Owner",
        accountName: "Realtime Lab",
      }),
    });
    expect(regRes.status).toBe(201);
    userCookie = extractCookie(regRes, "hc_user_session");

    const meRes = await req("/api/auth/me", { headers: { Cookie: userCookie } });
    const me = (await meRes.json()) as { account: { id: string }; user: { id: string } };
    accountId = me.account.id;
    userId = me.user.id;

    const boardsRes = await req("/api/board-library/catalog", {
      headers: { Cookie: userCookie },
    });
    const { boards } = (await boardsRes.json()) as {
      boards: Array<{ id: string; slug: string; chip_family: string }>;
    };
    const s3Board = boards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;

    const ctrlRes = await req("/api/board-instances", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ name: "Realtime Hub", boardProfileId: s3Board.id }),
    });
    expect(ctrlRes.status).toBe(201);
    const created = (await ctrlRes.json()) as {
      controller: { id: string };
      pairingCode: string;
    };
    controllerId = created.controller.id;

    const pairRes = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: created.pairingCode,
        macAddress: "AA:BB:CC:DD:EE:99",
        firmwareVersion: "1.4.0",
        boardSlug: s3Board.slug,
        chipVariant: "esp32s3",
        flashSizeMb: 16,
        psramSizeMb: 8,
      }),
    });
    expect(pairRes.status).toBe(200);
    const pair = (await pairRes.json()) as {
      device_api_token: string;
      topic_prefix: string;
    };
    deviceToken = pair.device_api_token;
    topicPrefix = pair.topic_prefix;

    const seeded = await seedInstalledFirmwareWithDrivers({
      pg: dbHarness.pg,
      boardInstanceId: controllerId,
      boardId: s3Board.id,
      boardSlug: s3Board.slug,
      chipFamily: "esp32s3",
      version: "1.4.0",
      driverIds: ["bme280"],
    });
    await dbHarness.pg.query(
      `UPDATE public.board_instances SET installed_firmware_release_id = $1 WHERE id = $2`,
      [seeded.releaseId, controllerId]
    );

    const switchRes = await req("/api/switches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        boardInstanceId: controllerId,
        name: "Desk Lamp",
        gpioPin: 4,
      }),
    });
    expect(switchRes.status).toBe(201);
    switchId = ((await switchRes.json()) as { switch: { id: string } }).switch.id;

    const deviceRes = await req("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        boardInstanceId: controllerId,
        name: "Ceiling Fan",
        deviceType: "relay",
        gpioPin: 6,
      }),
    });
    expect(deviceRes.status).toBe(201);
    deviceId = ((await deviceRes.json()) as { device: { id: string } }).device.id;

    const sensorRes = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Living Temp",
        sensorType: "temperature_bme280",
        boardInstanceId: controllerId,
        gpioPin: null,
        i2cAddress: "0x76",
      }),
    });
    expect(sensorRes.status).toBe(201);
    sensorId = ((await sensorRes.json()) as { sensor: { id: string } }).sensor.id;
  }, 60_000);

  it("issues one subscribe-only MQTT identity per browser session", async () => {
    const res = await req("/api/realtime/config", { headers: { Cookie: userCookie } });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      enabled: boolean;
      transport: string;
      accountId: string;
      credential: {
        brokerUrl: string;
        username: string;
        password: string;
        topic: string;
        expiresAt: string;
      };
    };

    expect(payload.enabled).toBe(true);
    expect(payload.transport).toBe("mqtt-ws");
    expect(payload.accountId).toBe(accountId);
    expect(payload.credential.brokerUrl).toBe("wss://mock.emqx.cloud:8084/mqtt");
    expect(payload.credential.topic).toBe(`homecore/${accountId}/realtime/#`);
    expect(payload.credential.username.startsWith("hcweb-")).toBe(true);

    // The password is derived, never stored, and the broker user is not a superuser.
    const provisioned = emqxMock.state.users.get(payload.credential.username);
    expect(provisioned?.password).toBe(payload.credential.password);
    expect(provisioned?.is_superuser).toBe(false);

    // Subscribe-only, account-scoped ACL: it can never publish or see devices.
    const rules = emqxMock.state.acls.get(payload.credential.username) as Array<{
      permission: string;
      action: string;
      topic: string;
    }>;
    expect(rules).toEqual([
      { permission: "allow", action: "subscribe", topic: `homecore/${accountId}/realtime/#` },
      { permission: "deny", action: "all", topic: "#" },
    ]);
    expect(rules.some((rule) => rule.action === "publish" && rule.permission === "allow")).toBe(false);

    // Re-opening the console reuses the identity: one EMQX write per sign-in.
    const writesBefore = emqxMock.state.userWrites.filter(
      (username) => username === payload.credential.username
    ).length;
    const second = await req("/api/realtime/config", { headers: { Cookie: userCookie } });
    const secondPayload = (await second.json()) as { credential: { username: string } };
    expect(secondPayload.credential.username).toBe(payload.credential.username);
    expect(
      emqxMock.state.userWrites.filter(
        (username) => username === payload.credential.username
      ).length
    ).toBe(writesBefore);
  });

  it("publishes one account-scoped envelope per user action", async () => {
    const before = realtimeMessages().length;
    const toggleRes = await req(`/api/switches/${switchId}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ isOn: true }),
    });
    expect(toggleRes.status).toBe(200);

    const messages = realtimeMessages().slice(before);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.accountId).toBe(accountId);
    expect(messages[0]!.v).toBe(1);
    const switchEvent = messages[0]!.events.find(
      (event) => event.entity === "switch" && event.id === switchId
    );
    expect(switchEvent?.phase).toBe("accepted");
    expect(switchEvent?.patch?.isOn).toBe(true);

    // The same message travels on the documented topic. A low-volume state
    // change is acknowledged (QoS 1); nothing is retained.
    const published = emqxMock.state.published.filter(
      (message) => message.topic === buildRealtimeTopic(accountId)
    );
    expect(published.length).toBeGreaterThan(0);
    expect(published.at(-1)!.qos).toBe(1);

    // The device command itself still goes to the controller's own topic.
    expect(
      emqxMock.state.published.some((message) => message.topic === `${topicPrefix}/cmd/switch`)
    ).toBe(true);
  });

  it("confirms hardware state from telemetry and suppresses unchanged readings", async () => {
    const telemetry = (body: Record<string, unknown>) =>
      req("/api/device/telemetry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deviceToken}`,
        },
        body: JSON.stringify(body),
      });

    const before = realtimeMessages().length;
    const first = await telemetry({
      sensors: [{ sensorId, value: 21.5, status: "ok", driverId: "bme280" }],
      switches: [{ switchId, isOn: true }],
    });
    expect(first.status).toBe(200);

    const firstEvents = realtimeMessages()
      .slice(before)
      .flatMap((message) => message.events);
    const sensorEvent = firstEvents.find(
      (event) => event.entity === "sensor" && event.id === sensorId
    );
    expect(sensorEvent?.phase).toBe("confirmed");
    expect(sensorEvent?.patch?.value).toBe(21.5);
    // Report is coalesced into exactly one MQTT message even with two entities,
    // and because it carries sensor telemetry it stays QoS 0.
    expect(realtimeMessages().length - before).toBe(1);
    const telemetryMessages = emqxMock.state.published.filter(
      (message) => message.topic === buildRealtimeTopic(accountId)
    );
    expect(telemetryMessages.at(-1)!.qos).toBe(0);
    // The reported switch state did not change, so no switch event is emitted.
    expect(firstEvents.some((event) => event.entity === "switch")).toBe(false);

    // A repeat with the same value inside the freshness window publishes nothing.
    const beforeRepeat = realtimeMessages().length;
    await telemetry({ sensors: [{ sensorId, value: 21.5, status: "ok", driverId: "bme280" }] });
    expect(realtimeMessages().length).toBe(beforeRepeat);
  });

  it("marks a command as confirmed only after hardware reports it", async () => {
    // Turn the lamp off through the API: accepted, not confirmed.
    const before = realtimeMessages().length;
    await req(`/api/switches/${switchId}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ isOn: false }),
    });
    const accepted = realtimeMessages()
      .slice(before)
      .flatMap((message) => message.events)
      .find((event) => event.entity === "switch");
    expect(accepted?.phase).toBe("accepted");
    expect(accepted?.patch?.isOn).toBe(false);

    // Device reports OFF -> confirmed event, even though the DB value already matched.
    const deviceBefore = realtimeMessages().length;
    await req("/api/device/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({ switches: [{ switchId, isOn: false }] }),
    });
    expect(realtimeMessages().length).toBe(deviceBefore);
  });

  it("reports a device command with a desired/accepted phase and never as confirmed", async () => {
    const before = realtimeMessages().length;
    const res = await req(`/api/devices/${deviceId}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ state: "active" }),
    });
    expect(res.status).toBe(200);
    const event = realtimeMessages()
      .slice(before)
      .flatMap((message) => message.events)
      .find((item) => item.entity === "device" && item.id === deviceId);
    expect(event).toBeDefined();
    expect(["accepted", "desired"]).toContain(event!.phase);
    expect(event!.phase).not.toBe("confirmed");
  });

  it("pushes ONLINE/OFFLINE transitions but not steady heartbeats", async () => {
    await dbHarness.pg.query(
      `UPDATE public.board_instances SET status = 'offline' WHERE id = $1`,
      [controllerId]
    );

    const before = realtimeMessages().length;
    const heartbeat = await req("/api/device/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({ wifiConnected: true, mqttConnected: true }),
    });
    expect(heartbeat.status).toBe(200);
    const onlineEvent = realtimeMessages()
      .slice(before)
      .flatMap((message) => message.events)
      .find((event) => event.entity === "board" && event.id === controllerId);
    expect(onlineEvent?.phase).toBe("confirmed");
    expect(onlineEvent?.patch?.status).toBe("online");

    // A steady follow-up heartbeat is written to Postgres but not broadcast as a
    // status change (a pending config sync may still publish its own event).
    const beforeSteady = realtimeMessages().length;
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({ wifiConnected: true, mqttConnected: true }),
    });
    const steadyEvents = realtimeMessages()
      .slice(beforeSteady)
      .flatMap((message) => message.events)
      .filter((event) => event.entity === "board" && event.id === controllerId);
    expect(steadyEvents.some((event) => event.action === "state")).toBe(false);

    // Heartbeat timeout -> one offline transition pushed to the console.
    await dbHarness.pg.query(
      `UPDATE public.board_instances
         SET last_heartbeat_at = now() - interval '10 minutes'
       WHERE id = $1`,
      [controllerId]
    );
    const beforeOffline = realtimeMessages().length;
    await req("/api/notifications?limit=5", { headers: { Cookie: userCookie } });
    const offlineEvent = realtimeMessages()
      .slice(beforeOffline)
      .flatMap((message) => message.events)
      .find(
        (event) =>
          event.entity === "board" &&
          event.id === controllerId &&
          event.patch?.status === "offline"
      );
    expect(offlineEvent).toBeDefined();

    // The offline notification itself is pushed too, so the bell updates live.
    const notificationEvent = realtimeMessages()
      .slice(beforeOffline)
      .flatMap((message) => message.events)
      .find((event) => event.entity === "notification");
    expect(notificationEvent).toBeDefined();
    expect(notificationEvent?.patch?.severity).toBe("warning");
  });

  it("publishes automation execution results as they happen", async () => {
    const ruleRes = await req("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Lamp follows itself off",
        executionMode: "cloud",
        triggerConfig: { type: "device_state", switchId, expectedState: false },
        actionsConfig: [{ type: "switch_on", switchId }],
      }),
    });
    expect(ruleRes.status).toBe(201);
    const ruleId = ((await ruleRes.json()) as { automation: { id: string } }).automation.id;

    const before = realtimeMessages().length;
    await req("/api/device/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({ switches: [{ switchId, isOn: false }] }),
    });

    const events = realtimeMessages()
      .slice(before)
      .flatMap((message) => message.events);
    const runEvent = events.find((event) => event.entity === "automation" && event.id === ruleId);
    expect(runEvent).toBeDefined();
    expect(runEvent?.action).toBe("run");
    expect(runEvent?.patch?.lastExecutionStatus).toBe("success");
    expect(runEvent?.version).toBe(runEvent?.patch?.lastExecutedAt);

    // The automation's own switch action is published too, so device cards
    // update immediately instead of waiting for a page reload.
    const switchEvent = events.find(
      (event) =>
        event.entity === "switch" && event.id === switchId && event.phase === "accepted"
    );
    expect(switchEvent).toBeDefined();
    expect(switchEvent?.patch?.source).toBe("automation");
    expect(switchEvent?.patch?.isOn).toBe(true);
    expect(Number.isFinite(Date.parse(switchEvent!.version!))).toBe(true);
  });

  it("publishes every switch the Dynamic Island action button actually changed", async () => {
    const createRes = await req("/api/action-button/configs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Master",
        icon: "power",
        color: "blue",
        category: "global",
        config: {
          single: [
            { id: "s1", kind: "switch", switchId, op: "off" },
            { id: "s2", kind: "device", deviceId, op: "on" },
          ],
          double: null,
          long: null,
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const actionButtonId = ((await createRes.json()) as { config: { id: string } }).config.id;

    const before = realtimeMessages().length;
    const runRes = await req(`/api/action-button/configs/${actionButtonId}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ gesture: "single" }),
    });
    expect(runRes.status).toBe(200);

    const events = realtimeMessages()
      .slice(before)
      .flatMap((message) => message.events);
    const switchState = events.find(
      (event) => event.entity === "switch" && event.id === switchId && event.phase === "accepted"
    );
    expect(switchState).toBeDefined();
    expect(switchState?.patch?.isOn).toBe(false);
    expect(switchState?.patch?.source).toBe("action_button");
    expect(Number.isFinite(Date.parse(switchState!.version!))).toBe(true);

    // A press that also targets a device publishes that device in the same pass.
    const deviceState = events.find(
      (event) => event.entity === "device" && event.id === deviceId && event.phase === "accepted"
    );
    expect(deviceState).toBeDefined();
    expect(deviceState?.patch?.source).toBe("action_button");
    expect(deviceState?.patch?.state).toBe("active");
  });

  it("splits a bulk batch across envelopes instead of dropping the tail", async () => {
    const total = REALTIME_MAX_EVENTS_PER_MESSAGE * 2 + 5;
    const events = Array.from({ length: total }, (_, index) =>
      makeRealtimeEvent("switch", "state", `bulk-${index}`, { isOn: true }, "accepted")
    );
    const before = realtimeMessages().length;
    const result = await publishRealtimeEvents(env, { emqxFetch: emqxMock.fetch }, accountId, events);
    expect(result.published).toBe(true);
    expect(result.failedChunks).toBe(0);

    const sent = realtimeMessages().slice(before);
    expect(sent).toHaveLength(3);
    expect(sent.every((message) => message.events.length <= REALTIME_MAX_EVENTS_PER_MESSAGE)).toBe(
      true
    );
    const delivered = sent.flatMap((message) => message.events.map((event) => event.id));
    expect(delivered).toHaveLength(total);
    expect(new Set(delivered).size).toBe(total);
  });

  it("publishes room edits as home events so the floor plan follows live", async () => {
    const homesRes = await req("/api/homes", { headers: { Cookie: userCookie } });
    const { homes } = (await homesRes.json()) as { homes: Array<{ id: string }> };
    const homeId = homes[0]!.id;

    const before = realtimeMessages().length;
    const roomRes = await req("/api/homes/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ homeId, name: "Workshop", roomType: "office" }),
    });
    expect(roomRes.status).toBe(201);

    const homeEvent = realtimeMessages()
      .slice(before)
      .flatMap((message) => message.events)
      .find((event) => event.entity === "home" && event.id === homeId);
    expect(homeEvent).toBeDefined();
    expect(homeEvent?.patch?.reason).toBe("rooms");
    expect(Number.isFinite(Date.parse(homeEvent!.version!))).toBe(true);

    // The snapshot reports the same version the event carried, so a reconnect
    // reconciles instead of reloading the floor plan. The publisher reads
    // `homes.updated_at` back from the row (the `set_updated_at` trigger stamps
    // the database clock, which is not the Worker's clock), so the two strings
    // must match byte for byte — never within a tolerance.
    const snapshotRes = await req("/api/realtime/snapshot", { headers: { Cookie: userCookie } });
    const { snapshot } = (await snapshotRes.json()) as {
      snapshot: { entities: { homes: Array<{ id: string; version: string }> } };
    };
    const row = snapshot.entities.homes.find((home) => home.id === homeId);
    expect(row?.version).toBe(homeEvent!.version);
  });

  it("serves a scoped version snapshot for reconnection reconciliation", async () => {
    const res = await req("/api/realtime/snapshot", { headers: { Cookie: userCookie } });
    expect(res.status).toBe(200);
    const { snapshot } = (await res.json()) as {
      snapshot: {
        v: number;
        accountId: string;
        serverTime: string;
        entities: Record<string, Array<{ id: string; version: string }>>;
      };
    };
    expect(snapshot.v).toBe(1);
    expect(snapshot.accountId).toBe(accountId);
    expect(Number.isFinite(Date.parse(snapshot.serverTime))).toBe(true);
    expect(snapshot.entities.boards!.some((row) => row.id === controllerId)).toBe(true);
    expect(snapshot.entities.switches!.some((row) => row.id === switchId)).toBe(true);
    expect(snapshot.entities.devices!.some((row) => row.id === deviceId)).toBe(true);
    expect(snapshot.entities.sensors!.some((row) => row.id === sensorId)).toBe(true);
    for (const rows of Object.values(snapshot.entities)) {
      for (const row of rows) {
        expect(Number.isFinite(Date.parse(row.version))).toBe(true);
      }
    }

    // A second account never sees the first account's entities.
    const otherReg = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "realtime-other@example.com",
        password: "Password123!",
        fullName: "Other Owner",
        accountName: "Other Lab",
      }),
    });
    const otherCookie = extractCookie(otherReg, "hc_user_session");
    const otherRes = await req("/api/realtime/snapshot", {
      headers: { Cookie: otherCookie },
    });
    const otherSnapshot = (await otherRes.json()) as {
      snapshot: { accountId: string; entities: Record<string, Array<{ id: string }>> };
    };
    otherAccountId = otherSnapshot.snapshot.accountId;
    const otherIds = Object.values(otherSnapshot.snapshot.entities)
      .flat()
      .map((row) => row.id);
    expect(otherIds).not.toContain(controllerId);
    expect(otherIds).not.toContain(switchId);
  });

  it("never reports a synchronized account when a snapshot query fails", async () => {
    const brokenApp = createWorkerApp({
      dbFetch: async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/rest/v1/board_instances")) {
          return new Response(
            JSON.stringify({ message: "connection reset by peer", code: "08006" }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
        return dbHarness.fetch(input as RequestInfo, init);
      },
      emqxFetch: emqxMock.fetch,
    });

    const res = await brokenApp.fetch(
      new Request("https://homecore.local/api/realtime/snapshot", {
        headers: { Cookie: userCookie },
      }),
      env
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { reason?: string; entity?: string };
    // A failed read is never answered with an empty entity list.
    expect(body.reason).toBe("snapshot_unavailable");
    expect(body.entity).toBe("boards");
  });

  it("moves the browser identity to the account being switched to", async () => {
    await dbHarness.pg.query(
      `INSERT INTO public.staff (account_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [otherAccountId, userId]
    );

    const firstConfig = await req("/api/realtime/config", { headers: { Cookie: userCookie } });
    const firstUsername = ((await firstConfig.json()) as { credential: { username: string } })
      .credential.username;
    expect(emqxMock.state.users.has(firstUsername)).toBe(true);

    const switchRes = await req("/api/auth/switch-account", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ accountId: otherAccountId }),
    });
    expect(switchRes.status).toBe(200);

    // The previous account's identity is gone before the new one is issued.
    expect(emqxMock.state.users.has(firstUsername)).toBe(false);

    const scopedConfig = await req("/api/realtime/config", { headers: { Cookie: userCookie } });
    const scoped = (await scopedConfig.json()) as {
      accountId: string;
      credential: { username: string; topic: string };
    };
    expect(scoped.accountId).toBe(otherAccountId);
    expect(scoped.credential.username).not.toBe(firstUsername);
    expect(scoped.credential.topic).toBe(`homecore/${otherAccountId}/realtime/#`);
    const scopedRules = emqxMock.state.acls.get(scoped.credential.username) as Array<{
      topic: string;
    }>;
    expect(scopedRules[0]!.topic).toBe(`homecore/${otherAccountId}/realtime/#`);

    // Back to the original account for the remaining assertions.
    const backRes = await req("/api/auth/switch-account", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ accountId }),
    });
    expect(backRes.status).toBe(200);
    expect(emqxMock.state.users.has(scoped.credential.username)).toBe(false);
  });

  it("revokes the broker identity of a manually revoked console session", async () => {
    const secondLogin = await req("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "realtime-owner@example.com", password: "Password123!" }),
    });
    expect(secondLogin.status).toBe(200);
    const secondCookie = extractCookie(secondLogin, "hc_user_session");

    const secondConfig = await req("/api/realtime/config", {
      headers: { Cookie: secondCookie },
    });
    const secondUsername = ((await secondConfig.json()) as { credential: { username: string } })
      .credential.username;
    expect(emqxMock.state.users.has(secondUsername)).toBe(true);

    const sessionsRes = await req("/api/auth/sessions", { headers: { Cookie: userCookie } });
    const { sessions } = (await sessionsRes.json()) as {
      sessions: Array<{ id: string; isCurrent: boolean }>;
    };
    const other = sessions.find((session) => !session.isCurrent);
    expect(other).toBeDefined();

    const revokeRes = await req(`/api/auth/sessions/${other!.id}`, {
      method: "DELETE",
      headers: { Cookie: userCookie },
    });
    expect(revokeRes.status).toBe(200);
    // Revoked sessions stop receiving private events immediately.
    expect(emqxMock.state.users.has(secondUsername)).toBe(false);
    expect(emqxMock.state.kickedClients).toContain(secondUsername);
  });

  it("revokes the broker identities of other sessions on a password change", async () => {
    const thirdLogin = await req("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "realtime-owner@example.com", password: "Password123!" }),
    });
    const thirdCookie = extractCookie(thirdLogin, "hc_user_session");
    const thirdConfig = await req("/api/realtime/config", { headers: { Cookie: thirdCookie } });
    const thirdUsername = ((await thirdConfig.json()) as { credential: { username: string } })
      .credential.username;
    expect(emqxMock.state.users.has(thirdUsername)).toBe(true);

    const currentConfig = await req("/api/realtime/config", { headers: { Cookie: userCookie } });
    const currentUsername = ((await currentConfig.json()) as { credential: { username: string } })
      .credential.username;

    const changeRes = await req("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ currentPassword: "Password123!", newPassword: "Password456!" }),
    });
    expect(changeRes.status).toBe(200);

    expect(emqxMock.state.users.has(thirdUsername)).toBe(false);
    // The session that performed the change keeps working.
    expect(emqxMock.state.users.has(currentUsername)).toBe(true);
  });

  it("revokes the browser identity on sign-out", async () => {
    const configRes = await req("/api/realtime/config", { headers: { Cookie: userCookie } });
    const { credential } = (await configRes.json()) as {
      credential: { username: string };
    };
    expect(emqxMock.state.users.has(credential.username)).toBe(true);

    const logout = await req("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: userCookie },
    });
    expect(logout.status).toBe(200);
    expect(emqxMock.state.users.has(credential.username)).toBe(false);
    expect(emqxMock.state.acls.has(credential.username)).toBe(false);

    const row = await dbHarness.pg.query<{ revoked_at: string | null }>(
      `SELECT revoked_at FROM public.realtime_web_sessions WHERE mqtt_username = $1`,
      [credential.username]
    );
    expect(row.rows[0]?.revoked_at).toBeTruthy();
  });
});
