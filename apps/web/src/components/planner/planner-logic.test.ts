import { PLANNER_INPUT_LIMITS, PLANNER_STAGE_ORDER, type PlannerStageEvent } from "@homecoreos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { analyzePlannerRequirements } from "@/lib/planner-api";
import {
  applyStageEvent,
  createPendingStages,
  describePlannerProgress,
  describePlannerStepCount,
  failRunningStages,
} from "./PlannerAnalysisProgress";
import {
  addLocation,
  addRoom,
  createEmptyDraft,
  draftToRequirements,
  duplicateRoom,
  loadStoredDraft,
  removeLocation,
  removeRoom,
  requirementsToDraft,
  setDeviceIndependent,
  setDeviceQuantity,
  setFanSpeedControl,
  setFloors,
  storeDraft,
  updateLocation,
  updateRoom,
  type PlannerDraft,
} from "./planner-draft";

const originalFetch = globalThis.fetch;

function draftWithRoom(name = "Living Room"): { draft: PlannerDraft; roomId: string } {
  const draft = addRoom(createEmptyDraft(), name);
  return { draft, roomId: draft.rooms[0]!.id };
}

describe("planner draft: rooms and device counts", () => {
  it("adds rooms with distinct ids and distinct names", () => {
    let draft = createEmptyDraft();
    draft = addRoom(draft, "Bedroom");
    draft = addRoom(draft, "Bedroom");
    draft = addRoom(draft, "Bedroom");
    draft = addRoom(draft);
    expect(draft.rooms.map((room) => room.name)).toEqual(["Bedroom", "Bedroom 2", "Bedroom 3", "Room 4"]);
    expect(new Set(draft.rooms.map((room) => room.id)).size).toBe(4);
  });

  it("gives a new room an id that no remaining room uses, even after removals", () => {
    let draft = createEmptyDraft();
    draft = addRoom(draft, "A");
    draft = addRoom(draft, "B");
    draft = addRoom(draft, "C");
    // Removing from the front and the middle leaves gaps in the numbering.
    draft = removeRoom(draft, draft.rooms[0]!.id);
    draft = addRoom(draft, "D");
    draft = removeRoom(draft, draft.rooms[1]!.id);
    draft = addRoom(draft, "E");
    draft = addRoom(draft, "F");
    expect(draft.rooms.map((room) => room.name)).toEqual(["B", "D", "E", "F"]);
    expect(new Set(draft.rooms.map((room) => room.id)).size).toBe(draft.rooms.length);
  });

  it("stops adding rooms at the planner's room limit", () => {
    let draft = createEmptyDraft();
    for (let i = 0; i < PLANNER_INPUT_LIMITS.maxRooms + 5; i++) draft = addRoom(draft);
    expect(draft.rooms).toHaveLength(PLANNER_INPUT_LIMITS.maxRooms);
  });

  it("duplicates a room with its devices, right after the original", () => {
    const { draft: start, roomId } = draftWithRoom("Bedroom");
    let draft = start;
    draft = setDeviceQuantity(draft, roomId, "lights", 4);
    draft = setDeviceIndependent(draft, roomId, "lights", 2);
    draft = addRoom(draft, "Kitchen");
    draft = duplicateRoom(draft, roomId);
    expect(draft.rooms.map((room) => room.name)).toEqual(["Bedroom", "Bedroom 2", "Kitchen"]);
    expect(draft.rooms[1]!.devices.lights).toEqual({ quantity: 4, independent: 2 });
    // The copy owns its counts: changing it leaves the original alone.
    draft = setDeviceQuantity(draft, draft.rooms[1]!.id, "lights", 1);
    expect(draft.rooms[0]!.devices.lights).toEqual({ quantity: 4, independent: 2 });
  });

  it("controls every device separately until the customer says otherwise", () => {
    const { draft: start, roomId } = draftWithRoom();
    let draft = start;
    draft = setDeviceQuantity(draft, roomId, "lights", 6);
    expect(draft.rooms[0]!.devices.lights).toEqual({ quantity: 6, independent: 6 });

    draft = setDeviceIndependent(draft, roomId, "lights", 2);
    draft = setDeviceQuantity(draft, roomId, "lights", 8);
    expect(draft.rooms[0]!.devices.lights).toEqual({ quantity: 8, independent: 2 });

    // Fewer devices than groups: the group count follows down.
    draft = setDeviceQuantity(draft, roomId, "lights", 1);
    expect(draft.rooms[0]!.devices.lights).toEqual({ quantity: 1, independent: 1 });
    draft = setDeviceQuantity(draft, roomId, "lights", 0);
    expect(draft.rooms[0]!.devices.lights).toEqual({ quantity: 0, independent: 0 });
  });

  it("keeps separately switched counts between 1 and the quantity", () => {
    const { draft: start, roomId } = draftWithRoom();
    let draft = start;
    draft = setDeviceQuantity(draft, roomId, "fans", 3);
    draft = setDeviceIndependent(draft, roomId, "fans", 99);
    expect(draft.rooms[0]!.devices.fans.independent).toBe(3);
    draft = setDeviceIndependent(draft, roomId, "fans", 0);
    expect(draft.rooms[0]!.devices.fans.independent).toBe(1);
    draft = setDeviceIndependent(draft, roomId, "fans", Number.NaN);
    expect(draft.rooms[0]!.devices.fans.independent).toBe(1);
  });

  it("does not let sensors share a connection", () => {
    const { draft: start, roomId } = draftWithRoom();
    let draft = start;
    draft = setDeviceQuantity(draft, roomId, "motion_sensors", 3);
    draft = setDeviceIndependent(draft, roomId, "motion_sensors", 1);
    expect(draft.rooms[0]!.devices.motion_sensors).toEqual({ quantity: 3, independent: 3 });
  });

  it("limits speed-controlled fans to the fans that are switched separately", () => {
    const { draft: start, roomId } = draftWithRoom();
    let draft = start;
    draft = setDeviceQuantity(draft, roomId, "fans", 3);
    draft = setFanSpeedControl(draft, roomId, 5);
    expect(draft.rooms[0]!.fanSpeedControl).toBe(3);
    draft = setDeviceIndependent(draft, roomId, "fans", 1);
    expect(draft.rooms[0]!.fanSpeedControl).toBe(1);
    draft = setDeviceQuantity(draft, roomId, "fans", 0);
    expect(draft.rooms[0]!.fanSpeedControl).toBe(0);
  });

  it("clamps quantities to the planner's limits and ignores junk", () => {
    const { draft: start, roomId } = draftWithRoom();
    let draft = start;
    draft = setDeviceQuantity(draft, roomId, "lights", 10_000);
    expect(draft.rooms[0]!.devices.lights.quantity).toBe(PLANNER_INPUT_LIMITS.maxQuantityPerCategory);
    draft = setDeviceQuantity(draft, roomId, "lights", -3);
    expect(draft.rooms[0]!.devices.lights.quantity).toBe(0);
    draft = setDeviceQuantity(draft, roomId, "lights", Number.NaN);
    expect(draft.rooms[0]!.devices.lights.quantity).toBe(0);
    draft = setDeviceQuantity(draft, roomId, "lights", 2.9);
    expect(draft.rooms[0]!.devices.lights.quantity).toBe(2);
  });

  it("pulls rooms and locations down when floors are removed", () => {
    const { draft: start, roomId } = draftWithRoom();
    let draft = start;
    draft = setFloors(draft, 3);
    draft = updateRoom(draft, roomId, { floor: 3 });
    draft = addLocation(draft);
    draft = updateLocation(draft, draft.locations[0]!.id, { floor: 3 });
    draft = setFloors(draft, 2);
    expect(draft.rooms[0]!.floor).toBe(2);
    expect(draft.locations[0]!.floor).toBe(2);
    expect(setFloors(draft, 0).floors).toBe(1);
    expect(setFloors(draft, 99).floors).toBe(PLANNER_INPUT_LIMITS.maxFloors);
  });

  it("sends rooms of a removed controller location back to the default one", () => {
    const { draft: start, roomId } = draftWithRoom();
    let draft = start;
    draft = addLocation(addLocation(draft));
    const second = draft.locations[1]!.id;
    draft = updateRoom(draft, roomId, { locationId: second });
    draft = removeLocation(draft, second);
    expect(draft.locations).toHaveLength(1);
    expect(draft.rooms[0]!.locationId).toBeNull();
  });
});

