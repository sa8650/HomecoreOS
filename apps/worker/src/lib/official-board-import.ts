/**
 * Official board import: preview first, then add only what the admin selected.
 *
 * Two providers share one flow:
 *
 *  - "seeed_xiao"  Seeed Studio XIAO boards. The reference profiles in
 *                  @homecoreos/shared are re-checked against Seeed's live
 *                  sources (wiki pin table, PlatformIO board manifest, image
 *                  links) every time a preview or an import runs.
 *  - "espressif"   The boards the existing Espressif catalog sync knows: the
 *                  verified catalog plus discovered DevKits without pin maps.
 *
 * Rules that hold for both:
 *  - nothing is written by a preview;
 *  - an import re-derives every candidate on the server, so pin data never
 *    comes from the browser;
 *  - a board that is already in the library is skipped and left untouched;
 *  - a board an admin removed earlier is restored exactly as it was;
 *  - a pin map is never invented: a board without a checked pin map is added
 *    hidden, as "needs verification".
 */
import {
  BOARD_REVISION_UNSPECIFIED,
  SEEED_PLATFORM_BOARDS_INDEX_URL,
  SEEED_PLATFORM_REPO_URL,
  SEEED_XIAO_OFFICIAL_BOARDS,
  SEEED_XIAO_SOURCE_PROVIDER,
  VERIFIED_BOARD_CATALOG,
  canonicalChipFamily,
  chipFamilyLabel,
  normalizeChipFamily,
  parseFlashSizeMb,
  parseUsbHexId,
  resolveBoardFirmwareCompatibility,
  seeedPlatformManifestUrl,
  validateBoardPublicationReady,
  type CatalogBoardSeed,
  type OfficialBoardSourceRef,
  type SeeedXiaoOfficialBoard,
} from "@homecoreos/shared";
import type { CustomFetch, DbClient } from "./db";
import {
  ESPRESSIF_DEVKITS_URL,
  ESP_BOARD_MANAGER_INDEX_URL,
  buildGpioDefinitionRows,
  buildUnverifiedCatalogRow,
  buildVerifiedCatalogRow,
  collectUnverifiedEspressifDevkits,
  fetchEspressifLiveSources,
  fetchOfficialSource,
  type DiscoveredDevKitEntry,
} from "./espressif-catalog-sync";

export const OFFICIAL_IMPORT_PROVIDERS = ["seeed_xiao", "espressif"] as const;
export type OfficialImportProvider = (typeof OFFICIAL_IMPORT_PROVIDERS)[number];

export const OFFICIAL_IMPORT_PROVIDER_LABELS: Record<OfficialImportProvider, string> = {
  seeed_xiao: "Seeed Studio XIAO",
  espressif: "Espressif DevKits",
};

export type ImportCandidateStatus = "new" | "in_library" | "removed" | "unsupported";

export type ImportCheckStatus =
  | "confirmed"
  | "conflict"
  | "unreachable"
  | "not_available"
  | "reference";

export interface ImportSourceCheck {
  key: "pin_table" | "manifest" | "images" | "listing";
  label: string;
  status: ImportCheckStatus;
  detail: string;
  url?: string;
}

/** A board profile in the shape the admin console renders (pinout included). */
export type ImportBoardProfile = Record<string, unknown> & {
  id: string;
  slug: string;
  manufacturer: string;
  model: string;
  gpio_definitions: unknown[];
};

export interface ImportCandidate {
  slug: string;
  provider: OfficialImportProvider;
  name: string;
  status: ImportCandidateStatus;
  statusDetail: string;
  /** Whether an import request may include this board. */
  selectable: boolean;
  /** How the board enters the library: checked profile, or held back for review. */
  verification: "verified" | "needs_verification";
  verificationNote: string;
  existingBoardId: string | null;
  board: ImportBoardProfile | null;
  highlights: string[];
  sources: OfficialBoardSourceRef[];
  checks: ImportSourceCheck[];
}

export interface ImportPreview {
  provider: OfficialImportProvider;
  providerLabel: string;
  fetchedAt: string;
  /** How many official sources answered. 0 means the preview is offline. */
  liveSourcesReached: number;
  sourceUrls: string[];
  notes: string[];
  candidates: ImportCandidate[];
}

// ---------------------------------------------------------------------------
// HTML and manifest parsing
// ---------------------------------------------------------------------------

