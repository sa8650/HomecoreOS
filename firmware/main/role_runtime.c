#include "role_runtime.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "espnow_link.h"
#include "connectivity_logic.h"
#include "transport.h"
#include "hc_board_capabilities.h"
#include "hc_board_capabilities_selected.h"

static const char *TAG = "hc_role";

#define HC_ESPNOW_KEEPALIVE_MS HC_BOARD_KEEPALIVE_MS

_Static_assert(HC_BOARD_MAX_NODES <= HC_ESPNOW_MAX_NODES,
               "board profile exceeds the ESP-NOW peer table");
#define HC_OTA_WINDOW_MS 180000u

typedef struct {
    char id[44];
    char mac[20];
    int8_t rssi;
    uint8_t channel;
    uint32_t last_seq;
    uint32_t last_seen_ms;
} hc_role_node_t;

static homecore_config_t *s_cfg = NULL;
static hc_role_state_t s_state;
static bool s_initialized = false;
static bool s_espnow_started = false;
static bool s_report_requested = false;

static uint32_t s_now_ms = 0;
static uint32_t s_ms_since_controller = HC_ROLE_LINK_TIMEOUT_MS;
static bool s_controller_fresh = false;
static bool s_ever_linked_in_session = false;
static bool s_seek_probe_unanswered = false;
static uint32_t s_keepalive_ms = 0;
static uint32_t s_ota_window_ms = 0;

static uint16_t s_remote_epoch = 0;     /* last command window seen from the Controller */
static uint32_t s_cmd_seq = 0;          /* last command sequence executed (dedupe) */
static uint32_t s_tx_seq = 0;           /* outbound keepalive / relay sequence */
static uint32_t s_last_ack_rx_seq = 0;  /* last verified Controller ACK sequence */
static hc_connectivity_state_t s_conn;
static hc_transport_t s_transports[HC_MAX_TRANSPORTS];
static size_t s_transport_count = 0;
static hc_command_dedupe_t s_command_dedupe;
static char s_peer_binding_id[40] = {0};
static uint32_t s_peer_binding_generation = 0;
static bool s_controller_cloud_healthy = false;

/* Controller-side authorized peers from the Worker snapshot. The Worker, not
 * the radio, is the binding authority; radio traffic is validated against it. */
typedef struct {
    char id[44];
    char binding_id[40];
    uint32_t generation;
    char challenge_id[40];
    char challenge_nonce[65];
} hc_peer_binding_t;
/* RAM-only Worker challenge. Binding credentials/epochs persist; a one-time
 * challenge deliberately does not survive a reboot. */
static char s_challenge_id[40] = {0};
static char s_challenge_nonce[65] = {0};
static uint32_t s_challenge_generation = 0;
static hc_peer_binding_t s_peer_bindings[HC_BOARD_MAX_NODES > 0 ? HC_BOARD_MAX_NODES : 1];
static int8_t s_peer_rssi = 0;          /* RSSI of last verified frame from Controller */
static uint8_t s_peer_channel = 0;      /* channel of last verified frame from Controller */

static hc_role_node_t s_nodes[HC_ESPNOW_MAX_NODES];
static uint8_t s_node_count = 0;

static uint32_t now_ms(void) {
    return (uint32_t)(esp_timer_get_time() / 1000ULL);
}

bool hc_role_consume_report_request(void) {
    bool req = s_report_requested;
    s_report_requested = false;
    return req;
}

const char *hc_role_comm_mode_name(const homecore_config_t *cfg) {
    if (!cfg) return "offline";
    // A linked Node is reachable over ESP-NOW even when its STA is between
    // router associations, so the link wins over the Wi-Fi state.
    if (cfg->board_role == HC_ROLE_NODE && s_state.link == HC_NODE_LINKED) {
        return "espnow";
    }
    if (!hc_wifi_is_connected()) return "offline";
    if (!cfg->paired) return "offline";
    return "wifi_mqtt";
}

hc_role_t hc_role_current(void) {
    return s_cfg ? (hc_role_t)s_cfg->board_role : HC_ROLE_CONTROLLER;
}

bool hc_role_is_node(void) {
    return hc_role_current() == HC_ROLE_NODE;
}

bool hc_role_wants_mqtt(void) {
    if (!s_cfg || s_cfg->board_role != HC_ROLE_NODE) return true;
    if (!s_initialized) return true;
    /* The connectivity manager owns this decision. A working MQTT session is
     * never closed just because a Controller is assigned or being searched;
     * it is closed only after a verified Controller relay has been confirmed. */
    return s_conn.output.keep_node_mqtt || s_state.ota_window_open;
}

hc_node_link_t hc_role_link_state(void) {
    if (!s_cfg || s_cfg->board_role != HC_ROLE_NODE) return HC_NODE_UNASSIGNED;
    return s_state.link;
}

uint16_t hc_role_epoch(void) {
    return s_state.epoch;
}

uint8_t hc_role_node_count(void) {
    if (!s_cfg || s_cfg->board_role != HC_ROLE_CONTROLLER) return 0;
    return s_node_count;
}

uint8_t hc_role_linked_node_count(void) {
    if (!s_cfg || s_cfg->board_role != HC_ROLE_CONTROLLER) return 0;
    uint8_t count = 0;
    for (uint8_t i = 0; i < s_node_count; ++i) {
        if (s_nodes[i].id[0] && !hc_role_node_is_stale(s_now_ms, s_nodes[i].last_seen_ms)) {
            count++;
        }
    }
    return count;
}

/** Worker-issued peer authorization, independent of radio send success. */
static bool peer_binding_valid(const char *node_id, const char *binding_id, uint32_t generation) {
    if (!node_id || node_id[0] == '\0') return false;
    for (size_t i = 0; i < sizeof(s_peer_bindings) / sizeof(s_peer_bindings[0]); ++i) {
        const hc_peer_binding_t *pb = &s_peer_bindings[i];
        if (pb->id[0] == '\0' || strcmp(pb->id, node_id) != 0) continue;
        if (pb->generation != generation) return false;
        if (pb->binding_id[0] && (!binding_id || strcmp(pb->binding_id, binding_id) != 0)) return false;
        return true;
    }
    /* Legacy pre-binding firmware: no Worker-authorized peer exists, but the
     * node is still in the roster, so keep it working during the upgrade. */
    return generation == 0 && (!binding_id || binding_id[0] == '\0');
}

