#include "../main/provisioning_logic.h"

#include <assert.h>
#include <stdio.h>

static void test_initial_boot_modes(void) {
    // 1. Fresh unprovisioned Wi-Fi + BLE board -> UNPROVISIONED (BLE + AP active)
    hc_prov_boot_input_t fresh_s3 = {
        .has_wifi = true,
        .has_ble = true,
        .paired = false,
        .has_wifi_ssid = false,
        .has_backend_url = false,
        .has_pending_pair_code = false,
        .recovery_requested = false,
    };
    hc_prov_state_t st;
    hc_prov_init_state(&st, &fresh_s3);
    assert(st.mode == HC_PROV_MODE_UNPROVISIONED);
    assert(hc_prov_should_ble_be_active(&st) == true);
    assert(hc_prov_should_ap_be_active(&st) == true);

    // 2. Previously paired & configured board rebooting when router is offline -> NORMAL (NEVER auto-opens BLE or AP!)
    hc_prov_boot_input_t paired_s3 = {
        .has_wifi = true,
        .has_ble = true,
        .paired = true,
        .has_wifi_ssid = true,
        .has_backend_url = true,
        .has_pending_pair_code = false,
        .recovery_requested = false,
    };
    hc_prov_init_state(&st, &paired_s3);
    assert(st.mode == HC_PROV_MODE_NORMAL);
    assert(hc_prov_should_ble_be_active(&st) == false);
    assert(hc_prov_should_ap_be_active(&st) == false);

    // 3. ESP32-S2 (no BLE): unprovisioned -> AP active, BLE NEVER active
    hc_prov_boot_input_t fresh_s2 = {
        .has_wifi = true,
        .has_ble = false,
        .paired = false,
        .has_wifi_ssid = false,
        .has_backend_url = false,
        .recovery_requested = false,
    };
    hc_prov_init_state(&st, &fresh_s2);
    assert(st.mode == HC_PROV_MODE_UNPROVISIONED);
    assert(hc_prov_should_ble_be_active(&st) == false);
    assert(hc_prov_should_ap_be_active(&st) == true);

    // 4. ESP32-H2 (BLE only, no Wi-Fi): unprovisioned -> BLE active, AP NEVER active
    hc_prov_boot_input_t fresh_h2 = {
        .has_wifi = false,
        .has_ble = true,
        .paired = false,
        .has_wifi_ssid = false,
        .has_backend_url = false,
        .recovery_requested = false,
    };
    hc_prov_init_state(&st, &fresh_h2);
    assert(st.mode == HC_PROV_MODE_UNPROVISIONED);
    assert(hc_prov_should_ble_be_active(&st) == true);
    assert(hc_prov_should_ap_be_active(&st) == false);

    // Paired ESP32-H2 -> NORMAL (BLE deinit / off)
    hc_prov_boot_input_t paired_h2 = {
        .has_wifi = false,
        .has_ble = true,
        .paired = true,
        .has_wifi_ssid = false,
        .has_backend_url = true,
        .recovery_requested = false,
    };
    hc_prov_init_state(&st, &paired_h2);
    assert(st.mode == HC_PROV_MODE_NORMAL);
    assert(hc_prov_should_ble_be_active(&st) == false);
    assert(hc_prov_should_ap_be_active(&st) == false);

    // 5. Explicit recovery requested on paired controller -> RECOVERY (preserves saved config)
    hc_prov_boot_input_t rec_s3 = paired_s3;
    rec_s3.recovery_requested = true;
    hc_prov_init_state(&st, &rec_s3);
    assert(st.mode == HC_PROV_MODE_RECOVERY);
    assert(st.paired == true);
    assert(st.has_saved_config == true);
    assert(hc_prov_should_ble_be_active(&st) == true);
    assert(hc_prov_should_ap_be_active(&st) == true);
}

