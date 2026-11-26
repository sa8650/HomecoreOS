#pragma once

/**
 * Runtime glue between the persisted configuration, the role state machine
 * (role_logic.c) and the transports (Wi-Fi / MQTT / ESP-NOW).
 *
 * Rules implemented here (see packages/shared/src/board-role.ts):
 *   Controller : Wi-Fi + EMQX MQTT + ESP-NOW hosting.
 *   Node       : Keeps direct MQTT until a Worker-confirmed Controller relay
 *                is healthy, then closes it. An assignment or a search alone
 *                never drops a working cloud session. ESP-NOW is used only
 *                when the board's compile-time capability profile allows it.
 *                The universal connectivity manager owns route decisions.
 *   OTA        : a Node opens a temporary Wi-Fi/MQTT window so EMQX can hand
 *                it the update (works for standalone Nodes too).
 */

#include <stdbool.h>
#include <stdint.h>

#include "cJSON.h"
#include "esp_err.h"
#include "homecore_config.h"
#include "role_logic.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Restores the persisted role and starts the matching transport. */
esp_err_t hc_role_init(homecore_config_t *cfg);

/** Advances the role state machine; call every supervision tick (~500 ms). */
void hc_role_tick(homecore_config_t *cfg, uint32_t elapsed_ms);

/**
 * Applies the `role` block of a consolidated config snapshot. Returns true when
 * anything changed (the caller then persists + acks the revision).
 */
bool hc_role_apply_snapshot(homecore_config_t *cfg, const char *snapshot_json);

/** Adds the role/comm-mode/link-state (and Node roster) fields to a heartbeat. */
void hc_role_fill_heartbeat(const homecore_config_t *cfg, cJSON *root);

hc_role_t hc_role_current(void);
hc_node_link_t hc_role_link_state(void);
bool hc_role_is_node(void);
uint16_t hc_role_epoch(void);

/**
 * True when the device should hold an EMQX session right now. A Controller
 * always does; a Node only while it is running its standalone fallback, is
 * unassigned, or has an OTA window open. main.c uses this so a Node never keeps
 * an independent Wi-Fi/MQTT connection while its ESP-NOW link is healthy.
 */
bool hc_role_wants_mqtt(void);

/** Keeps Wi-Fi/MQTT up for an OTA download (Nodes only; no-op for Controllers). */
void hc_role_open_ota_window(uint32_t duration_ms);

/** Node: drop the fallback and re-link to the Controller now. */
void hc_role_request_relink(homecore_config_t *cfg);

/** Controller: relay a JSON instruction to a hosted Node over ESP-NOW. */
esp_err_t hc_role_relay_command_to_node(homecore_config_t *cfg, const char *node_id, const char *json);

/** Clears a consumed/revoked challenge (RAM only). */
void hc_role_consume_binding_challenge(void);

/**
 * Stores a short-lived, Worker-issued binding challenge in RAM (never NVS).
 * On a Node it is echoed in heartbeats; on a Controller it is attached to the
 * matching roster entry so the Worker can verify both sides.
 */
void hc_role_set_binding_challenge(const homecore_config_t *cfg,
                                   const char *node_id,
                                   const char *challenge_id,
                                   const char *nonce,
                                   uint32_t generation);

/** Number of Nodes currently linked to this Controller (0 when it is a Node). */
uint8_t hc_role_linked_node_count(void);
/** Every Node this Controller has heard from recently, linked or not. */
uint8_t hc_role_node_count(void);

/** Human readable comm mode for heartbeats/logs. */
const char *hc_role_comm_mode_name(const homecore_config_t *cfg);

/**
 * True (and cleared) when a role, link, or hosted-roster transition occurred
 * and the supervisor should push an immediate heartbeat to HomecoreOS instead
 * of waiting for the 60s periodic interval.
 */
bool hc_role_consume_report_request(void);

#ifdef __cplusplus
}
#endif
