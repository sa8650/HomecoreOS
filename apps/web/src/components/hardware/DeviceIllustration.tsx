/**
 * Reusable SVG device illustrations for the Wire Diagram.
 * Everything is inline SVG on a dark background (the wire-diagram canvas is
 * dark) — no external assets. Each illustration is keyed by a stable string
 * used by both the circuit engine (`CircuitComponent.illustration`) and the
 * entity panel.
 */

function Frame({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 120 96"
      className="h-full w-full"
      role="img"
      aria-hidden="true"
      data-illustration={name}
    >
      {children}
    </svg>
  );
}

const lbl = {
  fontFamily: "ui-monospace, monospace",
  fontWeight: 700,
} as const;

/** Blue 1-channel relay module (also used for generic “relay channel”). */
function RelayIllustration() {
  return (
    <Frame name="relay">
      <rect x="8" y="18" width="104" height="58" rx="7" fill="#1d4ed8" stroke="#3b82f6" strokeWidth="1.5" />
      {/* screw terminals */}
      {[26, 50, 74].map((x) => (
        <g key={x}>
          <rect x={x - 9} y="10" width="18" height="14" rx="2" fill="#0f172a" stroke="#64748b" strokeWidth="1.2" />
          <circle cx={x} cy="17" r="4.4" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.3" />
          <line x1={x - 2.6} y1="17" x2={x + 2.6} y2="17" stroke="#94a3b8" strokeWidth="1.2" />
        </g>
      ))}
      {/* relay cube */}
      <rect x="16" y="36" width="34" height="30" rx="2.5" fill="#0b1220" stroke="#334155" strokeWidth="1.2" />
      <text x="33" y="55" textAnchor="middle" fill="#cbd5e1" fontSize="8" style={lbl}>RELAY</text>
      {/* optocoupler + header pins */}
      <rect x="58" y="40" width="16" height="12" rx="1.5" fill="#0b1220" stroke="#334155" />
      {[88, 98, 108].map((x) => (
        <rect key={x} x={x - 1.6} y="56" width="3.2" height="12" fill="#fbbf24" stroke="#b45309" strokeWidth="0.5" />
      ))}
      <text x="16" y="34" fill="#bfdbfe" fontSize="6.5" style={lbl}>IN&nbsp;&nbsp;VCC&nbsp;&nbsp;GND</text>
    </Frame>
  );
}

/** PWM dimmer module — relay-class board with a triac-style heatsink. */
function DimmerIllustration() {
  return (
    <Frame name="dimmer">
      <rect x="8" y="20" width="104" height="54" rx="7" fill="#7c2d12" stroke="#fb923c" strokeWidth="1.5" />
      {/* screw terminals */}
      {[28, 52].map((x) => (
        <g key={x}>
          <rect x={x - 9} y="12" width="18" height="14" rx="2" fill="#0f172a" stroke="#64748b" strokeWidth="1.2" />
          <circle cx={x} cy="19" r="4.4" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.3" />
        </g>
      ))}
      {/* heatsink */}
      {[66, 74, 82, 90, 98].map((x) => (
        <rect key={x} x={x - 1.5} y="28" width="3" height="26" fill="#475569" stroke="#94a3b8" strokeWidth="0.6" />
      ))}
      <rect x="16" y="40" width="30" height="22" rx="2" fill="#0b1220" stroke="#334155" />
      <text x="31" y="55" textAnchor="middle" fill="#fdba74" fontSize="8.5" style={lbl}>PWM</text>
    </Frame>
  );
}

/** Active piezo buzzer. */
function BuzzerIllustration() {
  return (
    <Frame name="buzzer">
      <ellipse cx="60" cy="52" rx="34" ry="24" fill="#0b1220" stroke="#334155" strokeWidth="1.5" />
      <ellipse cx="60" cy="30" rx="34" ry="9" fill="#1e293b" stroke="#475569" strokeWidth="1.2" />
      <ellipse cx="60" cy="30" rx="22" ry="5.4" fill="#0b1220" stroke="#475569" />
      <circle cx="60" cy="30" r="2.6" fill="#020617" />
      {/* sound arcs */}
      <path d="M 104 22 A 14 14 0 0 1 112 36" fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" />
      <path d="M 100 14 A 22 22 0 0 1 118 36" fill="none" stroke="#22d3ee" strokeWidth="1.6" strokeLinecap="round" opacity="0.65" />
      {/* legs */}
      <rect x="42" y="70" width="3.4" height="14" fill="#fbbf24" />
      <rect x="74" y="70" width="3.4" height="14" fill="#fbbf24" />
    </Frame>
  );
}

