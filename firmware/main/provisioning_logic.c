#include "provisioning_logic.h"

#include <stddef.h>
#include <string.h>

static bool compute_has_saved_config(const hc_prov_boot_input_t *in) {
    if (!in) return false;
    if (in->paired) return true;
    if (in->has_wifi) {
        return in->has_wifi_ssid && in->has_backend_url;
    }
    return in->has_backend_url;
}

hc_prov_mode_t hc_prov_determine_initial_mode(const hc_prov_boot_input_t *in) {
    if (!in) return HC_PROV_MODE_UNPROVISIONED;

    if (in->recovery_requested) {
        return HC_PROV_MODE_RECOVERY;
    }

    const bool cfg_complete = in->has_wifi
        ? (in->has_wifi_ssid && in->has_backend_url)
        : in->has_backend_url;

    // A previously paired & configured controller MUST always boot into NORMAL mode
    // (never opening BLE or setup AP automatically if the router is temporarily down).
    if (in->paired && cfg_complete) {
        return HC_PROV_MODE_NORMAL;
    }

    return HC_PROV_MODE_UNPROVISIONED;
}

void hc_prov_init_state(hc_prov_state_t *st, const hc_prov_boot_input_t *in) {
    if (!st) return;
    memset(st, 0, sizeof(*st));
    if (!in) {
        st->mode = HC_PROV_MODE_UNPROVISIONED;
        return;
    }
    st->has_wifi = in->has_wifi;
    st->has_ble = in->has_ble;
    st->paired = in->paired;
    st->has_saved_config = compute_has_saved_config(in);
    st->mode = hc_prov_determine_initial_mode(in);
    st->recovery_elapsed_ms = 0;
}

bool hc_prov_should_ble_be_active(const hc_prov_state_t *st) {
    if (!st || !st->has_ble) return false;
    return st->mode == HC_PROV_MODE_UNPROVISIONED || st->mode == HC_PROV_MODE_RECOVERY;
}

bool hc_prov_should_ap_be_active(const hc_prov_state_t *st) {
    if (!st || !st->has_wifi) return false;
    return st->mode == HC_PROV_MODE_UNPROVISIONED || st->mode == HC_PROV_MODE_RECOVERY;
}

void hc_prov_enter_recovery(hc_prov_state_t *st) {
    if (!st) return;
    st->mode = HC_PROV_MODE_RECOVERY;
    st->recovery_elapsed_ms = 0;
}

void hc_prov_on_pairing_completed(hc_prov_state_t *st) {
    if (!st) return;
    st->paired = true;
    st->has_saved_config = true;
    st->mode = HC_PROV_MODE_NORMAL;
    st->recovery_elapsed_ms = 0;
}

void hc_prov_on_wifi_reconfigured(
    hc_prov_state_t *st,
    bool has_wifi_ssid,
    bool has_backend_url
) {
    if (!st) return;
    if (has_wifi_ssid && has_backend_url) {
        st->has_saved_config = true;
    }
    if (st->paired && (!st->has_wifi || (has_wifi_ssid && has_backend_url))) {
        st->mode = HC_PROV_MODE_NORMAL;
        st->recovery_elapsed_ms = 0;
    }
}

bool hc_prov_tick(hc_prov_state_t *st, uint32_t dt_ms, bool *out_timed_out) {
    if (out_timed_out) *out_timed_out = false;
    if (!st || st->mode != HC_PROV_MODE_RECOVERY) return false;

    st->recovery_elapsed_ms += dt_ms;
    if (st->recovery_elapsed_ms >= HC_PROV_RECOVERY_TIMEOUT_MS) {
        st->recovery_elapsed_ms = 0;
        // Return cleanly without erasing saved credentials or pairing
        st->mode = (st->paired && st->has_saved_config)
            ? HC_PROV_MODE_NORMAL
            : (st->has_saved_config ? HC_PROV_MODE_NORMAL : HC_PROV_MODE_UNPROVISIONED);
        if (out_timed_out) *out_timed_out = true;
        return true;
    }
    return false;
}

