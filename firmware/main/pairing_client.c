#include "homecore_config.h"
#include "sdkconfig.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#if HOMECORE_HAS_WIFI
#include "esp_wifi.h"
#endif

static const char *TAG = "hc_pairing";

typedef struct {
    char *buf;
    size_t len;
    size_t cap;
} http_resp_acc_t;

static esp_err_t http_event_cb(esp_http_client_event_t *evt) {
    http_resp_acc_t *acc = (http_resp_acc_t *)evt->user_data;
    if (!acc) return ESP_OK;

    if (evt->event_id == HTTP_EVENT_ON_DATA && evt->data_len > 0) {
        if (acc->len + evt->data_len + 1 > acc->cap) {
            size_t next_cap = (acc->cap == 0 ? 1024 : acc->cap * 2) + evt->data_len;
            if (next_cap > 16384) return ESP_ERR_NO_MEM;
            char *next = realloc(acc->buf, next_cap);
            if (!next) return ESP_ERR_NO_MEM;
            acc->buf = next;
            acc->cap = next_cap;
        }
        memcpy(acc->buf + acc->len, evt->data, evt->data_len);
        acc->len += evt->data_len;
        acc->buf[acc->len] = '\0';
    }
    return ESP_OK;
}

static void copy_json_str(cJSON *obj, const char *key, char *dst, size_t max_len) {
    cJSON *item = cJSON_GetObjectItem(obj, key);
    if (cJSON_IsString(item) && item->valuestring) {
        hc_copy_str(dst, max_len, item->valuestring);
    }
}

void hc_net_get_sta_ip(char *out, size_t max_len) {
    snprintf(out, max_len, "0.0.0.0");
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (!netif) return;
    esp_netif_ip_info_t ip_info;
    if (esp_netif_get_ip_info(netif, &ip_info) == ESP_OK) {
        snprintf(out, max_len, IPSTR, IP2STR(&ip_info.ip));
    }
}

static void get_sta_ip_str(char *out, size_t max_len) {
    hc_net_get_sta_ip(out, max_len);
}

static esp_err_t perform_http_json(
    const homecore_config_t *cfg,
    esp_http_client_method_t method,
    const char *path,
    const char *json_body,
    bool with_bearer,
    char **out_resp_buf
) {
    if (!cfg || strlen(cfg->backend_url) == 0 || !hc_wifi_is_connected()) {
        return ESP_ERR_INVALID_STATE;
    }
    if (with_bearer && strlen(cfg->device_api_token) == 0) {
        return ESP_ERR_INVALID_STATE;
    }

    char url[320];
    int n = snprintf(url, sizeof(url), "%s%s", cfg->backend_url, path);
    if (n < 0 || (size_t)n >= sizeof(url)) {
        return ESP_ERR_INVALID_SIZE;
    }

    http_resp_acc_t acc = {0};
    esp_http_client_config_t http_cfg = {
        .url = url,
        .method = method,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .event_handler = http_event_cb,
        .user_data = &acc,
        .timeout_ms = 12000,
    };

    esp_http_client_handle_t client = esp_http_client_init(&http_cfg);
    if (!client) return ESP_ERR_NO_MEM;

    if (json_body) {
        esp_http_client_set_header(client, "Content-Type", "application/json");
        esp_http_client_set_post_field(client, json_body, strlen(json_body));
    }

    if (with_bearer) {
        char auth[192];
        snprintf(auth, sizeof(auth), "Bearer %s", cfg->device_api_token);
        esp_http_client_set_header(client, "Authorization", auth);
    }

    esp_err_t err = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);

    if (err != ESP_OK || status < 200 || status >= 300) {
        ESP_LOGW(TAG, "HTTP %s failed (err=%s, status=%d)", path, esp_err_to_name(err), status);
        free(acc.buf);
        return ESP_FAIL;
    }

    if (out_resp_buf) {
        *out_resp_buf = acc.buf;
    } else {
        free(acc.buf);
    }
    return ESP_OK;
}

