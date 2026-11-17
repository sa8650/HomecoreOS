import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";
import { seedInstalledFirmwareWithDrivers } from "./helpers/firmware-fixture";
import { buildFirmwareDriverManifest } from "@homecoreos/shared";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName} in ${header}`);
  return `${cookieName}=${match[1]}`;
}

function makeFakeEspOtaBinary(version: string, chipId = 9): Uint8Array {
  const buf = new Uint8Array(0x100);
  buf[0] = 0xe9;
  buf[12] = chipId & 0xff;
  buf[13] = (chipId >> 8) & 0xff;
  // esp_app_desc_t magic 0xABCD5432 at 0x20
  buf[0x20] = 0x32;
  buf[0x21] = 0x54;
  buf[0x22] = 0xcd;
  buf[0x23] = 0xab;
  const verBytes = new TextEncoder().encode(version);
  buf.set(verBytes, 0x30);
  const projBytes = new TextEncoder().encode("homecoreos");
  buf.set(projBytes, 0x50);
  return buf;
}

describe("Board-Aware Sensor Drivers & Authoritative Firmware Manifest Enforcement", () => {
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

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  it("enforces board + installed firmware compatibility across controller reports, sensor CRUD, config sync, heartbeat, and error telemetry", async () => {
    // 1. Register user
    const regRes = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "sensor-owner@example.com",
        password: "Password123!",
        fullName: "Sensor Owner",
        accountName: "Sensor Lab",
      }),
    });
    expect(regRes.status).toBe(201);
    const userCookie = extractCookie(regRes, "hc_user_session");

    // 2. Lookup Home & ESP32-S3 DevKitC N16R8 board
    const homesRes = await req("/api/homes", { headers: { Cookie: userCookie } });
    expect(homesRes.status).toBe(200);
    const { homes } = (await homesRes.json()) as { homes: Array<{ id: string }> };
    const home = homes[0]!;

    const boardsRes = await req("/api/boards/catalog", { headers: { Cookie: userCookie } });
    expect(boardsRes.status).toBe(200);
    const { boards } = (await boardsRes.json()) as {
      boards: Array<{ id: string; slug: string; chip_family: string }>;
    };
    const s3Board = boards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;
    expect(s3Board).toBeTruthy();

    // 3. Create controller & pair device
    const ctrlRes = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Lab S3 Hub",
        homeId: home.id,
        boardCatalogId: s3Board.id,
      }),
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
        macAddress: "AA:BB:CC:DD:EE:42",
        firmwareVersion: "1.4.0",
        boardSlug: s3Board.slug,
        chipVariant: "esp32s3",
        flashSizeMb: 16,
        psramSizeMb: 8,
      }),
    });
    expect(pairRes.status).toBe(200);
    const pairJson = (await pairRes.json()) as { device_api_token: string };
    const deviceToken = pairJson.device_api_token;

    // 4. Before any verified firmware release exists for v1.4.0, controller has NO verified drivers
    const compatBefore = await req(`/api/controllers/${controller.id}/sensor-compatibility`, {
      headers: { Cookie: userCookie },
    });
    expect(compatBefore.status).toBe(200);
    const beforeReport = (await compatBefore.json()) as {
      compatibleSensors: unknown[];
      needsFirmwareUpdate: boolean;
    };
    expect(beforeReport.compatibleSensors).toHaveLength(0);
    expect(beforeReport.needsFirmwareUpdate).toBe(true);

    const blockedBefore = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Early Temp",
        sensorType: "temperature_bme280",
        controllerId: controller.id,
        gpioPin: null,
        i2cAddress: "0x76",
      }),
    });
    expect(blockedBefore.status).toBe(400);

    // 5. Seed a partial firmware release v1.4.0 (ONLY bme280 + pir) and send device heartbeat to auto-link
    const seededPartial = await seedInstalledFirmwareWithDrivers({
      pg: dbHarness.pg,
      controllerId: controller.id,
      boardId: s3Board.id,
      boardSlug: s3Board.slug,
      chipFamily: "esp32s3",
      version: "1.4.0",
      driverIds: ["bme280", "pir"],
    });
    // Clear link first to test heartbeat auto-linking + diagnostic hash recording
    await dbHarness.pg.query(
      `UPDATE public.controllers SET installed_firmware_release_id = NULL WHERE id = $1`,
      [controller.id]
    );

    const hbRes = await req("/api/device/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        v: "1.4.0",
        b: s3Board.slug,
        w: true,
        m: true,
        r: -55,
        dmh: "deadbeef1234",
        // Even if device tries to spoof extra drivers, backend ignores it!
        compiledDrivers: ["dht22", "ds18b20", "adc_voltage"],
      }),
    });
    expect(hbRes.status).toBe(200);

    const ctrlRow = await dbHarness.pg.query<{
      installed_firmware_release_id: string | null;
      reported_driver_manifest_hash: string | null;
    }>(
      `SELECT installed_firmware_release_id, reported_driver_manifest_hash FROM public.controllers WHERE id = $1`,
      [controller.id]
    );
    expect(ctrlRow.rows[0]?.installed_firmware_release_id).toBe(seededPartial.releaseId);
    expect(ctrlRow.rows[0]?.reported_driver_manifest_hash).toBe("deadbeef1234");

    // 6. GET /api/controllers returns batched sensor_compatibility matching ONLY bme280 + pir
    const listRes = await req("/api/controllers", { headers: { Cookie: userCookie } });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      controllers: Array<{
        id: string;
        sensor_compatibility?: {
          compatibleSensors: Array<{ sensorType: string }>;
          needsFirmwareUpdate: boolean;
        };
      }>;
    };
    const listedCtrl = listJson.controllers.find((c) => c.id === controller.id)!;
    expect(listedCtrl.sensor_compatibility?.compatibleSensors.map((s) => s.sensorType)).toEqual([
      "temperature_bme280",
      "humidity_bme280",
      "pressure_bme280",
      "motion_pir",
    ]);
    expect(listedCtrl.sensor_compatibility?.needsFirmwareUpdate).toBe(true);

    // 7. POST /api/sensors allows BME280 temp + humidity sharing 0x76, and PIR on safe GPIO 4
    const tempCreate = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Lab BME Temp",
        sensorType: "temperature_bme280",
        controllerId: controller.id,
        gpioPin: null,
        i2cAddress: "0x76",
      }),
    });
    expect(tempCreate.status).toBe(201);
    const { sensor: tempSensor } = (await tempCreate.json()) as { sensor: { id: string } };

    const humCreate = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Lab BME Humidity",
        sensorType: "humidity_bme280",
        controllerId: controller.id,
        gpioPin: null,
        i2cAddress: "0x76",
      }),
    });
    expect(humCreate.status).toBe(201);

    const pirCreate = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Lab PIR",
        sensorType: "motion_pir",
        controllerId: controller.id,
        gpioPin: 4,
      }),
    });
    expect(pirCreate.status).toBe(201);

    // 8. POST /api/sensors REJECTS DHT22 (not compiled into v1.4.0) & reserved Octal PSRAM GPIO 35
    const dhtBlocked = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Blocked DHT",
        sensorType: "temperature_dht22",
        controllerId: controller.id,
        gpioPin: 5,
      }),
    });
    expect(dhtBlocked.status).toBe(400);

    const psramPinBlocked = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Bad Pin PIR",
        sensorType: "motion_pir",
        controllerId: controller.id,
        gpioPin: 35,
      }),
    });
    expect(psramPinBlocked.status).toBe(400);

    // 9. GET /api/device/config includes canonical driver_id on sensor items
    const cfgRes = await req("/api/device/config", {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    expect(cfgRes.status).toBe(200);
    const cfgJson = (await cfgRes.json()) as {
      sensors: Array<{ id: string; sensor_type: string; driver_id: string; i2c_address: string | null }>;
    };
    const cfgTemp = cfgJson.sensors.find((s) => s.id === tempSensor.id)!;
    expect(cfgTemp.driver_id).toBe("bme280");
    expect(cfgTemp.i2c_address).toBe("0x76");

    // 10. POST /api/device/telemetry accepts ok reading AND structured error reading
    const okTelem = await req("/api/device/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        sensors: [
          {
            sensorId: tempSensor.id,
            value: 23.4,
            unit: "°C",
            status: "ok",
            driverId: "bme280",
          },
        ],
      }),
    });
    expect(okTelem.status).toBe(200);

    const sRow = await dbHarness.pg.query<{
      last_value: number;
      unit: string;
      is_online: boolean;
    }>(`SELECT last_value, unit, is_online FROM public.sensors WHERE id = $1`, [tempSensor.id]);
    expect(Number(sRow.rows[0]?.last_value)).toBeCloseTo(23.4, 2);
    expect(sRow.rows[0]?.unit).toBe("°C");
    expect(sRow.rows[0]?.is_online).toBe(true);

    const errTelem = await req("/api/device/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        sensors: [
          {
            sensorId: tempSensor.id,
            status: "error",
            error: "i2c_nack",
            driverId: "bme280",
          },
        ],
      }),
    });
    expect(errTelem.status).toBe(200);

    const errRow = await dbHarness.pg.query<{
      is_online: boolean;
      last_raw_payload: Record<string, unknown>;
    }>(`SELECT is_online, last_raw_payload FROM public.sensors WHERE id = $1`, [tempSensor.id]);
    expect(errRow.rows[0]?.is_online).toBe(false);
    expect(errRow.rows[0]?.last_raw_payload?.last_error).toBe("i2c_nack");

    // 11. Metadata-only PATCH rename succeeds even if controller firmware lacks that driver,
    //     while hardware-binding change to an unsupported sensor fails.
    await dbHarness.pg.query(
      `UPDATE public.controllers SET installed_firmware_release_id = NULL, firmware_version = '0.9.0' WHERE id = $1`,
      [controller.id]
    );
    const renameOk = await req(`/api/sensors/${tempSensor.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ name: "Lab BME Temp Renamed" }),
    });
    expect(renameOk.status).toBe(200);

    const hwChangeBlocked = await req(`/api/sensors/${tempSensor.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Lab BME Temp Renamed",
        sensorType: "temperature_dht22",
        gpioPin: 5,
      }),
    });
    expect(hwChangeBlocked.status).toBe(400);
  });

  it("validates driver_manifest on admin firmware upload and rejects mismatched chip families", async () => {
    const bootRes = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "fw-admin@homecoreos.local",
        password: "AdminPassword123!",
        fullName: "FW Admin",
      }),
    });
    expect(bootRes.status).toBe(201);
    const adminCookie = extractCookie(bootRes, "hc_admin_session");

    const boardsRes = await req("/api/admin/boards", { headers: { Cookie: adminCookie } });
    const { boards } = (await boardsRes.json()) as {
      boards: Array<{ id: string; slug: string }>;
    };
    const s3Board = boards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;

    // Upload with a mismatched driver_manifest (esp32c3 manifest on esp32s3 upload) -> must reject 400
    const badManifest = buildFirmwareDriverManifest({
      firmwareVersion: "2.0.0",
      chipFamily: "esp32c3",
      targetBoardSlug: "esp32-c3-devkitm-1",
    });

    const badForm = new FormData();
    badForm.set("name", "Bad Manifest Release");
    badForm.set("version", "2.0.0");
    badForm.set("channel", "stable");
    badForm.set("chipFamily", "esp32s3");
    badForm.set("targetBoardSlug", s3Board.slug);
    badForm.set("compatibleBoardIds", JSON.stringify([s3Board.id]));
    badForm.set("driverManifest", JSON.stringify(badManifest));
    badForm.set(
      "otaFile",
      new File([makeFakeEspOtaBinary("2.0.0", 9)], "homecoreos-ota.bin", {
        type: "application/octet-stream",
      })
    );

    const badUpload = await req("/api/admin/firmware/release", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: badForm,
    });
    expect(badUpload.status).toBe(400);

    // Valid manifest upload persists compiled_sensor_drivers, supported_sensor_types, and SHA-256 manifest_hash
    const goodManifest = buildFirmwareDriverManifest({
      firmwareVersion: "2.0.0",
      chipFamily: "esp32s3",
      targetBoardSlug: s3Board.slug,
      partitionScheme: "dual_ota_16mb",
      flashSizeMb: 16,
      psramMode: "octal",
      driverIds: ["bme280", "bh1750", "pir"],
    });
    const goodForm = new FormData();
    goodForm.set("name", "Verified Driver Release");
    goodForm.set("version", "2.0.0");
    goodForm.set("channel", "stable");
    goodForm.set("chipFamily", "esp32s3");
    goodForm.set("targetBoardSlug", s3Board.slug);
    goodForm.set("compatibleBoardIds", JSON.stringify([s3Board.id]));
    goodForm.set("driverManifest", JSON.stringify(goodManifest));
    goodForm.set(
      "otaFile",
      new File([makeFakeEspOtaBinary("2.0.0", 9)], "homecoreos-ota.bin", {
        type: "application/octet-stream",
      })
    );

    const goodUpload = await req("/api/admin/firmware/release", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: goodForm,
    });
    expect(goodUpload.status).toBe(201);
    const goodJson = (await goodUpload.json()) as {
      release: {
        compiled_sensor_drivers: string[];
        supported_sensor_types: string[];
        manifest_hash: string;
        manifest_version: string;
      };
    };
    expect(goodJson.release.compiled_sensor_drivers).toEqual(["bme280", "bh1750", "pir"]);
    expect(goodJson.release.supported_sensor_types).toEqual([
      "temperature_bme280",
      "humidity_bme280",
      "pressure_bme280",
      "motion_pir",
      "light_bh1750",
    ]);
    expect(goodJson.release.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(goodJson.release.manifest_version).toBe("1.0");
  });

  it("handles full Device, Switch, and Sensor lifecycle including MQTT command/toggle, shared DHT22 pin, and i2c_address preservation", async () => {
    // 1. Register fresh tenant user & fetch home/room/board
    const regRes = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "full-hw-lifecycle@example.com",
        password: "Password123!",
        fullName: "Hardware Owner",
        accountName: "Hardware Home",
      }),
    });
    expect(regRes.status).toBe(201);
    const cookie = extractCookie(regRes, "hc_user_session");

    const homesRes = await req("/api/homes", { headers: { Cookie: cookie } });
    const { homes } = (await homesRes.json()) as { homes: Array<{ id: string }> };
    const home = homes[0]!;

    const roomRes = await req("/api/homes/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ homeId: home.id, name: "Living Room", roomType: "living_room" }),
    });
    expect(roomRes.status).toBe(201);
    const { room } = (await roomRes.json()) as { room: { id: string } };

    const boardsRes = await req("/api/boards/catalog", { headers: { Cookie: cookie } });
    const { boards } = (await boardsRes.json()) as {
      boards: Array<{ id: string; slug: string }>;
    };
    const s3Board = boards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;

    // 2. Create controller, pair device, and seed full-driver firmware
    const ctrlRes = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Living Room Hub",
        homeId: home.id,
        boardCatalogId: s3Board.id,
      }),
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
        macAddress: "AA:BB:CC:DD:EE:99",
        firmwareVersion: "1.6.0",
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

    await seedInstalledFirmwareWithDrivers({
      pg: dbHarness.pg,
      controllerId: controller.id,
      boardId: s3Board.id,
      boardSlug: s3Board.slug,
      chipFamily: "esp32s3",
      version: "1.6.0",
    });

    // 3. SWITCHES: create, reject cross-entity pin conflict, toggle ON/OFF with MQTT, edit, delete
    const swCreate = await req("/api/switches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Ceiling Light",
        controllerId: controller.id,
        roomId: room.id,
        gpioPin: 4,
        invertedLogic: true,
      }),
    });
    expect(swCreate.status).toBe(201);
    const { switch: sw } = (await swCreate.json()) as {
      switch: { id: string; gpio_pin: number; inverted: boolean; is_on: boolean };
    };
    expect(sw.gpio_pin).toBe(4);
    expect(sw.inverted).toBe(true);
    expect(sw.is_on).toBe(false);

    const publishCountBefore = emqxMock.state.published.length;
    const swOn = await req(`/api/switches/${sw.id}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ isOn: true }),
    });
    expect(swOn.status).toBe(200);
    const swOnJson = (await swOn.json()) as {
      switch: { is_on: boolean };
      mqttDispatched: boolean;
    };
    // `is_on` is the controller-CONFIRMED state: it does not flip until the
    // device reports back. The command itself must reach the broker.
    expect(swOnJson.mqttDispatched).toBe(true);
    expect((swOnJson as unknown as { stateStatus: string }).stateStatus).toBe("pending");
    const swMqttMsg = emqxMock.state.published
      .slice(publishCountBefore)
      .find((m) => m.topic.endsWith("/cmd/switch"));
    expect(swMqttMsg).toBeTruthy();
    expect(JSON.parse(swMqttMsg!.payload)).toMatchObject({
      switch_id: sw.id,
      gpio_pin: 4,
      state: "ON",
      inverted: true,
    });

    // Cross-entity pin conflict: creating a device on GPIO 4 (held by switch) must fail 400
    const conflictDev = await req("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Conflicting Fan",
        deviceType: "fan",
        controllerId: controller.id,
        roomId: room.id,
        gpioPin: 4,
      }),
    });
    expect(conflictDev.status).toBe(400);

    // 4. DEVICES: create, command active/inactive with MQTT, edit pin/name, delete
    const devCreate = await req("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Standing Fan",
        deviceType: "fan",
        controllerId: controller.id,
        roomId: room.id,
        gpioPin: 6,
      }),
    });
    expect(devCreate.status).toBe(201);
    const { device: dev } = (await devCreate.json()) as {
      device: { id: string; gpio_pin: number; state: string };
    };

    const devCmdBefore = emqxMock.state.published.length;
    const devCmd = await req(`/api/devices/${dev.id}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ state: "active" }),
    });
    expect(devCmd.status).toBe(200);
    const devCmdJson = (await devCmd.json()) as {
      device: { state: string };
      mqttDispatched: boolean;
    };
    // `state` is the confirmed value; the command is queued until the device
    // reports back, so it stays 'idle' here while the MQTT publish must occur.
    expect(devCmdJson.mqttDispatched).toBe(true);
    expect((devCmdJson as unknown as { stateStatus: string }).stateStatus).toBe("pending");
    const devMqttMsg = emqxMock.state.published
      .slice(devCmdBefore)
      .find((m) => m.topic.endsWith("/cmd/device"));
    expect(devMqttMsg).toBeTruthy();
    expect(JSON.parse(devMqttMsg!.payload)).toMatchObject({
      device_id: dev.id,
      gpio_pin: 6,
      state: "active",
      active: true,
    });

    const devPatch = await req(`/api/devices/${dev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Ceiling Fan", gpioPin: 7 }),
    });
    expect(devPatch.status).toBe(200);

    // 5. SENSORS: shared DHT22 GPIO 5 (temp + humidity), reject duplicate/PIR on GPIO 5,
    //    i2c_address normalization + projection in POST/GET/overview + preservation across PATCH
    const dhtTemp = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Living DHT Temp",
        sensorType: "temperature_dht22",
        controllerId: controller.id,
        roomId: room.id,
        gpioPin: 5,
      }),
    });
    expect(dhtTemp.status).toBe(201);

    // Second measurement from the SAME physical DHT22 on GPIO 5 must succeed (migration 0016!)
    const dhtHum = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Living DHT Humidity",
        sensorType: "humidity_dht22",
        controllerId: controller.id,
        roomId: room.id,
        gpioPin: 5,
      }),
    });
    expect(dhtHum.status).toBe(201);

    // Duplicate temperature_dht22 on GPIO 5 must fail 400
    const dupDht = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Duplicate DHT Temp",
        sensorType: "temperature_dht22",
        controllerId: controller.id,
        gpioPin: 5,
      }),
    });
    expect(dupDht.status).toBe(400);

    // Non-shareable PIR sensor on GPIO 5 must fail 400
    const pirConflict = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "PIR on DHT pin",
        sensorType: "motion_pir",
        controllerId: controller.id,
        gpioPin: 5,
      }),
    });
    expect(pirConflict.status).toBe(400);

    // I2C BME280 with uppercase "0X76" -> normalized & projected as top-level i2c_address: "0x76"
    const bmeRes = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Room BME280",
        sensorType: "temperature_bme280",
        controllerId: controller.id,
        roomId: room.id,
        gpioPin: null,
        i2cAddress: "0X76",
      }),
    });
    expect(bmeRes.status).toBe(201);
    const { sensor: bme } = (await bmeRes.json()) as {
      sensor: { id: string; i2c_address: string | null; driver_id: string | null };
    };
    expect(bme.i2c_address).toBe("0x76");
    expect(bme.driver_id).toBe("bme280");

    // GET /api/sensors AND GET /api/homes/overview both return top-level i2c_address
    const senListRes = await req("/api/sensors", { headers: { Cookie: cookie } });
    expect(senListRes.status).toBe(200);
    const senList = (await senListRes.json()) as {
      sensors: Array<{ id: string; i2c_address: string | null }>;
    };
    expect(senList.sensors.find((s) => s.id === bme.id)?.i2c_address).toBe("0x76");

    const overviewRes = await req("/api/homes/overview", { headers: { Cookie: cookie } });
    expect(overviewRes.status).toBe(200);
    const overview = (await overviewRes.json()) as {
      sensors: Array<{ id: string; i2c_address: string | null }>;
      devices: Array<{ id: string; state: string }>;
      switches: Array<{ id: string; is_on: boolean }>;
    };
    expect(overview.sensors.find((s) => s.id === bme.id)?.i2c_address).toBe("0x76");
    // Confirmed state: a command is recorded as pending intent rather than
    // optimistically rewriting the reported state.
    const ovDev = overview.devices.find((d) => d.id === dev.id) as
      | { state: string; state_status?: string; desired_state?: Record<string, unknown> }
      | undefined;
    expect(ovDev?.state_status).toBe("pending");
    expect(ovDev?.desired_state).toEqual({ state: "active" });
    const ovSw = overview.switches.find((s) => s.id === sw.id) as
      | { is_on: boolean; state_status?: string; desired_state?: Record<string, unknown> }
      | undefined;
    expect(ovSw?.state_status).toBe("pending");
    expect(ovSw?.desired_state).toEqual({ on: true });

    // Rename BME280 preserves i2c_address: "0x76"
    const bmePatch = await req(`/api/sensors/${bme.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Living Room BME280" }),
    });
    expect(bmePatch.status).toBe(200);
    const bmePatched = (await bmePatch.json()) as {
      sensor: { name: string; i2c_address: string | null };
    };
    expect(bmePatched.sensor.name).toBe("Living Room BME280");
    expect(bmePatched.sensor.i2c_address).toBe("0x76");

    // Consolidated device config contains switch, device (moved to GPIO 7), DHT22 pair on GPIO 5, and BME280 0x76
    const cfgRes = await req("/api/device/config", {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    expect(cfgRes.status).toBe(200);
    const cfg = (await cfgRes.json()) as {
      switches: Array<{ id: string; gpio_pin: number }>;
      devices: Array<{ id: string; gpio_pin: number }>;
      sensors: Array<{ id: string; gpio_pin: number | null; i2c_address: string | null; driver_id: string }>;
    };
    expect(cfg.switches.find((s) => s.id === sw.id)?.gpio_pin).toBe(4);
    expect(cfg.devices.find((d) => d.id === dev.id)?.gpio_pin).toBe(7);
    expect(cfg.sensors.filter((s) => s.gpio_pin === 5)).toHaveLength(2);
    expect(cfg.sensors.find((s) => s.id === bme.id)?.i2c_address).toBe("0x76");

    // Clean DELETE of switch, device, and sensor frees pins and removes from listings
    expect((await req(`/api/switches/${sw.id}`, { method: "DELETE", headers: { Cookie: cookie } })).status).toBe(200);
    expect((await req(`/api/devices/${dev.id}`, { method: "DELETE", headers: { Cookie: cookie } })).status).toBe(200);
    expect((await req(`/api/sensors/${bme.id}`, { method: "DELETE", headers: { Cookie: cookie } })).status).toBe(200);

    const afterCfgRes = await req("/api/device/config", {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    const afterCfg = (await afterCfgRes.json()) as {
      switches: unknown[];
      devices: unknown[];
      sensors: Array<{ id: string }>;
    };
    expect(afterCfg.switches).toHaveLength(0);
    expect(afterCfg.devices).toHaveLength(0);
    expect(afterCfg.sensors.find((s) => s.id === bme.id)).toBeUndefined();
  });
});
