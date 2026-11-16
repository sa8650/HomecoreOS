/**
 * Smart Home Planner — analysis pipeline.
 *
 * Wires the seven rule modules together. The pipeline is synchronous and
 * deterministic: the same requirements and the same catalog records always
 * produce the same recommendation. No AI, randomness or wall-clock input takes
 * part in any hardware, safety or firmware decision; the clock is only used to
 * time stages for the progress display.
 */
import { allocatePlannerChannels } from "./allocation";
import { evaluatePlannerAvailability } from "./availability";
import { evaluatePlannerBoardCapability } from "./board-capability";
import { buildPlannerExternalHardware } from "./external-hardware";
import { describePlannerInstallation, evaluatePlannerFirmware } from "./firmware";
import {
  comparePlannerPlanToBest,
  rankPlannerCandidates,
  type PlannerRankFacts,
} from "./ranking";
import { normalizePlannerRequirements } from "./requirements";
import {
  PLANNER_ENGINE_VERSION,
  PLANNER_STAGE_LABELS,
  PLANNER_STAGE_ORDER,
  type PlannerAllocation,
  type PlannerAvailability,
  type PlannerBoardCapability,
  type PlannerBoardRecord,
  type PlannerBoardSummary,
  type PlannerCandidatePlan,
  type PlannerCatalogSnapshot,
  type PlannerControllerPlan,
  type PlannerEvaluatedBoard,
  type PlannerFirmwareEvaluation,
  type PlannerNormalizedRequirements,
  type PlannerReadiness,
  type PlannerResult,
  type PlannerStage,
  type PlannerStageEvent,
  type PlannerStageId,
  type PlannerWarning,
} from "./types";
import {
  generatePlannerPlanWarnings,
  generatePlannerRequirementWarnings,
  plannerNoBoardsWarning,
  sortPlannerWarnings,
} from "./warnings";

/** Customer-facing detail for a stage that stopped unexpectedly. */
export const PLANNER_STAGE_FAILED_DETAIL = "This step could not be completed.";

/**
 * Records what each pipeline stage really did. Stage events are emitted the
 * moment a stage starts or finishes, so a progress display driven by them shows
 * actual operation states rather than a scripted animation.
 */
export class PlannerStageTracker {
  private readonly stages = new Map<PlannerStageId, PlannerStage>();
  private readonly startedAt = new Map<PlannerStageId, number>();

  constructor(
    private readonly onStage?: (event: PlannerStageEvent) => void,
    private readonly now: () => number = () => Date.now()
  ) {
    for (const id of PLANNER_STAGE_ORDER) {
      this.stages.set(id, {
        id,
        label: PLANNER_STAGE_LABELS[id],
        status: "pending",
        durationMs: null,
        detail: null,
      });
    }
  }

  private update(id: PlannerStageId, patch: Partial<PlannerStage>): void {
    const stage = { ...this.stages.get(id)!, ...patch };
    this.stages.set(id, stage);
    this.onStage?.({
      id,
      status: stage.status,
      durationMs: stage.durationMs,
      detail: stage.detail,
    });
  }

  start(id: PlannerStageId): void {
    this.startedAt.set(id, this.now());
    this.update(id, { status: "running", durationMs: null, detail: null });
  }

  private elapsed(id: PlannerStageId): number | null {
    const started = this.startedAt.get(id);
    return started === undefined ? null : Math.max(0, Math.round(this.now() - started));
  }

  complete(id: PlannerStageId, detail: string): void {
    this.update(id, { status: "completed", durationMs: this.elapsed(id), detail });
  }

  skip(id: PlannerStageId, detail: string): void {
    this.update(id, { status: "skipped", durationMs: null, detail });
  }

  fail(id: PlannerStageId, detail: string): void {
    this.update(id, { status: "failed", durationMs: this.elapsed(id), detail });
  }

  run<T>(id: PlannerStageId, work: () => T, describe: (value: T) => string): T {
    this.start(id);
    try {
      const value = work();
      this.complete(id, describe(value));
      return value;
    } catch (error) {
      // Stage details are shown to customers. The message of an unexpected error
      // is not written for them, so it travels with the rethrown error instead.
      this.fail(id, PLANNER_STAGE_FAILED_DETAIL);
      throw error;
    }
  }

