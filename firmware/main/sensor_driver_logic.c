#include "sensor_driver_logic.h"

#include <ctype.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

static bool str_ieq(const char *a, const char *b) {
    if (!a || !b) return false;
    while (*a && *b) {
        if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return false;
        a++;
        b++;
    }
    return *a == '\0' && *b == '\0';
}

static double round_to_decimals(double val, int decimals) {
    double scale = 1.0;
    for (int i = 0; i < decimals; i++) scale *= 10.0;
    return round(val * scale) / scale;
}

hc_sensor_measurement_t hc_sensor_resolve_measurement(const char *sensor_type) {
    if (!sensor_type || sensor_type[0] == '\0') return HC_MEAS_UNKNOWN;
    if (str_ieq(sensor_type, "temperature_bme280") || str_ieq(sensor_type, "temperature")) return HC_MEAS_TEMPERATURE;
    if (str_ieq(sensor_type, "temperature_dht22")) return HC_MEAS_TEMPERATURE_DHT22;
    if (str_ieq(sensor_type, "temperature_ds18b20")) return HC_MEAS_TEMPERATURE_DS18B20;
    if (str_ieq(sensor_type, "humidity_bme280") || str_ieq(sensor_type, "humidity")) return HC_MEAS_HUMIDITY;
    if (str_ieq(sensor_type, "humidity_dht22")) return HC_MEAS_HUMIDITY_DHT22;
    if (str_ieq(sensor_type, "pressure_bme280") || str_ieq(sensor_type, "pressure")) return HC_MEAS_PRESSURE;
    if (str_ieq(sensor_type, "motion_pir") || str_ieq(sensor_type, "motion")) return HC_MEAS_MOTION;
    if (str_ieq(sensor_type, "contact_reed") || str_ieq(sensor_type, "contact")) return HC_MEAS_CONTACT;
    if (str_ieq(sensor_type, "light_bh1750") || str_ieq(sensor_type, "light")) return HC_MEAS_LIGHT;
    if (str_ieq(sensor_type, "analog_voltage") || str_ieq(sensor_type, "voltage")) return HC_MEAS_VOLTAGE;
    return HC_MEAS_UNKNOWN;
}

static hc_sensor_driver_id_t parse_driver_id(const char *id) {
    if (!id || id[0] == '\0') return HC_DRV_NONE;
    if (str_ieq(id, "dht22")) return HC_DRV_DHT22;
    if (str_ieq(id, "ds18b20")) return HC_DRV_DS18B20;
    if (str_ieq(id, "bme280")) return HC_DRV_BME280;
    if (str_ieq(id, "pir")) return HC_DRV_PIR;
    if (str_ieq(id, "reed")) return HC_DRV_REED;
    if (str_ieq(id, "bh1750")) return HC_DRV_BH1750;
    if (str_ieq(id, "adc_voltage")) return HC_DRV_ADC_VOLTAGE;
    return HC_DRV_NONE;
}

hc_sensor_driver_id_t hc_sensor_resolve_driver(const char *sensor_type, const char *explicit_driver_id) {
    hc_sensor_driver_id_t explicit_drv = parse_driver_id(explicit_driver_id);
    if (explicit_drv != HC_DRV_NONE) {
        return explicit_drv;
    }

    switch (hc_sensor_resolve_measurement(sensor_type)) {
        case HC_MEAS_TEMPERATURE:
        case HC_MEAS_HUMIDITY:
        case HC_MEAS_PRESSURE:
            return HC_DRV_BME280;
        case HC_MEAS_TEMPERATURE_DHT22:
        case HC_MEAS_HUMIDITY_DHT22:
            return HC_DRV_DHT22;
        case HC_MEAS_TEMPERATURE_DS18B20:
            return HC_DRV_DS18B20;
        case HC_MEAS_MOTION:
            return HC_DRV_PIR;
        case HC_MEAS_CONTACT:
            return HC_DRV_REED;
        case HC_MEAS_LIGHT:
            return HC_DRV_BH1750;
        case HC_MEAS_VOLTAGE:
            return HC_DRV_ADC_VOLTAGE;
        default:
            return HC_DRV_NONE;
    }
}

