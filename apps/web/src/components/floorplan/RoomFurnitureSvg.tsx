import { memo, useState } from "react";
import type { FloorDoor, FloorStyle, FloorWindow, RoomType } from "@homecoreos/shared";

export interface FloorFixtureItem {
  id: string;
  kind: "switch" | "device";
  name: string;
  deviceType: string;
  isOn: boolean;
  online?: boolean;
  pending?: boolean;
}

export function isLightingFixture(kind: "switch" | "device", deviceType: string): boolean {
  if (kind === "switch") return true;
  const t = deviceType.toLowerCase();
  return t === "light" || t === "dimmer" || t === "led";
}

export const FloorPatternDefs = memo(function FloorPatternDefs() {
  return (
    <defs>
      {/* Warm wood plank flooring */}
      <pattern id="hc-floor-wood" width="48" height="24" patternUnits="userSpaceOnUse">
        <rect width="48" height="24" fill="#DBC6A1" />
        <path
          d="M0 12h48M0 24h48M16 0v12M38 12v12"
          stroke="#BFA77E"
          strokeWidth="0.9"
          strokeOpacity="0.65"
        />
        <rect x="1" y="1" width="46" height="10" fill="#E3D0AE" fillOpacity="0.28" />
      </pattern>

      {/* Ceramic tile grid */}
      <pattern id="hc-floor-tile" width="24" height="24" patternUnits="userSpaceOnUse">
        <rect width="24" height="24" fill="#E5E9EE" />
        <path d="M24 0H0v24" fill="none" stroke="#C7D0DA" strokeWidth="1" />
      </pattern>

      {/* Stone patio pavers */}
      <pattern id="hc-floor-stone" width="32" height="32" patternUnits="userSpaceOnUse">
        <rect width="32" height="32" fill="#D8D4CA" />
        <path d="M32 0H0v32M16 0v16M0 16h32" fill="none" stroke="#BAB4A7" strokeWidth="1" />
      </pattern>

      {/* Woven carpet */}
      <pattern id="hc-floor-carpet" width="12" height="12" patternUnits="userSpaceOnUse">
        <rect width="12" height="12" fill="#DFD9CE" />
        <circle cx="3" cy="3" r="0.6" fill="#C7BFAF" />
        <circle cx="9" cy="9" r="0.6" fill="#C7BFAF" />
      </pattern>

      {/* Active warm tungsten room illumination (when lights/switches are ON) */}
      <radialGradient id="hc-room-warm-glow" cx="50%" cy="50%" r="65%">
        <stop offset="0%" stopColor="#FEF08A" stopOpacity="0.58" />
        <stop offset="55%" stopColor="#FBBF24" stopOpacity="0.24" />
        <stop offset="100%" stopColor="#F59E0B" stopOpacity="0.06" />
      </radialGradient>

      {/* Localized fixture halo for individual lit lamps / switches */}
      <radialGradient id="hc-fixture-warm-halo" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#FEF08A" stopOpacity="0.72" />
        <stop offset="55%" stopColor="#FBBF24" stopOpacity="0.28" />
        <stop offset="100%" stopColor="#F59E0B" stopOpacity="0" />
      </radialGradient>

      {/* Cool ambient screen / AC glow */}
      <radialGradient id="hc-fixture-cool-halo" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.52" />
        <stop offset="60%" stopColor="#2563EB" stopOpacity="0.16" />
        <stop offset="100%" stopColor="#2563EB" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
});

export function getFloorPatternUrl(style?: FloorStyle): string {
  switch (style) {
    case "tile":
      return "url(#hc-floor-tile)";
    case "stone":
      return "url(#hc-floor-stone)";
    case "carpet":
      return "url(#hc-floor-carpet)";
    default:
      return "url(#hc-floor-wood)";
  }
}

export const RoomFurnitureArt = memo(function RoomFurnitureArt({
  roomType,
  x,
  y,
  w,
  h,
}: {
  roomType: RoomType;
  x: number;
  y: number;
  w: number;
  h: number;
}) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const pad = 18;
  const iw = Math.max(40, w - pad * 2);
  const ih = Math.max(40, h - pad * 2);

  switch (roomType) {
    case "living_room": {
      const rugW = Math.min(iw * 0.62, 160);
      const rugH = Math.min(ih * 0.56, 112);
      return (
        <g opacity="0.88" pointerEvents="none">
          {/* Rug */}
          <rect
            x={cx - rugW / 2}
            y={cy - rugH / 2 + 8}
            width={rugW}
            height={rugH}
            rx="4"
            fill="#C7B79B"
            stroke="#9E8D70"
            strokeWidth="1"
          />
          {/* Sofa */}
          <rect
            x={cx - rugW * 0.44}
            y={y + pad + 4}
            width={rugW * 0.88}
            height="30"
            rx="5"
            fill="#E2E5E9"
            stroke="#64748B"
            strokeWidth="1.2"
          />
          <rect x={cx - rugW * 0.4} y={y + pad + 6} width={rugW * 0.24} height="8" rx="2" fill="#CBD5E1" />
          <rect x={cx - rugW * 0.12} y={y + pad + 6} width={rugW * 0.24} height="8" rx="2" fill="#CBD5E1" />
          <rect x={cx + rugW * 0.16} y={y + pad + 6} width={rugW * 0.24} height="8" rx="2" fill="#CBD5E1" />
          {/* Coffee table */}
          <rect
            x={cx - 32}
            y={cy + 4}
            width="64"
            height="26"
            rx="4"
            fill="#B08962"
            stroke="#6F5134"
            strokeWidth="1.2"
          />
          {/* TV Console */}
          <rect
            x={cx - 46}
            y={y + h - 24}
            width="92"
            height="12"
            rx="2"
            fill="#475569"
            stroke="#1E293B"
            strokeWidth="1"
          />
        </g>
      );
    }

    case "bedroom": {
      const bedW = Math.min(iw * 0.55, 118);
      const bedH = Math.min(ih * 0.62, 132);
      const bx = cx - bedW / 2;
      const by = y + 18;
      return (
        <g opacity="0.9" pointerEvents="none">
          {/* Nightstands */}
          <rect x={bx - 24} y={by + 4} width="18" height="20" rx="2" fill="#9C7A54" stroke="#5C442B" strokeWidth="1" />
          <rect x={bx + bedW + 6} y={by + 4} width="18" height="20" rx="2" fill="#9C7A54" stroke="#5C442B" strokeWidth="1" />
          {/* Bed Frame */}
          <rect x={bx} y={by} width={bedW} height={bedH} rx="5" fill="#F1F5F9" stroke="#64748B" strokeWidth="1.4" />
          {/* Pillows */}
          <rect x={bx + 8} y={by + 7} width={bedW / 2 - 12} height="18" rx="3" fill="#CBD5E1" />
          <rect x={bx + bedW / 2 + 4} y={by + 7} width={bedW / 2 - 12} height="18" rx="3" fill="#CBD5E1" />
          {/* Blanket */}
          <rect x={bx + 3} y={by + bedH * 0.36} width={bedW - 6} height={bedH * 0.61} rx="3" fill="#94A3B8" fillOpacity="0.45" />
          {/* Wardrobe */}
          <rect x={x + w - 26} y={cy - 34} width="16" height="68" rx="2" fill="#B6956F" stroke="#6E5539" strokeWidth="1" />
        </g>
      );
    }

    case "kitchen": {
      const counterW = Math.min(iw * 0.86, 200);
      return (
        <g opacity="0.92" pointerEvents="none">
          {/* Countertop */}
          <rect x={x + 14} y={y + 14} width={counterW} height="34" rx="2" fill="#F1F5F9" stroke="#64748B" strokeWidth="1.2" />
          <rect x={x + 14} y={y + 14} width="34" height={Math.min(ih * 0.7, 130)} rx="2" fill="#F1F5F9" stroke="#64748B" strokeWidth="1.2" />
          {/* Cooktop */}
          <rect x={x + 64} y={y + 18} width="46" height="26" rx="2" fill="#1E293B" />
          <circle cx={x + 77} cy={y + 26} r="4.5" stroke="#94A3B8" strokeWidth="1.2" />
          <circle cx={x + 97} cy={y + 26} r="4.5" stroke="#94A3B8" strokeWidth="1.2" />
          <circle cx={x + 77} cy={y + 37} r="4.5" stroke="#94A3B8" strokeWidth="1.2" />
          <circle cx={x + 97} cy={y + 37} r="4.5" stroke="#94A3B8" strokeWidth="1.2" />
          {/* Sink */}
          <rect x={x + 126} y={y + 19} width="42" height="24" rx="3" fill="#CBD5E1" stroke="#475569" strokeWidth="1" />
          <circle cx={x + 147} cy={y + 31} r="2.2" fill="#475569" />
          {/* Island */}
          {h > 180 && (
            <rect x={cx - 42} y={cy + 14} width="84" height="32" rx="4" fill="#CBD5E1" stroke="#64748B" strokeWidth="1.2" />
          )}
        </g>
      );
    }

    case "dining": {
      const tw = Math.min(iw * 0.56, 116);
      const th = Math.min(ih * 0.36, 56);
      return (
        <g opacity="0.9" pointerEvents="none">
          {/* Chairs */}
          {[-0.28, 0.28].map((off, i) => (
            <g key={i}>
              <rect x={cx + tw * off - 10} y={cy - th / 2 - 12} width="20" height="9" rx="2" fill="#E2E8F0" stroke="#64748B" strokeWidth="1" />
              <rect x={cx + tw * off - 10} y={cy + th / 2 + 3} width="20" height="9" rx="2" fill="#E2E8F0" stroke="#64748B" strokeWidth="1" />
            </g>
          ))}
          <rect x={cx - tw / 2 - 12} y={cy - 10} width="9" height="20" rx="2" fill="#E2E8F0" stroke="#64748B" strokeWidth="1" />
          <rect x={cx + tw / 2 + 3} y={cy - 10} width="9" height="20" rx="2" fill="#E2E8F0" stroke="#64748B" strokeWidth="1" />
          {/* Table */}
          <rect x={cx - tw / 2} y={cy - th / 2} width={tw} height={th} rx="5" fill="#B99367" stroke="#6B5033" strokeWidth="1.3" />
        </g>
      );
    }

    case "bathroom": {
      return (
        <g opacity="0.92" pointerEvents="none">
          {/* Shower enclosure */}
          <rect x={x + 14} y={y + 14} width="64" height="64" rx="4" fill="#F8FAFC" stroke="#64748B" strokeWidth="1.3" />
          <circle cx={x + 30} cy={y + 30} r="4" fill="#94A3B8" />
          {/* Vanity sink */}
          <rect x={x + w - 52} y={y + 14} width="38" height="62" rx="3" fill="#E2E8F0" stroke="#64748B" strokeWidth="1.2" />
          <ellipse cx={x + w - 33} cy={y + 45} rx="10" ry="14" fill="#FFFFFF" stroke="#94A3B8" strokeWidth="1" />
          {/* Toilet */}
          <rect x={x + w - 44} y={y + h - 42} width="26" height="14" rx="2" fill="#FFFFFF" stroke="#64748B" strokeWidth="1.1" />
          <ellipse cx={x + w - 31} cy={y + h - 22} rx="10" ry="12" fill="#FFFFFF" stroke="#64748B" strokeWidth="1.1" />
        </g>
      );
    }

    case "toilet": {
      return (
        <g opacity="0.92" pointerEvents="none">
          <rect x={cx - 14} y={y + 14} width="28" height="12" rx="2" fill="#FFFFFF" stroke="#64748B" strokeWidth="1.1" />
          <ellipse cx={cx} cy={y + 36} rx="11" ry="13" fill="#FFFFFF" stroke="#64748B" strokeWidth="1.1" />
          <rect x={x + 14} y={y + h - 32} width="24" height="18" rx="3" fill="#FFFFFF" stroke="#64748B" strokeWidth="1" />
        </g>
      );
    }

    case "office": {
      return (
        <g opacity="0.9" pointerEvents="none">
          {/* Desk */}
          <rect x={x + 20} y={y + 18} width={Math.min(iw * 0.65, 118)} height="32" rx="3" fill="#AE8860" stroke="#61462C" strokeWidth="1.2" />
          {/* Monitor */}
          <rect x={x + 56} y={y + 23} width="42" height="7" rx="1.5" fill="#1E293B" />
          {/* Chair */}
          <circle cx={x + 77} cy={y + 68} r="13" fill="#64748B" fillOpacity="0.65" stroke="#334155" strokeWidth="1.2" />
          {/* Bookshelf */}
          <rect x={x + w - 26} y={y + 22} width="14" height={Math.min(ih * 0.6, 86)} rx="2" fill="#9C7A54" stroke="#5C442B" strokeWidth="1" />
        </g>
      );
    }

    case "patio": {
      return (
        <g opacity="0.9" pointerEvents="none">
          {/* Plant circles */}
          <circle cx={x + 28} cy={y + 28} r="14" fill="#65A30D" fillOpacity="0.55" stroke="#3F6212" strokeWidth="1.2" />
          <circle cx={x + 28} cy={y + h - 28} r="12" fill="#65A30D" fillOpacity="0.5" stroke="#3F6212" strokeWidth="1.2" />
          {/* Lounge table & chairs */}
          <circle cx={cx + 10} cy={cy} r="16" fill="#E2E8F0" stroke="#64748B" strokeWidth="1.2" />
          <rect x={cx + 32} y={cy - 12} width="16" height="24" rx="4" fill="#CBD5E1" stroke="#64748B" strokeWidth="1" />
        </g>
      );
    }

    case "hallway": {
      const steps = Math.min(7, Math.max(4, Math.floor(iw / 24)));
      return (
        <g opacity="0.65" pointerEvents="none">
          <rect x={x + 22} y={cy - 18} width={steps * 14} height="36" rx="2" fill="#CBD5E1" fillOpacity="0.35" stroke="#94A3B8" strokeWidth="1" />
          {Array.from({ length: steps - 1 }).map((_, idx) => (
            <line
              key={idx}
              x1={x + 22 + (idx + 1) * 14}
              y1={cy - 18}
              x2={x + 22 + (idx + 1) * 14}
              y2={cy + 18}
              stroke="#64748B"
              strokeWidth="1"
            />
          ))}
        </g>
      );
    }

    case "garage": {
      return (
        <g opacity="0.7" pointerEvents="none">
          <rect
            x={cx - 48}
            y={cy - 76}
            width="96"
            height="152"
            rx="16"
            fill="#94A3B8"
            fillOpacity="0.25"
            stroke="#64748B"
            strokeWidth="1.5"
            strokeDasharray="6 4"
          />
        </g>
      );
    }

    default:
      return (
        <g opacity="0.75" pointerEvents="none">
          <rect x={x + 18} y={y + 18} width="54" height="24" rx="3" fill="#CBD5E1" stroke="#64748B" strokeWidth="1.1" />
        </g>
      );
  }
});

