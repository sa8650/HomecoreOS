/**
 * Smart Home Planner — (4) firmware compatibility evaluation.
 *
 * Decides, for one board, what firmware HomecoreOS actually has for it. Hardware
 * compatibility reuses evaluateReleaseCompatibilityForBoard() and the same
 * "explicitly targeted or firmware_supported" rule the OTA and Board Library
 * code paths apply. On top of that it separates three things that must never be
 * blurred together:
 *
 *   - a release is technically compatible,
 *   - that release is published,
 *   - a real USB / OTA artifact exists to install.
 *
 * A board is only "installable" when all three hold.
 */
import {
  evaluateReleaseCompatibilityForBoard,
  resolveBoardFirmwareCompatibility,
} from "../board-firmware-compat";
import { compareFirmwareVersions } from "../index";
import type {
  PlannerBoardRecord,
  PlannerFirmwareEvaluation,
  PlannerFirmwareReleaseRecord,
  PlannerFirmwareState,
  PlannerInstallationStatus,
} from "./types";

export const PLANNER_FIRMWARE_STATE_LABELS: Record<PlannerFirmwareState, string> = {
  published_available: "Published and available",
  compatible_release_found: "Compatible release found",
  build_pending: "Build pending",
  build_failed: "Build failed",
  deprecated: "Deprecated",
  no_compatible_release: "No compatible release",
};

/** Higher is closer to "the customer can install this today". */
const STATE_PRIORITY: Record<PlannerFirmwareState, number> = {
  published_available: 5,
  compatible_release_found: 4,
  build_pending: 3,
  build_failed: 2,
  deprecated: 1,
  no_compatible_release: 0,
};

export function plannerFirmwareStateRank(state: PlannerFirmwareState): number {
  return STATE_PRIORITY[state];
}

function hasArtifact(release: PlannerFirmwareReleaseRecord, fileType: string): boolean {
  return (release.files ?? []).some((f) => f.file_type === fileType && f.validated !== false);
}

/** A USB factory image exists: the release says so AND a validated file row backs it. */
export function plannerReleaseHasUsbImage(release: PlannerFirmwareReleaseRecord): boolean {
  return Boolean(release.usb_available) && hasArtifact(release, "usb_factory");
}

/** An OTA image exists: the release says so AND a validated file row backs it. */
export function plannerReleaseHasOtaImage(release: PlannerFirmwareReleaseRecord): boolean {
  return Boolean(release.ota_available) && hasArtifact(release, "ota_app");
}

/** Lifecycle state of one release, or null when it should be ignored entirely. */
export function classifyPlannerReleaseState(
  release: PlannerFirmwareReleaseRecord
): PlannerFirmwareState | null {
  switch (release.status) {
    case "published":
      return plannerReleaseHasUsbImage(release) || plannerReleaseHasOtaImage(release)
        ? "published_available"
        : "compatible_release_found";
    case "deprecated":
      return "deprecated";
    case "draft":
      if (release.build_status === "pending" || release.build_status === "building") {
        return "build_pending";
      }
      if (release.build_status === "failed") return "build_failed";
      return "compatible_release_found";
    default:
      // Archived (or unknown) releases are no longer offered to anyone.
      return null;
  }
}

/** Same verification predicate syncBoardFirmwareStatuses() uses. */
function releaseVerifiedForBoard(
  release: PlannerFirmwareReleaseRecord,
  board: PlannerBoardRecord
): boolean {
  if (board.source === "custom") return false;
  return (
    Boolean(release.hardware_verified) ||
    (release.verified_board_ids ?? []).includes(board.id) ||
    (release.verified_board_slugs ?? []).includes(board.slug)
  );
}

export function isPlannerReleaseCompatibleWithBoard(
  release: PlannerFirmwareReleaseRecord,
  board: PlannerBoardRecord
): { compatible: boolean; reasons: string[]; warnings: string[] } {
  const hasExplicitBoards =
    (release.compatible_board_ids?.length ?? 0) > 0 ||
    (release.compatible_board_slugs?.length ?? 0) > 0;

  if (board.source === "custom" && hasExplicitBoards) {
    return {
      compatible: false,
      reasons: ["This release is validated for specific catalog boards, not for custom boards."],
      warnings: [],
    };
  }

  const base = evaluateReleaseCompatibilityForBoard({
    release: {
      chip_family: release.chip_family,
      status: release.status,
      target_board_slug: release.target_board_slug,
      compatible_board_ids: release.compatible_board_ids,
      compatible_board_slugs: release.compatible_board_slugs,
      partition_scheme: release.partition_scheme,
      psram_mode: release.psram_mode,
      flash_size_mb: release.flash_size_mb,
      files: (release.files ?? []).map((f) => ({ flash_size: f.flash_size ?? null })),
    },
    board: { ...board, ...resolveBoardFirmwareCompatibility(board) },
  });
  if (!base.compatible) return base;

  // A chip-wide release only applies to boards the platform marks as supported
  // (mirrors checkControllerReleaseCompatibility in the Worker).
  if (
    !hasExplicitBoards &&
    board.firmware_status !== "custom" &&
    board.firmware_status !== "firmware_supported"
  ) {
    return {
      compatible: false,
      reasons: [
        `${board.manufacturer} ${board.model} needs a firmware release that targets this board specifically.`,
      ],
      warnings: base.warnings,
    };
  }
  return base;
}

const CHANNEL_RANK: Record<string, number> = { stable: 0, beta: 1, development: 2 };

