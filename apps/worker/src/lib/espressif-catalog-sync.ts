import {
  VERIFIED_BOARD_CATALOG,
  normalizeChipFamily,
  resolveBoardFirmwareCompatibility,
  type BoardCatalogCategory,
  type CatalogBoardSeed,
  type ChipFamily,
  type GpioPinDefinition,
} from "@homecoreos/shared";
import type { CustomFetch, DbClient } from "./db";

export interface DiscoveredDevKitEntry {
  slug: string;
  manufacturer: string;
  model: string;
  revision: string;
  chip_family: ChipFamily;
  chip_variant: string;
  flash_size_mb: number;
  psram_size_mb: number;
  catalog_category: BoardCatalogCategory;
  series: string;
  image_url: string | null;
  docs_url: string | null;
  source_url: string;
  source_provider: string;
  revision_notes: string;
  eol?: boolean;
}

export const ESPRESSIF_DEVKITS_URL = "https://www.espressif.com/products/devkits";
export const ESP_BOARD_MANAGER_INDEX_URL =
  "https://docs.espressif.com/projects/esp-board-manager/en/latest/references/boards/index.html";

export const CURATED_UNVERIFIED_ESPRESSIF_DEVKITS: DiscoveredDevKitEntry[] = [
  {
    slug: "esp32-s3-devkitm-1",
    manufacturer: "Espressif",
    model: "ESP32-S3-DevKitM-1",
    revision: "v1.0",
    chip_family: "esp32s3",
    chip_variant: "ESP32-S3-MINI-1-N8",
    flash_size_mb: 8,
    psram_size_mb: 0,
    catalog_category: "official_espressif",
    series: "ESP32-S3",
    image_url: null,
    docs_url:
      "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitm-1/user_guide.html",
    source_url: ESPRESSIF_DEVKITS_URL,
    source_provider: "espressif_devkits",
    revision_notes:
      "Imported from official Espressif catalog. Verify exact J1/J3 GPIO assignments before publishing to users.",
  },
  {
    slug: "esp32-c6-devkitm-1",
    manufacturer: "Espressif",
    model: "ESP32-C6-DevKitM-1",
    revision: "v1.0",
    chip_family: "esp32c6",
    chip_variant: "ESP32-C6-MINI-1-N4",
    flash_size_mb: 4,
    psram_size_mb: 0,
    catalog_category: "official_espressif",
    series: "ESP32-C6",
    image_url: null,
    docs_url:
      "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c6/esp32-c6-devkitm-1/user_guide.html",
    source_url: ESPRESSIF_DEVKITS_URL,
    source_provider: "espressif_devkits",
    revision_notes:
      "Imported from official Espressif catalog. Verify exact J1/J3 pin header table before publishing.",
  },
  {
    slug: "esp32-devkitm-1",
    manufacturer: "Espressif",
    model: "ESP32-DevKitM-1",
    revision: "v1.0",
    chip_family: "esp32",
    chip_variant: "ESP32-MINI-1-N4",
    flash_size_mb: 4,
    psram_size_mb: 0,
    catalog_category: "official_espressif",
    series: "ESP32",
    image_url: null,
    docs_url:
      "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitm-1/user_guide.html",
    source_url: ESPRESSIF_DEVKITS_URL,
    source_provider: "espressif_devkits",
    revision_notes:
      "Imported from official Espressif catalog. Verify GPIO header table before publishing.",
  },
  {
    slug: "esp32-p4-function-ev-board",
    manufacturer: "Espressif",
    model: "ESP32-P4-Function-EV-Board",
    revision: "v1.5",
    chip_family: "esp32p4",
    chip_variant: "ESP32-P4NRW32",
    flash_size_mb: 16,
    psram_size_mb: 32,
    catalog_category: "official_espressif",
    series: "ESP32-P4",
    image_url: null,
    docs_url:
      "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32p4/esp32-p4-function-ev-board/user_guide.html",
    source_url: ESPRESSIF_DEVKITS_URL,
    source_provider: "espressif_devkits",
    revision_notes:
      "High-performance dual-core RISC-V multimedia EV board (no integrated Wi-Fi radio; uses C6 companion).",
  },
];

function slugifyModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseEspressifDevkitsHtml(html: string): DiscoveredDevKitEntry[] {
  const discovered: DiscoveredDevKitEntry[] = [];
  const seenSlugs = new Set<string>();

  // Parse Espressif DevKit board names and doc links directly from HTML
  const linkRegex =
    /<a[^>]+href=["'](https?:\/\/docs\.espressif\.com\/projects\/esp-dev-kits\/[^"']+|https?:\/\/www\.espressif\.com\/[^"']+)["'][^>]*>([^<]{3,80})<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1]!.trim();
    const text = match[2]!.replace(/\s+/g, " ").trim();
    if (!/devkit|ev-board|korvo|s3-box|eye|xiao/i.test(text)) continue;

    // Infer chip family from URL segment or board title
    const urlChipMatch = href.match(/esp-dev-kits\/en\/[^/]+\/(esp[a-z0-9]+)\//i);
    const titleChipMatch = text.match(/^(ESP32-[A-Z0-9]+|ESP8684|ESP32)/i);
    const chipFamily =
      normalizeChipFamily(urlChipMatch?.[1]) ?? normalizeChipFamily(titleChipMatch?.[1]);
    if (!chipFamily) continue;

    const slug = slugifyModel(text);
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    // Check nearby HTML slice (600 chars around match) for Flash/PSRAM hints or EOL
    const startIdx = Math.max(0, match.index - 200);
    const slice = html.slice(startIdx, Math.min(html.length, match.index + 800));
    if (/not recommended for new designs|\bEOL\b|end of life/i.test(slice)) {
      continue;
    }

    const flashMatch = slice.match(/(\d+)\s*MB\s*(?:SPI\s*)?Flash/i);
    const psramMatch = slice.match(/(\d+)\s*MB\s*(?:Octal\s*|Quad\s*)?PSRAM/i);
    const flashSize = flashMatch
      ? Math.min(64, Math.max(2, Number.parseInt(flashMatch[1]!, 10)))
      : 4;
    const psramSize = psramMatch
      ? Math.min(32, Math.max(0, Number.parseInt(psramMatch[1]!, 10)))
      : 0;

    discovered.push({
      slug,
      manufacturer: "Espressif",
      model: text,
      revision: "v1.0",
      chip_family: chipFamily,
      chip_variant: chipFamily.toUpperCase(),
      flash_size_mb: flashSize,
      psram_size_mb: psramSize,
      catalog_category: "official_espressif",
      series: chipFamily.toUpperCase().replace("ESP32", "ESP32-"),
      image_url: null,
      docs_url: href,
      source_url: ESPRESSIF_DEVKITS_URL,
      source_provider: "espressif_devkits",
      revision_notes:
        "Discovered via live Espressif DevKits sync. Verify physical pinout definition before publishing.",
    });
  }

  return discovered;
}

export function parseEspBoardManagerIndexHtml(html: string): string[] {
  const names: string[] = [];
  const regex = /(?:esp32[_-][a-z0-9_-]+|esp_box[a-z0-9_-]*|m5[a-z0-9_-]*)/gi;
  const matches = html.match(regex) ?? [];
  const seen = new Set<string>();
  for (const m of matches) {
    const slug = slugifyModel(m.replace(/_/g, "-"));
    if (slug.length >= 6 && !seen.has(slug)) {
      seen.add(slug);
      names.push(slug);
    }
  }
  return names;
}

/** One timed GET against an official source. Never throws. */
export async function fetchOfficialSource(
  fetcher: CustomFetch,
  url: string,
  options?: { accept?: string; timeoutMs?: number }
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 10000);
  try {
    const res = await fetcher(url, {
      headers: {
        Accept: options?.accept ?? "text/html",
        // api.github.com rejects requests without a User-Agent.
        "User-Agent": "HomecoreOS-BoardCatalog",
      },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, text: await res.text() };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "network error" };
  } finally {
    clearTimeout(timer);
  }
}

