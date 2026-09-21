/**
 * BLINDS DO NOT EXPLODE AFTER AN ENGINE RESTART (2026-08-27, P0).
 *
 * The defect these pin: the escalation factor was anchored to the length of an
 * array that the same code then PUSHED to. Anchor and level stayed in lockstep
 * in steady state, so it looked correct forever; a restart re-read the
 * structure at its persisted length while `current_level` came back from the
 * database, and from there every push multiplied by the same large factor
 * again. Three levels later the big blind was clamped at ten million.
 *
 * The regression test that matters is the last one in the first block: the same
 * (level, persisted length) must give the same blinds no matter how many times
 * it is asked. That is only true because nothing grows the array.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_BLIND_VALUE,
  capLevelToChipsInPlay,
  escalationFactor,
  escalatedBlindLevel,
  enforcePlayableBlindLevel,
  lastPlayableIndex,
} from './blindEscalation.js';

/** A 10-level structure whose last playable row is 375/750 ante 75. */
const LAST = { level: 10, smallBlind: 375, bigBlind: 750, ante: 75 };
const LEN = 10;

describe('escalation is anchored to the PERSISTED length', () => {
  /**
   * WAS "doubles once per level past the end" (2026-08-31).
   *
   * It no longer doubles, and that is the point: 95.7% of production MTTs ran
   * past the end of their structure, so doubling was the late game of nearly
   * every tournament on the platform rather than a rare tail. The ANCHORING
   * contract this file exists to protect is unchanged and is still asserted
   * below — only the ratio moved. See tournament/blindLadder.ts.
   */
  it('steps once per level past the end, at the ladder ratio - never doubling', () => {
    expect(escalationFactor(10, LEN)).toBeCloseTo(1.4, 10);
    expect(escalationFactor(11, LEN)).toBeCloseTo(Math.pow(1.4, 2), 10);
    expect(escalationFactor(12, LEN)).toBeCloseTo(Math.pow(1.4, 3), 10);
    expect(escalationFactor(13, LEN)).toBeCloseTo(Math.pow(1.4, 4), 10);
    // The defect, named so it cannot come back quietly.
    expect(escalationFactor(10, LEN)).not.toBe(2);
  });

  it('honours an explicit ratio, which is how the manager passes the real ladder cadence', () => {
    expect(escalationFactor(10, LEN, 2)).toBe(2);
    expect(escalationFactor(11, LEN, 2)).toBe(4);
  });

  it('is stateless: the answer for a level never depends on how it was reached', () => {
    // THE RESTART CASE. Steady state walked 10, 11, 12, 13, 14 and arrived at
    // 2^5. A process that resumes cold at level 14 must compute 2^5 too — with
    // the old push-based code its FIRST answer was right and every one after it
    // was 32x too big, because the push had moved the anchor.
    const steadyState = [10, 11, 12, 13, 14].map((n) => escalationFactor(n, LEN, 2)).pop();
    const coldResume = escalationFactor(14, LEN, 2);
    expect(coldResume).toBe(steadyState);
    expect(coldResume).toBe(32);

    // And the same statelessness at the real default ratio.
    const liveSteady = [10, 11, 12, 13, 14].map((n) => escalationFactor(n, LEN)).pop();
    expect(escalationFactor(14, LEN)).toBe(liveSteady);
    expect(escalationFactor(14, LEN)).toBeCloseTo(Math.pow(1.4, 5), 10);
  });

  it('asking for the same level twice gives the same blinds', () => {
    const a = escalatedBlindLevel(LAST, 14, LEN, 10, 2);
    const b = escalatedBlindLevel(LAST, 14, LEN, 10, 2);
    const c = escalatedBlindLevel(LAST, 14, LEN, 10, 2);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // And it is 32x the last PERSISTED level, not 32x the previous answer.
    expect(a.bigBlind).toBe(750 * 32);
  });

  it('reproduces the shape the live incident had, and does NOT explode', () => {
    // 24,000 -> 48,000 -> 1,536,000 was the observed run. The middle step is a
    // legitimate double; the third is the anchor having moved underneath it.
    const l1 = escalatedBlindLevel(LAST, 14, LEN, 10, 2).bigBlind; // 24,000
    const l2 = escalatedBlindLevel(LAST, 15, LEN, 10, 2).bigBlind;
    const l3 = escalatedBlindLevel(LAST, 16, LEN, 10, 2).bigBlind;
    expect(l1).toBe(24_000);
    expect(l2).toBe(l1 * 2);
    expect(l3).toBe(l2 * 2);
    expect(l3).not.toBe(1_536_000);

    // At the ratio that actually ships, the same run is far gentler — which is
    // the entire point of the change.
    const r1 = escalatedBlindLevel(LAST, 14, LEN, 10).bigBlind;
    const r3 = escalatedBlindLevel(LAST, 16, LEN, 10).bigBlind;
    // Whole chips now (2026-09-11), so the ratio holds to the rounding, not
    // to six decimal places.
    expect(r3 / r1).toBeCloseTo(Math.pow(1.4, 2), 2);
    expect(r3).toBeLessThan(l3);
  });
});

