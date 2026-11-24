#include "sensor_drivers.h"
#include "homecore_config.h"

#include <math.h>
#include <string.h>
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#if defined(CONFIG_HOMECORE_DRIVER_DHT22) && CONFIG_HOMECORE_DRIVER_DHT22
#define HC_EN_DHT22 1
#else
#define HC_EN_DHT22 0
#endif

#if defined(CONFIG_HOMECORE_DRIVER_DS18B20) && CONFIG_HOMECORE_DRIVER_DS18B20
#define HC_EN_DS18B20 1
#else
#define HC_EN_DS18B20 0
#endif

#if defined(CONFIG_HOMECORE_DRIVER_BME280) && CONFIG_HOMECORE_DRIVER_BME280
#define HC_EN_BME280 1
#else
#define HC_EN_BME280 0
#endif

#if defined(CONFIG_HOMECORE_DRIVER_PIR) && CONFIG_HOMECORE_DRIVER_PIR
#define HC_EN_PIR 1
#else
#define HC_EN_PIR 0
#endif

#if defined(CONFIG_HOMECORE_DRIVER_REED) && CONFIG_HOMECORE_DRIVER_REED
#define HC_EN_REED 1
#else
#define HC_EN_REED 0
#endif

#if defined(CONFIG_HOMECORE_DRIVER_BH1750) && CONFIG_HOMECORE_DRIVER_BH1750
#define HC_EN_BH1750 1
#else
#define HC_EN_BH1750 0
#endif

#if defined(CONFIG_HOMECORE_DRIVER_ADC_VOLTAGE) && CONFIG_HOMECORE_DRIVER_ADC_VOLTAGE
#define HC_EN_ADC_VOLTAGE 1
#else
#define HC_EN_ADC_VOLTAGE 0
#endif

#if defined(CONFIG_HOMECORE_DRIVER_DHT11) && CONFIG_HOMECORE_DRIVER_DHT11
#define HC_EN_DHT11 1
#else
#define HC_EN_DHT11 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_SHT3X) && CONFIG_HOMECORE_DRIVER_SHT3X
#define HC_EN_SHT3X 1
#else
#define HC_EN_SHT3X 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_AHT20) && CONFIG_HOMECORE_DRIVER_AHT20
#define HC_EN_AHT20 1
#else
#define HC_EN_AHT20 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_TMP117) && CONFIG_HOMECORE_DRIVER_TMP117
#define HC_EN_TMP117 1
#else
#define HC_EN_TMP117 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_LD2410) && CONFIG_HOMECORE_DRIVER_LD2410
#define HC_EN_LD2410 1
#else
#define HC_EN_LD2410 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_LD2450) && CONFIG_HOMECORE_DRIVER_LD2450
#define HC_EN_LD2450 1
#else
#define HC_EN_LD2450 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_VEML7700) && CONFIG_HOMECORE_DRIVER_VEML7700
#define HC_EN_VEML7700 1
#else
#define HC_EN_VEML7700 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_SGP30) && CONFIG_HOMECORE_DRIVER_SGP30
#define HC_EN_SGP30 1
#else
#define HC_EN_SGP30 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_WATER_LEAK) && CONFIG_HOMECORE_DRIVER_WATER_LEAK
#define HC_EN_WATER_LEAK 1
#else
#define HC_EN_WATER_LEAK 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_WATER_LEVEL) && CONFIG_HOMECORE_DRIVER_WATER_LEVEL
#define HC_EN_WATER_LEVEL 1
#else
#define HC_EN_WATER_LEVEL 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_SOIL_MOISTURE) && CONFIG_HOMECORE_DRIVER_SOIL_MOISTURE
#define HC_EN_SOIL_MOISTURE 1
#else
#define HC_EN_SOIL_MOISTURE 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_RAIN) && CONFIG_HOMECORE_DRIVER_RAIN
#define HC_EN_RAIN 1
#else
#define HC_EN_RAIN 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_INA219) && CONFIG_HOMECORE_DRIVER_INA219
#define HC_EN_INA219 1
#else
#define HC_EN_INA219 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_INA226) && CONFIG_HOMECORE_DRIVER_INA226
#define HC_EN_INA226 1
#else
#define HC_EN_INA226 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_PZEM004T) && CONFIG_HOMECORE_DRIVER_PZEM004T
#define HC_EN_PZEM004T 1
#else
#define HC_EN_PZEM004T 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_SCT013) && CONFIG_HOMECORE_DRIVER_SCT013
#define HC_EN_SCT013 1
#else
#define HC_EN_SCT013 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_MQ2) && CONFIG_HOMECORE_DRIVER_MQ2
#define HC_EN_MQ2 1
#else
#define HC_EN_MQ2 0
#endif
#if defined(CONFIG_HOMECORE_DRIVER_MQ135) && CONFIG_HOMECORE_DRIVER_MQ135
#define HC_EN_MQ135 1
#else
#define HC_EN_MQ135 0
#endif

#if HC_EN_BME280 || HC_EN_BH1750 || HC_EN_SHT3X || HC_EN_AHT20 || HC_EN_TMP117 || \
    HC_EN_VEML7700 || HC_EN_SGP30 || HC_EN_INA219 || HC_EN_INA226
#include "driver/i2c_master.h"
#endif

#if HC_EN_LD2410
#include "driver/uart.h"
#endif

#if HC_EN_ADC_VOLTAGE || HC_EN_WATER_LEVEL || HC_EN_SOIL_MOISTURE || HC_EN_MQ2 || HC_EN_MQ135
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#endif

static const char *TAG = "hc_sensors";

uint32_t hc_sensor_drivers_compiled_mask(void) {
    uint32_t mask = 0;
#if HC_EN_DHT22
    mask |= HC_DRV_BIT_DHT22;
#endif
#if HC_EN_DS18B20
    mask |= HC_DRV_BIT_DS18B20;
#endif
#if HC_EN_BME280
    mask |= HC_DRV_BIT_BME280;
#endif
#if HC_EN_PIR
    mask |= HC_DRV_BIT_PIR;
#endif
#if HC_EN_REED
    mask |= HC_DRV_BIT_REED;
#endif
#if HC_EN_BH1750
    mask |= HC_DRV_BIT_BH1750;
#endif
#if HC_EN_ADC_VOLTAGE
    mask |= HC_DRV_BIT_ADC_VOLTAGE;
#endif
#if HC_EN_DHT11
    mask |= HC_DRV_BIT_DHT11;
#endif
#if HC_EN_SHT3X
    mask |= HC_DRV_BIT_SHT3X;
#endif
#if HC_EN_AHT20
    mask |= HC_DRV_BIT_AHT20;
#endif
#if HC_EN_TMP117
    mask |= HC_DRV_BIT_TMP117;
#endif
#if HC_EN_LD2410
    mask |= HC_DRV_BIT_LD2410;
#endif
#if HC_EN_LD2450
    mask |= HC_DRV_BIT_LD2450;
#endif
#if HC_EN_VEML7700
    mask |= HC_DRV_BIT_VEML7700;
#endif
#if HC_EN_SGP30
    mask |= HC_DRV_BIT_SGP30;
#endif
#if HC_EN_WATER_LEAK
    mask |= HC_DRV_BIT_WATER_LEAK;
#endif
#if HC_EN_WATER_LEVEL
    mask |= HC_DRV_BIT_WATER_LEVEL;
#endif
#if HC_EN_SOIL_MOISTURE
    mask |= HC_DRV_BIT_SOIL_MOISTURE;
#endif
#if HC_EN_RAIN
    mask |= HC_DRV_BIT_RAIN;
#endif
#if HC_EN_INA219
    mask |= HC_DRV_BIT_INA219;
#endif
#if HC_EN_INA226
    mask |= HC_DRV_BIT_INA226;
#endif
#if HC_EN_PZEM004T
    mask |= HC_DRV_BIT_PZEM004T;
#endif
#if HC_EN_SCT013
    mask |= HC_DRV_BIT_SCT013;
#endif
#if HC_EN_MQ2
    mask |= HC_DRV_BIT_MQ2;
#endif
#if HC_EN_MQ135
    mask |= HC_DRV_BIT_MQ135;
#endif
    return mask;
}

static int64_t now_ms(void) {
    return esp_timer_get_time() / 1000LL;
}

static hc_sensor_reading_t make_error_reading(
    hc_sensor_driver_id_t drv,
    hc_sensor_measurement_t meas,
    const char *error_code
) {
    hc_sensor_reading_t r = {
        .ok = false,
        .value = 0.0,
        .unit = hc_sensor_default_unit(meas),
        .driver_id = hc_sensor_driver_name(drv),
        .error_code = error_code ? error_code : "read_failed",
        .timestamp_ms = now_ms(),
    };
    return r;
}

