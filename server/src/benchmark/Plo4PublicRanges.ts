import type { SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from '../engine/HorseLogic.js';
import { plo4HandShape } from '../engine/plo4/Plo4PolicyPack.js';
import { omahaNutStatus } from '../engine/HorseEval.js';
import { referenceDeck, cardKey } from './OmahaReference.js';
import type { OmahaRange } from './OmahaEquityOracle.js';
import { horsePolicyDealtPlayers } from '../engine/multiway/DealtSeatCensus.js';

/** Bounded heuristic priors from 64 fixed draws, conditioned on each public line.
 * These are neither known hole cards nor calibrated solver ranges. Folded seats
 * remain sampled for dead-card removal. One joint deck is enforced by the oracle.
 */
export function plo4PublicRanges(
  hero: SeatPlayer,
  state: HorseGameStateV2,
  seed: number
): Record<string, OmahaRange> {
  const seen = new Set([...hero.cards, ...state.communityCards].map(cardKey));
  const available = referenceDeck().filter((c) => !seen.has(cardKey(c)));
  const ranges: Record<string, OmahaRange> = {};
  for (const p of horsePolicyDealtPlayers(state.players, hero.seat, state.dealtSeatIds).filter(
    (p) => p.user_id !== hero.user_id
  )) {
    let rng = seed >>> 0;
    for (const c of p.user_id) rng = Math.imul(rng ^ c.charCodeAt(0), 16777619) >>> 0;
    if (!rng) rng = 1;
    const next = () => {
      rng ^= rng << 13;
      rng ^= rng >>> 17;
      rng ^= rng << 5;
      return rng >>> 0;
    };
    const line = (state.actionHistory ?? []).filter((a) => a.userId === p.user_id);
    const raises = line.filter(
      (a) =>
        a.action === 'raise' ||
        a.action === 'bet' ||
        (a.action === 'all_in' && a.isFullRaise !== undefined)
    ).length;
    const calls = line.filter(
      (a) => a.action === 'call' || (a.action === 'all_in' && a.isFullRaise === undefined)
    ).length;
    const combos = Array.from({ length: 64 }, () => {
      const deck = available.slice();
      const cards = Array.from({ length: 4 }, () => deck.splice(next() % deck.length, 1)[0]);
      const quality = plo4HandShape(cards).quality;
      const contact =
        state.communityCards.length >= 3
          ? omahaNutStatus(cards, state.communityCards).category / 10
          : quality;
      return {
        cards,
        weight: Math.max(
          0.001,
          Math.pow(0.2 + quality * 0.5 + contact * 0.3, Math.min(5, 1 + raises + calls * 0.25))
        ),
      };
    });
    // The oracle admits each physical holding once. Coalescing repeated draws
    // preserves their entire prior mass without extra draws or a changed budget.
    const unique = new Map<string, (typeof combos)[number]>();
    for (const combo of combos) {
      const key = combo.cards.map(cardKey).sort().join('|');
      const previous = unique.get(key);
      if (previous) previous.weight += combo.weight;
      else unique.set(key, combo);
    }
    ranges[p.user_id] = { combos: [...unique.values()] };
  }
  return ranges;
}
