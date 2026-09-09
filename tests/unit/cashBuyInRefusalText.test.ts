import { readFileSync } from 'node:fs';
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

  it('separates the club treasury from the player wallet', () => {
    expect(cashBuyInRefusalText('Insufficient club chips for buy-in (club abc)')).toBe(
      'The Club Treasury Cannot Cover This Buy In'
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
