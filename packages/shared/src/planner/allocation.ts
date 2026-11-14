/**
 * Smart Home Planner — (3) GPIO and device allocation.
 *
 * Packs the customer's control channels onto as few controllers as possible at
 * each installation location, then gives every channel a concrete pin.
 *
 * Whether a set of channels fits a board is answered exactly, with bipartite
 * matching (channels on one side, assignable pins on the other), not by counting
 * pins: an ADC sensor and a relay may compete for the same pin, and only a
 * matching proves that every channel can have a pin of the right kind at once.
 */
import { PLANNER_PIN_DEMANDS } from "./board-capability";
import {
  PLANNER_I2C_CLIMATE_SENSORS_PER_BUS,
  type PlannerAllocation,
  type PlannerAllocationPressure,
  type PlannerBoardCapability,
  type PlannerChannel,
  type PlannerControllerPlan,
  type PlannerControllerRoomSummary,
  type PlannerFutureCapacity,
  type PlannerHomecoreMapping,
  type PlannerNormalizedRequirements,
  type PlannerPinAssignment,
  type PlannerPinDemand,
  type PlannerSpareCapacity,
  type PlannerUnallocatedChannel,
  type PlannerUnallocatedReason,
} from "./types";

const DEMAND_LABELS: Record<PlannerPinDemand | "i2c_bus", string> = {
  digital_out: "an on/off output pin",
  pwm: "a PWM-capable output pin",
  digital_in: "a digital input pin",
  contact_in: "an input pin with a pull-up resistor",
  adc: "an analog (ADC) input pin",
  i2c: "an I2C-capable pin",
  i2c_bus: "the I2C sensor bus",
};

export function describePlannerDemand(demand: PlannerPinDemand | "i2c_bus"): string {
  return DEMAND_LABELS[demand];
}

/** Which kind of pin a channel needs, derived from the existing validator requirement. */
export function plannerChannelDemand(channel: PlannerChannel): PlannerPinDemand | "i2c_bus" {
  if (channel.kind === "i2c_sensor" || channel.requirement === "i2c") return "i2c_bus";
  switch (channel.requirement) {
    case "pwm":
      return "pwm";
    case "adc":
      return "adc";
    case "digital_out":
      return "digital_out";
    case "digital_in":
    case "pull_up":
    case "pull_down":
    default:
      return channel.requirePullUp ? "contact_in" : "digital_in";
  }
}

const FALLBACK_SENSOR_MAPPING: PlannerHomecoreMapping = {
  entity: "sensor",
  type: "temperature_dht22",
  label: "Sensor · Temperature & humidity (DHT22)",
};

// ---------------------------------------------------------------------------
// Board-independent preparation (done once per set of requirements)
// ---------------------------------------------------------------------------

/** A group of channels that must be placed together, with its demands precomputed. */
interface Unit {
  channels: PlannerChannel[];
  /** Pin demands of the channels that take their own pin. */
  demands: PlannerPinDemand[];
  /** Sensors that would prefer the shared I2C bus. */
  busCandidates: number;
}

interface PreparedRoom {
  units: Unit[];
  /** All of the room's units merged, for placing a room in one move. */
  whole: Unit;
}

interface PreparedLocation {
  id: string;
  name: string;
  /** Wireable atomic units in display order. */
  units: Unit[];
  /** The same units grouped by room, largest room first. */
  roomsBySize: PreparedRoom[];
  /** Channels using a connection type HomecoreOS cannot read. */
  unsupported: PlannerChannel[];
}

interface Prepared {
  locations: PreparedLocation[];
  /** Display order: by floor, then room, then the order devices were listed. */
  channelOrder: Map<string, number>;
  floorByRoom: Map<string, number>;
}

function makeUnit(channels: PlannerChannel[]): Unit {
  const demands: PlannerPinDemand[] = [];
  let busCandidates = 0;
  for (const channel of channels) {
    const demand = plannerChannelDemand(channel);
    if (demand === "i2c_bus") busCandidates += 1;
    else demands.push(demand);
  }
  return { channels, demands, busCandidates };
}

function mergeUnits(units: Unit[]): Unit {
  const channels: PlannerChannel[] = [];
  const demands: PlannerPinDemand[] = [];
  let busCandidates = 0;
  for (const unit of units) {
    channels.push(...unit.channels);
    demands.push(...unit.demands);
    busCandidates += unit.busCandidates;
  }
  return { channels, demands, busCandidates };
}

