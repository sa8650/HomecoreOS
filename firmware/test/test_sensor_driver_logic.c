#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "../main/sensor_driver_logic.h"

static bool approx(double a, double b, double tol) {
    return fabs(a - b) <= tol;
}

static void test_resolution_and_i2c_parsing(void) {
    /* Canonical SUPPORTED_SENSOR_TYPES from @homecoreos/shared */
    assert(hc_sensor_resolve_driver("temperature_bme280", NULL) == HC_DRV_BME280);
    assert(hc_sensor_resolve_driver("humidity_bme280", NULL) == HC_DRV_BME280);
    assert(hc_sensor_resolve_driver("pressure_bme280", NULL) == HC_DRV_BME280);
    assert(hc_sensor_resolve_driver("temperature_dht22", NULL) == HC_DRV_DHT22);
    assert(hc_sensor_resolve_driver("humidity_dht22", NULL) == HC_DRV_DHT22);
    assert(hc_sensor_resolve_driver("temperature_ds18b20", NULL) == HC_DRV_DS18B20);
    assert(hc_sensor_resolve_driver("motion_pir", NULL) == HC_DRV_PIR);
    assert(hc_sensor_resolve_driver("contact_reed", NULL) == HC_DRV_REED);
    assert(hc_sensor_resolve_driver("light_bh1750", NULL) == HC_DRV_BH1750);
    assert(hc_sensor_resolve_driver("analog_voltage", NULL) == HC_DRV_ADC_VOLTAGE);
    /* Short aliases remain accepted too */
    assert(hc_sensor_resolve_driver("temperature", NULL) == HC_DRV_BME280);
    assert(hc_sensor_resolve_driver("humidity", NULL) == HC_DRV_BME280);
    assert(hc_sensor_resolve_driver("pressure", NULL) == HC_DRV_BME280);
    assert(hc_sensor_resolve_driver("motion", NULL) == HC_DRV_PIR);
    assert(hc_sensor_resolve_driver("contact", NULL) == HC_DRV_REED);
    assert(hc_sensor_resolve_driver("light", NULL) == HC_DRV_BH1750);
    assert(hc_sensor_resolve_driver("voltage", NULL) == HC_DRV_ADC_VOLTAGE);
    assert(hc_sensor_resolve_driver("unknown_sensor", NULL) == HC_DRV_NONE);

    /* Explicit driver_id overrides sensor_type inference */
    assert(hc_sensor_resolve_driver("temperature", "dht22") == HC_DRV_DHT22);
    assert(strcmp(hc_sensor_driver_name(HC_DRV_ADC_VOLTAGE), "adc_voltage") == 0);
    assert(strcmp(hc_sensor_default_unit(HC_MEAS_PRESSURE), "hPa") == 0);
    assert(strcmp(hc_sensor_default_unit(HC_MEAS_LIGHT), "lux") == 0);
    assert(strcmp(hc_sensor_default_unit(HC_MEAS_VOLTAGE), "V") == 0);

    assert(hc_sensor_driver_is_i2c(HC_DRV_BME280) == true);
    assert(hc_sensor_driver_is_i2c(HC_DRV_BH1750) == true);
    assert(hc_sensor_driver_is_i2c(HC_DRV_DHT22) == false);
    assert(hc_sensor_driver_default_i2c_addr(HC_DRV_BME280) == 0x76);
    assert(hc_sensor_driver_default_i2c_addr(HC_DRV_BH1750) == 0x23);

    bool ok = false;
    assert(hc_sensor_parse_i2c_addr("0x77", 0x76, &ok) == 0x77 && ok);
    assert(hc_sensor_parse_i2c_addr(" 0x5C ", 0x23, &ok) == 0x5C && ok);
    assert(hc_sensor_parse_i2c_addr("118", 0x77, &ok) == 0x76 && ok);
    assert(hc_sensor_parse_i2c_addr("", 0x76, &ok) == 0x76 && ok);
    assert(hc_sensor_parse_i2c_addr(NULL, 0x23, &ok) == 0x23 && ok);

    /* Reserved / malformed I2C addresses must fail validation */
    assert(hc_sensor_parse_i2c_addr("0x03", 0x76, &ok) == 0x76 && !ok);
    assert(hc_sensor_parse_i2c_addr("0x78", 0x76, &ok) == 0x76 && !ok);
    assert(hc_sensor_parse_i2c_addr("not_hex", 0x76, &ok) == 0x76 && !ok);

    /* Compiled driver bitmask checks */
    uint32_t partial = HC_DRV_BIT_BME280 | HC_DRV_BIT_PIR;
    assert(hc_sensor_is_driver_in_mask(partial, HC_DRV_BME280) == true);
    assert(hc_sensor_is_driver_in_mask(partial, HC_DRV_PIR) == true);
    assert(hc_sensor_is_driver_in_mask(partial, HC_DRV_DHT22) == false);
    assert(hc_sensor_is_driver_in_mask(partial, HC_DRV_ADC_VOLTAGE) == false);
}

