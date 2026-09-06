/**
 * A BOOKING IS A GAME (2026-09-06).
 *
 * The rule the database enforces (`fn_enforce_four_table_limit` ->
 * `fn_concurrent_game_load`), proven here without a database. Every case is
 * one the fleet got wrong on production: 1,000 horses, TWO at four live
 * seats, 351 at the database's four-GAME limit, and 349 of those looking
 * completely free to the fleet's arithmetic.
 */
import { describe, it, expect } from 'vitest';
import {
  CONCURRENT_GAME_LIMIT,
  buildBookingLoad,
  concurrentGameLoad,
  mayEnterAnotherGame,
  refusalReason,
  remainingGameCapacity,
} from './HorseGameLoad.js';

const seats = (entries: Array<[string, string[]]>) =>
  new Map(entries.map(([p, t]) => [p, new Set(t)] as const));

describe('the four-game limit is the database rule', () => {
  it('is four, the number fn_enforce_four_table_limit refuses at', () => {
    expect(CONCURRENT_GAME_LIMIT).toBe(4);
  });

  it('a seat and a booking are both a game', () => {
    expect(concurrentGameLoad({ seats: 2, bookings: 2 })).toBe(4);
  });

  it('a horse at ONE live seat and three bookings may not take another - the live defect', () => {
    const load = { seats: 1, bookings: 3, ownCashCeiling: 4 };
    expect(mayEnterAnotherGame(load)).toBe(false);
    expect(remainingGameCapacity(load)).toBe(0);
    expect(refusalReason(load)).toBe('platform');
  });

  it('a horse at NO seat at all can still be full - 172 of 603 were', () => {
    const load = { seats: 0, bookings: 4, ownCashCeiling: 4 };
    expect(mayEnterAnotherGame(load)).toBe(false);
    expect(refusalReason(load)).toBe('platform');
  });

  it('the horse own ceiling still applies, and is named separately', () => {
    const load = { seats: 1, bookings: 0, ownCashCeiling: 1 };
    expect(mayEnterAnotherGame(load)).toBe(false);
    expect(refusalReason(load)).toBe('own_ceiling');
  });

  it('capacity is the tighter of the two, never negative', () => {
    expect(remainingGameCapacity({ seats: 0, bookings: 0, ownCashCeiling: 4 })).toBe(4);
    expect(remainingGameCapacity({ seats: 0, bookings: 2, ownCashCeiling: 4 })).toBe(2);
    expect(remainingGameCapacity({ seats: 1, bookings: 0, ownCashCeiling: 2 })).toBe(1);
    expect(remainingGameCapacity({ seats: 3, bookings: 3, ownCashCeiling: 4 })).toBe(0);
    expect(remainingGameCapacity({ seats: 9, bookings: 9, ownCashCeiling: 4 })).toBe(0);
  });

  it('a free horse with no bookings is unchanged - this rule takes nothing away', () => {
    const load = { seats: 0, bookings: 0, ownCashCeiling: 4 };
    expect(mayEnterAnotherGame(load)).toBe(true);
    expect(refusalReason(load)).toBe(null);
  });
});

describe('buildBookingLoad counts what the SQL counts', () => {
  it('one booking each', () => {
    const out = buildBookingLoad(
      [
        { user_id: 'a', tournament_id: 't1' },
        { user_id: 'b', tournament_id: 't1' },
      ],
      new Map(),
      seats([])
    );
    expect(out.get('a')).toBe(1);
    expect(out.get('b')).toBe(1);
  });

  it('NEVER BOTH: a booking whose tournament the player already sits in is not counted', () => {
    const out = buildBookingLoad(
      [
        { user_id: 'a', tournament_id: 't1' },
        { user_id: 'a', tournament_id: 't2' },
      ],
      new Map([['table-of-t1', 't1']]),
      seats([['a', ['table-of-t1']]])
    );
    expect(out.get('a')).toBe(1);
  });

  it('a cash seat is not a tournament table, so it excludes nothing', () => {
    const out = buildBookingLoad(
      [{ user_id: 'a', tournament_id: 't1' }],
      new Map([['table-of-t1', 't1']]),
      seats([['a', ['some-cash-table']]])
    );
    expect(out.get('a')).toBe(1);
  });

  it('two rows for one tournament are one game', () => {
    const out = buildBookingLoad(
      [
        { user_id: 'a', tournament_id: 't1' },
        { user_id: 'a', tournament_id: 't1' },
      ],
      new Map(),
      seats([])
    );
    expect(out.get('a')).toBe(1);
  });

  it('a player with no bookings is absent, which reads as zero', () => {
    const out = buildBookingLoad([], new Map(), seats([['a', ['x']]]));
    expect(out.get('a')).toBeUndefined();
    expect(out.get('a') ?? 0).toBe(0);
  });
});