describe("planner draft: conversion to and from requirements", () => {
  it("sends only what the customer entered", () => {
    const { draft: start, roomId } = draftWithRoom("  Living Room  ");
    let draft = start;
    draft = setDeviceQuantity(draft, roomId, "lights", 6);
    draft = setDeviceIndependent(draft, roomId, "lights", 3);
    draft = { ...draft, wifi: "strong", maxCableRunMeters: 12 };

    expect(draftToRequirements(draft)).toEqual({
      home: {
        floors: 1,
        rooms: [
          {
            id: roomId,
            name: "Living Room",
            floor: 1,
            locationId: null,
            // Categories left at zero are not sent at all.
            devices: { lights: { quantity: 6, independent: 3 } },
            fanSpeedControl: 0,
          },
        ],
        controllerLocations: [],
      },
      installation: {
        wifi: "strong",
        ethernet: "not_needed",
        // Unanswered questions stay unanswered; nothing is filled in for the customer.
        environment: null,
        maxCableRunMeters: 12,
        sensorWiring: null,
        allowAdditionalControllers: true,
        allowExternalRelayModules: true,
        futureOutputs: 0,
        futureInputs: 0,
      },
    });
  });

  it("round-trips a full draft without changing it", () => {
    let draft = createEmptyDraft();
    draft = setFloors(draft, 2);
    draft = addLocation(addLocation(draft));
    draft = updateLocation(draft, draft.locations[1]!.id, { name: "Upstairs cupboard", floor: 2 });
    draft = addRoom(addRoom(draft, "Living Room"), "Bedroom");
    const [living, bedroom] = draft.rooms.map((room) => room.id) as [string, string];
    draft = setDeviceQuantity(draft, living, "lights", 6);
    draft = setDeviceIndependent(draft, living, "lights", 3);
    draft = setDeviceQuantity(draft, living, "fans", 2);
    draft = setFanSpeedControl(draft, living, 1);
    draft = setDeviceQuantity(draft, bedroom, "climate_sensors", 1);
    draft = updateRoom(draft, bedroom, { floor: 2, locationId: draft.locations[1]!.id });
    draft = {
      ...draft,
      wifi: "weak",
      ethernet: "preferred",
      environment: "electrical_panel",
      maxCableRunMeters: 20,
      sensorWiring: "unsure",
      allowAdditionalControllers: false,
      futureOutputs: 4,
      futureInputs: 2,
    };

    const restored = requirementsToDraft(draftToRequirements(draft));
    expect(restored).toEqual(draft);
    expect(draftToRequirements(restored)).toEqual(draftToRequirements(draft));
  });

  it("keeps an explicit \"not sure\" instead of the wiring the planner assumes for it", () => {
    const restored = requirementsToDraft({
      home: { rooms: [{ name: "Hall", devices: { motion_sensors: { quantity: 1 } } }] },
      installation: { wifi: "strong", sensorWiring: "unsure" },
    });
    expect(restored.sensorWiring).toBe("unsure");
    expect(requirementsToDraft({ installation: { sensorWiring: "telepathy" } }).sensorWiring).toBeNull();
  });

  it("does not invent a controller location the customer never added", () => {
    const restored = requirementsToDraft({
      home: { rooms: [{ id: "r1", name: "Hall", locationId: "main", devices: {} }], controllerLocations: [] },
    });
    expect(restored.locations).toEqual([]);
    expect(restored.rooms[0]!.locationId).toBeNull();
  });

  it("drops malformed and out-of-range input instead of trusting it", () => {
    const restored = requirementsToDraft({
      home: {
        floors: "many",
        rooms: [
          { id: "r1", name: "A".repeat(500), devices: { lights: { quantity: 9999, independent: -4 }, lasers: { quantity: 3 } } },
          "not a room",
          null,
        ],
      },
      installation: { wifi: "5G", ethernet: 7, futureOutputs: 1e9, allowAdditionalControllers: "no" },
    });
    expect(restored.floors).toBe(1);
    expect(restored.rooms).toHaveLength(1);
    expect(restored.rooms[0]!.name).toHaveLength(PLANNER_INPUT_LIMITS.maxNameLength);
    expect(restored.rooms[0]!.devices.lights).toEqual({
      quantity: PLANNER_INPUT_LIMITS.maxQuantityPerCategory,
      independent: 1,
    });
    expect(Object.keys(restored.rooms[0]!.devices)).not.toContain("lasers");
    expect(restored.wifi).toBeNull();
    expect(restored.ethernet).toBe("not_needed");
    expect(restored.futureOutputs).toBe(PLANNER_INPUT_LIMITS.maxFutureChannels);
    expect(restored.allowAdditionalControllers).toBe(true);

    for (const junk of [null, undefined, 42, "text", [], { home: [] }]) {
      expect(requirementsToDraft(junk)).toEqual(createEmptyDraft());
    }
  });
});

