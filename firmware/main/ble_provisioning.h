#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "provisioning_logic.h"

struct homecore_config_s;

typedef enum {
    HC_BLE_APPLY_NONE = 0,
    HC_BLE_APPLY_WIFI_ONLY = 1,
    HC_BLE_APPLY_WIFI_AND_PAIR = 2,
    HC_BLE_APPLY_PAIR_ONLY = 3,
} hc_ble_apply_kind_t;

esp_err_t hc_ble_prov_start(struct homecore_config_s *cfg, hc_prov_mode_t mode);
void hc_ble_prov_set_mode(hc_prov_mode_t mode);
void hc_ble_prov_stop_and_reclaim(void);
void hc_ble_prov_release_unused_at_boot(void);
bool hc_ble_prov_is_active(void);
bool hc_ble_prov_is_mem_released(void);

hc_ble_apply_kind_t hc_ble_prov_consume_pending_apply(void);
void hc_ble_prov_update_status(
    const char *state_str,
    bool wifi_connected,
    bool paired,
    bool mqtt_connected,
    const char *ip_str,
    const char *error_msg
);
