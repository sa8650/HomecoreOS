import {
  evaluateReleaseCompatibilityForBoard,
  resolveBoardFirmwareCompatibility,
  type BoardProfileSpec,
} from "@homecoreos/shared";
import type { DbClient } from "./db";

export interface CompatBoardRecord {
  id: string;
  slug: string;
  manufacturer: string;
  model: string;
  revision: string;
  chip_family: string;
  chip_variant: string;
  flash_size_mb: number;
  psram_size_mb: number;
  firmware_status?: string;
  partition_scheme?: string | null;
  psram_mode?: string | null;
  flash_mode?: string | null;
  flash_freq?: string | null;
  bootloader_offset?: string | null;
  ota_app_offset?: string | null;
  boot_button_gpio?: number | null;
  usb_interface?: string | null;
  supports_wifi?: boolean | null;
  supports_ble?: boolean | null;
  supports_ble_wifi_provisioning?: boolean | null;
  supports_ota_rollback?: boolean | null;
  firmware_compat_key?: string | null;
  connectivity_note?: string | null;
  board_layout?: BoardProfileSpec["board_layout"];
}

export async function resolveControllerCompatBoard(
  db: DbClient,
  controller: {
    board_catalog_id: string | null;
    custom_board_id: string | null;
  }
): Promise<CompatBoardRecord | null> {
  if (controller.board_catalog_id) {
    const { data } = await db
      .from("board_catalog")
      .select(
        "id,slug,manufacturer,model,revision,chip_family,chip_variant,flash_size_mb,psram_size_mb,firmware_status,partition_scheme,psram_mode,flash_mode,flash_freq,bootloader_offset,ota_app_offset,boot_button_gpio,usb_interface,supports_wifi,supports_ble,supports_ble_wifi_provisioning,supports_ota_rollback,firmware_compat_key,connectivity_note,board_layout"
      )
      .eq("id", controller.board_catalog_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!data) return null;
    const row = data as CompatBoardRecord;
    return {
      ...row,
      ...resolveBoardFirmwareCompatibility(row),
    };
  }

  if (controller.custom_board_id) {
    const { data } = await db
      .from("custom_boards")
      .select(
        "id,slug,manufacturer,model,revision,chip_family,chip_variant,flash_size_mb,psram_size_mb,partition_scheme,psram_mode,flash_mode,flash_freq,bootloader_offset,ota_app_offset,boot_button_gpio,usb_interface,supports_wifi,supports_ble,supports_ble_wifi_provisioning,supports_ota_rollback,firmware_compat_key,connectivity_note,board_layout"
      )
      .eq("id", controller.custom_board_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!data) return null;
    const row = data as CompatBoardRecord;
    return {
      ...row,
      ...resolveBoardFirmwareCompatibility(row),
      firmware_status: "custom",
    };
  }

  return null;
}

export function checkControllerReleaseCompatibility(params: {
  board: CompatBoardRecord | null;
  release: {
    chip_family: string;
    status?: string | null;
    target_board_slug?: string | null;
    compatible_board_ids?: string[] | null;
    compatible_board_slugs?: string[] | null;
    partition_scheme?: string | null;
    psram_mode?: string | null;
    flash_size_mb?: number | null;
    files?: Array<{ flash_size?: string | null }> | null;
  };
  requirePublished?: boolean;
}): { compatible: boolean; reasons: string[]; warnings: string[] } {
  if (!params.board) {
    return {
      compatible: false,
      reasons: ["Controller is missing an assigned hardware board profile."],
      warnings: [],
    };
  }

  const baseCheck = evaluateReleaseCompatibilityForBoard({
    release: params.release,
    board: params.board,
    requirePublished: params.requirePublished,
  });

  if (!baseCheck.compatible) return baseCheck;

  // Enforce board readiness if release does not explicitly pin the board
  const hasExplicitBoards =
    (params.release.compatible_board_ids?.length ?? 0) > 0 ||
    (params.release.compatible_board_slugs?.length ?? 0) > 0;
  if (
    !hasExplicitBoards &&
    params.board.firmware_status &&
    params.board.firmware_status !== "custom" &&
    params.board.firmware_status !== "firmware_supported"
  ) {
    return {
      compatible: false,
      reasons: [
        `${params.board.manufacturer} ${params.board.model} is marked "${params.board.firmware_status}" and requires a board-targeted verified firmware release.`,
      ],
      warnings: baseCheck.warnings,
    };
  }

  return baseCheck;
}

