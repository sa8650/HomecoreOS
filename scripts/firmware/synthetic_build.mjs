/**
 * Builds a synthetic arduino-cli output directory.
 *
 * The images carry the same structure a real ESP32-S3 build produces: the ESP
 * magic byte, the chip id, a segment table with the application descriptor in
 * the DROM segment, a correct XOR checksum and the trailing SHA-256 of the
 * body. That lets the packaging script and the API's validator be exercised
 * without an ESP32 toolchain or a board.
 *
 * The layout follows what the Arduino ESP32 core actually emits:
 *   - a 24-byte image header;
 *   - the IROM segment (.flash.text) loaded at 0x42000020;
 *   - the DROM segment (.flash.appdesc + .flash.rodata) loaded at 0x3f400020,
 *     whose data starts with the 0x20-byte MMU mapping header followed by the
 *     ESP application descriptor.
 *
 * Getting this right matters: the descriptor is NOT at file offset 0x20, and a
 * builder that puts it there would hide the same class of bug in the validator.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IMAGE_CHECKSUM_SEED = 0xef;
const APP_DESC_OFFSET = 0x20;
const APP_DESC_MAGIC = 0xabcd5432;
const DROM_LOAD_ADDR = 0x3f400020;
const IROM_LOAD_ADDR = 0x42000020;

/**
 * Build one valid ESP application image.
 *
 * @param {object} options
 * @param {string} options.version   the version stamped into the image
 * @param {number} options.size     the total image size in bytes
 * @param {number} options.chipId   the ESP chip id (9 is the ESP32-S3)
 * @returns {Buffer}
 */
export function buildAppImage({ version, size = 256 * 1024, chipId = 9 }) {
  const body = Buffer.alloc(size, 0x00);

  body[0] = 0xe9;                                  // ESP image magic
  body[1] = 0x02;                                  // segment count
  body[2] = 0x02;                                  // SPI mode
  body[3] = 0x20;                                  // flash size and frequency
  body[23] = 0x01;                                 // hash appended
  body.writeUInt16LE(chipId, 12);

  // The IROM segment: the code, loaded at the instruction-fetch address.
  const iromLength = 0x1000;
  const iromHeader = 24;
  const iromData = iromHeader + 8;
  body.writeUInt32LE(IROM_LOAD_ADDR, iromHeader);
  body.writeUInt32LE(iromLength, iromHeader + 4);
  body.write('coreOS segment payload', iromData, 'latin1');

  // The DROM segment: the application descriptor and the read-only data. The
  // MMU mapping header occupies the first 0x20 bytes and the descriptor
  // follows it, which is why the descriptor is not at a fixed file offset.
  const dromLength = 0x1000;
  const dromHeader = iromData + iromLength;
  const dromData = dromHeader + 8;
  body.writeUInt32LE(DROM_LOAD_ADDR, dromHeader);
  body.writeUInt32LE(dromLength, dromHeader + 4);
  const descOffset = dromData + APP_DESC_OFFSET;
  body.writeUInt32LE(APP_DESC_MAGIC, descOffset);
  body.write(`1.0.0\0`, descOffset + 0x10, 'latin1');
  body.write('homecoreos_esp32\0', descOffset + 0x30, 'latin1');
  // ESP-IDF's esp_app_desc_t puts the compile time at 0x50 and the compile date
  // at 0x60, so the IDF version is at 0x70.
  body.write('v5.1\0', descOffset + 0x70, 'latin1');
  // The release version the firmware prints at boot.
  body.write(`hcver:${version}\0`, dromData + 0x200, 'latin1');

  // The XOR checksum covers the segment data, seeded with 0xEF. It must be
  // computed over the finished bytes, so every write above happens first.
  let checksum = IMAGE_CHECKSUM_SEED;
  for (let i = 0; i < iromLength; i += 1) checksum ^= body[iromData + i];
  for (let i = 0; i < dromLength; i += 1) checksum ^= body[dromData + i];
  const checksumOffset = size - 33;
  // The padding between the last segment and the checksum is zero and does not
  // change the running XOR, but it is walked explicitly to match the reader.
  for (let i = dromData + dromLength; i < checksumOffset; i += 1) checksum ^= body[i];
  body[checksumOffset] = checksum & 0xff;

  // The last 32 bytes are the SHA-256 of everything before them.
  const digest = createHash('sha256').update(body.subarray(0, size - 32)).digest();
  digest.copy(body, size - 32);

  return body;
}

/** Build the bootloader image. */
export function buildBootloader({ size = 1024, chipId = 9 } = {}) {
  const image = Buffer.alloc(size, 0x00);
  image[0] = 0xe9;
  image[1] = 0x01;
  image.writeUInt16LE(chipId, 12);
  return image;
}

/** Build the partition table image. */
export function buildPartitionTable({ size = 3072 } = {}) {
  const table = Buffer.alloc(size, 0x00);
  table[0] = 0xaa;
  table[1] = 0x50;
  return table;
}

/**
 * Write a complete synthetic build directory.
 *
 * @param {string} buildDir where to write the files
 * @param {string} version    the version to stamp into the application
 */
export function writeSyntheticBuild(buildDir, version) {
  execFileSync('mkdir', ['-p', buildDir]);
  writeFileSync(join(buildDir, 'homecoreos_esp32.ino.bin'), buildAppImage({ version }));
  writeFileSync(join(buildDir, 'homecoreos_esp32.ino.bootloader.bin'), buildBootloader());
  writeFileSync(join(buildDir, 'homecoreos_esp32.ino.partitions.bin'), buildPartitionTable());
  writeFileSync(join(buildDir, 'boot_app0.bin'), Buffer.alloc(4096, 0xff));
}
