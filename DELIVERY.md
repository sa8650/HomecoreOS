# HomecoreOS — Console Repair, Functionality and Performance

**Date:** 9 November 2026
**Scope:** Owner Console and User Console — inspection, repair, completion, dark mode, performance, cleanup and verification.

---

## 1. What HomecoreOS offers

HomecoreOS is a multi-home smart-home platform. One account can run many separate
homes, each with its own rooms, controllers, devices, sensors and automations,
and each isolated from the others. A platform owner runs the whole service
from a separate console.

### The two consoles

**User Console (13 pages)**

| Page | What it does |
| --- | --- |
| Overview | The dashboard. Live controller, device, sensor and area counts, area tiles, the device grid with on/off control, controller list, sensor readings, automation summary and recent activity. |
| Rooms & areas | Create, rename, icon and delete the areas of the home; see the devices and sensors in each. |
| Devices | Every switch and light bound to a controller and an exclusive pin. Add, edit and remove them; search and filter. |
| Switches | The same devices in a control-focused view for switching on and off. |
| Sensors | Temperature, humidity, motion and other readings, with the value, unit, area and age of the reading. |
| Controllers | The paired ESP32 controllers, their connection state, firmware version, pin map and configuration. |
| Board library | The catalogue of verified Espressif board pin maps, searchable by model, chip family and category. |
| Add a controller | The setup wizard: get a pairing code, enter it on the board, and the controller registers itself with its own credentials. |
| Automation | Rules with triggers and actions, run in the cloud, on the controller, or both. |
| Firmware & updates | Install a published release over USB in the browser, or update a paired controller over the air; the controller list and the update history. |
| Activity | The audit trail of what happened in this home. |
| Staff | Staff accounts for the home, with their roles. |
| Settings | Home profile, connection information, account usage, data export, session list, password change and recovery codes. |

**Owner Console (12 pages)**

| Page | What it does |
| --- | --- |
| Platform Overview | Accounts, controllers, switches and rooms across the service; the health of the broker, the API and the database; platform metrics and recent activity. |
| Setup status | A live checklist of the one-time setup, each item verified against the real service. |
| Customers | Every home on the service, with its details, and the ability to open one. |
| Staff & access | Platform staff accounts and their permissions. |
| Firmware management | Upload a release, check it, publish it to a channel, assign it to controllers, retire it, and watch the update history. |
| Board library | The catalogue of verified board pin maps that owners maintain. |
| EMQX management | The broker deployment, its provisioning strategy and its usage. |
| Usage & monitoring | Traffic, session minutes, connections and thresholds, with provider-reported values kept apart from estimates. |
| Platform settings | The settings the server actually enforces: announcements, registration, limits and thresholds. |
| Integrations | The state of every required secret and the R2 binding, and where to set them. |
| Authentication & security | Password hashing, account and session counts, registration control, lockouts and the sign-in limits — all enforced on the server. |
| Audit logs | Every administrative action, with who did it and when. |

---

## 2. What was repaired and completed

### The pages that showed nothing

Three faults were behind every blank page, and all three are fixed:

- The session cookie was always marked secure, so a browser refused it on a
  plain connection and quietly dropped the session on every request.
- The check that refuses cross-origin writes compared the browser's origin
  only with the address inside the request, which behind any proxy names the
  wrong host. Legitimate writes were rejected.
- The server's own procedure calls were losing their arguments, so they were
  never found.

### The pages that loaded but stayed blank

Cards were painted invisible and never appeared. The fade-in effect ran before
the page had its data, and it watched the window while the console scrolls
inside its own panel. Both are fixed, so every card now appears.

### The grey sidebar

The sidebar was never painted grey by the design. The grey was the browser's
own scrollbar, which nothing had styled, sitting inside the dark panel. It is
now styled to match the theme.

A collapsed sidebar was added, with the section names shown on hover, and the
account button kept reachable. Dark mode was checked in both consoles, in both
states, and every label was measured against its background.

### The firmware that never reached the customer

The published release did reach the customer; the customer's request was
failing with the broken session, so the list came back empty. The whole path
is now verified from end to end: the owner uploads and publishes, the release
appears in the customer's firmware page with its size, chip and checksum, the
owner assigns it to a controller, and the customer sees the update waiting
against their controller.

### The button that did nothing

