/**
 * Rake scaling must not move chips between winners.
 *
 * When rake comes out of the pot, every winner's share is scaled down to the
 * post-rake total. That scaling is rounded to whole cents, and the rounding
 * leftover has to go somewhere. It used to go to `adjusted[0]` unconditionally.
 *
 * Index 0 is the MAIN-pot winner, which is by construction the shortest all-in
 * stack at the table. In a hand with side pots that player is not eligible for
 * anything above the main pot, so the leftover cent was taken out of a side-pot
 * winner's stack and handed to them. The table total still balanced, which is
 * why plain chip-conservation never flagged it — the D24 fuzzer's INV-7
 * (eligibility ceiling) is what caught it.
 */

import { describe, it, expect } from 'vitest';
import { scaleWinnerCentsForRake } from './HandController.js';

const cents = (n: number) => Math.round(n * 100);

describe('scaleWinnerCentsForRake', () => {
  it('reproduces the fuzzer case without overpaying the main-pot winner', () => {
    // The exact hand the fuzzer found (seed 4138, 0.01/0.02 pineapple, 3% rake
    // capped at 0.02). u3 is all-in for 0.32 into a 1.93 main pot with four
    // side pots above them, so 1.93 is the most they can ever be paid.
    const preRake = [1.93, 4.78, 4.5, 4.76]; // u3 first: main-pot winner
    const totalWinnings = 15.95; // 15.97 pot - 0.02 rake

    const out = scaleWinnerCentsForRake(preRake, totalWinnings);

    expect(out.reduce((a, b) => a + b, 0)).toBe(cents(totalWinnings));
    expect(out[0]).toBeLessThanOrEqual(cents(1.93));
  });

  it('never pays anyone more than their pre-rake entitlement', () => {
    // Property check over a wide grid: rake only ever takes away, so no winner
    // may come out above where they started.
    for (let rakeCents = 0; rakeCents <= 40; rakeCents++) {
      for (const preRake of [
        [1.93, 4.78, 4.5, 4.76],
        [0.05, 0.28, 0.04],
        [10, 10, 10],
        [0.01, 0.01, 0.01, 0.01, 0.01],
        [7.77, 0.03],
        [100.01, 0.99, 12.34, 5.5],
      ]) {
        const gross = preRake.reduce((a, b) => a + b, 0);
        const net = Math.round(gross * 100 - rakeCents) / 100;
        if (net < 0) continue;
        const out = scaleWinnerCentsForRake(preRake, net);

        expect(out.reduce((a, b) => a + b, 0)).toBe(cents(net));
        out.forEach((c, i) => {
          expect(c).toBeLessThanOrEqual(cents(preRake[i]));
          expect(c).toBeGreaterThanOrEqual(0);
        });
      }
    }
  });

  it('is exact when there is no rake', () => {
    const preRake = [1.93, 4.78, 4.5, 4.76];
    const out = scaleWinnerCentsForRake(preRake, 15.97);
    expect(out).toEqual(preRake.map(cents));
  });

  it('handles a single winner taking the whole post-rake pot', () => {
    const out = scaleWinnerCentsForRake([15.97], 15.95);
    expect(out).toEqual([1595]);
  });

  it('survives float drift in the pot total', () => {
    // calculatePots routinely produces values like 0.04000000000000001 and
    // 0.5599999999999987. Math.trunc on those loses a cent; Math.round does not.
    const out = scaleWinnerCentsForRake([0.04000000000000001, 0.5599999999999987], 0.6);
    expect(out.reduce((a, b) => a + b, 0)).toBe(60);
  });

  it('handles run-it-twice thirds without over-paying the main-pot winner', () => {
    // The RIT path feeds this function FRACTIONAL pre-rake amounts (each
    // board's win divided by `runs`), e.g. thirds that do not land on cents.
    // Before 2026-08-23 RIT had its own bespoke copy of this scaling whose
    // drift cent went to the first map entry — a board-0 main-pot winner —
    // uncapped. Pin the shared function on RIT-shaped inputs: a tiny main-pot
    // share (whose proportional rake deduction rounds to zero) must not rise
    // above its pre-rake entitlement when the drift lands.
    const preRake = [0.5 / 3 + 0.5 / 3 + 0.5 / 3, 61.13 / 3, 61.13 / 3, 61.14 / 3]; // ≈ [0.5, 20.376, 20.376, 20.38]
    const gross = preRake.reduce((a2, b2) => a2 + b2, 0);
    const net = Math.round(gross * 100 - 5) / 100; // 0.05 rake

    const out = scaleWinnerCentsForRake(preRake, net);
    expect(out.reduce((a2, b2) => a2 + b2, 0)).toBe(Math.round(net * 100));
    out.forEach((c, i) => expect(c).toBeLessThanOrEqual(Math.round(preRake[i] * 100)));
  });

  it('never returns a negative share when rake exceeds a small winner', () => {
    const out = scaleWinnerCentsForRake([0.01, 0.01, 5.0], 4.5);
    expect(out.every((c) => c >= 0)).toBe(true);
    expect(out.reduce((a, b) => a + b, 0)).toBe(450);
  });
});
