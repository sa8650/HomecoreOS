import { apiFetch } from "./api";
import type { RecoveryServerApi } from "./recovery-engine";

const post = <T>(path: string, payload: unknown) => apiFetch<T>(path, {
  method: "POST", body: JSON.stringify(payload),
});
const base = "/api/recovery/sessions";

/**
 * The server re-runs diagnostics on its own rows, so it needs to know which
 * deployment it is being compared against. Sending the origin lets it flag a
 * controller pointing at a stale server URL — and the answer still comes from
 * the server, never from the browser.
 */
const withOrigin = <T extends object>(payload: T) => ({
  ...payload,
  websiteUrl: typeof window !== "undefined" ? window.location.origin : undefined,
});

export const recoveryServerApi: RecoveryServerApi = {
  startSession: (payload) => post(base, withOrigin(payload)),
  postDiagnostics: (id, payload) => post(`${base}/${encodeURIComponent(id)}/diagnostics`, withOrigin(payload)),
  complete: (id, payload) => post(`${base}/${encodeURIComponent(id)}/complete`, withOrigin(payload)),
  abandon: async (id, reason) => { await post(`${base}/${encodeURIComponent(id)}/abandon`, { reason }); },
};
