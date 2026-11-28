#include "board_log.h"
#include "homecore_config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "espnow_link.h"
#include "role_runtime.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mqtt_client.h"

static const char *TAG = "hc_mqtt";

static esp_mqtt_client_handle_t s_client = NULL;
static homecore_config_t *s_cfg = NULL;
static bool s_mqtt_connected = false;
static bool s_sync_requested = false;
static char s_last_mqtt_error[128] = {0};

bool hc_mqtt_is_started(void) {
    return s_client != NULL;
}

bool hc_mqtt_is_connected(void) {
    return s_mqtt_connected;
}

const char *hc_mqtt_get_last_error(void) {
    return s_last_mqtt_error;
}

bool hc_mqtt_consume_sync_request(void) {
    bool val = s_sync_requested;
    s_sync_requested = false;
    return val;
}

void hc_mqtt_trigger_reconnect(void) {
    if (s_client && !s_mqtt_connected) {
        esp_mqtt_client_reconnect(s_client);
    }
}

void hc_mqtt_stop(void) {
    s_mqtt_connected = false;
    if (s_client) {
        esp_mqtt_client_stop(s_client);
        esp_mqtt_client_destroy(s_client);
        s_client = NULL;
    }
}

/* Extracts the command id the Worker attached to a command, so a receiver-side
   fact can be tied back to the exact command that caused it. */
static void extract_command_id(const char *data, int len, char *out, size_t out_len) {
    if (!out || out_len == 0) return;
    out[0] = '\0';
    if (!data || len <= 0) return;
    cJSON *root = cJSON_ParseWithLength(data, (size_t)len);
    if (!root) return;
    cJSON *cid_j = cJSON_GetObjectItem(root, "cid");
    if (!cJSON_IsString(cid_j)) cid_j = cJSON_GetObjectItem(root, "command_id");
    if (cJSON_IsString(cid_j) && cid_j->valuestring) {
        snprintf(out, out_len, "%s", cid_j->valuestring);
    }
    cJSON_Delete(root);
}

/* Applies a switch/device command payload. Shared by the MQTT handlers and by
   ESP-NOW commands relayed from a Controller, so both transports execute exactly
   the same GPIO logic (no second command implementation to drift). */
static hc_cmd_outcome_t apply_switch_command(const char *data, int len) {
    if (!data || len <= 0) return HC_CMD_REJECTED;
    cJSON *root = cJSON_ParseWithLength(data, (size_t)len);
    if (!root) return HC_CMD_REJECTED;

    hc_cmd_outcome_t outcome = HC_CMD_REJECTED;
    cJSON *id_j = cJSON_GetObjectItem(root, "switch_id");
    cJSON *pin_j = cJSON_GetObjectItem(root, "gpio_pin");
    cJSON *state_j = cJSON_GetObjectItem(root, "state");
    cJSON *inv_j = cJSON_GetObjectItem(root, "inverted");

    if (cJSON_IsString(id_j) && cJSON_IsNumber(pin_j) &&
        (cJSON_IsString(state_j) || cJSON_IsBool(state_j))) {
        bool on = cJSON_IsBool(state_j)
            ? cJSON_IsTrue(state_j)
            : hc_io_parse_bool_state(state_j->valuestring, false);
        bool inv = cJSON_IsBool(inv_j) && cJSON_IsTrue(inv_j);
        /* The payload is valid, so a drive failure is a *failed* command, not
         * a rejected one: the board accepted it and could not apply it. */
        outcome = hc_io_drive_pin(
            id_j->valuestring,
            HC_IO_KIND_SWITCH,
            (uint8_t)pin_j->valueint,
            inv,
            on
        ) == ESP_OK ? HC_CMD_APPLIED : HC_CMD_FAILED;
        ESP_LOGI(TAG, "Switch %s (GPIO %d) -> %s", id_j->valuestring, pin_j->valueint, on ? "ON" : "OFF");
    }
    cJSON_Delete(root);
    return outcome;
}

