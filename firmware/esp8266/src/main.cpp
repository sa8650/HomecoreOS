/**
 * HomecoreOS ESP8266 Firmware Entry (nodemcu-esp8266)
 *
 * Isolated PlatformIO / Arduino-ESP8266 target — never built with ESP-IDF.
 * Shared protocol decoders come from firmware/main/sensor_driver_logic.c so
 * decoding stays identical to the ESP32 firmware. NodeMCU constraints are
 * enforced here: one ADC (A0), documented I2C SDA=GPIO4/SCL=GPIO5, no BLE,
 * no UART sensor drivers, small RAM footprint (<=8 configured sensors).
 *
 * Local configuration path: send one JSON line on the USB serial console:
 *   CFG:{"sensors":[{"id":"s1","sensorType":"temperature_sht3x",
 *     "driverId":"sht3x","gpioPin":4,"i2cAddress":"0x44"}]}
 * The line is parsed once, validated against the compiled driver list and
 * applied without rebooting. Telemetry is emitted as one JSON line per sample.
 */

#include <Arduino.h>
#include <Wire.h>
#include <ESP8266WiFi.h>
#include <ArduinoJson.h>
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
#ifndef HOMECORE_TELEMETRY_INTERVAL_MS
#define HOMECORE_TELEMETRY_INTERVAL_MS 5000
#endif

#define HC8266_MAX_SENSORS 8
#define HC8266_SERIAL_BUFFER 1024

struct Hc8266Binding {
    char id[40] = {0};
    char sensorType[40] = {0};
    char physicalId[40] = {0};
    hc_sensor_driver_id_t driver = HC_DRV_NONE;
    int16_t pin = -1;     /* primary role (SDA / data / ADC / GPIO) */
    int16_t aux = -1;     /* SCL when I2C */
    uint8_t addr = 0;
    double lastValue = 0;
    int64_t lastMs = 0;
    bool cached = false;
    const char *error = nullptr;
};

static Hc8266Binding s_sensors[HC8266_MAX_SENSORS];
static size_t s_sensorCount = 0;
static char s_serialBuffer[HC8266_SERIAL_BUFFER];
static size_t s_serialLength = 0;
static uint32_t s_lastSampleMs = 0;

static bool hc8266_driver_supported(hc_sensor_driver_id_t drv) {
    switch (drv) {
        case HC_DRV_DHT11:
        case HC_DRV_DHT22:
        case HC_DRV_DS18B20:
        case HC_DRV_BME280:
        case HC_DRV_SHT3X:
        case HC_DRV_AHT20:
        case HC_DRV_BH1750:
        case HC_DRV_VEML7700:
        case HC_DRV_PIR:
        case HC_DRV_REED:
        case HC_DRV_ADC_VOLTAGE:
        case HC_DRV_WATER_LEAK:
        case HC_DRV_WATER_LEVEL:
        case HC_DRV_SOIL_MOISTURE:
        case HC_DRV_RAIN:
            return true;
        default:
            /* UART, INA2xx, SGP30 and all planned drivers are not compiled. */
            return false;
    }
}

static bool hc8266_pin_usable(int pin) {
    /* NodeMCU: D0=16, D1=5, D2=4, D3=0 (BOOT), D4=2 (LED), D5..D8=14,12,13,15.
     * GPIO0 is boot strapping and GPIO17 is the internal A0 index (not a GPIO). */
    return pin == 4 || pin == 5 || pin == 12 || pin == 13 || pin == 14 || pin == 15 || pin == 16 || pin == 2;
}

static int16_t hc8266_role_pin(JsonObject resources, const char *role) {
    JsonObject pins = resources["pins"];
    if (pins.isNull()) return -1;
    if (pins[role].is<int>()) return (int16_t)pins[role].as<int>();
    return -1;
}

