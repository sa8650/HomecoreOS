import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiCache } from "@/lib/api";
import {
  RealtimeSyncClient,
  __resetRealtimeSingletonForTests,
  __setRealtimeSingletonForTests,
} from "@/lib/realtime/sync-client";
import type { RealtimeTransportParams } from "@/lib/realtime/transport";
import { TimezoneContext } from "@/lib/timezone";
import { MyBoardsPage } from "./MyBoardsPage";
import type { ControllerItem } from "@/features/types";
import { jsonResponse } from "@/test/http";

const originalFetch = globalThis.fetch;

const baseDevice = {
  account_id: "a1",
  home_id: "h1",
  board_profile_id: "b1",
  custom_board_profile_id: null,
  flash_size_mb: 16,
  psram_size_mb: 8,
  firmware_version: "1.5.0",
  mqtt_connected: true,
  wifi_ssid: "HomeNet",
  wifi_rssi: -50,
  local_ip: "192.168.1.40",
  last_heartbeat_at: null,
  last_communication_at: null,
  paired_at: "2026-10-01T00:00:00Z",
  connection_history: [],
} satisfies Partial<ControllerItem>;

const hub: ControllerItem = {
  ...baseDevice,
  id: "c-hub",
  name: "Living Hub",
  hardware_uid: "AA:BB:CC:DD:EE:01",
  board_model: "ESP32-S3-N16R8",
  chip_variant: "ESP32-S3",
  status: "online",
  board_role: "controller",
  connected_node_count: 1,
} as ControllerItem;

const standaloneNode: ControllerItem = {
  ...baseDevice,
  id: "c-node",
  name: "Hallway Node",
  hardware_uid: "AA:BB:CC:DD:EE:02",
  board_model: "ESP32-S3-N16R8",
  chip_variant: "ESP32-S3",
  status: "online",
  board_role: "node",
  node_comm_mode: "wifi_mqtt",
  node_link_state: "standalone",
  assigned_controller_id: "c-hub",
  assigned_controller_name: "Living Hub",
  node_last_linked_at: "2026-11-17T09:00:00Z",
} as ControllerItem;

function mockFetch(state: {
  devices: ControllerItem[];
  roleChangeBlocked?: boolean;
  failAssignControllerId?: string;
}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    if (url === "/api/board-instances") return jsonResponse({ controllers: state.devices });
    if (url === "/api/board-instances/trash") return jsonResponse({ controllers: [] });
    if (url === "/api/board-library/catalog") return jsonResponse({ boards: [] });
    if (url === "/api/board-library/custom") return jsonResponse({ boards: [] });
    if (url === "/api/homes")
      return jsonResponse({
        homes: [{ id: "h1", account_id: "a1", name: "Main Home", timezone: "UTC" }],
      });
    if (url === "/api/homes/rooms") return jsonResponse({ rooms: [] });
    if (url === "/api/firmware/updates") return jsonResponse({ applicableUpdates: [] });

    const roleMatch = url.match(/^\/api\/board-instances\/([^/]+)\/role$/);
    if (roleMatch && method === "PATCH") {
      const body = JSON.parse(String(init!.body)) as {
        role: "controller" | "node";
        acknowledgeAttachedNodes?: boolean;
      };
      if (state.roleChangeBlocked && body.role === "node" && !body.acknowledgeAttachedNodes) {
        return jsonResponse(
          {
            error: "1 Node still relies on this Controller.",
            code: "attached_nodes",
            attachedNodeCount: 1,
            details: { attachedNodeCount: 1 },
          },
          409
        );
      }
      state.devices = state.devices.map((d) =>
        d.id === roleMatch[1]
          ? {
              ...d,
              board_role: body.role,
              node_link_state: body.role === "node" ? "unassigned" : null,
              node_comm_mode:
                body.role === "node"
                  ? d.status === "online"
                    ? "wifi_mqtt"
                    : "offline"
                  : null,
              assigned_controller_id: null,
              assigned_controller_name: null,
              config_revision: (d.config_revision ?? 1) + 1,
            }
          : d
      );
      return jsonResponse({ device: { id: roleMatch[1], board_role: body.role } });
    }

    const renameMatch = url.match(/^\/api\/board-instances\/([^/]+)$/);
    if (renameMatch && method === "PATCH") {
      const body = JSON.parse(String(init!.body)) as { name: string };
      return jsonResponse({ controller: { id: renameMatch[1], name: body.name } });
    }

    const assignMatch = url.match(/^\/api\/board-instances\/([^/]+)\/assign-controller$/);
    if (assignMatch && method === "POST") {
      const body = JSON.parse(String(init!.body)) as { boardInstanceId: string | null };
      if (
        state.failAssignControllerId &&
        body.boardInstanceId === state.failAssignControllerId
      ) {
        return jsonResponse(
          {
            error: "The selected Controller is offline.",
            code: "controller_offline",
          },
          409
        );
      }
      const ctrl = body.boardInstanceId
        ? state.devices.find((d) => d.id === body.boardInstanceId) ?? null
        : null;
      state.devices = state.devices.map((d) =>
        d.id === assignMatch[1]
          ? {
              ...d,
              assigned_controller_id: body.boardInstanceId,
              assigned_controller_name: ctrl?.name ?? null,
              node_link_state: body.boardInstanceId ? "reconnecting" : "unassigned",
              config_revision: (d.config_revision ?? 1) + 1,
              pending_config_sync: true,
            }
          : d
      );
      return jsonResponse({ node: { id: assignMatch[1] }, controller: ctrl });
    }

    const relinkMatch = url.match(/^\/api\/board-instances\/([^/]+)\/relink$/);
    if (relinkMatch && method === "POST") {
      return jsonResponse({ ok: true, deliveredVia: "controller" });
    }

    return jsonResponse({ ok: true });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return calls;
}

