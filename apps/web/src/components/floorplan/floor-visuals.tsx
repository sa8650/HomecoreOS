import { memo } from "react";
import type { FloorStyle, RoomType } from "@homecoreos/shared";
import type { FloorDeviceKind, PlanRoom } from "./house-layout";

/* -------------------------------------------------------------------------- */
/* Room palette — soft pastel floors with a slightly deeper furniture tone      */
/* -------------------------------------------------------------------------- */

export interface RoomPalette {
  /** Floor tint */
  floor: string;
  /** Furniture fill */
  furniture: string;
  /** Secondary furniture / textile fill */
  textile: string;
  /** Label + accent ink */
  ink: string;
  /** Wall-adjacent skirting tone */
  edge: string;
}

export const ROOM_PALETTES: Record<RoomType, RoomPalette> = {
  living_room: { floor: "#B7E5C1", furniture: "#7CBF92", textile: "#D8EFDD", ink: "#2C6444", edge: "#9FD3AD" },
  bedroom: { floor: "#F8CFE1", furniture: "#E79BBE", textile: "#FBE2EE", ink: "#85395B", edge: "#F0B4D0" },
  kitchen: { floor: "#FADFA8", furniture: "#E8BE6D", textile: "#FCEFCF", ink: "#6F5115", edge: "#F3D596" },
  dining: { floor: "#BCDFEF", furniture: "#8AC3DC", textile: "#DEF0F9", ink: "#27586B", edge: "#A5D2E6" },
  bathroom: { floor: "#BEE9D9", furniture: "#88CCB6", textile: "#DFF5EC", ink: "#2A6153", edge: "#A5DBC9" },
  toilet: { floor: "#CCEDE1", furniture: "#97D3BE", textile: "#E5F7F0", ink: "#2C6657", edge: "#B4E1D2" },
  hallway: { floor: "#E0DCF0", furniture: "#B2A9D8", textile: "#F0EDFA", ink: "#453C6E", edge: "#CCC5E6" },
  patio: { floor: "#D8CBF2", furniture: "#AF9CDE", textile: "#EDE7FA", ink: "#483473", edge: "#C4B4EA" },
  office: { floor: "#C5D8F6", furniture: "#94B4E4", textile: "#E3ECFB", ink: "#2A4675", edge: "#AFC8EE" },
  garage: { floor: "#DDE2E8", furniture: "#AFBAC6", textile: "#EFF2F5", ink: "#3B4A58", edge: "#C7CFD8" },
  utility: { floor: "#C2DBF4", furniture: "#92BAE0", textile: "#E2EFFA", ink: "#284E76", edge: "#ABCCE9" },
  custom: { floor: "#E7DEF7", furniture: "#BCACE2", textile: "#F4EFFB", ink: "#4A3972", edge: "#D3C6EE" },
};

export function getRoomPalette(type: RoomType): RoomPalette {
  return ROOM_PALETTES[type] ?? ROOM_PALETTES.custom;
}

/* -------------------------------------------------------------------------- */
/* Device classification                                                       */
/* -------------------------------------------------------------------------- */

const KIND_KEYWORDS: Array<{ kind: FloorDeviceKind; pattern: RegExp }> = [
  { kind: "camera", pattern: /cam|cctv|doorbell|surveil/ },
  { kind: "tv", pattern: /\btv\b|television|display|screen|monitor/ },
  { kind: "fan", pattern: /fan|exhaust|vent/ },
  { kind: "ac", pattern: /\bac\b|air[ -]?con|conditioner|hvac|cooler|chiller/ },
  { kind: "heater", pattern: /heat|boiler|radiator/ },
  { kind: "speaker", pattern: /speaker|audio|sound|amp/ },
  { kind: "plug", pattern: /plug|outlet|socket|relay|power ?strip/ },
  { kind: "lock", pattern: /lock|deadbolt|dead-bolt/ },
  { kind: "door", pattern: /door|gate|garage|shutter|curtain/ },
  { kind: "valve", pattern: /valve|irrigation|sprinkler/ },
  { kind: "buzzer", pattern: /buzz|siren|alarm|bell|chime/ },
  { kind: "dimmer", pattern: /dimm/ },
  { kind: "light", pattern: /light|lamp|bulb|led|strip|spot|downlight/ },
];

