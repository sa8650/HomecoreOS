#include "homecore_config.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"

static const char *TAG = "hc_wifi";

#if !HOMECORE_HAS_WIFI

void hc_wifi_get_mac_uid(char *out_buf, size_t out_len) {
    uint8_t mac[8] = {0};
    if (esp_read_mac(mac, ESP_MAC_BT) != ESP_OK) {
        esp_read_mac(mac, ESP_MAC_IEEE802154);
    }
    snprintf(
        out_buf,
        out_len,
        "%02X:%02X:%02X:%02X:%02X:%02X",
        mac[0],
        mac[1],
        mac[2],
        mac[3],
        mac[4],
        mac[5]
    );
}

bool hc_wifi_is_connected(void) {
    return false;
}

const char *hc_wifi_get_last_error(void) {
    return "No integrated Wi-Fi radio on this board target";
}

esp_err_t hc_wifi_start_portal_ap(homecore_config_t *cfg) {
    (void)cfg;
    ESP_LOGW(TAG, "SoftAP Wi-Fi portal unavailable on %s (no Wi-Fi radio)", HOMECORE_BOARD_SLUG);
    return ESP_ERR_NOT_SUPPORTED;
}

void hc_wifi_stop_portal_ap(void) {}

esp_err_t hc_wifi_apply_new_credentials(homecore_config_t *cfg, const char *ssid, const char *pass) {
    (void)cfg;
    (void)ssid;
    (void)pass;
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t hc_wifi_start(homecore_config_t *cfg, bool allow_ap_portal) {
    (void)cfg;
    (void)allow_ap_portal;
    ESP_LOGW(TAG, "Board %s has no integrated Wi-Fi radio; Wi-Fi STA/AP skipped", HOMECORE_BOARD_SLUG);
    return ESP_ERR_NOT_SUPPORTED;
}

#else

#include "esp_wifi.h"

#define WIFI_CONNECTED_BIT BIT0

static EventGroupHandle_t s_wifi_event_group = NULL;
static bool s_stack_inited = false;
static bool s_connected = false;
static bool s_ap_active = false;
static bool s_sta_started = false;
static int s_retry_num = 0;
static char s_last_wifi_error[96] = {0};
static homecore_config_t *s_cfg_ref = NULL;
static httpd_handle_t s_httpd = NULL;
static esp_netif_t *s_sta_netif = NULL;
static esp_netif_t *s_ap_netif = NULL;
static esp_timer_handle_t s_retry_timer = NULL;
static esp_timer_handle_t s_portal_close_timer = NULL;

void hc_wifi_get_mac_uid(char *out_buf, size_t out_len) {
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(
        out_buf,
        out_len,
        "%02X:%02X:%02X:%02X:%02X:%02X",
        mac[0],
        mac[1],
        mac[2],
        mac[3],
        mac[4],
        mac[5]
    );
}

bool hc_wifi_is_connected(void) {
    return s_connected;
}

const char *hc_wifi_get_last_error(void) {
    return s_last_wifi_error;
}

static void url_decode(char *dst, const char *src, size_t max_len) {
    size_t i = 0;
    while (*src && i + 1 < max_len) {
        if (*src == '+') {
            dst[i++] = ' ';
            src++;
        } else if (src[0] == '%' && isxdigit((unsigned char)src[1]) && isxdigit((unsigned char)src[2])) {
            char hex[3] = { src[1], src[2], '\0' };
            dst[i++] = (char)strtol(hex, NULL, 16);
            src += 3;
        } else {
            dst[i++] = *src++;
        }
    }
    dst[i] = '\0';
}

static void extract_form_field(const char *body, const char *key, char *out, size_t max_len) {
    out[0] = '\0';
    size_t key_len = strlen(key);
    const char *p = body;
    while (p && *p) {
        const char *eq = strchr(p, '=');
        if (!eq) break;
        const char *amp = strchr(p, '&');
        if ((size_t)(eq - p) == key_len && strncmp(p, key, key_len) == 0) {
            size_t raw_len = amp ? (size_t)(amp - (eq + 1)) : strlen(eq + 1);
            char *tmp = calloc(1, raw_len + 1);
            if (tmp) {
                memcpy(tmp, eq + 1, raw_len);
                url_decode(out, tmp, max_len);
                free(tmp);
            }
            return;
        }
        p = amp ? (amp + 1) : NULL;
    }
}

static void stop_portal_ap_cb(void *arg) {
    (void)arg;
    hc_wifi_stop_portal_ap();
}

void hc_wifi_stop_portal_ap(void) {
    if (s_portal_close_timer) {
        esp_timer_stop(s_portal_close_timer);
    }
    if (s_httpd) {
        httpd_stop(s_httpd);
        s_httpd = NULL;
    }
    if (s_ap_active) {
        s_ap_active = false;
        if (s_cfg_ref && strlen(s_cfg_ref->wifi_ssid) > 0) {
            esp_wifi_set_mode(WIFI_MODE_STA);
        }
        ESP_LOGI(TAG, "Closed local setup AP; continuing in STA mode");
    }
}

static void retry_timer_cb(void *arg) {
    (void)arg;
    if (!s_connected && s_sta_started && s_cfg_ref && strlen(s_cfg_ref->wifi_ssid) > 0) {
        ESP_LOGI(TAG, "Attempting automatic Wi-Fi reconnect (attempt #%d)...", s_retry_num + 1);
        esp_wifi_connect();
    }
}

static void apply_sta_config_and_connect(const homecore_config_t *cfg) {
    if (!cfg || strlen(cfg->wifi_ssid) == 0) return;

    wifi_config_t sta_cfg = {0};
    hc_copy_str((char *)sta_cfg.sta.ssid, sizeof(sta_cfg.sta.ssid), cfg->wifi_ssid);
    hc_copy_str((char *)sta_cfg.sta.password, sizeof(sta_cfg.sta.password), cfg->wifi_pass);
    sta_cfg.sta.threshold.authmode =
        strlen(cfg->wifi_pass) > 0 ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;

    s_retry_num = 0;
    s_connected = false;
    esp_wifi_set_mode(s_ap_active ? WIFI_MODE_APSTA : WIFI_MODE_STA);
    esp_wifi_set_config(WIFI_IF_STA, &sta_cfg);
    if (!s_sta_started) {
        s_sta_started = true;
        esp_wifi_start();
    } else {
        esp_wifi_disconnect();
        esp_wifi_connect();
    }
}

static esp_err_t portal_get_handler(httpd_req_t *req) {
    char uid[24];
    hc_wifi_get_mac_uid(uid, sizeof(uid));

    const bool is_paired = s_cfg_ref && s_cfg_ref->paired;
    const bool phys_btn = s_cfg_ref && s_cfg_ref->physical_confirmed;

    char *page = calloc(1, 3584);
    if (!page) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "OOM");
        return ESP_FAIL;
    }

    snprintf(
        page,
        3584,
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>HomecoreOS Controller Setup &amp; Recovery</title>"
        "<style>body{font-family:sans-serif;max-width:460px;margin:1.5rem auto;padding:1rem;background:#0a0a0a;color:#fafafa}"
        "input,select,button{width:100%%;padding:.65rem;margin:.3rem 0 .8rem;border-radius:10px;border:1px solid #333;box-sizing:border-box}"
        "input,select{background:#171717;color:#fff}button{background:#2563eb;color:#fff;font-weight:700;cursor:pointer;border:none}"
        ".card{background:#121212;border:1px solid #262626;border-radius:16px;padding:1.25rem}"
        ".meta{font-size:12px;color:#94a3b8;margin-bottom:1rem}.chk{display:flex;gap:8px;align-items:flex-start;font-size:13px;margin:.5rem 0 1rem}"
        ".chk input{width:auto;margin:2px 0 0}</style></head><body>"
        "<div class='card'><h2>HomecoreOS Setup &amp; Recovery</h2>"
        "<p class='meta'>UID: <code>%s</code> &middot; Firmware v%s<br>"
        "Board: <code>%s</code> (%s, BOOT=GPIO%d)<br>"
        "Pairing: <strong>%s</strong> &middot; Wi-Fi: <strong>%s</strong></p>"
        "<form method='post' action='/provision'>"
        "<label>Action<select name='mode'>"
        "<option value='wifi_only'%s>Update Wi-Fi Credentials Only (Keep Pairing)</option>"
        "<option value='pair'%s>Pair New Controller</option>"
        "<option value='recover'>Recover / Re-pair Existing Controller</option>"
        "</select></label>"
        "<label>Wi-Fi SSID<input name='ssid' maxlength='63' value='%s' placeholder='HomeNetwork'></label>"
        "<label>Wi-Fi Password<input name='password' type='password' maxlength='63' placeholder='%s'></label>"
        "<label>HomecoreOS Server URL<input name='backend_url' required placeholder='https://your-worker.workers.dev' value='%s'></label>"
        "<label>6-Digit Pairing or Recovery Code (leave blank for Wi-Fi-only update)<input name='pair_code' maxlength='12' pattern='([0-9]{6})?' placeholder='123456'></label>"
        "<label class='chk'><input type='checkbox' name='phys_confirm' value='1'%s>"
        "<span>Confirm physical controller access for recovery re-pairing%s</span></label>"
        "<button type='submit'>Save &amp; Apply</button>"
        "</form></div></body></html>",
        uid,
        hc_get_runtime_fw_version(),
        HOMECORE_BOARD_SLUG,
        CONFIG_IDF_TARGET,
        HOMECORE_BOOT_BUTTON_GPIO,
        is_paired ? "Paired (Preserved)" : "Unpaired",
        s_connected ? "Connected" : (strlen(s_last_wifi_error) > 0 ? s_last_wifi_error : "Disconnected"),
        is_paired ? " selected" : "",
        is_paired ? "" : " selected",
        s_cfg_ref ? s_cfg_ref->wifi_ssid : "",
        (s_cfg_ref && strlen(s_cfg_ref->wifi_pass) > 0) ? "Leave blank to keep saved password" : "Wi-Fi password",
        s_cfg_ref ? s_cfg_ref->backend_url : "",
        phys_btn ? " checked" : "",
        phys_btn ? " (Recovery button verified)" : ""
    );

    httpd_resp_set_type(req, "text/html");
    esp_err_t res = httpd_resp_sendstr(req, page);
    free(page);
    return res;
}