static void test_dht22_decoder(void) {
    /* 61.2% RH = 612 = 0x0264, 24.5 C = 245 = 0x00F5 */
    uint8_t valid_pos[5] = { 0x02, 0x64, 0x00, 0xF5, (uint8_t)((0x02 + 0x64 + 0x00 + 0xF5) & 0xFF) };
    double temp = 0.0, hum = 0.0;
    assert(hc_dht22_decode(valid_pos, &temp, &hum) == true);
    assert(approx(temp, 24.5, 0.01));
    assert(approx(hum, 61.2, 0.01));

    /* Negative temp: -12.3 C -> 123 = 0x007B with sign bit 0x80 -> 0x80, 0x7B */
    uint8_t valid_neg[5] = { 0x01, 0xF4, 0x80, 0x7B, (uint8_t)((0x01 + 0xF4 + 0x80 + 0x7B) & 0xFF) };
    assert(hc_dht22_decode(valid_neg, &temp, &hum) == true);
    assert(approx(temp, -12.3, 0.01));
    assert(approx(hum, 50.0, 0.01));

    /* Bad checksum rejected */
    uint8_t bad_cksum[5] = { 0x02, 0x64, 0x00, 0xF5, 0x00 };
    assert(hc_dht22_decode(bad_cksum, &temp, &hum) == false);

    /* Out-of-range humidity (>100%) rejected */
    uint8_t bad_range[5] = { 0x04, 0xB0, 0x00, 0xFA, (uint8_t)((0x04 + 0xB0 + 0x00 + 0xFA) & 0xFF) };
    assert(hc_dht22_decode(bad_range, &temp, &hum) == false);
}

static void test_ds18b20_decoder(void) {
    /* +25.0625 C = 401 = 0x0191 */
    uint8_t sp_pos[9] = { 0x91, 0x01, 0x4B, 0x46, 0x7F, 0xFF, 0x0C, 0x10, 0x00 };
    sp_pos[8] = hc_onewire_crc8(sp_pos, 8);
    double temp = 0.0;
    assert(hc_ds18b20_decode_scratchpad(sp_pos, &temp) == true);
    assert(approx(temp, 25.06, 0.01));

    /* -10.125 C = -162 = 0xFF5E */
    uint8_t sp_neg[9] = { 0x5E, 0xFF, 0x4B, 0x46, 0x7F, 0xFF, 0x02, 0x10, 0x00 };
    sp_neg[8] = hc_onewire_crc8(sp_neg, 8);
    assert(hc_ds18b20_decode_scratchpad(sp_neg, &temp) == true);
    assert(approx(temp, -10.13, 0.01));

    /* Corrupted CRC rejected */
    sp_pos[8] ^= 0x01;
    assert(hc_ds18b20_decode_scratchpad(sp_pos, &temp) == false);

    /* Bus open/short fault (all 0x00 or all 0xFF) rejected */
    uint8_t all_zero[9] = {0};
    uint8_t all_ff[9] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
    assert(hc_ds18b20_decode_scratchpad(all_zero, &temp) == false);
    assert(hc_ds18b20_decode_scratchpad(all_ff, &temp) == false);
}

