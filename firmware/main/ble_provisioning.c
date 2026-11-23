#include "ble_provisioning.h"
#include "ble_protocol_logic.h"
#include "homecore_config.h"
#include "recovery_console.h"
#include "recovery_logic.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "hc_ble";

#if !HOMECORE_HAS_BLE

esp_err_t hc_ble_prov_start(homecore_config_t *cfg, hc_prov_mode_t mode) {
    (void)cfg;
    (void)mode;
    return ESP_ERR_NOT_SUPPORTED;
}

void hc_ble_prov_set_mode(hc_prov_mode_t mode) {
    (void)mode;
}

void hc_ble_prov_stop_and_reclaim(void) {}
void hc_ble_prov_release_unused_at_boot(void) {}
bool hc_ble_prov_is_active(void) { return false; }
bool hc_ble_prov_is_mem_released(void) { return true; }
hc_ble_apply_kind_t hc_ble_prov_consume_pending_apply(void) { return HC_BLE_APPLY_NONE; }

void hc_ble_prov_update_status(
    const char *state_str,
    bool wifi_connected,
    bool paired,
    bool mqtt_connected,
    const char *ip_str,
    const char *error_msg
) {
    (void)state_str;
    (void)wifi_connected;
    (void)paired;
    (void)mqtt_connected;
    (void)ip_str;
    (void)error_msg;
}

void hc_ble_prov_push_raw_status(const char *json, size_t len) {
    (void)json;
    (void)len;
}

void hc_ble_prov_push_chunked_status(const char *json, size_t len) {
    (void)json;
    (void)len;
}

#else /* HOMECORE_HAS_BLE */

#include "cJSON.h"
#include "esp_bt.h"
#include "host/ble_att.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "mbedtls/ecdh.h"
#include "mbedtls/ecp.h"
#include "mbedtls/gcm.h"
#include "mbedtls/md.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/sha256.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

// Little-endian 128-bit UUIDs matching @homecoreos/shared:
// Service:     686f6d65-636f-7265-0001-000000000001
// DeviceInfo:  686f6d65-636f-7265-0002-000000000001
// Handshake:   686f6d65-636f-7265-0003-000000000001
// Command:     686f6d65-636f-7265-0004-000000000001
// Status:      686f6d65-636f-7265-0005-000000000001
static const ble_uuid128_t s_svc_uuid = BLE_UUID128_INIT(
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00,
    0x65, 0x72, 0x6f, 0x63, 0x65, 0x6d, 0x6f, 0x68
);
static const ble_uuid128_t s_chr_info_uuid = BLE_UUID128_INIT(
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00,
    0x65, 0x72, 0x6f, 0x63, 0x65, 0x6d, 0x6f, 0x68
);
static const ble_uuid128_t s_chr_hs_uuid = BLE_UUID128_INIT(
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00,
    0x65, 0x72, 0x6f, 0x63, 0x65, 0x6d, 0x6f, 0x68
);
static const ble_uuid128_t s_chr_cmd_uuid = BLE_UUID128_INIT(
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00,
    0x65, 0x72, 0x6f, 0x63, 0x65, 0x6d, 0x6f, 0x68
);
static const ble_uuid128_t s_chr_status_uuid = BLE_UUID128_INIT(
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x00,
    0x65, 0x72, 0x6f, 0x63, 0x65, 0x6d, 0x6f, 0x68
);

static homecore_config_t *s_cfg_ref = NULL;
static hc_prov_mode_t s_prov_mode = HC_PROV_MODE_UNPROVISIONED;
static bool s_ble_active = false;
static bool s_ble_mem_released = false;
static volatile bool s_host_running = false;
static uint8_t s_own_addr_type = BLE_OWN_ADDR_PUBLIC;
static uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_status_val_handle = 0;
static bool s_status_notify_enabled = false;
static char s_ble_name[24] = "HomecoreOS-0000";
static char s_mac_suffix[8] = "0000";

static hc_ble_auth_guard_t s_auth_guard;
static uint8_t s_session_key[32];
static uint8_t s_client_pub[65];
static uint8_t s_dev_pub[65];
static uint8_t s_dev_challenge[16];
static uint8_t s_hs_resp[140];
static size_t s_hs_resp_len = 0;
static bool s_hs_awaiting_cli_proof = false;
static uint64_t s_hs_started_sec = 0;

/* Fragmented GATT writes are reassembled here before the payload is decrypted
 * or the handshake is run. A browser whose negotiated ATT_MTU is 23 (the
 * default on Windows and on many Android builds) cannot send a 66-byte Client
 * Hello or a ~300-byte encrypted command in one write, and its long-write
 * attempt fails with "GATT operation failed for unknown reason". */
static hc_ble_frag_rx_t s_cmd_rx;
static hc_ble_frag_rx_t s_hs_rx;
/* Cached ciphertext of s_status_json. A read can only return ATT_MTU - 1 bytes,
 * so a long status is served as several windows; they must all describe the
 * *same* ciphertext or the AES-GCM tag would not authenticate. The cache is
 * invalidated whenever the plaintext changes. */
static uint8_t s_status_enc[512];
static size_t s_status_enc_len = 0;
static bool s_status_enc_valid = false;
/* Read cursor for the windowed responses of the INFO / HANDSHAKE / STATUS
 * characteristics. NimBLE truncates a read response to ATT_MTU - 1, so a long
 * value silently loses its tail; the browser instead reads windows and stops
 * when it has the announced length. */
static size_t s_info_rd_off = 0;
static size_t s_hs_rd_off = 0;
static size_t s_status_rd_off = 0;

static void invalidate_status_ciphertext(void);

static size_t conn_fragment_budget(void) {
    unsigned mtu = 23;
    if (s_conn_handle != BLE_HS_CONN_HANDLE_NONE) {
        mtu = ble_att_mtu(s_conn_handle);
    }
    return hc_ble_fragment_budget(mtu);
}

/**
 * Appends `value` to a read response, windowed when it does not fit in one
 * ATT packet. Each window is self-describing (`[0x20][total][offset][slice]`)
 * so the browser can concatenate windows without guessing the total length,
 * and a value that fits is returned byte-for-byte unchanged.
 */
