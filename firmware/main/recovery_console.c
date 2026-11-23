#include "recovery_console.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/uart.h"
#include "driver/usb_serial_jtag.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "role_runtime.h"
#include "sdkconfig.h"

static const char *TAG = "hc_recovery";

static homecore_config_t *s_cfg = NULL;
static hc_recovery_snapshot_t s_snap;
static volatile bool s_console_busy = false;
static portMUX_TYPE s_repair_mux = portMUX_INITIALIZER_UNLOCKED;

static bool try_lock_repair(void) {
    portENTER_CRITICAL(&s_repair_mux);
    bool available = !s_console_busy;
    if (available) s_console_busy = true;
    portEXIT_CRITICAL(&s_repair_mux);
    return available;
}

static void unlock_repair(void) {
    portENTER_CRITICAL(&s_repair_mux);
    s_console_busy = false;
    portEXIT_CRITICAL(&s_repair_mux);
}
/** Set by a restart/factory-reset repair so the transport reboots after the ack is written. */
static volatile bool s_restart_pending = false;
static volatile bool s_factory_reset_pending = false;
static bool s_console_started = false;

#define HC_RECOVERY_UART_PORT UART_NUM_0
#define HC_RECOVERY_UART_BAUD 115200

void hc_recovery_publish_snapshot(const hc_recovery_snapshot_t *snap) {
    if (!snap) return;
    s_snap = *snap;
}

void hc_recovery_get_snapshot(hc_recovery_snapshot_t *out) {
    if (!out) return;
    *out = s_snap;
}

bool hc_recovery_console_busy(void) {
    return s_console_busy;
}

bool hc_recovery_restart_pending(void) {
    return s_restart_pending;
}

void hc_recovery_apply_pending_restart(void) {
    if (!s_restart_pending) return;
    /* The response is already on the wire (UART line, HTTP body, or BLE notify),
     * so the reboot cannot swallow it. Destructive resets are handled here too. */
    const bool do_factory_reset = s_factory_reset_pending;
    s_restart_pending = false;
    s_factory_reset_pending = false;
    if (do_factory_reset) {
        hc_nvs_factory_reset();
    } else if (s_cfg) {
        hc_nvs_save_config(s_cfg);
    }
    vTaskDelay(pdMS_TO_TICKS(250));
    esp_restart();
}

/* ------------------------------------------------------------------------- */
/* Repair execution (shared by USB and the Wi-Fi portal)                      */
/* ------------------------------------------------------------------------- */

