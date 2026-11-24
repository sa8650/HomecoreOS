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
    if (str_ieq(sensor_type, "temperature_dht11")) return HC_MEAS_TEMPERATURE_DHT11;
    if (str_ieq(sensor_type, "humidity_dht11")) return HC_MEAS_HUMIDITY_DHT11;
    if (str_ieq(sensor_type, "temperature_sht3x")) return HC_MEAS_TEMPERATURE_SHT3X;
    if (str_ieq(sensor_type, "humidity_sht3x")) return HC_MEAS_HUMIDITY_SHT3X;
    if (str_ieq(sensor_type, "temperature_aht20")) return HC_MEAS_TEMPERATURE_AHT20;
    if (str_ieq(sensor_type, "humidity_aht20")) return HC_MEAS_HUMIDITY_AHT20;
    if (str_ieq(sensor_type, "temperature_tmp117")) return HC_MEAS_TEMPERATURE_TMP117;
    if (str_ieq(sensor_type, "presence_ld2410")) return HC_MEAS_PRESENCE_LD2410;
    if (str_ieq(sensor_type, "motion_ld2410")) return HC_MEAS_MOTION_LD2410;
    if (str_ieq(sensor_type, "distance_ld2410")) return HC_MEAS_DISTANCE_LD2410;
    if (str_ieq(sensor_type, "presence_ld2450")) return HC_MEAS_PRESENCE_LD2450;
    if (str_ieq(sensor_type, "light_veml7700")) return HC_MEAS_LIGHT_VEML7700;
    if (str_ieq(sensor_type, "tvoc_sgp30")) return HC_MEAS_TVOC_SGP30;
    if (str_ieq(sensor_type, "eco2_sgp30")) return HC_MEAS_ECO2_SGP30;
    if (str_ieq(sensor_type, "water_leak")) return HC_MEAS_WATER_LEAK;
    if (str_ieq(sensor_type, "water_level")) return HC_MEAS_WATER_LEVEL;
    if (str_ieq(sensor_type, "voltage_ina219")) return HC_MEAS_VOLTAGE_INA219;
    if (str_ieq(sensor_type, "current_ina219")) return HC_MEAS_CURRENT_INA219;
    if (str_ieq(sensor_type, "power_ina219")) return HC_MEAS_POWER_INA219;
    if (str_ieq(sensor_type, "voltage_ina226")) return HC_MEAS_VOLTAGE_INA226;
    if (str_ieq(sensor_type, "current_ina226")) return HC_MEAS_CURRENT_INA226;
    if (str_ieq(sensor_type, "power_ina226")) return HC_MEAS_POWER_INA226;
    if (str_ieq(sensor_type, "energy_ina226")) return HC_MEAS_ENERGY_INA226;
    if (str_ieq(sensor_type, "voltage_pzem")) return HC_MEAS_VOLTAGE_PZEM;
    if (str_ieq(sensor_type, "current_pzem")) return HC_MEAS_CURRENT_PZEM;
    if (str_ieq(sensor_type, "power_pzem")) return HC_MEAS_POWER_PZEM;
    if (str_ieq(sensor_type, "energy_pzem")) return HC_MEAS_ENERGY_PZEM;
    if (str_ieq(sensor_type, "current_sct013")) return HC_MEAS_CURRENT_SCT013;
    if (str_ieq(sensor_type, "soil_moisture")) return HC_MEAS_SOIL_MOISTURE;
    if (str_ieq(sensor_type, "rain_level")) return HC_MEAS_RAIN;
    if (str_ieq(sensor_type, "gas_mq2")) return HC_MEAS_GAS_MQ2;
    if (str_ieq(sensor_type, "gas_mq135")) return HC_MEAS_GAS_MQ135;
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
    if (str_ieq(id, "dht11")) return HC_DRV_DHT11;
    if (str_ieq(id, "sht3x")) return HC_DRV_SHT3X;
    if (str_ieq(id, "aht20")) return HC_DRV_AHT20;
    if (str_ieq(id, "tmp117")) return HC_DRV_TMP117;
    if (str_ieq(id, "ld2410")) return HC_DRV_LD2410;
    if (str_ieq(id, "ld2450")) return HC_DRV_LD2450;
    if (str_ieq(id, "veml7700")) return HC_DRV_VEML7700;
    if (str_ieq(id, "sgp30")) return HC_DRV_SGP30;
    if (str_ieq(id, "water_leak")) return HC_DRV_WATER_LEAK;
    if (str_ieq(id, "water_level")) return HC_DRV_WATER_LEVEL;
    if (str_ieq(id, "soil_moisture")) return HC_DRV_SOIL_MOISTURE;
    if (str_ieq(id, "rain")) return HC_DRV_RAIN;
    if (str_ieq(id, "ina219")) return HC_DRV_INA219;
    if (str_ieq(id, "ina226")) return HC_DRV_INA226;
    if (str_ieq(id, "pzem004t")) return HC_DRV_PZEM004T;
    if (str_ieq(id, "sct013")) return HC_DRV_SCT013;
    if (str_ieq(id, "mq2")) return HC_DRV_MQ2;
    if (str_ieq(id, "mq135")) return HC_DRV_MQ135;
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
        case HC_MEAS_TEMPERATURE_DHT11:
        case HC_MEAS_HUMIDITY_DHT11:
            return HC_DRV_DHT11;
        case HC_MEAS_TEMPERATURE_SHT3X:
        case HC_MEAS_HUMIDITY_SHT3X:
            return HC_DRV_SHT3X;
        case HC_MEAS_TEMPERATURE_AHT20:
        case HC_MEAS_HUMIDITY_AHT20:
            return HC_DRV_AHT20;
        case HC_MEAS_TEMPERATURE_TMP117:
            return HC_DRV_TMP117;
        case HC_MEAS_PRESENCE_LD2410:
        case HC_MEAS_MOTION_LD2410:
        case HC_MEAS_DISTANCE_LD2410:
            return HC_DRV_LD2410;
        case HC_MEAS_PRESENCE_LD2450:
            return HC_DRV_LD2450;
        case HC_MEAS_LIGHT_VEML7700:
            return HC_DRV_VEML7700;
        case HC_MEAS_TVOC_SGP30:
        case HC_MEAS_ECO2_SGP30:
            return HC_DRV_SGP30;
        case HC_MEAS_WATER_LEAK:
            return HC_DRV_WATER_LEAK;
        case HC_MEAS_WATER_LEVEL:
            return HC_DRV_WATER_LEVEL;
        case HC_MEAS_SOIL_MOISTURE:
            return HC_DRV_SOIL_MOISTURE;
        case HC_MEAS_RAIN:
            return HC_DRV_RAIN;
        case HC_MEAS_VOLTAGE_INA219:
        case HC_MEAS_CURRENT_INA219:
        case HC_MEAS_POWER_INA219:
            return HC_DRV_INA219;
        case HC_MEAS_VOLTAGE_INA226:
        case HC_MEAS_CURRENT_INA226:
        case HC_MEAS_POWER_INA226:
        case HC_MEAS_ENERGY_INA226:
            return HC_DRV_INA226;
        case HC_MEAS_VOLTAGE_PZEM:
        case HC_MEAS_CURRENT_PZEM:
        case HC_MEAS_POWER_PZEM:
        case HC_MEAS_ENERGY_PZEM:
            return HC_DRV_PZEM004T;
        case HC_MEAS_CURRENT_SCT013:
            return HC_DRV_SCT013;
        case HC_MEAS_GAS_MQ2:
            return HC_DRV_MQ2;
        case HC_MEAS_GAS_MQ135:
            return HC_DRV_MQ135;
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
        case HC_DRV_DHT11: return "dht11";
        case HC_DRV_SHT3X: return "sht3x";
        case HC_DRV_AHT20: return "aht20";
        case HC_DRV_TMP117: return "tmp117";
        case HC_DRV_LD2410: return "ld2410";
        case HC_DRV_LD2450: return "ld2450";
        case HC_DRV_VEML7700: return "veml7700";
        case HC_DRV_SGP30: return "sgp30";
        case HC_DRV_WATER_LEAK: return "water_leak";
        case HC_DRV_WATER_LEVEL: return "water_level";
        case HC_DRV_SOIL_MOISTURE: return "soil_moisture";
        case HC_DRV_RAIN: return "rain";
        case HC_DRV_INA219: return "ina219";
        case HC_DRV_INA226: return "ina226";
        case HC_DRV_PZEM004T: return "pzem004t";
        case HC_DRV_SCT013: return "sct013";
        case HC_DRV_MQ2: return "mq2";
        case HC_DRV_MQ135: return "mq135";
        default: return "unknown";
    }
}

