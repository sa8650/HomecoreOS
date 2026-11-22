# Unified board repair and recovery

## Architecture

The shared recovery engine (`packages/shared/src/recovery.ts`) diagnoses telemetry, proposes explicit actions, and verifies the result. The browser controller (`apps/web/src/lib/recovery-engine.ts`) runs the same eight steps over Wi-Fi, BLE, or USB adapters. The Worker records recovery sessions and events; migration `0006_recovery_sessions.sql` must be applied before enabling these endpoints.

The Repair / Recover Board chooser exposes Wi-Fi, BLE and USB. All three mount `UnifiedRecoveryPanel`, which uses `createRecoveryController` and `recoveryServerApi`; only its transport factory changes. Setup Board and Flash Board retain their separate workflows. Recovery never imports esptool or writes a firmware image.

## Operator guide

1. Open Add Board → Repair / Recover Board and choose a transport.
2. No board dropdown is needed. Choose Discover BLE Board, Connect to Board (Wi-Fi) or Connect USB Board. The connected device is matched automatically to an installed controller in your account. Restore trashed boards from My Boards first; a new installation belongs in Setup Board.
3. Power the board, hold BOOT / Recovery for three seconds, and follow the selected method's connection instructions. On USB, use a data cable and close serial monitors. Do not hold BOOT during a reset into the ROM bootloader: this workflow communicates with running HomecoreOS firmware.
4. Discovery reads identity before diagnosis. The reported UID suffix must match exactly one account controller (or the controller whose details you opened). Unknown, missing and ambiguous identities stop the flow instead of choosing the first account record. Protocol v1 reports a suffix, not a cryptographically authenticated full USB identity. Treat physical access as trusted; a matching suffix is not an ownership credential.
5. Diagnostics run automatically after identification. Ordinary credential-free repairs and verification continue automatically. The main screen shows a compact progress pipeline; individual checks, unknown results and technical logs are available under Diagnostic details. Nothing is changed during discovery or diagnosis.
6. Provide Wi-Fi credentials only if requested. Account re-pairing is separate: it requires a live server session, physical recovery mode and explicit consent before requesting a single-use authorization. Ordinary MQTT failure does not automatically rotate credentials.
7. If new credentials are needed, review the proposed repairs, enter Wi-Fi details and choose Save & Recover. Account re-pairing is a separate, explicitly labelled Authorize & Recover action. Then wait for verification. A sent command is not success; read the final status, next action and expandable verification details.
8. Closing or backing out cancels the flow and releases the local transport. Reconnect & retry starts with new identification and diagnosis. No mutation is retransmitted automatically after an ambiguous timeout.

Recovery history can be loaded on demand under Previous recovery sessions in the chooser. The discovery screens reuse the original BLE and Wi-Fi artwork; USB recovery uses the same UsbFlashIllustration component as the separate flashing workflow, without invoking a flasher. Administrators can load the same account-scoped, read-only summary in Customer Monitoring. Neither history view polls or sends hardware commands.

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

- Validate serial/flash port handoff and cleanup on real devices.
- Confirm firmware build and all recovery transports on supported boards before deployment.

## API reference

