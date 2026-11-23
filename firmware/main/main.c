#include "homecore_config.h"
#include "recovery_console.h"
#include "recovery_logic.h"
#include "role_runtime.h"
#include "sensor_drivers.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "driver/gpio.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#if HOMECORE_HAS_WIFI
#include "esp_wifi.h"
#endif

static const char *TAG = "homecore_main";
static homecore_config_t s_config;
static hc_prov_state_t s_prov_state;
static hc_prov_button_tracker_t s_btn_tracker;
static uint32_t s_ble_close_grace_ms = 0;
static uint32_t s_ble_mqtt_verify_ms = 0;
static bool s_waiting_wifi_only_confirm = false;
static bool s_waiting_pair_mqtt_confirm = false;
static bool s_waiting_cloud_confirm = false;
/** True while a local-page "Save and Restart" awaits cloud confirmation. */
static bool s_portal_save_pending = false;
/** Milliseconds spent waiting for the cloud to confirm a local-page save. */
static uint32_t s_portal_confirm_ms = 0;
/** True once the last heartbeat HTTP round-trip succeeded (drives diagnostics). */
static bool s_backend_ok = false;
/** Wall-clock age of the last *successful* heartbeat (0 = never succeeded). */
static uint32_t s_last_hb_ok_ms = 0;
/** True between a failed and a successful heartbeat, so reachability is provable. */
static bool s_hb_attempted = false;
/** Set while the supervisor is re-entering NORMAL after leaving Recovery Mode. */
static bool s_pending_relink = false;
/** Throttles retries of a BLE interface that failed to open (0 = retry now). */
static uint32_t s_ble_open_backoff_ms = 0;
/** Consecutive BLE open failures; after a few the interface is reported once. */
static uint8_t s_ble_open_failures = 0;

/** Records the outcome of the most recent heartbeat, for recovery diagnostics. */
static void note_backend_result(esp_err_t err) {
    s_backend_ok = (err == ESP_OK);
    s_hb_attempted = true;
    if (s_backend_ok) {
        s_last_hb_ok_ms = (uint32_t)(esp_timer_get_time() / 1000LL);
    }
}

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
        /* The press at startup is the same proof-of-possession as a press while
         * running: persist it before any interface opens so a board that has to
         * restart to re-initialise BLE still comes back into Recovery Mode. */
        s_config.physical_confirmed = true;
        s_config.recovery_mode = true;
        hc_copy_str(s_config.confirm_method, sizeof(s_config.confirm_method), "button_press");
        hc_nvs_save_config(&s_config);
    }
    return act;
}

/* ------------------------------------------------------------------------- */
/* Recovery Mode supervisor: one owner for the temporary interfaces           */
/* ------------------------------------------------------------------------- */

/**
 * Marks the persisted recovery session as finished.
 *
 * `recovery_mode` tells `hc_pairing_claim_if_needed` to use the recovery pairing
 * endpoint, so a session that already ended must clear it — otherwise the next
 * ordinary setup claim would be sent as a recovery claim. The physical proof is
 * kept: a later BOOT press is what grants it, not this flag.
 */
static void clear_persisted_recovery_session(void) {
    if (!s_config.recovery_mode) return;
    s_config.recovery_mode = false;
    hc_nvs_save_config(&s_config);
}

/**
 * Restarts late enough for a transport to finish writing its reply.
 *
 * Recovery Mode is entered on boards whose BLE controller memory may already
 * have been released for NORMAL operation; NimBLE cannot be re-initialised in
 * place, so the only honest way to honour "open BLE recovery" is to persist the
 * request and reboot into it. Every restart that carries state in NVS goes
 * through here so the persisted request and the config land in the same commit.
 */
static void restart_into_recovery(void) {
    s_config.recovery_boot_req = true;
    hc_nvs_save_config(&s_config);
    ESP_LOGW(TAG, "Restarting to re-initialise BLE for Recovery Mode (config preserved)");
    vTaskDelay(pdMS_TO_TICKS(400));
    esp_restart();
}

/**
 * Applies the difference between the provisioning mode and what is actually
 * running. Both entering Recovery Mode and *every* exit go through here, which
 * is what makes the teardown unskippable: a path can no longer leave the setup
 * AP or BLE advertising behind by forgetting to close them itself.
 *
 * Called once per supervision tick, so an interface that failed to open is
 * retried and one that was closed behind our back is re-opened.
 *
 * Returns true when a restart was scheduled (it does not return in that case).
 */
