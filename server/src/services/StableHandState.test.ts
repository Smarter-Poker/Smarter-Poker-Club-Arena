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

/* restWeekday is a REAL day here, not null, because that is what every horse
   in the tag book actually carries - the tagger assigns one to all 1,000 - and
   because a row folded from a state with no rest day is deliberately not
   written at all (see 'the columns the table demands' below). A helper that
   defaulted it to null was quietly asserting the untagged path everywhere. */
const state = (over: Partial<HorseState> = {}): HorseState => ({
  horseId: 'h1',
  restWeekday: 3,
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

  /* REPLACED 2026-09-04, deliberately, and the old assertion is quoted here so
     nobody restores it by accident. This used to read:

         const { rows } = fold([], [{ horseId: 'newcomer', sitOnKey: 'k' }]);
         expect(rows[0].cash_sits_today).toEqual({ k: 1 });

     - a horse the tag book has never seen produced a row. That row could never
     reach the table: with no rest day and no daily cap it proposes NULL into
     two NOT NULL columns and Postgres rejects the whole chunk, taking every
     other horse's counters in the same array down with it. The intent behind
     the test - counters START at zero, they never inherit - is kept below and
     is what actually mattered. */
  it('starts a horse whose counters are empty from zero', () => {
    const { rows } = fold([state({ cashSitsToday: {} })], [{ horseId: 'h1', sitOnKey: 'k' }]);
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE COLUMNS THE TABLE DEMANDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * From 08:42 to 23:07 on 2026-09-04 this write failed on every single cycle
 * and nothing above it noticed. The payload left out `rest_weekday` and
 * `daily_cap_minutes` on the reasoning that an upsert conflicting on
 * `horse_id` takes the DO UPDATE branch and DO UPDATE only touches the columns
 * you name. Postgres checks NOT NULL on the PROPOSED tuple before it looks for
 * the conflict, so every chunk was rejected with 23502, `writeStateRows`
 * returned 0 by design, and the fleet carried on seeding with all three
 * counter-driven gates reading zero.
 *
 * The first test below pins the instance. The second reads the migration and
 * pins the CLASS: any column on this table that is NOT NULL with no DEFAULT
 * must appear in the row this module writes, so the next one added fails here
 * instead of switching the counters off in production for a day.
 */
describe('the columns the table demands', () => {
  const migration = readFileSync(
    resolve(
      __dirname,
      '../../../supabase/migrations/20260904060838_stable_hand_tag_and_state_tables.sql'
    ),
    'utf8'
  );

  const requiredColumns = (): string[] => {
    const body = migration
      .split(/CREATE TABLE IF NOT EXISTS public\.stable_hand_horse_state \(/)[1]
      .split(/\n\);/)[0];
    const out: string[] = [];
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('CONSTRAINT') || line.startsWith('--')) continue;
      const name = line.split(/\s+/)[0].replace(/,$/, '');
      if (!/^[a-z_]+$/.test(name)) continue;
      if (name === 'horse_id') continue; // the primary key, always supplied
      if (!/NOT NULL/i.test(line)) continue;
      if (/DEFAULT/i.test(line)) continue;
      out.push(name);
    }
    return out;
  };

  it('the migration really does have NOT NULL columns with no default', () => {
    // If this ever goes empty the test below stops proving anything, so say so.
    expect(requiredColumns()).toEqual(['rest_weekday', 'daily_cap_minutes']);
  });

  it('every one of them is in the row we write', () => {
    const { rows } = fold(
      [state({ restWeekday: 5, dailyCapMinutes: 400 })],
      [{ horseId: 'h1', sitOnKey: 'k' }]
    );
    expect(rows).toHaveLength(1);
    for (const col of requiredColumns()) {
      expect(Object.keys(rows[0])).toContain(col);
      expect((rows[0] as unknown as Record<string, unknown>)[col]).not.toBeNull();
    }
  });

  it("carries the tagger's values through rather than inventing them", () => {
    const { rows } = fold(
      [state({ restWeekday: 5, dailyCapMinutes: 400 })],
      [{ horseId: 'h1', addMinutes: 5 }]
    );
    expect(rows[0].rest_weekday).toBe(5);
    expect(rows[0].daily_cap_minutes).toBe(400);
  });

  it('writes NO row for a horse the tagger has never seen, and says how many', () => {
    const { rows, skippedUntagged } = fold(
      [state({ horseId: 'h1', restWeekday: null })],
      [
        { horseId: 'h1', sitOnKey: 'k' },
        { horseId: 'unknown-horse', sitOnKey: 'k' },
      ]
    );
    expect(rows).toHaveLength(0);
    expect(skippedUntagged).toBe(2);
  });

  it('a missing daily cap is refused on the same terms as a missing rest day', () => {
    const { rows, skippedUntagged } = fold(
      [state({ dailyCapMinutes: null })],
      [{ horseId: 'h1', sitOnKey: 'k' }]
    );
    expect(rows).toHaveLength(0);
    expect(skippedUntagged).toBe(1);
  });
});
