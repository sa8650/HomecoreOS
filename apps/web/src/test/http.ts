/**
 * Shared HTTP fixture for the web test suites.
 *
 * A dozen component tests stub `fetch` and need the same "JSON response with a
 * Content-Type header" helper. One copy keeps the stub honest (a missing header
 * would silently change how `apiFetch` parses it).
 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