All customer routes require an authenticated owner/administrator session and enforce account scope:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/recovery/sessions` | Start/resume a 15-minute session for `boardInstanceId` and `transport` |
| GET | `/api/recovery/sessions/:id` | Session, events and server diagnostics |
| POST | `/api/recovery/sessions/:id/diagnostics` | Structured checks, stage and plan inputs; never credentials |
| POST | `/api/recovery/sessions/:id/complete` | Action outcomes; server independently verifies health |
| POST | `/api/recovery/sessions/:id/abandon` | Cancel with a sanitized reason |
| GET | `/api/recovery/history` | Paginated account history, optionally filtered by board |
| GET | `/api/admin/accounts/:id/recovery-history` | Admin-session-only summary, latest 20 records; no mutations |

401/403/404/409/410 responses do not permit fallback to local repairs. A network/server outage can permit ordinary local diagnosis/repair, but cannot authorize re-pairing and is explicitly reported as local-only. A disconnected browser cannot store a server report until connectivity returns.

## Hardware and browser compatibility

- Wi-Fi requires a powered board with a Wi-Fi radio. The browser cannot scan or select its AP; users choose HomecoreOS-Setup-XXXX in OS settings. HTTPS-to-HTTP portal access can be blocked by mixed-content/private-network policies: permit local network access if available, otherwise use USB/BLE. It is not guaranteed to work in every browser.
- BLE requires the board's BLE radio, supported encrypted HomecoreOS provisioning service, a secure context and Web Bluetooth (typically Chrome/Edge desktop or Android, not Safari/iOS). Board Library capability flags can disable unsupported methods; actual discovery verifies firmware capabilities.
- USB requires Web Serial in a secure desktop Chromium browser and access to the running firmware's UART0 serial console at 115200 baud. USB-UART bridge boards are the initial target. Native USB CDC/JTAG-only paths are **not claimed verified** by this implementation; a visible port is not proof it carries UART0. ESP8266 firmware and ROM download mode do not implement this recovery protocol.
- Firmware without the recovery protocol cannot be repaired by guessing commands. Follow the separate, explicit firmware workflow when diagnostics say an update is required.
- Hardware revision comes from the installed Board Library profile; missing profile/telemetry fields stay unknown.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Wrong Wi-Fi password | Supply the correct 2.4 GHz credentials; pairing remains intact |
| Wi-Fi connected, API/MQTT unreachable | Check router, internet, endpoint and broker availability; do not re-pair automatically |
| Different board detected | Disconnect and select the intended physical controller; no repair is issued |
| USB busy or no answer | Close serial monitors, use a data cable, verify the UART path, boot normal HomecoreOS firmware, then enter recovery |
| BLE drops | Move closer, reconnect and re-diagnose; do not resend an uncertain mutation blindly |
| Portal fetch blocked | Check OS Wi-Fi selection and local-network permissions, or choose BLE/USB |
| Server refuses authorization / session expired | Sign in with an authorized account and start a fresh session; local repair cannot bypass refusal |
| Unknown subscriptions, sensors or sync | Firmware/server does not expose that fact; unknown is not a passing verification |

## Firmware implementation notes

The BLE relay strips the lowercase `hc ` envelope before passing `HC ...` to the console parser. The browser installs its encrypted status listener only after authentication. Repairs on the controller acquire a cross-task critical-section guard to reject concurrent local transport mutations. Snapshots, logs and task scheduling still need on-device stress testing. No hardware or ESP-IDF test results should be inferred from mocked browser tests or host C tests.

Sensitive console operations require the **current** provisioning mode to be recovery. A persisted `physical_confirmed` setup flag is not sufficient to authorize a later re-pair or factory reset.

## Setup reliability changes (migration 0007)

Apply `database/migrations/0007_pairing_identity_reuse.sql` before deploying the
updated Worker. No migration is applied to a hosted database by the code change.

- Pairing can resolve a never-paired provisional setup slot to an installed board
  with the same hardware UID or identity in the **same account**. Resolution is
  serialized per account. The installed record remains in place, preserving its
  name, home/room, IO configuration, devices and linked Nodes. Slots with existing
  identity, inventory or assignments are not silently merged. Cross-account
  identities and ambiguous matches are rejected; no ownership-transfer step was
  added.
- `POST /api/board-instances/pairing-status` accepts `{pairingCode}` in the request
  body and returns the resolved controller only for the signed-in account. Setup
  polls this endpoint so merging a provisional slot does not break completion.
  Codes are not placed in URLs. Broker credential provisioning now leaves
  `mqtt_connected` false until actual telemetry arrives; setup no longer accepts
  the generic `online` status as MQTT proof.
- The shared recovery controller receives the website origin and supplies it in
  Wi-Fi, pairing and config repair commands. Backend-unreachable plans include
  config re-sync; the firmware saves that supplied endpoint before fetching
  config. No extra Wi-Fi prompt or firmware update is needed for this repair.
- Local form POSTs read the complete bounded request body rather than assuming one
  TCP read contains the form. The unconditional 1.8-second portal shutdown timer
  is removed. After a form save or pairing claim, the supervisor waits for backend
  health and MQTT (unless the linked Node role intentionally does not use MQTT)
  before scheduling AP/BLE teardown. Merely entering recovery on a healthy board
  does not authorize immediate teardown. The existing recovery timeout remains.

### Remaining work and validation limits

This is a reliability increment, **not completion of the full expanded setup and
repair specification**. The local form still uses Save & Apply, not a verified
Save & Restart sequence. The website Wi-Fi recovery path still uses direct local
API access; a dedicated website-generated recovery-code handoff to the local form
is not implemented. Expanded ESP-NOW/AP/portal/firmware-validity/OTA-functionality
checks and a restart-and-reconnect stage across all transports remain work to do.
Do not infer OTA functionality from a reported firmware version. Recovery does not
flash or update firmware automatically. Flash with USB has not been modified.

Validation for this increment: 249 shared tests, 44 targeted browser recovery/UI
and transport tests, 12 targeted Worker integration tests, strict host C recovery
and provisioning tests, TypeScript checks, lint and schema snapshot verification.
These tests are simulated/host-side. ESP-IDF target compilation, real EMQX, USB,
BLE, AP behavior and the physical BOOT gesture have **not** been tested on boards.