static void test_bme280_compensation(void) {
    /* Reference Bosch Sensortec BME280 datasheet calibration constants */
    hc_bme280_calib_t cal = {
        .dig_T1 = 27504, .dig_T2 = 26435, .dig_T3 = -1000,
        .dig_P1 = 36477, .dig_P2 = -10685, .dig_P3 = 3024,
        .dig_P4 = 2855,  .dig_P5 = 140,    .dig_P6 = -7,
        .dig_P7 = 15500, .dig_P8 = -14600, .dig_P9 = 6000,
        .dig_H1 = 75,    .dig_H2 = 370,    .dig_H3 = 0,
        .dig_H4 = 300,   .dig_H5 = 50,     .dig_H6 = 30,
    };

    /* Verify register unpacker reproduces calibration table accurately */
    uint8_t c1[26] = {
        (uint8_t)(27504 & 0xFF), (uint8_t)(27504 >> 8),
        (uint8_t)(26435 & 0xFF), (uint8_t)(26435 >> 8),
        (uint8_t)((uint16_t)-1000 & 0xFF), (uint8_t)((uint16_t)-1000 >> 8),
        (uint8_t)(36477 & 0xFF), (uint8_t)(36477 >> 8),
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 75
    };
    uint8_t c2[7] = {
        (uint8_t)(370 & 0xFF), (uint8_t)(370 >> 8),
        0,
        (uint8_t)(300 >> 4),
        (uint8_t)((300 & 0x0F) | ((50 & 0x0F) << 4)),
        (uint8_t)(50 >> 4),
        30
    };
    hc_bme280_calib_t parsed;
    hc_bme280_parse_calib(c1, c2, &parsed);
    assert(parsed.dig_T1 == 27504);
    assert(parsed.dig_T2 == 26435);
    assert(parsed.dig_T3 == -1000);
    assert(parsed.dig_P1 == 36477);
    assert(parsed.dig_H1 == 75);
    assert(parsed.dig_H2 == 370);
    assert(parsed.dig_H4 == 300);
    assert(parsed.dig_H5 == 50);
    assert(parsed.dig_H6 == 30);

    /* Datasheet raw sample: adc_T=519888, adc_P=415148 -> ~25.08 C, ~1006.53 hPa */
    hc_bme280_sample_t out;
    assert(hc_bme280_compensate(&cal, 519888, 415148, 28000, &out) == true);
    assert(approx(out.temp_c, 25.08, 0.05));
    assert(approx(out.pressure_hpa, 1006.53, 0.2));
    assert(out.humidity_pct >= 0.0 && out.humidity_pct <= 100.0);

    /* Uninitialized / skipped readings must fail safely */
    assert(hc_bme280_compensate(&cal, 0x80000, 415148, 28000, &out) == false);
    hc_bme280_calib_t zero_cal;
    memset(&zero_cal, 0, sizeof(zero_cal));
    assert(hc_bme280_compensate(&zero_cal, 519888, 415148, 28000, &out) == false);
}

static void test_bh1750_digital_and_adc(void) {
    /* BH1750: raw 300 (0x012C) / 1.2 = 250.0 lux */
    uint8_t raw_lux[2] = { 0x01, 0x2C };
    double lux = 0.0;
    assert(hc_bh1750_decode_lux(raw_lux, &lux) == true);
    assert(approx(lux, 250.0, 0.1));

    /* PIR active-high and inverted */
    assert(approx(hc_pir_decode(1, false), 1.0, 0.001));
    assert(approx(hc_pir_decode(0, false), 0.0, 0.001));
    assert(approx(hc_pir_decode(1, true), 0.0, 0.001));

    /* Reed switch (internal pull-up: 0 = closed, 1 = open) */
    assert(approx(hc_reed_decode(0, false), 0.0, 0.001));
    assert(approx(hc_reed_decode(1, false), 1.0, 0.001));
    assert(approx(hc_reed_decode(0, true), 1.0, 0.001));

    /* Calibrated ADC millivolt -> volt */
    double volts = 0.0;
    assert(hc_adc_mv_to_volts(1650, 1.0, &volts) == true && approx(volts, 1.65, 0.001));
    assert(hc_adc_mv_to_volts(1650, 2.0, &volts) == true && approx(volts, 3.30, 0.001));
    assert(hc_adc_mv_to_volts(-5, 1.0, &volts) == false);
    assert(hc_adc_mv_to_volts(9000, 1.0, &volts) == false);
}


