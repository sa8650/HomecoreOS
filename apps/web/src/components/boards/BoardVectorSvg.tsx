import { useId } from "react";
import {
  resolveBoardHardwareSpecs,
  type BoardHeaderPin,
  type GpioPinDefinition,
} from "@homecoreos/shared";
import type { BoardProfileItem } from "@/features/types";
import { cn } from "@/lib/utils";

export type SvgPinTone =
  | "safe"
  | "warning"
  | "shared"
  | "blocked"
  | "input"
  | "power"
  | "ground"
  | "reset"
  | "nc";

const PIN_TONE_COLOR: Record<SvgPinTone, string> = {
  safe: "#10b981",
  warning: "#f59e0b",
  shared: "#38bdf8",
  blocked: "#f43f5e",
  input: "#a78bfa",
  power: "#fb923c",
  ground: "#94a3b8",
  reset: "#818cf8",
  nc: "#64748b",
};

export function resolveBoardPinRails(board: BoardProfileItem): {
  left: BoardHeaderPin[];
  right: BoardHeaderPin[];
  leftName: string;
  rightName: string;
} {
  const layout = board.board_layout;
  if (
    layout &&
    (layout.leftHeader?.pins?.length > 0 || layout.rightHeader?.pins?.length > 0)
  ) {
    return {
      left: layout.leftHeader?.pins ?? [],
      right: layout.rightHeader?.pins ?? [],
      leftName: layout.leftHeader?.name ?? "J1",
      rightName: layout.rightHeader?.name ?? "J3",
    };
  }

  // Synthesize symmetric headers for custom or unverified boards lacking board_layout
  const sorted = [...board.gpio_definitions].sort((a, b) => a.pin - b.pin);
  const half = Math.ceil(sorted.length / 2);
  const left: BoardHeaderPin[] = [
    { position: 1, headerName: "J1", pinName: "3V3", gpioPin: null, kind: "power", voltage: "3.3V" },
    { position: 2, headerName: "J1", pinName: "RST", gpioPin: null, kind: "reset", note: "Reset" },
    ...sorted.slice(0, half).map((g, idx) => ({
      position: idx + 3,
      headerName: "J1",
      pinName: g.board_pin_name ?? String(g.pin),
      gpioPin: g.pin,
      kind: "gpio" as const,
      note: g.board_note ?? undefined,
    })),
    { position: half + 3, headerName: "J1", pinName: "5V", gpioPin: null, kind: "power", voltage: "5V" },
    { position: half + 4, headerName: "J1", pinName: "G", gpioPin: null, kind: "ground", voltage: "GND" },
  ];
  const right: BoardHeaderPin[] = [
    { position: 1, headerName: "J3", pinName: "G", gpioPin: null, kind: "ground", voltage: "GND" },
    ...sorted.slice(half).map((g, idx) => ({
      position: idx + 2,
      headerName: "J3",
      pinName: g.board_pin_name ?? String(g.pin),
      gpioPin: g.pin,
      kind: "gpio" as const,
      note: g.board_note ?? undefined,
    })),
    { position: sorted.length - half + 2, headerName: "J3", pinName: "G", gpioPin: null, kind: "ground", voltage: "GND" },
  ];
  return { left, right, leftName: "J1", rightName: "J3" };
}

function pinToneForHeaderPin(
  hp: BoardHeaderPin,
  gpioByPin: Map<number, GpioPinDefinition>,
  usedPins?: Set<number>
): SvgPinTone {
  if (hp.kind === "power") return "power";
  if (hp.kind === "ground") return "ground";
  if (hp.kind === "reset") return "reset";
  if (hp.kind === "nc") return "nc";
  if (hp.gpioPin === null) return "nc";
  const def = gpioByPin.get(hp.gpioPin);
  if (!def) return "safe";
  if (def.restrictions.flash_psram_conflict || def.restrictions.reserved) return "blocked";
  if (usedPins?.has(def.pin)) return "blocked";
  if (def.restrictions.input_only) return "input";
  if (def.restrictions.strapping_pin) return "warning";
  if (def.restrictions.usb_jtag_conflict || (hp.note && /led|rgb|uart/i.test(hp.note))) {
    return "shared";
  }
  return "safe";
}

function shortSilkLabel(hp: BoardHeaderPin): string {
  const raw = hp.pinName.trim();
  if (raw.includes("/")) {
    const first = raw.split("/")[0]!.trim();
    return first.length <= 4 ? first : raw.slice(0, 4);
  }
  return raw;
}

export function getVectorVerticalPinPercents(board: BoardProfileItem): {
  pinTopPct: number;
  pinBottomPct: number;
} {
  const specs = resolveBoardHardwareSpecs(board);
  if (specs.modulePackage === "xiao" || board.board_layout?.formFactor === "xiao") {
    return { pinTopPct: 23.3, pinBottomPct: 82.8 };
  }
  return { pinTopPct: 14.8, pinBottomPct: 88.4 };
}

export interface BoardVectorSvgProps {
  board: BoardProfileItem;
  orientation?: "horizontal" | "vertical";
  compact?: boolean;
  className?: string;
  usedPins?: Set<number>;
  selectedPin?: number | null;
  activeHeaderPin?: BoardHeaderPin | null;
  pinDimmed?: (hp: BoardHeaderPin) => boolean;
  onPinClick?: (hp: BoardHeaderPin) => void;
  onPinHover?: (hp: BoardHeaderPin | null) => void;
}

