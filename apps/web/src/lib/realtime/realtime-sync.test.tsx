import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeProvider, useLiveSync } from "./RealtimeProvider";
import {
  RealtimeSyncClient,
  __resetRealtimeSingletonForTests,
  __setRealtimeSingletonForTests,
  type RealtimeChannelLike,
  type RealtimeSyncDeps,
} from "./sync-client";
import type { RealtimeBatch, RealtimeSnapshot } from "./types";
import type {
  RealtimeTransport,
  RealtimeTransportFactory,
  RealtimeTransportParams,
} from "./transport";

function emptySnapshot(accountId = "acct-1"): RealtimeSnapshot {
  return {
    v: 1,
    accountId,
    serverTime: new Date().toISOString(),
    entities: {
      boards: [],
      switches: [],
      devices: [],
      sensors: [],
      automations: [],
      homes: [],
    },
  };
}

function envelope(accountId: string, events: unknown[], sentAt = new Date().toISOString()) {
  return JSON.stringify({ v: 1, accountId, sentAt, events });
}

interface Harness {
  client: RealtimeSyncClient;
  emit: (payload: string) => void;
  transportParams: () => RealtimeTransportParams | null;
  transportCount: () => number;
  configCalls: () => number;
  snapshotCalls: () => number;
  batches: RealtimeBatch[];
  setSnapshot: (snapshot: RealtimeSnapshot) => void;
}

