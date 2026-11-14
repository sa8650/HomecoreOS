export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface CacheEntry {
  data: unknown;
  ts: number;
}

const getCache = new Map<string, CacheEntry>();
const inflightGets = new Map<string, Promise<unknown>>();
type NotificationSyncListener = (payload: {
  scope: "user" | "admin";
  unreadCount?: number;
}) => void;
const notificationListeners = new Set<NotificationSyncListener>();
let lastObservedFetch: typeof fetch | null = null;

function ensureFetchEpoch() {
  const current = globalThis.fetch;
  if (lastObservedFetch !== null && lastObservedFetch !== current) {
    getCache.clear();
    inflightGets.clear();
  }
  lastObservedFetch = current;
}

export function resetApiCache(): void {
  getCache.clear();
  inflightGets.clear();
  notificationListeners.clear();
}

export function emitNotificationSync(
  scope: "user" | "admin",
  unreadCount?: number
): void {
  for (const listener of notificationListeners) {
    listener({ scope, unreadCount });
  }
}

export function subscribeNotificationSync(
  listener: NotificationSyncListener
): () => void {
  notificationListeners.add(listener);
  return () => {
    notificationListeners.delete(listener);
  };
}

export function invalidateApiCache(...prefixes: string[]): void {
  if (prefixes.length === 0) {
    getCache.clear();
    return;
  }
  for (const key of Array.from(getCache.keys())) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      getCache.delete(key);
    }
  }
}

function invalidateCacheForMutation(path: string): void {
  if (
    path.startsWith("/api/auth/logout") ||
    path.startsWith("/api/auth/switch-account") ||
    path.startsWith("/api/admin/auth/logout")
  ) {
    getCache.clear();
    return;
  }
  if (path.startsWith("/api/switches")) {
    invalidateApiCache("/api/switches", "/api/homes/overview");
    return;
  }
  if (path.startsWith("/api/devices")) {
    invalidateApiCache("/api/devices", "/api/homes/overview");
    return;
  }
  if (path.startsWith("/api/sensors")) {
    invalidateApiCache("/api/sensors", "/api/homes/overview");
    return;
  }
  if (path.startsWith("/api/homes")) {
    invalidateApiCache("/api/homes", "/api/switches", "/api/devices", "/api/sensors");
    return;
  }
  if (path.startsWith("/api/controllers")) {
    invalidateApiCache(
      "/api/controllers",
      "/api/homes/overview",
      "/api/boards/my-boards",
      "/api/switches",
      "/api/devices",
      "/api/sensors"
    );
    return;
  }
  if (path.startsWith("/api/boards")) {
    invalidateApiCache("/api/boards");
    return;
  }
  if (path.startsWith("/api/automations")) {
    invalidateApiCache("/api/automations");
    if (path.endsWith("/run") || path.endsWith("/test")) {
      invalidateApiCache("/api/switches", "/api/devices", "/api/homes/overview");
    }
    return;
  }
  if (path.startsWith("/api/firmware")) {
    invalidateApiCache("/api/firmware", "/api/controllers");
    return;
  }
  if (path.startsWith("/api/notifications")) {
    invalidateApiCache("/api/notifications");
    return;
  }
  if (path.startsWith("/api/admin/notifications")) {
    invalidateApiCache("/api/admin/notifications");
    return;
  }
  if (path.startsWith("/api/admin")) {
    invalidateApiCache("/api/admin", "/api/boards", "/api/firmware");
  }
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  ensureFetchEpoch();
  const method = (options?.method ?? "GET").toUpperCase();
  const headers = new Headers(options?.headers);
  if (
    options?.body &&
    !(options.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers,
  });

  const contentType = response.headers.get("content-type") ?? "";
  let parsed: unknown = null;
  if (contentType.includes("application/json")) {
    parsed = await response.json().catch(() => null);
  } else {
    const text = await response.text().catch(() => "");
    parsed = text ? { error: text } : null;
  }

  if (!response.ok) {
    const obj = parsed as { error?: string; code?: string; details?: unknown } | null;
    throw new ApiError(
      obj?.error ?? `Request failed (${response.status})`,
      response.status,
      obj?.code,
      obj?.details
    );
  }

  if (method !== "GET" && method !== "HEAD") {
    invalidateCacheForMutation(path);
  }

  return parsed as T;
}

export function getCachedSnapshot<T>(path: string, maxAgeMs = 120_000): T | null {
  ensureFetchEpoch();
  const entry = getCache.get(path);
  if (!entry) return null;
  if (Date.now() - entry.ts > maxAgeMs) return null;
  return entry.data as T;
}

export async function cachedGet<T>(
  path: string,
  options?: { ttlMs?: number; force?: boolean }
): Promise<T> {
  ensureFetchEpoch();
  const ttlMs = options?.ttlMs ?? 15_000;
  if (!options?.force) {
    const entry = getCache.get(path);
    if (entry && Date.now() - entry.ts < ttlMs) {
      return entry.data as T;
    }
  }

  const existing = inflightGets.get(path);
  if (existing && !options?.force) {
    return existing as Promise<T>;
  }

  const promise = apiFetch<T>(path)
    .then((data) => {
      getCache.set(path, { data, ts: Date.now() });
      return data;
    })
    .finally(() => {
      if (inflightGets.get(path) === promise) {
        inflightGets.delete(path);
      }
    });

  inflightGets.set(path, promise);
  return promise;
}

export async function sha256HexClient(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function apiUploadWithProgress<T>(
  path: string,
  formData: FormData,
  onProgress?: (percent: number) => void
): Promise<T> {
  ensureFetchEpoch();
  const fetchIsMocked =
    typeof globalThis.fetch === "function" &&
    ("mock" in (globalThis.fetch as unknown as Record<string, unknown>) ||
      globalThis.fetch.name === "mockConstructor");

  if (typeof XMLHttpRequest === "undefined" || fetchIsMocked) {
    onProgress?.(35);
    const res = await apiFetch<T>(path, { method: "POST", body: formData });
    onProgress?.(100);
    return res;
  }

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path, true);
    xhr.withCredentials = true;

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable && evt.total > 0) {
        onProgress?.(Math.min(99, Math.round((evt.loaded / evt.total) * 100)));
      }
    };

    xhr.onload = () => {
      let parsed: unknown = null;
      const contentType = xhr.getResponseHeader("content-type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch {
          parsed = null;
        }
      } else if (xhr.responseText) {
        parsed = { error: xhr.responseText };
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        const obj = parsed as { error?: string; code?: string; details?: unknown } | null;
        reject(
          new ApiError(
            obj?.error ?? `Upload failed (${xhr.status})`,
            xhr.status,
            obj?.code,
            obj?.details
          )
        );
        return;
      }

      onProgress?.(100);
      invalidateCacheForMutation(path);
      resolve(parsed as T);
    };

    xhr.onerror = () => {
      reject(new ApiError("Network error during firmware upload.", 0));
    };

    xhr.send(formData);
  });
}