export interface EspressifLiveSources {
  discovered: DiscoveredDevKitEntry[];
  boardManagerBoards: number;
  liveSuccessCount: number;
  notes: string[];
}

/** Reads the two official Espressif sources the catalog sync is based on. */
export async function fetchEspressifLiveSources(fetcher: CustomFetch): Promise<EspressifLiveSources> {
  const notes: string[] = [];
  const discovered: DiscoveredDevKitEntry[] = [];
  let liveSuccessCount = 0;
  let boardManagerBoards = 0;

  const [devkits, boardManager] = await Promise.all([
    fetchOfficialSource(fetcher, ESPRESSIF_DEVKITS_URL),
    fetchOfficialSource(fetcher, ESP_BOARD_MANAGER_INDEX_URL),
  ]);

  if (devkits.ok) {
    const parsed = parseEspressifDevkitsHtml(devkits.text);
    discovered.push(...parsed);
    liveSuccessCount += 1;
    notes.push(`Fetched Espressif DevKits (${parsed.length} boards matched)`);
  } else if (/^HTTP /.test(devkits.reason)) {
    notes.push(`Espressif DevKits returned ${devkits.reason}`);
  } else {
    notes.push(`Espressif DevKits unreachable (${devkits.reason})`);
  }

  if (boardManager.ok) {
    boardManagerBoards = parseEspBoardManagerIndexHtml(boardManager.text).length;
    liveSuccessCount += 1;
    notes.push(`Fetched ESP Board Manager index (${boardManagerBoards} targets indexed)`);
  } else if (/^HTTP /.test(boardManager.reason)) {
    notes.push(`ESP Board Manager returned ${boardManager.reason}`);
  } else {
    notes.push(`ESP Board Manager unreachable (${boardManager.reason})`);
  }

  return { discovered, boardManagerBoards, liveSuccessCount, notes };
}

/** board_catalog row of a verified profile (catalog seed or official reference). */
export function buildVerifiedCatalogRow(
  board: CatalogBoardSeed,
  options: {
    isAvailable: boolean;
    firmwareStatus: string;
    verificationStatus?: "verified" | "needs_verification";
    nowIso: string;
  }
): Record<string, unknown> {
  const compat = resolveBoardFirmwareCompatibility(board);
  return {
    slug: board.slug,
    manufacturer: board.manufacturer,
    model: board.model,
    revision: board.revision,
    chip_family: board.chip_family,
    chip_variant: board.chip_variant,
    flash_size_mb: board.flash_size_mb,
    psram_size_mb: board.psram_size_mb,
    usb_vid: board.usb_vid ?? null,
    usb_pid: board.usb_pid ?? null,
    is_available: options.isAvailable,
    description: board.revision_notes ?? null,
    catalog_category: board.catalog_category,
    series: board.series,
    image_url: board.image_url,
    pinout_image_url: board.pinout_image_url ?? null,
    docs_url: board.docs_url,
    datasheet_url: board.datasheet_url ?? null,
    source_url: board.source_url,
    source_provider: board.source_provider,
    verification_status: options.verificationStatus ?? "verified",
    firmware_status: options.firmwareStatus,
    partition_scheme: compat.partition_scheme,
    psram_mode: compat.psram_mode,
    flash_mode: compat.flash_mode,
    flash_freq: compat.flash_freq,
    bootloader_offset: compat.bootloader_offset,
    ota_app_offset: compat.ota_app_offset,
    boot_button_gpio: compat.boot_button_gpio,
    usb_interface: compat.usb_interface,
    supports_wifi: compat.supports_wifi,
    supports_ble: compat.supports_ble,
    supports_ble_wifi_provisioning: compat.supports_ble_wifi_provisioning,
    supports_ota_rollback: compat.supports_ota_rollback,
    firmware_compat_key: compat.firmware_compat_key,
    connectivity_note: compat.connectivity_note,
    board_layout: board.board_layout,
    revision_notes: board.revision_notes ?? null,
    last_synced_at: options.nowIso,
  };
}