static int execute_repair(hc_rec_command_t *cmd, char *out, size_t out_cap) {
    char reason[192];
    if (!hc_rec_action_allowed(&s_snap, cmd->action, cmd->confirmed, reason, sizeof(reason))) {
        return hc_rec_build_error("not_allowed", reason, out, out_cap);
    }
    if (!s_cfg) {
        return hc_rec_build_error("not_ready", "The controller is still starting.", out, out_cap);
    }

    if (!try_lock_repair()) {
        return hc_rec_build_error("recovery_busy", "Another repair is in progress. Wait for it to finish.", out, out_cap);
    }
    int written = -1;
    ESP_LOGW(TAG, "Recovery action requested over local console: %s", hc_rec_action_name(cmd->action));

    switch (cmd->action) {
        case HC_REC_ACTION_WIFI:
            if (!HOMECORE_HAS_WIFI) {
                written = hc_rec_build_error(
                    "no_wifi", "This board has no integrated Wi-Fi radio.", out, out_cap
                );
                break;
            }
            if (strlen(cmd->backend_url) > 0) {
                hc_copy_str(s_cfg->backend_url, sizeof(s_cfg->backend_url), cmd->backend_url);
            }
            hc_copy_str(s_cfg->prov_transport, sizeof(s_cfg->prov_transport), "usb_console");
            /* Pairing, identity_key, device assignments and local rules stay
             * exactly as they are: this is the ordinary Wi-Fi repair. */
            hc_wifi_apply_new_credentials(s_cfg, cmd->ssid, cmd->password);
            hc_nvs_save_config(s_cfg);
            written = hc_rec_build_ack(
                HC_REC_ACTION_WIFI,
                "Wi-Fi credentials saved; pairing and device assignments preserved.",
                out,
                out_cap
            );
            break;

        case HC_REC_ACTION_MQTT:
            if (!HOMECORE_HAS_WIFI) {
                written = hc_rec_build_error(
                    "no_wifi", "This board has no integrated Wi-Fi radio.", out, out_cap
                );
                break;
            }
            if (!s_cfg->paired) {
                written = hc_rec_build_error(
                    "not_paired", "Re-pair the controller with HomecoreOS before reconnecting MQTT.",
                    out,
                    out_cap
                );
                break;
            }
            if (hc_mqtt_is_started()) {
                hc_mqtt_stop();
            }
            hc_mqtt_start(s_cfg);
            written = hc_rec_build_ack(
                HC_REC_ACTION_MQTT,
                "MQTT session restarted with the stored credentials.",
                out,
                out_cap
            );
            break;

        case HC_REC_ACTION_CONFIG:
            if (!s_cfg->paired) {
                written = hc_rec_build_error(
                    "not_paired", "Re-pair the controller before re-synchronizing configuration.",
                    out,
                    out_cap
                );
                break;
            }
            // The website supplies its canonical endpoint, without prompting
            // for Wi-Fi credentials or rotating pairing identity.
            if (cmd->backend_url[0]) {
                hc_copy_str(s_cfg->backend_url, sizeof(s_cfg->backend_url), cmd->backend_url);
                hc_nvs_save_config(s_cfg);
            }
            if (hc_http_fetch_config(s_cfg) == ESP_OK) {
                written = hc_rec_build_ack(
                    HC_REC_ACTION_CONFIG,
                    "Configuration snapshot re-fetched from HomecoreOS.",
                    out,
                    out_cap
                );
            } else {
                written = hc_rec_build_error(
                    "config_unreachable",
                    "The controller could not reach HomecoreOS to fetch its configuration.",
                    out,
                    out_cap
                );
            }
            break;

        case HC_REC_ACTION_ESPNOW:
            /* Re-open the ESP-NOW radio and re-sync the role block. This keeps
             * the board role, pairing, devices and Node assignments; it never
             * flashes, and a board with no ESP-NOW radio is told so plainly. */
            if (!HOMECORE_HAS_WIFI) {
                written = hc_rec_build_error(
                    "no_espnow",
                    "This board has no ESP-NOW-capable radio.",
                    out,
                    out_cap
                );
                break;
            }
            hc_role_request_relink(s_cfg);
            written = hc_rec_build_ack(
                HC_REC_ACTION_ESPNOW,
                hc_role_is_node()
                    ? "ESP-NOW re-opened; reconnecting to the assigned Controller."
                    : "ESP-NOW re-opened; waiting for attached Nodes to check in.",
                out,
                out_cap
            );
            break;

        case HC_REC_ACTION_RESTART: {
            /* A repair over a local transport ends with a clean restart. Leave
             * Recovery Mode on the way out: the reboot must come back as the
             * healthy controller the user just repaired, not re-open BLE and the
             * setup AP because a stale recovery flag was still persisted. */
            if (s_cfg->recovery_mode || s_cfg->physical_confirmed) {
                s_cfg->recovery_mode = false;
                s_cfg->physical_confirmed = false;
                s_cfg->confirm_method[0] = '\0';
                hc_nvs_save_config(s_cfg);
            }
            /* Ack first: the response must reach the browser before the reboot. */
            written = hc_rec_build_ack(
                HC_REC_ACTION_RESTART,
                "Restarting the controller with all settings preserved.",
                out,
                out_cap
            );
            s_restart_pending = true;
            unlock_repair();
            return written;
        }

        case HC_REC_ACTION_PAIR:
            /* Authorized account re-pair: the Worker validates the single-use
             * code, the board record and every device assignment stay the same,
             * and only the MQTT credentials are rotated. */
            if (strlen(cmd->backend_url) > 0) {
                hc_copy_str(s_cfg->backend_url, sizeof(s_cfg->backend_url), cmd->backend_url);
            }
            hc_copy_str(s_cfg->pending_pair_code, sizeof(s_cfg->pending_pair_code), cmd->pair_code);
            hc_copy_str(s_cfg->prov_transport, sizeof(s_cfg->prov_transport), "recovery_console");
            s_cfg->recovery_mode = true;
            if (!s_cfg->physical_confirmed) {
                /* Reaching this path already required recovery mode (see
                 * hc_rec_action_allowed), which is itself the physical proof. */
                s_cfg->physical_confirmed = true;
                if (strlen(s_cfg->confirm_method) == 0) {
                    hc_copy_str(s_cfg->confirm_method, sizeof(s_cfg->confirm_method), "recovery_console");
                }
            }
            s_cfg->paired = false;
            hc_nvs_save_config(s_cfg);
            if (hc_pairing_claim_if_needed(s_cfg) == ESP_OK) {
                written = hc_rec_build_ack(
                    HC_REC_ACTION_PAIR,
                    "Re-paired with HomecoreOS; devices, sensors and Nodes kept.",
                    out,
                    out_cap
                );
            } else if (hc_wifi_is_connected()) {
                written = hc_rec_build_error(
                    "pairing_failed",
                    "HomecoreOS rejected the recovery code. Generate a fresh code and try again.",
                    out,
                    out_cap
                );
            } else {
                written = hc_rec_build_error(
                    "pairing_offline",
                    "The controller is not on Wi-Fi yet, so it cannot re-pair. Fix Wi-Fi first.",
                    out,
                    out_cap
                );
            }
            break;

        case HC_REC_ACTION_FACTORY_RESET:
            s_factory_reset_pending = true;
            s_restart_pending = true;
            written = hc_rec_build_ack(
                HC_REC_ACTION_FACTORY_RESET,
                "Factory reset accepted; pairing, credentials and role will be erased.",
                out,
                out_cap
            );
            break;

        default:
            written = hc_rec_build_error("bad_action", "Unknown repair action.", out, out_cap);
            break;
    }

    unlock_repair();
    return written;
}

