#pragma once

/**
 * Universal connectivity manager (hardware-independent).
 *
 * Three state families are kept strictly separate:
 *   - hardware capability       (what this board can do, from its profile)
 *   - binding state             (unpaired/pairing/assigned/verified/revoked)
 *   - connection state          (ESP-NOW link + cloud route)
 *
 * An assignment is never proof of a working connection. A working ESP-NOW
 * link is never treated as a working cloud route. A Node keeps its MQTT
 * session until a Controller relay is established AND confirmed.
 */
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    HC_BINDING_UNPAIRED = 0,
    HC_BINDING_PAIRING = 1,
    HC_BINDING_ASSIGNED = 2,
    HC_BINDING_VERIFIED = 3,
    HC_BINDING_REVOKED = 4,
} hc_binding_state_t;

typedef enum {
    HC_ESPNOW_UNAVAILABLE = 0,
    HC_ESPNOW_SEARCHING = 1,
    HC_ESPNOW_LINKED = 2,
    HC_ESPNOW_LOST = 3,
    HC_ESPNOW_RECONNECTING = 4,
} hc_espnow_state_t;

typedef enum {
    HC_CLOUD_UNAVAILABLE = 0,
    HC_CLOUD_CONNECTING = 1,
    HC_CLOUD_DIRECT_NODE_MQTT = 2,
    HC_CLOUD_CONTROLLER_MQTT = 3,
} hc_cloud_route_t;

typedef struct {
    bool has_wifi;
    bool has_mqtt;
    bool has_espnow;
    bool can_controller;
    bool can_node;
    uint16_t espnow_mtu_bytes;
    uint16_t espnow_peer_limit;
    uint16_t max_controller_nodes;
    uint32_t keepalive_ms;
    uint32_t link_timeout_ms;
    uint32_t recovery_window_ms;
    uint32_t discovery_interval_ms;
} hc_connectivity_caps_t;

typedef struct {
    hc_binding_state_t binding;
    /** Worker-issued generation. Higher generations always win, even offline. */
    uint32_t generation;
    /** Generation seen in the newest authenticated Controller frame. */
    uint32_t peer_generation;
    bool node_mqtt_healthy;
    bool controller_mqtt_healthy;
    /** Bidirectional ESP-NOW ACK at the current generation. */
    bool espnow_ack_verified;
    /** Controller roster contains this Node at the current generation. */
    bool in_roster;
    bool telemetry_fresh;
    bool local_active;
    bool assigned;
    bool is_controller;
    bool route_confirmation_received;
} hc_connectivity_input_t;

typedef struct {
    hc_espnow_state_t espnow;
    hc_cloud_route_t cloud;
    bool keep_node_mqtt;
    bool start_espnow;
    bool host_espnow;
    bool report_state;
    bool route_changed;
} hc_connectivity_output_t;

typedef struct {
    hc_connectivity_caps_t caps;
    hc_connectivity_output_t output;
    uint32_t lost_ms;
    uint32_t discovery_ms;
    uint32_t generation;
    bool handoff_confirmed;
    hc_cloud_route_t confirmed_route;
} hc_connectivity_state_t;

#define HC_DEDUPE_RING_SIZE 32u

typedef struct {
    uint32_t generation;
    char id[48];
} hc_dedupe_entry_t;

typedef struct {
    hc_dedupe_entry_t entries[HC_DEDUPE_RING_SIZE];
    uint8_t head;
    uint8_t count;
} hc_command_dedupe_t;

const char *hc_binding_state_name(hc_binding_state_t state);
const char *hc_espnow_state_name(hc_espnow_state_t state);
const char *hc_cloud_route_name(hc_cloud_route_t route);

/** Unknown or missing capabilities disable every network feature. */
void hc_connectivity_init(hc_connectivity_state_t *state, const hc_connectivity_caps_t *caps);

/** One supervision tick. `elapsed_ms` must be the tick length. */
hc_connectivity_output_t hc_connectivity_step(
    hc_connectivity_state_t *state,
    const hc_connectivity_input_t *in,
    uint32_t elapsed_ms
);

/**
 * Offline epoch authority. Returns true only when a message belongs to the
 * current binding generation. Equal legacy generation 0 is accepted for
 * backward compatibility with pre-binding firmware.
 */
bool hc_connectivity_accept_generation(
    hc_connectivity_state_t *state,
    uint32_t message_generation,
    const char *message_binding_id,
    const char *expected_binding_id
);

/** Worker confirms that the alternative cloud route is authoritative. */
void hc_connectivity_confirm_route(
    hc_connectivity_state_t *state, uint32_t generation, hc_cloud_route_t route
);

/** Pure route selection, mirroring packages/shared/src/board-capabilities.ts. */
hc_cloud_route_t hc_select_cloud_route(
    bool telemetry_fresh,
    bool node_mqtt_healthy,
    bool controller_mqtt_healthy,
    bool espnow_linked,
    bool in_roster
);

/** In-memory, bounded command dedupe. Nothing transient is written to flash. */
bool hc_command_dedupe_accept(hc_command_dedupe_t *ring, uint32_t generation, const char *id);
void hc_command_dedupe_reset(hc_command_dedupe_t *ring);

#ifdef __cplusplus
}
#endif
