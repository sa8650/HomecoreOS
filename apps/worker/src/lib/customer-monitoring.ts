import {
  compareFirmwareVersions,
  getSensorDriverForMeasurement,
  isNewerFirmwareVersion,
  normalizeBoardRole,
  normalizeNodeLinkState,
  resolveBoardFirmwareCompatibility,
} from "@homecoreos/shared";
import type { DbClient } from "./db";
import {
  checkControllerReleaseCompatibility,
  type CompatBoardRecord,
} from "./firmware-compatibility";
import { getControllerSensorCompatibilityReport } from "./sensor-compatibility";

/**
 * Admin Customer Board & Device Monitoring — read-only health rules.
 *
 * This module is the single source of truth for how an administrator-facing
 * health verdict is derived from real telemetry. It never marks a board
 * Healthy merely because a row exists in the database: a Healthy verdict
 * requires fresh heartbeat telemetry, an online status, a connected MQTT
 * session and no outstanding warnings. Missing telemetry is reported as
 * Unknown, never as a confirmed failure and never as Healthy.
 *
 * All functions here are pure (except the `load*` helpers at the bottom,
 * which only SELECT). Nothing in this file publishes MQTT, calls EMQX, or
 * writes to the database.
 */

export type BoardHealthStatus = "healthy" | "warning" | "offline" | "unknown";

export interface BoardEntityCounts {
  devices: number;
  devicesOnline: number;
  sensors: number;
  sensorsOnline: number;
  /** Sensors with no reading, or a reading older than the stale threshold. */
  sensorsStale: number;
  switches: number;
  switchesOnline: number;
}

export interface BoardHealthInput {
  status: string | null | undefined;
  pairingStatus?: string | null;
  lastHeartbeatAt?: string | null;
  lastCommunicationAt?: string | null;
  mqttConnected?: boolean | null;
  wifiConnected?: boolean | null;
  /** MQTT credential status from mqtt_credentials_metadata, when known. */
  mqttStatus?: string | null;
  pendingConfigSync?: boolean | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
  firmwareVersion?: string | null;
  /** Newer compatible published OTA release, when one was found. */
  availableUpdateVersion?: string | null;
  boardRole?: string | null;
  nodeLinkState?: string | null;
  counts?: Partial<BoardEntityCounts> | null;
  /** Injectable clock for tests. Defaults to Date.now(). */
  nowMs?: number;
  /** From platform_settings.controller_offline_timeout_seconds. */
  offlineTimeoutSeconds?: number;
}

export interface BoardHealth {
  status: BoardHealthStatus;
  /** Human-readable reasons backing the verdict. Empty only when Healthy. */
  reasons: string[];
  telemetry: {
    hasTelemetry: boolean;
    heartbeatAgeSeconds: number | null;
    communicationAgeSeconds: number | null;
    heartbeatFresh: boolean;
    offlineTimeoutSeconds: number;
    sensorStaleSeconds: number;
  };
}

export const DEFAULT_OFFLINE_TIMEOUT_SECONDS = 180;
export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;
/**
 * A sensor is stale when it has never reported, or its last reading is older
 * than this. The effective threshold is max(15 minutes, 5x offline timeout)
 * so slow-reporting sensors are not flagged on the same cadence as heartbeats.
 */
export const SENSOR_STALE_FLOOR_SECONDS = 15 * 60;
/** Errors older than this no longer degrade health on their own. */
export const RECENT_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000;

function ageSeconds(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((nowMs - ms) / 1000));
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function sensorStaleThresholdSeconds(offlineTimeoutSeconds: number): number {
  return Math.max(SENSOR_STALE_FLOOR_SECONDS, offlineTimeoutSeconds * 5);
}

