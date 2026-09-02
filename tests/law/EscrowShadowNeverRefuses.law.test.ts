/**
 * LAW: THE ESCROW SHADOW NEVER REFUSES (Chip Accounting Standard, Lane B)
 * ===========================================================================
 * `docs/CHIP-ACCOUNTING-STANDARD.md` 3.3 R1/R4/R5 describe a tournament escrow
 * that REFUSES a payout at a CHECK constraint and makes prize_pool a derived
 * column. Dan ruled that version HIGH RISK for live play (SWARM-BRIEF-R2 rule
 * 13): a constraint that refuses a legitimate payout strands a player mid
 * tournament. What shipped instead is the SHADOW - it measures what every
 * tournament held versus what it paid, from evidence rows only, and files
 * incidents. It must stay a reporter.
 *
 * This law pins the shape of the migration that created it:
 *   1. `fn_ca_escrow_vs_counter_check` contains no RAISE EXCEPTION. A reporter
 *      that throws inside a cron tick is a reporter that silently stops.
 *   2. Neither function UPDATEs `tournaments` - the counters (`prize_pool`,
 *      `bounty_pool`, `total_rake`) are never written by the shadow. If the
 *      shadow is ever "fixed" to correct a counter it disagrees with, it has
 *      become the eleventh payer's bookkeeper, which is the bug the standard
 *      is chasing.
 *   3. The escrow function reads evidence tables, not counters.
 *   4. The check files incidents through `fn_ca_raise_drift_incident` with the
 *      `escrow:<tournament_id>` dedupe key, at info by default, and the
 *      warning path is capped per run.
 *
 * Every pin carries a negative control so a regex that matches nothing cannot
 * pass by accident.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = [
  'supabase/migrations/20260903013500_the_escrow_shadow_what_every_tournament_held_versus_what_it_paid.sql',
  // Replaced the check function whole (the by_variant rollup read the wrong
  // timestamp). The live body is the LAST one; every pin runs against both.
  'supabase/migrations/20260903014000_the_shadow_summary_reads_its_own_run.sql',
];

const texts = MIGRATIONS.map((m) => fs.readFileSync(path.join(process.cwd(), m), 'utf8'));
const text = texts[0];

/** The body of one CREATE OR REPLACE FUNCTION ... $fn$ ... $fn$; block. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined in the migration`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('$fn$', start);
  const close = source.indexOf('$fn$;', open + 4);
  expect(open, `${name} body opens with $fn$`).toBeGreaterThan(start);
  expect(close, `${name} body closes with $fn$;`).toBeGreaterThan(open);
  return source.slice(open + 4, close);
}

const CHECKS = texts.map((t) => functionBody(t, 'fn_ca_escrow_vs_counter_check'));
const ESCROW = functionBody(text, 'fn_ca_tournament_escrow');

// A counterfeit body that a careless "fix" would produce. Every pin below must
// FAIL against it, or the pin is not actually looking at anything.
const COUNTERFEIT = `
  IF e.prize_balance < 0 THEN
    RAISE EXCEPTION 'escrow short';
  END IF;
  UPDATE public.tournaments SET prize_pool = e.prize_in WHERE id = r.id;
`;

const RAISES = /RAISE\s+EXCEPTION/i;
const WRITES_TOURNAMENTS = /UPDATE\s+(public\.)?tournaments\b/i;
const WRITES_PRIZE_POOL = /\bSET\s+[^;]*\bprize_pool\s*=/i;

describe('the escrow shadow never refuses', () => {
  it('the check function contains no RAISE EXCEPTION', () => {
    for (const CHECK of CHECKS) expect(CHECK).not.toMatch(RAISES);
    // Negative control: the pattern does catch a refusal when one is written.
    expect(COUNTERFEIT).toMatch(RAISES);
  });

  it('the check function never writes tournaments (no counter is corrected)', () => {
    for (const CHECK of CHECKS) {
      expect(CHECK).not.toMatch(WRITES_TOURNAMENTS);
      expect(CHECK).not.toMatch(WRITES_PRIZE_POOL);
    }
    expect(COUNTERFEIT).toMatch(WRITES_TOURNAMENTS);
    expect(COUNTERFEIT).toMatch(WRITES_PRIZE_POOL);
  });

  it('the live check body reads its own run for the per-variant rollup', () => {
    expect(CHECKS[CHECKS.length - 1]).toMatch(/checked_at >= v_run_now/);
    expect(CHECKS[0]).not.toMatch(/checked_at >= v_run_now/);
  });

  it('the escrow function is read-only and reads evidence rows, not counters', () => {
    expect(ESCROW).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
    expect(ESCROW).not.toMatch(/\bprize_pool\b/);
    expect(ESCROW).not.toMatch(/\btotal_rake\b/);
    expect(ESCROW).not.toMatch(/\bbounty_pool\b/);
    for (const evidence of [
      'public.wallet_transactions',
      'public.rake_records',
      'public.chip_ledger',
      'public.tournament_guarantee_overlays',
      'public.tournament_payouts',
      'public.tournament_rake_settlements',
    ]) {
      expect(ESCROW, `escrow reads ${evidence}`).toContain(evidence);
    }
    // Negative control: a body that reads the counter would be caught.
    expect('SELECT prize_pool FROM public.tournaments').toMatch(/\bprize_pool\b/);
  });

  it('the migration keeps its own post-apply guard for the same two rules', () => {
    // The DO $verify$ block re-checks the live body after CREATE, so a later
    // migration replacing the function without this law is still caught once.
    for (const t of texts) {
      expect(t).toMatch(/the shadow check must never raise/);
      expect(t).toMatch(/the shadow check must never write a counter/);
    }
  });
});

describe('one incident per tournament, info by default, warnings capped', () => {
  it('files through fn_ca_raise_drift_incident with the escrow:<id> dedupe key', () => {
    for (const CHECK of CHECKS) {
      expect(CHECK).toMatch(/public\.fn_ca_raise_drift_incident\(/);
      expect(CHECK).toMatch(/'escrow:' \|\| r\.id::text/);
    }
    expect(COUNTERFEIT).not.toMatch(/fn_ca_raise_drift_incident/);
  });

  it('defaults to info and only escalates a prize residual under -1.00 to warning', () => {
    for (const CHECK of CHECKS) {
      expect(CHECK).toMatch(/v_sev := 'info';/);
      expect(CHECK).toMatch(/IF e\.prize_balance < -1\.00 THEN/);
      expect(CHECK).not.toMatch(/'critical'/);
    }
  });

  it('caps warnings per run so a backlog can never storm', () => {
    for (const CHECK of CHECKS) {
      expect(CHECK).toMatch(/v_warn < GREATEST\(COALESCE\(p_warning_cap, 5\), 0\)/);
      expect(CHECK).toMatch(/v_warn_capped := v_warn_capped \+ 1;/);
    }
  });

  it('spins are computed but not asserted (reserve-funded, another lane owns them)', () => {
    for (const CHECK of CHECKS) expect(CHECK).toMatch(/COALESCE\(r\.variant, ''\) <> 'spin'/);
  });

  it('is scheduled hourly at :35 under the name the brief fixed', () => {
    expect(text).toMatch(/'ca-escrow-shadow-hourly',\s*'35 \* \* \* \*'/);
  });
});
