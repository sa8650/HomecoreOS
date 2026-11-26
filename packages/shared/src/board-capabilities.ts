/**
 * Canonical, board-ID-driven connectivity capabilities.
 *
 * The JSON next to this file is the single source of truth. It is consumed by
 * this typed wrapper, by the Worker binding authority, by the web console and
 * by the firmware generator (which emits a compile-time C header from it).
 * Nothing here infers a capability from a chip-family name: an unknown board ID
 * has no radio, no roles and no transports until it is explicitly registered.
 */
import registry from "./board-capabilities.data.json";

export const BOARD_CAPABILITY_SCHEMA_VERSION = registry.schema_version;

export type BoardSupportStatus = "supported" | "experimental" | "unsupported";
export type FirmwareFramework = "esp_idf" | "arduino_esp8266";
export type BoardRoleCapability = "controller" | "node";
export type BoardConnectionTransport = "wifi_mqtt" | "espnow";
export type ProvisioningMethod = "ble" | "softap" | "usb_recovery";

/** Account enrollment is separate from Controller/Node binding. */
export type BindingState = "unpaired" | "pairing" | "assigned" | "verified" | "revoked";
/** ESP-NOW link state is deliberately separate from binding state. */
export type EspNowConnectionState =
  | "unavailable"
  | "searching"
  | "linked"
  | "lost"
  | "reconnecting";
/** How cloud traffic currently reaches this board. */
export type CloudRouteState =
  | "direct_node_mqtt"
  | "controller_mqtt"
  | "connecting"
  | "unavailable";

export interface BoardCapability {
  board_id: string;
  chip_target: string;
  chip_variant: string;
  firmware: {
    framework: FirmwareFramework;
    sdk_version: string;
    build_profile: string;
  };
  radio: {
    wifi: boolean;
    mqtt: boolean;
    espnow: boolean;
    espnow_protocol: "esp-now-v1" | null;
    /** v1-compatible payload ceiling for mixed-generation installations. */
    espnow_mtu_bytes: number;
    espnow_peer_limit: number;
    espnow_encrypted_peer_limit: number;
    ble_provisioning: boolean;
    softap_provisioning: boolean;
    usb_recovery: boolean;
  };
  memory: {
    flash_mb: number;
    psram_mb: number;
    psram_mode: "none" | "quad" | "octal";
    nominal_sram_kb: number;
  };
  limits: {
    max_controller_nodes: number;
    max_tested_controller_nodes: number;
    mqtt_buffer_bytes: number;
    connectivity_queue_depth: number;
    telemetry_interval_sec: number;
    keepalive_ms: number;
    link_timeout_ms: number;
    recovery_window_ms: number;
    discovery_interval_ms: number;
    connectivity_task_stack_bytes: number;
  };
  roles: {
    supported: BoardRoleCapability[];
    default: BoardRoleCapability | null;
  };
  transports: BoardConnectionTransport[];
  support: {
    status: BoardSupportStatus;
    firmware_build_verified: boolean;
    hardware_tested: boolean;
    notes: string[];
  };
}

const typedRegistry = registry as unknown as {
  schema_version: number;
  description: string;
  chip_wireless_policy: Record<
    string,
    { integrated_wifi: boolean; external_wireless_companion_required: boolean; network_roles_enabled: boolean }
  >;
  boards: BoardCapability[];
};

export const BOARD_CAPABILITIES: Readonly<Record<string, BoardCapability>> = Object.freeze(
  Object.fromEntries(typedRegistry.boards.map((b) => [b.board_id, b]))
);

export const BOARD_CAPABILITY_IDS: readonly string[] = Object.freeze(
  typedRegistry.boards.map((b) => b.board_id)
);

export const CHIP_WIRELESS_POLICY: Readonly<typeof typedRegistry.chip_wireless_policy> =
  Object.freeze(typedRegistry.chip_wireless_policy);

/**
 * Unknown boards are explicitly capabilityless. Callers must never fall back to
 * "it is an ESP32, therefore ..." — the registry is authoritative.
 */
export function getBoardCapabilities(boardId: string | null | undefined): BoardCapability | null {
  if (!boardId) return null;
  return BOARD_CAPABILITIES[boardId.trim().toLowerCase()] ?? null;
}

export function supportsRole(
  boardId: string | null | undefined,
  role: BoardRoleCapability
): boolean {
  return Boolean(getBoardCapabilities(boardId)?.roles.supported.includes(role));
}

export function supportsTransport(
  boardId: string | null | undefined,
  transport: BoardConnectionTransport
): boolean {
  return Boolean(getBoardCapabilities(boardId)?.transports.includes(transport));
}

export function supportsProvisioning(
  boardId: string | null | undefined,
  method: ProvisioningMethod
): boolean {
  const radio = getBoardCapabilities(boardId)?.radio;
  if (!radio) return false;
  if (method === "ble") return radio.ble_provisioning;
  if (method === "softap") return radio.softap_provisioning;
  return radio.usb_recovery;
}

/** P4-class targets without a companion are never given a network role. */
export function requiresExternalWirelessCompanion(chipTarget: string | null | undefined): boolean {
  if (!chipTarget) return false;
  return Boolean(CHIP_WIRELESS_POLICY[chipTarget.trim().toLowerCase()]?.external_wireless_companion_required);
}

