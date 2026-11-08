/**
 * Cloudflare Pages Functions entry — the ONLY server-side deployment unit.
 *
 * The owner adds two native bindings in Cloudflare Dashboard:
 *   Workers & Pages -> Pages project -> Settings -> Bindings
 *     D1 database  -> name: DB
 *     R2 bucket    -> name: FIRMWARE_BUCKET
 *   Variables and Secrets -> encrypted SECRETS_KEY
 * Then Save and redeploy. No R2 access keys, D1 API tokens or database URLs.
 *
 * Supabase users instead set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY as
 * bootstrap variables (plus SECRETS_KEY); the rest is entered in the Owner
 * Console. Exactly one provider is active per deployment.
 */

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
    const setup = /No database configured|SECRETS_KEY is missing|migrat/i.test(message);
    return Response.json({
      error: setup ? 'Platform setup required' : 'Server error',
      detail: message,
      owner_console: '/owner/setup',
      instructions: 'Cloudflare Dashboard → Workers & Pages → Pages project → Settings → Bindings → add D1 database named DB and R2 bucket named FIRMWARE_BUCKET → Variables and Secrets → add SECRETS_KEY → Save and redeploy.',
    }, { status: setup ? 503 : 500 });
  }
}
