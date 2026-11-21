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

/**
 * Flat two-tone thumbnails for the Board Actions list: a tinted tile with a
 * single ink-coloured line drawing, matching the prototype. The gradient tiles
 * remain for the larger BLE / Wi-Fi chooser cards.
 */
const LIGHT_PALETTE: Record<
  ControllerActionArtworkKind,
  { bg: string; border: string; ink: string; accent: string }
> = {
  usb: { bg: "#f0fdf4", border: "rgba(22,163,74,0.22)", ink: "#16a34a", accent: "#d97706" },
  bluetooth: { bg: "#eff6ff", border: "rgba(37,99,235,0.22)", ink: "#2563eb", accent: "#16a34a" },
  wifi: { bg: "#eff6ff", border: "rgba(37,99,235,0.22)", ink: "#2563eb", accent: "#16a34a" },
  recovery: { bg: "#fffbeb", border: "rgba(217,119,6,0.25)", ink: "#b45309", accent: "#16a34a" },
};

export function ControllerActionArtwork({
  kind,
  className = "",
  animated = false,
  tone = "gradient",
}: {
  kind: ControllerActionArtworkKind;
  className?: string;
  animated?: boolean;
  /** `light` draws the flat tinted thumbnail used by the Board Actions list. */
  tone?: "gradient" | "light";
}) {
  if (tone === "light") {
    const light = LIGHT_PALETTE[kind];
    return (
      <div
        aria-hidden="true"
        className={`relative overflow-hidden rounded-xl border ${className}`}
        style={{ backgroundColor: light.bg, borderColor: light.border }}
      >
        <svg viewBox="0 0 32 32" className="size-full p-1.5" fill="none">
          {kind === "usb" && (
            <>
              <rect
                x="14"
                y="8"
                width="15"
                height="16"
                rx="3"
                fill={light.ink}
                fillOpacity="0.12"
              />
              <rect x="18" y="12" width="7" height="8" rx="1.5" fill={light.ink} />
              <path
                d="M4 16h6M10 13v6M14 12h-1M14 20h-1"
                stroke={light.ink}
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </>
          )}
          {kind === "bluetooth" && (
            <>
              <rect
                x="5"
                y="12"
                width="22"
                height="14"
                rx="3"
                fill={light.ink}
                fillOpacity="0.12"
              />
              <circle cx="16" cy="20" r="2.2" fill={light.ink} />
              <path
                d="M10 9a8.5 8.5 0 0 1 12 0M13 5.5a4.5 4.5 0 0 1 6 0"
                stroke={light.ink}
                strokeWidth="2"
                strokeLinecap="round"
              />
            </>
          )}
          {kind === "wifi" && (
            <>
              <rect
                x="5"
                y="12"
                width="22"
                height="14"
                rx="3"
                fill={light.ink}
                fillOpacity="0.12"
              />
              <circle cx="16" cy="20" r="2.2" fill={light.ink} />
              <path
                d="M10 9a8.5 8.5 0 0 1 12 0M13 5.5a4.5 4.5 0 0 1 6 0"
                stroke={light.ink}
                strokeWidth="2"
                strokeLinecap="round"
              />
            </>
          )}
          {kind === "recovery" && (
            <>
              <rect
                x="6"
                y="13"
                width="20"
                height="13"
                rx="3"
                fill={light.ink}
                fillOpacity="0.12"
                stroke={light.ink}
                strokeWidth="1.6"
              />
              <path
                d="M10 8a8 8 0 0 1 11 0"
                stroke={light.ink}
                strokeWidth="2"
                strokeLinecap="round"
              />
              <path
                d="M22 4.5v3.5h-3.5"
                stroke={light.ink}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="16" cy="19.5" r="2.2" fill={light.accent} />
            </>
          )}
        </svg>
      </div>
    );
  }

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