static hc_sensor_reading_t make_ok_reading(
    hc_sensor_driver_id_t drv,
    hc_sensor_measurement_t meas,
    double value
) {
    hc_sensor_reading_t r = {
        .ok = true,
        .value = value,
        .unit = hc_sensor_default_unit(meas),
        .driver_id = hc_sensor_driver_name(drv),
        .error_code = NULL,
        .timestamp_ms = now_ms(),
    };
    return r;
}

/* ============================================================================
 * Shared I2C Bus Manager (BME280 & BH1750)
 * ============================================================================ */
#if HC_EN_BME280 || HC_EN_BH1750 || HC_EN_SHT3X || HC_EN_AHT20 || HC_EN_TMP117 || \
    HC_EN_VEML7700 || HC_EN_SGP30 || HC_EN_INA219 || HC_EN_INA226

#define HC_MAX_I2C_BUSES 2
#define HC_MAX_I2C_DEVS  8
#define HC_I2C_TIMEOUT_MS 120

typedef struct {
    bool in_use;
    int sda_pin;
    int scl_pin;
    i2c_master_bus_handle_t handle;
} hc_i2c_bus_slot_t;

typedef struct {
    bool in_use;
    int bus_idx;
    uint8_t addr;
    i2c_master_dev_handle_t handle;
    /* BME280 state */
    bool bme_calib_loaded;
    hc_bme280_calib_t bme_calib;
    bool bme_sample_valid;
    int64_t bme_sample_ms;
    hc_bme280_sample_t bme_sample;
    /* BH1750 / VEML7700 / SGP30 init state */
    bool bh_initialized;
    int64_t bh_init_ms;
    bool veml_initialized;
    bool sgp_initialized;
    /* Shared protocol-family sample cache (SHT3x/AHT20/TMP117/VEML/SGP30/INA2xx) */
    bool family_valid;
    hc_sensor_driver_id_t family_driver;
    int64_t family_ms;
    double family_a;   /* temperature / TVOC / bus voltage */
    double family_b;   /* humidity / eCO2 / current */
    double family_c;   /* power */
    double energy_wh;
    int64_t energy_ms;
} hc_i2c_dev_slot_t;

static hc_i2c_bus_slot_t s_i2c_buses[HC_MAX_I2C_BUSES];
static hc_i2c_dev_slot_t s_i2c_devs[HC_MAX_I2C_DEVS];

static bool resolve_i2c_pins(int16_t configured_pin, int16_t aux_scl_pin, int *out_sda, int *out_scl) {
    int def_sda = HOMECORE_I2C_DEFAULT_SDA_GPIO;
    int def_scl = HOMECORE_I2C_DEFAULT_SCL_GPIO;
    int sda = (configured_pin >= 0) ? (int)configured_pin : def_sda;
    int scl = (aux_scl_pin >= 0) ? (int)aux_scl_pin : def_scl;
    if (sda == scl && aux_scl_pin < 0 && def_sda >= 0 && def_sda != sda) {
        scl = def_sda;
    }
    if (sda < 0 || scl < 0 || sda == scl) {
        return false;
    }
    if (!hc_io_is_safe_gpio((uint8_t)sda) || !hc_io_is_safe_gpio((uint8_t)scl)) {
        return false;
    }
    if (!GPIO_IS_VALID_OUTPUT_GPIO((gpio_num_t)sda) || !GPIO_IS_VALID_OUTPUT_GPIO((gpio_num_t)scl)) {
        return false;
    }
    *out_sda = sda;
    *out_scl = scl;
    return true;
}

static int get_or_init_i2c_bus(int sda_pin, int scl_pin) {
    for (int i = 0; i < HC_MAX_I2C_BUSES; i++) {
        if (s_i2c_buses[i].in_use && s_i2c_buses[i].sda_pin == sda_pin && s_i2c_buses[i].scl_pin == scl_pin) {
            return i;
        }
    }
    int slot = -1;
    for (int i = 0; i < HC_MAX_I2C_BUSES; i++) {
        if (!s_i2c_buses[i].in_use) {
            slot = i;
            break;
        }
    }
    if (slot < 0) return -1;

    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = -1,
        .sda_io_num = (gpio_num_t)sda_pin,
        .scl_io_num = (gpio_num_t)scl_pin,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags = {
            .enable_internal_pullup = true,
        },
    };
    i2c_master_bus_handle_t bus_handle = NULL;
    esp_err_t err = i2c_new_master_bus(&bus_cfg, &bus_handle);
    if (err != ESP_OK || !bus_handle) {
        ESP_LOGW(TAG, "Failed to init I2C master bus (SDA=%d, SCL=%d): %s", sda_pin, scl_pin, esp_err_to_name(err));
        return -1;
    }
    s_i2c_buses[slot].in_use = true;
    s_i2c_buses[slot].sda_pin = sda_pin;
    s_i2c_buses[slot].scl_pin = scl_pin;
    s_i2c_buses[slot].handle = bus_handle;
    ESP_LOGI(TAG, "Initialized I2C master bus #%d (SDA=GPIO%d, SCL=GPIO%d)", slot, sda_pin, scl_pin);
    return slot;
}

static hc_i2c_dev_slot_t *get_or_init_i2c_dev_ex(int sda, int scl, uint8_t addr) {
    int bus_idx = get_or_init_i2c_bus(sda, scl);
    if (bus_idx < 0) return NULL;

    for (int i = 0; i < HC_MAX_I2C_DEVS; i++) {
        if (s_i2c_devs[i].in_use && s_i2c_devs[i].bus_idx == bus_idx && s_i2c_devs[i].addr == addr) {
            return &s_i2c_devs[i];
        }
    }
    int slot = -1;
    for (int i = 0; i < HC_MAX_I2C_DEVS; i++) {
        if (!s_i2c_devs[i].in_use) {
            slot = i;
            break;
        }
    }
    if (slot < 0) return NULL;

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = 100000,
    };
    i2c_master_dev_handle_t dev_handle = NULL;
    esp_err_t err = i2c_master_bus_add_device(s_i2c_buses[bus_idx].handle, &dev_cfg, &dev_handle);
    if (err != ESP_OK || !dev_handle) {
        ESP_LOGW(TAG, "Failed to attach I2C device 0x%02x: %s", addr, esp_err_to_name(err));
        return NULL;
    }

    memset(&s_i2c_devs[slot], 0, sizeof(s_i2c_devs[slot]));
    s_i2c_devs[slot].in_use = true;
    s_i2c_devs[slot].bus_idx = bus_idx;
    s_i2c_devs[slot].addr = addr;
    s_i2c_devs[slot].handle = dev_handle;
    return &s_i2c_devs[slot];
}

static hc_i2c_dev_slot_t *get_or_init_i2c_dev(const hc_sensor_binding_t *binding, uint8_t addr) {
    int sda = -1;
    int scl = -1;
    if (!binding || !resolve_i2c_pins(binding->gpio_pin, binding->aux_pin_a, &sda, &scl)) {
        return NULL;
    }
    return get_or_init_i2c_dev_ex(sda, scl, addr);
}

#if HC_EN_BME280 || HC_EN_SHT3X || HC_EN_AHT20 || HC_EN_VEML7700 || HC_EN_SGP30 || HC_EN_INA219 || HC_EN_INA226
static esp_err_t i2c_write_bytes(i2c_master_dev_handle_t dev, const uint8_t *buf, size_t len) {
    return i2c_master_transmit(dev, buf, len, HC_I2C_TIMEOUT_MS);
}
#endif

#if HC_EN_BME280 || HC_EN_TMP117 || HC_EN_VEML7700 || HC_EN_INA219 || HC_EN_INA226
static esp_err_t i2c_read_reg(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t *buf, size_t len) {
    return i2c_master_transmit_receive(dev, &reg, 1, buf, len, HC_I2C_TIMEOUT_MS);
}
#endif

#if HC_EN_BME280
static esp_err_t i2c_write_reg(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t val) {
    uint8_t payload[2] = { reg, val };
    return i2c_write_bytes(dev, payload, sizeof(payload));
}
#endif