static bool hc8266_apply_config(const char *json) {
    StaticJsonDocument<2048> doc;
    DeserializationError err = deserializeJson(doc, json);
    if (err) {
        Serial.printf("CFG_ERROR:invalid_json (%s)\n", err.c_str());
        return false;
    }
    JsonArray sensors = doc["sensors"];
    if (sensors.isNull()) {
        Serial.println("CFG_ERROR:missing_sensors");
        return false;
    }
    Hc8266Binding next[HC8266_MAX_SENSORS];
    size_t count = 0;
    for (JsonObject item : sensors) {
        if (count >= HC8266_MAX_SENSORS) break;
        const char *type = item["sensorType"] | "";
        const char *explicit = item["driverId"] | "";
        hc_sensor_driver_id_t drv = hc_sensor_resolve_driver(type, explicit);
        if (!hc8266_driver_supported(drv)) {
            Serial.printf("CFG_ERROR:unsupported_driver %s\n", type);
            return false;
        }
        Hc8266Binding &b = next[count++];
        strlcpy(b.sensorType, type, sizeof(b.sensorType));
        b.driver = drv;
        int pin = item["gpioPin"] | -1;
        JsonObject resources = item["resources"];
        if (!resources.isNull()) {
            const char *roles[] = { "i2c_sda", "onewire", "adc", "gpio_in", "gpio_out", "gpio_bidirectional", nullptr };
            for (int i = 0; roles[i]; i++) {
                int16_t p = hc8266_role_pin(resources, roles[i]);
                if (p >= 0) { pin = p; break; }
            }
            b.aux = hc8266_role_pin(resources, "i2c_scl");
            const char *resAddr = resources["i2c_address"] | "";
            if (resAddr[0]) {
                bool valid = false;
                b.addr = hc_sensor_parse_i2c_addr(resAddr, hc_sensor_driver_default_i2c_addr(drv), &valid);
                if (!valid) { Serial.println("CFG_ERROR:invalid_i2c_address"); return false; }
            }
            const char *phys = resources["physicalId"] | item["physicalSensorId"] | "";
            strlcpy(b.physicalId, phys, sizeof(b.physicalId));
        }
        if (!b.addr) b.addr = hc_sensor_driver_default_i2c_addr(drv);
        if (hc_sensor_driver_is_i2c(drv)) {
            if (pin < 0) pin = HOMECORE_I2C_DEFAULT_SDA_GPIO;
            if (b.aux < 0) b.aux = HOMECORE_I2C_DEFAULT_SCL_GPIO;
            if (pin == b.aux || !hc8266_pin_usable(pin) || !hc8266_pin_usable(b.aux)) {
                Serial.println("CFG_ERROR:invalid_i2c_bus");
                return false;
            }
        } else if (drv == HC_DRV_ADC_VOLTAGE || drv == HC_DRV_WATER_LEVEL ||
                   drv == HC_DRV_SOIL_MOISTURE) {
            if (pin != HOMECORE_ADC_PIN) {
                Serial.println("CFG_ERROR:esp8266_has_one_adc_A0");
                return false;
            }
        } else if (pin < 0 || !hc8266_pin_usable(pin)) {
            Serial.println("CFG_ERROR:invalid_gpio");
            return false;
        }
        b.pin = (int16_t)pin;
        if (!b.addr && drv != HC_DRV_DHT11 && drv != HC_DRV_DHT22 && drv != HC_DRV_DS18B20 &&
            drv != HC_DRV_PIR && drv != HC_DRV_REED && drv != HC_DRV_WATER_LEAK &&
            drv != HC_DRV_RAIN && drv != HC_DRV_ADC_VOLTAGE && drv != HC_DRV_WATER_LEVEL &&
            drv != HC_DRV_SOIL_MOISTURE) {
            Serial.println("CFG_ERROR:missing_i2c_address");
            return false;
        }
        const char *id = item["id"] | "";
        strlcpy(b.id, id[0] ? id : b.sensorType, sizeof(b.id));
        pinMode((uint8_t)b.pin, b.driver == HC_DRV_PIR || b.driver == HC_DRV_REED ||
                b.driver == HC_DRV_WATER_LEAK || b.driver == HC_DRV_RAIN
                    ? INPUT_PULLUP : INPUT);
    }
    memcpy(s_sensors, next, sizeof(next));
    s_sensorCount = count;
    s_lastSampleMs = 0;
    Serial.printf("CFG_OK:sensors=%d\n", (int)s_sensorCount);
    return true;
}

