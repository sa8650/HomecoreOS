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
- **Architectural 2D Floor Plan**: Homes render as top-down architectural floor plans (`HomeFloorPlan.tsx` + `RoomFurnitureSvg.tsx`) with wood planks, ceramic tiles, recessed windows, hinged swing doors, room furniture, warm amber active room lighting vs shaded idle rooms, drag-to-snap placement, and direct room hardware inspection.
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
- **`apps/web/src/features/admin/OfficialBoardImportDialog.tsx`** and **`BoardRemovalDialog.tsx`**: Three-step import (source, preview and select, result) that saves nothing before the last step, and a removal confirmation that first loads what depends on the board and refuses when controllers run on it.
- **`apps/web/src/components/boards/InteractiveBoardPinout.tsx`**: Interactive hardware pinout canvas (`apps/web/public/boards/*`) pairing physical J1/J3 header rails aligned to board photography with a clickable Pin Inspector, electrical capability tags, strapping/flash/PSRAM warnings, and capability filters.
- **`apps/web/src/components/automations/VisualAutomationBuilder.tsx`**: `@xyflow/react` node-graph automation canvas (lazy-split into a non-preloaded `vendor-xyflow` chunk) with left-to-right Trigger, branching True/False Condition, ALL/ANY Logic Join, Delay, Action (Switch/Device/Scene/Notification/HTTP Webhook/Variable), and End nodes, undo/redo, auto-arrange, and dry-run trace overlays.
- **`apps/web/src/components/floorplan/`**: `HomeFloorPlan.tsx`, `RoomFurnitureSvg.tsx`, `RoomEditorModal.tsx` — interactive 2D architectural floor plan with live light glow, room furniture, doors/windows, snap-grid dragging, and hardware room assignment.
- **`apps/web/src/components/controllers/ControllerSetupWizard.tsx`**: 8-step guided controller onboarding (`Dialog` + Cult UI `Onboarding` + `Progress` + `UsbFlashStagePipeline` + shared `useUsbFlashSession()`) from board selection and USB/BOOT guidance to Web Serial flashing, Wi-Fi provisioning, and live 6-digit pairing poll.
- **`apps/web/src/components/firmware/FirmwareProgressPipeline.tsx`**: `UsbFlashStagePipeline` & `OtaProgressPipeline` using ReUI `Stepper`, shadcn `Progress`, ReUI `Frame`, and `StatusAlert` (with pending OTA cancellation support).
- **`apps/web/src/lib/use-usb-flash.ts`**: React hook managing Web Serial flashing stages, chip detection, the board check, progress bytes, logs, and errors for `FirmwarePage`. While a flash is paused on a board mismatch it exposes `boardMismatch`; the page must show `UsbBoardMismatchPanel` and answer with `decideBoardMismatch()`.
- **`apps/web/src/components/firmware/UsbBoardMismatchPanel.tsx`**: Warning shown while a USB flash is paused because the connected board is not the selected one (`role="alertdialog"`): both boards side by side, a table of the checks, the recommended board with "Use this board", "Cancel flashing" as the focused default, and "Force to Flash" behind an acknowledgement checkbox.
- **`apps/web/src/lib/timezone.ts`**: `TimezoneContext`, `useEffectiveTimezone`, `formatTimestamp`, `formatShortTime`, `formatClockWithZone` backed by `REGIONAL_TIMEZONES` in `@homecoreos/shared`.
