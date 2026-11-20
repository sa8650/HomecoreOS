import { ApiError, apiFetch, emitNotificationSync, invalidateApiCache } from "@/lib/api";
import {
  REALTIME_CACHE_PREFIXES,
  SNAPSHOT_ENTITY_KINDS,
  type RealtimeBatch,
  type RealtimeConfigResponse,
  type RealtimeConnectionState,
  type RealtimeEnvelope,
  type RealtimeEntity,
  type RealtimeEvent,
  type RealtimeSnapshot,
  type RealtimeStatus,
} from "./types";
import type { RealtimeTransport, RealtimeTransportFactory } from "./transport";

export interface RealtimeChannelLike {
  postMessage: (message: unknown) => void;
  close: () => void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface RealtimeSyncDeps {
  fetchConfig: (accountId: string, options?: { reprovision?: boolean }) => Promise<RealtimeConfigResponse>;
  fetchSnapshot: () => Promise<RealtimeSnapshot>;
  createTransport: RealtimeTransportFactory;
  createChannel: (name: string) => RealtimeChannelLike | null;
  now: () => number;
  randomId: () => string;
  isVisible: () => boolean;
}

export const REALTIME_CHANNEL_NAME = "homecoreos:realtime-sync";
const PROBE_TIMEOUT_MS = 400;
const LEADER_HEARTBEAT_MS = 10_000;
const FOLLOWER_WATCHDOG_MS = 15_000;
const LEADER_STALE_MS = 25_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const BUFFER_LIMIT = 200;

const defaultDeps: RealtimeSyncDeps = {
  fetchConfig: (_accountId, options) =>
    apiFetch<RealtimeConfigResponse>(
      `/api/realtime/config${options?.reprovision ? "?reprovision=1" : ""}`
    ),
  fetchSnapshot: async () => {
    const res = await apiFetch<{ snapshot: RealtimeSnapshot }>("/api/realtime/snapshot");
    return res.snapshot;
  },
  createTransport: () => {
    // mqtt.js is loaded lazily by `ensureRealtimeTransportLoaded()` before the
    // first connection so a page that never goes live never pays for it.
    throw new Error("Realtime transport is not loaded");
  },
  createChannel: (name) => {
    if (typeof BroadcastChannel === "undefined") return null;
    return new BroadcastChannel(name) as unknown as RealtimeChannelLike;
  },
  now: () => Date.now(),
  randomId: () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
      : Math.random().toString(36).slice(2, 12),
  isVisible: () =>
    typeof document === "undefined" ? true : document.visibilityState !== "hidden",
};

function emptyStatus(): RealtimeStatus {
  return {
    state: "idle",
    synced: false,
    lastEventAt: null,
    lastSnapshotAt: null,
    lastError: null,
    reconnectAttempt: 0,
    isLeader: false,
    tabCount: 1,
    reason: null,
  };
}

function isRealtimeEntity(value: unknown): value is RealtimeEntity {
  return (
    value === "board" ||
    value === "switch" ||
    value === "device" ||
    value === "sensor" ||
    value === "automation" ||
    value === "notification" ||
    value === "home"
  );
}

function isValidEvent(value: unknown): value is RealtimeEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RealtimeEvent>;
  return (
    isRealtimeEntity(event.entity) &&
    typeof event.id === "string" &&
    event.id.length > 0 &&
    typeof event.ts === "string" &&
    Number.isFinite(Date.parse(event.ts))
  );
}

/**
 * One real-time connection for the whole console.
 *
 * Responsibilities:
 *  * elect a single leader tab (BroadcastChannel) so N open tabs cost one MQTT
 *    session, not N;
 *  * open one subscribe-only MQTT-over-WebSocket session;
 *  * apply event batches exactly once per tab, dropping duplicates, delayed and
 *    out-of-order events via a per-entity version (timestamp) watermark;
 *  * reconcile `/api/realtime/snapshot` after every (re)connect and tell pages
 *    to reload only the entities that actually drifted;
 *  * broadcast leader events to follower tabs;
 *  * expose one status object for the UI.
 */
export class RealtimeSyncClient {
  private readonly deps: RealtimeSyncDeps;
  private status: RealtimeStatus = emptyStatus();
  private readonly batchListeners = new Set<(batch: RealtimeBatch) => void>();
  private readonly statusListeners = new Set<(status: RealtimeStatus) => void>();

  private readonly versions = new Map<string, string>();
  private accountId: string | null = null;
  private started = false;
  private tabId: string;
  private clientIdSuffix: string;
  private transport: RealtimeTransport | null = null;
  private channel: RealtimeChannelLike | null = null;
  private isLeader = false;
  private leaderConfirmed = false;
  private leaderSeenAt = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private buffering = false;
  private buffer: RealtimeEvent[] = [];

