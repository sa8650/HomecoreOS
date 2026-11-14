import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256HexClient } from "./api";

const mockMain = vi.fn(async () => "ESP32-S3 (QFN56) (revision v0.2)");
const mockDetectFlashSize = vi.fn(async () => "16MB");
const mockWriteFlash = vi.fn(async () => {});
const mockFlashMd5sum = vi.fn<() => Promise<string>>(async () => "");
const mockAfter = vi.fn(async () => {});
const mockDisconnect = vi.fn(async () => {});

vi.mock("esptool-js", () => ({
  Transport: class MockTransport {
    disconnect = mockDisconnect;
  },
  ESPLoader: class MockESPLoader {
    main = mockMain;
    detectFlashSize = mockDetectFlashSize;
    writeFlash = mockWriteFlash;
    flashMd5sum = mockFlashMd5sum;
    after = mockAfter;
  },
}));

import {
  chipMatchesFamily,
  flashFreshControllerViaUsb,
  isWebSerialSupported,
  md5Hex,
  type UsbFlashReleaseSpec,
} from "./usb-flasher";

const originalFetch = globalThis.fetch;

describe("Browser USB Firmware Flasher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "isSecureContext", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(navigator, "serial", {
      value: {
        requestPort: vi.fn(async () => ({})),
      },
      configurable: true,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("detects Web Serial capability cleanly", () => {
    expect(isWebSerialSupported()).toEqual({ supported: true });

    Object.defineProperty(navigator, "serial", {
      value: undefined,
      configurable: true,
    });
    const unsupported = isWebSerialSupported();
    expect(unsupported.supported).toBe(false);
    expect(unsupported.reason).toMatch(/Web Serial/i);
  });

  it("verifies SHA-256, flashes ESP32-S3, and logs success event", async () => {
    const fakeBin = new Uint8Array([0xe9, 0x04, 0x02, 0x20, 0x10, 0x00, 0x00, 0x00]);
    const expectedSha = await sha256HexClient(fakeBin);
    const recordedEvents: Array<{ url: string; body: unknown }> = [];

    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/download")) {
        return new Response(fakeBin, {
          status: 200,
          headers: { "X-Firmware-Sha256": expectedSha },
        });
      }
      if (url.includes("/usb-flash-events")) {
        recordedEvents.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const release: UsbFlashReleaseSpec = {
      id: "rel-1",
      name: "HomecoreOS",
      version: "1.0.0",
      chip_family: "esp32s3",
      files: [
        {
          id: "file-usb",
          file_type: "usb_factory",
          file_name: "homecoreos-usb-factory.bin",
          size_bytes: fakeBin.byteLength,
          sha256: expectedSha,
          flash_address: "0x0",
          flash_mode: "qio",
          flash_freq: "80m",
          flash_size: "16MB",
        },
      ],
    };

    const stages: string[] = [];
    let detectedChip = "";
    const expectedMd5 = md5Hex(fakeBin);
    mockFlashMd5sum.mockResolvedValueOnce(expectedMd5);

    const result = await flashFreshControllerViaUsb({
      release,
      targetBoard: {
        slug: "esp32-s3-devkitc-1-n16r8",
        model: "ESP32-S3-DevKitC-1-N16R8",
        flash_size_mb: 16,
        boot_button_gpio: 0,
      },
      controllerId: "ctrl-1",
      eraseAll: false,
      callbacks: {
        onPhase: () => {},
        onProgress: () => {},
        onLog: () => {},
        onStage: (s) => stages.push(s),
        onChipDetected: (chip) => {
          detectedChip = chip;
        },
      },
    });

    expect(result.chipDetected).toContain("ESP32-S3");
    expect(detectedChip).toContain("ESP32-S3");
    expect(stages).toEqual([
      "preparing_firmware",
      "connecting",
      "detecting_board",
      "writing",
      "verifying",
      "completed",
    ]);
    expect(result.detectedFlashSize).toBe("16MB");
    expect(mockWriteFlash).toHaveBeenCalledTimes(1);
    expect(mockWriteFlash).toHaveBeenCalledWith(
      expect.objectContaining({
        flashMode: "keep",
        flashFreq: "keep",
        flashSize: "keep",
      })
    );
    expect(mockFlashMd5sum).toHaveBeenCalledWith(0, fakeBin.byteLength);
    expect(mockAfter).toHaveBeenCalledWith("hard_reset");
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(recordedEvents).toHaveLength(1);
    expect((recordedEvents[0]!.body as { status: string }).status).toBe("succeeded");
    expect(
      (recordedEvents[0]!.body as { detectedFlashSizeMb?: number }).detectedFlashSizeMb
    ).toBe(16);
  });

  it("matches chip families strictly without substring collisions and checks RFC1321 MD5", () => {
    expect(chipMatchesFamily("ESP32-C61 (revision v0.1)", "esp32c61")).toBe(true);
    expect(chipMatchesFamily("ESP32-C61 (revision v0.1)", "esp32c6")).toBe(false);
    expect(chipMatchesFamily("ESP32-C5 (revision v0.1)", "esp32c5")).toBe(true);
    expect(chipMatchesFamily("ESP32-C5 (revision v0.1)", "esp32")).toBe(false);
    expect(chipMatchesFamily("ESP8684 (revision v1.0)", "esp32c2")).toBe(true);
    expect(chipMatchesFamily("ESP32-D0WD-V3 (revision v3.1)", "esp32")).toBe(true);
    expect(md5Hex(new Uint8Array())).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex(new TextEncoder().encode("abc"))).toBe(
      "900150983cd24fb0d6963f7d28e17f72"
    );
  });

  it("aborts BEFORE flashing when detected SPI flash capacity is smaller than board requirement", async () => {
    const fakeBin = new Uint8Array([0xe9, 0x04, 0x02, 0x20]);
    const expectedSha = await sha256HexClient(fakeBin);
    mockMain.mockResolvedValueOnce("ESP32-S3 (QFN56) (revision v0.2)");
    mockDetectFlashSize.mockResolvedValueOnce("8MB");

    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/download")) {
        return new Response(fakeBin, {
          status: 200,
          headers: { "X-Firmware-Sha256": expectedSha },
        });
      }
      if (url.includes("/usb-flash-events")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const release: UsbFlashReleaseSpec = {
      id: "rel-1",
      name: "HomecoreOS",
      version: "1.0.0",
      chip_family: "esp32s3",
      target_board_slug: "esp32-s3-devkitc-1-n16r8",
      partition_scheme: "dual_ota_16mb",
      flash_size_mb: 16,
      files: [
        {
          id: "file-usb",
          file_type: "usb_factory",
          file_name: "homecoreos-usb-factory.bin",
          size_bytes: fakeBin.byteLength,
          sha256: expectedSha,
          flash_address: "0x0",
          flash_mode: "dio",
          flash_freq: "80m",
          flash_size: "16MB",
        },
      ],
    };

    await expect(
      flashFreshControllerViaUsb({
        release,
        targetBoard: {
          slug: "esp32-s3-devkitc-1-n16r8",
          model: "ESP32-S3-DevKitC-1-N16R8",
          flash_size_mb: 16,
          boot_button_gpio: 0,
        },
        callbacks: {
          onPhase: () => {},
          onProgress: () => {},
          onLog: () => {},
        },
      })
    ).rejects.toThrow(/Flash size mismatch/i);

    expect(mockWriteFlash).not.toHaveBeenCalled();
  });

  it("aborts BEFORE flashing when detected chip mismatches release chip_family", async () => {
    const fakeBin = new Uint8Array([0xe9, 0x04, 0x02, 0x20]);
    const expectedSha = await sha256HexClient(fakeBin);
    mockMain.mockResolvedValueOnce("ESP32-C3 (QFN32) (revision v0.4)");

    const recordedEvents: Array<{ body: unknown }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/download")) {
        return new Response(fakeBin, {
          status: 200,
          headers: { "X-Firmware-Sha256": expectedSha },
        });
      }
      if (url.includes("/usb-flash-events")) {
        recordedEvents.push({ body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const release: UsbFlashReleaseSpec = {
      id: "rel-1",
      name: "HomecoreOS",
      version: "1.0.0",
      chip_family: "esp32s3",
      files: [
        {
          id: "file-usb",
          file_type: "usb_factory",
          file_name: "homecoreos-usb-factory.bin",
          size_bytes: fakeBin.byteLength,
          sha256: expectedSha,
          flash_address: "0x0",
          flash_mode: "qio",
          flash_freq: "80m",
          flash_size: "16MB",
        },
      ],
    };

    await expect(
      flashFreshControllerViaUsb({
        release,
        callbacks: {
          onPhase: () => {},
          onProgress: () => {},
          onLog: () => {},
        },
      })
    ).rejects.toThrow(/Chip mismatch/i);

    expect(mockWriteFlash).not.toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect((recordedEvents[0]!.body as { status: string }).status).toBe("failed");
  });
});
