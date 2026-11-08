import { SignJWT, jwtVerify } from 'jose';
import type { AuthPort, DataClient } from '@homecoreos/core';
import type { Env } from './env';
import { jwtSecret } from './env';
import { hashPassword, verifyPassword } from './crypto';

const enc = new TextEncoder();

/**
 * Two adapters, one contract:
 *  - SupabaseAuthAdapter uses GoTrue (Supabase Auth) in production. The Worker
 *    verifies Supabase-issued JWTs with the project's JWT secret / JWKS.
 *  - LocalAuthAdapter is a fully functional offline equivalent backed by the
 *    same `auth.users` table and PBKDF2 hashes (dev + tests only).
 * Neither adapter ever accepts a profile id or role claim from the client body.
 */
export class LocalAuthAdapter implements AuthPort {
  constructor(private db: DataClient, private env: Env) {}
  private async issue(profileId: string, email: string) {
    return new SignJWT({ email, role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(profileId)
      .setIssuedAt()
      .setIssuer('homecoreos-local')
      .setAudience('authenticated')
      .setExpirationTime('7d')
      .sign(enc.encode(jwtSecret(this.env)));
  }
  async signup(email: string, password: string, meta: Record<string, string> = {}) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address');
    if (password.length < 10) throw new Error('Password must be at least 10 characters');
    const rows = await this.db.raw!<any>(
      `select id from auth.users where lower(email) = lower($1)`, [email]);
    if (rows.length) throw new Error('An account with this email already exists');
    const hash = await hashPassword(password);
    const inserted = await this.db.raw!<any>(
      `insert into auth.users (email, raw_user_meta_data, password_hash)
       values ($1, $2::jsonb, $3) returning id`, [email, JSON.stringify(meta), hash]);
    const profileId = inserted[0].id as string;
    return { token: await this.issue(profileId, email), profileId };
  }
  async login(email: string, password: string) {
    const rows = await this.db.raw!<any>(
      `select id, email, password_hash from auth.users where lower(email)=lower($1)`, [email]);
    const row = rows[0];
    if (!row || !row.password_hash || !(await verifyPassword(password, row.password_hash))) {
      throw new Error('Invalid email or password');
    }
    return { token: await this.issue(row.id, row.email), profileId: row.id as string };
  }
  async verify(token: string) {
    return verifyHs256(token, this.env);
  }
}

/**
 * Local-auth twin for Cloudflare D1. D1 has no SQL triggers or `auth.users`
 * schema, so signup writes the equivalent `auth_users` row and calls the
 * portable `rpc_bootstrap_user` domain operation (profile + tenant + owner
 * membership). Everything else (PBKDF2 hashes, HS256 JWT) is identical.
 */
export class D1LocalAuthAdapter implements AuthPort {
  constructor(private db: DataClient, private env: Env) {}
  private async issue(profileId: string, email: string) {
    return new SignJWT({ email, role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(profileId)
      .setIssuedAt()
      .setIssuer('homecoreos-local')
      .setAudience('authenticated')
      .setExpirationTime('7d')
      .sign(enc.encode(jwtSecret(this.env)));
  }
  async signup(email: string, password: string, meta: Record<string, string> = {}) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address');
    if (password.length < 10) throw new Error('Password must be at least 10 characters');
    const existing = await this.db.select<any>('auth_users', { eq: { email }, limit: 1 });
    if (existing.length) throw new Error('An account with this email already exists');
    const profileId = crypto.randomUUID();
    await this.db.insert('auth_users', {
      id: profileId, email, raw_user_meta_data: meta,
      password_hash: await hashPassword(password),
    });
    await this.db.rpc('rpc_bootstrap_user', { p_actor: profileId, p_email: email, p_meta: meta });
    return { token: await this.issue(profileId, email), profileId };
  }
  async login(email: string, password: string) {
    const rows = await this.db.select<any>('auth_users', { eq: { email }, limit: 1 });
    const row = rows[0];
    if (!row || !row.password_hash || !(await verifyPassword(password, row.password_hash))) {
      throw new Error('Invalid email or password');
    }
    return { token: await this.issue(row.id, row.email), profileId: row.id as string };
  }
  async verify(token: string) { return verifyHs256(token, this.env); }
}

export class SupabaseAuthAdapter implements AuthPort {
  constructor(private env: Env) {}
  private get base() { return `${this.env.SUPABASE_URL!.replace(/\/$/, '')}/auth/v1`; }
  private async call(path: string, body: unknown) {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { apikey: this.env.SUPABASE_ANON_KEY || '', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.msg || data.message || `Auth error ${res.status}`);
    return data;
  }
  async signup(email: string, password: string, meta: Record<string, string> = {}) {
    const d = await this.call('/signup', { email, password, data: meta });
    if (!d.access_token && d.user?.id) {
      // Email confirmation is enabled: no session yet. Caller shows a message.
      throw new Error('Account created. Confirm your email before signing in.');
    }
    const v = await verifyHs256(d.access_token, this.env);
    if (!v) throw new Error('Could not verify Supabase session');
    return { token: d.access_token, profileId: v.profileId };
  }
  async login(email: string, password: string) {
    const d = await this.call('/token?grant_type=password', { email, password });
    const v = await verifyHs256(d.access_token, this.env);
    if (!v) throw new Error('Could not verify Supabase session');
    return { token: d.access_token, profileId: v.profileId };
  }
  async verify(token: string) { return verifyHs256(token, this.env); }
}

export async function verifyHs256(token: string, env: Env) {
  try {
    const { payload } = await jwtVerify(token, enc.encode(jwtSecret(env)), {
      issuer: env.SUPABASE_JWT_SECRET ? undefined : 'homecoreos-local',
      audience: env.SUPABASE_JWT_SECRET ? undefined : 'authenticated',
      algorithms: ['HS256'],
    });
    if (!payload.sub) return null;
    return { profileId: payload.sub as string, email: payload.email as string | undefined, role: payload.role as string | undefined };
  } catch {
    return null;
  }
}

export function createAuth(db: DataClient, env: Env): AuthPort {
  if (env.DB_DRIVER === 'supabase') return new SupabaseAuthAdapter(env);
  if ((db as any).kind === 'd1') return new D1LocalAuthAdapter(db, env);
  return new LocalAuthAdapter(db, env);
}
