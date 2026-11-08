/** Cloudflare Pages Functions entry — the only server-side deployment unit. */

import { createApp } from '../apps/api/src/app';
import { getCloudRuntime } from '../apps/api/src/runtime/cloud';

export async function onRequest(ctx: any): Promise<Response> {
  const path = new URL(ctx.request.url).pathname;
  if (!path.startsWith('/api/') && !path.startsWith('/internal/') && path !== '/api/health') {
    return ctx.next();
  }
  try {
    const rt = await getCloudRuntime(ctx.env as Record<string, unknown>);
    const app = createApp(rt);
    return await app.fetch(ctx.request, ctx.env, ctx);
  } catch (e: any) {
    const message = String(e?.message || 'Configuration error');
    const setup = /Missing required configuration|signing key|not configured/i.test(message);
    return Response.json({
      error: setup ? 'Platform setup required' : 'Server error',
      detail: message,
      owner_console: '/owner/setup',
      instructions: 'Cloudflare Pages → Settings → Variables and Secrets → add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY as encrypted secrets, then redeploy. No D1 or R2 binding is needed.',
    }, { status: setup ? 503 : 500 });
  }
}
