#include "espnow_link.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "homecore_config.h"

#if HOMECORE_HAS_WIFI

#include "esp_wifi.h"

static const char *TAG = "hc_espnow";

static bool s_ready = false;
static bool s_hosting = false;
static bool s_seeking = false;
static uint8_t s_channel = 0;
static uint8_t s_seek_channel = 1;
static uint8_t s_target_mac[6] = {0};
static bool s_has_target = false;
static hc_espnow_rx_fn s_rx_cb = NULL;

static void mac_to_str(const uint8_t mac[6], char *out, size_t out_len) {
    snprintf(
        out,
        out_len,
        "%02X:%02X:%02X:%02X:%02X:%02X",
        mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]
    );
}

void hc_espnow_mac_to_string(const uint8_t mac[6], char *out, size_t out_len) {
    mac_to_str(mac, out, out_len);
}

bool hc_espnow_mac_from_string(const char *text, uint8_t out[6]) {
    if (!text || !out) return false;
    unsigned int v[6] = {0};
    int n = sscanf(
        text,
        "%x:%x:%x:%x:%x:%x",
        &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]
    );
    if (n != 6) return false;
    for (int i = 0; i < 6; ++i) {
        if (v[i] > 0xFF) return false;
        out[i] = (uint8_t)v[i];
    }
    bool all_zero = true;
    for (int i = 0; i < 6; ++i) {
        if (out[i] != 0) {
            all_zero = false;
            break;
        }
    }
    return !all_zero;
}

static esp_err_t ensure_peer(const uint8_t mac[6]) {
    if (esp_now_is_peer_exist(mac)) return ESP_OK;
    esp_now_peer_info_t peer;
    memset(&peer, 0, sizeof(peer));
    memcpy(peer.peer_addr, mac, 6);
    peer.channel = 0; /* 0 = current channel, so channel hops keep working */
    peer.ifidx = WIFI_IF_STA;
    peer.encrypt = false;
    esp_err_t err = esp_now_add_peer(&peer);
    if (err != ESP_OK && err != ESP_ERR_ESPNOW_EXIST) {
        ESP_LOGW(TAG, "add_peer failed: %s", esp_err_to_name(err));
        return err;
    }
    return ESP_OK;
}

esp_err_t hc_espnow_add_peer(const char *mac) {
    uint8_t addr[6];
    if (!hc_espnow_mac_from_string(mac, addr)) return ESP_ERR_INVALID_ARG;
    return ensure_peer(addr);
}

static void recv_cb(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    if (!info || !data || len < (int)sizeof(hc_espnow_header_t)) return;
    const hc_espnow_header_t *hdr = (const hc_espnow_header_t *)data;
    if (hdr->magic0 != HC_ESPNOW_MAGIC0 || hdr->magic1 != HC_ESPNOW_MAGIC1) return;
    if (hdr->version != HC_ESPNOW_VERSION) return;

    uint16_t payload_len = hdr->payload_len;
    if (payload_len > HC_ESPNOW_MAX_PAYLOAD) payload_len = HC_ESPNOW_MAX_PAYLOAD;
    if ((int)(sizeof(hc_espnow_header_t) + payload_len) > len) {
        payload_len = (uint16_t)(len - (int)sizeof(hc_espnow_header_t));
    }

    hc_espnow_rx_t rx;
    memset(&rx, 0, sizeof(rx));
    memcpy(rx.mac, info->src_addr, 6);
    rx.type = (hc_espnow_frame_type_t)hdr->type;
    rx.epoch = hdr->epoch;
    rx.seq = hdr->seq;
    rx.rssi = info->rx_ctrl ? info->rx_ctrl->rssi : 0;
    rx.payload_len = payload_len;
    memcpy(rx.payload, data + sizeof(hc_espnow_header_t), payload_len);
    rx.payload[payload_len] = '\0';

    if (s_hosting) {
        char from[20];
        mac_to_str(rx.mac, from, sizeof(from));
        ensure_peer(rx.mac);
        if (rx.type == HC_ESPNOW_FRAME_NODE_KEEPALIVE) {
            hc_espnow_send_ack(rx.mac, rx.epoch, rx.seq);
        }
        if (s_rx_cb) s_rx_cb(&rx);
        ESP_LOGD(TAG, "node frame from %s type=%d rssi=%d", from, (int)rx.type, rx.rssi);
        return;
    }

    if (s_has_target && memcmp(info->src_addr, s_target_mac, 6) != 0) {
        return; /* someone else's traffic while seeking */
    }
    if (rx.type == HC_ESPNOW_FRAME_CONTROLLER_ACK && s_seeking) {
        s_seeking = false;
        ESP_LOGI(TAG, "Controller answered on channel %u", (unsigned)s_channel);
    }
    if (s_rx_cb) s_rx_cb(&rx);
}

