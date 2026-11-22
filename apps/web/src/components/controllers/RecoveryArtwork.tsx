import { RiBluetoothConnectLine } from "@remixicon/react";
import { BluetoothPairingAnimation } from "@/components/graphics/ConnectionAnimations";

export function BleDiscoveryArtwork({
  mode,
  connected,
}: {
  mode: "setup" | "recover";
  connected?: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-[12px] border border-blue-600/20 bg-blue-50/60 px-5 py-6 text-center dark:border-blue-400/25 dark:bg-blue-950/30">
      <div className="flex justify-center">
        <BluetoothPairingAnimation className="size-24" />
      </div>

      <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-blue-600/25 bg-white px-2.5 py-1 text-[11.5px] font-medium text-blue-700 dark:border-blue-400/30 dark:bg-blue-950/60 dark:text-blue-200">
        <RiBluetoothConnectLine className="size-3.5" aria-hidden="true" />
        {connected
          ? "Connected over Bluetooth"
          : mode === "recover"
            ? "Bluetooth Board Recovery"
            : "Bluetooth Board Setup"}
      </span>

      <h3 className="mt-2.5 text-[15px] font-semibold tracking-[-0.01em] text-foreground">
        {mode === "recover"
          ? "Prepare Board for Recovery"
          : "Discover HomecoreOS Board"}
      </h3>
      <p className="mx-auto mt-1 max-w-[320px] text-[12.5px] leading-relaxed text-muted-foreground">
        {mode === "recover"
          ? "Hold the BOOT / Recovery button on your board for 3 seconds."
          : "Turn on your HomecoreOS Board and keep it nearby."}
      </p>
    </div>
  );
}

/**
 * Four-step Wi-Fi portal instruction artwork (matches the printed quick-start):
 * power the controller -> join HomecoreOS-Setup-XXXX -> open http://192.168.4.1
 * -> enter SSID / password / pairing code and press Save & Apply.
 * Inline SVG only; fixed light palette like the BleDiscoveryArtwork.
 */