static esp_err_t portal_post_handler(httpd_req_t *req) {
    char buf[1024];
    int received = httpd_req_recv(req, buf, sizeof(buf) - 1);
    if (received <= 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Empty body");
        return ESP_FAIL;
    }
    buf[received] = '\0';

    if (s_cfg_ref) {
        char mode[24] = {0};
        char ssid[64] = {0};
        char pass[64] = {0};
        char backend[192] = {0};
        char pair_code[16] = {0};
        char phys_confirm[8] = {0};

        extract_form_field(buf, "mode", mode, sizeof(mode));
        extract_form_field(buf, "ssid", ssid, sizeof(ssid));
        extract_form_field(buf, "password", pass, sizeof(pass));
        extract_form_field(buf, "backend_url", backend, sizeof(backend));
        extract_form_field(buf, "pair_code", pair_code, sizeof(pair_code));
        extract_form_field(buf, "phys_confirm", phys_confirm, sizeof(phys_confirm));

        const bool is_recover = (strcmp(mode, "recover") == 0);
        const bool has_code = (strlen(pair_code) == 6);

        if (is_recover && !s_cfg_ref->physical_confirmed && strcmp(phys_confirm, "1") != 0) {
            httpd_resp_set_status(req, "400 Bad Request");
            httpd_resp_set_type(req, "text/html");
            httpd_resp_sendstr(
                req,
                "<!doctype html><body style='font-family:sans-serif;padding:2rem;background:#0a0a0a;color:#fafafa'>"
                "<h2>Physical Confirmation Required</h2>"
                "<p>Check the physical access confirmation box or hold the BOOT/Recovery button for 3 seconds before re-pairing.</p>"
                "<p><a href='/' style='color:#60a5fa'>Back to Setup</a></p></body></html>"
            );
            return ESP_OK;
        }

        if (strlen(ssid) > 0) {
            bool ssid_changed = (strcmp(s_cfg_ref->wifi_ssid, ssid) != 0);
            hc_copy_str(s_cfg_ref->wifi_ssid, sizeof(s_cfg_ref->wifi_ssid), ssid);
            if (strlen(pass) > 0 || ssid_changed) {
                hc_copy_str(s_cfg_ref->wifi_pass, sizeof(s_cfg_ref->wifi_pass), pass);
            }
        }
        if (strlen(backend) > 0) {
            hc_copy_str(s_cfg_ref->backend_url, sizeof(s_cfg_ref->backend_url), backend);
        }
        hc_copy_str(s_cfg_ref->prov_transport, sizeof(s_cfg_ref->prov_transport), "softap");

        if (has_code && strcmp(mode, "wifi_only") != 0) {
            // Pairing or recovery re-pairing: keep identity_key intact!
            hc_copy_str(s_cfg_ref->pending_pair_code, sizeof(s_cfg_ref->pending_pair_code), pair_code);
            s_cfg_ref->paired = false;
            s_cfg_ref->recovery_mode = is_recover;
            if (strcmp(phys_confirm, "1") == 0 && !s_cfg_ref->physical_confirmed) {
                s_cfg_ref->physical_confirmed = true;
                hc_copy_str(s_cfg_ref->confirm_method, sizeof(s_cfg_ref->confirm_method), "local_portal");
            }
        }
        // Note: wifi_only preserves s_cfg_ref->paired, mqtt_*, device_api_token, identity_key, and local IO rules!

        hc_nvs_save_config(s_cfg_ref);
        apply_sta_config_and_connect(s_cfg_ref);
    }

    httpd_resp_set_type(req, "text/html");
    httpd_resp_sendstr(
        req,
        "<!doctype html><html><body style='font-family:sans-serif;padding:2rem;background:#0a0a0a;color:#fafafa'>"
        "<h2>Settings Applied!</h2>"
        "<p>Wi-Fi credentials and HomecoreOS configuration were saved. The controller is reconnecting to Wi-Fi and HomecoreOS now without losing saved pairing or local automations.</p>"
        "</body></html>"
    );

    if (s_portal_close_timer && s_cfg_ref && strlen(s_cfg_ref->wifi_ssid) > 0) {
        esp_timer_stop(s_portal_close_timer);
        esp_timer_start_once(s_portal_close_timer, 1800 * 1000);
    }
    return ESP_OK;
}

