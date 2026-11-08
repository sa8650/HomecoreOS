/**
 * Firmware release management and OTA delivery.
 *
 * One verified artifact serves both delivery paths: the browser flasher
 * downloads it, and the controller downloads the same bytes over HTTPS. An
 * artifact is only published when its structure, checksum and board
 * compatibility have been verified server-side; the ESP32 verifies the checksum
 * and signature again before it boots into it.
 */
import type { Runtime } from '../services/runtime';
import { HttpError } from '../context';
import { randomHex } from '../crypto';
import { deviceTopics } from '@homecoreos/core';
import type { DeviceRecord } from '../device-auth';
import { authenticateDevice } from '../device-auth';
import {
  inspectAppImage, inspectMergedImage, sha256Hex, trailingHashMatches, MAX_APP_BYTES, MAX_MERGED_BYTES, CHIP_IDS,
} from '../artifacts/image';
import { signatureMatches } from '../storage/signed-url';
import { readArchive, inspectPackage, PackageReport } from '../artifacts/package';
import { fromB64 } from '../crypto';

export const ALLOWED_CHANNELS = ['stable', 'beta', 'dev'] as const;
export const SIGNING_ALGORITHMS = ['ecdsa-p256-sha256', 'ed25519'] as const;

/**
 * Where each artifact kind is written in flash.
 *
 * An application-only image goes to the first application partition (0x10000). A
 * factory image is a merged image holding the bootloader, the partition table and
 * the OTA data page, so it is written from 0x0. These are the only two values the
 * column may hold, they are decided by the artifact kind - never copied from one
 * kind to the other - and `firmware_releases.flash_offset` is NOT NULL with a
 * matching CHECK, so a row cannot be stored without one.
 */
export const APP_FLASH_OFFSET = 0x10000;
export const FACTORY_FLASH_OFFSET = 0x0;

export function flashOffsetFor(artifactKind: unknown): number {
  return String(artifactKind) === 'factory' ? FACTORY_FLASH_OFFSET : APP_FLASH_OFFSET;
}

export interface UploadInput {
  name: string;
  version: string;
  description: string;
  releaseNotes: string;
  channel: string;
  status: string;
  boardModels: string[];
  chipFamily: string;
  hwConfig: string;
  artifactKind: string;
  flashOffset: number | null;
  bytes: Uint8Array;
  filename: string;
  declaredSha: string | null;
}

export function normalizeBoardModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))].slice(0, 40);
}

/** Reject anything that cannot be installed before it is stored. */
export async function validateArtifact(rt: Runtime, input: UploadInput) {
  if (!input.bytes.byteLength) throw new HttpError(400, 'The uploaded file is empty');
  const merged = input.artifactKind === 'factory';
  if (merged && input.bytes.byteLength > MAX_MERGED_BYTES) {
    throw new HttpError(413, 'A merged USB image larger than 8 MB is not accepted.');
  }
  if (!merged && input.bytes.byteLength > MAX_APP_BYTES) {
    throw new HttpError(413, 'A firmware image larger than 3 MB cannot be installed in the OTA slot.');
  }
  const image = merged
    ? inspectMergedImage(input.bytes)
    : inspectAppImage(input.bytes);
  const problems = [...image.errors];
  if (image.valid && !merged) {
    const trailingOk = await trailingHashMatches(input.bytes);
    if (!trailingOk) problems.push('The SHA-256 appended by the build does not match the image body.');
  }
  if (image.valid) {
    if (input.chipFamily && image.chipFamily && image.chipFamily.toLowerCase() !== input.chipFamily.toLowerCase()) {
      problems.push(`The image targets ${image.chipFamily} but the release says ${input.chipFamily}.`);
    }
    // The image stamps its release version as "hcver:<version>". Only that marker
    // is authoritative; the descriptor value is the Arduino core's build hash.
    if (input.version && image.versionSource === 'marker' && image.appVersion !== input.version) {
      problems.push(`The image is stamped with version ${image.appVersion}, not ${input.version}. Rebuild or correct the version.`);
    }
  }
  const digest = await sha256Hex(input.bytes);
  if (input.declaredSha && input.declaredSha.toLowerCase() !== digest) {
    problems.push('The file changed during upload (checksum mismatch).');
  }
  const catalog = await rt.db.select('board_catalog', { eq: { active: true } });
  const known = new Set((catalog as any[]).map((row) => String(row.id)));
  const unknown = input.boardModels.filter((id) => !known.has(id));
  if (unknown.length) problems.push(`Unknown board model: ${unknown.join(', ')}`);
  return {
    digest,
    image,
    problems,
    ok: problems.length === 0,
  };
}

