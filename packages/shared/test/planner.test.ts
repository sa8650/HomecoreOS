import { describe, expect, it } from "vitest";
import {
  PLANNER_ENGINE_VERSION,
  PLANNER_FIRMWARE_MAX_IO_ITEMS,
  PLANNER_INPUT_LIMITS,
  PLANNER_STAGE_FAILED_DETAIL,
  PLANNER_STAGE_ORDER,
  PlannerStageTracker,
  VERIFIED_BOARD_CATALOG,
  allocatePlannerChannels,
  buildPlannerCatalogRevisionSource,
  classifyPlannerBoardStatus,
  classifyPlannerReleaseState,
  evaluatePlannerBoardCapability,
  evaluatePlannerCatalog,
  evaluatePlannerFirmware,
  normalizePlannerRequirements,
  plannerChannelDemand,
  plannerDemandRule,
  runPlannerAnalysis,
  stablePlannerStringify,
  toPlannerBoardSpec,
  toPlannerRequirementsInput,
  validateGpioAssignment,
  type PlannerAllocation,
  type PlannerBoardCapability,
  type PlannerBoardRecord,
  type PlannerCatalogSnapshot,
  type PlannerFirmwareReleaseRecord,
  type PlannerPinDemand,
  type PlannerRequirementsInput,
  type PlannerResult,
  type PlannerStageEvent,
  type PlannerWarning,
} from "../src/index";

// ---------------------------------------------------------------------------
// Fixtures: real seed boards from the Board Library, never invented hardware.
// ---------------------------------------------------------------------------

const S3_N16R8 = "esp32-s3-devkitc-1-n16r8";
const S3_V1 = "esp32-s3-devkitc-1-v1-0";
const C3 = "esp32-c3-devkitm-1";
const CLASSIC = "esp32-devkitc-v4";
const S2 = "esp32-s2-devkitc-1";
const H2 = "esp32-h2-devkitm-1";

