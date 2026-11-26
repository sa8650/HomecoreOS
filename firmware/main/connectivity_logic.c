#include "connectivity_logic.h"

#include <string.h>

const char *hc_binding_state_name(hc_binding_state_t state) {
    switch (state) {
        case HC_BINDING_UNPAIRED: return "unpaired";
        case HC_BINDING_PAIRING: return "pairing";
        case HC_BINDING_ASSIGNED: return "assigned";
        case HC_BINDING_VERIFIED: return "verified";
        case HC_BINDING_REVOKED: return "revoked";
        default: return "unpaired";
    }
}

const char *hc_espnow_state_name(hc_espnow_state_t state) {
    switch (state) {
        case HC_ESPNOW_UNAVAILABLE: return "unavailable";
        case HC_ESPNOW_SEARCHING: return "searching";
        case HC_ESPNOW_LINKED: return "linked";
        case HC_ESPNOW_LOST: return "lost";
        case HC_ESPNOW_RECONNECTING: return "reconnecting";
        default: return "unavailable";
    }
}

const char *hc_cloud_route_name(hc_cloud_route_t route) {
    switch (route) {
        case HC_CLOUD_UNAVAILABLE: return "unavailable";
        case HC_CLOUD_CONNECTING: return "connecting";
        case HC_CLOUD_DIRECT_NODE_MQTT: return "direct_node_mqtt";
        case HC_CLOUD_CONTROLLER_MQTT: return "controller_mqtt";
        default: return "unavailable";
    }
}

void hc_connectivity_init(hc_connectivity_state_t *state, const hc_connectivity_caps_t *caps) {
    if (!state) return;
    memset(state, 0, sizeof(*state));
    if (caps) state->caps = *caps;
    /* A board with no verified capability profile is an offline local-only
     * device. No radio or cloud feature can be inferred from its name. */
    state->output.espnow = HC_ESPNOW_UNAVAILABLE;
    state->output.cloud = HC_CLOUD_UNAVAILABLE;
}

hc_cloud_route_t hc_select_cloud_route(
    bool telemetry_fresh,
    bool node_mqtt_healthy,
    bool controller_mqtt_healthy,
    bool espnow_linked,
    bool in_roster
) {
    if (!telemetry_fresh) return HC_CLOUD_UNAVAILABLE;
    if (espnow_linked && in_roster && controller_mqtt_healthy) return HC_CLOUD_CONTROLLER_MQTT;
    if (node_mqtt_healthy) return HC_CLOUD_DIRECT_NODE_MQTT;
    return HC_CLOUD_UNAVAILABLE;
}

