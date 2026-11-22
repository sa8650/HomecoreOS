import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * The three connection illustrations used across the board modal.
 *
 * Each one is a self-contained, looping SVG (SMIL `animate` / `animateTransform`,
 * no JS timers) taken from the supplied design exports:
 *
 * - {@link BluetoothPairingAnimation} — expanding Bluetooth rings and a rune,
 *   2.0 s loop.
 * - {@link WifiSignalAnimation} — the Wi-Fi glyph arcs swinging open with a
 *   pulsing dot, 2.0 s loop.
 * - {@link UsbCableAnimation} — a USB-C connector travelling into a port and the
 *   chip flashing while firmware streams, 2.04 s loop.
 *
 * Each root carries `.hc-connection-anim`, which drops the SMIL nodes under
 * `prefers-reduced-motion: reduce` — the static geometry underneath stays, so
 * reduced-motion users still see the artwork, just held still.
 */

/** Gradient/filter ids must be unique per instance: these can appear twice. */
function useInstanceId(kind: string) {
  return `${kind}-${useId().replace(/[:]/g, "")}`;
}

/* -------------------------------------------------------------------------- */
/* Bluetooth rune glyph (geometry shared by the icon and the animation)        */
/* -------------------------------------------------------------------------- */

/**
 * The canonical Bluetooth rune on a 24×24 grid: a vertical stem (x=12) with two
 * mirrored arms that meet at (17,7) and (17,17) and cross to the opposite
 * corners. Shared by the button glyph, the pairing animation and the action
 * card so the mark never drifts between them.
 */
export const BLUETOOTH_RUNE_PATH = "m7 7 10 10-5 5V2l5 5-10 10";

export function BluetoothGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("shrink-0", className)}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={BLUETOOTH_RUNE_PATH}
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Bluetooth: concentric pairing rings behind a Bluetooth rune                 */
/* -------------------------------------------------------------------------- */

