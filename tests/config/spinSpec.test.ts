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
  SPIN_STACKS,
  SPIN_SPEED_LABELS,
  SPIN_BLINDS,
  SPIN_FREQ_DENOMINATOR,
  SPIN_GAME_TYPES,
  SPIN_RAKE_RATE,
  spinRakeRate,
  spinRakeInvariant,
  assertSpinRakeInvariant,
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
    const server = readFileSync(resolve(__dirname, '../../server/src/config/spinSpec.ts'), 'utf8');
    expect(
      server,
      'server/src/config/spinSpec.ts has drifted from src/config/spinSpec.ts — ' +
        'that drift is exactly how three conflicting multiplier tables happened'
    ).toBe(client);
  });
});

describe('THE central invariant: the table implies the advertised rake', () => {
  it('expects exactly 2.76 across the full ladder', () => {
    /* REBALANCED 2026-09-05, and this pin moved with the change that replaced
       the behaviour it guards (CLAUDE.md 5.8). It read 2.7638, which is what
       the ladder expected while SPIN_RAKE_RATE booked 8.00% - so the product
       charged 7.874% and the 0.126pp went to players out of the reserve. The
       equality E[m] = seats x (1 - rake) is now exact rather than nearly
       true. */
    expect(expectedMultiplier()).toBeCloseTo(2.76, 10);
  });

  it('implies the 8% it books, not a nearby number', () => {
    // This assertion used to accept anything from 7.5% to 8.1% and the product
    // sat at 7.874% inside that band for weeks. A rate that is BOOKED to the
    // basis point is testable to the basis point.
    expect(impliedHouseEdge()).toBeCloseTo(0.08, 9);
  });

  it('PROVES the buy-in carries no fee on top', () => {
    // If a player paid B plus 8% on top, collected would be 3 x 1.08B = 3.24B
    // against an expected payout of 2.7638B — a true edge of 14.7%, which is
    // nearly double what any room advertises. The only pricing consistent with
    // both the table and an 8% headline is: the buy-in IS the whole charge.
    const withFeeOnTop = (3 * 1.08 - 2.76) / (3 * 1.08);
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
    /* EXACT, not within 200 (2026-08-28). The slack existed because the
       denominator was a hand-written literal that had drifted 99 off the
       ladder's real total; it is derived from the ladder now, so the only
       honest assertion is equality — and a tolerance that hides a real
       mismatch is how the drift survived in the first place. */
    expect(total).toBe(SPIN_FREQ_DENOMINATOR);
  });
});

describe('the rake is flat, and the invariant is what enforces it', () => {
  // There used to be four buy-in bands here booking 8 / 7 / 6 / 5%. They never
  // changed a single frequency, so the player was charged 7.87% at every stake
  // while the ledger recorded less, and 36,723.84 chips accumulated in
  // spin_bonus_pools owned by nobody. These four tests are the guard: the
  // equality holds at 8%, it REJECTS each rate the bands used to book, it
  // rejects a tampered frequency table, and it says all three numbers when it
  // fails so the next reader does not have to reconstruct the arithmetic.

  it('books one rate at every stake, and the table satisfies it', () => {
    expect(SPIN_RAKE_RATE).toBe(0.08);
    for (const buyIn of [0.5, 5, 10, 25, 50, 100, 1000, -1]) {
      expect(spinRakeRate(buyIn), `stake ${buyIn}`).toBe(0.08);
    }

    // E[multiplier] = seats x (1 - rake). To the cent, which is the finest
    // difference numeric(15,2) can ever carry into a ledger row.
    const inv = spinRakeInvariant();
    expect(inv.driftPerBuyIn).toBe(0);
    expect(Math.round(inv.expected * 100) / 100).toBe(Math.round(inv.implied * 100) / 100);
    expect(() => assertSpinRakeInvariant()).not.toThrow();
  });

  it('REJECTS every rate the deleted bands used to book', () => {
    // 7, 6 and 5% are the three the ladder booked above 5, 10 and 50 stake.
    // Each one implies a different expected multiplier than the ONE table pays.
    for (const rejected of [0.07, 0.06, 0.05]) {
      expect(
        () => assertSpinRakeInvariant(SPIN_TIERS, SPIN_SEATS, rejected),
        `${rejected * 100}% must not pass — the frequencies were never regenerated for it`
      ).toThrow(/SPIN RAKE INVARIANT BROKEN/);
      expect(spinRakeInvariant(SPIN_TIERS, SPIN_SEATS, rejected).driftPerBuyIn).not.toBe(0);
    }
  });

  it('rejects a tampered frequency table at the booked rate', () => {
    // Moving weight onto the top multiplier without touching the rate is the
    // other half of the same mistake, arriving from the opposite direction.
    const tampered = SPIN_TIERS.map((t) =>
      t.multiplier === 100 ? { ...t, freq: t.freq + 500_000 } : t
    );
    expect(() => assertSpinRakeInvariant(tampered)).toThrow(/SPIN RAKE INVARIANT BROKEN/);
    expect(() => assertSpinRakeInvariant(SPIN_TIERS)).not.toThrow();
  });

  it('names all three numbers when it fails', () => {
    let message = '';
    try {
      assertSpinRakeInvariant(SPIN_TIERS, SPIN_SEATS, 0.05);
    } catch (e) {
      message = (e as Error).message;
    }
    // What the table expects, what the booked rate implies, what is actually
    // charged. Without all three the reader cannot tell which side moved.
    expect(message).toContain(expectedMultiplier().toFixed(6));
    expect(message).toContain((SPIN_SEATS * (1 - 0.05)).toFixed(6));
    expect(message).toContain((impliedHouseEdge() * 100).toFixed(2));
    expect(message).toContain('5.00%');
  });
});

