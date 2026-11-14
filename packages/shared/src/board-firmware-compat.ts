import type { BoardLayoutSpec, ChipFamily } from "./index";

export type PartitionScheme =
  | "dual_ota_4mb"
  | "dual_ota_8mb"
  | "dual_ota_16mb"
  | "dual_ota_32mb";

export type PsramMode = "none" | "quad" | "octal";

export type FlashMode = "qio" | "qout" | "dio" | "dout";

export type FlashFreq = "40m" | "60m" | "64m" | "80m";

export type FirmwareReleaseStatus =
  | "draft"
  | "published"
  | "deprecated"
  | "archived";

export type FirmwareBuildStatus =
  | "pending"
  | "building"
  | "succeeded"
  | "failed"
  | "manual";

export interface BoardFirmwareCompatibilityProfile {
  partition_scheme: PartitionScheme;
  psram_mode: PsramMode;
  flash_mode: FlashMode;
  flash_freq: FlashFreq;
  bootloader_offset: string;
  ota_app_offset: string;
  boot_button_gpio: number;
  usb_interface: string;
  supports_wifi: boolean;
  supports_ble: boolean;
  supports_ble_wifi_provisioning: boolean;
  supports_ota_rollback: boolean;
  firmware_compat_key: string;
  connectivity_note: string | null;
}

export function buildFirmwareCompatKey(params: {
  chip_family: string;
  flash_size_mb: number;
  flash_mode: FlashMode;
  psram_mode: PsramMode;
  psram_size_mb: number;
  partition_scheme: PartitionScheme;
  boot_button_gpio: number;
}): string {
  const psramTag =
    params.psram_mode === "none" || params.psram_size_mb <= 0
      ? "none"
      : `${params.psram_mode}${params.psram_size_mb}m`;
  return [
    params.chip_family.trim().toLowerCase(),
    `${params.flash_size_mb}m`,
    params.flash_mode,
    psramTag,
    params.partition_scheme,
    `b${params.boot_button_gpio}`,
  ].join("-");
}

export function derivePartitionScheme(flashSizeMb: number): PartitionScheme {
  if (flashSizeMb >= 32) return "dual_ota_32mb";
  if (flashSizeMb >= 16) return "dual_ota_16mb";
  if (flashSizeMb >= 8) return "dual_ota_8mb";
  return "dual_ota_4mb";
}

export function defaultBootloaderOffsetForChip(chipFamily: string): string {
  const norm = chipFamily.trim().toLowerCase();
  if (norm === "esp32" || norm === "esp32s2") return "0x1000";
  if (
    norm === "esp32c5" ||
    norm === "esp32p4" ||
    norm === "esp32h4" ||
    norm === "esp32s31"
  ) {
    return "0x2000";
  }
  return "0x0";
}

export function defaultBootButtonGpioForChip(chipFamily: string, slug?: string): number {
  if (slug === "esp32-c5-devkitc-1") return 28;
  const norm = chipFamily.trim().toLowerCase();
  if (norm === "esp32c5") return 28;
  if (
    norm === "esp32c2" ||
    norm === "esp32c3" ||
    norm === "esp32c6" ||
    norm === "esp32c61" ||
    norm === "esp32h2" ||
    norm === "esp32h21"
  ) {
    return 9;
  }
  return 0;
}

export function chipSupportsIntegratedWifi(chipFamily: string): boolean {
  const norm = chipFamily.trim().toLowerCase();
  return !["esp32h2", "esp32h21", "esp32h4", "esp32p4"].includes(norm);
}

export function chipSupportsBle(chipFamily: string): boolean {
  const norm = chipFamily.trim().toLowerCase();
  return !["esp32s2", "esp32p4"].includes(norm);
}

export const BOARD_FIRMWARE_COMPAT_BY_SLUG: Record<
  string,
  BoardFirmwareCompatibilityProfile
