# Helios Design System

> Every UI implementation in this repository must follow this document. It is the authoritative source for visual and interaction decisions: `apps/web/src/styles.css` is its executable form.

## 1. Product design principles

1. **Immediate clarity over decoration.** A customer must always know which board, room, device, GPIO and connection they are looking at.
2. **Real state, not optimistic state.** A switch is ON only when the ESP32 reported ON. Requested, confirmed, unknown, offline and failed are distinct visual states.
3. **Two consoles, one language.** The Platform Owner Console and Customer Home Console share components, tokens and typography but have separate navigation and never mix scopes.
4. **Colour is information.** Colour is reserved for device state, warnings, errors and primary actions. Neutral ink/surfaces carry structure.
5. **No fake data.** Empty states describe the next real action. Loading skeletons mirror the real layout. Unavailable metrics say "Unavailable" with a reason.
6. **Restraint.** Subtle borders and shadows, minimal motion, no gradients used as decoration, no generic "AI dashboard" cards.
7. **Backend truth.** Every control performs a real API call; every table row is a database row.

## 2. Colour tokens

| Token | Value | Use |
|---|---|---|
| `--workspace` | `#FFFFFF` | Primary workspace background |
| `--sidebar` | `#F6F7FB` | Soft neutral sidebar |
| `--surface` | `#FFFFFF` | Cards |
| `--surface-2` | `#FAFAFC` | Hover / subtle inset |
| `--surface-3` | `#F3F4F8` | Chips, icon wells, segmented controls |
| `--text` | `#20212B` | Primary text, primary button label |
| `--text-2` | `#676879` | Secondary text, labels |
| `--text-3` | `#9395A4` | Metadata, captions |
| `--border` | `#E7E8EE` | Default borders, dividers |
| `--border-strong` | `#D9DBE4` | Input borders |
| `--focus` | `#3B6FE0` | Focus ring only |
| `--state-on` / `--state-on-bg` | `#12855B` / `#E8F6F0` | Confirmed ON, healthy, success |
| `--state-off` / `--state-off-bg` | `#676879` / `#F1F2F6` | OFF, neutral state |
| `--warn` / `--warn-bg` | `#B7720C` / `#FFF5E4` | Warning, boot-strapping, pending sync |
| `--danger` / `--danger-bg` | `#C43D3D` / `#FDEDED` | Failure, restricted GPIO, destructive action |
| `--info` / `--info-bg` | `#2B62C9` / `#EDF3FF` | Informational notice |
| Pin tokens | `--pin-available` `#F7F8FB`, `--pin-assigned` `#E8F6F0`, `--pin-system` `#F1F2F6`, `--pin-restricted` `#FDEDED` | GPIO states |

Primary action uses ink (`--text`), not a brand accent colour. Status colour never becomes a background wash on an entire page.

## 3. Surface hierarchy

- Level 0: workspace `#FFFFFF`.
- Level 1: sidebar `#F6F7FB` with a 1px right border.
- Level 2: cards on white with `--border` and `--shadow-sm`.
- Level 3: nested wells (`--surface-3`), code blocks, segmented controls.
- Dialogs: white card, `--shadow-lg`, backdrop `rgba(25,26,35,.32)` with 2px blur.

## 4. Borders and shadows

| Token | Value | Use |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgba(32,33,43,.04)` | Cards, active nav |
| `--shadow-md` | `0 4px 18px rgba(32,33,43,.07)` | Card hover, toasts |
| `--shadow-lg` | `0 18px 50px rgba(32,33,43,.14)` | Modal |
| Border width | 1px | All borders; active nav uses white fill instead of a thicker border |

## 5. Spacing scale

`--s1 4px`, `--s2 8px`, `--s3 12px`, `--s4 16px`, `--s5 20px`, `--s6 24px`, `--s8 32px`, `--s10 40px`. Page padding 28px desktop / 18px mobile; card padding 18px; grid gap 14px; form row gap 12px; field label gap 6px.

## 6. Border radius

`--r-sm 6px` (buttons, inputs, badges use 20px pill), `--r-md 10px` (pins, chips), `--r-lg 14px` (cards, tiles), `--r-xl 20px` (modals).

## 7. Icon system

`lucide-react`, 1.8 stroke, 16px in navigation, 14–15px in buttons and wells, 17px in device icons. Icons are monochrome (`--text-2` normally, `--text` on active). Icons never carry status colour by themselves; colour comes from the badge/dot. Mapped centrally in `apps/web/src/components.tsx` (`Icon`, `DEVICE_ICONS`, `SENSOR_ICONS`, `ROOM_ICONS`).

## 8. Component standards

### Buttons
- `.btn` — 34px height, 13px horizontal padding, 12.5px/600 label, 6px radius, 1px `--border-strong`.
- Variants: `.btn-primary` (ink fill), `.btn-danger` (danger text/border), `.btn-ghost` (no border), `.btn-sm` (28px), `.btn-icon` (32px square), `.btn-block`.
- Disabled: `opacity .5`, no pointer. Always show a busy state for real writes.

### Cards
`.card` + `.card-pad`, optional `.card-head` with title (13.5px/650) and sub (11.5px muted). Cards never contain a decorative gradient.

### Forms
`.field` label 11.5px/600 `--text-2`; `.input`/`.select`/`.textarea` 36px, 1px `--border-strong`, focus ring `0 0 0 3px rgba(59,111,224,.12)`; `.hint` 11px muted. Two-column `.form-row`. Checkboxes use the ink accent. Validation errors are inline + toast, never silent.

### Tables
`.tbl`: 11px uppercase muted headers, 12.5px body, 12px vertical padding, bottom border per row, hover `--surface-2`, no zebra striping. Right-align actions with `.row-actions`.

### Dialogs
`.modal` max 560px (860px `.wide`), 88vh max height, `.modal-head/body/foot`, Escape and backdrop close, primary action rightmost. Destructive confirmations require typing an exact identifier when the operation is irreversible (e.g. unclaim).

### Dropdowns
Native `<select>` styled with `.select` for reliability and accessibility. `.segmented` for 2–3 mutually exclusive short options. Action menus are inline cards in the sidebar, not floating popovers.

### Navigation
244px sidebar, 36px nav items, 16px icons, 10.5px uppercase group labels, active item = white fill + `--shadow-sm`. Owner navigation is completely separate (Overview, Customers, Staff & Access, EMQX Management, Usage & Monitoring, Board Library, Platform Settings, Audit Logs). Customer navigation groups Home / Devices / Manage. On ≤860px the sidebar collapses to a 64px icon rail.

### Device cards
`.device-card`: icon well, name, room/type metadata, status badge, border-top state row, 42×24 switch. The state line always reads "Confirmed ON", "Requested ON — awaiting acknowledgement", "State unknown", "Controller offline" or "Command failure" — never simply "ON" after a click.

### GPIO pin states
| State | Background | Border | Badge dot |
|---|---|---|---|
| Available | `--pin-available` | `--border-strong` | `--text-3` |
| Assigned | `--pin-assigned` | `#BFE4D4` | `--state-on` |
| System reserved | `--pin-system` | dashed | `--text-3` |
| Restricted | `--pin-restricted` | `#EECACA` | `--danger` |
| Incompatible | available + `opacity .55` | default | — |

