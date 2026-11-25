import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import { zipSync, strToU8 } from "fflate";
import { sha256Hex } from "../src/lib/crypto";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";
import { extractCookie } from "./helpers/http";


function makeFakeEspIdfImage(byteLength = 512): Uint8Array {
  const buf = new Uint8Array(byteLength);
  buf[0] = 0xe9;
  buf[1] = 0x04;
  return buf;
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

    const catRes = await req("/api/board-library/catalog", { headers: { Cookie: cookie } });
    const boards = ((await catRes.json()) as {
      boards: Array<{ id: string; slug: string; chip_family: string }>;
    }).boards;
    const s3 = boards.find(
      (b) => b.chip_family === "esp32s3" && b.slug === "esp32-s3-devkitc"
    ) ?? boards.find((b) => b.chip_family === "esp32s3")!;
    boardId = s3.id;
    boardSlug = s3.slug;

    // Two identical boards: one stays a Controller, one becomes a Node.
    const hubRes = await postJson("/api/board-instances", {
      name: "Living Room Hub",
      boardProfileId: boardId,
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

    const nodeRes = await postJson("/api/board-instances", {
      name: "Hallway Sensor Node",
      boardProfileId: boardId,
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
      `select id,name,board_role,assigned_controller_id,comm_mode,node_link_state,status,
              pairing_status,hardware_uid,installed_firmware_release_id
         from board_instances where id = $1`,
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
    const res = await req("/api/board-instances", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const { controllers } = (await res.json()) as {
      controllers: Array<Record<string, unknown>>;
    };
    expect(controllers).toHaveLength(2);
    for (const c of controllers) {
      expect(c.board_role).toBe("controller");
      expect(c.assigned_controller_id).toBeNull();
      expect(c.connected_node_count).toBe(0);
      expect(c.node_comm_mode).toBeNull();
    }
  });

  it("demotes a Controller to a Node without creating a second device record", async () => {
    const before = await deviceRow(nodeId);
    const res = await postJson(`/api/board-instances/${nodeId}/role`, { role: "node" }, "PATCH");
    expect(res.status).toBe(200);
    const { device } = (await res.json()) as { device: Record<string, unknown> };
    expect(device.board_role).toBe("node");

    const after = await deviceRow(nodeId);
    // Same row, same identity, same firmware history.
    expect(after.id).toBe(before.id);
    expect(after.hardware_uid).toBe(before.hardware_uid);
    expect(after.pairing_status).toBe(before.pairing_status);
    expect(after.installed_firmware_release_id).toBe(before.installed_firmware_release_id);
    expect(after.board_role).toBe("node");
    expect(after.node_link_state).toBe("unassigned");

    // Exactly two devices still exist.
    const countRes = await dbHarness.pg.query<{ n: number }>(
      "select count(*)::int as n from board_instances where deleted_at is null"
    );
    expect(countRes.rows[0]!.n).toBe(2);
  });

  it("assigns the Node to a Controller and publishes the role in its config snapshot", async () => {
    const res = await postJson(`/api/board-instances/${nodeId}/assign-controller`, {
      boardInstanceId: hubId,
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
      `/api/board-instances/${hubId}`,
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

    const listRes = await req("/api/board-instances", { headers: { Cookie: cookie } });
    const { controllers } = (await listRes.json()) as {
      controllers: Array<Record<string, unknown>>;
    };
    const node = controllers.find((c) => c.id === nodeId)!;
    const hub = controllers.find((c) => c.id === hubId)!;
    expect(node.node_comm_mode).toBe("espnow");
    expect(node.assigned_controller_name).toBe("Living Room Hub");
    expect(hub.connected_node_count).toBe(1);
  });

  it("marks an assigned Node controller_lost when its Controller reports an empty roster", async () => {
    // Pretend the Node was last seen longer ago than the ESP-NOW stale window.
    await dbHarness.pg.query(
      "update board_instances set node_last_linked_at = now() - interval '2 minutes' where id = $1",
      [nodeId]
    );

    const res = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${hubToken}` },
      body: JSON.stringify({ w: true, m: true, role: "controller", nodes: [] }),
    });
    expect(res.status).toBe(200);

    // "I host nobody" is authoritative: the assigned Node is reconnecting, not linked.
    expect((await deviceRow(nodeId)).node_link_state).toBe("controller_lost");

    // The card must stop claiming a linked Node it no longer hosts.
    const listRes = await req("/api/board-instances", { headers: { Cookie: cookie } });
    const { controllers } = (await listRes.json()) as {
      controllers: Array<{ id: string; connected_node_count: number }>;
    };
    expect(controllers.find((c) => c.id === hubId)!.connected_node_count).toBe(0);
  });

  it("relays a linked Node's switch command through its Controller instead of a silent MQTT publish", async () => {
    const swRes = await postJson("/api/switches", {
      boardInstanceId: nodeId,
      name: "Node Lamp",
      gpioPin: 4,
    });
    expect(swRes.status).toBe(201);
    const swId = ((await swRes.json()) as { switch: { id: string } }).switch.id;

    // The Node is linked over ESP-NOW, so it has no EMQX session of its own.
    await dbHarness.pg.query(
      "update board_instances set mqtt_connected = false, node_link_state = 'linked' where id = $1",
      [nodeId]
    );

    emqx.state.published.length = 0;
    const toggle = await postJson(`/api/switches/${swId}/toggle`, { isOn: true });
    expect(toggle.status).toBe(200);
    const toggleBody = (await toggle.json()) as { mqttDispatched: boolean };
    expect(toggleBody.mqttDispatched).toBe(true);

    // Nothing is published to the Node's own (unsubscribed) topic...
    expect(emqx.state.published.some((p) => p.topic.endsWith("/cmd/switch"))).toBe(false);
    // ...the instruction travels through the Controller's system topic instead.
    const relay = emqx.state.published.find((p) => p.payload.includes("relay_to_node"));
    expect(relay).toBeTruthy();
    expect(relay!.topic).toContain(hubId);
    const relayPayload = JSON.parse(relay!.payload) as {
      action: string;
      node_id: string;
      kind: string;
      payload: { switch_id: string; state: string };
    };
    expect(relayPayload.action).toBe("relay_to_node");
    expect(relayPayload.node_id).toBe(nodeId);
    expect(relayPayload.kind).toBe("switch");
    expect(relayPayload.payload.switch_id).toBe(swId);
    expect(relayPayload.payload.state).toBe("ON");
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
    expect(row.board_role).toBe("node");
  });

  it("refuses to demote a Controller that still hosts Nodes, and releases them when acknowledged", async () => {
    // Re-link the Node first so the Controller has something to host.
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${hubToken}` },
      body: JSON.stringify({ w: true, m: true, role: "controller", nodes: [{ id: nodeId, link: "linked" }] }),
    });

    const blocked = await postJson(`/api/board-instances/${hubId}/role`, { role: "node" }, "PATCH");
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
    expect((await deviceRow(hubId)).board_role).toBe("controller");
    expect((await deviceRow(nodeId)).assigned_controller_id).toBe(hubId);

    const confirmed = await postJson(
      `/api/board-instances/${hubId}/role`,
      { role: "node", acknowledgeAttachedNodes: true },
      "PATCH"
    );
    expect(confirmed.status).toBe(200);

    // Both are Nodes now; the released Node is explicitly unassigned, never
    // silently orphaned onto a Controller that stopped hosting.
    expect((await deviceRow(hubId)).board_role).toBe("node");
    const released = await deviceRow(nodeId);
    expect(released.board_role).toBe("node");
    expect(released.assigned_controller_id).toBeNull();
    expect(released.node_link_state).toBe("unassigned");
  });

  it("promotes a Node back to Controller and keeps its identity and history", async () => {
    const before = await deviceRow(nodeId);
    const res = await postJson(`/api/board-instances/${nodeId}/role`, { role: "controller" }, "PATCH");
    expect(res.status).toBe(200);

    const after = await deviceRow(nodeId);
    expect(after.board_role).toBe("controller");
    expect(after.assigned_controller_id).toBeNull();
    expect(after.id).toBe(before.id);
    expect(after.hardware_uid).toBe(before.hardware_uid);

    // Put it back to a Node for the OTA test below.
    await postJson(`/api/board-instances/${nodeId}/role`, { role: "node" }, "PATCH");
    await postJson(`/api/board-instances/${hubId}/role`, { role: "controller" }, "PATCH");
    await postJson(`/api/board-instances/${nodeId}/assign-controller`, { boardInstanceId: hubId });
  });

  it("rejects assigning a Node to another Node or to an offline Controller", async () => {
    const demote = await postJson(
      `/api/board-instances/${hubId}/role`,
      { role: "node", acknowledgeAttachedNodes: true },
      "PATCH"
    );
    expect(demote.status).toBe(200);
    const res = await postJson(`/api/board-instances/${nodeId}/assign-controller`, {
      boardInstanceId: hubId,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/operating as a Controller/i);

    await postJson(`/api/board-instances/${hubId}/role`, { role: "controller" }, "PATCH");
    // Re-assign so the offline check has a real target.
    await postJson(`/api/board-instances/${nodeId}/assign-controller`, { boardInstanceId: null });
    const offlineRes = await dbHarness.pg.query<{ id: string }>(
      "update board_instances set status = 'offline' where id = $1 returning id",
      [hubId]
    );
    expect(offlineRes.rows).toHaveLength(1);
    const offline = await postJson(`/api/board-instances/${nodeId}/assign-controller`, {
      boardInstanceId: hubId,
    });
    expect(offline.status).toBe(409);
    expect(((await offline.json()) as { error: string }).error).toMatch(/must be online/i);
    await dbHarness.pg.query("update board_instances set status = 'online' where id = $1", [hubId]);
  });

  it("relays a Node OTA instruction through its Controller when the Node has no MQTT session", async () => {
    const releaseId = await publishFirmwarePackage("9.9.9");

    // Re-establish the agreed topology: Hub hosts the Node over ESP-NOW, and the
    // Node runs no MQTT session of its own.
    await postJson(`/api/board-instances/${hubId}/role`, { role: "controller" }, "PATCH");
    await postJson(`/api/board-instances/${nodeId}/assign-controller`, { boardInstanceId: hubId });
    await dbHarness.pg.query(
      "update board_instances set status = 'online', mqtt_connected = true where id = $1",
      [hubId]
    );
    await dbHarness.pg.query(
      "update board_instances set status = 'online', mqtt_connected = false, node_link_state = 'linked' where id = $1",
      [nodeId]
    );

    // The Node is linked over ESP-NOW: its own MQTT session is not connected.
    await dbHarness.pg.query(
      "update board_instances set mqtt_connected = false where id = $1",
      [nodeId]
    );

    emqx.state.published.length = 0;
    const res = await postJson("/api/firmware/ota/start", { boardInstanceId: nodeId, releaseId });
    if (res.status !== 201) {
      throw new Error(`OTA start failed: ${res.status} ${await res.text()}`);
    }
    expect(res.status).toBe(201);

    const relay = emqx.state.published.find((p) => p.payload.includes("ota_relay"));
    expect(relay).toBeTruthy();
    const payload = JSON.parse(relay!.payload) as {
      action: string;
      node_id: string;
      ota: { board_role: string; wifi_window: boolean; ota_url: string };
    };
    expect(payload.action).toBe("ota_relay");
    expect(payload.node_id).toBe(nodeId);
    expect(payload.ota.board_role).toBe("node");
    expect(payload.ota.wifi_window).toBe(true);
    expect(payload.ota.ota_url).toContain("/api/device/firmware/ota/");
    // The relay goes to the hosting Controller, not the Node.
    expect(relay!.topic).toContain(hubId);
  });

  it("never lets a device promote or demote itself through a heartbeat", async () => {
    // A Node reports "controller": the persisted (user-owned) role must win.
    const nodeBefore = await deviceRow(nodeId);
    expect(nodeBefore.board_role).toBe("node");
    const nodeRes = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${nodeToken}` },
      body: JSON.stringify({ w: true, m: false, role: "controller", cm: "wifi_mqtt", ls: "linked" }),
    });
    expect(nodeRes.status).toBe(200);
    const nodeAfter = await deviceRow(nodeId);
    expect(nodeAfter.board_role).toBe("node");
    // Its own link/communication reporting is still accepted.
    expect(nodeAfter.comm_mode).toBe("wifi_mqtt");
    expect(nodeAfter.node_link_state).toBe("linked");

    // A Controller reporting "node" must not demote itself either.
    expect((await deviceRow(hubId)).board_role).toBe("controller");
    const hubRes = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${hubToken}` },
      body: JSON.stringify({ w: true, m: true, role: "node", ls: "standalone", cm: "wifi_mqtt" }),
    });
    expect(hubRes.status).toBe(200);
    const hubAfter = await deviceRow(hubId);
    expect(hubAfter.board_role).toBe("controller");
    // Uplink columns are Node-only and must not be written onto a Controller.
    expect(hubAfter.comm_mode).toBeNull();
    expect(hubAfter.node_link_state).toBeNull();
  });

  it("reports sync_published=false to a device with no MQTT session so it pulls the snapshot over HTTPS", async () => {
    await dbHarness.pg.query(
      `update board_instances
          set pending_config_sync = true,
              config_revision = config_revision + 5
        where id = $1`,
      [nodeId]
    );

    const res = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${nodeToken}` },
      body: JSON.stringify({ w: true, m: false, role: "node", ls: "linked", rev: 0 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sync_published: boolean; config_revision: number };
    // An EMQX publish would be "accepted" even with no subscriber, so a Node
    // without a session must be told to fetch over HTTPS instead.
    expect(body.sync_published).toBe(false);
    expect(body.config_revision).toBeGreaterThan(0);

    // The same device with a live MQTT session may rely on the MQTT push.
    await dbHarness.pg.query(
      "update board_instances set pending_config_sync = true where id = $1",
      [nodeId]
    );
    const mqttRes = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${nodeToken}` },
      body: JSON.stringify({ w: true, m: true, role: "node", ls: "standalone", rev: 0 }),
    });
    expect(mqttRes.status).toBe(200);
    expect(((await mqttRes.json()) as { sync_published: boolean }).sync_published).toBe(true);
  });

  it("keeps the Node OTA record in the shared update history", async () => {
    const res = await req("/api/firmware/updates", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applicableUpdates: Array<{ boardInstanceId: string; boardRole: string }>;
      history: Array<{ board_instance_id: string; status: string }>;
    };
    const nodeUpdate = body.applicableUpdates.find((u) => u.boardInstanceId === nodeId);
    expect(nodeUpdate?.boardRole).toBe("node");
    expect(body.history.some((h) => h.board_instance_id === nodeId)).toBe(true);
  });

  it("confirms OTA success on heartbeat for a linked ESP-NOW Node even with mqttConnected=false", async () => {
    // Seed an active rebooting OTA history row for the linked Node.
    const accountRow = await dbHarness.pg.query<{ account_id: string }>(
      "select account_id from board_instances where id = $1",
      [nodeId]
    );
    const relRow = await dbHarness.pg.query<{ id: string }>(
      "select id from firmware_releases limit 1"
    );
    const accountId = accountRow.rows[0]!.account_id;
    const releaseId = relRow.rows[0]!.id;
    const inserted = await dbHarness.pg.query<{ id: string }>(
      `insert into firmware_update_history
         (account_id, board_instance_id, release_id, update_type, target_version, status, progress_percent)
       values ($1, $2, $3, 'ota', '9.9.1', 'rebooting', 90)
       returning id`,
      [accountId, nodeId, releaseId]
    );
    const histId = inserted.rows[0]!.id;

    // Linked ESP-NOW Node intentionally keeps MQTT disconnected (m: false) once linked.
    const beat = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${nodeToken}` },
      body: JSON.stringify({
        w: true,
        m: false,
        v: "9.9.1",
        op: false,
        role: "node",
        cm: "espnow",
        ls: "linked",
      }),
    });
    expect(beat.status).toBe(200);

    const updated = await dbHarness.pg.query<{ status: string; progress_percent: number }>(
      "select status, progress_percent from firmware_update_history where id = $1",
      [histId]
    );
    expect(updated.rows[0]?.status).toBe("succeeded");
    expect(updated.rows[0]?.progress_percent).toBe(100);
  });

  it("surfaces Controller reported_nodes roster and blocks false linked state on one-way unacked keepalives", async () => {
    // 1. Node sends keepalives (kaTx=3) but explicitly reports zero received ACKs (ackRx=0).
    const unackedBeat = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${nodeToken}` },
      body: JSON.stringify({
        w: true,
        m: false,
        role: "node",
        cm: "offline",
        ls: "reconnecting",
        ch: 6,
        kaTx: 3,
        ackRx: 0,
      }),
    });
    expect(unackedBeat.status).toBe(200);

    // 2. Controller hears the one-way keepalive and reports the Node in its roster.
    // Because the Node just reported ackRx=0, the Worker must record controllerHeardAt
    // without falsely overwriting node_link_state to "linked".
    const ctrlBeat = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${hubToken}` },
      body: JSON.stringify({
        w: true,
        m: true,
        role: "controller",
        cm: "wifi_mqtt",
        ch: 6,
        espnowLinkState: "hosting",
        nodes: [{ id: nodeId, link: "linked", rssi: -52, channel: 6, seq: 3 }],
      }),
    });
    expect(ctrlBeat.status).toBe(200);

    let listRes = await req("/api/board-instances", { headers: { Cookie: cookie } });
    let { controllers } = (await listRes.json()) as {
      controllers: Array<Record<string, unknown>>;
    };
    let nodeItem = controllers.find((c) => c.id === nodeId)!;
    let hubItem = controllers.find((c) => c.id === hubId)!;
    expect(nodeItem.node_link_state).toBe("reconnecting");
    expect((nodeItem.espnow_telemetry as { controllerHeardAt?: string })?.controllerHeardAt).toBeTruthy();
    expect(hubItem.reported_nodes).toEqual([
      { id: nodeId, link: "linked", rssi: -52, channel: 6, seq: 3 },
    ]);

    // 3. Node now receives Controller ACK #4 and reports ls="linked", cm="espnow", ackRx=4.
    // Also verify no spurious "MQTT Disconnected" notification is emitted when m=false.
    await dbHarness.pg.query("update board_instances set mqtt_connected = true where id = $1", [
      nodeId,
    ]);
    await dbHarness.pg.query(
      "delete from notifications where dedup_key = $1",
      [`ctrl:${nodeId}:mqtt_off`]
    );

    const ackedBeat = await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${nodeToken}` },
      body: JSON.stringify({
        w: true,
        m: false,
        role: "node",
        cm: "espnow",
        ls: "linked",
        ch: 6,
        kaTx: 4,
        ackRx: 4,
        peerRssi: -49,
        peerCh: 6,
      }),
    });
    expect(ackedBeat.status).toBe(200);

    listRes = await req("/api/board-instances", { headers: { Cookie: cookie } });
    ({ controllers } = (await listRes.json()) as {
      controllers: Array<Record<string, unknown>>;
    });
    nodeItem = controllers.find((c) => c.id === nodeId)!;
    hubItem = controllers.find((c) => c.id === hubId)!;
    expect(nodeItem.node_link_state).toBe("linked");
    expect(nodeItem.node_comm_mode).toBe("espnow");
    expect(hubItem.hosted_node_ids).toContain(nodeId);
    expect((nodeItem.espnow_telemetry as { ackConfirmed?: boolean; rssi?: number }).ackConfirmed).toBe(true);
    expect((nodeItem.espnow_telemetry as { rssi?: number }).rssi).toBe(-49);

    const notifCheck = await dbHarness.pg.query<{ n: number }>(
      "select count(*)::int as n from notifications where dedup_key = $1",
      [`ctrl:${nodeId}:mqtt_off`]
    );
    expect(notifCheck.rows[0]!.n).toBe(0);
  });

  it("preserves room, switches, devices, sensors and credentials across Controller->Node conversion and assignment", async () => {
    const createRes = await postJson("/api/board-instances", {
      name: "Bedroom Panel",
      boardProfileId: boardId,
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      controller: { id: string; home_id: string };
      pairingCode: string;
    };
    const panelId = created.controller.id;

    const pairRes = await req("/api/device/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: created.pairingCode,
        macAddress: "AA:BB:CC:11:22:33",
        firmwareVersion: "1.6.0",
      }),
    });
    expect(pairRes.status).toBe(200);
    const panelToken = ((await pairRes.json()) as { device_api_token: string }).device_api_token;

    // Bring panel online and attach room, switch, device, and sensor.
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${panelToken}` },
      body: JSON.stringify({ w: true, m: true, v: "1.6.0" }),
    });

    const roomRes = await postJson("/api/homes/rooms", {
      homeId: created.controller.home_id,
      name: "Master Bedroom",
    });
    expect(roomRes.status).toBe(201);
    const roomId = ((await roomRes.json()) as { room: { id: string } }).room.id;

    const assignRoomRes = await req(`/api/board-instances/${panelId}/room`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ roomId }),
    });
    expect(assignRoomRes.status).toBe(200);

    await dbHarness.pg.query(
      `insert into switches (account_id, home_id, room_id, board_instance_id, name, gpio_pin)
       select account_id, home_id, room_id, id, 'Ceiling Light', 4 from board_instances where id = $1`,
      [panelId]
    );
    await dbHarness.pg.query(
      `insert into devices (account_id, home_id, room_id, board_instance_id, name, device_type, gpio_pin)
       select account_id, home_id, room_id, id, 'Ceiling Fan', 'fan', 5 from board_instances where id = $1`,
      [panelId]
    );
    await dbHarness.pg.query(
      `insert into sensors (account_id, home_id, room_id, board_instance_id, name, sensor_type, gpio_pin, unit)
       select account_id, home_id, room_id, id, 'Bedroom Temp', 'temperature', 6, 'C' from board_instances where id = $1`,
      [panelId]
    );

    // Ensure hub is online, then convert Bedroom Panel to a Node and assign to hubId.
    await req("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${hubToken}` },
      body: JSON.stringify({ w: true, m: true, role: "controller" }),
    });

    const roleRes = await req(`/api/board-instances/${panelId}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ role: "node" }),
    });
    expect(roleRes.status).toBe(200);

    const assignRes = await postJson(`/api/board-instances/${panelId}/assign-controller`, {
      boardInstanceId: hubId,
    });
    expect(assignRes.status).toBe(200);

    const check = await dbHarness.pg.query<{
      room_id: string | null;
      hardware_uid: string | null;
      pairing_status: string;
      sw_count: number;
      dev_count: number;
      sen_count: number;
      cred_count: number;
    }>(
      `select b.room_id, b.hardware_uid, b.pairing_status,
              (select count(*)::int from switches where board_instance_id = b.id and deleted_at is null) as sw_count,
              (select count(*)::int from devices where board_instance_id = b.id and deleted_at is null) as dev_count,
              (select count(*)::int from sensors where board_instance_id = b.id and deleted_at is null) as sen_count,
              (select count(*)::int from mqtt_credentials_metadata where board_instance_id = b.id and status = 'active') as cred_count
         from board_instances b where b.id = $1`,
      [panelId]
    );
    expect(check.rows[0]).toEqual({
      room_id: roomId,
      hardware_uid: "AA:BB:CC:11:22:33",
      pairing_status: "paired",
      sw_count: 1,
      dev_count: 1,
      sen_count: 1,
      cred_count: 1,
    });

    // Re-link publishes refreshed config snapshots + command without mutating identity.
    emqx.state.published.length = 0;
    const relinkRes = await postJson(`/api/board-instances/${panelId}/relink`, {});
    expect(relinkRes.status).toBe(200);
    expect(emqx.state.published.some((m) => m.topic.endsWith(`/${panelId}/config/snapshot`))).toBe(
      true
    );
    expect(emqx.state.published.some((m) => m.topic.endsWith(`/${hubId}/config/snapshot`))).toBe(
      true
    );
  });
});
