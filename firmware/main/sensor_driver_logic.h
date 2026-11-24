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
    HC_DRV_DHT11 = 8,
    HC_DRV_SHT3X = 9,
    HC_DRV_AHT20 = 10,
    HC_DRV_TMP117 = 11,
    HC_DRV_LD2410 = 12,
    HC_DRV_LD2450 = 13,
    HC_DRV_VEML7700 = 14,
    HC_DRV_SGP30 = 15,
    HC_DRV_WATER_LEAK = 16,
    HC_DRV_WATER_LEVEL = 17,
    HC_DRV_SOIL_MOISTURE = 18,
    HC_DRV_RAIN = 19,
    HC_DRV_INA219 = 20,
    HC_DRV_INA226 = 21,
    HC_DRV_PZEM004T = 22,
    HC_DRV_SCT013 = 23,
    HC_DRV_MQ2 = 24,
    HC_DRV_MQ135 = 25,
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
    HC_MEAS_TEMPERATURE_DHT11 = 11,
    HC_MEAS_HUMIDITY_DHT11 = 12,
    HC_MEAS_TEMPERATURE_SHT3X = 13,
    HC_MEAS_HUMIDITY_SHT3X = 14,
    HC_MEAS_TEMPERATURE_AHT20 = 15,
    HC_MEAS_HUMIDITY_AHT20 = 16,
    HC_MEAS_TEMPERATURE_TMP117 = 17,
    HC_MEAS_PRESENCE_LD2410 = 18,
    HC_MEAS_MOTION_LD2410 = 19,
    HC_MEAS_DISTANCE_LD2410 = 20,
    HC_MEAS_PRESENCE_LD2450 = 21,
    HC_MEAS_LIGHT_VEML7700 = 22,
    HC_MEAS_TVOC_SGP30 = 23,
    HC_MEAS_ECO2_SGP30 = 24,
    HC_MEAS_WATER_LEAK = 25,
    HC_MEAS_WATER_LEVEL = 26,
    HC_MEAS_VOLTAGE_INA219 = 27,
    HC_MEAS_CURRENT_INA219 = 28,
    HC_MEAS_POWER_INA219 = 29,
    HC_MEAS_VOLTAGE_INA226 = 30,
    HC_MEAS_CURRENT_INA226 = 31,
    HC_MEAS_POWER_INA226 = 32,
    HC_MEAS_ENERGY_INA226 = 33,
    HC_MEAS_VOLTAGE_PZEM = 34,
    HC_MEAS_CURRENT_PZEM = 35,
    HC_MEAS_POWER_PZEM = 36,
    HC_MEAS_ENERGY_PZEM = 37,
    HC_MEAS_CURRENT_SCT013 = 38,
    HC_MEAS_SOIL_MOISTURE = 39,
    HC_MEAS_RAIN = 40,
    HC_MEAS_GAS_MQ2 = 41,
    HC_MEAS_GAS_MQ135 = 42,
} hc_sensor_measurement_t;

typedef enum {
    HC_DRV_BIT_DHT22       = (1U << 0),
    HC_DRV_BIT_DS18B20     = (1U << 1),
    HC_DRV_BIT_BME280      = (1U << 2),
    HC_DRV_BIT_PIR         = (1U << 3),
    HC_DRV_BIT_REED        = (1U << 4),
    HC_DRV_BIT_BH1750      = (1U << 5),
    HC_DRV_BIT_ADC_VOLTAGE = (1U << 6),
    HC_DRV_BIT_DHT11        = (1U << 8),
    HC_DRV_BIT_SHT3X        = (1U << 9),
    HC_DRV_BIT_AHT20        = (1U << 10),
    HC_DRV_BIT_TMP117       = (1U << 11),
    HC_DRV_BIT_LD2410       = (1U << 12),
    HC_DRV_BIT_LD2450       = (1U << 13),
    HC_DRV_BIT_VEML7700     = (1U << 14),
    HC_DRV_BIT_SGP30        = (1U << 15),
    HC_DRV_BIT_WATER_LEAK   = (1U << 16),
    HC_DRV_BIT_WATER_LEVEL  = (1U << 17),
    HC_DRV_BIT_SOIL_MOISTURE = (1U << 18),
    HC_DRV_BIT_RAIN         = (1U << 19),
    HC_DRV_BIT_INA219       = (1U << 20),
    HC_DRV_BIT_INA226       = (1U << 21),
    HC_DRV_BIT_PZEM004T     = (1U << 22),
    HC_DRV_BIT_SCT013       = (1U << 23),
    HC_DRV_BIT_MQ2          = (1U << 24),
    HC_DRV_BIT_MQ135        = (1U << 25),
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

/* Shared protocol-family decoders (host-testable, no hardware dependencies) */
bool hc_dht11_decode(const uint8_t raw[5], double *out_temp_c, double *out_humidity_pct);
uint8_t hc_sht3x_crc8(const uint8_t *data, size_t len);
bool hc_sht3x_decode(const uint8_t raw[6], double *out_temp_c, double *out_humidity_pct);
bool hc_aht20_decode(const uint8_t raw[6], double *out_temp_c, double *out_humidity_pct);
bool hc_tmp117_decode(const uint8_t raw[2], double *out_temp_c);
bool hc_veml7700_decode_lux(const uint8_t raw[2], double *out_lux);
bool hc_sgp30_decode(const uint8_t raw[6], double *out_tvoc_ppb, double *out_eco2_ppm);
bool hc_ina_decode(const uint8_t raw[2], bool ina226, int meas_kind,
                   double shunt_ohms, double *out_value);
bool hc_ld2410_parse_frame(const uint8_t *buf, size_t len, double *out_presence,
                           double *out_motion, double *out_distance_cm);
bool hc_adc_percent(int32_t mv, int32_t max_mv, double *out_percent);
double hc_mq_qualitative_pct(int32_t mv, int32_t max_mv);

#ifdef __cplusplus
}
#endif