export function computeBoardHealth(input: BoardHealthInput): BoardHealth {
  const nowMs = input.nowMs ?? Date.now();
  const offlineTimeoutSeconds =
    typeof input.offlineTimeoutSeconds === "number" &&
    Number.isFinite(input.offlineTimeoutSeconds) &&
    input.offlineTimeoutSeconds > 0
      ? Math.round(input.offlineTimeoutSeconds)
      : DEFAULT_OFFLINE_TIMEOUT_SECONDS;
  const sensorStaleSeconds = sensorStaleThresholdSeconds(offlineTimeoutSeconds);

  const heartbeatAge = ageSeconds(input.lastHeartbeatAt, nowMs);
  const communicationAge = ageSeconds(input.lastCommunicationAt, nowMs);
  const hasTelemetry = heartbeatAge !== null || communicationAge !== null;
  const heartbeatFresh =
    heartbeatAge !== null && heartbeatAge <= offlineTimeoutSeconds;

  const telemetry: BoardHealth["telemetry"] = {
    hasTelemetry,
    heartbeatAgeSeconds: heartbeatAge,
    communicationAgeSeconds: communicationAge,
    heartbeatFresh,
    offlineTimeoutSeconds,
    sensorStaleSeconds,
  };

  const status = (input.status ?? "").trim().toLowerCase();
  const counts: BoardEntityCounts = {
    devices: input.counts?.devices ?? 0,
    devicesOnline: input.counts?.devicesOnline ?? 0,
    sensors: input.counts?.sensors ?? 0,
    sensorsOnline: input.counts?.sensorsOnline ?? 0,
    sensorsStale: input.counts?.sensorsStale ?? 0,
    switches: input.counts?.switches ?? 0,
    switchesOnline: input.counts?.switchesOnline ?? 0,
  };

  // --- Confirmed offline states (recorded by the device / stale sweeper) ---
  if (status === "offline" || status === "disconnected") {
    const reasons = [
      `Board reports "${status}"${
        heartbeatAge !== null
          ? `; last heartbeat ${formatAge(heartbeatAge)}`
          : "; no heartbeat telemetry recorded"
      }.`,
    ];
    if (input.mqttStatus === "revoked") {
      reasons.push("MQTT credentials are revoked.");
    }
    return { status: "offline", reasons, telemetry };
  }

  // --- Transitional states: degraded, but not a confirmed failure ---
  if (status === "reset_pending") {
    return {
      status: "warning",
      reasons: ["Board is in reset_pending (transitional state)."],
      telemetry,
    };
  }
  if (status === "updating") {
    return {
      status: "warning",
      reasons: ["Board is updating firmware (transitional state)."],
      telemetry,
    };
  }

  // --- Never paired / no recorded state: telemetry is unavailable ---
  if (status === "pending" || status === "") {
    if (!hasTelemetry) {
      return {
        status: "unknown",
        reasons: [
          "No heartbeat or communication telemetry recorded; board has not reported since registration.",
        ],
        telemetry,
      };
    }
    return {
      status: "warning",
      reasons: [
        `Board is not paired yet (status "${status || "unknown"}") but telemetry exists (last communication ${formatAge(communicationAge)}).`,
      ],
      telemetry,
    };
  }

  if (status !== "online") {
    return {
      status: "unknown",
      reasons: [`Unrecognised board status "${status}"; health cannot be determined.`],
      telemetry,
    };
  }

  // --- Online: health must be proven by fresh telemetry ---
  if (!hasTelemetry) {
    return {
      status: "unknown",
      reasons: [
        "Board is marked online but no heartbeat or communication telemetry is available; health cannot be confirmed.",
      ],
      telemetry,
    };
  }

  if (heartbeatAge === null) {
    return {
      status: "warning",
      reasons: [
        `No heartbeat timestamp; last communication ${formatAge(communicationAge)}. Heartbeat telemetry is incomplete.`,
      ],
      telemetry,
    };
  }

  if (!heartbeatFresh) {
    return {
      status: "offline",
      reasons: [
        `Heartbeat is stale: last heartbeat ${formatAge(heartbeatAge)} exceeds the ${offlineTimeoutSeconds}s offline timeout.`,
      ],
      telemetry,
    };
  }

  // Fresh heartbeat: collect warnings. Any warning degrades Healthy -> Warning.
  const warnings: string[] = [];

  if (input.mqttStatus === "revoked") {
    warnings.push("MQTT credentials are revoked.");
  } else if (input.mqttConnected === false) {
    warnings.push("MQTT is not connected.");
  }
  if (input.wifiConnected === false) {
    warnings.push("Wi-Fi is not connected.");
  }
  if (input.pendingConfigSync === true) {
    warnings.push("Configuration sync is pending (board has not acknowledged the latest config revision).");
  }
  if (input.lastError && input.lastError.trim()) {
    const errorAgeMs =
      input.lastErrorAt && Number.isFinite(Date.parse(input.lastErrorAt))
        ? nowMs - Date.parse(input.lastErrorAt)
        : null;
    if (errorAgeMs === null || errorAgeMs <= RECENT_ERROR_WINDOW_MS) {
      warnings.push(`Recent board error: ${input.lastError.trim().slice(0, 200)}`);
    }
  }
  if (!input.firmwareVersion || !input.firmwareVersion.trim()) {
    warnings.push("Firmware version has not been reported by the board.");
  } else if (input.availableUpdateVersion) {
    warnings.push(`Firmware update available: v${input.availableUpdateVersion} (running v${input.firmwareVersion}).`);
  }

  const role = normalizeBoardRole(input.boardRole);
  if (role === "node") {
    const link = normalizeNodeLinkState(input.nodeLinkState);
    if (link === "controller_lost") {
      warnings.push("Node has lost its assigned Controller (ESP-NOW link lost).");
    } else if (link === "reconnecting") {
      warnings.push("Node is reconnecting to its assigned Controller.");
    } else if (link === "unassigned") {
      warnings.push("Node has no assigned Controller.");
    } else if (link === "standalone") {
      warnings.push("Node is running standalone on Wi-Fi/MQTT without its Controller.");
    }
  }

  if (counts.devices > 0 && counts.devicesOnline < counts.devices) {
    warnings.push(
      `${counts.devices - counts.devicesOnline} of ${counts.devices} device(s) offline.`
    );
  }
  if (counts.sensors > 0 && counts.sensorsOnline < counts.sensors) {
    warnings.push(
      `${counts.sensors - counts.sensorsOnline} of ${counts.sensors} sensor(s) offline.`
    );
  }
  if (counts.sensors > 0 && counts.sensorsStale > 0) {
    warnings.push(
      `${counts.sensorsStale} sensor(s) stale (no reading within ${Math.round(sensorStaleSeconds / 60)}m).`
    );
  }
  if (counts.switches > 0 && counts.switchesOnline < counts.switches) {
    warnings.push(
      `${counts.switches - counts.switchesOnline} of ${counts.switches} switch(es) offline.`
    );
  }

  if (warnings.length > 0) {
    return { status: "warning", reasons: warnings, telemetry };
  }
  return { status: "healthy", reasons: [], telemetry };
}

