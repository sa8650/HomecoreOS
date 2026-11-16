export interface WorkerBindings {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  EMQX_API_BASE?: string;
  EMQX_APP_ID?: string;
  EMQX_APP_SECRET?: string;
  EMQX_BROKER_HOST?: string;
  EMQX_TLS_PORT?: string;
  FIRMWARE_BUCKET?: R2Bucket;
  ASSETS?: Fetcher;
}

export interface ConfigValidationEntry {
  key:
    | "SUPABASE_URL"
    | "SUPABASE_SERVICE_ROLE_KEY"
    | "EMQX_API_BASE"
    | "EMQX_APP_ID"
    | "EMQX_APP_SECRET"
    | "EMQX_BROKER_HOST"
    | "EMQX_TLS_PORT"
    | "FIRMWARE_BUCKET";
  kind: "variable" | "secret" | "binding";
  configured: boolean;
  valid: boolean;
  status: "connected" | "not_configured" | "configuration_required";
  message: string;
}

export interface ValidatedSupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

export interface ValidatedEmqxConfig {
  apiBase: string;
  appId: string;
  appSecret: string;
  brokerHost: string;
  tlsPort: number;
}

function nonEmpty(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isValidHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

export function normalizeEmqxApiBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/api/v5")) return trimmed;
  return `${trimmed}/api/v5`;
}

export function inspectConfiguration(env: WorkerBindings): {
  entries: ConfigValidationEntry[];
  missingKeys: string[];
  invalidKeys: string[];
  supabaseReady: boolean;
  emqxReady: boolean;
  r2Ready: boolean;
} {
  const supabaseUrl = nonEmpty(env.SUPABASE_URL);
  const supabaseKey = nonEmpty(env.SUPABASE_SERVICE_ROLE_KEY);
  const emqxApiBase = nonEmpty(env.EMQX_API_BASE);
  const emqxAppId = nonEmpty(env.EMQX_APP_ID);
  const emqxAppSecret = nonEmpty(env.EMQX_APP_SECRET);
  const emqxBrokerHost = nonEmpty(env.EMQX_BROKER_HOST);
  const emqxTlsPortRaw = nonEmpty(env.EMQX_TLS_PORT);
  const parsedPort = emqxTlsPortRaw ? Number(emqxTlsPortRaw) : NaN;
  const validPort = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535;
  const hasR2 = Boolean(env.FIRMWARE_BUCKET);

  const entries: ConfigValidationEntry[] = [
    {
      key: "SUPABASE_URL",
      kind: "variable",
      configured: supabaseUrl !== null,
      valid: supabaseUrl !== null && isValidHttpsUrl(supabaseUrl),
      status:
        supabaseUrl === null
          ? "not_configured"
          : isValidHttpsUrl(supabaseUrl)
            ? "connected"
            : "configuration_required",
      message:
        supabaseUrl === null
          ? "Missing SUPABASE_URL Worker variable."
          : isValidHttpsUrl(supabaseUrl)
            ? "Configured HTTPS Supabase endpoint."
            : "SUPABASE_URL must be a valid HTTPS URL.",
    },
    {
      key: "SUPABASE_SERVICE_ROLE_KEY",
      kind: "secret",
      configured: supabaseKey !== null,
      valid: supabaseKey !== null && supabaseKey.length >= 20,
      status:
        supabaseKey === null
          ? "not_configured"
          : supabaseKey.length >= 20
            ? "connected"
            : "configuration_required",
      message:
        supabaseKey === null
          ? "Missing SUPABASE_SERVICE_ROLE_KEY Worker secret."
          : supabaseKey.length >= 20
            ? "Secret present (value hidden)."
            : "SUPABASE_SERVICE_ROLE_KEY appears malformed.",
    },
    {
      key: "EMQX_API_BASE",
      kind: "variable",
      configured: emqxApiBase !== null,
      valid: emqxApiBase !== null && isValidHttpsUrl(emqxApiBase),
      status:
        emqxApiBase === null
          ? "not_configured"
          : isValidHttpsUrl(emqxApiBase)
            ? "connected"
            : "configuration_required",
      message:
        emqxApiBase === null
          ? "Missing EMQX_API_BASE Worker variable."
          : isValidHttpsUrl(emqxApiBase)
            ? "Configured HTTPS EMQX API base."
            : "EMQX_API_BASE must be a valid HTTPS URL.",
    },
    {
      key: "EMQX_APP_ID",
      kind: "variable",
      configured: emqxAppId !== null,
      valid: emqxAppId !== null,
      status: emqxAppId === null ? "not_configured" : "connected",
      message:
        emqxAppId === null
          ? "Missing EMQX_APP_ID Worker variable."
          : "Configured EMQX deployment App ID.",
    },
    {
      key: "EMQX_APP_SECRET",
      kind: "secret",
      configured: emqxAppSecret !== null,
      valid: emqxAppSecret !== null && emqxAppSecret.length >= 8,
      status:
        emqxAppSecret === null
          ? "not_configured"
          : emqxAppSecret.length >= 8
            ? "connected"
            : "configuration_required",
      message:
        emqxAppSecret === null
          ? "Missing EMQX_APP_SECRET Worker secret."
          : emqxAppSecret.length >= 8
            ? "Secret present (value hidden)."
            : "EMQX_APP_SECRET appears malformed.",
    },
    {
      key: "EMQX_BROKER_HOST",
      kind: "variable",
      configured: emqxBrokerHost !== null,
      valid:
        emqxBrokerHost !== null &&
        !/\s|[:/]/.test(emqxBrokerHost) &&
        emqxBrokerHost.includes("."),
      status:
        emqxBrokerHost === null
          ? "not_configured"
          : !/\s|[:/]/.test(emqxBrokerHost) && emqxBrokerHost.includes(".")
            ? "connected"
            : "configuration_required",
      message:
        emqxBrokerHost === null
          ? "Missing EMQX_BROKER_HOST Worker variable."
          : !/\s|[:/]/.test(emqxBrokerHost) && emqxBrokerHost.includes(".")
            ? "Configured MQTT TLS broker hostname."
            : "EMQX_BROKER_HOST must be a bare hostname without protocol or port.",
    },
    {
      key: "EMQX_TLS_PORT",
      kind: "variable",
      configured: emqxTlsPortRaw !== null,
      valid: validPort,
      status:
        emqxTlsPortRaw === null
          ? "not_configured"
          : validPort
            ? "connected"
            : "configuration_required",
      message:
        emqxTlsPortRaw === null
          ? "Missing EMQX_TLS_PORT Worker variable (typically 8883)."
          : validPort
            ? "Configured MQTT TLS port."
            : "EMQX_TLS_PORT must be a valid TCP port (1-65535).",
    },
    {
      key: "FIRMWARE_BUCKET",
      kind: "binding",
      configured: hasR2,
      valid: hasR2,
      status: hasR2 ? "connected" : "not_configured",
      message: hasR2
        ? "Private R2 FIRMWARE_BUCKET binding available."
        : "Missing FIRMWARE_BUCKET R2 binding in Worker configuration.",
    },
  ];

  const missingKeys = entries.filter((e) => !e.configured).map((e) => e.key);
  const invalidKeys = entries
    .filter((e) => e.configured && !e.valid)
    .map((e) => e.key);

  const supabaseReady =
    entries.find((e) => e.key === "SUPABASE_URL")!.valid &&
    entries.find((e) => e.key === "SUPABASE_SERVICE_ROLE_KEY")!.valid;

  const emqxReady =
    entries.find((e) => e.key === "EMQX_API_BASE")!.valid &&
    entries.find((e) => e.key === "EMQX_APP_ID")!.valid &&
    entries.find((e) => e.key === "EMQX_APP_SECRET")!.valid &&
    entries.find((e) => e.key === "EMQX_BROKER_HOST")!.valid &&
    entries.find((e) => e.key === "EMQX_TLS_PORT")!.valid;

  return {
    entries,
    missingKeys,
    invalidKeys,
    supabaseReady,
    emqxReady,
    r2Ready: hasR2,
  };
}

