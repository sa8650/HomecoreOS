import { zipSync, strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import { sha256Hex } from "../src/lib/crypto";
import {
  createMockEmqxFetch,
  createMockR2Bucket,
  type MockEmqxState,
} from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName} in ${header}`);
  return `${cookieName}=${match[1]}`;
}

function makeFakeEspIdfImage(byteLength = 512): Uint8Array {
  const buf = new Uint8Array(byteLength);
  buf[0] = 0xe9; // ESP-IDF magic byte
  buf[1] = 0x04;
  return buf;
}

describe("Controller Pairing, GPIO Validation, EMQX Publish, Automation, and R2 Firmware/OTA", () => {
  let dbHarness: PgliteHarness;
  let env: WorkerBindings;
  let emqxState: MockEmqxState;
  let app: ReturnType<typeof createWorkerApp>;

  beforeAll(async () => {
    dbHarness = await createPglitePostgrest();
    const emqxMock = createMockEmqxFetch();
    emqxState = emqxMock.state;
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

  it("pairs controller atomically, enforces ESP32-S3 N16R8 GPIO rules, dispatches MQTT, evaluates automations, and serves R2 OTA/USB firmware", async () => {
    // 1. Bootstrap admin & register customer
    const bootRes = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin@homecoreos.local",
        fullName: "Admin",
        password: "AdminPassword123!",
      }),
    });
    const adminCookie = extractCookie(bootRes, "hc_admin_session");

    const regRes = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "maker@homecoreos.local",
        password: "MakerPassword123!",
        fullName: "Maker Owner",
        accountName: "Maker Lab",
      }),
    });
    const userCookie = extractCookie(regRes, "hc_user_session");

    // 2. Fetch catalog board (esp32-s3-devkitc-1-n16r8)
    const catRes = await req("/api/boards/catalog", {
      headers: { Cookie: userCookie },
    });
    const catJson = (await catRes.json()) as {
      boards: Array<{ id: string; slug: string }>;
    };
    const s3Board = catJson.boards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;
    expect(s3Board).toBeDefined();

    // 3. Create controller -> receives 6-digit pairing code
    const ctrlCreate = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Lab ESP32-S3",
        boardCatalogId: s3Board.id,
      }),
    });
    expect(ctrlCreate.status).toBe(201);
    const { controller, pairingCode } = (await ctrlCreate.json()) as {
      controller: { id: string };
      pairingCode: string;
    };
    expect(pairingCode).toMatch(/^\d{6}$/);

    // 4. Pair ESP32 via /api/device/pair -> provisions EMQX user + ACL + device token
    const pair1 = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode,
        macAddress: "AA:BB:CC:DD:EE:01",
        firmwareVersion: "1.0.0",
        wifiSsid: "HomeWiFi",
        localIp: "192.168.1.44",
      }),
    });
    expect(pair1.status).toBe(200);
    const pairPayload = (await pair1.json()) as {
      mqtt_username: string;
      mqtt_client_id: string;
      topic_prefix: string;
      device_api_token: string;
      broker_host: string;
      tls_port: number;
    };
    expect(pairPayload.broker_host).toBe("mock.emqx.cloud");
    expect(pairPayload.tls_port).toBe(8883);
    expect(emqxState.users.has(pairPayload.mqtt_username)).toBe(true);
    expect(emqxState.acls.has(pairPayload.mqtt_username)).toBe(true);

    // Single-use pairing code: second attempt MUST fail
    const pair2 = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode }),
    });
    expect(pair2.status).toBe(400);

    // 5. GPIO validation: reject Octal PSRAM GPIO35 on ESP32-S3 N16R8
    const badSwitch = await req("/api/switches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        controllerId: controller.id,
        name: "Bad Relay",
        gpioPin: 35,
      }),
    });
    expect(badSwitch.status).toBe(400);

    // Valid GPIO 4 succeeds
    const goodSwitch = await req("/api/switches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        controllerId: controller.id,
        name: "Ceiling Relay",
        gpioPin: 4,
      }),
    });
    expect(goodSwitch.status).toBe(201);
    const switchId = ((await goodSwitch.json()) as { switch: { id: string } }).switch.id;

    // Duplicate GPIO 4 on same controller MUST fail
    const dupDevice = await req("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        controllerId: controller.id,
        name: "Conflicting Pump",
        deviceType: "relay",
        gpioPin: 4,
      }),
    });
    expect(dupDevice.status).toBe(400);

    // Unsupported sensor type rejected; supported dht22 on GPIO 5 accepted
    const badSensor = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        controllerId: controller.id,
        name: "Magic Quantum Sensor",
        sensorType: "quantum_flux",
        gpioPin: 5,
      }),
    });
    expect(badSensor.status).toBe(400);

    const goodSensor = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        controllerId: controller.id,
        name: "Lab Temp",
        sensorType: "temperature_dht22",
        gpioPin: 5,
      }),
    });
    expect(goodSensor.status).toBe(201);
    const sensorId = ((await goodSensor.json()) as { sensor: { id: string } }).sensor.id;

    // 6. Toggle switch -> publishes MQTT command via EMQX REST API
    const toggleRes = await req(`/api/switches/${switchId}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ isOn: true }),
    });
    expect(toggleRes.status).toBe(200);
    expect(emqxState.published.some((p) => p.topic === `${pairPayload.topic_prefix}/cmd/switch`)).toBe(true);

    // 7. Create automation rule: if sensor > 30 -> turn switch OFF
    const autoRes = await req("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "High Temp Shutoff",
        executionMode: "cloud",
        controllerId: controller.id,
        triggerConfig: {
          type: "sensor_value",
          sensorId,
          operator: "gt",
          threshold: 30,
        },
        actionsConfig: [{ type: "switch_off", switchId }],
      }),
    });
    expect(autoRes.status).toBe(201);

    // Device reports telemetry 32.5 -> triggers automation -> turns switch OFF
    const telRes = await req("/api/device/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pairPayload.device_api_token}`,
      },
      body: JSON.stringify({
        sensors: [{ sensorId, value: 32.5 }],
      }),
    });
    expect(telRes.status).toBe(200);

    const swList = await req("/api/switches", { headers: { Cookie: userCookie } });
    const swAfter = ((await swList.json()) as { switches: Array<{ id: string; is_on: boolean }> }).switches.find(
      (s) => s.id === switchId
    );
    expect(swAfter?.is_on).toBe(false);

    // 8. Admin uploads ZIP firmware package with manifest.json -> R2 private storage -> OTA & USB download
    const otaBytes = makeFakeEspIdfImage(512);
    const factoryBytes = makeFakeEspIdfImage(1024);
    const otaSha = await sha256Hex(otaBytes);
    const factorySha = await sha256Hex(factoryBytes);

    const manifest = {
      name: "HomecoreOS Core",
      version: "1.2.0",
      channel: "stable",
      chip_family: "esp32s3",
      chip_variant: "ESP32-S3-N16R8",
      release_notes: "Initial dual-app OTA + merged USB factory release",
      compatible_board_slugs: ["esp32-s3-devkitc-1-n16r8"],
      files: [
        {
          file_type: "ota_app",
          file_name: "homecoreos-ota.bin",
          sha256: otaSha,
          flash_address: "0x10000",
          flash_mode: "dio",
          flash_freq: "80m",
          flash_size: "16MB",
        },
        {
          file_type: "usb_factory",
          file_name: "homecoreos-factory-merged.bin",
          sha256: factorySha,
          flash_address: "0x0",
          flash_mode: "dio",
          flash_freq: "80m",
          flash_size: "16MB",
        },
      ],
    };

    const zipBytes = zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "homecoreos-ota.bin": otaBytes,
      "homecoreos-factory-merged.bin": factoryBytes,
    });

    const form = new FormData();
    form.append("package", new File([zipBytes], "homecoreos-1.2.0.zip", { type: "application/zip" }));
    form.append("publish", "true");

    const pkgUpload = await req("/api/admin/firmware/package", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: form,
    });
    expect(pkgUpload.status).toBe(201);
    const pkgJson = (await pkgUpload.json()) as {
      release: { id: string };
      files: Array<{ id: string; file_type: string; sha256: string }>;
    };
    const factoryFile = pkgJson.files.find((f) => f.file_type === "usb_factory")!;

    // Customer downloads USB factory binary through authenticated Worker endpoint (no public R2 URLs)
    const dlRes = await req(`/api/firmware/files/${factoryFile.id}/download`, {
      headers: { Cookie: userCookie },
    });
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get("X-Firmware-Sha256")).toBe(factorySha);
    expect(dlRes.headers.get("X-Flash-Address")).toBe("0x0");
    const downloadedBytes = new Uint8Array(await dlRes.arrayBuffer());
    expect(downloadedBytes.byteLength).toBe(1024);

    // Start OTA -> publishes OTA command & ESP32 downloads OTA image over authenticated bearer token
    const otaStart = await req("/api/firmware/ota/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        controllerId: controller.id,
        releaseId: pkgJson.release.id,
      }),
    });
    expect(otaStart.status).toBe(201);
    expect(emqxState.published.some((p) => p.topic === `${pairPayload.topic_prefix}/ota/cmd`)).toBe(true);

    const espOtaFetch = await req(`/api/device/firmware/ota/${pkgJson.release.id}`, {
      headers: { Authorization: `Bearer ${pairPayload.device_api_token}` },
    });
    expect(espOtaFetch.status).toBe(200);
    expect(espOtaFetch.headers.get("X-Firmware-Sha256")).toBe(otaSha);

    // 9. Deleting controller revokes EMQX user and ACL rules
    const delCtrl = await req(`/api/controllers/${controller.id}`, {
      method: "DELETE",
      headers: { Cookie: userCookie },
    });
    expect(delCtrl.status).toBe(200);
    expect(emqxState.users.has(pairPayload.mqtt_username)).toBe(false);
    expect(emqxState.acls.has(pairPayload.mqtt_username)).toBe(false);
  });
});
