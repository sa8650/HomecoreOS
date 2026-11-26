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
  ControllerSensorCompatibilityReport,
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
  OnboardingState,
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
  /** Mandatory four-step onboarding state, authoritative on the server. */
  onboarding?: OnboardingState;
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
  room_id?: string | null;
  board_profile_id: string | null;
  custom_board_profile_id: string | null;
  name: string;
  hardware_uid: string | null;
  board_model: string;
  chip_variant: string;
  flash_size_mb: number;
  psram_size_mb: number;
  firmware_version: string | null;
  installed_firmware_release_id?: string | null;
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
  sensor_compatibility?: ControllerSensorCompatibilityReport | null;
  // Unified Controller / Node role (see packages/shared/src/board-role.ts)
  board_role?: "controller" | "node";
  node_comm_mode?: "espnow" | "wifi_mqtt" | "offline" | null;
  comm_mode?: "espnow" | "wifi_mqtt" | "offline" | null;
  espnow_channel?: number | null;
  node_link_state?:
    | "linked"
    | "controller_lost"
    | "reconnecting"
    | "standalone"
    | "unassigned"
    | null;
  assigned_controller_id?: string | null;
  assigned_controller_name?: string | null;
  connected_node_count?: number;
  hosted_node_ids?: string[];
  reported_nodes?: Array<{
    id: string;
    link: "linked" | "controller_lost" | "reconnecting" | "standalone" | "unassigned";
    rssi?: number | null;
    channel?: number | null;
    seq?: number | null;
  }> | null;
  espnow_telemetry?: {
    channel?: number | null;
    rssi?: number | null;
    keepaliveTxSeq?: number | null;
    ackRxSeq?: number | null;
    ackConfirmed?: boolean | null;
    nodeReportedLinkState?:
      | "linked"
      | "controller_lost"
      | "reconnecting"
      | "standalone"
      | "unassigned"
      | null;
    nodeReportedAt?: string | null;
    controllerHeardAt?: string | null;
    controllerReportedRssi?: number | null;
    controllerReportedChannel?: number | null;
    rosterReportedAt?: string | null;
  } | null;
  config_revision?: number;
  last_synced_config_revision?: number;
  pending_config_sync?: boolean;
  role_changed_at?: string | null;
  node_last_linked_at?: string | null;
  // Worker-authorized binding and route state (separate from live connectivity).
  binding_id?: string | null;
  binding_state?: "unpaired" | "pairing" | "assigned" | "verified" | "revoked" | null;
  binding_generation?: number | null;
  cloud_route?: "direct_node_mqtt" | "controller_mqtt" | "connecting" | "unavailable" | null;
  connection_status?: string | null;
  offline_recovery_instructions?: string[];
}