export function requireSupabaseConfig(env: WorkerBindings): ValidatedSupabaseConfig {
  const status = inspectConfiguration(env);
  if (!status.supabaseReady) {
    throw new ConfigurationError(
      "Supabase PostgreSQL configuration is missing or invalid.",
      ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(
        (key) => status.missingKeys.includes(key) || status.invalidKeys.includes(key)
      )
    );
  }
  return {
    url: env.SUPABASE_URL!.trim().replace(/\/+$/, ""),
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  };
}

export function requireEmqxConfig(env: WorkerBindings): ValidatedEmqxConfig {
  const status = inspectConfiguration(env);
  if (!status.emqxReady) {
    throw new ConfigurationError(
      "EMQX Serverless configuration is missing or invalid.",
      [
        "EMQX_API_BASE",
        "EMQX_APP_ID",
        "EMQX_APP_SECRET",
        "EMQX_BROKER_HOST",
        "EMQX_TLS_PORT",
      ].filter(
        (key) => status.missingKeys.includes(key) || status.invalidKeys.includes(key)
      )
    );
  }
  return {
    apiBase: normalizeEmqxApiBase(env.EMQX_API_BASE!),
    appId: env.EMQX_APP_ID!.trim(),
    appSecret: env.EMQX_APP_SECRET!.trim(),
    brokerHost: env.EMQX_BROKER_HOST!.trim(),
    tlsPort: Number(env.EMQX_TLS_PORT!.trim()),
  };
}

export function requireFirmwareBucket(env: WorkerBindings): R2Bucket {
  if (!env.FIRMWARE_BUCKET) {
    throw new ConfigurationError(
      "FIRMWARE_BUCKET R2 binding is not configured.",
      ["FIRMWARE_BUCKET"]
    );
  }
  return env.FIRMWARE_BUCKET;
}

export class ConfigurationError extends Error {
  readonly missingOrInvalidKeys: string[];
  constructor(message: string, keys: string[]) {
    super(message);
    this.name = "ConfigurationError";
    this.missingOrInvalidKeys = keys;
  }
}