const PREPARED = new WeakMap<PlannerNormalizedRequirements, Prepared>();

function prepare(requirements: PlannerNormalizedRequirements): Prepared {
  const cached = PREPARED.get(requirements);
  if (cached) return cached;

  const roomRank = new Map<string, number>();
  requirements.rooms
    .map((room, index) => ({ room, index }))
    .sort((a, b) => a.room.floor - b.room.floor || a.index - b.index)
    .forEach((entry, position) => roomRank.set(entry.room.id, position));

  const ordered = requirements.channels
    .map((channel, index) => ({ channel, index }))
    .sort(
      (a, b) =>
        (roomRank.get(a.channel.roomId) ?? 0) - (roomRank.get(b.channel.roomId) ?? 0) ||
        a.index - b.index
    )
    .map((entry) => entry.channel);

  const channelOrder = new Map<string, number>();
  ordered.forEach((channel, position) => channelOrder.set(channel.id, position));

  const locations: PreparedLocation[] = requirements.locations.map((location) => {
    const unsupported: PlannerChannel[] = [];
    const groups: PlannerChannel[][] = [];
    const groupIndex = new Map<string, number>();

    for (const channel of ordered) {
      if (channel.locationId !== location.id) continue;
      if (channel.unsupportedInterface) {
        unsupported.push(channel);
        continue;
      }
      if (channel.atomicGroup) {
        const existing = groupIndex.get(channel.atomicGroup);
        if (existing !== undefined) {
          groups[existing]!.push(channel);
          continue;
        }
        groupIndex.set(channel.atomicGroup, groups.length);
      }
      groups.push([channel]);
    }
    const units = groups.map(makeUnit);

    const rooms: Array<{ units: Unit[]; size: number; index: number }> = [];
    const roomIndex = new Map<string, number>();
    for (const unit of units) {
      const key = unit.channels[0]!.roomId;
      let position = roomIndex.get(key);
      if (position === undefined) {
        position = rooms.length;
        roomIndex.set(key, position);
        rooms.push({ units: [], size: 0, index: position });
      }
      rooms[position]!.units.push(unit);
      rooms[position]!.size += unit.channels.length;
    }

    return {
      id: location.id,
      name: location.name,
      units,
      // Largest rooms first: the classic way to balance bins.
      roomsBySize: rooms
        .sort((a, b) => b.size - a.size || a.index - b.index)
        .map((room) => ({ units: room.units, whole: mergeUnits(room.units) })),
      unsupported,
    };
  });

  const prepared: Prepared = {
    locations,
    channelOrder,
    floorByRoom: new Map(requirements.rooms.map((room) => [room.id, room.floor])),
  };
  PREPARED.set(requirements, prepared);
  return prepared;
}

// ---------------------------------------------------------------------------
// Exact pin matching
// ---------------------------------------------------------------------------

/** Scratch space shared by every matcher of one board; searches never overlap. */
interface MatchScratch {
  visited: number[];
  generation: number;
}

/**
 * Incremental maximum bipartite matching (Kuhn's algorithm). Adding one item
 * searches for a single augmenting path and leaves the matcher untouched when
 * none exists, so a tentative placement of one channel costs nothing to discard.
 */
class PinMatcher {
  private constructor(
    private readonly pinsFor: Record<PlannerPinDemand, number[]>,
    private readonly scratch: MatchScratch,
    /** pin number -> index of the item holding it, or -1 when free. */
    private readonly pinOwner: number[],
    private readonly itemPin: number[],
    private readonly itemDemand: PlannerPinDemand[]
  ) {}

  static create(pinsFor: Record<PlannerPinDemand, number[]>, scratch: MatchScratch): PinMatcher {
    return new PinMatcher(pinsFor, scratch, new Array<number>(scratch.visited.length).fill(-1), [], []);
  }

  clone(): PinMatcher {
    return new PinMatcher(
      this.pinsFor,
      this.scratch,
      this.pinOwner.slice(),
      this.itemPin.slice(),
      this.itemDemand.slice()
    );
  }

  get size(): number {
    return this.itemPin.length;
  }

  pinOf(index: number): number {
    return this.itemPin[index] ?? -1;
  }

