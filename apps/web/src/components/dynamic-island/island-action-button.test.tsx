import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiCache } from "@/lib/api";
import { IslandActionButton } from "./IslandActionButton";
import type { ActionButtonConfigItem } from "@/features/types";

const originalFetch = globalThis.fetch;

const baseConfig: ActionButtonConfigItem = {
  id: "cfg-1",
  name: "Movie Time",
  icon: "tv",
  color: "violet",
  category: "group",
  config: {
    single: [{ id: "s1", kind: "switch", switchId: "sw-1", op: "toggle" }],
    double: null,
    long: null,
  },
  confirmationRequired: false,
  isEnabled: true,
  isActive: true,
  lastExecutedAt: null,
  lastExecutionStatus: null,
  lastError: null,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  states: { on: 2, off: 0 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(configs: ActionButtonConfigItem[], executeBody?: unknown, executeStatus = 200) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url === "/api/action-button/configs" && (!init?.method || init.method === "GET")) {
      return jsonResponse({ configs });
    }
    if (url.endsWith("/execute") && init?.method === "POST") {
      return jsonResponse(
        executeBody ?? {
          ok: true,
          execution: {
            ok: true,
            gesture: "single",
            executedCount: 1,
            failedCount: 0,
            status: "success",
            results: [
              { stepId: "s1", kind: "switch-target", summary: "Switch → toggle", status: "done" },
            ],
            states: { on: 3, off: 0 },
            executedAt: "2026-11-16T00:00:00Z",
          },
        },
        executeStatus
      );
    }
    return jsonResponse({ ok: true });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, calls };
}

describe("IslandActionButton", () => {
  beforeEach(() => {
    resetApiCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetApiCache();
  });

  it("renders nothing (no button or placeholder) when no configuration is assigned", async () => {
    mockFetch([]);
    const { container } = render(<IslandActionButton />);

    await waitFor(() => {
      expect(container.querySelector('[data-island-control]')).toBeNull();
    });
    expect(screen.queryByTestId("island-action-button")).toBeNull();
    expect(screen.queryByTestId("island-action-setup")).toBeNull();
    expect(screen.queryByTestId("island-action-skeleton")).toBeNull();
  });

  it("renders nothing when the assigned button is disabled", async () => {
    mockFetch([{ ...baseConfig, isEnabled: false }]);
    const { container } = render(<IslandActionButton />);

    await waitFor(() => {
      expect(container.querySelector('[data-island-control]')).toBeNull();
    });
    expect(screen.queryByTestId("island-action-button")).toBeNull();
  });

  it("renders the configured button with icon, label and ON state", async () => {
    mockFetch([baseConfig]);
    render(<IslandActionButton />);

    const button = await screen.findByTestId("island-action-button");
    expect(button).toHaveAttribute("aria-label", expect.stringContaining("Movie Time"));
    expect(screen.getByTestId("island-action-state")).toHaveTextContent("ON");
  });

  it("executes the single press action and flashes success", async () => {
    const { calls } = mockFetch([baseConfig]);
    render(<IslandActionButton />);

    const button = await screen.findByTestId("island-action-button");
    fireEvent.click(button);

    await waitFor(() => {
      const exec = calls.find((c) => c.url.endsWith("/execute"));
      expect(exec).toBeTruthy();
      expect(exec?.method).toBe("POST");
      expect(exec?.body).toEqual({ gesture: "single" });
    });
  });

  it("requires a confirming second tap when confirmation is enabled", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([{ ...baseConfig, confirmationRequired: true }]);
    render(<IslandActionButton />);

    const button = await screen.findByTestId("island-action-button");
    await user.click(button);
    // First tap arms only — no execute call yet.
    expect(calls.filter((c) => c.url.endsWith("/execute"))).toHaveLength(0);
    expect(button).toHaveAttribute("data-armed", "true");

    await user.click(button);
    await waitFor(() => {
      expect(calls.filter((c) => c.url.endsWith("/execute"))).toHaveLength(1);
    });
  });

  it("surfaces failures from the execute endpoint as error feedback", async () => {
    mockFetch([baseConfig], {
      ok: false,
      execution: {
        ok: false,
        gesture: "single",
        executedCount: 0,
        failedCount: 1,
        status: "failed",
        results: [
          {
            stepId: "s1",
            kind: "switch-target",
            summary: "Porch Light → toggle",
            status: "failed",
            error: "Controller is offline.",
          },
        ],
        states: null,
        executedAt: "2026-11-16T00:00:00Z",
      },
    });
    render(<IslandActionButton />);

    const button = await screen.findByTestId("island-action-button");
    fireEvent.click(button);

    await waitFor(() => {
      expect(button).toHaveAttribute("data-state", "error");
    });
  });
});