function createHarness(
  options: { accountId?: string; channelHub?: ReturnType<typeof createChannelHub>; enabled?: boolean } = {}
): Harness {
  const accountId = options.accountId ?? "acct-1";
  let params: RealtimeTransportParams | null = null;
  let transportCount = 0;
  let configCalls = 0;
  let snapshotCalls = 0;
  let snapshot = emptySnapshot(accountId);
  const batches: RealtimeBatch[] = [];

  const createTransport: RealtimeTransportFactory = (transportParams) => {
    params = transportParams;
    transportCount += 1;
    // Real transports call onConnected once SUBACK arrives; mirror that.
    queueMicrotask(() => transportParams.onConnected());
    const transport: RealtimeTransport = { close: () => {} };
    return transport;
  };

  const deps: Partial<RealtimeSyncDeps> = {
    fetchConfig: async () => {
      configCalls += 1;
      if (options.enabled === false) {
        return { enabled: false, reason: "emqx_not_configured", accountId };
      }
      return {
        enabled: true,
        accountId,
        transport: "mqtt-ws",
        credential: {
          brokerUrl: "wss://broker.example/mqtt",
          username: "hcweb-test",
          password: "derived-secret",
          topic: `homecore/${accountId}/realtime/#`,
          clientIdPrefix: "hcweb",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      };
    },
    fetchSnapshot: async () => {
      snapshotCalls += 1;
      return snapshot;
    },
    createTransport,
    createChannel: options.channelHub ?? (() => null),
    now: () => Date.now(),
    randomId: () => Math.random().toString(36).slice(2, 8),
  };

  const client = new RealtimeSyncClient(deps);
  client.subscribe((batch) => batches.push(batch));

  return {
    client,
    emit: (payload) => params?.onMessage(payload),
    transportParams: () => params,
    transportCount: () => transportCount,
    configCalls: () => configCalls,
    snapshotCalls: () => snapshotCalls,
    batches,
    setSnapshot: (next) => {
      snapshot = next;
    },
  };
}

/** In-memory BroadcastChannel hub shared by several clients in one test. */
function createChannelHub() {
  const peers = new Set<RealtimeChannelLike>();
  const factory = (): RealtimeChannelLike => {
    const channel: RealtimeChannelLike = {
      onmessage: null,
      postMessage: (message: unknown) => {
        for (const peer of peers) {
          if (peer === channel) continue;
          peer.onmessage?.({ data: structuredClone(message) });
        }
      },
      close: () => {
        peers.delete(channel);
      },
    };
    peers.add(channel);
    return channel;
  };
  return factory;
}

afterEach(() => {
  __resetRealtimeSingletonForTests();
  vi.useRealTimers();
});

describe("RealtimeSyncClient", () => {
  it("applies each event once and ignores duplicates and stale deliveries", async () => {
    const harness = createHarness();
    harness.client.start("acct-1");
    await waitFor(() => expect(harness.client.getStatus().state).toBe("live"));
    expect(harness.transportParams()?.topic).toBe("homecore/acct-1/realtime/#");
    expect(harness.transportParams()?.clientId.startsWith("hcweb-")).toBe(true);

    const newer = "2026-01-01T10:00:05.000Z";
    const older = "2026-01-01T10:00:01.000Z";

    harness.emit(
      envelope("acct-1", [
        { entity: "switch", action: "state", id: "sw1", ts: newer, phase: "confirmed" },
      ])
    );
    expect(harness.batches).toHaveLength(1);
    expect(harness.batches[0].entities).toEqual(["switch"]);

    // Duplicate delivery of the same event is dropped.
    harness.emit(
      envelope("acct-1", [
        { entity: "switch", action: "state", id: "sw1", ts: newer, phase: "confirmed" },
      ])
    );
    // Delayed, out-of-order delivery is dropped too.
    harness.emit(
      envelope("acct-1", [
        { entity: "switch", action: "state", id: "sw1", ts: older, phase: "confirmed" },
      ])
    );
    expect(harness.batches).toHaveLength(1);

    // A genuinely newer event for the same entity is applied.
    harness.emit(
      envelope("acct-1", [
        {
          entity: "switch",
          action: "state",
          id: "sw1",
          ts: "2026-01-01T10:00:06.000Z",
          phase: "confirmed",
        },
      ])
    );
    expect(harness.batches).toHaveLength(2);

    // Envelopes for another account are never applied.
    harness.emit(
      envelope("acct-2", [
        { entity: "switch", action: "state", id: "sw9", ts: newer, phase: "confirmed" },
      ])
    );
    expect(harness.batches).toHaveLength(2);
  });

  it("reloads only the entities that drifted after a reconnect", async () => {
    const harness = createHarness();
    const base = new Date(Date.now() - 60_000).toISOString();
    harness.setSnapshot({
      ...emptySnapshot(),
      entities: {
        boards: [],
        switches: [{ id: "sw1", version: base }],
        devices: [],
        sensors: [],
        automations: [],
        homes: [],
      },
    });

    harness.client.start("acct-1");
    await waitFor(() => expect(harness.client.getStatus().state).toBe("live"));
    await waitFor(() => expect(harness.snapshotCalls()).toBe(1));
    // First connection: the page already rendered its own data, no resync noise.
    expect(harness.batches.filter((batch) => batch.resync)).toHaveLength(0);

    // The socket drops, then the switch changes while the tab is disconnected.
    harness.transportParams()?.onDisconnected("closed");
    harness.setSnapshot({
      ...emptySnapshot(),
      entities: {
        boards: [],
        switches: [{ id: "sw1", version: new Date().toISOString() }],
        devices: [],
        sensors: [],
        automations: [],
        homes: [],
      },
    });

    await waitFor(() => expect(harness.transportCount()).toBe(2), { timeout: 5_000 });
    await waitFor(
      () => expect(harness.batches.some((batch) => batch.resync)).toBe(true),
      { timeout: 5_000 }
    );
    const resync = harness.batches.find((batch) => batch.resync)!;
    expect(resync.entities).toEqual(["switch"]);
    expect(resync.events).toHaveLength(0);
  });

  it("does not resync when the snapshot matches what the tab already applied", async () => {
    const harness = createHarness();
    harness.client.start("acct-1");
    await waitFor(() => expect(harness.client.getStatus().state).toBe("live"));
    await waitFor(() => expect(harness.snapshotCalls()).toBe(1));

    harness.emit(
      envelope("acct-1", [
        {
          entity: "sensor",
          action: "state",
          id: "s1",
          ts: new Date().toISOString(),
          phase: "confirmed",
        },
      ])
    );
    harness.setSnapshot({
      ...emptySnapshot(),
      entities: {
        boards: [],
        switches: [],
        devices: [],
        sensors: [{ id: "s1", version: harness.client.getVersion("sensor", "s1")! }],
        automations: [],
        homes: [],
      },
    });

    await harness.client.refreshSnapshot(true);
    expect(harness.batches.some((batch) => batch.resync)).toBe(false);
  });

  it("keeps one MQTT session per account across tabs and broadcasts to followers", async () => {
    const hub = createChannelHub();
    const leader = createHarness({ channelHub: hub });
    const follower = createHarness({ channelHub: hub });

    leader.client.start("acct-1");
    await waitFor(() => expect(leader.configCalls()).toBe(1));
    await waitFor(() => expect(leader.client.getStatus().state).toBe("live"));

    follower.client.start("acct-1");
    await new Promise((resolve) => setTimeout(resolve, 600));

    // The follower never opens its own broker session.
    expect(follower.configCalls()).toBe(0);
    expect(follower.transportCount()).toBe(0);
    expect(leader.transportCount()).toBe(1);

    // Leader events reach the follower tab without a second subscription.
    leader.emit(
      envelope("acct-1", [
        {
          entity: "device",
          action: "state",
          id: "d1",
          ts: new Date().toISOString(),
          phase: "confirmed",
        },
      ])
    );
    await waitFor(() => expect(follower.batches.length).toBeGreaterThan(0));
    expect(follower.batches[0].entities).toEqual(["device"]);
  });

  it("reports a disabled channel instead of polling tightly when EMQX is not configured", async () => {
    const harness = createHarness({ enabled: false });
    harness.client.start("acct-1");
    await waitFor(() => expect(harness.client.getStatus().state).toBe("disabled"));
    expect(harness.client.getStatus().reason).toBe("emqx_not_configured");
    expect(harness.transportCount()).toBe(0);
  });
});

describe("useLiveSync", () => {
  it("reloads the page when a matching real-time event arrives", async () => {
    const harness = createHarness();
    __setRealtimeSingletonForTests(harness.client);
    const reload = vi.fn();

    function Page() {
      useLiveSync(reload, { kinds: ["switch"], fallbackMs: 5_000 });
      return null;
    }

    render(
      <RealtimeProvider accountId="acct-1">
        <Page />
      </RealtimeProvider>
    );

    await waitFor(() => expect(harness.client.getStatus().state).toBe("live"), {
      timeout: 5_000,
    });

    harness.emit(
      envelope("acct-1", [
        {
          entity: "switch",
          action: "state",
          id: "sw1",
          ts: new Date().toISOString(),
          phase: "confirmed",
        },
      ])
    );
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 5_000 });

    // An event the page does not care about must not cause a reload.
    harness.emit(
      envelope("acct-1", [
        {
          entity: "automation",
          action: "run",
          id: "a1",
          ts: new Date(Date.now() + 1000).toISOString(),
        },
      ])
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("falls back to a slow visible-only refresh when the channel is disabled", async () => {
    const harness = createHarness({ enabled: false });
    __setRealtimeSingletonForTests(harness.client);
    const reload = vi.fn();

    function Page() {
      useLiveSync(reload, { kinds: ["sensor"], fallbackMs: 30 });
      return null;
    }

    render(
      <RealtimeProvider accountId="acct-1">
        <Page />
      </RealtimeProvider>
    );

    await waitFor(() => expect(reload.mock.calls.length).toBeGreaterThan(0), { timeout: 3_000 });
  });
});
