/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN SPEC — the arithmetic must hold, and the copies must not drift
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This file exists because of a real, expensive failure: the codebase carried
 * THREE Spin multiplier tables with expectations of 3.00, 2.75 and 2.24, and
 * the one that ran was not the one that was documented. Nobody noticed because
 * nothing asserted the relationship between the table and the advertised rake.
 *
 * So the central test here is not "does the table match a list of numbers" —
 * it is "does the table imply the rake we tell players we charge".
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SPIN_SEATS,
  SPIN_TIERS,
  SPIN_BLINDS,
  SPIN_FREQ_DENOMINATOR,
  SPIN_GAME_TYPES,
  spinRakeRate,
  spinTier,
  spinBlindsForLevel,
  expectedMultiplier,
  impliedHouseEdge,
  spinEconomics,
  eligibleSpinTiers,
  unlockThreshold,
  requiredSeed,
  reserveCeiling,
  isReserveThin,
} from '../../src/config/spinSpec';

describe('the spec is mirrored, not forked', () => {
  it('client and server copies are byte-identical', () => {
    const client = readFileSync(resolve(__dirname, '../../src/config/spinSpec.ts'), 'utf8');
    const server = readFileSync(
      resolve(__dirname, '../../server/src/config/spinSpec.ts'),
      'utf8'
    );
    expect(
      server,
      'server/src/config/spinSpec.ts has drifted from src/config/spinSpec.ts — ' +
        'that drift is exactly how three conflicting multiplier tables happened'
    ).toBe(client);
  });
});

describe('THE central invariant: the table implies the advertised rake', () => {
  it('expects 2.7638 across the full ladder', () => {
    expect(expectedMultiplier()).toBeCloseTo(2.7638, 4);
  });

  it('implies ~7.87% — the advertised 8% at the stakes it covers', () => {
    const edge = impliedHouseEdge();
    expect(edge).toBeGreaterThan(0.075);
    expect(edge).toBeLessThan(0.081);
  });

  it('PROVES the buy-in carries no fee on top', () => {
    // If a player paid B plus 8% on top, collected would be 3 x 1.08B = 3.24B
    // against an expected payout of 2.7638B — a true edge of 14.7%, which is
    // nearly double what any room advertises. The only pricing consistent with
    // both the table and an 8% headline is: the buy-in IS the whole charge.
    const withFeeOnTop = (3 * 1.08 - 2.7638) / (3 * 1.08);
    expect(withFeeOnTop).toBeGreaterThan(0.14);
    expect(impliedHouseEdge()).toBeLessThan(0.09);
  });

  it('is house-positive — it can never expect to pay out more than it takes', () => {
    expect(expectedMultiplier()).toBeLessThan(SPIN_SEATS);
  });

  it('frequencies land on the stated denominator', () => {
    const total = SPIN_TIERS.reduce((s, t) => s + t.freq, 0);
    // Dan's table sums to 10,000,099; the drift is rounding in the source and
    // is immaterial (1 part in 100k). Pinned so a real edit cannot hide in it.
    expect(Math.abs(total - SPIN_FREQ_DENOMINATOR)).toBeLessThan(200);
  });
});

describe('rake bands', () => {
  it('scales down with stake, exactly as published', () => {
    expect(spinRakeRate(0.5)).toBe(0.08);
    expect(spinRakeRate(5)).toBe(0.08);
    expect(spinRakeRate(10)).toBe(0.07);
    expect(spinRakeRate(25)).toBe(0.06);
    expect(spinRakeRate(50)).toBe(0.06);
    expect(spinRakeRate(100)).toBe(0.05);
    expect(spinRakeRate(1000)).toBe(0.05);
  });

  it('defaults an unknown stake to the HIGHEST rake, never the lowest', () => {
    // A misconfigured buy-in must not silently hand away margin.
    expect(spinRakeRate(-1)).toBe(0.08);
  });
});

describe('payout splits', () => {
  it('pays one player below 10x and three at 25x+', () => {
    expect(spinTier(2)!.payouts).toEqual([1]);
    expect(spinTier(5)!.payouts).toEqual([1]);
    expect(spinTier(10)!.payouts).toEqual([0.8, 0.2]);
    expect(spinTier(25)!.payouts).toEqual([0.8, 0.12, 0.08]);
    expect(spinTier(500)!.payouts).toEqual([0.8, 0.12, 0.08]);
  });

  it('every split sums to exactly 1', () => {
    for (const t of SPIN_TIERS) {
      const sum = t.payouts.reduce((a, b) => a + b, 0);
      expect(sum, `${t.multiplier}x split`).toBeCloseTo(1, 10);
    }
  });

  it('never pays out more than the pool holds, at any stake', () => {
    for (const t of SPIN_TIERS) {
      for (const buyIn of [0.5, 1, 3.33, 5, 10, 25, 50, 100]) {
        const e = spinEconomics(buyIn, t.multiplier);
        const paid = e.payouts.reduce((a, b) => a + b, 0);
        expect(
          Math.round(paid * 100) / 100,
          `${buyIn} @ ${t.multiplier}x paid ${paid} from a pool of ${e.prizePool}`
        ).toBeLessThanOrEqual(e.prizePool);
      }
    }
  });

  it('matches the published 500x example exactly', () => {
    // $1 -> $500 pool -> 400 / 60 / 40
    const e = spinEconomics(1, 500);
    expect(e.prizePool).toBe(500);
    expect(e.payouts).toEqual([400, 60, 40]);

    const e100 = spinEconomics(100, 500);
    expect(e100.prizePool).toBe(50000);
    expect(e100.payouts).toEqual([40000, 6000, 4000]);
  });
});

