# Frontend Reliability & Audit Fixes

Applied on top of `main` @ `6d73829`. Scope is limited to reliability,
robustness and accessibility; no page was redesigned and no backend, schema or
migration was changed.

## What this fixes

### 1. Blank/white screen after a deploy (the original bug)

Three independent defects could blank the whole console, each leaving `#root`
empty with no way to recover:

* **Stale hashed assets answered with HTML.** `not_found_handling:
  "single-page-application"` responds to a missing `/assets/<old-hash>.js` with
  `index.html` and a `200`. A tab open across a deploy requests the previous
  bundle, the browser tries to parse HTML as JavaScript, and the dynamic import
  rejects. A Workers route now answers `/assets/*` itself: real assets get
  `Cache-Control: immutable`, and anything that comes back as HTML becomes a
  `404 text/plain` ("This build is out of date…"). `/assets/*` is added to
  `run_worker_first` so the Worker sees these requests before the asset server.
* **A `200` that is not JSON was treated as data.** If `/api/auth/me` answered
  with an HTML page (SPA fallback, Cloudflare Access, a proxy), the body
  `{ error: "<!doctype html>…" }` was handed to the app, which then read
  `.account.status` off `undefined` and threw during render. `apiFetch` now
  rejects non-JSON `2xx` (`NON_JSON_RESPONSE`), malformed JSON
  (`INVALID_JSON_RESPONSE`) and network failures (`ApiError` with status `0`),
  and sends `Accept: application/json`.
* **No error boundary existed anywhere.** A single render error unmounted the
  entire React tree permanently, so every later route stayed blank. Added
  `ErrorBoundary` / `RouteErrorBoundary` at the root and around each route,
  plus `vite:preloadError` and `unhandledrejection` handling.

### 2. Session payload validation

`normalizeUserSession` / `normalizeAdminSession` validate every field before it
reaches React state. A `401`/`403` still shows the normal sign-in screen; a `5xx`,
non-JSON or network failure shows a recovery panel instead.

### 3. List payload guards

`asList<T>(value)` keeps list state render-safe when a response omits the
expected array, applied in `ControllersPage`, `FirmwarePage` and
`SmartHomePlannerPage` (`ActivityAndSettingsPages` and
`AdminAccountsAndBoardsPages` already had equivalent guards).

### 4. Unknown API routes answer JSON, not 500

Before the fix, an unknown `/api/*` path built a database client first and
returned `500` (or an HTML error page) when Supabase was not configured. A guard
now returns `{"error":"API route not found."}` with `404` before any client is
built.

> **Note:** the guard keeps a prefix list, and a missing prefix silently
> disables a whole router. During rebasing this actually happened:
> `/api/action-button` and `/api/activity` were absent, which broke the Action
> Button list endpoint. Both are now present, and
> `asset-and-api-fallbacks.test.ts` walks the real route table so a future
> router cannot regress this way unnoticed.

### 5. Accessibility — WCAG 2.1 AA contrast

| Token | Was | Now | Result |
|---|---|---|---|
| light `--primary` | `#3b76f6` | `#2d63db` | white label 4.11 → **5.36:1** |
| light `--muted-foreground` | `#64748b` | `#5b6b80` | on background 4.43 → **5.07:1** |
| dark `--primary-foreground` | `#ffffff` | `#0f172a` | on `#5b93f8` 3.01 → **5.93:1** |

### 6. Boot payload

`esptool-js` was pinned to a manual chunk, which made Rollup hoist Vite's
`__vitePreload` helper into that 313 kB chunk, so the entry imported it
synchronously on boot. Removing the forced chunk keeps the USB flasher a true
lazy import; boot now loads react, radix and icons only.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` (shared, web, worker) | pass |
| `npm run lint` | pass |
| `npm run build` | pass |
| `packages/shared` tests | 199 passed |
| `apps/worker` tests | 77 passed |
| `apps/web` tests | 226 passed |
| **Total** | **502 passed** |
| `wrangler deploy --dry-run` | pass |