static int append_read_window(
    struct ble_gatt_access_ctxt *ctxt,
    const uint8_t *value,
    size_t len,
    size_t *cursor
) {
    unsigned mtu = 23;
    if (s_conn_handle != BLE_HS_CONN_HANDLE_NONE) mtu = ble_att_mtu(s_conn_handle);
    const size_t budget = hc_ble_read_window_size(mtu);
    if (*cursor == 0 && len <= budget) {
        *cursor = 0;
        return os_mbuf_append(ctxt->om, value, (uint16_t)len) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (budget <= HC_BLE_FRAG_HEADER) return BLE_ATT_ERR_UNLIKELY;

    /* The window is capped well below the packet size so the buffer stays on
     * the stack: a very large negotiated MTU simply gets several windows
     * instead of one enormous one. */
#define HC_BLE_READ_WINDOW_MAX 260
    uint8_t frame[HC_BLE_FRAG_HEADER + HC_BLE_READ_WINDOW_MAX];
    size_t window = budget - HC_BLE_FRAG_HEADER;
    if (window > HC_BLE_READ_WINDOW_MAX) window = HC_BLE_READ_WINDOW_MAX;
    if (*cursor >= len) *cursor = 0;

    const size_t slice = hc_ble_frag_read_window(
        value, len, *cursor, window, frame + HC_BLE_FRAG_HEADER, HC_BLE_READ_WINDOW_MAX
    );
    if (slice <= 0) return BLE_ATT_ERR_UNLIKELY;

    frame[0] = HC_BLE_FRAG_READ_TAG;
    frame[1] = (uint8_t)(len & 0xFF);
    frame[2] = (uint8_t)((len >> 8) & 0xFF);
    frame[3] = (uint8_t)(*cursor & 0xFF);
    frame[4] = (uint8_t)((*cursor >> 8) & 0xFF);

    const size_t total = HC_BLE_FRAG_HEADER + (size_t)slice;
    *cursor = (*cursor + (size_t)slice) % (len ? len : 1);
    return os_mbuf_append(ctxt->om, frame, (uint16_t)total) == 0
        ? 0
        : BLE_ATT_ERR_INSUFFICIENT_RES;
}

/** Resets every per-connection framing cursor (called on connect/disconnect). */
static void reset_gatt_framing(void) {
    hc_ble_frag_reset(&s_cmd_rx);
    hc_ble_frag_reset(&s_hs_rx);
    invalidate_status_ciphertext();
    s_info_rd_off = 0;
    s_hs_rd_off = 0;
}

static volatile hc_ble_apply_kind_t s_pending_apply = HC_BLE_APPLY_NONE;
/* Sized for the enriched status payload (states, IP, error text plus the
 * running-image and capability mirrors); a truncation here would produce an
 * unparsable notification rather than a smaller one. */
static char s_status_json[512] = "{\"state\":\"idle\",\"wifi_connected\":false,\"paired\":false,\"mqtt_connected\":false}";

static uint64_t now_seconds(void) {
    return (uint64_t)(esp_timer_get_time() / 1000000ULL);
}

static int hc_mbedtls_rng(void *ctx, unsigned char *out, size_t len) {
    (void)ctx;
    if (out && len > 0) {
        esp_fill_random(out, len);
    }
    return 0;
}

static bool hc_const_time_eq(const uint8_t *a, const uint8_t *b, size_t len) {
    uint8_t diff = 0;
    for (size_t i = 0; i < len; i++) {
        diff |= (uint8_t)(a[i] ^ b[i]);
    }
    return diff == 0;
}

static void reset_ephemeral_crypto(void) {
    mbedtls_platform_zeroize(s_session_key, sizeof(s_session_key));
    mbedtls_platform_zeroize(s_client_pub, sizeof(s_client_pub));
    mbedtls_platform_zeroize(s_dev_pub, sizeof(s_dev_pub));
    mbedtls_platform_zeroize(s_dev_challenge, sizeof(s_dev_challenge));
    mbedtls_platform_zeroize(s_hs_resp, sizeof(s_hs_resp));
    s_hs_resp_len = 0;
    s_hs_awaiting_cli_proof = false;
    s_hs_started_sec = 0;
    invalidate_status_ciphertext();
    hc_ble_guard_reset_session(&s_auth_guard);
}

static int compute_hmac_sha256(
    const uint8_t *key,
    size_t key_len,
    const uint8_t *msg,
    size_t msg_len,
    uint8_t out32[32]
) {
    const mbedtls_md_info_t *md_info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (!md_info) return -1;
    return mbedtls_md_hmac(md_info, key, key_len, msg, msg_len, out32);
}

static int encrypt_status_payload(uint8_t *out_buf, size_t out_cap, size_t *out_len) {
    uint64_t now = now_seconds();
    if (!hc_ble_guard_is_session_valid(&s_auth_guard, now)) {
        const char *pub = hc_ble_guard_can_start_handshake(&s_auth_guard, now)
            ? "{\"state\":\"awaiting_auth\",\"wifi_connected\":false,\"paired\":false,\"mqtt_connected\":false}"
            : "{\"state\":\"locked_out\",\"wifi_connected\":false,\"paired\":false,\"mqtt_connected\":false}";
        size_t len = strlen(pub);
        if (len > out_cap) return -1;
        memcpy(out_buf, pub, len);
        *out_len = len;
        return 0;
    }

    size_t pt_len = strlen(s_status_json);
    if (12 + pt_len + 16 > out_cap) return -1;

    uint8_t iv[12];
    esp_fill_random(iv, sizeof(iv));
    memcpy(out_buf, iv, 12);

    mbedtls_gcm_context gcm;
    mbedtls_gcm_init(&gcm);
    int rc = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, s_session_key, 256);
    if (rc == 0) {
        rc = mbedtls_gcm_crypt_and_tag(
            &gcm,
            MBEDTLS_GCM_ENCRYPT,
            pt_len,
            iv,
            sizeof(iv),
            NULL,
            0,
            (const uint8_t *)s_status_json,
            out_buf + 12,
            16,
            out_buf + 12 + pt_len
        );
    }
    mbedtls_gcm_free(&gcm);
    if (rc != 0) return -1;
    *out_len = 12 + pt_len + 16;
    return 0;
}

/**
 * Sends one already-encrypted payload as a status notification.
 *
 * A notification can carry only ATT_MTU - 3 bytes and NimBLE truncates the
 * rest *silently*, so anything longer than the negotiated budget is split into
 * `{0x30, index, total}` fragments. The browser joins them before decrypting
 * (see `createBleNoteReassembler`), which means the AES-GCM tag still
 * authenticates the whole message even though it arrived in pieces.
 */