The window for sending a release to controllers opened with nothing chosen,
so its send button was dead. Every compatible controller is now offered from
the start, and the button says how many it will reach.

### Messages that said "Internal error"

A clash — two areas with the same name, a pin used twice, a device type that
does not exist — came back as "Internal error". Each of these now says what
is wrong in plain words, and a name is required and trimmed before it is
saved.

### The console that lagged

| | before | after |
| --- | --- | --- |
| The script the browser loads first | 383 kB | 78 kB |
| The same, compressed | 100 kB | 26 kB |
| Live connections | up to 5 on one page | 1 for the whole console |
| Requests across all 25 pages | many more | 23 |
| Time until a page shows its data | — | about 90 ms on average |

Every page is now fetched only when it is first opened. Identical requests
share one answer. Any change on the server, and any write from the console,
clears what was held, so nothing out of date is ever shown.

### Cleanup

Three exports that nothing used were removed, a helper that had been written
twice was moved to one place, and the database check no longer runs against
the database the console is using — it now works in a scratch database of its
own and refuses to touch a database that holds accounts.

---

## 3. The agenda, and what each part provides

| Part | What it provides |
| --- | --- |
| **Homes and areas** | Each home is a separate workspace with its own rooms, so devices can be found and controlled by where they are. |
| **Controllers** | An ESP32 board joins a home with a six-digit code and receives its own broker credentials, so it is trusted without ever sharing an account. |
| **Devices and sensors** | Switches, lights and sensors are bound to a controller and to one exclusive pin, so the wiring is never ambiguous. |
| **Automations** | Rules that turn a reading, a time or a device state into an action, running in the cloud, on the board, or both. |
| **Firmware** | One verified release per version, published to a channel, installed over USB or over the air, with the progress reported by the board itself. |
| **People** | Staff accounts, roles and permissions, so a home can be shared without handing over the keys. |
| **Oversight** | The owner sees every home, every account and every administrative action, and can close the platform down if needed. |
| **Trust** | Accounts, passwords, sessions and events all live in the database; nothing about the service is invented for display. |

---

## 4. The overall goal

A reliable, unified smart-home automation platform for managing homes,
devices, controllers and automations.

Everything in HomecoreOS exists to serve that: one place that knows every
home, every controller and every rule; one place that can say what is
happening and why; and one delivery path that takes a build from the
repository to a board in a customer's home.

The delivery flow is unchanged and is confirmed working:

**GitHub builds the firmware → the owner uploads one ZIP → HomecoreOS stores
and publishes it → the customer installs it over USB or updates the ESP32
over the air.**

Firmware is protected by a SHA-256 digest. There is no signing step.

---

## 5. What remains, and what needs real hardware

### Still to be confirmed on real hardware

- A controller downloading an update over the air and reporting each stage.
- A controller reporting the version it is now running after the update.
- The USB installer writing an image to a real board.
- A board reporting its pins, its sensors and its measurements.
- The broker accepting a real controller and reporting its usage.
- A controller losing its connection and coming back, and a rule still running
  on the board while the connection is down.

### Known limits, stated plainly

- The provider does not report monthly traffic, session minutes or rule
  counts through its interface. The owner console says **Unavailable** rather
  than inventing a number, and offers a place to record a verified figure.
- The firmware storage in this test environment is a private file store
  standing in for the bucket binding. In production the bucket binding is
  attached and the owner console reports it as verified.
- The console's own pages were checked against the real server and a real
  browser. Anything that needs a board or a broker was not exercised.

### How it was checked

| Check | Result |
| --- | --- |
| Database schema, run in a scratch database | 37 passed, 0 failed |
| Release package | 24 checks passed |
| Owner Console upload path | 21 checks passed |
| Firmware SHA-256 | 7 checks passed |
| Firmware headers | 20 checks passed |
| TypeScript typecheck | clean |
| Production build | clean |
| Every page in both consoles, in a browser | 25 of 25 rendered, no console errors, no failed requests, nothing invisible |
| Dark mode, both consoles, expanded and collapsed | no grey, every label readable |
| Controls that change data | creating an area, adding a device, saving the home name, creating a rule and deleting an area all work |

Row-level security is on for all 49 tables. No credential, broker key or
bucket secret is ever sent to the browser. Nothing was committed or pushed;
all of the work is in the working tree for review.
