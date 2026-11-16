import { describe, expect, it } from "vitest";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";

/**
 * These guard the "white screen after deploy" class of bug:
 *  - a stale `/assets/<old-hash>.js` request must never be answered with the
 *    SPA's index.html (the browser would try to parse HTML as JavaScript and
 *    the lazy route import would reject),
 *  - unknown API routes must answer JSON, never HTML,
 *  - the Worker's own error path must stay machine readable.
 */
const env = {} as WorkerBindings;

describe("Worker static asset and API fallbacks", () => {
  const app = createWorkerApp({});

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecoreos.example${path}`, init), env);
  }

  it("answers a stale hashed asset with 404 instead of index.html", async () => {
    const res = await req("/assets/index-DNwJ93j8.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("text/plain");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).not.toContain("<!doctype html");
    expect(body.toLowerCase()).not.toContain("<html");
  });

  it("keeps unknown API routes as JSON", async () => {
    const res = await req("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    await expect(res.json()).resolves.toMatchObject({ error: "API route not found." });
  });

  it("does not answer /api/auth/me with an HTML page", async () => {
    const res = await req("/api/auth/me");
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(res.status).toBeGreaterThanOrEqual(400);
    const text = await res.text();
    expect(text.trim().startsWith("<")).toBe(false);
  });

  it("serves a real hashed asset with a long-lived immutable cache", async () => {
    const asset = new Response("console.log('real bundle');", {
      status: 200,
      headers: { "Content-Type": "application/javascript" },
    });
    const res = await app.fetch(new Request("https://homecoreos.example/assets/index-abc123.js"), {
      ...env,
      ASSETS: { fetch: async () => asset.clone() },
    } as unknown as WorkerBindings);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toContain("real bundle");
  });

  it("converts an SPA-fallback HTML answer for /assets/* into 404", async () => {
    // This is exactly what Cloudflare returned in production for an old hash:
    // 200 + text/html. Serving that to a module import blanks the app.
    const htmlFallback = new Response("<!doctype html><html><body></body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    const res = await app.fetch(new Request("https://homecoreos.example/assets/index-oldhash.js"), {
      ...env,
      ASSETS: { fetch: async () => htmlFallback.clone() },
    } as unknown as WorkerBindings);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-homecore-stale-asset")).toBe("1");
    const body = await res.text();
    expect(body.toLowerCase()).not.toContain("<html");
  });

  it("answers customer routes with the SPA shell when assets are bound", async () => {
    const shell = new Response("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    const appWithAssets = createWorkerApp({});
    const res = await appWithAssets.fetch(
      new Request("https://homecoreos.example/rooms"),
      {
        ...env,
        ASSETS: { fetch: async () => shell.clone() },
      } as unknown as WorkerBindings
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });
});
