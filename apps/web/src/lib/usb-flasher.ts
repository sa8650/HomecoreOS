import type { Transport } from "esptool-js";
import type {
  FlashFreqValues,
  FlashModeValues,
  FlashSizeValues,
} from "esptool-js/lib/types/arguments.js";
import {
  defaultBootButtonGpioForChip,
  parseFlashSizeMb,
} from "@homecoreos/shared";
import { apiFetch, sha256HexClient } from "./api";
import { parseSetupSerialLine, type ParsedSerialSetupInfo } from "./ble-provisioning";

export interface UsbFlashFileSpec {
  id: string;
  file_type: "ota_app" | "usb_factory" | "manifest";
  file_name: string;
  size_bytes: number;
  sha256: string;
  flash_address: string | null;
  flash_mode: string | null;
  flash_freq: string | null;
  flash_size: string | null;
}

export interface UsbFlashReleaseSpec {
  id: string;
  name: string;
  version: string;
  chip_family: string;
  target_board_slug?: string | null;
  partition_scheme?: string | null;
  flash_size_mb?: number | null;
  files: UsbFlashFileSpec[];
}

export interface UsbFlashTargetBoardSpec {
  slug?: string;
  model?: string;
  chip_family?: string;
  flash_size_mb?: number;
  boot_button_gpio?: number | null;
  usb_interface?: string | null;
}

export type UsbFlashStage =
  | "idle"
  | "preparing_firmware"
  | "connecting"
  | "detecting_board"
  | "writing"
  | "verifying"
  | "completed"
  | "error";

export interface UsbFlashCallbacks {
  onPhase: (phase: string) => void;
  onProgress: (percent: number) => void;
  onLog: (line: string) => void;
  onStage?: (stage: UsbFlashStage) => void;
  onChipDetected?: (chip: string, flashSize?: string) => void;
  onBytesProgress?: (writtenBytes: number, totalBytes: number) => void;
  onSetupCaptured?: (info: ParsedSerialSetupInfo) => void;
}

type WebSerialPort = ConstructorParameters<typeof Transport>[0];
interface WebSerialNavigator {
  serial?: {
    requestPort(options?: {
      filters?: Array<{ usbVendorId?: number; usbProductId?: number }>;
    }): Promise<WebSerialPort>;
  };
}

export function isWebSerialSupported(): { supported: boolean; reason?: string } {
  if (typeof window === "undefined") {
    return { supported: false, reason: "Browser environment required." };
  }
  if (!window.isSecureContext) {
    return {
      supported: false,
      reason: "Web Serial requires HTTPS (or localhost during development).",
    };
  }
  const nav = navigator as Navigator & WebSerialNavigator;
  if (!nav.serial) {
    return {
      supported: false,
      reason:
        "Web Serial API is not available in this browser. Use desktop Chrome, Edge, or Chromium-based browsers.",
    };
  }
  return { supported: true };
}

function normalizeChipName(chipName: string): string {
  return chipName.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Extracts canonical Espressif SoC family from esptool-js CHIP_NAME strings
 * (e.g. "ESP32-C61 (revision v0.1)" -> "esp32c61", "ESP8684" -> "esp32c2",
 * "ESP32-D0WD-V3" -> "esp32") and compares strictly without substring collisions.
 */
export function extractCanonicalChipFamily(detectedChip: string): string {
  const firstToken = detectedChip.trim().split(/[\s(]/)[0] ?? "";
  const norm = normalizeChipName(firstToken);
  if (!norm) return "";
  if (norm === "esp8684" || norm.startsWith("esp8684")) return "esp32c2";

  const knownSubfamilies = [
    "esp32c61",
    "esp32h21",
    "esp32s31",
    "esp32s3",
    "esp32s2",
    "esp32c6",
    "esp32c5",
    "esp32c3",
    "esp32c2",
    "esp32h2",
    "esp32h4",
    "esp32p4",
  ];
  for (const fam of knownSubfamilies) {
    if (norm === fam || norm.startsWith(fam)) return fam;
  }
  if (
    norm === "esp32" ||
    norm.startsWith("esp32d0") ||
    norm.startsWith("esp32u4") ||
    norm.startsWith("esp32pico") ||
    norm.startsWith("esp32s0")
  ) {
    return "esp32";
  }
  return norm;
}

export function chipMatchesFamily(detectedChip: string, expectedFamily: string): boolean {
  const detected = extractCanonicalChipFamily(detectedChip);
  const target = extractCanonicalChipFamily(expectedFamily);
  return Boolean(detected && target && detected === target);
}

export function parseDetectedFlashMb(flashSize?: string | null): number | null {
  return parseFlashSizeMb(flashSize);
}

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
);

export function md5Hex(input: Uint8Array): string {
  const bitLen = input.length * 8;
  const paddedLen = (((input.length + 8) >> 6) + 1) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLen; offset += 64) {
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F = 0;
      let g = 0;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const word = view.getUint32(offset + g * 4, true);
      const sum = (A + F + MD5_K[i]! + word) >>> 0;
      const rot = ((sum << MD5_S[i]!) | (sum >>> (32 - MD5_S[i]!))) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rot) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  return [a0, b0, c0, d0]
    .map((n) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, n, true);
      return Array.from(b)
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    })
    .join("");
}

