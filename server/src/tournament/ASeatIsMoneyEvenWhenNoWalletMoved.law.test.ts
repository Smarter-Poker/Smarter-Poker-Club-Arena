/**
 * A SEAT IS MONEY EVEN WHEN NO WALLET MOVED (2026-09-02, Phase 4 of 6).
 *
 * A satellite seat is the one way money enters a tournament without a wallet
 * moving, and for that reason the conservation check could not see it - on
 * EITHER side.
 *
 * THE NUMBERS BELOW ARE MEASURED, NOT ILLUSTRATIVE.
 * `fn_award_satellite_seat` credits the target's prize_pool with the target's
 * buy_in and its total_rake with the target's fee, and pays the satellite's
 * winner in a seat instead of chips. `fn_tournament_conservation_delta` read
 * `wallet_transactions` debits for money_in, so:
 *
 *   * THE TARGET looked like it "paid out money it never collected". "Sunday
 *     $200 Deep Stack" read -4,780.00, of which -4,600.00 was exactly 23 seats
 *     x 200. The remaining -180.00 is a bubble-protection credit and is not
 *     this law's business.
 *   * THE SATELLITE looked like it "retained money it never paid out". Across
 *     all 11 satellites that have ever awarded a seat, the delta equalled the
 *     seat value paid EXACTLY, to the cent, 11 times out of 11.
 *
 * The money was always conserved. The CHECK was blind, symmetrically, and the
 * two blindnesses were the same 4,600.00 seen from opposite ends.
 *
 * AND SATELLITES WERE EXCLUDED FROM THE SCAN ENTIRELY, which is what made it
 * dangerous rather than untidy: a satellite that genuinely failed to award or
 * to pay would have raised nothing at all. That is the Phase 1 shape - a check
 * that cannot see the thing it exists for - and widening the delta without
 * also widening the scan would have fixed the arithmetic while leaving the
 * blindness in place.
 *
 * Each pin below is one of the ways that blindness gets back in. Fix your
 * change; never weaken a pin.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { sliceSqlStatement } from '../testHelpers/sourceWindow.js';

const MIG = (f: string) =>
  readFileSync(join(__dirname, '../../../supabase/migrations/', f), 'utf8');

/**
 * The migration holding the bodies production actually runs.
 *
 * WHEN EITHER FUNCTION IS CHANGED AGAIN, point these at the newest migration
 * in the SAME COMMIT and move LIVE_BODY_MIGRATION with them. A pin that has
 * drifted off the live body is worse than no pin, because it still reports
 * success - which is exactly what happened twice to the Phase 2 file before
 * the guard below existed.
 */
const LIVE_BODY_MIGRATION = '20260902155525';
const SOURCE = MIG('20260902155525_a_seat_is_money_even_when_no_wallet_moved.sql');

const DELTA = sliceSqlStatement(
  SOURCE,
  'CREATE OR REPLACE FUNCTION public.fn_tournament_conservation_delta'
);
const SCAN = sliceSqlStatement(
  SOURCE,
  'CREATE OR REPLACE FUNCTION public.fn_tournament_money_conservation'
);

