import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityPage } from "./ActivityAndSettingsPages";
import { TimezoneContext } from "@/lib/timezone";

const originalFetch = globalThis.fetch;

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

it("renders account activity with its category, action and regional time zone", async () => {
  const fetchMock = vi.fn(async () =>
    jsonResponse({
      activity: [
        {
          id: "activity-1",
          account_id: "account-1",
          board_instance_id: "board-1",
          category: "switch",
          action: "switch.toggled",
          summary: "Kitchen light turned on",
          created_at: "2026-11-25T12:00:00.000Z",
        },
      ],
    })
  );
  globalThis.fetch = fetchMock as typeof fetch;

  render(
    <TimezoneContext.Provider value="Asia/Dhaka">
      <ActivityPage />
    </TimezoneContext.Provider>
  );

  expect(await screen.findByRole("heading", { name: "Activity Log" })).toBeInTheDocument();
  expect(await screen.findByText("Kitchen light turned on")).toBeInTheDocument();
  expect(screen.getByText("switch.toggled")).toBeInTheDocument();
  expect(screen.getByText("switch", { selector: "span" })).toBeInTheDocument();
  expect(screen.getByText(/Real audit events.*Asia\/Dhaka/i)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/activity", expect.any(Object));
});

it("reloads the Activity Log when the category filter changes", async () => {
  const fetchMock = vi.fn(async () => jsonResponse({ activity: [] }));
  globalThis.fetch = fetchMock as typeof fetch;
  const user = userEvent.setup();

  render(
    <TimezoneContext.Provider value="UTC">
      <ActivityPage />
    </TimezoneContext.Provider>
  );

  await screen.findByRole("heading", { name: "Activity Log" });
  await user.click(screen.getByRole("combobox", { name: "Filter category" }));
  await user.click(await screen.findByRole("option", { name: "Switches" }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith("/api/activity?category=switch", expect.any(Object));
  });
});
