#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include "esp_err.h"
#include "io_state_logic.h"
#include "provisioning_logic.h"
#include "sdkconfig.h"

static inline void hc_copy_str(char *dst, size_t dst_cap, const char *src) {
    if (!dst || dst_cap == 0) return;
    if (!src) {
        dst[0] = '\0';
        return;
    }
    size_t len = strlen(src);
    if (len >= dst_cap) len = dst_cap - 1;
    memcpy(dst, src, len);
    dst[len] = '\0';
}

#ifdef CONFIG_HOMECORE_FW_VERSION
#define HOMECORE_FW_VERSION CONFIG_HOMECORE_FW_VERSION
#else
#define HOMECORE_FW_VERSION "1.2.0"
#endif

#ifdef CONFIG_HOMECORE_BOARD_SLUG
#define HOMECORE_BOARD_SLUG CONFIG_HOMECORE_BOARD_SLUG
#else
#define HOMECORE_BOARD_SLUG "esp32-s3-devkitc-1-n16r8"
#endif

#ifdef CONFIG_HOMECORE_PARTITION_SCHEME
#define HOMECORE_PARTITION_SCHEME CONFIG_HOMECORE_PARTITION_SCHEME
#else
#define HOMECORE_PARTITION_SCHEME "dual_ota_16mb"
#endif

#ifdef CONFIG_HOMECORE_BOOT_BUTTON_GPIO
#define HOMECORE_BOOT_BUTTON_GPIO CONFIG_HOMECORE_BOOT_BUTTON_GPIO
#elif defined(CONFIG_IDF_TARGET_ESP32C5)
#define HOMECORE_BOOT_BUTTON_GPIO 28
#elif defined(CONFIG_IDF_TARGET_ESP32C2) || defined(CONFIG_IDF_TARGET_ESP32C3) || defined(CONFIG_IDF_TARGET_ESP32C6) || defined(CONFIG_IDF_TARGET_ESP32C61) || defined(CONFIG_IDF_TARGET_ESP32H2)
#define HOMECORE_BOOT_BUTTON_GPIO 9
#else
#define HOMECORE_BOOT_BUTTON_GPIO 0
#endif

#ifdef CONFIG_HOMECORE_FLASH_SIZE_MB
#define HOMECORE_FLASH_SIZE_MB CONFIG_HOMECORE_FLASH_SIZE_MB
#else
#define HOMECORE_FLASH_SIZE_MB 16
#endif

#ifdef CONFIG_HOMECORE_PSRAM_SIZE_MB
#define HOMECORE_PSRAM_SIZE_MB CONFIG_HOMECORE_PSRAM_SIZE_MB
#else
#define HOMECORE_PSRAM_SIZE_MB 0
#endif

#if defined(CONFIG_SOC_WIFI_SUPPORTED) && CONFIG_SOC_WIFI_SUPPORTED
#define HOMECORE_HAS_WIFI 1
#else
#define HOMECORE_HAS_WIFI 0
#endif

#if !defined(CONFIG_IDF_TARGET_ESP32S2) && defined(CONFIG_BT_ENABLED) && CONFIG_BT_ENABLED && defined(CONFIG_BT_NIMBLE_ENABLED) && CONFIG_BT_NIMBLE_ENABLED
#define HOMECORE_HAS_BLE 1
#else
#define HOMECORE_HAS_BLE 0
#endif

#define HOMECORE_HAS_BLE_WIFI_PROVISIONING (HOMECORE_HAS_BLE && HOMECORE_HAS_WIFI)

#define HOMECORE_NVS_NAMESPACE "homecore"

#define HOMECORE_MAX_IO_ITEMS 32
#define HOMECORE_MAX_LOCAL_RULES 16
#define HOMECORE_DEFAULT_HEARTBEAT_SEC 60
#define HOMECORE_RECOVERY_HOLD_MS 3000
#define HOMECORE_FACTORY_RESET_HOLD_MS 10000

typedef struct homecore_config_s {
    char wifi_ssid[64];
    char wifi_pass[64];
    char backend_url[192];
    char pending_pair_code[16];

    // Persistent hardware identity (independent from Wi-Fi and MQTT credentials)
    char identity_key[65];
    // Per-device random 8-char secret used for both BLE Security 1 PoP & Setup AP WPA2
    char setup_pin[16];
    char prov_transport[16];
    bool recovery_mode;
    bool recovery_boot_req;
    bool physical_confirmed;
    char confirm_method[24];

    bool paired;
    char account_id[48];
    char controller_id[48];
    char mqtt_host[128];
    uint16_t mqtt_port;
    bool mqtt_tls;
    char mqtt_username[96];
    char mqtt_password[128];
    char mqtt_client_id[96];
    char topic_prefix[160];
    char device_api_token[128];

    // Consolidated config revision & sync tracking
    uint32_t config_revision;
    char config_hash[32];
    uint16_t heartbeat_interval_sec;
} homecore_config_t;

#include "ble_provisioning.h"

