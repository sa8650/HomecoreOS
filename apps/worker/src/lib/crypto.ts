import setupWasm from "argon2id/lib/setup.js";
import simdWasm from "argon2id/dist/simd.wasm";
import noSimdWasm from "argon2id/dist/no-simd.wasm";

export const DEFAULT_ARGON2ID_PARAMS = {
  memorySize: 4096, // 4 MiB — safe under Cloudflare Workers Free 10ms CPU budget & 128 MB isolate RAM
  passes: 2,
  parallelism: 1,
  tagLength: 32,
  saltLength: 16,
} as const;

const MAX_VERIFY_MEMORY_KIB = 65536;
const MAX_VERIFY_PASSES = 16;
const MAX_VERIFY_PARALLELISM = 8;

type Argon2idFn = (params: {
  password: Uint8Array;
  salt: Uint8Array;
  parallelism: number;
  passes: number;
  memorySize: number;
  tagLength: number;
}) => Uint8Array;

let argon2InstancePromise: Promise<Argon2idFn> | null = null;
let argon2Queue: Promise<unknown> = Promise.resolve();

async function getArgon2id(): Promise<Argon2idFn> {
  if (!argon2InstancePromise) {
    argon2InstancePromise = setupWasm(
      async (imports: WebAssembly.Imports) => ({
        instance: await WebAssembly.instantiate(simdWasm, imports),
      }),
      async (imports: WebAssembly.Imports) => ({
        instance: await WebAssembly.instantiate(noSimdWasm, imports),
      })
    ).catch((err: unknown) => {
      argon2InstancePromise = null;
      throw err;
    });
  }
  return argon2InstancePromise;
}

function enqueueArgon2<T>(fn: (hasher: Argon2idFn) => T): Promise<T> {
  const next = argon2Queue.then(async () => {
    const hasher = await getArgon2id();
    return fn(hasher);
  });
  argon2Queue = next.catch(() => {});
  return next;
}

function toBase64NoPad(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/=+$/, "");
}

function fromBase64NoPad(b64: string): Uint8Array {
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64NoPad(bytes).replace(/\+/g, "-").replace(/\//g, "_");
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < 8 || password.length > 256) {
    throw new Error("Password must be between 8 and 256 characters.");
  }
  const salt = crypto.getRandomValues(
    new Uint8Array(DEFAULT_ARGON2ID_PARAMS.saltLength)
  );
  const passwordBytes = new TextEncoder().encode(password);

  const digest = await enqueueArgon2((hasher) =>
    hasher({
      password: passwordBytes,
      salt,
      parallelism: DEFAULT_ARGON2ID_PARAMS.parallelism,
      passes: DEFAULT_ARGON2ID_PARAMS.passes,
      memorySize: DEFAULT_ARGON2ID_PARAMS.memorySize,
      tagLength: DEFAULT_ARGON2ID_PARAMS.tagLength,
    })
  );

  return `$argon2id$v=19$m=${DEFAULT_ARGON2ID_PARAMS.memorySize},t=${DEFAULT_ARGON2ID_PARAMS.passes},p=${DEFAULT_ARGON2ID_PARAMS.parallelism}$${toBase64NoPad(salt)}$${toBase64NoPad(digest)}`;
}

export async function verifyPassword(
  phcHash: string,
  password: string
): Promise<boolean> {
  if (!phcHash || !password) return false;
  const parts = phcHash.split("$");
  // Expected: ["", "argon2id", "v=19", "m=...,t=...,p=...", "<salt>", "<hash>"]
  if (parts.length !== 6 || parts[1] !== "argon2id" || parts[2] !== "v=19") {
    return false;
  }

  const paramEntries = Object.fromEntries(
    parts[3]!.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, Number(v)];
    })
  ) as Record<string, number>;

  const memorySize = paramEntries.m;
  const passes = paramEntries.t;
  const parallelism = paramEntries.p;

  if (
    !Number.isInteger(memorySize) ||
    !Number.isInteger(passes) ||
    !Number.isInteger(parallelism) ||
    memorySize < 8 ||
    memorySize > MAX_VERIFY_MEMORY_KIB ||
    passes < 1 ||
    passes > MAX_VERIFY_PASSES ||
    parallelism < 1 ||
    parallelism > MAX_VERIFY_PARALLELISM
  ) {
    return false;
  }

  let salt: Uint8Array;
  let expectedDigest: Uint8Array;
  try {
    salt = fromBase64NoPad(parts[4]!);
    expectedDigest = fromBase64NoPad(parts[5]!);
  } catch {
    return false;
  }

  if (salt.length < 8 || expectedDigest.length < 16) return false;

  const passwordBytes = new TextEncoder().encode(password);
  const actualDigest = await enqueueArgon2((hasher) =>
    hasher({
      password: passwordBytes,
      salt,
      parallelism,
      passes,
      memorySize,
      tagLength: expectedDigest.length,
    })
  );

  return timingSafeEqual(actualDigest, expectedDigest);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export function generateRandomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return toBase64Url(bytes);
}

/**
 * Cryptographically uniform 6-digit numeric pairing code using rejection sampling.
 */
export function generateSixDigitPairingCode(): string {
  const maxValid = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(buf);
    const val = buf[0]!;
    if (val < maxValid) {
      return String(val % 1_000_000).padStart(6, "0");
    }
  }
}

export function generateSlugSuffix(length = 6): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}
