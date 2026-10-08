/**
 * Round 3 test support (docs/horse-brain-phase12-round3-2026-10-08.md): a
 * decision state where the round-3 pack's proposal differs from the reference
 * at the HorseLogic owner. The round-3 pack keeps the reference everywhere
 * except its declared preflop spots, so a test that needs a real change
 * builds the heads-up button first in (where the pack opens a hand the
 * reference does not) and tries a fixed list of hero holdings until the
 * pack-off reference and the proposal differ. The reference is read from the
 * pack-off run, never from the code under test.
 */
import type { Card } from '../../types.js';
import { remainingVariantSpot } from '../../benchmark/RemainingVariantPolicyEvidence.js';
import type { RemainingPolicyVariant } from './RemainingVariantPolicyPack.js';

export type Round3Spot = ReturnType<typeof remainingVariantSpot>;

const RANK_SUIT: Record<string, Card['suit']> = {
  c: 'clubs',
  d: 'diamonds',
  h: 'hearts',
  s: 'spades',
};
const cards = (text: string): Card[] =>
  text.split(' ').map((c) => ({ rank: c[0] as Card['rank'], suit: RANK_SUIT[c[1]] }));

/** Holdings tried in order (preflop: no board or discard to collide with). */
const HOLDINGS: Record<RemainingPolicyVariant, readonly string[]> = {
  short_deck: [
    'Kc 6d',
    'Qc 7d',
    'Jc 6h',
    'Tc 7h',
    'Kh 7c',
    'Qh 6c',
    'Jd 8c',
    '9c 6d',
    'Ah 6c',
    'Kd 8h',
  ],
  pineapple: [
    'Kc 7d 2h',
    'Qc 8d 3h',
    'Jc 7d 2s',
    'Kh 6c 3d',
    'Qh 5c 2d',
    'Tc 8d 3s',
    'Ah 7c 2d',
    'Jd 9c 2h',
    'Kd 4h 2c',
    '9c 7d 3h',
  ],
  flh: ['Qc 4d', 'Jc 3d', 'Tc 5d', '9c 6d', 'Kc 2d', 'Qh 3c', 'Jh 5c', 'Th 6c', '8c 7d'],
  flo8: [
    'Kc Kd 3h 2s',
    'Qc Qd 3h 2s',
    '2c 3d 9h 9s',
    'Ac 3d 9h Ts',
    'Ah 4d Jc 9s',
    '2c 3c Jh 8d',
    'Kc 2d 3h 7s',
    'Ac 5d Kh 9s',
    'Jc Jd 4h 2s',
    'Ac 4c Qh Td',
    '3c 4d Kh Ks',
    'Ad 8c 7h 2s',
  ],
};

/** The declared spot: heads-up, first in on the button of the evidence spot. */
function round3Base(variant: RemainingPolicyVariant, mode: 'cash' | 'tournament') {
  return remainingVariantSpot(variant, 'preflop', 2, mode);
}

/** The street of the declared spot. */
export function round3ChangedStreet(_variant: RemainingPolicyVariant) {
  return 'preflop' as const;
}

/** One factory per fixed holding, in order, each making a fresh copy of the
 * declared spot for `variant` (for callers whose check is asynchronous). */
export function round3SpotFactories(
  variant: RemainingPolicyVariant,
  mode: 'cash' | 'tournament'
): ReadonlyArray<() => Round3Spot> {
  return HOLDINGS[variant].map((holding) => () => {
    const spot = round3Base(variant, mode);
    spot.hero.cards = cards(holding);
    return spot;
  });
}

/**
 * A factory for a fresh copy of the first declared spot, over the fixed
 * holdings, where `changed(spot)` holds; throws if none does.
 */
export function round3ChangedSpot(
  variant: RemainingPolicyVariant,
  mode: 'cash' | 'tournament',
  changed: (spot: Round3Spot) => boolean
): () => Round3Spot {
  for (const make of round3SpotFactories(variant, mode)) if (changed(make())) return make;
  throw new Error(`no round-3 ${variant} ${mode} spot changes the reference`);
}