static void send_encrypted_notification(const uint8_t *payload, size_t len) {
    if (!s_ble_active || s_conn_handle == BLE_HS_CONN_HANDLE_NONE || !s_status_notify_enabled) {
        return;
    }
    if (!payload || len == 0) return;

    /* A fragment never has to be larger than one packet, and the frame buffer
     * is what bounds the stack usage: cap the budget to it so a very large
     * negotiated MTU still produces several small fragments instead of a
     * notification that is silently dropped for not fitting the buffer. */
    uint8_t frame[HC_BLE_NOTE_FRAG_HEADER + 256];
    size_t budget = conn_fragment_budget();
    if (budget > sizeof(frame)) budget = sizeof(frame);

    const size_t total = hc_ble_note_count(len, budget);

    if (total <= 1) {
        struct os_mbuf *om = ble_hs_mbuf_from_flat(payload, (uint16_t)len);
        if (om) {
            ble_gatts_notify_custom(s_conn_handle, s_status_val_handle, om);
        }
        return;
    }
    for (size_t i = 0; i < total; i++) {
        size_t n = hc_ble_note_build(frame, sizeof(frame), payload, len, i, budget);
        if (n == 0) return;
        struct os_mbuf *om = ble_hs_mbuf_from_flat(frame, (uint16_t)n);
        if (!om) return;
        if (ble_gatts_notify_custom(s_conn_handle, s_status_val_handle, om) != 0) return;
        /* One notification per connection event: the browser only has to join
         * a handful of frames and this keeps NimBLE's mbuf pool intact on the
         * boards with the least RAM. */
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

/** Encrypts the current status once and keeps it for reads and notifications. */
static bool ensure_status_ciphertext(void) {
    if (s_status_enc_valid && s_status_enc_len > 0) return true;
    size_t enc_len = 0;
    if (encrypt_status_payload(s_status_enc, sizeof(s_status_enc), &enc_len) != 0 || enc_len == 0) {
        invalidate_status_ciphertext();
        return false;
    }
    s_status_enc_len = enc_len;
    s_status_enc_valid = true;
    /* A new ciphertext means new offsets: the next read starts at window 0. */
    s_status_rd_off = 0;
    return true;
}

/** Drops the cached ciphertext and restarts the read window at offset 0. */
static void invalidate_status_ciphertext(void) {
    s_status_enc_len = 0;
    s_status_enc_valid = false;
    s_status_rd_off = 0;
}

static void push_status_notification(void) {
    if (!s_ble_active || s_conn_handle == BLE_HS_CONN_HANDLE_NONE || !s_status_notify_enabled) {
        return;
    }
    /* Must match the read path: the enriched status JSON plus the 28-byte
     * IV/tag overhead overflows a 320-byte buffer, and a notification that
     * silently fails to build leaves the browser waiting for a status that
     * never arrives. */
    if (!ensure_status_ciphertext()) return;
    send_encrypted_notification(s_status_enc, s_status_enc_len);
}

/**
 * Pushes one already-built JSON payload (protocol response from
 * recovery_console.c) as an encrypted status notification.
 */
void hc_ble_prov_push_raw_status(const char *json, size_t len) {
    if (!json || len == 0 || len + 28 > sizeof(s_status_json)) return;
    hc_copy_str(s_status_json, sizeof(s_status_json), json);
    invalidate_status_ciphertext();
    push_status_notification();
}

/**
 * Recovery responses can exceed one ATT notification once they include the full
 * diagnostics object, so they are delivered as numbered chunks inside the same
 * encrypted envelope:
 *
 *   {"chunk":{"i":0,"n":3,"d":"<encrypted payload slice>"}}
 *
 * The browser reassembles by `i` until `n` chunks arrived (bounded by
 * HC_BLE_STATUS_CHUNKS_MAX) and then parses `d` as the protocol response. A
 * lost chunk is never guessed: the console asks again with HC STATUS.
 */
#define HC_BLE_STATUS_CHUNK_RAW 150
/* The status answer now also carries the running-image and capability facts
 * (partition, uptime, heap, server URL, OTA and ESP-NOW state), so the ceiling
 * accounts for a full ~1 KB diagnostics object instead of truncating it. */
#define HC_BLE_STATUS_CHUNKS_MAX 10

void hc_ble_prov_push_chunked_status(const char *json, size_t len) {
    if (!json || len == 0) return;
    if (len <= HC_BLE_STATUS_CHUNK_RAW) {
        hc_ble_prov_push_raw_status(json, len);
        return;
    }

    const size_t chunks = (len + HC_BLE_STATUS_CHUNK_RAW - 1) / HC_BLE_STATUS_CHUNK_RAW;
    if (chunks > HC_BLE_STATUS_CHUNKS_MAX) {
        ESP_LOGW(TAG, "Recovery response too large for BLE (%u bytes)", (unsigned)len);
        return;
    }

    for (size_t i = 0; i < chunks; i++) {
        const size_t offset = i * HC_BLE_STATUS_CHUNK_RAW;
        size_t slice = len - offset;
        if (slice > HC_BLE_STATUS_CHUNK_RAW) slice = HC_BLE_STATUS_CHUNK_RAW;

        char payload[HC_BLE_STATUS_CHUNK_RAW + 1];
        memcpy(payload, json + offset, slice);
        payload[slice] = '\0';

        char *escaped = calloc(1, HC_BLE_STATUS_CHUNK_RAW * 2 + 1);
        if (!escaped) return;
        if (hc_rec_escape_json(payload, escaped, HC_BLE_STATUS_CHUNK_RAW * 2 + 1) < 0) {
            free(escaped);
            return;
        }
        char envelope[sizeof(s_status_json)];
        int n = snprintf(
            envelope,
            sizeof(envelope),
            "{\"chunk\":{\"i\":%u,\"n\":%u,\"d\":\"%s\"}}",
            (unsigned)i,
            (unsigned)chunks,
            escaped
        );
        free(escaped);
        if (n <= 0 || (size_t)n >= sizeof(envelope)) return;
        hc_copy_str(s_status_json, sizeof(s_status_json), envelope);
        push_status_notification();
        /* One notification per connection event keeps the NimBLE host from
         * overflowing its mbuf pool on boards with little RAM. */
        vTaskDelay(pdMS_TO_TICKS(60));
    }
}

void hc_ble_prov_update_status(
    const char *state_str,
    bool wifi_connected,
    bool paired,
    bool mqtt_connected,
    const char *ip_str,
    const char *error_msg
) {
    cJSON *root = cJSON_CreateObject();
    if (!root) return;
    cJSON_AddStringToObject(root, "state", state_str ? state_str : "idle");
    cJSON_AddBoolToObject(root, "wifi_connected", wifi_connected);
    cJSON_AddBoolToObject(root, "paired", paired);
    cJSON_AddBoolToObject(root, "mqtt_connected", mqtt_connected);
    if (ip_str && ip_str[0] != '\0') {
        cJSON_AddStringToObject(root, "ip", ip_str);
    }
    if (error_msg && error_msg[0] != '\0') {
        cJSON_AddStringToObject(root, "error", error_msg);
    }
    /* Mirror the running-image and capability facts the recovery console
     * reports, so a browser that switched from provisioning to recovery (or
     * simply stayed connected) sees the same truth on both channels. These are
     * non-secret: no password, identity key or setup PIN is ever added here. */
    hc_recovery_snapshot_t snap;
    hc_recovery_get_snapshot(&snap);
    if (snap.partition[0]) cJSON_AddStringToObject(root, "partition", snap.partition);
    if (snap.board_slug[0]) cJSON_AddStringToObject(root, "board", snap.board_slug);
    if (snap.chip[0]) cJSON_AddStringToObject(root, "chip", snap.chip);
    if (snap.fw_version[0]) cJSON_AddStringToObject(root, "fw", snap.fw_version);
    cJSON_AddNumberToObject(root, "uptime_sec", snap.uptime_sec);
    cJSON_AddBoolToObject(root, "ota_supported", snap.ota_supported);
    cJSON_AddBoolToObject(root, "ota_pending", snap.ota_pending);
    cJSON_AddBoolToObject(root, "has_wifi", HOMECORE_HAS_WIFI ? true : false);
    cJSON_AddBoolToObject(root, "has_ble", HOMECORE_HAS_BLE ? true : false);
    cJSON_AddBoolToObject(root, "espnow_supported", snap.espnow_supported);
    if (snap.espnow_link[0]) cJSON_AddStringToObject(root, "espnow_link", snap.espnow_link);
    if (snap.backend_url[0]) cJSON_AddStringToObject(root, "backend_url", snap.backend_url);
    char *printed = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (printed) {
        hc_copy_str(s_status_json, sizeof(s_status_json), printed);
        cJSON_free(printed);
        invalidate_status_ciphertext();
        push_status_notification();
    }
}

static int handle_handshake_write(const uint8_t *buf, uint16_t len) {
    uint64_t now = now_seconds();
    if (!buf || len < 1) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;

    if (!hc_ble_guard_can_start_handshake(&s_auth_guard, now)) {
        reset_ephemeral_crypto();
        s_hs_resp[0] = 0x04;
        s_hs_resp[1] = 0x02;
        s_hs_resp[2] = 0;
        s_hs_resp_len = 3;
        return 0;
    }

    uint8_t msg_type = buf[0];
    if (msg_type == 0x01) {
        // Client Hello: [0x01][client_pub (65B uncompressed P-256)]
        if (len != 66 || buf[1] != 0x04) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        reset_ephemeral_crypto();
        memcpy(s_client_pub, buf + 1, 65);

        mbedtls_ecp_group grp;
        mbedtls_mpi d, z;
        mbedtls_ecp_point Q, Qp;
        mbedtls_ecp_group_init(&grp);
        mbedtls_mpi_init(&d);
        mbedtls_mpi_init(&z);
        mbedtls_ecp_point_init(&Q);
        mbedtls_ecp_point_init(&Qp);

        uint8_t shared[32] = {0};
        uint8_t pop_hash[32] = {0};
        uint8_t session_nonce[16] = {0};
        size_t olen = 0;
        int rc = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256R1);
        if (rc == 0) rc = mbedtls_ecp_gen_keypair(&grp, &d, &Q, hc_mbedtls_rng, NULL);
        if (rc == 0) {
            rc = mbedtls_ecp_point_write_binary(
                &grp, &Q, MBEDTLS_ECP_PF_UNCOMPRESSED, &olen, s_dev_pub, sizeof(s_dev_pub)
            );
            if (rc == 0 && olen != 65) rc = -1;
        }
        if (rc == 0) rc = mbedtls_ecp_point_read_binary(&grp, &Qp, s_client_pub, 65);
        if (rc == 0) rc = mbedtls_ecp_check_pubkey(&grp, &Qp);
        if (rc == 0) rc = mbedtls_ecdh_compute_shared(&grp, &z, &Qp, &d, hc_mbedtls_rng, NULL);
        if (rc == 0) rc = mbedtls_mpi_write_binary(&z, shared, sizeof(shared));

        mbedtls_ecp_group_free(&grp);
        mbedtls_mpi_free(&d);
        mbedtls_mpi_free(&z);
        mbedtls_ecp_point_free(&Q);
        mbedtls_ecp_point_free(&Qp);

        if (rc != 0) {
            mbedtls_platform_zeroize(shared, sizeof(shared));
            reset_ephemeral_crypto();
            return BLE_ATT_ERR_UNLIKELY;
        }

        esp_fill_random(session_nonce, sizeof(session_nonce));
        esp_fill_random(s_dev_challenge, sizeof(s_dev_challenge));

        static const char default_pop[] = "HOMECORE-S1-POP-V1";
        mbedtls_sha256(
            (const uint8_t *)default_pop,
            strlen(default_pop),
            pop_hash,
            0
        );

        // session_key = SHA256("HomecoreOS-BLE-S1" || shared || session_nonce || pop_hash)
        static const char kdf_label[] = "HomecoreOS-BLE-S1";
        uint8_t kdf_in[17 + 32 + 16 + 32];
        memcpy(kdf_in, kdf_label, 17);
        memcpy(kdf_in + 17, shared, 32);
        memcpy(kdf_in + 49, session_nonce, 16);
        memcpy(kdf_in + 65, pop_hash, 32);
        mbedtls_sha256(kdf_in, sizeof(kdf_in), s_session_key, 0);

        mbedtls_platform_zeroize(shared, sizeof(shared));
        mbedtls_platform_zeroize(pop_hash, sizeof(pop_hash));
        mbedtls_platform_zeroize(kdf_in, sizeof(kdf_in));

        // dev_proof = HMAC-SHA256(session_key, "dev-proof" || client_pub || dev_pub || session_nonce)
        static const char dev_lbl[] = "dev-proof";
        uint8_t proof_in[9 + 65 + 65 + 16];
        uint8_t dev_proof[32] = {0};
        memcpy(proof_in, dev_lbl, 9);
        memcpy(proof_in + 9, s_client_pub, 65);
        memcpy(proof_in + 74, s_dev_pub, 65);
        memcpy(proof_in + 139, session_nonce, 16);
        rc = compute_hmac_sha256(s_session_key, 32, proof_in, sizeof(proof_in), dev_proof);
        mbedtls_platform_zeroize(proof_in, sizeof(proof_in));
        if (rc != 0) {
            reset_ephemeral_crypto();
            return BLE_ATT_ERR_UNLIKELY;
        }

        // Device Hello response: [0x02][dev_pub(65)][session_nonce(16)][dev_challenge(16)][dev_proof(32)] = 130B
        s_hs_resp[0] = 0x02;
        memcpy(s_hs_resp + 1, s_dev_pub, 65);
        memcpy(s_hs_resp + 66, session_nonce, 16);
        memcpy(s_hs_resp + 82, s_dev_challenge, 16);
        memcpy(s_hs_resp + 98, dev_proof, 32);
        s_hs_resp_len = 130;
        s_hs_awaiting_cli_proof = true;
        s_hs_started_sec = now;
        return 0;
    }

    if (msg_type == 0x03) {
        // Client Proof: [0x03][client_proof (32B)]
        if (len != 33) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        if (!s_hs_awaiting_cli_proof || (now - s_hs_started_sec) > HC_PROV_BLE_SESSION_TTL_SEC) {
            hc_ble_guard_record_failure(&s_auth_guard, now);
            reset_ephemeral_crypto();
            s_hs_resp[0] = 0x04;
            s_hs_resp[1] = 0x00;
            s_hs_resp[2] = hc_ble_guard_attempts_remaining(&s_auth_guard);
            s_hs_resp_len = 3;
            return 0;
        }

        // expected = HMAC-SHA256(session_key, "cli-proof" || dev_pub || client_pub || dev_challenge)
        static const char cli_lbl[] = "cli-proof";
        uint8_t proof_in[9 + 65 + 65 + 16];
        uint8_t expected[32] = {0};
        memcpy(proof_in, cli_lbl, 9);
        memcpy(proof_in + 9, s_dev_pub, 65);
        memcpy(proof_in + 74, s_client_pub, 65);
        memcpy(proof_in + 139, s_dev_challenge, 16);
        int rc = compute_hmac_sha256(s_session_key, 32, proof_in, sizeof(proof_in), expected);
        mbedtls_platform_zeroize(proof_in, sizeof(proof_in));

        const bool ok = (rc == 0) && hc_const_time_eq(buf + 1, expected, 32);
        mbedtls_platform_zeroize(expected, sizeof(expected));
        s_hs_awaiting_cli_proof = false;

        if (ok) {
            hc_ble_guard_record_success(&s_auth_guard, now);
            s_hs_resp[0] = 0x04;
            s_hs_resp[1] = 0x01;
            s_hs_resp[2] = HC_PROV_BLE_MAX_AUTH_ATTEMPTS;
            s_hs_resp_len = 3;
            ESP_LOGI(TAG, "Security 1 BLE session authenticated");
        } else {
            hc_ble_guard_record_failure(&s_auth_guard, now);
            mbedtls_platform_zeroize(s_session_key, sizeof(s_session_key));
            s_hs_resp[0] = 0x04;
            s_hs_resp[1] = 0x00;
            s_hs_resp[2] = hc_ble_guard_attempts_remaining(&s_auth_guard);
            s_hs_resp_len = 3;
            ESP_LOGW(TAG, "BLE PoP verification failed (remaining=%u)", s_hs_resp[2]);
        }
        return 0;
    }

    return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
}

static int handle_command_write(const uint8_t *buf, uint16_t len) {
    uint64_t now = now_seconds();
    if (!hc_ble_guard_is_session_valid(&s_auth_guard, now)) {
        ESP_LOGW(TAG, "Rejected unauthenticated/expired BLE provisioning command");
        return BLE_ATT_ERR_INSUFFICIENT_AUTHEN;
    }
    if (!buf || len <= 28 || len > 512) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    size_t ct_len = len - 28;
    const uint8_t *iv = buf;
    const uint8_t *ct = buf + 12;
    const uint8_t *tag = buf + 12 + ct_len;

    uint8_t *pt = calloc(1, ct_len + 1);
    if (!pt) return BLE_ATT_ERR_INSUFFICIENT_RES;

    mbedtls_gcm_context gcm;
    mbedtls_gcm_init(&gcm);
    int rc = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, s_session_key, 256);
    if (rc == 0) {
        rc = mbedtls_gcm_auth_decrypt(&gcm, ct_len, iv, 12, NULL, 0, tag, 16, ct, pt);
    }
    mbedtls_gcm_free(&gcm);

    if (rc != 0) {
        mbedtls_platform_zeroize(pt, ct_len + 1);
        free(pt);
        ESP_LOGW(TAG, "Rejected BLE command with invalid AES-GCM authentication tag");
        return BLE_ATT_ERR_INSUFFICIENT_AUTHEN;
    }

    pt[ct_len] = '\0';
    cJSON *root = cJSON_Parse((const char *)pt);
    mbedtls_platform_zeroize(pt, ct_len + 1);
    free(pt);

    if (!root || !s_cfg_ref) {
        cJSON_Delete(root);
        return BLE_ATT_ERR_UNLIKELY;
    }

    cJSON *act_j = cJSON_GetObjectItem(root, "action");

    // Unified recovery protocol over the same encrypted channel. The BLE
    // transport answers exactly what USB and the Wi-Fi portal answer, because
    // every command body is relayed to recovery_console.c.
    if (cJSON_IsString(act_j) && act_j->valuestring &&
        strncmp(act_j->valuestring, "hc ", 3) == 0) {
        char line[HC_RECOVERY_LINE_MAX + 8];
        /* Strip the encrypted relay envelope; console parser expects HC ... */
        hc_copy_str(line, sizeof(line), act_j->valuestring + 3);
        cJSON_Delete(root);
        char response[HC_RECOVERY_RESPONSE_MAX];
        int written = hc_recovery_handle_line(line, response, sizeof(response));
        mbedtls_platform_zeroize(line, sizeof(line));
        if (written <= 0) return BLE_ATT_ERR_UNLIKELY;
        hc_ble_prov_push_chunked_status(response, (size_t)written);
        return 0;
    }

    cJSON *ssid_j = cJSON_GetObjectItem(root, "ssid");
    cJSON *pass_j = cJSON_GetObjectItem(root, "password");
    cJSON *backend_j = cJSON_GetObjectItem(root, "backend_url");
    cJSON *code_j = cJSON_GetObjectItem(root, "pair_code");
    cJSON *phys_j = cJSON_GetObjectItem(root, "physical_confirm");

    const char *action = (cJSON_IsString(act_j) && act_j->valuestring) ? act_j->valuestring : "provision_wifi";
    const bool is_wifi_only = (strcmp(action, "wifi_only") == 0);
    const bool is_recover = (strcmp(action, "recover") == 0);
    const bool is_pair_only = (strcmp(action, "pair") == 0);

    if (is_recover) {
        const bool phys_ok = (s_prov_mode == HC_PROV_MODE_RECOVERY) ||
            s_cfg_ref->physical_confirmed ||
            (cJSON_IsBool(phys_j) && cJSON_IsTrue(phys_j));
        if (!phys_ok) {
            cJSON_Delete(root);
            hc_ble_prov_update_status("error", hc_wifi_is_connected(), s_cfg_ref->paired, hc_mqtt_is_connected(), NULL, "Physical recovery confirmation required");
            return BLE_ATT_ERR_INSUFFICIENT_AUTHEN;
        }
    }

    bool wifi_updated = false;
    if (cJSON_IsString(ssid_j) && ssid_j->valuestring && strlen(ssid_j->valuestring) > 0) {
        bool ssid_changed = (strcmp(s_cfg_ref->wifi_ssid, ssid_j->valuestring) != 0);
        hc_copy_str(s_cfg_ref->wifi_ssid, sizeof(s_cfg_ref->wifi_ssid), ssid_j->valuestring);
        if (cJSON_IsString(pass_j) && pass_j->valuestring) {
            if (strlen(pass_j->valuestring) > 0 || ssid_changed) {
                hc_copy_str(s_cfg_ref->wifi_pass, sizeof(s_cfg_ref->wifi_pass), pass_j->valuestring);
            }
            mbedtls_platform_zeroize(pass_j->valuestring, strlen(pass_j->valuestring));
        }
        wifi_updated = true;
    }

    if (cJSON_IsString(backend_j) && backend_j->valuestring && strlen(backend_j->valuestring) > 0) {
        hc_copy_str(s_cfg_ref->backend_url, sizeof(s_cfg_ref->backend_url), backend_j->valuestring);
    }

    hc_copy_str(s_cfg_ref->prov_transport, sizeof(s_cfg_ref->prov_transport), "ble");

    if (!is_wifi_only && cJSON_IsString(code_j) && code_j->valuestring && strlen(code_j->valuestring) == 6) {
        hc_copy_str(s_cfg_ref->pending_pair_code, sizeof(s_cfg_ref->pending_pair_code), code_j->valuestring);
        s_cfg_ref->paired = false;
        s_cfg_ref->recovery_mode = is_recover;
        if (is_recover) {
            s_cfg_ref->physical_confirmed = true;
            if (strlen(s_cfg_ref->confirm_method) == 0) {
                hc_copy_str(s_cfg_ref->confirm_method, sizeof(s_cfg_ref->confirm_method), "ble_recovery");
            }
        }
        s_pending_apply = (is_pair_only || !HOMECORE_HAS_WIFI || !wifi_updated)
            ? HC_BLE_APPLY_PAIR_ONLY
            : HC_BLE_APPLY_WIFI_AND_PAIR;
    } else if (is_wifi_only && wifi_updated) {
        s_pending_apply = HC_BLE_APPLY_WIFI_ONLY;
    } else if (wifi_updated) {
        s_pending_apply = HC_BLE_APPLY_WIFI_ONLY;
    }

    cJSON_Delete(root);
    hc_nvs_save_config(s_cfg_ref);

    hc_ble_prov_update_status(
        (s_pending_apply == HC_BLE_APPLY_PAIR_ONLY) ? "pairing" : "connecting_wifi",
        hc_wifi_is_connected(),
        s_cfg_ref->paired,
        hc_mqtt_is_connected(),
        NULL,
        NULL
    );
    return 0;
}