esp_err_t hc_pairing_claim_if_needed(homecore_config_t *cfg) {
    if (cfg->paired) {
        return ESP_OK;
    }
    if (strlen(cfg->pending_pair_code) != 6 || strlen(cfg->backend_url) == 0) {
        return ESP_ERR_INVALID_STATE;
    }
    if (cfg->recovery_mode && !cfg->physical_confirmed) {
        ESP_LOGW(TAG, "Recovery pairing awaiting physical confirmation");
        return ESP_ERR_INVALID_STATE;
    }

    hc_nvs_ensure_identity_key(cfg);

    char uid[24];
    hc_wifi_get_mac_uid(uid, sizeof(uid));

    char ip_str[20];
    get_sta_ip_str(ip_str, sizeof(ip_str));

    cJSON *req_json = cJSON_CreateObject();
    if (!req_json) return ESP_ERR_NO_MEM;

    cJSON_AddStringToObject(req_json, "pairingCode", cfg->pending_pair_code);
    cJSON_AddStringToObject(req_json, "macAddress", uid);
    cJSON_AddStringToObject(req_json, "identityKey", cfg->identity_key);
    if (cfg->recovery_mode) {
        cJSON_AddBoolToObject(req_json, "physicalConfirmed", cfg->physical_confirmed);
        cJSON_AddStringToObject(
            req_json,
            "physicalConfirmationMethod",
            strlen(cfg->confirm_method) > 0 ? cfg->confirm_method : "local_portal"
        );
    }
    cJSON_AddStringToObject(req_json, "firmwareVersion", hc_get_runtime_fw_version());
    cJSON_AddStringToObject(req_json, "chipVariant", CONFIG_IDF_TARGET);
    cJSON_AddStringToObject(req_json, "boardSlug", HOMECORE_BOARD_SLUG);
    cJSON_AddStringToObject(req_json, "partitionScheme", HOMECORE_PARTITION_SCHEME);
    cJSON_AddNumberToObject(req_json, "flashSizeMb", HOMECORE_FLASH_SIZE_MB);
    cJSON_AddNumberToObject(req_json, "psramSizeMb", HOMECORE_PSRAM_SIZE_MB);
    cJSON_AddStringToObject(req_json, "wifiSsid", cfg->wifi_ssid);
    cJSON_AddStringToObject(req_json, "localIp", ip_str);
    if (strlen(cfg->setup_pin) >= 6) {
        cJSON_AddStringToObject(req_json, "bleSetupPin", cfg->setup_pin);
    }
    if (strlen(cfg->prov_transport) > 0) {
        cJSON_AddStringToObject(req_json, "provisioningTransport", cfg->prov_transport);
    }

    char *body = cJSON_PrintUnformatted(req_json);
    cJSON_Delete(req_json);
    if (!body) return ESP_ERR_NO_MEM;

    char *resp_buf = NULL;
    const char *endpoint = cfg->recovery_mode ? "/api/device/recover-pair" : "/api/device/pair";
    esp_err_t err = perform_http_json(cfg, HTTP_METHOD_POST, endpoint, body, false, &resp_buf);
    cJSON_free(body);

    if (err != ESP_OK || !resp_buf) {
        free(resp_buf);
        return ESP_FAIL;
    }

    cJSON *root = cJSON_Parse(resp_buf);
    free(resp_buf);
    if (!root) return ESP_FAIL;

    copy_json_str(root, "controller_id", cfg->controller_id, sizeof(cfg->controller_id));
    copy_json_str(root, "account_id", cfg->account_id, sizeof(cfg->account_id));
    copy_json_str(root, "broker_host", cfg->mqtt_host, sizeof(cfg->mqtt_host));
    cJSON *port = cJSON_GetObjectItem(root, "tls_port");
    if (cJSON_IsNumber(port)) cfg->mqtt_port = (uint16_t)port->valueint;
    cfg->mqtt_tls = true;
    copy_json_str(root, "mqtt_username", cfg->mqtt_username, sizeof(cfg->mqtt_username));
    copy_json_str(root, "mqtt_password", cfg->mqtt_password, sizeof(cfg->mqtt_password));
    copy_json_str(root, "mqtt_client_id", cfg->mqtt_client_id, sizeof(cfg->mqtt_client_id));
    copy_json_str(root, "topic_prefix", cfg->topic_prefix, sizeof(cfg->topic_prefix));
    copy_json_str(root, "device_api_token", cfg->device_api_token, sizeof(cfg->device_api_token));

    cJSON *cfg_obj = cJSON_GetObjectItem(root, "config");
    if (cJSON_IsObject(cfg_obj)) {
        char *cfg_str = cJSON_PrintUnformatted(cfg_obj);
        if (cfg_str) {
            bool changed = false;
            hc_io_apply_config_json(cfg_str, &changed);
            cJSON_free(cfg_str);
            cfg->config_revision = hc_io_get_config_revision();
            hc_copy_str(cfg->config_hash, sizeof(cfg->config_hash), hc_io_get_config_hash());
            cfg->heartbeat_interval_sec = hc_io_get_heartbeat_interval_sec();
        }
    }
    cJSON_Delete(root);

    if (strlen(cfg->controller_id) == 0 || strlen(cfg->mqtt_host) == 0 || strlen(cfg->device_api_token) == 0) {
        ESP_LOGE(TAG, "Pairing response missing required broker/token fields");
        return ESP_FAIL;
    }

    cfg->paired = true;
    cfg->pending_pair_code[0] = '\0';
    cfg->recovery_mode = false;
    cfg->physical_confirmed = false;
    cfg->confirm_method[0] = '\0';
    hc_nvs_save_config(cfg);
    ESP_LOGI(TAG, "Controller paired & synced successfully! ID=%s", cfg->controller_id);
    return ESP_OK;
}

