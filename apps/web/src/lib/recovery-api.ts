import { apiFetch } from "./api";
import type { RecoveryServerApi } from "./recovery-engine";

const post = <T>(path: string, payload: unknown) => apiFetch<T>(path, {
  method: "POST", body: JSON.stringify(payload),
});
const base = "/api/recovery/sessions";
export const recoveryServerApi: RecoveryServerApi = {
  startSession: (payload) => post(base, payload),
  postDiagnostics: (id, payload) => post(`${base}/${encodeURIComponent(id)}/diagnostics`, payload),
  complete: (id, payload) => post(`${base}/${encodeURIComponent(id)}/complete`, payload),
  abandon: async (id, reason) => { await post(`${base}/${encodeURIComponent(id)}/abandon`, { reason }); },
};
