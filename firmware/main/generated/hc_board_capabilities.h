/* GENERATED FILE - do not edit. Run firmware/scripts/generate_board_capabilities.py. */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef struct {
    const char *board_id;
    const char *chip_target;
    const char *sdk_version;
    const char *framework;
    bool has_wifi;
    bool has_mqtt;
    bool has_espnow;
    bool has_ble_provisioning;
    bool has_softap_provisioning;
    bool has_usb_recovery;
    bool can_controller;
    bool can_node;
    uint16_t espnow_mtu_bytes;
    uint16_t espnow_peer_limit;
    uint16_t espnow_encrypted_peer_limit;
    uint16_t max_controller_nodes;
    uint16_t max_tested_controller_nodes;
    uint32_t mqtt_buffer_bytes;
    uint16_t connectivity_queue_depth;
    uint32_t telemetry_interval_sec;
    uint32_t keepalive_ms;
    uint32_t link_timeout_ms;
    uint32_t recovery_window_ms;
    uint32_t discovery_interval_ms;
    uint32_t connectivity_task_stack_bytes;
    uint16_t flash_mb;
    uint16_t psram_mb;
    uint16_t nominal_sram_kb;
    bool experimental;
    bool hardware_tested;
} hc_board_capability_t;

static const hc_board_capability_t HC_BOARD_CAPABILITIES[] = {
    { "esp32-s3-devkitc-1-n16r8", "esp32s3", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 16, 8, 10, 0, 4096, 16, 30, 2000, 10000, 45000, 15000, 6144, 16, 8, 512, false, false },
    { "esp32-s3-devkitc-1-v1-0", "esp32s3", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 12, 6, 8, 0, 4096, 16, 30, 2000, 10000, 45000, 15000, 6144, 8, 8, 512, true, false },
    { "seeed-xiao-esp32s3", "esp32s3", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 12, 6, 8, 0, 4096, 16, 30, 2000, 10000, 45000, 15000, 6144, 8, 8, 512, true, false },
    { "seeed-xiao-esp32s3-sense", "esp32s3", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 12, 6, 8, 0, 4096, 16, 30, 2000, 10000, 45000, 15000, 6144, 8, 8, 512, true, false },
    { "seeed-xiao-esp32s3-plus", "esp32s3", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 16, 8, 10, 0, 4096, 16, 30, 2000, 10000, 45000, 15000, 6144, 16, 8, 512, true, false },
    { "waveshare-esp32-s3-zero", "esp32s3", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 8, 4, 4, 0, 4096, 16, 30, 2000, 10000, 45000, 15000, 6144, 4, 2, 512, true, false },
    { "waveshare-esp32-s3-pico", "esp32s3", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 12, 6, 8, 0, 4096, 16, 30, 2000, 10000, 45000, 15000, 6144, 16, 2, 512, true, false },
    { "waveshare-esp32-s3-relay-6ch", "esp32s3", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 16, 8, 10, 0, 4096, 16, 30, 2000, 10000, 45000, 15000, 6144, 16, 8, 512, true, false },
    { "esp32-devkitc-v4", "esp32", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 10, 4, 6, 0, 2048, 8, 60, 2000, 10000, 45000, 15000, 4096, 4, 0, 520, true, false },
    { "esp32-s2-devkitc-1", "esp32s2", "esp-idf v5.4", "esp_idf", true, true, true, false, true, true, true, true, 250, 8, 2, 4, 0, 4096, 16, 30, 2000, 10000, 45000, 15000, 6144, 4, 2, 320, true, false },
    { "esp32-c3-devkitm-1", "esp32c3", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 8, 2, 4, 0, 2048, 8, 60, 2000, 10000, 45000, 15000, 4096, 4, 0, 400, true, false },
    { "seeed-xiao-esp32c3", "esp32c3", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 8, 2, 4, 0, 2048, 8, 60, 2000, 10000, 45000, 15000, 4096, 4, 0, 400, true, false },
    { "waveshare-esp32-c3-zero", "esp32c3", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 8, 2, 4, 0, 2048, 8, 60, 2000, 10000, 45000, 15000, 4096, 4, 0, 400, true, false },
    { "esp32-c6-devkitc-1", "esp32c6", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 10, 4, 6, 0, 4096, 16, 30, 2000, 10000, 45000, 15000, 4096, 8, 0, 512, true, false },
    { "seeed-xiao-esp32c6", "esp32c6", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 8, 2, 4, 0, 2048, 8, 60, 2000, 10000, 45000, 15000, 4096, 4, 0, 512, true, false },
    { "waveshare-esp32-c6-zero", "esp32c6", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 8, 2, 4, 0, 2048, 8, 60, 2000, 10000, 45000, 15000, 4096, 4, 0, 512, true, false },
    { "esp32-c5-devkitc-1", "esp32c5", "esp-idf v5.5.2", "esp_idf", true, true, true, true, true, true, true, true, 250, 12, 4, 8, 0, 4096, 16, 30, 2000, 10000, 45000, 15000, 6144, 8, 8, 512, true, false },
    { "seeed-xiao-esp32c5", "esp32c5", "esp-idf v5.5.2", "esp_idf", true, true, true, true, true, true, true, true, 250, 12, 4, 8, 0, 4096, 16, 30, 2000, 10000, 45000, 15000, 6144, 8, 8, 512, true, false },
    { "esp32-c61-devkitc-1", "esp32c61", "esp-idf v5.5.2", "esp_idf", true, true, true, true, true, true, true, true, 250, 10, 4, 6, 0, 4096, 16, 30, 2000, 10000, 45000, 15000, 6144, 8, 2, 512, true, false },
    { "esp8684-devkitm-1", "esp32c2", "esp-idf v5.4", "esp_idf", true, true, true, true, true, true, true, true, 250, 6, 1, 2, 0, 2048, 8, 60, 2000, 10000, 45000, 15000, 4096, 4, 0, 400, true, false },
    { "esp32-h2-devkitm-1", "esp32h2", "esp-idf v5.4", "esp_idf", false, false, false, true, false, true, false, false, 0, 0, 0, 0, 0, 2048, 8, 60, 2000, 10000, 45000, 15000, 4096, 4, 0, 512, false, false },
    { "nodemcu-esp8266", "esp8266", "ESP8266 RTOS SDK via PlatformIO espressif8266 v4.x", "arduino_esp8266", true, true, false, false, true, true, false, true, 0, 0, 0, 0, 0, 2048, 8, 60, 2000, 10000, 45000, 15000, 4096, 4, 0, 160, true, false },
};

#define HC_BOARD_CAPABILITY_COUNT (sizeof(HC_BOARD_CAPABILITIES) / sizeof(HC_BOARD_CAPABILITIES[0]))

static inline const hc_board_capability_t *hc_board_capability_for_slug(const char *slug) {
    if (!slug) return NULL;
    for (size_t i = 0; i < HC_BOARD_CAPABILITY_COUNT; ++i) {
        if (strcmp(HC_BOARD_CAPABILITIES[i].board_id, slug) == 0) return &HC_BOARD_CAPABILITIES[i];
    }
    return NULL; /* unknown boards have no capabilities */
}
