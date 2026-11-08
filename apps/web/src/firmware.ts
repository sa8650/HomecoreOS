/**
 * Shared contract for the owner-side firmware workflow.
 *
 * The same release is used by both install paths: the browser writes the USB
 * image over serial, and a paired controller downloads the app image over
 * HTTPS. Everything that decides compatibility lives on the server; the console
 * only renders what it is told.
 */

export type ReleaseStatus = 'draft' | 'published' | 'archived';
export type ReleaseChannel = 'stable' | 'beta' | 'dev';
export type ArtifactKind = 'app' | 'factory';

export interface FirmwareRelease {
  id: string;
  name: string;
  description: string | null;
  version: string;
  channel: ReleaseChannel | string;
  chip_family: string;
  chip_family_target: string | null;
  board_models: string[];
  storage_backend: string;
  size_bytes: number;
  sha256: string;
  status: ReleaseStatus | string;
  artifact_kind: ArtifactKind | string;
  checksum_verified: boolean;
  artifact_verified: boolean;
  ota_eligible: boolean;
  signature: string | null;
  signature_alg: string | null;
  signed_at: string | null;
  release_notes: string | null;
  mandatory: boolean;
  downloads: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  archived_at: string | null;
  verification_detail?: {
    image?: {
      chipFamily: string | null;
      appVersion: string;
      projectName: string;
      idfVersion: string;
      checksumOk: boolean;
      size: number;
    };
    problems?: string[];
    checked_at?: string;
  };
  deployments: number;
  successful: number;
  failed: number;
  pending: number;
}

export interface UpdateHistoryRow {
  id: string;
  release_id: string | null;
  board_id: string | null;
  board_name: string | null;
  tenant_name: string | null;
  from_version: string | null;
  to_version: string | null;
  status: string;
  progress: number | null;
  error: string | null;
  source: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface ControllerEntry {
  id: string;
  name: string;
  device_id: string;
  status: string;
  last_seen_at: string | null;
  catalog_board_id: string | null;
  board_label: string | null;
  chip_family: string | null;
  installed_version: string | null;
  latest: {
    id: string;
    version: string;
    notes: string | null;
    size_bytes: number;
    sha256: string;
    signature_present: boolean;
    mandatory: boolean;
    update_available: boolean;
  } | null;
  update: { id: string; status: string; progress: number | null; error: string | null; started_at: string; to_version: string | null } | null;
  last_success_at: string | null;
  last_failure: { id: string; status: string; error: string | null; finished_at: string | null; to_version: string | null } | null;
  rollback: { available: boolean; version: string | null; reason: string | null };
}

export interface BoardCompatibility {
  controller_id: string;
  name: string;
  chip_family: string | null;
  installed_version: string | null;
  compatible: boolean;
  reason: string | null;
  update_available: boolean;
}

export interface OwnerFirmwareOverview {
  releases: FirmwareRelease[];
  history: UpdateHistoryRow[];
  controllers: Array<{
    id: string; name: string; catalog_board_id: string | null; chip_family: string | null;
    firmware_version: string | null; status: string; tenant_name: string | null;
    last_seen_at: string | null;
  }>;
  board_catalog: Array<{ id: string; manufacturer: string; model: string; chip_family: string; variant?: string | null }>;
  storage: { backend: string; connected: boolean; r2_configured?: boolean; last_test?: any };
  limits: {
    max_bytes: number; allowed_extensions: string[];
    package_max_bytes: number; package_extensions: string[];
  };
  signing: {
    configured: boolean; algorithm: string; public_key_suffix: string | null; note: string;
  };
}

/** Result of POST /api/owner/firmware/upload-package. */
export interface PackageUploadResult {
  ok: boolean;
  status: string;
  version: string;
  channel: string;
  name: string;
  board_models: string[];
  signature: { present: boolean; algorithm: string | null; verified: boolean | null };
  checks: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  problems: string[];
  releases: Array<{ id: string | null; kind: 'app' | 'factory'; sha256: string; size_bytes: number }>;
}

export interface PublishReadiness {
  ready: boolean;
  blockers: string[];
  checks: Array<{ id: string; label: string; ok: boolean; detail: string }>;
}

/** What the owner still has to do before a release may be published. */
export function publishReadiness(release: FirmwareRelease | null | undefined): PublishReadiness {
  if (!release) return { ready: false, blockers: ['Choose a release'], checks: [] };
  const checks = [
    { id: 'artifact', label: 'Artifact verified', ok: !!release.artifact_verified,
      detail: release.artifact_verified ? 'Structure, length and appended SHA-256 match' : 'The uploaded image failed validation' },
    { id: 'checksum', label: 'Checksum recorded', ok: (release.sha256 || '').length === 64,
      detail: release.sha256 ? `SHA-256 ${release.sha256.slice(0, 16)}…` : 'No checksum' },
    { id: 'boards', label: 'Board compatibility', ok: (release.board_models || []).length > 0,
      detail: (release.board_models || []).length ? `${release.board_models.length} board model(s)` : 'No controller model can install this' },
    { id: 'size', label: 'Fits the OTA slot', ok: (release.size_bytes || 0) > 0 && release.size_bytes <= 3 * 1024 * 1024,
      detail: `${Math.round((release.size_bytes || 0) / 1024)} KB of a 3 MB slot` },
    { id: 'signature', label: 'Signature attached', ok: !!release.signature,
      detail: release.signature ? `${release.signature_alg || 'signature'} · ${new Date(release.signed_at || 0).toLocaleDateString()}` : 'Not signed yet' },
  ];
  return { ready: checks.every((c) => c.ok), blockers: checks.filter((c) => !c.ok).map((c) => c.label), checks };
}

export const STATUS_TONE: Record<string, string> = {
  draft: 'warn', published: 'on', archived: '',
};

export function releaseKindLabel(kind: string | undefined): string {
  return kind === 'factory'
    ? 'Factory image — written from 0x0 over USB'
    : 'Application image — over-the-air, or over USB at 0x10000';
}
