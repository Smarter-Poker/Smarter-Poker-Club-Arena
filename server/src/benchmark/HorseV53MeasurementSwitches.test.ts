/**
 * V53 CONTINUATION AND PLO-DISCIPLINE LAYERS ARE MEASURED, NOT ASSUMED
 * (2026-10-24)
 *
 * #7838, #7866 and #7876 shipped premium raises, terminal commitment, the
 * call-side barrel budget and a set of PLO river/recovery repairs with no
 * switch, so the nightly league could not say whether any of them earns.
 * Each now sits behind a default-ON HorseDecideOpts switch (production
 * unchanged) and is measured on/off where it fires. The same day, the four
 * Omaha layers measured only on plo4/plo6 gained plo5 cards.
 *
 * Pins:
 *  1. Every new card is on the standing card, arm A = production default,
 *     arm B = exactly the layer(s) off.
 *  2. The legacy all-off arm switches every V53 layer off.
 *  3. Each new card is NOT inert: at a fixed seed and the smallest pair
 *     count measured to reach its first divergent pair, the two arms settle
 *     differently (see LeagueMatchupIsNotInert.test.ts). The seed and count
 *     are deterministic for a given strategy build; a brain change that moves
 *     the first divergence past them fails here instead of a nightly row
 *     quietly reading 0.00 +/- 0.00.
 *  4. Spelling every V53 switch out as true plays exactly the default brain
 *     (an inert mirror), so the switches change nothing until one is false.
 *
 * Layer-level spot pins (each switch restores its pre-change answer on the
 * retained incident it came from) live beside those incidents; see
 * server/src/engine/HorseV53Switches.test.ts for the index.
 */

import { describe, it, expect } from 'vitest';
import { LEAGUE_MATCHUPS, runMatchup } from './HorseLeague.js';
import type { HorseDecideOpts } from '../engine/HorseLogic.js';

const RIVER = {
  v53TripBoardBoat: false,
  v53ColdFlushPressure: false,
  v53CalledThroughFlush: false,
} as const;

/** [name, variant, arm B, seed, pairs]: seed and pairs are the measured
 *  smallest sample (searched over 12-20 seeds, 2026-10-24) that reaches the
 *  card's first divergent pair with at least two pairs played (one pair has
 *  no variance, so runMatchup would still call it inert). The rare river
 *  group needs 37-108 pairs; at 6,000 pairs a night it expects 3-12. */
const CARDS: Array<[string, string, HorseDecideOpts, number, number]> = [
  ['plo5_v40_omaha', 'plo5', { v40Omaha: false }, 4242, 20],
  ['plo5_v46_classes', 'plo5', { v46Charts: false }, 4242, 20],
  ['plo5_v24_price', 'plo5', { v24PloDefense: false }, 4242, 20],
  ['plo5_v15_discipline', 'plo5', { v15: false }, 4242, 20],
  ['plo4_v53_premium_raise', 'plo4', { v53PremiumRaise: false }, 9, 95],
  ['plo5_v53_premium_raise', 'plo5', { v53PremiumRaise: false }, 2, 5],
  ['plo6_v53_premium_raise', 'plo6', { v53PremiumRaise: false }, 2, 5],
  ['plo6_v53_terminal_commitment', 'plo6', { v53TerminalCommitment: false }, 6, 18],
  ['plo4_v53_omaha_river', 'plo4', RIVER, 3, 92],
  ['plo5_v53_omaha_river', 'plo5', RIVER, 8, 108],
  ['plo6_v53_omaha_river', 'plo6', RIVER, 15, 37],
  ['plo4_v53_omaha_blockers', 'plo4', { v53OmahaBlockers: false }, 11, 9],
  ['plo5_v53_omaha_blockers', 'plo5', { v53OmahaBlockers: false }, 8, 27],
  ['plo6_v53_omaha_blockers', 'plo6', { v53OmahaBlockers: false }, 7, 35],
  ['plo4_v53_physical_draws', 'plo4', { v53PhysicalDraws: false }, 4242, 7],
  ['plo5_v53_physical_draws', 'plo5', { v53PhysicalDraws: false }, 5, 2],
  ['plo6_v53_physical_draws', 'plo6', { v53PhysicalDraws: false }, 9, 9],
  ['plo4_v53_range_runout', 'plo4', { v53RangeRunout: false }, 4242, 9],
  ['plo5_v53_range_runout', 'plo5', { v53RangeRunout: false }, 5, 5],
  ['plo6_v53_range_runout', 'plo6', { v53RangeRunout: false }, 4242, 7],
];

const V53_SWITCHES = [
  'v53PremiumRaise',
  'v53TerminalCommitment',
  'v53BarrelBudget',
  'v53TripBoardBoat',
  'v53ColdFlushPressure',
  'v53CalledThroughFlush',
  'v53ManiacRecovery',
  'v53PhysicalDraws',
  'v53OmahaBlockers',
  'v53RangeRunout',
] as const;

describe('V53 layers and the PLO5 gap are measured on/off', { timeout: 900_000 }, () => {
  it('every new card is on the standing card with production as arm A', () => {
    for (const [name, variant, b] of CARDS) {
      const card = LEAGUE_MATCHUPS.find((m) => m.name === name);
      expect(card, `${name} is missing from the standing card`).toBeDefined();
      expect(card!.variant).toBe(variant);
      expect(card!.pairs).toBe(6000);
      expect(card!.a).toEqual({});
      expect(card!.b).toEqual(b);
    }
    expect(new Set(LEAGUE_MATCHUPS.map((m) => m.name)).size).toBe(LEAGUE_MATCHUPS.length);
  });

  it('the legacy all-off arm switches every V53 layer off', () => {
    const legacy = LEAGUE_MATCHUPS.find((m) => m.name === 'full_vs_v2_legacy')!.b as Record<
      string,
      unknown
    >;
    for (const key of V53_SWITCHES) expect(legacy[key], key).toBe(false);
  });

  it.each(CARDS.map(([name, , , seed, pairs]) => [name, seed, pairs] as const))(
    '%s: the two arms do not play identical poker (seed %i, %i pairs)',
    async (name, seed, pairs) => {
      const card = LEAGUE_MATCHUPS.find((m) => m.name === name)!;
      const r = await runMatchup(card, pairs, seed);
      expect(r.hands).toBe(pairs * 2);
      expect(r.divergentPairs).toBeGreaterThan(0);
      expect(r.inert).toBe(false);
    }
  );

  it.each(['nlh', 'plo5'])(
    '%s: every V53 switch spelled out as true is the default brain',
    async (variant) => {
      const on = Object.fromEntries(V53_SWITCHES.map((k) => [k, true])) as HorseDecideOpts;
      const r = await runMatchup(
        {
          name: 'v53_all_on_mirror',
          variant: variant === 'nlh' ? undefined : variant,
          a: {},
          b: on,
        },
        variant === 'nlh' ? 120 : 40,
        4242
      );
      expect(r.divergentPairs).toBe(0);
      expect(r.inert).toBe(true);
    }
  );
});
