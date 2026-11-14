import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOARD_FIRMWARE_COMPAT_BY_SLUG } from "@homecoreos/shared";
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
  buf[0] = 0xe9; // ESP-IDF image magic
  buf[1] = 0x04;
  return buf;
}

describe("Multi-Board Firmware Compatibility, Release Lifecycle, Verification, Rollback & OTA Guards", () => {
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

  it("verifies all 11 boards, admin release/attach/verify/rollback, strict OTA filtering, X-Homecore guards, and board-specific recovery", async () => {
    const bootRes = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin-mb@homecoreos.local",
        fullName: "Platform Admin",
        password: "AdminPassword123!",
      }),
    });
    expect(bootRes.status).toBe(201);
    const adminCookie = extractCookie(bootRes, "hc_admin_session");

    const regRes = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "user-mb@homecoreos.local",
        password: "UserPassword123!",
        fullName: "Fleet User",
        accountName: "MultiBoard Home",
      }),
    });
    expect(regRes.status).toBe(201);
    const userCookie = extractCookie(regRes, "hc_user_session");

    // 1. Validate migration 0009 compatibility metadata across all 11 cataloged boards
    const boardsRes = await req("/api/admin/boards", {
      headers: { Cookie: adminCookie },
    });
    expect(boardsRes.status).toBe(200);
    const boardsJson = (await boardsRes.json()) as {
      boards: Array<{
        id: string;
        slug: string;
        chip_family: string;
        flash_size_mb: number;
        firmware_status: string;
        partition_scheme: string;
        psram_mode: string;
        boot_button_gpio: number;
        bootloader_offset: string;
        supports_wifi: boolean;
        firmware_compat_key: string;
      }>;
    };

    const bySlug = new Map(boardsJson.boards.map((b) => [b.slug, b]));
    for (const [slug, expected] of Object.entries(BOARD_FIRMWARE_COMPAT_BY_SLUG)) {
      const board = bySlug.get(slug);
      expect(board, `Missing catalog board ${slug}`).toBeDefined();
      expect(board!.partition_scheme).toBe(expected.partition_scheme);
      expect(board!.psram_mode).toBe(expected.psram_mode);
      expect(board!.boot_button_gpio).toBe(expected.boot_button_gpio);
      expect(board!.bootloader_offset).toBe(expected.bootloader_offset);
      expect(board!.supports_wifi).toBe(expected.supports_wifi);
      expect(board!.firmware_compat_key).toBe(expected.firmware_compat_key);
    }
    expect(bySlug.get("esp32-s3-devkitc-1-n16r8")!.firmware_status).toBe("firmware_supported");
    expect(bySlug.get("esp32-c5-devkitc-1")!.firmware_status).toBe("catalog_only");
    expect(bySlug.get("esp32-h2-devkitm-1")!.supports_wifi).toBe(false);

    const s3N16Board = bySlug.get("esp32-s3-devkitc-1-n16r8")!;
    const xiaoS3Board = bySlug.get("seeed-xiao-esp32s3")!;
    const c5Board = bySlug.get("esp32-c5-devkitc-1")!;
    const h2Board = bySlug.get("esp32-h2-devkitm-1")!;

    // 2. Reject invalid board/flash compatibility on release creation (16MB scheme assigned to 8MB XIAO)
    const badForm = new FormData();
    badForm.append("name", "Bad S3 Image");
    badForm.append("version", "2.0.0");
    badForm.append("channel", "stable");
    badForm.append("chipFamily", "esp32s3");
    badForm.append("partitionScheme", "dual_ota_16mb");
    badForm.append("psramMode", "octal");
    badForm.append("flashSize", "16MB");
    badForm.append("compatibleBoardIds", JSON.stringify([xiaoS3Board.id]));
    badForm.append(
      "usbFile",
      new File([makeFakeEspIdfImage()], "bad-xiao.bin", { type: "application/octet-stream" })
    );
    const badRelRes = await req("/api/admin/firmware/release", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: badForm,
    });
    expect(badRelRes.status).toBe(400);

    // 3. Create draft ESP32-C5 release (dual_ota_8mb, quad PSRAM, DIO, 8MB) -> catalog stays catalog_only until verified + published
    const c5UsbBytes = makeFakeEspIdfImage(640);
    const c5OtaBytes = makeFakeEspIdfImage(512);
    const c5Form = new FormData();
    c5Form.append("name", "HomecoreOS C5");
    c5Form.append("version", "2.1.0");
    c5Form.append("channel", "stable");
    c5Form.append("chipFamily", "esp32c5");
    c5Form.append("targetBoardSlug", "esp32-c5-devkitc-1");
    c5Form.append("partitionScheme", "dual_ota_8mb");
    c5Form.append("psramMode", "quad");
    c5Form.append("flashMode", "dio");
    c5Form.append("flashFreq", "80m");
    c5Form.append("flashSize", "8MB");
    c5Form.append("compatibleBoardIds", JSON.stringify([c5Board.id]));
    c5Form.append("publish", "false");
    c5Form.append(
      "usbFile",
      new File([c5UsbBytes], "c5-usb.bin", { type: "application/octet-stream" })
    );
    const c5CreateRes = await req("/api/admin/firmware/release", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: c5Form,
    });
    expect(c5CreateRes.status).toBe(201);
    const c5RelId = ((await c5CreateRes.json()) as { release: { id: string } }).release.id;

    // Attach OTA file to existing draft release
    const attachForm = new FormData();
    attachForm.append("fileType", "ota_app");
    attachForm.append(
      "file",
      new File([c5OtaBytes], "c5-ota.bin", { type: "application/octet-stream" })
    );
    const attachRes = await req(`/api/admin/firmware/${c5RelId}/attach`, {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: attachForm,
    });
    expect(attachRes.status).toBe(201);

    // Publish without verification -> C5 board must still remain catalog_only
    const pubC5Res = await req(`/api/admin/firmware/${c5RelId}/publish`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    expect(pubC5Res.status).toBe(200);

    let boardCheckRes = await req("/api/admin/boards", { headers: { Cookie: adminCookie } });
    let boardCheck = ((await boardCheckRes.json()) as { boards: Array<{ slug: string; firmware_status: string }> }).boards;
    expect(boardCheck.find((b) => b.slug === "esp32-c5-devkitc-1")!.firmware_status).toBe("catalog_only");

    // Verify hardware compatibility -> automatically promotes esp32-c5-devkitc-1 to firmware_supported
    const verifyRes = await req(`/api/admin/firmware/${c5RelId}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({
        hardwareVerified: true,
        verifiedBoardIds: [c5Board.id],
        verificationNotes: "Flashed & OTA reboot tested on ESP32-C5-DevKitC-1",
      }),
    });
    expect(verifyRes.status).toBe(200);

    boardCheckRes = await req("/api/admin/boards", { headers: { Cookie: adminCookie } });
    boardCheck = ((await boardCheckRes.json()) as { boards: Array<{ slug: string; firmware_status: string }> }).boards;
    expect(boardCheck.find((b) => b.slug === "esp32-c5-devkitc-1")!.firmware_status).toBe("firmware_supported");
    expect(boardCheck.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!.firmware_status).toBe("firmware_supported");

    // Deprecating C5's only verified published release demotes C5 back to catalog_only while preserving S3 N16R8 baseline
    const depRes = await req(`/api/admin/firmware/${c5RelId}/deprecate`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    expect(depRes.status).toBe(200);

    boardCheckRes = await req("/api/admin/boards", { headers: { Cookie: adminCookie } });
    boardCheck = ((await boardCheckRes.json()) as { boards: Array<{ slug: string; firmware_status: string }> }).boards;
    expect(boardCheck.find((b) => b.slug === "esp32-c5-devkitc-1")!.firmware_status).toBe("catalog_only");
    expect(boardCheck.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!.firmware_status).toBe("firmware_supported");

    // Create & publish v2.2.0 C5 release, then roll it back to verified v2.1.0 (c5RelId)
    const c5V2Form = new FormData();
    c5V2Form.append("name", "HomecoreOS C5");
    c5V2Form.append("version", "2.2.0");
    c5V2Form.append("channel", "stable");
    c5V2Form.append("chipFamily", "esp32c5");
    c5V2Form.append("targetBoardSlug", "esp32-c5-devkitc-1");
    c5V2Form.append("partitionScheme", "dual_ota_8mb");
    c5V2Form.append("psramMode", "quad");
    c5V2Form.append("flashMode", "dio");
    c5V2Form.append("flashFreq", "80m");
    c5V2Form.append("flashSize", "8MB");
    c5V2Form.append("compatibleBoardIds", JSON.stringify([c5Board.id]));
    c5V2Form.append("publish", "true");
    c5V2Form.append(
      "usbFile",
      new File([makeFakeEspIdfImage(640)], "c5-v22-usb.bin", { type: "application/octet-stream" })
    );
    const c5V2Res = await req("/api/admin/firmware/release", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: c5V2Form,
    });
    expect(c5V2Res.status).toBe(201);
    const c5V2Id = ((await c5V2Res.json()) as { release: { id: string } }).release.id;

    const rbRes = await req(`/api/admin/firmware/${c5V2Id}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({
        targetReleaseId: c5RelId,
        reason: "Wi-Fi regression on v2.2.0, reverting to verified v2.1.0",
      }),
    });
    expect(rbRes.status).toBe(200);
    const rbPayload = (await rbRes.json()) as {
      release: { id: string; status: string; superseded_by_release_id: string };
    };
    expect(rbPayload.release.status).toBe("deprecated");
    expect(rbPayload.release.superseded_by_release_id).toBe(c5RelId);

    boardCheckRes = await req("/api/admin/boards", { headers: { Cookie: adminCookie } });
    boardCheck = ((await boardCheckRes.json()) as { boards: Array<{ slug: string; firmware_status: string }> }).boards;
    expect(boardCheck.find((b) => b.slug === "esp32-c5-devkitc-1")!.firmware_status).toBe("firmware_supported");

    // 4. Create & pair controllers on XIAO ESP32-S3 (8MB), ESP32-C5 (BOOT GPIO28), and ESP32-H2 (No Wi-Fi)
    const createCtrl = async (name: string, boardCatalogId: string) => {
      const r = await req("/api/controllers", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userCookie },
        body: JSON.stringify({ name, boardCatalogId }),
      });
      expect(r.status).toBe(201);
      return (await r.json()) as { controller: { id: string }; pairingCode: string };
    };

    const xiaoCtrl = await createCtrl("XIAO Relay", xiaoS3Board.id);
    const c5Ctrl = await createCtrl("C5 Gateway", c5Board.id);
    const h2Ctrl = await createCtrl("H2 Thread Node", h2Board.id);

    // Check board-specific offline recovery instructions before pairing
    const listBeforePair = await req("/api/controllers", { headers: { Cookie: userCookie } });
    expect(listBeforePair.status).toBe(200);
    const listedCtrls = ((await listBeforePair.json()) as {
      controllers: Array<{
        id: string;
        board_compat?: { boot_button_gpio: number; supports_wifi: boolean };
        offline_recovery_instructions?: string[];
      }>;
    }).controllers;
    const listedC5 = listedCtrls.find((c) => c.id === c5Ctrl.controller.id)!;
    const listedH2 = listedCtrls.find((c) => c.id === h2Ctrl.controller.id)!;
    expect(listedC5.board_compat?.boot_button_gpio).toBe(28);
    expect(listedC5.offline_recovery_instructions?.join(" ")).toContain("GPIO28");
    expect(listedH2.board_compat?.supports_wifi).toBe(false);
    expect(listedH2.offline_recovery_instructions?.join(" ")).toContain("no integrated Wi-Fi");

    // Pair XIAO S3 controller & send heartbeat with reported board + flash telemetry
    const xiaoPairRes = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: xiaoCtrl.pairingCode,
        macAddress: "AA:BB:CC:11:22:33",
        firmwareVersion: "1.0.0",
        wifiSsid: "LabWiFi",
        localIp: "192.168.10.22",
      }),
    });
    expect(xiaoPairRes.status).toBe(200);
    const xiaoCreds = (await xiaoPairRes.json()) as { device_api_token: string };

    const hbRes = await req("/api/device/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${xiaoCreds.device_api_token}`,
      },
      body: JSON.stringify({
        fw: "1.0.0",
        b: "seeed-xiao-esp32s3",
        f: 8,
        chipName: "ESP32-S3 (QFN56)",
      }),
    });
    expect(hbRes.status).toBe(200);

    // 5. Publish two S3 releases:
    //    (a) 16MB S3 N16R8 release v3.0.0 (incompatible with 8MB XIAO!)
    //    (b) 8MB XIAO S3 release v1.5.0 (compatible with 8MB XIAO!)
    const publishS3Release = async (opts: {
      name: string;
      version: string;
      flashMb: number;
      scheme: string;
      boardIds: string[];
      slug: string;
    }) => {
      const f = new FormData();
      f.append("name", opts.name);
      f.append("version", opts.version);
      f.append("channel", "stable");
      f.append("chipFamily", "esp32s3");
      f.append("targetBoardSlug", opts.slug);
      f.append("partitionScheme", opts.scheme);
      f.append("psramMode", "octal");
      f.append("flashMode", "qio");
      f.append("flashFreq", "80m");
      f.append("flashSize", `${opts.flashMb}MB`);
      f.append("compatibleBoardIds", JSON.stringify(opts.boardIds));
      f.append("publish", "true");
      f.append("hardwareVerified", "true");
      const otaBytes = makeFakeEspIdfImage(512);
      f.append(
        "otaFile",
        new File([otaBytes], `${opts.slug}.ota.bin`, { type: "application/octet-stream" })
      );
      const res = await req("/api/admin/firmware/release", {
        method: "POST",
        headers: { Cookie: adminCookie },
        body: f,
      });
      expect(res.status).toBe(201);
      const data = (await res.json()) as { release: { id: string } };
      return { id: data.release.id, sha: await sha256Hex(otaBytes) };
    };

    const rel16 = await publishS3Release({
      name: "HomecoreOS S3 N16R8",
      version: "3.0.0",
      flashMb: 16,
      scheme: "dual_ota_16mb",
      boardIds: [s3N16Board.id],
      slug: "esp32-s3-devkitc-1-n16r8",
    });

    const rel8 = await publishS3Release({
      name: "HomecoreOS XIAO S3",
      version: "1.5.0",
      flashMb: 8,
      scheme: "dual_ota_8mb",
      boardIds: [xiaoS3Board.id],
      slug: "seeed-xiao-esp32s3",
    });

    // Strict OTA updates filter: XIAO must see ONLY v1.5.0, NEVER v3.0.0 (16MB)
    const updRes = await req("/api/firmware/updates", { headers: { Cookie: userCookie } });
    expect(updRes.status).toBe(200);
    const updJson = (await updRes.json()) as {
      applicableUpdates: Array<{
        controllerId: string;
        availableRelease: { id: string; version: string };
      }>;
    };
    const xiaoUpdate = updJson.applicableUpdates.find(
      (u) => u.controllerId === xiaoCtrl.controller.id
    );
    expect(xiaoUpdate).toBeDefined();
    expect(xiaoUpdate!.availableRelease.id).toBe(rel8.id);
    expect(xiaoUpdate!.availableRelease.version).toBe("1.5.0");

    // Attempting to start 16MB OTA on 8MB XIAO MUST fail with 400
    const badStart = await req("/api/firmware/ota/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        controllerId: xiaoCtrl.controller.id,
        releaseId: rel16.id,
      }),
    });
    expect(badStart.status).toBe(400);

    // X-Homecore-* device binary download guard checks (rejects with 403)
    const mismatchChipDl = await req(`/api/device/firmware/ota/${rel8.id}`, {
      headers: {
        Authorization: `Bearer ${xiaoCreds.device_api_token}`,
        "X-Homecore-Chip-Family": "esp32c3",
        "X-Homecore-Board-Slug": "seeed-xiao-esp32s3",
        "X-Homecore-Flash-Mb": "8",
      },
    });
    expect(mismatchChipDl.status).toBe(403);

    const mismatchBoardDl = await req(`/api/device/firmware/ota/${rel16.id}`, {
      headers: {
        Authorization: `Bearer ${xiaoCreds.device_api_token}`,
        "X-Homecore-Chip-Family": "esp32s3",
        "X-Homecore-Board-Slug": "seeed-xiao-esp32s3",
        "X-Homecore-Flash-Mb": "8",
      },
    });
    expect(mismatchBoardDl.status).toBe(403);

    const mismatchPartitionDl = await req(`/api/device/firmware/ota/${rel8.id}`, {
      headers: {
        Authorization: `Bearer ${xiaoCreds.device_api_token}`,
        "X-Homecore-Chip-Family": "esp32s3",
        "X-Homecore-Board-Slug": "seeed-xiao-esp32s3",
        "X-Homecore-Flash-Mb": "8",
        "X-Homecore-Partition-Scheme": "dual_ota_4mb",
      },
    });
    expect(mismatchPartitionDl.status).toBe(403);

    const validDl = await req(`/api/device/firmware/ota/${rel8.id}`, {
      headers: {
        Authorization: `Bearer ${xiaoCreds.device_api_token}`,
        "X-Homecore-Chip-Family": "esp32s3",
        "X-Homecore-Board-Slug": "seeed-xiao-esp32s3",
        "X-Homecore-Flash-Mb": "8",
        "X-Homecore-Partition-Scheme": "dual_ota_8mb",
      },
    });
    expect(validDl.status).toBe(200);
    expect(validDl.headers.get("X-Firmware-Sha256")).toBe(rel8.sha);

    // 6. USB flash event logging records detectedFlashSizeMb + reportedBoardSlug
    const usbEvt = await req("/api/firmware/usb-flash-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        releaseId: rel8.id,
        controllerId: xiaoCtrl.controller.id,
        status: "succeeded",
        chipDetected: "ESP32-S3 (QFN56)",
        detectedFlashSizeMb: 8,
        reportedBoardSlug: "seeed-xiao-esp32s3",
      }),
    });
    expect(usbEvt.status).toBe(200);

    // 7. Simplified release upload: auto-resolves technical specs from compatibleBoardIds,
    //    rejects incompatible multi-board groups & bad .bin headers, and honors draft / hardwareVerified defaults
    const s3v10Board = bySlug.get("esp32-s3-devkitc-1-v1-0")!;
    const c3Board = bySlug.get("esp32-c3-devkitm-1")!;

    const autoForm = new FormData();
    autoForm.append("name", "HomecoreOS Unified 8MB S3");
    autoForm.append("version", "4.0.0-rc1");
    autoForm.append("channel", "beta");
    autoForm.append("releaseNotes", "Auto-resolved from board catalog");
    autoForm.append("compatibleBoardIds", JSON.stringify([xiaoS3Board.id, s3v10Board.id]));
    autoForm.append("hardwareVerified", "false");
    autoForm.append("publish", "false");
    autoForm.append(
      "usbFile",
      new File([makeFakeEspIdfImage(640)], "s3-8m-usb.bin", { type: "application/octet-stream" })
    );
    autoForm.append(
      "otaFile",
      new File([makeFakeEspIdfImage(512)], "s3-8m-ota.bin", { type: "application/octet-stream" })
    );
    const autoRes = await req("/api/admin/firmware/release", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: autoForm,
    });
    expect(autoRes.status).toBe(201);
    const autoPayload = (await autoRes.json()) as {
      release: {
        chip_family: string;
        target_board_slug: string | null;
        partition_scheme: string;
        psram_mode: string;
        flash_mode: string;
        flash_freq: string;
        flash_size_mb: number;
        hardware_verified: boolean;
        status: string;
        published_at: string | null;
      };
      files: Array<{ file_type: string; flash_address: string }>;
    };
    expect(autoPayload.release.chip_family).toBe("esp32s3");
    expect(autoPayload.release.target_board_slug).toBeNull();
    expect(autoPayload.release.partition_scheme).toBe("dual_ota_8mb");
    expect(autoPayload.release.psram_mode).toBe("octal");
    expect(autoPayload.release.flash_mode).toBe("qio");
    expect(autoPayload.release.flash_freq).toBe("80m");
    expect(autoPayload.release.flash_size_mb).toBe(8);
    expect(autoPayload.release.hardware_verified).toBe(false);
    expect(autoPayload.release.status).toBe("draft");
    expect(autoPayload.release.published_at).toBeNull();
    expect(autoPayload.files.find((f) => f.file_type === "usb_factory")?.flash_address).toBe("0x0");
    expect(autoPayload.files.find((f) => f.file_type === "ota_app")?.flash_address).toBe("0x20000");

    // Reject mixing 16MB and 8MB boards on simplified upload (must upload separate builds)
    const mixedFlashForm = new FormData();
    mixedFlashForm.append("name", "Mixed S3");
    mixedFlashForm.append("version", "4.0.1");
    mixedFlashForm.append("channel", "stable");
    mixedFlashForm.append("compatibleBoardIds", JSON.stringify([s3N16Board.id, xiaoS3Board.id]));
    mixedFlashForm.append(
      "otaFile",
      new File([makeFakeEspIdfImage(512)], "mixed.bin", { type: "application/octet-stream" })
    );
    const mixedFlashRes = await req("/api/admin/firmware/release", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: mixedFlashForm,
    });
    expect(mixedFlashRes.status).toBe(400);

    // Reject real ESP32-C3 extended header binary uploaded for an ESP32-S3 board
    const wrongChipOta = new Uint8Array(512);
    wrongChipOta[0] = 0xe9;
    wrongChipOta[1] = 0x04;
    wrongChipOta[8] = 0xee;
    wrongChipOta[12] = 5; // ESP32-C3 chip ID
    wrongChipOta[23] = 1;
    const wrongChipForm = new FormData();
    wrongChipForm.append("name", "Wrong Chip");
    wrongChipForm.append("version", "4.0.2");
    wrongChipForm.append("channel", "stable");
    wrongChipForm.append("compatibleBoardIds", JSON.stringify([xiaoS3Board.id]));
    wrongChipForm.append("publish", "true");
    wrongChipForm.append(
      "otaFile",
      new File([wrongChipOta], "c3-on-s3.bin", { type: "application/octet-stream" })
    );
    const wrongChipRes = await req("/api/admin/firmware/release", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: wrongChipForm,
    });
    expect(wrongChipRes.status).toBe(400);

    // Publish immediately with hardwareVerified=false keeps C3 board catalog_only
    const c3AutoForm = new FormData();
    c3AutoForm.append("name", "HomecoreOS C3 Unverified");
    c3AutoForm.append("version", "4.1.0");
    c3AutoForm.append("channel", "stable");
    c3AutoForm.append("compatibleBoardIds", JSON.stringify([c3Board.id]));
    c3AutoForm.append("hardwareVerified", "false");
    c3AutoForm.append("publish", "true");
    c3AutoForm.append(
      "otaFile",
      new File([wrongChipOta], "c3-ota.bin", { type: "application/octet-stream" })
    );
    const c3AutoRes = await req("/api/admin/firmware/release", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: c3AutoForm,
    });
    expect(c3AutoRes.status).toBe(201);
    const c3AutoJson = (await c3AutoRes.json()) as {
      release: { chip_family: string; partition_scheme: string; flash_size_mb: number; status: string; hardware_verified: boolean };
    };
    expect(c3AutoJson.release.chip_family).toBe("esp32c3");
    expect(c3AutoJson.release.partition_scheme).toBe("dual_ota_4mb");
    expect(c3AutoJson.release.flash_size_mb).toBe(4);
    expect(c3AutoJson.release.status).toBe("published");
    expect(c3AutoJson.release.hardware_verified).toBe(false);

    boardCheckRes = await req("/api/admin/boards", { headers: { Cookie: adminCookie } });
    boardCheck = ((await boardCheckRes.json()) as { boards: Array<{ slug: string; firmware_status: string }> }).boards;
    expect(boardCheck.find((b) => b.slug === "esp32-c3-devkitm-1")!.firmware_status).toBe("catalog_only");
  });
});
