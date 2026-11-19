import type { PGlite } from "@electric-sql/pglite";
import {
  ALL_BOARD_FIRMWARE_COMPAT_BY_SLUG,
  SENSOR_DRIVER_IDS,
  buildCanonicalDriverManifestString,
  buildFirmwareDriverManifest,
  type ChipFamily,
  type SensorDriverId,
} from "@homecoreos/shared";
import { sha256Hex } from "../../src/lib/crypto";

/**
 * Seeds a published, manifest-verified firmware release for a board and links a
 * test controller to it so tests exercising unrelated features (automations,
 * flow graphs, entity updates, MQTT telemetry) satisfy the mandatory
 * board + installed-firmware sensor driver invariant.
 */
export async function seedInstalledFirmwareWithDrivers(params: {
  pg: PGlite;
  boardInstanceId: string;
  boardId: string;
  boardSlug: string;
  chipFamily: ChipFamily;
  version?: string;
  driverIds?: readonly SensorDriverId[];
  omitDriverManifest?: boolean;
}): Promise<{ releaseId: string; version: string }> {
  const version = params.version ?? "1.5.0";
  const compat = ALL_BOARD_FIRMWARE_COMPAT_BY_SLUG[params.boardSlug];
  const flashSizeMb =
    compat?.partition_scheme === "dual_ota_16mb"
      ? 16
      : compat?.partition_scheme === "dual_ota_8mb"
        ? 8
        : 4;

  const manifest = params.omitDriverManifest
    ? null
    : buildFirmwareDriverManifest({
        firmwareVersion: version,
        chipFamily: params.chipFamily,
        targetBoardSlug: params.boardSlug,
        partitionScheme: compat?.partition_scheme ?? "dual_ota_16mb",
        flashSizeMb,
        psramMode: compat?.psram_mode ?? "none",
        driverIds: params.driverIds ?? SENSOR_DRIVER_IDS,
      });

  const manifestHash = manifest
    ? await sha256Hex(buildCanonicalDriverManifestString(manifest))
    : null;
  const finalManifest = manifest ? { ...manifest, manifest_hash: manifestHash! } : null;

  const existing = await params.pg.query<{ id: string }>(
    `SELECT id FROM public.firmware_releases
     WHERE version = $1 AND chip_family = $2 AND COALESCE(target_board_slug, '') = $3 AND deleted_at IS NULL
     LIMIT 1`,
    [version, params.chipFamily, params.boardSlug]
  );

  let releaseId = existing.rows[0]?.id;
  if (!releaseId) {
    const inserted = await params.pg.query<{ id: string }>(
      `INSERT INTO public.firmware_releases (
         name, version, channel, chip_family, target_board_slug,
         partition_scheme, psram_mode, flash_mode, flash_freq, flash_size_mb,
         compatible_board_ids, compatible_board_slugs,
         ota_available, usb_available, status, build_status,
         hardware_verified, verified_board_ids, verified_board_slugs,
         driver_manifest, compiled_sensor_drivers, supported_sensor_types,
         manifest_version, manifest_hash, published_at
       ) VALUES (
         $1, $2, 'stable', $3, $4,
         $5, $6, $7, $8, $9,
         ARRAY[$10::uuid], ARRAY[$4::text],
         true, true, 'published', 'succeeded',
         true, ARRAY[$10::uuid], ARRAY[$4::text],
         $11::jsonb, $12::text[], $13::text[],
         $14, $15, now()
       ) RETURNING id`,
      [
        `HomecoreOS ${params.boardSlug}`,
        version,
        params.chipFamily,
        params.boardSlug,
        compat?.partition_scheme ?? "dual_ota_16mb",
        compat?.psram_mode ?? "none",
        compat?.flash_mode ?? "qio",
        compat?.flash_freq ?? "80m",
        flashSizeMb,
        params.boardId,
        finalManifest ? JSON.stringify(finalManifest) : null,
        finalManifest ? finalManifest.sensor_drivers.map((d) => d.id) : [],
        finalManifest ? finalManifest.supported_sensor_types : [],
        finalManifest ? finalManifest.manifest_version : null,
        manifestHash,
      ]
    );
    releaseId = inserted.rows[0]!.id;
  }

  await params.pg.query(
    `UPDATE public.board_instances
     SET firmware_version = $1, installed_firmware_release_id = $2
     WHERE id = $3`,
    [version, releaseId, params.boardInstanceId]
  );

  return { releaseId, version };
}
