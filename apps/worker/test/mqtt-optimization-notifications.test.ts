import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
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

describe("MQTT Optimization, Consolidated Config Sync, Multi-Board Firmware, and Notifications", () => {
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

  it("handles consolidated config snapshots, hash dedup, ACK, compact heartbeat, notifications, preferences, and multi-board firmware validation", async () => {
    // 1. Bootstrap Admin & register User A + User B
    const bootRes = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin@homecoreos.local",
        fullName: "Platform Admin",
        password: "AdminPassword123!",
      }),
    });
    expect(bootRes.status).toBe(201);
    const adminCookie = extractCookie(bootRes, "hc_admin_session");

    const regARes = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alpha@homecoreos.local",
        password: "AlphaPassword123!",
        fullName: "Alpha User",
        accountName: "Alpha Home",
      }),
    });
    expect(regARes.status).toBe(201);
    const cookieA = extractCookie(regARes, "hc_user_session");

    const regBRes = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "beta@homecoreos.local",
        password: "BetaPassword123!",
        fullName: "Beta User",
        accountName: "Beta Home",
      }),
    });
    expect(regBRes.status).toBe(201);
    const cookieB = extractCookie(regBRes, "hc_user_session");

    // Admin received new_user_registrations notifications
    const adminNotifRes = await req("/api/admin/notifications", {
      headers: { Cookie: adminCookie },
    });
    expect(adminNotifRes.status).toBe(200);
    const adminNotifs = (await adminNotifRes.json()) as {
      notifications: Array<{ id: string; scope: string; event_key: string }>;
      unreadCount: number;
    };
    expect(adminNotifs.notifications.some((n) => n.event_key === "admin.user_registered")).toBe(true);
    expect(adminNotifs.notifications.every((n) => n.scope === "admin")).toBe(true);

    // 2. Fetch catalog boards for ESP32-S3 & ESP32-C3 (or create a custom board for C3 mismatch test)
    const boardsRes = await req("/api/admin/boards", {
      headers: { Cookie: adminCookie },
    });
    const { boards } = (await boardsRes.json()) as {
      boards: Array<{ id: string; slug: string; chip_family: string; flash_size_mb: number }>;
    };
    const s3Board = boards.find((b) => b.chip_family === "esp32s3")!;
    expect(s3Board).toBeDefined();

    const samplePins = [
      {
        pin: 4,
        label: "GPIO4",
        capabilities: {
          digital_in: true,
          digital_out: true,
          pwm: true,
          adc: true,
          i2c: true,
          spi: true,
          uart: true,
          touch: false,
          pull_up: true,
          pull_down: true,
        },
        restrictions: {
          input_only: false,
          reserved: false,
          strapping_pin: false,
          flash_psram_conflict: false,
          usb_jtag_conflict: false,
        },
      },
    ];

    // Create a second 4MB ESP32-C3 board via Admin API for multi-board & chip/flash validation tests
    const c3BoardRes = await req("/api/admin/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({
        slug: "esp32-c3-mini-4m",
        manufacturer: "Espressif",
        model: "ESP32-C3 Mini 4MB",
        revision: "v1.0",
        chipFamily: "esp32c3",
        chipVariant: "ESP32-C3",
        flashSizeMb: 4,
        psramSizeMb: 0,
        gpioDefinitions: samplePins,
      }),
    });
    expect(c3BoardRes.status).toBe(201);
    const { board: c3Board } = (await c3BoardRes.json()) as { board: { id: string } };

    // Also create a second 8MB ESP32-S3 board to test flash size rejection on 16MB firmware
    const s3SmallRes = await req("/api/admin/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({
        slug: "esp32-s3-mini-8m",
        manufacturer: "Espressif",
        model: "ESP32-S3 Mini 8MB",
        revision: "v1.0",
        chipFamily: "esp32s3",
        chipVariant: "ESP32-S3-FN8",
        flashSizeMb: 8,
        psramSizeMb: 0,
        gpioDefinitions: samplePins,
      }),
    });
    expect(s3SmallRes.status).toBe(201);
    const { board: s3SmallBoard } = (await s3SmallRes.json()) as { board: { id: string } };

    // 3. Test Multi-Board Firmware Upload Validation (reject chip mismatch & undersized flash; allow valid multi-board)
    const badChipForm = new FormData();
    badChipForm.append("file", new File([makeFakeEspIdfImage()], "fw.bin"));
    badChipForm.append("name", "HomecoreOS");
    badChipForm.append("version", "1.4.0");
    badChipForm.append("channel", "stable");
    badChipForm.append("chipFamily", "esp32s3");
    badChipForm.append("fileType", "usb_factory");
    badChipForm.append("flashAddress", "0x0");
    badChipForm.append("flashSize", "16MB");
    badChipForm.append("compatibleBoardIds", JSON.stringify([s3Board.id, c3Board.id]));
    const badChipRes = await req("/api/admin/firmware/single", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: badChipForm,
    });
    expect(badChipRes.status).toBe(400);

    const badFlashForm = new FormData();
    badFlashForm.append("file", new File([makeFakeEspIdfImage()], "fw.bin"));
    badFlashForm.append("name", "HomecoreOS");
    badFlashForm.append("version", "1.4.0");
    badFlashForm.append("channel", "stable");
    badFlashForm.append("chipFamily", "esp32s3");
    badFlashForm.append("fileType", "usb_factory");
    badFlashForm.append("flashAddress", "0x0");
    badFlashForm.append("flashSize", "16MB");
    badFlashForm.append("compatibleBoardIds", JSON.stringify([s3Board.id, s3SmallBoard.id]));
    const badFlashRes = await req("/api/admin/firmware/single", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: badFlashForm,
    });
    expect(badFlashRes.status).toBe(400);

    const goodFwForm = new FormData();
    goodFwForm.append("file", new File([makeFakeEspIdfImage()], "fw.bin"));
    goodFwForm.append("name", "HomecoreOS");
    goodFwForm.append("version", "1.4.0");
    goodFwForm.append("channel", "stable");
    goodFwForm.append("chipFamily", "esp32s3");
    goodFwForm.append("fileType", "usb_factory");
    goodFwForm.append("flashAddress", "0x0");
    goodFwForm.append("flashSize", "8MB");
    goodFwForm.append("compatibleBoardIds", JSON.stringify([s3Board.id, s3SmallBoard.id]));
    goodFwForm.append("publish", "true");
    const goodFwRes = await req("/api/admin/firmware/single", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: goodFwForm,
    });
    expect(goodFwRes.status).toBe(201);
    const { release: uploadedRel } = (await goodFwRes.json()) as {
      release: { id: string; compatible_board_ids: string[]; compatible_boards: Array<{ id: string }> };
    };
    expect(uploadedRel.compatible_board_ids).toEqual([s3Board.id, s3SmallBoard.id]);
    expect(uploadedRel.compatible_boards.length).toBe(2);

    // PATCH /api/admin/firmware/:id validates compatible_board_ids (rejects C3 chip mismatch; allows narrow update)
    const badPatchFwRes = await req(`/api/admin/firmware/${uploadedRel.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ compatible_board_ids: [s3Board.id, c3Board.id] }),
    });
    expect(badPatchFwRes.status).toBe(400);

    const goodPatchFwRes = await req(`/api/admin/firmware/${uploadedRel.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ compatible_board_ids: [s3Board.id] }),
    });
    expect(goodPatchFwRes.status).toBe(200);
    const patchedFw = (await goodPatchFwRes.json()) as {
      release: { compatible_board_ids: string[] };
    };
    expect(patchedFw.release.compatible_board_ids).toEqual([s3Board.id]);

    // Admin receives admin.firmware_published notification
    const adminFwNotifRes = await req("/api/admin/notifications?category=firmware", {
      headers: { Cookie: adminCookie },
    });
    const adminFwNotifs = (await adminFwNotifRes.json()) as {
      notifications: Array<{ event_key: string }>;
    };
    expect(adminFwNotifs.notifications.some((n) => n.event_key === "admin.firmware_published")).toBe(
      true
    );

    // 4. Create & Pair Controller for User A -> verify EMQX ACL includes config/# and config/ack
    const ctrlCreate = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ name: "Main Hub", boardCatalogId: s3Board.id }),
    });
    expect(ctrlCreate.status).toBe(201);
    const { controller, pairingCode } = (await ctrlCreate.json()) as {
      controller: { id: string };
      pairingCode: string;
    };

    const pairRes = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode,
        macAddress: "AA:BB:CC:DD:EE:11",
        firmwareVersion: "1.2.0",
        wifiSsid: "HomeWiFi",
        localIp: "192.168.1.22",
      }),
    });
    expect(pairRes.status).toBe(200);
    const pairBody = (await pairRes.json()) as {
      device_api_token: string;
      mqtt_username: string;
      topic_prefix: string;
      config: { revision: number; hash: string };
    };
    expect(pairBody.config.revision).toBeGreaterThanOrEqual(1);
    expect(pairBody.config.hash).toBeTruthy();

    // Now publish an OTA update targeting s3Board -> User A receives firmware.update_available, User B does not
    const otaFwForm = new FormData();
    otaFwForm.append("file", new File([makeFakeEspIdfImage()], "ota.bin"));
    otaFwForm.append("name", "HomecoreOS OTA");
    otaFwForm.append("version", "1.5.0");
    otaFwForm.append("channel", "stable");
    otaFwForm.append("chipFamily", "esp32s3");
    otaFwForm.append("fileType", "ota_app");
    otaFwForm.append("flashAddress", "0x10000");
    otaFwForm.append("flashSize", "16MB");
    otaFwForm.append("compatibleBoardIds", JSON.stringify([s3Board.id]));
    otaFwForm.append("publish", "true");
    const otaFwRes = await req("/api/admin/firmware/single", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: otaFwForm,
    });
    expect(otaFwRes.status).toBe(201);

    const userNotifAfterFw = await req("/api/notifications", {
      headers: { Cookie: cookieA },
    });
    const fwNotifBody = (await userNotifAfterFw.json()) as {
      notifications: Array<{ id: string; event_key: string; scope: string }>;
      unreadCount: number;
    };
    expect(fwNotifBody.notifications.some((n) => n.event_key === "firmware.update_available")).toBe(
      true
    );

    const userBNotifAfterFw = await req("/api/notifications", {
      headers: { Cookie: cookieB },
    });
    const fwNotifB = (await userBNotifAfterFw.json()) as {
      notifications: Array<{ event_key: string }>;
    };
    expect(fwNotifB.notifications.some((n) => n.event_key === "firmware.update_available")).toBe(
      false
    );

    const aclRules = emqxState.acls.get(pairBody.mqtt_username) as Array<{
      action: string;
      topic: string;
    }>;
    expect(aclRules.some((r) => r.action === "subscribe" && r.topic.endsWith("/config/#"))).toBe(true);
    expect(aclRules.some((r) => r.action === "publish" && r.topic.endsWith("/config/ack"))).toBe(true);

    // 5. Add a TV device & verify consolidated config snapshot MQTT push + hash dedup + ?knownRevision + ACK
    const pubsBefore = emqxState.published.length;
    const tvRes = await req("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        name: "Living Room TV",
        deviceType: "tv",
        controllerId: controller.id,
        gpioPin: 4,
      }),
    });
    expect(tvRes.status).toBe(201);
    const { device: tvDevice } = (await tvRes.json()) as { device: { id: string } };

    const snapshotPubs = emqxState.published
      .slice(pubsBefore)
      .filter((p) => p.topic === `${pairBody.topic_prefix}/config/snapshot`);
    expect(snapshotPubs.length).toBe(1);
    const snapshotPayload = JSON.parse(snapshotPubs[0]!.payload) as {
      revision: number;
      hash: string;
      devices: Array<{ id: string; device_type: string }>;
    };
    expect(snapshotPayload.devices.some((d) => d.id === tvDevice.id && d.device_type === "tv")).toBe(true);

    // Volatile state command ("on") & idempotent PATCH (unchanged structural hash) MUST NOT push redundant config/snapshot
    const pubsBeforeCmd = emqxState.published.length;
    const cmdRes = await req(`/api/devices/${tvDevice.id}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ state: "on" }),
    });
    expect(cmdRes.status).toBe(200);
    const idempotentPatchRes = await req(`/api/devices/${tvDevice.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ name: "Living Room TV" }),
    });
    expect(idempotentPatchRes.status).toBe(200);
    const redundantSnapPubs = emqxState.published
      .slice(pubsBeforeCmd)
      .filter((p) => p.topic === `${pairBody.topic_prefix}/config/snapshot`);
    expect(redundantSnapPubs.length).toBe(0);

    // GET /api/device/config?knownRevision=<current> returns { unchanged: true }
    const unchangedCfgRes = await req(
      `/api/device/config?knownRevision=${snapshotPayload.revision}`,
      { headers: { Authorization: `Bearer ${pairBody.device_api_token}` } }
    );
    expect(unchangedCfgRes.status).toBe(200);
    const unchangedCfgBody = (await unchangedCfgRes.json()) as { unchanged?: boolean; revision: number };
    expect(unchangedCfgBody.unchanged).toBe(true);

    // POST /api/device/config/ack acknowledges revision cleanly
    const ackRes = await req("/api/device/config/ack", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pairBody.device_api_token}`,
      },
      body: JSON.stringify({ revision: snapshotPayload.revision, hash: snapshotPayload.hash }),
    });
    expect(ackRes.status).toBe(200);

    // 6. Compact Heartbeat payload updates status & MQTT disconnect emits notification
    const hbRes = await req("/api/device/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pairBody.device_api_token}`,
      },
      body: JSON.stringify({
        r: -55,
        s: "HomeWiFi",
        ip: "192.168.1.22",
        v: "1.2.0",
        w: true,
        m: false,
        rev: snapshotPayload.revision,
      }),
    });
    expect(hbRes.status).toBe(200);

    const userNotifsAfterMqttDrop = await req("/api/notifications?category=controller", {
      headers: { Cookie: cookieA },
    });
    const ctrlNotifData = (await userNotifsAfterMqttDrop.json()) as {
      notifications: Array<{ id: string; event_key: string; is_read: boolean }>;
    };
    expect(ctrlNotifData.notifications.some((n) => n.event_key === "controller.mqtt_disconnected")).toBe(true);

    // 7. Tenant isolation & notification actions (read / unread / mark-all-read / preference suppression)
    const userBNotifs = await req("/api/notifications", {
      headers: { Cookie: cookieB },
    });
    const userBData = (await userBNotifs.json()) as {
      notifications: Array<{ event_key: string }>;
    };
    // User B must NOT see User A's controller MQTT disconnect alert
    expect(userBData.notifications.some((n) => n.event_key === "controller.mqtt_disconnected")).toBe(false);

    // User A marks all read, then toggles preference off and verifies suppression
    await req("/api/notifications/mark-all-read", {
      method: "POST",
      headers: { Cookie: cookieA },
    });
    const unreadCheck = await req("/api/notifications/unread-count", {
      headers: { Cookie: cookieA },
    });
    expect(((await unreadCheck.json()) as { unreadCount: number }).unreadCount).toBe(0);

    const prefPatch = await req("/api/notifications/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ security_events: false }),
    });
    expect(prefPatch.status).toBe(200);
    const prefJson = (await prefPatch.json()) as {
      preferences: { security_events: boolean };
    };
    expect(prefJson.preferences.security_events).toBe(false);

    // Password change emits security.password_changed, which is suppressed when security_events=false!
    await req("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        currentPassword: "AlphaPassword123!",
        newPassword: "AlphaPassword999!",
      }),
    });
    const afterPwChange = await req("/api/notifications?category=security", {
      headers: { Cookie: cookieA },
    });
    const secData = (await afterPwChange.json()) as {
      notifications: Array<{ event_key: string }>;
    };
    expect(secData.notifications.some((n) => n.event_key === "security.password_changed")).toBe(false);

    // Admin preference toggle & user isolation check (user cannot access admin notifications)
    const userOnAdminRes = await req("/api/admin/notifications", {
      headers: { Cookie: cookieA },
    });
    expect([401, 403]).toContain(userOnAdminRes.status);

    const adminPrefPatch = await req("/api/admin/notifications/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ platform_errors: false }),
    });
    expect(adminPrefPatch.status).toBe(200);
    const adminPrefData = (await adminPrefPatch.json()) as {
      preferences: { platform_errors: boolean };
    };
    expect(adminPrefData.preferences.platform_errors).toBe(false);
  });
});
