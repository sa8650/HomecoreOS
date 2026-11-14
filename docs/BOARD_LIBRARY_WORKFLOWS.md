# Board Library workflows

Four connected workflows keep the hardware that HomecoreOS knows about, the
pins a customer assigns, and the firmware that is written to a controller in
agreement with each other:

1. [Import Official Boards](#1-import-official-boards) (Admin Console)
2. [GPIO pin selector](#2-gpio-pin-selector) (device, switch and sensor forms)
3. [USB board verification](#3-usb-board-verification) (USB flasher)
4. [Board Library cards and details](#4-board-library-cards-and-details) (User Console)

The rules live in `packages/shared` and are used by the Worker and by the web
app, so the interface never offers something the server refuses.

| Rule set | Module | Used by |
| --- | --- | --- |
| Seeed Studio XIAO reference profiles | `packages/shared/src/seeed-xiao-catalog.ts` | import, tests |
| Pin selection policy | `packages/shared/src/gpio-pin-selector.ts` | pin selector, device / switch / sensor API |
| USB board identity | `packages/shared/src/usb-board-identity.ts` | USB flasher, mismatch warning |

The shared package is marked free of side effects (`"sideEffects": false` in
`packages/shared/package.json`). The web bundle therefore loads each rule set
only with the pages that use it, and does not contain the XIAO reference
profiles, which only the Worker reads. A shared module may only declare things
at its top level; `packages/shared/test/package-side-effects.test.ts` checks it.

## 1. Import Official Boards

**Where:** Admin Console, Board Library, "Import Official Boards".
Roles: super admin and operator.

The import has three steps, and nothing is saved before the third.

1. **Source.** Seeed Studio XIAO, or Espressif DevKits.
2. **Preview and select.** The Worker reads the maker's official sources and
   lists every board with its status (New, Already in library, Removed earlier,
   Not supported), its specifications and the result of each source check.
   "Details" shows what the board is, each check with a link to its source, the
   official documentation, and the table of every pad with its GPIO. Boards are
   selected one by one, or with "Select all".
3. **Result.** One line per board: added, restored or skipped, and why.

### What is read

| Source | Read for |
| --- | --- |
| Seeed Studio wiki, "Getting Started" page of each board | The official "XIAO Pin / Chip Pin" table, and the official board photo and pinout diagram links |
| Seeed PlatformIO platform (`Seeed-Studio/platform-seeedboards`), `boards/*.json` | MCU, flash size and USB IDs of each board, and the list of all XIAO boards Seeed publishes |
| Espressif DevKits page and ESP Board Manager index | Which Espressif boards are currently listed (the boards the catalog sync already knows) |

Each built-in XIAO profile is a transcription of the official pin table. Every
preview and every import compares it again with the live sources and shows the
outcome per board:

| Check result | Meaning |
| --- | --- |
| Confirmed | The live source says the same as the profile. |
| Conflict | The live source and the profile disagree. The board can still be imported, but hidden and marked "needs verification". |
| Source not reachable | The source did not answer. The profile is used as it is, and the preview says that it could not be re-checked. |
| Not published | The maker publishes no such source for this board (Seeed has no PlatformIO manifest for the plain XIAO ESP32-S3). |
| Built-in reference | Espressif boards: the pin map is the one in the HomecoreOS verified catalog, transcribed from the board's Espressif user guide. The import checks that the board is on Espressif's DevKits page. It does not compare the pin map with the live user guide. |

If no source answers at all, the preview says that it is offline. The built-in
profiles can still be imported.

### Boards with a checked profile

A new installation has the XIAO ESP32-S3. The other five boards are added with
this import.

| Board | Chip | Flash | PSRAM | GPIO pads | Hardware revision |
| --- | --- | --- | --- | --- | --- |
| XIAO ESP32-S3 | ESP32-S3R8 | 8 MB | 8 MB | 11 | v1.0 (see the note below) |
| XIAO ESP32-C3 | ESP32-C3 | 4 MB | none | 11 | v1.3 |
| XIAO ESP32-C6 | ESP32-C6 | 4 MB | none | 11 | v1.0 |
| XIAO ESP32-C5 | ESP32-C5 | 8 MB | 8 MB | 11 | not stated by Seeed |
| XIAO ESP32-S3 Sense | ESP32-S3R8 | 8 MB | 8 MB | 11 (D11 and D12 belong to the on-board microphone and are reserved) | v1.51 |
| XIAO ESP32-S3 Plus | ESP32-S3R8 | 16 MB | 8 MB | 11, plus 9 back pads (D11 to D19) | v1.1 |

Revisions are taken from the schematic file names Seeed links on each wiki
page. Seeed's schematic for the XIAO ESP32-C5 carries no version, so that board
is stored with the revision `unspecified`: cards show no revision and the
Details view says "Not stated by the maker". No revision is ever made up.

The XIAO ESP32-S3 profile was part of HomecoreOS before this import existed and
says v1.0, while Seeed's current schematic file for that board is v1.4. It was
left as it is: an import never changes a board that is already in the library.

A XIAO board that Seeed lists but HomecoreOS has no checked profile for is
offered too, when its manifest names an ESP32 chip and a flash size. It is
imported **hidden, without pins, as "needs verification"**. A pin map is never
invented. XIAO boards with other silicon (for example nRF52840 or RP2040) are
listed as not supported and cannot be selected.

### Rules

- **A preview writes nothing.**
- **Only the selected boards are imported.** The request carries board slugs
  only. The Worker derives every profile again from its own data and the
  official sources, so pin data never comes from the browser.
- **No duplicates.** A board that is already in the library is shown as
  "Already in library" and cannot be selected. Boards are matched by slug and
  by model name without the maker prefix, case and punctuation, so
  "Seeed Studio XIAO ESP32C3" and "XIAO ESP32-C3" are the same board.
- **Existing boards are never changed** by an import: not their pins, not their
  firmware flags, not their visibility.
- **A removed board is restored**, not created again: it comes back with the
  pins and firmware settings it had when it was removed. Its visibility follows
  the publish switch.
- **"Publish verified boards right away"** decides whether imported boards are
  visible in the user Board Library at once. Boards that need verification are
  added hidden in either case.
- Every import is recorded as a run in `board_catalog_sync_runs` (the Board
  Library page shows the latest run) and in the admin activity log
  (`admin.boards_imported`).

### Removing a board

Super admins can remove a board from the admin table. The confirmation first
asks the Worker what depends on the board:

- **Controllers run on it:** removal is refused (HTTP 409). A controller reads
  its pin map through the board. Hide the board instead.
- **Accounts saved it to My Boards, or firmware releases name it as a target:**
  removal is allowed, and the dialog says what happens. The board disappears
  from My Boards until it is restored. The releases stay, without this target.

A removed board is kept in the database. The catalog sync does not bring it
back. "Import Official Boards" restores it.

### API

All routes are under `/api/admin` and need an admin session.

| Route | Roles | Purpose |
| --- | --- | --- |
| `POST /boards/import/preview` `{ provider }` | super admin, operator | Reads the sources and returns the candidates. Writes nothing. |
| `POST /boards/import` `{ provider, slugs, publish }` | super admin, operator | Imports the selected boards and returns one outcome per board. |
| `GET /boards/:id/usage` | any admin | Controllers, accounts and firmware releases that depend on a board. |
| `DELETE /boards/:id` | super admin | Removes a board that no controller runs on. |

`provider` is `seeed_xiao` or `espressif`.

### Adding a board profile

1. Add the profile to `SEEED_XIAO_OFFICIAL_BOARDS` in
   `packages/shared/src/seeed-xiao-catalog.ts`: the pad list in the order of
   the maker's pin table, `officialPinMap` (pad name to GPIO), the wiki URL,
   the PlatformIO manifest name, and the source links.
2. Take every value from the maker's documentation. Leave out what the maker
   does not state (see the revision of the XIAO ESP32-C5).
3. `packages/shared/test/seeed-xiao-catalog.test.ts` checks every profile for
   internal consistency. The import then checks it against the live sources.

## 2. GPIO pin selector

**Where:** the Add and Edit forms for devices, switches and sensors.

Below the pin field, the form shows every GPIO of the controller's board as a
grid of tiles. A tile carries the GPIO number, the name printed on the board
("D4 / SDA") or the name of whatever already uses the pin, and what the pin can
do or why it is blocked.

| State | Meaning | Can be chosen |
| --- | --- | --- |
| **Available** | Free, and able to do what the selected type needs. | Yes |
| **Used** | Assigned to another device, switch or sensor on this controller. The tile names it. | No |
| **Restricted** | A boot-strapping pin, a USB / JTAG pin, the BOOT button pin, a pin taken by an on-board part, a pin that is not broken out, or a pin that lacks what the type needs (for example no ADC). | No |
| **Dangerous** | Wired to the board's internal flash or PSRAM (using it would crash the controller), or reserved by the board's own hardware. | No |

- **Every blocked pin explains itself.** Pointing at a tile, focusing it or
  pressing it shows one sentence with the reason. Pressing a blocked tile never
  changes the selection. A number typed into the field is checked by the same
  rules, and the Save button stays disabled while the pin is not allowed.
- **Suggestions.** The best pins for the selected type are offered as one-click
  choices, best first. Free header pins come before extra solder pads, pins
  that share an on-board part come last, and the pads of other buses (I2C, SPI,
  UART) and analog-capable pins are kept free for the hardware that needs them.
  For an I2C sensor the board's own SDA pad is suggested first.
- **A new entry starts on the first suggestion** and follows it when the
  controller or the type changes, until a pin is picked by hand. The map and
  the suggestions are recalculated with every such change.
- **A saved assignment is never taken away.** A device that already sits on a
  pin that would not be offered today keeps it, marked "Current", and can still
  be renamed or moved to another room.
- **Keyboard:** the grid is one tab stop. Arrow keys, Home and End move between
  tiles, Enter or Space selects.
- Colour is never the only signal: each state also has an icon and a word.

The Worker applies the same policy (`checkPinSelectionPolicy` in
`apps/worker/src/lib/board-helpers.ts`) when a device, switch or sensor is
created or its pin is changed, and answers with the same explanation.

## 3. USB board verification

**Where:** Firmware & Updates, "USB Browser Flasher".

An ESP32 has no register that names its board. Before anything is written, the
flasher therefore reads what the connected hardware reports and compares it
with the selected board:

| Check | Read from | A difference means |
| --- | --- | --- |
| Chip | ROM loader | Firmware for another chip cannot start. Critical. |
| Flash size | Flash ID | Less than expected: the firmware may not fit or start. More: another variant. |
| PSRAM | Chip feature list | Less than expected: firmware that needs PSRAM may fail. More: another variant. |
| USB interface and vendor | USB IDs of the serial port | The board connects another way, or is another maker's board. |

Anything the browser or the chip does not report is shown as "Not reported" and
is never counted as a difference.

### When the board does not match

Flashing pauses. Nothing has been written. The warning shows:

- the connected board and the selected board, side by side, with each check;
- what differs, and what that means for this firmware;
- **the recommended board**: the Board Library profile that fits the connected
  hardware. "Use this board" switches to it when USB firmware is published for
  it. If there is none, the warning says so;
- **Cancel flashing**, the default: it has the focus, and pressing Escape or
  closing the dialog does the same;
- **Force to Flash**, which needs a ticked acknowledgement first.

After "Cancel flashing" or "Use this board" the flasher is back on its first
step and nothing has been written. The notice there names the connected board.
While the selection still differs from it, the notice names the recommended
board. Once the selected board fits, it says so and asks to connect again.

The wording follows what actually differs:

| Badge | When | After a forced flash |
| --- | --- | --- |
| Will not start | Another chip | The controller cannot start. The last step offers "Install again" and no pairing. |
| May not start | Less flash or PSRAM than the selected board has | It may not appear for setup. |
| Different board | Only the USB interface or vendor differs | It should start, but with the pin map of the selected board. |
| Different variant | More memory than selected | It should start, but with the pin map of the selected board. |

A larger-memory variant is the only difference that does not stop a flash when
no page is there to ask.

### What is recorded

Every attempt is reported to `POST /api/firmware/usb-flash-events` with the
result of the board check, which is kept with the activity entry.

- **Stopped on a mismatch:** the activity entry says that the flash stopped
  before writing, and the notification is a warning, "USB Flash Stopped", which
  says that nothing was written. It is not reported as a failed flash.
- **Forced:** recorded as a success that was forced after a board mismatch
  warning, with a warning notification. The entry shows who accepted the risk.
- The selected board is **never stored as the connected board** when the check
  found a mismatch.

### For developers

`useUsbFlashSession()` (`apps/web/src/lib/use-usb-flash.ts`) exposes
`boardMismatch` while a flash is paused. A page that starts a flash with this
hook must show `UsbBoardMismatchPanel` while `boardMismatch` is set and answer
with `decideBoardMismatch("force" | "cancel")`. Otherwise the flash waits.

## 4. Board Library cards and details

**Where:** User Console, Board Library.

Every card has the same structure, so a row of cards lines up:

1. The board drawing on top, with its source (Official, Partner or Custom) and
   the "Verified" badge.
2. Model, then maker and revision.
3. Five fields in a fixed order: Chip, Memory, Wireless, Pins, Firmware.
4. "Details" and the second action (save, remove from My Boards, or delete a
   custom board) at the bottom.

Cards in one row have the same height, in light and dark mode and on phones.

"Details" opens a dialog with two tabs:

- **Board details:** overview, chip and memory, connectivity, pins, firmware
  parameters, record (source and last check), and the official resources
  (documentation, datasheet, pinout diagram). The official photo is loaded here
  only.
- **Pinout details:** the interactive pinout with the pin inspector, and a
  table of every pad with its GPIO and functions. Boards with extra solder pads
  (XIAO ESP32-S3 Plus: D11 to D19) show them as their own group.

## Tests

| Area | File |
| --- | --- |
| XIAO profiles | `packages/shared/test/seeed-xiao-catalog.test.ts` |
| Pin policy | `packages/shared/test/gpio-pin-selector.test.ts` |
| USB identity | `packages/shared/test/usb-board-identity.test.ts` |
| Shared package stays free of import-time side effects | `packages/shared/test/package-side-effects.test.ts` |
| Import, removal, pin policy on the API, USB flash events | `apps/worker/test/board-library-workflows.test.ts` |
| Import and removal dialogs, cards, details, pin selector, mismatch warning | `apps/web/src/features/board-library-workflows.test.tsx` |
| USB flasher: pause, force, cancel, USB IDs | `apps/web/src/lib/usb-flasher.test.ts` |
| USB flow on the Firmware page | `apps/web/src/features/user/usb-board-check-flow.test.tsx` |

Run everything with `npm run test` in the repository root.

## Limits

- Two boards with the same chip, the same memory and a generic USB-UART bridge
  cannot be told apart over USB. The check then reports a match.
- The live re-check needs the maker's website. Without it the import still
  works, from the built-in profiles, and says that it could not re-check.
- The list of all XIAO boards is read through the GitHub API, which limits
  anonymous requests per address. When the limit is reached, the preview shows
  the boards with a checked profile only, and says that the list could not be
  read.
- The official board photos and pinout diagrams are linked, not copied. They
  load from the maker's server.