export const RoomOpeningsSvg = memo(function RoomOpeningsSvg({
  x,
  y,
  w,
  h,
  doors = [],
  windows = [],
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  doors?: FloorDoor[];
  windows?: FloorWindow[];
}) {
  return (
    <g pointerEvents="none">
      {/* Recessed windows */}
      {windows.map((win) => {
        const winLen = Math.min(win.width ?? 74, (win.wall === "top" || win.wall === "bottom" ? w : h) * 0.55);
        if (win.wall === "top" || win.wall === "bottom") {
          const wy = win.wall === "top" ? y - 3 : y + h - 3;
          const wx = x + Math.max(18, Math.min(w - winLen - 18, w * win.offset - winLen / 2));
          return (
            <g key={win.id}>
              <rect x={wx} y={wy} width={winLen} height="6" fill="#F8FAFC" stroke="#475569" strokeWidth="1" />
              <line x1={wx} y1={wy + 3} x2={wx + winLen} y2={wy + 3} stroke="#60A5FA" strokeWidth="1.5" />
            </g>
          );
        } else {
          const wx = win.wall === "left" ? x - 3 : x + w - 3;
          const wy = y + Math.max(18, Math.min(h - winLen - 18, h * win.offset - winLen / 2));
          return (
            <g key={win.id}>
              <rect x={wx} y={wy} width="6" height={winLen} fill="#F8FAFC" stroke="#475569" strokeWidth="1" />
              <line x1={wx + 3} y1={wy} x2={wx + 3} y2={wy + winLen} stroke="#60A5FA" strokeWidth="1.5" />
            </g>
          );
        }
      })}

      {/* Architectural hinged doors with swing arcs */}
      {doors.map((door) => {
        const dw = Math.min(door.width ?? 44, 54);
        if (door.wall === "top" || door.wall === "bottom") {
          const dx = x + Math.max(14, Math.min(w - dw - 14, w * door.offset - dw / 2));
          const dy = door.wall === "top" ? y : y + h;
          const dir = door.wall === "top" ? 1 : -1;
          return (
            <g key={door.id}>
              {/* Wall gap */}
              <rect x={dx} y={dy - 4} width={dw} height="8" fill="#FAF7F0" />
              {/* Door leaf */}
              <line x1={dx} y1={dy} x2={dx} y2={dy + dir * dw} stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" />
              <line x1={dx} y1={dy} x2={dx} y2={dy + dir * dw} stroke="#334155" strokeWidth="1.3" strokeLinecap="round" />
              {/* Swing arc */}
              <path
                d={`M ${dx} ${dy + dir * dw} A ${dw} ${dw} 0 0 ${dir > 0 ? 0 : 1} ${dx + dw} ${dy}`}
                fill="none"
                stroke="#64748B"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
            </g>
          );
        } else {
          const dy = y + Math.max(14, Math.min(h - dw - 14, h * door.offset - dw / 2));
          const dx = door.wall === "left" ? x : x + w;
          const dir = door.wall === "left" ? 1 : -1;
          return (
            <g key={door.id}>
              <rect x={dx - 4} y={dy} width="8" height={dw} fill="#FAF7F0" />
              <line x1={dx} y1={dy} x2={dx + dir * dw} y2={dy} stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" />
              <line x1={dx} y1={dy} x2={dx + dir * dw} y2={dy} stroke="#334155" strokeWidth="1.3" strokeLinecap="round" />
              <path
                d={`M ${dx + dir * dw} ${dy} A ${dw} ${dw} 0 0 ${dir > 0 ? 1 : 0} ${dx} ${dy + dw}`}
                fill="none"
                stroke="#64748B"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
            </g>
          );
        }
      })}
    </g>
  );
});

