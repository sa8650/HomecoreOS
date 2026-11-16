import { describe, expect, it } from "vitest";
import {
  COMMUNITY_PARTNER_BOARDS,
  NODEMCU_ESP8266_BOARD,
  SUPPORTED_CHIP_FAMILIES,
  VERIFIED_BOARD_CATALOG,
  WAVESHARE_ESP_OFFICIAL_BOARDS,
  buildTriggerConfigFromList,
  chipFamilyLabel,
  compileFlowGraphToRuleConfigs,
  findWaveshareEspOfficialBoard,
  normalizeTriggerList,
  validateAutomationDraft,
  validateBoardProfileSpec,
} from "../src/index";

describe("Waveshare ESP32 catalog, NodeMCU ESP8266 support, and manual Scene trigger", () => {
  it("registers esp8266 as a supported chip family with display label", () => {
    expect(SUPPORTED_CHIP_FAMILIES).toContain("esp8266");
    expect(chipFamilyLabel("esp8266")).toBe("ESP8266");
  });

  it("keeps all 5 Waveshare ESP32 boards and NodeMCU ESP8266 schema-valid with unique slugs", () => {
    expect(WAVESHARE_ESP_OFFICIAL_BOARDS).toHaveLength(5);

    const expectedSlugs = [
      "waveshare-esp32-s3-zero",
      "waveshare-esp32-c6-zero",
      "waveshare-esp32-c3-zero",
      "waveshare-esp32-s3-pico",
      "waveshare-esp32-s3-relay-6ch",
    ];
    expect(WAVESHARE_ESP_OFFICIAL_BOARDS.map((b) => b.seed.slug)).toEqual(expectedSlugs);

    for (const entry of WAVESHARE_ESP_OFFICIAL_BOARDS) {
      const check = validateBoardProfileSpec(entry.seed);
      expect(check.valid, `${entry.seed.slug}: ${check.errors.join("; ")}`).toBe(true);
      expect(entry.seed.manufacturer).toBe("Waveshare");
      expect(entry.seed.gpio_definitions.length).toBeGreaterThan(0);
      expect(findWaveshareEspOfficialBoard(entry.seed.slug)?.seed.slug).toBe(entry.seed.slug);
    }

    const esp8266Check = validateBoardProfileSpec(NODEMCU_ESP8266_BOARD);
    expect(esp8266Check.valid, esp8266Check.errors.join("; ")).toBe(true);
    expect(NODEMCU_ESP8266_BOARD.slug).toBe("nodemcu-esp8266");
    expect(NODEMCU_ESP8266_BOARD.chip_family).toBe("esp8266");
    expect(NODEMCU_ESP8266_BOARD.gpio_definitions.some((g) => g.pin === 4)).toBe(true);
    expect(
      NODEMCU_ESP8266_BOARD.gpio_definitions.some((g) => g.restrictions.flash_psram_conflict)
    ).toBe(true);

    // Seeded community/partner defaults are Waveshare ESP32-S3-Zero + NodeMCU ESP8266
    expect(COMMUNITY_PARTNER_BOARDS.map((b) => b.slug)).toEqual([
      "waveshare-esp32-s3-zero",
      "nodemcu-esp8266",
    ]);

    // Every slug across VERIFIED_BOARD_CATALOG + all 5 Waveshare boards + NodeMCU ESP8266 is unique
    const combined = [
      ...VERIFIED_BOARD_CATALOG,
      ...WAVESHARE_ESP_OFFICIAL_BOARDS.map((b) => b.seed),
      NODEMCU_ESP8266_BOARD,
    ];
    const slugs = new Set(combined.map((b) => b.slug));
    expect(slugs.size).toBe(combined.length);
  });

  it("validates and round-trips manual Scene trigger across automations and flow-graph compiler", () => {
    const triggerConfig = buildTriggerConfigFromList([{ type: "manual" }]);
    expect(normalizeTriggerList(triggerConfig)).toEqual([{ type: "manual" }]);

    const draftCheck = validateAutomationDraft({
      name: "Goodnight Scene",
      triggers: [{ type: "manual" }],
      conditions: { logic: "AND", groups: [] },
      actions: [
        {
          type: "scene",
          sceneName: "Goodnight",
          targets: [
            {
              kind: "switch",
              switchId: "11111111-1111-4111-8111-111111111111",
              isOn: false,
            },
          ],
        },
      ],
    });
    expect(draftCheck.valid, draftCheck.errors.join("; ")).toBe(true);

    const compiled = compileFlowGraphToRuleConfigs({
      version: 1,
      nodes: [
        {
          id: "t1",
          kind: "trigger",
          label: "Manual Scene",
          position: { x: 0, y: 0 },
          config: { triggerType: "manual" },
        },
        {
          id: "a1",
          kind: "action",
          label: "Turn On",
          position: { x: 240, y: 0 },
          config: {
            actionType: "switch_on",
            switchId: "11111111-1111-4111-8111-111111111111",
          },
        },
      ],
      edges: [{ id: "e1", from: "t1", to: "a1" }],
    });

    expect(normalizeTriggerList(compiled.triggerConfig)).toMatchObject([
      { id: "t1", type: "manual" },
    ]);
  });
});
