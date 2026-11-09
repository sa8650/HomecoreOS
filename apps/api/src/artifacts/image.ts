/**
 * ESP32 application image inspection.
 *
 * The same structural rules are enforced here and on the controller, so a build
 * that cannot boot is rejected at upload time instead of after a customer has
 * already installed it. Nothing is inferred from the file name.
 */

export const CHIP_IDS: Record<string, number> = {
  ESP32: 0,
  'ESP32-S2': 2,
  'ESP32-S3': 9,
  'ESP32-C3': 5,
  'ESP32-C6': 13,
  'ESP32-H2': 16,
};

export const APP_DESC_MAGIC = 0xabcd5432;
/**
 * Offset of the application descriptor inside the DROM segment.
 *
 * ESP-IDF places `esp_app_desc_t` in the `.flash.appdesc` section, which is the
 * first thing in the DROM segment. The 0x20 bytes in front of it are the MMU
 * mapping header, so the descriptor starts 0x20 bytes into that segment.
 */
export const APP_DESC_OFFSET = 0x20;
/** Load address of the DROM/rodata segment, where the descriptor lives. */
export const DROM_LOAD_ADDR = 0x3f400020;
/** Load address of the IROM/text segment. */
export const IROM_LOAD_ADDR = 0x42000020;
export const IMAGE_CHECKSUM_SEED = 0xef;
export const MAX_APP_BYTES = 3 * 1024 * 1024;

export interface ImageReport {
  valid: boolean;
  chipId: number | null;
  chipFamily: string | null;
  /** Release version: the "hcver:" marker when present, else the descriptor value. */
  appVersion: string;
  /** How appVersion was found, so a mismatch message can name the right source. */
  versionSource: 'marker' | 'descriptor' | 'none';
  projectName: string;
  idfVersion: string;
  size: number;
  checksumOk: boolean;
  trailingHash: string | null;
  errors: string[];
}

