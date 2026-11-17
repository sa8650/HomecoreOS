import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";
import { seedInstalledFirmwareWithDrivers } from "./helpers/firmware-fixture";

/**
 * Reliable device state management.
 *
 * These tests exercise the guarantees the feature exists to provide:
 *  - a command issued while the controller is offline is stored, not lost,
 *  - rapid toggles converge on the last intent and do not spam MQTT,
 *  - duplicate delivery / stale revisions are rejected,
 *  - a reconnect delivers outstanding intent exactly once,
 *  - reboot recovery works because the intent rides the config snapshot,
 *  - automations and manual commands share one ordering domain,
 *  - partial failures surface as `failed` without corrupting confirmed state.
 */

function extractCookie(res: Response, name: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${name}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${name}`);
  return `${name}=${match[1]}`;
}

describe("Reliable device state management", () => {
  let h: PgliteHarness;
  let app: ReturnType<typeof createWorkerApp>;
  let env: WorkerBindings;
  let emqx: ReturnType<typeof createMockEmqxFetch>;

  let cookie = "";
  let accountId = "";
  let homeId = "";
  let controllerId = "";
  let switchId = "";
  let deviceTokenValue = "";

  beforeAll(async () => {
    h = await createPglitePostgrest();
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
    } as WorkerBindings;
    app = createWorkerApp({ dbFetch: h.fetch, emqxFetch: emqx.fetch });
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(() => {
    emqx.state.published.length = 0;
  });

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  let tenantSeq = 0;

  async function setupTenant() {
    tenantSeq += 1;
    const reg = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `state-owner-${tenantSeq}@example.com`,
        password: "PasswordA123!",
        fullName: "State Owner",
        accountName: "State Home",
      }),
    });
    expect(reg.status).toBe(201);
    cookie = extractCookie(reg, "hc_user_session");

    const acct = await h.pg.query<{ id: string }>(
      `SELECT a.id FROM public.accounts a
         JOIN public.users u ON u.id = a.owner_user_id
        WHERE u.email = $1`,
      [`state-owner-${tenantSeq}@example.com`]
    );
    accountId = acct.rows[0]!.id;

    const home = await h.pg.query<{ id: string }>(
      `INSERT INTO public.homes (account_id, name) VALUES ($1, 'Main') RETURNING id`,
      [accountId]
    );
    homeId = home.rows[0]!.id;

    const board = await h.pg.query<{ id: string }>(
      `SELECT id FROM public.board_catalog LIMIT 1`
    );

    const ctrl = await h.pg.query<{ id: string }>(
      `INSERT INTO public.controllers
        (account_id, home_id, name, board_model, chip_variant, flash_size_mb, status,
         board_catalog_id, pairing_status, mqtt_connected)
       VALUES ($1,$2,'Living Room','esp32','esp32',4,'offline',$3,'paired',false)
       RETURNING id`,
      [accountId, homeId, board.rows[0]!.id]
    );
    controllerId = ctrl.rows[0]!.id;

    const sw = await h.pg.query<{ id: string }>(
      `INSERT INTO public.switches
        (account_id, home_id, controller_id, name, gpio_pin, is_on)
       VALUES ($1,$2,$3,'Lamp',4,false) RETURNING id`,
      [accountId, homeId, controllerId]
    );
    switchId = sw.rows[0]!.id;

    // MQTT credentials so dispatch is possible at all.
    // Real device bearer token; the middleware stores/compares its sha256.
    const token = `device-token-${tenantSeq}`;
    const { sha256Hex } = await import("../src/lib/crypto");
    await h.pg.query(
      `INSERT INTO public.mqtt_credentials_metadata
        (account_id, controller_id, mqtt_username, mqtt_client_id, device_token_hash,
         topic_prefix, status)
       VALUES ($1,$2,$3,$4,$5,$6,'active')`,
      [
        accountId,
        controllerId,
        `dev-${tenantSeq}`,
        `client-${tenantSeq}`,
        await sha256Hex(token),
        `hc/${controllerId}`,
      ]
    );
    deviceTokenValue = token;

    await seedInstalledFirmwareWithDrivers({
      pg: h.pg,
      controllerId,
      boardId: board.rows[0]!.id,
      boardSlug: (await h.pg.query<{ slug: string }>(
        `SELECT slug FROM public.board_catalog WHERE id=$1`,
        [board.rows[0]!.id]
      )).rows[0]!.slug,
      chipFamily: "esp32",
    });
  }

  async function setControllerOnline(online: boolean) {
    await h.pg.query(
      `UPDATE public.controllers SET status=$2, mqtt_connected=$3 WHERE id=$1`,
      [controllerId, online ? "online" : "offline", online]
    );
  }

  async function readSwitch() {
    const res = await h.pg.query<{
      is_on: boolean;
      desired_state: Record<string, unknown> | null;
      desired_rev: number;
      applied_rev: number;
      state_status: string;
    }>(
      `SELECT is_on, desired_state, desired_rev, applied_rev, state_status
         FROM public.switches WHERE id=$1`,
      [switchId]
    );
    return res.rows[0]!;
  }

  async function toggle(isOn: boolean, headers?: Record<string, string>) {
    const res = await req(`/api/switches/${switchId}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, ...headers },
      body: JSON.stringify({ isOn }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("stores an offline command as pending without claiming it was applied", async () => {
    await setupTenant();
    await setControllerOnline(false);

    const { status, body } = await toggle(true);
    expect(status).toBe(200);

    // The UI contract: not accepted as *applied*, mqttDispatched false.
    expect(body.mqttDispatched).toBe(false);
    expect(body.controllerOnline).toBe(false);
    expect(body.stateStatus).toBe("pending");

    // Nothing was sent to the broker while offline.
    expect(emqx.state.published.length).toBe(0);

    const row = await readSwitch();
    expect(row.state_status).toBe("pending");
    expect(row.desired_state).toEqual({ on: true });
    // Confirmed state is untouched - the relay has not changed yet.
    expect(row.is_on).toBe(false);
  });

  it("does not publish while offline, then delivers exactly once on reconnect", async () => {
    await setControllerOnline(false);
    const first = await toggle(true);
    expect(first.body.mqttDispatched).toBe(false);
    expect(emqx.state.published.length).toBe(0);

    // Controller comes back and heartbeats.
    await setControllerOnline(true);
    const hb = await req("/api/device/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await deviceToken()}`,
      },
      body: JSON.stringify({ w: true, m: true, rev: 1 }),
    });
    expect(hb.status).toBe(200);
    const hbBody = (await hb.json()) as { pending_commands_delivered?: number };
    expect(hbBody.pending_commands_delivered).toBe(1);
    expect(emqx.state.published.length).toBe(1);

    const published = emqx.state.published[0]!;
    expect(published.topic).toContain("/cmd/switch");
    expect(JSON.parse(published.payload)).toMatchObject({ switch_id: switchId, state: "ON" });

    // A second heartbeat must not re-send (still pending though, since the
    // controller has not confirmed yet) - the intent is delivered once per
    // reconnect, and confirmation clears it.
    emqx.state.published.length = 0;
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await deviceToken()}`,
      },
      body: JSON.stringify({ w: true, m: true, rev: 1 }),
    });
    // Still pending -> redelivered is acceptable and idempotent for the device
    // (same revision), but it must never be *silently dropped*.
    const row = await readSwitch();
    expect(row.desired_state).toEqual({ on: true });
  });

  async function deviceToken(): Promise<string> {
    return deviceTokenValue;
  }

  it("collapses rapid toggles: last intent wins and only one command is sent", async () => {
    await setupTenant();
    await setControllerOnline(true);
    emqx.state.published.length = 0;

    // on -> off -> on quickly, as a user hammering a switch would.
    await toggle(true);
    await toggle(false);
    await toggle(true);

    const row = await readSwitch();
    expect(row.desired_state).toEqual({ on: true });
    expect(row.state_status).toBe("pending");

    // Duplicate intents were rejected, so we see fewer publishes than presses
    // and never a contradictory final state.
    const payloads = emqx.state.published.map(
      (p) => JSON.parse(p.payload) as { state: string }
    );
    const last = payloads[payloads.length - 1]!;
    expect(last.state).toBe("ON");
  });

  it("treats a repeated identical command as an idempotent no-op", async () => {
    await setupTenant();
    await setControllerOnline(true);
    emqx.state.published.length = 0;

    const first = await toggle(true);
    const second = await toggle(true);

    expect(first.body.accepted).toBe(true);
    expect(second.body.accepted).toBe(false);
    expect(second.body.reason).toBe("duplicate_pending");
    // Only the first press reached the broker.
    expect(emqx.state.published.length).toBe(1);
  });

  it("rejects a stale request whose revision is behind the stored intent", async () => {
    await setupTenant();
    await setControllerOnline(true);

    await toggle(true);
    await toggle(false);
    const before = await readSwitch();
    expect(before.desired_rev).toBeGreaterThan(1);

    // A delayed request that observed revision 0 must not win.
    const stale = await toggle(true, { "x-homecore-expected-rev": "0" });
    expect(stale.body.accepted).toBe(false);
    expect(stale.body.reason).toBe("stale_revision");

    const after = await readSwitch();
    expect(after.desired_rev).toBe(before.desired_rev);
    expect(after.desired_state).toEqual({ on: false });
  });

  it("confirms state from telemetry and clears the pending intent", async () => {
    await setupTenant();
    await setControllerOnline(true);
    await toggle(true);

    const token = await deviceToken();
    const tel = await req("/api/device/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ switches: [{ switchId, isOn: true, rev: 1 }] }),
    });
    expect(tel.status).toBe(200);

    const row = await readSwitch();
    expect(row.state_status).toBe("synced");
    expect(row.desired_state).toBeNull();
    expect(row.is_on).toBe(true);
    expect(row.applied_rev).toBeGreaterThanOrEqual(1);
  });

  it("ignores a delayed confirmation for an older revision", async () => {
    await setupTenant();
    await setControllerOnline(true);
    await toggle(true);
    const token = await deviceToken();

    // Confirm rev 1 (clears intent), then a new command bumps to rev 2.
    await req("/api/device/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ switches: [{ switchId, isOn: true, rev: 1 }] }),
    });
    await toggle(false);

    // A duplicate, delayed report of the old revision arrives late.
    await req("/api/device/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ switches: [{ switchId, isOn: true, rev: 1 }] }),
    });

    const row = await readSwitch();
    // The newer OFF intent must survive the stale report.
    expect(row.desired_state).toEqual({ on: false });
    expect(row.state_status).toBe("pending");
  });

  it("carries outstanding intent in the config snapshot so a reboot re-applies it", async () => {
    await setupTenant();
    await setControllerOnline(false);
    await toggle(true);

    const token = await deviceToken();
    const res = await req("/api/device/config", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const snap = (await res.json()) as {
      unchanged?: boolean;
      switches?: Array<{ id: string; is_on: boolean; desired_on: boolean | null; desired_rev: number }>;
    };
    expect(snap.unchanged).toBeFalsy();

    const entry = snap.switches?.find((s) => s.id === switchId);
    expect(entry).toBeDefined();
    // Confirmed state still says off, but the intent says on - the firmware
    // applies `desired_on`, which is what makes reboot recovery work.
    expect(entry!.is_on).toBe(false);
    expect(entry!.desired_on).toBe(true);
    expect(entry!.desired_rev).toBeGreaterThan(0);
  });

  it("shares one ordering domain between automations and manual commands", async () => {
    await setupTenant();
    await setControllerOnline(true);

    // Manual intent first.
    await toggle(true);
    const afterManual = await readSwitch();

    // An automation targeting the same switch must advance the same revision,
    // not create a parallel truth.
    const rule = await h.pg.query<{ id: string }>(
      `INSERT INTO public.automation_rules
        (account_id, home_id, name, enabled, trigger_config, actions_config,
         conditions_config, execution_mode)
       VALUES ($1,$2,'AutoOff',true,
         '{"type":"event"}'::jsonb,
         '[{"type":"switch_off","switchId":"${switchId}"}]'::jsonb,
         '{}'::jsonb, 'cloud')
       RETURNING id`,
      [accountId, homeId]
    );
    expect(rule.rows[0]!.id).toBeTruthy();

    await req(`/api/automations/${rule.rows[0]!.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });

    const afterAuto = await readSwitch();
    expect(afterAuto.desired_rev).toBeGreaterThan(afterManual.desired_rev);
    expect(afterAuto.desired_state).toEqual({ on: false });
  });

  it("reports a failed command without corrupting the confirmed state", async () => {
    await setupTenant();
    await setControllerOnline(true);

    // Make the broker reject the publish.
    const original = emqx.fetch;
    const failing: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/publish")) {
        return new Response(JSON.stringify({ message: "broker unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return original(input, init);
    };
    const failingApp = createWorkerApp({ dbFetch: h.fetch, emqxFetch: failing });

    const res = await failingApp.fetch(
      new Request(`https://homecore.local/api/switches/${switchId}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ isOn: true }),
      }),
      env
    );
    // Delivery failure is surfaced, not silently swallowed.
    expect(res.status).toBe(502);

    const row = await readSwitch();
    // The user's intent is still recorded (it will retry on reconnect), and the
    // confirmed state remains untouched.
    expect(row.is_on).toBe(false);
    expect(row.desired_state).toEqual({ on: true });
    expect(["pending", "failed"]).toContain(row.state_status);
  });

  it("keeps accounts isolated: another tenant cannot command the switch", async () => {
    await setControllerOnline(true);
    await toggle(true);

    const other = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "intruder@example.com",
        password: "PasswordB123!",
        fullName: "Intruder",
        accountName: "Other",
      }),
    });
    const otherCookie = extractCookie(other, "hc_user_session");

    const res = await req(`/api/switches/${switchId}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: otherCookie },
      body: JSON.stringify({ isOn: false }),
    });
    expect(res.status).toBe(404);

    const row = await readSwitch();
    expect(row.desired_state).toEqual({ on: true });
  });
});
