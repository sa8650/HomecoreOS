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
 *   4. writes manifest.json from the bytes on disk, SHA256SUMS.txt for both images,
 *      and an Ed25519 signature over the application digest when a signing key is
 *      supplied;
 *   5. writes one ZIP holding all of it, ready to upload in Firmware Management.
 *
 * A signing key is optional: with `--sign-key <pkcs8.pem>` the package is signed
 * and the signature is verified again before it is written. Without a key the
 * manifest says "unsigned" and the console reports "signing key not configured".
 * Nothing is ever marked as verified on its own.
 */
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const PACKAGE_FORMAT = 1;
const MAX_APP_BYTES = 3 * 1024 * 1024;
const MAX_MERGED_BYTES = 8 * 1024 * 1024;
const BOARD_MODELS = ['espressif.esp32-s3-devkitc-1.n16r8', 'espressif.esp32-s3-devkitc-1.v1.1'];
const FLASH = {
  bootloader: 0x0,
  partitions: 0x8000,
  ota_data: 0xe000,
  app: 0x10000,
};

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
const keyPath = arg('sign-key');
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
if (app.readUInt32LE(0x20) !== 0xabcd5432) fail('the application image has no application descriptor');

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

const appName = `homecoreos-${version}-app.bin`;
const usbName = `homecoreos-${version}-usb.bin`;
writeFileSync(join(buildDir, appName), app);
writeFileSync(join(buildDir, usbName), merged);

/* -------------------------------------------------------------- signature -- */

let signature = null;
let publicKey = null;
if (keyPath) {
  const pem = readFileSync(keyPath, 'utf8');
  if (!pem.includes('PRIVATE KEY')) fail(`${keyPath} is not a PEM private key`);
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') {
    fail(`the signing key is ${key.asymmetricKeyType}; releases are signed with Ed25519`);
  }
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  // An Ed25519 SPKI ends with the raw 32-byte public key.
  publicKey = Buffer.from(spki.subarray(spki.length - 32)).toString('base64');
  // The signed message is the lowercase hex SHA-256 of the application image,
  // which is exactly what the controller has after streaming the download.
  const message = Buffer.from(sha256(app), 'utf8');
  signature = cryptoSign(null, message, key).toString('base64');
  if (!verify(null, message, createPublicKey(key), Buffer.from(signature, 'base64'))) {
    fail('the signature does not verify with its own public key');
  }
}
const signatureName = signature ? `${appName}.sig` : null;
if (signature) writeFileSync(join(buildDir, signatureName), `${signature}\n`);

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
  artifacts: {
    app: {
      file: appName, kind: 'app', size: app.length, sha256: sha256(app),
      flash_offset: FLASH.app, install: 'ota and usb',
      description: 'Application image for wireless OTA updates and USB installs that keep the existing bootloader.',
    },
    factory: {
      file: usbName, kind: 'factory', size: merged.length, sha256: sha256(merged),
      flash_offset: 0, install: 'usb only',
      description: 'Bootloader, partition table, OTA data page and the application at their flash offsets. First install and recovery over USB. Never installed over the air.',
    },
  },
  signature: {
    state: signature ? 'signed' : 'unsigned',
    algorithm: signature ? 'ed25519' : null,
    // Base64 of the raw 32-byte public key. Compile the same value into the
    // firmware (HC_FW_PUBKEY) so the controller can verify an update itself.
    public_key: publicKey,
    signed_file: signature ? appName : null,
    signature_file: signatureName,
    value: signature,
    covers: 'the lowercase hex SHA-256 of the application image, as UTF-8 text',
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
if (signature) sums.push(`${sha256(Buffer.from(signature))}  ${signatureName}`);
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

const names = ['manifest.json', 'SHA256SUMS.txt', appName, usbName].concat(signatureName ? [signatureName] : []);
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
console.log(`  app image  ${appName}  ${app.length} bytes  ${sha256(app)}`);
console.log(`  usb image  ${usbName}  ${merged.length} bytes  ${sha256(merged)}`);
console.log(`  signature  ${signature ? 'ed25519 over the app digest, verified' : 'none - signing key not configured'}`);
console.log(`  zip        ${statSync(outFile).size} bytes  sha256 ${zipSha}`);
