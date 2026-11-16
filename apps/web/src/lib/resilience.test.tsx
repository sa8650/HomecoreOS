import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, normalizeAdminSession, normalizeUserSession } from "@/App";
import { ApiError, apiFetch } from "@/lib/api";
import {
  ErrorBoundary,
  isChunkLoadError,
  resetStaleChunkReloadGuard,
} from "@/components/layout/ErrorBoundary";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlResponse(markup = "<!doctype html><html><body>fallback</body></html>") {
  return new Response(markup, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  }) as unknown as typeof fetch;
}

const customerSession = {
  user: {
    id: "u1",
    email: "alice@example.com",
    fullName: "Alice Owner",
    appearancePreference: "system",
    timezone: "UTC",
  },
  account: {
    id: "a1",
    name: "Alice Home",
    slug: "alice-home",
    status: "active",
    staffRole: "owner",
  },
  accounts: [
    {
      id: "a1",
      name: "Alice Home",
      slug: "alice-home",
      status: "active",
      staffRole: "owner",
    },
  ],
  effectiveTimezone: "UTC",
  platformDefaultTimezone: "UTC",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.history.pushState({}, "", "/");
  sessionStorage.clear();
  vi.restoreAllMocks();
});

beforeEach(() => {
  sessionStorage.clear();
});

describe("apiFetch rejects payloads that are not API data", () => {
  it("throws ApiError instead of returning an HTML document with status 200", async () => {
    stubFetch(() => htmlResponse());

    await expect(apiFetch("/api/auth/me")).rejects.toMatchObject({
      name: "ApiError",
      status: 200,
      code: "NON_JSON_RESPONSE",
    });
    await expect(apiFetch("/api/auth/me")).rejects.toBeInstanceOf(ApiError);
  });

  it("names the SPA fallback as the likely cause", async () => {
    stubFetch(() => htmlResponse());
    await expect(apiFetch("/api/homes/overview")).rejects.toThrow(/HTML page/i);
  });

  it("throws on malformed JSON bodies", async () => {
    stubFetch(
      () =>
        new Response('{"broken":', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    await expect(apiFetch("/api/homes/overview")).rejects.toMatchObject({
      status: 200,
      code: "INVALID_JSON_RESPONSE",
    });
  });

  it("wraps a network failure in ApiError with status 0", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await expect(apiFetch("/api/auth/me")).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
    });
  });

  it("accepts an empty 204 body as success", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    await expect(apiFetch("/api/notifications/read-all", { method: "POST" })).resolves.toBeNull();
  });

  it("asks the worker for JSON so Cloudflare cannot negotiate an HTML page", async () => {
    const seen: Array<string | null> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("accept"));
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    await apiFetch("/api/homes/overview");
    expect(seen[0]).toBe("application/json");
  });

  it("still surfaces structured API errors", async () => {
    stubFetch(() => jsonResponse({ error: "Authentication required.", code: "UNAUTHORIZED" }, 401));
    await expect(apiFetch("/api/auth/me")).rejects.toMatchObject({
      status: 401,
      message: "Authentication required.",
      code: "UNAUTHORIZED",
    });
  });
});

describe("session payload validation", () => {
  it("rejects a session without user/account objects", () => {
    expect(normalizeUserSession({ ok: true })).toBeNull();
    expect(normalizeUserSession(null)).toBeNull();
    expect(normalizeUserSession({ user: { id: "u1" } })).toBeNull();
  });

  it("falls back to safe defaults for missing optional fields", () => {
    const session = normalizeUserSession({
      user: { id: "u1", email: "a@b.c" },
      account: { id: "a1", status: "weird", staffRole: "nope" },
    });
    expect(session).not.toBeNull();
    expect(session!.account.status).toBe("active");
    expect(session!.account.staffRole).toBe("viewer");
    expect(session!.accounts).toHaveLength(1);
    expect(session!.user.fullName).toBe("a@b.c");
  });

  it("keeps valid accounts and normalizes admin roles", () => {
    const admin = normalizeAdminSession({
      admin: { id: "ad1", email: "root@example.com", role: "super_admin" },
    });
    expect(admin?.admin.role).toBe("super_admin");
    expect(admin?.admin.fullName).toBe("root@example.com");
    expect(normalizeAdminSession({ admin: { email: "x@y.z" } })).toBeNull();
  });
});

