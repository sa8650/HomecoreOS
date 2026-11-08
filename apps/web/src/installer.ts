/**
 * In-browser USB installer for the ESP32-S3.
 *
 * Two paths, both writing the exact bytes stored in the private bucket:
 *  - a merged factory image over Web Serial (esptool-js), and
 *  - the official ESP Web Tools element for the same merged image.
 *
 * Nothing here reports success on its own: progress comes from the flash
 * transfer itself, and the controller is only "installed" once it boots, joins
 * Wi-Fi and redeems a pairing code.
 */

export const CHIP_IDS: Record<string, number> = {
  'ESP32': 0, 'ESP32-S2': 2, 'ESP32-S3': 9, 'ESP32-C3': 5, 'ESP32-C6': 13, 'ESP32-H2': 16,
};

export type InstallProgress = { written: number; total: number; percent: number; phase: string };
export type InstallLog = (line: string, level?: 'info' | 'warn' | 'error') => void;

export function serialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export function espWebToolsUrl(): string {
  return 'https://unpkg.com/esp-web-tools@10.0.1/dist/web/install-button.js?module';
}

/** Reads the chip id out of the image header so a wrong build is refused first. */
export function imageChipId(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 24 || bytes[0] !== 0xe9) return null;
  return bytes[12]! | (bytes[13]! << 8);
}

export async function verifyImage(bytes: Uint8Array, expectedSha: string): Promise<{ ok: boolean; detail: string }> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  const hex = Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, '0')).join('');
  if (hex !== expectedSha) {
    return { ok: false, detail: `The downloaded file is not the published build (expected ${expectedSha.slice(0, 16)}…, got ${hex.slice(0, 16)}…).` };
  }
  if (bytes[0] !== 0xe9) return { ok: false, detail: 'The file is not an ESP32 image.' };
  return { ok: true, detail: 'Checksum matches the published release' };
}

/** Fetches the release through the signed, expiring link. */
export async function fetchPackage(url: string, onProgress?: (loaded: number, total: number) => void) {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) {
    let message = `The download failed (${res.status})`;
    try { const body = await res.json(); message = body.error || message; } catch { /* binary or empty body */ }
    throw new Error(message);
  }
  const total = Number(res.headers.get('Content-Length') || 0);
  if (!res.body) {
    const buffer = new Uint8Array(await res.arrayBuffer());
    onProgress?.(buffer.byteLength, buffer.byteLength);
    return buffer;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total || loaded);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

type FlashOptions = {
  bytes: Uint8Array;
  offset: number;
  expectedChipId: number | null;
  /** Release digest, verified again from flash after writing. */
  expectedSha256: string;
  onProgress: (p: InstallProgress) => void;
  log: InstallLog;
};

/** Chip families this pipeline can write, as reported by the loader. */
const CHIP_NAME_IDS: Array<[RegExp, number]> = [
  [/^ESP32-S3/i, 9], [/^ESP32-S2/i, 2], [/^ESP32-C6/i, 13], [/^ESP32-C3/i, 5],
  [/^ESP32-H2/i, 16], [/^ESP32$/i, 0],
];

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Writes the image over Web Serial with esptool-js and then proves it landed.
 *
 * The library is imported on demand so the rest of the console never pays for it.
 * Sequence, and why each step exists:
 *   1. the user picks the port (browser permission),
 *   2. the loader identifies the chip — a mismatch aborts before any erase,
 *   3. the image is written at its own offset with real byte progress,
 *   4. the same region is read back and hashed, so "success" means the flash
 *      holds exactly the published bytes. If the read-back differs, the caller is
 *      told the write failed, even though the write itself reported success.
 * Nothing here decides that the controller works: that only happens after it
 * boots, joins Wi-Fi and reports its version.
 */
