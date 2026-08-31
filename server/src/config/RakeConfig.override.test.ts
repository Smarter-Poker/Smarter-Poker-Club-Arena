/**
 * PER-TABLE / PER-CLUB RAKE OVERRIDES (2026-08-18).
 *
 * Four owner-facing controls — the club's "Default Rake (%)" and "Rake Cap
 * (BB)", and a table's "Fee" and "FeeCap" sliders — wrote
 * clubs.default_rake_percent, clubs.rake_cap, tables.rake_percent and
 * tables.rake_cap_bb. Nothing read any of them. An owner who set 2% still had
 * 10% taken, and the settings screen said "Settings saved!".
 *
 * This file pins the arithmetic. Two things make it money-critical:
 *
 *   1. The UI cap is in BIG BLINDS; everything downstream of getFullRakeConfig
 *      (calculateRake's Math.min, getPlayerCountCaps' short-handed multipliers)
 *      assumes an absolute cash cap. The conversion happens in exactly one
 *      place and 3 BB means $0.60 at 0.10/0.20 and $75 at 10/25.
 *   2. `tables` is UPDATE-able by any club admin through RLS, so the column is
 *      not a trusted input. The clamp in getFullRakeConfig is the real guard;
 *      a DB CHECK is defence in depth, not the defence.
 */
import { describe, it, expect } from 'vitest';
import {
  getFullRakeConfig,
  getPlayerCountCaps,
  MAX_RAKE_CAP_BB,
  MAX_RAKE_PERCENT,
  RAKE_INHERIT,
  RAKE_SCHEDULE,
} from './RakeConfig.js';
import { calculateRake } from '../engine/PokerEngine.js';

describe('no override - the published schedule is untouched', () => {
  it('every scheduled stake returns exactly its scheduled rate and cap', () => {
    for (const row of RAKE_SCHEDULE) {
      const cfg = getFullRakeConfig(row.sb, row.bb);
      expect(cfg.rakePercent).toBe(row.rakePercent);
      expect(cfg.rakeCap).toBe(row.rakeCap);
      expect(cfg._overridden).toEqual({ percent: false, cap: false });
    }
  });

  it('the inherit sentinel is indistinguishable from passing nothing', () => {
    const plain = getFullRakeConfig(1, 2);
    const sentinel = getFullRakeConfig(1, 2, 'nlh', {
      rakePercent: RAKE_INHERIT,
      rakeCapBB: RAKE_INHERIT,
    });
    expect(sentinel.rakePercent).toBe(plain.rakePercent);
    expect(sentinel.rakeCap).toBe(plain.rakeCap);
    expect(sentinel._overridden).toEqual({ percent: false, cap: false });
  });

  it('null and undefined also mean inherit', () => {
    const plain = getFullRakeConfig(1, 2);
    for (const v of [null, undefined]) {
      const cfg = getFullRakeConfig(1, 2, 'nlh', { rakePercent: v, rakeCapBB: v });
      expect(cfg.rakePercent).toBe(plain.rakePercent);
      expect(cfg.rakeCap).toBe(plain.rakeCap);
    }
  });
});

describe('the cap is given in big blinds and stored in dollars', () => {
  // 3 BB is a very different amount of money at each end of the schedule.
  // Every row here stays at or under the stake's published cap, so it isolates
  // the BB -> dollars conversion. Rows that would EXCEED the published cap live
  // in 'the published cap is a ceiling' below, because the conversion is no
  // longer the only thing acting on them.
  it.each([
    [0.1, 0.2, 3, 0.6],
    [0.5, 1, 3, 3],
    [1, 2, 2, 4],
    [5, 10, 1, 10],
    [10, 25, 0.5, 12.5],
    [1, 2, 2.5, 5],
    [2, 5, 1.5, 7.5],
  ])('%s/%s with a %s BB cap -> $%s', (sb, bb, capBB, dollars) => {
    const cfg = getFullRakeConfig(sb, bb, 'nlh', { rakeCapBB: capBB });
    expect(cfg.rakeCap).toBe(dollars);
    expect(cfg.rakeCapDollars).toBe(dollars);
    expect(cfg._overridden.cap).toBe(true);
  });

  it('rounds to whole cents', () => {
    // 0.33 BB at 0.10/0.20 = 0.066 -> 0.07
    expect(getFullRakeConfig(0.1, 0.2, 'nlh', { rakeCapBB: 0.33 }).rakeCap).toBe(0.07);
  });

  it('feeds the short-handed caps, which are derived AFTER the conversion', () => {
    const cfg = getFullRakeConfig(1, 2, 'nlh', { rakeCapBB: 2 }); // $4, under the $5 cap
    const caps = getPlayerCountCaps(cfg.rakeCap);
    expect(caps.find((c) => c.players === 2)!.cap).toBe(2);
    expect(caps.find((c) => c.players === 4)!.cap).toBe(4);
  });
});

