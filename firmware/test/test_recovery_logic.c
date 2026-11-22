#include "../main/recovery_logic.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void test_snapshot_defaults(void) {
    hc_recovery_snapshot_t snap;
    hc_rec_snapshot_init(&snap);
    assert(strcmp(snap.mode, "unknown") == 0);
    assert(snap.recovery_supported == true);
    assert(snap.wifi_rssi == 0);
    assert(snap.paired == false);
}

static void test_parse_ping_hello_status(void) {
    hc_rec_command_t cmd;

    assert(hc_rec_parse_line("HC PING", &cmd) == 0);
    assert(cmd.kind == HC_REC_CMD_PING);

    assert(hc_rec_parse_line("HC HELLO", &cmd) == 0);
    assert(cmd.kind == HC_REC_CMD_HELLO);

    assert(hc_rec_parse_line("  HC STATUS\r\n", &cmd) == 0);
    assert(cmd.kind == HC_REC_CMD_STATUS);

    // Garbage, empty lines and non-HC traffic are rejected, never guessed.
    assert(hc_rec_parse_line("", &cmd) == -1);
    assert(hc_rec_parse_line("hello", &cmd) == -3);
    assert(hc_rec_parse_line("HC HACK", &cmd) == -3);
    assert(cmd.kind == HC_REC_CMD_INVALID);
}

static void test_parse_wifi_repair(void) {
    hc_rec_command_t cmd;
    const char *line =
        "HC REPAIR {\"action\":\"wifi\",\"ssid\":\"Home 24G\",\"password\":\"correct horse\",\"backend_url\":\"https://hc.example\"}";
    assert(hc_rec_parse_line(line, &cmd) == 0);
    assert(cmd.kind == HC_REC_CMD_REPAIR);
    assert(cmd.action == HC_REC_ACTION_WIFI);
    assert(strcmp(cmd.ssid, "Home 24G") == 0);
    assert(strcmp(cmd.password, "correct horse") == 0);
    assert(strcmp(cmd.backend_url, "https://hc.example") == 0);
    hc_rec_command_clear(&cmd);
    assert(cmd.password[0] == '\0');

    // A short WPA2 passphrase is still legal (8+), 4 chars is not.
    assert(hc_rec_parse_line("HC REPAIR {\"action\":\"wifi\",\"ssid\":\"A\",\"password\":\"1234\"}", &cmd) == -3);
    assert(cmd.password[0] == '\0');
    assert(hc_rec_parse_line("HC REPAIR {\"action\":\"wifi\",\"ssid\":\"\",\"password\":\"12345678\"}", &cmd) == -3);
    // Open network: empty password with an SSID is allowed.
    assert(hc_rec_parse_line("HC REPAIR {\"action\":\"wifi\",\"ssid\":\"OpenNet\"}", &cmd) == 0);
    assert(cmd.action == HC_REC_ACTION_WIFI);

    // Escaped quotes and slashes survive parsing.
    assert(
        hc_rec_parse_line(
            "HC REPAIR {\"action\":\"wifi\",\"ssid\":\"Cafe \\\"Guest\\\"\",\"password\":\"pass12345\"}",
            &cmd
        ) == 0
    );
    assert(strcmp(cmd.ssid, "Cafe \"Guest\"") == 0);
}

static void test_parse_non_secret_actions(void) {
    hc_rec_command_t cmd;
    assert(hc_rec_parse_line("HC REPAIR {\"action\":\"mqtt\"}", &cmd) == 0);
    assert(cmd.kind == HC_REC_CMD_REPAIR && cmd.action == HC_REC_ACTION_MQTT);
    assert(hc_rec_parse_line("HC REPAIR {\"action\":\"config\"}", &cmd) == 0);
    assert(cmd.action == HC_REC_ACTION_CONFIG);
    assert(hc_rec_parse_line("HC REPAIR {\"action\":\"restart\"}", &cmd) == 0);
    assert(cmd.action == HC_REC_ACTION_RESTART);
    assert(hc_rec_parse_line("HC REPAIR {\"action\":\"reboot\"}", &cmd) == 0);
    assert(cmd.action == HC_REC_ACTION_RESTART);
    assert(hc_rec_parse_line("HC REPAIR {\"action\":\"nuke\"}", &cmd) == -3);
}