/** Discrete status LED. */
function LedIllustration() {
  return (
    <Frame name="led">
      <path d="M 38 62 L 38 44 A 22 22 0 0 1 82 44 L 82 62 Z" fill="#ef4444" fillOpacity="0.85" stroke="#fca5a5" strokeWidth="1.5" />
      <rect x="34" y="62" width="52" height="6" rx="2" fill="#b91c1c" stroke="#fca5a5" />
      {/* flat side = cathode */}
      <rect x="70" y="68" width="4" height="16" fill="#fbbf24" />
      <rect x="46" y="68" width="4" height="22" fill="#fbbf24" />
      {/* rays */}
      {[[30, 30], [60, 14], [90, 30]].map(([x, y], i) => (
        <line key={i} x1={x} y1={y} x2={x + (x - 60) * 0.28} y2={y - 12} stroke="#fca5a5" strokeWidth="2" strokeLinecap="round" />
      ))}
    </Frame>
  );
}

/** Electronic door lock with keypad. */
function LockIllustration() {
  return (
    <Frame name="lock">
      <rect x="34" y="8" width="52" height="80" rx="7" fill="#1f2937" stroke="#94a3b8" strokeWidth="1.5" />
      <rect x="44" y="16" width="32" height="12" rx="2" fill="#0b1220" stroke="#334155" />
      <text x="60" y="25" textAnchor="middle" fill="#34d399" fontSize="7" style={lbl}>LOCKED</text>
      {/* keypad */}
      {[0, 1, 2].map((r) =>
        [0, 1, 2].map((c) => (
          <circle key={`${r}-${c}`} cx={50 + c * 10} cy={38 + r * 10} r="3" fill="#374151" stroke="#64748b" strokeWidth="0.7" />
        ))
      )}
      <circle cx="60" cy="76" r="4.6" fill="#0b1220" stroke="#64748b" />
    </Frame>
  );
}

/** Motorised ball valve with solenoid coil. */
function ValveIllustration() {
  return (
    <Frame name="valve">
      {/* pipe */}
      <rect x="6" y="58" width="108" height="12" rx="6" fill="#334155" stroke="#64748b" strokeWidth="1.2" />
      {/* valve body (bowtie) */}
      <path d="M 46 58 L 60 70 L 74 58 Z" fill="#0f766e" stroke="#2dd4bf" strokeWidth="1.3" />
      <path d="M 46 70 L 60 58 L 74 70 Z" fill="#115e59" stroke="#2dd4bf" strokeWidth="1.3" />
      {/* solenoid coil */}
      <rect x="48" y="14" width="24" height="26" rx="3" fill="#7c3aed" stroke="#c4b5fd" strokeWidth="1.4" />
      {[20, 26, 32].map((y) => (
        <line key={y} x1="48" y1={y} x2="72" y2={y} stroke="#c4b5fd" strokeWidth="1.1" />
      ))}
      <rect x="57" y="40" width="6" height="8" fill="#334155" />
    </Frame>
  );
}

/** PIR motion sensor — white Fresnel dome. */
function PirIllustration() {
  return (
    <Frame name="pir">
      <rect x="22" y="60" width="76" height="22" rx="3" fill="#166534" stroke="#4ade80" strokeWidth="1.3" />
      <path d="M 26 62 A 34 30 0 0 1 94 62 Z" fill="#f8fafc" stroke="#cbd5e1" strokeWidth="1.4" opacity="0.96" />
      <path d="M 38 62 A 22 19 0 0 1 82 62" fill="none" stroke="#94a3b8" strokeWidth="1.1" />
      <path d="M 48 62 A 12 10 0 0 1 72 62" fill="none" stroke="#94a3b8" strokeWidth="1" />
      <rect x="40" y="74" width="40" height="4" fill="#0b3b1e" />
      {/* pins */}
      {[48, 60, 72].map((x) => (
        <rect key={x} x={x - 1.4} y="82" width="2.8" height="8" fill="#fbbf24" />
      ))}
    </Frame>
  );
}

