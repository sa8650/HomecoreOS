import {
  buildCanonicalDriverManifestString,
  compareFirmwareVersions,
  evaluateControllerSensorCompatibility,
  evaluateReleaseCompatibilityForBoard,
  extractFirmwareDriverManifestFromRelease,
  FIRMWARE_DRIVER_MANIFEST_VERSION,
  validateFirmwareDriverManifest,
  validateSensorAssignmentForController,
  type BoardProfileSpec,
  type ControllerSensorCompatibilityReport,
  type ExistingControllerSensorSummary,
  type FirmwareDriverManifest,
  type ResolvedFirmwareDriverManifest,
  type SensorAssignmentValidationResult,
  type SensorResourcesConfig,
  type SupportedSensorType,
} from "@homecoreos/shared";
import { resolveControllerBoardSpec } from "./board-helpers";
import { sha256Hex } from "./crypto";
import type { DbClient } from "./db";

export interface ControllerFirmwareLookupRow {
  id: string;
  board_profile_id: string | null;
  custom_board_profile_id: string | null;
  firmware_version?: string | null;
  installed_firmware_release_id?: string | null;
}

interface FirmwareReleaseManifestRow {
  id: string;
  name: string;
  version: string;
  status: string;
  chip_family: string;
  target_board_slug?: string | null;
  partition_scheme?: string | null;
  psram_mode?: string | null;
  flash_size_mb?: number | null;
  compatible_board_ids?: string[] | null;
  compatible_board_slugs?: string[] | null;
  hardware_verified?: boolean | null;
  driver_manifest?: unknown;
  compiled_sensor_drivers?: string[] | null;
  supported_sensor_types?: string[] | null;
  manifest_version?: string | null;
  manifest_hash?: string | null;
  manifest?: unknown;
  published_at?: string | null;
}

function normalizeFwVersion(v: string | null | undefined): string {
  return (v ?? "").trim().replace(/^v/i, "").toLowerCase();
}

function scoreReleaseMatchForBoard(
  release: FirmwareReleaseManifestRow,
  board: BoardProfileSpec
): number {
  let score = 0;
  if (release.status === "published") score += 100;
  else if (release.status === "deprecated") score += 40;
  else if (release.status === "draft") score += 10;

  if (release.target_board_slug && release.target_board_slug === board.slug) {
    score += 50;
  }
  if (board.id && release.compatible_board_ids?.includes(board.id)) {
    score += 30;
  }
  if (release.compatible_board_slugs?.includes(board.slug)) {
    score += 20;
  }
  if (release.hardware_verified) {
    score += 10;
  }
  const extracted = extractFirmwareDriverManifestFromRelease(release);
  if (extracted.state === "manifest_verified") {
    score += 5;
  }
  return score;
}

function pickBestMatchingRelease(
  releases: FirmwareReleaseManifestRow[],
  board: BoardProfileSpec,
  controller: ControllerFirmwareLookupRow
): FirmwareReleaseManifestRow | null {
  // 1. Explicit release link on controller (still verified for board compatibility)
  if (controller.installed_firmware_release_id) {
    const direct = releases.find((r) => r.id === controller.installed_firmware_release_id);
    if (direct) {
      const compat = evaluateReleaseCompatibilityForBoard({
        release: direct,
        board,
        requirePublished: false,
      });
      if (compat.compatible) return direct;
    }
  }

  // 2. Exact installed firmware_version matched against compatible releases in DB
  const targetVer = normalizeFwVersion(controller.firmware_version);
  if (!targetVer) return null;

  const matching = releases
    .filter((r) => {
      if (normalizeFwVersion(r.version) !== targetVer) return false;
      const compat = evaluateReleaseCompatibilityForBoard({
        release: r,
        board,
        requirePublished: false,
      });
      return compat.compatible;
    })
    .sort((a, b) => scoreReleaseMatchForBoard(b, board) - scoreReleaseMatchForBoard(a, board));

  return matching[0] ?? null;
}

