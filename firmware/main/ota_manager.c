#include "homecore_config.h"
#include "ota_boot_logic.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_https_ota.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "hc_ota";

#define HC_OTA_MIN_HEALTH_HEAP_BYTES 24576U
#define HC_OTA_MIN_UPTIME_US         5000000LL
#define HC_OTA_WAIT_LOG_INTERVAL_US  10000000LL

typedef struct {
    homecore_config_t cfg;
    char release_id[48];
    char history_id[48];
    char target_version[32];
} ota_job_t;

static char s_ota_token[128] = {0};
static bool s_ota_in_progress = false;
static bool s_heartbeat_ok = false;
static bool s_boot_diag_logged = false;
static int64_t s_last_wait_log_us = 0;
static int64_t s_last_report_attempt_us = 0;

static const char *ota_state_to_str(esp_ota_img_states_t st) {
    switch (st) {
        case ESP_OTA_IMG_NEW:
            return "NEW";
        case ESP_OTA_IMG_PENDING_VERIFY:
            return "PENDING_VERIFY";
        case ESP_OTA_IMG_VALID:
            return "VALID";
        case ESP_OTA_IMG_INVALID:
            return "INVALID";
        case ESP_OTA_IMG_ABORTED:
            return "ABORTED";
        case ESP_OTA_IMG_UNDEFINED:
        default:
            return "UNDEFINED";
    }
}

static hc_ota_img_state_t to_logic_ota_state(esp_ota_img_states_t st) {
    switch (st) {
        case ESP_OTA_IMG_NEW:
            return HC_OTA_IMG_NEW;
        case ESP_OTA_IMG_PENDING_VERIFY:
            return HC_OTA_IMG_PENDING_VERIFY;
        case ESP_OTA_IMG_VALID:
            return HC_OTA_IMG_VALID;
        case ESP_OTA_IMG_INVALID:
            return HC_OTA_IMG_INVALID;
        case ESP_OTA_IMG_ABORTED:
            return HC_OTA_IMG_ABORTED;
        case ESP_OTA_IMG_UNDEFINED:
        default:
            return HC_OTA_IMG_UNDEFINED;
    }
}

const char *hc_get_runtime_fw_version(void) {
    const esp_app_desc_t *desc = esp_app_get_description();
    return hc_ota_select_runtime_version(desc ? desc->version : NULL, HOMECORE_FW_VERSION);
}

void hc_ota_notify_heartbeat_ok(void) {
    s_heartbeat_ok = true;
}

bool hc_ota_needs_heartbeat(void) {
    return hc_ota_is_pending_verify() && !s_heartbeat_ok;
}

static esp_err_t post_ota_progress(
    const homecore_config_t *cfg,
    const char *history_id,
    const char *release_id,
    const char *status,
    int progress_pct,
    const char *reported_version,
    const char *error_msg
) {
    if (!cfg || !hc_wifi_is_connected() || strlen(cfg->backend_url) == 0 || strlen(cfg->device_api_token) == 0) {
        return ESP_ERR_INVALID_STATE;
    }

    char url[320];
    snprintf(url, sizeof(url), "%s/api/device/ota/progress", cfg->backend_url);

    char auth[192];
    snprintf(auth, sizeof(auth), "Bearer %s", cfg->device_api_token);

    cJSON *root = cJSON_CreateObject();
    if (!root) return ESP_ERR_NO_MEM;
    if (history_id && strlen(history_id) > 0) {
        cJSON_AddStringToObject(root, "historyId", history_id);
    }
    if (release_id && strlen(release_id) > 0) {
        cJSON_AddStringToObject(root, "releaseId", release_id);
    }
    cJSON_AddStringToObject(root, "status", status);
    cJSON_AddNumberToObject(root, "progressPercent", progress_pct);
    if (reported_version && strlen(reported_version) > 0) {
        cJSON_AddStringToObject(root, "firmwareVersion", reported_version);
    }
    cJSON_AddStringToObject(root, "boardSlug", HOMECORE_BOARD_SLUG);
    cJSON_AddStringToObject(root, "partitionScheme", HOMECORE_PARTITION_SCHEME);
    if (error_msg && strlen(error_msg) > 0) {
        cJSON_AddStringToObject(root, "errorMessage", error_msg);
    }

    char *body = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!body) return ESP_ERR_NO_MEM;

    esp_http_client_config_t http_cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .timeout_ms = 10000,
    };

    esp_http_client_handle_t client = esp_http_client_init(&http_cfg);
    if (!client) {
        cJSON_free(body);
        return ESP_ERR_NO_MEM;
    }
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "Authorization", auth);
    esp_http_client_set_post_field(client, body, strlen(body));

    esp_err_t err = esp_http_client_perform(client);
    int code = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    cJSON_free(body);

    if (err != ESP_OK || code < 200 || code >= 300) {
        ESP_LOGW(TAG, "OTA progress HTTP %s failed (err=%s, status=%d)", status, esp_err_to_name(err), code);
        return ESP_FAIL;
    }
    return ESP_OK;
}