static hc_cmd_outcome_t apply_device_command(const char *data, int len) {
    if (!data || len <= 0) return HC_CMD_REJECTED;
    cJSON *root = cJSON_ParseWithLength(data, (size_t)len);
    if (!root) return HC_CMD_REJECTED;

    hc_cmd_outcome_t outcome = HC_CMD_REJECTED;
    cJSON *id_j = cJSON_GetObjectItem(root, "device_id");
    cJSON *pin_j = cJSON_GetObjectItem(root, "gpio_pin");
    cJSON *state_j = cJSON_GetObjectItem(root, "state");
    cJSON *active_j = cJSON_GetObjectItem(root, "active");

    if (cJSON_IsString(id_j) && cJSON_IsNumber(pin_j) &&
        (cJSON_IsString(state_j) || cJSON_IsBool(active_j))) {
        bool active = cJSON_IsBool(active_j)
            ? cJSON_IsTrue(active_j)
            : hc_io_parse_bool_state(state_j->valuestring, false);
        outcome = hc_io_drive_pin(
            id_j->valuestring,
            HC_IO_KIND_DEVICE,
            (uint8_t)pin_j->valueint,
            false,
            active
        ) == ESP_OK ? HC_CMD_APPLIED : HC_CMD_FAILED;
        ESP_LOGI(TAG, "Device %s (GPIO %d) -> %s (%s)",
            id_j->valuestring,
            pin_j->valueint,
            cJSON_IsString(state_j) ? state_j->valuestring : (active ? "active" : "inactive"),
            active ? "HIGH" : "LOW");
    }
    cJSON_Delete(root);
    return outcome;
}

static void handle_switch_cmd(const char *data, int len) {
    char command_id[HC_BOARD_LOG_COMMAND_LEN];
    extract_command_id(data, len, command_id, sizeof(command_id));
    /* "received" is a receiver-side fact: the broker delivered this command to
     * this board. It is never derived from a publish on the Worker side. */
    hc_board_log_record(
        HC_BOARD_LOG_KIND_COMMAND,
        HC_BOARD_LOG_STATUS_RECEIVED,
        HC_BOARD_LOG_METHOD_MQTT,
        NULL,
        "switch",
        command_id
    );
    hc_cmd_outcome_t outcome = apply_switch_command(data, len);
    hc_board_log_record(
        HC_BOARD_LOG_KIND_COMMAND,
        hc_cmd_outcome_status(outcome),
        HC_BOARD_LOG_METHOD_MQTT,
        NULL,
        outcome == HC_CMD_APPLIED
            ? "switch applied"
            : (outcome == HC_CMD_REJECTED ? "switch rejected" : "switch failed"),
        command_id
    );
}

static void handle_device_cmd(const char *data, int len) {
    char command_id[HC_BOARD_LOG_COMMAND_LEN];
    extract_command_id(data, len, command_id, sizeof(command_id));
    hc_board_log_record(
        HC_BOARD_LOG_KIND_COMMAND,
        HC_BOARD_LOG_STATUS_RECEIVED,
        HC_BOARD_LOG_METHOD_MQTT,
        NULL,
        "device",
        command_id
    );
    hc_cmd_outcome_t outcome = apply_device_command(data, len);
    hc_board_log_record(
        HC_BOARD_LOG_KIND_COMMAND,
        hc_cmd_outcome_status(outcome),
        HC_BOARD_LOG_METHOD_MQTT,
        NULL,
        outcome == HC_CMD_APPLIED
            ? "device applied"
            : (outcome == HC_CMD_REJECTED ? "device rejected" : "device failed"),
        command_id
    );
}

hc_cmd_outcome_t hc_command_apply_outcome(const char *kind, const char *json) {
    if (!kind || !json) return HC_CMD_REJECTED;
    int len = (int)strlen(json);
    if (strcmp(kind, "switch") == 0) return apply_switch_command(json, len);
    if (strcmp(kind, "device") == 0) return apply_device_command(json, len);
    /* An unknown command kind is refused, never executed. */
    ESP_LOGW(TAG, "Unsupported relayed command kind: %s", kind);
    return HC_CMD_REJECTED;
}

bool hc_command_apply(const char *kind, const char *json) {
    return hc_command_apply_outcome(kind, json) == HC_CMD_APPLIED;
}