function pickLatestPublishedManifestRelease(
  releases: FirmwareReleaseManifestRow[],
  board: BoardProfileSpec
): {
  id: string;
  version: string;
  name: string;
  supportedSensorTypes: SupportedSensorType[];
} | null {
  const candidates = releases
    .filter((r) => {
      if (r.status !== "published") return false;
      const compat = evaluateReleaseCompatibilityForBoard({
        release: r,
        board,
        requirePublished: true,
      });
      if (!compat.compatible) return false;
      const extracted = extractFirmwareDriverManifestFromRelease(r);
      return extracted.state === "manifest_verified" && extracted.supportedSensorTypes.length > 0;
    })
    .sort((a, b) => {
      const verCmp = compareFirmwareVersions(b.version, a.version);
      if (verCmp !== 0) return verCmp;
      return scoreReleaseMatchForBoard(b, board) - scoreReleaseMatchForBoard(a, board);
    });

  const best = candidates[0];
  if (!best) return null;
  const extracted = extractFirmwareDriverManifestFromRelease(best);
  return {
    id: best.id,
    version: best.version,
    name: best.name,
    supportedSensorTypes: extracted.supportedSensorTypes,
  };
}

function resolveFirmwareFromReleasesList(
  releases: FirmwareReleaseManifestRow[],
  controller: ControllerFirmwareLookupRow,
  board: BoardProfileSpec | null
): {
  installedFirmware: ResolvedFirmwareDriverManifest;
  latestAvailableRelease: {
    id: string;
    version: string;
    name: string;
    supportedSensorTypes: SupportedSensorType[];
  } | null;
  matchedReleaseId: string | null;
} {
  const fwVersion = (controller.firmware_version ?? "").trim() || null;

  if (!board) {
    return {
      installedFirmware: {
        state: fwVersion ? "unknown_firmware" : "no_firmware_installed",
        releaseId: null,
        releaseName: null,
        firmwareVersion: fwVersion,
        targetBoardSlug: null,
        manifestVersion: null,
        manifestHash: null,
        compiledDriverIds: [],
        supportedSensorTypes: [],
        drivers: [],
        reason: "Controller has no assigned hardware board profile.",
      },
      latestAvailableRelease: null,
      matchedReleaseId: null,
    };
  }

  const latestAvailableRelease = pickLatestPublishedManifestRelease(releases, board);

  if (!fwVersion && !controller.installed_firmware_release_id) {
    return {
      installedFirmware: {
        state: "no_firmware_installed",
        releaseId: null,
        releaseName: null,
        firmwareVersion: null,
        targetBoardSlug: board.slug,
        manifestVersion: null,
        manifestHash: null,
        compiledDriverIds: [],
        supportedSensorTypes: [],
        drivers: [],
        reason: `No installed firmware version is reported on this ${board.manufacturer} ${board.model} controller yet. Flash or pair verified firmware with a compiled sensor driver manifest.`,
      },
      latestAvailableRelease,
      matchedReleaseId: null,
    };
  }

  const matched = pickBestMatchingRelease(releases, board, controller);
  if (!matched) {
    return {
      installedFirmware: {
        state: "unknown_firmware",
        releaseId: null,
        releaseName: null,
        firmwareVersion: fwVersion,
        targetBoardSlug: board.slug,
        manifestVersion: null,
        manifestHash: null,
        compiledDriverIds: [],
        supportedSensorTypes: [],
        drivers: [],
        reason: `Installed firmware v${fwVersion ?? "unknown"} does not match any verified release manifest for ${board.manufacturer} ${board.model}. Update firmware to enable board-aware sensors.`,
      },
      latestAvailableRelease,
      matchedReleaseId: null,
    };
  }

  return {
    installedFirmware: extractFirmwareDriverManifestFromRelease(matched),
    latestAvailableRelease,
    matchedReleaseId: matched.id,
  };
}

const RELEASE_MANIFEST_SELECT =
  "id,name,version,status,chip_family,target_board_slug,partition_scheme,psram_mode,flash_size_mb,compatible_board_ids,compatible_board_slugs,hardware_verified,driver_manifest,compiled_sensor_drivers,supported_sensor_types,manifest_version,manifest_hash,manifest,published_at";

