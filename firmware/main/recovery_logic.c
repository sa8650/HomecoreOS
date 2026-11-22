#include "recovery_logic.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

static void copy_str(char *dst, size_t cap, const char *src) {
    if (!dst || cap == 0) return;
    if (!src) {
        dst[0] = '\0';
        return;
    }
    size_t len = strlen(src);
    if (len >= cap) len = cap - 1;
    memcpy(dst, src, len);
    dst[len] = '\0';
}

static void zeroize(void *p, size_t len) {
    volatile unsigned char *v = (volatile unsigned char *)p;
    for (size_t i = 0; i < len; i++) v[i] = 0;
}

void hc_rec_snapshot_init(hc_recovery_snapshot_t *snap) {
    if (!snap) return;
    memset(snap, 0, sizeof(*snap));
    snap->recovery_supported = true;
    copy_str(snap->mode, sizeof(snap->mode), "unknown");
    snap->wifi_rssi = 0;
}

void hc_rec_command_clear(hc_rec_command_t *cmd) {
    if (!cmd) return;
    zeroize(cmd->password, sizeof(cmd->password));
    memset(cmd, 0, sizeof(*cmd));
}

const char *hc_rec_action_name(hc_rec_action_t action) {
    switch (action) {
        case HC_REC_ACTION_WIFI: return "wifi";
        case HC_REC_ACTION_MQTT: return "mqtt";
        case HC_REC_ACTION_CONFIG: return "config";
        case HC_REC_ACTION_RESTART: return "restart";
        case HC_REC_ACTION_FACTORY_RESET: return "factory_reset";
        case HC_REC_ACTION_PAIR: return "pair";
        default: return "none";
    }
}

hc_rec_action_t hc_rec_action_from_name(const char *name) {
    if (!name) return HC_REC_ACTION_NONE;
    if (strcmp(name, "wifi") == 0 || strcmp(name, "wifi_only") == 0) return HC_REC_ACTION_WIFI;
    if (strcmp(name, "mqtt") == 0) return HC_REC_ACTION_MQTT;
    if (strcmp(name, "config") == 0) return HC_REC_ACTION_CONFIG;
    if (strcmp(name, "restart") == 0 || strcmp(name, "reboot") == 0) return HC_REC_ACTION_RESTART;
    if (strcmp(name, "factory_reset") == 0) return HC_REC_ACTION_FACTORY_RESET;
    if (strcmp(name, "pair") == 0 || strcmp(name, "recover") == 0) return HC_REC_ACTION_PAIR;
    return HC_REC_ACTION_NONE;
}

/* ------------------------------------------------------------------------- */
/* Minimal, bounded JSON string/bool readers (flat objects only)             */
/* ------------------------------------------------------------------------- */

static const char *find_key(const char *json, const char *key) {
    if (!json || !key || !*key) return NULL;
    size_t key_len = strlen(key);
    const char *p = json;
    while ((p = strchr(p, '"')) != NULL) {
        p++;
        const char *close = strchr(p, '"');
        if (!close) return NULL;
        size_t name_len = (size_t)(close - p);
        const char *after = close + 1;
        while (*after == ' ' || *after == '\t') after++;
        if (*after == ':') {
            after++;
            while (*after == ' ' || *after == '\t') after++;
            if (name_len == key_len && strncmp(p, key, key_len) == 0) return after;
        }
        p = close + 1;
    }
    return NULL;
}

bool hc_rec_json_get_string(const char *json, const char *key, char *out, size_t cap) {
    if (!out || cap == 0) return false;
    out[0] = '\0';
    const char *p = find_key(json, key);
    if (!p || *p != '"') return false;
    p++;
    size_t i = 0;
    while (*p && *p != '"') {
        if (i + 1 >= cap) return false;
        if (*p == '\\' && p[1]) {
            p++;
            switch (*p) {
                case 'n': out[i++] = '\n'; break;
                case 't': out[i++] = '\t'; break;
                case 'r': out[i++] = '\r'; break;
                case '\\': out[i++] = '\\'; break;
                case '"': out[i++] = '"'; break;
                case '/': out[i++] = '/'; break;
                default: out[i++] = *p; break;
            }
        } else {
            out[i++] = *p;
        }
        p++;
    }
    out[i] = '\0';
    return *p == '"';
}

