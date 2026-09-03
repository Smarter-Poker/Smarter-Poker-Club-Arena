#!/usr/bin/env node
/**
 * CI GATE — Stranded-writer detector
 *
 * Part of Phase U4 of `CLUB-ARENA-OFFICIAL-UPGRADE-INTEGRATION.md` §2.4
 * invariant 1: "For every UI-read table, `grep -rln "<table>" server/` must
 * return ≥1 hit. Zero hits → red flag."
 *
 * Why this matters: the 2026-04-15 silent-failure audit caught 9 bugs where
 * client code read a table that nothing on the server side wrote to. The
 * table existed, the query succeeded (empty), and the UI silently showed
 * stale or zeroed values. This gate fails CI when the UI references a
 * table with no corresponding writer on the server.
 *
 * Scans:
 *   - `src/` for .from('<table>')   — consumers (UI)
 *   - `server/src/` for .from('<table>') and raw table names — writers/readers
 *   - `supabase/migrations/*.sql` for RPC function bodies that write to tables
 *
 * A UI-read table is "stranded" if NO server-side source mentions it.
 *
 * Usage:
 *   node scripts/ci/check-stranded-writers.mjs         # fail on stranded
 *   node scripts/ci/check-stranded-writers.mjs --warn  # non-blocking
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const REPO = process.cwd();
const WARN_ONLY = process.argv.includes('--warn');

// Tables that are legitimately client-write-only (user-generated content
// updated from the browser with RLS guards), read-only lookup tables, or
// cross-orb tables whose writers live in a sibling repo (identity-dna-engine,
// diamond-arena, training-orb) or in the World Hub's `pages/api/*` handlers
// which this CA script does not scan.
// Add sparingly — every entry is an escape hatch for the stranded-writer rule.
const ALLOWLIST = new Set([
  // Client-authoritative
  'arena_sessions', // client-side session tracker
  'bus_event_log', // client-side telemetry
  // Writer lives in the DATABASE, which this repo-scanning check cannot see.
  // `vip_feature_usage_monthly` is written by the SECURITY DEFINER function
  // `fn_increment_vip_usage` (also referenced by `fn_platform_invariants_health`).
  // Verified against production 2026-08-17. Read from src/services/VIPService.ts:266.
  'vip_feature_usage_monthly',
  // Same shape as vip_feature_usage_monthly: the writers are SECURITY DEFINER
  // functions that live in the DATABASE, not in server/src or this repo's
  // (intentionally stale) migrations, so this repo-scanning check cannot see
  // them. Both verified against production 2026-08-19 via the Supabase MCP:
  //   union_pnl_settlements  3 writer functions, 3 rows.  Read: UnionDashboardPage.tsx:406
  //   avatar_unlocks         2 writer functions, 1 row.   Read: marketplaceShared.ts:352
  'union_pnl_settlements',
  'avatar_unlocks',
  //   union_settlement_rounds  written by the SECURITY DEFINER function
  //   `fn_union_settlement_cascade`; 3 rows in production. Verified 2026-08-20
  //   via the Supabase MCP. Read: src/services/UnionOpsService.ts:260.
  'union_settlement_rounds',
  // Cross-orb tables (tracked in ~/Documents/Smarter-Poker-World-Hub/supabase/migrations)
  'diamond_ledger', // Diamond Arena orb
  'user_avatars', // Identity DNA Engine
  'training_user_achievements', // Training orb
  'club_shop_items', // Marketplace orb
  'club_shop_purchases',
  'settlement_invoices', // Financial Export Service (WH-defined)
  // WH-authoritative: defined + written in Smarter-Poker-World-Hub/pages/api/*.
  // CA reads these from src/ but CA's server/ does not write them.
  'chip_ledger', // WH: Smarter-Poker-World-Hub/supabase/migrations/20260319_create_chip_ledger.sql
  'club_arena_audit_logs', // WH: 20260311000001_orb8_phase4_audit.sql
  // Read-only REFERENCE data. Not stranded — there is deliberately no runtime
  // writer, because a fee schedule that application code can rewrite is a
  // schedule nobody can audit. `bbj_stakes_tiers` is the published stakes
  // ladder (blind range, BBJ fee, and the loser/winner/table payout split) and
  // it is the table fn_bbj_payout pays FROM. Rows are seeded by migration and
  // changed by an operator; the only non-read grant is to service_role.
  // Verified against production 2026-08-23 via the Supabase MCP: 6 rows
  // (nano/micro/small/mid/high/nosebleeds), RLS on, SELECT policy
  // `read_bbj_stakes_tiers` for `authenticated`, USING (true).
  // Read from src/components/bbj/BBJBasicPanel.tsx — deliberately, so the
  // schedule shown to a player is the same object the engine pays from. The
  // client copy in src/config/RakeConfig.ts had drifted from it on fees,
  // blind ranges AND tier boundaries.
  'bbj_stakes_tiers',
  // Supabase auth schema
  'users',
  'members',
]);

// ─── Helpers ────────────────────────────────────────────────────────────

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
  } catch {}
  return out;
}

function listSqlFiles(dir) {
  const out = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...listSqlFiles(full));
      else if (entry.endsWith('.sql')) out.push(full);
    }
  } catch {}
  return out;
}

function fromCallsIn(dirs) {
  const rx = /\.from\s*\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*\)/g;
  const hits = new Map();
  for (const dir of dirs) {
    for (const f of listCodeFiles(join(REPO, dir))) {
      const src = readFileSync(f, 'utf8');
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(src))) {
        const t = m[1];
        if (!hits.has(t)) hits.set(t, []);
        hits.get(t).push({ file: f.replace(REPO + '/', ''), line: lineOf(src, m.index) });
      }
    }
  }
  return hits;
}

function lineOf(src, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

// Tables the CLIENT itself writes with an RLS-guarded chain
// (`.from('t').insert|update|upsert|delete(...)`). Such user-generated-content
// tables (reports, notes, feedback, …) are legitimately client-authoritative —
// they have a writer, just not a server-side one, so they are NOT stranded.
function clientWriteTables(dirs) {
  const rx = /\.from\s*\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*\)\s*\.(insert|update|upsert|delete)\b/g;
  const written = new Set();
  for (const dir of dirs) {
    for (const f of listCodeFiles(join(REPO, dir))) {
      const src = readFileSync(f, 'utf8');
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(src))) written.add(m[1]);
    }
  }
  return written;
}

function tablesMentionedIn(dir, extPattern) {
  // Loose mention check — any identifier-like token surrounded by quotes,
  // whitespace, or SQL punctuation. Used to catch RPC function bodies and
  // server code that inserts/updates without using .from().
  const tokens = new Set();
  const files = dir.endsWith('migrations')
    ? listSqlFiles(join(REPO, dir))
    : listCodeFiles(join(REPO, dir));
  for (const f of files) {
    tokens.add(readFileSync(f, 'utf8').toLowerCase());
  }
  return (name) => {
    const needle = name.toLowerCase();
    for (const blob of tokens) {
      // Word-boundary-ish match to avoid substring collisions
      if (
        blob.includes(` ${needle} `) ||
        blob.includes(`"${needle}"`) ||
        blob.includes(`'${needle}'`) ||
        blob.includes(`.${needle}`) ||
        blob.includes(`\`${needle}\``) ||
        blob.includes(`${needle}(`) ||
        blob.includes(`${needle},`) ||
        blob.includes(`${needle};`) ||
        blob.includes(`${needle}\n`)
      )
        return true;
    }
    return false;
  };
}

// ─── Scan ───────────────────────────────────────────────────────────────

const clientRefs = fromCallsIn(['src']);
const clientWrites = clientWriteTables(['src']);
const serverMentions = tablesMentionedIn('server/src');
const sqlMentions = tablesMentionedIn('supabase/migrations');

const stranded = [];
for (const [table, sites] of clientRefs) {
  if (ALLOWLIST.has(table)) continue;
  if (clientWrites.has(table)) continue; // client-authoritative (writes it itself)
  const foundOnServer = serverMentions(table);
  const foundInSql = sqlMentions(table); // RPC writer or migration INSERT
  if (!foundOnServer && !foundInSql) {
    stranded.push({ table, sites });
  }
}

// ─── Report ─────────────────────────────────────────────────────────────

console.log(`[check-stranded-writers] client-read tables: ${clientRefs.size}`);
console.log(`[check-stranded-writers] stranded (no server writer): ${stranded.length}`);

if (stranded.length === 0) {
  console.log('✓ every client-read table has a server-side writer');
  process.exit(0);
}

console.log('');
console.log('STRANDED WRITERS DETECTED:');
console.log('(these tables are read by src/ but have NO writer in server/src/ or migrations)');
console.log('');
for (const { table, sites } of stranded) {
  console.log(`  ${table}`);
  for (const s of sites.slice(0, 3)) console.log(`    ${s.file}:${s.line}`);
  if (sites.length > 3) console.log(`    ... ${sites.length - 3} more sites`);
}
console.log('');
console.log('To fix, for each stranded table:');
console.log('  1. If the table should be server-written: implement the writer in server/src/');
console.log('  2. If the UI is meant to write to it directly: add to ALLOWLIST in this script');
console.log('  3. If the read is obsolete: remove the .from() call');

if (WARN_ONLY) {
  console.log('');
  console.log('[--warn] exiting 0 despite failures');
  process.exit(0);
}
process.exit(1);
