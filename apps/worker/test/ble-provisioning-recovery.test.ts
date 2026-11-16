import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import { sha256Hex } from "../src/lib/crypto";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
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

describe("Dual BLE + Wi-Fi Provisioning & Recovery Backend Flows", () => {
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

  it("enforces board BLE capability matrix, validates manifests, stores ble_setup_pin/provisioning_transport, and serves board-specific recovery guidance", async () => {
    const bootRes = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin-ble@homecoreos.local",
        fullName: "BLE Admin",
        password: "AdminPassword123!",
      }),
    });
    expect(bootRes.status).toBe(201);
    const adminCookie = extractCookie(bootRes, "hc_admin_session");

    const regRes = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "user-ble@homecoreos.local",
        password: "UserPassword123!",
        fullName: "BLE User",
        accountName: "BLE Home",
      }),
    });
    expect(regRes.status).toBe(201);
    const userCookie = extractCookie(regRes, "hc_user_session");

    // 1. Catalog exposes exact supports_ble & supports_ble_wifi_provisioning flags
    const catRes = await req("/api/boards/catalog", {
      headers: { Cookie: userCookie },
    });
    expect(catRes.status).toBe(200);
    const catJson = (await catRes.json()) as {
      boards: Array<{
        id: string;
        slug: string;
        supports_wifi: boolean;
        supports_ble: boolean;
        supports_ble_wifi_provisioning: boolean;
      }>;
    };
    const bySlug = new Map(catJson.boards.map((b) => [b.slug, b]));
    expect(bySlug.get("esp32-s3-devkitc-1-n16r8")).toMatchObject({
      supports_wifi: true,
      supports_ble: true,
      supports_ble_wifi_provisioning: true,
    });
    expect(bySlug.get("esp32-s2-devkitc-1")).toMatchObject({
      supports_wifi: true,
      supports_ble: false,
      supports_ble_wifi_provisioning: false,
    });
    expect(bySlug.get("esp32-h2-devkitm-1")).toMatchObject({
      supports_wifi: false,
      supports_ble: true,
      supports_ble_wifi_provisioning: false,
    });

    // 2. Reject invalid manifest claiming supports_ble=true for ESP32-S2
    const bin = makeFakeEspIdfImage(512);
    const binSha = await sha256Hex(bin);
    const badS2Zip = zipSync({
      "manifest.json": strToU8(
        JSON.stringify({
          name: "Bad S2 BLE",
          version: "1.4.0",
          channel: "stable",
          chip_family: "esp32s2",
          target_board_slug: "esp32-s2-devkitc-1",
          partition_scheme: "dual_ota_4mb",
          supports_wifi: true,
          supports_ble: true,
          compatible_board_slugs: ["esp32-s2-devkitc-1"],
          files: [
            {
              file_type: "usb_factory",
              file_name: "homecoreos-factory.bin",
              sha256: binSha,
              file_size_bytes: bin.byteLength,
              flash_address: "0x1000",
              flash_size: "4MB",
            },
          ],
        })
      ),
      "homecoreos-factory.bin": bin,
    });
    const badForm = new FormData();
    badForm.append("package", new File([badS2Zip], "bad-s2.zip", { type: "application/zip" }));
    const badS2Res = await req("/api/admin/firmware/package", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: badForm,
    });
    expect(badS2Res.status).toBe(400);

    // 3. Reject invalid manifest claiming supports_ble_wifi_provisioning=true for ESP32-H2
    const badH2Zip = zipSync({
      "manifest.json": strToU8(
        JSON.stringify({
          name: "Bad H2 BLE Wi-Fi",
          version: "1.4.0",
          channel: "stable",
          chip_family: "esp32h2",
          target_board_slug: "esp32-h2-devkitm-1",
          partition_scheme: "dual_ota_4mb",
          supports_wifi: false,
          supports_ble: true,
          supports_ble_wifi_provisioning: true,
          compatible_board_slugs: ["esp32-h2-devkitm-1"],
          files: [
            {
              file_type: "usb_factory",
              file_name: "homecoreos-factory.bin",
              sha256: binSha,
              file_size_bytes: bin.byteLength,
              flash_address: "0x0",
              flash_size: "4MB",
            },
          ],
        })
      ),
      "homecoreos-factory.bin": bin,
    });
    const badH2Form = new FormData();
    badH2Form.append("package", new File([badH2Zip], "bad-h2.zip", { type: "application/zip" }));
    const badH2Res = await req("/api/admin/firmware/package", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: badH2Form,
    });
    expect(badH2Res.status).toBe(400);

    // 4. Create controllers for S3, S2, and H2 and verify BLE pairing + BLE recovery + guidance
    const s3Create = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Living Room S3",
        boardCatalogId: bySlug.get("esp32-s3-devkitc-1-n16r8")!.id,
      }),
    });
    expect(s3Create.status).toBe(201);
    const s3Json = (await s3Create.json()) as {
      controller: { id: string };
      pairingCode: string;
    };

    const s2Create = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Hallway S2",
        boardCatalogId: bySlug.get("esp32-s2-devkitc-1")!.id,
      }),
    });
    expect(s2Create.status).toBe(201);

    const h2Create = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Thread Hub H2",
        boardCatalogId: bySlug.get("esp32-h2-devkitm-1")!.id,
      }),
    });
    expect(h2Create.status).toBe(201);

    // Pair S3 over BLE transport with bleSetupPin
    const identityKey = "hw-s3-ble-identity-secret-1234567890abcd";
    const pairS3Res = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: s3Json.pairingCode,
        macAddress: "11:22:33:44:55:66",
        identityKey,
        boardSlug: "esp32-s3-devkitc-1-n16r8",
        firmwareVersion: "1.4.0",
        wifiSsid: "Home24GHz",
        localIp: "192.168.1.90",
        bleSetupPin: "K7M9P2Q4",
        provisioningTransport: "ble",
      }),
    });
    expect(pairS3Res.status).toBe(200);

    // List controllers and check ble_setup_pin, provisioning_transport, and board_compat flags
    const listRes = await req("/api/controllers", {
      headers: { Cookie: userCookie },
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      controllers: Array<{
        id: string;
        name: string;
        ble_setup_pin: string | null;
        provisioning_transport: string | null;
        board_compat?: {
          supports_wifi: boolean;
          supports_ble: boolean;
          supports_ble_wifi_provisioning: boolean;
        };
      }>;
    };
    const s3Ctrl = listJson.controllers.find((c) => c.name === "Living Room S3")!;
    const s2Ctrl = listJson.controllers.find((c) => c.name === "Hallway S2")!;
    const h2Ctrl = listJson.controllers.find((c) => c.name === "Thread Hub H2")!;

    expect(s3Ctrl.ble_setup_pin).toBe("K7M9P2Q4");
    expect(s3Ctrl.provisioning_transport).toBe("ble");
    expect(s3Ctrl.board_compat).toMatchObject({
      supports_wifi: true,
      supports_ble: true,
      supports_ble_wifi_provisioning: true,
    });
    expect(s2Ctrl.board_compat).toMatchObject({
      supports_wifi: true,
      supports_ble: false,
      supports_ble_wifi_provisioning: false,
    });
    expect(h2Ctrl.board_compat).toMatchObject({
      supports_wifi: false,
      supports_ble: true,
      supports_ble_wifi_provisioning: false,
    });

    // Check board-specific recovery instructions across S3, S2, and H2
    const recS3 = await req("/api/controllers/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ controllerId: s3Ctrl.id }),
    });
    expect(recS3.status).toBe(201);
    const recS3Json = (await recS3.json()) as {
      pairingCode: string;
      physicalConfirmationInstructions: string[];
    };
    expect(
      recS3Json.physicalConfirmationInstructions.some((s) => /Bluetooth/i.test(s))
    ).toBe(true);
    expect(
      recS3Json.physicalConfirmationInstructions.some((s) =>
        /HomecoreOS-Setup-XXXX/.test(s)
      )
    ).toBe(true);

    const recS2 = await req("/api/controllers/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ controllerId: s2Ctrl.id }),
    });
    expect(recS2.status).toBe(201);
    const recS2Json = (await recS2.json()) as {
      physicalConfirmationInstructions: string[];
    };
    expect(
      recS2Json.physicalConfirmationInstructions.some((s) => /HomecoreOS-Setup-XXXX/.test(s))
    ).toBe(true);
    expect(
      recS2Json.physicalConfirmationInstructions.some((s) =>
        /Provision over Bluetooth/i.test(s)
      )
    ).toBe(false);

    const recH2 = await req("/api/controllers/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ controllerId: h2Ctrl.id }),
    });
    expect(recH2.status).toBe(201);
    const recH2Json = (await recH2.json()) as {
      physicalConfirmationInstructions: string[];
    };
    expect(
      recH2Json.physicalConfirmationInstructions.some((s) => /BLE recovery mode/i.test(s))
    ).toBe(true);

    // Execute BLE recovery re-pair with physicalConfirmationMethod = "ble_recovery"
    const recPairRes = await req("/api/device/recover-pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: recS3Json.pairingCode,
        macAddress: "11:22:33:44:55:66",
        identityKey,
        physicalConfirmed: true,
        physicalConfirmationMethod: "ble_recovery",
        boardSlug: "esp32-s3-devkitc-1-n16r8",
        firmwareVersion: "1.4.1",
        wifiSsid: "Home24GHz-New",
        localIp: "192.168.1.91",
        bleSetupPin: "K7M9P2Q4",
        provisioningTransport: "ble",
      }),
    });
    expect(recPairRes.status).toBe(200);

    // Compact heartbeat with bp flag succeeds cleanly
    const { device_api_token } = (await recPairRes.json()) as { device_api_token: string };
    const hbRes = await req("/api/device/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${device_api_token}`,
      },
      body: JSON.stringify({
        r: -54,
        s: "Home24GHz-New",
        ip: "192.168.1.91",
        v: "1.4.1",
        b: "esp32-s3-devkitc-1-n16r8",
        ps: "dual_ota_16mb",
        w: true,
        m: true,
        bp: false,
        rev: 1,
      }),
    });
    expect(hbRes.status).toBe(200);
  });
});