const char *hc_sensor_driver_name(hc_sensor_driver_id_t drv) {
    switch (drv) {
        case HC_DRV_DHT22: return "dht22";
        case HC_DRV_DS18B20: return "ds18b20";
        case HC_DRV_BME280: return "bme280";
        case HC_DRV_PIR: return "pir";
        case HC_DRV_REED: return "reed";
        case HC_DRV_BH1750: return "bh1750";
        case HC_DRV_ADC_VOLTAGE: return "adc_voltage";
        default: return "unknown";
    }
}

const char *hc_sensor_default_unit(hc_sensor_measurement_t meas) {
    switch (meas) {
        case HC_MEAS_TEMPERATURE:
        case HC_MEAS_TEMPERATURE_DHT22:
        case HC_MEAS_TEMPERATURE_DS18B20:
            return "°C";
        case HC_MEAS_HUMIDITY:
        case HC_MEAS_HUMIDITY_DHT22:
            return "%";
        case HC_MEAS_PRESSURE:
            return "hPa";
        case HC_MEAS_LIGHT:
            return "lux";
        case HC_MEAS_VOLTAGE:
            return "V";
        case HC_MEAS_MOTION:
        case HC_MEAS_CONTACT:
        default:
            return "bool";
    }
}

bool hc_sensor_driver_is_i2c(hc_sensor_driver_id_t drv) {
    return drv == HC_DRV_BME280 || drv == HC_DRV_BH1750;
}

uint8_t hc_sensor_driver_default_i2c_addr(hc_sensor_driver_id_t drv) {
    if (drv == HC_DRV_BME280) return 0x76;
    if (drv == HC_DRV_BH1750) return 0x23;
    return 0;
}

uint8_t hc_sensor_parse_i2c_addr(const char *addr_str, uint8_t default_addr, bool *out_valid) {
    if (out_valid) *out_valid = true;
    if (!addr_str) return default_addr;

    while (*addr_str && isspace((unsigned char)*addr_str)) addr_str++;
    if (*addr_str == '\0') return default_addr;

    char *end = NULL;
    int base = (addr_str[0] == '0' && (addr_str[1] == 'x' || addr_str[1] == 'X')) ? 16 : 10;
    long val = strtol(addr_str, &end, base);
    if (end == addr_str) {
        if (out_valid) *out_valid = false;
        return default_addr;
    }
    while (end && *end && isspace((unsigned char)*end)) end++;
    if (end && *end != '\0') {
        if (out_valid) *out_valid = false;
        return default_addr;
    }
    if (val < 0x08 || val > 0x77) {
        if (out_valid) *out_valid = false;
        return default_addr;
    }
    return (uint8_t)val;
}

bool hc_sensor_is_driver_in_mask(uint32_t compiled_mask, hc_sensor_driver_id_t drv) {
    switch (drv) {
        case HC_DRV_DHT22: return (compiled_mask & HC_DRV_BIT_DHT22) != 0;
        case HC_DRV_DS18B20: return (compiled_mask & HC_DRV_BIT_DS18B20) != 0;
        case HC_DRV_BME280: return (compiled_mask & HC_DRV_BIT_BME280) != 0;
        case HC_DRV_PIR: return (compiled_mask & HC_DRV_BIT_PIR) != 0;
        case HC_DRV_REED: return (compiled_mask & HC_DRV_BIT_REED) != 0;
        case HC_DRV_BH1750: return (compiled_mask & HC_DRV_BIT_BH1750) != 0;
        case HC_DRV_ADC_VOLTAGE: return (compiled_mask & HC_DRV_BIT_ADC_VOLTAGE) != 0;
        default: return false;
    }
}