static void reset_i2c_manager(void) {
    for (int i = 0; i < HC_MAX_I2C_DEVS; i++) {
        if (s_i2c_devs[i].in_use && s_i2c_devs[i].handle) {
            i2c_master_bus_rm_device(s_i2c_devs[i].handle);
        }
        memset(&s_i2c_devs[i], 0, sizeof(s_i2c_devs[i]));
    }
    for (int i = 0; i < HC_MAX_I2C_BUSES; i++) {
        if (s_i2c_buses[i].in_use && s_i2c_buses[i].handle) {
            i2c_del_master_bus(s_i2c_buses[i].handle);
        }
        memset(&s_i2c_buses[i], 0, sizeof(s_i2c_buses[i]));
    }
}
#endif

/* ============================================================================
 * BME280 I2C Driver (Temperature, Humidity, Barometric Pressure)
 * ============================================================================ */
#if HC_EN_BME280
static hc_sensor_reading_t read_bme280(
    const hc_sensor_binding_t *binding,
    hc_sensor_measurement_t meas,
    bool allow_cached
) {
    uint8_t addr = binding->i2c_addr != 0 ? binding->i2c_addr : 0x76;
    hc_i2c_dev_slot_t *dev = get_or_init_i2c_dev(binding, addr);
    if (!dev) {
        return make_error_reading(HC_DRV_BME280, meas, "i2c_bus_not_configured");
    }

    int64_t t_now = now_ms();
    if (allow_cached && dev->bme_sample_valid && (t_now - dev->bme_sample_ms) < 1500) {
        double v = (meas == HC_MEAS_HUMIDITY) ? dev->bme_sample.humidity_pct
                 : (meas == HC_MEAS_PRESSURE) ? dev->bme_sample.pressure_hpa
                 : dev->bme_sample.temp_c;
        return make_ok_reading(HC_DRV_BME280, meas, v);
    }

    if (!dev->bme_calib_loaded) {
        uint8_t chip_id = 0;
        if (i2c_read_reg(dev->handle, 0xD0, &chip_id, 1) != ESP_OK) {
            return make_error_reading(HC_DRV_BME280, meas, "i2c_nack");
        }
        if (chip_id != 0x60) {
            ESP_LOGW(TAG, "BME280 at 0x%02x unexpected chip_id=0x%02x (expected 0x60)", addr, chip_id);
            return make_error_reading(HC_DRV_BME280, meas, "chip_id_mismatch");
        }
        uint8_t c1[26] = {0};
        uint8_t c2[7] = {0};
        if (i2c_read_reg(dev->handle, 0x88, c1, sizeof(c1)) != ESP_OK ||
            i2c_read_reg(dev->handle, 0xE1, c2, sizeof(c2)) != ESP_OK) {
            return make_error_reading(HC_DRV_BME280, meas, "i2c_calib_read_failed");
        }
        hc_bme280_parse_calib(c1, c2, &dev->bme_calib);
        dev->bme_calib_loaded = true;
    }

    /* Trigger forced-mode oversampling x1 (H, T, P) */
    if (i2c_write_reg(dev->handle, 0xF2, 0x01) != ESP_OK ||
        i2c_write_reg(dev->handle, 0xF5, 0x00) != ESP_OK ||
        i2c_write_reg(dev->handle, 0xF4, 0x25) != ESP_OK) {
        dev->bme_calib_loaded = false;
        return make_error_reading(HC_DRV_BME280, meas, "i2c_nack");
    }

    /* Wait up to 40ms for measuring flag (bit 3 of status reg 0xF3) to clear */
    vTaskDelay(pdMS_TO_TICKS(15));
    for (int attempt = 0; attempt < 5; attempt++) {
        uint8_t st = 0;
        if (i2c_read_reg(dev->handle, 0xF3, &st, 1) == ESP_OK && (st & 0x08) == 0) {
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(5));
    }

    uint8_t raw[8] = {0};
    if (i2c_read_reg(dev->handle, 0xF7, raw, sizeof(raw)) != ESP_OK) {
        return make_error_reading(HC_DRV_BME280, meas, "i2c_read_failed");
    }

    int32_t adc_p = ((int32_t)raw[0] << 12) | ((int32_t)raw[1] << 4) | ((int32_t)raw[2] >> 4);
    int32_t adc_t = ((int32_t)raw[3] << 12) | ((int32_t)raw[4] << 4) | ((int32_t)raw[5] >> 4);
    int32_t adc_h = ((int32_t)raw[6] << 8) | (int32_t)raw[7];

    hc_bme280_sample_t sample = {0};
    if (!hc_bme280_compensate(&dev->bme_calib, adc_t, adc_p, adc_h, &sample)) {
        return make_error_reading(HC_DRV_BME280, meas, "compensation_range_error");
    }

    dev->bme_sample = sample;
    dev->bme_sample_ms = now_ms();
    dev->bme_sample_valid = true;

    double v = (meas == HC_MEAS_HUMIDITY) ? sample.humidity_pct
             : (meas == HC_MEAS_PRESSURE) ? sample.pressure_hpa
             : sample.temp_c;
    return make_ok_reading(HC_DRV_BME280, meas, v);
}
#endif

/* ============================================================================
 * BH1750 I2C Ambient Light Driver
 * ============================================================================ */
#if HC_EN_BH1750
static hc_sensor_reading_t read_bh1750(
    const hc_sensor_binding_t *binding,
    hc_sensor_measurement_t meas
) {
    uint8_t addr = binding->i2c_addr != 0 ? binding->i2c_addr : 0x23;
    hc_i2c_dev_slot_t *dev = get_or_init_i2c_dev(binding, addr);
    if (!dev) {
        return make_error_reading(HC_DRV_BH1750, meas, "i2c_bus_not_configured");
    }

    if (!dev->bh_initialized) {
        uint8_t power_on = 0x01;
        uint8_t cont_hres = 0x10;
        if (i2c_master_transmit(dev->handle, &power_on, 1, HC_I2C_TIMEOUT_MS) != ESP_OK ||
            i2c_master_transmit(dev->handle, &cont_hres, 1, HC_I2C_TIMEOUT_MS) != ESP_OK) {
            return make_error_reading(HC_DRV_BH1750, meas, "i2c_nack");
        }
        dev->bh_initialized = true;
        dev->bh_init_ms = now_ms();
        vTaskDelay(pdMS_TO_TICKS(180));
    }

    uint8_t raw[2] = {0};
    if (i2c_master_receive(dev->handle, raw, sizeof(raw), HC_I2C_TIMEOUT_MS) != ESP_OK) {
        dev->bh_initialized = false;
        return make_error_reading(HC_DRV_BH1750, meas, "i2c_read_failed");
    }

    double lux = 0.0;
    if (!hc_bh1750_decode_lux(raw, &lux)) {
        return make_error_reading(HC_DRV_BH1750, meas, "decode_failed");
    }
    return make_ok_reading(HC_DRV_BH1750, meas, lux);
}
#endif

/* ============================================================================
 * DHT11 / DHT22 / AM2302 Single-Wire Driver (with 2s per-pin sample cache)
 * ============================================================================ */
#if HC_EN_DHT22 || HC_EN_DHT11

#define HC_MAX_DHT_PINS 6

typedef struct {
    bool in_use;
    uint8_t pin;
    hc_sensor_driver_id_t drv;
    bool valid;
    int64_t last_read_ms;
    double temp_c;
    double humidity_pct;
} hc_dht_cache_t;

static hc_dht_cache_t s_dht_cache[HC_MAX_DHT_PINS];

static hc_dht_cache_t *find_dht_cache(uint8_t pin) {
    for (int i = 0; i < HC_MAX_DHT_PINS; i++) {
        if (s_dht_cache[i].in_use && s_dht_cache[i].pin == pin) return &s_dht_cache[i];
    }
    for (int i = 0; i < HC_MAX_DHT_PINS; i++) {
        if (!s_dht_cache[i].in_use) {
            memset(&s_dht_cache[i], 0, sizeof(s_dht_cache[i]));
            s_dht_cache[i].in_use = true;
            s_dht_cache[i].pin = pin;
            return &s_dht_cache[i];
        }
    }
    return NULL;
}

static int64_t wait_gpio_level_us(gpio_num_t pin, int target_level, int64_t timeout_us) {
    int64_t start = esp_timer_get_time();
    while (gpio_get_level(pin) != target_level) {
        if ((esp_timer_get_time() - start) > timeout_us) {
            return -1;
        }
    }
    return esp_timer_get_time() - start;
}

static bool dht_wants_humidity(hc_sensor_measurement_t meas) {
    return meas == HC_MEAS_HUMIDITY_DHT22 ||
           meas == HC_MEAS_HUMIDITY_DHT11 ||
           meas == HC_MEAS_HUMIDITY;
}