/** DHT22 / AM2302 blue grid sensor. */
function Dht22Illustration() {
  return (
    <Frame name="dht22">
      <rect x="26" y="10" width="68" height="58" rx="5" fill="#1d4ed8" stroke="#60a5fa" strokeWidth="1.6" />
      {/* grid holes */}
      {[22, 32, 42, 52].map((y) =>
        [38, 50, 62, 74, 86].map((x) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="2.5" fill="#0b1c3f" />
        ))
      )}
      <text x="60" y="64" textAnchor="middle" fill="#dbeafe" fontSize="8" style={lbl}>DHT22</text>
      {/* legs */}
      {[40, 53, 66, 79].map((x) => (
        <rect key={x} x={x - 1.5} y="68" width="3" height="16" fill="#fbbf24" />
      ))}
    </Frame>
  );
}

/** DS18B20 in TO-92 package. */
function Ds18b20Illustration() {
  return (
    <Frame name="ds18b20">
      <path d="M 34 52 A 26 26 0 0 1 86 52 L 86 60 L 34 60 Z" fill="#0b1220" stroke="#475569" strokeWidth="1.6" />
      <rect x="34" y="52" width="52" height="8" fill="#0b1220" stroke="#475569" strokeWidth="1.4" />
      <text x="60" y="46" textAnchor="middle" fill="#94a3b8" fontSize="6.6" style={lbl}>DS18B20</text>
      {[46, 60, 74].map((x) => (
        <rect key={x} x={x - 1.7} y="60" width="3.4" height="24" fill="#fbbf24" />
      ))}
    </Frame>
  );
}

/** Small purple/black I2C breakout (BME280 / BH1750 class). */
function BreakoutIllustration() {
  return (
    <Frame name="breakout">
      <rect x="18" y="24" width="84" height="42" rx="4" fill="#4c1d95" stroke="#a78bfa" strokeWidth="1.5" />
      <rect x="44" y="34" width="32" height="22" rx="2" fill="#0b1220" stroke="#a78bfa" strokeWidth="1" />
      <rect x="52" y="40" width="16" height="10" fill="#1e293b" />
      {/* header pins */}
      {[28, 40, 52, 64, 76, 88].map((x) => (
        <rect key={x} x={x - 1.3} y="66" width="2.6" height="12" fill="#fbbf24" />
      ))}
      <text x="30" y="22" fill="#ddd6fe" fontSize="7" style={lbl}>I2C BREAKOUT</text>
    </Frame>
  );
}

/** Reed switch — glass capsule. */
function ReedIllustration() {
  return (
    <Frame name="reed">
      <rect x="26" y="38" width="68" height="14" rx="7" fill="#e0f2fe" fillOpacity="0.18" stroke="#e2e8f0" strokeWidth="1.4" />
      <rect x="34" y="42" width="26" height="6" fill="#94a3b8" />
      <rect x="62" y="42" width="24" height="6" fill="#94a3b8" />
      <line x1="26" y1="45" x2="8" y2="45" stroke="#fbbf24" strokeWidth="2.6" />
      <line x1="94" y1="45" x2="112" y2="45" stroke="#fbbf24" strokeWidth="2.6" />
      {/* magnet hint */}
      <rect x="48" y="10" width="24" height="12" rx="2" fill="#ef4444" stroke="#fca5a5" />
      <text x="60" y="19" textAnchor="middle" fill="#fecaca" fontSize="6.4" style={lbl}>MAG</text>
    </Frame>
  );
}

/** Ceiling fan. */
function FanIllustration() {
  return (
    <Frame name="fan">
      <circle cx="60" cy="44" r="30" fill="#0f2740" stroke="#38bdf8" strokeWidth="1.6" />
      {[0, 72, 144, 216, 288].map((deg) => (
        <path
          key={deg}
          d="M 60 44 C 66 26, 84 22, 88 34 C 78 40, 70 44, 60 44 Z"
          fill="#38bdf8"
          fillOpacity="0.55"
          stroke="#7dd3fc"
          strokeWidth="1.1"
          transform={`rotate(${deg} 60 44)`}
        />
      ))}
      <circle cx="60" cy="44" r="6.5" fill="#e0f2fe" stroke="#38bdf8" strokeWidth="1.4" />
      <rect x="44" y="76" width="32" height="6" rx="3" fill="#1e293b" stroke="#475569" />
    </Frame>
  );
}

