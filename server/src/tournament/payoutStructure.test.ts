/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PAYOUT STRUCTURE — the pool cannot pay out more than it holds
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The defect these pin: both payout sites fell back to "award 100% of the
 * prize pool to the winner" whenever `payout_structure` was missing or had no
 * place 1. The retired path paid places 2..N AT ELIMINATION, minutes earlier,
 * so on a 10x+ Spin (80/20, 80/12/8) that fallback paid the pool out at 120%.
 *
 * The current guards remove the guess entirely:
 *
 *   1. A Spin never needs the fallback — its split is a pure function of its
 *      multiplier, so the spec reconstructs it exactly.
 *   2. A missing exact contract fails closed for every format. The unspent-pool
 *      helper below preserves the arithmetic regression proof; it is not a
 *      fallback payout path.
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
  trimStructureToField,
  spinStoredStructureIsStale,
} from './payoutStructure.js';
import { computePlacePrize } from './payoutMath.js';
import { CHIP_UNIT_CENTS } from './tournamentUnit.js';
import { SPIN_TIERS } from '../config/spinSpec.js';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

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
  it('prefers the stored column when it is usable, for a format that may choose one', () => {
    const stored = [
      { place: 1, percentage: 65 },
      { place: 2, percentage: 35 },
    ];
    expect(resolvePayoutStructure({ payout_structure: stored, variant: 'mtt' })).toEqual(stored);
  });

  /* WAS: the same assertion with `variant: 'spin', spin_multiplier: 25`, i.e.
     a stored winner-take-all beating the 80/12/8 the 25x tier owes. That is
     the bug, re-encoded as law. A Spin's structure is a pure function of its
     multiplier and nobody may author a different one, so a stored structure on
     a Spin is only ever a COPY of the tier - and one that disagrees is stale,
     not chosen. 62 completed spins at 10x+ are sitting in `tournaments` with
     exactly that stale placeholder, having paid 100% to first place. */
  it('lets the TIER outrank a stale stored column on a Spin', () => {
    const stale = [{ place: 1, percentage: 100 }];
    expect(
      resolvePayoutStructure({ payout_structure: stale, variant: 'spin', spin_multiplier: 25 })
    ).toEqual([
      { place: 1, percentage: 80 },
      { place: 2, percentage: 12 },
      { place: 3, percentage: 8 },
    ]);
    expect(
      resolvePayoutStructure({ payout_structure: stale, variant: 'spin', spin_multiplier: 10 })
    ).toEqual([
      { place: 1, percentage: 80 },
      { place: 2, percentage: 20 },
    ]);
    // And the stale-column detector agrees, so a caller with a reporter can
    // say the start-time rewrite never landed.
    expect(
      spinStoredStructureIsStale({ payout_structure: stale, variant: 'spin', spin_multiplier: 25 })
    ).toBe(true);
  });

  it('leaves an honest stored column alone - below 10x the two agree exactly', () => {
    const wta = [{ place: 1, percentage: 100 }];
    for (const mult of [2, 3, 4, 5]) {
      expect(
        resolvePayoutStructure({ payout_structure: wta, variant: 'spin', spin_multiplier: mult }),
        `${mult}x`
      ).toEqual(wta);
      expect(
        spinStoredStructureIsStale({
          payout_structure: wta,
          variant: 'spin',
          spin_multiplier: mult,
        })
      ).toBe(false);
    }
  });

  it('refuses a stored Spin placeholder when the durable draw is missing or unknown', () => {
    // Pre-draw (null), and a retired tier such as the old 500x, do not identify
    // a canonical split. Paying the stored creation placeholder could turn a
    // missing high-tier draw into winner-take-all.
    const stored = [{ place: 1, percentage: 100 }];
    expect(
      resolvePayoutStructure({ payout_structure: stored, variant: 'spin', spin_multiplier: null })
    ).toBeNull();
    expect(
      resolvePayoutStructure({ payout_structure: stored, variant: 'spin', spin_multiplier: 500 })
    ).toBeNull();
    expect(spinStoredStructureIsStale({ variant: 'spin', spin_multiplier: 500 })).toBe(false);
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
      // Derived from SPIN_TIERS rather than hardcoded. This list used to name
      // 500x; that tier was retired in #164, resolvePayoutStructure started
      // returning null for it, and the null hit `.map` - which failed the
      // server suite, and the Hetzner deploy is gated on that suite, so a
      // retired tier in a test list was blocking every engine deploy in the
      // repo. Reading the spec means a tier can never again be retired out
      // from under this test.
      for (const mult of SPIN_TIERS.map((t) => t.multiplier)) {
        const structure = resolvePayoutStructure({ variant: 'spin', spin_multiplier: mult })!;
        expect(structure, `${mult}x must resolve to a structure`).not.toBeNull();
        const total = structure
          .map((p) => computePlacePrize(pool, structure, p.place, CHIP_UNIT_CENTS))
          .reduce((s, n) => s + n, 0);
        expect(Math.round(total * 100) / 100, `${mult}x on ${pool}`).toBe(pool);
      }
    }
  });
});

