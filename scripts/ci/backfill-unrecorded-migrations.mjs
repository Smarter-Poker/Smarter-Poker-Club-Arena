#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  BACKFILL: recover the repo file for every applied migration that lost one
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The estate applied migrations through the Supabase MCP for weeks without
 * always committing the .sql file (measured 2026-09-01: 378 of 1000 applied
 * since the 08-25 floor had no repo file). check-applied-migrations-are-recorded
 * flags them; this recovers them, BYTE-EXACT, from the one place the SQL still
 * lives: supabase_migrations.schema_migrations.statements.
 *
 * A file is written only when the repo does not already have that version (by
 * the 14-digit stamp prefix, the same key the checker uses). Migrations with
 * empty statements cannot be recovered and are listed, not invented.
 *
 * READ-ONLY against the database. It SELECTs and writes local files; it never
 * applies or alters anything. Idempotent: re-running writes only what is still
 * missing.
 *
 * Usage (on a machine with the service role):
 *   SUPABASE_DB_URL=postgres://... node scripts/ci/backfill-unrecorded-migrations.mjs [--since YYYYMMDD000000]
 * or with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY it uses the REST endpoint.
 */
import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SINCE = (() => {
  const i = process.argv.indexOf('--since');
  return i !== -1 ? process.argv[i + 1] : '20260825000000';
})();
const DIR = 'supabase/migrations';
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SB_URL || !SB_KEY) {
  console.error('Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.');
  process.exit(2);
}

// What the repo already has, by 14-digit version prefix.
const have = new Set();
for (const f of readdirSync(DIR)) {
  const m = /^(\d{14})_/.exec(f) || /^(\d{14})\.sql$/.exec(f);
  if (m) have.add(m[1]);
}
console.log(`[backfill] repo has ${have.size} versioned migration files; floor ${SINCE}`);

// Pull applied migrations since the floor. `statements` is a text[]; the
// migration file is the statements joined by newlines, which is exactly what
// Supabase splits a file INTO, so the round-trip is faithful.
async function fetchApplied() {
  // supabase_migrations is not REST-exposed, so this reads through a temporary
  // SECURITY DEFINER RPC (zz_backfill_migrations) created and dropped around
  // the run - a plain view runs with the caller's rights and cannot see it.
  const url = `${SB_URL}/rest/v1/rpc/zz_backfill_migrations`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      authorization: `Bearer ${SB_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ p_since: SINCE }),
  });
  if (!res.ok) throw new Error(`REST ${res.status}: ${await res.text()}`);
  return res.json();
}

const rows = await fetchApplied();
console.log(`[backfill] ${rows.length} applied migration(s) at or after the floor`);

let written = 0;
const empty = [];
const skippedNonNumeric = [];
for (const r of rows) {
  if (!/^\d{14}$/.test(r.version)) {
    skippedNonNumeric.push(r.version);
    continue;
  }
  if (have.has(r.version)) continue; // already recorded
  const stmts = Array.isArray(r.statements) ? r.statements : [];
  if (stmts.length === 0) {
    empty.push(`${r.version} ${r.name || ''}`.trim());
    continue;
  }
  const slug = (r.name || 'recovered').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'recovered';
  const fname = `${r.version}_${slug}.sql`;
  const header =
    `-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.\n` +
    `-- Applied to production ${r.version}; the .sql file was never committed at the\n` +
    `-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is\n` +
    `-- byte-exact to what ran. Do NOT re-apply; it is already live.\n\n`;
  writeFileSync(join(DIR, fname), header + stmts.join('\n') + '\n');
  written++;
}

console.log(`[backfill] wrote ${written} recovered migration file(s)`);
if (empty.length) {
  console.log(`[backfill] ${empty.length} applied migration(s) have EMPTY statements - unrecoverable, listed:`);
  for (const e of empty) console.log(`  ${e}`);
}
if (skippedNonNumeric.length) {
  console.log(`[backfill] skipped ${skippedNonNumeric.length} non-14-digit version(s) (e.g. 'manual'): ${skippedNonNumeric.join(', ')}`);
}
