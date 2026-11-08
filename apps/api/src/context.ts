import type { Context } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import type { Runtime } from './services/runtime';

export const SESSION_COOKIE = 'hc_session';

export class HttpError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) { super(message); }
}

export function runtime(c: Context): Runtime {
  return c.get('rt') as Runtime;
}

export interface Actor {
  profileId: string;
  email: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: string;
  role: string;
  permissions: string[];
  platformAdmin: boolean;
}
export interface RequestContext extends Actor {
  tenantId: string;
  tenant: any;
  member: any;
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true, sameSite: 'Lax' });
}

export async function actor(c: Context): Promise<Actor> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw new HttpError(401, 'Sign in to continue');
  const principal = await runtime(c).auth.verify(token);
  if (!principal) throw new HttpError(401, 'Session expired or invalid');
  return principal;
}

export async function context(c: Context, permission?: string): Promise<RequestContext> {
  const a = await actor(c);
  const rt = runtime(c);
  const ctx: any = await rt.db.rpc('rpc_context', { p_actor: a.profileId });
  if (!ctx?.tenant) throw new HttpError(403, 'No active home workspace for this account');
  if (ctx.tenant.status !== 'active') throw new HttpError(403, 'This workspace is suspended');
  const permissions: string[] = ctx.permissions || [];
  if (permission && !permissions.includes(permission)) {
    throw new HttpError(403, `Missing permission: ${permission}`);
  }
  if (permission) {
    const check: any = await rt.db.rpc('rpc_check_permission',
      { p_actor: a.profileId, p_tenant: ctx.tenant.id, p_permission: permission });
    if (!check?.allowed) throw new HttpError(403, `Missing permission: ${permission}`);
  }
  return { ...a, tenantId: ctx.tenant.id, tenant: ctx.tenant, member: ctx.member,
    role: ctx.role, permissions, platformAdmin: !!ctx.platform_admin && a.platformAdmin };
}

export async function ownerOnly(c: Context): Promise<RequestContext> {
  const a = await actor(c);
  const rt = runtime(c);
  const grant: any = await rt.db.rpc('rpc_auth_platform_permissions', { p_actor: a.profileId });
  const permissions: string[] = Array.isArray(grant?.permissions) ? grant.permissions : [];
  if (!a.platformAdmin || !grant?.platform_admin || !permissions.includes('owner.console')) {
    throw new HttpError(403, 'Platform administration only');
  }
  const ctx: any = await rt.db.rpc('rpc_context', { p_actor: a.profileId });
  if (!ctx?.platform_admin) throw new HttpError(403, 'Platform administration only');
  return { ...a, tenantId: ctx.tenant?.id || '', tenant: ctx.tenant || null,
    member: ctx.member || null, role: grant.role || 'platform_admin',
    permissions, platformAdmin: true };
}

export function p(c: Context, name: string): string { return c.req.param(name)!; }

export async function body(c: Context): Promise<Record<string, any>> {
  try { return await c.req.json(); } catch { throw new HttpError(400, 'Expected a JSON body'); }
}

export function auditEvent(rt: Runtime, tenantId: string, type: string, payload: Record<string, unknown>) {
  rt.emit(tenantId, type, { ...payload, at: new Date().toISOString() });
}