function readString(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[offset + i]!;
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

const VERSION_MARKER = [0x68, 0x63, 0x76, 0x65, 0x72, 0x3a]; // "hcver:"

export interface ImageSegmentInfo {
  /** Load address of the segment. */
  addr: number;
  /** Offset of the segment data within the file. */
  fileOffset: number;
  /** Length of the segment data. */
  length: number;
}

/**
 * The segments of an ESP image.
 *
 * The file layout is a 24-byte header followed by segments, each of which is an
 * 8-byte header (4-byte load address, 4-byte length) and then the data. The
 * walk stops at the first segment that is empty or would run past the end of
 * the file, exactly as the ROM loader does.
 */
export function readSegments(bytes: Uint8Array): ImageSegmentInfo[] {
  const segments: ImageSegmentInfo[] = [];
  let cursor = 24;
  while (cursor + 8 <= bytes.byteLength) {
    const addr = bytes[cursor]! | (bytes[cursor + 1]! << 8) | (bytes[cursor + 2]! << 16) | (bytes[cursor + 3]! << 24);
    const length = (bytes[cursor + 4]! | (bytes[cursor + 5]! << 8) | (bytes[cursor + 6]! << 16) | (bytes[cursor + 7]! << 24)) >>> 0;
    if (length === 0 || cursor + 8 + length > bytes.byteLength) break;
    segments.push({ addr: addr >>> 0, fileOffset: cursor + 8, length });
    cursor += 8 + length;
  }
  return segments;
}

/**
 * The offset of the application descriptor within the file, or null when the
 * image has no descriptor.
 *
 * The descriptor is NOT at a fixed file offset. ESP-IDF puts it at the start
 * of the DROM segment, 0x20 bytes past the segment header because of the MMU
 * mapping header that precedes it. The IROM segment normally comes first, so
 * the descriptor usually sits well past offset 0x20 of the file. The segment is
 * therefore located by walking the image, and the descriptor is confirmed by
 * its magic word rather than assumed.
 */
export function findAppDescriptorOffset(bytes: Uint8Array): number | null {
  const segments = readSegments(bytes);
  // The DROM segment is the one loaded at the flash-mapped rodata address.
  const drom = segments.find((s) => s.addr === DROM_LOAD_ADDR)
    // Some images are linked without the standard mapping address, so fall back
    // to the first segment whose data actually starts with the descriptor.
    ?? segments.find((s) => s.fileOffset + APP_DESC_OFFSET + 4 <= bytes.byteLength
      && readUint32LE(bytes, s.fileOffset + APP_DESC_OFFSET) === APP_DESC_MAGIC);
  if (drom) {
    const offset = drom.fileOffset + APP_DESC_OFFSET;
    if (offset + 4 <= bytes.byteLength && readUint32LE(bytes, offset) === APP_DESC_MAGIC) return offset;
  }
  // Last resort: the descriptor sits at 0x20 of the file when the image has a
  // single segment that starts at the DROM address.
  if (bytes.byteLength >= APP_DESC_OFFSET + 4 && readUint32LE(bytes, APP_DESC_OFFSET) === APP_DESC_MAGIC) {
    return APP_DESC_OFFSET;
  }
  return null;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

/**
 * The release version stamped into the image.
 *
 * The firmware prints "hcver:<version>" at boot, so the string is always in the
 * image. The ESP-IDF application descriptor of the Arduino core holds that core's
 * own build hash rather than the release version, so the marker is authoritative
 * and the descriptor value is only a fallback for images that do not have one.
 */
export function readVersionMarker(bytes: Uint8Array): string | null {
  const limit = Math.min(bytes.byteLength - VERSION_MARKER.length, 4 * 1024 * 1024);
  for (let i = 0; i < limit; i++) {
    let match = true;
    for (let k = 0; k < VERSION_MARKER.length; k++) {
      if (bytes[i + k] !== VERSION_MARKER[k]) { match = false; break; }
    }
    if (!match) continue;
    let value = '';
    for (let j = i + VERSION_MARKER.length; j < bytes.byteLength && value.length < 32; j++) {
      const byte = bytes[j]!;
      if (byte === 0) break;
      const ch = String.fromCharCode(byte);
      if (!/[A-Za-z0-9._+-]/.test(ch)) break;
      value += ch;
    }
    if (value) return value;
  }
  return null;
}

export function inspectAppImage(bytes: Uint8Array): ImageReport {
  const report: ImageReport = {
    valid: false, chipId: null, chipFamily: null, appVersion: '', versionSource: 'none', projectName: '',
    idfVersion: '', size: bytes.byteLength, checksumOk: false, trailingHash: null, errors: [],
  };
  const minimum = APP_DESC_OFFSET + 256 + 32;
  if (bytes.byteLength < minimum) {
    report.errors.push(`The file is only ${bytes.byteLength} bytes; a HomecoreOS application image is larger than ${minimum} bytes.`);
    return report;
  }
  if (bytes.byteLength > MAX_APP_BYTES) {
    report.errors.push('The image is larger than the application slot, so it cannot be installed over the air.');
  }
  if (bytes[0] !== 0xe9) {
    report.errors.push('Missing ESP32 image magic byte — this is not an ESP application image.');
    return report;
  }
  report.chipId = bytes[12]! | (bytes[13]! << 8);
  const family = Object.entries(CHIP_IDS).find(([, id]) => id === report.chipId);
  report.chipFamily = family ? family[0] : null;
  if (!report.chipFamily) report.errors.push(`Unknown target chip id ${report.chipId}.`);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The descriptor is located through the segment table, because its offset
  // depends on how the image was linked. See findAppDescriptorOffset().
  const descOffset = findAppDescriptorOffset(bytes);
  if (descOffset === null || view.getUint32(descOffset, true) !== APP_DESC_MAGIC) {
    report.errors.push('The application descriptor is missing, so this is not an application image.');
    return report;
  }
  const marker = readVersionMarker(bytes);
  report.appVersion = marker ?? readString(bytes, descOffset + 0x10, 32);
  report.versionSource = marker ? 'marker' : 'descriptor';
  report.projectName = readString(bytes, descOffset + 0x30, 32);
  // The descriptor layout is ESP-IDF's esp_app_desc_t: the compile time and
  // the compile date sit between the project name and the IDF version, so
  // idf_ver is at 0x70 and not at 0x50.
  report.idfVersion = readString(bytes, descOffset + 0x70, 32);

  // Segment walk: each segment is a 4-byte load address, a 4-byte length and the
  // data. The XOR checksum covers the data, seeded with 0xEF.
  //
  // Byte 23 of the header is the hash-appended flag, not the checksum. When it is
  // 1 the image ends with a 16-byte-aligned padding, one checksum byte and then the
  // 32-byte SHA-256, so the checksum is the byte at length-33. For an image without
  // the trailing hash the checksum follows the last segment directly.
  let checksum = IMAGE_CHECKSUM_SEED;
  let cursor = 24;
  let dataEnd = -1;
  while (cursor + 8 <= bytes.byteLength) {
    const length = (bytes[cursor + 4]! | (bytes[cursor + 5]! << 8) | (bytes[cursor + 6]! << 16) | (bytes[cursor + 7]! << 24)) >>> 0;
    if (length === 0 || cursor + 8 + length > bytes.byteLength) break;
    for (let i = 0; i < length; i++) checksum ^= bytes[cursor + 8 + i]!;
    cursor += 8 + length;
    dataEnd = cursor;
  }
  const hashAppended = bytes[23] === 1;
  const checksumOffset = hashAppended ? bytes.byteLength - 33 : dataEnd;
  if (checksumOffset > 24 && checksumOffset < bytes.byteLength) {
    // Padding between the last segment and the checksum is zero, so it does not
    // change the running XOR; include it to be exact.
    for (let i = dataEnd > 0 ? dataEnd : 24; i < checksumOffset; i++) checksum ^= bytes[i]!;
    report.checksumOk = (checksum & 0xff) === bytes[checksumOffset];
  }
  if (!report.checksumOk) report.errors.push('The image checksum does not match its contents (the build is corrupt or truncated).');

  let digestInput = bytes.subarray(0, bytes.byteLength - 32);
  if (bytes.byteLength - 32 < 0) digestInput = bytes;
  report.valid = report.errors.length === 0;
  return report;
}

/** SHA-256 of the file, computed again here so the client value is never trusted. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * The trailing 32 bytes of an application image are the SHA-256 of everything
 * before them. Comparing that with a freshly computed digest catches a file that
 * was altered after the build or a partial upload.
 */
export async function trailingHashMatches(bytes: Uint8Array): Promise<boolean> {
  if (bytes.byteLength <= 32) return false;
  const body = bytes.subarray(0, bytes.byteLength - 32);
  const expected = await sha256Hex(body);
  const embedded = Array.from(bytes.subarray(bytes.byteLength - 32))
    .map((x) => x.toString(16).padStart(2, '0')).join('');
  return embedded === expected;
}

/** Flash layout of a merged image the browser installer writes from address 0. */
export const MERGED_LAYOUT = { bootloader: 0x0, partitions: 0x8000, app: 0x10000 };
export const MAX_MERGED_BYTES = 8 * 1024 * 1024;

/**
 * A merged USB image is the bootloader, the partition table, the OTA data page and
 * the application, written at their real offsets. It is checked here so a file
 * that would brick a board on first boot is rejected at upload time.
 */
export function inspectMergedImage(bytes: Uint8Array): ImageReport & { appOffset: number } {
  const report = inspectAppImage(bytes.subarray(0, 0)) as ImageReport & { appOffset: number };
  report.appOffset = MERGED_LAYOUT.app;
  report.size = bytes.byteLength;
  report.errors = [];
  if (bytes.byteLength < MERGED_LAYOUT.app) {
    report.errors.push('The file is shorter than the application offset; it cannot be a merged image.');
    return report;
  }
  if (bytes[0] !== 0xe9) report.errors.push('No ESP32 bootloader at address 0x0.');
  if (bytes[MERGED_LAYOUT.partitions] !== 0xaa || bytes[MERGED_LAYOUT.partitions + 1] !== 0x50) {
    report.errors.push('No partition table at 0x8000.');
  }
  if (bytes.byteLength > MAX_MERGED_BYTES) {
    report.errors.push('The merged image is larger than 8 MB, which is more than this board needs.');
  }
  const app = inspectAppImage(bytes.subarray(MERGED_LAYOUT.app));
  report.chipId = app.chipId;
  report.chipFamily = app.chipFamily;
  report.appVersion = app.appVersion;
  report.versionSource = app.versionSource;
  report.projectName = app.projectName;
  report.idfVersion = app.idfVersion;
  report.checksumOk = app.checksumOk;
  report.errors.push(...app.errors.map((e) => `Application at 0x10000: ${e}`));
  report.valid = report.errors.length === 0;
  return report;
}
