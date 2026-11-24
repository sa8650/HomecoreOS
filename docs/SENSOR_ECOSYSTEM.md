# HomecoreOS sensor ecosystem (physical modules → measurements)

This document describes the **current** implementation. Hardware status is
deliberately conservative: `implemented_unverified` means the driver is
compiled and host-tested where possible, **not** that it has been tested on a
physical sensor. No driver in this repository is marked `bench_verified`.

## Architecture

The registry (`packages/shared/src/sensor-drivers.ts`) keeps three concepts
separate:

1. **Category** — logical grouping for the picker (`climate`, `motion`,
   `water`, `energy`, ...). It makes no hardware claim.
2. **Hardware model / physical driver** — one driver entry with supported
   models, protocol family, compiled-driver Kconfig flag and authoritative
   pin/peripheral resources.
3. **Measurement entities** — individual `sensors` rows (and their IDs,
   automations and telemetry history). Several entities may reference one
   physical module via `physical_sensor_instances` and `physical_sensor_id`.

Representative multi-measurement modules:

| Driver | Models / protocol family | Measurements |
| --- | --- | --- |
| `dht22` / `dht11` | DHT22/AM2302 vs DHT11, shared single-wire protocol, model-specific decoding | temperature + humidity |
| `sht3x` | SHT30/SHT31/SHT35, one I²C protocol with CRC-8 | temperature + humidity |
| `bme280` | BME280 I²C | temperature + humidity + pressure |
| `pzem004t` | planned only | voltage + current + power + energy |
| `ina219` | INA219 I²C | bus voltage + current + power |
| `ina226` | INA226 I²C | voltage + current + power + estimated energy |

`LD2450` and `PZEM-004T` are **catalog-only (`planned`)**: they are excluded
from generated/hashed firmware manifests and cannot be advertised as compiled
support. `SCT-013` is planned because the required burden resistor and bias
conditioning are not implemented. `MQ-2`/`MQ-135` report uncalibrated
qualitative `%FS` only and are **not** safety-rated gas or fire alarms.

## Pin and peripheral allocation

Every driver declares roles (`i2c_sda`/`i2c_scl`, `uart_tx`/`uart_rx`,
`spi_sclk`/`spi_cs`, `onewire`, `adc`, `gpio_in`/`gpio_out`/
`gpio_bidirectional`, pulse/interrupt), required pin capabilities and sharing
semantics:

- I²C: both pins on the same documented bus; unique 7-bit addresses per bus;
  sibling measurement entities of one physical module may share the address.
- 1-Wire: shared data pin for DS18B20 probes; distinct buses are rejected.
- UART/SPI: no multiplexing. SPI clock/data lines can be shared only with
  independent CS pins; conflicting pins are rejected.
- ADC: channel and ESP8266 single-A0 constraint enforced.
- Reserved/flash/PSRAM/strapping/BOOT/USB/JTAG/onboard pins are rejected by
  board policy; unused safe GPIOs remain selectable.

Frontend (`board-pin-helpers.ts`, `gpio-pin-selector.ts`), Worker
(`sensor-compatibility.ts`, `routes/devices.ts`) and the shared validators use
the same declarations. Invalid assignments are rejected server-side with
explanations in the API response.

## Firmware

ESP32 (ESP-IDF) implementation in `firmware/main/`:

- DHT11/DHT22, DS18B20, BME280, SHT3x, AHT20, TMP117, LD2410, VEML7700,
  SGP30, INA219/INA226, water leak/level, capacitive soil moisture, rain,
  PIR/reed, ADC voltage, MQ-2/MQ-135.
- Host-testable decoders live in `sensor_driver_logic.c`; `firmware/test`
  covers checksums, CRC, fixed-point conversions and driver resolution.
- Per-device model/limitations caching, lazy shared bus init, cached samples
  per physical read and safe release of UART/ADC resources.
- New drivers are opt-in through Kconfig. 4 MB board overlays keep the original
  seven-driver baseline; larger overlays enable the expanded compiled set.
  Manifest generation derives compiled drivers from these flags.

ESP8266 (`firmware/esp8266/`) is a **separate PlatformIO/Arduino target**,
never built with ESP-IDF. It supports DHT11/DHT22, DS18B20, BME280, SHT3x,
AHT20, BH1750, VEML7700, PIR, reed, ADC voltage, leak/level/soil/rain. It uses
documented NodeMCU defaults (I²C SDA GPIO4/SCL GPIO5, ADC A0), has no BLE, no
UART-heavy drivers, no LD2410/INA/SGP30 and caps configuration at eight
modules. Its own board profile/manifest is verified separately from ESP32.

## Database / API compatibility

Migration `0009_physical_sensor_instances.sql` adds physical module identity
and `sensors.driver_config`, backfills one physical module per legacy binding
and references it from existing sensors. No sensor ID, `sensor_type`, device,
automation or telemetry row is deleted or reset. Existing APIs remain
backward-compatible; new endpoints are additive:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/sensors/physical-instances?boardInstanceId=` | List physical modules and linked measurement entities |
| POST | `/api/sensors/physical-instances` | Validate and create a physical module binding |
| PATCH | `/api/sensors/physical-instances/:id` | Update informational/model data |
| DELETE | `/api/sensors/physical-instances/:id` | Soft-delete only when no measurement entities remain |

Sensor create/update accepts `driverId`, `model`, `resources` and
`physicalSensorId`; passing `physicalSensorId` attaches a new measurement to
an existing physical module rather than duplicating its hardware binding.

## Wiring diagrams

Diagrams are generated from the selected driver's resource declaration, the
configured pins and **documented board facts** only. They show roles and signal
direction, shared buses and sibling modules. The UI distinguishes configured
(logical) connections from physically verified wiring, and warns about level
mismatches, required external parts (pull-ups, burden resistors, dividers) and
missing board documentation. No voltage/current rating or board pinout is
invented.

## Hardware verification status

All newly added drivers are `implemented_unverified`. Physical bench testing,
long-run stability, MQ calibration and PZEM/LD2450 protocol work remain open.
Do not relabel any driver `bench_verified` until real hardware has been tested.
