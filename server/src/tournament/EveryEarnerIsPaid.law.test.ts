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
    '../../../supabase/migrations/20260901131129_a_player_who_earned_a_payout_is_always_paid.sql'
  ),
  'utf8'
);
const atomicCashMigration = readFileSync(
  join(
    __dirname,
    '../../../supabase/migrations/20260909042455_tournament_cash_settlement_has_one_atomic_authority.sql'
  ),
  'utf8'
);
const gameServer = readFileSync(join(__dirname, '../GameServer.ts'), 'utf8');
const executableGameServer = gameServer
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

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

describe('the repair payer remains untouched during the rolling stage-one install', () => {
  it('is neither redefined nor dropped by the atomic authority migration', () => {
    expect(atomicCashMigration).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_pay_backed_payout_shortfalls/
    );
    expect(atomicCashMigration).not.toMatch(
      /DROP FUNCTION(?: IF EXISTS)? public\.fn_pay_backed_payout_shortfalls/
    );
  });
});

describe('the atomic terminal authority replaces the rolling payout audit', () => {
  it('keeps the historical detector for retirement evidence but schedules no payout watcher', () => {
    expect(executableGameServer).not.toContain('fn_payout_guarantee_check');
    expect(executableGameServer).not.toContain('lastPayoutGuaranteeCheckAt');
    expect(executableGameServer).not.toContain('fn_pay_backed_payout_shortfalls');
    expect(executableGameServer).not.toContain('lastBackedPayoutAt');
  });
});
