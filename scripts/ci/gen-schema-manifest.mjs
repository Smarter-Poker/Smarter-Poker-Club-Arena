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

import { writeFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

/**
 * Write a manifest, and refuse to do it unless the file is exempt from Prettier.
 *
 * Prettier collapses short arrays onto one line and `JSON.stringify(x, null, 2)`
 * expands them, so the two formatters can never agree: lint-staged rewrites the
 * file on commit, the next regeneration writes it back, and the file oscillates
 * between two byte states with identical content. `detect-silent-revert.mjs`
 * reads the second of those as a wholesale revert, correctly, and blocks CI.
 *
 * This has now happened twice -- PR #360 for the columns manifest, and again
 * for the required-columns manifest, which was added on 2026-08-28 without an
 * entry in .prettierignore and churned 3,965 lines for no content change. The
 * fix both times was one line in .prettierignore, and both times the omission
 * was invisible until someone regenerated and read the diff.
 *
 * So the generator checks for itself. A fourth manifest added without the
 * exemption fails here, immediately, with the line to add -- rather than months
 * later as an unexplained CI failure on somebody else's pull request.
 */
function writeManifest(path, value) {
  const rel = relative(process.cwd(), path);
  const ignore = readFileSync(join(process.cwd(), '.prettierignore'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!ignore.includes(rel)) {
    console.error(
      `ERROR: ${rel} is not listed in .prettierignore.\n` +
        'Prettier and JSON.stringify format JSON arrays differently, so this file\n' +
        'would oscillate between two byte states on every commit and trip\n' +
        'scripts/ci/detect-silent-revert.mjs. Add this line to .prettierignore:\n\n' +
        `  ${rel}\n`
    );
    process.exit(1);
  }
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

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

async function callRpc(fn) {
  const res = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: supabaseServerHeaders(KEY, { 'Content-Type': 'application/json' }),
    body: '{}',
  });
  if (!res.ok) {
    console.error(`ERROR: ${fn} RPC failed (${res.status}): ${await res.text()}`);
    console.error('Create the helper RPC once, or regenerate via the MCP query in the header.');
    process.exit(2);
  }
  return res.json();
}

// 1) tables + functions manifest (phantom-table / phantom-rpc gate)
const data = await callRpc('fn_schema_manifest');
const manifest = {
  _comment:
    'Live public schema snapshot (tables/views + functions). Source of truth for the phantom-ref CI gate; regenerate with scripts/ci/gen-schema-manifest.mjs. Do NOT hand-edit.',
  tables: [...new Set(data.tables || [])].sort(),
  functions: [...new Set(data.functions || [])].sort(),
};
writeManifest(OUT, manifest);
console.log(
  `Wrote ${OUT}: ${manifest.tables.length} tables, ${manifest.functions.length} functions`
);

// 2) column manifest (phantom-column gate)
const COLS_OUT = join(process.cwd(), 'scripts/ci/supabase-columns-manifest.json');
const colsData = await callRpc('fn_columns_manifest');
const sortedCols = Object.fromEntries(
  Object.keys(colsData)
    .sort()
    .map((k) => [k, colsData[k]])
);
const colsManifest = {
  _comment:
    'Live public schema COLUMN snapshot {table: [columns]}. Source of truth for the phantom-column CI gate. Do NOT hand-edit.',
  columns: sortedCols,
};
// 2-space, matching the schema manifest above and Prettier's JSON output.
// It was `null, 0` (compact). lint-staged runs `prettier --write` on *.json, so
// every commit that staged this file rewrote it to multi-line, and the next
// regeneration wrote it back to one line. The file therefore oscillated between
// two byte-identical-to-an-earlier-state forms, and scripts/ci/detect-silent-revert.mjs
// correctly flagged that as a silent revert (PR #360, 2026-08-23) even though the
// 9,791 column keys were identical every time. Keep this at 2 so the generator is
// idempotent under Prettier.
writeManifest(COLS_OUT, colsManifest);
console.log(`Wrote ${COLS_OUT}: ${Object.keys(sortedCols).length} tables' columns`);

// 3) REQUIRED-column manifest (required-column write gate)
//
// The column manifest above answers "does this column exist", which catches a
// write that NAMES a column that is not there. It cannot catch a write that
// OMITS one that must be there - Postgres refuses the statement just as
// completely, the error lands in a catch, and the control silently does
// nothing. club_announcements.author_id and credit_requests.club_id were both
// found that way on 2026-08-28: creating an announcement and raising a credit
// request had never once worked.
//
// REQUIRED means NOT NULL, no DEFAULT, not identity, not generated. A column
// with a default or filled by a trigger is not the caller's problem, and
// including it would produce noise that teaches people to ignore the gate.
const REQ_OUT = join(process.cwd(), 'scripts/ci/supabase-required-columns-manifest.json');
const reqData = await callRpc('fn_required_columns_manifest');
const sortedReq = Object.fromEntries(
  Object.keys(reqData)
    .sort()
    .map((k) => [k, reqData[k]])
);
const reqManifest = {
  _comment:
    'Live public schema REQUIRED-COLUMN snapshot {table: [columns an INSERT must supply]}. ' +
    'NOT NULL, no default, not identity, not generated. Source of truth for the ' +
    'required-column CI gate. Do NOT hand-edit.',
  required: sortedReq,
};
// 2-space for the same reason as the columns manifest above: lint-staged runs
// prettier on *.json, and a compact write here would oscillate the file between
// two forms and trip detect-silent-revert.
writeManifest(REQ_OUT, reqManifest);
console.log(`Wrote ${REQ_OUT}: ${Object.keys(sortedReq).length} tables with required columns`);
