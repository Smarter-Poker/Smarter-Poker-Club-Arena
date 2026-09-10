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
    expect(r3 / r1).toBeCloseTo(Math.pow(1.4, 2), 3);
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

  it('refuses missing, fractional or malformed sources instead of synthesizing a fake level', () => {
    expect(() => escalatedBlindLevel({ smallBlind: 'x', bigBlind: null }, 11, LEN, 10)).toThrow(
      /whole small blind/
    );
    expect(() =>
      escalatedBlindLevel({ smallBlind: 25.5, bigBlind: 50, ante: 0 }, 11, LEN, 10)
    ).toThrow(/whole small blind/);
    expect(() =>
      escalatedBlindLevel({ smallBlind: 25, bigBlind: 0, ante: 0 }, 11, LEN, 10)
    ).toThrow(/positive whole big blind/);
  });

  it('allocates every synthesized chip value to a deterministic whole chip', () => {
    for (const ratio of [1.15, 1.2, 1.35, 1.4, 1.6]) {
      for (const index of [10, 11, 12, 15, 23, 40]) {
        const first = escalatedBlindLevel(LAST, index, LEN, 10, ratio);
        const restarted = escalatedBlindLevel(LAST, index, LEN, 10, ratio);
        expect(restarted).toEqual(first);
        expect(Number.isSafeInteger(first.smallBlind)).toBe(true);
        expect(Number.isSafeInteger(first.bigBlind)).toBe(true);
        expect(Number.isSafeInteger(first.ante)).toBe(true);
        expect(first.smallBlind).toBeGreaterThan(0);
        expect(first.bigBlind).toBeGreaterThan(0);
        expect(first.ante).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('uses an explicit nearest-chip rule on a binary half-boundary', () => {
    const level = escalatedBlindLevel({ smallBlind: 1, bigBlind: 10, ante: 1 }, 10, LEN, 10, 1.5);
    expect(level).toMatchObject({ smallBlind: 2, bigBlind: 15, ante: 2 });
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