  snapshot(): PlannerStage[] {
    return PLANNER_STAGE_ORDER.map((id) => ({ ...this.stages.get(id)! }));
  }
}

export interface PlannerEvaluationOptions {
  tracker?: PlannerStageTracker;
  /** Overrides the firmware's per-controller connection limit. */
  maxIoItems?: number;
  /** How many ranked plans carry full detail (recommendation + alternatives). */
  maxDetailedPlans?: number;
}

/** Whether a board can carry the plan as specified, and the deciding reason. */
interface FitVerdict {
  fits: boolean;
  /** Short form for lists, e.g. "Fits on 2 controllers". */
  label: string;
  /** One full sentence that explains the label. */
  detail: string;
}

interface Candidate {
  board: PlannerBoardRecord;
  capability: PlannerBoardCapability;
  allocation: PlannerAllocation;
  firmware: PlannerFirmwareEvaluation;
  availability: PlannerAvailability;
  fit: FitVerdict;
  readiness: PlannerReadiness;
  facts: PlannerRankFacts;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function boardName(board: PlannerBoardRecord): string {
  return `${board.manufacturer} ${board.model}`.trim();
}

function describeRequirements(requirements: PlannerNormalizedRequirements): string {
  const { totals } = requirements;
  return `${plural(totals.rooms, "room", "rooms")}, ${plural(
    totals.physicalDevices,
    "device",
    "devices"
  )}, ${plural(totals.gpioChannels, "controller connection", "controller connections")}`;
}

function summarizeRequirements(
  requirements: PlannerNormalizedRequirements
): PlannerResult["requirements"] {
  return {
    totals: requirements.totals,
    rooms: requirements.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      type: room.type,
      floor: room.floor,
      locationId: room.locationId,
      physicalDevices: room.physicalDevices,
      controlChannels: room.controlChannels,
    })),
    locations: requirements.locations,
    installation: requirements.installation,
    adjustments: requirements.adjustments,
  };
}

function relayChannelsOf(allocation: PlannerAllocation): number {
  return allocation.controllers.reduce((sum, c) => sum + c.relayChannels, 0);
}

/**
 * Decides whether a board can carry the plan as specified. This is the only
 * place that decision is made: a candidate's readiness, its row in the board
 * table, its reasons and the "boards that fit" count all read this verdict,
 * so they cannot disagree with each other.
 */
function evaluateFit(
  requirements: PlannerNormalizedRequirements,
  capability: PlannerBoardCapability,
  allocation: PlannerAllocation
): FitVerdict {
  const { installation, totals } = requirements;
  const connections = plural(totals.gpioChannels, "connection", "connections");
  const no = (label: string, detail: string): FitVerdict => ({ fits: false, label, detail });

  if (!capability.evaluable) {
    return no(
      "No usable pin map on record",
      "The Board Library has no complete pin map for this board, so no wiring plan could be validated."
    );
  }
  if (capability.status.code === "unsupported") {
    return no("This board is not supported", capability.status.detail);
  }
  if (!capability.supportsWifi) {
    return no(
      "No Wi-Fi, cannot connect to HomecoreOS",
      "This board has no Wi-Fi, and HomecoreOS controllers connect over Wi-Fi."
    );
  }
  if (!allocation.feasible) {
    const missing = allocation.unallocated.length;
    return no(
      `${missing} of ${totals.gpioChannels} connections cannot be wired`,
      `${missing} of ${connections} could not be given a suitable pin on this board.`
    );
  }
  // The board has enough pins, but the installation itself rules it out.
  if (installation.wifi === "none") {
    return no(
      "Enough pins, but no Wi-Fi where the controllers go",
      "You answered that there is no Wi-Fi where the controllers will be installed, and HomecoreOS controllers connect over Wi-Fi."
    );
  }
  if (installation.ethernet === "required") {
    return no(
      "Enough pins, but no Ethernet is documented for it",
      "You require a wired Ethernet connection, and the Board Library documents no Ethernet hardware for this board."
    );
  }
  const controllers = plural(allocation.controllers.length, "controller", "controllers");
  return {
    fits: true,
    label: `Fits on ${controllers}`,
    detail: `All ${connections} have a suitable pin on ${controllers}.`,
  };
}