const char *hc_sensor_default_unit(hc_sensor_measurement_t meas) {
    switch (meas) {
        case HC_MEAS_TEMPERATURE:
        case HC_MEAS_TEMPERATURE_DHT22:
        case HC_MEAS_TEMPERATURE_DS18B20:
        case HC_MEAS_TEMPERATURE_DHT11:
        case HC_MEAS_TEMPERATURE_SHT3X:
        case HC_MEAS_TEMPERATURE_AHT20:
        case HC_MEAS_TEMPERATURE_TMP117:
            return "°C";
        case HC_MEAS_HUMIDITY:
        case HC_MEAS_HUMIDITY_DHT22:
        case HC_MEAS_HUMIDITY_DHT11:
        case HC_MEAS_HUMIDITY_SHT3X:
        case HC_MEAS_HUMIDITY_AHT20:
        case HC_MEAS_SOIL_MOISTURE:
        case HC_MEAS_WATER_LEVEL:
            return "%";
        case HC_MEAS_GAS_MQ2:
        case HC_MEAS_GAS_MQ135:
            return "%FS";
        case HC_MEAS_PRESSURE:
            return "hPa";
        case HC_MEAS_LIGHT:
        case HC_MEAS_LIGHT_VEML7700:
            return "lux";
        case HC_MEAS_VOLTAGE:
        case HC_MEAS_VOLTAGE_INA219:
        case HC_MEAS_VOLTAGE_INA226:
        case HC_MEAS_VOLTAGE_PZEM:
            return "V";
        case HC_MEAS_CURRENT_INA219:
        case HC_MEAS_CURRENT_INA226:
        case HC_MEAS_CURRENT_PZEM:
        case HC_MEAS_CURRENT_SCT013:
            return "A";
        case HC_MEAS_POWER_INA219:
        case HC_MEAS_POWER_INA226:
        case HC_MEAS_POWER_PZEM:
            return "W";
        case HC_MEAS_ENERGY_INA226:
        case HC_MEAS_ENERGY_PZEM:
            return "Wh";
        case HC_MEAS_TVOC_SGP30:
            return "ppb";
        case HC_MEAS_ECO2_SGP30:
            return "ppm";
        case HC_MEAS_DISTANCE_LD2410:
            return "cm";
        case HC_MEAS_PRESENCE_LD2410:
        case HC_MEAS_MOTION_LD2410:
        case HC_MEAS_PRESENCE_LD2450:
        case HC_MEAS_WATER_LEAK:
        case HC_MEAS_RAIN:
            return "state";
        case HC_MEAS_MOTION:
        case HC_MEAS_CONTACT:
        default:
            return "bool";
    }
}

