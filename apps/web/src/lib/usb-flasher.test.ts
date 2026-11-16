import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256HexClient } from "./api";

const mockMain = vi.fn(async () => "ESP32-S3 (QFN56) (revision v0.2)");
const mockDetectFlashSize = vi.fn(async () => "16MB");
const mockWriteFlash = vi.fn(async () => {});
const mockFlashMd5sum = vi.fn<() => Promise<string>>(async () => "");
const mockAfter = vi.fn(async () => {});
const mockDisconnect = vi.fn(async () => {});
/** What the chip reports about itself; null stands for a loader without a feature list. */
const mockChipFeatures = vi.fn<() => Promise<string[] | null>>(async () => null);

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
    chip = { getChipFeatures: mockChipFeatures };
  },
}));

import { SEEED_XIAO_OFFICIAL_BOARDS, VERIFIED_BOARD_CATALOG } from "@homecoreos/shared";
import {
  chipMatchesFamily,
  flashFreshControllerViaUsb,
  isWebSerialSupported,
  md5Hex,
  UsbBoardMismatchError,
  type UsbBoardMismatchDecision,
  type UsbFlashBoardReport,
  type UsbFlashReleaseSpec,
  type UsbFlashTargetBoardSpec,
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

describe("Browser USB flasher: board verification before writing", () => {
  const fakeBin = new Uint8Array([0xe9, 0x04, 0x02, 0x20, 0x10, 0x00, 0x00, 0x00]);
  const library: UsbFlashTargetBoardSpec[] = [
    ...VERIFIED_BOARD_CATALOG.map((b) => ({ ...b, id: `id-${b.slug}` })),
    ...SEEED_XIAO_OFFICIAL_BOARDS.filter((b) => b.seed.slug !== "seeed-xiao-esp32s3").map((b) => ({
      ...b.seed,
      id: `id-${b.seed.slug}`,
    })),
  ];
  const board = (slug: string) => {
    const found = library.find((b) => b.slug === slug);
    if (!found) throw new Error(`missing ${slug}`);
    return found;
  };
  const devkit = board("esp32-s3-devkitc-1-n16r8");

  interface FlashEvent {
    status: string;
    reportedBoardSlug?: string;
    errorMessage?: string;
    boardCheck?: {
      result: string;
      forced: boolean;
      severity: string;
      detectedSummary: string;
      usbId?: string;
      selectedBoardSlug?: string;
      recommendedBoardSlugs: string[];
      mismatches: string[];
    };
  }
  let events: FlashEvent[] = [];
  let release: UsbFlashReleaseSpec;

  /** The serial port the user picked, with the USB IDs the browser reports for it. */
  function connect(usb: { usbVendorId?: number; usbProductId?: number } | null) {
    Object.defineProperty(navigator, "serial", {
      value: { requestPort: vi.fn(async () => (usb ? { getInfo: () => usb } : {})) },
      configurable: true,
    });
  }

  /** What the connected hardware reports through the ROM loader. */
  function hardware(chip: string, flash: string, features: string[] | null) {
    mockMain.mockResolvedValueOnce(chip);
    mockDetectFlashSize.mockResolvedValueOnce(flash);
    mockChipFeatures.mockResolvedValueOnce(features);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    events = [];
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    connect({ usbVendorId: 0x10c4, usbProductId: 0xea60 });
    const sha = await sha256HexClient(fakeBin);
    mockFlashMd5sum.mockResolvedValue(md5Hex(fakeBin));
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/download")) {
        return new Response(fakeBin, { status: 200, headers: { "X-Firmware-Sha256": sha } });
      }
      if (url.includes("/usb-flash-events")) {
        events.push(JSON.parse(String(init?.body ?? "{}")) as FlashEvent);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    release = {
      id: "rel-1",
      name: "HomecoreOS",
      version: "1.4.0",
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
          sha256: sha,
          flash_address: "0x0",
          flash_mode: "qio",
          flash_freq: "80m",
          flash_size: "16MB",
        },
      ],
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mockFlashMd5sum.mockReset();
    mockFlashMd5sum.mockImplementation(async () => "");
  });

  function run(options: {
    targetBoard?: UsbFlashTargetBoardSpec | null;
    onBoardMismatch?: (report: UsbFlashBoardReport) => Promise<UsbBoardMismatchDecision> | UsbBoardMismatchDecision;
  }) {
    const logs: string[] = [];
    const phases: string[] = [];
    const checked: UsbFlashBoardReport[] = [];
    const promise = flashFreshControllerViaUsb({
      release,
      targetBoard: options.targetBoard === undefined ? devkit : options.targetBoard,
      candidateBoards: library,
      controllerId: "ctrl-1",
      callbacks: {
        onPhase: (phase) => phases.push(phase),
        onProgress: () => {},
        onLog: (line) => logs.push(line),
        onBoardChecked: (report) => checked.push(report),
        onBoardMismatch: options.onBoardMismatch,
      },
    });
    return { promise, logs, phases, checked };
  }

  it("flashes straight through when the connected board is the selected one", async () => {
    hardware("ESP32-S3 (QFN56) (revision v0.2)", "16MB", ["WiFi", "BLE", "Embedded PSRAM 8MB (AP_3v3)"]);
    const onBoardMismatch = vi.fn<(report: UsbFlashBoardReport) => UsbBoardMismatchDecision>(() => "cancel");
    const { promise, checked } = run({ onBoardMismatch });
    const result = await promise;

    // Nothing to ask: the warning never appears for a matching board.
    expect(onBoardMismatch).not.toHaveBeenCalled();
    expect(checked).toHaveLength(1);
    expect(checked[0]).toMatchObject({ result: "match", severity: "none", mismatches: [] });
    expect(checked[0]!.detected).toMatchObject({ flashSizeMb: 16, psramSizeMb: 8, chipFamily: "esp32s3" });
    expect(mockWriteFlash).toHaveBeenCalledTimes(1);
    expect(result.boardCheck).toMatchObject({ result: "match", forced: false });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "succeeded",
      reportedBoardSlug: "esp32-s3-devkitc-1-n16r8",
      boardCheck: { result: "match", forced: false, usbId: "10C4:EA60", mismatches: [] },
    });
  });

  it("pauses on a mismatch and writes nothing until the user has answered", async () => {
    hardware("ESP32-S3 (QFN56) (revision v0.2)", "8MB", ["WiFi", "BLE"]);
    let answer: (decision: UsbBoardMismatchDecision) => void = () => {};
    const asked: UsbFlashBoardReport[] = [];
    const { promise, phases } = run({
      onBoardMismatch: (report) => {
        asked.push(report);
        return new Promise<UsbBoardMismatchDecision>((resolve) => {
          answer = resolve;
        });
      },
    });
    const settled = vi.fn();
    promise.then(settled, settled);

    await vi.waitFor(() => expect(asked).toHaveLength(1));
    // While the question is open nothing is written and nothing is recorded.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mockWriteFlash).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(settled).not.toHaveBeenCalled();
    expect(phases[phases.length - 1]).toMatch(/Waiting for your decision/);

    // The report says what differs and which library board fits the hardware.
    const report = asked[0]!;
    expect(report.result).toBe("mismatch");
    expect(report.mismatches.map((m) => m.code).sort()).toEqual(["flash_smaller", "psram_smaller"]);
    expect(report.detected.summary).toBe("ESP32-S3 · 8 MB flash · no PSRAM");
    expect(report.selected?.board.slug).toBe("esp32-s3-devkitc-1-n16r8");
    expect(report.recommended.length).toBeGreaterThan(0);
    for (const rec of report.recommended) expect(rec.board.chip_family).toBe("esp32s3");

    answer("cancel");
    const error = await promise.then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(UsbBoardMismatchError);
    expect((error as UsbBoardMismatchError).cancelledByUser).toBe(true);
    expect((error as UsbBoardMismatchError).message).toMatch(/stopped before anything was written/i);
    expect((error as UsbBoardMismatchError).message).toMatch(/Flash size mismatch/);

    expect(mockWriteFlash).not.toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "failed",
      boardCheck: {
        result: "mismatch",
        forced: false,
        severity: "major",
        selectedBoardSlug: "esp32-s3-devkitc-1-n16r8",
      },
    });
    // The check found another board, so the selected one is not reported as connected.
    expect(events[0]!.reportedBoardSlug).toBeUndefined();
  });

  it("writes after an explicit Force to Flash and records that it was forced", async () => {
    hardware("ESP32-S3 (QFN56) (revision v0.2)", "8MB", ["WiFi", "BLE"]);
    const onBoardMismatch = vi.fn<(report: UsbFlashBoardReport) => UsbBoardMismatchDecision>(() => "force");
    const { promise, logs } = run({ onBoardMismatch });
    const result = await promise;

    expect(onBoardMismatch).toHaveBeenCalledTimes(1);
    expect(mockWriteFlash).toHaveBeenCalledTimes(1);
    expect(mockAfter).toHaveBeenCalledWith("hard_reset");
    expect(logs.some((line) => /Force to Flash confirmed by the user/.test(line))).toBe(true);
    expect(result.boardCheck).toMatchObject({ result: "mismatch", forced: true, severity: "major" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "succeeded",
      boardCheck: {
        result: "mismatch",
        forced: true,
        mismatches: expect.arrayContaining(["flash_smaller"]),
      },
    });
    // A forced flash proved the board is not the selected one.
    expect(events[0]!.reportedBoardSlug).toBeUndefined();
  });

  it("recognises another maker's board by the USB ID of the serial port", async () => {
    // A XIAO ESP32-S3 Plus: same chip and memory as the DevKitC N16R8, its own USB ID.
    connect({ usbVendorId: 0x2886, usbProductId: 0x0056 });
    hardware("ESP32-S3 (QFN56) (revision v0.2)", "16MB", ["WiFi", "BLE", "Embedded PSRAM 8MB (AP_3v3)"]);
    const asked: UsbFlashBoardReport[] = [];
    const { promise } = run({
      onBoardMismatch: (report) => {
        asked.push(report);
        return "cancel";
      },
    });
    await expect(promise).rejects.toBeInstanceOf(UsbBoardMismatchError);

    expect(asked).toHaveLength(1);
    expect(asked[0]!.mismatches.map((m) => m.code)).toEqual(["usb_vendor"]);
    expect(asked[0]!.detected.usb).toMatchObject({ usbId: "2886:0056", vendorName: "Seeed Studio" });
    // The board that owns this USB ID and matches the memory is recommended as an exact fit.
    const exact = asked[0]!.recommended.filter((r) => r.exact).map((r) => r.board.slug);
    expect(exact).toEqual(["seeed-xiao-esp32s3-plus"]);
    expect(mockWriteFlash).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      status: "failed",
      boardCheck: {
        result: "mismatch",
        usbId: "2886:0056",
        recommendedBoardSlugs: expect.arrayContaining(["seeed-xiao-esp32s3-plus"]),
        mismatches: ["usb_vendor"],
      },
    });

    // The same hardware with the right board selected goes straight through.
    connect({ usbVendorId: 0x2886, usbProductId: 0x0056 });
    hardware("ESP32-S3 (QFN56) (revision v0.2)", "16MB", ["WiFi", "BLE", "Embedded PSRAM 8MB (AP_3v3)"]);
    const again = vi.fn<(report: UsbFlashBoardReport) => UsbBoardMismatchDecision>(() => "cancel");
    await run({ targetBoard: board("seeed-xiao-esp32s3-plus"), onBoardMismatch: again }).promise;
    expect(again).not.toHaveBeenCalled();
    expect(mockWriteFlash).toHaveBeenCalledTimes(1);
  });

  it("does not turn information the browser or the chip withholds into a mismatch", async () => {
    // No USB IDs from the port, no feature list from the loader.
    connect(null);
    hardware("ESP32-S3 (QFN56) (revision v0.2)", "16MB", null);
    const onBoardMismatch = vi.fn<(report: UsbFlashBoardReport) => UsbBoardMismatchDecision>(() => "cancel");
    const { promise, checked } = run({ onBoardMismatch });
    await promise;

    expect(onBoardMismatch).not.toHaveBeenCalled();
    expect(checked[0]!.result).toBe("match");
    expect(checked[0]!.detected.psramSizeMb).toBeNull();
    const unknown = checked[0]!.checks.filter((c) => c.status === "unknown").map((c) => c.key);
    expect(unknown).toEqual(expect.arrayContaining(["psram", "usb"]));
    expect(mockWriteFlash).toHaveBeenCalledTimes(1);
  });

  it("continues over a larger-memory variant when nobody can be asked, and stops on a real risk", async () => {
    // 32 MB flash where 16 MB is expected: more memory, same board family.
    hardware("ESP32-S3 (QFN56) (revision v0.2)", "32MB", ["WiFi", "BLE", "Embedded PSRAM 8MB (AP_3v3)"]);
    const larger = run({});
    const result = await larger.promise;
    expect(result.boardCheck).toMatchObject({ result: "mismatch", severity: "minor", forced: false });
    expect(larger.logs.some((line) => /does not keep this firmware from running/.test(line))).toBe(true);
    expect(mockWriteFlash).toHaveBeenCalledTimes(1);

    // Another chip, and still nobody to ask: it stops, and not as a user decision.
    mockWriteFlash.mockClear();
    hardware("ESP32-C3 (QFN32) (revision v0.4)", "4MB", ["WiFi", "BLE"]);
    const error = await run({}).promise.then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(UsbBoardMismatchError);
    expect((error as UsbBoardMismatchError).cancelledByUser).toBe(false);
    expect((error as UsbBoardMismatchError).message).toMatch(/Chip mismatch/);
    expect(mockWriteFlash).not.toHaveBeenCalled();
  });
});
