/**
 * V52 RANGE ADVANTAGE IS MEASURED, NOT ASSUMED (2026-10-24)
 *
 * The public-range advantage read (#7838, #7866) changes heads-up postflop
 * initiative: the range c-bet upgrade, the V38 EV initiative and the
 * pot-limit small sizes. After it shipped, same-hour live reviews showed NLH
 * big-bet-then-fold rising from 9.5% to 13.3% of reviewed hands. Outcome tags
 * cannot say whether the extra initiative earns, so the layer sits behind
 * `v52RangeAdvantage` (default ON, production unchanged) and the nightly
 * league measures it on/off in every variant where it fires.
 *
 * Pins:
 *  1. All four V52 cards are on the standing card with arm A = production
 *     default and arm B = the layer off.
 *  2. The flag reaches code: on the NLH and PLO6 cards the two arms do not
 *     play identical poker at a sample the suite can afford. A nightly row
 *     of 0.00 +/- 0.00 would otherwise be indistinguishable from a resolved
 *     zero (see LeagueMatchupIsNotInert.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { LEAGUE_MATCHUPS, runMatchup } from './HorseLeague.js';

const V52_CARDS: Array<[string, string | undefined]> = [
  ['v52_range_advantage', undefined],
  ['plo4_v52_range_advantage', 'plo4'],
  ['plo5_v52_range_advantage', 'plo5'],
  ['plo6_v52_range_advantage', 'plo6'],
];

describe('V52 range advantage is measured on/off in every variant', { timeout: 180_000 }, () => {
  it('every V52 card is on the standing card with production as arm A', () => {
    for (const [name, variant] of V52_CARDS) {
      const card = LEAGUE_MATCHUPS.find((m) => m.name === name);
      expect(card, `${name} is missing from the standing card`).toBeDefined();
      expect(card!.variant).toBe(variant);
      expect(card!.pairs).toBe(6000);
      expect(card!.a).toEqual({});
      expect(card!.b).toEqual({ v52RangeAdvantage: false });
    }
  });

  it.each(['v52_range_advantage', 'plo6_v52_range_advantage'])(
    '%s: the two arms do not play identical poker',
    async (name) => {
      const card = LEAGUE_MATCHUPS.find((m) => m.name === name)!;
      const r = await runMatchup(card, 300, 4242);
      expect(r.hands).toBe(600);
      expect(r.divergentPairs).toBeGreaterThan(0);
      expect(r.inert).toBe(false);
    }
  );
});
