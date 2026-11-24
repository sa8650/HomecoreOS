import { describe, expect, it } from "vitest";
import {
  ALL_BOARD_FIRMWARE_COMPAT_BY_SLUG,
  BOARD_FIRMWARE_COMPAT_BY_SLUG,
  COMMUNITY_PARTNER_BOARDS,
  PARTNER_BOARD_FIRMWARE_COMPAT_BY_SLUG,
  SEEED_XIAO_OFFICIAL_BOARDS,
  SENSOR_DRIVER_IDS,
  SENSOR_DRIVER_REGISTRY,
  SUPPORTED_SENSOR_TYPES,
  VERIFIED_BOARD_CATALOG,
  WAVESHARE_ESP_OFFICIAL_BOARDS,
  buildCanonicalDriverManifestString,
  buildFirmwareDriverManifest,
  deriveBoardHardwareCapabilityProfile,
  evaluateBoardDriverCompatibility,
  evaluateControllerSensorCompatibility,
  extractFirmwareDriverManifestFromRelease,
  getSensorDriverById,
  getSensorDriverForMeasurement,
  resolveBoardFirmwareCompatibility,
  validateFirmwareDriverManifest,
  validateSensorAssignmentForController,
} from "../src/index";

function getBoardInput(slug: string) {
  const catalog = [
    ...VERIFIED_BOARD_CATALOG,
    ...SEEED_XIAO_OFFICIAL_BOARDS.map((x) => x.seed),
    ...WAVESHARE_ESP_OFFICIAL_BOARDS.map((x) => x.seed),
    ...COMMUNITY_PARTNER_BOARDS,
  ];
  const found = catalog.find((b) => b.slug === slug);
  if (!found) throw new Error(`Board not found in catalogs: ${slug}`);
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

describe("Sensor Driver Registry & Multi-Board Hardware Compatibility", () => {
  it("maps every SUPPORTED_SENSOR_TYPE cleanly to a registered physical sensor driver", () => {
    expect(SENSOR_DRIVER_IDS.length).toBeGreaterThanOrEqual(25);
    expect(Object.keys(SENSOR_DRIVER_REGISTRY)).toHaveLength(SENSOR_DRIVER_IDS.length);
    /* Every registry driver must declare complete resource requirements. */
    for (const id of SENSOR_DRIVER_IDS) {
      const driver = getSensorDriverById(id)!;
      expect(driver.resources.roles.length, `Missing pin roles for ${id}`).toBeGreaterThan(0);
      expect(driver.measurements.length, `Missing measurements for ${id}`).toBeGreaterThan(0);
      expect(driver.category).toBeTruthy();
      expect(driver.hardwareModel || driver.modelProfiles?.length || driver.supportedModels.length).toBeTruthy();
    }
    /* Planned drivers are catalog-only and never advertised as compiled. */
    for (const id of ["ld2450", "pzem004t", "sct013"]) {
      expect(getSensorDriverById(id)!.hardwareVerificationStatus).toBe("planned");
    }

    for (const sensorType of SUPPORTED_SENSOR_TYPES) {
      const driver = getSensorDriverForMeasurement(sensorType);
      expect(driver, `Missing driver for ${sensorType}`).toBeTruthy();
      expect(driver!.measurements).toContain(sensorType);
      expect(getSensorDriverById(driver!.id)).toBe(driver);
    }
  });

  it("keeps BOARD_FIRMWARE_COMPAT_BY_SLUG to 11 seeded boards and covers all 22 catalog boards in ALL_BOARD_FIRMWARE_COMPAT_BY_SLUG", () => {
    expect(Object.keys(BOARD_FIRMWARE_COMPAT_BY_SLUG)).toHaveLength(11);
    expect(Object.keys(PARTNER_BOARD_FIRMWARE_COMPAT_BY_SLUG)).toHaveLength(11);
    expect(Object.keys(ALL_BOARD_FIRMWARE_COMPAT_BY_SLUG)).toHaveLength(22);

    const allSlugs = new Set([
      ...VERIFIED_BOARD_CATALOG.map((b) => b.slug),
      ...SEEED_XIAO_OFFICIAL_BOARDS.map((x) => x.seed.slug),
      ...WAVESHARE_ESP_OFFICIAL_BOARDS.map((x) => x.seed.slug),
      ...COMMUNITY_PARTNER_BOARDS.map((b) => b.slug),
    ]);

    for (const slug of allSlugs) {
      const compat = resolveBoardFirmwareCompatibility({ slug, chip_family: "esp32s3" });
      expect(compat, `Missing compat entry for ${slug}`).toBeTruthy();
      expect(ALL_BOARD_FIRMWARE_COMPAT_BY_SLUG[slug]).toBeTruthy();
    }
  });

  it("derives accurate hardware capability profiles for ESP32-S3, Relay-6CH, C3-Zero, and NodeMCU ESP8266", () => {
    const s3 = deriveBoardHardwareCapabilityProfile(getBoardInput("esp32-s3-devkitc-1-n16r8"));
    expect(s3.defaultI2cBus).toEqual({ sdaPin: 1, sclPin: 2 });
    expect(s3.usableGpios).not.toContain(19); // USB D-
    expect(s3.usableGpios).not.toContain(20); // USB D+
    expect(s3.usableGpios).not.toContain(35); // Octal PSRAM

    const relay6 = deriveBoardHardwareCapabilityProfile(getBoardInput("waveshare-esp32-s3-relay-6ch"));
    expect(relay6.defaultI2cBus).toEqual({ sdaPin: 8, sclPin: 9 });
    expect(relay6.onboardPeripherals.relays).toEqual(expect.arrayContaining([1, 2, 41, 42, 45, 46]));
    expect(relay6.onboardPeripherals.buzzers).toContain(21);
    // Onboard relay pins must NOT be offered as sensor inputs
    expect(relay6.pins.digitalIn).not.toContain(41);
    expect(relay6.pins.digitalIn).not.toContain(46);
    expect(relay6.pins.adc).toEqual(expect.arrayContaining([4, 5, 6, 7, 8, 9]));

    const c3Zero = deriveBoardHardwareCapabilityProfile(getBoardInput("waveshare-esp32-c3-zero"));
    // Avoids strapping GPIO8 for default I2C SDA
    expect(c3Zero.defaultI2cBus).toEqual({ sdaPin: 0, sclPin: 7 });

    const esp8266 = deriveBoardHardwareCapabilityProfile(getBoardInput("nodemcu-esp8266"));
    expect(esp8266.defaultI2cBus).toEqual({ sdaPin: 4, sclPin: 5 });
    expect(esp8266.pins.adc).toEqual([17]); // Dedicated A0 pin only
    expect(esp8266.pins.bidirectionalGpio).not.toContain(17);

    const esp8266Compat = ALL_BOARD_FIRMWARE_COMPAT_BY_SLUG["nodemcu-esp8266"];
    expect(esp8266Compat.build_platform).toBe("esp8266_rtos_sdk");
    expect(esp8266Compat.supports_ble).toBe(false);
  });

  it("evaluates strict board + installed firmware intersection and reports firmware update needs", () => {
    const board = getBoardInput("waveshare-esp32-s3-relay-6ch");
    const partialManifest = buildFirmwareDriverManifest({
      firmwareVersion: "1.2.0",
      chipFamily: "esp32s3",
      targetBoardSlug: "waveshare-esp32-s3-relay-6ch",
      partitionScheme: "dual_ota_16mb",
      flashSizeMb: 16,
      psramMode: "octal",
      driverIds: ["bme280", "pir"],
    });
    const resolvedPartial = extractFirmwareDriverManifestFromRelease({
      id: "rel-partial",
      version: "1.2.0",
      chip_family: "esp32s3",
      target_board_slug: "waveshare-esp32-s3-relay-6ch",
      driver_manifest: partialManifest,
      compiled_sensor_drivers: ["bme280", "pir"],
      supported_sensor_types: partialManifest.supported_sensor_types,
      manifest_version: partialManifest.manifest_version,
      manifest_hash: null,
    });

    const report = evaluateControllerSensorCompatibility({
      board,
      installedFirmware: resolvedPartial,
    });

    const compatTypes = report.compatibleSensors.map((s) => s.sensorType);
    expect(compatTypes).toEqual([
      "temperature_bme280",
      "humidity_bme280",
      "pressure_bme280",
      "motion_pir",
    ]);
    expect(report.needsFirmwareUpdate).toBe(true);
    expect(report.boardOnlySupportedSensors).toContain("temperature_dht22");
    expect(report.boardOnlySupportedSensors).toContain("analog_voltage");
    expect(report.updateRecommendation).toMatch(/firmware/i);

    // Legacy firmware release without driver_manifest blocks all sensors cleanly
    const legacyResolved = extractFirmwareDriverManifestFromRelease({
      id: "rel-legacy",
      version: "1.0.0",
      chip_family: "esp32s3",
      target_board_slug: "waveshare-esp32-s3-relay-6ch",
      driver_manifest: null,
      compiled_sensor_drivers: [],
      supported_sensor_types: [],
      manifest_version: null,
      manifest_hash: null,
    });
    const legacyReport = evaluateControllerSensorCompatibility({
      board,
      installedFirmware: legacyResolved,
    });
    expect(legacyReport.compatibleSensors).toHaveLength(0);
    expect(legacyReport.needsFirmwareUpdate).toBe(true);
  });

  it("enforces pin rules, shared I2C/DHT22 bindings, and rejects invalid hardware assignments", () => {
    const relay6 = getBoardInput("waveshare-esp32-s3-relay-6ch");
    const fullManifest = buildFirmwareDriverManifest({
      firmwareVersion: "1.3.0",
      chipFamily: "esp32s3",
      targetBoardSlug: "waveshare-esp32-s3-relay-6ch",
      partitionScheme: "dual_ota_16mb",
      flashSizeMb: 16,
      psramMode: "octal",
    });
    const resolvedFull = extractFirmwareDriverManifestFromRelease({
      id: "rel-full",
      version: "1.3.0",
      chip_family: "esp32s3",
      target_board_slug: "waveshare-esp32-s3-relay-6ch",
      driver_manifest: fullManifest,
      compiled_sensor_drivers: fullManifest.sensor_drivers.map((d) => d.id),
      supported_sensor_types: fullManifest.supported_sensor_types,
      manifest_version: fullManifest.manifest_version,
      manifest_hash: null,
    });

    // 1. Reject sensor assigned to onboard relay GPIO 41
    const badRelayPin = validateSensorAssignmentForController({
      board: relay6,
      installedFirmware: resolvedFull,
      sensorType: "motion_pir",
      gpioPin: 41,
      i2cAddress: null,
      usedPinsByNonSensors: [],
      existingSensorsOnController: [],
    });
    expect(badRelayPin.valid).toBe(false);
    expect(badRelayPin.code).toBe("GPIO_OR_BUS_INVALID");

    // 2. Allow sharing BME280 measurements on the same I2C address 0x76
    const sharedBme = validateSensorAssignmentForController({
      board: relay6,
      installedFirmware: resolvedFull,
      sensorType: "humidity_bme280",
      gpioPin: null,
      i2cAddress: "0x76",
      usedPinsByNonSensors: [],
      existingSensorsOnController: [
        {
          id: "s-1",
          name: "Room Temp",
          gpio_pin: null,
          sensor_type: "temperature_bme280",
          i2c_address: "0x76",
        },
      ],
    });
    expect(sharedBme.valid).toBe(true);

    // 3. Reject conflicting different driver on same I2C address 0x76
    const i2cConflict = validateSensorAssignmentForController({
      board: relay6,
      installedFirmware: resolvedFull,
      sensorType: "light_bh1750",
      gpioPin: null,
      i2cAddress: "0x76",
      usedPinsByNonSensors: [],
      existingSensorsOnController: [
        {
          id: "s-1",
          name: "Room Temp",
          gpio_pin: null,
          sensor_type: "temperature_bme280",
          i2c_address: "0x76",
        },
      ],
    });
    expect(i2cConflict.valid).toBe(false);
    expect(i2cConflict.code).toBe("I2C_ADDRESS_CONFLICT");

    // 4. Allow sharing DHT22 temperature + humidity on same GPIO 5
    const sharedDht = validateSensorAssignmentForController({
      board: relay6,
      installedFirmware: resolvedFull,
      sensorType: "humidity_dht22",
      gpioPin: 5,
      i2cAddress: null,
      usedPinsByNonSensors: [],
      existingSensorsOnController: [
        {
          id: "s-2",
          name: "DHT Temp",
          gpio_pin: 5,
          sensor_type: "temperature_dht22",
          i2c_address: null,
        },
      ],
    });
    expect(sharedDht.valid).toBe(true);

    // 5. NodeMCU ESP8266: allow ADC on A0 (pin 17), reject DHT22 on A0 (pin 17)
    const esp8266 = getBoardInput("nodemcu-esp8266");
    const esp8266Manifest = buildFirmwareDriverManifest({
      firmwareVersion: "1.3.0",
      chipFamily: "esp8266",
      targetBoardSlug: "nodemcu-esp8266",
      partitionScheme: "dual_ota_4mb",
      flashSizeMb: 4,
      psramMode: "none",
    });
    const resolvedEsp8266 = extractFirmwareDriverManifestFromRelease({
      id: "rel-8266",
      version: "1.3.0",
      chip_family: "esp8266",
      target_board_slug: "nodemcu-esp8266",
      driver_manifest: esp8266Manifest,
      compiled_sensor_drivers: esp8266Manifest.sensor_drivers.map((d) => d.id),
      supported_sensor_types: esp8266Manifest.supported_sensor_types,
      manifest_version: esp8266Manifest.manifest_version,
      manifest_hash: null,
    });

    const adcOk = validateSensorAssignmentForController({
      board: esp8266,
      installedFirmware: resolvedEsp8266,
      sensorType: "analog_voltage",
      gpioPin: 17,
      i2cAddress: null,
      usedPinsByNonSensors: [],
      existingSensorsOnController: [],
    });
    expect(adcOk.valid).toBe(true);

    const dhtOnAdc = validateSensorAssignmentForController({
      board: esp8266,
      installedFirmware: resolvedEsp8266,
      sensorType: "temperature_dht22",
      gpioPin: 17,
      i2cAddress: null,
      usedPinsByNonSensors: [],
      existingSensorsOnController: [],
    });
    expect(dhtOnAdc.valid).toBe(false);
    expect(dhtOnAdc.code).toBe("GPIO_OR_BUS_INVALID");
  });

  it("validates driver manifests and produces deterministic canonical JSON for hashing", () => {
    const manifest = buildFirmwareDriverManifest({
      firmwareVersion: "1.2.0",
      chipFamily: "esp32s3",
      targetBoardSlug: "esp32-s3-devkitc-1-n16r8",
      partitionScheme: "dual_ota_16mb",
      flashSizeMb: 16,
      psramMode: "octal",
    });

    const validated = validateFirmwareDriverManifest(manifest, {
      expectedChipFamily: "esp32s3",
      expectedBoardSlug: "esp32-s3-devkitc-1-n16r8",
    });
    expect(validated.valid).toBe(true);
    expect(validated.errors).toEqual([]);

    const mismatch = validateFirmwareDriverManifest(manifest, {
      expectedChipFamily: "esp32c3",
      expectedBoardSlug: "esp32-c3-devkitm-1",
    });
    expect(mismatch.valid).toBe(false);
    expect(mismatch.errors.length).toBeGreaterThan(0);

    // Deterministic canonical serialization regardless of driver array order
    const reordered = {
      ...manifest,
      sensor_drivers: [...manifest.sensor_drivers].reverse(),
    };
    expect(buildCanonicalDriverManifestString(manifest)).toBe(
      buildCanonicalDriverManifestString(reordered)
    );

    // Every published board supports all 7 drivers at the hardware level
    for (const drvId of SENSOR_DRIVER_IDS) {
      const check = evaluateBoardDriverCompatibility(
        getBoardInput("seeed-xiao-esp32c5"),
        drvId
      );
      expect(check.supported, `Expected seeed-xiao-esp32c5 to support ${drvId}`).toBe(true);
    }
  });
});