esp_err_t hc_espnow_init(void) {
    if (s_ready) return ESP_OK;
    esp_err_t err = esp_now_init();
    if (err != ESP_OK && err != ESP_ERR_ESPNOW_INTERNAL) {
        ESP_LOGW(TAG, "esp_now_init failed: %s", esp_err_to_name(err));
        return err;
    }
    err = esp_now_register_recv_cb(recv_cb);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "esp_now_register_recv_cb failed: %s", esp_err_to_name(err));
        return err;
    }
    s_ready = true;
    ESP_LOGI(TAG, "ESP-NOW ready on channel %u", (unsigned)hc_espnow_get_channel());
    return ESP_OK;
}

bool hc_espnow_is_ready(void) {
    return s_ready;
}

uint8_t hc_espnow_get_channel(void) {
    if (s_channel != 0) return s_channel;
    uint8_t primary = 0;
    wifi_second_chan_t second = WIFI_SECOND_CHAN_NONE;
    if (esp_wifi_get_channel(&primary, &second) == ESP_OK && primary > 0) {
        return primary;
    }
    return 1;
}

esp_err_t hc_espnow_set_channel(uint8_t channel) {
    if (channel > 13) return ESP_ERR_INVALID_ARG;
    s_channel = channel;
    if (channel == 0) {
        s_seeking = false;
        return ESP_OK;
    }
    esp_err_t err = esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "set_channel(%u) failed: %s", (unsigned)channel, esp_err_to_name(err));
    }
    return err;
}

esp_err_t hc_espnow_host_start(hc_espnow_rx_fn on_node_frame) {
    esp_err_t err = hc_espnow_init();
    if (err != ESP_OK) return err;
    s_rx_cb = on_node_frame;
    s_hosting = true;
    s_seeking = false;
    s_has_target = false;
    ESP_LOGI(TAG, "Hosting Nodes on channel %u", (unsigned)hc_espnow_get_channel());
    return ESP_OK;
}

esp_err_t hc_espnow_seek_start(const char *controller_mac, uint8_t channel, hc_espnow_rx_fn on_ctrl_frame) {
    esp_err_t err = hc_espnow_init();
    if (err != ESP_OK) return err;
    if (!hc_espnow_mac_from_string(controller_mac, s_target_mac)) {
        s_has_target = false;
        return ESP_ERR_INVALID_ARG;
    }
    s_has_target = true;
    s_rx_cb = on_ctrl_frame;
    s_hosting = false;
    ensure_peer(s_target_mac);

    if (channel >= 1 && channel <= 13) {
        s_seeking = false;
        return hc_espnow_set_channel(channel);
    }

    // No pinned channel: sweep 1..13 until the Controller answers. s_channel
    // stays 0 ("follow the radio") so get_channel() reports the live channel and
    // a later re-seek is allowed.
    s_seeking = true;
    s_channel = 0;
    s_seek_channel = 1;
    esp_err_t hop_err = esp_wifi_set_channel(s_seek_channel, WIFI_SECOND_CHAN_NONE);
    ESP_LOGI(TAG, "Seeking Controller %s across channels", controller_mac);
    return hop_err;
}

bool hc_espnow_is_seeking(void) {
    return s_seeking;
}

void hc_espnow_seek_hop(void) {
    if (!s_seeking) return;
    s_seek_channel = (uint8_t)((s_seek_channel % 13) + 1);
    esp_err_t err = esp_wifi_set_channel(s_seek_channel, WIFI_SECOND_CHAN_NONE);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "channel hop to %u failed: %s", (unsigned)s_seek_channel, esp_err_to_name(err));
    }
}

void hc_espnow_reseek(void) {
    if (s_hosting || !s_has_target) return;
    if (s_channel != 0) return; /* channel pinned in the console profile */
    s_seeking = true;
    s_seek_channel = 1;
    esp_err_t err = esp_wifi_set_channel(s_seek_channel, WIFI_SECOND_CHAN_NONE);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "re-seek start on channel 1 failed: %s", esp_err_to_name(err));
    }
    ESP_LOGI(TAG, "Controller link lost: sweeping channels again");
}