/* ---------- Shared I2C helpers ---------- */

static bool hc8266_i2c_write(uint8_t addr, const uint8_t *data, size_t len) {
    Wire.beginTransmission(addr);
    Wire.write(data, len);
    return Wire.endTransmission() == 0;
}

static bool hc8266_i2c_read_reg(uint8_t addr, uint8_t reg, uint8_t *buf, size_t len) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    if (Wire.endTransmission() != 0) return false;
    Wire.requestFrom(addr, (uint8_t)len);
    size_t i = 0;
    while (Wire.available() && i < len) buf[i++] = (uint8_t)Wire.read();
    return i == len;
}

static bool hc8266_i2c_read(uint8_t addr, uint8_t *buf, size_t len) {
    Wire.requestFrom(addr, (uint8_t)len);
    size_t i = 0;
    while (Wire.available() && i < len) buf[i++] = (uint8_t)Wire.read();
    return i == len;
}

/* ---------- Protocol implementations ---------- */

static bool hc8266_read_dht(const Hc8266Binding &b, double *outT, double *outH) {
    if (b.pin < 0 || !hc8266_pin_usable(b.pin)) return false;
    uint8_t pin = (uint8_t)b.pin;
    pinMode(pin, OUTPUT);
    digitalWrite(pin, HIGH);
    delay(20);
    digitalWrite(pin, LOW);
    delay(b.driver == HC_DRV_DHT11 ? 18 : 2);
    digitalWrite(pin, HIGH);
    delayMicroseconds(b.driver == HC_DRV_DHT11 ? 30 : 30);
    pinMode(pin, INPUT_PULLUP);
    if (pulseIn(pin, LOW, 100) == 0 || pulseIn(pin, HIGH, 100) == 0) return false;
    uint8_t raw[5] = {0};
    for (int bit = 0; bit < 40; bit++) {
        if (pulseIn(pin, HIGH, 100) == 0) return false;
        uint32_t low = pulseIn(pin, LOW, 100);
        if (low == 0) return false;
        raw[bit / 8] <<= 1;
        if (low > 45) raw[bit / 8] |= 1;
    }
    return b.driver == HC_DRV_DHT11
        ? hc_dht11_decode(raw, outT, outH)
        : hc_dht22_decode(raw, outT, outH);
}

static bool hc8266_ow_reset(uint8_t pin) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
    delayMicroseconds(480);
    pinMode(pin, INPUT_PULLUP);
    delayMicroseconds(70);
    bool present = digitalRead(pin) == LOW;
    delayMicroseconds(410);
    return present;
}

static void hc8266_ow_write(uint8_t pin, uint8_t value) {
    for (int i = 0; i < 8; i++) {
        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
        delayMicroseconds(value & 0x01 ? 6 : 60);
        digitalWrite(pin, HIGH);
        delayMicroseconds(value & 0x01 ? 64 : 10);
        value >>= 1;
    }
    pinMode(pin, INPUT_PULLUP);
}

static uint8_t hc8266_ow_read(uint8_t pin) {
    uint8_t value = 0;
    for (int i = 0; i < 8; i++) {
        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
        delayMicroseconds(6);
        pinMode(pin, INPUT_PULLUP);
        delayMicroseconds(9);
        value >>= 1;
        if (digitalRead(pin)) value |= 0x80;
        delayMicroseconds(55);
    }
    return value;
}

