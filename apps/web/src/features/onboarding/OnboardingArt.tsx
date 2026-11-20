/**
 * Custom onboarding illustrations.
 *
 * Four hand-drawn SVGs in the HomecoreOS visual language (soft blueprint
 * surfaces, rounded hardware, blue/emerald/amber accents) so the tour never
 * falls back to generic stock art. They are decorative, so each one carries a
 * single `aria-label` and hides its internals from assistive technology.
 */

const SURFACE = "fill-white dark:fill-slate-900";
const SURFACE_ALT = "fill-slate-50 dark:fill-slate-950";
const STROKE = "stroke-slate-300 dark:stroke-slate-700";
const INK = "fill-slate-900 dark:fill-slate-100";
const MUTED = "fill-slate-400 dark:fill-slate-500";

function ArtFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <svg
      aria-label={label}
      className="h-auto w-full"
      role="img"
      viewBox="0 0 480 320"
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

/** Step 1 — a home cut into rooms, wired to the HomecoreOS dashboard. */
export function WelcomeHomeArt() {
  return (
    <ArtFrame label="A house of connected rooms reporting into one HomecoreOS dashboard">
      <defs>
        <linearGradient id="ob-welcome-sky" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#eff6ff" />
          <stop offset="100%" stopColor="#f8fafc" />
        </linearGradient>
      </defs>
      <rect className="fill-blue-50 dark:fill-slate-900" height="320" rx="18" width="480" />

      {/* House shell */}
      <path className={`${SURFACE} ${STROKE}`} d="M52 140 168 58l116 82v122H52Z" strokeWidth="2.5" />
      <path className="fill-blue-100 dark:fill-slate-800 stroke-slate-300 dark:stroke-slate-700" d="M52 140 168 58l116 82Z" strokeWidth="2.5" />
      <path className={STROKE} d="M112 262v-70h56v70M168 140v122M224 168h44v94" strokeWidth="2" />

      {/* Rooms */}
      <text className={MUTED} fontSize="11" x="70" y="212">Living</text>
      <text className={MUTED} fontSize="11" x="122" y="182">Hall</text>
      <text className={MUTED} fontSize="11" x="236" y="222">Bed</text>

      {/* Light bulbs / devices in rooms */}
      <g className="text-amber-500">
        <circle cx="96" cy="188" r="8" className="fill-amber-400/80" />
        <path d="M96 196v6" className="stroke-amber-500" strokeWidth="2" strokeLinecap="round" />
        <circle cx="258" cy="196" r="8" className="fill-amber-400/60" />
        <path d="M258 204v6" className="stroke-amber-500" strokeWidth="2" strokeLinecap="round" />
      </g>
      <g className="text-sky-500">
        <circle cx="140" cy="232" r="7" className="fill-sky-400/70" />
        <path d="M136 232h8M140 228v8" className="stroke-white dark:stroke-slate-900" strokeWidth="1.6" strokeLinecap="round" />
      </g>

      {/* Link to the dashboard */}
      <path
        className="stroke-blue-400 dark:stroke-blue-500"
        d="M284 150h44c10 0 14 8 14 18v22"
        fill="none"
        strokeDasharray="5 6"
        strokeWidth="2.5"
      />

      {/* Dashboard card */}
      <g>
        <rect className={SURFACE} height="132" rx="14" width="126" x="332" y="92" />
        <rect className="fill-blue-600" height="10" rx="5" width="54" x="346" y="106" />
        <rect className="fill-slate-200 dark:fill-slate-700" height="7" rx="3.5" width="82" x="346" y="124" />
        <rect className="fill-slate-100 dark:fill-slate-800" height="34" rx="8" width="46" x="346" y="142" />
        <rect className="fill-slate-100 dark:fill-slate-800" height="34" rx="8" width="46" x="398" y="142" />
        <circle className="fill-emerald-400" cx="358" cy="159" r="4" />
        <circle className="fill-amber-400" cx="410" cy="159" r="4" />
        <rect className="fill-slate-200 dark:fill-slate-700" height="7" rx="3.5" width="66" x="346" y="190" />
        <rect className="fill-slate-200 dark:fill-slate-700" height="7" rx="3.5" width="44" x="346" y="204" />
      </g>

      {/* Sensor chip */}
      <g>
        <rect className="fill-white dark:fill-slate-900 stroke-slate-300 dark:stroke-slate-700" height="30" rx="10" width="86" x="52" y="272" strokeWidth="2" />
        <circle className="fill-emerald-400" cx="70" cy="287" r="4" />
        <text className={INK} fontSize="11" x="82" y="291">22.4 °C</text>
      </g>
    </ArtFrame>
  );
}

