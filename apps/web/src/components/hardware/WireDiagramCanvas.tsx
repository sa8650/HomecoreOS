import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  RiFlashlightLine,
  RiLockLine,
  RiTempColdLine,
  RiToggleLine,
  RiPlug2Line,
  RiZoomInLine,
  RiZoomOutLine,
  RiFullscreenLine,
  RiAlertLine,
} from "@remixicon/react";
import type {
  WireDiagramResult,
  GpioPinDefinition,
  CircuitComponent,
  CircuitEndpointRef,
  CircuitWire,
} from "@homecoreos/shared";
import {
  BoardVectorSvg,
  getBoardVectorVerticalLayout,
} from "@/components/boards/BoardVectorSvg";
import type { BoardProfileItem } from "@/features/types";
import { cn } from "cn";
import {
  pinCapabilityList,
  wireColor,
  wireDash,
  wireLabel,
  circuitWireColor,
  circuitWireWidth,
  circuitWireDash,
  CIRCUIT_WIRE_LABELS,
} from "./wire-diagram-shared";
import {
  DeviceIllustration,
  illustrationForEntity,
} from "./DeviceIllustration";

// ---------------------------------------------------------------------------
// Geometry constants (world units)
// ---------------------------------------------------------------------------
const WORLD_TOP = 116;
const BOARD_X = 64;
const STAGE = {
  w: 232,
  hdr: 44,
  rowH: 30,
  gap: 22,
  pad: 12,
};
const MOD = {
  w: 330,
  headerH: 64,
  illusionH: 96,
  padY: 12,
  termH: 52,
  gap: 6,
};
const AUX = {
  w: 252,
  hdr: 44,
  rowH: 30,
  gap: 22,
  pad: 12,
};
const PITCH = MOD.termH + MOD.gap;
const LABEL_FILL = "#64748b";
const AUX_KINDS = new Set([
  "ac_mains",
  "external_psu",
  "appliance_load",
  "led_strip",
  "onboard_relay",
]);
/** Stage cards stack in signal-flow order: driver input → switch → clamp. */
const STAGE_RANK: Record<string, number> = {
  base_resistor: 0,
  pull_up_resistor: 0,
  series_resistor: 0,
  mosfet_logic: 1,
  npn_transistor: 1,
  level_shifter: 1,
  voltage_divider: 1,
  flyback_diode: 2,
};
/** Aux tiles stack in signal-flow order: source → switching stage → load. */
const AUX_RANK: Record<string, number> = {
  ac_mains: 0,
  external_psu: 0,
  onboard_relay: 1,
  appliance_load: 2,
  led_strip: 2,
};