describe("App survives broken API responses instead of going blank", () => {
  it("shows a recovery panel (not a blank page) when /api/auth/me answers with an HTML page", async () => {
    stubFetch((url) => {
      if (url.endsWith("/api/auth/me")) return htmlResponse();
      return jsonResponse({});
    });

    render(<App />);

    // A 200 HTML body means the API was never reached (SPA fallback / Access
    // page), so surface a reload prompt instead of a misleading sign-in form.
    await waitFor(() => {
      expect(screen.getByTestId("app-error-fallback")).toBeInTheDocument();
    });
    expect(screen.getByText(/HTML page/i)).toBeInTheDocument();
  });

  it("still shows the sign-in screen for a normal 401", async () => {
    stubFetch((url) => {
      if (url.endsWith("/api/auth/me")) {
        return jsonResponse({ error: "Authentication required.", code: "UNAUTHORIZED" }, 401);
      }
      return jsonResponse({});
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Customer User Console/i })).toBeInTheDocument();
    });
  });

  it("shows a recovery panel when the API fails hard (5xx)", async () => {
    stubFetch((url) => {
      if (url.endsWith("/api/auth/me")) {
        return jsonResponse({ error: "Internal server error." }, 500);
      }
      return jsonResponse({});
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("app-error-fallback")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Reload page/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument();
  });

  it("renders the settings route even when list endpoints omit their arrays", async () => {
    stubFetch((url) => {
      if (url.endsWith("/api/auth/me")) return jsonResponse(customerSession);
      // Deliberately missing `sessions` / `staff` / `preferences` keys.
      return jsonResponse({});
    });

    window.history.pushState({}, "", "/settings");
    render(<App />);

    await waitFor(() => {
      expect(screen.queryByTestId("app-error-fallback")).not.toBeInTheDocument();
    });
    expect((document.body.textContent ?? "").length).toBeGreaterThan(0);
  });

  it("does not blank the app when a route payload has the wrong shape", async () => {
    stubFetch((url) => {
      if (url.endsWith("/api/auth/me")) return jsonResponse(customerSession);
      if (url.startsWith("/api/boards")) return jsonResponse({ unexpected: true });
      return jsonResponse({});
    });

    window.history.pushState({}, "", "/boards");
    render(<App />);

    await waitFor(() => {
      expect(screen.queryByTestId("app-error-fallback")).not.toBeInTheDocument();
    });
    expect((document.body.textContent ?? "").length).toBeGreaterThan(0);
  });
});

describe("ErrorBoundary recovers the UI", () => {
  function Boom({ error }: { error: unknown }): never {
    throw error;
  }

  it("detects stale-chunk errors", () => {
    expect(
      isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: /assets/x.js"))
    ).toBe(true);
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/x.css"))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
  });

  it("renders a fallback instead of unmounting the tree", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <ErrorBoundary fallback={(error) => <p role="alert">caught: {(error as Error).message}</p>}>
          <Boom error={new Error("kaboom")} />
        </ErrorBoundary>
        <span>still here</span>
      </div>
    );

    expect(screen.getByRole("alert")).toHaveTextContent("caught: kaboom");
    expect(screen.getByText("still here")).toBeInTheDocument();
  });

  it("treats a stale route chunk as a reload prompt without navigating twice", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Pretend a reload already happened moments ago so the guard suppresses it.
    sessionStorage.setItem("homecoreos:chunk-reload-at", String(Date.now()));

    render(
      <ErrorBoundary
        fallback={(error) => <p role="alert">chunk: {isChunkLoadError(error) ? "yes" : "no"}</p>}
      >
        <Boom
          error={
            new TypeError(
              "Failed to fetch dynamically imported module: https://app.example/assets/FirmwarePage-old.js"
            )
          }
        />
      </ErrorBoundary>
    );

    expect(screen.getByRole("alert")).toHaveTextContent("chunk: yes");
    resetStaleChunkReloadGuard();
  });
});
