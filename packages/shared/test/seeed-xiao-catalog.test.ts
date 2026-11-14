import { describe, expect, it } from "vitest";
import {
  BOARD_REVISION_UNSPECIFIED,
  SEEED_XIAO_OFFICIAL_BOARDS,
  VERIFIED_BOARD_CATALOG,
  boardPadMap,
  displayBoardRevision,
  findSeeedXiaoOfficialBoard,
  validateBoardProfileSpec,
  validateBoardPublicationReady,
} from "../src/index";

const bySlug = (slug: string) => {
  const board = findSeeedXiaoOfficialBoard(slug);
  if (!board) throw new Error(`missing reference board ${slug}`);
  return board;
};

describe("Seeed Studio XIAO reference profiles", () => {
  it("covers the six official ESP32-based XIAO boards with unique slugs", () => {
    const slugs = SEEED_XIAO_OFFICIAL_BOARDS.map((b) => b.seed.slug);
    expect(slugs.sort()).toEqual(
      [
        "seeed-xiao-esp32c3",
        "seeed-xiao-esp32c5",
        "seeed-xiao-esp32c6",
        "seeed-xiao-esp32s3",
        "seeed-xiao-esp32s3-plus",
        "seeed-xiao-esp32s3-sense",
      ].sort()
    );
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("does not add boards to the verified seed catalog (import is an admin decision)", () => {
    expect(VERIFIED_BOARD_CATALOG).toHaveLength(11);
    const seeded = VERIFIED_BOARD_CATALOG.filter((b) => b.slug.startsWith("seeed-xiao"));
    expect(seeded.map((b) => b.slug)).toEqual(["seeed-xiao-esp32s3"]);
    // The already shipped XIAO ESP32-S3 is reused, not redefined.
    expect(bySlug("seeed-xiao-esp32s3").seed.gpio_definitions).toEqual(seeded[0]!.gpio_definitions);
  });

  it("passes the platform's own board validation and publication rules", () => {
    for (const { seed } of SEEED_XIAO_OFFICIAL_BOARDS) {
      const spec = validateBoardProfileSpec(seed);
      expect(spec.errors, seed.slug).toEqual([]);
      const publication = validateBoardPublicationReady(seed);
      expect(publication.errors, seed.slug).toEqual([]);
      expect(seed.catalog_category).toBe("partner");
      expect(seed.manufacturer).toBe("Seeed Studio");
      expect(seed.firmware_status).toBe("catalog_only");
    }
  });

  it("maps every pad to the GPIO that Seeed's official pin table prints", () => {
    for (const board of SEEED_XIAO_OFFICIAL_BOARDS) {
      expect(boardPadMap(board.seed), board.seed.slug).toEqual(board.officialPinMap);
    }
    expect(bySlug("seeed-xiao-esp32c3").officialPinMap).toMatchObject({ D0: 2, D4: 6, D5: 7, D6: 21, D7: 20, D10: 10 });
    expect(bySlug("seeed-xiao-esp32c6").officialPinMap).toMatchObject({ D0: 0, D3: 21, D4: 22, D5: 23, D8: 19, D10: 18 });
    expect(bySlug("seeed-xiao-esp32c5").officialPinMap).toMatchObject({ D0: 1, D1: 0, D2: 25, D3: 7, D4: 23, D7: 12 });
    expect(bySlug("seeed-xiao-esp32s3-plus").officialPinMap).toMatchObject({ D11: 38, D16: 10, D19: 11 });
  });

  it("uses the standard XIAO footprint on every board", () => {
    for (const { seed } of SEEED_XIAO_OFFICIAL_BOARDS) {
      const layout = seed.board_layout;
      expect(layout.formFactor).toBe("xiao");
      expect(layout.leftHeader.pins.map((p) => p.pinName.split(" ")[0])).toEqual([
        "D0", "D1", "D2", "D3", "D4", "D5", "D6",
      ]);
      expect(layout.rightHeader.pins.map((p) => p.pinName.split(" ")[0])).toEqual([
        "5V", "GND", "3V3", "D10", "D9", "D8", "D7",
      ]);
      expect(layout.hardwareSpecs?.hasUartBridge).toBe(false);
    }
  });

  it("records the official memory, boot button and USB facts", () => {
    const facts = SEEED_XIAO_OFFICIAL_BOARDS.map(({ seed }) => [
      seed.slug,
      seed.chip_family,
      seed.flash_size_mb,
      seed.psram_size_mb,
      seed.boot_button_gpio,
      seed.partition_scheme,
    ]);
    expect(facts).toEqual(
      expect.arrayContaining([
        ["seeed-xiao-esp32c3", "esp32c3", 4, 0, 9, "dual_ota_4mb"],
        ["seeed-xiao-esp32c6", "esp32c6", 4, 0, 9, "dual_ota_4mb"],
        ["seeed-xiao-esp32c5", "esp32c5", 8, 8, 28, "dual_ota_8mb"],
        ["seeed-xiao-esp32s3-sense", "esp32s3", 8, 8, 0, "dual_ota_8mb"],
        ["seeed-xiao-esp32s3-plus", "esp32s3", 16, 8, 0, "dual_ota_16mb"],
      ])
    );
    for (const { seed, sources } of SEEED_XIAO_OFFICIAL_BOARDS) {
      expect(seed.docs_url).toMatch(/^https:\/\/wiki\.seeedstudio\.com\//);
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) expect(source.url).toMatch(/^https:\/\//);
    }
  });

  it("takes hardware revisions from Seeed's schematics and never guesses one", () => {
    const revisions = Object.fromEntries(
      SEEED_XIAO_OFFICIAL_BOARDS.map(({ seed }) => [seed.slug, seed.revision])
    );
    // Versions in the schematic file names on each wiki page.
    expect(revisions).toMatchObject({
      "seeed-xiao-esp32c3": "v1.3",
      "seeed-xiao-esp32c6": "v1.0",
      "seeed-xiao-esp32s3-sense": "v1.51",
      "seeed-xiao-esp32s3-plus": "v1.1",
    });
    // Seeed publishes no revision for the XIAO ESP32-C5: nothing is made up.
    expect(revisions["seeed-xiao-esp32c5"]).toBe(BOARD_REVISION_UNSPECIFIED);
    expect(displayBoardRevision(revisions["seeed-xiao-esp32c5"])).toBeNull();
    expect(displayBoardRevision("v1.3")).toBe("v1.3");
    expect(displayBoardRevision("  ")).toBeNull();
    expect(displayBoardRevision(null)).toBeNull();
    // The platform still accepts the board: the stored value is a real string.
    const c5 = bySlug("seeed-xiao-esp32c5").seed;
    expect(validateBoardProfileSpec(c5).errors).toEqual([]);
    expect(validateBoardPublicationReady(c5).errors).toEqual([]);
  });

  it("reserves the pins that serve on-board hardware", () => {
    const reserved = (slug: string) =>
      bySlug(slug)
        .seed.gpio_definitions.filter((g) => g.restrictions.reserved)
        .map((g) => g.pin);

    // XIAO ESP32-C6: RF switch power and antenna select.
    expect(reserved("seeed-xiao-esp32c6")).toEqual([3, 14]);
    // XIAO ESP32-C5: battery sense and its enable line.
    expect(reserved("seeed-xiao-esp32c5")).toEqual([6, 26]);
    // XIAO ESP32-S3 Sense: camera connector and digital microphone.
    expect(reserved("seeed-xiao-esp32s3-sense")).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 38, 39, 40, 41, 42, 47, 48,
    ]);
    // The Plus breaks the same GPIOs out as ordinary pads instead.
    expect(reserved("seeed-xiao-esp32s3-plus")).toEqual([]);
    expect(bySlug("seeed-xiao-esp32s3-plus").seed.board_layout.extraPads?.pins).toHaveLength(9);
  });

  it("marks the documented boot-strapping pads", () => {
    const strapping = (slug: string) =>
      bySlug(slug)
        .seed.gpio_definitions.filter((g) => g.restrictions.strapping_pin)
        .map((g) => g.pin);
    expect(strapping("seeed-xiao-esp32c3")).toEqual([2, 8, 9]);
    expect(strapping("seeed-xiao-esp32c5")).toEqual([7, 25, 27, 28]);
  });
});
