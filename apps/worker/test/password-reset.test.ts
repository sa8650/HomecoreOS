import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerApp } from "../src/index";
import type { WorkerBindings } from "../src/config/env";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";

const OLD_PASSWORD = "ForgottenPassw0rd!";
const NEW_PASSWORD = "BrandNewPassw0rd!";
const BREVO_KEY = "xkeysib-test-brevo-key";
const FROM_EMAIL = "no-reply@homecoreos.test";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName} in ${header}`);
  return `${cookieName}=${match[1]}`;
}

/** Captures the recovery code out of the Brevo payload the Worker really built. */
function createMockMail() {
  const sent: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    sent.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ messageId: `<${sent.length}@brevo>` }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  return { sent, fetch: fetchImpl };
}

describe("Password recovery with an emailed six-digit code", () => {
  let dbHarness: PgliteHarness;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;
  let mail: ReturnType<typeof createMockMail>;

  beforeAll(async () => {
    dbHarness = await createPglitePostgrest();
    mail = createMockMail();
    env = {
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-secret",
      EMQX_API_BASE: "https://mock.emqx.cloud:8443/api/v5",
      EMQX_APP_ID: "app-id",
      EMQX_APP_SECRET: "app-secret",
      EMQX_BROKER_HOST: "mock.emqx.cloud",
      EMQX_TLS_PORT: "8883",
      BREVO_API_KEY: BREVO_KEY,
      FIRMWARE_BUCKET: createMockR2Bucket(),
    };
    app = createWorkerApp({
      dbFetch: dbHarness.fetch,
      emqxFetch: createMockEmqxFetch().fetch,
      mailFetch: mail.fetch,
    });
    await dbHarness.pg.query(
      `UPDATE public.platform_settings SET brevo_from_email = $1, brevo_from_name = $2, brevo_reply_to = $3 WHERE id = 1`,
      [FROM_EMAIL, "HomecoreOS Test", "support@homecoreos.test"]
    );
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  function post(path: string, body: unknown) {
    return req(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function register(email: string) {
    const res = await post("/api/auth/register", {
      email,
      password: OLD_PASSWORD,
      fullName: "Recovery Owner",
      accountName: "Recovery Home",
    });
    expect(res.status).toBe(201);
    return extractCookie(res, "hc_user_session");
  }

  async function login(email: string, password: string) {
    return post("/api/auth/login", { email, password });
  }

  function lastCode(): string {
    const body = mail.sent[mail.sent.length - 1]!;
    const text = String(body.textContent ?? "");
    const match = text.match(/\b(\d{6})\b/);
    if (!match) throw new Error(`No six-digit code in ${text}`);
    return match[1]!;
  }

  it("emails a six-digit code from the configured sender without revealing accounts", async () => {
    const email = "recover.one@homecoreos.local";
    const cookie = await register(email);

    const unknown = await post("/api/auth/password-reset/request", {
      email: "nobody@homecoreos.local",
    });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ ok: true, expiresInMinutes: 10 });
    expect(mail.sent).toHaveLength(0);

    const res = await post("/api/auth/password-reset/request", { email });
    expect(res.status).toBe(200);

    const payload = mail.sent[0]!;
    expect(payload).toMatchObject({
      sender: { name: "HomecoreOS Test", email: FROM_EMAIL },
      replyTo: { email: "support@homecoreos.test" },
      to: [{ email }],
    });
    expect(String(payload.textContent)).toContain("HomecoreOS Test");
    expect(String(payload.htmlContent)).toContain("Password recovery code");
    expect(lastCode()).toMatch(/^\d{6}$/);

    // A second request inside the cooldown is refused rather than re-sent.
    const again = await post("/api/auth/password-reset/request", { email });
    expect(again.status).toBe(429);
    expect(cookie).toBeTruthy();
  });

  it("reports recovery as not configured when the Brevo key is absent", async () => {
    const email = "recover.nokey@homecoreos.local";
    await register(email);
    const res = await app.fetch(
      new Request("https://homecore.local/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
      { ...env, BREVO_API_KEY: "" }
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "EMAIL_NOT_CONFIGURED" });
  });

  it("rejects a wrong code, then accepts the right one once", async () => {
    const email = "recover.two@homecoreos.local";
    await register(email);
    expect((await post("/api/auth/password-reset/request", { email })).status).toBe(200);
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";

    const rejected = await post("/api/auth/password-reset/verify", { email, otp: wrong });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: "OTP_MISMATCH", attemptsRemaining: 4 });

    const malformed = await post("/api/auth/password-reset/verify", { email, otp: "12ab" });
    expect(malformed.status).toBe(400);

    const verified = await post("/api/auth/password-reset/verify", { email, otp: code });
    expect(verified.status).toBe(200);
    const { resetToken } = (await verified.json()) as { resetToken: string };
    expect(resetToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    // The code is spent, so it cannot be verified twice.
    const replay = await post("/api/auth/password-reset/verify", { email, otp: code });
    expect(replay.status).toBe(400);

    const done = await post("/api/auth/password-reset/confirm", {
      resetToken,
      newPassword: NEW_PASSWORD,
    });
    expect(done.status).toBe(200);

    // The token is single use.
    const reused = await post("/api/auth/password-reset/confirm", {
      resetToken,
      newPassword: "AnotherPassw0rd!",
    });
    expect(reused.status).toBe(400);

    expect((await login(email, OLD_PASSWORD)).status).toBe(401);
    expect((await login(email, NEW_PASSWORD)).status).toBe(200);
  });

  it("revokes every existing session when the new password is saved", async () => {
    const email = "recover.three@homecoreos.local";
    const sessionCookie = await register(email);
    expect((await req("/api/auth/me", { headers: { Cookie: sessionCookie } })).status).toBe(200);

    expect((await post("/api/auth/password-reset/request", { email })).status).toBe(200);
    const verified = await post("/api/auth/password-reset/verify", {
      email,
      otp: lastCode(),
    });
    const { resetToken } = (await verified.json()) as { resetToken: string };
    expect(
      (
        await post("/api/auth/password-reset/confirm", {
          resetToken,
          newPassword: NEW_PASSWORD,
        })
      ).status
    ).toBe(200);

    expect((await req("/api/auth/me", { headers: { Cookie: sessionCookie } })).status).toBe(401);
    const fresh = await login(email, NEW_PASSWORD);
    expect(fresh.status).toBe(200);
    expect((await req("/api/auth/me", {
      headers: { Cookie: extractCookie(fresh, "hc_user_session") },
    })).status).toBe(200);
  });

  it("expires a code that is older than its window", async () => {
    const email = "recover.four@homecoreos.local";
    await register(email);
    expect((await post("/api/auth/password-reset/request", { email })).status).toBe(200);
    await dbHarness.pg.query(
      `UPDATE public.password_reset_otps
          SET expires_at = now() - interval '1 minute'
        WHERE email = $1`,
      [email]
    );
    const res = await post("/api/auth/password-reset/verify", { email, otp: lastCode() });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: "OTP_EXPIRED" });
  });
});
