import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetApiCache } from "@/lib/api";
import { ActionButtonSettingsCard } from "./ActionButtonSettings";
import type { ActionButtonConfigItem } from "@/features/types";

const originalFetch = globalThis.fetch;

const configs: ActionButtonConfigItem[] = [
  {
    id: "cfg-1",
    name: "Movie Time",
    icon: "tv",
    color: "violet",
    category: "group",
    config: {
      single: [{ id: "s1", kind: "switch", switchId: "sw-1", op: "toggle" }],
      double: [{ id: "s2", kind: "all", target: "switches", op: "off" }],
      long: null,
    },
    confirmationRequired: true,
    isEnabled: true,
    isActive: true,
    lastExecutedAt: "2026-11-15T20:00:00Z",
    lastExecutionStatus: "success",
    lastError: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    states: { on: 2, off: 3 },
  },
  {
    id: "cfg-2",
    name: "Goodnight",
    icon: "moon",
    color: "slate",
    category: "global",
    config: {
      single: [{ id: "s1", kind: "all", target: "all", op: "off" }],
      double: null,
      long: null,
    },
    confirmationRequired: false,
    isEnabled: false,
    isActive: false,
    lastExecutedAt: null,
    lastExecutionStatus: null,
    lastError: null,
    createdAt: "2026-11-02T00:00:00Z",
    updatedAt: "2026-11-02T00:00:00Z",
    states: { on: 0, off: 5 },
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let stored = configs.map((c) => ({ ...c }));
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url === "/api/action-button/configs" && (!init?.method || init.method === "GET")) {
      return jsonResponse({ configs: stored });
    }
    if (url === "/api/action-button/configs" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      const created = {
        id: "cfg-new",
        isActive: false,
        lastExecutedAt: null,
        lastExecutionStatus: null,
        lastError: null,
        createdAt: "2026-11-16T00:00:00Z",
        updatedAt: "2026-11-16T00:00:00Z",
        ...body,
      };
      stored = [...stored, created];
      return jsonResponse({ config: created }, 201);
    }
    if (url.match(/\/api\/action-button\/configs\/[^/]+$/) && init?.method === "PATCH") {
      const id = url.split("/").pop()!;
      const patch = JSON.parse(String(init.body ?? "{}"));
      stored = stored.map((c) => (c.id === id ? { ...c, ...patch } : c));
      return jsonResponse({ config: stored.find((c) => c.id === id) });
    }
    if (url.match(/\/api\/action-button\/configs\/[^/]+$/) && init?.method === "DELETE") {
      const id = url.split("/").pop()!;
      stored = stored.filter((c) => c.id !== id);
      return jsonResponse({ ok: true });
    }
    if (url === "/api/switches") return jsonResponse({ switches: [] });
    if (url === "/api/devices") return jsonResponse({ devices: [] });
    if (url === "/api/homes/rooms") return jsonResponse({ rooms: [] });
    if (url === "/api/automations") return jsonResponse({ automations: [] });
    return jsonResponse({ ok: true });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, calls };
}

describe("ActionButtonSettingsCard", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetApiCache();
  });

  it("lists configurations with island assignment state", async () => {
    resetApiCache();
    mockFetch();
    render(<ActionButtonSettingsCard />);

    const card = await screen.findByTestId("action-button-settings");
    expect(await within(card).findByText("Movie Time")).toBeInTheDocument();
    expect(within(card).getByText("Goodnight")).toBeInTheDocument();
    expect(within(card).getByText("On island")).toBeInTheDocument();
    expect(within(card).getByText("MIXED")).toBeInTheDocument();
  });

  it("toggles a disabled button back on", async () => {
    const user = userEvent.setup();
    resetApiCache();
    const { calls } = mockFetch();
    render(<ActionButtonSettingsCard />);

    const toggle = await screen.findByRole("switch", { name: "Enable Goodnight" });
    expect(toggle).toHaveAttribute("data-state", "unchecked");
    await user.click(toggle);

    await waitFor(() => {
      const patch = calls.find(
        (c) => c.url.endsWith("/cfg-2") && c.method === "PATCH"
      );
      expect(patch?.body).toMatchObject({ isEnabled: true });
    });
  });

  it("assigns a button to the Dynamic Island", async () => {
    const user = userEvent.setup();
    resetApiCache();
    const { calls } = mockFetch();
    render(<ActionButtonSettingsCard />);

    const assign = (await screen.findAllByRole("button", { name: /Island/ })).find(
      (btn) => within(btn).queryByText("Island")
    )!;
    void assign;
    const buttons = await screen.findAllByRole("button", { name: /Island/ });
    const assignGoodnight = buttons[1]!;
    await user.click(assignGoodnight);

    await waitFor(() => {
      const patch = calls.find(
        (c) => c.url.endsWith("/cfg-2") && c.method === "PATCH"
      );
      expect(patch?.body).toMatchObject({ isActive: true, isEnabled: true });
    });
  });

  it("confirms before deleting a configuration", async () => {
    const user = userEvent.setup();
    resetApiCache();
    const { calls } = mockFetch();
    render(<ActionButtonSettingsCard />);

    const deleteButton = await screen.findByRole("button", { name: "Delete Movie Time" });
    await user.click(deleteButton);

    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: /Delete Button/ });
    await user.click(confirm);

    await waitFor(() => {
      const del = calls.find(
        (c) => c.url.endsWith("/cfg-1") && c.method === "DELETE"
      );
      expect(del).toBeTruthy();
    });
  });

  it("creates a new button through the editor dialog", async () => {
    const user = userEvent.setup();
    resetApiCache();
    const { calls } = mockFetch();
    render(<ActionButtonSettingsCard />);

    const newButton = await screen.findByRole("button", { name: /New Button/ });
    await user.click(newButton);

    const nameInput = await screen.findByLabelText("Name");
    await user.type(nameInput, "Dinner Time");

    const save = screen.getByRole("button", { name: /Create button/i });
    await user.click(save);

    await waitFor(() => {
      const create = calls.find(
        (c) => c.url === "/api/action-button/configs" && c.method === "POST"
      );
      expect(create?.body).toMatchObject({ name: "Dinner Time" });
    });
  });
});
