/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A POOL THAT IS PAID OWES NOBODY, AND A FINISHED SATELLITE CAN SETTLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two money guards added 2026-09-09, pinned to their migrations so a later
 * edit cannot quietly drop them.
 *
 * 1. `fn_tournament_payout_reconcile` distributed the whole prize_pool across
 *    the RANKED places and never looked at payouts made outside that structure
 *    (`position IS NULL`: bubble protection, final-table deals). On six events
 *    whose pools were paid to the cent it claimed five players were owed money
 *    the pool had already paid, and on one it wanted to top a final-table-deal
 *    winner up by the LOSER's share. Only the escrow cap stopped it.
 *
 * 2. 22 finished satellites could not settle at all: the settler needs an
 *    entry-close receipt, and the only writer of that receipt refuses once the
 *    tournament leaves RUNNING. 1,919.00 chips sat frozen for up to 27 hours.
 *    The eleven that then hit the concurrent-game cap are paid in cash - the
 *    fifth of five undeliverable-seat cases the delivery function handles.
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

const RECONCILE = readMigration('a_pool_that_is_fully_paid_owes_nobody_a_top_up');
const SATELLITE = readMigration('a_finished_satellite_must_be_able_to_settle');
const CASH = readMigration('a_seat_the_winner_cannot_take_is_paid_as_cash');

describe('a pool that has paid out its whole self owes no top-up', () => {
  it('counts payouts made outside the ranked structure', () => {
    expect(RECONCILE).toMatch(/tpo\."position" IS NULL/);
    expect(RECONCILE).toContain('v_unranked_paid');
  });

  it('refuses to reconcile an event settled by a final-table deal', () => {
    expect(RECONCILE).toContain("'settled_by_final_table_deal'");
    expect(RECONCILE).toMatch(/tpo\.source = 'final_table_deal'/);
  });

  it('stops before computing an expectation, not after', () => {
    // Both guards must sit ahead of the per-place loop, or the function will
    // still file the obligation it is meant not to file.
    const dealAt = RECONCILE.indexOf('settled_by_final_table_deal');
    const dischargedAt = RECONCILE.indexOf('pool_fully_discharged');
    const anchorAt = RECONCILE.indexOf('INTO v_has_record');
    expect(dealAt).toBeGreaterThan(anchorAt);
    expect(dischargedAt).toBeGreaterThan(anchorAt);
  });

  it('asserts both guards actually fire against real events before committing', () => {
    expect(RECONCILE).toContain('the deal guard did not fire on PLO4 Heads-Up 25');
    expect(RECONCILE).toContain('the discharged-pool guard did not fire on a449e853');
  });

  it('writes the phantom obligations down to what was paid, never up', () => {
    expect(RECONCILE).toMatch(/SET amount_owed = o\.amount_paid/);
    expect(RECONCILE).toMatch(/wrote %/); // exact-count assertion
  });
});

describe('a finished satellite can settle', () => {
  it('backfills the entry-close receipt only from finalized, snapshotted state', () => {
    expect(SATELLITE).toMatch(/prize_pool_finalized,false\) = true/);
    expect(SATELLITE).toContain('tournament_satellite_economic_snapshots');
    expect(SATELLITE).toContain('tournament_entry_close_receipts');
  });

  it('settles each satellite in its own subtransaction', () => {
    // One refusal must never roll back another satellite's payment.
    expect(SATELLITE).toMatch(
      /BEGIN[\s\S]{0,400}fn_settle_satellite_finish_atomic[\s\S]{0,300}EXCEPTION WHEN OTHERS/
    );
  });
});

describe('a seat the winner cannot take is paid as cash', () => {
  it('adds the cap as a fifth cash fallback', () => {
    expect(CASH).toContain('winner_at_concurrent_game_cap');
    expect(CASH).toMatch(/delivery','cash'/);
  });

  it('converts ONLY the concurrent-game cap, never another check violation', () => {
    expect(CASH).toMatch(/IF SQLERRM LIKE '%FOUR TABLE LIMIT%' THEN/);
    expect(CASH).toMatch(/RAISE;/); // everything else still aborts
  });

  it('refuses to edit unless all four existing cash fallbacks are present', () => {
    for (const reason of [
      'target_missing',
      'target_not_open',
      'target_economics_changed',
      'seat_already_held_elsewhere',
    ]) {
      expect(CASH).toContain(reason);
    }
    expect(CASH).toContain('the existing cash fallbacks are not all present');
  });

  it('keeps the money-exactness landmarks of the seat path', () => {
    expect(CASH).toContain('exact target-seat award refused or wrote incomplete money');
    expect(CASH).toContain('target seat, payout and pool transfer are not one exact event');
  });
});