static int gatt_chr_access_cb(
    uint16_t conn_handle,
    uint16_t attr_handle,
    struct ble_gatt_access_ctxt *ctxt,
    void *arg
) {
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ble_uuid_cmp(ctxt->chr->uuid, &s_chr_info_uuid.u) == 0) {
        if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) return BLE_ATT_ERR_WRITE_NOT_PERMITTED;

        // Public non-sensitive capability & board summary only (NEVER expose identity_key or setup_pin!)
        cJSON *info = cJSON_CreateObject();
        if (!info) return BLE_ATT_ERR_INSUFFICIENT_RES;
        cJSON_AddStringToObject(info, "board", HOMECORE_BOARD_SLUG);
        cJSON_AddStringToObject(info, "chip", CONFIG_IDF_TARGET);
        cJSON_AddStringToObject(info, "fw", hc_get_runtime_fw_version());
        cJSON_AddStringToObject(
            info,
            "mode",
            s_prov_mode == HC_PROV_MODE_RECOVERY ? "recovery" : "unprovisioned"
        );
        cJSON_AddBoolToObject(info, "wifi", HOMECORE_HAS_WIFI ? true : false);
        cJSON_AddBoolToObject(info, "ble_wifi", HOMECORE_HAS_BLE_WIFI_PROVISIONING ? true : false);
        cJSON_AddBoolToObject(info, "paired", s_cfg_ref ? s_cfg_ref->paired : false);
        cJSON_AddStringToObject(info, "mac_suffix", s_mac_suffix);
        cJSON_AddNumberToObject(info, "proto", 1);
        cJSON_AddStringToObject(info, "s1_mode", "auto");
        /* Advisory: the browser cannot raise the ATT MTU, but it can size its
         * GATT writes for a link that negotiated more than the 23-byte
         * default. The firmware never assumes the value it sees here. */
        cJSON_AddNumberToObject(info, "att_mtu", ble_att_mtu(s_conn_handle));
        char *str = cJSON_PrintUnformatted(info);
        cJSON_Delete(info);
        if (!str) return BLE_ATT_ERR_INSUFFICIENT_RES;
        /* The info payload grows with every capability we report, so it is
         * windowed too: a truncated read is a JSON parse error in the browser. */
        int rc = append_read_window(
            ctxt, (const uint8_t *)str, strlen(str), &s_info_rd_off
        );
        cJSON_free(str);
        return rc;
    }

    if (ble_uuid_cmp(ctxt->chr->uuid, &s_chr_hs_uuid.u) == 0) {
        if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
            uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
            if (len > 256) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
            uint8_t buf[256];
            uint16_t out_len = 0;
            if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &out_len) != 0) {
                return BLE_ATT_ERR_UNLIKELY;
            }

            /* Small MTU: the browser sends [0x10][total][offset][slice] pieces of
             * the 66-byte Client Hello / 33-byte Client Proof. */
            if (hc_ble_frag_is_fragment(buf, out_len)) {
                const uint8_t *whole = NULL;
                size_t whole_len = 0;
                int rc = hc_ble_frag_accept(&s_hs_rx, buf, out_len, &whole, &whole_len);
                if (rc < 0) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
                if (rc == 0) return 0; /* more fragments needed: a silent success */
                s_hs_rd_off = 0;
                return handle_handshake_write(whole, (uint16_t)whole_len);
            }

            hc_ble_frag_reset(&s_hs_rx);
            s_hs_rd_off = 0;
            return handle_handshake_write(buf, out_len);
        }
        if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
            if (s_hs_resp_len == 0) {
                uint8_t idle[3] = {0x00, 0x00, hc_ble_guard_attempts_remaining(&s_auth_guard)};
                return os_mbuf_append(ctxt->om, idle, sizeof(idle)) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
            }
            /* The Device Hello is 130 bytes. At MTU 23 a single read returns 22
             * of them and the browser would derive the session key from a
             * truncated packet, so the value is served in windows. */
            return append_read_window(ctxt, s_hs_resp, s_hs_resp_len, &s_hs_rd_off);
        }
        return BLE_ATT_ERR_UNLIKELY;
    }

    if (ble_uuid_cmp(ctxt->chr->uuid, &s_chr_cmd_uuid.u) == 0) {
        if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_READ_NOT_PERMITTED;
        uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
        if (len > 256) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        uint8_t *buf = calloc(1, len + 1);
        if (!buf) return BLE_ATT_ERR_INSUFFICIENT_RES;
        uint16_t out_len = 0;
        int flat_rc = ble_hs_mbuf_to_flat(ctxt->om, buf, len, &out_len);
        int rc = BLE_ATT_ERR_UNLIKELY;
        if (flat_rc == 0) {
            if (hc_ble_frag_is_fragment(buf, out_len)) {
                /* An encrypted command is 28 + JSON bytes; at MTU 23 that is a
                 * dozen writes that the browser would otherwise have to send as
                 * a long write, which Chrome on Windows refuses. */
                const uint8_t *whole = NULL;
                size_t whole_len = 0;
                int frag_rc = hc_ble_frag_accept(&s_cmd_rx, buf, out_len, &whole, &whole_len);
                if (frag_rc < 0) {
                    rc = BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
                } else if (frag_rc == 0) {
                    rc = 0;
                } else {
                    rc = handle_command_write(whole, (uint16_t)whole_len);
                    /* The plaintext is wiped inside handle_command_write; the
                     * reassembled ciphertext is not needed any more either. */
                    mbedtls_platform_zeroize(s_cmd_rx.buf, sizeof(s_cmd_rx.buf));
                }
            } else {
                hc_ble_frag_reset(&s_cmd_rx);
                rc = handle_command_write(buf, out_len);
            }
        }
        mbedtls_platform_zeroize(buf, len + 1);
        free(buf);
        return rc;
    }

    if (ble_uuid_cmp(ctxt->chr->uuid, &s_chr_status_uuid.u) == 0) {
        if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
        if (!ensure_status_ciphertext()) return BLE_ATT_ERR_UNLIKELY;
        return append_read_window(ctxt, s_status_enc, s_status_enc_len, &s_status_rd_off);
    }

    return BLE_ATT_ERR_UNLIKELY;
}

