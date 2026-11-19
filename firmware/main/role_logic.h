#pragma once

/**
 * Unified Controller / Node role state machine (hardware independent).
 *
 * One firmware image runs either role. This module decides, for every tick,
 * which transport a device should keep alive, and it owns the rules that the
 * Worker and the web console apply too (see packages/shared/src/device-role.ts):
 *
 *   Controller : Wi-Fi + EMQX MQTT + ESP-NOW peer hosting.
 *   Node       : ESP-NOW link to its assigned Controller, no MQTT session.
 *                On Controller loss it retries, then falls back to Wi-Fi/MQTT
 *                as a *standalone Node* — it is never promoted to Controller.
 *
 * Keeping this logic free of ESP-IDF lets the host test suite exercise every
 * transition (firmware/test/test_role_logic.c).
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    HC_ROLE_CONTROLLER = 0,
    HC_ROLE_NODE = 1,
} hc_role_t;

typedef enum {
    HC_NODE_UNASSIGNED = 0,   /* no Controller assigned yet */
    HC_NODE_LINKED = 1,       /* ESP-NOW link healthy */
    HC_NODE_CONTROLLER_LOST = 2, /* heartbeat lost, still retrying the Controller */
    HC_NODE_STANDALONE = 3,   /* Wi-Fi/MQTT fallback engaged */
} hc_node_link_t;

/* Actions a tick asks the firmware to (re)configure. */
#define HC_ROLE_ACT_NONE          (0u)
#define HC_ROLE_ACT_KEEP_WIFI     (1u << 0) /* Wi-Fi STA must stay up (ESP-NOW channel) */
#define HC_ROLE_ACT_START_MQTT    (1u << 1) /* open the EMQX session */
#define HC_ROLE_ACT_STOP_MQTT     (1u << 2) /* drop the session again */
#define HC_ROLE_ACT_ESPNOW_HOST   (1u << 3) /* Controller: serve Nodes */
#define HC_ROLE_ACT_ESPNOW_SEEK   (1u << 4) /* Node: heartbeat its Controller */
#define HC_ROLE_ACT_REPORT_STATE  (1u << 5) /* push role/link state to the cloud */
#define HC_ROLE_ACT_OTA_WINDOW    (1u << 6) /* keep Wi-Fi/MQTT for an OTA download */

/* Timing mirrors packages/shared/src/device-role.ts and the firmware Kconfig. */
#ifndef HC_ROLE_LINK_TIMEOUT_MS
#define HC_ROLE_LINK_TIMEOUT_MS 10000u
#endif
#ifndef HC_ROLE_RECONNECT_WINDOW_MS
#define HC_ROLE_RECONNECT_WINDOW_MS 45000u
#endif
#ifndef HC_ROLE_CONTROLLER_PROBE_MS
#define HC_ROLE_CONTROLLER_PROBE_MS 15000u
#endif
#ifndef HC_ROLE_NODE_STALE_MS
#define HC_ROLE_NODE_STALE_MS 20000u
#endif

typedef struct {
    hc_role_t role;
    bool has_wifi;         /* board has a Wi-Fi radio */
    bool has_espnow;       /* board supports ESP-NOW (needs Wi-Fi) */
    bool assigned;         /* Node: a Controller is assigned */
    bool controller_online; /* Node: assigned Controller heartbeat is fresh */
    bool mqtt_connected;
    bool ota_window;       /* an OTA update needs Wi-Fi/MQTT right now */
    uint32_t ms_since_controller; /* since the last Controller heartbeat */
} hc_role_input_t;

typedef struct {
    hc_node_link_t link;
    uint32_t lost_ms;          /* how long the Controller has been unreachable */
    uint32_t standalone_ms;    /* how long the Wi-Fi/MQTT fallback has run */
    uint32_t probe_ms;         /* controller-return probing cadence */
    uint16_t epoch;            /* bumped on every link transition (command dedupe) */
    bool standalone;
    bool ota_window_open;
} hc_role_state_t;

void hc_role_state_init(hc_role_state_t *state, hc_role_t role);

/** Resets the fallback bookkeeping (keeps the epoch, so stale commands stay stale). */
void hc_role_state_clear_fallback(hc_role_state_t *state);

/**
 * Opens a new command window by moving to the next epoch (wraps 65535 -> 1,
 * never 0). Called when a Controller boots or is promoted: its transmit
 * sequence lives in RAM and restarts, but a Node persists how far it got, so the
 * epoch — not the sequence — has to signal the new window.
 */
void hc_role_bump_epoch(hc_role_state_t *state);

/**
 * Advances a Node one tick and returns the action bitmask for the firmware.
 * `elapsed_ms` is the tick length.
 */
uint32_t hc_role_node_step(
    hc_role_state_t *state,
    const hc_role_input_t *in,
    uint32_t elapsed_ms
);

/** Actions a Controller keeps alive; also bumps the epoch when it changes role. */
uint32_t hc_role_controller_step(hc_role_state_t *state, const hc_role_input_t *in);

/** True when a Node has not reported for longer than HC_ROLE_NODE_STALE_MS. */
bool hc_role_node_is_stale(uint32_t now_ms, uint32_t last_seen_ms);

/**
 * Role changes are user-initiated only. A Controller may not be demoted while it
 * still hosts Nodes unless the caller explicitly acknowledged the fallback.
 */
bool hc_role_can_change(
    hc_role_t from,
    hc_role_t to,
    uint16_t attached_nodes,
    bool acknowledge_attached_nodes,
    bool board_supports_controller
);

/**
 * Command dedupe across link transitions. A command is only executed when it is
 * strictly newer than the last executed one — a replayed packet after a fallback
 * transition must not run twice. Returns true when the caller should execute.
 */
bool hc_role_accept_command(
    uint16_t epoch,
    uint32_t seq,
    uint16_t *last_epoch,
    uint32_t *last_seq
);

/** Label used in heartbeats/logs. */
const char *hc_role_name(hc_role_t role);
const char *hc_node_link_name(hc_node_link_t link);

/** Parses "controller"/"node" from config without ever changing the identity. */
hc_role_t hc_role_from_string(const char *value);

#ifdef __cplusplus
}
#endif