export async function resolveControllerInstalledFirmware(
  db: DbClient,
  controller: ControllerFirmwareLookupRow,
  board: BoardProfileSpec | null
): Promise<{
  installedFirmware: ResolvedFirmwareDriverManifest;
  latestAvailableRelease: {
    id: string;
    version: string;
    name: string;
    supportedSensorTypes: SupportedSensorType[];
  } | null;
  matchedReleaseId: string | null;
}> {
  if (!board) {
    return resolveFirmwareFromReleasesList([], controller, null);
  }
  const { data } = await db
    .from("firmware_releases")
    .select(RELEASE_MANIFEST_SELECT)
    .eq("chip_family", board.chip_family)
    .is("deleted_at", null);

  return resolveFirmwareFromReleasesList(
    (data ?? []) as FirmwareReleaseManifestRow[],
    controller,
    board
  );
}

/**
 * Matches a device-reported firmware version strictly against authoritative
 * `firmware_releases` records for its board so `controllers.installed_firmware_release_id`
 * can be linked safely during pair / heartbeat / OTA verification.
 */
export async function findMatchingFirmwareReleaseIdForDevice(
  db: DbClient,
  board: BoardProfileSpec | null,
  firmwareVersion: string | null | undefined
): Promise<string | null> {
  if (!board || !firmwareVersion || !firmwareVersion.trim()) return null;
  const { data } = await db
    .from("firmware_releases")
    .select(RELEASE_MANIFEST_SELECT)
    .eq("chip_family", board.chip_family)
    .is("deleted_at", null);

  const matched = pickBestMatchingRelease(
    (data ?? []) as FirmwareReleaseManifestRow[],
    board,
    {
      id: "",
      board_profile_id: board.id ?? null,
      custom_board_profile_id: null,
      firmware_version: firmwareVersion,
      installed_firmware_release_id: null,
    }
  );
  return matched?.id ?? null;
}

export async function getControllerSensorCompatibilityReport(
  db: DbClient,
  controller: ControllerFirmwareLookupRow,
  preloadedBoard?: BoardProfileSpec | null
): Promise<ControllerSensorCompatibilityReport> {
  const board =
    preloadedBoard !== undefined
      ? preloadedBoard
      : await resolveControllerBoardSpec(db, controller);
  const { installedFirmware, latestAvailableRelease } =
    await resolveControllerInstalledFirmware(db, controller, board);
  return evaluateControllerSensorCompatibility({
    board,
    installedFirmware,
    latestAvailableRelease,
  });
}

/**
 * Batched sensor compatibility lookup for `GET /api/board-instances` (avoids N+1 queries).
 */
export async function getControllersSensorCompatibilityMap(
  db: DbClient,
  controllers: ControllerFirmwareLookupRow[]
): Promise<Map<string, ControllerSensorCompatibilityReport>> {
  const result = new Map<string, ControllerSensorCompatibilityReport>();
  if (controllers.length === 0) return result;

  const boardsByCtrl = new Map<string, BoardProfileSpec | null>();
  const uniqueBoardKeys = new Map<
    string,
    { board_profile_id: string | null; custom_board_profile_id: string | null }
  >();

  for (const ctrl of controllers) {
    const key = ctrl.board_profile_id
      ? `catalog:${ctrl.board_profile_id}`
      : ctrl.custom_board_profile_id
        ? `custom:${ctrl.custom_board_profile_id}`
        : "none";
    if (key !== "none" && !uniqueBoardKeys.has(key)) {
      uniqueBoardKeys.set(key, {
        board_profile_id: ctrl.board_profile_id,
        custom_board_profile_id: ctrl.custom_board_profile_id,
      });
    }
  }

  const resolvedBoards = new Map<string, BoardProfileSpec | null>();
  await Promise.all(
    Array.from(uniqueBoardKeys.entries()).map(async ([key, ref]) => {
      const spec = await resolveControllerBoardSpec(db, ref);
      resolvedBoards.set(key, spec);
    })
  );

  const chipFamilies = new Set<string>();
  for (const ctrl of controllers) {
    const key = ctrl.board_profile_id
      ? `catalog:${ctrl.board_profile_id}`
      : ctrl.custom_board_profile_id
        ? `custom:${ctrl.custom_board_profile_id}`
        : "none";
    const board = key === "none" ? null : (resolvedBoards.get(key) ?? null);
    boardsByCtrl.set(ctrl.id, board);
    if (board?.chip_family) chipFamilies.add(board.chip_family);
  }

  let allReleases: FirmwareReleaseManifestRow[] = [];
  if (chipFamilies.size > 0) {
    const { data } = await db
      .from("firmware_releases")
      .select(RELEASE_MANIFEST_SELECT)
      .in("chip_family", Array.from(chipFamilies))
      .is("deleted_at", null);
    allReleases = (data ?? []) as FirmwareReleaseManifestRow[];
  }

  for (const ctrl of controllers) {
    const board = boardsByCtrl.get(ctrl.id) ?? null;
    const chipReleases = board
      ? allReleases.filter((r) => r.chip_family === board.chip_family)
      : [];
    const { installedFirmware, latestAvailableRelease } =
      resolveFirmwareFromReleasesList(chipReleases, ctrl, board);
    result.set(
      ctrl.id,
      evaluateControllerSensorCompatibility({
        board,
        installedFirmware,
        latestAvailableRelease,
      })
    );
  }

  return result;
}

