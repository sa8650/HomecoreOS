#!/usr/bin/env node
/**
 * Prints the ingress signing key the HomecoreOS API uses, derived exactly as
 * apps/api/src/config.ts does: HMAC-SHA256(SUPABASE_SERVICE_ROLE_KEY, "homecoreos-signing-key-v1").
 *
 * The bridge must sign with this value, because the API replaces any SIGNING_KEY
 * binding with it. Run it where the service-role key is available, and store the
 * output as the bridge's SIGNING_KEY secret. Do not commit the output.
 *
 *   SUPABASE_SERVICE_ROLE_KEY=... node scripts/bridge/derive_signing_key.mjs
 */
import { createHmac } from 'node:crypto';

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!serviceKey.trim()) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is required');
  process.exit(2);
}
process.stdout.write(createHmac('sha256', serviceKey.trim()).update('homecoreos-signing-key-v1').digest('hex'));
