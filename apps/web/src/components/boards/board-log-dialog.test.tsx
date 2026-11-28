import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BoardLogDialog } from "./BoardLogDialog";
import { TimezoneContext } from "@/lib/timezone";
import { getRealtimeClient } from "@/lib/realtime/sync-client";

/** The live state of the account channel, as the dialog sees it. */
let realtimeState = "live";

vi.mock("@/lib/realtime/RealtimeProvider", () => ({
  useRealtimeStatus: () => ({ state: realtimeState }),
}));

const originalFetch = globalThis.fetch;

type FetchCall = [input: RequestInfo | URL, init?: RequestInit];

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "log-1",
    boardInstanceId: "board-1",
    category: "connection",
    severity: "info",
    status: "online",
    method: "http",
    source: "board-1",
    destination: null,
    message: "Board came online.",
    metadata: {},
    createdAt: "2026-11-25T12:00:00.000Z",
    ...overrides,
  };
}

const board = {
  id: "board-1",
  name: "Living Room Hub",
  status: "online" as const,
  boardRole: "controller",
  lastHeartbeatAt: "2026-11-25T12:00:00.000Z",
  lastCommunicationAt: "2026-11-25T12:00:00.000Z",
  mqttConnected: true,
  wifiConnected: true,
  nodeLinkState: null,
  commMode: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
  realtimeState = "live";
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

it("shows the board identity, its status and the most recent entries", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse({
      board,
      entries: [
        entry(),
        entry({
          id: "log-2",
          category: "command",
          severity: "warning",
          status: "timeout",
          method: "mqtt",
          message: "Command was published but the board never confirmed it within 120s.",
          createdAt: "2026-11-25T12:05:00.000Z",
        }),
      ],
      nextCursor: null,
      hasMore: false,
    })
  );
  globalThis.fetch = fetchMock as typeof fetch;

  render(
    <TimezoneContext.Provider value="UTC">
      <BoardLogDialog board={board} open onOpenChange={() => {}} />
    </TimezoneContext.Provider>
  );

  expect(await screen.findByText(/Living Room Hub/)).toBeInTheDocument();
  expect(screen.getByTestId("board-log-board-id")).toHaveTextContent("board-1");
  expect(screen.getByTestId("board-log-status-line")).toHaveTextContent("Online");
  expect(screen.getByTestId("board-log-last-seen")).toHaveTextContent(/Last seen/);
  expect(screen.getByTestId("board-log-live-indicator")).toHaveTextContent(/Live/);

  // The status badge keeps the delivery states apart from the execution ones.
  const statuses = screen.getAllByTestId("board-log-status").map((node) => node.textContent);
  expect(statuses).toContain("Online");
  expect(statuses).toContain("Timeout");
  expect(screen.getByText(/never confirmed it within 120s/)).toBeInTheDocument();

  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/api/board-logs/board-1"),
    expect.any(Object)
  );
});

it("reports the real state of the live channel without losing the history", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse({
      board,
      entries: [entry()],
      nextCursor: null,
      hasMore: false,
    })
  );
  globalThis.fetch = fetchMock as typeof fetch;

  const { rerender } = render(
    <TimezoneContext.Provider value="UTC">
      <BoardLogDialog board={board} open onOpenChange={() => {}} />
    </TimezoneContext.Provider>
  );

  await screen.findByText("Board came online.");
  expect(screen.getByTestId("board-log-live-indicator")).toHaveTextContent(
    /Live — updating in real time/
  );

  // The channel drops: the stored history stays readable, the indicator tells
  // the truth about the live updates.
  realtimeState = "reconnecting";
  rerender(
    <TimezoneContext.Provider value="UTC">
      <BoardLogDialog board={board} open onOpenChange={() => {}} />
    </TimezoneContext.Provider>
  );

  await waitFor(() => {
    expect(screen.getByTestId("board-log-live-indicator")).toHaveTextContent(
      /waiting for the connection/
    );
  });
  expect(screen.getByText("Board came online.")).toBeInTheDocument();
});