function board(slug: string, overrides: Partial<PlannerBoardRecord> = {}): PlannerBoardRecord {
  const seed = VERIFIED_BOARD_CATALOG.find((b) => b.slug === slug);
  if (!seed) throw new Error(`Unknown seed board ${slug}`);
  return {
    id: `id-${slug}`,
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

function allSeedBoards(): PlannerBoardRecord[] {
  return VERIFIED_BOARD_CATALOG.map((seed) => board(seed.slug));
}

/** A published, hardware-verified release for the S3 N16R8 with both artifacts. */
function release(overrides: Partial<PlannerFirmwareReleaseRecord> = {}): PlannerFirmwareReleaseRecord {
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

function catalog(
  boards: PlannerBoardRecord[],
  releases: PlannerFirmwareReleaseRecord[] = [],
  overrides: Partial<PlannerCatalogSnapshot> = {}
): PlannerCatalogSnapshot {
  return { boards, releases, boardCatalogEnabled: true, account: null, revision: "rev-test", ...overrides };
}

type RoomDevices = NonNullable<NonNullable<PlannerRequirementsInput["home"]>["rooms"]>[number]["devices"];

function home(
  rooms: Array<{ name: string; devices: RoomDevices; fanSpeedControl?: number; floor?: number; locationId?: string }>,
  installation: PlannerRequirementsInput["installation"] = {},
  extra: Partial<NonNullable<PlannerRequirementsInput["home"]>> = {}
): PlannerRequirementsInput {
  return {
    home: {
      floors: 2,
      rooms: rooms.map((room, i) => ({ id: `r${i + 1}`, ...room })),
      ...extra,
    },
    installation: {
      wifi: "strong",
      environment: "indoor_dry",
      sensorWiring: "direct",
      maxCableRunMeters: 5,
      ...installation,
    },
  };
}

/** A typical family home: 28 controller connections across four rooms. */
function familyHome(installation: PlannerRequirementsInput["installation"] = {}): PlannerRequirementsInput {
  return home(
    [
      {
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
        name: "Kitchen",
        devices: {
          lights: { quantity: 2 },
          appliances: { quantity: 2 },
          gas_smoke_sensors: { quantity: 1 },
          leak_sensors: { quantity: 1 },
        },
      },
      {
        name: "Master Bedroom",
        floor: 2,
        devices: {
          lights: { quantity: 3, independent: 2 },
          fans: { quantity: 1 },
          climate_sensors: { quantity: 1 },
          contact_sensors: { quantity: 2 },
        },
      },
      { name: "Utility", devices: { pumps: { quantity: 1 } } },
    ],
    installation
  );
}

function relays(count: number, installation: PlannerRequirementsInput["installation"] = {}) {
  return home([{ name: "Hall", devices: { switches: { quantity: count } } }], installation);
}

function allocate(
  raw: PlannerRequirementsInput,
  slug: string,
  options?: { maxIoItems?: number; overrides?: Partial<PlannerBoardRecord> }
): { allocation: PlannerAllocation; capability: PlannerBoardCapability } {
  const capability = evaluatePlannerBoardCapability(board(slug, options?.overrides), {
    maxIoItems: options?.maxIoItems,
  });
  return { allocation: allocatePlannerChannels(normalizePlannerRequirements(raw), capability), capability };
}

function assignedPins(allocation: PlannerAllocation): number[][] {
  return allocation.controllers.map((controller) => {
    const pins = controller.assignments.flatMap((a) => (a.pin === null ? [] : [a.pin]));
    if (controller.i2cBus) pins.push(controller.i2cBus.sda, controller.i2cBus.scl);
    return pins;
  });
}

/** Strips the only non-deterministic field: measured stage durations. */
function withoutTimings(result: PlannerResult): PlannerResult {
  return { ...result, stages: result.stages.map((stage) => ({ ...stage, durationMs: null })) };
}

function codes(warnings: PlannerWarning[]): string[] {
  return warnings.map((w) => w.code);
}

// ---------------------------------------------------------------------------
// 1. Requirement normalization
// ---------------------------------------------------------------------------

describe("planner: requirement normalization", () => {
  it("never throws on malformed input and reports what is missing", () => {
    for (const raw of [undefined, null, 42, "home", [], { home: 5 }, { home: { rooms: "x" } }]) {
      const normalized = normalizePlannerRequirements(raw);
      expect(normalized.complete).toBe(false);
      expect(normalized.missing.some((m) => m.code === "no_rooms" && m.blocking)).toBe(true);
      expect(normalized.missing.some((m) => m.code === "wifi_unanswered" && m.blocking)).toBe(true);
    }
  });

  it("clamps numbers, drops control characters and keeps ids unique", () => {
    const normalized = normalizePlannerRequirements({
      home: {
        floors: 999,
        rooms: [
          { id: "dup", name: "  Living\u0000 Room  ", floor: 50, devices: { lights: { quantity: 9999, independent: -4 } } },
          { id: "dup", name: "", devices: { switches: { quantity: "3" } } },
          { id: "<script>", name: "x".repeat(500), devices: {} },
        ],
      },
      installation: { wifi: "telepathy", futureOutputs: 1e9 },
    });

    expect(normalized.floors).toBe(PLANNER_INPUT_LIMITS.maxFloors);
    expect(normalized.rooms[0]!.name).toBe("Living Room");
    expect(normalized.rooms[0]!.floor).toBe(PLANNER_INPUT_LIMITS.maxFloors);
    expect(normalized.rooms[0]!.devices.lights).toEqual({
      quantity: PLANNER_INPUT_LIMITS.maxQuantityPerCategory,
      independent: 1,
    });
    expect(normalized.rooms[1]!.devices.switches.quantity).toBe(3);
    expect(normalized.rooms[2]!.name).toHaveLength(PLANNER_INPUT_LIMITS.maxNameLength);
    expect(new Set(normalized.rooms.map((r) => r.id)).size).toBe(3);
    expect(normalized.rooms.every((r) => /^[A-Za-z0-9_-]+$/.test(r.id))).toBe(true);
    expect(normalized.installation.wifi).toBeNull();
    expect(normalized.installation.futureOutputs).toBe(PLANNER_INPUT_LIMITS.maxFutureChannels);
    expect(normalized.missing.some((m) => m.code === "room_unnamed" && !m.blocking)).toBe(true);
  });

  it("separates physical devices from independently controlled channels", () => {
    const normalized = normalizePlannerRequirements(
      home([{ name: "Hall", devices: { lights: { quantity: 6, independent: 2 }, curtains: { quantity: 1 } } }])
    );
    const lights = normalized.channels.filter((c) => c.category === "lights");
    expect(lights.map((c) => c.physicalDevices)).toEqual([3, 3]);
    expect(lights[0]!.label).toBe("Light group 1 (3 lights)");

    // A curtain motor needs an open and a close output that stay together.
    const curtain = normalized.channels.filter((c) => c.category === "curtains");
    expect(curtain).toHaveLength(2);
    expect(new Set(curtain.map((c) => c.atomicGroup)).size).toBe(1);

    expect(normalized.totals.physicalDevices).toBe(7);
    expect(normalized.totals.controlChannels).toBe(3);
    expect(normalized.totals.gpioChannels).toBe(4);
    expect(normalized.totals.relayChannels).toBe(4);
  });

  it("maps every category onto a pin requirement the platform validator knows", () => {
    const normalized = normalizePlannerRequirements(
      home([
        {
          name: "Everything",
          devices: {
            lights: { quantity: 1 },
            fans: { quantity: 2 },
            switches: { quantity: 1 },
            pumps: { quantity: 1 },
            appliances: { quantity: 1 },
            motion_sensors: { quantity: 1 },
            climate_sensors: { quantity: 1 },
            contact_sensors: { quantity: 1 },
            gas_smoke_sensors: { quantity: 1 },
            leak_sensors: { quantity: 1 },
          },
          fanSpeedControl: 1,
        },
      ])
    );
    const demandOf = (category: string, index = 0) =>
      plannerChannelDemand(normalized.channels.filter((c) => c.category === category)[index]!);

    expect(demandOf("lights")).toBe("digital_out");
    expect(demandOf("fans", 0)).toBe("pwm");
    expect(demandOf("fans", 1)).toBe("digital_out");
    expect(demandOf("switches")).toBe("digital_out");
    expect(demandOf("pumps")).toBe("digital_out");
    expect(demandOf("motion_sensors")).toBe("digital_in");
    expect(demandOf("climate_sensors")).toBe("digital_in");
    expect(demandOf("contact_sensors")).toBe("contact_in");
    expect(demandOf("leak_sensors")).toBe("contact_in");
    expect(demandOf("gas_smoke_sensors")).toBe("adc");
    expect(normalized.channels.filter((c) => c.needsRelay)).toHaveLength(5);
  });

  it("round-trips through its storable form without changing the plan", () => {
    const raw = familyHome({ sensorWiring: "unsure", futureOutputs: 3 });
    const first = normalizePlannerRequirements(raw);
    const stored = toPlannerRequirementsInput(first, raw);
    const second = normalizePlannerRequirements(JSON.parse(JSON.stringify(stored)));

    expect(second.channels).toEqual(first.channels);
    expect(second.totals).toEqual(first.totals);
    expect(second.installation).toEqual(first.installation);
    expect(second.missing).toEqual(first.missing);
    expect(stored.installation?.sensorWiring).toBe("unsure");
    expect(toPlannerRequirementsInput(second, stored)).toEqual(stored);
  });

  it("flags blocking gaps as incomplete and non-blocking gaps as assumptions", () => {
    const noDevices = normalizePlannerRequirements(home([{ name: "Empty", devices: {} }]));
    expect(noDevices.complete).toBe(false);
    expect(noDevices.missing.find((m) => m.blocking)?.code).toBe("no_devices");

    const noWifi = normalizePlannerRequirements(relays(2, { wifi: null }));
    expect(noWifi.complete).toBe(false);
    expect(noWifi.missing.find((m) => m.blocking)?.code).toBe("wifi_unanswered");

    const assumed = normalizePlannerRequirements(
      home([{ name: "Hall", devices: { motion_sensors: { quantity: 1 } } }], {
        wifi: "unknown",
        environment: null,
        sensorWiring: null,
        maxCableRunMeters: null,
      })
    );
    expect(assumed.complete).toBe(true);
    expect(assumed.missing.map((m) => m.code).sort()).toEqual([
      "cable_distance_unanswered",
      "controller_location_assumed",
      "environment_unanswered",
      "sensor_wiring_assumed",
      "wifi_unknown",
    ]);
    expect(assumed.missing.every((m) => !m.blocking)).toBe(true);
  });

  it("refuses plans beyond the supported size instead of running unbounded", () => {
    const rooms = Array.from({ length: 12 }, (_, i) => ({
      name: `Room ${i}`,
      devices: { switches: { quantity: 64 } },
    }));
    const normalized = normalizePlannerRequirements(home(rooms));
    expect(normalized.totals.gpioChannels).toBeGreaterThan(PLANNER_INPUT_LIMITS.maxTotalChannels);
    expect(normalized.complete).toBe(false);
    expect(normalized.missing.some((m) => m.code === "plan_too_large" && m.blocking)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Board status and capability
// ---------------------------------------------------------------------------

describe("planner: board status", () => {
  it("distinguishes published, unpublished, unverified and unsupported", () => {
    expect(classifyPlannerBoardStatus(board(S3_N16R8)).code).toBe("published");
    expect(classifyPlannerBoardStatus(board(S3_N16R8, { is_available: false })).code).toBe("unpublished");
    expect(
      classifyPlannerBoardStatus(board(S3_N16R8, { verification_status: "needs_verification" })).code
    ).toBe("unverified");
    expect(classifyPlannerBoardStatus(board(S3_N16R8, { firmware_status: "unsupported" })).code).toBe(
      "unsupported"
    );
    expect(classifyPlannerBoardStatus(board(S3_N16R8, { chip_family: "stm32" })).code).toBe("unsupported");
  });

  it("never treats an unverified board as published, even when it is listed", () => {
    const status = classifyPlannerBoardStatus(
      board(S3_N16R8, { verification_status: "needs_verification", is_available: true })
    );
    expect(status).toMatchObject({ code: "unverified", isPublished: false, isVerified: false });
  });

  it("treats the customer's own custom boards as unverified", () => {
    const status = classifyPlannerBoardStatus(
      board(S3_N16R8, { source: "custom", firmware_status: "custom", verification_status: null })
    );
    expect(status).toMatchObject({ code: "unverified", isCustom: true, isPublished: false });
  });
});

describe("planner: board capability", () => {
  it("holds back strapping, USB and flash pins on the ESP32-S3", () => {
    const capability = evaluatePlannerBoardCapability(board(S3_N16R8));
    const tierOf = (pin: number) => capability.pins.find((p) => p.pin === pin)?.tier;
    const handedOut = new Set(Object.values(capability.pinsFor).flat());

    expect(capability.evaluable).toBe(true);
    expect(capability.counts.usable).toBe(25);
    for (const pin of [0, 3, 45, 46, 19, 20]) {
      expect(tierOf(pin), `GPIO${pin}`).toBe("restricted");
      expect(handedOut.has(pin), `GPIO${pin}`).toBe(false);
    }
    for (const pin of capability.pins.filter((p) => p.tier === "blocked")) {
      expect(handedOut.has(pin.pin), `GPIO${pin.pin}`).toBe(false);
      expect(pin.reasons.length).toBeGreaterThan(0);
    }
  });

  it("only offers pins the existing GPIO validator accepts without warnings", () => {
    for (const record of allSeedBoards()) {
      const capability = evaluatePlannerBoardCapability(record);
      const spec = toPlannerBoardSpec(record)!;
      for (const demand of Object.keys(capability.pinsFor) as PlannerPinDemand[]) {
        const rule = plannerDemandRule(demand);
        for (const pin of capability.pinsFor[demand]) {
          const check = validateGpioAssignment({
            board: spec,
            pin,
            requirement: rule.requirement,
            usedPinsOnController: [],
            requirePullUp: rule.requirePullUp,
          });
          expect(check.valid && check.warnings.length === 0, `${record.slug} GPIO${pin} ${demand}`).toBe(true);
        }
      }
    }
  });

  it("knows input-only pins cannot drive a relay", () => {
    const capability = evaluatePlannerBoardCapability(board(CLASSIC));
    expect(capability.counts.digitalIn).toBe(19);
    expect(capability.counts.digitalOut).toBe(15);
    const inputOnly = capability.pins.filter((p) => p.inputOnly).map((p) => p.pin);
    expect(inputOnly.length).toBeGreaterThan(0);
    for (const pin of inputOnly) expect(capability.pinsFor.digital_out).not.toContain(pin);
  });

  it("reports undocumented facts as undocumented instead of assuming them", () => {
    for (const record of allSeedBoards()) {
      const capability = evaluatePlannerBoardCapability(record);
      expect(capability.ethernet).toBe("not_documented");
      expect(capability.currentLimitDocumented).toBe(false);
      expect(capability.onboardRelayChannels).toBe(0);
      expect(capability.maxIoItems).toBe(PLANNER_FIRMWARE_MAX_IO_ITEMS);
    }
    expect(evaluatePlannerBoardCapability(board(H2)).supportsWifi).toBe(false);
  });

  it("refuses to evaluate a board without a valid pin map", () => {
    const capability = evaluatePlannerBoardCapability(board(S3_N16R8, { gpio_definitions: [] }));
    expect(capability.evaluable).toBe(false);
    expect(capability.counts.usable).toBe(0);
    expect(capability.specIssues.length).toBeGreaterThan(0);

    const allocation = allocatePlannerChannels(normalizePlannerRequirements(relays(1)), capability);
    expect(allocation.feasible).toBe(false);
    expect(allocation.unallocated[0]!.reason).toBe("board_not_evaluable");
  });
});

// ---------------------------------------------------------------------------
// 3. GPIO and device allocation
// ---------------------------------------------------------------------------

describe("planner: GPIO allocation", () => {
  it("gives every channel its own validated pin of the right kind", () => {
    const { allocation, capability } = allocate(familyHome({ allowAdditionalControllers: true }), S2);
    expect(allocation.feasible).toBe(true);
    expect(allocation.controllers).toHaveLength(1);

    const controller = allocation.controllers[0]!;
    const pins = assignedPins(allocation)[0]!;
    expect(new Set(pins).size).toBe(pins.length);
    expect(controller.assignments).toHaveLength(28);

    for (const assignment of controller.assignments) {
      const demand = assignment.demand as PlannerPinDemand;
      expect(capability.pinsFor[demand], assignment.label).toContain(assignment.pin);
    }
    const tierOf = new Map(capability.pins.map((p) => [p.pin, p.tier]));
    for (const pin of pins) expect(["free", "shared"]).toContain(tierOf.get(pin));
  });

  it("solves pin competition exactly instead of counting pins", () => {
    // 15 outputs + 4 inputs on a classic ESP32: 19 usable pins, of which only 15
    // can drive an output. It fits only if the inputs take the input-only pins.
    const tight = home([
      { name: "Hall", devices: { switches: { quantity: 15 }, motion_sensors: { quantity: 4 } } },
    ]);
    const fit = allocate(tight, CLASSIC);
    expect(fit.allocation.feasible).toBe(true);
    expect(fit.allocation.controllers).toHaveLength(1);
    const inputOnly = new Set(fit.capability.pins.filter((p) => p.inputOnly).map((p) => p.pin));
    const sensorPins = fit.allocation.controllers[0]!.assignments
      .filter((a) => a.category === "motion_sensors")
      .map((a) => a.pin!);
    expect(sensorPins.every((pin) => inputOnly.has(pin))).toBe(true);

    // One more output cannot fit, however many pins are "free".
    const over = allocate(
      home([{ name: "Hall", devices: { switches: { quantity: 16 }, motion_sensors: { quantity: 3 } } }]),
      CLASSIC
    );
    expect(over.allocation.controllers).toHaveLength(2);
    expect(over.allocation.pressure.capabilityShortage).toContain("digital_out");
  });

  it("keeps analog sensors on ADC pins and adds a controller when they run out", () => {
    const fits = allocate(
      home([{ name: "Lab", devices: { gas_smoke_sensors: { quantity: 4 }, switches: { quantity: 4 } } }]),
      C3
    );
    expect(fits.allocation.feasible).toBe(true);
    expect(fits.allocation.controllers).toHaveLength(1);
    for (const a of fits.allocation.controllers[0]!.assignments.filter((x) => x.demand === "adc")) {
      expect(fits.capability.pinsFor.adc).toContain(a.pin);
    }

    const spills = allocate(home([{ name: "Lab", devices: { gas_smoke_sensors: { quantity: 5 } } }]), C3);
    expect(spills.allocation.feasible).toBe(true);
    expect(spills.allocation.controllers).toHaveLength(2);
    expect(spills.allocation.pressure.capabilityShortage).toEqual(["adc"]);
  });

  it("builds a multi-controller plan when one board is too small", () => {
    const { allocation, capability } = allocate(
      home([
        { name: "Ground", devices: { switches: { quantity: 14 }, curtains: { quantity: 3 } } },
        { name: "Upper", devices: { lights: { quantity: 10 } } },
      ]),
      C3
    );
    expect(capability.counts.usable).toBe(8);
    expect(allocation.feasible).toBe(true);
    // 30 connections on 8 usable pins need at least four controllers.
    expect(allocation.controllers.length).toBe(4);
    expect(allocation.pressure.gpioShortage).toBe(true);

    const seen = new Set<string>();
    for (const controller of allocation.controllers) {
      expect(controller.pinsUsed).toBeLessThanOrEqual(capability.counts.usable);
      expect(controller.ioItemsUsed).toBeLessThanOrEqual(capability.maxIoItems);
      const pins = controller.assignments.map((a) => a.pin);
      expect(new Set(pins).size).toBe(pins.length);
      for (const a of controller.assignments) {
        expect(seen.has(a.channelId)).toBe(false);
        seen.add(a.channelId);
      }
    }
    expect(seen.size).toBe(30);

    // Both windings of each curtain motor share a controller.
    for (let i = 1; i <= 3; i++) {
      const owners = allocation.controllers.filter((c) =>
        c.assignments.some((a) => a.channelId.startsWith(`r1:curtains:${i}:`))
      );
      expect(owners).toHaveLength(1);
    }
  });

  it("spreads rooms across controllers so each keeps spare pins", () => {
    const { allocation } = allocate(familyHome(), S3_N16R8);
    expect(allocation.feasible).toBe(true);
    expect(allocation.controllers).toHaveLength(2);
    for (const controller of allocation.controllers) {
      expect(controller.spare.pins).toBeGreaterThanOrEqual(5);
    }
    // No room is split between the two controllers.
    const roomOwners = new Map<string, Set<number>>();
    for (const controller of allocation.controllers) {
      for (const room of controller.rooms) {
        const owners = roomOwners.get(room.roomId) ?? new Set<number>();
        owners.add(controller.index);
        roomOwners.set(room.roomId, owners);
      }
    }
    for (const owners of roomOwners.values()) expect(owners.size).toBe(1);
  });

  it("enforces the firmware's per-controller connection limit", () => {
    const { allocation } = allocate(relays(25), S2, { maxIoItems: 10 });
    expect(allocation.feasible).toBe(true);
    expect(allocation.controllers).toHaveLength(3);
    for (const controller of allocation.controllers) {
      expect(controller.ioItemsUsed).toBeLessThanOrEqual(10);
    }
    expect(allocation.pressure.ioItemLimit).toBe(true);
  });

  it("does not add controllers the customer ruled out", () => {
    const { allocation } = allocate(relays(12, { allowAdditionalControllers: false }), C3);
    expect(allocation.feasible).toBe(false);
    expect(allocation.controllers).toHaveLength(1);
    expect(allocation.unallocated).toHaveLength(4);
    expect(allocation.unallocated.every((u) => u.reason === "single_controller_limit")).toBe(true);
    expect(allocation.pressure.singleControllerLimit).toBe(true);
  });

  it("places a controller at every installation location", () => {
    const raw = home(
      [
        { name: "Garage", locationId: "garage", devices: { switches: { quantity: 2 } } },
        { name: "Hall", locationId: "panel", devices: { switches: { quantity: 3 } } },
      ],
      {},
      {
        controllerLocations: [
          { id: "panel", name: "Main panel" },
          { id: "garage", name: "Garage box" },
        ],
      }
    );
    const { allocation } = allocate(raw, S2);
    expect(allocation.feasible).toBe(true);
    expect(allocation.controllers.map((c) => c.locationName).sort()).toEqual(["Garage box", "Main panel"]);
    const garage = allocation.controllers.find((c) => c.locationId === "garage")!;
    expect(garage.rooms.map((r) => r.roomName)).toEqual(["Garage"]);
  });

  it("shares one I2C bus between two sensors and falls back for the third", () => {
    const { allocation, capability } = allocate(
      home([{ name: "Lab", devices: { climate_sensors: { quantity: 3 } } }], { sensorWiring: "i2c_bus" }),
      S2
    );
    expect(allocation.feasible).toBe(true);
    const controller = allocation.controllers[0]!;
    const onBus = controller.assignments.filter((a) => a.demand === "i2c_bus");
    const fallback = controller.assignments.filter((a) => a.demand === "digital_in");

    expect(onBus).toHaveLength(2);
    expect(onBus.every((a) => a.pin === null)).toBe(true);
    expect(controller.i2cBus).toMatchObject({ sensors: 2 });
    expect(capability.pinsFor.i2c).toContain(controller.i2cBus!.sda);
    expect(capability.pinsFor.i2c).toContain(controller.i2cBus!.scl);
    expect(controller.i2cBus!.sda).not.toBe(controller.i2cBus!.scl);

    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.homecore.type).toBe("temperature_dht22");
    expect(controller.pinsUsed).toBe(3);
    expect(allocation.pressure.i2cFallbackSensors).toBe(1);
  });

  it("checks requested future capacity against the pins that are really left", () => {
    const enough = allocate(relays(4, { futureOutputs: 4 }), C3);
    expect(enough.allocation.future).toMatchObject({ accommodatedOutputs: 4, satisfied: true });

    const short = allocate(relays(4, { futureOutputs: 3, futureInputs: 3 }), C3);
    expect(short.allocation.future).toMatchObject({
      accommodatedOutputs: 3,
      accommodatedInputs: 1,
      satisfied: false,
    });
  });

  it("never gives a pin to a sensor type HomecoreOS cannot read", () => {
    const { allocation } = allocate(
      home([{ name: "Hall", devices: { switches: { quantity: 2 }, motion_sensors: { quantity: 2 } } }], {
        sensorWiring: "wireless",
      }),
      S2
    );
    expect(allocation.feasible).toBe(false);
    expect(allocation.controllers[0]!.assignments).toHaveLength(2);
    expect(allocation.unallocated).toHaveLength(2);
    expect(allocation.unallocated.every((u) => u.reason === "unsupported_interface")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Firmware compatibility
// ---------------------------------------------------------------------------

describe("planner: firmware states", () => {
  const s3 = board(S3_N16R8);

  it("reports a published release with real artifacts as installable", () => {
    const firmware = evaluatePlannerFirmware(s3, [release()]);
    expect(firmware).toMatchObject({
      state: "published_available",
      label: "Published and available",
      published: true,
      installable: true,
      usbFactoryAvailable: true,
      otaAvailable: true,
      validatedForBoard: true,
    });
    expect(firmware.release).toMatchObject({ id: "rel-1", name: "HomecoreOS", version: "1.2.0" });
  });

  it("keeps a release without a USB factory image from being installable", () => {
    const otaOnly = evaluatePlannerFirmware(s3, [
      release({ usb_available: false, files: [{ file_type: "ota_app", validated: true, flash_size: "16MB" }] }),
    ]);
    expect(otaOnly).toMatchObject({
      state: "published_available",
      installable: false,
      usbFactoryAvailable: false,
      otaAvailable: true,
    });

    const usbOnly = evaluatePlannerFirmware(s3, [
      release({ ota_available: false, files: [{ file_type: "usb_factory", validated: true, flash_size: "16MB" }] }),
    ]);
    expect(usbOnly).toMatchObject({ installable: true, usbFactoryAvailable: true, otaAvailable: false });
  });

  it("requires a validated file row behind every artifact flag", () => {
    const flagOnly = evaluatePlannerFirmware(s3, [release({ files: [] })]);
    expect(flagOnly).toMatchObject({
      state: "compatible_release_found",
      published: false,
      installable: false,
      usbFactoryAvailable: false,
      otaAvailable: false,
    });

    const unvalidated = evaluatePlannerFirmware(s3, [
      release({
        files: [
          { file_type: "usb_factory", validated: false, flash_size: "16MB" },
          { file_type: "ota_app", validated: true, flash_size: "16MB" },
        ],
      }),
    ]);
    expect(unvalidated).toMatchObject({ installable: false, usbFactoryAvailable: false, otaAvailable: true });
  });

  it("classifies every unpublished lifecycle state and keeps drafts anonymous", () => {
    const cases: Array<[Partial<PlannerFirmwareReleaseRecord>, string]> = [
      [{ status: "draft", build_status: "pending" }, "build_pending"],
      [{ status: "draft", build_status: "building" }, "build_pending"],
      [{ status: "draft", build_status: "failed" }, "build_failed"],
      [{ status: "draft", build_status: "succeeded" }, "compatible_release_found"],
      [{ status: "draft", build_status: "manual" }, "compatible_release_found"],
      [{ status: "deprecated" }, "deprecated"],
    ];
    for (const [overrides, expected] of cases) {
      const firmware = evaluatePlannerFirmware(s3, [release({ ...overrides, name: "Secret internal build" })]);
      expect(firmware.state, JSON.stringify(overrides)).toBe(expected);
      expect(firmware.published).toBe(false);
      expect(firmware.installable).toBe(false);
      expect(firmware.usbFactoryAvailable).toBe(false);
      expect(firmware.otaAvailable).toBe(false);
      // Unpublished releases expose a version only: no id, no name.
      expect(firmware.release).toMatchObject({ id: null, name: null, publishedAt: null });
      expect(JSON.stringify(firmware)).not.toContain("Secret internal build");
    }
  });

  it("ignores archived releases and releases for other hardware", () => {
    expect(classifyPlannerReleaseState(release({ status: "archived" }))).toBeNull();
    expect(evaluatePlannerFirmware(s3, [release({ status: "archived" })]).state).toBe("no_compatible_release");
    expect(evaluatePlannerFirmware(s3, []).state).toBe("no_compatible_release");

    // Wrong chip, and a release that names a different board.
    expect(evaluatePlannerFirmware(board(C3), [release()]).state).toBe("no_compatible_release");
    expect(evaluatePlannerFirmware(board(S3_V1), [release()]).state).toBe("no_compatible_release");
  });

  it("applies chip-wide releases only to boards flagged firmware supported", () => {
    const chipWide = release({ target_board_slug: null, compatible_board_ids: [], compatible_board_slugs: [] });
    expect(evaluatePlannerFirmware(s3, [chipWide]).state).toBe("published_available");
    expect(
      evaluatePlannerFirmware(board(S3_N16R8, { firmware_status: "catalog_only" }), [chipWide]).state
    ).toBe("no_compatible_release");
  });

  it("prefers the installable published release over everything else", () => {
    const firmware = evaluatePlannerFirmware(s3, [
      release({ id: "old", version: "1.0.0", status: "deprecated" }),
      release({ id: "draft", version: "2.0.0", status: "draft", build_status: "building" }),
      release({ id: "beta", version: "1.9.0", channel: "beta" }),
      release({ id: "stable-old", version: "1.1.0" }),
      release({ id: "stable-new", version: "1.3.0" }),
      release({ id: "ota-only", version: "1.5.0", usb_available: false, files: [{ file_type: "ota_app", validated: true }] }),
    ]);
    expect(firmware.state).toBe("published_available");
    expect(firmware.release?.id).toBe("stable-new");
    expect(firmware.compatibleReleaseCount).toBe(6);
    expect(firmware.otherStates).toEqual(["build_pending", "deprecated"]);
  });

  it("reports the Board Library's Build Pending flag even without a release row", () => {
    const pending = evaluatePlannerFirmware(board(S3_V1, { firmware_status: "build_pending" }), []);
    expect(pending.state).toBe("build_pending");
    expect(pending.release).toBeNull();
    expect(pending.installable).toBe(false);
  });

  it("does not call a release validated for a board it was never verified on", () => {
    const unverified = evaluatePlannerFirmware(
      board(S3_V1),
      [
        release({
          target_board_slug: S3_V1,
          compatible_board_ids: [`id-${S3_V1}`],
          compatible_board_slugs: [S3_V1],
          partition_scheme: "dual_ota_8mb",
          flash_size_mb: 8,
          hardware_verified: false,
          files: [
            { file_type: "usb_factory", validated: true, flash_size: "8MB" },
            { file_type: "ota_app", validated: true, flash_size: "8MB" },
          ],
        }),
      ]
    );
    expect(unverified.state).toBe("published_available");
    expect(unverified.installable).toBe(true);
    expect(unverified.validatedForBoard).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5–7. Availability, ranking, warnings and the full pipeline
// ---------------------------------------------------------------------------

describe("planner: recommendations", () => {
  it("recommends a ready plan only when board, firmware and USB installer all exist", () => {
    const result = runPlannerAnalysis(familyHome(), catalog(allSeedBoards(), [release()]));
    expect(result.state).toBe("ready");
    expect(result.headline).toBe("Ready to install");
    expect(result.engineVersion).toBe(PLANNER_ENGINE_VERSION);

    const best = result.plans[0]!;
    expect(best.board.slug).toBe(S3_N16R8);
    expect(best.readiness).toBe("ready");
    expect(best.controllerCount).toBe(2);
    expect(best.detailLevel).toBe("full");
    expect(best.firmware.installable).toBe(true);
    expect(best.installation.usbFactory.available).toBe(true);
    expect(best.installation.ota.available).toBe(true);
    expect(best.reasons.length).toBeGreaterThan(2);

    // Every other board lacks firmware, so none of them may claim to be ready.
    for (const plan of result.plans.slice(1)) expect(plan.readiness).toBe("partially_ready");
    expect(result.evaluatedBoards).toHaveLength(11);
    expect(result.evaluatedBoards.filter((b) => b.readiness === "ready")).toHaveLength(1);
    expect(result.stats).toMatchObject({ boardsEvaluated: 11, firmwareReleasesEvaluated: 1 });
  });

  it("is only partially ready when hardware fits but firmware is missing", () => {
    const result = runPlannerAnalysis(familyHome(), catalog(allSeedBoards(), []));
    expect(result.state).toBe("partially_ready");
    expect(result.plans.every((p) => p.readiness !== "ready")).toBe(true);
    expect(result.plans[0]!.firmware.state).toBe("no_compatible_release");
    expect(codes(result.plans[0]!.warnings)).toContain("no_compatible_firmware");
    expect(result.summary).toMatch(/no firmware release exists/);
  });

  it.each([
    [{ status: "draft", build_status: "building" }, "build_pending", "firmware_not_published"],
    [{ status: "draft", build_status: "failed" }, "build_failed", "firmware_not_published"],
    [{ status: "deprecated" }, "deprecated", "firmware_not_published"],
    [{ files: [{ file_type: "ota_app", validated: true }], usb_available: false }, "published_available", "missing_usb_artifact"],
  ] as Array<[Partial<PlannerFirmwareReleaseRecord>, string, string]>)(
    "never reports ready for firmware in state %o",
    (overrides, state, warning) => {
      const result = runPlannerAnalysis(familyHome(), catalog([board(S3_N16R8)], [release(overrides)]));
      expect(result.state).toBe("partially_ready");
      expect(result.plans[0]!.firmware.state).toBe(state);
      expect(result.plans[0]!.firmware.installable).toBe(false);
      expect(codes(result.plans[0]!.warnings)).toContain(warning);
    }
  );

  it("still installs over USB without an OTA image, and says updates are unavailable", () => {
    const result = runPlannerAnalysis(
      familyHome(),
      catalog([board(S3_N16R8)], [release({ ota_available: false, files: [{ file_type: "usb_factory", validated: true }] })])
    );
    expect(result.state).toBe("ready");
    expect(result.plans[0]!.installation.ota.available).toBe(false);
    expect(codes(result.plans[0]!.warnings)).toContain("missing_ota_artifact");
  });

  it("never presents an unpublished or unverified board as ready, and hides its pin map", () => {
    for (const overrides of [
      { is_available: false },
      { verification_status: "needs_verification" as const },
    ]) {
      const result = runPlannerAnalysis(familyHome(), catalog([board(S3_N16R8, overrides)], [release()]));
      const plan = result.plans[0]!;
      expect(result.state).toBe("partially_ready");
      expect(plan.readiness).toBe("partially_ready");
      expect(plan.detailLevel).toBe("summary");
      expect(plan.board.slug).toBeNull();
      expect(plan.controllers.every((c) => c.assignments.length === 0 && c.i2cBus === null)).toBe(true);
      expect(plan.capability.restrictedPins).toEqual([]);
      expect(
        codes(plan.warnings).some((code) => code === "board_not_published" || code === "unverified_board_specs")
      ).toBe(true);
    }
  });

  it("reports not supported when no board can meet the connectivity requirement", () => {
    const noWifi = runPlannerAnalysis(familyHome({ wifi: "none" }), catalog(allSeedBoards(), [release()]));
    expect(noWifi.state).toBe("not_supported");
    expect(noWifi.plans.every((p) => p.readiness === "not_supported")).toBe(true);
    expect(codes(noWifi.warnings)).toContain("unsupported_connectivity");

    const ethernet = runPlannerAnalysis(familyHome({ ethernet: "required" }), catalog(allSeedBoards(), [release()]));
    expect(ethernet.state).toBe("not_supported");
    expect(ethernet.warnings.find((w) => w.code === "unsupported_connectivity")?.effect).toBe("blocks_plan");

    const noRadio = runPlannerAnalysis(relays(2), catalog([board(H2)], []));
    expect(noRadio.state).toBe("not_supported");
    expect(codes(noRadio.plans[0]!.warnings)).toContain("unsupported_connectivity");
  });

  it("reports not supported for sensor types and capacity HomecoreOS cannot provide", () => {
    const wireless = runPlannerAnalysis(
      home([{ name: "Hall", devices: { motion_sensors: { quantity: 2 } } }], { sensorWiring: "rs485" }),
      catalog(allSeedBoards(), [release()])
    );
    expect(wireless.state).toBe("not_supported");
    expect(codes(wireless.warnings)).toContain("unsupported_sensor_interface");

    const single = runPlannerAnalysis(
      relays(40, { allowAdditionalControllers: false }),
      catalog(allSeedBoards(), [release()])
    );
    expect(single.state).toBe("not_supported");
    expect(codes(single.plans[0]!.warnings)).toContain("missing_expansion_modules");
    expect(single.plans[0]!.unallocated.length).toBeGreaterThan(0);
  });

  it("returns an incomplete result, with nothing recommended, when answers are missing", () => {
    const events: PlannerStageEvent[] = [];
    const tracker = new PlannerStageTracker((event) => events.push(event));
    const result = runPlannerAnalysis({ home: { rooms: [] } }, catalog(allSeedBoards(), [release()]), { tracker });

    expect(result.state).toBe("incomplete");
    expect(result.headline).toBe("More information needed");
    expect(result.plans).toEqual([]);
    expect(result.evaluatedBoards).toEqual([]);
    expect(result.missingInformation.filter((m) => m.blocking).map((m) => m.code)).toEqual([
      "no_rooms",
      "wifi_unanswered",
    ]);
    expect(codes(result.warnings)).toContain("incomplete_information");
    expect(result.stages[0]).toMatchObject({ id: "requirements", status: "completed" });
    expect(result.stages.slice(1).every((s) => s.status === "skipped")).toBe(true);
  });

  it("reports stock as unknown and gives no cost estimate without real data", () => {
    const result = runPlannerAnalysis(familyHome(), catalog([board(S3_N16R8)], [release()]));
    const availability = result.plans[0]!.availability;
    expect(availability.catalog.status).toBe("published");
    expect(availability.stock.status).toBe("unknown");
    expect(availability.cost.available).toBe(false);
    expect(codes(result.plans[0]!.warnings)).toContain("stock_unknown");
  });

  it("estimates cost only from a price that is really recorded", () => {
    const result = runPlannerAnalysis(
      familyHome(),
      catalog(
        [board(S3_N16R8, { unit_price: { amount: 14.5, currency: "usd" }, stock: { status: "in_stock", quantity: 7 } })],
        [release()]
      )
    );
    const availability = result.plans[0]!.availability;
    expect(availability.cost).toMatchObject({ available: true, currency: "USD", total: 29 });
    expect(availability.stock.status).toBe("in_stock");
    expect(codes(result.plans[0]!.warnings)).not.toContain("stock_unknown");
  });

  it("respects the account's controller limit", () => {
    const result = runPlannerAnalysis(
      familyHome(),
      catalog([board(S3_N16R8)], [release()], {
        account: { existingControllers: 24, existingDevices: 0, maxControllers: 25, maxDevices: 100 },
      })
    );
    expect(result.state).toBe("partially_ready");
    const limit = result.plans[0]!.availability.accountLimits.find((l) => l.kind === "controllers")!;
    expect(limit).toMatchObject({ limit: 25, existing: 24, planned: 2, exceeded: true });
    expect(codes(result.plans[0]!.warnings)).toContain("account_limit_exceeded");
  });

  it("requires relay hardware the customer has not allowed", () => {
    const result = runPlannerAnalysis(
      familyHome({ allowExternalRelayModules: false }),
      catalog([board(S3_N16R8)], [release()])
    );
    expect(result.state).toBe("partially_ready");
    const warning = result.plans[0]!.warnings.find((w) => w.code === "missing_relay_hardware")!;
    expect(warning.effect).toBe("blocks_installation");
  });

  it("lists the external hardware the validated plan needs", () => {
    const result = runPlannerAnalysis(familyHome(), catalog([board(S3_N16R8)], [release()]));
    const hardware = result.plans[0]!.externalHardware;
    const byKind = (kind: string) => hardware.filter((h) => h.kind === kind);

    // 3 light groups + 1 on/off fan + 4 switches + 2×2 curtain windings + 2 lights
    // + 2 appliances + 2 light groups + 1 fan + 1 pump. The PWM fan is not a relay.
    expect(byKind("relay_module")[0]!.quantity).toBe(20);
    expect(byKind("fan_speed_controller")[0]!.quantity).toBe(1);
    expect(byKind("curtain_controller")[0]!.quantity).toBe(2);
    expect(byKind("motor_contactor")[0]!.quantity).toBe(1);
    expect(byKind("power_supply")[0]!.quantity).toBe(2);
    expect(byKind("enclosure")[0]!.quantity).toBe(2);
    expect(byKind("sensor_module").reduce((sum, h) => sum + h.quantity, 0)).toBe(7);
  });

  it("uses only custom boards when the administrator disables the Board Library", () => {
    const custom = board(S2, { id: "custom-1", source: "custom", firmware_status: "custom", verification_status: null });
    const disabled = runPlannerAnalysis(
      relays(4),
      catalog([board(S3_N16R8), custom], [release()], { boardCatalogEnabled: false })
    );
    expect(disabled.evaluatedBoards.map((b) => b.boardId)).toEqual(["custom-1"]);
    expect(disabled.state).toBe("partially_ready");
    expect(disabled.plans[0]!.detailLevel).toBe("full");
    expect(codes(disabled.plans[0]!.warnings)).toContain("unverified_board_specs");

    const empty = runPlannerAnalysis(relays(4), catalog([board(S3_N16R8)], [release()], { boardCatalogEnabled: false }));
    expect(empty.state).toBe("not_supported");
    expect(empty.plans).toEqual([]);
    expect(codes(empty.warnings)).toContain("no_boards_available");
  });

  it("ranks by readiness first, then by how few controllers are needed", () => {
    const result = runPlannerAnalysis(familyHome(), catalog(allSeedBoards(), [release()]));
    const ranks = result.evaluatedBoards.map((b) => b.rank);
    expect(ranks).toEqual(ranks.map((_, i) => i + 1));

    const order = { ready: 0, partially_ready: 1, not_supported: 2 } as const;
    const readiness = result.evaluatedBoards.map((b) => order[b.readiness]);
    expect(readiness).toEqual([...readiness].sort((a, b) => a - b));

    // Among boards with identical readiness, status and firmware, fewer controllers wins.
    const partial = result.evaluatedBoards.filter((b) => b.readiness === "partially_ready");
    const counts = partial.map((b) => b.controllerCount!);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(result.evaluatedBoards[result.evaluatedBoards.length - 1]!.model).toMatch(/H2/);
  });

  it("words the verdict and the pin stage after what was actually checked", () => {
    const ready = runPlannerAnalysis(familyHome(), catalog(allSeedBoards(), [release()]));
    expect(ready.summary).toBe(
      "Everything you listed fits on 2 × Espressif ESP32-S3-DevKitC-1 N16R8, and firmware v1.2.0 is published with a USB installer."
    );
    // The pin stage counts pins only; the board without Wi-Fi still has enough of them.
    expect(ready.stages.find((stage) => stage.id === "allocation")!.detail).toBe(
      "Enough suitable pins for all 28 connections on 11 of 11 boards"
    );
    expect(ready.stats.boardsThatFit).toBe(10);

    const partial = runPlannerAnalysis(familyHome(), catalog(allSeedBoards(), []));
    expect(partial.state).toBe("partially_ready");
    expect(partial.summary).toBe(
      "Everything you listed fits on 1 × Espressif ESP32-S2-DevKitC-1, but no firmware release exists for it."
    );
  });

  it("says whether each evaluated board fits, in agreement with its readiness", () => {
    const fitOf = (result: PlannerResult, slug: string) =>
      result.evaluatedBoards.find((b) => b.boardId === `id-${slug}`)!;
    const consistent = (result: PlannerResult) => {
      for (const b of result.evaluatedBoards) {
        expect(b.fits).toBe(b.readiness !== "not_supported");
        expect(b.controllerCount === null).toBe(!b.fits);
        expect(b.summary.startsWith(`${b.fit} · `)).toBe(true);
      }
      expect(result.stats.boardsThatFit).toBe(result.evaluatedBoards.filter((b) => b.fits).length);
      // A detailed plan says the same about its board as the board table does.
      for (const plan of result.plans) {
        const row = result.evaluatedBoards.find((b) => b.boardId === plan.board.id)!;
        expect({ fits: plan.fits, fit: plan.fit }).toEqual({ fits: row.fits, fit: row.fit });
        expect(plan.fits).toBe(plan.readiness !== "not_supported");
        expect(plan.fitDetail).toMatch(/\.$/);
        expect(new Set(plan.reasons).size).toBe(plan.reasons.length);
        if (plan.fits) expect(plan.reasons[0]).toMatch(/^Connects all /);
        else expect(plan.reasons[0]).toBe(`Cannot be used as specified. ${plan.fitDetail}`);
      }
    };

    // Enough pins is not enough: a board without Wi-Fi cannot be used and is not counted.
    const normal = runPlannerAnalysis(familyHome(), catalog(allSeedBoards(), [release()]));
    consistent(normal);
    expect(normal.stats.boardsThatFit).toBe(10);
    expect(fitOf(normal, S3_N16R8)).toMatchObject({ fits: true, fit: "Fits on 2 controllers", controllerCount: 2 });
    expect(fitOf(normal, S2)).toMatchObject({ fits: true, fit: "Fits on 1 controller", controllerCount: 1 });
    expect(fitOf(normal, H2)).toMatchObject({
      fits: false,
      fit: "No Wi-Fi, cannot connect to HomecoreOS",
      controllerCount: null,
    });

    // When the installation rules every board out, no board is reported as fitting.
    const noWifi = runPlannerAnalysis(familyHome({ wifi: "none" }), catalog(allSeedBoards(), [release()]));
    consistent(noWifi);
    expect(noWifi.state).toBe("not_supported");
    expect(noWifi.stats.boardsThatFit).toBe(0);
    expect(fitOf(noWifi, S3_N16R8).fit).toBe("Enough pins, but no Wi-Fi where the controllers go");
    expect(fitOf(noWifi, H2).fit).toBe("No Wi-Fi, cannot connect to HomecoreOS");
    // The closest option leads with what rules it out, then says what it could still do.
    expect(noWifi.plans[0]!.reasons.slice(0, 2)).toEqual([
      "Cannot be used as specified. You answered that there is no Wi-Fi where the controllers will be installed, and HomecoreOS controllers connect over Wi-Fi.",
      "Connects all 28 control connections using 2 controllers.",
    ]);
    expect(normal.plans[0]!).toMatchObject({
      fits: true,
      fit: "Fits on 2 controllers",
      fitDetail: "All 28 connections have a suitable pin on 2 controllers.",
    });

    const wired = runPlannerAnalysis(familyHome({ ethernet: "required" }), catalog(allSeedBoards(), [release()]));
    consistent(wired);
    expect(wired.stats.boardsThatFit).toBe(0);
    expect(fitOf(wired, S3_N16R8).fit).toBe("Enough pins, but no Ethernet is documented for it");

    // One controller only: boards with too few pins say how much is left over.
    const single = runPlannerAnalysis(
      familyHome({ allowAdditionalControllers: false }),
      catalog(allSeedBoards(), [release()])
    );
    consistent(single);
    expect(fitOf(single, S2)).toMatchObject({ fits: true, fit: "Fits on 1 controller" });
    expect(fitOf(single, S3_N16R8).fits).toBe(false);
    expect(fitOf(single, S3_N16R8).fit).toMatch(/^\d+ of 28 connections cannot be wired$/);

    // Records that cannot be used at all.
    const broken = runPlannerAnalysis(
      familyHome(),
      catalog([
        board(S3_N16R8, { firmware_status: "unsupported" }),
        board(C3, { gpio_definitions: [] }),
        board(S2),
      ])
    );
    consistent(broken);
    expect(fitOf(broken, S3_N16R8).fit).toBe("This board is not supported");
    expect(fitOf(broken, C3).fit).toBe("No usable pin map on record");
    expect(broken.stats.boardsThatFit).toBe(1);

    // With nothing else on offer, such records are the "closest options" and explain themselves.
    const onlyBroken = runPlannerAnalysis(
      familyHome(),
      catalog([board(S3_N16R8, { firmware_status: "unsupported" }), board(H2)])
    );
    consistent(onlyBroken);
    expect(onlyBroken.state).toBe("not_supported");
    expect(onlyBroken.stats.boardsThatFit).toBe(0);
    const reasonsOf = (result: PlannerResult, slug: string) =>
      result.plans.find((plan) => plan.board.id === `id-${slug}`)!.reasons;
    expect(reasonsOf(onlyBroken, H2)[0]).toBe(
      "Cannot be used as specified. This board has no Wi-Fi, and HomecoreOS controllers connect over Wi-Fi."
    );
    // The board's own status sentence is not repeated after it was given as the blocker.
    const unsupportedReasons = reasonsOf(onlyBroken, S3_N16R8);
    expect(unsupportedReasons[0]).toBe(
      "Cannot be used as specified. This board is marked as unsupported in the Board Library."
    );
    expect(unsupportedReasons.filter((reason) => reason.includes("marked as unsupported"))).toHaveLength(1);

    const noPinMap = runPlannerAnalysis(familyHome(), catalog([board(C3, { gpio_definitions: [] })]));
    consistent(noPinMap);
    expect(reasonsOf(noPinMap, C3)[0]).toBe(
      "Cannot be used as specified. The Board Library has no complete pin map for this board, so no wiring plan could be validated."
    );
    expect(reasonsOf(noPinMap, C3).some((reason) => reason.startsWith("Connects all"))).toBe(false);

    const tooSmall = runPlannerAnalysis(
      familyHome({ allowAdditionalControllers: false }),
      catalog([board(C3)])
    );
    consistent(tooSmall);
    expect(reasonsOf(tooSmall, C3)[0]).toMatch(
      /^Cannot be used as specified\. \d+ of 28 connections could not be given a suitable pin on this board\.$/
    );
  });
});

describe("planner: warnings", () => {
  const scenarios: Array<[string, PlannerResult]> = [
    ["ready", runPlannerAnalysis(familyHome({ futureOutputs: 30 }), catalog(allSeedBoards(), [release()]))],
    ["no firmware", runPlannerAnalysis(familyHome({ wifi: "weak", environment: "outdoor" }), catalog(allSeedBoards(), []))],
    ["no wifi", runPlannerAnalysis(familyHome({ wifi: "none", ethernet: "required" }), catalog(allSeedBoards(), []))],
    ["wireless", runPlannerAnalysis(familyHome({ sensorWiring: "wireless" }), catalog(allSeedBoards(), []))],
    [
      "single controller",
      runPlannerAnalysis(relays(60, { allowAdditionalControllers: false, allowExternalRelayModules: false }), catalog(allSeedBoards(), [release()])),
    ],
    [
      "i2c + long cable",
      runPlannerAnalysis(
        home([{ name: "Lab", devices: { climate_sensors: { quantity: 4 }, gas_smoke_sensors: { quantity: 6 } } }], {
          sensorWiring: "i2c_bus",
          maxCableRunMeters: 40,
          environment: "electrical_panel",
        }),
        catalog(allSeedBoards(), [release({ status: "draft", build_status: "failed" })])
      ),
    ],
    ["incomplete", runPlannerAnalysis({}, catalog(allSeedBoards(), []))],
    [
      "ota only",
      runPlannerAnalysis(
        familyHome(),
        catalog([board(S3_N16R8)], [release({ usb_available: false, files: [{ file_type: "ota_app", validated: true }] })])
      ),
    ],
    [
      "usb only",
      runPlannerAnalysis(
        familyHome(),
        catalog([board(S3_N16R8)], [release({ ota_available: false, files: [{ file_type: "usb_factory", validated: true }] })])
      ),
    ],
    [
      "unverified",
      runPlannerAnalysis(familyHome(), catalog([board(S3_N16R8, { verification_status: "needs_verification" })], [release()])),
    ],
  ];

  const all = scenarios.flatMap(([, result]) => [...result.warnings, ...result.plans.flatMap((p) => p.warnings)]);

  it("explains every warning with severity, meaning, cause, impact and resolution", () => {
    expect(all.length).toBeGreaterThan(40);
    for (const warning of all) {
      expect(["critical", "high", "medium", "low"]).toContain(warning.severity);
      expect(["blocks_plan", "blocks_installation", "action_required", "advisory"]).toContain(warning.effect);
      for (const field of ["title", "meaning", "cause", "impact", "resolution"] as const) {
        expect(warning[field].trim().length, `${warning.code}.${field}`).toBeGreaterThan(8);
      }
      expect(warning.id.startsWith(warning.code)).toBe(true);
    }
  });

  it("covers every hardware, firmware and information risk the planner checks", () => {
    const seen = new Set(all.map((w) => w.code));
    for (const code of [
      "insufficient_gpio_channels",
      "restricted_pin_conflict",
      "insufficient_io_capacity",
      "missing_relay_hardware",
      "unsupported_sensor_interface",
      "insufficient_power_capacity",
      "missing_expansion_modules",
      "unsupported_connectivity",
      "unverified_board_specs",
      "no_compatible_firmware",
      "firmware_not_published",
      "missing_usb_artifact",
      "missing_ota_artifact",
      "incomplete_information",
      "insufficient_future_capacity",
      "mains_safety",
      "curtain_interlock",
      "life_safety_sensor",
      "stock_unknown",
    ]) {
      expect(seen.has(code as PlannerWarning["code"]), code).toBe(true);
    }
  });

  it("orders warnings from most to least serious and keeps ids unique per list", () => {
    const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    for (const [, result] of scenarios) {
      for (const list of [result.warnings, ...result.plans.map((p) => p.warnings)]) {
        const severities = list.map((w) => rank[w.severity]);
        expect(severities).toEqual([...severities].sort((a, b) => a - b));
        expect(new Set(list.map((w) => w.id)).size).toBe(list.length);
      }
    }
  });

  it("keeps serious safety warnings from blocking a plan that is otherwise ready", () => {
    const [, ready] = scenarios[0]!;
    expect(ready.state).toBe("ready");
    const mains = ready.warnings.find((w) => w.code === "mains_safety")!;
    expect(mains.severity).toBe("high");
    expect(mains.effect).toBe("action_required");
    const blocking = [...ready.warnings, ...ready.plans[0]!.warnings].filter(
      (w) => w.effect === "blocks_plan" || w.effect === "blocks_installation"
    );
    expect(blocking).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage tracking, determinism and cache invalidation
// ---------------------------------------------------------------------------

describe("planner: stage tracking", () => {
  it("reports each stage as it really starts and finishes, in order", () => {
    const events: PlannerStageEvent[] = [];
    let clock = 0;
    const tracker = new PlannerStageTracker(
      (event) => events.push(event),
      () => (clock += 5)
    );
    const result = runPlannerAnalysis(familyHome(), catalog(allSeedBoards(), [release()]), { tracker });

    expect(result.stages.map((s) => s.id)).toEqual([...PLANNER_STAGE_ORDER]);
    expect(result.stages.every((s) => s.status === "completed")).toBe(true);
    expect(result.stages.every((s) => s.durationMs === 5)).toBe(true);
    expect(result.stages.every((s) => (s.detail ?? "").length > 0)).toBe(true);

    // running → completed for every stage, never out of order.
    expect(events.map((e) => `${e.id}:${e.status}`)).toEqual(
      PLANNER_STAGE_ORDER.flatMap((id) => [`${id}:running`, `${id}:completed`])
    );
    expect(result.stages.find((s) => s.id === "board_capability")!.detail).toBe(
      "11 boards checked, 11 published and verified"
    );
    expect(result.stages.find((s) => s.id === "ranking")!.detail).toMatch(/ESP32-S3-DevKitC-1 N16R8/);
  });

  it("marks a stage as failed when its work throws, without exposing the internal error", () => {
    const events: PlannerStageEvent[] = [];
    const tracker = new PlannerStageTracker((event) => events.push(event));
    expect(() =>
      tracker.run(
        "allocation",
        () => {
          throw new Error("boom: internal detail");
        },
        () => "unused"
      )
    ).toThrow("boom: internal detail");
    expect(tracker.snapshot().find((s) => s.id === "allocation")).toMatchObject({
      status: "failed",
      detail: PLANNER_STAGE_FAILED_DETAIL,
    });
    // Stage events are streamed to the customer, so they carry the public text only.
    expect(events.map((e) => e.status)).toEqual(["running", "failed"]);
    expect(JSON.stringify(events)).not.toContain("boom");
  });
});

describe("planner: determinism", () => {
  it("produces the same recommendation for the same input every time", () => {
    const snapshot = catalog(allSeedBoards(), [release(), release({ id: "rel-2", version: "1.1.0" })]);
    const first = withoutTimings(runPlannerAnalysis(familyHome({ futureOutputs: 4 }), snapshot));
    for (let i = 0; i < 3; i++) {
      expect(withoutTimings(runPlannerAnalysis(familyHome({ futureOutputs: 4 }), snapshot))).toEqual(first);
    }
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it("does not depend on the order records arrive from the database", () => {
    const boards = allSeedBoards();
    const releases = [release(), release({ id: "rel-2", version: "1.1.0" }), release({ id: "rel-3", status: "deprecated" })];
    const first = withoutTimings(runPlannerAnalysis(familyHome(), catalog(boards, releases)));
    const shuffled = withoutTimings(
      runPlannerAnalysis(familyHome(), catalog([...boards].reverse(), [...releases].reverse()))
    );
    expect(shuffled.plans).toEqual(first.plans);
    expect(shuffled.evaluatedBoards).toEqual(first.evaluatedBoards);
    expect(shuffled.state).toBe(first.state);
  });

  it("evaluates already-normalized requirements identically", () => {
    const snapshot = catalog(allSeedBoards(), [release()]);
    const direct = evaluatePlannerCatalog(normalizePlannerRequirements(familyHome()), snapshot);
    const viaRun = runPlannerAnalysis(familyHome(), snapshot);
    expect(direct.plans).toEqual(viaRun.plans);
    expect(direct.state).toBe(viaRun.state);
  });
});

describe("planner: catalog revision", () => {
  const base = () => ({
    boards: allSeedBoards(),
    releases: [release(), release({ id: "rel-2", version: "1.1.0", status: "draft" })],
    boardCatalogEnabled: true,
    account: { existingControllers: 1, existingDevices: 4, maxControllers: 25, maxDevices: 100 },
  });
  const fingerprint = (mutate?: (snapshot: ReturnType<typeof base>) => void) => {
    const snapshot = base();
    mutate?.(snapshot);
    return buildPlannerCatalogRevisionSource(snapshot);
  };

  it("is stable when nothing changed, whatever order records come in", () => {
    expect(fingerprint()).toBe(fingerprint());
    expect(
      fingerprint((s) => {
        s.boards.reverse();
        s.releases.reverse();
        s.releases[0]!.files.reverse();
      })
    ).toBe(fingerprint());
    // Key order and absent-versus-null make no difference.
    expect(stablePlannerStringify({ b: 1, a: null, c: [{ y: 2, x: 1 }] })).toBe(
      stablePlannerStringify({ c: [{ x: 1, y: 2 }], b: 1 })
    );
  });

  it.each([
    ["a board is unpublished", (s: ReturnType<typeof base>) => { s.boards[0]!.is_available = false; }],
    ["a board loses verification", (s: ReturnType<typeof base>) => { s.boards[1]!.verification_status = "needs_verification"; }],
    ["a board's firmware status changes", (s: ReturnType<typeof base>) => { s.boards[2]!.firmware_status = "firmware_supported"; }],
    ["a pin definition changes", (s: ReturnType<typeof base>) => {
      const pins = s.boards[0]!.gpio_definitions.map((p) => ({ ...p, restrictions: { ...p.restrictions } }));
      pins[5]!.restrictions.reserved = !pins[5]!.restrictions.reserved;
      s.boards[0]!.gpio_definitions = pins;
    }],
    ["a board is added", (s: ReturnType<typeof base>) => { s.boards.push(board(S2, { id: "extra" })); }],
    ["a board is removed", (s: ReturnType<typeof base>) => { s.boards.pop(); }],
    ["a release is published", (s: ReturnType<typeof base>) => { s.releases[1]!.status = "published"; }],
    ["a release is deprecated", (s: ReturnType<typeof base>) => { s.releases[0]!.status = "deprecated"; }],
    ["a build finishes", (s: ReturnType<typeof base>) => { s.releases[1]!.build_status = "succeeded"; }],
    ["an artifact is removed", (s: ReturnType<typeof base>) => { s.releases[0]!.files = s.releases[0]!.files.slice(1); }],
    ["an artifact fails validation", (s: ReturnType<typeof base>) => { s.releases[0]!.files = s.releases[0]!.files.map((f) => ({ ...f, validated: false })); }],
    ["a release is verified on hardware", (s: ReturnType<typeof base>) => { s.releases[1]!.verified_board_slugs = [S3_N16R8]; }],
    ["a release is added", (s: ReturnType<typeof base>) => { s.releases.push(release({ id: "rel-9" })); }],
    ["the Board Library is disabled", (s: ReturnType<typeof base>) => { s.boardCatalogEnabled = false; }],
    ["the account limit changes", (s: ReturnType<typeof base>) => { s.account.maxControllers = 2; }],
    ["the account adds a controller", (s: ReturnType<typeof base>) => { s.account.existingControllers = 2; }],
  ])("changes when %s", (_label, mutate) => {
    expect(fingerprint(mutate)).not.toBe(fingerprint());
  });

  it("changes the recommendation when the catalog changes underneath a saved plan", () => {
    const before = runPlannerAnalysis(familyHome(), catalog(allSeedBoards(), [release()]));
    const after = runPlannerAnalysis(
      familyHome(),
      catalog(allSeedBoards(), [release({ status: "deprecated" })])
    );
    expect(before.state).toBe("ready");
    expect(after.state).toBe("partially_ready");
    expect(after.plans[0]!.firmware.state).toBe("deprecated");
  });
});
