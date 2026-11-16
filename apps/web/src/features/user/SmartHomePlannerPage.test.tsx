import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PLANNER_STAGE_ORDER,
  PlannerStageTracker,
  VERIFIED_BOARD_CATALOG,
  buildIncompletePlannerResult,
  describePlannerRequirements,
  evaluatePlannerCatalog,
  normalizePlannerRequirements,
  toPlannerRequirementsInput,
  type PlannerBoardRecord,
  type PlannerCatalogSnapshot,
  type PlannerFirmwareReleaseRecord,
  type PlannerRequirementsInput,
  type PlannerResult,
  type PlannerStageEvent,
} from "@homecoreos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { Toaster } from "@/components/ui/sonner";
import type { BoardProfileItem } from "@/features/types";
import type { PlannerPlanSummary } from "@/lib/planner-api";
import { SmartHomePlannerPage } from "./SmartHomePlannerPage";

// ---------------------------------------------------------------------------
// A stand-in for the Worker. It runs the real shared rule engine over the real
// seed boards, so every result these tests render is one the product can produce.
// ---------------------------------------------------------------------------

const S3_N16R8 = "esp32-s3-devkitc-1-n16r8";
const ACCOUNT = "acct-1";
const originalFetch = globalThis.fetch;

function plannerBoard(slug: string, overrides: Partial<PlannerBoardRecord> = {}): PlannerBoardRecord {
  const seed = VERIFIED_BOARD_CATALOG.find((b) => b.slug === slug);
  if (!seed) throw new Error(`Unknown seed board ${slug}`);
  return {
    id: `id-${seed.slug}`,
    source: "catalog",
    slug: seed.slug,
    manufacturer: seed.manufacturer,
    model: seed.model,
    revision: seed.revision,
    chip_family: seed.chip_family,
    chip_variant: seed.chip_variant,
    flash_size_mb: seed.flash_size_mb,
    psram_size_mb: seed.psram_size_mb,
    is_available: seed.is_published,
    verification_status: seed.verification_status,
    firmware_status: seed.firmware_status,
    catalog_category: seed.catalog_category,
    partition_scheme: seed.partition_scheme,
    psram_mode: seed.psram_mode,
    flash_mode: seed.flash_mode,
    flash_freq: seed.flash_freq,
    boot_button_gpio: seed.boot_button_gpio,
    usb_interface: seed.usb_interface,
    supports_wifi: seed.supports_wifi,
    supports_ble: seed.supports_ble,
    firmware_compat_key: seed.firmware_compat_key,
    connectivity_note: seed.connectivity_note,
    board_layout: seed.board_layout,
    docs_url: seed.docs_url,
    gpio_definitions: seed.gpio_definitions,
    ...overrides,
  };
}

/** A published, hardware-verified release for the S3 N16R8 with USB and OTA images. */
function publishedRelease(
  overrides: Partial<PlannerFirmwareReleaseRecord> = {}
): PlannerFirmwareReleaseRecord {
  return {
    id: "rel-1",
    name: "HomecoreOS",
    version: "1.2.0",
    channel: "stable",
    chip_family: "esp32s3",
    status: "published",
    build_status: "manual",
    target_board_slug: S3_N16R8,
    compatible_board_ids: [`id-${S3_N16R8}`],
    compatible_board_slugs: [S3_N16R8],
    partition_scheme: "dual_ota_16mb",
    psram_mode: "octal",
    flash_size_mb: 16,
    hardware_verified: true,
    verified_board_ids: [],
    verified_board_slugs: [],
    ota_available: true,
    usb_available: true,
    published_at: "2026-05-01T00:00:00.000Z",
    files: [
      { file_type: "usb_factory", validated: true, flash_size: "16MB" },
      { file_type: "ota_app", validated: true, flash_size: "16MB" },
    ],
    ...overrides,
  };
}

interface StoredPlan {
  id: string;
  name: string;
  requirements: PlannerRequirementsInput;
  result: PlannerResult;
  revision: string;
  analyzedAt: string;
  createdAt: string;
  updatedAt: string;
}

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
  headers: Headers;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** An NDJSON response whose lines the test releases one at a time. */
function manualStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    }),
    send: async (event: unknown) => {
      await act(async () => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    close: async () => {
      await act(async () => {
        controller.close();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

class MockWorker {
  boards: PlannerBoardRecord[] = VERIFIED_BOARD_CATALOG.map((seed) => plannerBoard(seed.slug));
  releases: PlannerFirmwareReleaseRecord[] = [publishedRelease()];
  revision = "rev-1";
  plans: StoredPlan[] = [];
  calls: RecordedCall[] = [];
  /** Replaces the default analysis response for one test. */
  analyzeOverride: ((requirements: unknown) => Response | Promise<Response>) | null = null;
  private nextPlan = 1;
  private clock = Date.parse("2026-11-14T08:00:00.000Z");

  private now(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  private catalog(): PlannerCatalogSnapshot {
    return {
      boards: this.boards,
      releases: this.releases,
      boardCatalogEnabled: true,
      account: { existingControllers: 0, existingDevices: 0, maxControllers: 25, maxDevices: 100 },
      revision: this.revision,
    };
  }

  /** Same pipeline as the Worker's analyze route, stage events included. */
  analyze(raw: unknown): {
    events: PlannerStageEvent[];
    result: PlannerResult;
    requirements: PlannerRequirementsInput;
  } {
    const events: PlannerStageEvent[] = [];
    const tracker = new PlannerStageTracker((event) => events.push(event));
    const normalized = tracker.run(
      "requirements",
      () => normalizePlannerRequirements(raw),
      describePlannerRequirements
    );
    const requirements = toPlannerRequirementsInput(normalized, raw);
    if (!normalized.complete) {
      return { events, result: buildIncompletePlannerResult(normalized, { tracker }), requirements };
    }
    const catalog = this.catalog();
    tracker.start("load_boards");
    tracker.start("load_firmware");
    tracker.complete("load_boards", `${catalog.boards.length} boards in the Board Library`);
    tracker.complete("load_firmware", `${catalog.releases.length} firmware releases on record`);
    return { events, result: evaluatePlannerCatalog(normalized, catalog, { tracker }), requirements };
  }

  private ndjson(raw: unknown): Response {
    const { events, result, requirements } = this.analyze(raw);
    const lines = [
      ...events.map((stage) => ({ type: "stage", stage })),
      { type: "result", result, requirements },
    ];
    return new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    });
  }

  private isCurrent(plan: StoredPlan): boolean {
    return plan.result.state === "incomplete" || plan.revision === this.revision;
  }

  private summary(plan: StoredPlan, current = this.isCurrent(plan)): PlannerPlanSummary {
    const best = plan.result.plans[0];
    const recommended = plan.result.state === "ready" || plan.result.state === "partially_ready";
    return {
      id: plan.id,
      name: plan.name,
      status: current ? "current" : "outdated",
      resultState: current ? plan.result.state : null,
      headline: current ? plan.result.headline : null,
      summary: current ? plan.result.summary : null,
      recommendation:
        current && best && recommended
          ? `${best.controllerCount} × ${best.board.manufacturer} ${best.board.model}`
          : null,
      rooms: plan.result.requirements.totals.rooms,
      devices: plan.result.requirements.totals.physicalDevices,
      connections: plan.result.requirements.totals.gpioChannels,
      analyzedAt: plan.analyzedAt,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }

  private detail(plan: StoredPlan, cache: { status: string; reason: string | null }) {
    return {
      plan: { ...this.summary(plan, true), requirements: plan.requirements, result: plan.result, cache },
    };
  }

  private store(plan: StoredPlan, raw: unknown): void {
    const analysis = this.analyze(raw);
    plan.requirements = analysis.requirements;
    plan.result = analysis.result;
    plan.revision = this.revision;
    plan.analyzedAt = this.now();
    plan.updatedAt = plan.analyzedAt;
  }

  /** Saves a plan the way the Worker would, for tests that start with saved plans. */
  seedPlan(name: string, requirements: PlannerRequirementsInput): StoredPlan {
    const created = this.now();
    const plan = {
      id: `plan-${this.nextPlan++}`,
      name,
      createdAt: created,
      updatedAt: created,
    } as StoredPlan;
    this.store(plan, requirements);
    this.plans.unshift(plan);
    return plan;
  }

  handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, url, body, headers: new Headers(init?.headers) });
    const fields = (body ?? {}) as { name?: string; requirements?: PlannerRequirementsInput };

    if (url === "/api/boards/catalog") {
      const visible = this.boards.filter(
        (board) => board.is_available && board.verification_status === "verified"
      );
      const profiles: BoardProfileItem[] = VERIFIED_BOARD_CATALOG.filter((seed) =>
        visible.some((board) => board.slug === seed.slug)
      ).map((seed) => ({ ...seed, id: `id-${seed.slug}`, is_available: true }));
      return json({ boards: profiles });
    }
    if (url === "/api/boards/custom") return json({ boards: [] });

    if (url === "/api/planner/analyze" && method === "POST") {
      if (this.analyzeOverride) return this.analyzeOverride(fields.requirements);
      return this.ndjson(fields.requirements);
    }

    if (url === "/api/planner/plans" && method === "GET") {
      return json({ plans: this.plans.map((plan) => this.summary(plan)), limit: 30 });
    }
    if (url === "/api/planner/plans" && method === "POST") {
      const plan = this.seedPlan(String(fields.name), fields.requirements ?? {});
      return json(this.detail(plan, { status: "recomputed", reason: "first_analysis" }), 201);
    }

    const match = /^\/api\/planner\/plans\/([^/]+)$/.exec(url);
    const plan = match ? this.plans.find((p) => p.id === match[1]) : undefined;
    if (match && !plan) return json({ error: "Plan not found." }, 404);
    if (plan && method === "GET") {
      if (this.isCurrent(plan)) return json(this.detail(plan, { status: "reused", reason: null }));
      this.store(plan, plan.requirements);
      return json(this.detail(plan, { status: "recomputed", reason: "catalog_changed" }));
    }
    if (plan && method === "PATCH") {
      if (fields.name) plan.name = fields.name;
      if (fields.requirements) {
        this.store(plan, fields.requirements);
        return json(this.detail(plan, { status: "recomputed", reason: "requirements_changed" }));
      }
      return json(this.detail(plan, { status: "reused", reason: null }));
    }
    if (plan && method === "DELETE") {
      this.plans = this.plans.filter((p) => p !== plan);
      return json({ ok: true });
    }
    return json({ error: `Unhandled ${method} ${url}` }, 404);
  };

  requests(method: string, url: string | RegExp): RecordedCall[] {
    return this.calls.filter(
      (call) =>
        call.method === method && (typeof url === "string" ? call.url === url : url.test(call.url))
    );
  }
}

/** A typical family home: 4 rooms, 30 devices, 28 controller connections. */
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
  installation: {
    wifi: "strong",
    environment: "indoor_dry",
    sensorWiring: "direct",
    maxCableRunMeters: 5,
  },
};

const SMALL_HOME: PlannerRequirementsInput = {
  home: { rooms: [{ id: "hall", name: "Hall", devices: { lights: { quantity: 2 } } }] },
  installation: { wifi: "strong", environment: "indoor_dry" },
};

/** Puts answers into the wizard the way a returning customer would find them. */
function restoreAnswers(requirements: PlannerRequirementsInput, step = 4, account = ACCOUNT) {
  window.sessionStorage.setItem(
    `homecoreos:planner-draft:${account}`,
    JSON.stringify({ requirements, step })
  );
}

function stageItem(id: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-stage="${id}"]`);
  if (!node) throw new Error(`Stage ${id} is not rendered`);
  return node;
}

function stageStatuses(): string[] {
  return PLANNER_STAGE_ORDER.map((id) => stageItem(id).getAttribute("data-status") ?? "");
}

describe("Smart Home Planner page", () => {
  let worker: MockWorker;
  let navigate: ReturnType<typeof vi.fn<(path: string) => void>>;

  beforeEach(() => {
    window.sessionStorage.clear();
    worker = new MockWorker();
    navigate = vi.fn<(path: string) => void>();
    globalThis.fetch = vi.fn(worker.handle) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    window.sessionStorage.clear();
    window.history.pushState({}, "", "/");
  });

  function renderPlanner(options: { canManage?: boolean; account?: string } = {}) {
    return render(
      <>
        <SmartHomePlannerPage
          canManage={options.canManage ?? true}
          onNavigate={navigate}
          accountId={options.account ?? ACCOUNT}
        />
        <Toaster />
      </>
    );
  }

  /** Renders the planner on the Review step with answers in place and runs the analysis. */
  async function analyze(
    requirements: PlannerRequirementsInput,
    options: { canManage?: boolean } = {}
  ) {
    const user = userEvent.setup();
    restoreAnswers(requirements);
    const view = renderPlanner(options);
    await user.click(screen.getByRole("button", { name: "Analyze my home" }));
    await screen.findByTestId("planner-verdict");
    return { user, view };
  }

  // -------------------------------------------------------------------------
  // Wizard
  // -------------------------------------------------------------------------

  describe("wizard", () => {
    it("opens on an empty first step under its own hero", async () => {
      renderPlanner();

      const hero = screen.getByRole("region", { name: "Smart Home Planner Header" });
      expect(hero).toHaveAttribute("data-hero-tone", "indigo");
      expect(within(hero).getByRole("heading", { name: "Smart Home Planner" })).toBeInTheDocument();

      expect(
        screen.getAllByRole("tab", { name: /^Step \d: / }).map((tab) => tab.getAttribute("aria-label"))
      ).toEqual(["Step 1: Your home", "Step 2: Devices", "Step 3: Installation", "Step 4: Review"]);
      expect(screen.getByRole("tab", { name: "Step 1: Your home" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByText("No rooms yet. Add your first room below.")).toBeInTheDocument();
      expect(screen.getByTestId("planner-running-totals")).toHaveTextContent(
        "0 rooms · 0 devices · 0 controller connections"
      );
      // Nothing is analyzed until the customer asks for it.
      await waitFor(() => expect(worker.requests("GET", "/api/planner/plans")).toHaveLength(1));
      expect(worker.requests("POST", "/api/planner/analyze")).toHaveLength(0);
    });

    it("collects the customer's answers and sends exactly those for analysis", async () => {
      const user = userEvent.setup();
      renderPlanner();

      // Step 1: rooms
      await user.click(screen.getByRole("button", { name: "Add Living Room" }));
      await user.click(screen.getByRole("button", { name: "Add Kitchen" }));
      expect(screen.getByRole("textbox", { name: "Room 1 name" })).toHaveValue("Living Room");
      expect(screen.queryByRole("button", { name: "Add Kitchen" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Next" }));

      // Step 2: devices. The first room is open.
      fireEvent.change(screen.getByRole("spinbutton", { name: "Lights in Living Room" }), {
        target: { value: "6" },
      });
      fireEvent.change(
        screen.getByRole("spinbutton", { name: "Lights switched separately in Living Room" }),
        { target: { value: "3" } }
      );
      expect(screen.getByText("6 lights share 3 controls.")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Increase Fans in Living Room" }));
      await user.click(
        screen.getByRole("button", { name: "Increase Fans with speed control in Living Room" })
      );
      await user.click(screen.getByRole("button", { name: /^Kitchen/ }));
      await user.click(
        screen.getByRole("button", { name: "Increase Gas & smoke sensors in Kitchen" })
      );
      expect(screen.getByTestId("planner-running-totals")).toHaveTextContent(
        "2 rooms · 8 devices · 5 controller connections"
      );
      await user.click(screen.getByRole("button", { name: "Next" }));

      // Step 3: installation
      await user.click(screen.getByRole("radio", { name: /Strong signal/ }));
      await user.click(screen.getByRole("radio", { name: /Indoors, dry/ }));
      await user.click(screen.getByRole("button", { name: "Next" }));

      // Step 4: review, then analyze
      expect(screen.getByText("Everything needed for an analysis is here")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Analyze my home" }));
      await screen.findByTestId("planner-verdict");

      const [call] = worker.requests("POST", "/api/planner/analyze");
      expect(call!.headers.get("accept")).toContain("application/x-ndjson");
      expect(call!.body).toEqual({
        requirements: {
          home: {
            floors: 1,
            rooms: [
              {
                id: "room-1",
                name: "Living Room",
                floor: 1,
                locationId: null,
                devices: {
                  lights: { quantity: 6, independent: 3 },
                  fans: { quantity: 1, independent: 1 },
                },
                fanSpeedControl: 1,
              },
              {
                id: "room-2",
                name: "Kitchen",
                floor: 1,
                locationId: null,
                devices: { gas_smoke_sensors: { quantity: 1, independent: 1 } },
                fanSpeedControl: 0,
              },
            ],
            controllerLocations: [],
          },
          installation: {
            wifi: "strong",
            ethernet: "not_needed",
            environment: "indoor_dry",
            // Questions the customer skipped are sent as unanswered, not filled in.
            maxCableRunMeters: null,
            sensorWiring: null,
            allowAdditionalControllers: true,
            allowExternalRelayModules: true,
            futureOutputs: 0,
            futureInputs: 0,
          },
        },
      });
    });

    it("only offers shared switching and fan speed where they make sense", async () => {
      const user = userEvent.setup();
      restoreAnswers({ home: { rooms: [{ id: "den", name: "Den", devices: {} }] } }, 2);
      renderPlanner();

      const lights = screen.getByRole("spinbutton", { name: "Lights in Den" });
      const separate = () =>
        screen.queryByRole("spinbutton", { name: "Lights switched separately in Den" });
      expect(separate()).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Increase Lights in Den" }));
      expect(lights).toHaveValue(1);
      expect(separate()).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Increase Lights in Den" }));
      expect(separate()).toHaveValue(2);
      expect(screen.getByText("Each of the 2 has its own on/off control.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Decrease Lights switched separately in Den" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Increase Lights switched separately in Den" })).toBeDisabled();

      // Sensors are never grouped, and speed control needs a fan first.
      await user.click(screen.getByRole("button", { name: "Increase Motion sensors in Den" }));
      await user.click(screen.getByRole("button", { name: "Increase Motion sensors in Den" }));
      expect(
        screen.queryByRole("spinbutton", { name: /Motion sensors switched separately/ })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("spinbutton", { name: "Fans with speed control in Den" })
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Increase Fans in Den" }));
      expect(screen.getByRole("spinbutton", { name: "Fans with speed control in Den" })).toHaveValue(0);
      expect(screen.getByRole("button", { name: "Decrease Lights in Den" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Decrease Pumps in Den" })).toBeDisabled();
    });

    it("lists what is still missing on the Review step and jumps to the right step", async () => {
      const user = userEvent.setup();
      restoreAnswers(
        { home: { rooms: [{ id: "hall", name: "Hall", devices: { lights: { quantity: 1 } } }] } },
        4
      );
      renderPlanner();

      expect(screen.getByText("A few answers are still missing")).toBeInTheDocument();
      expect(screen.getByText(/Tell us whether Wi-Fi reaches the controller location/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Fix this" }));

      expect(screen.getByRole("tab", { name: "Step 3: Installation" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
      await user.click(screen.getByRole("radio", { name: /Weak or patchy/ }));
      await user.click(screen.getByRole("tab", { name: "Step 4: Review" }));
      expect(screen.getByText("Everything needed for an analysis is here")).toBeInTheDocument();
    });

    it("asks before clearing the answers", async () => {
      const user = userEvent.setup();
      restoreAnswers(SMALL_HOME, 1);
      renderPlanner();

      await user.click(screen.getByRole("button", { name: "Start over" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(within(dialog).getByText("Start a new plan?")).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.getByRole("textbox", { name: "Room 1 name" })).toHaveValue("Hall");

      await user.click(screen.getByRole("button", { name: "Start over" }));
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Start over" })
      );
      await waitFor(() =>
        expect(screen.getByText("No rooms yet. Add your first room below.")).toBeInTheDocument()
      );
      expect(window.sessionStorage.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Progress
  // -------------------------------------------------------------------------

  describe("analysis progress", () => {
    it("moves a stage only when the Worker reports it", async () => {
      const user = userEvent.setup();
      const stream = manualStream();
      const real = worker.analyze(FAMILY_HOME);
      worker.analyzeOverride = () => stream.response;
      restoreAnswers(FAMILY_HOME);
      renderPlanner();

      await user.click(screen.getByRole("button", { name: "Analyze my home" }));
      await screen.findByRole("heading", { name: "Analyzing your home" });

      // The request is in flight and nothing has been reported: nothing is shown as started.
      expect(stageStatuses()).toEqual(Array(9).fill("pending"));
      expect(screen.getByText("0 of 9 steps")).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Sending your requirements");
      const bar = screen.getByRole("progressbar", { name: "Analysis progress" });
      expect(bar).toHaveAttribute("aria-valuenow", "0");

      await stream.send({ type: "stage", stage: { id: "requirements", status: "running", durationMs: null, detail: null } });
      expect(stageStatuses()).toEqual(["running", ...Array(8).fill("pending")]);
      expect(screen.getByRole("status")).toHaveTextContent("Understanding your home");

      await stream.send({
        type: "stage",
        stage: { id: "requirements", status: "completed", durationMs: 3, detail: "4 rooms, 30 devices, 28 controller connections" },
      });
      expect(stageItem("requirements")).toHaveTextContent("4 rooms, 30 devices, 28 controller connections");
      expect(stageItem("requirements")).toHaveTextContent("3 ms");
      expect(screen.getByText("1 of 9 steps")).toBeInTheDocument();

      // Boards and firmware are read side by side, so two stages run at once.
      await stream.send({ type: "stage", stage: { id: "load_boards", status: "running" } });
      await stream.send({ type: "stage", stage: { id: "load_firmware", status: "running" } });
      expect(stageStatuses()).toEqual(["completed", "running", "running", ...Array(6).fill("pending")]);
      expect(screen.getByRole("status")).toHaveTextContent(
        "Reading the Board Library and reading firmware releases"
      );

      // Firmware finishes first; the board stage keeps running until its own event arrives.
      await stream.send({
        type: "stage",
        stage: { id: "load_firmware", status: "completed", durationMs: 18, detail: "1 firmware release on record" },
      });
      expect(stageStatuses().slice(0, 4)).toEqual(["completed", "running", "completed", "pending"]);
      expect(screen.getByText("2 of 9 steps")).toBeInTheDocument();
      // The bar counts finished stages and nothing else: 2 of 9.
      expect(bar).toHaveAttribute("aria-valuenow", "22");
      expect(bar).toHaveAttribute("aria-valuetext", "2 of 9 steps finished");
      expect(screen.queryByTestId("planner-verdict")).not.toBeInTheDocument();

      // The result line ends the analysis. The stages it carries are the Worker's own record.
      await stream.send({ type: "result", result: real.result, requirements: real.requirements });
      await stream.close();
      const verdict = await screen.findByTestId("planner-verdict");
      expect(verdict).toHaveAttribute("data-result-state", "ready");

      const log = screen.getByTestId("planner-analysis-log");
      expect(within(log).getByText("9 of 9 steps")).toBeInTheDocument();
      expect(log).toHaveTextContent("Analysis complete");
      for (const stage of real.result.stages) {
        const item = log.querySelector(`[data-stage="${stage.id}"]`)!;
        expect(item).toHaveAttribute("data-status", "completed");
        expect(item).toHaveTextContent(stage.detail!);
      }
    });

    it("shows a failed stage and the Worker's message, then recovers on retry", async () => {
      const user = userEvent.setup();
      let attempts = 0;
      worker.analyzeOverride = (requirements) => {
        attempts += 1;
        if (attempts > 1) {
          worker.analyzeOverride = null;
          return worker.handle("/api/planner/analyze", {
            method: "POST",
            body: JSON.stringify({ requirements }),
          });
        }
        const lines = [
          { type: "stage", stage: { id: "requirements", status: "running" } },
          { type: "stage", stage: { id: "requirements", status: "completed", durationMs: 1, detail: "1 room, 2 devices, 2 controller connections" } },
          { type: "stage", stage: { id: "load_boards", status: "running" } },
          { type: "stage", stage: { id: "load_firmware", status: "running" } },
          { type: "stage", stage: { id: "load_boards", status: "failed", durationMs: 40, detail: "The Board Library could not be read" } },
          { type: "error", error: "The Board Library could not be read. Please try again." },
        ];
        return new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      };
      restoreAnswers(SMALL_HOME);
      renderPlanner();

      await user.click(screen.getByRole("button", { name: "Analyze my home" }));
      await screen.findByRole("heading", { name: "The analysis did not finish" });
      expect(
        screen.getByText("The Board Library could not be read. Please try again.")
      ).toBeInTheDocument();
      // One stage completed, both in-flight stages stopped, nothing else is shown as done.
      expect(stageStatuses()).toEqual(["completed", "failed", "failed", ...Array(6).fill("pending")]);
      expect(stageItem("load_boards")).toHaveTextContent("The Board Library could not be read");
      expect(screen.getByRole("status")).toHaveTextContent("The analysis stopped");
      expect(screen.queryByTestId("planner-verdict")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByTestId("planner-verdict")).toHaveAttribute("data-result-state", "ready");
      expect(attempts).toBe(2);
    });

    it("reports a rejected request without showing any stage as done", async () => {
      const user = userEvent.setup();
      worker.analyzeOverride = () =>
        json({ error: "This plan is too large to analyze. Split it into smaller plans." }, 413);
      restoreAnswers(SMALL_HOME);
      renderPlanner();

      await user.click(screen.getByRole("button", { name: "Analyze my home" }));
      expect(
        await screen.findByText("This plan is too large to analyze. Split it into smaller plans.")
      ).toBeInTheDocument();
      expect(stageStatuses()).toEqual(Array(9).fill("pending"));

      await user.click(screen.getByRole("button", { name: "Back to my answers" }));
      expect(screen.getByRole("button", { name: "Analyze my home" })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  describe("results", () => {
    it("READY: shows the verdict, the recommended board and every part of the plan", async () => {
      await analyze(FAMILY_HOME);
      const expected = worker.analyze(FAMILY_HOME).result;
      const best = expected.plans[0]!;
      expect(expected.state).toBe("ready");

      // Verdict
      const verdict = screen.getByTestId("planner-verdict");
      expect(verdict).toHaveAttribute("data-result-state", "ready");
      expect(within(verdict).getByRole("heading", { name: "Ready to install" })).toBeInTheDocument();
      expect(within(verdict).getByText(expected.summary)).toBeInTheDocument();
      for (const [label, value] of [
        ["Rooms", "4"],
        ["Devices", "30"],
        ["Controller connections", "28"],
        ["Boards checked", "11"],
        ["Boards that fit", "10"],
        ["Published firmware", "1"],
      ]) {
        expect(within(verdict).getByText(label!).nextElementSibling).toHaveTextContent(value!);
      }

      // Recommended option
      const options = within(screen.getByRole("group", { name: "Hardware options" })).getAllByRole("button");
      expect(options).toHaveLength(expected.plans.length);
      expect(options[0]).toHaveAttribute("aria-pressed", "true");
      expect(options[0]).toHaveTextContent("Recommended");
      expect(options[0]).toHaveTextContent("2 × ESP32-S3-DevKitC-1 N16R8");

      const detail = within(screen.getByTestId("planner-plan-detail"));
      expect(
        detail.getByRole("heading", { name: "2 × Espressif ESP32-S3-DevKitC-1 N16R8" })
      ).toBeInTheDocument();
      const why = within(detail.getByRole("list", { name: "Why this option" }));
      expect(why.getAllByRole("listitem").map((item) => item.textContent)).toEqual(best.reasons);

      // Readiness: first whether the board carries the plan, then what the records say,
      // including what is not known.
      const checks = within(detail.getByRole("region", { name: "Is it ready to install?" }));
      const tiles = checks.getAllByRole("listitem");
      expect(tiles[0]).toHaveAttribute("data-check-tone", "ok");
      expect(tiles[0]).toHaveTextContent("Your requirements");
      expect(tiles[0]).toHaveTextContent("Fits on 2 controllers");
      expect(tiles[0]).toHaveTextContent("All 28 connections have a suitable pin on 2 controllers.");
      expect(checks.getByText("Published in catalog")).toBeInTheDocument();
      expect(checks.getByText("Published and available")).toBeInTheDocument();
      expect(checks.getByText("USB factory image available")).toBeInTheDocument();
      expect(checks.getByText("OTA image available")).toBeInTheDocument();
      expect(checks.getByText("Stock unknown")).toBeInTheDocument();
      expect(checks.getByText("No estimate")).toBeInTheDocument();
      expect(checks.getByText(best.availability.stock.detail)).toBeInTheDocument();
      expect(checks.getByText("0 in use + 2 in this plan, of 25 allowed.")).toBeInTheDocument();

      // Controllers and pins
      const controllers = detail.getAllByTestId("planner-controller");
      expect(controllers).toHaveLength(2);
      const first = best.controllers[0]!;
      const table = within(controllers[0]!).getByRole("table", {
        name: `Pin assignments for ${first.name}`,
      });
      const rows = within(table).getAllByRole("row").slice(1);
      expect(rows).toHaveLength(first.assignments.length);
      first.assignments.forEach((assignment, index) => {
        expect(within(rows[index]!).getAllByRole("cell")[0]).toHaveTextContent(
          new RegExp(`^GPIO${assignment.pin}( \\(.+\\))?$`)
        );
        expect(rows[index]).toHaveTextContent(assignment.label);
        expect(rows[index]).toHaveTextContent(assignment.roomName);
        expect(rows[index]).toHaveTextContent(assignment.homecore.label);
      });
      // A pin is named plainly; the longer Board Library label is kept as a tooltip.
      const described = first.assignments.find((a) => a.pinLabel !== `GPIO${a.pin}`)!;
      expect(described.pinLabel).toBe("GPIO48 (General GPIO)");
      const describedCell = within(rows[first.assignments.indexOf(described)]!).getAllByRole("cell")[0]!;
      expect(describedCell).toHaveTextContent(/^GPIO48$/);
      expect(describedCell).toHaveAttribute("title", "GPIO48 (General GPIO)");
      const plain = first.assignments.find((a) => a.pinLabel === `GPIO${a.pin}`)!;
      expect(
        within(rows[first.assignments.indexOf(plain)]!).getAllByRole("cell")[0]
      ).not.toHaveAttribute("title");
      // The second controller stays folded until it is opened.
      expect(within(controllers[1]!).queryByRole("table")).not.toBeInTheDocument();

      // Required hardware, with quantities
      const hardware = within(detail.getByRole("region", { name: "What else you need" }));
      for (const item of best.externalHardware) {
        expect(hardware.getByText(item.label)).toBeInTheDocument();
        expect(hardware.getByText(item.detail)).toBeInTheDocument();
      }
      expect(hardware.getByText("20 relay channels")).toBeInTheDocument();

      // Warnings: plan-specific and general ones, most serious first
      const warnings = [...best.warnings, ...expected.warnings];
      expect(
        detail.getByRole("region", { name: `Warnings and things to check (${warnings.length})` })
      ).toBeInTheDocument();
      const items = within(detail.getByTestId("planner-warnings")).getAllByRole("listitem");
      expect(items).toHaveLength(warnings.length);
      const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
      const shown = items.map(
        (item) => item.querySelector("details")!.getAttribute("data-severity") as keyof typeof rank
      );
      expect([...shown].sort((a, b) => rank[a] - rank[b])).toEqual(shown);
      const mains = warnings.find((warning) => warning.code === "mains_safety")!;
      const mainsItem = within(
        detail.getByTestId("planner-warnings").querySelector('[data-warning-code="mains_safety"]')!
      );
      expect(mainsItem.getByText(mains.title)).toBeInTheDocument();
      expect(mainsItem.getByText(mains.meaning)).toBeInTheDocument();
      expect(mainsItem.getByText(mains.cause)).toBeInTheDocument();
      expect(mainsItem.getByText(mains.impact)).toBeInTheDocument();
      expect(mainsItem.getByText(mains.resolution)).toBeInTheDocument();

      // Every evaluated board is listed, including the ones that were not chosen.
      const boardRows = within(
        screen.getByRole("table", { name: "Boards evaluated by the planner" })
      )
        .getAllByRole("row")
        .slice(1);
      expect(boardRows).toHaveLength(11);
      expect(boardRows[0]).toHaveTextContent("ESP32-S3-DevKitC-1 N16R8");
      expect(boardRows[0]).toHaveTextContent("Ready");
      expect(boardRows[0]).toHaveTextContent("Fits on 2 controllers");
      // A board with enough pins but no Wi-Fi is not presented as fitting.
      const h2 = boardRows.find((row) => row.textContent?.includes("ESP32-H2-DevKitM-1"))!;
      expect(h2).toHaveTextContent("Not supported");
      expect(h2).toHaveTextContent("No Wi-Fi, cannot connect to HomecoreOS");
      expect(h2).not.toHaveTextContent(/Fits on/);
      expected.evaluatedBoards.forEach((board, index) => {
        expect(boardRows[index]).toHaveTextContent(board.model);
        expect(boardRows[index]).toHaveTextContent(board.fit);
        expect(boardRows[index]).toHaveTextContent(board.firmwareLabel);
      });
    });

    it("draws the recommended board and highlights only the pins the plan uses", async () => {
      const { user } = await analyze(FAMILY_HOME);
      const best = worker.analyze(FAMILY_HOME).result.plans[0]!;
      const controller = best.controllers[0]!;
      const card = screen.getAllByTestId("planner-controller")[0]!;

      // One drawing in the summary, one beside the first controller's pin table.
      const drawings = await screen.findAllByRole("img", { name: /ESP32-S3-DevKitC-1 N16R8 .*PCB diagram/ });
      expect(drawings).toHaveLength(2);
      const drawing = within(card).getByRole("img", { name: /vertical PCB diagram/ });

      const used = new Set(controller.assignments.map((a) => a.pin).filter((pin) => pin !== null));
      const bright = Array.from(drawing.querySelectorAll("[data-svg-pin]")).filter(
        (pin) => pin.getAttribute("opacity") === "1"
      );
      expect(bright).toHaveLength(used.size);

      // Pointing at a table row names the pin under the drawing.
      const assignment = controller.assignments[0]!;
      const row = within(card).getByRole("row", { name: new RegExp(assignment.label.replace(/[()]/g, "\\$&")) });
      await user.hover(row);
      expect(within(card).getByTestId("planner-pin-readout")).toHaveTextContent(
        `GPIO${assignment.pin}: ${assignment.label} (${assignment.roomName})`
      );
      expect(row).toHaveAttribute("data-state", "selected");
      await user.unhover(row);
      expect(row).not.toHaveAttribute("data-state");
    });

    it("lets the customer compare the ranked alternatives", async () => {
      const { user } = await analyze(FAMILY_HOME);
      const plans = worker.analyze(FAMILY_HOME).result.plans;
      expect(plans.length).toBeGreaterThan(1);
      const second = plans[1]!;

      const options = within(screen.getByRole("group", { name: "Hardware options" })).getAllByRole("button");
      expect(options[1]).toHaveTextContent("Option 2");
      await user.click(options[1]!);

      expect(options[1]).toHaveAttribute("aria-pressed", "true");
      expect(options[0]).toHaveAttribute("aria-pressed", "false");
      const detail = within(screen.getByTestId("planner-plan-detail"));
      expect(
        detail.getByRole("heading", {
          name: `${second.controllerCount} × ${second.board.manufacturer} ${second.board.model}`,
        })
      ).toBeInTheDocument();
      // The alternative has no published firmware, and says so instead of looking ready.
      expect(second.readiness).toBe("partially_ready");
      expect(detail.getByText(second.firmware.label)).toBeInTheDocument();
      expect(detail.getAllByText("Partially ready").length).toBeGreaterThan(0);
      expect(detail.queryByRole("button", { name: /Open Firmware/ })).not.toBeInTheDocument();
    });

    it("links to the Board Library and Firmware pages for an installable option", async () => {
      const { user } = await analyze(FAMILY_HOME);
      const detail = within(screen.getByTestId("planner-plan-detail"));
      await user.click(detail.getByRole("button", { name: "Open Board Library" }));
      await user.click(detail.getByRole("button", { name: "Open Firmware & Updates" }));
      expect(navigate.mock.calls).toEqual([["/boards"], ["/firmware"]]);
      expect(detail.getByRole("link", { name: /Board documentation/ })).toHaveAttribute(
        "href",
        expect.stringContaining("docs.espressif.com")
      );
    });

    it("PARTIALLY READY: hardware fits but no firmware is published", async () => {
      worker.releases = [];
      await analyze(FAMILY_HOME);
      const expected = worker.analyze(FAMILY_HOME).result;
      expect(expected.state).toBe("partially_ready");

      const verdict = screen.getByTestId("planner-verdict");
      expect(verdict).toHaveAttribute("data-result-state", "partially_ready");
      expect(within(verdict).getByRole("heading", { name: "Partially ready" })).toBeInTheDocument();
      expect(within(verdict).getByText(expected.summary)).toBeInTheDocument();
      expect(within(verdict).getByText("Published firmware").nextElementSibling).toHaveTextContent("0");

      const detail = within(screen.getByTestId("planner-plan-detail"));
      const checks = within(detail.getByRole("region", { name: "Is it ready to install?" }));
      expect(checks.getByText("No compatible release")).toBeInTheDocument();
      expect(checks.getByText(expected.plans[0]!.installation.usbFactory.label)).toBeInTheDocument();
      const blocker = detail
        .getByTestId("planner-warnings")
        .querySelector('[data-warning-code="no_compatible_firmware"]');
      expect(blocker).not.toBeNull();
      // Warnings that block installation are open without a click.
      expect(blocker).toHaveAttribute("open");
    });

    it("NOT SUPPORTED: says so, explains why, and recommends nothing", async () => {
      const requirements: PlannerRequirementsInput = {
        ...FAMILY_HOME,
        installation: { ...FAMILY_HOME.installation, wifi: "none" },
      };
      await analyze(requirements);
      const expected = worker.analyze(requirements).result;
      expect(expected.state).toBe("not_supported");

      const verdict = screen.getByTestId("planner-verdict");
      expect(verdict).toHaveAttribute("data-result-state", "not_supported");
      expect(within(verdict).getByRole("heading", { name: "Not supported" })).toBeInTheDocument();
      expect(within(verdict).getByText(expected.summary)).toBeInTheDocument();

      // Nothing is presented as a recommendation.
      expect(screen.queryByText("Recommended")).not.toBeInTheDocument();
      expect(screen.queryByText("Recommended hardware")).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Hardware options" })).not.toBeInTheDocument();
      if (expected.plans.length > 0) {
        expect(screen.getByRole("region", { name: "Closest options" })).toHaveTextContent(
          "None of these can be used as specified"
        );
      }
      const blocker = [...expected.warnings, ...(expected.plans[0]?.warnings ?? [])].find(
        (warning) => warning.effect === "blocks_plan"
      )!;
      expect(screen.getAllByText(blocker.title).length).toBeGreaterThan(0);
      expect(screen.getAllByText(blocker.resolution).length).toBeGreaterThan(0);

      // The closest option never reads as installable: its reasons and its
      // readiness checks both lead with what rules it out.
      const closest = expected.plans[0]!;
      expect(closest.fits).toBe(false);
      const detail = within(screen.getByTestId("planner-plan-detail"));
      const reasons = within(detail.getByRole("list", { name: "Why this option" })).getAllByRole("listitem");
      expect(reasons[0]).toHaveTextContent(
        "Cannot be used as specified. You answered that there is no Wi-Fi where the controllers will be installed, and HomecoreOS controllers connect over Wi-Fi."
      );
      const tiles = within(detail.getByRole("region", { name: "Is it ready to install?" })).getAllByRole("listitem");
      expect(tiles[0]).toHaveAttribute("data-check-tone", "blocked");
      expect(tiles[0]).toHaveTextContent("Blocked: Enough pins, but no Wi-Fi where the controllers go");

      // And no board in the table is presented as fitting.
      expect(within(verdict).getByText("Boards that fit").nextElementSibling).toHaveTextContent("0");
      const table = screen.getByRole("table", { name: "Boards evaluated by the planner" });
      const rows = within(table).getAllByRole("row").slice(1);
      expect(rows).toHaveLength(expected.evaluatedBoards.length);
      for (const row of rows) expect(row).not.toHaveTextContent(/Fits on/);
    });

    it("INCOMPLETE: asks for the missing answer and takes the customer to it", async () => {
      const requirements: PlannerRequirementsInput = {
        home: { rooms: [{ id: "hall", name: "Hall", devices: { lights: { quantity: 2 } } }] },
      };
      const { user } = await analyze(requirements);

      const verdict = screen.getByTestId("planner-verdict");
      expect(verdict).toHaveAttribute("data-result-state", "incomplete");
      expect(within(verdict).getByRole("heading", { name: "More information needed" })).toBeInTheDocument();
      // The catalog was never read, so no board or firmware counts are claimed.
      expect(within(verdict).queryByText("Boards checked")).not.toBeInTheDocument();
      expect(screen.queryByTestId("planner-plan-detail")).not.toBeInTheDocument();
      expect(screen.queryByRole("table", { name: "Boards evaluated by the planner" })).not.toBeInTheDocument();

      const needs = within(screen.getByRole("region", { name: "What the planner still needs" }));
      expect(needs.getByText(/Tell us whether Wi-Fi reaches the controller location/)).toBeInTheDocument();
      // The later stages really were skipped, and the log says so.
      const log = screen.getByTestId("planner-analysis-log");
      expect(log.querySelector('[data-stage="requirements"]')).toHaveAttribute("data-status", "completed");
      expect(log.querySelector('[data-stage="allocation"]')).toHaveAttribute("data-status", "skipped");
      expect(log.querySelector('[data-stage="allocation"]')).toHaveTextContent(
        "Skipped: more information is needed first"
      );
      // One step ran. The log does not present the eight skipped ones as done.
      await user.click(within(log).getByText("How this result was worked out"));
      expect(within(log).getByRole("status")).toHaveTextContent("Analysis ended early");
      expect(within(log).getByText("1 of 9 steps, 8 skipped")).toBeInTheDocument();
      const bar = within(log).getByRole("progressbar", { name: "Analysis progress" });
      expect(bar).toHaveAttribute("aria-valuenow", "11");
      expect(bar).toHaveAttribute("aria-valuetext", "1 of 9 steps, 8 skipped finished");

      await user.click(needs.getByRole("button", { name: "Answer this" }));
      expect(screen.getByRole("tab", { name: "Step 3: Installation" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("radio", { name: /Strong signal/ })).not.toBeChecked();
    });

    it("withholds pin details for a board the customer cannot see in the Board Library", async () => {
      // An administrator has published a single board; the others exist but are hidden.
      const published = "esp32-c3-devkitm-1";
      worker.boards = worker.boards.map((board) =>
        board.slug === published ? board : { ...board, is_available: false }
      );
      const { user } = await analyze(SMALL_HOME);
      const expected = worker.analyze(SMALL_HOME).result;
      expect(expected.plans[0]!.detailLevel).toBe("full");
      const hidden = expected.plans.find((plan) => plan.detailLevel === "summary")!;
      expect(hidden.boardStatus.code).toBe("unpublished");

      // The published board is shown in full, drawing and pins included.
      let detail = within(screen.getByTestId("planner-plan-detail"));
      expect(detail.getByRole("table", { name: /Pin assignments/ })).toBeInTheDocument();
      expect((await detail.findAllByRole("img")).length).toBeGreaterThan(0);

      const options = within(screen.getByRole("group", { name: "Hardware options" })).getAllByRole("button");
      await user.click(options[expected.plans.indexOf(hidden)]!);

      detail = within(screen.getByTestId("planner-plan-detail"));
      expect(
        detail.getByRole("heading", { name: `${hidden.controllerCount} × ${hidden.board.manufacturer} ${hidden.board.model}` })
      ).toBeInTheDocument();
      expect(detail.getByText("Pin assignments are not shown for this board")).toBeInTheDocument();
      expect(detail.queryByRole("table")).not.toBeInTheDocument();
      expect(detail.queryByRole("img")).not.toBeInTheDocument();
      expect(detail.queryByRole("button", { name: "Open Board Library" })).not.toBeInTheDocument();
      expect(detail.queryByRole("link", { name: /Board documentation/ })).not.toBeInTheDocument();
      // Its status is stated plainly, with the reason it is not ready.
      const checks = within(detail.getByRole("region", { name: "Is it ready to install?" }));
      expect(checks.getByText(hidden.boardStatus.label)).toBeInTheDocument();
      expect(checks.getByText(hidden.boardStatus.detail)).toBeInTheDocument();
    });

    it("does not draw a board that was hidden after its drawing was loaded", async () => {
      const { user } = await analyze(SMALL_HOME);
      let detail = within(screen.getByTestId("planner-plan-detail"));
      expect(detail.getByRole("heading", { name: "1 × Espressif ESP32-S3-DevKitC-1 N16R8" })).toBeInTheDocument();
      expect((await detail.findAllByRole("img")).length).toBeGreaterThan(0);

      // An administrator now hides every board but one. The page still holds the old drawings.
      worker.boards = worker.boards.map((board) =>
        board.slug === "esp32-c3-devkitm-1" ? board : { ...board, is_available: false }
      );
      const expected = worker.analyze(SMALL_HOME).result;
      const hidden = expected.plans.find((plan) => plan.board.id === "id-esp32-s3-devkitc-1-n16r8")!;
      expect(hidden.detailLevel).toBe("summary");

      await user.click(screen.getByRole("button", { name: "Analyze again" }));
      await waitFor(() =>
        expect(screen.getByTestId("planner-verdict")).toHaveAttribute("data-result-state", expected.state)
      );
      const options = within(screen.getByRole("group", { name: "Hardware options" })).getAllByRole("button");
      await user.click(options[expected.plans.indexOf(hidden)]!);

      detail = within(screen.getByTestId("planner-plan-detail"));
      expect(detail.getByRole("heading", { name: "1 × Espressif ESP32-S3-DevKitC-1 N16R8" })).toBeInTheDocument();
      expect(detail.queryByRole("img")).not.toBeInTheDocument();
      expect(
        detail.getByText("This board is not shown in your Board Library, so no drawing is available.")
      ).toBeInTheDocument();
      expect(detail.queryByRole("table")).not.toBeInTheDocument();
    });

    it("keeps a result only while it matches the answers on screen", async () => {
      const { user } = await analyze(SMALL_HOME);

      await user.click(screen.getByRole("button", { name: "Change my answers" }));
      expect(screen.getByText("You already have a result for these answers")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "View result" }));
      expect(screen.getByTestId("planner-verdict")).toBeInTheDocument();

      // Changing an answer retires the result until the plan is analyzed again.
      await user.click(screen.getByRole("button", { name: "Change my answers" }));
      await user.click(screen.getByRole("tab", { name: "Step 3: Installation" }));
      await user.click(screen.getByRole("radio", { name: /Weak or patchy/ }));
      expect(screen.getByText("Your answers have changed")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "View result" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("planner-verdict")).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Saved plans
  // -------------------------------------------------------------------------

  describe("saved plans", () => {
    it("saves a plan by name and never sends a result of its own", async () => {
      const { user } = await analyze(FAMILY_HOME);

      await user.click(screen.getByRole("button", { name: "Save plan" }));
      const dialog = await screen.findByRole("dialog");
      const name = within(dialog).getByRole("textbox", { name: "Plan name" });
      await user.clear(name);
      expect(within(dialog).getByRole("button", { name: "Save plan" })).toBeDisabled();
      await user.type(name, "Family home");
      await user.click(within(dialog).getByRole("button", { name: "Save plan" }));

      expect(await screen.findByText('Saved "Family home".')).toBeInTheDocument();
      expect(screen.getByTestId("planner-save-status")).toHaveTextContent('Saved as "Family home"');

      const [call] = worker.requests("POST", "/api/planner/plans");
      expect(Object.keys(call!.body as object).sort()).toEqual(["name", "requirements"]);
      expect(call!.body).toMatchObject({ name: "Family home" });
      // What is saved is the validated form the Worker returned with the analysis.
      expect((call!.body as { requirements: unknown }).requirements).toEqual(
        worker.analyze(FAMILY_HOME).requirements
      );

      await user.click(screen.getByRole("tab", { name: "Saved plans (1)" }));
      const card = screen.getByTestId("planner-saved-plan");
      expect(card).toHaveAttribute("data-plan-status", "current");
      expect(within(card).getByRole("heading", { name: "Family home" })).toBeInTheDocument();
      expect(within(card).getByText("Ready")).toBeInTheDocument();
      expect(within(card).getByText("2 × Espressif ESP32-S3-DevKitC-1 N16R8")).toBeInTheDocument();
      expect(within(card).getByText(/4 rooms · 30 devices · 28 connections/)).toBeInTheDocument();
      expect(within(card).getByText("Currently open")).toBeInTheDocument();
    });

    it("shows no verdict for a plan whose boards or firmware changed, and re-checks it when opened", async () => {
      const plan = worker.seedPlan("Family home", FAMILY_HOME);
      expect(plan.result.state).toBe("ready");
      // An administrator withdraws the only release after the plan was saved.
      worker.releases = [];
      worker.revision = "rev-2";

      const user = userEvent.setup();
      renderPlanner();
      await user.click(await screen.findByRole("tab", { name: "Saved plans (1)" }));

      const card = screen.getByTestId("planner-saved-plan");
      expect(card).toHaveAttribute("data-plan-status", "outdated");
      expect(within(card).getByText("Needs re-check")).toBeInTheDocument();
      // The stale "ready" verdict and recommendation are not shown anywhere.
      expect(within(card).queryByText("Ready")).not.toBeInTheDocument();
      expect(within(card).queryByText(/Ready to install/)).not.toBeInTheDocument();
      expect(within(card).queryByText(/ESP32-S3-DevKitC-1/)).not.toBeInTheDocument();

      await user.click(within(card).getByRole("button", { name: "Open Family home" }));

      const verdict = await screen.findByTestId("planner-verdict");
      expect(verdict).toHaveAttribute("data-result-state", "partially_ready");
      expect(screen.getByText("Checked again just now")).toBeInTheDocument();
      expect(
        screen.getByText(/Boards or firmware have changed since this plan was last checked/)
      ).toBeInTheDocument();
      expect(screen.getByTestId("planner-save-status")).toHaveTextContent('Saved as "Family home"');

      // The list now reports the fresh verdict.
      await user.click(screen.getByRole("tab", { name: "Saved plans (1)" }));
      await waitFor(() =>
        expect(screen.getByTestId("planner-saved-plan")).toHaveAttribute("data-plan-status", "current")
      );
      expect(within(screen.getByTestId("planner-saved-plan")).getByText("Partially ready")).toBeInTheDocument();
    });

    it("reuses a stored result while nothing changed and restores the answers", async () => {
      const plan = worker.seedPlan("Hall only", SMALL_HOME);
      const user = userEvent.setup();
      renderPlanner();
      await user.click(await screen.findByRole("tab", { name: "Saved plans (1)" }));
      await user.click(screen.getByRole("button", { name: "Open Hall only" }));

      expect(await screen.findByText("This result is still up to date")).toBeInTheDocument();
      expect(screen.getByText(/It was checked on Nov 14, 2026/)).toBeInTheDocument();
      expect(screen.getByTestId("planner-verdict")).toHaveAttribute("data-result-state", plan.result.state);
      // Opening is one read. The stored result came back, so nothing was analyzed again.
      expect(worker.requests("GET", `/api/planner/plans/${plan.id}`)).toHaveLength(1);
      expect(worker.requests("POST", "/api/planner/analyze")).toHaveLength(0);

      await user.click(screen.getByRole("button", { name: "Change my answers" }));
      await user.click(screen.getByRole("tab", { name: "Step 1: Your home" }));
      expect(screen.getByRole("textbox", { name: "Room 1 name" })).toHaveValue("Hall");
      await user.click(screen.getByRole("tab", { name: "Step 3: Installation" }));
      expect(screen.getByRole("radio", { name: /Strong signal/ })).toBeChecked();
    });

    it("saves edited answers back to the open plan", async () => {
      const plan = worker.seedPlan("Hall only", SMALL_HOME);
      const user = userEvent.setup();
      renderPlanner();
      await user.click(await screen.findByRole("tab", { name: "Saved plans (1)" }));
      await user.click(screen.getByRole("button", { name: "Open Hall only" }));
      await screen.findByTestId("planner-verdict");
      expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Change my answers" }));
      await user.click(screen.getByRole("tab", { name: "Step 2: Devices" }));
      await user.click(screen.getByRole("button", { name: "Increase Fans in Hall" }));
      await user.click(screen.getByRole("tab", { name: "Step 4: Review" }));
      await user.click(screen.getByRole("button", { name: "Analyze my home" }));
      await screen.findByTestId("planner-verdict");

      expect(screen.getByTestId("planner-save-status")).toHaveTextContent(
        'Changes to "Hall only" are not saved'
      );
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      expect(await screen.findByText('Saved changes to "Hall only".')).toBeInTheDocument();
      expect(screen.getByTestId("planner-save-status")).toHaveTextContent('Saved as "Hall only"');

      const [patch] = worker.requests("PATCH", `/api/planner/plans/${plan.id}`);
      expect(Object.keys(patch!.body as object)).toEqual(["requirements"]);
      expect(worker.plans[0]!.result.requirements.totals.byCategory.fans.quantity).toBe(1);
      expect(worker.plans).toHaveLength(1);
    });

    it("still knows which saved plan the answers belong to after leaving the page", async () => {
      const plan = worker.seedPlan("Hall only", SMALL_HOME);
      const user = userEvent.setup();
      const first = renderPlanner();
      await user.click(await screen.findByRole("tab", { name: "Saved plans (1)" }));
      await user.click(screen.getByRole("button", { name: "Open Hall only" }));
      await screen.findByTestId("planner-verdict");
      first.unmount();

      renderPlanner();
      expect(screen.getByTestId("planner-editing-plan")).toHaveTextContent(
        'These are the answers of the saved plan "Hall only".'
      );
      // Answers that match a saved plan are not treated as unsaved.
      await user.click(screen.getByRole("button", { name: "Analyze my home" }));
      await screen.findByTestId("planner-verdict");
      expect(screen.getByTestId("planner-save-status")).toHaveTextContent('Saved as "Hall only"');
      expect(screen.queryByRole("button", { name: "Save plan" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();

      // A change goes back into the same plan instead of creating a second one.
      await user.click(screen.getByRole("button", { name: "Change my answers" }));
      await user.click(screen.getByRole("tab", { name: "Step 2: Devices" }));
      await user.click(screen.getByRole("button", { name: "Increase Fans in Hall" }));
      expect(screen.getByTestId("planner-editing-plan")).toHaveTextContent(
        'These answers differ from the saved plan "Hall only". Analyze again to save the changes.'
      );
      await user.click(screen.getByRole("tab", { name: "Step 4: Review" }));
      await user.click(screen.getByRole("button", { name: "Analyze my home" }));
      await screen.findByTestId("planner-verdict");
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      expect(await screen.findByText('Saved changes to "Hall only".')).toBeInTheDocument();

      expect(worker.requests("PATCH", `/api/planner/plans/${plan.id}`)).toHaveLength(1);
      expect(worker.requests("POST", "/api/planner/plans")).toHaveLength(0);
      expect(worker.plans).toHaveLength(1);
    });

    it("follows a rename and notices a deletion made somewhere else", async () => {
      const plan = worker.seedPlan("Hall only", SMALL_HOME);
      const user = userEvent.setup();
      const first = renderPlanner();
      await user.click(await screen.findByRole("tab", { name: "Saved plans (1)" }));
      await user.click(screen.getByRole("button", { name: "Open Hall only" }));
      await screen.findByTestId("planner-verdict");
      first.unmount();

      // Renamed in another browser tab.
      plan.name = "Hallway";
      const second = renderPlanner();
      await waitFor(() =>
        expect(screen.getByTestId("planner-editing-plan")).toHaveTextContent(
          'These are the answers of the saved plan "Hallway".'
        )
      );
      second.unmount();

      // Deleted in another browser tab. The answers stay and can be saved again.
      worker.plans = [];
      renderPlanner();
      expect(
        await screen.findByText(
          '"Hallway" has been deleted. Your answers are still here and can be saved as a new plan.'
        )
      ).toBeInTheDocument();
      expect(screen.queryByTestId("planner-editing-plan")).not.toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Saved plans (0)" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Analyze my home" }));
      await screen.findByTestId("planner-verdict");
      expect(screen.queryByTestId("planner-save-status")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save plan" })).toBeEnabled();
    });

    it("offers a new plan when the open plan disappears before its changes are saved", async () => {
      worker.seedPlan("Hall only", SMALL_HOME);
      const user = userEvent.setup();
      renderPlanner();
      await user.click(await screen.findByRole("tab", { name: "Saved plans (1)" }));
      await user.click(screen.getByRole("button", { name: "Open Hall only" }));
      await screen.findByTestId("planner-verdict");
      await user.click(screen.getByRole("button", { name: "Change my answers" }));
      await user.click(screen.getByRole("tab", { name: "Step 2: Devices" }));
      await user.click(screen.getByRole("button", { name: "Increase Fans in Hall" }));
      await user.click(screen.getByRole("tab", { name: "Step 4: Review" }));
      await user.click(screen.getByRole("button", { name: "Analyze my home" }));
      await screen.findByTestId("planner-verdict");

      worker.plans = [];
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      expect(
        await screen.findByText(
          '"Hall only" no longer exists. Save your answers as a new plan to keep them.'
        )
      ).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Save plan" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("planner-save-status")).not.toBeInTheDocument();
      expect(screen.getByTestId("planner-verdict")).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole("tab", { name: "Saved plans (0)" })).toBeInTheDocument()
      );
      // Said once, not again when the refreshed list arrives.
      expect(screen.queryByText(/has been deleted/)).not.toBeInTheDocument();
    });

    it("renames and deletes a plan after confirmation", async () => {
      worker.seedPlan("Old name", SMALL_HOME);
      const user = userEvent.setup();
      renderPlanner();
      await user.click(await screen.findByRole("tab", { name: "Saved plans (1)" }));

      await user.click(screen.getByRole("button", { name: "Rename Old name" }));
      const rename = await screen.findByRole("dialog");
      const field = within(rename).getByRole("textbox", { name: "Plan name" });
      expect(field).toHaveValue("Old name");
      await user.clear(field);
      await user.type(field, "Ground floor");
      await user.click(within(rename).getByRole("button", { name: "Rename" }));
      expect(await screen.findByRole("heading", { name: "Ground floor" })).toBeInTheDocument();
      expect(worker.requests("PATCH", /\/api\/planner\/plans\//)[0]!.body).toEqual({ name: "Ground floor" });

      await user.click(screen.getByRole("button", { name: "Delete Ground floor" }));
      const confirm = await screen.findByRole("alertdialog");
      expect(within(confirm).getByText('Delete "Ground floor"?')).toBeInTheDocument();
      await user.click(within(confirm).getByRole("button", { name: "Delete plan" }));

      expect(await screen.findByText("No saved plans yet")).toBeInTheDocument();
      expect(worker.requests("DELETE", /\/api\/planner\/plans\//)).toHaveLength(1);
      expect(screen.getByRole("tab", { name: "Saved plans (0)" })).toBeInTheDocument();
    });

    it("lets a viewer analyze and open plans but not save, rename or delete them", async () => {
      worker.seedPlan("Family home", FAMILY_HOME);
      const { user } = await analyze(SMALL_HOME, { canManage: false });

      expect(screen.getByText("Only owners and administrators can save plans.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();

      await user.click(screen.getByRole("tab", { name: "Saved plans (1)" }));
      expect(screen.getByRole("button", { name: "Open Family home" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Rename/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();

      // Opening would replace the viewer's unsaved answers, so it asks first.
      await user.click(screen.getByRole("button", { name: "Open Family home" }));
      const confirm = await screen.findByRole("alertdialog");
      expect(within(confirm).getByText('Open "Family home"?')).toBeInTheDocument();
      await user.click(within(confirm).getByRole("button", { name: "Open plan" }));
      expect(await screen.findByRole("heading", { name: "Ready to install" })).toBeInTheDocument();
      expect(worker.requests("POST", "/api/planner/plans")).toHaveLength(0);
      expect(worker.requests("PATCH", /plans/)).toHaveLength(0);
      expect(worker.requests("DELETE", /plans/)).toHaveLength(0);
    });

    it("explains a failed save and keeps the result on screen", async () => {
      const { user } = await analyze(SMALL_HOME);
      const handle = worker.handle;
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/planner/plans" && init?.method === "POST") {
          return json(
            { error: "You can keep up to 30 saved plans. Delete one to save another.", code: "PLAN_LIMIT_REACHED" },
            409
          );
        }
        return handle(input, init);
      }) as unknown as typeof fetch;

      await user.click(screen.getByRole("button", { name: "Save plan" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Save plan" }));

      expect(
        await screen.findByText("You can keep up to 30 saved plans. Delete one to save another.")
      ).toBeInTheDocument();
      expect(screen.getByTestId("planner-verdict")).toBeInTheDocument();
      expect(screen.queryByTestId("planner-save-status")).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Unsaved answers and routing
  // -------------------------------------------------------------------------

  describe("unsaved answers", () => {
    it("come back after leaving the page, for the same account only", async () => {
      const user = userEvent.setup();
      const first = renderPlanner();
      await user.click(screen.getByRole("button", { name: "Add Kitchen" }));
      await user.click(screen.getByRole("button", { name: "Next" }));
      await user.click(screen.getByRole("button", { name: "Increase Lights in Kitchen" }));
      first.unmount();

      const second = renderPlanner();
      expect(screen.getByRole("tab", { name: "Step 2: Devices" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("spinbutton", { name: "Lights in Kitchen" })).toHaveValue(1);
      second.unmount();

      renderPlanner({ account: "acct-2" });
      expect(screen.getByRole("tab", { name: "Step 1: Your home" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByText("No rooms yet. Add your first room below.")).toBeInTheDocument();
    });
  });

  describe("routing", () => {
    it("is reachable at /planner from the user console navigation", async () => {
      const handle = worker.handle;
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/auth/me")) {
          return json({
            user: { id: "u1", email: "alice@example.com", fullName: "Alice Owner", appearancePreference: "system", timezone: null },
            account: { id: ACCOUNT, name: "Alice Home", slug: "alice-home", status: "active", staffRole: "owner" },
            accounts: [{ id: ACCOUNT, name: "Alice Home", slug: "alice-home", status: "active", staffRole: "owner" }],
            platformDefaultTimezone: "UTC",
            effectiveTimezone: "UTC",
          });
        }
        if (url.startsWith("/api/planner") || url.startsWith("/api/boards")) return handle(input, init);
        return json({});
      }) as unknown as typeof fetch;

      window.history.pushState({}, "", "/planner");
      render(<App />);

      expect(
        await screen.findByRole("region", { name: "Smart Home Planner Header" })
      ).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Step 1: Your home" })).toBeInTheDocument();
      expect(screen.getAllByText("Smart Home Planner").length).toBeGreaterThan(1);
      await waitFor(() => expect(worker.requests("GET", "/api/planner/plans")).toHaveLength(1));
    });
  });
});
