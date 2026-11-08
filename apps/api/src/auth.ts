import type { AuthPort, AuthPrincipal, AuthSessionTicket, DataClient } from '@homecoreos/core';
import { hmacHex, sha256Hex, randomHex, randomToken, verifyPassword } from './crypto';
import { signingKey, type Env } from './env';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthError extends Error {
  constructor(public status: number, message: string, public retryAfter = 0) { super(message); }
}

function safeMessage(e: any, fallback: string, status = 400): AuthError {
  const raw = String(e?.message || '');
  const known = [
    'An account with this email already exists',
    'Enter a valid email address',
    'Invalid or expired recovery code',
    'Current password is incorrect',
    'Enable the pgcrypto extension in Supabase to use password authentication',
    'Password is required',
    'A new password is required',
    'Account not found',
    'Unknown authentication setting',
    'Value out of range',
    'bcrypt_cost must be between 4 and 15',
    'Invalid status',
    'Invalid password hash',
  ];
  for (const k of known) if (raw.includes(k)) return new AuthError(status, k);
  if (raw.includes('23505') || /duplicate key/i.test(raw)) {
    return new AuthError(409, 'An account with this email already exists');
  }
  return new AuthError(status, fallback);
}

export interface AuthRequest { ip: string; userAgent: string }

export class CustomAuth implements AuthPort {
  private configCache: { at: number; value: Record<string, number> } | null = null;

  constructor(private db: DataClient, private env: Env) {}

  private async secret(password: string): Promise<string> {
    return hmacHex(signingKey(this.env), `homecoreos-password-pepper-v1:${password}`);
  }

  private async hashOf(token: string): Promise<string> { return sha256Hex(token); }

  async config(): Promise<Record<string, number>> {
    if (this.configCache && Date.now() - this.configCache.at < 15_000) return this.configCache.value;
    const value = (await this.db.rpc<any>('rpc_auth_config', {})) || {};
    this.configCache = { at: Date.now(), value };
    return value;
  }

  async setConfig(key: string, value: number): Promise<Record<string, number>> {
    let next: any;
    try {
      next = (await this.db.rpc<any>('rpc_auth_config_set', { p_key: key, p_value: Number(value) })) || {};
    } catch (e: any) { throw safeMessage(e, 'Could not update the setting', 400); }
    this.configCache = { at: Date.now(), value: next };
    return next;
  }

  async health(): Promise<any> {
    try { return (await this.db.rpc<any>('rpc_auth_health', {})) || {}; }
    catch (e: any) { return { error: String(e?.message || 'unavailable') }; }
  }

  private async passwordRules(password: string) {
    const cfg = await this.config();
    const min = Math.max(8, Math.min(128, cfg.password_min_length || 10));
    if (String(password || '').length < min) {
      throw new AuthError(400, `Password must be at least ${min} characters`);
    }
  }

  private async guard(email: string, ip: string, action: 'check' | 'fail' | 'clear', scope = 'login') {
    try {
      return (await this.db.rpc<any>('rpc_auth_guard',
        { p_email: email, p_ip: ip, p_action: action, p_scope: scope })) || {};
    } catch { return { allowed: true, retry_after: 0 }; }
  }

  private async openSession(userId: string, request: AuthRequest): Promise<{ token: string; expiresAt: string }> {
    const token = randomToken(32);
    const hash = await this.hashOf(token);
    const row: any = await this.db.rpc<any>('rpc_auth_session_create', {
      p_user_id: userId, p_token_hash: hash,
      p_ip: request.ip, p_user_agent: request.userAgent,
    });
    return { token, expiresAt: String(row?.expires_at || '') };
  }

  private async issueRecoveryCodes(userId: string): Promise<string[]> {
    const cfg = await this.config();
    const count = Math.max(1, Math.min(20, cfg.recovery_code_count || 8));
    const raw = Array.from({ length: count }, () => randomHex(8).toUpperCase());
    const hashes = await Promise.all(raw.map((c) => sha256Hex(c)));
    await this.db.rpc('rpc_auth_recovery_codes_set', { p_user_id: userId, p_hashes: hashes });
    return raw.map((c) => `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12, 16)}`);
  }