describe("planner draft: unsaved answers kept per browser tab and account", () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => window.sessionStorage.clear());

  it("restores answers for the same account only", () => {
    const { draft } = draftWithRoom("Kitchen");
    storeDraft("account-a", { ...draft, wifi: "strong" }, 3);

    const restored = loadStoredDraft("account-a");
    expect(restored?.step).toBe(3);
    expect(restored?.draft.rooms.map((room) => room.name)).toEqual(["Kitchen"]);
    expect(restored?.draft.wifi).toBe("strong");
    expect(loadStoredDraft("account-b")).toBeNull();
  });

  it("remembers the saved plan the answers belong to", () => {
    const { draft } = draftWithRoom("Kitchen");
    const link = { id: "plan-7", name: "Ground floor", savedKey: "fingerprint" };

    storeDraft("account-a", draft, 4, link);
    expect(loadStoredDraft("account-a")?.plan).toEqual(link);

    // Answers that were never saved carry no plan.
    storeDraft("account-a", draft, 4);
    expect(loadStoredDraft("account-a")?.plan).toBeNull();
    storeDraft("account-a", draft, 4, null);
    expect(loadStoredDraft("account-a")?.plan).toBeNull();

    // A damaged link is dropped; the answers themselves are still restored.
    for (const plan of [{ id: "plan-7", name: "Ground floor" }, { id: 7, name: "x", savedKey: "k" }, "plan-7", []]) {
      window.sessionStorage.setItem(
        "homecoreos:planner-draft:account-a",
        JSON.stringify({ requirements: { home: { rooms: [{ name: "Den" }] } }, step: 2, plan })
      );
      const restored = loadStoredDraft("account-a");
      expect(restored?.plan).toBeNull();
      expect(restored?.draft.rooms.map((room) => room.name)).toEqual(["Den"]);
    }
  });

  it("forgets the draft once the wizard is empty again", () => {
    const { draft } = draftWithRoom();
    storeDraft("account-a", draft, 2);
    expect(window.sessionStorage.length).toBe(1);
    storeDraft("account-a", createEmptyDraft(), 1);
    expect(window.sessionStorage.length).toBe(0);
    expect(loadStoredDraft("account-a")).toBeNull();
  });

  it("survives corrupted storage", () => {
    window.sessionStorage.setItem("homecoreos:planner-draft:account-a", "{not json");
    expect(loadStoredDraft("account-a")).toBeNull();
    window.sessionStorage.setItem("homecoreos:planner-draft:account-a", JSON.stringify({ step: 2 }));
    expect(loadStoredDraft("account-a")).toBeNull();
    window.sessionStorage.setItem(
      "homecoreos:planner-draft:account-a",
      JSON.stringify({ requirements: { home: { rooms: [{ name: "Den" }] } }, step: 99 })
    );
    expect(loadStoredDraft("account-a")).toMatchObject({ step: 1 });
  });
});

