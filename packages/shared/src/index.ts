import type {
  FlashFreq,
  FlashMode,
  PartitionScheme,
  PsramMode,
} from "./board-firmware-compat";

export type AccountStatus = "active" | "paused" | "pending_deletion";

export type StaffRole = "owner" | "administrator" | "operator" | "viewer";

export type PlatformAdminRole = "super_admin" | "operator" | "support";

export type FirmwareChannel = "stable" | "beta" | "development";

export type FirmwareArtifactType = "ota_app" | "usb_factory";

export const SUPPORTED_CHIP_FAMILIES = [
  "esp32",
  "esp32s2",
  "esp32s3",
  "esp32s31",
  "esp32c2",
  "esp32c3",
  "esp32c5",
  "esp32c6",
  "esp32c61",
  "esp32h2",
  "esp32h21",
  "esp32h4",
  "esp32p4",
] as const;

export type ChipFamily = (typeof SUPPORTED_CHIP_FAMILIES)[number];

export function chipFamilyLabel(chipFamily: string): string {
  const norm = chipFamily.trim().toLowerCase();
  if (!norm) return "";
  if (norm === "esp32") return "ESP32";
  if (norm.startsWith("esp32")) {
    return `ESP32-${norm.slice(5).toUpperCase()}`;
  }
  return norm.toUpperCase();
}

export type BoardCatalogCategory = "official_espressif" | "partner" | "custom";
export type BoardVerificationStatus = "verified" | "needs_verification";
export type BoardFirmwareStatus =
  | "firmware_supported"
  | "catalog_only"
  | "build_pending"
  | "unsupported";

export interface BoardHeaderPin {
  position: number;
  headerName: string;
  pinName: string;
  gpioPin: number | null;
  kind: "gpio" | "power" | "ground" | "reset" | "nc";
  voltage?: string;
  aliases?: string[];
  note?: string;
}

export interface BoardHardwareSpecs {
  processor: string;
  wireless: string;
  usb: string;
  usbPortCount?: 1 | 2;
  usbConnector?: "usb-c" | "micro-usb";
  buttons: string;
  resetLabel?: "RST" | "EN" | "RESET";
  modulePackage?: "wroom" | "mini" | "solo" | "xiao" | "custom";
  hasUartBridge?: boolean;
}

export interface ResolvedBoardHardwareSpecs extends BoardHardwareSpecs {
  memory: string;
  usbPortCount: 1 | 2;
  usbConnector: "usb-c" | "micro-usb";
  resetLabel: "RST" | "EN" | "RESET";
  modulePackage: "wroom" | "mini" | "solo" | "xiao" | "custom";
  hasUartBridge: boolean;
}

export interface BoardLayoutSpec {
  formFactor: "devkit" | "xiao" | "feather" | "custom";
  orientation: "vertical";
  aspectRatio: number;
  usbEdge: "top" | "bottom";
  usbLabel?: string;
  antennaEdge?: "top" | "bottom";
  antennaLabel?: string;
  imageFrame?: {
    pinTopPct: number;
    pinBottomPct: number;
  };
  hardwareSpecs?: BoardHardwareSpecs;
  leftHeader: {
    name: string;
    pins: BoardHeaderPin[];
  };
  rightHeader: {
    name: string;
    pins: BoardHeaderPin[];
  };
  onboardFeatures?: Array<{
    label: string;
    gpioPin: number | null;
    kind:
      | "led"
      | "rgb_led"
      | "button"
      | "usb"
      | "uart"
      | "psram"
      | "flash"
      | "camera"
      | "sd";
    note: string;
  }>;
}

export const ROOM_TYPES = [
  "living_room",
  "bedroom",
  "kitchen",
  "dining",
  "bathroom",
  "toilet",
  "hallway",
  "patio",
  "office",
  "garage",
  "utility",
  "custom",
] as const;

export type RoomType = (typeof ROOM_TYPES)[number];

export const ROOM_TYPE_LABELS: Record<RoomType, string> = {
  living_room: "Living Room",
  bedroom: "Bedroom",
  kitchen: "Kitchen",
  dining: "Dining Room",
  bathroom: "Bathroom",
  toilet: "Restroom / WC",
  hallway: "Hallway / Entry",
  patio: "Patio / Balcony",
  office: "Office / Study",
  garage: "Garage",
  utility: "Utility / Laundry",
  custom: "Custom Space",
};