/** Polyline with quadratic-rounded corners through absolute points. */
function orthoPath(points: Array<[number, number]>, radius = 12): string {
  if (points.length < 2) return "";
  let d = `M ${points[0]![0]} ${points[0]![1]}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[i + 1]!;
    const v1x = x1 - x0;
    const v1y = y1 - y0;
    const v2x = x2 - x1;
    const v2y = y2 - y1;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    const dot = v1x * v2x + v1y * v2y;
    const straight = l1 > 0 && l2 > 0 && Math.abs(dot - l1 * l2) < 1e-3;
    if (straight || l1 < 1e-3 || l2 < 1e-3) {
      d += ` L ${x1} ${y1}`;
      continue;
    }
    const rr = Math.min(radius, l1 / 2, l2 / 2);
    const p1x = x1 - (v1x / l1) * rr;
    const p1y = y1 - (v1y / l1) * rr;
    const p2x = x1 + (v2x / l2) * rr;
    const p2y = y1 + (v2y / l2) * rr;
    d += ` L ${p1x.toFixed(2)} ${p1y.toFixed(2)} Q ${x1} ${y1} ${p2x.toFixed(2)} ${p2y.toFixed(2)}`;
  }
  const [xn, yn] = points[points.length - 1]!;
  d += ` L ${xn} ${yn}`;
  return d;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cardHeight(comp: CircuitComponent, rowH: number, hdr: number, pad: number): number {
  // Top/bottom edge pins occupy no row.
  const rowPins = comp.pins.filter((p) => p.edge === "left" || p.edge === "right");
  const maxRow = rowPins.reduce((m, p) => Math.max(m, p.row), 0);
  return hdr + (maxRow + 1) * rowH + pad * 2;
}

export interface WireDiagramCanvasProps {
  board: BoardProfileItem;
  result: WireDiagramResult;
  selectedId: string | null;
  onSelectConnection: (id: string | null) => void;
  className?: string;
}

export function WireDiagramCanvas({
  board,
  result,
  selectedId,
  onSelectConnection,
  className,
}: WireDiagramCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    tx: number;
    ty: number;
    moved: boolean;
  } | null>(null);
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  const [dragging, setDragging] = useState(false);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState<
    | { type: "pin"; headerKey: string }
    | { type: "wire"; id: string }
    | { type: "cwire"; id: string }
    | null
  >(null);

  const layout = useMemo(() => getBoardVectorVerticalLayout(board), [board]);
  const circuit = result.circuit;

  // ---- Circuit component split: stage (control) vs aux (supply & load) ----
  const stageComps = useMemo(
    () =>
      circuit.components
        .filter((c) => !AUX_KINDS.has(c.kind))
        .slice()
        .sort((a, b) => (STAGE_RANK[a.kind] ?? 1) - (STAGE_RANK[b.kind] ?? 1)),
    [circuit.components]
  );
  const auxComps = useMemo(
    () =>
      circuit.components
        .filter((c) => AUX_KINDS.has(c.kind))
        .slice()
        .sort((a, b) => (AUX_RANK[a.kind] ?? 3) - (AUX_RANK[b.kind] ?? 3)),
    [circuit.components]
  );
  const hasStage = stageComps.length > 0;
  const hasAux = auxComps.length > 0;

  const STAGE_X = BOARD_X + layout.viewWidth + 64;
  const MOD_X = BOARD_X + layout.viewWidth + (hasStage ? STAGE.w + 64 + 84 : 150);
  const AUX_X = MOD_X + MOD.w + 96;
  const worldWidth =
    (hasAux ? AUX_X + AUX.w : MOD_X + MOD.w) + 48;

  // ---- Terminals targeted by circuit wires (badge only) ----
  const circuitTerminalTargets = useMemo(() => {
    const targets = new Set<string>();
    for (const wire of circuit.wires) {
      if (wire.to.type === "device_terminal") targets.add(wire.to.terminalId);
      if (wire.from.type === "device_terminal") targets.add(wire.from.terminalId);
    }
    return targets;
  }, [circuit.wires]);

  // ---- Base legs the circuit replaces (naive nets that would bypass the
  // driver / fight two supplies). Everything else keeps its base leg:
  // board GND and signal taps are required connectivity, not redundancy.
  const replacedBaseTerminals = useMemo(
    () => new Set(circuit.replacesBaseLegs ?? []),
    [circuit.replacesBaseLegs]
  );

  const drawn = useMemo(
    () =>
      result.connections.filter(
        (c) =>
          (c.placement === "header" || c.placement === "extra_pad") &&
          !replacedBaseTerminals.has(c.terminalId)
      ),
    [result.connections, replacedBaseTerminals]
  );
  const onboardOnly =
    result.connections.length > 0 &&
    result.connections.every((c) => c.placement === "onboard");

  const anchorsByKey = useMemo(
    () => new Map(layout.pins.map((p) => [p.key, p])),
    [layout.pins]
  );
  const gpioByPin = useMemo(
    () => new Map(board.gpio_definitions.map((g) => [g.pin, g])),
    [board.gpio_definitions]
  );
  const terminalIndex = useMemo(
    () => new Map(result.terminals.map((t, i) => [t.id, i])),
    [result.terminals]
  );

  // ---- Module geometry ----
  const moduleHeight =
    MOD.headerH +
    MOD.illusionH +
    MOD.padY * 2 +
    result.terminals.length * PITCH -
    MOD.gap;
  const moduleY = Math.max(
    12,
    WORLD_TOP + (layout.viewHeight - moduleHeight) / 2
  );

  // ---- Stage card & aux tile stacking ----
  const stageCards = useMemo(() => {
    let y = WORLD_TOP;
    return stageComps.map((comp) => {
      const h = cardHeight(comp, STAGE.rowH, STAGE.hdr, STAGE.pad);
      const card = { comp, x: STAGE_X, y, h };
      y += h + STAGE.gap;
      return card;
    });
  }, [stageComps, STAGE_X]);
  const stageBottom =
    stageCards.length > 0
      ? stageCards[stageCards.length - 1]!.y + stageCards[stageCards.length - 1]!.h
      : WORLD_TOP;

  const auxTiles = useMemo(() => {
    let y = WORLD_TOP;
    return auxComps.map((comp) => {
      const h = cardHeight(comp, AUX.rowH, AUX.hdr, AUX.pad);
      const tile = { comp, x: AUX_X, y, h };
      y += h + AUX.gap;
      return tile;
    });
  }, [auxComps, AUX_X]);
  const auxBottom =
    auxTiles.length > 0
      ? auxTiles[auxTiles.length - 1]!.y + auxTiles[auxTiles.length - 1]!.h
      : WORLD_TOP;

  // ---- Pin anchors for circuit components ----
  const pinAnchors = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const { comp, x, y, h } of stageCards) {
      for (const pin of comp.pins) {
        if (pin.edge === "top" || pin.edge === "bottom") {
          map.set(`${comp.id}:${pin.id}`, {
            x: x + STAGE.w / 2,
            y: pin.edge === "top" ? y : y + h,
          });
          continue;
        }
        map.set(`${comp.id}:${pin.id}`, {
          x: pin.edge === "left" ? x : x + STAGE.w,
          y: y + STAGE.hdr + STAGE.pad + pin.row * STAGE.rowH + STAGE.rowH / 2,
        });
      }
    }
    for (const { comp, y } of auxTiles) {
      for (const pin of comp.pins) {
        // Aux tiles always face the module: pins on the left edge.
        map.set(`${comp.id}:${pin.id}`, {
          x: AUX_X,
          y: y + AUX.hdr + AUX.pad + pin.row * AUX.rowH + AUX.rowH / 2,
        });
      }
    }
    return map;
  }, [stageCards, auxTiles, AUX_X]);

  const auxComponentIds = useMemo(
    () => new Set(auxComps.map((c) => c.id)),
    [auxComps]
  );

  // ---- Extra (back) pad chips: union of base legs and circuit GPIO refs ----
  const extraChipNames = useMemo(() => {
    const names = new Set<string>();
    for (const conn of drawn) {
      if (conn.placement === "extra_pad" && conn.extraPadName) {
        names.add(conn.extraPadName);
      }
    }
    for (const wire of circuit.wires) {
      for (const ep of [wire.from, wire.to]) {
        if (ep.type === "gpio" && ep.extraPadName) names.add(ep.extraPadName);
      }
    }
    return [...names];
  }, [drawn, circuit.wires]);

  const extraChips = useMemo(() => {
    const bottomY = WORLD_TOP + layout.viewHeight;
    const chipW = 118;
    const chipH = 40;
    const total = extraChipNames.length * (chipW + 14) - 14;
    const start = BOARD_X + (layout.viewWidth - total) / 2;
    return extraChipNames.map((name, i) => ({
      name,
      x: start + i * (chipW + 14),
      y: bottomY + 14,
      w: chipW,
      h: chipH,
    }));
  }, [extraChipNames, layout.viewHeight, layout.viewWidth]);
  const extraChipByName = useMemo(
    () => new Map(extraChips.map((chip) => [chip.name, chip])),
    [extraChips]
  );

  const termPoint = useCallback(
    (
      terminalId: string,
      side: "left" | "right" = "left"
    ): { x: number; y: number } => {
      const idx = terminalIndex.get(terminalId) ?? 0;
      return {
        x: side === "left" ? MOD_X : MOD_X + MOD.w,
        y:
          moduleY +
          MOD.headerH +
          MOD.illusionH +
          MOD.padY +
          idx * PITCH +
          MOD.termH / 2,
      };
    },
    [moduleY, terminalIndex, MOD_X]
  );

  // ---- Resolve a circuit endpoint to an absolute anchor ----
  const resolveCircuitEndpoint = useCallback(
    (
      ep: CircuitEndpointRef,
      other: CircuitEndpointRef | null
    ): { x: number; y: number } | null => {
      if (ep.type === "gpio") {
        if (ep.headerKey) {
          const anchor = anchorsByKey.get(ep.headerKey);
          if (anchor) {
            return { x: BOARD_X + anchor.edgeX, y: WORLD_TOP + anchor.cy };
          }
        }
        if (ep.extraPadName) {
          const chip = extraChipByName.get(ep.extraPadName);
          if (chip) return { x: chip.x + chip.w / 2, y: chip.y };
        }
        return null;
      }
      if (ep.type === "component") {
        return pinAnchors.get(`${ep.componentId}:${ep.pinId}`) ?? null;
      }
      // device_terminal — wires from the aux supply/load column attach on the
      // panel's right edge (like a real screw-terminal strip); everything else
      // attaches on the left where the control wiring lands.
      const otherIsAux =
        other?.type === "component" && auxComponentIds.has(other.componentId);
      const side: "left" | "right" = otherIsAux ? "right" : "left";
      return termPoint(ep.terminalId, side);
    },
    [anchorsByKey, extraChipByName, pinAnchors, auxComponentIds, termPoint]
  );

  // ---- Pin edge lookup for wire-exit direction (aux pins always face left) ----
  const pinEdgeByComponent = useMemo(() => {
    const m = new Map<string, Map<string, "left" | "right" | "top" | "bottom">>();
    for (const comp of circuit.components) {
      const inner = new Map<string, "left" | "right" | "top" | "bottom">();
      const aux = AUX_KINDS.has(comp.kind);
      for (const pin of comp.pins) {
        inner.set(pin.id, aux ? "left" : pin.edge);
      }
      m.set(comp.id, inner);
    }
    return m;
  }, [circuit.components]);

  const edgeOf = useCallback(
    (
      ep: CircuitEndpointRef,
      other: CircuitEndpointRef | null
    ): "left" | "right" | "top" | "bottom" => {
      if (ep.type === "component") {
        return pinEdgeByComponent.get(ep.componentId)?.get(ep.pinId) ?? "left";
      }
      if (ep.type === "gpio") {
        if (ep.headerKey) {
          const anchor = anchorsByKey.get(ep.headerKey);
          if (anchor) return anchor.edgeX < layout.viewWidth / 2 ? "left" : "right";
        }
        return "left"; // extra back pads — exit on the left
      }
      // device_terminal — aux-attached terminals attach on the right edge,
      // everything else on the left edge.
      const otherIsAux =
        other?.type === "component" && auxComponentIds.has(other.componentId);
      return otherIsAux ? "right" : "left";
    },
    [pinEdgeByComponent, anchorsByKey, layout.viewWidth, auxComponentIds]
  );

  // ---- Left-header pads in the lower half of the board route under the
  // world instead of over the top.
  const leftBottomCount = useMemo(
    () =>
      drawn.filter((c) => {
        if (c.placement !== "header" || c.side !== "left" || !c.headerKey) {
          return false;
        }
        const a = anchorsByKey.get(c.headerKey);
        return a ? a.cy > layout.viewHeight * 0.55 : false;
      }).length,
    [drawn, anchorsByKey, layout.viewHeight]
  );

  // ---- Span-crossing circuit wires (board/stage ↔ aux supply) route below everything ----
  const bottomLaneYs = useMemo(() => {
    const MOD_LEFT = MOD_X;
    const MOD_RIGHT = MOD_X + MOD.w;
    const base =
      Math.max(
        moduleY + moduleHeight,
        stageBottom,
        auxBottom,
        WORLD_TOP + layout.viewHeight + (extraChipNames.length > 0 ? 78 : 0)
      ) + 22;
    const map = new Map<string, number>();
    let k = 0;
    for (const wire of circuit.wires) {
      const s = resolveCircuitEndpoint(wire.from, wire.to);
      const e = resolveCircuitEndpoint(wire.to, wire.from);
      if (!s || !e) continue;
      const crosses =
        (s.x < MOD_LEFT && e.x > MOD_RIGHT) || (e.x < MOD_LEFT && s.x > MOD_RIGHT);
      if (crosses) {
        map.set(wire.id, base + (k % 3) * 17);
        k += 1;
      }
    }
    return {
      laneY: map,
      extra: k > 0 ? Math.min(k, 3) * 17 + 30 : 0,
    };
  }, [
    circuit.wires,
    resolveCircuitEndpoint,
    MOD_X,
    moduleY,
    moduleHeight,
    stageBottom,
    auxBottom,
    layout.viewHeight,
    extraChipNames.length,
  ]);

  const worldHeight =
    Math.max(
      WORLD_TOP + layout.viewHeight + 84 + leftBottomCount * 20,
      moduleY + moduleHeight + 84,
      stageBottom + 84,
      auxBottom + 84,
      560
    ) + bottomLaneYs.extra;

  // ---- Lane assignment (right bucket / left-over-the-top / extra-pad chip) ----
  const routed = useMemo(() => {
    const rightWires = drawn
      .filter((c) => c.placement === "header" && c.side === "right")
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const leftWires = drawn
      .filter((c) => c.placement === "header" && c.side === "left")
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const extraWires = drawn.filter((c) => c.placement === "extra_pad");

    const routes = new Map<
      string,
      {
        d: string;
        labelX: number;
        labelY: number;
        startX: number;
        startY: number;
        endX: number;
        endY: number;
      }
    >();

    const pcbRight = BOARD_X + layout.pcbX + layout.pcbW;
    const pcbLeft = BOARD_X + layout.pcbX;
    const bottomY = WORLD_TOP + layout.viewHeight;

    rightWires.forEach((conn, i) => {
      const anchor = anchorsByKey.get(conn.headerKey!)!;
      const start = { x: BOARD_X + anchor.edgeX, y: WORLD_TOP + anchor.cy };
      const end = termPoint(conn.terminalId, "left");
      const laneX = pcbRight + 22 + i * 26;
      const d = orthoPath(
        [
          [start.x, start.y],
          [laneX, start.y],
          [laneX, end.y],
          [end.x, end.y],
        ],
        12
      );
      const midY = (start.y + end.y) / 2;
      const tight = Math.abs(start.y - end.y) < 44;
      routes.set(conn.id, {
        d,
        labelX: tight ? (start.x + end.x) / 2 : laneX,
        labelY: tight ? start.y : midY,
        startX: start.x,
        startY: start.y,
        endX: end.x,
        endY: end.y,
      });
    });

    let overTop = 0;
    let lowBottom = 0;
    leftWires.forEach((conn) => {
      const anchor = anchorsByKey.get(conn.headerKey!)!;
      const start = { x: BOARD_X + anchor.edgeX, y: WORLD_TOP + anchor.cy };
      const end = termPoint(conn.terminalId, "left");
      if (layout.viewHeight > 0 && anchor.cy > layout.viewHeight * 0.55) {
        const bi = lowBottom;
        lowBottom += 1;
        const exitX = pcbLeft - 16 - bi * 24;
        const floorY = bottomY + 40 + bi * 20;
        const dropX = MOD_X - 16 - bi * 24;
        const d = orthoPath(
          [
            [start.x, start.y],
            [exitX, start.y],
            [exitX, floorY],
            [dropX, floorY],
            [dropX, end.y],
            [end.x, end.y],
          ],
          12
        );
        routes.set(conn.id, {
          d,
          labelX: (exitX + dropX) / 2,
          labelY: floorY,
          startX: start.x,
          startY: start.y,
          endX: end.x,
          endY: end.y,
        });
        return;
      }
      const i = overTop;
      overTop += 1;
      const exitX = pcbLeft - 16 - i * 24;
      const topY = 24 + i * 17;
      const dropX = MOD_X - 16 - i * 24;
      const d = orthoPath(
        [
          [start.x, start.y],
          [exitX, start.y],
          [exitX, topY],
          [dropX, topY],
          [dropX, end.y],
          [end.x, end.y],
        ],
        12
      );
      routes.set(conn.id, {
        d,
        labelX: (exitX + dropX) / 2,
        labelY: topY,
        startX: start.x,
        startY: start.y,
        endX: end.x,
        endY: end.y,
      });
    });

    extraWires.forEach((conn, i) => {
      const end = termPoint(conn.terminalId, "left");
      const chip = extraChipByName.get(conn.extraPadName ?? "");
      const start = chip
        ? { x: chip.x + chip.w / 2, y: chip.y }
        : { x: BOARD_X + layout.viewWidth / 2, y: bottomY + 26 };
      const floorY = bottomY + 34 + leftBottomCount * 20 + i * 17 + 28;
      const dropX = MOD_X - 16 - (leftWires.length + i) * 24;
      const d = orthoPath(
        [
          [start.x, start.y],
          [start.x, floorY],
          [dropX, floorY],
          [dropX, end.y],
          [end.x, end.y],
        ],
        12
      );
      routes.set(conn.id, {
        d,
        labelX: (start.x + dropX) / 2,
        labelY: floorY,
        startX: start.x,
        startY: start.y,
        endX: end.x,
        endY: end.y,
      });
    });

    return routes;
  }, [
    anchorsByKey,
    drawn,
    layout.pcbW,
    layout.pcbX,
    layout.viewHeight,
    layout.viewWidth,
    termPoint,
    MOD_X,
    extraChipByName,
    leftBottomCount,
  ]);

  // ---- Circuit wire routes ----
  const circuitRoutes = useMemo(() => {
    const routes: Array<{
      wire: CircuitWire;
      d: string;
      labelX: number;
      labelY: number;
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    }> = [];
    // Pills for any wire touching the aux column are pinned to the centre of
    // the module→aux gap so they never slide under the module panel or the
    // aux tiles (wires below them, cards above them).
    const gapCenter = hasAux ? (MOD_X + MOD.w + AUX_X) / 2 : 0;
    circuit.wires.forEach((wire, i) => {
      const start = resolveCircuitEndpoint(wire.from, wire.to);
      const end = resolveCircuitEndpoint(wire.to, wire.from);
      if (!start || !end) return;
      const startEdge = edgeOf(wire.from, wire.to);
      const endEdge = edgeOf(wire.to, wire.from);
      const vertStart = startEdge === "top" || startEdge === "bottom";
      const vertEnd = endEdge === "top" || endEdge === "bottom";
      const bothAux =
        wire.from.type === "component" &&
        wire.to.type === "component" &&
        auxComponentIds.has(wire.from.componentId) &&
        auxComponentIds.has(wire.to.componentId);
      const involvesAuxSide =
        hasAux &&
        ((wire.from.type === "component" &&
          auxComponentIds.has(wire.from.componentId)) ||
          (wire.to.type === "component" &&
            auxComponentIds.has(wire.to.componentId)));
      const mid = (start.x + end.x) / 2;
      const laneY = bottomLaneYs.laneY.get(wire.id);
      let d: string;
      let labelX: number;
      let labelY: number;
      if (laneY !== undefined) {
        // Span-crossing: exit the start side through its free column, run a
        // bottom lane underneath everything, rise into the end side. Board
        // ends approach from outside the board's left edge.
        // Drop column for span-crossing wires. Board/left-edge stage pins
        // exit through the free controller→stage gutter; right/top/bottom
        // pins exit into the stage→module gutter (never back through a
        // card); aux-side wires use the aux→module gutter.
        const leftCol = hasStage ? STAGE_X - 10 : MOD_X - 26;
        const gutterCol = hasStage ? STAGE_X + STAGE.w + 66 : MOD_X - 18;
        const rightCol = AUX_X - 26;
        const startEdgeC = edgeOf(wire.from, wire.to);
        let startCol: number;
        if (start.x < MOD_X) {
          startCol =
            startEdgeC === "right" || startEdgeC === "top" || startEdgeC === "bottom"
              ? gutterCol
              : leftCol;
        } else {
          startCol = rightCol;
        }
        // A gpio END entering a board pad must approach from outside the
        // board on the same side the pad lives on — never through the board.
        const boardRight = BOARD_X + layout.pcbX + layout.pcbW;
        const endGpioAnchor =
          wire.to.type === "gpio" && wire.to.headerKey
            ? anchorsByKey.get(wire.to.headerKey)
            : null;
        const endCol =
          end.x > MOD_X + MOD.w
            ? rightCol
            : wire.to.type === "gpio"
              ? endGpioAnchor && endGpioAnchor.edgeX > layout.viewWidth / 2
                ? boardRight + 22
                : BOARD_X - 26
              : leftCol;
        d = orthoPath(
          [
            [start.x, start.y],
            [startCol, start.y],
            [startCol, laneY],
            [endCol, laneY],
            [endCol, end.y],
            [end.x, end.y],
          ],
          12
        );
        // Pill on the longest horizontal segment (usually the bottom lane).
        const laneLen = Math.abs(endCol - startCol);
        const endStubLen = Math.abs(end.x - endCol);
        const startStubLen = Math.abs(start.x - startCol);
        if (laneLen >= endStubLen && laneLen >= startStubLen) {
          labelX = (startCol + endCol) / 2;
          labelY = laneY - 2;
        } else if (endStubLen >= startStubLen) {
          labelX = (endCol + end.x) / 2;
          labelY = end.y - 4;
        } else {
          labelX = (startCol + start.x) / 2;
          labelY = start.y - 4;
        }
      } else if (vertStart || vertEnd) {
        // A vertical-edge pin exits through its card edge, then jogs along a
        // mid-lane into the target. For the stacked-card hop (driver R1 →
        // gate/base) this is a straight vertical drop in the gap; the pill
        // rides beside the wire instead of on top of it.
        const midY = (start.y + end.y) / 2;
        let pts: Array<[number, number]>;
        if (vertStart && vertEnd) {
          pts = [
            [start.x, start.y],
            [start.x, midY],
            [end.x, midY],
            [end.x, end.y],
          ];
        } else if (vertStart) {
          pts = [
            [start.x, start.y],
            [start.x, midY],
            [end.x, midY],
            [end.x, end.y],
          ];
        } else {
          pts = [
            [start.x, start.y],
            [end.x, start.y],
            [end.x, end.y],
          ];
        }
        d = orthoPath(pts, 8);
        if (vertStart && vertEnd) {
          const hw = (wire.label.length * 6 + 12) / 2;
          labelX = start.x + hw + 10;
          labelY = midY;
        } else {
          labelX = (start.x + end.x) / 2;
          labelY = midY;
        }
      } else {
        const elbowX = bothAux
          ? AUX_X - 26 - i * 12
          : mid + ((i % 5) - 2) * 16;
        d = orthoPath(
          [
            [start.x, start.y],
            [elbowX, start.y],
            [elbowX, end.y],
            [end.x, end.y],
          ],
          12
        );
        const tight = Math.abs(start.y - end.y) < 30;
        labelX = tight ? mid : involvesAuxSide ? gapCenter : elbowX;
        labelY = tight ? start.y : (start.y + end.y) / 2;
      }
      routes.push({
        wire,
        d,
        labelX,
        labelY,
        startX: start.x,
        startY: start.y,
        endX: end.x,
        endY: end.y,
      });
    });
    return routes;
  }, [
    circuit.wires,
    resolveCircuitEndpoint,
    AUX_X,
    auxComponentIds,
    hasAux,
    hasStage,
    MOD_X,
    STAGE_X,
    bottomLaneYs,
    edgeOf,
    anchorsByKey,
    layout.pcbX,
    layout.pcbW,
    layout.viewWidth,
  ]);

  // ---- Pill labels rendered on a top overlay so HTML panels never clip them ----
  const pillLayer = useMemo(() => {
    const pills: Array<{
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      label: string;
      color: string;
      fontSize: number;
    }> = [];
    for (const conn of drawn) {
      const route = routed.get(conn.id);
      if (!route) continue;
      const label = wireLabel(conn);
      const w = label.length * 6.7 + 18;
      pills.push({
        id: `base-${conn.id}`,
        x: route.labelX - (label.length * 3.35 + 9),
        y: route.labelY - 9,
        w,
        h: 18,
        label,
        color: wireColor(conn),
        fontSize: 10,
      });
    }
    for (const route of circuitRoutes) {
      const label = route.wire.label;
      pills.push({
        id: `cw-${route.wire.id}`,
        x: route.labelX - (label.length * 3.0 + 6),
        y: route.labelY - 8,
        w: label.length * 6.0 + 12,
        h: 16,
        label,
        color: circuitWireColor(route.wire.kind),
        fontSize: 9,
      });
    }
    return pills;
  }, [drawn, routed, circuitRoutes]);

  const selected = result.connections.find((c) => c.id === selectedId) ?? null;
  const connectedHeaderKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const conn of result.connections) {
      if (conn.headerKey) keys.add(conn.headerKey);
    }
    for (const wire of circuit.wires) {
      for (const ep of [wire.from, wire.to]) {
        if (ep.type === "gpio" && ep.headerKey) keys.add(ep.headerKey);
      }
    }
    return keys;
  }, [result.connections, circuit.wires]);
  const highlightedHeaderKeys = useMemo(
    () => (selected?.headerKey ? new Set([selected.headerKey]) : new Set<string>()),
    [selected]
  );

  // ---- Fit-to-screen ----
  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const pad = 16;
    const kFit = Math.min((cw - pad * 2) / worldWidth, (ch - pad * 2) / worldHeight);
    const k = clamp(Math.min(kFit, 1.2), 0.3, 1.6);
    setView({
      k,
      tx: (cw - worldWidth * k) / 2,
      ty: (ch - worldHeight * k) / 2 + 2,
    });
  }, [worldHeight, worldWidth]);

  const boardStamp = `${board.id}:${layout.viewWidth}x${layout.viewHeight}:${result.terminals.length}:${stageComps.length}:${auxComps.length}`;
  useLayoutEffect(() => {
    fit();
    // Refit whenever the board or the entity wiring changes shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardStamp]);

  // ---- Wheel zoom (native, non-passive) ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0016);
        const k2 = clamp(v.k * factor, 0.4, 2.8);
        const scale = k2 / v.k;
        return {
          k: k2,
          tx: mx - (mx - v.tx) * scale,
          ty: my - (my - v.ty) * scale,
        };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const el = containerRef.current;
    if (!el) return;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    setView((v) => {
      const k2 = clamp(v.k * factor, 0.4, 2.8);
      const scale = k2 / v.k;
      return {
        k: k2,
        tx: cx - (cx - v.tx) * scale,
        ty: cy - (cy - v.ty) * scale,
      };
    });
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (
        e.target instanceof Element &&
        e.target.closest('[data-nopan="true"]')
      ) {
        return;
      }
      const el = containerRef.current;
      if (!el) return;
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        tx: view.tx,
        ty: view.ty,
        moved: false,
      };
      el.setPointerCapture(e.pointerId);
    },
    [view.tx, view.ty]
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    setDragging(true);
    setView((v) => ({ ...v, tx: drag.tx + dx, ty: drag.ty + dy }));
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId === e.pointerId) {
      if (drag.moved) suppressClickRef.current = true;
      dragRef.current = null;
    }
    setDragging(false);
  }, []);

  const handleClickCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);

  const pinFromHeaderKey = useCallback(
    (key: string) => {
      const anchor = anchorsByKey.get(key);
      if (!anchor) return null;
      const hp = anchor.headerPin;
      const def: GpioPinDefinition | undefined =
        hp.gpioPin !== null ? gpioByPin.get(hp.gpioPin) : undefined;
      return { anchor, hp, def };
    },
    [anchorsByKey, gpioByPin]
  );

  const selectFromPinKey = useCallback(
    (key: string) => {
      const match = result.connections.find((c) => c.headerKey === key);
      if (match) onSelectConnection(match.id === selectedId ? null : match.id);
    },
    [onSelectConnection, result.connections, selectedId]
  );

  // ---- Hover tooltip model ----
  let tooltip: { title: string; lines: string[] } | null = null;
  if (hover?.type === "pin") {
    const info = pinFromHeaderKey(hover.headerKey);
    if (info) {
      const { hp, def, anchor } = info;
      const caps = pinCapabilityList(def);
      const restrictions: string[] = [];
      if (def) {
        if (def.restrictions.reserved)
          restrictions.push(def.restrictions.reserved_reason ?? "reserved");
        if (def.restrictions.input_only) restrictions.push("input-only");
        if (def.restrictions.strapping_pin)
          restrictions.push(
            `bootstrapping: ${def.restrictions.strapping_note ?? "sampled at reset"}`
          );
        if (def.restrictions.usb_jtag_conflict) restrictions.push("shared with USB/JTAG");
        if (def.restrictions.flash_psram_conflict) restrictions.push("flash/PSRAM bus");
      }
      const wired = result.connections.find((c) => c.headerKey === hover.headerKey);
      const wiredCircuit = circuit.wires.find(
        (w) =>
          (w.from.type === "gpio" && w.from.headerKey === hover.headerKey) ||
          (w.to.type === "gpio" && w.to.headerKey === hover.headerKey)
      );
      tooltip = {
        title:
          hp.gpioPin !== null
            ? `GPIO${hp.gpioPin} · pad "${hp.pinName}"`
            : `Pad "${hp.pinName}"`,
        lines: [
          `${anchor.side === "left" ? "Left" : "Right"} header · pin ${hp.position}${hp.note ? ` · ${hp.note}` : ""}`,
          caps.length > 0 ? `Functions: ${caps.join(" · ")}` : "No GPIO functions documented",
          ...(restrictions.length > 0 ? [`⚠ ${restrictions.join(" · ")}`] : []),
          ...(wired
            ? [`Wired → ${wired.signal} (click to inspect)`]
            : wiredCircuit
              ? [`Wired → ${wiredCircuit.label}`]
              : ["Not wired in this diagram"]),
        ],
      };
    }
  } else if (hover?.type === "wire") {
    const conn = result.connections.find((c) => c.id === hover.id);
    if (conn) {
      tooltip = {
        title: `${conn.terminalLabel} · ${conn.signal}`,
        lines: [
          conn.pin !== null
            ? `GPIO${conn.pin}${conn.pinName ? ` (pad ${conn.pinName})` : ""}`
            : conn.headerName ?? "Reference",
          conn.kind,
          `Voltage: ${conn.voltage}`,
        ],
      };
    }
  } else if (hover?.type === "cwire") {
    const wire = circuit.wires.find((w) => w.id === hover.id);
    if (wire) {
      tooltip = {
        title: `${wire.label} · ${CIRCUIT_WIRE_LABELS[wire.kind]}`,
        lines: [
          wire.description,
          wire.domain === "load"
            ? "Domain: load side (power)"
            : "Domain: control side (logic)",
          wire.documented
            ? "Facts: documented on this board/profile"
            : "Facts: guidance — verify against the module documentation",
          ...(wire.warnings ?? []).map((w) => `⚠ ${w}`),
        ],
      };
    }
  }

  const zoomPercent = Math.round(view.k * 100);
  const panelIllustration = result.entity
    ? illustrationForEntity({
        kind: result.entityKind,
        typeLabel: result.entity.typeLabel,
        driverId: result.entity.driver?.driverId ?? null,
      })
    : "appliance";
  const moduleCaption =
    result.entityKind === "sensor"
      ? "SENSOR"
      : result.entityKind === "device"
        ? "DEVICE"
        : "SWITCH CHANNEL";
  const mainsDividerX = hasAux ? MOD_X + MOD.w + 48 : null;
  const zoneStroke = circuit.mainsInvolved
    ? "rgba(239,68,68,0.35)"
    : circuit.externalSupplyRequired
      ? "rgba(245,158,11,0.35)"
      : "rgba(255,255,255,0.07)";

  return (
    <div
      ref={containerRef}
      data-testid="wire-diagram-canvas"
      className={cn(
        "relative h-full w-full touch-none overflow-hidden overscroll-none select-none",
        dragging ? "cursor-grabbing" : "cursor-grab",
        className
      )}
      style={{
        backgroundColor: "#0b1017",
        backgroundImage:
          "radial-gradient(circle at 1px 1px, rgba(148,163,184,0.16) 1px, transparent 0)",
        backgroundSize: "22px 22px",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={handleClickCapture}
    >
      {/* world */}
      <div
        className="absolute left-0 top-0"
        style={{
          width: worldWidth,
          height: worldHeight,
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`,
          transformOrigin: "0 0",
        }}
      >
        {/* wires + zone bands layer */}
        <svg
          className="absolute left-0 top-0"
          width={worldWidth}
          height={worldHeight}
          viewBox={`0 0 ${worldWidth} ${worldHeight}`}
        >
          {/* zone bands */}
          <rect x={BOARD_X - 20} y={WORLD_TOP - 40} width={layout.viewWidth + 40} height={worldHeight - WORLD_TOP + 8} rx={16} fill="rgba(255,255,255,0.018)" stroke="rgba(255,255,255,0.06)" />
          {hasStage && (
            <rect x={STAGE_X - 20} y={WORLD_TOP - 40} width={STAGE.w + 40} height={stageBottom - WORLD_TOP + 64} rx={16} fill="rgba(34,211,238,0.028)" stroke="rgba(34,211,238,0.14)" />
          )}
          <rect x={MOD_X - 20} y={WORLD_TOP - 40} width={MOD.w + 40} height={moduleY + moduleHeight - WORLD_TOP + 64} rx={16} fill="rgba(255,255,255,0.022)" stroke="rgba(255,255,255,0.08)" />
          {hasAux && (
            <rect x={AUX_X - 20} y={WORLD_TOP - 40} width={AUX.w + 40} height={auxBottom - WORLD_TOP + 64} rx={16} fill={circuit.mainsInvolved ? "rgba(239,68,68,0.04)" : "rgba(245,158,11,0.03)"} stroke={zoneStroke} />
          )}
          {/* isolation divider between the switched module and the supply/load side */}
          {mainsDividerX !== null && (
            <g>
              <line
                x1={mainsDividerX}
                y1={WORLD_TOP - 28}
                x2={mainsDividerX}
                y2={worldHeight - 40}
                stroke={circuit.mainsInvolved ? "#ef4444" : "#f59e0b"}
                strokeWidth={2}
                strokeDasharray="10 8"
                strokeOpacity={0.75}
              />
              <text
                x={mainsDividerX}
                y={WORLD_TOP - 46}
                textAnchor="middle"
                fill={circuit.mainsInvolved ? "#f87171" : "#fbbf24"}
                fontSize={10}
                fontWeight={800}
                letterSpacing={2}
              >
                {circuit.mainsInvolved ? "⚠ MAINS SIDE" : "EXTERNAL SUPPLY"}
              </text>
            </g>
          )}

          {/* area captions */}
          <text x={BOARD_X} y={WORLD_TOP - 16} fill={LABEL_FILL} fontSize={10} fontWeight={700} letterSpacing={2}>
            CONTROLLER
          </text>
          {hasStage && (
            <text x={STAGE_X} y={WORLD_TOP - 16} fill="#67e8f9" fillOpacity={0.8} fontSize={10} fontWeight={700} letterSpacing={2}>
              DRIVER STAGE
            </text>
          )}
          <text x={MOD_X} y={WORLD_TOP - 16} fill={LABEL_FILL} fontSize={10} fontWeight={700} letterSpacing={2}>
            {moduleCaption}
          </text>
          {hasAux && (
            <text x={AUX_X} y={WORLD_TOP - 16} fill={circuit.mainsInvolved ? "#f87171" : "#fbbf24"} fillOpacity={0.9} fontSize={10} fontWeight={700} letterSpacing={2}>
              SUPPLY &amp; LOAD
            </text>
          )}

          {/* base connection wires */}
          {drawn.map((conn) => {
            const route = routed.get(conn.id);
            if (!route) return null;
            const color = wireColor(conn);
            const isSelected = conn.id === selectedId;
            const dimOthers = selectedId !== null && !isSelected;
            const dash = wireDash(conn);
            return (
              <g key={conn.id} opacity={dimOthers ? 0.3 : 1}>
                {isSelected && (
                  <path
                    d={route.d}
                    fill="none"
                    stroke={color}
                    strokeOpacity={0.35}
                    strokeWidth={10}
                    strokeLinecap="round"
                    pointerEvents="none"
                  />
                )}
                <path
                  d={route.d}
                  fill="none"
                  stroke={color}
                  strokeWidth={isSelected ? 4.4 : 2.6}
                  strokeDasharray={dash}
                  strokeLinecap="round"
                  pointerEvents="none"
                />
                <circle cx={route.startX} cy={route.startY} r={4.2} fill={color} stroke="#0b1017" strokeWidth={1.6} pointerEvents="none" />
                <circle cx={route.endX} cy={route.endY} r={4.2} fill={color} stroke="#0b1017" strokeWidth={1.6} pointerEvents="none" />
                <path
                  d={route.d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={18}
                  strokeLinecap="round"
                  data-nopan="true"
                  className="cursor-pointer"
                  style={{ pointerEvents: "stroke" }}
                  onClick={() => onSelectConnection(isSelected ? null : conn.id)}
                  onMouseEnter={() => setHover({ type: "wire", id: conn.id })}
                  onMouseLeave={() => setHover((h) => (h?.type === "wire" && h.id === conn.id ? null : h))}
                >
                  <title>{`${conn.terminalLabel} — ${conn.signal}`}</title>
                </path>
              </g>
            );
          })}

          {/* circuit wires */}
          {circuitRoutes.map((route) => {
            const { wire } = route;
            const color = circuitWireColor(wire.kind);
            const dash = circuitWireDash(wire);
            const isHot = hover?.type === "cwire" && hover.id === wire.id;
            return (
              <g key={wire.id}>
                {isHot && (
                  <path
                    d={route.d}
                    fill="none"
                    stroke={color}
                    strokeOpacity={0.35}
                    strokeWidth={10}
                    strokeLinecap="round"
                    pointerEvents="none"
                  />
                )}
                <path
                  d={route.d}
                  fill="none"
                  stroke={color}
                  strokeWidth={isHot ? 4 : circuitWireWidth(wire.kind)}
                  strokeDasharray={dash}
                  strokeLinecap="round"
                  pointerEvents="none"
                />
                <circle cx={route.startX} cy={route.startY} r={4.2} fill={color} stroke="#0b1017" strokeWidth={1.6} pointerEvents="none" />
                <circle cx={route.endX} cy={route.endY} r={4.2} fill={color} stroke="#0b1017" strokeWidth={1.6} pointerEvents="none" />
                <path
                  d={route.d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={18}
                  strokeLinecap="round"
                  data-nopan="true"
                  style={{ pointerEvents: "stroke" }}
                  onMouseEnter={() => setHover({ type: "cwire", id: wire.id })}
                  onMouseLeave={() => setHover((h) => (h?.type === "cwire" && h.id === wire.id ? null : h))}
                >
                  <title>{wire.label}</title>
                </path>
              </g>
            );
          })}

          {/* extra (back) pads */}
          {extraChips.map(({ name, x, y, w, h }) => {
            const conn = drawn.find(
              (c) => c.placement === "extra_pad" && c.extraPadName === name
            );
            const color = conn ? wireColor(conn) : "#38bdf8";
            const isSelected = conn ? conn.id === selectedId : false;
            return (
              <g
                key={name}
                data-nopan="true"
                className={conn ? "cursor-pointer" : undefined}
                onClick={
                  conn
                    ? () => onSelectConnection(isSelected ? null : conn.id)
                    : undefined
                }
                onMouseEnter={
                  conn ? () => setHover({ type: "wire", id: conn.id }) : undefined
                }
                onMouseLeave={() => setHover(null)}
              >
                <rect
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  rx={8}
                  fill="#111827"
                  stroke={color}
                  strokeDasharray="4 4"
                  strokeWidth={isSelected ? 2.2 : 1.3}
                />
                <text
                  x={x + w / 2}
                  y={y + 17}
                  textAnchor="middle"
                  fill="#e2e8f0"
                  fontSize={11.5}
                  fontWeight={700}
                  fontFamily="ui-monospace, monospace"
                >
                  {name}
                </text>
                <text
                  x={x + w / 2}
                  y={y + 31}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize={8}
                  fontWeight={600}
                >
                  BACK PAD · NOT IN HEADERS
                </text>
              </g>
            );
          })}
        </svg>

        {/* board layer */}
        <div
          className="absolute z-10"
          style={{
            left: BOARD_X,
            top: WORLD_TOP,
            width: layout.viewWidth,
            height: layout.viewHeight,
          }}
        >
          <BoardVectorSvg
            board={board}
            orientation="vertical"
            className="h-full w-full"
            connectedHeaderKeys={connectedHeaderKeys}
            highlightedHeaderKeys={highlightedHeaderKeys}
            onPinClick={(hp) => {
              const key = `${hp.headerName}:${hp.position}`;
              selectFromPinKey(key);
            }}
            onPinHover={(hp) => {
              setHover(
                hp ? { type: "pin", headerKey: `${hp.headerName}:${hp.position}` } : null
              );
            }}
          />
        </div>

        {/* stage cards layer */}
        {stageCards.map(({ comp, x, y, h }) => (
          <ComponentCard
            key={comp.id}
            comp={comp}
            x={x}
            y={y}
            h={h}
            width={STAGE.w}
            hdr={STAGE.hdr}
            rowH={STAGE.rowH}
            align="stage"
          />
        ))}

        {/* aux tiles layer */}
        {auxTiles.map(({ comp, x, y, h }) => (
          <ComponentCard
            key={comp.id}
            comp={comp}
            x={x}
            y={y}
            h={h}
            width={AUX.w}
            hdr={AUX.hdr}
            rowH={AUX.rowH}
            align="aux"
          />
        ))}

        {/* module layer */}
        <div
          className="absolute z-10"
          style={{ left: MOD_X, top: moduleY, width: MOD.w }}
        >
          <div
            className={cn(
              "overflow-hidden rounded-2xl border shadow-[0_18px_48px_rgba(0,0,0,0.45)]",
              onboardOnly ? "border-amber-400/40" : "border-slate-700/70"
            )}
            style={{
              background:
                "linear-gradient(168deg, #1b2433 0%, #131924 52%, #0f141d 100%)",
            }}
          >
            {/* module header */}
            <div
              className="flex items-center gap-3 border-b border-white/5 px-4"
              style={{ height: MOD.headerH }}
            >
              <div
                className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-100"
                aria-hidden="true"
              >
                <ModuleGlyph kind={result.entityKind} typeLabel={result.entity?.typeLabel ?? ""} />
              </div>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold leading-tight text-slate-100">
                  {result.entityName}
                </p>
                <p className="mt-0.5 truncate text-[10.5px] font-medium leading-tight text-slate-400">
                  {result.entity?.typeLabel}
                  {result.entity?.driver ? ` · ${result.entity.driver.interfaceLabel}` : ""}
                </p>
                {onboardOnly && (
                  <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-300">
                    On-board · no external module
                  </span>
                )}
              </div>
            </div>
            {/* device illustration banner */}
            <div
              className="relative border-b border-white/5"
              style={{
                height: MOD.illusionH,
                background:
                  "radial-gradient(120% 150% at 50% 0%, rgba(56,189,248,0.10), rgba(15,23,42,0) 62%)",
              }}
            >
              <div className="absolute inset-2">
                <DeviceIllustration name={panelIllustration} />
              </div>
              <span className="absolute bottom-1 right-2 text-[7.5px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Generic class illustration
              </span>
            </div>
            {/* terminals */}
            <div style={{ padding: `${MOD.padY}px 12px` }}>
              {result.terminals.map((term) => {
                const conn = result.connections.find((c) => c.terminalId === term.id);
                const isSelected = conn?.id === selectedId;
                const circuitWired = circuitTerminalTargets.has(term.id);
                const roleColor =
                  term.role === "signal"
                    ? "#fb923c"
                    : term.role === "power"
                      ? "#f87171"
                      : term.role === "load"
                        ? "#ef4444"
                        : "#94a3b8";
                return (
                  <button
                    key={term.id}
                    type="button"
                    data-nopan="true"
                    onClick={() =>
                      conn && onSelectConnection(isSelected ? null : conn.id)
                    }
                    disabled={!conn}
                    aria-pressed={conn ? isSelected : undefined}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border border-transparent px-2 text-left transition-colors",
                      conn && "hover:bg-white/5",
                      term.role === "load" && "border-red-500/15 bg-red-500/[0.04]",
                      isSelected && "border-sky-400/40 bg-sky-400/10"
                    )}
                    style={{ height: MOD.termH, marginBottom: MOD.gap }}
                  >
                    {/* screw terminal */}
                    <span
                      className="flex size-6 shrink-0 items-center justify-center rounded-full border-2"
                      style={{
                        borderColor: roleColor,
                        background: "radial-gradient(circle at 38% 36%, #3b4757, #141a23)",
                        boxShadow: `0 0 0 2px rgba(0,0,0,0.35), inset 0 1px 2px rgba(255,255,255,0.25)`,
                      }}
                      aria-hidden="true"
                    >
                      <span className="size-1.5 rounded-full bg-slate-950" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="font-mono text-[11px] font-bold tracking-wide text-slate-100">
                          {term.label}
                          {term.role === "load" && (
                            <span className="ml-1.5 align-middle text-[7.5px] font-sans font-bold uppercase tracking-wider text-red-400/80">
                              Load
                            </span>
                          )}
                        </span>
                        <span className="text-[8.5px] font-semibold uppercase tracking-wider text-slate-500">
                          {conn
                            ? conn.kind === "Reference Rail"
                              ? "Reference"
                              : conn.kind === "Advisory Warning"
                                ? "Advisory"
                                : conn.kind === "Pin Conflict / Invalid"
                                  ? "Check pin"
                                  : conn.placement === "onboard"
                                    ? "On-board"
                                    : "Wired"
                            : circuitWired
                              ? "Circuit"
                              : "—"}
                        </span>
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-[9px] leading-snug text-slate-400">
                        {term.function}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* pill overlay — labels stay on top of cards and panels */}
        <svg
          className="pointer-events-none absolute left-0 top-0 z-30"
          width={worldWidth}
          height={worldHeight}
          viewBox={`0 0 ${worldWidth} ${worldHeight}`}
          aria-hidden="true"
        >
          {pillLayer.map((p) => (
            <g key={p.id}>
              <rect
                x={p.x}
                y={p.y}
                width={p.w}
                height={p.h}
                rx={p.h / 2}
                fill="#0f172a"
                fillOpacity={0.96}
                stroke={p.color}
                strokeOpacity={0.65}
                strokeWidth={1}
              />
              <text
                x={p.x + p.w / 2}
                y={p.y + p.h / 2 + (p.fontSize === 10 ? 3.5 : 3)}
                textAnchor="middle"
                fill="#e2e8f0"
                fontSize={p.fontSize}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                fontWeight={600}
              >
                {p.label}
              </text>
            </g>
          ))}
        </svg>
      </div>

      {/* watermark */}
      <div className="pointer-events-none absolute bottom-2 left-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-600">
        HomecoreOS · Logical pin assignment + circuit guidance — not a physical inspection
      </div>

      {/* zoom toolbar */}
      <div
        className="absolute bottom-3 right-3 flex items-center gap-1 rounded-xl border border-white/10 bg-[#0f172a]/90 p-1 shadow-lg backdrop-blur"
        data-nopan="true"
      >
        <button
          type="button"
          className="rounded-lg p-1.5 text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => zoomBy(1 / 1.25)}
          aria-label="Zoom out"
        >
          <RiZoomOutLine className="size-4" aria-hidden="true" />
        </button>
        <span className="w-11 text-center font-mono text-[10.5px] font-semibold tabular-nums text-slate-300">
          {zoomPercent}%
        </span>
        <button
          type="button"
          className="rounded-lg p-1.5 text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => zoomBy(1.25)}
          aria-label="Zoom in"
        >
          <RiZoomInLine className="size-4" aria-hidden="true" />
        </button>
        <div className="mx-0.5 h-4 w-px bg-white/10" aria-hidden="true" />
        <button
          type="button"
          className="rounded-lg p-1.5 text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          onClick={fit}
          aria-label="Fit to screen"
          title="Fit to screen"
        >
          <RiFullscreenLine className="size-4" aria-hidden="true" />
        </button>
      </div>

      {/* hover tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none absolute z-30 w-60 rounded-lg border border-white/10 bg-[#0f172a]/95 p-2.5 shadow-xl backdrop-blur"
          style={{
            left: clamp(cursor.x + 14, 8, (containerRef.current?.clientWidth ?? 400) - 252),
            top: clamp(cursor.y + 14, 8, (containerRef.current?.clientHeight ?? 400) - 140),
          }}
        >
          <p className="font-mono text-[10.5px] font-bold text-slate-100">{tooltip.title}</p>
          {tooltip.lines.map((line, i) => (
            <p
              key={i}
              className={cn(
                "mt-0.5 text-[9.5px] leading-snug text-slate-400",
                line.startsWith("⚠") && "text-amber-400/90"
              )}
            >
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component card — shared renderer for driver-stage parts and supply/load tiles
// ---------------------------------------------------------------------------
function ComponentCard({
  comp,
  x,
  y,
  h,
  width,
  hdr,
  rowH,
  align,
}: {
  comp: CircuitComponent;
  x: number;
  y: number;
  h: number;
  width: number;
  hdr: number;
  rowH: number;
  align: "stage" | "aux";
}) {
  const isMains = comp.kind === "ac_mains";
  const isConditional = comp.certainty === "conditional";
  const accent = isMains ? "#ef4444" : align === "stage" ? "#22d3ee" : "#f59e0b";
  return (
    <div
      className="absolute z-10"
      style={{ left: x, top: y, width, height: h }}
      data-component-id={comp.id}
    >
      <div
        className={cn(
          "relative flex h-full flex-col overflow-visible rounded-2xl border shadow-[0_12px_36px_rgba(0,0,0,0.4)]",
          isConditional && "border-dashed"
        )}
        style={{
          background: isMains
            ? "linear-gradient(172deg, #2a0f0f 0%, #1d0b0b 60%, #160808 100%)"
            : "linear-gradient(172deg, #16202e 0%, #10161f 60%, #0d1118 100%)",
          borderColor: isMains
            ? "rgba(239,68,68,0.5)"
            : isConditional
              ? "rgba(245,158,11,0.45)"
              : align === "stage"
                ? "rgba(34,211,238,0.28)"
                : "rgba(245,158,11,0.3)",
        }}
      >
        {/* card header */}
        <div
          className="flex items-center gap-2 border-b border-white/5 px-2.5"
          style={{ height: hdr }}
        >
          <span
            className="size-8 shrink-0 rounded-md border bg-black/30 p-0.5"
            style={{ borderColor: `${accent}55` }}
            aria-hidden="true"
          >
            <DeviceIllustration name={comp.illustration ?? "appliance"} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[10px] font-bold leading-tight text-slate-100">
              {comp.label}
            </span>
            <span className="mt-0.5 block truncate text-[8px] font-semibold uppercase tracking-wider text-slate-500">
              {comp.value ? (
                <span className="font-mono normal-case text-slate-400">{comp.value}</span>
              ) : (
                "Rating not documented"
              )}
            </span>
          </span>
        </div>
        {/* pin rows */}
        <div className="relative flex-1" style={{ padding: "12px 0" }}>
          {comp.pins.filter((pin) => pin.edge === "left" || pin.edge === "right" || pin.edge === undefined).map((pin) => {
            const top = 12 + pin.row * rowH;
            // Aux tiles always face the module — pins anchored on the left edge.
            const leftEdge = align === "aux" ? true : pin.edge === "left";
            return (
              <div
                key={pin.id}
                className="group/pin absolute left-0 right-0"
                style={{ top, height: rowH }}
                data-component-pin={`${comp.id}:${pin.id}`}
              >
                {/* pin dot on the card edge */}
                <span
                  className="absolute top-1/2 size-3.5 -translate-y-1/2 rounded-full border-2 border-[#0b1017]"
                  style={{
                    background: pin.domain === "load" ? "#f87171" : accent,
                    [leftEdge ? "left" : "right"]: -7,
                  } as React.CSSProperties}
                  aria-hidden="true"
                />
                <span
                  className={cn(
                    "absolute top-1/2 flex -translate-y-1/2 flex-col justify-center px-3 leading-tight",
                    leftEdge ? "left-1 items-start" : "right-1 items-end"
                  )}
                >
                  <span className="font-mono text-[9.5px] font-bold text-slate-200">
                    {pin.label}
                  </span>
                </span>
              </div>
            );
          })}
          {/* role note */}
          <p
            className="absolute bottom-0.5 left-0 right-0 truncate px-3 text-[7.5px] font-medium uppercase tracking-wider text-slate-600"
            title={comp.role}
          >
            {comp.role}
          </p>
        </div>
        {/* top / bottom edge pins (gate-drive hop) */}
        {comp.pins
          .filter((pin) => pin.edge === "top" || pin.edge === "bottom")
          .map((pin) => {
            const isTop = pin.edge === "top";
            return (
              <div
                key={pin.id}
                className="group/pin absolute left-0 right-0"
                style={{ top: isTop ? -7 : undefined, bottom: isTop ? undefined : -7, height: 14 }}
                data-component-pin={`${comp.id}:${pin.id}`}
              >
                <span
                  className="absolute left-1/2 top-0 size-3.5 -translate-x-1/2 rounded-full border-2 border-[#0b1017]"
                  style={{ background: pin.domain === "load" ? "#f87171" : accent }}
                  title={pin.label}
                  aria-hidden="true"
                />
              </div>
            );
          })}
        {/* badges */}
        {(isMains || isConditional) && (
          <div className="absolute right-1.5 top-1.5 flex gap-1">
            {isMains && (
              <span className="flex items-center gap-0.5 rounded-full border border-red-500/60 bg-red-600/20 px-1.5 py-0.5 text-[7.5px] font-black uppercase tracking-wider text-red-300">
                <RiAlertLine className="size-2.5" aria-hidden="true" />
                Mains
              </span>
            )}
            {isConditional && (
              <span className="rounded-full border border-amber-500/50 bg-amber-500/15 px-1.5 py-0.5 text-[7.5px] font-bold uppercase tracking-wider text-amber-300">
                If needed
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ModuleGlyph({
  kind,
  typeLabel,
}: {
  kind: WireDiagramResult["entityKind"];
  typeLabel: string;
}) {
  const cls = "size-5";
  const lower = typeLabel.toLowerCase();
  if (kind === "switch") return <RiToggleLine className={cls} aria-hidden="true" />;
  if (lower.includes("lock")) return <RiLockLine className={cls} aria-hidden="true" />;
  if (lower.includes("temp") || lower.includes("humid") || lower.includes("climate"))
    return <RiTempColdLine className={cls} aria-hidden="true" />;
  if (lower.includes("relay")) return <RiPlug2Line className={cls} aria-hidden="true" />;
  return <RiFlashlightLine className={cls} aria-hidden="true" />;
}