export async function getControllerSensorOccupancy(
  db: DbClient,
  accountId: string,
  boardInstanceId: string
): Promise<{
  nonSensorUsedPins: number[];
  existingSensors: ExistingControllerSensorSummary[];
}> {
  const [devRes, swRes, senRes] = await Promise.all([
    db
      .from("devices")
      .select("id,gpio_pin")
      .eq("account_id", accountId)
      .eq("board_instance_id", boardInstanceId)
      .is("deleted_at", null),
    db
      .from("switches")
      .select("id,gpio_pin")
      .eq("account_id", accountId)
      .eq("board_instance_id", boardInstanceId)
      .is("deleted_at", null),
    db
      .from("sensors")
      .select("id,name,sensor_type,gpio_pin,last_raw_payload")
      .eq("account_id", accountId)
      .eq("board_instance_id", boardInstanceId)
      .is("deleted_at", null),
  ]);

  const nonSensorPins = new Set<number>();
  for (const row of [
    ...((devRes.data ?? []) as Array<{ gpio_pin: number | null }>),
    ...((swRes.data ?? []) as Array<{ gpio_pin: number | null }>),
  ]) {
    if (typeof row.gpio_pin === "number") nonSensorPins.add(row.gpio_pin);
  }

  const existingSensors: ExistingControllerSensorSummary[] = (
    (senRes.data ?? []) as Array<{
      id: string;
      name: string;
      sensor_type: string;
      gpio_pin: number | null;
      last_raw_payload: Record<string, unknown> | null;
    }>
  ).map((s) => ({
    id: s.id,
    name: s.name,
    sensor_type: s.sensor_type,
    gpio_pin: s.gpio_pin,
    i2c_address:
      typeof s.last_raw_payload?.i2c_address === "string"
        ? s.last_raw_payload.i2c_address
        : null,
    driver_id:
      typeof s.last_raw_payload?.driver_id === "string"
        ? s.last_raw_payload.driver_id
        : null,
    resources:
      s.last_raw_payload?.resources && typeof s.last_raw_payload.resources === "object"
        ? (s.last_raw_payload.resources as SensorResourcesConfig)
        : null,
  }));

  return {
    nonSensorUsedPins: Array.from(nonSensorPins),
    existingSensors,
  };
}

export async function validateControllerSensorMutation(
  db: DbClient,
  params: {
    accountId: string;
    controller: ControllerFirmwareLookupRow;
    sensorType: string;
    gpioPin: number | null | undefined;
    i2cAddress?: string | null;
    editingSensorId?: string | null;
    resources?: SensorResourcesConfig | null;
    driverId?: string | null;
    model?: string | null;
  }
): Promise<{
  result: SensorAssignmentValidationResult;
  board: BoardProfileSpec | null;
  installedFirmware: ResolvedFirmwareDriverManifest;
}> {
  const board = await resolveControllerBoardSpec(db, params.controller);
  const [{ installedFirmware }, occupancy] = await Promise.all([
    resolveControllerInstalledFirmware(db, params.controller, board),
    getControllerSensorOccupancy(db, params.accountId, params.controller.id),
  ]);

  const result = validateSensorAssignmentForController({
    board,
    installedFirmware,
    sensorType: params.sensorType,
    gpioPin: params.gpioPin,
    i2cAddress: params.i2cAddress,
    usedPinsByNonSensors: occupancy.nonSensorUsedPins,
    existingSensorsOnController: occupancy.existingSensors,
    editingSensorId: params.editingSensorId,
    resources: params.resources ?? null,
    driverId: params.driverId ?? null,
    model: params.model ?? null,
  });

  return { result, board, installedFirmware };
}