it("filters by category and searches inside the board's own entries", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse({
      board,
      entries: [
        entry({ id: "log-1", message: "Board came online." }),
        entry({
          id: "log-2",
          category: "command",
          status: "sent",
          message: "Command published to the board.",
        }),
      ],
      nextCursor: null,
      hasMore: false,
    })
  );
  globalThis.fetch = fetchMock as typeof fetch;
  const user = userEvent.setup();

  render(
    <TimezoneContext.Provider value="UTC">
      <BoardLogDialog board={board} open onOpenChange={() => {}} />
    </TimezoneContext.Provider>
  );

  await screen.findByText("Board came online.");

  await user.click(screen.getByTestId("board-log-filter-command"));
  await waitFor(() => {
    const calls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calls.some((url) => url.includes("category=command"))).toBe(true);
  });

  await user.type(screen.getByTestId("board-log-search"), "published");
  await waitFor(() => {
    expect(screen.queryByText("Board came online.")).not.toBeInTheDocument();
    expect(screen.getByText("Command published to the board.")).toBeInTheDocument();
  });
});

it("buffers live entries while the view is paused and applies them on resume", async () => {
  const fetchMock = vi.fn(async () =>
    jsonResponse({ board, entries: [entry()], nextCursor: null, hasMore: false })
  );
  globalThis.fetch = fetchMock as typeof fetch;
  const user = userEvent.setup();

  render(
    <TimezoneContext.Provider value="UTC">
      <BoardLogDialog board={board} open onOpenChange={() => {}} />
    </TimezoneContext.Provider>
  );

  await screen.findByText("Board came online.");
  await user.click(screen.getByTestId("board-log-pause"));
  expect(screen.getByTestId("board-log-live-indicator")).toHaveTextContent(/Paused/);

  // A live entry arrives on the account channel while the view is paused.
  getRealtimeClient().applyEvents(
    [
      {
        entity: "log",
        action: "created",
        id: "log-live",
        ts: new Date().toISOString(),
        patch: {
          boardInstanceId: "board-1",
          category: "communication",
          severity: "success",
          status: "received",
          method: "mqtt",
          message: "Command received.",
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      },
    ],
    { broadcast: false }
  );

  await waitFor(() => {
    expect(screen.getByTestId("board-log-live-indicator")).toHaveTextContent(/1 new entry/);
  });
  // The buffered entry is not shown while the view is paused.
  expect(screen.queryByText("Command received.")).not.toBeInTheDocument();

  await user.click(screen.getByTestId("board-log-pause"));
  await waitFor(() => {
    expect(screen.getByText("Command received.")).toBeInTheDocument();
  });
  expect(screen.getByTestId("board-log-live-indicator")).toHaveTextContent(/Live/);
});

it("clears the view without deleting the stored records", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse({
      board,
      entries: [entry({ id: "log-1", message: "Board came online." })],
      nextCursor: null,
      hasMore: false,
    })
  );
  globalThis.fetch = fetchMock as typeof fetch;
  const user = userEvent.setup();

  render(
    <TimezoneContext.Provider value="UTC">
      <BoardLogDialog board={board} open onOpenChange={() => {}} />
    </TimezoneContext.Provider>
  );

  await screen.findByText("Board came online.");
  const deleteCallsBefore = (fetchMock.mock.calls as FetchCall[]).filter((call) =>
    String(call[1]?.method ?? "GET").toUpperCase() === "DELETE"
  ).length;

  await user.click(screen.getByTestId("board-log-clear"));
  await waitFor(() => {
    expect(screen.queryByText("Board came online.")).not.toBeInTheDocument();
  });

  const deleteCallsAfter = (fetchMock.mock.calls as FetchCall[]).filter((call) =>
    String(call[1]?.method ?? "GET").toUpperCase() === "DELETE"
  ).length;
  expect(deleteCallsAfter).toBe(deleteCallsBefore);
  expect(screen.getByText(/Clear View only hides entries/)).toBeInTheDocument();
});

