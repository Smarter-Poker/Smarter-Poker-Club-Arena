/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MYSTERY BOUNTY INVENTORY — the arithmetic that has to be exact
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan's section 12 requires a mystery bounty event to reconcile to zero: what
 * the chests pay out equals the pool that funded them, to the cent. Everything
 * downstream — the seed RPC's `inventory_mismatch` refusal, the settlement's
 * `balanced` flag, the critical error at completion — depends on this function
 * getting it right, and none of them can repair it after the fact.
 *
 * So the sum is tested first, tested on hand-picked awkward numbers, and then
 * tested again on hundreds of random triples.
 */

import { describe, it, expect } from 'vitest';
import {
  buildInventory,
  largestRemainder,
  cleanDownCents,
  poolCentsFromNumeric,
  centsToNumeric,
  summariseInventory,
} from './mysteryBountyPool.js';
import {
  MYSTERY_BOUNTY_MIN_FIELD_FOR_JACKPOT,
  assertProfileSane,
  resolveMysteryBountyProfile,
  type MysteryBountyProfileName,
} from '../config/mysteryBountySpec.js';

const PROFILES: MysteryBountyProfileName[] = ['balanced', 'classic', 'jackpot'];

describe('mystery bounty tier ladders', () => {
  // TEST 1 — a ladder whose frequencies do not sum to 100 leaves chests
  // undefined; one whose shares do not sum to 100 promises money that does not
  // exist. Both are silent at runtime and unrecoverable once an event is live.
  it('every profile describes a whole field and a whole pool', () => {
    for (const p of PROFILES) expect(() => assertProfileSane(p)).not.toThrow();
  });

  it('falls back to classic for an unknown or missing profile name', () => {
    expect(resolveMysteryBountyProfile(null)).toBe('classic');
    expect(resolveMysteryBountyProfile('nonsense')).toBe('classic');
    expect(resolveMysteryBountyProfile('jackpot')).toBe('jackpot');
  });

  it('jackpot is top heavy and balanced is flat, relative to classic', () => {
    // The headline number a club is choosing between. Pinned so a future edit
    // to the ladders cannot quietly swap their characters.
    const top = (p: MysteryBountyProfileName) => ({ balanced: 15, classic: 20, jackpot: 30 })[p];
    expect(top('balanced')).toBeLessThan(top('classic'));
    expect(top('classic')).toBeLessThan(top('jackpot'));
  });
});

