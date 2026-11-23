/**
 * Small display helpers shared by the web console.
 *
 * These are pure formatting rules ("1 device" vs "3 devices"), so they live in
 * the shared package instead of being copied per screen — three planner views
 * had drifted copies of the same function.
 */

/** `plural(1, "device")` → "1 device"; `plural(3, "device")` → "3 devices". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
