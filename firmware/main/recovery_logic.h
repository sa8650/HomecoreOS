#pragma once

/**
 * HomecoreOS recovery console protocol — pure logic (no ESP-IDF dependencies).
 *
 * The unified Repair & Recovery engine in the web console
 * (`@homecoreos/shared/recovery`) needs three things from a board it can reach
 * over a *local* transport rather than the cloud:
 *
 *   discovery  — who are you, what firmware, what mode, is it paired?
 *   diagnostics— what is actually wrong right now (Wi-Fi, IP, MQTT, sync…)
 *   repair     — rewrite Wi-Fi / reconnect MQTT / re-sync config / restart
 *
 * This module implements that exchange as a line-oriented JSON protocol so all
 * three local transports share it byte for byte:
 *
 *   BLE : one encrypted payload per command + status notifications (proto 1)
 *   USB : one `\n`-terminated line per command, one JSON line per response
 *   Wi-Fi: the same JSON served by the local setup portal (`/api/status`)
 *
 * Keeping it here (stdbool/stdint/stdio only) means the safest part of the
 * recovery path — parsing, capability checks, factory-reset gating and the
 * diagnostics summary — is exercised by the host C test suite in CI, on the
 * same code the firmware links.
 *
 * Protocol (USB/serial form, all ASCII, `\n` terminated, 4-192 bytes):
 *
 *   HC PING                                   -> {"hc":"pong",...}
 *   HC HELLO                                  -> {"hc":"recovery",...}
 *   HC STATUS                                 -> {"hc":"status",...}
 *   HC REPAIR {"action":"wifi","ssid":"…","password":"…","backend_url":"…"}
 *                                             -> {"hc":"ack","action":"wifi",...}
 *   HC REPAIR {"action":"mqtt"|"config"|"espnow"|"restart"}
 *   HC REPAIR {"action":"pair","pair_code":"123456","backend_url":"https://…"}
 *   HC REPAIR {"action":"factory_reset","confirm":true}
 *                                             -> {"hc":"ack"...} or {"hc":"error"...}
 *
 * Secrets are never echoed back: responses only describe what happened.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define HC_RECOVERY_PROTO_VERSION 1
#define HC_RECOVERY_LINE_MAX 224
#define HC_RECOVERY_RESPONSE_MAX 1024

/** Destructive repairs are only accepted while the board is in recovery mode. */
#define HC_RECOVERY_ACTION_MAX 7

typedef enum {
    HC_REC_CMD_NONE = 0,
    HC_REC_CMD_PING = 1,
    HC_REC_CMD_HELLO = 2,
    HC_REC_CMD_STATUS = 3,
    HC_REC_CMD_REPAIR = 4,
    HC_REC_CMD_INVALID = 5,
} hc_rec_cmd_kind_t;

typedef enum {
    HC_REC_ACTION_NONE = 0,
    /** Rewrite Wi-Fi credentials and reconnect. Keeps pairing and identity. */
    HC_REC_ACTION_WIFI = 1,
    /** Reconnect to the MQTT broker and re-check authentication. */
    HC_REC_ACTION_MQTT = 2,
    /** Re-fetch and acknowledge the consolidated configuration snapshot. */
    HC_REC_ACTION_CONFIG = 3,
    /** Clean restart that keeps every stored setting. */
    HC_REC_ACTION_RESTART = 4,
    /** Destructive: erase pairing/credentials/role. Never automatic. */
    HC_REC_ACTION_FACTORY_RESET = 5,
    /**
     * Authorized account re-pair with a single-use 6-digit code. Keeps the board
     * record, room, devices, sensors, switches and Nodes; only the MQTT
     * credentials are rotated by the Worker. Requires recovery mode.
     */
    HC_REC_ACTION_PAIR = 6,
    /**
     * Re-open the ESP-NOW radio and re-sync the role block so a Controller and
     * its Nodes find each other again. Keeps every assignment; never flashes.
     */
    HC_REC_ACTION_ESPNOW = 7,
} hc_rec_action_t;

