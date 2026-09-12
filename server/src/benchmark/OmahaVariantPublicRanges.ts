import type { SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from '../engine/HorseLogic.js';
import {
  OMAHA_VARIANT_PACKS,
  omahaVariantHandShape,
  type OmahaPolicyVariant,
} from '../engine/omaha/OmahaVariantPolicyPack.js';
import { referenceDeck, cardKey, referenceOmaha } from './OmahaReference.js';
import type { OmahaRange } from './OmahaEquityOracle.js';

/** Explicit finite heuristic priors for independent oracle work. These are
 * intentionally distinct from the bounded sequential live sampler. The oracle
 * rejects intersecting joint combinations; a sparse population can report an
 * incomplete attempt budget rather than inventing cards or calibrated ranges. */
export function omahaVariantPublicRanges(
  variant: OmahaPolicyVariant,
  hero: SeatPlayer,
  state: HorseGameStateV2,
  seed: number
): Record<string, OmahaRange> {
  const seen = new Set([...hero.cards, ...state.communityCards].map(cardKey));
  const available = referenceDeck().filter((c) => !seen.has(cardKey(c)));
  return Object.fromEntries(
    state.players
      .filter((p) => p.user_id !== hero.user_id && !p.is_sitting_out)
      .map((p) => {
        let rng = seed >>> 0 || 1;
        for (const c of `${variant}:${p.user_id}`)
          rng = Math.imul(rng ^ c.charCodeAt(0), 16777619) >>> 0;
        rng ||= 1;
        const next = () => {
          rng ^= rng << 13;
          rng ^= rng >>> 17;
          rng ^= rng << 5;
          return (rng >>> 0) / 4294967296;
        };
        const line = (state.actionHistory ?? []).filter((a) => a.userId === p.user_id);
        const raises = line.filter(
          (a) =>
            a.action === 'bet' ||
            a.action === 'raise' ||
            (a.action === 'all_in' && a.isFullRaise !== undefined)
        ).length;
        const calls = line.filter(
          (a) => a.action === 'call' || (a.action === 'all_in' && a.isFullRaise === undefined)
        ).length;
        const keys = new Set<string>();
        const combos: { cards: SeatPlayer['cards']; weight: number }[] = [];
        for (let attempt = 0; combos.length < 64 && attempt < 128; attempt++) {
          const deck = available.slice();
          const cards = Array.from(
            { length: OMAHA_VARIANT_PACKS[variant].holes },
            () => deck.splice(Math.floor(next() * deck.length), 1)[0]
          );
          const key = cards.map(cardKey).sort().join('|');
          if (keys.has(key)) continue;
          keys.add(key);
          const shape = omahaVariantHandShape(variant, cards);
          const hand =
            state.communityCards.length >= 3 ? referenceOmaha(cards, state.communityCards) : null;
          const contact = hand ? hand.category / 9 : shape.quality;
          const split = variant === 'plo8' && hand && hand.low !== null ? 0.1 : 0;
          combos.push({
            cards,
            weight: Math.max(
              0.001,
              Math.pow(
                0.2 + shape.quality * 0.5 + contact * 0.2 + split,
                Math.min(5, 1 + raises + calls * 0.25)
              )
            ),
          });
        }
        return [p.user_id, { combos }];
      })
  );
}