function normalizeEsptoolMd5(raw: string): string {
  const clean = raw.trim().toLowerCase();
  if (clean.length === 64 && /^[0-9a-f]{64}$/.test(clean)) {
    // ROM bootloader returns 32 ASCII hex bytes encoded as 64 hex chars
    let ascii = "";
    for (let i = 0; i < 64; i += 2) {
      ascii += String.fromCharCode(Number.parseInt(clean.slice(i, i + 2), 16));
    }
    return ascii.toLowerCase();
  }
  return clean.slice(0, 32);
}

function parseHexOffset(raw: string | null): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 16);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

interface ReadableSerialPortLike {
  readable?: ReadableStream<Uint8Array> | null;
  open?: (opts: { baudRate: number }) => Promise<void>;
  close?: () => Promise<void>;
}

async function listenForSetupBannerOnPort(
  port: WebSerialPort,
  timeoutMs: number,
  onLog?: (line: string) => void
): Promise<ParsedSerialSetupInfo | null> {
  const serialPort = port as unknown as ReadableSerialPortLike;
  if (typeof serialPort.open !== "function") return null;

  let opened = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await serialPort.open({ baudRate: 115200 });
      opened = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  if (!opened || !serialPort.readable) return null;

  const reader = serialPort.readable.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let captured: ParsedSerialSetupInfo | null = null;
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(50, deadline - Date.now());
      const readRes = await Promise.race([
        reader.read(),
        new Promise<{ value?: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ done: true }), remaining)
        ),
      ]);
      if (readRes.done || !readRes.value) break;
      buf += decoder.decode(readRes.value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseSetupSerialLine(line);
        if (parsed?.setupPin) {
          captured = parsed;
          onLog?.(
            `Captured device Setup PIN (${parsed.setupPin})${
              parsed.bleName ? ` · BLE ${parsed.bleName}` : ""
            }${parsed.apSsid ? ` · AP ${parsed.apSsid}` : ""}`
          );
          return captured;
        }
      }
    }
  } catch {
    // Non-fatal: board may still be booting or CDC re-enumerated
  } finally {
    await reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
    await serialPort.close?.().catch(() => {});
  }
  return captured;
}