export function BoardVectorSvg({
  board,
  orientation = "horizontal",
  compact = false,
  className,
  usedPins,
  selectedPin = null,
  activeHeaderPin = null,
  pinDimmed,
  onPinClick,
  onPinHover,
}: BoardVectorSvgProps) {
  const rawId = useId();
  const uid = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const specs = resolveBoardHardwareSpecs(board);
  const { left, right } = resolveBoardPinRails(board);
  const gpioByPin = new Map(board.gpio_definitions.map((g) => [g.pin, g]));

  const isXiao = specs.modulePackage === "xiao" || board.board_layout?.formFactor === "xiao";
  const isMini = specs.modulePackage === "mini" || specs.modulePackage === "solo";
  const hasRgbLed =
    board.board_layout?.onboardFeatures?.some((f) => f.kind === "rgb_led") ?? !isXiao;
  const hasUserLed =
    board.board_layout?.onboardFeatures?.some((f) => f.kind === "led") ?? isXiao;
  const isNoWifi = board.chip_family === "esp32h2" || board.chip_family === "esp32h4" || board.chip_family === "esp32p4";
  const isDualBand = board.chip_family === "esp32c5";
  const interactive = Boolean(onPinClick || onPinHover);

  const isPinHighlighted = (hp: BoardHeaderPin) =>
    (selectedPin !== null && hp.gpioPin === selectedPin) ||
    (activeHeaderPin?.headerName === hp.headerName &&
      activeHeaderPin?.position === hp.position) ||
    (hp.gpioPin !== null &&
      activeHeaderPin?.gpioPin !== null &&
      activeHeaderPin?.gpioPin === hp.gpioPin);

  const defs = (
    <defs>
      <linearGradient id={`${uid}-pcb`} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#1b1f25" />
        <stop offset="55%" stopColor="#13161b" />
        <stop offset="100%" stopColor="#0d0f13" />
      </linearGradient>
      <linearGradient id={`${uid}-shield`} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#dde2e7" />
        <stop offset="28%" stopColor="#adb5bf" />
        <stop offset="55%" stopColor="#cfd5dc" />
        <stop offset="82%" stopColor="#8d959f" />
        <stop offset="100%" stopColor="#b9c0c8" />
      </linearGradient>
      <linearGradient id={`${uid}-shield-dark`} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#434a54" />
        <stop offset="45%" stopColor="#2b3038" />
        <stop offset="100%" stopColor="#1c2026" />
      </linearGradient>
      <linearGradient id={`${uid}-metal`} x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#eef2f6" />
        <stop offset="35%" stopColor="#a7b0ba" />
        <stop offset="70%" stopColor="#cfd5dc" />
        <stop offset="100%" stopColor="#77808b" />
      </linearGradient>
      <linearGradient id={`${uid}-gold`} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#f4cf6b" />
        <stop offset="50%" stopColor="#d7a338" />
        <stop offset="100%" stopColor="#9c6e18" />
      </linearGradient>
      <radialGradient id={`${uid}-pwr-glow`} cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#ff4d42" stopOpacity="1" />
        <stop offset="45%" stopColor="#ff2e22" stopOpacity="0.55" />
        <stop offset="100%" stopColor="#ff2e22" stopOpacity="0" />
      </radialGradient>
      <radialGradient id={`${uid}-rgb-glow`} cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#5eead4" stopOpacity="0.95" />
        <stop offset="45%" stopColor="#38bdf8" stopOpacity="0.45" />
        <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
      </radialGradient>
      <radialGradient id={`${uid}-amber-glow`} cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#fbbf24" stopOpacity="1" />
        <stop offset="55%" stopColor="#f59e0b" stopOpacity="0.45" />
        <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
      </radialGradient>
      <filter id={`${uid}-shadow`} x="-10%" y="-10%" width="120%" height="125%">
        <feDropShadow dx="0" dy="3" stdDeviation="3.5" floodColor="#000000" floodOpacity="0.55" />
      </filter>
    </defs>
  );

  // ============================================================================
  // 1. SEEED STUDIO XIAO (HORIZONTAL OR VERTICAL)
  // ============================================================================
  if (isXiao) {
    if (orientation === "vertical") {
      const vw = 260;
      const vh = 360;
      const pcbX = 36;
      const pcbY = 34;
      const pcbW = 188;
      const pcbH = 296;
      const yTop = 84;
      const yBot = 298;
      const leftStep = left.length > 1 ? (yBot - yTop) / (left.length - 1) : 0;
      const rightStep = right.length > 1 ? (yBot - yTop) / (right.length - 1) : 0;

      const renderXiaoVertPad = (
        hp: BoardHeaderPin,
        side: "left" | "right",
        idx: number,
        step: number
      ) => {
        const cy = yTop + idx * step;
        const cx = side === "left" ? pcbX + 6 : pcbX + pcbW - 6;
        const tone = pinToneForHeaderPin(hp, gpioByPin, usedPins);
        const color = PIN_TONE_COLOR[tone];
        const active = isPinHighlighted(hp);
        const dimmed = pinDimmed ? pinDimmed(hp) : false;

        return (
          <g
            key={`xv-${side}-${hp.position}`}
            data-svg-pin={hp.pinName}
            opacity={dimmed ? 0.25 : 1}
            className={interactive ? "cursor-pointer" : undefined}
            onClick={onPinClick ? () => onPinClick(hp) : undefined}
            onMouseEnter={onPinHover ? () => onPinHover(hp) : undefined}
            onMouseLeave={onPinHover ? () => onPinHover(null) : undefined}
          >
            {/* Castellated gold pad extending to PCB edge */}
            <rect
              x={side === "left" ? pcbX - 4 : pcbX + pcbW - 14}
              y={cy - 8}
              width={18}
              height={16}
              rx={5}
              fill={`url(#${uid}-gold)`}
              stroke={active ? "#38bdf8" : "#745011"}
              strokeWidth={active ? 2 : 0.8}
            />
            <circle cx={cx} cy={cy} r={3.8} fill="#0b0d11" />
            {active && (
              <circle
                cx={cx}
                cy={cy}
                r={10}
                fill="none"
                stroke="#38bdf8"
                strokeWidth={1.8}
              />
            )}
            <circle
              cx={side === "left" ? pcbX - 8 : pcbX + pcbW + 8}
              cy={cy}
              r={2.4}
              fill={color}
            />
            <text
              x={side === "left" ? pcbX + 20 : pcbX + pcbW - 20}
              y={cy + 3.2}
              textAnchor={side === "left" ? "start" : "end"}
              fill="#e2e8f0"
              fontSize="8.5"
              fontWeight="700"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              {shortSilkLabel(hp)}
            </text>
          </g>
        );
      };

      return (
        <svg
          viewBox={`0 0 ${vw} ${vh}`}
          className={cn("select-none", className)}
          role="img"
          aria-label={`${board.manufacturer} ${board.model} vector PCB diagram`}
        >
          {defs}
          {/* Main compact XIAO PCB */}
          <rect
            x={pcbX}
            y={pcbY}
            width={pcbW}
            height={pcbH}
            rx={18}
            fill={`url(#${uid}-pcb)`}
            stroke="#2f3640"
            strokeWidth={1.6}
            filter={`url(#${uid}-shadow)`}
          />
          <rect
            x={pcbX + 4}
            y={pcbY + 4}
            width={pcbW - 8}
            height={pcbH - 8}
            rx={15}
            fill="none"
            stroke="#4b5563"
            strokeWidth={0.7}
            strokeDasharray="3 3"
            opacity={0.45}
          />

          {/* Top USB Type-C Metallic Receptacle */}
          <rect
            x={vw / 2 - 32}
            y={12}
            width={64}
            height={44}
            rx={7}
            fill={`url(#${uid}-metal)`}
            stroke="#4a525d"
            strokeWidth={1.2}
          />
          <rect
            x={vw / 2 - 22}
            y={15}
            width={44}
            height={14}
            rx={5}
            fill="#14171c"
          />
          <rect
            x={vw / 2 - 14}
            y={19}
            width={28}
            height={4}
            rx={1.5}
            fill="#d4a02b"
          />

          {/* Top Left CHG LED (green) & Top Right USER LED (amber) */}
          <circle cx={pcbX + 26} cy={pcbY + 22} r={8} fill={`url(#${uid}-rgb-glow)`} />
          <rect x={pcbX + 22} y={pcbY + 19} width={8} height={5} rx={1} fill="#34d399" />
          <text x={pcbX + 34} y={pcbY + 24} fill="#9ca3af" fontSize="6" fontFamily="monospace">
            CHG
          </text>

          <circle cx={pcbX + pcbW - 26} cy={pcbY + 22} r={8} fill={`url(#${uid}-amber-glow)`} />
          <rect x={pcbX + pcbW - 30} y={pcbY + 19} width={8} height={5} rx={1} fill="#fbbf24" />
          <text
            x={pcbX + pcbW - 34}
            y={pcbY + 24}
            textAnchor="end"
            fill="#9ca3af"
            fontSize="6"
            fontFamily="monospace"
          >
            USR
          </text>

          {/* Micro Tactile RESET (Left) and BOOT (Right) Buttons */}
          <g>
            <rect x={pcbX + 18} y={pcbY + 34} width={22} height={14} rx={2} fill={`url(#${uid}-metal)`} />
            <circle cx={pcbX + 29} cy={pcbY + 41} r={4} fill="#1f242c" />
            <text x={pcbX + 44} y={pcbY + 43} fill="#cbd5e1" fontSize="6.5" fontWeight="700" fontFamily="monospace">
              R
            </text>
          </g>
          <g>
            <rect x={pcbX + pcbW - 40} y={pcbY + 34} width={22} height={14} rx={2} fill={`url(#${uid}-metal)`} />
            <circle cx={pcbX + pcbW - 29} cy={pcbY + 41} r={4} fill="#1f242c" />
            <text
              x={pcbX + pcbW - 44}
              y={pcbY + 43}
              textAnchor="end"
              fill="#cbd5e1"
              fontSize="6.5"
              fontWeight="700"
              fontFamily="monospace"
            >
              B
            </text>
          </g>

          {/* Center Dark Titanium RF Shield */}
          <rect
            x={vw / 2 - 46}
            y={104}
            width={92}
            height={142}
            rx={6}
            fill={`url(#${uid}-shield-dark)`}
            stroke="#64748b"
            strokeWidth={1.2}
          />
          <text
            x={vw / 2}
            y={144}
            textAnchor="middle"
            fill="#cbd5e1"
            fontSize="7.5"
            fontWeight="700"
            letterSpacing="0.8"
            fontFamily="ui-sans-serif, system-ui, sans-serif"
          >
            SEEED STUDIO
          </text>
          <text
            x={vw / 2}
            y={166}
            textAnchor="middle"
            fill="#f8fafc"
            fontSize="9.5"
            fontWeight="800"
            fontFamily="ui-monospace, monospace"
          >
            XIAO ESP32S3
          </text>
          <text
            x={vw / 2}
            y={184}
            textAnchor="middle"
            fill="#94a3b8"
            fontSize="7.5"
            fontFamily="ui-monospace, monospace"
          >
            {board.chip_variant}
          </text>
          <text
            x={vw / 2}
            y={204}
            textAnchor="middle"
            fill="#fbbf24"
            fontSize="7"
            fontWeight="600"
            fontFamily="ui-monospace, monospace"
          >
            {specs.memory}
          </text>

          {/* Bottom Gold U.FL RF Connector */}
          <circle cx={vw / 2 + 28} cy={pcbY + pcbH - 22} r={10} fill={`url(#${uid}-gold)`} stroke="#745011" />
          <circle cx={vw / 2 + 28} cy={pcbY + pcbH - 22} r={5.5} fill="#0d0f13" />
          <circle cx={vw / 2 + 28} cy={pcbY + pcbH - 22} r={2.2} fill={`url(#${uid}-gold)`} />
          <text x={vw / 2 - 22} y={pcbY + pcbH - 19} fill="#9ca3af" fontSize="6.5" fontFamily="monospace">
            U.FL ANT
          </text>

          {/* Left & Right Castellated Pin Pads */}
          {left.map((hp, idx) => renderXiaoVertPad(hp, "left", idx, leftStep))}
          {right.map((hp, idx) => renderXiaoVertPad(hp, "right", idx, rightStep))}
        </svg>
      );
    }

    // HORIZONTAL XIAO (Board Library Card matching image-3.png!)
    // +90 CW: U.FL / Module on LEFT, USB-C on RIGHT
    // TOP = leftHeader reversed (D6..D0), BOTTOM = rightHeader reversed (D7..5V)
    const vw = 640;
    const vh = 300;
    const pcbX = 116;
    const pcbY = 44;
    const pcbW = 394;
    const pcbH = 212;
    const topPins = [...left].reverse();
    const botPins = [...right].reverse();
    const xStart = 178;
    const xEnd = 456;
    const topStep = topPins.length > 1 ? (xEnd - xStart) / (topPins.length - 1) : 0;
    const botStep = botPins.length > 1 ? (xEnd - xStart) / (botPins.length - 1) : 0;

    const renderXiaoHorizPad = (
      hp: BoardHeaderPin,
      row: "top" | "bottom",
      idx: number,
      step: number
    ) => {
      const cx = xStart + idx * step;
      const cy = row === "top" ? pcbY + 8 : pcbY + pcbH - 8;
      const tone = pinToneForHeaderPin(hp, gpioByPin, usedPins);
      const active = isPinHighlighted(hp);
      const dimmed = pinDimmed ? pinDimmed(hp) : false;
      return (
        <g
          key={`xh-${row}-${hp.position}`}
          data-svg-pin={hp.pinName}
          opacity={dimmed ? 0.25 : 1}
          className={interactive ? "cursor-pointer" : undefined}
          onClick={onPinClick ? () => onPinClick(hp) : undefined}
          onMouseEnter={onPinHover ? () => onPinHover(hp) : undefined}
          onMouseLeave={onPinHover ? () => onPinHover(null) : undefined}
        >
          <rect
            x={cx - 10}
            y={row === "top" ? pcbY - 5 : pcbY + pcbH - 15}
            width={20}
            height={20}
            rx={6}
            fill={`url(#${uid}-gold)`}
            stroke={active ? "#38bdf8" : "#785312"}
            strokeWidth={active ? 1.8 : 0.9}
          />
          <circle cx={cx} cy={cy} r={4.5} fill="#0b0d11" />
          <circle cx={cx} cy={row === "top" ? pcbY - 12 : pcbY + pcbH + 12} r={2.2} fill={PIN_TONE_COLOR[tone]} />
          {!compact && (
            <text
              x={cx}
              y={row === "top" ? pcbY + 30 : pcbY + pcbH - 22}
              textAnchor="middle"
              fill="#e2e8f0"
              fontSize="10"
              fontWeight="700"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              {shortSilkLabel(hp)}
            </text>
          )}
        </g>
      );
    };

    return (
      <svg
        viewBox={`0 0 ${vw} ${vh}`}
        className={cn("select-none", className)}
        role="img"
        aria-label={`${board.manufacturer} ${board.model} vector PCB diagram`}
      >
        {defs}
        {/* Main XIAO PCB */}
        <rect
          x={pcbX}
          y={pcbY}
          width={pcbW}
          height={pcbH}
          rx={22}
          fill={`url(#${uid}-pcb)`}
          stroke="#2f3640"
          strokeWidth={1.8}
          filter={`url(#${uid}-shadow)`}
        />
        <rect
          x={pcbX + 5}
          y={pcbY + 5}
          width={pcbW - 10}
          height={pcbH - 10}
          rx={18}
          fill="none"
          stroke="#6a7782"
          strokeWidth={0.9}
          opacity={0.45}
        />

        {/* Gold U.FL RF Connector on LEFT */}
        <circle cx={pcbX + 34} cy={vh / 2 + 24} r={12} fill={`url(#${uid}-gold)`} stroke="#745011" strokeWidth={1} />
        <circle cx={pcbX + 34} cy={vh / 2 + 24} r={6.5} fill="#0b0d11" />
        <circle cx={pcbX + 34} cy={vh / 2 + 24} r={2.5} fill={`url(#${uid}-gold)`} />
        {!compact && (
          <text x={pcbX + 34} y={vh / 2 - 6} textAnchor="middle" fill="#9ca3af" fontSize="8" fontFamily="monospace">
            U.FL
          </text>
        )}

        {/* Center Dark-Titanium RF Shield */}
        <rect
          x={204}
          y={94}
          width={200}
          height={112}
          rx={8}
          fill={`url(#${uid}-shield-dark)`}
          stroke="#64748b"
          strokeWidth={1.3}
          filter={`url(#${uid}-shadow)`}
        />
        <text
          x={304}
          y={130}
          textAnchor="middle"
          fill="#cbd5e1"
          fontSize="9"
          fontWeight="700"
          letterSpacing="1.3"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
        >
          SEEED STUDIO
        </text>
        <text
          x={304}
          y={152}
          textAnchor="middle"
          fill="#f8fafc"
          fontSize="13.5"
          fontWeight="800"
          fontFamily="ui-monospace, monospace"
        >
          {board.model}
        </text>
        <text
          x={304}
          y={170}
          textAnchor="middle"
          fill="#38bdf8"
          fontSize="9.5"
          fontWeight="600"
          fontFamily="ui-monospace, monospace"
        >
          {board.chip_variant}
        </text>
        <text
          x={304}
          y={188}
          textAnchor="middle"
          fill="#fbbf24"
          fontSize="8.5"
          fontWeight="600"
          fontFamily="ui-monospace, monospace"
        >
          {specs.memory}
        </text>

        {/* Micro Tactile RESET (bottom-right) & BOOT (top-right) */}
        <g>
          <rect x={428} y={96} width={22} height={16} rx={2.5} fill={`url(#${uid}-metal)`} />
          <circle cx={439} cy={104} r={4.5} fill="#1f242c" />
          {!compact && (
            <text x={439} y={91} textAnchor="middle" fill="#cbd5e1" fontSize="7.5" fontWeight="700" fontFamily="monospace">
              BOOT
            </text>
          )}
        </g>
        <g>
          <rect x={428} y={188} width={22} height={16} rx={2.5} fill={`url(#${uid}-metal)`} />
          <circle cx={439} cy={196} r={4.5} fill="#1f242c" />
          {!compact && (
            <text x={439} y={214} textAnchor="middle" fill="#cbd5e1" fontSize="7.5" fontWeight="700" fontFamily="monospace">
              RST
            </text>
          )}
        </g>

        {/* USER (Amber) & CHG (Green) LEDs */}
        {hasUserLed && (
          <>
            <circle cx={438} cy={132} r={9} fill={`url(#${uid}-amber-glow)`} />
            <rect x={434} y={129} width={8} height={6} rx={1} fill="#fbbf24" />
          </>
        )}
        <circle cx={438} cy={166} r={9} fill={`url(#${uid}-rgb-glow)`} />
        <rect x={434} y={163} width={8} height={6} rx={1} fill="#34d399" />

        {/* Right USB Type-C Port */}
        <rect
          x={476}
          y={114}
          width={52}
          height={72}
          rx={8}
          fill={`url(#${uid}-metal)`}
          stroke="#475569"
          strokeWidth={1.3}
          filter={`url(#${uid}-shadow)`}
        />
        <rect x={510} y={124} width={14} height={52} rx={5} fill="#111318" />
        <rect x={515} y={133} width={4} height={34} rx={1.5} fill="#d4a02b" />

        {/* Castellated Top & Bottom Pads */}
        {topPins.map((hp, idx) => renderXiaoHorizPad(hp, "top", idx, topStep))}
        {botPins.map((hp, idx) => renderXiaoHorizPad(hp, "bottom", idx, botStep))}
      </svg>
    );
  }

  // ============================================================================
  // 2. ESPRESSIF DEVKIT VERTICAL (InteractiveBoardPinout Diagram)
  // ============================================================================
  if (orientation === "vertical") {
    const vw = 280;
    const vh = 620;
    const pcbX = 36;
    const pcbY = 28;
    const pcbW = 208;
    const pcbH = 562;
    const yTop = 92;
    const yBot = 548;
    const leftStep = left.length > 1 ? (yBot - yTop) / (left.length - 1) : 0;
    const rightStep = right.length > 1 ? (yBot - yTop) / (right.length - 1) : 0;

    const renderVertPin = (
      hp: BoardHeaderPin,
      side: "left" | "right",
      idx: number,
      step: number
    ) => {
      const cy = yTop + idx * step;
      const cx = side === "left" ? pcbX + 16 : pcbX + pcbW - 16;
      const tone = pinToneForHeaderPin(hp, gpioByPin, usedPins);
      const color = PIN_TONE_COLOR[tone];
      const active = isPinHighlighted(hp);
      const dimmed = pinDimmed ? pinDimmed(hp) : false;

      return (
        <g
          key={`dv-${side}-${hp.position}`}
          data-svg-pin={hp.pinName}
          opacity={dimmed ? 0.25 : 1}
          className={interactive ? "cursor-pointer" : undefined}
          onClick={onPinClick ? () => onPinClick(hp) : undefined}
          onMouseEnter={onPinHover ? () => onPinHover(hp) : undefined}
          onMouseLeave={onPinHover ? () => onPinHover(null) : undefined}
        >
          {/* Gold pad + thru-hole */}
          {idx === 0 ? (
            <rect
              x={cx - 6.5}
              y={cy - 6.5}
              width={13}
              height={13}
              rx={2}
              fill={`url(#${uid}-gold)`}
              stroke={active ? "#38bdf8" : "#6c4b11"}
              strokeWidth={active ? 1.8 : 0.7}
            />
          ) : (
            <circle
              cx={cx}
              cy={cy}
              r={6.5}
              fill={`url(#${uid}-gold)`}
              stroke={active ? "#38bdf8" : "#6c4b11"}
              strokeWidth={active ? 1.8 : 0.7}
            />
          )}
          <circle cx={cx} cy={cy} r={3.1} fill="#090b0f" />
          {active && (
            <circle
              cx={cx}
              cy={cy}
              r={9.5}
              fill="none"
              stroke="#38bdf8"
              strokeWidth={1.8}
            />
          )}
          <circle
            cx={side === "left" ? pcbX + 5 : pcbX + pcbW - 5}
            cy={cy}
            r={2.1}
            fill={color}
          />
          {!compact && (
            <text
              x={side === "left" ? cx + 10 : cx - 10}
              y={cy + 2.8}
              textAnchor={side === "left" ? "start" : "end"}
              fill="#e2e8f0"
              fontSize="7.4"
              fontWeight="700"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              {shortSilkLabel(hp)}
            </text>
          )}
        </g>
      );
    };

    const shieldW = isMini ? 104 : 116;
    const shieldH = isMini ? 116 : 158;
    const shieldX = (vw - shieldW) / 2;
    const shieldY = isMini ? 106 : 94;

    return (
      <svg
        viewBox={`0 0 ${vw} ${vh}`}
        className={cn("select-none", className)}
        role="img"
        aria-label={`${board.manufacturer} ${board.model} vertical PCB diagram`}
      >
        {defs}
        {/* Main DevKit PCB */}
        <rect
          x={pcbX}
          y={pcbY}
          width={pcbW}
          height={pcbH}
          rx={14}
          fill={`url(#${uid}-pcb)`}
          stroke="#2d343e"
          strokeWidth={1.5}
          filter={`url(#${uid}-shadow)`}
        />

        {/* Module Silkscreen Outline */}
        <rect
          x={shieldX - 4}
          y={34}
          width={shieldW + 8}
          height={shieldH + 66}
          rx={5}
          fill="#0f1216"
          stroke="#6a7782"
          strokeWidth={1}
        />

        {/* Meander PCB Antenna */}
        {!isNoWifi ? (
          <path
            d={`M ${vw / 2 - 42} 84 V 44 H ${vw / 2 - 28} V 74 H ${vw / 2 - 14} V 44 H ${vw / 2} V 74 H ${vw / 2 + 14} V 44 H ${vw / 2 + 28} V 74 H ${vw / 2 + 42} V 54`}
            fill="none"
            stroke="#c59942"
            strokeWidth={isDualBand ? 3.2 : 2.6}
            strokeLinecap="square"
            strokeLinejoin="miter"
          />
        ) : (
          <path
            d={`M ${vw / 2 - 36} 84 V 48 H ${vw / 2 - 18} V 70 H ${vw / 2 + 4} V 48 H ${vw / 2 + 34} V 70`}
            fill="none"
            stroke="#94a3b8"
            strokeWidth={2.5}
          />
        )}

        {/* Metallic Brushed RF Shield */}
        <rect
          x={shieldX}
          y={shieldY}
          width={shieldW}
          height={shieldH}
          rx={4}
          fill={`url(#${uid}-shield)`}
          stroke="#4d545d"
          strokeWidth={1.1}
          filter={`url(#${uid}-shadow)`}
        />
        <text
          x={vw / 2}
          y={shieldY + 42}
          textAnchor="middle"
          fill="#374151"
          fontSize="10"
          fontWeight="800"
          letterSpacing="1.2"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
        >
          ESPRESSIF
        </text>
        <text
          x={vw / 2}
          y={shieldY + 62}
          textAnchor="middle"
          fill="#1f2937"
          fontSize="7.4"
          fontWeight="700"
          fontFamily="ui-monospace, monospace"
        >
          {board.chip_variant}
        </text>
        <text
          x={vw / 2}
          y={shieldY + 80}
          textAnchor="middle"
          fill="#4b5563"
          fontSize="6.8"
          fontWeight="600"
          fontFamily="ui-monospace, monospace"
        >
          {specs.memory}
        </text>

        {/* 40MHz Crystal + LDO Regulator + UART Bridge */}
        <rect x={88} y={292} width={28} height={18} rx={3} fill={`url(#${uid}-metal)`} stroke="#555e68" />
        <text x={102} y={304} textAnchor="middle" fill="#1f2937" fontSize="6" fontWeight="700" fontFamily="monospace">
          40M
        </text>

        {/* LDO 3.3V Voltage Regulator */}
        <g>
          <rect x={126} y={322} width={34} height={10} fill={`url(#${uid}-metal)`} />
          <rect x={123} y={330} width={40} height={26} rx={2} fill="#1f232a" stroke="#475569" strokeWidth={0.8} />
          <rect x={127} y={356} width={6} height={7} fill={`url(#${uid}-metal)`} />
          <rect x={140} y={356} width={6} height={7} fill={`url(#${uid}-metal)`} />
          <rect x={153} y={356} width={6} height={7} fill={`url(#${uid}-metal)`} />
          <text x={143} y={346} textAnchor="middle" fill="#94a3b8" fontSize="6" fontFamily="monospace">
            3V3
          </text>
        </g>

        {/* USB-UART Bridge IC */}
        {specs.hasUartBridge && (
          <g>
            <rect x={118} y={388} width={44} height={44} rx={3} fill="#1d2229" stroke="#64748b" strokeWidth={0.9} />
            {[0, 1, 2, 3, 4].map((p) => (
              <g key={p}>
                <rect x={113} y={393 + p * 8} width={5} height={4} fill="#cbd5e1" />
                <rect x={162} y={393 + p * 8} width={5} height={4} fill="#cbd5e1" />
              </g>
            ))}
            <circle cx={125} cy={395} r={2} fill="#94a3b8" />
            <text x={140} y={413} textAnchor="middle" fill="#94a3b8" fontSize="6.5" fontFamily="monospace">
              UART
            </text>
          </g>
        )}

        {/* SMD Capacitors / Resistors */}
        {[304, 326, 444].map((ry, i) => (
          <g key={i}>
            <rect x={174} y={ry} width={14} height={7} rx={1} fill="#b68a44" />
            <rect x={172} y={ry} width={3} height={7} fill="#d1d5db" />
            <rect x={187} y={ry} width={3} height={7} fill="#d1d5db" />
          </g>
        ))}

        {/* Power LED (Red) + RGB LED */}
        <circle cx={96} cy={468} r={9} fill={`url(#${uid}-pwr-glow)`} />
        <rect x={92} y={465} width={8} height={5} rx={1} fill="#ef4444" />
        <text x={96} y={482} textAnchor="middle" fill="#94a3b8" fontSize="6" fontFamily="monospace">
          PWR
        </text>

        {hasRgbLed && (
          <g>
            <circle cx={140} cy={464} r={14} fill={`url(#${uid}-rgb-glow)`} />
            <rect x={131} y={455} width={18} height={18} rx={2} fill="#e2e8f0" stroke="#94a3b8" strokeWidth={0.8} />
            <circle cx={140} cy={464} r={6} fill="#38bdf8" />
            <text x={140} y={483} textAnchor="middle" fill="#94a3b8" fontSize="6" fontFamily="monospace">
              RGB
            </text>
          </g>
        )}

        {/* BOOT & RST / EN Tactile Buttons */}
        <g>
          <rect x={84} y={502} width={32} height={26} rx={3} fill={`url(#${uid}-metal)`} stroke="#475569" />
          <circle cx={100} cy={515} r={8} fill="#181b20" stroke="#64748b" strokeWidth={1} />
          <text x={100} y={540} textAnchor="middle" fill="#e2e8f0" fontSize="7" fontWeight="700" fontFamily="monospace">
            {specs.resetLabel}
          </text>
        </g>
        <g>
          <rect x={164} y={502} width={32} height={26} rx={3} fill={`url(#${uid}-metal)`} stroke="#475569" />
          <circle cx={180} cy={515} r={8} fill="#181b20" stroke="#64748b" strokeWidth={1} />
          <text x={180} y={540} textAnchor="middle" fill="#e2e8f0" fontSize="7" fontWeight="700" fontFamily="monospace">
            BOOT
          </text>
        </g>

        {/* Bottom USB Receptacle(s) */}
        {specs.usbPortCount === 2 ? (
          <>
            <g>
              <rect x={78} y={562} width={44} height={36} rx={6} fill={`url(#${uid}-metal)`} stroke="#475569" />
              <rect x={86} y={584} width={28} height={10} rx={3} fill="#0e1116" />
              <text x={100} y={556} textAnchor="middle" fill="#94a3b8" fontSize="6" fontFamily="monospace">
                USB
              </text>
            </g>
            <g>
              <rect x={158} y={562} width={44} height={36} rx={6} fill={`url(#${uid}-metal)`} stroke="#475569" />
              <rect x={166} y={584} width={28} height={10} rx={3} fill="#0e1116" />
              <text x={180} y={556} textAnchor="middle" fill="#94a3b8" fontSize="6" fontFamily="monospace">
                UART
              </text>
            </g>
          </>
        ) : (
          <g>
            <rect
              x={vw / 2 - 25}
              y={564}
              width={50}
              height={34}
              rx={specs.usbConnector === "usb-c" ? 7 : 3}
              fill={`url(#${uid}-metal)`}
              stroke="#475569"
            />
            <rect x={vw / 2 - 16} y={584} width={32} height={10} rx={3} fill="#0e1116" />
            <text x={vw / 2} y={558} textAnchor="middle" fill="#94a3b8" fontSize="6" fontFamily="monospace">
              {specs.usbConnector === "usb-c" ? "USB-C" : "MICRO-USB"}
            </text>
          </g>
        )}

        {/* Left & Right Header Pins */}
        {left.map((hp, idx) => renderVertPin(hp, "left", idx, leftStep))}
        {right.map((hp, idx) => renderVertPin(hp, "right", idx, rightStep))}
      </svg>
    );
  }

  // ============================================================================
  // 3. ESPRESSIF DEVKIT HORIZONTAL (Board Library Card matching image-3.png & Esp32_devkitc_v4.svg)
  // -90 CCW from Upright: Antenna LEFT, USB RIGHT, J3 on TOP (pin 1->N L-to-R), J1 on BOTTOM (pin 1->N L-to-R)
  // ============================================================================
  const vw = 760;
  const vh = 320;
  const pcbX = 44;
  const pcbY = 30;
  const pcbW = 672;
  const pcbH = 260;
  const xStart = 84;
  const xEnd = 676;
  const topStep = right.length > 1 ? (xEnd - xStart) / (right.length - 1) : 0;
  const botStep = left.length > 1 ? (xEnd - xStart) / (left.length - 1) : 0;
  const labelFontSize = Math.max(right.length, left.length) > 19 ? 8.2 : 9.4;

  const shieldW = isMini ? 150 : 210;
  const shieldH = isMini ? 132 : 148;
  const shieldX = 148;
  const shieldY = (vh - shieldH) / 2;

  const renderHorizPin = (
    hp: BoardHeaderPin,
    row: "top" | "bottom",
    idx: number,
    step: number
  ) => {
    const cx = xStart + idx * step;
    const cy = row === "top" ? pcbY + 18 : pcbY + pcbH - 18;
    const tone = pinToneForHeaderPin(hp, gpioByPin, usedPins);
    const active = isPinHighlighted(hp);
    const dimmed = pinDimmed ? pinDimmed(hp) : false;

    return (
      <g
        key={`dh-${row}-${hp.position}`}
        data-svg-pin={hp.pinName}
        opacity={dimmed ? 0.25 : 1}
        className={interactive ? "cursor-pointer" : undefined}
        onClick={onPinClick ? () => onPinClick(hp) : undefined}
        onMouseEnter={onPinHover ? () => onPinHover(hp) : undefined}
        onMouseLeave={onPinHover ? () => onPinHover(null) : undefined}
      >
        {/* Gold pad + silver solder ring + dark thru-hole */}
        {idx === 0 ? (
          <rect
            x={cx - 8}
            y={cy - 8}
            width={16}
            height={16}
            rx={2.5}
            fill={`url(#${uid}-gold)`}
            stroke={active ? "#38bdf8" : "#6c4b11"}
            strokeWidth={active ? 1.8 : 0.8}
          />
        ) : (
          <circle
            cx={cx}
            cy={cy}
            r={8}
            fill={`url(#${uid}-gold)`}
            stroke={active ? "#38bdf8" : "#6c4b11"}
            strokeWidth={active ? 1.8 : 0.8}
          />
        )}
        <circle cx={cx} cy={cy} r={4} fill="#090b0f" />
        <circle
          cx={cx}
          cy={row === "top" ? pcbY + 4 : pcbY + pcbH - 4}
          r={2}
          fill={PIN_TONE_COLOR[tone]}
        />
        {!compact && (
          <text
            x={cx}
            y={row === "top" ? pcbY + 38 : pcbY + pcbH - 31}
            textAnchor="middle"
            fill="#e2e8f0"
            fontSize={labelFontSize}
            fontWeight="700"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          >
            {shortSilkLabel(hp)}
          </text>
        )}
      </g>
    );
  };

  return (
    <svg
      viewBox={`0 0 ${vw} ${vh}`}
      className={cn("select-none", className)}
      role="img"
      aria-label={`${board.manufacturer} ${board.model} vector PCB diagram`}
    >
      {defs}
      {/* Main Matte-Black DevKit PCB */}
      <rect
        x={pcbX}
        y={pcbY}
        width={pcbW}
        height={pcbH}
        rx={16}
        fill={`url(#${uid}-pcb)`}
        stroke="#2b313a"
        strokeWidth={1.8}
        filter={`url(#${uid}-shadow)`}
      />
      <rect
        x={pcbX + 4}
        y={pcbY + 4}
        width={pcbW - 8}
        height={pcbH - 8}
        rx={13}
        fill="none"
        stroke="#3b434f"
        strokeWidth={0.7}
        opacity={0.45}
      />

      {/* Module Silkscreen Keepout Outline (Esp32_devkitc_v4 rect32142 style) */}
      <rect
        x={56}
        y={shieldY - 6}
        width={shieldW + 96}
        height={shieldH + 12}
        rx={6}
        fill="#0f1216"
        stroke="#6a7782"
        strokeWidth={1.1}
      />

      {/* Left Meander PCB Trace Antenna */}
      {!isNoWifi ? (
        <path
          d={`M 142 ${vh / 2 + 52} H 68 V ${vh / 2 + 32} H 116 V ${vh / 2 + 12} H 68 V ${vh / 2 - 8} H 116 V ${vh / 2 - 28} H 68 V ${vh / 2 - 48} H 128`}
          fill="none"
          stroke="#c99c43"
          strokeWidth={isDualBand ? 3.8 : 3.2}
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
      ) : (
        <path
          d={`M 142 ${vh / 2 + 40} H 76 V ${vh / 2 + 12} H 116 V ${vh / 2 - 18} H 76 V ${vh / 2 - 44} H 118`}
          fill="none"
          stroke="#94a3b8"
          strokeWidth={3}
        />
      )}

      {/* Brushed Aluminum RF Shield */}
      <rect
        x={shieldX}
        y={shieldY}
        width={shieldW}
        height={shieldH}
        rx={5}
        fill={`url(#${uid}-shield)`}
        stroke="#4b535c"
        strokeWidth={1.2}
        filter={`url(#${uid}-shadow)`}
      />
      <text
        x={shieldX + shieldW / 2}
        y={vh / 2 - 18}
        textAnchor="middle"
        fill="#272e37"
        fontSize="14"
        fontWeight="800"
        letterSpacing="1.8"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        ESPRESSIF
      </text>
      <text
        x={shieldX + shieldW / 2}
        y={vh / 2 + 4}
        textAnchor="middle"
        fill="#1e242c"
        fontSize={isMini ? "10" : "11"}
        fontWeight="700"
        fontFamily="ui-monospace, monospace"
      >
        {board.chip_variant}
      </text>
      <text
        x={shieldX + shieldW / 2}
        y={vh / 2 + 24}
        textAnchor="middle"
        fill="#475569"
        fontSize="9.5"
        fontWeight="600"
        fontFamily="ui-monospace, monospace"
      >
        {specs.memory}
      </text>

      {/* SMD 40 MHz Crystal + Passive Array */}
      <rect
        x={shieldX + shieldW + 22}
        y={96}
        width={30}
        height={20}
        rx={3}
        fill={`url(#${uid}-metal)`}
        stroke="#4b535c"
      />
      {!compact && (
        <text
          x={shieldX + shieldW + 37}
          y={109}
          textAnchor="middle"
          fill="#1f2937"
          fontSize="7"
          fontWeight="700"
          fontFamily="monospace"
        >
          40M
        </text>
      )}

      {/* SMD Capacitors & Resistors */}
      {[
        { x: shieldX + shieldW + 24, y: 132 },
        { x: shieldX + shieldW + 46, y: 132 },
        { x: shieldX + shieldW + 24, y: 150 },
        { x: 520, y: 100 },
        { x: 520, y: 210 },
      ].map((pt, i) => (
        <g key={i}>
          <rect x={pt.x} y={pt.y} width={16} height={8} rx={1.2} fill={i % 2 === 0 ? "#b68a44" : "#252b33"} />
          <rect x={pt.x - 2} y={pt.y} width={3.5} height={8} fill="#d1d5db" />
          <rect x={pt.x + 14.5} y={pt.y} width={3.5} height={8} fill="#d1d5db" />
        </g>
      ))}

      {/* 3.3V LDO Voltage Regulator (SOT-223) */}
      <g>
        <rect x={442} y={182} width={12} height={38} fill={`url(#${uid}-metal)`} />
        <rect x={452} y={178} width={30} height={46} rx={2.5} fill="#1f232a" stroke="#475569" strokeWidth={0.9} />
        <rect x={482} y={183} width={8} height={6} fill={`url(#${uid}-metal)`} />
        <rect x={482} y={198} width={8} height={6} fill={`url(#${uid}-metal)`} />
        <rect x={482} y={213} width={8} height={6} fill={`url(#${uid}-metal)`} />
        {!compact && (
          <text x={467} y={204} textAnchor="middle" fill="#94a3b8" fontSize="7" fontFamily="monospace">
            3V3
          </text>
        )}
      </g>

      {/* USB-UART Bridge IC (CP2102) */}
      {specs.hasUartBridge && (
        <g>
          <rect x={516} y={128} width={48} height={48} rx={3} fill="#1d2229" stroke="#64748b" strokeWidth={1} />
          {[0, 1, 2, 3, 4].map((p) => (
            <g key={p}>
              <rect x={510} y={133 + p * 8.5} width={6} height={4.2} fill="#cbd5e1" />
              <rect x={564} y={133 + p * 8.5} width={6} height={4.2} fill="#cbd5e1" />
            </g>
          ))}
          <circle cx={524} cy={136} r={2.2} fill="#94a3b8" />
          {!compact && (
            <text x={540} y={155} textAnchor="middle" fill="#94a3b8" fontSize="7.5" fontFamily="monospace">
              UART
            </text>
          )}
        </g>
      )}

      {/* Glowing Power LED + WS2812 RGB LED */}
      <g>
        <circle cx={596} cy={196} r={10} fill={`url(#${uid}-pwr-glow)`} />
        <rect x={592} y={193} width={8} height={6} rx={1} fill="#ef4444" />
        {!compact && (
          <text x={596} y={214} textAnchor="middle" fill="#94a3b8" fontSize="7" fontFamily="monospace">
            PWR
          </text>
        )}
      </g>

      {hasRgbLed && (
        <g>
          <circle cx={466} cy={126} r={16} fill={`url(#${uid}-rgb-glow)`} />
          <rect x={456} y={116} width={20} height={20} rx={2.5} fill="#e2e8f0" stroke="#94a3b8" strokeWidth={0.9} />
          <circle cx={466} cy={126} r={6.5} fill="#38bdf8" />
          {!compact && (
            <text x={466} y={108} textAnchor="middle" fill="#94a3b8" fontSize="7" fontFamily="monospace">
              RGB
            </text>
          )}
        </g>
      )}

      {/* BOOT (Top-Right) & RST/EN (Bottom-Right) Tactile Pushbuttons */}
      <g>
        <rect x={604} y={102} width={38} height={30} rx={3.5} fill={`url(#${uid}-metal)`} stroke="#4b535c" />
        <circle cx={623} cy={117} r={9} fill="#181b20" stroke="#64748b" strokeWidth={1.1} />
        {!compact && (
          <text x={623} y={144} textAnchor="middle" fill="#e2e8f0" fontSize="8" fontWeight="700" fontFamily="monospace">
            BOOT
          </text>
        )}
      </g>
      <g>
        <rect x={604} y={178} width={38} height={30} rx={3.5} fill={`url(#${uid}-metal)`} stroke="#4b535c" />
        <circle cx={623} cy={193} r={9} fill="#181b20" stroke="#64748b" strokeWidth={1.1} />
        {!compact && (
          <text x={623} y={220} textAnchor="middle" fill="#e2e8f0" fontSize="8" fontWeight="700" fontFamily="monospace">
            {specs.resetLabel}
          </text>
        )}
      </g>

      {/* Right Edge USB Connector(s) */}
      {specs.usbPortCount === 2 ? (
        <>
          <g>
            <rect
              x={680}
              y={102}
              width={46}
              height={46}
              rx={specs.usbConnector === "usb-c" ? 7 : 3}
              fill={`url(#${uid}-metal)`}
              stroke="#4b535c"
              strokeWidth={1.2}
              filter={`url(#${uid}-shadow)`}
            />
            <rect x={706} y={111} width={15} height={28} rx={4} fill="#0e1116" />
            <rect x={711} y={116} width={3.5} height={18} rx={1} fill="#d4a02b" />
          </g>
          <g>
            <rect
              x={680}
              y={172}
              width={46}
              height={46}
              rx={specs.usbConnector === "usb-c" ? 7 : 3}
              fill={`url(#${uid}-metal)`}
              stroke="#4b535c"
              strokeWidth={1.2}
              filter={`url(#${uid}-shadow)`}
            />
            <rect x={706} y={181} width={15} height={28} rx={4} fill="#0e1116" />
            <rect x={711} y={186} width={3.5} height={18} rx={1} fill="#d4a02b" />
          </g>
        </>
      ) : (
        <g>
          <rect
            x={678}
            y={128}
            width={48}
            height={64}
            rx={specs.usbConnector === "usb-c" ? 8 : 3}
            fill={`url(#${uid}-metal)`}
            stroke="#4b535c"
            strokeWidth={1.2}
            filter={`url(#${uid}-shadow)`}
          />
          <rect x={706} y={138} width={15} height={44} rx={4} fill="#0e1116" />
          <rect x={711} y={145} width={4} height={30} rx={1} fill="#d4a02b" />
        </g>
      )}

      {/* Top (J3) & Bottom (J1) Pin Rows */}
      {right.map((hp, idx) => renderHorizPin(hp, "top", idx, topStep))}
      {left.map((hp, idx) => renderHorizPin(hp, "bottom", idx, botStep))}
    </svg>
  );
}