> = {
  "esp32-s3-devkitc-1-n16r8": {
    partition_scheme: "dual_ota_16mb",
    psram_mode: "octal",
    flash_mode: "qio",
    flash_freq: "80m",
    bootloader_offset: "0x0",
    ota_app_offset: "0x20000",
    boot_button_gpio: 0,
    usb_interface: "Dual USB-C (UART + Native OTG)",
    supports_wifi: true,
    supports_ble: true,
    supports_ble_wifi_provisioning: true,
    supports_ota_rollback: true,
    firmware_compat_key: "esp32s3-16m-qio-octal8m-dual_ota_16mb-b0",
    connectivity_note: null,
  },
  "seeed-xiao-esp32s3": {
    partition_scheme: "dual_ota_8mb",
    psram_mode: "octal",
    flash_mode: "qio",
    flash_freq: "80m",
    bootloader_offset: "0x0",
    ota_app_offset: "0x20000",
    boot_button_gpio: 0,
    usb_interface: "Native USB-C (CDC/JTAG)",
    supports_wifi: true,
    supports_ble: true,
    supports_ble_wifi_provisioning: true,
    supports_ota_rollback: true,
    firmware_compat_key: "esp32s3-8m-qio-octal8m-dual_ota_8mb-b0",
    connectivity_note: null,
  },
  "esp32-s3-devkitc-1-v1-0": {
    partition_scheme: "dual_ota_8mb",
    psram_mode: "octal",
    flash_mode: "qio",
    flash_freq: "80m",
    bootloader_offset: "0x0",
    ota_app_offset: "0x20000",
    boot_button_gpio: 0,
    usb_interface: "Dual USB-C (UART + Native OTG)",
    supports_wifi: true,
    supports_ble: true,
    supports_ble_wifi_provisioning: true,
    supports_ota_rollback: true,
    firmware_compat_key: "esp32s3-8m-qio-octal8m-dual_ota_8mb-b0",
    connectivity_note: null,
  },
  "esp32-c6-devkitc-1": {
    partition_scheme: "dual_ota_8mb",
    psram_mode: "none",
    flash_mode: "dio",
    flash_freq: "80m",
    bootloader_offset: "0x0",
    ota_app_offset: "0x20000",
    boot_button_gpio: 9,
    usb_interface: "Dual USB-C (UART + Native JTAG)",
    supports_wifi: true,
    supports_ble: true,
    supports_ble_wifi_provisioning: true,
    supports_ota_rollback: true,
    firmware_compat_key: "esp32c6-8m-dio-none-dual_ota_8mb-b9",
    connectivity_note: null,
  },
  "esp32-c3-devkitm-1": {
    partition_scheme: "dual_ota_4mb",
    psram_mode: "none",
    flash_mode: "dio",
    flash_freq: "80m",
    bootloader_offset: "0x0",
    ota_app_offset: "0x20000",
    boot_button_gpio: 9,
    usb_interface: "USB-UART Bridge (CP2102N)",
    supports_wifi: true,
    supports_ble: true,
    supports_ble_wifi_provisioning: true,
    supports_ota_rollback: true,
    firmware_compat_key: "esp32c3-4m-dio-none-dual_ota_4mb-b9",
    connectivity_note: null,
  },
  "esp32-devkitc-v4": {
    partition_scheme: "dual_ota_4mb",
    psram_mode: "none",
    flash_mode: "dio",
    flash_freq: "40m",
    bootloader_offset: "0x1000",
    ota_app_offset: "0x20000",
    boot_button_gpio: 0,
    usb_interface: "USB-UART Bridge (CP2102N)",
    supports_wifi: true,
    supports_ble: true,
    supports_ble_wifi_provisioning: true,
    supports_ota_rollback: true,
    firmware_compat_key: "esp32-4m-dio-none-dual_ota_4mb-b0",
    connectivity_note: null,
  },
  "esp32-s2-devkitc-1": {
    partition_scheme: "dual_ota_4mb",
    psram_mode: "quad",
    flash_mode: "dio",
    flash_freq: "80m",
    bootloader_offset: "0x1000",
    ota_app_offset: "0x20000",
    boot_button_gpio: 0,
    usb_interface: "Dual Micro-USB (UART + Native OTG)",
    supports_wifi: true,
    supports_ble: false,
    supports_ble_wifi_provisioning: false,
    supports_ota_rollback: true,
    firmware_compat_key: "esp32s2-4m-dio-quad2m-dual_ota_4mb-b0",
    connectivity_note:
      "Wi-Fi 4 only (no Bluetooth hardware). Uses WPA2 Setup AP (HomecoreOS-Setup-XXXX) or USB Web Serial for provisioning and recovery.",
  },
  "esp32-c5-devkitc-1": {
    partition_scheme: "dual_ota_8mb",
    psram_mode: "quad",
    flash_mode: "dio",
    flash_freq: "80m",
    bootloader_offset: "0x2000",
    ota_app_offset: "0x20000",
    boot_button_gpio: 28,
    usb_interface: "Dual USB-C (UART + Native JTAG)",
    supports_wifi: true,
    supports_ble: true,
    supports_ble_wifi_provisioning: true,
    supports_ota_rollback: true,
    firmware_compat_key: "esp32c5-8m-dio-quad8m-dual_ota_8mb-b28",
    connectivity_note: null,
  },
  "esp32-c61-devkitc-1": {
    partition_scheme: "dual_ota_8mb",
    psram_mode: "quad",
    flash_mode: "dio",
    flash_freq: "80m",
    bootloader_offset: "0x0",
    ota_app_offset: "0x20000",
    boot_button_gpio: 9,
    usb_interface: "Dual USB-C (UART + Native JTAG)",
    supports_wifi: true,
    supports_ble: true,
    supports_ble_wifi_provisioning: true,
    supports_ota_rollback: true,
    firmware_compat_key: "esp32c61-8m-dio-quad2m-dual_ota_8mb-b9",
    connectivity_note: null,
  },
  "esp8684-devkitm-1": {
    partition_scheme: "dual_ota_4mb",
    psram_mode: "none",
    flash_mode: "dio",
    flash_freq: "60m",
    bootloader_offset: "0x0",
    ota_app_offset: "0x20000",
    boot_button_gpio: 9,
    usb_interface: "USB-UART Bridge (CP2102N)",
    supports_wifi: true,
    supports_ble: true,
    supports_ble_wifi_provisioning: true,
    supports_ota_rollback: true,
    firmware_compat_key: "esp32c2-4m-dio-none-dual_ota_4mb-b9",
    connectivity_note: null,
  },
  "esp32-h2-devkitm-1": {
    partition_scheme: "dual_ota_4mb",
    psram_mode: "none",
    flash_mode: "dio",
    flash_freq: "64m",
    bootloader_offset: "0x0",
    ota_app_offset: "0x20000",
    boot_button_gpio: 9,
    usb_interface: "Dual USB-C (UART + Native JTAG)",
    supports_wifi: false,
    supports_ble: true,
    supports_ble_wifi_provisioning: false,
    supports_ota_rollback: true,
    firmware_compat_key: "esp32h2-4m-dio-none-dual_ota_4mb-b9",
    connectivity_note:
      "IEEE 802.15.4 + BLE 5.3 only (no integrated Wi-Fi radio). Supports encrypted BLE device pairing/config; requires ESP-Hosted Wi-Fi companion or Thread/Matter bridge.",
  },
};