static esp_err_t ota_http_client_init_cb(esp_http_client_handle_t http_client) {
    char auth[192];
    snprintf(auth, sizeof(auth), "Bearer %s", s_ota_token);
    esp_err_t err = esp_http_client_set_header(http_client, "Authorization", auth);
    if (err != ESP_OK) return err;
    esp_http_client_set_header(http_client, "X-Homecore-Board-Slug", HOMECORE_BOARD_SLUG);
    esp_http_client_set_header(http_client, "X-Homecore-Chip-Family", CONFIG_IDF_TARGET);
    esp_http_client_set_header(http_client, "X-Homecore-Partition-Scheme", HOMECORE_PARTITION_SCHEME);
    char flash_hdr[16];
    snprintf(flash_hdr, sizeof(flash_hdr), "%d", HOMECORE_FLASH_SIZE_MB);
    esp_http_client_set_header(http_client, "X-Homecore-Flash-Mb", flash_hdr);
    return ESP_OK;
}

static void ota_task(void *pvParam) {
    ota_job_t *job = (ota_job_t *)pvParam;
    hc_copy_str(s_ota_token, sizeof(s_ota_token), job->cfg.device_api_token);
    hc_nvs_clear_ota_pending();

    const esp_partition_t *running_before = esp_ota_get_running_partition();
    uint32_t prev_addr = running_before ? running_before->address : 0;

    char ota_url[320];
    snprintf(
        ota_url,
        sizeof(ota_url),
        "%s/api/device/firmware/ota/%s",
        job->cfg.backend_url,
        job->release_id
    );

    ESP_LOGI(
        TAG,
        "Starting HTTPS OTA: history_id=%s target_version=%s current_version=%s current_part=%s (0x%06lx)",
        job->history_id[0] ? job->history_id : "none",
        job->target_version[0] ? job->target_version : "unknown",
        hc_get_runtime_fw_version(),
        running_before ? running_before->label : "unknown",
        (unsigned long)prev_addr
    );

    // Report downloading phase BEFORE opening esp_https_ota TLS stream to avoid concurrent TLS handshakes
    post_ota_progress(
        &job->cfg,
        job->history_id,
        job->release_id,
        "downloading",
        10,
        hc_get_runtime_fw_version(),
        NULL
    );

    esp_http_client_config_t http_cfg = {
        .url = ota_url,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .timeout_ms = 30000,
        .buffer_size = 4096,
        .buffer_size_tx = 2048,
        .keep_alive_enable = true,
    };

    esp_https_ota_config_t ota_cfg = {
        .http_config = &http_cfg,
        .http_client_init_cb = ota_http_client_init_cb,
        .partial_http_download = true,
        .max_http_request_size = 65536,
    };

    esp_https_ota_handle_t handle = NULL;
    esp_err_t err = esp_https_ota_begin(&ota_cfg, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_https_ota_begin failed: %s", esp_err_to_name(err));
        post_ota_progress(
            &job->cfg,
            job->history_id,
            job->release_id,
            "failed",
            0,
            hc_get_runtime_fw_version(),
            esp_err_to_name(err)
        );
        s_ota_in_progress = false;
        free(job);
        vTaskDelete(NULL);
        return;
    }

    int last_pct = 10;
    int total_len = esp_https_ota_get_image_size(handle);
    while (1) {
        err = esp_https_ota_perform(handle);
        if (err != ESP_ERR_HTTPS_OTA_IN_PROGRESS) {
            break;
        }
        if (total_len > 0) {
            int read_len = esp_https_ota_get_image_len_read(handle);
            int pct = 10 + (int)(((int64_t)read_len * 80) / total_len);
            if (pct > 90) pct = 90;
            if (pct - last_pct >= 10) {
                last_pct = pct;
                // Publish streaming progress via existing MQTT TLS session (never open a 2nd HTTPS TLS socket mid-stream)
                hc_mqtt_publish_ota_progress(job->history_id, "flashing", pct);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(5));
    }

    if (err != ESP_OK || !esp_https_ota_is_complete_data_received(handle)) {
        ESP_LOGE(TAG, "OTA image transfer incomplete/failed: %s", esp_err_to_name(err));
        esp_https_ota_abort(handle);
        post_ota_progress(
            &job->cfg,
            job->history_id,
            job->release_id,
            "failed",
            last_pct,
            hc_get_runtime_fw_version(),
            err != ESP_OK ? esp_err_to_name(err) : "OTA stream failed or incomplete"
        );
        s_ota_in_progress = false;
        free(job);
        vTaskDelete(NULL);
        return;
    }

    // Finish & validate image BEFORE persisting pending OTA state and reporting rebooting
    esp_err_t finish_err = esp_https_ota_finish(handle);
    if (finish_err != ESP_OK) {
        ESP_LOGE(TAG, "esp_https_ota_finish failed: %s", esp_err_to_name(finish_err));
        post_ota_progress(
            &job->cfg,
            job->history_id,
            job->release_id,
            "failed",
            90,
            hc_get_runtime_fw_version(),
            esp_err_to_name(finish_err)
        );
        s_ota_in_progress = false;
        free(job);
        vTaskDelete(NULL);
        return;
    }

    const esp_partition_t *boot_after = esp_ota_get_boot_partition();
    uint32_t target_addr = boot_after ? boot_after->address : 0;

    hc_ota_pending_t pend = {0};
    pend.active = true;
    pend.state = HC_OTA_PEND_REBOOT_PENDING;
    pend.boot_count = 0;
    hc_copy_str(pend.history_id, sizeof(pend.history_id), job->history_id);
    hc_copy_str(pend.release_id, sizeof(pend.release_id), job->release_id);
    hc_copy_str(pend.target_version, sizeof(pend.target_version), job->target_version);
    pend.prev_part_addr = prev_addr;
    pend.target_part_addr = target_addr;
    snprintf(
        pend.diag_msg,
        sizeof(pend.diag_msg),
        "Flashed slot 0x%06lx from 0x%06lx",
        (unsigned long)target_addr,
        (unsigned long)prev_addr
    );
    hc_nvs_save_ota_pending(&pend);

    ESP_LOGI(
        TAG,
        "OTA flashed & verified signature: history_id=%s target_version=%s prev_addr=0x%06lx next_boot_part=%s (0x%06lx)",
        pend.history_id[0] ? pend.history_id : "none",
        pend.target_version[0] ? pend.target_version : "unknown",
        (unsigned long)pend.prev_part_addr,
        boot_after ? boot_after->label : "unknown",
        (unsigned long)pend.target_part_addr
    );

    post_ota_progress(
        &job->cfg,
        job->history_id,
        job->release_id,
        "rebooting",
        95,
        hc_get_runtime_fw_version(),
        NULL
    );

    ESP_LOGI(TAG, "Rebooting into pending OTA partition...");
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
}

void hc_ota_start_async(
    const homecore_config_t *cfg,
    const char *release_id,
    const char *history_id,
    const char *target_version
) {
    if (s_ota_in_progress || !cfg || !release_id || strlen(release_id) == 0) {
        return;
    }
    ota_job_t *job = calloc(1, sizeof(ota_job_t));
    if (!job) return;
    memcpy(&job->cfg, cfg, sizeof(homecore_config_t));
    hc_copy_str(job->release_id, sizeof(job->release_id), release_id);
    if (history_id) hc_copy_str(job->history_id, sizeof(job->history_id), history_id);
    if (target_version) hc_copy_str(job->target_version, sizeof(job->target_version), target_version);

    s_ota_in_progress = true;
    xTaskCreate(ota_task, "hc_ota_task", 12288, job, 5, NULL);
}

bool hc_ota_is_bootloader_pending_verify(void) {
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t ota_state = ESP_OTA_IMG_UNDEFINED;
    if (running && esp_ota_get_state_partition(running, &ota_state) == ESP_OK) {
        return ota_state == ESP_OTA_IMG_PENDING_VERIFY;
    }
    return false;
}

bool hc_ota_is_pending_verify(void) {
    if (hc_ota_is_bootloader_pending_verify()) {
        return true;
    }
    hc_ota_pending_t pend;
    return hc_nvs_load_ota_pending(&pend);
}

static hc_ota_health_result_t run_first_boot_health_check(
    const homecore_config_t *cfg,
    bool has_pending,
    const hc_ota_pending_t *pend,
    const esp_partition_t *running,
    const char *running_ver,
    char *err_buf,
    size_t err_cap
) {
    if (err_buf && err_cap > 0) err_buf[0] = '\0';

    // 1. Deterministic firmware/partition check against pending OTA metadata
    if (has_pending && pend) {
        if (pend->target_part_addr != 0 && (!running || running->address != pend->target_part_addr)) {
            snprintf(
                err_buf,
                err_cap,
                "Running partition mismatch (current=0x%06lx expected=0x%06lx)",
                running ? (unsigned long)running->address : 0UL,
                (unsigned long)pend->target_part_addr
            );
            return HC_OTA_HEALTH_FAIL;
        }
        if (pend->target_version[0] != '\0' && !hc_ota_versions_equal(running_ver, pend->target_version)) {
            snprintf(
                err_buf,
                err_cap,
                "Firmware version mismatch (running=%s expected=%s)",
                running_ver ? running_ver : "unknown",
                pend->target_version
            );
            return HC_OTA_HEALTH_FAIL;
        }
    }

    // 2. Local subsystem integrity (NVS + heap + minimum startup stability window)
    bool nvs_ok = hc_nvs_health_check();
    uint32_t free_heap = esp_get_free_heap_size();
    bool heap_ok = (free_heap >= HC_OTA_MIN_HEALTH_HEAP_BYTES);
    int64_t uptime_us = esp_timer_get_time();
    bool uptime_ok = (uptime_us >= HC_OTA_MIN_UPTIME_US);

    if (!nvs_ok) {
        snprintf(err_buf, err_cap, "NVS health check failed on first boot");
        return HC_OTA_HEALTH_FAIL;
    }

    // 3. Connectivity checks (only wait when paired/Wi-Fi enabled; do NOT fail on transient network loss)
    bool wifi_ok = true;
    bool mqtt_ok = true;
    bool hb_ok = true;
    if (cfg && cfg->paired && HOMECORE_HAS_WIFI) {
        wifi_ok = hc_wifi_is_connected();
        mqtt_ok = hc_mqtt_is_connected();
        hb_ok = s_heartbeat_ok;
    } else if (HOMECORE_HAS_WIFI && cfg && strlen(cfg->wifi_ssid) > 0) {
        wifi_ok = hc_wifi_is_connected();
    }

    if (!uptime_ok || !heap_ok || !wifi_ok || !mqtt_ok || !hb_ok) {
        if (uptime_us - s_last_wait_log_us >= HC_OTA_WAIT_LOG_INTERVAL_US || s_last_wait_log_us == 0) {
            s_last_wait_log_us = uptime_us;
            ESP_LOGI(
                TAG,
                "First-boot health check WAIT: uptime_ms=%lld heap=%lu wifi=%d mqtt=%d heartbeat=%d",
                (long long)(uptime_us / 1000LL),
                (unsigned long)free_heap,
                wifi_ok ? 1 : 0,
                mqtt_ok ? 1 : 0,
                hb_ok ? 1 : 0
            );
        }
        return HC_OTA_HEALTH_WAIT;
    }

    ESP_LOGI(
        TAG,
        "First-boot health check PASS: uptime_ms=%lld heap=%lu nvs=%d wifi=%d mqtt=%d heartbeat=%d",
        (long long)(uptime_us / 1000LL),
        (unsigned long)free_heap,
        nvs_ok ? 1 : 0,
        wifi_ok ? 1 : 0,
        mqtt_ok ? 1 : 0,
        hb_ok ? 1 : 0
    );
    return HC_OTA_HEALTH_PASS;
}

void hc_ota_process_boot_validation(const homecore_config_t *cfg) {
    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_partition_t *invalid = esp_ota_get_last_invalid_partition();
    esp_ota_img_states_t ota_state = ESP_OTA_IMG_UNDEFINED;
    if (running) {
        esp_ota_get_state_partition(running, &ota_state);
    }

    hc_ota_pending_t pend;
    bool has_pending = hc_nvs_load_ota_pending(&pend);

    if (!has_pending && ota_state != ESP_OTA_IMG_PENDING_VERIFY) {
        return;
    }

    const esp_app_desc_t *desc = esp_app_get_description();
    const char *running_ver = hc_get_runtime_fw_version();

    if (!s_boot_diag_logged) {
        s_boot_diag_logged = true;
        if (has_pending && pend.boot_count < 255) {
            pend.boot_count += 1;
            hc_nvs_save_ota_pending(&pend);
        }
        ESP_LOGI(
            TAG,
            "OTA boot diagnostics: history_id=%s state=%u boot_count=%u target_ver=%s prev_addr=0x%06lx target_addr=0x%06lx "
            "running_part=%s (0x%06lx) running_ver=%s (kconfig=%s app_desc=%s) ota_state=%s invalid_part=%s (0x%06lx)",
            has_pending && pend.history_id[0] ? pend.history_id : "none",
            has_pending ? (unsigned)pend.state : 0U,
            has_pending ? (unsigned)pend.boot_count : 0U,
            has_pending && pend.target_version[0] ? pend.target_version : "none",
            has_pending ? (unsigned long)pend.prev_part_addr : 0UL,
            has_pending ? (unsigned long)pend.target_part_addr : 0UL,
            running ? running->label : "none",
            running ? (unsigned long)running->address : 0UL,
            running_ver,
            HOMECORE_FW_VERSION,
            desc ? desc->version : "none",
            ota_state_to_str(ota_state),
            invalid ? invalid->label : "none",
            invalid ? (unsigned long)invalid->address : 0UL
        );
    }

    char health_err[160] = {0};
    hc_ota_health_result_t health_res = HC_OTA_HEALTH_WAIT;
    if (ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
        health_res = run_first_boot_health_check(
            cfg,
            has_pending,
            &pend,
            running,
            running_ver,
            health_err,
            sizeof(health_err)
        );
    } else if (has_pending && pend.target_version[0] != '\0' && !hc_ota_versions_equal(running_ver, pend.target_version)) {
        snprintf(
            health_err,
            sizeof(health_err),
            "Firmware version mismatch (running=%s expected=%s)",
            running_ver ? running_ver : "unknown",
            pend.target_version
        );
        health_res = HC_OTA_HEALTH_FAIL;
    }

    hc_ota_boot_eval_input_t eval_in = {
        .has_pending = has_pending,
        .ota_state = to_logic_ota_state(ota_state),
        .running_addr = running ? running->address : 0U,
        .invalid_addr = invalid ? invalid->address : 0U,
        .prev_addr = has_pending ? pend.prev_part_addr : 0U,
        .target_addr = has_pending ? pend.target_part_addr : 0U,
        .running_version = running_ver,
        .target_version = has_pending ? pend.target_version : NULL,
        .health_result = health_res,
    };

    hc_ota_boot_decision_t decision = hc_ota_evaluate_boot_state(&eval_in);

    switch (decision) {
        case HC_OTA_DECISION_ROLLED_BACK: {
            if (pend.state != HC_OTA_PEND_ROLLED_BACK) {
                pend.state = HC_OTA_PEND_ROLLED_BACK;
                hc_copy_str(pend.diag_msg, sizeof(pend.diag_msg), "Bootloader rolled back to previous firmware");
                hc_nvs_save_ota_pending(&pend);
            }
            ESP_LOGE(
                TAG,
                "OTA decision=ROLLED_BACK: history_id=%s running_ver=%s target_ver=%s running_addr=0x%06lx prev_addr=0x%06lx target_addr=0x%06lx invalid_addr=0x%06lx",
                pend.history_id[0] ? pend.history_id : "none",
                running_ver,
                pend.target_version[0] ? pend.target_version : "unknown",
                running ? (unsigned long)running->address : 0UL,
                (unsigned long)pend.prev_part_addr,
                (unsigned long)pend.target_part_addr,
                invalid ? (unsigned long)invalid->address : 0UL
            );
            int64_t now_us = esp_timer_get_time();
            if (
                cfg &&
                cfg->paired &&
                hc_wifi_is_connected() &&
                (s_last_report_attempt_us == 0 || now_us - s_last_report_attempt_us >= 5000000LL)
            ) {
                s_last_report_attempt_us = now_us;
                if (post_ota_progress(
                        cfg,
                        pend.history_id,
                        pend.release_id,
                        "rolled_back",
                        0,
                        running_ver,
                        "Controller rolled back to previous firmware partition after first-boot failure"
                    ) == ESP_OK) {
                    hc_nvs_clear_ota_pending();
                }
            }
            break;
        }
        case HC_OTA_DECISION_FAIL_AND_ROLLBACK: {
            if (has_pending && pend.state != HC_OTA_PEND_FAILED) {
                pend.state = HC_OTA_PEND_FAILED;
                hc_copy_str(pend.diag_msg, sizeof(pend.diag_msg), health_err[0] ? health_err : "First-boot check failed");
                hc_nvs_save_ota_pending(&pend);
            }
            ESP_LOGE(
                TAG,
                "OTA decision=FAIL_AND_ROLLBACK: history_id=%s reason=%s running_ver=%s",
                has_pending && pend.history_id[0] ? pend.history_id : "none",
                health_err[0] ? health_err : "First-boot validation failed",
                running_ver
            );
            if (has_pending && cfg && cfg->paired && hc_wifi_is_connected()) {
                if (post_ota_progress(
                        cfg,
                        pend.history_id,
                        pend.release_id,
                        "failed",
                        0,
                        running_ver,
                        health_err[0] ? health_err : "First-boot validation failed"
                    ) == ESP_OK) {
                    hc_nvs_clear_ota_pending();
                }
            }
            esp_ota_mark_app_invalid_rollback_and_reboot();
            break;
        }
        case HC_OTA_DECISION_FAIL_NO_ROLLBACK: {
            ESP_LOGE(
                TAG,
                "OTA decision=FAIL_NO_ROLLBACK: history_id=%s reason=%s running_ver=%s",
                pend.history_id[0] ? pend.history_id : "none",
                health_err[0] ? health_err : "Firmware metadata mismatch",
                running_ver
            );
            int64_t now_us = esp_timer_get_time();
            if (
                cfg &&
                cfg->paired &&
                hc_wifi_is_connected() &&
                (s_last_report_attempt_us == 0 || now_us - s_last_report_attempt_us >= 5000000LL)
            ) {
                s_last_report_attempt_us = now_us;
                if (post_ota_progress(
                        cfg,
                        pend.history_id,
                        pend.release_id,
                        "failed",
                        0,
                        running_ver,
                        health_err[0] ? health_err : "Firmware metadata mismatch"
                    ) == ESP_OK) {
                    hc_nvs_clear_ota_pending();
                }
            }
            break;
        }
        case HC_OTA_DECISION_CONFIRM_AND_REPORT: {
            esp_err_t cerr = esp_ota_mark_app_valid_cancel_rollback();
            if (cerr != ESP_OK) {
                ESP_LOGE(TAG, "esp_ota_mark_app_valid_cancel_rollback failed: %s", esp_err_to_name(cerr));
                break;
            }
            if (has_pending) {
                pend.state = HC_OTA_PEND_CONFIRMED;
                hc_copy_str(pend.diag_msg, sizeof(pend.diag_msg), "First-boot validation confirmed");
                hc_nvs_save_ota_pending(&pend);
            }
            ESP_LOGI(
                TAG,
                "OTA decision=CONFIRMED: history_id=%s part=%s (0x%06lx) running_ver=%s",
                has_pending && pend.history_id[0] ? pend.history_id : "none",
                running ? running->label : "none",
                running ? (unsigned long)running->address : 0UL,
                running_ver
            );
            if (has_pending && cfg && cfg->paired && hc_wifi_is_connected()) {
                s_last_report_attempt_us = esp_timer_get_time();
                if (post_ota_progress(
                        cfg,
                        pend.history_id,
                        pend.release_id,
                        "succeeded",
                        100,
                        running_ver,
                        NULL
                    ) == ESP_OK) {
                    hc_nvs_clear_ota_pending();
                }
            } else if (!has_pending) {
                ESP_LOGI(TAG, "Cleared PENDING_VERIFY state on standalone partition");
            }
            break;
        }
        case HC_OTA_DECISION_REPORT_SUCCEEDED: {
            int64_t now_us = esp_timer_get_time();
            if (
                cfg &&
                cfg->paired &&
                hc_wifi_is_connected() &&
                (s_last_report_attempt_us == 0 || now_us - s_last_report_attempt_us >= 5000000LL)
            ) {
                s_last_report_attempt_us = now_us;
                if (post_ota_progress(
                        cfg,
                        pend.history_id,
                        pend.release_id,
                        "succeeded",
                        100,
                        running_ver,
                        NULL
                    ) == ESP_OK) {
                    ESP_LOGI(TAG, "OTA post-confirm progress reported cleanly (history_id=%s)", pend.history_id);
                    hc_nvs_clear_ota_pending();
                }
            }
            break;
        }
        case HC_OTA_DECISION_WAIT:
        case HC_OTA_DECISION_NONE:
        default:
            break;
    }
}
