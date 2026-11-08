/**
 * Release package reader for the Owner Console upload.
 *
 * A release ZIP is untrusted input. This reader:
 *   - reads the central directory instead of trusting local headers,
 *   - refuses absolute paths, `..` segments, backslashes, control characters and
 *     anything that is not a plain file at the archive root,
 *   - refuses links, directories and encrypted entries,
 *   - caps the archive size, the number of entries and the size of every entry,
 *   - refuses entries that would expand beyond the cap (zip bomb), checked both
 *     from the declared size and from the bytes actually produced,
 *   - verifies the CRC of every entry it decodes.
 *
 * The manifest and the checksums are checked again after decoding, and the
 * release is re-inspected from its bytes, so a hand-edited manifest cannot make
 * the console publish something the controller would reject.
 */
import { HttpError } from '../context';
import {
  inspectAppImage, inspectMergedImage, sha256Hex, trailingHashMatches,
  MAX_APP_BYTES, MAX_MERGED_BYTES,
} from '../artifacts/image';

export const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 24;
export const MAX_ENTRY_BYTES = MAX_MERGED_BYTES;
export const MAX_TOTAL_UNPACKED = 16 * 1024 * 1024;
const SIGNATURE_MAX_BYTES = 512;
const MANIFEST_MAX_BYTES = 64 * 1024;

/* ------------------------------------------------------------------ ZIP ---- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (let i = 0; i < bytes.byteLength; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** `node:zlib` is not available in the Pages runtime, so raw deflate is decoded here. */
export function inflateRaw(input: Uint8Array, maxBytes: number): Uint8Array {
  let pos = 0;
  let bitBuf = 0;
  let bitCount = 0;
  let out = new Uint8Array(Math.min(Math.max(input.byteLength * 4, 1024), maxBytes));
  let outLen = 0;

  const ensure = (extra: number) => {
    if (outLen + extra <= out.byteLength) return;
    if (outLen + extra > maxBytes) throw new HttpError(413, 'The archive expands far beyond a firmware image.');
    let size = out.byteLength * 2;
    while (size < outLen + extra) size *= 2;
    const next = new Uint8Array(Math.min(size, maxBytes));
    next.set(out.subarray(0, outLen));
    out = next;
  };
  const bits = (count: number) => {
    while (bitCount < count) {
      if (pos >= input.byteLength) throw new HttpError(400, 'The compressed archive is truncated.');
      bitBuf |= input[pos++]! << bitCount;
      bitCount += 8;
    }
    const value = bitBuf & ((1 << count) - 1);
    bitBuf >>>= count;
    bitCount -= count;
    return value;
  };

  const buildTable = (lengths: Uint8Array, count: number) => {
    const counts = new Uint16Array(16);
    for (let i = 0; i < count; i++) counts[lengths[i]!]!++;
    const offsets = new Uint16Array(16);
    for (let len = 1; len < 15; len++) offsets[len + 1] = offsets[len]! + counts[len]!;
    const symbols = new Uint16Array(count);
    for (let i = 0; i < count; i++) if (lengths[i]) symbols[offsets[lengths[i]!]!++] = i;
    return { counts, symbols };
  };
  const decode = (table: { counts: Uint16Array; symbols: Uint16Array }) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const count = table.counts[len]!;
      if (code - count < first) return table.symbols[index + (code - first)]!;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new HttpError(400, 'The compressed archive is damaged.');
  };

  const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  let fixedLit: ReturnType<typeof buildTable> | null = null;
  let fixedDist: ReturnType<typeof buildTable> | null = null;

  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      // Stored block: skip to the next byte boundary.
      bitBuf = 0; bitCount = 0;
      if (pos + 4 > input.byteLength) throw new HttpError(400, 'The compressed archive is truncated.');
      const len = input[pos]! | (input[pos + 1]! << 8);
      pos += 4;
      if (pos + len > input.byteLength) throw new HttpError(400, 'The compressed archive is truncated.');
      ensure(len);
      out.set(input.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
      continue;
    }
    let lit: ReturnType<typeof buildTable>;
    let dist: ReturnType<typeof buildTable>;
    if (type === 1) {
      if (!fixedLit) {
        const lengths = new Uint8Array(288);
        for (let i = 0; i < 144; i++) lengths[i] = 8;
        for (let i = 144; i < 256; i++) lengths[i] = 9;
        for (let i = 256; i < 280; i++) lengths[i] = 7;
        for (let i = 280; i < 288; i++) lengths[i] = 8;
        fixedLit = buildTable(lengths, 288);
        fixedDist = buildTable(new Uint8Array(30).fill(5), 30);
      }
      lit = fixedLit;
      dist = fixedDist!;
    } else if (type === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) codeLengths[ORDER[i]!] = bits(3);
      const codeTable = buildTable(codeLengths, 19);
      const lengths = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        const symbol = decode(codeTable);
        if (symbol < 16) { lengths[i++] = symbol; continue; }
        let repeat = 0, value = 0;
        if (symbol === 16) {
          if (i === 0) throw new HttpError(400, 'The compressed archive is damaged.');
          value = lengths[i - 1]!;
          repeat = 3 + bits(2);
        } else if (symbol === 17) repeat = 3 + bits(3);
        else repeat = 11 + bits(7);
        if (i + repeat > lengths.length) throw new HttpError(400, 'The compressed archive is damaged.');
        while (repeat-- > 0) lengths[i++] = value;
      }
      lit = buildTable(lengths.subarray(0, hlit), hlit);
      dist = buildTable(lengths.subarray(hlit), hdist);
    } else {
      throw new HttpError(400, 'The compressed archive uses an unsupported block type.');
    }
    for (;;) {
      const symbol = decode(lit);
      if (symbol < 256) { ensure(1); out[outLen++] = symbol; continue; }
      if (symbol === 256) break;
      const lenIndex = symbol - 257;
      if (lenIndex >= LENGTH_BASE.length) throw new HttpError(400, 'The compressed archive is damaged.');
      const length = LENGTH_BASE[lenIndex]! + bits(LENGTH_EXTRA[lenIndex]!);
      const distSymbol = decode(dist);
      if (distSymbol >= DIST_BASE.length) throw new HttpError(400, 'The compressed archive is damaged.');
      const distance = DIST_BASE[distSymbol]! + bits(DIST_EXTRA[distSymbol]!);
      if (distance > outLen) throw new HttpError(400, 'The compressed archive is damaged.');
      ensure(length);
      for (let i = 0; i < length; i++, outLen++) out[outLen] = out[outLen - distance]!;
    }
  }
  return out.subarray(0, outLen);
}