describe('the escalated level is safe to write to the database', () => {
  it('clamps at the DECIMAL(10,2) ceiling', () => {
    const far = escalatedBlindLevel(LAST, 400, LEN, 10);
    expect(far.bigBlind).toBe(MAX_BLIND_VALUE);
    expect(far.smallBlind).toBe(MAX_BLIND_VALUE / 2);
    expect(far.smallBlind).toBeLessThan(far.bigBlind);
  });

  it('repairs the exact shared-ceiling shape before the engine writes it', () => {
    expect(
      enforcePlayableBlindLevel({
        smallBlind: MAX_BLIND_VALUE,
        bigBlind: MAX_BLIND_VALUE,
        ante: MAX_BLIND_VALUE,
      })
    ).toMatchObject({
      smallBlind: MAX_BLIND_VALUE / 2,
      bigBlind: MAX_BLIND_VALUE,
      ante: MAX_BLIND_VALUE,
      adjusted: true,
    });

    const capped = capLevelToChipsInPlay(
      { smallBlind: MAX_BLIND_VALUE, bigBlind: MAX_BLIND_VALUE, ante: MAX_BLIND_VALUE },
      6_000_000
    );
    expect(capped).toMatchObject({ smallBlind: 150_000, bigBlind: 300_000, capped: true });
    expect(capped.smallBlind).toBeLessThan(capped.bigBlind);
  });

  /**
   * THE BAND BETWEEN THE TWO CEILINGS (2026-09-21).
   *
   * MAX_BLIND_VALUE used to be applied to the small blind and to the big blind
   * independently, and the only repair was `SB >= BB`. Between the level where
   * the big blind reaches the ceiling and the level where the small blind
   * reaches it too, SB < BB the whole way and nothing fired, so the authored
   * share walked from 1:2 towards 1:1 one level at a time. Calling the live
   * SQL resolver on 2026-09-21 with an anchor of sb 2,000,000 / bb 4,000,000
   * returned 0.5000, 0.6321, 0.8428 and only then 0.5000 again.
   */
  it('holds the small blind to its requested share when only the big blind is capped', () => {
    // The big blind is over the ceiling and the small blind is not: exactly
    // the band. 1:2 in, 1:2 out.
    expect(
      enforcePlayableBlindLevel({
        smallBlind: 9_000_000,
        bigBlind: 18_000_000,
        ante: 0,
      })
    ).toMatchObject({ smallBlind: 5_000_000, bigBlind: MAX_BLIND_VALUE, adjusted: true });

    // Right at the top of the band, where the small blind is one chip short
    // of the ceiling itself.
    const edge = enforcePlayableBlindLevel({
      smallBlind: MAX_BLIND_VALUE - 1,
      bigBlind: 2 * MAX_BLIND_VALUE - 2,
    });
    expect(edge.smallBlind).toBe(MAX_BLIND_VALUE / 2);
    expect(edge.bigBlind).toBe(MAX_BLIND_VALUE);

    // A structure authoring a THIRD keeps its third. bb/2 is not the rule;
    // the requested share is.
    const third = enforcePlayableBlindLevel({ smallBlind: 6_000_000, bigBlind: 18_000_000 });
    expect(third.bigBlind).toBe(MAX_BLIND_VALUE);
    expect(third.smallBlind).toBe(Math.floor(MAX_BLIND_VALUE / 3));
  });

  it('leaves every level that is under the ceiling exactly as it was', () => {
    for (const [sb, bb] of [
      [50, 100],
      [1, 2],
      [25, 50],
      [1_333_333, 4_000_000],
      [MAX_BLIND_VALUE / 2, MAX_BLIND_VALUE],
    ] as const) {
      const out = enforcePlayableBlindLevel({ smallBlind: sb, bigBlind: bb, ante: 0 });
      expect([out.smallBlind, out.bigBlind]).toEqual([sb, bb]);
    }
  });

  it('never raises a small blind, only ever lowers one', () => {
    // A request that already asks for SB >= BB is the older repair's business.
    // The share ceiling must not push it back up.
    expect(enforcePlayableBlindLevel({ smallBlind: 300, bigBlind: 200 }).smallBlind).toBe(100);
    expect(enforcePlayableBlindLevel({ smallBlind: 200, bigBlind: 200 }).smallBlind).toBe(100);
    // And an absurdly small requested share is honoured rather than widened.
    expect(enforcePlayableBlindLevel({ smallBlind: 1, bigBlind: 1000 }).smallBlind).toBe(1);
  });

  it('carries the requested share through a deep escalation, not a saturated 1:1', () => {
    // escalatedBlindLevel used to saturate each number at MAX_BLIND_VALUE
    // before enforcePlayableBlindLevel could read the share. Past the point
    // where the big blind alone is capped, the small blind must still be half.
    for (const idx of [30, 60, 120, 400, 5000]) {
      const lvl = escalatedBlindLevel({ smallBlind: 1_500_000, bigBlind: 3_000_000, ante: 0 }, idx, LEN, 10);
      expect(Number.isFinite(lvl.smallBlind)).toBe(true);
      expect(lvl.smallBlind).toBeLessThan(lvl.bigBlind);
      expect(lvl.smallBlind).toBeLessThanOrEqual(lvl.bigBlind / 2);
    }
  });

  it('never produces NaN or Infinity, however far out the level is', () => {
    for (const idx of [50, 100, 1000, 100000]) {
      const lvl = escalatedBlindLevel({ smallBlind: 10, bigBlind: 20, ante: 0 }, idx, LEN, 10);
      for (const v of [lvl.smallBlind, lvl.bigBlind, lvl.ante]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('a zero ante stays zero rather than becoming NaN at a huge factor', () => {
    // 0 * Infinity is NaN, which is why the exponent is capped rather than the
    // product alone. An ante of NaN fails the numeric column outright.
    const lvl = escalatedBlindLevel({ smallBlind: 25, bigBlind: 50, ante: 0 }, 5000, LEN, 10);
    expect(lvl.ante).toBe(0);
  });

  it('missing or garbage figures become the minimum legal blind level, never NaN', () => {
    const lvl = escalatedBlindLevel({ smallBlind: 'x', bigBlind: null }, 11, LEN, 10);
    expect(lvl.smallBlind).toBe(1);
    expect(lvl.bigBlind).toBe(2);
    expect(lvl.ante).toBe(0);
  });

  it('keeps the supplied positive duration, including short advertised levels', () => {
    expect(escalatedBlindLevel(LAST, 11, LEN, 0.5).durationMinutes).toBe(0.5);
    expect(escalatedBlindLevel(LAST, 11, LEN, 1).durationMinutes).toBe(1);
    expect(escalatedBlindLevel(LAST, 11, LEN, 7).durationMinutes).toBe(7);
  });
});

describe('escalation starts from the last PLAYABLE level', () => {
  it('steps back over trailing break rows so the blinds never grow from zero', () => {
    const withBreaks = [
      { smallBlind: 25, bigBlind: 50 },
      { smallBlind: 50, bigBlind: 100 },
      { isBreak: true, smallBlind: 0, bigBlind: 0 },
    ];
    expect(lastPlayableIndex(withBreaks)).toBe(1);
    const lvl = escalatedBlindLevel(withBreaks[lastPlayableIndex(withBreaks)], 3, 3, 10, 2);
    expect(lvl.bigBlind).toBe(200);

    // The break row must not be what the ladder grows from, at any ratio.
    const live = escalatedBlindLevel(withBreaks[lastPlayableIndex(withBreaks)], 3, 3, 10);
    expect(live.bigBlind).toBeGreaterThan(100);
  });

  it('an all-break structure falls back to index 0 rather than looping', () => {
    expect(lastPlayableIndex([{ isBreak: true }, { isBreak: true }])).toBe(0);
  });
});

/**
 * AN INVENTED LEVEL IS WHOLE CHIPS (2026-09-11).
 *
 * At the observed 1.278 cadence, 200/400 escalated to 255.58/511.15. Tournament
 * chips are an INTEGER column, so every hand that ended with a fractional stack
 * failed its commit's own stack check and was rolled back whole: 22 refused
 * hands on three heads-up SNGs in two minutes, and 12 more SNGs by 01:37.
 */
describe('an escalated level is whole chips', () => {
  it('rounds the live incident shape to whole chips', () => {
    const last = { level: 12, smallBlind: 200, bigBlind: 400, ante: 0 };
    const lvl = escalatedBlindLevel(last, 12, 12, 5, 1.27787);
    expect(lvl.smallBlind).toBe(256);
    expect(lvl.bigBlind).toBe(511);
    expect(lvl.ante).toBe(0);
  });

  it('every figure is an integer at every level and every ratio the manager can pass', () => {
    const structures = [
      { smallBlind: 200, bigBlind: 400, ante: 0 },
      { smallBlind: 375, bigBlind: 750, ante: 75 },
      { smallBlind: 1, bigBlind: 2, ante: 0 },
      { smallBlind: 3, bigBlind: 5, ante: 1 },
      { smallBlind: 1500, bigBlind: 3000, ante: 300 },
    ];
    for (const last of structures) {
      for (const ratio of [1.15, 1.2, 1.27787, 1.33, 1.4, 1.5, 1.6]) {
        let prevBig = 0;
        for (let index = 10; index < 40; index++) {
          const lvl = escalatedBlindLevel(last, index, 10, 5, ratio);
          expect(
            Number.isInteger(lvl.smallBlind),
            `${JSON.stringify(last)} r=${ratio} i=${index}`
          ).toBe(true);
          expect(Number.isInteger(lvl.bigBlind)).toBe(true);
          expect(Number.isInteger(lvl.ante)).toBe(true);
          expect(lvl.smallBlind).toBeGreaterThanOrEqual(1);
          expect(lvl.smallBlind).toBeLessThan(lvl.bigBlind);
          // Rounding never makes a later level smaller than an earlier one.
          expect(lvl.bigBlind).toBeGreaterThanOrEqual(prevBig);
          prevBig = lvl.bigBlind;
        }
      }
    }
  });

  it('the chip cap applied after it keeps the figures whole', () => {
    const lvl = escalatedBlindLevel(
      { smallBlind: 200, bigBlind: 400, ante: 40 },
      20,
      12,
      5,
      1.27787
    );
    const capped = capLevelToChipsInPlay(lvl, 123_457);
    expect(Number.isInteger(capped.smallBlind)).toBe(true);
    expect(Number.isInteger(capped.bigBlind)).toBe(true);
    expect(Number.isInteger(capped.ante)).toBe(true);
  });
});
