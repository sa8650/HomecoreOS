/**
 * Feeds the real release ZIP produced by scripts/firmware/hc_package.mjs
 * through the API's package reader and validator, and checks that the Owner
 * Console upload path accepts it.
 *
 *   node scripts/firmware/verify_api_package.mjs
 *
 * The API modules are TypeScript, so they are run through the TypeScript
 * compiler's transpile-only loader. No board, no cloud service and no
 * database are needed.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const require = createRequire(import.meta.url);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/* ------------------------------------------------- a synthetic build -- */

const work = mkdtempSync(join(tmpdir(), 'hc-api-pkg-'));
const build = join(work, 'build');
const { writeSyntheticBuild } = await import(pathToFileURL(join(here, 'synthetic_build.mjs')).href);
writeSyntheticBuild(build, '2.0.0');

const out = join(work, 'release.zip');
execFileSync('node', [join(repo, 'scripts/firmware/hc_package.mjs'), '--build', build, '--out', out], {
  stdio: 'pipe',
});

/* --------------------------------------------- load the API modules -- */

const apiDir = join(repo, 'apps', 'api', 'src');
const ts = require(join(repo, 'node_modules', 'typescript'));

/**
 * Transpile the API's TypeScript modules on the fly into a scratch directory
 * inside the repository, so the test exercises the real source and the bare
 * imports (hono, zod) still resolve from node_modules.
 */
const outDir = join(repo, 'node_modules', '.hc-api-build');

const transpileTree = (srcRoot, destRoot, rewrite) => {
  const files = [];
  const collect = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (execFileSync('stat', ['-c', '%F', full]).toString().trim() === 'directory') collect(full);
      else if (name.endsWith('.ts')) files.push(full);
    }
  };
  collect(srcRoot);
  for (const file of files) {
    const rel = file.slice(srcRoot.length + 1).replace(/\.ts$/, '.mjs');
    const dest = join(destRoot, rel);
    execFileSync('mkdir', ['-p', dirname(dest)]);
    const source = readFileSync(file, 'utf8');
    let output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    output = rewrite(output);
    writeFileSync(dest, output);
  }
};

const transpileAll = () => {
  execFileSync('rm', ['-rf', outDir]);
  execFileSync('mkdir', ['-p', outDir]);

  // The shared core package, so the bare "@homecoreos/core" import resolves.
  const coreSrc = join(repo, 'packages', 'core', 'src');
  const coreOut = join(outDir, '_core');
  transpileTree(coreSrc, coreOut, (o) => {
    let output = o.replace(/(from\s+['"])(\.\.?\/[^'"]+?)\.ts(['"])/g, '$1$2.mjs$3');
    output = output.replace(/(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g, (m, a, b, c) => {
      if (b.endsWith('.mjs')) return m;
      return `${a}${b}.mjs${c}`;
    });
    return output;
  });
  execFileSync('mkdir', ['-p', coreOut]);
  writeFileSync(join(coreOut, 'package.json'), JSON.stringify({ name: '@homecoreos/core', type: 'module', main: './index.mjs', exports: { '.': './index.mjs' } }));

  // The API itself.
  transpileTree(apiDir, outDir, (o) => {
    let output = o.replace(/(from\s+['"])(\.\.?\/[^'"]+?)\.ts(['"])/g, '$1$2.mjs$3');
    output = output.replace(/(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g, (m, a, b, c) => {
      if (b.endsWith('.mjs')) return m;
      return `${a}${b}.mjs${c}`;
    });
    return output;
  });

  // A tiny package.json so Node treats the scratch directory as ESM.
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ name: 'hc-api-build', type: 'module' }, null, 2));

  return outDir;
};

transpileAll();
// The shared core package resolves to its TypeScript source, which Node cannot
// load directly. A resolver hook points it at the transpiled copy.
const coreUrl = pathToFileURL(join(outDir, '_core', 'index.mjs')).href;
const { register } = require('node:module');
register(
  `data:text/javascript,${encodeURIComponent(`
    import { pathToFileURL } from 'node:url';
    export function resolve(specifier, context, next) {
      if (specifier === '@homecoreos/core') return { url: '${coreUrl}', shortCircuit: true };
      return next(specifier, context);
    }
  `)}`,
  pathToFileURL(join(work, 'hooks.mjs')),
);

const pkg = await import(pathToFileURL(join(outDir, 'artifacts/package.mjs')).href);
const releases = await import(pathToFileURL(join(outDir, 'firmware/releases.mjs')).href);
const image = await import(pathToFileURL(join(outDir, 'artifacts/image.mjs')).href);

/* ---------------------------------------------------------- the test -- */

const KNOWN_BOARDS = new Set([
  'espressif.esp32-s3-devkitc-1.n16r8',
  'espressif.esp32-s3-devkitc-1.v1.1',
]);

const zipBytes = new Uint8Array(readFileSync(out));
const entries = pkg.readArchive(zipBytes);
check('the API reads the release ZIP', entries.length === 4, `found ${entries.length} entries`);