export async function flashFreshControllerViaUsb(params: {
  release: UsbFlashReleaseSpec;
  targetBoard?: UsbFlashTargetBoardSpec | null;
  controllerId?: string;
  eraseAll?: boolean;
  baudRate?: number;
  callbacks: UsbFlashCallbacks;
}): Promise<{
  chipDetected: string;
  detectedFlashSize?: string;
  setupInfo?: ParsedSerialSetupInfo | null;
}> {
  const {
    release,
    targetBoard,
    controllerId,
    eraseAll = false,
    baudRate = 460800,
    callbacks,
  } = params;

  const serialCheck = isWebSerialSupported();
  if (!serialCheck.supported) {
    throw new Error(serialCheck.reason);
  }

  const factoryFile = release.files.find((f) => f.file_type === "usb_factory");
  if (!factoryFile) {
    throw new Error(
      "This firmware release does not contain a validated ESP-IDF USB factory image. Never flash an OTA application-only image at 0x0."
    );
  }

  const flashAddress = parseHexOffset(factoryFile.flash_address ?? "0x0");
  if (factoryFile.flash_address && Number.isNaN(flashAddress)) {
    throw new Error("Invalid flash offset declared by firmware artifact.");
  }

  callbacks.onStage?.("preparing_firmware");
  callbacks.onPhase("Downloading verified USB factory image...");
  callbacks.onProgress(5);
  callbacks.onLog(
    `Fetching ${factoryFile.file_name} (${(factoryFile.size_bytes / 1024).toFixed(1)} KB)...`
  );

  const response = await fetch(`/api/firmware/files/${factoryFile.id}/download`, {
    credentials: "include",
  });
  if (!response.ok) {
    callbacks.onStage?.("error");
    const errText = await response.text().catch(() => "Firmware download failed.");
    throw new Error(errText);
  }

  const headerSha = response.headers.get("X-Firmware-Sha256") ?? factoryFile.sha256;
  const firmwareBytes = new Uint8Array(await response.arrayBuffer());

  callbacks.onPhase("Verifying SHA-256 firmware integrity...");
  callbacks.onProgress(12);
  const actualSha = await sha256HexClient(firmwareBytes);
  if (actualSha.toLowerCase() !== headerSha.toLowerCase()) {
    callbacks.onStage?.("error");
    throw new Error(
      `SHA-256 verification failed! Expected ${headerSha}, got ${actualSha}. Aborting flash.`
    );
  }
  callbacks.onLog(`SHA-256 verified: ${actualSha}`);

  const nav = navigator as Navigator & WebSerialNavigator;
  if (!nav.serial) {
    callbacks.onStage?.("error");
    throw new Error("Web Serial API is unavailable in this browser.");
  }
  callbacks.onStage?.("connecting");
  callbacks.onPhase("Select your USB-connected ESP32 serial port...");
  let port: WebSerialPort;
  try {
    port = await nav.serial.requestPort({
      filters: [
        { usbVendorId: 0x303a }, // Espressif native USB-JTAG / USB-OTG
        { usbVendorId: 0x10c4 }, // Silicon Labs CP210x
        { usbVendorId: 0x1a86 }, // WCH CH340 / CH9102
        { usbVendorId: 0x0403 }, // FTDI
      ],
    });
  } catch (err) {
    callbacks.onStage?.("error");
    throw err;
  }

  const { ESPLoader, Transport } = await import("esptool-js");
  const transport = new Transport(port, true);
  let transportDisconnected = false;
  let chipDetected = "unknown";
  let detectedFlashSize: string | undefined;
  let detectedFlashSizeMb: number | null = null;
  const bootGpio =
    targetBoard?.boot_button_gpio ??
    defaultBootButtonGpioForChip(
      release.chip_family,
      targetBoard?.slug ?? release.target_board_slug ?? undefined
    );

  try {
    callbacks.onPhase("Connecting to ESP bootloader...");
    callbacks.onProgress(18);
    const esploader = new ESPLoader({
      transport,
      baudrate: baudRate,
      romBaudrate: 115200,
      terminal: {
        clean() {},
        writeLine(data: string) {
          if (data.trim()) callbacks.onLog(data);
        },
        write(data: string) {
          if (data.trim()) callbacks.onLog(data);
        },
      },
    });

    callbacks.onStage?.("detecting_board");
    callbacks.onPhase("Detecting microcontroller chip & flash capacity...");
    try {
      chipDetected = await esploader.main();
    } catch (connErr) {
      const baseMsg = connErr instanceof Error ? connErr.message : String(connErr);
      throw new Error(
        `Failed to connect to bootloader (${baseMsg}). Hold BOOT (GPIO${bootGpio}) while tapping RESET/EN, then retry.`
      );
    }
    callbacks.onLog(`Detected target chip: ${chipDetected}`);

    if (!chipMatchesFamily(chipDetected, release.chip_family)) {
      throw new Error(
        `Chip mismatch: Connected board reports "${chipDetected}", but selected firmware targets "${release.chip_family.toUpperCase()}".`
      );
    }

    detectedFlashSize = await esploader.detectFlashSize();
    detectedFlashSizeMb = parseDetectedFlashMb(detectedFlashSize);
    if (detectedFlashSize) {
      callbacks.onLog(`Detected SPI Flash capacity: ${detectedFlashSize}`);
    }
    callbacks.onChipDetected?.(chipDetected, detectedFlashSize);

    const schemeRequiredMb =
      release.partition_scheme === "dual_ota_32mb"
        ? 32
        : release.partition_scheme === "dual_ota_16mb"
          ? 16
          : release.partition_scheme === "dual_ota_8mb"
            ? 8
            : release.partition_scheme === "dual_ota_4mb"
              ? 4
              : null;
    const requiredFlashMb = Math.max(
      targetBoard?.flash_size_mb ?? 0,
      release.flash_size_mb ?? 0,
      parseDetectedFlashMb(factoryFile.flash_size) ?? 0,
      schemeRequiredMb ?? 0
    ) || null;

    if (
      detectedFlashSizeMb !== null &&
      requiredFlashMb !== null &&
      detectedFlashSizeMb < requiredFlashMb
    ) {
      throw new Error(
        `Flash size mismatch: Connected board has ${detectedFlashSizeMb}MB SPI flash, but selected firmware requires ${requiredFlashMb}MB (${targetBoard?.model ?? release.target_board_slug ?? release.partition_scheme ?? factoryFile.flash_size}).`
      );
    }

    // For merged 0x0 usb_factory images built by esptool.py merge_bin, pass "keep" so
    // esptool-js does not overwrite bootloader flash headers or choke on 60MHz/64MHz boards.
    const isMergedFactoryAtZero =
      flashAddress === 0 && factoryFile.file_type === "usb_factory";
    const flashMode = (isMergedFactoryAtZero ? "keep" : (factoryFile.flash_mode ?? "dio")) as FlashModeValues;
    const flashFreq = (isMergedFactoryAtZero ? "keep" : (factoryFile.flash_freq ?? "80m")) as FlashFreqValues;
    const flashSize = (isMergedFactoryAtZero ? "keep" : (detectedFlashSize ?? factoryFile.flash_size ?? "keep")) as FlashSizeValues;

    callbacks.onStage?.("writing");
    callbacks.onPhase(`Flashing ${factoryFile.file_name} at 0x${flashAddress.toString(16)}...`);
    await esploader.writeFlash({
      fileArray: [{ data: firmwareBytes, address: flashAddress }],
      flashMode,
      flashFreq,
      flashSize,
      eraseAll,
      compress: true,
      reportProgress(_fileIndex, written, total) {
        callbacks.onBytesProgress?.(written, total);
        const pct = total > 0 ? Math.round((written / total) * 75) + 20 : 50;
        callbacks.onProgress(Math.min(95, pct));
      },
    });

    callbacks.onStage?.("verifying");
    callbacks.onPhase("Verifying written flash checksum...");
    callbacks.onProgress(97);

    const loaderWithMd5 = esploader as unknown as {
      flashMd5sum?: (addr: number, size: number) => Promise<string>;
    };
    if (typeof loaderWithMd5.flashMd5sum === "function") {
      const expectedMd5 = md5Hex(firmwareBytes);
      const rawDeviceMd5 = await loaderWithMd5.flashMd5sum(
        flashAddress,
        firmwareBytes.byteLength
      );
      const deviceMd5 = normalizeEsptoolMd5(rawDeviceMd5);
      if (deviceMd5 && deviceMd5 !== expectedMd5) {
        throw new Error(
          `Flash MD5 verification mismatch! Expected ${expectedMd5}, chip reported ${deviceMd5}.`
        );
      }
      callbacks.onLog(`Flash MD5 verified: ${expectedMd5}`);
    }

    callbacks.onPhase("Resetting controller...");
    callbacks.onProgress(98);
    await esploader.after("hard_reset");

    if (!transportDisconnected) {
      transportDisconnected = true;
      await transport.disconnect().catch(() => {});
    }
    callbacks.onPhase("Listening briefly for device Setup PIN...");
    const setupInfo = await listenForSetupBannerOnPort(port, 4200, callbacks.onLog);
    if (setupInfo?.setupPin) {
      callbacks.onSetupCaptured?.(setupInfo);
    }

    callbacks.onProgress(100);
    callbacks.onStage?.("completed");
    callbacks.onPhase("Flash complete!");
    callbacks.onLog("Controller reset cleanly. Ready for Bluetooth LE / Wi-Fi provisioning & 6-digit pairing.");

    await apiFetch("/api/firmware/usb-flash-events", {
      method: "POST",
      body: JSON.stringify({
        releaseId: release.id,
        controllerId,
        status: "succeeded",
        chipDetected,
        detectedFlashSizeMb: detectedFlashSizeMb ?? undefined,
        reportedBoardSlug: targetBoard?.slug ?? release.target_board_slug ?? undefined,
      }),
    }).catch(() => {});

    return { chipDetected, detectedFlashSize, setupInfo };
  } catch (err) {
    callbacks.onStage?.("error");
    const message = err instanceof Error ? err.message : "USB flashing failed.";
    await apiFetch("/api/firmware/usb-flash-events", {
      method: "POST",
      body: JSON.stringify({
        releaseId: release.id,
        controllerId,
        status: "failed",
        chipDetected,
        detectedFlashSizeMb: detectedFlashSizeMb ?? undefined,
        reportedBoardSlug: targetBoard?.slug ?? release.target_board_slug ?? undefined,
        errorMessage: message.slice(0, 480),
      }),
    }).catch(() => {});
    throw err;
  } finally {
    if (!transportDisconnected) {
      transportDisconnected = true;
      await transport.disconnect().catch(() => {});
    }
  }
}