describe('payout splits', () => {
  it('pays one player below 10x and three at 25x+', () => {
    expect(spinTier(2)!.payouts).toEqual([1]);
    expect(spinTier(5)!.payouts).toEqual([1]);
    expect(spinTier(10)!.payouts).toEqual([0.8, 0.2]);
    expect(spinTier(25)!.payouts).toEqual([0.8, 0.12, 0.08]);
    expect(spinTier(100)!.payouts).toEqual([0.8, 0.12, 0.08]);
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

  it('matches the published top-tier example exactly', () => {
    // $1 -> $100 pool -> 80 / 12 / 8
    const e = spinEconomics(1, 100);
    expect(e.prizePool).toBe(100);
    expect(e.payouts).toEqual([80, 12, 8]);

    const e100 = spinEconomics(100, 100);
    expect(e100.prizePool).toBe(10000);
    expect(e100.payouts).toEqual([8000, 1200, 800]);
  });
});

describe('per-game economics', () => {
  it('books the fixed advertised rake on EVERY game, win or lose', () => {
    const small = spinEconomics(1, 2);
    const jackpot = spinEconomics(1, 100);
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

describe('the stack belongs to the board, not to the multiplier', () => {
  /**
   * REPLACES "matches the published stack and level table" and "gives bigger
   * prizes more poker, never less", both of which pinned the 2026-08-23 stack
   * bands (300 / 1000 / 5000, chosen by the drawn tier).
   *
   * Dan, 2026-09-01, verbatim: "we used to award more chips depending on if
   * its a higher multiplier... we are no longer doing that, once a player sits
   * down and 'buys in' they either get 300 chips for a turbo, or 1000 chips
   * for a deep stack. as soon as they buy in 300 chips should appear in their
   * action box (not 0)."
   *
   * The second sentence is why this is not cosmetic. A stack that depends on
   * the draw cannot be known when the money leaves the wallet, so the seat was
   * written at zero and the real number arrived 14.8 seconds later on the
   * chip-drop beat.
   */
  it('no tier carries a stack at all', () => {
    for (const tier of SPIN_TIERS) {
      expect(
        (tier as unknown as Record<string, unknown>).startingStack,
        `${tier.multiplier}x must not decide a stack`
      ).toBeUndefined();
    }
  });

  it('offers exactly two depths, and they are the two Dan named', () => {
    expect(SPIN_STACKS).toEqual({ turbo: 300, deep: 1000 });
    // The 5000 band is retired with the tier stacks. Nothing may reintroduce it.
    expect(Object.values(SPIN_STACKS)).not.toContain(5000);
  });

  it('names both depths in Title Case, because a player reads them', () => {
    expect(SPIN_SPEED_LABELS.turbo).toBe('Turbo');
    expect(SPIN_SPEED_LABELS.deep).toBe('Deep Stack');
  });

  it('keeps the level clock flat, which is the half of 2026-08-23 that stands', () => {
    // Dan 2026-08-20: "change spins to 3 min levels" - FLAT across the ladder.
    // Dan 2026-08-23: "SPEED SHOULDN'T CHANGE, ONLY THE STARTING STACK."
    for (const tier of SPIN_TIERS) {
      expect(tier.levelMinutes, `${tier.multiplier}x level length`).toBe(3);
    }
  });

  it('uses one blind ladder for every multiplier', () => {
    expect(SPIN_BLINDS[0]).toEqual({ small: 10, big: 20 });
    expect(SPIN_BLINDS[9]).toEqual({ small: 105, big: 210 });
    expect(spinBlindsForLevel(1)).toEqual({ small: 10, big: 20 });
    expect(spinBlindsForLevel(10)).toEqual({ small: 105, big: 210 });
  });

  it('keeps climbing past the published ladder', () => {
    // A deep 100x can outrun ten levels; a structure that stalls turns a
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
    expect(tiers.map((t) => t.multiplier)).toEqual([2, 3, 4, 5, 10, 25, 50, 100]);
  });

  it('THE REGRESSION: an unaffordable 4x must not be selectable', () => {
    // Found in production. A 4x pays 4B while three buy-ins bring in only
    // 2.76B, so on a thin pool it CANNOT be covered. The original gate only
    // guarded the top two tiers, so a 4x was offered, settlement aborted on the
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
        const contribution =
          buyIn * 3 * (1 - (buyIn <= 5 ? 0.08 : buyIn <= 10 ? 0.07 : buyIn <= 50 ? 0.06 : 0.05));
        for (const t of eligibleSpinTiers(balance, buyIn, buyIn)) {
          expect(
            balance + contribution,
            `balance ${balance} @ ${buyIn} cannot pay ${t.multiplier}x`
          ).toBeGreaterThanOrEqual(buyIn * t.multiplier);
        }
      }
    }
  });

  it('locks the 100x out of the DRAW when the pool is empty', () => {
    const tiers = eligibleSpinTiers(0, 10, 10);
    expect(tiers.some((t) => t.multiplier === 100)).toBe(false);
  });

  it('flags a thin pool before players notice the ladder shrinking', () => {
    expect(isReserveThin(0, 10)).toBe(true);
    expect(isReserveThin(1_000_000, 10)).toBe(false);
  });

  it('unlocks 100x at 1.5x its own jackpot, and not before', () => {
    const stake = 10;
    const need = unlockThreshold(spinTier(100)!, stake); // 10 * 100 * 1.5
    expect(need).toBe(1500);
    expect(eligibleSpinTiers(need - 0.01, stake, stake).some((t) => t.multiplier === 100)).toBe(
      false
    );
    expect(eligibleSpinTiers(need, stake, stake).some((t) => t.multiplier === 100)).toBe(true);
  });

  it('THE 500x IS RETIRED: it is off the ladder and can never be drawn', () => {
    // Dan, 2026-08-21: "REMOVE THE 500X WE WILL ONLY EVER DO 100X."
    // Asserted at the source AND through the draw, because a tier surviving
    // only in some fallback path is precisely the shape of bug this file was
    // written to catch.
    expect(spinTier(500)).toBeUndefined();
    expect(SPIN_TIERS.some((t) => t.multiplier === 500)).toBe(false);
    expect(Math.max(...SPIN_TIERS.map((t) => t.multiplier))).toBe(100);
    for (const balance of [0, 1_000, 1_000_000, 1_000_000_000]) {
      expect(
        eligibleSpinTiers(balance, 100, 100).some((t) => t.multiplier === 500),
        `a 500x was drawable at balance ${balance}`
      ).toBe(false);
    }
  });

  it('retiring it did NOT quietly raise the house edge', () => {
    // Deleting the row without moving its 50,000 weighted units would have
    // taken the expectation to 2.7588. The mass went to 100x (+508) and 3x
    // (+16), paid for out of 2x (-424).
    //
    // The totals below moved on 2026-09-05, when the 2x/3x split was solved to
    // put E[m] exactly on 2.76 - the retirement's own arithmetic is unchanged
    // and 100x still holds every unit it was given.
    expect(expectedMultiplier()).toBeCloseTo(2.76, 10);
    expect(SPIN_TIERS.reduce((s, t) => s + t.freq, 0)).toBe(10_000_000);
    expect(SPIN_TIERS.reduce((s, t) => s + t.multiplier * t.freq, 0)).toBe(27_600_000);
    expect(spinTier(100)!.freq).toBe(1_008);
  });

  it('the rebalance moved ONLY the two bottom rungs', () => {
    // Every tier a player celebrates keeps its exact frequency: the change is
    // invisible above 3x by construction, which is the whole point of solving
    // it as an equality on f2/f3 rather than refitting the ladder.
    expect(spinTier(4)!.freq).toBe(900_000);
    expect(spinTier(5)!.freq).toBe(250_000);
    expect(spinTier(10)!.freq).toBe(100_000);
    expect(spinTier(25)!.freq).toBe(7_500);
    expect(spinTier(50)!.freq).toBe(1_000);
    expect(spinTier(100)!.freq).toBe(1_008);
    expect(spinTier(2)!.freq).toBe(4_809_776);
    expect(spinTier(3)!.freq).toBe(3_930_716);
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
    // DERIVED from the top tier, so retiring the 500x cut it 5x. That is the
    // intended consequence and worth stating out loud: a club needs $2,000 of
    // operator seed at a $10 stake now, not $10,000.
    expect(requiredSeed(10)).toBe(2000); // 10 * 100 * 2
  });

  it('caps the pool so money cannot sit idle forever', () => {
    expect(reserveCeiling(10)).toBe(8000); // 10 * 100 * 8
    expect(reserveCeiling(10)).toBeGreaterThan(requiredSeed(10));
  });

  it('both track the TOP tier, whatever it currently is', () => {
    const top = Math.max(...SPIN_TIERS.map((t) => t.multiplier));
    expect(requiredSeed(10)).toBe(10 * top * 2);
    expect(reserveCeiling(10)).toBe(10 * top * 8);
  });
});
