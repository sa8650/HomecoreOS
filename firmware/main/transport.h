#pragma once

/**
 * Common transport abstraction. Every network path used by the connectivity
 * manager is described by one descriptor; a board only receives descriptors
 * its capability profile allows. Additional transports can be added without
 * duplicating the connection manager.
 */
#include <stdbool.h>
#include <stddef.h>

#include "connectivity_logic.h"
#include "esp_err.h"
#include "homecore_config.h"

#ifdef __cplusplus
extern "C" {
#endif

#define HC_MAX_TRANSPORTS 3u

typedef struct {
    const char *name; /* "wifi_mqtt", "espnow", "local_io" */
    bool (*available)(const hc_connectivity_caps_t *caps);
    bool (*is_active)(void);
    esp_err_t (*start)(homecore_config_t *cfg);
    void (*stop)(void);
} hc_transport_t;

/** Fills `out` with the transports enabled by this exact board profile. */
size_t hc_transport_build(
    const hc_connectivity_caps_t *caps,
    hc_transport_t *out,
    size_t capacity
);

const hc_transport_t *hc_transport_find(
    const hc_transport_t *transports,
    size_t count,
    const char *name
);

#ifdef __cplusplus
}
#endif