export function BluetoothPairingAnimation({ className }: { className?: string }) {
  const uid = useInstanceId("hc-ble");
  return (
    <svg
      viewBox="0 0 240 240"
      className={cn("hc-connection-anim select-none", className)}
      fill="none"
      role="img"
      aria-label="Bluetooth pairing signal"
      data-testid="bt-pairing-animation"
    >
      <defs>
        <filter id={`${uid}-glow`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      {/* A ring that grows out of the disc and fades, three times per loop.
          Stops at 88 so it stays inside the 240 artboard: a tight pulse rather
          than a full-card ripple. */}
      {[0, 1, 2].map((i) => (
        <circle
          key={i}
          cx="120"
          cy="120"
          r="40"
          stroke="#4586ff"
          strokeOpacity="0.45"
          strokeWidth="2"
        >
          <animate
            attributeName="r"
            values="40;88"
            dur="2s"
            begin={`${i * 0.666}s`}
            repeatCount="indefinite"
          />
          <animate
            attributeName="stroke-opacity"
            values="0.5;0"
            dur="2s"
            begin={`${i * 0.666}s`}
            repeatCount="indefinite"
          />
        </circle>
      ))}

      {/* Steady halo */}
      <circle cx="120" cy="120" r="60" fill="#eef4ff" />
      <circle cx="120" cy="120" r="60" stroke="#c7dbff" strokeWidth="2" />

      {/* Soft glow behind the rune */}
      <circle
        cx="120"
        cy="120"
        r="30"
        fill="#4586ff"
        opacity="0.28"
        filter={`url(#${uid}-glow)`}
      />

      {/* Rune disc: the shared 24-grid geometry, scaled ×2 and centred. */}
      <circle cx="120" cy="120" r="34" fill="#2176ff" />
      <g transform="translate(96 96) scale(2)">
        <path
          d={BLUETOOTH_RUNE_PATH}
          stroke="#ffffff"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <animate
            attributeName="opacity"
            values="1;1;0.55;1"
            keyTimes="0;0.5;0.75;1"
            dur="2s"
            repeatCount="indefinite"
          />
        </path>
      </g>
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Wi-Fi: the three arcs swing open and settle                                 */
/* -------------------------------------------------------------------------- */

export function WifiSignalAnimation({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 177 177"
      className={cn("hc-connection-anim select-none", className)}
      fill="none"
      role="img"
      aria-label="Wi-Fi signal"
      data-testid="wifi-signal-animation"
    >
      {/* Pulsing dot */}
      <g transform="translate(88.597,109.383)">
        <g>
          <animateTransform
            attributeName="transform"
            type="scale"
            values="1 1;1 1;0.9 0.9;1 1;0.9 0.9;1 1;1 1"
            keyTimes="0;0.083;0.283;0.483;0.683;0.883;1"
            dur="2s"
            repeatCount="indefinite"
          />
          <circle cx="0" cy="0" r="8.089" fill="#2176ff" />
        </g>
      </g>

      {/* Arcs: each rotates in, opens up, then stops for the rest of the loop. */}
      {[
        {
          translate: "translate(40.762,54.552)",
          inner: "translate(-0.002,-20.016)",
          d: "M-16.732,3.503C-12.465,-0.822,-6.534,-3.503,0.021,-3.503C6.556,-3.503,12.468,-0.84,16.732,3.46",
          values: "0;0;-8;1080;1080",
          keyTimes: "0;0.075;0.108;0.875;1",
        },
        {
          translate: "translate(40.778,54.557)",
          inner: "translate(-0.148,-30.157)",
          d: "M-24.739,5.135C-18.357,-1.211,-9.561,-5.135,0.151,-5.135C9.711,-5.135,18.383,-1.333,24.739,4.839",
          values: "0;0;-9;720;720",
          keyTimes: "0;0.067;0.1;0.867;1",
        },
        {
          translate: "translate(40.768,54.561)",
          inner: "translate(0.013,-40.169)",
          d: "M-33.281,6.893C-24.763,-1.624,-12.997,-6.893,0,-6.893C12.997,-6.893,24.764,-1.624,33.281,6.893",
          values: "0;0;-12;360;360",
          keyTimes: "0;0.058;0.092;0.858;1",
        },
      ].map((arc, index) => (
        <g key={index} transform="translate(47.816,54.818)">
          <g transform={arc.translate}>
            <g>
              <animateTransform
                attributeName="transform"
                type="rotate"
                values={arc.values}
                keyTimes={arc.keyTimes}
                dur="2s"
                repeatCount="indefinite"
              />
              <path
                transform={arc.inner}
                d={arc.d}
                stroke="#90baff"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          </g>
        </g>
      ))}
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* USB: the cable plugs in, the chip lights up                                 */
/* -------------------------------------------------------------------------- */

/**
 * The supplied export is a 300 × 400 artboard of a USB-C plug meeting a port,
 * with the port's status LED cycling blue → white while a cable-run mask sweeps.
 * It is redrawn here at the same proportions with a handful of paths so it stays
 * crisp at 48–120 px and can be tinted from the surrounding card.
 */
export function UsbCableAnimation({
  className,
  active = true,
}: {
  className?: string;
  /** When false the plug is parked outside the port and nothing pulses. */
  active?: boolean;
}) {
  const uid = useInstanceId("hc-usb");
  return (
    <svg
      viewBox="0 0 120 160"
      className={cn("hc-connection-anim select-none", className)}
      fill="none"
      role="img"
      aria-label={active ? "USB cable connected" : "USB cable"}
      data-testid="usb-cable-animation"
    >
      <defs>
        <linearGradient id={`${uid}-body`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#e9edf5" />
        </linearGradient>
        <clipPath id={`${uid}-slot`}>
          <rect x="38" y="104" width="44" height="14" rx="4" />
        </clipPath>
      </defs>

      {/* Cable */}
      <path
        d="M60 8v58"
        stroke="#94a3b8"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <path d="M60 8v58" stroke="#cbd5e1" strokeWidth="2.5" strokeLinecap="round" />

      {/* Plug body: slides down into the port and back out */}
      <g>
        {active && (
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 -6; 0 10; 0 10; 0 -6; 0 -6"
            keyTimes="0; 0.28; 0.72; 0.94; 1"
            dur="2.04s"
            repeatCount="indefinite"
          />
        )}
        <rect
          x="40"
          y="58"
          width="40"
          height="48"
          rx="9"
          fill={`url(#${uid}-body)`}
          stroke="#94a3b8"
          strokeWidth="2"
        />
        <rect x="46" y="66" width="28" height="7" rx="3.5" fill="#cbd5e1" />
        <rect
          x="48"
          y="98"
          width="24"
          height="10"
          rx="4"
          fill="#cbd5e1"
          stroke="#94a3b8"
          strokeWidth="1.6"
        />
      </g>

      {/* Port / board */}
      <rect
        x="14"
        y="118"
        width="92"
        height="34"
        rx="8"
        fill="#f1f5f9"
        stroke="#94a3b8"
        strokeWidth="2"
      />
      <rect x="38" y="104" width="44" height="14" rx="4" fill="#0f172a" />
      <g clipPath={`url(#${uid}-slot)`}>
        <rect x="38" y="104" width="44" height="14" fill="#0f172a" />
        <rect x="38" y="104" width="44" height="14" fill="#38bdf8" opacity="0">
          {active && (
            <animate
              attributeName="opacity"
              values="0;0;0.85;0;0"
              keyTimes="0;0.3;0.45;0.6;1"
              dur="2.04s"
              repeatCount="indefinite"
            />
          )}
        </rect>
      </g>

      {/* Status LED on the board */}
      <circle cx="88" cy="135" r="4" fill="#16a34a">
        {active && (
          <animate
            attributeName="fill"
            values="#16a34a;#16a34a;#38bdf8;#ffffff;#38bdf8;#ffffff;#38bdf8;#16a34a"
            keyTimes="0;0.62;0.66;0.7;0.76;0.82;0.9;1"
            dur="2.04s"
            repeatCount="indefinite"
          />
        )}
      </circle>
      <rect x="24" y="130" width="34" height="4" rx="2" fill="#cbd5e1" />
      <rect x="24" y="139" width="22" height="4" rx="2" fill="#dbe2ea" />
    </svg>
  );
}