static esp_err_t send_frame(
    const uint8_t mac[6],
    hc_espnow_frame_type_t type,
    uint16_t epoch,
    uint32_t seq,
    const char *json
) {
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    size_t payload_len = json ? strlen(json) : 0;
    if (payload_len > HC_ESPNOW_MAX_PAYLOAD) return ESP_ERR_INVALID_SIZE;

    uint8_t buffer[sizeof(hc_espnow_header_t) + HC_ESPNOW_MAX_PAYLOAD];
    hc_espnow_header_t hdr = {
        .magic0 = HC_ESPNOW_MAGIC0,
        .magic1 = HC_ESPNOW_MAGIC1,
        .version = HC_ESPNOW_VERSION,
        .type = (uint8_t)type,
        .epoch = epoch,
        .seq = seq,
        .payload_len = (uint16_t)payload_len,
    };
    memcpy(buffer, &hdr, sizeof(hdr));
    if (payload_len > 0) memcpy(buffer + sizeof(hdr), json, payload_len);

    ensure_peer(mac);
    return esp_now_send(mac, buffer, sizeof(hdr) + payload_len);
}

esp_err_t hc_espnow_send_keepalive(const char *mac, uint16_t epoch, uint32_t seq) {
    uint8_t addr[6];
    if (!hc_espnow_mac_from_string(mac, addr)) return ESP_ERR_INVALID_ARG;
    return send_frame(addr, HC_ESPNOW_FRAME_NODE_KEEPALIVE, epoch, seq, NULL);
}

esp_err_t hc_espnow_send_keepalive_json(
    const char *mac,
    uint16_t epoch,
    uint32_t seq,
    const char *json
) {
    uint8_t addr[6];
    if (!hc_espnow_mac_from_string(mac, addr)) return ESP_ERR_INVALID_ARG;
    return send_frame(addr, HC_ESPNOW_FRAME_NODE_KEEPALIVE, epoch, seq, json);
}

esp_err_t hc_espnow_send_ack(const uint8_t mac[6], uint16_t epoch, uint32_t seq) {
    return send_frame(mac, HC_ESPNOW_FRAME_CONTROLLER_ACK, epoch, seq, NULL);
}

esp_err_t hc_espnow_send_command(const char *mac, uint16_t epoch, uint32_t seq, const char *json) {
    uint8_t addr[6];
    if (!hc_espnow_mac_from_string(mac, addr)) return ESP_ERR_INVALID_ARG;
    if (!json || strlen(json) == 0) return ESP_ERR_INVALID_ARG;
    return send_frame(addr, HC_ESPNOW_FRAME_COMMAND, epoch, seq, json);
}

#else /* !HOMECORE_HAS_WIFI */

bool hc_espnow_is_ready(void) { return false; }
uint8_t hc_espnow_get_channel(void) { return 0; }
esp_err_t hc_espnow_init(void) { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t hc_espnow_set_channel(uint8_t channel) {
    (void)channel;
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t hc_espnow_host_start(hc_espnow_rx_fn on_node_frame) {
    (void)on_node_frame;
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t hc_espnow_seek_start(const char *controller_mac, uint8_t channel, hc_espnow_rx_fn on_ctrl_frame) {
    (void)controller_mac;
    (void)channel;
    (void)on_ctrl_frame;
    return ESP_ERR_NOT_SUPPORTED;
}
bool hc_espnow_is_seeking(void) { return false; }
void hc_espnow_seek_hop(void) {}
esp_err_t hc_espnow_send_keepalive(const char *mac, uint16_t epoch, uint32_t seq) {
    (void)mac;
    (void)epoch;
    (void)seq;
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t hc_espnow_send_keepalive_json(
    const char *mac,
    uint16_t epoch,
    uint32_t seq,
    const char *json
) {
    (void)mac;
    (void)epoch;
    (void)seq;
    (void)json;
    return ESP_ERR_NOT_SUPPORTED;
}
void hc_espnow_reseek(void) {}
esp_err_t hc_espnow_send_command(const char *mac, uint16_t epoch, uint32_t seq, const char *json) {
    (void)mac;
    (void)epoch;
    (void)seq;
    (void)json;
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t hc_espnow_send_ack(const uint8_t mac[6], uint16_t epoch, uint32_t seq) {
    (void)mac;
    (void)epoch;
    (void)seq;
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t hc_espnow_add_peer(const char *mac) {
    (void)mac;
    return ESP_ERR_NOT_SUPPORTED;
}
void hc_espnow_mac_to_string(const uint8_t mac[6], char *out, size_t out_len) {
    if (!out || out_len == 0) return;
    snprintf(out, out_len, "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}
bool hc_espnow_mac_from_string(const char *text, uint8_t out[6]) {
    (void)text;
    (void)out;
    return false;
}

#endif