bool hc_rec_json_get_bool(const char *json, const char *key, bool *out) {
    if (!out) return false;
    const char *p = find_key(json, key);
    if (!p) return false;
    if (strncmp(p, "true", 4) == 0) {
        *out = true;
        return true;
    }
    if (strncmp(p, "false", 5) == 0) {
        *out = false;
        return true;
    }
    return false;
}

/* ------------------------------------------------------------------------- */
/* Command parsing                                                           */
/* ------------------------------------------------------------------------- */

int hc_rec_parse_line(const char *line, hc_rec_command_t *out) {
    if (!out) return -1;
    hc_rec_command_clear(out);
    if (!line) return -1;

    while (*line == ' ' || *line == '\t' || *line == '\r' || *line == '\n') line++;
    if (!*line) return -1;
    if (strlen(line) > HC_RECOVERY_LINE_MAX) return -2;

    if (strncmp(line, "HC ", 3) != 0) {
        out->kind = HC_REC_CMD_INVALID;
        return -3;
    }
    const char *verb = line + 3;

    if (strncmp(verb, "PING", 4) == 0) {
        out->kind = HC_REC_CMD_PING;
        return 0;
    }
    if (strncmp(verb, "HELLO", 5) == 0) {
        out->kind = HC_REC_CMD_HELLO;
        return 0;
    }
    if (strncmp(verb, "STATUS", 6) == 0) {
        out->kind = HC_REC_CMD_STATUS;
        return 0;
    }
    if (strncmp(verb, "REPAIR ", 7) != 0) {
        out->kind = HC_REC_CMD_INVALID;
        return -3;
    }

    const char *json = verb + 7;
    char action_name[24];
    if (!hc_rec_json_get_string(json, "action", action_name, sizeof(action_name))) {
        out->kind = HC_REC_CMD_INVALID;
        return -3;
    }
    hc_rec_action_t action = hc_rec_action_from_name(action_name);
    if (action == HC_REC_ACTION_NONE) {
        out->kind = HC_REC_CMD_INVALID;
        return -3;
    }

    out->kind = HC_REC_CMD_REPAIR;
    out->action = action;
    hc_rec_json_get_string(json, "ssid", out->ssid, sizeof(out->ssid));
    hc_rec_json_get_string(json, "password", out->password, sizeof(out->password));
    hc_rec_json_get_string(json, "backend_url", out->backend_url, sizeof(out->backend_url));
    hc_rec_json_get_string(json, "pair_code", out->pair_code, sizeof(out->pair_code));
    hc_rec_json_get_bool(json, "confirm", &out->confirmed);

    if (action == HC_REC_ACTION_WIFI) {
        if (strlen(out->ssid) == 0 || strlen(out->ssid) > 32) {
            hc_rec_command_clear(out);
            out->kind = HC_REC_CMD_INVALID;
            return -3;
        }
        /* 8-63 for WPA2/WPA3; empty is allowed for an open network. */
        size_t pass_len = strlen(out->password);
        if (pass_len > 63 || (pass_len > 0 && pass_len < 8)) {
            hc_rec_command_clear(out);
            out->kind = HC_REC_CMD_INVALID;
            return -3;
        }
    }

    if (action == HC_REC_ACTION_PAIR) {
        /* A pairing code is exactly 6 digits; anything else is rejected before
         * it can reach the pairing client. */
        size_t code_len = strlen(out->pair_code);
        if (code_len != 6) {
            hc_rec_command_clear(out);
            out->kind = HC_REC_CMD_INVALID;
            return -3;
        }
        for (size_t i = 0; i < code_len; i++) {
            if (out->pair_code[i] < '0' || out->pair_code[i] > '9') {
                hc_rec_command_clear(out);
                out->kind = HC_REC_CMD_INVALID;
                return -3;
            }
        }
    }

    return 0;
}

