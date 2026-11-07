# Helios Typography

> Typography is the primary hierarchy tool. No decorative display fonts, no all-caps headings, no coloured text used for emphasis.

## 1. Font family

**Geist Sans** is the product typeface.

```css
--font: 'Geist Sans', 'Geist', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
--font-mono: 'Geist Mono', 'SFMono-Regular', ui-monospace, Menlo, Consolas, monospace;
```

- Production: self-host Geist Sans / Geist Mono from Cloudflare Pages as local font assets (no third-party CDN, no external requests from the preview iframe).
- Development/preview: the system stack renders immediately; layout and metrics are identical.
- Mono is used **only** for identifiers, topics, GPIO numbers, hashes, code and numeric payloads — never for prose.

## 2. Font weights

| Weight | Use |
|---|---|
| 400 | Body copy, descriptions, help text |
| 500 | Secondary labels, nav items, breadcrumbs |
| 550 | Segmented control labels, inactive tabs |
| 600 | Button labels, form labels, table headers, badges, device names |
| 650 | Page headings, card titles, stat values, brand name |

No 700/800/900 and no faux bold.

## 3. Type scale

| Name | Size | Line-height | Weight | Letter spacing |
|---|---|---|---|---|
| Display (auth art) | 30px | 1.2 | 650 | −0.05em |
| Page heading `h1` | 23px | 1.25 | 650 | −0.035em |
| Auth heading | 22px | 1.25 | 650 | −0.035em |
| Modal heading | 16.5px | 1.3 | 650 | −0.02em |
| Section heading `h3` | 13.5px | 1.35 | 650 | −0.01em |
| Tile / device heading `h4` | 13–15px | 1.35 | 650 | −0.01em |
| Body | 14px | 1.5 | 400 | normal |
| Lead / description | 13px | 1.55 | 400 | normal |
| Button / nav / table | 12.5–13px | 1.4 | 500–600 | normal |
| Label | 11.5px | 1.35 | 600 | normal |
| Caption / metadata / tiny | 11–11.5px | 1.4 | 400–500 | normal |
| Group label / table header | 10.5–11px | 1.3 | 600 | +0.02em to +0.09em (uppercase only) |
| Stat value | 26px | 1.2 | 650 | −0.045em |
| Telemetry value | 25px | 1.2 | 650 | −0.04em |

## 4. Component typography

| Component | Specification |
|---|---|
| Page heading | 23/650 with `−0.035em`; description 13px `--text-2`, one short line, max-width 680px, never duplicated in a card |
| Section heading | 13.5/650; card sub 11.5px `--text-3` |
| Body text | 14px `--text`, 1.5 line-height; descriptions 13px `--text-2` |
| Labels | 11.5/600 `--text-2`; hints 11px `--text-3`; no placeholder-as-label |
| Form typography | Inputs 13px/400; selects 13px; textarea 13px; monospace inputs 12px |
| Device names | 13.5/650 `--text`; metadata 11.5px `--text-3` |
| Numeric values | `font-variant-numeric: tabular-nums`; stat 26/650; telemetry 25/650; unit 12/500 `--text-3` |
| Telemetry values | 25/650 with 12px unit; history values 12.5px mono; invalid/out-of-range values are rejected, never rendered as if valid |
| Chart labels | 9px `--text-3`, dates shortened (`Nov 8`), no rotated text |
| Table typography | Headers 11/600 uppercase `--text-3` +0.02em; body 12.5/400; identifiers 11.5px mono |
| Badges | 11/600, sentence case ("Pending sync"), never all caps |
| Buttons | 12.5/600; small 11.5/600 |
| Code / topic / hash | 11.5px mono `--text-2`, word-break for long tokens |
| Breadcrumb | 12.5px `--text-3`; current page 13/600 `--text` |

## 5. Line heights

Headings 1.2–1.35, body 1.5, dense UI text 1.4, captions 1.3–1.4, notices 1.55–1.65. Never below 1.2 for copy.

## 6. Letter spacing

- Negative tracking only on large text (−0.02em to −0.05em) and stat/telemetry numbers (−0.045em).
- Positive tracking only on uppercase micro-labels (+0.02em group, +0.09em nav group).
- Body, labels, buttons and tables: normal.

## 7. Responsive typography

- ≤860px: page heading 21px, auth display hidden, page description 12.5px, grids single column but type sizes stay fixed to avoid reflow jitter.
- ≤420px: stat value 22px, telemetry value 22px, table body 12px with horizontal scroll.
- No viewport-unit font sizes; text never scales below 11px.

## 8. Consistency rules

1. One `h1` per page; card titles are `h3`; modal titles are `h2`.
2. Descriptions appear once (under the page heading), never repeated as card subtitles and banner text.
3. Status is always a word + badge, never colour alone.
4. Numbers are tabular; identifiers are mono; prose is sans.
5. Uppercase is reserved for micro-labels (group names, table headers) and never for device names.
6. Empty-state titles 13.5/650, body 12px `--text-2`, max-width 420px.

## 9. Implementation

All rules are encoded in `apps/web/src/styles.css`. Component usage lives in `apps/web/src/components.tsx`. Any future UI change must update both this document and the stylesheet.
