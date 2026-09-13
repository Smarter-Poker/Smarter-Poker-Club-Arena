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
  escalationFactor,
  escalatedBlindLevel,
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
    //
    // UPDATED 2026-09-09, because the level is now ROUNDED. This asserted
    // `r3 / r1` to seven decimal places, which can only hold while the blinds
    // are raw floats: 750 * 1.4^5 is 4033.68, and a blind of 4033.68 is written
    // to a DECIMAL(10,2) column and posted at a felt where every stack is an
    // integer. The pin moves to the new mechanism rather than being weakened -
    // it now names the exact whole numbers the ratio produces, and requires
    // them to BE whole numbers, which is the stronger statement.
    const r1 = escalatedBlindLevel(LAST, 14, LEN, 10).bigBlind;
    const r3 = escalatedBlindLevel(LAST, 16, LEN, 10).bigBlind;
    expect(r1).toBe(Math.round(750 * Math.pow(1.4, 5)));
    expect(r3).toBe(Math.round(750 * Math.pow(1.4, 7)));
    expect(Number.isInteger(r1)).toBe(true);
    expect(Number.isInteger(r3)).toBe(true);
    // Still two steps apart at the ladder ratio, to whatever precision rounding
    // two integers permits.
    expect(r3 / r1).toBeCloseTo(Math.pow(1.4, 2), 2);
    expect(r3).toBeLessThan(l3);
  });

  /**
   * `Math.min` IS NOT A ROUND (2026-09-09).
   *
   * `escalatedBlindLevel` scaled by `Math.pow(ratio, exponent)` and clamped the
   * result with `Math.min(..., MAX_BLIND_VALUE)`, and nothing rounded. Neither
   * that ceiling nor `capLevelToChipsInPlay` bites on a healthy ladder - both
   * return the level unchanged when they do not fire - so the ordinary case was
   * a fractional blind: a small blind of 1000 one level past the structure came
   * out as 1316.0740129524924. That is written to `tables.small_blind` /
   * `big_blind` / `ante` (DECIMAL(10,2)) and into `tables.stakes` as the raw JS
   * float string the masthead, the lobby rows and every BB-depth badge render.
   */
  it('never emits a fractional blind or ante', () => {
    for (let index = LEN; index < LEN + 12; index++) {
      const lvl = escalatedBlindLevel(LAST, index, LEN, 10);
      expect(Number.isInteger(lvl.smallBlind)).toBe(true);
      expect(Number.isInteger(lvl.bigBlind)).toBe(true);
      expect(Number.isInteger(lvl.ante)).toBe(true);
    }
    // A structure with no ante keeps no ante - rounding must not invent one.
    const noAnte = escalatedBlindLevel({ ...LAST, ante: 0 }, LEN + 3, LEN, 10);
    expect(noAnte.ante).toBe(0);
  });
});

describe('the escalated level is safe to write to the database', () => {
  it('clamps at the DECIMAL(10,2) ceiling', () => {
    const far = escalatedBlindLevel(LAST, 400, LEN, 10);
    expect(far.smallBlind).toBe(MAX_BLIND_VALUE);
    expect(far.bigBlind).toBe(MAX_BLIND_VALUE);
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

  it('missing or garbage figures read as 0, never NaN', () => {
    const lvl = escalatedBlindLevel({ smallBlind: 'x', bigBlind: null }, 11, LEN, 10);
    expect(lvl.smallBlind).toBe(0);
    expect(lvl.bigBlind).toBe(0);
    expect(lvl.ante).toBe(0);
  });

  it('keeps a level at least two minutes long', () => {
    expect(escalatedBlindLevel(LAST, 11, LEN, 0.5).durationMinutes).toBe(2);
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
