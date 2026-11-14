import { PostgrestClient } from "@supabase/postgrest-js";
import { requireSupabaseConfig, type WorkerBindings } from "../config/env";

export type DbClient = PostgrestClient;

export type CustomFetch = typeof fetch;

export function createDbClient(
  env: WorkerBindings,
  customFetch?: CustomFetch
): DbClient {
  const { url, serviceRoleKey } = requireSupabaseConfig(env);
  const restUrl = `${url}/rest/v1`;
  const fetchImpl: CustomFetch =
    customFetch ?? ((...args) => globalThis.fetch(...args));

  return new PostgrestClient(restUrl, {
    schema: "public",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    fetch: fetchImpl,
  });
}
