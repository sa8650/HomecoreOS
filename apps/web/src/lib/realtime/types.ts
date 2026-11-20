/**
 * Shared real-time protocol types.
 *
 * The Worker publishes one JSON envelope per state change batch to
 * `homecore/<accountId>/realtime/events` (MQTT over WebSocket). The browser
 * never invents events; it only applies them and reconciles against
 * `/api/realtime/snapshot` after a reconnect.
 */
export type RealtimeEntity =
  | "board"
  | "switch"
  | "device"
  | "sensor"
  | "automation"
  | "notification"
  | "home";

export type RealtimeEventAction =
  | "created"
  | "updated"
  | "deleted"
  | "state"
  | "run"
  | "alert";

/**
 * `desired`   the user asked for this state
 * `accepted`  the Worker/broker took the command, hardware not confirmed yet
 * `confirmed` hardware reported the state
 * `failed`    the command never reached the device
 */
export type RealtimeEventPhase = "desired" | "accepted" | "confirmed" | "failed";

export interface RealtimeEvent {
  entity: RealtimeEntity;
  action: RealtimeEventAction;
  id: string;
  /** Server timestamp; used only to order deliveries. */
  ts: string;
  phase?: RealtimeEventPhase;
  patch?: Record<string, unknown>;
  /**
   * Row-derived entity version (`last_changed_at`, `last_reading_at`, …). The
   * snapshot reports the same value for the same row, which is what lets a
   * reconnect reconcile an entity without reloading it.
   */
  version?: string;
}

export interface RealtimeEnvelope {
  v: 1;
  accountId: string;
  sentAt: string;
  events: RealtimeEvent[];
}

export interface RealtimeSnapshotEntity {
  id: string;
  version: string;
  [key: string]: unknown;
}

export interface RealtimeSnapshot {
  v: 1;
  accountId: string;
  serverTime: string;
  entities: {
    boards: RealtimeSnapshotEntity[];
    switches: RealtimeSnapshotEntity[];
    devices: RealtimeSnapshotEntity[];
    sensors: RealtimeSnapshotEntity[];
    automations: RealtimeSnapshotEntity[];
    homes: RealtimeSnapshotEntity[];
  };
}

export interface RealtimeCredentialPayload {
  brokerUrl: string;
  username: string;
  password: string;
  topic: string;
  clientIdPrefix: string;
  /** Deterministic per-session broker client id (one socket per session). */
  clientId?: string;
  expiresAt: string;
}

export interface RealtimeConfigResponse {
  enabled: boolean;
  accountId?: string;
  reason?: string;
  transport?: string;
  credential?: RealtimeCredentialPayload;
}

export type RealtimeConnectionState =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "degraded"
  | "disabled";

export interface RealtimeStatus {
  state: RealtimeConnectionState;
  /** true once at least one batch has been applied in this tab. */
  synced: boolean;
  lastEventAt: string | null;
  lastSnapshotAt: string | null;
  lastError: string | null;
  reconnectAttempt: number;
  /** This tab owns the MQTT socket; other tabs receive its broadcasts. */
  isLeader: boolean;
  tabCount: number;
  reason: string | null;
}

export interface RealtimeBatch {
  events: RealtimeEvent[];
  entities: RealtimeEntity[];
  /** Set when the store repaired drift after a reconnect; pages should reload. */
  resync: boolean;
  receivedAt: string;
}

/** Entity kinds mapped to the HTTP cache prefixes they invalidate. */
export const REALTIME_CACHE_PREFIXES: Record<RealtimeEntity, string[]> = {
  board: ["/api/board-instances", "/api/homes/overview", "/api/activity", "/api/planner"],
  switch: ["/api/switches", "/api/homes/overview", "/api/activity"],
  device: ["/api/devices", "/api/homes/overview", "/api/activity"],
  sensor: ["/api/sensors", "/api/homes/overview", "/api/activity"],
  automation: ["/api/automations", "/api/activity"],
  notification: ["/api/notifications"],
  home: [
    "/api/homes",
    "/api/switches",
    "/api/devices",
    "/api/sensors",
    "/api/activity",
    "/api/planner",
  ],
};

export const SNAPSHOT_ENTITY_KINDS = {
  boards: "board",
  switches: "switch",
  devices: "device",
  sensors: "sensor",
  automations: "automation",
  homes: "home",
} as const satisfies Record<keyof RealtimeSnapshot["entities"], RealtimeEntity>;
