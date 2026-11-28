import { Hono } from "hono";
import {
  BOARD_LOG_DEFAULT_PAGE_SIZE,
  BOARD_LOG_MAX_PAGE_SIZE,
  isBoardLogCategory,
  isBoardLogSeverity,
} from "@homecoreos/shared";
import { listBoardLogs } from "../lib/board-log";
import { requireUserSession } from "../middleware/auth";
import type { AppEnv } from "../types/context";

/**
 * Per-board live Log API.
 *
 * One board per request, one account per session: the board is resolved with
 * the session's account id in the same query, so a user can never read the log
 * of a board they do not own and never sees the log of another board.
 *
 * There is no delete endpoint on purpose — "Clear View" in the console only
 * clears the view; stored records are removed by the retention sweep.
 */
export function createBoardLogRoutes() {
  const app = new Hono<AppEnv>();

  app.use("*", requireUserSession());

  app.get("/:boardInstanceId", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const boardInstanceId = c.req.param("boardInstanceId");

    const { data: board } = await db
      .from("board_instances")
      .select("id,name,status,board_role,last_heartbeat_at,last_communication_at,mqtt_connected,wifi_connected,node_link_state,comm_mode")
      .eq("id", boardInstanceId)
      .eq("account_id", auth.accountId)
      .is("deleted_at", null)
      .is("permanently_deleted_at", null)
      .maybeSingle();

    // A board that is not owned by this account is reported as "not found",
    // never as "forbidden": the caller learns nothing about other accounts.
    if (!board) return c.json({ error: "Board not found." }, 404);

    const limitRaw = Number(c.req.query("limit") ?? BOARD_LOG_DEFAULT_PAGE_SIZE);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(1, Math.trunc(limitRaw)), BOARD_LOG_MAX_PAGE_SIZE)
      : BOARD_LOG_DEFAULT_PAGE_SIZE;

    const categoryRaw = c.req.query("category");
    const severityRaw = c.req.query("severity");
    const beforeRaw = c.req.query("before");

    try {
      const page = await listBoardLogs(db, {
        accountId: auth.accountId,
        boardInstanceId,
        limit,
        before: beforeRaw ?? null,
        category: categoryRaw ?? null,
        severity: severityRaw ?? null,
        search: c.req.query("q") ?? null,
      });

      const boardRow = board as Record<string, unknown>;
      return c.json({
        board: {
          id: String(boardRow.id),
          name: boardRow.name ?? null,
          status: boardRow.status ?? null,
          boardRole: boardRow.board_role ?? null,
          lastHeartbeatAt: boardRow.last_heartbeat_at ?? null,
          lastCommunicationAt: boardRow.last_communication_at ?? null,
          mqttConnected: boardRow.mqtt_connected ?? null,
          wifiConnected: boardRow.wifi_connected ?? null,
          nodeLinkState: boardRow.node_link_state ?? null,
          commMode: boardRow.comm_mode ?? null,
        },
        entries: page.entries,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        filters: {
          category: isBoardLogCategory(categoryRaw) ? categoryRaw : null,
          severity: isBoardLogSeverity(severityRaw) ? severityRaw : null,
        },
      });
    } catch (err) {
      console.error(
        `[board-logs] read failed: ${err instanceof Error ? err.message : "unknown error"}`
      );
      return c.json({ error: "Failed to read the board log." }, 500);
    }
  });

  return app;
}
