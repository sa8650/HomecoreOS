/**
 * Builds a synthetic arduino-cli output directory, runs the real packaging
 * script over it, and checks the resulting ZIP against the release contract:
 * one ZIP, the fixed artifact names, a manifest with the right flash offsets,
 * matching SHA-256 digests and no signature anywhere.
 *
 *   node scripts/firmware/verify_package.mjs
 *
 * This does not need an ESP32 toolchain or a board. The images are synthetic
 * but they carry the same structure the packaging script inspects.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/* ---------------------------------------------------- a synthetic build -- */

const work = mkdtempSync(join(tmpdir(), 'hc-pkg-'));
const build = join(work, 'build');
const { writeSyntheticBuild } = await import(pathToFileURL(join(here, 'synthetic_build.mjs')).href);
writeSyntheticBuild(build, '1.2.3');

/* ------------------------------------------------------------- package -- */

const out = join(work, 'homecoreos-release.zip');
let packaged = false;
try {
  execFileSync('node', [join(repo, 'scripts/firmware/hc_package.mjs'), '--build', build, '--out', out], {
    stdio: 'pipe',
  });
  packaged = true;
} catch (e) {
  console.log(`[FAIL] the packaging script ran\n        ${e.stderr?.toString() || e.message}`);
  failures += 1;
}

