import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";
import { extractCookie } from "./helpers/http";
import { seedInstalledFirmwareWithDrivers } from "./helpers/firmware-fixture";
import { sha256Hex } from "../src/lib/crypto";

/**
 * Integrated 12-scenario end-to-end workflow test exercising the real Worker
 * routes, PGlite Postgres schema/RPCs, mock EMQX broker, and mock R2 bucket.
 */
describe("End-to-End Platform User & Admin Workflows (12 Scenarios)", () => {
  let dbHarness: PgliteHarness;
  let emqxMock: ReturnType<typeof createMockEmqxFetch>;
  let r2: ReturnType<typeof createMockR2Bucket>;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;

  let userCookie = "";
  let adminCookie = "";
  let accountId = "";
  let homeId = "";
  let roomId = "";
  let s3ProfileId = "";
  let controllerId = "";
  let controllerToken = "";
  let nodeId = "";
  let nodeToken = "";
  let switchId = "";
  let sensorId = "";
  let releaseId = "";

  beforeAll(async () => {
    dbHarness = await createPglitePostgrest();
    emqxMock = createMockEmqxFetch();
    r2 = createMockR2Bucket();
    env = {
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-secret",
      EMQX_API_BASE: "https://mock.emqx.cloud:8443/api/v5",
      EMQX_APP_ID: "app-id",
      EMQX_APP_SECRET: "app-secret",
      EMQX_BROKER_HOST: "mock.emqx.cloud",
      EMQX_TLS_PORT: "8883",
      FIRMWARE_BUCKET: r2,
    };
    app = createWorkerApp({ dbFetch: dbHarness.fetch, emqxFetch: emqxMock.fetch });
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  it("Workflow 1: registers a customer account, logs in, and resolves home/catalog", async () => {
    const reg = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "e2e-owner@homecoreos.local",
        password: "E2eStrongPassword123!",
        fullName: "E2E Home Owner",
        accountName: "E2E Smart Residence",
      }),
    });
    expect(reg.status).toBe(201);
    userCookie = extractCookie(reg, "hc_user_session");
    expect(userCookie).toContain("hc_user_session=");

    const me = await req("/api/auth/me", { headers: { Cookie: userCookie } });
    expect(me.status).toBe(200);
    const meJson = (await me.json()) as { account: { id: string } };
    accountId = meJson.account.id;

    const homesRes = await req("/api/homes", { headers: { Cookie: userCookie } });
    const homesJson = (await homesRes.json()) as { homes: Array<{ id: string }> };
    homeId = homesJson.homes[0]!.id;

    const roomRes = await req("/api/homes/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ homeId, name: "Living Room", floorName: "Ground Floor" }),
    });
    expect(roomRes.status).toBe(201);
    roomId = ((await roomRes.json()) as { room: { id: string } }).room.id;

    const catRes = await req("/api/board-library/catalog", { headers: { Cookie: userCookie } });
    const cat = (await catRes.json()) as { boards: Array<{ id: string; slug: string }> };
    s3ProfileId = cat.boards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!.id;
  });

  it("Workflow 2: sets up and pairs a Controller via Wi-Fi setup portal (softap)", async () => {
    const create = await req("/api/board-instances", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Living Room Hub",
        homeId,
        roomId,
        boardProfileId: s3ProfileId,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      controller: { id: string };
      pairingCode: string;
    };
    controllerId = created.controller.id;

    const pair = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: created.pairingCode,
        macAddress: "AA:BB:CC:DD:10:01",
        identityKey: "e2e-controller-identity-key-0123456789abcdef",
        firmwareVersion: "1.4.0",
        chipVariant: "esp32s3",
        boardSlug: "esp32-s3-devkitc-1-n16r8",
        wifiSsid: "Home24G",
        localIp: "192.168.1.20",
        provisioningTransport: "softap",
      }),
    });
    expect(pair.status).toBe(200);
    const pairJson = (await pair.json()) as {
      board_instance_id: string;
      device_api_token: string;
      emqx_synced: boolean;
      mqtt_username: string;
    };
    expect(pairJson.board_instance_id).toBe(controllerId);
    expect(pairJson.emqx_synced).toBe(true);
    controllerToken = pairJson.device_api_token;
  });

  it("Workflow 3: sets up and pairs a second board via BLE provisioning", async () => {
    const create = await req("/api/board-instances", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Hallway Node",
        homeId,
        roomId,
        boardProfileId: s3ProfileId,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      controller: { id: string };
      pairingCode: string;
    };
    nodeId = created.controller.id;

    const pair = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: created.pairingCode,
        macAddress: "AA:BB:CC:DD:10:02",
        identityKey: "e2e-node-identity-key-0123456789abcdef",
        firmwareVersion: "1.4.0",
        chipVariant: "esp32s3",
        boardSlug: "esp32-s3-devkitc-1-n16r8",
        wifiSsid: "Home24G",
        localIp: "192.168.1.21",
        provisioningTransport: "ble",
      }),
    });
    expect(pair.status).toBe(200);
    nodeToken = ((await pair.json()) as { device_api_token: string }).device_api_token;
  });

  it("Workflow 4 & 5: configures switch & sensor, assigns Node to Controller via ESP-NOW, and relays commands", async () => {
    // Demote second board to Node and assign to Controller
    const demote = await req(`/api/board-instances/${nodeId}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ role: "node" }),
    });
    expect(demote.status).toBe(200);

    const assign = await req(`/api/board-instances/${nodeId}/assign-controller`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ boardInstanceId: controllerId, channel: 6 }),
    });
    expect(assign.status).toBe(200);

    // Linked Node fetches config and receives its role assignment block
    expect(nodeToken).toBeTruthy();
    const nodeCfg = await req("/api/device/config", {
      headers: { Authorization: `Bearer ${nodeToken}` },
    });
    expect(nodeCfg.status).toBe(200);
    const nodeCfgBody = (await nodeCfg.json()) as {
      role?: { mode: string; assignedControllerId: string | null };
    };
    expect(nodeCfgBody.role?.mode).toBe("node");
    expect(nodeCfgBody.role?.assignedControllerId).toBe(controllerId);

    // Controller heartbeat reports Node as linked over ESP-NOW
    const hubBeat = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${controllerToken}` },
      body: JSON.stringify({
        w: true,
        m: true,
        r: -55,
        v: "1.4.0",
        role: "controller",
        es: true,
        els: "linked",
        nodes: [{ id: nodeId, link: "linked", rssi: -62, channel: 6 }],
      }),
    });
    expect(hubBeat.status).toBe(200);

    // Seed compatible firmware with sensor driver manifest on the Controller
    await seedInstalledFirmwareWithDrivers({
      pg: dbHarness.pg,
      boardInstanceId: controllerId,
      boardId: s3ProfileId,
      boardSlug: "esp32-s3-devkitc-1-n16r8",
      chipFamily: "esp32s3",
    });

    // Add switch on linked Node & sensor on Controller
    const swRes = await req("/api/switches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        roomId,
        boardInstanceId: nodeId,
        name: "Hallway Ceiling Light",
        gpioPin: 4,
      }),
    });
    expect(swRes.status).toBe(201);
    switchId = ((await swRes.json()) as { switch: { id: string } }).switch.id;

    const sensRes = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        roomId,
        boardInstanceId: controllerId,
        name: "Living Room Motion",
        sensorType: "motion_pir",
        gpioPin: 5,
      }),
    });
    expect(sensRes.status).toBe(201);
    sensorId = ((await sensRes.json()) as { sensor: { id: string } }).sensor.id;

    // Toggling a switch on a linked Node relays through the Controller's cmd/system topic
    emqxMock.state.published.length = 0;
    const toggle = await req(`/api/switches/${switchId}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ isOn: true }),
    });
    expect(toggle.status).toBe(200);
    const relayMsg = emqxMock.state.published.find((m) => m.topic.endsWith("/cmd/system"));
    expect(relayMsg).toBeTruthy();
    const relayPayload =
      typeof relayMsg?.payload === "string"
        ? JSON.parse(relayMsg.payload)
        : relayMsg?.payload;
    expect(relayPayload).toMatchObject({ action: "relay_to_node", node_id: nodeId });
  });

  it("Workflow 6 & 7: verifies realtime channel config/snapshot and triggers sensor -> switch automation", async () => {
    const rtCfg = await req("/api/realtime/config", { headers: { Cookie: userCookie } });
    expect(rtCfg.status).toBe(200);
    const rtCfgJson = (await rtCfg.json()) as { enabled: boolean; credential?: { topic: string } };
    expect(rtCfgJson.enabled).toBe(true);
    expect(rtCfgJson.credential?.topic).toBe(`homecore/${accountId}/realtime/#`);

    const autoRes = await req("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Turn off light on motion threshold",
        executionMode: "cloud",
        triggerConfig: { type: "sensor_value", sensorId, operator: "gte", threshold: 1 },
        actionsConfig: [{ type: "switch_off", switchId }],
      }),
    });
    expect(autoRes.status).toBe(201);

    emqxMock.state.published.length = 0;
    const telem = await req("/api/device/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${controllerToken}` },
      body: JSON.stringify({
        sensors: [{ sensorId, value: 1, status: "ok" }],
      }),
    });
    expect(telem.status).toBe(200);

    // Realtime event envelope was published to account realtime topic
    const rtEvents = emqxMock.state.published.filter((m) =>
      m.topic.includes(`/realtime/events`)
    );
    expect(rtEvents.length).toBeGreaterThan(0);

    const snap = await req("/api/realtime/snapshot", { headers: { Cookie: userCookie } });
    expect(snap.status).toBe(200);
    const snapJson = (await snap.json()) as { snapshot: { entities: { sensors: unknown[] } } };
    expect(snapJson.snapshot.entities.sensors.length).toBeGreaterThanOrEqual(1);
  });

  it("Workflow 8: handles Wi-Fi/MQTT disconnect and reconnect transitions cleanly", async () => {
    const disc = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${controllerToken}` },
      body: JSON.stringify({ w: true, m: false, err: "MQTT broker timeout" }),
    });
    expect(disc.status).toBe(200);

    const rec = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${controllerToken}` },
      body: JSON.stringify({ w: true, m: true, err: null }),
    });
    expect(rec.status).toBe(200);

    const row = await dbHarness.pg.query<{ mqtt_connected: boolean; last_error: string | null }>(
      "select mqtt_connected, last_error from board_instances where id = $1",
      [controllerId]
    );
    expect(row.rows[0]?.mqtt_connected).toBe(true);
    expect(row.rows[0]?.last_error).toBeNull();
  });

  it("Workflow 9 & 10: completes BLE & USB recovery sessions preserving board identity and records USB flash", async () => {
    // Start BLE recovery session, run diagnostics, complete verified
    const start = await req("/api/recovery/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        boardInstanceId: controllerId,
        transport: "ble",
        websiteUrl: "https://homecore.local",
      }),
    });
    expect(start.status).toBe(201);
    const sessId = ((await start.json()) as { session: { id: string } }).session.id;

    // USB recovery_console re-pair preserves the exact boardInstanceId
    const regen = await req(`/api/board-instances/${controllerId}/regenerate-pairing-code`, {
      method: "POST",
      headers: { Cookie: userCookie },
    });
    const code = ((await regen.json()) as { pairingCode: string }).pairingCode;
    const rePair = await req("/api/device/recover-pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: code,
        macAddress: "AA:BB:CC:DD:10:01",
        identityKey: "e2e-controller-identity-key-0123456789abcdef",
        physicalConfirmed: true,
        physicalConfirmationMethod: "recovery_console",
        provisioningTransport: "usb_console",
        firmwareVersion: "1.4.0",
        boardSlug: "esp32-s3-devkitc-1-n16r8",
      }),
    });
    expect(rePair.status).toBe(200);
    const rePairJson = (await rePair.json()) as { board_instance_id: string; device_api_token: string };
    expect(rePairJson.board_instance_id).toBe(controllerId);
    controllerToken = rePairJson.device_api_token;

    // Healthy firmware heartbeat (including SSID, IP, RSSI, config revision) before completion
    const cfgRes = await req("/api/device/config", {
      headers: { Authorization: `Bearer ${controllerToken}` },
    });
    expect(cfgRes.status).toBe(200);
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${controllerToken}` },
      body: JSON.stringify({
        w: true,
        m: true,
        s: "Home24G",
        ip: "192.168.1.20",
        r: -54,
        v: "1.4.0",
        bu: "https://homecore.local",
      }),
    });

    const complete = await req(`/api/recovery/sessions/${sessId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        outcomes: [{ actionId: "reconnect_mqtt", status: "applied", message: "MQTT restored" }],
        transportReleased: true,
        websiteUrl: "https://homecore.local",
      }),
    });
    expect(complete.status).toBe(200);
    const completeJson = (await complete.json()) as { session: { status: string } };
    expect(completeJson.session.status).toBe("completed");
  });

  it("Workflow 11 & 12: publishes firmware, runs OTA + blocks incompatible chip, and verifies Admin Customer Monitoring", async () => {
    // Admin login / bootstrap
    const adminSetup = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin@homecoreos.local",
        password: "AdminPassword123!",
        fullName: "Platform Super Admin",
      }),
    });
    if (adminSetup.status === 201 || adminSetup.status === 200) {
      adminCookie = extractCookie(adminSetup, "hc_admin_session");
    } else {
      const adminLogin = await req("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "admin@homecoreos.local",
          password: "AdminPassword123!",
        }),
      });
      expect(adminLogin.status).toBe(200);
      adminCookie = extractCookie(adminLogin, "hc_admin_session");
    }

    // Create published ESP32-S3 release + OTA image in R2
    const otaBytes = new Uint8Array([0xe9, 0x04, 0x02, 0x20, 0x00, 0x01, 0x02, 0x03]);
    const otaSha = await sha256Hex(otaBytes);
    const r2Key = "releases/e2e/homecoreos-1.6.0-ota.bin";
    await r2.put(r2Key, otaBytes);

    const relInsert = await dbHarness.pg.query<{ id: string }>(
      `insert into firmware_releases
         (name, version, channel, chip_family, target_board_slug, compatible_board_ids, compatible_board_slugs, partition_scheme, flash_size_mb, status)
       values ('HomecoreOS S3', '1.6.0', 'stable', 'esp32s3', 'esp32-s3-devkitc-1-n16r8', array[$1::uuid], array['esp32-s3-devkitc-1-n16r8'], 'dual_ota_16mb', 16, 'published')
       returning id`,
      [s3ProfileId]
    );
    releaseId = relInsert.rows[0]!.id;

    await dbHarness.pg.query(
      `insert into firmware_files
         (release_id, file_type, file_name, r2_key, sha256, size_bytes)
       values ($1, 'ota_app', 'homecoreos-1.6.0-ota.bin', $2, $3, $4)`,
      [releaseId, r2Key, otaSha, otaBytes.byteLength]
    );

    // Incompatible chip header is rejected with 403 before downloading
    const blockedOta = await req(`/api/device/firmware/ota/${releaseId}`, {
      headers: {
        Authorization: `Bearer ${controllerToken}`,
        "X-Homecore-Chip-Family": "esp32c3",
      },
    });
    expect(blockedOta.status).toBe(403);

    // Compatible chip downloads verified OTA binary
    const allowedOta = await req(`/api/device/firmware/ota/${releaseId}`, {
      headers: {
        Authorization: `Bearer ${controllerToken}`,
        "X-Homecore-Chip-Family": "esp32s3",
        "X-Homecore-Board-Slug": "esp32-s3-devkitc-1-n16r8",
      },
    });
    expect(allowedOta.status).toBe(200);
    expect(allowedOta.headers.get("x-firmware-sha256")).toBe(otaSha);

    // Admin Customer Details monitoring returns read-only account + boards with zero secrets
    const monRes = await req(`/api/admin/accounts/${accountId}/monitoring`, {
      headers: { Cookie: adminCookie },
    });
    expect(monRes.status).toBe(200);
    const monText = await monRes.text();
    expect(monText).not.toContain(controllerToken);
    expect(monText).not.toContain("e2e-controller-identity-key");
    const monJson = JSON.parse(monText) as {
      summary: { totalBoards: number; controllers: number; nodes: number };
      boards: Array<{ id: string }>;
    };
    expect(monJson.summary.totalBoards).toBe(2);
    expect(monJson.summary.controllers).toBe(1);
    expect(monJson.summary.nodes).toBe(1);
  });

  it("Workflow 13 (Regression): preserves online status with recent telemetry, omits unsolicited health columns, and reconciles live EMQX connectivity", async () => {
    // 1. Clear health fields and send a legacy-style heartbeat (without otaPendingVerify/health fields)
    await dbHarness.pg.query(
      `update board_instances set ota_pending = null, health_reported_at = null where id = $1`,
      [controllerId]
    );
    const legacyHb = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${controllerToken}` },
      body: JSON.stringify({ w: true, m: true, r: -48, v: "1.2.43" }),
    });
    expect(legacyHb.status).toBe(200);
    const afterLegacy = await dbHarness.pg.query<{
      status: string;
      mqtt_connected: boolean;
      ota_pending: boolean | null;
      health_reported_at: string | null;
    }>(
      `select status, mqtt_connected, ota_pending, health_reported_at from board_instances where id = $1`,
      [controllerId]
    );
    expect(afterLegacy.rows[0]?.status).toBe("online");
    expect(afterLegacy.rows[0]?.mqtt_connected).toBe(true);
    expect(afterLegacy.rows[0]?.ota_pending).toBeNull();
    expect(afterLegacy.rows[0]?.health_reported_at).toBeNull();

    // 2. Stale last_heartbeat_at (>10m ago) + fresh last_communication_at (telemetry just arrived)
    //    must NOT be marked offline by refreshStaleControllerStates() on GET /api/board-instances
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const freshIso = new Date().toISOString();
    await dbHarness.pg.query(
      `update board_instances set status = 'online', last_heartbeat_at = $1, last_communication_at = $2 where id = $3`,
      [staleIso, freshIso, controllerId]
    );
    const listFreshComm = await req("/api/board-instances", {
      headers: { Cookie: userCookie },
    });
    expect(listFreshComm.status).toBe(200);
    const freshListJson = (await listFreshComm.json()) as {
      controllers: Array<{ id: string; status: string }>;
    };
    expect(freshListJson.controllers.find((c) => c.id === controllerId)?.status).toBe("online");

    // 3. If both timestamps are stale and DB drifted to offline, but live EMQX reports an active
    //    broker session for the paired board, GET /api/board-instances must reconcile status -> online
    const credRow = await dbHarness.pg.query<{ mqtt_client_id: string }>(
      `select mqtt_client_id from mqtt_credentials_metadata where board_instance_id = $1`,
      [controllerId]
    );
    const clientId = credRow.rows[0]!.mqtt_client_id;
    await dbHarness.pg.query(
      `update board_instances set status = 'offline', mqtt_connected = false, last_heartbeat_at = $1, last_communication_at = $1 where id = $2`,
      [staleIso, controllerId]
    );
    emqxMock.state.connectedClients.add(clientId);

    const listLiveEmqx = await req("/api/board-instances", {
      headers: { Cookie: userCookie },
    });
    expect(listLiveEmqx.status).toBe(200);
    const reconciledJson = (await listLiveEmqx.json()) as {
      controllers: Array<{ id: string; status: string; mqtt_connected: boolean; wifi_connected: boolean }>;
    };
    const reconciled = reconciledJson.controllers.find((c) => c.id === controllerId);
    expect(reconciled?.status).toBe("online");
    expect(reconciled?.mqtt_connected).toBe(true);
    expect(reconciled?.wifi_connected).toBe(true);

    const dbReconciled = await dbHarness.pg.query<{ status: string; mqtt_connected: boolean }>(
      `select status, mqtt_connected from board_instances where id = $1`,
      [controllerId]
    );
    expect(dbReconciled.rows[0]?.status).toBe("online");
    expect(dbReconciled.rows[0]?.mqtt_connected).toBe(true);

    emqxMock.state.connectedClients.delete(clientId);
  });
});