bool hc_sensor_driver_is_i2c(hc_sensor_driver_id_t drv) {
    switch (drv) {
        case HC_DRV_BME280:
        case HC_DRV_BH1750:
        case HC_DRV_SHT3X:
        case HC_DRV_AHT20:
        case HC_DRV_TMP117:
        case HC_DRV_VEML7700:
        case HC_DRV_SGP30:
        case HC_DRV_INA219:
        case HC_DRV_INA226:
            return true;
        default:
            return false;
    }
}

uint8_t hc_sensor_driver_default_i2c_addr(hc_sensor_driver_id_t drv) {
    if (drv == HC_DRV_BME280) return 0x76;
    if (drv == HC_DRV_BH1750) return 0x23;
    if (drv == HC_DRV_SHT3X) return 0x44;
    if (drv == HC_DRV_AHT20) return 0x38;
    if (drv == HC_DRV_TMP117) return 0x48;
    if (drv == HC_DRV_VEML7700) return 0x10;
    if (drv == HC_DRV_SGP30) return 0x58;
    if (drv == HC_DRV_INA219 || drv == HC_DRV_INA226) return 0x40;
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
        case HC_DRV_DHT11: return (compiled_mask & HC_DRV_BIT_DHT11) != 0;
        case HC_DRV_SHT3X: return (compiled_mask & HC_DRV_BIT_SHT3X) != 0;
        case HC_DRV_AHT20: return (compiled_mask & HC_DRV_BIT_AHT20) != 0;
        case HC_DRV_TMP117: return (compiled_mask & HC_DRV_BIT_TMP117) != 0;
        case HC_DRV_LD2410: return (compiled_mask & HC_DRV_BIT_LD2410) != 0;
        case HC_DRV_LD2450: return (compiled_mask & HC_DRV_BIT_LD2450) != 0;
        case HC_DRV_VEML7700: return (compiled_mask & HC_DRV_BIT_VEML7700) != 0;
        case HC_DRV_SGP30: return (compiled_mask & HC_DRV_BIT_SGP30) != 0;
        case HC_DRV_WATER_LEAK: return (compiled_mask & HC_DRV_BIT_WATER_LEAK) != 0;
        case HC_DRV_WATER_LEVEL: return (compiled_mask & HC_DRV_BIT_WATER_LEVEL) != 0;
        case HC_DRV_SOIL_MOISTURE: return (compiled_mask & HC_DRV_BIT_SOIL_MOISTURE) != 0;
        case HC_DRV_RAIN: return (compiled_mask & HC_DRV_BIT_RAIN) != 0;
        case HC_DRV_INA219: return (compiled_mask & HC_DRV_BIT_INA219) != 0;
        case HC_DRV_INA226: return (compiled_mask & HC_DRV_BIT_INA226) != 0;
        case HC_DRV_PZEM004T: return (compiled_mask & HC_DRV_BIT_PZEM004T) != 0;
        case HC_DRV_SCT013: return (compiled_mask & HC_DRV_BIT_SCT013) != 0;
        case HC_DRV_MQ2: return (compiled_mask & HC_DRV_BIT_MQ2) != 0;
        case HC_DRV_MQ135: return (compiled_mask & HC_DRV_BIT_MQ135) != 0;
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

/* ============================================================================
 * Expanded protocol families — shared by ESP32 (ESP-IDF) and ESP8266 builds.
 * ============================================================================ */

bool hc_dht11_decode(const uint8_t raw[5], double *out_temp_c, double *out_humidity_pct) {
    if (!raw || !out_temp_c || !out_humidity_pct) return false;
    uint8_t sum = (uint8_t)(raw[0] + raw[1] + raw[2] + raw[3]);
    if (sum != raw[4]) return false;
    double hum = (double)raw[0];
    double temp = (double)(raw[2] & 0x7FU);
    if (raw[2] & 0x80U) temp = -temp;
    if (hum < 0.0 || hum > 100.0 || temp < 0.0 || temp > 50.0) return false;
    *out_humidity_pct = round_to_decimals(hum, 0);
    *out_temp_c = round_to_decimals(temp, 0);
    return true;
}

uint8_t hc_sht3x_crc8(const uint8_t *data, size_t len) {
    uint8_t crc = 0xFFU;
    if (!data) return 0;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++) {
            crc = (crc & 0x80U) ? (uint8_t)((crc << 1) ^ 0x31U) : (uint8_t)(crc << 1);
        }
    }
    return crc;
}