describe("planner progress: stages only change when the server says so", () => {
  it("starts with every stage pending and no details", () => {
    const stages = createPendingStages();
    expect(stages).toHaveLength(9);
    expect(stages.every((s) => s.status === "pending" && s.detail === null && s.durationMs === null)).toBe(true);
    expect(describePlannerProgress(stages)).toBe("Sending your requirements");
  });

  it("applies an event to its own stage and leaves the others untouched", () => {
    let stages = createPendingStages();
    stages = applyStageEvent(stages, { id: "load_boards", status: "running" });
    stages = applyStageEvent(stages, { id: "load_firmware", status: "running" });
    expect(stages.filter((s) => s.status === "running").map((s) => s.id)).toEqual(["load_boards", "load_firmware"]);
    expect(describePlannerProgress(stages)).toBe("Reading the Board Library and reading firmware releases");

    stages = applyStageEvent(stages, {
      id: "load_boards",
      status: "completed",
      durationMs: 41,
      detail: "11 boards in the Board Library",
    });
    expect(stages.find((s) => s.id === "load_boards")).toMatchObject({
      status: "completed",
      durationMs: 41,
      detail: "11 boards in the Board Library",
    });
    expect(stages.find((s) => s.id === "allocation")!.status).toBe("pending");
    expect(describePlannerProgress(stages)).toBe("Reading firmware releases");
  });

  it("counts only steps that really ran, and does not call a cut-short analysis complete", () => {
    let stages = createPendingStages();
    expect(describePlannerStepCount(stages)).toBe("0 of 9 steps");
    for (const id of PLANNER_STAGE_ORDER) {
      stages = applyStageEvent(stages, { id, status: "completed", durationMs: 1, detail: "ok" });
    }
    expect(describePlannerProgress(stages)).toBe("Analysis complete");
    expect(describePlannerStepCount(stages)).toBe("9 of 9 steps");

    // Missing answers: the Worker reports the first step done and the rest skipped.
    let cutShort = createPendingStages();
    cutShort = applyStageEvent(cutShort, { id: "requirements", status: "completed", durationMs: 1, detail: "ok" });
    for (const id of PLANNER_STAGE_ORDER.slice(1)) {
      cutShort = applyStageEvent(cutShort, { id, status: "skipped", detail: "Skipped: more information is needed first" });
    }
    expect(describePlannerProgress(cutShort)).toBe("Analysis ended early");
    expect(describePlannerStepCount(cutShort)).toBe("1 of 9 steps, 8 skipped");
  });

  it("marks only in-flight stages as stopped when the analysis fails", () => {
    let stages = createPendingStages();
    stages = applyStageEvent(stages, { id: "requirements", status: "completed", durationMs: 1, detail: "ok" });
    stages = applyStageEvent(stages, { id: "load_boards", status: "running" });
    stages = failRunningStages(stages);
    expect(stages.map((s) => s.status).slice(0, 3)).toEqual(["completed", "failed", "pending"]);
    expect(describePlannerProgress(stages)).toBe("The analysis stopped");
  });
});