/** Maps a HomecoreOS `device_type` (plus its name) onto a map glyph. */
export function classifyDeviceType(deviceType: string, name = ""): FloorDeviceKind {
  const key = `${deviceType} ${name}`.toLowerCase();
  for (const { kind, pattern } of KIND_KEYWORDS) {
    if (pattern.test(key)) return kind;
  }
  return "generic";
}

/** Maps a HomecoreOS `switch` onto a map glyph (switches are wired relays/lights). */
export function classifySwitch(name: string): FloorDeviceKind {
  const key = name.toLowerCase();
  if (/fan/.test(key)) return "fan";
  if (/plug|outlet|socket/.test(key)) return "plug";
  if (/valve/.test(key)) return "valve";
  if (/door|lock|gate/.test(key)) return "door";
  return "light";
}

/** Maps a HomecoreOS `sensor_type` onto a map glyph. */
export function classifySensorType(sensorType: string, name = ""): FloorDeviceKind {
  const key = `${sensorType} ${name}`.toLowerCase();
  if (/motion|pir|occupan/.test(key)) return "sensor-motion";
  if (/contact|reed|door|window|magnet/.test(key)) return "sensor-contact";
  if (/humid|moist|water|leak/.test(key)) return "sensor-humidity";
  if (/press|baro/.test(key)) return "sensor-generic";
  if (/light|lux|lumin|bh1750/.test(key)) return "sensor-light";
  if (/volt|power|current|analog|energy/.test(key)) return "sensor-power";
  if (/temp|dht|ds18|bme|thermo/.test(key)) return "sensor-temperature";
  return "sensor-generic";
}

export function isLightingKind(kind: FloorDeviceKind): boolean {
  return kind === "light" || kind === "dimmer";
}

/**
 * Legacy helper kept for the room inspector: a switch always drives a light,
 * while a device counts as lighting when its type is a lamp/dimmer/strip.
 */
export function isLightingFixture(kind: "switch" | "device", deviceType: string): boolean {
  if (kind === "switch") return true;
  const type = deviceType.toLowerCase();
  return type === "light" || type === "dimmer" || type === "dimmer_pwm" || type === "led" || type === "status_led";
}

/* -------------------------------------------------------------------------- */
/* SVG defs — floor textures, glows and shadows                                */
/* -------------------------------------------------------------------------- */

export function getFloorPatternUrl(style?: FloorStyle): string {
  switch (style) {
    case "tile":
      return "url(#hc-floor-tile)";
    case "stone":
      return "url(#hc-floor-stone)";
    case "carpet":
      return "url(#hc-floor-carpet)";
    case "wood":
      return "url(#hc-floor-wood)";
    default:
      return "";
  }
}

