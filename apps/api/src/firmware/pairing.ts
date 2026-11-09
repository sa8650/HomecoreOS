/**
 * Six-digit controller pairing.
 *
 * The code is a short-lived bootstrap secret, never a device credential: once
 * redeemed the controller receives its own MQTT identity and the code is dead.
 * Codes come from the platform CSPRNG, keep leading zeros, are stored only as an
 * HMAC bound to the customer, workspace, home and browser session that created
 * them, and are redeemable exactly once inside one transaction.
 */
import type { Runtime } from '../services/runtime';
import { HttpError } from '../context';
import { hmacHex, randomHex, randomToken } from '../crypto';
import { deviceTopics } from '@homecoreos/core';
import { hashDevicePassword, sanitizeHardware } from '../device-auth';

export const CODE_TTL_SECONDS = 300;
export const MAX_CODE_ATTEMPTS = 5;

export interface IssuedCode {
  id: string;
  code: string;
  expiresAt: string;
  secondsLeft: number;
}

/** Uniform six digits, leading zeros preserved, from the platform CSPRNG. */
export function generatePairingCode(): string {
  const limit = 1_000_000;
  const max = Math.floor(0x1_0000_0000 / limit) * limit;
  const buffer = new Uint32Array(1);
  let value = 0;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0]!;
  } while (value >= max);
  return String(value % limit).padStart(6, '0');
}

export function codeDigest(signingKey: string, code: string): Promise<string> {
  return hmacHex(signingKey, `pairing-code:v1:${code}`);
}

export async function issuePairingSession(rt: Runtime, input: {
  actorProfileId: string;
  tenantId: string;
  sessionId: string;
  ip: string;
  catalogBoardId: string | null;
  boardName: string | null;
  homeName: string | null;
  /** Set for a re-pair: the existing, unclaimed controller record this code may restore. */
  userBoardId?: string | null;
}): Promise<IssuedCode> {
  if (!rt.env.SIGNING_KEY) throw new HttpError(503, 'The server signing key is not available');
  const code = generatePairingCode();
  const digest = await codeDigest(rt.env.SIGNING_KEY, code);
  const result: any = await rt.db.rpc('rpc_pairing_issue', {
    p_actor: input.actorProfileId,
    p_tenant: input.tenantId,
    p_code_hmac: digest,
    p_session: input.sessionId,
    p_ip: input.ip,
    p_data: {
      catalog_board_id: input.catalogBoardId,
      board_name: input.boardName,
      home_name: input.homeName,
      ttl_seconds: CODE_TTL_SECONDS,
      ...(input.userBoardId ? { user_board_id: input.userBoardId } : {}),
    },
  }).catch((e: any) => {
    const message = String(e?.message || '');
    // Two limits share the same error code. Say which one applies, so the person knows
    // whether to cancel an open setup or to wait.
    if (/Too many open/i.test(message)) {
      throw new HttpError(429, 'Too many pairing codes are open. Finish or cancel a current setup first.');
    }
    if (/rate limit/i.test(message)) {
      throw new HttpError(429, 'Too many controllers were added recently. Try again in a little while.');
    }
    if (/42901/.test(message)) {
      throw new HttpError(429, 'Too many pairing codes. Try again in a little while.');
    }
    if (/disabled for this workspace/i.test(message)) {
      throw new HttpError(403, 'Adding controllers is turned off for this home');
    }
    if (/Unknown board/i.test(message)) throw new HttpError(400, 'Unknown controller model');
    throw new HttpError(400, 'The pairing code could not be created');
  });
  return {
    id: String(result.id),
    code,
    expiresAt: String(result.expires_at),
    secondsLeft: Number(result.expires_in_seconds) || CODE_TTL_SECONDS,
  };
}

