# HomecoreOS console repair — what was found and what was changed

Everything here was reproduced against the real API source, a real PostgreSQL 16,
a real PostgREST 12 and a real browser, with the console served by Vite and the
API pointed at the local database.

---

## The empty pages

Three separate faults lined up so that every page fell back to the sign-in
screen:

1. **The session cookie was always marked `Secure`.** A browser refuses a
   `Secure` cookie on a plain-HTTP origin, so the session was silently thrown
   away on every request. The flag is now set only when the request really is
   HTTPS — Cloudflare Pages always is, so production keeps it.

2. **The cross-origin check was too strict.** It compared the browser's
   `Origin` header only with the host inside the request URL. Behind a proxy or
   a dev server that URL carries the internal host, so legitimate same-origin
   writes were refused with *Cross-origin request rejected*. The request host,
   the forwarded host and the `Host` header are all accepted now.

3. **The API's own RPC calls lost their arguments.** `JSON.stringify` drops
   `undefined` values, so a stored procedure was called with fewer parameters
   than it declares and PostgREST answered *function not found*. Absent
   arguments are sent as `null` now.

## The pages that rendered but looked empty

Cards were being painted at `opacity: 0` and never becoming visible.

- The fade-in observer ran once when a page opened, but a page only fills in
  **after its data arrives**, so the cards did not exist yet and were never
  observed. A mutation observer now watches for them being added.
- The observer used the window as its root, but the console scrolls inside
  `.content`, not the window. Anything below the fold therefore stayed
  invisible for good. The observer now watches the element that scrolls.

## The grey sidebar

The sidebar was never painted grey by the design system — the dark tokens are
correct and were verified by measurement. The grey was the **browser's own
scrollbar**: the sidebar scrolls, and nothing had styled the scrollbar, so the
browser drew it in its default mid grey, right inside the dark panel.

Scrollbars are now styled to match the theme in both light and dark.

A **collapsed sidebar** was added at the same time, because the narrow
rail had no defined appearance at all. It keeps every label available to a
screen reader, shows the name of a section on hover, and remembers its state.

## The live connection

Every page opened its **own** server-sent-events connection — five on the
overview alone — and all of them were torn down on every change of page.

There is now **one** connection for the whole console, shared by every
subscriber and kept alive across navigation.

## The firmware that never reached the customer

The published release did reach the customer, but only once the faults above
were fixed: the customer's firmware request was failing with the same broken
session, so the console showed an empty list.

The whole path is now verified end to end:

- the owner uploads a release and publishes it
- the release appears in the customer's firmware page, with its size, chip and
  checksum
- the owner assigns the release to a controller
- the customer sees the update as *queued* against their controller
- the customer can install the same release over USB from the browser

The *Assign* button used to open with nothing selected, which left the send
button dead. Every compatible controller is now offered from the start.

## Speed

| | before | after |
| --- | --- | --- |
| main script | 383 kB | 78 kB |
| main script, compressed | 100 kB | 26 kB |
| requests for all 25 pages | many more | 23 |
| live connections | up to 5 per page | 1 for the whole console |
| time until a page shows its data | — | about 90 ms on average |

Pages are now fetched when they are first opened, identical requests are
answered once, and a short-lived cache keeps the console from asking again
for the same thing. Any change on the server, and any write from the console,
clears the cache, so nothing stale is shown.

## Other faults fixed

- The live-update stream used a variable before it was ready and answered
  *Internal error* on every event; the keepalive timer also leaked.
- The deploy dialog opened with no controller selected, so its send button was
  disabled and did nothing.
- In the collapsed rail the account chip was clipped and its menu was
  unreachable.
- The empty states were 268 pixels tall for three lines of text.
- The database check rebuilt the schema in the **same** database the console
  was using, which deleted every account. It now runs in a scratch database
  and refuses to touch a database that holds accounts.
- Three unused exports were removed, and a helper that was written twice was
  moved into the shared place.

## What was left alone

- The simplified unsigned firmware architecture. No signing keys or signature
  checks were introduced.
- Row level security stays on, and no policy refers to a table that does not
  exist.
- The storage, database and broker integrations are unchanged.
- No number anywhere is invented. Where the provider does not report a value,
  the console says so.

## Still to be confirmed on real hardware

- A controller downloading and installing an update over the air.
- A controller reporting its installed version after the update.
- The USB installer writing an image to a real board.
- The broker accepting a real controller and reporting its usage.
