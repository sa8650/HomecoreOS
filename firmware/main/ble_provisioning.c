#include "ble_provisioning.h"
#include "homecore_config.h"

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

static volatile hc_ble_apply_kind_t s_pending_apply = HC_BLE_APPLY_NONE;
static char s_status_json[256] = "{\"state\":\"idle\",\"wifi_connected\":false,\"paired\":false,\"mqtt_connected\":false}";

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

static void push_status_notification(void) {
    if (!s_ble_active || s_conn_handle == BLE_HS_CONN_HANDLE_NONE || !s_status_notify_enabled) {
        return;
    }
    uint8_t enc_buf[320];
    size_t enc_len = 0;
    if (encrypt_status_payload(enc_buf, sizeof(enc_buf), &enc_len) != 0 || enc_len == 0) {
        return;
    }
    struct os_mbuf *om = ble_hs_mbuf_from_flat(enc_buf, (uint16_t)enc_len);
    if (om) {
        ble_gatts_notify_custom(s_conn_handle, s_status_val_handle, om);
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
    char *printed = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (printed) {
        hc_copy_str(s_status_json, sizeof(s_status_json), printed);
        cJSON_free(printed);
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
        char *str = cJSON_PrintUnformatted(info);
        cJSON_Delete(info);
        if (!str) return BLE_ATT_ERR_INSUFFICIENT_RES;
        int rc = os_mbuf_append(ctxt->om, str, (uint16_t)strlen(str));
        cJSON_free(str);
        return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }

    if (ble_uuid_cmp(ctxt->chr->uuid, &s_chr_hs_uuid.u) == 0) {
        if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
            uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
            if (len > 128) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
            uint8_t buf[128];
            uint16_t out_len = 0;
            if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &out_len) != 0) {
                return BLE_ATT_ERR_UNLIKELY;
            }
            return handle_handshake_write(buf, out_len);
        }
        if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
            if (s_hs_resp_len == 0) {
                uint8_t idle[3] = {0x00, 0x00, hc_ble_guard_attempts_remaining(&s_auth_guard)};
                return os_mbuf_append(ctxt->om, idle, sizeof(idle)) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
            }
            return os_mbuf_append(ctxt->om, s_hs_resp, (uint16_t)s_hs_resp_len) == 0
                ? 0
                : BLE_ATT_ERR_INSUFFICIENT_RES;
        }
        return BLE_ATT_ERR_UNLIKELY;
    }

    if (ble_uuid_cmp(ctxt->chr->uuid, &s_chr_cmd_uuid.u) == 0) {
        if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_READ_NOT_PERMITTED;
        uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
        if (len > 512) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        uint8_t *buf = calloc(1, len + 1);
        if (!buf) return BLE_ATT_ERR_INSUFFICIENT_RES;
        uint16_t out_len = 0;
        int flat_rc = ble_hs_mbuf_to_flat(ctxt->om, buf, len, &out_len);
        int rc = (flat_rc == 0) ? handle_command_write(buf, out_len) : BLE_ATT_ERR_UNLIKELY;
        mbedtls_platform_zeroize(buf, len + 1);
        free(buf);
        return rc;
    }

    if (ble_uuid_cmp(ctxt->chr->uuid, &s_chr_status_uuid.u) == 0) {
        if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
        uint8_t enc_buf[320];
        size_t enc_len = 0;
        if (encrypt_status_payload(enc_buf, sizeof(enc_buf), &enc_len) != 0) {
            return BLE_ATT_ERR_UNLIKELY;
        }
        return os_mbuf_append(ctxt->om, enc_buf, (uint16_t)enc_len) == 0
            ? 0
            : BLE_ATT_ERR_INSUFFICIENT_RES;
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
            if (s_ble_active) {
                ble_prov_advertise();
            }
            return 0;

        case BLE_GAP_EVENT_SUBSCRIBE:
            if (event->subscribe.attr_handle == s_status_val_handle) {
                s_status_notify_enabled = event->subscribe.cur_notify != 0;
            }
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