it("loads older entries with the cursor the server returned", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("before=")) {
      return jsonResponse({
        board,
        entries: [entry({ id: "log-old", message: "An older entry." })],
        nextCursor: null,
        hasMore: false,
      });
    }
    return jsonResponse({
      board,
      entries: [entry({ id: "log-new", message: "The newest entry." })],
      nextCursor: "42",
      hasMore: true,
    });
  });
  globalThis.fetch = fetchMock as typeof fetch;
  const user = userEvent.setup();

  render(
    <TimezoneContext.Provider value="UTC">
      <BoardLogDialog board={board} open onOpenChange={() => {}} />
    </TimezoneContext.Provider>
  );

  await screen.findByText("The newest entry.");
  await user.click(screen.getByTestId("board-log-load-older"));

  await waitFor(() => {
    expect(screen.getByText("An older entry.")).toBeInTheDocument();
  });
  const calls = (fetchMock.mock.calls as FetchCall[]).map((call) => String(call[0]));
  expect(calls.some((url) => url.includes("before=42"))).toBe(true);
});

it("keeps Clear View after the search reloads the page", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse({
      board,
      entries: [entry({ id: "log-1", message: "Board came online." })],
      nextCursor: null,
      hasMore: false,
    })
  );
  globalThis.fetch = fetchMock as typeof fetch;
  const user = userEvent.setup();

  render(
    <TimezoneContext.Provider value="UTC">
      <BoardLogDialog board={board} open onOpenChange={() => {}} />
    </TimezoneContext.Provider>
  );

  await screen.findByText("Board came online.");
  await user.click(screen.getByTestId("board-log-clear"));
  await waitFor(() => {
    expect(screen.queryByText("Board came online.")).not.toBeInTheDocument();
  });

  // A new search reloads the newest page from the server. The server still
  // returns the row, but Clear View is a view-only decision: it must survive.
  const callsBefore = fetchMock.mock.calls.length;
  await user.type(screen.getByTestId("board-log-search"), "online");
  await waitFor(() => {
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });
  expect(screen.queryByText("Board came online.")).not.toBeInTheDocument();
  expect(screen.getByText(/Clear View only hides entries/)).toBeInTheDocument();
});

it("keeps a paused view buffered when the search reloads the page", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse({
      board,
      entries: [entry({ id: "log-1", message: "Board came online." })],
      nextCursor: null,
      hasMore: false,
    })
  );
  globalThis.fetch = fetchMock as typeof fetch;
  const user = userEvent.setup();

  render(
    <TimezoneContext.Provider value="UTC">
      <BoardLogDialog board={board} open onOpenChange={() => {}} />
    </TimezoneContext.Provider>
  );

  await screen.findByText("Board came online.");
  await user.click(screen.getByTestId("board-log-pause"));
  getRealtimeClient().applyEvents(
    [
      {
        entity: "log",
        action: "created",
        id: "log-live",
        ts: new Date().toISOString(),
        patch: {
          boardInstanceId: "board-1",
          category: "communication",
          severity: "success",
          status: "received",
          method: "mqtt",
          message: "Command received while paused.",
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      },
    ],
    { broadcast: false }
  );
  await waitFor(() => {
    expect(screen.getByTestId("board-log-live-indicator")).toHaveTextContent(/1 new entry/);
  });

  // Reloading the filtered page must not throw away the buffered entry or
  // silently resume the view.
  await user.type(screen.getByTestId("board-log-search"), "received");
  await waitFor(() => {
    expect(screen.getByTestId("board-log-live-indicator")).toHaveTextContent(/Paused/);
  });
  expect(screen.getByTestId("board-log-live-indicator")).toHaveTextContent(/1 new entry/);
  expect(screen.queryByText("Command received while paused.")).not.toBeInTheDocument();

  await user.click(screen.getByTestId("board-log-pause"));
  await waitFor(() => {
    expect(screen.getByText("Command received while paused.")).toBeInTheDocument();
  });
});