static const struct ble_gatt_svc_def s_gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &s_svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid = &s_chr_info_uuid.u,
                .access_cb = gatt_chr_access_cb,
                .flags = BLE_GATT_CHR_F_READ,
            },
            {
                .uuid = &s_chr_hs_uuid.u,
                .access_cb = gatt_chr_access_cb,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE,
            },
            {
                .uuid = &s_chr_cmd_uuid.u,
                .access_cb = gatt_chr_access_cb,
                .flags = BLE_GATT_CHR_F_WRITE,
            },
            {
                .uuid = &s_chr_status_uuid.u,
                .access_cb = gatt_chr_access_cb,
                .val_handle = &s_status_val_handle,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
            },
            {0},
        },
    },
    {0},
};

static void ble_prov_advertise(void);

static int ble_gap_event_cb(struct ble_gap_event *event, void *arg) {
    (void)arg;
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            if (event->connect.status == 0) {
                s_conn_handle = event->connect.conn_handle;
                s_status_notify_enabled = false;
                reset_ephemeral_crypto();
                reset_gatt_framing();
                ESP_LOGI(TAG, "BLE client connected (handle=%u)", s_conn_handle);
            } else if (s_ble_active) {
                ble_prov_advertise();
            }
            return 0;

        case BLE_GAP_EVENT_DISCONNECT:
            ESP_LOGI(TAG, "BLE client disconnected (reason=%d)", event->disconnect.reason);
            s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            s_status_notify_enabled = false;
            reset_ephemeral_crypto();
            reset_gatt_framing();
            if (s_ble_active) {
                ble_prov_advertise();
            }
            return 0;

        case BLE_GAP_EVENT_SUBSCRIBE:
            if (event->subscribe.attr_handle == s_status_val_handle) {
                s_status_notify_enabled = event->subscribe.cur_notify != 0;
            }
            return 0;

        case BLE_GAP_EVENT_MTU:
            /* The write/read window is sized from this value, and the browser
             * needs to know it to pick its own fragment size. */
            s_info_rd_off = 0;
            s_hs_rd_off = 0;
            s_status_rd_off = 0;
            ESP_LOGI(
                TAG,
                "BLE ATT MTU negotiated: %u (fragment budget=%u)",
                (unsigned)event->mtu.value,
                (unsigned)hc_ble_fragment_budget(event->mtu.value)
            );
            return 0;

        case BLE_GAP_EVENT_ADV_COMPLETE:
            if (s_ble_active && s_conn_handle == BLE_HS_CONN_HANDLE_NONE) {
                ble_prov_advertise();
            }
            return 0;

        default:
            return 0;
    }
}