/**
 * Synchronizes board_catalog.firmware_status with published, hardware-verified releases.
 * - Never promotes unverified boards to 'firmware_supported'.
 * - Preserves 'esp32-s3-devkitc-1-n16r8' baseline 'firmware_supported' status unless explicitly marked unsupported.
 * - Demotes non-baseline boards back to 'catalog_only' if all verified published releases covering them are removed/unpublished/archived.
 */
export async function syncBoardFirmwareStatuses(
  db: DbClient,
  targetBoardIds?: string[]
): Promise<void> {
  const [boardsRes, releasesRes, filesRes] = await Promise.all([
    db
      .from("board_catalog")
      .select(
        "id,slug,manufacturer,model,chip_family,chip_variant,flash_size_mb,psram_size_mb,firmware_status,verification_status,partition_scheme,psram_mode,flash_mode,flash_freq,bootloader_offset,ota_app_offset,boot_button_gpio,usb_interface,supports_wifi,supports_ble,supports_ble_wifi_provisioning,supports_ota_rollback,firmware_compat_key"
      )
      .is("deleted_at", null),
    db
      .from("firmware_releases")
      .select(
        "id,status,chip_family,target_board_slug,partition_scheme,psram_mode,flash_size_mb,compatible_board_ids,compatible_board_slugs,hardware_verified,verified_board_ids,verified_board_slugs,build_status"
      )
      .is("deleted_at", null),
    db.from("firmware_files").select("release_id,validated,flash_size"),
  ]);

  const validFileReleaseIds = new Set<string>();
  const filesByRelease = new Map<string, Array<{ flash_size?: string | null }>>();
  for (const f of (filesRes.data ?? []) as Array<{
    release_id: string;
    validated?: boolean;
    flash_size?: string | null;
  }>) {
    if (f.validated !== false) validFileReleaseIds.add(f.release_id);
    const arr = filesByRelease.get(f.release_id) ?? [];
    arr.push({ flash_size: f.flash_size });
    filesByRelease.set(f.release_id, arr);
  }

  const releases = (releasesRes.data ?? []) as Array<{
    id: string;
    status: string;
    chip_family: string;
    target_board_slug?: string | null;
    partition_scheme?: string | null;
    psram_mode?: string | null;
    flash_size_mb?: number | null;
    compatible_board_ids?: string[];
    compatible_board_slugs?: string[];
    hardware_verified?: boolean;
    verified_board_ids?: string[];
    verified_board_slugs?: string[];
    build_status?: string;
  }>;

  const targetSet = targetBoardIds && targetBoardIds.length > 0 ? new Set(targetBoardIds) : null;

  for (const rawBoard of (boardsRes.data ?? []) as Array<
    CompatBoardRecord & { firmware_status: string; verification_status: string }
  >) {
    if (targetSet && !targetSet.has(rawBoard.id)) continue;
    if (rawBoard.firmware_status === "unsupported") continue;

    const board = {
      ...rawBoard,
      ...resolveBoardFirmwareCompatibility(rawBoard),
    };

    const hasVerifiedPublishedRelease = releases.some((r) => {
      if (r.status !== "published") return false;
      if (!validFileReleaseIds.has(r.id)) return false;
      const compat = evaluateReleaseCompatibilityForBoard({
        release: { ...r, files: filesByRelease.get(r.id) ?? [] },
        board,
        requirePublished: true,
      });
      if (!compat.compatible) return false;

      const verifiedForThisBoard =
        Boolean(r.hardware_verified) ||
        (r.verified_board_ids ?? []).includes(board.id) ||
        (r.verified_board_slugs ?? []).includes(board.slug);
      return verifiedForThisBoard;
    });

    let nextStatus = board.firmware_status;
    if (hasVerifiedPublishedRelease) {
      nextStatus = "firmware_supported";
    } else if (board.slug === "esp32-s3-devkitc-1-n16r8") {
      // Preserve baseline S3 N16R8 support status when no verified release rows exist yet
      nextStatus = "firmware_supported";
    } else if (board.firmware_status === "firmware_supported") {
      nextStatus = "catalog_only";
    }

    if (nextStatus !== board.firmware_status) {
      await db
        .from("board_catalog")
        .update({ firmware_status: nextStatus })
        .eq("id", board.id);
    }
  }
}