describe('an owner can take less, never more', () => {
  it('accepts a lower percent', () => {
    const cfg = getFullRakeConfig(1, 2, 'nlh', { rakePercent: 2 });
    expect(cfg.rakePercent).toBe(2);
    expect(cfg._overridden.percent).toBe(true);
  });

  it('clamps a percent above the schedule rate', () => {
    expect(getFullRakeConfig(1, 2, 'nlh', { rakePercent: 90 }).rakePercent).toBe(MAX_RAKE_PERCENT);
  });

  it('clamps an absurd cap down to the published cap for the stake', () => {
    // 999 BB would mean the cap never binds at all. MAX_RAKE_CAP_BB stops the
    // absurdity; the schedule stops it exceeding what 1/2 is allowed to rake.
    expect(getFullRakeConfig(1, 2, 'nlh', { rakeCapBB: 999 }).rakeCap).toBe(5);
  });

  describe('the published cap is a ceiling - each game has a max rake', () => {
    it('never exceeds the scheduled cap at ANY stake, whatever is asked for', () => {
      for (const row of RAKE_SCHEDULE) {
        for (const capBB of [1, 3, 5, 10, 999]) {
          const cfg = getFullRakeConfig(row.sb, row.bb, 'nlh', { rakeCapBB: capBB });
          expect(cfg.rakeCap, `${row.sb}/${row.bb} asked for ${capBB} BB`).toBeLessThanOrEqual(
            row.rakeCap
          );
        }
        for (const pct of [11, 50, 100]) {
          const cfg = getFullRakeConfig(row.sb, row.bb, 'nlh', { rakePercent: pct });
          expect(cfg.rakePercent).toBeLessThanOrEqual(row.rakePercent);
        }
      }
    });

    it.each([
      // stake,      capBB, published cap, what BB->$ alone would have given
      [1, 2, 3, 5, 6],
      [5, 10, 3, 12.5, 30],
      [10, 25, 3, 15, 75],
      [5, 10, 10, 12.5, 100],
      [10, 25, 10, 15, 250],
    ])(
      '%s/%s with a %s BB cap is held to $%s (unbounded conversion would be $%s)',
      (sb, bb, capBB, published) => {
        expect(getFullRakeConfig(sb, bb, 'nlh', { rakeCapBB: capBB }).rakeCap).toBe(published);
      }
    );

    it('a below-ceiling override is still honoured exactly', () => {
      expect(getFullRakeConfig(5, 10, 'nlh', { rakeCapBB: 1 }).rakeCap).toBe(10);
      expect(getFullRakeConfig(5, 10, 'nlh', { rakePercent: 4 }).rakePercent).toBe(4);
    });
  });

  it('treats a negative as inherit, not as a rake-free table by accident', () => {
    const plain = getFullRakeConfig(1, 2);
    const cfg = getFullRakeConfig(1, 2, 'nlh', { rakePercent: -5, rakeCapBB: -5 });
    expect(cfg.rakePercent).toBe(plain.rakePercent);
    expect(cfg.rakeCap).toBe(plain.rakeCap);
  });

  it('falls back to the schedule on garbage rather than throwing', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const cfg = getFullRakeConfig(1, 2, 'nlh', { rakePercent: bad, rakeCapBB: bad });
      expect(cfg.rakePercent).toBe(10);
      expect(cfg.rakeCap).toBe(5);
    }
  });

  it('ZERO is a real setting - a rake-free table, not an unset one', () => {
    const cfg = getFullRakeConfig(1, 2, 'nlh', { rakePercent: 0, rakeCapBB: 0 });
    expect(cfg.rakePercent).toBe(0);
    expect(cfg.rakeCap).toBe(0);
    expect(cfg._overridden).toEqual({ percent: true, cap: true });
    expect(calculateRake(500, true, { percent: 0, cap: 0, noFlopNoDrop: true }, 6)).toBe(0);
  });
});

describe('the jackpot drop is not overridable', () => {
  it('keeps every BBJ field on the schedule even when rake is overridden', () => {
    const plain = getFullRakeConfig(1, 2);
    const cfg = getFullRakeConfig(1, 2, 'nlh', { rakePercent: 1, rakeCapBB: 0 });
    expect(cfg.bbjEnabled).toBe(plain.bbjEnabled);
    expect(cfg.bbjFeeBB).toBe(plain.bbjFeeBB);
    expect(cfg.bbjFeeDollars).toBe(plain.bbjFeeDollars);
    expect(cfg.bbjPayoutLoser).toBe(plain.bbjPayoutLoser);
    expect(cfg.bbjPayoutWinner).toBe(plain.bbjPayoutWinner);
    expect(cfg.bbjPayoutTable).toBe(plain.bbjPayoutTable);
    expect(cfg.rules).toEqual(plain.rules);
    expect(cfg.qualifyingHand).toEqual(plain.qualifyingHand);
  });
});

describe('end to end through calculateRake', () => {
  const build = (sb: number, bb: number, o?: { rakePercent?: number; rakeCapBB?: number }) => {
    const full = getFullRakeConfig(sb, bb, 'nlh', o);
    return {
      percent: full.rakePercent,
      cap: full.rakeCap,
      noFlopNoDrop: true,
      playerCountCaps: getPlayerCountCaps(full.rakeCap),
    };
  };

  it('a 2% table takes a fifth of what the schedule would', () => {
    const pot = 100;
    expect(calculateRake(pot, true, build(1, 2), 6)).toBe(5); // schedule: 10% capped at $5
    expect(calculateRake(pot, true, build(1, 2, { rakePercent: 2 }), 6)).toBe(2);
  });

  it('a tighter cap binds before the percent does', () => {
    // 10% of a 200 pot is 20; the schedule cap is 5; a 1 BB cap is 2.
    expect(calculateRake(200, true, build(1, 2), 6)).toBe(5);
    expect(calculateRake(200, true, build(1, 2, { rakeCapBB: 1 }), 6)).toBe(2);
  });

  it('no flop, no drop still wins over any override', () => {
    expect(calculateRake(200, false, build(1, 2, { rakePercent: 10, rakeCapBB: 10 }), 6)).toBe(0);
  });

  it('heads-up still halves the overridden cap', () => {
    // 2 BB cap at 1/2 = $4; heads-up = $2.
    expect(calculateRake(500, true, build(1, 2, { rakeCapBB: 2 }), 2)).toBe(2);
    expect(calculateRake(500, true, build(1, 2, { rakeCapBB: 2 }), 6)).toBe(4);
  });
});
