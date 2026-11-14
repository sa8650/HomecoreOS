import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../src/lib/db";
import {
  generateSixDigitPairingCode,
  hashPassword,
  sha256Hex,
  verifyPassword,
} from "../src/lib/crypto";
import { createPglitePostgrest, type PgliteHarness } from "./helpers/pglite-postgrest";

describe("Argon2id crypto and PostgreSQL schema migrations", () => {
  let dbHarness: PgliteHarness;

  beforeAll(async () => {
    dbHarness = await createPglitePostgrest();
  });

  afterAll(async () => {
    await dbHarness.close();
  });

  it("hashes and verifies passwords using Argon2id PHC strings", async () => {
    const hash = await hashPassword("Homecore-Secure-123!");
    expect(hash.startsWith("$argon2id$v=19$m=4096,t=2,p=1$")).toBe(true);
    expect(await verifyPassword(hash, "Homecore-Secure-123!")).toBe(true);
    expect(await verifyPassword(hash, "WrongPassword-123!")).toBe(false);
  });

  it("generates uniform 6-digit pairing codes and SHA-256 digests", async () => {
    const code = generateSixDigitPairingCode();
    expect(code).toMatch(/^\d{6}$/);
    const digest = await sha256Hex(code);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("applies migrations with RLS disabled and seeds ESP32-S3 N16R8 + platform_settings", async () => {
    const rlsCheck = await dbHarness.pg.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`
    );
    expect(rlsCheck.rows.length).toBeGreaterThanOrEqual(24);
    for (const row of rlsCheck.rows) {
      expect(row.relrowsecurity).toBe(false);
    }

    const db = createDbClient(
      {
        SUPABASE_URL: "https://test-project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-0123456789abcdef",
      },
      dbHarness.fetch
    );

    const { data: settings, error: settingsErr } = await db
      .from("platform_settings")
      .select("*")
      .single();
    expect(settingsErr).toBeNull();
    expect(settings.pairing_code_expiration_seconds).toBe(300);

    const { data: board, error: boardErr } = await db
      .from("board_catalog")
      .select("*")
      .eq("slug", "esp32-s3-devkitc-1-n16r8")
      .single();
    expect(boardErr).toBeNull();
    expect(board.flash_size_mb).toBe(16);
    expect(board.psram_size_mb).toBe(8);

    const { data: gpios, error: gpioErr } = await db
      .from("board_gpio_definitions")
      .select("pin")
      .eq("board_catalog_id", board.id);
    expect(gpioErr).toBeNull();
    expect(gpios?.length).toBe(45); // 0..48 excluding 22..25
  });
});
