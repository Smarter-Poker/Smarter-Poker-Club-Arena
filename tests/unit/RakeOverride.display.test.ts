/**
 * WHAT THE PLAYER IS SHOWN MUST BE WHAT THE ENGINE TAKES (2026-08-18).
 *
 * On 2026-08-15 the Game Rules modal was found telling every player
 * "Rake 5% (Cap $3)" at every stake, because the props feeding it were never
 * assigned and the component fell through to placeholder defaults. That was
 * fixed by reading the client copy of the published schedule, and
 * scripts/ci/check-rake-schedule-parity.mjs keeps the two copies in step.
 *
 * Per-table and per-club rake overrides reopen exactly that hole: a table whose
 * owner sets 2% would still be SHOWN the schedule's 10%, and only for the
 * tables somebody bothered to configure. So the client resolver has to apply
 * the same precedence and the same clamps as
 * server/src/config/RakeConfig.ts getFullRakeConfig.
 *
 * This file pins the client half. The server half is pinned in
 * server/src/config/RakeConfig.override.test.ts, and the numbers below are
 * deliberately the same ones.
 */
import { describe, it, expect } from 'vitest';
import {
  getRakeConfig,
  MAX_RAKE_CAP_BB,
  MAX_RAKE_PERCENT,
  RAKE_INHERIT,
} from '../../src/config/RakeConfig';

describe('no override — the player sees the published schedule', () => {
  it('1/2 shows 10% capped at $5', () => {
    const c = getRakeConfig(2, 'nlh', 1);
    expect(c.rakePercent).toBe(10);
    expect(c.rakeCap).toBe(5);
  });

  it('the inherit sentinel reads the same as no override at all', () => {
    const plain = getRakeConfig(2, 'nlh', 1);
    const sentinel = getRakeConfig(2, 'nlh', 1, {
      rakePercent: RAKE_INHERIT,
      rakeCapBB: RAKE_INHERIT,
    });
    expect(sentinel.rakePercent).toBe(plain.rakePercent);
    expect(sentinel.rakeCap).toBe(plain.rakeCap);
  });
});

describe('with an override — the player sees the override', () => {
  it('shows the reduced percent', () => {
    expect(getRakeConfig(2, 'nlh', 1, { rakePercent: 2 }).rakePercent).toBe(2);
  });

  it('converts a big-blind cap to cash exactly as the server does', () => {
    // Each of these sits at or under its stake's published cap, so what is
    // being checked is purely the BB -> dollars conversion.
    expect(getRakeConfig(2, 'nlh', 1, { rakeCapBB: 2 }).rakeCap).toBe(4);
    expect(getRakeConfig(0.2, 'nlh', 0.1, { rakeCapBB: 3 }).rakeCap).toBe(0.6);
    expect(getRakeConfig(25, 'nlh', 10, { rakeCapBB: 0.5 }).rakeCap).toBe(12.5);
  });

  it('shows a rake-free table as 0, not as the schedule', () => {
    const c = getRakeConfig(2, 'nlh', 1, { rakePercent: 0, rakeCapBB: 0 });
    expect(c.rakePercent).toBe(0);
    expect(c.rakeCap).toBe(0);
  });

  it('never shows more than the schedule allows', () => {
    // "The schedule" means the published cap for THAT stake, not MAX_RAKE_CAP_BB.
    // 1/2 is capped at $5, so 3 BB ($6), 10 BB ($20) and 999 BB all display $5 —
    // which is what the engine will actually take.
    expect(getRakeConfig(2, 'nlh', 1, { rakePercent: 90 }).rakePercent).toBe(MAX_RAKE_PERCENT);
    expect(getRakeConfig(2, 'nlh', 1, { rakeCapBB: 999 }).rakeCap).toBe(5);
    expect(getRakeConfig(2, 'nlh', 1, { rakeCapBB: MAX_RAKE_CAP_BB }).rakeCap).toBe(5);
    expect(getRakeConfig(2, 'nlh', 1, { rakeCapBB: 3 }).rakeCap).toBe(5);
  });

  it('treats junk as inherit rather than displaying nonsense', () => {
    const plain = getRakeConfig(2, 'nlh', 1);
    for (const bad of [NaN, -5, null, undefined]) {
      const c = getRakeConfig(2, 'nlh', 1, { rakePercent: bad, rakeCapBB: bad });
      expect(c.rakePercent).toBe(plain.rakePercent);
      expect(c.rakeCap).toBe(plain.rakeCap);
    }
  });

  it('leaves the jackpot drop alone', () => {
    const plain = getRakeConfig(2, 'nlh', 1);
    const c = getRakeConfig(2, 'nlh', 1, { rakePercent: 1, rakeCapBB: 0 });
    expect(c.bbjFeeBB).toBe(plain.bbjFeeBB);
    expect(c.bbjEnabled).toBe(plain.bbjEnabled);
  });
});