bool hc_dht22_decode(const uint8_t raw[5], double *out_temp_c, double *out_humidity_pct) {
    if (!raw || !out_temp_c || !out_humidity_pct) return false;

    uint8_t sum = (uint8_t)((raw[0] + raw[1] + raw[2] + raw[3]) & 0xFFU);
    if (sum != raw[4]) {
        return false;
    }

    uint16_t raw_hum = (uint16_t)(((uint16_t)raw[0] << 8) | raw[1]);
    uint16_t raw_temp = (uint16_t)(((uint16_t)(raw[2] & 0x7FU) << 8) | raw[3]);
    bool negative = (raw[2] & 0x80U) != 0;

    double hum = (double)raw_hum / 10.0;
    double temp = (double)raw_temp / 10.0;
    if (negative) temp = -temp;

    if (hum < 0.0 || hum > 100.0 || temp < -40.0 || temp > 80.0) {
        return false;
    }

    *out_temp_c = round_to_decimals(temp, 1);
    *out_humidity_pct = round_to_decimals(hum, 1);
    return true;
}

uint8_t hc_onewire_crc8(const uint8_t *data, size_t len) {
    uint8_t crc = 0;
    if (!data) return 0;
    for (size_t i = 0; i < len; i++) {
        uint8_t inbyte = data[i];
        for (int b = 0; b < 8; b++) {
            uint8_t mix = (crc ^ inbyte) & 0x01U;
            crc >>= 1;
            if (mix) crc ^= 0x8CU;
            inbyte >>= 1;
        }
    }
    return crc;
}

bool hc_ds18b20_decode_scratchpad(const uint8_t scratchpad[9], double *out_temp_c) {
    if (!scratchpad || !out_temp_c) return false;

    bool all_zero = true;
    bool all_ff = true;
    for (int i = 0; i < 9; i++) {
        if (scratchpad[i] != 0x00U) all_zero = false;
        if (scratchpad[i] != 0xFFU) all_ff = false;
    }
    if (all_zero || all_ff) return false;

    if (hc_onewire_crc8(scratchpad, 8) != scratchpad[8]) {
        return false;
    }

    int16_t raw = (int16_t)((uint16_t)scratchpad[0] | ((uint16_t)scratchpad[1] << 8));
    double temp_c = (double)raw / 16.0;
    if (temp_c < -55.0 || temp_c > 125.0) {
        return false;
    }

    *out_temp_c = round_to_decimals(temp_c, 2);
    return true;
}