/** board_catalog row of a discovered board whose pin map is still unverified. */
export function buildUnverifiedCatalogRow(
  entry: DiscoveredDevKitEntry,
  nowIso: string
): Record<string, unknown> {
  const compat = resolveBoardFirmwareCompatibility(entry);
  return {
    slug: entry.slug,
    manufacturer: entry.manufacturer,
    model: entry.model,
    revision: entry.revision,
    chip_family: entry.chip_family,
    chip_variant: entry.chip_variant,
    flash_size_mb: entry.flash_size_mb,
    psram_size_mb: entry.psram_size_mb,
    is_available: false, // Never publish unverified boards to users automatically
    description: entry.revision_notes,
    catalog_category: entry.catalog_category,
    series: entry.series,
    image_url: entry.image_url,
    docs_url: entry.docs_url,
    source_url: entry.source_url,
    source_provider: entry.source_provider,
    verification_status: "needs_verification",
    firmware_status: "catalog_only",
    partition_scheme: compat.partition_scheme,
    psram_mode: compat.psram_mode,
    flash_mode: compat.flash_mode,
    flash_freq: compat.flash_freq,
    bootloader_offset: compat.bootloader_offset,
    ota_app_offset: compat.ota_app_offset,
    boot_button_gpio: compat.boot_button_gpio,
    usb_interface: compat.usb_interface,
    supports_wifi: compat.supports_wifi,
    supports_ble: compat.supports_ble,
    supports_ble_wifi_provisioning: compat.supports_ble_wifi_provisioning,
    supports_ota_rollback: compat.supports_ota_rollback,
    firmware_compat_key: compat.firmware_compat_key,
    connectivity_note: compat.connectivity_note,
    board_layout: {},
    revision_notes: entry.revision_notes,
    last_synced_at: nowIso,
  };
}

export function buildGpioDefinitionRows(
  boardCatalogId: string,
  definitions: GpioPinDefinition[]
): Array<Record<string, unknown>> {
  return definitions.map((g) => ({
    board_catalog_id: boardCatalogId,
    pin: g.pin,
    label: g.label,
    board_pin_name: g.board_pin_name ?? null,
    header_side: g.header_side ?? null,
    header_position: g.header_position ?? null,
    board_note: g.board_note ?? null,
    capabilities: g.capabilities,
    restrictions: g.restrictions,
  }));
}

/** Espressif boards that are known but whose pin maps are not verified yet. */
export function collectUnverifiedEspressifDevkits(
  liveDiscovered: DiscoveredDevKitEntry[]
): Map<string, DiscoveredDevKitEntry> {
  const verifiedSlugs = new Set(VERIFIED_BOARD_CATALOG.map((b) => b.slug));
  const pool = new Map<string, DiscoveredDevKitEntry>();
  for (const item of [...CURATED_UNVERIFIED_ESPRESSIF_DEVKITS, ...liveDiscovered]) {
    if (verifiedSlugs.has(item.slug)) continue;
    if (!pool.has(item.slug)) pool.set(item.slug, item);
  }
  return pool;
}