/** Light bulb. */
function BulbIllustration() {
  return (
    <Frame name="bulb">
      <circle cx="60" cy="36" r="22" fill="#fef08a" fillOpacity="0.9" stroke="#fde047" strokeWidth="1.6" />
      <path d="M 51 52 L 51 62 L 69 62 L 69 52" fill="#eab308" stroke="#fde047" strokeWidth="1.3" />
      <line x1="52" y1="66" x2="68" y2="66" stroke="#a16207" strokeWidth="2.4" />
      <line x1="52" y1="71" x2="68" y2="71" stroke="#a16207" strokeWidth="2.4" />
      {/* rays */}
      {[[22, 20], [60, 6], [98, 20]].map(([x, y], i) => (
        <line key={i} x1={x} y1={y} x2={x + (x - 60) * 0.25} y2={y - 4} stroke="#fde047" strokeWidth="2" strokeLinecap="round" opacity="0.9" />
      ))}
    </Frame>
  );
}

/** Television. */
function TvIllustration() {
  return (
    <Frame name="tv">
      <rect x="14" y="14" width="92" height="54" rx="5" fill="#020617" stroke="#475569" strokeWidth="1.6" />
      <rect x="19" y="19" width="82" height="44" rx="3" fill="#0c2a4d" />
      <path d="M 30 52 C 44 34, 60 46, 74 28" fill="none" stroke="#38bdf8" strokeWidth="2.4" strokeLinecap="round" opacity="0.85" />
      <rect x="46" y="68" width="28" height="4" fill="#475569" />
      <rect x="34" y="72" width="52" height="4" rx="2" fill="#334155" />
    </Frame>
  );
}

/** AC mains outlet — hazard-coded. */
function AcMainsIllustration() {
  return (
    <Frame name="ac_mains">
      <rect x="24" y="8" width="72" height="80" rx="10" fill="#450a0a" stroke="#ef4444" strokeWidth="2" />
      <circle cx="60" cy="34" r="13" fill="#7f1d1d" stroke="#fca5a5" strokeWidth="1.4" />
      <circle cx="55" cy="34" r="2.2" fill="#fecaca" />
      <circle cx="65" cy="34" r="2.2" fill="#fecaca" />
      <path d="M 66 50 L 55 62 L 61 62 L 54 74 L 68 59 L 61 59 L 68 50 Z" fill="#fbbf24" stroke="#fde68a" strokeWidth="0.8" />
    </Frame>
  );
}

/** External DC PSU brick. */
function PsuIllustration() {
  return (
    <Frame name="psu">
      <rect x="12" y="24" width="96" height="44" rx="7" fill="#111827" stroke="#f59e0b" strokeWidth="1.8" />
      {[44, 52, 60, 68, 76].map((x) => (
        <line key={x} x1={x} y1="32" x2={x} y2="44" stroke="#f59e0b" strokeWidth="1.6" strokeLinecap="round" opacity="0.8" />
      ))}
      <text x="26" y="60" fill="#fcd34d" fontSize="8" style={lbl}>DC OUT</text>
      {/* output terminals */}
      <circle cx="30" cy="76" r="3.6" fill="#ef4444" />
      <circle cx="48" cy="76" r="3.6" fill="#0f172a" stroke="#94a3b8" />
      <text x="30" y="90" textAnchor="middle" fill="#fca5a5" fontSize="6" style={lbl}>+V</text>
      <text x="48" y="90" textAnchor="middle" fill="#94a3b8" fontSize="6" style={lbl}>0V</text>
    </Frame>
  );
}

/** Generic household appliance (washing machine glyph). */
function ApplianceIllustration() {
  return (
    <Frame name="appliance">
      <rect x="24" y="10" width="72" height="76" rx="8" fill="#111827" stroke="#94a3b8" strokeWidth="1.6" />
      <circle cx="60" cy="50" r="17" fill="#1e293b" stroke="#64748b" strokeWidth="1.6" />
      <circle cx="60" cy="50" r="10" fill="#0c2a4d" stroke="#38bdf8" strokeWidth="1" opacity="0.9" />
      <circle cx="36" cy="21" r="2.6" fill="#475569" />
      <rect x="46" y="18" width="36" height="6" rx="3" fill="#1e293b" />
    </Frame>
  );
}

