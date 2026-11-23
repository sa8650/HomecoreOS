/**
 * Shared HTTP assertions for Worker route tests.
 *
 * Twenty-odd suites need the same two things from a `Response`: pull a session
 * cookie out of `set-cookie`, and parse a JSON body. Keeping one copy here means
 * a failure message ("Missing cookie X in <header>") and JSON typing stay
 * identical everywhere instead of drifting across 24 local copies.
 */

/** Returns `${name}=${value}` for the named cookie, or throws with the header. */
export function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName} in ${header}`);
  return `${cookieName}=${match[1]}`;
}

/** Parses a JSON response body, failing with the status when it is not JSON. */
export async function readJson<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON (HTTP ${res.status}) but received: ${text.slice(0, 200)}`);
  }
}