function renderPage(state: {
  devices: ControllerItem[];
  roleChangeBlocked?: boolean;
  failAssignControllerId?: string;
}) {
  const calls = mockFetch(state);
  render(
    <TimezoneContext.Provider value="UTC">
      <MyBoardsPage canManage={true} canOperate={true} onNavigate={vi.fn()} />
    </TimezoneContext.Provider>
  );
  return calls;
}

function installLiveRealtimeHarness() {
  let transportParams: RealtimeTransportParams | null = null;
  let seq = 0;
  const client = new RealtimeSyncClient({
    fetchConfig: async () => ({
      enabled: true,
      accountId: "a1",
      credential: {
        brokerUrl: "wss://mock.emqx.cloud:8084/mqtt",
        username: "test-user",
        password: "test-password",
        topic: "homecore/a1/realtime/events",
        clientIdPrefix: "hc-rt-test",
        expiresAt: "2027-01-01T00:00:00Z",
      },
    }),
    fetchSnapshot: async () => ({
      v: 1,
      accountId: "a1",
      serverTime: "2026-11-25T00:00:00Z",
      entities: {
        boards: [],
        switches: [],
        devices: [],
        sensors: [],
        automations: [],
        homes: [],
      },
    }),
    createChannel: () => null,
    createTransport: (params) => {
      transportParams = params;
      queueMicrotask(() => params.onConnected());
      return { close: () => {} };
    },
    isVisible: () => true,
  });
  __setRealtimeSingletonForTests(client);
  client.start("a1");

  return {
    async emitBoardUpdated(resourceId: string) {
      await waitFor(() => expect(transportParams).not.toBeNull());
      seq += 1;
      const ts = `2026-11-25T10:00:${String(seq).padStart(2, "0")}Z`;
      act(() => {
        transportParams!.onMessage(
          JSON.stringify({
            v: 1,
            accountId: "a1",
            sentAt: ts,
            events: [
              {
                entity: "board",
                action: "updated",
                id: resourceId,
                ts,
                version: `v-${seq}`,
              },
            ],
          })
        );
      });
    },
  };
}