static uint16_t u16_le(const uint8_t *p) {
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static int16_t s16_le(const uint8_t *p) {
    return (int16_t)u16_le(p);
}

void hc_bme280_parse_calib(
    const uint8_t calib_0x88[26],
    const uint8_t calib_0xE1[7],
    hc_bme280_calib_t *out
) {
    if (!calib_0x88 || !calib_0xE1 || !out) return;
    memset(out, 0, sizeof(*out));

    out->dig_T1 = u16_le(&calib_0x88[0]);
    out->dig_T2 = s16_le(&calib_0x88[2]);
    out->dig_T3 = s16_le(&calib_0x88[4]);

    out->dig_P1 = u16_le(&calib_0x88[6]);
    out->dig_P2 = s16_le(&calib_0x88[8]);
    out->dig_P3 = s16_le(&calib_0x88[10]);
    out->dig_P4 = s16_le(&calib_0x88[12]);
    out->dig_P5 = s16_le(&calib_0x88[14]);
    out->dig_P6 = s16_le(&calib_0x88[16]);
    out->dig_P7 = s16_le(&calib_0x88[18]);
    out->dig_P8 = s16_le(&calib_0x88[20]);
    out->dig_P9 = s16_le(&calib_0x88[22]);

    /* 0xA1 is index 25 in 0x88..0xA1 */
    out->dig_H1 = calib_0x88[25];
    out->dig_H2 = s16_le(&calib_0xE1[0]);
    out->dig_H3 = calib_0xE1[2];
    out->dig_H4 = (int16_t)(((int16_t)(int8_t)calib_0xE1[3] << 4) | (calib_0xE1[4] & 0x0F));
    out->dig_H5 = (int16_t)(((int16_t)(int8_t)calib_0xE1[5] << 4) | ((calib_0xE1[4] >> 4) & 0x0F));
    out->dig_H6 = (int8_t)calib_0xE1[6];
}

bool hc_bme280_compensate(
    const hc_bme280_calib_t *cal,
    int32_t adc_t,
    int32_t adc_p,
    int32_t adc_h,
    hc_bme280_sample_t *out
) {
    if (!cal || !out) return false;
    if (cal->dig_T1 == 0 || cal->dig_P1 == 0) return false;
    /* 0x80000 indicates skipped/unready temperature or pressure measurement */
    if (adc_t == 0x80000 || adc_p == 0x80000) return false;

    /* Bosch Sensortec BME280 datasheet double-precision compensation formulas */
    double var1 = (((double)adc_t) / 16384.0 - ((double)cal->dig_T1) / 1024.0) * ((double)cal->dig_T2);
    double var2 = ((((double)adc_t) / 131072.0 - ((double)cal->dig_T1) / 8192.0) *
                   (((double)adc_t) / 131072.0 - ((double)cal->dig_T1) / 8192.0)) * ((double)cal->dig_T3);
    double t_fine = var1 + var2;
    double temp_c = t_fine / 5120.0;

    if (temp_c < -40.0 || temp_c > 85.0) return false;

    /* Pressure (Pa -> hPa) */
    double p_var1 = (t_fine / 2.0) - 64000.0;
    double p_var2 = p_var1 * p_var1 * ((double)cal->dig_P6) / 32768.0;
    p_var2 = p_var2 + p_var1 * ((double)cal->dig_P5) * 2.0;
    p_var2 = (p_var2 / 4.0) + (((double)cal->dig_P4) * 65536.0);
    p_var1 = (((double)cal->dig_P3) * p_var1 * p_var1 / 524288.0 + ((double)cal->dig_P2) * p_var1) / 524288.0;
    p_var1 = (1.0 + p_var1 / 32768.0) * ((double)cal->dig_P1);
    if (fabs(p_var1) < 1e-9) return false;

    double p = 1048576.0 - (double)adc_p;
    p = (p - (p_var2 / 4096.0)) * 6250.0 / p_var1;
    p_var1 = ((double)cal->dig_P9) * p * p / 2147483648.0;
    p_var2 = p * ((double)cal->dig_P8) / 32768.0;
    p = p + (p_var1 + p_var2 + ((double)cal->dig_P7)) / 16.0;
    double pressure_hpa = p / 100.0;
    if (pressure_hpa < 300.0 || pressure_hpa > 1100.0) return false;

    /* Humidity (%RH) */
    double hum = 0.0;
    if (adc_h != 0x8000) {
        double h = t_fine - 76800.0;
        h = ((double)adc_h - (((double)cal->dig_H4) * 64.0 + ((double)cal->dig_H5) / 16384.0 * h)) *
            (((double)cal->dig_H2) / 65536.0 *
             (1.0 + ((double)cal->dig_H6) / 67108864.0 * h *
              (1.0 + ((double)cal->dig_H3) / 67108864.0 * h)));
        h = h * (1.0 - ((double)cal->dig_H1) * h / 524288.0);
        if (h > 100.0) h = 100.0;
        if (h < 0.0) h = 0.0;
        hum = h;
    }

    out->temp_c = round_to_decimals(temp_c, 2);
    out->pressure_hpa = round_to_decimals(pressure_hpa, 2);
    out->humidity_pct = round_to_decimals(hum, 2);
    return true;
}

bool hc_bh1750_decode_lux(const uint8_t raw[2], double *out_lux) {
    if (!raw || !out_lux) return false;
    uint16_t count = (uint16_t)(((uint16_t)raw[0] << 8) | raw[1]);
    *out_lux = round_to_decimals((double)count / 1.2, 1);
    return true;
}

double hc_pir_decode(int raw_level, bool inverted) {
    bool active = raw_level != 0;
    if (inverted) active = !active;
    return active ? 1.0 : 0.0;
}

double hc_reed_decode(int raw_level, bool inverted) {
    /* Internal pull-up: magnet closed pulls pin LOW (0), open floats HIGH (1). */
    bool is_open = raw_level != 0;
    if (inverted) is_open = !is_open;
    return is_open ? 1.0 : 0.0;
}

bool hc_adc_mv_to_volts(int32_t mv, double divider_ratio, double *out_volts) {
    if (!out_volts || mv < 0 || mv > 5000) return false;
    double ratio = divider_ratio > 0.0 ? divider_ratio : 1.0;
    *out_volts = round_to_decimals(((double)mv / 1000.0) * ratio, 3);
    return true;
}
