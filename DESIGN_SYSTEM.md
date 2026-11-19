# HomecoreOS Design System

Single source of truth for both the **User Console** and **Admin Console**.
Built cleanly in `apps/web` with **Tailwind CSS v4** (`apps/web/src/styles/globals.css`), **shadcn/ui (`radix-nova`)**, **ReUI (`@reui`)** structural primitives, **Cult UI `Onboarding`**, self-hosted **Geist Variable** & **Geist Mono Variable** typography (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono`), custom architectural/hardware SVGs (`apps/web/src/components/graphics/HomecoreGraphics.tsx`), and `@remixicon/react`.

---

## 1. Design Philosophy

HomecoreOS is an operational smart-home automation platform and ESP32 hardware control plane. The visual language combines crisp architectural blueprint precision with warm daylight ergonomics:

- **Composable ReUI + Radix Architecture**: Standard UI controls live in `apps/web/src/components/ui/` (Radix-backed `button`, `card` with `interactive` hover elevation mode, `dialog`, `alert-dialog`, `empty`, `progress`, `input`, `label`, `select`, `switch`, `tabs`, `table`, `tooltip`, `dropdown-menu`, `skeleton`, `separator`, `field`) and `apps/web/src/components/reui/` (`alert`, `badge`, `icon-tile`, `icon-stack`, `stepper`, `frame`).
- **Unified Empty States & Interactive Cards**: Every empty collection or table across both consoles uses `EmptyStatePanel` (`shadcn` `<Empty>` + `ReUI` `<IconStack>` with semantic tone tinting); clickable hardware/room/rule/board/firmware cards opt into `<Card interactive>` while static dashboards and settings panels remain calm.
- **Focused Canvas & Modal Workflows**: Primary workspace views highlight live state, tables, and the 2D floor plan; entity creation, controller recovery/Wi-Fi setup, firmware inspection, and full-field editing open inside validated modal dialogs (`RoomEditorModal`, `SwitchEditorModal`, `DeviceEditorModal`, `SensorEditorModal`, `ControllersPage` recovery dialogs) with real-time board GPIO validation and `ConfirmDeleteDialog` safeguards.
- **Truthful Operational State**: USB Web Serial flashing stages (`Preparing Firmware` → `Connect Serial` → `Detect Board` → `Writing Flash` → `Verify & Reset` → `Complete`) and OTA update phases reflect real `esptool-js` and backend telemetry via ReUI `Stepper`, `Progress`, `Onboarding`, and `useUsbFlashSession()`—never simulated progress.
- **Architectural 2D Floor Plan**: Homes render as one connected top-down floor map (`HomeFloorPlan.tsx` → `SmartHomeMap.tsx` + `house-layout.ts`) with pastel room floors, shared white walls, cut-through doorways, exterior windows, per-room furniture, warm room lighting that follows real light state, white circular device badges, swipe/scroll zoom, pan, room focus dimming, and direct device control popovers.
- **Unified Light & Dark Themes**: Class-based `.dark` on `<html>`, persisted via `localStorage` key `homecoreos:theme` with pre-hydration inline script in `apps/web/index.html`.

---

## 2. Typography

Self-hosted locally in the bundle (no external font CDN dependency):

- **Sans (`--font-sans`)**: `"Geist Variable", "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- **Monospace (`--font-mono`)**: `"Geist Mono Variable", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace`
- **Tabular numbers**: `.tabular-nums` (`font-variant-numeric: tabular-nums`) on all metric counters, sensor readings, byte counts, progress percentages, pairing codes, and timezone-aware timestamps.

---

## 3. Semantic Tokens & Registry Configuration

Configured in `apps/web/components.json` (`style: "radix-nova"`, `iconLibrary: "remixicon"`, `@reui` registry) and `apps/web/src/styles/globals.css`:

- **Core Surfaces & Brand**: `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--sidebar`
- **ReUI Semantic Accents**: `--success`, `--success-foreground`, `--info`, `--info-foreground`, `--warning`, `--warning-foreground`, `--invert`, `--invert-foreground`, `--focus`
- **Floor Plan Grid**: `--hc-floor-grid` (powers `.hc-blueprint-bg` in both light and dark modes).

---

## 4. Core Component Architecture

- **`apps/web/src/components/ui/`**: shadcn `radix-nova` primitives (`empty`, `card`, `dropdown-menu`, etc.) plus Cult UI `onboarding.tsx`.
- **`apps/web/src/components/reui/`**: ReUI `alert`, `badge`, `icon-tile`, `icon-stack`, `stepper`, `frame`.
- **`apps/web/src/components/shared/AppUi.tsx`**: Shared composite patterns (`PageHeader`, `StatCard`, `StatusAlert`, `ConfirmDeleteDialog`, `EmptyStatePanel` with ReUI `IconStack` + shadcn `Empty`, `ThemeToggleButton`, `TimezoneSelect`, `FormField`).
- **`apps/web/src/components/hardware/EntityModals.tsx`**: Unified Add/Edit dialogs (`SwitchEditorModal`, `DeviceEditorModal`, `SensorEditorModal`). The pin field is `useGpioPinField()` (`src/lib/use-gpio-pin-field.ts`) plus `GpioPinPicker`, backed by `src/lib/board-pin-helpers.ts` and the shared pin policy (`buildGpioPinSelectorModel` in `@homecoreos/shared`).
- **`apps/web/src/components/hardware/GpioPinPicker.tsx`**: Visual GPIO pin selector. One tile per GPIO in four states (available, used, restricted, dangerous), each with an icon and a word next to its colour; suggested pins as one-click chips; an explanation line for the pointed, focused or pressed tile; one tab stop with arrow-key, Home and End navigation. Blocked tiles stay focusable (`aria-disabled`) so their reason can be read.
- **`apps/web/src/components/graphics/HomecoreGraphics.tsx`**: `HomecoreLogoMark`, `HomecoreWordmark`, `Esp32BoardDiagram` (highlights `BOOT (GPIO0)` & `USB`/`UART` ports for onboarding).
- **`apps/web/src/components/boards/BoardLibraryCard.tsx`**: Board Library card with a fixed structure so cards in a row line up: drawing on top (source tag and "Verified" badge), model, maker and revision, five fields in a fixed order (Chip, Memory, Wireless, Pins, Firmware), and the actions pinned to the bottom. Everything else lives in `BoardDetailsDialog.tsx` (tabs "Board details" and "Pinout details", with `BoardPadTable.tsx` for the pad list).
- **`apps/web/src/components/controllers/ControllerCard.tsx`**: User-console controller card built at the same scale and anatomy as `BoardLibraryCard` so both grids read as one family: the board-map stage on top (`h-40`, dotted `.hc-dot-grid` panel with the `BoardVectorSvg` drawing of the controller's selected Board Library profile, room chip and firmware version badge overlaid in its corners as system `Badge`s), then the name (`text-sm font-bold`) with its kebab menu, the board model on a lightning row, five label/value rows on the shared `grid-cols-[4.25rem_minmax(0,1fr)]` column grid (Status, Wi-Fi, MQTT, Pairing, Last Seen) using system `Badge` variants, an optional connection-error strip, and the outlined primary `Details` button pinned to the bottom. The version badge shows the running firmware and turns `destructive-light` whenever it is older than the newest compatible published OTA release. Controllers whose board is missing from the library still draw a compact board map via `fallbackBoardProfile()`.
- **`apps/web/src/features/admin/OfficialBoardImportDialog.tsx`** and **`BoardRemovalDialog.tsx`**: Three-step import (source, preview and select, result) that saves nothing before the last step, and a removal confirmation that first loads what depends on the board and refuses when controllers run on it.
- **`apps/web/src/components/boards/InteractiveBoardPinout.tsx`**: Interactive hardware pinout canvas (`apps/web/public/boards/*`) pairing physical J1/J3 header rails aligned to board photography with a clickable Pin Inspector, electrical capability tags, strapping/flash/PSRAM warnings, and capability filters.
- **`apps/web/src/components/automations/VisualAutomationBuilder.tsx`**: `@xyflow/react` node-graph automation canvas (lazy-split into a non-preloaded `vendor-xyflow` chunk) with left-to-right Trigger, branching True/False Condition, ALL/ANY Logic Join, Delay, Action (Switch/Device/Scene/Notification/HTTP Webhook/Variable), and End nodes, undo/redo, auto-arrange, and dry-run trace overlays.
- **`apps/web/src/components/floorplan/`**: `HomeFloorPlan.tsx` (map shell, view modes, room inspector), `SmartHomeMap.tsx` (SVG floor map + interactions), `house-layout.ts` (room/wall/doorway geometry + device placement, unit tested), `floor-visuals.tsx` (room palettes, furniture art, device glyphs), `DeviceControlPopover.tsx` (compact device controls), `RoomControlsCard.tsx` (selected-room inspector), `RoomEditorModal.tsx` — interactive 2D smart-home floor map with live device state, drag-to-arrange rooms/badges, and hardware room assignment.
- **`apps/web/src/components/controllers/ControllerSetupWizard.tsx`**: 8-step guided controller onboarding (`Dialog` + Cult UI `Onboarding` + `Progress` + `UsbFlashStagePipeline` + shared `useUsbFlashSession()`) from board selection and USB/BOOT guidance to Web Serial flashing, Wi-Fi provisioning, and live 6-digit pairing poll.
- **`apps/web/src/components/firmware/FirmwareProgressPipeline.tsx`**: `UsbFlashStagePipeline` & `OtaProgressPipeline` using ReUI `Stepper`, shadcn `Progress`, ReUI `Frame`, and `StatusAlert` (with pending OTA cancellation support).
- **`apps/web/src/lib/use-usb-flash.ts`**: React hook managing Web Serial flashing stages, chip detection, the board check, progress bytes, logs, and errors for `FirmwarePage`. While a flash is paused on a board mismatch it exposes `boardMismatch`; the page must show `UsbBoardMismatchPanel` and answer with `decideBoardMismatch()`.
- **`apps/web/src/components/firmware/UsbBoardMismatchPanel.tsx`**: Warning shown while a USB flash is paused because the connected board is not the selected one (`role="alertdialog"`): both boards side by side, a table of the checks, the recommended board with "Use this board", "Cancel flashing" as the focused default, and "Force to Flash" behind an acknowledgement checkbox.
- **`apps/web/src/lib/timezone.ts`**: `TimezoneContext`, `useEffectiveTimezone`, `formatTimestamp`, `formatShortTime`, `formatClockWithZone` backed by `REGIONAL_TIMEZONES` in `@homecoreos/shared`.


---

## 8. 2D Smart-Home Floor Map (Overview)

The Overview home preview is a single connected floor plan, not a grid of room cards.

**Geometry (`house-layout.ts`, pure and unit tested)**

1. Rooms are taken from the user's room records (`floor_x/floor_y/floor_w/floor_h`). Homes that have never been arranged (`floor_x/floor_y` still all zero) get a generated "house grammar" layout: rooms are weighted by type, packed into full-width rows and stacked, so every room ends up sharing at least one wall.
2. Near-flush edges are magnetised (8px tolerance) so hand-arranged rooms still share one continuous wall.
3. Shared edges are merged into wall runs; doorways are cut between adjacent rooms (44–64px), plus explicit doors/windows from `layout_config` and an entry door on an exterior wall.
4. Windows are added on exterior walls of habitable rooms, so the plan reads architecturally before anything is configured.
5. Device badges are placed by type-aware anchors (lights centre, TVs/AC against walls, cameras and sensors in corners, plugs in floor corners) with deterministic collision resolution, honouring saved `layoutConfig.devicePositions`.

**Visual language**

- Pastel floor per room type (`ROOM_PALETTES`), a low-opacity flooring texture overlay, and white furniture/tone art in the room's own hue.
- Walls are white with a soft grey outline; exterior walls are thicker than interior walls. Doorways render as a threshold with a light swing arc, windows as a white band with a blue glazing line.
- Room labels sit in a translucent white pill at the bottom of each room so they stay readable over furniture.
- Selected rooms keep full saturation and gain a blue focus ring; other rooms drop to 80% opacity. Selecting a room refreshes the inspector on the right.
- Live lighting only: a room glows when one of *its* lights is on; a light badge pulses, fans rotate, TVs flicker, ACs drift — all bound to real entity state, never decorative.

**Device badges**

White circular badges with type glyphs (`floor-visuals.tsx` → `DeviceGlyph`), rendered at a constant screen size while the plan zooms. Off shows a slate glyph, on shows an amber (lighting/heater), blue (screen/fan/plug/camera) or green (lock/valve) glyph plus a halo, and offline entities get a red status dot. Sensors display their live reading in a small chip.

**Interaction**

**Viewport.** Drag / wheel / pinch to pan and zoom (0.55×–3×). Wheel and trackpad gestures are accumulated and applied once per animation frame with an exponential curve, so zoom follows the gesture instead of stepping; the zoom buttons and Fit ease to their target over ~190ms. Full screen renders through a portal into `<body>` — inside the page tree a transformed ancestor (the entrance animation) becomes the containing block for `position: fixed`, which previously left the overlay offset inside the page.

**Arrange mode.** Rooms snap to a 4-unit grid with a faint 10-unit guide grid drawn over the plan, so sizes can be nudged precisely; edges within 12 units magnetise flush to neighbours. Drag a room to move it, drag the corner grip to resize, drag a badge to place it. Every change persists through the existing Rooms PATCH endpoint (`floorX/floorY/floorW/floorH` and `layoutConfig.devicePositions`). "Reset Badges" clears saved badge positions. While the page is visible the overview is re-fetched every 10s (silently, no toast on failure) and on focus/visibility change, so MQTT-driven device state reaches the map without a manual refresh.

Click a badge → compact control panel (name, room, type, ON/OFF, online, controller, power switch, fan speed 1–5, lock/valve position, sensor value). Click a room → focus + inspector.

**Previewing the map without a backend**

```bash
npm run dev:web        # then open /preview/floor-map.html
```

`apps/web/preview/` holds a dev-only harness that mounts the real `OverviewPage` against a sample home with stubbed fetch responses. Nothing in `src/` imports it, so the production page can only ever render live HomecoreOS data.
