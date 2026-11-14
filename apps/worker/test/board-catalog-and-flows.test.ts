import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

describe("Official Board Catalog Sync, XIAO ESP32-S3, and Visual Flow Graph Execution", () => {
  let dbHarness: PgliteHarness;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;
  const webhookCalls: Array<{ url: string; method: string; body?: string }> = [];

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

    const syncFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("espressif.com/products/devkits")) {
        return new Response(
          `<html><body>
            <div>
              <a href="https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html">ESP32-S3-DevKitC-1</a>
              <span>16 MB Flash · 8 MB Octal PSRAM</span>
            </div>
            <div>
              <a href="https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32h4/esp32-h4-devkitm-1/user_guide.html">ESP32-H4-DevKitM-1</a>
              <span>4 MB Flash</span>
            </div>
          </body></html>`,
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      return new Response(
        `<html><body><ul><li>esp32_s3_devkitc_1</li><li>esp32_c6_devkitc_1</li></ul></body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    });

    const webhookFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      webhookCalls.push({
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method ?? "POST",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    });

    app = createWorkerApp({
      dbFetch: dbHarness.fetch,
      emqxFetch: emqxMock.fetch,
      syncFetch: syncFetch as unknown as typeof fetch,
      webhookFetch: webhookFetch as unknown as typeof fetch,
    });
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  it("syncs official Espressif catalog safely without publishing unverified boards, isolates firmware compatibility, and runs multi-branch flow graphs", async () => {
    // 1. Bootstrap platform admin
    const adminBoot = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "catalog-admin@homecore.local",
        fullName: "Catalog Admin",
        password: "AdminStrong!99",
      }),
    });
    expect(adminBoot.status).toBe(201);
    const adminCookie = extractCookie(adminBoot, "hc_admin_session");

    // 2. Run official Espressif catalog sync
    const syncRes = await req("/api/admin/boards/sync", {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    expect(syncRes.status).toBe(200);
    const syncBody = (await syncRes.json()) as {
      run: { status: string; discoveredCount: number; needsVerificationCount: number };
    };
    expect(syncBody.run.status).toBe("succeeded");
    expect(syncBody.run.needsVerificationCount).toBeGreaterThan(0);

    // 3. Admin boards endpoint returns verified + unverified + syncRuns; publishing unverified is blocked!
    const adminBoardsRes = await req("/api/admin/boards", {
      headers: { Cookie: adminCookie },
    });
    const adminBoardsJson = (await adminBoardsRes.json()) as {
      boards: Array<{
        id: string;
        slug: string;
        verification_status: string;
        firmware_status: string;
        is_available: boolean;
      }>;
      syncRuns: Array<{ id: string }>;
    };
    expect(adminBoardsJson.syncRuns.length).toBeGreaterThanOrEqual(1);
    const h4Board = adminBoardsJson.boards.find((b) => b.slug === "esp32-h4-devkitm-1");
    expect(h4Board).toBeDefined();
    expect(h4Board!.verification_status).toBe("needs_verification");
    expect(h4Board!.is_available).toBe(false);

    const publishUnverified = await req(`/api/admin/boards/${h4Board!.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ is_available: true }),
    });
    expect(publishUnverified.status).toBe(400);

    // 4. Register user and inspect public catalog
    const regRes = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "flowmaker@homecore.local",
        password: "MakerUser!23",
        fullName: "Flow Maker",
        accountName: "Flow Home",
      }),
    });
    const userCookie = extractCookie(regRes, "hc_user_session");

    const catRes = await req("/api/boards/catalog", {
      headers: { Cookie: userCookie },
    });
    const catJson = (await catRes.json()) as {
      boards: Array<{
        id: string;
        slug: string;
        catalog_category: string;
        firmware_status: string;
        image_url: string | null;
        board_layout: { leftHeader: { pins: unknown[] }; rightHeader: { pins: unknown[] } };
      }>;
    };
    // Unverified boards are hidden from users
    expect(catJson.boards.some((b) => b.slug === "esp32-h4-devkitm-1")).toBe(false);

    const xiao = catJson.boards.find((b) => b.slug === "seeed-xiao-esp32s3")!;
    expect(xiao).toBeDefined();
    expect(xiao.catalog_category).toBe("partner");
    expect(xiao.firmware_status).toBe("catalog_only");
    expect(xiao.image_url).toBeNull();
    expect(xiao.board_layout.leftHeader.pins).toHaveLength(7);

    // 5. Create controller, switches, sensor, and test multi-branch Visual Flow Graph
    const ctrlRes = await req("/api/controllers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ name: "XIAO Node", boardCatalogId: xiao.id }),
    });
    expect(ctrlRes.status).toBe(201);
    const ctrlId = ((await ctrlRes.json()) as { controller: { id: string } }).controller.id;

    const swTrueRes = await req("/api/switches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ controllerId: ctrlId, name: "Cool Fan", gpioPin: 1 }),
    });
    const swFalseRes = await req("/api/switches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ controllerId: ctrlId, name: "Heater Relay", gpioPin: 2 }),
    });
    const senRes = await req("/api/sensors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        controllerId: ctrlId,
        name: "Room Temp",
        sensorType: "temperature_dht22",
        gpioPin: 3,
        unit: "°C",
      }),
    });
    const swTrueId = ((await swTrueRes.json()) as { switch: { id: string } }).switch.id;
    const swFalseId = ((await swFalseRes.json()) as { switch: { id: string } }).switch.id;
    const sensorId = ((await senRes.json()) as { sensor: { id: string } }).sensor.id;

    // Pair and report temperature 29.5°C
    const flowGraph = {
      version: 1,
      variables: [{ id: "v1", name: "alertTag", type: "string", initialValue: "nominal" }],
      nodes: [
        {
          id: "trig-1",
          kind: "trigger",
          position: { x: 80, y: 180 },
          label: "Manual / Temp Check",
          config: { triggerType: "manual" },
        },
        {
          id: "cond-1",
          kind: "condition",
          position: { x: 380, y: 180 },
          label: "Temp > 25°C",
          config: {
            conditionType: "sensor_value",
            sensorId,
            operator: "gt",
            threshold: 25,
          },
        },
        {
          id: "act-var",
          kind: "action",
          position: { x: 700, y: 80 },
          label: "Set Alert Tag",
          config: {
            actionType: "set_variable",
            variableName: "alertTag",
            variableValue: "hot",
          },
        },
        {
          id: "act-fan",
          kind: "action",
          position: { x: 1020, y: 80 },
          label: "Fan ON",
          config: { actionType: "switch_on", switchId: swTrueId },
        },
        {
          id: "act-heat",
          kind: "action",
          position: { x: 700, y: 290 },
          label: "Heater ON",
          config: { actionType: "switch_on", switchId: swFalseId },
        },
        {
          id: "act-webhook",
          kind: "action",
          position: { x: 1320, y: 80 },
          label: "Notify Webhook",
          config: {
            actionType: "http_request",
            httpMethod: "POST",
            httpUrl: "https://hooks.example.test/climate",
          },
        },
        {
          id: "act-notif",
          kind: "action",
          position: { x: 1320, y: 200 },
          label: "Push Alert",
          config: {
            actionType: "notification",
            notificationTitle: "High Temperature",
            notificationMessage: "Cool fan started",
            notificationSeverity: "warning",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trig-1", sourceHandle: "out", target: "cond-1", targetHandle: "in" },
        { id: "e2", source: "cond-1", sourceHandle: "true", target: "act-var", targetHandle: "in" },
        { id: "e3", source: "act-var", sourceHandle: "out", target: "act-fan", targetHandle: "in" },
        { id: "e4", source: "act-fan", sourceHandle: "out", target: "act-webhook", targetHandle: "in" },
        { id: "e5", source: "act-fan", sourceHandle: "out", target: "act-notif", targetHandle: "in" },
        { id: "e6", source: "cond-1", sourceHandle: "false", target: "act-heat", targetHandle: "in" },
      ],
    };

    // Set sensor value directly in DB to 29.5°C so condition TRUE branch triggers
    await dbHarness.pg.query(`UPDATE public.sensors SET last_value = 29.5 WHERE id = $1`, [
      sensorId,
    ]);

    const saveFlowRes = await req("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Climate Branch Flow",
        folderName: "Climate",
        executionMode: "cloud",
        flowGraph,
      }),
    });
    expect(saveFlowRes.status).toBe(201);
    const savedAuto = ((await saveFlowRes.json()) as {
      automation: { id: string; folder_name: string };
    }).automation;
    expect(savedAuto.folder_name).toBe("Climate");

    // Run flow manually and verify TRUE branch executed, FALSE branch skipped, webhook & notification fired!
    const runRes = await req(`/api/automations/${savedAuto.id}/run`, {
      method: "POST",
      headers: { Cookie: userCookie },
    });
    expect(runRes.status).toBe(200);
    const runJson = (await runRes.json()) as {
      executedCount: number;
      flowTrace: {
        variablesSnapshot: Record<string, unknown>;
        nodeResults: Record<string, { status: string }>;
        edgeStates: Record<string, string>;
      };
    };
    expect(runJson.executedCount).toBe(4);
    expect(runJson.flowTrace.variablesSnapshot.alertTag).toBe("hot");
    expect(runJson.flowTrace.nodeResults["act-fan"]!.status).toBe("executed");
    expect(runJson.flowTrace.nodeResults["act-heat"]!.status).toBe("skipped");
    expect(runJson.flowTrace.edgeStates["e2"]).toBe("active");
    expect(runJson.flowTrace.edgeStates["e6"]).toBe("inactive");
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]!.url).toBe("https://hooks.example.test/climate");

    // Dry-run test on saved flow returns full flowTrace without dispatching webhook again
    const testSavedRes = await req(`/api/automations/${savedAuto.id}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(testSavedRes.status).toBe(200);
    const testSavedJson = (await testSavedRes.json()) as {
      dryRun: boolean;
      conditionsMatched: boolean;
      flowTrace?: { nodeResults: Record<string, { status: string }> };
    };
    expect(testSavedJson.dryRun).toBe(true);
    expect(testSavedJson.conditionsMatched).toBe(true);
    expect(testSavedJson.flowTrace?.nodeResults["act-fan"]?.status).toBe("passed");
    expect(webhookCalls).toHaveLength(1);

    // Custom board creation + PATCH preserves header layout & pin annotations
    const customCreateRes = await req("/api/boards/custom", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        manufacturer: "CustomLab",
        model: "C6 Mini Node",
        chipFamily: "esp32c6",
        chipVariant: "ESP32-C6FH4",
        flashSizeMb: 4,
        psramSizeMb: 0,
        gpioDefinitions: [
          {
            pin: 2,
            label: "D0 / GPIO2",
            board_pin_name: "D0",
            header_side: "left",
            header_position: 1,
            capabilities: {
              digital_in: true,
              digital_out: true,
              pwm: true,
              adc: true,
              i2c: false,
              spi: false,
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
          },
        ],
      }),
    });
    expect(customCreateRes.status).toBe(201);
    const customBoardId = ((await customCreateRes.json()) as { board: { id: string } }).board.id;
    const customPatchRes = await req(`/api/boards/custom/${customBoardId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        manufacturer: "CustomLab",
        model: "C6 Mini Node v2",
        chipFamily: "esp32c6",
        chipVariant: "ESP32-C6FH4",
        flashSizeMb: 4,
        psramSizeMb: 0,
        gpioDefinitions: [
          {
            pin: 2,
            label: "D0 / GPIO2",
            board_pin_name: "D0",
            header_side: "left",
            header_position: 1,
            board_note: "Analog sensor input",
            capabilities: {
              digital_in: true,
              digital_out: true,
              pwm: true,
              adc: true,
              i2c: false,
              spi: false,
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
          },
        ],
      }),
    });
    expect(customPatchRes.status).toBe(200);
    const patchedBoard = ((await customPatchRes.json()) as {
      board: {
        model: string;
        gpio_definitions: Array<{ board_pin_name?: string; board_note?: string }>;
      };
    }).board;
    expect(patchedBoard.model).toBe("C6 Mini Node v2");
    expect(patchedBoard.gpio_definitions[0]?.board_pin_name).toBe("D0");
    expect(patchedBoard.gpio_definitions[0]?.board_note).toBe("Analog sensor input");

    // Reject cyclic flow graphs
    const cycleFlowRes = await req("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Broken Loop",
        flowGraph: {
          ...flowGraph,
          edges: [
            ...flowGraph.edges,
            { id: "e-loop", source: "act-fan", target: "cond-1" },
          ],
        },
      }),
    });
    expect(cycleFlowRes.status).toBe(400);
  });
});