export function resolveBoardFirmwareCompatibility(board: {
  slug?: string | null;
  chip_family: ChipFamily | string;
  chip_variant?: string | null;
  flash_size_mb: number;
  psram_size_mb: number;
  partition_scheme?: PartitionScheme | string | null;
  psram_mode?: PsramMode | string | null;
  flash_mode?: FlashMode | string | null;
  flash_freq?: FlashFreq | string | null;
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
  board_layout?: BoardLayoutSpec | null;
}): BoardFirmwareCompatibilityProfile {
  const known = board.slug ? BOARD_FIRMWARE_COMPAT_BY_SLUG[board.slug] : undefined;
  const chip = String(board.chip_family).trim().toLowerCase();

  const partitionScheme =
    (board.partition_scheme as PartitionScheme | undefined) ??
    known?.partition_scheme ??
    derivePartitionScheme(board.flash_size_mb);

  const psramMode: PsramMode =
    (board.psram_mode as PsramMode | undefined) ??
    known?.psram_mode ??
    (board.psram_size_mb <= 0
      ? "none"
      : chip === "esp32s3" && board.psram_size_mb >= 8
        ? "octal"
        : "quad");

  const flashMode: FlashMode =
    (board.flash_mode as FlashMode | undefined) ??
    known?.flash_mode ??
    (chip === "esp32s3" ? "qio" : "dio");

  const flashFreq: FlashFreq =
    (board.flash_freq as FlashFreq | undefined) ??
    known?.flash_freq ??
    (chip === "esp32c2"
      ? "60m"
      : chip === "esp32h2"
        ? "64m"
        : chip === "esp32"
          ? "40m"
          : "80m");

  const bootloaderOffset =
    board.bootloader_offset ??
    known?.bootloader_offset ??
    defaultBootloaderOffsetForChip(chip);

  const otaAppOffset = board.ota_app_offset ?? known?.ota_app_offset ?? "0x20000";

  const bootButtonGpio =
    typeof board.boot_button_gpio === "number"
      ? board.boot_button_gpio
      : known?.boot_button_gpio ??
        defaultBootButtonGpioForChip(chip, board.slug ?? undefined);

  const usbInterface =
    board.usb_interface ??
    known?.usb_interface ??
    board.board_layout?.hardwareSpecs?.usb ??
    board.board_layout?.usbLabel ??
    "USB-C / UART";

  const supportsWifi =
    typeof board.supports_wifi === "boolean"
      ? board.supports_wifi
      : known?.supports_wifi ?? chipSupportsIntegratedWifi(chip);

  const supportsBle =
    typeof board.supports_ble === "boolean"
      ? board.supports_ble
      : known?.supports_ble ?? chipSupportsBle(chip);

  const supportsBleWifiProvisioning =
    typeof board.supports_ble_wifi_provisioning === "boolean"
      ? board.supports_ble_wifi_provisioning && supportsBle && supportsWifi
      : known?.supports_ble_wifi_provisioning ?? (supportsBle && supportsWifi);

  const supportsOtaRollback =
    typeof board.supports_ota_rollback === "boolean"
      ? board.supports_ota_rollback
      : known?.supports_ota_rollback ?? true;

  const compatKey =
    board.firmware_compat_key ??
    known?.firmware_compat_key ??
    buildFirmwareCompatKey({
      chip_family: chip,
      flash_size_mb: board.flash_size_mb,
      flash_mode: flashMode,
      psram_mode: psramMode,
      psram_size_mb: board.psram_size_mb,
      partition_scheme: partitionScheme,
      boot_button_gpio: bootButtonGpio,
    });

  const connectivityNote =
    board.connectivity_note ??
    known?.connectivity_note ??
    (!supportsWifi
      ? "No integrated Wi-Fi radio on silicon; requires Thread/Matter border router or ESP-Hosted companion."
      : !supportsBle
        ? "No integrated Bluetooth hardware; uses WPA2 Setup AP or USB Web Serial for provisioning."
        : null);

  return {
    partition_scheme: partitionScheme,
    psram_mode: psramMode,
    flash_mode: flashMode,
    flash_freq: flashFreq,
    bootloader_offset: bootloaderOffset,
    ota_app_offset: otaAppOffset,
    boot_button_gpio: bootButtonGpio,
    usb_interface: usbInterface,
    supports_wifi: supportsWifi,
    supports_ble: supportsBle,
    supports_ble_wifi_provisioning: supportsBleWifiProvisioning,
    supports_ota_rollback: supportsOtaRollback,
    firmware_compat_key: compatKey,
    connectivity_note: connectivityNote,
  };
}