if (packaged) {
  const zip = readFileSync(out);

  /* ------------------------------------------------------- the ZIP shape -- */

  // Parse the central directory so the check does not depend on an unzip tool.
  const names = [];
  let eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  let ptr = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    const nameLen = zip.readUInt16LE(ptr + 28);
    const extraLen = zip.readUInt16LE(ptr + 30);
    const commentLen = zip.readUInt16LE(ptr + 32);
    names.push(zip.toString('utf8', ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;
  }

  const expected = ['manifest.json', 'SHA256SUMS.txt', 'homecoreos-ota.bin', 'homecoreos-factory.bin'];
  check(
    'the ZIP holds exactly the four release files',
    names.length === expected.length && expected.every((n) => names.includes(n)),
    `found: ${names.join(', ')}`,
  );
  check('the ZIP has no nested ZIP', !names.some((n) => n.endsWith('.zip')));
  check('the ZIP has no signature file', !names.some((n) => /sig/i.test(n)));
  check('the ZIP has no .sig entry', !names.some((n) => n.endsWith('.sig')));

  /* ------------------------------------------------- read the contents -- */

  const readEntry = (name) => {
    let p = zip.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i += 1) {
      const nameLen = zip.readUInt16LE(p + 28);
      const extraLen = zip.readUInt16LE(p + 30);
      const commentLen = zip.readUInt16LE(p + 32);
      const entryName = zip.toString('utf8', p + 46, p + 46 + nameLen);
      if (entryName === name) {
        const local = zip.readUInt32LE(p + 42);
        const localNameLen = zip.readUInt16LE(local + 26);
        const localExtraLen = zip.readUInt16LE(local + 28);
        const start = local + 30 + localNameLen + localExtraLen;
        const size = zip.readUInt32LE(p + 20);
        return zip.subarray(start, start + size);
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  };

  const manifest = JSON.parse(readEntry('manifest.json').toString('utf8'));
  const ota = readEntry('homecoreos-ota.bin');
  const factory = readEntry('homecoreos-factory.bin');
  const sums = readEntry('SHA256SUMS.txt').toString('utf8');

  /* ------------------------------------------------------ the manifest -- */

  check('the manifest has no signature block', manifest.signature === undefined);
  check('the manifest names the OTA artifact', manifest.artifacts?.app?.file === 'homecoreos-ota.bin');
  check('the manifest names the factory artifact', manifest.artifacts?.factory?.file === 'homecoreos-factory.bin');
  check('the manifest targets ESP32-S3 (chip id 9)', manifest.chip_id === 9);
  check('the manifest carries the version', manifest.version === '1.2.3');
  check('the manifest lists the board models', Array.isArray(manifest.board_models) && manifest.board_models.length > 0);

  /* --------------------------------------------------- the flash offset -- */

  check(
    'the manifest gives the OTA image flash offset 65536 (0x10000)',
    manifest.artifacts?.app?.flash_offset === 65536,
    `got ${manifest.artifacts?.app?.flash_offset}`,
  );
  check(
    'the manifest gives the factory image flash offset 0',
    manifest.artifacts?.factory?.flash_offset === 0,
    `got ${manifest.artifacts?.factory?.flash_offset}`,
  );

  /* ------------------------------------------------------ the checksums -- */

  check('the OTA digest in the manifest matches the bytes', manifest.artifacts.app.sha256 === sha256(ota));
  check('the factory digest in the manifest matches the bytes', manifest.artifacts.factory.sha256 === sha256(factory));
  check('the OTA size in the manifest matches the bytes', manifest.artifacts.app.size === ota.length);
  check('the factory size in the manifest matches the bytes', manifest.artifacts.factory.size === factory.length);
  check('SHA256SUMS.txt lists the OTA image', sums.includes(sha256(ota)));
  check('SHA256SUMS.txt lists the factory image', sums.includes(sha256(factory)));

  /* ------------------------------------------------ the merged factory -- */

  check('the factory image starts with the bootloader at 0x0', factory[0] === 0xe9);
  check('the partition table sits at 0x8000', factory[0x8000] === 0xaa && factory[0x8001] === 0x50);
  check(
    'the application sits at 0x10000 in the factory image',
    factory.subarray(0x10000, 0x10000 + ota.length).equals(ota),
  );

  /* ------------------------------------------------------------ the CRC -- */

  // Every entry's CRC in the central directory must match the CRC of its own
  // bytes, which is what the API's reader checks before it accepts the file.
  const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    return table;
  })();
  const crc32 = (buf) => {
    let crc = -1;
    for (let i = 0; i < buf.length; i += 1) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  };

  // The CRC-32 of "123456789" is a fixed 0xCBF43926. A CRC implementation that
  // does not produce it would write archives that standard tools reject.
  const crcSelfTest = crc32(new TextEncoder().encode('123456789'));
  check(
    'the CRC implementation matches the standard CRC-32',
    crcSelfTest === 0xcbf43926,
    `got 0x${crcSelfTest.toString(16)}`,
  );

  let p2 = zip.readUInt32LE(eocd + 16);
  const crcProblems = [];
  for (let i = 0; i < count; i += 1) {
    const nameLen = zip.readUInt16LE(p2 + 28);
    const extraLen = zip.readUInt16LE(p2 + 30);
    const commentLen = zip.readUInt16LE(p2 + 32);
    const entryName = zip.toString('utf8', p2 + 46, p2 + 46 + nameLen);
    const declared = zip.readUInt32LE(p2 + 16);
    const size = zip.readUInt32LE(p2 + 20);
    const local = zip.readUInt32LE(p2 + 42);
    const localNameLen = zip.readUInt16LE(local + 26);
    const localExtraLen = zip.readUInt16LE(local + 28);
    const start = local + 30 + localNameLen + localExtraLen;
    const actual = crc32(zip.subarray(start, start + size));
    if (declared !== actual) crcProblems.push(`${entryName}: declared ${declared}, computed ${actual}`);
    p2 += 46 + nameLen + extraLen + commentLen;
  }
  check('every entry CRC matches its bytes', crcProblems.length === 0, crcProblems.join(' | '));

  /* ------------------------------------------------------- the checksum -- */

  const sidecar = readFileSync(`${out}.sha256`, 'utf8');
  check('the ZIP checksum sidecar matches the ZIP', sidecar.includes(sha256(zip)));
}

rmSync(work, { recursive: true, force: true });

console.log(`\n${'='.repeat(62)}`);
console.log(failures === 0 ? '  all packaging checks passed' : `  ${failures} packaging check(s) failed`);
console.log('='.repeat(62));
process.exit(failures === 0 ? 0 : 1);
