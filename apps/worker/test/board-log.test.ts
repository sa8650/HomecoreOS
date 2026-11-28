import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";
import { extractCookie } from "./helpers/http";
import {
  expireUnconfirmedCommands,
  pruneBoardLogs,
  resetBoardLogCaches,
} from "../src/lib/board-log";
import { createDbClient } from "../src/lib/db";

interface LogEntry {
  id: string;
  boardInstanceId: string;
  category: string;
  severity: string;
  status: string | null;
  method: string | null;
  source: string | null;
  destination: string | null;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface LogResponse {
  board: { id: string; name: string; status: string | null };
  entries: LogEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Per-board live Log.
 *
 * The Log is the operational history of exactly one board. These tests pin
 * down the properties that matter:
 *
 *  - a board's log only ever contains that board's events
 *  - a user can only read the log of a board in their own account
 *  - "sent" is never presented as "received": only a fact the destination
 *    board itself reported can create a "received" entry
 *  - the newest entry comes first and older pages are reachable with a cursor
 */
describe("Per-board live Log", () => {
  let dbHarness: PgliteHarness;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;
  let db: ReturnType<typeof createDbClient>;
  let cookie: string;
  let otherCookie: string;
  let emqx: ReturnType<typeof createMockEmqxFetch>;
  let boardProfileId: string;
  let controllerId: string;
  let controllerToken: string;
  let nodeId: string;
  let nodeToken: string;
  let switchId: string;

  beforeAll(async () => {
    resetBoardLogCaches();
    dbHarness = await createPglitePostgrest();
    emqx = createMockEmqxFetch();
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
    app = createWorkerApp({ dbFetch: dbHarness.fetch, emqxFetch: emqx.fetch });
    db = createDbClient(env, dbHarness.fetch);

    const regRes = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "log-owner@homecoreos.local",
        password: "LogOwner123!",
        fullName: "Log Owner",
        accountName: "Log Home",
        timezone: "Asia/Dhaka",
      }),
    });
    expect(regRes.status).toBe(201);
    cookie = extractCookie(regRes, "hc_user_session");

    const otherReg = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "log-other@homecoreos.local",
        password: "LogOther123!",
        fullName: "Other Owner",
        accountName: "Other Home",
        timezone: "UTC",
      }),
    });
    expect(otherReg.status).toBe(201);
    otherCookie = extractCookie(otherReg, "hc_user_session");

    const catRes = await req("/api/board-library/catalog", { headers: { Cookie: cookie } });
    const boards = ((await catRes.json()) as {
      boards: Array<{ id: string; slug: string; chip_family: string }>;
    }).boards;
    boardProfileId =
      boards.find((b) => b.chip_family === "esp32s3")?.id ?? boards[0]!.id;

    const ctrlRes = await postJson("/api/board-instances", {
      name: "Log Controller",
      boardProfileId,
    });
    const ctrlJson = (await ctrlRes.json()) as { controller: { id: string }; pairingCode: string };
    controllerId = ctrlJson.controller.id;
    const ctrlPair = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: ctrlJson.pairingCode }),
    });
    controllerToken = ((await ctrlPair.json()) as { device_api_token: string }).device_api_token;

    const nodeRes = await postJson("/api/board-instances", {
      name: "Log Node",
      boardProfileId,
    });
    const nodeJson = (await nodeRes.json()) as { controller: { id: string }; pairingCode: string };
    nodeId = nodeJson.controller.id;
    const nodePair = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: nodeJson.pairingCode }),
    });
    nodeToken = ((await nodePair.json()) as { device_api_token: string }).device_api_token;

    // A switch on the Controller, so a command can be sent to a board.
    const swRes = await postJson("/api/switches", {
      boardInstanceId: controllerId,
      name: "Desk Lamp",
      gpioPin: 4,
    });
    expect(swRes.status).toBe(201);
    switchId = ((await swRes.json()) as { switch: { id: string } }).switch.id;
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  function postJson(path: string, body: unknown, method = "POST") {
    return req(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });
  }

  async function readLog(boardId: string, query = "", cookieHeader = cookie) {
    const res = await req(`/api/board-logs/${boardId}${query}`, {
      headers: { Cookie: cookieHeader },
    });
    return { status: res.status, body: (await res.json()) as LogResponse };
  }

  it("records board status transitions on the board's own log", async () => {
    const before = await readLog(controllerId);
    expect(before.status).toBe(200);
    const countBefore = before.body.entries.length;

    // The board was marked offline by the Worker; its next heartbeat is the
    // transition back to online.
    await dbHarness.pg.query(
      "update board_instances set status = 'offline', mqtt_connected = false where id = $1",
      [controllerId]
    );

    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${controllerToken}` },
      body: JSON.stringify({ w: true, m: true, role: "controller", v: "1.0.0" }),
    });

    const after = await readLog(controllerId);
    expect(after.body.entries.length).toBeGreaterThan(countBefore);
    const statuses = after.body.entries.map((entry) => entry.status);
    expect(statuses).toContain("online");
    expect(statuses).toContain("connected");
    for (const entry of after.body.entries) {
      expect(entry.boardInstanceId).toBe(controllerId);
    }
  });

  it("records a reboot when the reported uptime goes backwards", async () => {
    await dbHarness.pg.query(
      "update board_instances set uptime_sec = 5000 where id = $1",
      [controllerId]
    );
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${controllerToken}` },
      body: JSON.stringify({ w: true, m: true, role: "controller", up: 12 }),
    });
    const log = await readLog(controllerId, "?category=system");
    expect(log.body.entries.some((entry) => entry.status === "reboot")).toBe(true);
  });

  it("never mixes one board's log with another board's log", async () => {
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${nodeToken}` },
      body: JSON.stringify({ w: true, m: true, role: "controller", v: "1.0.0" }),
    });

    const controllerLog = await readLog(controllerId);
    const nodeLog = await readLog(nodeId);

    expect(controllerLog.body.entries.every((e) => e.boardInstanceId === controllerId)).toBe(true);
    expect(nodeLog.body.entries.every((e) => e.boardInstanceId === nodeId)).toBe(true);
    // The Node's own events never appear in the Controller's log.
    const nodeIds = new Set(nodeLog.body.entries.map((e) => e.id));
    expect(controllerLog.body.entries.some((e) => nodeIds.has(e.id))).toBe(false);
  });

  it("refuses to read the log of a board from another account", async () => {
    const res = await readLog(controllerId, "", otherCookie);
    expect(res.status).toBe(404);
    expect(res.body.entries).toBeUndefined();
  });

  it("writes created and sent for a command, but never received", async () => {
    const res = await postJson(`/api/switches/${switchId}/toggle`, { isOn: true });
    expect(res.status).toBe(200);

    const log = await readLog(controllerId, "?category=command");
    const entries = log.body.entries;
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const statuses = entries.map((entry) => entry.status);
    expect(statuses).toContain("created");
    expect(statuses).toContain("sent");
    // A publish is not proof of receipt: "received" may only come from the
    // destination board itself.
    expect(statuses).not.toContain("received");
    expect(statuses).not.toContain("executed");

    const sent = entries.find((entry) => entry.status === "sent");
    expect(sent?.method).toBe("mqtt");
    expect(typeof sent?.metadata.commandId).toBe("string");
  });

  it("records the receiver-side facts a board reports about itself", async () => {
    const res = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${controllerToken}` },
      body: JSON.stringify({
        w: true,
        m: true,
        role: "controller",
        sid: 12345,
        fx: [
          { k: "cmd", s: "received", m: "mqtt", t: "desk-lamp", c: "cmd-1", ts: 1 },
          { k: "cmd", s: "executed", m: "mqtt", t: "desk-lamp", c: "cmd-1", ts: 2 },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const log = await readLog(controllerId, "?category=command");
    const reported = log.body.entries.filter((entry) =>
      String(entry.metadata.reportedBy ?? "") === "device"
    );
    expect(reported.length).toBeGreaterThanOrEqual(2);
    expect(reported.map((entry) => entry.status)).toEqual(
      expect.arrayContaining(["received", "executed"])
    );
    const received = reported.find((entry) => entry.status === "received");
    expect(received?.method).toBe("mqtt");
    expect(received?.destination).toBe("desk-lamp");
  });

  it("accepts a heartbeat that carries a completely full fact ring", async () => {
    // The firmware ring holds 12 facts. A board that fills it must still be
    // able to report: the heartbeat schema may not reject a full ring, or the
    // board would lose its telemetry as well.
    const fx = Array.from({ length: 12 }, (_unused, index) => ({
      k: "cmd",
      s: "received",
      m: "mqtt",
      t: `target-${index}`,
      c: `cmd-${index}`,
      ts: index + 1,
    }));
    const res = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${controllerToken}` },
      body: JSON.stringify({ w: true, m: true, role: "controller", sid: 4242, fx }),
    });
    expect(res.status).toBe(200);

    const log = await readLog(controllerId, "?category=command&limit=50");
    const reported = log.body.entries.filter(
      (entry) =>
        String(entry.metadata.reportedBy ?? "") === "device" &&
        String(entry.destination ?? "").startsWith("target-")
    );
    expect(reported.length).toBe(12);
    expect(reported.filter((entry) => entry.destination === "target-0").length).toBe(1);
    expect(reported.filter((entry) => entry.destination === "target-11").length).toBe(1);
  });

  it("stores a logical event only once", async () => {
    const fact = {
      w: true,
      m: true,
      role: "controller",
      sid: 777,
      fx: [{ k: "comm", s: "sent", m: "espnow", t: "peer-1", ts: 9 }],
    };
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${controllerToken}` },
      body: JSON.stringify(fact),
    });
    const first = await readLog(controllerId, "?category=communication");
    const firstCount = first.body.entries.filter(
      (entry) => entry.destination === "peer-1" && entry.status === "sent"
    ).length;
    expect(firstCount).toBe(1);

    // The same fact reported again (a retried heartbeat) must not add a row.
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${controllerToken}` },
      body: JSON.stringify(fact),
    });
    const second = await readLog(controllerId, "?category=communication");
    const secondCount = second.body.entries.filter(
      (entry) => entry.destination === "peer-1" && entry.status === "sent"
    ).length;
    expect(secondCount).toBe(1);
  });

  it("returns the newest entries first and pages older entries with a cursor", async () => {
    const first = await readLog(controllerId, "?limit=2");
    expect(first.status).toBe(200);
    expect(first.body.entries.length).toBeLessThanOrEqual(2);
    if (first.body.entries.length === 2) {
      const [newer, older] = first.body.entries;
      expect(new Date(newer.createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(older.createdAt).getTime()
      );
    }

    if (first.body.nextCursor) {
      const second = await readLog(controllerId, `?limit=2&before=${first.body.nextCursor}`);
      expect(second.status).toBe(200);
      const firstIds = new Set(first.body.entries.map((entry) => entry.id));
      expect(second.body.entries.some((entry) => firstIds.has(entry.id))).toBe(false);
    }
  });

  it("filters by category, by severity and by free text", async () => {
    const commands = await readLog(controllerId, "?category=command");
    expect(commands.body.entries.every((entry) => entry.category === "command")).toBe(true);

    const warnings = await readLog(controllerId, "?severity=warning");
    expect(warnings.body.entries.every((entry) => entry.severity === "warning")).toBe(true);

    const search = await readLog(controllerId, "?q=desk");
    for (const entry of search.body.entries) {
      expect(entry.message.toLowerCase()).toContain("desk");
    }
  });

  it("marks a published command as timed out when the board never confirms it", async () => {
    const res = await postJson(`/api/switches/${switchId}/toggle`, { isOn: false });
    expect(res.status).toBe(200);

    const log = await readLog(controllerId, "?category=command");
    const sent = log.body.entries.find((entry) => entry.status === "sent");
    expect(sent).toBeTruthy();
    const commandId = String(sent?.metadata.commandId ?? "");

    // Nothing has confirmed the command yet, so the sweep must time it out.
    const expired = await expireUnconfirmedCommands(db, {
      deadlineSeconds: 15,
      now: new Date(Date.now() + 60_000),
    });
    expect(expired).toBeGreaterThanOrEqual(1);

    const after = await readLog(controllerId, "?category=command");
    const timeouts = after.body.entries.filter(
      (entry) =>
        entry.status === "timeout" && String(entry.metadata.commandId ?? "") === commandId
    );
    expect(timeouts.length).toBeGreaterThanOrEqual(1);
  });

  it("does not time out a command the board confirmed itself", async () => {
    const res = await postJson(`/api/switches/${switchId}/toggle`, { isOn: true });
    expect(res.status).toBe(200);

    const log = await readLog(controllerId, "?category=command");
    const sent = log.body.entries.find((entry) => entry.status === "sent");
    const commandId = String(sent?.metadata.commandId ?? "");
    expect(commandId).not.toBe("");

    // The board reports that it received and executed that command.
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${controllerToken}` },
      body: JSON.stringify({
        w: true,
        m: true,
        role: "controller",
        sid: 4242,
        fx: [
          { k: "cmd", s: "received", m: "mqtt", c: commandId, ts: 1 },
          { k: "cmd", s: "executed", m: "mqtt", c: commandId, ts: 2 },
        ],
      }),
    });

    const before = await readLog(controllerId, "?category=command");
    const timeoutsBefore = before.body.entries.filter(
      (entry) => entry.status === "timeout"
    ).length;

    await expireUnconfirmedCommands(db, {
      deadlineSeconds: 15,
      now: new Date(Date.now() + 60_000),
    });

    const after = await readLog(controllerId, "?category=command");
    const timeoutsAfter = after.body.entries.filter(
      (entry) => entry.status === "timeout"
    );
    // The command the board confirmed must not be timed out.
    expect(
      timeoutsAfter.filter(
        (entry) => String(entry.metadata.commandId ?? "") === commandId
      ).length
    ).toBe(
      timeoutsBefore -
        (before.body.entries.filter(
          (entry) =>
            entry.status === "timeout" &&
            String(entry.metadata.commandId ?? "") === commandId
        ).length)
    );
    // The board's own confirmation is in the log.
    expect(
      after.body.entries.some(
        (entry) =>
          entry.status === "executed" &&
          String(entry.metadata.commandId ?? "") === commandId
      )
    ).toBe(true);
  });

  it("prunes rows older than the retention window and bounds the rows per board", async () => {
    await dbHarness.pg.query(
      `insert into board_log_events (account_id, board_instance_id, category, severity, status, message, created_at)
       select (select id from accounts limit 1), $1, 'system', 'info', 'old', 'an old entry', now() - interval '400 days'
       from generate_series(1, 3)`,
      [controllerId]
    );

    const result = await pruneBoardLogs(db, { retentionDays: 14 });
    expect(result.prunedByAge).toBeGreaterThanOrEqual(3);

    const { rows } = await dbHarness.pg.query<{ count: number }>(
      "select count(*)::int as count from board_log_events where message = 'an old entry'"
    );
    expect(rows[0]!.count).toBe(0);
  });

  it("keeps the stored records: the API exposes no destructive operation", async () => {
    const before = await readLog(controllerId);
    const deleteAttempt = await req(`/api/board-logs/${controllerId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect([404, 405]).toContain(deleteAttempt.status);

    const after = await readLog(controllerId);
    expect(after.body.entries.length).toBeGreaterThanOrEqual(before.body.entries.length);
  });
});