interface Candidate {
  release: PlannerFirmwareReleaseRecord;
  state: PlannerFirmwareState;
  usb: boolean;
  ota: boolean;
  verified: boolean;
  warnings: string[];
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.usb !== b.usb) return a.usb ? -1 : 1;
  if (a.verified !== b.verified) return a.verified ? -1 : 1;
  const channelDiff = (CHANNEL_RANK[a.release.channel] ?? 3) - (CHANNEL_RANK[b.release.channel] ?? 3);
  if (channelDiff !== 0) return channelDiff;
  const versionDiff = compareFirmwareVersions(b.release.version, a.release.version);
  if (versionDiff !== 0) return versionDiff;
  if (a.ota !== b.ota) return a.ota ? -1 : 1;
  const dateDiff = (b.release.published_at ?? "").localeCompare(a.release.published_at ?? "");
  if (dateDiff !== 0) return dateDiff;
  return a.release.id.localeCompare(b.release.id);
}

export function evaluatePlannerFirmware(
  board: PlannerBoardRecord,
  releases: PlannerFirmwareReleaseRecord[]
): PlannerFirmwareEvaluation {
  const candidates: Candidate[] = [];
  for (const release of releases) {
    const state = classifyPlannerReleaseState(release);
    if (!state) continue;
    const compat = isPlannerReleaseCompatibleWithBoard(release, board);
    if (!compat.compatible) continue;
    candidates.push({
      release,
      state,
      usb: plannerReleaseHasUsbImage(release),
      ota: plannerReleaseHasOtaImage(release),
      verified: releaseVerifiedForBoard(release, board),
      warnings: compat.warnings,
    });
  }

  let state: PlannerFirmwareState = "no_compatible_release";
  for (const candidate of candidates) {
    if (STATE_PRIORITY[candidate.state] > STATE_PRIORITY[state]) state = candidate.state;
  }

  // The Board Library's own "Build Pending" flag counts even before a release row exists.
  const flaggedPending = state === "no_compatible_release" && board.firmware_status === "build_pending";
  if (flaggedPending) state = "build_pending";

  const selected = candidates.filter((c) => c.state === state).sort(compareCandidates)[0] ?? null;
  const published = state === "published_available";
  const usb = published && Boolean(selected?.usb);
  const ota = published && Boolean(selected?.ota);
  const releaseHardwareVerified = Boolean(selected?.verified);
  const version = selected ? `v${selected.release.version.replace(/^v/i, "")}` : "";
  const boardName = `${board.manufacturer} ${board.model}`.trim();

  let detail: string;
  switch (state) {
    case "published_available":
      detail = `${selected!.release.name} ${version} (${selected!.release.channel}) is published for ${boardName}.`;
      break;
    case "compatible_release_found":
      detail =
        selected!.release.status === "published"
          ? `Firmware ${version} matches ${boardName}, but the release has no installable files attached.`
          : `Firmware ${version} matches ${boardName}, but it has not been published yet.`;
      break;
    case "build_pending":
      detail = selected
        ? `Firmware ${version} for ${boardName} is still being built.`
        : `${boardName} is marked "Build Pending" in the Board Library. No release exists yet.`;
      break;
    case "build_failed":
      detail = `The firmware build ${version} for ${boardName} failed, so nothing can be installed yet.`;
      break;
    case "deprecated":
      detail = `The only firmware that matches ${boardName} (${version}) has been deprecated by an administrator.`;
      break;
    default:
      detail =
        board.firmware_status === "firmware_supported"
          ? `${boardName} is supported by HomecoreOS firmware, but no release is currently published for it.`
          : `HomecoreOS has no firmware release that matches ${boardName}.`;
  }

  const notes = selected ? [...selected.warnings] : [];
  if (published && !releaseHardwareVerified && board.source !== "custom") {
    notes.push(
      board.firmware_status === "firmware_supported"
        ? "This release is not individually marked hardware-verified; the board itself is flagged as firmware supported."
        : "This release has not been marked hardware-verified on this board."
    );
  }

  return {
    state,
    label: PLANNER_FIRMWARE_STATE_LABELS[state],
    detail,
    release: selected
      ? {
          // Unpublished releases stay anonymous: only their version and channel are shown.
          id: published ? selected.release.id : null,
          name: published ? selected.release.name : null,
          version: selected.release.version,
          channel: selected.release.channel,
          publishedAt: published ? selected.release.published_at : null,
        }
      : null,
    published,
    installable: published && usb,
    usbFactoryAvailable: usb,
    otaAvailable: ota,
    validatedForBoard:
      published && (releaseHardwareVerified || board.firmware_status === "firmware_supported"),
    releaseHardwareVerified,
    compatibleReleaseCount: candidates.length,
    otherStates: Array.from(new Set(candidates.map((c) => c.state)))
      .filter((s) => s !== state)
      .sort((a, b) => STATE_PRIORITY[b] - STATE_PRIORITY[a]),
    notes,
  };
}

export function describePlannerInstallation(
  firmware: PlannerFirmwareEvaluation
): PlannerInstallationStatus {
  const version = firmware.release ? `v${firmware.release.version.replace(/^v/i, "")}` : null;
  const unavailableReason = firmware.published
    ? `Release ${version} does not include this file.`
    : "No published firmware release exists for this board.";

  return {
    usbFactory: {
      available: firmware.usbFactoryAvailable,
      label: firmware.usbFactoryAvailable
        ? "USB factory image available"
        : "USB factory image unavailable",
      detail: firmware.usbFactoryAvailable
        ? `A new board can be flashed over USB with release ${version} from Firmware & Updates.`
        : `${unavailableReason} A brand-new board cannot be flashed through HomecoreOS without it.`,
    },
    ota: {
      available: firmware.otaAvailable,
      label: firmware.otaAvailable ? "OTA image available" : "OTA image unavailable",
      detail: firmware.otaAvailable
        ? `Controllers already running HomecoreOS can update wirelessly to release ${version}.`
        : `${unavailableReason} Wireless updates will not be possible until an OTA image is published.`,
    },
  };
}
