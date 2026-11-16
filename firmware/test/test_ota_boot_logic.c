#include "../main/ota_boot_logic.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void test_runtime_version_prefers_app_desc(void) {
    assert(strcmp(hc_ota_select_runtime_version("1.2.9", "1.2.0"), "1.2.9") == 0);
    assert(strcmp(hc_ota_select_runtime_version("1.2.0", "1.2.9"), "1.2.0") == 0);
    assert(strcmp(hc_ota_select_runtime_version("1", "1.2.9"), "1.2.9") == 0);
    assert(strcmp(hc_ota_select_runtime_version("v1.2.0-g1234", "1.2.9"), "1.2.9") == 0);
    assert(strcmp(hc_ota_select_runtime_version("", "1.2.9"), "1.2.9") == 0);
    assert(strcmp(hc_ota_select_runtime_version("", ""), "unknown") == 0);
}

static void test_steady_state_unrelated_invalid_partition_ignored(void) {
    // Normal boot with no active pending OTA and an older invalid partition must do nothing.
    hc_ota_boot_eval_input_t in = {
        .has_pending = false,
        .ota_state = HC_OTA_IMG_VALID,
        .running_addr = 0x020000,
        .invalid_addr = 0x320000,
        .prev_addr = 0,
        .target_addr = 0,
        .running_version = "1.2.0",
        .target_version = NULL,
        .health_result = HC_OTA_HEALTH_PASS,
    };
    assert(hc_ota_evaluate_boot_state(&in) == HC_OTA_DECISION_NONE);
}

static void test_historical_invalid_partition_does_not_rollback_clean_v129_ota(void) {
    // Scenario 5: Previously invalid partition exists at prev_addr (0x020000) from an earlier OTA,
    // while current OTA cleanly boots v1.2.9 on target_addr (0x320000) and passes health checks.
    hc_ota_boot_eval_input_t in = {
        .has_pending = true,
        .ota_state = HC_OTA_IMG_PENDING_VERIFY,
        .running_addr = 0x320000,
        .invalid_addr = 0x020000,
        .prev_addr = 0x020000,
        .target_addr = 0x320000,
        .running_version = "1.2.9",
        .target_version = "1.2.9",
        .health_result = HC_OTA_HEALTH_PASS,
    };
    assert(hc_ota_evaluate_boot_state(&in) == HC_OTA_DECISION_CONFIRM_AND_REPORT);

    // Same scenario after already confirming (e.g. retrying succeeded HTTP callback after brief outage)
    in.ota_state = HC_OTA_IMG_VALID;
    assert(hc_ota_evaluate_boot_state(&in) == HC_OTA_DECISION_REPORT_SUCCEEDED);
}

static void test_transient_heartbeat_failure_waits_then_confirms(void) {
    // Scenario 4: Heartbeat temporarily fails -> WAIT (no confirm, no rollback), then passes -> CONFIRM.
    hc_ota_boot_eval_input_t in = {
        .has_pending = true,
        .ota_state = HC_OTA_IMG_PENDING_VERIFY,
        .running_addr = 0x320000,
        .invalid_addr = 0,
        .prev_addr = 0x020000,
        .target_addr = 0x320000,
        .running_version = "1.2.9",
        .target_version = "1.2.9",
        .health_result = HC_OTA_HEALTH_WAIT,
    };
    assert(hc_ota_evaluate_boot_state(&in) == HC_OTA_DECISION_WAIT);

    in.health_result = HC_OTA_HEALTH_PASS;
    assert(hc_ota_evaluate_boot_state(&in) == HC_OTA_DECISION_CONFIRM_AND_REPORT);
}

static void test_genuine_bootloader_rollback_detected(void) {
    // Scenario 6: Device failed/crashed before confirming target_addr (0x320000),
    // bootloader rolled back to prev_addr (0x020000) running v1.2.0.
    hc_ota_boot_eval_input_t in = {
        .has_pending = true,
        .ota_state = HC_OTA_IMG_VALID,
        .running_addr = 0x020000,
        .invalid_addr = 0x320000,
        .prev_addr = 0x020000,
        .target_addr = 0x320000,
        .running_version = "1.2.0",
        .target_version = "1.2.9",
        .health_result = HC_OTA_HEALTH_PASS,
    };
    assert(hc_ota_evaluate_boot_state(&in) == HC_OTA_DECISION_ROLLED_BACK);
}

static void test_wrong_embedded_version_fails_and_rolls_back(void) {
    // Scenario 7: OTA slot booted an image reporting v1.2.0 when target_version was v1.2.9.
    hc_ota_boot_eval_input_t in = {
        .has_pending = true,
        .ota_state = HC_OTA_IMG_PENDING_VERIFY,
        .running_addr = 0x320000,
        .invalid_addr = 0,
        .prev_addr = 0x020000,
        .target_addr = 0x320000,
        .running_version = "1.2.0",
        .target_version = "1.2.9",
        .health_result = HC_OTA_HEALTH_PASS,
    };
    assert(hc_ota_evaluate_boot_state(&in) == HC_OTA_DECISION_FAIL_AND_ROLLBACK);

    in.ota_state = HC_OTA_IMG_VALID;
    assert(hc_ota_evaluate_boot_state(&in) == HC_OTA_DECISION_FAIL_NO_ROLLBACK);
}

static void test_wrong_partition_slot_fails_and_rolls_back(void) {
    hc_ota_boot_eval_input_t in = {
        .has_pending = true,
        .ota_state = HC_OTA_IMG_PENDING_VERIFY,
        .running_addr = 0x020000,
        .invalid_addr = 0,
        .prev_addr = 0x020000,
        .target_addr = 0x320000,
        .running_version = "1.2.9",
        .target_version = "1.2.9",
        .health_result = HC_OTA_HEALTH_PASS,
    };
    assert(hc_ota_evaluate_boot_state(&in) == HC_OTA_DECISION_FAIL_AND_ROLLBACK);
}

int main(void) {
    test_runtime_version_prefers_app_desc();
    test_steady_state_unrelated_invalid_partition_ignored();
    test_historical_invalid_partition_does_not_rollback_clean_v129_ota();
    test_transient_heartbeat_failure_waits_then_confirms();
    test_genuine_bootloader_rollback_detected();
    test_wrong_embedded_version_fails_and_rolls_back();
    test_wrong_partition_slot_fails_and_rolls_back();
    printf("All C OTA boot logic unit tests passed!\n");
    return 0;
}
