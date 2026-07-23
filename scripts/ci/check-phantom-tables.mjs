#!/usr/bin/env node
/**
 * CI GATE — Phantom-table detector
 *
 * Part of Phase U4 of `CLUB-ARENA-OFFICIAL-UPGRADE-INTEGRATION.md` §2.4
 * invariant 2: "For every `.from('<name>')` in server/src/ and in
 * pages/api/*, the table MUST exist in pg_tables. Missing → 42P01
 * silent failure."
 *
 * This script uses `supabase/migrations/*.sql` as the schema source of truth
 * (any CREATE TABLE there is a table that will exist in production). That
 * avoids needing a live Supabase connection in CI.
 *
 * Scans:
 *   - src/**\/*.ts, src/**\/*.tsx  (UI + services)
 *   - server/src/**\/*.ts          (Hetzner game server)
 *
 * Fails CI if any `.from('<table>')` references a name not declared in
 * migrations.
 *
 * Usage:
 *   node scripts/ci/check-phantom-tables.mjs             # fail on phantom
 *   node scripts/ci/check-phantom-tables.mjs --warn      # non-blocking
 *
 * Exit codes:
 *   0 — clean, or --warn mode
 *   1 — phantoms found (strict mode)
 *   2 — script error (e.g. no migrations directory)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const REPO = process.cwd();
const MIGRATIONS = join(REPO, 'supabase/migrations');
const SCAN_DIRS = ['src', 'server/src'];
const ALLOWLIST = new Set([
  // Known non-table .from() targets (storage, rpc wrappers, etc.). Add sparingly.
  'pg_tables',
  'pg_stat_activity',
  'auth.users',
  'users', // Supabase auth.users via `.from('users')` after schema switch
  'members', // view or transient alias (legacy)
  // Cross-orb tables — defined in sibling-repo migrations not mounted in CA CI.
  // Remove each entry once CI mounts the relevant orb's migrations and passes
  // the corresponding --extra-migrations flag (see docs/U4-INVARIANT-FINDINGS.md).
  // Diamond Arena orb:
  'diamond_ledger',
  // Identity DNA Engine orb:
  'user_avatars',
  // Training orb:
  'training_user_achievements',
  // Marketplace orb:
  'club_shop_items',
  'club_shop_purchases',
  // World Hub (Smarter-Poker-World-Hub/supabase/migrations):
  'chip_ledger', // 20260319_create_chip_ledger.sql
  'club_arena_audit_logs', // 20260311000001_orb8_phase4_audit.sql
  'settlement_invoices', // WH Financial Export Service
  'union_wallet_transactions', // archive/20260308_union_wallets.sql
  // False positives (JSDoc / comment examples) — remove when the scanner
  // strips comments before matching.
  'announcements', // src/utils/sanitizeInput.ts:12 — JSDoc example
  // VIEWS created in 20260723_sweep3_feature_backends.sql — the ddlRx above
  // only parses CREATE TABLE, so views must be allowlisted explicitly.
  'player_sessions', // security_invoker view over session_history + tables
  'club_daily_stats', // security_invoker view over rake_records/rake_history
]);
const WARN_ONLY = process.argv.includes('--warn');

// Extra migration directories to also read as schema truth. Use when tables
// live in a sibling repo (cross-orb) but are referenced from this repo.
//   --extra-migrations=../Smarter-Poker-World-Hub/supabase/migrations
const EXTRA_MIGRATIONS = process.argv
  .filter((a) => a.startsWith('--extra-migrations='))
  .map((a) => a.slice('--extra-migrations='.length));

// ─── 1. Build schema set from migrations ────────────────────────────────

function listSqlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSqlFiles(full));
    else if (entry.endsWith('.sql')) out.push(full);
  }
  return out;
}

function extractSchemaTables() {
  let sqlFiles;
  try {
    sqlFiles = listSqlFiles(MIGRATIONS);
  } catch (err) {
    console.error(`ERROR: cannot read ${MIGRATIONS}:`, err.message);
    process.exit(2);
  }
  // Fold in any extra migration trees (cross-orb tables).
  for (const extra of EXTRA_MIGRATIONS) {
    try {
      sqlFiles.push(...listSqlFiles(extra));
    } catch (err) {
      console.error(`WARNING: --extra-migrations path not readable: ${extra}`);
    }
  }

  // Sort migrations by filename so timestamp-prefixed ordering is respected.
  sqlFiles.sort();

  const tables = new Set();

  // One combined regex whose alternation captures WHICH kind of DDL matched.
  // We walk matches in file-order and mutate `tables` accordingly so that
  // e.g. `DROP TABLE IF EXISTS agents; CREATE TABLE agents (...);` ends with
  // `agents` in the set (the intended outcome — drop-before-create pattern).
  const ddlRx = new RegExp(
    [
      // 1: CREATE TABLE
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["`]?([a-z_][a-z0-9_]*)["`]?/
        .source,
      // 2+3: ALTER TABLE ... RENAME TO
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?["`]?([a-z_][a-z0-9_]*)["`]?\s+RENAME\s+TO\s+(?:public\.)?["`]?([a-z_][a-z0-9_]*)["`]?/
        .source,
      // 4: DROP TABLE
      /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?["`]?([a-z_][a-z0-9_]*)["`]?/
        .source,
    ].join('|'),
    'gi'
  );

  for (const f of sqlFiles) {
    const src = readFileSync(f, 'utf8');
    ddlRx.lastIndex = 0;
    let m;
    while ((m = ddlRx.exec(src))) {
      if (m[1]) {
        tables.add(m[1]);
      } else if (m[2] && m[3]) {
        tables.delete(m[2]);
        tables.add(m[3]);
      } else if (m[4]) {
        tables.delete(m[4]);
      }
    }
  }
  return tables;
}

// ─── 2. Scan code for .from('<table>') ──────────────────────────────────

function listCodeFiles(dir) {
  const out = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) out.push(...listCodeFiles(full));
      else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry) && !/\.test\./.test(entry))
        out.push(full);
    }
  } catch {
    // directory may not exist (e.g. server/ in a pure-client repo); skip
  }
  return out;
}

function findFromCalls() {
  const fromRx = /\.from\s*\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*\)/g;
  const hits = new Map(); // table → [{file, line}]
  for (const dir of SCAN_DIRS) {
    for (const f of listCodeFiles(join(REPO, dir))) {
      const src = readFileSync(f, 'utf8');
      const lines = src.split('\n');
      let m;
      fromRx.lastIndex = 0;
      while ((m = fromRx.exec(src))) {
        const table = m[1];
        const before = src.slice(0, m.index);
        const lineNum = before.split('\n').length;
        if (!hits.has(table)) hits.set(table, []);
        hits.get(table).push({ file: f.replace(REPO + '/', ''), line: lineNum });
      }
    }
  }
  return hits;
}

// ─── 3. Compare ─────────────────────────────────────────────────────────

const schema = extractSchemaTables();
const refs = findFromCalls();

const phantoms = [];
for (const [table, sites] of refs) {
  if (ALLOWLIST.has(table)) continue;
  if (!schema.has(table)) phantoms.push({ table, sites });
}

// ─── 4. Report ──────────────────────────────────────────────────────────

console.log(`[check-phantom-tables] schema tables: ${schema.size}`);
console.log(`[check-phantom-tables] referenced tables: ${refs.size}`);
console.log(`[check-phantom-tables] phantoms: ${phantoms.length}`);

if (phantoms.length === 0) {
  console.log('✓ all .from() table references resolve to a migration-declared table');
  process.exit(0);
}

console.log('');
console.log('PHANTOM TABLES DETECTED:');
console.log('(these .from() calls reference tables that do not exist in supabase/migrations/)');
console.log('');
for (const { table, sites } of phantoms) {
  console.log(`  ${table}`);
  for (const s of sites) console.log(`    ${s.file}:${s.line}`);
}
console.log('');
console.log('To fix:');
console.log('  1. If the table SHOULD exist: add a CREATE TABLE migration in supabase/migrations/');
console.log('  2. If the .from() call is wrong: fix the table name');
console.log(
  '  3. If the name is a non-table target (view, storage bucket, etc.): add it to ALLOWLIST in this script'
);

if (WARN_ONLY) {
  console.log('');
  console.log('[--warn] exiting 0 despite failures');
  process.exit(0);
}
process.exit(1);
