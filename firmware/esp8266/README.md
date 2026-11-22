# HomecoreOS ESP8266 Firmware (`nodemcu-esp8266`)

> **Build Platform Isolation Notice:** ESP8266 (Xtensa LX106) is **not** supported by ESP-IDF v5.x (`idf.py`). This directory provides a dedicated, isolated PlatformIO / `espressif8266` firmware path for `nodemcu-esp8266` so it never interferes with the ESP-IDF multi-board build matrix in `firmware/boards/`.

## Target Hardware Profile (`nodemcu-esp8266`)

- **MCU**: ESP8266EX (Xtensa LX106, 80/160 MHz, single core)
- **Flash / PSRAM**: 4 MB QIO/DIO SPI Flash (`40m`), 0 MB PSRAM
- **Wireless**: Wi-Fi 4 (802.11 b/g/n) — **no Bluetooth / BLE radio**
- **Provisioning**: SoftAP Captive Portal / Manual Pairing (BLE provisioning disabled)
- **BOOT / FLASH Button**: `GPIO0` (NodeMCU `D3`)
- **Default I2C Bus**: `SDA = GPIO4 (D2)`, `SCL = GPIO5 (D1)`
- **Analog Input**: Single dedicated 10-bit ADC channel `A0` (internal pin index `17`, input-only, `0–3.3V` via onboard NodeMCU voltage divider)
- **Shared Sensor Decoder Logic**: Compiles `firmware/main/sensor_driver_logic.c` directly so DHT22 checksums, DS18B20 CRC-8, BME280 compensation math, BH1750 lux conversion, and PIR/Reed decoding stay bit-for-bit identical with the ESP-IDF firmware.

## Local Build

```bash
cd firmware/esp8266
pio run -e nodemcu-esp8266
```

## CI Validation

The `.github/workflows/build-firmware.yml` workflow validates `firmware/esp8266/board-profile.json` and verifies that `nodemcu-esp8266` stays isolated from ESP-IDF targets via `firmware/scripts/verify_firmware_image.py --verify-esp8266-profile`.
