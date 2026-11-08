# HomecoreOS — UI diagnosis & redesign record

**Scope:** the whole web console (`/owner`, `/customer`, `/owner/setup`, auth, and the new owner screens).
**Baseline examined:** commit `7bd46f6` — `apps/web/src/styles.css`, `components.tsx`, `App.tsx`, `index.html`, `pages/*.tsx`, `apps/web/package.json`.
**Method:** static audit of the baseline snapshot against the *Redesign Existing Projects*, *Landing Page Design* (shared visual system) and *Figma Designer* (tokens, states, accessibility, motion) skills. Contrast ratios below are computed from the shipped token values with the WCAG relative-luminance formula. Browser rendering and a device at 390 px were not available in this environment; those checks are listed explicitly under *Remaining checks*.

The baseline was already a competent, quiet dashboard. The redesign was therefore a system replacement rather than a cosmetic repaint: one typeface, a two-layer colour system with dark mode, one icon family, semantic landmarks, and complete interactive states.

---

## 1. Diagnosis of the baseline

### Typography — priority 1
- `--font` declared `'Geist Sans', 'Geist', 'Inter', … , Roboto, Helvetica, Arial` and `--font-mono` declared `'Geist Mono'`; neither Geist face was loaded by `index.html`. In practice the app fell through to **Inter/system/Roboto/Arial** — four of the disallowed families — and no approved webfont was ever fetched.
- Ad-hoc sizes (`10.5px`, `11.5px`, `12.5px`, `13.5px`, `15px`, `23px`, `26px`) and ad-hoc weights (`650`, `600`, `500`) rather than a named scale. `--r-*` radii were `6/10/14/20` and spacing used `4/8/12/16/20/24/32/40` with no nested-radius rule.
- No named text-style set existed, so headings, labels, captions and data values were styled per component.

### Colour & surfaces — priority 2
- One flat list of 30+ raw hex variables in a single `:root`. No `Core Colors` layer, no `Color System` light/dark alias layer, no dark mode at all. `theme-color` was hard-coded `#FFFFFF`.
- `--accent: #20212B` was near-black "ink, not decoration": there was no accent hue below 80 % saturation, so the interface had no semantic colour hierarchy beyond status colours.
- Single-sided borders throughout (`.sidebar { border-right }`, `.topbar { border-bottom }`, `.card-head { border-bottom }`, `.board-tile .art { border-bottom }`) — the Figma token spec requires card borders on all sides or none, with internal separators drawn as filled 1 px divider rectangles rather than single-side card borders.
- Decorative gradients (`.skeleton` shimmer and `.board-tile .art` 135° gradient) and neutral drop shadows (`--shadow-sm/md/lg` using plain `rgba(32,33,43,…)`). The spec allows tinted shadows and no background gradients except a hero heading text gradient.
- No overlay token set, no `--state-*-border`/`--*-on` pairs, so error/success/warning surfaces were single flat tones.

### Interaction states — priority 3
- Baseline `.btn` had `:hover`, `:active`, `:disabled` and a global `:focus-visible`, but **no pressed/focus/disabled variants for inputs, selects, cards, nav items, tabs or table rows**, no error/filled input states, and no loading state on buttons (no spinner, no `aria-busy`).
- `EmptyState`, `Skeleton`, `Loading` and `Notice` existed, but there was **no composed error state, no success state, no inline field validation**, and no per-component "is loading / is empty / has error" contract.
- `CopyButton` used `navigator.clipboard` without a visible success/failure state.

### Layout & spacing — priority 4
- `.content-inner { max-width: 1320px }` exceeds the 1200–1280 desktop container; `.sidebar` was a fixed 244 px with no mobile drawer/scrim semantics.
- Breakpoints existed at 1100 px and 860 px, and there was a `prefers-reduced-motion` block, but **there was no 390 px breakpoint**. Touch targets were 28–36 px high (`.btn-sm` 28 px, `.nav-item` 36 px), below the 44 px minimum.
- Repeated three/four-equal-column stat grids with no componentisation of repeated device rows.

### Motion — priority 5
- `transition: … .16s ease` / `transform .12s ease` — generic easing, not the required `cubic-bezier(0.22, 1, 0.36, 1)`; no 500 ms movement / 300 ms colour split.
- No scroll reveals / `IntersectionObserver`; `@keyframes fade-in` and `modal-in` were unconditional, so reduced-motion users only got a blanket animation kill rather than an intentional reduced path.
- `dot-pulse` and `shimmer` were the only motion vocabulary.

