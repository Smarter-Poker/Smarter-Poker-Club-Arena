#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DEPRECATED TABLE GATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Fails the build when source code READS a table that receives no writes.
 *
 * Why this exists: on 2026-08-19 five separate features were found reading
 * dead tables and rendering the empty result as a legitimate zero —
 *
 *   - ClubFinancialsPage        (a club owner's money screen, zeros for 3.5 months)
 *   - ClubFinancialDashboard    (revenue chart, flat zero line)
 *   - TableService.getTableStats(every table reported 0 rake)
 *   - ProfileService.getStats   (EVERY player: 0 hands, 0% win rate)
 *   - FriendSuggestionService   (never returned a single suggestion)
 *
 * The codebase already carried comments saying these tables were empty. That
 * did not prevent any of the five, because a comment in one file is invisible
 * to someone writing a query in another. A build failure is not.
 *
 * A dead table is uniquely dangerous because the failure is SILENT: the query
 * succeeds, returns [], and the UI renders "0" — which looks like a real
 * answer. Nothing throws, nothing logs, nobody notices.
 *
 * WRITES are allowed (some legacy writers are retired on their own schedule,
 * governed by MIGRATION-LAW phases). Only reads fail the build.
 *
 * To add a table: add it here AND to the `deprecated_tables` registry in the
 * database, so the schema itself carries the same fact.
 * To allowlist a specific read: add "<file>:<table>" to ALLOWLIST below with a
 * reason. Prefer fixing the query.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'server/src'];
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);

/** table -> what to use instead. Mirrors public.deprecated_tables. */
const DEPRECATED = {
  // Added 2026-09-11. The daily free spin was replaced by the one-time welcome
  // spin (Dan 2026-09-10), which is the REAL wheel and lives in wheel_spins
  // with is_welcome set. Its two readers were dropped in
  // 20260911052216_the_daily_free_spin_leaves_the_building. The rows stay; the
  // point is that nothing reads them again and renders the empty result as a
  // legitimate zero.
  wheel_free_spins: 'wheel_spins WHERE is_welcome',
  wheel_free_segments: 'wheel_segments',
  rake_history: 'rake_records',
  hand_players: 'hand_history (or the ca_player_stats_full RPC for aggregates)',
  // rake_attributions: NO LONGER DEPRECATED (Dan 2026-08-29/30). It was
  // genuinely dead — declared with a unique guard and 0 rows, which is why it
  // was listed here. The weighted contributed rake migration made it the
  // AUTHORITATIVE per-player rake ledger: atomic_distribute_rake writes one
  // row per contributor per hand inside the banking transaction, the SQL
  // consumers read it through fn_rake_shares_for_record, and the settler
  // reads it through sharesForRakeRecordWithLedger. A register that still
  // called it dead would push the next reader back onto recomputation — the
  // dual-implementation shape that produced the equal-dealt bug. Removed
  // from DEPRECATED deliberately, in the commit that started reading it.
  // hands / hand_actions: zero rows ever. saveHand inserts into `hands` first
  // and returns early when it fails, so everything below it is unreachable.
  hands: 'hand_history',
  hand_actions: 'hand_history.actions (jsonb)',
  // Added 2026-08-27. The global chip pool, FROZEN since 2026-08-21 00:59 UTC
  // with 732,591,994.33 chips stranded in it (club-arena CLAUDE.md 11.5).
  // The rule said "nothing reads it"; eleven sites did, and because the table
  // still HOLDS numbers the reads did not render zeros - they rendered
  // six-day-stale, plausible, formatted lies. One sampled player read
  // 3,313,727.73 against a true 34,818.60, and the frozen pool summed to six
  // times the entire real economy. That is why a comment was not enough and
  // this line exists: a read is now a build failure.
  wallets:
    'club_members.chip_balance / .promo_balance / .locked_chips (club-scoped, live), ' +
    'agents.agent_wallet_balance for BUSINESS, or the fn_player_spendable_balance RPC ' +
    'when the question is what a player can SPEND at a table',
};

/** "<path>:<table>" entries that are deliberately permitted, with a reason. */
const ALLOWLIST = new Map([
  // (none — every known read was repointed on 2026-08-19)
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (EXTS.has(entry.slice(entry.lastIndexOf('.')))) out.push(full);
  }
  return out;
}

/**
 * A read is `.from('<table>')` NOT immediately followed by a write call.
 * Writes look like .from('t').insert( / .upsert( / .update( / .delete(
 * possibly across a line break.
 */
function findReads(source, table) {
  const hits = [];
  const re = new RegExp(`\\.from\\(\\s*['"\`]${table}['"\`]\\s*\\)`, 'g');
  let m;
  while ((m = re.exec(source)) !== null) {
    const after = source.slice(m.index + m[0].length, m.index + m[0].length + 120);
    if (/^\s*\.\s*(insert|upsert|update|delete)\s*\(/.test(after)) continue; // write
    const line = source.slice(0, m.index).split('\n').length;
    hits.push(line);
  }
  return hits;
}

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
const violations = [];

for (const file of files) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const rel = relative(ROOT, file);
  for (const [table, replacement] of Object.entries(DEPRECATED)) {
    if (!source.includes(table)) continue;
    for (const line of findReads(source, table)) {
      if (ALLOWLIST.has(`${rel}:${table}`)) continue;
      violations.push({ rel, line, table, replacement });
    }
  }
}

if (violations.length === 0) {
  console.log(
    `OK — no source file reads a deprecated table (${Object.keys(DEPRECATED).join(', ')}).`
  );
  process.exit(0);
}

console.error('\nDEPRECATED TABLE READ(S) DETECTED\n');
console.error('These tables receive no writes. The query will succeed and return an');
console.error('empty set, which the UI will render as a real "0". Nothing will throw.\n');
for (const v of violations) {
  console.error(`  ${v.rel}:${v.line}`);
  console.error(`      reads '${v.table}' — use ${v.replacement}\n`);
}
console.error(`${violations.length} violation(s). Fix the query, or allowlist it in`);
console.error('scripts/ci/check-deprecated-tables.mjs with a reason.\n');
process.exit(1);
