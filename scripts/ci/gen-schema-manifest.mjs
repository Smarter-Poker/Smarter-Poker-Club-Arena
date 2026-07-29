#!/usr/bin/env node
/**
 * Regenerate scripts/ci/supabase-schema-manifest.json — the live-schema source
 * of truth for the phantom-ref CI gate (check-phantom-tables.mjs).
 *
 * The manifest lists every public table/view and every public function in the
 * production Supabase project. It exists because the repo's supabase/migrations
 * are intentionally stale (schema is applied straight to prod via the Supabase
 * MCP), so migrations can't be the source of truth for "does this table exist".
 *
 * Requires a service-role connection to the production project. Provide:
 *   SUPABASE_URL                 e.g. https://kuklfnapbkmacvwxktbh.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY    service_role key (never commit it)
 *
 * It calls a SECURITY DEFINER helper RPC `public.fn_schema_manifest()` that
 * returns { tables: text[], functions: text[] }. If that RPC is absent, create
 * it once (see the SQL in this file's header comment) or regenerate the manifest
 * from an agent with direct SQL access (Supabase MCP execute_sql):
 *
 *   SELECT json_build_object(
 *     'tables',    (SELECT coalesce(json_agg(table_name ORDER BY table_name),'[]')
 *                   FROM information_schema.tables
 *                   WHERE table_schema='public' AND table_type IN ('BASE TABLE','VIEW')),
 *     'functions', (SELECT coalesce(json_agg(DISTINCT proname ORDER BY proname),'[]')
 *                   FROM pg_proc WHERE pronamespace='public'::regnamespace));
 *
 * Usage:  node scripts/ci/gen-schema-manifest.mjs
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT = join(process.cwd(), 'scripts/ci/supabase-schema-manifest.json');

if (!URL || !KEY) {
  console.error(
    'ERROR: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. ' +
      'Or regenerate the manifest via the Supabase MCP query in this file header.'
  );
  process.exit(2);
}

const res = await fetch(`${URL}/rest/v1/rpc/fn_schema_manifest`, {
  method: 'POST',
  headers: {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
  },
  body: '{}',
});
if (!res.ok) {
  console.error(`ERROR: fn_schema_manifest RPC failed (${res.status}): ${await res.text()}`);
  console.error('Create the helper RPC once, or regenerate via the MCP query in the header.');
  process.exit(2);
}
const data = await res.json();
const manifest = {
  _comment:
    'Live public schema snapshot (tables/views + functions). Source of truth for the phantom-ref CI gate; regenerate with scripts/ci/gen-schema-manifest.mjs. Do NOT hand-edit.',
  tables: [...new Set(data.tables || [])].sort(),
  functions: [...new Set(data.functions || [])].sort(),
};
writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${OUT}: ${manifest.tables.length} tables, ${manifest.functions.length} functions`);
