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

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bufferRef = useRef<BoardLogEntry[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const filter = useMemo(
    () => BOARD_LOG_FILTERS.find((item) => item.id === filterId) ?? BOARD_LOG_FILTERS[0],
    [filterId]
  );

  const buildQuery = useCallback(
    (before?: string | null, overrides?: { filterId?: string; search?: string }) => {
      const activeFilter =
        BOARD_LOG_FILTERS.find(
          (item) => item.id === (overrides?.filterId ?? filterId)
        ) ?? BOARD_LOG_FILTERS[0];
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      if (before) params.set("before", before);
      if (activeFilter.category) params.set("category", activeFilter.category);
      if (activeFilter.severity) params.set("severity", activeFilter.severity);
      const term = (overrides?.search ?? search).trim();
      if (term) params.set("q", term);
      return `/api/board-logs/${boardId}?${params.toString()}`;
    },
    [boardId, filterId, search]
  );

  const load = useCallback(
    async (options?: { before?: string | null; silent?: boolean }) => {
      if (!boardId) return;
      if (!options?.silent) setLoading(true);
      try {
        const path = buildQuery(options?.before ?? null);
        const data = await apiFetch<BoardLogResponse>(path);
        setEntries(data.entries ?? []);
        setCursor(data.nextCursor ?? null);
        setHasMore(Boolean(data.hasMore));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load the board log.");
      } finally {
        setLoading(false);
      }
    },
    [boardId, buildQuery]
  );

  // Load the recent entries whenever the dialog opens for a board.
  useEffect(() => {
    if (!open || !boardId) return;
    setClearedAt(null);
    setBufferedCount(0);
    bufferRef.current = [];
    void load();
  }, [open, boardId, load]);

  // Live updates: the account channel carries one "log" event per new entry.
  useEffect(() => {
    if (!open || !boardId) return;
    const client = getRealtimeClient();
    return client.subscribe((batch) => {
      for (const event of batch.events) {
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
          bufferRef.current.push(entry);
          setBufferedCount(bufferRef.current.length);
          continue;
        }
        setEntries((previous) => {
          if (previous.some((item) => item.id === entry.id)) return previous;
          return [entry, ...previous];
        });
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
    if (buffered.length === 0) return;
    setEntries((previous) => {
      const known = new Set(previous.map((item) => item.id));
      const fresh = buffered.filter((item) => !known.has(item.id));
      return fresh.length > 0 ? [...fresh, ...previous] : previous;
    });
  }, []);

  const loadOlder = useCallback(async () => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const path = buildQuery(cursor);
      const data = await apiFetch<BoardLogResponse>(path);
      const known = new Set(entries.map((item) => item.id));
      const older = (data.entries ?? []).filter((item) => !known.has(item.id));
      setEntries((previous) => [...previous, ...older]);
      setCursor(data.nextCursor ?? null);
      setHasMore(Boolean(data.hasMore));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load older entries.");
    } finally {
      setLoadingOlder(false);
    }
  }, [buildQuery, cursor, entries, loadingOlder]);

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

  const isOnline = board.status === "online";

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
              {isOnline ? "Online" : board.status ?? "unknown"}
            </span>
            <span className="mx-2 text-muted-foreground">·</span>
            <span data-testid="board-log-last-seen">
              Last seen {formatTimestamp(board.lastHeartbeatAt ?? board.lastCommunicationAt, timezone)}
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
            onClick={() => setClearedAt(Date.now())}
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