static void test_repair_pairing_gating(void) {
    hc_rec_command_t cmd;
    hc_recovery_snapshot_t snap;
    char reason[160];

    // A recovery code is exactly six digits, and it is parsed into its own field
    // (never mistaken for a Wi-Fi password).
    assert(
        hc_rec_parse_line(
            "HC REPAIR {\"action\":\"pair\",\"pair_code\":\"123456\",\"backend_url\":\"https://hc.example\"}",
            &cmd
        ) == 0
    );
    assert(cmd.action == HC_REC_ACTION_PAIR);
    assert(strcmp(cmd.pair_code, "123456") == 0);
    assert(cmd.password[0] == '\0');
    assert(hc_rec_parse_line("HC REPAIR {\"action\":\"recover\",\"pair_code\":\"654321\"}", &cmd) == 0);
    assert(cmd.action == HC_REC_ACTION_PAIR);

    // Malformed or missing codes are rejected outright.
    assert(hc_rec_parse_line("HC REPAIR {\"action\":\"pair\",\"pair_code\":\"12345\"}", &cmd) == -3);
    assert(hc_rec_parse_line("HC REPAIR {\"action\":\"pair\",\"pair_code\":\"12ab56\"}", &cmd) == -3);
    assert(hc_rec_parse_line("HC REPAIR {\"action\":\"pair\"}", &cmd) == -3);
    assert(cmd.pair_code[0] == '\0');

    // Re-pairing rotates MQTT credentials, so it needs physical recovery mode.
    hc_rec_snapshot_init(&snap);
    strcpy(snap.mode, "normal");
    assert(hc_rec_action_allowed(&snap, HC_REC_ACTION_PAIR, false, reason, sizeof(reason)) == false);
    assert(strstr(reason, "physical recovery mode") != NULL);
    strcpy(snap.mode, "recovery");
    assert(hc_rec_action_allowed(&snap, HC_REC_ACTION_PAIR, false, reason, sizeof(reason)) == true);
    strcpy(snap.mode, "normal");
    snap.physical_confirmed = true;
    assert(hc_rec_action_allowed(&snap, HC_REC_ACTION_PAIR, false, reason, sizeof(reason)) == false);
}

static void test_factory_reset_gating(void) {
    hc_recovery_snapshot_t snap;
    char reason[160];
    hc_rec_snapshot_init(&snap);
    strcpy(snap.mode, "normal");

    // Never automatic, never from normal mode, never without explicit consent.
    assert(hc_rec_action_allowed(&snap, HC_REC_ACTION_FACTORY_RESET, true, reason, sizeof(reason)) == false);
    assert(strstr(reason, "physical recovery mode") != NULL);

    strcpy(snap.mode, "recovery");
    assert(hc_rec_action_allowed(&snap, HC_REC_ACTION_FACTORY_RESET, false, reason, sizeof(reason)) == false);
    assert(strstr(reason, "Confirm explicitly") != NULL);

    assert(hc_rec_action_allowed(&snap, HC_REC_ACTION_FACTORY_RESET, true, reason, sizeof(reason)) == true);

    // Historical physical confirmation cannot authorize a new reset.
    strcpy(snap.mode, "normal");
    snap.physical_confirmed = true;
    assert(hc_rec_action_allowed(&snap, HC_REC_ACTION_FACTORY_RESET, true, reason, sizeof(reason)) == false);

    // Ordinary repairs never require confirmation or recovery mode.
    hc_rec_snapshot_init(&snap);
    strcpy(snap.mode, "normal");
    assert(hc_rec_action_allowed(&snap, HC_REC_ACTION_WIFI, false, reason, sizeof(reason)) == true);
    assert(hc_rec_action_allowed(&snap, HC_REC_ACTION_MQTT, false, reason, sizeof(reason)) == true);
    assert(hc_rec_action_allowed(&snap, HC_REC_ACTION_CONFIG, false, reason, sizeof(reason)) == true);
    assert(hc_rec_action_allowed(&snap, HC_REC_ACTION_NONE, true, reason, sizeof(reason)) == false);
}

