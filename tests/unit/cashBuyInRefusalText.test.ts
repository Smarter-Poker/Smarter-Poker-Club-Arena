import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { cashBuyInRefusalText } from '../../src/lib/cashBuyIn';

/**
 * These strings are the ACTUAL raise texts in `atomic_table_buyin` and the two
 * four-table-cap triggers, read out of production with
 * `pg_get_functiondef` on 2026-08-28. If somebody edits a message server-side
 * without updating the mapper, the refusal silently reverts to
 * "check your balance" - the failure this whole file exists to end. That is
 * what these pins catch.
 */
describe('cashBuyInRefusalText', () => {
  it('names the four-table cap rather than the balance', () => {
    const raw =
      'FOUR TABLE LIMIT: user 6443a6ce-03b6-4baa-99ce-381352d2f277 is already committed to 4 games and may not enter another';
    expect(cashBuyInRefusalText(raw)).toBe(
      'You Are Already In Four Games, Leave One To Join Another'
    );
  });

  it('accepts the structured reason the seat RPC now returns', () => {
    expect(cashBuyInRefusalText('table_limit_reached')).toBe(
      'You Are Already In Four Games, Leave One To Join Another'
    );
  });

  it('carries the server numbers through for the cash-table cap', () => {
    expect(cashBuyInRefusalText('TABLE_CAP_REACHED: already seated at 4 cash tables (max 4)')).toBe(
      'You Are Already At 4 Cash Tables, The Limit Is 4'
    );
  });

  it('quotes the VPIP floor the table actually requires', () => {
    const raw =
      'NIT_GAME: this table needs a career VPIP of at least 18, and yours is 9 over 250 hands';
    expect(cashBuyInRefusalText(raw)).toBe(
      'This Table Requires A Career VPIP Of At Least 18 Percent'
    );
  });

  it('quotes the rejoin floor as a number and nothing else (chip continuity, 2026-09-04)', () => {
    expect(
      cashBuyInRefusalText('BUYIN_BELOW_FLOOR: minimum buy-in for this game right now is 2,500')
    ).toBe('The Minimum Buy In For This Game Right Now Is 2,500');
    expect(
      cashBuyInRefusalText(
        'BUYIN_ABOVE_MAX: add-on of 200 would take the stack above the table maximum (400.00)'
      )
    ).toBe('Your Stack Cannot Go Above The Table Maximum Of 400.00');
  });

  it('quotes the table minimum and maximum', () => {
    expect(cashBuyInRefusalText('Buy-in below table minimum (min 400)')).toBe(
      'The Minimum Buy In At This Table Is 400'
    );
    expect(cashBuyInRefusalText('Buy-in above table maximum (max 2000)')).toBe(
      'The Maximum Buy In At This Table Is 2000'
    );
  });

  it('names the player club wallet actually debited by the cash RPC', () => {
    expect(cashBuyInRefusalText('Insufficient club chips for buy-in (club abc)')).toBe(
      'Your Club Wallet Does Not Have Enough Chips For This Buy In'
    );
  });

  it('handles the other tagged refusals', () => {
    expect(cashBuyInRefusalText('VIP_ONLY: this table is open to VIP members only')).toBe(
      'This Table Is Open To VIP Members Only'
    );
    expect(cashBuyInRefusalText('TABLE_SIZE: table is full (6 of 6 seats taken)')).toBe(
      'This Table Is Full'
    );
    expect(cashBuyInRefusalText('TABLE_SIZE: seat 9 does not exist at this table (6 max)')).toBe(
      'That Seat Does Not Exist At This Table'
    );
    expect(cashBuyInRefusalText('Banned from this club')).toBe('You Cannot Buy In At This Club');
  });

  it('reads a real Error object, not just a string', () => {
    expect(
      cashBuyInRefusalText(new Error('VIP_ONLY: this table is open to VIP members only'))
    ).toBe('This Table Is Open To VIP Members Only');
  });

  /* The important half: an unrecognised refusal must NOT be relabelled. It
     keeps the generic text and stays visible to error reporting. */
  it('returns null for anything it does not recognise', () => {
    expect(cashBuyInRefusalText('some brand new server refusal')).toBeNull();
    expect(cashBuyInRefusalText('')).toBeNull();
    expect(cashBuyInRefusalText(undefined)).toBeNull();
    expect(cashBuyInRefusalText(null)).toBeNull();
  });
});