it("refills the newest page when the live channel reconnects", async () => {
  let calls = 0;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    calls += 1;
    const entries = [entry({ id: "log-1", message: "Board came online." })];
    if (calls > 1) {
      entries.push(
        entry({
          id: "log-missed",
          category: "command",
          severity: "success",
          status: "executed",
          method: "mqtt",
          message: "A command executed while the channel was down.",
          createdAt: "2026-11-25T12:10:00.000Z",
        })
      );
    }
    return jsonResponse({ board, entries, nextCursor: null, hasMore: false });
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <TimezoneContext.Provider value="UTC">
      <BoardLogDialog board={board} open onOpenChange={() => {}} />
    </TimezoneContext.Provider>
  );

  await screen.findByText("Board came online.");
  expect(calls).toBe(1);

  realtimeState = "reconnecting";
  view.rerender(
    <TimezoneContext.Provider value="UTC">
      <BoardLogDialog board={board} open onOpenChange={() => {}} />
    </TimezoneContext.Provider>
  );
  realtimeState = "live";
  view.rerender(
    <TimezoneContext.Provider value="UTC">
      <BoardLogDialog board={board} open onOpenChange={() => {}} />
    </TimezoneContext.Provider>
  );

  await waitFor(() => {
    expect(screen.getByText("A command executed while the channel was down.")).toBeInTheDocument();
  });
});

it("shows no entry of the previous board while the next board is loading", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("board-2")) {
      // The second board's page never resolves: the dialog must not keep the
      // first board's rows on screen while it waits.
      return new Promise<Response>(() => {});
    }
    return jsonResponse({
      board,
      entries: [entry({ id: "log-1", message: "Board came online." })],
      nextCursor: null,
      hasMore: false,
    });
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <TimezoneContext.Provider value="UTC">
      <BoardLogDialog board={board} open onOpenChange={() => {}} />
    </TimezoneContext.Provider>
  );
  await screen.findByText("Board came online.");

  view.rerender(
    <TimezoneContext.Provider value="UTC">
      <BoardLogDialog
        board={{ ...board, id: "board-2", name: "Hallway Node", boardRole: "node" }}
        open
        onOpenChange={() => {}}
      />
    </TimezoneContext.Provider>
  );

  await waitFor(() => {
    expect(screen.queryByText("Board came online.")).not.toBeInTheDocument();
  });
});

it("clears a paused buffer together with the view", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse({
      board,
      entries: [entry({ id: "log-1", message: "Board came online." })],
      nextCursor: null,
      hasMore: false,
    })
  );
  globalThis.fetch = fetchMock as typeof fetch;
  const user = userEvent.setup();

  render(
    <TimezoneContext.Provider value="UTC">
      <BoardLogDialog board={board} open onOpenChange={() => {}} />
    </TimezoneContext.Provider>
  );

  await screen.findByText("Board came online.");
  await user.click(screen.getByTestId("board-log-pause"));
  getRealtimeClient().applyEvents(
    [
      {
        entity: "log",
        action: "created",
        id: "log-buffered",
        ts: new Date().toISOString(),
        patch: {
          boardInstanceId: "board-1",
          category: "connection",
          severity: "info",
          status: "online",
          method: "http",
          message: "A buffered entry.",
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      },
    ],
    { broadcast: false }
  );
  await waitFor(() => {
    expect(screen.getByTestId("board-log-live-indicator")).toHaveTextContent(/1 new entry/);
  });

  await user.click(screen.getByTestId("board-log-clear"));
  // The buffer was part of the cleared view: the counter must not promise an
  // entry the view can never show.
  await waitFor(() => {
    expect(screen.getByTestId("board-log-live-indicator")).toHaveTextContent(/0 new entries/);
  });

  await user.click(screen.getByTestId("board-log-pause"));
  expect(screen.queryByText("A buffered entry.")).not.toBeInTheDocument();
  expect(screen.queryByText("Board came online.")).not.toBeInTheDocument();
});
