import { Hono } from "hono";
import {
  buildRealtimeSnapshot,
  buildRealtimeSubscription,
  ensureRealtimeCredential,
  REALTIME_MAX_EVENTS_PER_MESSAGE,
} from "../lib/realtime";
import { requireUserSession } from "../middleware/auth";
import type { AppEnv } from "../types/context";

/**
 * Browser-facing real-time endpoints.
 *
 *   GET /api/realtime/config    subscribe-only MQTT-over-WebSocket identity
 *   GET /api/realtime/snapshot  compact entity-version map for reconciliation
 *
 * Both endpoints are per-session and never cacheable: the broker password is
 * derived from the Worker's app secret and must not sit in a shared cache.
 */
export function createRealtimeRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/config", requireUserSession(), async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const deps = c.get("deps") ?? {};
    const force = c.req.query("reprovision") === "1";

    const result = await ensureRealtimeCredential({
      db,
      env: c.env ?? {},
      deps,
      sessionId: auth.sessionId,
      accountId: auth.accountId,
      userId: auth.userId,
      force,
    });

    c.header("Cache-Control", "no-store");
    if (!result.ok) {
      return c.json({
        enabled: false,
        reason: result.reason,
        accountId: auth.accountId,
        topic: buildRealtimeSubscription(auth.accountId),
        transport: "mqtt-ws",
        maxEventsPerMessage: REALTIME_MAX_EVENTS_PER_MESSAGE,
      });
    }

    return c.json({
      enabled: true,
      accountId: auth.accountId,
      transport: "mqtt-ws",
      maxEventsPerMessage: REALTIME_MAX_EVENTS_PER_MESSAGE,
      credential: result.credential,
    });
  });

  app.get("/snapshot", requireUserSession(), async (c) => {
    const auth = c.get("userAuth")!;
    const snapshot = await buildRealtimeSnapshot(c.get("db"), auth.accountId);
    c.header("Cache-Control", "no-store");
    return c.json({ snapshot });
  });

  return app;
}
