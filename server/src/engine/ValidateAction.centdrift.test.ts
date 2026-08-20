/**
 * validateAction — cent tolerance.
 *
 * The min-raise button was rejected on ~45% of raise levels. `raiseAmount =
 * amount - currentBet` is IEEE 754 subtraction of two exact-cent values, and
 * the result lands a hair BELOW the true increment often enough that
 * `raiseAmount < minRaise` fired on a legal, exactly-minimum raise:
 *
 *   currentBet 0.10, minRaise 0.05, player raises to 0.15
 *   0.15 - 0.10 === 0.04999999999999999  ->  "Minimum raise is 0.05"
 *
 * Found by the chip-conservation property test, which generated a raise from
 * this module's own published bounds and had the engine refuse it.
 *
 * The tolerance cannot mask a real violation: chip amounts are whole cents
 * (Bible V8 §2.6), so the smallest genuine shortfall is 1 cent — 200x the
 * half-cent slack. Every test below that ends in `.valid === false` is there to
 * prove that.
 */

import { describe, it, expect } from 'vitest';
import { calculateBettingState, validateAction } from './PokerEngine.js';

describe('validateAction accepts an exactly-minimum raise', () => {
  it('accepts the specific case that was failing', () => {
    const bs = calculateBettingState(0.3, 0.1, 0, 0.02, 0.05, false);
    expect(bs.minRaise).toBe(0.05);
    expect(validateAction('raise', 0.15, 2, bs).valid).toBe(true);
  });

  it('accepts it at EVERY cent level, not just the lucky ones', () => {
    const rejected: string[] = [];
    for (let betCents = 1; betCents <= 400; betCents++) {
      for (const stepCents of [3, 5, 7, 11]) {
        const currentBet = betCents / 100;
        const minRaise = stepCents / 100;
        const raiseTo = Math.round((currentBet + minRaise) * 100) / 100;
        const bs = calculateBettingState(10, currentBet, 0, 0.02, minRaise, false);
        if (!validateAction('raise', raiseTo, 1000, bs).valid) {
          rejected.push(`currentBet=${currentBet} minRaise=${minRaise} raiseTo=${raiseTo}`);
        }
      }
    }
    // Was 538 of 1200 before the fix.
    expect(rejected.slice(0, 5)).toEqual([]);
  });

  it('accepts an exactly-minimum opening BET at every cent level', () => {
    const rejected: string[] = [];
    for (let bbCents = 1; bbCents <= 200; bbCents++) {
      const bb = bbCents / 100;
      const bs = calculateBettingState(bb * 3, 0, 0, bb, 0, false);
      if (!validateAction('bet', bs.minRaise, 1000, bs).valid) rejected.push(`bb=${bb}`);
    }
    expect(rejected.slice(0, 5)).toEqual([]);
  });

  it('accepts a raise that is exactly the whole remaining stack', () => {
    // maxRaiseTo = playerBet + playerStack; drift here read as "Insufficient chips".
    const rejected: string[] = [];
    for (let stackCents = 10; stackCents <= 400; stackCents++) {
      const stack = stackCents / 100;
      const currentBet = 0.07;
      const bs = calculateBettingState(1, currentBet, 0.03, 0.02, 0.02, false);
      const playerBet = currentBet - bs.toCall;
      const maxRaiseTo = Math.round((playerBet + stack) * 100) / 100;
      if (!validateAction('raise', maxRaiseTo, stack, bs).valid) rejected.push(`stack=${stack}`);
    }
    expect(rejected.slice(0, 5)).toEqual([]);
  });

  it('accepts an exactly-pot-sized pot-limit raise', () => {
    const rejected: string[] = [];
    for (let potCents = 10; potCents <= 400; potCents++) {
      const pot = potCents / 100;
      const bs = calculateBettingState(pot, 0.07, 0, 0.02, 0.05, true);
      const raiseTo = Math.round((0.07 + bs.maxRaise!) * 100) / 100;
      if (!validateAction('raise', raiseTo, 1000, bs).valid) rejected.push(`pot=${pot}`);
    }
    expect(rejected.slice(0, 5)).toEqual([]);
  });
});

describe('the tolerance does not admit an actually-illegal action', () => {
  const bs = () => calculateBettingState(10, 0.1, 0, 0.02, 0.05, false);

  it('still rejects a raise one cent short of the minimum', () => {
    // minimum is raise-to 0.15; 0.14 is a full cent short.
    expect(validateAction('raise', 0.14, 1000, bs()).valid).toBe(false);
  });

  it('still rejects a raise beyond the stack', () => {
    expect(validateAction('raise', 5, 1, bs()).valid).toBe(false);
  });

  it('still rejects a bet one cent below the minimum', () => {
    const s = calculateBettingState(0.06, 0, 0, 0.02, 0, false);
    expect(s.minRaise).toBe(0.02);
    expect(validateAction('bet', 0.01, 1000, s).valid).toBe(false);
  });

  it('still rejects a bet beyond the stack', () => {
    const s = calculateBettingState(0.06, 0, 0, 0.02, 0, false);
    expect(validateAction('bet', 2, 1, s).valid).toBe(false);
  });

  it('still rejects a pot-limit raise one cent over the pot', () => {
    const s = calculateBettingState(1, 0.1, 0, 0.02, 0.05, true);
    const overPot = Math.round((0.1 + s.maxRaise! + 0.01) * 100) / 100;
    expect(validateAction('raise', overPot, 1000, s).valid).toBe(false);
  });

  it('still rejects a check facing a bet, and a call facing nothing', () => {
    expect(validateAction('check', undefined, 100, bs()).valid).toBe(false);
    const noBet = calculateBettingState(0.06, 0, 0, 0.02, 0, false);
    expect(validateAction('call', undefined, 100, noBet).valid).toBe(false);
  });
});