static bool nodes_upsert_validated(const hc_espnow_rx_t *frame) {
    if (!frame || !s_cfg || s_cfg->board_role != HC_ROLE_CONTROLLER) return false;

    char id[44] = {0};
    char target_ctrl[44] = {0};
    char binding_id[40] = {0};
    uint32_t generation = 0;
    if (frame->payload_len > 0) {
        cJSON *root = cJSON_Parse(frame->payload);
        if (root) {
            cJSON *id_j = cJSON_GetObjectItem(root, "id");
            if (cJSON_IsString(id_j) && id_j->valuestring) {
                snprintf(id, sizeof(id), "%s", id_j->valuestring);
            }
            cJSON *ctrl_j = cJSON_GetObjectItem(root, "ctrl");
            if (cJSON_IsString(ctrl_j) && ctrl_j->valuestring) {
                snprintf(target_ctrl, sizeof(target_ctrl), "%s", ctrl_j->valuestring);
            }
            cJSON *bid_j = cJSON_GetObjectItem(root, "bid");
            if (cJSON_IsString(bid_j) && bid_j->valuestring) {
                snprintf(binding_id, sizeof(binding_id), "%s", bid_j->valuestring);
            }
            cJSON *gen_j = cJSON_GetObjectItem(root, "gen");
            if (cJSON_IsNumber(gen_j)) generation = (uint32_t)gen_j->valuedouble;
            cJSON_Delete(root);
        }
    }

    if (!hc_role_validate_keepalive_target(s_cfg->board_instance_id, id, target_ctrl) ||
        !peer_binding_valid(id, binding_id, generation)) {
        ESP_LOGW(
            TAG,
            "Ignoring Node frame (id=%s target_ctrl=%s self=%s)",
            id[0] ? id : "<empty>",
            target_ctrl[0] ? target_ctrl : "<any>",
            s_cfg->board_instance_id[0] ? s_cfg->board_instance_id : "<unpaired>"
        );
        return false;
    }

    uint32_t rx_now = now_ms();
    s_now_ms = rx_now;

    char mac[20];
    hc_espnow_mac_to_string(frame->mac, mac, sizeof(mac));

    for (uint8_t i = 0; i < s_node_count; ++i) {
        bool same_mac = strcmp(s_nodes[i].mac, mac) == 0;
        bool same_id = strcmp(s_nodes[i].id, id) == 0;
        if (same_mac || same_id) {
            bool was_stale = hc_role_node_is_stale(rx_now, s_nodes[i].last_seen_ms);
            snprintf(s_nodes[i].id, sizeof(s_nodes[i].id), "%s", id);
            snprintf(s_nodes[i].mac, sizeof(s_nodes[i].mac), "%s", mac);
            s_nodes[i].rssi = frame->rssi;
            s_nodes[i].channel = frame->channel;
            s_nodes[i].last_seq = frame->seq;
            s_nodes[i].last_seen_ms = rx_now;
            if (was_stale) {
                s_report_requested = true;
                ESP_LOGI(TAG, "Node re-linked: %s (%s) rssi=%d ch=%u", id, mac, frame->rssi, (unsigned)frame->channel);
            }
            return true;
        }
    }

    if (s_node_count >= HC_BOARD_MAX_NODES) return false;
    hc_role_node_t *slot = &s_nodes[s_node_count++];
    memset(slot, 0, sizeof(*slot));
    snprintf(slot->id, sizeof(slot->id), "%s", id);
    snprintf(slot->mac, sizeof(slot->mac), "%s", mac);
    slot->rssi = frame->rssi;
    slot->channel = frame->channel;
    slot->last_seq = frame->seq;
    slot->last_seen_ms = rx_now;
    s_report_requested = true;
    ESP_LOGI(TAG, "Node linked: %s (%s) rssi=%d ch=%u", id, mac, frame->rssi, (unsigned)frame->channel);
    return true;
}

static void on_node_frame(const hc_espnow_rx_t *frame) {
    if (!frame || !s_cfg || s_cfg->board_role != HC_ROLE_CONTROLLER) return;
    if (frame->type != HC_ESPNOW_FRAME_NODE_KEEPALIVE && frame->type != HC_ESPNOW_FRAME_COMMAND) {
        return;
    }

    if (!nodes_upsert_validated(frame)) {
        return;
    }

    if (frame->type == HC_ESPNOW_FRAME_NODE_KEEPALIVE) {
        uint8_t active_ch = hc_espnow_get_channel();
        char ack_json[HC_ESPNOW_MAX_PAYLOAD];
        if (s_cfg->board_instance_id[0]) {
            int n = snprintf(
                ack_json,
                sizeof(ack_json),
                "{\"id\":\"%s\",\"ch\":%u,\"bid\":\"%s\",\"gen\":%u,\"mq\":%d}",
                s_cfg->board_instance_id,
                (unsigned)active_ch,
                s_cfg->binding_id,
                (unsigned)s_cfg->binding_generation,
                hc_mqtt_is_connected() ? 1 : 0
            );
            if (n > 0 && n < (int)sizeof(ack_json)) {
                hc_espnow_send_ack_json(frame->mac, frame->epoch, frame->seq, ack_json);
            }
        } else {
            hc_espnow_send_ack(frame->mac, frame->epoch, frame->seq);
        }
    }
}