uint32_t hc_prov_wifi_backoff_ms(uint32_t retry_count) {
    uint32_t shift = retry_count < 5U ? retry_count : 5U;
    uint32_t delay = HC_PROV_WIFI_BACKOFF_MIN_MS << shift;
    if (delay > HC_PROV_WIFI_BACKOFF_MAX_MS) {
        delay = HC_PROV_WIFI_BACKOFF_MAX_MS;
    }
    return delay;
}

hc_prov_boot_btn_action_t hc_prov_evaluate_startup_button(uint32_t hold_ms) {
    if (hold_ms >= HC_PROV_FACTORY_RESET_HOLD_MS) {
        return HC_BOOT_BTN_FACTORY_RESET;
    }
    if (hold_ms >= HC_PROV_RECOVERY_HOLD_MS) {
        return HC_BOOT_BTN_RECOVERY;
    }
    return HC_BOOT_BTN_NONE;
}

void hc_prov_button_tracker_reset(hc_prov_button_tracker_t *t) {
    if (!t) return;
    memset(t, 0, sizeof(*t));
}

hc_prov_boot_btn_action_t hc_prov_button_step(
    hc_prov_button_tracker_t *t,
    bool pressed_now,
    uint32_t dt_ms,
    bool *out_just_armed_recovery
) {
    if (out_just_armed_recovery) *out_just_armed_recovery = false;
    if (!t) return HC_BOOT_BTN_NONE;

    if (pressed_now) {
        t->hold_ms += dt_ms;
        if (t->hold_ms >= HC_PROV_FACTORY_RESET_HOLD_MS && !t->reset_triggered) {
            t->reset_triggered = true;
            return HC_BOOT_BTN_FACTORY_RESET;
        }
        if (t->hold_ms >= HC_PROV_RECOVERY_HOLD_MS && !t->recovery_armed) {
            t->recovery_armed = true;
            if (!t->recovery_announced) {
                t->recovery_announced = true;
                if (out_just_armed_recovery) *out_just_armed_recovery = true;
            }
        }
        return HC_BOOT_BTN_NONE;
    }

    hc_prov_boot_btn_action_t action = HC_BOOT_BTN_NONE;
    if (t->recovery_armed && !t->reset_triggered) {
        action = HC_BOOT_BTN_RECOVERY;
    }
    hc_prov_button_tracker_reset(t);
    return action;
}

void hc_ble_guard_init(hc_ble_auth_guard_t *g) {
    if (!g) return;
    memset(g, 0, sizeof(*g));
}

bool hc_ble_guard_can_start_handshake(const hc_ble_auth_guard_t *g, uint64_t now_sec) {
    if (!g) return false;
    return now_sec >= g->lockout_until_sec;
}

void hc_ble_guard_record_failure(hc_ble_auth_guard_t *g, uint64_t now_sec) {
    if (!g) return;
    g->session_authenticated = false;
    g->session_started_sec = 0;
    g->failed_attempts++;
    if (g->failed_attempts >= HC_PROV_BLE_MAX_AUTH_ATTEMPTS) {
        g->lockout_until_sec = now_sec + HC_PROV_BLE_LOCKOUT_SEC;
        g->failed_attempts = 0;
    }
}

void hc_ble_guard_record_success(hc_ble_auth_guard_t *g, uint64_t now_sec) {
    if (!g) return;
    g->failed_attempts = 0;
    g->lockout_until_sec = 0;
    g->session_authenticated = true;
    g->session_started_sec = now_sec;
}

void hc_ble_guard_reset_session(hc_ble_auth_guard_t *g) {
    if (!g) return;
    g->session_authenticated = false;
    g->session_started_sec = 0;
}

bool hc_ble_guard_is_session_valid(const hc_ble_auth_guard_t *g, uint64_t now_sec) {
    if (!g || !g->session_authenticated) return false;
    if (now_sec < g->session_started_sec) return false;
    return (now_sec - g->session_started_sec) <= HC_PROV_BLE_SESSION_TTL_SEC;
}

uint8_t hc_ble_guard_attempts_remaining(const hc_ble_auth_guard_t *g) {
    if (!g) return 0;
    if (g->failed_attempts >= HC_PROV_BLE_MAX_AUTH_ATTEMPTS) return 0;
    return (uint8_t)(HC_PROV_BLE_MAX_AUTH_ATTEMPTS - g->failed_attempts);
}