export interface RedeemOutcome {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Redeem a code for a controller. Broker credentials are provisioned first, so a
 * broker failure never leaves a half-registered controller in the database.
 */
export async function redeemPairingCode(rt: Runtime, input: {
  code: unknown;
  ip: string;
  hardware: unknown;
  windowOpen?: boolean;
}): Promise<RedeemOutcome> {
  const raw = String(input.code ?? '').trim();
  if (!input.windowOpen) {
    return {
      status: 409,
      body: { error: 'No pairing window is open. Press "Get a new code" on the website first.' },
    };
  }
  if (!/^[0-9]{6}$/.test(raw)) {
    return { status: 400, body: { error: 'Enter all six digits of the pairing code.' } };
  }
  if (!rt.env.SIGNING_KEY) return { status: 503, body: { error: 'Server configuration is incomplete.' } };

  const ipState: any = await rt.db.rpc('rpc_pairing_record_failure', { p_ip: input.ip })
    .catch((e: any) => (/42902|Too many incorrect/i.test(String(e?.message || '')) ? { locked: true } : {}));
  if (ipState?.locked) {
    return { status: 429, body: { error: 'Too many incorrect codes. Wait ten minutes before trying again.' } };
  }

  const digest = await codeDigest(rt.env.SIGNING_KEY, raw);
  const rows = await rt.db.select('device_pairing_tokens', { eq: { code_hmac: digest }, limit: 1 });
  const session: any = rows[0];
  if (!session) return { status: 401, body: { error: 'That pairing code is not valid. Check the six digits.' } };
  if (session.consumed_at) {
    return { status: 409, body: { error: 'That pairing code has already been used.' } };
  }
  if (session.revoked_at) return { status: 410, body: { error: 'That pairing code was cancelled.' } };
  if (session.expires_at && new Date(session.expires_at).getTime() <= Date.now()) {
    return { status: 410, body: { error: 'That pairing code has expired. Create a new one.' } };
  }
  if (session.locked_until && new Date(session.locked_until).getTime() > Date.now()) {
    return { status: 429, body: { error: 'Too many attempts on this code. Create a new one.' } };
  }
  if (Number(session.failed_attempts) >= MAX_CODE_ATTEMPTS) {
    return { status: 429, body: { error: 'Too many attempts on this code. Create a new one.' } };
  }

  // A re-pair code is bound to one existing controller record. That record keeps its
  // device ID; only its broker identity is new. A fresh code gets a new device ID.
  let deviceId = `hcd-${randomHex(6)}`;
  if (session.user_board_id) {
    const records = await rt.db.select<any>('user_boards', { eq: { id: session.user_board_id }, limit: 1 });
    if (!records.length || !records[0].device_id || records[0].deleted_at) {
      return { status: 410, body: { error: 'That controller record no longer exists. Create a new code from the Controllers page.' } };
    }
    deviceId = String(records[0].device_id);
  }
  const clientId = `hcc-${randomHex(8)}`;
  const username = `hu-${randomHex(8)}`;
  const password = randomToken(32);
  let providerRef: Record<string, unknown> = {};
  try {
    const credential = await rt.mqtt.provisionDevice({
      username, password, clientId, tenantId: String(session.tenant_id), deviceId,
    });
    providerRef = credential.providerRef;
  } catch (e: any) {
    return {
      status: 502,
      body: {
        error: 'The broker could not create credentials for this controller. Please try again shortly.',
        detail: String(e?.message || e).slice(0, 300),
      },
    };
  }

  const passwordHash = await hashDevicePassword(rt, password);
  let claimed: any;
  try {
    claimed = await rt.db.rpc('rpc_pairing_redeem', {
      p_code_hmac: digest,
      p_board_name: String(session.board_name || 'HomecoreOS controller'),
      p_device_id: deviceId,
      p_client_id: clientId,
      p_username: username,
      p_password_hash: passwordHash,
      p_provider_ref: providerRef,
      p_ip: input.ip,
    });
  } catch (e: any) {
    await rt.mqtt.revokeDevice({ username, clientId }).catch(() => {});
    const message = String(e?.message || '');
    console.error('[pairing] redeem failed:', message.slice(0, 400));
    if (/42902|Too many attempts/i.test(message)) {
      return { status: 429, body: { error: 'Too many attempts. Wait a few minutes and try again.' } };
    }
    if (/already registered|23505/i.test(message)) {
      return { status: 409, body: { error: 'This controller is already registered to a home.' } };
    }
    return { status: 401, body: { error: 'That pairing code can no longer be used. Create a new one.' } };
  }

  const boardId = String(claimed.board_id);
  const tenantId = String(claimed.tenant_id);
  const hardware = sanitizeHardware(input.hardware);
  if (Object.keys(hardware).length) {
    await rt.db.update('user_boards', { id: boardId }, hardware).catch(() => {});
  }
  const configurations = await rt.db.select('device_configurations', {
    eq: { user_board_id: boardId }, order: { column: 'version', ascending: false }, limit: 1,
  });
  const config = (configurations[0] as any)?.config
    ?? { schema_version: 1, board_id: deviceId, config_version: 0, devices: [], sensors: [], buses: [] };

  return {
    status: 201,
    body: {
      board_id: boardId,
      tenant_id: tenantId,
      device_id: deviceId,
      // The controller reports these back over MQTT so the platform can match the
      // report to this exact accepted code and this exact controller.
      controller_id: boardId,
      home_id: tenantId,
      pairing_session_id: String(session.id),
      mqtt: {
        host: String(rt.env.EMQX_BROKER_HOST || ''),
        port: Number(rt.env.EMQX_TLS_PORT || 8883),
        tls: true,
        client_id: clientId,
        username,
        password,
        keepalive: 60,
      },
      topics: deviceTopics(tenantId, deviceId),
      config,
      note: 'Shown once. The controller stores these itself; they are never reused or shared.',
    },
  };
}