static void test_builders_never_leak_secrets(void) {
    hc_recovery_snapshot_t snap;
    hc_rec_snapshot_init(&snap);
    strcpy(snap.board_slug, "esp32-s3-devkitc-1-n16r8");
    strcpy(snap.chip, "esp32s3");
    strcpy(snap.fw_version, "1.5.0");
    strcpy(snap.hardware_uid, "AA:BB:CC:DD:EE:12");
    strcpy(snap.mode, "recovery");
    snap.has_wifi = true;
    snap.has_ble = true;
    snap.paired = true;

    char out[HC_RECOVERY_RESPONSE_MAX];
    assert(hc_rec_build_hello(&snap, out, sizeof(out)) > 0);
    assert(strstr(out, "\"hc\":\"recovery\"") != NULL);
    assert(strstr(out, "\"board\":\"esp32-s3-devkitc-1-n16r8\"") != NULL);
    assert(strstr(out, "\"mode\":\"recovery\"") != NULL);
    assert(strstr(out, "\"uid_suffix\":\"EE12\"") != NULL);
    // The full hardware address and any secret must never be echoed.
    assert(strstr(out, "AA:BB:CC") == NULL);
    assert(strstr(out, "password") == NULL);

    strcpy(snap.wifi_ssid, "Home24G");
    snap.wifi_connected = true;
    snap.wifi_rssi = -61;
    strcpy(snap.ip, "192.168.1.44");
    snap.mqtt_connected = true;
    snap.backend_ok = true;
    snap.backend_reachable = true;
    snap.backend_authenticated = true;
    snap.config_revision = 4;
    snap.synced_config_revision = 4;
    snap.sensor_total = 3;
    snap.sensor_reporting = 3;
    strcpy(snap.last_error, "");

    assert(hc_rec_build_status(&snap, out, sizeof(out)) > 0);
    assert(strstr(out, "\"hc\":\"status\"") != NULL);
    assert(strstr(out, "\"wifi_connected\":true") != NULL);
    assert(strstr(out, "\"rssi\":-61") != NULL);
    assert(strstr(out, "\"mqtt_connected\":true") != NULL);
    assert(strstr(out, "\"backend_authenticated\":true") != NULL);
    assert(strstr(out, "\"config_revision\":4") != NULL);

    // A tiny buffer must fail cleanly instead of truncating JSON.
    char tiny[16];
    assert(hc_rec_build_status(&snap, tiny, sizeof(tiny)) == -1);

    assert(hc_rec_build_ack(HC_REC_ACTION_WIFI, "Wi-Fi credentials saved", out, sizeof(out)) > 0);
    assert(strstr(out, "\"action\":\"wifi\"") != NULL);
    assert(strstr(out, "\"ok\":true") != NULL);

    assert(hc_rec_build_pong(out, sizeof(out)) > 0);
    assert(strstr(out, "\"hc\":\"pong\"") != NULL);

    assert(hc_rec_build_error("bad_action", "Unknown repair action", out, sizeof(out)) > 0);
    assert(strstr(out, "\"ok\":false") != NULL);
}

static void test_json_escaping(void) {
    char out[128];
    assert(hc_rec_escape_json("a\"b\\c\nd", out, sizeof(out)) > 0);
    assert(strcmp(out, "a\\\"b\\\\c\\nd") == 0);
    char tiny[4];
    assert(hc_rec_escape_json("abcdef", tiny, sizeof(tiny)) == -1);
}

