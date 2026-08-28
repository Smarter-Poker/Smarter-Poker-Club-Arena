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
  it('doubles once per level past the end', () => {
    expect(escalationFactor(10, LEN)).toBe(2);
    expect(escalationFactor(11, LEN)).toBe(4);
    expect(escalationFactor(12, LEN)).toBe(8);
    expect(escalationFactor(13, LEN)).toBe(16);
  });

  it('is stateless: the answer for a level never depends on how it was reached', () => {
    // THE RESTART CASE. Steady state walked 10, 11, 12, 13, 14 and arrived at
    // 2^5. A process that resumes cold at level 14 must compute 2^5 too — with
    // the old push-based code its FIRST answer was right and every one after it
    // was 32x too big, because the push had moved the anchor.
    const steadyState = [10, 11, 12, 13, 14].map((n) => escalationFactor(n, LEN)).pop();
    const coldResume = escalationFactor(14, LEN);
    expect(coldResume).toBe(steadyState);
    expect(coldResume).toBe(32);
  });

  it('asking for the same level twice gives the same blinds', () => {
    const a = escalatedBlindLevel(LAST, 14, LEN, 10);
    const b = escalatedBlindLevel(LAST, 14, LEN, 10);
    const c = escalatedBlindLevel(LAST, 14, LEN, 10);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // And it is 32x the last persisted level, not 32x the previous answer.
    expect(a.bigBlind).toBe(750 * 32);
  });

  it('reproduces the shape the live incident had, and does NOT explode', () => {
    // 24,000 -> 48,000 -> 1,536,000 was the observed run. The middle step is a
    // legitimate double; the third is the anchor having moved underneath it.
    const l1 = escalatedBlindLevel(LAST, 14, LEN, 10).bigBlind; // 24,000
    const l2 = escalatedBlindLevel(LAST, 15, LEN, 10).bigBlind;
    const l3 = escalatedBlindLevel(LAST, 16, LEN, 10).bigBlind;
    expect(l1).toBe(24_000);
    expect(l2).toBe(l1 * 2);
    expect(l3).toBe(l2 * 2);
    expect(l3).not.toBe(1_536_000);
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
  it('steps back over trailing break rows so the blinds do not double zero', () => {
    const withBreaks = [
      { smallBlind: 25, bigBlind: 50 },
      { smallBlind: 50, bigBlind: 100 },
      { isBreak: true, smallBlind: 0, bigBlind: 0 },
    ];
    expect(lastPlayableIndex(withBreaks)).toBe(1);
    const lvl = escalatedBlindLevel(withBreaks[lastPlayableIndex(withBreaks)], 3, 3, 10);
    expect(lvl.bigBlind).toBe(200);
  });

  it('an all-break structure falls back to index 0 rather than looping', () => {
    expect(lastPlayableIndex([{ isBreak: true }, { isBreak: true }])).toBe(0);
  });
});
