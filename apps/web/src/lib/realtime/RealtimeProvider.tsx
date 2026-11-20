import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ensureRealtimeTransportLoaded,
  getRealtimeClient,
  type RealtimeSyncClient,
} from "./sync-client";
import type {
  RealtimeBatch,
  RealtimeConnectionState,
  RealtimeEntity,
  RealtimeStatus,
} from "./types";

const idleStatus: RealtimeStatus = {
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

const RealtimeContext = createContext<RealtimeStatus>(idleStatus);

/**
 * Owns the app's single real-time connection for the signed-in account.
 *
 * Mount once, high in the tree (next to the console shell). Every page shares
 * this one connection and one version map — no component opens its own socket
 * and no component polls device state by itself.
 */
export function RealtimeProvider({
  accountId,
  children,
}: {
  accountId: string;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<RealtimeStatus>(idleStatus);

  useEffect(() => {
    let cancelled = false;
    const client = getRealtimeClient();
    const unsubscribe = client.subscribeStatus((next) => {
      if (!cancelled) setStatus(next);
    });

    const boot = async () => {
      try {
        await ensureRealtimeTransportLoaded();
      } catch {
        // Without the transport the console still works through the API.
      }
      if (cancelled) return;
      client.start(accountId);
    };
    void boot();

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void client.refreshSnapshot();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);

    return () => {
      cancelled = true;
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      client.stop();
      setStatus(idleStatus);
    };
  }, [accountId]);

  return <RealtimeContext.Provider value={status}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeStatus(): RealtimeStatus {
  return useContext(RealtimeContext);
}

export function useRealtimeClient(): RealtimeSyncClient {
  return getRealtimeClient();
}

/** Subscribe to every applied batch. Pages normally want `useLiveSync`. */
export function useRealtimeEvents(
  handler: (batch: RealtimeBatch) => void,
  enabled = true
): void {
  const client = getRealtimeClient();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    return client.subscribe((batch) => handlerRef.current(batch));
  }, [client, enabled]);
}

export interface LiveSyncOptions {
  /** Entity kinds that should trigger a reload of this page. */
  kinds: RealtimeEntity[];
  /** Safety interval used only while the real-time channel is not live. */
  fallbackMs?: number;
  /** Minimum spacing between event-driven reloads (coalesces bursts). */
  minIntervalMs?: number;
  enabled?: boolean;
}

/**
 * The one hook pages use to stay in sync.
 *
 * While the real-time channel is live, reloads are event-driven and coalesced
 * (one reload per burst of changes, never per event). While it is not live — a
 * broker outage, a browser that blocks WebSockets, or a test environment —
 * the page falls back to a slow visible-only refresh so data never goes stale
 * and never spins.
 */
export function useLiveSync(
  reload: () => void | Promise<void>,
  options: LiveSyncOptions
): { isLive: boolean; state: RealtimeConnectionState } {
  const { kinds, fallbackMs = 60_000, minIntervalMs = 2_000, enabled = true } = options;
  const status = useRealtimeStatus();
  const client = getRealtimeClient();
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const pendingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const lastRunRef = useRef(0);
  const kindsKey = useMemo(() => kinds.slice().sort().join(","), [kinds]);

  const scheduleReload = useCallback(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      pendingRef.current = true;
      return;
    }
    if (timerRef.current !== null) return;
    // Trailing throttle: a burst of events becomes one reload, and a chatty
    // sensor cannot turn the page into a request generator.
    const elapsed = Date.now() - lastRunRef.current;
    const delay = Math.max(120, minIntervalMs - elapsed);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      pendingRef.current = false;
      lastRunRef.current = Date.now();
      void reloadRef.current();
    }, delay);
  }, [minIntervalMs]);

  useEffect(() => {
    if (!enabled) return;
    const wanted = new Set(kindsKey.split(",").filter(Boolean));
    return client.subscribe((batch) => {
      if (batch.entities.some((entity) => wanted.has(entity))) {
        scheduleReload();
      }
    });
  }, [client, enabled, kindsKey, scheduleReload]);

  useEffect(() => {
    if (!enabled) return;
    if (status.state === "live") return;
    const interval = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void reloadRef.current();
    }, fallbackMs);
    return () => window.clearInterval(interval);
  }, [enabled, fallbackMs, status.state]);

  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      if (pendingRef.current) {
        pendingRef.current = false;
        void reloadRef.current();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled]);

  return { isLive: status.state === "live", state: status.state };
}

/** Small status chip payload shared by the island and page headers. */
export function describeRealtimeState(status: RealtimeStatus): {
  label: string;
  tone: "success" | "warning" | "neutral";
} {
  switch (status.state) {
    case "live":
      return { label: "Live", tone: "success" };
    case "connecting":
      return { label: "Connecting", tone: "neutral" };
    case "reconnecting":
      return { label: "Reconnecting", tone: "warning" };
    case "degraded":
      return { label: "Delayed", tone: "warning" };
    case "disabled":
      return { label: "Manual refresh", tone: "neutral" };
    default:
      return { label: "Idle", tone: "neutral" };
  }
}