export async function flashOverSerial(options: FlashOptions): Promise<{ detected: string }> {
  if (!serialSupported()) throw new Error('This browser does not support Web Serial. Use Chrome or Edge on desktop.');
  const { ESPLoader, Transport } = await import('esptool-js');
  const bytes = options.bytes;
  const total = bytes.byteLength;

  options.log('Waiting for you to choose the serial port…');
  const port = await (navigator as any).serial.requestPort();
  const transport = new Transport(port, true);
  const loader = new ESPLoader({
    transport,
    baudrate: 921600,
    romBaudrate: 115200,
    terminal: {
      clean: () => {},
      write: (data: string) => options.log(data.replace(/\s+$/, '')),
      writeLine: (data: string) => options.log(data),
    },
  });

  try {
    options.onProgress({ written: 0, total, percent: 0, phase: 'Connecting to the controller' });
    options.log('Connecting to the bootloader…');
    const detected = await loader.main();
    options.log(`Connected: ${detected}`, 'info');

    // Refuse a mismatch before anything is erased: the silicon and the release
    // must agree, otherwise the board would boot into a foreign image.
    const detectedId = CHIP_NAME_IDS.find(([pattern]) => pattern.test(detected))?.[1] ?? null;
    const expected = options.expectedChipId ?? imageChipId(bytes);
    if (detectedId === null) {
      throw new Error(`The connected board reports "${detected}", which this release cannot identify. Nothing was written.`);
    }
    if (expected !== null && detectedId !== expected) {
      const wanted = Object.keys(CHIP_IDS).find((k) => CHIP_IDS[k] === expected) || 'the released chip';
      throw new Error(`The connected board reports ${detected}, but this release is built for ${wanted}. Nothing was written.`);
    }
    // The release is built for a 16 MB layout; a smaller board cannot hold the
    // second application slot, so the customer is told before the write starts.
    const flashSize = await loader.detectFlashSize().catch(() => undefined);
    if (flashSize) {
      options.log(`Flash: ${flashSize}`, 'info');
      if (!/^(16|32|64|128)MB$/.test(flashSize)) {
        options.log(`This board reports ${flashSize} of flash but the release is built for 16 MB. Use the matching board model, or the update will not boot.`, 'warn');
      }
    }

    options.onProgress({ written: 0, total, percent: 0, phase: 'Writing the firmware' });
    await loader.writeFlash({
      fileArray: [{ data: bytes, address: options.offset }],
      flashMode: 'dio',
      flashFreq: '80m',
      // "keep" leaves the flash parameters already in the image header untouched.
      flashSize: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (_index: number, written: number, reportedTotal: number) => {
        // The loader reports compressed bytes; scale to the uncompressed size the
        // customer is actually waiting for so the bar cannot stall near 100 %.
        const effectiveTotal = reportedTotal || total;
        const done = Math.round((written / effectiveTotal) * total);
        const percent = total ? Math.min(99, Math.max(0, Math.round((done / total) * 100))) : 0;
        options.onProgress({ written: Math.min(done, total), total, percent, phase: 'Writing the firmware' });
      },
    });
    // No calculateMD5Hash is passed on purpose: a hash the page invents would be
    // compared against the flash and could only ever fail.

    options.onProgress({ written: total, total, percent: 99, phase: 'Reading the flash back to verify' });
    options.log('Reading the written region back to verify it…');
    const readBack = await loader.readFlash(options.offset, total);
    if (readBack.byteLength < total) {
      throw new Error(`Only ${readBack.byteLength} of ${total} bytes could be read back. Do not unplug the controller; try the installation again.`);
    }
    const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', readBack.subarray(0, total) as unknown as BufferSource)));
    if (digest !== options.expectedSha256.toLowerCase()) {
      throw new Error(`The flash does not hold the published build (expected ${options.expectedSha256.slice(0, 16)}…, read back ${digest.slice(0, 16)}…). The controller was not marked as installed.`);
    }
    options.log('Flash contents match the published checksum.', 'info');

    options.onProgress({ written: total, total, percent: 100, phase: 'Restarting the controller' });
    options.log('Restarting the controller…');
    await loader.after('hard_reset');
    return { detected };
  } finally {
    await transport.disconnect().catch(() => {});
  }
}

export function installModeLabel(kind: string | undefined): { label: string; detail: string } {
  return kind === 'factory'
    ? { label: 'Full installation', detail: 'Writes the bootloader, partition table and firmware from address 0x0. Use this for a new or recovered controller.' }
    : { label: 'Firmware update over USB', detail: 'Writes only the application image at 0x10000 and keeps the existing bootloader and partition table.' };
}

export const USB_STEPS = [
  { title: 'Connect the controller with a USB cable', detail: 'Use a data cable, not a charge-only cable. Connect it directly to this computer — a hub often drops the connection mid-write.' },
  { title: 'Put the controller in download mode', detail: 'Hold the BOOT button, briefly press RESET, then release BOOT. On boards with one button, hold BOOT while you plug the cable in.' },
  { title: 'Choose the serial port', detail: 'Your browser asks which port to use. It usually appears as "USB JTAG/serial debug unit" or "CP210x".' },
  { title: 'Wait for the write to finish', detail: 'Do not unplug the controller, close the tab or switch windows while the progress bar is moving.' },
];