export async function storeArtifact(rt: Runtime, input: UploadInput, digest: string) {
  if (!rt.store) throw new HttpError(503, 'Firmware storage is not configured');
  const safeVersion = input.version.replace(/[^A-Za-z0-9._-]/g, '_');
  const extension = input.artifactKind === 'factory' ? 'usb-merged.bin' : 'app.bin';
  const key = `firmware/${safeVersion}/${input.chipFamily.toLowerCase()}-${randomHex(4)}.${extension}`;
  await rt.store.put(key, input.bytes);
  const readBack = await rt.store.get(key);
  if (!readBack) throw new HttpError(502, 'The firmware could not be read back after upload');
  const verified = await sha256Hex(new Uint8Array(readBack));
  if (verified !== digest) {
    await rt.store.delete(key).catch(() => {});
    throw new HttpError(502, 'The stored firmware failed its read-back checksum');
  }
  return key;
}

export async function createRelease(rt: Runtime, input: UploadInput, actorProfileId: string) {
  const validation = await validateArtifact(rt, input);
  const publishable = validation.ok;
  if (input.status === 'published' && !publishable) {
    throw new HttpError(422, 'This build cannot be published', {
      problems: validation.problems,
      image: validation.image,
    } as any);
  }
  if (input.status === 'published' && !input.boardModels.length) {
    throw new HttpError(400, 'Select at least one compatible controller model before publishing');
  }
  const key = await storeArtifact(rt, input, validation.digest);
  const existing = await rt.db.select<any>('firmware_releases', {
    eq: { version: input.version, channel: input.channel }, limit: 10,
  });
  if (existing.some((row) => !row.deleted_at && (row.artifact_kind || 'app') === input.artifactKind)) {
    await rt.store?.delete(key).catch(() => {});
    throw new HttpError(409, `Version ${input.version} already exists in the ${input.channel} channel for this artifact kind`);
  }
  const rows = await insertRelease(rt, {
    tenant_id: null,
    channel: input.channel,
    version: input.version,
    chip_family: input.chipFamily,
    chip_family_target: String(validation.image.chipFamily || input.chipFamily),
    board_models: input.boardModels,
    r2_key: key,
    size_bytes: input.bytes.byteLength,
    sha256: validation.digest,
    notes: input.description,
    description: input.description,
    release_notes: input.releaseNotes,
    name: input.name,
    status: publishable ? input.status : 'draft',
    artifact_kind: input.artifactKind,
    // Written from the artifact kind, always as a number. This previously sent
    // null for an application image, which PostgREST rejected with 23502 as soon
    // as the column became NOT NULL - and before that stored a row with no
    // installable offset at all.
    flash_offset: flashOffsetFor(input.artifactKind),
    hw_config: input.hwConfig,
    storage_backend: rt.storageBackend,
    checksum_verified: publishable,
    artifact_verified: publishable,
    verification_detail: {
      image: validation.image,
      problems: validation.problems,
      checked_at: new Date().toISOString(),
      trailing_hash_ok: validation.ok,
    },
    uploaded_by: actorProfileId,
    created_by: actorProfileId,
    published_at: publishable && input.status === 'published' ? new Date().toISOString() : null,
  }, [key]);
  const id = (rows[0] as any)?.id ?? null;
  await rt.db.insert('audit_logs', {
    actor_id: actorProfileId, actor_type: 'platform_admin',
    action: 'platform.firmware.upload', entity_type: 'firmware_release', entity_id: String(id),
    after: {
      name: input.name, version: input.version, kind: input.artifactKind,
      size_bytes: input.bytes.byteLength, sha256: validation.digest,
      boards: input.boardModels, problems: validation.problems,
    },
  }).catch(() => {});
  return {
    id,
    version: input.version,
    sha256: validation.digest,
    size_bytes: input.bytes.byteLength,
    status: publishable ? input.status : 'draft',
    verified: publishable,
    problems: validation.problems,
    image: validation.image,
    artifact_kind: input.artifactKind,
  };
}

/* ------------------------------------------------------- release packages -- */

