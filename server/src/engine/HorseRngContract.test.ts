/**
 * V13 — the fastRandom() contract, and why it is a contract.
 *
 * xorshift32's period covers every non-zero 32-bit state, so the state reaches
 * 0xffffffff exactly once per period. Dividing by 0xffffffff made that draw
 * return EXACTLY 1.0, and every consumer in the Monte Carlo is
 * `Math.floor(fastRandom() * (n - i))`, which then indexes one past the deck.
 * The undefined card reached the evaluator, threw, and HorseLogic.decide's
 * safety net converted it into a FOLD — a silent, unexplained fold of an
 * arbitrary hand, fleet-wide, with no telemetry.
 */

import { describe, it, expect } from 'vitest';
import { fastRandom, seedFastRandom, saveFastRandom, restoreFastRandom } from './HorseEval.js';

describe('fastRandom - [0, 1) contract', () => {
  it('never returns 1.0, including from the state that used to produce it', () => {
    // Seed so the very next draw comes from the all-ones state.
    seedFastRandom(0xffffffff);
    for (let i = 0; i < 1000; i++) {
      const r = fastRandom();
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
  });

  it('never indexes past the end of a deck-sized array', () => {
    seedFastRandom(0xffffffff);
    const n = 52;
    for (let i = 0; i < 20000; i++) {
      const idx = Math.floor(fastRandom() * n);
      expect(idx).toBeLessThanOrEqual(n - 1);
      expect(idx).toBeGreaterThanOrEqual(0);
    }
  });

  it('save/restore returns the stream to the exact same position', () => {
    seedFastRandom(0x1234abcd);
    for (let i = 0; i < 25; i++) fastRandom();
    const saved = saveFastRandom();
    const expected = [fastRandom(), fastRandom(), fastRandom()];
    for (let i = 0; i < 500; i++) fastRandom(); // wander off
    restoreFastRandom(saved);
    expect([fastRandom(), fastRandom(), fastRandom()]).toEqual(expected);
  });
});