bool hc_rec_action_allowed(
    const hc_recovery_snapshot_t *snap,
    hc_rec_action_t action,
    bool confirmed,
    char *out_reason,
    size_t reason_cap
) {
    if (out_reason && reason_cap) out_reason[0] = '\0';
    if (!snap) return false;

    const bool in_recovery = strcmp(snap->mode, "recovery") == 0;
    const bool unprovisioned = strcmp(snap->mode, "unprovisioned") == 0;

    switch (action) {
        case HC_REC_ACTION_WIFI:
        case HC_REC_ACTION_MQTT:
        case HC_REC_ACTION_CONFIG:
        case HC_REC_ACTION_RESTART:
            /* Ordinary repairs never need physical confirmation: they keep
             * identity, pairing and every device assignment. */
            return true;

        case HC_REC_ACTION_PAIR:
            /* Re-pairing rotates the board's MQTT credentials, so it needs the
             * same physical proof as a factory reset: the user is standing at
             * the controller holding BOOT. Persisted physical_confirmed is
             * historical setup proof, not authorization for a new repair. */
            if (!in_recovery) {
                if (out_reason && reason_cap) {
                    copy_str(
                        out_reason,
                        reason_cap,
                        "Re-pairing requires the board's physical recovery mode (hold BOOT for 3 seconds)."
                    );
                }
                return false;
            }
            return true;

        case HC_REC_ACTION_FACTORY_RESET:
            if (!in_recovery) {
                if (out_reason && reason_cap) {
                    copy_str(
                        out_reason,
                        reason_cap,
                        "Factory reset requires the board's physical recovery mode (hold BOOT for 3 seconds)."
                    );
                }
                return false;
            }
            if (!confirmed) {
                if (out_reason && reason_cap) {
                    copy_str(
                        out_reason,
                        reason_cap,
                        "Factory reset erases pairing, credentials and the device's role. Confirm explicitly to continue."
                    );
                }
                return false;
            }
            return true;

        default:
            (void)unprovisioned;
            if (out_reason && reason_cap) copy_str(out_reason, reason_cap, "Unknown repair action.");
            return false;
    }
}

const char *hc_rec_wifi_problem_code(const char *last_error) {
    if (!last_error || !*last_error) return NULL;
    if (strstr(last_error, "authentication") || strstr(last_error, "password") ||
        strstr(last_error, "handshake")) {
        return "wifi_auth_failed";
    }
    if (strstr(last_error, "not found") || strstr(last_error, "No AP") ||
        strstr(last_error, "out of range")) {
        return "wifi_network_not_found";
    }
    if (strstr(last_error, "IP") || strstr(last_error, "DHCP") ||
        strstr(last_error, "address")) {
        return "dhcp_no_address";
    }
    return "wifi_not_connected";
}

/* ------------------------------------------------------------------------- */
/* JSON builders                                                             */
/* ------------------------------------------------------------------------- */

int hc_rec_escape_json(const char *src, char *out, size_t cap) {
    if (!out || cap == 0) return -1;
    size_t i = 0;
    for (const char *p = src ? src : ""; *p; p++) {
        char c = *p;
        const char *esc = NULL;
        switch (c) {
            case '"': esc = "\\\""; break;
            case '\\': esc = "\\\\"; break;
            case '\n': esc = "\\n"; break;
            case '\r': esc = "\\r"; break;
            case '\t': esc = "\\t"; break;
            default: break;
        }
        if (esc) {
            if (i + 2 >= cap) return -1;
            out[i++] = esc[0];
            out[i++] = esc[1];
        } else {
            if ((unsigned char)c < 0x20) continue; /* drop control chars */
            if (i + 1 >= cap) return -1;
            out[i++] = c;
        }
    }
    out[i] = '\0';
    return (int)i;
}

