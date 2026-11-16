# Smart Home Planner

The Smart Home Planner lets a customer describe their home in plain language and
answers one question: **which controller hardware does HomecoreOS have for it,
and can it be installed today?**

It is a deterministic rule engine. It reads the boards and firmware releases
administrators already manage in the Board Library and Firmware Management
pages, and nothing else. It does not guess, and it does not contain hardware
facts of its own.

- Customer page: `/planner` in the User Console ("Smart Home Planner").
- API: `/api/planner/*` on the Worker.
- Rules: `packages/shared/src/planner/`.

## What the customer does

1. **Your home**: floors, rooms, and (optionally) where controllers can be installed.
2. **Devices**: how many lights, fans, switches, curtains, pumps, appliances and
   sensors each room has, and which of them are switched separately.
3. **Installation**: Wi-Fi at the controller location, Ethernet, environment,
   cable length, sensor wiring, whether more than one controller and external
   relay modules are acceptable, and room to grow.
4. **Review**: a summary with anything that is still missing, then "Analyze my home".

The result shows a verdict, up to four ranked hardware options, a readiness
checklist, the controller-by-controller pin assignments on a drawing of the
board, the extra parts that are needed, warnings, and every board that was
checked. Owners and administrators can save up to 30 plans per account.

## Result states

| State | Meaning |
| --- | --- |
| **Ready** | A published, verified board carries every connection, and a published firmware release with a validated USB factory image exists for that board. Relay needs and account limits are satisfied. |
| **Partially ready** | A board carries every connection, but something is missing before it can be installed: the board is unpublished or unverified, no firmware is published or validated for it, the USB image is missing, relay modules were ruled out, or an account limit is exceeded. |
| **Not supported** | No board can carry the plan as specified. Examples: no Wi-Fi at the controller location, wired Ethernet required, wireless or RS-485 sensors, more connections than one controller holds when only one is allowed. The two closest boards are shown with what rules them out. |
| **Incomplete** | An essential answer is missing (no rooms, no devices, Wi-Fi not answered) or the plan exceeds 600 connections. The catalog is not read, and the remaining steps are reported as skipped. |

A board is only ever described as fitting when it is not "not supported". That
decision is made in one place (`evaluateFit` in `engine.ts`), and the verdict,
the option reasons, the readiness checklist, the board table and the
"boards that fit" count all read it.

## Where the facts come from