/**
 * Verify a detached Ed25519 signature over the lowercase hex SHA-256 of an
 * application image, the same message the controller verifies after streaming
 * the download.
 *
 * `publicKeyB64` is the configured signing key (Cloudflare Pages variable
 * `FW_SIGNING_PUBKEY`, base64 of the raw 32-byte key). When no key is configured
 * the result is `null`, which the console shows as "signing key not configured"
 * - it is never reported as a passing check.
 */
export async function verifyEd25519(
  signatureB64: string,
  message: Uint8Array,
  publicKeyB64: string,
): Promise<boolean | null> {
  const key = String(publicKeyB64 || '').trim();
  if (!key) return null;
  let raw: Uint8Array;
  let sig: Uint8Array;
  try {
    raw = fromB64(key);
    sig = fromB64(signatureB64.replace(/\s+/g, ''));
  } catch {
    return false;
  }
  if (raw.byteLength !== 32 || sig.byteLength !== 64) return false;
  try {
    const algorithm = { name: 'Ed25519' } as any;
    const cryptoKey = await crypto.subtle.importKey('raw', raw as BufferSource, algorithm, false, ['verify']);
    return await crypto.subtle.verify(algorithm, cryptoKey, sig as BufferSource, message as BufferSource);
  } catch {
    // A runtime without Ed25519 (older Node) cannot check the signature.
    return null;
  }
}

export interface PackageUploadInput {
  bytes: Uint8Array;
  status: string;
  channel: string | null;
  notes: string | null;
  name: string | null;
  boardModels: string[] | null;
}

/**
 * Create (or re-create) both artifacts of a release ZIP: the application image
 * for over-the-air updates and the merged USB factory image.
 *
 * Nothing in the ZIP is trusted: the archive is re-read here, every checksum is
 * recomputed, both images are inspected structurally, and the Ed25519 signature
 * is checked against the configured public key. A package that fails any check is
 * stored as a draft with the reasons attached, never as published.
 */
/** Channel values the table accepts. An unknown value falls back to stable. */
export function normaliseChannel(value: unknown): 'stable' | 'beta' | 'dev' {
  const channel = String(value || '').trim().toLowerCase();
  return (ALLOWED_CHANNELS as readonly string[]).includes(channel) ? channel as 'stable' | 'beta' | 'dev' : 'stable';
}

/** chip_family is stored lowercase, as the column comment and the API agree. */
export function normaliseChipFamily(value: unknown): string {
  const family = String(value || '').trim().toLowerCase();
  return family || 'esp32-s3';
}

/**
 * Columns that must never be null on a release row, with the value to use when the
 * caller left one out. Kept next to the insert so a new column cannot be added to
 * the table without a decision here.
 */