const migrationsDefining = (signature: string): string[] => {
  const dir = join(__dirname, '../../../supabase/migrations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => readFileSync(join(dir, f), 'utf8').includes(signature))
    .sort();
};

describe('the pins read the bodies production is running', () => {
  it.each([['fn_tournament_conservation_delta'], ['fn_tournament_money_conservation']])(
    'the newest migration defining %s is the one the pins read',
    (name) => {
      // MOVING THE POINTER BY HAND IS NOT A FIX, IT IS THE SAME BUG DEFERRED.
      const defining = migrationsDefining(`CREATE OR REPLACE FUNCTION public.${name}`);
      expect(defining.length, `no migration defines ${name}`).toBeGreaterThan(0);

      const newest = defining[defining.length - 1];
      expect(
        newest.startsWith(LIVE_BODY_MIGRATION),
        `the newest migration defining ${name} is ${newest}, but the pins read ` +
          `${LIVE_BODY_MIGRATION}. Point them at the newest one and update ` +
          `LIVE_BODY_MIGRATION, in the commit that changed the function.`
      ).toBe(true);
    }
  );
});

describe('a seat is counted on both sides, or it is counted on neither', () => {
  it('the target is credited with the seat that funded its pool', () => {
    // The payout row belongs to the SATELLITE that paid it, so the target is
    // found through metadata. Get this key wrong and seat_income is silently
    // 0 everywhere - the migration asserts against exactly that.
    expect(DELTA).toContain("sp.metadata->>'satellite_target_id' = t.id::text");
    // Anchored to end of line: an unanchored /AS seat_income/ also matches
    // `AS seat_income_renamed`, which is a pin that cannot fail. Caught by
    // negative control, which is the only reason a pin is worth writing.
    expect(DELTA).toMatch(/AS seat_income,$/m);
  });

  it('the satellite is debited with the seat it paid out', () => {
    expect(DELTA).toMatch(/sp\.tournament_id = t\.id\), 0\) AS seat_paid_out$/m);
  });

  it('both terms reach the arithmetic, with the signs that make them cancel', () => {
    // A term defined in the CTE and left out of the SELECT is the quietest
    // possible way to undo this fix.
    expect(DELTA).toMatch(/\+ m\.seat_income/);
    expect(DELTA).toMatch(/- m\.seat_paid_out/);
  });

  it('reads ONE witness, so a seat can never be counted twice', () => {
    // Unlike the Phase 2 exemptions - which enumerate three witnesses because
    // each has a birthday - a seat carries BOTH a tournament_payouts row and
    // (when the target charges a fee) a rake_records row. Reading both here
    // would double-count. tournament_payouts is canonical: it is written in
    // the same transaction as the seat, and Phase 2 back-filled the 23 seats
    // awarded before that block existed, so it is complete.
    expect(DELTA).toContain("sp.source = 'satellite_seat'");
    const seatWitnesses = DELTA.match(/FROM public\.tournament_payouts sp/g) ?? [];
    expect(seatWitnesses).toHaveLength(2);
    expect(DELTA).not.toContain("r.source = 'fn_award_satellite_seat'");
  });
});

describe('the scan can see the events the delta now balances', () => {
  it('satellites are scanned', () => {
    // Matched on the CODE form. The bare word appears in the commentary right
    // above this clause, and an assertion against the bare word would pass on
    // the prose while the exclusion sat untouched three lines below - the
    // self-refusing assertion this workstream has now written three times.
    expect(SCAN).not.toContain("NOT IN ('spin', 'satellite')");
    expect(SCAN).not.toContain("NOT IN ('spin','satellite')");
    expect(SCAN).toContain("COALESCE(t.variant, '') NOT IN ('spin')");
  });

  it('spins stay out, and for a stated reason', () => {
    // A Spin's pool is funded by the Reserve Pool rather than by its own
    // collections, so its delta does not mean what it means elsewhere. It has
    // its own check. Widening the scan to spins is a different decision and
    // must not ride along on this one.
    expect(SCAN).toContain("'spin'");
    expect(SCAN).toMatch(/Reserve Pool/);
  });
});

describe('the delta observes and never pays', () => {
  it('moves no money', () => {
    // A detector that can pay is a detector that can overpay. The crediting
    // functions and every write to a balance are absent by construction: this
    // is a STABLE sql function, and the migration only ever replaces it as one.
    for (const forbidden of [
      'fn_credit_and_log',
      'fn_credit_player_wallet_once',
      'fn_add_chips',
      'INSERT INTO',
      'UPDATE public.club_members',
      'UPDATE public.tournaments',
    ]) {
      expect(DELTA, `the delta must not contain ${forbidden}`).not.toContain(forbidden);
    }
    expect(DELTA).toMatch(/LANGUAGE sql\s+STABLE/);
  });

  it('stays service_role only', () => {
    // Browser-reachable money arithmetic is how an IDOR becomes a ledger.
    expect(SOURCE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_tournament_conservation_delta(uuid) FROM PUBLIC'
    );
    expect(SOURCE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_tournament_conservation_delta(uuid) TO service_role'
    );
  });
});

describe('the migration proves its own claim before it is believed', () => {
  it('asserts the seat-income term actually matched rows', () => {
    // THE ASSERTION THAT MATTERS MOST. A wrong metadata key leaves seat_income
    // at 0 everywhere; every other assertion still passes; the migration
    // reports a fix it did not make.
    expect(SOURCE).toContain(
      'seat income term matched nothing: no satellite_seat payout names a target'
    );
  });

  it('asserts the blindness signature is gone, not merely that nothing threw', () => {
    expect(SOURCE).toContain('satellites that paid seats and still do not balance');
  });

  it('asserts on structure, never on wall clock', () => {
    // Wall clock on this database swings 10x with load; a timing gate in a
    // migration is flaky by construction and teaches everyone to re-run
    // migrations until they pass.
    expect(SOURCE).not.toMatch(/duration_ms\s*>\s*\d+/);
    expect(SOURCE).not.toMatch(/not inside its budget/);
  });
});