### Components & icons — priority 6
- `lucide-react` was the single dependency. Lucide is on the disallowed icon list; the approved sets are Phosphor, Solar or Iconamoon.
- Components were present but thin: `DataTable` took plain rows, `Modal` had no focus trap or Escape handling, `Tabs` had no `aria-selected`/keyboard semantics, and no `Icon/*` token concept existed (icons were hardcoded `stroke-width: 1.8/1.9`).

### Copy, semantics & accessibility — priorities 7–9
- `index.html` had no meta description, no favicon, no early theme script and no skip link. Missing `<main>`, `<nav>`, `<header>`, `<footer>` landmarks; the shell was `<div>` soup.
- No custom 404 (unknown routes fell through to the router's default), no `aria-current` on the active nav item, no accessible labels on icon-only buttons, and no form-level validation messaging.
- Owner and customer consoles duplicated the same board/settings/security/wizard blocks with different wrappers, so visual consistency was accidental rather than enforced by shared components.

### Figma-specific gaps
- No 10-shade `Core Colors` palette, no `Color System` Light/Dark modes, no named text styles, no `Default / Hover / Pressed / Focus / Disabled` component variants (and `Error / Filled` for inputs), no five button types × five states, no Loading skeleton / Empty composed / Error variants, no 768 px and 390 px frames, no one-stroke-weight SVG icon set bound as a token.

---

## 2. Remediation, in the required priority order

| # | Area | Shipped change |
|---|---|---|
| 1 | Font | **Manrope** loaded in `index.html` and used as the single typeface; Geist Mono retained only for numeric/code fallback. Tailwind type scale `text-xs … text-4xl` (12/14/16/18/20/24/30/36) with named sizes, weights 500/600/700 only, no italics or ultra-bold. |
| 2 | Colour / surfaces | `apps/web/src/styles.css` now defines a `Core Colors` layer (Primary, Grayscale, Red, Green, Yellow, accent at 10 named shades) and a `Color System` layer with `Light` and `Dark` modes. Semantic tokens `--bg`, `--surface`, `--surface-strong`, `--surface-subtle`, `--border`, `--text`, `--muted`, `--primary`, `--primary-on`, `--success*`, `--warn*`, `--error*`, `--overlay*`, `--shadow-tint`. Dark surfaces use only the allowed `#000000 / #0B0D10 / #14171C / #16191E / #1F242B / #272D35` family. Card shells now have full-perimeter borders (the single-side card borders are gone); internal separators are 1 px filled lines for table rows and shell chrome. Decorative gradients are removed — the one remaining `linear-gradient` is the moving highlight inside the skeleton shimmer, not a surface fill. Shadows are tinted. |
| 3 | States | Every control ships default, hover, pressed, focus-visible, disabled, and — for inputs — error and filled. Long-running actions set `aria-busy="true"`, which renders a spinner ring and a "Saving… / Creating…" label; `Loading` (skeleton), `EmptyState` (composed), `ErrorState` (retry) and `SuccessState` are shared components; inline field errors replace native dialogs; `Notice` covers info/warn/error/success. Toasts are a polite live region with `role="status"` / `role="alert"`. |
| 4 | Layout | 1200 px container, Tailwind spacing scale `0/2/4/8/12/16/24/32/40/48/64/80/96`, radii `0/2/4/6/8/12/16/24/9999` with nested `inner = outer − gap`, mobile drawer with scrim, breakpoints at 1100 / 860 / 480 px plus a dedicated `@media (max-width: 390px)` pass (single-column key/value rows, wrapping page actions, scrollable filter bars and tabs, safe word wrapping), 44 × 44 px minimum touch targets. |
| 5 | Motion | `cubic-bezier(0.22, 1, 0.36, 1)` at 500 ms for movement and 300 ms for colour, transform + opacity only, `IntersectionObserver` scroll reveals, and a full `prefers-reduced-motion` path that disables transforms and reveals. |
| 6 | Components / icons | `lucide-react` and `@phosphor-icons/react` removed from `package.json`; `apps/web/src/icons.tsx` contains 100 **local Phosphor Regular** glyphs at one stroke weight, bound through `makeIcon()` and exposed as a single semantic `Icon` map. Shared `Card`, `Stat`, `Badge`, `StatusBadge`, `DataTable`, `Modal` (Escape + outside click), `Tabs` (ARIA), `Field`, `CopyButton`, `Progress`, `DeviceIllustration`. |
| 7 | Copy | Sentence-case, realistic, no invented metrics or hardware claims. Device setup wizard says "Not reported" when firmware has not supplied chip, MAC, board revision, RSSI or uptime, and advances only on a real `status === 'online'`. |
| 8 | Semantics / a11y | `<header> / <nav aria-label> / <main id="main"> / <footer>` landmarks, skip link, `aria-current="page"` from `NavLink`, `aria-label` on all 17 icon-only controls, `aria-busy` on in-flight buttons, `role="status"` / `role="alert"` toasts inside a polite live region, `aria-pressed` on device switches, custom `NotFoundPage`, viewport/theme-color/description meta, inline SVG favicon, early theme script (no flash of wrong theme). |
| 9 | Themes | `System / Light / Dark` preference persisted in `homecoreos_theme`, applied via `data-theme` on `<html>`, with a keyboard-operable theme menu (outside click + Escape). Customer and owner consoles share the same shell, tokens and components. |

### Contrast verification (computed, WCAG 2.1)

| Pair | Light | Dark |
|---|---:|---:|
| Body text / page background | 15.41:1 | 17.65:1 |
| Muted text / page background | 4.66:1 | 8.18:1 |
| Body text / card | 16.39:1 | 15.98:1 |
| Muted text / card | 4.96:1 | 7.41:1 |
| Button label / primary fill | 5.70:1 | 8.17:1 |
| Success / Error / Warning text on tinted surface | 5.82 / 6.28 / 5.52:1 | 9.84 / 8.44 / 9.83:1 |

All body-text pairs clear 4.5:1 and all large/UI pairs clear 3:1. Status is never conveyed by colour alone — every badge and notice carries an icon and a text label.

---

## 3. New screens covered by the same system

- **Owner → Firmware Management** — storage status (never claims "connected" without a real R2 round trip), upload with SHA-256 read-back, edit, publish/archive, deploy, delete with confirmation, and real deployment history.
- **Owner → Board Library** — documented GPIO maps, validation against restricted/boot-strapping/input-only pins, and an explicit "link the manufacturer pinout" requirement; no invented specifications.
- **Owner → Platform Settings / Authentication & Security** — only values and events the backend actually reads, writes or records; sensitive changes require explicit confirmation; no fake security score or placeholder charts.
- **Device Setup Wizard** — five real steps with live polling, plain language, no fake success animation on a failed or unclaimed connection.
- **Customer Overview** — device-first home console with areas, filters, controllers, sensors, automations and activity, using the same components and tokens as the owner console.

---

## 4. Verification performed

- `npm run typecheck` — clean for `core`, `api`, `web`.
- `npm run build` — clean with no warnings; framework and app code split into two cacheable chunks (vendor 164.62 kB / 53.56 kB gzip, app 339.93 kB / 87.46 kB gzip, CSS 35.13 kB / 7.08 kB gzip).
- Static CSS audit — 372 balanced rule blocks, 103 defined tokens, 78 used tokens, 0 undefined `var()` references, media queries at 1100 / 860 / 480 / 390 px plus a reduced-motion path.
- PostgREST-free API integration against a real PostgreSQL (PGlite) — 46/46 assertions covering owner auth, firmware upload/checksum/duplicates/download, board GPIO validation, settings enforcement, feature gates, real security events, pairing-token progress/cancel, and customer denial of owner routes.
- `supabase/schema.sql` applied twice — 45/45 assertions, 0 comments.
- Pages Functions bundle — 0 `node:` imports.
- Local S3-compatible SigV4 mock — 11/11 assertions (the R2 client only; **not** a connection to Cloudflare R2).
- Static greps: no `lucide-react`, no `@phosphor-icons/react`, no `supabase.auth`/GoTrue calls, no `window.alert`, no `VITE_` credential copies, 0 SQL comments.

## 5. Remaining checks (require a browser or a hosted environment)

These were not possible in this workspace and are called out rather than claimed as done:

1. Visual inspection at 390 px, 768 px and 1440 px on a real device/emulator, including the mobile drawer and horizontal overflow of tables.
2. Keyboard-only walkthrough of the theme menu, modal focus trapping, and wizard step navigation; screen-reader pass on landmarks and live regions.
3. Rendering with Manrope actually loaded from the network (the in-app file preview has no network access, so the local fallback is used there).
4. `Theme = System` behaviour when the OS preference changes while the console is open.
5. A real upload → download → SHA-256 → delete round trip against a private Cloudflare R2 bucket, which is the only event that may mark storage as **Verified**.
