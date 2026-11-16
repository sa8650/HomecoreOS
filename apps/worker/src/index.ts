import { Hono } from "hono";
import { inspectConfiguration, type WorkerBindings } from "./config/env";
import { evaluateScheduledAutomations } from "./lib/automation-engine";
import { createDbClient } from "./lib/db";
import { emitNotification } from "./lib/notifications";
import { dbMiddleware } from "./middleware/auth";
import { createAccountRoutes } from "./routes/account";
import { createAdminRoutes } from "./routes/admin";
import { createAuthRoutes } from "./routes/auth";
import { createAutomationRoutes } from "./routes/automations";
import { createBoardRoutes } from "./routes/boards";
import { createControllerRoutes } from "./routes/controllers";
import { createDeviceApiRoutes } from "./routes/device-api";
import { createDeviceRoutes } from "./routes/devices";
import { createFirmwareRoutes } from "./routes/firmware";
import { createHomeRoutes } from "./routes/homes";
import {
  createAdminNotificationRoutes,
  createUserNotificationRoutes,
} from "./routes/notifications";
import { createPlannerRoutes } from "./routes/planner";
import type { AppEnv, WorkerRuntimeDeps } from "./types/context";

/** Every path prefix that a real API router is mounted under. */
const KNOWN_API_PREFIXES = [
  "/api/auth",
  "/api/account",
  "/api/homes",
  "/api/boards",
  "/api/controllers",
  "/api/automations",
  "/api/firmware",
  "/api/notifications",
  "/api/planner",
  "/api/admin",
  "/api/device",
  "/api/switches",
  "/api/devices",
  "/api/sensors",
];

export function createWorkerApp(defaultDeps?: WorkerRuntimeDeps) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    if (defaultDeps) {
      c.set("deps", defaultDeps);
    } else {
      c.set("deps", {});
    }
    await next();
  });

  // Only build a database client for routes that need one. Unknown /api paths
  // must fall through to the JSON 404 handler instead of failing here with a
  // 500 when Supabase is not configured.
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "GET" && KNOWN_API_PREFIXES.every((p) => !c.req.path.startsWith(p))) {
      if (!c.req.path.startsWith("/api/device/")) {
        return c.json({ error: "API route not found." }, 404);
      }
    }
    return dbMiddleware()(c, next);
  });

  // Stale-hash guard. `not_found_handling: "single-page-application"` answers
  // any missing asset with index.html and a 200, so a tab left open across a
  // deploy requests the previous `/assets/<hash>.js`, receives HTML, and the
  // dynamic import rejects - which used to blank the whole app. `/assets/*` is
  // listed in `run_worker_first`, so this handler sees those requests first.
  app.get("/assets/*", async (c) => {
    const assets = c.env?.ASSETS;
    if (!assets) return c.notFound();

    const res = await assets.fetch(c.req.raw);
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();

    // The asset worker answered with the SPA shell: this hash no longer exists.
    if (contentType.includes("text/html")) {
      return new Response("This build is out of date. Reload the page to continue.", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Homecore-Stale-Asset": "1",
        },
      });
    }

    const headers = new Headers(res.headers);
    // Hashed filenames are immutable; revalidation only wastes round trips.
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(res.body, { status: res.status, headers });
  });

  app.get("/health", (c) => {
    const cfg = inspectConfiguration(c.env ?? {});
    const missingVariables = cfg.entries
      .filter((e) => e.kind !== "secret" && !e.valid)
      .map((e) => e.key);
    const missingSecretsCount = cfg.entries.filter(
      (e) => e.kind === "secret" && !e.valid
    ).length;
    return c.json({
      status: "ok",
      service: "homecoreos-worker",
      supabaseConfigured: cfg.supabaseReady,
      emqxConfigured: cfg.emqxReady,
      r2Bound: cfg.r2Ready,
      missingVariables,
      missingSecretsCount,
    });
  });

  // Customer & Auth APIs
  app.route("/api/auth", createAuthRoutes());
  app.route("/api/account", createAccountRoutes());
  app.route("/api/homes", createHomeRoutes());
  app.route("/api/boards", createBoardRoutes());
  app.route("/api/controllers", createControllerRoutes());
  app.route("/api/automations", createAutomationRoutes());
  app.route("/api/firmware", createFirmwareRoutes());
  app.route("/api/notifications", createUserNotificationRoutes());
  app.route("/api/planner", createPlannerRoutes());
  app.route("/api", createDeviceRoutes());

  // Device / ESP32 Controller APIs
  app.route("/api/device", createDeviceApiRoutes());

  // Platform Admin APIs (completely separated)
  app.route("/api/admin/notifications", createAdminNotificationRoutes());
  app.route("/api/admin", createAdminRoutes());

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "API route not found." }, 404);
    }
    if (c.req.path.startsWith("/assets/")) {
      // Never answer a stale asset request with index.html: the browser would
      // parse HTML as JavaScript and the dynamic import would reject.
      return new Response("Asset not found. Reload the page to get the latest build.", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    if (c.env?.ASSETS) {
      return c.env.ASSETS.fetch(c.req.raw);
    }
    return c.text("Not Found", 404);
  });

  app.onError((err, c) => {
    console.error("HomecoreOS Worker error:", err.message);
    try {
      const db = c.get("db");
      if (db && c.req.path.startsWith("/api/")) {
        const emitPromise = emitNotification(db, {
          scope: "admin",
          category: "system",
          eventKey: "admin.platform_error",
          preferenceKey: "platform_errors",
          severity: "danger",
          title: `Worker Error on ${c.req.path}`,
          message: err.message || "Unhandled Worker exception.",
          dedupKey: `err:${c.req.path}:${(err.message || "").slice(0, 40)}`,
          dedupWindowSeconds: 300,
        }).catch(() => null);
        try {
          c.executionCtx.waitUntil(emitPromise);
        } catch {
          void emitPromise;
        }
      }
    } catch {
      // Ignore notification emission errors inside error handler
    }
    if (c.req.path.startsWith("/api/")) {
      return c.json(
        { error: err.message || "Internal server error." },
        500
      );
    }
    return c.text("Internal Server Error", 500);
  });

  return app;
}

const app = createWorkerApp();

export default {
  fetch(request: Request, env: WorkerBindings, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  scheduled(
    event: { scheduledTime?: number },
    env: WorkerBindings,
    ctx: ExecutionContext
  ) {
    const cfg = inspectConfiguration(env);
    if (!cfg.supabaseReady) return;
    const now =
      typeof event.scheduledTime === "number"
        ? new Date(event.scheduledTime)
        : new Date();
    const db = createDbClient(env);
    ctx.waitUntil(
      evaluateScheduledAutomations({ db, env, now }).catch((err) => {
        console.error("HomecoreOS scheduled automation tick failed:", err);
      })
    );
  },
};
