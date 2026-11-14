#include "homecore_config.h"

#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "esp_random.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "hc_nvs";

esp_err_t hc_nvs_init(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "Erasing NVS flash due to partition version mismatch");
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    return err;
}

static void read_str_or_empty(nvs_handle_t h, const char *key, char *out, size_t max_len) {
    size_t len = max_len;
    if (nvs_get_str(h, key, out, &len) != ESP_OK) {
        out[0] = '\0';
    }
}

void hc_nvs_ensure_identity_key(homecore_config_t *cfg) {
    if (!cfg || strlen(cfg->identity_key) >= 32) {
        return;
    }
    uint8_t raw[32];
    esp_fill_random(raw, sizeof(raw));
    for (size_t i = 0; i < sizeof(raw); i++) {
        snprintf(&cfg->identity_key[i * 2], 3, "%02x", raw[i]);
    }
    cfg->identity_key[64] = '\0';
    hc_nvs_save_config(cfg);
    ESP_LOGI(TAG, "Generated persistent controller hardware identity key");
}

void hc_nvs_ensure_setup_pin(homecore_config_t *cfg) {
    if (!cfg || strlen(cfg->setup_pin) >= 8) {
        return;
    }
    static const char charset[] = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    uint8_t raw[8];
    esp_fill_random(raw, sizeof(raw));
    for (size_t i = 0; i < 8; i++) {
        cfg->setup_pin[i] = charset[raw[i] % (sizeof(charset) - 1)];
    }
    cfg->setup_pin[8] = '\0';
    hc_nvs_save_config(cfg);
    ESP_LOGI(TAG, "Generated unique per-controller setup PIN / AP passphrase");
}