static void handle_system_cmd(const char *data, int len) {
    cJSON *root = cJSON_ParseWithLength(data, (size_t)len);
    if (!root) return;

    cJSON *act_j = cJSON_GetObjectItem(root, "action");
    if (cJSON_IsString(act_j) && act_j->valuestring) {
        const char *action = act_j->valuestring;
        ESP_LOGW(TAG, "Received remote system action: %s", action);
        {
            char command_id[HC_BOARD_LOG_COMMAND_LEN];
            extract_command_id(data, len, command_id, sizeof(command_id));
            hc_board_log_record(
                HC_BOARD_LOG_KIND_COMMAND,
                HC_BOARD_LOG_STATUS_RECEIVED,
                HC_BOARD_LOG_METHOD_MQTT,
                NULL,
                action,
                command_id
            );
        }

        if (strcmp(action, "restart") == 0) {
            cJSON_Delete(root);
            vTaskDelay(pdMS_TO_TICKS(300));
            esp_restart();
            return;
        } else if (strcmp(action, "reconnect") == 0) {
            s_sync_requested = true;
            hc_mqtt_trigger_reconnect();
        } else if (strcmp(action, "sync_config") == 0) {
            s_sync_requested = true;
        } else if (strcmp(action, "reset") == 0) {
            hc_nvs_factory_reset();
            cJSON_Delete(root);
            vTaskDelay(pdMS_TO_TICKS(300));
            esp_restart();
            return;
        } else if (strcmp(action, "relink_controller") == 0 && s_cfg) {
            // Delivered to a Node that already runs its own EMQX session
            // (standalone fallback): drop the fallback and try ESP-NOW again.
            hc_role_request_relink(s_cfg);
            s_sync_requested = true;
        } else if (strcmp(action, "relink_node") == 0 && s_cfg) {
            // Delivered to a Controller: relay to the named Node over ESP-NOW.
            cJSON *node_j = cJSON_GetObjectItem(root, "node_id");
            if (cJSON_IsString(node_j) && node_j->valuestring) {
                // epoch/seq already travel in the ESP-NOW frame header; keeping
                // them out of the JSON leaves room for the payload.
                static const char cmd[] = "{\"cmd\":\"relink\"}";
                esp_err_t relay = hc_role_relay_command_to_node(s_cfg, node_j->valuestring, cmd);
                ESP_LOGI(TAG, "Relayed re-link to Node %s: %s", node_j->valuestring, esp_err_to_name(relay));
            }
        } else if (strcmp(action, "ota_relay") == 0 && s_cfg) {
            // EMQX-only OTA for a Node that has no MQTT session of its own: the
            // Controller passes the instruction on and the Node opens a
            // temporary Wi-Fi/EMQX window to download the firmware.
            cJSON *node_j = cJSON_GetObjectItem(root, "node_id");
            cJSON *ota_j = cJSON_GetObjectItem(root, "ota");
            if (cJSON_IsString(node_j) && node_j->valuestring && cJSON_IsObject(ota_j)) {
                cJSON *rel_j = cJSON_GetObjectItem(ota_j, "release_id");
                cJSON *hist_j = cJSON_GetObjectItem(ota_j, "history_id");
                cJSON *ver_j = cJSON_GetObjectItem(ota_j, "version");
                char cmd[HC_ESPNOW_MAX_PAYLOAD + 1];
                int n = snprintf(
                    cmd,
                    sizeof(cmd),
                    "{\"cmd\":\"ota\",\"ota\":{\"release_id\":\"%s\",\"history_id\":\"%s\",\"version\":\"%s\"}}",
                    cJSON_IsString(rel_j) ? rel_j->valuestring : "",
                    cJSON_IsString(hist_j) ? hist_j->valuestring : "",
                    cJSON_IsString(ver_j) ? ver_j->valuestring : ""
                );
                if (n <= 0 || (size_t)n > HC_ESPNOW_MAX_PAYLOAD) {
                    ESP_LOGW(TAG, "OTA instruction for Node %s does not fit an ESP-NOW frame", node_j->valuestring);
                } else {
                    esp_err_t relay = hc_role_relay_command_to_node(s_cfg, node_j->valuestring, cmd);
                    ESP_LOGI(TAG, "Relayed OTA to Node %s: %s", node_j->valuestring, esp_err_to_name(relay));
                }
            }
        } else if (strcmp(action, "binding_challenge") == 0 && s_cfg) {
            /* Worker-authorized, single-use challenge. Kept in RAM so it never
             * survives a reboot and is echoed only in live telemetry. */
            cJSON *node_j = cJSON_GetObjectItem(root, "node_id");
            cJSON *cid_j = cJSON_GetObjectItem(root, "challenge_id");
            cJSON *nonce_j = cJSON_GetObjectItem(root, "nonce");
            cJSON *gen_j = cJSON_GetObjectItem(root, "gen");
            if (cJSON_IsString(cid_j) && cid_j->valuestring && cJSON_IsNumber(gen_j)) {
                hc_role_set_binding_challenge(
                    s_cfg,
                    cJSON_IsString(node_j) && node_j->valuestring ? node_j->valuestring : "",
                    cid_j->valuestring,
                    cJSON_IsString(nonce_j) && nonce_j->valuestring ? nonce_j->valuestring : "",
                    (uint32_t)gen_j->valuedouble
                );
            }
        } else if (strcmp(action, "confirm_route") == 0 && s_cfg) {
            hc_role_consume_binding_challenge();
            /* Worker-confirmed route handoff. Relayed to the Node so it may
             * close its own MQTT session only after this point. */
            cJSON *node_j = cJSON_GetObjectItem(root, "node_id");
            cJSON *cid_j = cJSON_GetObjectItem(root, "cid");
            cJSON *gen_j = cJSON_GetObjectItem(root, "gen");
            if (cJSON_IsString(node_j) && node_j->valuestring) {
                char frame[96];
                int n = snprintf(
                    frame,
                    sizeof(frame),
                    "{\"cmd\":\"route_confirm\",\"cid\":\"%s\",\"gen\":%u}",
                    cJSON_IsString(cid_j) && cid_j->valuestring ? cid_j->valuestring : "route",
                    cJSON_IsNumber(gen_j) ? (unsigned)gen_j->valuedouble : 0
                );
                if (n > 0 && (size_t)n < sizeof(frame)) {
                    esp_err_t relay = hc_role_relay_command_to_node(
                        s_cfg, node_j->valuestring, frame
                    );
                    ESP_LOGI(TAG, "Route confirmation relay to %s: %s",
                             node_j->valuestring, relay == ESP_OK ? "ok" : "failed");
                }
            }
        } else if (strcmp(action, "relay_to_node") == 0 && s_cfg) {
            // A Node linked over ESP-NOW keeps no EMQX session of its own, so the
            // Worker sends its switch/device commands to this Controller. We
            // forward a compact frame over ESP-NOW; the Node executes it with the
            // same handler it uses for local MQTT commands.
            cJSON *node_j = cJSON_GetObjectItem(root, "node_id");
            cJSON *kind_j = cJSON_GetObjectItem(root, "kind");
            cJSON *payload_j = cJSON_GetObjectItem(root, "payload");
            cJSON *cid_j = cJSON_GetObjectItem(root, "cid");
            cJSON *gen_j = cJSON_GetObjectItem(root, "gen");
            char cid[48] = {0};
            uint32_t command_gen = 0;
            if (cJSON_IsString(cid_j) && cid_j->valuestring) {
                hc_copy_str(cid, sizeof(cid), cid_j->valuestring);
            }
            if (cJSON_IsNumber(gen_j)) command_gen = (uint32_t)gen_j->valuedouble;
            if (cJSON_IsString(node_j) && node_j->valuestring &&
                cJSON_IsString(kind_j) && kind_j->valuestring &&
                cJSON_IsObject(payload_j)) {
                const char *kind = kind_j->valuestring;
                cJSON *compact = cJSON_CreateObject();
                if (compact) {
                    if (strcmp(kind, "switch") == 0) {
                        cJSON *id_j = cJSON_GetObjectItem(payload_j, "switch_id");
                        cJSON *pin_j = cJSON_GetObjectItem(payload_j, "gpio_pin");
                        cJSON *state_j = cJSON_GetObjectItem(payload_j, "state");
                        cJSON *inv_j = cJSON_GetObjectItem(payload_j, "inverted");
                        if (cJSON_IsString(id_j) && id_j->valuestring) {
                            cJSON_AddStringToObject(compact, "switch_id", id_j->valuestring);
                        }
                        if (cJSON_IsNumber(pin_j)) {
                            cJSON_AddNumberToObject(compact, "gpio_pin", pin_j->valuedouble);
                        }
                        if (cJSON_IsString(state_j) && state_j->valuestring) {
                            cJSON_AddStringToObject(compact, "state", state_j->valuestring);
                        } else if (cJSON_IsBool(state_j)) {
                            cJSON_AddBoolToObject(compact, "state", cJSON_IsTrue(state_j));
                        }
                        if (cJSON_IsBool(inv_j)) {
                            cJSON_AddBoolToObject(compact, "inverted", cJSON_IsTrue(inv_j));
                        }
                    } else if (strcmp(kind, "device") == 0) {
                        cJSON *id_j = cJSON_GetObjectItem(payload_j, "device_id");
                        cJSON *pin_j = cJSON_GetObjectItem(payload_j, "gpio_pin");
                        cJSON *state_j = cJSON_GetObjectItem(payload_j, "state");
                        cJSON *active_j = cJSON_GetObjectItem(payload_j, "active");
                        if (cJSON_IsString(id_j) && id_j->valuestring) {
                            cJSON_AddStringToObject(compact, "device_id", id_j->valuestring);
                        }
                        if (cJSON_IsNumber(pin_j)) {
                            cJSON_AddNumberToObject(compact, "gpio_pin", pin_j->valuedouble);
                        }
                        if (cJSON_IsString(state_j) && state_j->valuestring) {
                            cJSON_AddStringToObject(compact, "state", state_j->valuestring);
                        }
                        if (cJSON_IsBool(active_j)) {
                            cJSON_AddBoolToObject(compact, "active", cJSON_IsTrue(active_j));
                        }
                    }

                    char *payload_str = cJSON_PrintUnformatted(compact);
                    cJSON_Delete(compact);
                    if (payload_str) {
                        // epoch/seq are in the frame header; the Node falls back
                        // to them, so the JSON only needs the command itself.
                        char frame[HC_ESPNOW_MAX_PAYLOAD + 1];
                        int n = cid[0]
                            ? snprintf(
                                frame,
                                sizeof(frame),
                                "{\"cmd\":\"exec\",\"k\":\"%s\",\"p\":%s,\"cid\":\"%s\",\"gen\":%u}",
                                kind,
                                payload_str,
                                cid,
                                (unsigned)command_gen
                            )
                            : snprintf(
                                frame,
                                sizeof(frame),
                                "{\"cmd\":\"exec\",\"k\":\"%s\",\"p\":%s,\"gen\":%u}",
                                kind,
                                payload_str,
                                (unsigned)command_gen
                            );
                        cJSON_free(payload_str);
                        if (n > 0 && (size_t)n <= HC_ESPNOW_MAX_PAYLOAD) {
                            esp_err_t relay =
                                hc_role_relay_command_to_node(s_cfg, node_j->valuestring, frame);
                            if (relay != ESP_OK) {
                                ESP_LOGW(
                                    TAG,
                                    "Failed to relay %s command to Node %s: %s",
                                    kind,
                                    node_j->valuestring,
                                    esp_err_to_name(relay)
                                );
                            } else {
                                ESP_LOGI(TAG, "Relayed %s command to Node %s", kind, node_j->valuestring);
                            }
                        } else {
                            ESP_LOGW(TAG, "Relayed %s command does not fit an ESP-NOW frame", kind);
                        }
                    }
                }
            }
        } else if (strcmp(action, "wifi") == 0 && s_cfg) {
            cJSON *ssid_j = cJSON_GetObjectItem(root, "ssid");
            cJSON *pass_j = cJSON_GetObjectItem(root, "password");
            if (cJSON_IsString(ssid_j) && ssid_j->valuestring) {
                const char *pass = (cJSON_IsString(pass_j) && pass_j->valuestring) ? pass_j->valuestring : "";
                // Update ONLY Wi-Fi credentials while preserving controller identity, pairing, and MQTT creds
                hc_wifi_apply_new_credentials(s_cfg, ssid_j->valuestring, pass);
                s_sync_requested = true;
            }
        }
    }
    cJSON_Delete(root);
}