const report = await pkg.inspectPackage(entries, KNOWN_BOARDS);

check('the API finds no problems in a good package', report.problems.length === 0, report.problems.join(' | '));
check('the API reads the version from the manifest', report.version === '2.0.0', report.version);
check('the API reads the board models', report.boardModels.length === 2, JSON.stringify(report.boardModels));
check('the API reads the chip id', report.chipId === 9, String(report.chipId));

check(
  'the API puts the OTA image at offset 65536',
  report.app.offset === 65536,
  String(report.app.offset),
);
check('the API puts the factory image at offset 0', report.factory.offset === 0, String(report.factory.offset));

check('the API found no signature check', !report.checks.some((c) => /signature/i.test(c.id + c.label)));
check('the report has no signature field', report.signature === undefined);

/* --------------------------------------- the same package with damage -- */

const damaged = entries.map((e) => ({
  ...e,
  bytes: e.name.toLowerCase() === 'homecoreos-ota.bin'
    ? Uint8Array.from(e.bytes.slice(0, e.bytes.length - 16))
    : e.bytes,
}));
const damagedReport = await pkg.inspectPackage(damaged, KNOWN_BOARDS);
check(
  'a tampered OTA image is rejected',
  damagedReport.problems.length > 0,
  damagedReport.problems.join(' | '),
);

/* ------------------------------------- a package with an unknown board -- */

const unknownBoards = await pkg.inspectPackage(entries, new Set(['some.other.board']));
check(
  'a package for unknown boards is rejected',
  unknownBoards.problems.length > 0,
  unknownBoards.problems.join(' | '),
);

/* ------------------------------------- the release helper constants -- */

check(
  'the release module exposes the same flash offsets',
  releases.APP_FLASH_OFFSET === 65536 && releases.FACTORY_FLASH_OFFSET === 0,
  `app=${releases.APP_FLASH_OFFSET} factory=${releases.FACTORY_FLASH_OFFSET}`,
);

/* ------------------------- the application descriptor is located properly -- */

/*
 * The application descriptor is not at file offset 0x20. ESP-IDF links it into
 * the .flash.appdesc section, the first thing in the DROM segment, and the MMU
 * mapping header in front of it takes the first 0x20 bytes. The IROM segment is
 * normally emitted first, so the descriptor sits well past offset 0x20 of the
 * file. An inspector that assumes a fixed offset rejects every real image.
 */
const appBytes = new Uint8Array(readFileSync(join(build, 'homecoreos_esp32.ino.bin')));
const descOffset = image.findAppDescriptorOffset(appBytes);
check(
  'the application descriptor is found through the segment table',
  descOffset !== null && descOffset !== 0x20,
  `descriptor at file offset ${descOffset === null ? 'not found' : '0x' + descOffset.toString(16)}`,
);

const appReport = image.inspectAppImage(appBytes);
check(
  'a real ESP32-S3 image passes inspection',
  appReport.valid,
  appReport.errors.join(' | '),
);
check(
  'the image reports its chip family',
  appReport.chipFamily === 'ESP32-S3',
  `chip=${appReport.chipFamily} id=${appReport.chipId}`,
);
check(
  'the image reports its stamped version',
  appReport.appVersion === '2.0.0',
  `version=${appReport.appVersion} source=${appReport.versionSource}`,
);
check(
  'the image reports its project name',
  appReport.projectName === 'homecoreos_esp32',
  `project=${appReport.projectName}`,
);
check(
  'the image reports its IDF version',
  appReport.idfVersion === 'v5.1',
  // ESP-IDF's esp_app_desc_t puts the compile time at 0x50 and the compile date
  // at 0x60, so reading 0x50 here would report the build time instead.
  `idf=${appReport.idfVersion}`,
);
check(
  'the image checksum is verified',
  appReport.checksumOk === true,
  `checksumOk=${appReport.checksumOk}`,
);

// An image whose descriptor is missing must still be rejected.
const noDescriptor = new Uint8Array(appBytes);
for (let i = 0; i < noDescriptor.length - 4; i += 1) {
  if (noDescriptor[i] === 0x32 && noDescriptor[i + 1] === 0x54
    && noDescriptor[i + 2] === 0xcd && noDescriptor[i + 3] === 0xab) {
    noDescriptor[i] = 0; noDescriptor[i + 1] = 0; noDescriptor[i + 2] = 0; noDescriptor[i + 3] = 0;
  }
}
check(
  'an image without a descriptor is rejected',
  image.inspectAppImage(noDescriptor).errors.length > 0,
  image.inspectAppImage(noDescriptor).errors.join(' | '),
);

rmSync(work, { recursive: true, force: true });
rmSync(outDir, { recursive: true, force: true });

console.log(`\n${'='.repeat(62)}`);
console.log(failures === 0 ? '  all API package checks passed' : `  ${failures} API package check(s) failed`);
console.log('='.repeat(62));
process.exit(failures === 0 ? 0 : 1);