static bool apply_interface_plan(void) {
    const hc_prov_iface_plan_t plan = hc_prov_plan_interfaces(
        &s_prov_state,
        hc_ble_prov_is_active(),
        hc_ble_prov_is_mem_released(),
        hc_wifi_is_portal_ap_active()
    );

    if (plan.restart_required) {
        restart_into_recovery();
        return true;
    }
    if (plan.open_ble && s_ble_open_backoff_ms == 0) {
        esp_err_t err = hc_ble_prov_start(&s_config, s_prov_state.mode);
        if (err == ESP_OK) {
            s_ble_open_failures = 0;
        } else {
            /* A NimBLE bring-up that fails is usually persistent; retrying it
             * every tick would spam the log and hammer the controller. Back off,
             * then say plainly that this transport is unavailable instead of
             * leaving the user waiting for an interface that never arrives. */
            if (s_ble_open_failures < 3) s_ble_open_failures++;
            s_ble_open_backoff_ms = 5000U;
            if (s_ble_open_failures == 3) {
                ESP_LOGE(
                    TAG,
                    "BLE recovery interface could not be started (%s); use the setup AP or USB, then restart the board",
                    esp_err_to_name(err)
                );
            } else {
                ESP_LOGW(TAG, "BLE recovery interface unavailable (%s); retrying", esp_err_to_name(err));
            }
        }
    } else if (plan.open_ble && s_ble_open_backoff_ms > 0) {
        s_ble_open_backoff_ms -= (s_ble_open_backoff_ms > 500U) ? 500U : s_ble_open_backoff_ms;
    } else if (!plan.open_ble) {
        s_ble_open_failures = 0;
        s_ble_open_backoff_ms = 0;
    }
    /* A transport that is still writing its last reply keeps the radio for the
     * grace window; the supervisor re-applies this plan when it expires, so the
     * BLE interface is delayed, never skipped. */
    if (plan.close_ble && s_ble_close_grace_ms == 0) {
        hc_ble_prov_stop_and_reclaim();
    }
    if (plan.open_ap) {
        hc_wifi_start_portal_ap(&s_config);
    }
    if (plan.close_ap) {
        hc_wifi_stop_portal_ap();
    }
    return false;
}

/**
 * Enters Recovery Mode. Idempotent: pressing BOOT while already in recovery
 * keeps the interfaces exactly as they are instead of re-opening them.
 */
static void enter_recovery_mode(void) {
    const bool was_recovery = (s_prov_state.mode == HC_PROV_MODE_RECOVERY);
    hc_prov_enter_recovery(&s_prov_state);
    hc_ble_prov_set_mode(HC_PROV_MODE_RECOVERY);
    s_ble_close_grace_ms = 0;
    s_waiting_wifi_only_confirm = false;
    s_waiting_pair_mqtt_confirm = false;
    s_portal_save_pending = false;
    s_waiting_cloud_confirm = false;
    if (!was_recovery) {
        ESP_LOGW(TAG, "Recovery Mode open for %u minutes (BLE + setup AP)", HC_PROV_RECOVERY_TIMEOUT_MS / 60000U);
    }
    apply_interface_plan();
}

/**
 * Leaves Recovery Mode and restores the board to normal operation.
 *
 * Closing the temporary interfaces is not enough to be healthy again: the board
 * must also return to the cloud transport its role uses. A Controller (or a
 * standalone/unassigned Node) gets MQTT back; a Node whose ESP-NOW link is
 * healthy deliberately keeps no independent EMQX session and asks the role
 * runtime to re-link instead.
 */
static void exit_recovery_mode(bool keep_grace_for_ble_reply) {
    const bool leaving = (s_prov_state.mode == HC_PROV_MODE_RECOVERY);
    hc_prov_exit_recovery(&s_prov_state);
    hc_ble_prov_set_mode(s_prov_state.mode);

    /* A transport that is mid-reply still needs its socket for a few hundred
     * milliseconds; `apply_interface_plan` honours the grace for BLE only, so
     * the setup AP closes right away and BLE follows when the grace expires. */
    s_ble_close_grace_ms = keep_grace_for_ble_reply ? 1000U : 0;
    s_waiting_wifi_only_confirm = false;
    s_waiting_pair_mqtt_confirm = false;
    s_waiting_cloud_confirm = false;
    s_portal_save_pending = false;
    s_portal_confirm_ms = 0;
    clear_persisted_recovery_session();
    apply_interface_plan();

    if (leaving) {
        ESP_LOGI(
            TAG,
            "Recovery Mode closed; mode=%s",
            s_prov_state.mode == HC_PROV_MODE_NORMAL ? "normal" : "unprovisioned"
        );
    }
    s_pending_relink = true;
}