int hc_recovery_handle_line(const char *line, char *out, size_t out_cap) {
    if (!out || out_cap == 0) return -1;
    out[0] = '\0';

    hc_rec_command_t cmd;
    int parsed = hc_rec_parse_line(line, &cmd);
    if (parsed == -1) return 0;
    if (parsed == -2) {
        int n = hc_rec_build_error("line_too_long", "Command line is too long.", out, out_cap);
        hc_rec_command_clear(&cmd);
        return n;
    }
    if (parsed != 0) {
        int n = hc_rec_build_error(
            "bad_command",
            "Unrecognised command. Send HC PING, HC HELLO, HC STATUS or HC REPAIR {…}.",
            out,
            out_cap
        );
        hc_rec_command_clear(&cmd);
        return n;
    }

    int written = -1;
    switch (cmd.kind) {
        case HC_REC_CMD_PING:
            written = hc_rec_build_pong(out, out_cap);
            break;
        case HC_REC_CMD_HELLO:
            written = hc_rec_build_hello(&s_snap, out, out_cap);
            break;
        case HC_REC_CMD_STATUS:
            written = hc_rec_build_status(&s_snap, out, out_cap);
            break;
        case HC_REC_CMD_REPAIR:
            written = execute_repair(&cmd, out, out_cap);
            break;
        default:
            written = hc_rec_build_error("bad_command", "Unrecognised command.", out, out_cap);
            break;
    }

    hc_rec_command_clear(&cmd);
    return written;
}

int hc_recovery_handle_json(const char *line, char *out, size_t out_cap) {
    return hc_recovery_handle_line(line, out, out_cap);
}

/* ------------------------------------------------------------------------- */
/* USB / UART console task                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Reads one byte from whichever USB port carries this board's console.
 *
 * Boards with native USB route the console over USB-Serial-JTAG, and boards with
 * a USB-UART bridge route it over UART0. Using UART0 unconditionally made the
 * console silently unreachable on every native-USB board (the browser opened
 * the USB-CDC port the chip exposes and nothing ever answered), and it also put
 * a driver on the bootloader's UART pins on boards whose USB port is elsewhere.
 */