  /** Returns the new item's index, or -1 (state unchanged) when it cannot be matched. */
  add(demand: PlannerPinDemand): number {
    const index = this.itemPin.length;
    this.itemPin.push(-1);
    this.itemDemand.push(demand);
    this.scratch.generation += 1;
    if (this.augment(index)) return index;
    this.itemPin.pop();
    this.itemDemand.pop();
    return -1;
  }

  // Ownership is only rewritten once a complete augmenting path is known to
  // exist, so a failed search never leaves a half-applied change behind.
  private augment(item: number): boolean {
    const candidates = this.pinsFor[this.itemDemand[item]!];
    const { visited } = this.scratch;
    const stamp = this.scratch.generation;
    // Take the most preferred pin that is still free before disturbing anyone:
    // this keeps pin plans in a natural, predictable order.
    for (let i = 0; i < candidates.length; i++) {
      const pin = candidates[i]!;
      if (visited[pin] === stamp || this.pinOwner[pin] !== -1) continue;
      visited[pin] = stamp;
      this.pinOwner[pin] = item;
      this.itemPin[item] = pin;
      return true;
    }
    // Otherwise ask a current owner to move somewhere else.
    for (let i = 0; i < candidates.length; i++) {
      const pin = candidates[i]!;
      if (visited[pin] === stamp) continue;
      visited[pin] = stamp;
      const owner = this.pinOwner[pin]!;
      if (owner !== -1 && this.augment(owner)) {
        this.pinOwner[pin] = item;
        this.itemPin[item] = pin;
        return true;
      }
    }
    return false;
  }
}

interface DraftController {
  locationId: string;
  channels: PlannerChannel[];
  matcher: PinMatcher;
  ioItems: number;
  busSensors: number;
}

interface UnitShape {
  demands: PlannerPinDemand[];
  ioItems: number;
  busSensors: number;
}

/** The pins a unit would occupy on a controller that already carries `busSensorsAlready`. */
function shapeUnit(unit: Unit, busSensorsAlready: number): UnitShape {
  if (unit.busCandidates === 0) {
    return { demands: unit.demands, ioItems: unit.demands.length, busSensors: 0 };
  }
  const demands = [...unit.demands];
  let ioItems = unit.demands.length;
  let busSensors = 0;
  for (let i = 0; i < unit.busCandidates; i++) {
    if (busSensorsAlready + busSensors < PLANNER_I2C_CLIMATE_SENSORS_PER_BUS) {
      // The first sensor on a controller brings the two shared bus wires with it.
      if (busSensorsAlready + busSensors === 0) demands.push("i2c", "i2c");
      busSensors += 1;
    } else {
      // The bus is full: plan this sensor on its own single-wire input instead.
      demands.push("digital_in");
      ioItems += 1;
    }
  }
  return { demands, ioItems, busSensors };
}

interface BoardContext {
  capability: PlannerBoardCapability;
  maxIoItems: number;
  usablePins: number;
  scratch: MatchScratch;
}

function emptyDraft(locationId: string, ctx: BoardContext): DraftController {
  return {
    locationId,
    channels: [],
    matcher: PinMatcher.create(ctx.capability.pinsFor, ctx.scratch),
    ioItems: 0,
    busSensors: 0,
  };
}

function tryPlace(draft: DraftController, unit: Unit, ctx: BoardContext): boolean {
  const shape = shapeUnit(unit, draft.busSensors);
  if (draft.ioItems + shape.ioItems > ctx.maxIoItems) return false;
  // Cheap rejection before any matching work: not enough pins left at all.
  if (draft.matcher.size + shape.demands.length > ctx.usablePins) return false;

  if (shape.demands.length === 1) {
    // A single add is atomic, so nothing needs to be copied or rolled back.
    if (draft.matcher.add(shape.demands[0]!) < 0) return false;
  } else {
    const trial = draft.matcher.clone();
    for (let i = 0; i < shape.demands.length; i++) {
      if (trial.add(shape.demands[i]!) < 0) return false;
    }
    draft.matcher = trial;
  }
  for (const channel of unit.channels) draft.channels.push(channel);
  draft.ioItems += shape.ioItems;
  draft.busSensors += shape.busSensors;
  return true;
}

