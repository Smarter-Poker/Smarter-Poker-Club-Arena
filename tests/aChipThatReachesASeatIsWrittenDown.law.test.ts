/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CHIP THAT REACHES A SEAT IS WRITTEN DOWN, AND A METER READS ONE INSTANT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The kill switch tripped on the felt: 4,379.10 chips the journal could not
 * account for, 6,504.34 over two days. Two separate faults, pinned here so a
 * later edit cannot quietly reintroduce either.
 *
 * 1. THE LEG THAT CANCELLED ITSELF. bbj_credit_one_recipient says in its own
 *    comment that "the felt is a derived account: the pool debit (bbj_pool ->
 *    table_stack) is the leg, and the seat row simply holds the chips".
 *    fn_bbj_mini_payout declared bbj_pool as its OWN counterparty before
 *    debiting bbj_pool, so the autoledger wrote bbj_pool -> bbj_pool and the
 *    movement vanished. Twelve payouts, 6,750.00 chips, against a felt residue
 *    of 1,825.00 and 4,225.00 on the two days the mini jackpot ran.
 *
 * 2. THE READER THAT LOST CHIPS OF ITS OWN. fn_ca_ledger_replay read the
 *    balance at one instant and the journal window at another, seconds apart,
 *    on an account with 371 seats and 340,000 legs a day. It must read both in
 *    one statement, and the mark it leaves for the next run must be captured
 *    BEFORE that statement - a per-row clock_timestamp() cost -100.60 chips on
 *    the very first run after the rewrite.
 *
 * The same one-instant rule is asserted for the meters that had the same bug.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');
const readMigration = (fragment: string): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(fragment));
  expect(file, `no migration matching ${fragment}`).toBeTruthy();
  return readFileSync(resolve(MIGRATIONS, file as string), 'utf8');
};

const JACKPOT = readMigration('the_mini_jackpot_pays_the_felt_and_the_journal_says_so');
const REPLAY = readMigration('the_replay_reads_the_balance_and_the_journal_at_one_instant');
const MARK = readMigration('the_mark_a_reading_leaves_is_where_the_reading_started');
const ONE_MARK = readMigration('every_account_read_in_one_run_carries_one_mark');
const DRILL = readMigration('a_drill_that_could_not_arm_is_not_a_silent_detector');
const SUSPENSE = readMigration('suspense_is_a_corridor_not_a_room');
const SCALAR = readMigration(
  'a_standing_incident_says_what_it_is_now_and_a_scalar_check_is_counted'
);
const EPOCH = readMigration(
  'the_jackpot_epoch_is_measured_end_to_end_not_summed_interval_by_interval'
);
const STRADDLE = readMigration(
  'a_jackpot_drop_that_straddled_a_reading_is_counted_at_the_next_one'
);
const PAYOUT = readMigration('a_payout_row_is_not_a_payment_and_the_detector_counts_chips');

describe('a chip that reaches a seat is written down', () => {
  it('the mini jackpot names the felt, not itself, as the counterparty', () => {
    expect(JACKPOT).toContain("fn_ca_declare_ledger('bbj_payout', 'table_stack', p_table_id");
    // The migration quotes the old declaration as its search anchor, so the
    // proof it is gone is the assertion the migration makes about the LIVE
    // function after replacing it - and refuses to commit if it is still there.
    expect(JACKPOT).toContain(
      "IF position($chk$'bbj_payout', 'bbj_pool', p_pool_id$chk$ IN v_src) <> 0"
    );
    expect(JACKPOT).toContain('fn_bbj_mini_payout did not take the counterparty fix');
  });

  it('refuses to apply unless the old declaration is where it was read', () => {
    expect(JACKPOT).toContain('the mini payout declaration was not found where it was read');
  });

  it('posts the twelve missing legs, both pools, to the cent', () => {
    expect(JACKPOT).toContain('5625.00');
    expect(JACKPOT).toContain('1125.00');
    expect(JACKPOT).toContain(
      'the corrections do not add up to the 6,750.00 the mini jackpots paid'
    );
  });

  it('posts them through the correction door, linked to the incidents they close', () => {
    expect(JACKPOT).toContain('fn_ca_post_correction');
    expect(JACKPOT).toContain('c_inc_replay');
    expect(JACKPOT).toContain('c_inc_kill');
  });
});

