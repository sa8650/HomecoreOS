import type { Context } from 'hono';
import type { Runtime } from './services/runtime';

export class HttpError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) { super(message); }
}

export function runtime(c: Context): Runtime {
  return c.get('rt') as Runtime;
}

export interface Actor { profileId: string; email?: string; }
export interface RequestContext extends Actor {
  tenantId: string;
  tenant: any;
  member: any;
  role: string;
  permissions: string[];
  platformAdmin: boolean;
}

export async function actor(c: Context): Promise<Actor> {
  const rt = runtime(c);
  const h = c.req.header('Authorization') || '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Sign in to continue');
  const v = await rt.auth.verify(h.slice(7));
  if (!v) throw new HttpError(401, 'Session expired or invalid');
  return { profileId: v.profileId, email: v.email };
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
  // Re-check inside the database as well (defense in depth against stale claims).
  if (permission) {
    const check: any = await rt.db.rpc('rpc_check_permission',
      { p_actor: a.profileId, p_tenant: ctx.tenant.id, p_permission: permission });
    if (!check?.allowed) throw new HttpError(403, `Missing permission: ${permission}`);
  }
  return { ...a, tenantId: ctx.tenant.id, tenant: ctx.tenant, member: ctx.member,
    role: ctx.role, permissions, platformAdmin: !!ctx.platform_admin };
}

export async function ownerOnly(c: Context): Promise<RequestContext> {
  // The platform owner may have no customer workspace at all; only identity +
  // platform-admin membership are required (never a tenant membership).
  const a = await actor(c);
  const ctx: any = await runtime(c).db.rpc('rpc_context', { p_actor: a.profileId });
  if (!ctx?.platform_admin) throw new HttpError(403, 'Platform administration only');
  return { ...a, tenantId: ctx.tenant?.id || '', tenant: ctx.tenant || null,
    member: ctx.member || null, role: ctx.role || 'platform_admin',
    permissions: ctx.permissions || [], platformAdmin: true };
}

export function p(c: Context, name: string): string { return c.req.param(name)!; }

export async function body(c: Context): Promise<Record<string, any>> {
  try { return await c.req.json(); } catch { throw new HttpError(400, 'Expected a JSON body'); }
}

export function auditEvent(rt: Runtime, tenantId: string, type: string, payload: Record<string, unknown>) {
  rt.emit(tenantId, type, { ...payload, at: new Date().toISOString() });
}
