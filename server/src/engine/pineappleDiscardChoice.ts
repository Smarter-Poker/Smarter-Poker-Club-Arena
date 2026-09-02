/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHICH OF THE THREE TO THROW AWAY — ONE ANSWER, FOR EVERYBODY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Crazy Pineapple has exactly one decision the other variants do not, and
 * until now the platform answered it in two different places with two
 * different rules:
 *
 *   - HorseLogic.decideDiscard simulated the rest of the board and kept the
 *     pair with the highest EQUITY;
 *   - HandController.resolvePendingPineappleDiscards - the auto-resolve for a
 *     seat that was already all-in when the flop landed, and so never got to
 *     choose - scored the flop-MADE hand and kept the best of those.
 *
 * The second rule is backwards in the one situation it is used. It only ever
 * runs on an ALL-IN: two more cards are coming and there is no more betting,
 * which is precisely when a draw is worth the most it will ever be worth. On
 * A♥K♥ + 2♥ against a 7♥8♥3♣ flop it keeps the pair of nothing and throws away
 * the nut flush draw, because a pair outranks a draw on the flop and the flop
 * is all it looked at.
 *
 * CLAUDE.md 10.5, verbatim: "EVERY HORSE OR HUMAN PLAYER NEEDS TO BE TREATED
 * 100% EXACTLY THE SAME ALL ACROSS THE BOARD IN EVERYTHING". A horse choosing
 * by equity while a human's forced discard is chosen by a worse rule is that
 * law broken in the player's favour nowhere and against them here. So there is
 * one function now, and both callers use it.
 */
import type { Card } from '../types.js';
import { simulateEquity, variantInfo, holdemPreflopScore } from './HorseEval.js';

/**
 * The index (0..2) of the card to throw away.
 *
 * With a flop down, every candidate pair is priced by simulating the rest of
 * the board; before one, by preflop strength. Returns 2 - the last card, which
 * is what the engine's original blind fallback threw - for any input that is
 * not three cards, so a caller can never be handed an index it cannot use.
 */
export function bestPineappleDiscard(
  cards: Card[],
  communityCards: Card[],
  gameVariant: string,
  iterations = 400
): number {
  if (!cards || cards.length !== 3) return 2;
  // After the discard the hand plays exactly like holdem, whatever the table
  // calls itself, so it is priced as holdem.
  const vi = variantInfo('nlh');
  let bestIdx = 2;
  let bestEq = -1;
  for (let discard = 0; discard < 3; discard++) {
    const keep = cards.filter((_, i) => i !== discard);
    const eq =
      communityCards.length >= 3
        ? simulateEquity(keep, communityCards, 1, vi, iterations)
        : holdemPreflopScore(keep[0], keep[1], gameVariant === 'short_deck');
    if (eq > bestEq) {
      bestEq = eq;
      bestIdx = discard;
    }
  }
  return bestIdx;
}
