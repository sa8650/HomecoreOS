#pragma once

#include <stdbool.h>
#include <stdint.h>

#define HC_PROV_RECOVERY_HOLD_MS 3000U
#define HC_PROV_FACTORY_RESET_HOLD_MS 10000U
#define HC_PROV_RECOVERY_TIMEOUT_MS (15U * 60U * 1000U)
#define HC_PROV_WIFI_BACKOFF_MIN_MS 2000U
#define HC_PROV_WIFI_BACKOFF_MAX_MS 60000U

#define HC_PROV_BLE_MAX_AUTH_ATTEMPTS 5U
#define HC_PROV_BLE_LOCKOUT_SEC 60U
#define HC_PROV_BLE_SESSION_TTL_SEC 120U

typedef enum {
    HC_PROV_MODE_UNPROVISIONED = 0,
    HC_PROV_MODE_NORMAL = 1,
    HC_PROV_MODE_RECOVERY = 2,
} hc_prov_mode_t;

typedef enum {
    HC_BOOT_BTN_NONE = 0,
    HC_BOOT_BTN_RECOVERY = 1,
    HC_BOOT_BTN_FACTORY_RESET = 2,
} hc_prov_boot_btn_action_t;

typedef struct {
    bool has_wifi;
    bool has_ble;
    bool paired;
    bool has_wifi_ssid;
    bool has_backend_url;
    bool has_pending_pair_code;
    bool recovery_requested;
} hc_prov_boot_input_t;

typedef struct {
    hc_prov_mode_t mode;
    bool has_wifi;
    bool has_ble;
    bool has_saved_config;
    bool paired;
    uint32_t recovery_elapsed_ms;
} hc_prov_state_t;

typedef struct {
    uint32_t hold_ms;
    bool recovery_armed;
    bool recovery_announced;
    bool reset_triggered;
} hc_prov_button_tracker_t;

typedef struct {
    uint8_t failed_attempts;
    uint64_t lockout_until_sec;
    uint64_t session_started_sec;
    bool session_authenticated;
} hc_ble_auth_guard_t;

hc_prov_mode_t hc_prov_determine_initial_mode(const hc_prov_boot_input_t *in);
void hc_prov_init_state(hc_prov_state_t *st, const hc_prov_boot_input_t *in);

bool hc_prov_should_ble_be_active(const hc_prov_state_t *st);
bool hc_prov_should_ap_be_active(const hc_prov_state_t *st);

void hc_prov_enter_recovery(hc_prov_state_t *st);
void hc_prov_on_pairing_completed(hc_prov_state_t *st);
void hc_prov_on_wifi_reconfigured(hc_prov_state_t *st, bool has_wifi_ssid, bool has_backend_url);
bool hc_prov_tick(hc_prov_state_t *st, uint32_t dt_ms, bool *out_timed_out);

uint32_t hc_prov_wifi_backoff_ms(uint32_t retry_count);

hc_prov_boot_btn_action_t hc_prov_evaluate_startup_button(uint32_t hold_ms);
void hc_prov_button_tracker_reset(hc_prov_button_tracker_t *t);
hc_prov_boot_btn_action_t hc_prov_button_step(
    hc_prov_button_tracker_t *t,
    bool pressed_now,
    uint32_t dt_ms,
    bool *out_just_armed_recovery
);

void hc_ble_guard_init(hc_ble_auth_guard_t *g);
bool hc_ble_guard_can_start_handshake(const hc_ble_auth_guard_t *g, uint64_t now_sec);
void hc_ble_guard_record_failure(hc_ble_auth_guard_t *g, uint64_t now_sec);
void hc_ble_guard_record_success(hc_ble_auth_guard_t *g, uint64_t now_sec);
void hc_ble_guard_reset_session(hc_ble_auth_guard_t *g);
bool hc_ble_guard_is_session_valid(const hc_ble_auth_guard_t *g, uint64_t now_sec);
uint8_t hc_ble_guard_attempts_remaining(const hc_ble_auth_guard_t *g);