static hc_sensor_reading_t read_dht_family(
    const hc_sensor_binding_t *binding,
    hc_sensor_driver_id_t drv,
    hc_sensor_measurement_t meas,
    bool allow_cached
) {
    if (binding->gpio_pin < 0 || !hc_io_is_safe_gpio((uint8_t)binding->gpio_pin) ||
        !GPIO_IS_VALID_OUTPUT_GPIO((gpio_num_t)binding->gpio_pin)) {
        return make_error_reading(drv, meas, "invalid_gpio");
    }

    uint8_t pin_u8 = (uint8_t)binding->gpio_pin;
    gpio_num_t pin = (gpio_num_t)pin_u8;
    hc_dht_cache_t *cache = find_dht_cache(pin_u8);
    int64_t t_now = now_ms();

    /* DHT11/DHT22 hardware requires >= 2 seconds between conversions */
    if (cache && cache->valid && cache->drv == drv &&
        (allow_cached || (t_now - cache->last_read_ms) < 2000) &&
        (t_now - cache->last_read_ms) < 2500) {
        double v = dht_wants_humidity(meas) ? cache->humidity_pct : cache->temp_c;
        return make_ok_reading(drv, meas, v);
    }

    /* Send host start signal: DHT11 requires >=18 ms LOW; DHT22 uses >=1-2 ms LOW. */
    gpio_set_direction(pin, GPIO_MODE_OUTPUT);
    gpio_set_level(pin, 0);
    vTaskDelay(pdMS_TO_TICKS(drv == HC_DRV_DHT11 ? 20 : 2));
    gpio_set_level(pin, 1);
    esp_rom_delay_us(30);
    gpio_set_direction(pin, GPIO_MODE_INPUT);
    gpio_set_pull_mode(pin, GPIO_PULLUP_ONLY);

    /* Sensor response handshake: LOW (~80us) -> HIGH (~80us) -> LOW (start of bit 0) */
    if (wait_gpio_level_us(pin, 0, 120) < 0 ||
        wait_gpio_level_us(pin, 1, 140) < 0 ||
        wait_gpio_level_us(pin, 0, 140) < 0) {
        return make_error_reading(drv, meas, "no_response");
    }

    uint8_t bytes[5] = {0};
    for (int bit = 0; bit < 40; bit++) {
        if (wait_gpio_level_us(pin, 1, 100) < 0) {
            return make_error_reading(drv, meas, "timeout");
        }
        int64_t high_us = wait_gpio_level_us(pin, 0, 120);
        if (high_us < 0) {
            return make_error_reading(drv, meas, "timeout");
        }
        bytes[bit / 8] <<= 1;
        if (high_us > 45) {
            bytes[bit / 8] |= 1U;
        }
    }

    double temp_c = 0.0;
    double hum_pct = 0.0;
    bool decoded = false;
    if (drv == HC_DRV_DHT11) {
        decoded = hc_dht11_decode(bytes, &temp_c, &hum_pct);
    } else {
        decoded = hc_dht22_decode(bytes, &temp_c, &hum_pct);
    }
    if (!decoded) {
        return make_error_reading(drv, meas, "checksum_failed");
    }

    if (cache) {
        cache->drv = drv;
        cache->temp_c = temp_c;
        cache->humidity_pct = hum_pct;
        cache->last_read_ms = now_ms();
        cache->valid = true;
    }

    double v = dht_wants_humidity(meas) ? hum_pct : temp_c;
    return make_ok_reading(drv, meas, v);
}
#endif

/* ============================================================================
 * DS18B20 1-Wire Temperature Driver (Dallas/Maxim CRC-8 verified)
 * ============================================================================ */
#if HC_EN_DS18B20

#define HC_MAX_OW_PINS 6

typedef struct {
    bool in_use;
    uint8_t pin;
    bool valid;
    int64_t last_read_ms;
    double temp_c;
} hc_ow_cache_t;

static hc_ow_cache_t s_ow_cache[HC_MAX_OW_PINS];
static portMUX_TYPE s_ow_mux = portMUX_INITIALIZER_UNLOCKED;

static hc_ow_cache_t *find_ow_cache(uint8_t pin) {
    for (int i = 0; i < HC_MAX_OW_PINS; i++) {
        if (s_ow_cache[i].in_use && s_ow_cache[i].pin == pin) return &s_ow_cache[i];
    }
    for (int i = 0; i < HC_MAX_OW_PINS; i++) {
        if (!s_ow_cache[i].in_use) {
            memset(&s_ow_cache[i], 0, sizeof(s_ow_cache[i]));
            s_ow_cache[i].in_use = true;
            s_ow_cache[i].pin = pin;
            return &s_ow_cache[i];
        }
    }
    return NULL;
}

static bool ow_reset(gpio_num_t pin) {
    gpio_set_direction(pin, GPIO_MODE_OUTPUT_OD);
    gpio_set_pull_mode(pin, GPIO_PULLUP_ONLY);
    gpio_set_level(pin, 0);
    esp_rom_delay_us(480);

    portENTER_CRITICAL(&s_ow_mux);
    gpio_set_level(pin, 1);
    esp_rom_delay_us(70);
    int presence = gpio_get_level(pin);
    portEXIT_CRITICAL(&s_ow_mux);

    esp_rom_delay_us(410);
    return presence == 0;
}

static void ow_write_bit(gpio_num_t pin, uint8_t bit) {
    portENTER_CRITICAL(&s_ow_mux);
    gpio_set_level(pin, 0);
    if (bit) {
        esp_rom_delay_us(6);
        gpio_set_level(pin, 1);
        esp_rom_delay_us(64);
    } else {
        esp_rom_delay_us(60);
        gpio_set_level(pin, 1);
        esp_rom_delay_us(10);
    }
    portEXIT_CRITICAL(&s_ow_mux);
}

static uint8_t ow_read_bit(gpio_num_t pin) {
    portENTER_CRITICAL(&s_ow_mux);
    gpio_set_level(pin, 0);
    esp_rom_delay_us(6);
    gpio_set_level(pin, 1);
    esp_rom_delay_us(9);
    uint8_t bit = (uint8_t)(gpio_get_level(pin) ? 1U : 0U);
    portEXIT_CRITICAL(&s_ow_mux);
    esp_rom_delay_us(55);
    return bit;
}

static void ow_write_byte(gpio_num_t pin, uint8_t byte) {
    for (int i = 0; i < 8; i++) {
        ow_write_bit(pin, (byte >> i) & 0x01U);
    }
}

static uint8_t ow_read_byte(gpio_num_t pin) {
    uint8_t byte = 0;
    for (int i = 0; i < 8; i++) {
        if (ow_read_bit(pin)) {
            byte |= (uint8_t)(1U << i);
        }
    }
    return byte;
}

static hc_sensor_reading_t read_ds18b20(
    const hc_sensor_binding_t *binding,
    hc_sensor_measurement_t meas,
    bool allow_cached
) {
    if (binding->gpio_pin < 0 || !hc_io_is_safe_gpio((uint8_t)binding->gpio_pin) ||
        !GPIO_IS_VALID_OUTPUT_GPIO((gpio_num_t)binding->gpio_pin)) {
        return make_error_reading(HC_DRV_DS18B20, meas, "invalid_gpio");
    }

    uint8_t pin_u8 = (uint8_t)binding->gpio_pin;
    gpio_num_t pin = (gpio_num_t)pin_u8;
    hc_ow_cache_t *cache = find_ow_cache(pin_u8);
    int64_t t_now = now_ms();

    if (allow_cached && cache && cache->valid && (t_now - cache->last_read_ms) < 3000) {
        return make_ok_reading(HC_DRV_DS18B20, meas, cache->temp_c);
    }

    if (!ow_reset(pin)) {
        return make_error_reading(HC_DRV_DS18B20, meas, "no_presence");
    }
    ow_write_byte(pin, 0xCC); /* Skip ROM */
    ow_write_byte(pin, 0x44); /* Convert T */

    /* 12-bit DS18B20 conversion takes up to 750ms; yield task during conversion */
    vTaskDelay(pdMS_TO_TICKS(750));

    if (!ow_reset(pin)) {
        return make_error_reading(HC_DRV_DS18B20, meas, "no_presence");
    }
    ow_write_byte(pin, 0xCC); /* Skip ROM */
    ow_write_byte(pin, 0xBE); /* Read Scratchpad */

    uint8_t scratchpad[9] = {0};
    for (int i = 0; i < 9; i++) {
        scratchpad[i] = ow_read_byte(pin);
    }

    double temp_c = 0.0;
    if (!hc_ds18b20_decode_scratchpad(scratchpad, &temp_c)) {
        return make_error_reading(HC_DRV_DS18B20, meas, "crc_failed");
    }

    if (cache) {
        cache->temp_c = temp_c;
        cache->last_read_ms = now_ms();
        cache->valid = true;
    }
    return make_ok_reading(HC_DRV_DS18B20, meas, temp_c);
}
#endif

