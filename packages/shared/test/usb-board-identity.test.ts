import { describe, expect, it } from "vitest";
import {
  SEEED_XIAO_OFFICIAL_BOARDS,
  VERIFIED_BOARD_CATALOG,
  canonicalChipFamily,
  describeUsbSerialInterface,
  detectedPsramFromFeatures,
  usbBoardMismatchImpact,
  verifyUsbBoardIdentity,
  type DetectedUsbBoard,
} from "../src/index";

const library = [...VERIFIED_BOARD_CATALOG, ...SEEED_XIAO_OFFICIAL_BOARDS.filter((b) => b.seed.slug !== "seeed-xiao-esp32s3").map((b) => b.seed)];
const board = (slug: string) => {
  const found = library.find((b) => b.slug === slug);
  if (!found) throw new Error(`missing ${slug}`);
  return found;
};

const xiaoS3Hardware: DetectedUsbBoard = {
  chipName: "ESP32-S3 (QFN56) (revision v0.2)",
  flashSizeMb: 8,
  psramSizeMb: 8,
  usbVendorId: 0x303a,
  usbProductId: 0x1001,
};

describe("USB board identity verification", () => {
  it("normalises ROM chip names to whole chip families", () => {
    expect(canonicalChipFamily("ESP32-S3 (QFN56) (revision v0.2)")).toBe("esp32s3");
    expect(canonicalChipFamily("ESP32-C61 (revision v0.1)")).toBe("esp32c61");
    expect(canonicalChipFamily("ESP32-C6")).toBe("esp32c6");
    expect(canonicalChipFamily("ESP8684 (revision v1.0)")).toBe("esp32c2");
    expect(canonicalChipFamily("ESP32-D0WD-V3 (revision v3.1)")).toBe("esp32");
    expect(canonicalChipFamily("esp32c5")).toBe("esp32c5");
    expect(canonicalChipFamily("")).toBe("");
  });

  it("classifies the USB interface of the selected serial port", () => {
    expect(describeUsbSerialInterface(0x303a, 0x1001)).toMatchObject({ kind: "native_usb", usbId: "303A:1001" });
    expect(describeUsbSerialInterface(0x10c4, 0xea60)).toMatchObject({ kind: "uart_bridge" });
    expect(describeUsbSerialInterface(0x1a86, 0x55d4)).toMatchObject({ kind: "uart_bridge" });
    expect(describeUsbSerialInterface(0x2886, 0x0056)).toMatchObject({ kind: "vendor_usb", vendorName: "Seeed Studio" });
    expect(describeUsbSerialInterface(undefined, undefined)).toMatchObject({ kind: "unknown", usbId: null });
  });

  it("reads in-package PSRAM only where the chip reports it", () => {
    expect(detectedPsramFromFeatures("ESP32-S3", ["Wi-Fi", "BLE", "Embedded PSRAM 8MB (AP_3v3)"])).toBe(8);
    expect(detectedPsramFromFeatures("ESP32-S3", ["Wi-Fi", "BLE"])).toBe(0);
    // An unsized PSRAM entry is unknown, never "none".
    expect(detectedPsramFromFeatures("ESP32-S3", ["Wi-Fi", "Unknown Embedded PSRAM (AP_1v8)"])).toBeNull();
    // Other families do not report PSRAM: unknown.
    expect(detectedPsramFromFeatures("ESP32-C3", ["Wi-Fi", "BLE"])).toBeNull();
    expect(detectedPsramFromFeatures("ESP32-S3", undefined)).toBeNull();
  });

  it("reports a match when the connected hardware agrees with the selected board", () => {
    const report = verifyUsbBoardIdentity({
      detected: xiaoS3Hardware,
      selectedBoard: board("seeed-xiao-esp32s3"),
      candidateBoards: library,
      firmware: { chipFamily: "esp32s3", minFlashMb: 8, label: "HomecoreOS v1.4.0" },
    });
    expect(report.result).toBe("match");
    expect(report.severity).toBe("none");
    expect(report.mismatches).toEqual([]);
    expect(report.recommended).toEqual([]);
    expect(report.checks.map((c) => [c.key, c.status])).toEqual([
      ["chip", "match"],
      ["flash", "match"],
      ["psram", "match"],
      ["usb", "match"],
    ]);
    expect(report.detected.summary).toBe("ESP32-S3 · 8 MB flash · 8 MB PSRAM");
    expect(report.headline).toMatch(/matches Seeed Studio XIAO ESP32-S3/);
  });

  it("flags a different chip as critical and recommends boards with that chip", () => {
    const report = verifyUsbBoardIdentity({
      detected: {
        chipName: "ESP32-C3 (QFN32) (revision v0.4)",
        flashSizeMb: 4,
        psramSizeMb: null,
        usbVendorId: 0x303a,
        usbProductId: 0x1001,
      },
      selectedBoard: board("esp32-s3-devkitc-1-n16r8"),
      candidateBoards: library,
      firmware: { chipFamily: "esp32s3", minFlashMb: 16, label: "HomecoreOS v1.4.0" },
    });
    expect(report.result).toBe("mismatch");
    expect(report.severity).toBe("critical");
    expect(report.mismatches.map((m) => m.code)).toContain("chip_family");
    expect(report.mismatches.filter((m) => m.code === "chip_family")).toHaveLength(1);
    // Native USB + ESP32-C3 + 4 MB: the XIAO ESP32-C3 fits, the bridge-only DevKitM-1 does not.
    expect(report.recommended.map((r) => r.board.slug)).toEqual(["seeed-xiao-esp32c3"]);
    expect(report.recommended[0]!.exact).toBe(true);
    expect(report.headline).toMatch(/^Board mismatch/);
  });

  it("tells a flash shortfall (major) from a larger variant (minor)", () => {
    const smaller = verifyUsbBoardIdentity({
      detected: { chipName: "ESP32-S3", flashSizeMb: 8, psramSizeMb: 8, usbVendorId: 0x10c4, usbProductId: 0xea60 },
      selectedBoard: board("esp32-s3-devkitc-1-n16r8"),
      candidateBoards: library,
    });
    expect(smaller.result).toBe("mismatch");
    expect(smaller.severity).toBe("major");
    expect(smaller.mismatches.map((m) => m.code)).toEqual(["flash_smaller"]);
    // Connected through a UART bridge, so the bridge-less XIAO is not recommended.
    expect(smaller.recommended.map((r) => r.board.slug)).toEqual(["esp32-s3-devkitc-1-v1-0"]);

    const larger = verifyUsbBoardIdentity({
      detected: { chipName: "ESP32-S3", flashSizeMb: 16, psramSizeMb: 8, usbVendorId: 0x10c4, usbProductId: 0xea60 },
      selectedBoard: board("esp32-s3-devkitc-1-v1-0"),
      candidateBoards: library,
    });
    expect(larger.result).toBe("mismatch");
    expect(larger.severity).toBe("minor");
    expect(larger.mismatches.map((m) => m.code)).toEqual(["flash_larger"]);
    expect(larger.recommended.map((r) => r.board.slug)).toEqual(["esp32-s3-devkitc-1-n16r8"]);
  });

  it("detects a board that is connected through the wrong kind of USB interface", () => {
    const report = verifyUsbBoardIdentity({
      detected: { ...xiaoS3Hardware, usbVendorId: 0x10c4, usbProductId: 0xea60 },
      selectedBoard: board("seeed-xiao-esp32s3"),
      candidateBoards: library,
    });
    expect(report.result).toBe("mismatch");
    expect(report.mismatches.map((m) => m.code)).toEqual(["usb_interface"]);
    expect(report.mismatches[0]!.detail).toMatch(/no USB-UART bridge/);
    expect(report.recommended.map((r) => r.board.slug)).toEqual(["esp32-s3-devkitc-1-v1-0"]);
  });

  it("detects a USB device of another vendor and prefers the board that owns the USB ID", () => {
    const report = verifyUsbBoardIdentity({
      detected: { ...xiaoS3Hardware, usbVendorId: 0x2886, usbProductId: 0x0056 },
      selectedBoard: board("esp32-s3-devkitc-1-v1-0"),
      candidateBoards: library,
    });
    expect(report.result).toBe("mismatch");
    expect(report.mismatches.map((m) => m.code)).toEqual(["usb_vendor"]);
    expect(report.recommended.map((r) => r.board.slug).sort()).toEqual(
      ["seeed-xiao-esp32s3", "seeed-xiao-esp32s3-sense"].sort()
    );
  });

  it("words the consequence by what differs, not only by how firmly to stop", () => {
    const check = (detected: DetectedUsbBoard, slug: string) =>
      verifyUsbBoardIdentity({ detected, selectedBoard: board(slug), candidateBoards: library });

    // Another chip: the firmware cannot start.
    const chip = check({ ...xiaoS3Hardware, chipName: "ESP32-C3 (QFN32) (revision v0.4)" }, "seeed-xiao-esp32s3");
    expect(usbBoardMismatchImpact(chip.mismatches)).toBe("will_not_start");

    // Less memory than the selected board: it may not start.
    const short = check({ ...xiaoS3Hardware, flashSizeMb: 4 }, "seeed-xiao-esp32s3");
    expect(short.severity).toBe("major");
    expect(usbBoardMismatchImpact(short.mismatches)).toBe("may_not_start");

    // Same chip and memory, another maker's USB ID: it stops as firmly (major),
    // but the honest consequence is a wrong board profile, not a boot failure.
    const vendor = check({ ...xiaoS3Hardware, usbVendorId: 0x2886, usbProductId: 0x0056 }, "esp32-s3-devkitc-1-v1-0");
    expect(vendor.mismatches.map((m) => m.code)).toEqual(["usb_vendor"]);
    expect(vendor.severity).toBe("major");
    expect(usbBoardMismatchImpact(vendor.mismatches)).toBe("different_board");

    const bridge = check({ ...xiaoS3Hardware, usbVendorId: 0x10c4, usbProductId: 0xea60 }, "seeed-xiao-esp32s3");
    expect(usbBoardMismatchImpact(bridge.mismatches)).toBe("different_board");

    // More memory only: a variant of the same board.
    const larger = check({ ...xiaoS3Hardware, flashSizeMb: 16 }, "seeed-xiao-esp32s3");
    expect(larger.severity).toBe("minor");
    expect(usbBoardMismatchImpact(larger.mismatches)).toBe("different_variant");

    // A shortfall outranks a USB difference that comes with it.
    const both = check({ ...xiaoS3Hardware, flashSizeMb: 4, usbVendorId: 0x10c4, usbProductId: 0xea60 }, "seeed-xiao-esp32s3");
    expect(both.mismatches.map((m) => m.code).sort()).toEqual(["flash_smaller", "usb_interface"]);
    expect(usbBoardMismatchImpact(both.mismatches)).toBe("may_not_start");

    expect(usbBoardMismatchImpact([])).toBeNull();
  });

  it("never turns missing information into a mismatch", () => {
    const report = verifyUsbBoardIdentity({
      detected: { chipName: "ESP32-S3", flashSizeMb: null, psramSizeMb: null },
      selectedBoard: board("esp32-s3-devkitc-1-n16r8"),
      candidateBoards: library,
    });
    expect(report.result).toBe("match");
    expect(report.checks.filter((c) => c.status === "unknown").map((c) => c.key)).toEqual([
      "flash",
      "psram",
      "usb",
    ]);

    // A partly filled target (legacy callers) falls back to the firmware's needs.
    const partial = verifyUsbBoardIdentity({
      detected: { chipName: "ESP32-S3", flashSizeMb: 16, psramSizeMb: null },
      selectedBoard: { slug: "esp32-s3-devkitc-1-n16r8", model: "ESP32-S3-DevKitC-1-N16R8", flash_size_mb: 16 },
      firmware: { chipFamily: "esp32s3", minFlashMb: 16, label: "HomecoreOS v1.0.0" },
    });
    expect(partial.result).toBe("match");
  });

  it("checks the firmware's own requirements when no board is selected", () => {
    const chip = verifyUsbBoardIdentity({
      detected: { chipName: "ESP32-C3 (QFN32)", flashSizeMb: 4, psramSizeMb: null },
      selectedBoard: null,
      candidateBoards: library,
      firmware: { chipFamily: "esp32s3", minFlashMb: null, label: "HomecoreOS v1.0.0" },
    });
    expect(chip.result).toBe("mismatch");
    expect(chip.severity).toBe("critical");
    expect(chip.selected).toBeNull();

    const flash = verifyUsbBoardIdentity({
      detected: { chipName: "ESP32-S3", flashSizeMb: 8, psramSizeMb: null },
      selectedBoard: null,
      firmware: { chipFamily: "esp32s3", minFlashMb: 16, label: "HomecoreOS v1.0.0" },
    });
    expect(flash.mismatches.map((m) => m.code)).toEqual(["flash_smaller"]);
    expect(flash.severity).toBe("major");
  });

  it("identifies the board when exactly one library profile fits", () => {
    const report = verifyUsbBoardIdentity({
      detected: { chipName: "ESP32-C6", flashSizeMb: 4, psramSizeMb: null, usbVendorId: 0x303a, usbProductId: 0x1001 },
      selectedBoard: null,
      candidateBoards: [board("seeed-xiao-esp32c6"), board("esp32-s3-devkitc-1-n16r8")],
      firmware: { chipFamily: "esp32c6", minFlashMb: 4, label: "HomecoreOS v1.0.0" },
    });
    expect(report.result).toBe("match");
    expect(report.identified?.slug).toBe("seeed-xiao-esp32c6");
    expect(report.headline).toMatch(/identified as Seeed Studio XIAO ESP32-C6/);
  });
});
