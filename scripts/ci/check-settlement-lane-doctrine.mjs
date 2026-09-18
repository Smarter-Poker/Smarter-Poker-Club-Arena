#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SETTLEMENT LANE DOCTRINE IS ASKED OF THE LIVE CATALOG
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS (2026-09-17)
 * The tournament settlement lane is a set of advisory keys with one order:
 * G (platform), F (finishes), T(id) (one event), then table_cap keys, then
 * the club wallet row, then rows. Three migrations in a week moved hot paths
 * off G-exclusive (rolling authorities on 2026-09-10, finishes and then
 * sweeps and satellites on 2026-09-17), and each time the previous shape had
 * been put there by someone who could not see the whole graph. Every one of
 * those migrations re-proved the graph inside its own transaction and then
 * stopped proving it: the next function to take the global lane in a loop
 * would have gone unnoticed until the platform stalled behind it again.
 * `public.fn_ca_settlement_lane_doctrine()` asks the live catalog the same
 * four questions the migrations asked, and this makes CI ask it:
 *   1. G is taken exclusively only by the two lane helpers.
 *   2. F is named only by the three finish-lane helpers.
 *   3. Every function naming the global helper is a reviewed global authority.
 *   4. No rolling authority reaches the global lane within four calls.
 * A new global-lane caller fails here until somebody reads it for what it
 * writes and adds it to the reviewed list inside the doctrine function, which
 * is the review the lane needs. This asks production because migrations are
 * applied to production before their pull request merges (see
 * check-migrations-applied.mjs), so the live catalog IS the branch's truth.
 * Usage:  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/ci/check-settlement-lane-doctrine.mjs
 * Exit:   0 doctrine holds · 1 a violation · 2 could not ask (NEVER silently green)
 */
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('[check-settlement-lane-doctrine] set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(2);
}

let res;
try {
  res = await fetch(`${URL}/rest/v1/rpc/fn_ca_settlement_lane_doctrine`, {
    method: 'POST',
    headers: supabaseServerHeaders(KEY, { 'Content-Type': 'application/json' }),
    body: '{}',
    signal: AbortSignal.timeout(60_000),
  });
} catch (error) {
  console.error(`[check-settlement-lane-doctrine] could not ask: ${error?.message ?? error}`);
  process.exit(2);
}
if (!res.ok) {
  console.error(
    `[check-settlement-lane-doctrine] fn_ca_settlement_lane_doctrine answered ${res.status}: ${await res.text()}`
  );
  process.exit(2);
}
const answer = await res.json();
if (!answer || typeof answer !== 'object' || typeof answer.ok !== 'boolean') {
  console.error('[check-settlement-lane-doctrine] malformed answer', JSON.stringify(answer));
  process.exit(2);
}
if (answer.ok) {
  console.log(
    `[check-settlement-lane-doctrine] OK - the lane doctrine holds on the live catalog (${answer.checked_at}).`
  );
  process.exit(0);
}
console.error(
  '[check-settlement-lane-doctrine] BLOCKED - the live catalog breaks the settlement lane doctrine:'
);
for (const v of answer.violations ?? []) {
  console.error(`  ${v.rule}: ${v.found}`);
}
console.error(
  '\n  A function took the global lane, named the finish lane, or reached the global\n' +
    '  lane from a rolling authority. Read it for what it writes: a per-tournament\n' +
    '  writer takes fn_ca_lock_settlement_lane_for_tournament or the finish lane; a\n' +
    '  cross-tournament writer is reviewed and added to the list inside\n' +
    '  public.fn_ca_settlement_lane_doctrine() in the same migration.\n' +
    '  See docs/terminal-settlement-lane-per-tournament-plan-2026-09-17.md.'
);
process.exit(1);