esp_err_t hc_nvs_set_recovery_boot_req(bool req) {
    nvs_handle_t h;
    esp_err_t err = nvs_open(HOMECORE_NVS_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_u8(h, "rec_req", req ? 1 : 0);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

esp_err_t hc_nvs_load_config(homecore_config_t *out) {
    memset(out, 0, sizeof(*out));
    out->mqtt_port = 8883;
    out->mqtt_tls = true;
    out->heartbeat_interval_sec = HOMECORE_DEFAULT_HEARTBEAT_SEC;

    nvs_handle_t h;
    esp_err_t err = nvs_open(HOMECORE_NVS_NAMESPACE, NVS_READONLY, &h);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        hc_nvs_ensure_identity_key(out);
        hc_nvs_ensure_setup_pin(out);
        return ESP_OK;
    }
    if (err != ESP_OK) {
        return err;
    }

    read_str_or_empty(h, "wifi_ssid", out->wifi_ssid, sizeof(out->wifi_ssid));
    read_str_or_empty(h, "wifi_pass", out->wifi_pass, sizeof(out->wifi_pass));
    read_str_or_empty(h, "backend_url", out->backend_url, sizeof(out->backend_url));
    read_str_or_empty(h, "pair_code", out->pending_pair_code, sizeof(out->pending_pair_code));
    read_str_or_empty(h, "ident_key", out->identity_key, sizeof(out->identity_key));
    read_str_or_empty(h, "setup_pin", out->setup_pin, sizeof(out->setup_pin));
    read_str_or_empty(h, "prov_tx", out->prov_transport, sizeof(out->prov_transport));
    read_str_or_empty(h, "conf_meth", out->confirm_method, sizeof(out->confirm_method));

    uint8_t paired_u8 = 0;
    if (nvs_get_u8(h, "paired", &paired_u8) == ESP_OK) {
        out->paired = (paired_u8 == 1);
    }
    uint8_t rec_u8 = 0;
    if (nvs_get_u8(h, "rec_mode", &rec_u8) == ESP_OK) {
        out->recovery_mode = (rec_u8 == 1);
    }
    uint8_t rec_req_u8 = 0;
    if (nvs_get_u8(h, "rec_req", &rec_req_u8) == ESP_OK) {
        out->recovery_boot_req = (rec_req_u8 == 1);
    }
    uint8_t phys_u8 = 0;
    if (nvs_get_u8(h, "phys_conf", &phys_u8) == ESP_OK) {
        out->physical_confirmed = (phys_u8 == 1);
    }

    read_str_or_empty(h, "account_id", out->account_id, sizeof(out->account_id));
    read_str_or_empty(h, "ctrl_id", out->controller_id, sizeof(out->controller_id));
    read_str_or_empty(h, "mqtt_host", out->mqtt_host, sizeof(out->mqtt_host));
    uint16_t port_u16 = 8883;
    if (nvs_get_u16(h, "mqtt_port", &port_u16) == ESP_OK) {
        out->mqtt_port = port_u16;
    }
    uint8_t tls_u8 = 1;
    if (nvs_get_u8(h, "mqtt_tls", &tls_u8) == ESP_OK) {
        out->mqtt_tls = (tls_u8 == 1);
    }
    read_str_or_empty(h, "mqtt_user", out->mqtt_username, sizeof(out->mqtt_username));
    read_str_or_empty(h, "mqtt_pass", out->mqtt_password, sizeof(out->mqtt_password));
    read_str_or_empty(h, "mqtt_cid", out->mqtt_client_id, sizeof(out->mqtt_client_id));
    read_str_or_empty(h, "topic_pfx", out->topic_prefix, sizeof(out->topic_prefix));
    read_str_or_empty(h, "dev_token", out->device_api_token, sizeof(out->device_api_token));
    uint32_t rev_u32 = 0;
    if (nvs_get_u32(h, "cfg_rev", &rev_u32) == ESP_OK) {
        out->config_revision = rev_u32;
    }
    read_str_or_empty(h, "cfg_hash", out->config_hash, sizeof(out->config_hash));
    uint16_t hb_u16 = HOMECORE_DEFAULT_HEARTBEAT_SEC;
    if (nvs_get_u16(h, "hb_sec", &hb_u16) == ESP_OK && hb_u16 >= 30 && hb_u16 <= 300) {
        out->heartbeat_interval_sec = hb_u16;
    }

    nvs_close(h);
    hc_nvs_ensure_identity_key(out);
    hc_nvs_ensure_setup_pin(out);
    return ESP_OK;
}

esp_err_t hc_nvs_save_config(const homecore_config_t *cfg) {
    nvs_handle_t h;
    esp_err_t err = nvs_open(HOMECORE_NVS_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }

    nvs_set_str(h, "wifi_ssid", cfg->wifi_ssid);
    nvs_set_str(h, "wifi_pass", cfg->wifi_pass);
    nvs_set_str(h, "backend_url", cfg->backend_url);
    nvs_set_str(h, "pair_code", cfg->pending_pair_code);
    nvs_set_str(h, "ident_key", cfg->identity_key);
    nvs_set_str(h, "setup_pin", cfg->setup_pin);
    nvs_set_str(h, "prov_tx", cfg->prov_transport);
    nvs_set_str(h, "conf_meth", cfg->confirm_method);
    nvs_set_u8(h, "rec_mode", cfg->recovery_mode ? 1 : 0);
    nvs_set_u8(h, "rec_req", cfg->recovery_boot_req ? 1 : 0);
    nvs_set_u8(h, "phys_conf", cfg->physical_confirmed ? 1 : 0);
    nvs_set_u8(h, "paired", cfg->paired ? 1 : 0);
    nvs_set_str(h, "account_id", cfg->account_id);
    nvs_set_str(h, "ctrl_id", cfg->controller_id);
    nvs_set_str(h, "mqtt_host", cfg->mqtt_host);
    nvs_set_u16(h, "mqtt_port", cfg->mqtt_port);
    nvs_set_u8(h, "mqtt_tls", cfg->mqtt_tls ? 1 : 0);
    nvs_set_str(h, "mqtt_user", cfg->mqtt_username);
    nvs_set_str(h, "mqtt_pass", cfg->mqtt_password);
    nvs_set_str(h, "mqtt_cid", cfg->mqtt_client_id);
    nvs_set_str(h, "topic_pfx", cfg->topic_prefix);
    nvs_set_str(h, "dev_token", cfg->device_api_token);
    nvs_set_u32(h, "cfg_rev", cfg->config_revision);
    nvs_set_str(h, "cfg_hash", cfg->config_hash);
    nvs_set_u16(h, "hb_sec", cfg->heartbeat_interval_sec >= 30 ? cfg->heartbeat_interval_sec : HOMECORE_DEFAULT_HEARTBEAT_SEC);

    err = nvs_commit(h);
    nvs_close(h);
    return err;
}

esp_err_t hc_nvs_clear_pairing(homecore_config_t *cfg) {
    // Keep identity_key, wifi_ssid, wifi_pass, and backend_url separate from MQTT/pairing credentials
    cfg->paired = false;
    cfg->pending_pair_code[0] = '\0';
    cfg->recovery_mode = false;
    cfg->physical_confirmed = false;
    cfg->confirm_method[0] = '\0';
    cfg->account_id[0] = '\0';
    cfg->controller_id[0] = '\0';
    cfg->mqtt_host[0] = '\0';
    cfg->mqtt_username[0] = '\0';
    cfg->mqtt_password[0] = '\0';
    cfg->mqtt_client_id[0] = '\0';
    cfg->topic_prefix[0] = '\0';
    cfg->device_api_token[0] = '\0';
    cfg->config_revision = 0;
    cfg->config_hash[0] = '\0';
    cfg->heartbeat_interval_sec = HOMECORE_DEFAULT_HEARTBEAT_SEC;
    return hc_nvs_save_config(cfg);
}

esp_err_t hc_nvs_factory_reset(void) {
    nvs_handle_t h;
    esp_err_t err = nvs_open(HOMECORE_NVS_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_erase_all(h);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    return err;
}

esp_err_t hc_nvs_load_io_json(char *buf, size_t max_len) {
    buf[0] = '\0';
    nvs_handle_t h;
    esp_err_t err = nvs_open(HOMECORE_NVS_NAMESPACE, NVS_READONLY, &h);
    if (err != ESP_OK) {
        return err;
    }
    size_t len = max_len;
    err = nvs_get_str(h, "io_cfg", buf, &len);
    nvs_close(h);
    return err;
}

esp_err_t hc_nvs_save_io_json(const char *json) {
    nvs_handle_t h;
    esp_err_t err = nvs_open(HOMECORE_NVS_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_str(h, "io_cfg", json);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    return err;
}

bool hc_nvs_health_check(void) {
    nvs_handle_t h;
    esp_err_t err = nvs_open(HOMECORE_NVS_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return false;
    }
    nvs_close(h);
    return true;
}

esp_err_t hc_nvs_save_ota_pending(const hc_ota_pending_t *pend) {
    if (!pend) return ESP_ERR_INVALID_ARG;
    nvs_handle_t h;
    esp_err_t err = nvs_open(HOMECORE_NVS_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    nvs_set_u8(h, "ota_pend", 1);
    nvs_set_u8(h, "ota_st", pend->state);
    nvs_set_u8(h, "ota_bc", pend->boot_count);
    nvs_set_str(h, "ota_hist", pend->history_id);
    nvs_set_str(h, "ota_rel", pend->release_id);
    nvs_set_str(h, "ota_ver", pend->target_version);
    nvs_set_u32(h, "ota_prev", pend->prev_part_addr);
    nvs_set_u32(h, "ota_tgt", pend->target_part_addr);
    nvs_set_str(h, "ota_diag", pend->diag_msg);
    err = nvs_commit(h);
    nvs_close(h);
    return err;
}

bool hc_nvs_load_ota_pending(hc_ota_pending_t *out) {
    if (!out) return false;
    memset(out, 0, sizeof(*out));

    nvs_handle_t h;
    if (nvs_open(HOMECORE_NVS_NAMESPACE, NVS_READONLY, &h) != ESP_OK) {
        return false;
    }
    uint8_t pend = 0;
    if (nvs_get_u8(h, "ota_pend", &pend) != ESP_OK || pend != 1) {
        nvs_close(h);
        return false;
    }
    out->active = true;
    uint8_t st = HC_OTA_PEND_REBOOT_PENDING;
    if (nvs_get_u8(h, "ota_st", &st) == ESP_OK) {
        out->state = st;
    } else {
        out->state = HC_OTA_PEND_REBOOT_PENDING;
    }
    uint8_t bc = 0;
    if (nvs_get_u8(h, "ota_bc", &bc) == ESP_OK) {
        out->boot_count = bc;
    }
    read_str_or_empty(h, "ota_hist", out->history_id, sizeof(out->history_id));
    read_str_or_empty(h, "ota_rel", out->release_id, sizeof(out->release_id));
    read_str_or_empty(h, "ota_ver", out->target_version, sizeof(out->target_version));
    uint32_t prev = 0;
    if (nvs_get_u32(h, "ota_prev", &prev) == ESP_OK) {
        out->prev_part_addr = prev;
    }
    uint32_t tgt = 0;
    if (nvs_get_u32(h, "ota_tgt", &tgt) == ESP_OK) {
        out->target_part_addr = tgt;
    }
    read_str_or_empty(h, "ota_diag", out->diag_msg, sizeof(out->diag_msg));
    nvs_close(h);
    return true;
}

esp_err_t hc_nvs_clear_ota_pending(void) {
    nvs_handle_t h;
    esp_err_t err = nvs_open(HOMECORE_NVS_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    nvs_erase_key(h, "ota_pend");
    nvs_erase_key(h, "ota_st");
    nvs_erase_key(h, "ota_bc");
    nvs_erase_key(h, "ota_hist");
    nvs_erase_key(h, "ota_rel");
    nvs_erase_key(h, "ota_ver");
    nvs_erase_key(h, "ota_prev");
    nvs_erase_key(h, "ota_tgt");
    nvs_erase_key(h, "ota_diag");
    err = nvs_commit(h);
    nvs_close(h);
    return err;
}
