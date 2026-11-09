/**
 * Turns an arduino-cli build into the release package the Owner Console accepts.
 *
 *   node scripts/firmware/hc_package.mjs --build <arduino build dir> --out <release.zip>
 *
 * What it does, in order:
 *   1. finds the application image, the bootloader, the partition table and the
 *      OTA data page in the arduino-cli build directory;
 *   2. checks the application image (ESP magic, ESP32-S3 chip id, application
 *      descriptor) and reads its stamped version from the "hcver:" marker;
 *   3. writes the merged USB factory image: bootloader at 0x0, partition table at
 *      0x8000, OTA data at 0xE000 and the same application at 0x10000;
 *   4. writes manifest.json and SHA256SUMS.txt from the bytes on disk;
 *   5. writes one ZIP holding all of it, ready to upload in Firmware Management.
 *
 * There is no signing step. The package carries the SHA-256 of each image, and
 * the Owner Console recomputes and checks those digests when the ZIP is
 * uploaded. The controller verifies the same digest before it boots an update.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const PACKAGE_FORMAT = 1;
const MAX_APP_BYTES = 3 * 1024 * 1024;
const MAX_MERGED_BYTES = 8 * 1024 * 1024;
const BOARD_MODELS = ['espressif.esp32-s3-devkitc-1.n16r8', 'espressif.esp32-s3-devkitc-1.v1.1'];
const APP_DESC_MAGIC = 0xabcd5432;
const APP_DESC_OFFSET = 0x20;
const DROM_LOAD_ADDR = 0x3f400020;
const FLASH = {
  bootloader: 0x0,
  partitions: 0x8000,
  ota_data: 0xe000,
  app: 0x10000,
};

/**
 * The offset of the ESP application descriptor inside the image, or null.
 *
 * The descriptor is not at a fixed file offset. ESP-IDF links it into the
 * `.flash.appdesc` section, which is the first thing in the DROM segment, and
 * the MMU mapping header in front of it takes the first 0x20 bytes. The IROM
 * segment is normally emitted first, so the descriptor usually sits well past
 * offset 0x20 of the file. The segment table is walked to find it and the
 * magic word confirms the match.
 */