static void on_controller_frame(const hc_espnow_rx_t *frame) {
    if (!frame || !s_cfg || s_cfg->board_role != HC_ROLE_NODE) return;

    if (frame->type == HC_ESPNOW_FRAME_CONTROLLER_ACK) {
        char ack_ctrl_id[44] = {0};
        int ack_ch = 0;
        char ack_binding_id[40] = {0};
        uint32_t ack_generation = 0;
        bool ack_cloud_healthy = false;
        if (frame->payload_len > 0) {
            cJSON *ack_root = cJSON_Parse(frame->payload);
            if (ack_root) {
                cJSON *id_j = cJSON_GetObjectItem(ack_root, "id");
                if (cJSON_IsString(id_j) && id_j->valuestring) {
                    snprintf(ack_ctrl_id, sizeof(ack_ctrl_id), "%s", id_j->valuestring);
                }
                cJSON *ch_j = cJSON_GetObjectItem(ack_root, "ch");
                if (cJSON_IsNumber(ch_j)) ack_ch = (int)ch_j->valuedouble;
                cJSON *bid_j = cJSON_GetObjectItem(ack_root, "bid");
                if (cJSON_IsString(bid_j) && bid_j->valuestring) {
                    snprintf(ack_binding_id, sizeof(ack_binding_id), "%s", bid_j->valuestring);
                }
                cJSON *gen_j = cJSON_GetObjectItem(ack_root, "gen");
                if (cJSON_IsNumber(gen_j)) ack_generation = (uint32_t)gen_j->valuedouble;
                cJSON *mq_j = cJSON_GetObjectItem(ack_root, "mq");
                if (cJSON_IsNumber(mq_j)) ack_cloud_healthy = mq_j->valuedouble > 0;
                cJSON_Delete(ack_root);
            }
        }

        /* Binding generation and identity are checked before a radio ACK can
         * mark the link healthy. Legacy generation 0 remains accepted. */
        if (ack_generation > 0 &&
            (ack_generation != s_peer_binding_generation ||
             (s_peer_binding_id[0] && strcmp(ack_binding_id, s_peer_binding_id) != 0))) {
            ESP_LOGW(TAG, "Rejected Controller ACK with stale/unknown binding generation");
            return;
        }

        if (!hc_role_validate_controller_ack(
                s_state.epoch,
                s_tx_seq,
                s_last_ack_rx_seq,
                frame->epoch,
                frame->seq,
                s_cfg->assigned_controller_id,
                ack_ctrl_id
            )) {
            ESP_LOGW(
                TAG,
                "Rejected Controller ACK (epoch=%u/%u seq=%lu/%lu id=%s)",
                (unsigned)frame->epoch,
                (unsigned)s_state.epoch,
                (unsigned long)frame->seq,
                (unsigned long)s_tx_seq,
                ack_ctrl_id[0] ? ack_ctrl_id : "-"
            );
            return;
        }

        s_last_ack_rx_seq = frame->seq;
        s_controller_cloud_healthy = ack_cloud_healthy;
        s_peer_binding_generation = ack_generation ? ack_generation : s_peer_binding_generation;
        s_peer_rssi = frame->rssi;
        s_peer_channel = (ack_ch >= 1 && ack_ch <= 13) ? (uint8_t)ack_ch : frame->channel;
        s_ms_since_controller = 0;
        s_controller_fresh = true;
        s_seek_probe_unanswered = false;
        hc_espnow_seek_lock();
        return;
    }

    if (frame->type == HC_ESPNOW_FRAME_COMMAND && frame->payload_len > 0) {
        cJSON *root = cJSON_Parse(frame->payload);
        if (!root) return;
        cJSON *cmd_j = cJSON_GetObjectItem(root, "cmd");

        // Same dedupe as MQTT commands: a replayed frame after a link
        // transition must not execute twice.
        cJSON *seq_j = cJSON_GetObjectItem(root, "seq");
        cJSON *epoch_j = cJSON_GetObjectItem(root, "epoch");
        uint16_t epoch = cJSON_IsNumber(epoch_j) ? (uint16_t)epoch_j->valuedouble : frame->epoch;
        uint32_t seq = cJSON_IsNumber(seq_j) ? (uint32_t)seq_j->valuedouble : frame->seq;
        // Dedupe on the *Controller's* command window, not on this Node's own
        // link epoch (each side counts its own transitions).
        bool accept = hc_role_accept_command(epoch, seq, &s_remote_epoch, &s_cmd_seq);
        /* Bounded in-memory command ID dedupe survives route changes without a
         * flash write; replayed toggles after a failover are rejected. */
        {
            cJSON *cid_j = cJSON_GetObjectItem(root, "cid");
            cJSON *gen_j = cJSON_GetObjectItem(root, "gen");
            if (cJSON_IsString(cid_j) && cid_j->valuestring) {
                uint32_t cmd_gen = cJSON_IsNumber(gen_j)
                    ? (uint32_t)gen_j->valuedouble
                    : s_cfg->binding_generation;
                if (!hc_command_dedupe_accept(&s_command_dedupe, cmd_gen, cid_j->valuestring)) {
                    accept = false;
                }
            }
        }

        if (s_cfg && s_cmd_seq > s_cfg->last_cmd_seq) {
            s_cfg->last_cmd_seq = s_cmd_seq;
        }
        if (accept) {
            s_peer_rssi = frame->rssi;
            s_peer_channel = frame->channel;
            s_ms_since_controller = 0;
            s_controller_fresh = true;
            s_seek_probe_unanswered = false;
            hc_espnow_seek_lock();
        }
        if (accept && cJSON_IsString(cmd_j) && cmd_j->valuestring) {
            if (strcmp(cmd_j->valuestring, "relink") == 0) {
                ESP_LOGW(TAG, "Controller asked this Node to re-link now");
                hc_role_state_clear_fallback(&s_state);
                s_controller_fresh = true;
                s_ms_since_controller = 0;
                s_report_requested = true;
            } else if (strcmp(cmd_j->valuestring, "route_confirm") == 0) {
                /* Worker-confirmed route change: only now may the Node drop its
                 * own MQTT session, and only for the current generation. */
                hc_connectivity_confirm_route(&s_conn, s_cfg->binding_generation,
                                              HC_CLOUD_CONTROLLER_MQTT);
                s_report_requested = true;
            } else if (strcmp(cmd_j->valuestring, "ota") == 0) {
                cJSON *ota_j = cJSON_GetObjectItem(root, "ota");
                if (cJSON_IsObject(ota_j) && s_cfg) {
                    cJSON *rel_j = cJSON_GetObjectItem(ota_j, "release_id");
                    cJSON *hist_j = cJSON_GetObjectItem(ota_j, "history_id");
                    cJSON *ver_j = cJSON_GetObjectItem(ota_j, "version");
                    ESP_LOGW(TAG, "Received OTA instruction over ESP-NOW; opening Wi-Fi/EMQX window");
                    hc_role_open_ota_window(HC_OTA_WINDOW_MS);
                    if (cJSON_IsString(rel_j) && rel_j->valuestring) {
                        hc_ota_start_async(
                            s_cfg,
                            rel_j->valuestring,
                            cJSON_IsString(hist_j) ? hist_j->valuestring : "",
                            cJSON_IsString(ver_j) ? ver_j->valuestring : ""
                        );
                    }
                }
            } else if (strcmp(cmd_j->valuestring, "exec") == 0) {
                // A switch/device command relayed by the Controller (this Node has
                // no MQTT session while linked). Same handler as the MQTT path.
                cJSON *kind_j = cJSON_GetObjectItem(root, "k");
                cJSON *payload_j = cJSON_GetObjectItem(root, "p");
                if (cJSON_IsString(kind_j) && kind_j->valuestring &&
                    cJSON_IsObject(payload_j)) {
                    char *payload_str = cJSON_PrintUnformatted(payload_j);
                    if (payload_str) {
                        bool applied = hc_command_apply(kind_j->valuestring, payload_str);
                        ESP_LOGI(
                            TAG,
                            "Relayed %s command from Controller: %s",
                            kind_j->valuestring,
                            applied ? "applied" : "ignored"
                        );
                        cJSON_free(payload_str);
                    }
                }
            }
        }
        cJSON_Delete(root);
    }
}

static void persist_role(homecore_config_t *cfg, bool force) {
    if (!cfg) return;
    bool changed = force;
    uint8_t link = (uint8_t)s_state.link;
    if (cfg->node_link_state != link) {
        cfg->node_link_state = link;
        changed = true;
    }
    if (cfg->link_epoch != s_state.epoch) {
        cfg->link_epoch = s_state.epoch;
        changed = true;
    }
    if (changed) {
        hc_nvs_save_config(cfg);
    }
}