export function isBoardSupportedForNetwork(boardId: string | null | undefined): boolean {
  const board = getBoardCapabilities(boardId);
  if (!board || board.support.status === "unsupported") return false;
  return board.roles.supported.length > 0;
}

/** Maximum Nodes a Controller may *host*, enforced by its own board profile. */
export function maxHostedNodes(boardId: string | null | undefined): number {
  const board = getBoardCapabilities(boardId);
  if (!board || !supportsRole(boardId, "controller")) return 0;
  return board.limits.max_controller_nodes;
}

export function normalizeBindingState(value: unknown): BindingState {
  if (value === "unpaired" || value === "pairing" || value === "assigned" || value === "verified" || value === "revoked") {
    return value;
  }
  // Legacy devices have no binding state. They were enrolled and implicitly
  // trusted before bindings existed; treat them as verified, never as unpaired.
  return "verified";
}

export function normalizeEspNowState(value: unknown): EspNowConnectionState {
  if (
    value === "unavailable" ||
    value === "searching" ||
    value === "linked" ||
    value === "lost" ||
    value === "reconnecting"
  ) {
    return value;
  }
  return "unavailable";
}

export function normalizeCloudRoute(value: unknown): CloudRouteState {
  if (
    value === "direct_node_mqtt" ||
    value === "controller_mqtt" ||
    value === "connecting" ||
    value === "unavailable"
  ) {
    return value;
  }
  return "unavailable";
}

/** Monotonic generation: invalid values never roll authority backwards. */
export function normalizeGeneration(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export function isNewerGeneration(candidate: unknown, current: number): boolean {
  return normalizeGeneration(candidate) > normalizeGeneration(current);
}

/** Explicit alias used by the Worker binding authority. */
export const normalizeBindingGeneration = normalizeGeneration;

export type UserConnectionStatus =
  | "Connected directly"
  | "Connected through Controller"
  | "Reconnecting automatically"
  | "Local connection active"
  | "Cloud unavailable"
  | "Device not supported for this connection method";

/**
 * One truthful user-facing status. Binding state is shown separately and is
 * never used to claim that a connection works.
 */
export function userConnectionStatus(input: {
  boardId?: string | null;
  role?: unknown;
  bindingState?: unknown;
  espnowState?: unknown;
  cloudRoute?: unknown;
  online?: boolean;
  localActive?: boolean;
}): UserConnectionStatus {
  if (!isBoardSupportedForNetwork(input.boardId)) {
    return "Device not supported for this connection method";
  }
  const route = normalizeCloudRoute(input.cloudRoute);
  const link = normalizeEspNowState(input.espnowState);
  const binding = normalizeBindingState(input.bindingState);
  if (route === "direct_node_mqtt") return "Connected directly";
  if (route === "controller_mqtt" && link === "linked" && binding === "verified") {
    return "Connected through Controller";
  }
  if (link === "searching" || link === "reconnecting" || link === "lost" || route === "connecting") {
    return "Reconnecting automatically";
  }
  if (input.localActive) return "Local connection active";
  if (input.online === false) return "Cloud unavailable";
  return "Cloud unavailable";
}

export interface RouteCandidateInput {
  /** Node has its own live MQTT session. */
  nodeMqttHealthy: boolean;
  /** Assigned Controller has a live MQTT session. */
  controllerMqttHealthy: boolean;
  /** ESP-NOW link is bidirectionally verified for the current binding generation. */
  espnowLinked: boolean;
  /** Controller roster contains this Node for the current generation. */
  inRoster: boolean;
  /** Telemetry is fresh enough to be trusted. */
  telemetryFresh: boolean;
}

/**
 * Single route policy, shared by Worker delivery and firmware route selection.
 * The preferred route is Controller relay once it is genuinely healthy, but a
 * working Node MQTT session is never treated as dead during the handoff.
 */
export function selectCloudRoute(input: RouteCandidateInput): CloudRouteState {
  if (!input.telemetryFresh) return "unavailable";
  const relayReady =
    input.espnowLinked && input.inRoster && input.controllerMqttHealthy;
  if (relayReady) return "controller_mqtt";
  if (input.nodeMqttHealthy) return "direct_node_mqtt";
  /* ESP-NOW by itself is a local link, not a cloud route. */
  return "unavailable";
}

export interface RouteChangeInput {
  current: CloudRouteState;
  next: CloudRouteState;
  nextReady: boolean;
  confirmed: boolean;
}

/** Make-before-break: never close the current route until the next is confirmed. */
export function canClosePreviousRoute(input: RouteChangeInput): boolean {
  if (input.current === input.next) return false;
  if (!input.nextReady || !input.confirmed) return false;
  return input.next === "direct_node_mqtt" || input.next === "controller_mqtt";
}

export function bindingBlocker(
  boardId: string | null | undefined,
  role: BoardRoleCapability
): string | null {
  const board = getBoardCapabilities(boardId);
  if (!board) return "This board has no verified capability profile.";
  if (!board.roles.supported.includes(role)) {
    return role === "controller"
      ? "This board cannot host a Controller: its radio and resource profile do not allow it."
      : "This board cannot operate as a Node with the selected connection method.";
  }
  if (board.support.status === "unsupported") {
    return "This board is not supported for Controller/Node connectivity.";
  }
  return null;
}