export function inferRoomTypeFromName(name: string): RoomType {
  const lower = name.toLowerCase();
  if (lower.includes("bed") || lower.includes("master") || lower.includes("guest")) return "bedroom";
  if (lower.includes("kitchen")) return "kitchen";
  if (lower.includes("dining")) return "dining";
  if (lower.includes("bath") || lower.includes("shower")) return "bathroom";
  if (lower.includes("toilet") || lower.includes("wc") || lower.includes("restroom")) return "toilet";
  if (lower.includes("hall") || lower.includes("corridor") || lower.includes("foyer") || lower.includes("stair")) return "hallway";
  if (lower.includes("patio") || lower.includes("balcony") || lower.includes("terrace") || lower.includes("deck")) return "patio";
  if (lower.includes("office") || lower.includes("study") || lower.includes("desk")) return "office";
  if (lower.includes("garage") || lower.includes("car")) return "garage";
  if (lower.includes("utility") || lower.includes("laundry") || lower.includes("lab")) return "utility";
  if (lower.includes("living") || lower.includes("lounge") || lower.includes("family")) return "living_room";
  return "living_room";
}

export type WallSide = "top" | "right" | "bottom" | "left";

export type FloorStyle = "wood" | "tile" | "stone" | "carpet";

export interface FloorDoor {
  id: string;
  wall: WallSide;
  /** Offset along the wall from 0.1 to 0.9 */
  offset: number;
  width?: number;
  hinge?: "start" | "end";
  swing?: "in" | "out";
}

export interface FloorWindow {
  id: string;
  wall: WallSide;
  /** Offset along the wall from 0.1 to 0.9 */
  offset: number;
  width?: number;
}

export interface RoomLayoutConfig {
  floorStyle?: FloorStyle;
  doors?: FloorDoor[];
  windows?: FloorWindow[];
  rotation?: number;
}

export interface RegionalTimezoneOption {
  value: string;
  label: string;
  region:
    | "Global"
    | "Americas"
    | "Europe"
    | "Asia"
    | "Middle East"
    | "Africa"
    | "Oceania";
}

