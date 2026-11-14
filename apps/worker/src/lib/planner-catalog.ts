/**
 * Smart Home Planner — live catalog loader.
 *
 * Reads the boards and firmware releases administrators already manage through
 * the Board Library and Firmware Management pages, and hands them to the shared
 * rule engine. Nothing is copied, cached or hard-coded here: every analysis
 * starts from the rows that are in the database at that moment.
 *
 * Two rules keep this safe for customers:
 *   - Only the columns the engine needs are read. Private firmware storage keys
 *     (firmware_files.r2_key), file names, checksums, release notes and CI
 *     metadata never enter the planner, so they can never leave it.
 *   - A failed read is an error, never "no boards". The planner must not turn a
 *     database hiccup into a "not supported" recommendation.
 */
import {
  buildPlannerCatalogRevisionSource,
  type BoardCatalogCategory,
  type BoardFirmwareStatus,
  type BoardLayoutSpec,
  type GpioPinDefinition,
  type PlannerAccountContext,
  type PlannerBoardRecord,
  type PlannerCatalogSnapshot,
  type PlannerFirmwareFileRecord,
  type PlannerFirmwareReleaseRecord,
  type PlannerStageTracker,
} from "@homecoreos/shared";
import { sha256Hex } from "./crypto";
import type { DbClient } from "./db";

/** Raised when admin-managed data could not be read. Its message is safe to show. */
export class PlannerCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerCatalogError";
  }
}

type Row = Record<string, unknown>;

interface QueryResult {
  data: unknown;
  error: { message?: string } | null;
}

const GPIO_COLUMNS =
  "pin,label,board_pin_name,header_side,header_position,board_note,capabilities,restrictions";

const RELEASE_COLUMNS =
  "id,name,version,channel,chip_family,status,build_status,target_board_slug,compatible_board_ids,compatible_board_slugs,partition_scheme,psram_mode,flash_size_mb,hardware_verified,verified_board_ids,verified_board_slugs,ota_available,usb_available,published_at";

// Deliberately excludes r2_key, file_name, sha256 and size_bytes.
const FILE_COLUMNS = "release_id,file_type,validated,flash_size";

const FIRMWARE_STATUSES: readonly BoardFirmwareStatus[] = [
  "firmware_supported",
  "catalog_only",
  "build_pending",
  "unsupported",
];
const CATALOG_CATEGORIES: readonly BoardCatalogCategory[] = [
  "official_espressif",
  "partner",
  "custom",
];