static void reset_node_session_counters(void) {
    s_controller_fresh = false;
    s_ms_since_controller = HC_ROLE_LINK_TIMEOUT_MS;
    s_ever_linked_in_session = false;
    s_seek_probe_unanswered = false;
    s_tx_seq = 0;
    s_last_ack_rx_seq = 0;
    s_peer_rssi = 0;
    s_peer_channel = 0;
    s_keepalive_ms = HC_ESPNOW_KEEPALIVE_MS; /* transmit first keepalive on next tick */
}

static void start_controller_transport(homecore_config_t *cfg) {
    if (s_espnow_started) return;
#if HOMECORE_HAS_WIFI && HC_BOARD_CAN_CONTROLLER
    if (cfg && cfg->espnow_channel >= 1 && cfg->espnow_channel <= 13 && !hc_wifi_is_connected()) {
        hc_espnow_set_channel(cfg->espnow_channel);
    }
    esp_err_t err = hc_espnow_host_start(on_node_frame);
    if (err == ESP_OK) {
        s_espnow_started = true;
        ESP_LOGI(TAG, "Controller role active: hosting Nodes over ESP-NOW");
    } else {
        ESP_LOGW(TAG, "ESP-NOW host start failed: %s", esp_err_to_name(err));
    }
#else
    (void)on_node_frame;
    ESP_LOGW(TAG, "Board has no Wi-Fi radio: Controller role runs Wi-Fi/MQTT only");
    s_espnow_started = true;
#endif
    (void)cfg;
}

static void start_node_transport(homecore_config_t *cfg) {
    if (!cfg) return;
    if (!s_conn.caps.has_espnow || !s_conn.caps.can_node) {
        /* Cloud-only Node: no ESP-NOW radio path exists on this board. */
        hc_espnow_stop();
        return;
    }
    if (strlen(cfg->assigned_controller_id) == 0) {
        hc_espnow_stop();
        s_state.link = HC_NODE_UNASSIGNED;
        s_espnow_started = true; /* nothing to seek: stay a Wi-Fi/MQTT Node */
        return;
    }
    if (strlen(cfg->assigned_controller_mac) == 0) {
        // The Controller is assigned but its ESP-NOW MAC is not known yet (it
        // pairs/reports it on its next heartbeat). Mark the transport armed so
        // the tick does not retry every 500 ms; a config snapshot restarts it
        // as soon as the MAC arrives.
        hc_espnow_stop();
        s_state.link = HC_NODE_CONTROLLER_LOST;
        s_espnow_started = true;
        ESP_LOGW(TAG, "Node assigned but Controller MAC unknown; waiting for config sync");
        return;
    }
#if HOMECORE_HAS_WIFI
    esp_err_t err = hc_espnow_seek_start(
        cfg->assigned_controller_mac,
        cfg->espnow_channel,
        on_controller_frame
    );
    if (err == ESP_OK) {
        s_espnow_started = true;
        s_keepalive_ms = HC_ESPNOW_KEEPALIVE_MS;
        s_seek_probe_unanswered = false;
        ESP_LOGI(
            TAG,
            "Node role active: seeking Controller %s (channel %s)",
            cfg->assigned_controller_mac,
            cfg->espnow_channel ? "pinned" : "auto"
        );
    } else {
        ESP_LOGW(TAG, "ESP-NOW seek start failed: %s", esp_err_to_name(err));
    }
#else
    (void)on_controller_frame;
    ESP_LOGW(TAG, "Board has no Wi-Fi radio: Node falls back to Wi-Fi/MQTT");
    s_espnow_started = true;
#endif
}

esp_err_t hc_role_init(homecore_config_t *cfg) {
    if (!cfg) return ESP_ERR_INVALID_ARG;
    s_cfg = cfg;
    s_now_ms = now_ms();
    s_espnow_started = false;
    s_report_requested = false;
    s_node_count = 0;
    s_ota_window_ms = 0;
    s_cmd_seq = cfg->last_cmd_seq;
    s_remote_epoch = 0;
    hc_command_dedupe_reset(&s_command_dedupe);
    reset_node_session_counters();

    /* Compile-time board profile -> connectivity capability. An unknown slug
     * yields a zeroed capability struct, never a guessed fallback. */
    hc_connectivity_caps_t caps;
    memset(&caps, 0, sizeof(caps));
    const hc_board_capability_t *board = hc_board_capability_for_slug(HOMECORE_BOARD_SLUG);
    if (board) {
        caps.has_wifi = board->has_wifi;
        caps.has_mqtt = board->has_mqtt;
        caps.has_espnow = board->has_espnow;
        caps.can_controller = board->can_controller;
        caps.can_node = board->can_node;
        caps.espnow_mtu_bytes = board->espnow_mtu_bytes;
        caps.espnow_peer_limit = board->espnow_peer_limit;
        caps.max_controller_nodes = board->max_controller_nodes;
        caps.keepalive_ms = board->keepalive_ms;
        caps.link_timeout_ms = board->link_timeout_ms;
        caps.recovery_window_ms = board->recovery_window_ms;
        caps.discovery_interval_ms = board->discovery_interval_ms;
    }
    hc_connectivity_init(&s_conn, &caps);
    s_conn.output.keep_node_mqtt = true; /* no relay is confirmed at boot */
    s_conn.generation = cfg->binding_generation;
    s_transport_count = hc_transport_build(&s_conn.caps, s_transports, HC_MAX_TRANSPORTS);

    hc_role_t role = (hc_role_t)cfg->board_role;
    hc_role_state_init(&s_state, role);
    s_state.epoch = cfg->link_epoch ? cfg->link_epoch : 1;
    s_state.link = (hc_node_link_t)cfg->node_link_state;
    if (role == HC_ROLE_NODE && s_state.link == HC_NODE_LINKED) {
        // A reboot always restarts the link verification until a real ACK arrives.
        s_state.link = HC_NODE_CONTROLLER_LOST;
    }
    if (role == HC_ROLE_NODE && strlen(cfg->assigned_controller_id) == 0) {
        s_state.link = HC_NODE_UNASSIGNED;
    }
    if (role == HC_ROLE_CONTROLLER) {
        hc_role_bump_epoch(&s_state);
        persist_role(cfg, true);
    }

    ESP_LOGI(TAG, "Role=%s assigned=%s", hc_role_name(role), cfg->assigned_controller_id);

    // Transports are started from the supervision tick: at this point Wi-Fi is
    // not up yet on a cold boot, and ESP-NOW needs the radio initialised.
    s_initialized = true;
    return ESP_OK;
}

void hc_role_open_ota_window(uint32_t duration_ms) {
    s_ota_window_ms = duration_ms;
    s_state.ota_window_open = true;
}

