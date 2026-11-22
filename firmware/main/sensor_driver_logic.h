#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    HC_DRV_NONE = 0,
    HC_DRV_DHT22 = 1,
    HC_DRV_DS18B20 = 2,
    HC_DRV_BME280 = 3,
    HC_DRV_PIR = 4,
    HC_DRV_REED = 5,
    HC_DRV_BH1750 = 6,
    HC_DRV_ADC_VOLTAGE = 7,
} hc_sensor_driver_id_t;

typedef enum {
    HC_MEAS_UNKNOWN = 0,
    HC_MEAS_TEMPERATURE = 1,
    HC_MEAS_TEMPERATURE_DHT22 = 2,
    HC_MEAS_TEMPERATURE_DS18B20 = 3,
    HC_MEAS_HUMIDITY = 4,
    HC_MEAS_HUMIDITY_DHT22 = 5,
    HC_MEAS_PRESSURE = 6,
    HC_MEAS_MOTION = 7,
    HC_MEAS_CONTACT = 8,
    HC_MEAS_LIGHT = 9,
    HC_MEAS_VOLTAGE = 10,
} hc_sensor_measurement_t;

typedef enum {
    HC_DRV_BIT_DHT22       = (1U << 0),
    HC_DRV_BIT_DS18B20     = (1U << 1),
    HC_DRV_BIT_BME280      = (1U << 2),
    HC_DRV_BIT_PIR         = (1U << 3),
    HC_DRV_BIT_REED        = (1U << 4),
    HC_DRV_BIT_BH1750      = (1U << 5),
    HC_DRV_BIT_ADC_VOLTAGE = (1U << 6),
} hc_driver_mask_bit_t;

typedef struct {
    uint16_t dig_T1;
    int16_t  dig_T2;
    int16_t  dig_T3;
    uint16_t dig_P1;
    int16_t  dig_P2;
    int16_t  dig_P3;
    int16_t  dig_P4;
    int16_t  dig_P5;
    int16_t  dig_P6;
    int16_t  dig_P7;
    int16_t  dig_P8;
    int16_t  dig_P9;
    uint8_t  dig_H1;
    int16_t  dig_H2;
    uint8_t  dig_H3;
    int16_t  dig_H4;
    int16_t  dig_H5;
    int8_t   dig_H6;
} hc_bme280_calib_t;

typedef struct {
    double temp_c;
    double pressure_hpa;
    double humidity_pct;
} hc_bme280_sample_t;

hc_sensor_measurement_t hc_sensor_resolve_measurement(const char *sensor_type);
hc_sensor_driver_id_t hc_sensor_resolve_driver(const char *sensor_type, const char *explicit_driver_id);
const char *hc_sensor_driver_name(hc_sensor_driver_id_t drv);
const char *hc_sensor_default_unit(hc_sensor_measurement_t meas);
bool hc_sensor_driver_is_i2c(hc_sensor_driver_id_t drv);
uint8_t hc_sensor_driver_default_i2c_addr(hc_sensor_driver_id_t drv);
uint8_t hc_sensor_parse_i2c_addr(const char *addr_str, uint8_t default_addr, bool *out_valid);
bool hc_sensor_is_driver_in_mask(uint32_t compiled_mask, hc_sensor_driver_id_t drv);

/* Pure protocol decoders & calibration compensation (host-testable) */
bool hc_dht22_decode(const uint8_t raw[5], double *out_temp_c, double *out_humidity_pct);
uint8_t hc_onewire_crc8(const uint8_t *data, size_t len);
bool hc_ds18b20_decode_scratchpad(const uint8_t scratchpad[9], double *out_temp_c);
void hc_bme280_parse_calib(
    const uint8_t calib_0x88[26],
    const uint8_t calib_0xE1[7],
    hc_bme280_calib_t *out
);
bool hc_bme280_compensate(
    const hc_bme280_calib_t *cal,
    int32_t adc_t,
    int32_t adc_p,
    int32_t adc_h,
    hc_bme280_sample_t *out
);
bool hc_bh1750_decode_lux(const uint8_t raw[2], double *out_lux);
double hc_pir_decode(int raw_level, bool inverted);
double hc_reed_decode(int raw_level, bool inverted);
bool hc_adc_mv_to_volts(int32_t mv, double divider_ratio, double *out_volts);

#ifdef __cplusplus
}
#endif
