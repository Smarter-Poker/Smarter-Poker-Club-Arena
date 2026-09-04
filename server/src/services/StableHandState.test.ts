/**
 * THE DAY'S COUNTERS. Every column the Stable Hand mutex reads about a horse
 * had held its default since the table was created, so the per-key sit cap
 * compared 0 against 3-5 and always said yes. These are the rules that write
 * them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { foldMutations, MINUTES_ACCRUAL_MS, type StateMutation } from './StableHandState.js';
import {
  sitsOnKeyToday,
  dailyCapReached,
  countersAreToday,
  type HorseState,
} from './StableHandTags.js';

const TODAY = '2026-09-04';
const YESTERDAY = '2026-09-03';
const NOW = Date.UTC(2026, 8, 4, 18, 0, 0);

const state = (over: Partial<HorseState> = {}): HorseState => ({
  horseId: 'h1',
  restWeekday: null,
  dailyCapMinutes: 525,
  minutesPlayedToday: 0,
  sessionStartBalance: null,
  cashSitsToday: {},
  twoHourWindow: {},
  countersResetOn: TODAY,
  ...over,
});

const fold = (states: HorseState[], muts: StateMutation[], today = TODAY) =>
  foldMutations(new Map(states.map((s) => [s.horseId, s])), muts, today, NOW);

describe('a sit is counted against the key the mutex judged', () => {
  it('increments the key', () => {
    const { rows } = fold([state({ cashSitsToday: { k: 2 } })], [{ horseId: 'h1', sitOnKey: 'k' }]);
    expect(rows[0].cash_sits_today).toEqual({ k: 3 });
  });

  it('counts keys independently', () => {
    const { rows } = fold([state({ cashSitsToday: { a: 1 } })], [{ horseId: 'h1', sitOnKey: 'b' }]);
    expect(rows[0].cash_sits_today).toEqual({ a: 1, b: 1 });
  });

  it('starts a horse it has never seen from zero', () => {
    const { rows } = fold([], [{ horseId: 'newcomer', sitOnKey: 'k' }]);
    expect(rows[0].cash_sits_today).toEqual({ k: 1 });
    expect(rows[0].counters_reset_on).toBe(TODAY);
  });
});

describe('THE DAY RESETS ITSELF - there is no midnight job to miss', () => {
  it("yesterday's sits are not added to, they are replaced", () => {
    const stale = state({
      countersResetOn: YESTERDAY,
      cashSitsToday: { k: 5 },
      minutesPlayedToday: 400,
    });
    const { rows } = fold([stale], [{ horseId: 'h1', sitOnKey: 'k' }]);
    expect(rows[0].cash_sits_today).toEqual({ k: 1 });
    expect(rows[0].minutes_played_today).toBe(0);
    expect(rows[0].counters_reset_on).toBe(TODAY);
  });

  it('and the READER returns zero for a stale date even if nothing wrote', () => {
    // This is what makes the reset structural rather than scheduled. A job
    // that has to run for a rule to hold is a rule that is wrong whenever the
    // job does not run.
    const stale = state({
      countersResetOn: YESTERDAY,
      cashSitsToday: { k: 5 },
      minutesPlayedToday: 9999,
    });
    expect(countersAreToday(stale, TODAY)).toBe(false);
    expect(sitsOnKeyToday(stale, 'k', TODAY)).toBe(0);
    expect(dailyCapReached(stale, TODAY)).toBe(false);
    // and today's numbers still read
    const fresh = state({ cashSitsToday: { k: 5 }, minutesPlayedToday: 9999 });
    expect(sitsOnKeyToday(fresh, 'k', TODAY)).toBe(5);
    expect(dailyCapReached(fresh, TODAY)).toBe(true);
  });

  it('the two-hour window is NOT cleared by the new day', () => {
    // It is a rolling two hours, not a daily allowance: a horse that cashed
    // out at 23:30 is still inside it at 00:30.
    const stale = state({ countersResetOn: YESTERDAY, twoHourWindow: { k: NOW - 60_000 } });
    const { rows } = fold([stale], [{ horseId: 'h1', addMinutes: 5 }]);
    expect(rows[0].two_hour_window.k).toBe(NOW - 60_000);
  });
});

describe('the two-hour window opens when a seat is GIVEN UP', () => {
  it('stamps the key with the moment it closed', () => {
    const { rows } = fold([state()], [{ horseId: 'h1', closedKey: 'k' }]);
    expect(rows[0].two_hour_window).toEqual({ k: NOW });
  });

  it('drops entries old enough that nothing can still be inside them', () => {
    // Otherwise a horse that plays many games over months leaves a permanent
    // entry for every one of them.
    const old = state({ twoHourWindow: { ancient: NOW - 48 * 60 * 60_000, recent: NOW - 60_000 } });
    const { rows } = fold([old], [{ horseId: 'h1', closedKey: 'k' }]);
    expect(Object.keys(rows[0].two_hour_window).sort()).toEqual(['k', 'recent']);
  });
});

describe('minutes played', () => {
  it('accrues', () => {
    const { rows } = fold([state({ minutesPlayedToday: 10 })], [{ horseId: 'h1', addMinutes: 5 }]);
    expect(rows[0].minutes_played_today).toBe(15);
  });

  it('is written as a whole number', () => {
    const { rows } = fold([state()], [{ horseId: 'h1', addMinutes: 5.4 }]);
    expect(Number.isInteger(rows[0].minutes_played_today)).toBe(true);
  });

  it('accrues far more finely than the smallest cap needs', () => {
    // The smallest daily cap on the fleet is 510 minutes; five is 1/100th of
    // it, and one write every ten seeding cycles rather than two a minute.
    expect(MINUTES_ACCRUAL_MS).toBe(5 * 60_000);
    expect(MINUTES_ACCRUAL_MS / 60_000).toBeLessThan(510 / 50);
  });
});

describe('the session-start balance', () => {
  it('is what the 50% commit cap is measured against', () => {
    const { rows } = fold([state()], [{ horseId: 'h1', sessionStartBalance: 12_345 }]);
    expect(rows[0].session_start_balance).toBe(12_345);
  });

  it('is left alone when the cycle does not set one', () => {
    const { rows } = fold(
      [state({ sessionStartBalance: 999 })],
      [{ horseId: 'h1', addMinutes: 1 }]
    );
    expect(rows[0].session_start_balance).toBe(999);
  });
});

describe('a quiet cycle writes nothing', () => {
  it('returns no rows for no mutations', () => {
    expect(fold([state()], []).rows).toHaveLength(0);
  });

  it('returns ONE row per horse however many mutations it had', () => {
    const { rows } = fold(
      [state()],
      [
        { horseId: 'h1', sitOnKey: 'a' },
        { horseId: 'h1', sitOnKey: 'b' },
        { horseId: 'h1', addMinutes: 5 },
        { horseId: 'h1', closedKey: 'c' },
      ]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cash_sits_today).toEqual({ a: 1, b: 1 });
    expect(rows[0].minutes_played_today).toBe(5);
    expect(rows[0].two_hour_window).toEqual({ c: NOW });
  });

  it('does not mutate the map it was given', () => {
    const original = state({ cashSitsToday: { k: 1 } });
    const map = new Map([[original.horseId, original]]);
    foldMutations(map, [{ horseId: 'h1', sitOnKey: 'k' }], TODAY, NOW);
    expect(original.cashSitsToday).toEqual({ k: 1 });
  });
});

describe('SOURCE LAW: the writer is one round trip, and it never invents a horse', () => {
  const raw = readFileSync(resolve(__dirname, 'StableHandState.ts'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('upserts an ARRAY rather than a row at a time', () => {
    expect(src).toContain(".upsert(chunk, { onConflict: 'horse_id' })");
  });

  it('reports a failed write and carries on rather than throwing the cycle away', () => {
    // A counter that did not persist allows one extra sit. A cycle that throws
    // stops the whole floor filling.
    expect(src).toContain("reportError(error, 'StableHandState.writeStateRows')");
    expect(src).toContain('continue;');
  });

  it('touches ONLY the horse-state table', () => {
    expect(src.match(/\.from\(/g)?.length).toBe(1);
    expect(src).toContain("from('stable_hand_horse_state')");
  });

  it('never writes a tag, a seat or a chip', () => {
    for (const banned of [
      'stable_hand_membership_tags',
      'table_seats',
      'club_members',
      'chip_balance',
      'atomic_table_buyin',
    ]) {
      expect(src).not.toContain(banned);
    }
  });
});