static bool hc8266_read_ds18b20(const Hc8266Binding &b, double *outT) {
    uint8_t pin = (uint8_t)b.pin;
    if (!hc8266_ow_reset(pin)) return false;
    hc8266_ow_write(pin, 0xCC); /* skip ROM: one probe per pin is supported */
    hc8266_ow_write(pin, 0x44); /* convert */
    delay(750);
    if (!hc8266_ow_reset(pin)) return false;
    hc8266_ow_write(pin, 0xCC);
    hc8266_ow_write(pin, 0xBE); /* read scratchpad */
    uint8_t scratch[9] = {0};
    for (int i = 0; i < 9; i++) scratch[i] = hc8266_ow_read(pin);
    return hc_ds18b20_decode_scratchpad(scratch, outT);
}

static bool hc8266_read_bme280(const Hc8266Binding &b, hc_bme280_sample_t *out) {
    uint8_t id = 0, c1[26] = {0}, c2[7] = {0}, raw[8] = {0};
    if (!hc8266_i2c_read_reg(b.addr, 0xD0, &id, 1) || id != 0x60) return false;
    if (!hc8266_i2c_read_reg(b.addr, 0x88, c1, sizeof(c1)) ||
        !hc8266_i2c_read_reg(b.addr, 0xE1, c2, sizeof(c2))) return false;
    hc_bme280_calib_t cal;
    hc_bme280_parse_calib(c1, c2, &cal);
    const uint8_t cfg[] = { 0xF2, 0x01, 0xF5, 0x00, 0xF4, 0x25 };
    if (!hc8266_i2c_write(b.addr, cfg, sizeof(cfg))) return false;
    delay(30);
    if (!hc8266_i2c_read_reg(b.addr, 0xF7, raw, sizeof(raw))) return false;
    int32_t p = ((int32_t)raw[0] << 12) | ((int32_t)raw[1] << 4) | ((int32_t)raw[2] >> 4);
    int32_t t = ((int32_t)raw[3] << 12) | ((int32_t)raw[4] << 4) | ((int32_t)raw[5] >> 4);
    int32_t h = ((int32_t)raw[6] << 8) | (int32_t)raw[7];
    return hc_bme280_compensate(&cal, t, p, h, out);
}

static bool hc8266_read_sht3x(const Hc8266Binding &b, double *outT, double *outH) {
    const uint8_t cmd[] = { 0x2C, 0x06 };
    uint8_t raw[6] = {0};
    if (!hc8266_i2c_write(b.addr, cmd, sizeof(cmd))) return false;
    delay(25);
    return hc8266_i2c_read(b.addr, raw, sizeof(raw)) && hc_sht3x_decode(raw, outT, outH);
}

static bool hc8266_read_aht20(const Hc8266Binding &b, double *outT, double *outH) {
    uint8_t status = 0;
    if (!hc8266_i2c_read(b.addr, &status, 1)) return false;
    if ((status & 0x08U) == 0) {
        const uint8_t init[] = { 0xBE, 0x80, 0x00 };
        if (!hc8266_i2c_write(b.addr, init, sizeof(init))) return false;
        delay(10);
    }
    const uint8_t cmd[] = { 0xAC, 0x33, 0x00 };
    uint8_t raw[6] = {0};
    if (!hc8266_i2c_write(b.addr, cmd, sizeof(cmd))) return false;
    delay(80);
    return hc8266_i2c_read(b.addr, raw, sizeof(raw)) && hc_aht20_decode(raw, outT, outH);
}

static bool hc8266_read_bh1750(const Hc8266Binding &b, double *outLux) {
    const uint8_t power = 0x01, cont = 0x10;
    if (!hc8266_i2c_write(b.addr, &power, 1) || !hc8266_i2c_write(b.addr, &cont, 1)) return false;
    delay(150);
    uint8_t raw[2] = {0};
    return hc8266_i2c_read(b.addr, raw, sizeof(raw)) && hc_bh1750_decode_lux(raw, outLux);
}

