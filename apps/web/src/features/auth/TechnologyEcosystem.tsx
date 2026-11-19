/**
 * Technology Ecosystem strip for the login pages.
 *
 * A compact, unobtrusive row of brand marks (transparent backgrounds, brand
 * colours, one consistent size) followed by a row of capability labels. It sits
 * in the page footer only, so it never competes with the sign-in form.
 */

type Brand = {
  name: string;
  /** Brand colour, or `null` for marks that are officially monochrome. */
  colour: string | null;
  path: string;
  /** Simple Icons marks are drawn on a 24x24 grid. */
  viewBox?: string;
};

const BRANDS: Brand[] = [
  {
    name: "Espressif",
    colour: "#E7352C",
    path: "M12.926 19.324a7.6 7.6 0 00-2.983-6.754 7.44 7.44 0 00-3.828-1.554.697.697 0 01-.606-.731.674.674 0 01.743-.617 8.97 8.97 0 018 9.805 7.828 7.828 0 01-.298 1.542l1.989.56a11.039 11.039 0 001.714-.651 12.159 12.159 0 00.217-2.343A12.57 12.57 0 007.212 6.171a5.53 5.53 0 00-2 0 4.354 4.354 0 00-2.16 1.337 4.274 4.274 0 001.909 6.856 9.896 9.896 0 001.074.195 4.011 4.011 0 013.337 3.954 3.965 3.965 0 01-.64 2.16l1.371.88a10.182 10.182 0 002.057.342 7.52 7.52 0 00.754-2.628m.16 4.73A13.073 13.073 0 01.001 10.983 12.982 12.982 0 013.83 1.737l.743.697a12.067 12.067 0 000 17.141 12.067 12.067 0 0017.141 0l.697.697a12.97 12.97 0 01-9.336 3.726M24 10.993A10.993 10.993 0 0012.949 0c-.389 0-.766 0-1.143.057l-.252.732a18.912 18.912 0 0111.588 11.576l.731-.263c0-.366.069-.732.069-1.143m-1.269 5.165A17.53 17.53 0 007.818 1.27a11.119 11.119 0 00-2.457 1.77v1.635A13.919 13.919 0 0119.268 18.57h1.634a11.713 11.713 0 001.771-2.446M7.92 17.884a1.691 1.691 0 11-1.69-1.691 1.691 1.691 0 011.69 1.691",
  },
  {
    // EMQX mark: hexagonal shell with the three-bar "E". Official artwork ships
    // as monochrome light/dark variants, so it follows the theme foreground.
    name: "EMQX",
    colour: null,
    viewBox: "0 0 24 24",
    path: "M12 1.9 21.5 7.3v9.4L12 22.1 2.5 16.7V7.3L12 1.9Z",
  },
  {
    name: "Cloudflare",
    colour: "#F38020",
    path: "M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727",
  },
  {
    name: "Supabase",
    colour: "#3FCF8E",
    path: "M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z",
  },
  {
    name: "GitHub",
    colour: null,
    path: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  },
];

const TECH_LABELS = ["ESP32", "ESP-NOW", "MQTT", "BLE", "Wi-Fi", "HTTPS", "OTA"];

export function TechnologyEcosystem({ className }: { className?: string }) {
  return (
    <div
      className={["flex flex-col items-center gap-2", className].filter(Boolean).join(" ")}
      data-testid="technology-ecosystem"
    >
      <ul
        aria-label="Built with"
        className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 sm:gap-x-7"
      >
        {BRANDS.map((brand) => (
          <li key={brand.name} className="flex items-center">
            <span className="sr-only">{brand.name}</span>
            <svg
              aria-hidden="true"
              focusable="false"
              viewBox={brand.viewBox ?? "0 0 24 24"}
              role="img"
              className="h-4 w-auto opacity-80 transition-opacity duration-200 hover:opacity-100"
              fill={brand.colour ?? "currentColor"}
            >
              {brand.name === "EMQX" ? (
                <>
                  <path d={brand.path} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                  <path
                    d="M7.6 8.2h8.6M7.6 11.2h5.8M7.6 14.2h8.6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  />
                </>
              ) : (
                <path d={brand.path} />
              )}
            </svg>
          </li>
        ))}
      </ul>

      <ul
        aria-label="Technologies"
        className="flex flex-wrap items-center justify-center text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70"
      >
        {TECH_LABELS.map((label, index) => (
          <li key={label} className="flex items-center gap-2">
            {index > 0 && (
              <span aria-hidden="true" className="px-1 text-muted-foreground/40">
                ·
              </span>
            )}
            <span>{label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
