import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerApp } from "../src/index";
import type { WorkerBindings } from "../src/config/env";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName} in ${header}`);
  return `${cookieName}=${match[1]}`;
}

describe("Authentication, RBAC, Paused Account, and Cross-Account Tenant Isolation", () => {
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
    app = createWorkerApp({
      dbFetch: dbHarness.fetch,
      emqxFetch: emqxMock.fetch,
    });
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  it("enforces initial platform admin bootstrap once and separates admin vs customer cookies", async () => {
    const status1 = await req("/api/admin/auth/bootstrap-status");
    expect(status1.status).toBe(200);
    expect(await status1.json()).toEqual({ needsBootstrap: true });

    const boot1 = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "super@homecoreos.local",
        fullName: "Platform Root",
        password: "SuperSecretPassword!99",
      }),
    });
    expect(boot1.status).toBe(201);
    const adminCookie = extractCookie(boot1, "hc_admin_session");

    // Second bootstrap MUST fail
    const boot2 = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "evil@homecoreos.local",
        fullName: "Attacker",
        password: "SuperSecretPassword!99",
      }),
    });
    expect(boot2.status).toBe(409);

    // Admin cookie MUST NOT grant access to customer User Console API
    const userMeWithAdminCookie = await req("/api/auth/me", {
      headers: { Cookie: adminCookie },
    });
    expect(userMeWithAdminCookie.status).toBe(401);

    // Admin cookie works on Admin Console setup status and never leaks secrets
    const setupRes = await req("/api/admin/setup-status", {
      headers: { Cookie: adminCookie },
    });
    expect(setupRes.status).toBe(200);
    const setupText = await setupRes.text();
    expect(setupText).not.toContain("service-role-key-secret");
    expect(setupText).not.toContain("app-secret");
  });

  it("isolates tenant accounts, enforces staff roles, blocks paused accounts, and protects login rate limits", async () => {
    // 1. Register Account A
    const regA = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        password: "AlicePassword123!",
        fullName: "Alice Owner",
        accountName: "Alice Villa",
        homeName: "Villa Alpha",
      }),
    });
    expect(regA.status).toBe(201);
    const cookieA = extractCookie(regA, "hc_user_session");
    const bodyA = (await regA.json()) as { account: { id: string } };

    // Customer cookie MUST NOT access Admin Console API
    const adminWithCustomerCookie = await req("/api/admin/accounts", {
      headers: { Cookie: cookieA },
    });
    expect(adminWithCustomerCookie.status).toBe(401);

    // Create a room in Account A
    const homesA = await req("/api/homes", { headers: { Cookie: cookieA } });
    const homeAId = ((await homesA.json()) as { homes: Array<{ id: string }> }).homes[0]!.id;

    const roomARes = await req("/api/homes/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ homeId: homeAId, name: "Living Room" }),
    });
    expect(roomARes.status).toBe(201);
    const roomAId = ((await roomARes.json()) as { room: { id: string } }).room.id;

    // 2. Register Account B
    const regB = await req("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "bob@example.com",
        password: "BobPassword123!",
        fullName: "Bob Owner",
        accountName: "Bob Loft",
      }),
    });
    expect(regB.status).toBe(201);
    const cookieB = extractCookie(regB, "hc_user_session");

    // Cross-account isolation checks: Bob MUST NOT see or mutate Alice's room/home/account
    const bobOverview = await req("/api/homes/overview", {
      headers: { Cookie: cookieB },
    });
    const bobOverviewJson = (await bobOverview.json()) as {
      rooms: Array<{ id: string }>;
    };
    expect(bobOverviewJson.rooms.find((r) => r.id === roomAId)).toBeUndefined();

    const bobRenameAliceRoom = await req(`/api/homes/rooms/${roomAId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieB },
      body: JSON.stringify({ name: "Hacked Room" }),
    });
    expect(bobRenameAliceRoom.status).toBe(404);

    const bobDeleteAliceRoom = await req(`/api/homes/rooms/${roomAId}`, {
      method: "DELETE",
      headers: { Cookie: cookieB },
    });
    expect(bobDeleteAliceRoom.status).toBe(404);

    // 3. Staff role RBAC: Alice adds a Viewer and an Operator
    const addViewer = await req("/api/account/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        email: "viewer@example.com",
        fullName: "Vera Viewer",
        password: "ViewerPassword123!",
        role: "viewer",
      }),
    });
    expect(addViewer.status).toBe(201);

    const viewerLogin = await req("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "viewer@example.com",
        password: "ViewerPassword123!",
      }),
    });
    expect(viewerLogin.status).toBe(200);
    const viewerCookie = extractCookie(viewerLogin, "hc_user_session");

    // Viewer can read overview, CANNOT create a room or pause account
    expect((await req("/api/homes/overview", { headers: { Cookie: viewerCookie } })).status).toBe(200);
    const viewerCreateRoom = await req("/api/homes/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: viewerCookie },
      body: JSON.stringify({ homeId: homeAId, name: "Unauthorized Room" }),
    });
    expect(viewerCreateRoom.status).toBe(403);

    // 4. Invitation flow: Alice creates an expiring invite link for an operator
    const inviteRes = await req("/api/account/staff/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ role: "operator", expiresInHours: 24 }),
    });
    expect(inviteRes.status).toBe(201);
    const { inviteCode } = (await inviteRes.json()) as { inviteCode: string };

    // Bob accepts invite to join Alice's account, then switches back
    const acceptRes = await req("/api/auth/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieB },
      body: JSON.stringify({ code: inviteCode }),
    });
    expect(acceptRes.status).toBe(200);

    // 5. Paused account disables protected operations without deleting data
    const pauseRes = await req("/api/account/pause", {
      method: "POST",
      headers: { Cookie: cookieA },
    });
    expect(pauseRes.status).toBe(200);

    const blockedOverview = await req("/api/homes/overview", {
      headers: { Cookie: cookieA },
    });
    expect(blockedOverview.status).toBe(403);
    expect(((await blockedOverview.json()) as { code: string }).code).toBe("ACCOUNT_PAUSED");

    // /api/auth/me still works so the user sees why the account is paused
    const mePaused = await req("/api/auth/me", {
      headers: { Cookie: cookieA },
    });
    expect(mePaused.status).toBe(200);
    expect(((await mePaused.json()) as { account: { status: string } }).account.status).toBe("paused");

    // 6. Login rate-limiting protects against brute force
    for (let i = 0; i < 5; i += 1) {
      await req("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "203.0.113.77",
        },
        body: JSON.stringify({ email: "alice@example.com", password: "wrong-password" }),
      });
    }
    const lockedRes = await req("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-connecting-ip": "203.0.113.77",
      },
      body: JSON.stringify({
        email: "alice@example.com",
        password: "AlicePassword123!",
      }),
    });
    expect(lockedRes.status).toBe(429);

    expect(bodyA.account.id).toBeTruthy();
  });

  it("revokes all other sessions on password change", async () => {
    const login1 = await req("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-connecting-ip": "198.51.100.10",
      },
      body: JSON.stringify({
        email: "bob@example.com",
        password: "BobPassword123!",
      }),
    });
    expect(login1.status).toBe(200);
    const cookie1 = extractCookie(login1, "hc_user_session");

    const login2 = await req("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-connecting-ip": "198.51.100.11",
      },
      body: JSON.stringify({
        email: "bob@example.com",
        password: "BobPassword123!",
      }),
    });
    expect(login2.status).toBe(200);
    const cookie2 = extractCookie(login2, "hc_user_session");

    const changeRes = await req("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie2 },
      body: JSON.stringify({
        currentPassword: "BobPassword123!",
        newPassword: "BobNewPassword456!",
      }),
    });
    expect(changeRes.status).toBe(200);

    // Session 1 MUST be revoked; Session 2 remains active
    expect((await req("/api/auth/me", { headers: { Cookie: cookie1 } })).status).toBe(401);
    expect((await req("/api/auth/me", { headers: { Cookie: cookie2 } })).status).toBe(200);
  });
});
