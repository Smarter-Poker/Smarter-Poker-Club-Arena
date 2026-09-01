/**
 * EVERY EARNER IS PAID (2026-09-01).
 *
 * Dan, verbatim: "IT IS AN ABSOLUTE MUST THAT PLAYERS ALWAYS 100% GET PAID OUT
 * OF EVERY SINGLE MTT, SPIN OR HEADS UP THEY PLAY (IF THEY EARNED A PAYOUT)."
 *
 * The audit behind these pins reconciled 49,044 completed events with a prize
 * pool over 120 days against wallet_transactions, not against paperwork:
 *
 *   SPIN  32,433 events   0 underpaid
 *   SNG   15,010 events   0 underpaid
 *   MTT    1,601 events  12 underpaid, 76.70 chips
 *
 * Every one of the twelve has the same signature and nothing was looking for
 * it: A PAID PLACE WITH NOBODY IN IT. Late Night Grind (PLO4) on 2026-06-07
 * seated ten players and recorded places 1, 2, then 6 through 13; places 3, 4
 * and 5 pay 18/10/7 percent and had no holder, so 17.50 of a 50.00 pool went to
 * nobody. Fifteen events carry nineteen such vacancies, all between 2026-05-08
 * and 2026-07-19, none after - the distinct-places work of 2026-07-19 fixed the
 * cause. It ran unseen for ten weeks because no check on this platform asked
 * whether a place the structure pays actually has somebody in it.
 *
 * Each pin below is one of those failures, or one of the two ways the repair
 * machinery could fail the rule quietly. Fix your change; never weaken a pin.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const migration = readFileSync(
  join(
    __dirname,
    '../../../supabase/migrations/20260901140000_a_player_who_earned_a_payout_is_always_paid.sql'
  ),
  'utf8'
);
const gameServer = readFileSync(join(__dirname, '../GameServer.ts'), 'utf8');

describe('the check exists and asks all three questions', () => {
  it('declares fn_payout_guarantee_check', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_payout_guarantee_check/);
  });

  it('asks whether a paid place has anybody in it', () => {
    // The vacancy test: a place the structure pays, within the field, that no
    // tournament_players row holds. This is the one that caught all fifteen.
    expect(migration).toContain("'vacant_paid_place'");
    expect(migration).toMatch(/WHERE tp\.tournament_id = p\.id AND tp\.position = p\.place/);
    expect(migration).toMatch(/p\.place <= p\.entrants/);
  });

  it('measures what a player received against the WALLET, never the payout record', () => {
    // tournament_payouts is incomplete for 61 events / 5,515.91 chips. If this
    // check read it, a paperwork gap would read as an unpaid player and a
    // complete-looking record would hide a real one.
    expect(migration).toContain("'earner_not_paid'");
    const earnerBlock = migration.slice(
      migration.indexOf("'earner_not_paid'") - 3000,
      migration.indexOf("'earner_not_paid'")
    );
    expect(earnerBlock).toContain('FROM public.wallet_transactions w');
    expect(earnerBlock).toContain("w.category IN ('prize','bounty')");
  });

  it('reports prizes paid with no payout record, because that is what arms a double-pay', () => {
    expect(migration).toContain("'paid_but_unrecorded'");
  });

  it('moves no money: it has no credit call of any kind', () => {
    const fnStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_payout_guarantee_check'
    );
    const fnEnd = migration.indexOf('$function$;', fnStart);
    const body = migration.slice(fnStart, fnEnd);
    expect(body).not.toContain('fn_credit_and_log');
    expect(body).not.toContain('fn_credit_player_wallet_once');
    expect(body).not.toMatch(/UPDATE\s+public\.club_members/);
  });

  it('is closed to browser roles, like every other sweep', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_payout_guarantee_check\(integer\)\s*\n?\s*FROM PUBLIC, anon, authenticated;/
    );
  });
});

describe('the sweep that pays cannot fail a player quietly', () => {
  const sweep = migration.slice(
    migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_pay_backed_payout_shortfalls')
  );

  it('withholding raises a durable alert instead of a console line', () => {
    // This branch used to increment a counter and nothing else. Money owed to a
    // player and not paid left no record anywhere that anyone could find later.
    expect(sweep).toContain("'withheld_unfunded_pool'");
    expect(sweep).toMatch(/SELECT 'critical', 'fn_pay_backed_payout_shortfalls'/);
    const withheldAt = sweep.indexOf("'withheld_unfunded_pool'");
    const guardAt = sweep.indexOf('IF r.delta < r.topup THEN');
    expect(guardAt).toBeGreaterThan(-1);
    expect(withheldAt).toBeGreaterThan(guardAt);
  });

  it('refuses to top up an event whose wallet already covers its pool', () => {
    // The reconciler reads tournament_payouts to decide what is owed. 61 events
    // paid 5,515.91 chips that were never recorded there, so it reports those
    // as outstanding. Nothing but an unfunded pool was stopping a second
    // payment; that is luck, not a safety property.
    expect(sweep).toContain("'refused_already_disbursed'");
    expect(sweep).toMatch(/IF r\.wallet_prizes \+ 0\.01 >= COALESCE\(r\.prize_pool, 0\)/);
  });

  it('treats the backfill log as a receipt, not a tombstone', () => {
    // `NOT EXISTS (... backfill_log ...)` meant one inspection excluded an
    // event for good, so a shortfall that became payable later - a guarantee
    // funded, a baseline acknowledged - would never be looked at again.
    expect(sweep).not.toMatch(
      /NOT EXISTS\s*\(SELECT 1 FROM public\.tournament_payout_backfill_log/
    );
    expect(sweep).toContain('ON CONFLICT (tournament_id) DO UPDATE');
    // The only correct exclusion is that nothing is owed.
    expect(sweep).toContain('CONTINUE WHEN r.topup <= 0.005;');
  });

  it('still refuses to pay more than the event is holding', () => {
    expect(sweep).toContain('IF r.delta < r.topup THEN');
    expect(sweep).toMatch(/would leave conservation at %; refusing/);
  });

  it('still leaves satellites and spins alone', () => {
    expect(sweep).toMatch(/COALESCE\(t\.variant, ''\) <> 'satellite'/);
    expect(sweep).toMatch(/COALESCE\(t\.variant, ''\) <> 'spin'/);
  });
});

describe('the check actually runs', () => {
  it('GameServer calls it on its own timer', () => {
    // The lesson recorded on the overpay charge: a repair gated on another
    // job's clock runs once at boot and then effectively never.
    expect(gameServer).toContain("'fn_payout_guarantee_check'");
    expect(gameServer).toContain('lastPayoutGuaranteeCheckAt');
    const declAt = gameServer.indexOf('private lastPayoutGuaranteeCheckAt = 0;');
    const gateAt = gameServer.indexOf(
      'Date.now() - this.lastPayoutGuaranteeCheckAt > 60 * 60 * 1000'
    );
    expect(declAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(declAt);
  });

  it('a failed call is reported rather than swallowed', () => {
    expect(gameServer).toContain('GameServer.payout_guarantee_check_failed');
    expect(gameServer).toContain('GameServer.payout_guarantee_check_threw');
  });
});
