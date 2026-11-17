import { useId, useMemo } from "react";
import { cn } from "@/lib/utils";

export interface SensorReadingPoint {
  value: number;
  unit?: string;
  recordedAt: string;
}

/**
 * Soft, muted tone per measurement family so temperature/humidity/voltage
 * readings are visually distinguishable without heavy chrome.
 * Falls back to a neutral emerald for everything else.
 */
const TONE_RULES: ReadonlyArray<{ match: RegExp; tone: string }> = [
  { match: /^temp/i, tone: "#f0a35e" }, // warm amber (matches card reference)
  { match: /^humid/i, tone: "#5eb4f0" }, // soft sky
  { match: /^press|^baro/i, tone: "#a78bfa" }, // soft violet
  { match: /^volt|^adc|electric/i, tone: "#8b5cf6" }, // violet
  { match: /^curr|^power|^energy/i, tone: "#f472b6" }, // soft pink
  { match: /^light|lux/i, tone: "#eab308" }, // soft gold
  { match: /^motion|pir|^occup/i, tone: "#34d399" }, // soft emerald
  { match: /^contact|reed|door|window/i, tone: "#2dd4bf" }, // soft teal
  { match: /^ph|water|ec/i, tone: "#22d3ee" }, // cyan
];
const FALLBACK_TONE = "#34d399";

function toneForSensorType(sensorType: string): string {
  for (const rule of TONE_RULES) {
    if (rule.match.test(sensorType)) return rule.tone;
  }
  return FALLBACK_TONE;
}

interface SparkPoint {
  x: number;
  y: number;
}

/** Catmull-Rom → cubic Bézier for a soft, smooth line. */
function buildSmoothLine(points: SparkPoint[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    return `M 0 ${points[0]!.y.toFixed(2)} L 100 ${points[0]!.y.toFixed(2)}`;
  }
  let d = `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

const VIEW_W = 100;
const VIEW_H = 34;
const PAD_Y = 4;

/**
 * Minimal, axis-free sparkline for sensor cards.
 * Renders nothing but a soft area + line from real recorded history;
 * shows a compact "awaiting history" empty state when there are
 * fewer than two recorded numeric points. Never fabricates data.
 */
export function SensorSparkline({
  sensorType,
  points,
  className,
}: {
  sensorType: string;
  points: SensorReadingPoint[] | undefined;
  className?: string;
}) {
  const gradientId = useId();
  const tone = toneForSensorType(sensorType);

  const model = useMemo(() => {
    const numeric = (points ?? []).filter((p) => Number.isFinite(p.value));
    if (numeric.length < 2) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const p of numeric) {
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    }
    const span = max - min;
    const usableH = VIEW_H - PAD_Y * 2;
    const coords: SparkPoint[] = numeric.map((p, index) => {
      const x = (index / (numeric.length - 1)) * VIEW_W;
      // Flat series → centered line instead of dividing by zero.
      const ratio = span === 0 ? 0.5 : (p.value - min) / span;
      const y = PAD_Y + (1 - ratio) * usableH;
      return { x, y };
    });
    const line = buildSmoothLine(coords);
    const area = `${line} L ${VIEW_W} ${VIEW_H} L 0 ${VIEW_H} Z`;
    const last = coords[coords.length - 1]!;
    return { line, area, last, min, max, count: numeric.length };
  }, [points]);

  if (!model) {
    return (
      <div
        data-testid="sensor-sparkline-empty"
        className={cn(
          "flex h-14 w-full items-center justify-center rounded-lg border border-dashed border-muted-foreground/20 bg-muted/30 px-2",
          className
        )}
      >
        <p className="text-center text-[10px] font-medium leading-tight text-muted-foreground/80">
          History appears as readings arrive
        </p>
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Recent readings trend: low ${model.min}, high ${model.max} across ${model.count} samples`}
      data-testid="sensor-sparkline"
      className={cn("h-14 w-full overflow-visible", className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity="0.32" />
          <stop offset="100%" stopColor={tone} stopOpacity="0.04" />
        </linearGradient>
      </defs>
      <path d={model.area} fill={`url(#${gradientId})`} />
      <path
        d={model.line}
        fill="none"
        stroke={tone}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        opacity="0.9"
      />
      <circle cx={model.last.x} cy={model.last.y} r="1.7" fill={tone} />
    </svg>
  );
}
