/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PAYOUT STRUCTURE — the pool cannot pay out more than it holds
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The defect these pin: both payout sites fell back to "award 100% of the
 * prize pool to the winner" whenever `payout_structure` was missing or had no
 * place 1. Places 2..N are paid AT ELIMINATION, minutes earlier, so on a 10x+
 * Spin (80/20, 80/12/8) that fallback pays the pool out at 120%.
 *
 * Two independent guards, because either alone would still leave a hole:
 *
 *   1. A Spin never needs the fallback — its split is a pure function of its
 *      multiplier, so the spec reconstructs it exactly.
 *   2. The fallback itself is capped at the UNSPENT pool, for every format.
 *      An MTT with a lost structure had the identical exposure.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parsePayoutStructure,
  spinPayoutStructure,
  resolvePayoutStructure,
  remainingPoolAfterAwards,
  isSpinTournament,
} from './payoutStructure.js';
import { computePlacePrize } from './payoutMath.js';
import { SPIN_TIERS } from '../config/spinSpec.js';

const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('parsePayoutStructure accepts only a USABLE structure', () => {
  it('takes an array or its JSON string form', () => {
    const arr = [{ place: 1, percentage: 100 }];
    expect(parsePayoutStructure(arr)).toEqual(arr);
    expect(parsePayoutStructure(JSON.stringify(arr))).toEqual(arr);
  });

  it('rejects the shapes that are valid JSON but not a structure', () => {
    expect(parsePayoutStructure(null)).toBeNull();
    expect(parsePayoutStructure(undefined)).toBeNull();
    expect(parsePayoutStructure('not json')).toBeNull();
    expect(parsePayoutStructure([])).toBeNull();
    expect(parsePayoutStructure('[]')).toBeNull();
    // No place 1 — the shape the old fallback keyed on.
    expect(parsePayoutStructure([{ place: 2, percentage: 100 }])).toBeNull();
    // Percentages that cannot split anything.
    expect(parsePayoutStructure([{ place: 1, percentage: 0 }])).toBeNull();
    expect(parsePayoutStructure([{ place: 1, percentage: -50 }])).toBeNull();
    expect(parsePayoutStructure([{ place: 0, percentage: 100 }])).toBeNull();
  });
});

describe('a Spin rebuilds its own split from the spec', () => {
  it('matches the ladder at every tier', () => {
    for (const tier of SPIN_TIERS) {
      const derived = spinPayoutStructure(tier.multiplier);
      expect(derived, `${tier.multiplier}x`).not.toBeNull();
      expect(derived!.length).toBe(tier.payouts.length);
      expect(derived!.map((p) => p.place)).toEqual(tier.payouts.map((_, i) => i + 1));
      expect(derived!.reduce((s, p) => s + p.percentage, 0)).toBeCloseTo(100, 6);
    }
  });

  it('knows the two shapes that had never actually run', () => {
    expect(spinPayoutStructure(10)).toEqual([
      { place: 1, percentage: 80 },
      { place: 2, percentage: 20 },
    ]);
    expect(spinPayoutStructure(25)).toEqual([
      { place: 1, percentage: 80 },
      { place: 2, percentage: 12 },
      { place: 3, percentage: 8 },
    ]);
  });

  it('is null for a multiplier that is not on the ladder', () => {
    expect(spinPayoutStructure(7)).toBeNull();
    expect(spinPayoutStructure(0)).toBeNull();
    expect(spinPayoutStructure(null)).toBeNull();
  });
});

describe('resolvePayoutStructure', () => {
  it('prefers the stored column when it is usable', () => {
    const stored = [{ place: 1, percentage: 100 }];
    expect(
      resolvePayoutStructure({ payout_structure: stored, variant: 'spin', spin_multiplier: 25 })
    ).toEqual(stored);
  });

  it('rebuilds a Spin whose column is missing or corrupt', () => {
    for (const bad of [null, undefined, '', '[]', 'garbage', [{ place: 2, percentage: 100 }]]) {
      expect(
        resolvePayoutStructure({ payout_structure: bad, variant: 'spin', spin_multiplier: 25 }),
        String(bad)
      ).toEqual([
        { place: 1, percentage: 80 },
        { place: 2, percentage: 12 },
        { place: 3, percentage: 8 },
      ]);
    }
  });

  it('recognises a Spin by tournament_type as well as variant', () => {
    expect(isSpinTournament({ tournament_type: 'SPIN' })).toBe(true);
    expect(resolvePayoutStructure({ tournament_type: 'SPIN', spin_multiplier: 10 })).not.toBeNull();
  });

  it('gives a non-Spin nothing to guess with', () => {
    expect(resolvePayoutStructure({ variant: 'mtt', payout_structure: null })).toBeNull();
    expect(resolvePayoutStructure(null)).toBeNull();
  });
});

