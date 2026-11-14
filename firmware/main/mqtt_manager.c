#include "homecore_config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_system.h"
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

static void handle_switch_cmd(const char *data, int len) {
    cJSON *root = cJSON_ParseWithLength(data, (size_t)len);
    if (!root) return;

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
        hc_io_drive_pin(id_j->valuestring, HC_IO_KIND_SWITCH, (uint8_t)pin_j->valueint, inv, on);
        ESP_LOGI(TAG, "Switch %s (GPIO %d) -> %s", id_j->valuestring, pin_j->valueint, on ? "ON" : "OFF");
    }
    cJSON_Delete(root);
}

static void handle_device_cmd(const char *data, int len) {
    cJSON *root = cJSON_ParseWithLength(data, (size_t)len);
    if (!root) return;

    cJSON *id_j = cJSON_GetObjectItem(root, "device_id");
    cJSON *pin_j = cJSON_GetObjectItem(root, "gpio_pin");
    cJSON *state_j = cJSON_GetObjectItem(root, "state");
    cJSON *active_j = cJSON_GetObjectItem(root, "active");

    if (cJSON_IsString(id_j) && cJSON_IsNumber(pin_j) &&
        (cJSON_IsString(state_j) || cJSON_IsBool(active_j))) {
        bool active = cJSON_IsBool(active_j)
            ? cJSON_IsTrue(active_j)
            : hc_io_parse_bool_state(state_j->valuestring, false);
        hc_io_drive_pin(id_j->valuestring, HC_IO_KIND_DEVICE, (uint8_t)pin_j->valueint, false, active);
        ESP_LOGI(TAG, "Device %s (GPIO %d) -> %s (%s)",
            id_j->valuestring,
            pin_j->valueint,
            cJSON_IsString(state_j) ? state_j->valuestring : (active ? "active" : "inactive"),
            active ? "HIGH" : "LOW");
    }
    cJSON_Delete(root);
}

static void handle_system_cmd(const char *data, int len) {
    cJSON *root = cJSON_ParseWithLength(data, (size_t)len);
    if (!root) return;

    cJSON *act_j = cJSON_GetObjectItem(root, "action");
    if (cJSON_IsString(act_j) && act_j->valuestring) {
        const char *action = act_j->valuestring;
        ESP_LOGW(TAG, "Received remote system action: %s", action);

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
