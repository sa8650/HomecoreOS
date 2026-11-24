#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "sensor_driver_logic.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool ok;
    double value;
    const char *unit;
    const char *driver_id;
    const char *error_code;
    int64_t timestamp_ms;
} hc_sensor_reading_t;

typedef struct {
    const char *sensor_type;
    const char *explicit_driver_id;
    int16_t gpio_pin;       /* primary role: SDA / TX / CS / data / ADC / GPIO */
    int16_t aux_pin_a;      /* second role: SCL / RX (resolved from board default when -1) */
    int16_t aux_pin_b;      /* reserved for SPI MISO/MOSI expansion */
    uint8_t i2c_addr;       /* 0 to use driver default */
    bool inverted;
    const char *model;      /* model-specific decoding profile, when selected */
    const char *physical_id;/* shared physical module identity for sibling measurements */
} hc_sensor_binding_t;

/* Compile-time driver mask derived from Kconfig CONFIG_HOMECORE_DRIVER_* flags */
uint32_t hc_sensor_drivers_compiled_mask(void);

/* Configure GPIO / I2C / ADC resources for one sensor binding */
esp_err_t hc_sensor_driver_configure(const hc_sensor_binding_t *binding);

/* Perform a board-aware, cached hardware read for one sensor binding */
hc_sensor_reading_t hc_sensor_driver_read(const hc_sensor_binding_t *binding, bool allow_cached);

/* Tear down I2C/ADC handles and sample caches before applying a new config snapshot */
void hc_sensor_drivers_reset(void);

#ifdef __cplusplus
}
#endif
