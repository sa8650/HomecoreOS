import type { DbClient } from "./db";

export type ActivityCategory =
  | "controller"
  | "device"
  | "switch"
  | "sensor"
  | "pairing"
  | "firmware"
  | "account"
  | "staff"
  | "automation"
  | "admin"
  | "security";

export async function recordActivity(
  db: DbClient,
  entry: {
    accountId?: string | null;
    actorUserId?: string | null;
    controllerId?: string | null;
    category: ActivityCategory;
    action: string;
    summary: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await db.from("activity_logs").insert({
    account_id: entry.accountId ?? null,
    actor_user_id: entry.actorUserId ?? null,
    controller_id: entry.controllerId ?? null,
    category: entry.category,
    action: entry.action,
    summary: entry.summary,
    metadata: entry.metadata ?? {},
  });
}