/**
 * Customer-level verdict from per-board verdicts. Mixed environments are
 * Warning (degraded), never Healthy: one unhealthy board degrades the whole
 * environment, and Unknown boards can never be averaged into Healthy.
 */
export function computeCustomerHealth(boardStatuses: BoardHealthStatus[]): {
  status: BoardHealthStatus;
  counts: Record<BoardHealthStatus, number>;
} {
  const counts: Record<BoardHealthStatus, number> = {
    healthy: 0,
    warning: 0,
    offline: 0,
    unknown: 0,
  };
  for (const s of boardStatuses) counts[s] += 1;

  if (boardStatuses.length === 0) return { status: "unknown", counts };
  if (counts.healthy === boardStatuses.length) return { status: "healthy", counts };
  if (counts.offline === boardStatuses.length) return { status: "offline", counts };
  if (counts.unknown === boardStatuses.length) return { status: "unknown", counts };
  return { status: "warning", counts };
}

// ---------------------------------------------------------------------------
// Read-only DB loaders (SELECT only). Every query is scoped by account_id so
// one customer's data can never leak into another customer's page.
// ---------------------------------------------------------------------------

export interface MonitoringPagination {
  page: number;
  pageSize: number;
}

export function parsePagination(
  searchParams: URLSearchParams,
  defaultPageSize = 25,
  maxPageSize = 100
): MonitoringPagination {
  const rawPage = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const rawSize = Number.parseInt(
    searchParams.get("pageSize") ?? String(defaultPageSize),
    10
  );
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize =
    Number.isFinite(rawSize) && rawSize >= 1
      ? Math.min(rawSize, maxPageSize)
      : defaultPageSize;
  return { page, pageSize };
}

export function paginationMeta(total: number, pagination: MonitoringPagination) {
  const totalPages = Math.max(1, Math.ceil(total / pagination.pageSize));
  return {
    page: pagination.page,
    pageSize: pagination.pageSize,
    total,
    totalPages,
    hasNext: pagination.page < totalPages,
    hasPrev: pagination.page > 1,
  };
}

type BoardRow = Record<string, unknown> & {
  id: string;
  account_id: string;
  name: string;
  status: string;
  firmware_version: string | null;
  board_profile_id: string | null;
  custom_board_profile_id: string | null;
  installed_firmware_release_id: string | null;
  room_id: string | null;
  home_id: string | null;
  assigned_controller_id: string | null;
};

export interface EnrichedBoard extends BoardRow {
  board_profile: Record<string, unknown> | null;
  custom_board_profile: Record<string, unknown> | null;
  /** Resolved hardware record used for firmware compatibility checks. */
  compatBoard: CompatBoardRecord | null;
  room_name: string | null;
  home_name: string | null;
  mqtt: {
    mqtt_username: string;
    mqtt_client_id: string;
    topic_prefix: string;
    emqx_synced: boolean;
    status: string;
    last_rotated_at: string | null;
  } | null;
  installed_release: {
    id: string;
    name: string;
    version: string;
    channel: string;
    status: string;
    published_at: string | null;
  } | null;
  available_update: {
    id: string;
    name: string;
    version: string;
    channel: string;
    published_at: string | null;
  } | null;
  counts: BoardEntityCounts;
  attached_node_count: number;
  assigned_controller_name: string | null;
  health: BoardHealth;
}

async function fetchPlatformHealthSettings(db: DbClient) {
  const { data } = await db
    .from("platform_settings")
    .select("controller_offline_timeout_seconds,controller_heartbeat_interval_seconds")
    .eq("id", 1)
    .maybeSingle();
  const row = data as {
    controller_offline_timeout_seconds?: number | null;
    controller_heartbeat_interval_seconds?: number | null;
  } | null;
  return {
    offlineTimeoutSeconds:
      row?.controller_offline_timeout_seconds ?? DEFAULT_OFFLINE_TIMEOUT_SECONDS,
    heartbeatIntervalSeconds:
      row?.controller_heartbeat_interval_seconds ?? DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  };
}