export const REGIONAL_TIMEZONES: RegionalTimezoneOption[] = [
  { value: "UTC", label: "UTC — Coordinated Universal Time", region: "Global" },
  { value: "America/New_York", label: "America/New_York (Eastern Time)", region: "Americas" },
  { value: "America/Chicago", label: "America/Chicago (Central Time)", region: "Americas" },
  { value: "America/Denver", label: "America/Denver (Mountain Time)", region: "Americas" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles (Pacific Time)", region: "Americas" },
  { value: "America/Toronto", label: "America/Toronto (Eastern Canada)", region: "Americas" },
  { value: "America/Sao_Paulo", label: "America/Sao_Paulo (Brasília)", region: "Americas" },
  { value: "America/Mexico_City", label: "America/Mexico_City (Central Mexico)", region: "Americas" },
  { value: "Europe/London", label: "Europe/London (UK / GMT / BST)", region: "Europe" },
  { value: "Europe/Berlin", label: "Europe/Berlin (Central European)", region: "Europe" },
  { value: "Europe/Paris", label: "Europe/Paris (Central European)", region: "Europe" },
  { value: "Europe/Amsterdam", label: "Europe/Amsterdam (Netherlands)", region: "Europe" },
  { value: "Europe/Madrid", label: "Europe/Madrid (Spain)", region: "Europe" },
  { value: "Europe/Rome", label: "Europe/Rome (Italy)", region: "Europe" },
  { value: "Europe/Warsaw", label: "Europe/Warsaw (Poland)", region: "Europe" },
  { value: "Europe/Istanbul", label: "Europe/Istanbul (Turkey)", region: "Europe" },
  { value: "Asia/Dhaka", label: "Asia/Dhaka (Bangladesh)", region: "Asia" },
  { value: "Asia/Kolkata", label: "Asia/Kolkata (India)", region: "Asia" },
  { value: "Asia/Karachi", label: "Asia/Karachi (Pakistan)", region: "Asia" },
  { value: "Asia/Singapore", label: "Asia/Singapore (Singapore)", region: "Asia" },
  { value: "Asia/Bangkok", label: "Asia/Bangkok (Indochina)", region: "Asia" },
  { value: "Asia/Jakarta", label: "Asia/Jakarta (Western Indonesia)", region: "Asia" },
  { value: "Asia/Shanghai", label: "Asia/Shanghai (China)", region: "Asia" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo (Japan)", region: "Asia" },
  { value: "Asia/Seoul", label: "Asia/Seoul (South Korea)", region: "Asia" },
  { value: "Asia/Dubai", label: "Asia/Dubai (UAE / Gulf)", region: "Middle East" },
  { value: "Asia/Riyadh", label: "Asia/Riyadh (Saudi Arabia)", region: "Middle East" },
  { value: "Africa/Cairo", label: "Africa/Cairo (Egypt)", region: "Africa" },
  { value: "Africa/Lagos", label: "Africa/Lagos (West Africa)", region: "Africa" },
  { value: "Africa/Johannesburg", label: "Africa/Johannesburg (South Africa)", region: "Africa" },
  { value: "Australia/Sydney", label: "Australia/Sydney (Eastern Australia)", region: "Oceania" },
  { value: "Australia/Melbourne", label: "Australia/Melbourne (Victoria)", region: "Oceania" },
  { value: "Pacific/Auckland", label: "Pacific/Auckland (New Zealand)", region: "Oceania" },
];

export function isValidIanaTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveEffectiveTimezone(
  userTimezone: string | null | undefined,
  platformDefaultTimezone: string | null | undefined
): string {
  if (userTimezone && isValidIanaTimezone(userTimezone)) {
    return userTimezone;
  }
  if (platformDefaultTimezone && isValidIanaTimezone(platformDefaultTimezone)) {
    return platformDefaultTimezone;
  }
  return "UTC";
}

export interface GpioPinDefinition {
  pin: number;
  label: string;
  board_pin_name?: string | null;
  header_side?: "left" | "right" | null;
  header_position?: number | null;
  board_note?: string | null;
  capabilities: {
    digital_in: boolean;
    digital_out: boolean;
    pwm: boolean;
    adc: boolean;
    i2c: boolean;
    spi: boolean;
    uart: boolean;
    touch: boolean;
    pull_up: boolean;
    pull_down: boolean;
  };
  restrictions: {
    input_only: boolean;
    reserved: boolean;
    reserved_reason?: string;
    strapping_pin: boolean;
    strapping_note?: string;
    flash_psram_conflict: boolean;
    usb_jtag_conflict: boolean;
  };
}

export interface BoardProfileSpec {
  id?: string;
  slug: string;
  manufacturer: string;
  model: string;
  revision: string;
  chip_family: ChipFamily;
  chip_variant: string;
  flash_size_mb: number;
  psram_size_mb: number;
  usb_vid?: string;
  usb_pid?: string;
  catalog_category?: BoardCatalogCategory;
  series?: string | null;
  image_url?: string | null;
  pinout_image_url?: string | null;
  docs_url?: string | null;
  datasheet_url?: string | null;
  source_url?: string | null;
  source_provider?: string | null;
  verification_status?: BoardVerificationStatus;
  firmware_status?: BoardFirmwareStatus;
  partition_scheme?: PartitionScheme | null;
  psram_mode?: PsramMode | null;
  flash_mode?: FlashMode | null;
  flash_freq?: FlashFreq | null;
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
  revision_notes?: string | null;
  gpio_definitions: GpioPinDefinition[];
}

export const SUPPORTED_SENSOR_TYPES = [
  "temperature_dht22",
  "humidity_dht22",
  "temperature_ds18b20",
  "temperature_bme280",
  "humidity_bme280",
  "pressure_bme280",
  "motion_pir",
  "contact_reed",
  "light_bh1750",
  "analog_voltage",
] as const;

export type SupportedSensorType = (typeof SUPPORTED_SENSOR_TYPES)[number];

export const SUPPORTED_DEVICE_TYPES = [
  "relay",
  "light",
  "dimmer_pwm",
  "fan",
  "tv",
  "lock",
  "valve",
  "buzzer",
  "status_led",
] as const;

export type SupportedDeviceType = (typeof SUPPORTED_DEVICE_TYPES)[number];

export type NotificationScope = "user" | "admin";
export type NotificationSeverity = "info" | "success" | "warning" | "danger";

export interface UserNotificationPreferences {
  controller_offline_online: boolean;
  device_disconnected: boolean;
  sensor_alerts: boolean;
  automation_failures: boolean;
  firmware_updates: boolean;
  firmware_install_results: boolean;
  security_events: boolean;
}

export interface AdminNotificationPreferences {
  new_user_registrations: boolean;
  controller_activity: boolean;
  firmware_publishing: boolean;
  platform_errors: boolean;
  service_health_alerts: boolean;
}

export const DEFAULT_USER_NOTIFICATION_PREFERENCES: UserNotificationPreferences = {
  controller_offline_online: true,
  device_disconnected: true,
  sensor_alerts: true,
  automation_failures: true,
  firmware_updates: true,
  firmware_install_results: true,
  security_events: true,
};

export const DEFAULT_ADMIN_NOTIFICATION_PREFERENCES: AdminNotificationPreferences = {
  new_user_registrations: true,
  controller_activity: true,
  firmware_publishing: true,
  platform_errors: true,
  service_health_alerts: true,
};

export interface FirmwareCompatibleBoardItem {
  id: string;
  slug: string;
  manufacturer: string;
  model: string;
  chip_family: string;
  chip_variant: string;
  flash_size_mb: number;
  psram_size_mb: number;
  partition_scheme?: string | null;
  psram_mode?: string | null;
  firmware_compat_key?: string | null;
  boot_button_gpio?: number | null;
  usb_interface?: string | null;
  supports_wifi?: boolean;
  supports_ble?: boolean;
  supports_ble_wifi_provisioning?: boolean;
  firmware_status?: BoardFirmwareStatus | string | null;
}

export function parseFlashSizeMb(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d+)\s*MB$/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function validateFirmwareBoardsCompatibility(params: {
  chipFamily: string;
  flashSizeMb?: number | null;
  psramMode?: string | null;
  boards: Array<{
    id: string;
    slug?: string;
    manufacturer: string;
    model: string;
    chip_family: string;
    flash_size_mb: number;
    psram_size_mb?: number;
    psram_mode?: string | null;
  }>;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const targetChip = params.chipFamily.trim().toLowerCase();
  const targetPsram = params.psramMode ? params.psramMode.trim().toLowerCase() : null;

  for (const board of params.boards) {
    if (board.chip_family.trim().toLowerCase() !== targetChip) {
      errors.push(
        `Board "${board.manufacturer} ${board.model}" (${board.chip_family.toUpperCase()}) is incompatible with ${targetChip.toUpperCase()} firmware.`
      );
    }
    if (
      params.flashSizeMb &&
      params.flashSizeMb > 0 &&
      board.flash_size_mb < params.flashSizeMb
    ) {
      errors.push(
        `Board "${board.manufacturer} ${board.model}" has ${board.flash_size_mb}MB flash, which cannot fit ${params.flashSizeMb}MB firmware.`
      );
    }
    if (targetPsram && targetPsram !== "none") {
      const boardPsramSize = board.psram_size_mb ?? 0;
      const boardPsramMode =
        board.psram_mode ??
        (boardPsramSize <= 0
          ? "none"
          : board.chip_family.toLowerCase() === "esp32s3" && boardPsramSize >= 8
            ? "octal"
            : "quad");
      if (boardPsramMode === "none" || boardPsramSize <= 0) {
        errors.push(
          `Board "${board.manufacturer} ${board.model}" has no PSRAM, incompatible with ${targetPsram.toUpperCase()} PSRAM firmware.`
        );
      } else if (boardPsramMode !== targetPsram) {
        errors.push(
          `Board "${board.manufacturer} ${board.model}" uses ${boardPsramMode.toUpperCase()} PSRAM, incompatible with ${targetPsram.toUpperCase()} PSRAM firmware.`
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export type ControllerPairingStatus =
  | "pending"
  | "paired"
  | "revoked"
  | "recovery_pending";

export const CONTROLLER_TRASH_RETENTION_DAYS = 30;

function parseVersionParts(raw: string): {
  nums: number[];
  prerelease: string[];
} | null {
  const cleaned = raw.trim().replace(/^v/i, "");
  if (!cleaned) return null;
  const [core, ...preRest] = cleaned.split("-");
  const coreSegments = core.split(".");
  if (coreSegments.length === 0 || coreSegments.some((s) => !/^\d+$/.test(s))) {
    return null;
  }
  const nums = coreSegments.map((s) => Number.parseInt(s, 10));
  const prerelease = preRest.length > 0 ? preRest.join("-").split(".") : [];
  return { nums, prerelease };
}

export function compareFirmwareVersions(a: string, b: string): number {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (!pa || !pb) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  }
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const na = pa.nums[i] ?? 0;
    const nb = pb.nums[i] ?? 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  // Same core numbers: stable release > prerelease
  if (pa.prerelease.length === 0 && pb.prerelease.length > 0) return 1;
  if (pa.prerelease.length > 0 && pb.prerelease.length === 0) return -1;
  const preLen = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < preLen; i++) {
    const sa = pa.prerelease[i];
    const sb = pb.prerelease[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    const numA = /^\d+$/.test(sa) ? Number.parseInt(sa, 10) : null;
    const numB = /^\d+$/.test(sb) ? Number.parseInt(sb, 10) : null;
    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA > numB ? 1 : -1;
    } else if (sa !== sb) {
      return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: "base" });
    }
  }
  return 0;
}

export function isNewerFirmwareVersion(
  candidate: string,
  current: string | null | undefined
): boolean {
  if (!candidate || !candidate.trim()) return false;
  if (!current || !current.trim()) return true;
  return compareFirmwareVersions(candidate, current) > 0;
}

export * from "./board-validation";
export * from "./board-catalog-data";
export * from "./board-firmware-compat";
export * from "./ble-provisioning";
export * from "./automations";
export * from "./flow-graph";
export * from "./planner";