function findAppDescriptorOffset(bytes) {
  const segments = [];
  let cursor = 24;
  while (cursor + 8 <= bytes.length) {
    const addr = bytes.readUInt32LE(cursor);
    const length = bytes.readUInt32LE(cursor + 4);
    if (length === 0 || cursor + 8 + length > bytes.length) break;
    segments.push({ addr, fileOffset: cursor + 8, length });
    cursor += 8 + length;
  }
  const drom = segments.find((s) => s.addr === DROM_LOAD_ADDR)
    ?? segments.find((s) => s.fileOffset + APP_DESC_OFFSET + 4 <= bytes.length
      && bytes.readUInt32LE(s.fileOffset + APP_DESC_OFFSET) === APP_DESC_MAGIC);
  if (drom) {
    const offset = drom.fileOffset + APP_DESC_OFFSET;
    if (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === APP_DESC_MAGIC) return offset;
  }
  if (bytes.length >= APP_DESC_OFFSET + 4 && bytes.readUInt32LE(APP_DESC_OFFSET) === APP_DESC_MAGIC) {
    return APP_DESC_OFFSET;
  }
  return null;
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const fail = (message) => {
  console.error(`hc_package: ${message}`);
  process.exit(1);
};

const buildDir = resolve(arg('build', ''));
const outFile = resolve(arg('out', 'release.zip'));
const notesPath = arg('notes');
if (!buildDir || !existsSync(buildDir)) fail('pass --build <arduino-cli build directory>');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const findOne = (pattern) => {
  const hit = readdirSync(buildDir).find((name) => pattern.test(name));
  if (!hit) fail(`the build directory has no file matching ${pattern}`);
  return join(buildDir, hit);
};

/* ------------------------------------------------------------ the images -- */

const appPath = findOne(/\.ino\.bin$/);
const app = readFileSync(appPath);
if (app.length > MAX_APP_BYTES) {
  fail(`the application image is ${app.length} bytes; the OTA slot holds 3 MB`);
}
if (app[0] !== 0xe9) fail('the application image has no ESP32 magic byte');
const chipId = app[12] | (app[13] << 8);
if (chipId !== 9) fail(`the image targets chip id ${chipId}; this release is for ESP32-S3 (9)`);
// The application descriptor is not at a fixed file offset: ESP-IDF puts it at
// the start of the DROM segment, 0x20 bytes past the segment header because of
// the MMU mapping header in front of it. The segment table is walked to find it.
if (findAppDescriptorOffset(app) === null) fail('the application image has no application descriptor');

// The release version is printed at boot as "hcver:<version>" and lives in the
// image as a plain string. The IDF descriptor is not used: with this core it
// holds the precompiled core's build hash, not the release version.
const marker = /hcver:([A-Za-z0-9._+-]{1,32})\0/.exec(app.toString('latin1'));
if (!marker) {
  fail('the image carries no version marker; run scripts/firmware/hc_build.mjs before compiling');
}
const version = arg('version', marker[1]);
if (version !== marker[1]) {
  fail(`the image is stamped ${marker[1]} but the package says ${version}; rebuild with HC_FW_VERSION=${version}`);
}

const segments = [
  [FLASH.bootloader, readFileSync(findOne(/\.ino\.bootloader\.bin$/))],
  [FLASH.partitions, readFileSync(findOne(/\.ino\.partitions\.bin$/))],
  [FLASH.ota_data, readFileSync(join(buildDir, 'boot_app0.bin'))],
  [FLASH.app, app],
];
const mergedLength = FLASH.app + app.length;
if (segments[0][1].length > FLASH.partitions) fail('the bootloader overlaps the partition table');
if (segments[1][1].length > FLASH.ota_data - FLASH.partitions) fail('the partition table overlaps the OTA data page');
if (mergedLength > MAX_MERGED_BYTES) fail(`the merged image would be ${mergedLength} bytes, over the 8 MB limit`);
const merged = Buffer.alloc(mergedLength, 0xff);
for (const [offset, data] of segments) data.copy(merged, offset);
if (merged[0x8000] !== 0xaa || merged[0x8001] !== 0x50) fail('the merged image has no partition table at 0x8000');

// The two file names are fixed, so the Owner Console and the installer always
// know which artifact is which:
//   homecoreos-ota.bin     - the application image, written at 0x10000
//   homecoreos-factory.bin - the merged USB image, written at 0x0
const appName = 'homecoreos-ota.bin';
const usbName = 'homecoreos-factory.bin';
writeFileSync(join(buildDir, appName), app);
writeFileSync(join(buildDir, usbName), merged);

/* --------------------------------------------------------------- manifest -- */

const notes = notesPath && existsSync(notesPath)
  ? readFileSync(notesPath, 'utf8').trim().slice(0, 4000)
  : 'Built by GitHub Actions from the repository source.';

const manifest = {
  package_format: PACKAGE_FORMAT,
  project: 'homecoreos_esp32',
  name: `HomecoreOS Controller ${version}`,
  version,
  channel: arg('channel', 'stable'),
  chip_family: 'ESP32-S3',
  chip_id: 9,
  board_models: BOARD_MODELS,
  hardware: {
    flash_size_mb: 16,
    psram: 'octal',
    flash_mode: 'dio',
    flash_freq: '80mhz',
    partition_scheme: 'app3M_fat9M_16MB',
    fqbn: 'esp32:esp32:esp32s3:PSRAM=opi,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,CDCOnBoot=cdc',
  },
  // flash_offset is the address in bytes the image is written at: 65536 (0x10000)
  // for the application image and 0 for the merged factory image. It is written as
  // a plain integer, because that is the type of firmware_releases.flash_offset
  // (bigint) and the column is NOT NULL with a CHECK tying it to the artifact kind.
  artifacts: {
    app: {
      file: appName, kind: 'app', size: app.length, sha256: sha256(app),
      flash_offset: FLASH.app, install: 'ota and usb',
      description: 'Application image for wireless OTA updates and USB installs that keep the existing bootloader.',
    },
    factory: {
      file: usbName, kind: 'factory', size: merged.length, sha256: sha256(merged),
      flash_offset: FLASH.bootloader, install: 'usb only',
      description: 'Bootloader, partition table, OTA data page and the application at their flash offsets. First install and recovery over USB. Never installed over the air.',
    },
  },
  notes,
  built_at: new Date().toISOString(),
  builder: process.env.GITHUB_ACTIONS ? `github-actions:${process.env.GITHUB_RUN_ID || ''}` : 'local',
};
writeFileSync(join(buildDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const sums = [
  `${sha256(app)}  ${appName}`,
  `${sha256(merged)}  ${usbName}`,
  `${sha256(readFileSync(join(buildDir, 'manifest.json')))}  manifest.json`,
];
writeFileSync(join(buildDir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);

/* -------------------------------------------------------------------- ZIP -- */

// Stored (method 0) entries: a firmware image does not compress, and a plain
// store keeps the archive readable by any unpacker, including the Pages Function
// that validates it again before anything is stored.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();
function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

const names = ['manifest.json', 'SHA256SUMS.txt', appName, usbName];
const entries = names.map((name) => ({ name, data: readFileSync(join(buildDir, name)) }));

const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
const dosDay = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

const local = [];
const central = [];
let offset = 0;
for (const entry of entries) {
  const nameBytes = Buffer.from(entry.name, 'utf8');
  const crc = crc32(entry.data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);   // flags
  header.writeUInt16LE(0, 8);   // method: stored
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDay, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(entry.data.length, 18);
  header.writeUInt32LE(entry.data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  local.push(header, nameBytes, entry.data);

  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(20, 4);  // version made by
  record.writeUInt16LE(20, 6);  // version needed
  record.writeUInt16LE(0, 8);
  record.writeUInt16LE(0, 10);
  record.writeUInt16LE(dosTime, 12);
  record.writeUInt16LE(dosDay, 14);
  record.writeUInt32LE(crc, 16);
  record.writeUInt32LE(entry.data.length, 20);
  record.writeUInt32LE(entry.data.length, 24);
  record.writeUInt16LE(nameBytes.length, 28);
  record.writeUInt16LE(0, 30);  // extra
  record.writeUInt16LE(0, 32);  // comment
  record.writeUInt16LE(0, 34);  // disk
  record.writeUInt16LE(0, 36);  // internal attributes
  record.writeUInt32LE(0, 38);  // external attributes
  record.writeUInt32LE(offset, 42);
  central.push(record, nameBytes);
  offset += header.length + nameBytes.length + entry.data.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, Buffer.concat([...local, centralBuf, end]));

const zipSha = sha256(readFileSync(outFile));
writeFileSync(`${outFile}.sha256`, `${zipSha}  ${basename(outFile)}\n`);

console.log(`release package ${outFile}`);
console.log(`  version    ${version}`);
console.log(`  ota image  ${appName}  ${app.length} bytes  ${sha256(app)}  flash_offset 0x${FLASH.app.toString(16)}`);
console.log(`  factory    ${usbName}  ${merged.length} bytes  ${sha256(merged)}  flash_offset 0x0`);
console.log(`  zip        ${statSync(outFile).size} bytes  sha256 ${zipSha}`);