bool hc_sht3x_decode(const uint8_t raw[6], double *out_temp_c, double *out_humidity_pct) {
    if (!raw || !out_temp_c || !out_humidity_pct) return false;
    uint8_t t_crc = hc_sht3x_crc8(raw, 2);
    uint8_t h_crc = hc_sht3x_crc8(raw + 3, 2);
    if (t_crc != raw[2] || h_crc != raw[5]) return false;
    uint16_t t_raw = (uint16_t)(((uint16_t)raw[0] << 8) | raw[1]);
    uint16_t h_raw = (uint16_t)(((uint16_t)raw[3] << 8) | raw[4]);
    double temp = -45.0 + 175.0 * (double)t_raw / 65535.0;
    double hum = 100.0 * (double)h_raw / 65535.0;
    if (temp < -40.0 || temp > 125.0 || hum < 0.0 || hum > 100.0) return false;
    *out_temp_c = round_to_decimals(temp, 2);
    *out_humidity_pct = round_to_decimals(hum, 2);
    return true;
}

bool hc_aht20_decode(const uint8_t raw[6], double *out_temp_c, double *out_humidity_pct) {
    if (!raw || !out_temp_c || !out_humidity_pct) return false;
    /* Status byte: bit 7 = busy (must be 0), bit 3 = calibrated (must be 1). */
    if ((raw[0] & 0x80U) != 0 || (raw[0] & 0x08U) == 0) return false;
    uint32_t hum_raw = (((uint32_t)raw[1] << 16) | ((uint32_t)raw[2] << 8) | raw[3]) >> 4;
    uint32_t temp_raw = (((uint32_t)(raw[3] & 0x0FU) << 16) |
                         ((uint32_t)raw[4] << 8) | (uint32_t)raw[5]);
    double hum = 100.0 * (double)hum_raw / 1048576.0;
    double temp = 200.0 * (double)temp_raw / 1048576.0 - 50.0;
    if (hum < 0.0 || hum > 100.0 || temp < -40.0 || temp > 85.0) return false;
    *out_humidity_pct = round_to_decimals(hum, 2);
    *out_temp_c = round_to_decimals(temp, 2);
    return true;
}