/** What the board knows about itself right now (filled by main.c each tick). */
typedef struct {
    char board_slug[48];
    char chip[24];
    char fw_version[24];
    /** Hardware UID (MAC). Only the last 4 hex chars are ever transmitted. */
    char hardware_uid[24];
    /** "unprovisioned" | "recovery" | "normal" */
    char mode[16];
    bool paired;
    bool has_wifi;
    bool has_ble;
    bool physical_confirmed;
    /** True when this firmware implements the recovery protocol. */
    bool recovery_supported;

    /* --- Live diagnostics ------------------------------------------------- */
    bool wifi_connected;
    char wifi_ssid[64];
    /** 0 = unknown, otherwise negative dBm (e.g. -67). */
    int wifi_rssi;
    char ip[20];
    char wifi_last_error[96];
    bool mqtt_connected;
    char mqtt_last_error[96];
    /** Last backend (HTTPS) result recorded by the heartbeat loop. */
    bool backend_ok;
    bool backend_reachable;
    bool backend_authenticated;
    bool config_pending_sync;
    unsigned config_revision;
    unsigned synced_config_revision;
    /** Seconds since the last successful heartbeat (0 = never). */
    unsigned heartbeat_age_sec;
    unsigned heartbeat_interval_sec;
    /* --- Running image & capability (additive, proto 1) ------------------- */
    /** Partition the image is executing from ("app0"/"ota_1"…); "" if unknown. */
    char partition[24];
    /** Seconds since this image booted. A small value proves a restart. */
    unsigned uptime_sec;
    /** Free heap in bytes; an "is the image healthy" fact, not a fault. */
    unsigned free_heap_bytes;
    /** Server URL the board has stored; "" means it has none. */
    char backend_url[192];
    /** Whether this image can update itself over the air. */
    bool ota_supported;
    /** An OTA image is installed but not yet health-confirmed. */
    bool ota_pending;
    char ota_last_error[96];
    /** ESP-NOW radio availability and the Controller/Node link verdict. */
    bool espnow_supported;
    /** "linked" | "controller_lost" | "reconnecting" | "standalone" | "unassigned" | "down" */
    char espnow_link[24];
    /** False until the firmware can actually count its entities; the console
     * then reports "reporting unknown" instead of "nothing assigned". */
    bool entities_known;
    bool nodes_known;
    unsigned sensor_total;
    unsigned sensor_reporting;
    unsigned switch_total;
    unsigned switch_reporting;
    unsigned node_total;
    unsigned node_linked;
    char last_error[128];
} hc_recovery_snapshot_t;

typedef struct {
    hc_rec_cmd_kind_t kind;
    hc_rec_action_t action;
    char ssid[64];
    char password[64];
    char backend_url[192];
    /** Single-use 6-digit account recovery code for HC_REC_ACTION_PAIR. */
    char pair_code[16];
    bool confirmed;
} hc_rec_command_t;

/** Snapshot with safe defaults; call before filling it. */
void hc_rec_snapshot_init(hc_recovery_snapshot_t *snap);

/**
 * Parses one console line. Returns 0 for a valid command, -1 for an empty line,
 * -2 for an oversized line, -3 for an unknown/garbled command. `out` is always
 * zeroed first, so a failed parse can never leave a stale password behind.
 */
int hc_rec_parse_line(const char *line, hc_rec_command_t *out);

/** Wipes a parsed command, including the Wi-Fi password it may hold. */
void hc_rec_command_clear(hc_rec_command_t *cmd);

const char *hc_rec_action_name(hc_rec_action_t action);
hc_rec_action_t hc_rec_action_from_name(const char *name);

/**
 * A destructive action is allowed only when the board is already in its
 * physical recovery mode AND the caller sent an explicit `confirm:true`.
 * `out_reason` receives a plain-language explanation on refusal.
 */
bool hc_rec_action_allowed(
    const hc_recovery_snapshot_t *snap,
    hc_rec_action_t action,
    bool confirmed,
    char *out_reason,
    size_t reason_cap
);

/** Recommended next action for the local portal banner (may be NULL). */
const char *hc_rec_wifi_problem_code(const char *last_error);

/** JSON builders. Each returns the written length, or -1 when it does not fit. */
int hc_rec_build_hello(const hc_recovery_snapshot_t *snap, char *out, size_t cap);
int hc_rec_build_status(const hc_recovery_snapshot_t *snap, char *out, size_t cap);
int hc_rec_build_ack(hc_rec_action_t action, const char *detail, char *out, size_t cap);
int hc_rec_build_pong(char *out, size_t cap);
int hc_rec_build_error(const char *code, const char *message, char *out, size_t cap);

/**
 * Escapes `src` into a JSON string body (without quotes). Returns the written
 * length, or -1 when it would not fit. Secrets are never passed through here.
 */
int hc_rec_escape_json(const char *src, char *out, size_t cap);

/**
 * Reads a flat JSON string member (`"key":"value"`). Returns true when found.
 * Bounded and side-effect free: this is the only "parser" the firmware needs,
 * which keeps malformed or hostile input from doing anything but failing.
 */
bool hc_rec_json_get_string(const char *json, const char *key, char *out, size_t cap);
/** Reads `"key":true|false`. */
bool hc_rec_json_get_bool(const char *json, const char *key, bool *out);
