import { Component, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { RiAlertLine, RiRefreshLine } from "@remixicon/react";
import { Button } from "@/components/ui/button";

/**
 * True when the error came from a lazily-imported route chunk rather than from
 * the page's own logic. After a deploy every open tab (and every cached
 * `index.html`) still asks for the previous `/assets/<hash>.js`, and
 * Cloudflare's SPA fallback answers those with `200 OK text/html`. The dynamic
 * import then rejects with `Failed to fetch dynamically imported module`.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|ChunkLoadError/i.test(
    message
  );
}

const CHUNK_RELOAD_KEY = "homecoreos:chunk-reload-at";
const CHUNK_RELOAD_WINDOW_MS = 15_000;

/**
 * Reloads once so the tab picks up the freshly deployed asset hashes. Guarded
 * by sessionStorage so a genuinely broken deploy cannot trap the tab in a loop.
 */
export function reloadForStaleChunk(): void {
  if (typeof window === "undefined") return;
  let previous: string | null = null;
  try {
    previous = sessionStorage.getItem(CHUNK_RELOAD_KEY);
  } catch {
    previous = null;
  }
  const now = Date.now();
  try {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
  } catch {
    // storage unavailable; the caller still shows a manual reload button
  }
  const previousAt = previous === null ? null : Number(previous);
  if (previousAt !== null && Number.isFinite(previousAt)) {
    if (now - previousAt < CHUNK_RELOAD_WINDOW_MS) return;
  }
  window.location.reload();
}

export function AppErrorFallback({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const chunkError = isChunkLoadError(error);
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";

  return (
    <div
      role="alert"
      data-testid="app-error-fallback"
      className="mx-auto flex w-full max-w-xl flex-col items-center gap-4 rounded-2xl border border-border/70 bg-card px-6 py-10 text-center shadow-sm"
    >
      <span className="flex size-11 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
        <RiAlertLine className="size-5" aria-hidden="true" />
      </span>
      <div className="space-y-1.5">
        <h2 className="text-base font-semibold">
          {chunkError ? "A new version is available" : "This view hit a snag"}
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {chunkError
            ? "HomecoreOS was updated while this tab was open, so part of the page is out of date. Reload to pick up the latest version."
            : "Something went wrong while rendering this screen. Your data is safe - reload the page or try again."}
        </p>
        {message && (
          <p className="break-words pt-1 font-mono text-[11px] text-muted-foreground/80">
            {message.slice(0, 240)}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" onClick={() => window.location.reload()}>
          <RiRefreshLine className="size-3.5" aria-hidden="true" />
          Reload page
        </Button>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Changing this value (route path, retry counter) clears a caught error. */
  resetKey?: string;
  fallback: (error: unknown, reset: () => void) => ReactNode;
  onError?: (error: unknown) => void;
}

interface ErrorBoundaryState {
  error: unknown;
}

/**
 * Catches render/lazy-import failures from the subtree. Without one, React 19
 * unmounts the whole tree on an uncaught error and the app leaves a blank
 * `#root` behind - which is exactly the white screen reported after deploy.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.props.onError?.(error);
    console.error("HomecoreOS render error:", error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (this.state.error !== null) {
      return this.props.fallback(this.state.error, this.reset);
    }
    return this.props.children;
  }
}

/**
 * Route-level boundary: a failed screen shows a recovery panel, navigation
 * clears it, and a stale chunk triggers exactly one automatic reload.
 */
export function RouteErrorBoundary({
  path,
  children,
}: {
  path: string;
  children: ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<unknown>(null);

  return (
    <ErrorBoundary
      resetKey={`${path}:${attempt}`}
      onError={(caught) => {
        setError(caught);
        if (isChunkLoadError(caught)) reloadForStaleChunk();
      }}
      fallback={(caught) => (
        <AppErrorFallback
          error={caught ?? error}
          onRetry={() => {
            setError(null);
            setAttempt((count) => count + 1);
          }}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

/** Test-only helper: clears the once-per-session reload guard. */
export function resetStaleChunkReloadGuard(): void {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    // ignore
  }
}
