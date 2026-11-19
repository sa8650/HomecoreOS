import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import { zipSync, strToU8 } from "fflate";
import { sha256Hex } from "../src/lib/crypto";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";


function makeFakeEspIdfImage(byteLength = 512): Uint8Array {
  const buf = new Uint8Array(byteLength);
  buf[0] = 0xe9;
  buf[1] = 0x04;
  return buf;
}

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName}`);
  return `${cookieName}=${match[1]}`;
}

/**
 * Unified Controller / Node architecture, end to end against a real database:
 * role changes keep the device record, Node assignment, ESP-NOW roster
 * reconciliation, standalone fallback reporting and EMQX-relayed Node OTA.
 */
describe("Unified Controller & Node roles", () => {
  let dbHarness: PgliteHarness;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;
  let cookie: string;
  let emqx: ReturnType<typeof createMockEmqxFetch>;
  let hubId: string;
  let hubToken: string;
  let nodeId: string;
  let nodeToken: string;
  let boardId: string;
  let boardSlug: string;

  beforeAll(async () => {
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

    const regRes = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "roles-owner@homecoreos.local",
        password: "RolesOwner123!",
        fullName: "Roles Owner",
        accountName: "Roles Home",
        timezone: "Asia/Dhaka",
      }),
    });
    expect(regRes.status).toBe(201);
    cookie = extractCookie(regRes, "hc_user_session");

    const catRes = await req("/api/boards/catalog", { headers: { Cookie: cookie } });
    const boards = ((await catRes.json()) as {
      boards: Array<{ id: string; slug: string; chip_family: string }>;
    }).boards;
    const s3 = boards.find(
      (b) => b.chip_family === "esp32s3" && b.slug === "esp32-s3-devkitc"
    ) ?? boards.find((b) => b.chip_family === "esp32s3")!;
    boardId = s3.id;
    boardSlug = s3.slug;

    // Two identical boards: one stays a Controller, one becomes a Node.
    const hubRes = await postJson("/api/controllers", {
      name: "Living Room Hub",
      boardCatalogId: boardId,
    });
    const hubJson = (await hubRes.json()) as { controller: { id: string }; pairingCode: string };
    hubId = hubJson.controller.id;
    const hubPair = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: hubJson.pairingCode }),
    });
    expect(hubPair.status).toBe(200);
    hubToken = ((await hubPair.json()) as { device_api_token: string }).device_api_token;

    const nodeRes = await postJson("/api/controllers", {
      name: "Hallway Sensor Node",
      boardCatalogId: boardId,
    });
    const nodeJson = (await nodeRes.json()) as { controller: { id: string }; pairingCode: string };
    nodeId = nodeJson.controller.id;
    const nodePair = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: nodeJson.pairingCode }),
    });
    expect(nodePair.status).toBe(200);
    nodeToken = ((await nodePair.json()) as { device_api_token: string }).device_api_token;

    // Both devices online so role/OTA operations are allowed.
    for (const token of [hubToken, nodeToken]) {
      await req("/api/device/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ w: true, m: true, v: "1.5.0" }),
      });
    }
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

  async function deviceRow(id: string) {
    const res = await dbHarness.pg.query<Record<string, unknown>>(
      `select id,name,device_role,assigned_controller_id,comm_mode,node_link_state,status,
              pairing_status,hardware_uid,installed_firmware_release_id
         from controllers where id = $1`,
      [id]
    );
    return res.rows[0]!;
  }

  async function publishFirmwarePackage(version: string): Promise<string> {
    const bootRes = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "roles-admin@homecoreos.local",
        fullName: "Roles Admin",
        password: "RolesAdmin123!",
      }),
    });
    const adminCookie =
      bootRes.status === 201
        ? extractCookie(bootRes, "hc_admin_session")
        : extractCookie(
            await req("/api/admin/auth/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                email: "roles-admin@homecoreos.local",
                password: "RolesAdmin123!",
              }),
            }),
            "hc_admin_session"
          );

    const otaBytes = makeFakeEspIdfImage(512);
    const factoryBytes = makeFakeEspIdfImage(1024);
    const manifest = {
      name: "HomecoreOS Core",
      version,
      channel: "stable",
      chip_family: "esp32s3",
      chip_variant: "ESP32S3",
      release_notes: `Release ${version}`,
      compatible_board_slugs: [boardSlug],
      files: [
        {
          file_type: "ota_app",
          file_name: `homecoreos-${version}-ota.bin`,
          sha256: await sha256Hex(otaBytes),
          flash_address: "0x10000",
          flash_mode: "dio",
          flash_freq: "80m",
          flash_size: "16MB",
        },
        {
          file_type: "usb_factory",
          file_name: `homecoreos-${version}-factory.bin`,
          sha256: await sha256Hex(factoryBytes),
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
    form.append(
      "package",
      new File([zipBytes], `homecoreos-${version}.zip`, { type: "application/zip" })
    );
    form.append("publish", "true");

    const res = await req("/api/admin/firmware/package", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: form,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { release: { id: string } }).release.id;
  }

  it("lists every device as a Controller by default (legacy rows keep working)", async () => {
    const res = await req("/api/controllers", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const { controllers } = (await res.json()) as {
      controllers: Array<Record<string, unknown>>;
    };
    expect(controllers).toHaveLength(2);
    for (const c of controllers) {
      expect(c.device_role).toBe("controller");
      expect(c.assigned_controller_id).toBeNull();
      expect(c.connected_node_count).toBe(0);
      expect(c.node_comm_mode).toBeNull();
    }
  });

  it("demotes a Controller to a Node without creating a second device record", async () => {
    const before = await deviceRow(nodeId);
    const res = await postJson(`/api/controllers/${nodeId}/role`, { role: "node" }, "PATCH");
    expect(res.status).toBe(200);
    const { device } = (await res.json()) as { device: Record<string, unknown> };
    expect(device.device_role).toBe("node");

    const after = await deviceRow(nodeId);
    // Same row, same identity, same firmware history.
    expect(after.id).toBe(before.id);
    expect(after.hardware_uid).toBe(before.hardware_uid);
    expect(after.pairing_status).toBe(before.pairing_status);
    expect(after.installed_firmware_release_id).toBe(before.installed_firmware_release_id);
    expect(after.device_role).toBe("node");
    expect(after.node_link_state).toBe("unassigned");

    // Exactly two devices still exist.
    const countRes = await dbHarness.pg.query<{ n: number }>(
      "select count(*)::int as n from controllers where deleted_at is null"
    );
    expect(countRes.rows[0]!.n).toBe(2);
  });

  it("assigns the Node to a Controller and publishes the role in its config snapshot", async () => {
    const res = await postJson(`/api/controllers/${nodeId}/assign-controller`, {
      controllerId: hubId,
    });
    expect(res.status).toBe(200);

    const row = await deviceRow(nodeId);
    expect(row.assigned_controller_id).toBe(hubId);
    expect(row.comm_mode).toBe("espnow");

    // The device learns its role from the consolidated config snapshot.
    const cfgRes = await req("/api/device/config", {
      headers: { Authorization: `Bearer ${nodeToken}` },
    });
    expect(cfgRes.status).toBe(200);
    const cfg = (await cfgRes.json()) as {
      role?: {
        mode: string;
        assignedControllerId: string | null;
        assignedControllerMac: string | null;
        espnowChannel: number;
        linkTimeoutMs: number;
        reconnectWindowMs: number;
      };
    };
    expect(cfg.role?.mode).toBe("node");
    expect(cfg.role?.assignedControllerId).toBe(hubId);
    // ESP-NOW timing contract the firmware relies on.
    expect(cfg.role?.reconnectWindowMs).toBe(45_000);
    expect(cfg.role?.linkTimeoutMs).toBe(10_000);
    // null = the Node searches the Controller's channel instead of being pinned.
    expect(cfg.role?.espnowChannel).toBeNull();

    // The Controller's snapshot lists the Node it hosts.
    const hubCfgRes = await req("/api/device/config", {
      headers: { Authorization: `Bearer ${hubToken}` },
    });
    const hubCfg = (await hubCfgRes.json()) as {
      role?: { mode: string; nodeIds: string[] };
    };
    expect(hubCfg.role?.mode).toBe("controller");
    expect(hubCfg.role?.nodeIds).toContain(nodeId);
  });

  it("publishes a pinned ESP-NOW channel and bumps the config revision when role data changes", async () => {
    const revBefore = (
      (await (await req("/api/device/config", {
        headers: { Authorization: `Bearer ${nodeToken}` },
      })).json()) as { revision: number }
    ).revision;

    const pinRes = await postJson(
      `/api/controllers/${hubId}`,
      { espnowChannel: 6 },
      "PATCH"
    );
    expect(pinRes.status).toBe(200);

    const cfg = (await (await req("/api/device/config", {
      headers: { Authorization: `Bearer ${nodeToken}` },
    })).json()) as { revision: number; role?: { espnowChannel: number | null } };
    expect(cfg.role?.espnowChannel).toBe(6);
    // The role block is part of the hashed payload, so the revision must move.
    expect(cfg.revision).toBeGreaterThan(revBefore);
  });

  it("keeps a Node visible through its Controller's ESP-NOW roster", async () => {
    const res = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${hubToken}` },
      body: JSON.stringify({
        w: true,
        m: true,
        role: "controller",
        cm: "wifi_mqtt",
        nodes: [{ id: nodeId, link: "linked", rssi: -55, channel: 6 }],
      }),
    });
    expect(res.status).toBe(200);

    const row = await deviceRow(nodeId);
    expect(row.node_link_state).toBe("linked");
    expect(row.comm_mode).toBe("espnow");
    expect(row.status).toBe("online");

    const listRes = await req("/api/controllers", { headers: { Cookie: cookie } });
    const { controllers } = (await listRes.json()) as {
      controllers: Array<Record<string, unknown>>;
    };
    const node = controllers.find((c) => c.id === nodeId)!;
    const hub = controllers.find((c) => c.id === hubId)!;
    expect(node.node_comm_mode).toBe("espnow");
    expect(node.assigned_controller_name).toBe("Living Room Hub");
    expect(hub.connected_node_count).toBe(1);
  });

  it("accepts a standalone Node reporting its Wi-Fi/MQTT fallback", async () => {
    const res = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${nodeToken}` },
      body: JSON.stringify({
        w: true,
        m: true,
        role: "node",
        cm: "wifi_mqtt",
        ls: "standalone",
        v: "1.5.0",
      }),
    });
    expect(res.status).toBe(200);

    const row = await deviceRow(nodeId);
    expect(row.node_link_state).toBe("standalone");
    expect(row.comm_mode).toBe("wifi_mqtt");
    // Still a Node: falling back never promotes the device.
    expect(row.device_role).toBe("node");
  });

  it("refuses to demote a Controller that still hosts Nodes, and releases them when acknowledged", async () => {
    // Re-link the Node first so the Controller has something to host.
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${hubToken}` },
      body: JSON.stringify({ w: true, m: true, role: "controller", nodes: [{ id: nodeId, link: "linked" }] }),
    });

    const blocked = await postJson(`/api/controllers/${hubId}/role`, { role: "node" }, "PATCH");
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as {
      code: string;
      attachedNodeCount: number;
      attachedNodes: Array<{ id: string; name: string }>;
    };
    expect(blockedBody.code).toBe("attached_nodes");
    expect(blockedBody.attachedNodeCount).toBe(1);
    expect(blockedBody.attachedNodes[0]!.name).toBe("Hallway Sensor Node");

    // Nothing changed while the change was refused.
    expect((await deviceRow(hubId)).device_role).toBe("controller");
    expect((await deviceRow(nodeId)).assigned_controller_id).toBe(hubId);

    const confirmed = await postJson(
      `/api/controllers/${hubId}/role`,
      { role: "node", acknowledgeAttachedNodes: true },
      "PATCH"
    );
    expect(confirmed.status).toBe(200);

    // Both are Nodes now; the released Node is explicitly unassigned, never
    // silently orphaned onto a Controller that stopped hosting.
    expect((await deviceRow(hubId)).device_role).toBe("node");
    const released = await deviceRow(nodeId);
    expect(released.device_role).toBe("node");
    expect(released.assigned_controller_id).toBeNull();
    expect(released.node_link_state).toBe("unassigned");
  });

  it("promotes a Node back to Controller and keeps its identity and history", async () => {
    const before = await deviceRow(nodeId);
    const res = await postJson(`/api/controllers/${nodeId}/role`, { role: "controller" }, "PATCH");
    expect(res.status).toBe(200);

    const after = await deviceRow(nodeId);
    expect(after.device_role).toBe("controller");
    expect(after.assigned_controller_id).toBeNull();
    expect(after.id).toBe(before.id);
    expect(after.hardware_uid).toBe(before.hardware_uid);

    // Put it back to a Node for the OTA test below.
    await postJson(`/api/controllers/${nodeId}/role`, { role: "node" }, "PATCH");
    await postJson(`/api/controllers/${hubId}/role`, { role: "controller" }, "PATCH");
    await postJson(`/api/controllers/${nodeId}/assign-controller`, { controllerId: hubId });
  });

  it("rejects assigning a Node to another Node or to an offline Controller", async () => {
    const demote = await postJson(
      `/api/controllers/${hubId}/role`,
      { role: "node", acknowledgeAttachedNodes: true },
      "PATCH"
    );
    expect(demote.status).toBe(200);
    const res = await postJson(`/api/controllers/${nodeId}/assign-controller`, {
      controllerId: hubId,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/operating as a Controller/i);

    await postJson(`/api/controllers/${hubId}/role`, { role: "controller" }, "PATCH");
    // Re-assign so the offline check has a real target.
    await postJson(`/api/controllers/${nodeId}/assign-controller`, { controllerId: null });
    const offlineRes = await dbHarness.pg.query<{ id: string }>(
      "update controllers set status = 'offline' where id = $1 returning id",
      [hubId]
    );
    expect(offlineRes.rows).toHaveLength(1);
    const offline = await postJson(`/api/controllers/${nodeId}/assign-controller`, {
      controllerId: hubId,
    });
    expect(offline.status).toBe(409);
    expect(((await offline.json()) as { error: string }).error).toMatch(/must be online/i);
    await dbHarness.pg.query("update controllers set status = 'online' where id = $1", [hubId]);
  });

  it("relays a Node OTA instruction through its Controller when the Node has no MQTT session", async () => {
    const releaseId = await publishFirmwarePackage("9.9.9");

    // Re-establish the agreed topology: Hub hosts the Node over ESP-NOW, and the
    // Node runs no MQTT session of its own.
    await postJson(`/api/controllers/${hubId}/role`, { role: "controller" }, "PATCH");
    await postJson(`/api/controllers/${nodeId}/assign-controller`, { controllerId: hubId });
    await dbHarness.pg.query(
      "update controllers set status = 'online', mqtt_connected = true where id = $1",
      [hubId]
    );
    await dbHarness.pg.query(
      "update controllers set status = 'online', mqtt_connected = false, node_link_state = 'linked' where id = $1",
      [nodeId]
    );

    // The Node is linked over ESP-NOW: its own MQTT session is not connected.
    await dbHarness.pg.query(
      "update controllers set mqtt_connected = false where id = $1",
      [nodeId]
    );

    emqx.state.published.length = 0;
    const res = await postJson("/api/firmware/ota/start", { controllerId: nodeId, releaseId });
    if (res.status !== 201) {
      throw new Error(`OTA start failed: ${res.status} ${await res.text()}`);
    }
    expect(res.status).toBe(201);

    const relay = emqx.state.published.find((p) => p.payload.includes("ota_relay"));
    expect(relay).toBeTruthy();
    const payload = JSON.parse(relay!.payload) as {
      action: string;
      node_id: string;
      ota: { device_role: string; wifi_window: boolean; ota_url: string };
    };
    expect(payload.action).toBe("ota_relay");
    expect(payload.node_id).toBe(nodeId);
    expect(payload.ota.device_role).toBe("node");
    expect(payload.ota.wifi_window).toBe(true);
    expect(payload.ota.ota_url).toContain("/api/device/firmware/ota/");
    // The relay goes to the hosting Controller, not the Node.
    expect(relay!.topic).toContain(hubId);
  });

  it("keeps the Node OTA record in the shared update history", async () => {
    const res = await req("/api/firmware/updates", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applicableUpdates: Array<{ controllerId: string; deviceRole: string }>;
      history: Array<{ controller_id: string; status: string }>;
    };
    const nodeUpdate = body.applicableUpdates.find((u) => u.controllerId === nodeId);
    expect(nodeUpdate?.deviceRole).toBe("node");
    expect(body.history.some((h) => h.controller_id === nodeId)).toBe(true);
  });
});
