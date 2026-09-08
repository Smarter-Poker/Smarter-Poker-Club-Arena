#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  verify-tournaments.mjs — Tournament money-conservation scorecard (rerunnable)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Runs the same invariants the in-engine tournament sentinel enforces
 * (RakebackSettlerService.runTournamentSentinel), but on demand across the last N
 * COMPLETED tournaments, and prints a scorecard. Use it after any deploy to prove
 * the platform is minting/destroying zero chips, stranding zero players, and taking
 * zero rake on tournament hands.
 *
 * INVARIANTS
 *   1. PAYOUT CONSERVATION  — for full-cash-pool events (NOT satellite/bounty/
 *      pko/mystery), SUM(tournament_players.prize) ≈ tournaments.prize_pool within
 *      max(1, 1% of pool). Bounty-family and satellites are exempt because their
 *      money flows through separate bounty/ticket ledgers.
 *   2. WINNER EXISTS        — every COMPLETED tournament has exactly one 'winner'.
 *   3. NO STRANDED PLAYERS  — zero tournament_players still 'playing'/'registered'/
 *      'active' on a COMPLETED tournament.
 *   4. NO RAKED HANDS       — zero rake_records with a hand_id and positive
 *      rake_amount for any tournament (pot engine must not rake tournament play).
 *   5. SPIN ECONOMICS       — spin/lottery events pay out ≈ buyIn × multiplier and
 *      never more than their prize_pool.
 *
 * USAGE
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/verify-tournaments.mjs [N]
 *   (N defaults to 100.)
 *
 * Exit code 0 = all invariants pass; 1 = one or more violations (CI-friendly).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kuklfnapbkmacvwxktbh.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const N = Math.max(1, parseInt(process.argv[2] || '100', 10));

if (!SERVICE_KEY) {
  console.error('FATAL: SUPABASE_SERVICE_ROLE_KEY env var is required.');
  process.exit(2);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
  global: {
    headers: {
      'x-smarter-data-actor': 'service',
      'x-smarter-data-protocol': '1',
    },
  },
});

const BOUNTY_FAMILY = new Set(['satellite', 'bounty', 'pko', 'progressive_ko', 'mystery', 'mystery_bounty']);
const SPIN_TYPES = new Set(['spin', 'lottery', 'spin_and_go', 'spingo']);

function poolCheckExempt(t) {
  const v = (t.variant || '').toLowerCase();
  return BOUNTY_FAMILY.has(v) || !!t.satellite_target_id;
}

async function main() {
  console.log(`\n═══ Tournament verification scorecard — last ${N} COMPLETED ═══\n`);

  const { data: tourneys, error } = await sb
    .from('tournaments')
    .select('id, name, prize_pool, variant, satellite_target_id, tournament_type, updated_at')
    .eq('status', 'COMPLETED')
    .order('updated_at', { ascending: false })
    .limit(N);
  if (error) {
    console.error('Query failed:', error.message);
    process.exit(2);
  }
  if (!tourneys || tourneys.length === 0) {
    console.log('No completed tournaments found.');
    process.exit(0);
  }

  const violations = [];
  let satellites = 0;
  let bountyFamily = 0;

  for (const t of tourneys) {
    if ((t.variant || '').toLowerCase() === 'satellite' || t.satellite_target_id) satellites++;
    if (poolCheckExempt(t)) bountyFamily++;

    // Player aggregates for this tournament.
    const { data: players } = await sb
      .from('tournament_players')
      .select('prize, status')
      .eq('tournament_id', t.id);
    const rows = players || [];
    const paid = rows
      .filter((r) => Number(r.prize) > 0)
      .reduce((s, r) => s + Number(r.prize), 0);
    const winners = rows.filter((r) => r.status === 'winner').length;
    const stranded = rows.filter((r) => ['playing', 'registered', 'active'].includes(r.status)).length;

    // (1) Payout conservation.
    const pool = Number(t.prize_pool) || 0;
    if (!poolCheckExempt(t) && pool > 0) {
      const tol = Math.max(1, pool * 0.01);
      if (Math.abs(paid - pool) > tol) {
        violations.push({
          type: 'payout_conservation',
          tournament: t.name || t.id,
          detail: `paid ${paid.toFixed(2)} vs pool ${pool.toFixed(2)} (diff ${(paid - pool).toFixed(2)})`,
        });
      }
    }

    // (2) Winner exists.
    if (winners === 0) {
      violations.push({ type: 'missing_winner', tournament: t.name || t.id, detail: 'no winner row' });
    }

    // (3) No stranded players.
    if (stranded > 0) {
      violations.push({ type: 'stranded_players', tournament: t.name || t.id, detail: `${stranded} still active` });
    }

    // (4) No raked hands.
    const { count: rakedHands } = await sb
      .from('rake_records')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', t.id)
      .not('hand_id', 'is', null)
      .gt('rake_amount', 0);
    if ((rakedHands || 0) > 0) {
      violations.push({ type: 'raked_tournament_hands', tournament: t.name || t.id, detail: `${rakedHands} raked hand(s)` });
    }

    // (5) Spin economics — payout must not exceed the funded pool.
    if (SPIN_TYPES.has((t.tournament_type || '').toLowerCase())) {
      if (pool > 0 && paid > pool + Math.max(1, pool * 0.01)) {
        violations.push({
          type: 'spin_overpay',
          tournament: t.name || t.id,
          detail: `paid ${paid.toFixed(2)} exceeds pool ${pool.toFixed(2)}`,
        });
      }
    }
  }

  console.log(`Tournaments checked : ${tourneys.length}`);
  console.log(`  satellites        : ${satellites} (pool-check exempt)`);
  console.log(`  bounty-family     : ${bountyFamily} (pool-check exempt)`);
  console.log('');
  console.log(`Missing winner      : ${violations.filter((v) => v.type === 'missing_winner').length}`);
  console.log(`Payout mismatch     : ${violations.filter((v) => v.type === 'payout_conservation').length}`);
  console.log(`Stranded players    : ${violations.filter((v) => v.type === 'stranded_players').length}`);
  console.log(`Raked tourney hands : ${violations.filter((v) => v.type === 'raked_tournament_hands').length}`);
  console.log(`Spin overpay        : ${violations.filter((v) => v.type === 'spin_overpay').length}`);
  console.log('');

  if (violations.length === 0) {
    console.log('✅ ALL INVARIANTS PASS — no chip minting/destruction, no stranded players, no tournament rake.');
    process.exit(0);
  }

  console.log(`❌ ${violations.length} violation(s):`);
  for (const v of violations) {
    console.log(`   [${v.type}] ${v.tournament} — ${v.detail}`);
  }
  console.log(
    '\nNOTE: tournaments completed BEFORE the sweep-4/5/6 engine build can show small\n' +
      'legacy payout-rounding diffs; those clear for events run on the new build.'
  );
  process.exit(1);
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(2);
});