describe("MyBoardsPage Controller / Node tabs", () => {
  beforeEach(() => {
    resetApiCache();
    __resetRealtimeSingletonForTests();
  });

  afterEach(() => {
    __resetRealtimeSingletonForTests();
    globalThis.fetch = originalFetch;
    resetApiCache();
  });

  it("splits devices into a Controllers tab and a Nodes tab", async () => {
    renderPage({ devices: [hub, standaloneNode] });

    expect(await screen.findByRole("tab", { name: /Controllers \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Nodes \(1\)/ })).toBeInTheDocument();

    // Controllers tab only lists Controllers.
    const controllerGrid = await screen.findByTestId("controllers-card-grid");
    expect(within(controllerGrid).getByText("Living Hub")).toBeInTheDocument();
    expect(within(controllerGrid).queryByText("Hallway Node")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Nodes \(1\)/ }));
    const nodeGrid = await screen.findByTestId("nodes-card-grid");
    expect(within(nodeGrid).getByText("Hallway Node")).toBeInTheDocument();
    // The Controller is only referenced as the Node's host, never listed as a device.
    expect(
      within(nodeGrid).queryByRole("button", { name: /View details for Living Hub/i })
    ).not.toBeInTheDocument();
  });

  it("describes a Node that lost its Controller as a Standalone Node, never as a Controller", async () => {
    renderPage({ devices: [hub, standaloneNode] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: /Nodes \(1\)/ }));

    const card = (await screen.findByText("Hallway Node")).closest(
      "[class*='rounded-xl']"
    ) as HTMLElement;
    expect(
      within(card).getByText(/Standalone Node — Controller Disconnected/i)
    ).toBeInTheDocument();
    expect(within(card).getByText(/Wi-Fi \/ MQTT/i)).toBeInTheDocument();
    expect(within(card).getByText("Living Hub")).toBeInTheDocument();
  });

  it("prompts for confirmation through the Worker when a Controller still hosts Nodes", async () => {
    const calls = renderPage({ devices: [hub, standaloneNode], roleChangeBlocked: true });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Actions for Living Hub" }));
    await user.click(screen.getByRole("menuitem", { name: /Make this a Node/i }));
    await user.click(screen.getByRole("button", { name: /^Make Node$/i }));

    // The Worker refused because a Node still relies on it.
    expect(
      await screen.findByRole("dialog", { name: /Nodes still rely on this Controller/i })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Release Nodes and Continue/i }));
    await waitFor(() => {
      const patches = calls.filter(
        (c) => c.url === "/api/board-instances/c-hub/role" && c.method === "PATCH"
      );
      expect(patches).toHaveLength(2);
      expect(patches[0]!.body).toEqual({ role: "node", acknowledgeAttachedNodes: false });
      expect(patches[1]!.body).toEqual({ role: "node", acknowledgeAttachedNodes: true });
    });
  });

  it("assigns a Node to a Controller from the Nodes tab", async () => {
    const calls = renderPage({ devices: [hub, { ...standaloneNode }] });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("tab", { name: /Nodes \(1\)/ }));
    await user.click(await screen.findByRole("button", { name: "Actions for Hallway Node" }));
    await user.click(screen.getByRole("menuitem", { name: /Change Controller/i }));

    const dialog = await screen.findByRole("dialog", { name: /Assign a Controller/i });
    await user.click(within(dialog).getByRole("radio", { name: /Living Hub/i }));
    await user.click(within(dialog).getByRole("button", { name: /Save Assignment/i }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.url === "/api/board-instances/c-node/assign-controller" && c.method === "POST"
      );
      expect(post?.body).toEqual({ boardInstanceId: "c-hub" });
    });
  });

  it("shows the role badge, board model and last activity on both tabs", async () => {
    const nodeWithActivity: ControllerItem = {
      ...standaloneNode,
      last_communication_at: "2026-11-18T10:30:00Z",
    } as ControllerItem;
    renderPage({ devices: [hub, nodeWithActivity] });

    const controllerGrid = await screen.findByTestId("controllers-card-grid");
    expect(within(controllerGrid).getByTestId("controller-role-badge")).toHaveTextContent(
      "Controller"
    );
    expect(within(controllerGrid).getByText("ESP32-S3-N16R8")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Nodes \(1\)/ }));
    const nodeGrid = await screen.findByTestId("nodes-card-grid");
    expect(within(nodeGrid).getByTestId("node-role-badge")).toHaveTextContent("Node");
    expect(within(nodeGrid).getByText("ESP32-S3-N16R8")).toBeInTheDocument();
    const activity = within(nodeGrid).getByTestId("node-last-activity");
    expect(activity).toHaveTextContent(/Last activity/);
    expect(activity.textContent).not.toContain("Never");
  });

  it("re-links a Node through its Controller", async () => {
    const calls = renderPage({ devices: [hub, { ...standaloneNode }] });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("tab", { name: /Nodes \(1\)/ }));
    await user.click(await screen.findByRole("button", { name: "Actions for Hallway Node" }));
    await user.click(screen.getByRole("menuitem", { name: /Re-link to Controller/i }));
    await user.click(await screen.findByRole("button", { name: /Re-link Now/i }));

    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.url === "/api/board-instances/c-node/relink" && c.method === "POST"
        )
      ).toBe(true);
    });
  });

  it("renames a Controller and a Node through the shared Edit name action", async () => {
    const calls = renderPage({ devices: [hub, standaloneNode] });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Actions for Living Hub" }));
    await user.click(screen.getByRole("menuitem", { name: /Edit name/i }));
    let dialog = await screen.findByRole("dialog", { name: /Edit Controller name/i });
    const field = within(dialog).getByLabelText(/Name/i);
    await user.clear(field);
    await user.type(field, "Lounge Hub");
    await user.click(within(dialog).getByRole("button", { name: /Save Name/i }));

    await waitFor(() => {
      const patch = calls.find((c) => c.url === "/api/board-instances/c-hub" && c.method === "PATCH");
      expect(patch?.body).toEqual({ name: "Lounge Hub" });
    });

    await user.click(await screen.findByRole("tab", { name: /Nodes \(1\)/ }));
    await user.click(await screen.findByRole("button", { name: "Actions for Hallway Node" }));
    await user.click(screen.getByRole("menuitem", { name: /Edit name/i }));
    dialog = await screen.findByRole("dialog", { name: /Edit Node name/i });
    const nodeField = within(dialog).getByLabelText(/Name/i);
    await user.clear(nodeField);
    await user.type(nodeField, "Hallway Node 2");
    await user.click(within(dialog).getByRole("button", { name: /Save Name/i }));

    await waitFor(() => {
      const patch = calls.find(
        (c) => c.url === "/api/board-instances/c-node" && c.method === "PATCH"
      );
      expect(patch?.body).toEqual({ name: "Hallway Node 2" });
    });
  });

  it("gives the Node card the same anatomy as the Controller card, with Node details", async () => {
    renderPage({ devices: [hub, standaloneNode] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: /Nodes \(1\)/ }));

    const grid = await screen.findByTestId("nodes-card-grid");
    expect(within(grid).getByTestId("node-card-stage")).toBeInTheDocument();
    expect(within(grid).getByRole("button", { name: /^Details$/i })).toBeInTheDocument();

    // Role / Status rows plus the Node-specific rows: host Controller, link and firmware.
    for (const label of ["Role", "Status", "Controller", "Link", "Firmware", "Last activity"]) {
      expect(within(grid).getByText(label)).toBeInTheDocument();
    }
    // The firmware badge on the stage and the Firmware row both carry the version.
    expect(within(grid).getAllByText("v1.5.0").length).toBeGreaterThan(1);
  });

  it("filters Choose Controller in Make this a Node to eligible online same-home Controllers", async () => {
    const targetCtrl: ControllerItem = {
      ...baseDevice,
      id: "c-target",
      name: "Kitchen Switch Board",
      hardware_uid: "AA:BB:CC:DD:EE:09",
      board_model: "ESP32-WROOM-32D",
      chip_variant: "ESP32",
      status: "online",
      board_role: "controller",
      connected_node_count: 0,
    } as ControllerItem;

    const degradedMqttHub: ControllerItem = {
      ...baseDevice,
      id: "c-hub-mqtt-off",
      name: "Garage Hub",
      hardware_uid: "AA:BB:CC:DD:EE:10",
      board_model: "ESP32-C3-MINI-1",
      chip_variant: "ESP32-C3",
      status: "online",
      mqtt_connected: false,
      board_role: "controller",
    } as ControllerItem;

    const offlineHub: ControllerItem = {
      ...baseDevice,
      id: "c-offline",
      name: "Attic Offline Hub",
      hardware_uid: "AA:BB:CC:DD:EE:11",
      board_model: "ESP32-S3-N16R8",
      chip_variant: "ESP32-S3",
      status: "offline",
      board_role: "controller",
    } as ControllerItem;

    const otherHomeHub: ControllerItem = {
      ...baseDevice,
      id: "c-other-home",
      home_id: "h-other",
      name: "Vacation Home Hub",
      hardware_uid: "AA:BB:CC:DD:EE:12",
      board_model: "ESP32-S3-N16R8",
      chip_variant: "ESP32-S3",
      status: "online",
      board_role: "controller",
    } as ControllerItem;

    renderPage({
      devices: [
        hub,
        targetCtrl,
        degradedMqttHub,
        offlineHub,
        otherHomeHub,
        standaloneNode,
      ],
    });
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: "Actions for Kitchen Switch Board" })
    );
    await user.click(screen.getByRole("menuitem", { name: /Make this a Node/i }));

    const dialog = await screen.findByRole("dialog", { name: /Make this a Node\?/i });
    const summary = within(dialog).getByTestId("role-dialog-board-summary");
    expect(within(summary).getByText("Kitchen Switch Board")).toBeInTheDocument();
    expect(within(summary).getByText("ESP32-WROOM-32D")).toBeInTheDocument();

    const radioGroup = within(dialog).getByRole("radiogroup", {
      name: /Choose Controller/i,
    });
    expect(
      within(radioGroup).getByRole("radio", { name: /Set Controller Later/i })
    ).toHaveAttribute("aria-checked", "true");

    // Eligible same-home online Controllers appear with model + Online + MQTT badges.
    const livingHubRadio = within(radioGroup).getByRole("radio", { name: /Living Hub/i });
    expect(within(livingHubRadio).getByText(/ESP32-S3-N16R8/)).toBeInTheDocument();
    expect(within(livingHubRadio).getByText("Online")).toBeInTheDocument();
    expect(within(livingHubRadio).getByText("MQTT Connected")).toBeInTheDocument();

    const garageRadio = within(radioGroup).getByRole("radio", { name: /Garage Hub/i });
    expect(within(garageRadio).getByText("MQTT Disconnected")).toBeInTheDocument();

    // Never offers itself, another Node, an offline Controller, or another home's Controller.
    expect(
      within(radioGroup).queryByRole("radio", { name: /Kitchen Switch Board/i })
    ).not.toBeInTheDocument();
    expect(
      within(radioGroup).queryByRole("radio", { name: /Hallway Node/i })
    ).not.toBeInTheDocument();
    expect(
      within(radioGroup).queryByRole("radio", { name: /Attic Offline Hub/i })
    ).not.toBeInTheDocument();
    expect(
      within(radioGroup).queryByRole("radio", { name: /Vacation Home Hub/i })
    ).not.toBeInTheDocument();
  });

  it("converts to an unassigned Node without opening link verification when Set Controller Later is kept", async () => {
    const targetCtrl: ControllerItem = {
      ...baseDevice,
      id: "c-target",
      name: "Study Board",
      hardware_uid: "AA:BB:CC:DD:EE:20",
      board_model: "ESP32-S3-N16R8",
      chip_variant: "ESP32-S3",
      status: "online",
      board_role: "controller",
    } as ControllerItem;

    const calls = renderPage({ devices: [hub, targetCtrl] });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Actions for Study Board" }));
    await user.click(screen.getByRole("menuitem", { name: /Make this a Node/i }));
    await user.click(screen.getByRole("button", { name: /^Make Node$/i }));

    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.url === "/api/board-instances/c-target/role" && c.method === "PATCH"
        )
      ).toBe(true);
    });
    expect(
      calls.some((c) => c.url.endsWith("/assign-controller") && c.method === "POST")
    ).toBe(false);
    expect(
      screen.queryByTestId("node-controller-link-dialog")
    ).not.toBeInTheDocument();
  });

  it("verifies real-time ESP-NOW handshake, transitions to Connected, detects live disconnect, and supports Retry Connection", async () => {
    const rt = installLiveRealtimeHarness();
    const targetCtrl: ControllerItem = {
      ...baseDevice,
      id: "c-target",
      name: "Patio Relay Board",
      hardware_uid: "AA:BB:CC:DD:EE:30",
      board_model: "ESP32-S3-N16R8",
      chip_variant: "ESP32-S3",
      status: "online",
      board_role: "controller",
      config_revision: 2,
      last_synced_config_revision: 2,
      pending_config_sync: false,
    } as ControllerItem;

    const state = { devices: [{ ...hub, connected_node_count: 0 }, targetCtrl] };
    const calls = renderPage(state);
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: "Actions for Patio Relay Board" })
    );
    await user.click(screen.getByRole("menuitem", { name: /Make this a Node/i }));

    const roleDialog = await screen.findByRole("dialog", { name: /Make this a Node\?/i });
    await user.click(within(roleDialog).getByRole("radio", { name: /Living Hub/i }));
    await user.click(within(roleDialog).getByRole("button", { name: /^Make Node$/i }));

    // Role conversion + Controller assignment ran in order, then opened link verification.
    const linkDialog = await screen.findByTestId("node-controller-link-dialog");
    expect(
      within(linkDialog).getByRole("heading", { name: /Connecting Node to Controller/i })
    ).toBeInTheDocument();
    expect(within(linkDialog).getByTestId("link-dialog-node-board")).toHaveTextContent(
      "Patio Relay Board"
    );
    expect(
      within(linkDialog).getByTestId("link-dialog-controller-board")
    ).toHaveTextContent("Living Hub");

    // Initially waiting for hardware confirmation — NEVER falsely Connected.
    expect(within(linkDialog).getByTestId("link-dialog-status-banner")).toHaveAttribute(
      "data-tone",
      "waiting"
    );
    expect(within(linkDialog).getByTestId("link-dialog-verdict-badge")).toHaveTextContent(
      "Verifying Hardware"
    );

    // Step 1: Real hardware confirms mutual ESP-NOW handshake + Controller roster + MQTT healthy.
    state.devices = state.devices.map((d) => {
      if (d.id === "c-target") {
        return {
          ...d,
          status: "online",
          board_role: "node",
          mqtt_connected: false,
          node_comm_mode: "espnow",
          node_link_state: "linked",
          espnow_channel: 6,
          pending_config_sync: false,
          last_synced_config_revision: d.config_revision,
          node_last_linked_at: "2026-11-25T10:00:02Z",
          last_communication_at: "2026-11-25T10:00:02Z",
          espnow_telemetry: {
            channel: 6,
            rssi: -47,
            keepaliveTxSeq: 3,
            ackRxSeq: 3,
            ackConfirmed: true,
          },
        };
      }
      if (d.id === "c-hub") {
        return {
          ...d,
          status: "online",
          mqtt_connected: true,
          espnow_channel: 6,
          hosted_node_ids: ["c-target"],
          reported_nodes: [{ id: "c-target", link: "linked", rssi: -47, channel: 6, seq: 3 }],
          last_communication_at: "2026-11-25T10:00:02Z",
        };
      }
      return d;
    });
    await rt.emitBoardUpdated("c-target");

    await waitFor(() => {
      expect(within(linkDialog).getByTestId("link-dialog-status-banner")).toHaveAttribute(
        "data-tone",
        "connected"
      );
    });
    expect(within(linkDialog).getByTestId("link-dialog-verdict-badge")).toHaveTextContent(
      "Connected"
    );
    expect(linkDialog).toHaveTextContent("Ch 6 · -47 dBm");
    expect(linkDialog).toHaveTextContent("Verified in roster");

    // Step 2: While dialog remains open, Controller goes offline -> live transition to Connection Lost!
    state.devices = state.devices.map((d) =>
      d.id === "c-hub"
        ? { ...d, status: "offline", mqtt_connected: false }
        : d
    );
    await rt.emitBoardUpdated("c-hub");

    await waitFor(() => {
      expect(within(linkDialog).getByTestId("link-dialog-status-banner")).toHaveAttribute(
        "data-tone",
        "failed"
      );
    });
    expect(within(linkDialog).getByTestId("link-dialog-verdict-badge")).toHaveTextContent(
      "Connection Lost"
    );
    expect(within(linkDialog).getByTestId("link-dialog-fault-badge")).toHaveTextContent(
      "Controller board issue"
    );

    // Step 3: Retry Connection calls /relink, and Close preserves Node role + assignment.
    await user.click(within(linkDialog).getByTestId("link-dialog-retry-button"));
    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.url === "/api/board-instances/c-target/relink" && c.method === "POST"
        )
      ).toBe(true);
    });

    await user.click(within(linkDialog).getByTestId("link-dialog-close-button"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("node-controller-link-dialog")
      ).not.toBeInTheDocument();
    });
    const savedTarget = state.devices.find((d) => d.id === "c-target")!;
    expect(savedTarget.board_role).toBe("node");
    expect(savedTarget.assigned_controller_id).toBe("c-hub");
  });

  it("preserves the selected Controller across the attached-Nodes warning confirmation", async () => {
    const secondaryHub: ControllerItem = {
      ...baseDevice,
      id: "c-hub-2",
      name: "Upstairs Hub",
      hardware_uid: "AA:BB:CC:DD:EE:40",
      board_model: "ESP32-S3-N16R8",
      chip_variant: "ESP32-S3",
      status: "online",
      board_role: "controller",
      connected_node_count: 0,
    } as ControllerItem;

    const calls = renderPage({
      devices: [hub, secondaryHub, standaloneNode],
      roleChangeBlocked: true,
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Actions for Living Hub" }));
    await user.click(screen.getByRole("menuitem", { name: /Make this a Node/i }));

    const roleDialog = await screen.findByRole("dialog", { name: /Make this a Node\?/i });
    await user.click(within(roleDialog).getByRole("radio", { name: /Upstairs Hub/i }));
    await user.click(within(roleDialog).getByRole("button", { name: /^Make Node$/i }));

    const warnDialog = await screen.findByRole("dialog", {
      name: /Nodes still rely on this Controller/i,
    });
    expect(warnDialog).toHaveTextContent(/Upstairs Hub/);

    await user.click(
      within(warnDialog).getByRole("button", { name: /Release Nodes and Continue/i })
    );

    await waitFor(() => {
      const assignCall = calls.find(
        (c) =>
          c.url === "/api/board-instances/c-hub/assign-controller" && c.method === "POST"
      );
      expect(assignCall?.body).toEqual({ boardInstanceId: "c-hub-2" });
    });
    expect(await screen.findByTestId("node-controller-link-dialog")).toBeInTheDocument();
  });

  it("recovers cleanly when role change succeeds but Controller assignment fails", async () => {
    const flakyHub: ControllerItem = {
      ...baseDevice,
      id: "c-flaky-hub",
      name: "Flaky Hub",
      hardware_uid: "AA:BB:CC:DD:EE:50",
      board_model: "ESP32-S3-N16R8",
      chip_variant: "ESP32-S3",
      status: "online",
      board_role: "controller",
    } as ControllerItem;

    const targetBoard: ControllerItem = {
      ...baseDevice,
      id: "c-target-recover",
      name: "Office Relay",
      hardware_uid: "AA:BB:CC:DD:EE:51",
      board_model: "ESP32-S3-N16R8",
      chip_variant: "ESP32-S3",
      status: "online",
      board_role: "controller",
    } as ControllerItem;

    const calls = renderPage({
      devices: [hub, flakyHub, targetBoard],
      failAssignControllerId: "c-flaky-hub",
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Actions for Office Relay" }));
    await user.click(screen.getByRole("menuitem", { name: /Make this a Node/i }));

    const dialog = await screen.findByRole("dialog", { name: /Make this a Node\?/i });
    await user.click(within(dialog).getByRole("radio", { name: /Flaky Hub/i }));
    await user.click(within(dialog).getByRole("button", { name: /^Make Node$/i }));

    // Role converted once, assignment failed -> dialog stays open in partial-failure recovery state!
    expect(
      await within(dialog).findByText(/Converted to Node — Controller assignment failed/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("node-controller-link-dialog")
    ).not.toBeInTheDocument();

    // Select healthy Living Hub and retry assignment without re-running role conversion.
    await user.click(within(dialog).getByRole("radio", { name: /Living Hub/i }));
    await user.click(within(dialog).getByRole("button", { name: /Retry Assignment/i }));

    expect(await screen.findByTestId("node-controller-link-dialog")).toBeInTheDocument();
    const rolePatches = calls.filter(
      (c) =>
        c.url === "/api/board-instances/c-target-recover/role" && c.method === "PATCH"
    );
    expect(rolePatches).toHaveLength(1);
    const assignPosts = calls.filter(
      (c) =>
        c.url === "/api/board-instances/c-target-recover/assign-controller" &&
        c.method === "POST"
    );
    expect(assignPosts).toHaveLength(2);
    expect(assignPosts[1]!.body).toEqual({ boardInstanceId: "c-hub" });
  });
});
