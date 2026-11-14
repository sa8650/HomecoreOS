import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BOARD_REVISION_UNSPECIFIED,
  SEEED_XIAO_OFFICIAL_BOARDS,
  VERIFIED_BOARD_CATALOG,
} from "@homecoreos/shared";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import {
  boardModelKey,
  parseHtmlTables,
  parseSeeedPlatformIndex,
  parseSeeedPlatformManifest,
  parseSeeedXiaoPinTables,
  type ImportCandidate,
  type ImportPreview,
  type ImportRunResult,
} from "../src/lib/official-board-import";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName}`);
  return `${cookieName}=${match[1]}`;
}

// ---------------------------------------------------------------------------
// Fixtures: the official sources, in the exact markup the live sites serve.
// The Seeed wiki ships minified HTML without the optional closing tags.
// ---------------------------------------------------------------------------

type PinRow = [pad: string, fn: string, chipPin: string];

function seeedPinTable(rows: PinRow[]): string {
  const cell = (value: string, align = "center") => `<td style=text-align:${align}>${value}`;
  const head =
    "<thead><tr><th style=text-align:center>XIAO Pin<th style=text-align:center>Function" +
    "<th style=text-align:center>Chip Pin<th style=text-align:center>Alternate Functions" +
    "<th style=text-align:left>Description";
  const body = rows
    .map(([pad, fn, chip]) => `<tr>${cell(pad)}${cell(fn)}${cell(chip)}${cell("")}${cell("GPIO", "left")}`)
    .join("");
  return `<table>${head}<tbody>${body}</table>`;
}

const POWER_ROWS: PinRow[] = [
  ["5V", "VBUS", ""],
  ["GND", "", ""],
  ["3V3", "3V3_OUT", ""],
];

const C3_ROWS: PinRow[] = [
  ...POWER_ROWS,
  ["D0", "Analog", "GPIO2"],
  ["D1", "Analog", "GPIO3"],
  ["D2", "Analog", "GPIO4"],
  ["D3", "Analog", "GPIO5"],
  ["D4", "SDA", "GPIO6"],
  ["D5", "SCL", "GPIO7"],
  ["D6", "TX", "GPIO21"],
  ["D7", "RX", "GPIO20"],
  ["D8", "SCK", "GPIO8"],
  ["D9", "MISO", "GPIO9"],
  ["D10", "MOSI", "GPIO10"],
  ["MTDO", "", "GPIO7"],
  ["Reset", "CHIP_EN", ""],
  ["Boot", "", "GPIO9"],
];

const C6_ROWS: PinRow[] = [
  ...POWER_ROWS,
  ["D0", "Analog", "GPIO0"],
  ["D1", "Analog", "GPIO1"],
  ["D2", "Analog", "GPIO2"],
  ["D3", "Digital", "GPIO21"],
  ["D4", "SDA", "GPIO22"],
  ["D5", "SCL", "GPIO23"],
  ["D6", "TX", "GPIO16"],
  ["D7", "RX", "GPIO17"],
  ["D8", "SCK", "GPIO19"],
  ["D9", "MISO", "GPIO20"],
  ["D10", "MOSI", "GPIO18"],
  ["Boot", "", "GPIO9"],
  ["RF Switch Port Select", "", "GPIO14"],
  ["Light", "", "GPIO15"],
];

const C5_ROWS: PinRow[] = [
  ...POWER_ROWS,
  ["D0", "Analog", "GPIO1"],
  ["D1", "", "GPIO0"],
  ["D2", "", "GPIO25"],
  ["D3", "", "GPIO7"],
  ["D4", "SDA", "GPIO23"],
  ["D5", "SCL", "GPIO24"],
  ["D6", "TX", "GPIO11"],
  ["D7", "RX", "GPIO12"],
  ["D8", "SCK", "GPIO8"],
  ["D9", "MISO", "GPIO9"],
  ["D10", "MOSI", "GPIO10"],
  ["ADC_BAT", "", "GPIO6"],
  ["Boot", "", "GPIO28"],
  ["USER_LED", "", "GPIO27"],
];

const S3_BASE_ROWS: PinRow[] = [
  ...POWER_ROWS,
  ["D0", "Analog", "GPIO1"],
  ["D1", "Analog", "GPIO2"],
  ["D2", "Analog", "GPIO3"],
  ["D3", "Analog", "GPIO4"],
  ["D4", "Analog, SDA", "GPIO5"],
  ["D5", "Analog, SCL", "GPIO6"],
  ["D6", "TX", "GPIO43"],
  ["D7", "RX", "GPIO44"],
  ["D8", "Analog, SCK", "GPIO7"],
  ["D9", "Analog, MISO", "GPIO8"],
  ["D10", "Analog, MOSI", "GPIO9"],
];

const S3_ROWS: PinRow[] = [
  ...S3_BASE_ROWS,
  ["D11", "Analog", "GPIO42"],
  ["D12", "Analog", "GPIO41"],
  ["Boot", "", "GPIO0"],
  ["USER_LED", "", "GPIO21"],
];

const S3_PLUS_ROWS: PinRow[] = [
  ...S3_BASE_ROWS,
  ["D11", "", "GPIO38"],
  ["D12", "", "GPIO39"],
  ["D13", "", "GPIO40"],
  ["D14", "", "GPIO41"],
  ["D15", "", "GPIO42"],
  ["D16", "", "GPIO10"],
  ["D17", "", "GPIO13"],
  ["D18", "", "GPIO12"],
  ["D19", "", "GPIO11"],
  ["Boot", "", "GPIO0"],
  ["ADC_BAT", "", "GPIO10"],
];

function imageTags(slugs: string[]): string {
  return SEEED_XIAO_OFFICIAL_BOARDS.filter((b) => slugs.includes(b.seed.slug))
    .flatMap((b) => [b.seed.image_url, b.seed.pinout_image_url])
    .filter(Boolean)
    .map((url) => `<img src="${url}">`)
    .join("");
}

function manifest(mcu: string, flash: string, hwids: string[][], name: string): string {
  return JSON.stringify({
    build: { core: "esp32", extra_flags: ["-DARDUINO_USB_MODE=1"], hwids, mcu },
    name,
    upload: { flash_size: flash, maximum_size: Number.parseInt(flash, 10) * 1024 * 1024 },
    url: "https://wiki.seeedstudio.com/",
    vendor: "Seeed Studio",
  });
}

const MANIFESTS: Record<string, string> = {
  "seeed-xiao-esp32-c3": manifest("esp32c3", "4MB", [["0x2886", "0x0046"], ["0x303a", "0x1001"]], "Seeed Studio XIAO ESP32C3"),
  "seeed-xiao-esp32-c6": manifest("esp32c6", "4MB", [["0x2886", "0x0046"], ["0x303a", "0x1001"]], "Seeed Studio XIAO ESP32C6"),
  "seeed-xiao-esp32-c5": manifest("esp32c5", "8MB", [["0x303a", "0x1001"]], "Seeed Studio XIAO ESP32C5"),
  "seeed-xiao-esp32-s3-sense": manifest("esp32s3", "8MB", [["0x2886", "0x0056"], ["0x2886", "0x8056"]], "Seeed Studio XIAO ESP32S3 Sense"),
  "seeed-xiao-esp32-s3-plus": manifest("esp32s3", "16MB", [["0x2886", "0x0056"], ["0x2886", "0x8056"]], "Seeed Studio XIAO ESP32S3 Plus"),
  // A board Seeed lists that HomecoreOS has no checked profile for.
  "seeed-xiao-esp32-h2": manifest("esp32h2", "4MB", [["0x303a", "0x1001"]], "Seeed Studio XIAO ESP32H2"),
};

const INDEX = JSON.stringify(
  [...Object.keys(MANIFESTS), "seeed-xiao-rp2040", "seeed-xiao-mbed-nrf52840"].map((name) => ({
    name: `${name}.json`,
    type: "file",
  }))
);

describe("Board Library workflows: official import, removal, pin policy, USB audit", () => {
  let dbHarness: PgliteHarness;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;
  let adminCookie = "";
  let userCookie = "";

  /** Switches the simulated state of the official sources. */
  const scenario = { offline: false, c5Conflict: false, requests: [] as string[] };

  beforeAll(async () => {
    dbHarness = await createPglitePostgrest();
    const emqxMock = createMockEmqxFetch();
    env = {
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-secret",
      EMQX_API_BASE: "https://mock.emqx.cloud:8443/api/v5",
      EMQX_APP_ID: "app-id",
      EMQX_APP_SECRET: "app-secret",
      EMQX_BROKER_HOST: "mock.emqx.cloud",
      EMQX_TLS_PORT: "8883",
      FIRMWARE_BUCKET: createMockR2Bucket(),
    };

    const html = (body: string) =>
      new Response(`<!doctype html><html><body>${body}</body></html>`, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    const json = (body: string) =>
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });

    const syncFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      scenario.requests.push(url);
      if (scenario.offline) throw new Error("network unreachable");

      if (url.includes("wiki.seeedstudio.com/XIAO_ESP32C3_Getting_Started")) {
        return html(seeedPinTable(C3_ROWS) + imageTags(["seeed-xiao-esp32c3"]));
      }
      if (url.includes("wiki.seeedstudio.com/xiao_esp32c6_getting_started")) {
        return html(seeedPinTable(C6_ROWS) + imageTags(["seeed-xiao-esp32c6"]));
      }
      if (url.includes("wiki.seeedstudio.com/xiao_esp32c5_getting_started")) {
        const rows = scenario.c5Conflict
          ? C5_ROWS.map((r): PinRow => (r[0] === "D3" ? ["D3", "", "GPIO26"] : r))
          : C5_ROWS;
        return html(seeedPinTable(rows) + imageTags(["seeed-xiao-esp32c5"]));
      }
      if (url.includes("wiki.seeedstudio.com/xiao_esp32s3_getting_started")) {
        // One page documents the S3, the Sense and the Plus. The Plus photo is
        // deliberately absent to prove that dead image links are left out.
        const plus = SEEED_XIAO_OFFICIAL_BOARDS.find((b) => b.seed.slug === "seeed-xiao-esp32s3-plus")!;
        return html(
          seeedPinTable(S3_ROWS) +
            seeedPinTable(S3_ROWS) +
            seeedPinTable(S3_PLUS_ROWS) +
            imageTags(["seeed-xiao-esp32s3-sense"]) +
            `<img src="${plus.seed.pinout_image_url}">`
        );
      }
      if (url.includes("api.github.com/repos/Seeed-Studio/platform-seeedboards")) return json(INDEX);
      const manifestMatch = url.match(/platform-seeedboards\/main\/boards\/([a-z0-9-]+)\.json/);
      if (manifestMatch) {
        const body = MANIFESTS[manifestMatch[1]!];
        return body ? json(body) : new Response("not found", { status: 404 });
      }
      if (url.includes("espressif.com/products/devkits")) {
        return html(
          `<a href="https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html">ESP32-S3-DevKitC-1</a><span>16 MB Flash</span>`
        );
      }
      return html("<ul><li>esp32_s3_devkitc_1</li></ul>");
    });

    app = createWorkerApp({
      dbFetch: dbHarness.fetch,
      emqxFetch: emqxMock.fetch,
      syncFetch: syncFetch as unknown as typeof fetch,
    });

    const adminBoot = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "library-admin@homecore.local",
        fullName: "Library Admin",
        password: "AdminStrong!99",
      }),
    });
    expect(adminBoot.status).toBe(201);
    adminCookie = extractCookie(adminBoot, "hc_admin_session");

    const reg = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "maker@homecore.local",
        password: "MakerUser!23",
        fullName: "Board Maker",
        accountName: "Maker Home",
      }),
    });
    userCookie = extractCookie(reg, "hc_user_session");
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }
  const adminJson = (path: string, body: unknown, method = "POST") =>
    req(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify(body),
    });
  const userJson = (path: string, body: unknown, method = "POST") =>
    req(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify(body),
    });

  async function preview(provider: "seeed_xiao" | "espressif"): Promise<ImportPreview> {
    const res = await adminJson("/api/admin/boards/import/preview", { provider });
    expect(res.status).toBe(200);
    return ((await res.json()) as { preview: ImportPreview }).preview;
  }
  async function importBoards(
    provider: "seeed_xiao" | "espressif",
    slugs: string[],
    publish = true
  ): Promise<ImportRunResult> {
    const res = await adminJson("/api/admin/boards/import", { provider, slugs, publish });
    expect(res.status).toBe(200);
    return ((await res.json()) as { run: ImportRunResult }).run;
  }
  const candidate = (p: ImportPreview, slug: string): ImportCandidate => {
    const found = p.candidates.find((c) => c.slug === slug);
    if (!found) throw new Error(`candidate ${slug} missing`);
    return found;
  };
  async function adminBoards() {
    const res = await req("/api/admin/boards", { headers: { Cookie: adminCookie } });
    return (
      (await res.json()) as {
        boards: Array<{
          id: string;
          slug: string;
          revision: string;
          is_available: boolean;
          verification_status: string;
          firmware_status: string;
          image_url: string | null;
          pinout_image_url: string | null;
          source_provider: string | null;
          board_layout: { extraPads?: { pins: unknown[] } } | null;
          gpio_definitions: Array<{ pin: number; board_pin_name: string | null }>;
        }>;
        syncRuns: Array<{ source_name: string; status: string; inserted_count: number }>;
      }
    );
  }
  async function catalogSlugs(): Promise<string[]> {
    const res = await req("/api/boards/catalog", { headers: { Cookie: userCookie } });
    return ((await res.json()) as { boards: Array<{ slug: string }> }).boards.map((b) => b.slug);
  }
  async function boardCount(): Promise<number> {
    const res = await dbHarness.pg.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.board_catalog"
    );
    return res.rows[0]!.n;
  }

  it("parses the official sources: minified pin tables, manifests and the board list", () => {
    const tables = parseSeeedXiaoPinTables(seeedPinTable(C6_ROWS));
    expect(tables).toHaveLength(1);
    expect(tables[0]!.pads).toEqual({
      D0: 0, D1: 1, D2: 2, D3: 21, D4: 22, D5: 23, D6: 16, D7: 17, D8: 19, D9: 20, D10: 18,
    });
    expect(tables[0]!.bootGpio).toBe(9);
    expect(tables[0]!.userLedGpio).toBe(15);

    // Fully closed markup gives the same result; unrelated tables are ignored.
    const closed =
      "<table><tr><th>Item</th><th>Value</th></tr><tr><td>Flash</td><td>4MB</td></tr></table>" +
      "<table><thead><tr><th>XIAO Pin</th><th>Function</th><th>Chip Pin</th></tr></thead>" +
      "<tbody><tr><td>D0</td><td>Analog</td><td>GPIO2</td></tr>" +
      "<tr><td>D1</td><td>Analog</td><td> GPIO3 </td></tr>" +
      "<tr><td>GND</td><td></td><td></td></tr></tbody></table>";
    expect(parseHtmlTables(closed)).toHaveLength(2);
    expect(parseSeeedXiaoPinTables(closed).map((t) => t.pads)).toEqual([{ D0: 2, D1: 3 }]);
    expect(parseSeeedXiaoPinTables("<p>no tables here</p>")).toEqual([]);

    expect(parseSeeedPlatformManifest(MANIFESTS["seeed-xiao-esp32-s3-plus"]!)).toMatchObject({
      mcu: "esp32s3",
      flashSizeMb: 16,
      hwids: [
        [0x2886, 0x0056],
        [0x2886, 0x8056],
      ],
    });
    expect(parseSeeedPlatformManifest("<html>rate limited</html>")).toBeNull();
    expect(parseSeeedPlatformIndex(INDEX)).toContain("seeed-xiao-rp2040");
    expect(parseSeeedPlatformIndex('{"message":"API rate limit exceeded"}')).toBeNull();

    expect(boardModelKey("Seeed Studio", "XIAO ESP32-C3")).toBe("xiaoesp32c3");
    expect(boardModelKey("Seeed", "Seeed Studio XIAO ESP32C3")).toBe("xiaoesp32c3");
  });

  it("previews Seeed Studio XIAO boards from the official sources without writing anything", async () => {
    const before = await boardCount();
    scenario.requests.length = 0;
    const p = await preview("seeed_xiao");

    expect(await boardCount()).toBe(before);
    expect(p.providerLabel).toBe("Seeed Studio XIAO");
    expect(p.liveSourcesReached).toBeGreaterThanOrEqual(9);
    // The official sources were really requested.
    expect(scenario.requests.some((u) => u.includes("wiki.seeedstudio.com/xiao_esp32c6_getting_started"))).toBe(true);
    expect(scenario.requests.some((u) => u.includes("api.github.com/repos/Seeed-Studio/platform-seeedboards"))).toBe(true);

    // The XIAO ESP32-S3 already ships in the library: no duplicate is offered.
    expect(candidate(p, "seeed-xiao-esp32s3")).toMatchObject({ status: "in_library", selectable: false });

    for (const slug of [
      "seeed-xiao-esp32c3",
      "seeed-xiao-esp32c6",
      "seeed-xiao-esp32c5",
      "seeed-xiao-esp32s3-sense",
      "seeed-xiao-esp32s3-plus",
    ]) {
      const c = candidate(p, slug);
      expect(c, slug).toMatchObject({ status: "new", selectable: true, verification: "verified" });
      expect(c.checks.find((k) => k.key === "pin_table")?.status, slug).toBe("confirmed");
      expect(c.checks.find((k) => k.key === "manifest")?.status, slug).toBe("confirmed");
      // The preview carries the complete profile: specification, layout and pinout.
      expect(c.board?.gpio_definitions.length, slug).toBeGreaterThanOrEqual(11);
      expect(c.board?.board_layout, slug).toBeTruthy();
      expect(c.sources.length, slug).toBeGreaterThan(0);
    }
    const c6 = candidate(p, "seeed-xiao-esp32c6");
    expect(c6.board).toMatchObject({ chip_family: "esp32c6", flash_size_mb: 4, boot_button_gpio: 9 });
    expect(c6.board?.image_url).toMatch(/files\.seeedstudio\.com/);

    // An image link that is no longer on the official page is left out.
    const plus = candidate(p, "seeed-xiao-esp32s3-plus");
    expect(plus.board?.image_url).toBeNull();
    expect(plus.board?.pinout_image_url).toMatch(/Plus_front_pinout/);
    expect(plus.checks.find((k) => k.key === "images")?.status).toBe("not_available");

    // A listed ESP32 board without a checked profile: importable, but never with invented pins.
    const h2 = candidate(p, "seeed-xiao-esp32h2");
    expect(h2).toMatchObject({ status: "new", selectable: true, verification: "needs_verification" });
    expect(h2.board?.gpio_definitions).toEqual([]);

    // Non-ESP32 XIAO boards are listed as unsupported and cannot be selected.
    expect(candidate(p, "seeed-xiao-rp2040")).toMatchObject({ status: "unsupported", selectable: false });
    expect(candidate(p, "seeed-xiao-rp2040").statusDetail).toMatch(/ESP32 chips only/);
  });

  it("imports only the selected boards, with their verified pin maps", async () => {
    const before = await boardCount();
    const run = await importBoards("seeed_xiao", ["seeed-xiao-esp32c3", "seeed-xiao-esp32s3-plus"]);

    expect(run).toMatchObject({ importedCount: 2, restoredCount: 0, skippedCount: 0, status: "succeeded" });
    // What was read from the sources is reported on its own, and with the counts for the history.
    expect(run.sourceNotes.length).toBeGreaterThan(0);
    expect(run.sourceNotes.join(" ")).toMatch(/Seeed Studio wiki: \d+ of \d+ pages read/);
    expect(run.sourceNotes.join(" ")).not.toMatch(/Import:/);
    expect(run.summaryNotes).toBe(
      [...run.sourceNotes, "Import: 2 added, 0 restored, 0 skipped of 2 selected."].join(" · ")
    );
    expect(run.outcomes.map((o) => [o.slug, o.action, o.published, o.verification])).toEqual([
      ["seeed-xiao-esp32c3", "imported", true, "verified"],
      ["seeed-xiao-esp32s3-plus", "imported", true, "verified"],
    ]);
    expect(await boardCount()).toBe(before + 2);

    const { boards, syncRuns } = await adminBoards();
    const c3 = boards.find((b) => b.slug === "seeed-xiao-esp32c3")!;
    const plus = boards.find((b) => b.slug === "seeed-xiao-esp32s3-plus")!;
    const refC3 = SEEED_XIAO_OFFICIAL_BOARDS.find((b) => b.seed.slug === "seeed-xiao-esp32c3")!.seed;
    const refPlus = SEEED_XIAO_OFFICIAL_BOARDS.find((b) => b.seed.slug === "seeed-xiao-esp32s3-plus")!.seed;

    expect(c3).toMatchObject({ verification_status: "verified", is_available: true, firmware_status: "catalog_only" });
    // The revision is the one in Seeed's schematic, stored as published.
    expect(c3.revision).toBe(refC3.revision);
    expect(plus.revision).toBe(refPlus.revision);
    expect(c3.gpio_definitions.map((g) => g.pin)).toEqual(refC3.gpio_definitions.map((g) => g.pin));
    expect(c3.image_url).toBe(refC3.image_url);
    expect(plus.gpio_definitions).toHaveLength(refPlus.gpio_definitions.length);
    expect(plus.gpio_definitions.find((g) => g.pin === 38)?.board_pin_name).toBe("D11");
    expect(plus.board_layout?.extraPads?.pins).toHaveLength(9);
    expect(plus.image_url).toBeNull();

    // Boards that were not selected are not added.
    expect(boards.some((b) => b.slug === "seeed-xiao-esp32c6")).toBe(false);
    expect(boards.some((b) => b.slug === "seeed-xiao-esp32s3-sense")).toBe(false);

    // Users see the published boards in the existing Board Library.
    const slugs = await catalogSlugs();
    expect(slugs).toContain("seeed-xiao-esp32c3");
    expect(slugs).toContain("seeed-xiao-esp32s3-plus");

    expect(syncRuns[0]).toMatchObject({ source_name: "Seeed Studio XIAO (official import)", inserted_count: 2 });
    const audit = await dbHarness.pg.query<{ summary: string }>(
      "SELECT summary FROM public.activity_logs WHERE action = 'admin.boards_imported'"
    );
    expect(audit.rows[0]!.summary).toMatch(/2 added, 0 restored, 0 skipped/);
  });

  it("prevents duplicate imports and preserves existing board configurations", async () => {
    const { boards } = await adminBoards();
    const c3 = boards.find((b) => b.slug === "seeed-xiao-esp32c3")!;

    // The admin customises the imported board.
    const patch = await adminJson(
      `/api/admin/boards/${c3.id}`,
      { firmware_status: "build_pending", is_available: false },
      "PATCH"
    );
    expect(patch.status).toBe(200);

    const before = await boardCount();
    const p = await preview("seeed_xiao");
    expect(candidate(p, "seeed-xiao-esp32c3")).toMatchObject({ status: "in_library", selectable: false });

    // Even a request that names existing boards changes nothing.
    const run = await importBoards("seeed_xiao", [
      "seeed-xiao-esp32c3",
      "seeed-xiao-esp32s3",
      "seeed-xiao-esp32c3",
      "not-a-real-board",
    ]);
    expect(run).toMatchObject({ requestedCount: 3, importedCount: 0, restoredCount: 0, skippedCount: 3 });
    expect(run.outcomes.find((o) => o.slug === "seeed-xiao-esp32c3")?.detail).toMatch(/Already in the Board Library/);
    expect(run.outcomes.find((o) => o.slug === "not-a-real-board")?.detail).toMatch(/Not offered/);
    expect(await boardCount()).toBe(before);

    const after = (await adminBoards()).boards.find((b) => b.slug === "seeed-xiao-esp32c3")!;
    expect(after).toMatchObject({ id: c3.id, firmware_status: "build_pending", is_available: false });
    expect(after.gpio_definitions).toHaveLength(c3.gpio_definitions.length);

    // The verified XIAO ESP32-S3 that shipped with the platform is untouched too.
    const s3 = (await adminBoards()).boards.find((b) => b.slug === "seeed-xiao-esp32s3")!;
    expect(s3.gpio_definitions).toHaveLength(
      VERIFIED_BOARD_CATALOG.find((b) => b.slug === "seeed-xiao-esp32s3")!.gpio_definitions.length
    );
  });

  it("recognises a board that was added by hand under another slug", async () => {
    await dbHarness.pg.query(
      `INSERT INTO public.board_catalog (slug, manufacturer, model, chip_family, chip_variant, flash_size_mb, psram_size_mb)
       VALUES ('xiao-c6-manual', 'Seeed', 'Seeed Studio XIAO ESP32C6', 'esp32c6', 'ESP32-C6', 4, 0)`
    );
    const p = await preview("seeed_xiao");
    const c6 = candidate(p, "seeed-xiao-esp32c6");
    expect(c6).toMatchObject({ status: "in_library", selectable: false });
    expect(c6.statusDetail).toMatch(/xiao-c6-manual/);

    const run = await importBoards("seeed_xiao", ["seeed-xiao-esp32c6"]);
    expect(run).toMatchObject({ importedCount: 0, skippedCount: 1 });
    expect((await adminBoards()).boards.some((b) => b.slug === "seeed-xiao-esp32c6")).toBe(false);
  });

  it("holds a board back when the official source disagrees with the built-in profile", async () => {
    scenario.c5Conflict = true;
    try {
      const p = await preview("seeed_xiao");
      const c5 = candidate(p, "seeed-xiao-esp32c5");
      expect(c5).toMatchObject({ status: "new", selectable: true, verification: "needs_verification" });
      const pinCheck = c5.checks.find((k) => k.key === "pin_table")!;
      expect(pinCheck.status).toBe("conflict");
      expect(pinCheck.detail).toMatch(/D3: profile GPIO7, page GPIO26/);

      // Asking to publish does not publish an unconfirmed pin map.
      const run = await importBoards("seeed_xiao", ["seeed-xiao-esp32c5"], true);
      expect(run.outcomes[0]).toMatchObject({ action: "imported", published: false, verification: "needs_verification" });
      expect(run.needsVerificationCount).toBe(1);
    } finally {
      scenario.c5Conflict = false;
    }

    const c5 = (await adminBoards()).boards.find((b) => b.slug === "seeed-xiao-esp32c5")!;
    expect(c5).toMatchObject({ verification_status: "needs_verification", is_available: false });
    // The pin map is kept so an admin can review it.
    expect(c5.gpio_definitions.length).toBeGreaterThan(0);
    expect(await catalogSlugs()).not.toContain("seeed-xiao-esp32c5");

    const publish = await adminJson(`/api/admin/boards/${c5.id}`, { is_available: true }, "PATCH");
    expect(publish.status).toBe(400);
  });

  it("imports a listed board without a checked profile hidden and without pins", async () => {
    const run = await importBoards("seeed_xiao", ["seeed-xiao-esp32h2"]);
    expect(run.outcomes[0]).toMatchObject({ action: "imported", published: false, verification: "needs_verification" });
    const h2 = (await adminBoards()).boards.find((b) => b.slug === "seeed-xiao-esp32h2")!;
    expect(h2).toMatchObject({ verification_status: "needs_verification", is_available: false });
    expect(h2.gpio_definitions).toEqual([]);
    // The manifest states no hardware revision, and none is made up.
    expect(h2.revision).toBe(BOARD_REVISION_UNSPECIFIED);
    expect(await catalogSlugs()).not.toContain("seeed-xiao-esp32h2");
  });

  it("still works from the built-in profiles when the official sources are unreachable", async () => {
    scenario.offline = true;
    try {
      const p = await preview("seeed_xiao");
      expect(p.liveSourcesReached).toBe(0);
      const sense = candidate(p, "seeed-xiao-esp32s3-sense");
      expect(sense).toMatchObject({ status: "new", selectable: true, verification: "verified" });
      expect(sense.checks.find((k) => k.key === "pin_table")?.status).toBe("unreachable");
      expect(sense.verificationNote).toMatch(/could not be read/);
      // Without the board list, nothing unknown is offered.
      expect(p.candidates.some((c) => c.status === "unsupported")).toBe(false);

      const run = await importBoards("seeed_xiao", ["seeed-xiao-esp32s3-sense"], false);
      expect(run.status).toBe("partial");
      expect(run.outcomes[0]).toMatchObject({ action: "imported", published: false, verification: "verified" });
    } finally {
      scenario.offline = false;
    }
    const sense = (await adminBoards()).boards.find((b) => b.slug === "seeed-xiao-esp32s3-sense")!;
    expect(sense).toMatchObject({ verification_status: "verified", is_available: false });
    // Camera and microphone pins arrive reserved.
    expect(sense.gpio_definitions.map((g) => g.pin)).toEqual(expect.arrayContaining([10, 41, 42, 48]));
  });

  it("offers the Espressif source through the same preview and selection", async () => {
    const p = await preview("espressif");
    expect(p.providerLabel).toBe("Espressif DevKits");
    expect(candidate(p, "esp32-s3-devkitc-1-n16r8")).toMatchObject({ status: "in_library", selectable: false });
    const devkitm = candidate(p, "esp32-s3-devkitm-1");
    expect(devkitm).toMatchObject({ status: "new", selectable: true, verification: "needs_verification" });
    // Seeed boards are not offered by the Espressif source.
    expect(p.candidates.some((c) => c.slug.startsWith("seeed-"))).toBe(false);

    const before = await boardCount();
    const run = await importBoards("espressif", ["esp32-s3-devkitm-1", "esp32-s3-devkitc-1-n16r8"]);
    expect(run).toMatchObject({ importedCount: 1, skippedCount: 1 });
    expect(await boardCount()).toBe(before + 1);
    const added = (await adminBoards()).boards.find((b) => b.slug === "esp32-s3-devkitm-1")!;
    expect(added).toMatchObject({ verification_status: "needs_verification", is_available: false });
  });

  it("rejects malformed import requests", async () => {
    expect((await adminJson("/api/admin/boards/import/preview", { provider: "arduino" })).status).toBe(400);
    expect((await adminJson("/api/admin/boards/import", { provider: "seeed_xiao", slugs: [] })).status).toBe(400);
    // The import API is for platform admins only.
    expect((await userJson("/api/admin/boards/import/preview", { provider: "seeed_xiao" })).status).toBe(401);
  });

  let s3ControllerId = "";
  let c3ControllerId = "";

  it("refuses to remove a board that controllers run on, and removes an unused one", async () => {
    const { boards } = await adminBoards();
    const s3 = boards.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;
    const plus = boards.find((b) => b.slug === "seeed-xiao-esp32s3-plus")!;

    const ctrl = await userJson("/api/controllers", { name: "Hall Hub", boardCatalogId: s3.id });
    expect(ctrl.status).toBe(201);
    s3ControllerId = ((await ctrl.json()) as { controller: { id: string } }).controller.id;
    // A user also bookmarks the XIAO Plus.
    expect((await req(`/api/boards/my-boards/${plus.id}`, { method: "POST", headers: { Cookie: userCookie } })).status).toBeLessThan(300);

    // In use: blocked, with the reason.
    const usageRes = await req(`/api/admin/boards/${s3.id}/usage`, { headers: { Cookie: adminCookie } });
    const usage = ((await usageRes.json()) as { usage: { controllerCount: number; canRemove: boolean; blockers: string[] } }).usage;
    expect(usage).toMatchObject({ controllerCount: 1, canRemove: false });
    expect(usage.blockers[0]).toMatch(/1 controller runs on this board/);
    const blocked = await req(`/api/admin/boards/${s3.id}`, { method: "DELETE", headers: { Cookie: adminCookie } });
    expect(blocked.status).toBe(409);
    expect((await adminBoards()).boards.some((b) => b.id === s3.id)).toBe(true);

    // Unused: the confirmation shows what else is affected, then it is removed.
    const plusUsage = (
      (await (await req(`/api/admin/boards/${plus.id}/usage`, { headers: { Cookie: adminCookie } })).json()) as {
        usage: { canRemove: boolean; savedByAccountCount: number; consequences: string[] };
      }
    ).usage;
    expect(plusUsage).toMatchObject({ canRemove: true, savedByAccountCount: 1 });
    expect(plusUsage.consequences.join(" ")).toMatch(/1 account has it in My Boards/);

    const removed = await req(`/api/admin/boards/${plus.id}`, { method: "DELETE", headers: { Cookie: adminCookie } });
    expect(removed.status).toBe(200);
    expect((await adminBoards()).boards.some((b) => b.id === plus.id)).toBe(false);
    expect(await catalogSlugs()).not.toContain("seeed-xiao-esp32s3-plus");
    const mine = (await (await req("/api/boards/my-boards", { headers: { Cookie: userCookie } })).json()) as {
      catalogBoards: Array<{ slug: string }>;
    };
    expect(mine.catalogBoards.some((b) => b.slug === "seeed-xiao-esp32s3-plus")).toBe(false);

    // Removing it twice, or removing an unknown board, is a clean 404.
    expect((await req(`/api/admin/boards/${plus.id}`, { method: "DELETE", headers: { Cookie: adminCookie } })).status).toBe(404);
    expect(
      (await req("/api/admin/boards/00000000-0000-4000-8000-000000000000", { method: "DELETE", headers: { Cookie: adminCookie } })).status
    ).toBe(404);

    const audit = await dbHarness.pg.query<{ summary: string }>(
      "SELECT summary FROM public.activity_logs WHERE action = 'admin.board_removed'"
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.summary).toMatch(/Seeed Studio XIAO ESP32-S3 Plus/);
  });

  it("keeps a removed board removed across catalog syncs and restores it on request", async () => {
    // Also remove one of the platform's own verified boards.
    const h2 = (await adminBoards()).boards.find((b) => b.slug === "esp32-h2-devkitm-1")!;
    await adminJson(`/api/admin/boards/${h2.id}`, { firmware_status: "build_pending" }, "PATCH");
    expect((await req(`/api/admin/boards/${h2.id}`, { method: "DELETE", headers: { Cookie: adminCookie } })).status).toBe(200);

    // The one-click Espressif sync neither fails nor brings it back.
    const sync = await req("/api/admin/boards/sync", { method: "POST", headers: { Cookie: adminCookie } });
    expect(sync.status).toBe(200);
    const syncBody = (await sync.json()) as { run: { status: string; summaryNotes: string } };
    expect(syncBody.run.status).toBe("succeeded");
    expect(syncBody.run.summaryNotes).toMatch(/removed by an admin were left out/);
    let boards = (await adminBoards()).boards;
    expect(boards.some((b) => b.slug === "esp32-h2-devkitm-1")).toBe(false);
    expect(boards.some((b) => b.slug === "seeed-xiao-esp32s3-plus")).toBe(false);

    // The import preview offers both as restorable.
    expect(candidate(await preview("espressif"), "esp32-h2-devkitm-1")).toMatchObject({ status: "removed", selectable: true });
    expect(candidate(await preview("seeed_xiao"), "seeed-xiao-esp32s3-plus")).toMatchObject({ status: "removed", selectable: true });

    const run = await importBoards("espressif", ["esp32-h2-devkitm-1"]);
    expect(run).toMatchObject({ importedCount: 0, restoredCount: 1 });
    boards = (await adminBoards()).boards;
    const restored = boards.find((b) => b.slug === "esp32-h2-devkitm-1")!;
    // Same record, same configuration, same pins.
    expect(restored).toMatchObject({ id: h2.id, firmware_status: "build_pending", is_available: true });
    expect(restored.gpio_definitions).toHaveLength(h2.gpio_definitions.length);
  });

  it("enforces the pin selector's policy on the server for new assignments", async () => {
    const device = (gpioPin: number, name: string, controllerId = s3ControllerId, deviceType = "relay") =>
      userJson("/api/devices", { controllerId, name, deviceType, gpioPin });

    // Restricted pins: boot strapping and USB / JTAG.
    const strapping = await device(0, "On Strapping");
    expect(strapping.status).toBe(400);
    expect(((await strapping.json()) as { error: string }).error).toMatch(/GPIO 0 is a boot-strapping pin/);
    const usb = await device(19, "On USB");
    expect(usb.status).toBe(400);
    expect(((await usb.json()) as { error: string }).error).toMatch(/USB \/ JTAG/);

    // Dangerous pins keep their existing message.
    const psram = await device(35, "On PSRAM");
    expect(psram.status).toBe(400);
    expect(((await psram.json()) as { error: string }).error).toMatch(/reserved|Flash\/PSRAM/i);

    // An available pin works; using it twice is a conflict.
    expect((await device(5, "Porch Light")).status).toBe(201);
    const conflict = await userJson("/api/switches", { controllerId: s3ControllerId, name: "Twin", gpioPin: 5 });
    expect(conflict.status).toBe(400);
    expect(((await conflict.json()) as { error: string }).error).toMatch(/GPIO 5 is already assigned/);

    // A sensor type that needs ADC cannot sit on a pin without it.
    const analog = await userJson("/api/sensors", {
      controllerId: s3ControllerId,
      name: "Soil",
      sensorType: "analog_voltage",
      gpioPin: 21,
      unit: "V",
    });
    expect(analog.status).toBe(400);
    expect(((await analog.json()) as { error: string }).error).toMatch(/does not support adc/);

    // The same rules apply to an imported XIAO board.
    const c3 = (await adminBoards()).boards.find((b) => b.slug === "seeed-xiao-esp32c3")!;
    await adminJson(`/api/admin/boards/${c3.id}`, { is_available: true }, "PATCH");
    const ctrl = await userJson("/api/controllers", { name: "XIAO C3 Node", boardCatalogId: c3.id });
    expect(ctrl.status).toBe(201);
    c3ControllerId = ((await ctrl.json()) as { controller: { id: string } }).controller.id;
    const boot = await device(9, "On Boot Button", c3ControllerId);
    expect(boot.status).toBe(400);
    expect(((await boot.json()) as { error: string }).error).toMatch(/boot-strapping pin/);
    const missing = await device(40, "Off Board", c3ControllerId);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toMatch(/does not exist/);
    expect((await device(5, "Desk Lamp", c3ControllerId)).status).toBe(201);
  });

  it("keeps existing assignments on restricted pins working", async () => {
    const created = await userJson("/api/devices", {
      controllerId: s3ControllerId,
      name: "Old Relay",
      deviceType: "relay",
      gpioPin: 8,
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { device: { id: string } }).device.id;
    // An assignment made before the policy existed.
    await dbHarness.pg.query("UPDATE public.devices SET gpio_pin = 0 WHERE id = $1", [id]);

    // The edit dialog always sends the controller and the pin; nothing changed, so it saves.
    const rename = await userJson(
      `/api/devices/${id}`,
      { name: "Old Relay (renamed)", controllerId: s3ControllerId, gpioPin: 0 },
      "PATCH"
    );
    expect(rename.status).toBe(200);

    // Moving it to another restricted pin is refused; moving it to a free pin works.
    const toStrapping = await userJson(`/api/devices/${id}`, { gpioPin: 3 }, "PATCH");
    expect(toStrapping.status).toBe(400);
    expect(((await toStrapping.json()) as { error: string }).error).toMatch(/boot-strapping pin/);
    expect((await userJson(`/api/devices/${id}`, { gpioPin: 9 }, "PATCH")).status).toBe(200);
    // Once it left the restricted pin it cannot go back.
    expect((await userJson(`/api/devices/${id}`, { gpioPin: 0 }, "PATCH")).status).toBe(400);
  });

  it("records a forced USB flash in the audit trail", async () => {
    const releaseId = "11111111-1111-4111-8111-111111111111";
    const forced = await userJson("/api/firmware/usb-flash-events", {
      releaseId,
      status: "succeeded",
      chipDetected: "ESP32-S3 (QFN56)",
      detectedFlashSizeMb: 8,
      reportedBoardSlug: "esp32-s3-devkitc-1-n16r8",
      boardCheck: {
        result: "mismatch",
        forced: true,
        severity: "major",
        detectedSummary: "ESP32-S3 · 8 MB flash · 8 MB PSRAM",
        selectedBoardSlug: "esp32-s3-devkitc-1-n16r8",
        recommendedBoardSlugs: ["seeed-xiao-esp32s3"],
        mismatches: ["flash_smaller"],
      },
    });
    expect(forced.status).toBe(200);

    // Events from older clients, without the board check, are still accepted.
    const legacy = await userJson("/api/firmware/usb-flash-events", {
      releaseId,
      status: "failed",
      chipDetected: "ESP32-C3",
      errorMessage: "Chip mismatch",
    });
    expect(legacy.status).toBe(200);

    const logs = await dbHarness.pg.query<{ action: string; summary: string; metadata: { boardCheck?: { forced: boolean; mismatches: string[] } } }>(
      "SELECT action, summary, metadata FROM public.activity_logs WHERE action LIKE 'firmware.usb_flash_%' ORDER BY created_at"
    );
    expect(logs.rows).toHaveLength(2);
    expect(logs.rows[0]!.action).toBe("firmware.usb_flash_succeeded");
    expect(logs.rows[0]!.summary).toMatch(/forced by the user after a board mismatch warning/);
    expect(logs.rows[0]!.metadata.boardCheck).toMatchObject({ forced: true, mismatches: ["flash_smaller"] });
    expect(logs.rows[1]!.summary).not.toMatch(/forced/);
    expect(logs.rows[1]!.metadata.boardCheck).toBeUndefined();

    // A forced flag is ignored unless the check really reported a mismatch.
    const notForced = await userJson("/api/firmware/usb-flash-events", {
      releaseId,
      status: "succeeded",
      boardCheck: { result: "match", forced: true },
    });
    expect(notForced.status).toBe(200);
    const last = await dbHarness.pg.query<{ summary: string }>(
      "SELECT summary FROM public.activity_logs WHERE action = 'firmware.usb_flash_succeeded' ORDER BY created_at DESC LIMIT 1"
    );
    expect(last.rows[0]!.summary).not.toMatch(/forced/);
  });

  it("records a flash that stopped on a board mismatch as a stop, not as a failed flash", async () => {
    const releaseId = "22222222-2222-4222-8222-222222222222";
    const mismatch = {
      result: "mismatch",
      severity: "major",
      detectedSummary: "ESP32-S3 · 8 MB flash · no PSRAM",
      selectedBoardSlug: "esp32-s3-devkitc-1-n16r8",
      recommendedBoardSlugs: ["esp32-s3-devkitc-1-v1-0"],
      mismatches: ["flash_smaller", "psram_smaller"],
    };
    const notifications = async () =>
      (
        await dbHarness.pg.query<{ severity: string; title: string; message: string; metadata: Record<string, unknown> }>(
          "SELECT severity, title, message, metadata FROM public.notifications WHERE event_key = 'firmware.install_result' ORDER BY created_at DESC LIMIT 1"
        )
      ).rows[0]!;
    const controllerSlug = async () =>
      (
        await dbHarness.pg.query<{ reported_board_slug: string | null; firmware_version: string | null }>(
          "SELECT reported_board_slug, firmware_version FROM public.controllers WHERE id = $1",
          [s3ControllerId]
        )
      ).rows[0]!;

    // The user cancelled at the warning: nothing was written.
    const stopped = await userJson("/api/firmware/usb-flash-events", {
      releaseId,
      controllerId: s3ControllerId,
      status: "failed",
      chipDetected: "ESP32-S3 (QFN56)",
      detectedFlashSizeMb: 8,
      errorMessage: "Flashing stopped before anything was written. Flash size mismatch.",
      boardCheck: { ...mismatch, forced: false },
    });
    expect(stopped.status).toBe(200);
    const stopLog = await dbHarness.pg.query<{ action: string; summary: string; metadata: { boardCheck?: { forced: boolean } } }>(
      "SELECT action, summary, metadata FROM public.activity_logs WHERE action LIKE 'firmware.usb_flash_%' ORDER BY created_at DESC LIMIT 1"
    );
    expect(stopLog.rows[0]!.action).toBe("firmware.usb_flash_failed");
    expect(stopLog.rows[0]!.summary).toMatch(/stopped before writing/);
    expect(stopLog.rows[0]!.summary).toMatch(/did not match the selected board/);
    expect(stopLog.rows[0]!.metadata.boardCheck).toMatchObject({ forced: false });
    const stopNote = await notifications();
    expect(stopNote).toMatchObject({ severity: "warning", title: "USB Flash Stopped (usb-factory)" });
    expect(stopNote.message).toMatch(/Nothing was written to the controller/);
    expect(stopNote.message).toMatch(/8 MB flash/);
    expect(stopNote.metadata).toMatchObject({ stoppedOnBoardMismatch: true, forced: false });
    // A stopped flash changes nothing about the controller.
    const untouched = await controllerSlug();
    expect(untouched.firmware_version).not.toBe("usb-factory");

    // A flash that broke for another reason is still a failure.
    const broken = await userJson("/api/firmware/usb-flash-events", {
      releaseId,
      status: "failed",
      chipDetected: "ESP32-S3 (QFN56)",
      errorMessage: "Flash MD5 verification mismatch!",
      boardCheck: { result: "match", forced: false, severity: "none" },
    });
    expect(broken.status).toBe(200);
    expect(await notifications()).toMatchObject({ severity: "danger", title: "USB Flash Failed (usb-factory)" });

    // A forced flash is written, flagged, and never recorded as the selected board:
    // the check proved the connected board is a different one.
    const before = (await controllerSlug()).reported_board_slug;
    // Guards the assertion below: it only means something if the value would change.
    expect(before).not.toBe("esp32-s3-devkitc-1-n16r8");
    const forced = await userJson("/api/firmware/usb-flash-events", {
      releaseId,
      controllerId: s3ControllerId,
      status: "succeeded",
      chipDetected: "ESP32-S3 (QFN56)",
      detectedFlashSizeMb: 8,
      reportedBoardSlug: "esp32-s3-devkitc-1-n16r8",
      boardCheck: { ...mismatch, forced: true },
    });
    expect(forced.status).toBe(200);
    const after = await controllerSlug();
    expect(after.firmware_version).toBe("usb-factory");
    expect(after.reported_board_slug).toBe(before);
    const forcedNote = await notifications();
    expect(forcedNote).toMatchObject({ severity: "warning", title: "USB Flash Complete (usb-factory)" });
    expect(forcedNote.message).toMatch(/did not match the selected board and the flash was forced/);

    // A normal flash of the matching board still stores what it flashed.
    const matched = await userJson("/api/firmware/usb-flash-events", {
      releaseId,
      controllerId: s3ControllerId,
      status: "succeeded",
      chipDetected: "ESP32-S3 (QFN56)",
      detectedFlashSizeMb: 16,
      reportedBoardSlug: "esp32-s3-devkitc-1-n16r8",
      boardCheck: { result: "match", forced: false, severity: "none" },
    });
    expect(matched.status).toBe(200);
    expect((await controllerSlug()).reported_board_slug).toBe("esp32-s3-devkitc-1-n16r8");
    expect(await notifications()).toMatchObject({ severity: "success" });
  });
});