export async function runOfficialCatalogSync(params: {
  db: DbClient;
  adminUserId?: string | null;
  syncFetch?: CustomFetch;
}): Promise<{
  runId: string | null;
  status: "succeeded" | "partial" | "failed";
  discoveredCount: number;
  insertedCount: number;
  updatedCount: number;
  needsVerificationCount: number;
  sourceUrls: string[];
  summaryNotes: string;
}> {
  const fetcher: CustomFetch = params.syncFetch ?? fetch;
  const startedAt = new Date().toISOString();
  const sourceUrls: string[] = [ESPRESSIF_DEVKITS_URL, ESP_BOARD_MANAGER_INDEX_URL];

  const live = await fetchEspressifLiveSources(fetcher);
  const fetchNotes = live.notes;
  const liveSuccessCount = live.liveSuccessCount;

  // Every row counts here, removed ones included: a slug stays unique after a
  // soft delete, and a board an admin removed must not come back on its own.
  const { data: allRows } = await params.db
    .from("board_catalog")
    .select("id,slug,firmware_status,is_available,verification_status,deleted_at");

  const rows = (allRows ?? []) as Array<{
    id: string;
    slug: string;
    firmware_status: string;
    is_available: boolean;
    verification_status: string;
    deleted_at: string | null;
  }>;
  const existingBySlug = new Map(rows.filter((r) => !r.deleted_at).map((r) => [r.slug, r]));
  const removedSlugs = new Set(rows.filter((r) => r.deleted_at).map((r) => r.slug));

  let insertedCount = 0;
  let updatedCount = 0;
  let needsVerificationCount = 0;
  let skippedRemovedCount = 0;
  const nowIso = new Date().toISOString();

  // 1. Upsert verified boards (preserve admin firmware_status overrides)
  for (const board of VERIFIED_BOARD_CATALOG) {
    if (removedSlugs.has(board.slug)) {
      skippedRemovedCount += 1;
      continue;
    }
    const existing = existingBySlug.get(board.slug);
    const payload = buildVerifiedCatalogRow(board, {
      isAvailable: existing ? existing.is_available : board.is_published,
      firmwareStatus: existing?.firmware_status ?? board.firmware_status,
      nowIso,
    });

    if (existing) {
      await params.db
        .from("board_catalog")
        .update(payload)
        .eq("id", existing.id);
      updatedCount += 1;
    } else {
      const { data: created } = await params.db
        .from("board_catalog")
        .insert(payload)
        .select("id")
        .single();
      const boardId = (created as { id?: string } | null)?.id;
      if (!boardId) continue;
      await params.db
        .from("board_gpio_definitions")
        .insert(buildGpioDefinitionRows(boardId, board.gpio_definitions));
      insertedCount += 1;
    }
  }

  // 2. Merge additional non-verified Espressif boards WITHOUT fabricating GPIO pinouts
  const unverifiedPool = collectUnverifiedEspressifDevkits(live.discovered);

  for (const entry of unverifiedPool.values()) {
    if (removedSlugs.has(entry.slug)) {
      skippedRemovedCount += 1;
      continue;
    }
    const existing = existingBySlug.get(entry.slug);
    if (existing) {
      await params.db
        .from("board_catalog")
        .update({
          image_url: entry.image_url,
          docs_url: entry.docs_url,
          source_url: entry.source_url,
          source_provider: entry.source_provider,
          last_synced_at: nowIso,
        })
        .eq("id", existing.id);
      if (existing.verification_status === "needs_verification") {
        needsVerificationCount += 1;
      }
      updatedCount += 1;
    } else {
      await params.db.from("board_catalog").insert(buildUnverifiedCatalogRow(entry, nowIso));
      insertedCount += 1;
      needsVerificationCount += 1;
    }
  }

  const discoveredCount = VERIFIED_BOARD_CATALOG.length + unverifiedPool.size;
  const status: "succeeded" | "partial" | "failed" =
    liveSuccessCount >= 1 ? "succeeded" : "partial";
  const summaryNotes = [
    ...fetchNotes,
    `Catalog synced: ${VERIFIED_BOARD_CATALOG.length} verified boards, ${needsVerificationCount} awaiting GPIO verification.`,
    ...(skippedRemovedCount > 0
      ? [
          `${skippedRemovedCount} board(s) removed by an admin were left out. Use Import Official Boards to restore them.`,
        ]
      : []),
  ].join(" · ");

  const { data: runRow } = await params.db
    .from("board_catalog_sync_runs")
    .insert({
      source_name: "Espressif Official Catalog & Board Manager",
      status,
      triggered_by_admin_id: params.adminUserId ?? null,
      discovered_count: discoveredCount,
      inserted_count: insertedCount,
      updated_count: updatedCount,
      needs_verification_count: needsVerificationCount,
      source_urls: sourceUrls,
      summary_notes: summaryNotes,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();

  return {
    runId: (runRow as { id?: string } | null)?.id ?? null,
    status,
    discoveredCount,
    insertedCount,
    updatedCount,
    needsVerificationCount,
    sourceUrls,
    summaryNotes,
  };
}