export interface ArchiveEntry {
  name: string;
  bytes: Uint8Array;
}

/** Decode a ZIP archive of firmware files, or throw a message safe to show the owner. */
export function readArchive(data: Uint8Array): ArchiveEntry[] {
  if (data.byteLength > MAX_ARCHIVE_BYTES) {
    throw new HttpError(413, `The ZIP is ${Math.round(data.byteLength / 1048576)} MB. A release package is smaller than ${MAX_ARCHIVE_BYTES / 1048576} MB.`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Find the end-of-central-directory record in the last 64 KB (a ZIP comment may follow it).
  let eocd = -1;
  for (let i = data.byteLength - 22; i >= Math.max(0, data.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new HttpError(400, 'This file is not a ZIP archive. Download the release ZIP from GitHub Actions or Releases and upload it unchanged.');
  const declaredCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (declaredCount === 0) throw new HttpError(400, 'The ZIP is empty.');
  if (declaredCount > MAX_ARCHIVE_ENTRIES) throw new HttpError(400, `The ZIP holds ${declaredCount} files; a release package has at most ${MAX_ARCHIVE_ENTRIES}.`);
  if (centralOffset + centralSize > data.byteLength) throw new HttpError(400, 'The ZIP index points outside the file; it is truncated or damaged.');

  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let cursor = centralOffset;
  for (let i = 0; i < declaredCount; i++) {
    if (cursor + 46 > data.byteLength || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new HttpError(400, 'The ZIP index is damaged.');
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameBytes = data.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: false }).decode(nameBytes);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new HttpError(400, 'The ZIP is password protected; release packages must not be encrypted.');
    if (method !== 0 && method !== 8) throw new HttpError(400, `"${name}" uses an unsupported compression method.`);
    // Linux file type lives in the high 16 bits of the external attributes.
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if (unixMode && (unixMode & 0xf000) === 0xa000) throw new HttpError(400, 'The ZIP contains a symbolic link, which is not allowed.');
    if (name.endsWith('/')) continue;                     // directory entry
    if (!name || name.length > 120) throw new HttpError(400, 'The ZIP contains an entry with an invalid name.');
    if (/[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, 'The ZIP contains an entry name with control characters.');
    if (name.includes('\\')) throw new HttpError(400, `"${name}" uses a Windows path separator; flatten the ZIP.`);
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new HttpError(400, `"${name}" is an absolute path.`);
    const segments = name.split('/');
    if (segments.length !== 1) throw new HttpError(400, `"${name}" is inside a folder. Put manifest.json and the .bin files at the top level of the ZIP.`);
    if (segments[0] === '.' || segments[0] === '..') throw new HttpError(400, `"${name}" is not a file name.`);
    if (seen.has(name.toLowerCase())) throw new HttpError(400, `The ZIP contains "${name}" twice.`);
    seen.add(name.toLowerCase());

    if (uncompressedSize > MAX_ENTRY_BYTES) throw new HttpError(413, `"${name}" is larger than the 8 MB limit for one firmware file.`);
    if (compressedSize > MAX_ENTRY_BYTES) throw new HttpError(413, `"${name}" is larger than the 8 MB limit for one firmware file.`);
    total += uncompressedSize;
    if (total > MAX_TOTAL_UNPACKED) throw new HttpError(413, 'The ZIP expands beyond the size of a firmware release.');

    if (localOffset + 30 > data.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new HttpError(400, `"${name}" has a damaged local header.`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > data.byteLength) throw new HttpError(400, `"${name}" is truncated.`);
    const raw = data.subarray(dataStart, dataStart + compressedSize);
    const bytes = method === 0 ? raw : inflateRaw(raw, MAX_ENTRY_BYTES);
    if (bytes.byteLength !== uncompressedSize) {
      throw new HttpError(400, `"${name}" does not match the size recorded in the ZIP.`);
    }
    if (crc32(bytes) !== crc) throw new HttpError(400, `"${name}" failed its CRC check; the ZIP is damaged.`);
    entries.push({ name, bytes });
  }
  if (!entries.length) throw new HttpError(400, 'The ZIP contains no files.');
  return entries;
}

/* ------------------------------------------------------------- manifest ---- */

export interface ReleaseManifest {
  package_format: number;
  project: string;
  name: string;
  version: string;
  channel: string;
  chip_family: string;
  chip_id: number | null;
  board_models: string[];
  hardware: Record<string, unknown>;
  artifacts: {
    app?: { file: string; size: number; sha256: string; flash_offset?: number };
    factory?: { file: string; size: number; sha256: string; flash_offset?: number };
  };
  signature?: {
    state?: string;
    algorithm?: string | null;
    public_key?: string | null;
    signed_file?: string | null;
    signature_file?: string | null;
    value?: string | null;
  };
  notes?: string;
}

export const PACKAGE_PROJECT = 'homecoreos_esp32';
/** Where an application-only image is written in flash. Kept in step with
 *  APP_FLASH_OFFSET in firmware/releases.ts and with MERGED_LAYOUT.app. */
const APP_OFFSET = 0x10000;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const VERSION_RE = /^[A-Za-z0-9._+-]{1,32}$/;

export interface PackageReport {
  version: string;
  channel: string;
  name: string;
  notes: string;
  chipFamily: string;
  chipId: number | null;
  boardModels: string[];
  hardware: Record<string, unknown>;
  app: { file: string; bytes: Uint8Array; sha256: string; offset: number; version: string };
  factory: { file: string; bytes: Uint8Array; sha256: string; offset: number };
  signature: {
    present: boolean;
    algorithm: string | null;
    value: string | null;
    publicKey: string | null;
    signedFile: string | null;
    verified: boolean | null;
    problems: string[];
  };
  problems: string[];
  checks: { id: string; label: string; ok: boolean; detail: string }[];
}

/**
 * Validate a decoded archive. Every problem is collected so the owner sees the
 * whole list at once instead of fixing one error per upload.
 */
export async function inspectPackage(entries: ArchiveEntry[], knownBoards: Set<string>): Promise<PackageReport> {
  const problems: string[] = [];
  const checks: PackageReport['checks'] = [];
  const record = (id: string, label: string, ok: boolean, detail: string) => checks.push({ id, label, ok, detail });
  const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));

  const manifestEntry = byName.get('manifest.json');
  if (!manifestEntry) throw new HttpError(400, 'manifest.json is missing. Upload the release ZIP exactly as GitHub Actions produced it.');
  if (manifestEntry.bytes.byteLength > MANIFEST_MAX_BYTES) throw new HttpError(413, 'manifest.json is unexpectedly large.');

  let manifest: ReleaseManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry.bytes));
  } catch {
    throw new HttpError(400, 'manifest.json is not valid JSON.');
  }
  record('manifest-json', 'manifest.json is readable JSON', true, `${manifestEntry.bytes.byteLength} bytes`);

  if (Number(manifest.package_format) !== 1) problems.push(`Unsupported package format ${String(manifest.package_format)}; expected 1.`);
  if (String(manifest.project || '') !== PACKAGE_PROJECT) {
    problems.push(`This package is for "${String(manifest.project || 'unknown')}", not ${PACKAGE_PROJECT}.`);
  }
  const version = String(manifest.version || '').trim();
  if (!VERSION_RE.test(version)) problems.push('manifest.json has no usable version (letters, numbers, dots, dashes or plus signs).');
  record('manifest-fields', 'Manifest identity', problems.length === 0 || !problems.some((p) => p.includes('manifest.json')),
    `version ${version || 'missing'}, project ${String(manifest.project || 'missing')}`);

  const declared = manifest.artifacts || {};
  const resolveFile = (declaredName: unknown, expect: 'app' | 'factory') => {
    const name = String(declaredName || '');
    if (!name) { problems.push(`manifest.json does not name the ${expect} image.`); return null; }
    const entry = byName.get(name.toLowerCase());
    if (!entry) { problems.push(`manifest.json names "${name}" but the ZIP does not contain it.`); return null; }
    if (!/\.bin$/i.test(name)) problems.push(`"${name}" is not a .bin image.`);
    return { name, entry };
  };
  const appEntry = resolveFile(declared.app?.file, 'app');
  const factoryEntry = resolveFile(declared.factory?.file, 'factory');

  const checksumProblems: string[] = [];
  const digest = async (name: string, entry: ArchiveEntry, expected: unknown) => {
    const actual = await sha256Hex(entry.bytes);
    if (!SHA256_RE.test(String(expected || ''))) {
      checksumProblems.push(`manifest.json has no SHA-256 for ${name}.`);
    } else if (String(expected).toLowerCase() !== actual) {
      checksumProblems.push(`The checksum in manifest.json does not match ${name}. The file was changed after the build.`);
    }
    const size = Number((entry.bytes as any).byteLength);
    return { actual, size };
  };

  let app = null as PackageReport['app'] | null;
  if (appEntry) {
    const { actual } = await digest(appEntry.name, appEntry.entry, declared.app?.sha256);
    const declaredSize = Number(declared.app?.size);
    if (Number.isFinite(declaredSize) && declaredSize !== appEntry.entry.bytes.byteLength) {
      checksumProblems.push(`manifest.json says the application image is ${declaredSize} bytes; the file is ${appEntry.entry.bytes.byteLength}.`);
    }
    const image = inspectAppImage(appEntry.entry.bytes);
    if (!image.valid) image.errors.forEach((e) => problems.push(`Application image: ${e}`));
    if (image.versionSource !== 'marker') {
      problems.push('The application image carries no "hcver:" version marker, so the version it installs cannot be proven. Rebuild the package with scripts/firmware/hc_package.mjs.');
    } else if (image.appVersion !== version) {
      problems.push(`The application image is stamped with version "${image.appVersion}" but the manifest says "${version}".`);
    }
    if (!(await trailingHashMatches(appEntry.entry.bytes))) {
      problems.push('The SHA-256 trailer inside the application image does not match its body.');
    }
    if (appEntry.entry.bytes.byteLength > MAX_APP_BYTES) {
      problems.push('The application image is larger than the 3 MB OTA slot.');
    }
    // The build must state where the image is written, and it must be the offset an
    // application image belongs at. A package that says 0 would be flashed over the
    // bootloader, so it is reported instead of silently corrected.
    if (declared.app?.flash_offset === undefined || declared.app.flash_offset === null) {
      problems.push('manifest.json does not say which flash offset the application image is written at. Rebuild the package with scripts/firmware/hc_package.mjs.');
    } else if (Number(declared.app.flash_offset) !== APP_OFFSET) {
      problems.push(`The application image must be flashed from offset 0x${APP_OFFSET.toString(16)} (${APP_OFFSET}); manifest.json says ${declared.app.flash_offset}.`);
    }
    app = {
      file: appEntry.name, bytes: appEntry.entry.bytes, sha256: actual,
      offset: APP_OFFSET, version: image.appVersion || version,
    };
    record('app-image', 'OTA application image', image.valid,
      image.valid ? `${image.chipFamily} ${image.appVersion}, ${appEntry.entry.bytes.byteLength} bytes` : image.errors.join(' '));
    if (image.chipId !== null) record('app-chip', 'Application targets this board family', image.chipId === 9,
      `chip id ${image.chipId}${image.chipId === 9 ? ' (ESP32-S3)' : ' (expected 9)'}`);
  }

  let factory = null as PackageReport['factory'] | null;
  if (factoryEntry) {
    const { actual } = await digest(factoryEntry.name, factoryEntry.entry, declared.factory?.sha256);
    const declaredSize = Number(declared.factory?.size);
    if (Number.isFinite(declaredSize) && declaredSize !== factoryEntry.entry.bytes.byteLength) {
      checksumProblems.push(`manifest.json says the USB image is ${declaredSize} bytes; the file is ${factoryEntry.entry.bytes.byteLength}.`);
    }
    const merged = inspectMergedImage(factoryEntry.entry.bytes);
    if (!merged.valid) merged.errors.forEach((e) => problems.push(`USB image: ${e}`));
    if (merged.versionSource === 'marker' && merged.appVersion !== version) {
      problems.push(`The USB image carries version "${merged.appVersion}" but the manifest says "${version}".`);
    }
    if (factoryEntry.entry.bytes.byteLength > MAX_MERGED_BYTES) {
      problems.push('The USB image is larger than the 8 MB limit.');
    }
    // The USB image must carry the very same application as the OTA image.
    if (app && merged.valid) {
      const embedded = factoryEntry.entry.bytes.subarray(0x10000, 0x10000 + app.bytes.byteLength);
      if (embedded.byteLength !== app.bytes.byteLength || (await sha256Hex(embedded)) !== app.sha256) {
        problems.push('The application inside the USB image differs from the OTA image. Both must come from the same build.');
      }
    }
    if (declared.factory?.flash_offset === undefined || declared.factory.flash_offset === null) {
      problems.push('manifest.json does not say which flash offset the USB image is written at. Rebuild the package with scripts/firmware/hc_package.mjs.');
    } else if (Number(declared.factory.flash_offset) !== 0) {
      problems.push('The USB image must be flashed from offset 0x0.');
    }

    factory = { file: factoryEntry.name, bytes: factoryEntry.entry.bytes, sha256: actual, offset: 0 };
    record('factory-image', 'USB factory image', merged.valid,
      merged.valid ? `merged image, ${factoryEntry.entry.bytes.byteLength} bytes` : merged.errors.join(' '));
  } else {
    problems.push('The package has no USB factory image. The first-time USB install needs one.');
  }
  if (checksumProblems.length) problems.push(...checksumProblems);
  record('checksums', 'Checksums match the files', checksumProblems.length === 0,
    checksumProblems.length ? checksumProblems.join(' ') : 'every SHA-256 in manifest.json matches its file');

  // Board compatibility: only models that exist in the catalog may be claimed.
  const declaredBoards = Array.isArray(manifest.board_models) ? manifest.board_models.map(String) : [];
  const boardModels = declaredBoards.filter((id) => knownBoards.has(id));
  const unknownBoards = declaredBoards.filter((id) => !knownBoards.has(id));
  if (!declaredBoards.length) problems.push('manifest.json lists no board models, so no controller could install this release.');
  if (unknownBoards.length) problems.push(`The package claims board models that are not in the catalog: ${unknownBoards.join(', ')}.`);
  record('boards', 'Board compatibility', declaredBoards.length > 0 && unknownBoards.length === 0,
    boardModels.length ? boardModels.join(', ') : 'no usable board model');

  const hardware = (manifest.hardware || {}) as Record<string, unknown>;
  const flashMb = Number(hardware.flash_size_mb);
  if (Number.isFinite(flashMb) && flashMb !== 16) {
    problems.push(`The package is built for ${flashMb} MB of flash; this controller family uses 16 MB.`);
  }
  record('hardware', 'Hardware configuration', !Number.isFinite(flashMb) || flashMb === 16,
    `flash ${Number.isFinite(flashMb) ? `${flashMb} MB` : 'not stated'}, PSRAM ${String(hardware.psram || 'not stated')}`);

  // Signature: presence is reported honestly, and a declared signature must match
  // the file it claims to cover. The console cannot verify Ed25519 with the
  // public key unless one is configured, so `verified` stays null ("unchecked")
  // rather than being reported as valid.
  const sig = manifest.signature || {};
  const sigProblems: string[] = [];
  const sigEntry = sig.signature_file ? byName.get(String(sig.signature_file).toLowerCase()) : undefined;
  let sigValue = String(sig.value || '').trim();
  if (!sigValue && sigEntry) {
    if (sigEntry.bytes.byteLength > SIGNATURE_MAX_BYTES) sigProblems.push('The signature file is too large to be an Ed25519 signature.');
    else sigValue = new TextDecoder().decode(sigEntry.bytes).trim();
  }
  let signaturePresent = false;
  let signatureAlg: string | null = null;
  if (sig.value || sigEntry || sig.state === 'signed') {
    signaturePresent = true;
    signatureAlg = String(sig.algorithm || '');
    if (signatureAlg !== 'ed25519') sigProblems.push(`The package declares signature algorithm "${signatureAlg || 'none'}"; releases accept ed25519.`);
    if (!sigValue) sigProblems.push('The package is marked signed but carries no signature value.');
    if (sig.signed_file && String(sig.signed_file).toLowerCase() !== String(declared.app?.file || '').toLowerCase()) {
      sigProblems.push('The signature covers a file that is not the application image.');
    }
    if (sigValue) {
      try {
        const raw = Uint8Array.from(atob(sigValue.replace(/\s+/g, '')), (ch) => ch.charCodeAt(0));
        if (raw.byteLength !== 64) sigProblems.push(`An Ed25519 signature is 64 bytes; this one is ${raw.byteLength}.`);
      } catch {
        sigProblems.push('The signature is not valid base64.');
      }
    }
  } else if (String(sig.state || '') && !['unsigned', 'none'].includes(String(sig.state))) {
    sigProblems.push(`Unknown signature state "${String(sig.state)}".`);
  }
  problems.push(...sigProblems);
  record('signature', 'Detached signature', sigProblems.length === 0,
    sigProblems.length ? sigProblems.join(' ')
      : signaturePresent ? `ed25519 signature over ${String(sig.signed_file || declared.app?.file)}` : 'unsigned package - the controller will report "signing key not configured"');

  if (!app) problems.push('The package has no OTA application image; wireless updates need one.');
  if (!app || !factory) {
    // Fall back to placeholder values so the caller can still show the problems.
  }

  return {
    version,
    channel: ['stable', 'beta', 'dev'].includes(String(manifest.channel)) ? String(manifest.channel) : 'stable',
    name: String(manifest.name || `HomecoreOS Controller ${version}`).slice(0, 120),
    notes: String(manifest.notes || '').slice(0, 4000),
    chipFamily: String(manifest.chip_family || 'ESP32-S3'),
    chipId: Number.isFinite(Number(manifest.chip_id)) ? Number(manifest.chip_id) : 9,
    boardModels,
    hardware,
    app: app as PackageReport['app'],
    factory: factory as PackageReport['factory'],
    signature: {
      present: signaturePresent,
      algorithm: signatureAlg,
      value: sigValue || null,
      publicKey: sig.public_key ? String(sig.public_key) : null,
      signedFile: sig.signed_file ? String(sig.signed_file) : null,
      verified: null,
      problems: sigProblems,
    },
    problems,
    checks,
  };
}
