import { describe, expect, it } from "vitest";
import {
  COMMUNITY_PARTNER_BOARDS,
  VERIFIED_BOARD_CATALOG,
  WAVESHARE_ESP_OFFICIAL_BOARDS,
  SEEED_XIAO_OFFICIAL_BOARDS,
  areMeasurementsSamePhysicalDriver,
  buildFirmwareDriverManifest,
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

  it("keeps the ESP8266 single-ADC constraint explicit", () => {
    const spec = board("nodemcu-esp8266");
    const result = resolveSensorResources({
      board: spec,
      sensorType: "soil_moisture",
      resources: { pins: { adc: 17 } },
    });
    expect(result.valid).toBe(true);
    expect(result.resolved?.pins).toMatchObject({ adc: 17 });
  });
});
