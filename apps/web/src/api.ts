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

export const api = {
  get: <T = any>(p: string) => request<T>(p),
  post: <T = any>(p: string, body?: unknown) => request<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T = any>(p: string, body?: unknown) => request<T>(p, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T = any>(p: string, body?: unknown) => request<T>(p, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T = any>(p: string, body?: unknown) => request<T>(p, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body) }),
};

/** Fetch + refresh on live events (SSE). The session cookie is sent by the browser. */
export function useLiveData<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const key = JSON.stringify(deps);
  useEffect(() => {
    if (!path) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    api.get<T>(path).then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [path, tick, key]);
  useEffect(() => {
    if (!path) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/stream', { credentials: 'same-origin', signal: ctrl.signal });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop() || '';
          for (const part of parts) {
            const line = part.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type !== 'connected') setTick((n) => n + 1);
            } catch { /* ignore */ }
          }
        }
      } catch { /* aborted or offline */ }
    })();
    return () => ctrl.abort();
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
