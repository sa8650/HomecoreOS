/**
 * Smart Home Planner — catalog fingerprint for cache invalidation.
 *
 * A cached recommendation is only valid for the exact board and firmware records
 * it was computed from. This module turns those records into one canonical
 * string; the Worker hashes it into a revision that is stored with every cached
 * recommendation. When an administrator publishes a board, verifies a pin map,
 * uploads firmware or deprecates a release through the existing admin pages,
 * the string changes, the revision no longer matches, and the cache is dropped.
 *
 * It needs no hooks in the admin code: any change, by any code path, is seen.
 */
import { PLANNER_ENGINE_VERSION, type PlannerCatalogSnapshot } from "./types";

/**
 * JSON with sorted object keys. Keys holding null or undefined are omitted so
 * `{ a: null }`, `{ a: undefined }` and `{}` all fingerprint identically.
 */
export function stablePlannerStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") {
    return typeof value === "number" && !Number.isFinite(value) ? "null" : JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stablePlannerStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== null && record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stablePlannerStringify(record[key])}`).join(",")}}`;
}

function sortedStrings(values: readonly string[] | null | undefined): string[] {
  return [...(values ?? [])].sort();
}

/**
 * Canonical text of everything the planner reads. Record order and the order of
 * id / slug lists do not matter; any difference in content does.
 */
export function buildPlannerCatalogRevisionSource(
  snapshot: Omit<PlannerCatalogSnapshot, "revision">
): string {
  const boards = [...snapshot.boards]
    .sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id))
    .map((board) => ({
      ...board,
      gpio_definitions: [...(board.gpio_definitions ?? [])].sort((a, b) => a.pin - b.pin),
    }));

  const releases = [...snapshot.releases]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((release) => ({
      ...release,
      compatible_board_ids: sortedStrings(release.compatible_board_ids),
      compatible_board_slugs: sortedStrings(release.compatible_board_slugs),
      verified_board_ids: sortedStrings(release.verified_board_ids),
      verified_board_slugs: sortedStrings(release.verified_board_slugs),
      files: [...(release.files ?? [])]
        .map((file) => ({
          file_type: file.file_type,
          validated: file.validated,
          flash_size: file.flash_size ?? null,
        }))
        .sort((a, b) => stablePlannerStringify(a).localeCompare(stablePlannerStringify(b))),
    }));

  return stablePlannerStringify({
    engine: PLANNER_ENGINE_VERSION,
    boardCatalogEnabled: snapshot.boardCatalogEnabled,
    account: snapshot.account,
    boards,
    releases,
  });
}