export const FloorMapDefs = memo(function FloorMapDefs() {
  return (
    <defs>
      {/* Soft plank seams, used as a low-opacity overlay on the pastel floor */}
      <pattern id="hc-floor-wood" width="52" height="26" patternUnits="userSpaceOnUse">
        <path d="M0 13h52M0 26h52M17 0v13M39 13v13" stroke="#FFFFFF" strokeWidth="1" strokeOpacity="0.55" />
      </pattern>

      <pattern id="hc-floor-tile" width="26" height="26" patternUnits="userSpaceOnUse">
        <path d="M26 0H0v26" fill="none" stroke="#FFFFFF" strokeWidth="1" strokeOpacity="0.6" />
      </pattern>

      <pattern id="hc-floor-stone" width="34" height="34" patternUnits="userSpaceOnUse">
        <path
          d="M34 0H0v34M17 0v17M0 17h34"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="1"
          strokeOpacity="0.45"
        />
      </pattern>

      <pattern id="hc-floor-carpet" width="14" height="14" patternUnits="userSpaceOnUse">
        <circle cx="3" cy="3" r="0.8" fill="#FFFFFF" fillOpacity="0.4" />
        <circle cx="10" cy="10" r="0.8" fill="#FFFFFF" fillOpacity="0.4" />
      </pattern>

      {/* Warm room illumination when lighting is actually on */}
      <radialGradient id="hc-room-warm-glow" cx="50%" cy="46%" r="74%">
        <stop offset="0%" stopColor="#FFE9A8" stopOpacity="0.46" />
        <stop offset="55%" stopColor="#FFD37A" stopOpacity="0.22" />
        <stop offset="100%" stopColor="#F5A94B" stopOpacity="0.05" />
      </radialGradient>

      {/* Localised halo for a lit lamp / switch */}
      <radialGradient id="hc-fixture-warm-halo" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#FFE58A" stopOpacity="0.8" />
        <stop offset="55%" stopColor="#FBBF24" stopOpacity="0.32" />
        <stop offset="100%" stopColor="#F59E0B" stopOpacity="0" />
      </radialGradient>

      {/* Cool halo for screens, fans and AC units */}
      <radialGradient id="hc-fixture-cool-halo" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#7DD3FC" stopOpacity="0.5" />
        <stop offset="60%" stopColor="#2563EB" stopOpacity="0.16" />
        <stop offset="100%" stopColor="#2563EB" stopOpacity="0" />
      </radialGradient>

      <filter id="hc-device-shadow" x="-60%" y="-60%" width="220%" height="220%">
        <feDropShadow dx="0" dy="1.1" stdDeviation="1.4" floodColor="#0F172A" floodOpacity="0.22" />
      </filter>

      <filter id="hc-plan-shadow" x="-8%" y="-8%" width="118%" height="118%">
        <feDropShadow dx="0" dy="6" stdDeviation="7" floodColor="#334155" floodOpacity="0.16" />
      </filter>

      <filter id="hc-room-selected-glow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#2563EB" floodOpacity="0.45" />
      </filter>
    </defs>
  );
});

/* -------------------------------------------------------------------------- */
/* Lightweight pastel furniture art                                            */
/* -------------------------------------------------------------------------- */