| Fact | Source |
| --- | --- |
| Boards, pins, pin capabilities and restrictions, Wi-Fi/BLE, publication and verification status | `board_catalog`, `custom_boards` (the customer's own), `board_gpio_definitions` |
| Firmware releases, target boards, status, USB/OTA files and their validation | `firmware_releases`, `firmware_files` |
| Whether the Board Library is enabled, account limits | `platform_settings` |
| Controllers and devices the account already has | `controllers`, `devices` (counts only) |
| I/O items one controller can hold (32) | `PLANNER_FIRMWARE_MAX_IO_ITEMS`, mirrors `HOMECORE_MAX_IO_ITEMS` in `firmware/main/homecore_config.h` |

Not on record anywhere in HomecoreOS, and therefore reported as unknown rather
than estimated:

- **Stock.** "Published in catalog" is not "in stock".
- **Price.** No cost estimate is shown.
- **Ethernet hardware.** A plan that requires wired Ethernet is not supported.
- **Power ratings.** A warning asks the installer to size the supply.
- **On-board relays.** Every switched load is planned on an external relay module.
- **Which device types a firmware release can drive.** Releases record the
  boards they run on, not their drivers. The planner maps each connection to an
  existing HomecoreOS device or sensor type and checks pins and the I/O limit;
  it cannot confirm driver support per device type.

Only the columns the engine needs are read. Firmware storage keys, file names
and checksums never enter the planner.

Boards that are not published in the Board Library are still evaluated, so the
planner can say honestly that hardware exists but is not available yet. For
those boards customers see the name, chip and status only: no pins, slug,
documentation link or drawing.

## The engine

`packages/shared/src/planner/`, one module per concern:

| Module | Concern |
| --- | --- |
| `requirements.ts` | Validates and normalizes the answers, expands devices into connections |
| `board-capability.ts` | What each board's pins can do; which pins are held back and why |
| `allocation.ts` | Assigns connections to controllers and pins; keeps rooms together |
| `firmware.ts` | Matches releases to a board; USB and OTA availability |
| `availability.ts` | Catalog status, stock, cost, account limits |
| `ranking.ts` | Orders the candidates and explains the differences |
| `warnings.ts` | Warnings with meaning, cause, impact, resolution and severity |
| `external-hardware.ts` | Relay modules, sensors, supplies and enclosures the plan needs |
| `catalog-revision.ts` | Fingerprint of the records a result was computed from |
| `engine.ts` | Runs the stages in order and assembles the result |

The engine is pure: the same requirements and the same records always give the
same result. Analyzing 11 boards takes a few milliseconds.

### Stages

`requirements`, `load_boards`, `load_firmware`, `board_capability`,
`allocation`, `firmware_compatibility`, `availability`, `ranking`, `warnings`.

The progress display is driven by these stages and nothing else. The Worker
streams an event when a stage starts and when it finishes, with the duration it
measured and a one-line finding. The page shows no timer-based or simulated
progress. A step that is skipped does not move the bar, and a stage that fails
reports a fixed public message; the internal error is logged, not sent.

## API

All routes require a customer session. Saving, changing and deleting plans
require the owner or administrator role; viewers can analyze, list and open.

| Route | Purpose |
| --- | --- |
| `POST /api/planner/analyze` | Analyze `{ requirements }`. With `Accept: application/x-ndjson` the response is a stream of `{type:"stage"}` lines followed by `{type:"result"}` or `{type:"error"}`. |
| `GET /api/planner/plans` | Saved plans of the account, with `status: "current" \| "outdated"`. |
| `POST /api/planner/plans` | Save `{ name, requirements }`. The result is always computed by the Worker; a result sent by the client is ignored. |
| `GET /api/planner/plans/:id` | Open a plan. Re-analyzes it first when its stored result is outdated. |
| `PATCH /api/planner/plans/:id` | Rename, or replace the requirements (which re-analyzes). |
| `DELETE /api/planner/plans/:id` | Soft-delete. |

## Saved results and invalidation

A saved plan stores the validated requirements, the result, and a fingerprint
(`catalog_revision`) of every board and firmware record the result was computed
from, together with the account limits and the engine version.

A stored result is reused only while that fingerprint still matches the live
records. Publishing or hiding a board, verifying a pin map, uploading,
publishing or deprecating firmware, or changing a limit all change the
fingerprint. No hook in the admin code is needed, so a change made by any code
path is noticed.

- In the list, an outdated plan shows "Needs re-check" and no old verdict.
- Opening it analyzes it again and says so.
- The web client drops its cached planner responses after board, firmware,
  device, controller and admin mutations.

When a rule change alters results or their shape, increase
`PLANNER_ENGINE_VERSION` in `types.ts`. Stored results from an older version are
then recomputed on first use.

## Limits

| Limit | Value |
| --- | --- |
| Floors / rooms / controller locations | 12 / 40 / 20 |
| Devices per category per room | 64 |
| Connections in one plan | 600 |
| Saved plans per account | 30 |
| Request body | 200,000 characters |

A stored result is roughly 140 KB for a 60-connection home and can reach about
700 KB near the connection limit.

## Deployment

Apply `database/migrations/0013_smart_home_planner.sql`. It adds one table,
`planner_plans`, and follows the privilege pattern of the existing migrations.
No environment variables, bindings or seed data are needed.

## Tests

| Layer | File |
| --- | --- |
| Rules | `packages/shared/test/planner.test.ts` |
| API, permissions, tenant isolation, invalidation | `apps/worker/test/smart-home-planner.test.ts` |
| Wizard state, progress and stream client | `apps/web/src/components/planner/planner-logic.test.ts` |
| Page behavior | `apps/web/src/features/user/SmartHomePlannerPage.test.tsx` |

The rule tests build their boards from the real `VERIFIED_BOARD_CATALOG` seeds,
and the page tests run the real engine behind a mock Worker, so a rule change
shows up in every layer.