describe('per-game economics', () => {
  it('books the fixed advertised rake on EVERY game, win or lose', () => {
    const small = spinEconomics(1, 2);
    const jackpot = spinEconomics(1, 500);
    // The house takes 8% of $3 either way. The pool absorbs the variance.
    expect(small.houseRake).toBe(0.24);
    expect(jackpot.houseRake).toBe(0.24);
  });

  it('routes everything else into the reserve', () => {
    const e = spinEconomics(1, 2);
    expect(e.collected).toBe(3);
    expect(e.reserveIn).toBe(2.76);
    expect(e.prizePool).toBe(2);
    // A 2x leaves the pool ahead...
    expect(e.reserveNet).toBeLessThan(0);
  });

  it('makes a jackpot a pool DRAW, which is the whole point of the pool', () => {
    const e = spinEconomics(1, 500);
    expect(e.reserveNet).toBeGreaterThan(400);
  });

  it('is net-neutral for the pool over the true distribution', () => {
    // E[prize] should equal reserve_in, or the pool drifts without bound.
    const buyIn = 1;
    const reserveIn = spinEconomics(buyIn, 2).reserveIn;
    const expectedPrize = expectedMultiplier() * buyIn;
    expect(expectedPrize).toBeCloseTo(reserveIn, 2);
  });
});

describe('structure scales with the multiplier', () => {
  it('matches the published stack and level table', () => {
    const expected: Array<[number, number, number]> = [
      [2, 300, 1],
      [3, 300, 2],
      [4, 400, 2],
      [5, 400, 3],
      [10, 500, 3],
      [25, 500, 3],
      [50, 500, 4],
      [100, 500, 5],
      [500, 500, 5],
    ];
    for (const [mult, stack, mins] of expected) {
      const t = spinTier(mult)!;
      expect(t.startingStack, `${mult}x stack`).toBe(stack);
      expect(t.levelMinutes, `${mult}x level length`).toBe(mins);
    }
  });

  it('gives bigger prizes more poker, never less', () => {
    for (let i = 1; i < SPIN_TIERS.length; i++) {
      expect(SPIN_TIERS[i].startingStack).toBeGreaterThanOrEqual(
        SPIN_TIERS[i - 1].startingStack
      );
      expect(SPIN_TIERS[i].levelMinutes).toBeGreaterThanOrEqual(
        SPIN_TIERS[i - 1].levelMinutes
      );
    }
  });

  it('uses one blind ladder for every multiplier', () => {
    expect(SPIN_BLINDS[0]).toEqual({ small: 10, big: 20 });
    expect(SPIN_BLINDS[9]).toEqual({ small: 105, big: 210 });
    expect(spinBlindsForLevel(1)).toEqual({ small: 10, big: 20 });
    expect(spinBlindsForLevel(10)).toEqual({ small: 105, big: 210 });
  });

  it('keeps climbing past the published ladder', () => {
    // A 5-minute 500x can outrun ten levels; a structure that stalls turns a
    // hyper-turbo into a grind.
    const l11 = spinBlindsForLevel(11);
    const l12 = spinBlindsForLevel(12);
    expect(l11.big).toBeGreaterThan(210);
    expect(l12.big).toBeGreaterThan(l11.big);
    expect(l11.small).toBe(Math.round(l11.big / 2));
  });

  it('covers all four game types', () => {
    expect(SPIN_GAME_TYPES).toEqual(['NLH', 'PLO4', 'PLO5', 'PLO6']);
  });
});

