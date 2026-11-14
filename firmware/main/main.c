#include "homecore_config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "driver/gpio.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "homecore_main";
static homecore_config_t s_config;
static hc_prov_state_t s_prov_state;
static hc_prov_button_tracker_t s_btn_tracker;
static uint32_t s_ble_close_grace_ms = 0;
static uint32_t s_ble_mqtt_verify_ms = 0;
static bool s_waiting_wifi_only_confirm = false;
static bool s_waiting_pair_mqtt_confirm = false;

static void init_recovery_button(void) {
    gpio_config_t btn_cfg = {
        .pin_bit_mask = (1ULL << HOMECORE_BOOT_BUTTON_GPIO),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&btn_cfg);
}

static hc_prov_boot_btn_action_t check_boot_button_at_startup(void) {
    init_recovery_button();
    if (gpio_get_level((gpio_num_t)HOMECORE_BOOT_BUTTON_GPIO) != 0) {
        return HC_BOOT_BTN_NONE;
    }

    ESP_LOGW(TAG, "BOOT button held on startup (3s = Recovery, 10s = Factory Reset)...");
    uint32_t held_ms = 0;
    while (gpio_get_level((gpio_num_t)HOMECORE_BOOT_BUTTON_GPIO) == 0) {
        vTaskDelay(pdMS_TO_TICKS(100));
        held_ms += 100U;
        if (held_ms == HC_PROV_RECOVERY_HOLD_MS) {
            ESP_LOGW(TAG, "Release BOOT now for Recovery Mode, or keep holding to 10s for Factory Reset...");
        }
        if (held_ms >= HC_PROV_FACTORY_RESET_HOLD_MS) {
            ESP_LOGW(TAG, "BOOT held 10s at startup -> performing full factory reset");
            hc_nvs_factory_reset();
            vTaskDelay(pdMS_TO_TICKS(250));
            esp_restart();
            return HC_BOOT_BTN_FACTORY_RESET;
        }
    }

    hc_prov_boot_btn_action_t act = hc_prov_evaluate_startup_button(held_ms);
    if (act == HC_BOOT_BTN_RECOVERY) {
        s_config.physical_confirmed = true;
        hc_copy_str(s_config.confirm_method, sizeof(s_config.confirm_method), "button_press");
        hc_nvs_save_config(&s_config);
    }
    return act;
}

static void sync_cloud_and_report_state(char *telem_buf, size_t telem_cap, bool fetch_http_config) {
    if (!s_config.paired) return;
    if (!hc_mqtt_is_started()) {
        hc_mqtt_start(&s_config);
    } else if (!hc_mqtt_is_connected()) {
        hc_mqtt_trigger_reconnect();
    }
    if (fetch_http_config || s_config.config_revision == 0 || !hc_mqtt_is_connected()) {
        hc_http_fetch_config(&s_config);
    }
    if (hc_http_post_heartbeat(&s_config) == ESP_OK) {
        hc_ota_notify_heartbeat_ok();
    }
    hc_ota_process_boot_validation(&s_config);

    if (telem_buf) {
        hc_io_build_telemetry_json(telem_buf, telem_cap);
        hc_mqtt_publish_telemetry(telem_buf);
        hc_http_post_telemetry(&s_config, telem_buf);
    }
}

