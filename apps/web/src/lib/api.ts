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
  source?: string;
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
  unreadCount?: number,
  source?: string
): void {
  for (const listener of notificationListeners) {
    listener({ scope, unreadCount, source });
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
    path.startsWith("/api/auth/login") ||
    path.startsWith("/api/auth/register") ||
    path.startsWith("/api/auth/invitations/accept") ||
    path.startsWith("/api/auth/logout") ||
    path.startsWith("/api/auth/switch-account") ||
    path.startsWith("/api/admin/auth/login") ||
    path.startsWith("/api/admin/auth/bootstrap") ||
    path.startsWith("/api/admin/auth/logout")
  ) {
    getCache.clear();
    inflightGets.clear();
    return;
  }
  if (path.startsWith("/api/switches")) {
    invalidateApiCache("/api/switches", "/api/homes/overview", "/api/activity");
    return;
  }
  if (path.startsWith("/api/devices")) {
    // Device and controller counts feed the planner's account-limit check.
    invalidateApiCache("/api/devices", "/api/homes/overview", "/api/planner", "/api/activity");
    return;
  }
  if (path.startsWith("/api/sensors")) {
    invalidateApiCache("/api/sensors", "/api/homes/overview", "/api/activity");
    return;
  }
  if (path.startsWith("/api/homes")) {
    invalidateApiCache("/api/homes", "/api/switches", "/api/devices", "/api/sensors", "/api/activity");
    return;
  }
  if (path.startsWith("/api/controllers")) {
    invalidateApiCache(
      "/api/controllers",
      "/api/homes/overview",
      "/api/boards/my-boards",
      "/api/switches",
      "/api/devices",
      "/api/sensors",
      "/api/planner",
      "/api/activity"
    );
    return;
  }
  if (path.startsWith("/api/boards")) {
    // A custom board is a planner candidate, so saved plan verdicts may be stale.
    invalidateApiCache("/api/boards", "/api/planner", "/api/activity");
    return;
  }
  if (path.startsWith("/api/planner")) {
    invalidateApiCache("/api/planner");
    return;
  }
  if (path.startsWith("/api/automations")) {
    invalidateApiCache("/api/automations", "/api/activity");
    if (
      path.endsWith("/run") ||
      path.endsWith("/test") ||
      path.endsWith("/evaluate-schedules")
    ) {
      invalidateApiCache("/api/switches", "/api/devices", "/api/homes/overview");
    }
    return;
  }
  if (path.startsWith("/api/firmware")) {
    invalidateApiCache("/api/firmware", "/api/controllers", "/api/activity");
    return;
  }
  if (path.startsWith("/api/account") || path.startsWith("/api/auth/change-password")) {
    invalidateApiCache("/api/account", "/api/auth", "/api/activity");
    return;
  }
  if (path.startsWith("/api/action-button")) {
    invalidateApiCache(
      "/api/switches",
      "/api/devices",
      "/api/homes/overview",
      "/api/activity"
    );
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
    // Board and firmware changes also invalidate Smart Home Planner results.
    invalidateApiCache("/api/admin", "/api/boards", "/api/firmware", "/api/planner");
  }
}

/**
 * A 2xx response that is not JSON means we did not actually reach the worker
 * API. Cloudflare's SPA fallback (`not_found_handling`), an Access/WAF login
 * page, or a proxy error page all answer `200 OK text/html`. Accepting that as
 * data used to hand pages an HTML string where they expected an object, which
 * threw during render and permanently blanked the SPA.
 */
const NON_JSON_PAYLOAD_MESSAGE =
  "The server returned an unexpected (non-JSON) response. Please reload the page and try again.";

function looksLikeHtml(text: string): boolean {
  return /^\s*<(!doctype|html|head|body)/i.test(text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalizes an error body into the `{ error, code, details }` shape we read. */
function toErrorPayload(parsed: unknown): ErrorPayload | null {
  if (isPlainObject(parsed)) {
    const error = typeof parsed.error === "string" ? parsed.error : undefined;
    const code = typeof parsed.code === "string" ? parsed.code : undefined;
    return { error, code, details: parsed.details };
  }
  return null;
}

interface ErrorPayload {
  error?: string;
  code?: string;
  details?: unknown;
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
  if (!headers.has("Accept")) {
    // Without this, Cloudflare/browsers may negotiate an HTML error page and
    // the worker can never answer with a machine-readable error body.
    headers.set("Accept", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "include",
      ...options,
      headers,
    });
  } catch (err) {
    throw new ApiError(
      err instanceof Error && err.message
        ? `Network error: ${err.message}`
        : "Network error: the server could not be reached.",
      0
    );
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const isJson = contentType.includes("json");
  // All API payloads are small JSON documents; read them as text first so a
  // truncated or HTML body surfaces as a clean ApiError instead of a TypeError.
  const rawText = await response.text().catch(() => "");
  let parsed: unknown = null;
  if (isJson && rawText.trim().length > 0) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    if (
      (response.status === 401 || response.status === 403) &&
      (path === "/api/auth/me" || path === "/api/admin/auth/me")
    ) {
      getCache.clear();
      inflightGets.clear();
    }
    const obj =
      parsed !== null
        ? toErrorPayload(parsed)
        : rawText.trim().length > 0 && !looksLikeHtml(rawText)
          ? { error: rawText.trim().slice(0, 300) }
          : null;
    throw new ApiError(
      obj?.error ?? `Request failed (${response.status})`,
      response.status,
      obj?.code,
      obj?.details
    );
  }

  if (!isJson) {
    // Empty bodies are a legitimate success (204 No Content and friends).
    if (rawText.trim().length === 0) {
      if (method !== "GET" && method !== "HEAD") invalidateCacheForMutation(path);
      return null as T;
    }
    throw new ApiError(
      looksLikeHtml(rawText)
        ? `${NON_JSON_PAYLOAD_MESSAGE} (the server sent an HTML page instead of API data)`
        : NON_JSON_PAYLOAD_MESSAGE,
      response.status,
      "NON_JSON_RESPONSE"
    );
  }

  if (parsed === null && rawText.trim().length > 0) {
    throw new ApiError(
      "The server returned malformed JSON. Please reload the page and try again.",
      response.status,
      "INVALID_JSON_RESPONSE"
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