/** Restores the cloud transport that this board's role actually uses. */
static void resume_cloud_after_recovery(void) {
    if (!s_pending_relink) return;
    s_pending_relink = false;
    if (!s_config.paired) return;

    if (hc_role_wants_mqtt()) {
        if (!hc_mqtt_is_started()) {
            hc_mqtt_start(&s_config);
        } else if (!hc_mqtt_is_connected()) {
            hc_mqtt_trigger_reconnect();
        }
    } else {
        /* A Node with a healthy ESP-NOW link must not open its own EMQX
         * session; re-link to its Controller instead. */
        hc_role_request_relink(&s_config);
    }
}

/**
 * Publishes what the board knows about itself so the local recovery console
 * (USB / BLE / Wi-Fi portal) can answer discovery and diagnostics honestly.
 * Every field is either measured or left "unknown": nothing is guessed.
 */
static void publish_recovery_snapshot(
    const homecore_config_t *cfg,
    const hc_prov_state_t *prov,
    bool wifi_connected,
    const char *ip_str,
    bool backend_ok,
    uint32_t heartbeat_age_ms
) {
    hc_recovery_snapshot_t snap;
    hc_rec_snapshot_init(&snap);

    hc_copy_str(snap.board_slug, sizeof(snap.board_slug), HOMECORE_BOARD_SLUG);
    hc_copy_str(snap.chip, sizeof(snap.chip), CONFIG_IDF_TARGET);
    hc_copy_str(snap.fw_version, sizeof(snap.fw_version), hc_get_runtime_fw_version());
    char uid[24] = {0};
    hc_wifi_get_mac_uid(uid, sizeof(uid));
    hc_copy_str(snap.hardware_uid, sizeof(snap.hardware_uid), uid);

    const char *mode = "normal";
    if (prov) {
        if (prov->mode == HC_PROV_MODE_RECOVERY) {
            mode = "recovery";
        } else if (prov->mode == HC_PROV_MODE_UNPROVISIONED) {
            mode = "unprovisioned";
        }
    }
    hc_copy_str(snap.mode, sizeof(snap.mode), mode);

    snap.paired = cfg ? cfg->paired : false;
    snap.has_wifi = HOMECORE_HAS_WIFI != 0;
    snap.has_ble = HOMECORE_HAS_BLE != 0;
    snap.physical_confirmed = cfg ? cfg->physical_confirmed : false;
    snap.recovery_supported = true;

    snap.wifi_connected = wifi_connected;
#if HOMECORE_HAS_WIFI
    if (wifi_connected) {
        wifi_ap_record_t ap_info;
        if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
            snap.wifi_rssi = ap_info.rssi;
        }
    }
