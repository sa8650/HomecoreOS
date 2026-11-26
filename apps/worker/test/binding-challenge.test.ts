import { describe, expect, it } from "vitest";
import { verifyNodeBinding } from "../src/lib/board-roles";
import type { DbClient } from "../src/lib/db";

interface Scenario {
  pending: { id: string; nonce: string; generation: number } | null;
}

function mockDb(scenario: Scenario) {
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  let consumed = 0;

  const chain = (data: unknown) => ({
    select: () => chain(data),
    eq: () => chain(data),
    is: () => chain(data),
    gt: () => chain(data),
    order: () => chain(data),
    limit: () => chain(data),
    maybeSingle: async () => ({ data, error: null }),
    update: (values: Record<string, unknown>) => {
      if (data === scenario.pending) consumed++;
      updates.push({ table: "update", values });
      return chain(data);
    },
    insert: (values: Record<string, unknown>) => {
      updates.push({ table: "insert", values });
      return chain(data);
    },
  });

  const client = {
    from(table: string) {
      if (table === "board_instances") {
        return chain({
          id: "node-1",
          board_role: "node",
          assigned_controller_id: "ctrl-1",
          binding_generation: 3,
          binding_state: "assigned",
          binding_id: "binding-1",
        });
      }
      if (table === "board_binding_challenges") return chain(scenario.pending);
      return chain(null);
    },
  };
  return { db: client as unknown as DbClient, updates, consumed: () => consumed };
}

const base = {
  nodeId: "node-1",
  controllerId: "ctrl-1",
  generation: 4,
  bindingId: "binding-1",
  espnowLinked: true,
  rosterConfirmed: true,
  controllerMqttHealthy: true,
};

describe("Worker-authorized binding challenge", () => {
  it("verifies only with the exact challenge ID, nonce and generation", async () => {
    const mock = mockDb({ pending: { id: "ch-1", nonce: "abc123", generation: 4 } });
    const verdict = await verifyNodeBinding(mock.db, "acct-1", {
      ...base,
      challengeId: "ch-1",
      challengeNonce: "abc123",
    });
    expect(verdict).toEqual({ verified: true, generation: 4 });
    expect(mock.consumed()).toBe(1);
    expect(mock.updates.some((u) => u.values.binding_state === "verified")).toBe(true);
  });

  it("rejects a wrong nonce or a stale generation without consuming the challenge", async () => {
    const mock = mockDb({ pending: { id: "ch-1", nonce: "abc123", generation: 4 } });
    expect(
      await verifyNodeBinding(mock.db, "acct-1", {
        ...base,
        challengeId: "ch-1",
        challengeNonce: "wrong",
      })
    ).toEqual({ verified: false, generation: 4 });
    expect(
      await verifyNodeBinding(mock.db, "acct-1", {
        ...base,
        generation: 3,
        challengeId: "ch-1",
        challengeNonce: "abc123",
      })
    ).toEqual({ verified: false, generation: 3 });
    expect(mock.consumed()).toBe(0);
  });

  it("rejects replayed and unknown challenge IDs when no challenge is pending", async () => {
    const mock = mockDb({ pending: null });
    expect(
      await verifyNodeBinding(mock.db, "acct-1", {
        ...base,
        challengeId: "ch-1",
        challengeNonce: "abc123",
      })
    ).toEqual({ verified: false, generation: 4 });
    expect(mock.updates).toHaveLength(0);
  });

  it("keeps legacy bindings verifiable when no challenge is pending", async () => {
    const mock = mockDb({ pending: null });
    const verdict = await verifyNodeBinding(mock.db, "acct-1", base);
    expect(verdict.verified).toBe(true);
  });
});
