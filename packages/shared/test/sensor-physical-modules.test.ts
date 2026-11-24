import { describe, expect, it } from "vitest";
import {
  COMMUNITY_PARTNER_BOARDS,
  VERIFIED_BOARD_CATALOG,
  WAVESHARE_ESP_OFFICIAL_BOARDS,
  SEEED_XIAO_OFFICIAL_BOARDS,
  areMeasurementsSamePhysicalDriver,
  buildFirmwareDriverManifest,
  evaluateBoardDriverCompatibility,
  getMeasurementOptionsForDriver,
  getSensorDriverById,
  resolveSensorResources,
  suggestSensorResources,
  validateFirmwareDriverManifest,
  validateSensorResourceAssignments,
} from "../src/index";

function board(slug: string) {
  const all = [
    ...VERIFIED_BOARD_CATALOG,
    ...COMMUNITY_PARTNER_BOARDS,
    ...WAVESHARE_ESP_OFFICIAL_BOARDS.map((x) => x.seed),
    ...SEEED_XIAO_OFFICIAL_BOARDS.map((x) => x.seed),
  ];
  const found = all.find((b) => b.slug === slug);
  if (!found) throw new Error(`missing board ${slug}`);
  return {
    slug: found.slug,
    manufacturer: found.manufacturer,
    model: found.model,
    chip_family: found.chip_family,
    flash_size_mb: found.flash_size_mb,
    psram_size_mb: found.psram_size_mb,
    gpio_definitions: found.gpio_definitions,
    board_layout: found.board_layout ?? null,
  };
}