describe('a meter reads its balance and its journal at one instant', () => {
  it('the replay lets the statement snapshot end the window', () => {
    expect(REPLAY).toContain("fn_ca_leg_accounts(v_at, 'infinity'::timestamptz)");
    expect(REPLAY).toContain('one-snapshot-v2');
  });

  it('the balance is read in the same statement as the legs', () => {
    const legsAt = REPLAY.indexOf('WITH legs AS MATERIALIZED');
    const balanceAt = REPLAY.indexOf('public.fn_ca_account_balance(t.account_type');
    expect(legsAt).toBeGreaterThan(0);
    expect(balanceAt).toBeGreaterThan(legsAt);
  });

  it('the mark it leaves is captured before the statement, not inside it', () => {
    expect(MARK).toContain('v_read_at := clock_timestamp();');
    expect(MARK).toContain('clock_timestamp() evaluated per row');
    expect(MARK).toContain('fn_ca_ledger_replay did not take the read-mark fix');
  });

  it('every account read in one run carries one mark', () => {
    expect(ONE_MARK).toContain('one mark for the whole run');
    expect(ONE_MARK).toContain("SET statement_timeout TO '540s'");
  });

  it('a change of basis rebaselines instead of reading as drift', () => {
    expect(REPLAY).toContain('A CHANGE OF BASIS IS NOT DRIFT');
    expect(REPLAY).toContain('basis_version');
  });

  it('the jackpot epoch is one end-to-end comparison, not a sum of intervals', () => {
    expect(EPOCH).toContain('END TO END, NOT INTERVAL BY INTERVAL');
    expect(EPOCH).toContain('epoch_residue');
  });

  it('the jackpot meter windows from the opening balance so a straddle is caught next time', () => {
    expect(STRADDLE).toContain('FROM THE OPENING BALANCE, NOT THE LAST READING');
    expect(STRADDLE).toContain('CUMULATIVE SINCE THE OPENING BALANCE');
  });
});

describe('a drill that could not arm is not a silent detector', () => {
  it('the drill exempts its own transaction from the maintenance freeze', () => {
    expect(DRILL).toContain("set_config('app.freeze_bypass', 'on', true)");
  });

  it('reports could-not-arm separately from stayed-silent', () => {
    expect(DRILL).toContain('THE ALARM DRILL COULD NOT ARM');
    expect(DRILL).toContain('THE ALARM DRILL FAILED');
    expect(DRILL).toContain('v_unarmed');
    expect(DRILL).toContain('v_silent');
  });

  it('does not run on the hour the freeze owns', () => {
    expect(DRILL).toContain("'7 11 * * 1'");
  });

  it('an arm proves its own detector, not the board history', () => {
    expect(SUSPENSE).toContain('v_ok := public.fn_ca_suspense_regression_check() > 0;');
    // Same shape: the old assertion is quoted as the anchor, and the migration
    // refuses to commit unless it is gone from the live drill.
    expect(SUSPENSE).toContain("position($chk$LIKE 'suspense-regression:%'$chk$ IN v_src) <> 0");
    expect(SUSPENSE).toContain('did not take the arm-1/arm-2 fixes');
  });
});

describe('a check is measured by what it returns', () => {
  it('suspense is judged on what it keeps, not what passes through', () => {
    expect(SUSPENSE).toContain('suspense kept');
    expect(SUSPENSE).toContain("FILTER (WHERE to_type = 'settlement_suspense')");
    expect(SUSPENSE).not.toMatch(/v_rows > 10 OR v_chips > 50/);
  });

  it('a scalar check is read as a scalar', () => {
    expect(SCALAR).toContain('unstamped_union_tables');
    expect(SCALAR).toContain('jsonb_array_length(v.j)');
  });

  it('a standing incident is refreshed rather than frozen at first sight', () => {
    expect(SCALAR).toContain('suspected_cause    = COALESCE(p_suspected_cause, suspected_cause)');
    expect(SCALAR).toContain('expected 3 cause-refresh sites');
  });

  it('a payment is a registered credit, not a payout row', () => {
    expect(PAYOUT).toContain('wallet_credit_idempotency');
    expect(PAYOUT).toContain('fn_ca_payout_rows_without_money');
    expect(PAYOUT).toContain('the double-paid detector still reports');
  });
});