/** Tries controllers from least to most loaded, without sorting or allocating. */
function placeOnLeastLoaded(drafts: DraftController[], unit: Unit, ctx: BoardContext): boolean {
  let lastLoad = -1;
  let lastIndex = -1;
  for (let attempt = 0; attempt < drafts.length; attempt++) {
    let pick = -1;
    let pickLoad = 0;
    for (let i = 0; i < drafts.length; i++) {
      const load = drafts[i]!.matcher.size;
      const afterLast = load > lastLoad || (load === lastLoad && i > lastIndex);
      if (afterLast && (pick === -1 || load < pickLoad)) {
        pick = i;
        pickLoad = load;
      }
    }
    if (pick === -1) return false;
    if (tryPlace(drafts[pick]!, unit, ctx)) return true;
    lastLoad = pickLoad;
    lastIndex = pick;
  }
  return false;
}

/**
 * First-fit finds how few controllers a location needs, but it fills the first
 * one to the brim and splits rooms at the boundary. Once the count is known,
 * this spreads whole rooms across that same number of controllers so each keeps
 * headroom and a room's devices stay together where possible. Returns null when
 * the even spread does not fit, in which case the first-fit plan is kept.
 */
function rebalance(
  controllerCount: number,
  location: PreparedLocation,
  ctx: BoardContext
): DraftController[] | null {
  if (controllerCount <= 1) return null;
  const drafts = Array.from({ length: controllerCount }, () => emptyDraft(location.id, ctx));

  for (const room of location.roomsBySize) {
    if (placeOnLeastLoaded(drafts, room.whole, ctx)) continue;
    for (const unit of room.units) {
      if (!placeOnLeastLoaded(drafts, unit, ctx)) return null;
    }
  }
  return drafts.filter((draft) => draft.channels.length > 0);
}

function rawPinSupports(
  pin: PlannerBoardCapability["pins"][number],
  demand: PlannerPinDemand
): boolean {
  switch (demand) {
    case "digital_out":
      return pin.digitalOut;
    case "pwm":
      return pin.pwm;
    case "digital_in":
      return pin.digitalIn;
    case "contact_in":
      return pin.digitalIn && pin.pullUp;
    case "adc":
      return pin.adc;
    case "i2c":
      return pin.i2c;
  }
}

interface FinalizedController {
  assignments: PlannerPinAssignment[];
  i2cBus: { sda: number; scl: number; sensors: number } | null;
  pinsUsed: number;
  fallbackSensors: number;
}

/**
 * Re-solves one controller from scratch, most constrained channel first, so the
 * published pin plan is stable and does not depend on packing order.
 */