bool hc_tmp117_decode(const uint8_t raw[2], double *out_temp_c) {
    if (!raw || !out_temp_c) return false;
    /* TMP117 temperature register 0x00 is 16-bit signed big-endian (7.8125 mC/LSB). */
    uint16_t u_raw = (uint16_t)(((uint16_t)raw[0] << 8) | (uint16_t)raw[1]);
    if (u_raw == 0x8000U) return false; /* power-on/invalid sentinel (-256 C) */
    int16_t raw_i = (int16_t)u_raw;
    double temp = (double)raw_i * 0.0078125;
    if (temp < -40.0 || temp > 125.0) return false;
    *out_temp_c = round_to_decimals(temp, 3);
    return true;
}

bool hc_veml7700_decode_lux(const uint8_t raw[2], double *out_lux) {
    if (!raw || !out_lux) return false;
    /* VEML7700 ALS register 0x04 returns 16-bit little-endian [LSB, MSB]. */
    uint16_t count = (uint16_t)((uint16_t)raw[0] | ((uint16_t)raw[1] << 8));
    /* Gain 1/4 + 100 ms integration time (config 0x1800): 0.2304 lx/count. */
    *out_lux = round_to_decimals((double)count * 0.2304, 2);
    return true;
}

bool hc_sgp30_decode(const uint8_t raw[6], double *out_tvoc_ppb, double *out_eco2_ppm) {
    if (!raw || !out_tvoc_ppb || !out_eco2_ppm) return false;
    if (hc_sht3x_crc8(raw, 2) != raw[2] || hc_sht3x_crc8(raw + 3, 2) != raw[5]) return false;
    /* SGP30 measure_iaq (0x2008): bytes 0..1 = eCO2 (ppm), bytes 3..4 = TVOC (ppb). */
    *out_eco2_ppm = (double)(((uint16_t)raw[0] << 8) | raw[1]);
    *out_tvoc_ppb = (double)(((uint16_t)raw[3] << 8) | raw[4]);
    if (*out_eco2_ppm < 400.0 || *out_eco2_ppm > 60000.0) return false;
    if (*out_tvoc_ppb < 0.0 || *out_tvoc_ppb > 60000.0) return false;
    return true;
}