export async function prepareFirmwareDriverManifestForStorage(
  raw: unknown,
  context: {
    firmwareVersion: string;
    chipFamily: string;
    targetBoardSlug: string | null;
    partitionScheme?: string | null;
    flashSizeMb?: number | null;
    psramMode?: string | null;
    idfVersion?: string | null;
    ciCommitSha?: string | null;
  }
): Promise<
  | {
      ok: true;
      present: boolean;
      driver_manifest: FirmwareDriverManifest | null;
      compiled_sensor_drivers: string[];
      supported_sensor_types: string[];
      manifest_version: string | null;
      manifest_hash: string | null;
    }
  | { ok: false; error: string }
> {
  if (raw === null || raw === undefined) {
    return {
      ok: true,
      present: false,
      driver_manifest: null,
      compiled_sensor_drivers: [],
      supported_sensor_types: [],
      manifest_version: null,
      manifest_hash: null,
    };
  }

  const normalizedInput =
    Array.isArray(raw)
      ? {
          manifest_version: FIRMWARE_DRIVER_MANIFEST_VERSION,
          firmware_version: context.firmwareVersion,
          chip_family: context.chipFamily,
          target_board_slug: context.targetBoardSlug,
          partition_scheme: context.partitionScheme ?? null,
          flash_size_mb: context.flashSizeMb ?? null,
          psram_mode: context.psramMode ?? null,
          sensor_drivers: raw,
        }
      : typeof raw === "object"
        ? {
            manifest_version: FIRMWARE_DRIVER_MANIFEST_VERSION,
            firmware_version: context.firmwareVersion,
            chip_family: context.chipFamily,
            target_board_slug: context.targetBoardSlug,
            partition_scheme: context.partitionScheme ?? null,
            flash_size_mb: context.flashSizeMb ?? null,
            psram_mode: context.psramMode ?? null,
            ...(raw as Record<string, unknown>),
          }
        : raw;

  const validated = validateFirmwareDriverManifest(normalizedInput, {
    expectedChipFamily: context.chipFamily,
    expectedBoardSlug: context.targetBoardSlug,
  });
  if (!validated.valid || !validated.manifest) {
    return { ok: false, error: validated.errors.join(" ") };
  }

  const canonical = buildCanonicalDriverManifestString(validated.manifest);
  const computedHash = await sha256Hex(canonical);

  if (
    validated.manifest.manifest_hash &&
    validated.manifest.manifest_hash.toLowerCase() !== computedHash.toLowerCase()
  ) {
    return {
      ok: false,
      error: `Firmware driver manifest hash mismatch (expected ${computedHash}, got ${validated.manifest.manifest_hash}).`,
    };
  }

  const finalManifest: FirmwareDriverManifest = {
    ...validated.manifest,
    manifest_hash: computedHash,
    ...(context.idfVersion || context.ciCommitSha
      ? {
          build_verification: {
            verified: validated.manifest.build_verification?.verified ?? true,
            verifier:
              validated.manifest.build_verification?.verifier ??
              "homecoreos-verify-firmware-image",
            ci_commit_sha:
              validated.manifest.build_verification?.ci_commit_sha ??
              context.ciCommitSha ??
              null,
            idf_version:
              validated.manifest.build_verification?.idf_version ??
              context.idfVersion ??
              null,
          },
        }
      : {}),
  };

  return {
    ok: true,
    present: true,
    driver_manifest: finalManifest,
    compiled_sensor_drivers: finalManifest.sensor_drivers.map((d) => d.id),
    supported_sensor_types: [...finalManifest.supported_sensor_types],
    manifest_version: finalManifest.manifest_version,
    manifest_hash: computedHash,
  };
}