Each pin shows GPIO number, header label, and allocation owner/function. Clicking opens a detail dialog with header position, functions, ADC channels, direction, boot-strapping, USB/JTAG, flash/PSRAM, restrictions and notes. A "validate against" selector recomputes compatibility for output / input / ADC / PWM.

### Status indicators
`.badge` pill with 6px dot; tones `on`, `off`, `warn`, `danger`, `info`. Live connection uses a pulsing dot (2s ease-in-out) and stops under reduced motion. Status text is written out ("Pending sync"), not colour-only.

### Charts
Hand-built SVG (`MiniChart`) with 1px neutral gridlines, a 2px ink line, and a 5% ink area fill. Labels 9px `--text-3`. No colour series, no 3D, no animation that obscures values. When a provider metric is missing, the chart area shows an "Unavailable" empty state with the reason.

## 9. Responsive layout rules

- ≥1100px: 4-column stats, 3-column card grids, 244px sidebar.
- 861–1099px: stats and grids collapse to 2 columns.
- ≤860px: single-column grids, 64px icon-rail sidebar, 18px page padding; auth page shows the form only.
- Tables scroll horizontally inside `.table-wrap`; modals become full-width minus 20px padding.
- Pin grids use `repeat(auto-fill, minmax(76px, 1fr))` and reflow without overlap.

## 10. Animation standards

- Page/route transitions: none (instant clarity); content fades only via skeletons resolving.
- Dropdown/dialog: 160–180ms ease-out (`fade-in`, `modal-in`), transform ≤8px, scale ≥.985.
- Card hover: 180ms shadow + 2px lift on board tiles only.
- Switch: 220ms background + knob transform (`cubic-bezier(.2,.8,.2,1)`).
- Pin allocation/release: 160ms background transition; no pin re-ordering animations.
- Live dots: 2s pulse.
- Skeleton shimmer: 1.4s linear gradient.
- Provisioning: stepper + progress feedback, no confetti.
- `@media (prefers-reduced-motion: reduce)` sets all durations to `.001ms`. No animation may delay a device command.

## 11. Accessibility

- Native labels, semantic headings, `aria-modal`/`aria-label` on dialogs and switches (`aria-pressed`).
- Focus-visible ring 2px `--focus` with 2px offset.
- Colour is never the only signal; badges include text; errors include messages.
- Minimum contrast: primary text `#20212B` on white; secondary `#676879` on white; white on ink buttons.
- Icon-only buttons always have `title` and `aria-label`.
- Keyboard: Escape closes dialogs; all controls reachable by Tab.

## 12. Empty, loading and error states

- **Empty:** centered 42px icon well, 13.5px title, 12px explanatory text (max 420px), one primary action describing the real next step. No illustrative illustrations of fictional devices.
- **Loading:** `.skeleton` blocks matching the actual grid/card/table geometry; never a spinner over a finished layout.
- **Error:** inline notice (`--danger-bg`) plus toast naming the failed operation and the server reason; the user can retry. Network/fabricated values are never substituted.
- **Unavailable:** for provider metrics, show "Unavailable", the explicit reason, and the owner-side sync/manual-entry action. Estimated values are always labelled "Application-side estimate".

## 13. Implementation map

| Document section | Code |
|---|---|
| Tokens, layout, components | `apps/web/src/styles.css` |
| Reusable components | `apps/web/src/components.tsx` |
| Customer console | `apps/web/src/pages/customer.tsx` |
| Owner console | `apps/web/src/pages/owner.tsx` |
| Shell / navigation / auth | `apps/web/src/App.tsx` |
| Typography | `typography.md` |