static void controller_supervision_task(void *pvParam) {
    (void)pvParam;
    char *telem_buf = calloc(1, 2048);
    uint32_t tick_ms = 0;
    uint32_t hb_elapsed_ms = 0;
    uint32_t ota_retry_elapsed_ms = 0;
    uint32_t pair_retry_cooldown_ms = 0;
    bool prev_wifi_connected = hc_wifi_is_connected();

    hc_prov_button_tracker_reset(&s_btn_tracker);

    while (1) {
        vTaskDelay(pdMS_TO_TICKS(500));
        tick_ms += 500U;
        hb_elapsed_ms += 500U;
        ota_retry_elapsed_ms += 500U;
        if (pair_retry_cooldown_ms >= 500U) {
            pair_retry_cooldown_ms -= 500U;
        } else {
            pair_retry_cooldown_ms = 0;
        }

        // 1. Physical BOOT button handling (3s..10s release = Recovery, >=10s = Factory Reset)
        bool btn_pressed = (gpio_get_level((gpio_num_t)HOMECORE_BOOT_BUTTON_GPIO) == 0);
        bool just_armed_rec = false;
        hc_prov_boot_btn_action_t btn_act = hc_prov_button_step(
            &s_btn_tracker, btn_pressed, 500U, &just_armed_rec
        );
        if (just_armed_rec) {
            ESP_LOGW(TAG, "BOOT held 3s: release now for Recovery Mode, or keep holding to 10s for Factory Reset");
        }
        if (btn_act == HC_BOOT_BTN_FACTORY_RESET) {
            ESP_LOGW(TAG, "BOOT button held 10s -> performing full factory reset");
            hc_nvs_factory_reset();
            vTaskDelay(pdMS_TO_TICKS(300));
            esp_restart();
        } else if (btn_act == HC_BOOT_BTN_RECOVERY) {
            s_config.physical_confirmed = true;
            hc_copy_str(s_config.confirm_method, sizeof(s_config.confirm_method), "button_press");
            if (HOMECORE_HAS_BLE && hc_ble_prov_is_mem_released()) {
                ESP_LOGW(TAG, "Entering explicit Recovery Mode via clean restart (preserving saved config)...");
                s_config.recovery_boot_req = true;
                hc_nvs_save_config(&s_config);
                vTaskDelay(pdMS_TO_TICKS(200));
                esp_restart();
            } else {
                ESP_LOGW(TAG, "Entering explicit Recovery Mode (preserving saved config)");
                hc_nvs_save_config(&s_config);
                hc_prov_enter_recovery(&s_prov_state);
                s_ble_close_grace_ms = 0;
                if (hc_prov_should_ble_be_active(&s_prov_state)) {
                    hc_ble_prov_start(&s_config, HC_PROV_MODE_RECOVERY);
                }
                if (hc_prov_should_ap_be_active(&s_prov_state)) {
                    hc_wifi_start_portal_ap(&s_config);
                }
            }
        }

        // 2. Process queued BLE GATT provisioning commands safely in task context
        hc_ble_apply_kind_t ble_apply = hc_ble_prov_consume_pending_apply();
        if (ble_apply != HC_BLE_APPLY_NONE) {
            s_ble_mqtt_verify_ms = 0;
            s_waiting_wifi_only_confirm = false;
            s_waiting_pair_mqtt_confirm = false;
            if (ble_apply == HC_BLE_APPLY_WIFI_ONLY || ble_apply == HC_BLE_APPLY_WIFI_AND_PAIR) {
                hc_wifi_apply_new_credentials(&s_config, s_config.wifi_ssid, s_config.wifi_pass);
                if (ble_apply == HC_BLE_APPLY_WIFI_ONLY && s_config.paired) {
                    s_waiting_wifi_only_confirm = true;
                }
            }
            if (ble_apply == HC_BLE_APPLY_WIFI_AND_PAIR || ble_apply == HC_BLE_APPLY_PAIR_ONLY) {
                pair_retry_cooldown_ms = 0;
            }
        }

        // 3. Enforce 15-minute Recovery Mode timeout without erasing saved config
        bool rec_timed_out = false;
        if (hc_prov_tick(&s_prov_state, 500U, &rec_timed_out) && rec_timed_out) {
            ESP_LOGW(TAG, "Recovery mode 15-minute window expired; returning cleanly without erasing config");
            s_waiting_wifi_only_confirm = false;
            if (!hc_prov_should_ap_be_active(&s_prov_state)) {
                hc_wifi_stop_portal_ap();
            }
            if (!hc_prov_should_ble_be_active(&s_prov_state)) {
                hc_ble_prov_stop_and_reclaim();
            }
        }

        // 4. Delayed BLE/AP teardown after delivering final status notification to client
        if (s_ble_close_grace_ms > 0) {
            if (s_ble_close_grace_ms <= 500U) {
                s_ble_close_grace_ms = 0;
                if (s_prov_state.mode == HC_PROV_MODE_NORMAL) {
                    hc_wifi_stop_portal_ap();
                    hc_ble_prov_stop_and_reclaim();
                }
            } else {
                s_ble_close_grace_ms -= 500U;
            }
        }

        // 5. Evaluate local offline automations every 2s regardless of network connectivity
        bool local_state_changed = false;
        if (tick_ms % 2000U == 0) {
            local_state_changed = hc_io_evaluate_local_rules();
        }

        // 6. Check Wi-Fi connectivity & notify BLE client on failure/success
        bool wifi_now = hc_wifi_is_connected();
        if (!wifi_now) {
            if (prev_wifi_connected) {
                prev_wifi_connected = false;
            }
            const char *werr = hc_wifi_get_last_error();
            if (hc_ble_prov_is_active() && werr && strlen(werr) > 0) {
                hc_ble_prov_update_status("wifi_failed", false, s_config.paired, false, NULL, werr);
            }
            hc_ota_process_boot_validation(&s_config);
            continue;
        }

        char ip_str[20];
        hc_net_get_sta_ip(ip_str, sizeof(ip_str));

        // Handle BLE Wi-Fi-only update completion while preserving pairing (verify MQTT first)
        if (s_waiting_wifi_only_confirm && s_config.paired) {
            if (s_ble_mqtt_verify_ms == 0) {
                if (!hc_mqtt_is_started()) {
                    hc_mqtt_start(&s_config);
                } else if (!hc_mqtt_is_connected()) {
                    hc_mqtt_trigger_reconnect();
                }
                hc_ble_prov_update_status("wifi_connected", true, true, hc_mqtt_is_connected(), ip_str, NULL);
            }
            s_ble_mqtt_verify_ms += 500U;
            if (hc_mqtt_is_connected()) {
                s_waiting_wifi_only_confirm = false;
                s_ble_mqtt_verify_ms = 0;
                hc_http_post_heartbeat(&s_config);
                hc_prov_on_wifi_reconfigured(
                    &s_prov_state,
                    strlen(s_config.wifi_ssid) > 0,
                    strlen(s_config.backend_url) > 0
                );
                hc_ble_prov_update_status("wifi_connected", true, true, true, ip_str, NULL);
                s_ble_close_grace_ms = 2500U;
            } else if (s_ble_mqtt_verify_ms >= 8000U) {
                s_waiting_wifi_only_confirm = false;
                s_ble_mqtt_verify_ms = 0;
                hc_ble_prov_update_status("error", true, true, false, ip_str, "MQTT authentication or broker connection failed");
            }
        }

        // 7. Claim pairing or recovery re-pairing when code is queued
        if (!s_config.paired && strlen(s_config.pending_pair_code) == 6 && pair_retry_cooldown_ms == 0) {
            pair_retry_cooldown_ms = 10000U;
            if (hc_ble_prov_is_active()) {
                hc_ble_prov_update_status("pairing", true, false, false, ip_str, NULL);
            }
            if (hc_pairing_claim_if_needed(&s_config) == ESP_OK) {
                hc_prov_on_pairing_completed(&s_prov_state);
                hc_mqtt_start(&s_config);
                sync_cloud_and_report_state(telem_buf, 2048, false);
                hb_elapsed_ms = 0;
                prev_wifi_connected = true;

                if (hc_ble_prov_is_active()) {
                    if (hc_mqtt_is_connected()) {
                        hc_ble_prov_update_status("paired", true, true, true, ip_str, NULL);
                        s_ble_close_grace_ms = 2500U;
                    } else {
                        s_waiting_pair_mqtt_confirm = true;
                        s_ble_mqtt_verify_ms = 0;
                        hc_ble_prov_update_status("pairing", true, true, false, ip_str, NULL);
                    }
                } else {
                    hc_wifi_stop_portal_ap();
                }
            } else if (hc_ble_prov_is_active()) {
                hc_ble_prov_update_status("error", true, false, false, ip_str, "Backend pairing rejected or unreachable");
            }
        }

        if (s_waiting_pair_mqtt_confirm && s_config.paired) {
            s_ble_mqtt_verify_ms += 500U;
            if (hc_mqtt_is_connected()) {
                s_waiting_pair_mqtt_confirm = false;
                s_ble_mqtt_verify_ms = 0;
                hc_http_post_heartbeat(&s_config);
                if (hc_ble_prov_is_active()) {
                    hc_ble_prov_update_status("paired", true, true, true, ip_str, NULL);
                    s_ble_close_grace_ms = 2500U;
                }
            } else if (s_ble_mqtt_verify_ms >= 8000U) {
                s_waiting_pair_mqtt_confirm = false;
                s_ble_mqtt_verify_ms = 0;
                if (hc_ble_prov_is_active()) {
                    hc_ble_prov_update_status("error", true, true, false, ip_str, "MQTT authentication or broker connection failed");
                }
            }
        }

        // 8. Wi-Fi recovered from outage OR MQTT requested explicit config sync
        bool explicit_sync = hc_mqtt_consume_sync_request();
        if (!prev_wifi_connected || explicit_sync) {
            prev_wifi_connected = true;
            if (s_config.paired) {
                ESP_LOGI(TAG, "Connectivity restored / sync requested -> checking rev=%u", (unsigned)s_config.config_revision);
                sync_cloud_and_report_state(telem_buf, 2048, explicit_sync);
                hb_elapsed_ms = 0;
            }
        } else if (local_state_changed && s_config.paired && telem_buf) {
            hc_io_build_telemetry_json(telem_buf, 2048);
            hc_mqtt_publish_telemetry(telem_buf);
            hc_http_post_telemetry(&s_config, telem_buf);
        }

        // 9. First-boot OTA validation & retry loop
        if (hc_ota_is_pending_verify()) {
            if (s_config.paired && hc_ota_needs_heartbeat() && ota_retry_elapsed_ms >= 5000U) {
                ota_retry_elapsed_ms = 0;
                if (!hc_mqtt_is_started()) {
                    hc_mqtt_start(&s_config);
                } else if (!hc_mqtt_is_connected()) {
                    hc_mqtt_trigger_reconnect();
                }
                if (hc_http_post_heartbeat(&s_config) == ESP_OK) {
                    hc_ota_notify_heartbeat_ok();
                }
            }
            hc_ota_process_boot_validation(&s_config);
        }

        // 10. Periodic heartbeat & batched telemetry
        uint32_t hb_interval_ms = (uint32_t)hc_io_get_heartbeat_interval_sec() * 1000U;
        if (hb_interval_ms < 30000U) hb_interval_ms = HOMECORE_DEFAULT_HEARTBEAT_SEC * 1000U;
        if (s_config.paired && hb_elapsed_ms >= hb_interval_ms) {
            hb_elapsed_ms = 0;
            if (hc_http_post_heartbeat(&s_config) == ESP_OK) {
                hc_ota_notify_heartbeat_ok();
            }
            hc_ota_process_boot_validation(&s_config);
            if (telem_buf) {
                hc_io_build_telemetry_json(telem_buf, 2048);
                hc_mqtt_publish_telemetry(telem_buf);
                hc_http_post_telemetry(&s_config, telem_buf);
            }
        }
    }
}