export const FloorDeviceFixtures = memo(function FloorDeviceFixtures({
  x,
  y,
  w,
  h,
  fixtures,
  interactive,
  onToggleFixture,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  fixtures: FloorFixtureItem[];
  interactive: boolean;
  onToggleFixture: (item: FloorFixtureItem) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  if (fixtures.length === 0) return null;

  // Distribute fixtures cleanly along the right/top architectural zone without blocking room title/sensor chips
  const visible = fixtures.slice(0, 12);
  const maxRows = Math.max(2, Math.floor((h - 68) / 34));
  let hoveredTooltip: { fx: number; fy: number; label: string } | null = null as {
    fx: number;
    fy: number;
    label: string;
  } | null;

  return (
    <g>
      {visible.map((item, idx) => {
        const row = idx % maxRows;
        const col = Math.floor(idx / maxRows);
        const fx = x + w - 26 - col * 34;
        const fy = y + 26 + row * 34;
        if (fy > y + h - 42 || fx < x + 28) return null;

        const dt = item.deviceType.toLowerCase();
        const isLight = isLightingFixture(item.kind, dt);
        const canClick = interactive && !item.pending;
        const statusText = [
          item.isOn ? "ON" : "OFF",
          item.online === false ? "Offline" : null,
          item.pending ? "Syncing..." : null,
        ]
          .filter(Boolean)
          .join(" · ");

        if (hoveredId === item.id) {
          hoveredTooltip = { fx, fy, label: `${item.name} · ${statusText}` };
        }

        return (
          <g
            key={`${item.kind}:${item.id}`}
            transform={`translate(${fx}, ${fy})`}
            data-fixture-id={item.id}
            role={canClick ? "button" : undefined}
            tabIndex={canClick ? 0 : undefined}
            aria-label={`${item.name} (${item.isOn ? "ON" : "OFF"})`}
            aria-busy={item.pending ? true : undefined}
            className={canClick ? "cursor-pointer" : item.pending ? "cursor-wait opacity-80" : undefined}
            onMouseEnter={() => setHoveredId(item.id)}
            onMouseLeave={() => setHoveredId((cur) => (cur === item.id ? null : cur))}
            onFocus={() => setHoveredId(item.id)}
            onBlur={() => setHoveredId((cur) => (cur === item.id ? null : cur))}
            onPointerDown={(e) => {
              if (interactive) e.stopPropagation();
            }}
            onClick={(e) => {
              if (!canClick) return;
              e.stopPropagation();
              onToggleFixture(item);
            }}
            onKeyDown={(e) => {
              if (!canClick) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onToggleFixture(item);
              }
            }}
          >

            {/* Ambient real-light halo */}
            {item.isOn && isLight && (
              <circle
                cx="0"
                cy="0"
                r="34"
                fill="url(#hc-fixture-warm-halo)"
                className="hc-light-pulse"
                pointerEvents="none"
              />
            )}
            {item.isOn && (dt === "tv" || dt === "ac" || dt === "fan") && (
              <circle
                cx="0"
                cy="0"
                r="26"
                fill="url(#hc-fixture-cool-halo)"
                pointerEvents="none"
              />
            )}
            {item.pending && (
              <circle
                cx="0"
                cy="0"
                r="16"
                fill="none"
                stroke="#3B82F6"
                strokeWidth="1.6"
                strokeDasharray="4 3"
                pointerEvents="none"
              />
            )}

            {/* Fixture medallion */}
            <circle
              cx="0"
              cy="0"
              r="12"
              fill={
                item.isOn
                  ? isLight || dt === "heater"
                    ? "#F59E0B"
                    : dt === "lock" || dt === "door_lock"
                      ? "#10B981"
                      : "#2563EB"
                  : "#1E293B"
              }
              fillOpacity={item.online === false ? 0.55 : item.isOn ? 0.96 : 0.86}
              stroke={item.online === false ? "#94A3B8" : "#FFFFFF"}
              strokeWidth="1.6"
            />

            {/* Type-specific lightweight SVG glyph */}
            {dt === "fan" ? (
              <g className={item.isOn ? "hc-fan-spin" : undefined}>
                <path
                  d="M0-7 C2-4 2-2 0 0 C-2-2 -2-4 0-7 M7 0 C4 2 2 2 0 0 C2-2 4-2 7 0 M0 7 C-2 4 -2 2 0 0 C2 2 2 4 0 7 M-7 0 C-4-2 -2-2 0 0 C-2 2 -4 2 -7 0"
                  fill={item.isOn ? "#FFFFFF" : "#94A3B8"}
                />
                <circle cx="0" cy="0" r="1.8" fill="#0F172A" />
              </g>
            ) : dt === "tv" ? (
              <g className={item.isOn ? "hc-tv-glow" : undefined}>
                <rect
                  x="-6.5"
                  y="-4.5"
                  width="13"
                  height="8.5"
                  rx="1.4"
                  fill={item.isOn ? "#E0F2FE" : "#334155"}
                  stroke={item.isOn ? "#FFFFFF" : "#94A3B8"}
                  strokeWidth="1.1"
                />
                <line
                  x1="-3"
                  y1="6"
                  x2="3"
                  y2="6"
                  stroke={item.isOn ? "#FFFFFF" : "#94A3B8"}
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </g>
            ) : dt === "ac" ? (
              <g>
                <rect
                  x="-6.5"
                  y="-4.5"
                  width="13"
                  height="5.5"
                  rx="1.2"
                  fill={item.isOn ? "#FFFFFF" : "#94A3B8"}
                />
                <path
                  d="M-4 3.5 Q-2 5 0 3.5 T4 3.5"
                  fill="none"
                  stroke={item.isOn ? "#BAE6FD" : "#64748B"}
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  className={item.isOn ? "hc-ac-wave" : undefined}
                />
              </g>
            ) : dt === "lock" || dt === "door_lock" ? (
              <g>
                <path
                  d={
                    item.isOn
                      ? "M-3-1 V-3.5 A3 3 0 0 1 3-3.5 V-2"
                      : "M-3-1 V-3.5 A3 3 0 0 1 3-3.5 V-1"
                  }
                  fill="none"
                  stroke={item.isOn ? "#FFFFFF" : "#94A3B8"}
                  strokeWidth="1.3"
                />
                <rect
                  x="-4.5"
                  y="-1"
                  width="9"
                  height="6"
                  rx="1.2"
                  fill={item.isOn ? "#FFFFFF" : "#94A3B8"}
                />
              </g>
            ) : isLight ? (
              <g>
                <circle
                  cx="0"
                  cy="-1"
                  r="4"
                  fill={item.isOn ? "#FEF9C3" : "#94A3B8"}
                />
                <line
                  x1="-2"
                  y1="5"
                  x2="2"
                  y2="5"
                  stroke={item.isOn ? "#0F172A" : "#64748B"}
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </g>
            ) : (
              <circle
                cx="0"
                cy="0"
                r="3.2"
                fill={item.isOn ? "#FFFFFF" : "#94A3B8"}
              />
            )}
          </g>
        );
      })}
      {hoveredTooltip && (() => {
        const textW = Math.min(180, Math.max(82, hoveredTooltip.label.length * 6.1 + 16));
        const tx = Math.max(x + 6, Math.min(x + w - textW - 6, hoveredTooltip.fx - textW / 2));
        const ty = hoveredTooltip.fy > y + 40 ? hoveredTooltip.fy - 36 : hoveredTooltip.fy + 18;
        return (
          <g transform={`translate(${tx}, ${ty})`} pointerEvents="none">
            <rect
              width={textW}
              height="20"
              rx="6"
              fill="#0F172A"
              fillOpacity="0.94"
              stroke="rgba(255,255,255,0.2)"
              strokeWidth="0.8"
            />
            <text
              x={textW / 2}
              y="13.5"
              textAnchor="middle"
              fill="#F8FAFC"
              fontSize="10"
              fontWeight="600"
            >
              {hoveredTooltip.label.slice(0, 28)}
            </text>
          </g>
        );
      })()}
    </g>
  );
});
