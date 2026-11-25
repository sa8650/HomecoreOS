#include "role_logic.h"

#include <string.h>

static bool str_eq_ci(const char *a, const char *b) {
    if (!a || !b) return false;
    while (*a && *b) {
        char ca = *a;
        char cb = *b;
        if (ca >= 'A' && ca <= 'Z') ca = (char)(ca - 'A' + 'a');
        if (cb >= 'A' && cb <= 'Z') cb = (char)(cb - 'A' + 'a');
        if (ca != cb) return false;
        a++;
        b++;
    }
    return *a == '\0' && *b == '\0';
}

const char *hc_role_name(hc_role_t role) {
    return role == HC_ROLE_NODE ? "node" : "controller";
}

const char *hc_node_link_name(hc_node_link_t link) {
    switch (link) {
        case HC_NODE_LINKED:
            return "linked";
        case HC_NODE_CONTROLLER_LOST:
            return "controller_lost";
        case HC_NODE_STANDALONE:
            return "standalone";
        case HC_NODE_UNASSIGNED:
        default:
            return "unassigned";
    }
}

hc_role_t hc_role_from_string(const char *value) {
    if (value && str_eq_ci(value, "node")) return HC_ROLE_NODE;
    return HC_ROLE_CONTROLLER;
}

void hc_role_state_init(hc_role_state_t *state, hc_role_t role) {
    if (!state) return;
    memset(state, 0, sizeof(*state));
    state->link = role == HC_ROLE_NODE ? HC_NODE_UNASSIGNED : HC_NODE_UNASSIGNED;
    state->epoch = 1;
}

void hc_role_state_clear_fallback(hc_role_state_t *state) {
    if (!state) return;
    state->standalone = false;
    state->standalone_ms = 0;
    state->lost_ms = 0;
    state->probe_ms = 0;
    state->ota_window_open = false;
}

void hc_role_bump_epoch(hc_role_state_t *state) {
    if (!state) return;
    state->epoch = (uint16_t)(state->epoch + 1u);
    if (state->epoch == 0) state->epoch = 1;
}

static void enter_link(hc_role_state_t *state, hc_node_link_t next) {
    if (state->link != next) {
        state->link = next;
        /* Every link transition opens a new command window: anything queued on
           the old transport must not be executed on the new one. */
        hc_role_bump_epoch(state);
    }
}

uint32_t hc_role_node_step(
    hc_role_state_t *state,
    const hc_role_input_t *in,
    uint32_t elapsed_ms
) {
    if (!state || !in) return HC_ROLE_ACT_NONE;

    uint32_t actions = HC_ROLE_ACT_NONE;
    if (in->role != HC_ROLE_NODE) {
        return hc_role_controller_step(state, in);
    }

    /* A Node without a Wi-Fi radio can only ever be unreachable locally; keep it
       honest instead of pretending an ESP-NOW link exists. */
    if (!in->assigned || !in->has_wifi) {
        enter_link(state, HC_NODE_UNASSIGNED);
        state->standalone = false;
        state->standalone_ms = 0;
        state->lost_ms = 0;
        actions |= HC_ROLE_ACT_KEEP_WIFI | HC_ROLE_ACT_START_MQTT | HC_ROLE_ACT_REPORT_STATE;
        return actions;
    }

    if (!in->has_espnow) {
        /* No ESP-NOW on this board: the Node is always a Wi-Fi/MQTT Node. It is
           still a Node — never promoted, never a Controller. */
        enter_link(state, HC_NODE_STANDALONE);
        state->standalone = true;
        state->standalone_ms += elapsed_ms;
        actions |= HC_ROLE_ACT_KEEP_WIFI | HC_ROLE_ACT_START_MQTT | HC_ROLE_ACT_REPORT_STATE;
        if (in->ota_window) actions |= HC_ROLE_ACT_OTA_WINDOW;
        return actions;
    }

    const bool controller_fresh = in->controller_online &&
        in->ms_since_controller <= HC_ROLE_LINK_TIMEOUT_MS;

    if (controller_fresh) {
        const bool recovered = state->standalone ||
            state->link == HC_NODE_STANDALONE ||
            state->link == HC_NODE_CONTROLLER_LOST;
        enter_link(state, HC_NODE_LINKED);
        state->lost_ms = 0;
        state->standalone_ms = 0;
        state->probe_ms = 0;
        state->standalone = false;
        /* Normal operation: ESP-NOW only. The Wi-Fi link stays up because the
           radio is shared, but no independent MQTT session is maintained. */
        actions |= HC_ROLE_ACT_KEEP_WIFI | HC_ROLE_ACT_ESPNOW_SEEK | HC_ROLE_ACT_STOP_MQTT;
        if (recovered) actions |= HC_ROLE_ACT_REPORT_STATE;
        if (in->ota_window) {
            /* OTA is authorised over EMQX, so the session is re-opened just for
               the download and closed again afterwards. */
            state->ota_window_open = true;
            actions |= HC_ROLE_ACT_START_MQTT | HC_ROLE_ACT_OTA_WINDOW;
        } else if (state->ota_window_open) {
            state->ota_window_open = false;
        }
        return actions;
    }

    /* Controller unreachable. */
    const bool just_lost = state->link != HC_NODE_CONTROLLER_LOST &&
        state->link != HC_NODE_STANDALONE;
    if (just_lost) {
        enter_link(state, HC_NODE_CONTROLLER_LOST);
        state->lost_ms = 0;
        actions |= HC_ROLE_ACT_REPORT_STATE;
    }

    state->lost_ms += elapsed_ms;

    if (state->lost_ms < HC_ROLE_RECONNECT_WINDOW_MS) {
        enter_link(state, HC_NODE_CONTROLLER_LOST);
        /* Retry the assigned Controller first; keep the MQTT session closed so a
           flapping link does not open a competing command channel. */
        actions |= HC_ROLE_ACT_KEEP_WIFI | HC_ROLE_ACT_ESPNOW_SEEK | HC_ROLE_ACT_STOP_MQTT;
        return actions;
    }

    /* Reconnection budget exhausted: fall back to Wi-Fi/EMQX as a standalone
       Node. The device keeps its Node role and its identity. */
    const bool entering_standalone = !state->standalone;
    enter_link(state, HC_NODE_STANDALONE);
    state->standalone = true;
    state->standalone_ms += elapsed_ms;
    state->probe_ms += elapsed_ms;

    actions |= HC_ROLE_ACT_KEEP_WIFI | HC_ROLE_ACT_START_MQTT;
    if (in->ota_window) actions |= HC_ROLE_ACT_OTA_WINDOW;

    /* While standalone the Node keeps probing for its Controller to return. */
    if (state->probe_ms >= HC_ROLE_CONTROLLER_PROBE_MS) {
        state->probe_ms = 0;
        actions |= HC_ROLE_ACT_ESPNOW_SEEK;
    }
    if (entering_standalone) {
        actions |= HC_ROLE_ACT_ESPNOW_SEEK | HC_ROLE_ACT_REPORT_STATE;
    }
    return actions;
}