export async function loadAccountForMonitoring(
  db: DbClient,
  accountId: string
): Promise<{
  account: Record<string, unknown> & { id: string; owner_user_id: string };
  owner: { id: string; email: string; full_name: string; created_at: string | null } | null;
} | null> {
  const { data } = await db
    .from("accounts")
    .select("*")
    .eq("id", accountId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const account = data as Record<string, unknown> & { id: string; owner_user_id: string };

  let owner: { id: string; email: string; full_name: string; created_at: string | null } | null =
    null;
  if (account.owner_user_id) {
    const { data: user } = await db
      .from("users")
      .select("id,email,full_name,created_at")
      .eq("id", account.owner_user_id)
      .maybeSingle();
    owner = (user as typeof owner) ?? null;
  }
  return { account, owner };
}

interface OtaReleaseRow {
  id: string;
  name: string;
  version: string;
  channel: string;
  chip_family: string;
  status: string | null;
  target_board_slug: string | null;
  compatible_board_ids: string[] | null;
  compatible_board_slugs: string[] | null;
  partition_scheme: string | null;
  psram_mode: string | null;
  flash_size_mb: number | null;
  published_at: string | null;
}

async function loadPublishedOtaReleases(db: DbClient): Promise<OtaReleaseRow[]> {
  const { data } = await db
    .from("firmware_releases")
    .select(
      "id,name,version,channel,chip_family,status,target_board_slug,compatible_board_ids,compatible_board_slugs,partition_scheme,psram_mode,flash_size_mb,published_at"
    )
    .eq("status", "published")
    .eq("ota_available", true)
    .is("deleted_at", null)
    .order("published_at", { ascending: false });
  const releases = ((data ?? []) as OtaReleaseRow[]) ?? [];
  if (releases.length === 0) return releases;

  const { data: files } = await db
    .from("firmware_files")
    .select("release_id,flash_size")
    .in(
      "release_id",
      releases.map((r) => r.id)
    )
    .eq("file_type", "ota_app");
  const filesByRelease = new Map<string, Array<{ flash_size?: string | null }>>();
  for (const f of (files ?? []) as Array<{ release_id: string; flash_size?: string | null }>) {
    const list = filesByRelease.get(f.release_id) ?? [];
    list.push(f);
    filesByRelease.set(f.release_id, list);
  }
  // Releases without an OTA artifact cannot be offered as an update.
  return releases.filter((r) => (filesByRelease.get(r.id)?.length ?? 0) > 0).map((r) => ({
    ...r,
    // Stash OTA file flash sizes on the row for the compat check below via a
    // non-enumerable-free extra field consumed only in this module.
    ...( { _otaFiles: filesByRelease.get(r.id) ?? [] } as unknown as Record<string, unknown>),
  })) as OtaReleaseRow[];
}

function findAvailableUpdate(
  compatBoard: CompatBoardRecord | null,
  firmwareVersion: string | null,
  otaReleases: OtaReleaseRow[]
): EnrichedBoard["available_update"] {
  if (!compatBoard || !otaReleases.length) return null;
  const compatibleNewer = otaReleases
    .filter((rel) => {
      const files = (rel as unknown as { _otaFiles?: Array<{ flash_size?: string | null }> })._otaFiles;
      const compat = checkControllerReleaseCompatibility({
        board: compatBoard,
        release: { ...rel, files: files ?? [] },
        requirePublished: true,
      });
      if (!compat.compatible) return false;
      return isNewerFirmwareVersion(rel.version, firmwareVersion);
    })
    .sort((a, b) => compareFirmwareVersions(b.version, a.version));
  const best = compatibleNewer[0];
  if (!best) return null;
  return {
    id: best.id,
    name: best.name,
    version: best.version,
    channel: best.channel,
    published_at: best.published_at,
  };
}

/**
 * Batch-enriches a page of board rows. Bounded queries: one per related
 * table (profiles, rooms, homes, MQTT creds, releases, entities, nodes),
 * never one per board.
 */
export async function enrichBoards(
  db: DbClient,
  boards: BoardRow[],
  opts: {
    offlineTimeoutSeconds: number;
    otaReleases: OtaReleaseRow[];
    nowMs?: number;
  }
): Promise<EnrichedBoard[]> {
  if (boards.length === 0) return [];
  const boardIds = boards.map((b) => b.id);
  const catalogIds = Array.from(
    new Set(boards.map((b) => b.board_profile_id).filter(Boolean) as string[])
  );
  const customIds = Array.from(
    new Set(boards.map((b) => b.custom_board_profile_id).filter(Boolean) as string[])
  );
  const roomIds = Array.from(
    new Set(boards.map((b) => b.room_id).filter(Boolean) as string[])
  );
  const homeIds = Array.from(
    new Set(boards.map((b) => b.home_id).filter(Boolean) as string[])
  );
  const releaseIds = Array.from(
    new Set(
      boards.map((b) => b.installed_firmware_release_id).filter(Boolean) as string[]
    )
  );
  const parentIds = Array.from(
    new Set(boards.map((b) => b.assigned_controller_id).filter(Boolean) as string[])
  );

  const [
    catalogRes,
    customRes,
    roomsRes,
    homesRes,
    credsRes,
    releasesRes,
    devicesRes,
    sensorsRes,
    switchesRes,
    attachedRes,
    parentsRes,
  ] = await Promise.all([
    catalogIds.length > 0
      ? db
          .from("board_profiles")
          .select(
            "id,slug,manufacturer,model,revision,chip_family,chip_variant,flash_size_mb,psram_size_mb,firmware_status,verification_status,catalog_category,partition_scheme,psram_mode,flash_mode,flash_freq,bootloader_offset,ota_app_offset,boot_button_gpio,usb_interface,supports_wifi,supports_ble,supports_ble_wifi_provisioning,supports_ota_rollback,firmware_compat_key,connectivity_note"
          )
          .in("id", catalogIds)
      : Promise.resolve({ data: [] as unknown[] }),
    customIds.length > 0
      ? db
          .from("custom_board_profiles")
          .select(
            "id,slug,manufacturer,model,revision,chip_family,chip_variant,flash_size_mb,psram_size_mb,partition_scheme,psram_mode,flash_mode,flash_freq,bootloader_offset,ota_app_offset,boot_button_gpio,usb_interface,supports_wifi,supports_ble,supports_ble_wifi_provisioning,supports_ota_rollback,firmware_compat_key,connectivity_note"
          )
          .in("id", customIds)
      : Promise.resolve({ data: [] as unknown[] }),
    roomIds.length > 0
      ? db.from("rooms").select("id,name").in("id", roomIds)
      : Promise.resolve({ data: [] as unknown[] }),
    homeIds.length > 0
      ? db.from("homes").select("id,name").in("id", homeIds)
      : Promise.resolve({ data: [] as unknown[] }),
    db
      .from("mqtt_credentials_metadata")
      .select(
        "board_instance_id,mqtt_username,mqtt_client_id,topic_prefix,emqx_synced,status,last_rotated_at"
      )
      .in("board_instance_id", boardIds),
    releaseIds.length > 0
      ? db
          .from("firmware_releases")
          .select("id,name,version,channel,status,published_at")
          .in("id", releaseIds)
      : Promise.resolve({ data: [] as unknown[] }),
    db
      .from("devices")
      .select("board_instance_id,is_online,state")
      .in("board_instance_id", boardIds)
      .is("deleted_at", null),
    db
      .from("sensors")
      .select("board_instance_id,is_online,last_reading_at")
      .in("board_instance_id", boardIds)
      .is("deleted_at", null),
    db
      .from("switches")
      .select("board_instance_id,is_online")
      .in("board_instance_id", boardIds)
      .is("deleted_at", null),
    db
      .from("board_instances")
      .select("id,assigned_controller_id,status,board_role,node_link_state")
      .in("assigned_controller_id", boardIds)
      .is("deleted_at", null)
      .is("permanently_deleted_at", null),
    parentIds.length > 0
      ? db.from("board_instances").select("id,name").in("id", parentIds)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);

  const catalogById = new Map<string, Record<string, unknown>>();
  for (const row of (catalogRes.data ?? []) as Array<Record<string, unknown>>) {
    catalogById.set(String(row.id), row);
  }
  const customById = new Map<string, Record<string, unknown>>();
  for (const row of (customRes.data ?? []) as Array<Record<string, unknown>>) {
    customById.set(String(row.id), row);
  }
  const roomById = new Map(
    ((roomsRes.data ?? []) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name])
  );
  const homeById = new Map(
    ((homesRes.data ?? []) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name])
  );
  const credByBoard = new Map(
    (
      (credsRes.data ?? []) as Array<{
        board_instance_id: string;
        mqtt_username: string;
        mqtt_client_id: string;
        topic_prefix: string;
        emqx_synced: boolean;
        status: string;
        last_rotated_at: string | null;
      }>
    ).map((m) => [m.board_instance_id, m])
  );
  const releaseById = new Map(
    (
      (releasesRes.data ?? []) as Array<{
        id: string;
        name: string;
        version: string;
        channel: string;
        status: string;
        published_at: string | null;
      }>
    ).map((r) => [r.id, r])
  );
  const parentNameById = new Map(
    ((parentsRes.data ?? []) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name])
  );

  const nowMs = opts.nowMs ?? Date.now();
  const sensorStaleSeconds = sensorStaleThresholdSeconds(opts.offlineTimeoutSeconds);

  const countsByBoard = new Map<string, BoardEntityCounts>();
  const ensureCounts = (id: string): BoardEntityCounts => {
    let entry = countsByBoard.get(id);
    if (!entry) {
      entry = {
        devices: 0,
        devicesOnline: 0,
        sensors: 0,
        sensorsOnline: 0,
        sensorsStale: 0,
        switches: 0,
        switchesOnline: 0,
      };
      countsByBoard.set(id, entry);
    }
    return entry;
  };
  for (const d of (devicesRes.data ?? []) as Array<{
    board_instance_id: string;
    is_online: boolean;
  }>) {
    const c = ensureCounts(d.board_instance_id);
    c.devices += 1;
    if (d.is_online) c.devicesOnline += 1;
  }
  for (const s of (sensorsRes.data ?? []) as Array<{
    board_instance_id: string;
    is_online: boolean;
    last_reading_at: string | null;
  }>) {
    const c = ensureCounts(s.board_instance_id);
    c.sensors += 1;
    if (s.is_online) c.sensorsOnline += 1;
    const age = ageSeconds(s.last_reading_at, nowMs);
    if (age === null || age > sensorStaleSeconds) c.sensorsStale += 1;
  }
  for (const s of (switchesRes.data ?? []) as Array<{
    board_instance_id: string;
    is_online: boolean;
  }>) {
    const c = ensureCounts(s.board_instance_id);
    c.switches += 1;
    if (s.is_online) c.switchesOnline += 1;
  }

  const attachedNodeCount = new Map<string, number>();
  for (const node of (attachedRes.data ?? []) as Array<{
    assigned_controller_id: string | null;
    status: string;
    board_role: string | null;
    node_link_state: string | null;
  }>) {
    if (!node.assigned_controller_id) continue;
    if (normalizeBoardRole(node.board_role) !== "node") continue;
    if (normalizeNodeLinkState(node.node_link_state) !== "linked") continue;
    if (node.status !== "online") continue;
    attachedNodeCount.set(
      node.assigned_controller_id,
      (attachedNodeCount.get(node.assigned_controller_id) ?? 0) + 1
    );
  }

  return boards.map((board) => {
    const catalogRow = board.board_profile_id
      ? (catalogById.get(board.board_profile_id) ?? null)
      : null;
    const customRow = board.custom_board_profile_id
      ? (customById.get(board.custom_board_profile_id) ?? null)
      : null;
    const rawCompat = (catalogRow ?? customRow) as CompatBoardRecord | null;
    const compatBoard: CompatBoardRecord | null = rawCompat
      ? {
          ...rawCompat,
          ...resolveBoardFirmwareCompatibility(rawCompat),
          ...(customRow ? { firmware_status: "custom" } : {}),
        }
      : null;

    const mqtt = credByBoard.get(board.id) ?? null;
    const availableUpdate = findAvailableUpdate(
      compatBoard,
      board.firmware_version,
      opts.otaReleases
    );
    const counts = ensureCounts(board.id);
    const health = computeBoardHealth({
      status: board.status,
      pairingStatus: (board.pairing_status as string | null) ?? null,
      lastHeartbeatAt: (board.last_heartbeat_at as string | null) ?? null,
      lastCommunicationAt: (board.last_communication_at as string | null) ?? null,
      mqttConnected: (board.mqtt_connected as boolean | null) ?? null,
      wifiConnected: (board.wifi_connected as boolean | null) ?? null,
      mqttStatus: mqtt?.status ?? null,
      pendingConfigSync: (board.pending_config_sync as boolean | null) ?? null,
      lastError: (board.last_error as string | null) ?? null,
      lastErrorAt: (board.last_error_at as string | null) ?? null,
      firmwareVersion: board.firmware_version,
      availableUpdateVersion: availableUpdate?.version ?? null,
      boardRole: (board.board_role as string | null) ?? null,
      nodeLinkState: (board.node_link_state as string | null) ?? null,
      counts,
      nowMs,
      offlineTimeoutSeconds: opts.offlineTimeoutSeconds,
    });

    return {
      ...board,
      board_profile: catalogRow,
      custom_board_profile: customRow,
      compatBoard,
      room_name: board.room_id ? (roomById.get(board.room_id) ?? null) : null,
      home_name: board.home_id ? (homeById.get(board.home_id) ?? null) : null,
      mqtt,
      installed_release: board.installed_firmware_release_id
        ? (releaseById.get(board.installed_firmware_release_id) ?? null)
        : null,
      available_update: availableUpdate,
      counts,
      attached_node_count: attachedNodeCount.get(board.id) ?? 0,
      assigned_controller_name: board.assigned_controller_id
        ? (parentNameById.get(board.assigned_controller_id) ?? null)
        : null,
      health,
    };
  });
}