/** LED strip segment. */
function LedStripIllustration() {
  return (
    <Frame name="led_strip">
      <rect x="8" y="38" width="104" height="18" rx="3" fill="#fefce8" fillOpacity="0.14" stroke="#fde047" strokeWidth="1.3" />
      {[26, 46, 66, 86].map((x) => (
        <g key={x}>
          <rect x={x - 5} y="42" width="10" height="10" rx="1.5" fill="#fef08a" stroke="#eab308" strokeWidth="1" />
          <line x1={x - 6} y1="33" x2={x + 6} y2="33" stroke="#fde047" strokeWidth="1.6" strokeLinecap="round" />
        </g>
      ))}
      {/* cut marks */}
      <line x1="36" y1="38" x2="36" y2="56" stroke="#fde047" strokeWidth="1" strokeDasharray="2 2" />
      <line x1="56" y1="38" x2="56" y2="56" stroke="#fde047" strokeWidth="1" strokeDasharray="2 2" />
      <line x1="76" y1="38" x2="76" y2="56" stroke="#fde047" strokeWidth="1" strokeDasharray="2 2" />
      <text x="60" y="72" textAnchor="middle" fill="#fef08a" fontSize="6.6" style={lbl}>12/24V LED STRIP</text>
    </Frame>
  );
}

/** NPN transistor (low-side driver). */
function NpnIllustration() {
  const stroke = "#22d3ee";
  return (
    <Frame name="npn">
      <circle cx="60" cy="44" r="26" fill="#0b1220" stroke="#22d3ee" strokeWidth="1.6" />
      <line x1="46" y1="44" x2="60" y2="44" stroke={stroke} strokeWidth="2" />
      <line x1="56" y1="26" x2="56" y2="62" stroke={stroke} strokeWidth="2.4" />
      <line x1="56" y1="34" x2="74" y2="22" stroke={stroke} strokeWidth="2" />
      <line x1="56" y1="54" x2="74" y2="66" stroke={stroke} strokeWidth="2" />
      <path d="M 74 66 L 66 62 L 70 55 Z" fill="#22d3ee" />
      <text x="60" y="90" textAnchor="middle" fill="#67e8f9" fontSize="7" style={lbl}>NPN</text>
    </Frame>
  );
}

/** Logic-level N-MOSFET. */
function MosfetIllustration() {
  const stroke = "#22d3ee";
  return (
    <Frame name="mosfet">
      <circle cx="60" cy="44" r="26" fill="#0b1220" stroke="#22d3ee" strokeWidth="1.6" />
      <line x1="38" y1="44" x2="52" y2="44" stroke={stroke} strokeWidth="2" />
      <line x1="54" y1="30" x2="54" y2="58" stroke={stroke} strokeWidth="2.2" />
      <line x1="62" y1="24" x2="62" y2="64" stroke={stroke} strokeWidth="2.2" />
      <line x1="62" y1="34" x2="76" y2="34" stroke={stroke} strokeWidth="2" />
      <line x1="62" y1="54" x2="76" y2="54" stroke={stroke} strokeWidth="2" />
      <line x1="69" y1="54" x2="76" y2="34" stroke={stroke} strokeWidth="1.4" strokeDasharray="2.4 2" />
      <text x="60" y="90" textAnchor="middle" fill="#67e8f9" fontSize="7" style={lbl}>N-MOSFET</text>
    </Frame>
  );
}

/** Flyback diode. */
function DiodeIllustration() {
  return (
    <Frame name="diode">
      <line x1="14" y1="44" x2="106" y2="44" stroke="#f472b6" strokeWidth="2" />
      <path d="M 44 26 L 44 62 L 74 44 Z" fill="#f472b6" fillOpacity="0.75" stroke="#fbcfe8" strokeWidth="1.3" />
      <line x1="78" y1="24" x2="78" y2="64" stroke="#fbcfe8" strokeWidth="3" />
      <text x="60" y="84" textAnchor="middle" fill="#f9a8d4" fontSize="7" style={lbl}>1N4007</text>
    </Frame>
  );
}

/** Resistor (axial). */
function ResistorIllustration() {
  return (
    <Frame name="resistor">
      <line x1="10" y1="44" x2="30" y2="44" stroke="#fbbf24" strokeWidth="2.4" />
      <line x1="90" y1="44" x2="110" y2="44" stroke="#fbbf24" strokeWidth="2.4" />
      <rect x="30" y="32" width="60" height="24" rx="11" fill="#b45309" stroke="#fbbf24" strokeWidth="1.6" />
      {[42, 52, 62, 76].map((x, i) => (
        <line key={x} x1={x} y1="33" x2={x} y2="55" stroke={["#111", "#b91c1c", "#7c3aed", "#b45309"][i]} strokeWidth="3.2" />
      ))}
    </Frame>
  );
}