/** Step 2 — device → node → home Wi-Fi → HomecoreOS. */
export function HardwareChainArt() {
  return (
    <ArtFrame label="A sensor, switch and relay wired into a Node board that reaches HomecoreOS over home Wi-Fi">
      <rect className="fill-slate-50 dark:fill-slate-900" height="320" rx="18" width="480" />

      {/* Field devices */}
      <g>
        <rect className={`${SURFACE} ${STROKE}`} height="52" rx="12" width="86" x="18" y="52" strokeWidth="2" />
        <circle className="fill-sky-400" cx="42" cy="78" r="8" />
        <path className="stroke-sky-400" d="M52 74c8-6 16-6 24 0M52 82c8 6 16 6 24 0" fill="none" strokeWidth="2" strokeLinecap="round" />
        <text className={MUTED} fontSize="10" x="24" y="120">Sensor</text>
      </g>
      <g>
        <rect className={`${SURFACE} ${STROKE}`} height="52" rx="12" width="86" x="18" y="140" strokeWidth="2" />
        <rect className="fill-slate-200 dark:fill-slate-700" height="16" rx="8" width="44" x="30" y="158" />
        <circle className="fill-emerald-400" cx="66" cy="166" r="7" />
        <text className={MUTED} fontSize="10" x="24" y="210">Switch</text>
      </g>
      <g>
        <rect className={`${SURFACE} ${STROKE}`} height="52" rx="12" width="86" x="18" y="228" strokeWidth="2" />
        <path className="fill-amber-400" d="M58 240l-12 20h9l-3 12 14-20h-9l3-12Z" />
        <text className={MUTED} fontSize="10" x="24" y="298">Relay module</text>
      </g>

      {/* Wiring into the node */}
      <g className="stroke-slate-400 dark:stroke-slate-500" fill="none" strokeWidth="2.5" strokeLinecap="round">
        <path d="M104 78h34c10 0 10 14 20 14h8" />
        <path d="M104 166h62" />
        <path d="M104 254h34c10 0 10-14 20-14h8" />
      </g>

      {/* Node board */}
      <g>
        <rect className="fill-slate-900 dark:fill-slate-800" height="196" rx="14" width="126" x="176" y="62" />
        <rect className="fill-slate-800 dark:fill-slate-700" height="120" rx="8" width="86" x="196" y="96" />
        {/* antenna */}
        <path className="stroke-slate-300" d="M282 62v-16h-12" fill="none" strokeWidth="2.5" strokeLinecap="round" />
        {/* chip + pins */}
        <rect className="fill-slate-600 dark:fill-slate-500" height="46" rx="6" width="54" x="212" y="130" />
        <text className="fill-white" fontSize="10" x="222" y="158">ESP32</text>
        <g className="stroke-slate-500" strokeWidth="2">
          <path d="M196 108h-10M196 124h-10M196 140h-10M196 156h-10M196 172h-10M196 188h-10" />
          <path d="M282 108h10M282 124h10M282 140h10M282 156h10M282 172h10M282 188h10" />
        </g>
        <circle className="fill-emerald-400" cx="278" cy="236" r="5" />
        <text className="fill-slate-300" fontSize="10" x="192" y="86">NODE</text>
        <text className={MUTED} fontSize="10" x="196" y="276">Board Library board</text>
      </g>

      {/* Wi-Fi arcs */}
      <g className="stroke-blue-500" fill="none" strokeWidth="2.6" strokeLinecap="round">
        <path d="M330 150c16-14 40-14 56 0" />
        <path d="M340 166c12-10 30-10 42 0" />
        <path d="M352 182c5-4 13-4 18 0" />
        <circle className="fill-blue-500 stroke-none" cx="361" cy="196" r="3.4" />
      </g>
      <text className={MUTED} fontSize="10" x="322" y="220">Home Wi-Fi</text>

      {/* HomecoreOS cloud */}
      <g>
        <path className={`${SURFACE} ${STROKE}`} d="M366 74a20 20 0 0 0-38-6 16 16 0 0 0 4 32h34a14 14 0 0 0 0-26Z" strokeWidth="2" />
        <text className={INK} fontSize="11" x="360" y="128">HomecoreOS</text>
        <rect className="fill-blue-600" height="6" rx="3" width="70" x="356" y="138" />
      </g>

      {/* Flow legend */}
      <g>
        <rect className={`${SURFACE_ALT} ${STROKE}`} height="30" rx="15" width="120" x="18" y="284" strokeWidth="1.5" opacity="0" />
      </g>
    </ArtFrame>
  );
}

