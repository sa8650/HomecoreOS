import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BOARD_LOG_FILTERS,
  boardLogCategoryLabel,
  boardLogStatusLabel,
  type BoardLogCategory,
  type BoardLogEntry,
  type BoardLogSeverity,
} from "@homecoreos/shared";
import {
  RiAlertFill,
  RiCloseLine,
  RiErrorWarningFill,
  RiFileListLine,
  RiFilterLine,
  RiInformationFill,
  RiLoopLeftLine,
  RiPauseFill,
  RiPlayFill,
  RiRefreshLine,
  RiSearchLine,
  RiWifiLine,
} from "@remixicon/react";
import { apiFetch } from "@/lib/api";
import { formatTimestamp, useEffectiveTimezone } from "@/lib/timezone";
import { getRealtimeClient } from "@/lib/realtime/sync-client";
import { useRealtimeStatus } from "@/lib/realtime/RealtimeProvider";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * Per-board live Log.
 *
 * The dialog shows the operational history of exactly one board: the board's
 * own status changes, its communication with the platform and with its peers,
 * the commands addressed to it and the device activity it reported. A Node's
 * log never contains the Controller's log and vice versa — the Controller only
 * appears in a Node's log as the peer of a communication event.
 *
 * Live updates arrive over the existing account real-time channel; the dialog
 * never polls. While the view is paused the incoming entries are buffered and
 * applied when the view resumes.
 */

const PAGE_SIZE = 50;
/**
 * Upper bound for the paused buffer. A dialog left paused for hours must not
 * grow without limit; the oldest buffered entries are dropped and the newest
 * page is refilled on resume, so nothing silently disappears from the stored
 * history (it stays reachable with "Load older").
 */
const MAX_PAUSED_BUFFER = 500;

export interface BoardLogDialogBoard {
  id: string;
  name: string;
  status?: string | null;
  boardRole?: string | null;
  lastHeartbeatAt?: string | null;
  lastCommunicationAt?: string | null;
  mqttConnected?: boolean | null;
  wifiConnected?: boolean | null;
  nodeLinkState?: string | null;
  commMode?: string | null;
}

interface BoardLogResponse {
  board: BoardLogDialogBoard;
  entries: BoardLogEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

const SEVERITY_STYLE: Record<BoardLogSeverity, string> = {
  info: "text-muted-foreground",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
};

/** Newest first. An unparseable timestamp sorts last instead of throwing. */
function sortEntries(entries: BoardLogEntry[]): BoardLogEntry[] {
  return [...entries].sort((a, b) => {
    const at = Date.parse(a.createdAt);
    const bt = Date.parse(b.createdAt);
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
  });
}

/**
 * Merges `incoming` into `existing` by entry id and keeps the list newest
 * first. Used for every write to the view (server page, live event, buffered
 * event) so an entry can never appear twice and a late response can never
 * duplicate the live entries that arrived while it was in flight.
 */
function mergeEntries(
  incoming: BoardLogEntry[],
  existing: BoardLogEntry[]
): BoardLogEntry[] {
  if (incoming.length === 0) return existing;
  const seen = new Set<string>();
  const merged: BoardLogEntry[] = [];
  for (const entry of [...incoming, ...existing]) {
    if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return sortEntries(merged);
}

function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        online
          ? "inline-block size-2 shrink-0 rounded-full bg-emerald-500"
          : "inline-block size-2 shrink-0 rounded-full bg-destructive"
      }
    />
  );
}

function CategoryIcon({ category }: { category: BoardLogCategory }) {
  const className = "size-4 shrink-0";
  switch (category) {
    case "command":
      return <RiFileListLine className={className} aria-hidden="true" />;
    case "connection":
      return <RiWifiLine className={className} aria-hidden="true" />;
    case "device_activity":
      return <RiLoopLeftLine className={className} aria-hidden="true" />;
    case "communication":
      return <RiFilterLine className={className} aria-hidden="true" />;
    default:
      return <RiInformationFill className={className} aria-hidden="true" />;
  }
}