typedef enum {
    HC_IO_KIND_SWITCH = 0,
    HC_IO_KIND_DEVICE = 1,
    HC_IO_KIND_SENSOR = 2,
} hc_io_kind_t;

typedef struct {
    char id[48];
    hc_io_kind_t kind;
    uint8_t gpio_pin;
    bool inverted;
    bool state;
    char driver_type[32];
} hc_io_entry_t;

// NVS Store
esp_err_t hc_nvs_init(void);
esp_err_t hc_nvs_load_config(homecore_config_t *out);
esp_err_t hc_nvs_save_config(const homecore_config_t *cfg);
void hc_nvs_ensure_identity_key(homecore_config_t *cfg);
void hc_nvs_ensure_setup_pin(homecore_config_t *cfg);
esp_err_t hc_nvs_set_recovery_boot_req(bool req);
esp_err_t hc_nvs_clear_pairing(homecore_config_t *cfg);
esp_err_t hc_nvs_factory_reset(void);
esp_err_t hc_nvs_load_io_json(char *buf, size_t max_len);
esp_err_t hc_nvs_save_io_json(const char *json);

// Wi-Fi & Unified Local Setup / Recovery Portal
esp_err_t hc_wifi_start(homecore_config_t *cfg, bool allow_ap_portal);
esp_err_t hc_wifi_start_portal_ap(homecore_config_t *cfg);
void hc_wifi_stop_portal_ap(void);
esp_err_t hc_wifi_apply_new_credentials(homecore_config_t *cfg, const char *ssid, const char *pass);
bool hc_wifi_is_connected(void);
const char *hc_wifi_get_last_error(void);
void hc_wifi_get_mac_uid(char *out_buf, size_t out_len);

// Backend Pairing, Recovery, Config Sync & HTTPS Telemetry
void hc_net_get_sta_ip(char *out, size_t max_len);
esp_err_t hc_pairing_claim_if_needed(homecore_config_t *cfg);
esp_err_t hc_http_fetch_config(homecore_config_t *cfg);
esp_err_t hc_http_post_heartbeat(homecore_config_t *cfg);
esp_err_t hc_http_post_telemetry(const homecore_config_t *cfg, const char *json_payload);

// GPIO / IO / Sensor & Offline Local Automation Manager
esp_err_t hc_io_init(const char *initial_json);
esp_err_t hc_io_apply_config_json(const char *json, bool *out_changed);
uint32_t hc_io_get_config_revision(void);
const char *hc_io_get_config_hash(void);
uint16_t hc_io_get_heartbeat_interval_sec(void);
esp_err_t hc_io_set_output(const char *target_id, bool state);
esp_err_t hc_io_drive_pin(const char *target_id, hc_io_kind_t kind, uint8_t gpio_pin, bool inverted, bool state);
bool hc_io_is_safe_gpio(uint8_t pin);
void hc_io_build_telemetry_json(char *out_buf, size_t out_len);
bool hc_io_evaluate_local_rules(void);

// OTA Updates
typedef enum {
    HC_OTA_PEND_NONE = 0,
    HC_OTA_PEND_REBOOT_PENDING = 1,
    HC_OTA_PEND_CONFIRMED = 2,
    HC_OTA_PEND_ROLLED_BACK = 3,
    HC_OTA_PEND_FAILED = 4,
} hc_ota_pend_state_t;

typedef struct {
    bool active;
    uint8_t state;
    uint8_t boot_count;
    char history_id[48];
    char release_id[48];
    char target_version[32];
    uint32_t prev_part_addr;
    uint32_t target_part_addr;
    char diag_msg[96];
} hc_ota_pending_t;

const char *hc_get_runtime_fw_version(void);
void hc_ota_start_async(
    const homecore_config_t *cfg,
    const char *release_id,
    const char *history_id,
    const char *target_version
);
void hc_ota_notify_heartbeat_ok(void);
bool hc_ota_needs_heartbeat(void);
bool hc_ota_is_pending_verify(void);
bool hc_ota_is_bootloader_pending_verify(void);
void hc_ota_process_boot_validation(const homecore_config_t *cfg);

// NVS Pending OTA Tracking & Health Check
bool hc_nvs_health_check(void);
esp_err_t hc_nvs_save_ota_pending(const hc_ota_pending_t *pend);
bool hc_nvs_load_ota_pending(hc_ota_pending_t *out);
esp_err_t hc_nvs_clear_ota_pending(void);

// EMQX TLS MQTT Manager
esp_err_t hc_mqtt_start(homecore_config_t *cfg);
void hc_mqtt_stop(void);
bool hc_mqtt_is_started(void);
bool hc_mqtt_is_connected(void);
const char *hc_mqtt_get_last_error(void);
void hc_mqtt_trigger_reconnect(void);
bool hc_mqtt_consume_sync_request(void);
void hc_mqtt_publish_status(const char *status_str);
void hc_mqtt_publish_telemetry(const char *json_payload);
void hc_mqtt_publish_config_ack(uint32_t revision, const char *hash);
void hc_mqtt_publish_ota_progress(const char *history_id, const char *status, int progress_pct);