static void test_three_second_boot_press_opens_both_temporary_interfaces(void) {
    // Requirement: a single 3-second BOOT press must open BOTH the temporary
    // Wi-Fi setup network and BLE — on a paired board and on a fresh one, and
    // without erasing anything.
    for (int paired = 0; paired <= 1; paired++) {
        hc_prov_boot_input_t in = {
            .has_wifi = true,
            .has_ble = true,
            .paired = paired == 1,
            .has_wifi_ssid = true,
            .has_backend_url = true,
            .has_pending_pair_code = false,
            .recovery_requested = true,
        };
        hc_prov_state_t st;
        hc_prov_init_state(&st, &in);
        assert(st.mode == HC_PROV_MODE_RECOVERY);
        assert(hc_prov_should_ap_be_active(&st) == true);
        assert(hc_prov_should_ble_be_active(&st) == true);
        // Recovery never removes the saved configuration that boot restored.
        assert(st.paired == (paired == 1));
        assert(st.has_saved_config == true);
    }

    // A board with no Wi-Fi radio opens BLE only; one with no BLE opens the AP
    // only. Neither pretends an interface it does not have is running.
    hc_prov_boot_input_t h2 = {
        .has_wifi = false, .has_ble = true, .paired = false,
        .has_backend_url = true, .recovery_requested = true,
    };
    hc_prov_state_t st;
    hc_prov_init_state(&st, &h2);
    assert(hc_prov_should_ble_be_active(&st) == true);
    assert(hc_prov_should_ap_be_active(&st) == false);

    hc_prov_boot_input_t wifi_only = {
        .has_wifi = true, .has_ble = false, .paired = true,
        .has_wifi_ssid = true, .has_backend_url = true, .recovery_requested = true,
    };
    hc_prov_init_state(&st, &wifi_only);
    assert(hc_prov_should_ap_be_active(&st) == true);
    assert(hc_prov_should_ble_be_active(&st) == false);
}

static void test_recovery_timeout_and_transitions(void) {
    hc_prov_boot_input_t paired_s3 = {
        .has_wifi = true,
        .has_ble = true,
        .paired = true,
        .has_wifi_ssid = true,
        .has_backend_url = true,
        .recovery_requested = false,
    };
    hc_prov_state_t st;
    hc_prov_init_state(&st, &paired_s3);
    assert(st.mode == HC_PROV_MODE_NORMAL);

    // Enter recovery explicitly
    hc_prov_enter_recovery(&st);
    assert(st.mode == HC_PROV_MODE_RECOVERY);
    assert(hc_prov_should_ble_be_active(&st) == true);
    assert(hc_prov_should_ap_be_active(&st) == true);

    // Tick 14m 59.5s -> still in RECOVERY
    bool timed_out = false;
    assert(hc_prov_tick(&st, HC_PROV_RECOVERY_TIMEOUT_MS - 500U, &timed_out) == false);
    assert(timed_out == false);
    assert(st.mode == HC_PROV_MODE_RECOVERY);

    // Cross 15m boundary -> transitions cleanly back to NORMAL without clearing saved config
    assert(hc_prov_tick(&st, 500U, &timed_out) == true);
    assert(timed_out == true);
    assert(st.mode == HC_PROV_MODE_NORMAL);
    assert(st.paired == true);
    assert(st.has_saved_config == true);
    assert(hc_prov_should_ble_be_active(&st) == false);
    assert(hc_prov_should_ap_be_active(&st) == false);

    // Provisioning completion transitions from UNPROVISIONED/RECOVERY to NORMAL
    hc_prov_boot_input_t fresh = {
        .has_wifi = true,
        .has_ble = true,
        .paired = false,
        .has_wifi_ssid = false,
        .has_backend_url = false,
    };
    hc_prov_init_state(&st, &fresh);
    assert(st.mode == HC_PROV_MODE_UNPROVISIONED);
    hc_prov_on_pairing_completed(&st);
    assert(st.mode == HC_PROV_MODE_NORMAL);
    assert(st.paired == true);
    assert(hc_prov_should_ble_be_active(&st) == false);
    assert(hc_prov_should_ap_be_active(&st) == false);

    // Wi-Fi-only update on already-paired device in RECOVERY returns to NORMAL
    hc_prov_enter_recovery(&st);
    hc_prov_on_wifi_reconfigured(&st, true, true);
    assert(st.mode == HC_PROV_MODE_NORMAL);
    assert(st.paired == true);
}

static void test_wifi_exponential_backoff(void) {
    assert(hc_prov_wifi_backoff_ms(0) == 2000U);
    assert(hc_prov_wifi_backoff_ms(1) == 4000U);
    assert(hc_prov_wifi_backoff_ms(2) == 8000U);
    assert(hc_prov_wifi_backoff_ms(3) == 16000U);
    assert(hc_prov_wifi_backoff_ms(4) == 32000U);
    assert(hc_prov_wifi_backoff_ms(5) == 60000U);
    assert(hc_prov_wifi_backoff_ms(20) == 60000U);
}