  private async checkCurrent(userId: string, password: string): Promise<boolean> {
    const rows = await this.db.select<any>('app_users', {
      columns: 'id,email,password_hash,password_algo', eq: { id: userId }, limit: 1,
    });
    const row = rows[0];
    if (!row) throw new AuthError(404, 'Account not found');
    if (row.password_algo === 'recovery-required') {
      throw new AuthError(403, 'Use a recovery code or ask the platform owner to set a new password.');
    }
    if (row.password_algo !== 'bcrypt-pepper') return verifyPassword(password, row.password_hash);
    const secret = await this.secret(password);
    return !!(await this.db.rpc<any>('rpc_auth_verify_secret', { p_secret: secret, p_hash: row.password_hash }));
  }

  async signup(email: string, password: string, meta: Record<string, string>, request: AuthRequest): Promise<AuthSessionTicket> {
    const normalized = String(email || '').trim().toLowerCase();
    if (!EMAIL.test(normalized)) throw new AuthError(400, 'Enter a valid email address');
    await this.passwordRules(password);
    const secret = await this.secret(password);
    let reg: any;
    try {
      reg = await this.db.rpc<any>('rpc_auth_register', {
        p_email: normalized, p_secret: secret,
        p_meta: { full_name: meta.full_name || '', home_name: meta.home_name || '', timezone: meta.timezone || 'UTC' },
      });
    } catch (e: any) { throw safeMessage(e, 'Could not create the account', 409); }
    if (!reg?.user_id) throw new AuthError(500, 'Could not create the account');
    const recoveryCodes = await this.issueRecoveryCodes(reg.user_id);
    const session = await this.openSession(reg.user_id, request);
    return { token: session.token, expiresAt: session.expiresAt, userId: reg.user_id,
      email: reg.email, role: reg.role, recoveryCodes };
  }

  async login(email: string, password: string, request: AuthRequest): Promise<AuthSessionTicket> {
    const normalized = String(email || '').trim().toLowerCase();
    const check: any = await this.guard(normalized, request.ip, 'check');
    if (check.allowed === false) {
      throw new AuthError(429, `Too many attempts. Try again in ${check.retry_after || 1} seconds`, Number(check.retry_after || 1));
    }
    let lookup: any = null;
    try { lookup = await this.db.rpc<any>('rpc_auth_lookup', { p_email: normalized }); }
    catch (e: any) { throw safeMessage(e, 'Sign in is temporarily unavailable', 503); }
    if (!lookup?.user_id) {
      const failed: any = await this.guard(normalized, request.ip, 'fail');
      if (failed.allowed === false) throw new AuthError(429, `Too many attempts. Try again in ${failed.retry_after || 1} seconds`, Number(failed.retry_after || 1));
      throw new AuthError(401, 'Invalid email or password');
    }
    if (lookup.status !== 'active') throw new AuthError(403, 'This account is suspended');
    if (lookup.password_algo === 'recovery-required') {
      throw new AuthError(403, 'This account needs a password reset. Use a recovery code or ask the platform owner.');
    }

    const secret = await this.secret(password);
    let ok = false;
    try {
      if (lookup.password_algo === 'bcrypt-pepper') {
        ok = !!(await this.db.rpc<any>('rpc_auth_verify_secret', { p_secret: secret, p_hash: lookup.password_hash }));
      } else {
        ok = await verifyPassword(password, lookup.password_hash);
        if (ok) {
          const upgraded = await this.db.rpc<any>('rpc_auth_hash_secret', { p_secret: secret });
          await this.db.rpc('rpc_auth_update_secret', {
            p_user_id: lookup.user_id, p_hash: upgraded, p_keep_token_hash: '',
          });
        }
      }
    } catch (e: any) {
      if (!/pgcrypto/i.test(String(e?.message || ''))) ok = false;
      else throw safeMessage(e, 'Password hashing is unavailable', 503);
    }
    if (!ok) {
      const failed: any = await this.guard(normalized, request.ip, 'fail');
      if (failed.allowed === false) throw new AuthError(429, `Too many attempts. Try again in ${failed.retry_after || 1} seconds`, Number(failed.retry_after || 1));
      throw new AuthError(401, 'Invalid email or password');
    }
    await this.guard(normalized, request.ip, 'clear');
    const session = await this.openSession(lookup.user_id, request);
    const principal = await this.verify(session.token);
    return { token: session.token, expiresAt: session.expiresAt, userId: lookup.user_id,
      email: lookup.email, role: principal?.role || 'customer' };
  }