function resolveReadiness(
  requirements: PlannerNormalizedRequirements,
  capability: PlannerBoardCapability,
  allocation: PlannerAllocation,
  firmware: PlannerFirmwareEvaluation,
  availability: PlannerAvailability,
  fit: FitVerdict
): PlannerReadiness {
  if (!fit.fits) return "not_supported";

  const relayOk =
    requirements.installation.allowExternalRelayModules ||
    relayChannelsOf(allocation) <= capability.onboardRelayChannels;
  const withinLimits = !availability.accountLimits.some((limit) => limit.exceeded);

  // "Ready" demands a published, verified board AND a real, published, USB-
  // installable firmware artifact validated for it. A board that merely could
  // run HomecoreOS is never presented as ready to install.
  return capability.status.code === "published" &&
    firmware.installable &&
    firmware.validatedForBoard &&
    relayOk &&
    withinLimits
    ? "ready"
    : "partially_ready";
}

/** The single most important reason a hardware-feasible plan is not yet ready. */
function describeGap(candidate: Candidate, requirements: PlannerNormalizedRequirements): string {
  const { capability, firmware, availability, allocation } = candidate;
  if (capability.status.code === "unverified") {
    return capability.status.isCustom
      ? "it is a custom board whose specifications HomecoreOS has not verified"
      : "the board's specifications are not verified yet";
  }
  if (capability.status.code === "unpublished") return "the board is not published in the catalog";
  if (firmware.state === "no_compatible_release") return "no firmware release exists for it";
  if (!firmware.published) return `its firmware is not published (${firmware.label.toLowerCase()})`;
  if (!firmware.usbFactoryAvailable) return "the published firmware has no USB factory image";
  if (!firmware.validatedForBoard) return "its firmware has not been verified on this board";
  if (
    !requirements.installation.allowExternalRelayModules &&
    relayChannelsOf(allocation) > capability.onboardRelayChannels
  ) {
    return "no board with built-in relays is available";
  }
  if (availability.accountLimits.some((limit) => limit.exceeded)) {
    return "the plan exceeds your account limits";
  }
  return "some requirements are still incomplete";
}

function buildReasons(
  candidate: Candidate,
  requirements: PlannerNormalizedRequirements,
  best: Candidate | null
): string[] {
  const { capability, allocation, firmware, fit } = candidate;
  const total = requirements.totals.gpioChannels;
  const reasons: string[] = [];
  /** Adds a sentence unless an earlier reason already says it. */
  const add = (reason: string) => {
    if (!reasons.some((earlier) => earlier.includes(reason))) reasons.push(reason);
  };

  // What rules a board out is said first, then what it could still do.
  if (!fit.fits) add(`Cannot be used as specified. ${fit.detail}`);
  if (allocation.feasible) {
    add(
      `Connects all ${plural(total, "control connection", "control connections")} using ${plural(
        allocation.controllers.length,
        "controller",
        "controllers"
      )}.`
    );
  }

  add(capability.status.detail);
  add(firmware.detail);
  add(
    firmware.installable
      ? "A new board can be installed over USB from Firmware & Updates."
      : "It cannot be installed through HomecoreOS yet."
  );
  if (allocation.feasible) {
    add(
      `Leaves ${plural(allocation.spare.pins, "spare pin", "spare pins")}: room for up to ${plural(
        allocation.spare.outputs,
        "more output",
        "more outputs"
      )} or ${plural(allocation.spare.inputs, "more sensor input", "more sensor inputs")}.`
    );
  }
  if (best && best !== candidate) {
    for (const difference of comparePlannerPlanToBest(candidate.facts, best.facts)) add(difference);
  }
  return reasons;
}

function summarizeBoard(candidate: Candidate, full: boolean): PlannerBoardSummary {
  const { board, capability } = candidate;
  return {
    id: board.id,
    source: board.source,
    slug: full ? board.slug : null,
    manufacturer: board.manufacturer,
    model: board.model,
    revision: full ? board.revision : null,
    chipLabel: capability.chipLabel,
    chipVariant: full ? board.chip_variant : null,
    memory: full ? capability.memory : null,
    wireless: full ? capability.wireless : null,
    docsUrl: full ? (board.docs_url ?? null) : null,
  };
}

