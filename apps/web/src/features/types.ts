import type {
  AccountStatus,
  AdminNotificationPreferences,
  AutomationActionItem,
  AutomationConditionsConfig,
  AutomationTriggerConfig,
  BoardCatalogCategory,
  BoardFirmwareStatus,
  BoardLayoutSpec,
  BoardVerificationStatus,
  ChipFamily,
  ControllerPairingStatus,
  FirmwareBuildStatus,
  FirmwareChannel,
  FirmwareCompatibleBoardItem,
  FirmwareReleaseStatus,
  FlashFreq,
  FlashMode,
  FlowExecutionTrace,
  FlowGraph,
  GpioPinDefinition,
  NotificationScope,
  NotificationSeverity,
  PartitionScheme,
  PlatformAdminRole,
  PsramMode,
  RoomLayoutConfig,
  RoomType,
  StaffRole,
  UserNotificationPreferences,
} from "@homecoreos/shared";

export interface UserSessionData {
  user: {
    id: string;
    email: string;
    fullName: string;
    avatarSeed?: string | null;
    appearancePreference: "light" | "dark" | "system";
    timezone: string | null;
  };
  account: {
    id: string;
    name: string;
    slug: string;
    status: AccountStatus;
    staffRole: StaffRole;
  };
  accounts: Array<{
    id: string;
    name: string;
    slug: string;
    status: AccountStatus;
    staffRole: StaffRole;
  }>;
  platformDefaultTimezone?: string;
  effectiveTimezone?: string;
}

export interface AdminSessionData {
  admin: {
    id: string;
    email: string;
    fullName: string;
    role: PlatformAdminRole;
    appearancePreference?: string;
    timezone?: string | null;
  };
  platformDefaultTimezone?: string;
  effectiveTimezone?: string;
}

export interface HomeItem {
  id: string;
  account_id: string;
  name: string;
  timezone: string;
}

export interface RoomItem {
  id: string;
  account_id: string;
  home_id: string;
  name: string;
  icon: string;
  floor_order: number;
  grid_col_span: number;
  room_type?: RoomType;
  floor_x?: number;
  floor_y?: number;
  floor_w?: number;
  floor_h?: number;
  layout_config?: RoomLayoutConfig;
}

export interface ControllerItem {
  id: string;
  account_id: string;
  home_id: string;
  board_catalog_id: string | null;
  custom_board_id: string | null;
  name: string;
  hardware_uid: string | null;
  board_model: string;
  chip_variant: string;
  flash_size_mb: number;
  psram_size_mb: number;
  firmware_version: string | null;
  status: "pending" | "online" | "offline" | "disconnected" | "reset_pending" | "updating";
  pairing_status?: ControllerPairingStatus;
  wifi_connected?: boolean;
  mqtt_connected: boolean;
  wifi_ssid: string | null;
  wifi_rssi: number | null;
  local_ip: string | null;
  last_heartbeat_at: string | null;
  last_communication_at: string | null;
  wifi_last_connected_at?: string | null;
  mqtt_last_connected_at?: string | null;
  last_error?: string | null;
  last_error_at?: string | null;
  paired_at: string | null;
  detected_flash_size_mb?: number | null;
  detected_chip_name?: string | null;
  reported_board_slug?: string | null;
  ble_setup_pin?: string | null;
  provisioning_transport?: "ble" | "softap" | "usb" | "manual" | null;
  deleted_at?: string | null;
  trash_expires_at?: string | null;
  days_remaining?: number;
  recoverable_counts?: {
    switches: number;
    devices: number;
    sensors: number;
  };
  connection_history: Array<{ event: string; at: string; ip?: string }>;
  mqtt?: {
    mqtt_username: string;
    mqtt_client_id: string;
    topic_prefix: string;
    emqx_synced: boolean;
    status: string;
    last_rotated_at?: string;
  } | null;
  board_compat?: {
    slug: string;
    model: string;
    chip_family: string;
    partition_scheme: string | null;
    boot_button_gpio: number;
    usb_interface: string | null;
    supports_wifi: boolean;
    supports_ble?: boolean;
    supports_ble_wifi_provisioning?: boolean;
    connectivity_note: string | null;
  };
  offline_recovery_instructions?: string[];
}

export interface DeviceItem {
  id: string;
  account_id: string;
  home_id: string;
  room_id: string | null;
  controller_id: string;
  name: string;
  device_type: string;
  gpio_pin: number;
  state: string;
  is_online: boolean;
}

export interface SwitchItem {
  id: string;
  account_id: string;
  home_id: string;
  room_id: string | null;
  controller_id: string;
  name: string;
  gpio_pin: number;
  is_on: boolean;
  inverted: boolean;
  is_online: boolean;
  last_changed_at: string | null;
}

export interface SensorItem {
  id: string;
  account_id: string;
  home_id: string;
  room_id: string | null;
  controller_id: string;
  name: string;
  sensor_type: string;
  gpio_pin: number | null;
  i2c_address?: string | null;
  unit: string;
  last_value: number | null;
  last_raw_payload: Record<string, unknown> | null;
  is_online: boolean;
  last_reading_at: string | null;
}