/** Step 3 — dashboard with rooms and a working automation. */
export function ControlAutomateArt() {
  return (
    <ArtFrame label="A dashboard of room cards, live sensor readings and a motion-to-light automation">
      <rect className="fill-blue-50 dark:fill-slate-900" height="320" rx="18" width="480" />

      {/* Dashboard window */}
      <g>
        <rect className={SURFACE} height="150" rx="14" width="288" x="18" y="24" />
        <rect className="fill-slate-100 dark:fill-slate-800" height="150" rx="14" width="46" x="18" y="24" />
        <circle className="fill-blue-600" cx="41" cy="44" r="7" />
        <g className="fill-slate-300 dark:fill-slate-600">
          <rect height="7" rx="3.5" width="22" x="30" y="66" />
          <rect height="7" rx="3.5" width="22" x="30" y="82" />
          <rect height="7" rx="3.5" width="22" x="30" y="98" />
        </g>

        {/* Room cards */}
        {[
          { x: 76, y: 38, label: "Living Room", on: true, tone: "amber" },
          { x: 192, y: 38, label: "Hallway", on: true, tone: "amber" },
          { x: 76, y: 106, label: "Bedroom", on: false, tone: "slate" },
          { x: 192, y: 106, label: "Kitchen", on: false, tone: "slate" },
        ].map((card) => (
          <g key={card.label}>
            <rect className="fill-slate-50 dark:fill-slate-800" height="54" rx="10" width="104" x={card.x} y={card.y} />
            <circle
              className={card.on ? "fill-amber-400" : "fill-slate-300 dark:fill-slate-600"}
              cx={card.x + 20}
              cy={card.y + 22}
              r="8"
            />
            <text className={MUTED} fontSize="9" x={card.x + 34} y={card.y + 25}>
              {card.label}
            </text>
            <rect
              className={card.on ? "fill-amber-300" : "fill-slate-200 dark:fill-slate-700"}
              height="6"
              rx="3"
              width="70"
              x={card.x + 12}
              y={card.y + 38}
            />
          </g>
        ))}
      </g>

      {/* Sensor reading + status chips */}
      <g>
        <rect className={`${SURFACE} ${STROKE}`} height="66" rx="12" width="140" x="322" y="24" strokeWidth="2" />
        <text className={MUTED} fontSize="9" x="336" y="46">Hallway sensor</text>
        <text className={INK} fontSize="20" x="336" y="72">22.4 °C</text>
        <circle className="fill-emerald-400" cx="446" cy="42" r="4" />
      </g>
      <g>
        <rect className={`${SURFACE} ${STROKE}`} height="66" rx="12" width="140" x="322" y="100" strokeWidth="2" />
        <text className={MUTED} fontSize="9" x="336" y="122">Node health</text>
        {[0, 1, 2].map((i) => (
          <circle key={i} className="fill-emerald-400" cx={342 + i * 18} cy="142" r="5" />
        ))}
        <text className={MUTED} fontSize="9" x="400" y="146">1 Node</text>
      </g>

      {/* Automation flow */}
      <g>
        <rect className={`${SURFACE} ${STROKE}`} height="96" rx="14" width="444" x="18" y="196" strokeWidth="2" />
        <text className={MUTED} fontSize="10" x="32" y="216">AUTOMATION</text>

        <rect className="fill-sky-50 dark:fill-sky-950/60" height="40" rx="10" width="112" x="32" y="228" />
        <circle className="fill-sky-400" cx="50" cy="248" r="6" />
        <text className={INK} fontSize="10" x="62" y="245">Motion</text>
        <text className={MUTED} fontSize="9" x="62" y="258">Hallway</text>

        <rect className="fill-indigo-50 dark:fill-indigo-950/60" height="40" rx="10" width="112" x="184" y="228" />
        <text className={INK} fontSize="10" x="202" y="245">After sunset</text>
        <text className={MUTED} fontSize="9" x="202" y="258">Condition</text>

        <rect className="fill-amber-50 dark:fill-amber-950/50" height="40" rx="10" width="122" x="336" y="228" />
        <circle className="fill-amber-400" cx="354" cy="248" r="6" />
        <text className={INK} fontSize="10" x="366" y="245">Light on</text>
        <text className={MUTED} fontSize="9" x="366" y="258">Hallway</text>

        <g className="stroke-slate-400 dark:stroke-slate-500" fill="none" strokeWidth="2" strokeLinecap="round">
          <path d="M144 248h28" />
          <path d="M296 248h28" />
        </g>
        <path className="fill-slate-400 dark:fill-slate-500" d="M170 244l6 4-6 4ZM322 244l6 4-6 4Z" />
      </g>
    </ArtFrame>
  );
}

