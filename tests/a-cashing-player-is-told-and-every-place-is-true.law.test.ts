/**
 * A CASHING PLAYER IS TOLD, AND EVERY PLACE IS TRUE ONCE THE FIELD IS FIXED.
 *
 * Dan, 2026-10-21: "fully build, fix and enhance all of these".
 *
 *   1. No tournament prize ever produced a bell or a push. One
 *      'tournament_cash' notice is now written, exactly once, the moment a
 *      place, Bubble Protection, satellite seat or satellite cash obligation
 *      is fully paid, and the normal notification -> push mirror delivers it.
 *      A notice can never roll back the payment that caused it.
 *   2. Between late registration closing and the bubble every bust kept the
 *      engine's provisional place (a 222-entry event showed places 2 to 200
 *      with 25 left). Once the pool is finalized the standings are restamped
 *      on every bust, in the money or not; before it nothing moves.
 *
 * Registry: docs/laws.d/a-cashing-player-is-told-and-every-place-is-true.md
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const file = readdirSync(MIGRATIONS)
  .filter((name) =>
    name.endsWith('_tournament_places_are_true_from_the_first_bust_and_cashing_p.sql')
  )
  .sort()
  .at(-1);
const RAW = file ? readFileSync(join(MIGRATIONS, file), 'utf8') : '';
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
const NOTICE = between(
  'CREATE OR REPLACE FUNCTION public.trg_ca_notify_tournament_cash(',
  '$function$;'
);

describe('a cashing player is told', () => {
  it('the migration exists, is one transaction, and defines both functions', () => {
    expect(file, 'migration not found').toBeTruthy();
    expect(SQL).toMatch(/^\s*BEGIN;/m);
    expect(SQL).toMatch(/COMMIT;\s*$/);
    expect(PAYER.length).toBeGreaterThan(0);
    expect(NOTICE.length).toBeGreaterThan(0);
  });

  it('fires when an obligation becomes fully paid, for every cashing kind', () => {
    expect(SQL).toMatch(
      /CREATE TRIGGER zzz_notify_tournament_cash\s+AFTER INSERT OR UPDATE OF settled_at ON public\.tournament_obligations\s+FOR EACH ROW\s+WHEN \(NEW\.settled_at IS NOT NULL\)/
    );
    expect(NOTICE).toMatch(
      /NEW\.kind NOT IN \('place','bubble_protection','satellite_remainder','seat'\)/
    );
    expect(NOTICE).toMatch(/TG_OP = 'UPDATE' AND OLD\.settled_at IS NOT NULL/);
  });

  it('writes one notice per obligation and lets the normal mirror push it', () => {
    expect(NOTICE).toMatch(/n\.data->>'obligation_id' = NEW\.id::text/);
    expect(NOTICE).toMatch(/INSERT INTO public\.notifications\(user_id, type, title, message, data, link\)/);
    expect(NOTICE).toContain("'tournament_cash'");
    expect(NOTICE).toContain("'/hub/club-arena/tournaments/' || NEW.tournament_id::text");
    // The push comes from the existing notification -> push_outbox mirror,
    // with its preference, quiet-hour and device gates; no private push here.
    expect(NOTICE).not.toMatch(/push_outbox/);
    expect(NOTICE).not.toMatch(/'_push'/);
  });

  it('can never roll back the payment that caused it', () => {
    expect(NOTICE).toMatch(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/);
    expect(NOTICE).not.toMatch(/RAISE EXCEPTION/);
    expect(NOTICE).not.toMatch(/UPDATE public\.|DELETE FROM/);
  });

  it('speaks in Title Case and the right currency, with no em dash', () => {
    expect(RAW).not.toContain(String.fromCharCode(0x2014));
    expect(NOTICE).toMatch(/'Diamonds' ELSE 'Chips'/);
    for (const title of [
      'You Won A Seat',
      'Bubble Protection Paid',
      'Satellite Cash Paid',
      'You Won The Tournament',
    ]) {
      expect(NOTICE).toContain(`'${title}'`);
    }
    expect(NOTICE).toContain('It Is Already In Your Wallet.');
  });

  it('treats horses exactly as humans', () => {
    expect(NOTICE).not.toMatch(/is_horse/);
  });
});

describe('every place is true once the field is fixed', () => {
  it('still moves nothing before the pool is finalized', () => {
    const early = PAYER.indexOf("'pool_not_finalized'");
    const restamp = PAYER.indexOf('SET position = NULL');
    expect(early).toBeGreaterThan(-1);
    expect(restamp).toBeGreaterThan(early);
  });

  it('restamps the standings before it asks whether anybody is in the money', () => {
    const restamp = PAYER.indexOf('SET position = NULL');
    const prize = PAYER.indexOf('SET prize = CASE');
    const money = PAYER.indexOf("'nobody_in_the_money_yet'");
    expect(restamp).toBeGreaterThan(-1);
    expect(prize).toBeGreaterThan(restamp);
    expect(money).toBeGreaterThan(prize);
  });

  it('never relabels a paid place, and pays only through the obligation doors', () => {
    expect(PAYER.indexOf("'paid_place_out_of_order'")).toBeLessThan(
      PAYER.indexOf('SET position = NULL')
    );
    expect(PAYER).toContain('public.fn_ca_settle_tournament_place_raw(');
    expect(PAYER).toContain('public.fn_ca_settle_tournament_bubble_raw(');
    expect(PAYER).not.toMatch(/fn_credit_and_log|fn_add_chips|chip_balance|wallet_transactions/);
  });
});
