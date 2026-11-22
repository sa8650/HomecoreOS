import { Hono } from "hono";
import {
  buildRealtimeSnapshot,
  buildRealtimeSubscription,
  ensureRealtimeCredential,
  RealtimeSnapshotError,
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
    c.header("Cache-Control", "no-store");
    try {
      const snapshot = await buildRealtimeSnapshot(c.get("db"), auth.accountId);
      return c.json({ snapshot });
    } catch (err) {
      // Never answer a failed read with an empty entity list: the browser would
      // conclude that every device vanished and report itself as synchronized.
      const entity = err instanceof RealtimeSnapshotError ? err.entity : "unknown";
      const detail = err instanceof Error ? err.message : "Snapshot unavailable";
      console.warn(`[realtime] snapshot failed (${entity}): ${detail}`);
      return c.json(
        {
          error: "Realtime snapshot unavailable. Retry shortly.",
          reason: "snapshot_unavailable",
          entity,
        },
        503
      );
    }
  });

  return app;
}