/** Step 4 — a growing, monitored home. */
export function MonitorExpandArt() {
  return (
    <ArtFrame label="Three healthy nodes, an activity feed and room for more boards as the home grows">
      <rect className="fill-slate-50 dark:fill-slate-900" height="320" rx="18" width="480" />

      {/* House with three node badges */}
      <g>
        <path className={`${SURFACE} ${STROKE}`} d="M30 132 132 62l102 70v148H30Z" strokeWidth="2.5" />
        <path className="fill-slate-100 dark:fill-slate-800 stroke-slate-300 dark:stroke-slate-700" d="M30 132 132 62l102 70Z" strokeWidth="2.5" />
        <path className={STROKE} d="M84 210v-56h44v56M132 132v148" strokeWidth="2" />

        {[
          { x: 62, y: 176, label: "Living" },
          { x: 150, y: 176, label: "Bedroom" },
          { x: 106, y: 246, label: "Hall" },
        ].map((n) => (
          <g key={n.label}>
            <rect className="fill-blue-600" height="26" rx="7" width="34" x={n.x} y={n.y} />
            <circle className="fill-emerald-300" cx={n.x + 8} cy={n.y + 8} r="3" />
            <text className="fill-white" fontSize="8" x={n.x + 6} y={n.y + 22}>NODE</text>
            <text className={MUTED} fontSize="9" x={n.x} y={n.y + 42}>{n.label}</text>
          </g>
        ))}
      </g>

      {/* Activity feed */}
      <g>
        <rect className={`${SURFACE} ${STROKE}`} height="164" rx="14" width="196" x="258" y="52" strokeWidth="2" />
        <text className={MUTED} fontSize="10" x="274" y="74">ACTIVITY</text>
        {[
          { y: 94, tone: "fill-emerald-400", text: "Hallway motion detected" },
          { y: 122, tone: "fill-amber-400", text: "Porch light turned on" },
          { y: 150, tone: "fill-blue-500", text: "Node firmware up to date" },
          { y: 178, tone: "fill-slate-300 dark:fill-slate-600", text: "Bedroom sensor online" },
        ].map((row) => (
          <g key={row.text}>
            <circle className={row.tone} cx="276" cy={row.y} r="4" />
            <rect className="fill-slate-200 dark:fill-slate-700" height="7" rx="3.5" width={row.text.length * 4} x="290" y={row.y - 4} />
          </g>
        ))}
      </g>

      {/* Expand card */}
      <g>
        <rect className="fill-blue-600" height="84" rx="14" width="196" x="258" y="232" />
        <text className="fill-white" fontSize="12" x="274" y="262">Add another Node</text>
        <text className="fill-blue-100" fontSize="10" x="274" y="282">Boards, sensors, rooms</text>
        <circle className="fill-white/20" cx="428" cy="252" r="18" />
        <path className="stroke-white" d="M428 244v16M420 252h16" strokeWidth="2.4" strokeLinecap="round" />
      </g>
    </ArtFrame>
  );
}
