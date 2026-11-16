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
} from "@remixicon/react";
import type { WireDiagramResult, GpioPinDefinition } from "@homecoreos/shared";
import {
  BoardVectorSvg,
  getBoardVectorVerticalLayout,
} from "@/components/boards/BoardVectorSvg";
import type { BoardProfileItem } from "@/features/types";
import { cn } from "@/lib/utils";
import { pinCapabilityList, wireColor, wireDash, wireLabel } from "./wire-diagram-shared";

// ---------------------------------------------------------------------------
// Geometry constants (world units)
// ---------------------------------------------------------------------------
const WORLD_TOP = 116;
const BOARD_X = 64;
const MOD = {
  x: 648,
  w: 330,
  headerH: 64,
  padY: 14,
  termH: 52,
  gap: 6,
};
const PITCH = MOD.termH + MOD.gap;
const LABEL_FILL = "#64748b";

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
    | null
  >(null);

  const layout = useMemo(() => getBoardVectorVerticalLayout(board), [board]);
  const drawn = useMemo(
    () =>
      result.connections.filter(
        (c) => c.placement === "header" || c.placement === "extra_pad"
      ),
    [result.connections]
  );
  const onboardOnly = drawn.length === 0 && result.connections.some((c) => c.placement === "onboard");
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

  const moduleHeight =
    MOD.headerH + MOD.padY * 2 + result.terminals.length * PITCH - MOD.gap;
  const moduleY = Math.max(
    12,
    WORLD_TOP + (layout.viewHeight - moduleHeight) / 2
  );
  const worldWidth = MOD.x + MOD.w + 48;
  const worldHeight = Math.max(
    WORLD_TOP + layout.viewHeight + 84,
    moduleY + moduleHeight + 84,
    560
  );

  const termPoint = useCallback(
    (terminalId: string): { x: number; y: number } => {
      const idx = terminalIndex.get(terminalId) ?? 0;
      return {
        x: MOD.x,
        y: moduleY + MOD.headerH + MOD.padY + idx * PITCH + MOD.termH / 2,
      };
    },
    [moduleY, terminalIndex]
  );

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
      const end = termPoint(conn.terminalId);
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

    leftWires.forEach((conn, i) => {
      const anchor = anchorsByKey.get(conn.headerKey!)!;
      const start = { x: BOARD_X + anchor.edgeX, y: WORLD_TOP + anchor.cy };
      const end = termPoint(conn.terminalId);
      const exitX = pcbLeft - 16 - i * 24;
      const topY = 24 + i * 17;
      const dropX = MOD.x - 16 - i * 24;
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
      const end = termPoint(conn.terminalId);
      const chipW = 118;
      const chipH = 40;
      const total = extraWires.length * (chipW + 14) - 14;
      const chipX = BOARD_X + (layout.viewWidth - total) / 2 + i * (chipW + 14);
      const chipY = bottomY + 14;
      const start = { x: chipX + chipW / 2, y: chipY };
      const floorY = bottomY + 34 + i * 17 + chipH - 12;
      const dropX = MOD.x - 16 - (leftWires.length + i) * 24;
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
  }, [anchorsByKey, drawn, layout.pcbW, layout.pcbX, layout.viewHeight, layout.viewWidth, termPoint]);

  const extraChips = useMemo(() => {
    const chips = drawn.filter((c) => c.placement === "extra_pad");
    const bottomY = WORLD_TOP + layout.viewHeight;
    const chipW = 118;
    const chipH = 40;
    const total = chips.length * (chipW + 14) - 14;
    const start = BOARD_X + (layout.viewWidth - total) / 2;
    return chips.map((conn, i) => ({
      conn,
      x: start + i * (chipW + 14),
      y: bottomY + 14,
      w: chipW,
      h: chipH,
    }));
  }, [drawn, layout.viewHeight, layout.viewWidth]);

  const selected = result.connections.find((c) => c.id === selectedId) ?? null;
  const connectedHeaderKeys = useMemo(
    () =>
      new Set(
        result.connections
          .map((c) => c.headerKey)
          .filter((k): k is string => Boolean(k))
      ),
    [result.connections]
  );
  const highlightedHeaderKeys = useMemo(
    () =>
      new Set(
        selected?.headerKey ? [selected.headerKey] : []
      ),
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

  const boardStamp = `${board.id}:${layout.viewWidth}x${layout.viewHeight}:${result.terminals.length}`;
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

  const zoomBy = useCallback(
    (factor: number) => {
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
    },
    []
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // Interactive controls (wires, terminals, toolbar, chips) opt out of panning.
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

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
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
    },
    []
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId === e.pointerId) {
      if (drag.moved) suppressClickRef.current = true;
      dragRef.current = null;
    }
    setDragging(false);
  }, []);

  const handleClickCapture = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    []
  );

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
      tooltip = {
        title:
          hp.gpioPin !== null
            ? `GPIO${hp.gpioPin} · pad "${hp.pinName}"`
            : `Pad "${hp.pinName}"`,
        lines: [
          `${anchor.side === "left" ? "Left" : "Right"} header · pin ${hp.position}${hp.note ? ` · ${hp.note}` : ""}`,
          caps.length > 0 ? `Functions: ${caps.join(" · ")}` : "No GPIO functions documented",
          ...(restrictions.length > 0 ? [`⚠ ${restrictions.join(" · ")}`] : []),
          ...(wired ? [`Wired → ${wired.signal} (click to inspect)`] : ["Not wired in this diagram"]),
        ],
      };
    }
  } else if (hover?.type === "wire") {
    const conn = result.connections.find((c) => c.id === hover.id);
    if (conn) {
      tooltip = {
        title: `${conn.terminalLabel} · ${conn.signal}`,
        lines: [
          conn.pin !== null ? `GPIO${conn.pin}${conn.pinName ? ` (pad ${conn.pinName})` : ""}` : conn.headerName ?? "Reference",
          conn.kind,
          `Voltage: ${conn.voltage}`,
        ],
      };
    }
  }

  const zoomPercent = Math.round(view.k * 100);

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
        {/* wires layer */}
        <svg
          className="absolute left-0 top-0"
          width={worldWidth}
          height={worldHeight}
          viewBox={`0 0 ${worldWidth} ${worldHeight}`}
        >
          {/* area captions */}
          <text x={BOARD_X} y={WORLD_TOP - 16} fill={LABEL_FILL} fontSize={10} fontWeight={700} letterSpacing={2}>
            CONTROLLER
          </text>
          <text x={MOD.x} y={moduleY - 16} fill={LABEL_FILL} fontSize={10} fontWeight={700} letterSpacing={2}>
            {result.entityKind === "sensor" ? "SENSOR" : result.entityKind === "device" ? "DEVICE" : "SWITCH CHANNEL"}
          </text>

          {/* wires */}
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
                {/* endpoint dots */}
                <circle cx={route.startX} cy={route.startY} r={4.2} fill={color} stroke="#0b1017" strokeWidth={1.6} pointerEvents="none" />
                <circle cx={route.endX} cy={route.endY} r={4.2} fill={color} stroke="#0b1017" strokeWidth={1.6} pointerEvents="none" />
                {/* label pill */}
                <g pointerEvents="none">
                  <rect
                    x={route.labelX - (wireLabel(conn).length * 3.35 + 9)}
                    y={route.labelY - 9}
                    width={wireLabel(conn).length * 6.7 + 18}
                    height={18}
                    rx={9}
                    fill="#0f172a"
                    stroke={color}
                    strokeOpacity={0.55}
                    strokeWidth={1}
                  />
                  <text
                    x={route.labelX}
                    y={route.labelY + 3.5}
                    textAnchor="middle"
                    fill="#e2e8f0"
                    fontSize={10}
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    fontWeight={600}
                  >
                    {wireLabel(conn)}
                  </text>
                </g>
                {/* fat invisible hit target */}
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

          {/* extra (back) pads not drawn on the headers */}
          {extraChips.map(({ conn, x, y, w, h }) => {
            const color = wireColor(conn);
            const isSelected = conn.id === selectedId;
            return (
              <g
                key={conn.id}
                data-nopan="true"
                className="cursor-pointer"
                onClick={() => onSelectConnection(isSelected ? null : conn.id)}
                onMouseEnter={() => setHover({ type: "wire", id: conn.id })}
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
                  {conn.extraPadName ?? "PAD"}
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

        {/* module layer */}
        <div
          className="absolute z-10"
          style={{ left: MOD.x, top: moduleY, width: MOD.w }}
        >
          <div
            className={cn(
              "overflow-hidden rounded-2xl border shadow-[0_18px_48px_rgba(0,0,0,0.45)]",
              onboardOnly
                ? "border-amber-400/40"
                : "border-slate-700/70"
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
            {/* terminals */}
            <div style={{ padding: `${MOD.padY}px 12px` }}>
              {result.terminals.map((term) => {
                const conn = result.connections.find((c) => c.terminalId === term.id);
                const isSelected = conn?.id === selectedId;
                const roleColor =
                  term.role === "signal"
                    ? "#fb923c"
                    : term.role === "power"
                      ? "#f87171"
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
      </div>

      {/* watermark */}
      <div className="pointer-events-none absolute bottom-2 left-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-600">
        HomecoreOS · Logical pin assignment — not a physical inspection
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
          className="pointer-events-none absolute z-30 w-56 rounded-lg border border-white/10 bg-[#0f172a]/95 p-2.5 shadow-xl backdrop-blur"
          style={{
            left: clamp(cursor.x + 14, 8, (containerRef.current?.clientWidth ?? 400) - 232),
            top: clamp(cursor.y + 14, 8, (containerRef.current?.clientHeight ?? 400) - 120),
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