void app_main(void) {
    const esp_app_desc_t *app_desc = esp_app_get_description();
    const char *runtime_ver = hc_get_runtime_fw_version();
    ESP_LOGI(
        TAG,
        "Booting HomecoreOS ESP-IDF Firmware v%s (app_desc=%s kconfig=%s board=%s target=%s partition=%s flash=%dMB psram=%dMB boot_gpio=%d wifi=%s ble=%s)",
        runtime_ver,
        app_desc ? app_desc->version : "none",
        HOMECORE_FW_VERSION,
        HOMECORE_BOARD_SLUG,
        CONFIG_IDF_TARGET,
        HOMECORE_PARTITION_SCHEME,
        HOMECORE_FLASH_SIZE_MB,
        HOMECORE_PSRAM_SIZE_MB,
        HOMECORE_BOOT_BUTTON_GPIO,
        HOMECORE_HAS_WIFI ? "yes" : "no",
        HOMECORE_HAS_BLE ? "yes" : "no"
    );

    ESP_ERROR_CHECK(hc_nvs_init());
    ESP_ERROR_CHECK(hc_nvs_load_config(&s_config));

    const bool persisted_rec_req = s_config.recovery_boot_req;
    if (persisted_rec_req) {
        s_config.recovery_boot_req = false;
        hc_nvs_set_recovery_boot_req(false);
    }

    char *io_json = calloc(1, 8192);
    if (io_json) {
        hc_nvs_load_io_json(io_json, 8192);
        hc_io_init(io_json);
        free(io_json);
    } else {
        hc_io_init("");
    }

    hc_prov_boot_btn_action_t startup_btn = check_boot_button_at_startup();
    hc_prov_boot_input_t boot_in = {
        .has_wifi = HOMECORE_HAS_WIFI != 0,
        .has_ble = HOMECORE_HAS_BLE != 0,
        .paired = s_config.paired,
        .has_wifi_ssid = strlen(s_config.wifi_ssid) > 0,
        .has_backend_url = strlen(s_config.backend_url) > 0,
        .has_pending_pair_code = strlen(s_config.pending_pair_code) == 6,
        .recovery_requested = persisted_rec_req || (startup_btn == HC_BOOT_BTN_RECOVERY),
    };
    hc_prov_init_state(&s_prov_state, &boot_in);

    if (s_prov_state.mode == HC_PROV_MODE_NORMAL) {
        hc_ble_prov_release_unused_at_boot();
    } else if (hc_prov_should_ble_be_active(&s_prov_state)) {
        hc_ble_prov_start(&s_config, s_prov_state.mode);
    }

#if !HOMECORE_HAS_WIFI
    ESP_LOGW(TAG, "Non-Wi-Fi board target (%s): running BLE provisioning / local GPIO supervision", HOMECORE_BOARD_SLUG);
#else
    esp_err_t wifi_res = hc_wifi_start(&s_config, hc_prov_should_ap_be_active(&s_prov_state));

    if (wifi_res == ESP_OK) {
        if (!s_config.paired && strlen(s_config.pending_pair_code) == 6) {
            if (hc_pairing_claim_if_needed(&s_config) == ESP_OK) {
                hc_prov_on_pairing_completed(&s_prov_state);
                if (!hc_prov_should_ap_be_active(&s_prov_state)) hc_wifi_stop_portal_ap();
                if (!hc_prov_should_ble_be_active(&s_prov_state)) hc_ble_prov_stop_and_reclaim();
            }
        }
        if (s_config.paired) {
            hc_mqtt_start(&s_config);
            if (s_config.config_revision == 0) {
                hc_http_fetch_config(&s_config);
            }
            if (hc_http_post_heartbeat(&s_config) == ESP_OK) {
                hc_ota_notify_heartbeat_ok();
            }
        }
    }
#endif

    hc_ota_process_boot_validation(&s_config);
    xTaskCreate(controller_supervision_task, "hc_supervision", 6144, NULL, 4, NULL);
}