  constructor(deps: Partial<RealtimeSyncDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
    this.tabId = this.deps.randomId();
    this.clientIdSuffix = this.tabId;
  }

  getStatus(): RealtimeStatus {
    return { ...this.status };
  }

  subscribe(listener: (batch: RealtimeBatch) => void): () => void {
    this.batchListeners.add(listener);
    return () => this.batchListeners.delete(listener);
  }

  subscribeStatus(listener: (status: RealtimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => this.statusListeners.delete(listener);
  }

  /** Exposed for tests and for pages that want an explicit refresh. */
  getVersion(entity: RealtimeEntity, id: string): string | undefined {
    return this.versions.get(`${entity}:${id}`);
  }

  start(accountId: string): void {
    if (this.started) {
      if (this.accountId === accountId) return;
      this.stop();
    }
    this.started = true;
    this.accountId = accountId;
    this.versions.clear();
    this.setStatus({ ...emptyStatus(), state: "connecting" });

    this.channel = this.deps.createChannel(REALTIME_CHANNEL_NAME);
    if (this.channel) {
      this.channel.onmessage = (event) => this.handleChannelMessage(event.data);
      // Probe for an existing leader; if nobody answers, this tab connects.
      this.channel.postMessage({ type: "probe", tabId: this.tabId });
      this.probeTimer = setTimeout(() => {
        this.probeTimer = null;
        if (!this.leaderConfirmed && this.started && !this.isLeader) {
          void this.takeLeadership();
        }
      }, PROBE_TIMEOUT_MS);
      this.watchdogTimer = setInterval(() => this.followerWatchdog(), FOLLOWER_WATCHDOG_MS);
    } else {
      void this.takeLeadership();
    }
  }

  stop(): void {
    this.started = false;
    this.isLeader = false;
    this.leaderConfirmed = false;
    this.teardownTimers();
    this.transport?.close();
    this.transport = null;
    this.buffer = [];
    this.buffering = false;
    if (this.channel) {
      try {
        this.channel.postMessage({ type: "release", tabId: this.tabId });
        this.channel.close();
      } catch {
        // ignore
      }
      this.channel = null;
    }
    this.accountId = null;
    this.versions.clear();
    if (this.status.state !== "disabled") {
      this.setStatus(emptyStatus());
    }
  }

  /**
   * Repairs drift. Called on reconnect and whenever the tab becomes visible
   * again after being hidden long enough for the browser to throttle sockets.
   */
  async refreshSnapshot(force = false): Promise<void> {
    if (!this.accountId || !this.isLeader) return;
    if (!force && this.buffering) return;
    let snapshot: RealtimeSnapshot;
    try {
      snapshot = await this.deps.fetchSnapshot();
    } catch (err) {
      this.setStatus({
        lastError: err instanceof Error ? err.message : "Snapshot refresh failed",
      });
      return;
    }
    this.reconcile(snapshot);
  }

  private async takeLeadership(): Promise<void> {
    if (!this.started || !this.accountId) return;
    this.isLeader = true;
    this.setStatus({ isLeader: true });
    this.channel?.postMessage({ type: "leader", tabId: this.tabId });
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.channel?.postMessage({ type: "heartbeat", tabId: this.tabId });
    }, LEADER_HEARTBEAT_MS);

    let config: RealtimeConfigResponse;
    try {
      config = await this.deps.fetchConfig(this.accountId);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      // A signed-out or paused session cannot be repaired by retrying.
      if (status === 401 || status === 403) {
        this.setStatus({
          state: "disabled",
          reason: "session_restricted",
          lastError: err instanceof Error ? err.message : "Realtime unavailable",
          isLeader: true,
        });
        return;
      }
      this.setStatus({
        state: "degraded",
        reason: "config_unavailable",
        lastError: err instanceof Error ? err.message : "Realtime config unavailable",
      });
      this.scheduleReconnect();
      return;
    }

    const credential = config?.credential;
    const usable =
      Boolean(config?.enabled) &&
      Boolean(credential) &&
      (credential!.brokerUrl.startsWith("ws://") || credential!.brokerUrl.startsWith("wss://")) &&
      typeof credential!.topic === "string" &&
      credential!.topic.length > 0;

    if (!usable) {
      this.setStatus({
        state: "disabled",
        reason: config?.reason ?? "realtime_not_configured",
        isLeader: true,
      });
      return;
    }