const Furniture = memo(function Furniture({ room }: { room: PlanRoom }) {
  const palette = getRoomPalette(room.type);
  const { x, y, w, h } = room;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const pad = 20;
  const iw = Math.max(48, w - pad * 2);
  const ih = Math.max(48, h - pad * 2);
  const solid = palette.furniture;
  const soft = palette.textile;
  const groupProps = { opacity: 0.95, pointerEvents: "none" as const };

  switch (room.type) {
    case "living_room": {
      const rugW = Math.min(iw * 0.66, 190);
      const rugH = Math.min(ih * 0.52, 130);
      const sofaW = Math.min(iw * 0.62, 176);
      return (
        <g {...groupProps}>
          <rect x={cx - rugW / 2} y={cy - rugH / 2 + 6} width={rugW} height={rugH} rx="6" fill={soft} fillOpacity="0.75" />
          <rect x={cx - sofaW / 2} y={y + pad} width={sofaW} height="30" rx="7" fill={solid} />
          <rect x={cx - sofaW / 2 + 7} y={y + pad + 6} width={sofaW / 3 - 12} height="12" rx="4" fill={soft} />
          <rect x={cx - sofaW / 6 + 6} y={y + pad + 6} width={sofaW / 3 - 12} height="12" rx="4" fill={soft} />
          <rect x={cx + sofaW / 6 - 1} y={y + pad + 6} width={sofaW / 3 - 12} height="12" rx="4" fill={soft} />
          <rect x={cx - Math.min(46, iw * 0.24)} y={cy + 12} width={Math.min(92, iw * 0.48)} height="26" rx="6" fill={solid} />
          <rect x={cx - Math.min(iw * 0.3, 70)} y={y + h - pad - 12} width={Math.min(iw * 0.6, 140)} height="12" rx="3" fill={solid} fillOpacity="0.7" />
        </g>
      );
    }

    case "bedroom": {
      const bedW = Math.min(iw * 0.5, 116);
      const bedH = Math.min(ih * 0.62, 138);
      const bx = cx - bedW / 2;
      const by = y + pad + 4;
      return (
        <g {...groupProps}>
          <rect x={bx - 26} y={by + 6} width="20" height="22" rx="3" fill={solid} />
          <rect x={bx + bedW + 6} y={by + 6} width="20" height="22" rx="3" fill={solid} />
          <rect x={bx} y={by} width={bedW} height={bedH} rx="6" fill={soft} />
          <rect x={bx + 3} y={by + 3} width={bedW - 6} height="20" rx="4" fill={solid} fillOpacity="0.5" />
          <rect x={bx + 8} y={by + 8} width={bedW / 2 - 12} height="14" rx="4" fill="#FFFFFF" fillOpacity="0.85" />
          <rect x={bx + bedW / 2 + 4} y={by + 8} width={bedW / 2 - 12} height="14" rx="4" fill="#FFFFFF" fillOpacity="0.85" />
          <rect x={bx + 3} y={by + bedH * 0.42} width={bedW - 6} height={bedH * 0.55} rx="4" fill={solid} fillOpacity="0.62" />
          <rect x={x + w - pad - 16} y={cy - 34} width="16" height="68" rx="3" fill={solid} fillOpacity="0.8" />
        </g>
      );
    }

    case "kitchen": {
      const counterW = Math.min(iw * 0.9, 210);
      return (
        <g {...groupProps}>
          <rect x={x + pad} y={y + pad} width={counterW} height="34" rx="4" fill={soft} />
          <rect x={x + pad} y={y + pad} width="36" height={Math.min(ih * 0.72, 150)} rx="4" fill={soft} />
          <rect x={x + pad + 52} y={y + pad + 6} width="46" height="24" rx="4" fill={solid} />
          <circle cx={x + pad + 66} cy={y + pad + 13} r="4.2" fill={soft} />
          <circle cx={x + pad + 86} cy={y + pad + 13} r="4.2" fill={soft} />
          <circle cx={x + pad + 66} cy={y + pad + 24} r="4.2" fill={soft} />
          <circle cx={x + pad + 86} cy={y + pad + 24} r="4.2" fill={soft} />
          <rect x={x + pad + 116} y={y + pad + 8} width="44" height="22" rx="5" fill={solid} fillOpacity="0.55" />
          <circle cx={x + pad + 138} cy={y + pad + 19} r="2.4" fill={soft} />
          {h > 210 && (
            <rect x={cx - 52} y={cy + 22} width="104" height="30" rx="5" fill={soft} />
          )}
        </g>
      );
    }

    case "dining": {
      const tw = Math.min(iw * 0.52, 116);
      const th = Math.min(ih * 0.34, 60);
      return (
        <g {...groupProps}>
          <rect x={cx - tw / 2} y={cy - th / 2} width={tw} height={th} rx="8" fill={solid} />
          {[-0.3, 0.3].map((offset, index) => (
            <g key={index}>
              <rect x={cx + tw * offset - 11} y={cy - th / 2 - 13} width="22" height="10" rx="3" fill={soft} />
              <rect x={cx + tw * offset - 11} y={cy + th / 2 + 3} width="22" height="10" rx="3" fill={soft} />
            </g>
          ))}
          <rect x={cx - tw / 2 - 15} y={cy - 11} width="10" height="22" rx="3" fill={soft} />
          <rect x={cx + tw / 2 + 5} y={cy - 11} width="10" height="22" rx="3" fill={soft} />
        </g>
      );
    }

    case "bathroom": {
      return (
        <g {...groupProps}>
          <rect x={x + pad} y={y + pad} width="66" height="66" rx="6" fill={soft} />
          <path
            d={`M${x + pad + 6} ${y + pad + 6} L${x + pad + 60} ${y + pad + 60}`}
            stroke={solid}
            strokeWidth="2"
          />
          <circle cx={x + pad + 33} cy={y + pad + 14} r="4" fill={solid} />
          <rect x={x + w - pad - 40} y={y + pad} width="40" height="64" rx="5" fill={soft} />
          <ellipse cx={x + w - pad - 20} cy={y + pad + 32} rx="11" ry="15" fill="#FFFFFF" fillOpacity="0.9" />
          <rect x={x + pad} y={y + h - pad - 34} width={Math.min(96, iw * 0.55)} height="34" rx="10" fill={soft} />
          <ellipse
            cx={x + pad + Math.min(96, iw * 0.55) / 2}
            cy={y + h - pad - 17}
            rx={Math.min(14, Math.min(96, iw * 0.55) * 0.2)}
            ry="9"
            fill="#FFFFFF"
            fillOpacity="0.8"
          />
        </g>
      );
    }

    case "toilet": {
      return (
        <g {...groupProps}>
          <rect x={cx - 16} y={y + pad} width="32" height="14" rx="4" fill={soft} />
          <ellipse cx={cx} cy={y + pad + 34} rx="13" ry="15" fill="#FFFFFF" fillOpacity="0.85" />
          <rect x={x + pad} y={y + h - pad - 26} width="30" height="24" rx="5" fill={soft} />
        </g>
      );
    }

    case "office": {
      return (
        <g {...groupProps}>
          <rect x={x + pad} y={y + pad} width={Math.min(iw * 0.62, 122)} height="34" rx="4" fill={soft} />
          <rect x={x + pad + 26} y={y + pad + 10} width="44" height="7" rx="2" fill={solid} />
          <circle cx={x + pad + 49} cy={y + pad + 62} r="14" fill={solid} fillOpacity="0.7" />
          <rect x={x + w - pad - 16} y={y + pad + 6} width="16" height={Math.min(ih * 0.6, 92)} rx="3" fill={solid} fillOpacity="0.8" />
        </g>
      );
    }

    case "patio": {
      return (
        <g {...groupProps}>
          <circle cx={x + pad + 14} cy={y + pad + 14} r="15" fill={solid} fillOpacity="0.65" />
          <circle cx={x + pad + 14} cy={y + h - pad - 14} r="12" fill={solid} fillOpacity="0.55" />
          <circle cx={cx + 14} cy={cy} r="18" fill={soft} />
          <rect x={cx + 40} y={cy - 13} width="18" height="26" rx="6" fill={solid} />
          <rect x={cx - 14} y={cy - 34} width="18" height="12" rx="5" fill={solid} />
        </g>
      );
    }

    case "hallway": {
      const rugW = Math.min(iw * 0.34, 70);
      return (
        <g {...groupProps}>
          <rect x={cx - rugW / 2} y={y + pad} width={rugW} height={Math.max(60, h - pad * 4)} rx="6" fill={soft} fillOpacity="0.9" />
          <rect x={x + pad} y={y + h - pad - 34} width={Math.min(64, iw * 0.4)} height="16" rx="3" fill={solid} fillOpacity="0.55" />
        </g>
      );
    }

    case "garage": {
      return (
        <g {...groupProps}>
          <rect
            x={cx - 46}
            y={cy - 72}
            width="92"
            height="144"
            rx="22"
            fill={solid}
            fillOpacity="0.28"
            stroke={solid}
            strokeWidth="2"
            strokeDasharray="7 5"
          />
        </g>
      );
    }

    case "utility": {
      return (
        <g {...groupProps}>
          <rect x={x + pad} y={y + pad} width="40" height="40" rx="5" fill={soft} />
          <circle cx={x + pad + 20} cy={y + pad + 20} r="11" fill={solid} fillOpacity="0.5" />
          <rect x={x + pad} y={y + pad + 50} width="40" height="40" rx="5" fill={soft} />
          <circle cx={x + pad + 20} cy={y + pad + 70} r="11" fill={solid} fillOpacity="0.5" />
        </g>
      );
    }

    default:
      return (
        <g {...groupProps}>
          <rect x={cx - 34} y={cy - 20} width="68" height="40" rx="8" fill={soft} fillOpacity="0.8" />
        </g>
      );
  }
});