static void test_boot_button_hold_thresholds(void) {
    assert(hc_prov_evaluate_startup_button(0) == HC_BOOT_BTN_NONE);
    assert(hc_prov_evaluate_startup_button(2999) == HC_BOOT_BTN_NONE);
    assert(hc_prov_evaluate_startup_button(3000) == HC_BOOT_BTN_RECOVERY);
    assert(hc_prov_evaluate_startup_button(9999) == HC_BOOT_BTN_RECOVERY);
    assert(hc_prov_evaluate_startup_button(10000) == HC_BOOT_BTN_FACTORY_RESET);

    // Runtime button tracker: hold 3.5s then release -> triggers RECOVERY (not reset)
    hc_prov_button_tracker_t tr;
    hc_prov_button_tracker_reset(&tr);
    bool armed = false;
    for (int i = 0; i < 6; i++) {
        assert(hc_prov_button_step(&tr, true, 500U, &armed) == HC_BOOT_BTN_NONE);
        if (i < 5) assert(armed == false);
    }
    assert(armed == true); // Armed right at 3000ms
    assert(hc_prov_button_step(&tr, true, 500U, &armed) == HC_BOOT_BTN_NONE);
    assert(armed == false); // Only announced once
    assert(hc_prov_button_step(&tr, false, 500U, &armed) == HC_BOOT_BTN_RECOVERY);

    // Hold full 10s -> triggers FACTORY RESET immediately at 10s, releasing does not trigger RECOVERY
    hc_prov_button_tracker_reset(&tr);
    hc_prov_boot_btn_action_t act = HC_BOOT_BTN_NONE;
    for (int i = 0; i < 20; i++) {
        act = hc_prov_button_step(&tr, true, 500U, &armed);
        if (i < 19) assert(act == HC_BOOT_BTN_NONE);
    }
    assert(act == HC_BOOT_BTN_FACTORY_RESET);
    assert(hc_prov_button_step(&tr, false, 500U, &armed) == HC_BOOT_BTN_NONE);
}

static void test_ble_auth_guard_rate_limit_and_expiry(void) {
    hc_ble_auth_guard_t g;
    hc_ble_guard_init(&g);

    assert(hc_ble_guard_can_start_handshake(&g, 100) == true);
    assert(hc_ble_guard_attempts_remaining(&g) == 5);
    assert(hc_ble_guard_is_session_valid(&g, 100) == false);

    // 4 failed PoP attempts still allow retries
    for (int i = 0; i < 4; i++) {
        hc_ble_guard_record_failure(&g, 100 + (uint64_t)i);
        assert(hc_ble_guard_can_start_handshake(&g, 105) == true);
    }
    assert(hc_ble_guard_attempts_remaining(&g) == 1);

    // 5th failure triggers 60s lockout
    hc_ble_guard_record_failure(&g, 110);
    assert(hc_ble_guard_can_start_handshake(&g, 110) == false);
    assert(hc_ble_guard_can_start_handshake(&g, 169) == false);
    assert(hc_ble_guard_can_start_handshake(&g, 170) == true);

    // Valid session expires cleanly after 120s
    hc_ble_guard_record_success(&g, 200);
    assert(hc_ble_guard_is_session_valid(&g, 200) == true);
    assert(hc_ble_guard_is_session_valid(&g, 320) == true);
    assert(hc_ble_guard_is_session_valid(&g, 321) == false);

    // Reset clears authentication
    hc_ble_guard_reset_session(&g);
    assert(hc_ble_guard_is_session_valid(&g, 210) == false);
}

static void test_cloud_verification_before_teardown(void) {
    // BOOT on a healthy installed board must not immediately hide recovery.
    assert(!hc_prov_cloud_repair_verified(false, true, true, true, true));
    assert(!hc_prov_cloud_repair_verified(true, false, true, true, true));
    assert(!hc_prov_cloud_repair_verified(true, true, false, true, true));
    assert(!hc_prov_cloud_repair_verified(true, true, true, true, false));
    assert(hc_prov_cloud_repair_verified(true, true, true, true, true));
    // Linked Nodes intentionally do not need their own MQTT session.
    assert(hc_prov_cloud_repair_verified(true, true, true, false, false));
}