static void handle_config_snapshot(const char *data, int len) {
    if (!data || len <= 0) return;
    char *copy = malloc((size_t)len + 1);
    if (!copy) return;
    memcpy(copy, data, (size_t)len);
    copy[len] = '\0';

    bool changed = false;
    esp_err_t err = hc_io_apply_config_json(copy, &changed);
    // Roles are applied separately: a role change re-arms the transports.
    if (s_cfg && hc_role_apply_snapshot(s_cfg, copy)) {
        changed = true;
    }
    free(copy);

    if (err == ESP_OK) {
        uint32_t rev = hc_io_get_config_revision();
        const char *hash = hc_io_get_config_hash();
        uint16_t hb = hc_io_get_heartbeat_interval_sec();
        if (changed && s_cfg) {
            s_cfg->config_revision = rev;
            hc_copy_str(s_cfg->config_hash, sizeof(s_cfg->config_hash), hash);
            s_cfg->heartbeat_interval_sec = hb;
            hc_nvs_save_config(s_cfg);
        }
        if (rev > 0) {
            hc_mqtt_publish_config_ack(rev, hash);
        }
    }
}

static void handle_ota_cmd(const char *data, int len) {
    cJSON *root = cJSON_ParseWithLength(data, (size_t)len);
    if (!root) return;

    cJSON *rel_j = cJSON_GetObjectItem(root, "release_id");
    cJSON *hist_j = cJSON_GetObjectItem(root, "history_id");
    cJSON *ver_j = cJSON_GetObjectItem(root, "version");

    if (s_cfg && cJSON_IsString(rel_j) && rel_j->valuestring) {
        hc_ota_start_async(
            s_cfg,
            rel_j->valuestring,
            cJSON_IsString(hist_j) ? hist_j->valuestring : "",
            cJSON_IsString(ver_j) ? ver_j->valuestring : ""
        );
    }
    cJSON_Delete(root);
}