function finalizeController(draft: DraftController, ctx: BoardContext): FinalizedController {
  const { capability } = ctx;
  interface Slot {
    channel: PlannerChannel | null;
    demand: PlannerPinDemand;
    role: "channel" | "fallback" | "sda" | "scl";
  }
  const slots: Slot[] = [];
  const busChannels: PlannerChannel[] = [];

  for (const channel of draft.channels) {
    const demand = plannerChannelDemand(channel);
    if (demand === "i2c_bus") {
      if (busChannels.length < PLANNER_I2C_CLIMATE_SENSORS_PER_BUS) {
        busChannels.push(channel);
      } else {
        slots.push({ channel, demand: "digital_in", role: "fallback" });
      }
    } else {
      slots.push({ channel, demand, role: "channel" });
    }
  }
  if (busChannels.length > 0) {
    slots.push({ channel: null, demand: "i2c", role: "sda" });
    slots.push({ channel: null, demand: "i2c", role: "scl" });
  }

  const order = slots
    .map((slot, index) => ({ demand: slot.demand, index }))
    .sort(
      (a, b) =>
        capability.pinsFor[a.demand].length - capability.pinsFor[b.demand].length ||
        a.index - b.index
    );

  const matcher = PinMatcher.create(capability.pinsFor, ctx.scratch);
  const itemBySlot = new Array<number>(slots.length);
  for (const entry of order) {
    const item = matcher.add(entry.demand);
    if (item < 0) {
      // Packing already proved these demands can all be matched, and a maximum
      // matching does not depend on insertion order. Failing loudly beats
      // publishing a pin plan that was never proven.
      throw new Error("Planner invariant violated: controller pin plan could not be re-solved.");
    }
    itemBySlot[entry.index] = item;
  }

  const pinInfo = new Map(capability.pins.map((p) => [p.pin, p]));
  const assignments: PlannerPinAssignment[] = [];
  let sda = -1;
  let scl = -1;
  let fallbackSensors = 0;

  slots.forEach((slot, index) => {
    const pin = matcher.pinOf(itemBySlot[index]!);
    if (slot.role === "sda") {
      sda = pin;
      return;
    }
    if (slot.role === "scl") {
      scl = pin;
      return;
    }
    const channel = slot.channel!;
    const info = pinInfo.get(pin);
    const notes: string[] = [];
    if (info?.tier === "shared") notes.push(...info.reasons);
    if (slot.role === "fallback") {
      fallbackSensors += 1;
      notes.push(
        `Planned as a single-wire sensor: the I2C bus carries only ${PLANNER_I2C_CLIMATE_SENSORS_PER_BUS} of these sensors per controller.`
      );
    }
    assignments.push({
      channelId: channel.id,
      roomId: channel.roomId,
      roomName: channel.roomName,
      category: channel.category,
      label: channel.label,
      kind: slot.role === "fallback" ? "digital_input" : channel.kind,
      pin,
      pinLabel: info?.label ?? `GPIO${pin}`,
      boardPinName: info?.boardPinName ?? null,
      demand: slot.demand,
      physicalDevices: channel.physicalDevices,
      homecore: slot.role === "fallback" ? FALLBACK_SENSOR_MAPPING : channel.homecore,
      needsRelay: channel.needsRelay,
      notes,
    });
  });

  for (const channel of busChannels) {
    assignments.push({
      channelId: channel.id,
      roomId: channel.roomId,
      roomName: channel.roomName,
      category: channel.category,
      label: channel.label,
      kind: channel.kind,
      pin: null,
      pinLabel: `I2C bus (SDA GPIO${sda}, SCL GPIO${scl})`,
      boardPinName: null,
      demand: "i2c_bus",
      physicalDevices: channel.physicalDevices,
      homecore: channel.homecore,
      needsRelay: false,
      notes:
        busChannels.length > 1
          ? ["Shares the two I2C bus wires with the other bus sensor on this controller."]
          : ["Uses the controller's two I2C bus wires."],
    });
  }

  return {
    assignments,
    i2cBus: busChannels.length > 0 ? { sda, scl, sensors: busChannels.length } : null,
    pinsUsed: slots.length,
    fallbackSensors,
  };
}

function countAdditional(draft: DraftController, demand: PlannerPinDemand, ctx: BoardContext): number {
  const trial = draft.matcher.clone();
  let added = 0;
  while (draft.ioItems + added < ctx.maxIoItems && trial.add(demand) >= 0) added += 1;
  return added;
}

function summarizeRooms(
  assignments: PlannerPinAssignment[],
  floorByRoom: Map<string, number>
): PlannerControllerRoomSummary[] {
  const rooms = new Map<string, PlannerControllerRoomSummary>();
  for (const a of assignments) {
    let summary = rooms.get(a.roomId);
    if (!summary) {
      summary = {
        roomId: a.roomId,
        roomName: a.roomName,
        floor: floorByRoom.get(a.roomId) ?? 1,
        channels: 0,
        physicalDevices: 0,
        byCategory: {},
      };
      rooms.set(a.roomId, summary);
    }
    summary.channels += 1;
    summary.physicalDevices += a.physicalDevices;
    summary.byCategory[a.category] = (summary.byCategory[a.category] ?? 0) + 1;
  }
  return Array.from(rooms.values());
}

