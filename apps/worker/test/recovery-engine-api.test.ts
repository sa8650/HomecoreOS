import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName} in ${header}`);
  return `${cookieName}=${match[1]}`;
}

describe("Unified Repair & Recovery API", () => {
  let dbHarness: PgliteHarness;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;
  let userCookie = "";
  let otherUserCookie = "";
  let boardId = "";
  let boardProfileId = "";
  let homeId = "";

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
    app = createWorkerApp({ dbFetch: dbHarness.fetch, emqxFetch: emqxMock.fetch });

    const reg = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "recovery-owner@homecoreos.local",
        password: "RecoveryPass123!",
        fullName: "Recovery Owner",
        accountName: "Recovery Home",
      }),
    });
    expect(reg.status).toBe(201);
    userCookie = extractCookie(reg, "hc_user_session");

    const other = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "recovery-other@homecoreos.local",
        password: "RecoveryPass123!",
        fullName: "Other Owner",
        accountName: "Other Home",
      }),
    });
    expect(other.status).toBe(201);
    otherUserCookie = extractCookie(other, "hc_user_session");

    const homesRes = await req("/api/homes", { headers: { Cookie: userCookie } });
    expect(homesRes.status).toBe(200);
    const homes = (await homesRes.json()) as { homes: Array<{ id: string }> };
    homeId = homes.homes[0].id;

    const catalogRes = await req("/api/board-library/catalog", {
      headers: { Cookie: userCookie },
    });
    const catalog = (await catalogRes.json()) as {
      boards: Array<{ id: string; slug: string }>;
    };
    boardProfileId = catalog.boards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!.id;

    const created = await req("/api/board-instances", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: "Recovery Test Hub",
        homeId,
        boardProfileId,
      }),
    });
    expect(created.status).toBe(201);
    const createdJson = (await created.json()) as { controller: { id: string }; pairingCode: string };
    boardId = createdJson.controller.id;

    // Pair it so the board behaves like a real installed controller.
    const pairRes = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: createdJson.pairingCode,
        macAddress: "AA:BB:CC:DD:EE:01",
        identityKey: "identity-key-for-recovery-tests-0123456789",
        firmwareVersion: "1.5.0",
        chipVariant: "esp32s3",
        boardSlug: "esp32-s3-devkitc-1-n16r8",
        wifiSsid: "Home24G",
        localIp: "192.168.1.50",
      }),
    });
    expect([200, 201]).toContain(pairRes.status);
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  async function startSession(transport: "wifi" | "ble" | "usb" = "ble") {
    return req("/api/recovery/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ boardInstanceId: boardId, transport }),
    });
  }

  it("requires an authenticated account staff session", async () => {
    const anon = await req("/api/recovery/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boardInstanceId: boardId, transport: "ble" }),
    });
    expect(anon.status).toBe(401);
  });

  it("never exposes another customer's board", async () => {
    const res = await req("/api/recovery/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: otherUserCookie },
      body: JSON.stringify({ boardInstanceId: boardId, transport: "usb" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects a connected board identity mismatch before opening a session", async () => {
    const res = await req("/api/recovery/sessions", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ boardInstanceId: boardId, transport: "usb", hardwareUidSuffix: "FFFF" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Connected board identity does not match this controller." });
  });

  it("starts one server-verified session with diagnostics and a plan", async () => {
    const res = await startSession("ble");
    expect([200, 201]).toContain(res.status);
    const json = (await res.json()) as {
      session: {
        id: string;
        status: string;
        transport: string;
        expiresAt: string;
        detectedProblems: string[];
      };
      server: {
        diagnostics: { checks: Array<{ id: string; status: string }>; status: string };
        plan: { actions: Array<{ id: string }> };
      };
      board: { id: string; name: string };
    };
    expect(json.session.transport).toBe("ble");
    expect(json.session.status).toBe("active");
    expect(json.session.id).toMatch(/[0-9a-f-]{36}/);
    expect(json.board.id).toBe(boardId);
    // The server mints its own 15-minute expiry.
    const ttlMs = Date.parse(json.session.expiresAt) - Date.now();
    expect(ttlMs).toBeGreaterThan(10 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000 + 5000);
    expect(json.server.diagnostics.checks.length).toBeGreaterThan(5);
    expect(Array.isArray(json.server.plan.actions)).toBe(true);
  });

  it("prevents two concurrent recovery sessions on the same board", async () => {
    const first = await startSession("ble");
    expect([200, 201]).toContain(first.status); // resumed for the same user
    const firstJson = (await first.json()) as { session: { id: string } };

    // A different account can never reach it at all.
    const foreign = await req("/api/recovery/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: otherUserCookie },
      body: JSON.stringify({ boardInstanceId: boardId, transport: "ble" }),
    });
    expect(foreign.status).toBe(404);

    // Close, then start fresh: no duplicate active row can exist.
    const abandon = await req(`/api/recovery/sessions/${firstJson.session.id}/abandon`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ reason: "test cleanup" }),
    });
    expect(abandon.status).toBe(200);

    const after = await startSession("usb");
    expect([200, 201]).toContain(after.status);
    const afterJson = (await after.json()) as { session: { id: string }; resumed: boolean };
    expect(afterJson.session.id).not.toBe(firstJson.session.id);
    expect(afterJson.resumed).toBe(false);
  });

  it("stores diagnostics without ever persisting secrets", async () => {
    const start = await startSession("wifi");
    const { session } = (await start.json()) as { session: { id: string } };

    const diag = await req(`/api/recovery/sessions/${session.id}/diagnostics`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        transport: "wifi",
        stage: "diagnostics",
        wifiCredentialsProvided: true,
        clientChecks: [
          { id: "wifi_connection", status: "fail", problem: "wifi_auth_failed", summary: "password rejected" },
        ],
      }),
    });
    expect(diag.status).toBe(200);
    const diagJson = (await diag.json()) as {
      diagnostics: { problems: string[] };
      plan: { actions: Array<{ id: string }> };
    };
    expect(Array.isArray(diagJson.diagnostics.problems)).toBe(true);

    const read = await req(`/api/recovery/sessions/${session.id}`, {
      headers: { Cookie: userCookie },
    });
    expect(read.status).toBe(200);
    const raw = await read.text();
    expect(raw).not.toMatch(/wifi_pass|mqtt_password|device_api_token|identity_key/i);
    expect(raw).not.toContain("RecoveryPass123!");

    await req(`/api/recovery/sessions/${session.id}/abandon`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ reason: "done" }),
    });
  });

  it("verifies a repair from server telemetry, not from the browser's claim", async () => {
    const start = await startSession("usb");
    const { session } = (await start.json()) as { session: { id: string } };

    // The browser claims success while the board has never reported a heartbeat.
    const complete = await req(`/api/recovery/sessions/${session.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        outcomes: [{ actionId: "rewrite_wifi", status: "applied", message: "wrote Wi-Fi" }],
        transportReleased: true,
      }),
    });
    expect(complete.status).toBe(200);
    const json = (await complete.json()) as {
      report: { finalStatus: string; verification: { status: string }; nextAction: string | null };
      serverVerified: string;
    };
    expect(json.report.verification.status).not.toBe("verified");
    expect(json.report.finalStatus).not.toBe("completed");
    expect(json.report.nextAction).toBeTruthy();
  });

  it("records a verified recovery when the board really reports healthy", async () => {
    const now = new Date().toISOString();
    await dbHarness.fetch(
      new Request(`https://test.supabase.co/rest/v1/board_instances?id=eq.${boardId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          status: "online",
          pairing_status: "paired",
          wifi_connected: true,
          wifi_ssid: "Home24G",
          wifi_rssi: -58,
          local_ip: "192.168.1.50",
          mqtt_connected: true,
          last_heartbeat_at: now,
          last_communication_at: now,
          last_config_synced_at: now,
          config_revision: 2,
          last_synced_config_revision: 2,
          pending_config_sync: false,
          last_error: null,
          firmware_version: "1.5.0",
        }),
      })
    );

    const start = await startSession("ble");
    const { session } = (await start.json()) as { session: { id: string } };

    const complete = await req(`/api/recovery/sessions/${session.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        outcomes: [{ actionId: "reconnect_mqtt", status: "applied", message: "MQTT reconnected" }],
        transportReleased: true,
      }),
    });
    expect(complete.status).toBe(200);
    const json = (await complete.json()) as {
      report: {
        finalStatus: string;
        finalTelemetry: { mqttConnected: boolean | null; connected: boolean | null };
        verification: { checks: Array<{ id: string; status: string }> };
      };
      session: { status: string };
    };
    expect(json.report.finalTelemetry.connected).toBe(true);
    expect(json.report.finalTelemetry.mqttConnected).toBe(true);
    const mqttCheck = json.report.verification.checks.find((c) => c.id === "mqtt_connected");
    expect(mqttCheck?.status).toBe("pass");
    const syncedCheck = json.report.verification.checks.find((c) => c.id === "config_synced");
    expect(syncedCheck?.status).toBe("pass");
    expect(json.session.status).toBe("completed");
  });

  it("closes a session that has already been completed", async () => {
    const start = await startSession("wifi");
    const { session } = (await start.json()) as { session: { id: string } };
    const complete = await req(`/api/recovery/sessions/${session.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ outcomes: [] }),
    });
    expect(complete.status).toBe(200);
    const again = await req(`/api/recovery/sessions/${session.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ outcomes: [] }),
    });
    expect(again.status).toBe(409);
  });

  it("returns recovery history scoped to the account", async () => {
    const res = await req("/api/recovery/history?limit=10", { headers: { Cookie: userCookie } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      sessions: Array<{ id: string; transport: string; status: string }>;
      pagination: { total: number };
    };
    expect(json.sessions.length).toBeGreaterThan(0);
    expect(json.pagination.total).toBeGreaterThan(0);
    expect(json.sessions.every((s) => ["wifi", "ble", "usb"].includes(s.transport))).toBe(true);

    const foreign = await req("/api/recovery/history", { headers: { Cookie: otherUserCookie } });
    const foreignJson = (await foreign.json()) as { sessions: unknown[] };
    expect(foreignJson.sessions).toEqual([]);
  });
});
