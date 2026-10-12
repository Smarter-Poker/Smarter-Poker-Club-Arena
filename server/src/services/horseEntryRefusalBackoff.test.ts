import { describe, expect, it } from 'vitest';
import {
  HORSE_ENTRY_FIRST_RECHECK_MS,
  HORSE_ENTRY_MAX_RECHECK_MS,
  HorseEntryRefusalBackoff,
  databaseDidNotAnswer,
  jitteredBackoffMs,
} from './horseEntryRefusalBackoff.js';

describe('jitteredBackoffMs', () => {
  it('waits between half and all of a doubling ceiling, never past the cap', () => {
    expect(jitteredBackoffMs(1, 200, 800, () => 0)).toBe(100);
    expect(jitteredBackoffMs(1, 200, 800, () => 1)).toBe(200);
    expect(jitteredBackoffMs(2, 200, 800, () => 0)).toBe(200);
    expect(jitteredBackoffMs(2, 200, 800, () => 1)).toBe(400);
    expect(jitteredBackoffMs(9, 200, 800, () => 1)).toBe(800);
    expect(jitteredBackoffMs(9, 200, 800, () => 0)).toBe(400);
  });
  it('treats a nonsense attempt as the first and clamps the random draw', () => {
    expect(jitteredBackoffMs(0, 200, 800, () => 5)).toBe(200);
    expect(jitteredBackoffMs(Number.NaN, 200, 800, () => -1)).toBe(100);
  });
  it('spreads callers that failed together', () => {
    const waits = new Set(
      Array.from({ length: 50 }, (_, i) => jitteredBackoffMs(1, 200, 800, () => i / 50))
    );
    expect(waits.size).toBeGreaterThan(40);
  });
});

describe('databaseDidNotAnswer', () => {
  it.each([
    [{ message: 'supabase_timeout' }],
    [{ message: 'x', code: 'PGRST003' }],
    [{ message: 'Timed out acquiring connection from connection pool.' }],
    [{ message: 'TypeError: fetch failed' }],
    [{ message: 'canceling statement due to statement timeout', code: '57014' }],
    [{ message: 'upstream answered 504' }],
  ])('%j did not answer', (error) => expect(databaseDidNotAnswer(error)).toBe(true));
  it.each([
    [{ message: 'ticket admission tournament cache changed', code: '55000' }],
    [{ message: 'F06_RETRY_CANONICAL_LANE', code: '55P03' }],
    [null],
  ])('%j is an answer', (error) => expect(databaseDidNotAnswer(error)).toBe(false));
});

describe('HorseEntryRefusalBackoff', () => {
  it('defers by tournament and horse, doubles to the cap, and clears on an answer', () => {
    let now = 0;
    const b = new HorseEntryRefusalBackoff(
      () => now,
      () => 1
    );
    expect(b.shouldAttempt('t', 'h')).toBe(true);
    expect(b.refused('t', 'h')).toBe(HORSE_ENTRY_FIRST_RECHECK_MS);
    expect(b.shouldAttempt('t', 'h')).toBe(false);
    expect(b.shouldAttempt('t', 'other')).toBe(true);
    expect(b.shouldAttempt('u', 'h')).toBe(true);
    now += HORSE_ENTRY_FIRST_RECHECK_MS;
    expect(b.shouldAttempt('t', 'h')).toBe(true);
    expect(b.refused('t', 'h')).toBe(2 * HORSE_ENTRY_FIRST_RECHECK_MS);
    for (let i = 0; i < 10; i++) b.refused('t', 'h');
    expect(b.refused('t', 'h')).toBe(HORSE_ENTRY_MAX_RECHECK_MS);
    b.settled('t', 'h');
    expect(b.shouldAttempt('t', 'h')).toBe(true);
    expect(b.size).toBe(0);
  });
  it('forgets a deferral nobody has looked at for a day', () => {
    let now = 0;
    const b = new HorseEntryRefusalBackoff(() => now);
    b.refused('t', 'old');
    now += 25 * 60 * 60 * 1000;
    b.refused('t', 'new');
    expect(b.size).toBe(1);
  });
});