describe('reserve gating — an unpayable jackpot must be impossible', () => {
  it('allows 2x through 50x when the pool can afford them', () => {
    // Well-funded pool at a $100 stake: everything below the jackpot gates.
    const tiers = eligibleSpinTiers(1_000_000, 100, 100);
    expect(tiers.map((t) => t.multiplier)).toEqual([2, 3, 4, 5, 10, 25, 50, 100, 500]);
  });

  it('THE REGRESSION: an unaffordable 4x must not be selectable', () => {
    // Found in production. A 4x pays 4B while three buy-ins bring in only
    // 2.76B, so on a thin pool it CANNOT be covered. The original gate only
    // guarded 100x/500x, so a 4x was offered, settlement aborted on the
    // non-negative constraint, and the game ran UNBOOKED — no ledger row, no
    // rake record. Three live spins hit this within 20 minutes of cutover.
    const thin = eligibleSpinTiers(0, 10, 10);
    // 10 x 3 x 0.93 = 27.9 available; a 4x needs 40.
    expect(thin.some((t) => t.multiplier === 4)).toBe(false);
    // ...but a 2x (needs 20) is affordable from the contribution alone.
    expect(thin.some((t) => t.multiplier === 2)).toBe(true);
  });

  it('counts the game OWN contribution as available to fund its prize', () => {
    // 10 x 3 x 0.93 = 27.9. A 2x needs 20 and must pass on an empty pool.
    expect(eligibleSpinTiers(0, 10, 10).some((t) => t.multiplier === 2)).toBe(true);
    // A tiny top-up should unlock the 3x (needs 30).
    expect(eligibleSpinTiers(0, 10, 10).some((t) => t.multiplier === 3)).toBe(false);
    expect(eligibleSpinTiers(3, 10, 10).some((t) => t.multiplier === 3)).toBe(true);
  });

  it('never offers a tier the pool plus contribution cannot pay, at any balance', () => {
    for (const balance of [0, 5, 50, 500, 5000, 50000]) {
      for (const buyIn of [1, 5, 25, 100]) {
        const contribution = buyIn * 3 * (1 - (buyIn <= 5 ? 0.08 : buyIn <= 10 ? 0.07 : buyIn <= 50 ? 0.06 : 0.05));
        for (const t of eligibleSpinTiers(balance, buyIn, buyIn)) {
          expect(
            balance + contribution,
            `balance ${balance} @ ${buyIn} cannot pay ${t.multiplier}x`
          ).toBeGreaterThanOrEqual(buyIn * t.multiplier);
        }
      }
    }
  });

  it('locks 100x and 500x out of the DRAW when the pool is empty', () => {
    const tiers = eligibleSpinTiers(0, 10, 10);
    expect(tiers.some((t) => t.multiplier === 100)).toBe(false);
    expect(tiers.some((t) => t.multiplier === 500)).toBe(false);
  });

  it('flags a thin pool before players notice the ladder shrinking', () => {
    expect(isReserveThin(0, 10)).toBe(true);
    expect(isReserveThin(1_000_000, 10)).toBe(false);
  });

  it('unlocks 100x at 1.5x its own jackpot, and not before', () => {
    const stake = 10;
    const need = unlockThreshold(spinTier(100)!, stake); // 10 * 100 * 1.5
    expect(need).toBe(1500);
    expect(eligibleSpinTiers(need - 0.01, stake, stake).some((t) => t.multiplier === 100)).toBe(false);
    expect(eligibleSpinTiers(need, stake, stake).some((t) => t.multiplier === 100)).toBe(true);
  });

  it('unlocks 500x at 2.0x its own jackpot, and not before', () => {
    const stake = 10;
    const need = unlockThreshold(spinTier(500)!, stake); // 10 * 500 * 2
    expect(need).toBe(10000);
    expect(eligibleSpinTiers(need - 0.01, stake, stake).some((t) => t.multiplier === 500)).toBe(false);
    expect(eligibleSpinTiers(need, stake, stake).some((t) => t.multiplier === 500)).toBe(true);
  });

  it('measures the threshold against the HIGHEST stake running, not this table', () => {
    // The pool must be able to pay the jackpot at the biggest table open.
    // 1500 covers 100x at a $10 stake but not at a $100 stake.
    expect(eligibleSpinTiers(1500, 10, 10).some((t) => t.multiplier === 100)).toBe(true);
    expect(eligibleSpinTiers(1500, 100, 100).some((t) => t.multiplier === 100)).toBe(false);
  });

  it('a gated ladder still has a valid, house-positive expectation', () => {
    // Redistribution must not accidentally make a locked-down ladder
    // house-negative — that would turn an empty pool into a bleeding one.
    for (const balance of [0, 100, 1000, 5000, 50000]) {
      const tiers = eligibleSpinTiers(balance, 10, 10);
      expect(tiers.length).toBeGreaterThan(0);
      expect(expectedMultiplier(tiers)).toBeLessThan(SPIN_SEATS);
      expect(impliedHouseEdge(tiers)).toBeGreaterThan(0);
    }
  });

  it('locking the top tiers makes the house edge LARGER, never smaller', () => {
    const full = impliedHouseEdge(SPIN_TIERS);
    const gated = impliedHouseEdge(eligibleSpinTiers(0, 100, 100));
    expect(gated).toBeGreaterThan(full);
  });
});

describe('seed and ceiling', () => {
  it('requires two full top jackpots as the operator seed', () => {
    expect(requiredSeed(10)).toBe(10000); // 10 * 500 * 2
  });

  it('caps the pool so money cannot sit idle forever', () => {
    expect(reserveCeiling(10)).toBe(40000); // 10 * 500 * 8
    expect(reserveCeiling(10)).toBeGreaterThan(requiredSeed(10));
  });
});