static void mqtt_event_handler(
    void *handler_args,
    esp_event_base_t base,
    int32_t event_id,
    void *event_data
) {
    (void)handler_args;
    (void)base;
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;
    switch ((esp_mqtt_event_id_t)event_id) {
        case MQTT_EVENT_CONNECTED: {
            s_mqtt_connected = true;
            s_last_mqtt_error[0] = '\0';
            if (s_cfg && s_cfg->config_revision == 0) {
                s_sync_requested = true;
            }
            ESP_LOGI(TAG, "Connected to EMQX TLS broker (session_present=%d)", event->session_present);

            if (!event->session_present) {
                char sub_topic[224];
                snprintf(sub_topic, sizeof(sub_topic), "%s/cmd/#", s_cfg->topic_prefix);
                esp_mqtt_client_subscribe(s_client, sub_topic, 1);

                snprintf(sub_topic, sizeof(sub_topic), "%s/ota/cmd", s_cfg->topic_prefix);
                esp_mqtt_client_subscribe(s_client, sub_topic, 1);

                snprintf(sub_topic, sizeof(sub_topic), "%s/config/snapshot", s_cfg->topic_prefix);
                esp_mqtt_client_subscribe(s_client, sub_topic, 1);
            }

            hc_mqtt_publish_status("online");
            break;
        }
        case MQTT_EVENT_DISCONNECTED:
            s_mqtt_connected = false;
            ESP_LOGW(TAG, "Disconnected from EMQX broker");
            break;
        case MQTT_EVENT_ERROR:
            s_mqtt_connected = false;
            if (event->error_handle) {
                snprintf(
                    s_last_mqtt_error,
                    sizeof(s_last_mqtt_error),
                    "MQTT error type=%d tls=%d sock=%d conn_rc=%d",
                    (int)event->error_handle->error_type,
                    event->error_handle->esp_tls_last_esp_err,
                    event->error_handle->esp_transport_sock_errno,
                    (int)event->error_handle->connect_return_code
                );
            } else {
                hc_copy_str(s_last_mqtt_error, sizeof(s_last_mqtt_error), "MQTT broker connection failed");
            }
            ESP_LOGW(TAG, "%s", s_last_mqtt_error);
            break;
        case MQTT_EVENT_DATA: {
            if (!event->topic || event->topic_len <= 0) break;
            char topic[224];
            int tlen = event->topic_len < (int)sizeof(topic) - 1 ? event->topic_len : (int)sizeof(topic) - 1;
            memcpy(topic, event->topic, (size_t)tlen);
            topic[tlen] = '\0';

            if (strstr(topic, "/cmd/switch")) {
                handle_switch_cmd(event->data, event->data_len);
            } else if (strstr(topic, "/cmd/device")) {
                handle_device_cmd(event->data, event->data_len);
            } else if (strstr(topic, "/cmd/system")) {
                handle_system_cmd(event->data, event->data_len);
            } else if (strstr(topic, "/ota/cmd")) {
                handle_ota_cmd(event->data, event->data_len);
            } else if (strstr(topic, "/config/snapshot")) {
                handle_config_snapshot(event->data, event->data_len);
            }
            break;
        }
        default:
            break;
    }
}

