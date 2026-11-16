/**
 * HomecoreOS ESP8266 Firmware Entry (nodemcu-esp8266)
 *
 * Isolated from ESP-IDF v5.x builds; shares pure-C sensor protocol decoders
 * (`sensor_driver_logic.h`) and IO state parsing (`io_state_logic.h`) with the
 * main ESP-IDF codebase while respecting ESP8266 hardware constraints:
 *   - No BLE radio (Wi-Fi SoftAP / manual provisioning only)
 *   - Default I2C bus: SDA=GPIO4 (D2), SCL=GPIO5 (D1)
 *   - Dedicated 10-bit ADC input: A0 (pin index 17, 0..3.3V via NodeMCU divider)
 */

#include <Arduino.h>
#include <Wire.h>
#include <ESP8266WiFi.h>
#include "sensor_driver_logic.h"
#include "io_state_logic.h"

#ifndef HOMECORE_I2C_DEFAULT_SDA_GPIO
#define HOMECORE_I2C_DEFAULT_SDA_GPIO 4
#endif

#ifndef HOMECORE_I2C_DEFAULT_SCL_GPIO
#define HOMECORE_I2C_DEFAULT_SCL_GPIO 5
#endif

#ifndef HOMECORE_ADC_PIN
#define HOMECORE_ADC_PIN 17
#endif

static bool hc8266_read_adc_voltage(double *out_volts) {
    int32_t sum = 0;
    for (int i = 0; i < 8; i++) {
        sum += analogRead(A0);
    }
    int32_t avg = sum / 8;
    int32_t mv = (avg * 3300) / 1023;
    return hc_adc_mv_to_volts(mv, 1.0, out_volts);
}

static bool hc8266_read_bh1750(uint8_t addr, double *out_lux) {
    Wire.beginTransmission(addr);
    Wire.write(0x01);
    if (Wire.endTransmission() != 0) return false;
    Wire.beginTransmission(addr);
    Wire.write(0x20);
    if (Wire.endTransmission() != 0) return false;
    delay(150);
    if (Wire.requestFrom(addr, (uint8_t)2) != 2) return false;
    uint8_t raw[2] = { (uint8_t)Wire.read(), (uint8_t)Wire.read() };
    return hc_bh1750_decode_lux(raw, out_lux);
}

void setup() {
    Serial.begin(115200);
    delay(200);
    Wire.begin(HOMECORE_I2C_DEFAULT_SDA_GPIO, HOMECORE_I2C_DEFAULT_SCL_GPIO);
    WiFi.mode(WIFI_STA);
    Serial.printf(
        "HomecoreOS ESP8266 ready (board=%s, i2c=%d/%d, adc=A0/%d, ble=no)\n",
        HOMECORE_BOARD_SLUG,
        HOMECORE_I2C_DEFAULT_SDA_GPIO,
        HOMECORE_I2C_DEFAULT_SCL_GPIO,
        HOMECORE_ADC_PIN
    );
}

void loop() {
    double v = 0.0;
    if (hc8266_read_adc_voltage(&v)) {
        (void)v;
    }
    double lux = 0.0;
    (void)hc8266_read_bh1750(0x23, &lux);
    delay(5000);
}