/** Bidirectional logic level shifter. */
function ShifterIllustration() {
  return (
    <Frame name="shifter">
      <rect x="18" y="28" width="84" height="38" rx="4" fill="#0c4a6e" stroke="#38bdf8" strokeWidth="1.5" />
      <text x="60" y="44" textAnchor="middle" fill="#e0f2fe" fontSize="7.4" style={lbl}>LEVEL</text>
      <text x="60" y="56" textAnchor="middle" fill="#7dd3fc" fontSize="7.4" style={lbl}>SHIFTER</text>
      {[34, 50, 66, 82].map((x) => (
        <rect key={x} x={x - 1.3} y="66" width="2.6" height="10" fill="#fbbf24" />
      ))}
    </Frame>
  );
}

/** Voltage divider (two resistors on a mini board). */
function DividerIllustration() {
  return (
    <Frame name="divider">
      <line x1="60" y1="12" x2="60" y2="30" stroke="#a78bfa" strokeWidth="2" />
      <rect x="48" y="30" width="24" height="10" rx="5" fill="#b45309" stroke="#fbbf24" strokeWidth="1.2" />
      <line x1="60" y1="40" x2="60" y2="54" stroke="#a78bfa" strokeWidth="2" />
      <circle cx="60" cy="54" r="2.6" fill="#a78bfa" />
      <line x1="60" y1="54" x2="86" y2="54" stroke="#a78bfa" strokeWidth="2" />
      <rect x="48" y="58" width="24" height="10" rx="5" fill="#b45309" stroke="#fbbf24" strokeWidth="1.2" />
      <line x1="60" y1="68" x2="60" y2="84" stroke="#a78bfa" strokeWidth="2" />
      <text x="90" y="57" fill="#c4b5fd" fontSize="6.4" style={lbl}>ADC</text>
    </Frame>
  );
}

const ILLUSTRATIONS: Record<string, () => React.JSX.Element> = {
  relay: RelayIllustration,
  dimmer: DimmerIllustration,
  buzzer: BuzzerIllustration,
  led: LedIllustration,
  lock: LockIllustration,
  valve: ValveIllustration,
  pir: PirIllustration,
  dht22: Dht22Illustration,
  ds18b20: Ds18b20Illustration,
  breakout: BreakoutIllustration,
  reed: ReedIllustration,
  fan: FanIllustration,
  bulb: BulbIllustration,
  tv: TvIllustration,
  ac_mains: AcMainsIllustration,
  psu: PsuIllustration,
  appliance: ApplianceIllustration,
  led_strip: LedStripIllustration,
  npn: NpnIllustration,
  mosfet: MosfetIllustration,
  diode: DiodeIllustration,
  resistor: ResistorIllustration,
  shifter: ShifterIllustration,
  divider: DividerIllustration,
};

/** Map a device/sensor class label (from the engine) to an illustration key. */
export function illustrationForEntity(opts: {
  kind: "sensor" | "device" | "switch";
  typeLabel: string;
  driverId?: string | null;
}): string {
  const t = opts.typeLabel.toLowerCase();
  if (opts.kind === "sensor") {
    switch (opts.driverId) {
      case "pir": return "pir";
      case "dht22": return "dht22";
      case "ds18b20": return "ds18b20";
      case "bme280":
      case "bh1750":
        return "breakout";
      case "reed": return "reed";
      case "adc_voltage": return "divider";
      default: return "breakout";
    }
  }
  if (opts.kind === "switch") return "relay";
  if (t.includes("dimmer")) return "dimmer";
  if (t.includes("buzzer")) return "buzzer";
  if (t.includes("status led") || t.includes("led")) return "led";
  if (t.includes("lock")) return "lock";
  if (t.includes("valve")) return "valve";
  return "relay";
}

export function DeviceIllustration({ name }: { name: string }): React.JSX.Element {
  const Cmp = ILLUSTRATIONS[name] ?? ApplianceIllustration;
  return (
    <span className="block h-full w-full" aria-hidden="true">
      <Cmp />
    </span>
  );
}