void hc_role_request_relink(homecore_config_t *cfg) {
    if (!cfg || cfg->board_role != HC_ROLE_NODE) return;
    ESP_LOGW(TAG, "Re-link requested: clearing the Wi-Fi/MQTT fallback");
    hc_role_state_clear_fallback(&s_state);
    reset_node_session_counters();
    if (strlen(cfg->assigned_controller_id) > 0) {
        s_state.link = HC_NODE_CONTROLLER_LOST;
        hc_role_bump_epoch(&s_state);
    }
    s_report_requested = true;
    if (cfg->assigned_controller_mac[0]) {
        s_espnow_started = false;
        start_node_transport(cfg);
    }
    /* Note: MQTT teardown is intentionally deferred to node_tick() on the
       supervision task so hc_mqtt_stop() is never invoked from inside the
       MQTT client's own event callback. */
}

esp_err_t hc_role_relay_command_to_node(homecore_config_t *cfg, const char *node_id, const char *json) {
    if (!cfg || cfg->board_role != HC_ROLE_CONTROLLER) return ESP_ERR_INVALID_STATE;
    if (!node_id || !json) return ESP_ERR_INVALID_ARG;
    for (uint8_t i = 0; i < s_node_count; ++i) {
        if (strcmp(s_nodes[i].id, node_id) != 0) continue;
        if (hc_role_node_is_stale(s_now_ms, s_nodes[i].last_seen_ms)) {
            ESP_LOGW(TAG, "Node %s is stale; dropping relayed command", node_id);
            return ESP_ERR_INVALID_STATE;
        }
        return hc_espnow_send_command(
            s_nodes[i].mac,
            s_state.epoch,
            ++s_tx_seq,
            json
        );
    }
    ESP_LOGW(TAG, "Node %s is not linked to this Controller", node_id);
    return ESP_ERR_NOT_FOUND;
}

static void node_tick(homecore_config_t *cfg, uint32_t elapsed_ms) {
    hc_role_input_t in;
    memset(&in, 0, sizeof(in));
    in.role = HC_ROLE_NODE;
    in.has_wifi = HOMECORE_HAS_WIFI != 0;
    in.has_espnow = HOMECORE_HAS_WIFI != 0;
    in.assigned = strlen(cfg->assigned_controller_id) > 0;
    in.controller_online = s_controller_fresh &&
        s_ms_since_controller < HC_ROLE_LINK_TIMEOUT_MS;
    in.mqtt_connected = hc_mqtt_is_connected();
    in.ota_window = s_ota_window_ms > 0;
    in.ms_since_controller = s_ms_since_controller;

    const hc_node_link_t prev_link = s_state.link;
    uint32_t actions = hc_role_node_step(&s_state, &in, elapsed_ms);

    /* Universal connectivity manager: capabilities, binding and both link
     * states stay separate. Its route decision supersedes the legacy
     * role state machine's MQTT teardown hint. */
    hc_connectivity_input_t conn_in;
    memset(&conn_in, 0, sizeof(conn_in));
    conn_in.binding = (hc_binding_state_t)cfg->binding_state;
    if (conn_in.binding > HC_BINDING_REVOKED) conn_in.binding = HC_BINDING_UNPAIRED;
    conn_in.generation = cfg->binding_generation;
    conn_in.peer_generation = s_peer_binding_generation;
    const hc_transport_t *mqtt_t = hc_transport_find(s_transports, s_transport_count, "wifi_mqtt");
    conn_in.node_mqtt_healthy = mqtt_t ? mqtt_t->is_active() : false;
    conn_in.controller_mqtt_healthy = s_controller_fresh && s_controller_cloud_healthy;
    conn_in.espnow_ack_verified = s_controller_fresh;
    conn_in.in_roster = s_controller_fresh && s_peer_binding_generation == cfg->binding_generation;
    conn_in.telemetry_fresh = cfg->paired; /* freshness is also enforced in the Worker */
    conn_in.local_active = true; /* local GPIO/automation runs independently */
    conn_in.assigned = in.assigned;
    hc_connectivity_output_t conn_out = hc_connectivity_step(&s_conn, &conn_in, elapsed_ms);
    cfg->cloud_route = (uint8_t)conn_out.cloud;
    if ((actions & HC_ROLE_ACT_STOP_MQTT) && conn_out.keep_node_mqtt) {
        actions &= (uint32_t)~HC_ROLE_ACT_STOP_MQTT;
    }
    if (!conn_out.start_espnow ||
        !hc_transport_find(s_transports, s_transport_count, "espnow")) {
        actions &= (uint32_t)~HC_ROLE_ACT_ESPNOW_SEEK;
    }

    if ((actions & HC_ROLE_ACT_ESPNOW_SEEK) && !s_espnow_started) {
        start_node_transport(cfg);
    }

    if ((actions & HC_ROLE_ACT_ESPNOW_SEEK) && cfg->assigned_controller_mac[0]) {
        s_keepalive_ms += elapsed_ms;
        if (s_keepalive_ms >= HC_ESPNOW_KEEPALIVE_MS) {
            s_keepalive_ms = 0;
            // Hop BEFORE transmitting the next keepalive only after the full
            // 2000 ms listen window on the previous channel went unanswered.
            if (s_seek_probe_unanswered && cfg->espnow_channel == 0 && hc_espnow_is_seeking()) {
                hc_espnow_seek_hop();
            }

            char keepalive[HC_ESPNOW_MAX_PAYLOAD];
            if (cfg->board_instance_id[0] && cfg->assigned_controller_id[0]) {
                int n = snprintf(
                    keepalive,
                    sizeof(keepalive),
                    "{\"id\":\"%s\",\"ctrl\":\"%s\",\"bid\":\"%s\",\"gen\":%u}",
                    cfg->board_instance_id,
                    cfg->assigned_controller_id,
                    cfg->binding_id,
                    (unsigned)cfg->binding_generation
                );
                if (n < 0 || n >= (int)sizeof(keepalive)) keepalive[0] = '\0';
            } else if (cfg->board_instance_id[0]) {
                snprintf(
                    keepalive,
                    sizeof(keepalive),
                    "{\"id\":\"%s\",\"bid\":\"%s\",\"gen\":%u}",
                    cfg->board_instance_id,
                    cfg->binding_id,
                    (unsigned)cfg->binding_generation
                );
            } else {
                keepalive[0] = '\0';
            }

            esp_err_t err = hc_espnow_send_keepalive_json(
                cfg->assigned_controller_mac,
                s_state.epoch,
                ++s_tx_seq,
                keepalive[0] ? keepalive : NULL
            );
            if (err == ESP_OK && hc_espnow_is_seeking()) {
                s_seek_probe_unanswered = true;
            }
        }
    }

    if (s_state.link == HC_NODE_LINKED) {
        s_ever_linked_in_session = true;
    }

    if (s_state.link != prev_link) {
        ESP_LOGI(
            TAG,
            "Node link state: %s -> %s (standalone fallback %s)",
            hc_node_link_name(prev_link),
            hc_node_link_name(s_state.link),
            s_state.standalone ? "active" : "off"
        );
        if (prev_link == HC_NODE_LINKED && s_state.link != HC_NODE_LINKED && cfg->espnow_channel == 0) {
            // The Controller may have moved to another Wi-Fi channel while it
            // was away: sweep again instead of shouting on a dead channel.
            s_seek_probe_unanswered = false;
            hc_espnow_reseek();
        }
        persist_role(cfg, true);
        s_report_requested = true;
    } else if (actions & HC_ROLE_ACT_REPORT_STATE) {
        if (prev_link != HC_NODE_UNASSIGNED || s_state.link != HC_NODE_UNASSIGNED) {
            s_report_requested = true;
        }
    }

    // The role owns the EMQX session for a Node: open it for the fallback or an
    // OTA window, and close it again as soon as the ESP-NOW link is healthy (or
    // while seeking inside the 45 s window). Running this here on the main
    // supervision task avoids stopping MQTT from inside its own callback.
    if (hc_role_wants_mqtt()) {
        if (!hc_mqtt_is_started() && hc_wifi_is_connected()) {
            hc_mqtt_start(cfg);
        }
    } else if (hc_mqtt_is_started()) {
        hc_mqtt_stop();
        ESP_LOGI(TAG, "Node operating over ESP-NOW: closed independent MQTT session");
    }
}