static void ble_prov_advertise(void) {
    if (!s_ble_active) return;

    struct ble_hs_adv_fields fields;
    memset(&fields, 0, sizeof(fields));
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.uuids128 = (ble_uuid128_t *)&s_svc_uuid;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;
    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGW(TAG, "ble_gap_adv_set_fields rc=%d", rc);
    }

    struct ble_hs_adv_fields rsp;
    memset(&rsp, 0, sizeof(rsp));
    rsp.name = (uint8_t *)s_ble_name;
    rsp.name_len = (uint8_t)strlen(s_ble_name);
    rsp.name_is_complete = 1;
    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        ESP_LOGW(TAG, "ble_gap_adv_rsp_set_fields rc=%d", rc);
    }

    struct ble_gap_adv_params adv_params;
    memset(&adv_params, 0, sizeof(adv_params));
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    adv_params.itvl_min = 0x00A0; // 100 ms
    adv_params.itvl_max = 0x0140; // 200 ms
    ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &adv_params, ble_gap_event_cb, NULL);
}

static void ble_on_sync(void) {
    if (!s_ble_active) return;
    int rc = ble_hs_id_infer_auto(0, &s_own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_hs_id_infer_auto failed rc=%d", rc);
        return;
    }
    ble_svc_gap_device_name_set(s_ble_name);
    ble_prov_advertise();
    ESP_LOGW(
        TAG,
        "[HC_SETUP] BOARD=%s BLE_NAME=%s S1_MODE=auto MODE=%s",
        HOMECORE_BOARD_SLUG,
        s_ble_name,
        s_prov_mode == HC_PROV_MODE_RECOVERY ? "recovery" : "unprovisioned"
    );
}

