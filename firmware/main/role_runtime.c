#include "role_runtime.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "espnow_link.h"

static const char *TAG = "hc_role";

#define HC_ESPNOW_KEEPALIVE_MS 2000u
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
    if (!s_initialized) return false;
    /* Standalone fallback, an OTA window, or no Controller assigned at all: the
       Node must stay reachable over EMQX. Otherwise (linked or retrying) it
       deliberately keeps no cloud session of its own. */
    return s_state.standalone || s_state.ota_window_open ||
        s_state.link == HC_NODE_UNASSIGNED;
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

static bool nodes_upsert_validated(const hc_espnow_rx_t *frame) {
    if (!frame || !s_cfg || s_cfg->board_role != HC_ROLE_CONTROLLER) return false;

    char id[44] = {0};
    char target_ctrl[44] = {0};
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
            cJSON_Delete(root);
        }
    }

    if (!hc_role_validate_keepalive_target(s_cfg->board_instance_id, id, target_ctrl)) {
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

    if (s_node_count >= HC_ESPNOW_MAX_NODES) return false;
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
        char ack_json[96];
        if (s_cfg->board_instance_id[0]) {
            snprintf(
                ack_json,
                sizeof(ack_json),
                "{\"id\":\"%s\",\"ch\":%u}",
                s_cfg->board_instance_id,
                (unsigned)active_ch
            );
            hc_espnow_send_ack_json(frame->mac, frame->epoch, frame->seq, ack_json);
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
        if (frame->payload_len > 0) {
            cJSON *ack_root = cJSON_Parse(frame->payload);
            if (ack_root) {
                cJSON *id_j = cJSON_GetObjectItem(ack_root, "id");
                if (cJSON_IsString(id_j) && id_j->valuestring) {
                    snprintf(ack_ctrl_id, sizeof(ack_ctrl_id), "%s", id_j->valuestring);
                }
                cJSON *ch_j = cJSON_GetObjectItem(ack_root, "ch");
                if (cJSON_IsNumber(ch_j)) {
                    ack_ch = (int)ch_j->valuedouble;
                }
                cJSON_Delete(ack_root);
            }
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
#if HOMECORE_HAS_WIFI
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
    reset_node_session_counters();

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

            char keepalive[128];
            if (cfg->board_instance_id[0] && cfg->assigned_controller_id[0]) {
                snprintf(
                    keepalive,
                    sizeof(keepalive),
                    "{\"id\":\"%s\",\"ctrl\":\"%s\"}",
                    cfg->board_instance_id,
                    cfg->assigned_controller_id
                );
            } else if (cfg->board_instance_id[0]) {
                snprintf(
                    keepalive,
                    sizeof(keepalive),
                    "{\"id\":\"%s\"}",
                    cfg->board_instance_id
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
    if (actions & HC_ROLE_ACT_ESPNOW_HOST) {
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

bool hc_role_apply_snapshot(homecore_config_t *cfg, const char *snapshot_json) {
    if (!cfg || !snapshot_json) return false;
    cJSON *root = cJSON_Parse(snapshot_json);
    if (!root) return false;

    cJSON *role_j = cJSON_GetObjectItem(root, "role");
    if (!cJSON_IsObject(role_j)) {
        cJSON_Delete(root);
        return false;
    }

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

    if (!changed) return roster_evicted;

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

void hc_role_fill_heartbeat(const homecore_config_t *cfg, cJSON *root) {
    if (!cfg || !root) return;

    cJSON_AddStringToObject(
        root,
        "role",
        hc_role_name((hc_role_t)cfg->board_role)
    );
    if (!cfg->paired) return;

    cJSON_AddStringToObject(root, "cm", hc_role_comm_mode_name(cfg));

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