uint32_t hc_role_controller_step(hc_role_state_t *state, const hc_role_input_t *in) {
    (void)in;
    if (!state) return HC_ROLE_ACT_NONE;
    enter_link(state, HC_NODE_UNASSIGNED);
    state->standalone = false;
    state->lost_ms = 0;
    state->standalone_ms = 0;
    /* A Controller always talks to the cloud and hosts its Nodes. */
    return HC_ROLE_ACT_KEEP_WIFI | HC_ROLE_ACT_START_MQTT | HC_ROLE_ACT_ESPNOW_HOST;
}

bool hc_role_node_is_stale(uint32_t now_ms, uint32_t last_seen_ms) {
    if (now_ms < last_seen_ms) return false;
    return (now_ms - last_seen_ms) > HC_ROLE_NODE_STALE_MS;
}

bool hc_role_validate_keepalive_target(
    const char *self_controller_id,
    const char *node_id,
    const char *target_controller_id
) {
    if (!node_id || node_id[0] == '\0') return false;
    if (self_controller_id && self_controller_id[0] != '\0') {
        if (strcmp(node_id, self_controller_id) == 0) return false;
        if (target_controller_id && target_controller_id[0] != '\0' &&
            strcmp(target_controller_id, self_controller_id) != 0) {
            return false;
        }
    }
    return true;
}

bool hc_role_validate_controller_ack(
    uint16_t expected_epoch,
    uint32_t last_tx_seq,
    uint32_t last_ack_seq,
    uint16_t rx_epoch,
    uint32_t rx_seq,
    const char *expected_controller_id,
    const char *rx_controller_id
) {
    if (expected_epoch == 0 || last_tx_seq == 0) return false;
    if (rx_epoch != expected_epoch) return false;
    if (rx_seq == 0 || rx_seq > last_tx_seq || rx_seq < last_ack_seq) return false;
    if (expected_controller_id && expected_controller_id[0] != '\0' &&
        rx_controller_id && rx_controller_id[0] != '\0' &&
        strcmp(expected_controller_id, rx_controller_id) != 0) {
        return false;
    }
    return true;
}

bool hc_role_can_change(
    hc_role_t from,
    hc_role_t to,
    uint16_t attached_nodes,
    bool acknowledge_attached_nodes,
    bool board_supports_controller
) {
    if (from == to) return true;
    if (to == HC_ROLE_CONTROLLER && !board_supports_controller) return false;
    if (from == HC_ROLE_CONTROLLER && to == HC_ROLE_NODE) {
        if (attached_nodes > 0 && !acknowledge_attached_nodes) return false;
    }
    return true;
}

bool hc_role_accept_command(
    uint16_t epoch,
    uint32_t seq,
    uint16_t *last_epoch,
    uint32_t *last_seq
) {
    if (!last_epoch || !last_seq) return false;
    if (epoch > *last_epoch) {
        *last_epoch = epoch;
        *last_seq = seq;
        return true;
    }
    if (epoch < *last_epoch) return false; /* stale packet from a previous link */
    if (seq <= *last_seq) return false;    /* duplicate or replayed */
    *last_seq = seq;
    return true;
}