static void controller_tick(homecore_config_t *cfg, uint32_t elapsed_ms) {
    (void)elapsed_ms;
    hc_role_input_t in;
    memset(&in, 0, sizeof(in));
    in.role = HC_ROLE_CONTROLLER;
    in.has_wifi = HOMECORE_HAS_WIFI != 0;
    in.has_espnow = HOMECORE_HAS_WIFI != 0;
    in.mqtt_connected = hc_mqtt_is_connected();

    uint32_t actions = hc_role_controller_step(&s_state, &in);
    hc_connectivity_input_t conn_in;
    memset(&conn_in, 0, sizeof(conn_in));
    conn_in.is_controller = true;
    conn_in.generation = cfg->binding_generation;
    conn_in.controller_mqtt_healthy = hc_mqtt_is_connected();
    conn_in.telemetry_fresh = cfg->paired;
    conn_in.local_active = true;
    hc_connectivity_output_t conn_out = hc_connectivity_step(&s_conn, &conn_in, elapsed_ms);
    cfg->cloud_route = (uint8_t)conn_out.cloud;
    if ((actions & HC_ROLE_ACT_ESPNOW_HOST) && conn_out.host_espnow) {
        start_controller_transport(cfg);
    }
    if ((actions & HC_ROLE_ACT_START_MQTT) && !hc_mqtt_is_started() && hc_wifi_is_connected()) {
        hc_mqtt_start(cfg);
    }

    // Push an immediate heartbeat whenever the live linked Node count changes
    // (e.g. a Node links or crosses the 20 s stale window).
    static uint8_t last_count = 0;
    uint8_t count = hc_role_linked_node_count();
    if (count != last_count) {
        last_count = count;
        persist_role(cfg, true);
        s_report_requested = true;
    }
}

void hc_role_tick(homecore_config_t *cfg, uint32_t elapsed_ms) {
    if (!cfg || !s_initialized) return;
    s_now_ms = now_ms();
    if (s_ms_since_controller <= UINT32_MAX - elapsed_ms) {
        s_ms_since_controller += elapsed_ms;
    } else {
        s_ms_since_controller = UINT32_MAX;
    }
    if (s_ms_since_controller >= HC_ROLE_LINK_TIMEOUT_MS) {
        s_controller_fresh = false;
    }
    if (s_ota_window_ms > 0) {
        if (s_ota_window_ms <= elapsed_ms) {
            s_ota_window_ms = 0;
            s_state.ota_window_open = false;
            ESP_LOGI(TAG, "OTA Wi-Fi window closed");
        } else {
            s_ota_window_ms -= elapsed_ms;
        }
    }

    if (cfg->board_role == HC_ROLE_NODE) {
        node_tick(cfg, elapsed_ms);
    } else {
        controller_tick(cfg, elapsed_ms);
    }
}

static bool evict_unassigned_roster_nodes(cJSON *node_ids_j) {
    if (!cJSON_IsArray(node_ids_j) || s_node_count == 0) return false;
    bool evicted = false;
    uint8_t write_idx = 0;
    for (uint8_t i = 0; i < s_node_count; ++i) {
        bool still_assigned = false;
        cJSON *entry = NULL;
        cJSON_ArrayForEach(entry, node_ids_j) {
            if (cJSON_IsString(entry) && entry->valuestring &&
                strcmp(entry->valuestring, s_nodes[i].id) == 0) {
                still_assigned = true;
                break;
            }
        }
        if (still_assigned) {
            if (write_idx != i) {
                s_nodes[write_idx] = s_nodes[i];
            }
            write_idx++;
        } else {
            evicted = true;
            ESP_LOGI(TAG, "Evicted unassigned Node %s from Controller roster", s_nodes[i].id);
        }
    }
    s_node_count = write_idx;
    return evicted;
}

static uint8_t parse_binding_state(const cJSON *value) {
    if (!cJSON_IsString(value) || !value->valuestring) return HC_BINDING_UNPAIRED;
    if (strcmp(value->valuestring, "pairing") == 0) return HC_BINDING_PAIRING;
    if (strcmp(value->valuestring, "assigned") == 0) return HC_BINDING_ASSIGNED;
    if (strcmp(value->valuestring, "verified") == 0) return HC_BINDING_VERIFIED;
    if (strcmp(value->valuestring, "revoked") == 0) return HC_BINDING_REVOKED;
    return HC_BINDING_UNPAIRED;
}

/**
 * Applies the Worker-authorized binding block. A lower generation is ignored:
 * offline peers cannot downgrade authority. Only changed binding credentials
 * are committed to NVS.
 */
