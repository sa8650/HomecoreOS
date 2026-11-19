#pragma once

/**
 * ESP-NOW transport for the unified Controller / Node firmware.
 *
 * Responsibilities (transport only — every decision lives in role_logic.c):
 *   Controller : host peers (accept Node keepalives, answer them, relay
 *                instructions to a named Node).
 *   Node       : seek its assigned Controller (optionally hopping channels),
 *                send keepalives, receive instructions.
 *
 * ESP-NOW rides on the Wi-Fi radio, so this module is compiled only for targets
 * with Wi-Fi (HOMECORE_HAS_WIFI).
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define HC_ESPNOW_MAGIC0 'H'
#define HC_ESPNOW_MAGIC1 'C'
#define HC_ESPNOW_VERSION 1

/** Frames carry at most this much JSON (ESP-NOW's hard limit is 250 bytes). */
#define HC_ESPNOW_MAX_PAYLOAD 200
#define HC_ESPNOW_MAX_NODES 32

typedef enum {
    HC_ESPNOW_FRAME_NODE_KEEPALIVE = 1, /* Node -> Controller */
    HC_ESPNOW_FRAME_CONTROLLER_ACK = 2, /* Controller -> Node */
    HC_ESPNOW_FRAME_COMMAND = 3,        /* either direction, JSON payload */
} hc_espnow_frame_type_t;

typedef struct __attribute__((packed)) {
    uint8_t magic0;
    uint8_t magic1;
    uint8_t version;
    uint8_t type;
    uint16_t epoch;
    uint32_t seq;
    uint16_t payload_len;
} hc_espnow_header_t;

typedef struct {
    uint8_t mac[6];
    hc_espnow_frame_type_t type;
    uint16_t epoch;
    uint32_t seq;
    int8_t rssi;
    uint16_t payload_len;
    char payload[HC_ESPNOW_MAX_PAYLOAD + 1];
} hc_espnow_rx_t;

typedef void (*hc_espnow_rx_fn)(const hc_espnow_rx_t *frame);

/** One-time radio init. Safe to call twice. */
esp_err_t hc_espnow_init(void);
bool hc_espnow_is_ready(void);

/**
 * Pins the ESP-NOW channel. `0` keeps the current STA channel (the normal case:
 * a Controller follows the channel of the router it is associated with).
 */
esp_err_t hc_espnow_set_channel(uint8_t channel);
uint8_t hc_espnow_get_channel(void);

/** Controller: register the Node frame handler and start hosting peers. */
esp_err_t hc_espnow_host_start(hc_espnow_rx_fn on_node_frame);

/** Node: register the Controller frame handler and (re)target the Controller. */
esp_err_t hc_espnow_seek_start(const char *controller_mac, uint8_t channel, hc_espnow_rx_fn on_ctrl_frame);

/** Advances the Node's channel search by one hop (no-op unless searching). */
void hc_espnow_seek_hop(void);
bool hc_espnow_is_seeking(void);

/** Sends a keepalive to `mac` (used by the Node every heartbeat interval). */
esp_err_t hc_espnow_send_keepalive(const char *mac, uint16_t epoch, uint32_t seq);

/** Sends a JSON command to `mac`; fails when the payload exceeds the frame. */
esp_err_t hc_espnow_send_command(
    const char *mac,
    uint16_t epoch,
    uint32_t seq,
    const char *json
);

/** Answers a Node keepalive so it knows the Controller is alive. */
esp_err_t hc_espnow_send_ack(const uint8_t mac[6], uint16_t epoch, uint32_t seq);

/** Adds/refreshes a peer (Controller side). */
esp_err_t hc_espnow_add_peer(const char *mac);

void hc_espnow_mac_to_string(const uint8_t mac[6], char *out, size_t out_len);
bool hc_espnow_mac_from_string(const char *text, uint8_t out[6]);

#ifdef __cplusplus
}
#endif
