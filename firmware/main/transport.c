#include "transport.h"

#include <string.h>

#include "espnow_link.h"

static bool wifi_mqtt_available(const hc_connectivity_caps_t *caps) {
    return caps && caps->has_wifi && caps->has_mqtt;
}

static bool wifi_mqtt_active(void) {
    return hc_mqtt_is_connected();
}

static esp_err_t wifi_mqtt_start(homecore_config_t *cfg) {
    return hc_mqtt_start(cfg);
}

static void wifi_mqtt_stop(void) {
    hc_mqtt_stop();
}

static bool espnow_available(const hc_connectivity_caps_t *caps) {
    return caps && caps->has_espnow && caps->can_node;
}

static bool espnow_active(void) {
    return hc_espnow_is_ready();
}

static esp_err_t espnow_start(homecore_config_t *cfg) {
    (void)cfg;
    /* Role runtime still chooses host vs. seek; this initialises the radio. */
    return hc_espnow_init();
}

static void espnow_stop(void) {
    hc_espnow_stop();
}

static bool local_io_available(const hc_connectivity_caps_t *caps) {
    (void)caps;
    /* Local GPIO/automation is the one path that must survive cloud failure. */
    return true;
}

static bool local_io_active(void) {
    return true;
}

static esp_err_t local_io_start(homecore_config_t *cfg) {
    (void)cfg;
    return ESP_OK;
}

static void local_io_stop(void) {
    /* Local I/O is never stopped by a cloud or radio route change. */
}

static const hc_transport_t HC_TRANSPORTS[] = {
    { "wifi_mqtt", wifi_mqtt_available, wifi_mqtt_active, wifi_mqtt_start, wifi_mqtt_stop },
    { "espnow", espnow_available, espnow_active, espnow_start, espnow_stop },
    { "local_io", local_io_available, local_io_active, local_io_start, local_io_stop },
};

size_t hc_transport_build(
    const hc_connectivity_caps_t *caps,
    hc_transport_t *out,
    size_t capacity
) {
    if (!out) return 0;
    size_t count = 0;
    for (size_t i = 0; i < sizeof(HC_TRANSPORTS) / sizeof(HC_TRANSPORTS[0]); ++i) {
        if (count >= capacity) break;
        if (!HC_TRANSPORTS[i].available(caps)) continue;
        out[count++] = HC_TRANSPORTS[i];
    }
    return count;
}

const hc_transport_t *hc_transport_find(
    const hc_transport_t *transports,
    size_t count,
    const char *name
) {
    if (!transports || !name) return NULL;
    for (size_t i = 0; i < count; ++i) {
        if (strcmp(transports[i].name, name) == 0) return &transports[i];
    }
    return NULL;
}
