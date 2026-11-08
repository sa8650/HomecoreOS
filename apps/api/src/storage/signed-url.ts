import { hmacHex } from '../crypto';

/**
 * Short-lived, HMAC-signed download path served by the API.
 *
 * The bucket itself is never public and the page never holds a bucket secret:
 * a browser or a controller receives only this expiring URL, which the API
 * checks again before streaming the bytes.
 */
export async function signedPath(secret: string, publicBase: string, key: string, expiresSeconds: number) {
  const expires = Math.floor(Date.now() / 1000) + expiresSeconds;
  const sig = await hmacHex(secret, `${key}\n${expires}`);
  const base = publicBase.replace(/\/$/, '');
  return `${base}/api/firmware/object/${encodeURIComponent(btoa(key))}?expires=${expires}&sig=${sig}`;
}

/** Constant-time comparison so a signed URL cannot be guessed byte by byte. */
export function signatureMatches(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}