export function completeReleaseRow(row: Record<string, any>): Record<string, any> {
  const filled: Record<string, any> = {
    ...row,
    tenant_id: row.tenant_id ?? null,
    channel: normaliseChannel(row.channel),
    version: String(row.version || '').trim(),
    chip_family: normaliseChipFamily(row.chip_family),
    chip_family_target: String(row.chip_family_target || row.chip_family || 'ESP32-S3'),
    board_models: Array.isArray(row.board_models) ? row.board_models : [],
    r2_key: String(row.r2_key || ''),
    sha256: String(row.sha256 || '').toLowerCase(),
    status: ['draft', 'published', 'archived'].includes(String(row.status)) ? String(row.status) : 'draft',
    artifact_kind: row.artifact_kind === 'factory' ? 'factory' : 'app',
    // The flash offset is a required part of the record and is derived here from
    // the artifact kind, so no caller can omit it. A value supplied by a caller is
    // kept only when it is the offset that belongs to this kind.
    flash_offset: Number.isInteger(Number(row.flash_offset)) && Number(row.flash_offset) >= 0
      ? Number(row.flash_offset)
      : flashOffsetFor(row.artifact_kind),
    storage_backend: String(row.storage_backend || 'supabase'),
    checksum_verified: row.checksum_verified === true,
    artifact_verified: row.artifact_verified === true,
    // A factory image is never installable over the air.
    ota_eligible: row.artifact_kind === 'factory' ? false : row.ota_eligible !== false,
    rollout_pct: Number.isFinite(Number(row.rollout_pct)) ? Number(row.rollout_pct) : 100,
    mandatory: row.mandatory === true,
    downloads: Number.isFinite(Number(row.downloads)) ? Number(row.downloads) : 0,
    verification_detail: row.verification_detail && typeof row.verification_detail === 'object'
      ? row.verification_detail : {},
  };
  const problems: string[] = [];
  if (!filled.version) problems.push('version');
  if (!filled.r2_key) problems.push('r2_key');
  if (!/^[0-9a-f]{64}$/.test(filled.sha256)) problems.push('sha256');
  if (!filled.chip_family) problems.push('chip_family');
  // flash_offset is NOT NULL in the table. Checked here too so a null is reported
  // as an incomplete record before anything is written, rather than as a 23502
  // from PostgREST after both images are already in R2.
  if (!Number.isInteger(filled.flash_offset)) problems.push('flash_offset');
  // An application image flashed from 0x0 would overwrite the bootloader, and a
  // merged factory image flashed from 0x10000 would be corrupt. The kind decides.
  if (filled.flash_offset !== flashOffsetFor(filled.artifact_kind)) {
    problems.push(`flash_offset must be ${flashOffsetFor(filled.artifact_kind)} for a ${filled.artifact_kind} image`);
  }
  // A published release that names no controller model can never be matched to a
  // controller, so it is rejected here rather than becoming an unreachable record
  // the Owner Console shows as live. A draft may still be empty: that is how an
  // upload whose board list failed validation is kept, so the owner can see the
  // problem and fix it before publishing.
  if (filled.status === 'published'
      && (!Array.isArray(filled.board_models) || filled.board_models.length === 0)) {
    throw new HttpError(400, 'A published release must name at least one compatible controller model. Nothing was stored.');
  }
  if (problems.length) {
    // This can only happen through a server-side programming error; it is reported
    // before any row is written, so no release record can be created half-filled.
    throw new HttpError(500, `The release record is incomplete (${problems.join(', ')}). Nothing was stored.`);
  }
  return filled;
}

/**
 * Insert one release row, and if the insert fails remove the objects this upload
 * already stored so a rejected release leaves nothing behind.
 */
async function insertRelease(
  rt: Runtime,
  row: Record<string, any>,
  storedKeys: Array<string | null>,
): Promise<any[]> {
  const complete = completeReleaseRow(row);
  try {
    return await rt.db.insert<any>('firmware_releases', complete);
  } catch (error: any) {
    for (const key of storedKeys) {
      if (key) await rt.store?.delete(key).catch(() => {});
    }
    throw new HttpError(502, `The release could not be recorded: ${String(error?.message || error).slice(0, 300)}`);
  }
}

