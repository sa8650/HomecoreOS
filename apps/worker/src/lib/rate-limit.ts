import type { DbClient } from "./db";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCK_MS = 15 * 60 * 1000; // 15 minutes

interface LoginAttemptRow {
  id: string;
  identifier: string;
  ip_address: string;
  attempt_count: number;
  first_attempt_at: string;
  locked_until: string | null;
}

export function extractClientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "0.0.0.0"
  );
}

export async function checkAttemptAllowed(
  db: DbClient,
  identifier: string,
  ipAddress: string
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const { data } = await db
    .from("login_attempts")
    .select("*")
    .eq("identifier", identifier)
    .eq("ip_address", ipAddress)
    .maybeSingle();

  const row = data as LoginAttemptRow | null;
  if (!row || !row.locked_until) {
    return { allowed: true };
  }

  const lockedUntilMs = new Date(row.locked_until).getTime();
  const nowMs = Date.now();
  if (lockedUntilMs > nowMs) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((lockedUntilMs - nowMs) / 1000)),
    };
  }

  return { allowed: true };
}

export async function recordFailedAttempt(
  db: DbClient,
  identifier: string,
  ipAddress: string,
  maxAttempts = MAX_ATTEMPTS
): Promise<{ locked: boolean; attemptsRemaining: number }> {
  const now = new Date();
  const { data } = await db
    .from("login_attempts")
    .select("*")
    .eq("identifier", identifier)
    .eq("ip_address", ipAddress)
    .maybeSingle();

  const existing = data as LoginAttemptRow | null;
  if (!existing) {
    await db.from("login_attempts").insert({
      identifier,
      ip_address: ipAddress,
      attempt_count: 1,
      first_attempt_at: now.toISOString(),
      locked_until: null,
      updated_at: now.toISOString(),
    });
    return { locked: false, attemptsRemaining: Math.max(0, maxAttempts - 1) };
  }

  const windowExpired =
    now.getTime() - new Date(existing.first_attempt_at).getTime() > WINDOW_MS;
  const nextCount = windowExpired ? 1 : existing.attempt_count + 1;
  const shouldLock = nextCount >= maxAttempts;
  const lockedUntil = shouldLock
    ? new Date(now.getTime() + LOCK_MS).toISOString()
    : null;

  await db
    .from("login_attempts")
    .update({
      attempt_count: nextCount,
      first_attempt_at: windowExpired
        ? now.toISOString()
        : existing.first_attempt_at,
      locked_until: lockedUntil,
      updated_at: now.toISOString(),
    })
    .eq("id", existing.id);

  return {
    locked: shouldLock,
    attemptsRemaining: Math.max(0, maxAttempts - nextCount),
  };
}

export async function resetAttempts(
  db: DbClient,
  identifier: string,
  ipAddress: string
): Promise<void> {
  await db
    .from("login_attempts")
    .delete()
    .eq("identifier", identifier)
    .eq("ip_address", ipAddress);
}