static void ble_on_reset(int reason) {
    ESP_LOGW(TAG, "NimBLE reset (reason=%d)", reason);
}

static void ble_host_task(void *param) {
    (void)param;
    nimble_port_run();
    s_host_running = false;
    nimble_port_freertos_deinit();
}

esp_err_t hc_ble_prov_start(homecore_config_t *cfg, hc_prov_mode_t mode) {
    s_cfg_ref = cfg;
    s_prov_mode = mode;

    if (s_ble_mem_released) {
        ESP_LOGW(TAG, "BT memory was released for NORMAL mode; restart required to re-init BLE");
        return ESP_ERR_INVALID_STATE;
    }
    if (s_ble_active) {
        return ESP_OK;
    }

    if (cfg) {
        hc_nvs_ensure_setup_pin(cfg);
    }
    hc_ble_guard_init(&s_auth_guard);
    reset_ephemeral_crypto();
    s_pending_apply = HC_BLE_APPLY_NONE;

    uint8_t mac[6] = {0};
    if (esp_read_mac(mac, ESP_MAC_BT) != ESP_OK) {
        esp_read_mac(mac, ESP_MAC_WIFI_STA);
    }
    snprintf(s_mac_suffix, sizeof(s_mac_suffix), "%02X%02X", mac[4], mac[5]);
    snprintf(s_ble_name, sizeof(s_ble_name), "HomecoreOS-%s", s_mac_suffix);

    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init failed: %s", esp_err_to_name(err));
        return err;
    }

    ble_hs_cfg.sync_cb = ble_on_sync;
    ble_hs_cfg.reset_cb = ble_on_reset;
    ble_att_set_preferred_mtu(256);

    ble_svc_gap_init();
    ble_svc_gatt_init();
    if (ble_gatts_count_cfg(s_gatt_svcs) != 0 || ble_gatts_add_svcs(s_gatt_svcs) != 0) {
        ESP_LOGE(TAG, "Failed to register HomecoreOS BLE GATT provisioning service");
        nimble_port_deinit();
        return ESP_FAIL;
    }

    s_ble_active = true;
    s_host_running = true;
    nimble_port_freertos_init(ble_host_task);
    return ESP_OK;
}