bool hc_ina_decode(const uint8_t raw[2], bool ina226, int meas_kind,
                   double shunt_ohms, double *out_value) {
    if (!raw || !out_value) return false;
    if (!(shunt_ohms > 0.0)) shunt_ohms = 0.1;
    /* INA219 and INA226 I2C registers are 16-bit big-endian [MSB, LSB]. */
    uint16_t u_raw = (uint16_t)(((uint16_t)raw[0] << 8) | (uint16_t)raw[1]);
    int16_t signed_raw = (int16_t)u_raw;
    switch (meas_kind) {
        case 0: { /* bus voltage register 0x02 (unsigned) */
            double volts = ina226 ? (double)u_raw * 0.00125
                                  : (double)(u_raw >> 3) * 0.004;
            if (volts < 0.0 || volts > 40.0) return false;
            *out_value = round_to_decimals(volts, 3);
            return true;
        }
        case 1: { /* shunt voltage register 0x01 -> current through fitted shunt */
            double shunt_mv = (double)signed_raw * (ina226 ? 0.0025 : 0.01);
            double amps = shunt_mv / (1000.0 * shunt_ohms);
            if (amps < -500.0 || amps > 500.0) return false;
            *out_value = round_to_decimals(amps, 3);
            return true;
        }
        case 2: { /* power register 0x03 (unsigned; calibrated at 100 uA/bit for 0.1 ohm) */
            double current_lsb = 0.00001 / shunt_ohms;
            double watts = (double)u_raw * (ina226 ? 25.0 : 20.0) * current_lsb;
            if (watts < 0.0 || watts > 10000.0) return false;
            *out_value = round_to_decimals(watts, 3);
            return true;
        }
        default:
            return false; /* energy is accumulated in firmware, not decoded */
    }
}

bool hc_ld2410_parse_frame(const uint8_t *buf, size_t len, double *out_presence,
                           double *out_motion, double *out_distance_cm) {
    if (!buf || len < 23 || !out_presence || !out_motion || !out_distance_cm) return false;
    for (size_t i = 0; i + 22 < len; i++) {
        /* Hi-Link LD2410 reporting frame header: F4 F3 F2 F1 */
        if (buf[i] != 0xF4U || buf[i + 1] != 0xF3U ||
            buf[i + 2] != 0xF2U || buf[i + 3] != 0xF1U) {
            continue;
        }
        size_t payload_len = (size_t)buf[i + 4] | ((size_t)buf[i + 5] << 8);
        if (payload_len < 13 || i + 6 + payload_len + 4 > len) continue;
        size_t tail = i + 6 + payload_len;
        /* Hi-Link LD2410 reporting frame footer: F8 F7 F6 F5 */
        if (buf[tail] != 0xF8U || buf[tail + 1] != 0xF7U ||
            buf[tail + 2] != 0xF6U || buf[tail + 3] != 0xF5U) {
            continue;
        }
        const uint8_t *p = buf + i + 6;
        if ((p[0] != 0x01U && p[0] != 0x02U) || p[1] != 0xAAU) continue;
        if (p[payload_len - 2] != 0x55U) continue;
        int state = p[2];
        if (state > 3) continue;
        uint16_t dist = (uint16_t)p[9] | ((uint16_t)p[10] << 8);
        if (dist > 1000U) continue;
        *out_presence = (double)(state != 0 ? 1 : 0);
        *out_motion = (double)((state == 1 || state == 3) ? 1 : 0);
        *out_distance_cm = (double)dist;
        return true;
    }
    return false;
}

bool hc_adc_percent(int32_t mv, int32_t max_mv, double *out_percent) {
    if (!out_percent || mv < 0 || max_mv <= 0) return false;
    double pct = 100.0 * (double)mv / (double)max_mv;
    if (pct > 100.0) pct = 100.0;
    *out_percent = round_to_decimals(pct, 1);
    return true;
}

double hc_mq_qualitative_pct(int32_t mv, int32_t max_mv) {
    double pct = 0.0;
    if (!hc_adc_percent(mv, max_mv, &pct)) return 0.0;
    return pct;
}