function severityIcon(severity: BoardLogSeverity) {
  if (severity === "error") {
    return <RiErrorWarningFill className="size-4 shrink-0 text-destructive" aria-hidden="true" />;
  }
  if (severity === "warning") {
    return <RiAlertFill className="size-4 shrink-0 text-amber-500" aria-hidden="true" />;
  }
  if (severity === "success") {
    return (
      <RiInformationFill
        className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
        aria-hidden="true"
      />
    );
  }
  return <RiInformationFill className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

function LogRow({
  entry,
  timezone,
}: {
  entry: BoardLogEntry;
  timezone: string;
}) {
  return (
    <li
      data-testid="board-log-entry"
      className="flex gap-2.5 rounded-lg border border-border/60 bg-card px-3 py-2"
    >
      <div className="flex shrink-0 flex-col items-center gap-1 pt-0.5">
        {severityIcon(entry.severity)}
        <CategoryIcon category={entry.category} />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            data-testid="board-log-status"
            className={`text-[11px] font-semibold ${SEVERITY_STYLE[entry.severity]}`}
          >
            {boardLogStatusLabel(entry.status)}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {boardLogCategoryLabel(entry.category)}
          </span>
          {entry.method ? (
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
              {entry.method}
            </span>
          ) : null}
        </div>
        <p className="break-words text-sm leading-snug text-foreground">{entry.message}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <time dateTime={entry.createdAt}>{formatTimestamp(entry.createdAt, timezone)}</time>
          {entry.source ? <span>Source: {entry.source}</span> : null}
          {entry.destination ? <span>Destination: {entry.destination}</span> : null}
        </div>
      </div>
    </li>
  );
}

export function BoardLogDialog({
  board,
  open,
  onOpenChange,
}: {
  board: BoardLogDialogBoard | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const timezone = useEffectiveTimezone();
  const boardId = board?.id ?? null;
  // The live indicator reports the real state of the account channel: a
  // reconnect never loses the stored history, it only postpones the live
  // entries.
  const realtimeState = useRealtimeStatus().state;

  const [entries, setEntries] = useState<BoardLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterId, setFilterId] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const [bufferedCount, setBufferedCount] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [clearedAt, setClearedAt] = useState<number | null>(null);
  // Connection facts that arrive while the dialog is open. The board row is a
  // snapshot from when the dialog opened; these keep "current status" and
  // "last seen" honest while the view is live.
  const [liveBoard, setLiveBoard] = useState<{
    status?: string;
    lastHeartbeatAt?: string;
  } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bufferRef = useRef<BoardLogEntry[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  /** Board currently shown; guards a response that belongs to a previous board. */
  const boardKeyRef = useRef<string | null>(null);
  /** The newest request owns the view; older responses are dropped. */
  const requestSeqRef = useRef(0);
  /** A gap was detected (reconnect) while the view was paused. */
  const resyncPendingRef = useRef(false);

  const filter = useMemo(
    () => BOARD_LOG_FILTERS.find((item) => item.id === filterId) ?? BOARD_LOG_FILTERS[0],
    [filterId]
  );

  const buildQuery = useCallback(
    (before?: string | null) => {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      if (before) params.set("before", before);
      if (filter.category) params.set("category", filter.category);
      if (filter.severity) params.set("severity", filter.severity);
      const term = search.trim();
      if (term) params.set("q", term);
      return `/api/board-logs/${boardId}?${params.toString()}`;
    },
    [boardId, filter, search]
  );

  /**
   * Refills the view. Entries are merged by id and kept newest-first, so a
   * response never drops a live entry that arrived while the request was in
   * flight, and a stale response for another board is discarded outright.
   */
  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!boardId) return;
      const seq = ++requestSeqRef.current;
      if (!options?.silent) setLoading(true);
      try {
        const data = await apiFetch<BoardLogResponse>(buildQuery());
        if (seq !== requestSeqRef.current || boardKeyRef.current !== boardId) return;
        setEntries((previous) => mergeEntries(data.entries ?? [], previous));
        setCursor(data.nextCursor ?? null);
        setHasMore(Boolean(data.hasMore));
        setError(null);
      } catch (err) {
        if (seq !== requestSeqRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to load the board log.");
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    },
    [boardId, buildQuery]
  );

  const loadRef = useRef(load);
  loadRef.current = load;

  // Opening the dialog (or switching to another board) starts from a clean
  // view: the entries of the previous board must never be shown under the new
  // board's name while the first page is loading.
  useEffect(() => {
    if (!open || !boardId) {
      boardKeyRef.current = null;
      return;
    }
    boardKeyRef.current = boardId;
    requestSeqRef.current += 1;
    setEntries([]);
    setCursor(null);
    setHasMore(false);
    setError(null);
    setClearedAt(null);
    setPaused(false);
    setBufferedCount(0);
    setLiveBoard(null);
    bufferRef.current = [];
    resyncPendingRef.current = false;
    void loadRef.current();
  }, [open, boardId]);

  // A filter or search change re-reads the page from the server, debounced so
  // typing does not fire a request per keystroke. It only refreshes the
  // entries: "Clear View" and the paused buffer are display state and must
  // survive a filter change.
  const lastQueryRef = useRef<{ boardId: string | null; filterId: string; search: string }>({
    boardId: null,
    filterId: "all",
    search: "",
  });
  useEffect(() => {
    if (!open || !boardId) return;
    const previous = lastQueryRef.current;
    lastQueryRef.current = { boardId, filterId, search };
    if (previous.boardId !== boardId) return; // the open effect already loaded
    if (previous.filterId === filterId && previous.search === search) return;
    const timer = window.setTimeout(() => {
      void loadRef.current({ silent: true });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [open, boardId, filterId, search]);

  // A reconnect can have missed entries. The snapshot does not carry log rows,
  // so refill the newest page once the channel is live again instead of
  // pretending the live view is complete.
  const wasLiveRef = useRef(realtimeState === "live");
  useEffect(() => {
    const isLive = realtimeState === "live";
    const becameLive = isLive && !wasLiveRef.current;
    wasLiveRef.current = isLive;
    if (!becameLive || !open || !boardId) return;
    if (pausedRef.current) {
      resyncPendingRef.current = true;
      return;
    }
    void loadRef.current({ silent: true });
  }, [realtimeState, open, boardId]);

  // Live updates: the account channel carries one "log" event per new entry
  // and the board state events that keep the header honest.
  useEffect(() => {
    if (!open || !boardId) return;
    const client = getRealtimeClient();
    return client.subscribe((batch) => {
      if (batch.resync) {
        // The channel repaired a gap: entries written while it was down are
        // not in the view. Refill now, or when the paused view resumes.
        if (pausedRef.current) {
          resyncPendingRef.current = true;
        } else {
          void loadRef.current({ silent: true });
        }
      }
      for (const event of batch.events) {
        if (event.entity === "board" && event.id === boardId) {
          const patch = event.patch as
            | { status?: string; lastHeartbeatAt?: string }
            | undefined;
          if (patch && (patch.status !== undefined || patch.lastHeartbeatAt !== undefined)) {
            setLiveBoard((previous) => ({
              status: patch.status ?? previous?.status,
              lastHeartbeatAt: patch.lastHeartbeatAt ?? previous?.lastHeartbeatAt,
            }));
          }
          continue;
        }
        if (event.entity !== "log") continue;
        const patch = event.patch as { boardInstanceId?: string } | undefined;
        if (!patch || patch.boardInstanceId !== boardId) continue;
        const entry = {
          id: event.id,
          boardInstanceId: boardId,
          category: (patch as { category?: BoardLogCategory }).category ?? "system",
          severity: (patch as { severity?: BoardLogSeverity }).severity ?? "info",
          status: (patch as { status?: string | null }).status ?? null,
          method: (patch as { method?: string | null }).method ?? null,
          source: (patch as { source?: string | null }).source ?? null,
          destination: (patch as { destination?: string | null }).destination ?? null,
          message: (patch as { message?: string }).message ?? "",
          metadata: (patch as { metadata?: Record<string, unknown> }).metadata ?? {},
          createdAt: (patch as { createdAt?: string }).createdAt ?? event.ts,
        } as BoardLogEntry;
        if (pausedRef.current) {
          if (bufferRef.current.length >= MAX_PAUSED_BUFFER) {
            bufferRef.current.shift();
            // The dropped entry must come back with the refilled page.
            resyncPendingRef.current = true;
          }
          bufferRef.current.push(entry);
          setBufferedCount(bufferRef.current.length);
          continue;
        }
        setEntries((previous) => mergeEntries([entry], previous));
      }
    });
  }, [open, boardId]);

  // Auto-scroll to the newest entry while the view follows the live feed.
  useEffect(() => {
    if (!autoScroll) return;
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = 0;
  }, [entries, autoScroll]);

  const resume = useCallback(() => {
    setPaused(false);
    const buffered = bufferRef.current;
    bufferRef.current = [];
    setBufferedCount(0);
    // Buffered entries were collected in arrival order; merging sorts them
    // newest-first with the entries that were already on screen.
    if (buffered.length > 0) {
      setEntries((previous) => mergeEntries(buffered, previous));
    }
    if (resyncPendingRef.current) {
      resyncPendingRef.current = false;
      void loadRef.current({ silent: true });
    }
  }, []);

  /**
   * "Clear View" hides what is on screen. The paused buffer is part of the view
   * as well: leaving it behind would promise "3 new entries" that can never
   * appear (they are older than the clear point), so the buffer is dropped and
   * its counter reset — the stored rows are untouched and still reachable by
   * refreshing or paging.
   */
  const clearView = useCallback(() => {
    setClearedAt(Date.now());
    bufferRef.current = [];
    setBufferedCount(0);
    resyncPendingRef.current = false;
  }, []);

  const loadOlder = useCallback(async () => {
    if (!cursor || loadingOlder) return;
    const forBoard = boardId;
    setLoadingOlder(true);
    try {
      const data = await apiFetch<BoardLogResponse>(buildQuery(cursor));
      // A response for another board is never merged into this view.
      if (!forBoard || boardKeyRef.current !== forBoard) return;
      setEntries((previous) => mergeEntries(data.entries ?? [], previous));
      setCursor(data.nextCursor ?? null);
      setHasMore(Boolean(data.hasMore));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load older entries.");
    } finally {
      setLoadingOlder(false);
    }
  }, [boardId, buildQuery, cursor, loadingOlder]);

  const visibleEntries = useMemo(() => {
    const term = search.trim().toLowerCase();
    const cleared = clearedAt;
    return entries.filter((entry) => {
      if (cleared && new Date(entry.createdAt).getTime() < cleared) return false;
      if (filter.category && entry.category !== filter.category) return false;
      if (filter.severity && entry.severity !== filter.severity) return false;
      if (term && !entry.message.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [entries, filter, search, clearedAt]);

  if (!board) return null;

  const effectiveStatus = liveBoard?.status ?? board.status ?? null;
  const isOnline = effectiveStatus === "online";
  const lastSeenAt =
    liveBoard?.lastHeartbeatAt ?? board.lastHeartbeatAt ?? board.lastCommunicationAt ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-3xl"
        data-testid="board-log-dialog"
        aria-label={`Log for ${board.name}`}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <StatusDot online={isOnline} />
            Log · {board.name}
          </DialogTitle>
          <DialogDescription>
            <span data-testid="board-log-board-id" className="font-mono text-[11px]">
              {board.id}
            </span>
            <span className="mx-2 text-muted-foreground">·</span>
            <span data-testid="board-log-status-line">
              {isOnline ? "Online" : effectiveStatus ?? "unknown"}
            </span>
            <span className="mx-2 text-muted-foreground">·</span>
            <span data-testid="board-log-last-seen">
              Last seen {formatTimestamp(lastSeenAt, timezone)}
            </span>
            {board.boardRole ? (
              <>
                <span className="mx-2 text-muted-foreground">·</span>
                <span>{board.boardRole === "node" ? "Node" : "Controller"}</span>
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <RiSearchLine
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search this board's log"
              aria-label="Search log entries"
              className="pl-8"
              data-testid="board-log-search"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            aria-label="Refresh log"
            data-testid="board-log-refresh"
          >
            <RiRefreshLine className="size-4" aria-hidden="true" />
            Refresh
          </Button>
          <Button
            type="button"
            variant={paused ? "default" : "outline"}
            size="sm"
            onClick={() => (paused ? resume() : setPaused(true))}
            data-testid="board-log-pause"
          >
            {paused ? (
              <RiPlayFill className="size-4" aria-hidden="true" />
            ) : (
              <RiPauseFill className="size-4" aria-hidden="true" />
            )}
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={clearView}
            data-testid="board-log-clear"
          >
            <RiCloseLine className="size-4" aria-hidden="true" />
            Clear View
          </Button>
          <Button
            type="button"
            variant={autoScroll ? "default" : "outline"}
            size="sm"
            onClick={() => setAutoScroll((value) => !value)}
            data-testid="board-log-autoscroll"
            aria-pressed={autoScroll}
          >
            Auto-scroll
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Log filters">
          {BOARD_LOG_FILTERS.map((item) => (
            <Button
              key={item.id}
              type="button"
              size="xs"
              variant={filterId === item.id ? "default" : "outline"}
              onClick={() => setFilterId(item.id)}
              aria-pressed={filterId === item.id}
              data-testid={`board-log-filter-${item.id}`}
            >
              {item.label}
            </Button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span data-testid="board-log-live-indicator">
            {paused ? (
              <span className="font-medium text-amber-600 dark:text-amber-400">
                Paused — {bufferedCount} new {bufferedCount === 1 ? "entry" : "entries"} buffered
              </span>
            ) : realtimeState === "live" ? (
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                Live — updating in real time
              </span>
            ) : (
              <span className="font-medium text-amber-600 dark:text-amber-400">
                Live updates are waiting for the connection — the stored history stays readable
              </span>
            )}
          </span>
          <span>
            {visibleEntries.length} {visibleEntries.length === 1 ? "entry" : "entries"}
          </span>
        </div>

        <div
          ref={scrollRef}
          data-testid="board-log-list"
          className="max-h-[45vh] min-h-[12rem] space-y-1.5 overflow-y-auto rounded-lg border border-border/60 bg-muted/20 p-2"
        >
          {error ? (
            <p className="px-2 py-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {loading && visibleEntries.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">Loading log…</p>
          ) : null}
          {!loading && visibleEntries.length === 0 && !error ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              No log entries for this board yet.
            </p>
          ) : null}
          <ul className="space-y-1.5">
            {visibleEntries.map((entry) => (
              <LogRow key={entry.id} entry={entry} timezone={timezone} />
            ))}
          </ul>
        </div>

        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadOlder()}
            disabled={!hasMore || !cursor || loadingOlder}
            data-testid="board-log-load-older"
          >
            {loadingOlder ? "Loading…" : "Load older"}
          </Button>
          <Badge variant="outline" className="text-[10px]">
            Clear View only hides entries — stored records are kept.
          </Badge>
        </div>
      </DialogContent>
    </Dialog>
  );
}