void hc_ble_prov_set_mode(hc_prov_mode_t mode) {
    s_prov_mode = mode;
}

void hc_ble_prov_stop_and_reclaim(void) {
    if (s_ble_active) {
        s_ble_active = false;
        if (s_conn_handle != BLE_HS_CONN_HANDLE_NONE) {
            ble_gap_terminate(s_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
            vTaskDelay(pdMS_TO_TICKS(150));
            s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        }
        ble_gap_adv_stop();
        reset_ephemeral_crypto();

        int stop_rc = nimble_port_stop();
        if (stop_rc == 0) {
            for (int i = 0; i < 40 && s_host_running; i++) {
                vTaskDelay(pdMS_TO_TICKS(50));
            }
            vTaskDelay(pdMS_TO_TICKS(60));
            nimble_port_deinit();
        }
    }

    if (!s_ble_mem_released) {
        esp_err_t rel_err = esp_bt_mem_release(ESP_BT_MODE_BLE);
        if (rel_err == ESP_OK || rel_err == ESP_ERR_INVALID_STATE) {
            s_ble_mem_released = true;
        }
        ESP_LOGI(
            TAG,
            "BLE deinitialized & BT memory reclaimed (err=%s free_heap=%lu)",
            esp_err_to_name(rel_err),
            (unsigned long)esp_get_free_heap_size()
        );
    }
}

void hc_ble_prov_release_unused_at_boot(void) {
    if (s_ble_active || s_ble_mem_released) return;
    esp_err_t rel_err = esp_bt_mem_release(ESP_BT_MODE_BLE);
    if (rel_err == ESP_OK || rel_err == ESP_ERR_INVALID_STATE) {
        s_ble_mem_released = true;
    }
    ESP_LOGI(
        TAG,
        "NORMAL boot: BLE skipped & BT controller memory released (free_heap=%lu)",
        (unsigned long)esp_get_free_heap_size()
    );
}

bool hc_ble_prov_is_active(void) {
    return s_ble_active;
}

bool hc_ble_prov_is_mem_released(void) {
    return s_ble_mem_released;
}

hc_ble_apply_kind_t hc_ble_prov_consume_pending_apply(void) {
    hc_ble_apply_kind_t kind = s_pending_apply;
    s_pending_apply = HC_BLE_APPLY_NONE;
    return kind;
}

#endif /* HOMECORE_HAS_BLE */
