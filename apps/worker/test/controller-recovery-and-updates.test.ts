import { strToU8, zipSync } from "fflate";
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
  buf[0] = 0xe9;
  buf[1] = 0x04;
  return buf;
}

describe("Controller Trash/Restore, Secure Recovery Re-Pairing, Config Sync, and Firmware Updates", () => {
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

  async function publishFirmwarePackage(
    adminCookie: string,
    version: string,
    chipFamily = "esp32s3",
    boardSlug = "esp32-s3-devkitc-1-n16r8"
  ) {
    const otaBytes = makeFakeEspIdfImage(512);
    const factoryBytes = makeFakeEspIdfImage(1024);
    const otaSha = await sha256Hex(otaBytes);
    const factorySha = await sha256Hex(factoryBytes);

    const manifest = {
      name: "HomecoreOS Core",
      version,
      channel: "stable",
      chip_family: chipFamily,
      chip_variant: chipFamily.toUpperCase(),
      release_notes: `Release ${version}`,
      compatible_board_slugs: [boardSlug],
      files: [
        {
          file_type: "ota_app",
          file_name: `homecoreos-${version}-ota.bin`,
          sha256: otaSha,
          flash_address: "0x10000",
          flash_mode: "dio",
          flash_freq: "80m",
          flash_size: "16MB",
        },
        {
          file_type: "usb_factory",
          file_name: `homecoreos-${version}-factory.bin`,
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
      [`homecoreos-${version}-ota.bin`]: otaBytes,
      [`homecoreos-${version}-factory.bin`]: factoryBytes,
    });

    const form = new FormData();
    form.append("package", new File([zipBytes], `homecoreos-${version}.zip`, { type: "application/zip" }));
    form.append("publish", "true");

    const res = await req("/api/admin/firmware/package", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: form,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { release: { id: string; version: string } };
  }

  it("handles 30-day Trash & Restore, prevents manual-delete resurrection, enforces physical recovery security, syncs config, and filters/cancels OTA updates", async () => {
    const bootRes = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin-rec@homecoreos.local",
        fullName: "Admin",
        password: "AdminPassword123!",
      }),
    });
    const adminCookie = extractCookie(bootRes, "hc_admin_session");

    // Register Household A and Household B
    const regA = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alpha@homecoreos.local",
        password: "AlphaPassword123!",
        fullName: "Alpha Owner",
        accountName: "Alpha Home",
      }),
    });
    const cookieA = extractCookie(regA, "hc_user_session");

    const regB = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "beta@homecoreos.local",
        password: "BetaPassword123!",
        fullName: "Beta Owner",
        accountName: "Beta Home",
      }),
    });
    const cookieB = extractCookie(regB, "hc_user_session");

    // Look up ESP32-S3 board and room
    const catRes = await req("/api/boards/catalog", { headers: { Cookie: cookieA } });
    const catJson = (await catRes.json()) as {
      boards: Array<{ id: string; slug: string }>;
    };
    const s3Board = catJson.boards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;
    expect(s3Board).toBeDefined();

    const homesRes = await req("/api/homes", { headers: { Cookie: cookieA } });
    const homeId = ((await homesRes.json()) as { homes: Array<{ id: string }> }).homes[0].id;

    const roomRes = await req("/api/homes/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        homeId,
        name: "Utility Room",
        roomType: "utility",
      }),
    });
    expect(roomRes.status).toBe(201);
    const roomId = ((await roomRes.json()) as { room: { id: string } }).room.id;

    // 1. Register & initially pair Controller A with persistent hardware identity key
    const createCtrlA = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        name: "Utility ESP32-S3",
        homeId,
        boardCatalogId: s3Board.id,
      }),
    });
    expect(createCtrlA.status).toBe(201);
    const { controller: ctrlA, pairingCode: initialCode } = (await createCtrlA.json()) as {
      controller: { id: string };
      pairingCode: string;
    };

    const identityKeyA = "hw_id_esp32s3_aabbccddeeff00112233445566778899";
    const pairA = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: initialCode,
        macAddress: "AA:BB:CC:11:22:33",
        identityKey: identityKeyA,
        firmwareVersion: "1.1.0",
        wifiSsid: "AlphaWiFi",
        localIp: "192.168.10.22",
      }),
    });
    expect(pairA.status).toBe(200);
    const pairPayloadA = (await pairA.json()) as {
      mqtt_username: string;
      device_api_token: string;
    };

    // 2. Attach two switches, manually delete one BEFORE trashing controller
    const swKeepRes = await req("/api/switches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        controllerId: ctrlA.id,
        roomId,
        name: "Bench Light",
        gpioPin: 4,
      }),
    });
    expect(swKeepRes.status).toBe(201);
    const swKeepId = ((await swKeepRes.json()) as { switch: { id: string } }).switch.id;

    const swManualDelRes = await req("/api/switches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        controllerId: ctrlA.id,
        roomId,
        name: "Manual Removed Relay",
        gpioPin: 5,
      }),
    });
    const swManualDelId = ((await swManualDelRes.json()) as { switch: { id: string } }).switch.id;
    await req(`/api/switches/${swManualDelId}`, {
      method: "DELETE",
      headers: { Cookie: cookieA },
    });

    // 3. Truthful heartbeat reporting sets wifiConnected, mqttConnected, lastError
    const hbErr = await req("/api/device/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pairPayloadA.device_api_token}`,
      },
      body: JSON.stringify({
        wifiConnected: true,
        mqttConnected: false,
        wifiRssi: -68,
        localIp: "192.168.10.22",
        lastError: "EMQX TLS handshake timeout",
      }),
    });
    expect(hbErr.status).toBe(200);

    const getCtrlDetail = await req(`/api/controllers/${ctrlA.id}`, {
      headers: { Cookie: cookieA },
    });
    const detailJson = (await getCtrlDetail.json()) as {
      controller: {
        wifi_connected: boolean;
        mqtt_connected: boolean;
        last_error: string | null;
      };
    };
    expect(detailJson.controller.wifi_connected).toBe(true);
    expect(detailJson.controller.mqtt_connected).toBe(false);
    expect(detailJson.controller.last_error).toBe("EMQX TLS handshake timeout");

    // 4. Duplicate claim protection: Account B CANNOT hijack active Controller A via its MAC/identityKey
    const createCtrlB = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieB },
      body: JSON.stringify({
        name: "Hijack Attempt",
        boardCatalogId: s3Board.id,
      }),
    });
    const { pairingCode: codeB } = (await createCtrlB.json()) as { pairingCode: string };

    const hijackRes = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: codeB,
        macAddress: "AA:BB:CC:11:22:33",
        identityKey: identityKeyA,
      }),
    });
    expect(hijackRes.status).toBe(409);

    // 5. Move Controller A to Trash -> cascades to Bench Light, hides both, revokes EMQX
    const trashRes = await req(`/api/controllers/${ctrlA.id}`, {
      method: "DELETE",
      headers: { Cookie: cookieA },
    });
    expect(trashRes.status).toBe(200);
    expect(emqxState.users.has(pairPayloadA.mqtt_username)).toBe(false);

    const activeSwitchesAfterTrash = await req("/api/switches", {
      headers: { Cookie: cookieA },
    });
    expect(((await activeSwitchesAfterTrash.json()) as { switches: unknown[] }).switches).toHaveLength(0);

    const trashListRes = await req("/api/controllers/trash", {
      headers: { Cookie: cookieA },
    });
    expect(trashListRes.status).toBe(200);
    const trashList = (await trashListRes.json()) as {
      controllers: Array<{
        id: string;
        days_remaining: number;
        recoverable_counts: { switches: number; devices: number; sensors: number };
      }>;
    };
    expect(trashList.controllers).toHaveLength(1);
    expect(trashList.controllers[0].days_remaining).toBe(30);
    expect(trashList.controllers[0].recoverable_counts.switches).toBe(1);

    // 6. Restore Controller A from Trash -> brings back Bench Light ONLY (NOT manually deleted switch!) & rotates MQTT/recovery code
    const restoreRes = await req(`/api/controllers/${ctrlA.id}/restore`, {
      method: "POST",
      headers: { Cookie: cookieA },
    });
    expect(restoreRes.status).toBe(200);
    const restoreJson = (await restoreRes.json()) as {
      credentialsRotated: boolean;
      pairingCode: string;
      restoredCounts: { switches: number };
    };
    expect(restoreJson.credentialsRotated).toBe(true);
    expect(restoreJson.restoredCounts.switches).toBe(1);
    expect(restoreJson.pairingCode).toMatch(/^\d{6}$/);

    const switchesAfterRestore = (await (
      await req("/api/switches", { headers: { Cookie: cookieA } })
    ).json()) as { switches: Array<{ id: string; room_id: string | null }> };
    expect(switchesAfterRestore.switches).toHaveLength(1);
    expect(switchesAfterRestore.switches[0].id).toBe(swKeepId);
    expect(switchesAfterRestore.switches[0].room_id).toBe(roomId);

    // 7. Secure recovery pairing requires physical confirmation (403 without physicalConfirmed: true)
    const recoverWithoutPhysical = await req("/api/device/recover-pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: restoreJson.pairingCode,
        identityKey: identityKeyA,
        physicalConfirmed: false,
        physicalConfirmationMethod: "local_portal",
      }),
    });
    expect(recoverWithoutPhysical.status).toBe(403);

    // Valid physical confirmation succeeds and syncs /api/device/config cleanly
    const recoverWithPhysical = await req("/api/device/recover-pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: restoreJson.pairingCode,
        macAddress: "AA:BB:CC:11:22:33",
        identityKey: identityKeyA,
        physicalConfirmed: true,
        physicalConfirmationMethod: "button_press",
        firmwareVersion: "1.1.0",
        wifiSsid: "AlphaNewRouter",
        localIp: "192.168.10.45",
      }),
    });
    expect(recoverWithPhysical.status).toBe(200);
    const recoveredPayload = (await recoverWithPhysical.json()) as {
      device_api_token: string;
      mqtt_username: string;
    };

    const configRes = await req("/api/device/config", {
      headers: { Authorization: `Bearer ${recoveredPayload.device_api_token}` },
    });
    expect(configRes.status).toBe(200);
    const configJson = (await configRes.json()) as {
      switches: Array<{ id: string; gpio_pin: number }>;
      devices: unknown[];
      sensors: unknown[];
      automations: unknown[];
    };
    expect(configJson.switches).toHaveLength(1);
    expect(configJson.switches[0].id).toBe(swKeepId);
    expect(configJson.switches[0].gpio_pin).toBe(4);

    // Mark controller online via heartbeat
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${recoveredPayload.device_api_token}`,
      },
      body: JSON.stringify({
        wifiConnected: true,
        mqttConnected: true,
        firmwareVersion: "1.1.0",
        wifiRssi: -52,
        localIp: "192.168.10.45",
      }),
    });

    // 8. Applicable Firmware Updates & Pending OTA Cancellation
    await publishFirmwarePackage(adminCookie, "1.0.5"); // older than 1.1.0 -> should NOT appear
    const newerPkg = await publishFirmwarePackage(adminCookie, "1.3.0"); // newer -> SHOULD appear

    const updatesRes = await req("/api/firmware/updates", {
      headers: { Cookie: cookieA },
    });
    expect(updatesRes.status).toBe(200);
    const updatesJson = (await updatesRes.json()) as {
      applicableUpdates: Array<{
        controllerId: string;
        currentVersion: string | null;
        availableRelease: { id: string; version: string };
      }>;
    };
    expect(updatesJson.applicableUpdates).toHaveLength(1);
    expect(updatesJson.applicableUpdates[0].controllerId).toBe(ctrlA.id);
    expect(updatesJson.applicableUpdates[0].availableRelease.version).toBe("1.3.0");

    // Start OTA -> pending -> cancel succeeds
    const otaStartRes = await req("/api/firmware/ota/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        controllerId: ctrlA.id,
        releaseId: newerPkg.release.id,
      }),
    });
    expect(otaStartRes.status).toBe(201);
    const historyId = ((await otaStartRes.json()) as { update: { id: string } }).update.id;

    const cancelPendingRes = await req(`/api/firmware/ota/${historyId}/cancel`, {
      method: "POST",
      headers: { Cookie: cookieA },
    });
    expect(cancelPendingRes.status).toBe(200);
    expect(((await cancelPendingRes.json()) as { update: { status: string } }).update.status).toBe(
      "cancelled"
    );

    // Start second OTA, move to downloading -> cancel MUST return 409
    const otaStart2 = await req("/api/firmware/ota/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        controllerId: ctrlA.id,
        releaseId: newerPkg.release.id,
      }),
    });
    const historyId2 = ((await otaStart2.json()) as { update: { id: string } }).update.id;

    const progRes = await req("/api/device/ota/progress", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${recoveredPayload.device_api_token}`,
      },
      body: JSON.stringify({
        historyId: historyId2,
        status: "downloading",
        progressPercent: 25,
      }),
    });
    expect(progRes.status).toBe(200);

    const cancelActiveRes = await req(`/api/firmware/ota/${historyId2}/cancel`, {
      method: "POST",
      headers: { Cookie: cookieA },
    });
    expect(cancelActiveRes.status).toBe(409);

    // 9. Permanent Delete + Re-add via Existing Controller / Recover Controller
    await req(`/api/controllers/${ctrlA.id}`, {
      method: "DELETE",
      headers: { Cookie: cookieA },
    });
    const permRes = await req(`/api/controllers/${ctrlA.id}/permanent`, {
      method: "DELETE",
      headers: { Cookie: cookieA },
    });
    expect(permRes.status).toBe(200);

    // Restoring permanently deleted controller fails
    const restoreAfterPerm = await req(`/api/controllers/${ctrlA.id}/restore`, {
      method: "POST",
      headers: { Cookie: cookieA },
    });
    expect(restoreAfterPerm.status).toBe(404);

    // Recover Permanently Deleted physical hardware into a new record via /api/controllers/recover
    const recNewRes = await req("/api/controllers/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        name: "Recovered Utility Hub",
        homeId,
        boardCatalogId: s3Board.id,
      }),
    });
    expect(recNewRes.status).toBe(201);
    const recNewJson = (await recNewRes.json()) as {
      controller: { id: string };
      pairingCode: string;
    };

    const rePairFinal = await req("/api/device/recover-pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: recNewJson.pairingCode,
        macAddress: "AA:BB:CC:11:22:33",
        identityKey: identityKeyA,
        physicalConfirmed: true,
        physicalConfirmationMethod: "local_portal",
        firmwareVersion: "1.3.0",
      }),
    });
    expect(rePairFinal.status).toBe(200);
  });

  it("supports HTTP Range OTA download, releaseId progress fallback, post-reboot rollback reconciliation, and version sync", async () => {
    const adminLogin = await req("/api/admin/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin-rec@homecoreos.local",
        password: "AdminPassword123!",
      }),
    });
    expect(adminLogin.status).toBe(200);
    const adminCookie = extractCookie(adminLogin, "hc_admin_session");

    const userLogin = await req("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alpha@homecoreos.local",
        password: "AlphaPassword123!",
      }),
    });
    expect(userLogin.status).toBe(200);
    const userCookie = extractCookie(userLogin, "hc_user_session");

    const catRes = await req("/api/boards/catalog", { headers: { Cookie: userCookie } });
    const s3Board = (
      (await catRes.json()) as { boards: Array<{ id: string; slug: string }> }
    ).boards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;

    // Publish v1.3.2 & v1.3.5 packages using existing helper
    const pkg132 = await publishFirmwarePackage(adminCookie, "1.3.2");
    const pkg135 = await publishFirmwarePackage(adminCookie, "1.3.5");

    // Register & pair dedicated controller running v1.1.0
    const ctrlRes = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ name: "OTA Sync Hub", boardCatalogId: s3Board.id }),
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
        macAddress: "11:22:33:44:55:66",
        identityKey: "ota-sync-identity-key-000111222333444",
        firmwareVersion: "1.1.0",
        boardSlug: s3Board.slug,
        flashSizeMb: 16,
      }),
    });
    expect(pairRes.status).toBe(200);
    const { device_api_token: devToken } = (await pairRes.json()) as {
      device_api_token: string;
    };

    // 1. HTTP Range partial content download on OTA endpoint
    const rangeRes = await req(`/api/device/firmware/ota/${pkg132.release.id}`, {
      headers: {
        Authorization: `Bearer ${devToken}`,
        Range: "bytes=0-63",
      },
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("Content-Range")).toMatch(/^bytes 0-63\/\d+$/);
    expect((await rangeRes.arrayBuffer()).byteLength).toBe(64);

    // 2. Start OTA v1.3.2 -> progress "rebooting" (95%) -> heartbeat reports v1.1.0 -> rolled_back
    const start1 = await req("/api/firmware/ota/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        controllerId: controller.id,
        releaseId: pkg132.release.id,
      }),
    });
    expect(start1.status).toBe(201);

    await req("/api/device/ota/progress", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${devToken}`,
      },
      body: JSON.stringify({
        releaseId: pkg132.release.id,
        status: "rebooting",
        progressPercent: 95,
      }),
    });

    await req("/api/device/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${devToken}`,
      },
      body: JSON.stringify({
        wifiConnected: true,
        mqttConnected: true,
        firmwareVersion: "1.1.0",
      }),
    });

    const updatesAfterRollback = (await (
      await req("/api/firmware/updates", { headers: { Cookie: userCookie } })
    ).json()) as {
      applicableUpdates: Array<{ controllerId: string; currentVersion: string }>;
      history: Array<{ controller_id: string; status: string; error_message: string | null }>;
    };
    const ctrlHistRollback = updatesAfterRollback.history.filter(
      (h) => h.controller_id === controller.id
    );
    expect(ctrlHistRollback[0]?.status).toBe("rolled_back");
    expect(ctrlHistRollback[0]?.error_message).toMatch(/v1\.1\.0.*v1\.3\.2/i);
    expect(
      updatesAfterRollback.applicableUpdates.some((u) => u.controllerId === controller.id)
    ).toBe(true);

    // 3. Retry OTA v1.3.2 -> post succeeded via releaseId fallback (no historyId) + heartbeat v1.3.2
    const start2 = await req("/api/firmware/ota/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        controllerId: controller.id,
        releaseId: pkg132.release.id,
      }),
    });
    expect(start2.status).toBe(201);

    const progOk = await req("/api/device/ota/progress", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${devToken}`,
      },
      body: JSON.stringify({
        releaseId: pkg132.release.id,
        status: "succeeded",
        progressPercent: 100,
        firmwareVersion: "1.3.2",
      }),
    });
    expect(progOk.status).toBe(200);

    await req("/api/device/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${devToken}`,
      },
      body: JSON.stringify({
        wifiConnected: true,
        mqttConnected: true,
        firmwareVersion: "1.3.2",
      }),
    });

    const ctrlRes132 = (await (
      await req(`/api/controllers/${controller.id}`, { headers: { Cookie: userCookie } })
    ).json()) as { controller: { firmware_version: string } };
    expect(ctrlRes132.controller.firmware_version).toBe("1.3.2");

    // 4. False-positive pre-reboot succeeded (100%) on v1.3.5 followed by stale v1.3.2 heartbeat -> flags rolled_back!
    const start3 = await req("/api/firmware/ota/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        controllerId: controller.id,
        releaseId: pkg135.release.id,
      }),
    });
    expect(start3.status).toBe(201);

    await req("/api/device/ota/progress", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${devToken}`,
      },
      body: JSON.stringify({
        releaseId: pkg135.release.id,
        status: "succeeded",
        progressPercent: 100,
      }),
    });

    await req("/api/device/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${devToken}`,
      },
      body: JSON.stringify({
        wifiConnected: true,
        mqttConnected: true,
        firmwareVersion: "1.3.2",
      }),
    });

    const updatesPostFalseSuccess = (await (
      await req("/api/firmware/updates", { headers: { Cookie: userCookie } })
    ).json()) as {
      history: Array<{ controller_id: string; status: string; target_version: string }>;
    };
    const latestForCtrl = updatesPostFalseSuccess.history.find(
      (h) => h.controller_id === controller.id
    );
    expect(latestForCtrl?.target_version).toBe("1.3.5");
    expect(latestForCtrl?.status).toBe("rolled_back");

    const ctrlResFinal = (await (
      await req(`/api/controllers/${controller.id}`, { headers: { Cookie: userCookie } })
    ).json()) as { controller: { firmware_version: string } };
    expect(ctrlResFinal.controller.firmware_version).toBe("1.3.2");
  });

  it("enforces strict runtime version validation (1.2.0 -> 1.2.9), single terminal result per historyId, and blocks premature or duplicate outcomes", async () => {
    const adminLogin = await req("/api/admin/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin-rec@homecoreos.local",
        password: "AdminPassword123!",
      }),
    });
    const adminCookie = extractCookie(adminLogin, "hc_admin_session");

    const userLogin = await req("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alpha@homecoreos.local",
        password: "AlphaPassword123!",
      }),
    });
    const userCookie = extractCookie(userLogin, "hc_user_session");

    const catRes = await req("/api/boards/catalog", { headers: { Cookie: userCookie } });
    const s3Board = (
      (await catRes.json()) as { boards: Array<{ id: string; slug: string }> }
    ).boards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;

    const pkg129 = await publishFirmwarePackage(adminCookie, "1.2.9");

    const ctrlRes = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ name: "Strict OTA S3", boardCatalogId: s3Board.id }),
    });
    const { controller, pairingCode } = (await ctrlRes.json()) as {
      controller: { id: string };
      pairingCode: string;
    };

    const pairRes = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode,
        macAddress: "AA:BB:CC:DD:EE:09",
        identityKey: "strict-ota-s3-n16r8-identity-key-01",
        firmwareVersion: "1.2.0",
        boardSlug: s3Board.slug,
        flashSizeMb: 16,
      }),
    });
    const { device_api_token: devToken } = (await pairRes.json()) as {
      device_api_token: string;
    };

    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${devToken}` },
      body: JSON.stringify({ wifiConnected: true, mqttConnected: true, firmwareVersion: "1.2.0" }),
    });

    // Case A (Scenario 7): Image reporting v1.2.0 for target v1.2.9 MUST NOT be recorded as succeeded
    const startA = await req("/api/firmware/ota/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ controllerId: controller.id, releaseId: pkg129.release.id }),
    });
    expect(startA.status).toBe(201);
    const histIdA = ((await startA.json()) as { update: { id: string } }).update.id;

    const spoofedRes = await req("/api/device/ota/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${devToken}` },
      body: JSON.stringify({
        historyId: histIdA,
        releaseId: pkg129.release.id,
        status: "succeeded",
        progressPercent: 100,
        firmwareVersion: "1.2.0",
      }),
    });
    expect(spoofedRes.status).toBe(200);
    const spoofedJson = (await spoofedRes.json()) as { status?: string };
    expect(spoofedJson.status).toBe("rolled_back");

    const ctrlAfterSpoof = (await (
      await req(`/api/controllers/${controller.id}`, { headers: { Cookie: userCookie } })
    ).json()) as { controller: { firmware_version: string } };
    expect(ctrlAfterSpoof.controller.firmware_version).toBe("1.2.0");

    // Case B (Scenario 8): Single terminal result per historyId — duplicate/conflicting callbacks cannot overwrite or double-notify
    const startB = await req("/api/firmware/ota/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ controllerId: controller.id, releaseId: pkg129.release.id }),
    });
    expect(startB.status).toBe(201);
    const histIdB = ((await startB.json()) as { update: { id: string } }).update.id;

    // Transient failed heartbeat before confirmation does NOT complete or fail OTA while rebooting
    await req("/api/device/ota/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${devToken}` },
      body: JSON.stringify({
        historyId: histIdB,
        status: "rebooting",
        progressPercent: 95,
        firmwareVersion: "1.2.0",
      }),
    });

    // Confirmed v1.2.9 boot -> succeeded once
    const confirmRes = await req("/api/device/ota/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${devToken}` },
      body: JSON.stringify({
        historyId: histIdB,
        releaseId: pkg129.release.id,
        status: "succeeded",
        progressPercent: 100,
        firmwareVersion: "1.2.9",
      }),
    });
    expect(confirmRes.status).toBe(200);
    expect(((await confirmRes.json()) as { status?: string }).status).toBe("succeeded");

    // Duplicate succeeded, delayed flashing, conflicting rolled_back, and stale heartbeat all ignored for histIdB
    const dupSucceeded = await req("/api/device/ota/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${devToken}` },
      body: JSON.stringify({
        historyId: histIdB,
        status: "succeeded",
        progressPercent: 100,
        firmwareVersion: "1.2.9",
      }),
    });
    expect(((await dupSucceeded.json()) as { alreadyTerminal?: boolean }).alreadyTerminal).toBe(true);

    const lateConflict = await req("/api/device/ota/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${devToken}` },
      body: JSON.stringify({
        historyId: histIdB,
        status: "rolled_back",
        progressPercent: 0,
        firmwareVersion: "1.2.0",
      }),
    });
    expect(((await lateConflict.json()) as { alreadyTerminal?: boolean }).alreadyTerminal).toBe(true);

    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${devToken}` },
      body: JSON.stringify({
        wifiConnected: true,
        mqttConnected: true,
        firmwareVersion: "1.2.0",
      }),
    });

    const updatesJson = (await (
      await req("/api/firmware/updates", { headers: { Cookie: userCookie } })
    ).json()) as {
      history: Array<{ id: string; status: string }>;
    };
    const rowB = updatesJson.history.find((h) => h.id === histIdB);
    expect(rowB?.status).toBe("succeeded");

    const notifRes = (await (
      await req("/api/notifications", { headers: { Cookie: userCookie } })
    ).json()) as {
      notifications: Array<{ metadata?: { historyId?: string; controllerId?: string } }>;
    };
    const histBNotifs = notifRes.notifications.filter(
      (n) => n.metadata?.historyId === histIdB
    );
    expect(histBNotifs).toHaveLength(1);

    // Case C (Boot verification gate): Heartbeat with otaPendingVerify=true on target version stays "verifying" and later allows rollback detection
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${devToken}` },
      body: JSON.stringify({
        wifiConnected: true,
        mqttConnected: true,
        firmwareVersion: "1.2.0",
      }),
    });

    const pkg136 = await publishFirmwarePackage(adminCookie, "1.3.6");
    const startC = await req("/api/firmware/ota/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ controllerId: controller.id, releaseId: pkg136.release.id }),
    });
    expect(startC.status).toBe(201);
    const histIdC = ((await startC.json()) as { update: { id: string } }).update.id;

    // First-boot heartbeat BEFORE health check completes (otaPendingVerify: true)
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${devToken}` },
      body: JSON.stringify({
        wifiConnected: true,
        mqttConnected: false,
        firmwareVersion: "1.3.6",
        otaPendingVerify: true,
      }),
    });

    const midUpdatesJson = (await (
      await req("/api/firmware/updates", { headers: { Cookie: userCookie } })
    ).json()) as {
      history: Array<{ id: string; status: string; progress_percent: number }>;
    };
    const midRowC = midUpdatesJson.history.find((h) => h.id === histIdC);
    expect(midRowC?.status).toBe("verifying");
    expect(midRowC?.progress_percent).toBe(96);

    const ctrlDuringVerify = (await (
      await req(`/api/controllers/${controller.id}`, { headers: { Cookie: userCookie } })
    ).json()) as { controller: { firmware_version: string } };
    expect(ctrlDuringVerify.controller.firmware_version).toBe("1.2.0");

    // Subsequent boot after bootloader rollback reports v1.2.0 -> rolled_back (NOT blocked by premature succeeded!)
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${devToken}` },
      body: JSON.stringify({
        wifiConnected: true,
        mqttConnected: true,
        firmwareVersion: "1.2.0",
        otaPendingVerify: false,
      }),
    });

    const finalUpdatesJson = (await (
      await req("/api/firmware/updates", { headers: { Cookie: userCookie } })
    ).json()) as {
      history: Array<{ id: string; status: string }>;
    };
    expect(finalUpdatesJson.history.find((h) => h.id === histIdC)?.status).toBe("rolled_back");
  });
});