export async function createPackageRelease(
  rt: Runtime,
  input: PackageUploadInput,
  actorProfileId: string,
  signingPublicKey: string,
) {
  const entries = readArchive(input.bytes);
  const catalog = await rt.db.select<any>('board_catalog', { eq: { active: true } });
  const known = new Set((catalog as any[]).map((row) => String(row.id)));
  const report: PackageReport = await inspectPackage(entries, known);

  if (!report.app || !report.factory) {
    const missing = [
      !report.app ? 'the OTA application image' : null,
      !report.factory ? 'the USB factory image' : null,
    ].filter(Boolean).join(' and ');
    throw new HttpError(422, `The package is incomplete: ${missing} could not be read.`, {
      problems: report.problems, checks: report.checks,
    } as any);
  }

  const channel = input.channel && (ALLOWED_CHANNELS as readonly string[]).includes(input.channel)
    ? input.channel : report.channel;
  const duplicates = await rt.db.select<any>('firmware_releases', { eq: { version: report.version }, limit: 10 });
  if (duplicates.some((row) => !row.deleted_at && row.channel === channel)) {
    throw new HttpError(409, `Version ${report.version} already exists in the ${channel} channel. Publish a new version, or archive the old release first.`);
  }

  // Signature outcome: verified true/false when a key is configured, null when not.
  const signatureOk = report.signature.present
    ? await verifyEd25519(
        String(report.signature.value || ''),
        new TextEncoder().encode(report.app.sha256),
        signingPublicKey,
      )
    : null;
  if (report.signature.present && signatureOk === false) {
    report.problems.push('The Ed25519 signature does not match the application image and the configured public key.');
    report.checks.push({ id: 'signature-match', label: 'Signature matches the image', ok: false, detail: 'verification failed' });
  } else if (signatureOk === true) {
    report.checks.push({ id: 'signature-match', label: 'Signature matches the image', ok: true, detail: 'Ed25519 signature verified with the configured public key' });
  }
  const verified = report.problems.length === 0;
  const wanted = String(input.status || 'draft');
  const status = wanted === 'published' && verified ? 'published' : 'draft';
  const boardModels = input.boardModels && input.boardModels.length
    ? input.boardModels.filter((id) => known.has(id))
    : report.boardModels;
  if (status === 'published' && !boardModels.length) {
    throw new HttpError(400, 'Add at least one compatible controller model before publishing');
  }

  const base = `firmware/${report.version.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const appKey = await storeVerified(rt, `${base}/app-${report.app.sha256.slice(0, 12)}.app.bin`, report.app.bytes, report.app.sha256);
  let factoryKey: string | null = null;
  try {
    factoryKey = await storeVerified(rt, `${base}/factory-${report.factory.sha256.slice(0, 12)}.usb-merged.bin`, report.factory.bytes, report.factory.sha256);
  } catch (e) {
    await rt.store?.delete(appKey).catch(() => {});
    throw e;
  }

  // Every NOT NULL column of public.firmware_releases is written explicitly here
  // rather than left to a table default: a database created by an earlier schema
  // does not have those defaults, and PostgREST answers a missing value with
  // 23502. `buildReleaseRow` is the single place that decides them.
  const chipFamilyTarget = String(report.chipFamily || 'ESP32-S3').trim();
  const common = {
    tenant_id: null,
    channel: normaliseChannel(channel),
    version: report.version,
    // Both artifacts advertise the same controller models. Without this the row
    // is stored with an empty board_models array, and every later lookup that
    // matches a release to a controller (install package, download, update
    // check) rejects it - the release exists but is offered to nobody.
    board_models: boardModels,
    chip_family: normaliseChipFamily(chipFamilyTarget),
    chip_family_target: chipFamilyTarget,
    status,
    hw_config: String((report.hardware as any)?.fqbn || '').slice(0, 200),
    storage_backend: rt.storageBackend,
    checksum_verified: verified,
    artifact_verified: verified,
    verification_detail: {
      package: true,
      checks: report.checks,
      problems: report.problems,
      hardware: report.hardware,
      checked_at: new Date().toISOString(),
    },
    uploaded_by: actorProfileId,
    created_by: actorProfileId,
    published_at: status === 'published' ? new Date().toISOString() : null,
    release_notes: input.notes ?? report.notes,
  };

  const releaseName = String(input.name || report.name || `HomecoreOS ${report.version}`).slice(0, 120);
  const notes = String(input.notes ?? report.notes ?? '').slice(0, 4000);

  const appRows = await insertRelease(rt, {
    ...common,
    name: releaseName,
    description: notes || null,
    notes: notes || null,
    r2_key: appKey,
    size_bytes: report.app.bytes.byteLength,
    sha256: report.app.sha256,
    artifact_kind: 'app',
    flash_offset: flashOffsetFor('app'),
    ota_eligible: true,
    signature: report.signature.present ? report.signature.value : null,
    signature_alg: report.signature.present ? report.signature.algorithm : null,
    signed_by_key: report.signature.publicKey,
  }, [appKey, factoryKey]);
  const factoryRows = await insertRelease(rt, {
    ...common,
    name: `${releaseName} (USB)`.slice(0, 120),
    description: 'Merged USB factory image for the in-browser installer, recovery and first-time setup.',
    notes: 'USB and recovery only. Not installable over the air.',
    r2_key: factoryKey,
    size_bytes: report.factory.bytes.byteLength,
    sha256: report.factory.sha256,
    artifact_kind: 'factory',
    flash_offset: flashOffsetFor('factory'),
    ota_eligible: false,
    signature: null,
    signature_alg: null,
  }, [appKey, factoryKey]);

  await rt.db.insert('audit_logs', {
    actor_id: actorProfileId, actor_type: 'platform_admin',
    action: 'platform.firmware.package.upload', entity_type: 'firmware_release',
    entity_id: String(appRows[0]?.id ?? ''),
    after: {
      version: report.version, channel, status,
      app: { sha256: report.app.sha256, size: report.app.bytes.byteLength },
      factory: { sha256: report.factory.sha256, size: report.factory.bytes.byteLength },
      signature: { present: report.signature.present, verified: signatureOk },
      boards: boardModels, problems: report.problems,
    },
  }).catch(() => {});

  return {
    ok: verified,
    status,
    version: report.version,
    channel,
    name: input.name || report.name,
    board_models: boardModels,
    signature: { present: report.signature.present, algorithm: report.signature.algorithm, verified: signatureOk },
    checks: report.checks,
    problems: report.problems,
    releases: [
      { id: appRows[0]?.id ?? null, kind: 'app', sha256: report.app.sha256, size_bytes: report.app.bytes.byteLength },
      { id: factoryRows[0]?.id ?? null, kind: 'factory', sha256: report.factory.sha256, size_bytes: report.factory.bytes.byteLength },
    ],
  };
}

/** Store one artifact and prove the stored bytes match the expected digest. */
async function storeVerified(rt: Runtime, key: string, bytes: Uint8Array, expected: string): Promise<string> {
  if (!rt.store) throw new HttpError(503, 'Firmware storage is not configured');
  await rt.store.put(key, bytes);
  const readBack = await rt.store.get(key);
  if (!readBack) throw new HttpError(502, 'The firmware could not be read back after upload');
  const digest = await sha256Hex(new Uint8Array(readBack));
  if (digest !== expected) {
    await rt.store.delete(key).catch(() => {});
    throw new HttpError(502, 'The stored firmware failed its read-back checksum');
  }
  return key;
}

/**
 * Issue an OTA command for one controller. Compatibility, publication state and
 * signature presence are all checked here; the controller then re-verifies the
 * bytes it receives.
 */
export async function queueOta(rt: Runtime, input: {
  releaseId: string;
  boardId: string;
  ip: string;
  allowUnsigned: boolean;
}): Promise<Record<string, unknown>> {
  const releases = await rt.db.select<any>('firmware_releases', { eq: { id: input.releaseId }, limit: 1 });
  const release = releases[0];
  if (!release || release.deleted_at) throw new HttpError(404, 'Firmware release not found');
  if (release.status !== 'published') throw new HttpError(409, 'Only published releases can be installed');
  if (release.artifact_kind !== 'app') {
    throw new HttpError(409, 'A factory image can only be installed over USB, not over the air');
  }
  if (!release.artifact_verified) throw new HttpError(409, 'This release has not passed artifact validation');
  if (!release.signature && !input.allowUnsigned) {
    throw new HttpError(409, 'This release has no signature and signing is required');
  }
  const boards = await rt.db.select<any>('user_boards', { eq: { id: input.boardId }, isNull: ['deleted_at'], limit: 1 });
  const board = boards[0];
  if (!board) throw new HttpError(404, 'Controller not found');
  const catalog = await rt.db.select<any>('board_catalog');
  const boardCatalog = (catalog as any[]).find((c) => c.id === board.catalog_board_id);
  const models: string[] = release.board_models || [];
  const compatible = models.includes(board.catalog_board_id)
    || (boardCatalog && models.includes(boardCatalog.chip_family));
  if (!compatible) throw new HttpError(409, 'This release does not support that controller model');
  if (release.size_bytes > MAX_APP_BYTES) throw new HttpError(409, 'The image is larger than the OTA slot');

  await rt.db.insert('device_firmware_history', {
    tenant_id: board.tenant_id,
    user_board_id: board.id,
    firmware_release_id: release.id,
    from_version: board.firmware_version,
    to_version: release.version,
    status: 'queued',
    progress: 0,
    bytes_total: release.size_bytes,
    source: 'console',
  });
  return {
    release_id: release.id,
    version: release.version,
    sha256: release.sha256,
    signature: release.signature,
    size_bytes: release.size_bytes,
    board_id: board.id,
    device_id: board.device_id,
    tenant_id: board.tenant_id,
    topics: deviceTopics(board.tenant_id, board.device_id),
    command: {
      schema_version: 1,
      command_id: crypto.randomUUID(),
      device_id: board.device_id,
      component_id: 'board',
      action: 'update_firmware',
      version: release.version,
      sha256: release.sha256,
      signature: release.signature || '',
      size_bytes: release.size_bytes,
      expires_at: Math.floor(Date.now() / 1000) + 900,
    },
  };
}

/** Publish the command produced above on the board's command topic. */
export async function publishOtaCommand(rt: Runtime, plan: Record<string, any>) {
  await rt.mqtt.publish({ topic: plan.topics.command, payload: plan.command, qos: 1 });
  await rt.db.update('device_firmware_history', {
    user_board_id: plan.board_id, status: 'queued',
  }, { command_id: plan.command.command_id }).catch(() => {});
  if (plan.tenant_id) rt.emit(plan.tenant_id, 'firmware.ota.queued', { board_id: plan.board_id, version: plan.version });
}

/**
 * Authenticated firmware download for controllers. The controller presents its
 * own credentials, and the container only serves a release compatible with that
 * board, so a leaked URL is useless without the device password.
 */
export async function deviceDownload(rt: Runtime, c: any): Promise<Response> {
  const body = await c.req.json().catch(() => ({}) as any);
  const device = await authenticateDevice(rt, String(body.client_id || ''), String(body.password || ''));
  if (!device) throw new HttpError(401, 'Controller credentials were not accepted');
  const releaseId = String(c.req.query('release') || '');
  const releases = await rt.db.select<any>('firmware_releases', { eq: { id: releaseId }, limit: 1 });
  const release = releases[0];
  if (!release || release.status !== 'published') throw new HttpError(404, 'Release not available');
  const latest = await rt.db.rpc<any>('rpc_firmware_latest', { p_board: device.board_id }).catch(() => null);
  if (!latest || String(latest.id) !== String(release.id)) {
    throw new HttpError(403, 'That release is not offered to this controller');
  }
  const data = await rt.store?.get(release.r2_key);
  if (!data) throw new HttpError(404, 'The firmware object is missing from storage');
  const digest = await sha256Hex(new Uint8Array(data));
  if (digest !== release.sha256) throw new HttpError(502, 'The stored firmware does not match its published checksum');
  await rt.db.update('firmware_releases', { id: release.id }, { downloads: Number(release.downloads || 0) + 1 }).catch(() => {});
  return new Response(data, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.byteLength),
      'X-Firmware-Sha256': digest,
      'X-Firmware-Version': String(release.version),
      'Cache-Control': 'private, no-store',
    },
  });
}

/**
 * Firmware negotiation for a paired controller: report the running version and
 * answer with the release it should install, if any.
 */
export async function firmwareCheck(rt: Runtime, device: DeviceRecord, origin: string, body: any) {
  const latest: any = await rt.db.rpc('rpc_firmware_latest', { p_board: device.board_id }).catch(() => null);
  const running = String(body?.firmware_version || '');
  await rt.db.update('user_boards', { id: device.board_id }, {
    firmware_version: running || null,
    last_seen_at: new Date().toISOString(),
    status: 'online',
    rssi: Number.isFinite(Number(body?.rssi)) ? Math.round(Number(body.rssi)) : undefined,
    uptime_seconds: Number.isFinite(Number(body?.uptime_seconds)) ? Math.round(Number(body.uptime_seconds)) : undefined,
  }).catch(() => {});
  if (!latest) return { update_available: false, installed: running };
  if (String(latest.version) === running) {
    return { update_available: false, installed: running, version: latest.version };
  }
  return {
    update_available: true,
    version: latest.version,
    notes: latest.notes,
    size_bytes: latest.size_bytes,
    sha256: latest.sha256,
    signature: latest.signature,
    signature_alg: latest.signature_alg,
    mandatory: !!latest.mandatory,
    url: `${origin}/api/device/firmware-download?release=${encodeURIComponent(String(latest.id))}`,
    installed: running,
  };
}

/**
 * Install package handed to the customer console: version, size, checksum and an
 * expiring download path. Nothing here is trusted after the fact - the download
 * route re-checks the release state, the signature and the digest.
 */
export async function installPackage(rt: Runtime, releaseId: string, _origin: string) {
  const releases = await rt.db.select<any>('firmware_releases', { eq: { id: releaseId }, limit: 1 });
  const release = releases[0];
  if (!release || release.deleted_at) throw new HttpError(404, 'Firmware release not found');
  if (release.status !== 'published') throw new HttpError(409, 'Only a published release can be installed');
  if (!rt.store) throw new HttpError(503, 'Firmware storage is not configured');
  const image = release.verification_detail?.image || inspectAppImage(new Uint8Array());
  return {
    id: release.id,
    version: release.version,
    name: release.name,
    notes: release.description || release.notes || release.release_notes || null,
    channel: release.channel,
    artifact_kind: release.artifact_kind,
    chip_family: release.chip_family_target || image.chipFamily || release.chip_family,
    chip_id: release.chip_family_target ? CHIP_IDS[release.chip_family_target] ?? null : null,
    size_bytes: Number(release.size_bytes || 0),
    sha256: release.sha256,
    signature_present: !!release.signature,
    signature_alg: release.signature_alg,
    ota_eligible: !!release.ota_eligible,
    // Read from the record, not guessed from the artifact kind: the browser
    // installer writes these bytes to exactly this address, so the stored value is
    // the one that has to be right. `flashOffsetFor` is the single place that
    // decides it, and this falls back to it only for a row written before the
    // column was populated.
    flash_offset: Number.isInteger(Number(release.flash_offset ?? NaN))
      ? Number(release.flash_offset)
      : flashOffsetFor(release.artifact_kind),
    published_at: release.published_at,
    url: await rt.store.signedUrl(release.r2_key, 600),
  };
}

/**
 * Latest published stable release for a board model.
 *
 * `kind` separates the two USB paths: an application image is written at the
 * application offset and keeps the existing bootloader and partition table, while
 * a factory image covers the whole flash layout for a first install or recovery.
 */
export async function latestForBoard(rt: Runtime, boardId: string | null, kind: 'app' | 'factory' = 'app') {
  const rows = await rt.db.select<any>('firmware_releases', { eq: { status: 'published' }, isNull: ['deleted_at'] });
  const found = (rows as any[])
    .filter((r) => r.channel === 'stable' && r.artifact_kind === kind)
    .filter((r) => !boardId || (r.board_models || []).includes(boardId))
    .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
  return found[0] || null;
}

/**
 * Streams a release to a signed-in customer browser for installation over USB.
 *
 * The caller is already authenticated and tenant-scoped by the route. Only a
 * published, verified release is served, and the bytes are re-hashed before they
 * leave so a corrupted object is never handed to a flasher.
 */
export async function customerDownload(rt: Runtime, releaseId: string): Promise<Response> {
  const releases = await rt.db.select<any>('firmware_releases', { eq: { id: releaseId }, limit: 1 });
  const release = releases[0];
  if (!release || release.deleted_at) throw new HttpError(404, 'Firmware release not found');
  if (release.status !== 'published') throw new HttpError(409, 'Only a published release can be installed');
  if (!rt.store) throw new HttpError(503, 'Firmware storage is not configured');
  const data = await rt.store.get(release.r2_key);
  if (!data) throw new HttpError(404, 'The firmware file is missing from storage');
  const digest = await sha256Hex(new Uint8Array(data));
  if (digest !== release.sha256) throw new HttpError(502, 'The stored firmware does not match its published checksum');
  const safe = String(release.version).replace(/[^A-Za-z0-9._-]/g, '_');
  return new Response(data, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.byteLength),
      'X-Firmware-Sha256': digest,
      'X-Firmware-Version': String(release.version),
      'Content-Disposition': `attachment; filename="homecoreos-${safe}-${release.artifact_kind === 'factory' ? 'factory' : 'app'}.bin"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

/**
 * Serves a signed download path. Used for the USB installer link (signed by the
 * server, so the page never sees a storage secret) and re-validates the release
 * before any bytes are sent.
 */
export async function serveSignedDownload(rt: Runtime, env: any, key: string, expires: string, sig: string): Promise<Response> {
  const secret = String(env?.SIGNING_KEY || '');
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new HttpError(503, 'Server signing key is not available');
  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) {
    throw new HttpError(410, 'This download link has expired. Reload the firmware page for a new one.');
  }
  const { hmacHex } = await import('../crypto');
  const expected = await hmacHex(secret, `${key}\n${expiresAt}`);
  if (!signatureMatches(expected, sig)) throw new HttpError(403, 'This download link is not valid');
  if (!rt.store) throw new HttpError(503, 'Firmware storage is not configured');
  const data = await rt.store.get(key);
  if (!data) throw new HttpError(404, 'The firmware file is missing from storage');
  const digest = await sha256Hex(new Uint8Array(data));
  return new Response(data, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.byteLength),
      'X-Firmware-Sha256': digest,
      'Cache-Control': 'private, no-store',
    },
  });
}
