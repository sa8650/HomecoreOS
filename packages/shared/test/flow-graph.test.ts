import { describe, expect, it } from "vitest";
import {
  VERIFIED_BOARD_CATALOG,
  analyzeFlowGraphLocalCapability,
  autoLayoutFlowGraph,
  compileFlowGraphToRuleConfigs,
  flowGraphFromLegacyRule,
  normalizeChipFamily,
  validateBoardProfileSpec,
  validateBoardPublicationReady,
  validateFlowGraph,
  type FlowGraph,
} from "../src/index";

describe("Board Catalog & Visual Flow Graph Shared Engine", () => {
  it("validates every verified official Espressif and Seeed Studio catalog board", () => {
    expect(VERIFIED_BOARD_CATALOG.length).toBeGreaterThanOrEqual(10);

    for (const b of VERIFIED_BOARD_CATALOG) {
      expect(validateBoardProfileSpec(b)).toEqual({ valid: true, errors: [] });
      expect(validateBoardPublicationReady(b)).toEqual({ ready: true, errors: [] });
      expect(b.board_layout.leftHeader.pins.length).toBeGreaterThan(0);
      expect(b.board_layout.rightHeader.pins.length).toBeGreaterThan(0);
    }

    const s3v11 = VERIFIED_BOARD_CATALOG.find(
      (b) => b.slug === "esp32-s3-devkitc-1-n16r8"
    )!;
    expect(s3v11.firmware_status).toBe("firmware_supported");
    expect(s3v11.board_layout.rightHeader.pins.find((p) => p.gpioPin === 38)?.note).toMatch(
      /v1\.1/i
    );

    const xiao = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "seeed-xiao-esp32s3")!;
    expect(xiao.catalog_category).toBe("partner");
    expect(xiao.firmware_status).toBe("catalog_only");
    expect(xiao.board_layout.leftHeader.pins).toHaveLength(7);
    expect(xiao.board_layout.rightHeader.pins).toHaveLength(7);

    expect(normalizeChipFamily("ESP8684")).toBe("esp32c2");
    expect(normalizeChipFamily("ESP32-C61")).toBe("esp32c61");
    expect(normalizeChipFamily("ESP32-P4")).toBe("esp32p4");
  });

  it("blocks publication of unverified boards", () => {
    const unverified = {
      ...VERIFIED_BOARD_CATALOG[0]!,
      verification_status: "needs_verification" as const,
    };
    const res = validateBoardPublicationReady(unverified);
    expect(res.ready).toBe(false);
    expect(res.errors[0]).toMatch(/needs_verification/i);
  });

  it("detects cyclic flow graphs, performs topological auto-layout, and round-trips legacy rules", () => {
    const cyclicGraph: FlowGraph = {
      version: 1,
      variables: [],
      nodes: [
        {
          id: "t1",
          kind: "trigger",
          position: { x: 0, y: 0 },
          label: "Manual",
          config: { triggerType: "manual" },
        },
        {
          id: "a1",
          kind: "action",
          position: { x: 200, y: 0 },
          label: "Notify",
          config: {
            actionType: "notification",
            notificationTitle: "Hi",
            notificationMessage: "Ping",
          },
        },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "t1" },
      ],
    };

    const invalid = validateFlowGraph({ name: "Looping", graph: cyclicGraph });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some((e) => /loop/i.test(e))).toBe(true);

    const legacyGraph = flowGraphFromLegacyRule({
      name: "Hot Fan",
      trigger_config: {
        type: "sensor_value",
        sensorId: "11111111-1111-1111-1111-111111111111",
        operator: "gt",
        threshold: 30,
      },
      conditions_config: [
        {
          type: "switch_state",
          switchId: "22222222-2222-2222-2222-222222222222",
          expectedState: false,
        },
      ],
      actions_config: [
        {
          type: "switch_on",
          switchId: "22222222-2222-2222-2222-222222222222",
        },
      ],
    });

    const laidOut = autoLayoutFlowGraph(legacyGraph);
    expect(laidOut.nodes.length).toBe(3);
    expect(laidOut.nodes[0]!.position.x).toBeLessThan(laidOut.nodes[1]!.position.x);
    expect(laidOut.nodes[1]!.position.x).toBeLessThan(laidOut.nodes[2]!.position.x);

    const compiled = compileFlowGraphToRuleConfigs(laidOut);
    expect(compiled.isSimpleLinear).toBe(true);
    expect(compiled.actionsConfig).toHaveLength(1);

    const localCap = analyzeFlowGraphLocalCapability({
      graph: laidOut,
      switchControllerById: new Map([["22222222-2222-2222-2222-222222222222", "c1"]]),
      deviceControllerById: new Map(),
      sensorControllerById: new Map([["11111111-1111-1111-1111-111111111111", "c1"]]),
    });
    expect(localCap.supported).toBe(true);
    expect(localCap.controllerId).toBe("c1");
  });
});
