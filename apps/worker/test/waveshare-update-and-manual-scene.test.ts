import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import type { ImportPreview, ImportRunResult } from "../src/lib/official-board-import";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName}`);
  return `${cookieName}=${match[1]}`;
}

describe("Waveshare import, NodeMCU ESP8266 seeding, Update Board endpoint, and Manual Scene automations", () => {
  let dbHarness: PgliteHarness;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;
  let adminCookie = "";
  let userCookie = "";

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

    const syncFetch = vi.fn(async () =>
      new Response("<!doctype html><html><body>Waveshare Wiki</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    );

    app = createWorkerApp({
      dbFetch: dbHarness.fetch,
      emqxFetch: emqxMock.fetch,
      syncFetch: syncFetch as unknown as typeof fetch,
    });

    const adminBoot = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "waveshare-admin@homecore.local",
        fullName: "Catalog Admin",
        password: "AdminStrong!99",
      }),
    });
    expect(adminBoot.status).toBe(201);
    adminCookie = extractCookie(adminBoot, "hc_admin_session");

    const reg = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "scene-user@homecore.local",
        password: "SceneUser!23",
        fullName: "Scene User",
        accountName: "Smart Things Home",
      }),
    });
    expect(reg.status).toBe(201);
    userCookie = extractCookie(reg, "hc_user_session");
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  const adminJson = (path: string, body?: unknown, method = "POST") =>
    req(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const userJson = (path: string, body?: unknown, method = "POST") =>
    req(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  it("seeds Waveshare ESP32-S3-Zero and NodeMCU ESP8266 in the public board catalog", async () => {
    const res = await req("/api/boards/catalog", { headers: { Cookie: userCookie } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      boards: Array<{ slug: string; manufacturer: string; chip_family: string; gpio_definitions: unknown[] }>;
    };

    const waveshare = data.boards.find((b) => b.slug === "waveshare-esp32-s3-zero");
    expect(waveshare).toBeDefined();
    expect(waveshare?.manufacturer).toBe("Waveshare");
    expect(waveshare?.chip_family).toBe("esp32s3");
    expect(waveshare?.gpio_definitions.length).toBeGreaterThanOrEqual(20);

    const nodemcu = data.boards.find((b) => b.slug === "nodemcu-esp8266");
    expect(nodemcu).toBeDefined();
    expect(nodemcu?.chip_family).toBe("esp8266");
    expect(nodemcu?.gpio_definitions.length).toBeGreaterThanOrEqual(15);
  });

  it("previews and imports Waveshare ESP boards and updates only existing boards on POST /api/admin/boards/update", async () => {
    const previewRes = await adminJson("/api/admin/boards/import/preview", {
      provider: "waveshare",
    });
    expect(previewRes.status).toBe(200);
    const { preview } = (await previewRes.json()) as { preview: ImportPreview };
    expect(preview.provider).toBe("waveshare");
    expect(preview.candidates).toHaveLength(5);

    const s3Zero = preview.candidates.find((c) => c.slug === "waveshare-esp32-s3-zero");
    const c6Zero = preview.candidates.find((c) => c.slug === "waveshare-esp32-c6-zero");
    expect(s3Zero?.status).toBe("in_library");
    expect(s3Zero?.existingBoardId).toBeTruthy();
    expect(c6Zero?.status).toBe("new");
    expect(c6Zero?.selectable).toBe(true);

    // Import only waveshare-esp32-c6-zero
    const commitRes = await adminJson("/api/admin/boards/import", {
      provider: "waveshare",
      slugs: ["waveshare-esp32-c6-zero"],
      publish: true,
    });
    expect(commitRes.status).toBe(200);
    const { run: importRun } = (await commitRes.json()) as { run: ImportRunResult };
    expect(importRun.importedCount).toBe(1);

    // Run POST /api/admin/boards/update — refreshes existing boards WITHOUT inserting un-imported boards
    const updateRes = await adminJson("/api/admin/boards/update", {});
    expect(updateRes.status).toBe(200);
    const { run } = (await updateRes.json()) as {
      run: {
        status: string;
        totalPresentCount: number;
        updatedCount: number;
        skippedCount: number;
      };
    };
    expect(run.status).toBe("succeeded");
    expect(run.totalPresentCount).toBe(14);
    expect(run.updatedCount).toBeGreaterThan(0);

    // Verify un-imported Waveshare boards were NOT inserted by Update Board
    const listRes = await req("/api/admin/boards", { headers: { Cookie: adminCookie } });
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as { boards: Array<{ slug: string }> };
    const slugs = new Set(listData.boards.map((b) => b.slug));
    expect(slugs.has("waveshare-esp32-s3-zero")).toBe(true);
    expect(slugs.has("waveshare-esp32-c6-zero")).toBe(true);
    expect(slugs.has("nodemcu-esp8266")).toBe(true);
    expect(slugs.has("waveshare-esp32-s3-relay-6ch")).toBe(false);
  });

  it("creates, dry-run tests, and manually runs a manual Scene automation rule", async () => {
    const catalogRes = await req("/api/boards/catalog", { headers: { Cookie: userCookie } });
    const catalogData = (await catalogRes.json()) as {
      boards: Array<{ id: string; slug: string }>;
    };
    const s3BoardId = catalogData.boards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!.id;

    const ctrlRes = await userJson("/api/controllers", {
      name: "Scene Hub",
      boardCatalogId: s3BoardId,
    });
    expect(ctrlRes.status).toBe(201);
    const ctrlId = ((await ctrlRes.json()) as { controller: { id: string } }).controller.id;

    const swRes = await userJson("/api/switches", {
      name: "Ambient Lamp",
      controllerId: ctrlId,
      gpioPin: 4,
    });
    expect(swRes.status).toBe(201);
    const switchId = ((await swRes.json()) as { switch: { id: string } }).switch.id;

    // Create a manual Scene automation rule
    const createRes = await userJson("/api/automations", {
      name: "Movie Night Scene",
      folderName: "Scenes",
      executionMode: "cloud",
      triggerConfig: { type: "manual" },
      actionsConfig: [
        {
          type: "scene",
          sceneName: "Movie Night",
          targets: [{ kind: "switch", switchId, isOn: true }],
        },
      ],
    });
    expect(createRes.status).toBe(201);
    const ruleId = ((await createRes.json()) as { automation: { id: string } }).automation.id;

    // Dry-run test the manual Scene
    const testRes = await userJson(`/api/automations/${ruleId}/test`, { dryRun: true });
    expect(testRes.status).toBe(200);
    const testData = (await testRes.json()) as {
      conditionsMatched: boolean;
      plannedActions: Array<{ summary: string }>;
    };
    expect(testData.conditionsMatched).toBe(true);
    expect(testData.plannedActions.length).toBeGreaterThan(0);

    // Manually run the Scene and confirm the switch turned ON
    const runRes = await userJson(`/api/automations/${ruleId}/run`, {});
    expect(runRes.status).toBe(200);
    const runData = (await runRes.json()) as { executedCount: number; errors: string[] };
    expect(runData.executedCount).toBe(1);
    expect(runData.errors).toEqual([]);

    const switchesRes = await req("/api/switches", { headers: { Cookie: userCookie } });
    const switchesData = (await switchesRes.json()) as {
      switches: Array<{
        id: string;
        is_on: boolean;
        state_status?: string;
        desired_state?: Record<string, unknown>;
      }>;
    };
    // The scene records an ON intent; `is_on` stays the confirmed value until
    // the controller reports back.
    const sceneSw = switchesData.switches.find((s) => s.id === switchId);
    expect(sceneSw?.state_status).toBe("pending");
    expect(sceneSw?.desired_state).toEqual({ on: true });
  });
});
