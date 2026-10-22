/**
 * A TOURNAMENT FINISHER IS PAID THE MOMENT THEY BUST.
 *
 * Dan, 2026-10-21: "PAYOUTS FOR TOURNAMENTS WHEN A PLAYER BUSTS NEEDS TO BE
 * REAL TIME PAYOUT, IT SHOULD NOT WAIT UNTIL THE END OF THE TOURNAMENT FOR A
 * PLAYER TO GET PAID. THEY SHOULD GET THE CHIPS SENT TO THERE ACCOUNT AS SOON
 * AS THEY BUST OUT."
 *
 * The elimination doors used to record a provisional place and move no money;
 * every place waited for the terminal settlement. The commit that records a
 * bust now pays it, through the same idempotent obligation door the terminal
 * uses, so the terminal later finds those places exactly settled.
 *
 * These pins read the migration text:
 *   1. the payment runs at the COMMIT of the bust (a deferred constraint
 *      trigger on playing -> eliminated) and when the pool finalizes;
 *   2. only a RUNNING event with a finalized pool, never a satellite or an
 *      event a deal or a place batch owns, and never while a bust is still
 *      unrecorded;
 *   3. the place is the terminal's own rule (bust time, then same-hand stack);
 *   4. money moves only through fn_ca_settle_tournament_place_raw and
 *      fn_ca_settle_tournament_bubble_raw - never a direct wallet write;
 *   5. a paid place is never relabelled;
 *   6. a failure never blocks the bust - it rolls back only the payment.
 *
 * Registry: docs/laws.d/a-tournament-finisher-is-paid-the-moment-they-bust.md
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const file = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('_tournament_finishers_are_paid_the_moment_they_bust.sql'))
  .sort()
  .at(-1);
const RAW = file ? readFileSync(join(MIGRATIONS, file), 'utf8') : '';
/** Comments explain; only executable SQL can satisfy a pin. */
const SQL = RAW.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const between = (start: string, end: string): string => {
  const a = SQL.indexOf(start);
  const b = SQL.indexOf(end, a + start.length);
  return a >= 0 && b > a ? SQL.slice(a, b) : '';
};
const PAYER = between(
  'CREATE OR REPLACE FUNCTION public.fn_ca_pay_tournament_finishers_now(',
  '$function$;'
);
const WRAPPER = between(
  'CREATE OR REPLACE FUNCTION public.trg_ca_pay_tournament_finishers_at_commit(',
  '$function$;'
);

describe('a tournament finisher is paid the moment they bust', () => {
  it('the migration exists and is one transaction', () => {
    expect(file, 'migration not found').toBeTruthy();
    expect(SQL).toMatch(/^\s*BEGIN;/m);
    expect(SQL).toMatch(/COMMIT;\s*$/);
    expect(PAYER.length).toBeGreaterThan(0);
    expect(WRAPPER.length).toBeGreaterThan(0);
  });

  it('pays at the commit that records the bust, and when the pool finalizes', () => {
    expect(SQL).toMatch(
      /CREATE CONSTRAINT TRIGGER zzz_pay_finisher_at_bust\s+AFTER UPDATE OF status ON public\.tournament_players\s+DEFERRABLE INITIALLY DEFERRED\s+FOR EACH ROW\s+WHEN \(OLD\.status::text = 'playing' AND NEW\.status::text = 'eliminated'\)/
    );
    expect(SQL).toMatch(
      /CREATE CONSTRAINT TRIGGER zzz_pay_finishers_when_pool_finalizes\s+AFTER UPDATE OF prize_pool_finalized ON public\.tournaments\s+DEFERRABLE INITIALLY DEFERRED/
    );
    expect(WRAPPER).toContain('public.fn_ca_pay_tournament_finishers_now(v_tournament_id)');
  });

  it('pays only a final place: running, finalized, not a satellite, no deal, no unrecorded bust', () => {
    expect(PAYER).toMatch(/<> 'RUNNING'/);
    expect(PAYER).toMatch(/prize_pool_finalized,false\) IS NOT TRUE/);
    expect(PAYER).toMatch(/'satellite'/);
    expect(PAYER).toMatch(/final_table_deal/);
    expect(PAYER).toMatch(/tournament_place_settlement_batches/);
    expect(PAYER).toMatch(/status::text = 'playing'\s+AND COALESCE\(tp\.chips,0\) <= 0/);
    expect(PAYER).toMatch(/fn_ca_lock_settlement_lane_for_tournament/);
  });

  it('places by the terminal rule: when the bust happened, then the smaller same-hand stack', () => {
    expect(PAYER).toMatch(/hand_atomic_commits/);
    expect(PAYER).toMatch(/\(s\.stack_before, s\.eliminated_user_id\)\s+< \(c\.stack_before, c\.eliminated_user_id\)/);
    expect(PAYER).toMatch(/ORDER BY b\.bust_at DESC, b\.elimination_sequence DESC, b\.id ASC/);
    expect(PAYER).toMatch(/v_live \+ row_number\(\)/);
  });

  it('moves money only through the obligation doors the terminal uses', () => {
    expect(PAYER).toContain('public.fn_ca_settle_tournament_place_raw(');
    expect(PAYER).toContain('public.fn_ca_settle_tournament_bubble_raw(');
    expect(PAYER).not.toMatch(/fn_credit_and_log|fn_add_chips|chip_balance|wallet_transactions/);
    expect(PAYER).not.toMatch(/INSERT INTO public\.tournament_payouts/);
  });

  it('never relabels a paid place', () => {
    expect(PAYER).toMatch(/'paid_place_out_of_order'/);
    const guard = PAYER.indexOf("'paid_place_out_of_order'");
    const restamp = PAYER.indexOf('SET position = NULL');
    expect(guard).toBeGreaterThan(-1);
    expect(restamp).toBeGreaterThan(guard);
  });

  it('never blocks the bust: a refusal rolls back only the payment and is recorded once', () => {
    expect(WRAPPER).toMatch(/EXCEPTION WHEN OTHERS THEN/);
    expect(WRAPPER).toMatch(/tournament\.real_time_payout_refused/);
    expect(WRAPPER).toMatch(/RETURN NULL;/);
    expect(WRAPPER).not.toMatch(/RAISE EXCEPTION/);
  });

  it('is not callable from a browser', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_pay_tournament_finishers_now\(uuid\) FROM PUBLIC, anon, authenticated;/
    );
  });
});