void hc_mqtt_publish_status(const char *status_str) {
    if (!s_client || !s_mqtt_connected || !s_cfg) return;
    char topic[224];
    snprintf(topic, sizeof(topic), "%s/status/online", s_cfg->topic_prefix);
    cJSON *root = cJSON_CreateObject();
    if (!root) return;
    cJSON_AddStringToObject(root, "status", status_str ? status_str : "unknown");
    cJSON_AddStringToObject(root, "firmware", hc_get_runtime_fw_version());
    if (s_cfg->config_revision > 0) {
        cJSON_AddNumberToObject(root, "rev", (double)s_cfg->config_revision);
    }
    char *payload = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!payload) return;
    esp_mqtt_client_publish(s_client, topic, payload, 0, 1, 0);
    cJSON_free(payload);
}

void hc_mqtt_publish_ota_progress(const char *history_id, const char *status, int progress_pct) {
    if (!s_client || !s_mqtt_connected || !s_cfg) return;
    char topic[224];
    snprintf(topic, sizeof(topic), "%s/ota/progress", s_cfg->topic_prefix);
    cJSON *root = cJSON_CreateObject();
    if (!root) return;
    if (history_id && strlen(history_id) > 0) {
        cJSON_AddStringToObject(root, "history_id", history_id);
    }
    cJSON_AddStringToObject(root, "status", status ? status : "flashing");
    cJSON_AddNumberToObject(root, "progress_percent", progress_pct);
    cJSON_AddStringToObject(root, "firmware_version", hc_get_runtime_fw_version());
    char *payload = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!payload) return;
    esp_mqtt_client_publish(s_client, topic, payload, 0, 0, 0);
    cJSON_free(payload);
}