static void start_http_portal_server(void) {
    if (s_httpd) return;
    httpd_config_t httpd_cfg = HTTPD_DEFAULT_CONFIG();
    if (httpd_start(&s_httpd, &httpd_cfg) == ESP_OK) {
        httpd_uri_t get_root = {
            .uri = "/",
            .method = HTTP_GET,
            .handler = portal_get_handler,
        };
        httpd_uri_t post_prov = {
            .uri = "/provision",
            .method = HTTP_POST,
            .handler = portal_post_handler,
        };
        httpd_register_uri_handler(s_httpd, &get_root);
        httpd_register_uri_handler(s_httpd, &post_prov);
    }
}

static void wifi_event_handler(
    void *arg,
    esp_event_base_t event_base,
    int32_t event_id,
    void *event_data
) {
    (void)arg;
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        if (s_cfg_ref && strlen(s_cfg_ref->wifi_ssid) > 0) {
            esp_wifi_connect();
        }
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        s_connected = false;
        wifi_event_sta_disconnected_t *disc = (wifi_event_sta_disconnected_t *)event_data;
        uint8_t reason = disc ? disc->reason : 0;
        if (reason == WIFI_REASON_AUTH_FAIL || reason == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT) {
            hc_copy_str(s_last_wifi_error, sizeof(s_last_wifi_error), "Wi-Fi authentication failed");
        } else if (reason == WIFI_REASON_NO_AP_FOUND) {
            hc_copy_str(s_last_wifi_error, sizeof(s_last_wifi_error), "Wi-Fi network not found");
        } else {
            snprintf(s_last_wifi_error, sizeof(s_last_wifi_error), "Wi-Fi disconnected (reason=%u)", reason);
        }

        // Exponential backoff reconnect: 2s -> 4s -> 8s -> 16s -> 32s -> max 60s
        // Saved Wi-Fi credentials are NEVER cleared on disconnect!
        if (s_cfg_ref && strlen(s_cfg_ref->wifi_ssid) > 0 && s_retry_timer) {
            uint32_t delay_ms = hc_prov_wifi_backoff_ms((uint32_t)s_retry_num);
            s_retry_num++;
            esp_timer_stop(s_retry_timer);
            esp_timer_start_once(s_retry_timer, (uint64_t)delay_ms * 1000ULL);
            ESP_LOGW(TAG, "%s; retrying in %ums", s_last_wifi_error, (unsigned)delay_ms);
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "Connected with IP: " IPSTR, IP2STR(&event->ip_info.ip));
        s_retry_num = 0;
        s_connected = true;
        s_last_wifi_error[0] = '\0';
        if (s_wifi_event_group) {
            xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
        }
    }
}