static void test_exit_recovery_chooses_the_mode_stored_state_justifies(void) {
    // Paired + complete config: leaving Recovery Mode returns to NORMAL.
    hc_prov_boot_input_t paired = {
        .has_wifi = true, .has_ble = true, .paired = true,
        .has_wifi_ssid = true, .has_backend_url = true,
    };
    hc_prov_state_t st;
    hc_prov_init_state(&st, &paired);
    hc_prov_enter_recovery(&st);
    hc_prov_exit_recovery(&st);
    assert(st.mode == HC_PROV_MODE_NORMAL);
    assert(st.recovery_elapsed_ms == 0);
    assert(hc_prov_should_ble_be_active(&st) == false);
    assert(hc_prov_should_ap_be_active(&st) == false);

    // A board that is not paired with a complete config must NOT pretend to be
    // healthy: it stays discoverable so setup can actually be finished.
    hc_prov_boot_input_t half_configured = {
        .has_wifi = true, .has_ble = true, .paired = true,
        .has_wifi_ssid = true, .has_backend_url = false,
    };
    hc_prov_init_state(&st, &half_configured);
    assert(st.mode == HC_PROV_MODE_UNPROVISIONED);
    hc_prov_enter_recovery(&st);
    hc_prov_exit_recovery(&st);
    assert(st.mode == HC_PROV_MODE_UNPROVISIONED);
    assert(hc_prov_should_ble_be_active(&st) == true);
    assert(hc_prov_should_ap_be_active(&st) == true);

    // Recovery timing out while unprovisioned keeps the interfaces the user
    // still needs, but the recovery session itself ends.
    hc_prov_enter_recovery(&st);
    bool timed_out = false;
    assert(hc_prov_tick(&st, HC_PROV_RECOVERY_TIMEOUT_MS, &timed_out) == true);
    assert(timed_out == true);
    assert(st.mode == HC_PROV_MODE_UNPROVISIONED);
    assert(hc_prov_should_ble_be_active(&st) == true);

    // Null-safe.
    hc_prov_exit_recovery(NULL);
}

static void test_interface_plan_is_symmetric(void) {
    hc_prov_boot_input_t paired = {
        .has_wifi = true, .has_ble = true, .paired = true,
        .has_wifi_ssid = true, .has_backend_url = true,
    };
    hc_prov_state_t st;
    hc_prov_init_state(&st, &paired);

    // NORMAL with everything closed: nothing to do, nothing to restart.
    hc_prov_iface_plan_t plan = hc_prov_plan_interfaces(&st, false, true, false);
    assert(!plan.open_ble && !plan.open_ap && !plan.close_ble && !plan.close_ap);
    assert(!plan.restart_required);

    // Entering recovery on a NORMAL board whose BT memory was reclaimed must ask
    // for a restart instead of silently advertising nothing.
    hc_prov_enter_recovery(&st);
    plan = hc_prov_plan_interfaces(&st, false, true, false);
    assert(plan.restart_required == true);
    assert(plan.open_ble == false);
    assert(plan.open_ap == true);

    // Recovery on a board that still owns its BT stack opens BLE in place.
    plan = hc_prov_plan_interfaces(&st, false, false, false);
    assert(plan.restart_required == false);
    assert(plan.open_ble == true);
    assert(plan.open_ap == true);
    assert(plan.close_ble == false && plan.close_ap == false);

    // Already open -> idempotent (a second BOOT press must not re-open anything).
    plan = hc_prov_plan_interfaces(&st, true, false, true);
    assert(!plan.open_ble && !plan.open_ap && !plan.close_ble && !plan.close_ap);

    // Leaving recovery closes whatever is still up, in one place.
    hc_prov_exit_recovery(&st);
    plan = hc_prov_plan_interfaces(&st, true, false, true);
    assert(plan.close_ble == true);
    assert(plan.close_ap == true);
    assert(!plan.open_ble && !plan.open_ap && !plan.restart_required);

    // A board without a radio is never asked to open one.
    hc_prov_boot_input_t ble_only = {
        .has_wifi = false, .has_ble = true, .paired = false,
        .has_backend_url = false,
    };
    hc_prov_init_state(&st, &ble_only);
    plan = hc_prov_plan_interfaces(&st, false, false, false);
    assert(plan.open_ble == true);
    assert(plan.open_ap == false);

    hc_prov_boot_input_t wifi_only = {
        .has_wifi = true, .has_ble = false, .paired = false,
        .has_wifi_ssid = false, .has_backend_url = false,
    };
    hc_prov_init_state(&st, &wifi_only);
    plan = hc_prov_plan_interfaces(&st, false, true, false);
    assert(plan.open_ble == false);
    assert(plan.open_ap == true);
    assert(plan.restart_required == false);

    // Null state: no plan, never a restart.
    plan = hc_prov_plan_interfaces(NULL, true, false, true);
    assert(!plan.open_ble && !plan.open_ap && !plan.close_ble && !plan.close_ap);
    assert(!plan.restart_required);
}

int main(void) {
    test_cloud_verification_before_teardown();
    test_exit_recovery_chooses_the_mode_stored_state_justifies();
    test_interface_plan_is_symmetric();
    test_initial_boot_modes();
    test_recovery_timeout_and_transitions();
    test_three_second_boot_press_opens_both_temporary_interfaces();
    test_wifi_exponential_backoff();
    test_boot_button_hold_thresholds();
    test_ble_auth_guard_rate_limit_and_expiry();
    printf("All provisioning logic C unit tests passed.\n");
    return 0;
}