    this.connect(config);
  }

  private connect(config: RealtimeConfigResponse): void {
    const credential = config.credential!;
    this.buffering = true;
    this.buffer = [];
    this.setStatus({ state: this.reconnectAttempt > 0 ? "reconnecting" : "connecting" });

    try {
      this.transport = this.deps.createTransport({
        brokerUrl: credential.brokerUrl,
        username: credential.username,
        password: credential.password,
        clientId: `${credential.clientIdPrefix || "hcweb"}-${this.clientIdSuffix}`,
        topic: credential.topic,
        onConnected: () => {
          this.reconnectAttempt = 0;
          void this.reconcileAfterConnect();
        },
        onDisconnected: (reason) => {
          if (!this.started) return;
          this.transport?.close();
          this.transport = null;
          if (this.status.state === "disabled") return;
          this.setStatus({ state: "reconnecting", lastError: reason });
          this.scheduleReconnect();
        },
        onError: (message) => {
          this.setStatus({ lastError: message });
        },
        onMessage: (payload) => this.handleRawMessage(payload),
      });
    } catch (err) {
      this.buffering = false;
      this.setStatus({
        state: "degraded",
        lastError: err instanceof Error ? err.message : "Realtime connection failed",
      });
      this.scheduleReconnect();
    }
  }

  private async reconcileAfterConnect(): Promise<void> {
    this.setStatus({ state: "live", reconnectAttempt: this.reconnectAttempt });
    try {
      const snapshot = await this.deps.fetchSnapshot();
      this.reconcile(snapshot);
    } catch (err) {
      this.setStatus({
        lastError: err instanceof Error ? err.message : "Snapshot refresh failed",
      });
    } finally {
      this.buffering = false;
      const pending = this.buffer;
      this.buffer = [];
      if (pending.length > 0) {
        this.applyEvents(pending, { broadcast: false });
      }
      this.setStatus({ state: "live" });
    }
  }

  /**
   * Compares the server's version map with what this tab has applied. Only
   * entities that are new, changed or missing trigger a page reload, so a
   * reconnect after a short network blip usually reloads nothing.
   */
  private reconcile(snapshot: RealtimeSnapshot): void {
    if (!snapshot || snapshot.v !== 1) return;
    const hadKnowledge = this.versions.size > 0;
    const drifted = new Set<RealtimeEntity>();

    for (const [key, kind] of Object.entries(SNAPSHOT_ENTITY_KINDS) as Array<
      [keyof RealtimeSnapshot["entities"], RealtimeEntity]
    >) {
      const rows = snapshot.entities?.[key] ?? [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (!row || typeof row.id !== "string") continue;
        const mapKey = `${kind}:${row.id}`;
        seen.add(mapKey);
        const previous = this.versions.get(mapKey);
        const version = typeof row.version === "string" ? row.version : null;
        if (!version) continue;
        if (previous && previous !== version) drifted.add(kind);
        if (!previous && hadKnowledge) drifted.add(kind);
        if (!previous || version > previous) this.versions.set(mapKey, version);
      }
      if (hadKnowledge) {
        for (const mapKey of Array.from(this.versions.keys())) {
          if (!mapKey.startsWith(`${kind}:`)) continue;
          if (!seen.has(mapKey)) {
            drifted.add(kind);
            this.versions.delete(mapKey);
          }
        }
      }
    }

    this.status.lastSnapshotAt = snapshot.serverTime;
    this.status.synced = true;

    if (drifted.size > 0) {
      this.emitBatch({
        events: [],
        entities: Array.from(drifted),
        resync: true,
        receivedAt: new Date(this.deps.now()).toISOString(),
      });
    }
  }

  private handleRawMessage(payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const envelope = parsed as Partial<RealtimeEnvelope>;
    if (envelope?.v !== 1 || !Array.isArray(envelope.events)) return;
    if (this.accountId && envelope.accountId && envelope.accountId !== this.accountId) return;

    const events = envelope.events.filter(isValidEvent);
    if (events.length === 0) return;

    if (this.buffering) {
      this.buffer.push(...events);
      if (this.buffer.length > BUFFER_LIMIT) {
        this.buffer = this.buffer.slice(-BUFFER_LIMIT);
      }
      return;
    }

    this.applyEvents(events, { broadcast: true });
  }

  /**
   * Applies events in order, dropping duplicates and anything older than the
   * newest version already applied for that entity. This is what makes delayed
   * or out-of-order broker deliveries harmless.
   */
  applyEvents(events: RealtimeEvent[], options: { broadcast: boolean }): RealtimeEvent[] {
    const accepted: RealtimeEvent[] = [];
    for (const event of events) {
      if (!isValidEvent(event)) continue;
      const key = `${event.entity}:${event.id}`;
      const previous = this.versions.get(key);
      // Delayed, duplicate and out-of-order deliveries all collapse here: an
      // event is only applied when it is strictly newer than the last one seen
      // for that entity.
      if (previous && event.ts <= previous) continue;
      this.versions.set(key, event.ts);
      accepted.push(event);
    }
    if (accepted.length === 0) return [];

    const entities = Array.from(new Set(accepted.map((event) => event.entity)));
    for (const entity of entities) {
      invalidateApiCache(...REALTIME_CACHE_PREFIXES[entity]);
    }
    if (entities.includes("notification")) {
      emitNotificationSync("user", undefined, "realtime");
    }

    this.status.lastEventAt = new Date(this.deps.now()).toISOString();
    this.emitBatch({
      events: accepted,
      entities,
      resync: false,
      receivedAt: this.status.lastEventAt!,
    });

    if (options.broadcast) {
      this.channel?.postMessage({ type: "events", tabId: this.tabId, events: accepted });
    }
    return accepted;
  }

  private handleChannelMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const message = raw as {
      type?: string;
      tabId?: string;
      events?: unknown;
    };
    if (message.tabId === this.tabId) return;

    switch (message.type) {
      case "probe":
        if (this.isLeader) {
          this.channel?.postMessage({ type: "leader", tabId: this.tabId });
        }
        break;
      case "leader":
        if (!this.isLeader) {
          this.leaderConfirmed = true;
          this.leaderSeenAt = this.deps.now();
          this.setStatus({
            state: this.status.lastEventAt ? "live" : "connecting",
            isLeader: false,
            reason: null,
          });
        }
        break;
      case "heartbeat":
        if (!this.isLeader) {
          this.leaderConfirmed = true;
          this.leaderSeenAt = this.deps.now();
        }
        break;
      case "release":
        if (!this.isLeader) {
          this.leaderConfirmed = false;
          // Another tab closed; this one takes over shortly.
          setTimeout(() => {
            if (this.started && !this.isLeader && !this.leaderConfirmed) {
              void this.takeLeadership();
            }
          }, PROBE_TIMEOUT_MS);
        }
        break;
      case "events": {
        if (!Array.isArray(message.events)) return;
        const events = message.events.filter(isValidEvent);
        if (events.length > 0) this.applyEvents(events, { broadcast: false });
        break;
      }
      default:
        break;
    }
  }

  private followerWatchdog(): void {
    if (!this.started || this.isLeader) return;
    if (!this.leaderConfirmed) return;
    if (this.deps.now() - this.leaderSeenAt > LEADER_STALE_MS) {
      this.leaderConfirmed = false;
      void this.takeLeadership();
    }
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const backoff = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempt - 1, 5)
    );
    const jitter = Math.floor(Math.random() * 400);
    this.setStatus({ state: "reconnecting", reconnectAttempt: this.reconnectAttempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.started) return;
      void this.takeLeadership();
    }, backoff + jitter);
  }

  private teardownTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.reconnectTimer = null;
    this.probeTimer = null;
    this.heartbeatTimer = null;
    this.watchdogTimer = null;
  }

  private emitBatch(batch: RealtimeBatch): void {
    for (const listener of Array.from(this.batchListeners)) {
      try {
        listener(batch);
      } catch {
        // A broken subscriber must not break the sync loop.
      }
    }
  }

  private setStatus(patch: Partial<RealtimeStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of Array.from(this.statusListeners)) {
      try {
        listener(this.getStatus());
      } catch {
        // ignore
      }
    }
  }

  /** Test seam: inspect the internal state without a DOM. */
  get connectionState(): RealtimeConnectionState {
    return this.status.state;
  }

  /** Test seam: true while the client holds the MQTT socket. */
  get leads(): boolean {
    return this.isLeader;
  }
}