static void test_expanded_driver_resolution(void) {
    assert(hc_sensor_resolve_driver("temperature_sht3x", NULL) == HC_DRV_SHT3X);
    assert(hc_sensor_resolve_driver("humidity_sht3x", NULL) == HC_DRV_SHT3X);
    assert(hc_sensor_resolve_driver("temperature_aht20", "sht3x") == HC_DRV_SHT3X);
    assert(hc_sensor_resolve_driver("presence_ld2410", NULL) == HC_DRV_LD2410);
    assert(hc_sensor_resolve_driver("voltage_ina219", NULL) == HC_DRV_INA219);
    assert(hc_sensor_resolve_driver("energy_ina226", NULL) == HC_DRV_INA226);
    assert(hc_sensor_resolve_driver("soil_moisture", NULL) == HC_DRV_SOIL_MOISTURE);
    assert(hc_sensor_resolve_driver("gas_mq135", NULL) == HC_DRV_MQ135);
    assert(strcmp(hc_sensor_driver_name(HC_DRV_SHT3X), "sht3x") == 0);
    assert(strcmp(hc_sensor_default_unit(HC_MEAS_CURRENT_INA226), "A") == 0);
    assert(strcmp(hc_sensor_default_unit(HC_MEAS_TVOC_SGP30), "ppb") == 0);
    assert(strcmp(hc_sensor_default_unit(HC_MEAS_DISTANCE_LD2410), "cm") == 0);
    assert(hc_sensor_driver_is_i2c(HC_DRV_INA219) == true);
    assert(hc_sensor_driver_is_i2c(HC_DRV_LD2410) == false);
    assert(hc_sensor_driver_default_i2c_addr(HC_DRV_AHT20) == 0x38);
    assert(hc_sensor_is_driver_in_mask(HC_DRV_BIT_SHT3X | HC_DRV_BIT_INA226, HC_DRV_INA219) == false);
}

