/**
 * THE TAG BOOK - the read side of a layer that had been written and never
 * read. Every assertion below is either the fail-open contract or one of the
 * two bugs the first live read exposed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  tagKey,
  tagAllowsCash,
  tagAllowsVariant,
  tagAllowsStake,
  tagMaxTables,
  isRestDayFor,
  dailyCapReached,
  sitsOnKeyToday,
  inTwoHourWindow,
  TAG_TTL_MS,
  STATE_TTL_MS,
  type HorseTag,
  type HorseState,
} from './StableHandTags.js';
import { TWO_HOUR_WINDOW_MS } from './StableHand.js';

const tag = (over: Partial<HorseTag> = {}): HorseTag => ({
  horseId: 'h1',
  clubId: 'c1',
  mode: 'cash',
  cashFreeroll: false,
  personaCash: 'regular',
  personaMtt: null,
  variants: ['nlh', 'plo4'],
  preferredStakes: [0.5, 1, 2],
  maxTables: 3,
  ...over,
});

const state = (over: Partial<HorseState> = {}): HorseState => ({
  horseId: 'h1',
  restWeekday: 3,
  dailyCapMinutes: 525,
  minutesPlayedToday: 0,
  sessionStartBalance: 10_000,
  cashSitsToday: {},
  twoHourWindow: {},
  countersResetOn: null,
  ...over,
});

describe('UNTAGGED IS NOT UNTAGGABLE - every reader fails open', () => {
  it('an absent tag answers undefined, never false', () => {
    // undefined means "I have no opinion, keep what you decided" - the caller
    // then uses the hash rules it used before. Returning false would refuse
    // every horse on a failed read, which is the shape of the bug that emptied
    // the cash floor for forty minutes on 2026-08-31.
    expect(tagAllowsCash(undefined)).toBeUndefined();
    expect(tagAllowsVariant(undefined, 'nlh')).toBeUndefined();
    expect(tagAllowsStake(undefined, 2)).toBeUndefined();
  });

  it('an absent tag leaves the platform table ceiling alone', () => {
    expect(tagMaxTables(undefined)).toBe(4);
  });

  it('absent state is never a rest day and never a spent day', () => {
    expect(isRestDayFor(undefined, 3)).toBe(false);
    expect(dailyCapReached(undefined)).toBe(false);
    expect(sitsOnKeyToday(undefined, 'k')).toBe(0);
    expect(inTwoHourWindow(undefined, 'k', Date.now(), TWO_HOUR_WINDOW_MS)).toBe(false);
  });

  it('an unset cap is not a reached cap', () => {
    expect(dailyCapReached(state({ dailyCapMinutes: null, minutesPlayedToday: 9999 }))).toBe(false);
  });

  it('an empty preferred-stakes list on a CASH horse is a gap, not a refusal', () => {
    // The tagger leaves it empty only for a tourney-only horse; a cash horse
    // with none is a tagging gap and the old stake band decides.
    expect(tagAllowsStake(tag({ preferredStakes: [] }), 2)).toBeUndefined();
  });
});

describe('what a tag actually says', () => {
  it('a tourney-only horse plays no cash, no variant and no stake', () => {
    const t = tag({ mode: 'tourney', variants: [], preferredStakes: [] });
    expect(tagAllowsCash(t)).toBe(false);
    expect(tagAllowsVariant(t, 'nlh')).toBe(false);
    expect(tagAllowsStake(t, 2)).toBe(false);
  });

  it('cash and both play cash', () => {
    expect(tagAllowsCash(tag({ mode: 'cash' }))).toBe(true);
    expect(tagAllowsCash(tag({ mode: 'both' }))).toBe(true);
  });

  it('a horse plays only the variants it carries, case-insensitively', () => {
    expect(tagAllowsVariant(tag(), 'nlh')).toBe(true);
    expect(tagAllowsVariant(tag(), 'NLH')).toBe(true);
    expect(tagAllowsVariant(tag(), 'short_deck')).toBe(false);
  });

  it('a horse sits only at the stakes it carries', () => {
    expect(tagAllowsStake(tag(), 2)).toBe(true);
    expect(tagAllowsStake(tag(), 5)).toBe(false);
    // fractional blinds compare on value, not on string
    expect(tagAllowsStake(tag({ preferredStakes: [0.02] }), 0.02)).toBe(true);
  });

  it('the horse ceiling never exceeds the platform ceiling of four', () => {
    expect(tagMaxTables(tag({ maxTables: 9 }))).toBe(4);
    expect(tagMaxTables(tag({ maxTables: 1 }))).toBe(1);
    expect(tagMaxTables(tag({ maxTables: 0 }))).toBe(1);
  });
});

describe('the daily counters', () => {
  it('the rest day is the Chicago weekday, Sunday-first', () => {
    expect(isRestDayFor(state({ restWeekday: 3 }), 3)).toBe(true);
    expect(isRestDayFor(state({ restWeekday: 3 }), 4)).toBe(false);
  });

  it('the cap is reached at the cap, not past it', () => {
    expect(dailyCapReached(state({ dailyCapMinutes: 525, minutesPlayedToday: 524 }))).toBe(false);
    expect(dailyCapReached(state({ dailyCapMinutes: 525, minutesPlayedToday: 525 }))).toBe(true);
  });

  it('sits are counted per game key', () => {
    const s = state({ cashSitsToday: { 'host:nlh:1:2': 3 } });
    expect(sitsOnKeyToday(s, 'host:nlh:1:2')).toBe(3);
    expect(sitsOnKeyToday(s, 'host:nlh:2:5')).toBe(0);
  });
});

describe('the two-hour window', () => {
  const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
  it('holds for two hours after the cash-out that opened it', () => {
    const s = state({ twoHourWindow: { k: NOW - 60 * 60_000 } });
    expect(inTwoHourWindow(s, 'k', NOW, TWO_HOUR_WINDOW_MS)).toBe(true);
  });

  it('lifts at exactly two hours', () => {
    const s = state({ twoHourWindow: { k: NOW - TWO_HOUR_WINDOW_MS } });
    expect(inTwoHourWindow(s, 'k', NOW, TWO_HOUR_WINDOW_MS)).toBe(false);
  });

  it('is per key - cashing out of one game does not lock the others', () => {
    const s = state({ twoHourWindow: { a: NOW } });
    expect(inTwoHourWindow(s, 'a', NOW, TWO_HOUR_WINDOW_MS)).toBe(true);
    expect(inTwoHourWindow(s, 'b', NOW, TWO_HOUR_WINDOW_MS)).toBe(false);
  });
});

describe('SOURCE LAW: the book is read whole or not at all', () => {
  const raw = readFileSync(resolve(__dirname, 'StableHandTags.ts'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('THE TAG READ IS PAGED PER CLUB - the key is (horse_id, club_id)', () => {
    /* A horse in both JAQK and Shark has two rows sharing one horse_id, so a
       keyset cursor on horse_id alone drops a row at every page boundary that
       lands between them. Measured on the first live read: 1,579 of 1,580.
       It reads as "this horse has no Shark tag", not as an error. */
    expect(src).toContain(".eq('club_id', clubId)");
    expect(src).toContain('for (const clubId of new Set(Object.values(WALLETS_FOR_HOST).flat()))');
  });

  it('discards a partial read rather than serving it', () => {
    expect(src.match(/if \(!page\.complete\) return null;/g)?.length).toBe(2);
  });

  it('keeps the last good book rather than dropping to an empty one', () => {
    // An empty book reads as "every horse is untagged", which is a decision.
    // Null reads as "no book", which is not.
    expect(src).toContain('if (tags) {');
    expect(src).toContain('if (states) {');
  });

  it('THE TAGS ARE THE BOOK; a failed state read does not throw the tags away', () => {
    /* This cost four hours of live running on 2026-09-04. Returning null
       unless BOTH reads succeeded meant one slow state read switched off the
       whole tag layer - variants, stakes, lanes, table ceilings - and wrote no
       counter, silently. Every state reader already fails open on a missing
       row, so tags-without-states is the smaller and honest degradation. */
    expect(src).toContain('if (!this.tags) return null;');
    expect(src).toContain('states: this.states ?? new Map()');
    expect(src).not.toContain('if (!this.tags || !this.states)');
  });

  it('holds one read at a time', () => {
    expect(src).toContain('if (this.inFlight) return this.inFlight;');
  });

  it('caches tags longer than state, because only state moves', () => {
    expect(TAG_TTL_MS).toBeGreaterThan(STATE_TTL_MS);
  });

  it('does not re-read the whole state table on every seeding cycle', () => {
    /* It was 25 seconds against a 30-second cycle, so a 1,000-row read ran on
       every pass for no gain: this cycle folds its own writes back into the
       cached map before the next one reads it, and there is no other writer. */
    expect(STATE_TTL_MS).toBeGreaterThan(30_000);
  });

  it('never writes', () => {
    expect(src).not.toContain('.update(');
    expect(src).not.toContain('.insert(');
    expect(src).not.toContain('.upsert(');
    expect(src).not.toContain('.delete(');
  });
});

describe('tagKey', () => {
  it('is the membership, not the horse', () => {
    expect(tagKey('h', 'a')).not.toBe(tagKey('h', 'b'));
  });
});
