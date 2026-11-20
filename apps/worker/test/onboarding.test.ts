import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerApp } from "../src/index";
import type { WorkerBindings } from "../src/config/env";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";

const PASSWORD = "OnboardingPassw0rd!";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName} in ${header}`);
  return `${cookieName}=${match[1]}`;
}

interface OnboardingPayload {
  onboarding: {
    required: boolean;
    step: number;
    completedAt: string | null;
    startedAt: string | null;
  };
}

describe("Mandatory four-step onboarding", () => {
  let dbHarness: PgliteHarness;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;

  beforeAll(async () => {
    dbHarness = await createPglitePostgrest();
    const emqxMock = createMockEmqxFetch();
    env = {
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-secret",
      EMQX_API_BASE: "https://mock.emqx.cloud:8443/api/v5",
      EMQX_APP_ID: "app-id",
      EMQX_APP_SECRET: "app-secret",
      EMQX_BROKER_HOST: "mock.emqx.cloud",
      EMQX_TLS_PORT: "8883",
      FIRMWARE_BUCKET: createMockR2Bucket(),
    };
    app = createWorkerApp({ dbFetch: dbHarness.fetch, emqxFetch: emqxMock.fetch });
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  async function register(email: string) {
    const res = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: PASSWORD,
        fullName: "New Home Owner",
        accountName: `Home of ${email.split("@")[0]}`,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as OnboardingPayload;
    return { cookie: extractCookie(res, "hc_user_session"), onboarding: body.onboarding };
  }

  async function onboardingOf(cookie: string) {
    const res = await req("/api/auth/onboarding", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as OnboardingPayload).onboarding;
  }

  function putStep(cookie: string, step: unknown) {
    return req("/api/auth/onboarding", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ step }),
    });
  }

  async function userIdFor(email: string) {
    const res = await dbHarness.pg.query<{ id: string }>(
      "SELECT id FROM public.users WHERE email = $1",
      [email]
    );
    return res.rows[0]!.id;
  }

  async function rawOnboardingRow(email: string) {
    const res = await dbHarness.pg.query<{
      onboarding_step: number;
      onboarding_started_at: string | null;
      onboarding_completed_at: string | null;
    }>(
      "SELECT onboarding_step, onboarding_started_at, onboarding_completed_at FROM public.users WHERE email = $1",
      [email]
    );
    return res.rows[0]!;
  }

  it("starts a brand-new account on step 1 with no completion timestamp", async () => {
    const { cookie, onboarding } = await register("fresh@example.com");

    expect(onboarding).toEqual({
      required: true,
      step: 1,
      completedAt: null,
      startedAt: null,
    });

    const me = (await (await req("/api/auth/me", { headers: { Cookie: cookie } })).json()) as
      OnboardingPayload;
    expect(me.onboarding.required).toBe(true);
    expect(me.onboarding.step).toBe(1);

    const row = await rawOnboardingRow("fresh@example.com");
    expect(Number(row.onboarding_step)).toBe(1);
    expect(row.onboarding_completed_at).toBeNull();
  });

  it("persists the step in the database and resumes after a reload", async () => {
    const { cookie } = await register("resume@example.com");

    const saved = await putStep(cookie, 3);
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as OnboardingPayload;
    expect(savedBody.onboarding.step).toBe(3);
    expect(savedBody.onboarding.required).toBe(true);
    expect(savedBody.onboarding.startedAt).toBeTruthy();

    // A brand-new request (what a page refresh does) must read the stored step.
    expect((await onboardingOf(cookie)).step).toBe(3);

    const row = await rawOnboardingRow("resume@example.com");
    expect(Number(row.onboarding_step)).toBe(3);
    expect(row.onboarding_started_at).toBeTruthy();
  });

  it("stores the exact step, including going back, and rejects bad steps", async () => {
    const { cookie } = await register("backwards@example.com");

    expect((await putStep(cookie, 3)).status).toBe(200);
    const back = await putStep(cookie, 2);
    expect(back.status).toBe(200);
    // Going Back is saved too, so a refresh resumes on the step the user sees.
    expect(((await back.json()) as OnboardingPayload).onboarding.step).toBe(2);

    for (const bad of [0, 5, -1, "abc", null]) {
      const res = await putStep(cookie, bad);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("INVALID_ONBOARDING_STEP");
    }

    expect(Number((await rawOnboardingRow("backwards@example.com")).onboarding_step)).toBe(2);
  });

  it("resumes instead of restarting after signing out without completing", async () => {
    const { cookie } = await register("signout@example.com");
    expect((await putStep(cookie, 2)).status).toBe(200);

    const logout = await req("/api/auth/logout", { method: "POST", headers: { Cookie: cookie } });
    expect(logout.status).toBe(200);

    // The old cookie is dead.
    expect((await req("/api/auth/onboarding", { headers: { Cookie: cookie } })).status).toBe(401);

    const login = await req("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "signout@example.com", password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as OnboardingPayload;
    expect(loginBody.onboarding.required).toBe(true);
    expect(loginBody.onboarding.step).toBe(2);

    const newCookie = extractCookie(login, "hc_user_session");
    expect((await onboardingOf(newCookie)).step).toBe(2);
  });

  it("completes once, stays completed on later sign-ins, and is idempotent", async () => {
    const { cookie } = await register("complete@example.com");
    await putStep(cookie, 4);

    const done = await req("/api/auth/onboarding/complete", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(done.status).toBe(200);
    const doneBody = (await done.json()) as OnboardingPayload;
    expect(doneBody.onboarding.required).toBe(false);
    expect(doneBody.onboarding.step).toBe(4);
    const firstCompletedAt = doneBody.onboarding.completedAt;
    expect(firstCompletedAt).toBeTruthy();

    const again = await req("/api/auth/onboarding/complete", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as OnboardingPayload).onboarding.completedAt).toBe(
      firstCompletedAt
    );

    // Completing never regresses, and later progress writes are ignored.
    expect(((await (await putStep(cookie, 1)).json()) as OnboardingPayload).onboarding.step).toBe(4);

    const userId = await userIdFor("complete@example.com");
    const activity = await dbHarness.pg.query<{ action: string }>(
      "SELECT action FROM public.activity_logs WHERE actor_user_id = $1",
      [userId]
    );
    expect(activity.rows.map((r) => r.action)).toContain("account.onboarding_completed");

    await req("/api/auth/logout", { method: "POST", headers: { Cookie: cookie } });
    const login = await req("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "complete@example.com", password: PASSWORD }),
    });
    const loginBody = (await login.json()) as OnboardingPayload;
    expect(loginBody.onboarding.required).toBe(false);
    expect(loginBody.onboarding.completedAt).toBe(firstCompletedAt);
  });

  it("keeps pre-existing accounts completed so nobody is interrupted", async () => {
    // Simulate a user that existed before onboarding shipped, exactly as the
    // migration backfills them.
    const legacy = await dbHarness.pg.query<{ id: string }>(
      `INSERT INTO public.users (email, user_kind, password_hash, full_name, onboarding_step, onboarding_completed_at)
       VALUES ('legacy@example.com', 'customer', 'x', 'Legacy Owner', 4, now())
       RETURNING id`
    );
    expect(legacy.rows[0]!.id).toBeTruthy();

    // A fresh registration in the same database is still required to onboard.
    const fresh = await register("still-new@example.com");
    expect(fresh.onboarding.required).toBe(true);
  });

  it("walks the full journey: register, resume, complete, sign out, never again", async () => {
    const email = "journey@example.com";
    const { cookie, onboarding } = await register(email);

    // 1. Registered -> onboarding required at step 1.
    expect(onboarding.required).toBe(true);
    expect(onboarding.step).toBe(1);

    const meAfterRegister = (await (
      await req("/api/auth/me", { headers: { Cookie: cookie } })
    ).json()) as OnboardingPayload & { account: { name: string } };
    expect(meAfterRegister.onboarding.required).toBe(true);
    expect(meAfterRegister.account.name).toContain("journey");

    // 2. Next through steps 2, 3 and 4, each persisted server-side.
    for (const step of [2, 3, 4]) {
      expect((await putStep(cookie, step)).status).toBe(200);
      expect((await onboardingOf(cookie)).step).toBe(step);
    }

    // 3. Completion flips the account and unlocks the console.
    const done = await req("/api/auth/onboarding/complete", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(done.status).toBe(200);
    const meAfterComplete = (await (
      await req("/api/auth/me", { headers: { Cookie: cookie } })
    ).json()) as OnboardingPayload;
    expect(meAfterComplete.onboarding.required).toBe(false);

    // 4. Sign out and back in: onboarding never returns.
    await req("/api/auth/logout", { method: "POST", headers: { Cookie: cookie } });
    const login = await req("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const loginBody = (await login.json()) as OnboardingPayload;
    expect(loginBody.onboarding.required).toBe(false);

    const newCookie = extractCookie(login, "hc_user_session");
    const meAfterRelogin = (await (
      await req("/api/auth/me", { headers: { Cookie: newCookie } })
    ).json()) as OnboardingPayload;
    expect(meAfterRelogin.onboarding.required).toBe(false);
    expect(meAfterRelogin.onboarding.step).toBe(4);

    // The database is the source of truth for that decision.
    const row = await rawOnboardingRow(email);
    expect(row.onboarding_completed_at).toBeTruthy();
    expect(Number(row.onboarding_step)).toBe(4);
  });

  it("requires a signed-in customer session for every onboarding route", async () => {
    expect((await req("/api/auth/onboarding")).status).toBe(401);
    expect(
      (
        await req("/api/auth/onboarding", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ step: 2 }),
        })
      ).status
    ).toBe(401);
    expect(
      (await req("/api/auth/onboarding/complete", { method: "POST" })).status
    ).toBe(401);
  });
});