export function partitionSchemeFlashMb(
  scheme: string | null | undefined
): number | null {
  if (!scheme) return null;
  const m = scheme.trim().toLowerCase().match(/(\d+)\s*mb$/);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

export function evaluateReleaseCompatibilityForBoard(params: {
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
  board: {
    id?: string | null;
    slug?: string | null;
    manufacturer?: string | null;
    model?: string | null;
    chip_family: string;
    flash_size_mb: number;
    psram_size_mb: number;
    partition_scheme?: string | null;
    psram_mode?: string | null;
    flash_mode?: string | null;
    flash_freq?: string | null;
    bootloader_offset?: string | null;
    boot_button_gpio?: number | null;
    usb_interface?: string | null;
    supports_wifi?: boolean | null;
    supports_ota_rollback?: boolean | null;
    firmware_compat_key?: string | null;
    board_layout?: BoardLayoutSpec | null;
  };
  requirePublished?: boolean;
}): { compatible: boolean; reasons: string[]; warnings: string[] } {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const { release, board } = params;
  const boardCompat = resolveBoardFirmwareCompatibility(board);
  const boardLabel =
    `${board.manufacturer ?? ""} ${board.model ?? board.slug ?? "board"}`.trim();

  if (
    params.requirePublished &&
    release.status &&
    release.status !== "published"
  ) {
    reasons.push(`Release status is "${release.status}" (not published).`);
  } else if (release.status === "deprecated") {
    warnings.push("This release has been marked deprecated by an administrator.");
  }

  const relChip = release.chip_family.trim().toLowerCase();
  const boardChip = board.chip_family.trim().toLowerCase();
  if (relChip !== boardChip) {
    reasons.push(
      `Chip mismatch: firmware targets ${relChip.toUpperCase()} but board uses ${boardChip.toUpperCase()}.`
    );
  }

  if (
    release.target_board_slug &&
    board.slug &&
    release.target_board_slug !== board.slug
  ) {
    const slugs = release.compatible_board_slugs ?? [];
    if (!slugs.includes(board.slug)) {
      reasons.push(
        `Release is pinned to board "${release.target_board_slug}" and does not list "${board.slug}".`
      );
    }
  }

  const hasExplicitIds = (release.compatible_board_ids?.length ?? 0) > 0;
  const hasExplicitSlugs = (release.compatible_board_slugs?.length ?? 0) > 0;
  if (hasExplicitIds || hasExplicitSlugs) {
    const idMatch = Boolean(
      board.id && release.compatible_board_ids?.includes(board.id)
    );
    const slugMatch = Boolean(
      board.slug && release.compatible_board_slugs?.includes(board.slug)
    );
    if (!idMatch && !slugMatch) {
      reasons.push(
        `${boardLabel} is not in the release's validated compatible boards list.`
      );
    }
  }

  const fileFlashMb = (() => {
    const raw = release.files?.find((f) => f.flash_size)?.flash_size;
    if (!raw) return null;
    const m = raw.trim().match(/^(\d+)\s*MB$/i);
    return m ? Number.parseInt(m[1]!, 10) : null;
  })();

  const requiredFlashMb =
    release.flash_size_mb ??
    partitionSchemeFlashMb(release.partition_scheme) ??
    fileFlashMb;

  if (requiredFlashMb && board.flash_size_mb < requiredFlashMb) {
    reasons.push(
      `Insufficient flash: ${boardLabel} has ${board.flash_size_mb}MB flash, firmware requires ${requiredFlashMb}MB.`
    );
  }

  if (
    release.partition_scheme &&
    release.partition_scheme !== boardCompat.partition_scheme
  ) {
    const relPartMb = partitionSchemeFlashMb(release.partition_scheme);
    const boardPartMb = partitionSchemeFlashMb(boardCompat.partition_scheme);
    if (relPartMb && boardPartMb && relPartMb > boardPartMb) {
      reasons.push(
        `Partition layout ${release.partition_scheme} exceeds ${boardCompat.partition_scheme} on ${boardLabel}.`
      );
    } else {
      warnings.push(
        `Partition scheme differs (${release.partition_scheme} vs ${boardCompat.partition_scheme}).`
      );
    }
  }

  if (release.psram_mode && release.psram_mode !== "none") {
    if (boardCompat.psram_mode === "none" || board.psram_size_mb <= 0) {
      reasons.push(
        `PSRAM required: firmware enables ${release.psram_mode.toUpperCase()} PSRAM, but ${boardLabel} has no PSRAM.`
      );
    } else if (release.psram_mode !== boardCompat.psram_mode) {
      reasons.push(
        `PSRAM mode mismatch: firmware compiled for ${release.psram_mode.toUpperCase()} PSRAM, board uses ${boardCompat.psram_mode.toUpperCase()} PSRAM.`
      );
    }
  }

  if (!boardCompat.supports_wifi) {
    warnings.push(
      boardCompat.connectivity_note ??
        `${boardLabel} does not include an integrated Wi-Fi radio.`
    );
  }

  return {
    compatible: reasons.length === 0,
    reasons,
    warnings,
  };
}

export const ESP_IMAGE_CHIP_ID_TO_FAMILY: Record<number, string> = {
  0: "esp32",
  2: "esp32s2",
  5: "esp32c3",
  9: "esp32s3",
  12: "esp32c2",
  13: "esp32c6",
  16: "esp32h2",
  18: "esp32p4",
  20: "esp32c61",
  23: "esp32c5",
  25: "esp32h21",
  28: "esp32h4",
  32: "esp32s31",
};

const ESP_FLASH_SIZE_NIBBLE_TO_MB: Record<number, number> = {
  0: 1,
  1: 2,
  2: 4,
  3: 8,
  4: 16,
  5: 32,
  6: 64,
  7: 128,
};

const ESP_FLASH_MODE_BYTE_TO_NAME: Record<number, FlashMode> = {
  0: "qio",
  1: "qout",
  2: "dio",
  3: "dout",
};

export interface BoardBuildConfigInput {
  id?: string | null;
  slug?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  chip_family: ChipFamily | string;
  chip_variant?: string | null;
  flash_size_mb: number;
  psram_size_mb: number;
  verification_status?: string | null;
  firmware_status?: string | null;
  partition_scheme?: PartitionScheme | string | null;
  psram_mode?: PsramMode | string | null;
  flash_mode?: FlashMode | string | null;
  flash_freq?: FlashFreq | string | null;
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
  board_layout?: BoardLayoutSpec | null;
}

export interface ResolvedBoardBuildConfig {
  valid: boolean;
  errors: string[];
  warnings: string[];
  chipFamily: string | null;
  targetBoardSlug: string | null;
  partitionScheme: PartitionScheme | null;
  psramMode: PsramMode | null;
  flashMode: FlashMode | null;
  flashFreq: FlashFreq | null;
  flashSizeMb: number | null;
  flashSizeLabel: string | null;
  bootloaderOffset: string | null;
  otaAppOffset: string | null;
  bootButtonGpio: number | null;
  supportsWifi: boolean | null;
  supportsBle: boolean | null;
  supportsBleWifiProvisioning: boolean | null;
  firmwareCompatKey: string | null;
}

function formatBoardLabel(b: BoardBuildConfigInput): string {
  const full = `${b.manufacturer ?? ""} ${b.model ?? b.slug ?? "Board"}`.trim();
  return full || "Selected board";
}

export function getBoardSelectionConflictReason(
  candidate: BoardBuildConfigInput,
  selectedBoards: BoardBuildConfigInput[]
): string | null {
  if (candidate.firmware_status === "unsupported") {
    return "Unsupported";
  }
  if (candidate.verification_status === "needs_verification") {
    return "Unverified";
  }
  if (selectedBoards.length === 0) return null;

  const anchor = selectedBoards[0]!;
  const anchorCompat = resolveBoardFirmwareCompatibility(anchor);
  const candCompat = resolveBoardFirmwareCompatibility(candidate);

  const anchorChip = String(anchor.chip_family).trim().toLowerCase();
  const candChip = String(candidate.chip_family).trim().toLowerCase();
  if (candChip !== anchorChip) {
    return `Chip mismatch (${candChip.toUpperCase()})`;
  }
  if (
    candidate.flash_size_mb !== anchor.flash_size_mb ||
    candCompat.partition_scheme !== anchorCompat.partition_scheme
  ) {
    return `Requires ${candidate.flash_size_mb}MB (${candCompat.partition_scheme})`;
  }
  if (candCompat.psram_mode !== anchorCompat.psram_mode) {
    return `PSRAM ${candCompat.psram_mode}`;
  }
  if (
    candCompat.flash_mode !== anchorCompat.flash_mode ||
    candCompat.flash_freq !== anchorCompat.flash_freq
  ) {
    return `Flash ${candCompat.flash_mode.toUpperCase()} ${candCompat.flash_freq}`;
  }
  if (
    candCompat.bootloader_offset !== anchorCompat.bootloader_offset ||
    candCompat.ota_app_offset !== anchorCompat.ota_app_offset
  ) {
    return `Offset ${candCompat.bootloader_offset}`;
  }
  if (candCompat.supports_wifi !== anchorCompat.supports_wifi) {
    return candCompat.supports_wifi ? "Wi-Fi mismatch" : "No Wi-Fi";
  }
  if (candCompat.supports_ble !== anchorCompat.supports_ble) {
    return candCompat.supports_ble ? "BLE mismatch" : "No BLE";
  }
  return null;
}

export function resolveBoardSelectionBuildConfig(
  boards: BoardBuildConfigInput[]
): ResolvedBoardBuildConfig {
  const empty: ResolvedBoardBuildConfig = {
    valid: false,
    errors: [],
    warnings: [],
    chipFamily: null,
    targetBoardSlug: null,
    partitionScheme: null,
    psramMode: null,
    flashMode: null,
    flashFreq: null,
    flashSizeMb: null,
    flashSizeLabel: null,
    bootloaderOffset: null,
    otaAppOffset: null,
    bootButtonGpio: null,
    supportsWifi: null,
    supportsBle: null,
    supportsBleWifiProvisioning: null,
    firmwareCompatKey: null,
  };

  if (!boards || boards.length === 0) {
    return {
      ...empty,
      errors: [
        "Select at least one compatible board from the catalog to automatically resolve firmware hardware targets.",
      ],
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const b of boards) {
    if (b.firmware_status === "unsupported") {
      errors.push(
        `Board "${formatBoardLabel(b)}" is marked unsupported and cannot be assigned firmware releases.`
      );
    } else if (b.verification_status === "needs_verification") {
      errors.push(
        `Board "${formatBoardLabel(b)}" has not completed catalog verification and cannot be assigned firmware releases.`
      );
    }
  }

  const profiles = boards.map((b) => ({
    board: b,
    chip: String(b.chip_family).trim().toLowerCase(),
    compat: resolveBoardFirmwareCompatibility(b),
  }));

  const uniqueChips = [...new Set(profiles.map((p) => p.chip))];
  if (uniqueChips.length > 1) {
    errors.push(
      `Selected boards span multiple chip families (${uniqueChips.map((c) => c.toUpperCase()).join(", ")}). Each silicon family requires separate firmware binaries—upload separate releases or use a CI ZIP package.`
    );
  }

  const uniqueLayouts = [
    ...new Set(
      profiles.map((p) => `${p.board.flash_size_mb}MB (${p.compat.partition_scheme})`)
    ),
  ];
  if (uniqueLayouts.length > 1) {
    errors.push(
      `Selected boards require separate flash / partition layouts (${uniqueLayouts.join(" vs ")}). Upload separate firmware binaries for each flash size.`
    );
  }

  const uniquePsram = [
    ...new Set(profiles.map((p) => p.compat.psram_mode)),
  ];
  if (uniquePsram.length > 1) {
    errors.push(
      `Selected boards use incompatible PSRAM modes (${uniquePsram.join(" vs ")}). Upload separate binaries matching each board's PSRAM hardware.`
    );
  }

  const uniqueFlashParams = [
    ...new Set(
      profiles.map((p) => `${p.compat.flash_mode.toUpperCase()} ${p.compat.flash_freq}`)
    ),
  ];
  if (uniqueFlashParams.length > 1) {
    errors.push(
      `Selected boards require different SPI flash settings (${uniqueFlashParams.join(" vs ")}). Upload separate binaries matching each board's flash mode and frequency.`
    );
  }

  const uniqueOffsets = [
    ...new Set(
      profiles.map(
        (p) => `boot:${p.compat.bootloader_offset}/ota:${p.compat.ota_app_offset}`
      )
    ),
  ];
  if (uniqueOffsets.length > 1) {
    errors.push(
      `Selected boards require different bootloader/OTA offsets (${uniqueOffsets.join(" vs ")}). Upload separate firmware binaries.`
    );
  }

  const uniqueWifi = [...new Set(profiles.map((p) => p.compat.supports_wifi))];
  if (uniqueWifi.length > 1) {
    errors.push(
      "Selected boards mix integrated Wi-Fi boards with non-Wi-Fi boards. Upload separate releases for each radio configuration."
    );
  }

  const anchor = profiles[0]!;
  if (!anchor.compat.supports_wifi) {
    warnings.push(
      anchor.compat.connectivity_note ??
        `${formatBoardLabel(anchor.board)} does not include an integrated Wi-Fi radio.`
    );
  }

  if (errors.length > 0) {
    return {
      ...empty,
      errors,
      warnings,
    };
  }

  return {
    valid: true,
    errors: [],
    warnings,
    chipFamily: anchor.chip,
    targetBoardSlug: boards.length === 1 ? (anchor.board.slug ?? null) : null,
    partitionScheme: anchor.compat.partition_scheme,
    psramMode: anchor.compat.psram_mode,
    flashMode: anchor.compat.flash_mode,
    flashFreq: anchor.compat.flash_freq,
    flashSizeMb: anchor.board.flash_size_mb,
    flashSizeLabel: `${anchor.board.flash_size_mb}MB`,
    bootloaderOffset: anchor.compat.bootloader_offset,
    otaAppOffset: anchor.compat.ota_app_offset,
    bootButtonGpio: anchor.compat.boot_button_gpio,
    supportsWifi: anchor.compat.supports_wifi,
    supportsBle: anchor.compat.supports_ble,
    supportsBleWifiProvisioning: anchor.compat.supports_ble_wifi_provisioning,
    firmwareCompatKey: anchor.compat.firmware_compat_key,
  };
}

export interface EspIdfBinaryInspection {
  valid: boolean;
  error?: string;
  detectedChipFamily?: string | null;
  detectedFlashMb?: number | null;
  detectedFlashMode?: FlashMode | null;
  embeddedAppVersion?: string | null;
  embeddedProjectName?: string | null;
  versionMismatchWarning?: string | null;
  hasPartitionTableAt0x8000?: boolean;
  maxPartitionEndBytes?: number | null;
  bootloaderOffsetChecked: string;
}

function readNullTerminatedAscii(bytes: Uint8Array, offset: number, maxLen: number): string | null {
  if (offset + maxLen > bytes.byteLength) return null;
  let end = offset;
  while (end < offset + maxLen && bytes[end] !== 0) {
    const ch = bytes[end] ?? 0;
    if (ch < 0x20 || ch > 0x7e) return null;
    end++;
  }
  if (end === offset) return null;
  let out = "";
  for (let i = offset; i < end; i++) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out.trim() || null;
}

function extractEspAppDescMetadata(
  bytes: Uint8Array,
  appImageOffset: number
): { embeddedAppVersion: string | null; embeddedProjectName: string | null } {
  // esp_app_desc_t sits immediately after esp_image_header_t (24B) + esp_image_segment_header_t (8B)
  const descOffset = appImageOffset + 32;
  if (bytes.byteLength < descOffset + 80) {
    return { embeddedAppVersion: null, embeddedProjectName: null };
  }
  const magic =
    ((bytes[descOffset] ?? 0) |
      ((bytes[descOffset + 1] ?? 0) << 8) |
      ((bytes[descOffset + 2] ?? 0) << 16) |
      ((bytes[descOffset + 3] ?? 0) << 24)) >>>
    0;
  if (magic !== 0xabcd5432) {
    return { embeddedAppVersion: null, embeddedProjectName: null };
  }
  const embeddedAppVersion = readNullTerminatedAscii(bytes, descOffset + 16, 32);
  const embeddedProjectName = readNullTerminatedAscii(bytes, descOffset + 48, 32);
  return { embeddedAppVersion, embeddedProjectName };
}

export function inspectEspIdfBinary(
  bytes: Uint8Array,
  fileType: "usb_factory" | "ota_app",
  expected?: {
    chipFamily?: string | null;
    flashSizeMb?: number | null;
    bootloaderOffset?: string | null;
    version?: string | null;
  }
): EspIdfBinaryInspection {
  const expectedChip = expected?.chipFamily
    ? expected.chipFamily.trim().toLowerCase()
    : null;
  const bootOffsetHex =
    expected?.bootloaderOffset ??
    (expectedChip ? defaultBootloaderOffsetForChip(expectedChip) : "0x0");
  const bootOffset = Number.parseInt(bootOffsetHex, 16) || 0;

  if (bytes.byteLength < 64) {
    return {
      valid: false,
      error: "File is too small to be a valid ESP-IDF .bin image (minimum 64 bytes).",
      bootloaderOffsetChecked: bootOffsetHex,
    };
  }
  if (bytes.byteLength > 16 * 1024 * 1024) {
    return {
      valid: false,
      error: "Firmware binary exceeds maximum 16 MB image limit.",
      bootloaderOffsetChecked: bootOffsetHex,
    };
  }

  let headerOffset = 0;
  let hasPartitionTableAt0x8000 = false;
  let maxPartitionEndBytes: number | null = null;

  if (fileType === "ota_app") {
    if (bytes[0] !== 0xe9) {
      return {
        valid: false,
        error:
          "Invalid ESP-IDF OTA application binary (missing 0xE9 magic header at byte 0).",
        bootloaderOffsetChecked: "0x0",
      };
    }
    if (
      bytes.byteLength >= 0x8002 &&
      bytes[0x8000] === 0xaa &&
      bytes[0x8001] === 0x50
    ) {
      return {
        valid: false,
        error:
          "Uploaded file appears to be a merged USB factory image (partition table detected at 0x8000), not an OTA app binary.",
        hasPartitionTableAt0x8000: true,
        bootloaderOffsetChecked: "0x0",
      };
    }
  } else {
    if (bytes.byteLength >= 0x3000) {
      headerOffset = bootOffset;
      if (bytes[bootOffset] !== 0xe9) {
        if (bootOffset > 0 && bytes[0] === 0xe9) {
          return {
            valid: false,
            error: `Invalid USB factory binary for ${expectedChip ? expectedChip.toUpperCase() : "selected board"}: bootloader header was found at 0x0 instead of expected offset ${bootOffsetHex}.`,
            bootloaderOffsetChecked: bootOffsetHex,
          };
        }
        return {
          valid: false,
          error: `Invalid ESP-IDF USB factory binary (missing 0xE9 bootloader magic header at ${bootOffsetHex}).`,
          bootloaderOffsetChecked: bootOffsetHex,
        };
      }
    } else if (
      bytes[0] !== 0xe9 &&
      (bytes.byteLength <= bootOffset || bytes[bootOffset] !== 0xe9)
    ) {
      return {
        valid: false,
        error: `Invalid ESP-IDF USB factory binary (missing 0xE9 magic header at ${bootOffsetHex}).`,
        bootloaderOffsetChecked: bootOffsetHex,
      };
    } else {
      headerOffset = bytes[0] === 0xe9 ? 0 : bootOffset;
    }

    if (
      bytes.byteLength >= 0x8020 &&
      bytes[0x8000] === 0xaa &&
      bytes[0x8001] === 0x50
    ) {
      hasPartitionTableAt0x8000 = true;
      let maxEnd = 0;
      for (let i = 0; i < 16; i++) {
        const pos = 0x8000 + i * 32;
        if (pos + 16 > bytes.byteLength) break;
        if (bytes[pos] !== 0xaa || bytes[pos + 1] !== 0x50) break;
        const partOffset =
          ((bytes[pos + 4] ?? 0) |
            ((bytes[pos + 5] ?? 0) << 8) |
            ((bytes[pos + 6] ?? 0) << 16) |
            ((bytes[pos + 7] ?? 0) << 24)) >>>
          0;
        const partSize =
          ((bytes[pos + 8] ?? 0) |
            ((bytes[pos + 9] ?? 0) << 8) |
            ((bytes[pos + 10] ?? 0) << 16) |
            ((bytes[pos + 11] ?? 0) << 24)) >>>
          0;
        if (partOffset + partSize > maxEnd) {
          maxEnd = partOffset + partSize;
        }
      }
      if (maxEnd > 0) {
        maxPartitionEndBytes = maxEnd;
        if (
          expected?.flashSizeMb &&
          maxEnd > expected.flashSizeMb * 1024 * 1024
        ) {
          return {
            valid: false,
            error: `USB factory partition table requires ${(maxEnd / (1024 * 1024)).toFixed(1)}MB flash, exceeding selected board flash (${expected.flashSizeMb}MB).`,
            hasPartitionTableAt0x8000,
            maxPartitionEndBytes,
            bootloaderOffsetChecked: bootOffsetHex,
          };
        }
      }
    }
  }

  let detectedChipFamily: string | null = null;
  let detectedFlashMb: number | null = null;
  let detectedFlashMode: FlashMode | null = null;

  const hasExtendedEspIdfHeader =
    bytes.byteLength >= headerOffset + 24 &&
    bytes[headerOffset + 8] === 0xee &&
    (bytes[headerOffset + 23] === 0 || bytes[headerOffset + 23] === 1);

  if (hasExtendedEspIdfHeader) {
    const chipId =
      (bytes[headerOffset + 12] ?? 0) | ((bytes[headerOffset + 13] ?? 0) << 8);
    detectedChipFamily = ESP_IMAGE_CHIP_ID_TO_FAMILY[chipId] ?? null;
    const flashModeByte = bytes[headerOffset + 2] ?? 0;
    detectedFlashMode = ESP_FLASH_MODE_BYTE_TO_NAME[flashModeByte] ?? null;
    const flashSizeNibble = ((bytes[headerOffset + 3] ?? 0) >> 4) & 0x0f;
    detectedFlashMb = ESP_FLASH_SIZE_NIBBLE_TO_MB[flashSizeNibble] ?? null;

    if (
      expectedChip &&
      detectedChipFamily &&
      detectedChipFamily !== expectedChip
    ) {
      return {
        valid: false,
        error: `Binary targets ${detectedChipFamily.toUpperCase()} (chip ID ${chipId}), which is incompatible with selected ${expectedChip.toUpperCase()} board(s).`,
        detectedChipFamily,
        detectedFlashMb,
        detectedFlashMode,
        hasPartitionTableAt0x8000,
        maxPartitionEndBytes,
        bootloaderOffsetChecked: bootOffsetHex,
      };
    }

    if (
      fileType === "usb_factory" &&
      expected?.flashSizeMb &&
      detectedFlashMb &&
      detectedFlashMb > expected.flashSizeMb
    ) {
      return {
        valid: false,
        error: `USB factory binary header specifies ${detectedFlashMb}MB flash, which exceeds selected board flash (${expected.flashSizeMb}MB).`,
        detectedChipFamily,
        detectedFlashMb,
        detectedFlashMode,
        hasPartitionTableAt0x8000,
        maxPartitionEndBytes,
        bootloaderOffsetChecked: bootOffsetHex,
      };
    }
  }

  let embeddedAppVersion: string | null = null;
  let embeddedProjectName: string | null = null;
  let versionMismatchWarning: string | null = null;

  if (fileType === "ota_app") {
    const appMeta = extractEspAppDescMetadata(bytes, 0);
    embeddedAppVersion = appMeta.embeddedAppVersion;
    embeddedProjectName = appMeta.embeddedProjectName;
    const normVer = (v: string) => v.trim().replace(/^v/i, "");
    if (
      expected?.version &&
      embeddedAppVersion &&
      normVer(expected.version) !== normVer(embeddedAppVersion)
    ) {
      const cleanEmbedded = normVer(embeddedAppVersion);
      const cleanExpected = normVer(expected.version);
      versionMismatchWarning = `OTA binary embeds esp_app_desc_t version v${cleanEmbedded} (reports v${cleanEmbedded}), which differs from release version v${cleanExpected}. Rebuilding with HOMECORE_FW_VERSION="${cleanExpected}" ensures devices report the updated version after reboot.`;
    }
  }

  return {
    valid: true,
    detectedChipFamily,
    detectedFlashMb,
    detectedFlashMode,
    embeddedAppVersion,
    embeddedProjectName,
    versionMismatchWarning,
    hasPartitionTableAt0x8000,
    maxPartitionEndBytes,
    bootloaderOffsetChecked: bootOffsetHex,
  };
}