/* ============================================================================
 * Calibrated ADC Oneshot Voltage Driver (shared by all analog families)
 * ============================================================================ */
#if HC_EN_ADC_VOLTAGE || HC_EN_WATER_LEVEL || HC_EN_SOIL_MOISTURE || HC_EN_MQ2 || HC_EN_MQ135

#define HC_MAX_ADC_UNITS 2

typedef struct {
    bool initialized;
    adc_oneshot_unit_handle_t unit_handle;
    bool cali_ready;
    adc_cali_handle_t cali_handle;
} hc_adc_unit_slot_t;

static hc_adc_unit_slot_t s_adc_units[HC_MAX_ADC_UNITS];

static bool ensure_adc_unit(adc_unit_t unit_id) {
    int idx = (int)unit_id;
    if (idx < 0 || idx >= HC_MAX_ADC_UNITS) return false;
    if (s_adc_units[idx].initialized) return true;

    adc_oneshot_unit_init_cfg_t init_cfg = {
        .unit_id = unit_id,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    if (adc_oneshot_new_unit(&init_cfg, &s_adc_units[idx].unit_handle) != ESP_OK) {
        return false;
    }
    s_adc_units[idx].initialized = true;

#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
    adc_cali_curve_fitting_config_t cali_cfg = {
        .unit_id = unit_id,
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    if (adc_cali_create_scheme_curve_fitting(&cali_cfg, &s_adc_units[idx].cali_handle) == ESP_OK) {
        s_adc_units[idx].cali_ready = true;
    }
#elif ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
    adc_cali_line_fitting_config_t cali_cfg = {
        .unit_id = unit_id,
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    if (adc_cali_create_scheme_line_fitting(&cali_cfg, &s_adc_units[idx].cali_handle) == ESP_OK) {
        s_adc_units[idx].cali_ready = true;
    }
#endif
    return true;
}

#if HC_EN_ADC_VOLTAGE
static hc_sensor_reading_t read_adc_voltage(
    const hc_sensor_binding_t *binding,
    hc_sensor_measurement_t meas
) {
    if (binding->gpio_pin < 0 || !hc_io_is_safe_gpio((uint8_t)binding->gpio_pin)) {
        return make_error_reading(HC_DRV_ADC_VOLTAGE, meas, "invalid_gpio");
    }

    adc_unit_t unit_id;
    adc_channel_t channel;
    if (adc_oneshot_io_to_channel((int)binding->gpio_pin, &unit_id, &channel) != ESP_OK) {
        return make_error_reading(HC_DRV_ADC_VOLTAGE, meas, "adc_channel_invalid");
    }
    if (!ensure_adc_unit(unit_id)) {
        return make_error_reading(HC_DRV_ADC_VOLTAGE, meas, "adc_init_failed");
    }

    hc_adc_unit_slot_t *slot = &s_adc_units[(int)unit_id];
    adc_oneshot_chan_cfg_t chan_cfg = {
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    if (adc_oneshot_config_channel(slot->unit_handle, channel, &chan_cfg) != ESP_OK) {
        return make_error_reading(HC_DRV_ADC_VOLTAGE, meas, "adc_config_failed");
    }

    int32_t raw_sum = 0;
    const int samples = 8;
    for (int i = 0; i < samples; i++) {
        int raw = 0;
        if (adc_oneshot_read(slot->unit_handle, channel, &raw) != ESP_OK) {
            return make_error_reading(HC_DRV_ADC_VOLTAGE, meas, "adc_read_failed");
        }
        raw_sum += raw;
    }
    int raw_avg = (int)(raw_sum / samples);
    int mv = 0;
    if (slot->cali_ready && adc_cali_raw_to_voltage(slot->cali_handle, raw_avg, &mv) == ESP_OK) {
        /* calibrated millivolts */
    } else {
        /* Fallback linear scaling for uncalibrated chips */
        mv = (int)((raw_avg * 3300LL) / 4095LL);
    }

    double volts = 0.0;
    if (!hc_adc_mv_to_volts(mv, 1.0, &volts)) {
        return make_error_reading(HC_DRV_ADC_VOLTAGE, meas, "adc_range_error");
    }
    return make_ok_reading(HC_DRV_ADC_VOLTAGE, meas, volts);
}
#endif

static void reset_adc_manager(void) {
    for (int i = 0; i < HC_MAX_ADC_UNITS; i++) {
        if (s_adc_units[i].cali_ready && s_adc_units[i].cali_handle) {
#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
            adc_cali_delete_scheme_curve_fitting(s_adc_units[i].cali_handle);
#elif ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
            adc_cali_delete_scheme_line_fitting(s_adc_units[i].cali_handle);
#endif
        }
        if (s_adc_units[i].initialized && s_adc_units[i].unit_handle) {
            adc_oneshot_del_unit(s_adc_units[i].unit_handle);
        }
        memset(&s_adc_units[i], 0, sizeof(s_adc_units[i]));
    }
}
#endif


/* ============================================================================
 * Expanded physical drivers: shared protocol families and model decoding.
 * One physical read refreshes a cached sample reused by every measurement of
 * the same hardware module (no duplicate I2C/UART transactions).
 * ============================================================================ */

#if HC_EN_SHT3X || HC_EN_AHT20 || HC_EN_TMP117 || HC_EN_VEML7700 || HC_EN_SGP30 || \
    HC_EN_INA219 || HC_EN_INA226
static double family_value_for(hc_sensor_measurement_t meas, const hc_i2c_dev_slot_t *dev) {
    switch (meas) {
        case HC_MEAS_TEMPERATURE_SHT3X:
        case HC_MEAS_TEMPERATURE_AHT20:
        case HC_MEAS_TEMPERATURE_TMP117:
            return dev->family_a;
        case HC_MEAS_HUMIDITY_SHT3X:
        case HC_MEAS_HUMIDITY_AHT20:
            return dev->family_b;
        case HC_MEAS_LIGHT_VEML7700:
            return dev->family_a;
        case HC_MEAS_TVOC_SGP30:
            return dev->family_a;
        case HC_MEAS_ECO2_SGP30:
            return dev->family_b;
        case HC_MEAS_VOLTAGE_INA219:
        case HC_MEAS_VOLTAGE_INA226:
            return dev->family_a;
        case HC_MEAS_CURRENT_INA219:
        case HC_MEAS_CURRENT_INA226:
            return dev->family_b;
        case HC_MEAS_POWER_INA219:
        case HC_MEAS_POWER_INA226:
            return dev->family_c;
        case HC_MEAS_ENERGY_INA226:
            return dev->energy_wh;
        default:
            return 0.0;
    }
}

static int64_t family_interval_ms(hc_sensor_driver_id_t drv) {
    switch (drv) {
        case HC_DRV_SHT3X: return 1000;
        case HC_DRV_AHT20: return 2000;
        case HC_DRV_TMP117: return 1000;
        case HC_DRV_VEML7700: return 500;
        case HC_DRV_SGP30: return 1000;
        case HC_DRV_INA219:
        case HC_DRV_INA226: return 500;
        default: return 1000;
    }
}

static hc_sensor_reading_t read_i2c_family(
    const hc_sensor_binding_t *binding,
    hc_sensor_driver_id_t drv,
    hc_sensor_measurement_t meas,
    bool allow_cached
) {
    uint8_t addr = binding->i2c_addr != 0 ? binding->i2c_addr : hc_sensor_driver_default_i2c_addr(drv);
    hc_i2c_dev_slot_t *dev = get_or_init_i2c_dev(binding, addr);
    if (!dev) return make_error_reading(drv, meas, "i2c_bus_not_configured");

    int64_t t_now = now_ms();
    if (allow_cached && dev->family_valid && dev->family_driver == drv &&
        (t_now - dev->family_ms) < family_interval_ms(drv)) {
        return make_ok_reading(drv, meas, family_value_for(meas, dev));
    }

    bool ok = false;
    switch (drv) {
#if HC_EN_SHT3X
        case HC_DRV_SHT3X: {
            /* High repeatability, clock stretching disabled: 0x2C 0x06. */
            const uint8_t cmd[2] = { 0x2C, 0x06 };
            uint8_t raw[6] = {0};
            if (i2c_write_bytes(dev->handle, cmd, sizeof(cmd)) != ESP_OK) {
                return make_error_reading(drv, meas, "i2c_nack");
            }
            vTaskDelay(pdMS_TO_TICKS(25));
            if (i2c_master_receive(dev->handle, raw, sizeof(raw), HC_I2C_TIMEOUT_MS) != ESP_OK) {
                return make_error_reading(drv, meas, "i2c_read_failed");
            }
            double t = 0.0, h = 0.0;
            if (!hc_sht3x_decode(raw, &t, &h)) {
                return make_error_reading(drv, meas, "sht3x_crc_failed");
            }
            dev->family_a = t;
            dev->family_b = h;
            ok = true;
            break;
        }
#endif
#if HC_EN_AHT20
        case HC_DRV_AHT20: {
            uint8_t status = 0;
            if (i2c_master_receive(dev->handle, &status, 1, HC_I2C_TIMEOUT_MS) != ESP_OK) {
                return make_error_reading(drv, meas, "i2c_nack");
            }
            if ((status & 0x08U) == 0) {
                /* AHT20 datasheet calibration init command: 0xBE 0x08 0x00 */
                const uint8_t init_cmd[3] = { 0xBE, 0x08, 0x00 };
                if (i2c_write_bytes(dev->handle, init_cmd, sizeof(init_cmd)) != ESP_OK) {
                    return make_error_reading(drv, meas, "aht20_init_failed");
                }
                vTaskDelay(pdMS_TO_TICKS(10));
            }
            const uint8_t measure_cmd[3] = { 0xAC, 0x33, 0x00 };
            uint8_t raw[6] = {0};
            if (i2c_write_bytes(dev->handle, measure_cmd, sizeof(measure_cmd)) != ESP_OK) {
                return make_error_reading(drv, meas, "i2c_nack");
            }
            vTaskDelay(pdMS_TO_TICKS(80));
            if (i2c_master_receive(dev->handle, raw, sizeof(raw), HC_I2C_TIMEOUT_MS) != ESP_OK) {
                return make_error_reading(drv, meas, "i2c_read_failed");
            }
            double t = 0.0, h = 0.0;
            if (!hc_aht20_decode(raw, &t, &h)) {
                return make_error_reading(drv, meas, "aht20_not_ready");
            }
            dev->family_a = t;
            dev->family_b = h;
            ok = true;
            break;
        }
#endif
#if HC_EN_TMP117
        case HC_DRV_TMP117: {
            uint8_t raw[2] = {0};
            if (i2c_read_reg(dev->handle, 0x00, raw, sizeof(raw)) != ESP_OK) {
                return make_error_reading(drv, meas, "i2c_read_failed");
            }
            double t = 0.0;
            if (!hc_tmp117_decode(raw, &t)) return make_error_reading(drv, meas, "tmp117_fault");
            dev->family_a = t;
            ok = true;
            break;
        }
#endif
#if HC_EN_VEML7700
        case HC_DRV_VEML7700: {
            if (!dev->veml_initialized) {
                /* Reg 0x00 [LSB, MSB]: ALS_SD=0 (power on), IT=100 ms, Gain=1/4 (0x1800). */
                const uint8_t cfg[3] = { 0x00, 0x00, 0x18 };
                if (i2c_write_bytes(dev->handle, cfg, sizeof(cfg)) != ESP_OK) {
                    return make_error_reading(drv, meas, "i2c_nack");
                }
                dev->veml_initialized = true;
                vTaskDelay(pdMS_TO_TICKS(110));
            }
            uint8_t raw[2] = {0};
            if (i2c_read_reg(dev->handle, 0x04, raw, sizeof(raw)) != ESP_OK) {
                dev->veml_initialized = false;
                return make_error_reading(drv, meas, "i2c_read_failed");
            }
            double lux = 0.0;
            if (!hc_veml7700_decode_lux(raw, &lux)) {
                return make_error_reading(drv, meas, "decode_failed");
            }
            dev->family_a = lux;
            ok = true;
            break;
        }
#endif
#if HC_EN_SGP30
        case HC_DRV_SGP30: {
            if (!dev->sgp_initialized) {
                const uint8_t init_cmd[2] = { 0x20, 0x03 }; /* sgp30_iaq_init */
                if (i2c_write_bytes(dev->handle, init_cmd, sizeof(init_cmd)) != ESP_OK) {
                    return make_error_reading(drv, meas, "i2c_nack");
                }
                dev->sgp_initialized = true;
                vTaskDelay(pdMS_TO_TICKS(15));
            }
            const uint8_t meas_cmd[2] = { 0x20, 0x08 }; /* sgp30_measure_iaq */
            uint8_t raw[6] = {0};
            if (i2c_write_bytes(dev->handle, meas_cmd, sizeof(meas_cmd)) != ESP_OK) {
                dev->sgp_initialized = false;
                return make_error_reading(drv, meas, "i2c_nack");
            }
            vTaskDelay(pdMS_TO_TICKS(20));
            if (i2c_master_receive(dev->handle, raw, sizeof(raw), HC_I2C_TIMEOUT_MS) != ESP_OK) {
                dev->sgp_initialized = false;
                return make_error_reading(drv, meas, "i2c_read_failed");
            }
            double tvoc = 0.0, eco2 = 0.0;
            if (!hc_sgp30_decode(raw, &tvoc, &eco2)) {
                return make_error_reading(drv, meas, "sgp30_crc_failed");
            }
            dev->family_a = tvoc;
            dev->family_b = eco2;
            ok = true;
            break;
        }
#endif
#if HC_EN_INA219 || HC_EN_INA226
        case HC_DRV_INA219:
        case HC_DRV_INA226: {
            bool ina226 = drv == HC_DRV_INA226;
            /* 0.1 ohm shunt: Cal=0x1000 (INA219) / 0x0200 (INA226) -> 100 uA/bit.
               INA219 config 0x399F = 32V bus range, +/-320mV PGA /8, 12-bit cont. */
            const uint8_t cfg[3] = { 0x00,
                ina226 ? 0x41 : 0x39, ina226 ? 0x27 : 0x9F };
            const uint8_t cal[3] = { 0x05,
                ina226 ? 0x02 : 0x10, 0x00 };
            if (i2c_write_bytes(dev->handle, cfg, sizeof(cfg)) != ESP_OK ||
                i2c_write_bytes(dev->handle, cal, sizeof(cal)) != ESP_OK) {
                return make_error_reading(drv, meas, "i2c_nack");
            }
            /* Reg 0x02 = Bus Voltage, Reg 0x01 = Shunt Voltage, Reg 0x03 = Power */
            uint8_t bus[2] = {0}, shunt[2] = {0}, power[2] = {0};
            if (i2c_read_reg(dev->handle, 0x02, bus, sizeof(bus)) != ESP_OK ||
                i2c_read_reg(dev->handle, 0x01, shunt, sizeof(shunt)) != ESP_OK ||
                i2c_read_reg(dev->handle, 0x03, power, sizeof(power)) != ESP_OK) {
                return make_error_reading(drv, meas, "i2c_read_failed");
            }
            double volts = 0.0, amps = 0.0, watts = 0.0;
            if (!hc_ina_decode(bus, ina226, 0, 0.1, &volts) ||
                !hc_ina_decode(shunt, ina226, 1, 0.1, &amps) ||
                !hc_ina_decode(power, ina226, 2, 0.1, &watts)) {
                return make_error_reading(drv, meas, "ina_range_error");
            }
            if (dev->energy_ms > 0 && t_now > dev->energy_ms) {
                /* Energy is a firmware estimate from sampled power (Wh). */
                dev->energy_wh += dev->family_c * (double)(t_now - dev->energy_ms) / 3600000.0;
            }
            dev->energy_ms = t_now;
            dev->family_a = volts;
            dev->family_b = amps;
            dev->family_c = watts;
            ok = true;
            break;
        }
#endif
        default:
            return make_error_reading(drv, meas, "driver_not_compiled");
    }
    if (!ok) return make_error_reading(drv, meas, "decode_failed");
    dev->family_driver = drv;
    dev->family_ms = now_ms();
    dev->family_valid = true;
    return make_ok_reading(drv, meas, family_value_for(meas, dev));
}
#endif /* I2C family drivers */

#if HC_EN_WATER_LEVEL || HC_EN_SOIL_MOISTURE || HC_EN_MQ2 || HC_EN_MQ135
static bool read_adc_millivolts(const hc_sensor_binding_t *binding, int32_t *out_mv) {
    if (!out_mv || binding->gpio_pin < 0 || !hc_io_is_safe_gpio((uint8_t)binding->gpio_pin)) return false;
    adc_unit_t unit_id;
    adc_channel_t channel;
    if (adc_oneshot_io_to_channel((int)binding->gpio_pin, &unit_id, &channel) != ESP_OK) return false;
    if (!ensure_adc_unit(unit_id)) return false;
    hc_adc_unit_slot_t *slot = &s_adc_units[(int)unit_id];
    adc_oneshot_chan_cfg_t chan_cfg = { .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT };
    if (adc_oneshot_config_channel(slot->unit_handle, channel, &chan_cfg) != ESP_OK) return false;
    int32_t sum = 0;
    const int samples = 8;
    for (int i = 0; i < samples; i++) {
        int raw = 0;
        if (adc_oneshot_read(slot->unit_handle, channel, &raw) != ESP_OK) return false;
        sum += raw;
    }
    int raw_avg = (int)(sum / samples);
    int mv = 0;
    if (slot->cali_ready && adc_cali_raw_to_voltage(slot->cali_handle, raw_avg, &mv) == ESP_OK) {
        *out_mv = (int32_t)mv;
        return true;
    }
    *out_mv = (int32_t)((raw_avg * 3300LL) / 4095LL);
    return true;
}

static hc_sensor_reading_t read_analog_family(
    const hc_sensor_binding_t *binding,
    hc_sensor_driver_id_t drv,
    hc_sensor_measurement_t meas
) {
    int32_t mv = 0;
    if (!read_adc_millivolts(binding, &mv)) {
        return make_error_reading(drv, meas, "adc_read_failed");
    }
    double value = 0.0;
    switch (drv) {
        case HC_DRV_WATER_LEVEL:
        case HC_DRV_SOIL_MOISTURE:
            if (!hc_adc_percent(mv, 3300, &value)) {
                return make_error_reading(drv, meas, "adc_range_error");
            }
            break;
        case HC_DRV_MQ2:
        case HC_DRV_MQ135:
            value = hc_mq_qualitative_pct(mv, 3300);
            break;
        default:
            return make_error_reading(drv, meas, "driver_not_compiled");
    }
    return make_ok_reading(drv, meas, value);
}
#endif /* analog family drivers */

#if HC_EN_WATER_LEAK || HC_EN_RAIN
static hc_sensor_reading_t read_digital_sensor(
    const hc_sensor_binding_t *binding,
    hc_sensor_driver_id_t drv,
    hc_sensor_measurement_t meas
) {
    if (binding->gpio_pin < 0 || !hc_io_is_safe_gpio((uint8_t)binding->gpio_pin)) {
        return make_error_reading(drv, meas, "invalid_gpio");
    }
    int level = gpio_get_level((gpio_num_t)binding->gpio_pin);
    return make_ok_reading(drv, meas, hc_pir_decode(level, binding->inverted));
}
#endif

#if HC_EN_LD2410
static struct {
    bool initialized;
    int tx_pin;
    int rx_pin;
} s_ld2410_uart = { false, -1, -1 };

static hc_sensor_reading_t read_ld2410(
    const hc_sensor_binding_t *binding,
    hc_sensor_measurement_t meas,
    bool allow_cached
) {
    static double presence = 0.0, motion = 0.0, distance = 0.0;
    static int64_t sample_ms = 0;
    if (binding->gpio_pin < 0 || binding->aux_pin_a < 0 ||
        binding->gpio_pin == binding->aux_pin_a ||
        !hc_io_is_safe_gpio((uint8_t)binding->gpio_pin) ||
        !hc_io_is_safe_gpio((uint8_t)binding->aux_pin_a)) {
        return make_error_reading(HC_DRV_LD2410, meas, "uart_pins_invalid");
    }
    const int tx = (int)binding->gpio_pin;   /* controller TX -> module RX */
    const int rx = (int)binding->aux_pin_a;  /* module TX -> controller RX */
    if (!s_ld2410_uart.initialized || s_ld2410_uart.tx_pin != tx || s_ld2410_uart.rx_pin != rx) {
        if (s_ld2410_uart.initialized) {
            uart_driver_delete(UART_NUM_1);
            s_ld2410_uart.initialized = false;
            s_ld2410_uart.tx_pin = -1;
            s_ld2410_uart.rx_pin = -1;
        }
        uart_config_t uart_cfg = {
            .baud_rate = 256000,
            .data_bits = UART_DATA_8_BITS,
            .parity = UART_PARITY_DISABLE,
            .stop_bits = UART_STOP_BITS_1,
            .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
            .source_clk = UART_SCLK_DEFAULT,
        };
        if (uart_driver_install(UART_NUM_1, 256, 0, 0, NULL, 0) != ESP_OK) {
            return make_error_reading(HC_DRV_LD2410, meas, "uart_init_failed");
        }
        if (uart_param_config(UART_NUM_1, &uart_cfg) != ESP_OK ||
            uart_set_pin(UART_NUM_1, tx, rx, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK) {
            uart_driver_delete(UART_NUM_1);
            return make_error_reading(HC_DRV_LD2410, meas, "uart_init_failed");
        }
        s_ld2410_uart.initialized = true;
        s_ld2410_uart.tx_pin = tx;
        s_ld2410_uart.rx_pin = rx;
    }
    int64_t t_now = now_ms();
    if (allow_cached && sample_ms > 0 && (t_now - sample_ms) < 500) {
        double v = (meas == HC_MEAS_MOTION_LD2410) ? motion
                 : (meas == HC_MEAS_DISTANCE_LD2410) ? distance : presence;
        return make_ok_reading(HC_DRV_LD2410, meas, v);
    }
    uint8_t buf[128] = {0};
    int read_bytes = uart_read_bytes(UART_NUM_1, buf, sizeof(buf), pdMS_TO_TICKS(120));
    if (read_bytes <= 0) return make_error_reading(HC_DRV_LD2410, meas, "uart_timeout");
    double p = 0.0, m = 0.0, d = 0.0;
    if (!hc_ld2410_parse_frame(buf, (size_t)read_bytes, &p, &m, &d)) {
        return make_error_reading(HC_DRV_LD2410, meas, "uart_frame_invalid");
    }
    presence = p; motion = m; distance = d;
    sample_ms = now_ms();
    double value = (meas == HC_MEAS_MOTION_LD2410) ? motion
                 : (meas == HC_MEAS_DISTANCE_LD2410) ? distance : presence;
    return make_ok_reading(HC_DRV_LD2410, meas, value);
}
#endif /* LD2410 */

/* ============================================================================
 * Public Driver Configuration, Dispatch & Cleanup
 * ============================================================================ */

esp_err_t hc_sensor_driver_configure(const hc_sensor_binding_t *binding) {
    if (!binding) return ESP_ERR_INVALID_ARG;
    hc_sensor_driver_id_t drv = hc_sensor_resolve_driver(binding->sensor_type, binding->explicit_driver_id);
    if (drv == HC_DRV_NONE || !hc_sensor_is_driver_in_mask(hc_sensor_drivers_compiled_mask(), drv)) {
        return ESP_ERR_NOT_SUPPORTED;
    }

    switch (drv) {
        case HC_DRV_BME280:
        case HC_DRV_BH1750:
        case HC_DRV_SHT3X:
        case HC_DRV_AHT20:
        case HC_DRV_TMP117:
        case HC_DRV_VEML7700:
        case HC_DRV_SGP30:
        case HC_DRV_INA219:
        case HC_DRV_INA226: {
#if HC_EN_BME280 || HC_EN_BH1750 || HC_EN_SHT3X || HC_EN_AHT20 || HC_EN_TMP117 || \
    HC_EN_VEML7700 || HC_EN_SGP30 || HC_EN_INA219 || HC_EN_INA226
            uint8_t addr = binding->i2c_addr != 0
                ? binding->i2c_addr
                : hc_sensor_driver_default_i2c_addr(drv);
            return get_or_init_i2c_dev(binding, addr) ? ESP_OK : ESP_ERR_INVALID_ARG;
#else
            return ESP_ERR_NOT_SUPPORTED;
#endif
        }
        case HC_DRV_DHT22:
        case HC_DRV_DHT11:
        case HC_DRV_DS18B20: {
            if (binding->gpio_pin < 0 || !hc_io_is_safe_gpio((uint8_t)binding->gpio_pin) ||
                !GPIO_IS_VALID_OUTPUT_GPIO((gpio_num_t)binding->gpio_pin)) {
                return ESP_ERR_INVALID_ARG;
            }
            gpio_config_t cfg = {
                .pin_bit_mask = (1ULL << (uint8_t)binding->gpio_pin),
                .mode = GPIO_MODE_INPUT,
                .pull_up_en = GPIO_PULLUP_ENABLE,
                .pull_down_en = GPIO_PULLDOWN_DISABLE,
                .intr_type = GPIO_INTR_DISABLE,
            };
            return gpio_config(&cfg);
        }
        case HC_DRV_PIR: {
            if (binding->gpio_pin < 0 || !hc_io_is_safe_gpio((uint8_t)binding->gpio_pin)) {
                return ESP_ERR_INVALID_ARG;
            }
            gpio_config_t cfg = {
                .pin_bit_mask = (1ULL << (uint8_t)binding->gpio_pin),
                .mode = GPIO_MODE_INPUT,
                .pull_up_en = GPIO_PULLUP_DISABLE,
                .pull_down_en = GPIO_PULLDOWN_ENABLE,
                .intr_type = GPIO_INTR_DISABLE,
            };
            return gpio_config(&cfg);
        }
        case HC_DRV_REED:
        case HC_DRV_WATER_LEAK:
        case HC_DRV_RAIN: {
            if (binding->gpio_pin < 0 || !hc_io_is_safe_gpio((uint8_t)binding->gpio_pin)) {
                return ESP_ERR_INVALID_ARG;
            }
            gpio_config_t cfg = {
                .pin_bit_mask = (1ULL << (uint8_t)binding->gpio_pin),
                .mode = GPIO_MODE_INPUT,
                .pull_up_en = GPIO_PULLUP_ENABLE,
                .pull_down_en = GPIO_PULLDOWN_DISABLE,
                .intr_type = GPIO_INTR_DISABLE,
            };
            return gpio_config(&cfg);
        }
        case HC_DRV_ADC_VOLTAGE:
        case HC_DRV_WATER_LEVEL:
        case HC_DRV_SOIL_MOISTURE:
        case HC_DRV_MQ2:
        case HC_DRV_MQ135: {
#if HC_EN_ADC_VOLTAGE || HC_EN_WATER_LEVEL || HC_EN_SOIL_MOISTURE || HC_EN_MQ2 || HC_EN_MQ135
            if (binding->gpio_pin < 0 || !hc_io_is_safe_gpio((uint8_t)binding->gpio_pin)) {
                return ESP_ERR_INVALID_ARG;
            }
            adc_unit_t unit_id;
            adc_channel_t channel;
            if (adc_oneshot_io_to_channel((int)binding->gpio_pin, &unit_id, &channel) != ESP_OK) {
                return ESP_ERR_INVALID_ARG;
            }
            return ensure_adc_unit(unit_id) ? ESP_OK : ESP_FAIL;
#else
            return ESP_ERR_NOT_SUPPORTED;
#endif
        }
#if HC_EN_LD2410
        case HC_DRV_LD2410: {
            if (binding->gpio_pin < 0 || binding->aux_pin_a < 0 ||
                binding->gpio_pin == binding->aux_pin_a ||
                !hc_io_is_safe_gpio((uint8_t)binding->gpio_pin) ||
                !hc_io_is_safe_gpio((uint8_t)binding->aux_pin_a)) {
                return ESP_ERR_INVALID_ARG;
            }
            return ESP_OK; /* UART1 is installed lazily on first read. */
        }
#endif
        default:
            return ESP_ERR_NOT_SUPPORTED;
    }
}

hc_sensor_reading_t hc_sensor_driver_read(const hc_sensor_binding_t *binding, bool allow_cached) {
    (void)allow_cached;
    if (!binding) {
        return make_error_reading(HC_DRV_NONE, HC_MEAS_UNKNOWN, "invalid_binding");
    }
    hc_sensor_measurement_t meas = hc_sensor_resolve_measurement(binding->sensor_type);
    hc_sensor_driver_id_t drv = hc_sensor_resolve_driver(binding->sensor_type, binding->explicit_driver_id);

    if (drv == HC_DRV_NONE) {
        return make_error_reading(HC_DRV_NONE, meas, "unknown_driver");
    }
    if (!hc_sensor_is_driver_in_mask(hc_sensor_drivers_compiled_mask(), drv)) {
        return make_error_reading(drv, meas, "driver_not_compiled");
    }

    switch (drv) {
#if HC_EN_BME280
        case HC_DRV_BME280:
            return read_bme280(binding, meas, allow_cached);
#endif
#if HC_EN_BH1750
        case HC_DRV_BH1750:
            return read_bh1750(binding, meas);
#endif
#if HC_EN_SHT3X || HC_EN_AHT20 || HC_EN_TMP117 || HC_EN_VEML7700 || HC_EN_SGP30 || \
    HC_EN_INA219 || HC_EN_INA226
        case HC_DRV_SHT3X:
        case HC_DRV_AHT20:
        case HC_DRV_TMP117:
        case HC_DRV_VEML7700:
        case HC_DRV_SGP30:
        case HC_DRV_INA219:
        case HC_DRV_INA226:
            return read_i2c_family(binding, drv, meas, allow_cached);
#endif
#if HC_EN_DHT22
        case HC_DRV_DHT22:
            return read_dht_family(binding, HC_DRV_DHT22, meas, allow_cached);
#endif
#if HC_EN_DHT11
        case HC_DRV_DHT11:
            return read_dht_family(binding, HC_DRV_DHT11, meas, allow_cached);
#endif
#if HC_EN_DS18B20
        case HC_DRV_DS18B20:
            return read_ds18b20(binding, meas, allow_cached);
#endif
#if HC_EN_PIR
        case HC_DRV_PIR: {
            if (binding->gpio_pin < 0 || !hc_io_is_safe_gpio((uint8_t)binding->gpio_pin)) {
                return make_error_reading(HC_DRV_PIR, meas, "invalid_gpio");
            }
            int lvl = gpio_get_level((gpio_num_t)binding->gpio_pin);
            return make_ok_reading(HC_DRV_PIR, meas, hc_pir_decode(lvl, binding->inverted));
        }
#endif
#if HC_EN_REED
        case HC_DRV_REED: {
            if (binding->gpio_pin < 0 || !hc_io_is_safe_gpio((uint8_t)binding->gpio_pin)) {
                return make_error_reading(HC_DRV_REED, meas, "invalid_gpio");
            }
            int lvl = gpio_get_level((gpio_num_t)binding->gpio_pin);
            return make_ok_reading(HC_DRV_REED, meas, hc_reed_decode(lvl, binding->inverted));
        }
#endif
#if HC_EN_ADC_VOLTAGE
        case HC_DRV_ADC_VOLTAGE:
            return read_adc_voltage(binding, meas);
#endif
#if HC_EN_WATER_LEVEL || HC_EN_SOIL_MOISTURE || HC_EN_MQ2 || HC_EN_MQ135
        case HC_DRV_WATER_LEVEL:
        case HC_DRV_SOIL_MOISTURE:
        case HC_DRV_MQ2:
        case HC_DRV_MQ135:
            return read_analog_family(binding, drv, meas);
#endif
#if HC_EN_WATER_LEAK || HC_EN_RAIN
        case HC_DRV_WATER_LEAK:
        case HC_DRV_RAIN:
            return read_digital_sensor(binding, drv, meas);
#endif
#if HC_EN_LD2410
        case HC_DRV_LD2410:
            return read_ld2410(binding, meas, allow_cached);
#endif
        default:
            return make_error_reading(drv, meas, "driver_not_compiled");
    }
}

void hc_sensor_drivers_reset(void) {
    (void)TAG;
#if HC_EN_BME280 || HC_EN_BH1750 || HC_EN_SHT3X || HC_EN_AHT20 || HC_EN_TMP117 || \
    HC_EN_VEML7700 || HC_EN_SGP30 || HC_EN_INA219 || HC_EN_INA226
    reset_i2c_manager();
#endif
#if HC_EN_DHT22 || HC_EN_DHT11
    memset(s_dht_cache, 0, sizeof(s_dht_cache));
#endif
#if HC_EN_DS18B20
    memset(s_ow_cache, 0, sizeof(s_ow_cache));
#endif
#if HC_EN_ADC_VOLTAGE || HC_EN_WATER_LEVEL || HC_EN_SOIL_MOISTURE || HC_EN_MQ2 || HC_EN_MQ135
    reset_adc_manager();
#endif
#if HC_EN_LD2410
    if (s_ld2410_uart.initialized) {
        uart_driver_delete(UART_NUM_1);
        s_ld2410_uart.initialized = false;
        s_ld2410_uart.tx_pin = -1;
        s_ld2410_uart.rx_pin = -1;
    }
#endif
}