static void ensure_wifi_stack_initialized(void) {
    if (s_stack_inited) return;
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    s_wifi_event_group = xEventGroupCreate();
    s_sta_netif = esp_netif_create_default_wifi_sta();
    s_ap_netif = esp_netif_create_default_wifi_ap();
    (void)s_sta_netif;
    (void)s_ap_netif;

    wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init_cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL
    ));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, NULL
    ));

    esp_timer_create_args_t retry_args = {
        .callback = &retry_timer_cb,
        .name = "hc_wifi_retry",
    };
    ESP_ERROR_CHECK(esp_timer_create(&retry_args, &s_retry_timer));

    esp_timer_create_args_t close_args = {
        .callback = &stop_portal_ap_cb,
        .name = "hc_portal_close",
    };
    ESP_ERROR_CHECK(esp_timer_create(&close_args, &s_portal_close_timer));

    s_stack_inited = true;
}

esp_err_t hc_wifi_start_portal_ap(homecore_config_t *cfg) {
    s_cfg_ref = cfg;
    ensure_wifi_stack_initialized();
    if (cfg) {
        hc_nvs_ensure_setup_pin(cfg);
    }

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);

    wifi_config_t ap_cfg = {0};
    snprintf((char *)ap_cfg.ap.ssid, sizeof(ap_cfg.ap.ssid), "HomecoreOS-Setup-%02X%02X", mac[4], mac[5]);
    ap_cfg.ap.ssid_len = strlen((const char *)ap_cfg.ap.ssid);
    ap_cfg.ap.channel = 1;
    ap_cfg.ap.max_connection = 4;
    ap_cfg.ap.authmode = WIFI_AUTH_OPEN;

    const bool has_sta = (cfg && strlen(cfg->wifi_ssid) > 0);
    s_ap_active = true;
    ESP_ERROR_CHECK(esp_wifi_set_mode(has_sta ? WIFI_MODE_APSTA : WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap_cfg));
    if (!s_sta_started) {
        if (has_sta) {
            wifi_config_t sta_cfg = {0};
            hc_copy_str((char *)sta_cfg.sta.ssid, sizeof(sta_cfg.sta.ssid), cfg->wifi_ssid);
            hc_copy_str((char *)sta_cfg.sta.password, sizeof(sta_cfg.sta.password), cfg->wifi_pass);
            sta_cfg.sta.threshold.authmode =
                strlen(cfg->wifi_pass) > 0 ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
            ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta_cfg));
        }
        s_sta_started = true;
        ESP_ERROR_CHECK(esp_wifi_start());
    }

    start_http_portal_server();
    ESP_LOGW(
        TAG,
        "[HC_SETUP] BOARD=%s AP_SSID=%s URL=http://192.168.4.1",
        HOMECORE_BOARD_SLUG,
        (char *)ap_cfg.ap.ssid
    );
    return ESP_OK;
}