static bool apply_binding_snapshot(homecore_config_t *cfg, const cJSON *root) {
    cJSON *binding_j = cJSON_GetObjectItem(root, "binding");
    if (!cJSON_IsObject(binding_j)) return false;
    cJSON *gen_j = cJSON_GetObjectItem(binding_j, "generation");
    cJSON *id_j = cJSON_GetObjectItem(binding_j, "id");
    cJSON *state_j = cJSON_GetObjectItem(binding_j, "state");
    cJSON *controller_j = cJSON_GetObjectItem(binding_j, "controllerId");
    uint32_t generation = cJSON_IsNumber(gen_j) && gen_j->valuedouble > 0
        ? (uint32_t)gen_j->valuedouble
        : 0;
    char new_id[sizeof(cfg->binding_id)] = {0};
    if (cJSON_IsString(id_j) && id_j->valuestring) {
        hc_copy_str(new_id, sizeof(new_id), id_j->valuestring);
    }

    bool changed = false;
    if (generation > cfg->binding_generation ||
        (generation == cfg->binding_generation && strcmp(new_id, cfg->binding_id) != 0)) {
        cfg->binding_generation = generation;
        hc_copy_str(cfg->binding_id, sizeof(cfg->binding_id), new_id);
        changed = true;
    }
    uint8_t new_state = parse_binding_state(state_j);
    if (cfg->binding_state != new_state) {
        cfg->binding_state = new_state;
        changed = true;
    }
    if (changed) {
        hc_command_dedupe_reset(&s_command_dedupe); /* new binding window */
        s_peer_binding_generation = 0;
        s_peer_binding_id[0] = '\0';
        /* A new generation invalidates every old challenge and peer grant. */
        s_challenge_id[0] = '\0';
        s_challenge_nonce[0] = '\0';
        s_challenge_generation = 0;
        for (size_t i = 0; i < sizeof(s_peer_bindings) / sizeof(s_peer_bindings[0]); ++i) {
            s_peer_bindings[i].challenge_id[0] = '\0';
            s_peer_bindings[i].challenge_nonce[0] = '\0';
        }
        hc_nvs_save_binding_if_changed(cfg);
    }

    if (cJSON_IsString(controller_j) && controller_j->valuestring &&
        cfg->assigned_controller_id[0] &&
        strcmp(controller_j->valuestring, cfg->assigned_controller_id) == 0) {
        hc_copy_str(s_peer_binding_id, sizeof(s_peer_binding_id), new_id);
        s_peer_binding_generation = generation;
    }

    cJSON *nodes_j = cJSON_GetObjectItem(binding_j, "nodeBindings");
    if (cJSON_IsArray(nodes_j)) {
        memset(s_peer_bindings, 0, sizeof(s_peer_bindings));
        size_t idx = 0;
        const cJSON *entry = NULL;
        cJSON_ArrayForEach(entry, nodes_j) {
            if (idx >= sizeof(s_peer_bindings) / sizeof(s_peer_bindings[0])) break;
            cJSON *nid = cJSON_GetObjectItem(entry, "id");
            cJSON *nbid = cJSON_GetObjectItem(entry, "bindingId");
            cJSON *ngen = cJSON_GetObjectItem(entry, "generation");
            if (!cJSON_IsString(nid) || !nid->valuestring) continue;
            hc_copy_str(s_peer_bindings[idx].id, sizeof(s_peer_bindings[idx].id), nid->valuestring);
            if (cJSON_IsString(nbid) && nbid->valuestring) {
                hc_copy_str(s_peer_bindings[idx].binding_id, sizeof(s_peer_bindings[idx].binding_id), nbid->valuestring);
            }
            s_peer_bindings[idx].generation = cJSON_IsNumber(ngen) ? (uint32_t)ngen->valuedouble : 0;
            idx++;
        }
    }
    s_conn.generation = cfg->binding_generation;
    return changed;
}

bool hc_role_apply_snapshot(homecore_config_t *cfg, const char *snapshot_json) {
    if (!cfg || !snapshot_json) return false;
    cJSON *root = cJSON_Parse(snapshot_json);
    if (!root) return false;

    cJSON *role_j = cJSON_GetObjectItem(root, "role");
    if (!cJSON_IsObject(role_j)) {
        cJSON_Delete(root);
        return false;
    }
    bool binding_changed = apply_binding_snapshot(cfg, root);

    bool changed = false;
    hc_role_t new_role = HC_ROLE_CONTROLLER;
    cJSON *mode_j = cJSON_GetObjectItem(role_j, "mode");
    if (cJSON_IsString(mode_j) && mode_j->valuestring) {
        new_role = hc_role_from_string(mode_j->valuestring);
    }

    char new_uplink_id[sizeof(cfg->assigned_controller_id)] = {0};
    char new_uplink_mac[sizeof(cfg->assigned_controller_mac)] = {0};
    uint8_t new_channel = HOMECORE_ESPNOW_CHANNEL_ANY;

    cJSON *uplink_j = cJSON_GetObjectItem(role_j, "assignedControllerId");
    if (cJSON_IsString(uplink_j) && uplink_j->valuestring) {
        snprintf(new_uplink_id, sizeof(new_uplink_id), "%s", uplink_j->valuestring);
    }
    cJSON *mac_j = cJSON_GetObjectItem(role_j, "assignedControllerMac");
    if (cJSON_IsString(mac_j) && mac_j->valuestring) {
        snprintf(new_uplink_mac, sizeof(new_uplink_mac), "%s", mac_j->valuestring);
    }
    cJSON *ch_j = cJSON_GetObjectItem(role_j, "espnowChannel");
    if (cJSON_IsNumber(ch_j)) {
        int ch = (int)ch_j->valuedouble;
        if (ch >= 1 && ch <= 13) new_channel = (uint8_t)ch;
    }

    uint8_t old_role = cfg->board_role;
    if (cfg->board_role != (uint8_t)new_role) {
        cfg->board_role = (uint8_t)new_role;
        changed = true;
        ESP_LOGW(TAG, "Role changed by user: %s", hc_role_name(new_role));
    }
    if (strcmp(cfg->assigned_controller_id, new_uplink_id) != 0) {
        snprintf(
            cfg->assigned_controller_id,
            sizeof(cfg->assigned_controller_id),
            "%s",
            new_uplink_id
        );
        changed = true;
    }
    if (strcmp(cfg->assigned_controller_mac, new_uplink_mac) != 0) {
        snprintf(
            cfg->assigned_controller_mac,
            sizeof(cfg->assigned_controller_mac),
            "%s",
            new_uplink_mac
        );
        changed = true;
    }
    if (cfg->espnow_channel != new_channel) {
        cfg->espnow_channel = new_channel;
        changed = true;
    }

    bool roster_evicted = false;
    if (new_role == HC_ROLE_CONTROLLER) {
        cJSON *node_ids_j = cJSON_GetObjectItem(role_j, "nodeIds");
        roster_evicted = evict_unassigned_roster_nodes(node_ids_j);
        if (roster_evicted) {
            s_report_requested = true;
        }
    }
    cJSON_Delete(root);

    if (!changed) return roster_evicted || binding_changed;

    // Tear down any previous ESP-NOW hosting/seeking state immediately so a
    // demoted Controller stops ACKing peers right away.
    hc_espnow_stop();
    s_node_count = 0;
    s_espnow_started = false;
    reset_node_session_counters();
    hc_role_state_init(&s_state, (hc_role_t)cfg->board_role);
    s_state.epoch = cfg->link_epoch ? cfg->link_epoch : 1;

    if (cfg->board_role == HC_ROLE_CONTROLLER) {
        if (old_role != HC_ROLE_CONTROLLER) {
            // Promoting to Controller opens a fresh command window: Nodes that
            // link to it must not reject its first commands as stale.
            hc_role_bump_epoch(&s_state);
        }
        start_controller_transport(cfg);
    } else {
        hc_role_bump_epoch(&s_state);
        if (strlen(cfg->assigned_controller_id) == 0) {
            s_state.link = HC_NODE_UNASSIGNED;
        } else {
            s_state.link = HC_NODE_CONTROLLER_LOST;
            start_node_transport(cfg);
        }
        /* MQTT start/stop is reconciled on the next supervision tick in
           node_tick() / controller_tick() so we never destroy the MQTT client
           from inside handle_config_snapshot() on the MQTT task, and so
           config/ack can be published before closing the session. */
    }
    s_report_requested = true;
    persist_role(cfg, true);
    return true;
}