static void test_problem_classification(void) {
    assert(strcmp(hc_rec_wifi_problem_code("Wi-Fi authentication failed"), "wifi_auth_failed") == 0);
    assert(strcmp(hc_rec_wifi_problem_code("Wi-Fi network not found"), "wifi_network_not_found") == 0);
    assert(strcmp(hc_rec_wifi_problem_code("DHCP gave no address"), "dhcp_no_address") == 0);
    assert(strcmp(hc_rec_wifi_problem_code("Something else"), "wifi_not_connected") == 0);
    assert(hc_rec_wifi_problem_code(NULL) == NULL);
    assert(hc_rec_wifi_problem_code("") == NULL);
}

static void test_action_names_round_trip(void) {
    const hc_rec_action_t all[] = {
        HC_REC_ACTION_WIFI,
        HC_REC_ACTION_MQTT,
        HC_REC_ACTION_CONFIG,
        HC_REC_ACTION_RESTART,
        HC_REC_ACTION_FACTORY_RESET,
        HC_REC_ACTION_PAIR,
        HC_REC_ACTION_ESPNOW,
    };
    for (size_t i = 0; i < sizeof(all) / sizeof(all[0]); i++) {
        assert(hc_rec_action_from_name(hc_rec_action_name(all[i])) == all[i]);
    }
    assert(strcmp(hc_rec_action_name(HC_REC_ACTION_NONE), "none") == 0);
}


static void test_status_reports_image_and_capability_facts(void) {
    hc_recovery_snapshot_t snap;
    hc_rec_snapshot_init(&snap);
    snprintf(snap.board_slug, sizeof(snap.board_slug), "esp32-s3-devkitc-1-n16r8");
    snprintf(snap.chip, sizeof(snap.chip), "esp32s3");
    snprintf(snap.fw_version, sizeof(snap.fw_version), "1.5.0");
    snprintf(snap.mode, sizeof(snap.mode), "recovery");
    snprintf(snap.partition, sizeof(snap.partition), "ota_1");
    snprintf(snap.backend_url, sizeof(snap.backend_url), "https://homecore.local");
    snprintf(snap.espnow_link, sizeof(snap.espnow_link), "linked");
    snap.paired = true;
    snap.wifi_connected = true;
    snap.uptime_sec = 9;
    snap.free_heap_bytes = 180000;
    snap.ota_supported = true;
    snap.ota_pending = false;
    snap.has_wifi = true;
    snap.has_ble = true;
    snap.espnow_supported = true;

    char out[HC_RECOVERY_RESPONSE_MAX];
    int n = hc_rec_build_status(&snap, out, sizeof(out));
    assert(n > 0);
    // The console reads these exact keys; a rename here would silently make
    // every repair report Unknown instead of a fact.
    assert(strstr(out, "\"uptime_sec\":9") != NULL);
    assert(strstr(out, "\"free_heap\":180000") != NULL);
    assert(strstr(out, "\"partition\":\"ota_1\"") != NULL);
    assert(strstr(out, "\"backend_url\":\"https://homecore.local\"") != NULL);
    assert(strstr(out, "\"ota_supported\":true") != NULL);
    assert(strstr(out, "\"ota_pending\":false") != NULL);
    assert(strstr(out, "\"has_wifi\":true") != NULL);
    assert(strstr(out, "\"has_ble\":true") != NULL);
    assert(strstr(out, "\"espnow_supported\":true") != NULL);
    assert(strstr(out, "\"espnow_link\":\"linked\"") != NULL);
    // The pre-existing contract still holds.
    assert(strstr(out, "\"hc\":\"status\"") != NULL);
    assert(strstr(out, "\"wifi_connected\":true") != NULL);
    assert(strstr(out, "\"last_error\":\"\"") != NULL);
    // A password or pairing secret is never part of a status answer.
    assert(strstr(out, "password") == NULL);
}