esp_err_t hc_http_fetch_config(homecore_config_t *cfg) {
    if (!cfg || !cfg->paired) return ESP_ERR_INVALID_STATE;
    char path[96];
    if (cfg->config_revision > 0) {
        snprintf(path, sizeof(path), "/api/device/config?knownRevision=%lu", (unsigned long)cfg->config_revision);
    } else {
        snprintf(path, sizeof(path), "/api/device/config");
    }
    char *resp_buf = NULL;
    esp_err_t err = perform_http_json(cfg, HTTP_METHOD_GET, path, NULL, true, &resp_buf);
    if (err != ESP_OK || !resp_buf) {
        free(resp_buf);
        return err;
    }
    bool changed = false;
    esp_err_t apply_err = hc_io_apply_config_json(resp_buf, &changed);
    free(resp_buf);
    if (apply_err == ESP_OK && changed) {
        cfg->config_revision = hc_io_get_config_revision();
        hc_copy_str(cfg->config_hash, sizeof(cfg->config_hash), hc_io_get_config_hash());
        cfg->heartbeat_interval_sec = hc_io_get_heartbeat_interval_sec();
        hc_nvs_save_config(cfg);
    }
    return apply_err;
}

esp_err_t hc_http_post_heartbeat(homecore_config_t *cfg) {
    if (!cfg || !cfg->paired) return ESP_ERR_INVALID_STATE;
    char ip_str[20];
    get_sta_ip_str(ip_str, sizeof(ip_str));

    int rssi = -60;
#if HOMECORE_HAS_WIFI
    wifi_ap_record_t ap_info;
    if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
        rssi = ap_info.rssi;
    }
#endif

    const char *mqtt_err = hc_mqtt_get_last_error();
    const char *wifi_err = hc_wifi_get_last_error();
    const char *reported_err = (mqtt_err && strlen(mqtt_err) > 0)
        ? mqtt_err
        : (wifi_err && strlen(wifi_err) > 0 ? wifi_err : NULL);

    // Compact JSON keys minimize payload bandwidth while staying accepted by Worker
    cJSON *root = cJSON_CreateObject();
    if (!root) return ESP_ERR_NO_MEM;
    cJSON_AddNumberToObject(root, "r", rssi);
    cJSON_AddStringToObject(root, "s", cfg->wifi_ssid);
    cJSON_AddStringToObject(root, "ip", ip_str);
    cJSON_AddStringToObject(root, "v", hc_get_runtime_fw_version());
    cJSON_AddStringToObject(root, "b", HOMECORE_BOARD_SLUG);
    cJSON_AddStringToObject(root, "ps", HOMECORE_PARTITION_SCHEME);
    cJSON_AddBoolToObject(root, "w", hc_wifi_is_connected());
    cJSON_AddBoolToObject(root, "m", hc_mqtt_is_connected());
    cJSON_AddBoolToObject(root, "bp", hc_ble_prov_is_active());
    if (hc_ota_is_bootloader_pending_verify()) {
        cJSON_AddBoolToObject(root, "op", true);
    }
    cJSON_AddNumberToObject(root, "rev", (double)cfg->config_revision);
    if (reported_err) {
        cJSON_AddStringToObject(root, "err", reported_err);
    }

    char *payload = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!payload) return ESP_ERR_NO_MEM;

    char *resp_buf = NULL;
    esp_err_t res = perform_http_json(cfg, HTTP_METHOD_POST, "/api/device/heartbeat", payload, true, &resp_buf);
    cJSON_free(payload);

    if (res == ESP_OK && resp_buf) {
        cJSON *resp_j = cJSON_Parse(resp_buf);
        if (resp_j) {
            cJSON *srv_rev_j = cJSON_GetObjectItem(resp_j, "config_revision");
            cJSON *pub_j = cJSON_GetObjectItem(resp_j, "sync_published");
            uint32_t srv_rev = cJSON_IsNumber(srv_rev_j) ? (uint32_t)srv_rev_j->valuedouble : 0;
            bool sync_pub = cJSON_IsBool(pub_j) && cJSON_IsTrue(pub_j);
            cJSON_Delete(resp_j);

            // If server reports a newer revision and couldn't push via MQTT, fetch via HTTP fallback
            if (srv_rev > cfg->config_revision && !sync_pub) {
                hc_http_fetch_config(cfg);
            }
        }
    }
    free(resp_buf);
    return res;
}

esp_err_t hc_http_post_telemetry(const homecore_config_t *cfg, const char *json_payload) {
    if (!cfg || !cfg->paired || !json_payload) return ESP_ERR_INVALID_STATE;
    return perform_http_json(cfg, HTTP_METHOD_POST, "/api/device/telemetry", json_payload, true, NULL);
}