let singleton: RealtimeSyncClient | null = null;

/**
 * The single client instance for the app. The transport is constructed lazily
 * here so `mqtt` is only pulled in for browsers that actually go live.
 */
export function getRealtimeClient(): RealtimeSyncClient {
  if (!singleton) {
    singleton = new RealtimeSyncClient({
      createTransport: (params) => {
        const factory = lazyMqttFactory;
        if (!factory) throw new Error("Realtime transport is not available");
        return factory(params);
      },
    });
  }
  return singleton;
}

let lazyMqttFactory: RealtimeTransportFactory | null = null;
let mqttFactoryPromise: Promise<void> | null = null;

/** Loads mqtt.js on first real connection attempt. */
export async function ensureRealtimeTransportLoaded(): Promise<void> {
  if (lazyMqttFactory) return;
  if (!mqttFactoryPromise) {
    mqttFactoryPromise = import("./transport").then((mod) => {
      lazyMqttFactory = mod.createMqttTransport;
    });
  }
  await mqttFactoryPromise;
}

/** Test seam: reset the module singleton between tests. */
export function __resetRealtimeSingletonForTests(): void {
  singleton?.stop();
  singleton = null;
}

/** Test seam: inject a client (with fake deps) as the app singleton. */
export function __setRealtimeSingletonForTests(client: RealtimeSyncClient | null): void {
  singleton?.stop();
  singleton = client;
}
