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
    /** Stored-configuration facts, so leaving Recovery Mode can apply exactly
     * the same "is this board actually set up?" rule as boot does. */
    bool has_wifi_ssid;
    bool has_backend_url;
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

/**
 * Difference between the temporary interfaces the current mode requires and the
 * ones that are actually running.
 *
 * The supervisor owns "open both, close both": every path in and out of
 * Recovery Mode is reduced to publishing a mode, then applying this plan. That
 * is what makes the teardown unskippable — a path that forgets to call
 * `hc_wifi_stop_portal_ap()` cannot leave an AP behind, because the AP's fate is
 * derived from the mode rather than from each exit branch remembering it.
 */
typedef struct {
    /** BLE should be advertising, is not, and memory is still available. */
    bool open_ble;
    /** The temporary setup AP should be running and is not. */
    bool open_ap;
    /** BLE is running but the current mode does not need it. */
    bool close_ble;
    /** The setup AP is running but the current mode does not need it. */
    bool close_ap;
    /**
     * BLE is required but its controller memory was already reclaimed for
     * NORMAL operation. NimBLE cannot be re-initialised in place, so the only
     * way to honour the request is a clean restart with the recovery request
     * persisted first.
     */
    bool restart_required;
} hc_prov_iface_plan_t;

hc_prov_iface_plan_t hc_prov_plan_interfaces(
    const hc_prov_state_t *st,
    bool ble_active,
    bool ble_mem_released,
    bool ap_active
);

hc_prov_mode_t hc_prov_determine_initial_mode(const hc_prov_boot_input_t *in);
void hc_prov_init_state(hc_prov_state_t *st, const hc_prov_boot_input_t *in);

bool hc_prov_should_ble_be_active(const hc_prov_state_t *st);
bool hc_prov_should_ap_be_active(const hc_prov_state_t *st);

/**
 * Refreshes the stored-configuration facts the mode decisions depend on.
 *
 * The supervisor calls this every tick with what NVS actually holds, so a
 * Wi-Fi/URL setup that arrives over BLE or the portal is reflected before the
 * board decides whether it is still unprovisioned.
 */
void hc_prov_note_stored_config(hc_prov_state_t *st, bool has_wifi_ssid, bool has_backend_url);

void hc_prov_enter_recovery(hc_prov_state_t *st);
/**
 * Leaves Recovery Mode for the mode the board's *stored* state actually
 * justifies: NORMAL only when this board is paired with a complete config
 * (the same rule `hc_prov_determine_initial_mode` applies at boot), otherwise
 * UNPROVISIONED — a board that still needs setup must stay discoverable over
 * BLE and the temporary AP instead of pretending to be a healthy controller.
 */
void hc_prov_exit_recovery(hc_prov_state_t *st);
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

/** A healthy board entering BOOT recovery must remain discoverable until a
 * requested setup/repair has actually completed its cloud checks. */
bool hc_prov_cloud_repair_verified(bool repair_pending, bool paired, bool backend_ok,
                                   bool mqtt_required, bool mqtt_connected);
