# Unified board repair and recovery (in progress)

## Architecture

The shared recovery engine (`packages/shared/src/recovery.ts`) diagnoses telemetry, proposes explicit actions, and verifies the result. The browser controller (`apps/web/src/lib/recovery-engine.ts`) runs the same eight steps over Wi-Fi, BLE, or USB adapters. The Worker records recovery sessions and events; migration `0006_recovery_sessions.sql` must be applied before enabling these endpoints.

The existing ControllerSetupModal has **not yet been migrated** to the new controller. These modules are infrastructure, not a completed user-facing rollout.

## Device protocol

Protocol version 1 accepts newline-delimited `HC PING`, `HC HELLO`, `HC STATUS`, and `HC REPAIR {json}`. Repair actions are `wifi`, `mqtt`, `config`, `restart`, `pair`, and `factory_reset`. Firmware gates identity-changing operations on recovery mode/physical confirmation. Re-pair requires a six-digit single-use recovery code. Restart acknowledges before restarting.

- Wi-Fi: GET `/api/recovery` returns discovery and status; POST accepts `{ "command": "HC ..." }` at the setup portal, normally `http://192.168.4.1`.
- BLE: encrypted command action `hc HC ...`; status may arrive as `{chunk:{i,n,d}}` notifications (150-byte chunks, maximum eight).
- USB: Web Serial, 115200 baud, one JSON response per line. Boot log lines are ignored.

Browser support, secure-context rules, local-network access and mixed-content restrictions still apply. A failed portal fetch must be explained, not interpreted as a healthy board.

## Safety and verification

Credentials stay in the current browser flow and must never be written to session diagnostics or logs. Unknown telemetry is not a passing check. A browser that sees a failed verification must not display a successful server report. A server outage can produce a local report, not proof of backend health. Sessions expire after 900 seconds. Cancelling releases the transport and abandons the session where possible.

## Validation

Targeted browser tests:

```
npm --workspace=apps/web run test -- src/components/recovery-flow.test.ts src/components/recovery-transport.test.ts
npm --workspace=packages/shared run test
npm --workspace=apps/worker run test
npm run typecheck
npm run lint
node database/verify/verify-schema.mjs
```

Host firmware logic:

```
gcc -Wall -Wextra -Werror -std=c11 firmware/test/test_recovery_logic.c firmware/main/recovery_logic.c -o /tmp/recovery-test
/tmp/recovery-test
```

ESP-IDF compilation and real Wi-Fi/BLE/USB hardware validation remain necessary. Host tests do not validate FreeRTOS task lifecycle, UART ownership, GATT encryption or actual network reconnection.

## Remaining rollout work

- Move existing modal recovery paths onto the controller, preserving setup behavior and recovery labels.
- Wire the browser server API adapter and board capabilities into that UI.
- Validate serial/flash port handoff and cleanup on real devices.
- Confirm firmware build and all recovery transports on supported boards before deployment.
