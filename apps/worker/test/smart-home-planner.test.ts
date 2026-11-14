import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PLANNER_ENGINE_VERSION,
  PLANNER_STAGE_ORDER,
  VERIFIED_BOARD_CATALOG,
  type PlannerRequirementsInput,
  type PlannerResult,
  type PlannerStageEvent,
} from "@homecoreos/shared";
import type { WorkerBindings } from "../src/config/env";
import { createWorkerApp } from "../src/index";
import { MAX_SAVED_PLANS_PER_ACCOUNT } from "../src/routes/planner";
import { createMockEmqxFetch, createMockR2Bucket } from "./helpers/mock-emqx-r2";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";

const S3_N16R8 = "esp32-s3-devkitc-1-n16r8";

function extractCookie(res: Response, cookieName: string): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${cookieName} in ${header}`);
  return `${cookieName}=${match[1]}`;
}

function makeFakeEspIdfImage(byteLength = 512): Uint8Array {
  const buf = new Uint8Array(byteLength);
  buf[0] = 0xe9; // ESP-IDF image magic
  buf[1] = 0x04;
  return buf;
}

/** 28 controller connections: needs two ESP32-S3-DevKitC-1 N16R8 controllers. */
const FAMILY_HOME: PlannerRequirementsInput = {
  home: {
    floors: 2,
    rooms: [
      {
        id: "living",
        name: "Living Room",
        devices: {
          lights: { quantity: 6, independent: 3 },
          fans: { quantity: 2 },
          switches: { quantity: 4 },
          curtains: { quantity: 2 },
          motion_sensors: { quantity: 1 },
          climate_sensors: { quantity: 1 },
        },
        fanSpeedControl: 1,
      },
      {
        id: "kitchen",
        name: "Kitchen",
        devices: {
          lights: { quantity: 2 },
          appliances: { quantity: 2 },
          gas_smoke_sensors: { quantity: 1 },
          leak_sensors: { quantity: 1 },
        },
      },
      {
        id: "bedroom",
        name: "Master Bedroom",
        floor: 2,
        devices: {
          lights: { quantity: 3, independent: 2 },
          fans: { quantity: 1 },
          climate_sensors: { quantity: 1 },
          contact_sensors: { quantity: 2 },
        },
      },
      { id: "utility", name: "Utility", devices: { pumps: { quantity: 1 } } },
    ],
  },
  installation: { wifi: "strong", environment: "indoor_dry", sensorWiring: "direct", maxCableRunMeters: 5 },
};

const SMALL_HOME: PlannerRequirementsInput = {
  home: { rooms: [{ id: "hall", name: "Hall", devices: { switches: { quantity: 3 } } }] },
  installation: { wifi: "strong", environment: "indoor_dry" },
};

interface PlanDetail {
  id: string;
  name: string;
  status: "current" | "outdated";
  resultState: string | null;
  headline: string | null;
  recommendation: string | null;
  rooms: number;
  devices: number;
  connections: number;
  requirements: PlannerRequirementsInput;
  result: PlannerResult;
  cache: { status: "reused" | "recomputed"; reason: string | null };
}

type PlanSummary = Omit<PlanDetail, "requirements" | "result" | "cache">;

describe("Smart Home Planner API", () => {
  let dbHarness: PgliteHarness;
  let env: WorkerBindings;
  let app: ReturnType<typeof createWorkerApp>;
  let adminCookie = "";
  let ownerCookie = "";
  let otherCookie = "";
  let s3BoardId = "";
  let releaseCounter = 0;

  function req(path: string, init?: RequestInit) {
    return app.fetch(new Request(`https://homecore.local${path}`, init), env);
  }

  function post(path: string, cookie: string, body: unknown, method = "POST") {
    return req(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });
  }

  async function analyze(cookie: string, requirements: unknown): Promise<PlannerResult> {
    const res = await post("/api/planner/analyze", cookie, { requirements });
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: PlannerResult }).result;
  }

  async function savePlan(cookie: string, name: string, requirements: unknown): Promise<PlanDetail> {
    const res = await post("/api/planner/plans", cookie, { name, requirements });
    expect(res.status).toBe(201);
    return ((await res.json()) as { plan: PlanDetail }).plan;
  }

  async function openPlan(cookie: string, id: string): Promise<PlanDetail> {
    const res = await req(`/api/planner/plans/${id}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { plan: PlanDetail }).plan;
  }

  async function listPlans(cookie: string): Promise<PlanSummary[]> {
    const res = await req("/api/planner/plans", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { plans: PlanSummary[] }).plans;
  }

  async function adminPost(path: string, body?: unknown, method = "POST") {
    const res = await req(path, {
      method,
      headers: body === undefined
        ? { Cookie: adminCookie }
        : { "Content-Type": "application/json", Cookie: adminCookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(res.status, `${method} ${path}`).toBe(200);
    return res;
  }

  /** Uploads a firmware release for the S3 N16R8 through the real admin route. */
  async function uploadRelease(options?: {
    name?: string;
    publish?: boolean;
    hardwareVerified?: boolean;
    usb?: boolean;
    ota?: boolean;
  }): Promise<string> {
    releaseCounter += 1;
    const form = new FormData();
    form.append("name", options?.name ?? "HomecoreOS S3 N16R8");
    form.append("version", `4.${releaseCounter}.0`);
    form.append("channel", "stable");
    form.append("chipFamily", "esp32s3");
    form.append("targetBoardSlug", S3_N16R8);
    form.append("partitionScheme", "dual_ota_16mb");
    form.append("psramMode", "octal");
    form.append("flashMode", "qio");
    form.append("flashFreq", "80m");
    form.append("flashSize", "16MB");
    form.append("compatibleBoardIds", JSON.stringify([s3BoardId]));
    form.append("publish", String(options?.publish ?? true));
    form.append("hardwareVerified", String(options?.hardwareVerified ?? true));
    form.append("releaseNotes", "INTERNAL-RELEASE-NOTES-DO-NOT-LEAK");
    form.append("verificationNotes", "INTERNAL-VERIFICATION-NOTES-DO-NOT-LEAK");
    if (options?.usb ?? true) {
      form.append(
        "usbFile",
        new File([makeFakeEspIdfImage(640)], `private-usb-${releaseCounter}.bin`, {
          type: "application/octet-stream",
        })
      );
    }
    if (options?.ota ?? true) {
      form.append(
        "otaFile",
        new File([makeFakeEspIdfImage(512)], `private-ota-${releaseCounter}.bin`, {
          type: "application/octet-stream",
        })
      );
    }
    const res = await req("/api/admin/firmware/release", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: form,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { release: { id: string } }).release.id;
  }

  /** Archives every release so a test starts from "no firmware". */
  async function clearFirmware() {
    await dbHarness.pg.query(
      `UPDATE public.firmware_releases SET status = 'archived' WHERE status <> 'archived'`
    );
  }

  async function accountIdOf(email: string): Promise<string> {
    const res = await dbHarness.pg.query<{ account_id: string }>(
      `SELECT s.account_id FROM public.staff s JOIN public.users u ON u.id = s.user_id WHERE u.email = $1`,
      [email]
    );
    return res.rows[0]!.account_id;
  }

  beforeAll(async () => {
    dbHarness = await createPglitePostgrest();
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
    app = createWorkerApp({ dbFetch: dbHarness.fetch, emqxFetch: createMockEmqxFetch().fetch });

    const bootRes = await req("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin-planner@homecoreos.local",
        fullName: "Platform Admin",
        password: "AdminPassword123!",
      }),
    });
    expect(bootRes.status).toBe(201);
    adminCookie = extractCookie(bootRes, "hc_admin_session");

    const register = async (email: string, accountName: string) => {
      const res = await req("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "UserPassword123!", fullName: "Planner User", accountName }),
      });
      expect(res.status).toBe(201);
      return extractCookie(res, "hc_user_session");
    };
    ownerCookie = await register("owner-planner@homecoreos.local", "Planner Home");
    otherCookie = await register("other-planner@homecoreos.local", "Other Home");

    const boardsRes = await req("/api/admin/boards", { headers: { Cookie: adminCookie } });
    const boards = ((await boardsRes.json()) as { boards: Array<{ id: string; slug: string }> }).boards;
    s3BoardId = boards.find((b) => b.slug === S3_N16R8)!.id;
  }, 120_000);

  afterAll(async () => {
    await dbHarness.close();
  });

  it("requires a signed-in customer session on every route", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const attempts: Array<[string, string]> = [
      ["POST", "/api/planner/analyze"],
      ["GET", "/api/planner/plans"],
      ["POST", "/api/planner/plans"],
      ["GET", `/api/planner/plans/${id}`],
      ["PATCH", `/api/planner/plans/${id}`],
      ["DELETE", `/api/planner/plans/${id}`],
    ];
    for (const cookie of [undefined, adminCookie, "hc_user_session=forged-token"]) {
      for (const [method, path] of attempts) {
        const res = await req(path, {
          method,
          headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
          body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify({ requirements: SMALL_HOME }),
        });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(await res.text()).not.toContain("plans\":");
      }
    }
  });

  it("analyzes against the live catalog and is only partially ready without firmware", async () => {
    const res = await post("/api/planner/analyze", ownerCookie, { requirements: FAMILY_HOME });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { result, requirements } = (await res.json()) as {
      result: PlannerResult;
      requirements: PlannerRequirementsInput;
    };

    expect(result.engineVersion).toBe(PLANNER_ENGINE_VERSION);
    expect(result.state).toBe("partially_ready");
    expect(result.stats).toMatchObject({
      boardsEvaluated: 11,
      firmwareReleasesEvaluated: 0,
      publishedFirmwareReleases: 0,
    });
    expect(result.catalogRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(result.plans.every((plan) => plan.readiness !== "ready")).toBe(true);
    expect(result.plans[0]!.firmware.state).toBe("no_compatible_release");
    expect(result.plans[0]!.availability.stock.status).toBe("unknown");
    expect(result.plans[0]!.availability.cost.available).toBe(false);

    // Every stage really ran, against the rows that are in the database.
    expect(result.stages.map((s) => s.id)).toEqual([...PLANNER_STAGE_ORDER]);
    expect(result.stages.every((s) => s.status === "completed")).toBe(true);
    expect(result.stages.find((s) => s.id === "load_boards")!.detail).toBe("11 boards in the Board Library");
    expect(result.stages.find((s) => s.id === "load_firmware")!.detail).toBe(
      "0 firmware releases on record, 0 published"
    );

    // The canonical requirements come back so the wizard can store exactly what was analyzed.
    expect(requirements.home?.rooms).toHaveLength(4);
    expect(requirements.installation?.wifi).toBe("strong");
  });

  it("streams each stage as it really starts and finishes", async () => {
    const res = await req("/api/planner/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson", Cookie: ownerCookie },
      body: JSON.stringify({ requirements: FAMILY_HOME }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const events = (await res.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; stage?: PlannerStageEvent; result?: PlannerResult });

    const last = events[events.length - 1]!;
    expect(last.type).toBe("result");
    expect(events.slice(0, -1).every((e) => e.type === "stage")).toBe(true);

    const sequence = events.slice(0, -1).map((e) => `${e.stage!.id}:${e.stage!.status}`);
    expect(sequence.slice(0, 4)).toEqual([
      "requirements:running",
      "requirements:completed",
      "load_boards:running",
      "load_firmware:running",
    ]);
    for (const id of PLANNER_STAGE_ORDER) {
      const started = sequence.indexOf(`${id}:running`);
      const finished = sequence.indexOf(`${id}:completed`);
      expect(started, id).toBeGreaterThanOrEqual(0);
      expect(finished, id).toBeGreaterThan(started);
    }
    // Rule stages run strictly one after another, after both reads have finished.
    const ruleStages = PLANNER_STAGE_ORDER.slice(3);
    expect(sequence.slice(-ruleStages.length * 2)).toEqual(
      ruleStages.flatMap((id) => [`${id}:running`, `${id}:completed`])
    );
    // The final result carries the same stage outcomes that were streamed.
    for (const stage of last.result!.stages) {
      const streamed = [...events].reverse().find((e) => e.stage?.id === stage.id)!.stage!;
      expect(streamed.status).toBe(stage.status);
      expect(streamed.detail).toBe(stage.detail);
    }
  });

  it("reports incomplete requirements without reading the catalog", async () => {
    const result = await analyze(ownerCookie, { home: { rooms: [{ name: "Hall", devices: {} }] } });
    expect(result.state).toBe("incomplete");
    expect(result.plans).toEqual([]);
    expect(result.catalogRevision).toBeNull();
    expect(result.missingInformation.filter((m) => m.blocking).map((m) => m.code)).toEqual([
      "no_devices",
      "wifi_unanswered",
    ]);
    expect(result.stages.find((s) => s.id === "load_boards")!.status).toBe("skipped");
    expect(result.stages.find((s) => s.id === "load_firmware")!.status).toBe("skipped");
  });

  it("rejects malformed and oversized requests", async () => {
    const send = (body: string) =>
      req("/api/planner/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: ownerCookie },
        body,
      });
    expect((await send("{not json")).status).toBe(400);
    expect((await send(JSON.stringify({}))).status).toBe(400);
    expect((await send(JSON.stringify({ requirements: [1, 2, 3] }))).status).toBe(400);
    expect((await send(JSON.stringify({ requirements: "everything" }))).status).toBe(400);
    expect((await send(JSON.stringify({ requirements: { padding: "x".repeat(250_000) } }))).status).toBe(413);

    // Hostile values inside a well-formed body are clamped, never executed or stored raw.
    const result = await analyze(ownerCookie, {
      home: { rooms: [{ id: "'; DROP TABLE planner_plans;--", name: "<script>alert(1)</script>", devices: { lights: { quantity: 1e12 } } }] },
      installation: { wifi: "strong" },
    });
    expect(result.requirements.totals.byCategory.lights.quantity).toBe(64);
    expect(result.requirements.rooms[0]!.id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("becomes ready only once a verified, published, USB-installable release exists", async () => {
    await clearFirmware();
    expect((await analyze(ownerCookie, FAMILY_HOME)).state).toBe("partially_ready");

    const releaseId = await uploadRelease({ name: "HomecoreOS S3 N16R8" });
    const res = await post("/api/planner/analyze", ownerCookie, { requirements: FAMILY_HOME });
    const body = await res.text();
    const { result } = JSON.parse(body) as { result: PlannerResult };

    expect(result.state).toBe("ready");
    expect(result.headline).toBe("Ready to install");
    const best = result.plans[0]!;
    expect(best.board.slug).toBe(S3_N16R8);
    expect(best.controllerCount).toBe(2);
    expect(best.firmware).toMatchObject({
      state: "published_available",
      installable: true,
      usbFactoryAvailable: true,
      otaAvailable: true,
      validatedForBoard: true,
    });
    expect(best.firmware.release).toMatchObject({ id: releaseId, name: "HomecoreOS S3 N16R8" });
    expect(best.installation.usbFactory.available).toBe(true);
    expect(best.detailLevel).toBe("full");
    expect(best.controllers.flatMap((c) => c.assignments)).toHaveLength(28);
    // No other board has firmware, so only one board may be ready.
    expect(result.evaluatedBoards.filter((b) => b.readiness === "ready")).toHaveLength(1);

    // Private storage details and admin notes never reach the customer.
    const files = await dbHarness.pg.query<{ r2_key: string; file_name: string; sha256: string }>(
      `SELECT r2_key, file_name, sha256 FROM public.firmware_files`
    );
    expect(files.rows.length).toBeGreaterThanOrEqual(2);
    for (const file of files.rows) {
      expect(body).not.toContain(file.r2_key);
      expect(body).not.toContain(file.file_name);
      expect(body).not.toContain(file.sha256);
    }
    expect(body).not.toMatch(/r2_key|file_name|sha256|size_bytes|release_notes|verification_notes|ci_run_url|ci_commit_sha/);
    expect(body).not.toContain("DO-NOT-LEAK");
    expect(body).not.toContain("admin-planner@homecoreos.local");
  });

  it("separates USB and OTA artifacts instead of assuming both exist", async () => {
    await clearFirmware();
    await uploadRelease({ usb: false, ota: true });
    const otaOnly = await analyze(ownerCookie, FAMILY_HOME);
    const otaPlan = otaOnly.plans.find((p) => p.board.slug === S3_N16R8)!;
    expect(otaOnly.state).toBe("partially_ready");
    expect(otaPlan.firmware).toMatchObject({
      state: "published_available",
      installable: false,
      usbFactoryAvailable: false,
      otaAvailable: true,
    });
    expect(otaPlan.installation.usbFactory.available).toBe(false);
    expect(otaPlan.warnings.map((w) => w.code)).toContain("missing_usb_artifact");

    await clearFirmware();
    await uploadRelease({ usb: true, ota: false });
    const usbOnly = await analyze(ownerCookie, FAMILY_HOME);
    expect(usbOnly.state).toBe("ready");
    expect(usbOnly.plans[0]!.installation.ota.available).toBe(false);
    expect(usbOnly.plans[0]!.warnings.map((w) => w.code)).toContain("missing_ota_artifact");

    // A file row that failed validation does not count as an artifact.
    await dbHarness.pg.query(`UPDATE public.firmware_files SET validated = false`);
    const unvalidated = await analyze(ownerCookie, FAMILY_HOME);
    expect(unvalidated.state).toBe("partially_ready");
    expect(unvalidated.plans.find((p) => p.board.slug === S3_N16R8)?.firmware.installable ?? false).toBe(false);
    await dbHarness.pg.query(`UPDATE public.firmware_files SET validated = true`);
  });

  it("reports draft, pending, failed and deprecated firmware honestly and anonymously", async () => {
    await clearFirmware();
    const secretName = "Confidential Unreleased Build";
    const releaseId = await uploadRelease({ name: secretName, publish: false });

    const firmwareFor = async () => {
      const res = await post("/api/planner/analyze", ownerCookie, { requirements: FAMILY_HOME });
      const body = await res.text();
      const result = (JSON.parse(body) as { result: PlannerResult }).result;
      const board = result.evaluatedBoards.find((b) => b.model.includes("N16R8"))!;
      const plan = result.plans.find((p) => p.board.slug === S3_N16R8);
      return { body, result, board, plan };
    };
    const setBuildStatus = (status: string) =>
      dbHarness.pg.query(`UPDATE public.firmware_releases SET build_status = $1 WHERE id = $2`, [
        status,
        releaseId,
      ]);

    const expectations: Array<[string, string]> = [
      ["manual", "compatible_release_found"],
      ["pending", "build_pending"],
      ["building", "build_pending"],
      ["failed", "build_failed"],
      ["succeeded", "compatible_release_found"],
    ];
    for (const [buildStatus, expected] of expectations) {
      await setBuildStatus(buildStatus);
      const { body, result, board, plan } = await firmwareFor();
      expect(result.state, buildStatus).toBe("partially_ready");
      expect(board.firmwareState, buildStatus).toBe(expected);
      expect(board.usbFactoryAvailable).toBe(false);
      expect(board.otaAvailable).toBe(false);
      expect(board.readiness).not.toBe("ready");
      if (plan) {
        expect(plan.firmware.release).toMatchObject({ id: null, name: null });
        expect(plan.firmware.installable).toBe(false);
      }
      // An unpublished release is never named or identified to a customer.
      expect(body).not.toContain(secretName);
      expect(body).not.toContain(releaseId);
    }

    await setBuildStatus("manual");
    await adminPost(`/api/admin/firmware/${releaseId}/publish`);
    expect((await firmwareFor()).result.state).toBe("ready");

    await adminPost(`/api/admin/firmware/${releaseId}/deprecate`);
    const deprecated = await firmwareFor();
    expect(deprecated.result.state).toBe("partially_ready");
    expect(deprecated.board.firmwareState).toBe("deprecated");
    expect(deprecated.board.readiness).toBe("partially_ready");
    expect(deprecated.body).not.toContain(releaseId);
  });

  it("never recommends an unpublished or unverified board as ready", async () => {
    await clearFirmware();
    await uploadRelease();
    expect((await analyze(ownerCookie, FAMILY_HOME)).state).toBe("ready");

    await adminPost(`/api/admin/boards/${s3BoardId}`, { is_available: false }, "PATCH");
    const unpublished = await analyze(ownerCookie, FAMILY_HOME);
    const hidden = unpublished.evaluatedBoards.find((b) => b.boardId === s3BoardId)!;
    expect(unpublished.state).toBe("partially_ready");
    expect(hidden.boardStatus.code).toBe("unpublished");
    expect(hidden.readiness).toBe("partially_ready");
    expect(unpublished.evaluatedBoards.some((b) => b.readiness === "ready")).toBe(false);
    for (const plan of unpublished.plans.filter((p) => p.board.id === s3BoardId)) {
      expect(plan.detailLevel).toBe("summary");
      expect(plan.board.slug).toBeNull();
      expect(plan.controllers.every((c) => c.assignments.length === 0)).toBe(true);
    }

    await dbHarness.pg.query(
      `UPDATE public.board_catalog SET verification_status = 'needs_verification', is_available = true WHERE id = $1`,
      [s3BoardId]
    );
    const unverified = await analyze(ownerCookie, FAMILY_HOME);
    const pending = unverified.evaluatedBoards.find((b) => b.boardId === s3BoardId)!;
    expect(pending.boardStatus.code).toBe("unverified");
    expect(pending.readiness).not.toBe("ready");
    expect(unverified.state).toBe("partially_ready");

    await dbHarness.pg.query(
      `UPDATE public.board_catalog SET firmware_status = 'unsupported', verification_status = 'verified' WHERE id = $1`,
      [s3BoardId]
    );
    const unsupported = await analyze(ownerCookie, FAMILY_HOME);
    const blocked = unsupported.evaluatedBoards.find((b) => b.boardId === s3BoardId)!;
    expect(blocked.boardStatus.code).toBe("unsupported");
    expect(blocked.readiness).toBe("not_supported");

    await dbHarness.pg.query(
      `UPDATE public.board_catalog SET firmware_status = 'firmware_supported', verification_status = 'verified', is_available = true WHERE id = $1`,
      [s3BoardId]
    );
    expect((await analyze(ownerCookie, FAMILY_HOME)).state).toBe("ready");
  });

  it("reuses a saved recommendation only while boards and firmware are unchanged", async () => {
    await clearFirmware();
    const firstRelease = await uploadRelease();

    const created = await savePlan(ownerCookie, "Family home", FAMILY_HOME);
    expect(created.cache).toEqual({ status: "recomputed", reason: "first_analysis" });
    expect(created.result.state).toBe("ready");
    expect(created.recommendation).toBe("2 × Espressif ESP32-S3-DevKitC-1 N16R8");
    expect(created).toMatchObject({ status: "current", rooms: 4, connections: 28 });

    // Nothing changed: the stored result is returned as it was, twice.
    for (let i = 0; i < 2; i++) {
      const reopened = await openPlan(ownerCookie, created.id);
      expect(reopened.cache).toEqual({ status: "reused", reason: null });
      expect(reopened.result).toEqual(created.result);
    }
    expect((await listPlans(ownerCookie)).find((p) => p.id === created.id)).toMatchObject({
      status: "current",
      resultState: "ready",
    });

    const expectRefresh = async (label: string, expectedState: string) => {
      // The listing stops repeating the old verdict before the plan is even opened.
      const listed = (await listPlans(ownerCookie)).find((p) => p.id === created.id)!;
      expect(listed.status, label).toBe("outdated");
      expect(listed.resultState, label).toBeNull();
      expect(listed.headline, label).toBeNull();
      expect(listed.recommendation, label).toBeNull();

      const refreshed = await openPlan(ownerCookie, created.id);
      expect(refreshed.cache, label).toEqual({ status: "recomputed", reason: "catalog_changed" });
      expect(refreshed.result.state, label).toBe(expectedState);
      expect(refreshed.resultState, label).toBe(expectedState);

      const again = await openPlan(ownerCookie, created.id);
      expect(again.cache, label).toEqual({ status: "reused", reason: null });
      expect(again.result, label).toEqual(refreshed.result);
      return refreshed;
    };

    // Firmware changes made through the real admin routes.
    await adminPost(`/api/admin/firmware/${firstRelease}/deprecate`);
    const deprecated = await expectRefresh("release deprecated", "partially_ready");
    expect(deprecated.result.evaluatedBoards.find((b) => b.boardId === s3BoardId)!.firmwareState).toBe("deprecated");

    const secondRelease = await uploadRelease({ publish: false });
    await expectRefresh("draft uploaded", "partially_ready");

    await adminPost(`/api/admin/firmware/${secondRelease}/publish`);
    const published = await expectRefresh("release published", "ready");
    expect(published.result.plans[0]!.firmware.release?.id).toBe(secondRelease);

    await adminPost(`/api/admin/firmware/${secondRelease}/unpublish`);
    await expectRefresh("release unpublished", "partially_ready");
    await adminPost(`/api/admin/firmware/${secondRelease}/publish`);
    await expectRefresh("release republished", "ready");

    // Board changes.
    await adminPost(`/api/admin/boards/${s3BoardId}`, { is_available: false }, "PATCH");
    await expectRefresh("board unpublished", "partially_ready");
    await adminPost(`/api/admin/boards/${s3BoardId}`, { is_available: true }, "PATCH");
    await expectRefresh("board republished", "ready");

    // Platform limits.
    await adminPost("/api/admin/settings", { max_controllers_per_account: 1 }, "PATCH");
    const limited = await expectRefresh("controller limit lowered", "partially_ready");
    expect(limited.result.plans[0]!.warnings.map((w) => w.code)).toContain("account_limit_exceeded");
    await adminPost("/api/admin/settings", { max_controllers_per_account: 25 }, "PATCH");
    await expectRefresh("controller limit restored", "ready");

    // An artifact disappearing is a catalog change too.
    await dbHarness.pg.query(
      `DELETE FROM public.firmware_files WHERE file_type = 'usb_factory' AND release_id = $1`,
      [secondRelease]
    );
    const noUsb = await expectRefresh("USB artifact removed", "partially_ready");
    expect(noUsb.result.plans.find((p) => p.board.slug === S3_N16R8)!.installation.usbFactory.available).toBe(false);

    // A rule-engine upgrade invalidates stored results as well.
    await dbHarness.pg.query(`UPDATE public.planner_plans SET engine_version = 0 WHERE id = $1`, [created.id]);
    expect((await listPlans(ownerCookie)).find((p) => p.id === created.id)!.status).toBe("outdated");
    const upgraded = await openPlan(ownerCookie, created.id);
    expect(upgraded.cache).toEqual({ status: "recomputed", reason: "engine_updated" });
    expect((await openPlan(ownerCookie, created.id)).cache.status).toBe("reused");

    // What is stored is exactly what was served.
    const stored = await dbHarness.pg.query<{
      result_state: string;
      catalog_revision: string;
      engine_version: number;
      result: PlannerResult;
    }>(`SELECT result_state, catalog_revision, engine_version, result FROM public.planner_plans WHERE id = $1`, [
      created.id,
    ]);
    expect(stored.rows[0]!.result_state).toBe("partially_ready");
    expect(stored.rows[0]!.engine_version).toBe(PLANNER_ENGINE_VERSION);
    expect(stored.rows[0]!.catalog_revision).toBe(upgraded.result.catalogRevision);
    expect(stored.rows[0]!.result.state).toBe("partially_ready");
  });

  it("does not recompute an incomplete plan when the catalog changes", async () => {
    const incomplete = await savePlan(ownerCookie, "Draft idea", { home: { rooms: [{ name: "Hall" }] } });
    expect(incomplete.result.state).toBe("incomplete");
    expect(incomplete.recommendation).toBeNull();

    await uploadRelease({ publish: false });
    const reopened = await openPlan(ownerCookie, incomplete.id);
    expect(reopened.cache).toEqual({ status: "reused", reason: null });
    expect((await listPlans(ownerCookie)).find((p) => p.id === incomplete.id)).toMatchObject({
      status: "current",
      resultState: "incomplete",
    });
  });

  it("stores only what the server computed from validated requirements", async () => {
    const res = await post("/api/planner/plans", ownerCookie, {
      name: "  Tampered  ",
      requirements: {
        ...SMALL_HOME,
        installation: {},
        injected: "<img src=x onerror=alert(1)>",
        home: { rooms: [{ id: "hall", name: "Hall", devices: { switches: { quantity: 3 } }, secret: "extra" }] },
      },
      // A client cannot supply its own verdict.
      result: { state: "ready", headline: "Ready to install" },
      resultState: "ready",
    });
    expect(res.status).toBe(201);
    const plan = ((await res.json()) as { plan: PlanDetail }).plan;
    expect(plan.name).toBe("Tampered");
    expect(plan.result.state).toBe("incomplete");
    expect(plan.resultState).toBe("incomplete");

    const stored = await dbHarness.pg.query<{ requirements: unknown; result_state: string }>(
      `SELECT requirements, result_state FROM public.planner_plans WHERE id = $1`,
      [plan.id]
    );
    expect(stored.rows[0]!.result_state).toBe("incomplete");
    const storedText = JSON.stringify(stored.rows[0]!.requirements);
    expect(storedText).not.toContain("injected");
    expect(storedText).not.toContain("secret");
    expect(storedText).not.toContain("onerror");

    for (const bad of [{ requirements: SMALL_HOME }, { name: "", requirements: SMALL_HOME }, { name: "x".repeat(81), requirements: SMALL_HOME }, { name: "No requirements" }]) {
      expect((await post("/api/planner/plans", ownerCookie, bad)).status).toBe(400);
    }
  });

  it("keeps saved plans private to the account that owns them", async () => {
    const mine = await savePlan(ownerCookie, "Private plan", SMALL_HOME);
    const beforeCount = (await listPlans(ownerCookie)).length;

    expect(await listPlans(otherCookie)).toEqual([]);
    expect((await req(`/api/planner/plans/${mine.id}`, { headers: { Cookie: otherCookie } })).status).toBe(404);
    expect((await post(`/api/planner/plans/${mine.id}`, otherCookie, { name: "Hijacked" }, "PATCH")).status).toBe(404);
    expect(
      (await post(`/api/planner/plans/${mine.id}`, otherCookie, { requirements: FAMILY_HOME }, "PATCH")).status
    ).toBe(404);
    expect(
      (await req(`/api/planner/plans/${mine.id}`, { method: "DELETE", headers: { Cookie: otherCookie } })).status
    ).toBe(404);

    // Malformed ids are a plain 404, never a database error.
    for (const id of ["not-a-uuid", "1%20OR%201=1", "00000000-0000-4000-8000-000000000000"]) {
      expect((await req(`/api/planner/plans/${id}`, { headers: { Cookie: ownerCookie } })).status).toBe(404);
    }

    // The owner's plan is untouched.
    const untouched = await openPlan(ownerCookie, mine.id);
    expect(untouched.name).toBe("Private plan");
    expect((await listPlans(ownerCookie)).length).toBe(beforeCount);
  });

  it("lets viewers analyze but not change saved plans", async () => {
    const plan = await savePlan(otherCookie, "Shared plan", SMALL_HOME);
    await dbHarness.pg.query(
      `UPDATE public.staff SET role = 'viewer' WHERE user_id = (SELECT id FROM public.users WHERE email = $1)`,
      ["other-planner@homecoreos.local"]
    );

    expect((await analyze(otherCookie, SMALL_HOME)).state).not.toBe("incomplete");
    expect((await listPlans(otherCookie)).map((p) => p.id)).toContain(plan.id);
    expect((await openPlan(otherCookie, plan.id)).name).toBe("Shared plan");

    for (const res of [
      await post("/api/planner/plans", otherCookie, { name: "Nope", requirements: SMALL_HOME }),
      await post(`/api/planner/plans/${plan.id}`, otherCookie, { name: "Nope" }, "PATCH"),
      await req(`/api/planner/plans/${plan.id}`, { method: "DELETE", headers: { Cookie: otherCookie } }),
    ]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("FORBIDDEN_STAFF_ROLE");
    }

    await dbHarness.pg.query(
      `UPDATE public.staff SET role = 'owner' WHERE user_id = (SELECT id FROM public.users WHERE email = $1)`,
      ["other-planner@homecoreos.local"]
    );
  });

  it("re-analyzes when requirements change, and supports rename and delete", async () => {
    await clearFirmware();
    await uploadRelease();
    const plan = await savePlan(ownerCookie, "Hall only", SMALL_HOME);
    expect(plan.connections).toBe(3);

    const renamedRes = await post(`/api/planner/plans/${plan.id}`, ownerCookie, { name: "Hall switches" }, "PATCH");
    expect(renamedRes.status).toBe(200);
    const renamed = ((await renamedRes.json()) as { plan: PlanDetail }).plan;
    expect(renamed.name).toBe("Hall switches");
    expect(renamed.cache).toEqual({ status: "reused", reason: null });
    expect(renamed.result).toEqual(plan.result);

    const changedRes = await post(
      `/api/planner/plans/${plan.id}`,
      ownerCookie,
      { requirements: FAMILY_HOME },
      "PATCH"
    );
    expect(changedRes.status).toBe(200);
    const changed = ((await changedRes.json()) as { plan: PlanDetail }).plan;
    expect(changed.cache).toEqual({ status: "recomputed", reason: "requirements_changed" });
    expect(changed.name).toBe("Hall switches");
    expect(changed.connections).toBe(28);
    expect(changed.result.requirements.totals.gpioChannels).toBe(28);
    expect((await openPlan(ownerCookie, plan.id)).cache.status).toBe("reused");

    expect((await post(`/api/planner/plans/${plan.id}`, ownerCookie, {}, "PATCH")).status).toBe(400);

    const deleted = await req(`/api/planner/plans/${plan.id}`, { method: "DELETE", headers: { Cookie: ownerCookie } });
    expect(deleted.status).toBe(200);
    expect((await req(`/api/planner/plans/${plan.id}`, { headers: { Cookie: ownerCookie } })).status).toBe(404);
    expect((await listPlans(ownerCookie)).map((p) => p.id)).not.toContain(plan.id);
  });

  it("follows the administrator's Board Library switch and includes only the account's custom boards", async () => {
    const s2 = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "esp32-s2-devkitc-1")!;
    const customRes = await post("/api/boards/custom", ownerCookie, {
      manufacturer: "Acme",
      model: "Planner Custom S2",
      revision: "v1.0",
      chipFamily: "esp32s2",
      chipVariant: s2.chip_variant,
      flashSizeMb: s2.flash_size_mb,
      psramSizeMb: s2.psram_size_mb,
      gpioDefinitions: s2.gpio_definitions.map((g) => ({
        pin: g.pin,
        label: g.label,
        capabilities: g.capabilities,
        restrictions: g.restrictions,
      })),
    });
    expect(customRes.status).toBe(201);
    const customId = ((await customRes.json()) as { board: { id: string } }).board.id;

    // The route stores the pin rows together with the board.
    const stored = await dbHarness.pg.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.board_gpio_definitions WHERE custom_board_id = $1",
      [customId]
    );
    expect(stored.rows[0]!.n).toBe(s2.gpio_definitions.length);

    // A board whose pin rows are missing is reported as unusable rather than guessed at.
    await dbHarness.pg.query(
      "DELETE FROM public.board_gpio_definitions WHERE custom_board_id = $1",
      [customId]
    );
    const withoutPins = await analyze(ownerCookie, SMALL_HOME);
    expect(withoutPins.evaluatedBoards.find((b) => b.boardId === customId)).toMatchObject({
      fits: false,
      readiness: "not_supported",
    });

    for (const g of s2.gpio_definitions) {
      await dbHarness.pg.query(
        `INSERT INTO public.board_gpio_definitions (custom_board_id, pin, label, capabilities, restrictions)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [customId, g.pin, g.label, JSON.stringify(g.capabilities), JSON.stringify(g.restrictions)]
      );
    }

    const mine = await analyze(ownerCookie, SMALL_HOME);
    const custom = mine.evaluatedBoards.filter((b) => b.source === "custom");
    expect(custom).toHaveLength(1);
    expect(custom[0]!.boardStatus).toMatchObject({ code: "unverified", isCustom: true });
    expect(custom[0]!.readiness).not.toBe("ready");
    expect(mine.stats.boardsEvaluated).toBe(12);

    // Another account never sees it.
    const theirs = await analyze(otherCookie, SMALL_HOME);
    expect(theirs.evaluatedBoards.some((b) => b.source === "custom")).toBe(false);
    expect(theirs.stats.boardsEvaluated).toBe(11);
    expect(JSON.stringify(theirs)).not.toContain("Planner Custom S2");

    await adminPost("/api/admin/settings", { board_catalog_enabled: false }, "PATCH");
    const disabledMine = await analyze(ownerCookie, SMALL_HOME);
    expect(disabledMine.evaluatedBoards.map((b) => b.source)).toEqual(["custom"]);
    expect(disabledMine.state).toBe("partially_ready");
    expect(disabledMine.stages.find((s) => s.id === "load_boards")!.detail).toBe(
      "The Board Library is switched off by the administrator, 1 custom board"
    );

    const disabledTheirs = await analyze(otherCookie, SMALL_HOME);
    expect(disabledTheirs.state).toBe("not_supported");
    expect(disabledTheirs.plans).toEqual([]);
    expect(disabledTheirs.warnings.map((w) => w.code)).toContain("no_boards_available");

    await adminPost("/api/admin/settings", { board_catalog_enabled: true }, "PATCH");
    expect((await analyze(otherCookie, SMALL_HOME)).stats.boardsEvaluated).toBe(11);
  });

  it("limits how many plans an account can keep", async () => {
    const accountId = await accountIdOf("other-planner@homecoreos.local");
    const existing = (await listPlans(otherCookie)).length;
    await dbHarness.pg.query(
      `INSERT INTO public.planner_plans (account_id, name)
       SELECT $1::uuid, 'Filler ' || g FROM generate_series(1, $2::int) g`,
      [accountId, MAX_SAVED_PLANS_PER_ACCOUNT - existing]
    );

    const res = await post("/api/planner/plans", otherCookie, { name: "One too many", requirements: SMALL_HOME });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PLAN_LIMIT_REACHED");

    // Rows that were never analyzed report no verdict until they are opened.
    const listed = await listPlans(otherCookie);
    expect(listed).toHaveLength(MAX_SAVED_PLANS_PER_ACCOUNT);
    const filler = listed.find((p) => p.name.startsWith("Filler"))!;
    expect(filler).toMatchObject({ status: "outdated", resultState: null });
    const opened = await openPlan(otherCookie, filler.id);
    expect(opened.cache).toEqual({ status: "recomputed", reason: "first_analysis" });
    expect(opened.result.state).toBe("incomplete");

    // Deleting one makes room again.
    const removed = await req(`/api/planner/plans/${filler.id}`, { method: "DELETE", headers: { Cookie: otherCookie } });
    expect(removed.status).toBe(200);
    expect((await post("/api/planner/plans", otherCookie, { name: "Fits now", requirements: SMALL_HOME })).status).toBe(201);
  });

  it("fails loudly instead of guessing when the catalog cannot be read", async () => {
    const failingApp = createWorkerApp({
      dbFetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/board_catalog")) {
          return new Response(JSON.stringify({ message: "connection reset" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        return dbHarness.fetch(input, init);
      },
      emqxFetch: createMockEmqxFetch().fetch,
    });
    const send = (accept: string) =>
      failingApp.fetch(
        new Request("https://homecore.local/api/planner/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: accept, Cookie: ownerCookie },
          body: JSON.stringify({ requirements: SMALL_HOME }),
        }),
        env
      );

    const plain = await send("application/json");
    expect(plain.status).toBe(503);
    const plainBody = (await plain.json()) as { error: string; result?: unknown };
    expect(plainBody.error).toMatch(/Board Library could not be read/);
    expect(plainBody.result).toBeUndefined();

    const streamed = await send("application/x-ndjson");
    const events = (await streamed.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; error?: string; stage?: PlannerStageEvent });
    expect(events[events.length - 1]).toMatchObject({ type: "error" });
    expect(events[events.length - 1]!.error).toMatch(/Board Library could not be read/);
    expect(events.some((e) => e.type === "result")).toBe(false);
    expect(events.some((e) => e.stage?.id === "load_boards" && e.stage.status === "failed")).toBe(true);
    // Internal error text never reaches the customer.
    expect(JSON.stringify(events)).not.toContain("connection reset");
  });
});
