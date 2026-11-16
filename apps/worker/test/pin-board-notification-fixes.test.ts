import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GpioPinDefinition } from "@homecoreos/shared";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import { emitNotification } from "../src/lib/notifications";
import { createDbClient } from "../src/lib/db";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName} in ${header}`);
  return `${cookieName}=${match[1]}`;
}

function makePin(pin: number, overrides: Partial<GpioPinDefinition> = {}): GpioPinDefinition {
  return {
    pin,
    label: `GPIO${pin}`,
    board_pin_name: `D${pin}`,
    header_side: pin % 2 === 0 ? "left" : "right",
    header_position: pin + 1,
    board_note: `Custom note ${pin}`,
    capabilities: {
      digital_in: true,
      digital_out: true,
      pwm: true,
      adc: pin <= 10,
      i2c: true,
      spi: true,
      uart: false,
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
    ...overrides,
  };
}

describe("Pin Management, Board Import, Board Update, and Notification Fixes", () => {
  let dbHarness: PgliteHarness;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;
  let emqxShouldFail = false;

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
      emqxFetch: async (input, init) => {
        if (emqxShouldFail) {
          return new Response("EMQX unreachable", { status: 503 });
        }
        return emqxMock.fetch(input, init);
      },
      syncFetch: async () => new Response("offline", { status: 503 }),
    });
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  async function req(path: string, init?: RequestInit): Promise<Response> {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  function jsonReq(path: string, method: string, cookie: string, body?: unknown) {
    return req(path, {
      method,
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it("verifies pin metadata parity, custom/catalog board conflict guards, community_partner import, update preservation, and multi-user notification isolation", async () => {
    const db = createDbClient(env, dbHarness.fetch);

    // 1. Bootstrap Super Admin 1 + add Operator Admin 2
    const bootRes = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "super@homecoreos.local",
        fullName: "Super Admin",
        password: "AdminPassword123!",
      }),
    });
    expect(bootRes.status).toBe(201);
    const admin1Cookie = extractCookie(bootRes, "hc_admin_session");

    const addOpRes = await jsonReq("/api/admin/platform-staff", "POST", admin1Cookie, {
      email: "operator@homecoreos.local",
      fullName: "Operator Admin",
      password: "OperatorPassword123!",
      role: "operator",
    });
    expect(addOpRes.status).toBe(201);

    const loginOpRes = await req("/api/admin/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "operator@homecoreos.local",
        password: "OperatorPassword123!",
      }),
    });
    expect(loginOpRes.status).toBe(200);
    const admin2Cookie = extractCookie(loginOpRes, "hc_admin_session");

    // 2. Register Owner A + invite/create Member B in the SAME customer account
    const regOwnerRes = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@homecoreos.local",
        password: "OwnerPassword123!",
        fullName: "Account Owner",
        accountName: "Shared Smart Home",
      }),
    });
    expect(regOwnerRes.status).toBe(201);
    const ownerCookie = extractCookie(regOwnerRes, "hc_user_session");
    const ownerData = (await regOwnerRes.json()) as {
      account: { id: string };
      user: { id: string };
    };
    const accountId = ownerData.account.id;

    const addMemberRes = await jsonReq("/api/account/staff", "POST", ownerCookie, {
      email: "member@homecoreos.local",
      fullName: "Account Member",
      password: "MemberPassword123!",
      role: "operator",
    });
    expect(addMemberRes.status).toBe(201);

    const loginMemberRes = await req("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "member@homecoreos.local",
        password: "MemberPassword123!",
      }),
    });
    expect(loginMemberRes.status).toBe(200);
    const memberCookie = extractCookie(loginMemberRes, "hc_user_session");

    // ------------------------------------------------------------------
    // A. PIN MANAGEMENT: my-boards & custom boards preserve pin metadata
    //    and resolved firmware compatibility; unverified catalog save blocked
    // ------------------------------------------------------------------
    const customCreateRes = await jsonReq("/api/boards/custom", "POST", ownerCookie, {
      manufacturer: "Acme",
      model: "Custom S3 Lab",
      revision: "v1.0",
      chipFamily: "esp32s3",
      chipVariant: "ESP32-S3-WROOM-1",
      flashSizeMb: 16,
      psramSizeMb: 8,
      gpioDefinitions: [makePin(4), makePin(5), makePin(6)],
    });
    expect(customCreateRes.status).toBe(201);
    const customBoardId = ((await customCreateRes.json()) as { board: { id: string } }).board.id;

    const [customListRes, myBoardsRes] = await Promise.all([
      req("/api/boards/custom", { headers: { Cookie: ownerCookie } }),
      req("/api/boards/my-boards", { headers: { Cookie: ownerCookie } }),
    ]);
    expect(customListRes.status).toBe(200);
    expect(myBoardsRes.status).toBe(200);

    const customList = (await customListRes.json()) as {
      boards: Array<{
        id: string;
        supports_ble: boolean;
        partition_scheme: string;
        gpio_definitions: GpioPinDefinition[];
      }>;
    };
    const myBoards = (await myBoardsRes.json()) as {
      customBoards: Array<{
        id: string;
        supports_ble: boolean;
        gpio_definitions: GpioPinDefinition[];
      }>;
    };

    const fetchedCustom = customList.boards.find((b) => b.id === customBoardId)!;
    expect(fetchedCustom.supports_ble).toBe(true);
    expect(fetchedCustom.partition_scheme).toBeTruthy();
    expect(fetchedCustom.gpio_definitions[0]?.board_pin_name).toBe("D4");
    expect(fetchedCustom.gpio_definitions[0]?.header_side).toBe("left");
    expect(fetchedCustom.gpio_definitions[0]?.board_note).toBe("Custom note 4");

    const fetchedMyCustom = myBoards.customBoards.find((b) => b.id === customBoardId)!;
    expect(fetchedMyCustom.supports_ble).toBe(true);
    expect(fetchedMyCustom.gpio_definitions[0]?.board_pin_name).toBe("D4");
    expect(fetchedMyCustom.gpio_definitions[0]?.header_position).toBe(5);

    // Create an unverified catalog board and verify users CANNOT save it to my-boards
    const unverifiedCreateRes = await jsonReq("/api/admin/boards", "POST", admin1Cookie, {
      slug: "espressif-unverified-test-board",
      manufacturer: "Espressif",
      model: "Unverified Test DevKit",
      revision: "v1.0",
      chipFamily: "esp32s3",
      chipVariant: "ESP32-S3",
      flashSizeMb: 8,
      psramSizeMb: 0,
      isAvailable: false,
      verificationStatus: "needs_verification",
      gpioDefinitions: [makePin(4)],
    });
    expect(unverifiedCreateRes.status).toBe(201);
    const unverifiedBoardId = (
      (await unverifiedCreateRes.json()) as { board: { id: string } }
    ).board.id;

    // Force is_available=true in DB to prove POST /my-boards/:catalogId ALSO checks verification_status
    await db
      .from("board_catalog")
      .update({ is_available: true })
      .eq("id", unverifiedBoardId);

    const saveUnverifiedRes = await jsonReq(
      `/api/boards/my-boards/${unverifiedBoardId}`,
      "POST",
      ownerCookie
    );
    expect(saveUnverifiedRes.status).toBe(404);

    // Reset back to hidden
    await db
      .from("board_catalog")
      .update({ is_available: false })
      .eq("id", unverifiedBoardId);

    // ------------------------------------------------------------------
    // B. BOARD UPDATE: Active controller pin/chip-family conflict guards +
    //    admin PATCH validation + Update Board preservation
    // ------------------------------------------------------------------
    const homesRes = await req("/api/homes", { headers: { Cookie: ownerCookie } });
    const homeId = ((await homesRes.json()) as { homes: Array<{ id: string }> }).homes[0]!.id;
    const roomRes = await jsonReq("/api/homes/rooms", "POST", ownerCookie, {
      homeId,
      name: "Lab Room",
    });
    expect(roomRes.status).toBe(201);
    const roomId = ((await roomRes.json()) as { room: { id: string } }).room.id;

    // Pair controller on our custom board and assign a device to GPIO 4
    const pairCustomRes = await jsonReq("/api/controllers", "POST", ownerCookie, {
      homeId,
      roomId,
      customBoardId,
      name: "Custom Lab Hub",
    });
    expect(pairCustomRes.status).toBe(201);
    const customCtrlId = (
      (await pairCustomRes.json()) as { controller: { id: string } }
    ).controller.id;

    const devOnPin4Res = await jsonReq("/api/devices", "POST", ownerCookie, {
      controllerId: customCtrlId,
      roomId,
      name: "Lab Relay",
      deviceType: "relay",
      gpioPin: 4,
    });
    expect(devOnPin4Res.status).toBe(201);

    const customBase = {
      manufacturer: "Acme",
      model: "Custom S3 Lab",
      revision: "v1.0",
      chipFamily: "esp32s3",
      chipVariant: "ESP32-S3-WROOM-1",
      flashSizeMb: 16,
      psramSizeMb: 8,
    };

    // Removing GPIO 4 from the custom board must be blocked with 409!
    const breakCustomPinRes = await jsonReq(
      `/api/boards/custom/${customBoardId}`,
      "PATCH",
      ownerCookie,
      {
        ...customBase,
        gpioDefinitions: [makePin(5), makePin(6)],
      }
    );
    expect(breakCustomPinRes.status).toBe(409);

    // Changing chipFamily while controller is active must be blocked with 409!
    const breakChipRes = await jsonReq(
      `/api/boards/custom/${customBoardId}`,
      "PATCH",
      ownerCookie,
      {
        ...customBase,
        chipFamily: "esp32c3",
        gpioDefinitions: [makePin(4), makePin(5), makePin(6)],
      }
    );
    expect(breakChipRes.status).toBe(409);

    // Adding GPIO 7 while keeping GPIO 4 valid must succeed!
    const safeCustomPatchRes = await jsonReq(
      `/api/boards/custom/${customBoardId}`,
      "PATCH",
      ownerCookie,
      {
        ...customBase,
        gpioDefinitions: [makePin(4), makePin(5), makePin(6), makePin(7)],
      }
    );
    expect(safeCustomPatchRes.status).toBe(200);

    // Admin PATCH validation even when is_available is false: reject invalid input-only + digital_out
    const badAdminPatchRes = await jsonReq(
      `/api/admin/boards/${unverifiedBoardId}`,
      "PATCH",
      admin1Cookie,
      {
        is_available: false,
        gpio_definitions: [
          makePin(4, {
            restrictions: {
              input_only: true,
              reserved: false,
              strapping_pin: false,
              flash_psram_conflict: false,
              usb_jtag_conflict: false,
            },
          }),
        ],
      }
    );
    expect(badAdminPatchRes.status).toBe(400);

    // Admin PATCH valid pin verification returns gpio_definitions
    const verifyPatchRes = await jsonReq(
      `/api/admin/boards/${unverifiedBoardId}`,
      "PATCH",
      admin1Cookie,
      {
        verification_status: "verified",
        is_available: true,
        gpio_definitions: [makePin(4), makePin(5)],
      }
    );
    expect(verifyPatchRes.status).toBe(200);
    const verifiedBoardBody = (await verifyPatchRes.json()) as {
      board: { verification_status: string; gpio_definitions: GpioPinDefinition[] };
    };
    expect(verifiedBoardBody.board.verification_status).toBe("verified");
    expect(verifiedBoardBody.board.gpio_definitions).toHaveLength(2);

    // Pair controller on catalog board, assign GPIO 4, then verify admin PATCH removing GPIO 4 returns 409
    const pairCatalogRes = await jsonReq("/api/controllers", "POST", ownerCookie, {
      homeId,
      roomId,
      boardCatalogId: unverifiedBoardId,
      name: "Catalog Guard Hub",
    });
    expect(pairCatalogRes.status).toBe(201);
    const catalogCtrlId = (
      (await pairCatalogRes.json()) as { controller: { id: string } }
    ).controller.id;

    const catDevRes = await jsonReq("/api/devices", "POST", ownerCookie, {
      controllerId: catalogCtrlId,
      roomId,
      name: "Catalog Relay",
      deviceType: "relay",
      gpioPin: 4,
    });
    expect(catDevRes.status).toBe(201);

    const adminBreakPinRes = await jsonReq(
      `/api/admin/boards/${unverifiedBoardId}`,
      "PATCH",
      admin1Cookie,
      {
        gpio_definitions: [makePin(5)],
      }
    );
    expect(adminBreakPinRes.status).toBe(409);

    // Update Board preservation: mark an existing Espressif board as needs_verification
    // with custom image_url & revision_notes, run POST /api/admin/boards/update, verify BOTH preserved!
    const adminBoardsRes = await req("/api/admin/boards", {
      headers: { Cookie: admin1Cookie },
    });
    const adminBoards = (
      (await adminBoardsRes.json()) as {
        boards: Array<{ id: string; slug: string; image_url: string | null }>;
      }
    ).boards;
    const s3Board = adminBoards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;
    expect(s3Board).toBeDefined();

    await db
      .from("board_catalog")
      .update({
        verification_status: "needs_verification",
        image_url: "https://cdn.example.com/custom-s3-photo.png",
        revision_notes: "Admin hold: verifying rev 1.2 strapping",
      })
      .eq("id", s3Board.id);

    const updateRunRes = await jsonReq("/api/admin/boards/update", "POST", admin1Cookie);
    expect(updateRunRes.status).toBe(200);

    const { data: s3After } = await db
      .from("board_catalog")
      .select("verification_status,image_url,revision_notes")
      .eq("id", s3Board.id)
      .single();
    const s3AfterRow = s3After as {
      verification_status: string;
      image_url: string | null;
      revision_notes: string | null;
    };
    expect(s3AfterRow.verification_status).toBe("needs_verification");
    expect(s3AfterRow.image_url).toBe("https://cdn.example.com/custom-s3-photo.png");
    expect(s3AfterRow.revision_notes).toBe("Admin hold: verifying rev 1.2 strapping");

    // ------------------------------------------------------------------
    // C. BOARD IMPORT: community_partner provider (NodeMCU ESP8266)
    // ------------------------------------------------------------------
    const cpPreviewRes = await jsonReq(
      "/api/admin/boards/import/preview",
      "POST",
      admin1Cookie,
      { provider: "community_partner" }
    );
    expect(cpPreviewRes.status).toBe(200);
    const cpPreview = (await cpPreviewRes.json()) as {
      preview: {
        provider: string;
        candidates: Array<{ slug: string; status: string }>;
      };
    };
    expect(cpPreview.preview.provider).toBe("community_partner");
    expect(cpPreview.preview.candidates.some((c) => c.slug === "nodemcu-esp8266")).toBe(true);

    // Remove NodeMCU (unused) and restore it cleanly via community_partner import
    const nodeMcu = adminBoards.find((b) => b.slug === "nodemcu-esp8266")!;
    expect(nodeMcu).toBeDefined();
    const delNodeRes = await req(`/api/admin/boards/${nodeMcu.id}`, {
      method: "DELETE",
      headers: { Cookie: admin1Cookie },
    });
    expect(delNodeRes.status).toBe(200);

    const restoreNodeRes = await jsonReq("/api/admin/boards/import", "POST", admin1Cookie, {
      provider: "community_partner",
      slugs: ["nodemcu-esp8266"],
      publish: true,
    });
    expect(restoreNodeRes.status).toBe(200);
    const restoreBody = (await restoreNodeRes.json()) as {
      run: { restoredCount: number };
    };
    expect(restoreBody.run.restoredCount).toBe(1);

    // ------------------------------------------------------------------
    // D. NOTIFICATIONS: Multi-member preferences, per-user read/clear
    //    isolation (user + admin), and EMQX category
    // ------------------------------------------------------------------
    // Owner disables controller_offline_online; Member leaves default (true)
    const ownerPrefRes = await jsonReq("/api/notifications/preferences", "PATCH", ownerCookie, {
      controller_offline_online: false,
    });
    expect(ownerPrefRes.status).toBe(200);

    const emitCtrlRes = await emitNotification(db, {
      scope: "user",
      accountId,
      category: "controller",
      eventKey: "controller.offline",
      preferenceKey: "controller_offline_online",
      severity: "warning",
      title: "Hub Offline Alert",
      message: "Hub missed heartbeat",
    });
    // Must STILL be created because Member B has controller_offline_online enabled!
    expect(emitCtrlRes.created).toBe(true);
    const ctrlNotifId = emitCtrlRes.notification!.id;

    // Owner must NOT see it (preference disabled), Member MUST see it!
    const [ownerList1, memberList1] = await Promise.all([
      req("/api/notifications", { headers: { Cookie: ownerCookie } }).then((r) =>
        r.json() as Promise<{ notifications: Array<{ id: string }>; unreadCount: number }>
      ),
      req("/api/notifications", { headers: { Cookie: memberCookie } }).then((r) =>
        r.json() as Promise<{ notifications: Array<{ id: string; is_read: boolean }>; unreadCount: number }>
      ),
    ]);
    expect(ownerList1.notifications.some((n) => n.id === ctrlNotifId)).toBe(false);
    expect(memberList1.notifications.some((n) => n.id === ctrlNotifId)).toBe(true);

    // Shared notification visible to BOTH Owner & Member
    const emitSharedRes = await emitNotification(db, {
      scope: "user",
      accountId,
      category: "device",
      eventKey: "device.command_failed",
      preferenceKey: "device_disconnected",
      severity: "danger",
      title: "Relay Command Failed",
      message: "Broker publish error",
    });
    expect(emitSharedRes.created).toBe(true);
    const sharedNotifId = emitSharedRes.notification!.id;

    // Owner marks read and clears all -> must NOT affect Member!
    const ownerReadRes = await jsonReq(
      `/api/notifications/${sharedNotifId}/read`,
      "POST",
      ownerCookie
    );
    expect(ownerReadRes.status).toBe(200);
    const ownerClearRes = await jsonReq("/api/notifications/clear", "POST", ownerCookie);
    expect(ownerClearRes.status).toBe(200);

    const [ownerAfterClear, memberAfterOwnerClear] = await Promise.all([
      req("/api/notifications", { headers: { Cookie: ownerCookie } }).then((r) =>
        r.json() as Promise<{ notifications: Array<{ id: string }>; unreadCount: number }>
      ),
      req("/api/notifications", { headers: { Cookie: memberCookie } }).then((r) =>
        r.json() as Promise<{
          notifications: Array<{ id: string; is_read: boolean }>;
          unreadCount: number;
        }>
      ),
    ]);
    expect(ownerAfterClear.notifications).toHaveLength(0);
    expect(ownerAfterClear.unreadCount).toBe(0);
    const memberShared = memberAfterOwnerClear.notifications.find((n) => n.id === sharedNotifId);
    expect(memberShared).toBeDefined();
    expect(memberShared!.is_read).toBe(false);
    expect(memberAfterOwnerClear.unreadCount).toBeGreaterThanOrEqual(2);

    // Multi-admin isolation + EMQX category check
    emqxShouldFail = true;
    const emqxStatusRes = await req("/api/admin/emqx/status", {
      headers: { Cookie: admin1Cookie },
    });
    expect(emqxStatusRes.status).toBe(200);
    emqxShouldFail = false;

    const admin1EmqxNotifs = (await req("/api/admin/notifications?category=emqx", {
      headers: { Cookie: admin1Cookie },
    }).then((r) => r.json())) as {
      notifications: Array<{ id: string; category: string; title: string; is_read: boolean }>;
    };
    expect(admin1EmqxNotifs.notifications.length).toBeGreaterThanOrEqual(1);
    const emqxNotifId = admin1EmqxNotifs.notifications[0]!.id;
    expect(admin1EmqxNotifs.notifications[0]!.category).toBe("emqx");

    // Admin 1 clears the EMQX alert -> Admin 2 MUST still see it UNREAD!
    const admin1DelRes = await req(`/api/admin/notifications/${emqxNotifId}`, {
      method: "DELETE",
      headers: { Cookie: admin1Cookie },
    });
    expect(admin1DelRes.status).toBe(200);

    const admin2EmqxNotifs = (await req("/api/admin/notifications?category=emqx", {
      headers: { Cookie: admin2Cookie },
    }).then((r) => r.json())) as {
      notifications: Array<{ id: string; is_read: boolean }>;
    };
    const admin2Alert = admin2EmqxNotifs.notifications.find((n) => n.id === emqxNotifId);
    expect(admin2Alert).toBeDefined();
    expect(admin2Alert!.is_read).toBe(false);
  });
});