/** Pin-level data is withheld for boards customers cannot see in the Board Library. */
function redactControllers(controllers: PlannerControllerPlan[]): PlannerControllerPlan[] {
  return controllers.map((controller) => ({ ...controller, assignments: [], i2cBus: null }));
}

function buildPlan(
  candidate: Candidate,
  rank: number,
  requirements: PlannerNormalizedRequirements,
  best: Candidate | null,
  warnings: PlannerWarning[]
): PlannerCandidatePlan {
  const { board, capability, allocation, firmware, availability } = candidate;
  // Customers may see full detail only for boards the Board Library already shows
  // them: published catalog boards and their own custom boards.
  const full = capability.status.code === "published" || board.source === "custom";

  return {
    rank,
    board: summarizeBoard(candidate, full),
    readiness: candidate.readiness,
    fits: candidate.fit.fits,
    fit: candidate.fit.label,
    fitDetail: candidate.fit.detail,
    detailLevel: full ? "full" : "summary",
    boardStatus: capability.status,
    firmware,
    installation: describePlannerInstallation(firmware),
    availability,
    controllerCount: allocation.controllers.length,
    controllers: full ? allocation.controllers : redactControllers(allocation.controllers),
    unallocated: allocation.unallocated,
    capability: {
      ...capability.counts,
      maxIoItems: capability.maxIoItems,
      powerRails: capability.powerRails,
      supportsWifi: capability.supportsWifi,
      supportsBle: capability.supportsBle,
      restrictedPins: full
        ? capability.pins
            .filter((p) => p.tier === "restricted")
            .map((p) => ({ pin: p.pin, label: p.label, reason: p.reasons[0] ?? "Held back" }))
        : [],
    },
    externalHardware: buildPlannerExternalHardware(requirements, allocation),
    expansion: { ...allocation.future, spare: allocation.spare },
    reasons: buildReasons(candidate, requirements, best),
    warnings,
  };
}

function summarizeEvaluatedBoard(candidate: Candidate, rank: number): PlannerEvaluatedBoard {
  const { board, capability, allocation, firmware, fit } = candidate;

  return {
    boardId: board.id,
    manufacturer: board.manufacturer,
    model: board.model,
    chipLabel: capability.chipLabel,
    source: board.source,
    boardStatus: capability.status,
    firmwareState: firmware.state,
    firmwareLabel: firmware.label,
    usbFactoryAvailable: firmware.usbFactoryAvailable,
    otaAvailable: firmware.otaAvailable,
    fits: fit.fits,
    fit: fit.label,
    controllerCount: fit.fits ? allocation.controllers.length : null,
    readiness: candidate.readiness,
    rank,
    summary: `${fit.label} · ${capability.status.label} · Firmware: ${firmware.label.toLowerCase()}`,
  };
}

/** Result for requirements that are missing essential answers. No catalog needed. */
export function buildIncompletePlannerResult(
  requirements: PlannerNormalizedRequirements,
  options?: { tracker?: PlannerStageTracker; catalogRevision?: string | null }
): PlannerResult {
  const tracker = options?.tracker ?? new PlannerStageTracker();
  const reason = "Skipped: more information is needed first";
  for (const stage of tracker.snapshot()) {
    if (stage.status === "pending") tracker.skip(stage.id, reason);
  }
  const blocking = requirements.missing.filter((m) => m.blocking);

  return {
    engineVersion: PLANNER_ENGINE_VERSION,
    state: "incomplete",
    headline: "More information needed",
    summary:
      blocking[0]?.message ??
      "A few answers are still missing before hardware can be recommended.",
    catalogRevision: options?.catalogRevision ?? null,
    requirements: summarizeRequirements(requirements),
    missingInformation: requirements.missing,
    plans: [],
    evaluatedBoards: [],
    warnings: sortPlannerWarnings(generatePlannerRequirementWarnings(requirements)),
    stats: {
      boardsEvaluated: 0,
      boardsThatFit: 0,
      firmwareReleasesEvaluated: 0,
      publishedFirmwareReleases: 0,
    },
    stages: tracker.snapshot(),
  };
}

