import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOMECORE_BLE_SERVICE_UUID,
  VERIFIED_BOARD_CATALOG,
  chipSupportsBle,
  evaluateReleaseCompatibilityForBoard,
  inspectEspIdfBinary,
  resolveBoardFirmwareCompatibility,
  resolveBoardSelectionBuildConfig,
  supportsBleProvisioningForBoard,
  validateBleProvisioningInputs,
  validateFirmwareBoardsCompatibility,
} from "../src/index";

describe("Multi-Board Firmware Compatibility Metadata", () => {
  it("resolves exact compatibility metadata for all 11 cataloged boards", () => {
    expect(VERIFIED_BOARD_CATALOG).toHaveLength(11);

    const bySlug = new Map(VERIFIED_BOARD_CATALOG.map((b) => [b.slug, b]));

    const n16r8 = bySlug.get("esp32-s3-devkitc-1-n16r8")!;
    expect(n16r8.firmware_status).toBe("firmware_supported");
    expect(resolveBoardFirmwareCompatibility(n16r8)).toMatchObject({
      partition_scheme: "dual_ota_16mb",
      psram_mode: "octal",
      flash_mode: "qio",
      flash_freq: "80m",
      bootloader_offset: "0x0",
      boot_button_gpio: 0,
      supports_wifi: true,
    });

    const xiao = bySlug.get("seeed-xiao-esp32s3")!;
    const s3v10 = bySlug.get("esp32-s3-devkitc-1-v1-0")!;
    expect(xiao.firmware_status).toBe("catalog_only");
    expect(s3v10.firmware_status).toBe("catalog_only");
    expect(xiao.firmware_compat_key).toBe("esp32s3-8m-qio-octal8m-dual_ota_8mb-b0");
    expect(s3v10.firmware_compat_key).toBe(xiao.firmware_compat_key);
    expect(n16r8.firmware_compat_key).not.toBe(xiao.firmware_compat_key);

    const c5 = bySlug.get("esp32-c5-devkitc-1")!;
    expect(resolveBoardFirmwareCompatibility(c5)).toMatchObject({
      partition_scheme: "dual_ota_8mb",
      psram_mode: "quad",
      bootloader_offset: "0x2000",
      boot_button_gpio: 28,
      supports_wifi: true,
    });

    const c3 = bySlug.get("esp32-c3-devkitm-1")!;
    expect(resolveBoardFirmwareCompatibility(c3)).toMatchObject({
      partition_scheme: "dual_ota_4mb",
      psram_mode: "none",
      bootloader_offset: "0x0",
      boot_button_gpio: 9,
      supports_wifi: true,
    });

    const esp32v4 = bySlug.get("esp32-devkitc-v4")!;
    expect(resolveBoardFirmwareCompatibility(esp32v4)).toMatchObject({
      partition_scheme: "dual_ota_4mb",
      psram_mode: "none",
      flash_freq: "40m",
      bootloader_offset: "0x1000",
      boot_button_gpio: 0,
    });

    const h2 = bySlug.get("esp32-h2-devkitm-1")!;
    expect(resolveBoardFirmwareCompatibility(h2)).toMatchObject({
      partition_scheme: "dual_ota_4mb",
      psram_mode: "none",
      flash_freq: "64m",
      boot_button_gpio: 9,
      supports_wifi: false,
    });
  });

  it("blocks cross-chip, insufficient flash, and PSRAM mode mismatches", () => {
    const n16r8 = VERIFIED_BOARD_CATALOG.find(
      (b) => b.slug === "esp32-s3-devkitc-1-n16r8"
    )!;
    const xiao = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "seeed-xiao-esp32s3")!;
    const c3 = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "esp32-c3-devkitm-1")!;
    const s2 = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "esp32-s2-devkitc-1")!;

    // 16MB Octal PSRAM N16R8 binary cannot run on 8MB XIAO S3
    const flashMismatch = evaluateReleaseCompatibilityForBoard({
      release: {
        chip_family: "esp32s3",
        status: "published",
        partition_scheme: "dual_ota_16mb",
        psram_mode: "octal",
        flash_size_mb: 16,
      },
      board: xiao,
      requirePublished: true,
    });
    expect(flashMismatch.compatible).toBe(false);
    expect(flashMismatch.reasons.some((r) => /16MB|Insufficient flash/i.test(r))).toBe(true);

    // Octal PSRAM firmware rejected on Quad PSRAM board
    const psramCheck = validateFirmwareBoardsCompatibility({
      chipFamily: "esp32s2",
      flashSizeMb: 4,
      psramMode: "octal",
      boards: [
        {
          id: "s2",
          manufacturer: s2.manufacturer,
          model: s2.model,
          chip_family: s2.chip_family,
          flash_size_mb: s2.flash_size_mb,
          psram_size_mb: s2.psram_size_mb,
          psram_mode: s2.psram_mode,
        },
      ],
    });
    expect(psramCheck.valid).toBe(false);
    expect(psramCheck.errors[0]).toMatch(/OCTAL PSRAM/i);

    // Cross-chip rejected
    const crossChip = evaluateReleaseCompatibilityForBoard({
      release: {
        chip_family: "esp32s3",
        status: "published",
        partition_scheme: "dual_ota_4mb",
        psram_mode: "none",
      },
      board: c3,
    });
    expect(crossChip.compatible).toBe(false);
    expect(crossChip.reasons[0]).toMatch(/Chip mismatch/i);

    // Matching board accepted
    const valid = evaluateReleaseCompatibilityForBoard({
      release: {
        chip_family: "esp32s3",
        status: "published",
        target_board_slug: "esp32-s3-devkitc-1-n16r8",
        compatible_board_slugs: ["esp32-s3-devkitc-1-n16r8"],
        partition_scheme: "dual_ota_16mb",
        psram_mode: "octal",
        flash_size_mb: 16,
      },
      board: n16r8,
      requirePublished: true,
    });
    expect(valid.compatible).toBe(true);
    expect(valid.reasons).toHaveLength(0);
  });

  it("keeps firmware/boards/*.sdkconfig, partitions/*.csv, and CI build matrix aligned with all 11 catalog boards", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const workflow = readFileSync(
      path.join(repoRoot, ".github/workflows/build-firmware.yml"),
      "utf8"
    );

    for (const board of VERIFIED_BOARD_CATALOG) {
      const sdkPath = path.join(repoRoot, "firmware/boards", `${board.slug}.sdkconfig`);
      expect(existsSync(sdkPath), `Missing overlay ${sdkPath}`).toBe(true);
      const sdk = readFileSync(sdkPath, "utf8");
      const compat = resolveBoardFirmwareCompatibility(board);

      expect(sdk).toContain(`CONFIG_IDF_TARGET="${board.chip_family}"`);
      expect(sdk).toContain(`CONFIG_HOMECORE_BOARD_SLUG="${board.slug}"`);
      expect(sdk).toContain(`CONFIG_HOMECORE_PARTITION_SCHEME="${compat.partition_scheme}"`);
      expect(sdk).toContain(`CONFIG_HOMECORE_BOOT_BUTTON_GPIO=${compat.boot_button_gpio}`);
      expect(sdk).toContain(`CONFIG_HOMECORE_FLASH_SIZE_MB=${board.flash_size_mb}`);
      expect(sdk).toContain(`CONFIG_HOMECORE_PSRAM_SIZE_MB=${board.psram_size_mb}`);

      if (compat.psram_mode === "octal") {
        expect(sdk).toContain("CONFIG_SPIRAM_MODE_OCT=y");
      } else if (compat.psram_mode === "quad") {
        expect(sdk).toContain("CONFIG_SPIRAM_MODE_QUAD=y");
      }

      if (board.slug === "seeed-xiao-esp32s3") {
        expect(sdk).toContain("CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y");
      }
      if (board.slug === "esp8684-devkitm-1") {
        expect(sdk).toContain("CONFIG_XTAL_FREQ_26=y");
      }

      expect(workflow).toContain(`"board_slug": "${board.slug}"`);
      expect(workflow).toContain(`"partition_scheme": "${compat.partition_scheme}"`);
    }

    // Workflow must never reference matrix.* inside a job-level `if` condition
    expect(workflow).toContain("prepare-matrix:");
    expect(workflow).toContain("fromJson(needs.prepare-matrix.outputs.matrix)");
    const jobIfLines = workflow
      .split(/\r?\n/)
      .filter((line) => /^\s{4}if:\s/.test(line));
    for (const ifLine of jobIfLines) {
      expect(ifLine).not.toContain("matrix.");
    }

    // All three partition tables preserve identical NVS / otadata / phy_init / ota_0 base offsets
    for (const partName of ["partitions_4mb.csv", "partitions_8mb.csv", "partitions_16mb.csv"]) {
      const csv = readFileSync(path.join(repoRoot, "firmware/partitions", partName), "utf8");
      expect(csv).toContain("0x9000");
      expect(csv).toContain("0xf000");
      expect(csv).toContain("0x11000");
      expect(csv).toContain("0x20000");
    }
  });

  it("automatically resolves build configs from selected boards and rejects incompatible combinations", () => {
    const bySlug = new Map(VERIFIED_BOARD_CATALOG.map((b) => [b.slug, b]));
    const n16r8 = bySlug.get("esp32-s3-devkitc-1-n16r8")!;
    const xiao = bySlug.get("seeed-xiao-esp32s3")!;
    const s3v10 = bySlug.get("esp32-s3-devkitc-1-v1-0")!;
    const c5 = bySlug.get("esp32-c5-devkitc-1")!;
    const h2 = bySlug.get("esp32-h2-devkitm-1")!;

    // Empty board list rejected
    expect(resolveBoardSelectionBuildConfig([]).valid).toBe(false);

    // Single board ESP32-C5 auto-resolves chip, flash, PSRAM, partition, mode, freq, offsets
    const c5Resolved = resolveBoardSelectionBuildConfig([c5]);
    expect(c5Resolved.valid).toBe(true);
    expect(c5Resolved).toMatchObject({
      chipFamily: "esp32c5",
      targetBoardSlug: "esp32-c5-devkitc-1",
      partitionScheme: "dual_ota_8mb",
      psramMode: "quad",
      flashMode: "dio",
      flashFreq: "80m",
      flashSizeMb: 8,
      flashSizeLabel: "8MB",
      bootloaderOffset: "0x2000",
      otaAppOffset: "0x20000",
    });

    // Multi-board matching configuration (XIAO ESP32S3 + DevKitC-1 v1.0 both 8MB octal QIO 80m) succeeds
    const s3Pair = resolveBoardSelectionBuildConfig([xiao, s3v10]);
    expect(s3Pair.valid).toBe(true);
    expect(s3Pair.targetBoardSlug).toBeNull();
    expect(s3Pair.partitionScheme).toBe("dual_ota_8mb");
    expect(s3Pair.flashSizeMb).toBe(8);

    // Mixing 16MB N16R8 and 8MB XIAO requires separate builds
    const mixedFlash = resolveBoardSelectionBuildConfig([n16r8, xiao]);
    expect(mixedFlash.valid).toBe(false);
    expect(mixedFlash.errors.some((e) => /flash|partition/i.test(e))).toBe(true);

    // Mixing chips (ESP32-S3 + ESP32-C5) requires separate builds
    const mixedChips = resolveBoardSelectionBuildConfig([n16r8, c5]);
    expect(mixedChips.valid).toBe(false);
    expect(mixedChips.errors.some((e) => /chip/i.test(e))).toBe(true);

    // Unsupported board blocked
    const unsupportedRes = resolveBoardSelectionBuildConfig([
      { ...c5, firmware_status: "unsupported" },
    ]);
    expect(unsupportedRes.valid).toBe(false);
    expect(unsupportedRes.errors[0]).toMatch(/unsupported/i);

    // Non-Wi-Fi board emits warning while resolving valid metadata
    const h2Resolved = resolveBoardSelectionBuildConfig([h2]);
    expect(h2Resolved.valid).toBe(true);
    expect(h2Resolved.supportsWifi).toBe(false);
    expect(h2Resolved.warnings.length).toBeGreaterThan(0);
  });

  it("inspects ESP-IDF binary headers for chip mismatch, bootloader offset, and partition overflow", () => {
    // Valid C3 OTA binary with ESP-IDF extended header (wp_pin=0xee, chipId=5)
    const c3Ota = new Uint8Array(512);
    c3Ota[0] = 0xe9;
    c3Ota[1] = 0x04;
    c3Ota[2] = 0x02; // dio
    c3Ota[3] = 0x2f; // 4MB, 80m
    c3Ota[8] = 0xee; // wp_pin disabled marker
    c3Ota[12] = 5; // ESP32-C3 chip ID
    c3Ota[23] = 1; // append_digest

    expect(inspectEspIdfBinary(c3Ota, "ota_app", { chipFamily: "esp32c3" }).valid).toBe(true);
    const wrongChip = inspectEspIdfBinary(c3Ota, "ota_app", { chipFamily: "esp32s3" });
    expect(wrongChip.valid).toBe(false);
    expect(wrongChip.error).toMatch(/ESP32C3.*ESP32S3/i);

    // ESP32-C5 USB factory binary expects bootloader at 0x2000
    const c5FactoryAtZero = new Uint8Array(0x4000);
    c5FactoryAtZero[0] = 0xe9;
    const wrongOffset = inspectEspIdfBinary(c5FactoryAtZero, "usb_factory", {
      chipFamily: "esp32c5",
      flashSizeMb: 8,
      bootloaderOffset: "0x2000",
    });
    expect(wrongOffset.valid).toBe(false);
    expect(wrongOffset.error).toMatch(/0x2000/);

    const c5FactoryValid = new Uint8Array(0x4000);
    c5FactoryValid[0x2000] = 0xe9;
    c5FactoryValid[0x2008] = 0xee;
    c5FactoryValid[0x200c] = 23; // ESP32-C5 chip ID
    c5FactoryValid[0x2017] = 1;
    expect(
      inspectEspIdfBinary(c5FactoryValid, "usb_factory", {
        chipFamily: "esp32c5",
        flashSizeMb: 8,
        bootloaderOffset: "0x2000",
      }).valid
    ).toBe(true);

    // Merged USB factory binary uploaded as OTA app is rejected via 0x8000 partition table check
    const mergedUsb = new Uint8Array(0x9000);
    mergedUsb[0] = 0xe9;
    mergedUsb[0x8000] = 0xaa;
    mergedUsb[0x8001] = 0x50;
    // Partition ending at 16MB (offset 0x900000 + size 0x700000)
    mergedUsb[0x8004] = 0x00;
    mergedUsb[0x8005] = 0x00;
    mergedUsb[0x8006] = 0x90;
    mergedUsb[0x8008] = 0x00;
    mergedUsb[0x8009] = 0x00;
    mergedUsb[0x800a] = 0x70;
    const usbAsOta = inspectEspIdfBinary(mergedUsb, "ota_app", { chipFamily: "esp32s3" });
    expect(usbAsOta.valid).toBe(false);
    expect(usbAsOta.error).toMatch(/merged USB factory image/i);

    const overflowUsb = inspectEspIdfBinary(mergedUsb, "usb_factory", {
      chipFamily: "esp32s3",
      flashSizeMb: 8,
      bootloaderOffset: "0x0",
    });
    expect(overflowUsb.valid).toBe(false);
    expect(overflowUsb.error).toMatch(/exceeding selected board flash \(8MB\)/i);

    // Embedded esp_app_desc_t version extraction & mismatch warning
    const otaWithDesc = new Uint8Array(0x400);
    otaWithDesc[0] = 0xe9;
    otaWithDesc[12] = 0x09; // ESP32-S3 chip_id LE
    otaWithDesc[13] = 0x00;
    // esp_app_desc_t at 0x20: magic 0xABCD5432 LE = 0x32, 0x54, 0xCD, 0xAB
    otaWithDesc[0x20] = 0x32;
    otaWithDesc[0x21] = 0x54;
    otaWithDesc[0x22] = 0xcd;
    otaWithDesc[0x23] = 0xab;
    const writeCString = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i += 1) {
        otaWithDesc[offset + i] = value.charCodeAt(i);
      }
    };
    writeCString(0x30, "1.1.0");
    writeCString(0x50, "HomecoreOS");

    const mismatched = inspectEspIdfBinary(otaWithDesc, "ota_app", {
      chipFamily: "esp32s3",
      version: "1.2.9",
    });
    expect(mismatched.valid).toBe(true);
    expect(mismatched.embeddedAppVersion).toBe("1.1.0");
    expect(mismatched.embeddedProjectName).toBe("HomecoreOS");
    expect(mismatched.versionMismatchWarning).toMatch(/reports v1\.1\.0.*release version v1\.2\.9/i);

    const matched = inspectEspIdfBinary(otaWithDesc, "ota_app", {
      chipFamily: "esp32s3",
      version: "1.1.0",
    });
    expect(matched.valid).toBe(true);
    expect(matched.versionMismatchWarning).toBeNull();

    // Scenario 1: Build with requested version 1.2.9 verifies esp_app_desc_t.version == "1.2.9"
    const ota129 = new Uint8Array(otaWithDesc);
    for (let i = 0x30; i < 0x50; i += 1) ota129[i] = 0;
    for (let i = 0; i < "1.2.9".length; i += 1) ota129[0x30 + i] = "1.2.9".charCodeAt(i);
    const inspected129 = inspectEspIdfBinary(ota129, "ota_app", {
      chipFamily: "esp32s3",
      version: "1.2.9",
    });
    expect(inspected129.valid).toBe(true);
    expect(inspected129.embeddedAppVersion).toBe("1.2.9");
    expect(inspected129.versionMismatchWarning).toBeNull();
  });

  it("enforces HOMECORE_FW_VERSION propagation, single-quote-free esp-idf-ci-action command, verify_firmware_image.py checks, and ESP32-S3 N16R8 partition limits in CI", () => {
    const rootDir = path.resolve(import.meta.dirname, "../../..");
    const workflow = readFileSync(
      path.join(rootDir, ".github/workflows/build-firmware.yml"),
      "utf8"
    );
    const verifyPy = readFileSync(
      path.join(rootDir, "firmware/scripts/verify_firmware_image.py"),
      "utf8"
    );
    const cmake = readFileSync(path.join(rootDir, "firmware/CMakeLists.txt"), "utf8");
    const n16r8Cfg = readFileSync(
      path.join(rootDir, "firmware/boards/esp32-s3-devkitc-1-n16r8.sdkconfig"),
      "utf8"
    );
    const part16 = readFileSync(
      path.join(rootDir, "firmware/partitions/partitions_16mb.csv"),
      "utf8"
    );
    const sdkDefaults = readFileSync(
      path.join(rootDir, "firmware/sdkconfig.defaults"),
      "utf8"
    );

    // Scenario 3: GH Actions explicitly assigns, exports, and validates HOMECORE_FW_VERSION inside container command
    expect(workflow).toContain('HOMECORE_FW_VERSION="${{ needs.prepare-matrix.outputs.version }}"');
    expect(workflow).toContain("export HOMECORE_FW_VERSION");
    expect(workflow).toContain('if [ -z "${HOMECORE_FW_VERSION}" ]');
    expect(workflow).toContain('-DHOMECORE_FW_VERSION="${HOMECORE_FW_VERSION}"');
    expect(workflow).toContain("python3 scripts/verify_firmware_image.py --write-sdkconfig-version");
    expect(workflow).toContain("--verify-build");
    expect(workflow).toContain("verify_firmware_image.py");
    expect(workflow).toContain("--verify-package");
    // Regression guard: esp-idf-ci-action@v1 wraps `inputs.command` inside single quotes (`/bin/bash -c '... && ${{ inputs.command }}'`).
    const commandBlockMatch = workflow.match(/uses: espressif\/esp-idf-ci-action@v1[\s\S]*?command:\s*\|\s*\n([\s\S]*?)(?:\n\s{6}- name:|\n\s{2}[a-z-]+:)/);
    expect(commandBlockMatch, "Missing espressif/esp-idf-ci-action@v1 command block").not.toBeNull();
    expect(commandBlockMatch![1]).not.toContain("'");
    expect(commandBlockMatch![1]).not.toContain("<<");

    // Scenario 2: verify_firmware_image.py checks esp_app_desc_t.version & sdkconfig match requested version and fails on mismatch
    expect(verifyPy).toContain("0xABCD5432");
    expect(verifyPy).toContain('normalize_version(app["version"]) != requested');
    expect(verifyPy).toContain("sdk_ver != requested");
    expect(workflow).toContain('"max_ota_bytes": 3145728');
    expect(workflow).toContain("homecoreos-usb-factory.bin");

    // CMakeLists maps HOMECORE_FW_VERSION into PROJECT_VER (esp_app_desc_t.version)
    expect(cmake).toContain('set(PROJECT_VER "${HOMECORE_FW_VERSION}")');

    // ESP32-S3 N16R8 config preserves bootloader rollback protection, 16MB QIO flash, 8MB Octal PSRAM, dual 3MB OTA
    expect(sdkDefaults).toContain("CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y");
    expect(n16r8Cfg).toContain('CONFIG_HOMECORE_PARTITION_SCHEME="dual_ota_16mb"');
    expect(n16r8Cfg).toContain("CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y");
    expect(n16r8Cfg).toContain("CONFIG_SPIRAM_MODE_OCT=y");
    expect(part16).toContain("ota_0,    app,  ota_0,   0x20000,  0x300000");
    expect(part16).toContain("ota_1,    app,  ota_1,   0x320000, 0x300000");
  });

  it("enforces exact BLE + Wi-Fi provisioning matrix across all 11 boards, ESP32-S2 NimBLE exclusion, and input validation", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const mainCmake = readFileSync(path.join(repoRoot, "firmware/main/CMakeLists.txt"), "utf8");
    const s2Cfg = readFileSync(
      path.join(repoRoot, "firmware/boards/esp32-s2-devkitc-1.sdkconfig"),
      "utf8"
    );
    const verifyPy = readFileSync(
      path.join(repoRoot, "firmware/scripts/verify_firmware_image.py"),
      "utf8"
    );

    expect(HOMECORE_BLE_SERVICE_UUID).toBe("686f6d65-636f-7265-0001-000000000001");
    expect(mainCmake).toContain('if(NOT IDF_TARGET STREQUAL "esp32s2")');
    expect(s2Cfg).toContain("# CONFIG_BT_ENABLED is not set");
    expect(s2Cfg).toContain("# CONFIG_BT_NIMBLE_ENABLED is not set");
    expect(verifyPy).toContain('if args.target == "esp32s2":');

    for (const board of VERIFIED_BOARD_CATALOG) {
      const compat = resolveBoardFirmwareCompatibility(board);
      const summary = supportsBleProvisioningForBoard(board);
      if (board.chip_family === "esp32s2") {
        expect(chipSupportsBle(board.chip_family)).toBe(false);
        expect(compat.supports_ble).toBe(false);
        expect(compat.supports_ble_wifi_provisioning).toBe(false);
        expect(summary.modeLabel).toBe("wifi_ap_only");
      } else if (board.chip_family === "esp32h2") {
        expect(chipSupportsBle(board.chip_family)).toBe(true);
        expect(compat.supports_ble).toBe(true);
        expect(compat.supports_ble_wifi_provisioning).toBe(false);
        expect(summary.modeLabel).toBe("ble_no_wifi");
      } else {
        expect(chipSupportsBle(board.chip_family)).toBe(true);
        expect(compat.supports_ble).toBe(true);
        expect(compat.supports_ble_wifi_provisioning).toBe(true);
        expect(summary.modeLabel).toBe("ble_and_wifi");
      }
    }

    // Input validation checks
    expect(
      validateBleProvisioningInputs({
        action: "provision_wifi",
        setupPin: "AB12",
        ssid: "HomeWiFi",
        pairCode: "482913",
      }).valid
    ).toBe(false);
    expect(
      validateBleProvisioningInputs({
        action: "provision_wifi",
        setupPin: "A7K9P2M4",
        ssid: "HomeWiFi",
        password: "short",
        pairCode: "482913",
      }).valid
    ).toBe(false);
    expect(
      validateBleProvisioningInputs({
        action: "provision_wifi",
        setupPin: "A7K9P2M4",
        ssid: "HomeWiFi",
        password: "MySecurePassword",
        pairCode: "482913",
        backendUrl: "https://api.homecoreos.example",
      }).valid
    ).toBe(true);
    expect(
      validateBleProvisioningInputs({
        action: "pair",
        setupPin: "A7K9P2M4",
        pairCode: "482913",
        supportsWifi: false,
      }).valid
    ).toBe(true);
    expect(
      validateBleProvisioningInputs({
        action: "provision_wifi",
        ssid: "HomeWiFi",
        password: "MySecurePassword",
        pairCode: "482913",
        backendUrl: "https://api.homecoreos.example",
      }).valid
    ).toBe(true);
  });
});