static int append(char *out, size_t cap, size_t *len, const char *fmt, ...) {
    if (*len >= cap) return -1;
    va_list args;
    va_start(args, fmt);
    int written = vsnprintf(out + *len, cap - *len, fmt, args);
    va_end(args);
    if (written < 0 || (size_t)written >= cap - *len) return -1;
    *len += (size_t)written;
    return 0;
}

int hc_rec_build_pong(char *out, size_t cap) {
    if (!out || cap == 0) return -1;
    int n = snprintf(out, cap, "{\"hc\":\"pong\",\"proto\":%d}", HC_RECOVERY_PROTO_VERSION);
    return (n < 0 || (size_t)n >= cap) ? -1 : n;
}

int hc_rec_build_hello(const hc_recovery_snapshot_t *snap, char *out, size_t cap) {
    if (!snap || !out || cap == 0) return -1;
    char slug[96], chip[48], fw[48], mode[32];
    if (hc_rec_escape_json(snap->board_slug, slug, sizeof(slug)) < 0) return -1;
    if (hc_rec_escape_json(snap->chip, chip, sizeof(chip)) < 0) return -1;
    if (hc_rec_escape_json(snap->fw_version, fw, sizeof(fw)) < 0) return -1;
    if (hc_rec_escape_json(snap->mode, mode, sizeof(mode)) < 0) return -1;

    /* Identity only: the hardware UID is truncated to its last 4 characters so
     * a local console can match the board without receiving a full MAC. */
    const char *uid = snap->hardware_uid;
    size_t uid_len = uid ? strlen(uid) : 0;
    char suffix[8] = "";
    if (uid_len >= 4) {
        /* Walk back to the last four *hex* characters so that a colon-separated
         * MAC (AA:BB:CC:DD:EE:12) reports "EE12" rather than "E:12". */
        size_t taken = 0;
        for (size_t i = uid_len; i > 0 && taken < 4; i--) {
            char c = uid[i - 1];
            const bool is_hex =
                (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f');
            if (!is_hex) continue;
            suffix[taken++] = c;
        }
        suffix[taken] = '\0';
        /* Reverse in place: the loop above walks the UID backwards. */
        for (size_t i = 0; i < taken / 2; i++) {
            char tmp = suffix[i];
            suffix[i] = suffix[taken - 1 - i];
            suffix[taken - 1 - i] = tmp;
        }
    }

    int n = snprintf(
        out,
        cap,
        "{\"hc\":\"recovery\",\"proto\":%d,\"board\":\"%s\",\"chip\":\"%s\",\"fw\":\"%s\","
        "\"mode\":\"%s\",\"paired\":%s,\"wifi\":%s,\"ble\":%s,\"recovery_supported\":%s,"
        "\"uid_suffix\":\"%s\"}",
        HC_RECOVERY_PROTO_VERSION,
        slug,
        chip,
        fw,
        mode,
        snap->paired ? "true" : "false",
        snap->has_wifi ? "true" : "false",
        snap->has_ble ? "true" : "false",
        snap->recovery_supported ? "true" : "false",
        suffix
    );
    return (n < 0 || (size_t)n >= cap) ? -1 : n;
}

int hc_rec_build_status(const hc_recovery_snapshot_t *snap, char *out, size_t cap) {
    if (!snap || !out || cap == 0) return -1;
    char ssid[96], ip[48], werr[192], merr[192], lerr[256], mode[32], fw[48];
    if (hc_rec_escape_json(snap->wifi_ssid, ssid, sizeof(ssid)) < 0) return -1;
    if (hc_rec_escape_json(snap->ip, ip, sizeof(ip)) < 0) return -1;
    if (hc_rec_escape_json(snap->wifi_last_error, werr, sizeof(werr)) < 0) return -1;
    if (hc_rec_escape_json(snap->mqtt_last_error, merr, sizeof(merr)) < 0) return -1;
    if (hc_rec_escape_json(snap->last_error, lerr, sizeof(lerr)) < 0) return -1;
    if (hc_rec_escape_json(snap->mode, mode, sizeof(mode)) < 0) return -1;
    if (hc_rec_escape_json(snap->fw_version, fw, sizeof(fw)) < 0) return -1;

    size_t len = 0;
    if (append(
            out,
            cap,
            &len,
            "{\"hc\":\"status\",\"proto\":%d,\"mode\":\"%s\",\"fw\":\"%s\",\"paired\":%s,"
            "\"wifi_connected\":%s,\"ssid\":\"%s\",\"rssi\":%d,\"ip\":\"%s\","
            "\"wifi_error\":\"%s\",\"mqtt_connected\":%s,\"mqtt_error\":\"%s\","
            "\"backend_reachable\":%s,\"backend_authenticated\":%s,\"backend_ok\":%s,"
            "\"config_revision\":%u,\"synced_config_revision\":%u,\"pending_config\":%s,"
            "\"heartbeat_age_sec\":%u,\"heartbeat_interval_sec\":%u,",
            HC_RECOVERY_PROTO_VERSION,
            mode,
            fw,
            snap->paired ? "true" : "false",
            snap->wifi_connected ? "true" : "false",
            ssid,
            snap->wifi_rssi,
            ip,
            werr,
            snap->mqtt_connected ? "true" : "false",
            merr,
            snap->backend_reachable ? "true" : "false",
            snap->backend_authenticated ? "true" : "false",
            snap->backend_ok ? "true" : "false",
            snap->config_revision,
            snap->synced_config_revision,
            snap->config_pending_sync ? "true" : "false",
            snap->heartbeat_age_sec,
            snap->heartbeat_interval_sec
        ) < 0) {
        return -1;
    }

    if (append(
            out,
            cap,
            &len,
            "\"entities_known\":%s,\"sensors_total\":%u,\"sensors_reporting\":%u,"
            "\"switches_total\":%u,\"switches_reporting\":%u,"
            "\"nodes_known\":%s,\"nodes_total\":%u,\"nodes_linked\":%u,"
            "\"last_error\":\"%s\"}",
            snap->entities_known ? "true" : "false",
            snap->sensor_total,
            snap->sensor_reporting,
            snap->switch_total,
            snap->switch_reporting,
            snap->nodes_known ? "true" : "false",
            snap->node_total,
            snap->node_linked,
            lerr
        ) < 0) {
        return -1;
    }
    return (int)len;
}

int hc_rec_build_ack(hc_rec_action_t action, const char *detail, char *out, size_t cap) {
    if (!out || cap == 0) return -1;
    char detail_esc[256];
    if (hc_rec_escape_json(detail, detail_esc, sizeof(detail_esc)) < 0) return -1;
    int n = snprintf(
        out,
        cap,
        "{\"hc\":\"ack\",\"action\":\"%s\",\"ok\":true,\"detail\":\"%s\"}",
        hc_rec_action_name(action),
        detail_esc
    );
    return (n < 0 || (size_t)n >= cap) ? -1 : n;
}

int hc_rec_build_error(const char *code, const char *message, char *out, size_t cap) {
    if (!out || cap == 0) return -1;
    char code_esc[64], msg_esc[320];
    if (hc_rec_escape_json(code, code_esc, sizeof(code_esc)) < 0) return -1;
    if (hc_rec_escape_json(message, msg_esc, sizeof(msg_esc)) < 0) return -1;
    int n = snprintf(
        out,
        cap,
        "{\"hc\":\"error\",\"code\":\"%s\",\"message\":\"%s\",\"ok\":false}",
        code_esc,
        msg_esc
    );
    return (n < 0 || (size_t)n >= cap) ? -1 : n;
}