#endif
    if (cfg) hc_copy_str(snap.wifi_ssid, sizeof(snap.wifi_ssid), cfg->wifi_ssid);
    if (ip_str) hc_copy_str(snap.ip, sizeof(snap.ip), ip_str);
    hc_copy_str(snap.wifi_last_error, sizeof(snap.wifi_last_error), hc_wifi_get_last_error());
    snap.mqtt_connected = hc_mqtt_is_connected();
    hc_copy_str(snap.mqtt_last_error, sizeof(snap.mqtt_last_error), hc_mqtt_get_last_error());
    if (cfg) {
        /* Reachability is a *measured* HTTPS fact, not a proxy for "Wi-Fi is
         * up": a board that joined an SSID but cannot reach the Worker is
         * exactly the fault recovery exists for, and it used to be reported as
         * healthy because the link was. Only a heartbeat that actually
         * completed (or one that has not been attempted since boot) is
         * inconclusive rather than unreachable. */
        snap.backend_ok = backend_ok;
        snap.backend_reachable = cfg->paired
            ? (backend_ok || (!s_hb_attempted && wifi_connected))
            : wifi_connected;
        snap.backend_authenticated = backend_ok && cfg->paired;
        /* `hc_io_get_config_revision()` is the revision this image *applied*;
         * `cfg->config_revision` is what it last persisted from the server. A
         * gap between them means the applied configuration was never saved,
         * and an unsaved configuration is a sync fault worth reporting. */
        snap.config_revision = (unsigned)hc_io_get_config_revision();
        snap.synced_config_revision = (unsigned)cfg->config_revision;
        snap.config_pending_sync =
            snap.config_revision > snap.synced_config_revision ||
            (cfg->paired && snap.config_revision == 0);
        snap.heartbeat_interval_sec = hc_io_get_heartbeat_interval_sec();
    }
    /* Age of the last *successful* heartbeat, not of the last attempt: after a
     * failed round-trip the previous success is still the last time the Worker
     * actually answered, and the retry loop resets the elapsed counter. */
    if (backend_ok) {
        snap.heartbeat_age_sec = heartbeat_age_ms / 1000U;
    } else if (s_last_hb_ok_ms > 0) {
        const uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000LL);
        snap.heartbeat_age_sec = now_ms > s_last_hb_ok_ms ? (now_ms - s_last_hb_ok_ms) / 1000U : 0U;
    } else {
        snap.heartbeat_age_sec = 0U; /* never succeeded -> "never", not "just now" */
    }

    /* --- Running image & capabilities -------------------------------------
     * Everything here is measured by this image, so the recovery console can
     * validate the firmware, prove a restart and correct a missing/stale
     * server URL without guessing. */
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (running) {
        hc_copy_str(snap.partition, sizeof(snap.partition), running->label);
    }
    const esp_app_desc_t *app = esp_app_get_description();
    if (app && app->project_name[0]) {
        /* The build's own description is authoritative over the configured
         * version string; a mismatch means the flashed image is not the one
         * this configuration was built for. */
        hc_copy_str(snap.fw_version, sizeof(snap.fw_version), app->version);
    }
    snap.uptime_sec = (unsigned)(esp_timer_get_time() / 1000000LL);
    snap.free_heap_bytes = (unsigned)esp_get_free_heap_size();
    if (cfg) {
        hc_copy_str(snap.backend_url, sizeof(snap.backend_url), cfg->backend_url);
    }
    /* OTA works exactly when the partition table has a second app slot to
     * write into; a factory-only image must not promise an update it cannot
     * receive. */
    snap.ota_supported = esp_ota_get_next_update_partition(NULL) != NULL;
    snap.ota_pending = hc_ota_is_bootloader_pending_verify();
    if (snap.ota_pending) {
        hc_copy_str(
            snap.ota_last_error,
            sizeof(snap.ota_last_error),
            "An over-the-air image is installed and awaits its first confirmed health report."
        );
    }
    /* ESP-NOW only exists where a Wi-Fi radio and the role runtime do. */
    snap.espnow_supported = HOMECORE_HAS_WIFI != 0;
    if (snap.espnow_supported) {
        hc_copy_str(
            snap.espnow_link,
            sizeof(snap.espnow_link),
            hc_node_link_name(hc_role_link_state())
        );
    }

    /* Entity counts are owned by the IO manager's telemetry builder, which is
     * the only component that knows which sensors/switches actually exist on
     * this board. When it can report them, the console shows the real numbers;
     * otherwise it says "reporting unknown" instead of "nothing assigned". */
    hc_io_entity_counts_t counts;
    if (hc_io_get_entity_counts(&counts)) {
        snap.entities_known = true;
        snap.sensor_total = counts.sensors_total;
        snap.sensor_reporting = counts.sensors_reporting;
        snap.switch_total = counts.switches_total;
        snap.switch_reporting = counts.switches_reporting;
    } else {
        snap.entities_known = false;
    }
    /* Nodes are hosted by a Controller over ESP-NOW; a Node itself has none. */
    if (HOMECORE_HAS_WIFI && !hc_role_is_node()) {
        snap.nodes_known = true;
        snap.node_total = hc_role_node_count();
        snap.node_linked = hc_role_linked_node_count();
    } else {
        snap.nodes_known = false;
    }

    hc_recovery_publish_snapshot(&snap);
}

