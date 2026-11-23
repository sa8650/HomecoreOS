import { useId } from "react";
import { cn } from "cn";

/**
 * The pairwise-connection illustrations used across the board modal.
 *
 * Each one is a self-contained, looping SVG (SMIL `animate` / `animateTransform`,
 * no JS timers) taken from the supplied design exports:
 *
 * - {@link BluetoothPairingAnimation} — expanding Bluetooth rings and a rune,
 *   2.0 s loop.
 * - {@link WifiSignalAnimation} — the Wi-Fi glyph arcs swinging open with a
 *   pulsing dot, 2.0 s loop.
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