static bool hc8266_read_veml7700(const Hc8266Binding &b, double *outLux) {
    const uint8_t cfg[] = { 0x00, 0x01 };
    uint8_t raw[2] = {0};
    if (!hc8266_i2c_write(b.addr, cfg, sizeof(cfg))) return false;
    delay(10);
    return hc8266_i2c_read_reg(b.addr, 0x04, raw, sizeof(raw)) && hc_veml7700_decode_lux(raw, outLux);
}

static bool hc8266_read_adc(const Hc8266Binding &b, double *outVolts) {
    if (b.pin != HOMECORE_ADC_PIN) return false; /* one ADC on NodeMCU */
    int32_t sum = 0;
    for (int i = 0; i < 8; i++) sum += analogRead(A0);
    int32_t mv = (int32_t)((((double)sum / 8.0) * 3300.0) / 1023.0);
    return hc_adc_mv_to_volts(mv, 1.0, outVolts);
}

static bool hc8266_read_sensor(Hc8266Binding &b, double *outValue) {
    hc_sensor_measurement_t meas = hc_sensor_resolve_measurement(b.sensorType);
    double t = 0, h = 0, lux = 0, volts = 0, pct = 0;
    switch (b.driver) {
        case HC_DRV_DHT11:
        case HC_DRV_DHT22:
            if (!hc8266_read_dht(b, &t, &h)) return false;
            *outValue = (meas == HC_MEAS_HUMIDITY_DHT11 || meas == HC_MEAS_HUMIDITY_DHT22) ? h : t;
            return true;
        case HC_DRV_DS18B20:
            return hc8266_read_ds18b20(b, outValue);
        case HC_DRV_BME280: {
            hc_bme280_sample_t sample;
            if (!hc8266_read_bme280(b, &sample)) return false;
            *outValue = meas == HC_MEAS_HUMIDITY ? sample.humidity_pct
                      : meas == HC_MEAS_PRESSURE ? sample.pressure_hpa : sample.temp_c;
            return true;
        }
        case HC_DRV_SHT3X:
            if (!hc8266_read_sht3x(b, &t, &h)) return false;
            *outValue = meas == HC_MEAS_HUMIDITY_SHT3X ? h : t;
            return true;
        case HC_DRV_AHT20:
            if (!hc8266_read_aht20(b, &t, &h)) return false;
            *outValue = meas == HC_MEAS_HUMIDITY_AHT20 ? h : t;
            return true;
        case HC_DRV_BH1750:
            if (!hc8266_read_bh1750(b, &lux)) return false;
            *outValue = lux;
            return true;
        case HC_DRV_VEML7700:
            if (!hc8266_read_veml7700(b, &lux)) return false;
            *outValue = lux;
            return true;
        case HC_DRV_PIR:
        case HC_DRV_RAIN:
        case HC_DRV_WATER_LEAK:
            *outValue = hc_pir_decode(digitalRead(b.pin), false);
            return true;
        case HC_DRV_REED:
            *outValue = hc_reed_decode(digitalRead(b.pin), false);
            return true;
        case HC_DRV_ADC_VOLTAGE:
        case HC_DRV_WATER_LEVEL:
        case HC_DRV_SOIL_MOISTURE:
            if (!hc8266_read_adc(b, &volts)) return false;
            if (b.driver == HC_DRV_ADC_VOLTAGE) { *outValue = volts; return true; }
            return hc_adc_percent((int32_t)(volts * 1000.0), 3300, outValue);
        default:
            return false;
    }
}

/** Reuse one physical sample across all measurement entities of that module. */
static bool hc8266_is_same_physical(const Hc8266Binding &a, const Hc8266Binding &b) {
    if (a.driver != b.driver) return false;
    if (a.physicalId[0] && b.physicalId[0]) return strcmp(a.physicalId, b.physicalId) == 0;
    return a.pin == b.pin && a.addr == b.addr;
}

