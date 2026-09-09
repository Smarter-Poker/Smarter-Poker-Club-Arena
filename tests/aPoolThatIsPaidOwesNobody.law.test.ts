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
 *    A later live patch converted a concurrent-game cap into cash. That is
 *    preserved only as history: the atomic authority now holds a cap-blocked
 *    full award as a target-scoped tournament ticket, never wallet chips.
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
const ATOMIC = readMigration('satellite_settlement_has_one_atomic_authority');

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

describe('a four-table cap preserves the award as a noncash ticket', () => {
  it('serializes each winner cap decision before classifying delivery', () => {
    const locks = ATOMIC.indexOf('FOR v_cap_user_id IN');
    const plan = ATOMIC.indexOf('FOR v_place IN 1..v_ticket_award_count', locks);
    expect(locks).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(locks);
    expect(ATOMIC.slice(locks, plan)).toContain('ORDER BY tp.user_id');
    expect(ATOMIC.slice(locks, plan)).toContain("hashtextextended('table_cap:'");
  });

  it('classifies a capped winner as ticket, not cash or a fifth table', () => {
    expect(ATOMIC).toContain('v_cap_load:=public.fn_concurrent_game_load(');
    expect(ATOMIC).toContain('IF v_cap_load>=4 THEN');
    expect(ATOMIC).toContain("v_delivery_kind := 'ticket'");
    expect(ATOMIC).not.toContain('winner_at_concurrent_game_cap');
  });

  it('moves the source-pool value into immutable ticket escrow with no wallet credit', () => {
    const start = ATOMIC.indexOf("ELSIF v_delivery_kind = 'ticket' THEN");
    const end = ATOMIC.indexOf("ELSIF v_delivery_kind = 'cash' THEN", start);
    const ticket = ATOMIC.slice(start, end);
    expect(ticket).toContain('INSERT INTO public.tournament_tickets');
    expect(ticket).toContain("'tournament_entry_only', v_target_id, p_tournament_id");
    expect(ticket).toContain("'prize_liability', p_tournament_id");
    expect(ticket).toContain("'escrow', v_ticket_id");
    expect(ticket).toContain('p_prize_out => v_ticket_cost');
    expect(ticket).not.toContain('fn_credit_and_log');
  });

  it('keeps direct-ticket provenance target-scoped and one-to-one', () => {
    expect(ATOMIC).toContain('source_satellite_award_place integer');
    expect(ATOMIC).toContain('tournament_tickets_direct_satellite_award_fkey');
    expect(ATOMIC).toContain('tournament_ticket_one_direct_satellite_award');
    expect(ATOMIC).toContain('tk.source_tournament_id IS DISTINCT FROM v_h.target_id');
    expect(ATOMIC).toContain("'entry_ticket_count', v_h.entry_ticket_count");
  });
});
