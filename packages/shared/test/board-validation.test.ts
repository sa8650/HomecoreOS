import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADMIN_NOTIFICATION_PREFERENCES,
  DEFAULT_USER_NOTIFICATION_PREFERENCES,
  VERIFIED_BOARD_CATALOG,
  buildEsp32S3N16R8PinMap,
  compareFirmwareVersions,
  isNewerFirmwareVersion,
  isSupportedDeviceType,
  parseFlashSizeMb,
  requiredPinCapabilityForDevice,
  resolveBoardHardwareSpecs,
  validateBoardProfileSpec,
  validateFirmwareBoardsCompatibility,
  validateGpioAssignment,
} from "../src/index";

describe("ESP32-S3 N16R8 GPIO & Board Profile Validation", () => {
  const n16r8 = {
    slug: "esp32-s3-devkitc-1-n16r8",
    manufacturer: "Espressif",
    model: "ESP32-S3-DevKitC-1 N16R8",
    revision: "v1.1",
    chip_family: "esp32s3" as const,
    chip_variant: "ESP32-S3-WROOM-1-N16R8",
    flash_size_mb: 16,
    psram_size_mb: 8,
    gpio_definitions: buildEsp32S3N16R8PinMap(),
  };

  it("validates the built-in ESP32-S3 N16R8 board profile", () => {
    expect(validateBoardProfileSpec(n16r8)).toEqual({ valid: true, errors: [] });
  });

  it("blocks Octal PSRAM pins GPIO 35-37 and SPI Flash pins GPIO 26-32", () => {
    for (const pin of [26, 28, 33, 35, 36, 37]) {
      const res = validateGpioAssignment({
        board: n16r8,
        pin,
        requirement: "digital_out",
        usedPinsOnController: [],
      });
      expect(res.valid).toBe(false);
      expect(res.errors.length).toBeGreaterThan(0);
    }
  });

  it("blocks duplicate GPIO pin assignments on the same controller", () => {
    const res = validateGpioAssignment({
      board: n16r8,
      pin: 4,
      requirement: "digital_out",
      usedPinsOnController: [4, 5],
    });
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toMatch(/already assigned/i);
  });

  it("blocks output assignment on input-only GPIO46 and warns on strapping pins", () => {
    const res46 = validateGpioAssignment({
      board: n16r8,
      pin: 46,
      requirement: "digital_out",
      usedPinsOnController: [],
    });
    expect(res46.valid).toBe(false);

    const res0 = validateGpioAssignment({
      board: n16r8,
      pin: 0,
      requirement: "digital_in",
      usedPinsOnController: [],
    });
    expect(res0.valid).toBe(true);
    expect(res0.warnings[0]).toMatch(/strapping/i);
  });

  it("allows safe ADC1 and digital output pins", () => {
    const adc = validateGpioAssignment({
      board: n16r8,
      pin: 4,
      requirement: "adc",
      usedPinsOnController: [],
    });
    expect(adc.valid).toBe(true);

    const out = validateGpioAssignment({
      board: n16r8,
      pin: 15,
      requirement: "pwm",
      usedPinsOnController: [4],
    });
    expect(out.valid).toBe(true);
  });

  it("compares semantic and prerelease firmware versions accurately", () => {
    expect(compareFirmwareVersions("1.10.0", "1.2.0")).toBeGreaterThan(0);
    expect(compareFirmwareVersions("v1.2.0", "1.2.0-beta.1")).toBeGreaterThan(0);
    expect(compareFirmwareVersions("1.2.0-beta.2", "1.2.0-beta.1")).toBeGreaterThan(0);
    expect(compareFirmwareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(isNewerFirmwareVersion("1.1.0", "1.0.0")).toBe(true);
    expect(isNewerFirmwareVersion("1.0.0", "1.1.0")).toBe(false);
    expect(isNewerFirmwareVersion("1.0.0", null)).toBe(true);
  });

  it("supports TV device type and validates multi-board firmware compatibility", () => {
    expect(isSupportedDeviceType("tv")).toBe(true);
    expect(requiredPinCapabilityForDevice("tv")).toBe("digital_out");
    expect(parseFlashSizeMb("16MB")).toBe(16);
    expect(parseFlashSizeMb("4MB")).toBe(4);

    const compat = validateFirmwareBoardsCompatibility({
      chipFamily: "esp32s3",
      flashSizeMb: 16,
      boards: [
        {
          id: "b1",
          manufacturer: "Espressif",
          model: "ESP32-S3-DevKitC-1 N16R8",
          chip_family: "esp32s3",
          flash_size_mb: 16,
        },
        {
          id: "b2",
          manufacturer: "Espressif",
          model: "ESP32-C3 Mini",
          chip_family: "esp32c3",
          flash_size_mb: 4,
        },
      ],
    });
    expect(compat.valid).toBe(false);
    expect(compat.errors.length).toBe(2);

    const validCompat = validateFirmwareBoardsCompatibility({
      chipFamily: "esp32s3",
      flashSizeMb: 8,
      boards: [
        {
          id: "b1",
          manufacturer: "Espressif",
          model: "ESP32-S3-DevKitC-1 N16R8",
          chip_family: "esp32s3",
          flash_size_mb: 16,
        },
        {
          id: "b3",
          manufacturer: "Espressif",
          model: "ESP32-S3 Mini 8MB",
          chip_family: "esp32s3",
          flash_size_mb: 8,
        },
      ],
    });
    expect(validCompat).toEqual({ valid: true, errors: [] });
  });

  it("provides strict default user & admin notification preference maps", () => {
    expect(Object.keys(DEFAULT_USER_NOTIFICATION_PREFERENCES)).toEqual([
      "controller_offline_online",
      "device_disconnected",
      "sensor_alerts",
      "automation_failures",
      "firmware_updates",
      "firmware_install_results",
      "security_events",
    ]);
    expect(Object.values(DEFAULT_USER_NOTIFICATION_PREFERENCES).every(Boolean)).toBe(true);

    expect(Object.keys(DEFAULT_ADMIN_NOTIFICATION_PREFERENCES)).toEqual([
      "new_user_registrations",
      "controller_activity",
      "firmware_publishing",
      "platform_errors",
      "service_health_alerts",
    ]);
    expect(Object.values(DEFAULT_ADMIN_NOTIFICATION_PREFERENCES).every(Boolean)).toBe(true);
  });

  it("resolves official hardware specifications for catalog and custom boards", () => {
    const s3 = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;
    const xiao = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "seeed-xiao-esp32s3")!;
    const h2 = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "esp32-h2-devkitm-1")!;

    expect(resolveBoardHardwareSpecs(s3)).toMatchObject({
      processor: "Dual-Core Xtensa LX7 (240 MHz)",
      memory: "16MB Flash + 8MB PSRAM",
      wireless: "Wi-Fi 4, BLE 5.0",
      usbPortCount: 2,
      usbConnector: "usb-c",
      buttons: "RST + BOOT",
      modulePackage: "wroom",
    });

    expect(resolveBoardHardwareSpecs(xiao)).toMatchObject({
      memory: "8MB Flash + 8MB PSRAM",
      usb: "1x USB-C",
      usbPortCount: 1,
      modulePackage: "xiao",
      hasUartBridge: false,
    });

    expect(resolveBoardHardwareSpecs(h2)).toMatchObject({
      wireless: "BLE 5.3, Zigbee / Thread (No Wi-Fi)",
      memory: "4MB Flash",
      modulePackage: "mini",
    });
  });
});
