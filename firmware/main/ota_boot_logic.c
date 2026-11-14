#include "ota_boot_logic.h"

#include <stddef.h>
#include <string.h>

static const char *strip_v_prefix(const char *v) {
    if (!v) return "";
    while (*v == ' ' || *v == '\t') v++;
    if (*v == 'v' || *v == 'V') v++;
    return v;
}

bool hc_ota_versions_equal(const char *a, const char *b) {
    const char *ca = strip_v_prefix(a);
    const char *cb = strip_v_prefix(b);
    if (ca[0] == '\0' || cb[0] == '\0') return false;
    return strcmp(ca, cb) == 0;
}

static bool is_valid_app_desc_version(const char *ver) {
    if (!ver || ver[0] == '\0') return false;
    if (strcmp(ver, "0") == 0 || strcmp(ver, "1") == 0) return false;
    if (strstr(ver, "-dirty") != NULL || strstr(ver, "-g") != NULL) return false;
    return true;
}

const char *hc_ota_select_runtime_version(
    const char *app_desc_version,
    const char *kconfig_version
) {
    if (is_valid_app_desc_version(app_desc_version)) {
        return app_desc_version;
    }
    if (kconfig_version && kconfig_version[0] != '\0') {
        return kconfig_version;
    }
    if (app_desc_version && app_desc_version[0] != '\0') {
        return app_desc_version;
    }
    return "unknown";
}

hc_ota_boot_decision_t hc_ota_evaluate_boot_state(const hc_ota_boot_eval_input_t *in) {
    if (!in) return HC_OTA_DECISION_NONE;

    const bool is_pending_verify = (in->ota_state == HC_OTA_IMG_PENDING_VERIFY);

    if (!in->has_pending && !is_pending_verify) {
        return HC_OTA_DECISION_NONE;
    }

    const bool has_target_addr = (in->target_addr != 0);
    const bool has_prev_addr = (in->prev_addr != 0);
    const bool on_target_slot =
        has_target_addr && (in->running_addr != 0) && (in->running_addr == in->target_addr);
    const bool on_prev_slot =
        has_prev_addr && (in->running_addr != 0) && (in->running_addr == in->prev_addr) && !on_target_slot;
    const bool this_target_invalid =
        has_target_addr && (in->invalid_addr != 0) && (in->invalid_addr == in->target_addr) && !on_target_slot;

    // Rollback detection is strictly tied to THIS OTA attempt's partition evidence.
    // An unrelated invalid partition from an earlier update (invalid_addr != target_addr)
    // does NOT mark the current OTA attempt as rolled back.
    if (in->has_pending && !is_pending_verify) {
        if (on_prev_slot || this_target_invalid) {
            return HC_OTA_DECISION_ROLLED_BACK;
        }
    }

    const bool has_target_ver = (in->target_version && in->target_version[0] != '\0');
    const bool version_ok =
        !has_target_ver || hc_ota_versions_equal(in->running_version, in->target_version);
    const bool partition_ok =
        !in->has_pending ||
        (has_target_addr ? on_target_slot : (!has_prev_addr || !on_prev_slot));

    // Pending verify image running in bootloader verification state
    if (is_pending_verify) {
        if (in->has_pending && (!partition_ok || !version_ok)) {
            return HC_OTA_DECISION_FAIL_AND_ROLLBACK;
        }
        if (in->health_result == HC_OTA_HEALTH_FAIL) {
            return HC_OTA_DECISION_FAIL_AND_ROLLBACK;
        }
        if (in->health_result == HC_OTA_HEALTH_PASS) {
            return HC_OTA_DECISION_CONFIRM_AND_REPORT;
        }
        return HC_OTA_DECISION_WAIT;
    }

    // Already confirmed in otadata (ESP_OTA_IMG_VALID), retrying terminal report after transient outage
    if (in->has_pending) {
        if (!partition_ok || !version_ok) {
            return HC_OTA_DECISION_FAIL_NO_ROLLBACK;
        }
        return HC_OTA_DECISION_REPORT_SUCCEEDED;
    }

    return HC_OTA_DECISION_NONE;
}
