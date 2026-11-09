/** Client for the HomecoreOS API. Sessions are HttpOnly cookies; no token is stored in the browser. */
import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) { super(message); }
}

export const UNAUTHORIZED_EVENT = 'homecoreos:unauthorized';

async function request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as any) };
  const res = await fetch(path, { ...init, credentials: 'same-origin', headers });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const publicAuthPaths = ['/api/auth/me', '/api/auth/login', '/api/auth/signup', '/api/auth/recovery/reset'];
    if (res.status === 401 && !publicAuthPaths.some((p) => path.startsWith(p))) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.detail);
  }
  return data as T;
}

const inflight = new Map<string, Promise<any>>();
const cache = new Map<string, { at: number; value: any }>();
const CACHE_MS = 3000;

/**
 * Every request that changes something clears the cache, so the console never
 * shows a value that the server has already moved on from.
 */
function invalidateAfterChange() {
  cache.clear();
  inflight.clear();
  // The account details around the console can change too, so they are
  // fetched again.
  window.dispatchEvent(new Event('homecoreos:changed'));
}

export const api = {
  get: <T = any>(p: string) => request<T>(p),
  post: <T = any>(p: string, body?: unknown) => request<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
    .then((v) => { invalidateAfterChange(); return v; }),
  patch: <T = any>(p: string, body?: unknown) => request<T>(p, { method: 'PATCH', body: JSON.stringify(body) })
    .then((v) => { invalidateAfterChange(); return v; }),
  put: <T = any>(p: string, body?: unknown) => request<T>(p, { method: 'PUT', body: JSON.stringify(body) })
    .then((v) => { invalidateAfterChange(); return v; }),
  del: <T = any>(p: string, body?: unknown) => request<T>(p, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body) })
    .then((v) => { invalidateAfterChange(); return v; }),
};

/* ------------------------------------------------------------------ *
 * A single live-update connection for the whole console.
 *
 * Every live-data hook used to open its own server-sent-events stream,
 * so a page with five hooks opened five connections and aborted all of
 * them on navigation. One shared connection serves every subscriber and
 * is opened only while at least one of them is listening.
 * ------------------------------------------------------------------ */

type LiveListener = () => void;

const liveListeners = new Set<LiveListener>();
let liveSource: EventSource | null = null;
let liveRetry: number | null = null;
let liveRetryDelay = 1000;
/** Set when the last subscriber leaves, so a page change does not tear the
 *  connection down and immediately build a new one. */
let liveIdleTimer: number | null = null;

function startLive() {
  if (liveSource || typeof EventSource === 'undefined') return;
  if (liveIdleTimer) { window.clearTimeout(liveIdleTimer); liveIdleTimer = null; }
  try {
    liveSource = new EventSource('/api/stream', { withCredentials: true });
  } catch {
    // The console still works without live updates; the data simply refreshes
    // when the page is reloaded or a control is used.
    return;
  }
  liveSource.onmessage = () => {
    // The server says something changed, so anything already fetched may be
    // out of date. It is dropped, and each subscriber asks again.
    cache.clear();
    window.dispatchEvent(new Event('homecoreos:live'));
    for (const listener of [...liveListeners]) {
      try { listener(); } catch { /* a subscriber went away */ }
    }
  };
  liveSource.onerror = () => {
    // The browser reconnects on its own, but a closed stream does not always
    // come back, so the connection is rebuilt with a growing delay.
    if (liveRetry) return;
    liveRetryDelay = Math.min(liveRetryDelay * 2, 30000);
    liveRetry = window.setTimeout(() => {
      liveRetry = null;
      liveSource?.close();
      liveSource = null;
      if (liveListeners.size) startLive();
    }, liveRetryDelay);
  };
  liveSource.onopen = () => { liveRetryDelay = 1000; };
}

function stopLiveIfIdle() {
  if (liveListeners.size || !liveSource) return;
  // A page change replaces one hook with another. Waiting a moment keeps the
  // single connection alive instead of closing and reopening it.
  if (liveIdleTimer) window.clearTimeout(liveIdleTimer);
  liveIdleTimer = window.setTimeout(() => {
    liveIdleTimer = null;
    if (liveListeners.size || !liveSource) return;
    liveSource.close();
    liveSource = null;
    if (liveRetry) { window.clearTimeout(liveRetry); liveRetry = null; }
  }, 1500);
}

function subscribeLive(listener: LiveListener): () => void {
  liveListeners.add(listener);
  startLive();
  return () => {
    liveListeners.delete(listener);
    stopLiveIfIdle();
  };
}

/* ------------------------------------------------------------------ *
 * Request de-duplication and a short-lived cache.
 *
 * Several pages ask for the same resource. Without this, one page visit
 * sends the same request several times over, and a live event makes every
 * subscriber refetch. Identical in-flight requests share one response, and
 * a response is reused for a short moment afterwards.
 * ------------------------------------------------------------------ */

export function invalidateCache(prefix?: string) {
  if (!prefix) { cache.clear(); return; }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/**
 * Fetches a resource, sharing one request between identical callers and
 * reusing a recent answer.
 *
 * `fresh` skips the cache, which is what a control that changes data wants.
 */
export async function getCached<T = any>(path: string, fresh = false): Promise<T> {
  if (!fresh) {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    const pending = inflight.get(path);
    if (pending) return pending as Promise<T>;
  }
  const p = request<T>(path)
    .then((value) => { cache.set(path, { at: Date.now(), value }); return value; })
    .finally(() => { inflight.delete(path); });
  inflight.set(path, p);
  return p as Promise<T>;
}

/** Fetch + refresh on live events (SSE). The session cookie is sent by the browser. */
export function useLiveData<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  /** Counts how many times the page asked for the data to be fetched again.
   *  A change here means the answer already held is not used. */
  const [fresh, setFresh] = useState(0);
  const refresh = useCallback(() => { setFresh((n) => n + 1); setTick((n) => n + 1); }, []);
  const key = JSON.stringify(deps);

  useEffect(() => {
    if (!path) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    getCached<T>(path, fresh > 0)
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [path, tick, key, fresh]);

  // One shared connection for the whole console. The listener is only
  // registered while this hook is mounted.
  useEffect(() => {
    if (!path) return;
    // The server said something changed, so the answer on screen may be out
    // of date and is fetched again rather than taken from the cache.
    const unsubscribe = subscribeLive(() => { setFresh((n) => n + 1); setTick((n) => n + 1); });
    return unsubscribe;
  }, [path]);

  return { data, loading, error, refresh, setData };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e: any) { setError(e.message || 'Something went wrong'); return null; }
    finally { setBusy(false); }
  }, []);
  return { busy, error, run, clearError: () => setError(null) };
}