describe('booted for low VPIP is barred for two hours (Dan 2026-09-05)', () => {
  it('reads the bar in minutes, from either door', () => {
    expect(cashBuyInRefusalText({ message: 'VPIP_BARRED:7200' })).toBe(
      'You Were Removed For Low VPIP. You May Rejoin This Game In 120 Minutes'
    );
    expect(cashBuyInRefusalText({ message: 'GAME_BARRED:59' })).toBe(
      'You Were Removed For Low VPIP. You May Rejoin This Game In 1 Minute'
    );
    expect(cashBuyInRefusalText({ message: 'VPIP_BARRED' })).toBe(
      'You Were Removed For Low VPIP And Cannot Rejoin This Game Yet'
    );
  });

  /* ─── THE DIAMOND REFUSALS (2026-09-12) ────────────────────────────────
     Every one of these reached the player as the caller's generic fallback -
     "Buy-in failed. Please check your balance and try again." Three have
     nothing to do with a balance, and `diamond_cash_not_open` is a table that
     is not open yet, so a waitlisted player who arrived on time was told they
     were short of Diamonds.

     The messages are asserted against the SQL exception names, and the names
     are asserted to be the ones the database actually raises, so a renamed
     refusal fails here rather than degrading silently into the fallback. */
  it('translates every Diamond refusal a player can reach', () => {
    const cases: Array<[string, string]> = [
      ['insufficient_settled_diamonds', 'Your Settled Diamonds Do Not Cover This Buy In'],
      ['diamond_cash_not_open', 'Diamond Cash Games Are Not Open Yet'],
      ['diamond_plain_cash_table_required', 'This Table Is Not Set Up For Diamond Play'],
      ['invalid_diamond_cash_purchase', 'A Diamond Buy In Must Be A Whole Number Of Diamonds'],
      [
        'diamond_cash_requires_whole_amounts',
        'A Diamond Buy In Must Be A Whole Number Of Diamonds',
      ],
      ['diamond_debt_requires_settlement', 'Settle Your Outstanding Diamonds Before Taking A Seat'],
      ['diamond_custody_requires_settlement', 'Your Last Seat Has Not Finished Settling Yet'],
      ['diamond_purchase_arena_mismatch', 'That Purchase Belongs To A Different Arena'],
      ['diamond_seat_custody_binding_failed', 'That Seat Could Not Be Held'],
      ['diamond_arena_policy_missing', 'The Arena Is Not Accepting Seats Right Now'],
      ['diamond_top_up_exceeds_max_buy_in', 'That Would Put You Over This Table Maximum'],
      ['diamond_top_up_requires_a_live_seat', 'You Are Not Seated At This Table'],
      ['diamond_top_up_stale_seat', 'The Seat Changed While That Was In Flight'],
    ];
    for (const [refusal, expected] of cases) {
      const text = cashBuyInRefusalText({ message: refusal });
      expect(text, `${refusal} reaches the player untranslated`).not.toBeNull();
      expect(text, `${refusal} says the wrong thing`).toContain(expected);
    }
  });

  it('and none of those names is one the database stopped raising', () => {
    /* A translation keyed on a name the database no longer uses is worse than
       no translation: it looks handled and is dead. The names are read back
       out of the migrations that raise them. */
    const dir = resolve(__dirname, '../../supabase/migrations');
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(resolve(dir, f), 'utf8'))
      .join('\n');
    for (const refusal of [
      'insufficient_settled_diamonds',
      'diamond_cash_not_open',
      'diamond_plain_cash_table_required',
      'invalid_diamond_cash_purchase',
      'diamond_cash_requires_whole_amounts',
      'diamond_debt_requires_settlement',
      'diamond_purchase_arena_mismatch',
      'diamond_arena_policy_missing',
      'diamond_top_up_exceeds_max_buy_in',
      'diamond_top_up_requires_a_live_seat',
      'diamond_top_up_stale_seat',
    ]) {
      expect(sql, `${refusal} is translated but never raised`).toContain(refusal);
    }
  });

  it('the eviction passes the leave mode the database writes the bar from', () => {
    const base = readFileSync(
      resolve(__dirname, '../../server/src/engine/ServerTableEngineBase.ts'),
      'utf8'
    );
    expect(base).toMatch(/nitEvict \? \{ leaveMode: 'vpip_evicted' as const \} : \{\}/);
    const mig = readFileSync(
      resolve(
        __dirname,
        '../../supabase/migrations/20260905064000_booted_for_low_vpip_is_barred_for_two_hours.sql'
      ),
      'utf8'
    );
    expect(mig).toMatch(/RAISE EXCEPTION 'VPIP_BARRED:%'/);
    expect(mig).toMatch(/GAME_BARRED:%/);
    expect(mig).toMatch(/IF p_reason = 'vpip_evicted'/);
  });
});
