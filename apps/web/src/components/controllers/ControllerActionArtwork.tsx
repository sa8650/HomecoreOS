/**
 * Compact, self-contained illustrations for the controller action cards.
 *
 * The larger flow screens keep their own detailed artwork (`BleDiscoveryArtwork`,
 * `WifiPortalArtwork`, `UsbFlashIllustration`); these are the small tiles that
 * identify each action in the picker, drawn in the same palette so the modal
 * reads as one hardware-setup surface.
 */

export type ControllerActionArtworkKind = "usb" | "bluetooth" | "wifi" | "recovery";

const PALETTE: Record<
  ControllerActionArtworkKind,
  { from: string; via: string; to: string; stroke: string; accent: string }
> = {
  usb: {
    from: "#0f172a",
    via: "#111f33",
    to: "#0e3b47",
    stroke: "#67e8f9",
    accent: "#34d399",
  },
  bluetooth: {
    from: "#2563eb",
    via: "#3b76f6",
    to: "#1d4ed8",
    stroke: "#bcd7ff",
    accent: "#ffffff",
  },
  wifi: {
    from: "#4338ca",
    via: "#4f46e5",
    to: "#6d28d9",
    stroke: "#ddd6fe",
    accent: "#ffffff",
  },
  recovery: {
    from: "#065f46",
    via: "#047857",
    to: "#0f766e",
    stroke: "#a7f3d0",
    accent: "#ffffff",
  },
};

/** The controller board shape shared by the tiles. */
function BoardShape({ stroke, accent }: { stroke: string; accent: string }) {
  return (
    <>
      <rect
        x="30"
        y="20"
        width="44"
        height="48"
        rx="7"
        fill="rgba(255,255,255,0.10)"
        stroke={stroke}
        strokeWidth="2"
      />
      <rect
        x="39"
        y="30"
        width="26"
        height="20"
        rx="3"
        fill="rgba(0,0,0,0.28)"
        stroke={stroke}
        strokeWidth="1.6"
      />
      <circle cx="52" cy="58" r="3" fill={accent} />
      <path
        d="M36 24v-5m10 5v-5m10 5v-5m10 5v-5"
        stroke={stroke}
        strokeOpacity="0.6"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </>
  );
}

export function ControllerActionArtwork({
  kind,
  className = "",
  animated = false,
}: {
  kind: ControllerActionArtworkKind;
  className?: string;
  animated?: boolean;
}) {
  const palette = PALETTE[kind];
  return (
    <div
      aria-hidden="true"
      className={`relative overflow-hidden rounded-xl bg-gradient-to-br shadow-inner ${className}`}
      style={{
        backgroundImage: `linear-gradient(135deg, ${palette.from} 0%, ${palette.via} 55%, ${palette.to} 100%)`,
      }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-6 -top-6 size-16 rounded-full bg-white/10 blur-xl"
      />
      <svg viewBox="0 0 104 88" className="relative size-full" fill="none">
        {kind === "usb" && (
          <>
            <BoardShape stroke={palette.stroke} accent={palette.accent} />
            <path
              d="M74 44h8c8 0 6-10 12-10"
              stroke={palette.stroke}
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeDasharray="4 4"
              className={animated ? "animate-pulse" : undefined}
            />
            <rect
              x="86"
              y="18"
              width="9"
              height="16"
              rx="2"
              fill="rgba(255,255,255,0.14)"
              stroke={palette.stroke}
              strokeWidth="2"
            />
          </>
        )}

        {kind === "bluetooth" && (
          <>
            <BoardShape stroke={palette.stroke} accent={palette.accent} />
            <path
              d="M85.6 35.6 93.6 43.6 89.6 47.6V31.6l4 4-8 8"
              stroke={palette.stroke}
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            <path
              d="M18 35a22 22 0 0 1 0-14M12 31a13 13 0 0 1 0-6"
              stroke={palette.accent}
              strokeOpacity="0.7"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
          </>
        )}

        {kind === "wifi" && (
          <>
            <BoardShape stroke={palette.stroke} accent={palette.accent} />
            {/* router body with broadcast arcs above it */}
            <rect
              x="79"
              y="56"
              width="22"
              height="12"
              rx="3.5"
              fill="rgba(255,255,255,0.16)"
              stroke={palette.stroke}
              strokeWidth="2"
            />
            <circle cx="86" cy="62" r="1.9" fill={palette.accent} />
            <circle cx="93" cy="62" r="1.9" fill={palette.accent} opacity="0.55" />
            <path
              d="M81 50a14 14 0 0 1 18 0M85.5 42.5a7 7 0 0 1 9 0"
              stroke={palette.stroke}
              strokeWidth="2.2"
              strokeLinecap="round"
              fill="none"
            />
          </>
        )}

        {kind === "recovery" && (
          <>
            <BoardShape stroke={palette.stroke} accent={palette.accent} />
            <path
              d="M86 26l9 4v10c0 8-5.5 12.5-9 14-3.5-1.5-9-6-9-14V30z"
              fill="rgba(255,255,255,0.16)"
              stroke={palette.stroke}
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <path
              d="M82.5 40.5l2.6 2.6 5.4-5.4"
              stroke={palette.accent}
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}
      </svg>
    </div>
  );
}