static void hc8266_publish_telemetry() {
    StaticJsonDocument<1536> root;
    JsonArray sensors = root.createNestedArray("sensors");
    for (size_t i = 0; i < s_sensorCount; i++) {
        Hc8266Binding &b = s_sensors[i];
        int64_t now = (int64_t)millis();
        double value = 0;
        bool reuse = false;
        for (size_t j = 0; j < i; j++) {
            Hc8266Binding &peer = s_sensors[j];
            if (peer.cached && hc8266_is_same_physical(peer, b)) {
                value = peer.lastValue;
                reuse = true;
                break;
            }
        }
        bool ok = reuse || hc8266_read_sensor(b, &value);
        if (ok) { b.lastValue = value; b.lastMs = now; b.cached = true; b.error = nullptr; }
        else { b.cached = false; b.error = "read_failed"; }
        JsonObject item = sensors.createNestedObject();
        item["id"] = b.id;
        item["sensorType"] = b.sensorType;
        item["driverId"] = hc_sensor_driver_name(b.driver);
        item["ok"] = ok;
        item["value"] = ok ? value : 0;
        item["unit"] = hc_sensor_default_unit(hc_sensor_resolve_measurement(b.sensorType));
        if (!ok) item["error"] = b.error ? b.error : "read_failed";
    }
    root["board"] = HOMECORE_BOARD_SLUG;
    root["revision"] = 1;
    serializeJson(root, Serial);
    Serial.println();
}

static void hc8266_handle_serial_line(char *line) {
    while (*line == ' ' || *line == '\r' || *line == '\n') line++;
    if (strncmp(line, "CFG:", 4) == 0) hc8266_apply_config(line + 4);
    else if (strcmp(line, "MANIFEST") == 0) {
        Serial.println("{\"drivers\":[\"dht22\",\"dht11\",\"ds18b20\",\"bme280\",\"sht3x\","
                       "\"aht20\",\"bh1750\",\"veml7700\",\"pir\",\"reed\",\"adc_voltage\","
                       "\"water_leak\",\"water_level\",\"soil_moisture\",\"rain\"],"
                       "\"chip_family\":\"esp8266\",\"supports_ble\":false}");
    }
}

void setup() {
    Serial.begin(115200);
    delay(200);
    pinMode(HOMECORE_I2C_DEFAULT_SDA_GPIO, INPUT_PULLUP);
    pinMode(HOMECORE_I2C_DEFAULT_SCL_GPIO, INPUT_PULLUP);
    Wire.begin(HOMECORE_I2C_DEFAULT_SDA_GPIO, HOMECORE_I2C_DEFAULT_SCL_GPIO);
    WiFi.mode(WIFI_STA); /* no BLE on ESP8266 */
    Serial.printf(
        "HomecoreOS ESP8266 ready (board=%s, i2c=%d/%d, adc=A0/%d, ble=no, sensors=%d)\n",
        HOMECORE_BOARD_SLUG, HOMECORE_I2C_DEFAULT_SDA_GPIO,
        HOMECORE_I2C_DEFAULT_SCL_GPIO, HOMECORE_ADC_PIN, (int)s_sensorCount
    );
}

void loop() {
    while (Serial.available()) {
        char c = (char)Serial.read();
        if (c == '\n' || c == '\r') {
            s_serialBuffer[s_serialLength] = '\0';
            if (s_serialLength > 0) hc8266_handle_serial_line(s_serialBuffer);
            s_serialLength = 0;
        } else if (s_serialLength + 1 < HC8266_SERIAL_BUFFER) {
            s_serialBuffer[s_serialLength++] = c;
        }
    }
    uint32_t now = millis();
    if (s_sensorCount > 0 && (uint32_t)(now - s_lastSampleMs) >= HOMECORE_TELEMETRY_INTERVAL_MS) {
        s_lastSampleMs = now;
        hc8266_publish_telemetry();
    }
    delay(20);
}