describe("physical sensor modules and driver-aware resources", () => {
  it("exposes every measurement of a physical module through one driver binding", () => {
    const bmeMeasurements = getMeasurementOptionsForDriver("bme280").map((m) => m.sensorType);
    expect(bmeMeasurements).toEqual(
      expect.arrayContaining(["temperature_bme280", "humidity_bme280", "pressure_bme280"])
    );
    expect(getMeasurementOptionsForDriver("pzem004t")).toHaveLength(4);
    expect(areMeasurementsSamePhysicalDriver("temperature_dht22", "humidity_dht22")).toBe(true);
    expect(areMeasurementsSamePhysicalDriver("temperature_dht22", "temperature_sht3x")).toBe(false);
    /* Model variants reuse one protocol family, not separate drivers. */
    expect(getSensorDriverById("sht3x")?.modelProfiles?.map((m) => m.model)).toEqual(
      expect.arrayContaining(["SHT30", "SHT31", "SHT35"])
    );
  });

  it("rejects planned drivers from compiled firmware manifests", () => {
    const manifest = buildFirmwareDriverManifest({
      firmwareVersion: "9.9.9",
      chipFamily: "esp32s3",
      targetBoardSlug: "esp32-s3-devkitc-1-n16r8",
      partitionScheme: "dual_ota_16mb",
      flashSizeMb: 16,
      psramMode: "octal",
    });
    const ids = manifest.sensor_drivers.map((d) => d.id);
    expect(ids).not.toContain("ld2450");
    expect(ids).not.toContain("pzem004t");
    expect(ids).not.toContain("sct013");
    const check = validateFirmwareDriverManifest({
      manifest,
      sdkConfig: {},
      boardSlug: "esp32-s3-devkitc-1-n16r8",
      chipFamily: "esp32s3",
    });
    expect(check.errors.join(" ")).not.toMatch(/ld2450|pzem004t|sct013/);
  });

  it("auto-derives documented bus roles and detects duplicate I2C addresses", () => {
    const spec = board("waveshare-esp32-s3-relay-6ch");
    const suggested = suggestSensorResources({ board: spec, sensorType: "temperature_sht3x" });
    expect(suggested.pins?.i2c_sda).toBeTypeOf("number");
    expect(suggested.pins?.i2c_scl).toBeTypeOf("number");
    expect(suggested.i2cAddress).toBeTruthy();

    const allocation = {
      id: "t1",
      kind: "sensor",
      name: "temperature",
      sensorType: "temperature_sht3x",
      driverId: "sht3x",
      i2cAddress: "0x44",
      resources: suggested,
    };
    const sibling = {
      id: "t2",
      kind: "sensor",
      name: "humidity",
      sensorType: "humidity_sht3x",
      driverId: "sht3x",
      i2cAddress: "0x44",
      resources: suggested,
    };
    const shared = validateSensorResourceAssignments({
      board: spec,
      candidate: allocation,
      allocations: [sibling],
    });
    expect(shared.errors.join(" ")).not.toMatch(/address/i);

    const conflicting = validateSensorResourceAssignments({
      board: spec,
      candidate: {
        ...allocation,
        sensorType: "temperature_bme280",
        driverId: "bme280",
        resources: { ...suggested, model: "BME280" },
      },
      allocations: [sibling],
    });
    expect(conflicting.errors.join(" ")).toMatch(/address|0x44/i);
  });

  it("keeps the ESP8266 single-ADC constraint explicit and restricts ESP32-only chips", () => {
    const spec = board("nodemcu-esp8266");
    const result = resolveSensorResources({
      board: spec,
      sensorType: "soil_moisture",
      resources: { pins: { adc: 17 } },
    });
    expect(result.valid).toBe(true);
    expect(result.resolved?.pins).toMatchObject({ adc: 17 });

    const tmpBoard = evaluateBoardDriverCompatibility({
      board: spec,
      driverId: "tmp117",
    });
    expect(tmpBoard.supported).toBe(false);
    const sgpBoard = evaluateBoardDriverCompatibility({
      board: spec,
      driverId: "sgp30",
    });
    expect(sgpBoard.supported).toBe(false);
  });

  it("allows same I2C address on disjoint buses and DS18B20 on distinct 1-Wire pins", () => {
    const spec = board("esp32-s3-devkitc-1-n16r8");
    const bmeA = resolveSensorResources({
      board: spec,
      sensorType: "temperature_bme280",
      i2cAddress: "0x76",
      resources: { driverId: "bme280", pins: { i2c_sda: 8, i2c_scl: 9 }, i2cAddress: "0x76" },
    });
    const bmeB = resolveSensorResources({
      board: spec,
      sensorType: "temperature_bme280",
      i2cAddress: "0x76",
      resources: { driverId: "bme280", pins: { i2c_sda: 4, i2c_scl: 5 }, i2cAddress: "0x76" },
    });
    expect(bmeA.valid).toBe(true);
    expect(bmeB.valid).toBe(true);
    const busCheck = validateSensorResourceAssignments({
      board: spec,
      candidate: {
        sensorType: "temperature_bme280",
        driverId: "bme280",
        resources: bmeB.resolved!,
      },
      allocations: [
        {
          id: "bme-a",
          name: "Bus 0 BME280",
          sensorType: "temperature_bme280",
          driverId: "bme280",
          resources: bmeA.resolved!,
        },
      ],
    });
    expect(busCheck.valid).toBe(true);

    const dsA = resolveSensorResources({
      board: spec,
      sensorType: "temperature_ds18b20",
      resources: { driverId: "ds18b20", pins: { onewire: 4 } },
    });
    const dsB = resolveSensorResources({
      board: spec,
      sensorType: "temperature_ds18b20",
      resources: { driverId: "ds18b20", pins: { onewire: 5 } },
    });
    const owCheck = validateSensorResourceAssignments({
      board: spec,
      candidate: {
        sensorType: "temperature_ds18b20",
        driverId: "ds18b20",
        resources: dsB.resolved!,
      },
      allocations: [
        {
          id: "ds-a",
          name: "Probe 1",
          sensorType: "temperature_ds18b20",
          driverId: "ds18b20",
          resources: dsA.resolved!,
        },
      ],
    });
    expect(owCheck.valid).toBe(true);
  });

  it("aligns reed category and water_leak / sct013 metadata", () => {
    expect(getSensorDriverById("reed")?.category).toBe("contact");
    expect(getSensorDriverById("water_leak")?.defaultUnits.water_leak).toBe("state");
    expect(getSensorDriverById("sct013")?.hardwareVerificationStatus).toBe("planned");
  });
});