static void test_shared_protocol_decoders(void) {
    double t = 0.0, h = 0.0, lux = 0.0, v = 0.0, pct = 0.0;

    /* DHT11: 23 C / 45 %RH, checksum is the low byte of the sum. */
    uint8_t dht11[5] = { 45, 0, 23, 0, 0 };
    dht11[4] = (uint8_t)(dht11[0] + dht11[1] + dht11[2] + dht11[3]);
    assert(hc_dht11_decode(dht11, &t, &h));
    assert(approx(t, 23.0, 0.01) && approx(h, 45.0, 0.01));
    dht11[4]++;
    assert(!hc_dht11_decode(dht11, &t, &h));

    /* SHT3x: 25 C (0x6266) / 50 %RH (0x8000), CRC-8 poly 0x31 init 0xFF. */
    uint8_t sht[6] = { 0x66, 0x66, 0, 0x80, 0x00, 0 };
    sht[2] = hc_sht3x_crc8(sht, 2);
    sht[5] = hc_sht3x_crc8(sht + 3, 2);
    assert(hc_sht3x_decode(sht, &t, &h));
    assert(approx(t, 25.0, 0.1) && approx(h, 50.0, 0.1));
    sht[1] ^= 0x01U;
    assert(!hc_sht3x_decode(sht, &t, &h));

    /* AHT20: ready (bit7=0) + calibrated (bit3=1), 50 %RH and 25 C. */
    uint8_t aht[6] = { 0x08, 0x80, 0x00, 0x06, 0x00, 0x00 };
    assert(hc_aht20_decode(aht, &t, &h));
    assert(approx(h, 50.0, 0.5));
    assert(approx(t, 25.0, 0.5));
    /* Reject busy (0x88) and uncalibrated (0x00). */
    assert(!hc_aht20_decode((const uint8_t[]){ 0x88, 0x80, 0x00, 0x06, 0x00, 0x00 }, &t, &h));
    assert(!hc_aht20_decode((const uint8_t[]){ 0x00, 0x80, 0x00, 0x06, 0x00, 0x00 }, &t, &h));

    /* TMP117 big-endian: 25.0 C = 3200 (0x0C80), 0.15625 C = 20 (0x0014), -10.0 C = 0xFB00. */
    uint8_t tmp[2] = { 0x00, 0x14 };
    assert(hc_tmp117_decode(tmp, &t) && approx(t, 0.156, 0.01));
    assert(hc_tmp117_decode((const uint8_t[]){ 0x0C, 0x80 }, &t) && approx(t, 25.0, 0.01));
    assert(hc_tmp117_decode((const uint8_t[]){ 0xFB, 0x00 }, &t) && approx(t, -10.0, 0.01));
    assert(!hc_tmp117_decode((const uint8_t[]){ 0x80, 0x00 }, &t));

    /* VEML7700 little-endian: {0x00, 0x01} = 256 counts * 0.2304 = 58.98 lx. */
    uint8_t veml[2] = { 0x00, 0x01 };
    assert(hc_veml7700_decode_lux(veml, &lux) && approx(lux, 58.98, 0.01));

    /* SGP30: bytes 0..1 = eCO2 (450 = 0x01C2), bytes 3..4 = TVOC (120 = 0x0078). */
    uint8_t sgp[6] = { 0x01, 0xC2, 0, 0x00, 0x78, 0 };
    sgp[2] = hc_sht3x_crc8(sgp, 2);
    sgp[5] = hc_sht3x_crc8(sgp + 3, 2);
    double tvoc = 0.0, eco2 = 0.0;
    assert(hc_sgp30_decode(sgp, &tvoc, &eco2));
    assert(approx(eco2, 450.0, 0.01) && approx(tvoc, 120.0, 0.01));
    sgp[2] ^= 0xFFU;
    assert(!hc_sgp30_decode(sgp, &tvoc, &eco2));

    /* INA219/INA226 big-endian: 0x5DC0 (24000) -> 12.0V (INA219 >>3 * 4mV) / 30.0V (INA226 * 1.25mV). */
    uint8_t ina[2] = { 0x5D, 0xC0 };
    assert(hc_ina_decode(ina, false, 0, 0.1, &v) && approx(v, 12.0, 0.01));
    assert(hc_ina_decode(ina, true, 0, 0.1, &v) && approx(v, 30.0, 0.01));
    /* INA226 0.5 A through 0.1 ohm -> shunt 50 mV -> 20000 = 0x4E20 big-endian. */
    uint8_t shunt[2] = { 0x4E, 0x20 };
    assert(hc_ina_decode(shunt, true, 1, 0.1, &v) && approx(v, 0.5, 0.01));
    /* INA226 6.0 W power (Cal=0x0200, 2.5 mW/LSB) -> 2400 = 0x0960 big-endian. */
    assert(hc_ina_decode((const uint8_t[]){ 0x09, 0x60 }, true, 2, 0.1, &v) && approx(v, 6.0, 0.01));
    /* INA219 6.0 W power (Cal=0x1000, 2.0 mW/LSB) -> 3000 = 0x0BB8 big-endian. */
    assert(hc_ina_decode((const uint8_t[]){ 0x0B, 0xB8 }, false, 2, 0.1, &v) && approx(v, 6.0, 0.01));

    /* Hi-Link LD2410 normal reporting frame (F4 F3 F2 F1 ... F8 F7 F6 F5):
       state=0x03 (moving+stationary), detection distance=180 cm (0x00B4 LE). */
    uint8_t ld[] = {
        0xF4, 0xF3, 0xF2, 0xF1, 0x0D, 0x00,
        0x02, 0xAA, 0x03,
        0xB4, 0x00, 0x46,
        0xC8, 0x00, 0x32,
        0xB4, 0x00,
        0x55, 0x00,
        0xF8, 0xF7, 0xF6, 0xF5
    };
    assert(hc_ld2410_parse_frame(ld, sizeof(ld), &v, &pct, &t));
    assert(approx(v, 1.0, 0.01) && approx(pct, 1.0, 0.01) && approx(t, 180.0, 0.01));
    /* Stationary-only target (state=0x02): presence=1, motion=0 */
    ld[8] = 0x02;
    assert(hc_ld2410_parse_frame(ld, sizeof(ld), &v, &pct, &t));
    assert(approx(v, 1.0, 0.01) && approx(pct, 0.0, 0.01));
    /* No target (state=0x00): presence=0, motion=0 */
    ld[8] = 0x00;
    assert(hc_ld2410_parse_frame(ld, sizeof(ld), &v, &pct, &t));
    assert(approx(v, 0.0, 0.01) && approx(pct, 0.0, 0.01));

    assert(hc_adc_percent(1650, 3300, &pct) && approx(pct, 50.0, 0.01));
    assert(!hc_adc_percent(-1, 3300, &pct));
    assert(approx(hc_mq_qualitative_pct(1650, 3300), 50.0, 0.01));
}

int main(void) {
    test_resolution_and_i2c_parsing();
    test_dht22_decoder();
    test_ds18b20_decoder();
    test_bme280_compensation();
    test_bh1750_digital_and_adc();
    test_expanded_driver_resolution();
    test_shared_protocol_decoders();
    printf("All sensor driver logic tests passed.\n");
    return 0;
}