/** Evaluates complete requirements against the admin-managed catalog. */
export function evaluatePlannerCatalog(
  requirements: PlannerNormalizedRequirements,
  catalog: PlannerCatalogSnapshot,
  options?: PlannerEvaluationOptions
): PlannerResult {
  const tracker = options?.tracker ?? new PlannerStageTracker();
  if (!requirements.complete) {
    return buildIncompletePlannerResult(requirements, {
      tracker,
      catalogRevision: catalog.revision,
    });
  }

  // When the administrator switches the Board Library off, catalog boards are
  // not offered to customers anywhere, so the planner does not offer them either.
  const boards = catalog.boardCatalogEnabled
    ? catalog.boards
    : catalog.boards.filter((board) => board.source === "custom");
  const releases = catalog.releases;

  const capabilities = tracker.run(
    "board_capability",
    () =>
      boards.map((board) =>
        evaluatePlannerBoardCapability(board, { maxIoItems: options?.maxIoItems })
      ),
    (list) =>
      `${plural(list.length, "board", "boards")} checked, ${
        list.filter((c) => c.status.code === "published").length
      } published and verified`
  );

  const allocations = tracker.run(
    "allocation",
    () => capabilities.map((capability) => allocatePlannerChannels(requirements, capability)),
    (list) =>
      // A statement about pins only. Whether a board can really be used also
      // depends on its connectivity, which the ranking stage weighs.
      `Enough suitable pins for all ${plural(
        requirements.totals.gpioChannels,
        "connection",
        "connections"
      )} on ${list.filter((a) => a.feasible).length} of ${plural(list.length, "board", "boards")}`
  );

  const firmwares = tracker.run(
    "firmware_compatibility",
    () => boards.map((board) => evaluatePlannerFirmware(board, releases)),
    (list) =>
      `${plural(releases.length, "release", "releases")} checked, ${
        list.filter((f) => f.installable).length
      } of ${plural(list.length, "board", "boards")} can be installed over USB`
  );

  const availabilities = tracker.run(
    "availability",
    () =>
      boards.map((board, i) =>
        evaluatePlannerAvailability({
          board,
          boardStatus: capabilities[i]!.status,
          controllers: allocations[i]!.controllers,
          account: catalog.account,
        })
      ),
    (list) => {
      const known = list.filter((a) => a.stock.status !== "unknown").length;
      return known === 0
        ? "Catalog status read; no stock or price data is recorded"
        : `Catalog status read; stock recorded for ${plural(known, "board", "boards")}`;
    }
  );

  const ranked = tracker.run(
    "ranking",
    () => {
      const candidates: Candidate[] = boards.map((board, i) => {
        const capability = capabilities[i]!;
        const allocation = allocations[i]!;
        const firmware = firmwares[i]!;
        const availability = availabilities[i]!;
        const fit = evaluateFit(requirements, capability, allocation);
        const readiness = resolveReadiness(
          requirements,
          capability,
          allocation,
          firmware,
          availability,
          fit
        );
        return {
          board,
          capability,
          allocation,
          firmware,
          availability,
          fit,
          readiness,
          facts: {
            boardId: board.id,
            label: boardName(board),
            catalogCategory: board.source === "custom" ? "custom" : (board.catalog_category ?? null),
            readiness,
            fits: allocation.feasible,
            unallocated: allocation.unallocated.length,
            boardStatus: capability.status.code,
            firmwareState: firmware.state,
            installable: firmware.installable,
            validatedForBoard: firmware.validatedForBoard,
            otaAvailable: firmware.otaAvailable,
            controllerCount: allocation.controllers.length,
            futureSatisfied: allocation.future.satisfied,
            sparePins: allocation.spare.pins,
          },
        };
      });
      return rankPlannerCandidates(candidates);
    },
    (list) => {
      const top = list[0];
      if (!top) return "No boards to rank";
      return top.readiness === "not_supported"
        ? "No board satisfies every requirement"
        : `Best match: ${boardName(top.board)}`;
    }
  );

  const qualifying = ranked.filter((c) => c.readiness !== "not_supported");
  const maxPlans = Math.max(1, options?.maxDetailedPlans ?? 4);
  // With nothing qualifying, the closest options are still shown so the customer
  // can see exactly what is missing.
  const shown = qualifying.length > 0 ? qualifying.slice(0, maxPlans) : ranked.slice(0, 2);
  const best = qualifying[0] ?? null;

  const { plans, globalWarnings } = tracker.run(
    "warnings",
    () => {
      const global = generatePlannerRequirementWarnings(requirements);
      if (boards.length === 0) global.push(plannerNoBoardsWarning(catalog.boardCatalogEnabled));
      const built = shown.map((candidate, i) =>
        buildPlan(
          candidate,
          i + 1,
          requirements,
          best,
          sortPlannerWarnings(
            generatePlannerPlanWarnings({
              requirements,
              board: candidate.board,
              capability: candidate.capability,
              allocation: candidate.allocation,
              firmware: candidate.firmware,
              availability: candidate.availability,
            })
          )
        )
      );
      return { plans: built, globalWarnings: sortPlannerWarnings(global) };
    },
    (value) => {
      const all = [...value.globalWarnings, ...(value.plans[0]?.warnings ?? [])];
      const serious = all.filter((w) => w.severity === "critical" || w.severity === "high").length;
      return `${plural(all.length, "note", "notes")} for the recommended plan, ${serious} needing attention`;
    }
  );

  let state: PlannerResult["state"];
  let headline: string;
  let summary: string;

  if (best) {
    const count = best.allocation.controllers.length;
    const subject = `${count} × ${boardName(best.board)}`;
    state = best.readiness;
    if (best.readiness === "ready") {
      const version = best.firmware.release?.version.replace(/^v/i, "") ?? "";
      headline = "Ready to install";
      summary = `Everything you listed fits on ${subject}, and firmware v${version} is published with a USB installer.`;
    } else {
      headline = "Partially ready";
      summary = `Everything you listed fits on ${subject}, but ${describeGap(best, requirements)}.`;
    }
  } else {
    state = "not_supported";
    headline = "Not supported";
    const blocker = globalWarnings.find((w) => w.effect === "blocks_plan");
    summary =
      boards.length === 0
        ? "There are no boards in the Board Library to evaluate."
        : blocker
          ? `${blocker.title}. No validated configuration satisfies these requirements as specified.`
          : "No verified board configuration in HomecoreOS fits everything you listed as specified.";
  }

  return {
    engineVersion: PLANNER_ENGINE_VERSION,
    state,
    headline,
    summary,
    catalogRevision: catalog.revision,
    requirements: summarizeRequirements(requirements),
    missingInformation: requirements.missing,
    plans,
    evaluatedBoards: ranked.map((candidate, i) => summarizeEvaluatedBoard(candidate, i + 1)),
    warnings: globalWarnings,
    stats: {
      boardsEvaluated: boards.length,
      boardsThatFit: ranked.filter((c) => c.fit.fits).length,
      firmwareReleasesEvaluated: releases.length,
      publishedFirmwareReleases: releases.filter((r) => r.status === "published").length,
    },
    stages: tracker.snapshot(),
  };
}

/**
 * Convenience entry point: normalize raw wizard input and evaluate it against a
 * catalog snapshot that is already in memory.
 */
export function runPlannerAnalysis(
  rawRequirements: unknown,
  catalog: PlannerCatalogSnapshot,
  options?: PlannerEvaluationOptions
): PlannerResult {
  const tracker = options?.tracker ?? new PlannerStageTracker();
  const requirements = tracker.run(
    "requirements",
    () => normalizePlannerRequirements(rawRequirements),
    describeRequirements
  );
  if (!requirements.complete) {
    return buildIncompletePlannerResult(requirements, {
      tracker,
      catalogRevision: catalog.revision,
    });
  }
  // The snapshot was loaded by the caller; record what it contained.
  tracker.start("load_boards");
  tracker.complete("load_boards", `${plural(catalog.boards.length, "board", "boards")} in the Board Library`);
  tracker.start("load_firmware");
  tracker.complete(
    "load_firmware",
    `${plural(catalog.releases.length, "firmware release", "firmware releases")} on record`
  );
  return evaluatePlannerCatalog(requirements, catalog, { ...options, tracker });
}

export { describeRequirements as describePlannerRequirements };