function cleanCell(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reads every HTML table as rows of plain-text cells. Works on minified HTML
 * that omits the optional closing tags (which is what the Seeed wiki serves)
 * as well as on fully closed markup.
 */
export function parseHtmlTables(html: string): string[][][] {
  const tables: string[][][] = [];
  const tableRegex = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let match: RegExpExecArray | null;
  while ((match = tableRegex.exec(html)) !== null) {
    const rows: string[][] = [];
    for (const rowChunk of match[1]!.split(/<tr\b[^>]*>/i).slice(1)) {
      const cells = rowChunk
        .split(/<t[dh]\b[^>]*>/i)
        .slice(1)
        .map(cleanCell);
      if (cells.length > 0) rows.push(cells);
    }
    tables.push(rows);
  }
  return tables;
}

export interface SeeedPinTable {
  /** Pad name -> GPIO, e.g. { D0: 2, D1: 3 } */
  pads: Record<string, number>;
  bootGpio: number | null;
  userLedGpio: number | null;
}

/** Extracts every "XIAO Pin / Chip Pin" table of a Seeed wiki page. */
export function parseSeeedXiaoPinTables(html: string): SeeedPinTable[] {
  const result: SeeedPinTable[] = [];
  for (const rows of parseHtmlTables(html)) {
    const header = rows[0];
    if (!header) continue;
    const padIdx = header.findIndex((cell) => /xiao\s*pin/i.test(cell));
    const chipIdx = header.findIndex((cell) => /chip\s*pin/i.test(cell));
    if (padIdx < 0 || chipIdx < 0) continue;

    const table: SeeedPinTable = { pads: {}, bootGpio: null, userLedGpio: null };
    for (const row of rows.slice(1)) {
      const pad = (row[padIdx] ?? "").trim();
      const chipMatch = (row[chipIdx] ?? "").trim().match(/^GPIO\s*(\d{1,2})$/i);
      if (!chipMatch) continue;
      const gpio = Number.parseInt(chipMatch[1]!, 10);
      if (/^D\d{1,2}$/i.test(pad)) {
        table.pads[pad.toUpperCase()] = gpio;
      } else if (/^boot$/i.test(pad)) {
        table.bootGpio = gpio;
      } else if (/^(user[_\s-]?led|light)$/i.test(pad)) {
        table.userLedGpio = gpio;
      }
    }
    if (Object.keys(table.pads).length > 0) result.push(table);
  }
  return result;
}

export interface SeeedPlatformManifest {
  name: string | null;
  mcu: string | null;
  flashSizeMb: number | null;
  hwids: Array<[number, number]>;
  hasPsram: boolean;
  url: string | null;
}

export function parseSeeedPlatformManifest(text: string): SeeedPlatformManifest | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const root = json as {
    name?: unknown;
    url?: unknown;
    build?: { mcu?: unknown; hwids?: unknown; extra_flags?: unknown };
    upload?: { flash_size?: unknown; maximum_size?: unknown };
  };
  const hwids: Array<[number, number]> = [];
  if (Array.isArray(root.build?.hwids)) {
    for (const pair of root.build.hwids) {
      if (!Array.isArray(pair)) continue;
      const vid = parseUsbHexId(String(pair[0] ?? ""));
      const pid = parseUsbHexId(String(pair[1] ?? ""));
      if (vid !== null && pid !== null) hwids.push([vid, pid]);
    }
  }
  const flags = Array.isArray(root.build?.extra_flags)
    ? root.build.extra_flags.map(String)
    : typeof root.build?.extra_flags === "string"
      ? [root.build.extra_flags]
      : [];
  let flashSizeMb = parseFlashSizeMb(
    typeof root.upload?.flash_size === "string" ? root.upload.flash_size : null
  );
  if (flashSizeMb === null && typeof root.upload?.maximum_size === "number") {
    const mb = root.upload.maximum_size / (1024 * 1024);
    if (Number.isInteger(mb) && mb > 0) flashSizeMb = mb;
  }
  return {
    name: typeof root.name === "string" ? root.name : null,
    mcu: typeof root.build?.mcu === "string" ? root.build.mcu : null,
    flashSizeMb,
    hwids,
    hasPsram: flags.some((flag) => /BOARD_HAS_PSRAM/.test(flag)),
    url: typeof root.url === "string" ? root.url : null,
  };
}