describe('remainingPoolAfterAwards - the universal cap', () => {
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

  it('live elimination and reprice views resolve the structure rather than parsing it themselves', () => {
    const uses = ELIM.match(/resolvePayoutStructure\(/g) ?? [];
    expect(uses.length, 'eliminatePlayer and late-reg reprice').toBeGreaterThanOrEqual(2);
  });

  it('the stuck-COMPLETING rescue shares it too', () => {
    expect(RECOVERY).toMatch(/resolvePayoutStructure\(/);
  });

  it('the uncapped "award the whole pool" fallback is gone', () => {
    const finish = sliceMethod(ELIM, 'finishTournament(winnerId: string): Promise<void>');
    // The process never computes a terminal amount. The database derives the
    // complete ladder and returns its immutable receipt or nothing is shown.
    expect(blankNonCode(finish)).not.toMatch(
      /winnerPrize\s*=\s*Math\.round\(\s*\(?\s*tournament\??\.?\??\.prize_pool/
    );
    expect(finish).toContain(
      "requestTournamentTerminalReceipt(this.tournamentId, 'places', winnerId)"
    );
    expect(blankNonCode(finish)).not.toMatch(
      /resolvePayoutStructure|computePlacePrize|prize_pool|payout_structure/
    );
  });

  it('both sites select what a rebuild needs', () => {
    const selects = ELIM.match(/'payout_structure[^']*'/g) ?? [];
    expect(selects.length).toBeGreaterThanOrEqual(1);
    for (const s of selects) {
      expect(s, `select missing spin_multiplier: ${s}`).toMatch(/spin_multiplier/);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A STRUCTURE CANNOT PAY A PLACE NOBODY REACHED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * SHORT-FIELD RESIDUAL 2026-08-27. computePlacePrize gives the LAST place in
 * the structure whatever is left over, so the paid places sum to the pool to
 * the cent. Nothing trimmed the structure to the size of the field, so when
 * fewer players entered than the structure pays, the residual sat on a place no
 * finisher ever held and never left the house.
 *
 * Sunday Midway Major: 9 places, 8 entrants, 250.00 of a 10,000.00 pool
 * stranded. PLO Daily 18155d71: 5 places, 4 entrants, 52.50. Eight events with
 * a pool in thirty days, each also leaving fn_tournament_payout_reconcile
 * holding a no_finisher_recorded critical it correctly refuses to resolve alone.
 *
 * Trimming is the direction that OVERPAYS - a field size that is too small
 * promotes an earlier place to residual holder - so most of these pin the cases
 * where the trim must NOT happen.
 */
describe('the structure is trimmed to the field that can fill it', () => {
  const NINE = [
    { place: 1, percentage: 30 },
    { place: 2, percentage: 20 },
    { place: 3, percentage: 14 },
    { place: 4, percentage: 10 },
    { place: 5, percentage: 8 },
    { place: 6, percentage: 6 },
    { place: 7, percentage: 5 },
    { place: 8, percentage: 4.5 },
    { place: 9, percentage: 2.5 },
  ];

  it('drops the places the field can never reach', () => {
    const trimmed = trimStructureToField(NINE, 8)!;
    expect(trimmed.map((p) => p.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('moves the residual onto the last place a player actually held', () => {
    // The whole point, in money. 10,000 pool, 9-place structure, 8 entrants.
    const stranded =
      10000 -
      NINE.reduce((sum, p) => sum + computePlacePrize(10000, NINE, p.place, CHIP_UNIT_CENTS), 0);
    // Untrimmed, place 9 holds the residual and nobody is there to take it.
    expect(computePlacePrize(10000, NINE, 9, CHIP_UNIT_CENTS)).toBeCloseTo(250, 2);
    expect(stranded).toBeCloseTo(0, 2); // the pool balances only if place 9 pays

    const trimmed = trimStructureToField(NINE, 8)!;
    const paid = trimmed.reduce(
      (sum, p) => sum + computePlacePrize(10000, trimmed, p.place, CHIP_UNIT_CENTS),
      0
    );
    expect(paid).toBeCloseTo(10000, 2);

    /**
     * The 2.5% that had nowhere to go is spread PROPORTIONALLY, not dumped on
     * the last place. That falls out of computePlacePrize's existing
     * normalisation rather than from anything new here: it scales whatever
     * structure it is handed to 100% before splitting, so a set summing to
     * 97.5 is scaled by 100/97.5 and every remaining place grows by the same
     * factor. The last place still takes the rounding residual on top, so the
     * eight places sum to the pool to the cent.
     */
    expect(computePlacePrize(10000, trimmed, 1, CHIP_UNIT_CENTS)).toBeCloseTo(3076.92, 2);
    expect(computePlacePrize(10000, trimmed, 8, CHIP_UNIT_CENTS)).toBeCloseTo(461.55, 2);
    // Nobody is paid less than they would have been in a full field.
    for (const p of trimmed) {
      expect(computePlacePrize(10000, trimmed, p.place, CHIP_UNIT_CENTS)).toBeGreaterThanOrEqual(
        computePlacePrize(10000, NINE, p.place, CHIP_UNIT_CENTS)
      );
    }
  });

  it('leaves a full field completely alone', () => {
    expect(trimStructureToField(NINE, 9)).toBe(NINE);
    expect(trimStructureToField(NINE, 40)).toBe(NINE);
  });

  it('trims nothing when the field size is unknown or nonsense', () => {
    // Every existing caller passes nothing and must keep its exact behaviour.
    expect(trimStructureToField(NINE)).toBe(NINE);
    expect(trimStructureToField(NINE, undefined)).toBe(NINE);
    expect(trimStructureToField(NINE, null)).toBe(NINE);
    expect(trimStructureToField(NINE, 0)).toBe(NINE);
    expect(trimStructureToField(NINE, -3)).toBe(NINE);
    expect(trimStructureToField(NINE, 2.5)).toBe(NINE);
    expect(trimStructureToField(NINE, NaN)).toBe(NINE);
  });

  it('never trims itself down to nothing', () => {
    // A structure that starts at place 2 (malformed, but reachable) with a
    // field of 1 would otherwise leave no places at all and pay the pool to
    // nobody.
    const oddball = [
      { place: 2, percentage: 60 },
      { place: 3, percentage: 40 },
    ];
    expect(trimStructureToField(oddball, 1)).toBe(oddball);
  });

  it('trims the structure resolvePayoutStructure hands back, stored or rebuilt', () => {
    const stored = resolvePayoutStructure({ payout_structure: NINE } as any, 8)!;
    expect(stored.map((p) => p.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // A Spin rebuilt from its multiplier goes through the same trim, so the
    // two ways of getting a structure cannot disagree about the field.
    const spin = resolvePayoutStructure(
      { variant: 'spin', spin_multiplier: 10, payout_structure: null } as any,
      1
    );
    expect(Array.isArray(spin)).toBe(true);
    expect(spin!.every((p) => p.place <= 1)).toBe(true);
  });
});
