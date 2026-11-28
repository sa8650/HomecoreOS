/**
 * Per-board live Log domain model.
 *
 * The Log answers one question: *what happened on this individual board?*
 * Every entry belongs to exactly one board instance and is read back only by
 * users of the owning account. A Controller's Log never contains the Log of
 * the Nodes it hosts: a Node appears in a Controller's Log only as the peer of
 * a communication event.
 *
 * The vocabulary is deliberately strict. A command is never "done" because a
 * publish succeeded:
 *
 *   created       the console accepted the request
 *   sent          the Worker handed the command to a transport (publish only)
 *   received      the destination board confirmed it received the command
 *   acknowledged  the sender received a valid acknowledgement for it
 *   executed      the destination board confirmed it applied the command
 *   rejected      the destination board refused the command
 *   duplicate     the destination board had already seen this command
 *   failed        the command could not be delivered or could not be applied
 *   timeout       no confirmation arrived before the deadline
 *   offline       the destination board was not reachable
 */

export const BOARD_LOG_CATEGORIES = [
  "communication",
  "device_activity",
  "connection",
  "command",
  "binding",
  "system",
] as const;

export type BoardLogCategory = (typeof BOARD_LOG_CATEGORIES)[number];

export const BOARD_LOG_SEVERITIES = [
  "info",
  "success",
  "warning",
  "error",
] as const;

export type BoardLogSeverity = (typeof BOARD_LOG_SEVERITIES)[number];

/**
 * Transport / origin of an entry. `mqtt` and `espnow` are the two board
 * transports, `http` is the board's own HTTPS report to the Worker, `worker`
 * is a server-side fact and `user` is an operator action.
 */
export const BOARD_LOG_METHODS = [
  "mqtt",
  "espnow",
  "http",
  "wifi",
  "worker",
  "user",
] as const;

export type BoardLogMethod = (typeof BOARD_LOG_METHODS)[number];

/**
 * Lifecycle states an entry can carry. Kept open (a plain string) so a new
 * transport can report a status without a schema migration, but the values
 * below are the ones the console renders specially.
 */
export const BOARD_LOG_STATUSES = [
  "created",
  "sent",
  "received",
  "acknowledged",
  "executed",
  "rejected",
  "duplicate",
  "failed",
  "timeout",
  "offline",
  "online",
  "connected",
  "disconnected",
  "linked",
  "controller_lost",
  "standalone",
  "unassigned",
  "reconnecting",
  "route_changed",
  "assigned",
  "unpaired",
  "verified",
  "revoked",
  "role_changed",
  "generation_mismatch",
  "on",
  "off",
  "active",
  "inactive",
  "error",
  "reboot",
] as const;

export type BoardLogStatus = (typeof BOARD_LOG_STATUSES)[number];