void hc_mqtt_publish_config_ack(uint32_t revision, const char *hash) {
    if (!s_client || !s_mqtt_connected || !s_cfg || revision == 0) return;
    char topic[224];
    snprintf(topic, sizeof(topic), "%s/config/ack", s_cfg->topic_prefix);
    cJSON *root = cJSON_CreateObject();
    if (!root) return;
    cJSON_AddNumberToObject(root, "revision", (double)revision);
    if (hash && strlen(hash) > 0) {
        cJSON_AddStringToObject(root, "hash", hash);
    }
    char *payload = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!payload) return;
    esp_mqtt_client_publish(s_client, topic, payload, 0, 1, 0);
    cJSON_free(payload);
}

void hc_mqtt_publish_telemetry(const char *json_payload) {
    if (!s_client || !s_mqtt_connected || !s_cfg) return;
    char topic[224];
    snprintf(topic, sizeof(topic), "%s/telemetry/sensors", s_cfg->topic_prefix);
    esp_mqtt_client_publish(s_client, topic, json_payload, 0, 0, 0);
}

esp_err_t hc_mqtt_start(homecore_config_t *cfg) {
    if (!cfg || !cfg->paired || strlen(cfg->mqtt_host) == 0) {
        return ESP_ERR_INVALID_STATE;
    }
    hc_mqtt_stop();
    s_cfg = cfg;

    static char broker_uri[256];
    snprintf(
        broker_uri,
        sizeof(broker_uri),
        "%s://%s:%u",
        cfg->mqtt_tls ? "mqtts" : "mqtt",
        cfg->mqtt_host,
        cfg->mqtt_port
    );

    static char lwt_topic[224];
    snprintf(lwt_topic, sizeof(lwt_topic), "%s/status/online", cfg->topic_prefix);
    static const char *lwt_msg = "{\"status\":\"offline\"}";

    esp_mqtt_client_config_t mqtt_cfg = {
        .broker.address.uri = broker_uri,
        .broker.verification.crt_bundle_attach = cfg->mqtt_tls ? esp_crt_bundle_attach : NULL,
        .credentials.username = cfg->mqtt_username,
        .credentials.client_id = cfg->mqtt_client_id,
        .credentials.authentication.password = cfg->mqtt_password,
        .session.disable_clean_session = true,
        .session.last_will.topic = lwt_topic,
        .session.last_will.msg = lwt_msg,
        .session.last_will.msg_len = (int)strlen(lwt_msg),
        .session.last_will.qos = 1,
        .session.last_will.retain = 0,
        .network.disable_auto_reconnect = false,
        .network.reconnect_timeout_ms = 5000,
    };

    s_client = esp_mqtt_client_init(&mqtt_cfg);
    esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
    return esp_mqtt_client_start(s_client);
}
