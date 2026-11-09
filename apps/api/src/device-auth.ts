/**
 * Device identity helpers shared by the API routes.
 *
 * A controller proves who it is with its own MQTT identity: the client id is
 * public, the password is the secret. Password hashes live in PostgreSQL
 * (`rpc_auth_*`), never in the frontend and never inside firmware.
 */
import type { Runtime } from './services/runtime';
import { verifyPassword } from './crypto';

export interface DeviceRecord {
  board_id: string;
  tenant_id: string;
  device_id: string;
  username: string;
  password_hash: string;
  credential_status: string;
  board_status: string;
  topics: Record<string, string>;
}

export async function hashDevicePassword(rt: Runtime, password: string): Promise<string> {
  return rt.db.rpc<string>('rpc_auth_hash_secret', { p_secret: password });
}

export async function verifyDevicePassword(rt: Runtime, password: string, hash: string): Promise<boolean> {
  if (String(hash || '').startsWith('pbkdf2$')) return verifyPassword(password, hash);
  try {
    return !!(await rt.db.rpc<any>('rpc_auth_verify_secret', { p_secret: password, p_hash: hash }));
  } catch {
    return false;
  }
}

/** Resolve a controller from its client id and prove the password matches. */
export async function authenticateDevice(
  rt: Runtime, clientId: string, password: string,
): Promise<DeviceRecord | null> {
  const info = await rt.db.rpc<DeviceRecord | null>('rpc_board_from_client', { p_client_id: clientId });
  if (!info || info.credential_status !== 'active') return null;
  if (info.board_status === 'disabled') return null;
  if (!password) return null;
  if (!(await verifyDevicePassword(rt, password, info.password_hash))) return null;
  return info;
}

export const HARDWARE_FIELDS: [string, number][] = [
  ['chip_family', 40], ['chip_model', 40], ['chip_revision', 20], ['mac_address', 24],
  ['sdk_version', 60], ['fw_build', 80], ['firmware_version', 40], ['hardware_revision', 60],
  ['board_id', 80],
];

/** Only known, length-bounded hardware fields are stored — nothing is trusted blindly. */
export function sanitizeHardware(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, max] of HARDWARE_FIELDS) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    out[key] = text.slice(0, max);
  }
  for (const [key, limit] of [['rssi', 0], ['uptime_seconds', 0]] as [string, number][]) {
    void limit;
    const value = source[key];
    if (value !== undefined && Number.isFinite(Number(value))) out[key] = Math.round(Number(value));
  }
  return out;
}

/**
 * Source address of the caller. Behind Cloudflare this is the CF-Connecting-IP
 * header; there is no plausible fallback (every request would share one bucket),
 * so an empty value is reported as unknown and rate limited as such.
 */
export function requestIp(c: any): string {
  const ip = (String(c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '').split(',')[0] || '').trim();
  return ip || 'unknown';
}

/** Pairing failures are counted per address; clearing is an explicit action. */
export async function resetPairingFailures(rt: Runtime, ip: string) {
  await rt.db.rpc('rpc_pairing_address_reset', { p_ip: ip }).catch(() => {});
}

/** Absolute HTTPS origin of the current request, used for device-facing URLs. */
export function originOf(c: any): string {
  return new URL(c.req.url).origin;
}