function rows(result: QueryResult, what: string): Row[] {
  if (result.error) {
    console.error(`Smart Home Planner: reading ${what} failed:`, result.error.message);
    throw new PlannerCatalogError(`${what} could not be read. Please try again.`);
  }
  return Array.isArray(result.data) ? (result.data as Row[]) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function int(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function layout(value: unknown): BoardLayoutSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.keys(value as Row).length > 0 ? (value as BoardLayoutSpec) : null;
}

function toGpioDefinition(row: Row): GpioPinDefinition {
  return {
    pin: int(row.pin, -1),
    label: text(row.label) ?? `GPIO${int(row.pin, 0)}`,
    board_pin_name: text(row.board_pin_name),
    header_side: row.header_side === "left" || row.header_side === "right" ? row.header_side : null,
    header_position: nullableInt(row.header_position),
    board_note: text(row.board_note),
    capabilities: (row.capabilities ?? {}) as GpioPinDefinition["capabilities"],
    restrictions: (row.restrictions ?? {}) as GpioPinDefinition["restrictions"],
  };
}

function groupGpio(list: Row[], key: "board_catalog_id" | "custom_board_id"): Map<string, GpioPinDefinition[]> {
  const grouped = new Map<string, GpioPinDefinition[]>();
  for (const row of list) {
    const owner = text(row[key]);
    if (!owner) continue;
    const pins = grouped.get(owner) ?? [];
    pins.push(toGpioDefinition(row));
    grouped.set(owner, pins);
  }
  for (const pins of grouped.values()) pins.sort((a, b) => a.pin - b.pin);
  return grouped;
}

function sharedBoardFields(row: Row) {
  return {
    id: String(row.id),
    slug: text(row.slug) ?? String(row.id),
    manufacturer: text(row.manufacturer) ?? "",
    model: text(row.model) ?? "",
    revision: text(row.revision) ?? "",
    chip_family: text(row.chip_family) ?? "",
    chip_variant: text(row.chip_variant) ?? "",
    flash_size_mb: int(row.flash_size_mb, 0),
    psram_size_mb: int(row.psram_size_mb, 0),
    partition_scheme: text(row.partition_scheme),
    psram_mode: text(row.psram_mode),
    flash_mode: text(row.flash_mode),
    flash_freq: text(row.flash_freq),
    bootloader_offset: text(row.bootloader_offset),
    ota_app_offset: text(row.ota_app_offset),
    boot_button_gpio: nullableInt(row.boot_button_gpio),
    usb_interface: text(row.usb_interface),
    supports_wifi: flag(row.supports_wifi),
    supports_ble: flag(row.supports_ble),
    supports_ble_wifi_provisioning: flag(row.supports_ble_wifi_provisioning),
    supports_ota_rollback: flag(row.supports_ota_rollback),
    firmware_compat_key: text(row.firmware_compat_key),
    connectivity_note: text(row.connectivity_note),
    board_layout: layout(row.board_layout),
    docs_url: text(row.docs_url),
  };
}

function toCatalogBoard(row: Row, gpio: GpioPinDefinition[]): PlannerBoardRecord {
  const firmwareStatus = FIRMWARE_STATUSES.find((s) => s === row.firmware_status) ?? null;
  return {
    ...sharedBoardFields(row),
    source: "catalog",
    is_available: row.is_available === true,
    // Anything other than an explicit "verified" is treated as unverified.
    verification_status: row.verification_status === "verified" ? "verified" : "needs_verification",
    firmware_status: firmwareStatus,
    catalog_category: CATALOG_CATEGORIES.find((c) => c === row.catalog_category) ?? null,
    gpio_definitions: gpio,
  };
}

function toCustomBoard(row: Row, gpio: GpioPinDefinition[]): PlannerBoardRecord {
  return {
    ...sharedBoardFields(row),
    source: "custom",
    is_available: false,
    verification_status: null,
    firmware_status: "custom",
    catalog_category: "custom",
    gpio_definitions: gpio,
  };
}

export interface PlannerBoardData {
  boards: PlannerBoardRecord[];
  boardCatalogEnabled: boolean;
  account: PlannerAccountContext;
}

/**
 * Every non-deleted Board Library row (published or not, verified or not), the
 * account's own custom boards, and the account limits the platform enforces.
 * Unpublished and unverified boards are read on purpose: the engine reports
 * their status instead of pretending they do not exist, and never offers them
 * as ready.
 */
export async function loadPlannerBoards(db: DbClient, accountId: string): Promise<PlannerBoardData> {
  const [settingsRes, catalogRes, customRes, catalogGpioRes, controllersRes, devicesRes] =
    await Promise.all([
      db
        .from("platform_settings")
        .select("board_catalog_enabled,max_controllers_per_account,max_devices_per_account")
        .eq("id", 1)
        .maybeSingle(),
      db.from("board_catalog").select("*").is("deleted_at", null),
      db.from("custom_boards").select("*").eq("account_id", accountId).is("deleted_at", null),
      db
        .from("board_gpio_definitions")
        .select(`board_catalog_id,${GPIO_COLUMNS}`)
        .not("board_catalog_id", "is", null)
        .order("pin", { ascending: true }),
      db
        .from("controllers")
        .select("id", { count: "exact", head: true })
        .eq("account_id", accountId)
        .is("deleted_at", null),
      db
        .from("devices")
        .select("id", { count: "exact", head: true })
        .eq("account_id", accountId)
        .is("deleted_at", null),
    ]);

  if (settingsRes.error) {
    console.error("Smart Home Planner: reading platform settings failed:", settingsRes.error.message);
    throw new PlannerCatalogError("Platform settings could not be read. Please try again.");
  }
  if (controllersRes.error || devicesRes.error) {
    throw new PlannerCatalogError("Your account's controllers could not be read. Please try again.");
  }

  const catalogRows = rows(catalogRes, "The Board Library");
  const customRows = rows(customRes, "Your custom boards");
  const catalogGpio = groupGpio(rows(catalogGpioRes, "The Board Library pin maps"), "board_catalog_id");

  let customGpio = new Map<string, GpioPinDefinition[]>();
  if (customRows.length > 0) {
    const customGpioRes = await db
      .from("board_gpio_definitions")
      .select(`custom_board_id,${GPIO_COLUMNS}`)
      .in(
        "custom_board_id",
        customRows.map((row) => String(row.id))
      )
      .order("pin", { ascending: true });
    customGpio = groupGpio(rows(customGpioRes, "Your custom board pin maps"), "custom_board_id");
  }

  const settings = (settingsRes.data ?? null) as Row | null;

  return {
    boards: [
      ...catalogRows.map((row) => toCatalogBoard(row, catalogGpio.get(String(row.id)) ?? [])),
      ...customRows.map((row) => toCustomBoard(row, customGpio.get(String(row.id)) ?? [])),
    ],
    boardCatalogEnabled: settings?.board_catalog_enabled !== false,
    account: {
      existingControllers: controllersRes.count ?? 0,
      existingDevices: devicesRes.count ?? 0,
      // Same fallbacks the pairing and device routes enforce.
      maxControllers: int(settings?.max_controllers_per_account, 25),
      maxDevices: int(settings?.max_devices_per_account, 100),
    },
  };
}

/**
 * Every non-deleted firmware release in any lifecycle state, with the artifact
 * rows that prove a USB or OTA image really exists.
 */
export async function loadPlannerFirmware(db: DbClient): Promise<PlannerFirmwareReleaseRecord[]> {
  const [releasesRes, filesRes] = await Promise.all([
    db.from("firmware_releases").select(RELEASE_COLUMNS).is("deleted_at", null),
    db.from("firmware_files").select(FILE_COLUMNS),
  ]);

  const releaseRows = rows(releasesRes, "Firmware releases");
  const fileRows = rows(filesRes, "Firmware artifacts");

  const filesByRelease = new Map<string, PlannerFirmwareFileRecord[]>();
  for (const file of fileRows) {
    const releaseId = text(file.release_id);
    const fileType = text(file.file_type);
    if (!releaseId || !fileType) continue;
    const list = filesByRelease.get(releaseId) ?? [];
    list.push({
      file_type: fileType,
      validated: file.validated === true,
      flash_size: text(file.flash_size),
    });
    filesByRelease.set(releaseId, list);
  }

  return releaseRows.map((row) => ({
    id: String(row.id),
    name: text(row.name) ?? "",
    version: text(row.version) ?? "",
    channel: text(row.channel) ?? "",
    chip_family: text(row.chip_family) ?? "",
    status: text(row.status) ?? "",
    build_status: text(row.build_status),
    target_board_slug: text(row.target_board_slug),
    compatible_board_ids: stringList(row.compatible_board_ids),
    compatible_board_slugs: stringList(row.compatible_board_slugs),
    partition_scheme: text(row.partition_scheme),
    psram_mode: text(row.psram_mode),
    flash_size_mb: nullableInt(row.flash_size_mb),
    hardware_verified: row.hardware_verified === true,
    verified_board_ids: stringList(row.verified_board_ids),
    verified_board_slugs: stringList(row.verified_board_slugs),
    ota_available: row.ota_available === true,
    usb_available: row.usb_available === true,
    published_at: text(row.published_at),
    files: filesByRelease.get(String(row.id)) ?? [],
  }));
}

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function describeBoards(data: PlannerBoardData): string {
  const catalog = data.boards.filter((b) => b.source === "catalog").length;
  const custom = data.boards.length - catalog;
  const parts = [
    data.boardCatalogEnabled
      ? `${count(catalog, "board", "boards")} in the Board Library`
      : "The Board Library is switched off by the administrator",
  ];
  if (custom > 0) parts.push(count(custom, "custom board", "custom boards"));
  return parts.join(", ");
}

function describeFirmware(releases: PlannerFirmwareReleaseRecord[]): string {
  const published = releases.filter((r) => r.status === "published").length;
  return `${count(releases.length, "firmware release", "firmware releases")} on record, ${published} published`;
}

/**
 * Loads boards and firmware side by side and fingerprints them. When a tracker
 * is supplied, the two loading stages are reported as they really start and
 * finish, so the customer's progress display reflects the actual reads.
 */
export async function loadPlannerCatalog(
  db: DbClient,
  accountId: string,
  tracker?: PlannerStageTracker
): Promise<PlannerCatalogSnapshot> {
  tracker?.start("load_boards");
  tracker?.start("load_firmware");

  const [boardsOutcome, firmwareOutcome] = await Promise.allSettled([
    loadPlannerBoards(db, accountId).then((data) => {
      tracker?.complete("load_boards", describeBoards(data));
      return data;
    }),
    loadPlannerFirmware(db).then((releases) => {
      tracker?.complete("load_firmware", describeFirmware(releases));
      return releases;
    }),
  ]);

  if (boardsOutcome.status === "rejected") {
    tracker?.fail("load_boards", "The Board Library could not be read");
  }
  if (firmwareOutcome.status === "rejected") {
    tracker?.fail("load_firmware", "Firmware releases could not be read");
  }
  if (boardsOutcome.status === "rejected") throw boardsOutcome.reason;
  if (firmwareOutcome.status === "rejected") throw firmwareOutcome.reason;

  const snapshot = {
    boards: boardsOutcome.value.boards,
    releases: firmwareOutcome.value,
    boardCatalogEnabled: boardsOutcome.value.boardCatalogEnabled,
    account: boardsOutcome.value.account,
  };

  return {
    ...snapshot,
    revision: await sha256Hex(buildPlannerCatalogRevisionSource(snapshot)),
  };
}