export interface CustomerMonitoringResult {
  account: Record<string, unknown>;
  owner: { id: string; email: string; full_name: string; created_at: string | null } | null;
  summary: {
    totalBoards: number;
    totalDevices: number;
    totalSensors: number;
    totalSwitches: number;
    onlineBoards: number;
    offlineBoards: number;
    controllers: number;
    nodes: number;
    lastSyncAt: string | null;
    lastHeartbeatAt: string | null;
    lastCommunicationAt: string | null;
    lastActivityAt: string | null;
  };
  health: {
    status: BoardHealthStatus;
    counts: Record<BoardHealthStatus, number>;
    offlineTimeoutSeconds: number;
    heartbeatIntervalSeconds: number;
  };
  boards: EnrichedBoard[];
  pagination: ReturnType<typeof paginationMeta>;
  settings: {
    offlineTimeoutSeconds: number;
    heartbeatIntervalSeconds: number;
  };
}

export async function loadCustomerMonitoring(
  db: DbClient,
  accountId: string,
  pagination: MonitoringPagination,
  nowMs = Date.now()
): Promise<CustomerMonitoringResult | null> {
  const loaded = await loadAccountForMonitoring(db, accountId);
  if (!loaded) return null;
  const { account, owner } = loaded;

  const settings = await fetchPlatformHealthSettings(db);

  const [
    boardsCountRes,
    onlineCountRes,
    controllersCountRes,
    nodesCountRes,
    devicesCountRes,
    sensorsCountRes,
    switchesCountRes,
    allBoardsRes,
    lastSyncRes,
    lastHeartbeatRes,
    lastCommRes,
  ] = await Promise.all([
    db
      .from("board_instances")
      .select("id", { count: "exact", head: true })
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .is("permanently_deleted_at", null),
    db
      .from("board_instances")
      .select("id", { count: "exact", head: true })
      .eq("account_id", accountId)
      .eq("status", "online")
      .is("deleted_at", null)
      .is("permanently_deleted_at", null),
    db
      .from("board_instances")
      .select("id", { count: "exact", head: true })
      .eq("account_id", accountId)
      .eq("board_role", "controller")
      .is("deleted_at", null)
      .is("permanently_deleted_at", null),
    db
      .from("board_instances")
      .select("id", { count: "exact", head: true })
      .eq("account_id", accountId)
      .eq("board_role", "node")
      .is("deleted_at", null)
      .is("permanently_deleted_at", null),
    db
      .from("devices")
      .select("id", { count: "exact", head: true })
      .eq("account_id", accountId)
      .is("deleted_at", null),
    db
      .from("sensors")
      .select("id", { count: "exact", head: true })
      .eq("account_id", accountId)
      .is("deleted_at", null),
    db
      .from("switches")
      .select("id", { count: "exact", head: true })
      .eq("account_id", accountId)
      .is("deleted_at", null),
    // Boards per account are capped by platform_settings
    // (max_board_instances_per_account, default 25, max 500), so enriching
    // every board in batched queries is bounded and lets the customer verdict
    // cover all boards (connectivity + entities + firmware), not just the
    // current page. The response itself is still paginated below.
    db
      .from("board_instances")
      .select("*")
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .is("permanently_deleted_at", null)
      .order("created_at", { ascending: false }),
    db
      .from("board_instances")
      .select("last_config_synced_at")
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .is("permanently_deleted_at", null)
      .not("last_config_synced_at", "is", null)
      .order("last_config_synced_at", { ascending: false })
      .limit(1),
    db
      .from("board_instances")
      .select("last_heartbeat_at")
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .is("permanently_deleted_at", null)
      .not("last_heartbeat_at", "is", null)
      .order("last_heartbeat_at", { ascending: false })
      .limit(1),
    db
      .from("board_instances")
      .select("last_communication_at")
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .is("permanently_deleted_at", null)
      .not("last_communication_at", "is", null)
      .order("last_communication_at", { ascending: false })
      .limit(1),
  ]);

  const totalBoards = boardsCountRes.count ?? 0;
  const onlineBoards = onlineCountRes.count ?? 0;
  const lastSyncAt =
    ((lastSyncRes.data as Array<{ last_config_synced_at: string | null }> | null)?.[0]
      ?.last_config_synced_at ?? null) as string | null;
  const lastHeartbeatAt =
    ((lastHeartbeatRes.data as Array<{ last_heartbeat_at: string | null }> | null)?.[0]
      ?.last_heartbeat_at ?? null) as string | null;
  const lastCommunicationAt =
    ((lastCommRes.data as Array<{ last_communication_at: string | null }> | null)?.[0]
      ?.last_communication_at ?? null) as string | null;
  const lastActivityAt = [lastSyncAt, lastHeartbeatAt, lastCommunicationAt]
    .filter(Boolean)
    .sort()
    .pop() ?? null;

  const otaReleases = await loadPublishedOtaReleases(db);
  const allBoards = await enrichBoards(
    db,
    ((allBoardsRes.data ?? []) as BoardRow[]) ?? [],
    { offlineTimeoutSeconds: settings.offlineTimeoutSeconds, otaReleases, nowMs }
  );

  // Customer verdict covers ALL boards with full per-board health (connectivity
  // + MQTT/Wi-Fi + sync + firmware + entity warnings), then the inventory is
  // paginated for the response.
  const customerHealth = computeCustomerHealth(
    allBoards.map((b) => b.health.status)
  );
  const offset = (pagination.page - 1) * pagination.pageSize;
  const boards = allBoards.slice(offset, offset + pagination.pageSize);

  return {
    account,
    owner,
    summary: {
      totalBoards,
      totalDevices: devicesCountRes.count ?? 0,
      totalSensors: sensorsCountRes.count ?? 0,
      totalSwitches: switchesCountRes.count ?? 0,
      onlineBoards,
      offlineBoards: Math.max(0, totalBoards - onlineBoards),
      controllers: controllersCountRes.count ?? 0,
      nodes: nodesCountRes.count ?? 0,
      lastSyncAt,
      lastHeartbeatAt,
      lastCommunicationAt,
      lastActivityAt,
    },
    health: {
      status: customerHealth.status,
      counts: customerHealth.counts,
      offlineTimeoutSeconds: settings.offlineTimeoutSeconds,
      heartbeatIntervalSeconds: settings.heartbeatIntervalSeconds,
    },
    boards,
    pagination: paginationMeta(totalBoards, pagination),
    settings,
  };
}