/** Manifest names ("seeed-xiao-esp32-c3") listed in Seeed's PlatformIO platform. */
export function parseSeeedPlatformIndex(text: string): string[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(json)) return null;
  const names: string[] = [];
  for (const entry of json) {
    const name = (entry as { name?: unknown } | null)?.name;
    if (typeof name === "string" && /^seeed-xiao-[a-z0-9-]+\.json$/i.test(name)) {
      names.push(name.replace(/\.json$/i, "").toLowerCase());
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Library state
// ---------------------------------------------------------------------------

interface LibraryRow {
  id: string;
  slug: string;
  manufacturer: string;
  model: string;
  is_available: boolean;
  verification_status: string;
  deleted_at: string | null;
}

interface LibraryState {
  bySlug: Map<string, LibraryRow>;
  byModelKey: Map<string, LibraryRow>;
}

/** "Seeed Studio" + "XIAO ESP32-C3" and "XIAO ESP32C3" give the same key. */
export function boardModelKey(manufacturer: string, model: string): string {
  const maker = manufacturer.toLowerCase().replace(/[^a-z0-9]/g, "");
  let key = model.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Longest first, so "seeedstudio" is removed as a whole and not as "seeed".
  const prefixes = [maker, "seeedstudio", "seeed", "espressif"]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (key.startsWith(prefix) && key.length > prefix.length) {
      key = key.slice(prefix.length);
      break;
    }
  }
  return key;
}

async function loadLibraryState(db: DbClient): Promise<LibraryState> {
  const { data } = await db
    .from("board_catalog")
    .select("id,slug,manufacturer,model,is_available,verification_status,deleted_at");
  const rows = (data ?? []) as LibraryRow[];
  const bySlug = new Map<string, LibraryRow>();
  const byModelKey = new Map<string, LibraryRow>();
  for (const row of rows) {
    bySlug.set(row.slug, row);
    if (!row.deleted_at) byModelKey.set(boardModelKey(row.manufacturer, row.model), row);
  }
  return { bySlug, byModelKey };
}

function libraryStatus(
  state: LibraryState,
  slug: string,
  manufacturer: string,
  model: string
): Pick<ImportCandidate, "status" | "statusDetail" | "selectable" | "existingBoardId"> {
  const bySlug = state.bySlug.get(slug);
  if (bySlug && !bySlug.deleted_at) {
    return {
      status: "in_library",
      statusDetail: `Already in the Board Library (${bySlug.is_available ? "published" : "hidden"}). Its configuration is left untouched.`,
      selectable: false,
      existingBoardId: bySlug.id,
    };
  }
  if (bySlug?.deleted_at) {
    return {
      status: "removed",
      statusDetail:
        "Removed from the Board Library earlier. Importing restores it with the configuration it had.",
      selectable: true,
      existingBoardId: bySlug.id,
    };
  }
  const sameModel = state.byModelKey.get(boardModelKey(manufacturer, model));
  if (sameModel) {
    return {
      status: "in_library",
      statusDetail: `Already in the Board Library as "${sameModel.manufacturer} ${sameModel.model}" (${sameModel.slug}).`,
      selectable: false,
      existingBoardId: sameModel.id,
    };
  }
  return {
    status: "new",
    statusDetail: "Not in the Board Library yet.",
    selectable: true,
    existingBoardId: null,
  };
}

function previewProfile(seed: CatalogBoardSeed, extra?: Record<string, unknown>): ImportBoardProfile {
  return {
    ...seed,
    ...resolveBoardFirmwareCompatibility(seed),
    id: `preview:${seed.slug}`,
    description: seed.revision_notes ?? null,
    is_available: false,
    ...extra,
  };
}

function unverifiedPreviewProfile(entry: DiscoveredDevKitEntry): ImportBoardProfile {
  return {
    ...entry,
    ...resolveBoardFirmwareCompatibility(entry),
    id: `preview:${entry.slug}`,
    description: entry.revision_notes,
    verification_status: "needs_verification",
    firmware_status: "catalog_only",
    is_available: false,
    board_layout: null,
    gpio_definitions: [],
  };
}

// ---------------------------------------------------------------------------
// Seeed Studio XIAO
// ---------------------------------------------------------------------------

type FetchResult = Awaited<ReturnType<typeof fetchOfficialSource>>;

function comparePinTable(
  reference: SeeedXiaoOfficialBoard,
  page: FetchResult | undefined
): ImportSourceCheck {
  const label = "Pin table (Seeed Studio wiki)";
  const url = reference.wikiUrl;
  if (!page || !page.ok) {
    return {
      key: "pin_table",
      label,
      status: "unreachable",
      detail: `The wiki page could not be read (${page && !page.ok ? page.reason : "not requested"}). The built-in profile, transcribed from the official pin table, is used as is.`,
      url,
    };
  }
  const tables = parseSeeedXiaoPinTables(page.text);
  if (tables.length === 0) {
    return {
      key: "pin_table",
      label,
      status: "not_available",
      detail:
        "The wiki page loaded but no pin table was found on it (the page layout may have changed). The built-in profile is used as is.",
      url,
    };
  }

  const refPads = Object.entries(reference.officialPinMap);
  const bootGpio = reference.seed.boot_button_gpio ?? null;
  let best: { table: SeeedPinTable; diffs: string[] } | null = null;
  for (const table of tables) {
    const diffs: string[] = [];
    for (const [pad, gpio] of refPads) {
      const live = table.pads[pad];
      if (live === undefined) diffs.push(`${pad} is missing on the page`);
      else if (live !== gpio) diffs.push(`${pad}: profile GPIO${gpio}, page GPIO${live}`);
    }
    if (diffs.length === 0 && bootGpio !== null && table.bootGpio !== null && table.bootGpio !== bootGpio) {
      diffs.push(`BOOT button: profile GPIO${bootGpio}, page GPIO${table.bootGpio}`);
    }
    if (!best || diffs.length < best.diffs.length) best = { table, diffs };
    if (diffs.length === 0) break;
  }

  if (best && best.diffs.length === 0) {
    return {
      key: "pin_table",
      label,
      status: "confirmed",
      detail: `All ${refPads.length} pads match the official pin table${
        best.table.bootGpio !== null ? `, BOOT button on GPIO${best.table.bootGpio}` : ""
      }.`,
      url,
    };
  }
  return {
    key: "pin_table",
    label,
    status: "conflict",
    detail: `The official pin table differs from the built-in profile: ${(best?.diffs ?? []).slice(0, 4).join("; ")}.`,
    url,
  };
}

function compareManifest(
  reference: SeeedXiaoOfficialBoard,
  manifestResult: FetchResult | undefined
): ImportSourceCheck {
  const label = "Board manifest (Seeed PlatformIO platform)";
  if (!reference.platformManifest) {
    return {
      key: "manifest",
      label,
      status: "not_available",
      detail: "Seeed publishes no separate PlatformIO manifest for this board.",
      url: SEEED_PLATFORM_REPO_URL,
    };
  }
  const url = seeedPlatformManifestUrl(reference.platformManifest);
  if (!manifestResult || !manifestResult.ok) {
    return {
      key: "manifest",
      label,
      status: "unreachable",
      detail: `The manifest could not be read (${manifestResult && !manifestResult.ok ? manifestResult.reason : "not requested"}).`,
      url,
    };
  }
  const manifest = parseSeeedPlatformManifest(manifestResult.text);
  if (!manifest) {
    return { key: "manifest", label, status: "not_available", detail: "The manifest is not valid JSON.", url };
  }

  const seed = reference.seed;
  const diffs: string[] = [];
  const manifestFamily = canonicalChipFamily(manifest.mcu);
  if (manifestFamily && manifestFamily !== seed.chip_family) {
    diffs.push(`MCU: profile ${chipFamilyLabel(seed.chip_family)}, manifest ${manifest.mcu}`);
  }
  if (manifest.flashSizeMb !== null && manifest.flashSizeMb !== seed.flash_size_mb) {
    diffs.push(`flash: profile ${seed.flash_size_mb} MB, manifest ${manifest.flashSizeMb} MB`);
  }
  const vid = parseUsbHexId(seed.usb_vid);
  const pid = parseUsbHexId(seed.usb_pid);
  const usbListed =
    manifest.hwids.length === 0 ||
    vid === null ||
    pid === null ||
    manifest.hwids.some(([v, p]) => v === vid && p === pid);
  if (!usbListed) diffs.push(`USB ID ${seed.usb_vid}:${seed.usb_pid} is not listed in the manifest`);

  if (diffs.length > 0) {
    return {
      key: "manifest",
      label,
      status: "conflict",
      detail: `The official manifest differs from the built-in profile: ${diffs.join("; ")}.`,
      url,
    };
  }
  return {
    key: "manifest",
    label,
    status: "confirmed",
    detail: `MCU ${manifest.mcu ?? "?"}, ${manifest.flashSizeMb ?? "?"} MB flash and the USB ID match the official manifest.`,
    url,
  };
}

function compareImages(
  reference: SeeedXiaoOfficialBoard,
  page: FetchResult | undefined
): { check: ImportSourceCheck; imageUrl: string | null; pinoutImageUrl: string | null } {
  const label = "Board images (files.seeedstudio.com)";
  const seed = reference.seed;
  const wanted = [seed.image_url, seed.pinout_image_url].filter((u): u is string => Boolean(u));
  if (wanted.length === 0) {
    return {
      check: { key: "images", label, status: "not_available", detail: "No official image is recorded for this board." },
      imageUrl: null,
      pinoutImageUrl: null,
    };
  }
  if (!page || !page.ok) {
    return {
      check: {
        key: "images",
        label,
        status: "unreachable",
        detail: "The wiki page could not be read, so the image links were not re-checked.",
        url: reference.wikiUrl,
      },
      imageUrl: seed.image_url ?? null,
      pinoutImageUrl: seed.pinout_image_url ?? null,
    };
  }
  const listed = (url: string | null | undefined) => Boolean(url && page.text.includes(url));
  const imageUrl = listed(seed.image_url) ? (seed.image_url as string) : null;
  const pinoutImageUrl = listed(seed.pinout_image_url) ? (seed.pinout_image_url as string) : null;
  const found = [imageUrl, pinoutImageUrl].filter(Boolean).length;
  return {
    check: {
      key: "images",
      label,
      status: found === wanted.length ? "confirmed" : "not_available",
      detail:
        found === wanted.length
          ? "The board photo and the pinout diagram are still published on the official page."
          : `${wanted.length - found} of ${wanted.length} image links are no longer on the official page and are left out.`,
      url: reference.wikiUrl,
    },
    imageUrl,
    pinoutImageUrl,
  };
}

function mcuFromManifestName(name: string): string {
  const match = name.match(/(esp32-?[a-z]\d+|nrf54lm20[ab]?|nrf54l15|nrf52840|rp2040|rp2350|samd|mg24|ra4m1|stm32[a-z]\d+)/i);
  return match ? match[1]!.toUpperCase() : "another";
}

async function collectSeeedXiao(params: {
  db: DbClient;
  fetcher: CustomFetch;
}): Promise<ImportPreview> {
  const { fetcher } = params;
  const references = SEEED_XIAO_OFFICIAL_BOARDS;
  const wikiUrls = Array.from(new Set(references.map((r) => r.wikiUrl)));
  const manifestNames = references
    .map((r) => r.platformManifest)
    .filter((name): name is string => Boolean(name));

  const [state, indexResult, wikiResults, manifestResults] = await Promise.all([
    loadLibraryState(params.db),
    fetchOfficialSource(fetcher, SEEED_PLATFORM_BOARDS_INDEX_URL, { accept: "application/json" }),
    Promise.all(wikiUrls.map((url) => fetchOfficialSource(fetcher, url))),
    Promise.all(
      manifestNames.map((name) =>
        fetchOfficialSource(fetcher, seeedPlatformManifestUrl(name), { accept: "application/json" })
      )
    ),
  ]);

  const wikiByUrl = new Map(wikiUrls.map((url, i) => [url, wikiResults[i]!]));
  const manifestByName = new Map(manifestNames.map((name, i) => [name, manifestResults[i]!]));
  const liveSourcesReached =
    wikiResults.filter((r) => r.ok).length +
    manifestResults.filter((r) => r.ok).length +
    (indexResult.ok ? 1 : 0);

  const notes: string[] = [];
  const reachedWiki = wikiResults.filter((r) => r.ok).length;
  notes.push(`Seeed Studio wiki: ${reachedWiki} of ${wikiUrls.length} pages read`);
  notes.push(
    `Seeed PlatformIO manifests: ${manifestResults.filter((r) => r.ok).length} of ${manifestNames.length} read`
  );

  const candidates: ImportCandidate[] = [];

  for (const reference of references) {
    const seed = reference.seed;
    const page = wikiByUrl.get(reference.wikiUrl);
    const pinCheck = comparePinTable(reference, page);
    const manifestCheck = compareManifest(
      reference,
      reference.platformManifest ? manifestByName.get(reference.platformManifest) : undefined
    );
    const images = compareImages(reference, page);
    const conflict = pinCheck.status === "conflict" || manifestCheck.status === "conflict";
    const confirmedLive = pinCheck.status === "confirmed";

    candidates.push({
      slug: seed.slug,
      provider: "seeed_xiao",
      name: `${seed.manufacturer} ${seed.model}`,
      ...libraryStatus(state, seed.slug, seed.manufacturer, seed.model),
      verification: conflict ? "needs_verification" : "verified",
      verificationNote: conflict
        ? "The official source and the built-in profile disagree. The board is imported hidden and must be verified before it can be published."
        : confirmedLive
          ? "Pin map confirmed against the official Seeed Studio pin table just now."
          : "The official source could not be read just now. The built-in profile is a checked transcription of the official pin table.",
      board: previewProfile(seed, {
        image_url: images.imageUrl,
        pinout_image_url: images.pinoutImageUrl,
        verification_status: conflict ? "needs_verification" : "verified",
      }),
      highlights: reference.highlights,
      sources: reference.sources,
      checks: [pinCheck, manifestCheck, images.check],
    });
  }

  // Boards Seeed lists that HomecoreOS has no checked profile for.
  const knownManifests = new Set(manifestNames);
  const index = indexResult.ok ? parseSeeedPlatformIndex(indexResult.text) : null;
  if (!indexResult.ok) {
    notes.push(`Seeed board list unreachable (${indexResult.reason}); only known boards are shown`);
  } else if (!index) {
    notes.push("Seeed board list could not be parsed; only known boards are shown");
  } else {
    notes.push(`Seeed board list: ${index.length} XIAO manifests`);
    const unknown = index.filter((name) => !knownManifests.has(name));
    const unknownEsp32 = unknown.filter((name) => /esp32/.test(name));
    const fetchedUnknown = await Promise.all(
      unknownEsp32.map((name) =>
        fetchOfficialSource(fetcher, seeedPlatformManifestUrl(name), { accept: "application/json" })
      )
    );

    unknownEsp32.forEach((name, i) => {
      const result = fetchedUnknown[i]!;
      const manifest = result.ok ? parseSeeedPlatformManifest(result.text) : null;
      const chipFamily = normalizeChipFamily(manifest?.mcu ?? name.replace(/^seeed-xiao-/, ""));
      const model = (manifest?.name ?? name.replace(/^seeed-/, "").replace(/-/g, " ").toUpperCase())
        .replace(/^Seeed Studio\s+/i, "")
        .trim();
      const slug = name.replace(/esp32-([a-z]\d+)/, "esp32$1");
      const manifestUrl = seeedPlatformManifestUrl(name);
      if (!manifest || !chipFamily || manifest.flashSizeMb === null) {
        candidates.push({
          slug,
          provider: "seeed_xiao",
          name: `Seeed Studio ${model}`,
          status: "unsupported",
          statusDetail: !manifest
            ? "Listed by Seeed, but its manifest could not be read."
            : "Listed by Seeed, but its manifest does not state a supported chip and flash size.",
          selectable: false,
          verification: "needs_verification",
          verificationNote: "No checked profile exists for this board.",
          existingBoardId: null,
          board: null,
          highlights: [],
          sources: [{ label: "Seeed PlatformIO board manifest", url: manifestUrl }],
          checks: [],
        });
        return;
      }
      const entry: DiscoveredDevKitEntry = {
        slug,
        manufacturer: "Seeed Studio",
        model,
        // The manifest states no hardware revision.
        revision: BOARD_REVISION_UNSPECIFIED,
        chip_family: chipFamily,
        chip_variant: chipFamilyLabel(chipFamily),
        flash_size_mb: manifest.flashSizeMb,
        psram_size_mb: 0,
        catalog_category: "partner",
        series: chipFamilyLabel(chipFamily),
        image_url: null,
        docs_url: manifest.url,
        source_url: manifestUrl,
        source_provider: SEEED_XIAO_SOURCE_PROVIDER,
        revision_notes:
          "Listed in Seeed's official PlatformIO platform. HomecoreOS has no checked pin map for it yet: verify the pinout before publishing.",
      };
      candidates.push({
        slug,
        provider: "seeed_xiao",
        name: `Seeed Studio ${model}`,
        ...libraryStatus(state, slug, "Seeed Studio", model),
        verification: "needs_verification",
        verificationNote:
          "HomecoreOS has no checked pin map for this board. It is imported hidden, without pins, until an admin verifies the pinout.",
        board: unverifiedPreviewProfile(entry),
        highlights: [
          `${chipFamilyLabel(chipFamily)}, ${manifest.flashSizeMb} MB flash${manifest.hasPsram ? ", PSRAM fitted (size not stated)" : ""}`,
        ],
        sources: [
          { label: "Seeed PlatformIO board manifest", url: manifestUrl },
          ...(manifest.url ? [{ label: "Seeed Studio wiki", url: manifest.url }] : []),
        ],
        checks: [
          {
            key: "manifest",
            label: "Board manifest (Seeed PlatformIO platform)",
            status: "confirmed",
            detail: "MCU and flash size are read from the official manifest. It contains no pin map.",
            url: manifestUrl,
          },
        ],
      });
    });

    for (const name of unknown.filter((n) => !/esp32/.test(n))) {
      candidates.push({
        slug: name,
        provider: "seeed_xiao",
        name: name.replace(/^seeed-/, "").replace(/-/g, " ").toUpperCase(),
        status: "unsupported",
        statusDetail: `Uses ${mcuFromManifestName(name)} silicon. HomecoreOS firmware runs on ESP32 chips only.`,
        selectable: false,
        verification: "needs_verification",
        verificationNote: "Not an ESP32 board.",
        existingBoardId: null,
        board: null,
        highlights: [],
        sources: [{ label: "Seeed PlatformIO board manifest", url: seeedPlatformManifestUrl(name) }],
        checks: [],
      });
    }
  }

  return {
    provider: "seeed_xiao",
    providerLabel: OFFICIAL_IMPORT_PROVIDER_LABELS.seeed_xiao,
    fetchedAt: new Date().toISOString(),
    liveSourcesReached,
    sourceUrls: [...wikiUrls, SEEED_PLATFORM_REPO_URL],
    notes,
    candidates,
  };
}

// ---------------------------------------------------------------------------
// Espressif
// ---------------------------------------------------------------------------

async function collectEspressif(params: { db: DbClient; fetcher: CustomFetch }): Promise<ImportPreview> {
  const [state, live] = await Promise.all([
    loadLibraryState(params.db),
    fetchEspressifLiveSources(params.fetcher),
  ]);
  const listingReachable = live.notes.some((n) => /^Fetched Espressif DevKits/.test(n));
  const candidates: ImportCandidate[] = [];

  for (const seed of VERIFIED_BOARD_CATALOG.filter((b) => b.catalog_category === "official_espressif")) {
    const listed = live.discovered.some(
      (d) => seed.slug === d.slug || seed.slug.startsWith(`${d.slug}-`)
    );
    candidates.push({
      slug: seed.slug,
      provider: "espressif",
      name: `${seed.manufacturer} ${seed.model}`,
      ...libraryStatus(state, seed.slug, seed.manufacturer, seed.model),
      verification: "verified",
      verificationNote:
        "Pin map from the HomecoreOS verified catalog, transcribed from the Espressif user guide.",
      board: previewProfile(seed),
      highlights: [],
      sources: [
        { label: "Espressif user guide", url: seed.docs_url },
        ...(seed.datasheet_url ? [{ label: "Module datasheet", url: seed.datasheet_url }] : []),
      ],
      checks: [
        {
          key: "pin_table",
          label: "Pin map (HomecoreOS verified catalog)",
          status: "reference",
          detail: "Transcribed from the board's Espressif user guide and checked by HomecoreOS.",
          url: seed.docs_url,
        },
        {
          key: "listing",
          label: "Listing (espressif.com DevKits)",
          status: !listingReachable ? "unreachable" : listed ? "confirmed" : "not_available",
          detail: !listingReachable
            ? "The Espressif DevKits page could not be read just now."
            : listed
              ? "The board is on Espressif's current DevKits page."
              : "The board was not found on the current DevKits page.",
          url: ESPRESSIF_DEVKITS_URL,
        },
      ],
    });
  }

  for (const entry of collectUnverifiedEspressifDevkits(live.discovered).values()) {
    candidates.push({
      slug: entry.slug,
      provider: "espressif",
      name: `${entry.manufacturer} ${entry.model}`,
      ...libraryStatus(state, entry.slug, entry.manufacturer, entry.model),
      verification: "needs_verification",
      verificationNote:
        "HomecoreOS has no checked pin map for this board. It is imported hidden, without pins, until an admin verifies the pinout.",
      board: unverifiedPreviewProfile(entry),
      highlights: [
        `${chipFamilyLabel(entry.chip_family)}, ${entry.flash_size_mb} MB flash${entry.psram_size_mb > 0 ? `, ${entry.psram_size_mb} MB PSRAM` : ""}`,
      ],
      sources: [
        ...(entry.docs_url ? [{ label: "Espressif documentation", url: entry.docs_url }] : []),
        { label: "Espressif DevKits", url: entry.source_url },
      ],
      checks: [],
    });
  }

  return {
    provider: "espressif",
    providerLabel: OFFICIAL_IMPORT_PROVIDER_LABELS.espressif,
    fetchedAt: new Date().toISOString(),
    liveSourcesReached: live.liveSuccessCount,
    sourceUrls: [ESPRESSIF_DEVKITS_URL, ESP_BOARD_MANAGER_INDEX_URL],
    notes: live.notes,
    candidates,
  };
}

/** Reads the official sources and lists what could be imported. Writes nothing. */
export async function previewOfficialBoardImport(params: {
  db: DbClient;
  provider: OfficialImportProvider;
  syncFetch?: CustomFetch;
}): Promise<ImportPreview> {
  const fetcher: CustomFetch = params.syncFetch ?? fetch;
  return params.provider === "seeed_xiao"
    ? collectSeeedXiao({ db: params.db, fetcher })
    : collectEspressif({ db: params.db, fetcher });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportBoardOutcome {
  slug: string;
  name: string;
  action: "imported" | "restored" | "skipped";
  /** Why a board was skipped, or how it entered the library. */
  detail: string;
  boardId: string | null;
  published: boolean;
  verification: "verified" | "needs_verification" | null;
}

export interface ImportRunResult {
  runId: string | null;
  provider: OfficialImportProvider;
  providerLabel: string;
  status: "succeeded" | "partial" | "failed";
  requestedCount: number;
  importedCount: number;
  restoredCount: number;
  skippedCount: number;
  needsVerificationCount: number;
  outcomes: ImportBoardOutcome[];
  /** What was read from the official sources during this run. */
  sourceNotes: string[];
  /** The source notes plus the counts, as stored in the sync history. */
  summaryNotes: string;
}

function findSeed(provider: OfficialImportProvider, slug: string): CatalogBoardSeed | null {
  if (provider === "seeed_xiao") {
    return SEEED_XIAO_OFFICIAL_BOARDS.find((b) => b.seed.slug === slug)?.seed ?? null;
  }
  return (
    VERIFIED_BOARD_CATALOG.find(
      (b) => b.slug === slug && b.catalog_category === "official_espressif"
    ) ?? null
  );
}

/** Adds the selected boards. Everything is re-derived on the server. */
export async function importOfficialBoards(params: {
  db: DbClient;
  provider: OfficialImportProvider;
  slugs: string[];
  publish: boolean;
  adminUserId?: string | null;
  syncFetch?: CustomFetch;
}): Promise<ImportRunResult> {
  const startedAt = new Date().toISOString();
  const preview = await previewOfficialBoardImport({
    db: params.db,
    provider: params.provider,
    syncFetch: params.syncFetch,
  });
  const candidates = new Map(preview.candidates.map((c) => [c.slug, c]));
  const requested = Array.from(new Set(params.slugs.map((s) => s.trim()).filter(Boolean)));
  const nowIso = new Date().toISOString();
  const outcomes: ImportBoardOutcome[] = [];

  for (const slug of requested) {
    const candidate = candidates.get(slug);
    if (!candidate) {
      outcomes.push({
        slug,
        name: slug,
        action: "skipped",
        detail: "Not offered by this source.",
        boardId: null,
        published: false,
        verification: null,
      });
      continue;
    }
    const base = { slug, name: candidate.name };

    if (candidate.status === "in_library") {
      outcomes.push({
        ...base,
        action: "skipped",
        detail: "Already in the Board Library. Nothing was changed.",
        boardId: candidate.existingBoardId,
        published: false,
        verification: null,
      });
      continue;
    }
    if (candidate.status === "unsupported" || !candidate.board) {
      outcomes.push({
        ...base,
        action: "skipped",
        detail: candidate.statusDetail,
        boardId: null,
        published: false,
        verification: null,
      });
      continue;
    }

    if (candidate.status === "removed" && candidate.existingBoardId) {
      const { data: existing } = await params.db
        .from("board_catalog")
        .select("id,verification_status")
        .eq("id", candidate.existingBoardId)
        .maybeSingle();
      const row = existing as { id: string; verification_status: string } | null;
      if (!row) {
        outcomes.push({
          ...base,
          action: "skipped",
          detail: "The removed board record no longer exists.",
          boardId: null,
          published: false,
          verification: null,
        });
        continue;
      }
      const published = params.publish && row.verification_status === "verified";
      const { data: restored, error } = await params.db
        .from("board_catalog")
        .update({ deleted_at: null, is_available: published, last_synced_at: nowIso })
        .eq("id", row.id)
        .select("id")
        .maybeSingle();
      if (error || !restored) {
        outcomes.push({
          ...base,
          action: "skipped",
          detail: `Could not restore the board${error ? `: ${error.message}` : "."}`,
          boardId: row.id,
          published: false,
          verification: null,
        });
        continue;
      }
      outcomes.push({
        ...base,
        action: "restored",
        detail: published
          ? "Restored with its previous configuration and published."
          : "Restored with its previous configuration, hidden from users.",
        boardId: row.id,
        published,
        verification: row.verification_status === "verified" ? "verified" : "needs_verification",
      });
      continue;
    }

    // New board.
    const seed = candidate.verification === "verified" ? findSeed(params.provider, slug) : null;
    const verifiedSeed = seed && candidate.board.gpio_definitions.length > 0 ? seed : null;
    let rowPayload: Record<string, unknown>;
    let published = false;

    if (verifiedSeed) {
      published = params.publish && validateBoardPublicationReady(verifiedSeed).ready;
      rowPayload = {
        ...buildVerifiedCatalogRow(verifiedSeed, {
          isAvailable: published,
          firmwareStatus: verifiedSeed.firmware_status,
          verificationStatus: "verified",
          nowIso,
        }),
        // Only image links that are still on the official page are stored.
        image_url: (candidate.board.image_url as string | null | undefined) ?? null,
        pinout_image_url: (candidate.board.pinout_image_url as string | null | undefined) ?? null,
      };
    } else {
      const conflictSeed = findSeed(params.provider, slug);
      rowPayload = conflictSeed
        ? {
            // A reference profile that disagrees with the official source is
            // kept for review, hidden, and must be verified by an admin.
            ...buildVerifiedCatalogRow(conflictSeed, {
              isAvailable: false,
              firmwareStatus: conflictSeed.firmware_status,
              verificationStatus: "needs_verification",
              nowIso,
            }),
            revision_notes: `${conflictSeed.revision_notes ?? ""} Imported with a conflict against the official source: verify the pin map before publishing.`.trim(),
          }
        : buildUnverifiedCatalogRow(candidate.board as unknown as DiscoveredDevKitEntry, nowIso);
    }

    const { data: created, error } = await params.db
      .from("board_catalog")
      .insert(rowPayload)
      .select("id")
      .maybeSingle();
    const boardId = (created as { id?: string } | null)?.id ?? null;
    if (error || !boardId) {
      outcomes.push({
        ...base,
        action: "skipped",
        detail: /duplicate|unique/i.test(error?.message ?? "")
          ? "Already in the Board Library. Nothing was changed."
          : `Could not add the board${error ? `: ${error.message}` : "."}`,
        boardId: null,
        published: false,
        verification: null,
      });
      continue;
    }

    const pinSource = verifiedSeed ?? findSeed(params.provider, slug);
    if (pinSource && pinSource.gpio_definitions.length > 0) {
      await params.db
        .from("board_gpio_definitions")
        .insert(buildGpioDefinitionRows(boardId, pinSource.gpio_definitions));
    }

    outcomes.push({
      ...base,
      action: "imported",
      detail: verifiedSeed
        ? published
          ? "Added with its verified pin map and published."
          : "Added with its verified pin map, hidden from users."
        : "Added hidden. The pin map must be verified before it can be published.",
      boardId,
      published,
      verification: verifiedSeed ? "verified" : "needs_verification",
    });
  }

  const importedCount = outcomes.filter((o) => o.action === "imported").length;
  const restoredCount = outcomes.filter((o) => o.action === "restored").length;
  const skippedCount = outcomes.filter((o) => o.action === "skipped").length;
  const needsVerificationCount = outcomes.filter(
    (o) => o.action !== "skipped" && o.verification === "needs_verification"
  ).length;
  const status: ImportRunResult["status"] = preview.liveSourcesReached >= 1 ? "succeeded" : "partial";
  const summaryNotes = [
    ...preview.notes,
    `Import: ${importedCount} added, ${restoredCount} restored, ${skippedCount} skipped of ${requested.length} selected.`,
  ].join(" · ");

  const { data: runRow } = await params.db
    .from("board_catalog_sync_runs")
    .insert({
      source_name: `${preview.providerLabel} (official import)`,
      status,
      triggered_by_admin_id: params.adminUserId ?? null,
      discovered_count: preview.candidates.length,
      inserted_count: importedCount,
      updated_count: restoredCount,
      needs_verification_count: needsVerificationCount,
      source_urls: preview.sourceUrls,
      summary_notes: summaryNotes,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();

  return {
    runId: (runRow as { id?: string } | null)?.id ?? null,
    provider: params.provider,
    providerLabel: preview.providerLabel,
    status,
    requestedCount: requested.length,
    importedCount,
    restoredCount,
    skippedCount,
    needsVerificationCount,
    outcomes,
    sourceNotes: preview.notes,
    summaryNotes,
  };
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

export interface BoardUsage {
  /** Controllers that run on this board. They block a removal. */
  controllerCount: number;
  /** Accounts that saved the board to My Boards. */
  savedByAccountCount: number;
  /** Firmware releases that name the board as a target. */
  firmwareReleaseCount: number;
  canRemove: boolean;
  blockers: string[];
  consequences: string[];
}

/** What depends on a catalog board, and whether it may be removed. */
export async function inspectBoardUsage(
  db: DbClient,
  board: { id: string; slug: string }
): Promise<BoardUsage> {
  const [controllersRes, savedRes, releasesRes] = await Promise.all([
    db.from("controllers").select("id").eq("board_catalog_id", board.id).is("deleted_at", null),
    db.from("account_saved_boards").select("account_id").eq("board_catalog_id", board.id),
    db
      .from("firmware_releases")
      .select("id,compatible_board_ids,target_board_slug")
      .is("deleted_at", null),
  ]);

  const controllerCount = (controllersRes.data ?? []).length;
  const savedByAccountCount = new Set(
    ((savedRes.data ?? []) as Array<{ account_id: string }>).map((r) => r.account_id)
  ).size;
  const firmwareReleaseCount = (
    (releasesRes.data ?? []) as Array<{
      compatible_board_ids?: string[] | null;
      target_board_slug?: string | null;
    }>
  ).filter(
    (r) => r.target_board_slug === board.slug || (r.compatible_board_ids ?? []).includes(board.id)
  ).length;

  const blockers: string[] = [];
  if (controllerCount > 0) {
    blockers.push(
      `${controllerCount} controller${controllerCount === 1 ? " runs" : "s run"} on this board. Removing it would leave ${controllerCount === 1 ? "it" : "them"} without a pin map. Hide the board instead.`
    );
  }
  const consequences: string[] = [
    "The board disappears from the user Board Library and from new controller setups.",
  ];
  if (savedByAccountCount > 0) {
    consequences.push(
      `${savedByAccountCount} account${savedByAccountCount === 1 ? " has" : "s have"} it in My Boards. It is hidden there until the board is restored.`
    );
  }
  if (firmwareReleaseCount > 0) {
    consequences.push(
      `${firmwareReleaseCount} firmware release${firmwareReleaseCount === 1 ? " names" : "s name"} it as a target. The release${firmwareReleaseCount === 1 ? "" : "s"} stay${firmwareReleaseCount === 1 ? "s" : ""}, but no longer apply to this board.`
    );
  }
  consequences.push(
    "The catalog sync will not bring it back. It can be restored later with Import Official Boards, with its configuration intact."
  );

  return {
    controllerCount,
    savedByAccountCount,
    firmwareReleaseCount,
    canRemove: blockers.length === 0,
    blockers,
    consequences,
  };
}
