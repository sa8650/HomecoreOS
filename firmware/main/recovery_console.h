#pragma once

/**
 * HomecoreOS recovery console — transport plumbing around recovery_logic.c.
 *
 * The USB console and the Wi-Fi setup portal both answer the same JSON protocol
 * (`recovery_logic.h`), and both feed the browser's unified Repair & Recovery
 * engine. Keeping the ESP-IDF glue here (rather than duplicating it per
 * transport) is what makes "one engine, three transports" true on the device
 * side as well.
 *
 *   1. snapshot — main.c publishes what the board knows each supervision tick.
 *   2. USB      — a UART/USB-Serial-JTAG task reads `HC …` lines and writes one
 *                 JSON line back. Read-only by default: repairs also require the
 *                 board to be in recovery mode, so a stray terminal cannot
 *                 rewrite Wi-Fi on a working controller.
 *   3. WiFi     — the local portal exposes the same JSON for the browser that is
 *                 joined to HomecoreOS-Setup-XXXX.
 */

#include <stdbool.h>
#include <stddef.h>

#include "homecore_config.h"
#include "recovery_logic.h"

/** Called from `app_main` once NVS, IO and Wi-Fi are initialised. */
void hc_recovery_console_start(homecore_config_t *cfg);

/**
 * Publishes the board's live state for discovery/diagnostics responses.
 *
 * The caller (main.c) owns this on purpose: the snapshot mixes Wi-Fi/MQTT
 * state, the provisioning mode and the last heartbeat outcome, all of which the
 * supervision loop already samples every 500 ms. Publishing from there keeps
 * one source of truth and adds no new task or polling to normal operation.
 */
void hc_recovery_publish_snapshot(const hc_recovery_snapshot_t *snap);

/** Current snapshot copy (zeroed when nothing was published yet). */
void hc_recovery_get_snapshot(hc_recovery_snapshot_t *out);

/**
 * Handles one protocol line and writes the JSON response.
 * Returns the response length (0 when the line should be ignored), or -1 when
 * the caller's buffer is too small.
 */
int hc_recovery_handle_line(const char *line, char *out, size_t out_cap);

/** True while a serial/USB recovery console command is being applied. */
bool hc_recovery_console_busy(void);

/** True when the last repair asked for a clean restart. */
bool hc_recovery_restart_pending(void);

/**
 * Reboots the controller if a restart repair was accepted. Called by each
 * transport *after* the ack has been written, so the browser always sees the
 * response before the board goes away.
 */
void hc_recovery_apply_pending_restart(void);

/** Response builder used by the Wi-Fi portal's `/api/recovery` endpoint. */
int hc_recovery_handle_json(const char *line, char *out, size_t out_cap);