describe('a rebuilt Spin structure pays out exactly the pool', () => {
  it('80/20 and 80/12/8 sum to the pool to the cent', () => {
    // 33.33 is deliberately awkward: 80/12/8 of it rounds to 26.66 + 4.00 +
    // 2.67 = 33.33 only because the last place absorbs the residual.
    for (const pool of [10, 25, 33.33, 100, 0.03, 1234.56]) {
      for (const mult of [10, 25, 100]) {
        const structure = resolvePayoutStructure({ variant: 'spin', spin_multiplier: mult })!;
        const total = structure
          .map((p) => computePlacePrize(pool, structure, p.place))
          .reduce((s, n) => s + n, 0);
        expect(Math.round(total * 100) / 100, `${mult}x on ${pool}`).toBe(pool);
      }
    }
  });
});

describe('the retired 500x tier', () => {
  it('resolves to nothing — 100x is the top of the ladder', () => {
    // Retired in #160. This lived in the loop above as a fourth multiplier,
    // where `!` hid its disappearance from the compiler and the suite died on
    // `null.map` instead of saying what had changed. Asserted explicitly now:
    // if 500x is ever reinstated, this is the line that says so out loud.
    expect(resolvePayoutStructure({ variant: 'spin', spin_multiplier: 500 })).toBeNull();
  });
});

describe('remainingPoolAfterAwards — the universal cap', () => {
  it('is the pool minus what has already gone out', () => {
    expect(remainingPoolAfterAwards(100, 20)).toBe(80);
    expect(remainingPoolAfterAwards(33.33, 6.67)).toBe(26.66);
  });

  it('never goes negative, whatever it is handed', () => {
    expect(remainingPoolAfterAwards(100, 250)).toBe(0);
    expect(remainingPoolAfterAwards(-5, 0)).toBe(0);
    expect(remainingPoolAfterAwards(NaN, NaN)).toBe(0);
  });

  it('the 120% overpay is arithmetically gone', () => {
    // A 10x Spin on a 3-unit buy-in: pool 30, second place already paid 6.
    // The old fallback handed the winner all 30, so 36 left a 30 pool.
    expect(remainingPoolAfterAwards(30, 6)).toBe(24);
  });
});

describe('every payout path actually uses the rule', () => {
  const ELIM = code(read('src/tournament/TournamentManagerEliminations.ts'));
  const RECOVERY = code(read('src/tournament/tournamentRecovery.ts'));

  it('both live sites resolve the structure rather than parsing it themselves', () => {
    const uses = ELIM.match(/resolvePayoutStructure\(/g) ?? [];
    expect(uses.length, 'eliminatePlayer and finishTournament').toBeGreaterThanOrEqual(2);
  });

  it('the stuck-COMPLETING rescue shares it too', () => {
    expect(RECOVERY).toMatch(/resolvePayoutStructure\(/);
  });

  it('the uncapped "award the whole pool" fallback is gone', () => {
    // The exact shape: winnerPrize set from prize_pool with nothing subtracted.
    expect(ELIM).not.toMatch(
      /winnerPrize\s*=\s*Math\.round\(\s*\(?\s*tournament\??\.?\??\.prize_pool/
    );
    expect(ELIM).toMatch(/remainingPoolAfterAwards\(/);
  });

  it('both sites select what a rebuild needs', () => {
    const selects = ELIM.match(/'payout_structure[^']*'/g) ?? [];
    expect(selects.length).toBeGreaterThanOrEqual(1);
    for (const s of selects) {
      expect(s, `select missing spin_multiplier: ${s}`).toMatch(/spin_multiplier/);
    }
  });
});