export interface BoardDetailResult {
  board: EnrichedBoard;
  firmwareHistory: Array<Record<string, unknown>>;
  recentActivity: Array<{
    id: string;
    category: string;
    action: string;
    summary: string;
    board_instance_id: string | null;
    created_at: string;
  }>;
  attachedNodes: Array<Record<string, unknown>>;
  parentBoard: { id: string; name: string; status: string } | null;
  sensorCompatibility: unknown;
}

export async function loadBoardDetail(
  db: DbClient,
  accountId: string,
  boardId: string,
  nowMs = Date.now()
): Promise<BoardDetailResult | null> {
  const loaded = await loadAccountForMonitoring(db, accountId);
  if (!loaded) return null;

  const { data } = await db
    .from("board_instances")
    .select("*")
    .eq("id", boardId)
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .is("permanently_deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const boardRow = data as BoardRow;

  const settings = await fetchPlatformHealthSettings(db);
  const otaReleases = await loadPublishedOtaReleases(db);
  const [enriched] = await enrichBoards(db, [boardRow], {
    offlineTimeoutSeconds: settings.offlineTimeoutSeconds,
    otaReleases,
    nowMs,
  });
  if (!enriched) return null;

  const role = normalizeBoardRole(boardRow.board_role);
  const [historyRes, activityRes, attachedRes, parentRes] = await Promise.all([
    db
      .from("firmware_update_history")
      .select("*")
      .eq("account_id", accountId)
      .eq("board_instance_id", boardId)
      .order("started_at", { ascending: false })
      .limit(20),
    db
      .from("activity_logs")
      .select("id,category,action,summary,board_instance_id,created_at")
      .eq("account_id", accountId)
      .eq("board_instance_id", boardId)
      .order("created_at", { ascending: false })
      .limit(20),
    role === "controller"
      ? db
          .from("board_instances")
          .select("*")
          .eq("account_id", accountId)
          .eq("assigned_controller_id", boardId)
          .is("deleted_at", null)
          .is("permanently_deleted_at", null)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as unknown[] }),
    boardRow.assigned_controller_id
      ? db
          .from("board_instances")
          .select("id,name,status")
          .eq("id", boardRow.assigned_controller_id)
          .eq("account_id", accountId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // Firmware history release names (batched, bounded to 20 rows).
  const historyRows = ((historyRes.data ?? []) as Array<Record<string, unknown>>) ?? [];
  const historyReleaseIds = Array.from(
    new Set(
      historyRows.map((h) => h.release_id).filter(Boolean) as string[]
    )
  );
  let historyWithRelease = historyRows;
  if (historyReleaseIds.length > 0) {
    const { data: rels } = await db
      .from("firmware_releases")
      .select("id,name,version,channel")
      .in("id", historyReleaseIds);
    const relById = new Map(
      ((rels ?? []) as Array<{ id: string; name: string; version: string; channel: string }>).map(
        (r) => [r.id, r]
      )
    );
    historyWithRelease = historyRows.map((h) => ({
      ...h,
      release: h.release_id ? (relById.get(String(h.release_id)) ?? null) : null,
    }));
  }

  // Sensor compatibility is best-effort diagnostics; never fail the detail
  // view if the report cannot be built.
  let sensorCompatibility: unknown = null;
  try {
    sensorCompatibility = await getControllerSensorCompatibilityReport(db, {
      id: boardRow.id,
      board_profile_id: boardRow.board_profile_id,
      custom_board_profile_id: boardRow.custom_board_profile_id,
      firmware_version: boardRow.firmware_version,
      installed_firmware_release_id: boardRow.installed_firmware_release_id,
    });
  } catch {
    sensorCompatibility = null;
  }

  return {
    board: enriched,
    firmwareHistory: historyWithRelease,
    recentActivity: ((activityRes.data ?? []) as BoardDetailResult["recentActivity"]) ?? [],
    attachedNodes: ((attachedRes.data ?? []) as Array<Record<string, unknown>>) ?? [],
    parentBoard: (parentRes.data as BoardDetailResult["parentBoard"]) ?? null,
    sensorCompatibility,
  };
}

export type BoardEntityKind = "devices" | "sensors" | "switches";

export async function loadBoardEntities(
  db: DbClient,
  accountId: string,
  boardId: string,
  kind: BoardEntityKind,
  pagination: MonitoringPagination
): Promise<{
  items: Array<Record<string, unknown>>;
  pagination: ReturnType<typeof paginationMeta>;
} | null> {
  // Ownership gate: the board must belong to this account, otherwise 404.
  const { data: board } = await db
    .from("board_instances")
    .select("id")
    .eq("id", boardId)
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .is("permanently_deleted_at", null)
    .maybeSingle();
  if (!board) return null;

  const offset = (pagination.page - 1) * pagination.pageSize;
  const table = kind; // devices | sensors | switches — all scoped the same way.
  const base = db
    .from(table)
    .select("*", { count: "exact" })
    .eq("account_id", accountId)
    .eq("board_instance_id", boardId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .range(offset, offset + pagination.pageSize - 1);

  const { data, count } = await base;
  let items = ((data ?? []) as Array<Record<string, unknown>>) ?? [];

  if (kind === "sensors") {
    items = items.map((row) => {
      const raw = (row.last_raw_payload ?? null) as Record<string, unknown> | null;
      const i2cAddress =
        typeof raw?.i2c_address === "string" && raw.i2c_address.trim()
          ? raw.i2c_address
          : null;
      const driverId =
        typeof raw?.driver_id === "string" && raw.driver_id.trim()
          ? raw.driver_id
          : typeof row.sensor_type === "string"
            ? (getSensorDriverForMeasurement(row.sensor_type)?.id ?? null)
            : null;
      return { ...row, i2c_address: i2cAddress, driver_id: driverId };
    });
  }

  return { items, pagination: paginationMeta(count ?? items.length, pagination) };
}