export function allocatePlannerChannels(
  requirements: PlannerNormalizedRequirements,
  capability: PlannerBoardCapability
): PlannerAllocation {
  const { installation } = requirements;
  const unallocated: PlannerUnallocatedChannel[] = [];
  const pressure: PlannerAllocationPressure = {
    gpioShortage: false,
    ioItemLimit: false,
    capabilityShortage: [],
    restrictedPinsWithheld: false,
    singleControllerLimit: false,
    i2cFallbackSensors: 0,
  };

  const reject = (channel: PlannerChannel, reason: PlannerUnallocatedReason, detail: string) => {
    unallocated.push({
      channelId: channel.id,
      roomId: channel.roomId,
      roomName: channel.roomName,
      label: channel.label,
      category: channel.category,
      demand: plannerChannelDemand(channel),
      reason,
      detail,
    });
  };

  if (!capability.evaluable) {
    for (const channel of requirements.channels) {
      reject(
        channel,
        "board_not_evaluable",
        "This board has no complete, valid pin map on record, so no wiring plan can be validated for it."
      );
    }
    const future: PlannerFutureCapacity = {
      requestedOutputs: installation.futureOutputs,
      requestedInputs: installation.futureInputs,
      accommodatedOutputs: 0,
      accommodatedInputs: 0,
      satisfied: installation.futureOutputs === 0 && installation.futureInputs === 0,
    };
    return {
      feasible: false,
      controllers: [],
      unallocated,
      pressure,
      future,
      spare: { pins: 0, outputs: 0, inputs: 0, ioItems: 0 },
    };
  }

  const prepared = prepare(requirements);
  let highestPin = 0;
  for (const pin of capability.pins) if (pin.pin > highestPin) highestPin = pin.pin;
  const ctx: BoardContext = {
    capability,
    maxIoItems: capability.maxIoItems,
    usablePins: capability.counts.usable,
    scratch: { visited: new Array<number>(highestPin + 1).fill(0), generation: 0 },
  };
  const restrictedPins = capability.pins.filter((p) => p.tier === "restricted");

  const noteShortage = (draft: DraftController | null, unit: Unit) => {
    const shape = shapeUnit(unit, draft?.busSensors ?? 0);
    if (draft && draft.ioItems + shape.ioItems > ctx.maxIoItems) {
      pressure.ioItemLimit = true;
      return;
    }
    const freePins = ctx.usablePins - (draft?.matcher.size ?? 0);
    const distinct = Array.from(new Set(shape.demands));
    if (freePins < shape.demands.length) {
      pressure.gpioShortage = true;
    } else {
      for (const demand of distinct) {
        if (!pressure.capabilityShortage.includes(demand)) pressure.capabilityShortage.push(demand);
      }
    }
    if (restrictedPins.some((p) => distinct.some((d) => rawPinSupports(p, d)))) {
      pressure.restrictedPinsWithheld = true;
    }
  };

  const drafts: DraftController[] = [];

  for (const location of prepared.locations) {
    for (const channel of location.unsupported) {
      reject(channel, "unsupported_interface", channel.unsupportedInterface ?? "Unsupported sensor connection.");
    }

    const here: DraftController[] = [];
    let everythingPlaced = true;
    // Controllers before this index have no pin or connection slot left.
    let firstOpen = 0;

    for (const unit of location.units) {
      while (
        firstOpen < here.length &&
        (here[firstOpen]!.matcher.size >= ctx.usablePins ||
          here[firstOpen]!.ioItems >= ctx.maxIoItems)
      ) {
        firstOpen += 1;
      }
      let placed = false;
      for (let i = firstOpen; i < here.length; i++) {
        if (tryPlace(here[i]!, unit, ctx)) {
          placed = true;
          break;
        }
      }
      if (placed) continue;

      const canOpen = installation.allowAdditionalControllers || here.length === 0;
      const fresh = emptyDraft(location.id, ctx);
      const fitsAlone = tryPlace(fresh, unit, ctx);

      if (fitsAlone && canOpen) {
        // The channels spilled onto a new controller: record why the last one was full.
        if (here.length > 0) noteShortage(here[here.length - 1]!, unit);
        here.push(fresh);
        continue;
      }

      everythingPlaced = false;
      if (fitsAlone) {
        pressure.singleControllerLimit = true;
        noteShortage(here[here.length - 1] ?? null, unit);
        for (const channel of unit.channels) {
          reject(
            channel,
            "single_controller_limit",
            "The controller at this location is full and additional controllers were not allowed."
          );
        }
        continue;
      }

      noteShortage(null, unit);
      const overLimit = shapeUnit(unit, 0).ioItems > ctx.maxIoItems;
      for (const channel of unit.channels) {
        reject(
          channel,
          overLimit ? "io_item_limit" : "no_capable_pin",
          overLimit
            ? `One controller can run at most ${ctx.maxIoItems} connections.`
            : `This board has no assignable pin that offers ${describePlannerDemand(
                plannerChannelDemand(channel)
              )}.`
        );
      }
    }

    // Spreading rooms evenly only makes sense when every unit found a home.
    const settled = (everythingPlaced ? rebalance(here.length, location, ctx) : null) ?? here;
    const order = prepared.channelOrder;
    for (const draft of settled) {
      draft.channels.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
    settled.sort(
      (a, b) => (order.get(a.channels[0]?.id ?? "") ?? 0) - (order.get(b.channels[0]?.id ?? "") ?? 0)
    );
    drafts.push(...settled);
  }

  const locationName = new Map(prepared.locations.map((l) => [l.id, l.name]));
  const perLocationCount = new Map<string, number>();
  for (const draft of drafts) {
    perLocationCount.set(draft.locationId, (perLocationCount.get(draft.locationId) ?? 0) + 1);
  }
  const perLocationSeen = new Map<string, number>();

  const controllers: PlannerControllerPlan[] = drafts.map((draft, i) => {
    const finalized = finalizeController(draft, ctx);
    const name = locationName.get(draft.locationId) ?? "Controller location";
    const seen = (perLocationSeen.get(draft.locationId) ?? 0) + 1;
    perLocationSeen.set(draft.locationId, seen);
    const multiple = (perLocationCount.get(draft.locationId) ?? 1) > 1;
    pressure.i2cFallbackSensors += finalized.fallbackSensors;

    const channelOrder = prepared.channelOrder;
    finalized.assignments.sort(
      (a, b) => (channelOrder.get(a.channelId) ?? 0) - (channelOrder.get(b.channelId) ?? 0)
    );

    return {
      index: i + 1,
      name: multiple ? `Controller ${i + 1} · ${name} (${seen})` : `Controller ${i + 1} · ${name}`,
      locationId: draft.locationId,
      locationName: name,
      rooms: summarizeRooms(finalized.assignments, prepared.floorByRoom),
      assignments: finalized.assignments,
      i2cBus: finalized.i2cBus,
      ioItemsUsed: draft.ioItems,
      pinsUsed: finalized.pinsUsed,
      relayChannels: finalized.assignments.filter((a) => a.needsRelay).length,
      spare: {
        pins: Math.max(0, ctx.usablePins - finalized.pinsUsed),
        outputs: countAdditional(draft, "digital_out", ctx),
        inputs: countAdditional(draft, "digital_in", ctx),
        ioItems: Math.max(0, ctx.maxIoItems - draft.ioItems),
      },
    };
  });

  // Future additions: outputs first, then inputs, competing for the same spare pins.
  let accommodatedOutputs = 0;
  let accommodatedInputs = 0;
  if (installation.futureOutputs + installation.futureInputs > 0) {
    const futureDrafts = drafts.map((draft) => ({
      matcher: draft.matcher.clone(),
      ioItems: draft.ioItems,
    }));
    const placeFuture = (demand: PlannerPinDemand): boolean =>
      futureDrafts.some((draft) => {
        if (draft.ioItems >= ctx.maxIoItems) return false;
        if (draft.matcher.add(demand) < 0) return false;
        draft.ioItems += 1;
        return true;
      });
    while (accommodatedOutputs < installation.futureOutputs && placeFuture("digital_out")) {
      accommodatedOutputs += 1;
    }
    while (accommodatedInputs < installation.futureInputs && placeFuture("digital_in")) {
      accommodatedInputs += 1;
    }
  }

  const spare: PlannerSpareCapacity = { pins: 0, outputs: 0, inputs: 0, ioItems: 0 };
  for (const controller of controllers) {
    spare.pins += controller.spare.pins;
    spare.outputs += controller.spare.outputs;
    spare.inputs += controller.spare.inputs;
    spare.ioItems += controller.spare.ioItems;
  }

  pressure.capabilityShortage.sort(
    (a, b) => PLANNER_PIN_DEMANDS.indexOf(a) - PLANNER_PIN_DEMANDS.indexOf(b)
  );

  return {
    feasible: unallocated.length === 0 && controllers.length > 0,
    controllers,
    unallocated,
    pressure,
    future: {
      requestedOutputs: installation.futureOutputs,
      requestedInputs: installation.futureInputs,
      accommodatedOutputs,
      accommodatedInputs,
      satisfied:
        accommodatedOutputs >= installation.futureOutputs &&
        accommodatedInputs >= installation.futureInputs,
    },
    spare,
  };
}
