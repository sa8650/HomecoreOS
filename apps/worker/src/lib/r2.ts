import { requireFirmwareBucket, type WorkerBindings } from "../config/env";
import { sha256Hex } from "./crypto";

export async function putFirmwareObject(
  env: WorkerBindings,
  key: string,
  bytes: Uint8Array,
  metadata: Record<string, string>
): Promise<{ sha256: string; sizeBytes: number }> {
  const bucket = requireFirmwareBucket(env);
  const sha256 = await sha256Hex(bytes);
  await bucket.put(key, bytes, {
    httpMetadata: {
      contentType: "application/octet-stream",
    },
    customMetadata: {
      ...metadata,
      sha256,
    },
  });
  return { sha256, sizeBytes: bytes.byteLength };
}

export async function getFirmwareObject(
  env: WorkerBindings,
  key: string,
  options?: R2GetOptions
): Promise<R2ObjectBody | null> {
  const bucket = requireFirmwareBucket(env);
  return options ? bucket.get(key, options) : bucket.get(key);
}

export async function deleteFirmwareObject(
  env: WorkerBindings,
  key: string
): Promise<void> {
  const bucket = requireFirmwareBucket(env);
  await bucket.delete(key);
}

export async function checkR2Health(env: WorkerBindings): Promise<{
  status: "connected" | "not_configured" | "failed";
  objectCount?: number;
  totalBytes?: number;
  error?: string;
}> {
  if (!env.FIRMWARE_BUCKET) {
    return { status: "not_configured" };
  }
  try {
    const listed = await env.FIRMWARE_BUCKET.list({ limit: 100 });
    let totalBytes = 0;
    for (const obj of listed.objects) {
      totalBytes += obj.size;
    }
    return {
      status: "connected",
      objectCount: listed.objects.length,
      totalBytes,
    };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "R2 access failed",
    };
  }
}