  async verify(token: string): Promise<AuthPrincipal | null> {
    if (!token) return null;
    try {
      const hash = await this.hashOf(token);
      const p: any = await this.db.rpc<any>('rpc_auth_session_resolve', { p_token_hash: hash });
      if (!p?.user_id) return null;
      return {
        profileId: p.user_id, email: p.email, sessionId: p.session_id, tokenHash: hash,
        expiresAt: p.expires_at, role: p.role,
        permissions: Array.isArray(p.permissions) ? p.permissions : [],
        platformAdmin: !!p.platform_admin,
      };
    } catch { return null; }
  }

  async logout(token: string): Promise<void> {
    try { await this.db.rpc('rpc_auth_session_revoke', { p_token_hash: await this.hashOf(token) }); }
    catch { /* session already gone */ }
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string, keepTokenHash: string): Promise<void> {
    await this.passwordRules(newPassword);
    if (!await this.checkCurrent(userId, currentPassword)) {
      throw new AuthError(400, 'Current password is incorrect');
    }
    const hash = await this.db.rpc<any>('rpc_auth_hash_secret', { p_secret: await this.secret(newPassword) });
    try {
      await this.db.rpc('rpc_auth_update_secret', {
        p_user_id: userId, p_hash: hash, p_keep_token_hash: keepTokenHash,
      });
    } catch (e: any) { throw safeMessage(e, 'Could not change the password', 400); }
  }

  async recover(email: string, code: string, newPassword: string, request: AuthRequest): Promise<void> {
    const normalized = String(email || '').trim().toLowerCase();
    const check: any = await this.guard(normalized, request.ip, 'check', 'recovery');
    if (check.allowed === false) {
      throw new AuthError(429, `Too many attempts. Try again in ${check.retry_after || 1} seconds`, Number(check.retry_after || 1));
    }
    await this.passwordRules(newPassword);
    const normalizedCode = String(code || '').toUpperCase().replace(/[^0-9A-F]/g, '');
    if (normalizedCode.length !== 16) throw new AuthError(400, 'Invalid or expired recovery code');
    try {
      const hash = await this.db.rpc<any>('rpc_auth_hash_secret', { p_secret: await this.secret(newPassword) });
      await this.db.rpc('rpc_auth_recovery_redeem', {
        p_email: normalized, p_code_hash: await sha256Hex(normalizedCode), p_new_hash: hash,
      });
    } catch (e: any) {
      const failed: any = await this.guard(normalized, request.ip, 'fail', 'recovery');
      if (failed.allowed === false) throw new AuthError(429, `Too many attempts. Try again in ${failed.retry_after || 1} seconds`, Number(failed.retry_after || 1));
      throw safeMessage(e, 'Invalid or expired recovery code', 400);
    }
    await this.guard(normalized, request.ip, 'clear', 'recovery');
  }

  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    return this.issueRecoveryCodes(userId);
  }

  async adminResetPassword(userId: string, newPassword: string): Promise<void> {
    await this.passwordRules(newPassword);
    const hash = await this.db.rpc<any>('rpc_auth_hash_secret', { p_secret: await this.secret(newPassword) });
    try {
      await this.db.rpc('rpc_auth_update_secret', { p_user_id: userId, p_hash: hash, p_keep_token_hash: '' });
      await this.db.select('app_users', { columns: 'id,email', eq: { id: userId }, limit: 1 })
        .then(async (rows: any[]) => {
          if (rows[0]?.email) await this.db.rpc('rpc_auth_guard_reset_for', { p_email: String(rows[0].email) });
        }).catch(() => {});
    } catch (e: any) { throw safeMessage(e, 'Could not reset the password', 400); }
  }
}

export function createAuth(db: DataClient, env: Env): CustomAuth {
  return new CustomAuth(db, env);
}