hc_connectivity_output_t hc_connectivity_step(
    hc_connectivity_state_t *state,
    const hc_connectivity_input_t *in,
    uint32_t elapsed_ms
) {
    hc_connectivity_output_t out;
    memset(&out, 0, sizeof(out));
    out.espnow = HC_ESPNOW_UNAVAILABLE;
    out.cloud = HC_CLOUD_UNAVAILABLE;
    if (!state || !in) return out;

    const hc_connectivity_caps_t *c = &state->caps;
    state->generation = in->generation;

    if (in->is_controller) {
        /* A Controller keeps Wi-Fi/MQTT and ESP-NOW hosting independent. Local
         * I/O keeps working even when both are down (handled by io_manager). */
        out.host_espnow = c->has_espnow && c->can_controller;
        out.espnow = out.host_espnow ? HC_ESPNOW_LINKED : HC_ESPNOW_UNAVAILABLE;
        out.cloud = c->has_mqtt && in->controller_mqtt_healthy
            ? HC_CLOUD_CONTROLLER_MQTT
            : HC_CLOUD_UNAVAILABLE;
        out.keep_node_mqtt = false;
        state->output = out;
        return out;
    }

    if (!c->can_node) {
        /* ESP32-H2 and other non-network targets stay local-only. */
        state->output = out;
        return out;
    }

    /* Direct MQTT is the default route until a verified Controller relay is
     * actually established. Assignment or searching alone never closes it. */
    const bool can_relay = c->has_espnow && in->assigned &&
        (in->binding == HC_BINDING_VERIFIED || in->binding == HC_BINDING_ASSIGNED) &&
        in->espnow_ack_verified && in->peer_generation == in->generation;
    const bool verified_peer = can_relay && in->binding == HC_BINDING_VERIFIED;
    const bool link_valid = verified_peer && in->in_roster;

    if (can_relay) {
        out.espnow = HC_ESPNOW_LINKED;
        state->lost_ms = 0;
        state->discovery_ms = 0;
    } else if (!c->has_espnow || !in->assigned || in->binding == HC_BINDING_UNPAIRED ||
               in->binding == HC_BINDING_REVOKED) {
        out.espnow = HC_ESPNOW_UNAVAILABLE;
        state->lost_ms = 0;
    } else if (state->output.espnow == HC_ESPNOW_LINKED ||
               state->output.espnow == HC_ESPNOW_LOST) {
        out.espnow = HC_ESPNOW_LOST;
        state->lost_ms += elapsed_ms;
        if (state->lost_ms >= c->recovery_window_ms) {
            out.espnow = HC_ESPNOW_SEARCHING;
            state->discovery_ms += elapsed_ms;
        }
    } else {
        out.espnow = state->output.espnow == HC_ESPNOW_SEARCHING
            ? HC_ESPNOW_SEARCHING
            : HC_ESPNOW_RECONNECTING;
        state->discovery_ms += elapsed_ms;
    }

    out.start_espnow = c->has_espnow && in->assigned &&
        out.espnow != HC_ESPNOW_UNAVAILABLE;

    const hc_cloud_route_t selected = hc_select_cloud_route(
        in->telemetry_fresh,
        c->has_mqtt && in->node_mqtt_healthy,
        c->has_mqtt && in->controller_mqtt_healthy,
        link_valid,
        link_valid
    );

    /* Make-before-break: only a confirmed Controller relay may take over. */
    if (link_valid && in->controller_mqtt_healthy &&
        selected == HC_CLOUD_CONTROLLER_MQTT) {
        out.cloud = HC_CLOUD_CONTROLLER_MQTT;
    } else if (c->has_mqtt && in->node_mqtt_healthy) {
        out.cloud = HC_CLOUD_DIRECT_NODE_MQTT;
    } else if (selected == HC_CLOUD_CONNECTING && c->has_mqtt) {
        out.cloud = HC_CLOUD_CONNECTING;
    } else {
        out.cloud = HC_CLOUD_UNAVAILABLE;
    }

    out.keep_node_mqtt = c->has_mqtt &&
        !(out.cloud == HC_CLOUD_CONTROLLER_MQTT && state->handoff_confirmed &&
            state->confirmed_route == HC_CLOUD_CONTROLLER_MQTT);
    out.route_changed = out.cloud != state->output.cloud ||
        out.espnow != state->output.espnow;
    out.report_state = out.route_changed || in->local_active;

    state->output = out;
    return out;
}

bool hc_connectivity_accept_generation(
    hc_connectivity_state_t *state,
    uint32_t message_generation,
    const char *message_binding_id,
    const char *expected_binding_id
) {
    if (!state) return false;
    uint32_t current = state->generation;
    if (message_generation > current) return false; /* never accept from the future */
    if (message_generation < current) return false; /* stale generation */
    if (expected_binding_id && expected_binding_id[0]) {
        if (!message_binding_id || strcmp(message_binding_id, expected_binding_id) != 0) return false;
    }
    return true;
}

void hc_connectivity_confirm_route(
    hc_connectivity_state_t *state, uint32_t generation, hc_cloud_route_t route
) {
    if (!state || generation != state->generation) return;
    state->handoff_confirmed = true;
    state->confirmed_route = route;
}

bool hc_command_dedupe_accept(hc_command_dedupe_t *ring, uint32_t generation, const char *id) {
    if (!ring || !id || id[0] == '\0') return false;
    for (uint8_t i = 0; i < ring->count; ++i) {
        uint8_t idx = (uint8_t)((ring->head + HC_DEDUPE_RING_SIZE - 1u - i) % HC_DEDUPE_RING_SIZE);
        if (ring->entries[idx].generation == generation &&
            strcmp(ring->entries[idx].id, id) == 0) {
            return false;
        }
    }
    uint8_t slot = ring->head;
    ring->entries[slot].generation = generation;
    size_t len = strlen(id);
    if (len >= sizeof(ring->entries[slot].id)) len = sizeof(ring->entries[slot].id) - 1u;
    memcpy(ring->entries[slot].id, id, len);
    ring->entries[slot].id[len] = '\0';
    ring->head = (uint8_t)((ring->head + 1u) % HC_DEDUPE_RING_SIZE);
    if (ring->count < HC_DEDUPE_RING_SIZE) ring->count++;
    return true;
}

void hc_command_dedupe_reset(hc_command_dedupe_t *ring) {
    if (!ring) return;
    memset(ring, 0, sizeof(*ring));
}