static void sync_cloud_and_report_state(char *telem_buf, size_t telem_cap, bool fetch_http_config) {
    if (!s_config.paired) return;
    // A Node keeps no independent EMQX session while its ESP-NOW link is healthy;
    // the role runtime owns that decision (see role_runtime.c). Heartbeats,
    // telemetry and config sync still travel over HTTPS in every state.
    if (hc_role_wants_mqtt()) {
        if (!hc_mqtt_is_started()) {
            hc_mqtt_start(&s_config);
        } else if (!hc_mqtt_is_connected()) {
            hc_mqtt_trigger_reconnect();
        }
    }
    if (fetch_http_config || s_config.config_revision == 0 || !hc_mqtt_is_connected()) {
        hc_http_fetch_config(&s_config);
    }
    note_backend_result(hc_http_post_heartbeat(&s_config));
    if (s_backend_ok) {
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
    const size_t telem_cap = 4096;
    char *telem_buf = calloc(1, telem_cap);
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

        // 0. Keep the provisioning state's view of the stored config current, so
        //    entering/leaving Recovery Mode is judged against what NVS holds
        //    now (a BLE/portal setup can add the SSID or server URL at runtime).
        hc_prov_note_stored_config(
            &s_prov_state,
            strlen(s_config.wifi_ssid) > 0,
            strlen(s_config.backend_url) > 0
        );

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
            ESP_LOGW(TAG, "BOOT button held 10s -> performing full factory reset (role, pairing and credentials are erased; the device returns as a Controller)");
            hc_nvs_factory_reset();
            vTaskDelay(pdMS_TO_TICKS(300));
            esp_restart();
        } else if (btn_act == HC_BOOT_BTN_RECOVERY) {
            /* The physical press is the proof-of-possession for Recovery Mode.
             * It is persisted before any interface opens, so a board that has to
             * reboot to re-initialise BLE still comes back into recovery rather
             * than into NORMAL (where the button press would be lost). */
            s_config.physical_confirmed = true;
            s_config.recovery_mode = true;
            hc_copy_str(s_config.confirm_method, sizeof(s_config.confirm_method), "button_press");
            hc_nvs_save_config(&s_config);
            enter_recovery_mode();
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

        if (hc_wifi_take_portal_saved()) {
            // The board's own local page stored Wi-Fi / URL / code: this is the
            // "Save and Restart" hand-off, tracked separately from a pairing
            // claim so the temporary interfaces close only for this flow.
            s_portal_save_pending = true;
            s_portal_confirm_ms = 0;
            s_waiting_cloud_confirm = true;
            s_backend_ok = false;
        }

        // 3. Enforce 15-minute Recovery Mode timeout without erasing saved config.
        //    The mode has already moved on (`hc_prov_exit_recovery`), so the same
        //    plan-based teardown every other exit uses closes BLE *and* the AP —
        //    including on a board that times out while still unprovisioned and
        //    therefore legitimately keeps them open.
        bool rec_timed_out = false;
        if (hc_prov_tick(&s_prov_state, 500U, &rec_timed_out) && rec_timed_out) {
            ESP_LOGW(TAG, "Recovery mode 15-minute window expired; returning cleanly without erasing config");
            const bool still_needs_setup = (s_prov_state.mode != HC_PROV_MODE_NORMAL);
            if (still_needs_setup) {
                /* Unprovisioned: BLE and the setup AP are how the user finishes
                 * setup, so they stay up — but the *recovery* session is over. */
                s_waiting_wifi_only_confirm = false;
                s_waiting_pair_mqtt_confirm = false;
                s_waiting_cloud_confirm = false;
                s_portal_save_pending = false;
                clear_persisted_recovery_session();
                hc_ble_prov_set_mode(s_prov_state.mode);
                apply_interface_plan();
            } else {
                exit_recovery_mode(false);
                resume_cloud_after_recovery();
            }
        }

        // 4. Delayed BLE interface release after a transport delivered its final
        //    status notification. Re-applying the plan is what actually closes
        //    BLE, so the grace window can delay the teardown but never skip it.
        if (s_ble_close_grace_ms > 0) {
            if (s_ble_close_grace_ms <= 500U) {
                s_ble_close_grace_ms = 0;
            } else {
                s_ble_close_grace_ms -= 500U;
            }
        }

        // 4.1 Deferred restart / factory-reset requested over BLE recovery.
        //     USB and Wi-Fi portal apply restarts immediately after flushing
        //     their response; BLE cannot block inside the NimBLE GATT write
        //     callback, so the supervision loop completes it after one tick.
        if (hc_recovery_restart_pending()) {
            vTaskDelay(pdMS_TO_TICKS(300));
            hc_recovery_apply_pending_restart();
        }

        // 4a. Converge the temporary interfaces on the current mode every tick.
        //     This is the single owner of "open both, close both": a BLE start
        //     that failed, an AP that was closed by a transport, or a mode that
        //     changed in a branch above is corrected here instead of being left
        //     for whichever exit path happens to run.
        apply_interface_plan();

        // 4b. Unified Controller / Node role supervision (ESP-NOW link, standalone
        //     fallback, automatic return to ESP-NOW).
        hc_role_tick(&s_config, 500U);

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
            // Still publish (with wifi_connected=false) so a local console can
            // diagnose a board that is *not* on the network — which is exactly
            // the case recovery exists for.
            publish_recovery_snapshot(
                &s_config,
                &s_prov_state,
                false,
                NULL,
                s_backend_ok,
                hb_elapsed_ms
            );
            continue;
        }

        char ip_str[20];
        hc_net_get_sta_ip(ip_str, sizeof(ip_str));

        // Publish the recovery snapshot as soon as the board is on the network,
        // so a local console (USB / BLE / portal) never reports stale data while
        // the rest of this tick is still waiting on the cloud.
        publish_recovery_snapshot(
            &s_config,
            &s_prov_state,
            true,
            ip_str,
            s_backend_ok,
            hb_elapsed_ms
        );

        // Handle BLE Wi-Fi-only update completion while preserving pairing (verify MQTT first)
        if (s_waiting_wifi_only_confirm && s_config.paired && !hc_role_wants_mqtt()) {
            // A linked Node intentionally holds no EMQX session, so a Wi-Fi
            // recovery on it is confirmed by an authenticated HTTPS heartbeat
            // instead of waiting for an MQTT connection that must not exist.
            s_waiting_wifi_only_confirm = false;
            s_ble_mqtt_verify_ms = 0;
            if (hc_http_post_heartbeat(&s_config) == ESP_OK) {
                hc_prov_on_wifi_reconfigured(
                    &s_prov_state,
                    strlen(s_config.wifi_ssid) > 0,
                    strlen(s_config.backend_url) > 0
                );
                hc_ble_prov_update_status("wifi_connected", true, true, false, ip_str, NULL);
                exit_recovery_mode(true);
                resume_cloud_after_recovery();
            } else {
                hc_ble_prov_update_status(
                    "error",
                    true,
                    true,
                    false,
                    ip_str,
                    "Device unreachable after the Wi-Fi update"
                );
            }
        } else if (s_waiting_wifi_only_confirm && s_config.paired) {
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
                exit_recovery_mode(true);
                resume_cloud_after_recovery();
            } else if (s_ble_mqtt_verify_ms >= 8000U) {
                s_waiting_wifi_only_confirm = false;
                s_ble_mqtt_verify_ms = 0;
                hc_ble_prov_update_status("error", true, true, false, ip_str, "MQTT authentication or broker connection failed");
            }
        }

        // 6b. Local-page "Save and Restart": the portal has already stored the
        //     Wi-Fi credentials, the server URL and any recovery code, and the
        //     station is reconnecting. Once the cloud confirms this board (an
        //     authenticated heartbeat, or MQTT where the role uses it), the
        //     temporary setup network and BLE close on their own — a board that
        //     never confirms keeps them open so the user can try again.
        if (s_portal_save_pending) {
            s_portal_confirm_ms += 500U;
            const bool mqtt_ok = hc_mqtt_is_connected();
            const bool role_uses_mqtt = hc_role_wants_mqtt();
            if (!role_uses_mqtt || mqtt_ok) {
                const esp_err_t hb = hc_http_post_heartbeat(&s_config);
                note_backend_result(hb);
                if (hb == ESP_OK) {
                    ESP_LOGI(TAG, "Local setup confirmed by HomecoreOS; closing temporary interfaces");
                    s_portal_save_pending = false;
                    s_waiting_cloud_confirm = false;
                    s_portal_confirm_ms = 0;
                    hc_prov_on_wifi_reconfigured(
                        &s_prov_state,
                        strlen(s_config.wifi_ssid) > 0,
                        strlen(s_config.backend_url) > 0
                    );
                    // The local page is answered already; closing the AP now
                    // is what "the temporary network closes itself" means. BLE
                    // gets a short grace so its final status notification is
                    // delivered before the radio is reclaimed — the shared exit
                    // closes both, so neither can be left behind here.
                    if (hc_ble_prov_is_active()) {
                        hc_ble_prov_update_status("paired", true, s_config.paired, mqtt_ok, ip_str, NULL);
                    }
                    exit_recovery_mode(hc_ble_prov_is_active());
                    resume_cloud_after_recovery();
                }
            }
            if (s_portal_confirm_ms >= 180000U) {
                ESP_LOGW(TAG, "Local setup was saved but HomecoreOS never confirmed the board; keeping the setup network open");
                s_portal_save_pending = false;
                s_waiting_cloud_confirm = false;
                s_portal_confirm_ms = 0;
            }
        }

        // 7. Claim pairing or recovery re-pairing when code is queued
        if (!s_config.paired && strlen(s_config.pending_pair_code) == 6 && pair_retry_cooldown_ms == 0) {
            pair_retry_cooldown_ms = 10000U;
            if (hc_ble_prov_is_active()) {
                hc_ble_prov_update_status("pairing", true, false, false, ip_str, NULL);
            }
            if (hc_pairing_claim_if_needed(&s_config) == ESP_OK) {
                s_waiting_cloud_confirm = true;
                hc_mqtt_start(&s_config);
                sync_cloud_and_report_state(telem_buf, telem_cap, false);
                hb_elapsed_ms = 0;
                prev_wifi_connected = true;

                if (s_prov_state.mode != HC_PROV_MODE_NORMAL && hc_mqtt_is_connected()) {
                    /* The claim succeeded and the broker already accepted the
                     * board: nothing is left waiting on, so the temporary
                     * interfaces close now instead of after a verify timer. */
                    if (hc_ble_prov_is_active()) {
                        hc_ble_prov_update_status("paired", true, true, true, ip_str, NULL);
                    }
                    s_waiting_cloud_confirm = false;
                    hc_prov_on_pairing_completed(&s_prov_state);
                    exit_recovery_mode(hc_ble_prov_is_active());
                    resume_cloud_after_recovery();
                } else if (s_prov_state.mode != HC_PROV_MODE_NORMAL) {
                    /* Claimed, but not yet proven against the broker: keep the
                     * temporary interfaces open until `s_waiting_pair_mqtt_confirm`
                     * sees MQTT come up (or gives up). */
                    s_waiting_pair_mqtt_confirm = true;
                    s_ble_mqtt_verify_ms = 0;
                    if (hc_ble_prov_is_active()) {
                        hc_ble_prov_update_status("pairing", true, true, false, ip_str, NULL);
                    }
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
                }
                if (s_prov_state.mode != HC_PROV_MODE_NORMAL) {
                    hc_prov_on_pairing_completed(&s_prov_state);
                    exit_recovery_mode(hc_ble_prov_is_active());
                    resume_cloud_after_recovery();
                }
            } else if (s_ble_mqtt_verify_ms >= 8000U) {
                s_waiting_pair_mqtt_confirm = false;
                s_ble_mqtt_verify_ms = 0;
                if (hc_ble_prov_is_active()) {
                    hc_ble_prov_update_status("error", true, true, false, ip_str, "MQTT authentication or broker connection failed");
                }
            }
        }

        // Applies equally to portal and BLE setup, including claims made at boot.
        // Provisioned credentials are not proof that the broker accepted them.
        if (s_prov_state.mode != HC_PROV_MODE_NORMAL &&
            hc_prov_cloud_repair_verified(s_waiting_cloud_confirm, s_config.paired,
                                         s_backend_ok, hc_role_wants_mqtt(), hc_mqtt_is_connected())) {
            s_waiting_cloud_confirm = false;
            hc_prov_on_pairing_completed(&s_prov_state);
            if (hc_ble_prov_is_active()) {
                hc_ble_prov_update_status("paired", true, true, hc_mqtt_is_connected(), ip_str, NULL);
            }
            exit_recovery_mode(hc_ble_prov_is_active());
            resume_cloud_after_recovery();
        }

        // 8. Wi-Fi recovered from outage OR MQTT requested explicit config sync
        bool explicit_sync = hc_mqtt_consume_sync_request();
        if (!prev_wifi_connected || explicit_sync) {
            prev_wifi_connected = true;
            if (s_config.paired) {
                ESP_LOGI(TAG, "Connectivity restored / sync requested -> checking rev=%u", (unsigned)s_config.config_revision);
                sync_cloud_and_report_state(telem_buf, telem_cap, explicit_sync);
                hb_elapsed_ms = 0;
            }
        } else if (local_state_changed && s_config.paired && telem_buf) {
            hc_io_build_telemetry_json(telem_buf, telem_cap);
            hc_mqtt_publish_telemetry(telem_buf);
            hc_http_post_telemetry(&s_config, telem_buf);
        }

        // 9. First-boot OTA validation & retry loop
        if (hc_ota_is_pending_verify()) {
            if (s_config.paired && hc_ota_needs_heartbeat() && ota_retry_elapsed_ms >= 5000U) {
                ota_retry_elapsed_ms = 0;
                if (hc_role_wants_mqtt()) {
                    if (!hc_mqtt_is_started()) {
                        hc_mqtt_start(&s_config);
                    } else if (!hc_mqtt_is_connected()) {
                        hc_mqtt_trigger_reconnect();
                    }
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
            note_backend_result(hc_http_post_heartbeat(&s_config));
            if (s_backend_ok) {
                hc_ota_notify_heartbeat_ok();
            }
            hc_ota_process_boot_validation(&s_config);
            if (telem_buf) {
                hc_io_build_telemetry_json(telem_buf, telem_cap);
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
        "Booting HomecoreOS ESP-IDF Firmware v%s (app_desc=%s kconfig=%s board=%s target=%s partition=%s flash=%dMB psram=%dMB boot_gpio=%d i2c=%d/%d drv_mask=0x%02lx wifi=%s ble=%s)",
        runtime_ver,
        app_desc ? app_desc->version : "none",
        HOMECORE_FW_VERSION,
        HOMECORE_BOARD_SLUG,
        CONFIG_IDF_TARGET,
        HOMECORE_PARTITION_SCHEME,
        HOMECORE_FLASH_SIZE_MB,
        HOMECORE_PSRAM_SIZE_MB,
        HOMECORE_BOOT_BUTTON_GPIO,
        HOMECORE_I2C_DEFAULT_SDA_GPIO,
        HOMECORE_I2C_DEFAULT_SCL_GPIO,
        (unsigned long)hc_sensor_drivers_compiled_mask(),
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

    ESP_ERROR_CHECK(hc_role_init(&s_config));

    // Logged after NVS load so the banner never claims a role the device did not
    // actually restore (the static config starts zeroed = Controller).
    ESP_LOGI(
        TAG,
        "Unified role=%s assigned_controller=%s espnow_channel=%s",
        s_config.board_role == 1 ? "node" : "controller",
        s_config.assigned_controller_id[0] ? s_config.assigned_controller_id : "-",
        s_config.espnow_channel ? "pinned" : "auto"
    );

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
    hc_ble_prov_set_mode(s_prov_state.mode);

    /* A boot that is *not* in Recovery Mode must not carry the recovery flag
     * forward: `hc_rec_action_allowed` gates destructive repairs on it, so a
     * stale flag would let the next BOOT press-less session accept a factory
     * reset the user never asked for on this boot. */
    if (s_prov_state.mode == HC_PROV_MODE_NORMAL && s_config.recovery_mode) {
        s_config.recovery_mode = false;
        hc_nvs_save_config(&s_config);
    }

    if (s_prov_state.mode == HC_PROV_MODE_NORMAL) {
        hc_ble_prov_release_unused_at_boot();
    } else if (hc_prov_should_ble_be_active(&s_prov_state)) {
        hc_ble_prov_start(&s_config, s_prov_state.mode);
    }

    /* Local recovery console (USB serial + shared JSON used by BLE and the
     * Wi-Fi portal). Read-only until the board is in recovery mode. */
    publish_recovery_snapshot(&s_config, &s_prov_state, hc_wifi_is_connected(), "0.0.0.0", false, 0);
    hc_recovery_console_start(&s_config);

#if !HOMECORE_HAS_WIFI
    ESP_LOGW(TAG, "Non-Wi-Fi board target (%s): running BLE provisioning / local GPIO supervision", HOMECORE_BOARD_SLUG);
#else
    esp_err_t wifi_res = hc_wifi_start(&s_config, hc_prov_should_ap_be_active(&s_prov_state));

    if (wifi_res == ESP_OK) {
        if (!s_config.paired && strlen(s_config.pending_pair_code) == 6) {
            if (hc_pairing_claim_if_needed(&s_config) == ESP_OK) {
                s_waiting_cloud_confirm = true;
                // Keep AP/BLE available until the supervisor verifies cloud health.
            }
        }
        if (s_config.paired) {
            // A Node that is linked (or still retrying its Controller) must not
            // open its own EMQX session at boot; role_runtime opens the fallback
            // session when — and only when — it is needed.
            if (hc_role_wants_mqtt()) {
                hc_mqtt_start(&s_config);
            }
            if (s_config.config_revision == 0) {
                hc_http_fetch_config(&s_config);
            }
            /* Recorded like any other heartbeat so diagnostics never claim the
             * Worker is reachable before the board has actually reached it (or
             * claim the opposite after it just did). */
            note_backend_result(hc_http_post_heartbeat(&s_config));
            if (s_backend_ok) {
                hc_ota_notify_heartbeat_ok();
            }
        }
    }
#endif

    hc_ota_process_boot_validation(&s_config);
    xTaskCreate(controller_supervision_task, "hc_supervision", 6144, NULL, 4, NULL);
}
