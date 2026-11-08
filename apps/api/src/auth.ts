/**
 * Authentication against Supabase Auth (GoTrue) using the service-role key
 * only. No anon/publishable key and no JWT secret are required.
 *
 * Passwords are verified from an application-owned private table, and sessions
 * are short HS256 tokens signed with a key derived from the service-role key.
 */
import { SignJWT, jwtVerify } from 'jose';
import type { AuthPort, DataClient } from '@homecoreos/core';
import { hashPassword, verifyPassword } from './crypto';
import { signingKey, type Env } from './env';

const enc = new TextEncoder();
const ISSUER = 'homecoreos';
const AUDIENCE = 'homecoreos-app';
const SESSION_SECONDS = 7 * 24 * 60 * 60;

async function issue(profileId: string, email: string, env: Env): Promise<string> {
  return new SignJWT({ email, role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(profileId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_SECONDS}s`)
    .sign(enc.encode(signingKey(env)));
}

export async function verifyHs256(token: string, env: Env) {
  try {
    const { payload } = await jwtVerify(token, enc.encode(signingKey(env)), {
      issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'],
    });
    if (!payload.sub) return null;
    return { profileId: payload.sub, email: payload.email as string | undefined,
      role: payload.role as string | undefined };
  } catch { return null; }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class SupabaseAuthAdapter implements AuthPort {
  constructor(private db: DataClient, private env: Env) {}

  private get url() { return String(this.env.SUPABASE_URL || '').replace(/\/$/, ''); }
  private get key() { return String(this.env.SUPABASE_SERVICE_ROLE_KEY || ''); }
  private headers() {
    return { apikey: this.key, 'Content-Type': 'application/json' };
  }

  private async saveCredential(userId: string, email: string, password: string) {
    const passwordHash = await hashPassword(password);
    await this.db.insert('app_user_credentials', { user_id: userId, email, password_hash: passwordHash });
  }

  async signup(email: string, password: string, meta: Record<string, string> = {}) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!EMAIL.test(normalized)) throw new Error('Enter a valid email address');
    if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters');
    const existing = await this.db.select<any>('app_user_credentials', { eq: { email: normalized }, limit: 1 });
    if (existing.length) throw new Error('An account with this email already exists');

    const body: Record<string, unknown> = { email: normalized, password, data: meta };
    if (/^eyJ/.test(this.key)) body.email_confirm = true;
    const res = await fetch(`${this.url}/auth/v1/signup`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body),
    });
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d?.msg || d?.message || `Sign up failed (${res.status})`);
    const profileId = d?.user?.id || d?.id;
    if (!profileId) throw new Error('Supabase did not return a user id; check the Auth settings');
    await this.saveCredential(profileId, normalized, password);
    return { profileId, token: await issue(profileId, normalized, this.env) };
  }

  async login(email: string, password: string) {
    const normalized = String(email || '').trim().toLowerCase();
    const rows = await this.db.select<any>('app_user_credentials', { eq: { email: normalized }, limit: 1 });
    const row = rows[0];
    if (row) {
      if (!await verifyPassword(String(password || ''), row.password_hash)) {
        throw new Error('Invalid email or password');
      }
      return { profileId: row.user_id, token: await issue(row.user_id, normalized, this.env) };
    }
    // Accounts created before this table existed are verified through GoTrue,
    // then migrated into the application-owned credential table.
    const res = await fetch(`${this.url}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ email: normalized, password }),
    });
    const d: any = await res.json().catch(() => ({}));
    const profileId = d?.user?.id || d?.id;
    if (res.ok && profileId) {
      await this.saveCredential(profileId, normalized, password).catch(() => {});
      return { profileId, token: await issue(profileId, normalized, this.env) };
    }
    throw new Error('Invalid email or password');
  }

  async verify(token: string) { return verifyHs256(token, this.env); }
}

export function createAuth(db: DataClient, env: Env): AuthPort {
  return new SupabaseAuthAdapter(db, env);
}