export function WifiPortalArtwork({ recovery = false }: { recovery?: boolean }) {
  const badge = "#1e63e0";
  const ink = "#141a24";
  const softStroke = "#dfe3e8";
  const deviceStroke = "#8b939e";
  return (
    <div className="flex justify-center rounded-[12px] border border-border bg-muted/30 p-3">
      {/* ~35% of the previous full-width artwork: the four beats still read at
          this size, and the dialog stays short enough to scroll on a laptop.
          The animated Wi-Fi glyph lives on the "Setup with Wi-Fi" option row. */}
      <svg
        viewBox="0 0 1230 392"
        className="h-auto w-full max-w-[300px] select-none"
        role="img"
        aria-label={recovery
          ? "Recovery steps: Power the board, enter recovery mode, join HomecoreOS-Setup-XXXX, then connect to identify the board and repair its Wi-Fi connection. Local portal: http://192.168.4.1."
          : "Four steps: 1. Plug the board into power. 2. Join its HomecoreOS-Setup-XXXX Wi-Fi network from your phone or computer. 3. Open http://192.168.4.1 in your browser. 4. Enter the Wi-Fi SSID, password, website URL and pairing code, then press Save and Restart."}
      >
        {/* panel */}
        <rect x="6" y="6" width="1218" height="380" rx="18" fill="#fcfcfa" stroke="#e3e6ea" strokeWidth="2" />

        {/* step circles */}
        {[214, 488, 762, 1016].map((cx) => (
          <circle key={cx} cx={cx} cy="200" r="116" fill="#ffffff" stroke={softStroke} strokeWidth="2" />
        ))}

        {/* dotted connectors with chevrons */}
        {[[330, 382], [604, 656], [878, 930]].map(([x1, x2]) => (
          <g key={x1} stroke="#7a8089" strokeWidth="4" strokeLinecap="round" fill="none">
            <line x1={x1} y1="200" x2={x2 - 14} y2="200" strokeDasharray="0.1 11" />
            <polyline points={`${x2 - 8},190 ${x2 + 2},200 ${x2 - 8},210`} strokeLinejoin="round" />
          </g>
        ))}

        {/* step badges */}
        {[214 - 88, 488 - 88, 762 - 88, 1016 - 88].map((cx, i) => (
          <g key={i}>
            <circle cx={cx} cy="74" r="20" fill={badge} />
            <text x={cx} y="81.5" textAnchor="middle" fill="#ffffff" fontSize="21" fontWeight="800" fontFamily="ui-sans-serif, system-ui, sans-serif">
              {i + 1}
            </text>
          </g>
        ))}

        {/* ---------- step 1: outlet + plug + up arrow ---------- */}
        <g>
          {/* outlet plate */}
          <rect x="186" y="104" width="56" height="96" rx="8" fill="#f4f5f7" stroke="#d3d7de" strokeWidth="2" />
          {/* duplex sockets */}
          <rect x="196" y="113" width="36" height="32" rx="6" fill="#ffffff" stroke="#d0d5dc" strokeWidth="1.5" />
          <rect x="196" y="155" width="36" height="32" rx="6" fill="#ffffff" stroke="#d0d5dc" strokeWidth="1.5" />
          {/* top socket slots + ground */}
          <rect x="204" y="120" width="3.6" height="10" rx="1.8" fill="#41464f" />
          <rect x="221" y="120" width="3.6" height="10" rx="1.8" fill="#41464f" />
          <circle cx="214.3" cy="139.5" r="2.6" fill="#41464f" />
          {/* bottom socket slots + ground */}
          <rect x="204" y="162" width="3.6" height="10" rx="1.8" fill="#41464f" />
          <rect x="221" y="162" width="3.6" height="10" rx="1.8" fill="#41464f" />
          <circle cx="214.3" cy="181.5" r="2.6" fill="#41464f" />
          {/* plug prongs + body */}
          <rect x="193" y="212" width="6" height="26" rx="3" fill="#e6e8ec" stroke="#c6cbd3" strokeWidth="1.5" />
          <rect x="209" y="212" width="6" height="26" rx="3" fill="#e6e8ec" stroke="#c6cbd3" strokeWidth="1.5" />
          <rect x="184" y="238" width="44" height="24" rx="5" fill="#ffffff" stroke="#c9ced6" strokeWidth="2" />
          {/* cord */}
          <path d="M206 262 C206 282 220 290 214 312" fill="none" stroke="#c9ced6" strokeWidth="5" strokeLinecap="round" />
          {/* blue up arrow */}
          <path d="M267 176 L250 208 L259.5 208 L259.5 240 L274.5 240 L274.5 208 L284 208 Z" fill={badge} />
        </g>

        {/* ---------- step 2: phone + laptop on Wi-Fi ---------- */}
        <g>
          {/* laptop */}
          <rect x="476" y="128" width="88" height="76" rx="7" fill="#ffffff" stroke="#565e68" strokeWidth="2.5" />
          <rect x="483" y="135" width="74" height="57" rx="2" fill="#e8ecf1" />
          <rect x="466" y="207" width="108" height="7" rx="3.5" fill="#aeb4bd" />
          {/* laptop wifi arcs */}
          <g fill="none" stroke={badge} strokeWidth="3" strokeLinecap="round">
            <path d="M513 171.5 A9 9 0 0 1 527 171.5" />
            <path d="M508.5 166 A14.5 14.5 0 0 1 531.5 166" />
            <path d="M504 160.5 A20 20 0 0 1 536 160.5" />
          </g>
          <circle cx="520" cy="178" r="2.7" fill={badge} />
          {/* phone (in front) */}
          <rect x="424" y="126" width="42" height="90" rx="9" fill="#ffffff" stroke={deviceStroke} strokeWidth="2.5" />
          <rect x="438" y="130" width="14" height="2.4" rx="1.2" fill={deviceStroke} />
          <rect x="429" y="136" width="32" height="66" rx="3" fill="#e8ecf1" />
          {/* phone wifi arcs */}
          <g fill="none" stroke={badge} strokeWidth="3" strokeLinecap="round">
            <path d="M438.5 186.5 A8.5 8.5 0 0 1 451.5 186.5" />
            <path d="M434 181.5 A14 14 0 0 1 456 181.5" />
            <path d="M429.5 176.5 A19.5 19.5 0 0 1 460.5 176.5" />
          </g>
          <circle cx="445" cy="192.5" r="2.5" fill={badge} />
        </g>

        {/* ---------- step 3: browser at http://192.168.4.1 ---------- */}
        <g>
          <rect x="672" y="126" width="180" height="120" rx="10" fill="#ffffff" stroke={deviceStroke} strokeWidth="2" />
          {/* chrome bar */}
          <path d="M672 136 a10 10 0 0 1 10 -10 h160 a10 10 0 0 1 10 10 v14 H672 Z" fill="#e9edf1" />
          <line x1="672" y1="150" x2="852" y2="150" stroke="#d5dae0" strokeWidth="1.5" />
          <circle cx="683" cy="138.5" r="3.2" fill="#c3c9d1" />
          <circle cx="693" cy="138.5" r="3.2" fill="#c3c9d1" />
          <circle cx="703" cy="138.5" r="3.2" fill="#c3c9d1" />
          {/* address bar */}
          <rect x="682" y="162" width="160" height="28" rx="6" fill="#f1f4f8" stroke="#e1e6ec" strokeWidth="1.5" />
          <text x="762" y="181" textAnchor="middle" fill={badge} fontSize="14.5" fontWeight="650" fontFamily="ui-sans-serif, system-ui, sans-serif">
            http://192.168.4.1
          </text>
          {/* cursor pointer */}
          <path d="M796 196 L796 226 L803.5 219 L808.5 229 L813.5 227 L808.5 217 L817 217 Z" fill="#111111" stroke="#ffffff" strokeWidth="1.5" strokeLinejoin="round" />
        </g>

        {/* ---------- step 4: portal form + Save and Restart ---------- */}
        <g fontFamily="ui-sans-serif, system-ui, sans-serif">
          {/* labels — the local page asks for exactly these four things */}
          <text x="954" y="112" fill={ink} fontSize="12.5" fontWeight="650">Wi-Fi SSID</text>
          <text x="954" y="180" fill={ink} fontSize="12.5" fontWeight="650">Password</text>
          <text x="954" y="248" fill={ink} fontSize="12.5" fontWeight="650">
            {recovery ? "Recovery Code" : "Pairing Code"}
          </text>
          {/* SSID field */}
          <rect x="954" y="118" width="152" height="23" rx="5" fill="#ffffff" stroke="#c9ced6" strokeWidth="1.5" />
          <text x="963" y="134" fill="#1f2937" fontSize="12.5">Home_Network</text>
          <g fill="none" stroke="#5b636e" strokeWidth="1.6" strokeLinecap="round">
            <path d="M1084 133.5 A5.2 5.2 0 0 1 1092.4 133.5" />
            <path d="M1081.6 129.8 A8.6 8.6 0 0 1 1094.8 129.8" />
          </g>
          <circle cx="1088.2" cy="136.6" r="1.4" fill="#5b636e" />
          {/* Password field */}
          <rect x="954" y="186" width="152" height="23" rx="5" fill="#ffffff" stroke="#c9ced6" strokeWidth="1.5" />
          <text x="963" y="202" fill="#111111" fontSize="13.5" letterSpacing="3.5">•••••••</text>
          <rect x="1083" y="194" width="13" height="10" rx="2" fill="none" stroke="#5b636e" strokeWidth="1.6" />
          <path d="M1085.8 194 v-2.4 a3.7 3.7 0 0 1 7.4 0 V194" fill="none" stroke="#5b636e" strokeWidth="1.6" />
          {/* code field */}
          <rect x="954" y="254" width="152" height="23" rx="5" fill="#ffffff" stroke="#c9ced6" strokeWidth="1.5" />
          <text x="963" y="270" fill="#1f2937" fontSize="12.5" fontFamily="ui-monospace, monospace">
            {recovery ? "482913" : "123456"}
          </text>
          {/* Save and Restart button */}
          <rect x="962" y="284" width="156" height="26" rx="6" fill={badge} />
          <text x="1040" y="301" textAnchor="middle" fill="#ffffff" fontSize="12" fontWeight="700">
            Save and Restart
          </text>
        </g>
      </svg>
    </div>
  );
}