static int console_read_byte(uint8_t *ch) {
#if defined(CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG)
    return (int)usb_serial_jtag_read_bytes(ch, 1, pdMS_TO_TICKS(100));
#else
    return uart_read_bytes(HC_RECOVERY_UART_PORT, ch, 1, pdMS_TO_TICKS(100));
#endif
}

/** Writes a response back on the same port it was read from. */
static void console_write(const char *data, size_t len) {
#if defined(CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG)
    usb_serial_jtag_write_bytes(data, len, pdMS_TO_TICKS(200));
#else
    uart_write_bytes(HC_RECOVERY_UART_PORT, data, len);
#endif
}

static void recovery_console_task(void *arg) {
    (void)arg;
    char line[HC_RECOVERY_LINE_MAX + 8];
    size_t len = 0;
    bool capturing = false;
    char response[HC_RECOVERY_RESPONSE_MAX];

    while (1) {
        uint8_t ch = 0;
        int read = console_read_byte(&ch);
        if (read <= 0) continue;

        if (ch == '\r' || ch == '\n') {
            if (capturing && len > 0) {
                line[len] = '\0';
                int n = hc_recovery_handle_line(line, response, sizeof(response));
                if (n > 0) {
                    console_write(response, (size_t)n);
                    console_write("\n", 1);
                    if (hc_recovery_restart_pending()) {
                        vTaskDelay(pdMS_TO_TICKS(150));
                        hc_recovery_apply_pending_restart();
                    }
                }
            }
            len = 0;
            capturing = false;
            continue;
        }

        /* Only lines that start with the protocol prefix are consumed, so the
         * normal ESP-IDF log stream on the same port keeps working. */
        if (!capturing) {
            if (ch == 'H' && len == 0) {
                line[len++] = (char)ch;
            } else {
                len = 0;
                continue;
            }
            capturing = true;
            continue;
        }

        if (len < sizeof(line) - 1) {
            line[len++] = (char)ch;
            if (len == 2 && !(line[1] == 'C' || line[1] == 'c')) {
                len = 0;
                capturing = false;
            }
        } else {
            line[len] = '\0';
            int n = hc_rec_build_error("line_too_long", "Command line is too long.", response, sizeof(response));
            if (n > 0) {
                console_write(response, (size_t)n);
                console_write("\n", 1);
            }
            len = 0;
            capturing = false;
        }
    }
}

void hc_recovery_console_start(homecore_config_t *cfg) {
    s_cfg = cfg;
    if (s_snap.mode[0] == '\0') {
        hc_rec_snapshot_init(&s_snap);
    }
    if (s_console_started) return;

#if defined(CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG)
    /* USB-Serial-JTAG needs no driver install: the IDF console already owns the
     * port this image logs to, which is the same port the browser opens. */
    ESP_LOGI(TAG, "Unified recovery console reading USB-Serial-JTAG (protocol %d)", HC_RECOVERY_PROTO_VERSION);
#else
    /* UART0 is already installed by the IDF console; only install the driver
     * when the build does not own the port, so we never fight the log output. */
    esp_err_t err = uart_driver_install(HC_RECOVERY_UART_PORT, 1024, 1024, 0, NULL, 0);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "USB recovery console unavailable (uart driver: %s)", esp_err_to_name(err));
        return;
    }
    uart_set_baudrate(HC_RECOVERY_UART_PORT, HC_RECOVERY_UART_BAUD);
#endif

    if (xTaskCreate(recovery_console_task, "hc_recovery", 4096, NULL, 2, NULL) != pdPASS) {
        ESP_LOGW(TAG, "USB recovery console task could not start");
        return;
    }
    s_console_started = true;
    ESP_LOGI(TAG, "Unified recovery console ready on USB/UART0 (protocol %d)", HC_RECOVERY_PROTO_VERSION);
}