export interface DeviceItem {
  id: string;
  account_id: string;
  home_id: string;
  room_id: string | null;
  board_instance_id: string;
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
  board_instance_id: string;
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
  board_instance_id: string;
  name: string;
  sensor_type: string;
  gpio_pin: number | null;
  i2c_address?: string | null;
  driver_id?: string | null;
  model?: string | null;
  resources?: import("@homecoreos/shared").SensorResourcesConfig | null;
  physical_sensor_id?: string | null;
  unit: string;
  last_value: number | null;
  last_raw_payload: Record<string, unknown> | null;
  threshold_enabled?: boolean;
  threshold_value?: number | null;
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

/** Where "Import Board" reads official hardware profiles from. */
export type BoardImportProvider =
  | "seeed_xiao"
  | "espressif"
  | "waveshare"
  | "community_partner";

export interface BoardImportSourceCheck {
  key: "pin_table" | "manifest" | "images" | "listing";
  label: string;
  /**
   * confirmed: the official source agrees with the profile.
   * conflict: it disagrees, so the board is held back for review.
   * unreachable / not_available / reference: nothing to compare against.
   */
  status: "confirmed" | "conflict" | "unreachable" | "not_available" | "reference";
  detail: string;
  url?: string;
}

export interface BoardImportCandidate {
  slug: string;
  provider: BoardImportProvider;
  name: string;
  status: "new" | "in_library" | "removed" | "unsupported";
  statusDetail: string;
  /** Whether an import request may include this board. */
  selectable: boolean;
  verification: "verified" | "needs_verification";
  verificationNote: string;
  existingBoardId: string | null;
  /** The profile that would be added. Null when the board cannot be imported. */
  board: BoardProfileItem | null;
  highlights: string[];
  sources: Array<{ label: string; url: string }>;
  checks: BoardImportSourceCheck[];
}

export interface BoardImportPreview {
  provider: BoardImportProvider;
  providerLabel: string;
  fetchedAt: string;
  /** How many official sources answered. 0 means the preview is offline. */
  liveSourcesReached: number;
  sourceUrls: string[];
  notes: string[];
  candidates: BoardImportCandidate[];
}

export interface BoardImportOutcome {
  slug: string;
  name: string;
  action: "imported" | "restored" | "skipped";
  detail: string;
  boardId: string | null;
  published: boolean;
  verification: "verified" | "needs_verification" | null;
}

export interface BoardImportRun {
  runId: string | null;
  provider: BoardImportProvider;
  providerLabel: string;
  status: "succeeded" | "partial" | "failed";
  requestedCount: number;
  importedCount: number;
  restoredCount: number;
  skippedCount: number;
  needsVerificationCount: number;
  outcomes: BoardImportOutcome[];
  /** What was read from the official sources during this run. */
  sourceNotes: string[];
  /** The source notes plus the counts, as stored in the sync history. */
  summaryNotes: string;
}

/** What depends on a catalog board, and whether it may be removed. */
export interface BoardUsageInfo {
  controllerCount: number;
  savedByAccountCount: number;
  firmwareReleaseCount: number;
  canRemove: boolean;
  blockers: string[];
  consequences: string[];
}

/** Admin Customer Monitoring (read-only). See docs/ADMIN_CUSTOMER_MONITORING.md. */
export type BoardHealthStatus = "healthy" | "warning" | "offline" | "unknown";

export interface BoardEntityCounts {
  devices: number;
  devicesOnline: number;
  sensors: number;
  sensorsOnline: number;
  sensorsStale: number;
  switches: number;
  switchesOnline: number;
}

export interface BoardHealth {
  status: BoardHealthStatus;
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

export interface MonitoredBoardProfile {
  id: string;
  slug: string;
  manufacturer: string;
  model: string;
  revision?: string | null;
  chip_family: string;
  chip_variant: string;
  flash_size_mb: number;
  psram_size_mb: number;
  firmware_status?: string | null;
  verification_status?: string | null;
  catalog_category?: string | null;
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
}

export interface MonitoredBoard {
  id: string;
  account_id: string;
  home_id: string | null;
  room_id: string | null;
  board_profile_id: string | null;
  custom_board_profile_id: string | null;
  name: string;
  hardware_uid: string | null;
  board_model: string;
  chip_variant: string;
  flash_size_mb: number;
  psram_size_mb: number;
  firmware_version: string | null;
  status: string;
  pairing_status?: string | null;
  board_role?: "controller" | "node" | string | null;
  comm_mode?: string | null;
  node_link_state?: string | null;
  assigned_controller_id?: string | null;
  assigned_controller_name?: string | null;
  attached_node_count?: number;
  mqtt_connected: boolean;
  wifi_connected?: boolean | null;
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
  connection_history?: Array<{ event: string; at: string; ip?: string }>;
  created_at: string;
  updated_at: string;
  config_revision?: number | null;
  config_hash?: string | null;
  last_synced_config_revision?: number | null;
  last_config_published_at?: string | null;
  last_config_synced_at?: string | null;
  pending_config_sync?: boolean | null;
  heartbeat_interval_sec?: number | null;
  detected_flash_size_mb?: number | null;
  detected_chip_name?: string | null;
  reported_board_slug?: string | null;
  provisioning_transport?: string | null;
  installed_firmware_release_id?: string | null;
  reported_driver_manifest_hash?: string | null;
  board_profile: MonitoredBoardProfile | null;
  custom_board_profile: MonitoredBoardProfile | null;
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
  health: BoardHealth;
}

export interface CustomerMonitoringData {
  account: {
    id: string;
    name: string;
    slug: string;
    status: string;
    created_at: string;
    paused_at?: string | null;
    owner_user_id: string;
  };
  owner: {
    id: string;
    email: string;
    full_name: string;
    created_at: string | null;
  } | null;
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
  settings: {
    offlineTimeoutSeconds: number;
    heartbeatIntervalSeconds: number;
  };
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
  boards: MonitoredBoard[];
}

export interface BoardDetailData {
  board: MonitoredBoard;
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
  driver_manifest?: Record<string, unknown> | null;
  compiled_sensor_drivers?: string[];
  supported_sensor_types?: string[];
  manifest_version?: string | null;
  manifest_hash?: string | null;
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
  board_instance_id: string;
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
  boardInstanceId: string;
  controllerName: string;
  /** Unified role: a Node's update is relayed through its Controller. */
  boardRole?: "controller" | "node";
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
  board_instance_id: string | null;
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

// ── Dynamic Island Action Button ─────────────────────────────────────────────
export type {
  ActionButtonCategory,
  ActionButtonColor,
  ActionButtonGesture,
  ActionButtonGestures,
  ActionButtonIcon,
  ActionButtonOp,
  ActionButtonStep,
} from "@homecoreos/shared";

export interface ActionButtonConfigItem {
  id: string;
  name: string;
  icon: string;
  color: string;
  category: import("@homecoreos/shared").ActionButtonCategory;
  config: import("@homecoreos/shared").ActionButtonGestures;
  confirmationRequired: boolean;
  isEnabled: boolean;
  isActive: boolean;
  lastExecutedAt: string | null;
  lastExecutionStatus: "success" | "partial" | "failed" | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  states?: { on: number; off: number } | null;
}

export interface ActionButtonExecutionResult {
  ok: boolean;
  execution: {
    ok: boolean;
    gesture: import("@homecoreos/shared").ActionButtonGesture;
    executedCount: number;
    failedCount: number;
    status: "success" | "partial" | "failed";
    results: Array<{
      stepId: string;
      kind: string;
      summary: string;
      status: "done" | "failed";
      error?: string;
      acknowledged?:
        | { kind: "switch"; switchId: string; isOn: boolean }
        | { kind: "device"; deviceId: string; state: string };
    }>;
    states: { on: number; off: number } | null;
    executedAt: string;
  };
}