export interface BoardProfileItem {
  id: string;
  slug: string;
  manufacturer: string;
  model: string;
  revision: string;
  chip_family: ChipFamily;
  chip_variant: string;
  flash_size_mb: number;
  psram_size_mb: number;
  usb_vid?: string | null;
  usb_pid?: string | null;
  description?: string | null;
  is_available?: boolean;
  is_validated?: boolean;
  compatible_firmware_count?: number;
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
  last_synced_at?: string | null;
  gpio_definitions: GpioPinDefinition[];
}

export interface BoardSyncRunItem {
  id: string;
  source_name: string;
  status: "running" | "succeeded" | "partial" | "failed";
  discovered_count: number;
  inserted_count: number;
  updated_count: number;
  needs_verification_count: number;
  source_urls: string[];
  summary_notes: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface AutomationItem {
  id: string;
  account_id: string;
  home_id: string;
  name: string;
  folder_name?: string;
  description: string | null;
  enabled: boolean;
  execution_mode: "cloud" | "controller" | "hybrid";
  trigger_config: AutomationTriggerConfig;
  conditions_config?: AutomationConditionsConfig;
  actions_config: AutomationActionItem[];
  flow_graph?: FlowGraph | null;
  flow_version?: number;
  last_run_trace?: FlowExecutionTrace | null;
  last_execution_status: string;
  last_executed_at: string | null;
  last_error: string | null;
}

export interface FirmwareFileItem {
  id: string;
  release_id: string;
  file_type: "ota_app" | "usb_factory" | "manifest";
  file_name: string;
  size_bytes: number;
  sha256: string;
  flash_address: string | null;
  flash_mode: string | null;
  flash_freq: string | null;
  flash_size: string | null;
  validated: boolean;
}

export interface FirmwareReleaseItem {
  id: string;
  name: string;
  version: string;
  channel: FirmwareChannel;
  chip_family: ChipFamily;
  target_board_slug?: string | null;
  partition_scheme?: PartitionScheme | string | null;
  psram_mode?: PsramMode | string | null;
  flash_mode?: string | null;
  flash_freq?: string | null;
  flash_size_mb?: number | null;
  build_status?: FirmwareBuildStatus;
  hardware_verified?: boolean;
  verified_board_ids?: string[];
  verified_board_slugs?: string[];
  verification_notes?: string | null;
  rollback_from_release_id?: string | null;
  superseded_by_release_id?: string | null;
  ci_run_url?: string | null;
  ci_commit_sha?: string | null;
  compatible_board_ids: string[];
  compatible_board_slugs?: string[];
  compatible_boards?: FirmwareCompatibleBoardItem[];
  ota_available: boolean;
  usb_available: boolean;
  status: FirmwareReleaseStatus;
  release_notes: string;
  published_at: string | null;
  created_at?: string;
  files: FirmwareFileItem[];
  ota_stats?: {
    total: number;
    succeeded: number;
    failed: number;
    active: number;
  };
}

export interface NotificationItem {
  id: string;
  scope: NotificationScope;
  account_id: string | null;
  user_id: string | null;
  category: string;
  event_key: string;
  preference_key: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
}

export type NotificationPreferenceKey =
  | keyof UserNotificationPreferences
  | keyof AdminNotificationPreferences;

export interface FirmwareUpdateHistoryItem {
  id: string;
  account_id: string;
  controller_id: string;
  controller_name?: string;
  release_id: string | null;
  update_type: "ota" | "usb_factory";
  previous_version: string | null;
  target_version: string;
  status:
    | "pending"
    | "downloading"
    | "flashing"
    | "verifying"
    | "rebooting"
    | "succeeded"
    | "rolled_back"
    | "failed"
    | "cancelled";
  progress_percent: number;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface ApplicableFirmwareUpdateItem {
  controllerId: string;
  controllerName: string;
  boardModel: string;
  controllerStatus: string;
  currentVersion: string | null;
  availableRelease: {
    id: string;
    name: string;
    version: string;
    channel: FirmwareChannel;
    chip_family: ChipFamily;
    target_board_slug?: string | null;
    partition_scheme?: string | null;
    psram_mode?: string | null;
    hardware_verified?: boolean;
    release_notes: string;
    published_at: string | null;
  };
  activeUpdate: FirmwareUpdateHistoryItem | null;
}

export interface ActivityItem {
  id: string;
  account_id: string | null;
  controller_id: string | null;
  category: string;
  action: string;
  summary: string;
  created_at: string;
}

export interface OverviewData {
  summary: {
    totalRooms: number;
    totalDevices: number;
    activeDevices: number;
    totalSwitches: number;
    activeSwitches: number;
    totalSensors: number;
    totalControllers: number;
    onlineControllers: number;
    offlineControllers: number;
  };
  homes: HomeItem[];
  rooms: RoomItem[];
  controllers: ControllerItem[];
  devices: DeviceItem[];
  switches: SwitchItem[];
  sensors: SensorItem[];
  recentActivity: ActivityItem[];
}