describe("planner API client: analysis stream", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function streamResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
  }

  const RESULT = { state: "incomplete", stages: [], plans: [] };

  it("asks for a stage stream and reports every stage in the order it arrived", async () => {
    const lines = [
      JSON.stringify({ type: "stage", stage: { id: "requirements", status: "running", durationMs: null, detail: null } }),
      JSON.stringify({ type: "stage", stage: { id: "requirements", status: "completed", durationMs: 2, detail: "1 room" } }),
      JSON.stringify({ type: "result", result: RESULT, requirements: { home: { floors: 1 } } }),
    ].join("\n");
    // Split in awkward places: in the middle of a line and in the middle of a token.
    const fetchMock = vi.fn(async () => streamResponse([lines.slice(0, 17), lines.slice(17, 140), lines.slice(140) + "\n"]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const seen: PlannerStageEvent[] = [];
    const analysis = await analyzePlannerRequirements(
      { home: { floors: 1 } },
      { onStage: (event) => seen.push(event) }
    );

    expect(seen.map((e) => `${e.id}:${e.status}`)).toEqual(["requirements:running", "requirements:completed"]);
    expect(seen[1]!.detail).toBe("1 room");
    expect(analysis.result).toEqual(RESULT);
    expect(analysis.requirements).toEqual({ home: { floors: 1 } });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/planner/analyze");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).get("accept")).toContain("application/x-ndjson");
    // The client sends requirements only. It has no way to send a result.
    expect(JSON.parse(String(init.body))).toEqual({ requirements: { home: { floors: 1 } } });
  });

  it("decodes characters that are split across network chunks", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(
      `${JSON.stringify({ type: "stage", stage: { id: "ranking", status: "completed", durationMs: 1, detail: "Best match: Café · 2 × board" } })}\n${JSON.stringify({ type: "result", result: RESULT, requirements: {} })}\n`
    );
    const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn(
      async () => new Response(body, { headers: { "Content-Type": "application/x-ndjson" } })
    ) as unknown as typeof fetch;

    const seen: PlannerStageEvent[] = [];
    await analyzePlannerRequirements({}, { onStage: (event) => seen.push(event) });
    expect(seen[0]!.detail).toBe("Best match: Café · 2 × board");
  });

  it("turns a server-reported error into an ApiError carrying the customer message", async () => {
    globalThis.fetch = vi.fn(async () =>
      streamResponse([
        `${JSON.stringify({ type: "stage", stage: { id: "load_boards", status: "failed", durationMs: 3, detail: "The Board Library could not be read" } })}\n`,
        `${JSON.stringify({ type: "error", error: "The Board Library could not be read. Please try again." })}\n`,
      ])
    ) as unknown as typeof fetch;

    const seen: PlannerStageEvent[] = [];
    await expect(
      analyzePlannerRequirements({}, { onStage: (event) => seen.push(event) })
    ).rejects.toMatchObject({
      name: "ApiError",
      message: "The Board Library could not be read. Please try again.",
    });
    expect(seen.map((e) => e.status)).toEqual(["failed"]);
  });

  it("fails clearly when the stream ends without a result", async () => {
    globalThis.fetch = vi.fn(async () =>
      streamResponse([`${JSON.stringify({ type: "stage", stage: { id: "requirements", status: "running" } })}\n`])
    ) as unknown as typeof fetch;
    await expect(analyzePlannerRequirements({})).rejects.toThrow(/ended before a result arrived/);
  });

  it("fails clearly on a corrupted line instead of showing a partial result", async () => {
    globalThis.fetch = vi.fn(async () => streamResponse(['{"type":"stage","sta\n'])) as unknown as typeof fetch;
    await expect(analyzePlannerRequirements({})).rejects.toBeInstanceOf(ApiError);
  });

  it("maps HTTP errors to the message and status the Worker sent", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "This plan is too large to analyze. Split it into smaller plans." }), {
          status: 413,
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof fetch;
    await expect(analyzePlannerRequirements({})).rejects.toMatchObject({
      status: 413,
      message: "This plan is too large to analyze. Split it into smaller plans.",
    });

    globalThis.fetch = vi.fn(async () => new Response("upstream down", { status: 502 })) as unknown as typeof fetch;
    await expect(analyzePlannerRequirements({})).rejects.toMatchObject({
      status: 502,
      message: "Request failed (502)",
    });
  });

  it("accepts a plain JSON answer and then reports no stages, because none were sent", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: RESULT, requirements: {} }), {
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof fetch;
    const onStage = vi.fn();
    const analysis = await analyzePlannerRequirements({}, { onStage });
    expect(analysis.result).toEqual(RESULT);
    expect(onStage).not.toHaveBeenCalled();

    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } })
    ) as unknown as typeof fetch;
    await expect(analyzePlannerRequirements({})).rejects.toThrow(/unexpected response/);
  });
});
