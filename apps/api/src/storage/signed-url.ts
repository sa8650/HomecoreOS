import { hmacHex } from '../crypto';

/**
 * Short-lived, HMAC-signed download path served by the API. The bucket itself
 * is never public: browsers only ever receive this expiring URL.
 */
export async function signedPath(secret: string, publicBase: string, key: string, expiresSeconds: number) {
  const expires = Math.floor(Date.now() / 1000) + expiresSeconds;
  const sig = await hmacHex(secret, `${key}\n${expires}`);
  const base = publicBase.replace(/\/$/, '');
  return `${base}/api/firmware/download/${encodeURIComponent(btoa(key))}?expires=${expires}&sig=${sig}`;
}