export interface BoardLogEntry {
  id: string;
  boardInstanceId: string;
  category: BoardLogCategory;
  severity: BoardLogSeverity;
  status: string | null;
  method: string | null;
  source: string | null;
  destination: string | null;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface BoardLogPage {
  entries: BoardLogEntry[];
  /** Cursor for the next (older) page: pass as `before`. */
  nextCursor: string | null;
  hasMore: boolean;
}

/** Default number of entries returned for the first page. */
export const BOARD_LOG_DEFAULT_PAGE_SIZE = 50;

/** Hard ceiling for one page, so a crafted cursor cannot ask for everything. */
export const BOARD_LOG_MAX_PAGE_SIZE = 200;

/**
 * Retention window for stored log rows. The Worker prunes older rows on its
 * scheduled tick; the value is configurable per deployment.
 */
export const BOARD_LOG_RETENTION_DAYS = 14;

/**
 * Per-board row ceiling. A board that produces a lot of activity keeps its
 * newest rows only, so one noisy board can never grow the table without bound.
 */
export const BOARD_LOG_MAX_ROWS_PER_BOARD = 2000;

/**
 * Console filter list. `warning` and `error` are severity filters, the rest
 * are category filters — the console shows exactly these seven chips.
 */
export const BOARD_LOG_FILTERS = [
  { id: "all", label: "All", category: null, severity: null },
  {
    id: "communication",
    label: "Communication",
    category: "communication" as BoardLogCategory,
    severity: null,
  },
  {
    id: "device_activity",
    label: "Device Activity",
    category: "device_activity" as BoardLogCategory,
    severity: null,
  },
  {
    id: "connection",
    label: "Connection",
    category: "connection" as BoardLogCategory,
    severity: null,
  },
  {
    id: "command",
    label: "Commands",
    category: "command" as BoardLogCategory,
    severity: null,
  },
  { id: "warning", label: "Warning", category: null, severity: "warning" as BoardLogSeverity },
  { id: "error", label: "Error", category: null, severity: "error" as BoardLogSeverity },
] as const;

export type BoardLogFilterId = (typeof BOARD_LOG_FILTERS)[number]["id"];

export function boardLogFilterById(id: string): (typeof BOARD_LOG_FILTERS)[number] {
  return (
    BOARD_LOG_FILTERS.find((filter) => filter.id === id) ?? BOARD_LOG_FILTERS[0]
  );
}

/**
 * Statuses that describe a *failure* of a delivery or of the board itself.
 * The console renders these with the error tone.
 */
export const BOARD_LOG_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "timeout",
  "rejected",
  "offline",
  "controller_lost",
  "error",
  "generation_mismatch",
]);

/**
 * Statuses that describe a *delivery* rather than an execution. A "sent"
 * entry must never be presented as a confirmed change.
 */
export const BOARD_LOG_DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  "created",
  "sent",
  "received",
  "acknowledged",
  "duplicate",
]);

export function isBoardLogCategory(value: unknown): value is BoardLogCategory {
  return (
    typeof value === "string" &&
    (BOARD_LOG_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isBoardLogSeverity(value: unknown): value is BoardLogSeverity {
  return (
    typeof value === "string" &&
    (BOARD_LOG_SEVERITIES as readonly string[]).includes(value)
  );
}

export function boardLogCategoryLabel(category: string): string {
  switch (category) {
    case "device_activity":
      return "Device Activity";
    case "communication":
      return "Communication";
    case "connection":
      return "Connection";
    case "command":
      return "Command";
    case "binding":
      return "Binding";
    case "system":
      return "System";
    default:
      return category;
  }
}

/** Human label for a status token, used by the console as the status badge. */
export function boardLogStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  switch (status) {
    case "sent":
      return "Sent";
    case "received":
      return "Received";
    case "acknowledged":
      return "Acknowledged";
    case "executed":
      return "Executed";
    case "rejected":
      return "Rejected";
    case "duplicate":
      return "Duplicate";
    case "failed":
      return "Failed";
    case "timeout":
      return "Timeout";
    case "offline":
      return "Offline";
    case "online":
      return "Online";
    case "connected":
      return "Connected";
    case "disconnected":
      return "Disconnected";
    case "linked":
      return "Linked";
    case "controller_lost":
      return "Controller Lost";
    case "standalone":
      return "Standalone";
    case "unassigned":
      return "Unassigned";
    case "reconnecting":
      return "Reconnecting";
    case "route_changed":
      return "Route Changed";
    case "assigned":
      return "Assigned";
    case "unpaired":
      return "Unpaired";
    case "verified":
      return "Verified";
    case "revoked":
      return "Revoked";
    case "role_changed":
      return "Role Changed";
    case "generation_mismatch":
      return "Generation Mismatch";
    case "created":
      return "Created";
    case "reboot":
      return "Reboot";
    case "on":
      return "ON";
    case "off":
      return "OFF";
    case "active":
      return "Active";
    case "inactive":
      return "Inactive";
    default:
      return status;
  }
}

/** Maximum characters kept for a single metadata value. */
export const BOARD_LOG_METADATA_VALUE_LIMIT = 240;

/** Maximum number of metadata keys kept per entry. */
export const BOARD_LOG_METADATA_KEY_LIMIT = 20;
