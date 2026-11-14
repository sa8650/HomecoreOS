import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  inspectConfiguration,
  normalizeEmqxApiBase,
  requireEmqxConfig,
  requireFirmwareBucket,
  requireSupabaseConfig,
} from "../src/config/env";

describe("Worker central configuration validator", () => {
  it("reports missing keys clearly without exposing any secret values", () => {
    const result = inspectConfiguration({});
    expect(result.supabaseReady).toBe(false);
    expect(result.emqxReady).toBe(false);
    expect(result.r2Ready).toBe(false);
    expect(result.missingKeys).toEqual([
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "EMQX_API_BASE",
      "EMQX_APP_ID",
      "EMQX_APP_SECRET",
      "EMQX_BROKER_HOST",
      "EMQX_TLS_PORT",
      "FIRMWARE_BUCKET",
    ]);
  });

  it("validates valid Section 11 config and hides secret contents", () => {
    const secretRole = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.example-secret-key-value";
    const secretEmqx = "super-secret-app-secret-value";
    const result = inspectConfiguration({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: secretRole,
      EMQX_API_BASE: "https://abc123.emqxsl.com:8443",
      EMQX_APP_ID: "app_12345",
      EMQX_APP_SECRET: secretEmqx,
      EMQX_BROKER_HOST: "abc123.emqxsl.com",
      EMQX_TLS_PORT: "8883",
      FIRMWARE_BUCKET: {} as R2Bucket,
    });

    expect(result.supabaseReady).toBe(true);
    expect(result.emqxReady).toBe(true);
    expect(result.r2Ready).toBe(true);
    expect(result.missingKeys).toEqual([]);
    expect(result.invalidKeys).toEqual([]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretRole);
    expect(serialized).not.toContain(secretEmqx);
  });

  it("normalizes EMQX API base path to end with /api/v5 once", () => {
    expect(normalizeEmqxApiBase("https://broker.emqxsl.com:8443/")).toBe(
      "https://broker.emqxsl.com:8443/api/v5"
    );
    expect(normalizeEmqxApiBase("https://broker.emqxsl.com:8443/api/v5/")).toBe(
      "https://broker.emqxsl.com:8443/api/v5"
    );
  });

  it("throws ConfigurationError with missing keys when required helpers fail", () => {
    expect(() => requireSupabaseConfig({})).toThrow(ConfigurationError);
    expect(() => requireEmqxConfig({})).toThrow(ConfigurationError);
    expect(() => requireFirmwareBucket({})).toThrow(ConfigurationError);
  });
});