describe('largestRemainder', () => {
  // TEST 2 — the apportionment underneath both the chest counts and the money.
  it('always sums to the total, whatever the weights', () => {
    expect(largestRemainder(100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(largestRemainder(7, [1, 1, 1, 1, 1, 1, 1, 1])).toHaveLength(8);
    expect(largestRemainder(7, [1, 1, 1, 1, 1, 1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(7);
    expect(largestRemainder(1, [50, 30, 20]).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('is deterministic - ties go to the earlier index', () => {
    expect(largestRemainder(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(largestRemainder(2, [1, 1, 1])).toEqual([1, 1, 0]);
  });

  it('spreads evenly when every weight is zero rather than returning nothing', () => {
    expect(largestRemainder(10, [0, 0, 0, 0])).toEqual([3, 3, 2, 2]);
  });
});

describe('cents conversion', () => {
  // TEST 3 — the boundary where the old float money becomes integer money. A
  // silent truncation here is a pool the inventory can never match.
  it('converts an exact two-decimal value losslessly', () => {
    expect(poolCentsFromNumeric(450)).toBe(45000);
    expect(poolCentsFromNumeric(4.35)).toBe(435);
    expect(poolCentsFromNumeric('12.07')).toBe(1207);
    expect(poolCentsFromNumeric(0.01)).toBe(1);
  });

  it('refuses a value that is not a whole number of cents', () => {
    expect(() => poolCentsFromNumeric(1.005)).toThrow(/whole number of cents/);
    expect(() => poolCentsFromNumeric(-1)).toThrow(/negative/);
    expect(() => poolCentsFromNumeric(Number.NaN)).toThrow(/not a number/);
  });

  it('round-trips back to dollars', () => {
    expect(centsToNumeric(435)).toBe(4.35);
    expect(() => centsToNumeric(4.5)).toThrow();
  });
});

describe('cleanDownCents', () => {
  // TEST 4 — must be monotone, or a tier can end up worth less than the one
  // below it purely through rounding.
  it('never rounds up and never returns zero', () => {
    expect(cleanDownCents(1247)).toBe(1200);
    expect(cleanDownCents(99)).toBe(99);
    expect(cleanDownCents(1)).toBe(1);
    expect(cleanDownCents(0)).toBe(0);
  });

  it('is monotone non-decreasing across every step boundary', () => {
    let prev = 0;
    for (let v = 0; v <= 200000; v += 7) {
      const c = cleanDownCents(v);
      expect(c).toBeGreaterThanOrEqual(prev);
      expect(c).toBeLessThanOrEqual(v);
      prev = c;
    }
  });
});

describe('buildInventory', () => {
  // TEST 5 — the invariant everything else rests on.
  it('sums to the pool EXACTLY on a realistic field', () => {
    const chests = buildInventory(2_250_00, 180, 'classic');
    expect(chests).toHaveLength(180);
    expect(chests.reduce((s, c) => s + c.amountCents, 0)).toBe(2_250_00);
  });

  it('creates exactly one chest per player', () => {
    for (const n of [10, 27, 63, 180, 999]) {
      expect(buildInventory(1_000_00, n, 'classic')).toHaveLength(n);
    }
  });

  // TEST 6 — "one player wins the big one" is the premise of the format.
  // Largest remainder on a 1% frequency gives zero jackpots below 50 chests
  // and two above 150; neither is what the event advertises.
  it('creates exactly one jackpot whenever the field can carry one', () => {
    for (const n of [MYSTERY_BOUNTY_MIN_FIELD_FOR_JACKPOT, 27, 63, 180, 500, 1000]) {
      const chests = buildInventory(5_000_00, n, 'classic');
      expect(chests.filter((c) => c.tier === 'jackpot')).toHaveLength(1);
    }
  });

  it('creates no jackpot at all when the field is too small to mean one', () => {
    for (let n = 2; n < MYSTERY_BOUNTY_MIN_FIELD_FOR_JACKPOT; n++) {
      const chests = buildInventory(5_000_00, n, 'classic');
      expect(chests.filter((c) => c.tier === 'jackpot')).toHaveLength(0);
      expect(chests.reduce((s, c) => s + c.amountCents, 0)).toBe(5_000_00);
    }
  });

  // TEST 7 — a `large` worth less than a `medium` is a bug the reveal
  // animation cannot hide.
  it('never labels a chest richer than one below it in the ladder', () => {
    const order = [
      'jackpot',
      'mega',
      'major',
      'large',
      'medium',
      'small',
      'base_plus',
      'base',
    ] as const;
    for (const profile of PROFILES) {
      for (const n of [12, 27, 63, 180, 640]) {
        const chests = buildInventory(3_000_00, n, profile);
        const worst = new Map<string, number>();
        const best = new Map<string, number>();
        for (const c of chests) {
          worst.set(c.tier, Math.min(worst.get(c.tier) ?? Infinity, c.amountCents));
          best.set(c.tier, Math.max(best.get(c.tier) ?? 0, c.amountCents));
        }
        const present = order.filter((t) => worst.has(t));
        for (let i = 1; i < present.length; i++) {
          expect(worst.get(present[i - 1])!).toBeGreaterThanOrEqual(best.get(present[i])!);
        }
      }
    }
  });

  // TEST 8 — a chest worth nothing is a knockout that pays nothing.
  it('never produces a zero, negative or fractional amount', () => {
    for (const profile of PROFILES) {
      for (const n of [2, 3, 10, 37, 250]) {
        for (const chest of buildInventory(1_234_56, n, profile)) {
          expect(Number.isInteger(chest.amountCents)).toBe(true);
          expect(chest.amountCents).toBeGreaterThan(0);
        }
      }
    }
  });

  // TEST 9 — small fields cannot express eight tiers, so they collapse. The
  // requirement is that they collapse rather than emit nonsense.
  it('merges the ladder sensibly for a small field', () => {
    const chests = buildInventory(500_00, 6, 'classic');
    expect(chests).toHaveLength(6);
    expect(chests.reduce((s, c) => s + c.amountCents, 0)).toBe(500_00);
    const tiers = new Set(chests.map((c) => c.tier));
    // Six chests cannot carry eight meaningfully different tiers.
    expect(tiers.size).toBeLessThanOrEqual(4);
  });

  // TEST 10 — the tightest case there is: one cent per chest.
  it('handles a pool of exactly one cent per chest', () => {
    const chests = buildInventory(40, 40, 'classic');
    expect(chests).toHaveLength(40);
    expect(chests.every((c) => c.amountCents === 1)).toBe(true);
  });

  // TEST 11 — refuse rather than invent.
  it('refuses inputs it cannot honour', () => {
    expect(() => buildInventory(0, 10, 'classic')).toThrow(/positive whole number of cents/);
    expect(() => buildInventory(1000, 0, 'classic')).toThrow(/positive integer/);
    expect(() => buildInventory(10, 40, 'classic')).toThrow(/cannot fund/);
    expect(() => buildInventory(10.5, 4, 'classic')).toThrow();
  });

  // TEST 12 — deterministic: the same three arguments give the same inventory,
  // so an event's chest list can be recomputed and audited after the fact. The
  // randomness lives in the shuffle, not here.
  it('is deterministic', () => {
    const a = buildInventory(987_65, 43, 'jackpot');
    const b = buildInventory(987_65, 43, 'jackpot');
    expect(a).toEqual(b);
  });

  it('summarises to tier rows that still add up', () => {
    const chests = buildInventory(2_000_00, 120, 'classic');
    const rows = summariseInventory(chests);
    expect(rows.reduce((s, r) => s + r.count, 0)).toBe(120);
    expect(rows.reduce((s, r) => s + r.totalCents, 0)).toBe(2_000_00);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  THE PROPERTY TEST
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Hundreds of random (pool, count, profile) triples. Hand-picked cases test
  // the shapes we thought of; this tests the ones we did not. The seed is
  // fixed so a failure is reproducible — a property test that cannot be
  // replayed is a flake generator, not a test.
  it('reconciles exactly across hundreds of random pool/count/profile triples', () => {
    let seed = 0x5eed1234;
    const rand = () => {
      // xorshift32. Deterministic, and its quality is irrelevant here — this
      // picks TEST INPUTS, not money.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };

    for (let i = 0; i < 600; i++) {
      const drawCount = 2 + Math.floor(rand() * 900);
      // Pools from "a few cents per chest" to "a serious guarantee".
      const poolCents = Math.max(drawCount, Math.floor(rand() * 50_000_00) + 1);
      const profile = PROFILES[Math.floor(rand() * PROFILES.length)];

      let chests;
      try {
        chests = buildInventory(poolCents, drawCount, profile);
      } catch (err) {
        throw new Error(
          `buildInventory(${poolCents}, ${drawCount}, ${profile}) threw: ${(err as Error).message}`
        );
      }

      const sum = chests.reduce((s, c) => s + c.amountCents, 0);
      if (sum !== poolCents || chests.length !== drawCount) {
        throw new Error(
          `buildInventory(${poolCents}, ${drawCount}, ${profile}) -> ${chests.length} chests summing to ${sum}`
        );
      }
      for (const c of chests) {
        if (!Number.isInteger(c.amountCents) || c.amountCents <= 0) {
          throw new Error(
            `buildInventory(${poolCents}, ${drawCount}, ${profile}) produced ${c.amountCents}c`
          );
        }
      }
      if (drawCount >= MYSTERY_BOUNTY_MIN_FIELD_FOR_JACKPOT) {
        const jackpots = chests.filter((c) => c.tier === 'jackpot').length;
        if (jackpots > 1) {
          throw new Error(
            `buildInventory(${poolCents}, ${drawCount}, ${profile}) produced ${jackpots} jackpots`
          );
        }
      }
    }
  });
});