export const RoomFloorArt = Furniture;

/* -------------------------------------------------------------------------- */
/* Device glyphs                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Compact 24×24 glyphs drawn relative to the badge centre. Every glyph is a
 * stroked line icon so a badge reads clearly at any zoom level.
 */
export const DeviceGlyph = memo(function DeviceGlyph({
  kind,
  color,
  scale = 1,
  animated = false,
}: {
  kind: FloorDeviceKind;
  color: string;
  scale?: number;
  animated?: boolean;
}) {
  const stroke = {
    stroke: color,
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };

  return (
    <g transform={`scale(${scale})`} aria-hidden="true">
      {kind === "light" || kind === "dimmer" ? (
        <g {...stroke}>
          <path d="M-3.4 -0.9a3.4 3.4 0 1 1 6.8 0c0 1.2-.6 1.9-1.2 2.6-.4.5-.6 1-.6 1.6h-3.2c0-.6-.2-1.1-.6-1.6-.6-.7-1.2-1.4-1.2-2.6Z" />
          <path d="M-1.5 6h3" />
        </g>
      ) : kind === "fan" ? (
        <g className={animated ? "hc-fan-spin" : undefined}>
          <g fill={color}>
            <path d="M0-1.2c-.9-2 -.5-5 .9-5.6 1.4-.6 2.6.8 2.1 2.7-.3 1.4-1.7 2.4-3 2.9Z" />
            <path d="M1.2 0c2-.9 5-.5 5.6.9.6 1.4-.8 2.6-2.7 2.1-1.4-.3-2.4-1.7-2.9-3Z" />
            <path d="M0 1.2c.9 2 .5 5-.9 5.6-1.4.6-2.6-.8-2.1-2.7.3-1.4 1.7-2.4 3-2.9Z" />
            <path d="M-1.2 0c-2 .9-5 .5-5.6-.9-.6-1.4.8-2.6 2.7-2.1 1.4.3 2.4 1.7 2.9 3Z" />
          </g>
          <circle cx="0" cy="0" r="1.5" fill={color} />
        </g>
      ) : kind === "tv" ? (
        <g {...stroke}>
          <rect x="-6" y="-4.6" width="12" height="8.4" rx="1.6" />
          <path d="M-2.6 6h5.2" />
        </g>
      ) : kind === "camera" ? (
        <g {...stroke}>
          <path d="M-6.4 -1.6 5.6 -4.4a1.4 1.4 0 0 1 1.7 1v3.6a1.4 1.4 0 0 1-1 1.4L-6.4 4.4Z" />
          <circle cx="-1.4" cy="0.6" r="1.3" fill={color} stroke="none" />
        </g>
      ) : kind === "plug" ? (
        <g {...stroke}>
          <rect x="-4.2" y="-5.4" width="8.4" height="7.4" rx="1.8" />
          <path d="M-1.9 -7.6v2.2M1.9 -7.6v2.2M0 2v2.6M0 4.6h-3.2M0 4.6h3.2" />
        </g>
      ) : kind === "ac" ? (
        <g {...stroke}>
          <rect x="-6.4" y="-5" width="12.8" height="5.6" rx="1.4" />
          <path d="M-3.6 1.4c.8 1 .8 2 0 3M0 1.4c.8 1 .8 2 0 3M3.6 1.4c.8 1 .8 2 0 3" />
        </g>
      ) : kind === "heater" ? (
        <g {...stroke}>
          <rect x="-5.6" y="-4.4" width="11.2" height="9" rx="1.6" />
          <path d="M-3 -.6v3M0 -.6v3M3 -.6v3" />
        </g>
      ) : kind === "lock" ? (
        <g {...stroke}>
          <path d="M-3 -1.4v-2.2a3 3 0 0 1 6 0v2.2" />
          <rect x="-4.6" y="-1.4" width="9.2" height="6.8" rx="1.6" />
        </g>
      ) : kind === "door" ? (
        <g {...stroke}>
          <rect x="-3.4" y="-6" width="6.8" height="12" rx="1" />
          <path d="M-3.4 6h6.8" />
          <circle cx="1.4" cy="0.4" r="0.9" fill={color} stroke="none" />
        </g>
      ) : kind === "valve" ? (
        <g {...stroke}>
          <circle cx="0" cy="0" r="3" />
          <path d="M-5.4 0h2.4M3 0h2.4M0-5.4v2.4M0 3v2.4" />
        </g>
      ) : kind === "buzzer" ? (
        <g {...stroke}>
          <path d="M-4.2 -3.2h2.6l3.6-2.6v11.6L-1.6 3.2h-2.6Z" />
          <path d="M3.6 0.4c.8.8.8 2.2 0 3" />
        </g>
      ) : kind === "speaker" ? (
        <g {...stroke}>
          <rect x="-3.4" y="-6" width="6.8" height="12" rx="1.6" />
          <circle cx="0" cy="-2.4" r="1.4" />
          <circle cx="0" cy="2.4" r="1.8" />
        </g>
      ) : kind === "sensor-temperature" ? (
        <g {...stroke}>
          <path d="M1.4 1.4V-4a1.4 1.4 0 0 0-2.8 0v5.4a2.8 2.8 0 1 0 2.8 0Z" />
          <path d="M0 0v3.4" />
        </g>
      ) : kind === "sensor-humidity" ? (
        <g {...stroke}>
          <path d="M0-6c0 0-4 4.2-4 6.8a4 4 0 0 0 8 0C4-1.8 0-6 0-6Z" />
        </g>
      ) : kind === "sensor-motion" ? (
        <g {...stroke}>
          <circle cx="-3.4" cy="0" r="1.6" fill={color} stroke="none" />
          <path d="M0 -3.4a4.8 4.8 0 0 1 0 6.8M2.4 -5.4a7.6 7.6 0 0 1 0 10.8" />
        </g>
      ) : kind === "sensor-contact" ? (
        <g {...stroke}>
          <rect x="-6" y="-2.6" width="5" height="5.2" rx="1.2" />
          <rect x="1" y="-2.6" width="5" height="5.2" rx="1.2" />
        </g>
      ) : kind === "sensor-light" ? (
        <g {...stroke}>
          <circle cx="0" cy="0" r="2.6" />
          <path d="M0-6v1.6M0 4.4v1.6M-6 0h1.6M4.4 0h1.6M-4.2-4.2l1.1 1.1M3.1 3.1l1.1 1.1M4.2-4.2 3.1-3.1M-3.1 3.1l-1.1 1.1" />
        </g>
      ) : kind === "sensor-power" ? (
        <g {...stroke}>
          <path d="M1.4-6-4 0.8h3.4L-1 6l5.4-6.8H1Z" />
        </g>
      ) : kind === "sensor-generic" ? (
        <g {...stroke}>
          <path d="M-6 0h2.4l1.8-3.6 2.4 7.2 1.8-3.6H6" />
        </g>
      ) : (
        <g {...stroke}>
          <path d="M0-5.4V1.6M-3.4-1.6a5.2 5.2 0 1 0 6.8 0" />
        </g>
      )}
    </g>
  );
});

export function deviceKindLabel(kind: FloorDeviceKind): string {
  return kind
    .replace("sensor-", "Sensor · ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/* -------------------------------------------------------------------------- */
/* Viewport zoom — the map and its inner canvas share one range and clamp      */
/* -------------------------------------------------------------------------- */

export const FLOOR_MIN_ZOOM = 0.55;
export const FLOOR_MAX_ZOOM = 3;

/** Clamps a zoom factor into the floor-plan viewport range (3 decimals). */
export function clampFloorZoom(value: number): number {
  return Math.min(FLOOR_MAX_ZOOM, Math.max(FLOOR_MIN_ZOOM, Number(value.toFixed(3))));
}
