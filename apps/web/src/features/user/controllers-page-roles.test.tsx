import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiCache } from "@/lib/api";
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
      return jsonResponse({ device: { id: roleMatch[1], board_role: body.role } });
    }

    const renameMatch = url.match(/^\/api\/board-instances\/([^/]+)$/);
    if (renameMatch && method === "PATCH") {
      const body = JSON.parse(String(init!.body)) as { name: string };
      return jsonResponse({ controller: { id: renameMatch[1], name: body.name } });
    }

    const assignMatch = url.match(/^\/api\/board-instances\/([^/]+)\/assign-controller$/);
    if (assignMatch && method === "POST") {
      return jsonResponse({ node: { id: assignMatch[1] }, controller: null });
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

function renderPage(state: { devices: ControllerItem[]; roleChangeBlocked?: boolean }) {
  const calls = mockFetch(state);
  render(
    <TimezoneContext.Provider value="UTC">
      <MyBoardsPage canManage={true} canOperate={true} onNavigate={vi.fn()} />
    </TimezoneContext.Provider>
  );
  return calls;
}

describe("MyBoardsPage Controller / Node tabs", () => {
  beforeEach(() => {
    resetApiCache();
  });

  afterEach(() => {
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
});