esp_err_t hc_wifi_apply_new_credentials(homecore_config_t *cfg, const char *ssid, const char *pass) {
    if (!cfg || !ssid || strlen(ssid) == 0) return ESP_ERR_INVALID_ARG;
    s_cfg_ref = cfg;
    hc_copy_str(cfg->wifi_ssid, sizeof(cfg->wifi_ssid), ssid);
    hc_copy_str(cfg->wifi_pass, sizeof(cfg->wifi_pass), pass ? pass : "");
    hc_nvs_save_config(cfg);

    ensure_wifi_stack_initialized();
    apply_sta_config_and_connect(cfg);
    return ESP_OK;
}

esp_err_t hc_wifi_start(homecore_config_t *cfg, bool allow_ap_portal) {
    s_cfg_ref = cfg;
    ensure_wifi_stack_initialized();

    const bool has_sta_cfg = (cfg && strlen(cfg->wifi_ssid) > 0 && strlen(cfg->backend_url) > 0);
    if (allow_ap_portal) {
        hc_wifi_start_portal_ap(cfg);
        if (!has_sta_cfg) {
            return ESP_ERR_NOT_FOUND;
        }
    } else {
        apply_sta_config_and_connect(cfg);
    }

    EventBits_t bits = xEventGroupWaitBits(
        s_wifi_event_group,
        WIFI_CONNECTED_BIT,
        pdFALSE,
        pdFALSE,
        pdMS_TO_TICKS(allow_ap_portal ? 5000 : 10000)
    );

    if (bits & WIFI_CONNECTED_BIT) {
        return ESP_OK;
    }

    // In NORMAL mode (already paired & configured), NEVER open setup AP automatically
    // when the router is temporarily offline; STA exponential-backoff retry stays active.
    return ESP_FAIL;
}

#endif /* HOMECORE_HAS_WIFI */