void hc_role_consume_binding_challenge(void) {
    s_challenge_id[0] = '\0';
    s_challenge_nonce[0] = '\0';
    s_challenge_generation = 0;
    for (size_t i = 0; i < sizeof(s_peer_bindings) / sizeof(s_peer_bindings[0]); ++i) {
        s_peer_bindings[i].challenge_id[0] = '\0';
        s_peer_bindings[i].challenge_nonce[0] = '\0';
    }
}

void hc_role_set_binding_challenge(const homecore_config_t *cfg,
                                   const char *node_id,
                                   const char *challenge_id,
                                   const char *nonce,
                                   uint32_t generation) {
    if (!cfg || !challenge_id || !generation) return;
    if (cfg->board_role == HC_ROLE_NODE) {
        hc_copy_str(s_challenge_id, sizeof(s_challenge_id), challenge_id);
        hc_copy_str(s_challenge_nonce, sizeof(s_challenge_nonce), nonce ? nonce : "");
        s_challenge_generation = generation;
        ESP_LOGI(TAG, "Stored Worker binding challenge generation %u", generation);
        return;
    }
    if (!node_id) return;
    for (size_t i = 0; i < sizeof(s_peer_bindings) / sizeof(s_peer_bindings[0]); ++i) {
        if (!s_peer_bindings[i].id[0]) {
            hc_copy_str(s_peer_bindings[i].id, sizeof(s_peer_bindings[i].id), node_id);
        }
        if (strcmp(s_peer_bindings[i].id, node_id) != 0) continue;
        hc_copy_str(s_peer_bindings[i].challenge_id,
                    sizeof(s_peer_bindings[i].challenge_id), challenge_id);
        hc_copy_str(s_peer_bindings[i].challenge_nonce,
                    sizeof(s_peer_bindings[i].challenge_nonce), nonce ? nonce : "");
        ESP_LOGI(TAG, "Stored Worker challenge for Node %s generation %u", node_id, generation);
        return;
    }
    ESP_LOGW(TAG, "No peer slot available for binding challenge");
}

void hc_role_fill_heartbeat(const homecore_config_t *cfg, cJSON *root) {
    if (!cfg || !root) return;

    cJSON_AddStringToObject(
        root,
        "role",
        hc_role_name((hc_role_t)cfg->board_role)
    );
    if (!cfg->paired) return;

    cJSON_AddStringToObject(root, "cm", hc_role_comm_mode_name(cfg));
    /* Binding state is reported separately from live connectivity. */
    cJSON_AddStringToObject(root, "bs", hc_binding_state_name((hc_binding_state_t)cfg->binding_state));
    cJSON_AddStringToObject(root, "bid", cfg->binding_id);
    cJSON_AddNumberToObject(root, "gen", (double)cfg->binding_generation);
    cJSON_AddStringToObject(root, "cr", hc_cloud_route_name((hc_cloud_route_t)cfg->cloud_route));

    uint8_t radio_ch = hc_espnow_get_channel();
    if (radio_ch >= 1 && radio_ch <= 13) {
        cJSON_AddNumberToObject(root, "ch", radio_ch);
    }

    if (cfg->board_role == HC_ROLE_NODE) {
        const char *ls_name = hc_node_link_name(s_state.link);
        if (s_state.link == HC_NODE_CONTROLLER_LOST &&
            !s_ever_linked_in_session &&
            strlen(cfg->assigned_controller_id) > 0) {
            ls_name = "reconnecting";
        }
        cJSON_AddStringToObject(root, "ls", ls_name);
        cJSON_AddStringToObject(root, "espnowLinkState", ls_name);
        cJSON_AddNumberToObject(root, "kaTx", (double)s_tx_seq);
        cJSON_AddNumberToObject(root, "ackRx", (double)s_last_ack_rx_seq);
        if (s_challenge_id[0] && s_challenge_generation >= cfg->binding_generation) {
            cJSON_AddStringToObject(root, "chid", s_challenge_id);
            cJSON_AddStringToObject(root, "cnon", s_challenge_nonce);
            cJSON_AddNumberToObject(root, "chg", (double)s_challenge_generation);
        }
        if (s_peer_rssi != 0) {
            cJSON_AddNumberToObject(root, "peerRssi", s_peer_rssi);
        }
        if (s_peer_channel >= 1 && s_peer_channel <= 13) {
            cJSON_AddNumberToObject(root, "peerCh", s_peer_channel);
        }
        return;
    }

    cJSON_AddStringToObject(root, "espnowLinkState", "hosting");

    // The roster is always present for a Controller — including when it is
    // empty. An omitted array would make the console keep the last "linked"
    // state forever; an empty array is what marks assigned Nodes as
    // controller_lost after the stale window.
    cJSON *nodes = cJSON_AddArrayToObject(root, "nodes");
    if (!nodes) return;
    for (uint8_t i = 0; i < s_node_count; ++i) {
        if (!s_nodes[i].id[0]) continue;
        if (hc_role_node_is_stale(s_now_ms, s_nodes[i].last_seen_ms)) continue;
        cJSON *item = cJSON_CreateObject();
        if (!item) continue;
        cJSON_AddStringToObject(item, "id", s_nodes[i].id);
        for (size_t b = 0; b < sizeof(s_peer_bindings) / sizeof(s_peer_bindings[0]); ++b) {
            if (s_peer_bindings[b].id[0] && strcmp(s_peer_bindings[b].id, s_nodes[i].id) == 0) {
                cJSON_AddStringToObject(item, "bid", s_peer_bindings[b].binding_id);
                cJSON_AddNumberToObject(item, "gen", (double)s_peer_bindings[b].generation);
                if (s_peer_bindings[b].challenge_id[0]) {
                    cJSON_AddStringToObject(item, "chid", s_peer_bindings[b].challenge_id);
                    cJSON_AddStringToObject(item, "cnon", s_peer_bindings[b].challenge_nonce);
                }
                break;
            }
        }
        cJSON_AddStringToObject(item, "link", "linked");
        cJSON_AddNumberToObject(item, "rssi", s_nodes[i].rssi);
        if (s_nodes[i].channel >= 1 && s_nodes[i].channel <= 13) {
            cJSON_AddNumberToObject(item, "channel", s_nodes[i].channel);
        }
        if (s_nodes[i].last_seq > 0) {
            cJSON_AddNumberToObject(item, "seq", (double)s_nodes[i].last_seq);
        }
        cJSON_AddItemToArray(nodes, item);
    }
}
