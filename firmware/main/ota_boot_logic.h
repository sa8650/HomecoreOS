#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    HC_OTA_IMG_NEW = 0,
    HC_OTA_IMG_PENDING_VERIFY = 1,
    HC_OTA_IMG_VALID = 2,
    HC_OTA_IMG_INVALID = 3,
    HC_OTA_IMG_ABORTED = 4,
    HC_OTA_IMG_UNDEFINED = 0xFFFFFFFFu,
} hc_ota_img_state_t;

typedef enum {
    HC_OTA_HEALTH_WAIT = 0,
    HC_OTA_HEALTH_PASS = 1,
    HC_OTA_HEALTH_FAIL = 2,
} hc_ota_health_result_t;

typedef enum {
    HC_OTA_DECISION_NONE = 0,
    HC_OTA_DECISION_WAIT = 1,
    HC_OTA_DECISION_CONFIRM_AND_REPORT = 2,
    HC_OTA_DECISION_REPORT_SUCCEEDED = 3,
    HC_OTA_DECISION_ROLLED_BACK = 4,
    HC_OTA_DECISION_FAIL_AND_ROLLBACK = 5,
    HC_OTA_DECISION_FAIL_NO_ROLLBACK = 6,
} hc_ota_boot_decision_t;

typedef struct {
    bool has_pending;
    hc_ota_img_state_t ota_state;
    uint32_t running_addr;
    uint32_t invalid_addr;
    uint32_t prev_addr;
    uint32_t target_addr;
    const char *running_version;
    const char *target_version;
    hc_ota_health_result_t health_result;
} hc_ota_boot_eval_input_t;

bool hc_ota_versions_equal(const char *a, const char *b);
const char *hc_ota_select_runtime_version(
    const char *app_desc_version,
    const char *kconfig_version
);
hc_ota_boot_decision_t hc_ota_evaluate_boot_state(const hc_ota_boot_eval_input_t *in);