static void test_status_without_a_server_url_reports_empty_not_missing(void) {
    hc_recovery_snapshot_t snap;
    hc_rec_snapshot_init(&snap);
    snprintf(snap.mode, sizeof(snap.mode), "unprovisioned");
    snap.has_wifi = true;

    char out[HC_RECOVERY_RESPONSE_MAX];
    assert(hc_rec_build_status(&snap, out, sizeof(out)) > 0);
    // Reported-empty is the signal the console needs to auto-configure it.
    assert(strstr(out, "\"backend_url\":\"\"") != NULL);
    assert(strstr(out, "\"uptime_sec\":0") != NULL);
}

static void test_hello_carries_the_running_partition(void) {
    hc_recovery_snapshot_t snap;
    hc_rec_snapshot_init(&snap);
    snprintf(snap.board_slug, sizeof(snap.board_slug), "esp32-h2-devkitm-1");
    snprintf(snap.chip, sizeof(snap.chip), "esp32h2");
    snprintf(snap.fw_version, sizeof(snap.fw_version), "1.5.0");
    snprintf(snap.mode, sizeof(snap.mode), "recovery");
    snprintf(snap.partition, sizeof(snap.partition), "app0");
    snprintf(snap.hardware_uid, sizeof(snap.hardware_uid), "AA:BB:CC:DD:EE:12");
    snap.has_wifi = false;
    snap.has_ble = true;

    char out[HC_RECOVERY_RESPONSE_MAX];
    assert(hc_rec_build_hello(&snap, out, sizeof(out)) > 0);
    assert(strstr(out, "\"uid_suffix\":\"EE12\"") != NULL);
    assert(strstr(out, "\"partition\":\"app0\"") != NULL);
    assert(strstr(out, "\"wifi\":false") != NULL);
    assert(strstr(out, "\"ble\":true") != NULL);
}

static void test_espnow_repair_is_a_non_destructive_action(void) {
    hc_rec_command_t cmd;
    assert(
        hc_rec_parse_line("HC REPAIR {\"action\":\"espnow\"}", &cmd) == 0 &&
        cmd.action == HC_REC_ACTION_ESPNOW
    );
    assert(strcmp(hc_rec_action_name(HC_REC_ACTION_ESPNOW), "espnow") == 0);
    assert(strcmp(hc_rec_action_name(HC_REC_ACTION_WIFI), "wifi") == 0);

    hc_recovery_snapshot_t snap;
    hc_rec_snapshot_init(&snap);
    // A relink is an ordinary repair: no BOOT press and no confirmation needed,
    // even on a board sitting in normal mode.
    snprintf(snap.mode, sizeof(snap.mode), "normal");
    char reason[160];
    assert(hc_rec_action_allowed(&snap, HC_REC_ACTION_ESPNOW, false, reason, sizeof(reason)) == true);
    assert(hc_rec_action_allowed(&snap, HC_REC_ACTION_RESTART, false, reason, sizeof(reason)) == true);
    // Re-pairing and factory reset still require physical recovery mode.
    assert(hc_rec_action_allowed(&snap, HC_REC_ACTION_PAIR, false, reason, sizeof(reason)) == false);
    assert(strstr(reason, "BOOT") != NULL);
}

int main(void) {
    test_snapshot_defaults();
    test_parse_ping_hello_status();
    test_parse_wifi_repair();
    test_parse_non_secret_actions();
    test_repair_pairing_gating();
    test_factory_reset_gating();
    test_builders_never_leak_secrets();
    test_json_escaping();
    test_problem_classification();
    test_action_names_round_trip();
    test_status_reports_image_and_capability_facts();
    test_status_without_a_server_url_reports_empty_not_missing();
    test_hello_carries_the_running_partition();
    test_espnow_repair_is_a_non_destructive_action();
    printf("test_recovery_logic: all assertions passed\n");
    return 0;
}
